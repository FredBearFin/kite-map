// Geometry helpers: tile math, distances, and the open-water "fetch" of a lake.
// Pure functions with no browser APIs, so they can be unit tested in Node.

export const DIRS16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export function lon2tile(lon, z) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

export function lat2tile(lat, z) {
  const r = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

/** Tile x/y ranges covering bbox [west, south, east, north] at zoom z. */
export function tileRange(bbox, z) {
  const n = 2 ** z;
  const clamp = (v) => Math.max(0, Math.min(n - 1, v));
  return {
    x0: clamp(lon2tile(bbox[0], z)),
    x1: clamp(lon2tile(bbox[2], z)),
    y0: clamp(lat2tile(bbox[3], z)),
    y1: clamp(lat2tile(bbox[1], z)),
  };
}

export function countTiles(bbox, z) {
  const r = tileRange(bbox, z);
  return (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);
}

/** Yields [z, x, y] for every tile covering bbox at zoom z. */
export function* tilesIn(bbox, z) {
  const r = tileRange(bbox, z);
  for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) yield [z, x, y];
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR;
  const dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** All rings of a GeoJSON Polygon or MultiPolygon. */
export function ringsOf(geometry) {
  if (geometry.type === 'Polygon') return geometry.coordinates;
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat();
  return [];
}

export function bboxOf(geometry) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const ring of ringsOf(geometry)) {
    for (const [x, y] of ring) {
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
    }
  }
  return [w, s, e, n];
}

export function bboxIntersects(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

export function bufferBbox(b, km) {
  const dLat = km / 110.54;
  const dLon = km / (111.32 * Math.max(0.05, Math.cos((((b[1] + b[3]) / 2) * Math.PI) / 180)));
  return [b[0] - dLon, b[1] - dLat, b[2] + dLon, b[3] + dLat];
}

/**
 * Longest straight run of open water across the lake, for each of 8 axes
 * (0 = north-south, 1 = 22.5 deg, ... 7 = 157.5 deg). Islands break a run.
 * Returns metres. `lines` is how many parallel scan lines are tried per axis.
 */
export function fetchByAxis(geometry, lines = 24) {
  const rings = ringsOf(geometry);
  const [w, s, e, n] = bboxOf(geometry);
  const lat0 = (s + n) / 2;
  const lon0 = (w + e) / 2;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110540;
  const pts = rings.map((r) => r.map(([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * ky]));
  const out = new Array(8).fill(0);
  for (let a = 0; a < 8; a++) {
    const ang = (a * 22.5 * Math.PI) / 180;
    const sa = Math.sin(ang);
    const ca = Math.cos(ang);
    // u runs along the axis (compass bearing ang), v across it.
    const rot = pts.map((r) => r.map(([x, y]) => [x * sa + y * ca, x * ca - y * sa]));
    let vmin = Infinity, vmax = -Infinity;
    for (const r of rot) for (const p of r) {
      if (p[1] < vmin) vmin = p[1];
      if (p[1] > vmax) vmax = p[1];
    }
    let best = 0;
    for (let i = 0; i < lines; i++) {
      const c = vmin + ((i + 0.5) / lines) * (vmax - vmin);
      const xs = [];
      for (const r of rot) {
        for (let j = 0, k = r.length - 1; j < r.length; k = j++) {
          const [u1, v1] = r[k];
          const [u2, v2] = r[j];
          if ((v1 <= c) !== (v2 <= c)) xs.push(u1 + ((c - v1) * (u2 - u1)) / (v2 - v1));
        }
      }
      xs.sort((p, q) => p - q);
      for (let j = 0; j + 1 < xs.length; j += 2) best = Math.max(best, xs[j + 1] - xs[j]);
    }
    out[a] = Math.round(best);
  }
  return out;
}

/** Map a 16-point direction index to its 8-axis index. */
export function axisOfDir(d16) {
  return d16 % 8;
}

/**
 * How well the lake suits wind from direction d16 (0..1).
 * Needs a long clear run along the wind (clean, steady wind and room to go
 * downwind) and enough width across the wind to ride back and forth.
 */
export function dirSuitability(fetch8, d16, opts = {}) {
  const along = fetch8[axisOfDir(d16)];
  const across = fetch8[axisOfDir(d16 + 4)];
  const needAlong = opts.needAlong ?? 1500;
  const needAcross = opts.needAcross ?? 800;
  return Math.min(1, along / needAlong) * Math.min(1, across / needAcross);
}

export function dirIndex(deg) {
  return Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
}
