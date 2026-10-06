// 1.7: weekly summary; a dashcam's live stream in live view.
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-test-17-'));
const port = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (n) => { passed++; console.log('  ✓', n); };

// A "dashcam" stream (an HTTP video stands in for RTSP; ffmpeg reads both the same way)
const streamFile = path.join(dir, 'stream.mp4');
// (index at the start of the file, as with streamed video, so it can be read straight through like a live stream)
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=15', '-t', '20', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', streamFile]);
let streamRequests = 0;
const cam = http.createServer((req, res) => {
  streamRequests++;
  const data = fs.readFileSync(streamFile);
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': data.length });
  res.end(data);
});
await new Promise((r) => cam.listen(0, '127.0.0.1', r));
const pushes = [];
const pushServer = http.createServer((req, res) => { req.resume(); req.on('end', () => { pushes.push(req.url); res.writeHead(201); res.end(); }); });
await new Promise((r) => pushServer.listen(0, '127.0.0.1', r));

let log = '';
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.js'], {
  env: { ...process.env, PORT: String(port), ODC_HTTPS_PORT: String(port + 1500), ODC_DATA_DIR: dir, ODC_TRIP_INTERVAL_MS: '300', ODC_VIOFO_INTERVAL_MS: '3600000', ODC_LIVE_IDLE_MS: '3000' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));
function client() {
  let cookie = '';
  const c = async (method, url, body) => {
    const h = cookie ? { Cookie: cookie } : {};
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const r = await fetch(base + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: r.status, data: (r.headers.get('content-type') || '').includes('json') ? await r.json() : null };
  };
  c.cookie = () => cookie;
  return c;
}

