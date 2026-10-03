import { getSettings } from './db.js';

/**
 * Sends alerts to ntfy (https://ntfy.sh or self-hosted). The URL includes the topic,
 * e.g. https://ntfy.example.com/odc-alerts. Failures are logged and ignored.
 */
export async function notify(db, { title, message, priority = 3, tags = [] }) {
  const s = getSettings(db);
  if (!s.ntfyUrl) return false;
  try {
    const headers = { Title: asciiHeader(title), Priority: String(priority) };
    if (tags.length) headers.Tags = tags.join(',');
    if (s.ntfyToken) headers.Authorization = `Bearer ${s.ntfyToken}`;
    const r = await fetch(s.ntfyUrl, { method: 'POST', headers, body: message, signal: AbortSignal.timeout(10_000) });
    return r.ok;
  } catch (e) {
    console.warn('ntfy failed:', e.message);
    return false;
  }
}

// HTTP header values must be ASCII; ntfy also reads RFC 2047, but plain ASCII keeps it simple.
const asciiHeader = (s) => String(s).replace(/[^\x20-\x7E]/g, '').slice(0, 200);
