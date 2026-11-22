// Running the shore analysis inside the app: on a lake when you open it, and
// across the map in the background to discover launch spots anywhere (lakes,
// coasts, bays and rivers). Results are saved, so it all works offline later.

import { backend } from './backend.js';
import { bboxOf, bufferBbox } from './geo.js';
import { analyzeSite, SITE_VERSION } from './site.js';
import { gatherInputs } from './sitegather.js';
import { scoreSite } from './spotscore.js';
import { fetchTile } from './tiles.js';

const getTile = (z, x, y) => fetchTile('osm', z, x, y);

let canvas = null;
async function getDem(z, x, y) {
  const bytes = await fetchTile('dem', z, x, y);
  if (!bytes?.length) return null;
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  canvas ??= new OffscreenCanvas(256, 256);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, 256, 256);
  ctx.drawImage(bmp, 0, 0, 256, 256);
  bmp.close?.();
  return ctx.getImageData(0, 0, 256, 256).data;
}

const polysOf = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []);

/** Shore analysis of one lake (saved). */
export async function analyzeLake(f) {
  const key = `site/lake/${f.properties.id}`;
  const saved = await backend.kvGet(key);
  if (saved?.v === SITE_VERSION) return saved;
  const bbox = bufferBbox(bboxOf(f.geometry), 1.5);
  const inp = await gatherInputs(bbox, getTile, getDem, { maxTiles: 36 });
  const raw = analyzeSite({ ...inp, bbox, lake: polysOf(f.geometry), maxFetch: 15000 });
  raw.v = SITE_VERSION;
  // Only save once the map detail was there, so it improves when it is.
  if (raw.ok && !raw.waterFromLake && !inp.missing) await backend.kvSet(key, raw);
  return raw;
}

/** Shore analysis around any point (coast, bay, river or lake). */
export async function analyzePoint(lon, lat) {
  const bbox = bufferBbox([lon, lat, lon, lat], 12);
  const inp = await gatherInputs(bbox, getTile, getDem, { maxTiles: 36 });
  return analyzeSite({ ...inp, bbox, point: [lon, lat], radiusM: 2500, maxFetch: 15000 });
}

// ---------- discovery across the map ----------

export const BOX = 0.125; // degrees; the map is scanned in boxes this size
export const boxKey = (lon, lat) => `${Math.floor(lat / BOX)},${Math.floor(lon / BOX)}`;

export function boxesIn(bbox) {
  const out = [];
  for (let j = Math.floor(bbox[1] / BOX); j * BOX < bbox[3]; j++)
    for (let i = Math.floor(bbox[0] / BOX); i * BOX < bbox[2]; i++) out.push({ key: `${j},${i}`, bbox: [i * BOX, j * BOX, (i + 1) * BOX, (j + 1) * BOX] });
  return out;
}

const boxMem = new Map();

/** Launch candidates in one box (saved). */
export async function scanBox(b) {
  if (boxMem.has(b.key)) return boxMem.get(b.key);
  const key = `site/box/${b.key}`;
  let raw = await backend.kvGet(key);
  if (raw?.v !== SITE_VERSION) {
    // Look 1.5 km past the box so upwind water and shade are seen.
    const bbox = bufferBbox(b.bbox, 1.5);
    const inp = await gatherInputs(bbox, getTile, getDem, { maxTiles: 36 });
    if (!inp.tiles) return null; // nothing saved here and offline
    raw = inp.water.length ? analyzeSite({ ...inp, bbox, region: true, maxCand: 400, maxFetch: 15000, maxCells: 1000 }) : { ok: false };
    const c = b.bbox;
    raw.cand = (raw.cand || []).filter((p) => p.lon >= c[0] && p.lon < c[2] && p.lat >= c[1] && p.lat < c[3]);
    raw.v = SITE_VERSION;
    if (!inp.missing) await backend.kvSet(key, raw);
  }
  boxMem.set(b.key, raw);
  return raw;
}

/** Score each candidate on its own and keep the best one within ~2 km. */
export function pickSpots(raws, windAt, mode, minScore = 35) {
  const all = [];
  for (const raw of raws) {
    if (!raw?.cand?.length) continue;
    for (const c of raw.cand) {
      const one = { ok: true, cand: [c], roadsKnown: raw.roadsKnown };
      const s = scoreSite(one, windAt(c.lat, c.lon), mode);
      if (s.score >= minScore) all.push({ c, raw: one, score: s.score, basis: s.basis });
    }
  }
  all.sort((a, b) => b.score - a.score);
  const kept = [];
  const near = (a, b) => Math.abs(a.c.lat - b.c.lat) < 0.018 && Math.abs(a.c.lon - b.c.lon) < 0.018 / Math.cos((a.c.lat * Math.PI) / 180);
  for (const s of all) if (!kept.some((k) => near(k, s))) kept.push(s);
  return kept;
}
