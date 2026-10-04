import { getSettings } from './db.js';

/**
 * Security headers for every response. The web app loads its map and QR code libraries from public
 * CDNs and map tiles from the configured map style, so those are allowed; everything else is same-origin.
 */
export function securityHeaders(db, req, res, secure) {
  const s = getSettings(db);
  let mapOrigin = '';
  try { mapOrigin = new URL(s.mapStyleUrl).origin; } catch { /* ignore */ }
  const csp = [
    "default-src 'self'",
    "script-src 'self' https://unpkg.com https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://unpkg.com",
    `img-src 'self' data: blob: https:`,
    `connect-src 'self' https: ${mapOrigin}`.trim(),
    "worker-src 'self' blob:",
    "media-src 'self' blob:",
    "font-src 'self' data: https:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ');
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (secure && s.httpsOnly) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

/**
 * HTTPS-only mode: browsers arriving over plain HTTP are redirected to HTTPS. The phone API (/api/v1)
 * is left alone so phones paired with an http:// address keep working; they show their own warning.
 * Returns true if the request was redirected.
 */
export function httpsRedirect(db, req, res, secure, httpsPort) {
  if (secure || !getSettings(db).httpsOnly) return false;
  const url = new URL(req.url, 'http://local');
  if (url.pathname.startsWith('/api/v1/')) return false;
  const pub = process.env.ODC_PUBLIC_URL || '';
  let target;
  if (pub.startsWith('https://')) target = pub.replace(/\/$/, '') + req.url;
  else {
    const host = (req.headers.host || 'localhost').replace(/:\d+$/, '');
    target = `https://${host}:${httpsPort}${req.url}`;
  }
  res.writeHead(308, { Location: target });
  res.end();
  return true;
}
