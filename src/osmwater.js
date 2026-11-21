// Lakes from the OpenStreetMap water polygons in the basemap tiles.
//
// HydroLAKES only lists lakes of 10 ha or more, with coarse outlines, so many
// sandpit lakes, small reservoirs and city lakes are missing from it. The
// basemap already carries every OSM water polygon, so the lakes on screen are
// rebuilt from those tiles (which also works offline from saved tiles).
// Pure functions here; no browser APIs.

import polygonClipping from 'polygon-clipping';
import { bboxIntersects, bboxOf } from './geo.js';

// Water polygon kinds that are not lakes.
const NOT_LAKE = new Set(['ocean', 'sea', 'bay', 'strait', 'fjord', 'river', 'riverbank', 'canal', 'stream', 'ditch', 'drain', 'dock', 'swimming_pool', 'fountain', 'moat', 'wastewater', 'playa']);

/** Area of one ring in km² (small-area approximation, good to well under 1%). */
function ringKm2(ring, lat0) {
  const kx = 111.32 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110.54;
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    s += ring[j][0] * kx * (ring[i][1] * ky) - ring[i][0] * kx * (ring[j][1] * ky);
  }
  return Math.abs(s) / 2;
}

/** Area of a Polygon's coordinates (outer ring minus holes) in km². */
export function polygonKm2(poly) {
  const lat0 = poly[0][0][1];
  return poly.reduce((a, r, i) => a + (i ? -1 : 1) * ringKm2(r, lat0), 0);
}

function polysOf(g) {
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  return [];
}

/** Stable numeric id from position and size, kept clear of HydroLAKES ids. */
function osmId(lon, lat, a) {
  const s = `${lon.toFixed(3)},${lat.toFixed(3)},${Math.round(a * 20)}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return 1e9 + ((h >>> 0) % 1e9);
}

/**
 * Turn water features from vector tiles (clipped per tile, so one lake can come
 * in several pieces) into whole lakes. Lakes that run past `within` (the view)
 * are skipped, as they may be cut off. Returns GeoJSON lake features with
 * HydroLAKES-like properties: id, n (name), a (km²), src: 'osm'.
 */
export function lakesFromWater(features, within, minKm2 = 0.1) {
  const pieces = [];
  for (const f of features) {
    const kind = f.properties?.kind;
    if (kind && NOT_LAKE.has(kind)) continue;
    for (const poly of polysOf(f.geometry)) {
      if (!poly[0] || poly[0].length < 4) continue;
      pieces.push({ poly, bbox: bboxOf({ type: 'Polygon', coordinates: poly }), name: f.properties?.name || f.properties?.['name:en'] || null });
    }
  }
  // Group pieces whose boxes touch, and merge only those groups.
  const parent = pieces.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const order = pieces.map((_, i) => i).sort((a, b) => pieces[a].bbox[0] - pieces[b].bbox[0]);
  for (let ii = 0; ii < order.length; ii++) {
    const a = pieces[order[ii]];
    for (let jj = ii + 1; jj < order.length; jj++) {
      const b = pieces[order[jj]];
      if (b.bbox[0] > a.bbox[2] + 1e-6) break;
      if (bboxIntersects([a.bbox[0] - 1e-6, a.bbox[1] - 1e-6, a.bbox[2] + 1e-6, a.bbox[3] + 1e-6], b.bbox)) {
        parent[find(order[ii])] = find(order[jj]);
      }
    }
  }
  const groups = new Map();
  pieces.forEach((p, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(p);
  });

  const out = [];
  for (const g of groups.values()) {
    let polys;
    if (g.length === 1) polys = [g[0].poly];
    else {
      try {
        polys = polygonClipping.union(...g.map((p) => p.poly));
      } catch {
        polys = g.map((p) => p.poly);
      }
    }
    const name = g.find((p) => p.name)?.name || null;
    for (const poly of polys) {
      const a = polygonKm2(poly);
      if (a < minKm2) continue;
      const geometry = { type: 'Polygon', coordinates: poly };
      const b = bboxOf(geometry);
      if (within && (b[0] < within[0] || b[1] < within[1] || b[2] > within[2] || b[3] > within[3])) continue;
      const lon = (b[0] + b[2]) / 2;
      const lat = (b[1] + b[3]) / 2;
      out.push({
        type: 'Feature',
        geometry,
        properties: { id: osmId(lon, lat, a), n: name, a: Math.round(a * 1000) / 1000, src: 'osm' },
      });
    }
  }
  return out;
}

/** How much of box a's area is covered by box b (0..1). */
export function bboxOverlap(a, b) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.max(1e-12, (a[2] - a[0]) * (a[3] - a[1]));
}
