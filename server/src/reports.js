import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { audit } from './audit.js';
import { getSettings } from './db.js';
import { placeName } from './geocode.js';
import { mlBlurAvailable } from './blur.js';
import { getJob, jobView, startJob } from './jobs.js';
import { prepareCopy } from './shares.js';
import { routePoints } from './tracks.js';
import { HttpError, now, readJson, send } from './util.js';
import { writeZip } from './zip.js';

/**
 * Incident reports: one ZIP with every camera's footage around a moment (trimmed, optionally with plates
 * and faces blurred), a printable report.html (summary, route map, speed graph, events, notes) and the
 * GPS track as GPX. Meant for an insurer or a police report.
 */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const clock = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const dateLong = (t) => new Date(t).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

function speedSvg(points, from, to, t, mph) {
  const W = 800, H = 220, L = 46, B = 28, T = 10, R = 10;
  const conv = mph ? 2.23694 : 3.6;
  const sp = points.filter((p) => p.speed != null && p.t >= from && p.t <= to);
  if (sp.length < 2) return '<p class="muted">No speed data for this period.</p>';
  const max = Math.max(10, ...sp.map((p) => p.speed * conv));
  const top = Math.ceil(max / 10) * 10;
  const x = (tt) => L + ((tt - from) / (to - from)) * (W - L - R);
  const y = (v) => H - B - (v / top) * (H - B - T);
  const line = sp.map((p) => `${x(p.t).toFixed(1)},${y(p.speed * conv).toFixed(1)}`).join(' ');
  const grid = [];
  for (let v = 0; v <= top; v += top / 4) grid.push(`<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#ddd"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${Math.round(v)}</text>`);
  const ticks = [];
  for (let i = 0; i <= 4; i++) { const tt = from + ((to - from) * i) / 4; ticks.push(`<text x="${x(tt)}" y="${H - 8}" text-anchor="middle">${clock(tt)}</text>`); }
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Speed graph" font-size="11" font-family="sans-serif">
${grid.join('')}${ticks.join('')}
<text x="12" y="${T + 10}" transform="rotate(-90 12 ${T + 10})" text-anchor="end">${mph ? 'mph' : 'km/h'}</text>
<polyline points="${line}" fill="none" stroke="#d9480f" stroke-width="2"/>
<line x1="${x(t)}" x2="${x(t)}" y1="${T}" y2="${H - B}" stroke="#000" stroke-dasharray="4 3"/><text x="${x(t) + 4}" y="${T + 10}">incident</text></svg>`;
}

function gpx(points) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Open Dash Cam" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Incident</name><trkseg>
${points.map((p) => `<trkpt lat="${p.lat}" lon="${p.lon}"><time>${new Date(p.t).toISOString()}</time>${p.speed != null ? `<extensions><speed>${p.speed}</speed></extensions>` : ''}</trkpt>`).join('\n')}
</trkseg></trk></gpx>
`;
}

