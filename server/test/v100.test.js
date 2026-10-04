// 1.0: built-in HTTPS, security headers, HTTPS-only mode, signed-in devices, audit log, backups.
import { spawn } from 'node:child_process';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-test-10-'));
const port = 18000 + Math.floor(Math.random() * 1000);
const httpsPort = port + 1500;
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let log = '';
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.js'], {
  env: { ...process.env, PORT: String(port), ODC_HTTPS_PORT: String(httpsPort), ODC_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));
let passed = 0;
const ok = (n) => { passed++; console.log('  ✓', n); };

function client() {
  let cookie = '';
  const c = async (method, url, body, extra = {}) => {
    const h = { ...(cookie ? { Cookie: cookie } : {}), ...extra };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const r = await fetch(base + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, headers: r.headers, data: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  c.cookie = () => cookie;
  return c;
}
// HTTPS request that accepts the self-signed certificate and reports its fingerprint (as the app does by pinning).
function httpsGet(p) {
  return new Promise((resolve, reject) => {
    const req = https.get({ host: '127.0.0.1', port: httpsPort, path: p, rejectUnauthorized: false }, (res) => {
      const der = res.socket.getPeerCertificate().raw;
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, fp: crypto.createHash('sha256').update(der).digest('base64url'), body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
  });
}

try {
  for (let i = 0; i < 50; i++) { try { await fetch(`${base}/api/setup`); break; } catch { await sleep(100); } }
  await sleep(300);
  const admin = client();
  await admin('POST', '/api/setup', { username: 'admin', password: 'correct horse' });

  // ---- security headers
  let r = await admin('GET', '/');
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff'); ok('security headers on pages');
  r = await admin('GET', '/api/me');
  assert.ok(r.headers.get('content-security-policy')); ok('…and on API responses');

  // ---- built-in HTTPS + pairing pin
  await admin('PUT', '/api/settings', { homeUrl: `https://192.168.1.50:${httpsPort}/` });
  const car = (await admin('POST', '/api/cars', { name: 'CX5' })).data;
  r = await admin('POST', `/api/cars/${car.id}/pairing`, { label: 'Front' });
  const qr = JSON.parse(r.data.qr);
  assert.equal(qr.home, `https://192.168.1.50:${httpsPort}`); assert.ok(qr.fp); ok('pairing QR includes the home address and certificate fingerprint');
  const h = await httpsGet('/api/setup');
  assert.equal(h.status, 200); assert.equal(h.fp, qr.fp); ok('HTTPS port serves the certificate the QR code pins');
  assert.match(log, new RegExp(`fingerprint ${qr.fp}`)); ok('fingerprint is printed in the server log');

  // ---- HTTPS-only mode
  await admin('PUT', '/api/settings', { httpsOnly: true });
  r = await admin('GET', '/timeline');
  assert.equal(r.status, 308); assert.equal(r.headers.get('location'), `https://127.0.0.1:${httpsPort}/timeline`); ok('browsers on http:// are redirected to HTTPS');
  r = await fetch(`${base}/api/v1/time`);
  assert.equal(r.status, 200); ok('phone API is not redirected (phones keep working)');
  const hs = await httpsGet('/');
  assert.match(hs.headers['strict-transport-security'], /max-age=/); ok('HSTS sent over HTTPS in HTTPS-only mode');
  r = await fetch(`${base}/api/me`, { headers: { 'X-Forwarded-Proto': 'https', Cookie: admin.cookie() } });
  assert.equal(r.status, 200); ok('requests through an HTTPS reverse proxy are not redirected');
  await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'X-Forwarded-Proto': 'https', Cookie: admin.cookie(), 'Content-Type': 'application/json' }, body: JSON.stringify({ httpsOnly: false }) });

  // ---- signed-in devices
  const laptop = client();
  await laptop('POST', '/api/login', { username: 'admin', password: 'correct horse' }, { 'User-Agent': 'Laptop browser' });
  r = await admin('GET', '/api/me/sessions');
  assert.equal(r.data.length, 2); assert.equal(r.data.filter((s) => s.current).length, 1); assert.ok(r.data.some((s) => s.userAgent === 'Laptop browser'));
  ok('signed-in devices listed, current one marked');
  const other = r.data.find((s) => !s.current);
  await admin('DELETE', `/api/me/sessions/${other.id}`);
  r = await laptop('GET', '/api/me');
  assert.equal(r.status, 401); ok('signing out another device works');
  await laptop('POST', '/api/login', { username: 'admin', password: 'correct horse' });
  r = await admin('POST', '/api/me/sessions/sign-out-others');
  assert.equal(r.data.signedOut, 1);
  assert.equal((await laptop('GET', '/api/me')).status, 401); ok('"sign out all other devices" works');
  await laptop('POST', '/api/login', { username: 'admin', password: 'correct horse' });
  await admin('PUT', '/api/me/password', { current: 'correct horse', password: 'battery staple' });
  assert.equal((await laptop('GET', '/api/me')).status, 401); assert.equal((await admin('GET', '/api/me')).status, 200);
  ok('changing the password signs out other devices, keeps this one');

  // ---- audit log
  await client()('POST', '/api/login', { username: 'admin', password: 'nope' });
  await admin('POST', '/api/users', { username: 'sam', password: 'password123' });
  r = await admin('GET', '/api/audit');
  const actions = r.data.map((e) => e.action);
  for (const a of ['setup', 'sign-in', 'sign-in failed', 'server settings changed', 'pairing code created', 'signed out a device', 'password changed', 'person added']) {
    assert.ok(actions.includes(a), `missing ${a}`);
  }
  ok(`audit log records sign-ins, failures, settings, pairing, devices, people (${r.data.length} entries)`);
  assert.ok(r.data.some((e) => e.action === 'server settings changed' && /homeUrl: "" → "https:\/\/192\.168\.1\.50/.test(e.detail))); ok('settings changes show what changed, old → new');
  const sam = client();
  await sam('POST', '/api/login', { username: 'sam', password: 'password123' });
  r = await sam('GET', '/api/audit');
  assert.ok(r.data.length > 0 && r.data.every((e) => e.user === 'sam')); ok('people who aren’t admins see only their own entries');

  // ---- backups
  r = await admin('POST', '/api/backups');
  assert.equal(r.status, 201);
  const file = path.join(dir, 'backups', r.data.name);
  const copy = new DatabaseSync(file, { readOnly: true });
  assert.equal(copy.prepare('SELECT COUNT(*) n FROM users').get().n, 2); copy.close(); ok('backup is a complete, readable database');
  await admin('PUT', '/api/settings', { backupKeep: 2 });
  for (let i = 0; i < 3; i++) { await sleep(1100); await admin('POST', '/api/backups'); }
  r = await admin('GET', '/api/backups');
  assert.ok(r.data.length <= 2); ok('only the newest backups are kept');
  r = await sam('GET', '/api/backups');
  assert.equal(r.status, 403); ok('only admins can see or download backups');
  r = await admin('GET', `/api/backups/${(await admin('GET', '/api/backups')).data[0].name}`);
  assert.equal(r.status, 200); assert.equal(r.data.subarray(0, 15).toString(), 'SQLite format 3'); ok('admin can download a backup');

  console.log(`\nAll ${passed} checks passed.`);
} catch (e) {
  console.error('\nFAILED:', e);
  console.error('--- log ---\n' + log.slice(-3000));
  process.exitCode = 1;
} finally {
  server.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
