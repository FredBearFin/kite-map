// Water colour of a lake, measured from the Sentinel-2 cloudless satellite
// mosaic (EOX). Clear, deep water looks dark blue or black; algae-rich water
// looks green; silty water looks brown. This is a rough signal, not a lab test.

import { backend } from './backend.js';
import { tileRange } from './geo.js';
import { lakeCenter, pointInLake } from './lakes.js';
import { fetchTile } from './tiles.js';

function pixelLonLat(z, x, y, px, py) {
  const n = 256 * 2 ** z;
  const X = (x * 256 + px + 0.5) / n;
  const Y = (y * 256 + py + 0.5) / n;
  const lon = X * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * Y))) * 180) / Math.PI;
  return [lon, lat];
}

/** Classify a mean RGB colour of open water. */
export function classifyWater([r, g, b]) {
  const bright = r + g + b;
  if (r > b * 1.15 && bright > 180) return 'murky';
  if (g > b * 1.12 && g >= r) return 'green';
  return 'clear';
}

let canvas = null;
async function decode(bytes) {
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  canvas ??= new OffscreenCanvas(256, 256);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, 256, 256);
  bmp.close?.();
  return ctx.getImageData(0, 0, 256, 256).data;
}

/**
 * Sample the lake's open water (pixels whose neighbours are also inside the
 * lake, so shoreline and beach pixels are skipped). Saves and returns
 * { color, rgb, n } or null if there was too little water to judge.
 */
export async function measureLake(f) {
  const p = f.properties;
  const key = 'water/' + p.id;
  const saved = await backend.kvGet(key);
  if (saved) return saved;
  lakeCenter(f);
  const b = p._bbox;
  // Pick a zoom where the lake covers at most about 4 tiles.
  let z = 13;
  for (; z > 8; z--) {
    const r = tileRange(b, z);
    if ((r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1) <= 4) break;
  }
  const r = tileRange(b, z);
  let sr = 0, sg = 0, sb = 0, n = 0;
  const step = 3; // pixels
  for (let x = r.x0; x <= r.x1; x++) {
    for (let y = r.y0; y <= r.y1; y++) {
      const bytes = await fetchTile('sat', z, x, y);
      if (!bytes?.length) continue;
      const data = await decode(bytes);
      for (let py = step; py < 256 - step; py += step) {
        for (let px = step; px < 256 - step; px += step) {
          const [lon, lat] = pixelLonLat(z, x, y, px, py);
          if (!pointInLake(f, lon, lat)) continue;
          const [l1, t1] = pixelLonLat(z, x, y, px - step, py - step);
          const [l2, t2] = pixelLonLat(z, x, y, px + step, py + step);
          if (!pointInLake(f, l1, t1) || !pointInLake(f, l2, t2) || !pointInLake(f, l1, t2) || !pointInLake(f, l2, t1)) continue;
          const i = (py * 256 + px) * 4;
          sr += data[i];
          sg += data[i + 1];
          sb += data[i + 2];
          n++;
        }
      }
    }
  }
  if (n < 6) return null;
  const rgb = [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)];
  const res = { color: classifyWater(rgb), rgb, n };
  await backend.kvSet(key, res);
  return res;
}

/** Attach saved colours to features (no network). */
export async function attachWaterColors(features) {
  const rows = await backend.kvList('water/');
  const map = new Map(rows.map(([k, v]) => [k.slice(6), v]));
  for (const f of features) {
    const w = map.get(String(f.properties.id));
    if (w) {
      f.properties.wc = w.color;
      f.properties.wrgb = w.rgb;
    }
  }
}
