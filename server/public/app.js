// Open Dash Cam web app. No build step: plain ES modules. MapLibre and the QR library load on demand.
const MAPLIBRE_JS = 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js';
const MAPLIBRE_CSS = 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css';
const QR_JS = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js';

// ---------------------------------------------------------------- helpers

const $ = (sel, el = document) => el.querySelector(sel);
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await r.json(); } catch { /* empty */ }
  if (r.status === 401 && !url.startsWith('/api/login') && !url.startsWith('/api/setup')) {
    state.me = null;
    render();
    throw new Error('Please sign in.');
  }
  if (!r.ok && r.status !== 202) {
    const err = new Error(data?.error || `Request failed (${r.status})`);
    err.data = data;
    throw err;
  }
  return { status: r.status, data };
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 3000);
}

const loaded = new Map();
function loadScript(src) {
  if (!loaded.has(src)) loaded.set(src, new Promise((res, rej) => {
    const s = h('script', { src });
    s.onload = res;
    s.onerror = () => rej(new Error('Could not load ' + src));
    document.head.append(s);
  }));
  return loaded.get(src);
}
async function loadMapLibre() {
  if (!document.querySelector(`link[href="${MAPLIBRE_CSS}"]`)) document.head.append(h('link', { rel: 'stylesheet', href: MAPLIBRE_CSS }));
  await loadScript(MAPLIBRE_JS);
  return window.maplibregl;
}

const fmtBytes = (b) => b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : b >= 1024 ** 2 ? `${Math.round(b / 1024 ** 2)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDateTime = (t) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const fmtDay = (t) => new Date(t).toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
const fmtDur = (ms) => { if (!ms) return ''; const s = Math.round(ms / 1000); const m = Math.floor(s / 60); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}:${String(s % 60).padStart(2, '0')}`; };
function ago(t) {
  if (!t) return 'never';
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return fmtDateTime(t);
}
/** Imperial for 'mph', metric for 'kmh'; 'auto' follows the browser's region (US, UK, Liberia, Myanmar). */
/** The browser's region, from its language list or, failing that, its date/number formatting locale. */
function browserRegion() {
  const locales = [...(navigator.languages || []), navigator.language, Intl.DateTimeFormat().resolvedOptions().locale];
  for (const l of locales) {
    const m = /[-_]([A-Za-z]{2})(?:[-_]|$)/.exec(l || '');
    if (m) return m[1].toUpperCase();
  }
  return null;
}

function isImperial(units) {
  if (units === 'mph') return true;
  if (units === 'kmh') return false;
  return ['US', 'GB', 'LR', 'MM'].includes(browserRegion());
}

const useMph = () => isImperial(state.me?.settings?.units);
const fmtSpeed = (ms) => ms == null ? '' : useMph() ? `${Math.round(ms * 2.23694)} mph` : `${Math.round(ms * 3.6)} km/h`;
const fmtShortDist = (m) => useMph() ? `${Math.round(m / 0.3048)} ft` : `${Math.round(m)} m`;
const fmtDist = (m) => useMph() ? `${(m / 1609.34).toFixed(1)} mi` : `${(m / 1000).toFixed(1)} km`;

// ---------------------------------------------------------------- state and routing

const state = { me: null, setup: null, cars: [], cleanup: [] };
const routes = {
  timeline: pageTimeline, map: pageMap, trips: pageTrips, trip: pageTrip, cars: pageCars,
  events: pageEvents, settings: pageSettings, sync: pageSync, search: pageSearch, plates: pagePlates, plate: pagePlate,
};

function parseHash() {
  const [path, qs] = (location.hash.slice(2) || 'timeline').split('?');
  const [page, id] = path.split('/');
  return { page, id, params: new URLSearchParams(qs || '') };
}

async function boot() {
  try {
    state.setup = (await api('GET', '/api/setup')).data;
    if (!state.setup.needsSetup) state.me = (await api('GET', '/api/me')).data;
  } catch { /* not signed in */ }
  render();
}

window.addEventListener('hashchange', render);

function render() {
  state.cleanup.forEach((fn) => fn());
  state.cleanup = [];
  const root = $('#app');
  root.replaceChildren();
  if (state.setup?.needsSetup || state.wizard) return root.append(setupWizard());
  if (!state.me) return root.append(loginPage());
  const { page, id, params } = parseHash();
  const nav = (key, label) => h('a', { href: `#/${key}`, class: page === key || (key === 'trips' && page === 'trip') || (key === 'timeline' && page === 'sync') || (key === 'plates' && page === 'plate') ? 'active' : '' }, label);
  const main = h('main');
  root.append(h('div', { class: 'shell' },
    h('nav', { class: 'nav' },
      h('div', { class: 'brand' }, h('img', { src: '/icon.svg', alt: '' }), 'Open Dash Cam'),
      nav('timeline', 'Timeline'), nav('search', 'Search'), state.me.settings.plateLog ? nav('plates', 'Plates') : null, nav('map', 'Map'), nav('trips', 'Trips'), nav('cars', 'Cars'),
      nav('events', 'Events'), nav('settings', 'Settings'),
      h('div', { class: 'spacer' }),
      h('div', { class: 'muted small', style: 'padding:0 .75rem' }, `${state.me.username} · v${state.me.version}`),
      h('a', { href: '#', onclick: async (e) => { e.preventDefault(); await api('POST', '/api/logout'); state.me = null; render(); } }, 'Sign out')),
    main));
  (routes[page] || pageTimeline)(main, id, params).catch((e) => main.append(h('p', { class: 'error' }, e.message)));
}

function modal(content, narrow = false) {
  const close = () => { backdrop.remove(); content.dispatchEvent(new Event('close')); };
  const backdrop = h('div', { class: 'backdrop', onclick: (e) => { if (e.target === backdrop) close(); } },
    h('div', { class: `modal${narrow ? ' narrow' : ''}` }, content));
  const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  $('#modal-root').append(backdrop);
  return close;
}

async function loadCars() {
  state.cars = (await api('GET', '/api/cars')).data;
  return state.cars;
}

// ---------------------------------------------------------------- setup wizard and login

function setupWizard() {
  state.wizard = state.wizard || { step: 1 };
  const w = state.wizard;
  const box = h('div', { class: 'auth card stack' });
  const err = h('p', { class: 'error' });
  const steps = h('div', { class: 'steps' }, `Step ${w.step} of 4`);

  if (w.step === 1) {
    const user = h('input', { type: 'text', autocomplete: 'username', value: 'admin' });
    const pw = h('input', { type: 'password', autocomplete: 'new-password' });
    const pw2 = h('input', { type: 'password', autocomplete: 'new-password' });
    box.append(steps, h('h1', {}, 'Welcome to Open Dash Cam'),
      h('p', { class: 'muted' }, 'Create the admin account. You can add more people later.'),
      h('label', { class: 'field' }, h('span', {}, 'Username'), user),
      h('label', { class: 'field' }, h('span', {}, 'Password (8+ characters)'), pw),
      h('label', { class: 'field' }, h('span', {}, 'Repeat password'), pw2), err,
      h('button', { class: 'btn primary', onclick: async () => {
        if (pw.value !== pw2.value) return (err.textContent = "Passwords don't match.");
        try {
          await api('POST', '/api/setup', { username: user.value, password: pw.value });
          state.setup.needsSetup = false;
          state.me = (await api('GET', '/api/me')).data;
          w.step = 2;
          render();
        } catch (e) { err.textContent = e.message; }
      } }, 'Create account'));
  } else if (w.step === 2) {
    box.append(steps, h('h1', {}, 'Server settings'),
      h('p', { class: 'muted' }, 'The defaults keep all footage forever, send no alerts, and use OpenStreetMap maps. You can change anything later in Settings.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: () => { w.step = 3; render(); } }, 'Use recommended defaults'),
        h('button', { class: 'btn', onclick: async () => {
          const form = await serverSettingsForm(() => { closeIt(); w.step = 3; render(); });
          const closeIt = modal(form);
        } }, 'Customize')));
  } else if (w.step === 3) {
    const name = h('input', { type: 'text', placeholder: 'e.g. Civic' });
    box.append(steps, h('h1', {}, 'Add your first car'),
      h('p', { class: 'muted' }, 'Every camera belongs to a car. A car can have several phones, for example one facing forward and one facing back.'),
      h('label', { class: 'field' }, h('span', {}, 'Car name'), name), err,
      h('button', { class: 'btn primary', onclick: async () => {
        try {
          w.car = (await api('POST', '/api/cars', { name: name.value })).data;
          w.step = 4;
          render();
        } catch (e) { err.textContent = e.message; }
      } }, 'Add car'));
  } else {
    box.append(steps, h('h1', {}, 'Connect a phone'),
      h('p', { class: 'muted' }, `Open ODC on the phone → Settings → ODC Server → Pair with server, and scan this code. It works once and expires in 10 minutes.`));
    const holder = h('div');
    box.append(holder, h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: () => { state.wizard = null; location.hash = '#/timeline'; render(); } }, 'Done'),
      h('span', { class: 'muted small' }, 'You can add more phones from the Cars page.')));
    pairingPanel(w.car.id, 'Front').then((p) => holder.append(p)).catch((e) => holder.append(h('p', { class: 'error' }, e.message)));
  }
  return box;
}

function loginPage() {
  const user = h('input', { type: 'text', autocomplete: 'username' });
  const pw = h('input', { type: 'password', autocomplete: 'current-password' });
  const code = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '123456' });
  const codeField = h('label', { class: 'field', style: 'display:none' }, h('span', {}, 'Code from your authenticator app (or a recovery code)'), code);
  const err = h('p', { class: 'error' });
  const submit = async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/login', { username: user.value, password: pw.value, code: code.value || undefined });
      state.me = (await api('GET', '/api/me')).data;
      render();
    } catch (ex) {
      if (ex.data?.totpRequired) {
        const first = codeField.style.display === 'none';
        codeField.style.display = '';
        code.focus();
        err.textContent = first ? '' : ex.message;
      } else err.textContent = ex.message;
    }
  };
  return h('form', { class: 'auth card stack', onsubmit: submit },
    h('div', { class: 'brand' }, h('img', { src: '/icon.svg', alt: '', style: 'width:36px' }), h('h1', { style: 'margin:0' }, 'Open Dash Cam')),
    h('label', { class: 'field' }, h('span', {}, 'Username'), user),
    h('label', { class: 'field' }, h('span', {}, 'Password'), pw), codeField, err,
    h('button', { class: 'btn primary', type: 'submit' }, 'Sign in'));
}

// ---------------------------------------------------------------- pairing

