// Lake data (HydroLAKES, split into 10-degree cells) and wind history.

import { backend } from './backend.js';
import { bboxOf, bboxIntersects, haversineKm } from './geo.js';
import { lakeShape, scoreLake, windStats, WIND_VERSION } from './scoring.js';
import { scoreSite } from './spotscore.js';

// The lake database is built on this computer from the HydroLAKES zip
// (see the Regions tab), and stored under lakes/<cell> and lakes/index.json.
export const HYDROLAKES_URL = 'https://data.hydrosheds.org/file/hydrolakes/HydroLAKES_polys_v10_shp.zip';
export const HYDROLAKES_PAGE = 'https://www.hydrosheds.org/products/hydrolakes';

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
/** The lake index, or null if the lake database has not been set up yet. */
export async function lakeIndex({ reload = false } = {}) {
  if (index && !reload) return index;
  const bytes = await backend.cacheGet('lakes/index.json');
  index = bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
  return index;
}

/** Load one cell from the local lake database. Returns GeoJSON features. */
export async function loadCell(name) {
  const bytes = await backend.cacheGet('lakes/' + name);
  if (!bytes) return [];
  const fc = await gunzipJson(bytes);
  return fc.features;
}

// ---------- Wind ----------

const GRID = 0.25; // degrees: ERA5's own grid, so each spot gets its nearest weather cell

export function windCellKey(lat, lon) {
  const gl = Math.round(lat / GRID) * GRID;
  const gn = Math.round(lon / GRID) * GRID;
  return `${gl.toFixed(2)},${gn.toFixed(2)}`;
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
export async function downloadWind(points, onProgress, signal, { retries = 4 } = {}) {
  const todo = [];
  for (const k of points) {
    const w = await backend.kvGet('wind/' + k);
    if (!w || (w.v ?? 1) < WIND_VERSION) todo.push(k);
  }
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
      `&hourly=wind_speed_10m,wind_direction_10m,temperature_2m&wind_speed_unit=kn&timezone=auto&timeformat=unixtime`;
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await backend.httpJson(url);
        break;
      } catch (e) {
        if (attempt >= retries || signal?.aborted) throw e;
        onProgress?.(i, todo.length, 'Wind service is busy, waiting a minute...');
        await sleep(60000);
      }
    }
    const list = Array.isArray(res) ? res : [res];
    for (let j = 0; j < part.length; j++) {
      const r = list[j];
      if (!r?.hourly) continue;
      const off = r.utc_offset_seconds || 0;
      const local = r.hourly.time.map((t) => new Date((t + off) * 1000));
      const hours = local.map((d) => d.getUTCHours());
      const months = local.map((d) => d.getUTCMonth());
      const stats = windStats(r.hourly.wind_speed_10m, r.hourly.wind_direction_10m, hours, 1, months, r.hourly.temperature_2m);
      stats.year = year;
      windMem.set(part[j], stats);
      await backend.kvSet('wind/' + part[j], stats);
    }
    onProgress?.(Math.min(i + batch, todo.length), todo.length);
    // Stay well inside Open-Meteo's free limits.
    if (i + batch < todo.length) await sleep(4000);
  }
}

/** Live forecast (next 7 days), hourly wind. Online only. */
export async function forecast(lat, lon) {
  return (await forecastMany([[lat, lon]]))[0];
}

/** Forecasts for several points in one request. Returns one result per point. */
export async function forecastMany(points) {
  const out = [];
  for (let i = 0; i < points.length; i += 50) {
    const part = points.slice(i, i + 50);
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${part.map((p) => p[0].toFixed(3)).join(',')}` +
      `&longitude=${part.map((p) => p[1].toFixed(3)).join(',')}` +
      `&hourly=wind_speed_10m,wind_gusts_10m,wind_direction_10m,temperature_2m&wind_speed_unit=kn&timezone=auto&forecast_days=7`;
    // The forecast service sometimes times out: try a few times.
    let r, err;
    for (let k = 0; k < 3 && !r; k++) {
      try { r = await backend.httpJson(url, { refresh: true }); } catch (e) { err = e; await sleep(3000 * (k + 1)); }
    }
    if (!r) throw err;
    out.push(...(Array.isArray(r) ? r : [r]));
  }
  return out;
}

/** Real driving time and distance via the public OSRM router. Online only. */
export async function driveRoute(from, to) {
  const key = `drive/${from.lat.toFixed(3)},${from.lon.toFixed(3)}/${to[1].toFixed(3)},${to[0].toFixed(3)}`;
  const saved = await backend.kvGet(key);
  if (saved) return saved;
  const url = `https://router.project-osrm.org/route/v1/driving/${from.lon.toFixed(5)},${from.lat.toFixed(5)};${to[0].toFixed(5)},${to[1].toFixed(5)}?overview=false`;
  const r = await backend.httpJson(url);
  if (r.code !== 'Ok' || !r.routes?.length) throw new Error('no route');
  const res = { hours: r.routes[0].duration / 3600, km: r.routes[0].distance / 1000 };
  await backend.kvSet(key, res);
  return res;
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

// Shore analyses of lakes (site.js), by lake id. Lakes with one are scored
// from it; the others get the quick shape-only estimate.
export const lakeSites = new Map();

export async function scoreFeatures(features, mode = 'water') {
  let n = 0;
  for (const f of features) {
    // Let the window repaint while scoring thousands of lakes.
    if (++n % 400 === 0) await new Promise((r) => setTimeout(r, 0));
    const [lon, lat] = lakeCenter(f);
    const fetch8 = lakeShape(f);
    const wind = await getWind(lat, lon);
    const site = lakeSites.get(f.properties.id);
    if (site?.ok) {
      const s = scoreSite(site, wind, mode, f.properties);
      Object.assign(f.properties, { score: s.score, eff: s.eff, basis: s.basis, detail: 1 });
      f.properties._suit = s.Q;
      continue;
    }
    const s = scoreLake(fetch8, wind, mode, f.properties);
    Object.assign(f.properties, { score: s.score, eff: s.effHours, basis: s.basis, detail: 0 });
    f.properties._suit = s.suit;
  }
}

export function filterBbox(features, bbox) {
  return features.filter((f) => {
    lakeCenter(f);
    return bboxIntersects(f.properties._bbox, bbox);
  });
}

/** Is [lon, lat] inside the lake polygon (outer ring, ignoring islands)? */
export function pointInLake(f, lon, lat) {
  lakeCenter(f);
  const b = f.properties._bbox;
  if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) return false;
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  for (const poly of polys) {
    const r = poly[0];
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i];
      const [xj, yj] = r[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

export function distanceFromHome(f, home) {
  const [lon, lat] = lakeCenter(f);
  return haversineKm(home.lat, home.lon, lat, lon);
}
