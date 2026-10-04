import { getSettings } from './db.js';
import { notify } from './notify.js';
import { haversine, now } from './util.js';

/**
 * Looks at every GPS point the server receives (live position, tracking-only mode, and GPS tracks
 * uploaded with clips) for:
 *  - arrival/leaving alerts at places people mark on the map
 *  - speed alerts (sustained over a car's limit)
 *  - driving events: hard braking, hard acceleration, sharp turns (optional; recorded, not alerted)
 * Arrival and speed alerts only fire for recent points, so a late upload doesn't send stale alerts.
 */
const FRESH_MS = 10 * 60_000;
const placeState = new Map(); // `${placeId}:${carId}` -> inside (bool)
const speedState = new Map(); // carId -> { overSince, alerted, belowSince, peak, lastAlert }

const kmh = (ms) => ms * 3.6;
const fmtSpeed = (units, k) => (units === 'mph' ? `${Math.round(k / 1.609344)} mph` : `${Math.round(k)} km/h`);

export function analyzePoints(db, carId, cameraId, points) {
  if (!points.length) return;
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const fresh = sorted.filter((p) => p.t > now() - FRESH_MS && (p.acc == null || p.acc <= 100));
  if (fresh.length) {
    checkPlaces(db, carId, fresh);
    checkSpeed(db, carId, fresh);
  }
  if (getSettings(db).drivingEvents) detectDriving(db, carId, cameraId, sorted);
}

// ---------------------------------------------------------------- places

function placesFor(db, carId) {
  return db.all('SELECT * FROM alert_places').filter((p) => {
    if (p.car_ids) return JSON.parse(p.car_ids).includes(carId);
    // "All cars" means all cars the place's owner can see.
    return !!db.get('SELECT 1 FROM cars WHERE id = ? AND (owner_id = ? OR id IN (SELECT car_id FROM car_shares WHERE user_id = ?))', carId, p.user_id, p.user_id)
      || !!db.get('SELECT 1 FROM users WHERE id = ? AND is_admin = 1', p.user_id);
  });
}

