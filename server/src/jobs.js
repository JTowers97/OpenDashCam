import crypto from 'node:crypto';
import { now } from './util.js';

/**
 * Background jobs for slow work, kept in memory for a day; the browser and the app poll /api/jobs/:id. Jobs run one at a
 * time per lane, so a long memory card import doesn't hold up a share link waiting to be blurred (and vice versa):
 *   import: memory card imports
 *   ml:     blurring (share links) and incident reports
 */
const jobs = new Map();
const lanes = new Map(); // lane -> { queue, running }

export const laneFor = (kind) => (kind === 'import' ? 'import' : 'ml');

export function startJob(userId, kind, title, fn) {
  const id = crypto.randomUUID();
  const job = { id, userId, kind, title, status: 'queued', progress: 0, step: 'Waiting for other work to finish', error: null, result: null,
    createdAt: now(), startedAt: null, finishedAt: null, lane: laneFor(kind) };
  jobs.set(id, job);
  const lane = lanes.get(job.lane) || { queue: [], running: false };
  lanes.set(job.lane, lane);
  lane.queue.push(async () => {
    job.status = 'running';
    job.startedAt = now();
    job.step = 'Starting';
    try {
      job.result = await fn({ progress: (p, step) => { job.progress = Math.max(0, Math.min(1, p)); if (step) job.step = step; } });
      job.status = 'done';
      job.progress = 1;
      job.step = 'Done';
    } catch (e) {
      job.status = 'failed';
      job.error = e.message;
    }
    job.finishedAt = now();
  });
  pump(lane);
  for (const [k, v] of jobs) if (now() - v.createdAt > 86400_000) jobs.delete(k);
  return job;
}

async function pump(lane) {
  if (lane.running) return;
  lane.running = true;
  while (lane.queue.length) await lane.queue.shift()();
  lane.running = false;
}

export const getJob = (id) => jobs.get(id);
export const allJobs = () => [...jobs.values()];
/** Where a queued job is in its lane (1 = next). */
export const queuePosition = (j) => (j.status !== 'queued' ? 0 : allJobs().filter((x) => x.lane === j.lane && x.status === 'queued' && x.createdAt <= j.createdAt).length);
export const jobView = (j) => ({ id: j.id, kind: j.kind, title: j.title, status: j.status, progress: j.progress, step: j.step, error: j.error, result: j.result,
  createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt, queuePosition: queuePosition(j) });
