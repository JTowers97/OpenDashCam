import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { audit } from './audit.js';
import { notify } from './notify.js';
import { HttpError, now, num, readJson, send, str } from './util.js';

/**
 * Live view on demand. Phones that are recording keep a long-poll open (GET /api/v1/live-view/wait); when someone
 * starts a live view of the car, the server answers it and the phones send JPEG frames (1–2 per second) until the
 * session ends. Viewers watch an MJPEG stream (browsers show it in a normal <img>). Sessions last 2 minutes unless
 * extended, and end 20 seconds after the last viewer leaves.
 */
const SESSION_MS = Number(process.env.ODC_LIVE_SESSION_MS) || 2 * 60_000;
const MAX_SESSION_MS = 15 * 60_000;
const IDLE_MS = Number(process.env.ODC_LIVE_IDLE_MS) || 20_000;   // end this long after the last viewer leaves
const WAIT_MS = Number(process.env.ODC_LIVE_WAIT_MS) || 25_000;   // long-poll length
const waiters = new Map();   // carId -> Set<{ cam, res, timer }>
const sessions = new Map();  // id -> session
const bus = new EventEmitter();
bus.setMaxListeners(100);

function endSession(s, reason = 'ended') {
  if (s.ended) return;
  s.ended = reason;
  sessions.delete(s.id);
  bus.emit(`end:${s.id}`);
}

setInterval(() => {
  for (const s of sessions.values()) {
    if (now() > s.expiresAt) endSession(s, 'time limit reached');
    else if (s.viewers === 0 && now() - s.lastViewerAt > IDLE_MS) endSession(s, 'no viewers');
  }
}, Math.min(2000, IDLE_MS / 2)).unref();