async function pairingPanel(carId, label) {
  const { data } = await api('POST', `/api/cars/${carId}/pairing`, { label });
  await loadScript(QR_JS);
  const qr = window.qrcode(0, 'M');
  qr.addData(data.qr);
  qr.make();
  const left = h('span', { class: 'muted small' });
  const tick = () => {
    const s = Math.max(0, Math.round((data.expiresAt - Date.now()) / 1000));
    left.textContent = s > 0 ? `Expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'Expired. Create a new code.';
  };
  tick();
  const timer = setInterval(tick, 1000);
  state.cleanup.push(() => clearInterval(timer));
  return h('div', { class: 'stack', style: 'text-align:center' },
    h('div', { class: 'qr', html: qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }) }),
    h('div', {}, h('div', { class: 'muted small' }, 'Or enter the code by hand:'), h('div', { class: 'code' }, data.code.replace(/(.{4})/, '$1 '))),
    h('div', { class: 'muted small' }, `Server address: ${data.url}`), left);
}

// ---------------------------------------------------------------- timeline

async function pageTimeline(main, _id, params) {
  await loadCars();
  const f = {
    car: params.get('car') || '', sort: 'date', order: 'desc',
    locked: false, impact: false, parking: false,
  };
  const grid = h('div');
  const more = h('button', { class: 'btn', style: 'margin-top:1rem' }, 'Load more');
  let offset = 0;
  let total = 0;
  let lastDay = null;
  let section = null;

  const carSel = h('select', { onchange: () => { f.car = carSel.value; reload(); } },
    h('option', { value: '' }, 'All cars'), state.cars.map((c) => h('option', { value: c.id, selected: String(c.id) === f.car }, c.name)));
  const sortSel = h('select', { onchange: () => { f.sort = sortSel.value; reload(); } },
    ['date', 'size', 'car', 'camera', 'location'].map((s) => h('option', { value: s }, `Sort by ${s}`)));
  const orderBtn = h('button', { class: 'btn', onclick: () => { f.order = f.order === 'desc' ? 'asc' : 'desc'; orderBtn.textContent = f.order === 'desc' ? '↓ Newest/largest first' : '↑ Oldest/smallest first'; reload(); } }, '↓ Newest/largest first');
  const chip = (key, label) => {
    const c = h('button', { class: 'chip', onclick: () => { f[key] = !f[key]; c.classList.toggle('on', f[key]); reload(); } }, label);
    return c;
  };
  const count = h('span', { class: 'muted small' });

  main.append(h('h1', {}, 'Timeline'),
    h('div', { class: 'toolbar' }, carSel, sortSel, orderBtn, chip('locked', 'Locked'), chip('impact', 'Impact'), chip('parking', 'Parking'), count),
    grid, more);

  async function load() {
    const q = new URLSearchParams({ sort: f.sort, order: f.order, limit: 120, offset });
    if (f.car) q.set('car', f.car);
    for (const k of ['locked', 'impact', 'parking']) if (f[k]) q.set(k, '1');
    const { data } = await api('GET', `/api/clips?${q}`);
    total = data.total;
    offset += data.clips.length;
    count.textContent = `${total} clips`;
    if (!total) grid.replaceChildren(h('p', { class: 'muted' }, state.cars.length
      ? 'No footage yet. Clips appear here as phones upload them.'
      : 'Add a car and connect a phone on the Cars page to get started.'));
    for (const c of data.clips) {
      const dayKey = f.sort === 'date' ? new Date(c.startedAt).toDateString() : 'all';
      if (dayKey !== lastDay) {
        lastDay = dayKey;
        if (f.sort === 'date') grid.append(h('div', { class: 'day' }, fmtDay(c.startedAt)));
        section = h('div', { class: 'grid' });
        grid.append(section);
      }
      section.append(clipTile(c));
    }
    more.style.display = offset < total ? '' : 'none';
  }
  async function reload() {
    offset = 0;
    lastDay = null;
    grid.replaceChildren();
    await load();
  }
  more.onclick = load;
  await load();
}

function clipTile(c, onChange, offsetMs) {
  const tags = [];
  if (c.lockReason === 'impact') tags.push(h('span', { class: 'badge red' }, 'Impact'));
  else if (c.locked) tags.push(h('span', { class: 'badge accent' }, 'Locked'));
  if (c.mode?.startsWith('parking')) tags.push(h('span', { class: 'badge' }, 'Parking'));
  if (c.encrypted) tags.push(h('span', { class: 'badge' }, 'Encrypted'));
  if (offsetMs != null) tags.push(h('span', { class: 'badge accent' }, `at ${fmtDur(Math.max(1000, offsetMs))}`));
  const thumb = h('div', { class: 'thumb', style: c.hasThumb ? `background-image:url('/api/clips/${c.id}/thumb')` : '' },
    !c.hasThumb ? (c.encrypted ? 'Encrypted' : 'Processing…') : null,
    h('div', { class: 'tags' }, tags),
    c.durationMs ? h('div', { class: 'dur' }, fmtDur(c.durationMs)) : null);
  return h('div', { class: 'tile', onclick: () => openClip(c.id, onChange, offsetMs) }, thumb,
    h('div', { class: 'meta' },
      h('div', {}, h('strong', {}, fmtTime(c.startedAt)), ` · ${c.carName} · ${c.camera}`),
      h('div', { class: 'muted' }, [c.place, fmtBytes(c.size), c.codec?.toUpperCase()].filter(Boolean).join(' · '))));
}

async function openClip(id, onChange, offsetMs) {
  const { data: c } = await api('GET', `/api/clips/${id}`);
  const car = state.cars.find((x) => x.id === c.carId);
  const canManage = car && car.role !== 'viewer';
  const video = h('video', { controls: true, playsinline: true, preload: 'metadata' });
  const note = h('p', { class: 'muted small' });
  const body = h('div', { class: 'stack' });
  if (offsetMs) video.addEventListener('loadedmetadata', () => { video.currentTime = offsetMs / 1000; }, { once: true });

  const hevc = c.codec === 'hevc';
  const canHevc = video.canPlayType('video/mp4; codecs="hvc1"') || video.canPlayType('video/mp4; codecs="hev1.1.6.L93.B0"');
  let polling = true;
  body.addEventListener('close', () => { polling = false; video.pause(); video.removeAttribute('src'); video.load(); });
  if (c.encrypted) {
    note.replaceChildren();
    const pass = h('input', { type: 'password', placeholder: 'Encryption passphrase', autocomplete: 'off' });
    const err = h('span', { class: 'error small' });
    const go = h('button', { class: 'btn primary', onclick: async () => {
      go.disabled = true;
      go.textContent = 'Decrypting…';
      try {
        const r = await api('POST', `/api/clips/${id}/decrypt`, { passphrase: pass.value });
        video.src = r.data.streamUrl;
        body.prepend(video);
        note.replaceChildren(h('span', { class: 'muted small' }, 'Decrypted on the server for playback. The passphrase isn’t stored, and the decrypted copy is deleted an hour after you stop watching.'));
        video.play().catch(() => {});
      } catch (e) {
        err.textContent = e.message;
        go.disabled = false;
        go.textContent = 'Decrypt and play';
      }
    } }, 'Decrypt and play');
    note.append(h('span', { class: 'muted small' }, 'This clip was encrypted on the phone. '), h('div', { class: 'row', style: 'margin-top:.5rem' }, pass, go, err));
  } else if (hevc && !canHevc) {
    note.textContent = 'This browser can’t play H.265, so the server is preparing a compatible copy…';
    (async () => {
      // A 1-byte range request: 202 = still converting, 206/200 = ready.
      while (polling) {
        const r = await fetch(`/api/clips/${id}/stream?codec=h264`, { headers: { Range: 'bytes=0-0' } }).catch(() => null);
        if (r && r.status !== 202) break;
        await new Promise((res) => setTimeout(res, 3000));
      }
      if (!polling) return;
      note.textContent = 'Playing a converted H.264 copy. The original is unchanged.';
      video.src = `/api/clips/${id}/stream?codec=h264`;
    })();
  } else {
    video.src = `/api/clips/${id}/stream`;
  }

  const lockBtn = h('button', { class: 'btn', disabled: !canManage, onclick: async () => {
    const r = await api('PATCH', `/api/clips/${id}`, { locked: !c.locked });
    c.locked = r.data.locked;
    lockBtn.textContent = c.locked ? 'Unlock' : 'Lock';
    toast(c.locked ? 'Locked: retention rules won’t remove it.' : 'Unlocked.');
    onChange?.();
  } }, c.locked ? 'Unlock' : 'Lock');
  const del = h('button', { class: 'btn danger', disabled: !canManage, onclick: async () => {
    if (!confirm('Delete this clip from the server? Copies on phones and SMB shares are not affected.')) return;
    await api('DELETE', `/api/clips/${id}`);
    close();
    toast('Clip deleted.');
    render();
  } }, 'Delete');
  const dl = h('a', { class: 'btn', href: `/api/clips/${id}/download` }, 'Download');
  const syncLink = !c.encrypted ? h('a', { class: 'btn', href: `#/sync?car=${c.carId}&from=${c.startedAt - 60000}&to=${c.startedAt + 20 * 60000}&t=${c.startedAt}`, onclick: () => close() }, 'Watch all cameras') : null;
  const mapLink = c.hasTrack ? h('a', { class: 'btn', href: `#/map?car=${c.carId}&from=${c.startedAt}&to=${c.startedAt + (c.durationMs || 180000)}`, onclick: () => close() }, 'Show route on map') : null;

  body.append(c.encrypted ? null : video, note,
    h('div', { class: 'row' }, h('h2', { class: 'grow', style: 'margin:0' }, `${c.carName} · ${c.camera}`), syncLink, lockBtn, dl, mapLink, del),
    h('table', {},
      [['Recorded', fmtDateTime(c.startedAt)], ['Place', c.place || (c.lat != null ? `${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}` : '')], ['Length', fmtDur(c.durationMs)], ['Size', fmtBytes(c.size)],
        ['Video', [c.width && `${c.width}×${c.height}`, c.fps && `${c.fps} fps`, c.codec?.toUpperCase()].filter(Boolean).join(' · ')],
        ['Mode', c.mode || ''], ['Lock', c.locked ? (c.lockReason === 'impact' ? 'Locked by impact detection' : 'Locked') : 'Not locked'],
        ['SHA-256', h('code', { class: 'small' }, c.sha256)], ['File', c.fileName]]
        .map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v)))));
  const close = modal(body);
}

// ---------------------------------------------------------------- search

