// 1.6: per-person display preferences.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-test-16-'));
const port = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.js'], {
  env: { ...process.env, PORT: String(port), ODC_HTTPS_PORT: String(port + 1500), ODC_DATA_DIR: dir }, stdio: 'ignore',
});
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
    return { status: r.status, data: (r.headers.get('content-type') || '').includes('json') ? await r.json() : null };
  };
}
try {
  for (let i = 0; i < 50; i++) { try { await fetch(`${base}/api/setup`); break; } catch { await sleep(100); } }
  const a = client();
  await a('POST', '/api/setup', { username: 'admin', password: 'correct horse' });
  let r = await a('GET', '/api/me');
  assert.deepEqual(r.data.prefs, {}); ok('no preferences until chosen (defaults apply)');
  r = await a('PUT', '/api/me/prefs', { theme: 'light', accent: 'teal', textSize: 130, highContrast: true, reduceMotion: true });
  assert.deepEqual(r.data, { theme: 'light', accent: 'teal', textSize: 130, highContrast: true, reduceMotion: true }); ok('preferences saved');
  r = await a('PUT', '/api/me/prefs', { theme: 'neon', accent: '<script>', textSize: 999 });
  assert.deepEqual(r.data, { theme: 'dark', accent: 'orange', textSize: 100, highContrast: false, reduceMotion: false }); ok('invalid values fall back to defaults');
  await a('PUT', '/api/me/prefs', { theme: 'system', accent: 'purple', textSize: 115 });
  const b = client();
  await a('POST', '/api/users', { username: 'sam', password: 'password123' });
  await b('POST', '/api/login', { username: 'sam', password: 'password123' });
  assert.deepEqual((await b('GET', '/api/me')).data.prefs, {}); ok('each person has their own preferences');
  const again = client();
  await again('POST', '/api/login', { username: 'admin', password: 'correct horse' });
  assert.equal((await again('GET', '/api/me')).data.prefs.accent, 'purple'); ok('preferences follow the person to another browser');
  const css = await (await fetch(`${base}/style.css`)).text();
  assert.match(css, /data-theme="light"/); assert.match(css, /data-contrast="high"/); assert.match(css, /focus-visible/); ok('light theme, high contrast and focus styles are served');
  assert.equal((await fetch(`${base}/prefs.js`)).status, 200); ok('preferences script is served (applied before the page draws)');
  console.log(`\nAll ${passed} checks passed.`);
} catch (e) {
  console.error('\nFAILED:', e);
  process.exitCode = 1;
} finally {
  server.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