try {
  for (let i = 0; i < 50; i++) { try { await fetch(`${base}/api/setup`); break; } catch { await sleep(100); } }
  const web = client();
  await web('POST', '/api/setup', { username: 'admin', password: 'correct horse' });
  await web('PUT', '/api/settings', { units: 'mph' });
  const car = (await web('POST', '/api/cars', { name: 'CX5' })).data;

  // ================= dashcam live stream
  await web('PATCH', `/api/cars/${car.id}`, { viofoUrl: `127.0.0.1:${cam.address().port}`, viofoStream: `http://127.0.0.1:${cam.address().port}/live.mp4` });
  let r = await web('GET', '/api/live-view-ready');
  assert.equal(r.data[car.id], 'dashcam'); ok('a car with a dashcam offers live view');
  assert.equal((await web('PATCH', `/api/cars/${car.id}`, { viofoStream: 'ftp://nope' })).status, 400); ok('stream address must be rtsp:// (or http)');
  r = await web('POST', `/api/cars/${car.id}/live-view`, { fps: 2 });
  assert.equal(r.status, 201); assert.equal(r.data.phones, 0); assert.equal(r.data.dashcam, true); ok('live view starts with no phone in the car');
  const sid = r.data.session;
  let st;
  for (let i = 0; i < 40; i++) { st = (await web('GET', `/api/live-view/${sid}`)).data; if (st.streams.length) break; await sleep(250); }
  assert.equal(st.streams[0].label, 'Viofo dashcam'); ok('the dashcam’s stream appears as “Viofo dashcam”');
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/live-view/${sid}/stream?key=${encodeURIComponent(st.streams[0].key)}`, { headers: { Cookie: web.cookie() }, signal: ctrl.signal });
  let buf = Buffer.alloc(0);
  const jpegs = [];
  const reader = (async () => { try { for await (const c of res.body) { buf = Buffer.concat([buf, c]); let i; while ((i = buf.indexOf('\r\n\r\n')) >= 0) { const len = Number(/Content-Length: (\d+)/.exec(buf.subarray(0, i))?.[1]); if (buf.length < i + 4 + len + 2) break; jpegs.push(buf.subarray(i + 4, i + 4 + len)); buf = buf.subarray(i + 4 + len + 2); } } } catch { /* stopped */ } })();
  await sleep(3000);
  assert.ok(jpegs.length >= 3, `frames ${jpegs.length}`); assert.ok(jpegs.every((j) => j[0] === 0xff && j[1] === 0xd8 && j.at(-1) === 0xd9));
  const dims = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'json', '-'], { input: jpegs[0] })).streams[0];
  ok(`viewers receive complete pictures from the dashcam (${jpegs.length} in 3 s at 2/s, ${dims.width}×${dims.height})`);
  ctrl.abort(); await reader;
  await web('DELETE', `/api/live-view/${sid}`);
  const n = streamRequests;
  await sleep(6500);
  assert.equal(streamRequests, n); ok('stopping live view closes the dashcam stream (no reconnecting)');

  await web('PATCH', `/api/cars/${car.id}`, { viofoStream: 'http://127.0.0.1:9/nothing.mp4' });
  r = await web('POST', `/api/cars/${car.id}/live-view`, {});
  for (let i = 0; i < 40; i++) { st = (await web('GET', `/api/live-view/${r.data.session}`)).data; if (st.dashcamError) break; await sleep(250); }
  assert.ok(st.dashcamError); ok(`an unreachable dashcam stream reports why (“${st.dashcamError.slice(0, 60)}”)`);
  await web('DELETE', `/api/live-view/${r.data.session}`);

  // ================= weekly summary
  const code = (await web('POST', `/api/cars/${car.id}/pairing`, { label: 'Front' })).data.code;
  const token = (await (await fetch(`${base}/api/v1/devices/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json()).token;
  const auth = { Authorization: `Bearer ${token}` };
  const start = Date.now() - 2 * 86400_000;
  const f = path.join(dir, 'c.mp4');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=5', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f]);
  const b = fs.readFileSync(f);
  const up = await (await fetch(`${base}/api/v1/uploads`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ fileName: 'ODC_c.mp4', sizeBytes: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex'), startedAt: start }) })).json();
  await fetch(`${base}/api/v1/uploads/${up.id}`, { method: 'PATCH', headers: { ...auth, 'Upload-Offset': '0' }, body: b });
  await fetch(`${base}/api/v1/uploads/${up.id}/complete`, { method: 'POST', headers: auth });
  const pts = Array.from({ length: 600 }, (_, i) => `<trkpt lat="${(38.5 + i * 0.0003).toFixed(6)}" lon="-90.3"><time>${new Date(start + i * 1000).toISOString()}</time></trkpt>`).join('');
  await fetch(`${base}/api/v1/clips/${up.id}/sidecar?kind=gpx`, { method: 'POST', headers: auth, body: `<gpx><trk><trkseg>${pts}</trkseg></trk></gpx>` });
  await fetch(`${base}/api/v1/events`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'impact', message: '2 g' }) });
  await sleep(1500);
  r = await web('GET', '/api/me/summary');
  assert.match(r.data.message, /^CX5: 1 trip, \d+ mi, 10 min driving · 1 impact · 1 clip \(1 MB\)$/); ok(`summary: “${r.data.message.split('\n')[0]}”`);

  await web('POST', '/api/push/subscribe', { endpoint: `http://127.0.0.1:${pushServer.address().port}/p/1`, keys: { p256dh: crypto.createECDH('prime256v1').generateKeys().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } });
  r = await web('PUT', '/api/me/prefs', { weeklySummary: true, summaryDay: 1, summaryHour: 9 });
  assert.deepEqual([r.data.weeklySummary, r.data.summaryDay, r.data.summaryHour], [true, 1, 9]); ok('weekly summary turned on for Monday 9:00');
  await web('GET', '/api/me/summary?send=1');
  await sleep(400);
  assert.equal(pushes.length, 1); ok('“send a preview now” delivers it');

  // Scheduling, run against the server's database: once at the chosen hour, only for people who turned it on.
  const { openDb } = await import('../src/db.js');
  const { maybeSendSummaries } = await import('../src/summary.js');
  const db = openDb(path.join(dir, 'odc.db'));
  await web('POST', '/api/users', { username: 'sam', password: 'password123' });
  const monday9 = new Date(2026, 9, 5, 9, 15);  // Monday, October 5, 2026, 9:15
  assert.equal(maybeSendSummaries(db, new Date(2026, 9, 5, 8, 15)), 0); ok('not sent before the chosen hour');
  assert.equal(maybeSendSummaries(db, monday9), 1); ok('sent at the chosen day and hour, only to people who turned it on');
  assert.equal(maybeSendSummaries(db, new Date(2026, 9, 5, 9, 45)), 0); ok('sent only once that week');
  console.log(`\nAll ${passed} checks passed.`);
} catch (e) {
  console.error('\nFAILED:', e);
  console.error('--- log ---\n' + log.slice(-3000));
  process.exitCode = 1;
} finally {
  server.kill();
  cam.close();
  pushServer.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