function checkPlaces(db, carId, points) {
  const places = placesFor(db, carId);
  if (!places.length) return;
  const car = db.get('SELECT name FROM cars WHERE id = ?', carId);
  for (const place of places) {
    const key = `${place.id}:${carId}`;
    for (const p of points) {
      const d = haversine(p.lat, p.lon, place.lat, place.lon);
      const was = placeState.get(key);
      // Hysteresis: enter inside the radius, leave only beyond 120% of it, so GPS jitter at the edge doesn't flap.
      const inside = was ? d <= place.radius_m * 1.2 : d <= place.radius_m;
      if (was === undefined) { placeState.set(key, inside); continue; } // first sighting: just learn the state
      if (inside === was) continue;
      placeState.set(key, inside);
      const type = inside ? 'arrived' : 'left';
      db.run('INSERT INTO events(car_id, camera_id, type, t, data) VALUES (?, NULL, ?, ?, ?)', carId, type, p.t,
        JSON.stringify({ place: place.name, placeId: place.id, lat: p.lat, lon: p.lon }));
      if ((inside && place.on_arrive) || (!inside && place.on_leave)) {
        notify(db, {
          title: `${car?.name ?? 'Car'} ${inside ? 'arrived at' : 'left'} ${place.name}`,
          message: `${new Date(p.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
          tags: [inside ? 'round_pushpin' : 'checkered_flag'],
          userIds: [place.user_id],
          url: '/#/map',
        });
      }
    }
  }
}

// ---------------------------------------------------------------- speed

function checkSpeed(db, carId, points) {
  const car = db.get('SELECT name, speed_alert_kmh FROM cars WHERE id = ?', carId);
  const limit = car?.speed_alert_kmh;
  if (!limit) return;
  const units = getSettings(db).units;
  const st = speedState.get(carId) || { overSince: null, alerted: false, belowSince: null, peak: 0, lastAlert: 0 };
  for (const p of points) {
    if (p.speed == null) continue;
    const v = kmh(p.speed);
    if (v > limit) {
      st.belowSince = null;
      st.overSince ??= p.t;
      st.peak = Math.max(st.peak, v);
      // Sustained for 10 s (ignores single GPS glitches); at most one alert per episode and per 10 minutes.
      if (!st.alerted && p.t - st.overSince >= 10_000 && p.t - st.lastAlert > 10 * 60_000) {
        st.alerted = true;
        st.lastAlert = p.t;
        db.run('INSERT INTO events(car_id, camera_id, type, t, data) VALUES (?, NULL, ?, ?, ?)', carId, 'speeding', p.t,
          JSON.stringify({ speedKmh: Math.round(v), limitKmh: limit, lat: p.lat, lon: p.lon }));
        notify(db, {
          title: `${car.name}: over ${fmtSpeed(units, limit)}`,
          message: `Going ${fmtSpeed(units, v)} for at least 10 seconds.`,
          tags: ['rotating_light'],
          priority: 4,
          carId,
          url: '/#/map',
        });
      }
    } else {
      st.overSince = null;
      if (v < limit - 5) {
        st.belowSince ??= p.t;
        if (p.t - st.belowSince >= 60_000) { st.alerted = false; st.peak = 0; } // back under for a minute: re-arm
      }
    }
  }
  speedState.set(carId, st);
}

// ---------------------------------------------------------------- driving events

const THRESHOLDS = { // m/s² (1 g = 9.81)
  low: { brake: 5.0, accel: 4.0, turn: 5.0 },
  normal: { brake: 4.0, accel: 3.2, turn: 4.0 },
  high: { brake: 3.2, accel: 2.6, turn: 3.2 },
};

function detectDriving(db, carId, cameraId, points) {
  const th = THRESHOLDS[getSettings(db).drivingSensitivity] || THRESHOLDS.normal;
  const prev = db.get('SELECT t, lat, lon, speed, course, acc FROM points WHERE camera_id = ? AND t < ? ORDER BY t DESC LIMIT 1', cameraId, points[0].t);
  const seq = prev ? [prev, ...points] : points;
  for (let i = 1; i < seq.length; i++) {
    const a = seq[i - 1];
    const b = seq[i];
    const dt = (b.t - a.t) / 1000;
    // Needs about one GPS point per second, like the tracks recorded with clips.
    if (dt < 0.5 || dt > 2.5 || a.speed == null || b.speed == null) continue;
    if ((a.acc != null && a.acc > 25) || (b.acc != null && b.acc > 25)) continue;
    const along = (b.speed - a.speed) / dt;
    const found = [];
    if (along <= -th.brake && a.speed > 4) found.push(['hard_brake', -along]);
    if (along >= th.accel) found.push(['hard_accel', along]);
    const v = (a.speed + b.speed) / 2;
    if (v > 6 && a.course != null && b.course != null) {
      const dc = ((b.course - a.course + 540) % 360) - 180; // shortest turn, degrees
      const lateral = v * (Math.abs(dc) * Math.PI / 180) / dt;
      if (lateral >= th.turn && Math.abs(dc) < 120) found.push(['sharp_turn', lateral]);
    }
    for (const [type, value] of found) {
      // One event per type within 8 s (e.g. when a track is uploaded again, or by two cameras in the car).
      if (db.get('SELECT 1 FROM events WHERE car_id = ? AND type = ? AND t BETWEEN ? AND ?', carId, type, b.t - 8000, b.t + 8000)) continue;
      db.run('INSERT INTO events(car_id, camera_id, type, t, data) VALUES (?, ?, ?, ?, ?)', carId, cameraId, type, b.t,
        JSON.stringify({ g: Math.round((value / 9.81) * 100) / 100, speedKmh: Math.round(kmh(type === 'hard_brake' ? a.speed : b.speed)), lat: b.lat, lon: b.lon }));
    }
  }
}
