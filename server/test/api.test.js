// End-to-end API test: starts a real server on a temp data dir and exercises the phone and web APIs.
// Requires ffmpeg/ffprobe on PATH. Run: npm test
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-test-'));
const port = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.js'], {
  env: { ...process.env, PORT: String(port), ODC_DATA_DIR: dir, ODC_TRIP_INTERVAL_MS: '500' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (name) => { passed++; console.log('  ✓', name); };

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${base}/api/setup`); return; } catch { await sleep(100); }
  }
  throw new Error('server did not start:\n' + serverLog);
}

function makeClient() {
  let cookie = '';
  return async (method, url, body, headers = {}) => {
    const h = { ...headers };
    if (cookie) h.Cookie = cookie;
    let payload = body;
    if (body !== undefined && !(body instanceof Uint8Array) && typeof body !== 'string') {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const r = await fetch(base + url, { method, headers: h, body: payload });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
    return { status: r.status, data, headers: r.headers };
  };
}

function makeVideo(file, seconds, codec) {
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc=size=640x360:rate=30:duration=${seconds}`,
    '-c:v', codec, '-pix_fmt', 'yuv420p', ...(codec === 'libx265' ? ['-tag:v', 'hvc1', '-x265-params', 'log-level=error'] : []), file]);
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

try {
  await waitForServer();
  const web = makeClient();
  const other = makeClient();

  // ---- setup
  let r = await web('GET', '/api/setup');
  assert.equal(r.data.needsSetup, true); ok('fresh server needs setup');
  r = await web('POST', '/api/setup', { username: 'admin', password: 'short' });
  assert.equal(r.status, 400); ok('rejects short password');
  r = await web('POST', '/api/setup', { username: 'admin', password: 'correct horse' });
  assert.equal(r.status, 201); ok('creates admin and signs in');
  r = await web('POST', '/api/setup', { username: 'x', password: 'correct horse' });
  assert.equal(r.status, 409); ok('setup cannot run twice');
  r = await web('GET', '/api/me');
  assert.equal(r.data.username, 'admin'); assert.equal(r.data.isAdmin, true); ok('session works');

  // ---- users
  r = await web('POST', '/api/users', { username: 'sam', password: 'password123' });
  assert.equal(r.status, 201); ok('admin creates user');
  r = await other('POST', '/api/login', { username: 'sam', password: 'wrong-pass' });
  assert.equal(r.status, 401); ok('wrong password rejected');
  r = await other('POST', '/api/login', { username: 'SAM', password: 'password123' });
  assert.equal(r.status, 200); ok('login (case-insensitive username)');
  r = await other('GET', '/api/users');
  assert.equal(r.status, 403); ok('non-admin cannot list users');

  // ---- car and pairing
  r = await web('POST', '/api/cars', { name: 'Civic' });
  assert.equal(r.status, 201); const car = r.data; ok('creates car');
  r = await web('POST', `/api/cars/${car.id}/pairing`, { label: 'Front' });
  const pairing = r.data;
  assert.match(pairing.code, /^[A-Z2-9]{8}$/); assert.equal(JSON.parse(pairing.qr).code, pairing.code); ok('pairing code + QR payload');
  r = await fetch(`${base}/api/v1/devices/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: pairing.code.toLowerCase(), deviceModel: 'Pixel 8', appVersion: '0.4.0 (test)' }) });
  const paired = await r.json();
  assert.equal(r.status, 200); assert.ok(paired.token); assert.equal(paired.carName, 'Civic'); ok('phone pairs (code is case-insensitive)');
  r = await fetch(`${base}/api/v1/devices/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: pairing.code }) });
  assert.equal(r.status, 400); ok('pairing code is single-use');
  r = await web('POST', `/api/cars/${car.id}/pairing`, { label: 'Rear' });
  r = await fetch(`${base}/api/v1/devices/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: r.data.code }) });
  const paired2 = await r.json();

  const device = (token) => async (method, url, body, headers = {}) => {
    const h = { Authorization: `Bearer ${token}`, ...headers };
    let payload = body;
    if (body !== undefined && !(body instanceof Uint8Array)) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers: h, body: payload });
    const ct = res.headers.get('content-type') || '';
    const data = method === 'HEAD' || res.status === 204 ? null : ct.includes('json') ? await res.json() : null;
    return { status: res.status, data, headers: res.headers };
  };
  const phone = device(paired.token);
  const phone2 = device(paired2.token);
  r = await phone('GET', '/api/v1/devices/me');
  assert.equal(r.data.carName, 'Civic'); ok('device token works');
  r = await device('nope')('GET', '/api/v1/devices/me');
  assert.equal(r.status, 401); ok('bad device token rejected');

  // ---- resumable upload with server-side checksum
  const hevcFile = path.join(dir, 'ODC_20261001_081203_front.mp4');
  makeVideo(hevcFile, 3, 'libx265');
  const bytes = fs.readFileSync(hevcFile);
  const startedAt = Date.parse('2026-10-01T08:12:03Z');
  r = await phone('POST', '/api/v1/uploads', { fileName: path.basename(hevcFile), sizeBytes: bytes.length, sha256: sha(bytes),
    stream: 'front', startedAt, codec: 'hevc', width: 640, height: 360, fps: 30, mode: 'driving' });
  assert.equal(r.status, 201); const up = r.data; ok('upload created');
  const half = Math.floor(bytes.length / 2);
  r = await phone('PATCH', `/api/v1/uploads/${up.id}`, bytes.subarray(0, half), { 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' });
  assert.equal(r.status, 204); assert.equal(r.headers.get('upload-offset'), String(half)); ok('first half uploaded');
  r = await phone('HEAD', `/api/v1/uploads/${up.id}`);
  assert.equal(r.headers.get('upload-offset'), String(half)); ok('HEAD reports resume offset');
  r = await phone('PATCH', `/api/v1/uploads/${up.id}`, bytes.subarray(half), { 'Upload-Offset': '0' });
  assert.equal(r.status, 409); ok('wrong offset rejected');
  r = await phone('POST', '/api/v1/uploads', { fileName: path.basename(hevcFile), sizeBytes: bytes.length, sha256: sha(bytes) });
  assert.equal(r.data.id, up.id); assert.equal(r.data.offset, half); ok('re-creating resumes the same upload');
  // Second half the way Android sends it: POST + X-HTTP-Method-Override: PATCH
  r = await phone('POST', `/api/v1/uploads/${up.id}`, bytes.subarray(half), { 'Upload-Offset': String(half), 'X-HTTP-Method-Override': 'PATCH' });
  assert.equal(r.status, 204); ok('method override (Android) appends data');
  r = await phone('POST', `/api/v1/uploads/${up.id}/complete`);
  assert.equal(r.status, 200); assert.equal(r.data.verified, true); assert.equal(r.data.sha256, sha(bytes)); ok('server verified SHA-256');
  r = await phone('POST', '/api/v1/uploads', { fileName: path.basename(hevcFile), sizeBytes: bytes.length, sha256: sha(bytes) });
  assert.equal(r.data.complete, true); ok('duplicate upload detected as already complete');

  // damaged upload
  const bad = Buffer.from(bytes); bad[100] ^= 0xff;
  r = await phone('POST', '/api/v1/uploads', { fileName: 'damaged.mp4', sizeBytes: bad.length, sha256: sha(Buffer.from(bytes.subarray(0, bytes.length - 1)).toString('hex') + 'x').slice(0, 64), startedAt });
  const badUp = r.data;
  await phone('PATCH', `/api/v1/uploads/${badUp.id}`, bad, { 'Upload-Offset': '0' });
  r = await phone('POST', `/api/v1/uploads/${badUp.id}/complete`);
  assert.equal(r.status, 422); ok('checksum mismatch rejected and discarded');

  // ---- GPX sidecar → track points
  const gpxPts = [];
  for (let i = 0; i < 120; i++) {
    const t = new Date(startedAt + i * 1000).toISOString();
    gpxPts.push(`<trkpt lat="${(40 + i * 0.0003).toFixed(7)}" lon="-90.0000000"><time>${t}</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:speed>13.40</gpxtpx:speed><gpxtpx:course>0.0</gpxtpx:course></gpxtpx:TrackPointExtension></extensions></trkpt>`);
  }
  const gpx = `<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>${gpxPts.join('\n')}</trkseg></trk></gpx>`;
  r = await phone('POST', `/api/v1/clips/${up.id}/sidecar?kind=gpx`, new TextEncoder().encode(gpx));
  assert.equal(r.status, 200); ok('GPX sidecar accepted');

  // ---- thumbnails, metadata, streaming
  await sleep(4000);
  r = await web('GET', `/api/clips/${up.id}`);
  assert.equal(r.data.hasTrack, true); assert.equal(r.data.hasThumb, true); assert.equal(r.data.codec, 'hevc');
  assert.ok(r.data.durationMs > 2000); ok('thumbnail made, duration and codec probed, track linked');
  const st = r.data.streamToken;
  r = await web('GET', `/api/clips/${up.id}/stream`, undefined, { Range: 'bytes=0-99' });
  assert.equal(r.status, 206); assert.equal(r.data.length, 100); assert.ok(r.headers.get('content-range').startsWith('bytes 0-99/')); ok('range requests for seeking');
  r = await fetch(`${base}/api/clips/${up.id}/stream?st=${st}`);
  assert.equal(r.status, 200); ok('stream token works without a session (for players)');
  r = await fetch(`${base}/api/clips/${up.id}/stream?st=123.forged`);
  assert.equal(r.status, 401); ok('forged stream token rejected');
  r = await web('GET', `/api/clips/${up.id}/stream?codec=h264`);
  assert.equal(r.status, 202); ok('H.264 transcode starts on demand');
  for (let i = 0; i < 30 && r.status === 202; i++) { await sleep(500); r = await web('GET', `/api/clips/${up.id}/stream?codec=h264`); }
  assert.equal(r.status, 200);
  const h264 = path.join(dir, 'h264.mp4'); fs.writeFileSync(h264, r.data);
  const codec = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', h264]).toString().trim();
  assert.equal(codec, 'h264'); ok('H.264 copy served');

  // ---- clip listing, sorting, permissions
  const smallFile = path.join(dir, 'ODC_20261001_090000_rear.mp4');
  makeVideo(smallFile, 1, 'libx264');
  const small = fs.readFileSync(smallFile);
  r = await phone2('POST', '/api/v1/uploads', { fileName: path.basename(smallFile), sizeBytes: small.length, sha256: sha(small), startedAt: startedAt + 3600_000, stream: 'rear', mode: 'parking-motion' });
  await phone2('PATCH', `/api/v1/uploads/${r.data.id}`, small, { 'Upload-Offset': '0' });
  await phone2('POST', `/api/v1/uploads/${r.data.id}/complete`);
  r = await web('GET', '/api/clips?sort=size&order=asc');
  assert.equal(r.data.total, 2); assert.ok(r.data.clips[0].size <= r.data.clips[1].size); ok('list sorted by size');
  r = await web('GET', '/api/clips?parking=1');
  assert.equal(r.data.total, 1); ok('filter parking clips');
  r = await other('GET', '/api/clips');
  assert.equal(r.data.total, 0); ok("other users can't see the car");
  r = await other('GET', `/api/clips/${up.id}`);
  assert.equal(r.status, 404); ok("other users can't open a clip by id");
  r = await web('POST', `/api/cars/${car.id}/shares`, { username: 'sam', role: 'viewer' });
  r = await other('GET', '/api/clips');
  assert.equal(r.data.total, 2); ok('sharing as viewer grants access');
  r = await other('PATCH', `/api/clips/${up.id}`, { locked: true });
  assert.equal(r.status, 403); ok('viewers cannot change clips');
  r = await web('PATCH', `/api/clips/${up.id}`, { locked: true });
  assert.equal(r.data.locked, true); ok('owner locks a clip');

  // ---- live, mismatch, map
  await web('PUT', '/api/settings', { mismatchSustainSec: 0 }); // normally 10 s; immediate for the test
  for (let i = 0; i < 4; i++) {
    await phone('POST', '/api/v1/live', { t: Date.now(), lat: 41, lon: -90, speed: 20, course: 0, acc: 5 });
    await phone2('POST', '/api/v1/live', { t: Date.now(), lat: 41.01, lon: -90, speed: 20, course: 0, acc: 5 });
    await sleep(i === 3 ? 0 : 10);
  }
  r = await web('GET', '/api/live');
  assert.equal(r.data[0].position.live, true); assert.ok(r.data[0].position.mismatch); ok('live position with mismatch flag (alert policy)');
  await web('PATCH', `/api/cars/${car.id}`, { mismatchPolicy: 'average' });
  r = await web('GET', '/api/live');
  assert.ok(Math.abs(r.data[0].position.lat - 41.005) < 0.001); ok('average policy merges cameras');
  await web('PATCH', `/api/cars/${car.id}`, { mismatchPolicy: 'source', truthCameraId: paired2.cameraId });
  r = await web('GET', '/api/live');
  assert.ok(Math.abs(r.data[0].position.lat - 41.01) < 1e-9); ok('source-of-truth policy');
  r = await web('PATCH', `/api/cars/${car.id}`, { truthCameraId: null, mismatchPolicy: 'alert' });

  // ---- trips from the GPX track
  await sleep(1500);
  r = await web('GET', '/api/trips');
  const trip = r.data.find((t) => t.startT === startedAt);
  assert.ok(trip, 'trip from GPX'); assert.ok(trip.distanceM > 3500 && trip.distanceM < 4500); ok(`trip built (${Math.round(trip.distanceM)} m)`);
  r = await web('GET', `/api/trips/${trip.id}`);
  assert.ok(r.data.route.length > 100); assert.ok(r.data.clips.some((c) => c.id === up.id)); ok('trip has route and clips');
  r = await web('GET', `/api/cars/${car.id}/route?from=${startedAt}&to=${startedAt + 200_000}`);
  assert.equal(r.data.length, 120); ok('history route');

  // ---- events and heartbeat
  r = await phone('POST', '/api/v1/events', { type: 'impact', message: '2.4 g' });
  r = await phone('POST', '/api/v1/devices/me/heartbeat', { battery: 80, charging: true, recording: true, storageFreeBytes: 5e9, appVersion: '0.4.0 (test)' });
  r = await web('GET', '/api/events');
  assert.ok(r.data.some((e) => e.type === 'impact')); assert.ok(r.data.some((e) => e.type === 'mismatch')); ok('impact and mismatch events recorded');
  r = await web('GET', '/api/cars');
  assert.equal(r.data[0].cameras.length, 2); assert.equal(r.data[0].cameras[0].battery, 80); ok('car view with camera status');

  // ---- app clip list with stream URLs
  r = await phone('GET', '/api/v1/clips');
  assert.equal(r.data.clips.length, 2); assert.ok(r.data.clips[0].streamUrl.includes('?st=')); ok('phone lists server clips with stream URLs');

  // ---- retention by storage cap keeps locked clips
  await web('PUT', '/api/settings', { storageCapGb: 0.0000001 });
  await phone('POST', '/api/v1/uploads', { fileName: 'x.mp4', sizeBytes: 1, sha256: sha(Buffer.from('a')) }).then(async (res) => {
    await phone('PATCH', `/api/v1/uploads/${res.data.id}`, Buffer.from('a'), { 'Upload-Offset': '0' });
    await phone('POST', `/api/v1/uploads/${res.data.id}/complete`);
  });
  await sleep(1500);
  r = await web('GET', '/api/clips');
  assert.ok(r.data.clips.some((c) => c.id === up.id)); assert.ok(r.data.clips.every((c) => c.locked)); ok('storage cap removes oldest unlocked clips, keeps locked');

  // ---- revoke
  r = await web('DELETE', `/api/cameras/${paired2.cameraId}`);
  r = await phone2('GET', '/api/v1/devices/me');
  assert.equal(r.status, 401); ok('revoked phone is locked out');

  console.log(`\nAll ${passed} checks passed.`);
} catch (e) {
  console.error('\nFAILED:', e);
  console.error('--- server log ---\n' + serverLog);
  process.exitCode = 1;
} finally {
  server.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