async function pageSearch(main, _id, params) {
  await loadCars();
  const q = h('input', { type: 'text', value: params.get('q') || '', placeholder: 'Search footage: white pickup truck, bridge, a place name, a license plate…', style: 'flex:1;min-width:240px;font-size:1.05rem' });
  const carSel = h('select', {}, h('option', { value: '' }, 'All cars'), state.cars.map((c) => h('option', { value: c.id }, c.name)));
  const fromIn = h('input', { type: 'date', title: 'From' });
  const toIn = h('input', { type: 'date', title: 'To' });
  const flags = { locked: false, impact: false, parking: false };
  const chip = (key, label) => { const c = h('button', { class: 'chip', onclick: () => { flags[key] = !flags[key]; c.classList.toggle('on', flags[key]); run(); } }, label); return c; };
  const statusEl = h('div', { class: 'small muted' });
  const results = h('div');

  main.append(h('h1', {}, 'Search'),
    h('form', { class: 'toolbar', onsubmit: (e) => { e.preventDefault(); run(); } }, q, h('button', { class: 'btn primary', type: 'submit' }, 'Search')),
    h('div', { class: 'toolbar' }, carSel, h('span', { class: 'muted small' }, 'From'), fromIn, h('span', { class: 'muted small' }, 'to'), toIn,
      chip('locked', 'Locked'), chip('impact', 'Impact'), chip('parking', 'Parking')),
    statusEl, results);
  for (const el of [carSel, fromIn, toIn]) el.onchange = run;
  q.focus();

  api('GET', '/api/search/status').then(({ data: st }) => {
    if (!st.enabled) {
      statusEl.textContent = 'Searching by place, car and camera names. Searching by what’s in the video (smart search) is off' +
        (state.me.isAdmin ? '; turn it on in Settings → Smart search.' : '; an admin can turn it on.');
    } else if (!st.ml?.ready) {
      statusEl.textContent = `Smart search is on but not available: ${st.ml?.error || 'the ML model is still loading'}.`;
    } else if (st.indexed < st.searchable) {
      statusEl.textContent = `Smart search is analyzing footage: ${st.indexed} of ${st.searchable} clips done. Newer clips are analyzed first.`;
    } else {
      statusEl.textContent = `Smart search covers all ${st.indexed} clips.`;
    }
    if (st.plateSearch) {
      statusEl.textContent += ` License plate search is on (plates read in ${st.platesIndexed} of ${st.platesEligible} clips from the last ${st.plateRetentionDays} days).`;
    }
  }).catch(() => {});

  async function run() {
    const p = new URLSearchParams();
    if (q.value.trim()) p.set('q', q.value.trim());
    if (carSel.value) p.set('car', carSel.value);
    if (fromIn.value) p.set('from', new Date(fromIn.value + 'T00:00:00').getTime());
    if (toIn.value) p.set('to', new Date(toIn.value + 'T23:59:59').getTime());
    for (const k of Object.keys(flags)) if (flags[k]) p.set(k, '1');
    if (![...p.keys()].length) { results.replaceChildren(); return; }
    history.replaceState(null, '', `#/search?q=${encodeURIComponent(q.value.trim())}`);
    results.replaceChildren(h('p', { class: 'muted' }, 'Searching…'));
    const { data } = await api('GET', `/api/search?${p}`);
    results.replaceChildren();
    if (data.visualError) results.append(h('p', { class: 'error small' }, data.visualError));
    if (data.plates?.length) {
      results.append(h('h2', { style: 'margin-top:1rem' }, `License plates (${data.plates.length})`),
        h('p', { class: 'muted small' }, 'Plates read automatically can contain mistakes; close matches (like 8 for B) are included. Each opens where the plate was seen.'),
        h('div', { class: 'grid' }, data.plates.map((c) => {
          const tile = clipTile(c, null, c.offsetMs);
          tile.querySelector('.meta').append(h('div', { class: 'small' }, `Plate read as `, h('strong', {}, c.plate),
            ` · ${Math.round(c.plateConfidence * 100)}% sure${c.plateMatch < 1 ? ' · close match' : ''}`,
            state.me.settings.plateLog ? [' · ', h('a', { href: `#/plate/${c.plate}`, onclick: (e) => e.stopPropagation() }, 'all sightings')] : null));
          return tile;
        })));
    }
    if (data.visual.length) {
      results.append(h('h2', { style: 'margin-top:1rem' }, `In the video (${data.visual.length})`),
        h('p', { class: 'muted small' }, 'Best matches first. Each opens at the moment that matched.'),
        h('div', { class: 'grid' }, data.visual.map((c) => clipTile(c, null, c.offsetMs))));
    }
    if (data.text.length) {
      results.append(h('h2', { style: 'margin-top:1rem' }, q.value.trim() ? `Places and names (${data.text.length})` : `Clips (${data.text.length})`),
        h('div', { class: 'grid' }, data.text.map((c) => clipTile(c))));
    }
    if (!data.visual.length && !data.text.length && !data.plates?.length) results.append(h('p', { class: 'muted' }, 'Nothing found.'));
  }
  if (q.value) run();
}

// ---------------------------------------------------------------- plate log

async function pagePlates(main, _id, params) {
  await loadCars();
  const q = h('input', { type: 'text', value: params.get('q') || '', placeholder: 'Find a plate or note', style: 'min-width:220px' });
  const sortSel = h('select', {}, [['recent', 'Most recent'], ['sightings', 'Most sightings'], ['days', 'Most days seen'], ['plate', 'Plate A–Z']]
    .map(([v, l]) => h('option', { value: v }, l)));
  const list = h('div');
  main.append(h('h1', {}, 'Plates'),
    h('p', { class: 'muted small' }, 'Every plate read in your cars’ footage. Readings can contain mistakes: open a plate to fix misreads or merge duplicates.'),
    h('form', { class: 'toolbar', onsubmit: (e) => { e.preventDefault(); load(); } }, q, sortSel, h('button', { class: 'btn', type: 'submit' }, 'Filter')),
    list);
  sortSel.onchange = load;
  async function load() {
    const { data } = await api('GET', `/api/plates?q=${encodeURIComponent(q.value.trim())}&sort=${sortSel.value}`);
    const carName = (id) => state.cars.find((c) => c.id === id)?.name || '';
    list.replaceChildren(data.length ? h('div', { class: 'card', style: 'padding:0;overflow-x:auto' }, h('table', {},
      h('tr', {}, ['Plate', 'Note', 'Sightings', 'Days', 'First seen', 'Last seen', 'Seen by'].map((x) => h('th', {}, x))),
      data.map((p) => h('tr', { style: 'cursor:pointer', onclick: () => (location.hash = `#/plate/${p.plate}`) },
        h('td', {}, h('strong', { style: 'font-family:ui-monospace,monospace;font-size:1.05rem' }, p.plate)),
        h('td', { class: 'small' }, p.note || ''), h('td', {}, p.sightings), h('td', {}, p.days),
        h('td', { class: 'small' }, fmtDateTime(p.first)), h('td', { class: 'small' }, fmtDateTime(p.last)),
        h('td', { class: 'small' }, p.cars.map(carName).join(', '))))))
      : h('p', { class: 'muted' }, q.value ? 'No plates match.' : 'No plates read yet. Plates appear as footage is analyzed.'));
  }
  await load();
}

async function pagePlate(main, plateParam) {
  await loadCars();
  let data;
  try {
    data = (await api('GET', `/api/plates/${encodeURIComponent(plateParam)}`)).data;
  } catch (e) {
    main.append(h('a', { href: '#/plates' }, '‹ Plates'), h('p', { class: 'muted' }, e.message));
    return;
  }
  const noteIn = h('input', { type: 'text', value: data.note || '', placeholder: 'Your note (only you see it)', style: 'min-width:260px' });
  const reload = () => render();
  main.append(h('a', { href: '#/plates' }, '‹ Plates'),
    h('h1', { style: 'margin-top:.5rem;font-family:ui-monospace,monospace;letter-spacing:.05em' }, data.plate),
    h('p', { class: 'muted' }, `${data.reads.length} sightings · first ${fmtDateTime(data.reads[data.reads.length - 1].t)} · last ${fmtDateTime(data.reads[0].t)}`),
    h('div', { class: 'row', style: 'margin-bottom:1rem' }, noteIn,
      h('button', { class: 'btn', onclick: async () => { await api('PATCH', `/api/plates/${data.plate}`, { note: noteIn.value }); toast('Saved.'); } }, 'Save note'),
      h('button', { class: 'btn', onclick: async () => {
        const into = prompt(`Merge all sightings of ${data.plate} into which plate?`);
        if (!into) return;
        try { const r = await api('POST', `/api/plates/${data.plate}/merge`, { into }); location.hash = `#/plate/${r.data.plate}`; } catch (e) { toast(e.message); }
      } }, 'Merge into…')));

  if (data.similar.length) {
    main.append(h('div', { class: 'card stack', style: 'margin-bottom:1rem' },
      h('h3', {}, 'Possibly the same plate'),
      h('p', { class: 'muted small' }, 'These readings differ by a look-alike or one character. If they’re the same vehicle, merge them here; future readings of that text will be merged automatically.'),
      data.similar.map((sp) => h('div', { class: 'row' },
        h('a', { href: `#/plate/${sp.plate}`, style: 'font-family:ui-monospace,monospace;font-weight:700' }, sp.plate),
        h('span', { class: 'muted small grow' }, `${sp.sightings} sightings · last ${ago(sp.last)}`),
        h('button', { class: 'btn small primary', onclick: async () => {
          await api('POST', `/api/plates/${sp.plate}/merge`, { into: data.plate });
          toast(`Merged ${sp.plate} into ${data.plate}.`);
          reload();
        } }, 'Same plate: merge'),
        h('a', { class: 'btn small', href: `#/plate/${sp.plate}` }, 'Compare')))));
  }

  main.append(h('h2', {}, 'Sightings'), h('div', { class: 'grid' }, data.reads.map((r) => {
    const car = state.cars.find((c) => c.id === r.carId);
    const canManage = car && car.role !== 'viewer';
    return h('div', { class: 'tile' },
      h('div', { class: 'thumb', style: `background-image:url('/api/plates/reads/${r.id}/crop');background-size:contain;cursor:pointer`, onclick: () => openClip(r.clipId, null, r.offsetMs) }),
      h('div', { class: 'meta' },
        h('div', {}, h('strong', {}, fmtDateTime(r.t))),
        h('div', { class: 'muted' }, [r.carName, r.camera, r.place].filter(Boolean).join(' · ')),
        h('div', { class: 'small' }, `${Math.round(r.confidence * 100)}% sure`, r.corrected ? ' · corrected' : ''),
        h('div', { class: 'row', style: 'margin-top:.35rem' },
          h('button', { class: 'btn small', onclick: () => openClip(r.clipId, null, r.offsetMs) }, 'Play'),
          canManage ? h('button', { class: 'btn small', onclick: async () => {
            const p = prompt('What does this plate actually say?', data.plate);
            if (!p) return;
            await api('PATCH', `/api/plates/reads/${r.id}`, { plate: p });
            toast('Reading corrected.');
            reload();
          } }, 'Fix reading') : null,
          canManage ? h('button', { class: 'btn small danger', onclick: async () => {
            await api('DELETE', `/api/plates/reads/${r.id}`);
            toast('Reading removed.');
            reload();
          } }, 'Not a plate') : null)));
  })));
}

// ---------------------------------------------------------------- map

