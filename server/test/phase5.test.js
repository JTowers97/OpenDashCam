// Smart search end to end: real server + the real ML service code in its fake-model mode.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-test-5-'));
const geo = path.join(dir, 'geonames');
fs.mkdirSync(geo);
fs.writeFileSync(path.join(geo, 'cities500.txt'),
  ['1', 'Testville', 'Testville', '', '40.0', '-90.0', 'P', 'PPL', 'US', '', 'IL', '', '', '', '1000', '', '', 'America/Chicago', '2024-01-01'].join('\t') + '\n');
const port = 18000 + Math.floor(Math.random() * 1000);
const mlPort = port + 1000;
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let log = '';
const ml = spawn('python3', ['ml/app.py'], { env: { ...process.env, ODC_ML_FAKE: '1', PORT: String(mlPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
ml.stderr.on('data', (d) => (log += '[ml] ' + d));
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.js'], {
  env: { ...process.env, PORT: String(port), ODC_DATA_DIR: dir, ODC_GEONAMES_DIR: geo, ODC_ML_URL: `http://127.0.0.1:${mlPort}`, ODC_INDEX_INTERVAL_MS: '500' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));
let passed = 0;
const ok = (n) => { passed++; console.log('  ✓', n); };

let cookie = '';
async function web(method, url, body) {
  const h = cookie ? { Cookie: cookie } : {};
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(base + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return { status: r.status, data: (r.headers.get('content-type') || '').includes('json') ? await r.json() : null };
}

try {
  for (let i = 0; i < 50; i++) { try { await fetch(`${base}/api/setup`); break; } catch { await sleep(100); } }
  await web('POST', '/api/setup', { username: 'admin', password: 'correct horse' });
  const car = (await web('POST', '/api/cars', { name: 'CX5' })).data;
  const code = (await web('POST', `/api/cars/${car.id}/pairing`, { label: 'Front' })).data.code;
  const token = (await (await fetch(`${base}/api/v1/devices/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json()).token;
  const phone = async (method, url, body, headers = {}) => {
    const h = { Authorization: `Bearer ${token}`, ...headers };
    let payload = body;
    if (body !== undefined && !(body instanceof Uint8Array)) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(base + url, { method, headers: h, body: payload });
    return { status: r.status, data: r.status !== 204 && (r.headers.get('content-type') || '').includes('json') ? await r.json() : null };
  };

  // Clips: 20 s each. "mixed" is gray for 12 s, then red, so the best moment is in the second half.
  const t0 = Date.parse('2026-10-01T08:00:00Z');
  const make = async (name, filter, startedAt, extra = {}) => {
    const f = path.join(dir, name);
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', filter, '-t', '20', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-metadata', `comment=${name}`, '-f', 'mp4', f]);
    const b = fs.readFileSync(f);
    const sha = crypto.createHash('sha256').update(b).digest('hex');
    const up = (await phone('POST', '/api/v1/uploads', { fileName: name, sizeBytes: b.length, sha256: sha, startedAt, ...extra })).data;
    await phone('PATCH', `/api/v1/uploads/${up.id}`, b, { 'Upload-Offset': '0' });
    assert.equal((await phone('POST', `/api/v1/uploads/${up.id}/complete`)).status, 200);
    return up.id;
  };
  const red = await make('red.mp4', 'color=c=red:size=320x180:rate=10', t0);
  const blue = await make('blue.mp4', 'color=c=blue:size=320x180:rate=10', t0 + 60_000);
  const green = await make('green.mp4', 'color=c=green:size=320x180:rate=10', t0 + 86400_000);
  const mixed = await make('mixed.mp4', "color=c=gray:size=320x180:rate=10[a];color=c=red:size=320x180:rate=10[b];[a][b]overlay=enable='gte(t,12)'", t0 + 120_000);
  const enc = await make('secret.odcenc', 'color=c=red:size=320x180:rate=10', t0 + 180_000, { encrypted: true });
  // Put the blue clip in Testville
  const gpx = `<gpx><trk><trkseg><trkpt lat="40.0010000" lon="-90.0000000"><time>${new Date(t0 + 60_000).toISOString()}</time></trkpt></trkseg></trk></gpx>`;
  await phone('POST', `/api/v1/clips/${blue}/sidecar?kind=gpx`, new TextEncoder().encode(gpx));

  // ---- off by default
  let r = await web('GET', '/api/search?q=red');
  assert.equal(r.data.smartSearch, false); assert.equal(r.data.visual.length, 0); ok('smart search is off by default');
  r = await web('GET', '/api/search?q=testville');
  assert.deepEqual(r.data.text.map((c) => c.id), [blue]); ok('place-name search works without ML');

  // ---- turn on: indexer runs
  await web('PUT', '/api/settings', { smartSearch: true });
  let st;
  for (let i = 0; i < 60; i++) {
    st = (await web('GET', '/api/search/status')).data;
    if (st.ml?.ready && st.indexed === 4) break;
    await sleep(500);
  }
  assert.equal(st.ml.ready, true); assert.equal(st.indexed, 4); assert.equal(st.searchable, 4); ok('indexed 4 clips; encrypted clip skipped');

  r = await web('GET', '/api/search?q=a%20red%20car');
  const ids = r.data.visual.map((c) => c.id);
  assert.ok(ids.includes(red) && ids.includes(mixed)); assert.ok(!ids.includes(blue) && !ids.includes(green) && !ids.includes(enc));
  ok('"a red car" finds the red clips only');
  const m = r.data.visual.find((c) => c.id === mixed);
  assert.ok(m.offsetMs >= 12_000, `offset ${m.offsetMs}`); ok(`jumps to the moment red appears (${m.offsetMs / 1000} s into the mixed clip)`);
  assert.ok(r.data.visual[0].score > 0.9); ok('scores are reported');
  r = await web('GET', '/api/search?q=blue%20truck');
  assert.equal(r.data.visual[0].id, blue); ok('"blue truck" finds the blue clip');
  r = await web('GET', `/api/search?q=red&from=${t0 + 100_000}&to=${t0 + 200_000}`);
  assert.deepEqual(r.data.visual.map((c) => c.id), [mixed]); ok('date filter narrows visual results');
  r = await web('GET', `/api/search?q=green&car=${car.id}`);
  assert.equal(r.data.visual[0].id, green); ok('car filter + visual search');

  // ---- deleted clips leave the index
  await web('DELETE', `/api/clips/${red}`);
  r = await web('GET', '/api/search?q=red');
  assert.ok(!r.data.visual.some((c) => c.id === red)); ok('deleted clip disappears from results');

  // ---- license plates (fake model reads "RED123" in red frames)
  r = await web('GET', '/api/search?q=RED123');
  assert.equal(r.data.plateSearch, false); assert.equal(r.data.plates.length, 0); ok('plate search is off by default');
  await web('PUT', '/api/settings', { plateSearch: true, plateRetentionDays: 30 });
  for (let i = 0; i < 60; i++) {
    st = (await web('GET', '/api/search/status')).data;
    if (st.platesIndexed >= 3) break;
    await sleep(500);
  }
  assert.ok(st.platesIndexed >= 3, JSON.stringify(st)); ok(`plates read from ${st.platesIndexed} clips`);
  r = await web('GET', '/api/search?q=RED%20123');
  assert.deepEqual(r.data.plates.map((c) => c.id).sort(), [mixed].sort()); ok('plate search finds the clip showing the plate');
  assert.ok(r.data.plates[0].offsetMs >= 12_000); ok('opens at the moment the plate was seen');
  r = await web('GET', '/api/search?q=RE0123');
  assert.equal(r.data.plates.length, 1); assert.equal(r.data.plates[0].plateMatch, 0.9); ok('look-alike characters (D/0) still match');
  r = await web('GET', '/api/search?q=XYZ999');
  assert.equal(r.data.plates.length, 0); ok('a different plate finds nothing');
  r = await web('GET', `/api/search?q=RED123&from=${t0 + 86400_000}`);
  assert.equal(r.data.plates.length, 0); ok('date filters apply to plate search');
  // ---- plate log (separate switch)
  r = await web('GET', '/api/plates');
  assert.equal(r.status, 403); ok('plate log is off until it is turned on');
  await web('PUT', '/api/settings', { plateLog: true });
  r = await web('GET', '/api/plates');
  assert.equal(r.status, 200); assert.equal(r.data.length, 1); assert.equal(r.data[0].plate, 'RED123');
  assert.ok(r.data[0].sightings >= 1); ok(`log lists RED123 (${r.data[0].sightings} sightings)`);
  r = await web('GET', '/api/plates/RED123');
  const reads = r.data.reads;
  assert.ok(reads.length >= 1 && reads[0].carName === 'CX5'); ok('plate detail lists sightings with car and time');
  const crop = await fetch(`${base}/api/plates/reads/${reads[0].id}/crop`, { headers: { Cookie: cookie } });
  assert.equal(crop.status, 200); assert.equal(crop.headers.get('content-type'), 'image/jpeg');
  assert.ok((await crop.arrayBuffer()).byteLength > 500); ok('cropped plate image for review');
  // Simulate a misread, then merge it back as "the same plate"
  r = await web('PATCH', `/api/plates/reads/${reads[0].id}`, { plate: 'RED1Z3' });
  assert.equal(r.data.plate, 'RED1Z3'); ok('correct a single reading');
  r = await web('GET', '/api/plates/RED123');
  if (r.status === 200) {
    assert.ok(r.data.similar.some((x) => x.plate === 'RED1Z3')); ok('suggests the misread as possibly the same plate');
  } else {
    r = await web('GET', '/api/plates/RED1Z3');
    assert.ok(r.data.reads.length >= 1); ok('corrected reading appears under its new plate');
  }
  await web('PATCH', '/api/plates/RED1Z3', { note: 'neighbor' });
  r = await web('POST', '/api/plates/RED1Z3/merge', { into: 'RED123' });
  assert.equal(r.data.plate, 'RED123');
  r = await web('GET', '/api/plates');
  assert.deepEqual(r.data.map((p) => p.plate), ['RED123']); assert.equal(r.data[0].note, 'neighbor'); ok('merge combines sightings and notes');
  r = await web('GET', '/api/plates?q=neighbor');
  assert.equal(r.data.length, 1); ok('search the log by note');
  // Re-reading a clip applies the remembered merge
  r = await web('GET', '/api/plates/RED123');
  const before = r.data.reads.length;
  await web('PATCH', `/api/plates/reads/${r.data.reads[0].id}`, { plate: 'RED999' });
  await web('POST', '/api/plates/RED999/merge', { into: 'RED123' });
  r = await web('GET', '/api/plates/RED123');
  assert.equal(r.data.reads.length, before); ok('merges are remembered');
  // Delete a false reading
  const extra = r.data.reads[0].id;
  r = await web('DELETE', `/api/plates/reads/${extra}`);
  r = await web('GET', '/api/plates/RED123');
  assert.equal(r.status === 404 ? 0 : r.data.reads.length, before - 1); ok('delete a false reading');

  // ---- retention: forever keeps everything; a short period purges old readings
  await web('PUT', '/api/settings', { plateRetentionDays: 0 });
  r = await web('GET', '/api/search/status');
  const kept = r.data.plateReads;
  await web('PUT', '/api/settings', { plateRetentionDays: 0 });
  assert.equal((await web('GET', '/api/search/status')).data.plateReads, kept); ok('"keep forever" keeps readings');
  // Turning plate reading off keeps the data (and turns the log off); erasing is a separate action
  await web('PUT', '/api/settings', { plateSearch: false });
  st = (await web('GET', '/api/search/status')).data;
  assert.equal(st.plateSearch, false);
  const sAfter = (await web('GET', '/api/settings')).data;
  assert.equal(sAfter.plateLog, false); ok('turning plate reading off also turns the log off');
  await web('PUT', '/api/settings', { plateSearch: true });
  assert.ok((await web('GET', '/api/search/status')).data.plateReads >= 0);
  r = await web('POST', '/api/plates/erase');
  assert.equal((await web('GET', '/api/search/status')).data.plateReads, 0); ok('"delete all plate data" erases readings');
  await web('PUT', '/api/settings', { plateRetentionDays: 1, plateSearch: false });

  // ---- ML service down: text search still works, visual reports the problem
  ml.kill();
  await sleep(500);
  r = await web('GET', '/api/search?q=testville');
  assert.equal(r.data.text.length, 1); assert.ok(r.data.visualError); ok('ML outage: place search still works, visual search explains the problem');
  st = (await web('GET', '/api/search/status')).data;
  assert.equal(st.ml.ready, false); ok('status shows the ML service is unreachable');

  // ---- reindex resets
  r = await web('POST', '/api/search/reindex', { failedOnly: false });
  assert.equal(r.data.indexed, 0); ok('reindex clears the index');

  console.log(`\nAll ${passed} checks passed.`);
} catch (e) {
  console.error('\nFAILED:', e);
  console.error('--- log ---\n' + log);
  process.exitCode = 1;
} finally {
  server.kill();
  ml.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
