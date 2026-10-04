import { getSettings } from './db.js';
import { haversine, now } from './util.js';
import { notify } from './notify.js';
import { analyzePoints } from './alerts.js';
import { placeName } from './geocode.js';

// Alerts follow the server's Units setting; "auto" shows both, since the server can't know the reader's region.
const fmtDist = (units, m) => units === 'mph' ? `${Math.round(m / 0.3048)} ft` : units === 'kmh' ? `${Math.round(m)} m` : `${Math.round(m / 0.3048)} ft (${Math.round(m)} m)`;
const fmtSpeedKmh = (units, k) => units === 'mph' ? `${Math.round(k / 1.609344)} mph` : units === 'kmh' ? `${Math.round(k)} km/h` : `${Math.round(k / 1.609344)} mph (${Math.round(k)} km/h)`;

/** Parses the GPX files ODC writes (GPX 1.1 + Garmin TrackPointExtension speed/course). */
export function parseGpx(xml) {
  const points = [];
  const re = /<trkpt\s+lat="([-\d.]+)"\s+lon="([-\d.]+)"[^>]*>([\s\S]*?)<\/trkpt>/g;
  let m;
  while ((m = re.exec(xml))) {
    const body = m[3];
    const time = /<time>([^<]+)<\/time>/.exec(body)?.[1];
    const t = time ? Date.parse(time) : NaN;
    if (!Number.isFinite(t)) continue;
    const speed = /<(?:gpxtpx:)?speed>([-\d.]+)</.exec(body)?.[1];
    const course = /<(?:gpxtpx:)?course>([-\d.]+)</.exec(body)?.[1];
    const hdop = /<hdop>([-\d.]+)</.exec(body)?.[1];
    points.push({
      t,
      lat: Number(m[1]),
      lon: Number(m[2]),
      speed: speed != null ? Number(speed) : null,
      course: course != null ? Number(course) : null,
      acc: hdop != null ? Number(hdop) * 5 : null,
    });
  }
  return points;
}

