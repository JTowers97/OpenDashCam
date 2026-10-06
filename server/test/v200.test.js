// 2.0: remote settings for dashcam phones.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-test-20-'));
const port = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (n) => { passed++; console.log('  ✓', n); };
let log = '';
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.js'], {
  env: { ...process.env, PORT: String(port), ODC_HTTPS_PORT: String(port + 1500), ODC_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));
const post = (url, body, headers = {}) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const signIn = async (username, password) => {
  const key = (await (await post('/api/login', { username, password, app: true, deviceName: 'Pixel 8' })).json()).token;
  return async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
};

try {
  for (let i = 0; i < 50; i++) { try { await fetch(`${base}/api/setup`); break; } catch { await sleep(100); } }
  await post('/api/setup', { username: 'admin', password: 'correct horse' });
  const cc = await signIn('admin', 'correct horse');
  const car = (await cc('POST', '/api/cars', { name: 'CX5' })).data;
  const code = (await cc('POST', `/api/cars/${car.id}/pairing`, { label: 'Old phone' })).data.code;
  const phone = { Authorization: `Bearer ${(await (await post('/api/v1/devices/pair', { code })).json()).token}` };
  const cam = (await cc('GET', '/api/cars')).data[0].cameras[0];
  const exchange = async (settings, applied) => (await post('/api/v1/devices/me/settings', { settings, applied }, phone)).json();

  let r = await cc('GET', `/api/cameras/${cam.id}/settings`);
  assert.equal(r.data.reported, null); assert.ok(r.data.spec.length >= 15); ok(`before the phone checks in: no settings yet (${r.data.spec.length} settings can be changed remotely)`);
  const phoneSettings = { resolution: 1080, overlayEnabled: false, parkingEnabled: true, batteryCutoff: 15, notAllowed: 'x' };
  let x = await exchange(phoneSettings, 0);
  assert.equal(x.changes, undefined);
  r = await cc('GET', `/api/cameras/${cam.id}/settings`);
  assert.deepEqual(r.data.reported, { resolution: 1080, overlayEnabled: false, parkingEnabled: true, batteryCutoff: 15 }); ok('the phone reports its settings (only the remotely changeable ones are kept)');

  assert.equal((await cc('PUT', `/api/cameras/${cam.id}/settings`, { changes: { audioEnabled: true } })).status, 400); ok('settings outside the list (like audio recording) can’t be changed remotely');
  assert.equal((await cc('PUT', `/api/cameras/${cam.id}/settings`, { changes: { resolution: 999 } })).status, 400); ok('invalid values are refused');
  r = await cc('PUT', `/api/cameras/${cam.id}/settings`, { changes: { overlayEnabled: true, resolution: 1440 } });
  assert.deepEqual(r.data.pending, { overlayEnabled: true, resolution: 1440 }); ok('changes wait for the phone (shown as pending)');
  r = await cc('PUT', `/api/cameras/${cam.id}/settings`, { changes: { batteryCutoff: 20 } });
  assert.deepEqual(r.data.pending, { overlayEnabled: true, resolution: 1440, batteryCutoff: 20 }); ok('further changes add to what’s waiting');

  x = await exchange(phoneSettings, 0);
  assert.deepEqual(x.changes, { overlayEnabled: true, resolution: 1440, batteryCutoff: 20 }); ok('the phone gets them at its next check-in');
  await exchange({ ...phoneSettings, overlayEnabled: true, resolution: 1440, batteryCutoff: 20 }, x.version);
  r = await cc('GET', `/api/cameras/${cam.id}/settings`);
  assert.equal(r.data.pending, null); assert.equal(r.data.reported.resolution, 1440); ok('once applied, nothing is pending and the new values show');
  x = await exchange(r.data.reported, x.version);
  assert.equal(x.changes, undefined); ok('they aren’t sent again');

  await cc('POST', '/api/users', { username: 'sam', password: 'password123' });
  await cc('POST', `/api/cars/${car.id}/shares`, { username: 'sam', role: 'viewer' });
  const sam = await signIn('sam', 'password123');
  assert.equal((await sam('PUT', `/api/cameras/${cam.id}/settings`, { changes: { parkingEnabled: false } })).status, 403); ok('people with view-only access can’t change a phone’s settings');
  r = await cc('GET', '/api/audit?action=phone settings');
  assert.ok(r.data.some((e) => /Date\/time stamp: true/.test(e.detail))); ok('changes are in the activity log');
  console.log(`\nAll ${passed} checks passed.`);
} catch (e) {
  console.error('\nFAILED:', e);
  console.error('--- log ---\n' + log.slice(-3000));
  process.exitCode = 1;
} finally {
  server.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
