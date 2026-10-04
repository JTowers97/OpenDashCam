// 1.3: arrival/leaving alerts, speed alerts, driving events, impact snapshots.
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-test-13-'));
const port = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let log = '';
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.js'], {
  env: { ...process.env, PORT: String(port), ODC_HTTPS_PORT: String(port + 1500), ODC_DATA_DIR: dir, ODC_TRIP_INTERVAL_MS: '300' }, stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));
let passed = 0;
const ok = (n) => { passed++; console.log('  ✓', n); };

// A fake browser push service that decrypts notifications like a browser would.
const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
const uaAuth = crypto.randomBytes(16);
const pushes = [];
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const pushServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const salt = body.subarray(0, 16); const idlen = body[20]; const asPub = body.subarray(21, 21 + idlen); const ct = body.subarray(21 + idlen);
    const ikm = hmac(hmac(uaAuth, ua.computeSecret(asPub)), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub, Buffer.from([1])]));
    const prk = hmac(salt, ikm);
    const d = crypto.createDecipheriv('aes-128-gcm', hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16),
      hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12));
    d.setAuthTag(ct.subarray(ct.length - 16));
    const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
    pushes.push(JSON.parse(plain.subarray(0, plain.length - 1).toString()));
    res.writeHead(201); res.end();
  });
});
await new Promise((r) => pushServer.listen(0, '127.0.0.1', r));

