import { getSettings } from './db.js';
import { sendPush } from './webpush.js';

/**
 * Sends an alert to ntfy (if configured) and as a browser notification to the people concerned:
 * everyone who can see the car (owner and shares), or the admins for server-wide alerts.
 * Failures are logged and ignored.
 */
export async function notify(db, { title, message, priority = 3, tags = [], carId = null, userIds = null, url = '/#/events', image = null }) {
  const s = getSettings(db);
  let ok = false;
  if (s.ntfyUrl) {
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
  const users = userIds ? userIds.map((id) => ({ id })) : carId
    ? db.all('SELECT owner_id AS id FROM cars WHERE id = ? UNION SELECT user_id AS id FROM car_shares WHERE car_id = ?', carId, carId)
    : db.all('SELECT id FROM users WHERE is_admin = 1');
  if (users.length) {
    const subs = db.all(`SELECT * FROM push_subs WHERE user_id IN (${users.map(() => '?').join(',')})`, ...users.map((u) => u.id));
    const subject = (process.env.ODC_PUBLIC_URL || '').startsWith('https://') ? process.env.ODC_PUBLIC_URL : 'mailto:noreply@opendashcam.invalid';
    for (const sub of subs) {
      try {
        const alive = await sendPush(db, sub, { title, body: message, url, urgent: priority >= 4, image }, subject);
        if (!alive) db.run('DELETE FROM push_subs WHERE endpoint = ?', sub.endpoint);
        else ok = true;
      } catch (e) {
        console.warn('push failed:', e.message);
      }
    }
  }
  return ok;
}

// HTTP header values must be ASCII; ntfy also reads RFC 2047, but plain ASCII keeps it simple.
const asciiHeader = (s) => String(s).replace(/[^\x20-\x7E]/g, '').slice(0, 200);
