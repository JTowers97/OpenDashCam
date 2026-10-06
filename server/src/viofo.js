import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { config } from './config.js';
import { placeName } from './geocode.js';
import { insertPoints } from './tracks.js';
import { now } from './util.js';

/**
 * Imports recordings from Viofo dashcams over Wi-Fi. When the camera is on the home network (Viofo
 * "station mode"), the server lists its files, downloads new ones (resuming interrupted downloads) and adds
 * them as clips of the car, with GPS read from the video (ExifTool), so maps, trips, alerts and search work
 * as with phone footage. Each lens (front, rear, interior) becomes a camera of the car.
 *
 * Camera interface (Novatek, used by Viofo): file list at /?custom=1&cmd=3015&par=1 (XML), or the folder
 * listings /DCIM/Movie, /DCIM/Movie/Parking, /DCIM/Movie/RO; files download over plain HTTP.
 */
const EXIFTOOL = process.env.ODC_EXIFTOOL || 'exiftool';
const FOLDERS = { movie: '/DCIM/Movie/', parking: '/DCIM/Movie/Parking/', ro: '/DCIM/Movie/RO/' };
const LENSES = { F: 'Front', R: 'Rear', I: 'Interior' };
let running = false;

const setStatus = (db, carId, st) => db.run('UPDATE cars SET viofo_status = ? WHERE id = ?', JSON.stringify({ ...st, at: now() }), carId);

async function get(url, ms = 8000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

/**
 * Parses a dashcam file name (camera local time; F/R/I = front/rear/interior lens). Accepts the common styles:
 * 2024_0715_093012_000123F.MP4, 20240715_093012_0123F.MP4, 20240715093012_000123F.MP4, 2024_0715_093012_F.MP4.
 * If the name has no recognizable date, the time the camera reports for the file (`fallbackTime`) is used.
 */
export function parseName(name, fallbackTime = null) {
  if (!/\.(mp4|ts|mov)$/i.test(name)) return null;
  const lensM = /(?:^|[_-])?([FRI])(?:[_-]?\d*)?\.(mp4|ts|mov)$/i.exec(name);
  const lens = (lensM?.[1] || 'F').toUpperCase();
  const m = /(\d{4})[_-]?(\d{2})(\d{2})[_-]?(\d{2})(\d{2})(\d{2})/.exec(name);
  if (m) {
    const [, y, mo, d, h, mi, s] = m;
    const t = new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
    if (+y >= 2010 && +mo >= 1 && +mo <= 12 && Number.isFinite(t)) return { time: t, lens };
  }
  if (fallbackTime && /\.(mp4|ts|mov)$/i.test(name)) return { time: fallbackTime, lens };
  return null;
}

/** "2026/09/15 08:00:00" (the camera's file time in its XML list) -> ms, or null. */
const cameraTime = (s) => {
  const m = /(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s || '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
};

/** Lists videos on the camera: [{ path, name, folder, size|null }] (newest first). */
export async function listFiles(base, folders) {
  const out = [];
  const folderOf = (p) => (/\/RO\//i.test(p) ? 'ro' : /\/Parking\//i.test(p) ? 'parking' : 'movie');
  try {
    const xml = await get(`${base}/?custom=1&cmd=3015&par=1`, 15_000);
    for (const f of xml.match(/<File>[\s\S]*?<\/File>/gi) || []) {
      const tag = (t) => new RegExp(`<${t}>([^<]*)</${t}>`, 'i').exec(f)?.[1]?.trim();
      const fpath = tag('FPATH');
      if (!fpath) continue;
      const p = '/' + fpath.replace(/^[A-Z]:\\?/i, '').replace(/\\/g, '/').replace(/^\/+/, '');
      out.push({ path: p, name: tag('NAME') || p.split('/').pop(), folder: folderOf(p), size: Number(tag('SIZE')) || null, camTime: cameraTime(tag('TIME')) });
    }
  } catch { /* fall back to folder listings */ }
  if (!out.length) {
    for (const [key, dir] of Object.entries(FOLDERS)) {
      if (!folders.includes(key)) continue;
      let html;
      try { html = await get(`${base}${dir}`); } catch { continue; }
      for (const m of html.matchAll(/href="([^"?]+\.(?:mp4|ts|mov))"/gi)) {
        const p = m[1].startsWith('/') ? m[1] : dir + m[1];
        if (folderOf(p) !== key) continue; // the Movie listing also links into subfolders
        out.push({ path: p, name: p.split('/').pop(), folder: key, size: null });
      }
    }
  }
  const seen = new Set();
  const videos = out.filter((f) => /\.(mp4|ts|mov)$/i.test(f.name) && folders.includes(f.folder) && !seen.has(f.path) && seen.add(f.path))
    .map((f) => ({ ...f, info: parseName(f.name, f.camTime) }));
  const known = videos.filter((f) => f.info).sort((a, b) => b.info.time - a.info.time);
  known.unrecognized = videos.filter((f) => !f.info).map((f) => f.name);
  return known;
}

async function download(url, dest, expected, onProgress = () => {}) {
  const part = `${dest}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  const r = await fetch(url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal: AbortSignal.timeout(30 * 60_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const append = have > 0 && r.status === 206;
  const out = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
  try {
    let got = have;
    for await (const chunk of r.body) {
      got += chunk.length;
      onProgress(got, have);
      if (!out.write(chunk)) await new Promise((res) => out.once('drain', res));
    }
  } finally {
    await new Promise((res) => out.end(res));
  }
  const size = fs.statSync(part).size;
  if (expected && size !== expected) throw new Error(`incomplete download (${size} of ${expected} bytes)`);
  fs.renameSync(part, dest);
  return size;
}

const sha256File = (file) => new Promise((res, rej) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
});

/** GPS embedded in the video, via ExifTool: [{ t, lat, lon, speed (m/s), course }]. Empty if unavailable. */
export function readGps(file) {
  return new Promise((resolve) => {
    execFile(EXIFTOOL, ['-api', 'LargeFileSupport=1', '-ee', '-n', '-j', '-G3', '-GPSDateTime', '-GPSLatitude', '-GPSLongitude', '-GPSSpeed', '-GPSTrack', file],
      { maxBuffer: 64 * 1024 * 1024, timeout: 120_000 }, (err, stdout) => {
        if (err && !stdout) return resolve([]);
        try {
          const docs = new Map();
          for (const [k, v] of Object.entries(JSON.parse(stdout)[0] || {})) {
            const m = /^Doc(\d+):GPS(\w+)$/.exec(k);
            if (!m) continue;
            if (!docs.has(m[1])) docs.set(m[1], {});
            docs.get(m[1])[m[2]] = v;
          }
          const pts = [];
          for (const d of docs.values()) {
            const iso = String(d.DateTime || '').replace(/^(\d{4}):(\d{2}):(\d{2}) /, '$1-$2-$3T');
            const t = Date.parse(/Z|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`);
            const lat = Number(d.Latitude);
            const lon = Number(d.Longitude);
            if (!Number.isFinite(t) || !Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
            pts.push({ t, lat, lon, speed: d.Speed != null ? Number(d.Speed) / 3.6 : null, course: d.Track != null ? Number(d.Track) : null, acc: null });
          }
          resolve(pts.sort((a, b) => a.t - b.t));
        } catch {
          resolve([]);
        }
      });
  });
}