export function registerReportRoutes(router, app, { requireUser }) {
  const { db } = app;
  const { visibleCarIds } = app.helpers;

  router.add('POST', '/api/reports', async (ctx) => {
    const u = requireUser(ctx);
    const b = await readJson(ctx.req);
    const carId = Number(b.carId);
    if (!visibleCarIds(db, u).includes(carId)) throw new HttpError(404, 'Car not found');
    const t = Number(b.t);
    const before = Math.min(600, Math.max(5, Number(b.beforeS) || 60));
    const after = Math.min(600, Math.max(5, Number(b.afterS) || 60));
    if (!t) throw new HttpError(400, 'Choose the moment of the incident.');
    const blur = { blurPlates: !!b.blurPlates, blurFaces: !!b.blurFaces };
    if ((blur.blurPlates || blur.blurFaces) && !(await mlBlurAvailable(db))) throw new HttpError(400, 'Blurring needs the ML container (smart search) running and reachable.');
    const mph = b.units === 'mph';
    const note = String(b.note || '').slice(0, 4000);
    const car = db.get('SELECT * FROM cars WHERE id = ?', carId);
    const from = t - before * 1000;
    const to = t + after * 1000;
    const job = startJob(u.id, 'report', `Incident report: ${car.name}, ${new Date(t).toLocaleString()}`, async ({ progress }) => {
      const dir = path.join(config.cacheDir, 'reports', `${Date.now()}-${carId}`);
      fs.mkdirSync(path.join(dir, 'clips'), { recursive: true });
      try {
        const clips = db.all(`SELECT c.*, m.label AS camera FROM clips c JOIN cameras m ON m.id = c.camera_id
          WHERE c.car_id = ? AND c.encrypted = 0 AND c.started_at < ? AND c.started_at + COALESCE(c.duration_ms, 180000) > ? ORDER BY m.label, c.started_at`,
          carId, to, from);
        const pieces = [];
        for (let i = 0; i < clips.length; i++) {
          const c = clips[i];
          const dur = (c.duration_ms || 180_000) / 1000;
          const s = Math.max(0, (from - c.started_at) / 1000);
          const e = Math.min(dur, (to - c.started_at) / 1000);
          if (e - s < 1) continue;
          const name = `${c.camera} ${clock(c.started_at + s * 1000).replace(/:/g, '-')}.mp4`.replace(/[\\/:*?"<>|]/g, '_');
          const out = path.join(dir, 'clips', name);
          await prepareCopy(db, c, out, { start: s, end: e, ...blur }, (p, step) => progress((i + p) / Math.max(1, clips.length) * 0.9, `${step || 'Preparing'} ${c.camera} (${i + 1} of ${clips.length})`));
          pieces.push({ name, camera: c.camera, start: c.started_at + s * 1000, end: c.started_at + e * 1000 });
        }
        progress(0.92, 'Writing the report');
        const route = routePoints(db, carId, t - 5 * 60_000, t + 5 * 60_000);
        const at = route.length ? route.reduce((a, p) => (Math.abs(p.t - t) < Math.abs(a.t - t) ? p : a)) : null;
        const inWindow = route.filter((p) => p.t >= from && p.t <= to && p.speed != null);
        const conv = mph ? 2.23694 : 3.6;
        const unit = mph ? 'mph' : 'km/h';
        const events = db.all('SELECT * FROM events WHERE car_id = ? AND t BETWEEN ? AND ? ORDER BY t', carId, from, to);
        const place = at ? placeName(at.lat, at.lon) : null;
        const rows = [
          ['Date', dateLong(t)],
          ['Time of incident', `${clock(t)} (server time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone})`],
          ['Vehicle', car.name],
          ['Location', at ? `${place ? esc(place) + ' · ' : ''}<a href="https://www.openstreetmap.org/?mlat=${at.lat}&mlon=${at.lon}#map=18/${at.lat}/${at.lon}">${at.lat.toFixed(6)}, ${at.lon.toFixed(6)}</a>` : 'No GPS data'],
          ['Speed at that moment', at?.speed != null && Math.abs(at.t - t) < 5000 ? `${Math.round(at.speed * conv)} ${unit}` : 'Unknown'],
          ['Top speed in this period', inWindow.length ? `${Math.round(Math.max(...inWindow.map((p) => p.speed)) * conv)} ${unit}` : 'Unknown'],
          ['Period covered', `${clock(from)} – ${clock(to)} (${before} s before, ${after} s after)`],
          ['Footage', pieces.length ? `${pieces.length} video file${pieces.length === 1 ? '' : 's'} from ${[...new Set(pieces.map((p) => p.camera))].join(', ')}` : 'No footage covers this period'],
          ...(blur.blurPlates || blur.blurFaces ? [['Privacy', `${[blur.blurPlates && 'License plates', blur.blurFaces && 'faces'].filter(Boolean).join(' and ')} blurred in the video`]] : []),
        ];
        const eventRows = events.map((e) => {
          const d = (() => { try { return JSON.parse(e.data || '{}'); } catch { return {}; } })();
          const details = Object.entries(d).filter(([, v]) => v != null && typeof v !== 'object').map(([k, v]) => (k === 'message' ? String(v) : `${k}: ${v}`)).join(' · ');
          return `<tr><td>${clock(e.t)}</td><td>${esc(e.type)}</td><td>${esc(details)}</td></tr>`;
        }).join('');
        const geo = JSON.stringify({ type: 'Feature', geometry: { type: 'LineString', coordinates: route.map((p) => [p.lon, p.lat]) } });
        const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Incident report · ${esc(car.name)} · ${esc(dateLong(t))}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css">
<style>body{font:15px/1.5 system-ui,sans-serif;color:#111;max-width:960px;margin:2rem auto;padding:0 1rem}h1{margin-bottom:.2rem}
table{border-collapse:collapse;width:100%;margin:.5rem 0 1.5rem}td,th{border-bottom:1px solid #ddd;padding:.4rem .5rem;text-align:left;vertical-align:top}
td:first-child{width:30%;color:#555}.muted{color:#666;font-size:.9rem}#map{height:380px;border:1px solid #ccc;border-radius:6px}
video{width:100%;max-width:640px;background:#000;border-radius:6px}.clip{margin:1rem 0}.note{white-space:pre-wrap;border-left:3px solid #d9480f;padding-left:.75rem}
@media print{#map{display:none}.noprint{display:none}video{display:none}}</style></head><body>
<h1>Incident report</h1><p class="muted">Created ${esc(new Date().toLocaleString())} with Open Dash Cam. Footage is unedited apart from trimming${blur.blurPlates || blur.blurFaces ? ' and privacy blurring' : ''}.</p>
<table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${k === 'Location' ? v : esc(v)}</td></tr>`).join('')}</table>
${note ? `<h2>Notes</h2><p class="note">${esc(note)}</p>` : ''}
<h2>Route</h2>${route.length ? `<div id="map"></div><p class="muted noprint">The map needs an internet connection. The route is also in <code>route.gpx</code>.</p>` : '<p class="muted">No GPS data for this period.</p>'}
<h2>Speed</h2>${speedSvg(route, from, to, t, mph)}
<h2>Events</h2>${eventRows ? `<table><tr><th>Time</th><th>Type</th><th>Details</th></tr>${eventRows}</table>` : '<p class="muted">No events recorded in this period.</p>'}
<h2>Footage</h2><p class="muted noprint">Extract the whole ZIP first so the videos play here. They're in the <code>clips</code> folder.</p>
${pieces.map((p) => `<div class="clip"><strong>${esc(p.camera)}</strong> · ${clock(p.start)} – ${clock(p.end)}<br><video src="clips/${encodeURI(p.name)}" controls preload="metadata"></video><div class="muted">clips/${esc(p.name)}</div></div>`).join('') || '<p class="muted">None.</p>'}
${route.length ? `<script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script><script>
try{const r=${geo};const m=new maplibregl.Map({container:'map',style:'https://tiles.openfreemap.org/styles/liberty',center:[${at.lon},${at.lat}],zoom:15});
m.on('load',()=>{m.addSource('r',{type:'geojson',data:r});m.addLayer({id:'r',type:'line',source:'r',paint:{'line-color':'#d9480f','line-width':4}});
new maplibregl.Marker({color:'#000'}).setLngLat([${at.lon},${at.lat}]).addTo(m);const b=new maplibregl.LngLatBounds();r.geometry.coordinates.forEach(c=>b.extend(c));m.fitBounds(b,{padding:40,maxZoom:16});});}
catch(e){document.getElementById('map').textContent='The map couldn\\u2019t load (no internet connection?).';}</script>` : ''}
</body></html>`;
        fs.writeFileSync(path.join(dir, 'report.html'), html);
        if (route.length) fs.writeFileSync(path.join(dir, 'route.gpx'), gpx(route));
        fs.writeFileSync(path.join(dir, 'README.txt'), 'Open report.html in a web browser (extract the whole ZIP first so the videos play).\r\nTo make a PDF, print report.html and choose "Save as PDF".\r\n');
        const stamp = new Date(t).toISOString().slice(0, 16).replace(/[:T]/g, '-');
        const zipPath = `${dir}.zip`;
        const entries = [
          { name: 'report.html', path: path.join(dir, 'report.html') },
          { name: 'README.txt', path: path.join(dir, 'README.txt') },
          ...(route.length ? [{ name: 'route.gpx', path: path.join(dir, 'route.gpx') }] : []),
          ...pieces.map((p) => ({ name: `clips/${p.name}`, path: path.join(dir, 'clips', p.name) })),
        ];
        await writeZip(fs.createWriteStream(zipPath), entries);
        await new Promise((r) => setTimeout(r, 200));
        return { file: zipPath, name: `Incident-${car.name.replace(/[^\w-]+/g, '_')}-${stamp}.zip`, clips: pieces.length, hasRoute: route.length > 0 };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
    audit(db, { user: u, action: 'incident report created', target: `${car.name} · ${new Date(t).toLocaleString()}`, ip: ctx.ip,
      detail: [blur.blurPlates && 'plates blurred', blur.blurFaces && 'faces blurred'].filter(Boolean).join(', ') || null });
    send(ctx.res, 202, { jobId: job.id });
  });

  router.add('GET', '/api/jobs/:id', (ctx) => {
    const u = requireUser(ctx);
    const j = getJob(ctx.params.id);
    if (!j || j.userId !== u.id) throw new HttpError(404, 'Job not found');
    const v = jobView(j);
    if (j.kind === 'report' && j.result) v.result = { clips: j.result.clips, hasRoute: j.result.hasRoute, downloadUrl: `/api/reports/${j.id}/download` };
    send(ctx.res, 200, v);
  });

  router.add('GET', '/api/reports/:id/download', (ctx) => {
    const u = requireUser(ctx);
    const j = getJob(ctx.params.id);
    if (!j || j.userId !== u.id || j.status !== 'done' || !fs.existsSync(j.result.file)) throw new HttpError(404, 'This report is no longer available. Create it again.');
    app.serveFile(ctx, j.result.file, 'application/zip', { 'Content-Disposition': `attachment; filename="${j.result.name}"` });
  });
}

/** Reports are kept for a day. */
export function cleanReports() {
  const dir = path.join(config.cacheDir, 'reports');
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const p = path.join(dir, f);
    if (Date.now() - fs.statSync(p).mtimeMs > 86400_000) fs.rmSync(p, { recursive: true, force: true });
  }
}
void getSettings; void now;
