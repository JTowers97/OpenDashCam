import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mismatch_policy TEXT NOT NULL DEFAULT 'alert',
  truth_camera_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS car_shares (
  car_id INTEGER NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  PRIMARY KEY (car_id, user_id)
);

CREATE TABLE IF NOT EXISTS cameras (
  id TEXT PRIMARY KEY,
  car_id INTEGER NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  device_model TEXT,
  app_version TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  battery INTEGER,
  charging INTEGER,
  thermal INTEGER,
  storage_free INTEGER,
  recording INTEGER NOT NULL DEFAULT 0,
  mode TEXT,
  offline_alerted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash TEXT PRIMARY KEY,
  car_id INTEGER NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  camera_id TEXT NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  meta TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS clips (
  id TEXT PRIMARY KEY,
  camera_id TEXT NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  car_id INTEGER NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  stream TEXT,
  file_name TEXT NOT NULL,
  path TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  duration_ms INTEGER,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  codec TEXT,
  width INTEGER,
  height INTEGER,
  fps INTEGER,
  mode TEXT,
  locked INTEGER NOT NULL DEFAULT 0,
  lock_reason TEXT,
  encrypted INTEGER NOT NULL DEFAULT 0,
  has_track INTEGER NOT NULL DEFAULT 0,
  has_thumb INTEGER NOT NULL DEFAULT 0,
  lat REAL,
  lon REAL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS clips_car_time ON clips(car_id, started_at);
CREATE INDEX IF NOT EXISTS clips_time ON clips(started_at);

CREATE TABLE IF NOT EXISTS points (
  car_id INTEGER NOT NULL,
  camera_id TEXT NOT NULL,
  t INTEGER NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  speed REAL,
  course REAL,
  acc REAL,
  PRIMARY KEY (camera_id, t)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS points_car_time ON points(car_id, t);

CREATE TABLE IF NOT EXISTS live (
  camera_id TEXT PRIMARY KEY,
  car_id INTEGER NOT NULL,
  t INTEGER NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  speed REAL,
  course REAL,
  acc REAL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  car_id INTEGER,
  camera_id TEXT,
  type TEXT NOT NULL,
  t INTEGER NOT NULL,
  data TEXT
);
CREATE INDEX IF NOT EXISTS events_car_time ON events(car_id, t);

CREATE TABLE IF NOT EXISTS trips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  car_id INTEGER NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  start_t INTEGER NOT NULL,
  end_t INTEGER NOT NULL,
  distance_m REAL NOT NULL,
  max_speed REAL,
  avg_speed REAL,
  start_lat REAL, start_lon REAL, end_lat REAL, end_lon REAL,
  name TEXT
);
CREATE INDEX IF NOT EXISTS trips_car_time ON trips(car_id, start_t);

-- Manual trip edits, re-applied whenever trips are rebuilt from GPS points.
CREATE TABLE IF NOT EXISTS trip_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  car_id INTEGER NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,          -- 'split' at from_t, or 'merge' across from_t..to_t
  from_t INTEGER NOT NULL,
  to_t INTEGER
);

-- Frequently visited places, learned from trips when commute learning is on.
CREATE TABLE IF NOT EXISTS places (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  car_id INTEGER NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  visits INTEGER NOT NULL,
  kind TEXT NOT NULL,          -- 'home' | 'work' | 'frequent'
  label TEXT,
  custom_label INTEGER NOT NULL DEFAULT 0
);

-- Smart search: CLIP embeddings of frames sampled from each clip (int8-quantized, 512 bytes each).
CREATE TABLE IF NOT EXISTS clip_frames (
  clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  offset_ms INTEGER NOT NULL,
  vec BLOB NOT NULL,
  PRIMARY KEY (clip_id, offset_ms)
) WITHOUT ROWID;

-- License plate readings (only when plate search is on; deleted after the retention period).
CREATE TABLE IF NOT EXISTS plate_reads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  car_id INTEGER NOT NULL,
  t INTEGER NOT NULL,           -- wall-clock time of the sighting
  offset_ms INTEGER NOT NULL,
  plate TEXT NOT NULL,          -- normalized: uppercase letters and digits only
  confidence REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS plate_reads_t ON plate_reads(t);
CREATE INDEX IF NOT EXISTS plate_reads_clip ON plate_reads(clip_id);
CREATE INDEX IF NOT EXISTS plate_reads_plate ON plate_reads(plate);

-- Plate log: your notes on plates, and merges ("A8C1234 is really ABC1234") applied to future readings.
CREATE TABLE IF NOT EXISTS plate_notes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plate TEXT NOT NULL,
  note TEXT NOT NULL,
  PRIMARY KEY (user_id, plate)
);
CREATE TABLE IF NOT EXISTS plate_aliases (
  from_plate TEXT PRIMARY KEY,
  to_plate TEXT NOT NULL
);

