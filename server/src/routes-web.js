import fs from 'node:fs';
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
    const token = createSession(db, Number(r.lastInsertRowid));
    send(ctx.res, 201, { ok: true }, { 'Set-Cookie': sessionCookie(token, secure(ctx)) });
  });

  router.add('POST', '/api/login', async (ctx) => {
    checkLoginRate(ctx.ip);
    const b = await readJson(ctx.req);
    const user = db.get('SELECT * FROM users WHERE username = ?', String(b.username || '').trim());
    if (!user || !verifyPassword(String(b.password || ''), user.password_hash)) {
      recordLoginFailure(ctx.ip);
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
        throw new HttpError(401, 'That code is wrong or expired.', { totpRequired: true });
      }
    }
    const token = createSession(db, user.id);
    send(ctx.res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(token, secure(ctx)) });
  });

  router.add('POST', '/api/logout', (ctx) => {
    destroySession(db, ctx.req);
    send(ctx.res, 200, { ok: true }, { 'Set-Cookie': clearCookie() });
  });

  router.add('GET', '/api/me', (ctx) => {
    const u = requireUser(ctx);
    const row = db.get('SELECT totp_enabled FROM users WHERE id = ?', u.id);
    send(ctx.res, 200, { ...u, totpEnabled: !!row.totp_enabled, settings: publicSettings(getSettings(db)), version: config.version });
  });

  router.add('PUT', '/api/me/password', async (ctx) => {
    const u = requireUser(ctx);
    const b = await readJson(ctx.req);
    const row = db.get('SELECT password_hash FROM users WHERE id = ?', u.id);
    if (!verifyPassword(String(b.current || ''), row.password_hash)) throw new HttpError(400, 'Current password is wrong.');
    validatePassword(b.password);
    db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(b.password), u.id);
    send(ctx.res, 200, { ok: true });
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
    send(ctx.res, 200, { recoveryCodes: codes });
  });

  router.add('POST', '/api/me/totp/disable', async (ctx) => {
    const u = requireUser(ctx);
    const b = await readJson(ctx.req);
    const row = db.get('SELECT password_hash FROM users WHERE id = ?', u.id);
    if (!verifyPassword(String(b.password || ''), row.password_hash)) throw new HttpError(400, 'Password is wrong.');
    db.run('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?', u.id);
    db.run('DELETE FROM recovery_codes WHERE user_id = ?', u.id);
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

  const publicSettings = (s) => ({ serverName: s.serverName, units: s.units, mapStyleUrl: s.mapStyleUrl, plateLog: !!(s.plateSearch && s.plateLog) });

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
    if (after.smartSearch && (!prev.smartSearch || prev.mlUrl !== after.mlUrl)) runIndexer(db).catch(() => {});
    if (!after.plateSearch && after.plateLog) saveSettings(db, { plateLog: false }); // the log needs plate reading
    if (after.plateSearch) {
      purgeOldPlates(db);
      if (!prev.plateSearch) runPlateIndexer(db).catch(() => {});
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
    const { notify } = await import('./notify.js');
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
    send(ctx.res, 200, db.all('SELECT id, username, is_admin AS isAdmin, totp_enabled AS totpEnabled, created_at AS createdAt FROM users ORDER BY id')
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
    send(ctx.res, 201, { ok: true });
  });

  router.add('PATCH', '/api/users/:id', async (ctx) => {
    const me = requireAdmin(ctx);
    const id = Number(ctx.params.id);
    const b = await readJson(ctx.req);
    if (b.password !== undefined) {
      validatePassword(b.password);
      db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(b.password), id);
      db.run('DELETE FROM sessions WHERE user_id = ?', id);
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
    db.run('DELETE FROM users WHERE id = ?', id);
    send(ctx.res, 200, { ok: true });
  });

  // ---------------------------------------------------------------- cars, cameras, sharing, pairing

  const carView = (car, user) => {
    const cameras = db.all('SELECT * FROM cameras WHERE car_id = ? ORDER BY created_at', car.id).map((c) => ({
      id: c.id, label: c.label, deviceModel: c.device_model, appVersion: c.app_version, lastSeenAt: c.last_seen_at,
      battery: c.battery, charging: !!c.charging, thermal: c.thermal, storageFree: c.storage_free,
      recording: !!c.recording, mode: c.mode,
    }));
    const shares = db.all('SELECT s.user_id AS userId, u.username, s.role FROM car_shares s JOIN users u ON u.id = s.user_id WHERE s.car_id = ?', car.id);
    const stats = db.get('SELECT COUNT(*) n, COALESCE(SUM(size), 0) bytes, MAX(started_at) last FROM clips WHERE car_id = ?', car.id);
    const owner = db.get('SELECT username FROM users WHERE id = ?', car.owner_id);
    return {
      id: car.id, name: car.name, owner: owner?.username, role: carRole(db, user, car.id),
      mismatchPolicy: car.mismatch_policy, truthCameraId: car.truth_camera_id,
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
    send(ctx.res, 200, { ok: true });
  });

  router.add('DELETE', '/api/cars/:id/shares/:userId', (ctx) => {
    const u = requireUser(ctx);
    const id = Number(ctx.params.id);
    if (requireCarRole(db, u, id) !== 'owner') throw new HttpError(403, 'Only the owner can change sharing.');
    db.run('DELETE FROM car_shares WHERE car_id = ? AND user_id = ?', id, Number(ctx.params.userId));
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
    send(ctx.res, 201, { code, expiresAt, url, qr: JSON.stringify({ odc: 1, url, code }) });
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

  /** Unpairs the phone. Its footage stays on the server. */
  router.add('DELETE', '/api/cameras/:id', (ctx) => {
    const u = requireUser(ctx);
    const cam = cameraWithRole(u, ctx.params.id, true);
    db.run('UPDATE cameras SET token_hash = ? WHERE id = ?', 'revoked:' + cam.id + ':' + now(), cam.id);
    db.run('DELETE FROM live WHERE camera_id = ?', cam.id);
    send(ctx.res, 200, { ok: true });
  });

  // ---------------------------------------------------------------- clips

  const clipView = (c) => ({
    id: c.id, carId: c.car_id, carName: c.car_name, cameraId: c.camera_id, camera: c.camera_label, stream: c.stream,
    fileName: c.file_name, startedAt: c.started_at, durationMs: c.duration_ms, size: c.size, sha256: c.sha256,
    codec: c.codec, width: c.width, height: c.height, fps: c.fps, mode: c.mode, locked: !!c.locked,
    lockReason: c.lock_reason, encrypted: !!c.encrypted, hasTrack: !!c.has_track, hasThumb: !!c.has_thumb,
    lat: c.lat, lon: c.lon, place: c.place,
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
    if (c.encrypted) throw new HttpError(415, 'This clip is encrypted. Download it and open it with odc_decrypt.');
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
    send(ctx.res, 200, { ...tripView(t), route: simplify(routePoints(db, t.car_id, t.start_t, t.end_t), 3000), clips });
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
    runIndexer(db).catch(() => {});
    send(ctx.res, 200, indexStats(db));
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
    send(ctx.res, 200, plateLog(db, plateCars(u), {
      q: ctx.query.get('q') || '', sort: ctx.query.get('sort') || 'recent', limit: Math.min(1000, Number(ctx.query.get('limit')) || 300), userId: u.id,
    }));
  });

  router.add('POST', '/api/plates/erase', (ctx) => {
    requireAdmin(ctx);
    erasePlates(db);
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
    send(ctx.res, 200, { ok: true, plate });
  });

  /** Remove a false reading (not a plate, or unreadable). */
  router.add('DELETE', '/api/plates/reads/:id', (ctx) => {
    const u = requirePlateLog(ctx);
    const r = readFor(u, ctx.params.id, true);
    db.run('DELETE FROM plate_reads WHERE id = ?', r.id);
    send(ctx.res, 200, { ok: true });
  });

  router.add('GET', '/api/plates/reads/:id/crop', async (ctx) => {
    const u = requirePlateLog(ctx);
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
    send(ctx.res, 200, rows.map((e) => ({
      id: e.id, carId: e.car_id, carName: e.car_name, camera: e.camera_label, type: e.type, t: e.t,
      data: safeJson(e.data),
    })));
  });
}

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
