// 2.0.1: job lanes, blur jobs that can't wait forever, share links resumed after a restart, the safety net for
// unexpected errors, and the Background work overview.
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-test-201-'));
const port = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (n) => { passed++; console.log('  ✓', n); };

// A stand-in ML container: "stuck" (blur jobs never start), "ok" (they finish), "gone" (it restarted and forgot them)
let mode = 'stuck';
const mlJobs = new Map();
const ml = http.createServer((req, res) => {
  const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (req.url === '/health') return json(200, { ready: true, blur: true });
    if (req.url.startsWith('/can-read')) return json(200, { readable: true });
    if (req.url === '/status') return json(200, { busy: null, models: {}, blur: [...mlJobs.values()].map((j) => ({ id: j.id, status: 'queued', progress: 0, src: path.basename(j.input) })) });
    if (req.method === 'POST' && req.url === '/blur') { const b = JSON.parse(Buffer.concat(chunks)); mlJobs.set(b.id, b); return json(200, { ok: true }); }
    const m = /^\/blur\/(.+)$/.exec(req.url);
    if (m) {
      const j = mlJobs.get(m[1]);
      if (!j || mode === 'gone') return json(404, { error: 'unknown job' });
      if (mode === 'stuck') return json(200, { status: 'queued', progress: 0 });
      fs.copyFileSync(j.input, j.output);
      mlJobs.delete(m[1]);
      return json(200, { status: 'done', progress: 1 });
    }
    json(404, {});
  });
});
await new Promise((r) => ml.listen(0, '127.0.0.1', r));
// A slow ExifTool, so a memory card import takes a while
const slowExif = path.join(dir, 'exiftool');
fs.writeFileSync(slowExif, '#!/usr/bin/env node\nsetTimeout(() => console.log(JSON.stringify([{}])), 1500);\n');
fs.chmodSync(slowExif, 0o755);

