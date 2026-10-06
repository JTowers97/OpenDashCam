// 1.9: everything Command Center's screens use works with the app's sign-in (Bearer key): timeline, calendar,
// thumbnails, clip playback, search, map positions, trips, cars and pairing, and live view's picture stream.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-test-19-'));
const port = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (n) => { passed++; console.log('  ✓', n); };
let log = '';
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.js'], {
  env: { ...process.env, PORT: String(port), ODC_HTTPS_PORT: String(port + 1500), ODC_DATA_DIR: dir, ODC_TRIP_INTERVAL_MS: '300' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));
const post = (url, body, headers = {}) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

try {
  for (let i = 0; i < 50; i++) { try { await fetch(`${base}/api/setup`); break; } catch { await sleep(100); } }
  await post('/api/setup', { username: 'admin', password: 'correct horse' });
  const key = (await (await post('/api/login', { username: 'admin', password: 'correct horse', app: true, deviceName: 'Pixel 8' })).json()).token;
  const app = async (method, url, body) => {
    const h = { Authorization: `Bearer ${key}` };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const r = await fetch(base + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const type = r.headers.get('content-type') || '';
    return { status: r.status, type, data: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };

  // Cars and pairing from the app (as an old phone would then scan)
  let r = await app('POST', '/api/cars', { name: 'CX5' });
  const car = r.data;
  assert.equal(r.status, 201); ok('add a car from the app');
  r = await app('POST', `/api/cars/${car.id}/pairing`, { label: 'Phone 1' });
  const qr = JSON.parse(r.data.qr);
  assert.equal(qr.code, r.data.code); ok('pairing code and QR contents for an old phone to scan');
  const camToken = (await (await post('/api/v1/devices/pair', { code: qr.code })).json()).token;
  assert.ok(camToken); ok('the old phone pairs with that code');
  const phone = { Authorization: `Bearer ${camToken}` };

  // Footage and a trip
  const f = path.join(dir, 'c.mp4');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=5', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f]);
  const b = fs.readFileSync(f);
  const start = Date.now() - 3600_000;
  const up = await (await post('/api/v1/uploads', { fileName: 'ODC_c.mp4', sizeBytes: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex'), startedAt: start, stamp: true }, phone)).json();
  await fetch(`${base}/api/v1/uploads/${up.id}`, { method: 'PATCH', headers: { ...phone, 'Upload-Offset': '0' }, body: b });
  await fetch(`${base}/api/v1/uploads/${up.id}/complete`, { method: 'POST', headers: phone });
  const pts = Array.from({ length: 400 }, (_, i) => `<trkpt lat="${(38.5 + i * 0.0003).toFixed(6)}" lon="-90.3"><time>${new Date(start + i * 1000).toISOString()}</time></trkpt>`).join('');
  await fetch(`${base}/api/v1/clips/${up.id}/sidecar?kind=gpx`, { method: 'POST', headers: phone, body: `<gpx><trk><trkseg>${pts}</trkseg></trk></gpx>` });
  await sleep(2000);

  r = await app('GET', `/api/clips?limit=60&offset=0&car=${car.id}`);
  assert.equal(r.data.total, 1); ok('timeline list');
  const d = new Date(start);
  const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  r = await app('GET', `/api/clips/calendar?month=${month}&car=${car.id}`);
  assert.equal(Object.values(r.data.days)[0].count, 1); ok('calendar');
  r = await app('GET', `/api/clips/${up.id}/thumb`);
  assert.equal(r.status, 200); assert.match(r.type, /image/); ok('thumbnails load with the app’s key');
  r = await app('GET', `/api/clips/${up.id}`);
  const stream = await fetch(`${base}/api/clips/${up.id}/stream?st=${r.data.streamToken}`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(stream.status, 206); ok('clip playback link (the app’s video player)');
  r = await app('PATCH', `/api/clips/${up.id}`, { locked: true });
  assert.equal(r.status, 200); ok('lock a clip from the app');
  r = await app('GET', '/api/search?q=CX5');
  assert.equal(r.data.text.length, 1); ok('search');
  r = await app('GET', '/api/trips');
  assert.equal(r.data.length, 1);
  const trip = (await app('GET', `/api/trips/${r.data[0].id}`)).data;
  assert.ok(trip.route.length > 10); assert.equal(trip.clips.length, 1); ok(`trips, with route (${trip.route.length} points) and clips`);
  await post('/api/v1/live', { lat: 38.6, lon: -90.2, speed: 12 }, phone);
  r = await app('GET', '/api/live');
  assert.equal(r.data[0].position.live, true); ok('map positions');
  r = await app('GET', '/api/cars');
  assert.equal(r.data[0].cameras[0].clips, 1); assert.equal(r.data[0].role, 'owner'); ok('cars with their cameras and footage');

  // Live view's picture stream with the app's key
  const waiting = fetch(`${base}/api/v1/live-view/wait`, { headers: phone });
  await sleep(200);
  const session = (await app('POST', `/api/cars/${car.id}/live-view`, { fps: 1 })).data.session;
  await waiting;
  const jpg = path.join(dir, 's.jpg');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180', '-frames:v', '1', jpg]);
  await fetch(`${base}/api/v1/live-view/${session}/frame?stream=rear&label=Road`, { method: 'POST', headers: { ...phone, 'Content-Type': 'image/jpeg' }, body: fs.readFileSync(jpg) });
  const st = (await app('GET', `/api/live-view/${session}`)).data.streams[0];
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/live-view/${session}/stream?key=${encodeURIComponent(st.key)}`, { headers: { Authorization: `Bearer ${key}` }, signal: ctrl.signal });
  assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /multipart\/x-mixed-replace/);
  const reader = res.body.getReader();
  const { value } = await reader.read();
  assert.ok(Buffer.from(value).toString('latin1').includes('Content-Length:')); ok('live view pictures stream to the app with its key (parts with Content-Length, as the app reads them)');
  ctrl.abort();
  await app('DELETE', `/api/live-view/${session}`);
  console.log(`\nAll ${passed} checks passed.`);
} catch (e) {
  console.error('\nFAILED:', e);
  console.error('--- log ---\n' + log.slice(-3000));
  process.exitCode = 1;
} finally {
  server.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
