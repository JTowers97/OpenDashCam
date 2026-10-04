// v0.9.0: retention per car and per person, decrypting phone-encrypted clips, browser notifications (Web Push), app sync data.
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-test-9-'));
const port = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let log = '';
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.js'], {
  env: { ...process.env, PORT: String(port), ODC_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));
let passed = 0;
const ok = (n) => { passed++; console.log('  ✓', n); };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function client() {
  let cookie = '';
  return async (method, url, body) => {
    const h = cookie ? { Cookie: cookie } : {};
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const r = await fetch(base + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, data: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
}

// ODC encryption format (mirror of the app's OdcEncryption), to create phone-encrypted clips.
function odcEncrypt(plain, passphrase, chunk = 4096) {
  const salt = crypto.randomBytes(16), prefix = crypto.randomBytes(4), it = 200000;
  const key = crypto.pbkdf2Sync(passphrase, salt, it, 32, 'sha256');
  const check = crypto.createHmac('sha256', key).update('ODC key check').digest().subarray(0, 16);
  const header = Buffer.alloc(53);
  Buffer.from('ODCENC1\n').copy(header, 0); header[8] = 1; salt.copy(header, 9);
  header.writeUInt32BE(it, 25); header.writeUInt32BE(chunk, 29); prefix.copy(header, 33); check.copy(header, 37);
  const n = Math.max(1, Math.ceil(plain.length / chunk));
  const parts = [header];
  for (let i = 0; i < n; i++) {
    const nonce = Buffer.concat([prefix, Buffer.alloc(8)]); nonce.writeBigUInt64BE(BigInt(i), 4);
    const aad = Buffer.alloc(9); aad.writeBigUInt64BE(BigInt(i)); aad[8] = i === n - 1 ? 1 : 0;
    const c = crypto.createCipheriv('aes-256-gcm', key, nonce); c.setAAD(Buffer.concat([header, aad]));
    parts.push(nonce, c.update(plain.subarray(i * chunk, (i + 1) * chunk)), c.final(), c.getAuthTag());
  }
  return Buffer.concat(parts);
}

// A fake browser push service, decrypting like a browser (RFC 8291) and checking the VAPID signature (RFC 8292).
const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
const uaAuth = crypto.randomBytes(16);
const received = [];
let pushStatus = 201;
const pushServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    received.push({ headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(pushStatus); res.end();
  });
});
await new Promise((r) => pushServer.listen(0, '127.0.0.1', r));
const pushUrl = `http://127.0.0.1:${pushServer.address().port}/push/abc`;
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
function browserDecrypt(body) {
  const salt = body.subarray(0, 16); const idlen = body[20]; const asPublic = body.subarray(21, 21 + idlen); const ct = body.subarray(21 + idlen);
  const shared = ua.computeSecret(asPublic);
  const ikm = hmac(hmac(uaAuth, shared), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2);
  return JSON.parse(plain.subarray(0, plain.length - 1).toString());
}
function verifyVapid(authHeader) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(authHeader);
  const [h, c, s] = m[1].split('.');
  const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: Buffer.from(m[2], 'base64url').subarray(1, 33).toString('base64url'), y: Buffer.from(m[2], 'base64url').subarray(33).toString('base64url') }, format: 'jwk' });
  const valid = crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
  return { valid, claims: JSON.parse(Buffer.from(c, 'base64url')) };
}

