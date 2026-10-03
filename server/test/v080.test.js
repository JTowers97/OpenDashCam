// v0.8.0: analyzing existing footage (backlog, ranges, redo) and tracking-only uploads.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-test-8-'));
const port = 18000 + Math.floor(Math.random() * 1000);
const mlPort = port + 1000;
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let log = '';
const ml = spawn('python3', ['ml/app.py'], { env: { ...process.env, ODC_ML_FAKE: '1', PORT: String(mlPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
ml.stderr.on('data', (d) => (log += '[ml] ' + d));
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.js'], {
  env: { ...process.env, PORT: String(port), ODC_DATA_DIR: dir, ODC_ML_URL: `http://127.0.0.1:${mlPort}`, ODC_INDEX_INTERVAL_MS: '60000', ODC_TRIP_INTERVAL_MS: '300' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));
let passed = 0;
const ok = (n) => { passed++; console.log('  ✓', n); };
let cookie = '';
async function web(method, url, body) {
  const h = cookie ? { Cookie: cookie } : {};
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(base + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return { status: r.status, data: (r.headers.get('content-type') || '').includes('json') ? await r.json() : null };
}
const waitFor = async (fn, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(400);
  }
};

try {
  for (let i = 0; i < 50; i++) { try { await fetch(`${base}/api/setup`); break; } catch { await sleep(100); } }
  await web('POST', '/api/setup', { username: 'admin', password: 'correct horse' });
  const car = (await web('POST', '/api/cars', { name: 'CX5' })).data;
  const code = (await web('POST', `/api/cars/${car.id}/pairing`, { label: 'Front' })).data.code;
  const token = (await (await fetch(`${base}/api/v1/devices/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json()).token;
  const phone = async (method, url, body, headers = {}) => {
    const h = { Authorization: `Bearer ${token}`, ...headers };
    let payload = body;
    if (body !== undefined && !(body instanceof Uint8Array)) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(base + url, { method, headers: h, body: payload });
    return { status: r.status, data: r.status !== 204 && (r.headers.get('content-type') || '').includes('json') ? await r.json() : null };
  };

  // 14 "old" clips uploaded before any analysis is turned on: 12 recent, 2 from 60 days ago.
  const now = Date.now();
  const ids = [];
  for (let i = 0; i < 14; i++) {
    const f = path.join(dir, `c${i}.mp4`);
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${i % 2 ? 'red' : 'blue'}:size=160x90:rate=5`, '-t', '3',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-metadata', `comment=${i}`, f]);
    const b = fs.readFileSync(f);
    const startedAt = i < 12 ? now - (i + 1) * 3600_000 : now - 60 * 86400_000 - i * 1000;
    const up = (await phone('POST', '/api/v1/uploads', { fileName: `c${i}.mp4`, sizeBytes: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex'), startedAt })).data;
    await phone('PATCH', `/api/v1/uploads/${up.id}`, b, { 'Upload-Offset': '0' });
    await phone('POST', `/api/v1/uploads/${up.id}/complete`);
    ids.push(up.id);
  }

  // Turning smart search on analyzes all existing footage, beyond a single batch.
  await web('PUT', '/api/settings', { smartSearch: true });
  let st = await waitFor(async () => { const s = (await web('GET', '/api/search/status')).data; return s.indexed === 14 && s; });
  assert.equal(st.indexed, 14); ok('existing footage analyzed for smart search (14 clips, more than one batch)');

  // Plates: only clips within the retention period are read.
  await web('PUT', '/api/settings', { plateSearch: true, plateRetentionDays: 30 });
  st = await waitFor(async () => { const s = (await web('GET', '/api/search/status')).data; return s.platesIndexed === 12 && s; });
  assert.equal(st.platesIndexed, 12); assert.equal(st.platesEligible, 12); ok('plates read from the 12 clips within the 30-day retention');
  let r = await web('POST', '/api/search/analyze', { plates: true, smart: false });
  assert.equal(r.data.plates.skippedOlderThanRetention, 2); ok('analyze reports clips skipped for being older than retention');
  await web('PUT', '/api/settings', { plateRetentionDays: 0 });
  r = await web('POST', '/api/search/analyze', { plates: true, smart: false });
  await waitFor(async () => (await web('GET', '/api/search/status')).data.platesIndexed === 14);
  ok('with "keep forever", older footage is read too');

  // Redo a date range
  const from = now - 3 * 3600_000 - 60_000;
  r = await web('POST', '/api/search/analyze', { from, to: now, redo: true, plates: false });
  assert.equal(r.data.smart.reset, 3); ok('redo a date range re-queues just those clips (3)');
  st = await waitFor(async () => { const s = (await web('GET', '/api/search/status')).data; return s.indexed === 14 && s; });
  ok('re-analysis finishes');
  r = await web('POST', '/api/search/analyze', { car: car.id + 99, redo: true });
  assert.equal(r.data.smart.reset, 0); ok('car filter applies');
  r = await web('GET', '/api/search?q=RED123');
  assert.equal(r.data.plates.length, 7); ok('plate search covers old and new footage (7 red clips)');

  // ---- tracking-only batches
  const t0 = now - 20 * 60_000;
  const points = Array.from({ length: 60 }, (_, i) => ({ t: t0 + i * 10_000, lat: 39 + i * 0.0005, lon: -94.5, speed: 14, acc: 8 }));
  r = await phone('POST', '/api/v1/track', { points: points.slice(0, 40) });
  assert.equal(r.data.accepted, 40); ok('batch of 40 tracked points accepted');
  r = await phone('POST', '/api/v1/track', { points: [...points.slice(40), { t: 0, lat: 999, lon: 0 }] });
  assert.equal(r.data.accepted, 20); ok('invalid points are dropped');
  r = await web('GET', '/api/live');
  assert.ok(Math.abs(r.data[0].position.lat - points[59].lat) < 1e-9); ok('newest tracked point is the live position');
  r = await web('GET', `/api/cars/${car.id}/route?from=${t0}&to=${now}`);
  assert.equal(r.data.length, 60); ok('tracked points form the route history');
  await sleep(1200);
  r = await web('GET', '/api/trips');
  assert.ok(r.data.some((t) => t.startT === t0)); ok('a trip is built from tracking data');
  r = await web('GET', '/api/cars');
  assert.equal(r.data[0].cameras[0].mode, 'tracking'); ok('the phone shows as tracking');

  // ---- clip locations for the app's map view
  const gpx = `<gpx><trk><trkseg><trkpt lat="39.1000000" lon="-94.6000000"><time>${new Date(now - 3600_000).toISOString()}</time></trkpt></trkseg></trk></gpx>`;
  await phone('POST', `/api/v1/clips/${ids[0]}/sidecar?kind=gpx`, new TextEncoder().encode(gpx));
  r = await phone('GET', '/api/v1/clips?located=1&limit=500');
  assert.equal(r.data.clips.length, 1); assert.equal(r.data.clips[0].lat, 39.1); ok('phone can list clips that have a location');

  console.log(`\nAll ${passed} checks passed.`);
} catch (e) {
  console.error('\nFAILED:', e);
  console.error('--- log ---\n' + log.slice(-3000));
  process.exitCode = 1;
} finally {
  server.kill();
  ml.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
