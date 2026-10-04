import crypto from 'node:crypto';
import fs from 'node:fs';

/**
 * Decrypts Open Dash Cam .odcenc files (encrypted on the phone). Same format as the app's
 * OdcEncryption and tools/odc_decrypt.py: 53-byte header, then AES-256-GCM chunks.
 * The passphrase is only used for this request and never stored.
 */
const MAGIC = Buffer.from('ODCENC1\n', 'ascii');
const HEADER_LEN = 53;
const OVERHEAD = 28;

export class WrongPassphrase extends Error {}

export async function decryptFile(src, dst, passphrase) {
  const fd = fs.openSync(src, 'r');
  const out = fs.openSync(dst + '.tmp', 'w');
  try {
    const size = fs.fstatSync(fd).size;
    const header = Buffer.alloc(HEADER_LEN);
    fs.readSync(fd, header, 0, HEADER_LEN, 0);
    if (!header.subarray(0, 8).equals(MAGIC)) throw new Error('Not an encrypted ODC file');
    const salt = header.subarray(9, 25);
    const iterations = header.readUInt32BE(25);
    const chunk = header.readUInt32BE(29);
    const prefix = header.subarray(33, 37);
    if (iterations < 10_000 || iterations > 5_000_000 || chunk < 4096 || chunk > 64 * 1024 * 1024) throw new Error('Damaged header');
    const key = await new Promise((res, rej) => crypto.pbkdf2(passphrase, salt, iterations, 32, 'sha256', (e, k) => (e ? rej(e) : res(k))));
    const check = crypto.createHmac('sha256', key).update('ODC key check').digest().subarray(0, 16);
    if (!crypto.timingSafeEqual(check, header.subarray(37, 53))) throw new WrongPassphrase('Wrong passphrase');
    let pos = HEADER_LEN;
    let index = 0n;
    const buf = Buffer.alloc(chunk + OVERHEAD);
    while (pos < size) {
      const len = Math.min(size - pos, chunk + OVERHEAD);
      if (len < OVERHEAD) throw new Error('File is incomplete');
      fs.readSync(fd, buf, 0, len, pos);
      pos += len;
      const final = pos >= size;
      const nonce = buf.subarray(0, 12);
      const expected = Buffer.concat([prefix, Buffer.alloc(8)]);
      expected.writeBigUInt64BE(index, 4);
      if (!nonce.equals(expected)) throw new Error('Chunks out of order');
      const aad = Buffer.alloc(9);
      aad.writeBigUInt64BE(index, 0);
      aad[8] = final ? 1 : 0;
      const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
      d.setAAD(Buffer.concat([header, aad]));
      d.setAuthTag(buf.subarray(len - 16, len));
      const plain = Buffer.concat([d.update(buf.subarray(12, len - 16)), d.final()]);
      fs.writeSync(out, plain);
      index++;
    }
  } finally {
    fs.closeSync(fd);
    fs.closeSync(out);
  }
  fs.renameSync(dst + '.tmp', dst);
}
