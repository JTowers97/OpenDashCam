import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

function run(cmd, args, timeoutMs = 10 * 60_000) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-400)}`));
    });
  });
}

export async function probe(file) {
  try {
    const out = await run(config.ffprobe, [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
    ], 60_000);
    const j = JSON.parse(out);
    const v = (j.streams || []).find((s) => s.codec_type === 'video');
    return {
      durationMs: j.format?.duration ? Math.round(Number(j.format.duration) * 1000) : null,
      codec: v?.codec_name || null,
      width: v?.width || null,
      height: v?.height || null,
    };
  } catch {
    return {};
  }
}

export const thumbPath = (clipId) => path.join(config.cacheDir, 'thumbs', `${clipId}.jpg`);
export const h264Path = (clipId) => path.join(config.cacheDir, 'h264', `${clipId}.mp4`);

export async function makeThumbnail(file, clipId) {
  const out = thumbPath(clipId);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // Try 1 s in; very short clips fall back to the first frame.
  for (const ss of ['1', '0']) {
    try {
      await run(config.ffmpeg, ['-y', '-v', 'error', '-ss', ss, '-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '5', out], 60_000);
      if (fs.existsSync(out) && fs.statSync(out).size > 0) return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

/** H.264 copy for browsers that can't play H.265. Cached; originals are never modified. */
export async function transcodeH264(file, clipId) {
  const out = h264Path(clipId);
  if (fs.existsSync(out)) return out;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = out + '.tmp.mp4';
  await run(config.ffmpeg, [
    '-y', '-v', 'error', '-i', file,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', tmp,
  ]);
  fs.renameSync(tmp, out);
  return out;
}

/** A tiny sequential job queue so heavy ffmpeg work never runs many at once. */
export class JobQueue {
  constructor(concurrency = 1) {
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = [];
    this.pending = new Map();
  }

  /** Runs fn once per key; callers with the same key share the same promise. */
  push(key, fn) {
    if (this.pending.has(key)) return this.pending.get(key);
    const p = new Promise((resolve, reject) => this.queue.push({ fn, resolve, reject }));
    this.pending.set(key, p);
    p.finally(() => this.pending.delete(key)).catch(() => {});
    this.next();
    return p;
  }

  has(key) {
    return this.pending.has(key);
  }

  next() {
    while (this.running < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      this.running++;
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.running--;
          this.next();
        });
    }
  }
}
