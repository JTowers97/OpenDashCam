import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { getMeta, getSettings, openDb, setMeta } from './db.js';
import { installSafetyNet } from './errors.js';
import { resumeShares } from './shares.js';
import { Router } from './router.js';
import { HttpError, now, send } from './util.js';
import { registerDeviceRoutes } from './routes-device.js';
import { registerWebRoutes } from './routes-web.js';
import { JobQueue, h264Path, makeThumbnail, probe, thumbPath, transcodeH264 } from './media.js';
import { learnPlaces, rebuildDirtyTrips, relabelTrips } from './tracks.js';
import { loadGeocoder, placeName } from './geocode.js';
import { forgetClip, runIndexer } from './search.js';
import { purgeOldPlates, purgeStampReadings, runPlateIndexer } from './plates.js';
import { loadTls } from './tls.js';
import { httpsRedirect, securityHeaders } from './headers.js';
import { maybeBackup } from './backup.js';
import { purgeAudit } from './audit.js';
import { deleteShareFiles, purgeExpiredShares } from './shares.js';
import { cleanReports } from './reports.js';
import { haShutdown, haTick } from './homeassistant.js';
import { viofoTick } from './viofo.js';
import { maybeSendSummaries } from './summary.js';
import { purgeNotifications } from './notify.js';
import { notify } from './notify.js';

for (const d of [config.dataDir, config.libraryDir, config.uploadsDir, config.cacheDir]) fs.mkdirSync(d, { recursive: true });

const db = openDb(config.dbPath);
installSafetyNet();
const tls = loadTls(config.dataDir);
// Readings of the date/time stamp logged before the stamp area was skipped: removed once.
if (getMeta(db, 'stamp_readings_cleaned_v2') !== '1') {
  const n = purgeStampReadings(db);
  setMeta(db, 'stamp_readings_cleaned_v2', '1');
  if (n) console.log(`Removed ${n} license plate readings of the date/time stamp.`);
}
const jobs = new JobQueue(1);        // thumbnails and probing
const transcodes = new JobQueue(1);  // H.264 conversions

