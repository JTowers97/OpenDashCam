// 1.2: expiring share links (with trimming and blurring), incident reports, background jobs.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-test-12-'));
const port = 18000 + Math.floor(Math.random() * 1000);
const mlPort = port + 1000;
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let log = '';
const ml = spawn('python3', ['ml/app.py'], { env: { ...process.env, ODC_ML_FAKE: '1', PORT: String(mlPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
ml.stderr.on('data', (d) => (log += '[ml] ' + d));
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.js'], {
  env: { ...process.env, PORT: String(port), ODC_HTTPS_PORT: String(port + 1500), ODC_DATA_DIR: dir, ODC_ML_URL: `http://127.0.0.1:${mlPort}`, ODC_INDEX_INTERVAL_MS: '600000', ODC_TRIP_INTERVAL_MS: '300' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));
let passed = 0;
const ok = (n) => { passed++; console.log('  ✓', n); };
function client() {
  let cookie = '';
  return async (method, url, body) => {
    const h = cookie ? { Cookie: cookie } : {};
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const r = await fetch(base + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, headers: r.headers, data: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
}
const probe = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,codec_type', '-of', 'json', f]).toString());

try {
  for (let i = 0; i < 80; i++) { try { await fetch(`${base}/api/setup`); await fetch(`http://127.0.0.1:${mlPort}/health`); break; } catch { await sleep(100); } }
  const web = client();
  await web('POST', '/api/setup', { username: 'admin', password: 'correct horse' });
  const car = (await web('POST', '/api/cars', { name: 'CX5' })).data;
  const phones = {};
  for (const label of ['Front', 'Rear']) {
    const code = (await web('POST', `/api/cars/${car.id}/pairing`, { label })).data.code;
    const token = (await (await fetch(`${base}/api/v1/devices/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json()).token;
    phones[label] = async (method, url, body, headers = {}) => {
      const h = { Authorization: `Bearer ${token}`, ...headers };
      let payload = body;
      if (body !== undefined && !(body instanceof Uint8Array)) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
      const res = await fetch(base + url, { method, headers: h, body: payload });
      return { status: res.status, data: res.status !== 204 && (res.headers.get('content-type') || '').includes('json') ? await res.json() : null };
    };
  }
  const t0 = Date.now() - 3600_000;
  const upload = async (label, startedAt, i) => {
    const f = path.join(dir, `${label}${i}.mp4`);
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=gray:s=320x180:r=10,noise=alls=50:allf=t,drawbox=x=100:y=60:w=10:h=10:color=red@1:t=fill`,
      '-t', '20', '-g', '10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-metadata', `comment=${label}${i}`, f]);
    const b = fs.readFileSync(f);
    const up = (await phones[label]('POST', '/api/v1/uploads', { fileName: `ODC_${label}_${i}.mp4`, sizeBytes: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex'), startedAt })).data;
    await phones[label]('PATCH', `/api/v1/uploads/${up.id}`, b, { 'Upload-Offset': '0' });
    await phones[label]('POST', `/api/v1/uploads/${up.id}/complete`);
    return { id: up.id, bytes: b };
  };
  const front = await upload('Front', t0, 1);
  const front2 = await upload('Front', t0 + 20_000, 2);
  const rear = await upload('Rear', t0 + 5_000, 1);
  const pts = Array.from({ length: 41 }, (_, i) => `<trkpt lat="${(38.6 + i * 0.0003).toFixed(6)}" lon="-90.2"><time>${new Date(t0 + i * 1000).toISOString()}</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:speed>${(10 + i * 0.3).toFixed(1)}</gpxtpx:speed></gpxtpx:TrackPointExtension></extensions></trkpt>`).join('');
  await phones.Front('POST', `/api/v1/clips/${front.id}/sidecar?kind=gpx`, new TextEncoder().encode(`<gpx><trk><trkseg>${pts}</trkseg></trk></gpx>`));
  await sleep(1500);

  // ---- plain share link
  let r = await web('POST', `/api/clips/${front.id}/share`, { expiresHours: 24, allowDownload: false });
  assert.equal(r.status, 201); assert.equal(r.data.status, 'ready'); assert.ok(r.data.url.endsWith(`/s/${r.data.token}`));
  assert.ok(Math.abs(r.data.expiresAt - (Date.now() + 24 * 3600_000)) < 60_000); ok('share link created (24 hours, ready immediately)');
  const tok = r.data.token;
  let page = await fetch(`${base}/s/${tok}`);
  const html = await page.text();
  assert.equal(page.status, 200); assert.match(html, /<video src="\/s\/[^"]+\/video"/); assert.doesNotMatch(html, /CX5|Front/);
  assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow'); ok('public page plays the video without an account and doesn’t reveal the car');
  const vid = Buffer.from(await (await fetch(`${base}/s/${tok}/video`)).arrayBuffer());
  assert.ok(vid.equals(front.bytes)); ok('video streams from the share link');
  assert.equal((await fetch(`${base}/s/${tok}/download`)).status, 403); ok('download refused unless allowed');
  r = await web('GET', '/api/shares');
  assert.equal(r.data[0].views, 1); ok('views are counted');
  await web('DELETE', `/api/shares/${tok}`);
  assert.equal((await fetch(`${base}/s/${tok}`)).status, 410); assert.equal((await fetch(`${base}/s/${tok}/video`)).status, 410); ok('revoked links stop working');

  // expiry
  r = await web('POST', `/api/clips/${front.id}/share`, { expiresHours: 1, allowDownload: true });
  const tok2 = r.data.token;
  assert.equal((await fetch(`${base}/s/${tok2}/download`)).status, 200); ok('download works when allowed');
  const dbh = new DatabaseSync(path.join(dir, 'odc.db'));
  dbh.prepare('UPDATE shares SET expires_at = ? WHERE token = ?').run(Date.now() - 1000, tok2);
  dbh.close();
  page = await fetch(`${base}/s/${tok2}`);
  assert.equal(page.status, 410); assert.match(await page.text(), /expired/); ok('expired links show “expired”');

  // ---- trimmed + blurred share (background job through the ML container)
  r = await web('GET', '/api/blur/available');
  assert.equal(r.data.available, true); ok('blurring is available with the ML container');
  r = await web('POST', `/api/clips/${front.id}/share`, { expiresHours: 168, start: 4, end: 12, blurPlates: true, blurFaces: true });
  assert.equal(r.data.status, 'processing'); assert.ok(r.data.jobId);
  const tok3 = r.data.token;
  let job;
  for (let i = 0; i < 120; i++) { job = (await web('GET', `/api/jobs/${r.data.jobId}`)).data; if (job.status === 'done' || job.status === 'failed') break; await sleep(500); }
  assert.equal(job.status, 'done', job.error); ok('trim + blur job finishes');
  const blurred = path.join(dir, 'blurred.mp4');
  fs.writeFileSync(blurred, Buffer.from(await (await fetch(`${base}/s/${tok3}/video`)).arrayBuffer()));
  const info = probe(blurred);
  assert.ok(Math.abs(Number(info.format.duration) - 8) < 1.5, `duration ${info.format.duration}`); assert.equal(info.streams[0].codec_name, 'h264');
  ok(`shared copy is trimmed (${Number(info.format.duration).toFixed(1)} s) and re-encoded after blurring`);
  assert.match(await (await fetch(`${base}/s/${tok3}`)).text(), /License plates blurred and faces blurred/); ok('page says what was blurred');

  await web('PUT', '/api/settings', { mlUrl: 'http://127.0.0.1:9' });
  r = await web('POST', `/api/clips/${front.id}/share`, { blurPlates: true });
  assert.equal(r.status, 400); ok('blurring refused clearly when the ML container is unreachable');
  await web('PUT', '/api/settings', { mlUrl: `http://127.0.0.1:${mlPort}` });

  // ---- incident report
  await phones.Front('POST', '/api/v1/events', { type: 'impact', message: '2.6 g impact' });
  const dbh2 = new DatabaseSync(path.join(dir, 'odc.db'));
  dbh2.prepare("UPDATE events SET t = ? WHERE type = 'impact'").run(t0 + 12_000);
  dbh2.close();
  r = await web('POST', '/api/reports', { carId: car.id, t: t0 + 12_000, beforeS: 10, afterS: 15, units: 'mph', note: 'Other car ran the red light.\n<script>alert(1)</script>' });
  assert.equal(r.status, 202);
  for (let i = 0; i < 120; i++) { job = (await web('GET', `/api/jobs/${r.data.jobId}`)).data; if (job.status === 'done' || job.status === 'failed') break; await sleep(500); }
  assert.equal(job.status, 'done', job.error); assert.ok(job.result.downloadUrl); ok(`report job finished (${job.result.clips} video pieces)`);
  const zip = await web('GET', job.result.downloadUrl);
  const zf = path.join(dir, 'report.zip');
  fs.writeFileSync(zf, zip.data);
  execFileSync('unzip', ['-tq', zf]);
  const listing = execFileSync('unzip', ['-Z1', zf]).toString().trim().split('\n');
  assert.ok(listing.includes('report.html') && listing.includes('route.gpx') && listing.includes('README.txt'));
  assert.equal(listing.filter((n) => n.startsWith('clips/Front')).length, 2); assert.equal(listing.filter((n) => n.startsWith('clips/Rear')).length, 1);
  ok('report ZIP: report.html, route.gpx, and footage from both cameras (front spans two clips)');
  const rep = execFileSync('unzip', ['-p', zf, 'report.html']).toString();
  assert.match(rep, /Incident report/); assert.match(rep, /<polyline/); assert.match(rep, /impact/); assert.match(rep, /2\.6 g impact/);
  assert.match(rep, /Other car ran the red light/); assert.doesNotMatch(rep, /<script>alert/); assert.match(rep, /&lt;script&gt;/);
  ok('report has summary, speed graph, the impact event and notes (safely escaped)');
  assert.match(rep, /Speed at that moment<\/td><td>\d+ mph/); ok('speed shown in the chosen units');
  const piece = path.join(dir, 'piece.mp4');
  fs.writeFileSync(piece, execFileSync('unzip', ['-p', zf, listing.find((n) => n.startsWith('clips/Rear'))], { maxBuffer: 1 << 28 }));
  const pd = Number(probe(piece).format.duration);
  assert.ok(pd > 15 && pd < 22, `rear piece ${pd}`); ok(`footage trimmed to the period (${pd.toFixed(1)} s of rear camera)`);
  const other = client();
  await web('POST', '/api/users', { username: 'sam', password: 'password123' });
  await other('POST', '/api/login', { username: 'sam', password: 'password123' });
  assert.equal((await other('GET', `/api/jobs/${r.data.jobId}`)).status, 404);
  assert.equal((await other('GET', job.result.downloadUrl)).status, 404); ok('reports and jobs are private to whoever created them');

  // ---- deleting a clip removes its links
  r = await web('POST', `/api/clips/${front2.id}/share`, {});
  const tok4 = r.data.token;
  await web('DELETE', `/api/clips/${front2.id}`);
  assert.equal((await fetch(`${base}/s/${tok4}`)).status, 410); ok('deleting a clip turns off its links');
  r = await web('GET', '/api/audit?action=share');
  assert.ok(r.data.some((e) => e.action === 'share link created' && /plates blurred/.test(e.detail))); ok('share links are in the activity log');
  void rear;

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