function gpxFor(points) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Open Dash Cam (Viofo import)" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v2"><trk><trkseg>\n${points.map((p) =>
    `<trkpt lat="${p.lat}" lon="${p.lon}"><time>${new Date(p.t).toISOString()}</time>${p.speed != null ? `<extensions><gpxtpx:TrackPointExtension><gpxtpx:speed>${p.speed.toFixed(2)}</gpxtpx:speed>${p.course != null ? `<gpxtpx:course>${p.course}</gpxtpx:course>` : ''}</gpxtpx:TrackPointExtension></extensions>` : ''}</trkpt>`).join('\n')}\n</trkseg></trk></gpx>\n`;
}

function cameraFor(db, carId, lens) {
  const key = `viofo:${carId}:${lens}`;
  const row = db.get('SELECT * FROM cameras WHERE token_hash = ?', key);
  if (row) return row;
  const id = crypto.randomUUID();
  db.run('INSERT INTO cameras(id, car_id, label, device_model, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id, carId, `Viofo ${LENSES[lens] || lens}`, 'Viofo dashcam', key, now());
  return db.get('SELECT * FROM cameras WHERE id = ?', id);
}

/** Where a recording is stored in the library. */
export function destFor(car, cam, time, name) {
  return path.join(config.libraryDir, String(car.id), cam.id, new Date(time).toISOString().slice(0, 10), path.basename(name));
}

/** True if this car already has this recording (same name and size), from any import route. */
export function alreadyImported(db, carId, name, size) {
  return !!db.get('SELECT 1 FROM clips WHERE car_id = ? AND file_name = ? AND (? IS NULL OR size = ?)', carId, name, size ?? null, size ?? null);
}

/**
 * Adds a recording that's already at its place in the library: reads its GPS, stores it as a clip of the car
 * (event recordings locked, parking ones marked) and records where it came from. Shared by Wi-Fi and SD card import.
 */
export async function storeRecording(db, app, car, cam, { file, name, folder, info, cameraPath }) {
  const size = fs.statSync(file).size;
  const pts = await readGps(file);
  const startedAt = pts.length ? pts[0].t : info.time;
  const id = crypto.randomUUID();
  const first = pts[0];
  if (pts.length) fs.writeFileSync(file.replace(/\.(mp4|ts|mov)$/i, '.gpx'), gpxFor(pts));
  db.run(`INSERT INTO clips(id, camera_id, car_id, stream, file_name, path, started_at, size, sha256, mode, locked, lock_reason, encrypted,
      has_track, lat, lon, place, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    id, cam.id, car.id, (LENSES[info.lens] || 'front').toLowerCase(), name, file, startedAt, size, await sha256File(file),
    folder === 'parking' ? 'parking' : 'driving', folder === 'ro' ? 1 : 0, folder === 'ro' ? 'event' : null,
    pts.length ? 1 : 0, first?.lat ?? null, first?.lon ?? null, first ? placeName(first.lat, first.lon) : null, now());
  if (pts.length) insertPoints(db, car.id, cam.id, pts);
  if (cameraPath) db.run('INSERT OR REPLACE INTO viofo_files(car_id, path, size, clip_id, imported_at) VALUES (?, ?, ?, ?, ?)', car.id, cameraPath, size, id, now());
  db.run('UPDATE cameras SET last_seen_at = ? WHERE id = ?', now(), cam.id);
  app.onClipAdded(id);
  return id;
}

