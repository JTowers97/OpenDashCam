import { audit } from './audit.js';
import { HttpError, now, readJson, send } from './util.js';

/**
 * Remote settings for dashcam phones (Command Center): the phone reports its settings when it checks in, and picks
 * up changes made from Command Center or the web app the next time it does. Only these settings can be changed
 * remotely; anything involving the phone's own permissions or legal choices (audio recording, privacy zones,
 * passwords) stays on the phone. The phone shows a notification when its settings are changed remotely.
 */
export const SETTINGS_SPEC = [
  { key: 'resolution', label: 'Video resolution', group: 'Recording', type: 'choice', options: [[2160, '4K'], [1440, '1440p'], [1080, '1080p'], [720, '720p']], note: 'If the phone’s camera can’t, it uses the closest it can.' },
  { key: 'fps', label: 'Frame rate', group: 'Recording', type: 'choice', options: [[30, '30 fps'], [60, '60 fps']] },
  { key: 'segmentMinutes', label: 'Clip length', group: 'Recording', type: 'choice', options: [[1, '1 min'], [3, '3 min'], [5, '5 min']] },
  { key: 'overlayEnabled', label: 'Date/time stamp', group: 'Recording', type: 'bool' },
  { key: 'overlaySpeed', label: 'Speed in the stamp', group: 'Recording', type: 'bool' },
  { key: 'overlayCoords', label: 'Coordinates in the stamp', group: 'Recording', type: 'bool' },
  { key: 'spokenFeedback', label: 'Spoken feedback', group: 'Recording', type: 'bool' },
  { key: 'parkingEnabled', label: 'Parking mode', group: 'Parking and impacts', type: 'bool' },
  { key: 'impactEnabled', label: 'Impact detection', group: 'Parking and impacts', type: 'bool' },
  { key: 'gpsEnabled', label: 'GPS logging', group: 'Location', type: 'bool', note: 'Needs location permission on the phone.' },
  { key: 'serverLiveEnabled', label: 'Share live location', group: 'Location', type: 'bool' },
  { key: 'liveViewAllowed', label: 'Allow live view', group: 'Location', type: 'bool', note: 'The phone shows a notification while someone watches.' },
  { key: 'backupCellular', label: 'Back up over mobile data', group: 'Backup', type: 'bool' },
  { key: 'backupEventsOnMobile', label: 'Impact and locked clips over mobile data', group: 'Backup', type: 'bool' },
  { key: 'cellularCapMb', label: 'Monthly mobile data limit', group: 'Backup', type: 'choice', options: [[256, '256 MB'], [1024, '1 GB'], [5120, '5 GB'], [0, 'No limit']] },
  { key: 'backupOnlyCharging', label: 'Back up only while charging', group: 'Backup', type: 'bool' },
  { key: 'autoStartCharging', label: 'Start recording when charging starts', group: 'Auto-start', type: 'bool' },
  { key: 'batteryCutoff', label: 'Stop recording below battery', group: 'Battery', type: 'choice', options: [[10, '10%'], [15, '15%'], [20, '20%'], [30, '30%']] },
  { key: 'thermalProtection', label: 'Pause when the phone is too hot', group: 'Battery', type: 'bool' },
];
const SPEC = Object.fromEntries(SETTINGS_SPEC.map((s) => [s.key, s]));

const parse = (s) => { try { return JSON.parse(s || 'null'); } catch { return null; } };

/** Checks a value against the allowlist. Returns the cleaned value, or throws. */
function clean(key, v) {
  const s = SPEC[key];
  if (!s) throw new HttpError(400, `“${key}” can’t be changed remotely.`);
  if (s.type === 'bool') return !!v;
  const n = Number(v);
  if (!s.options.some(([o]) => o === n)) throw new HttpError(400, `Not a valid choice for ${s.label}.`);
  return n;
}

export function registerRemoteSettingsRoutes(router, app, { requireUser, requireCamera, requireCarRole }) {
  const { db } = app;

  /** Phone: reports its settings and the change version it has applied; gets any newer changes. */
  router.add('POST', '/api/v1/devices/me/settings', async (ctx) => {
    const cam = requireCamera(ctx);
    const b = await readJson(ctx.req);
    const reported = {};
    for (const [k, v] of Object.entries(b.settings || {})) if (SPEC[k]) reported[k] = v;
    db.run('UPDATE cameras SET settings_reported = ?, settings_applied = ?, settings_reported_at = ? WHERE id = ?',
      JSON.stringify(reported), Number(b.applied) || 0, now(), cam.id);
    const desired = parse(cam.settings_desired);
    const version = cam.settings_version || 0;
    send(ctx.res, 200, desired && version > (Number(b.applied) || 0) ? { version, changes: desired } : { version });
  });

  const camera = (u, id) => {
    const cam = db.get('SELECT * FROM cameras WHERE id = ?', id);
    if (!cam) throw new HttpError(404, 'Camera not found');
    requireCarRole(db, u, cam.car_id, true);
    if (cam.token_hash.startsWith('viofo:')) throw new HttpError(400, 'Remote settings are for ODC phones.');
    return cam;
  };
  const view = (cam) => {
    const pending = (cam.settings_version || 0) > (cam.settings_applied || 0);
    return {
      spec: SETTINGS_SPEC,
      reported: parse(cam.settings_reported),
      reportedAt: cam.settings_reported_at || null,
      pending: pending ? parse(cam.settings_desired) : null,
    };
  };

  router.add('GET', '/api/cameras/:id/settings', (ctx) => {
    const u = requireUser(ctx);
    send(ctx.res, 200, view(camera(u, ctx.params.id)));
  });

  /** Changes some of a phone's settings; it applies them the next time it checks in. */
  router.add('PUT', '/api/cameras/:id/settings', async (ctx) => {
    const u = requireUser(ctx);
    const cam = camera(u, ctx.params.id);
    const b = await readJson(ctx.req);
    const changes = {};
    for (const [k, v] of Object.entries(b.changes || {})) changes[k] = clean(k, v);
    if (!Object.keys(changes).length) throw new HttpError(400, 'No changes');
    const stillPending = (cam.settings_version || 0) > (cam.settings_applied || 0) ? parse(cam.settings_desired) || {} : {};
    const desired = { ...stillPending, ...changes };
    db.run('UPDATE cameras SET settings_desired = ?, settings_version = ? WHERE id = ?', JSON.stringify(desired), (cam.settings_version || 0) + 1, cam.id);
    audit(db, { user: u, action: 'phone settings changed', target: cam.label, ip: ctx.ip,
      detail: Object.entries(changes).map(([k, v]) => `${SPEC[k].label}: ${v}`).join(', ') });
    send(ctx.res, 200, view(db.get('SELECT * FROM cameras WHERE id = ?', cam.id)));
  });
}
