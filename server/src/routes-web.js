import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import {
  carRole, checkLoginRate, checkStreamToken, clearCookie, createSession, destroySession, hashPassword,
  newPairingCode, recordLoginFailure, requireCarRole, sessionCookie, streamToken, userFromRequest,
  validatePassword, verifyPassword, visibleCarIds,
} from './auth.js';
import { getSettings, saveSettings } from './db.js';
import { HttpError, now, num, readJson, send, sha256hex, str } from './util.js';
import { carLive, learnPlaces, markTripsDirty, mergeTrips, rebuildTrips, relabelTrips, routePoints, splitTrip } from './tracks.js';
import { newRecoveryCodes, newSecret, otpauthUrl, verifyTotp } from './totp.js';
import { vapidKeys } from './webpush.js';
import { audit } from './audit.js';
import { listBackups, runBackup, backupDir } from './backup.js';
import { currentSessionHash, sessionId } from './auth.js';
import { writeZip, ZIP_LIMIT } from './zip.js';
import { trimClip } from './media.js';
import { randomToken, sha256hex as hashOf } from './util.js';
import crypto from 'node:crypto';
import { WrongPassphrase, decryptFile } from './crypto-odcenc.js';
import { registerShareRoutes } from './shares.js';
import { registerReportRoutes } from './reports.js';
import { snapshotPath } from './snapshots.js';
import { haStatus } from './homeassistant.js';
import { importCar, listFiles } from './viofo.js';
import { registerLiveViewRoutes } from './liveview.js';
import { registerImportRoutes } from './sdimport.js';
import { buildSummary } from './summary.js';
import { ALERT_KINDS, notify, waitForNotification } from './notify.js';
import { requireCamera } from './routes-device.js';
import { indexerState, indexStats, mlHealth, resetIndex, runIndexer, visualSearch } from './search.js';
import {
  erasePlates, mergePlates, normalizePlate, plateCrop, plateLog, plateStats, purgeOldPlates, runPlateIndexer, searchPlates, similarPlates,
} from './plates.js';
import { h264Path, thumbPath } from './media.js';

