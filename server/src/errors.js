import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * A safety net: an unexpected error is written to data/logs/errors.log and kept for the Background work page, instead
 * of stopping the server (which would interrupt everyone's uploads, imports and downloads until it restarts).
 */
export const recentErrors = [];

export function recordError(where, e) {
  const entry = { t: Date.now(), where, message: String(e?.message || e).slice(0, 500), stack: String(e?.stack || '').split('\n').slice(0, 6).join('\n') };
  recentErrors.unshift(entry);
  recentErrors.length = Math.min(recentErrors.length, 30);
  console.error(`${where}:`, e);
  try {
    const dir = path.join(config.dataDir, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'errors.log'), `${new Date(entry.t).toISOString()} ${where}: ${entry.message}\n${entry.stack}\n\n`);
  } catch { /* logging must never fail */ }
}

export function installSafetyNet() {
  process.on('unhandledRejection', (e) => recordError('Unhandled error', e));
  process.on('uncaughtException', (e) => recordError('Unexpected error', e));
}
