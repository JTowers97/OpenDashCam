// Cameras: disconnecting vs deleting; Viofo lens choice; importing a dashcam memory card (folder and browser upload).
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-test-161-'));
const port = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (n) => { passed++; console.log('  ✓', n); };
const video = (name) => {
  const f = path.join(dir, 'src', name);
  if (!fs.existsSync(f)) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=5', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-metadata', `comment=${name}`, f]);
  }
  return f;
};
const fakeExif = path.join(dir, 'exiftool');
fs.writeFileSync(fakeExif, '#!/usr/bin/env node\nconsole.log(JSON.stringify([{ SourceFile: process.argv.at(-1) }]));\n');
fs.chmodSync(fakeExif, 0o755);

// A Viofo camera with front and rear recordings
const camFiles = ['2026_1005_181010_107360F.MP4', '2026_1005_181010_107360R.MP4', '2026_1005_181310_107362F.MP4', '2026_1005_181310_107362R.MP4',
  '2026_1005_181410_107364F.MP4', '2026_1005_181410_107364R.MP4'];
const camera = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://cam');
  if (u.searchParams.get('cmd') === '3015') {
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    return res.end(`<LIST>${camFiles.map((n) => `<ALLFile><File><NAME>${n}</NAME><FPATH>A:\\DCIM\\Movie\\${n}</FPATH><SIZE>${fs.statSync(video(n)).size}</SIZE><TIME>2026/10/05 18:10:10</TIME></File></ALLFile>`).join('')}</LIST>`);
  }
  const n = camFiles.find((x) => u.pathname === `/DCIM/Movie/${x}`);
  if (!n) { res.writeHead(404); return res.end(); }
  const data = fs.readFileSync(video(n));
  res.writeHead(200, { 'Content-Length': data.length });
  res.end(data);
});
await new Promise((r) => camera.listen(0, '127.0.0.1', r));

let log = '';
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.js'], {
  env: { ...process.env, PORT: String(port), ODC_HTTPS_PORT: String(port + 1500), ODC_DATA_DIR: dir, ODC_EXIFTOOL: fakeExif, ODC_VIOFO_INTERVAL_MS: '3600000' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));
function client() {
  let cookie = '';
  const c = async (method, url, body, headers = {}) => {
    const h = { ...(cookie ? { Cookie: cookie } : {}), ...headers };
    let payload = body;
    if (body !== undefined && !Buffer.isBuffer(body)) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(base + url, { method, headers: h, body: payload });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: r.status, data: (r.headers.get('content-type') || '').includes('json') ? await r.json() : null };
  };
  return c;
}
const waitFor = async (fn, ms = 20_000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await sleep(250); } };
const job = async (c, id) => waitFor(async () => { const j = (await c('GET', `/api/jobs/${id}`)).data; return j.status === 'done' || j.status === 'failed' ? j : null; });

