// 1.8: Command Center sign-in from the app, the notification inbox and direct connection, alert choices,
// push to the app (with what it needs to open the clip), and finding the clip for an alert.
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-test-18-'));
const port = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (n) => { passed++; console.log('  ✓', n); };

// A push service receiving the app's notifications (decrypts like the app does: RFC 8291)
const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
const uaAuth = crypto.randomBytes(16);
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const pushes = [];
const pushServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const salt = body.subarray(0, 16); const idlen = body[20]; const asPub = body.subarray(21, 21 + idlen); const ct = body.subarray(21 + idlen);
    const prk = hmac(salt, hmac(hmac(uaAuth, ua.computeSecret(asPub)), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub, Buffer.from([1])])));
    const d = crypto.createDecipheriv('aes-128-gcm', hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16),
      hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12));
    d.setAuthTag(ct.subarray(ct.length - 16));
    const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
    pushes.push(JSON.parse(plain.subarray(0, plain.length - 1)));
    res.writeHead(201); res.end();
  });
});
await new Promise((r) => pushServer.listen(0, '127.0.0.1', r));

let log = '';
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.js'], {
  env: { ...process.env, PORT: String(port), ODC_HTTPS_PORT: String(port + 1500), ODC_DATA_DIR: dir, ODC_NOTIFY_WAIT_MS: '1500' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));
function web() {
  let cookie = '';
  return async (method, url, body) => {
    const h = cookie ? { Cookie: cookie } : {};
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const r = await fetch(base + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: r.status, data: (r.headers.get('content-type') || '').includes('json') ? await r.json() : null };
  };
}
const appClient = (token) => async (method, url, body) => {
  const h = { Authorization: `Bearer ${token}` };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(base + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, data: (r.headers.get('content-type') || '').includes('json') ? await r.json() : null };
};
const post = (url, body, headers = {}) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