let server;
let log = '';
const start = async () => {
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.js'], {
    env: { ...process.env, PORT: String(port), ODC_HTTPS_PORT: String(port + 1500), ODC_DATA_DIR: dir, ODC_ML_URL: `http://127.0.0.1:${ml.address().port}`,
      ODC_EXIFTOOL: slowExif, ODC_TEST_HOOKS: '1', ODC_INDEX_INTERVAL_MS: '600000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 50; i++) { try { await fetch(`${base}/api/setup`); return; } catch { await sleep(100); } }
};
const stop = async () => { server.kill(); await new Promise((r) => server.once('exit', r)); };
const post = (url, body, headers = {}) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
let key;
const api = async (method, url, body, k = key) => {
  const r = await fetch(base + url, { method, headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const video = (name) => {
  const f = path.join(dir, 'src', name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=5', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-metadata', `comment=${name}`, f]);
  return f;
};

try {
  await start();
  await post('/api/setup', { username: 'admin', password: 'correct horse' });
  key = (await (await post('/api/login', { username: 'admin', password: 'correct horse', app: true })).json()).token;
  const car = (await api('POST', '/api/cars', { name: 'CX5' })).data;
  const code = (await api('POST', `/api/cars/${car.id}/pairing`, { label: 'Front' })).data.code;
  const phone = { Authorization: `Bearer ${(await (await post('/api/v1/devices/pair', { code })).json()).token}` };
  const b = fs.readFileSync(video('ODC_a.mp4'));
  const up = await (await post('/api/v1/uploads', { fileName: 'ODC_a.mp4', sizeBytes: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex'), startedAt: Date.now() - 600_000 }, phone)).json();
  await fetch(`${base}/api/v1/uploads/${up.id}`, { method: 'PATCH', headers: { ...phone, 'Upload-Offset': '0' }, body: b });
  await fetch(`${base}/api/v1/uploads/${up.id}/complete`, { method: 'POST', headers: phone });

  // A share whose blurring is stuck in the ML container's queue
  let r = await api('POST', `/api/clips/${up.id}/share`, { blurFaces: true });
  const stuckShare = r.data.token;
  await sleep(1500);
  r = await api('GET', '/api/background');
  const sj = r.data.jobs.find((j) => j.kind === 'share');
  assert.equal(sj.status, 'running'); assert.match(sj.step, /Waiting for the ML container/); assert.match(sj.title, /blurring faces/);
  assert.equal(r.data.ml.reachable, true); assert.equal(r.data.ml.blur.length, 1); ok('Background work shows the share job and that it’s waiting in the ML container’s queue');

  // The server restarts: the share is prepared again, and completes once the ML container works
  await stop();
  mode = 'ok';
  await start();
  for (let i = 0; i < 40; i++) { const s = (await api('GET', '/api/shares')).data.find((x) => x.token === stuckShare); if (s.status === 'ready') break; await sleep(250); }
  assert.equal((await api('GET', '/api/shares')).data.find((x) => x.token === stuckShare).status, 'ready'); ok('a share link interrupted by a server restart is prepared again and becomes ready');

  // Lanes: a slow memory card import doesn't hold up a share link
  fs.mkdirSync(path.join(dir, 'import', 'card'), { recursive: true });
  for (let i = 0; i < 4; i++) fs.copyFileSync(video(`2026_1005_10000${i}_00000${i}F.MP4`), path.join(dir, 'import', 'card', `2026_1005_10000${i}_00000${i}F.MP4`));
  r = await api('POST', `/api/cars/${car.id}/import`, { folder: 'card' });
  const importJob = r.data.jobId;
  await sleep(300);
  r = await api('POST', `/api/clips/${up.id}/share`, { blurPlates: true });
  const shareJob = r.data.jobId;
  let share, imp;
  for (let i = 0; i < 40; i++) { share = (await api('GET', `/api/jobs/${shareJob}`)).data; if (share.status === 'done') break; await sleep(200); }
  imp = (await api('GET', `/api/jobs/${importJob}`)).data;
  assert.equal(share.status, 'done'); assert.equal(imp.status, 'running'); ok('a share link finishes while a slow memory card import is still running (separate lanes)');
  r = await api('GET', '/api/background');
  const ij = r.data.jobs.find((j) => j.kind === 'import');
  assert.equal(ij.status, 'running'); assert.match(ij.step, /of 4/); ok(`Background work shows the import’s progress (“${ij.step}”)`);

  // The ML container restarts during blurring: the share fails clearly instead of waiting forever
  mode = 'gone';
  r = await api('POST', `/api/clips/${up.id}/share`, { blurFaces: true });
  let j;
  for (let i = 0; i < 40; i++) { j = (await api('GET', `/api/jobs/${r.data.jobId}`)).data; if (j.status === 'failed') break; await sleep(200); }
  assert.equal(j.status, 'failed'); assert.match(j.error, /restarted/); ok(`a blur job the ML container forgot fails with a clear message (“${j.error}”)`);

  // Safety net: an unexpected error doesn't stop the server
  await api('POST', '/api/test/crash');
  await sleep(500);
  assert.equal((await api('GET', '/api/me')).status, 200); ok('an unexpected error doesn’t stop the server');
  r = await api('GET', '/api/background');
  assert.ok(r.data.errors.some((e) => e.message === 'test crash')); assert.ok(fs.readFileSync(path.join(dir, 'logs', 'errors.log'), 'utf8').includes('test crash'));
  ok('…it’s listed for admins in Background work and written to logs/errors.log');

  // People who aren't admins see only their own jobs, and no errors
  await api('POST', '/api/users', { username: 'sam', password: 'password123' });
  const samKey = (await (await post('/api/login', { username: 'sam', password: 'password123', app: true })).json()).token;
  r = await api('GET', '/api/background', undefined, samKey);
  assert.equal(r.data.jobs.length, 0); assert.equal(r.data.errors.length, 0); ok('others see only their own jobs, and no error details');
  console.log(`\nAll ${passed} checks passed.`);
} catch (e) {
  console.error('\nFAILED:', e);
  console.error('--- log ---\n' + log.slice(-3000));
  process.exitCode = 1;
} finally {
  server?.kill();
  ml.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
