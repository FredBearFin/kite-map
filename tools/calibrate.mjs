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
import { PARAMS } from '../src/site.js';

// NO_DEPTH=1 scores without the sea-floor depth (the old model), for before/after.
if (process.env.NO_DEPTH) PARAMS.shallowAngle = null;

// expect: 'good' = established kite spot, 'poor' = not a kite spot.
const PLACES = [
  // Coasts, bays and lagoons (most kiting happens here)
  { name: 'Laguna Madre flats, TX', lat: 26.13, lon: -97.18, expect: 'good', coast: true },
  { name: 'Bird Island Basin, TX', lat: 27.475, lon: -97.31, expect: 'good', coast: true },
  { name: 'Cape Hatteras (Pamlico Sound), NC', lat: 35.3, lon: -75.52, expect: 'good', coast: true },
  { name: 'Jensen Beach Causeway, FL', lat: 27.21, lon: -80.21, expect: 'good', coast: true },
  { name: 'Crissy Field, CA', lat: 37.806, lon: -122.465, expect: 'good', coast: true },
  { name: 'Sherman Island, CA', lat: 38.04, lon: -121.79, expect: 'good', coast: true },
  { name: 'Kailua Beach, HI', lat: 21.4, lon: -157.73, expect: 'good', coast: true },
  { name: 'Cabarete, DR', lat: 19.765, lon: -70.41, expect: 'good', coast: true },
  { name: 'Cumbuco, BR', lat: -3.625, lon: -38.73, expect: 'good', coast: true },
  { name: 'Jericoacoara, BR', lat: -2.795, lon: -40.51, expect: 'good', coast: true },
  { name: 'Tarifa, ES', lat: 36.03, lon: -5.63, expect: 'good', coast: true },
  { name: 'Sotavento, Fuerteventura, ES', lat: 28.13, lon: -14.23, expect: 'good', coast: true },
  { name: 'Leucate, FR', lat: 42.91, lon: 3.05, expect: 'good', coast: true },
  { name: 'Brouwersdam, NL', lat: 51.765, lon: 3.85, expect: 'good', coast: true },
  { name: 'St. Peter-Ording, DE', lat: 54.31, lon: 8.6, expect: 'good', coast: true },
  { name: 'Prasonisi, Rhodes, GR', lat: 35.885, lon: 27.765, expect: 'good', coast: true },
  { name: 'Le Morne, Mauritius', lat: -20.455, lon: 57.315, expect: 'good', coast: true },
  { name: 'Langebaan Lagoon, ZA', lat: -33.1, lon: 18.03, expect: 'good', coast: true },
  { name: 'Bloubergstrand, ZA', lat: -33.805, lon: 18.46, expect: 'good', coast: true },
  { name: 'Kalpitiya Lagoon, LK', lat: 8.23, lon: 79.76, expect: 'good', coast: true },
  { name: 'Boracay (Bulabog), PH', lat: 11.96, lon: 121.935, expect: 'good', coast: true },
  { name: 'Hood River (Columbia), OR', lat: 45.715, lon: -121.52, expect: 'good', coast: true },
  { name: 'Lake Garda (Torbole), IT', lat: 45.87, lon: 10.875, expect: 'good', coast: true },
  // Lakes and rivers
  { name: 'West Okoboji Lake, IA', lat: 43.375, lon: -95.155, expect: 'good' },
  { name: 'Big Spirit Lake, IA', lat: 43.47, lon: -95.1, expect: 'good' },
  { name: 'Branched Oak Lake, NE', lat: 40.97, lon: -96.86, expect: 'good' },
  { name: 'Lake McConaughy, NE', lat: 41.25, lon: -101.72, expect: 'good' },
  { name: 'Lake Waconia, MN', lat: 44.865, lon: -93.785, expect: 'good' },
  { name: 'Lake Mendota, WI', lat: 43.105, lon: -89.42, expect: 'good' },
  { name: 'Lake Winnebago, WI', lat: 44.0, lon: -88.42, expect: 'good' },
  { name: 'Mille Lacs Lake, MN', lat: 46.23, lon: -93.65, expect: 'good' },
  { name: 'Cherry Creek Reservoir, CO', lat: 39.64, lon: -104.855, expect: 'good' },
  { name: 'Lake Pepin (Mississippi), MN', lat: 44.5, lon: -92.29, expect: 'good' },
  // Not kite spots. Coasts: cliffs, harbours, fjords, rocky and sheltered shores.
  { name: 'Big Sur cliffs, CA', lat: 36.27, lon: -121.835, expect: 'poor', coast: true },
  { name: 'Baltimore Inner Harbor, MD', lat: 39.284, lon: -76.608, expect: 'poor', coast: true },
  { name: 'Boston Inner Harbor, MA', lat: 42.36, lon: -71.045, expect: 'poor', coast: true },
  { name: 'Acadia rocky coast, ME', lat: 44.33, lon: -68.185, expect: 'poor', coast: true },
  { name: 'Hood Canal, WA', lat: 47.6, lon: -122.95, expect: 'poor', coast: true },
  { name: 'Geirangerfjord, NO', lat: 62.1, lon: 7.2, expect: 'poor', coast: true },
  { name: 'Monaco harbour, MC', lat: 43.735, lon: 7.425, expect: 'poor', coast: true },
  { name: 'Amalfi coast, IT', lat: 40.633, lon: 14.6, expect: 'poor', coast: true },
  { name: 'Missouri River at Omaha, NE', lat: 41.27, lon: -95.925, expect: 'poor', coast: true },
  { name: 'Mississippi River at St. Louis, MO', lat: 38.63, lon: -90.18, expect: 'poor', coast: true },
  // Lakes: small, narrow, wooded, urban or busy.
  { name: 'Lake of the Isles, MN', lat: 44.956, lon: -93.308, expect: 'poor' },
  { name: 'Lake Cunningham, NE', lat: 41.34, lon: -96.06, expect: 'poor' },
  { name: 'Zorinsky Lake, NE', lat: 41.24, lon: -96.18, expect: 'poor' },
  { name: 'Walden Pond, MA', lat: 42.44, lon: -71.337, expect: 'poor' },
  { name: 'Central Park Reservoir, NY', lat: 40.785, lon: -73.962, expect: 'poor' },
  { name: 'Lake of the Ozarks (Osage arm), MO', lat: 38.17, lon: -92.75, expect: 'poor' },
  { name: 'Table Rock Lake, MO', lat: 36.6, lon: -93.4, expect: 'poor' },
  { name: 'Smith Mountain Lake, VA', lat: 37.08, lon: -79.6, expect: 'poor' },
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

// WIND_SOURCE=era5 (reanalysis, about 30 km cells) or hires (archived
// forecasts from the best local weather model, a few km: catches sea breezes,
// lake breezes and valley winds that ERA5 smooths away).
const SOURCE = process.env.WIND_SOURCE || 'era5';
async function getWind(lat, lon, grid = 1) {
  const year = new Date().getUTCFullYear() - 1;
  const glat = grid ? Math.round(lat / grid) * grid : lat, glon = grid ? Math.round(lon / grid) * grid : lon;
  const host = SOURCE === 'hires' ? 'https://historical-forecast-api.open-meteo.com/v1/forecast' : 'https://archive-api.open-meteo.com/v1/archive';
  const url = `${host}?latitude=${glat.toFixed(4)}&longitude=${glon.toFixed(4)}&start_date=${year}-01-01&end_date=${year}-12-31` +
    `&hourly=wind_speed_10m,wind_direction_10m,temperature_2m&wind_speed_unit=kn&timezone=auto&timeformat=unixtime`;
  for (let a = 0; a < 4; a++) {
    // A network hiccup throws instead of returning an error status: retry it too.
    const r = await fetch(url).catch((e) => ({ ok: false, err: e }));
    if (!r.ok && r.status) console.log('  wind', r.status, (await r.text()).slice(0, 200));
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
  // Lakes: the water at the point, growing the box until the whole lake fits
  // (or until a shore shows up, for a point in the middle of a big lake).
  // Coasts, bays and rivers: the biggest water near the point, 12 km around.
  for (let km = p.coast ? 12 : 4; km <= 48; km *= 2) {
    const bbox = box(p.lon, p.lat, km);
    const inp = await gatherInputs(bbox, getTile, getDem, { maxTiles: 64 });
    raw = analyzeSite({ ...inp, bbox, point: [p.lon, p.lat], radiusM: p.coast ? 3000 : 60000, maxFetch: 15000, pickLargest: !!p.coast });
    if (p.coast) break;
    if (raw.ok && !raw.touchesEdge) break;
    if (!raw.ok && raw.reason !== 'no shoreline found') break;
  }
  const wind = await getWind(p.lat, p.lon, GRID);
  console.log(`  ${SOURCE} wind kiteable h/yr: ${wind?.kiteHours}`);
  const s = scoreSite(raw, wind, 'water');
  const sb = scoreSite(raw, wind, 'beginner');
  results.push({ ...p, raw, wind, score: s.score, beginner: sb.score });
  const shallowN = raw.cand?.filter((c) => c.depth && c.depth[0] != null && c.depth[0] <= 1.6 && c.depth[1] <= 1.6).length ?? 0;
  console.log(`\n${p.name} [${p.expect}] score ${s.score} (beginner ${sb.score}), ${raw.cand?.length ?? 0} launch points, water ${raw.waterKm2} km2, depth data ${raw.bathy ? 'yes' : 'no'}, shallow launches ${shallowN}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  for (const r of explain(s, raw)) console.log(`  ${r.kind.padEnd(4)} ${r.text}`);
}

// Accuracy: how often a real kite spot outscores a non-spot (1 = always), and
// how many places land on the right side of 50.
const good = results.filter((r) => r.expect === 'good'), poor = results.filter((r) => r.expect === 'poor');
let wins = 0;
for (const g of good) for (const b of poor) wins += g.score > b.score ? 1 : g.score === b.score ? 0.5 : 0;
const ranking = wins / (good.length * poor.length);
const right = results.filter((r) => (r.expect === 'good') === (r.score >= 50)).length;
console.log(`\nACCURACY ${SOURCE}${process.env.NO_DEPTH ? ' no-depth' : ''}: ranking ${(100 * ranking).toFixed(1)}% (a real spot beats a non-spot), ${right} of ${results.length} on the right side of 50`);
for (const [label, f] of [['coasts', (r) => r.coast], ['lakes', (r) => !r.coast]]) {
  const G = good.filter(f), B = poor.filter(f);
  let w = 0;
  for (const g of G) for (const b of B) w += g.score > b.score ? 1 : g.score === b.score ? 0.5 : 0;
  console.log(`  ${label}: ranking ${G.length && B.length ? ((100 * w) / (G.length * B.length)).toFixed(1) : '-'}%, ${G.length} spots, ${B.length} non-spots`);
}
console.log('\nSummary');
for (const r of [...results].sort((a, b) => b.score - a.score)) console.log(`${String(r.score).padStart(3)} ${String(r.beginner).padStart(3)}  ${r.expect.padEnd(4)}  ${r.name}`);
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(results));