export function registerWebRoutes(router, app) {
  const { db } = app;

  const requireUser = (ctx) => {
    const u = userFromRequest(db, ctx.req);
    if (!u) throw new HttpError(401, 'Please sign in.');
    return u;
  };
  const requireAdmin = (ctx) => {
    const u = requireUser(ctx);
    if (!u.isAdmin) throw new HttpError(403, 'Only an admin can do that.');
    return u;
  };
  const secure = (ctx) => ctx.req.headers['x-forwarded-proto'] === 'https' || !!ctx.req.socket.encrypted;
  const userCount = () => db.get('SELECT COUNT(*) n FROM users').n;

  // ---------------------------------------------------------------- setup and sessions

  router.add('GET', '/api/setup', (ctx) => send(ctx.res, 200, { needsSetup: userCount() === 0, version: config.version }));

  router.add('POST', '/api/setup', async (ctx) => {
    if (userCount() > 0) throw new HttpError(409, 'Setup is already complete.');
    const b = await readJson(ctx.req);
    const username = str(b.username, 60)?.trim();
    if (!username) throw new HttpError(400, 'Choose a username.');
    validatePassword(b.password);
    const r = db.run('INSERT INTO users(username, password_hash, is_admin, created_at) VALUES (?, ?, 1, ?)',
      username, hashPassword(b.password), now());
    const token = createSession(db, Number(r.lastInsertRowid), ctx);
    audit(db, { user: { id: Number(r.lastInsertRowid), username }, action: 'setup', ip: ctx.ip });
    send(ctx.res, 201, { ok: true }, { 'Set-Cookie': sessionCookie(token, secure(ctx)) });
  });

  router.add('POST', '/api/login', async (ctx) => {
    checkLoginRate(ctx.ip);
    const b = await readJson(ctx.req);
    const user = db.get('SELECT * FROM users WHERE username = ?', String(b.username || '').trim());
    if (!user || !verifyPassword(String(b.password || ''), user.password_hash)) {
      recordLoginFailure(ctx.ip);
      audit(db, { user: user ? { id: user.id, username: user.username } : null, action: 'sign-in failed', target: String(b.username || '').slice(0, 60), ip: ctx.ip, detail: 'wrong password' });
      throw new HttpError(401, 'Wrong username or password.');
    }
    if (user.totp_enabled) {
      const code = String(b.code || '').trim().toLowerCase();
      if (!code) throw new HttpError(401, 'Enter the code from your authenticator app.', { totpRequired: true });
      let ok = verifyTotp(user.totp_secret, code);
      if (!ok && /^[a-z0-9]{4}-?[a-z0-9]{4}$/.test(code)) {
        const normalized = code.includes('-') ? code : `${code.slice(0, 4)}-${code.slice(4)}`;
        const r = db.run('DELETE FROM recovery_codes WHERE user_id = ? AND code_hash = ?', user.id, sha256hex(normalized));
        ok = r.changes > 0;
      }
      if (!ok) {
        recordLoginFailure(ctx.ip);
        audit(db, { user: { id: user.id, username: user.username }, action: 'sign-in failed', ip: ctx.ip, detail: 'wrong 2FA code' });
        throw new HttpError(401, 'That code is wrong or expired.', { totpRequired: true });
      }
    }
    if (b.app) {
      // Command Center in the ODC app: a year-long sign-in, returned to the app instead of a cookie.
      const token = createSession(db, user.id, ctx, { app: true, deviceName: b.deviceName });
      audit(db, { user: { id: user.id, username: user.username }, action: 'sign-in', ip: ctx.ip, detail: `ODC app${b.deviceName ? ` on ${String(b.deviceName).slice(0, 80)}` : ''}` });
      return send(ctx.res, 200, { ok: true, token, user: { id: user.id, username: user.username, isAdmin: user.is_admin === 1 } });
    }
    const token = createSession(db, user.id, ctx);
    audit(db, { user: { id: user.id, username: user.username }, action: 'sign-in', ip: ctx.ip, detail: String(ctx.req.headers['user-agent'] || '').slice(0, 200) });
    send(ctx.res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(token, secure(ctx)) });
  });

  router.add('POST', '/api/logout', (ctx) => {
    const u = userFromRequest(db, ctx.req);
    if (u) audit(db, { user: u, action: 'sign-out', ip: ctx.ip });
    destroySession(db, ctx.req);
    send(ctx.res, 200, { ok: true }, { 'Set-Cookie': clearCookie() });
  });

  router.add('GET', '/api/me', (ctx) => {
    const u = requireUser(ctx);
    const row = db.get('SELECT totp_enabled, prefs FROM users WHERE id = ?', u.id);
    send(ctx.res, 200, { ...u, totpEnabled: !!row.totp_enabled, prefs: safeJson(row.prefs) || {}, settings: publicSettings(getSettings(db)), version: config.version });
  });

  // ---------------------------------------------------------------- the app's notification inbox

  const notificationView = (n, base) => ({
    id: n.id, t: n.t, kind: n.kind, title: n.title, body: n.body, carId: n.car_id, eventId: n.event_id, read: !!n.read,
    // Photos through the signed-in API (the push copy carries a signed link instead).
    imageUrl: n.event_id && n.image ? `${base}/api/snapshots/${n.event_id}` : null,
  });

  router.add('GET', '/api/me/notifications', (ctx) => {
    const u = requireUser(ctx);
    const after = Number(ctx.query.get('after')) || 0;
    const limit = Math.min(200, Number(ctx.query.get('limit')) || 50);
    const rows = after
      ? db.all('SELECT * FROM notifications WHERE user_id = ? AND id > ? ORDER BY id LIMIT ?', u.id, after, limit)
      : db.all('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?', u.id, limit).reverse();
    const base = app.publicUrl(ctx.req);
    send(ctx.res, 200, { notifications: rows.map((n) => notificationView(n, base)), unread: db.get('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read = 0', u.id).n });
  });

  /** The app's direct connection: answers as soon as there's a notification after `after`, or with nothing after ~25 s. */
  router.add('GET', '/api/me/notifications/wait', (ctx) => {
    const u = requireUser(ctx);
    const after = Number(ctx.query.get('after')) || 0;
    const base = app.publicUrl(ctx.req);
    const answer = () => {
      const rows = db.all('SELECT * FROM notifications WHERE user_id = ? AND id > ? ORDER BY id LIMIT 50', u.id, after);
      if (!ctx.res.writableEnded) send(ctx.res, 200, { notifications: rows.map((n) => notificationView(n, base)) });
    };
    if (db.get('SELECT 1 FROM notifications WHERE user_id = ? AND id > ?', u.id, after)) return answer();
    const cancel = waitForNotification(u.id, Number(process.env.ODC_NOTIFY_WAIT_MS) || 25_000, () => answer());
    ctx.res.on('close', cancel);
  });

  router.add('POST', '/api/me/notifications/read', async (ctx) => {
    const u = requireUser(ctx);
    const b = await readJson(ctx.req);
    if (b.all) db.run('UPDATE notifications SET read = 1 WHERE user_id = ?', u.id);
    else for (const id of (Array.isArray(b.ids) ? b.ids : []).slice(0, 500)) db.run('UPDATE notifications SET read = 1 WHERE user_id = ? AND id = ?', u.id, Number(id));
    send(ctx.res, 200, { ok: true });
  });

  /** A test alert to this person: shows in their inbox, apps and browsers. */
  router.add('POST', '/api/me/notifications/test', async (ctx) => {
    const u = requireUser(ctx);
    await notify(db, { title: 'Open Dash Cam test alert', message: 'Alerts from your ODC Server arrive here.', userIds: [u.id], kind: 'test' });
    send(ctx.res, 200, { ok: true });
  });

  /** From an alert to its footage: the clip covering the event's moment (its own camera first), and where in it. */
  router.add('GET', '/api/events/:id/clip', (ctx) => {
    const u = requireUser(ctx);
    const ev = db.get('SELECT * FROM events WHERE id = ?', Number(ctx.params.id));
    if (!ev || !carRole(db, u, ev.car_id)) throw new HttpError(404, 'Event not found');
    const covering = db.all(`SELECT c.*, m.label AS camera_label FROM clips c JOIN cameras m ON m.id = c.camera_id
      WHERE c.car_id = ? AND c.started_at <= ? AND c.started_at + COALESCE(c.duration_ms, 180000) >= ? ORDER BY (c.camera_id = ?) DESC, c.started_at DESC`,
    ev.car_id, ev.t, ev.t, ev.camera_id || '');
    const data = safeJson(ev.data) || {};
    const base = app.publicUrl(ctx.req);
    send(ctx.res, 200, {
      eventId: ev.id, type: ev.type, t: ev.t, carId: ev.car_id, data,
      snapshotUrl: data.snapshot ? `${base}/api/snapshots/${ev.id}` : null,
      clips: covering.map((c) => ({ clipId: c.id, camera: c.camera_label, offsetMs: Math.max(0, ev.t - c.started_at), encrypted: !!c.encrypted,
        streamUrl: c.encrypted ? null : `${base}/api/clips/${c.id}/stream?st=${streamToken(db, c.id)}` })),
    });
  });

  /** Preview of this person's weekly summary (also sends it now with ?send=1). */
  router.add('GET', '/api/me/summary', (ctx) => {
    const u = requireUser(ctx);
    const s = buildSummary(db, u.id);
    if (ctx.query.get('send') === '1') notify(db, { title: s.title, message: s.message, tags: ['bar_chart'], userIds: [u.id], url: '/#/trips', priority: 2, kind: 'summary' });
    send(ctx.res, 200, s);
  });

  /** Display preferences, per person (follow them to any browser). */
  router.add('PUT', '/api/me/prefs', async (ctx) => {
    const u = requireUser(ctx);
    // Merge with what's saved, so each settings card only sends its own choices.
    const b = { ...(safeJson(db.get('SELECT prefs FROM users WHERE id = ?', u.id)?.prefs) || {}), ...(await readJson(ctx.req)) };
    const pick = (v, allowed, def) => (allowed.includes(v) ? v : def);
    const prefs = {
      theme: pick(b.theme, ['dark', 'light', 'system'], 'dark'),
      accent: pick(b.accent, ['orange', 'blue', 'green', 'purple', 'teal', 'red'], 'orange'),
      textSize: pick(Number(b.textSize), [100, 115, 130], 100),
      highContrast: !!b.highContrast,
      reduceMotion: !!b.reduceMotion,
      weeklySummary: !!b.weeklySummary,
      // Which alerts this person gets (in the app, browsers and their inbox); everything is on unless turned off.
      alerts: Object.fromEntries(ALERT_KINDS.map((k) => [k, b.alerts?.[k] !== false])),
      summaryDay: Math.min(6, Math.max(0, Math.round(Number(b.summaryDay ?? 0)) || 0)),
      summaryHour: Math.min(23, Math.max(0, Math.round(Number(b.summaryHour ?? 18)) || 0)),
    };
    db.run('UPDATE users SET prefs = ? WHERE id = ?', JSON.stringify(prefs), u.id);
    send(ctx.res, 200, prefs);
  });

  router.add('PUT', '/api/me/password', async (ctx) => {
    const u = requireUser(ctx);
    const b = await readJson(ctx.req);
    const row = db.get('SELECT password_hash FROM users WHERE id = ?', u.id);
    if (!verifyPassword(String(b.current || ''), row.password_hash)) throw new HttpError(400, 'Current password is wrong.');
    validatePassword(b.password);
    db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(b.password), u.id);
    // Sign out everywhere else.
    db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', u.id, currentSessionHash(ctx.req) || '');
    audit(db, { user: u, action: 'password changed', ip: ctx.ip });
    send(ctx.res, 200, { ok: true });
  });

  // ---------------------------------------------------------------- signed-in devices

  router.add('GET', '/api/me/sessions', (ctx) => {
    const u = requireUser(ctx);
    const cur = currentSessionHash(ctx.req);
    send(ctx.res, 200, db.all('SELECT token_hash, created_at, last_used_at, user_agent, ip FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_used_at DESC', u.id, now())
      .map((s) => ({ id: sessionId(s.token_hash), createdAt: s.created_at, lastUsedAt: s.last_used_at, userAgent: s.user_agent, ip: s.ip, current: s.token_hash === cur })));
  });

  router.add('DELETE', '/api/me/sessions/:id', (ctx) => {
    const u = requireUser(ctx);
    const row = db.all('SELECT token_hash FROM sessions WHERE user_id = ?', u.id).find((s) => sessionId(s.token_hash) === ctx.params.id);
    if (!row) throw new HttpError(404, 'Session not found');
    db.run('DELETE FROM sessions WHERE token_hash = ?', row.token_hash);
    audit(db, { user: u, action: 'signed out a device', target: ctx.params.id, ip: ctx.ip });
    send(ctx.res, 200, { ok: true });
  });

  router.add('POST', '/api/me/sessions/sign-out-others', (ctx) => {
    const u = requireUser(ctx);
    const r = db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', u.id, currentSessionHash(ctx.req) || '');
    audit(db, { user: u, action: 'signed out other devices', ip: ctx.ip, detail: `${r.changes} sessions` });
    send(ctx.res, 200, { ok: true, signedOut: r.changes });
  });

  // ---------------------------------------------------------------- audit log and backups (admin)

  router.add('GET', '/api/audit', (ctx) => {
    const u = requireUser(ctx);
    const q = ctx.query;
    const where = [];
    const params = [];
    if (!u.isAdmin) { where.push('user_id = ?'); params.push(u.id); }
    else if (q.get('user')) { where.push('username = ?'); params.push(q.get('user')); }
    if (q.get('action')) { where.push('action LIKE ?'); params.push(`%${q.get('action')}%`); }
    if (q.get('before')) { where.push('id < ?'); params.push(Number(q.get('before'))); }
    const rows = db.all(`SELECT * FROM audit ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`,
      ...params, Math.min(500, Number(q.get('limit')) || 200));
    send(ctx.res, 200, rows.map((r) => ({ id: r.id, t: r.t, user: r.username, action: r.action, target: r.target, ip: r.ip, detail: r.detail })));
  });

  router.add('GET', '/api/tls', (ctx) => {
    requireAdmin(ctx);
    send(ctx.res, 200, { fingerprint: app.tls.fingerprint, httpsPort: config.httpsPort, secure: !!ctx.req.socket.encrypted || ctx.req.headers['x-forwarded-proto'] === 'https' });
  });

  router.add('GET', '/api/backups', (ctx) => {
    requireAdmin(ctx);
    send(ctx.res, 200, listBackups(config.dataDir));
  });

  router.add('POST', '/api/backups', (ctx) => {
    const u = requireAdmin(ctx);
    const name = runBackup(db, config.dataDir);
    audit(db, { user: u, action: 'backup created', target: name, ip: ctx.ip });
    send(ctx.res, 201, { name, backups: listBackups(config.dataDir) });
  });

  router.add('GET', '/api/backups/:name', (ctx) => {
    const u = requireAdmin(ctx);
    const name = ctx.params.name;
    if (!/^odc-[\d-]+\.db$/.test(name)) throw new HttpError(400, 'Invalid name');
    audit(db, { user: u, action: 'backup downloaded', target: name, ip: ctx.ip });
    serveFile(ctx, path.join(backupDir(config.dataDir), name), 'application/octet-stream', { 'Content-Disposition': `attachment; filename="${name}"` });
  });

  // ---------------------------------------------------------------- two-factor sign-in

  router.add('POST', '/api/me/totp/setup', (ctx) => {
    const u = requireUser(ctx);
    const secret = newSecret();
    db.run('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?', secret, u.id);
    send(ctx.res, 200, { secret, otpauth: otpauthUrl(secret, u.username, getSettings(db).serverName || 'Open Dash Cam') });
  });

  router.add('POST', '/api/me/totp/enable', async (ctx) => {
    const u = requireUser(ctx);
    const b = await readJson(ctx.req);
    const row = db.get('SELECT totp_secret FROM users WHERE id = ?', u.id);
    if (!row.totp_secret || !verifyTotp(row.totp_secret, b.code)) throw new HttpError(400, 'That code is wrong. Check the time on your phone and try again.');
    const codes = newRecoveryCodes();
    db.tx(() => {
      db.run('UPDATE users SET totp_enabled = 1 WHERE id = ?', u.id);
      db.run('DELETE FROM recovery_codes WHERE user_id = ?', u.id);
      for (const c of codes) db.run('INSERT INTO recovery_codes(user_id, code_hash) VALUES (?, ?)', u.id, sha256hex(c));
    });
    audit(db, { user: u, action: '2FA turned on', ip: ctx.ip });
    send(ctx.res, 200, { recoveryCodes: codes });
  });

  router.add('POST', '/api/me/totp/disable', async (ctx) => {
    const u = requireUser(ctx);
    const b = await readJson(ctx.req);
    const row = db.get('SELECT password_hash FROM users WHERE id = ?', u.id);
    if (!verifyPassword(String(b.password || ''), row.password_hash)) throw new HttpError(400, 'Password is wrong.');
    db.run('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?', u.id);
    db.run('DELETE FROM recovery_codes WHERE user_id = ?', u.id);
    audit(db, { user: u, action: '2FA turned off', ip: ctx.ip });
    send(ctx.res, 200, { ok: true });
  });

  router.add('POST', '/api/me/totp/recovery', async (ctx) => {
    const u = requireUser(ctx);
    const b = await readJson(ctx.req);
    const row = db.get('SELECT password_hash, totp_enabled FROM users WHERE id = ?', u.id);
    if (!row.totp_enabled) throw new HttpError(400, 'Two-factor sign-in is off.');
    if (!verifyPassword(String(b.password || ''), row.password_hash)) throw new HttpError(400, 'Password is wrong.');
    const codes = newRecoveryCodes();
    db.tx(() => {
      db.run('DELETE FROM recovery_codes WHERE user_id = ?', u.id);
      for (const c of codes) db.run('INSERT INTO recovery_codes(user_id, code_hash) VALUES (?, ?)', u.id, sha256hex(c));
    });
    send(ctx.res, 200, { recoveryCodes: codes });
  });

  // ---------------------------------------------------------------- server settings (admin)

  const publicSettings = (s) => ({ serverName: s.serverName, units: s.units, mapStyleUrl: s.mapStyleUrl, plateLog: !!(s.plateSearch && s.plateLog), plateSearch: !!s.plateSearch });

  router.add('GET', '/api/settings', (ctx) => {
    requireAdmin(ctx);
    send(ctx.res, 200, getSettings(db));
  });

  router.add('PUT', '/api/settings', async (ctx) => {
    requireAdmin(ctx);
    const prev = getSettings(db);
    const before = prev.commuteLearning;
    saveSettings(db, await readJson(ctx.req));
    const after = getSettings(db);
    const changed = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(prev[k]) && k !== 'ntfyToken');
    if (changed.length) audit(db, { user: userFromRequest(db, ctx.req), action: 'server settings changed', ip: ctx.ip, detail: changed.map((k) => `${k}: ${JSON.stringify(prev[k])} → ${JSON.stringify(after[k])}`).join('; ') });
    if (after.smartSearch && (!prev.smartSearch || prev.mlUrl !== after.mlUrl)) app.analyzeNow?.();
    if (!after.plateSearch && after.plateLog) saveSettings(db, { plateLog: false }); // the log needs plate reading
    if (after.plateSearch) {
      purgeOldPlates(db);
      if (!prev.plateSearch) app.analyzeNow?.();
    }
    if (before !== after.commuteLearning) {
      for (const c of db.all('SELECT id FROM cars')) {
        if (after.commuteLearning) learnPlaces(db, c.id);
        else rebuildTrips(db, c.id, now() - 120 * 86400_000); // undo commute-based merging
      }
    }
    send(ctx.res, 200, after);
  });

  router.add('POST', '/api/settings/test-ntfy', async (ctx) => {
    requireAdmin(ctx);
    const ok = await notify(db, { title: 'Open Dash Cam test', message: 'Alerts from your ODC server will arrive here.', tags: ['white_check_mark'] });
    send(ctx.res, ok ? 200 : 502, { ok, error: ok ? undefined : 'Could not reach the ntfy URL.' });
  });

  router.add('GET', '/api/storage', async (ctx) => {
    requireUser(ctx);
    const used = db.get('SELECT COALESCE(SUM(size), 0) s FROM clips').s;
    let free = null;
    let total = null;
    try {
      const st = await fs.promises.statfs(config.dataDir);
      free = st.bavail * st.bsize;
      total = st.blocks * st.bsize;
    } catch { /* not supported */ }
    send(ctx.res, 200, { usedBytes: used, freeBytes: free, totalBytes: total, capGb: getSettings(db).storageCapGb });
  });

  // ---------------------------------------------------------------- users (admin)

  router.add('GET', '/api/users', (ctx) => {
    requireAdmin(ctx);
    send(ctx.res, 200, db.all(`SELECT u.id, u.username, u.is_admin AS isAdmin, u.totp_enabled AS totpEnabled, u.created_at AS createdAt,
        u.quota_gb AS quotaGb, (SELECT COALESCE(SUM(c.size), 0) FROM clips c JOIN cars k ON k.id = c.car_id WHERE k.owner_id = u.id) AS usedBytes
      FROM users u ORDER BY u.id`)
      .map((u) => ({ ...u, isAdmin: !!u.isAdmin, totpEnabled: !!u.totpEnabled })));
  });

  router.add('POST', '/api/users', async (ctx) => {
    requireAdmin(ctx);
    const b = await readJson(ctx.req);
    const username = str(b.username, 60)?.trim();
    if (!username) throw new HttpError(400, 'Username required.');
    validatePassword(b.password);
    if (db.get('SELECT id FROM users WHERE username = ?', username)) throw new HttpError(409, 'That username is taken.');
    db.run('INSERT INTO users(username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?)',
      username, hashPassword(b.password), b.isAdmin ? 1 : 0, now());
    audit(db, { user: userFromRequest(db, ctx.req), action: 'person added', target: username, ip: ctx.ip, detail: b.isAdmin ? 'admin' : null });
    send(ctx.res, 201, { ok: true });
  });

  router.add('PATCH', '/api/users/:id', async (ctx) => {
    const me = requireAdmin(ctx);
    const id = Number(ctx.params.id);
    const b = await readJson(ctx.req);
    const target = db.get('SELECT username FROM users WHERE id = ?', id)?.username;
    if (b.password !== undefined) {
      validatePassword(b.password);
      db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(b.password), id);
      db.run('DELETE FROM sessions WHERE user_id = ?', id);
      audit(db, { user: me, action: 'password reset by admin', target, ip: ctx.ip });
    }
    if (b.isAdmin !== undefined) audit(db, { user: me, action: b.isAdmin ? 'made admin' : 'removed admin', target, ip: ctx.ip });
    if (b.resetTotp) audit(db, { user: me, action: '2FA reset by admin', target, ip: ctx.ip });
    if (b.quotaGb !== undefined) audit(db, { user: me, action: 'storage limit changed', target, ip: ctx.ip, detail: String(b.quotaGb) });
    if (b.quotaGb !== undefined) {
      const v = b.quotaGb === null || b.quotaGb === '' || Number(b.quotaGb) <= 0 ? null : Number(b.quotaGb);
      db.run('UPDATE users SET quota_gb = ? WHERE id = ?', v, id);
      app.enforceRetention?.();
    }
    if (b.resetTotp) {
      db.run('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?', id);
      db.run('DELETE FROM recovery_codes WHERE user_id = ?', id);
    }
    if (b.isAdmin !== undefined) {
      if (id === me.id && !b.isAdmin) throw new HttpError(400, "You can't remove your own admin rights.");
      db.run('UPDATE users SET is_admin = ? WHERE id = ?', b.isAdmin ? 1 : 0, id);
    }
    send(ctx.res, 200, { ok: true });
  });

  router.add('DELETE', '/api/users/:id', (ctx) => {
    const me = requireAdmin(ctx);
    const id = Number(ctx.params.id);
    if (id === me.id) throw new HttpError(400, "You can't delete your own account.");
    const owned = db.get('SELECT COUNT(*) n FROM cars WHERE owner_id = ?', id).n;
    if (owned > 0) throw new HttpError(409, 'This user still owns cars. Delete or reassign them first.');
    audit(db, { user: me, action: 'person deleted', target: db.get('SELECT username FROM users WHERE id = ?', id)?.username, ip: ctx.ip });
    db.run('DELETE FROM users WHERE id = ?', id);
    send(ctx.res, 200, { ok: true });
  });

  // ---------------------------------------------------------------- cars, cameras, sharing, pairing

  const carView = (car, user) => {
    const cameras = db.all(`SELECT c.*, (SELECT COUNT(*) FROM clips k WHERE k.camera_id = c.id) AS clip_count,
        (SELECT COALESCE(SUM(size), 0) FROM clips k WHERE k.camera_id = c.id) AS clip_bytes
      FROM cameras c WHERE c.car_id = ? ORDER BY c.created_at`, car.id)
      .map((c) => ({
        id: c.id, label: c.label, deviceModel: c.device_model, appVersion: c.app_version, lastSeenAt: c.last_seen_at,
        battery: c.battery, charging: !!c.charging, thermal: c.thermal, storageFree: c.storage_free,
        recording: !!c.recording, mode: c.mode,
        kind: c.token_hash.startsWith('viofo:') ? 'dashcam' : 'phone',
        disconnected: c.token_hash.startsWith('revoked:'),
        clips: c.clip_count, bytes: c.clip_bytes,
      }))
      // A disconnected phone stays listed only while it still has footage on the server.
      .filter((c) => !(c.disconnected && c.clips === 0));
    const shares = db.all('SELECT s.user_id AS userId, u.username, s.role FROM car_shares s JOIN users u ON u.id = s.user_id WHERE s.car_id = ?', car.id);
    const stats = db.get('SELECT COUNT(*) n, COALESCE(SUM(size), 0) bytes, MAX(started_at) last FROM clips WHERE car_id = ?', car.id);
    const owner = db.get('SELECT username FROM users WHERE id = ?', car.owner_id);
    return {
      id: car.id, name: car.name, owner: owner?.username, role: carRole(db, user, car.id),
      mismatchPolicy: car.mismatch_policy, truthCameraId: car.truth_camera_id,
      retentionDays: car.retention_days, storageCapGb: car.storage_cap_gb, speedAlertKmh: car.speed_alert_kmh,
      viofoUrl: car.viofo_url || null, viofoFolders: (car.viofo_folders || 'movie,parking,ro').split(','), viofoStatus: safeJson(car.viofo_status),
      viofoLenses: (car.viofo_lenses || 'F,R,I').split(','), viofoStream: car.viofo_stream || null,
      cameras, shares, clipCount: stats.n, clipBytes: stats.bytes, lastClipAt: stats.last,
      live: carLive(db, car),
    };
  };

  router.add('GET', '/api/cars', (ctx) => {
    const u = requireUser(ctx);
    const ids = visibleCarIds(db, u);
    const cars = ids.map((id) => db.get('SELECT * FROM cars WHERE id = ?', id)).filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
    send(ctx.res, 200, cars.map((c) => carView(c, u)));
  });

  router.add('POST', '/api/cars', async (ctx) => {
    const u = requireUser(ctx);
    const b = await readJson(ctx.req);
    const name = str(b.name, 60)?.trim();
    if (!name) throw new HttpError(400, 'Give the car a name.');
    const r = db.run('INSERT INTO cars(owner_id, name, created_at) VALUES (?, ?, ?)', u.id, name, now());
    audit(db, { user: u, action: 'car added', target: name, ip: ctx.ip });
    send(ctx.res, 201, carView(db.get('SELECT * FROM cars WHERE id = ?', Number(r.lastInsertRowid)), u));
  });

  router.add('PATCH', '/api/cars/:id', async (ctx) => {
    const u = requireUser(ctx);
    const id = Number(ctx.params.id);
    requireCarRole(db, u, id, true);
    const b = await readJson(ctx.req);
    if (b.name !== undefined) db.run('UPDATE cars SET name = ? WHERE id = ?', str(b.name, 60) || 'Car', id);
    if (b.mismatchPolicy !== undefined) {
      if (!['alert', 'source', 'average'].includes(b.mismatchPolicy)) throw new HttpError(400, 'Invalid policy');
      db.run('UPDATE cars SET mismatch_policy = ? WHERE id = ?', b.mismatchPolicy, id);
    }
    if (b.viofoUrl !== undefined) {
      let v = String(b.viofoUrl || '').trim().replace(/\/$/, '');
      if (v && !/^https?:\/\//i.test(v)) v = `http://${v}`;
      if (v) { try { new URL(v); } catch { throw new HttpError(400, 'Enter the camera’s address, e.g. 192.168.1.60'); } }
      db.run('UPDATE cars SET viofo_url = ?, viofo_status = NULL WHERE id = ?', v || null, id);
      audit(db, { user: u, action: v ? 'Viofo import set up' : 'Viofo import turned off', target: db.get('SELECT name FROM cars WHERE id = ?', id)?.name, ip: ctx.ip, detail: v || null });
    }
    if (b.viofoStream !== undefined) {
      const v = String(b.viofoStream || '').trim();
      if (v && !/^(rtsp|rtsps|http|https):\/\//i.test(v)) throw new HttpError(400, 'The live stream address should start with rtsp://');
      db.run('UPDATE cars SET viofo_stream = ? WHERE id = ?', v || null, id);
    }
    if (b.viofoLenses !== undefined) {
      const l = (Array.isArray(b.viofoLenses) ? b.viofoLenses : []).filter((x) => ['F', 'R', 'I'].includes(x));
      db.run('UPDATE cars SET viofo_lenses = ? WHERE id = ?', (l.length ? l : ['F', 'R', 'I']).join(','), id);
    }
    if (b.viofoFolders !== undefined) {
      const f = (Array.isArray(b.viofoFolders) ? b.viofoFolders : []).filter((x) => ['movie', 'parking', 'ro'].includes(x));
      db.run('UPDATE cars SET viofo_folders = ? WHERE id = ?', (f.length ? f : ['movie', 'parking', 'ro']).join(','), id);
    }
    if (b.speedAlertKmh !== undefined) {
      const v = b.speedAlertKmh === null || b.speedAlertKmh === '' || Number(b.speedAlertKmh) <= 0 ? null : Math.min(400, Number(b.speedAlertKmh));
      db.run('UPDATE cars SET speed_alert_kmh = ? WHERE id = ?', v, id);
      audit(db, { user: u, action: 'speed alert changed', target: db.get('SELECT name FROM cars WHERE id = ?', id)?.name, ip: ctx.ip, detail: v == null ? 'off' : `${v} km/h` });
    }
    if (b.retentionDays !== undefined) {
      const v = b.retentionDays === null || b.retentionDays === '' ? null : Math.max(0, Math.round(Number(b.retentionDays) || 0));
      db.run('UPDATE cars SET retention_days = ? WHERE id = ?', v, id);
    }
    if (b.storageCapGb !== undefined) {
      const v = b.storageCapGb === null || b.storageCapGb === '' || Number(b.storageCapGb) <= 0 ? null : Number(b.storageCapGb);
      db.run('UPDATE cars SET storage_cap_gb = ? WHERE id = ?', v, id);
    }
    if (b.retentionDays !== undefined || b.storageCapGb !== undefined) app.enforceRetention?.();
    if (b.truthCameraId !== undefined) {
      const ok = b.truthCameraId === null || db.get('SELECT id FROM cameras WHERE id = ? AND car_id = ?', b.truthCameraId, id);
      if (!ok) throw new HttpError(400, 'That camera is not in this car.');
      db.run('UPDATE cars SET truth_camera_id = ? WHERE id = ?', b.truthCameraId, id);
      markTripsDirty(id, 0);
    }
    send(ctx.res, 200, carView(db.get('SELECT * FROM cars WHERE id = ?', id), u));
  });

  router.add('DELETE', '/api/cars/:id', async (ctx) => {
    const u = requireUser(ctx);
    const id = Number(ctx.params.id);
    if (requireCarRole(db, u, id) !== 'owner') throw new HttpError(403, 'Only the owner can delete a car.');
    if (ctx.query.get('confirm') !== 'delete-footage') throw new HttpError(400, 'Confirmation required.');
    audit(db, { user: u, action: 'car deleted with its footage', target: db.get('SELECT name FROM cars WHERE id = ?', id)?.name, ip: ctx.ip });
    for (const c of db.all('SELECT id, path FROM clips WHERE car_id = ?', id)) app.deleteClipFiles(c);
    db.run('DELETE FROM points WHERE car_id = ?', id);
    db.run('DELETE FROM live WHERE car_id = ?', id);
    db.run('DELETE FROM events WHERE car_id = ?', id);
    db.run('DELETE FROM cars WHERE id = ?', id);
    send(ctx.res, 200, { ok: true });
  });

  router.add('POST', '/api/cars/:id/shares', async (ctx) => {
    const u = requireUser(ctx);
    const id = Number(ctx.params.id);
    if (requireCarRole(db, u, id) !== 'owner') throw new HttpError(403, 'Only the owner can share a car.');
    const b = await readJson(ctx.req);
    const target = db.get('SELECT id FROM users WHERE username = ?', String(b.username || '').trim());
    if (!target) throw new HttpError(404, 'No user with that name.');
    if (target.id === u.id) throw new HttpError(400, 'You already own this car.');
    const role = b.role === 'manager' ? 'manager' : 'viewer';
    db.run('INSERT INTO car_shares(car_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT(car_id, user_id) DO UPDATE SET role = excluded.role',
      id, target.id, role);
    audit(db, { user: u, action: 'car shared', target: `${db.get('SELECT name FROM cars WHERE id = ?', id)?.name} → ${b.username}`, ip: ctx.ip, detail: role });
    send(ctx.res, 200, { ok: true });
  });

  router.add('DELETE', '/api/cars/:id/shares/:userId', (ctx) => {
    const u = requireUser(ctx);
    const id = Number(ctx.params.id);
    if (requireCarRole(db, u, id) !== 'owner') throw new HttpError(403, 'Only the owner can change sharing.');
    db.run('DELETE FROM car_shares WHERE car_id = ? AND user_id = ?', id, Number(ctx.params.userId));
    audit(db, { user: u, action: 'car unshared', target: `${db.get('SELECT name FROM cars WHERE id = ?', id)?.name} → ${db.get('SELECT username FROM users WHERE id = ?', Number(ctx.params.userId))?.username}`, ip: ctx.ip });
    send(ctx.res, 200, { ok: true });
  });

  /** One-time pairing code; the QR code contains {"odc":1,"url":...,"code":...}. */
  router.add('POST', '/api/cars/:id/pairing', async (ctx) => {
    const u = requireUser(ctx);
    const id = Number(ctx.params.id);
    requireCarRole(db, u, id, true);
    const b = await readJson(ctx.req);
    const code = newPairingCode();
    const expiresAt = now() + 10 * 60_000;
    db.run('DELETE FROM pairing_codes WHERE expires_at < ? OR used = 1', now());
    db.run('INSERT INTO pairing_codes(code_hash, car_id, label, created_by, expires_at) VALUES (?, ?, ?, ?, ?)',
      sha256hex(code), id, str(b.label, 40) || 'Camera', u.id, expiresAt);
    const url = app.publicUrl(ctx.req);
    const home = getSettings(db).homeUrl.replace(/\/$/, '') || null;
    const fp = app.tls.fingerprint;
    audit(db, { user: u, action: 'pairing code created', target: db.get('SELECT name FROM cars WHERE id = ?', id)?.name, ip: ctx.ip });
    send(ctx.res, 201, { code, expiresAt, url, homeUrl: home, fingerprint: fp, qr: JSON.stringify({ odc: 1, url, code, ...(home ? { home } : {}), fp }) });
  });

  const cameraWithRole = (u, cameraId, manage) => {
    const cam = db.get('SELECT * FROM cameras WHERE id = ?', cameraId);
    if (!cam) throw new HttpError(404, 'Camera not found');
    requireCarRole(db, u, cam.car_id, manage);
    return cam;
  };

  router.add('PATCH', '/api/cameras/:id', async (ctx) => {
    const u = requireUser(ctx);
    const cam = cameraWithRole(u, ctx.params.id, true);
    const b = await readJson(ctx.req);
    if (b.label !== undefined) db.run('UPDATE cameras SET label = ? WHERE id = ?', str(b.label, 40) || 'Camera', cam.id);
    send(ctx.res, 200, { ok: true });
  });

  /**
   * Without ?purge=1: disconnects the phone (it can't upload any more); its footage stays, and it stays listed until
   * that footage is gone. With ?purge=1: deletes the camera and all its footage (GPS history and trips are kept).
   */
  router.add('DELETE', '/api/cameras/:id', (ctx) => {
    const u = requireUser(ctx);
    const cam = cameraWithRole(u, ctx.params.id, true);
    if (ctx.query.get('purge') === '1') {
      const clips = db.all('SELECT id, path FROM clips WHERE camera_id = ?', cam.id);
      for (const c of clips) app.deleteClipFiles(c);
      db.run('DELETE FROM clips WHERE camera_id = ?', cam.id);
      db.run('DELETE FROM live WHERE camera_id = ?', cam.id);
      db.run('DELETE FROM cameras WHERE id = ?', cam.id);
      audit(db, { user: u, action: 'camera deleted with its footage', target: cam.label, ip: ctx.ip, detail: `${clips.length} clips` });
      return send(ctx.res, 200, { ok: true, deletedClips: clips.length });
    }
    db.run('UPDATE cameras SET token_hash = ? WHERE id = ?', 'revoked:' + cam.id + ':' + now(), cam.id);
    audit(db, { user: u, action: 'phone disconnected', target: cam.label, ip: ctx.ip });
    db.run('DELETE FROM live WHERE camera_id = ?', cam.id);
    send(ctx.res, 200, { ok: true });
  });

  // ---------------------------------------------------------------- clips

  const clipView = (c) => ({
    id: c.id, carId: c.car_id, carName: c.car_name, cameraId: c.camera_id, camera: c.camera_label, stream: c.stream,
    fileName: c.file_name, startedAt: c.started_at, durationMs: c.duration_ms, size: c.size, sha256: c.sha256,
    codec: c.codec, width: c.width, height: c.height, fps: c.fps, mode: c.mode, locked: !!c.locked,
    lockReason: c.lock_reason, encrypted: !!c.encrypted, hasTrack: !!c.has_track, hasThumb: !!c.has_thumb,
    lat: c.lat, lon: c.lon, place: c.place, trimmedFrom: c.trimmed_from,
  });

  const CLIP_SELECT = `SELECT c.*, k.name AS car_name, m.label AS camera_label FROM clips c
    JOIN cars k ON k.id = c.car_id JOIN cameras m ON m.id = c.camera_id`;

  router.add('GET', '/api/clips', (ctx) => {
    const u = requireUser(ctx);
    const q = ctx.query;
    const cars = visibleCarIds(db, u);
    if (!cars.length) return send(ctx.res, 200, { clips: [], total: 0 });
    const where = [`c.car_id IN (${cars.map(() => '?').join(',')})`];
    const params = [...cars];
    if (q.get('car')) { where.push('c.car_id = ?'); params.push(Number(q.get('car'))); }
    if (q.get('camera')) { where.push('c.camera_id = ?'); params.push(q.get('camera')); }
    if (q.get('locked') === '1') where.push('c.locked = 1');
    if (q.get('impact') === '1') where.push(`c.lock_reason = 'impact'`);
    if (q.get('parking') === '1') where.push(`c.mode LIKE 'parking%'`);
    if (q.get('from')) { where.push('c.started_at >= ?'); params.push(Number(q.get('from'))); }
    if (q.get('to')) { where.push('c.started_at <= ?'); params.push(Number(q.get('to'))); }
    const order = q.get('order') === 'asc' ? 'ASC' : 'DESC';
    const sorts = {
      date: `c.started_at ${order}`,
      size: `c.size ${order}, c.started_at DESC`,
      car: `k.name ${order}, c.started_at DESC`,
      camera: `m.label ${order}, c.started_at DESC`,
      location: `c.lat IS NULL, c.lat ${order}, c.lon ${order}, c.started_at DESC`,
    };
    const sort = sorts[q.get('sort')] || sorts.date;
    const limit = Math.min(500, Number(q.get('limit')) || 100);
    const offset = Number(q.get('offset')) || 0;
    const w = where.join(' AND ');
    const total = db.get(`SELECT COUNT(*) n FROM clips c WHERE ${w}`, ...params).n;
    const rows = db.all(`${CLIP_SELECT} WHERE ${w} ORDER BY ${sort} LIMIT ? OFFSET ?`, ...params, limit, offset);
    send(ctx.res, 200, { clips: rows.map(clipView), total });
  });

  const clipFor = (u, id, manage = false) => {
    const c = db.get(`${CLIP_SELECT} WHERE c.id = ?`, id);
    if (!c) throw new HttpError(404, 'Clip not found');
    requireCarRole(db, u, c.car_id, manage);
    return c;
  };

  router.add('GET', '/api/clips/:id', (ctx) => {
    const u = requireUser(ctx);
    const c = clipFor(u, ctx.params.id);
    send(ctx.res, 200, { ...clipView(c), streamToken: streamToken(db, c.id) });
  });

  router.add('PATCH', '/api/clips/:id', async (ctx) => {
    const u = requireUser(ctx);
    const c = clipFor(u, ctx.params.id, true);
    const b = await readJson(ctx.req);
    if (b.locked !== undefined) db.run('UPDATE clips SET locked = ?, lock_reason = ? WHERE id = ?', b.locked ? 1 : 0, b.locked ? (c.lock_reason || 'user') : null, c.id);
    send(ctx.res, 200, clipView(db.get(`${CLIP_SELECT} WHERE c.id = ?`, c.id)));
  });

  router.add('DELETE', '/api/clips/:id', (ctx) => {
    const u = requireUser(ctx);
    const c = clipFor(u, ctx.params.id, true);
    app.deleteClipFiles(c);
    db.run('DELETE FROM clips WHERE id = ?', c.id);
    audit(db, { user: u, action: 'clip deleted', target: `${c.car_name} · ${c.file_name}`, ip: ctx.ip });
    send(ctx.res, 200, { ok: true });
  });

  /** Media requests accept either a session cookie or a stream token (for external players / the phone app). */
  const clipForMedia = (ctx) => {
    const id = ctx.params.id;
    const st = ctx.query.get('st');
    if (st && checkStreamToken(db, id, st)) {
      const c = db.get('SELECT * FROM clips WHERE id = ?', id);
      if (!c) throw new HttpError(404, 'Clip not found');
      return c;
    }
    return clipFor(requireUser(ctx), id);
  };

  router.add('GET', '/api/clips/:id/thumb', (ctx) => {
    const c = clipForMedia(ctx);
    const p = thumbPath(c.id);
    if (!fs.existsSync(p)) throw new HttpError(404, 'No thumbnail');
    serveFile(ctx, p, 'image/jpeg', { 'Cache-Control': 'private, max-age=86400' });
  });

  router.add('GET', '/api/clips/:id/stream', async (ctx) => {
    const c = clipForMedia(ctx);
    if (c.encrypted) {
      const plain = decryptedPath(c.id);
      if (ctx.query.get('decrypted') === '1' && fs.existsSync(plain)) return serveFile(ctx, plain, 'video/mp4');
      throw new HttpError(415, 'This clip is encrypted. Enter the passphrase to play it, or download it and use odc_decrypt.');
    }
    if (ctx.query.get('codec') === 'h264' && c.codec !== 'h264') {
      const p = h264Path(c.id);
      if (!fs.existsSync(p)) {
        app.transcode(c);
        return send(ctx.res, 202, { status: 'transcoding' }, { 'Retry-After': '5' });
      }
      return serveFile(ctx, p, 'video/mp4');
    }
    serveFile(ctx, c.path, 'video/mp4');
  });

  router.add('GET', '/api/clips/:id/download', (ctx) => {
    const c = clipForMedia(ctx);
    serveFile(ctx, c.path, c.encrypted ? 'application/octet-stream' : 'video/mp4', {
      'Content-Disposition': `attachment; filename="${c.file_name.replace(/"/g, '')}"`,
    });
  });

  router.add('GET', '/api/clips/:id/track', (ctx) => {
    const u = requireUser(ctx);
    const c = clipFor(u, ctx.params.id);
    const end = c.started_at + (c.duration_ms || 180_000);
    send(ctx.res, 200, db.all('SELECT t, lat, lon, speed, course FROM points WHERE camera_id = ? AND t BETWEEN ? AND ? ORDER BY t',
      c.camera_id, c.started_at - 1000, end + 1000));
  });

  // ---------------------------------------------------------------- map, trips, events

  router.add('GET', '/api/live', (ctx) => {
    const u = requireUser(ctx);
    const cars = visibleCarIds(db, u).map((id) => db.get('SELECT * FROM cars WHERE id = ?', id)).filter(Boolean);
    send(ctx.res, 200, cars.map((car) => ({
      id: car.id, name: car.name, position: carLive(db, car),
      cameras: db.all('SELECT id, label, last_seen_at AS lastSeenAt, recording, battery, charging FROM cameras WHERE car_id = ?', car.id)
        .map((c) => ({ ...c, recording: !!c.recording, charging: !!c.charging })),
    })));
  });

  router.add('GET', '/api/cars/:id/route', (ctx) => {
    const u = requireUser(ctx);
    const id = Number(ctx.params.id);
    requireCarRole(db, u, id);
    const from = Number(ctx.query.get('from')) || now() - 86400_000;
    const to = Number(ctx.query.get('to')) || now();
    if (to - from > 31 * 86400_000) throw new HttpError(400, 'Choose a range of 31 days or less.');
    send(ctx.res, 200, simplify(routePoints(db, id, from, to), 5000));
  });

  router.add('GET', '/api/trips', (ctx) => {
    const u = requireUser(ctx);
    const cars = visibleCarIds(db, u);
    if (!cars.length) return send(ctx.res, 200, []);
    const params = [...cars];
    let where = `t.car_id IN (${cars.map(() => '?').join(',')})`;
    if (ctx.query.get('car')) { where += ' AND t.car_id = ?'; params.push(Number(ctx.query.get('car'))); }
    const rows = db.all(`SELECT t.*, k.name AS car_name FROM trips t JOIN cars k ON k.id = t.car_id WHERE ${where}
      ORDER BY t.start_t DESC LIMIT ?`, ...params, Math.min(500, Number(ctx.query.get('limit')) || 100));
    send(ctx.res, 200, rows.map(tripView));
  });

  router.add('GET', '/api/trips/:id', (ctx) => {
    const u = requireUser(ctx);
    const t = db.get('SELECT t.*, k.name AS car_name FROM trips t JOIN cars k ON k.id = t.car_id WHERE t.id = ?', Number(ctx.params.id));
    if (!t) throw new HttpError(404, 'Trip not found');
    requireCarRole(db, u, t.car_id);
    const clips = db.all(`${CLIP_SELECT} WHERE c.car_id = ? AND c.started_at BETWEEN ? AND ? ORDER BY c.started_at`,
      t.car_id, t.start_t - 10 * 60_000, t.end_t).map(clipView);
    const drivingEvents = db.all(`SELECT id, type, t, data FROM events WHERE car_id = ? AND t BETWEEN ? AND ?
      AND type IN ('hard_brake', 'hard_accel', 'sharp_turn', 'speeding', 'impact') ORDER BY t`, t.car_id, t.start_t, t.end_t)
      .map((e) => ({ id: e.id, type: e.type, t: e.t, data: safeJson(e.data) }));
    send(ctx.res, 200, { ...tripView(t), route: simplify(routePoints(db, t.car_id, t.start_t, t.end_t), 3000), clips, events: drivingEvents });
  });

  router.add('PATCH', '/api/trips/:id', async (ctx) => {
    const u = requireUser(ctx);
    const t = db.get('SELECT * FROM trips WHERE id = ?', Number(ctx.params.id));
    if (!t) throw new HttpError(404, 'Trip not found');
    requireCarRole(db, u, t.car_id, true);
    const b = await readJson(ctx.req);
    db.run('UPDATE trips SET name = ? WHERE id = ?', str(b.name, 80) || null, t.id);
    send(ctx.res, 200, { ok: true });
  });

  router.add('POST', '/api/trips/:id/split', async (ctx) => {
    const u = requireUser(ctx);
    const t = db.get('SELECT * FROM trips WHERE id = ?', Number(ctx.params.id));
    if (!t) throw new HttpError(404, 'Trip not found');
    requireCarRole(db, u, t.car_id, true);
    const b = await readJson(ctx.req);
    const at = Number(b.t);
    if (!(at > t.start_t && at < t.end_t)) throw new HttpError(400, 'Pick a time inside the trip.');
    splitTrip(db, t, at);
    send(ctx.res, 200, tripsAround(t.car_id, t.start_t, t.end_t));
  });

  router.add('POST', '/api/trips/:id/merge', async (ctx) => {
    const u = requireUser(ctx);
    const t = db.get('SELECT * FROM trips WHERE id = ?', Number(ctx.params.id));
    if (!t) throw new HttpError(404, 'Trip not found');
    requireCarRole(db, u, t.car_id, true);
    const b = await readJson(ctx.req);
    const other = b.with === 'prev'
      ? db.get('SELECT * FROM trips WHERE car_id = ? AND end_t <= ? ORDER BY end_t DESC LIMIT 1', t.car_id, t.start_t)
      : db.get('SELECT * FROM trips WHERE car_id = ? AND start_t >= ? ORDER BY start_t LIMIT 1', t.car_id, t.end_t);
    if (!other) throw new HttpError(400, b.with === 'prev' ? 'There is no earlier trip.' : 'There is no later trip.');
    const [a, c] = b.with === 'prev' ? [other, t] : [t, other];
    mergeTrips(db, a, c);
    send(ctx.res, 200, tripsAround(t.car_id, a.start_t, c.end_t));
  });

  const tripsAround = (carId, from, to) => db.all(
    'SELECT t.*, k.name AS car_name FROM trips t JOIN cars k ON k.id = t.car_id WHERE t.car_id = ? AND t.end_t >= ? AND t.start_t <= ? ORDER BY t.start_t',
    carId, from, to).map(tripView);

  router.add('GET', '/api/cars/:id/places', (ctx) => {
    const u = requireUser(ctx);
    const id = Number(ctx.params.id);
    requireCarRole(db, u, id);
    send(ctx.res, 200, db.all('SELECT id, lat, lon, visits, kind, label, custom_label AS customLabel FROM places WHERE car_id = ? ORDER BY visits DESC', id));
  });

  router.add('PATCH', '/api/places/:id', async (ctx) => {
    const u = requireUser(ctx);
    const place = db.get('SELECT * FROM places WHERE id = ?', Number(ctx.params.id));
    if (!place) throw new HttpError(404, 'Place not found');
    requireCarRole(db, u, place.car_id, true);
    const b = await readJson(ctx.req);
    const label = str(b.label, 60)?.trim();
    db.run('UPDATE places SET label = ?, custom_label = ? WHERE id = ?', label || null, label ? 1 : 0, place.id);
    relabelTrips(db, place.car_id);
    send(ctx.res, 200, { ok: true });
  });

  /** Everything needed to play all of a car's cameras in sync over a time range. */
  router.add('GET', '/api/cars/:id/sync', (ctx) => {
    const u = requireUser(ctx);
    const id = Number(ctx.params.id);
    requireCarRole(db, u, id);
    const from = Number(ctx.query.get('from'));
    const to = Number(ctx.query.get('to')) || from + 30 * 60_000;
    if (!from || to <= from || to - from > 12 * 3600_000) throw new HttpError(400, 'Choose a range up to 12 hours.');
    const cameras = db.all('SELECT id, label FROM cameras WHERE car_id = ? ORDER BY created_at', id);
    // Include clips that started up to 10 minutes before the range, since they may overlap it.
    const clips = db.all(`${CLIP_SELECT} WHERE c.car_id = ? AND c.encrypted = 0 AND c.started_at BETWEEN ? AND ? ORDER BY c.started_at`,
      id, from - 10 * 60_000, to).map(clipView)
      .filter((c) => c.startedAt + (c.durationMs || 180_000) >= from);
    send(ctx.res, 200, { cameras, clips, route: simplify(routePoints(db, id, from, to), 4000), from, to });
  });

  // ---------------------------------------------------------------- setup checklist

  router.add('GET', '/api/checklist', async (ctx) => {
    const u = requireUser(ctx);
    const s = getSettings(db);
    const cars = visibleCarIds(db, u);
    const ph = cars.map(() => '?').join(',') || 'NULL';
    const has = (sql, ...p) => !!db.get(sql, ...p);
    const secureNow = !!ctx.req.socket.encrypted || ctx.req.headers['x-forwarded-proto'] === 'https';
    const items = [
      { key: 'car', title: 'Add a car', done: cars.length > 0, link: '#/cars' },
      { key: 'phone', title: 'Connect a phone', hint: 'Cars → Connect a phone, then scan the code in ODC on the phone.', done: has(`SELECT 1 FROM cameras WHERE car_id IN (${ph})`, ...cars), link: '#/cars' },
      { key: 'clip', title: 'Receive the first clip', hint: 'Phones upload on Wi-Fi once backup to the server is on (ODC → Settings → ODC Server).', done: has(`SELECT 1 FROM clips WHERE car_id IN (${ph})`, ...cars), link: '#/timeline' },
      { key: 'gps', title: 'Turn on GPS logging', hint: 'ODC → Settings → Location. Needed for the map, trips and place names.', done: has(`SELECT 1 FROM points WHERE car_id IN (${ph}) LIMIT 1`, ...cars), link: '#/map' },
      { key: 'alerts', title: 'Get alerts', hint: 'Turn on notifications in this browser, or set up ntfy (Settings).', done: !!s.ntfyUrl || has('SELECT 1 FROM push_subs WHERE user_id = ?', u.id), link: '#/settings' },
      { key: 'twofa', title: 'Turn on two-factor sign-in', hint: 'Recommended if the server is reachable from the internet.', done: !!db.get('SELECT totp_enabled FROM users WHERE id = ?', u.id)?.totp_enabled, link: '#/settings' },
      { key: 'https', title: 'Use HTTPS', hint: 'See the server README: automatic Let’s Encrypt certificates or the built-in HTTPS.', done: secureNow || (process.env.ODC_PUBLIC_URL || '').startsWith('https://'), link: '#/settings' },
    ];
    if (u.isAdmin) items.push({ key: 'backups', title: 'Database backups on', hint: 'Settings → Database backups. Copy the backups folder to another disk too.', done: s.backupEnabled, link: '#/settings' });
    send(ctx.res, 200, items);
  });

  // ---------------------------------------------------------------- calendar, bulk actions, downloads, trimming

  /** Footage per day for a month: { "2026-10-03": { count, bytes, impact, locked } }. Days are in the server's time zone. */
  router.add('GET', '/api/clips/calendar', (ctx) => {
    const u = requireUser(ctx);
    const cars = visibleCarIds(db, u);
    const month = String(ctx.query.get('month') || new Date().toISOString().slice(0, 7));
    if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, 'month must look like 2026-10');
    const [y, m] = month.split('-').map(Number);
    const from = new Date(y, m - 1, 1).getTime();
    const to = new Date(y, m, 1).getTime();
    const out = {};
    if (cars.length) {
      const params = [...cars, from, to];
      let carFilter = '';
      if (ctx.query.get('car')) { carFilter = ' AND car_id = ?'; params.push(Number(ctx.query.get('car'))); }
      for (const c of db.all(`SELECT started_at, size, locked, lock_reason FROM clips WHERE car_id IN (${cars.map(() => '?').join(',')})
          AND started_at >= ? AND started_at < ?${carFilter}`, ...params)) {
        const d = new Date(c.started_at);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const e = (out[key] ||= { count: 0, bytes: 0, impact: false, locked: 0 });
        e.count++;
        e.bytes += c.size;
        if (c.locked) e.locked++;
        if (c.lock_reason === 'impact') e.impact = true;
      }
    }
    send(ctx.res, 200, { month, days: out });
  });

  router.add('POST', '/api/clips/bulk', async (ctx) => {
    const u = requireUser(ctx);
    const b = await readJson(ctx.req);
    const ids = (Array.isArray(b.ids) ? b.ids : []).slice(0, 2000).map(String);
    if (!['lock', 'unlock', 'delete'].includes(b.action)) throw new HttpError(400, 'action must be lock, unlock or delete');
    let done = 0;
    let skipped = 0;
    for (const id of ids) {
      const c = db.get(`${CLIP_SELECT} WHERE c.id = ?`, id);
      const role = c && carRole(db, u, c.car_id);
      if (!c || !role || role === 'viewer') { skipped++; continue; }
      if (b.action === 'delete') {
        app.deleteClipFiles(c);
        db.run('DELETE FROM clips WHERE id = ?', c.id);
      } else {
        db.run('UPDATE clips SET locked = ?, lock_reason = ? WHERE id = ?', b.action === 'lock' ? 1 : 0, b.action === 'lock' ? (c.lock_reason || 'user') : null, c.id);
      }
      done++;
    }
    audit(db, { user: u, action: b.action === 'delete' ? 'clips deleted' : b.action === 'lock' ? 'clips locked' : 'clips unlocked', ip: ctx.ip, detail: `${done} clips` });
    send(ctx.res, 200, { done, skipped });
  });

  // Short-lived download links, so a big ZIP or a trimmed clip can be fetched with a plain link.
  const downloads = new Map(); // token -> { userId, expires, kind, ... }
  const issueDownload = (u, data) => {
    const token = randomToken(24);
    downloads.set(token, { userId: u.id, expires: now() + 15 * 60_000, ...data });
    for (const [k, v] of downloads) if (v.expires < now()) downloads.delete(k);
    return `/api/downloads/${token}`;
  };

  router.add('POST', '/api/clips/zip', async (ctx) => {
    const u = requireUser(ctx);
    const b = await readJson(ctx.req);
    const ids = (Array.isArray(b.ids) ? b.ids : []).slice(0, 2000).map(String);
    const clips = ids.map((id) => db.get(`${CLIP_SELECT} WHERE c.id = ?`, id)).filter((c) => c && carRole(db, u, c.car_id));
    if (!clips.length) throw new HttpError(400, 'No clips selected.');
    const total = clips.reduce((a, c) => a + c.size, 0);
    if (total > ZIP_LIMIT) throw new HttpError(413, `That’s ${(total / 1024 ** 3).toFixed(1)} GB; downloads are limited to 4 GB at a time. Select fewer clips.`);
    audit(db, { user: u, action: 'clips downloaded', ip: ctx.ip, detail: `${clips.length} clips` });
    send(ctx.res, 200, { url: issueDownload(u, { kind: 'zip', ids: clips.map((c) => c.id) }), count: clips.length, bytes: total });
  });

  router.add('GET', '/api/downloads/:token', async (ctx) => {
    const u = requireUser(ctx);
    const d = downloads.get(ctx.params.token);
    if (!d || d.userId !== u.id || d.expires < now()) throw new HttpError(404, 'This download link has expired. Start the download again.');
    if (d.kind === 'trim') {
      return serveFile(ctx, d.path, 'video/mp4', { 'Content-Disposition': `attachment; filename="${d.name}"` });
    }
    const clips = d.ids.map((id) => db.get(`${CLIP_SELECT} WHERE c.id = ?`, id)).filter((c) => c && carRole(db, u, c.car_id));
    const used = new Set();
    const entries = [];
    for (const c of clips) {
      const folder = `${c.car_name} - ${c.camera_label}`.replace(/[\\/:*?"<>|]/g, '_');
      let name = `${folder}/${c.file_name}`;
      for (let i = 2; used.has(name); i++) name = `${folder}/${i}_${c.file_name}`;
      used.add(name);
      entries.push({ name, path: c.path });
      const base = c.path.replace(/\.(mp4|odcenc)$/, '');
      for (const ext of ['gpx', 'srt']) {
        if (fs.existsSync(`${base}.${ext}`)) entries.push({ name: name.replace(/\.(mp4|odcenc)$/, `.${ext}`), path: `${base}.${ext}` });
      }
    }
    const stamp = new Date().toISOString().slice(0, 10);
    ctx.res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="OpenDashCam-${stamp}.zip"`, 'Cache-Control': 'no-store' });
    try { await writeZip(ctx.res, entries); } catch { ctx.res.destroy(); }
  });

  /**
   * Trims a clip (start/end in seconds). With save=true it becomes a new, locked clip next to the original
   * (the original is unchanged); otherwise a download link for the trimmed file is returned.
   */
  router.add('POST', '/api/clips/:id/trim', async (ctx) => {
    const u = requireUser(ctx);
    const c = clipFor(u, ctx.params.id);
    if (c.encrypted) throw new HttpError(400, 'Encrypted clips can’t be trimmed.');
    const b = await readJson(ctx.req);
    const start = Number(b.start);
    const end = Number(b.end);
    const dur = (c.duration_ms || 0) / 1000;
    if (!(start >= 0 && end > start && (!dur || end <= dur + 1))) throw new HttpError(400, 'Choose a start before the end, inside the clip.');
    const startedAt = c.started_at + Math.round(start * 1000);
    const name = c.file_name.replace(/\.mp4$/i, '') + `_trim_${Math.round(start)}-${Math.round(end)}s.mp4`;
    if (b.save) {
      requireCarRole(db, u, c.car_id, true);
      const id = crypto.randomUUID();
      const dest = path.join(path.dirname(c.path), `${id.slice(0, 8)}_${name}`);
      await trimClip(c.path, start, end, dest);
      const size = fs.statSync(dest).size;
      db.run(`INSERT INTO clips(id, camera_id, car_id, stream, file_name, path, started_at, duration_ms, size, sha256, codec, width, height, fps,
          mode, locked, lock_reason, encrypted, created_at, trimmed_from, lat, lon, place, has_track)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'user', 0, ?, ?, ?, ?, ?, ?)`,
        id, c.camera_id, c.car_id, c.stream, name, dest, startedAt, Math.round((end - start) * 1000), size,
        hashOf(fs.readFileSync(dest)), c.codec, c.width, c.height, c.fps, c.mode, now(), c.id, c.lat, c.lon, c.place, c.has_track);
      app.onClipAdded(id);
      audit(db, { user: u, action: 'clip trimmed', target: `${c.car_name} · ${name}`, ip: ctx.ip });
      return send(ctx.res, 201, { id });
    }
    const out = path.join(config.cacheDir, 'trims', `${crypto.randomUUID()}.mp4`);
    await trimClip(c.path, start, end, out);
    send(ctx.res, 200, { url: issueDownload(u, { kind: 'trim', path: out, name }) });
  });

  // ---------------------------------------------------------------- trip logbook (CSV)

  router.add('GET', '/api/trips.csv', (ctx) => {
    const u = requireUser(ctx);
    const cars = visibleCarIds(db, u);
    const s = getSettings(db);
    const mph = s.units === 'mph' || (s.units === 'auto' && ctx.query.get('units') === 'mph');
    const params = [...cars];
    let where = `t.car_id IN (${cars.map(() => '?').join(',') || 'NULL'})`;
    if (ctx.query.get('car')) { where += ' AND t.car_id = ?'; params.push(Number(ctx.query.get('car'))); }
    if (ctx.query.get('from')) { where += ' AND t.start_t >= ?'; params.push(Number(ctx.query.get('from'))); }
    if (ctx.query.get('to')) { where += ' AND t.start_t <= ?'; params.push(Number(ctx.query.get('to'))); }
    const rows = db.all(`SELECT t.*, k.name AS car_name FROM trips t JOIN cars k ON k.id = t.car_id WHERE ${where} ORDER BY t.start_t`, ...params);
    const dist = (m) => (mph ? m / 1609.344 : m / 1000).toFixed(2);
    const spd = (ms) => (ms == null ? '' : (mph ? ms * 2.23694 : ms * 3.6).toFixed(0));
    const pad = (n) => String(n).padStart(2, '0');
    const day = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
    const clock = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
    const q = (v) => { const x = String(v ?? ''); return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
    const unit = mph ? 'mi' : 'km';
    const speedUnit = mph ? 'mph' : 'km/h';
    const lines = [['Date', 'Start', 'End', 'Car', 'Trip', 'From', 'To', `Distance (${unit})`, 'Duration (min)', `Average (${speedUnit})`, `Top speed (${speedUnit})`].join(',')];
    let total = 0;
    for (const t of rows) {
      total += t.distance_m;
      lines.push([day(t.start_t), clock(t.start_t), clock(t.end_t), t.car_name, t.name || t.auto_name || '', t.start_place || '', t.end_place || '',
        dist(t.distance_m), Math.round((t.end_t - t.start_t) / 60_000), spd(t.avg_speed), spd(t.max_speed)].map(q).join(','));
    }
    lines.push(['Total', '', '', '', '', '', '', dist(total), '', '', ''].join(','));
    ctx.res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="trip-logbook.csv"`, 'Cache-Control': 'no-store' });
    ctx.res.end('\ufeff' + lines.join('\r\n') + '\r\n'); // BOM so Excel reads UTF-8
  });

  // ---------------------------------------------------------------- live view
  registerLiveViewRoutes(router, app, { requireUser, requireCamera, carRole });
  registerImportRoutes(router, app, { requireUser, requireCarRole });

  // ---------------------------------------------------------------- plates in one clip

  router.add('GET', '/api/clips/:id/plates', (ctx) => {
    const u = requireUser(ctx);
    const c = clipFor(u, ctx.params.id);
    const s = getSettings(db);
    if (!s.plateSearch) throw new HttpError(403, 'License plate reading is turned off (Settings → License plates).');
    const reads = db.all('SELECT id, plate, offset_ms, confidence, corrected FROM plate_reads WHERE clip_id = ? ORDER BY offset_ms', c.id);
    audit(db, { user: u, action: 'clip plates viewed', target: `${c.car_name} · ${c.file_name}`, ip: ctx.ip, detail: `${reads.length} readings` });
    send(ctx.res, 200, {
      analyzed: !!db.get('SELECT plates_indexed FROM clips WHERE id = ?', c.id)?.plates_indexed,
      plateLog: !!s.plateLog,
      reads: reads.map((r) => ({ id: r.id, plate: r.plate, offsetMs: r.offset_ms, confidence: r.confidence, corrected: !!r.corrected,
        cropUrl: `/api/plates/reads/${r.id}/crop` })),
    });
  });

  // ---------------------------------------------------------------- share links and incident reports
  const shared = { ...app, serveFile, helpers: { visibleCarIds } };
  registerShareRoutes(router, shared, { requireUser, clipFor });
  registerReportRoutes(router, shared, { requireUser });

  // ---------------------------------------------------------------- encrypted clips

  /** Decrypts a phone-encrypted clip for playback. The passphrase isn't stored; the copy is deleted after an hour. */
  router.add('POST', '/api/clips/:id/decrypt', async (ctx) => {
    const u = requireUser(ctx);
    const c = clipFor(u, ctx.params.id);
    if (!c.encrypted) throw new HttpError(400, 'This clip is not encrypted.');
    const b = await readJson(ctx.req);
    const pass = String(b.passphrase || '');
    if (!pass) throw new HttpError(400, 'Enter the passphrase.');
    const out = decryptedPath(c.id);
    if (!fs.existsSync(out)) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      try {
        await decryptFile(c.path, out, pass);
      } catch (e) {
        fs.rmSync(out + '.tmp', { force: true });
        if (e instanceof WrongPassphrase) throw new HttpError(400, 'That passphrase doesn’t open this clip.');
        throw new HttpError(422, `Couldn’t decrypt this clip: ${e.message}`);
      }
    }
    fs.utimesSync(out, new Date(), new Date());
    audit(db, { user: u, action: 'encrypted clip opened', target: `${c.car_name} · ${c.file_name}`, ip: ctx.ip });
    send(ctx.res, 200, { ok: true, streamUrl: `/api/clips/${c.id}/stream?decrypted=1` });
  });

  // ---------------------------------------------------------------- browser notifications

  router.add('GET', '/api/push/key', (ctx) => {
    requireUser(ctx);
    send(ctx.res, 200, { publicKey: vapidKeys(db).publicKey });
  });

  router.add('POST', '/api/push/subscribe', async (ctx) => {
    const u = requireUser(ctx);
    const b = await readJson(ctx.req);
    const endpoint = String(b.endpoint || '');
    if (!/^https:\/\//.test(endpoint) && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(endpoint)) throw new HttpError(400, 'Invalid push endpoint');
    if (!b.keys?.p256dh || !b.keys?.auth) throw new HttpError(400, 'Missing subscription keys');
    db.run(`INSERT INTO push_subs(endpoint, user_id, p256dh, auth, created_at, kind, label) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, kind = excluded.kind, label = excluded.label`,
      endpoint, u.id, String(b.keys.p256dh), String(b.keys.auth), now(), b.kind === 'app' ? 'app' : 'browser', b.label ? String(b.label).slice(0, 80) : null);
    send(ctx.res, 200, { ok: true });
  });

  router.add('POST', '/api/push/unsubscribe', async (ctx) => {
    const u = requireUser(ctx);
    const b = await readJson(ctx.req);
    db.run('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?', String(b.endpoint || ''), u.id);
    send(ctx.res, 200, { ok: true });
  });

  router.add('POST', '/api/push/test', async (ctx) => {
    const u = requireUser(ctx);
    const subs = db.all('SELECT * FROM push_subs WHERE user_id = ?', u.id);
    if (!subs.length) throw new HttpError(400, 'Turn on notifications in this browser first.');
    const { sendPush } = await import('./webpush.js');
    let sent = 0;
    for (const s of subs) {
      try {
        const alive = await sendPush(db, s, { title: 'Open Dash Cam', body: 'Notifications work in this browser.', url: '/#/events' }, 'mailto:noreply@opendashcam.invalid');
        if (alive) sent++;
        else db.run('DELETE FROM push_subs WHERE endpoint = ?', s.endpoint);
      } catch { /* reported below */ }
    }
    send(ctx.res, sent ? 200 : 502, { ok: sent > 0, sent, error: sent ? undefined : 'The browser’s push service didn’t accept the notification.' });
  });

  // ---------------------------------------------------------------- smart search

  router.add('GET', '/api/search/status', async (ctx) => {
    requireUser(ctx);
    const s = getSettings(db);
    const health = s.smartSearch ? await mlHealth(db) : null;
    const plates = s.plateSearch
      ? { plateSearch: true, plateLog: s.plateLog, plateRetentionDays: s.plateRetentionDays, ...plateStats(db) }
      : { plateSearch: false, plateLog: false };
    const mlNeeded = s.smartSearch || s.plateSearch;
    send(ctx.res, 200, {
      enabled: s.smartSearch, ml: mlNeeded ? (health || await mlHealth(db)) : null, ...indexStats(db), ...plates,
      indexing: !!indexerState.current, lastError: indexerState.lastError,
    });
  });

  router.add('POST', '/api/search/reindex', async (ctx) => {
    requireAdmin(ctx);
    const b = await readJson(ctx.req);
    resetIndex(db, b.failedOnly !== false);
    app.analyzeNow?.();
    send(ctx.res, 200, indexStats(db));
  });

  /**
   * Analyze existing footage for smart search and/or plates: all footage, a date range and/or one car.
   * Clips already analyzed are skipped unless `redo` is set. Work happens in the background.
   */
  router.add('POST', '/api/search/analyze', async (ctx) => {
    requireAdmin(ctx);
    const b = await readJson(ctx.req);
    const s = getSettings(db);
    const where = ['encrypted = 0'];
    const params = [];
    if (b.from) { where.push('started_at >= ?'); params.push(Number(b.from)); }
    if (b.to) { where.push('started_at <= ?'); params.push(Number(b.to)); }
    if (b.car) { where.push('car_id = ?'); params.push(Number(b.car)); }
    const w = where.join(' AND ');
    const out = {};
    if (b.smart !== false && s.smartSearch) {
      const r = db.run(`UPDATE clips SET indexed = 0 WHERE ${w} AND indexed ${b.redo ? '!= 0' : '= -1'}`, ...params);
      out.smart = { queued: db.get(`SELECT COUNT(*) n FROM clips WHERE ${w} AND indexed = 0`, ...params).n, reset: r.changes };
    }
    if (b.plates !== false && s.plateSearch) {
      const r = db.run(`UPDATE clips SET plates_indexed = 0 WHERE ${w} AND plates_indexed ${b.redo ? '!= 0' : '= -1'}`, ...params);
      const cutoff = s.plateRetentionDays > 0 ? now() - s.plateRetentionDays * 86400_000 : 0;
      out.plates = {
        queued: db.get(`SELECT COUNT(*) n FROM clips WHERE ${w} AND plates_indexed = 0 AND started_at >= ?`, ...params, cutoff).n,
        reset: r.changes,
        skippedOlderThanRetention: db.get(`SELECT COUNT(*) n FROM clips WHERE ${w} AND started_at < ?`, ...params, cutoff).n,
      };
    }
    app.analyzeNow?.();
    send(ctx.res, 200, out);
  });

  /**
   * Search footage. `q` matches place names, car and camera names, and (with smart search on)
   * what's visible in the video. Filters: car, from, to (ms), locked, impact, parking.
   */
  router.add('GET', '/api/search', async (ctx) => {
    const u = requireUser(ctx);
    const q = ctx.query;
    const cars = visibleCarIds(db, u);
    const empty = { visual: [], text: [], plates: [], smartSearch: getSettings(db).smartSearch, plateSearch: getSettings(db).plateSearch, visualError: null };
    if (!cars.length) return send(ctx.res, 200, empty);
    const where = [`c.car_id IN (${cars.map(() => '?').join(',')})`];
    const params = [...cars];
    if (q.get('car')) { where.push('c.car_id = ?'); params.push(Number(q.get('car'))); }
    if (q.get('from')) { where.push('c.started_at >= ?'); params.push(Number(q.get('from'))); }
    if (q.get('to')) { where.push('c.started_at <= ?'); params.push(Number(q.get('to'))); }
    if (q.get('locked') === '1') where.push('c.locked = 1');
    if (q.get('impact') === '1') where.push(`c.lock_reason = 'impact'`);
    if (q.get('parking') === '1') where.push(`c.mode LIKE 'parking%'`);
    const candidates = db.all(`${CLIP_SELECT} WHERE ${where.join(' AND ')} ORDER BY c.started_at DESC LIMIT 50000`, ...params);
    const text = String(q.get('q') || '').trim().slice(0, 200);
    const limit = Math.min(300, Number(q.get('limit')) || 120);
    if (!text) return send(ctx.res, 200, { ...empty, text: candidates.slice(0, limit).map(clipView) });

    const needle = text.toLowerCase();
    const textMatches = candidates.filter((c) =>
      [c.place, c.car_name, c.camera_label, c.file_name].some((f) => f && f.toLowerCase().includes(needle)));
    let visual = [];
    let visualError = null;
    if (getSettings(db).smartSearch) {
      try {
        const byId = new Map(candidates.map((c) => [c.id, c]));
        visual = (await visualSearch(db, text, candidates.map((c) => c.id))).slice(0, limit)
          .map((r) => ({ ...clipView(byId.get(r.id)), score: Math.round(r.score * 1000) / 1000, offsetMs: r.offsetMs }));
      } catch (e) {
        visualError = `Visual search is unavailable: ${e.cause?.code || e.message}`;
      }
    }
    let plates = [];
    if (getSettings(db).plateSearch && /[0-9A-Za-z]/.test(text) && text.replace(/[^0-9A-Za-z]/g, '').length <= 10) {
      const byId = new Map(candidates.map((c) => [c.id, c]));
      audit(db, { user: u, action: 'plate search', target: text, ip: ctx.ip });
      plates = searchPlates(db, text, candidates.map((c) => c.id)).slice(0, limit)
        .map((r) => ({ ...clipView(byId.get(r.id)), plate: r.plate, plateConfidence: r.confidence, plateMatch: r.match, offsetMs: r.offsetMs }));
    }
    send(ctx.res, 200, { ...empty, visual, visualError, plates, text: textMatches.slice(0, limit).map(clipView) });
  });

  // ---------------------------------------------------------------- plate log

  const requirePlateLog = (ctx) => {
    const u = requireUser(ctx);
    const s = getSettings(db);
    if (!s.plateSearch || !s.plateLog) throw new HttpError(403, 'The plate log is turned off. An admin can turn it on in Settings.');
    return u;
  };
  /** Cars whose plate readings this user may see, or change (manage role). */
  const plateCars = (u, manage) => visibleCarIds(db, u).filter((id) => !manage || carRole(db, u, id) !== 'viewer');

  router.add('GET', '/api/plates', (ctx) => {
    const u = requirePlateLog(ctx);
    audit(db, { user: u, action: 'plate log viewed', ip: ctx.ip, detail: ctx.query.get('q') ? `filter: ${ctx.query.get('q')}` : null });
    send(ctx.res, 200, plateLog(db, plateCars(u), {
      q: ctx.query.get('q') || '', sort: ctx.query.get('sort') || 'recent', limit: Math.min(1000, Number(ctx.query.get('limit')) || 300), userId: u.id,
    }));
  });

  router.add('POST', '/api/plates/erase', (ctx) => {
    const admin = requireAdmin(ctx);
    erasePlates(db);
    audit(db, { user: admin, action: 'all plate data deleted', ip: ctx.ip });
    send(ctx.res, 200, { ok: true });
  });

  router.add('GET', '/api/plates/:plate', (ctx) => {
    const u = requirePlateLog(ctx);
    const plate = normalizePlate(ctx.params.plate);
    const cars = plateCars(u);
    if (!cars.length) throw new HttpError(404, 'Plate not found');
    const ph = cars.map(() => '?').join(',');
    const reads = db.all(`SELECT r.id, r.t, r.offset_ms AS offsetMs, r.confidence, r.corrected, r.clip_id AS clipId, r.car_id AS carId,
        k.name AS carName, c.place, c.lat, c.lon, m.label AS camera
      FROM plate_reads r JOIN clips c ON c.id = r.clip_id JOIN cars k ON k.id = r.car_id JOIN cameras m ON m.id = c.camera_id
      WHERE r.plate = ? AND r.car_id IN (${ph}) ORDER BY r.t DESC LIMIT 1000`, plate, ...cars);
    if (!reads.length) throw new HttpError(404, 'No sightings of that plate.');
    audit(db, { user: u, action: 'plate viewed', target: plate, ip: ctx.ip });
    const note = db.get('SELECT note FROM plate_notes WHERE user_id = ? AND plate = ?', u.id, plate)?.note || null;
    send(ctx.res, 200, { plate, note, reads: reads.map((r) => ({ ...r, corrected: !!r.corrected })), similar: similarPlates(db, cars, plate) });
  });

  router.add('PATCH', '/api/plates/:plate', async (ctx) => {
    const u = requirePlateLog(ctx);
    const plate = normalizePlate(ctx.params.plate);
    const b = await readJson(ctx.req);
    const note = str(b.note, 300)?.trim();
    if (note) db.run('INSERT INTO plate_notes(user_id, plate, note) VALUES (?, ?, ?) ON CONFLICT(user_id, plate) DO UPDATE SET note = excluded.note', u.id, plate, note);
    else db.run('DELETE FROM plate_notes WHERE user_id = ? AND plate = ?', u.id, plate);
    send(ctx.res, 200, { ok: true });
  });

  /** "These are the same plate": moves all sightings of :plate to `into`. */
  router.add('POST', '/api/plates/:plate/merge', async (ctx) => {
    const u = requirePlateLog(ctx);
    const from = normalizePlate(ctx.params.plate);
    const into = normalizePlate((await readJson(ctx.req)).into);
    if (into.length < 2 || into === from) throw new HttpError(400, 'Enter a different plate to merge into.');
    const cars = plateCars(u, true);
    if (!cars.length) throw new HttpError(403, 'You can view these cars but not change them.');
    mergePlates(db, cars, from, into);
    audit(db, { user: u, action: 'plates merged', target: `${from} → ${into}`, ip: ctx.ip });
    send(ctx.res, 200, { plate: into });
  });

  const readFor = (u, id, manage) => {
    const r = db.get('SELECT r.*, c.path FROM plate_reads r JOIN clips c ON c.id = r.clip_id WHERE r.id = ?', Number(id));
    if (!r || !plateCars(u, manage).includes(r.car_id)) throw new HttpError(404, 'Reading not found');
    return r;
  };

  /** Fix one misread reading. */
  router.add('PATCH', '/api/plates/reads/:id', async (ctx) => {
    const u = requirePlateLog(ctx);
    const r = readFor(u, ctx.params.id, true);
    const plate = normalizePlate((await readJson(ctx.req)).plate);
    if (plate.length < 2) throw new HttpError(400, 'Enter the plate as it should read.');
    db.run('UPDATE plate_reads SET plate = ?, corrected = 1 WHERE id = ?', plate, r.id);
    audit(db, { user: u, action: 'plate reading corrected', target: `${r.plate} → ${plate}`, ip: ctx.ip });
    send(ctx.res, 200, { ok: true, plate });
  });

  /** Remove a false reading (not a plate, or unreadable). */
  router.add('DELETE', '/api/plates/reads/:id', (ctx) => {
    const u = requirePlateLog(ctx);
    const r = readFor(u, ctx.params.id, true);
    db.run('DELETE FROM plate_reads WHERE id = ?', r.id);
    audit(db, { user: u, action: 'plate reading removed', target: r.plate, ip: ctx.ip });
    send(ctx.res, 200, { ok: true });
  });

  router.add('GET', '/api/plates/reads/:id/crop', async (ctx) => {
    // Crops are shown in a clip's plate list too, so they only need plate reading on (not the plate log).
    const u = requireUser(ctx);
    if (!getSettings(db).plateSearch) throw new HttpError(403, 'License plate reading is turned off.');
    const r = readFor(u, ctx.params.id, false);
    const file = await plateCrop(db, r, r.path);
    serveFile(ctx, file, 'image/jpeg', { 'Cache-Control': 'private, max-age=86400' });
  });

  router.add('GET', '/api/events', (ctx) => {
    const u = requireUser(ctx);
    const cars = visibleCarIds(db, u);
    if (!cars.length) return send(ctx.res, 200, []);
    const rows = db.all(`SELECT e.*, k.name AS car_name, m.label AS camera_label FROM events e
      JOIN cars k ON k.id = e.car_id LEFT JOIN cameras m ON m.id = e.camera_id
      WHERE e.car_id IN (${cars.map(() => '?').join(',')}) ORDER BY e.t DESC LIMIT 200`, ...cars);
    send(ctx.res, 200, rows.map((e) => {
      const data = safeJson(e.data);
      return {
        id: e.id, carId: e.car_id, carName: e.car_name, camera: e.camera_label, type: e.type, t: e.t, data,
        snapshotUrl: data?.snapshot ? `/api/snapshots/${e.id}` : null,
      };
    }));
  });

  /** An event's photo: for people who can see the car, or with the signed link sent in notifications. */
  router.add('GET', '/api/snapshots/:id', (ctx) => {
    const id = Number(ctx.params.id);
    const ev = db.get('SELECT car_id FROM events WHERE id = ?', id);
    if (!ev) throw new HttpError(404, 'Not found');
    const viaLink = checkStreamToken(db, `snap-${id}`, ctx.query.get('st'));
    if (!viaLink) {
      const u = requireUser(ctx);
      if (!carRole(db, u, ev.car_id)) throw new HttpError(404, 'Not found');
    }
    const file = snapshotPath(id);
    if (!fs.existsSync(file)) throw new HttpError(404, 'No photo');
    serveFile(ctx, file, 'image/jpeg', { 'Cache-Control': 'private, max-age=86400' });
  });

  // ---------------------------------------------------------------- integrations

  router.add('GET', '/api/integrations', (ctx) => {
    requireAdmin(ctx);
    send(ctx.res, 200, { homeAssistant: haStatus() });
  });

  /** Checks a car's Viofo camera now (lists its files; imports a first batch in the background). */
  router.add('POST', '/api/cars/:id/viofo/check', async (ctx) => {
    const u = requireUser(ctx);
    const id = Number(ctx.params.id);
    requireCarRole(db, u, id, true);
    const car = db.get('SELECT * FROM cars WHERE id = ?', id);
    if (!car.viofo_url) throw new HttpError(400, 'Enter the camera’s address first.');
    let files;
    try {
      files = await listFiles(car.viofo_url.replace(/\/$/, ''), (car.viofo_folders || 'movie,parking,ro').split(','));
    } catch (e) {
      throw new HttpError(502, `Couldn’t reach the camera: ${e.message}`);
    }
    const already = db.get('SELECT COUNT(*) n FROM viofo_files WHERE car_id = ?', id).n;
    importCar(db, app, car).catch(() => {});
    send(ctx.res, 200, { files: files.length, imported: already, newest: files[0]?.name ?? null });
  });

  // ---------------------------------------------------------------- arrival alert places

  const placeView = (p) => ({ id: p.id, name: p.name, lat: p.lat, lon: p.lon, radiusM: p.radius_m, onArrive: !!p.on_arrive, onLeave: !!p.on_leave,
    carIds: p.car_ids ? JSON.parse(p.car_ids) : null });
  const readPlace = async (ctx, u) => {
    const b = await readJson(ctx.req);
    const name = str(b.name, 60)?.trim();
    const lat = Number(b.lat);
    const lon = Number(b.lon);
    const radius = Math.min(5000, Math.max(30, Number(b.radiusM) || 150));
    if (!name) throw new HttpError(400, 'Give the place a name.');
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) throw new HttpError(400, 'Choose a spot on the map.');
    const visible = visibleCarIds(db, u);
    const cars = Array.isArray(b.carIds) ? b.carIds.map(Number).filter((id) => visible.includes(id)) : null;
    return { name, lat, lon, radius, arrive: b.onArrive !== false, leave: !!b.onLeave, cars: cars && cars.length ? JSON.stringify(cars) : null };
  };

  router.add('GET', '/api/alert-places', (ctx) => {
    const u = requireUser(ctx);
    send(ctx.res, 200, db.all('SELECT * FROM alert_places WHERE user_id = ? ORDER BY name', u.id).map(placeView));
  });

  router.add('POST', '/api/alert-places', async (ctx) => {
    const u = requireUser(ctx);
    const p = await readPlace(ctx, u);
    const r = db.run('INSERT INTO alert_places(user_id, name, lat, lon, radius_m, on_arrive, on_leave, car_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      u.id, p.name, p.lat, p.lon, p.radius, p.arrive ? 1 : 0, p.leave ? 1 : 0, p.cars, now());
    audit(db, { user: u, action: 'alert place added', target: p.name, ip: ctx.ip });
    send(ctx.res, 201, placeView(db.get('SELECT * FROM alert_places WHERE id = ?', Number(r.lastInsertRowid))));
  });

  router.add('PUT', '/api/alert-places/:id', async (ctx) => {
    const u = requireUser(ctx);
    const id = Number(ctx.params.id);
    if (!db.get('SELECT 1 FROM alert_places WHERE id = ? AND user_id = ?', id, u.id)) throw new HttpError(404, 'Place not found');
    const p = await readPlace(ctx, u);
    db.run('UPDATE alert_places SET name = ?, lat = ?, lon = ?, radius_m = ?, on_arrive = ?, on_leave = ?, car_ids = ? WHERE id = ?',
      p.name, p.lat, p.lon, p.radius, p.arrive ? 1 : 0, p.leave ? 1 : 0, p.cars, id);
    send(ctx.res, 200, placeView(db.get('SELECT * FROM alert_places WHERE id = ?', id)));
  });

  router.add('DELETE', '/api/alert-places/:id', (ctx) => {
    const u = requireUser(ctx);
    const r = db.run('DELETE FROM alert_places WHERE id = ? AND user_id = ?', Number(ctx.params.id), u.id);
    if (!r.changes) throw new HttpError(404, 'Place not found');
    send(ctx.res, 200, { ok: true });
  });
}

