import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

/**
 * Offline reverse geocoding: turns coordinates into "Springfield, IL" using GeoNames city data
 * (cities500: every place with 500+ people; CC BY 4.0, geonames.org). The Docker image downloads it
 * at build time. No location ever leaves the server.
 */
const dir = process.env.ODC_GEONAMES_DIR || new URL('../geonames', import.meta.url).pathname;
const MAX_KM = 40;

let lat = null;
let lon = null;
let names = [];
let regions = [];   // "MO" for US/CA states, region name elsewhere
let countries = [];
const grid = new Map(); // "latCell,lonCell" -> [index...]
let ready = false;

export const geocoderReady = () => ready;

export async function loadGeocoder() {
  const cities = path.join(dir, 'cities500.txt');
  if (!fs.existsSync(cities)) {
    console.log('Place names off: GeoNames data not found in', dir);
    return false;
  }
  const admin1 = new Map();
  const adminFile = path.join(dir, 'admin1CodesASCII.txt');
  if (fs.existsSync(adminFile)) {
    for (const line of fs.readFileSync(adminFile, 'utf8').split('\n')) {
      const [code, name] = line.split('\t');
      if (code && name) admin1.set(code, name);
    }
  }
  const lats = [];
  const lons = [];
  const rl = readline.createInterface({ input: fs.createReadStream(cities, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    const f = line.split('\t');
    if (f.length < 11) continue;
    const la = Number(f[4]);
    const lo = Number(f[5]);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
    const cc = f[8];
    const a1 = f[10];
    const i = names.length;
    names.push(f[1]);
    regions.push(cc === 'US' || cc === 'CA' ? a1 : admin1.get(`${cc}.${a1}`) || '');
    countries.push(cc);
    lats.push(la);
    lons.push(lo);
    const key = `${Math.floor(la)},${Math.floor(lo)}`;
    let cell = grid.get(key);
    if (!cell) grid.set(key, (cell = []));
    cell.push(i);
  }
  lat = Float64Array.from(lats);
  lon = Float64Array.from(lons);
  ready = names.length > 0;
  console.log(`Place names on: ${names.length} places loaded`);
  return ready;
}

/** Nearest populated place within 40 km, as "Name, Region" (plus country outside the US). */
export function placeName(la, lo) {
  if (!ready || la == null || lo == null) return null;
  const cla = Math.floor(la);
  const clo = Math.floor(lo);
  const cosLat = Math.cos((la * Math.PI) / 180);
  let best = -1;
  let bestD = Infinity;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      let x = clo + dx;
      if (x < -180) x += 360;
      if (x >= 180) x -= 360;
      const cell = grid.get(`${cla + dy},${x}`);
      if (!cell) continue;
      for (const i of cell) {
        let dLon = Math.abs(lon[i] - lo);
        if (dLon > 180) dLon = 360 - dLon;
        const d = (lat[i] - la) ** 2 + (dLon * cosLat) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
  }
  if (best < 0 || Math.sqrt(bestD) * 111.2 > MAX_KM) return null;
  const parts = [names[best]];
  if (regions[best]) parts.push(regions[best]);
  if (countries[best] !== 'US') parts.push(countries[best]);
  return parts.join(', ');
}