async function pageMap(main, _id, params) {
  await loadCars();
  const mapEl = h('div', { class: 'map' });
  const side = h('div', { class: 'map-side stack' });
  const carSel = h('select', {}, state.cars.map((c) => h('option', { value: c.id, selected: String(c.id) === params.get('car') }, c.name)));
  const today = new Date().toISOString().slice(0, 10);
  const dateIn = h('input', { type: 'date', value: params.get('from') ? new Date(Number(params.get('from'))).toISOString().slice(0, 10) : today });
  const routeInfo = h('div', { class: 'muted small' });
  const list = h('div', { class: 'stack' });
  side.append(h('h1', {}, 'Map'), list,
    h('div', { class: 'card stack' }, h('h3', {}, 'Route history'),
      state.cars.length ? h('div', { class: 'row' }, carSel, dateIn, h('button', { class: 'btn', onclick: () => showRoute() }, 'Show')) : h('p', { class: 'muted' }, 'No cars yet.'),
      routeInfo));
  main.append(h('div', { class: 'map-page' }, side, mapEl));

  let maplibregl;
  try { maplibregl = await loadMapLibre(); } catch (e) { mapEl.append(h('p', { class: 'error', style: 'padding:1rem' }, e.message)); return; }
  const map = new maplibregl.Map({ container: mapEl, style: state.me.settings.mapStyleUrl, center: [-95, 39], zoom: 3 });
  map.addControl(new maplibregl.NavigationControl(), 'top-right');
  state.cleanup.push(() => map.remove());
  const markers = new Map();
  let fitted = false;

  async function refresh() {
    const { data } = await api('GET', '/api/live');
    list.replaceChildren();
    const bounds = new maplibregl.LngLatBounds();
    for (const car of data) {
      const p = car.position;
      const recording = car.cameras.some((c) => c.recording && Date.now() - (c.lastSeenAt || 0) < 120000);
      list.append(h('div', { class: 'card' },
        h('div', { class: 'row' }, h('strong', { class: 'grow' }, car.name),
          p?.live ? h('span', { class: 'badge ok' }, 'Live') : h('span', { class: 'badge' }, 'Last seen'),
          recording ? h('span', { class: 'badge red' }, 'REC') : null),
        p ? h('div', { class: 'small' }, p.live ? `${fmtSpeed(p.speed)} · updated ${ago(p.t)}` : `Last seen ${ago(p.t)}`) : h('div', { class: 'muted small' }, 'No location yet'),
        p?.mismatch ? h('div', { class: 'small', style: 'color:var(--warn)' }, `⚠ Cameras disagree by ${fmtShortDist(p.mismatch.distance)}`) : null));
      if (!p) continue;
      // MapLibre positions the marker's outer element with its own classes, so only the inner label is restyled.
      let m = markers.get(car.id);
      if (!m) {
        const wrapper = h('div', {}, h('div', { class: 'car-marker' }));
        m = new maplibregl.Marker({ element: wrapper }).setLngLat([p.lon, p.lat]).addTo(map);
        markers.set(car.id, m);
      } else m.setLngLat([p.lon, p.lat]);
      const label = m.getElement().firstChild;
      label.textContent = p.live ? `${car.name} · ${fmtSpeed(p.speed)}` : car.name;
      label.className = `car-marker${p.live ? '' : ' stale'}${p.mismatch ? ' warn' : ''}`;
      bounds.extend([p.lon, p.lat]);
    }
    if (!fitted && !bounds.isEmpty() && !params.get('from')) {
      fitted = true;
      map.fitBounds(bounds, { padding: 80, maxZoom: 14, duration: 0 });
    }
  }

  async function showRoute(from, to) {
    const carId = carSel.value;
    if (!carId) return;
    if (!from) {
      const d = new Date(dateIn.value + 'T00:00:00');
      from = d.getTime();
      to = from + 86400000;
    }
    const { data } = await api('GET', `/api/cars/${carId}/route?from=${from}&to=${to}`);
    const coords = data.map((p) => [p.lon, p.lat]);
    const geo = { type: 'FeatureCollection', features: coords.length > 1 ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }] : [] };
    if (map.getSource('route')) map.getSource('route').setData(geo);
    else {
      map.addSource('route', { type: 'geojson', data: geo });
      map.addLayer({ id: 'route', type: 'line', source: 'route', paint: { 'line-color': '#ff5a36', 'line-width': 4 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
    }
    if (coords.length > 1) {
      const b = coords.reduce((acc, c) => acc.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
      map.fitBounds(b, { padding: 60, duration: 500 });
      const maxSpeed = Math.max(...data.map((p) => p.speed || 0));
      routeInfo.textContent = `${data.length} points · top speed ${fmtSpeed(maxSpeed)}`;
    } else routeInfo.textContent = 'No GPS data for that day.';
  }

  map.on('load', () => {
    refresh();
    if (params.get('from')) showRoute(Number(params.get('from')) - 5000, Number(params.get('to')) + 5000);
  });
  const timer = setInterval(() => refresh().catch(() => {}), 5000);
  state.cleanup.push(() => clearInterval(timer));
}

// ---------------------------------------------------------------- trips

async function pageTrips(main, _id, params) {
  await loadCars();
  const carSel = h('select', { onchange: () => { location.hash = `#/trips?car=${carSel.value}`; } },
    h('option', { value: '' }, 'All cars'), state.cars.map((c) => h('option', { value: c.id, selected: String(c.id) === params.get('car') }, c.name)));
  const q = params.get('car') ? `?car=${params.get('car')}` : '';
  const { data } = await api('GET', `/api/trips${q}`);
  main.append(h('h1', {}, 'Trips'),
    h('p', { class: 'muted' }, 'Trips are built automatically from GPS tracks: a new trip starts after 5 minutes without movement data.'),
    h('div', { class: 'toolbar' }, carSel),
    data.length ? h('div', { class: 'card', style: 'padding:0;overflow-x:auto' }, h('table', {},
      h('tr', {}, ['Trip', 'Car', 'Start', 'Duration', 'Distance', 'Average', 'Top speed'].map((x) => h('th', {}, x))),
      data.map((t) => h('tr', { style: 'cursor:pointer', onclick: () => (location.hash = `#/trip/${t.id}`) },
        h('td', {}, t.displayName || `Trip at ${fmtTime(t.startT)}`), h('td', {}, t.carName), h('td', {}, fmtDateTime(t.startT)),
        h('td', {}, fmtDur(t.endT - t.startT)), h('td', {}, fmtDist(t.distanceM)), h('td', {}, fmtSpeed(t.avgSpeed)), h('td', {}, fmtSpeed(t.maxSpeed))))))
      : h('p', { class: 'muted' }, 'No trips yet. Turn on GPS logging in the app; trips appear once clips with GPS tracks upload.'));
}

async function pageTrip(main, id) {
  await loadCars();
  const { data: t } = await api('GET', `/api/trips/${id}`);
  const car = state.cars.find((c) => c.id === t.carId);
  const canManage = car && car.role !== 'viewer';
  const autoLabel = t.autoName || `Trip at ${fmtTime(t.startT)}`;
  const nameIn = h('input', { type: 'text', value: t.name || '', placeholder: autoLabel, style: 'min-width:260px' });
  const mapEl = h('div', { class: 'map', style: 'height:50vh' });
  const grid = h('div', { class: 'grid' }, t.clips.map((c) => clipTile(c)));

  // Split: pick a moment along the route.
  const route = t.route;
  const splitRange = h('input', { type: 'range', min: '1', max: String(Math.max(1, route.length - 2)), value: String(Math.floor(route.length / 2)), style: 'flex:1' });
  const splitLabel = h('span', { class: 'small muted' });
  let splitMarker = null;
  const splitPoint = () => route[Number(splitRange.value)];
  const updateSplit = () => {
    const p = splitPoint();
    if (!p) return;
    splitLabel.textContent = `${fmtTime(p.t)} · ${fmtSpeed(p.speed)}`;
    splitMarker?.setLngLat([p.lon, p.lat]);
  };
  splitRange.oninput = updateSplit;
  const splitBox = h('div', { class: 'card stack', style: 'display:none;margin-top:1rem' },
    h('h3', {}, 'Split this trip'),
    h('p', { class: 'muted small' }, 'Drag to the moment the second trip should start (the white dot on the map).'),
    h('div', { class: 'row' }, splitRange, splitLabel),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: async () => {
        const r = await api('POST', `/api/trips/${id}/split`, { t: splitPoint().t });
        toast('Trip split in two.');
        location.hash = `#/trip/${r.data[0].id}`;
      } }, 'Split here'),
      h('button', { class: 'btn', onclick: () => { splitBox.style.display = 'none'; splitMarker?.remove(); splitMarker = null; } }, 'Cancel')));

  const merge = async (dir) => {
    try {
      const r = await api('POST', `/api/trips/${id}/merge`, { with: dir });
      toast('Trips merged.');
      location.hash = `#/trip/${r.data[0].id}`;
    } catch (e) { toast(e.message); }
  };

  main.append(h('a', { href: '#/trips' }, '‹ Trips'),
    h('h1', { style: 'margin-top:.5rem' }, t.name || autoLabel),
    h('p', { class: 'muted' }, `${t.carName} · ${fmtDateTime(t.startT)} · ${fmtDur(t.endT - t.startT)} · ${fmtDist(t.distanceM)} · average ${fmtSpeed(t.avgSpeed)} · top ${fmtSpeed(t.maxSpeed)}`),
    h('div', { class: 'row', style: 'margin-bottom:1rem' },
      h('a', { class: 'btn primary', href: `#/sync?car=${t.carId}&from=${t.startT}&to=${t.endT}` }, '▶ Watch with all cameras'),
      canManage ? [
        nameIn,
        h('button', { class: 'btn', onclick: async () => { await api('PATCH', `/api/trips/${id}`, { name: nameIn.value }); toast(nameIn.value ? 'Renamed.' : 'Using the automatic name.'); } }, 'Rename'),
        route.length > 3 ? h('button', { class: 'btn', onclick: () => {
          splitBox.style.display = '';
          if (window.maplibregl && map && !splitMarker) {
            splitMarker = new window.maplibregl.Marker({ color: '#ffffff' }).setLngLat([splitPoint().lon, splitPoint().lat]).addTo(map);
          }
          updateSplit();
        } }, 'Split…') : null,
        h('button', { class: 'btn', onclick: () => merge('prev') }, 'Merge with previous'),
        h('button', { class: 'btn', onclick: () => merge('next') }, 'Merge with next'),
      ] : null),
    t.startPlace || t.endPlace ? h('p', { class: 'small muted' }, `From ${t.startPlace || 'unknown'} to ${t.endPlace || 'unknown'}`) : null,
    mapEl, splitBox,
    h('h2', { style: 'margin-top:1.5rem' }, `Clips (${t.clips.length})`),
    t.clips.length ? grid : h('p', { class: 'muted' }, 'No clips from this trip have been uploaded.'));

  let map = null;
  let maplibregl;
  try { maplibregl = await loadMapLibre(); } catch (e) { mapEl.append(h('p', { class: 'error', style: 'padding:1rem' }, e.message)); return; }
  const coords = route.map((p) => [p.lon, p.lat]);
  map = new maplibregl.Map({ container: mapEl, style: state.me.settings.mapStyleUrl, bounds: coords.length > 1 ? coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0])) : undefined, fitBoundsOptions: { padding: 40 } });
  state.cleanup.push(() => map.remove());
  map.on('load', () => {
    map.addSource('route', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} } });
    map.addLayer({ id: 'route', type: 'line', source: 'route', paint: { 'line-color': '#ff5a36', 'line-width': 4 } });
    if (coords.length) {
      new maplibregl.Marker({ color: '#3dbb6c' }).setLngLat(coords[0]).addTo(map);
      new maplibregl.Marker({ color: '#e5484d' }).setLngLat(coords[coords.length - 1]).addTo(map);
    }
  });
}

