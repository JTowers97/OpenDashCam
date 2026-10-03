// Tests for v0.5: place names, trip split/merge, two-factor sign-in, synced playback data, commute learning.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { totpAt } from '../src/totp.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-test-b-'));
const geo = path.join(dir, 'geonames');
fs.mkdirSync(geo);
// A tiny GeoNames extract in the real file format.
const row = (id, name, lat, lon, cc, a1) => [id, name, name, '', lat, lon, 'P', 'PPL', cc, '', a1, '', '', '', '1000', '', '200', 'America/Chicago', '2024-01-01'].join('\t');
fs.writeFileSync(path.join(geo, 'cities500.txt'), [
  row(1, 'Testville', 40.0, -90.0, 'US', 'IL'),
  row(2, 'Endburg', 40.036, -90.0, 'US', 'IL'),
  row(3, 'Homeford', 38.20, -90.40, 'US', 'MO'),
  row(4, 'Workton', 38.30, -90.40, 'US', 'MO'),
  row(5, 'Lyon', 45.75, 4.85, 'FR', '84'),
].join('\n') + '\n');
fs.writeFileSync(path.join(geo, 'admin1CodesASCII.txt'), 'FR.84\tAuvergne-Rhone-Alpes\tAuvergne-Rhone-Alpes\t11071619\n');

const port = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.js'], {
  env: { ...process.env, PORT: String(port), ODC_DATA_DIR: dir, ODC_TRIP_INTERVAL_MS: '300', ODC_GEONAMES_DIR: geo, TZ: 'UTC' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (n) => { passed++; console.log('  ✓', n); };

function client() {
  let cookie = '';
  return async (method, url, body, headers = {}) => {
    const h = { ...headers };
    if (cookie) h.Cookie = cookie;
    let payload = body;
    if (body !== undefined && !(body instanceof Uint8Array)) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(base + url, { method, headers: h, body: payload });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, data: ct.includes('json') ? await r.json() : null };
  };
}
const device = (token) => async (method, url, body, headers = {}) => {
  const h = { Authorization: `Bearer ${token}`, ...headers };
  let payload = body;
  if (body !== undefined && !(body instanceof Uint8Array)) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(base + url, { method, headers: h, body: payload });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: r.status !== 204 && ct.includes('json') ? await r.json() : null };
};
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