try {
  for (let i = 0; i < 50; i++) { try { await fetch(`${base}/api/setup`); break; } catch { await sleep(100); } }
  const admin = web();
  await admin('POST', '/api/setup', { username: 'admin', password: 'correct horse' });
  const car = (await admin('POST', '/api/cars', { name: 'CX5' })).data;
  const code = (await admin('POST', `/api/cars/${car.id}/pairing`, { label: 'Front' })).data.code;
  const camToken = (await (await post('/api/v1/devices/pair', { code })).json()).token;
  const phone = { Authorization: `Bearer ${camToken}` };

  // ================= signing in from the app
  let r = await (await post('/api/login', { username: 'admin', password: 'correct horse', app: true, deviceName: 'Pixel 8' })).json();
  assert.ok(r.token); assert.equal(r.user.username, 'admin'); ok('the app signs in and gets its own key');
  const cc = appClient(r.token);
  assert.equal((await cc('GET', '/api/me')).status, 200); ok('the key works for the whole server API (Command Center)');
  const sessions = (await admin('GET', '/api/me/sessions')).data;
  const appSession = sessions.find((s) => s.userAgent === 'ODC app on Pixel 8');
  assert.ok(appSession); assert.ok(Date.now() + 300 * 86400_000 < appSession.createdAt + 365 * 86400_000 + 1000); ok('it shows as “ODC app on Pixel 8” in Signed-in devices');
  await admin('DELETE', `/api/me/sessions/${appSession.id}`);
  assert.equal((await cc('GET', '/api/me')).status, 401); ok('signing it out there locks the app out');

  // two-factor sign-in from the app
  const { totpAt } = await import('../src/totp.js');
  const totp = (secret) => totpAt(secret, Date.now());
  const setup = (await admin('POST', '/api/me/totp/setup')).data;
  await admin('POST', '/api/me/totp/enable', { code: totp(setup.secret) });
  let res = await post('/api/login', { username: 'admin', password: 'correct horse', app: true, deviceName: 'Pixel 8' });
  assert.equal(res.status, 401); assert.equal((await res.json()).totpRequired, true);
  r = await (await post('/api/login', { username: 'admin', password: 'correct horse', code: totp(setup.secret), app: true, deviceName: 'Pixel 8' })).json();
  assert.ok(r.token); ok('two-factor sign-in works from the app');
  const app = appClient(r.token);

  // ================= alerts: inbox, push to the app, direct connection
  await app('POST', '/api/push/subscribe', { endpoint: `http://127.0.0.1:${pushServer.address().port}/up/1`, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: uaAuth.toString('base64url') }, kind: 'app', label: 'Pixel 8' });
  // a clip that covers the impact
  const f = path.join(dir, 'c.mp4');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=5', '-t', '60', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f]);
  const b = fs.readFileSync(f);
  const clipStart = Date.now() - 30_000;
  const up = await (await post('/api/v1/uploads', { fileName: 'ODC_c.mp4', sizeBytes: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex'), startedAt: clipStart }, phone)).json();
  await fetch(`${base}/api/v1/uploads/${up.id}`, { method: 'PATCH', headers: { ...phone, 'Upload-Offset': '0' }, body: b });
  await fetch(`${base}/api/v1/uploads/${up.id}/complete`, { method: 'POST', headers: phone });
  await sleep(1500);

  const before = (await app('GET', '/api/me/notifications')).data.notifications.at(-1)?.id || 0;
  const waiting = app('GET', `/api/me/notifications/wait?after=${before}`);
  await sleep(200);
  const t0 = Date.now();
  const jpg = path.join(dir, 's.jpg');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180', '-frames:v', '1', jpg]);
  await fetch(`${base}/api/v1/events/snapshot?type=impact&message=2.4%20g%20jolt&t=${Date.now() - 1000}`, { method: 'POST', headers: { ...phone, 'Content-Type': 'image/jpeg' }, body: fs.readFileSync(jpg) });
  r = await waiting;
  const n = r.data.notifications[0];
  assert.equal(n.kind, 'impact'); assert.ok(Date.now() - t0 < 1000); ok(`the app’s direct connection gets the impact right away (${Date.now() - t0} ms)`);
  assert.ok(n.eventId && n.imageUrl); assert.equal(n.carId, car.id);
  const img2 = await app('GET', n.imageUrl.replace(/^https?:\/\/[^/]+/, ''));
  assert.equal(img2.status, 200); ok('it carries the impact photo (loaded with the app’s sign-in)');
  await sleep(300);
  const push = pushes.find((p) => p.kind === 'impact');
  assert.ok(push); assert.equal(push.eventId, n.eventId); assert.equal(push.id, n.id); assert.ok(push.image?.includes('st='));
  ok('the app’s push copy has the alert, its photo link and what’s needed to open the clip');
  r = await app('GET', `/api/me/notifications/wait?after=${n.id}`);
  assert.deepEqual(r.data.notifications, []); ok('with nothing new, the direct connection answers empty after a while');

  // from the alert to the clip
  r = await app('GET', `/api/events/${n.eventId}/clip`);
  assert.equal(r.data.clips.length, 1);
  const c = r.data.clips[0];
  assert.equal(c.clipId, up.id); assert.ok(c.offsetMs > 25_000 && c.offsetMs < 32_000, `offset ${c.offsetMs}`); ok(`the alert leads to its clip, ${Math.round(c.offsetMs / 1000)} s in`);
  const stream = await fetch(c.streamUrl.replace(/^https?:\/\/[^/]+/, base), { headers: { Range: 'bytes=0-99' } });
  assert.equal(stream.status, 206); ok('the clip’s stream link plays (as the app’s video player needs)');

  // alert choices
  await app('PUT', '/api/me/prefs', { alerts: { speeding: false } });
  await post('/api/v1/events', { type: 'overheating', message: 'hot' }, phone);
  await sleep(300);
  const kinds = (await app('GET', '/api/me/notifications')).data.notifications.map((x) => x.kind);
  assert.ok(kinds.includes('overheating')); ok('alerts arrive for the kinds you want…');
  await admin('PATCH', `/api/cars/${car.id}`, { speedAlertKmh: 50 });
  for (let i = 0; i < 4; i++) await post('/api/v1/live', { lat: 38.6, lon: -90.2, speed: 25, t: Date.now() - 20_000 + i * 5000 }, phone);
  await sleep(500);
  const ev = (await admin('GET', '/api/events')).data;
  assert.ok(ev.some((e) => e.type === 'speeding'));
  assert.ok(!(await app('GET', '/api/me/notifications')).data.notifications.some((x) => x.kind === 'speeding')); ok('…and not for kinds you turned off (the event is still recorded)');

  // read state
  r = await app('GET', '/api/me/notifications');
  assert.ok(r.data.unread >= 2);
  await app('POST', '/api/me/notifications/read', { all: true });
  assert.equal((await app('GET', '/api/me/notifications')).data.unread, 0); ok('notifications can be marked read');
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
