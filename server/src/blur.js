import crypto from 'node:crypto';
import { getSettings } from './db.js';

/**
 * Plate/face blurring is done by the optional ML container, which reads and writes the same /data folder.
 * Returns when the blurred file has been written.
 */
export async function mlBlurAvailable(db) {
  const s = getSettings(db);
  if (!s.mlUrl) return false;
  try {
    const r = await fetch(`${s.mlUrl.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok && (await r.json()).blur === true;
  } catch {
    return false;
  }
}

export async function blurFile(db, input, output, { plates, faces }, onProgress = () => {}) {
  const base = getSettings(db).mlUrl.replace(/\/$/, '');
  const id = crypto.randomUUID();
  const r = await fetch(`${base}/blur`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, input, output, plates: !!plates, faces: !!faces }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`Blurring isn't available: ${(await r.json().catch(() => ({}))).error || r.status}`);
  for (;;) {
    await new Promise((res) => setTimeout(res, 1000));
    const s = await (await fetch(`${base}/blur/${id}`, { signal: AbortSignal.timeout(10_000) })).json();
    onProgress(s.progress || 0);
    if (s.status === 'done') return;
    if (s.status === 'failed') throw new Error(`Blurring failed: ${s.error}`);
  }
}
