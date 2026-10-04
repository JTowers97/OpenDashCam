import fs from 'node:fs';
import path from 'node:path';
import { getMeta, getSettings, setMeta } from './db.js';

/**
 * Scheduled database backups: a consistent copy of odc.db (accounts, cars, trips, settings, plate log,
 * clip index) written to /data/backups with SQLite's VACUUM INTO, which is safe while the server runs.
 * Footage isn't included (it's large and already its own backup of the phones). Copy the backups
 * folder somewhere else as well, since it lives on the same disk.
 */
export function backupDir(dataDir) {
  return path.join(dataDir, 'backups');
}

export function runBackup(db, dataDir) {
  const dir = backupDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const file = path.join(dir, `odc-${stamp}.db`);
  fs.rmSync(file, { force: true });
  db.raw.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  setMeta(db, 'last_backup', String(Date.now()));
  pruneBackups(dataDir, getSettings(db).backupKeep);
  return path.basename(file);
}

export function listBackups(dataDir) {
  const dir = backupDir(dataDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^odc-.*\.db$/.test(f)).map((f) => {
    const st = fs.statSync(path.join(dir, f));
    return { name: f, size: st.size, at: st.mtimeMs };
  }).sort((a, b) => b.at - a.at);
}

function pruneBackups(dataDir, keep) {
  for (const b of listBackups(dataDir).slice(Math.max(1, keep))) fs.rmSync(path.join(backupDir(dataDir), b.name), { force: true });
}

/** Called hourly: one backup a day at the chosen hour (local time). */
export function maybeBackup(db, dataDir) {
  const s = getSettings(db);
  if (!s.backupEnabled) return null;
  const last = Number(getMeta(db, 'last_backup') || 0);
  const d = new Date();
  if (d.getHours() !== s.backupHour || Date.now() - last < 20 * 3600_000) return null;
  return runBackup(db, dataDir);
}
