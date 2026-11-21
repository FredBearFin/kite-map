// Downloading a region for offline use.

import { backend } from './backend.js';
import { bufferBbox, countTiles, tilesIn } from './geo.js';
import { cellsFor, downloadWind, filterBbox, lakeCenter, loadCell, scoreFeatures, windCellKey } from './lakes.js';
import { ASSETS, fetchAsset, fetchTile } from './tiles.js';

export const DEFAULTS = {
  baseZoom: 11, // whole box
  detailZoom: 14, // around candidate spots (basemap source max zoom)
  demZoom: 9,
  demDetailZoom: 12,
  geoZoom: 8,
  minAreaKm2: 0.3,
  detailSpots: 300,
};

const FONTS = ['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic'];
const RANGES = ['0-255', '256-511', '512-767', '768-1023', '8192-8447'];

/** Rough tile counts and size so the user knows what they are getting into. */
export function estimate(bbox, opt = DEFAULTS) {
  let base = 0, dem = 0, geo = 0;
  for (let z = 0; z <= opt.baseZoom; z++) base += countTiles(bbox, z);
  for (let z = 0; z <= opt.demZoom; z++) dem += countTiles(bbox, z);
  if (opt.geology) for (let z = 0; z <= opt.geoZoom; z++) geo += countTiles(bbox, z);
  // Detail tiles: about 60 per spot across z12-z14 for a typical lake.
  const detail = opt.detailSpots * 35;
  const mb = (base * 25 + detail * 30 + dem * 60 + geo * 20) / 1024;
  return { tiles: base + dem + geo + detail, mb: Math.round(mb) };
}

async function runPool(items, worker, concurrency, signal, onTick) {
  let i = 0, done = 0, failed = 0;
  async function next() {
    while (i < items.length) {
      if (signal?.aborted) throw new Error('cancelled');
      const it = items[i++];
      try {
        await worker(it);
      } catch {
        failed++;
      }
      done++;
      if (done % 20 === 0 || done === items.length) onTick(done, failed);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
  return failed;
}

async function missingTiles(layer, list) {
  const out = [];
  for (let i = 0; i < list.length; i += 500) {
    const part = list.slice(i, i + 500);
    const has = await backend.cacheHas(part.map(([z, x, y]) => `t/${layer}/${z}/${x}/${y}`));
    part.forEach((t, j) => !has[j] && out.push(t));
  }
  return out;
}

function tileList(bbox, z0, z1) {
  const out = [];
  for (let z = z0; z <= z1; z++) for (const t of tilesIn(bbox, z)) out.push(t);
  return out;
}

function dedupe(list) {
  const seen = new Set();
  return list.filter(([z, x, y]) => {
    const k = `${z}/${x}/${y}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Download everything for a region. progress(stepLabel, done, total, note).
 * Returns the region record that is saved in the store.
 */
export async function downloadRegion(region, progress, signal) {
  const opt = { ...DEFAULTS, ...region.options };
  const bbox = region.bbox;
  const report = { failed: 0 };

  // 1. Lakes
  progress('Lakes', 0, 1);
  const cells = cellsFor(bbox);
  let lakes = [];
  for (let i = 0; i < cells.length; i++) {
    if (signal?.aborted) throw new Error('cancelled');
    lakes.push(...(await loadCell(cells[i])));
    progress('Lakes', i + 1, cells.length);
  }
  lakes = filterBbox(lakes, bbox).filter((f) => f.properties.a >= opt.minAreaKm2);

  // 2. Wind history for each 1-degree grid point that has lakes
  const points = [...new Set(lakes.map((f) => windCellKey(lakeCenter(f)[1], lakeCenter(f)[0])))];
  progress('Wind history', 0, points.length);
  try {
    await downloadWind(points, (d, t, note) => progress('Wind history', d, t, note), signal);
  } catch (e) {
    if (String(e).includes('cancelled')) throw e;
    report.windError = String(e);
  }

  // 3. Score and pick the spots that get full-detail map tiles
  progress('Scoring spots', 0, 1);
  await scoreFeatures(lakes);
  const ranked = [...lakes].sort((a, b) => b.properties.score - a.properties.score);
  const spots = ranked.slice(0, opt.detailSpots);
  progress('Scoring spots', 1, 1);

  // 4. Map tiles
  let osm = tileList(bbox, 0, opt.baseZoom);
  let dem = tileList(bbox, 0, opt.demZoom);
  for (const f of spots) {
    const b = bufferBbox(f.properties._bbox, 1.5);
    osm.push(...tileList(b, opt.baseZoom + 1, opt.detailZoom));
    dem.push(...tileList(b, opt.demZoom + 1, opt.demDetailZoom));
  }
  osm = await missingTiles('osm', dedupe(osm));
  dem = await missingTiles('dem', dedupe(dem));
  let geo = opt.geology ? await missingTiles('geo', tileList(bbox, 0, opt.geoZoom)) : [];

  const jobs = [
    ['Map', osm, (t) => fetchTile('osm', ...t), 12],
    ['Terrain', dem, (t) => fetchTile('dem', ...t), 8],
    ['Geology', geo, (t) => fetchTile('geo', ...t), 4],
  ];
  for (const [label, list, fn, conc] of jobs) {
    if (!list.length) continue;
    progress(label, 0, list.length);
    report.failed += await runPool(list, fn, conc, signal, (d, f) =>
      progress(label, d, list.length, f ? `${f} could not be downloaded` : ''),
    );
  }

  // 5. Fonts and icons
  const assets = [ASSETS.sprite + '.json', ASSETS.sprite + '.png', ASSETS.sprite + '@2x.json', ASSETS.sprite + '@2x.png'];
  for (const font of FONTS) for (const r of RANGES) assets.push(ASSETS.glyphs.replace('{fontstack}', font).replace('{range}', r));
  progress('Fonts and icons', 0, assets.length);
  await runPool(assets, fetchAsset, 4, signal, (d) => progress('Fonts and icons', d, assets.length));

  const record = {
    ...region,
    options: opt,
    lakes: lakes.length,
    windPoints: points.length,
    failedTiles: report.failed,
    windError: report.windError || null,
    downloaded: Date.now(),
  };
  await backend.kvSet('region/' + region.id, record);
  return record;
}
