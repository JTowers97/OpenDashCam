import { config } from './config.js';
import { getSettings } from './db.js';
import { MqttClient } from './mqtt.js';
import { carLive } from './tracks.js';
import { now } from './util.js';

/**
 * Home Assistant integration over MQTT with discovery: each car appears as a device with
 *   - a location tracker (works with Home Assistant zones)
 *   - sensors: speed, last seen, phone battery; binary sensors: recording, moving
 *   - an event entity for impacts, arrivals/leaving, speeding, offline and driving events
 * Nothing needs configuring in Home Assistant beyond its MQTT integration.
 */
const EVENT_TYPES = ['impact', 'arrived', 'left', 'speeding', 'offline', 'overheating', 'battery_cutoff', 'recording_stopped',
  'mismatch', 'hard_brake', 'hard_accel', 'sharp_turn'];

let client = null;
let clientKey = '';
let lastEventId = 0;
const lastPublished = new Map(); // topic -> payload (avoid re-sending unchanged states)
const announced = new Set();     // car ids with discovery published
let lastDiscovery = 0;

export const haStatus = () => ({
  enabled: !!client,
  connected: !!client?.connected,
  error: client && !client.connected ? client.lastError || 'Connecting…' : null,
});

function settingsKey(s) {
  return JSON.stringify([s.mqttEnabled, s.mqttUrl, s.mqttUsername, s.mqttPassword, s.mqttPrefix, s.mqttDiscoveryPrefix]);
}

/** Called every few seconds: (re)connects when settings change, then publishes discovery, states and events. */
export function haTick(db) {
  const s = getSettings(db);
  const key = settingsKey(s);
  if (key !== clientKey) {
    if (client) {
      client.publish(`${s.mqttPrefix || 'opendashcam'}/status`, 'offline', { retain: true });
      client.close();
    }
    client = null;
    clientKey = key;
    lastPublished.clear();
    announced.clear();
    lastDiscovery = 0;
    if (!s.mqttEnabled || !s.mqttUrl) return;
    const prefix = s.mqttPrefix || 'opendashcam';
    try {
      client = new MqttClient(s.mqttUrl, {
        username: s.mqttUsername || undefined,
        password: s.mqttPassword || undefined,
        clientId: `opendashcam-${(config.version || '').replace(/\W/g, '')}-${Math.random().toString(36).slice(2, 7)}`,
        will: { topic: `${prefix}/status`, payload: 'offline', retain: true },
      });
    } catch (e) {
      client = null;
      console.warn('MQTT:', e.message);
      return;
    }
    client.on('connect', () => {
      client.publish(`${prefix}/status`, 'online', { retain: true });
      lastDiscovery = 0; // re-announce after (re)connecting
      lastEventId = lastEventId || (db.get('SELECT MAX(id) m FROM events')?.m ?? 0);
    });
  }
  if (!client?.connected) return;
  publishAll(db, s);
}

function pub(topic, payload, retain = true) {
  const p = typeof payload === 'string' ? payload : JSON.stringify(payload);
  if (retain && lastPublished.get(topic) === p) return;
  lastPublished.set(topic, p);
  client.publish(topic, p, { retain });
}