export function insertPoints(db, carId, cameraId, points) {
  if (!points.length) return;
  db.tx(() => {
    for (const p of points) {
      db.run(
        `INSERT OR IGNORE INTO points(car_id, camera_id, t, lat, lon, speed, course, acc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        carId, cameraId, p.t, p.lat, p.lon, p.speed, p.course, p.acc);
    }
  });
  markTripsDirty(carId, points[0].t);
  analyzePoints(db, carId, cameraId, points);
}

// ---------------------------------------------------------------- trips

const dirty = new Map(); // carId -> earliest changed time
export function markTripsDirty(carId, t) {
  const cur = dirty.get(carId);
  if (cur === undefined || t < cur) dirty.set(carId, t);
}

const TRIP_GAP_MS = 5 * 60_000;
const MIN_TRIP_MS = 60_000;
const MIN_TRIP_M = 200;

/** Which camera's points describe the car: the chosen source of truth, else the camera with the most points. */
function primaryCamera(db, carId, from, to) {
  const car = db.get('SELECT truth_camera_id FROM cars WHERE id = ?', carId);
  if (car?.truth_camera_id) return car.truth_camera_id;
  return db.get(
    `SELECT camera_id, COUNT(*) n FROM points WHERE car_id = ? AND t BETWEEN ? AND ? GROUP BY camera_id ORDER BY n DESC LIMIT 1`,
    carId, from, to)?.camera_id || null;
}

export function routePoints(db, carId, from, to) {
  const cam = primaryCamera(db, carId, from, to);
  if (!cam) return [];
  return db.all(
    'SELECT t, lat, lon, speed, course FROM points WHERE camera_id = ? AND t BETWEEN ? AND ? ORDER BY t',
    cam, from, to);
}

const PLACE_RADIUS_M = 250;
const COMMUTE_STOP_MS = 15 * 60_000;

/** A learned place near these coordinates, if commute learning is on. */
function nearPlace(places, la, lo) {
  let best = null;
  let bestD = PLACE_RADIUS_M;
  for (const p of places) {
    const d = haversine(p.lat, p.lon, la, lo);
    if (d <= bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

function learnedPlaces(db, carId) {
  return getSettings(db).commuteLearning ? db.all('SELECT * FROM places WHERE car_id = ?', carId) : [];
}

/** "Home → Work", "Springfield, IL → Chicago, IL", "Around Springfield, IL", or null. */
function autoName(places, a, b, startPlace, endPlace) {
  const from = nearPlace(places, a.lat, a.lon)?.label || startPlace;
  const to = nearPlace(places, b.lat, b.lon)?.label || endPlace;
  if (!from && !to) return null;
  if (from && to && from === to) return `Around ${from}`;
  return `${from || 'Unknown'} → ${to || 'Unknown'}`;
}

/** Splits GPS points into trips: gaps over 5 min end a trip, unless merged; manual splits always end one. */
function segment(pts, edits, places) {
  const splits = edits.filter((e) => e.kind === 'split').map((e) => e.from_t);
  const merges = edits.filter((e) => e.kind === 'merge');
  const segs = [];
  let cur = { pts: [], manualStart: false, manualEnd: false };
  for (const p of pts) {
    if (cur.pts.length) {
      const prev = cur.pts[cur.pts.length - 1];
      const split = splits.some((t) => prev.t < t && t <= p.t);
      const gap = p.t - prev.t > TRIP_GAP_MS && !merges.some((m) => m.from_t <= prev.t && p.t <= m.to_t);
      if (split || gap) {
        cur.manualEnd = split;
        segs.push(cur);
        cur = { pts: [], manualStart: split, manualEnd: false };
      }
    }
    cur.pts.push(p);
  }
  if (cur.pts.length) segs.push(cur);

  // Commute learning: a short stop (fuel, coffee) between two learned places doesn't end the trip.
  if (places.length) {
    for (let i = 0; i < segs.length - 1; i++) {
      const a = segs[i];
      const b = segs[i + 1];
      if (a.manualEnd) continue;
      const aStart = a.pts[0];
      const aEnd = a.pts[a.pts.length - 1];
      const bStart = b.pts[0];
      const bEnd = b.pts[b.pts.length - 1];
      if (bStart.t - aEnd.t > COMMUTE_STOP_MS) continue;
      if (nearPlace(places, aStart.lat, aStart.lon) && nearPlace(places, bEnd.lat, bEnd.lon) && !nearPlace(places, aEnd.lat, aEnd.lon)) {
        a.pts = a.pts.concat(b.pts);
        a.manualEnd = b.manualEnd;
        segs.splice(i + 1, 1);
        i--;
      }
    }
  }
  return segs;
}

/** Rebuilds trips for cars whose points changed. Called periodically and after trip edits. */
export function rebuildDirtyTrips(db) {
  for (const [carId, since] of dirty) {
    dirty.delete(carId);
    rebuildTrips(db, carId, since);
  }
}

export function rebuildTrips(db, carId, since) {
  // Start from the beginning of the trip that contains `since`, if any.
  const overlapping = db.get('SELECT MIN(start_t) s FROM trips WHERE car_id = ? AND end_t >= ?', carId, since - TRIP_GAP_MS);
  const from = Math.min(since, overlapping?.s ?? since) - TRIP_GAP_MS;
  const to = now() + 60_000;
  const pts = routePoints(db, carId, from, to);
  const edits = db.all('SELECT * FROM trip_edits WHERE car_id = ? AND COALESCE(to_t, from_t) >= ?', carId, from);
  const places = learnedPlaces(db, carId);
  const named = new Map(db.all('SELECT start_t, name FROM trips WHERE car_id = ? AND end_t >= ? AND name IS NOT NULL', carId, from)
    .map((r) => [r.start_t, r.name]));
  db.tx(() => {
    db.run('DELETE FROM trips WHERE car_id = ? AND end_t >= ?', carId, from);
    for (const seg of segment(pts, edits, places)) {
      const ps = seg.pts;
      if (ps.length < 2) continue;
      let dist = 0;
      let max = 0;
      for (let i = 1; i < ps.length; i++) {
        dist += haversine(ps[i - 1].lat, ps[i - 1].lon, ps[i].lat, ps[i].lon);
        max = Math.max(max, ps[i].speed ?? 0);
      }
      const dur = ps[ps.length - 1].t - ps[0].t;
      // Tiny segments are GPS noise, unless the user split them off on purpose.
      if (!seg.manualStart && !seg.manualEnd && (dur < MIN_TRIP_MS || dist < MIN_TRIP_M)) continue;
      const a = ps[0];
      const b = ps[ps.length - 1];
      const startPlace = placeName(a.lat, a.lon);
      const endPlace = placeName(b.lat, b.lon);
      db.run(
        `INSERT INTO trips(car_id, start_t, end_t, distance_m, max_speed, avg_speed, start_lat, start_lon, end_lat, end_lon,
           name, start_place, end_place, auto_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        carId, a.t, b.t, dist, max, dur > 0 ? dist / (dur / 1000) : 0, a.lat, a.lon, b.lat, b.lon,
        named.get(a.t) ?? null, startPlace, endPlace, autoName(places, a, b, startPlace, endPlace));
    }
  });
}

/** Splits a trip at time t (kept across rebuilds). */
export function splitTrip(db, trip, t) {
  db.run('INSERT INTO trip_edits(car_id, kind, from_t) VALUES (?, ?, ?)', trip.car_id, 'split', t);
  rebuildTrips(db, trip.car_id, trip.start_t);
}

/** Merges two consecutive trips (kept across rebuilds). */
export function mergeTrips(db, a, b) {
  // Remove manual splits at the boundary, and bridge the time gap.
  db.run(`DELETE FROM trip_edits WHERE car_id = ? AND kind = 'split' AND from_t > ? AND from_t <= ?`, a.car_id, a.end_t, b.start_t);
  db.run('INSERT INTO trip_edits(car_id, kind, from_t, to_t) VALUES (?, ?, ?, ?)', a.car_id, 'merge', a.end_t, b.start_t);
  rebuildTrips(db, a.car_id, a.start_t);
}

// ---------------------------------------------------------------- commute learning

/**
 * Learns frequently visited places from the last 120 days of trips: endpoints within 250 m are
 * clustered; places visited 3+ times are kept. "Home" is where trips tend to start in the morning and
 * end in the evening; "Work" is where weekday trips tend to end in the morning and start in the
 * afternoon. Runs entirely on this server. Users can rename places.
 */
export function learnPlaces(db, carId) {
  const trips = db.all('SELECT * FROM trips WHERE car_id = ? AND start_t > ?', carId, now() - 120 * 86400_000);
  const clusters = [];
  const add = (la, lo, t, isStart) => {
    let c = clusters.find((x) => haversine(x.lat, x.lon, la, lo) <= PLACE_RADIUS_M);
    if (!c) clusters.push((c = { lat: la, lon: lo, n: 0, home: 0, work: 0 }));
    c.lat = (c.lat * c.n + la) / (c.n + 1);
    c.lon = (c.lon * c.n + lo) / (c.n + 1);
    c.n++;
    const d = new Date(t);
    const hour = d.getHours();
    const weekday = d.getDay() >= 1 && d.getDay() <= 5;
    if (isStart && hour >= 5 && hour < 11) c.home++;
    if (!isStart && (hour >= 17 || hour < 4)) c.home++;
    if (weekday && !isStart && hour >= 6 && hour < 11) c.work++;
    if (weekday && isStart && hour >= 14 && hour < 20) c.work++;
  };
  for (const t of trips) {
    if (t.start_lat == null || t.end_lat == null) continue;
    add(t.start_lat, t.start_lon, t.start_t, true);
    add(t.end_lat, t.end_lon, t.end_t, false);
  }
  const frequent = clusters.filter((c) => c.n >= 3);
  const home = frequent.filter((c) => c.home >= 3).sort((a, b) => b.home - a.home)[0];
  const work = frequent.filter((c) => c !== home && c.work >= 3).sort((a, b) => b.work - a.work)[0];

  const sig = (rows) => rows.map((r) => `${r.kind}:${r.lat.toFixed(3)},${r.lon.toFixed(3)}`).sort().join('|');
  const before = sig(db.all('SELECT * FROM places WHERE car_id = ?', carId));
  const old = db.all('SELECT * FROM places WHERE car_id = ? AND custom_label = 1', carId);
  db.tx(() => {
    db.run('DELETE FROM places WHERE car_id = ?', carId);
    for (const c of frequent) {
      const kind = c === home ? 'home' : c === work ? 'work' : 'frequent';
      const custom = old.find((o) => haversine(o.lat, o.lon, c.lat, c.lon) <= PLACE_RADIUS_M);
      const label = custom?.label || (kind === 'home' ? 'Home' : kind === 'work' ? 'Work' : placeName(c.lat, c.lon));
      db.run('INSERT INTO places(car_id, lat, lon, visits, kind, label, custom_label) VALUES (?, ?, ?, ?, ?, ?, ?)',
        carId, c.lat, c.lon, c.n, kind, label, custom ? 1 : 0);
    }
  });
  // New or moved places can change where trips split (short stops on a commute), so rebuild; otherwise just rename.
  if (sig(db.all('SELECT * FROM places WHERE car_id = ?', carId)) !== before) rebuildTrips(db, carId, now() - 120 * 86400_000);
  else relabelTrips(db, carId);
}

/** Re-applies place names and learned places to trip names without rebuilding trips. */
export function relabelTrips(db, carId) {
  const places = learnedPlaces(db, carId);
  db.tx(() => {
    for (const t of db.all('SELECT * FROM trips WHERE car_id = ?', carId)) {
      const startPlace = t.start_place || placeName(t.start_lat, t.start_lon);
      const endPlace = t.end_place || placeName(t.end_lat, t.end_lon);
      const auto = autoName(places, { lat: t.start_lat, lon: t.start_lon }, { lat: t.end_lat, lon: t.end_lon }, startPlace, endPlace);
      db.run('UPDATE trips SET start_place = ?, end_place = ?, auto_name = ? WHERE id = ?', startPlace, endPlace, auto, t.id);
    }
  });
}

// ---------------------------------------------------------------- live positions

const FRESH_MS = 2 * 60_000;
const mismatchState = new Map(); // carId -> { since, alertedAt, distance, speedDiff }

export function recordLive(db, camera, p) {
  db.run(
    `INSERT INTO live(camera_id, car_id, t, lat, lon, speed, course, acc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(camera_id) DO UPDATE SET car_id = excluded.car_id, t = excluded.t, lat = excluded.lat, lon = excluded.lon,
       speed = excluded.speed, course = excluded.course, acc = excluded.acc`,
    camera.id, camera.car_id, p.t, p.lat, p.lon, p.speed, p.course, p.acc);
  insertPoints(db, camera.car_id, camera.id, [p]);
  checkMismatch(db, camera.car_id);
}

/** Compares cameras in the same car; a sustained disagreement becomes an event and an alert. */
function checkMismatch(db, carId) {
  const s = getSettings(db);
  const rows = db.all('SELECT * FROM live WHERE car_id = ? AND t > ?', carId, now() - 15_000);
  let worst = null;
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i];
      const b = rows[j];
      if (Math.abs(a.t - b.t) > 5_000) continue;
      const d = haversine(a.lat, a.lon, b.lat, b.lon);
      const sd = Math.abs((a.speed ?? 0) - (b.speed ?? 0)) * 3.6;
      if (d > s.mismatchDistanceM || sd > s.mismatchSpeedKmh) {
        if (!worst || d > worst.distance) worst = { distance: d, speedDiffKmh: sd, cameras: [a.camera_id, b.camera_id] };
      }
    }
  }
  const st = mismatchState.get(carId);
  if (!worst) {
    if (st) mismatchState.delete(carId);
    return;
  }
  const t = now();
  const state = st || { since: t, alertedAt: 0 };
  Object.assign(state, worst);
  mismatchState.set(carId, state);
  if (t - state.since >= s.mismatchSustainSec * 1000 && t - state.alertedAt > 5 * 60_000) {
    state.alertedAt = t;
    db.run('INSERT INTO events(car_id, camera_id, type, t, data) VALUES (?, NULL, ?, ?, ?)',
      carId, 'mismatch', t, JSON.stringify(worst));
    const car = db.get('SELECT name FROM cars WHERE id = ?', carId);
    notify(db, {
      title: `${car?.name ?? 'Car'}: cameras disagree`,
      message: `Two cameras report positions ${fmtDist(s.units, worst.distance)} apart and speeds ${fmtSpeedKmh(s.units, worst.speedDiffKmh)} apart.`,
      tags: ['warning'],
      carId,
    });
  }
}