// ---------------------------------------------------------------- synced multi-camera playback

/**
 * Plays every camera of a car together on one clock. The page keeps a master time; each camera shows
 * whichever of its clips covers that moment and is nudged back into sync if it drifts. Gaps between
 * clips show "No footage". The clock pauses while a camera is still loading.
 */
async function pageSync(main, _id, params) {
  await loadCars();
  const carId = Number(params.get('car'));
  const from = Number(params.get('from'));
  const to = Number(params.get('to')) || from + 20 * 60000;
  const { data } = await api('GET', `/api/cars/${carId}/sync?from=${from}&to=${to}`);
  const car = state.cars.find((c) => c.id === carId);
  const probe = document.createElement('video');
  const canHevc = !!(probe.canPlayType('video/mp4; codecs="hvc1"') || probe.canPlayType('video/mp4; codecs="hev1.1.6.L93.B0"'));
  const needsCopy = (c) => c.codec === 'hevc' && !canHevc;
  const ready = new Set(); // clip ids whose H.264 copy is ready
  const S = { t: Number(params.get('t')) || from, playing: false, rate: 1 };

  const camsWithClips = data.cameras.filter((cam) => data.clips.some((c) => c.cameraId === cam.id));
  if (!camsWithClips.length) {
    main.append(h('a', { href: '#/timeline' }, '‹ Timeline'), h('h1', {}, 'No footage'), h('p', { class: 'muted' }, 'No clips were uploaded for this time.'));
    return;
  }

  const panels = camsWithClips.map((cam) => {
    const video = h('video', { playsinline: true, muted: true, preload: 'auto' });
    const overlay = h('div', { class: 'overlay' });
    const el = h('div', { class: 'sync-panel' }, video, overlay, h('div', { class: 'label' }, cam.label));
    const clips = data.clips.filter((c) => c.cameraId === cam.id).sort((a, b) => a.startedAt - b.startedAt);
    return { cam, video, overlay, el, clips, clipId: null, waitingSince: 0 };
  });
  // Sound comes from the first camera only (others are muted to avoid echo).
  const audioPanel = panels[0];

  const clipAt = (p, t) => p.clips.find((c) => t >= c.startedAt && t < c.startedAt + (c.durationMs || 180000));
  const srcFor = (c) => (needsCopy(c) ? `/api/clips/${c.id}/stream?codec=h264` : `/api/clips/${c.id}/stream`);

  // Controls
  const playBtn = h('button', { class: 'btn primary', style: 'min-width:90px' }, '▶ Play');
  const scrub = h('input', { type: 'range', min: String(from), max: String(to), step: '500', value: String(S.t) });
  const clock = h('span', { class: 'small', style: 'min-width:150px' });
  const rateSel = h('select', {}, [1, 2, 4, 8].map((r) => h('option', { value: r }, `${r}×`)));
  const status = h('div', { class: 'small muted' });
  const speedBig = h('div', { class: 'speed-big' });
  const placeLine = h('div', { class: 'small muted' });
  const mapEl = h('div', { class: 'map', style: 'height:260px' });
  const coverage = h('div', { class: 'stack', style: 'margin-top:.5rem' }, panels.map((p) => h('div', { class: 'coverage-row' },
    h('span', {}, p.cam.label),
    h('div', { class: 'coverage' }, p.clips.map((c) => {
      const a = Math.max(0, (c.startedAt - from) / (to - from));
      const b = Math.min(1, (c.startedAt + (c.durationMs || 180000) - from) / (to - from));
      return h('span', { style: `left:${a * 100}%;width:${Math.max(0.3, (b - a) * 100)}%` });
    })))));

  main.append(
    h('a', { href: '#/timeline' }, '‹ Timeline'),
    h('h1', { style: 'margin-top:.5rem' }, `${car?.name || 'Car'} · all cameras`),
    h('div', { class: 'sync-grid' }, panels.map((p) => p.el)),
    h('div', { class: 'sync-controls' }, playBtn, clock, scrub, rateSel),
    coverage,
    h('div', { class: 'sync-bottom' },
      h('div', { class: 'stack' }, status, h('p', { class: 'small muted' }, 'Tip: space bar plays and pauses. Cameras stay in sync to within about a second, depending on how closely the phones’ clocks agree.')),
      h('div', { class: 'stack' }, speedBig, placeLine, mapEl)));

  // Prepare H.264 copies where this browser can't play H.265.
  const copies = data.clips.filter(needsCopy);
  async function checkCopies() {
    for (const c of copies) {
      if (ready.has(c.id)) continue;
      const r = await fetch(`/api/clips/${c.id}/stream?codec=h264`, { headers: { Range: 'bytes=0-0' } }).catch(() => null);
      if (r && r.status !== 202 && r.ok) ready.add(c.id);
    }
    const pending = copies.length - ready.size;
    status.textContent = pending ? `This browser can’t play H.265. Preparing compatible copies: ${ready.size} of ${copies.length} ready…` : '';
    if (pending && alive) setTimeout(checkCopies, 3000);
  }
  let alive = true;
  state.cleanup.push(() => { alive = false; panels.forEach((p) => { p.video.pause(); p.video.removeAttribute('src'); p.video.load(); }); });
  if (copies.length) checkCopies();

  // Route position at time t (linear interpolation between GPS points).
  const route = data.route;
  function posAt(t) {
    if (!route.length) return null;
    let lo = 0, hi = route.length - 1;
    if (t <= route[0].t) return route[0];
    if (t >= route[hi].t) return route[hi];
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (route[m].t <= t) lo = m; else hi = m; }
    const a = route[lo], b = route[hi], f = (t - a.t) / Math.max(1, b.t - a.t);
    return { t, lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f, speed: a.speed };
  }

  let lastSync = 0;
  function syncVideos(force) {
    const now = performance.now();
    if (!force && now - lastSync < 250) return;
    lastSync = now;
    for (const p of panels) {
      const c = clipAt(p, S.t);
      if (!c) {
        p.overlay.textContent = 'No footage at this moment';
        p.video.style.visibility = 'hidden';
        if (!p.video.paused) p.video.pause();
        p.clipId = null;
        continue;
      }
      if (needsCopy(c) && !ready.has(c.id)) {
        p.overlay.textContent = 'Preparing a compatible copy…';
        p.video.style.visibility = 'hidden';
        p.clipId = null;
        continue;
      }
      if (p.clipId !== c.id) {
        p.clipId = c.id;
        p.video.src = srcFor(c);
        p.video.muted = p !== audioPanel;
      }
      p.video.style.visibility = 'visible';
      p.overlay.textContent = p.video.readyState < 2 ? 'Loading…' : '';
      const want = (S.t - c.startedAt) / 1000;
      if (p.video.readyState >= 1 && Math.abs(p.video.currentTime - want) > 0.25 * S.rate + 0.1) p.video.currentTime = want;
      p.video.playbackRate = S.rate;
      if (S.playing && p.video.paused && p.video.readyState >= 2) p.video.play().catch(() => {});
      if (!S.playing && !p.video.paused) p.video.pause();
    }
  }

  // A camera still loading holds the clock (up to 5 s, so one broken clip can't freeze playback).
  function anyLoading() {
    const now = performance.now();
    return panels.some((p) => {
      if (!p.clipId || p.video.readyState >= 3) { p.waitingSince = 0; return false; }
      if (!p.waitingSince) p.waitingSince = now;
      return now - p.waitingSince < 5000;
    });
  }

  let marker = null;
  function renderUi() {
    clock.textContent = new Date(S.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    if (document.activeElement !== scrub) scrub.value = String(S.t);
    const p = posAt(S.t);
    speedBig.textContent = p?.speed != null ? fmtSpeed(p.speed) : '';
    placeLine.textContent = p ? `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}` : 'No GPS data for this time';
    if (p && marker) marker.setLngLat([p.lon, p.lat]);
  }

  let last = performance.now();
  function frame(now) {
    if (!alive) return;
    const dt = now - last;
    last = now;
    if (S.playing && !anyLoading()) {
      S.t += dt * S.rate;
      if (S.t >= to) { S.t = to; setPlaying(false); }
    }
    syncVideos(false);
    renderUi();
    requestAnimationFrame(frame);
  }
  function setPlaying(on) {
    S.playing = on;
    playBtn.textContent = on ? '❚❚ Pause' : '▶ Play';
    syncVideos(true);
  }
  playBtn.onclick = () => setPlaying(!S.playing);
  scrub.oninput = () => { S.t = Number(scrub.value); syncVideos(true); renderUi(); };
  rateSel.onchange = () => { S.rate = Number(rateSel.value); syncVideos(true); };
  const onKey = (e) => { if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); setPlaying(!S.playing); } };
  document.addEventListener('keydown', onKey);
  state.cleanup.push(() => document.removeEventListener('keydown', onKey));
  requestAnimationFrame(frame);

  // Map with the route and a moving marker.
  try {
    const maplibregl = await loadMapLibre();
    if (!alive || !route.length) return;
    const coords = route.map((p) => [p.lon, p.lat]);
    const map = new maplibregl.Map({ container: mapEl, style: state.me.settings.mapStyleUrl, bounds: coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0])), fitBoundsOptions: { padding: 30 } });
    state.cleanup.push(() => map.remove());
    map.on('load', () => {
      map.addSource('route', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} } });
      map.addLayer({ id: 'route', type: 'line', source: 'route', paint: { 'line-color': '#ff5a36', 'line-width': 4 } });
      marker = new maplibregl.Marker({ element: h('div', {}, h('div', { class: 'car-marker' }, car?.name || 'Car')) }).setLngLat(coords[0]).addTo(map);
    });
  } catch (e) {
    mapEl.replaceChildren(h('p', { class: 'error small', style: 'padding:1rem' }, e.message));
  }
}

// ---------------------------------------------------------------- cars