try {
  for (let i = 0; i < 50; i++) { try { await fetch(`${base}/api/setup`); break; } catch { await sleep(100); } }
  const web = client();
  await web('POST', '/api/setup', { username: 'admin', password: 'correct horse' });
  const carA = (await web('POST', '/api/cars', { name: 'Alpha' })).data;
  const carB = (await web('POST', '/api/cars', { name: 'Bravo' })).data;
  const pair = async (car) => {
    const code = (await web('POST', `/api/cars/${car.id}/pairing`, { label: 'Front' })).data.code;
    const tok = (await (await fetch(`${base}/api/v1/devices/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json()).token;
    return async (method, url, body, headers = {}) => {
      const h = { Authorization: `Bearer ${tok}`, ...headers };
      let payload = body;
      if (body !== undefined && !(body instanceof Uint8Array)) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
      const r = await fetch(base + url, { method, headers: h, body: payload });
      return { status: r.status, data: r.status !== 204 && (r.headers.get('content-type') || '').includes('json') ? await r.json() : null };
    };
  };
  const phoneA = await pair(carA);
  const phoneB = await pair(carB);
  let n = 0;
  const upload = async (phone, startedAt, extra = {}, bytes) => {
    const f = path.join(dir, `v${n++}.mp4`);
    if (!bytes) {
      execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=5', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-metadata', `comment=${n}`, f]);
      bytes = fs.readFileSync(f);
    }
    const up = (await phone('POST', '/api/v1/uploads', { fileName: extra.fileName || `c${n}.mp4`, sizeBytes: bytes.length, sha256: sha(bytes), startedAt, ...extra })).data;
    await phone('PATCH', `/api/v1/uploads/${up.id}`, bytes, { 'Upload-Offset': '0' });
    assert.equal((await phone('POST', `/api/v1/uploads/${up.id}/complete`)).status, 200);
    return up.id;
  };
  const now = Date.now();
  const aOld = await upload(phoneA, now - 3 * 86400_000);
  const aNew = await upload(phoneA, now - 3600_000);
  const bOld = await upload(phoneB, now - 3 * 86400_000);
  const bOld2 = await upload(phoneB, now - 2 * 86400_000);
  const bNew = await upload(phoneB, now - 600_000);
  const ids = async () => new Set((await web('GET', '/api/clips?limit=500')).data.clips.map((c) => c.id));

  // ---- retention per car
  await web('PATCH', `/api/cars/${carA.id}`, { retentionDays: 1 });
  let s = await ids();
  assert.ok(!s.has(aOld) && s.has(aNew)); assert.ok(s.has(bOld)); ok('car retention removes only that car’s old clips');
  let r = await web('GET', '/api/cars');
  assert.equal(r.data.find((c) => c.id === carA.id).retentionDays, 1); ok('car shows its retention setting');
  // Car with "keep forever" overrides a server default
  await web('PUT', '/api/settings', { retentionDays: 1 });
  await web('PATCH', `/api/cars/${carB.id}`, { retentionDays: 0 });
  s = await ids();
  assert.ok(s.has(bOld)); ok('"keep forever" on a car overrides the server default');
  await web('PUT', '/api/settings', { retentionDays: 0 });

  // ---- size limit per car (locked clips are kept)
  await web('PATCH', `/api/clips/${bOld}`, { locked: true });
  const bSizes = (await web('GET', `/api/clips?car=${carB.id}`)).data.clips;
  const total = bSizes.reduce((a, c) => a + c.size, 0);
  await web('PATCH', `/api/cars/${carB.id}`, { storageCapGb: (total - 10) / 1024 ** 3 });
  s = await ids();
  assert.ok(s.has(bOld) && !s.has(bOld2) && s.has(bNew)); ok('car size limit removes the oldest unlocked clip, keeps locked');

  // ---- size limit per person
  const before = (await web('GET', '/api/users')).data[0];
  assert.ok(before.usedBytes > 0); ok(`people list shows storage used (${before.usedBytes} bytes)`);
  await web('PATCH', `/api/users/${before.id}`, { quotaGb: 1e-9 });
  s = await ids();
  assert.ok(!s.has(aNew) && !s.has(bNew) && s.has(bOld)); ok('person’s limit removes unlocked clips across their cars');
  await web('PATCH', `/api/users/${before.id}`, { quotaGb: null });
  await web('PATCH', `/api/cars/${carB.id}`, { storageCapGb: null });

  // ---- phone-encrypted clip: play on the server with the passphrase
  const plainFile = path.join(dir, 'secret.mp4');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=5', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-metadata', 'comment=secret', plainFile]);
  const plain = fs.readFileSync(plainFile);
  const enc = odcEncrypt(plain, 'hunter2 hunter2');
  const encId = await upload(phoneA, now - 60_000, { fileName: 'ODC_secret_rear.odcenc', encrypted: true }, enc);
  r = await web('GET', `/api/clips/${encId}/stream`);
  assert.equal(r.status, 415); ok('encrypted clip needs the passphrase');
  r = await web('POST', `/api/clips/${encId}/decrypt`, { passphrase: 'wrong one' });
  assert.equal(r.status, 400); ok('wrong passphrase rejected');
  r = await web('POST', `/api/clips/${encId}/decrypt`, { passphrase: 'hunter2 hunter2' });
  assert.equal(r.status, 200);
  const played = await web('GET', r.data.streamUrl);
  assert.ok(played.data.equals(plain)); ok('decrypted with the right passphrase; playback matches the original exactly');
  assert.ok(!(await web('GET', '/api/settings')).data.passphrase); ok('passphrase is not stored');

  // ---- browser notifications
  r = await web('GET', '/api/push/key');
  assert.equal(Buffer.from(r.data.publicKey, 'base64url').length, 65); ok('server has a VAPID public key');
  r = await web('POST', '/api/push/subscribe', { endpoint: pushUrl, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: uaAuth.toString('base64url') } });
  assert.equal(r.status, 200);
  r = await web('POST', '/api/push/test');
  assert.equal(r.data.sent, 1);
  let msg = received.at(-1);
  assert.equal(msg.headers['content-encoding'], 'aes128gcm');
  const v = verifyVapid(msg.headers.authorization);
  assert.ok(v.valid); assert.equal(v.claims.aud, new URL(pushUrl).origin); ok('push request is VAPID-signed (signature verified)');
  assert.equal(browserDecrypt(msg.body).body, 'Notifications work in this browser.'); ok('payload decrypts as a browser would (RFC 8291)');
  await phoneA('POST', '/api/v1/events', { type: 'impact', message: '2.4 g' });
  await sleep(500);
  msg = received.at(-1);
  const payload = browserDecrypt(msg.body);
  assert.match(payload.title, /Alpha.*Impact/); ok(`impact alert delivered to the browser: "${payload.title}"`);
  pushStatus = 410;
  await web('POST', '/api/push/test');
  r = await web('POST', '/api/push/test');
  assert.equal(r.status, 400); ok('expired subscriptions (410) are removed');

  // ---- app synced playback data
  const sync = await phoneA('GET', `/api/v1/sync?from=${now - 7200_000}&to=${now}`);
  assert.equal(sync.status, 200); assert.ok(Array.isArray(sync.data.cameras));
  assert.ok(sync.data.clips.every((c) => c.streamUrl.includes('?st='))); ok('app gets synced-playback data with stream links');

  console.log(`\nAll ${passed} checks passed.`);
} catch (e) {
  console.error('\nFAILED:', e);
  console.error('--- log ---\n' + log.slice(-3000));
  process.exitCode = 1;
} finally {
  server.kill();
  pushServer.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