try {
  for (let i = 0; i < 50; i++) { try { await fetch(`${base}/api/setup`); break; } catch { await sleep(100); } }
  const web = client();
  await web('POST', '/api/setup', { username: 'admin', password: 'correct horse' });
  const car = (await web('POST', '/api/cars', { name: 'A229' })).data;
  const carView = async () => (await web('GET', '/api/cars')).data.find((c) => c.id === car.id);

  // ================= disconnecting vs deleting a camera
  const code = (await web('POST', `/api/cars/${car.id}/pairing`, { label: 'Old phone' })).data.code;
  const token = (await (await fetch(`${base}/api/v1/devices/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json()).token;
  const b = fs.readFileSync(video('ODC_phone.mp4'));
  const up = await (await fetch(`${base}/api/v1/uploads`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: 'ODC_phone.mp4', sizeBytes: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex'), startedAt: Date.now() - 600_000 }) })).json();
  await fetch(`${base}/api/v1/uploads/${up.id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Upload-Offset': '0' }, body: b });
  await fetch(`${base}/api/v1/uploads/${up.id}/complete`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  let cam = (await carView()).cameras[0];
  await web('DELETE', `/api/cameras/${cam.id}`);
  cam = (await carView()).cameras[0];
  assert.ok(cam.disconnected); assert.equal(cam.clips, 1); assert.equal(cam.kind, 'phone'); ok('a disconnected phone stays listed, marked, with its footage count');
  await web('DELETE', `/api/clips/${up.id}`);
  assert.equal((await carView()).cameras.length, 0); ok('…and disappears once its footage is gone');

  const code2 = (await web('POST', `/api/cars/${car.id}/pairing`, { label: 'Phone 2' })).data.code;
  const token2 = (await (await fetch(`${base}/api/v1/devices/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code2 }) })).json()).token;
  const up2 = await (await fetch(`${base}/api/v1/uploads`, { method: 'POST', headers: { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: 'ODC_phone2.mp4', sizeBytes: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex'), startedAt: Date.now() - 500_000 }) })).json();
  await fetch(`${base}/api/v1/uploads/${up2.id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${token2}`, 'Upload-Offset': '0' }, body: b });
  await fetch(`${base}/api/v1/uploads/${up2.id}/complete`, { method: 'POST', headers: { Authorization: `Bearer ${token2}` } });
  await fetch(`${base}/api/v1/live`, { method: 'POST', headers: { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ lat: 38.6, lon: -90.2, speed: 5 }) });
  cam = (await carView()).cameras.find((c) => c.label === 'Phone 2');
  let r = await web('DELETE', `/api/cameras/${cam.id}?purge=1`);
  assert.equal(r.data.deletedClips, 1);
  assert.equal((await carView()).cameras.length, 0);
  assert.equal((await web('GET', `/api/clips?car=${car.id}`)).data.total, 0); ok('“Delete with footage” removes the camera and its clips');
  r = await web('GET', `/api/cars/${car.id}/route?from=${Date.now() - 3600_000}&to=${Date.now() + 1000}`);
  assert.ok(r.data.length >= 1); ok('…but keeps its GPS history for trips');

  // ================= Viofo: only the lenses you choose
  await web('PATCH', `/api/cars/${car.id}`, { viofoUrl: `127.0.0.1:${camera.address().port}`, viofoLenses: ['F'] });
  await web('POST', `/api/cars/${car.id}/viofo/check`);
  await waitFor(async () => /Imported|Up to date|newest/.test((await carView()).viofoStatus?.message || ''));
  let clips = (await web('GET', `/api/clips?car=${car.id}&limit=50`)).data.clips;
  assert.deepEqual(clips.map((c) => c.fileName).sort(), ['2026_1005_181010_107360F.MP4', '2026_1005_181310_107362F.MP4']); ok('Wi-Fi import takes only the chosen lens (front), newest held back');
  const dash = (await carView()).cameras.find((c) => c.label === 'Viofo Front');
  assert.equal(dash.kind, 'dashcam'); assert.equal(dash.clips, 2); ok('the dashcam’s lens shows as a dashcam camera with its footage');

  // ================= memory card: copied into data/import
  const card = path.join(dir, 'import', 'SD card');
  const put = (rel, src) => { fs.mkdirSync(path.dirname(path.join(card, rel)), { recursive: true }); fs.copyFileSync(src, path.join(card, rel)); };
  for (const n of camFiles) put(`DCIM/Movie/${n}`, video(n));          // includes the two already imported over Wi-Fi
  put('DCIM/Movie/RO/2026_1004_120000_107100F.MP4', video('ro.MP4'));
  put('DCIM/Movie/Parking/2026_1004_230000_107200R.MP4', video('park.MP4'));
  put('DCIM/Photo/2026_1004_120000_107100F.JPG', video('ro.MP4'));       // not a video: ignored
  put('misc/CLIP0001.MP4', video('nodate.MP4'));                         // no date in the name: uses the file's time
  r = await web('GET', '/api/import');
  const sd = r.data.folders.find((f) => f.folder === 'SD card');
  assert.equal(sd.files, 9); ok(`the import folder lists “SD card” with 9 videos (${sd.bytes} bytes)`);
  r = await web('POST', `/api/cars/${car.id}/import`, { folder: 'SD card' });
  let j = await job(web, r.data.jobId);
  assert.equal(j.status, 'done', j.error);
  assert.deepEqual([j.result.imported, j.result.skipped], [7, 2]); ok('memory card import: 7 new, 2 already imported over Wi-Fi skipped');
  clips = (await web('GET', `/api/clips?car=${car.id}&limit=50`)).data.clips;
  const byName = Object.fromEntries(clips.map((c) => [c.fileName, c]));
  assert.ok(byName['2026_1004_120000_107100F.MP4'].locked); assert.equal(byName['2026_1004_230000_107200R.MP4'].mode, 'parking'); ok('event recordings arrive locked, parking ones marked');
  assert.ok(byName['CLIP0001.MP4']); ok('a file without a date in its name uses the file’s time');
  assert.deepEqual((await carView()).cameras.map((c) => c.label).sort(), ['Viofo Front', 'Viofo Rear']); ok('one camera per lens, shared with Wi-Fi import');
  assert.ok(!fs.existsSync(path.join(card, 'DCIM/Movie', camFiles[0])) && !fs.existsSync(path.join(card, 'DCIM/Movie/RO/2026_1004_120000_107100F.MP4'))); ok('files are moved out of the import folder (instant)');
  assert.ok(fs.existsSync(path.join(card, 'DCIM/Photo/2026_1004_120000_107100F.JPG'))); ok('non-video files are left alone');

  // Wi-Fi import now has nothing to do (card already brought them in)
  await web('PATCH', `/api/cars/${car.id}`, { viofoLenses: ['F', 'R'] });
  const before = (await web('GET', `/api/clips?car=${car.id}&limit=50`)).data.total;
  await web('POST', `/api/cars/${car.id}/viofo/check`);
  await sleep(1500);
  assert.equal((await web('GET', `/api/clips?car=${car.id}&limit=50`)).data.total, before); ok('Wi-Fi import doesn’t download what the card already brought in');

  // keep files option + re-import skips
  put('again/DCIM/Movie/RO/2026_1004_120000_107100F.MP4', video('ro.MP4'));
  put('again/DCIM/Movie/2026_1003_090000_107000F.MP4', video('new.MP4'));
  r = await web('POST', `/api/cars/${car.id}/import`, { folder: 'SD card/again', keepFiles: true });
  j = await job(web, r.data.jobId);
  assert.deepEqual([j.result.imported, j.result.skipped], [1, 1]); assert.ok(fs.existsSync(path.join(card, 'again/DCIM/Movie/2026_1003_090000_107000F.MP4'))); ok('“keep the files” copies instead of moving; duplicates skipped');

  // ================= browser upload (in pieces), and who can import what
  await web('POST', '/api/users', { username: 'sam', password: 'password123' });
  await web('POST', `/api/cars/${car.id}/shares`, { username: 'sam', role: 'manager' });
  const sam = client();
  await sam('POST', '/api/login', { username: 'sam', password: 'password123' });
  const samId = (await sam('GET', '/api/me')).data.id;
  const batch = `upload-${samId}-20261005-190000`;
  const data = fs.readFileSync(video('2026_1002_080000_106900R.MP4'));
  r = await sam('POST', '/api/import/uploads', { batch, relPath: 'DCIM/Movie/2026_1002_080000_106900R.MP4', size: data.length });
  const uid = r.data.id;
  const half = Math.floor(data.length / 2);
  r = await sam('PATCH', `/api/import/uploads/${uid}`, data.subarray(0, half), { 'Upload-Offset': '0' });
  assert.equal(r.data.offset, half);
  r = await sam('PATCH', `/api/import/uploads/${uid}`, data.subarray(0, 10), { 'Upload-Offset': '0' });
  assert.equal(r.status, 409); assert.equal(r.data.offset, half); ok('uploads go in pieces and refuse out-of-order pieces');
  r = await sam('PATCH', `/api/import/uploads/${uid}`, data.subarray(half), { 'Upload-Offset': String(half) });
  assert.ok(r.data.done);
  assert.equal((await sam('POST', `/api/cars/${car.id}/import`, { folder: 'SD card' })).status, 403); ok('people who aren’t admins can’t import from the server’s folder');
  r = await sam('POST', `/api/cars/${car.id}/import`, { folder: batch });
  j = await job(sam, r.data.jobId);
  assert.equal(j.result.imported, 1); assert.ok(!fs.existsSync(path.join(dir, 'import', batch))); ok('…but can import their own upload (and it’s tidied up afterwards)');
  r = await sam('GET', '/api/import');
  assert.ok(r.data.folders.every((f) => f.folder.startsWith(`upload-${samId}-`))); ok('…and only see their own uploads');
  assert.equal((await sam('POST', '/api/import/uploads', { batch: `upload-1-20261005-190000`, relPath: 'x.MP4', size: 5 })).status, 400); ok('can’t upload into someone else’s batch');
  assert.equal((await sam('POST', '/api/import/uploads', { batch, relPath: '../../odc.db.MP4', size: 5 })).status, 201);
  assert.ok(!fs.existsSync(path.join(dir, 'odc.db.MP4.part'))); ok('upload paths can’t escape the import folder');

  r = await web('GET', '/api/audit?action=memory card');
  assert.ok(r.data.length >= 2); ok('memory card imports are in the activity log');
  console.log(`\nAll ${passed} checks passed.`);
} catch (e) {
  console.error('\nFAILED:', e);
  console.error('--- log ---\n' + log.slice(-3000));
  process.exitCode = 1;
} finally {
  server.kill();
  camera.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
