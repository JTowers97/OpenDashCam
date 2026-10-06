import crypto from 'node:crypto';
import { HttpError, now, parseCookies, randomToken, sha256hex } from './util.js';
import { getMeta, setMeta } from './db.js';

const SESSION_COOKIE = 'odc_session';
const SESSION_DAYS = 30;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const N = 16384, r = 8, p = 1;
  const hash = crypto.scryptSync(password, salt, 64, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [algo, N, r, p, saltB64, hashB64] = stored.split('$');
    if (algo !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'Passwords need at least 8 characters.');
}

/** A sign-in. App sign-ins (Command Center) last a year and show the phone's name in Signed-in devices. */
export function createSession(db, userId, ctx = null, { app = false, deviceName = null } = {}) {
  const token = randomToken();
  const t = now();
  const label = app ? `ODC app${deviceName ? ` on ${String(deviceName).slice(0, 80)}` : ''}` : ctx ? String(ctx.req.headers['user-agent'] || '').slice(0, 300) : null;
  db.run('INSERT INTO sessions(token_hash, user_id, created_at, expires_at, user_agent, ip, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sha256hex(token), userId, t, t + (app ? 365 : SESSION_DAYS) * 86400_000, label, ctx?.ip ?? null, t);
  return token;
}

/** Short public id for a session (never the token itself). */
export const sessionId = (tokenHash) => tokenHash.slice(0, 16);

export function currentSessionHash(req) {
  const token = sessionToken(req);
  return token ? sha256hex(token) : null;
}

export function sessionCookie(token, secure) {
  const attrs = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${SESSION_DAYS * 86400}`];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/** The session token: the browser's cookie, or the app's "Authorization: Bearer" header. */
export function sessionToken(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : parseCookies(req)[SESSION_COOKIE];
}

export function userFromRequest(db, req) {
  const token = sessionToken(req);
  if (!token) return null;
  const hash = sha256hex(token);
  const row = db.get(
    `SELECT u.id, u.username, u.is_admin, s.last_used_at FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`, hash, now());
  if (!row) return null;
  if (!row.last_used_at || now() - row.last_used_at > 5 * 60_000) db.run('UPDATE sessions SET last_used_at = ? WHERE token_hash = ?', now(), hash);
  return { id: row.id, username: row.username, isAdmin: row.is_admin === 1 };
}

export function destroySession(db, req) {
  const token = sessionToken(req);
  if (token) db.run('DELETE FROM sessions WHERE token_hash = ?', sha256hex(token));
}

/** Phones authenticate with "Authorization: Bearer <device token>". */
export function cameraFromRequest(db, req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  return db.get(
    `SELECT c.*, k.name AS car_name FROM cameras c JOIN cars k ON k.id = c.car_id WHERE c.token_hash = ?`,
    sha256hex(h.slice(7).trim())) || null;
}

// ---- Pairing codes: 8 characters without look-alikes, single use, 10 minutes.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newPairingCode() {
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s;
}
export const normalizeCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// ---- Stream tokens let video players (which can't send headers) fetch one clip for a while.
function secret(db) {
  let s = getMeta(db, 'stream_secret');
  if (!s) {
    s = randomToken(32);
    setMeta(db, 'stream_secret', s);
  }
  return s;
}

export function streamToken(db, clipId, ttlMs = 6 * 3600_000) {
  const exp = now() + ttlMs;
  const sig = crypto.createHmac('sha256', secret(db)).update(`${clipId}.${exp}`).digest('base64url');
  return `${exp}.${sig}`;
}

export function checkStreamToken(db, clipId, token) {
  const [expStr, sig] = String(token || '').split('.');
  const exp = Number(expStr);
  if (!exp || exp < now() || !sig) return false;
  const expected = crypto.createHmac('sha256', secret(db)).update(`${clipId}.${exp}`).digest('base64url');
  return expected.length === sig.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

// ---- Car access: owners and users the car is shared with. Admins manage accounts, not other people's footage.
export function carRole(db, user, carId) {
  const car = db.get('SELECT owner_id FROM cars WHERE id = ?', carId);
  if (!car) return null;
  if (car.owner_id === user.id) return 'owner';
  return db.get('SELECT role FROM car_shares WHERE car_id = ? AND user_id = ?', carId, user.id)?.role || null;
}

export function requireCarRole(db, user, carId, needManage = false) {
  const role = carRole(db, user, carId);
  if (!role) throw new HttpError(404, 'Car not found');
  if (needManage && role === 'viewer') throw new HttpError(403, 'You can view this car but not change it.');
  return role;
}

export function visibleCarIds(db, user) {
  return db.all(
    `SELECT id FROM cars WHERE owner_id = ? UNION SELECT car_id AS id FROM car_shares WHERE user_id = ?`,
    user.id, user.id).map((r) => r.id);
}

// ---- Simple login throttling per IP.
const attempts = new Map();
export function checkLoginRate(ip) {
  const t = now();
  const a = (attempts.get(ip) || []).filter((x) => t - x < 15 * 60_000);
  attempts.set(ip, a);
  if (a.length >= 10) throw new HttpError(429, 'Too many login attempts. Try again in 15 minutes.');
}
export function recordLoginFailure(ip) {
  const a = attempts.get(ip) || [];
  a.push(now());
  attempts.set(ip, a);
}