const app = {
  db,
  tls,

  /** The address phones should use, e.g. https://opendashcam.example.com */
  publicUrl(req) {
    if (process.env.ODC_PUBLIC_URL) return process.env.ODC_PUBLIC_URL.replace(/\/$/, '');
    const proto = (req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim();
    const host = (req.headers['x-forwarded-host'] || req.headers.host || `localhost:${config.port}`).split(',')[0].trim();
    return `${proto}://${host}`;
  },

  onClipAdded(clipId) {
    jobs.push(`clip:${clipId}`, async () => {
      const c = db.get('SELECT * FROM clips WHERE id = ?', clipId);
      if (!c) return;
      if (!c.encrypted) {
        const info = await probe(c.path);
        db.run('UPDATE clips SET duration_ms = COALESCE(?, duration_ms), codec = COALESCE(?, codec), width = COALESCE(?, width), height = COALESCE(?, height) WHERE id = ?',
          info.durationMs ?? null, info.codec ?? null, info.width ?? null, info.height ?? null, c.id);
        if (await makeThumbnail(c.path, c.id)) db.run('UPDATE clips SET has_thumb = 1 WHERE id = ?', c.id);
        const updated = db.get('SELECT * FROM clips WHERE id = ?', c.id);
        if (getSettings(db).preTranscode && updated.codec && updated.codec !== 'h264') app.transcode(updated);
      }
      enforceRetention();
    }).catch((e) => console.warn('clip processing failed:', e.message));
  },

  transcode(clip) {
    if (transcodes.has(clip.id) || fs.existsSync(h264Path(clip.id))) return;
    transcodes.push(clip.id, () => transcodeH264(clip.path, clip.id))
      .catch((e) => console.warn('transcode failed:', e.message));
  },

  deleteClipFiles(clip) {
    forgetClip(clip.id);
    deleteShareFiles(db, clip.id);
    fs.rmSync(path.join(config.cacheDir, 'decrypted', `${clip.id}.mp4`), { force: true });
    const base = clip.path.replace(/\.(mp4|odcenc)$/, '');
    for (const f of [clip.path, `${base}.gpx`, `${base}.srt`, `${base}.gpx.odcenc`, `${base}.srt.odcenc`, thumbPath(clip.id), h264Path(clip.id)]) {
      fs.rmSync(f, { force: true });
    }
  },
};

// ---------------------------------------------------------------- retention and alerts

function deleteClip(c) {
  app.deleteClipFiles(c);
  db.run('DELETE FROM clips WHERE id = ?', c.id);
}

function enforceRetention() {
  const s = getSettings(db);
  const t = now();
  const deleteOldestUntil = (rows, overBy) => {
    let left = overBy;
    for (const c of rows) {
      if (left <= 0) break;
      deleteClip(c);
      left -= c.size;
    }
  };
  // Age: each car's own setting (0 = keep forever), else the server default.
  for (const car of db.all('SELECT id, retention_days FROM cars')) {
    const days = car.retention_days ?? s.retentionDays;
    if (days > 0) for (const c of db.all('SELECT id, path FROM clips WHERE car_id = ? AND locked = 0 AND started_at < ?', car.id, t - days * 86400_000)) deleteClip(c);
  }
  // Size limit per car.
  for (const car of db.all('SELECT id, name, storage_cap_gb FROM cars WHERE storage_cap_gb > 0')) {
    const used = db.get('SELECT COALESCE(SUM(size), 0) s FROM clips WHERE car_id = ?', car.id).s;
    const cap = car.storage_cap_gb * 1024 ** 3;
    if (used > cap) deleteOldestUntil(db.all('SELECT id, path, size FROM clips WHERE car_id = ? AND locked = 0 ORDER BY started_at', car.id), used - cap);
  }
  // Size limit per person, across the cars they own.
  for (const u of db.all('SELECT id, username, quota_gb FROM users WHERE quota_gb > 0')) {
    const used = db.get('SELECT COALESCE(SUM(c.size), 0) s FROM clips c JOIN cars k ON k.id = c.car_id WHERE k.owner_id = ?', u.id).s;
    const cap = u.quota_gb * 1024 ** 3;
    if (used > cap) {
      deleteOldestUntil(db.all('SELECT c.id, c.path, c.size FROM clips c JOIN cars k ON k.id = c.car_id WHERE k.owner_id = ? AND c.locked = 0 ORDER BY c.started_at', u.id), used - cap);
    }
    const after = db.get('SELECT COALESCE(SUM(c.size), 0) s FROM clips c JOIN cars k ON k.id = c.car_id WHERE k.owner_id = ?', u.id).s;
    const day = new Date().toISOString().slice(0, 10);
    if (after >= cap * 0.9 && getMeta(db, `quota_warned_${u.id}`) !== day) {
      setMeta(db, `quota_warned_${u.id}`, day);
      const car = db.get('SELECT id FROM cars WHERE owner_id = ? LIMIT 1', u.id);
      notify(db, {
        title: `${u.username}: storage limit almost reached`,
        message: `Footage uses ${(after / 1024 ** 3).toFixed(1)} of ${u.quota_gb} GB. The oldest unlocked clips are being removed.`,
        tags: ['floppy_disk'], carId: car?.id ?? null, kind: 'storage',
      });
    }
  }
  // Server-wide limit.
  if (s.storageCapGb > 0) {
    const cap = s.storageCapGb * 1024 ** 3;
    const used = db.get('SELECT COALESCE(SUM(size), 0) s FROM clips').s;
    if (used > cap) deleteOldestUntil(db.all('SELECT id, path, size FROM clips WHERE locked = 0 ORDER BY started_at'), used - cap);
    const after = db.get('SELECT COALESCE(SUM(size), 0) s FROM clips').s;
    const day = new Date().toISOString().slice(0, 10);
    if (after >= cap * 0.9 && getMeta(db, 'cap_warned') !== day) {
      setMeta(db, 'cap_warned', day);
      notify(db, {
        title: 'ODC server storage almost full',
        message: `Footage uses ${(after / 1024 ** 3).toFixed(1)} of ${s.storageCapGb} GB. The oldest unlocked clips are being removed.`,
        tags: ['floppy_disk'], kind: 'storage',
      });
    }
  }
}
app.enforceRetention = enforceRetention;

/** Decrypted playback copies are removed an hour after their last use. */
function cleanDecrypted() {
  const dir = path.join(config.cacheDir, 'decrypted');
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const p = path.join(dir, f);
    if (Date.now() - fs.statSync(p).mtimeMs > 3600_000) fs.rmSync(p, { force: true });
  }
}

