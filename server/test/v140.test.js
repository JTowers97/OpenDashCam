// 1.4: Home Assistant over MQTT (discovery, states, events, reconnects) and Viofo dashcam import.
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-test-14-'));
const port = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (n) => { passed++; console.log('  ✓', n); };

// ---- a test MQTT broker (MQTT 3.1.1): accepts one user, records publishes
const published = [];
let connects = [];
const brokerSockets = new Set();
const broker = net.createServer((sock) => {
  brokerSockets.add(sock);
  sock.on('close', () => brokerSockets.delete(sock));
  let buf = Buffer.alloc(0);
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      let len = 0, mult = 1, i = 1, b;
      do { if (i >= buf.length) return; b = buf[i++]; len += (b & 0x7f) * mult; mult *= 128; } while (b & 0x80);
      if (buf.length < i + len) return;
      const type = buf[0] >> 4, flags = buf[0] & 0x0f, body = buf.subarray(i, i + len);
      buf = buf.subarray(i + len);
      const rd = (o) => { const l = body.readUInt16BE(o); return [body.subarray(o + 2, o + 2 + l).toString(), o + 2 + l]; };
      if (type === 1) { // CONNECT
        let [proto, o] = rd(0);
        const level = body[o]; const cf = body[o + 1]; o += 4;
        let clientId, willTopic, willMsg, user, pass;
        [clientId, o] = rd(o);
        if (cf & 0x04) { [willTopic, o] = rd(o); [willMsg, o] = rd(o); }
        if (cf & 0x80) [user, o] = rd(o);
        if (cf & 0x40) [pass, o] = rd(o);
        connects.push({ proto, level, clientId, willTopic, willMsg, willRetain: !!(cf & 0x20), user, pass });
        sock.write(Buffer.from([0x20, 0x02, 0x00, user === 'ha' && pass === 'secret' ? 0 : 5]));
      } else if (type === 3) { // PUBLISH (QoS 0)
        const [topic, o] = rd(0);
        published.push({ topic, payload: body.subarray(o).toString(), retain: !!(flags & 1) });
      } else if (type === 12) sock.write(Buffer.from([0xd0, 0x00])); // PINGREQ -> PINGRESP
    }
  });
});
await new Promise((r) => broker.listen(0, '127.0.0.1', r));
const brokerUrl = `mqtt://127.0.0.1:${broker.address().port}`;
const last = (topic) => [...published].reverse().find((p) => p.topic === topic);

