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

/** Parses a Viofo file name: 2024_0715_093012_000123F.MP4 (camera local time; F/R/I = lens). */
export function parseName(name) {
  const m = /^(\d{4})_(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(?:_\d+)?([FRI])?\.(mp4|ts)$/i.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, lens] = m;
  return { time: new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime(), lens: (lens || 'F').toUpperCase() };
}

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
      out.push({ path: p, name: tag('NAME') || p.split('/').pop(), folder: folderOf(p), size: Number(tag('SIZE')) || null });
    }
  } catch { /* fall back to folder listings */ }
  if (!out.length) {
    for (const [key, dir] of Object.entries(FOLDERS)) {
      if (!folders.includes(key)) continue;
      let html;
      try { html = await get(`${base}${dir}`); } catch { continue; }
      for (const m of html.matchAll(/href="([^"?]+\.(?:mp4|ts))"/gi)) {
        const p = m[1].startsWith('/') ? m[1] : dir + m[1];
        if (folderOf(p) !== key) continue; // the Movie listing also links into subfolders
        out.push({ path: p, name: p.split('/').pop(), folder: key, size: null });
      }
    }
  }
  const seen = new Set();
  return out
    .filter((f) => /\.(mp4|ts)$/i.test(f.name) && folders.includes(f.folder) && !seen.has(f.path) && seen.add(f.path))
    .map((f) => ({ ...f, info: parseName(f.name) }))
    .filter((f) => f.info)
    .sort((a, b) => b.info.time - a.info.time);
}

async function download(url, dest, expected) {
  const part = `${dest}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  const r = await fetch(url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal: AbortSignal.timeout(30 * 60_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const append = have > 0 && r.status === 206;
  const out = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
  try {
    for await (const chunk of r.body) if (!out.write(chunk)) await new Promise((res) => out.once('drain', res));
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
  const todo = files.filter((f) => !skip.has(f.path) && !db.get('SELECT 1 FROM viofo_files WHERE car_id = ? AND path = ?', car.id, f.path));
  let imported = 0;
  for (const f of todo) {
    if (imported >= maxFiles) break;
    setStatus(db, car.id, { state: 'importing', message: `Importing ${f.name} (${imported + 1} of ${todo.length})`, imported });
    const cam = cameraFor(db, car.id, f.info.lens);
    const day = new Date(f.info.time).toISOString().slice(0, 10);
    const dest = path.join(config.libraryDir, String(car.id), cam.id, day, f.name.replace(/\.ts$/i, '.ts'));
    try {
      const size = await download(`${base}${encodeURI(f.path)}`, dest, f.size);
      const pts = await readGps(dest);
      const startedAt = pts.length ? pts[0].t : f.info.time;
      const id = crypto.randomUUID();
      const first = pts[0];
      if (pts.length) fs.writeFileSync(dest.replace(/\.(mp4|ts)$/i, '.gpx'), gpxFor(pts));
      db.run(`INSERT INTO clips(id, camera_id, car_id, stream, file_name, path, started_at, size, sha256, mode, locked, lock_reason, encrypted,
          has_track, lat, lon, place, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
        id, cam.id, car.id, (LENSES[f.info.lens] || 'front').toLowerCase(), f.name, dest, startedAt, size, await sha256File(dest),
        f.folder === 'parking' ? 'parking' : 'driving', f.folder === 'ro' ? 1 : 0, f.folder === 'ro' ? 'event' : null,
        pts.length ? 1 : 0, first?.lat ?? null, first?.lon ?? null, first ? placeName(first.lat, first.lon) : null, now());
      if (pts.length) insertPoints(db, car.id, cam.id, pts);
      db.run('INSERT OR REPLACE INTO viofo_files(car_id, path, size, clip_id, imported_at) VALUES (?, ?, ?, ?, ?)', car.id, f.path, size, id, now());
      db.run('UPDATE cameras SET last_seen_at = ? WHERE id = ?', now(), cam.id);
      app.onClipAdded(id);
      imported++;
    } catch (e) {
      // Usually the car drove away mid-download: the partial file is kept and resumed next time.
      setStatus(db, car.id, { state: 'interrupted', message: `Stopped at ${f.name}: ${e.message}. It will resume next time.`, imported });
      return { imported, unreachable: false };
    }
  }
  setStatus(db, car.id, { state: 'idle', message: imported ? `Imported ${imported} recordings.` : 'Up to date.', imported, files: files.length });
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
