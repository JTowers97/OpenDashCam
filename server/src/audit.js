import { now } from './util.js';

/** Records an action in the audit log. Never throws. */
export function audit(db, { user = null, action, target = null, ip = null, detail = null }) {
  try {
    db.run('INSERT INTO audit(t, user_id, username, action, target, ip, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
      now(), user?.id ?? null, user?.username ?? null, action, target == null ? null : String(target).slice(0, 200),
      ip, detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 1000));
  } catch (e) {
    console.warn('audit failed:', e.message);
  }
}

export function purgeAudit(db, days) {
  if (days > 0) db.run('DELETE FROM audit WHERE t < ?', now() - days * 86400_000);
}
