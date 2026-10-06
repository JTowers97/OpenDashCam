import { getSettings } from './db.js';
import { now } from './util.js';
import { sendPush } from './webpush.js';

/**
 * Sends an alert to everyone concerned: people who can see the car (owner and shares), specific people, or the admins
 * for server-wide alerts. For each person it respects their alert choices, adds the alert to their inbox (the app's
 * alert list), pushes it to their browsers and apps, and wakes their app's direct connection. ntfy (if configured)
 * gets a copy too.
 *
 * kind: impact, arrived, left, speeding, offline, overheating, battery_cutoff, recording_stopped, mismatch, storage,
 *       live_view, summary, test (people can turn each kind off for themselves)
 */
export const ALERT_KINDS = ['impact', 'arrived', 'left', 'speeding', 'offline', 'overheating', 'battery_cutoff', 'recording_stopped',
  'mismatch', 'storage', 'live_view', 'summary'];

const waiters = new Map(); // userId -> Set<callback>, for the app's direct connection

/** The app's direct connection waits here; resolves when this person gets a new notification (or times out). */
export function waitForNotification(userId, ms, cb) {
  const set = waiters.get(userId) || new Set();
  waiters.set(userId, set);
  const done = () => { clearTimeout(timer); set.delete(fire); };
  const fire = () => { done(); cb(true); };
  const timer = setTimeout(() => { set.delete(fire); cb(false); }, ms);
  set.add(fire);
  return done;
}

function wantsKind(db, userId, kind) {
  if (kind === 'test') return true;
  try {
    const p = JSON.parse(db.get('SELECT prefs FROM users WHERE id = ?', userId)?.prefs || '{}');
    return p.alerts?.[kind] !== false;
  } catch {
    return true;
  }
}

export async function notify(db, { title, message, priority = 3, tags = [], carId = null, userIds = null, url = '/#/events', image = null, kind = 'other', eventId = null }) {
  const s = getSettings(db);
  let ok = false;
  if (s.ntfyUrl && kind !== 'summary' && kind !== 'test') {
    try {
      const headers = { Title: asciiHeader(title), Priority: String(priority) };
      if (tags.length) headers.Tags = tags.join(',');
      if (s.ntfyToken) headers.Authorization = `Bearer ${s.ntfyToken}`;
      if (image) headers.Attach = image;
      const r = await fetch(s.ntfyUrl, { method: 'POST', headers, body: message, signal: AbortSignal.timeout(10_000) });
      ok = r.ok;
    } catch (e) {
      console.warn('ntfy failed:', e.message);
    }
  }
  const users = (userIds ? userIds.map((id) => ({ id })) : carId
    ? db.all('SELECT owner_id AS id FROM cars WHERE id = ? UNION SELECT user_id AS id FROM car_shares WHERE car_id = ?', carId, carId)
    : db.all('SELECT id FROM users WHERE is_admin = 1')).filter((u) => wantsKind(db, u.id, kind));
  const t = now();
  const subject = (process.env.ODC_PUBLIC_URL || '').startsWith('https://') ? process.env.ODC_PUBLIC_URL : 'mailto:noreply@opendashcam.invalid';
  for (const u of users) {
    const r = db.run('INSERT INTO notifications(user_id, t, kind, title, body, car_id, event_id, image, url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      u.id, t, kind, title, message, carId, eventId, image, url);
    const id = Number(r.lastInsertRowid);
    for (const fire of [...(waiters.get(u.id) || [])]) fire();
    for (const sub of db.all('SELECT * FROM push_subs WHERE user_id = ?', u.id)) {
      try {
        const alive = await sendPush(db, sub, { id, kind, title, body: message, url, urgent: priority >= 4, image, carId, eventId, t }, subject);
        if (!alive) db.run('DELETE FROM push_subs WHERE endpoint = ?', sub.endpoint);
        else ok = true;
      } catch (e) {
        console.warn('push failed:', e.message);
      }
    }
  }
  return ok || users.length > 0;
}

export function purgeNotifications(db, days = 60) {
  db.run('DELETE FROM notifications WHERE t < ?', now() - days * 86400_000);
}

// HTTP header values must be ASCII; ntfy also reads RFC 2047, but plain ASCII keeps it simple.
const asciiHeader = (s) => String(s).replace(/[^\x20-\x7E]/g, '').slice(0, 200);
