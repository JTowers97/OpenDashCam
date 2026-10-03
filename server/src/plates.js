import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { getSettings } from './db.js';
import { now } from './util.js';

/**
 * License plate reading (optional, off by default). Reads plates from frames sampled every couple of
 * seconds and keeps the readings for the retention period you choose (or forever). Readings power
 * plate search and, if the plate log is also turned on, a browsable log of plates with review tools.
 * Laws on this differ by place; the user is responsible for following them.
 */

export const normalizePlate = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Characters OCR commonly confuses are compared as one.
const CONFUSABLE = { O: '0', Q: '0', D: '0', I: '1', L: '1', B: '8', S: '5', Z: '2', G: '6' };
const canon = (s) => normalizePlate(s).replace(/[OQDILBSZG]/g, (c) => CONFUSABLE[c]);

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** How well a reading matches the query: 1 exact, 0.9 same apart from look-alike characters, 0.7 one character off, 0.6 partial. */
export function plateMatch(query, plate) {
  const q = normalizePlate(query);
  if (q.length < 2) return 0;
  if (plate === q) return 1;
  const cq = canon(q);
  const cp = canon(plate);
  if (cp === cq) return 0.9;
  if (q.length >= 5 && editDistance(cq, cp) === 1) return 0.7;
  if (q.length >= 3 && cp.includes(cq)) return 0.6;
  return 0;
}

// ---------------------------------------------------------------- reading plates

function extractFrames(file, intervalSec, outDir) {
  return new Promise((resolve, reject) => {
    // Full resolution: plates are small in a wide dashcam frame.
    const p = spawn(config.ffmpeg, ['-v', 'error', '-i', file, '-vf', `fps=1/${intervalSec}`, '-q:v', '2', path.join(outDir, 'p%04d.jpg')]);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-300)))));
  });
}

async function readPlates(db, jpeg) {
  const url = getSettings(db).mlUrl.replace(/\/$/, '') + '/plates';
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: jpeg, signal: AbortSignal.timeout(60_000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`ML service: ${data.error || r.status}`);
  return data.plates || [];
}

let running = false;
export const plateState = { lastError: null };