async function pageCars(main) {
  await loadCars();
  const name = h('input', { type: 'text', placeholder: 'New car name' });
  main.append(h('h1', {}, 'Cars'),
    h('div', { class: 'toolbar' }, name, h('button', { class: 'btn primary', onclick: async () => {
      try { await api('POST', '/api/cars', { name: name.value }); render(); } catch (e) { toast(e.message); }
    } }, 'Add car')));
  if (!state.cars.length) main.append(h('p', { class: 'muted' }, 'Add a car, then connect phones to it.'));
  for (const car of state.cars) main.append(carCard(car));
}

function carCard(car) {
  const manage = car.role !== 'viewer';
  const owner = car.role === 'owner';
  const card = h('div', { class: 'card stack', style: 'margin-bottom:1rem' });
  card.append(h('div', { class: 'row' },
    h('h2', { class: 'grow', style: 'margin:0' }, car.name),
    h('span', { class: 'badge' }, owner ? 'Owner' : car.role === 'manager' ? `Shared by ${car.owner} · can manage` : `Shared by ${car.owner} · view only`),
    manage ? h('button', { class: 'btn small', onclick: async () => {
      const n = prompt('Rename car', car.name);
      if (n) { await api('PATCH', `/api/cars/${car.id}`, { name: n }); render(); }
    } }, 'Rename') : null,
    owner ? h('button', { class: 'btn small danger', onclick: async () => {
      const typed = prompt(`This deletes "${car.name}" and ALL of its footage on the server. Type the car name to confirm.`);
      if (typed !== car.name) return;
      await api('DELETE', `/api/cars/${car.id}?confirm=delete-footage`);
      render();
    } }, 'Delete') : null));
  card.append(h('div', { class: 'muted small' }, `${car.clipCount} clips · ${fmtBytes(car.clipBytes)} · last clip ${ago(car.lastClipAt)}`));

  // Cameras
  card.append(h('h3', {}, 'Cameras'));
  if (!car.cameras.length) card.append(h('p', { class: 'muted small' }, 'No phones connected yet.'));
  else card.append(h('div', { style: 'overflow-x:auto' }, h('table', {},
    h('tr', {}, ['Camera', 'Phone', 'App version', 'Last seen', 'Status', ''].map((x) => h('th', {}, x))),
    car.cameras.map((c) => h('tr', {},
      h('td', {}, c.label), h('td', {}, c.deviceModel || ''), h('td', { class: 'small' }, c.appVersion || ''),
      h('td', {}, ago(c.lastSeenAt)),
      h('td', { class: 'small' }, [c.recording ? 'Recording' : 'Idle', c.mode, c.battery != null ? `${c.battery}%${c.charging ? ' ⚡' : ''}` : null,
        c.storageFree != null ? `${fmtBytes(c.storageFree)} free` : null].filter(Boolean).join(' · ')),
      h('td', {}, manage ? h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: async () => { const l = prompt('Camera name', c.label); if (l) { await api('PATCH', `/api/cameras/${c.id}`, { label: l }); render(); } } }, 'Rename'),
        h('button', { class: 'btn small danger', onclick: async () => {
          if (!confirm(`Disconnect "${c.label}"? The phone stops uploading. Its footage stays on the server.`)) return;
          await api('DELETE', `/api/cameras/${c.id}`); render();
        } }, 'Disconnect')) : null))))));
  if (manage) {
    card.append(h('button', { class: 'btn primary', onclick: async () => {
      const label = prompt('Name this camera (e.g. Front, Rear, Cabin)', car.cameras.length ? 'Rear' : 'Front');
      if (!label) return;
      const box = h('div', { class: 'stack' }, h('h2', {}, `Connect a phone to ${car.name}`),
        h('p', { class: 'muted' }, 'In ODC on the phone: Settings → ODC Server → Pair with server, then scan this code.'));
      const close = modal(box, true);
      try { box.append(await pairingPanel(car.id, label)); } catch (e) { box.append(h('p', { class: 'error' }, e.message)); }
      box.append(h('button', { class: 'btn', onclick: () => { close(); render(); } }, 'Done'));
    } }, 'Connect a phone'));
  }

  // Mismatch policy
  if (manage && car.cameras.length > 1) {
    const pol = h('select', {}, [['alert', 'Alert me and let me fix it'], ['source', 'Use one camera as the source of truth'], ['average', 'Average the cameras']]
      .map(([v, l]) => h('option', { value: v, selected: car.mismatchPolicy === v }, l)));
    const truth = h('select', {}, car.cameras.map((c) => h('option', { value: c.id, selected: car.truthCameraId === c.id }, c.label)));
    const save = async () => {
      await api('PATCH', `/api/cars/${car.id}`, { mismatchPolicy: pol.value, truthCameraId: pol.value === 'source' ? truth.value : null });
      toast('Saved.');
    };
    truth.style.display = pol.value === 'source' ? '' : 'none';
    pol.onchange = () => { truth.style.display = pol.value === 'source' ? '' : 'none'; save(); };
    truth.onchange = save;
    card.append(h('h3', {}, 'When cameras disagree on location or speed'), h('div', { class: 'row' }, pol, truth));
  }

  // Footage kept for this car
  if (manage) {
    const mode = h('select', {}, [['default', 'Server default'], ['forever', 'Keep forever'], ['days', 'Delete unlocked clips after…']]
      .map(([v, l]) => h('option', { value: v, selected: (car.retentionDays == null ? 'default' : car.retentionDays === 0 ? 'forever' : 'days') === v }, l)));
    const days = h('input', { type: 'number', min: '1', value: car.retentionDays > 0 ? car.retentionDays : 30, style: 'width:90px' });
    const daysLabel = h('span', { class: 'small muted' }, 'days');
    const cap = h('input', { type: 'number', min: '0', step: '1', value: car.storageCapGb ?? '', placeholder: 'No limit', style: 'width:110px' });
    const sync = () => { days.style.display = daysLabel.style.display = mode.value === 'days' ? '' : 'none'; };
    mode.onchange = sync;
    sync();
    card.append(h('h3', {}, 'Footage kept for this car'),
      h('div', { class: 'row' }, mode, days, daysLabel),
      h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Size limit (GB)'), cap,
        h('button', { class: 'btn small', onclick: async () => {
          await api('PATCH', `/api/cars/${car.id}`, {
            retentionDays: mode.value === 'default' ? null : mode.value === 'forever' ? 0 : Number(days.value),
            storageCapGb: cap.value === '' ? null : Number(cap.value),
          });
          toast('Saved. Locked clips are always kept.');
          render();
        } }, 'Save')),
      h('p', { class: 'muted small' }, 'When a limit is reached, the oldest unlocked clips of this car are removed. Locked clips are always kept.'));
  }

  // Learned places (commute learning)
  const placesBox = h('div');
  card.append(placesBox);
  api('GET', `/api/cars/${car.id}/places`).then(({ data: places }) => {
    if (!places.length) return;
    placesBox.append(h('h3', {}, 'Learned places'),
      h('p', { class: 'muted small' }, 'Places this car visits often, learned on this server. Rename them to change how trips are named.'),
      h('div', { class: 'stack' }, places.map((p) => h('div', { class: 'row' },
        h('span', { class: 'grow' }, p.label || 'Unnamed place', ' ', h('span', { class: 'badge' }, p.kind === 'home' ? 'Home' : p.kind === 'work' ? 'Work' : `${p.visits} visits`)),
        manage ? h('button', { class: 'btn small', onclick: async () => {
          const l = prompt('Name this place (leave empty for the automatic name)', p.label || '');
          if (l === null) return;
          await api('PATCH', `/api/places/${p.id}`, { label: l });
          render();
        } }, 'Rename') : null))));
  }).catch(() => {});

  // Sharing
  if (owner) {
    const user = h('input', { type: 'text', placeholder: 'Username' });
    const role = h('select', {}, h('option', { value: 'viewer' }, 'Can view'), h('option', { value: 'manager' }, 'Can manage'));
    card.append(h('h3', {}, 'Sharing'),
      car.shares.length ? h('div', { class: 'stack' }, car.shares.map((s) => h('div', { class: 'row' },
        h('span', { class: 'grow' }, `${s.username} · ${s.role === 'manager' ? 'can manage' : 'can view'}`),
        h('button', { class: 'btn small', onclick: async () => { await api('DELETE', `/api/cars/${car.id}/shares/${s.userId}`); render(); } }, 'Remove'))))
        : h('p', { class: 'muted small' }, 'Only you can see this car.'),
      h('div', { class: 'row' }, user, role, h('button', { class: 'btn', onclick: async () => {
        try { await api('POST', `/api/cars/${car.id}/shares`, { username: user.value, role: role.value }); render(); } catch (e) { toast(e.message); }
      } }, 'Share')));
  }
  return card;
}

// ---------------------------------------------------------------- events

async function pageEvents(main) {
  const { data } = await api('GET', '/api/events');
  const labels = { impact: '⚠ Impact', mismatch: '⇄ Cameras disagree', offline: '⏻ Went offline', overheating: '🌡 Overheating', battery_cutoff: '🔋 Battery cutoff', recording_stopped: '■ Recording stopped' };
  const detail = (e) => e.type === 'mismatch' && e.data ? `${fmtShortDist(e.data.distance)} apart, ${fmtSpeed(e.data.speedDiffKmh / 3.6)} speed difference` : '';
  main.append(h('h1', {}, 'Events'),
    data.length ? h('div', { class: 'card', style: 'padding:0;overflow-x:auto' }, h('table', {},
      h('tr', {}, ['Event', 'Car', 'Camera', 'When', 'Details'].map((x) => h('th', {}, x))),
      data.map((e) => h('tr', {}, h('td', {}, labels[e.type] || e.type), h('td', {}, e.carName), h('td', {}, e.camera || ''),
        h('td', {}, fmtDateTime(e.t)), h('td', { class: 'small muted' }, detail(e))))))
      : h('p', { class: 'muted' }, 'No events. Impacts, overheating, cameras going offline and location disagreements show up here.'));
}

// ---------------------------------------------------------------- settings