function checkOffline() {
  const s = getSettings(db);
  const cutoff = now() - s.offlineAlertMin * 60_000;
  const rows = db.all(`SELECT c.id, c.label, c.car_id, k.name AS car_name FROM cameras c JOIN cars k ON k.id = c.car_id
    WHERE c.recording = 1 AND c.offline_alerted = 0 AND c.last_seen_at < ? AND c.token_hash NOT LIKE 'revoked:%'`, cutoff);
  for (const c of rows) {
    db.run('UPDATE cameras SET offline_alerted = 1 WHERE id = ?', c.id);
    db.run('INSERT INTO events(car_id, camera_id, type, t, data) VALUES (?, ?, ?, ?, ?)', c.car_id, c.id, 'offline', now(), '{}');
    notify(db, {
      title: `${c.car_name} · ${c.label} went offline`,
      message: `No contact for ${s.offlineAlertMin} minutes while it was recording.`,
      tags: ['electric_plug'],
      carId: c.car_id,
      kind: 'offline',
    });
  }
}

// Abandoned uploads (no progress for 7 days) are removed.
function cleanUploads() {
  for (const u of db.all('SELECT id FROM uploads WHERE created_at < ?', now() - 7 * 86400_000)) {
    fs.rmSync(path.join(config.uploadsDir, `${u.id}.part`), { force: true });
    db.run('DELETE FROM uploads WHERE id = ?', u.id);
  }
}

// Place names: load GeoNames data, then fill in clips and trips that don't have a place yet.
loadGeocoder().then((ok) => {
  if (!ok) return;
  for (const c of db.all('SELECT id, lat, lon FROM clips WHERE place IS NULL AND lat IS NOT NULL')) {
    db.run('UPDATE clips SET place = ? WHERE id = ?', placeName(c.lat, c.lon), c.id);
  }
  for (const car of db.all('SELECT DISTINCT car_id FROM trips WHERE start_place IS NULL')) relabelTrips(db, car.car_id);
}).catch((e) => console.warn('geocoder failed:', e.message));

function learnAllPlaces() {
  if (!getSettings(db).commuteLearning) return;
  for (const c of db.all('SELECT id FROM cars')) learnPlaces(db, c.id);
}

const every = (ms, fn) => setInterval(() => { try { fn(); } catch (e) { console.warn(e); } }, ms).unref();
every(Number(process.env.ODC_TRIP_INTERVAL_MS) || 30_000, () => rebuildDirtyTrips(db));
every(60_000, checkOffline);
// Smart search indexing runs in the background whenever there are new clips and the ML service is up.
// Analysis runs in batches and keeps going while there's a backlog (e.g. existing footage after turning a
// feature on), then waits for new clips. Smart search and plates take turns so neither starves the other.
let analyzing = false;
async function analyzeLoop() {
  if (analyzing) return;
  analyzing = true;
  try {
    for (;;) {
      const a = await runIndexer(db, 10);
      const b = await runPlateIndexer(db, 5);
      if (!a && !b) break;
    }
  } catch (e) {
    console.warn('analysis:', e.message);
  } finally {
    analyzing = false;
  }
}
app.analyzeNow = () => { analyzeLoop(); };
every(Number(process.env.ODC_INDEX_INTERVAL_MS) || 30_000, analyzeLoop);
every(3600_000, () => { enforceRetention(); cleanUploads(); learnAllPlaces(); purgeOldPlates(db); });
every(10 * 60_000, cleanDecrypted);
every(Number(process.env.ODC_VIOFO_INTERVAL_MS) || 120_000, () => viofoTick(db, app));
every(Number(process.env.ODC_HA_INTERVAL_MS) || 5000, () => { try { haTick(db); } catch (e) { console.warn('Home Assistant:', e.message); } });
every(3600_000, () => {
  purgeAudit(db, getSettings(db).auditRetentionDays);
  purgeExpiredShares(db);
  maybeSendSummaries(db);
  purgeNotifications(db);
  cleanReports();
  const b = maybeBackup(db, config.dataDir);
  if (b) console.log('Database backup written:', b);
});