function client() {
  let cookie = '';
  return async (method, url, body) => {
    const h = cookie ? { Cookie: cookie } : {};
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const r = await fetch(base + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, data: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
}
const moveBy = (lat, lon, metersNorth) => [lat + metersNorth / 111_320, lon];

try {
  for (let i = 0; i < 50; i++) { try { await fetch(`${base}/api/setup`); break; } catch { await sleep(100); } }
  const web = client();
  await web('POST', '/api/setup', { username: 'admin', password: 'correct horse' });
  await web('POST', '/api/push/subscribe', { endpoint: `http://127.0.0.1:${pushServer.address().port}/p/1`, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: uaAuth.toString('base64url') } });
  const car = (await web('POST', '/api/cars', { name: 'CX5' })).data;
  const code = (await web('POST', `/api/cars/${car.id}/pairing`, { label: 'Front' })).data.code;
  const token = (await (await fetch(`${base}/api/v1/devices/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json()).token;
  const phone = async (method, url, body, headers = {}) => {
    const h = { Authorization: `Bearer ${token}`, ...headers };
    let payload = body;
    if (body !== undefined && !(body instanceof Uint8Array) && !Buffer.isBuffer(body)) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers: h, body: payload });
    return { status: res.status, data: (res.headers.get('content-type') || '').includes('json') ? await res.json() : null };
  };
  const live = (lat, lon, speed = 10, t = Date.now()) => phone('POST', '/api/v1/live', { lat, lon, speed, course: 0, acc: 8, t });
  const events = async (type) => (await web('GET', '/api/events')).data.filter((e) => e.type === type);

  // ---- arrival / leaving
  const home = [38.6270, -90.1994];
  let r = await web('POST', '/api/alert-places', { name: 'Home', lat: home[0], lon: home[1], radiusM: 150, onArrive: true, onLeave: true });
  assert.equal(r.status, 201); ok('alert place created');
  await live(...moveBy(...home, 2000));                 // far away: just learns "outside"
  await live(...moveBy(...home, 400));
  await live(...moveBy(...home, 60));                   // inside
  await sleep(400);
  assert.equal((await events('arrived')).length, 1);
  assert.ok(pushes.some((p) => p.title === 'CX5 arrived at Home')); ok('arriving sends “CX5 arrived at Home”');
  await live(...moveBy(...home, 165));                  // 110% of radius: GPS jitter, still inside
  await live(...moveBy(...home, 90));
  await live(...moveBy(...home, 170));
  await sleep(300);
  assert.equal((await events('left')).length, 0); ok('jitter near the edge doesn’t trigger “left”');
  await live(...moveBy(...home, 600));
  await sleep(400);
  assert.equal((await events('left')).length, 1); assert.ok(pushes.some((p) => p.title === 'CX5 left Home')); ok('leaving sends “CX5 left Home”');
  await live(...moveBy(...home, 20), 10, Date.now() - 3600_000); // an old point inside: no alert
  await sleep(300);
  assert.equal((await events('arrived')).length, 1); ok('old points don’t trigger alerts');

  // ---- speed alerts
  await web('PATCH', `/api/cars/${car.id}`, { speedAlertKmh: 100 });
  const t0 = Date.now() - 120_000;
  const far = moveBy(...home, 5000);
  await live(...far, 31, t0);                              // 112 km/h, single point: a glitch
  await live(...far, 20, t0 + 5_000);
  await sleep(300);
  assert.equal((await events('speeding')).length, 0); ok('a single fast reading is ignored');
  for (let i = 0; i < 5; i++) await live(...far, 31, t0 + 10_000 + i * 5_000);  // 20 s over
  await sleep(400);
  const sp = await events('speeding');
  assert.equal(sp.length, 1); assert.equal(sp[0].data.speedKmh, 112);
  assert.ok(pushes.some((p) => /CX5: over 100 km\/h/.test(p.title))); ok('sustained speeding alerts once (112 km/h over 100)');
  for (let i = 0; i < 3; i++) await live(...far, 33, t0 + 40_000 + i * 5_000);
  await sleep(300);
  assert.equal((await events('speeding')).length, 1); ok('no repeat alerts while still speeding');
  r = await web('GET', '/api/cars');
  assert.equal(r.data[0].speedAlertKmh, 100); ok('car shows its speed alert');

  // ---- driving events (from a track with one point per second)
  await web('PUT', '/api/settings', { drivingEvents: true });
  const start = Date.now() - 3 * 3600_000;
  const speeds = [];
  const courses = [];
  for (let i = 0; i < 90; i++) {
    let v = 20;
    if (i >= 10 && i < 12) v = 20 - (i - 9) * 6;           // 20 -> 14 -> 8: hard braking (6 m/s²)
    if (i >= 12 && i < 20) v = 8;
    if (i >= 20 && i < 24) v = 8 + (i - 19) * 4;           // +4 m/s²: hard acceleration
    if (i >= 24) v = 24;                                    // then holds speed
    speeds.push(v);
    courses.push(i < 40 ? 90 : i < 41 ? 120 : 120 + (i - 40) * 2); // a 30° turn in one second at 24 m/s: sharp turn
  }
  const pts = speeds.map((v, i) => `<trkpt lat="${(38.5 + i * 0.0002).toFixed(6)}" lon="-90.3"><time>${new Date(start + i * 1000).toISOString()}</time><hdop>1.2</hdop>` +
    `<extensions><gpxtpx:TrackPointExtension><gpxtpx:speed>${v}</gpxtpx:speed><gpxtpx:course>${courses[i]}</gpxtpx:course></gpxtpx:TrackPointExtension></extensions></trkpt>`).join('');
  const gpx = new TextEncoder().encode(`<gpx><trk><trkseg>${pts}</trkseg></trk></gpx>`);
  const f = path.join(dir, 'c.mp4');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=5', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f]);
  const b = fs.readFileSync(f);
  const up = (await phone('POST', '/api/v1/uploads', { fileName: 'ODC_c.mp4', sizeBytes: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex'), startedAt: start })).data;
  await phone('PATCH', `/api/v1/uploads/${up.id}`, b, { 'Upload-Offset': '0' });
  await phone('POST', `/api/v1/uploads/${up.id}/complete`);
  await phone('POST', `/api/v1/clips/${up.id}/sidecar?kind=gpx`, gpx);
  await sleep(500);
  const brakes = await events('hard_brake');
  assert.equal(brakes.length, 1); assert.ok(brakes[0].data.g > 0.5 && brakes[0].data.g < 0.7, `g ${brakes[0].data.g}`);
  assert.equal((await events('hard_accel')).length, 1); assert.equal((await events('sharp_turn')).length, 1);
  ok(`hard braking (${brakes[0].data.g} g), hard acceleration and a sharp turn detected`);
  assert.ok(!pushes.some((p) => /brak/i.test(p.title))); ok('driving events are recorded quietly (no alerts)');
  await phone('POST', `/api/v1/clips/${up.id}/sidecar?kind=gpx`, gpx);
  await sleep(300);
  assert.equal((await events('hard_brake')).length, 1); ok('uploading the same track again doesn’t duplicate events');
  await sleep(1500);
  r = await web('GET', '/api/trips');
  const trip = r.data.find((t) => t.startT <= start + 30_000 && t.endT >= start + 30_000);
  assert.ok(trip, 'trip should exist: ' + JSON.stringify(r.data.map((t) => [new Date(t.startT).toISOString(), (t.endT - t.startT) / 1000, Math.round(t.distanceM)])) + ' track start ' + new Date(start).toISOString());
  const d = (await web('GET', `/api/trips/${trip.id}`)).data;
  assert.deepEqual([...new Set(d.events.map((e) => e.type))].sort(), ['hard_accel', 'hard_brake', 'sharp_turn']); ok('trip details include its driving events');

  // ---- impact snapshot
  const jpg = path.join(dir, 's.jpg');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360', '-frames:v', '1', jpg]);
  r = await phone('POST', '/api/v1/events/snapshot?type=impact&message=2.4%20g%20jolt', fs.readFileSync(jpg), { 'Content-Type': 'image/jpeg' });
  assert.equal(r.status, 201);
  await sleep(500);
  const ev = (await events('impact'))[0];
  assert.equal(ev.snapshotUrl, `/api/snapshots/${ev.id}`); assert.equal(ev.data.message, '2.4 g jolt');
  assert.ok(Math.abs(ev.t - Date.now()) < 60_000, `event time ${new Date(ev.t).toISOString()}`);
  const img = await web('GET', ev.snapshotUrl);
  assert.equal(img.status, 200); assert.equal(img.data[0], 0xff); ok('impact event has its photo');
  const push = pushes.find((p) => /Impact detected/.test(p.title));
  assert.ok(push?.image); ok('the notification includes the photo');
  const imgLink = await fetch(push.image.replace(/^https?:\/\/[^/]+/, base));
  assert.equal(imgLink.status, 200); ok('the notification’s photo link works without signing in');
  assert.equal((await fetch(`${base}/api/snapshots/${ev.id}?st=bogus`)).status, 401); ok('without a valid link or account, the photo isn’t available');
  r = await phone('POST', '/api/v1/events/snapshot?type=impact', Buffer.from('not a jpeg at all, just text...'.repeat(5)), { 'Content-Type': 'image/jpeg' });
  assert.equal(r.status, 400); ok('non-JPEG uploads are rejected');

  console.log(`\nAll ${passed} checks passed.`);
} catch (e) {
  console.error('\nFAILED:', e);
  console.error('--- log ---\n' + log.slice(-3000));
  process.exitCode = 1;
} finally {
  server.kill();
  pushServer.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