async function serverSettingsForm(onSaved) {
  const { data: s } = await api('GET', '/api/settings');
  const f = {};
  const field = (key, label, type = 'text', hint) => {
    const input = h('input', { type, value: s[key] ?? '' });
    if (type === 'checkbox') { input.checked = !!s[key]; input.removeAttribute('value'); }
    f[key] = input;
    return h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('div', { class: 'muted small' }, hint) : null);
  };
  const units = h('select', {}, [['auto', `Automatic (currently ${isImperial('auto') ? 'mph / feet' : 'km/h / meters'})`], ['mph', 'mph / miles / feet'], ['kmh', 'km/h / km / meters']].map(([v, l]) => h('option', { value: v, selected: s.units === v }, l)));
  f.units = units;
  // Stored in meters and km/h; shown in feet and mph when imperial units are selected.
  const M_PER_FT = 0.3048;
  const KMH_PER_MPH = 1.609344;
  const distIn = h('input', { type: 'number', min: '1' });
  const speedIn = h('input', { type: 'number', min: '1' });
  const distLabel = h('span');
  const speedLabel = h('span');
  const distField = h('label', { class: 'field' }, distLabel, distIn);
  const speedField = h('label', { class: 'field' }, speedLabel, speedIn);
  let shownImperial = null;
  const metric = { dist: s.mismatchDistanceM, speed: s.mismatchSpeedKmh };
  const shown = { dist: null, speed: null };
  function readMismatch() {
    // Only convert values the user changed, so untouched settings don't drift from rounding.
    if (Number(distIn.value) !== shown.dist) metric.dist = shownImperial ? Number(distIn.value) * M_PER_FT : Number(distIn.value);
    if (Number(speedIn.value) !== shown.speed) metric.speed = shownImperial ? Number(speedIn.value) * KMH_PER_MPH : Number(speedIn.value);
  }
  function showMismatch() {
    if (shownImperial !== null) readMismatch();
    shownImperial = isImperial(units.value);
    shown.dist = shownImperial ? Math.round(metric.dist / M_PER_FT) : Math.round(metric.dist);
    shown.speed = shownImperial ? Math.round(metric.speed / KMH_PER_MPH) : Math.round(metric.speed);
    distIn.value = shown.dist;
    speedIn.value = shown.speed;
    distLabel.textContent = shownImperial ? 'Position difference (feet)' : 'Position difference (meters)';
    speedLabel.textContent = shownImperial ? 'Speed difference (mph)' : 'Speed difference (km/h)';
  }
  units.addEventListener('change', showMismatch);
  showMismatch();

  const smartStatus = h('div', { class: 'stack' });

  // Analyze existing footage (smart search and/or plates), with a scope.
  const anScope = h('select', {}, [['all', 'All footage'], ['range', 'A date range'], ['car', 'One car']].map(([v, l]) => h('option', { value: v }, l)));
  const anFrom = h('input', { type: 'date' });
  const anTo = h('input', { type: 'date' });
  const anCar = h('select', {}, (state.cars.length ? state.cars : (await api('GET', '/api/cars')).data).map((c) => h('option', { value: c.id }, c.name)));
  const anSmart = h('input', { type: 'checkbox', checked: true });
  const anPlates = h('input', { type: 'checkbox', checked: true });
  const anRedo = h('input', { type: 'checkbox' });
  const anResult = h('div', { class: 'small' });
  const anRange = h('div', { class: 'row', style: 'display:none' }, h('span', { class: 'small muted' }, 'From'), anFrom, h('span', { class: 'small muted' }, 'to'), anTo);
  const anCarRow = h('div', { class: 'row', style: 'display:none' }, anCar);
  anScope.onchange = () => {
    anRange.style.display = anScope.value === 'range' ? '' : 'none';
    anCarRow.style.display = anScope.value === 'car' ? '' : 'none';
  };
  const analyzeBox = h('div', { class: 'card stack', style: 'background:var(--panel2)' },
    h('h3', {}, 'Analyze footage'),
    h('p', { class: 'muted small' }, 'Footage already on the server is analyzed automatically in the background once a feature is turned on, newest first. Use this to analyze a specific period or car first, to retry, or to analyze clips again (for example after changing settings).'),
    h('div', { class: 'row' }, anScope), anRange, anCarRow,
    h('label', { class: 'row small' }, anSmart, 'Smart search'),
    h('label', { class: 'row small' }, anPlates, 'License plates'),
    h('label', { class: 'row small' }, anRedo, 'Also redo clips that were already analyzed'),
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => {
      const body = { smart: anSmart.checked, plates: anPlates.checked, redo: anRedo.checked };
      if (anScope.value === 'range') {
        if (anFrom.value) body.from = new Date(anFrom.value + 'T00:00:00').getTime();
        if (anTo.value) body.to = new Date(anTo.value + 'T23:59:59').getTime();
      }
      if (anScope.value === 'car') body.car = Number(anCar.value);
      try {
        const { data } = await api('POST', '/api/search/analyze', body);
        const parts = [];
        if (data.smart) parts.push(`Smart search: ${data.smart.queued} clips waiting`);
        if (data.plates) parts.push(`Plates: ${data.plates.queued} clips waiting` +
          (data.plates.skippedOlderThanRetention ? ` (${data.plates.skippedOlderThanRetention} older than your plate retention period are skipped; set retention to 0 to include them)` : ''));
        anResult.textContent = parts.length ? parts.join(' · ') + '. Progress shows above and on the Search page.' : 'Turn on smart search or license plates first, and save.';
        refreshSmart();
      } catch (e) { anResult.textContent = e.message; }
    } }, 'Analyze')), anResult);
  const plateBox = h('input', { type: 'checkbox' });
  plateBox.checked = !!s.plateSearch;
  const PLATE_NOTICE = (what) => `Before you turn on ${what}\n\n` +
    'Laws on reading, storing and logging license plates differ between countries, states and cities: it is ' +
    'legal in some places, a grey area in others and illegal in others. You alone are responsible for knowing and ' +
    'following the laws where you drive and where this server runs. The Open Dash Cam project and its contributors ' +
    'accept no responsibility for how this feature is used.\n\nTurn it on?';
  plateBox.onchange = () => {
    if (plateBox.checked && !s.plateSearch && !confirm(PLATE_NOTICE('license plate reading'))) plateBox.checked = false;
    if (!plateBox.checked) plateLogBox.checked = false;
    plateLogBox.disabled = !plateBox.checked;
  };
  f.plateSearch = plateBox;
  const plateToggle = h('label', { class: 'row' }, plateBox, 'Read license plates and search by plate');
  const plateLogBox = h('input', { type: 'checkbox' });
  plateLogBox.checked = !!s.plateLog;
  plateLogBox.disabled = !s.plateSearch;
  plateLogBox.onchange = () => {
    if (plateLogBox.checked && !s.plateLog && !confirm(PLATE_NOTICE('the plate log'))) plateLogBox.checked = false;
  };
  f.plateLog = plateLogBox;
  const plateLogToggle = h('label', { class: 'row' }, plateLogBox, 'Plate log');
  const refreshSmart = async () => {
    try {
      const { data: st } = await api('GET', '/api/search/status');
      const line = !st.enabled ? 'Off.'
        : !st.ml?.ready ? `Not available: ${st.ml?.error || 'model loading'}`
          : `Ready (${st.ml.model}). ${st.indexed} of ${st.searchable} clips analyzed${st.failed ? `, ${st.failed} couldn’t be read` : ''}.`;
      smartStatus.replaceChildren(h('div', { class: 'small' }, line),
        st.plateSearch ? h('div', { class: 'small' }, `License plates: read in ${st.platesIndexed} of ${st.platesEligible} clips` +
          (st.plateRetentionDays ? ` from the last ${st.plateRetentionDays} days` : '') + ` · ${st.distinctPlates} plates, ${st.plateReads} readings.`) : null,
        st.enabled ? h('div', { class: 'row' },
          st.failed ? h('button', { class: 'btn small', onclick: async () => { await api('POST', '/api/search/reindex', { failedOnly: true }); refreshSmart(); } }, 'Retry failed clips') : null,
          h('button', { class: 'btn small', onclick: async () => {
            if (!confirm('Analyze all footage again? Search results will be incomplete until it finishes.')) return;
            await api('POST', '/api/search/reindex', { failedOnly: false }); refreshSmart();
          } }, 'Rebuild search index')) : null);
    } catch { /* not admin or offline */ }
  };
  refreshSmart();

  const err = h('p', { class: 'error' });
  const form = h('div', { class: 'stack' },
    h('h2', {}, 'Server settings'),
    field('serverName', 'Server name'),
    h('label', { class: 'field' }, h('span', {}, 'Units'), units),
    h('h3', {}, 'Storage'),
    field('storageCapGb', 'Maximum footage size (GB, 0 = no limit)', 'number', 'When reached, the oldest unlocked clips are removed. You get an alert at 90%.'),
    field('retentionDays', 'Delete unlocked clips older than (days, 0 = keep forever)', 'number'),
    h('label', { class: 'row' }, field('preTranscode', '', 'checkbox').querySelector('input'), 'Prepare H.264 copies right after upload (uses more CPU and space; speeds up playback in browsers without H.265)'),
    h('h3', {}, 'Alerts'),
    field('ntfyUrl', 'ntfy topic URL', 'url', 'e.g. https://ntfy.sh/a-long-random-topic or your own ntfy server. Leave blank for no alerts.'),
    field('ntfyToken', 'ntfy access token (optional)', 'password'),
    h('button', { class: 'btn small', onclick: async () => {
      await save(false);
      try { await api('POST', '/api/settings/test-ntfy'); toast('Test alert sent.'); } catch (e) { toast(e.message); }
    } }, 'Send test alert'),
    field('offlineAlertMin', 'Alert when a recording camera is silent for (minutes)', 'number'),
    h('h3', {}, 'When cameras in one car disagree'),
    distField, speedField,
    field('mismatchSustainSec', 'For at least (seconds)', 'number'),
    h('h3', {}, 'Trips'),
    h('label', { class: 'row' }, field('commuteLearning', '', 'checkbox').querySelector('input'),
      'Learn usual places and commutes (names trips like “Home → Work” and keeps a short stop from splitting a commute)'),
    h('div', { class: 'muted small' }, 'Learning runs only on this server and uses only your own trips. Nothing is sent anywhere.'),
    h('h3', {}, 'Smart search'),
    h('label', { class: 'row' }, field('smartSearch', '', 'checkbox').querySelector('input'),
      'Search footage by what’s in it (“red pickup truck”, “bridge”, “snow”)'),
    h('div', { class: 'muted small' }, 'Needs the optional ML container (see the server README). Footage is analyzed on this server; nothing is sent elsewhere. A frame every few seconds is analyzed, newest clips first.'),
    field('mlUrl', 'ML service address', 'url'),
    field('searchFrameIntervalSec', 'Analyze one frame every (seconds)', 'number', 'Lower finds brief moments more reliably but takes longer. Default 10.'),
    smartStatus,
    h('h3', {}, 'License plates'),
    plateToggle,
    h('div', { class: 'muted small' }, 'Reads license plates in your footage on this server (needs the ML container), so clips can be found by plate.'),
    plateLogToggle,
    h('div', { class: 'muted small' }, 'Adds a Plates page listing every plate read, with sightings, notes and tools to fix misreads and merge duplicates.'),
    field('plateRetentionDays', 'Keep plate readings for (days, 0 = forever)', 'number', 'Footage itself is not affected.'),
    field('plateMinConfidence', 'Ignore readings less certain than (0–1)', 'number', 'Default 0.6. Higher means fewer but more reliable readings.'),
    analyzeBox,
    h('button', { class: 'btn small danger', onclick: async () => {
      if (!confirm('Delete all license plate readings, notes and merges? This can’t be undone.')) return;
      await api('POST', '/api/plates/erase');
      toast('All plate data deleted.');
    } }, 'Delete all plate data'),
    h('h3', {}, 'Map'),
    field('mapStyleUrl', 'Map style URL', 'url', 'Default: OpenFreeMap (free, no key). Any MapLibre style works, including self-hosted tiles.'),
    h('div', { class: 'muted small' }, 'Place names come from GeoNames (geonames.org, CC BY 4.0) and are looked up on this server.'),
    err,
    h('button', { class: 'btn primary', onclick: () => save(true) }, 'Save'));
  async function save(done) {
    const patch = {};
    for (const [k, el] of Object.entries(f)) patch[k] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
    readMismatch();
    patch.mismatchDistanceM = Math.round(metric.dist * 10) / 10;
    patch.mismatchSpeedKmh = Math.round(metric.speed * 10) / 10;
    try {
      Object.assign(s, (await api('PUT', '/api/settings', patch)).data);
      state.me = (await api('GET', '/api/me')).data;
      refreshSmart();
      if (done) { toast('Settings saved.'); onSaved?.(); }
    } catch (e) { err.textContent = e.message; }
  }
  return form;
}

