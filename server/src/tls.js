import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Built-in HTTPS. On first start the server creates its own certificate (ECDSA P-256, valid 20 years) in
 * /data/tls. Browsers will warn about it once (it isn't from a public authority); phones don't, because the
 * pairing QR code carries the certificate's fingerprint and the app trusts exactly that certificate.
 * To use your own certificate instead, replace cert.pem and key.pem and restart.
 */

// ---- minimal DER encoding, enough for one X.509 certificate
const len = (n) => (n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]));
const tlv = (tag, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), len(body.length), body]); };
const seq = (...p) => tlv(0x30, ...p);
const set = (...p) => tlv(0x31, ...p);
const int = (buf) => tlv(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf);
const oid = (s) => {
  const p = s.split('.').map(Number);
  const out = [40 * p[0] + p[1]];
  for (const v of p.slice(2)) {
    const bytes = [];
    let x = v;
    do { bytes.unshift(x & 0x7f); x = Math.floor(x / 128); } while (x > 0);
    for (let i = 0; i < bytes.length - 1; i++) bytes[i] |= 0x80;
    out.push(...bytes);
  }
  return tlv(0x06, Buffer.from(out));
};
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const time = (d) => {
  const s = d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(s.slice(2))) : tlv(0x18, Buffer.from(s));
};
const ctx = (n, ...p) => tlv(0xa0 + n, ...p);
const octet = (...p) => tlv(0x04, ...p);
const bits = (buf) => tlv(0x03, Buffer.from([0]), buf);

function makeCertificate(privateKey, publicKey, hosts) {
  const ecdsaSha256 = seq(oid('1.2.840.10045.4.3.2'));
  const name = seq(set(seq(oid('2.5.4.3'), utf8('Open Dash Cam'))));
  const now = new Date();
  const notBefore = new Date(now.getTime() - 86400_000);
  const notAfter = new Date(now.getTime() + 20 * 365 * 86400_000);
  const san = hosts.map((h) => (/^\d+\.\d+\.\d+\.\d+$/.test(h)
    ? tlv(0x87, Buffer.from(h.split('.').map(Number)))   // iPAddress
    : tlv(0x82, Buffer.from(h, 'ascii'))));               // dNSName
  const extensions = ctx(3, seq(
    seq(oid('2.5.29.17'), octet(seq(...san))),                                    // subjectAltName
    seq(oid('2.5.29.19'), tlv(0x01, Buffer.from([0xff])), octet(seq())),          // basicConstraints: not a CA (critical)
  ));
  const tbs = seq(
    ctx(0, int(Buffer.from([2]))),                      // v3
    int(crypto.randomBytes(16)),                        // serial
    ecdsaSha256,
    name,
    seq(time(notBefore), time(notAfter)),
    name,
    publicKey.export({ format: 'der', type: 'spki' }),
    extensions,
  );
  const signature = crypto.sign('sha256', tbs, privateKey); // DER-encoded ECDSA signature
  return seq(tbs, ecdsaSha256, bits(signature));
}

const pem = (label, der) => `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;

/** Loads (or creates) the certificate. Returns { key, cert, fingerprint } where fingerprint is SHA-256 of the DER, base64url. */
export function loadTls(dataDir) {
  const dir = path.join(dataDir, 'tls');
  const certFile = path.join(dir, 'cert.pem');
  const keyFile = path.join(dir, 'key.pem');
  if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
    fs.mkdirSync(dir, { recursive: true });
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const der = makeCertificate(privateKey, publicKey, ['localhost', '127.0.0.1', 'opendashcam']);
    fs.writeFileSync(keyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    fs.writeFileSync(certFile, pem('CERTIFICATE', der));
  }
  const cert = fs.readFileSync(certFile, 'utf8');
  const key = fs.readFileSync(keyFile, 'utf8');
  const der = new crypto.X509Certificate(cert).raw;
  return { cert, key, fingerprint: crypto.createHash('sha256').update(der).digest('base64url') };
}
