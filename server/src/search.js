import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { getSettings } from './db.js';

/**
 * Smart search. A background indexer samples one frame every N seconds from each clip, asks the
 * optional ML service for a CLIP embedding, and stores it (int8, 512 bytes). A search phrase is
 * embedded the same way and compared with every frame; the best frame per clip gives its score and
 * the moment to jump to. All of this runs on your server.
 */

// ---------------------------------------------------------------- ML service client

async function ml(db, pathname, body, contentType) {
  const url = getSettings(db).mlUrl.replace(/\/$/, '') + pathname;
  const r = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': contentType } : {},
    body,
    signal: AbortSignal.timeout(body ? 60_000 : 5_000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `ML service responded ${r.status}`);
  return data;
}

export async function mlHealth(db) {
  try {
    return await ml(db, '/health');
  } catch (e) {
    return { ready: false, error: `Can't reach the ML service at ${getSettings(db).mlUrl} (${e.cause?.code || e.message})` };
  }
}

const embedText = async (db, text) => Float32Array.from((await ml(db, '/embed/text', JSON.stringify({ text }), 'application/json')).embedding);
const embedImage = async (db, jpeg) => Float32Array.from((await ml(db, '/embed/image', jpeg, 'image/jpeg')).embedding);

const quantize = (v) => {
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round(v[i] * 127)));
  return q;
};

// ---------------------------------------------------------------- in-memory index

let index = null; // Map clipId -> Int8Array[] (frames), plus offsets
function loadIndex(db) {
  if (index) return index;
  index = new Map();
  for (const r of db.all('SELECT clip_id, offset_ms, vec FROM clip_frames ORDER BY clip_id, offset_ms')) {
    let e = index.get(r.clip_id);
    if (!e) index.set(r.clip_id, (e = { offsets: [], vecs: [] }));
    e.offsets.push(r.offset_ms);
    e.vecs.push(new Int8Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength));
  }
  return index;
}

export function forgetClip(clipId) {
  index?.delete(clipId);
}

// ---------------------------------------------------------------- indexer

function extractFrames(file, intervalSec, outDir) {
  return new Promise((resolve, reject) => {
    const p = spawn(config.ffmpeg, ['-v', 'error', '-i', file, '-vf', `fps=1/${intervalSec},scale=-2:336`, '-q:v', '4', path.join(outDir, 'f%04d.jpg')]);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-300)))));
  });
}

let running = false;
export const indexerState = { lastError: null, current: null };

/** Indexes pending clips, newest first. Stops quietly if the ML service is unavailable. */
export async function runIndexer(db, limit = 50) {
  const s = getSettings(db);
  if (!s.smartSearch || running) return 0;
  running = true;
  let done = 0;
  try {
    const health = await mlHealth(db);
    if (!health.ready) {
      indexerState.lastError = health.error || 'The ML model is still loading.';
      return 0;
    }
    indexerState.lastError = null;
    const clips = db.all('SELECT id, path FROM clips WHERE indexed = 0 AND encrypted = 0 ORDER BY started_at DESC LIMIT ?', limit);
    for (const c of clips) {
      indexerState.current = c.id;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-frames-'));
      try {
        await extractFrames(c.path, Math.max(2, s.searchFrameIntervalSec), dir);
        const frames = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort();
        const rows = [];
        for (let i = 0; i < frames.length; i++) {
          const vec = await embedImage(db, fs.readFileSync(path.join(dir, frames[i])));
          // fps filter samples the middle of each interval
          rows.push([Math.round((i + 0.5) * s.searchFrameIntervalSec * 1000), quantize(vec)]);
        }
        db.tx(() => {
          db.run('DELETE FROM clip_frames WHERE clip_id = ?', c.id);
          for (const [off, q] of rows) db.run('INSERT INTO clip_frames(clip_id, offset_ms, vec) VALUES (?, ?, ?)', c.id, off, Buffer.from(q.buffer));
          db.run('UPDATE clips SET indexed = 1 WHERE id = ?', c.id);
        });
        if (index) index.set(c.id, { offsets: rows.map((r) => r[0]), vecs: rows.map((r) => r[1]) });
        done++;
      } catch (e) {
        // Connection problems leave the clip pending; a bad file is marked failed so it isn't retried forever.
        if (/fetch failed|ECONNREFUSED|ML service/.test(e.message)) {
          indexerState.lastError = e.message;
          break;
        }
        db.run('UPDATE clips SET indexed = -1 WHERE id = ?', c.id);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  } finally {
    running = false;
    indexerState.current = null;
  }
  return done;
}

export function resetIndex(db, failedOnly) {
  if (failedOnly) db.run('UPDATE clips SET indexed = 0 WHERE indexed = -1');
  else {
    db.run('DELETE FROM clip_frames');
    db.run('UPDATE clips SET indexed = 0');
    index = null;
  }
}

export function indexStats(db) {
  const r = db.get(`SELECT SUM(CASE WHEN indexed = 1 THEN 1 ELSE 0 END) done, SUM(CASE WHEN indexed = -1 THEN 1 ELSE 0 END) failed,
    SUM(CASE WHEN encrypted = 0 THEN 1 ELSE 0 END) searchable, COUNT(*) total FROM clips`);
  return { indexed: r.done || 0, failed: r.failed || 0, searchable: r.searchable || 0, total: r.total || 0 };
}

// ---------------------------------------------------------------- search

/**
 * Scores clips against a phrase. Returns Map clipId -> { score, offsetMs } for clips in `candidates`
 * that clearly match: at least 0.2 cosine similarity and within 0.08 of the best match.
 */
export async function visualSearch(db, text, candidates) {
  const q = await embedText(db, text);
  const idx = loadIndex(db);
  const scored = [];
  for (const id of candidates) {
    const e = idx.get(id);
    if (!e) continue;
    let best = -1;
    let bestOff = 0;
    for (let f = 0; f < e.vecs.length; f++) {
      const v = e.vecs[f];
      let dot = 0;
      for (let i = 0; i < v.length; i++) dot += v[i] * q[i];
      if (dot > best) {
        best = dot;
        bestOff = e.offsets[f];
      }
    }
    scored.push({ id, score: best / 127, offsetMs: bestOff });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0]?.score ?? 0;
  const cutoff = Math.max(0.2, top - 0.08);
  return scored.filter((r) => r.score >= cutoff);
}