// ---- a simulated Viofo camera
const clipFile = (name) => {
  const f = path.join(dir, 'cam', name);
  if (!fs.existsSync(f)) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-metadata', `comment=${name}`, f]);
  }
  return f;
};
const camFiles = [
  ['Movie', '2026_0915_080000_000101F.MP4'], ['Movie', '2026_0915_080300_000102F.MP4'], ['Movie', '2026_0915_080600_000103F.MP4'],
  ['Movie', '2026_0915_080000_000101R.MP4'], ['Movie', '2026_0915_080300_000102R.MP4'],
  ['Movie/Parking', '2026_0915_120000_000201F.MP4'], ['Movie/Parking', '2026_0915_121000_000202F.MP4'],
  ['Movie/RO', '2026_0915_080130_000301F.MP4'],
];
let xmlWorks = true;
let interruptOnce = '2026_0915_080000_000101F.MP4';
const rangeRequests = [];
const camera = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://cam');
  if (u.searchParams.get('custom') === '1' && u.searchParams.get('cmd') === '3015') {
    if (!xmlWorks) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    return res.end(`<?xml version="1.0" encoding="UTF-8" ?>\n<LIST>${camFiles.map(([d, n]) => `<ALLFile><File><NAME>${n}</NAME><FPATH>A:\\DCIM\\${d.replace(/\//g, '\\')}\\${n}</FPATH><SIZE>${fs.statSync(clipFile(n)).size}</SIZE><TIMECODE>0</TIMECODE><TIME>2026/09/15 08:00:00</TIME><ATTR>32</ATTR></File></ALLFile>`).join('')}</LIST>`);
  }
  const m = /^\/DCIM\/(Movie(?:\/Parking|\/RO)?)\/?$/.exec(u.pathname);
  if (m) { // folder listing
    const here = camFiles.filter(([d]) => d === m[1]);
    const sub = m[1] === 'Movie' ? '<a href="/DCIM/Movie/Parking/">Parking</a><a href="/DCIM/Movie/RO/">RO</a>' : '';
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(`<html><body>${sub}${here.map(([d, n]) => `<a href="/DCIM/${d}/${n}">${n}</a> <a href="/DCIM/${d}/${n}?del=1">delete</a>`).join('<br>')}</body></html>`);
  }
  const hit = camFiles.find(([d, n]) => u.pathname === `/DCIM/${d}/${n}`);
  if (!hit) { res.writeHead(404); return res.end(); }
  const data = fs.readFileSync(clipFile(hit[1]));
  const range = /bytes=(\d+)-/.exec(req.headers.range || '');
  if (range) {
    rangeRequests.push(hit[1]);
    const start = Number(range[1]);
    res.writeHead(206, { 'Content-Length': data.length - start, 'Content-Range': `bytes ${start}-${data.length - 1}/${data.length}` });
    return res.end(data.subarray(start));
  }
  if (hit[1] === interruptOnce) { // the car drives away mid-download
    interruptOnce = null;
    res.writeHead(200, { 'Content-Length': data.length });
    res.write(data.subarray(0, Math.floor(data.length / 2)));
    return setTimeout(() => res.destroy(), 50);
  }
  res.writeHead(200, { 'Content-Length': data.length });
  res.end(data);
});
await new Promise((r) => camera.listen(0, '127.0.0.1', r));
const camUrl = `http://127.0.0.1:${camera.address().port}`;

// ---- an ExifTool stand-in producing ExifTool's JSON output for embedded GPS (front-lens driving clips have GPS)
const fakeExif = path.join(dir, 'exiftool');
fs.writeFileSync(fakeExif, `#!/usr/bin/env node
const f = process.argv[process.argv.length - 1];
const m = /(\\d{4})_(\\d{2})(\\d{2})_(\\d{2})(\\d{2})(\\d{2})_\\d+F\\.MP4$/i.exec(f);
const out = { SourceFile: f };
if (m && !/Parking/i.test(f)) {
  const t0 = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) + 4 * 3600e3; // camera clock in local time; GPS is UTC
  for (let i = 0; i < 90; i++) {
    const d = new Date(t0 + i * 1000).toISOString().replace(/-/g, ':').replace('T', ' ').replace(/\\.\\d+Z$/, 'Z');
    out['Doc' + (i + 1) + ':GPSDateTime'] = d;
    out['Doc' + (i + 1) + ':GPSLatitude'] = 38.62 + i * 0.0002;
    out['Doc' + (i + 1) + ':GPSLongitude'] = -90.2;
    out['Doc' + (i + 1) + ':GPSSpeed'] = 72;
    out['Doc' + (i + 1) + ':GPSTrack'] = 0;
  }
}
console.log(JSON.stringify([out]));
`);
fs.chmodSync(fakeExif, 0o755);

let log = '';
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.js'], {
  env: { ...process.env, PORT: String(port), ODC_HTTPS_PORT: String(port + 1500), ODC_DATA_DIR: dir, ODC_HA_INTERVAL_MS: '200',
    ODC_VIOFO_INTERVAL_MS: '3600000', ODC_EXIFTOOL: fakeExif, ODC_TRIP_INTERVAL_MS: '300', ODC_PUBLIC_URL: 'https://odc.example.com' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));
function client() {
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
const waitFor = async (fn, ms = 15_000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await sleep(200); } };

