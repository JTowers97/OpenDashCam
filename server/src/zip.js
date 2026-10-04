import fs from 'node:fs';
import zlib from 'node:zlib';

/**
 * Streams a ZIP file (stored, not compressed: video doesn't compress) to a writable stream.
 * Files are read once; CRCs are computed while streaming and written in data descriptors.
 * Classic ZIP format, so the total must stay under 4 GB (checked by the caller).
 */
export async function writeZip(out, entries /* [{ name, path }] */) {
  let failed = null;
  out.on('error', (e) => { failed = e; });
  const write = (buf) => {
    if (failed) throw failed; // e.g. the browser cancelled the download
    return out.write(buf) ? Promise.resolve() : new Promise((res) => out.once('drain', res));
  };
  const central = [];
  let offset = 0;
  const { time, date } = dosTime(new Date());
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0808, 6);          // data descriptor follows; UTF-8 names
    local.writeUInt16LE(0, 8);               // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt16LE(name.length, 26);
    await write(local);
    await write(name);
    let crc = 0;
    let size = 0;
    for await (const chunk of fs.createReadStream(e.path, { highWaterMark: 1 << 20 })) {
      crc = zlib.crc32(chunk, crc);
      size += chunk.length;
      await write(chunk);
    }
    const desc = Buffer.alloc(16);
    desc.writeUInt32LE(0x08074b50, 0);
    desc.writeUInt32LE(crc >>> 0, 4);
    desc.writeUInt32LE(size, 8);
    desc.writeUInt32LE(size, 12);
    await write(desc);
    central.push({ name, crc, size, offset, time, date });
    offset += 30 + name.length + size + 16;
  }
  const cdStart = offset;
  for (const c of central) {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(20, 6);
    h.writeUInt16LE(0x0808, 8);
    h.writeUInt16LE(0, 10);
    h.writeUInt16LE(c.time, 12);
    h.writeUInt16LE(c.date, 14);
    h.writeUInt32LE(c.crc >>> 0, 16);
    h.writeUInt32LE(c.size, 20);
    h.writeUInt32LE(c.size, 24);
    h.writeUInt16LE(c.name.length, 28);
    h.writeUInt32LE(c.offset, 42);
    await write(h);
    await write(c.name);
    offset += 46 + c.name.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(offset - cdStart, 12);
  end.writeUInt32LE(cdStart, 16);
  await write(end);
  out.end();
}

export const ZIP_LIMIT = 4 * 1024 ** 3 - 64 * 1024 * 1024; // leave room for headers

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}