export async function runPlateIndexer(db, limit = 20) {
  const s = getSettings(db);
  if (!s.plateSearch || running) return 0;
  running = true;
  let done = 0;
  try {
    const cutoff = s.plateRetentionDays > 0 ? now() - s.plateRetentionDays * 86400_000 : 0;
    const aliases = new Map(db.all('SELECT from_plate, to_plate FROM plate_aliases').map((a) => [a.from_plate, a.to_plate]));
    const clips = db.all(`SELECT id, path, car_id, started_at FROM clips
      WHERE plates_indexed = 0 AND encrypted = 0 AND started_at >= ? ORDER BY started_at DESC LIMIT ?`, cutoff, limit);
    for (const c of clips) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-plates-'));
      try {
        const interval = Math.max(1, s.plateFrameIntervalSec);
        await extractFrames(c.path, interval, dir);
        const frames = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort();
        // Keep the most confident reading of each plate per 10-second window.
        const best = new Map();
        for (let i = 0; i < frames.length; i++) {
          const offset = Math.round((i + 0.5) * interval * 1000);
          for (const p of await readPlates(db, fs.readFileSync(path.join(dir, frames[i])))) {
            const read = normalizePlate(p.text);
            const plate = aliases.get(read) || read;
            if (plate.length < 2 || p.confidence < s.plateMinConfidence) continue;
            const key = `${plate}:${Math.floor(offset / 10_000)}`;
            const prev = best.get(key);
            if (!prev || p.confidence > prev.confidence) best.set(key, { plate, offset, confidence: p.confidence, box: p.box || null });
          }
        }
        db.tx(() => {
          db.run('DELETE FROM plate_reads WHERE clip_id = ?', c.id);
          for (const r of best.values()) {
            db.run('INSERT INTO plate_reads(clip_id, car_id, t, offset_ms, plate, confidence, box) VALUES (?, ?, ?, ?, ?, ?, ?)',
              c.id, c.car_id, c.started_at + r.offset, r.offset, r.plate, r.confidence, r.box ? JSON.stringify(r.box) : null);
          }
          db.run('UPDATE clips SET plates_indexed = 1 WHERE id = ?', c.id);
        });
        done++;
        plateState.lastError = null;
      } catch (e) {
        if (/fetch failed|ECONNREFUSED|ML service/.test(e.message)) {
          plateState.lastError = e.message;
          break;
        }
        db.run('UPDATE clips SET plates_indexed = -1 WHERE id = ?', c.id);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  } finally {
    running = false;
  }
  return done;
}

/** Deletes readings older than the retention period. */
export function purgeOldPlates(db) {
  const s = getSettings(db);
  if (s.plateRetentionDays > 0) db.run('DELETE FROM plate_reads WHERE t < ?', now() - s.plateRetentionDays * 86400_000);
}

/** Deletes all plate data: readings, notes and merges. */
export function erasePlates(db) {
  db.run('DELETE FROM plate_reads');
  db.run('DELETE FROM plate_notes');
  db.run('DELETE FROM plate_aliases');
  db.run('UPDATE clips SET plates_indexed = 0');
}

export function plateStats(db) {
  const s = getSettings(db);
  const cutoff = s.plateRetentionDays > 0 ? now() - s.plateRetentionDays * 86400_000 : 0;
  const r = db.get(`SELECT SUM(CASE WHEN plates_indexed = 1 THEN 1 ELSE 0 END) done,
    SUM(CASE WHEN encrypted = 0 AND started_at >= ? THEN 1 ELSE 0 END) eligible FROM clips`, cutoff);
  const n = db.get('SELECT COUNT(*) reads, COUNT(DISTINCT plate) plates FROM plate_reads');
  return { platesIndexed: r.done || 0, platesEligible: r.eligible || 0, plateError: plateState.lastError, plateReads: n.reads, distinctPlates: n.plates };
}

/** Clips showing a plate like `query`, best match per clip, limited to clips the user can see. */
export function searchPlates(db, query, clipIds) {
  const allowed = new Set(clipIds);
  const q = normalizePlate(query);
  if (q.length < 2) return [];
  const byClip = new Map();
  for (const r of db.all('SELECT clip_id, offset_ms, plate, confidence FROM plate_reads')) {
    if (!allowed.has(r.clip_id)) continue;
    const m = plateMatch(q, r.plate);
    if (!m) continue;
    const score = m * r.confidence;
    const prev = byClip.get(r.clip_id);
    if (!prev || score > prev.score) byClip.set(r.clip_id, { id: r.clip_id, plate: r.plate, confidence: r.confidence, match: m, score, offsetMs: r.offset_ms });
  }
  return [...byClip.values()].sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------- plate log

/** Plates seen by these cars, with sighting counts. */
export function plateLog(db, carIds, { q, sort, limit = 200, userId }) {
  if (!carIds.length) return [];
  const ph = carIds.map(() => '?').join(',');
  const rows = db.all(`SELECT plate, COUNT(*) sightings, COUNT(DISTINCT date(t / 1000, 'unixepoch', 'localtime')) days,
      MIN(t) first, MAX(t) last, MAX(confidence) best, GROUP_CONCAT(DISTINCT car_id) cars
    FROM plate_reads WHERE car_id IN (${ph}) GROUP BY plate`, ...carIds);
  const notes = new Map(db.all('SELECT plate, note FROM plate_notes WHERE user_id = ?', userId).map((n) => [n.plate, n.note]));
  let out = rows.map((r) => ({ ...r, cars: String(r.cars).split(',').map(Number), note: notes.get(r.plate) || null }));
  if (q) {
    const needle = String(q).toLowerCase();
    out = out.filter((r) => plateMatch(q, r.plate) > 0 || (r.note && r.note.toLowerCase().includes(needle)));
  }
  const sorts = {
    recent: (a, b) => b.last - a.last,
    sightings: (a, b) => b.sightings - a.sightings || b.last - a.last,
    days: (a, b) => b.days - a.days || b.last - a.last,
    plate: (a, b) => a.plate.localeCompare(b.plate),
  };
  return out.sort(sorts[sort] || sorts.recent).slice(0, limit);
}

/** Plates that are probably the same as this one (a misread), for merging. */
export function similarPlates(db, carIds, plate) {
  if (!carIds.length) return [];
  const ph = carIds.map(() => '?').join(',');
  return db.all(`SELECT plate, COUNT(*) sightings, MAX(t) last FROM plate_reads WHERE car_id IN (${ph}) AND plate != ? GROUP BY plate`, ...carIds, plate)
    .map((r) => ({ ...r, match: plateMatch(plate, r.plate) }))
    .filter((r) => r.match >= 0.7 && Math.abs(r.plate.length - plate.length) <= 1)
    .sort((a, b) => b.match - a.match || b.sightings - a.sightings)
    .slice(0, 10);
}

/** Merges plate `from` into `to` for these cars' readings, and remembers it for future readings. */
export function mergePlates(db, carIds, from, to) {
  const ph = carIds.map(() => '?').join(',');
  db.tx(() => {
    db.run(`UPDATE plate_reads SET plate = ?, corrected = 1 WHERE plate = ? AND car_id IN (${ph})`, to, from, ...carIds);
    db.run('INSERT INTO plate_aliases(from_plate, to_plate) VALUES (?, ?) ON CONFLICT(from_plate) DO UPDATE SET to_plate = excluded.to_plate', from, to);
    db.run('UPDATE plate_aliases SET to_plate = ? WHERE to_plate = ?', to, from); // keep chains short
    for (const n of db.all('SELECT user_id, note FROM plate_notes WHERE plate = ?', from)) {
      const existing = db.get('SELECT note FROM plate_notes WHERE user_id = ? AND plate = ?', n.user_id, to);
      const note = existing ? `${existing.note} · ${n.note}` : n.note;
      db.run('INSERT INTO plate_notes(user_id, plate, note) VALUES (?, ?, ?) ON CONFLICT(user_id, plate) DO UPDATE SET note = excluded.note', n.user_id, to, note);
    }
    db.run('DELETE FROM plate_notes WHERE plate = ?', from);
  });
}

/** Cuts the plate out of the frame where it was read, for review screens. Cached. */
export async function plateCrop(db, read, clipPath) {
  const out = path.join(config.cacheDir, 'plates', `${read.id}.jpg`);
  if (fs.existsSync(out)) return out;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const box = read.box ? JSON.parse(read.box) : null;
  const filter = box
    ? (() => {
        // Pad the box so the plate has some context, then scale up small crops.
        const [x1, y1, x2, y2] = box;
        const w = x2 - x1;
        const h = y2 - y1;
        const px = Math.round(w * 0.35);
        const py = Math.round(h * 0.6);
        const x = Math.max(0, x1 - px);
        const y = Math.max(0, y1 - py);
        return `crop=w='min(${w + 2 * px},iw-${x})':h='min(${h + 2 * py},ih-${y})':x=${x}:y=${y},scale='max(320,iw)':-2`;
      })()
    : 'scale=480:-2';
  await new Promise((resolve, reject) => {
    const p = spawn(config.ffmpeg, ['-y', '-v', 'error', '-ss', String(read.offset_ms / 1000), '-i', clipPath, '-frames:v', '1', '-vf', filter, '-q:v', '3', out]);
    p.on('error', reject);
    p.on('close', (code) => (code === 0 && fs.existsSync(out) ? resolve() : reject(new Error('crop failed'))));
  });
  return out;
}