function notificationsCard() {
  const card = h('div', { class: 'card stack', style: 'max-width:640px;margin-top:1rem' }, h('h2', {}, 'Notifications in this browser'));
  const status = h('p', { class: 'small' });
  const buttons = h('div', { class: 'row' });
  card.append(h('p', { class: 'muted small' }, 'Impacts, overheating, cameras going offline and other alerts for your cars, shown by this browser even when ODC isn’t open.'), status, buttons);
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!supported) { status.textContent = 'This browser doesn’t support notifications from websites.'; return card; }
  if (!window.isSecureContext) {
    status.textContent = 'Browsers only allow notifications on secure (https://) addresses. Open ODC through HTTPS (see the server README), or use ntfy alerts in Server settings.';
    return card;
  }
  const b64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
  const refresh = async () => {
    const reg = await navigator.serviceWorker.register('/sw.js');
    const sub = await reg.pushManager.getSubscription();
    buttons.replaceChildren();
    if (Notification.permission === 'denied') {
      status.textContent = 'Notifications are blocked for this site. Allow them in the browser’s site settings, then reload.';
    } else if (sub) {
      status.textContent = 'On for this browser.';
      buttons.append(
        h('button', { class: 'btn', onclick: async () => { try { await api('POST', '/api/push/test'); toast('Test notification sent.'); } catch (e) { toast(e.message); } } }, 'Send a test'),
        h('button', { class: 'btn danger', onclick: async () => {
          await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint });
          await sub.unsubscribe();
          refresh();
        } }, 'Turn off'));
    } else {
      status.textContent = 'Off for this browser.';
      buttons.append(h('button', { class: 'btn primary', onclick: async () => {
        try {
          if ((await Notification.requestPermission()) !== 'granted') return refresh();
          const { data } = await api('GET', '/api/push/key');
          const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(data.publicKey) });
          await api('POST', '/api/push/subscribe', s.toJSON());
          toast('Notifications are on.');
        } catch (e) { toast(`Couldn’t turn on notifications: ${e.message}`); }
        refresh();
      } }, 'Turn on'));
    }
  };
  refresh().catch((e) => { status.textContent = e.message; });
  return card;
}

function showRecoveryCodes(codes) {
  const box = h('div', { class: 'stack' },
    h('h2', {}, 'Save your recovery codes'),
    h('p', { class: 'muted' }, 'If you lose your phone, each of these codes signs you in once instead of an authenticator code. Store them somewhere safe; they won’t be shown again.'),
    h('div', { class: 'codes' }, codes.map((c) => h('span', {}, c))),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: async () => { await navigator.clipboard.writeText(codes.join('\n')); toast('Copied.'); } }, 'Copy'),
      h('button', { class: 'btn primary', onclick: () => { close(); render(); } }, 'I saved them')));
  const close = modal(box, true);
}

async function twoFactorCard() {
  const me = (await api('GET', '/api/me')).data;
  const card = h('div', { class: 'card stack', style: 'max-width:640px;margin-top:1rem' }, h('h2', {}, 'Two-factor sign-in'));
  if (me.totpEnabled) {
    card.append(
      h('p', {}, h('span', { class: 'badge ok' }, 'On'), ' Signing in needs your password and a code from your authenticator app.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: async () => {
          const pw = prompt('Your password, to create new recovery codes (old ones stop working)');
          if (!pw) return;
          try { showRecoveryCodes((await api('POST', '/api/me/totp/recovery', { password: pw })).data.recoveryCodes); } catch (e) { toast(e.message); }
        } }, 'New recovery codes'),
        h('button', { class: 'btn danger', onclick: async () => {
          const pw = prompt('Your password, to turn off two-factor sign-in');
          if (!pw) return;
          try { await api('POST', '/api/me/totp/disable', { password: pw }); toast('Two-factor sign-in is off.'); render(); } catch (e) { toast(e.message); }
        } }, 'Turn off')));
    return card;
  }
  card.append(
    h('p', { class: 'muted' }, 'Adds a 6-digit code from an authenticator app (Aegis, 2FAS, Google Authenticator, 1Password…) to signing in. Recommended if the server is reachable from the internet.'),
    h('button', { class: 'btn', onclick: async () => {
      const { data } = await api('POST', '/api/me/totp/setup');
      const code = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '123456' });
      const err = h('p', { class: 'error' });
      const qrHolder = h('div');
      const box = h('div', { class: 'stack' },
        h('h2', {}, 'Set up two-factor sign-in'),
        h('p', { class: 'muted' }, '1. Scan this with your authenticator app (or enter the key by hand).'),
        qrHolder,
        h('div', { class: 'small', style: 'text-align:center;word-break:break-all' }, h('code', {}, data.secret)),
        h('p', { class: 'muted' }, '2. Enter the 6-digit code the app shows.'),
        code, err,
        h('button', { class: 'btn primary', onclick: async () => {
          try {
            const r = await api('POST', '/api/me/totp/enable', { code: code.value });
            close();
            showRecoveryCodes(r.data.recoveryCodes);
          } catch (e) { err.textContent = e.message; }
        } }, 'Turn on'));
      const close = modal(box, true);
      try {
        await loadScript(QR_JS);
        const qr = window.qrcode(0, 'M');
        qr.addData(data.otpauth);
        qr.make();
        qrHolder.append(h('div', { class: 'qr', html: qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }) }));
      } catch { qrHolder.append(h('p', { class: 'muted small' }, 'QR code unavailable; enter the key below in your app.')); }
    } }, 'Set up two-factor sign-in'));
  return card;
}

async function pageSettings(main) {
  const cur = h('input', { type: 'password', autocomplete: 'current-password' });
  const pw = h('input', { type: 'password', autocomplete: 'new-password' });
  main.append(h('h1', {}, 'Settings'),
    h('div', { class: 'card stack', style: 'max-width:640px' }, h('h2', {}, 'Your account'),
      h('label', { class: 'field' }, h('span', {}, 'Current password'), cur),
      h('label', { class: 'field' }, h('span', {}, 'New password (8+ characters)'), pw),
      h('button', { class: 'btn', onclick: async () => {
        try { await api('PUT', '/api/me/password', { current: cur.value, password: pw.value }); toast('Password changed.'); cur.value = pw.value = ''; } catch (e) { toast(e.message); }
      } }, 'Change password')));

  main.append(await twoFactorCard());
  main.append(notificationsCard());

  const { data: st } = await api('GET', '/api/storage');
  main.append(h('div', { class: 'card stack', style: 'max-width:640px;margin-top:1rem' }, h('h2', {}, 'Storage'),
    h('p', {}, `Footage: ${fmtBytes(st.usedBytes)}${st.capGb ? ` of ${st.capGb} GB limit` : ''}${st.freeBytes != null ? ` · ${fmtBytes(st.freeBytes)} free on disk` : ''}`)));

  if (!state.me.isAdmin) return;
  const serverCard = h('div', { class: 'card', style: 'max-width:640px;margin-top:1rem' }, await serverSettingsForm());
  main.append(serverCard);

  const { data: users } = await api('GET', '/api/users');
  const nu = h('input', { type: 'text', placeholder: 'Username' });
  const np = h('input', { type: 'password', placeholder: 'Password (8+)' });
  const na = h('input', { type: 'checkbox' });
  main.append(h('div', { class: 'card stack', style: 'max-width:640px;margin-top:1rem' }, h('h2', {}, 'People'),
    h('p', { class: 'muted small' }, 'Admins manage accounts and server settings. Footage is only visible to a car’s owner and the people it’s shared with.'),
    h('table', {}, users.map((u) => h('tr', {},
      h('td', {}, u.username, u.isAdmin ? h('span', { class: 'badge', style: 'margin-left:.5rem' }, 'Admin') : null,
        u.totpEnabled ? h('span', { class: 'badge ok', style: 'margin-left:.5rem' }, '2FA') : null,
        h('div', { class: 'small muted' }, `${fmtBytes(u.usedBytes)} used` + (u.quotaGb ? ` of ${u.quotaGb} GB` : ''))),
      h('td', {}, h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: async () => { const p = prompt(`New password for ${u.username}`); if (p) { try { await api('PATCH', `/api/users/${u.id}`, { password: p }); toast('Password reset.'); } catch (e) { toast(e.message); } } } }, 'Reset password'),
        u.id !== state.me.id ? h('button', { class: 'btn small', onclick: async () => { await api('PATCH', `/api/users/${u.id}`, { isAdmin: !u.isAdmin }); render(); } }, u.isAdmin ? 'Remove admin' : 'Make admin') : null,
        h('button', { class: 'btn small', onclick: async () => {
          const v = prompt(`Storage limit for ${u.username} in GB (across the cars they own). Leave empty for no limit. When reached, their oldest unlocked clips are removed.`, u.quotaGb ?? '');
          if (v === null) return;
          await api('PATCH', `/api/users/${u.id}`, { quotaGb: v.trim() === '' ? null : Number(v) });
          render();
        } }, 'Storage limit'),
        u.totpEnabled && u.id !== state.me.id ? h('button', { class: 'btn small', onclick: async () => {
          if (confirm(`Turn off two-factor sign-in for ${u.username}? Use this if they lost their phone.`)) { await api('PATCH', `/api/users/${u.id}`, { resetTotp: true }); render(); }
        } }, 'Reset 2FA') : null,
        u.id !== state.me.id ? h('button', { class: 'btn small danger', onclick: async () => { if (confirm(`Delete ${u.username}?`)) { try { await api('DELETE', `/api/users/${u.id}`); render(); } catch (e) { toast(e.message); } } } }, 'Delete') : null))))),
    h('div', { class: 'row' }, nu, np, h('label', { class: 'row small' }, na, 'Admin'),
      h('button', { class: 'btn', onclick: async () => {
        try { await api('POST', '/api/users', { username: nu.value, password: np.value, isAdmin: na.checked }); render(); } catch (e) { toast(e.message); }
      } }, 'Add person'))));
}

boot();