try {
  for (let i = 0; i < 50; i++) { try { await fetch(`${base}/api/setup`); break; } catch { await sleep(100); } }
  await sleep(300); // let the geocoder load
  assert.match(log, /Place names on: 5 places/); ok('GeoNames data loaded');

  const web = client();
  await web('POST', '/api/setup', { username: 'admin', password: 'correct horse' });
  const car = (await web('POST', '/api/cars', { name: 'CX5' })).data;
  const pair = async (label) => {
    const code = (await web('POST', `/api/cars/${car.id}/pairing`, { label })).data.code;
    const r = await fetch(`${base}/api/v1/devices/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    return r.json();
  };
  const front = await pair('Front');
  const rear = await pair('Rear');
  const phone = device(front.token);
  const phone2 = device(rear.token);

  // ---- clips from two cameras over the same time, with a GPS track
  const t0 = Date.parse('2026-10-01T08:00:00Z');
  const upload = async (ph, name, startedAt, seconds) => {
    const f = path.join(dir, name);
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc=size=320x180:rate=15:duration=${seconds}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-metadata', `comment=${name}`, f]);
    const b = fs.readFileSync(f);
    const up = (await ph('POST', '/api/v1/uploads', { fileName: name, sizeBytes: b.length, sha256: sha(b), startedAt, stream: name.includes('rear') ? 'rear' : 'front' })).data;
    await ph('PATCH', `/api/v1/uploads/${up.id}`, b, { 'Upload-Offset': '0' });
    assert.equal((await ph('POST', `/api/v1/uploads/${up.id}/complete`)).status, 200);
    return up.id;
  };
  const gpx = (start, n, lat0, dLat, gapAt = -1, gapMs = 0) => {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const t = start + i * 10_000 + (gapAt >= 0 && i >= gapAt ? gapMs : 0);
      pts.push(`<trkpt lat="${(lat0 + i * dLat).toFixed(7)}" lon="-90.0000000"><time>${new Date(t).toISOString()}</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:speed>12.0</gpxtpx:speed></gpxtpx:TrackPointExtension></extensions></trkpt>`);
    }
    return new TextEncoder().encode(`<gpx><trk><trkseg>${pts.join('')}</trkseg></trk></gpx>`);
  };
  const f1 = await upload(phone, 'ODC_20261001_080000_front.mp4', t0, 3);
  const f2 = await upload(phone, 'ODC_20261001_080300_front.mp4', t0 + 180_000, 3);
  const r1 = await upload(phone2, 'ODC_20261001_080001_rear.mp4', t0 + 1000, 3);
  // 61 points over 10 minutes from Testville toward Endburg
  await phone('POST', `/api/v1/clips/${f1}/sidecar?kind=gpx`, gpx(t0, 61, 40.0, 0.0006));
  await sleep(1200);

  // ---- place names
  let r = await web('GET', `/api/clips/${f1}`);
  assert.equal(r.data.place, 'Testville, IL'); ok('clip gets a place name');
  r = await web('GET', '/api/trips');
  assert.equal(r.data.length, 1);
  let trip = r.data[0];
  assert.equal(trip.startPlace, 'Testville, IL'); assert.equal(trip.endPlace, 'Endburg, IL');
  assert.equal(trip.displayName, 'Testville, IL → Endburg, IL'); ok('trip named "Testville, IL → Endburg, IL"');

  // ---- synced playback data
  r = await web('GET', `/api/cars/${car.id}/sync?from=${t0}&to=${t0 + 600_000}`);
  assert.equal(r.data.cameras.length, 2); assert.equal(r.data.clips.length, 3); assert.ok(r.data.route.length > 50);
  assert.ok(r.data.clips.some((c) => c.id === r1) && r.data.clips.some((c) => c.id === f2)); ok('sync view returns both cameras, all overlapping clips and the route');
  r = await web('GET', `/api/cars/${car.id}/sync?from=${t0 + 181_000}&to=${t0 + 182_000}`);
  assert.deepEqual(r.data.clips.map((c) => c.id).sort(), [f2].sort()); ok('sync view excludes clips that ended before the range');

  // ---- split, survives rebuild, merge
  const mid = t0 + 300_000;
  r = await web('POST', `/api/trips/${trip.id}/split`, { t: mid });
  assert.equal(r.status, 200); assert.equal(r.data.length, 2); ok('split a trip in two');
  const [a, b] = r.data;
  assert.ok(a.endT < mid && b.startT >= mid); ok('split at the chosen time');
  await phone('POST', `/api/v1/clips/${f2}/sidecar?kind=gpx`, gpx(t0 + 600_000, 3, 40.036, 0.0001)); // new points trigger a rebuild
  await sleep(1000);
  r = await web('GET', '/api/trips');
  assert.equal(r.data.length, 2); ok('manual split is kept when trips are rebuilt');
  r = await web('POST', `/api/trips/${r.data.find((t) => t.startT === a.startT).id}/merge`, { with: 'next' });
  assert.equal(r.data.length, 1); ok('merged back into one trip');
  // Merge across a real time gap
  await phone('POST', `/api/v1/clips/${f1}/sidecar?kind=gpx`, gpx(t0, 61, 40.0, 0.0006, 30, 20 * 60_000));
  await sleep(1000);
  r = await web('GET', '/api/trips');
  const gapTrips = r.data.filter((t) => t.startT >= t0 - 1000).sort((x, y) => x.startT - y.startT);
  assert.ok(gapTrips.length >= 1);
  r = await web('POST', `/api/trips/1/split`, { t: 0 });
  assert.equal(r.status, 404); ok('editing a trip that no longer exists is rejected cleanly');
  r = await web('POST', `/api/trips/${gapTrips[0].id}/merge`, { with: 'prev' });
  assert.equal(r.status, 400); ok('merge with a non-existent earlier trip is rejected');

  // ---- two-factor sign-in
  r = await web('POST', '/api/me/totp/setup');
  const secret = r.data.secret;
  assert.match(r.data.otpauth, /^otpauth:\/\/totp\/.+secret=/); ok('2FA setup returns an otpauth link');
  r = await web('POST', '/api/me/totp/enable', { code: '000000' });
  assert.equal(r.status, 400); ok('wrong code does not enable 2FA');
  r = await web('POST', '/api/me/totp/enable', { code: totpAt(secret, Date.now()) });
  assert.equal(r.data.recoveryCodes.length, 8); const codes = r.data.recoveryCodes; ok('2FA enabled with 8 recovery codes');
  const fresh = client();
  r = await fresh('POST', '/api/login', { username: 'admin', password: 'correct horse' });
  assert.equal(r.status, 401); assert.equal(r.data.totpRequired, true); ok('password alone is no longer enough');
  r = await fresh('POST', '/api/login', { username: 'admin', password: 'correct horse', code: '123456' });
  assert.equal(r.status, 401); ok('wrong 2FA code rejected');
  r = await fresh('POST', '/api/login', { username: 'admin', password: 'correct horse', code: totpAt(secret, Date.now()) });
  assert.equal(r.status, 200); ok('sign in with authenticator code');
  const f3 = client();
  r = await f3('POST', '/api/login', { username: 'admin', password: 'correct horse', code: codes[0].toUpperCase() });
  assert.equal(r.status, 200); ok('recovery code works');
  r = await client()('POST', '/api/login', { username: 'admin', password: 'correct horse', code: codes[0] });
  assert.equal(r.status, 401); ok('recovery code works only once');
  r = await web('POST', '/api/me/totp/disable', { password: 'correct horse' });
  r = await client()('POST', '/api/login', { username: 'admin', password: 'correct horse' });
  assert.equal(r.status, 200); ok('2FA can be turned off');

  // ---- commute learning: 4 weekdays of Home (Homeford) -> Work (Workton) at 8:00, back at 17:00
  const drive = async (start, fromLat, toLat, stopAtMid = 0) => {
    for (let i = 0; i <= 20; i++) {
      const t = start + i * 30_000 + (i > 10 ? stopAtMid : 0);
      await phone('POST', '/api/v1/live', { t, lat: fromLat + (toLat - fromLat) * (i / 20), lon: -90.40, speed: 15 });
    }
  };
  const monday = Date.parse('2026-09-21T00:00:00Z');
  for (let d = 0; d < 4; d++) {
    await drive(monday + d * 86400_000 + 8 * 3600_000, 38.20, 38.30);
    await drive(monday + d * 86400_000 + 17 * 3600_000, 38.30, 38.20);
  }
  // Friday: a 10-minute coffee stop halfway
  const friday = monday + 4 * 86400_000 + 8 * 3600_000;
  await drive(friday, 38.20, 38.30, 10 * 60_000);
  await sleep(1200);
  r = await web('GET', '/api/trips?limit=500');
  const fridayTrips = r.data.filter((t) => t.startT >= friday && t.startT < friday + 3600_000);
  assert.equal(fridayTrips.length, 2); ok('without learning, the coffee stop splits the commute in two');
  assert.equal(r.data.find((t) => t.startT === monday + 8 * 3600_000).displayName, 'Homeford, MO → Workton, MO'); ok('commute named by place before learning');

  await web('PUT', '/api/settings', { commuteLearning: true });
  r = await web('GET', `/api/cars/${car.id}/places`);
  const home = r.data.find((p) => p.kind === 'home');
  const work = r.data.find((p) => p.kind === 'work');
  assert.ok(home && Math.abs(home.lat - 38.20) < 0.01); assert.ok(work && Math.abs(work.lat - 38.30) < 0.01); ok('learned Home and Work');
  r = await web('GET', '/api/trips?limit=500');
  assert.equal(r.data.find((t) => t.startT === monday + 8 * 3600_000).displayName, 'Home → Work');
  assert.equal(r.data.find((t) => t.startT === monday + 17 * 3600_000).displayName, 'Work → Home'); ok('trips named "Home → Work" and "Work → Home"');
  const fridayAfter = r.data.filter((t) => t.startT >= friday && t.startT < friday + 3600_000);
  assert.equal(fridayAfter.length, 1); assert.equal(fridayAfter[0].displayName, 'Home → Work'); ok('with learning, the coffee stop no longer splits the commute');
  await web('PATCH', `/api/places/${work.id}`, { label: 'Office' });
  r = await web('GET', '/api/trips?limit=500');
  assert.equal(r.data.find((t) => t.startT === monday + 8 * 3600_000).displayName, 'Home → Office'); ok('renamed place applies to trips');
  await web('PUT', '/api/settings', { commuteLearning: false });
  r = await web('GET', '/api/trips?limit=500');
  assert.equal(r.data.filter((t) => t.startT >= friday && t.startT < friday + 3600_000).length, 2); ok('turning learning off restores normal trip splitting');

  console.log(`\nAll ${passed} checks passed.`);
} catch (e) {
  console.error('\nFAILED:', e);
  console.error('--- server log ---\n' + log);
  process.exitCode = 1;
} finally {
  server.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
