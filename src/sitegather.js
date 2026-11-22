// Collect the inputs for analyzeSite() from basemap vector tiles and terrain
// tiles. The tile getters are passed in, so the app (saved tiles, offline) and
// the calibration script (network) share this code.

import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import { tileRange } from './geo.js';
import { coverHeight } from './site.js';

const NOT_WATER = new Set(['swimming_pool', 'fountain', 'wastewater', 'playa']);
const RIVER = new Set(['river', 'riverbank', 'canal', 'stream']);
const NO_ROAD = new Set(['path', 'rail', 'ferry', 'aerialway']);

function polys(geom) {
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  return [];
}
function lines(geom) {
  if (geom.type === 'LineString') return [geom.coordinates];
  if (geom.type === 'MultiLineString') return geom.coordinates;
  return [];
}

/** Pick a zoom (z1 down to z0) where the box needs at most maxTiles tiles. */
export function zoomFor(bbox, z1, z0, maxTiles) {
  let z = z1;
  for (; z > z0; z--) {
    const r = tileRange(bbox, z);
    if ((r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1) <= maxTiles) break;
  }
  return z;
}

const BEACH = new Set(['beach', 'sand', 'dune']);
const ROCK = new Set(['bare_rock', 'rock', 'cliff', 'scree']);

/** Decode one basemap tile into water, cover and road features (lon/lat). */
export function tileFeatures(bytes, z, x, y, out) {
  if (!bytes || !bytes.length) return out;
  const vt = new VectorTile(new Pbf(bytes));
  const each = (name, fn) => {
    const L = vt.layers[name];
    if (!L) return;
    for (let i = 0; i < L.length; i++) {
      const f = L.feature(i);
      fn(f.toGeoJSON(x, y, z), f.properties);
    }
  };
  each('water', (gj, p) => {
    if (NOT_WATER.has(p.kind)) return;
    for (const poly of polys(gj.geometry)) out.water.push({ poly, river: RIVER.has(p.kind) });
  });
  for (const layer of ['landcover', 'landuse', 'natural']) {
    each(layer, (gj, p) => {
      // Sand beaches are where kites launch; bare rock and cliffs are not.
      if (BEACH.has(p.kind)) for (const poly of polys(gj.geometry)) (out.beach ||= []).push(poly);
      if (ROCK.has(p.kind)) for (const poly of polys(gj.geometry)) (out.rock ||= []).push(poly);
      const hc = coverHeight(p.kind);
      if (!hc || !hc[0]) return;
      for (const poly of polys(gj.geometry)) out.cover.push({ poly, h: hc[0], code: hc[1] });
    });
  }
  each('buildings', (gj, p) => {
    const h = Math.min(60, Math.max(4, Math.round(+p.height || 8)));
    for (const poly of polys(gj.geometry)) out.cover.push({ poly, h, code: 2 });
  });
  each('roads', (gj, p) => {
    if (NO_ROAD.has(p.kind)) return;
    for (const l of lines(gj.geometry)) out.roads.push(l);
  });
  return out;
}

/** Terrarium elevation from RGBA pixels. */
const terrarium = (d, k) => d[k] * 256 + d[k + 1] + d[k + 2] / 256 - 32768;

/**
 * getTile(z, x, y) -> Uint8Array of the vector tile, or null.
 * getDem(z, x, y) -> RGBA pixels (256x256) of the terrain tile, or null.
 */
export async function gatherInputs(bbox, getTile, getDem, { maxTiles = 36 } = {}) {
  const out = { water: [], cover: [], roads: [], beach: [], rock: [], tiles: 0, missing: 0 };
  const z = zoomFor(bbox, 13, 8, maxTiles);
  const r = tileRange(bbox, z);
  const jobs = [];
  for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) jobs.push([x, y]);
  await Promise.all(jobs.map(async ([x, y]) => {
    let bytes = null;
    try { bytes = await getTile(z, x, y); } catch {}
    if (bytes?.length) { out.tiles++; tileFeatures(bytes, z, x, y, out); } else out.missing++;
  }));

  out.dem = null;
  if (getDem) {
    const dz = zoomFor(bbox, Math.min(z, 12), 7, maxTiles);
    const dr = tileRange(bbox, dz);
    const tiles = new Map();
    const djobs = [];
    for (let x = dr.x0; x <= dr.x1; x++) for (let y = dr.y0; y <= dr.y1; y++) djobs.push([x, y]);
    await Promise.all(djobs.map(async ([x, y]) => {
      try {
        const px = await getDem(dz, x, y);
        if (px) tiles.set(x + ',' + y, px);
      } catch {}
    }));
    if (tiles.size) {
      const n = 2 ** dz;
      out.dem = (lon, lat) => {
        const X = ((lon + 180) / 360) * n;
        const s = Math.sin((lat * Math.PI) / 180);
        const Y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
        const tx = Math.floor(X), ty = Math.floor(Y);
        const d = tiles.get(tx + ',' + ty);
        if (!d) return null;
        const px = Math.min(255, Math.floor((X - tx) * 256)), py = Math.min(255, Math.floor((Y - ty) * 256));
        return terrarium(d, (py * 256 + px) * 4);
      };
    }
  }
  return out;
}
