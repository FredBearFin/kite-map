// Lake data (HydroLAKES, split into 10-degree cells) and wind history.

import { backend } from './backend.js';
import { bboxOf, bboxIntersects, haversineKm } from './geo.js';
import { lakeShape, scoreLake, windStats } from './scoring.js';

export const LAKES_BASE = 'https://github.com/FredBearFin/kite-map/releases/download/lakes-v1/';

export function cellName(lat0, lon0) {
  const ns = lat0 >= 0 ? 'n' : 's';
  const ew = lon0 >= 0 ? 'e' : 'w';
  return `${ns}${String(Math.abs(lat0)).padStart(2, '0')}${ew}${String(Math.abs(lon0)).padStart(3, '0')}`;
}

/** 10-degree cells touching bbox (lakes are filed by their outlet point). */
export function cellsFor(bbox) {
  const out = [];
  const pad = 0.5; // a big lake's outlet can sit just outside the box
  for (let lat = Math.floor((bbox[1] - pad) / 10) * 10; lat < bbox[3] + pad; lat += 10)
    for (let lon = Math.floor((bbox[0] - pad) / 10) * 10; lon < bbox[2] + pad; lon += 10)
      if (lat >= -90 && lat < 90 && lon >= -180 && lon < 180) out.push(cellName(lat, lon));
  return out;
}

async function gunzipJson(bytes) {
  // Files are gzip; handle a server that already un-gzipped it too.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

let index = null;
export async function lakeIndex() {
  if (index) return index;
  index = await backend.httpJson(LAKES_BASE + 'index.json', { key: 'lakes/index.json' });
  return index;
}

/** Load one cell (downloading it if needed). Returns GeoJSON features. */
export async function loadCell(name, { offlineOnly = false } = {}) {
  const key = 'lakes/' + name;
  let bytes = await backend.cacheGet(key);
  if (!bytes) {
    if (offlineOnly) return [];
    const idx = await lakeIndex();
    if (!idx.cells[name]) return [];
    bytes = await backend.httpGet(LAKES_BASE + name + '.geojson.gz', { key });
  }
  const fc = await gunzipJson(bytes);
  return fc.features;
}

// ---------- Wind ----------

const GRID = 1; // degrees; ERA5 is 0.25 deg but 1 deg keeps downloads small

export function windCellKey(lat, lon) {
  const gl = Math.round(lat / GRID) * GRID;
  const gn = Math.round(lon / GRID) * GRID;
  return `${gl.toFixed(1)},${gn.toFixed(1)}`;
}

const windMem = new Map();
export async function getWind(lat, lon) {
  const k = windCellKey(lat, lon);
  if (windMem.has(k)) return windMem.get(k);
  const w = await backend.kvGet('wind/' + k);
  windMem.set(k, w);
  return w;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Download one year of hourly wind (ERA5 via Open-Meteo) for grid points and
 * save kiteable-hour stats. Points already saved are skipped.
 */
export async function downloadWind(points, onProgress, signal) {
  const todo = [];
  for (const k of points) if (!(await backend.kvGet('wind/' + k))) todo.push(k);
  const year = new Date().getUTCFullYear() - 1;
  const batch = 8;
  for (let i = 0; i < todo.length; i += batch) {
    if (signal?.aborted) throw new Error('cancelled');
    const part = todo.slice(i, i + batch);
    const lats = part.map((k) => k.split(',')[0]).join(',');
    const lons = part.map((k) => k.split(',')[1]).join(',');
    const url =
      `https://archive-api.open-meteo.com/v1/archive?latitude=${lats}&longitude=${lons}` +
      `&start_date=${year}-01-01&end_date=${year}-12-31` +
      `&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=kn&timezone=auto&timeformat=unixtime`;
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await backend.httpJson(url);
        break;
      } catch (e) {
        if (attempt >= 4 || signal?.aborted) throw e;
        onProgress?.(i, todo.length, 'Wind service is busy, waiting a minute...');
        await sleep(60000);
      }
    }
    const list = Array.isArray(res) ? res : [res];
    for (let j = 0; j < part.length; j++) {
      const r = list[j];
      if (!r?.hourly) continue;
      const off = r.utc_offset_seconds || 0;
      const hours = r.hourly.time.map((t) => new Date((t + off) * 1000).getUTCHours());
      const stats = windStats(r.hourly.wind_speed_10m, r.hourly.wind_direction_10m, hours);
      stats.year = year;
      windMem.set(part[j], stats);
      await backend.kvSet('wind/' + part[j], stats);
    }
    onProgress?.(Math.min(i + batch, todo.length), todo.length);
    // Stay well inside Open-Meteo's free limits.
    if (i + batch < todo.length) await sleep(4000);
  }
}

/** Live forecast (next 7 days) of kiteable daylight hours. Online only. */
export async function forecast(lat, lon) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}` +
    `&hourly=wind_speed_10m,wind_gusts_10m,wind_direction_10m&wind_speed_unit=kn&timezone=auto&forecast_days=7`;
  return backend.httpJson(url);
}

// ---------- Scoring all loaded lakes ----------

export function lakeCenter(f) {
  const p = f.properties;
  if (p._c) return p._c;
  const b = bboxOf(f.geometry);
  p._bbox = b;
  p._c = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  return p._c;
}

export async function scoreFeatures(features) {
  for (const f of features) {
    const [lon, lat] = lakeCenter(f);
    const fetch8 = lakeShape(f);
    const wind = await getWind(lat, lon);
    const s = scoreLake(fetch8, wind);
    Object.assign(f.properties, { score: s.score, eff: s.effHours, basis: s.basis });
    f.properties._suit = s.suit;
  }
}

export function filterBbox(features, bbox) {
  return features.filter((f) => {
    lakeCenter(f);
    return bboxIntersects(f.properties._bbox, bbox);
  });
}

export function distanceFromHome(f, home) {
  const [lon, lat] = lakeCenter(f);
  return haversineKm(home.lat, home.lon, lat, lon);
}