// Finish processing for clips that arrived before a restart.
for (const c of db.all('SELECT id FROM clips WHERE has_thumb = 0 AND encrypted = 0 ORDER BY started_at DESC LIMIT 200')) app.onClipAdded(c.id);

// ---------------------------------------------------------------- HTTP

const router = new Router();
registerDeviceRoutes(router, app);
registerWebRoutes(router, app);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

/**
 * Static web app. Browsers must check for a newer version on every load (with a cheap 304 when nothing
 * changed), and index.html links the script and styles with the server version, so an update is
 * picked up immediately instead of after the browser's cache expires.
 */
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html'; // single-page app
  const file = path.normalize(path.join(config.publicDir, rel));
  if (!file.startsWith(config.publicDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return send(res, 404, { error: 'Not found' });
  }
  const stat = fs.statSync(file);
  const etag = `"${config.version}-${stat.size}-${Math.round(stat.mtimeMs)}"`;
  const headers = {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  if (rel === '/index.html') {
    const html = fs.readFileSync(file, 'utf8')
      .replace('src="/app.js"', `src="/app.js?v=${config.version}-${Math.round(fs.statSync(path.join(config.publicDir, 'app.js')).mtimeMs)}"`)
      .replace('href="/style.css"', `href="/style.css?v=${config.version}-${Math.round(fs.statSync(path.join(config.publicDir, 'style.css')).mtimeMs)}"`);
    res.writeHead(200, headers);
    return res.end(html);
  }
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://local');
  const secure = !!req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  securityHeaders(db, req, res, secure);
  if (httpsRedirect(db, req, res, secure, config.httpsPort)) return;
  const ip = config.trustProxy ? (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress : req.socket.remoteAddress;
  try {
    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/s/')) return serveStatic(req, res, url.pathname);
    // Android's HttpURLConnection can't send PATCH; it sends POST + X-HTTP-Method-Override (as tus allows).
    const override = String(req.headers['x-http-method-override'] || '').toUpperCase();
    const method = req.method === 'POST' && ['PATCH', 'DELETE'].includes(override) ? override : req.method;
    const m = router.match(method, url.pathname);
    if (!m) throw new HttpError(404, 'Not found');
    if (m.methodNotAllowed) throw new HttpError(405, 'Method not allowed');
    await m.handler({ req, res, params: m.params, query: url.searchParams, db, ip, method });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(req.method, url.pathname, e);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'Server error' : e.message, ...(e.extra || {}) });
    else res.destroy();
  }
}

const server = http.createServer(handle);
// Built-in HTTPS on its own port, with the server's own certificate (see tls.js).
const secureServer = https.createServer({ key: tls.key, cert: tls.cert }, handle);
secureServer.requestTimeout = 0;
secureServer.listen(config.httpsPort, () => {
  console.log(`HTTPS on port ${config.httpsPort} (certificate fingerprint ${tls.fingerprint})`);
});

server.requestTimeout = 0; // large uploads
server.listen(config.port, () => {
  console.log(`Open Dash Cam server ${config.version} listening on port ${config.port} (data: ${config.dataDir})`);
});

const shutdown = () => { haShutdown(db); secureServer.close(); server.close(() => process.exit(0)); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Share links interrupted by a restart: prepare them again.
const resumed = resumeShares(db);
if (resumed) console.log(`Resuming ${resumed} share link${resumed === 1 ? '' : 's'} that were being prepared.`);