/** The car's position for the map, per its mismatch policy: alert (primary camera), source of truth, or average. */
export function carLive(db, car) {
  const rows = db.all('SELECT * FROM live WHERE car_id = ? ORDER BY t DESC', car.id);
  if (!rows.length) return null;
  const fresh = rows.filter((r) => now() - r.t < FRESH_MS);
  const mismatch = mismatchState.get(car.id);
  const active = mismatch && now() - mismatch.since >= 0 ? { distance: mismatch.distance, speedDiffKmh: mismatch.speedDiffKmh } : null;
  let pos;
  if (fresh.length > 1 && car.mismatch_policy === 'average') {
    let wsum = 0, lat = 0, lon = 0, speed = 0;
    for (const r of fresh) {
      const w = 1 / Math.max(1, r.acc ?? 10);
      wsum += w;
      lat += r.lat * w;
      lon += r.lon * w;
      speed += (r.speed ?? 0) * w;
    }
    pos = { t: fresh[0].t, lat: lat / wsum, lon: lon / wsum, speed: speed / wsum, course: fresh[0].course, source: 'average' };
  } else {
    const truth = car.truth_camera_id && rows.find((r) => r.camera_id === car.truth_camera_id);
    const r = (car.mismatch_policy === 'source' && truth) || fresh[0] || rows[0];
    pos = { t: r.t, lat: r.lat, lon: r.lon, speed: r.speed, course: r.course, source: r.camera_id };
  }
  return { ...pos, live: now() - pos.t < FRESH_MS, mismatch: car.mismatch_policy === 'alert' ? active : null };
}
