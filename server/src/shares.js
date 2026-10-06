import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { audit } from './audit.js';
import { blurFile, blurStatus, mlBlurAvailable } from './blur.js';
import { trimClip } from './media.js';
import { stampAreaFor } from './plates.js';
import { startJob } from './jobs.js';
import { HttpError, now, randomToken, readJson, send } from './util.js';

/**
 * Expiring share links: anyone with the link can watch one clip (or a trimmed part of it) until the
 * link expires or is revoked. Optionally plates and/or faces are blurred first (needs the ML container).
 * Links never reveal the car, the account or where the clip was recorded.
 */
const EXPIRY_HOURS = [1, 24, 24 * 7, 24 * 30];
const shareDir = () => path.join(config.dataDir, 'shares');

export function deleteShareFiles(db, clipId) {
  for (const s of db.all('SELECT file FROM shares WHERE clip_id = ?', clipId)) if (s.file) fs.rmSync(s.file, { force: true });
}

export function purgeExpiredShares(db) {
  for (const s of db.all('SELECT token, file FROM shares WHERE expires_at < ?', now())) {
    if (s.file) fs.rmSync(s.file, { force: true });
    db.run('DELETE FROM shares WHERE token = ?', s.token);
  }
}

/** Trims and/or blurs a clip into `out`. Shared by share links and incident reports. */
export async function prepareCopy(db, clip, out, { start = null, end = null, blurPlates = false, blurFaces = false }, progress = () => {}) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  let src = clip.path;
  const tmp = `${out}.trim.mp4`;
  try {
    if (start != null && end != null) {
      progress(0.02, 'Trimming');
      await trimClip(clip.path, start, end, blurPlates || blurFaces ? tmp : out);
      src = tmp;
    }
    if (blurPlates || blurFaces) {
      progress(0.05, 'Blurring');
      await blurFile(db, src === tmp ? tmp : clip.path, out, { plates: blurPlates, faces: blurFaces, ignoreArea: stampAreaFor(db, clip) }, (p, step) => progress(0.05 + 0.95 * p, step || 'Blurring'));
    } else if (start == null) {
      fs.copyFileSync(clip.path, out);
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const shareView = (db, s, base) => {
  const c = db.get('SELECT file_name, started_at, duration_ms FROM clips WHERE id = ?', s.clip_id);
  return {
    token: s.token, url: `${base}/s/${s.token}`, clipId: s.clip_id, clipName: c?.file_name, startedAt: c?.started_at,
    createdAt: s.created_at, expiresAt: s.expires_at, allowDownload: !!s.allow_download, blurPlates: !!s.blur_plates, blurFaces: !!s.blur_faces,
    start: s.start_s, end: s.end_s, status: s.status, error: s.error, views: s.views,
  };
};

/** Prepares a share's copy (trimmed and/or blurred) in the background. */
function startPrepare(db, share, clip) {
  const blur = [share.blur_plates && 'plates', share.blur_faces && 'faces'].filter(Boolean).join(' and ');
  return startJob(share.user_id, 'share', `Share link for ${clip.file_name}${blur ? ` (blurring ${blur})` : ''}`, async ({ progress }) => {
    try {
      await prepareCopy(db, clip, share.file, { start: share.start_s, end: share.end_s, blurPlates: !!share.blur_plates, blurFaces: !!share.blur_faces }, progress);
      db.run(`UPDATE shares SET status = 'ready' WHERE token = ?`, share.token);
    } catch (e) {
      db.run(`UPDATE shares SET status = 'failed', error = ? WHERE token = ?`, e.message, share.token);
      throw e;
    }
  });
}

/** Share links still being prepared when the server stopped: start their preparation again. */
export function resumeShares(db) {
  const rows = db.all(`SELECT s.*, c.id AS cid FROM shares s JOIN clips c ON c.id = s.clip_id WHERE s.status = 'processing' AND s.expires_at > ?`, now());
  for (const s of rows) startPrepare(db, s, db.get('SELECT * FROM clips WHERE id = ?', s.cid));
  db.run(`UPDATE shares SET status = 'failed', error = 'The clip was deleted' WHERE status = 'processing' AND clip_id NOT IN (SELECT id FROM clips)`);
  return rows.length;
}

export function registerShareRoutes(router, app, { requireUser, clipFor }) {
  const { db } = app;

  router.add('GET', '/api/blur/available', async (ctx) => {
    requireUser(ctx);
    send(ctx.res, 200, await blurStatus(db));
  });

  router.add('POST', '/api/clips/:id/share', async (ctx) => {
    const u = requireUser(ctx);
    const c = clipFor(u, ctx.params.id);
    if (c.encrypted) throw new HttpError(400, 'Encrypted clips can’t be shared by link.');
    const b = await readJson(ctx.req);
    const hours = EXPIRY_HOURS.includes(Number(b.expiresHours)) ? Number(b.expiresHours) : 24;
    const trim = b.start != null && b.end != null;
    if (trim && !(Number(b.start) >= 0 && Number(b.end) > Number(b.start))) throw new HttpError(400, 'Choose a start before the end.');
    const blurPlates = !!b.blurPlates;
    const blurFaces = !!b.blurFaces;
    if ((blurPlates || blurFaces) && !(await mlBlurAvailable(db))) {
      const st = await blurStatus(db);
      throw new HttpError(400, st.reason === 'not-mounted'
        ? 'Blurring needs the ML container to see the footage: add “- ./data:/data” to its volumes in docker-compose.yml (see the server README).'
        : 'Blurring needs the ML container (smart search) running and reachable.');
    }
    const token = randomToken(24);
    const needsCopy = trim || blurPlates || blurFaces;
    const file = needsCopy ? path.join(shareDir(), `${token}.mp4`) : null;
    db.run(`INSERT INTO shares(token, user_id, clip_id, created_at, expires_at, allow_download, blur_plates, blur_faces, start_s, end_s, file, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, token, u.id, c.id, now(), now() + hours * 3600_000, b.allowDownload ? 1 : 0,
      blurPlates ? 1 : 0, blurFaces ? 1 : 0, trim ? Number(b.start) : null, trim ? Number(b.end) : null, file, needsCopy ? 'processing' : 'ready');
    const job = needsCopy ? startPrepare(db, db.get('SELECT * FROM shares WHERE token = ?', token), c) : null;
    audit(db, { user: u, action: 'share link created', target: `${c.car_name} · ${c.file_name}`, ip: ctx.ip,
      detail: [`${hours} h`, b.allowDownload ? 'download allowed' : null, blurPlates ? 'plates blurred' : null, blurFaces ? 'faces blurred' : null, trim ? `trimmed ${b.start}–${b.end} s` : null].filter(Boolean).join(', ') });
    send(ctx.res, 201, { ...shareView(db, db.get('SELECT * FROM shares WHERE token = ?', token), app.publicUrl(ctx.req)), jobId: job?.id ?? null });
  });

  router.add('GET', '/api/shares', (ctx) => {
    const u = requireUser(ctx);
    const base = app.publicUrl(ctx.req);
    send(ctx.res, 200, db.all('SELECT * FROM shares WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC', u.id, now()).map((s) => shareView(db, s, base)));
  });

  router.add('DELETE', '/api/shares/:token', (ctx) => {
    const u = requireUser(ctx);
    const s = db.get('SELECT * FROM shares WHERE token = ?', ctx.params.token);
    if (!s || (s.user_id !== u.id && !u.isAdmin)) throw new HttpError(404, 'Link not found');
    if (s.file) fs.rmSync(s.file, { force: true });
    db.run('DELETE FROM shares WHERE token = ?', s.token);
    audit(db, { user: u, action: 'share link revoked', ip: ctx.ip, target: s.clip_id });
    send(ctx.res, 200, { ok: true });
  });

  // ---- public pages (no account)
  const live = (token) => {
    const s = db.get('SELECT s.*, c.path, c.started_at, c.duration_ms FROM shares s JOIN clips c ON c.id = s.clip_id WHERE s.token = ?', token);
    if (!s) return { error: 'This link doesn’t exist or has been turned off.' };
    if (s.expires_at < now()) return { error: 'This link has expired.' };
    return { s };
  };
  const privateHeaders = { 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'private, no-store' };

  router.add('GET', '/s/:token', (ctx) => {
    const { s, error } = live(ctx.params.token);
    const page = (body, status = 200) => {
      ctx.res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...privateHeaders });
      ctx.res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Shared video · Open Dash Cam</title>
<style>body{margin:0;background:#0f1012;color:#ececec;font:16px/1.5 system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;padding:1rem}
main{width:100%;max-width:1000px}video{width:100%;background:#000;border-radius:10px}h1{font-size:1.2rem;margin:.5rem 0}
.muted{color:#9a9a9a;font-size:.9rem}a.btn{display:inline-block;margin-top:.75rem;padding:.5rem .9rem;border-radius:8px;background:#ff5a36;color:#120805;text-decoration:none;font-weight:600}</style>
</head><body><main>${body}<p class="muted">Shared with Open Dash Cam.</p></main></body></html>`);
    };
    if (error) return page(`<h1>${error}</h1><p class="muted">Ask the person who sent it for a new link.</p>`, 410);
    if (s.status === 'processing') return page('<h1>This video is still being prepared.</h1><p class="muted">Try again in a few minutes.</p>', 202);
    if (s.status === 'failed') return page('<h1>This video couldn’t be prepared.</h1><p class="muted">Ask the person who sent it for a new link.</p>', 500);
    db.run('UPDATE shares SET views = views + 1 WHERE token = ?', s.token);
    const when = new Date(s.started_at + (s.start_s || 0) * 1000);
    const expires = new Date(s.expires_at);
    const notes = [s.blur_plates && 'license plates blurred', s.blur_faces && 'faces blurred'].filter(Boolean).join(' and ');
    page(`<h1>Video recorded ${when.toUTCString().replace(' GMT', ' UTC')}</h1>
<video src="/s/${s.token}/video" controls playsinline preload="metadata"></video>
<p class="muted">${notes ? notes[0].toUpperCase() + notes.slice(1) + '. ' : ''}This link expires ${expires.toUTCString().replace(' GMT', ' UTC')}.</p>
${s.allow_download ? `<a class="btn" href="/s/${s.token}/download">Download video</a>` : ''}`);
  });

  router.add('GET', '/s/:token/video', (ctx) => {
    const { s, error } = live(ctx.params.token);
    if (error || s.status !== 'ready') throw new HttpError(error ? 410 : 409, error || 'Not ready yet');
    app.serveFile(ctx, s.file || s.path, 'video/mp4', privateHeaders);
  });

  router.add('GET', '/s/:token/download', (ctx) => {
    const { s, error } = live(ctx.params.token);
    if (error || s.status !== 'ready') throw new HttpError(error ? 410 : 409, error || 'Not ready yet');
    if (!s.allow_download) throw new HttpError(403, 'Downloading isn’t allowed for this link.');
    const name = `video-${new Date(s.started_at).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.mp4`;
    app.serveFile(ctx, s.file || s.path, 'video/mp4', { ...privateHeaders, 'Content-Disposition': `attachment; filename="${name}"` });
  });
}
