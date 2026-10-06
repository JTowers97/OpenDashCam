// The date/time stamp area is skipped for license plates, per clip: the bottom-left corner on ODC phone clips with the
// stamp on (or unknown), nothing on phone clips without it, the bottom strip on Viofo dashcam clips.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-test-181-'));
const port = 18000 + Math.floor(Math.random() * 1000);
const mlPort = port + 1000;
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (n) => { passed++; console.log('  ✓', n); };
const fakeExif = path.join(dir, 'exiftool');
fs.writeFileSync(fakeExif, '#!/usr/bin/env node\nconsole.log(JSON.stringify([{}]));\n');
fs.chmodSync(fakeExif, 0o755);
let log = '';
const ml = spawn('python3', ['ml/app.py'], { env: { ...process.env, ODC_ML_FAKE: '1', PORT: String(mlPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.js'], {
  env: { ...process.env, PORT: String(port), ODC_HTTPS_PORT: String(port + 1500), ODC_DATA_DIR: dir, ODC_ML_URL: `http://127.0.0.1:${mlPort}`, ODC_INDEX_INTERVAL_MS: '600000', ODC_EXIFTOOL: fakeExif },
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
// 640x360 test videos: red "text" where a stamp would be, and optionally a red "plate" up in the road area.
const video = (name, stampBox, roadPlate) => {
  const f = path.join(dir, 'src', name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const boxes = [stampBox, ...(roadPlate ? ['drawbox=x=380:y=150:w=60:h=24:color=red@1:t=fill'] : [])];
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=gray:s=640x360:r=5,${boxes.join(',')}`, '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-metadata', `comment=${name}`, f]);
  return f;
};
const CORNER = 'drawbox=x=12:y=316:w=200:h=36:color=red@1:t=fill';      // ODC's stamp: bottom-left
const STRIP = 'drawbox=x=400:y=322:w=220:h=30:color=red@1:t=fill';      // a dashcam stamp across the bottom (right side)

try {
  for (let i = 0; i < 80; i++) { try { await fetch(`${base}/api/setup`); await fetch(`http://127.0.0.1:${mlPort}/health`); break; } catch { await sleep(100); } }
  const w = web();
  await w('POST', '/api/setup', { username: 'admin', password: 'correct horse' });
  assert.equal((await w('GET', '/api/settings')).data.plateIgnoreArea, undefined); ok('no setting: the area depends on where the footage came from');
  const car = (await w('POST', '/api/cars', { name: 'CX5' })).data;
  const code = (await w('POST', `/api/cars/${car.id}/pairing`, { label: 'Front' })).data.code;
  const token = (await (await fetch(`${base}/api/v1/devices/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json()).token;
  const auth = { Authorization: `Bearer ${token}` };
  const upload = async (file, t, extra) => {
    const b = fs.readFileSync(file);
    const up = await (await fetch(`${base}/api/v1/uploads`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: path.basename(file), sizeBytes: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex'), startedAt: t, ...extra }) })).json();
    await fetch(`${base}/api/v1/uploads/${up.id}`, { method: 'PATCH', headers: { ...auth, 'Upload-Offset': '0' }, body: b });
    await fetch(`${base}/api/v1/uploads/${up.id}/complete`, { method: 'POST', headers: auth });
    return up.id;
  };
  const now = Date.now();
  const stamped = await upload(video('ODC_stamped.mp4', CORNER, true), now - 900_000, { stamp: true });
  const plain = await upload(video('ODC_plain.mp4', CORNER, false), now - 800_000, { stamp: false });
  const older = await upload(video('ODC_older.mp4', CORNER, false), now - 700_000, {});
  // A Viofo memory card import: its stamp runs along the bottom
  fs.mkdirSync(path.join(dir, 'import', 'card', 'DCIM', 'Movie'), { recursive: true });
  fs.copyFileSync(video('2026_1005_100000_000001F.MP4', STRIP, true), path.join(dir, 'import', 'card', 'DCIM', 'Movie', '2026_1005_100000_000001F.MP4'));
  let r = await w('POST', `/api/cars/${car.id}/import`, { folder: 'card' });
  for (let i = 0; i < 40; i++) { const j = (await w('GET', `/api/jobs/${r.data.jobId}`)).data; if (j.status === 'done') break; await sleep(250); }
  const viofo = (await w('GET', `/api/clips?car=${car.id}&limit=50`)).data.clips.find((c) => c.fileName.endsWith('F.MP4')).id;

  await w('PUT', '/api/settings', { plateSearch: true });
  const reads = async (id) => { for (let i = 0; i < 120; i++) { const p = (await w('GET', `/api/clips/${id}/plates`)).data; if (p.analyzed) return p.reads; await sleep(250); } throw new Error('not analyzed'); };
  const boxes = async (id) => (await reads(id)).length;
  assert.equal(await boxes(stamped), 1); ok('ODC phone clip with the stamp on: the stamp is skipped, the road plate is read');
  assert.equal(await boxes(plain), 1); ok('ODC phone clip without a stamp: the bottom-left corner is read normally');
  assert.equal(await boxes(older), 0); ok('older uploads (stamp unknown): the corner is skipped to be safe');
  assert.equal(await boxes(viofo), 1); ok('Viofo clip: the stamp along the bottom is skipped, the road plate is read');
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