try {
  for (let i = 0; i < 50; i++) { try { await fetch(`${base}/api/setup`); break; } catch { await sleep(100); } }
  const web = client();
  await web('POST', '/api/setup', { username: 'admin', password: 'correct horse' });
  const car = (await web('POST', '/api/cars', { name: 'CX5' })).data;
  const code = (await web('POST', `/api/cars/${car.id}/pairing`, { label: 'Phone' })).data.code;
  const token = (await (await fetch(`${base}/api/v1/devices/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json()).token;
  const phone = (method, url, body) => fetch(base + url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  // ================= Home Assistant
  await web('PUT', '/api/settings', { mqttEnabled: true, mqttUrl: brokerUrl, mqttUsername: 'ha', mqttPassword: 'wrong' });
  await waitFor(async () => (await web('GET', '/api/integrations')).data.homeAssistant.error?.includes('username and password'));
  ok('wrong MQTT password is reported clearly');
  await web('PUT', '/api/settings', { mqttPassword: 'secret' });
  await waitFor(async () => (await web('GET', '/api/integrations')).data.homeAssistant.connected);
  const c = connects.at(-1);
  assert.equal(c.proto, 'MQTT'); assert.equal(c.level, 4); assert.equal(c.willTopic, 'opendashcam/status'); assert.equal(c.willMsg, 'offline'); assert.ok(c.willRetain);
  ok('connects with MQTT 3.1.1, credentials and an “offline” last will');
  await waitFor(() => last('opendashcam/status')?.payload === 'online');
  ok('announces itself online');
  const cfgTopics = ['device_tracker/odc_car_1/location', 'sensor/odc_car_1/speed', 'sensor/odc_car_1/last_seen', 'sensor/odc_car_1/battery',
    'binary_sensor/odc_car_1/recording', 'binary_sensor/odc_car_1/moving', 'event/odc_car_1/alert'].map((t) => `homeassistant/${t}/config`);
  await waitFor(() => cfgTopics.every((t) => last(t)));
  const tracker = JSON.parse(last(cfgTopics[0]).payload);
  assert.equal(tracker.device.name, 'CX5'); assert.deepEqual(tracker.device.identifiers, ['odc_car_1']); assert.equal(tracker.json_attributes_topic, 'opendashcam/car/1/location');
  assert.equal(tracker.configuration_url, undefined); assert.equal(tracker.device.configuration_url, 'https://odc.example.com/#/cars');
  assert.ok(cfgTopics.every((t) => last(t).retain)); ok('discovery creates a device with tracker, sensors and an event entity (retained)');
  const ev = JSON.parse(last(cfgTopics[6]).payload);
  assert.ok(ev.event_types.includes('impact') && ev.event_types.includes('arrived')); ok('event entity lists impact, arrival and other alert types');

  await phone('POST', '/api/v1/devices/me/heartbeat', { battery: 81, charging: true, recording: true, mode: 'driving' });
  await phone('POST', '/api/v1/live', { lat: 38.627, lon: -90.199, speed: 20, acc: 6 });
  await waitFor(() => last('opendashcam/car/1/location') && JSON.parse(last('opendashcam/car/1/state').payload).speed === 72);
  const loc = JSON.parse(last('opendashcam/car/1/location').payload);
  assert.deepEqual(loc, { latitude: 38.627, longitude: -90.199, gps_accuracy: 6 });
  const st = JSON.parse(last('opendashcam/car/1/state').payload);
  assert.equal(st.recording, true); assert.equal(st.moving, true); assert.equal(st.battery, 81); assert.ok(Date.parse(st.last_seen));
  ok('location and states arrive: 72 km/h, moving, recording, battery 81%');
  const nState = published.filter((p) => p.topic === 'opendashcam/car/1/state').length;
  await sleep(800);
  assert.equal(published.filter((p) => p.topic === 'opendashcam/car/1/state').length, nState); ok('unchanged states aren’t re-sent');

  await phone('POST', '/api/v1/events', { type: 'impact', message: '2.2 g jolt' });
  await waitFor(() => last('opendashcam/car/1/event'));
  const e = JSON.parse(last('opendashcam/car/1/event').payload);
  assert.equal(e.event_type, 'impact'); assert.equal(e.message, '2.2 g jolt'); assert.equal(e.camera, 'Phone'); assert.ok(!last('opendashcam/car/1/event').retain);
  ok('impact appears as a Home Assistant event (not retained)');

  for (const s of brokerSockets) s.destroy(); // broker restarts
  const before = connects.length;
  published.length = 0;
  await waitFor(() => connects.length > before && cfgTopics.every((t) => last(t)) && last('opendashcam/car/1/location'), 20_000);
  ok('reconnects after the broker drops and re-announces everything');

  assert.equal((await web('DELETE', `/api/cars/${car.id}?confirm=delete-footage`)).status, 200);
  await waitFor(() => last(cfgTopics[0])?.payload === '');
  ok('deleting a car removes its entities from Home Assistant');

  // ================= Viofo import
  const car2 = (await web('POST', '/api/cars', { name: 'Outback' })).data;
  let r = await web('PATCH', `/api/cars/${car2.id}`, { viofoUrl: camUrl.replace('http://', '') });
  assert.equal(r.status, 200);
  r = await web('GET', '/api/cars');
  assert.equal(r.data.find((x) => x.id === car2.id).viofoUrl, camUrl); ok('camera address saved (http:// added)');
  r = await web('POST', `/api/cars/${car2.id}/viofo/check`);
  assert.equal(r.data.files, 8); ok('camera check lists 8 recordings');
  const clipsOf = async () => (await web('GET', `/api/clips?car=${car2.id}&limit=100`)).data.clips;
  // First pass stops at the interrupted download; the next check resumes it.
  await waitFor(async () => /Stopped at|Up to date|Imported/.test((await web('GET', '/api/cars')).data.find((x) => x.id === car2.id).viofoStatus?.message || ''));
  await web('POST', `/api/cars/${car2.id}/viofo/check`);
  await waitFor(async () => (await clipsOf()).length === 5, 30_000);
  await sleep(500);
  const clips = await clipsOf();
  const names = clips.map((x) => x.fileName).sort();
  assert.deepEqual(names, ['2026_0915_080000_000101F.MP4', '2026_0915_080000_000101R.MP4', '2026_0915_080130_000301F.MP4', '2026_0915_080300_000102F.MP4', '2026_0915_120000_000201F.MP4']);
  ok('imports 5 of 8: the newest front, rear and parking clips are left until a newer one exists');
  assert.ok(rangeRequests.includes('2026_0915_080000_000101F.MP4')); ok('an interrupted download resumes where it stopped');
  const resumed = clips.find((x) => x.fileName === '2026_0915_080000_000101F.MP4');
  const orig = crypto.createHash('sha256').update(fs.readFileSync(clipFile(resumed.fileName))).digest('hex');
  const find = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? find(path.join(d, e.name)) : e.name === resumed.fileName ? [path.join(d, e.name)] : []));
  const stored = find(path.join(dir, 'library'));
  assert.equal(stored.length, 1); assert.ok(!fs.existsSync(`${stored[0]}.part`));
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(stored[0])).digest('hex'), orig); ok('the resumed file is intact (identical to the camera’s file)');
  const ro = clips.find((x) => x.fileName.includes('000301'));
  assert.ok(ro.locked); ok('event (RO) recordings arrive locked');
  assert.equal(clips.find((x) => x.fileName.includes('000201')).mode, 'parking'); ok('parking recordings are marked as parking');
  const cams = (await web('GET', '/api/cars')).data.find((x) => x.id === car2.id).cameras.map((x) => x.label).sort();
  assert.deepEqual(cams, ['Viofo Front', 'Viofo Rear']); ok('front and rear lenses become separate cameras');
  assert.ok(resumed.hasTrack); assert.equal(resumed.startedAt, Date.UTC(2026, 8, 15, 12, 0, 0)); ok('GPS from the video: has a track, and the start time comes from GPS (UTC)');
  await sleep(1500);
  const trips = (await web('GET', `/api/trips?car=${car2.id}`)).data;
  assert.ok(trips.length >= 1); ok('imported GPS forms trips');

  const n = (await clipsOf()).length;
  await web('POST', `/api/cars/${car2.id}/viofo/check`);
  await sleep(1500);
  assert.equal((await clipsOf()).length, n); ok('checking again doesn’t import anything twice');

  // HTML folder listing fallback, and a new recording appearing
  xmlWorks = false;
  camFiles.push(['Movie', '2026_0915_080900_000104F.MP4']);
  await web('POST', `/api/cars/${car2.id}/viofo/check`);
  await waitFor(async () => (await clipsOf()).some((x) => x.fileName === '2026_0915_080600_000103F.MP4'), 20_000);
  ok('works with the folder listings too, and imports the previous newest clip once a newer one exists');

  await web('PATCH', `/api/cars/${car2.id}`, { viofoUrl: '' });
  r = await web('GET', '/api/audit?action=Viofo');
  assert.ok(r.data.some((x) => x.action === 'Viofo import set up') && r.data.some((x) => x.action === 'Viofo import turned off')); ok('Viofo setup is in the activity log');

  console.log(`\nAll ${passed} checks passed.`);
} catch (err) {
  console.error('\nFAILED:', err);
  console.error('--- log ---\n' + log.slice(-3000));
  process.exitCode = 1;
} finally {
  server.kill();
  broker.close();
  for (const s of brokerSockets) s.destroy();
  camera.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
