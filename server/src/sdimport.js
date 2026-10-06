import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { audit } from './audit.js';
import { startJob } from './jobs.js';
import { HttpError, now, readJson, send } from './util.js';
import { alreadyImported, cameraFor, destFor, folderOfPath, parseName, storeRecording } from './viofo.js';

/**
 * Importing footage straight from a dashcam's memory card: copy the card's files into data/import on the server
 * (or upload them from the browser), then import them into a car. Each recording goes through the same steps as Wi-Fi
 * import: GPS read from the video, event recordings locked, parking recordings marked, one camera per lens, and
 * anything already imported (by Wi-Fi or an earlier import) is skipped.
 */
export const importDir = () => path.join(config.dataDir, 'import');
const VIDEO = /\.(mp4|ts|mov)$/i;

function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else if (VIDEO.test(e.name) && !e.name.endsWith('.part')) out.push({ abs: p, rel: path.relative(base, p).split(path.sep).join('/') });
  }
  return out;
}

/** Folder names in data/import, made safe (no "..", no absolute paths). */
function safeFolder(name) {
  const clean = String(name || '').replace(/\\/g, '/').split('/').filter((s) => s && s !== '.' && s !== '..').join('/');
  const abs = path.join(importDir(), clean);
  if (!abs.startsWith(importDir())) throw new HttpError(400, 'Invalid folder');
  return { clean, abs };
}

async function moveOrCopy(src, dest, keep) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (keep) return fs.promises.copyFile(src, dest);
  try {
    fs.renameSync(src, dest); // instant on the same disk
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fs.promises.copyFile(src, dest);
    fs.rmSync(src);
  }
}

export function registerImportRoutes(router, app, { requireUser, requireCarRole }) {
  const { db } = app;

  /** What's waiting in data/import: the folders (and the top level), with video counts. */
  router.add('GET', '/api/import', (ctx) => {
    const u = requireUser(ctx);
    const root = importDir();
    fs.mkdirSync(root, { recursive: true });
    const entries = [{ folder: '', label: 'Everything in the import folder' }];
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      // People who aren't admins only see their own browser uploads.
      if (!u.isAdmin && !e.name.startsWith(`upload-${u.id}-`)) continue;
      entries.push({ folder: e.name, label: e.name });
    }
    const out = [];
    for (const en of entries) {
      if (!u.isAdmin && en.folder === '') continue;
      const files = walk(path.join(root, en.folder));
      out.push({ ...en, files: files.length, bytes: files.reduce((a, f) => a + fs.statSync(f.abs).size, 0) });
    }
    send(ctx.res, 200, { path: 'data/import', folders: out.filter((f) => f.files > 0) });
  });

  /** Imports a folder of data/import into a car, in the background. */
  router.add('POST', '/api/cars/:id/import', async (ctx) => {
    const u = requireUser(ctx);
    const carId = Number(ctx.params.id);
    requireCarRole(db, u, carId, true);
    const b = await readJson(ctx.req);
    const { clean, abs } = safeFolder(b.folder);
    if (!u.isAdmin && !clean.startsWith(`upload-${u.id}-`)) throw new HttpError(403, 'Only admins can import from the server’s import folder; upload the files instead.');
    const files = walk(abs);
    if (!files.length) throw new HttpError(400, 'No video files found there.');
    const keep = !!b.keepFiles;
    const car = db.get('SELECT * FROM cars WHERE id = ?', carId);
    const job = startJob(u.id, 'import', `Importing ${files.length} files into ${car.name}`, async ({ progress }) => {
      let imported = 0, skipped = 0;
      const unrecognized = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        progress(i / files.length, `${i + 1} of ${files.length}: ${path.basename(f.rel)}`);
        const name = path.basename(f.abs);
        const st = fs.statSync(f.abs);
        const info = parseName(name, st.mtimeMs);
        if (!info) { unrecognized.push(f.rel); continue; }
        if (alreadyImported(db, carId, name, st.size)) {
          skipped++;
          if (!keep) fs.rmSync(f.abs, { force: true });
          continue;
        }
        const cam = cameraFor(db, carId, info.lens);
        const dest = destFor(car, cam, info.time, name);
        await moveOrCopy(f.abs, dest, keep);
        // Remember camera paths (DCIM/...) so Wi-Fi import won't download these again.
        const dcim = /(?:^|\/)(DCIM\/.*)$/i.exec(f.rel);
        await storeRecording(db, app, car, cam, { file: dest, name, folder: folderOfPath(f.rel), info, cameraPath: dcim ? `/${dcim[1]}` : null });
        imported++;
      }
      // Tidy up emptied upload folders.
      if (!keep && clean.startsWith('upload-')) fs.rmSync(abs, { recursive: true, force: true });
      return { imported, skipped, unrecognized: unrecognized.length, example: unrecognized[0] || null };
    });
    audit(db, { user: u, action: 'footage imported from a memory card', target: car.name, ip: ctx.ip, detail: `${files.length} files${keep ? ', kept in the import folder' : ''}` });
    send(ctx.res, 202, { jobId: job.id, files: files.length });
  });

  // ---- browser uploads into data/import/upload-<user>-<time>/... (in pieces, so large files work)
  const uploads = new Map(); // id -> { userId, file, size }
  router.add('POST', '/api/import/uploads', async (ctx) => {
    const u = requireUser(ctx);
    const b = await readJson(ctx.req);
    const batch = String(b.batch || '');
    if (!/^upload-\d+-\d{8}-\d{6}$/.test(batch) || !batch.startsWith(`upload-${u.id}-`)) throw new HttpError(400, 'Invalid upload batch');
    const rel = String(b.relPath || '').replace(/\\/g, '/').split('/').filter((s) => s && s !== '.' && s !== '..').map((s) => s.replace(/[^\w .()-]/g, '_')).join('/');
    if (!VIDEO.test(rel)) throw new HttpError(400, 'Only video files (.mp4, .ts, .mov) can be imported.');
    const file = path.join(importDir(), batch, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.part`, '');
    const id = `${now()}-${Math.random().toString(36).slice(2, 10)}`;
    uploads.set(id, { userId: u.id, file, size: Number(b.size) || 0 });
    send(ctx.res, 201, { id });
  });

  router.add('PATCH', '/api/import/uploads/:id', async (ctx) => {
    const u = requireUser(ctx);
    const up = uploads.get(ctx.params.id);
    if (!up || up.userId !== u.id) throw new HttpError(404, 'Upload not found');
    const offset = Number(ctx.req.headers['upload-offset']);
    const have = fs.statSync(`${up.file}.part`).size;
    if (offset !== have) return send(ctx.res, 409, { offset: have });
    const out = fs.createWriteStream(`${up.file}.part`, { flags: 'a' });
    for await (const chunk of ctx.req) if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    await new Promise((r) => out.end(r));
    const size = fs.statSync(`${up.file}.part`).size;
    if (up.size && size >= up.size) {
      fs.renameSync(`${up.file}.part`, up.file);
      uploads.delete(ctx.params.id);
      return send(ctx.res, 200, { offset: size, done: true });
    }
    send(ctx.res, 200, { offset: size });
  });
}
