// 1.1: setup checklist, calendar, bulk actions, ZIP downloads, trimming, trip logbook CSV.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-test-11-'));
const port = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let log = '';
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.js'], {
  env: { ...process.env, PORT: String(port), ODC_HTTPS_PORT: String(port + 1500), ODC_DATA_DIR: dir, ODC_TRIP_INTERVAL_MS: '300' },
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

try {
  for (let i = 0; i < 50; i++) { try { await fetch(`${base}/api/setup`); break; } catch { await sleep(100); } }
  const web = client();
  await web('POST', '/api/setup', { username: 'admin', password: 'correct horse' });
  let r = await web('GET', '/api/checklist');
  assert.equal(r.data.filter((i) => i.done).length, 1); assert.ok(r.data.find((i) => i.key === 'backups').done); ok('checklist starts mostly open (backups already on)');

  const car = (await web('POST', '/api/cars', { name: 'CX5' })).data;
  const code = (await web('POST', `/api/cars/${car.id}/pairing`, { label: 'Front' })).data.code;
  const token = (await (await fetch(`${base}/api/v1/devices/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json()).token;
  const phone = async (method, url, body, headers = {}) => {
    const h = { Authorization: `Bearer ${token}`, ...headers };
    let payload = body;
    if (body !== undefined && !(body instanceof Uint8Array)) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers: h, body: payload });
    return { status: res.status, data: res.status !== 204 && (res.headers.get('content-type') || '').includes('json') ? await res.json() : null };
  };
  // 10-second clips with a keyframe every second, on two different days
  const day1 = new Date(2026, 8, 14, 8, 0, 0).getTime();
  const day2 = new Date(2026, 8, 16, 17, 30, 0).getTime();
  const ids = [];
  for (const [i, t] of [[0, day1], [1, day1 + 600_000], [2, day2]]) {
    const f = path.join(dir, `c${i}.mp4`);
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-t', '10', '-g', '10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-metadata', `comment=${i}`, f]);
    const b = fs.readFileSync(f);
    const up = (await phone('POST', '/api/v1/uploads', { fileName: `ODC_${i}_front.mp4`, sizeBytes: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex'), startedAt: t })).data;
    await phone('PATCH', `/api/v1/uploads/${up.id}`, b, { 'Upload-Offset': '0' });
    await phone('POST', `/api/v1/uploads/${up.id}/complete`);
    ids.push(up.id);
  }
  // A GPX track for the first clip, and a 20-minute drive for the logbook
  const pts = Array.from({ length: 121 }, (_, i) => `<trkpt lat="${(38.6 + i * 0.001).toFixed(6)}" lon="-90.2"><time>${new Date(day1 + i * 10_000).toISOString()}</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:speed>13.4</gpxtpx:speed></gpxtpx:TrackPointExtension></extensions></trkpt>`).join('');
  await phone('POST', `/api/v1/clips/${ids[0]}/sidecar?kind=gpx`, new TextEncoder().encode(`<gpx><trk><trkseg>${pts}</trkseg></trk></gpx>`));
  await sleep(2500);

  r = await web('GET', '/api/checklist');
  const done = Object.fromEntries(r.data.map((i) => [i.key, i.done]));
  assert.ok(done.car && done.phone && done.clip && done.gps && !done.twofa); ok('checklist updates as steps are completed');

  // ---- calendar
  r = await web('GET', '/api/clips/calendar?month=2026-09');
  assert.equal(r.data.days['2026-09-14'].count, 2); assert.equal(r.data.days['2026-09-16'].count, 1); assert.ok(!r.data.days['2026-09-15']);
  ok('calendar counts clips per day (server time zone)');
  r = await web('GET', '/api/clips/calendar?month=2026-10');
  assert.deepEqual(r.data.days, {}); ok('empty months are empty');

  // ---- bulk actions + permissions
  r = await web('POST', '/api/clips/bulk', { ids: [ids[0], ids[1]], action: 'lock' });
  assert.equal(r.data.done, 2);
  r = await web('GET', '/api/clips?locked=1');
  assert.equal(r.data.total, 2); ok('bulk lock');
  await web('POST', '/api/users', { username: 'sam', password: 'password123' });
  await web('POST', `/api/cars/${car.id}/shares`, { username: 'sam', role: 'viewer' });
  const sam = client();
  await sam('POST', '/api/login', { username: 'sam', password: 'password123' });
  r = await sam('POST', '/api/clips/bulk', { ids, action: 'delete' });
  assert.equal(r.data.done, 0); assert.equal(r.data.skipped, 3); ok('viewers can’t bulk-delete');

  // ---- ZIP download
  r = await web('POST', '/api/clips/zip', { ids: [ids[0], ids[2]] });
  assert.equal(r.data.count, 2);
  const zip = await web('GET', r.data.url);
  const zf = path.join(dir, 'dl.zip');
  fs.writeFileSync(zf, zip.data);
  const listing = execFileSync('unzip', ['-l', zf]).toString();
  execFileSync('unzip', ['-tq', zf]);
  assert.match(listing, /CX5 - Front\/ODC_0_front\.mp4/); assert.match(listing, /ODC_0_front\.gpx/); assert.match(listing, /ODC_2_front\.mp4/);
  ok('ZIP download is valid and includes the GPS track');
  r = await sam('GET', zip.headers ? (await web('POST', '/api/clips/zip', { ids: [ids[0]] })).data.url : '');
  assert.equal(r.status, 404); ok('download links only work for the person who requested them');

  // ---- trimming
  r = await web('POST', `/api/clips/${ids[0]}/trim`, { start: 2, end: 6, save: true });
  assert.equal(r.status, 201);
  await sleep(1500);
  const trimmed = (await web('GET', `/api/clips/${r.data.id}`)).data;
  assert.ok(trimmed.locked); assert.equal(trimmed.trimmedFrom, ids[0]); assert.ok(trimmed.durationMs >= 3500 && trimmed.durationMs <= 5000, `duration ${trimmed.durationMs}`);
  assert.equal(trimmed.startedAt, day1 + 2000); ok(`trimmed copy saved as a new locked clip (${trimmed.durationMs / 1000} s, starts 2 s in)`);
  const orig = (await web('GET', `/api/clips/${ids[0]}`)).data;
  assert.ok(orig.durationMs >= 9500); ok('original clip is unchanged');
  r = await web('POST', `/api/clips/${ids[2]}/trim`, { start: 0, end: 3 });
  const dl = await web('GET', r.data.url);
  const tf = path.join(dir, 't.mp4');
  fs.writeFileSync(tf, dl.data);
  const d = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', tf]).toString());
  assert.ok(d >= 2.5 && d <= 4, `duration ${d}`); ok(`trimmed download works (${d.toFixed(1)} s)`);
  r = await web('POST', `/api/clips/${ids[2]}/trim`, { start: 5, end: 2 });
  assert.equal(r.status, 400); ok('invalid trims are rejected');

  // ---- trip logbook CSV
  r = await web('GET', '/api/trips.csv?units=mph');
  const csv = r.data.toString('utf8').replace(/^\ufeff/, '');
  const rows = csv.trim().split('\r\n');
  assert.match(rows[0], /^Date,Start,End,Car,Trip,From,To,Distance \(mi\)/);
  assert.equal(rows.length, 3); assert.match(rows[1], /^2026-09-14,08:00,08:20,CX5,/);
  const miles = Number(rows[1].split(',')[7]);
  assert.ok(miles > 8 && miles < 9, `miles ${miles}`); assert.match(rows[2], /^Total/); ok(`logbook CSV: one trip of ${miles} mi, with a total row`);
  await web('PUT', '/api/settings', { units: 'kmh' });
  r = await web('GET', '/api/trips.csv');
  assert.match(r.data.toString(), /Distance \(km\)/); ok('logbook follows the units setting');

  r = await web('GET', '/api/audit?action=clips');
  assert.ok(r.data.some((e) => e.action === 'clips locked') && r.data.some((e) => e.action === 'clips downloaded')); ok('bulk actions and downloads are in the activity log');

  console.log(`\nAll ${passed} checks passed.`);
} catch (e) {
  console.error('\nFAILED:', e);
  console.error('--- log ---\n' + log.slice(-3000));
  process.exitCode = 1;
} finally {
  server.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
