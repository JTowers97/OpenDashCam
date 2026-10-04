import crypto from 'node:crypto';
import { getMeta, setMeta } from './db.js';

/**
 * Browser notifications using the Web Push standard (RFC 8030/8291/8292): VAPID-signed requests and
 * aes128gcm-encrypted payloads, sent to the push service of each subscribed browser. Works while the
 * web app is closed. Browsers only allow it on HTTPS (or localhost).
 */
const b64u = (buf) => Buffer.from(buf).toString('base64url');

/** The server's VAPID key pair, created once. */
export function vapidKeys(db) {
  let pub = getMeta(db, 'vapid_public');
  let priv = getMeta(db, 'vapid_private');
  if (!pub || !priv) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    pub = b64u(publicKey.export({ format: 'der', type: 'spki' }).subarray(-65)); // raw uncompressed point
    priv = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    setMeta(db, 'vapid_public', pub);
    setMeta(db, 'vapid_private', priv);
  }
  return { publicKey: pub, privateKey: priv };
}

function vapidHeader(db, endpoint, subject) {
  const { publicKey, privateKey } = vapidKeys(db);
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${publicKey}`;
}

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** RFC 8291 payload encryption (aes128gcm). */
export function encryptPayload(payload, p256dhB64, authB64) {
  const uaPublic = Buffer.from(p256dhB64, 'base64url');
  const auth = Buffer.from(authB64, 'base64url');
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(auth, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const salt = crypto.randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/** Sends a notification to one subscription. Returns false if the subscription is gone. */
export async function sendPush(db, sub, message, subject) {
  const body = encryptPayload(JSON.stringify(message), sub.p256dh, sub.auth);
  const r = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidHeader(db, sub.endpoint, subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: message.urgent ? 'high' : 'normal',
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (r.status === 404 || r.status === 410) return false;
  if (!r.ok) throw new Error(`push service responded ${r.status}`);
  return true;
}
