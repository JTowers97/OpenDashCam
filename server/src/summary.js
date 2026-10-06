import { getMeta, getSettings, setMeta } from './db.js';
import { notify } from './notify.js';

/**
 * Weekly summary (optional, per person): trips, distance, driving time, alerts and footage for each car they can see,
 * over the past 7 days, sent through their notification channels at the day and hour they choose.
 */
function carsFor(db, userId) {
  const u = db.get('SELECT is_admin FROM users WHERE id = ?', userId);
  return u?.is_admin
    ? db.all('SELECT id, name FROM cars ORDER BY name')
    : db.all('SELECT id, name FROM cars WHERE owner_id = ? OR id IN (SELECT car_id FROM car_shares WHERE user_id = ?) ORDER BY name', userId, userId);
}

export function buildSummary(db, userId, until = Date.now()) {
  const from = until - 7 * 86400_000;
  const s = getSettings(db);
  const mph = s.units === 'mph';
  const dist = (m) => (mph ? `${(m / 1609.344).toFixed(0)} mi` : `${(m / 1000).toFixed(0)} km`);
  const lines = [];
  let anything = false;
  for (const car of carsFor(db, userId)) {
    const t = db.get('SELECT COUNT(*) n, COALESCE(SUM(distance_m), 0) d, COALESCE(SUM(end_t - start_t), 0) ms FROM trips WHERE car_id = ? AND start_t >= ? AND start_t < ?', car.id, from, until);
    const ev = Object.fromEntries(db.all(`SELECT type, COUNT(*) n FROM events WHERE car_id = ? AND t >= ? AND t < ? GROUP BY type`, car.id, from, until).map((e) => [e.type, e.n]));
    const clips = db.get('SELECT COUNT(*) n, COALESCE(SUM(size), 0) b FROM clips WHERE car_id = ? AND started_at >= ? AND started_at < ?', car.id, from, until);
    const hours = Math.floor(t.ms / 3600_000);
    const mins = Math.round((t.ms % 3600_000) / 60_000);
    const parts = [];
    if (t.n) parts.push(`${t.n} trip${t.n === 1 ? '' : 's'}, ${dist(t.d)}, ${hours ? `${hours} h ` : ''}${mins} min driving`);
    else parts.push('no trips');
    const alerts = [
      ev.impact && `${ev.impact} impact${ev.impact === 1 ? '' : 's'}`,
      ev.speeding && `${ev.speeding} speeding`,
      (ev.hard_brake || ev.hard_accel || ev.sharp_turn) && `${(ev.hard_brake || 0) + (ev.hard_accel || 0) + (ev.sharp_turn || 0)} driving events`,
      ev.offline && `${ev.offline} camera offline`,
    ].filter(Boolean);
    if (alerts.length) parts.push(alerts.join(', '));
    if (clips.n) parts.push(`${clips.n} clip${clips.n === 1 ? '' : 's'} (${clips.b >= 1024 ** 3 ? `${(clips.b / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(clips.b / 1024 ** 2))} MB`})`);
    if (t.n || clips.n || alerts.length) anything = true;
    lines.push(`${car.name}: ${parts.join(' · ')}`);
  }
  const used = db.get('SELECT COALESCE(SUM(size), 0) b FROM clips').b;
  if (s.storageCapGb > 0) lines.push(`Server storage: ${(used / 1024 ** 3).toFixed(0)} of ${s.storageCapGb} GB used`);
  return { anything, title: 'Your week with Open Dash Cam', message: lines.join('\n') || 'No cars yet.' };
}

/** Called hourly: sends each person's summary once a week, at their chosen day and hour (server time). */
export function maybeSendSummaries(db, now = new Date()) {
  let sent = 0;
  for (const u of db.all('SELECT id, prefs FROM users')) {
    let p = {};
    try { p = JSON.parse(u.prefs || '{}'); } catch { /* ignore */ }
    if (!p.weeklySummary) continue;
    const day = p.summaryDay ?? 0;    // 0 = Sunday
    const hour = p.summaryHour ?? 18;
    if (now.getDay() !== day || now.getHours() !== hour) continue;
    const key = `summary_sent_${u.id}`;
    const stamp = now.toISOString().slice(0, 10);
    if (getMeta(db, key) === stamp) continue;
    setMeta(db, key, stamp);
    const s = buildSummary(db, u.id, now.getTime());
    notify(db, { title: s.title, message: s.message, tags: ['bar_chart'], userIds: [u.id], url: '/#/trips', priority: 2, kind: 'summary' });
    sent++;
  }
  return sent;
}