-- Browser notifications (Web Push subscriptions).
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Audit log: who did what, when, from where.
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  t INTEGER NOT NULL,
  user_id INTEGER,
  username TEXT,
  action TEXT NOT NULL,
  target TEXT,
  ip TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS audit_t ON audit(t);

-- Expiring share links for single clips (or a trimmed part), optionally with plates/faces blurred.
CREATE TABLE IF NOT EXISTS shares (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  allow_download INTEGER NOT NULL DEFAULT 0,
  blur_plates INTEGER NOT NULL DEFAULT 0,
  blur_faces INTEGER NOT NULL DEFAULT 0,
  start_s REAL,
  end_s REAL,
  file TEXT,                 -- processed copy (trimmed and/or blurred); null = the original clip
  status TEXT NOT NULL,      -- processing | ready | failed
  error TEXT,
  views INTEGER NOT NULL DEFAULT 0
);

-- Places on the map that trigger arrival/leaving alerts for the person who created them.
CREATE TABLE IF NOT EXISTS alert_places (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  radius_m REAL NOT NULL,
  on_arrive INTEGER NOT NULL DEFAULT 1,
  on_leave INTEGER NOT NULL DEFAULT 0,
  car_ids TEXT,            -- JSON array, or null for all cars the person can see
  created_at INTEGER NOT NULL
);

-- Recordings already imported from a Viofo dashcam (so each is fetched once).
CREATE TABLE IF NOT EXISTS viofo_files (
  car_id INTEGER NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  size INTEGER,
  clip_id TEXT,
  imported_at INTEGER NOT NULL,
  PRIMARY KEY (car_id, path)
);

-- Each person's notifications (their inbox in the app; also delivered by push and the app's direct connection).
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  t INTEGER NOT NULL,
  kind TEXT NOT NULL,          -- impact, arrived, left, speeding, offline, overheating, battery_cutoff, recording_stopped,
                               -- mismatch, storage, live_view, summary, test
  title TEXT NOT NULL,
  body TEXT,
  car_id INTEGER,
  event_id INTEGER,
  image TEXT,
  url TEXT,
  read INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, id);

