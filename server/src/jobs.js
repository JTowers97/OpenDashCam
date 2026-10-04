import crypto from 'node:crypto';
import { now } from './util.js';

/**
 * Background jobs for slow work (blurring, incident reports), one at a time so the server stays
 * responsive. Progress and results are kept in memory for a day; the browser polls /api/jobs/:id.
 */
const jobs = new Map();
const queue = [];
let running = false;

export function startJob(userId, kind, title, fn) {
  const id = crypto.randomUUID();
  const job = { id, userId, kind, title, status: 'queued', progress: 0, step: 'Waiting', error: null, result: null, createdAt: now() };
  jobs.set(id, job);
  queue.push(async () => {
    job.status = 'running';
    try {
      job.result = await fn({ progress: (p, step) => { job.progress = Math.max(0, Math.min(1, p)); if (step) job.step = step; } });
      job.status = 'done';
      job.progress = 1;
      job.step = 'Done';
    } catch (e) {
      job.status = 'failed';
      job.error = e.message;
    }
  });
  pump();
  for (const [k, v] of jobs) if (now() - v.createdAt > 86400_000) jobs.delete(k);
  return job;
}

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) await queue.shift()();
  running = false;
}

export const getJob = (id) => jobs.get(id);
export const jobView = (j) => ({ id: j.id, kind: j.kind, title: j.title, status: j.status, progress: j.progress, step: j.step, error: j.error, result: j.result });
