// 1.5: live view on demand, and the plates found in one clip.
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-test-15-'));
const port = 18000 + Math.floor(Math.random() * 1000);
const mlPort = port + 1000;
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (n) => { passed++; console.log('  ✓', n); };
let log = '';
const ml = spawn('python3', ['ml/app.py'], { env: { ...process.env, ODC_ML_FAKE: '1', PORT: String(mlPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.js'], {
  env: { ...process.env, PORT: String(port), ODC_HTTPS_PORT: String(port + 1500), ODC_DATA_DIR: dir, ODC_ML_URL: `http://127.0.0.1:${mlPort}`,
    ODC_LIVE_IDLE_MS: '1500', ODC_LIVE_WAIT_MS: '1500', ODC_INDEX_INTERVAL_MS: '600000' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));
const pushes = [];
const pushServer = http.createServer((req, res) => { req.resume(); req.on('end', () => { pushes.push(req.url); res.writeHead(201); res.end(); }); });
await new Promise((r) => pushServer.listen(0, '127.0.0.1', r));

function client() {
  let cookie = '';
  const c = async (method, url, body) => {
    const h = cookie ? { Cookie: cookie } : {};
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const r = await fetch(base + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: r.status, data: (r.headers.get('content-type') || '').includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  c.cookie = () => cookie;
  return c;
}
const jpeg = (color) => {
  const f = path.join(dir, `${color}.jpg`);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=${color}:s=320x180`, '-frames:v', '1', f]);
  return fs.readFileSync(f);
};

// Reads an MJPEG stream and collects the JPEG parts.
function watch(url, cookie) {
  const parts = [];
  let ended = false;
  const ctrl = new AbortController();
  (async () => {
    try {
      const r = await fetch(url, { headers: { Cookie: cookie }, signal: ctrl.signal });
      assert.match(r.headers.get('content-type'), /multipart\/x-mixed-replace; boundary=odcframe/);
      let buf = Buffer.alloc(0);
      for await (const chunk of r.body) {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          const h = buf.indexOf('\r\n\r\n');
          if (h < 0) break;
          const len = Number(/Content-Length: (\d+)/.exec(buf.subarray(0, h).toString())?.[1]);
          if (!len || buf.length < h + 4 + len + 2) break;
          parts.push(buf.subarray(h + 4, h + 4 + len));
          buf = buf.subarray(h + 4 + len + 2);
        }
      }
    } catch { /* aborted */ }
    ended = true;
  })();
  return { parts, stop: () => ctrl.abort(), ended: () => ended };
}

try {
  for (let i = 0; i < 80; i++) { try { await fetch(`${base}/api/setup`); await fetch(`http://127.0.0.1:${mlPort}/health`); break; } catch { await sleep(100); } }
  const owner = client();
  await owner('POST', '/api/setup', { username: 'admin', password: 'correct horse' });
  await owner('POST', '/api/push/subscribe', { endpoint: `http://127.0.0.1:${pushServer.address().port}/p/owner`, keys: { p256dh: crypto.createECDH('prime256v1').generateKeys().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } });
  const car = (await owner('POST', '/api/cars', { name: 'CX5' })).data;
  const code = (await owner('POST', `/api/cars/${car.id}/pairing`, { label: 'Phone' })).data.code;
  const token = (await (await fetch(`${base}/api/v1/devices/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json()).token;
  const auth = { Authorization: `Bearer ${token}` };

  // ================= live view
  let r = await owner('POST', `/api/cars/${car.id}/live-view`, {});
  assert.equal(r.status, 409); assert.match(r.data.error, /recording/); ok('clear message when no phone is ready');

  let w = await fetch(`${base}/api/v1/live-view/wait`, { headers: auth });
  assert.equal(w.status, 204); ok('the phone’s wait times out quietly when nobody is watching');

  const waiting = fetch(`${base}/api/v1/live-view/wait`, { headers: auth });
  await sleep(200);
  r = await owner('GET', '/api/live-view-ready');
  assert.equal(r.data[car.id], 1); ok('the server knows a phone is ready');
  const t0 = Date.now();
  r = await owner('POST', `/api/cars/${car.id}/live-view`, { fps: 2 });
  assert.equal(r.status, 201); assert.equal(r.data.phones, 1);
  const sid = r.data.session;
  w = await waiting;
  const offer = await w.json();
  assert.equal(offer.session, sid); assert.equal(offer.fps, 2); assert.ok(Date.now() - t0 < 1000); ok(`starting a live view wakes the phone right away (${Date.now() - t0} ms)`);

  const viewRear = watch(`${base}/api/live-view/${sid}/stream?key=${encodeURIComponent('PLACEHOLDER')}`, owner.cookie());
  viewRear.stop();
  const send = (stream, label, body) => fetch(`${base}/api/v1/live-view/${sid}/frame?stream=${stream}&label=${label}`, { method: 'POST', headers: { ...auth, 'Content-Type': 'image/jpeg' }, body });
  const red = jpeg('red');
  const blue = jpeg('blue');
  let fr = await (await send('rear', 'Road', red)).json();
  assert.equal(fr.continue, true);
  await send('front', 'Cabin', blue);
  r = await owner('GET', `/api/live-view/${sid}`);
  assert.deepEqual(r.data.streams.map((s) => s.label).sort(), ['Phone · Cabin', 'Phone · Road']); ok('two cameras on the phone appear as two streams');
  const rearKey = r.data.streams.find((s) => s.label.endsWith('Road')).key;
  const v = watch(`${base}/api/live-view/${sid}/stream?key=${encodeURIComponent(rearKey)}`, owner.cookie());
  await sleep(300);
  await send('rear', 'Road', red);
  await send('front', 'Cabin', blue);
  await send('rear', 'Road', red);
  await sleep(500);
  assert.ok(v.parts.length >= 2, `parts ${v.parts.length}`); assert.ok(v.parts.every((p) => p.equals(red))); ok(`viewer receives the road camera’s frames as MJPEG (${v.parts.length} frames, only that camera)`);
  assert.equal((await fetch(`${base}/api/v1/live-view/${sid}/frame?stream=rear`, { method: 'POST', headers: auth, body: Buffer.from('not an image'.repeat(20)) })).status, 400); ok('non-JPEG frames are rejected');

  const before = (await owner('GET', `/api/live-view/${sid}`)).data.expiresAt;
  await sleep(50);
  r = await owner('POST', `/api/live-view/${sid}/extend`);
  assert.ok(r.data.expiresAt > before); ok('a session can be extended');

  await owner('DELETE', `/api/live-view/${sid}`);
  await sleep(300);
  assert.ok(v.ended()); fr = await (await send('rear', 'Road', red)).json();
  assert.equal(fr.continue, false); ok('stopping ends the stream and tells the phone to stop sending');

  // nobody watching -> session ends by itself
  let wait2 = fetch(`${base}/api/v1/live-view/wait`, { headers: auth });
  await sleep(200);
  const s2 = (await owner('POST', `/api/cars/${car.id}/live-view`, {})).data.session;
  await wait2;
  await sleep(4000);
  fr = await (await fetch(`${base}/api/v1/live-view/${s2}/frame?stream=rear`, { method: 'POST', headers: { ...auth, 'Content-Type': 'image/jpeg' }, body: red })).json();
  assert.equal(fr.continue, false); ok('a session nobody is watching ends by itself');

  // permissions and notifying the owner
  await owner('POST', '/api/users', { username: 'sam', password: 'password123' });
  await owner('POST', '/api/users', { username: 'kim', password: 'password123' });
  await owner('POST', `/api/cars/${car.id}/shares`, { username: 'sam', role: 'viewer' });
  await owner('POST', `/api/cars/${car.id}/shares`, { username: 'kim', role: 'manager' });
  const sam = client(); await sam('POST', '/api/login', { username: 'sam', password: 'password123' });
  const kim = client(); await kim('POST', '/api/login', { username: 'kim', password: 'password123' });
  wait2 = fetch(`${base}/api/v1/live-view/wait`, { headers: auth });
  await sleep(200);
  r = await sam('POST', `/api/cars/${car.id}/live-view`, {});
  assert.equal(r.status, 403); ok('people with view-only access can’t start live view');
  const pushesBefore = pushes.length;
  r = await kim('POST', `/api/cars/${car.id}/live-view`, {});
  assert.equal(r.status, 201);
  await wait2;
  await sleep(500);
  assert.ok(pushes.length > pushesBefore); ok('the owner is notified when someone else starts a live view');
  assert.equal((await owner('GET', `/api/live-view/${r.data.session}`)).status, 404); ok('each person’s live view session is their own');
  r = await owner('GET', '/api/audit?action=live');
  assert.ok(r.data.some((e) => e.user === 'kim' && e.action === 'live view started')); ok('live views are in the activity log');

  // ================= plates in one clip
  await owner('PUT', '/api/settings', { plateSearch: true });
  const f = path.join(dir, 'red.mp4');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=320x180:r=10:d=8', '-f', 'lavfi', '-i', 'color=red:s=320x180:r=10:d=6',
    '-filter_complex', '[0][1]concat=n=2:v=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f]);
  const b = fs.readFileSync(f);
  const up = await (await fetch(`${base}/api/v1/uploads`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: 'ODC_red.mp4', sizeBytes: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex'), startedAt: Date.now() - 600_000 }) })).json();
  await fetch(`${base}/api/v1/uploads/${up.id}`, { method: 'PATCH', headers: { ...auth, 'Upload-Offset': '0' }, body: b });
  await fetch(`${base}/api/v1/uploads/${up.id}/complete`, { method: 'POST', headers: auth });
  await owner('POST', '/api/search/analyze', { smart: false, plates: true });
  let pl;
  for (let i = 0; i < 60; i++) { pl = (await owner('GET', `/api/clips/${up.id}/plates`)).data; if (pl.analyzed) break; await sleep(500); }
  assert.ok(pl.analyzed); assert.ok(pl.reads.length >= 1); assert.ok(pl.reads.every((x) => x.plate === 'RED123'));
  assert.ok(pl.reads[0].offsetMs >= 7000, `first read at ${pl.reads[0].offsetMs}`); ok(`the clip’s plates are listed with their moment (RED123 at ${pl.reads[0].offsetMs / 1000} s)`);
  r = await owner('GET', pl.reads[0].cropUrl);
  assert.equal(r.status, 200); assert.equal(r.data[0], 0xff); ok('crops work with plate reading on, even without the plate log');
  r = await sam('GET', `/api/clips/${up.id}/plates`);
  assert.equal(r.status, 200); ok('anyone who can see the clip can see its plates');
  r = await owner('GET', '/api/audit?action=clip plates');
  assert.ok(r.data.some((e) => e.action === 'clip plates viewed')); ok('viewing a clip’s plates is in the activity log');
  await owner('PUT', '/api/settings', { plateSearch: false });
  r = await owner('GET', `/api/clips/${up.id}/plates`);
  assert.equal(r.status, 403); ok('not available while plate reading is off');

  console.log(`\nAll ${passed} checks passed.`);
} catch (e) {
  console.error('\nFAILED:', e);
  console.error('--- log ---\n' + log.slice(-3000));
  process.exitCode = 1;
} finally {
  server.kill();
  ml.kill();
  pushServer.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