function publishAll(db, s) {
  const prefix = s.mqttPrefix || 'opendashcam';
  const disc = s.mqttDiscoveryPrefix || 'homeassistant';
  const cars = db.all('SELECT * FROM cars ORDER BY id');
  const base = (process.env.ODC_PUBLIC_URL || '').replace(/\/$/, '');

  // Discovery: on connect, every 10 minutes, and when cars are added or removed.
  const ids = new Set(cars.map((c) => c.id));
  const changed = cars.some((c) => !announced.has(c.id)) || [...announced].some((id) => !ids.has(id));
  if (changed || now() - lastDiscovery > 10 * 60_000) {
    lastDiscovery = now();
    for (const id of [...announced]) {
      if (ids.has(id)) continue;
      for (const [comp, obj] of COMPONENTS) pub(`${disc}/${comp}/odc_car_${id}/${obj}/config`, ''); // removes the entities
      announced.delete(id);
    }
    for (const car of cars) {
      const device = {
        identifiers: [`odc_car_${car.id}`], name: car.name, manufacturer: 'Open Dash Cam', model: 'Car',
        sw_version: config.version, ...(base ? { configuration_url: `${base}/#/cars` } : {}),
      };
      const common = { device, availability_topic: `${prefix}/status`, state_topic: `${prefix}/car/${car.id}/state` };
      const id = car.id;
      const configs = {
        [`device_tracker/odc_car_${id}/location`]: { name: 'Location', unique_id: `odc_car_${id}_location`, device, availability_topic: `${prefix}/status`,
          json_attributes_topic: `${prefix}/car/${id}/location`, source_type: 'gps', icon: 'mdi:car' },
        [`sensor/odc_car_${id}/speed`]: { ...common, name: 'Speed', unique_id: `odc_car_${id}_speed`, device_class: 'speed', unit_of_measurement: 'km/h',
          state_class: 'measurement', value_template: '{{ value_json.speed }}' },
        [`sensor/odc_car_${id}/last_seen`]: { ...common, name: 'Last seen', unique_id: `odc_car_${id}_last_seen`, device_class: 'timestamp',
          value_template: '{{ value_json.last_seen }}' },
        [`sensor/odc_car_${id}/battery`]: { ...common, name: 'Phone battery', unique_id: `odc_car_${id}_battery`, device_class: 'battery', unit_of_measurement: '%',
          state_class: 'measurement', value_template: '{{ value_json.battery }}', entity_category: 'diagnostic' },
        [`binary_sensor/odc_car_${id}/recording`]: { ...common, name: 'Recording', unique_id: `odc_car_${id}_recording`, icon: 'mdi:record-rec',
          value_template: "{{ 'ON' if value_json.recording else 'OFF' }}" },
        [`binary_sensor/odc_car_${id}/moving`]: { ...common, name: 'Moving', unique_id: `odc_car_${id}_moving`, device_class: 'moving',
          value_template: "{{ 'ON' if value_json.moving else 'OFF' }}" },
        [`event/odc_car_${id}/alert`]: { name: 'Alert', unique_id: `odc_car_${id}_alert`, device, availability_topic: `${prefix}/status`,
          state_topic: `${prefix}/car/${id}/event`, event_types: EVENT_TYPES, icon: 'mdi:car-emergency' },
      };
      for (const [path, cfg] of Object.entries(configs)) pub(`${disc}/${path}/config`, cfg);
      announced.add(car.id);
    }
  }

  // States: location and sensors, re-sent only when they change.
  for (const car of cars) {
    const p = carLive(db, car);
    const cams = db.all(`SELECT * FROM cameras WHERE car_id = ? AND token_hash NOT LIKE 'revoked:%' AND token_hash NOT LIKE 'viofo:%'`, car.id);
    const seen = Math.max(0, ...cams.map((c) => c.last_seen_at || 0), p?.t || 0);
    const recording = cams.some((c) => c.recording && now() - (c.last_seen_at || 0) < 120_000);
    const withBattery = cams.filter((c) => c.battery != null).sort((a, b) => (b.last_seen_at || 0) - (a.last_seen_at || 0))[0];
    const speedKmh = p?.live && p.speed != null ? Math.round(p.speed * 3.6) : 0;
    pub(`${prefix}/car/${car.id}/state`, {
      speed: speedKmh, moving: speedKmh > 3, recording,
      battery: withBattery?.battery ?? null,
      last_seen: seen ? new Date(seen).toISOString() : null,
    });
    if (p) pub(`${prefix}/car/${car.id}/location`, { latitude: p.lat, longitude: p.lon, gps_accuracy: Math.round(p.acc ?? 15) });
  }

  // Events since last time.
  for (const e of db.all('SELECT * FROM events WHERE id > ? ORDER BY id LIMIT 100', lastEventId)) {
    lastEventId = e.id;
    if (!EVENT_TYPES.includes(e.type)) continue;
    let data = {};
    try { data = JSON.parse(e.data || '{}'); } catch { /* ignore */ }
    const cam = e.camera_id ? db.get('SELECT label FROM cameras WHERE id = ?', e.camera_id) : null;
    pub(`${prefix}/car/${e.car_id}/event`, {
      event_type: e.type, time: new Date(e.t).toISOString(), camera: cam?.label ?? null,
      ...(data.message ? { message: data.message } : {}), ...(data.place ? { place: data.place } : {}),
      ...(data.speedKmh != null ? { speed_kmh: data.speedKmh } : {}), ...(data.g != null ? { g: data.g } : {}),
      ...(data.snapshot && base ? { snapshot_url: `${base}/#/events` } : {}),
    }, false);
  }
}

const COMPONENTS = [['device_tracker', 'location'], ['sensor', 'speed'], ['sensor', 'last_seen'], ['sensor', 'battery'],
  ['binary_sensor', 'recording'], ['binary_sensor', 'moving'], ['event', 'alert']];

export function haShutdown(db) {
  if (!client) return;
  const s = getSettings(db);
  client.publish(`${s.mqttPrefix || 'opendashcam'}/status`, 'offline', { retain: true });
  client.close();
}