CREATE TABLE IF NOT EXISTS recovery_codes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  PRIMARY KEY (user_id, code_hash)
);
`;

/** Columns added after v0.4.0. Each is added only if missing, so existing databases upgrade in place. */
const COLUMNS = [
  ['users', 'totp_secret', 'TEXT'],
  ['users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0'],
  ['clips', 'place', 'TEXT'],
  ['trips', 'start_place', 'TEXT'],
  ['trips', 'end_place', 'TEXT'],
  ['trips', 'auto_name', 'TEXT'],
  ['clips', 'indexed', 'INTEGER NOT NULL DEFAULT 0'],   // smart search: 0 pending, 1 done, -1 failed
  ['clips', 'plates_indexed', 'INTEGER NOT NULL DEFAULT 0'],
  ['plate_reads', 'box', 'TEXT'],           // [x1, y1, x2, y2] in the full-resolution frame
  ['plate_reads', 'corrected', 'INTEGER NOT NULL DEFAULT 0'],
  ['cars', 'retention_days', 'INTEGER'],        // null = server default, 0 = keep forever
  ['cars', 'storage_cap_gb', 'REAL'],           // null = no per-car limit
  ['users', 'quota_gb', 'REAL'],                // null = no per-person limit (cars they own)
  ['sessions', 'user_agent', 'TEXT'],
  ['clips', 'trimmed_from', 'TEXT'],
  ['clips', 'stamp', 'INTEGER'],              // date/time stamp burned in: 1 yes, 0 no, null unknown (older uploads)
  ['users', 'prefs', 'TEXT'],
  ['push_subs', 'kind', "TEXT NOT NULL DEFAULT 'browser'"],   // browser | app
  ['push_subs', 'label', 'TEXT'],                 // JSON: display preferences (theme, accent, text size, contrast, motion)
  ['cars', 'speed_alert_kmh', 'REAL'],        // null = no speed alert
  ['cars', 'viofo_url', 'TEXT'],              // Viofo dashcam address on the home network, e.g. http://192.168.1.60
  ['cars', 'viofo_folders', 'TEXT'],          // which folders to import: movie,parking,ro
  ['cars', 'viofo_status', 'TEXT'],           // JSON: last check result
  ['cars', 'viofo_lenses', 'TEXT'],           // which lenses to import over Wi-Fi: F,R,I
  ['cars', 'viofo_stream', 'TEXT'],           // live stream address (RTSP); default rtsp://<camera>/xxx.mov          // id of the clip a trimmed copy was cut from
  ['sessions', 'ip', 'TEXT'],
  ['sessions', 'last_used_at', 'INTEGER'],
];

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  for (const [table, col, type] of COLUMNS) {
    const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  return {
    raw: db,
    get: (sql, ...p) => stmt(sql).get(...p),
    all: (sql, ...p) => stmt(sql).all(...p),
    run: (sql, ...p) => stmt(sql).run(...p),
    tx(fn) {
      db.exec('BEGIN');
      try {
        const r = fn();
        db.exec('COMMIT');
        return r;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

/** Server-wide settings with defaults. */
export const DEFAULT_SETTINGS = {
  serverName: 'Open Dash Cam',
  units: 'auto',              // auto | mph | kmh
  storageCapGb: 0,            // 0 = no limit
  retentionDays: 0,           // 0 = keep forever
  ntfyUrl: '',                // e.g. https://ntfy.sh/my-secret-topic
  ntfyToken: '',
  mapStyleUrl: 'https://tiles.openfreemap.org/styles/liberty',
  mismatchDistanceM: 50,
  mismatchSpeedKmh: 16,
  mismatchSustainSec: 10,
  offlineAlertMin: 30,
  preTranscode: false,
  commuteLearning: false,
  smartSearch: false,
  mlUrl: process.env.ODC_ML_URL || 'http://opendashcam-ml:3003',
  searchFrameIntervalSec: 10,
  homeUrl: process.env.ODC_HOME_URL || '',   // optional address on the home network, e.g. https://192.168.1.50:8443
  httpsOnly: false,
  backupEnabled: true,
  backupHour: 3,
  backupKeep: 7,
  auditRetentionDays: 365,
  mqttEnabled: false,
  mqttUrl: '',                    // mqtt://broker:1883 or mqtts://broker:8883
  mqttUsername: '',
  mqttPassword: '',
  mqttPrefix: 'opendashcam',
  mqttDiscoveryPrefix: 'homeassistant',
  drivingEvents: false,
  drivingSensitivity: 'normal',   // low | normal | high
  plateSearch: false,
  plateLog: false,
  plateRetentionDays: 30,
  plateFrameIntervalSec: 2,
  plateMinConfidence: 0.6,
};

export function getSettings(db) {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of db.all('SELECT key, value FROM settings')) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      /* ignore bad rows */
    }
  }
  return out;
}

export function saveSettings(db, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    const def = DEFAULT_SETTINGS[k];
    let value = v;
    if (typeof def === 'number') value = Number(v) || 0;
    if (k === 'plateRetentionDays') value = Math.min(3650, Math.max(0, Math.round(value))); // 0 = keep forever
    if (k === 'plateMinConfidence') value = Math.min(1, Math.max(0, value));
    if (k === 'searchFrameIntervalSec' || k === 'plateFrameIntervalSec') value = Math.max(1, value);
    if (typeof def === 'boolean') value = Boolean(v);
    if (typeof def === 'string') value = String(v ?? '').slice(0, 500);
    db.run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, JSON.stringify(value));
  }
}

export function getMeta(db, key) {
  return db.get('SELECT value FROM meta WHERE key = ?', key)?.value ?? null;
}

export function setMeta(db, key, value) {
  db.run('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}