export function registerLiveViewRoutes(router, app, { requireUser, requireCamera, carRole }) {
  const { db } = app;

  const canView = (u, carId) => {
    const role = carRole(db, u, carId);
    if (!role) throw new HttpError(404, 'Car not found');
    if (role === 'viewer') throw new HttpError(403, 'Live view needs owner or manager access to this car.');
  };
  const sessionFor = (u, id) => {
    const s = sessions.get(id);
    if (!s || s.userId !== u.id) throw new HttpError(404, 'This live view has ended.');
    return s;
  };

  // ---------------------------------------------------------------- phone side

  /** Long-poll: answers when a live view starts for this phone's car, or with 204 after ~25 s. */
  router.add('GET', '/api/v1/live-view/wait', (ctx) => {
    const cam = requireCamera(ctx);
    const active = [...sessions.values()].find((s) => s.carId === cam.car_id && !s.ended);
    if (active) return send(ctx.res, 200, offer(active));
    const set = waiters.get(cam.car_id) || new Set();
    waiters.set(cam.car_id, set);
    const w = { cam, res: ctx.res };
    w.timer = setTimeout(() => { set.delete(w); if (!ctx.res.writableEnded) { ctx.res.writeHead(204); ctx.res.end(); } }, WAIT_MS);
    ctx.res.on('close', () => { clearTimeout(w.timer); set.delete(w); });
    set.add(w);
    db.run('UPDATE cameras SET last_seen_at = ? WHERE id = ?', now(), cam.id);
  });

  const offer = (s) => ({ session: s.id, fps: s.fps, maxWidth: s.maxWidth, until: s.expiresAt });

  /** A frame from the phone. stream = which camera on the phone (e.g. rear/front). */
  router.add('POST', '/api/v1/live-view/:id/frame', async (ctx) => {
    const cam = requireCamera(ctx);
    const s = sessions.get(ctx.params.id);
    const chunks = [];
    let size = 0;
    for await (const c of ctx.req) {
      size += c.length;
      if (size > 2 * 1024 * 1024) throw new HttpError(413, 'Frame too large');
      chunks.push(c);
    }
    if (!s || s.carId !== cam.car_id) return send(ctx.res, 200, { continue: false });
    const jpeg = Buffer.concat(chunks);
    if (jpeg.length < 100 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new HttpError(400, 'Expected a JPEG image');
    const stream = `${cam.id}:${str(ctx.query.get('stream'), 20) || 'main'}`;
    const label = `${cam.label}${ctx.query.get('label') ? ` · ${str(ctx.query.get('label'), 20)}` : ''}`;
    s.frames.set(stream, { jpeg, t: now(), label });
    s.bytes += jpeg.length;
    bus.emit(`frame:${s.id}`, stream);
    send(ctx.res, 200, { continue: true, fps: s.fps, maxWidth: s.maxWidth, until: s.expiresAt });
  });

  // ---------------------------------------------------------------- viewer side

  router.add('POST', '/api/cars/:id/live-view', async (ctx) => {
    const u = requireUser(ctx);
    const carId = Number(ctx.params.id);
    canView(u, carId);
    const b = await readJson(ctx.req).catch(() => ({}));
    const fps = [0.5, 1, 2].includes(Number(b.fps)) ? Number(b.fps) : 1;
    const phones = [...(waiters.get(carId) || [])];
    const existing = [...sessions.values()].find((s) => s.carId === carId && s.userId === u.id);
    if (!phones.length && !existing) {
      throw new HttpError(409, 'No phone in this car is available for live view right now. Live view works while ODC is recording, with “Allow live view” turned on in the app.');
    }
    const s = existing || {
      id: crypto.randomUUID(), carId, userId: u.id, fps, maxWidth: 960, createdAt: now(), expiresAt: now() + SESSION_MS,
      frames: new Map(), viewers: 0, lastViewerAt: now(), bytes: 0, ended: null,
    };
    s.fps = fps;
    sessions.set(s.id, s);
    // Wake the waiting phones.
    for (const w of phones) {
      clearTimeout(w.timer);
      waiters.get(carId).delete(w);
      if (!w.res.writableEnded) send(w.res, 200, offer(s));
    }
    const car = db.get('SELECT name, owner_id FROM cars WHERE id = ?', carId);
    if (!existing) {
      audit(db, { user: u, action: 'live view started', target: car.name, ip: ctx.ip });
      if (car.owner_id !== u.id) {
        notify(db, { title: `${u.username} is watching ${car.name} live`, message: 'Started from the ODC Server.', tags: ['eyes'], userIds: [car.owner_id], url: '/#/cars' });
      }
    }
    send(ctx.res, 201, { session: s.id, phones: phones.length, expiresAt: s.expiresAt });
  });

  router.add('GET', '/api/live-view/:id', (ctx) => {
    const u = requireUser(ctx);
    const s = sessionFor(u, ctx.params.id);
    send(ctx.res, 200, {
      session: s.id, expiresAt: s.expiresAt, fps: s.fps, bytes: s.bytes,
      streams: [...s.frames.entries()].map(([key, f]) => ({ key, label: f.label, lastFrameAt: f.t })),
    });
  });

  router.add('POST', '/api/live-view/:id/extend', (ctx) => {
    const u = requireUser(ctx);
    const s = sessionFor(u, ctx.params.id);
    s.expiresAt = Math.min(s.createdAt + MAX_SESSION_MS, now() + SESSION_MS);
    send(ctx.res, 200, { expiresAt: s.expiresAt, maxReached: s.expiresAt >= s.createdAt + MAX_SESSION_MS });
  });

  router.add('DELETE', '/api/live-view/:id', (ctx) => {
    const u = requireUser(ctx);
    endSession(sessionFor(u, ctx.params.id), 'stopped');
    send(ctx.res, 200, { ok: true });
  });

  /** MJPEG stream of one camera: works in a plain <img>. */
  router.add('GET', '/api/live-view/:id/stream', (ctx) => {
    const u = requireUser(ctx);
    const s = sessionFor(u, ctx.params.id);
    const key = ctx.query.get('key');
    const boundary = 'odcframe';
    ctx.res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${boundary}`,
      'Cache-Control': 'no-store', Connection: 'close', 'X-Accel-Buffering': 'no',
    });
    s.viewers++;
    s.lastViewerAt = now();
    const push = (k) => {
      if (k !== key) return;
      const f = s.frames.get(key);
      if (!f || ctx.res.writableEnded) return;
      ctx.res.write(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${f.jpeg.length}\r\n\r\n`);
      ctx.res.write(f.jpeg);
      ctx.res.write('\r\n');
      s.lastViewerAt = now();
    };
    const end = () => { if (!ctx.res.writableEnded) ctx.res.end(); };
    bus.on(`frame:${s.id}`, push);
    bus.once(`end:${s.id}`, end);
    if (s.frames.has(key)) push(key);
    ctx.res.on('close', () => {
      bus.off(`frame:${s.id}`, push);
      bus.off(`end:${s.id}`, end);
      s.viewers--;
      s.lastViewerAt = now();
    });
  });

  /** Which cars have a phone ready for live view (for showing the button). */
  router.add('GET', '/api/live-view-ready', (ctx) => {
    requireUser(ctx);
    const out = {};
    for (const [carId, set] of waiters) if (set.size) out[carId] = set.size;
    send(ctx.res, 200, out);
  });
  void num;
}
