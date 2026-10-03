import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { config } from './config.js';
import { cameraFromRequest, normalizeCode, streamToken } from './auth.js';
import { getSettings } from './db.js';
import { HttpError, now, num, randomToken, readBody, readJson, send, sha256hex, str, uuid, bool } from './util.js';
import { insertPoints, parseGpx, recordLive } from './tracks.js';
import { placeName } from './geocode.js';
import { notify } from './notify.js';

const API_VERSIONS = [1];

function requireCamera(ctx) {
  const cam = cameraFromRequest(ctx.db, ctx.req);
  if (!cam) throw new HttpError(401, 'Unknown or revoked device. Pair this phone again.');
  ctx.db.run('UPDATE cameras SET last_seen_at = ?, offline_alerted = 0 WHERE id = ?', now(), cam.id);
  return cam;
}

const safeName = (n) => path.basename(String(n || 'clip.mp4')).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
const partPath = (id) => path.join(config.uploadsDir, `${id}.part`);

export function registerDeviceRoutes(router, app) {
  const { db } = app;

  // ---- Pairing
  router.add('POST', '/api/v1/devices/pair', async (ctx) => {
    const body = await readJson(ctx.req);
    const code = normalizeCode(body.code);
    const row = db.get('SELECT * FROM pairing_codes WHERE code_hash = ?', sha256hex(code));
    if (!row || row.used || row.expires_at < now()) {
      throw new HttpError(400, 'This pairing code is invalid or has expired. Create a new one on the server.');
    }
    const token = randomToken();
    const id = uuid();
    db.tx(() => {
      db.run('UPDATE pairing_codes SET used = 1 WHERE code_hash = ?', row.code_hash);
      db.run(
        `INSERT INTO cameras(id, car_id, label, device_model, app_version, token_hash, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id, row.car_id, str(body.label, 40) || row.label, str(body.deviceModel, 80), str(body.appVersion, 60),
        sha256hex(token), now(), now());
    });
    const car = db.get('SELECT name FROM cars WHERE id = ?', row.car_id);
    send(ctx.res, 200, {
      token, cameraId: id, carId: row.car_id, carName: car.name, label: str(body.label, 40) || row.label,
      serverName: getSettings(db).serverName, apiVersions: API_VERSIONS,
    });
  });

  router.add('GET', '/api/v1/devices/me', (ctx) => {
    const cam = requireCamera(ctx);
    const s = getSettings(db);
    send(ctx.res, 200, {
      cameraId: cam.id, carId: cam.car_id, carName: cam.car_name, label: cam.label,
      serverName: s.serverName, serverVersion: config.version, apiVersions: API_VERSIONS,
      units: s.units, liveIntervalSec: 5,
    });
  });

  router.add('GET', '/api/v1/time', (ctx) => send(ctx.res, 200, { now: now() }));

  router.add('POST', '/api/v1/devices/me/heartbeat', async (ctx) => {
    const cam = requireCamera(ctx);
    const b = await readJson(ctx.req);
    const storageFree = num(b.storageFreeBytes);
    db.run(
      `UPDATE cameras SET battery = ?, charging = ?, thermal = ?, storage_free = ?, recording = ?, mode = ?, app_version = COALESCE(?, app_version)
       WHERE id = ?`,
      num(b.battery), bool(b.charging), num(b.thermal), storageFree, bool(b.recording), str(b.mode, 20), str(b.appVersion, 60), cam.id);
    if (storageFree != null && storageFree < 1024 ** 3 && (cam.storage_free == null || cam.storage_free >= 1024 ** 3)) {
      notify(db, { title: `${cam.car_name} · ${cam.label}: phone storage low`, message: 'Less than 1 GB free on the phone.', tags: ['floppy_disk'] });
    }
    send(ctx.res, 200, { ok: true, now: now() });
  });

  // ---- Live position (every few seconds while ODC is open)
  router.add('POST', '/api/v1/live', async (ctx) => {
    const cam = requireCamera(ctx);
    const b = await readJson(ctx.req);
    const p = { t: num(b.t) ?? now(), lat: num(b.lat), lon: num(b.lon), speed: num(b.speed), course: num(b.course), acc: num(b.acc) };
    if (p.lat == null || p.lon == null || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) throw new HttpError(400, 'Invalid position');
    recordLive(db, cam, p);
    send(ctx.res, 200, { ok: true });
  });

  // ---- Events reported by the phone (impact, overheating, ...)
  router.add('POST', '/api/v1/events', async (ctx) => {
    const cam = requireCamera(ctx);
    const b = await readJson(ctx.req);
    const type = str(b.type, 30) || 'event';
    const t = num(b.t) ?? now();
    db.run('INSERT INTO events(car_id, camera_id, type, t, data) VALUES (?, ?, ?, ?, ?)',
      cam.car_id, cam.id, type, t, JSON.stringify(b.data ?? {}));
    const titles = {
      impact: 'Impact detected',
      overheating: 'Phone overheating',
      battery_cutoff: 'Recording paused: low battery',
      recording_stopped: 'Recording stopped after an error',
    };
    if (titles[type]) {
      notify(db, {
        title: `${cam.car_name} · ${cam.label}: ${titles[type]}`,
        message: b.message ? String(b.message).slice(0, 500) : titles[type],
        priority: type === 'impact' ? 5 : 4,
        tags: [type === 'impact' ? 'rotating_light' : 'warning'],
      });
    }
    send(ctx.res, 200, { ok: true });
  });

  // ---- Uploads: create, resume (HEAD), append (PATCH), complete (server verifies SHA-256)
  router.add('POST', '/api/v1/uploads', async (ctx) => {
    const cam = requireCamera(ctx);
    const b = await readJson(ctx.req);
    const size = num(b.sizeBytes);
    const sha = String(b.sha256 || '').toLowerCase();
    if (!size || size <= 0 || !/^[0-9a-f]{64}$/.test(sha)) throw new HttpError(400, 'sizeBytes and sha256 are required');
    const fileName = safeName(b.fileName);

    const existing = db.get('SELECT id FROM clips WHERE camera_id = ? AND sha256 = ?', cam.id, sha);
    if (existing) return send(ctx.res, 200, { id: existing.id, offset: size, complete: true });

    const pending = db.get(`SELECT id FROM uploads WHERE camera_id = ? AND json_extract(meta, '$.sha256') = ?`, cam.id, sha);
    if (pending) {
      const offset = fs.existsSync(partPath(pending.id)) ? fs.statSync(partPath(pending.id)).size : 0;
      return send(ctx.res, 200, { id: pending.id, offset, complete: false });
    }

    const meta = {
      fileName, sha256: sha, sizeBytes: size,
      stream: str(b.stream, 20), startedAt: num(b.startedAt) ?? now(), durationMs: num(b.durationMs),
      codec: str(b.codec, 20), width: num(b.width), height: num(b.height), fps: num(b.fps),
      mode: str(b.mode, 30), locked: Boolean(b.locked), lockReason: str(b.lockReason, 20),
      encrypted: Boolean(b.encrypted) || fileName.endsWith('.odcenc'),
    };
    const id = uuid();
    fs.mkdirSync(config.uploadsDir, { recursive: true });
    fs.writeFileSync(partPath(id), Buffer.alloc(0));
    db.run('INSERT INTO uploads(id, camera_id, meta, size, created_at) VALUES (?, ?, ?, ?, ?)', id, cam.id, JSON.stringify(meta), size, now());
    send(ctx.res, 201, { id, offset: 0, complete: false });
  });

  const loadUpload = (cam, id) => {
    const up = db.get('SELECT * FROM uploads WHERE id = ? AND camera_id = ?', id, cam.id);
    if (!up) throw new HttpError(404, 'Upload not found');
    return up;
  };

  router.add('GET', '/api/v1/uploads/:id', (ctx) => {
    const cam = requireCamera(ctx);
    const up = loadUpload(cam, ctx.params.id);
    const offset = fs.existsSync(partPath(up.id)) ? fs.statSync(partPath(up.id)).size : 0;
    ctx.res.writeHead(200, { 'Upload-Offset': String(offset), 'Upload-Length': String(up.size), 'Cache-Control': 'no-store', 'Content-Type': 'application/json' });
    ctx.res.end(ctx.req.method === 'HEAD' ? undefined : JSON.stringify({ offset, size: up.size }));
  });

  router.add('PATCH', '/api/v1/uploads/:id', async (ctx) => {
    const cam = requireCamera(ctx);
    const up = loadUpload(cam, ctx.params.id);
    const file = partPath(up.id);
    const current = fs.existsSync(file) ? fs.statSync(file).size : 0;
    const offset = Number(ctx.req.headers['upload-offset']);
    if (offset !== current) {
      ctx.req.resume();
      return send(ctx.res, 409, { error: 'Offset mismatch', offset: current }, { 'Upload-Offset': String(current) });
    }
    let written = 0;
    const limiter = new Transform({
      transform(chunk, _enc, cb) {
        written += chunk.length;
        if (current + written > up.size) return cb(new HttpError(413, 'More data than declared'));
        cb(null, chunk);
      },
    });
    await pipeline(ctx.req, limiter, fs.createWriteStream(file, { flags: 'a' }));
    const newOffset = current + written;
    ctx.res.writeHead(204, { 'Upload-Offset': String(newOffset), 'Cache-Control': 'no-store' });
    ctx.res.end();
  });

  router.add('POST', '/api/v1/uploads/:id/complete', async (ctx) => {
    const cam = requireCamera(ctx);
    const up = loadUpload(cam, ctx.params.id);
    const meta = JSON.parse(up.meta);
    const file = partPath(up.id);
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    if (size !== up.size) throw new HttpError(409, `Upload incomplete: ${size} of ${up.size} bytes`);

    const hash = crypto.createHash('sha256');
    await pipeline(fs.createReadStream(file), hash);
    const actual = hash.digest('hex');
    if (actual !== meta.sha256) {
      fs.rmSync(file, { force: true });
      db.run('DELETE FROM uploads WHERE id = ?', up.id);
      throw new HttpError(422, 'Checksum mismatch: the upload was damaged and has been discarded. It will be sent again.');
    }

    const day = new Date(meta.startedAt).toISOString().slice(0, 10);
    const dir = path.join(config.libraryDir, String(cam.car_id), cam.id, day);
    fs.mkdirSync(dir, { recursive: true });
    let dest = path.join(dir, meta.fileName);
    if (fs.existsSync(dest)) dest = path.join(dir, `${up.id.slice(0, 8)}_${meta.fileName}`);
    fs.renameSync(file, dest);

    db.tx(() => {
      db.run(
        `INSERT INTO clips(id, camera_id, car_id, stream, file_name, path, started_at, duration_ms, size, sha256, codec, width, height, fps,
           mode, locked, lock_reason, encrypted, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        up.id, cam.id, cam.car_id, meta.stream, meta.fileName, dest, meta.startedAt, meta.durationMs, size, actual,
        meta.codec, meta.width, meta.height, meta.fps, meta.mode, bool(meta.locked), meta.lockReason, bool(meta.encrypted), now());
      db.run('DELETE FROM uploads WHERE id = ?', up.id);
    });
    app.onClipAdded(up.id);
    send(ctx.res, 200, { id: up.id, sha256: actual, verified: true });
  });

  // ---- Sidecars (GPS track, subtitles) for a finished clip
  router.add('POST', '/api/v1/clips/:id/sidecar', async (ctx) => {
    const cam = requireCamera(ctx);
    const clip = db.get('SELECT * FROM clips WHERE id = ? AND camera_id = ?', ctx.params.id, cam.id);
    if (!clip) throw new HttpError(404, 'Clip not found');
    const kind = ctx.query.get('kind');
    const encrypted = ctx.query.get('encrypted') === '1';
    if (!['gpx', 'srt'].includes(kind)) throw new HttpError(400, 'kind must be gpx or srt');
    const body = await readBody(ctx.req, 20_000_000);
    const base = clip.path.replace(/\.(mp4|odcenc)$/, '');
    fs.writeFileSync(`${base}.${kind}${encrypted ? '.odcenc' : ''}`, body);
    if (kind === 'gpx' && !encrypted) {
      const points = parseGpx(body.toString('utf8'));
      insertPoints(db, cam.car_id, cam.id, points);
      if (points.length) {
        db.run('UPDATE clips SET has_track = 1, lat = ?, lon = ?, place = ? WHERE id = ?',
          points[0].lat, points[0].lon, placeName(points[0].lat, points[0].lon), clip.id);
      }
    }
    send(ctx.res, 200, { ok: true });
  });

  // ---- Clips of this phone's car, for browsing in the app
  router.add('GET', '/api/v1/clips', (ctx) => {
    const cam = requireCamera(ctx);
    const limit = Math.min(200, Number(ctx.query.get('limit')) || 50);
    const offset = Number(ctx.query.get('offset')) || 0;
    const rows = db.all(
      `SELECT c.id, c.file_name, c.started_at, c.duration_ms, c.size, c.locked, c.encrypted, c.mode, c.codec, m.label AS camera
       FROM clips c JOIN cameras m ON m.id = c.camera_id WHERE c.car_id = ? ORDER BY c.started_at DESC LIMIT ? OFFSET ?`,
      cam.car_id, limit, offset);
    const base = app.publicUrl(ctx.req);
    send(ctx.res, 200, {
      clips: rows.map((r) => {
        const st = streamToken(db, r.id);
        return {
          id: r.id, fileName: r.file_name, startedAt: r.started_at, durationMs: r.duration_ms, size: r.size,
          locked: !!r.locked, encrypted: !!r.encrypted, mode: r.mode, codec: r.codec, camera: r.camera,
          streamUrl: `${base}/api/clips/${r.id}/stream?st=${st}`,
          h264Url: `${base}/api/clips/${r.id}/stream?codec=h264&st=${st}`,
          thumbUrl: `${base}/api/clips/${r.id}/thumb?st=${st}`,
        };
      }),
    });
  });
}