const decryptedPath = (clipId) => path.join(config.cacheDir, 'decrypted', `${clipId}.mp4`);

const tripView = (t) => ({
  id: t.id, carId: t.car_id, carName: t.car_name, startT: t.start_t, endT: t.end_t, distanceM: t.distance_m,
  maxSpeed: t.max_speed, avgSpeed: t.avg_speed, start: [t.start_lat, t.start_lon], end: [t.end_lat, t.end_lon], name: t.name,
  startPlace: t.start_place, endPlace: t.end_place, autoName: t.auto_name,
  displayName: t.name || t.auto_name || null,
});

const safeJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

/** Keeps at most `max` points, evenly spread, always including the last. */
function simplify(points, max) {
  if (points.length <= max) return points;
  const step = points.length / max;
  const out = [];
  for (let i = 0; i < max; i++) out.push(points[Math.floor(i * step)]);
  out.push(points[points.length - 1]);
  return out;
}

/** Serves a file with HTTP Range support so video players can seek. */
export function serveFile(ctx, file, type, extra = {}) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new HttpError(404, 'File is missing on the server');
  }
  const size = stat.size;
  const range = ctx.req.headers.range;
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', ...extra };
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? Number(m[1]) : 0;
    let end = m && m[2] ? Number(m[2]) : size - 1;
    if (m && !m[1] && m[2]) { start = Math.max(0, size - Number(m[2])); end = size - 1; }
    if (start >= size || end < start) {
      ctx.res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return ctx.res.end();
    }
    end = Math.min(end, size - 1);
    ctx.res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    if (ctx.req.method === 'HEAD') return ctx.res.end();
    return fs.createReadStream(file, { start, end }).pipe(ctx.res);
  }
  ctx.res.writeHead(200, { ...headers, 'Content-Length': size });
  if (ctx.req.method === 'HEAD') return ctx.res.end();
  fs.createReadStream(file).pipe(ctx.res);
}
