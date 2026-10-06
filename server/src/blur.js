import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { getSettings } from './db.js';

/**
 * Plate/face blurring is done by the optional ML container, which reads and writes the same /data folder.
 * Returns when the blurred file has been written.
 */
/** Whether blurring can work: { available, reason }. Checks the ML container can actually read this server's files. */
export async function blurStatus(db) {
  const s = getSettings(db);
  if (!s.mlUrl) return { available: false, reason: 'no-ml' };
  const base = s.mlUrl.replace(/\/$/, '');
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok || (await r.json()).blur !== true) return { available: false, reason: 'no-ml' };
  } catch {
    return { available: false, reason: 'no-ml' };
  }
  // Write a small file into the data folder and ask the ML container whether it can see it.
  const probe = path.join(config.cacheDir, 'ml-probe.txt');
  try {
    fs.mkdirSync(path.dirname(probe), { recursive: true });
    fs.writeFileSync(probe, 'ODC');
    const r = await fetch(`${base}/can-read?path=${encodeURIComponent(probe)}`, { signal: AbortSignal.timeout(3000) });
    if (r.status === 404) return { available: true, reason: null }; // older ML container: can't check, assume OK
    const j = await r.json();
    return j.readable ? { available: true, reason: null } : { available: false, reason: 'not-mounted', dataDir: config.dataDir };
  } catch {
    return { available: false, reason: 'no-ml' };
  }
}

export async function mlBlurAvailable(db) {
  return (await blurStatus(db)).available;
}

export async function blurFile(db, input, output, { plates, faces, ignoreArea = 'none' }, onProgress = () => {}) {
  const base = getSettings(db).mlUrl.replace(/\/$/, '');
  const id = crypto.randomUUID();
  const r = await fetch(`${base}/blur`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, input, output, plates: !!plates, faces: !!faces, ignoreArea }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`Blurring isn't available: ${(await r.json().catch(() => ({}))).error || r.status}`);
  let last = -1;
  let lastChange = Date.now();
  const stallMs = Number(process.env.ODC_BLUR_STALL_MS) || 30 * 60_000;
  for (;;) {
    await new Promise((res) => setTimeout(res, 1000));
    const r2 = await fetch(`${base}/blur/${id}`, { signal: AbortSignal.timeout(10_000) });
    // The ML container no longer knows this job (it restarted): stop instead of waiting forever.
    if (r2.status === 404) throw new Error('The ML container restarted during blurring. Please try again.');
    const s = await r2.json();
    onProgress(s.progress || 0, s.status === 'queued' ? 'Waiting for the ML container' : 'Blurring');
    if (s.status === 'done') return;
    if (s.status === 'failed') throw new Error(`Blurring failed: ${s.error}`);
    if (s.progress !== last) { last = s.progress; lastChange = Date.now(); }
    else if (s.status === 'running' && Date.now() - lastChange > stallMs) throw new Error('Blurring stopped making progress. Please try again.');
  }
}
