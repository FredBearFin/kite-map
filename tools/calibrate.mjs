// Calibration check for the spot scoring. Runs the same analysis as the app on
// real map, terrain and wind data for a few places whose kiting quality is
// known, and prints how they score. These places are never shown in the app;
// they only check that the algorithm ranks real kite spots above poor ones.
//
// Usage: node tools/calibrate.mjs [out.json]   (needs internet)

import fs from 'node:fs';
import { PMTiles } from 'pmtiles';
import { PNG } from 'pngjs';
import { analyzeSite } from '../src/site.js';
import { gatherInputs } from '../src/sitegather.js';
import { windStats } from '../src/scoring.js';
import { scoreSite, explain } from '../src/spotscore.js';

// expect: 'good' = established kite spot, 'poor' = not a kite spot.
const PLACES = [
  { name: 'West Okoboji Lake, IA', lat: 43.375, lon: -95.155, expect: 'good' },
  { name: 'Big Spirit Lake, IA', lat: 43.47, lon: -95.1, expect: 'good' },
  { name: 'Branched Oak Lake, NE', lat: 40.97, lon: -96.86, expect: 'good' },
  { name: 'Lake McConaughy, NE', lat: 41.25, lon: -101.72, expect: 'good' },
  { name: 'Lake Waconia, MN', lat: 44.865, lon: -93.785, expect: 'good' },
  { name: 'White Bear Lake, MN', lat: 45.08, lon: -92.985, expect: 'good' },
  { name: 'Bde Maka Ska, MN', lat: 44.948, lon: -93.311, expect: 'good' },
  { name: 'Lake Mendota, WI', lat: 43.105, lon: -89.42, expect: 'good' },
  { name: 'Lake Pepin (Mississippi), MN', lat: 44.5, lon: -92.29, expect: 'good' },
  { name: 'Laguna Madre flats, TX', lat: 26.13, lon: -97.18, expect: 'good', coast: true },
  { name: 'Bird Island Basin, TX', lat: 27.475, lon: -97.31, expect: 'good', coast: true },
  { name: 'Hood River (Columbia), OR', lat: 45.715, lon: -121.52, expect: 'good', coast: true },
  { name: 'Lake of the Isles, MN', lat: 44.956, lon: -93.308, expect: 'poor' },
  { name: 'Lake Cunningham, NE', lat: 41.34, lon: -96.06, expect: 'poor' },
  { name: 'Missouri River at Omaha, NE', lat: 41.27, lon: -95.925, expect: 'poor', coast: true },
];

const builds = await (await fetch('https://build-metadata.protomaps.dev/builds.json')).json();
const build = builds.map((b) => b.key).filter((k) => /^\d{8}\.pmtiles$/.test(k)).sort().pop();
const pm = new PMTiles('https://build.protomaps.com/' + build);
console.log('basemap', build);

const getTile = async (z, x, y) => {
  const r = await pm.getZxy(z, x, y);
  return r ? new Uint8Array(r.data) : null;
};
const getDem = async (z, x, y) => {
  const r = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`);
  if (!r.ok) return null;
  return PNG.sync.read(Buffer.from(await r.arrayBuffer())).data;
};

async function getWind(lat, lon, grid = 1) {
  const year = new Date().getUTCFullYear() - 1;
  const glat = grid ? Math.round(lat / grid) * grid : lat, glon = grid ? Math.round(lon / grid) * grid : lon;
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${glat}&longitude=${glon}&start_date=${year}-01-01&end_date=${year}-12-31` +
    `&hourly=wind_speed_10m,wind_direction_10m,temperature_2m&wind_speed_unit=kn&timezone=auto&timeformat=unixtime`;
  for (let a = 0; a < 4; a++) {
    const r = await fetch(url);
    if (r.ok) {
      const j = await r.json();
      const off = j.utc_offset_seconds || 0;
      const local = j.hourly.time.map((t) => new Date((t + off) * 1000));
      return windStats(j.hourly.wind_speed_10m, j.hourly.wind_direction_10m, local.map((d) => d.getUTCHours()), 1, local.map((d) => d.getUTCMonth()), j.hourly.temperature_2m);
    }
    await new Promise((r) => setTimeout(r, 20000));
  }
  return null;
}

const box = (lon, lat, km) => {
  const dLat = km / 110.54, dLon = km / (111.32 * Math.cos((lat * Math.PI) / 180));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
};

const GRID = +(process.env.WIND_GRID || 1);
const results = [];
for (const p of PLACES) {
  const t0 = Date.now();
  let raw = null;
  // Lakes: grow the box until the whole lake fits. Coasts and rivers: 12 km around.
  for (let km = p.coast ? 12 : 4; km <= 40; km *= 2) {
    const bbox = box(p.lon, p.lat, km);
    const inp = await gatherInputs(bbox, getTile, getDem, { maxTiles: 64 });
    raw = analyzeSite({ ...inp, bbox, point: [p.lon, p.lat], radiusM: p.coast ? 3000 : 60000, maxFetch: 15000, pickLargest: !p.coast });
    if (p.coast || !raw.ok || !raw.touchesEdge) break;
  }
  const wind = await getWind(p.lat, p.lon, GRID);
  const w1 = GRID === 1 ? wind : await getWind(p.lat, p.lon, 1);
  const w0 = await getWind(p.lat, p.lon, 0);
  console.log(`  wind kiteable h/yr: 1deg ${w1?.kiteHours}, ${GRID}deg ${wind?.kiteHours}, exact ${w0?.kiteHours}`);
  const s = scoreSite(raw, wind, 'water');
  const sb = scoreSite(raw, wind, 'beginner');
  results.push({ ...p, raw, wind, score: s.score, beginner: sb.score });
  console.log(`\n${p.name} [${p.expect}] score ${s.score} (beginner ${sb.score}), ${raw.cand?.length ?? 0} launch points, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  for (const r of explain(s, raw)) console.log(`  ${r.kind.padEnd(4)} ${r.text}`);
}

console.log('\nSummary');
for (const r of [...results].sort((a, b) => b.score - a.score)) console.log(`${String(r.score).padStart(3)} ${String(r.beginner).padStart(3)}  ${r.expect.padEnd(4)}  ${r.name}`);
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(results));