export { cameraFor, folderOfPath };
const folderOfPath = (p) => (/(^|\/)RO\//i.test(p) ? 'ro' : /(^|\/)Parking\//i.test(p) ? 'parking' : 'movie');

/** Checks one car's camera and imports what's new. Returns { imported, unreachable }. */
export async function importCar(db, app, car, { maxFiles = Infinity } = {}) {
  const base = car.viofo_url.replace(/\/$/, '');
  const folders = (car.viofo_folders || 'movie,parking,ro').split(',');
  let files;
  try {
    files = await listFiles(base, folders);
  } catch {
    files = null;
  }
  if (!files) {
    setStatus(db, car.id, { state: 'unreachable', message: 'Camera not reachable (it’s only reachable while on your network).' });
    return { imported: 0, unreachable: true };
  }
  // The newest normal and parking recordings may still be being written; they're imported once a newer one exists.
  const skip = new Set();
  for (const folder of ['movie', 'parking']) {
    for (const lens of Object.keys(LENSES)) {
      const newest = files.find((f) => f.folder === folder && f.info.lens === lens);
      if (newest) skip.add(newest.path);
    }
  }
  const lenses = (car.viofo_lenses || 'F,R,I').split(',');
  const todo = files.filter((f) => lenses.includes(f.info.lens) && !skip.has(f.path)
    && !db.get('SELECT 1 FROM viofo_files WHERE car_id = ? AND path = ?', car.id, f.path) && !alreadyImported(db, car.id, f.name, f.size));
  let imported = 0;
  for (const f of todo) {
    if (imported >= maxFiles) break;
    const cam = cameraFor(db, car.id, f.info.lens);
    const dest = destFor(car, cam, f.info.time, f.name);
    try {
      // Progress with transfer speed, so slow Wi-Fi is easy to spot.
      const t0 = Date.now();
      let lastUpdate = 0;
      const progress = (got, resumedFrom) => {
        if (Date.now() - lastUpdate < 2000) return;
        lastUpdate = Date.now();
        const mbps = (got - resumedFrom) / 1e6 / Math.max(0.5, (Date.now() - t0) / 1000);
        const pct = f.size ? ` · ${Math.round((got / f.size) * 100)}%` : '';
        const eta = f.size && mbps > 0 ? ` · about ${Math.max(1, Math.round((f.size - got) / 1e6 / mbps / 60))} min left` : '';
        setStatus(db, car.id, { state: 'importing', message: `Importing ${f.name} (${imported + 1} of ${todo.length})${pct} · ${mbps.toFixed(1)} MB/s${eta}`, imported, mbps });
      };
      setStatus(db, car.id, { state: 'importing', message: `Importing ${f.name} (${imported + 1} of ${todo.length})`, imported });
      await download(`${base}${encodeURI(f.path)}`, dest, f.size, progress);
      await storeRecording(db, app, car, cam, { file: dest, name: f.name, folder: f.folder, info: f.info, cameraPath: f.path });
      imported++;
    } catch (e) {
      // Usually the car drove away mid-download: the partial file is kept and resumed next time.
      setStatus(db, car.id, { state: 'interrupted', message: `Stopped at ${f.name}: ${e.message}. It will resume next time.`, imported });
      return { imported, unreachable: false };
    }
  }
  let message = imported ? `Imported ${imported} recordings.` : 'Up to date.';
  if (!files.length && files.unrecognized?.length) {
    message = `Found ${files.unrecognized.length} videos, but couldn’t read their date from the names (e.g. ${files.unrecognized[0]}). Please report this model.`;
  } else if (!files.length) {
    message = 'Connected, but no recordings were found in the selected folders.';
  } else if (!imported && todo.length === 0 && skip.size >= files.length) {
    message = 'Connected. The newest recording is waiting until the camera starts the next one (it may still be recording).';
  }
  setStatus(db, car.id, { state: 'idle', message, imported, files: files.length });
  return { imported, unreachable: false };
}

/** Background loop: every couple of minutes, each car with a Viofo camera configured. */
export async function viofoTick(db, app) {
  if (running) return;
  running = true;
  try {
    for (const car of db.all("SELECT * FROM cars WHERE viofo_url IS NOT NULL AND viofo_url != ''")) {
      await importCar(db, app, car);
    }
  } catch (e) {
    console.warn('Viofo import:', e.message);
  } finally {
    running = false;
  }
}
