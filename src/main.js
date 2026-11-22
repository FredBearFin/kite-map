import './style.css';
import maplibregl from 'maplibre-gl';
import { layers, namedFlavor } from '@protomaps/basemaps';
import { backend } from './backend.js';
import { DIRS16, bboxIntersects, bboxOf } from './geo.js';
import { lakesFromWater, bboxOverlap } from './osmwater.js';
import { bestDirs, estimateDriveHours, iceMonths } from './scoring.js';
import { registerProtocol, glyphsTemplate, assetUrl, ASSETS, status, tileTemplate, initBasemap, prefetchWorld } from './tiles.js';
import { HYDROLAKES_PAGE, HYDROLAKES_URL, lakeIndex, lakeSites, downloadWind, windCellKey, cellsFor, distanceFromHome, driveRoute, filterBbox, forecast, forecastMany, getWind, lakeCenter, loadCell, pointInLake, scoreFeatures } from './lakes.js';
import { analyzeLake, analyzePoint, boxesIn, pickSpots, scanBox } from './siteapp.js';
import { explain, launches, scoreSite, angleWord } from './spotscore.js';
import { enterSpotView, spotViewControl } from './spotview.js';
import { forecastDays, windowText } from './forecastscore.js';
import { accessKey, accessReasons, fetchAccess } from './access.js';
import { attachWaterColors } from './watercolor.js';
import { downloadRegion, estimate, DEFAULTS } from './download.js';

const $ = (id) => document.getElementById(id);
const OMAHA = { lat: 41.2565, lon: -95.9345, name: 'Omaha' };

const state = {
  home: OMAHA, // the current starting point
  origins: [OMAHA],
  mode: 'water',
  lakes: [], // scored features from all downloaded regions
  byId: new Map(),
  regions: [],
  saved: [],
  drawBox: null,
  downloading: null,
};

// ---------- Map ----------

registerProtocol();
// Pick the basemap build first (instant when it was checked in the last week).
await Promise.race([initBasemap(), new Promise((r) => setTimeout(r, 4000))]);

function buildStyle() {
  const base = layers('protomaps', namedFlavor('light'), { lang: 'en' });
  const waterIdx = base.findIndex((l) => l.id === 'water');
  const extra = [
    { id: 'geology', type: 'raster', source: 'geo', paint: { 'raster-opacity': 0.45 }, layout: { visibility: 'none' } },
    {
      id: 'hillshade',
      type: 'hillshade',
      source: 'dem',
      paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#4a5560', 'hillshade-highlight-color': '#ffffff' },
    },
  ];
  base.splice(waterIdx, 0, ...extra);
  // Satellite imagery sits above the base map fills, below roads and labels.
  const roadsIdx = base.findIndex((l) => l.id.startsWith('roads'));
  base.splice(roadsIdx < 0 ? base.length : roadsIdx, 0, { id: 'satellite', type: 'raster', source: 'sat', layout: { visibility: 'none' } });
  return {
    version: 8,
    glyphs: glyphsTemplate(),
    sprite: assetUrl(ASSETS.sprite),
    sources: {
      protomaps: {
        type: 'vector',
        tiles: [tileTemplate('osm')],
        maxzoom: 14,
        attribution: '© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>, Protomaps',
      },
      dem: { type: 'raster-dem', tiles: [tileTemplate('dem')], tileSize: 256, maxzoom: 12, encoding: 'terrarium' },
      geo: { type: 'raster', tiles: [tileTemplate('geo')], tileSize: 256, maxzoom: 12, attribution: 'Macrostrat' },
      sat: {
        type: 'raster',
        tiles: [tileTemplate('sat')],
        tileSize: 256,
        maxzoom: 14,
        attribution: '<a href="https://s2maps.eu">Sentinel-2 cloudless 2024</a> by EOX (modified Copernicus Sentinel data)',
      },
    },
    layers: base,
  };
}

const map = new maplibregl.Map({
  container: 'map',
  style: buildStyle(),
  center: [OMAHA.lon, OMAHA.lat],
  zoom: 6,
  attributionControl: { compact: true, customAttribution: 'HydroLAKES, Open-Meteo / ERA5' },
});
map.addControl(new maplibregl.NavigationControl(), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-right');

const SCORE_COLOR = ['interpolate', ['linear'], ['get', 'score'], 0, '#9fb3c8', 40, '#f2c14e', 70, '#f78154', 90, '#d7263d'];
function scoreColor(s) {
  if (s >= 90) return '#d7263d';
  if (s >= 70) return '#f78154';
  if (s >= 40) return '#e0a92e';
  return '#8aa0b6';
}

map.once('style.load', () => {
  map.addSource('lakes', { type: 'geojson', data: fc([]), promoteId: 'id' });
  map.addLayer({ id: 'lake-fill', type: 'fill', source: 'lakes', paint: { 'fill-color': SCORE_COLOR, 'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.85, 0.6] } });
  map.addLayer({ id: 'lake-line', type: 'line', source: 'lakes', paint: { 'line-color': '#1d4f6e', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.3, 12, 1.5] } });
  map.addLayer({
    id: 'lake-score',
    type: 'symbol',
    source: 'lakes',
    minzoom: 8,
    filter: ['>=', ['get', 'score'], 40],
    layout: { 'text-field': ['to-string', ['get', 'score']], 'text-font': ['Noto Sans Medium'], 'text-size': 12 },
    paint: { 'text-color': '#1d2733', 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
  });
  map.addSource('regions', { type: 'geojson', data: fc([]) });
  map.addLayer({ id: 'region-line', type: 'line', source: 'regions', paint: { 'line-color': '#12658f', 'line-width': 1.5, 'line-dasharray': [3, 2] } });
  map.addSource('draw', { type: 'geojson', data: fc([]) });
  map.addLayer({ id: 'draw-fill', type: 'fill', source: 'draw', paint: { 'fill-color': '#12658f', 'fill-opacity': 0.1 } });
  map.addLayer({ id: 'draw-line', type: 'line', source: 'draw', paint: { 'line-color': '#12658f', 'line-width': 2 } });
  map.addSource('saved', { type: 'geojson', data: fc([]) });
  map.addLayer({ id: 'saved-pt', type: 'circle', source: 'saved', paint: { 'circle-radius': 7, 'circle-color': '#7b2cbf', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  // Launch spots found by the shore analysis (lakes, coasts, bays, rivers).
  map.addSource('spots', { type: 'geojson', data: fc([]) });
  map.addLayer({
    id: 'spot-pt', type: 'circle', source: 'spots', minzoom: 8,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 5, 13, 10],
      // With a forecast day picked: green = go, yellow = maybe, grey = no.
      'circle-color': ['match', ['coalesce', ['get', 'fc'], ''], 'go', '#2a9d55', 'maybe', '#f2c14e', 'no', '#aab4bf', SCORE_COLOR],
      'circle-stroke-color': ['match', ['get', 'access'], 'no', '#c62828', 'limited', '#b26a00', '#fff'],
      'circle-stroke-width': ['match', ['get', 'access'], 'no', 3, 'limited', 2.5, 1.5],
    },
  });
  map.addLayer({
    id: 'spot-label', type: 'symbol', source: 'spots', minzoom: 10,
    layout: { 'text-field': ['coalesce', ['get', 'fcText'], ['to-string', ['get', 'score']]], 'text-font': ['Noto Sans Medium'], 'text-size': 10, 'text-allow-overlap': true },
    paint: { 'text-color': '#1d2733' },
  });
  // Best launch points of the lake or spot that is open.
  map.addSource('launch', { type: 'geojson', data: fc([]) });
  map.addLayer({ id: 'launch-pt', type: 'circle', source: 'launch', paint: { 'circle-radius': 7, 'circle-color': '#2a9d55', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  map.addLayer({
    id: 'launch-label', type: 'symbol', source: 'launch',
    layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Medium'], 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top' },
    paint: { 'text-color': '#1c6b3a', 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
  });
  map.addSource('home', { type: 'geojson', data: fc([]) });
  map.addLayer({ id: 'home-pt', type: 'circle', source: 'home', paint: { 'circle-radius': 6, 'circle-color': '#1d2733', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  init().catch((e) => toast('Startup problem: ' + e));
});

const fc = (features) => ({ type: 'FeatureCollection', features });
const boxFeature = (b) => ({
  type: 'Feature',
  properties: {},
  geometry: { type: 'Polygon', coordinates: [[[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]]] },
});

// ---------- Startup ----------

async function init() {
  const oldHome = await backend.kvGet('home');
  state.origins = await backend.kvGet('origins', oldHome ? [{ ...oldHome, id: 'home', name: 'Home' }] : [{ ...OMAHA, id: 'omaha' }]);
  const oid = await backend.kvGet('originId');
  state.home = state.origins.find((o) => o.id === oid) || state.origins[0];
  state.mode = await backend.kvGet('mode', 'water');
  $('f-mode').value = state.mode;
  renderOrigins();
  state.saved = await backend.kvGet('saved', []);
  const view = await backend.kvGet('view');
  if (view) map.jumpTo(view);
  map.on('moveend', () => {
    backend.kvSet('view', { center: map.getCenter().toArray(), zoom: map.getZoom() });
    if ($('f-view').checked) renderSpots();
    refreshView();
    needOsm = true;
  });
  // Once the tiles in view have loaded, pick up the lakes drawn on them.
  let needOsm = true;
  map.on('idle', () => {
    if (!needOsm) return;
    needOsm = false;
    addOsmLakes()
      .catch((e) => console.warn('osm lakes', e))
      .then(() => analyzeLakesInView())
      .then(() => scanView());
  });
  await loadRegions();
  renderHome();
  renderSaved();
  state.fcData = await backend.kvGet('forecast/last');
  renderForecast();
  $('folder').textContent = 'Data folder: ' + (await backend.dataFolder());
  await renderLakeDb();
  await renderWorld();
  const planet = backend.isTauri ? await backend.call('planet_status').catch(() => null) : null;
  if (navigator.onLine && !planet?.complete) prefetchWorld();
  if (!(await lakeIndex())) {
    switchTab('regions');
    toast('Welcome! First set up the lake database: click "Import lake zip" and choose HydroLAKES_polys_v10_shp.zip.', 10000);
  } else if (!state.regions.length) {
    switchTab('regions');
    toast('Now download an area: click "Draw area" and drag a box around the lakes you want to explore.', 9000);
  }
}

// Lakes are loaded by 10-degree cell from the local lake database: every
// cell in view, plus the cells of downloaded regions.
const MIN_AREA = 0.25; // km² (the import keeps HydroLAKES lakes from 0.25 km²)
const MIN_OSM_AREA = 0.1; // km², about 300 x 330 m: the smallest water worth a look
const osmLakes = new Map(); // id -> lake built from OpenStreetMap water in the basemap
const loadedCells = new Map(); // cell -> features
let loadingCells = false;

async function ensureCells(cells) {
  const missing = cells.filter((c) => !loadedCells.has(c));
  if (!missing.length || loadingCells) return false;
  loadingCells = true;
  try {
    for (const cell of missing) {
      setBanner(`Loading lakes (${cell.toUpperCase()})...`);
      const feats = (await loadCell(cell)).filter((f) => f.properties.a >= MIN_AREA);
      await attachWaterColors(feats);
      await scoreFeatures(feats, state.mode);
      loadedCells.set(cell, feats);
    }
  } finally {
    loadingCells = false;
  }
  publishLakes();
  return true;
}

function publishLakes() {
  state.lakes = [...loadedCells.values()].flat().concat([...osmLakes.values()]);
  state.byId = new Map(state.lakes.map((f) => [f.properties.id, f]));
  map.getSource('lakes')?.setData(fc(state.lakes));
  renderSpots();
}

const sameLake = (a, b) => bboxOverlap(a, b) > 0.5 && bboxOverlap(b, a) > 0.5;

function setShape(f, geometry, z) {
  f.geometry = geometry;
  for (const k of ['_fetch', '_bbox', '_c']) delete f.properties[k];
  f.properties._z = z;
  lakeCenter(f);
}

/**
 * Add every lake drawn on the basemap in view (OpenStreetMap water), not just
 * the HydroLAKES ones: sandpits, small reservoirs and city lakes. A lake that is
 * also in HydroLAKES keeps its HydroLAKES data but gets the sharper OSM outline.
 */
let osmBusy = false;
async function addOsmLakes() {
  const z = Math.floor(map.getZoom());
  if (osmBusy || z < 9 || !map.getSource('protomaps')) return;
  osmBusy = true;
  try {
    const raw = map.querySourceFeatures('protomaps', { sourceLayer: 'water' });
    const found = lakesFromWater(raw, viewBbox(), MIN_OSM_AREA);
    const hydro = [...loadedCells.values()].flat();
    const fresh = [];
    for (const f of found) {
      const fb = bboxOf(f.geometry);
      const h = hydro.find((h) => sameLake(lakeCenter(h) && h.properties._bbox, fb));
      if (h) {
        if ((h.properties._z ?? -1) < z) {
          setShape(h, f.geometry, z);
          fresh.push(h);
        }
        continue;
      }
      let skip = false;
      for (const [id, o] of osmLakes) {
        if (!sameLake(o.properties._bbox, fb)) continue;
        if (o.properties._z >= z) skip = true;
        else osmLakes.delete(id);
      }
      if (skip) continue;
      lakeCenter(f);
      f.properties._z = z;
      osmLakes.set(f.properties.id, f);
      fresh.push(f);
    }
    if (!fresh.length) return;
    await attachWaterColors(fresh);
    await scoreFeatures(fresh, state.mode);
    publishLakes();
    autoWind();
  } finally {
    osmBusy = false;
  }
}

async function rescoreAll() {
  await scoreFeatures(state.lakes, state.mode);
  refreshSpots();
  map.getSource('lakes')?.setData(fc(state.lakes));
  renderSpots();
}

function viewBbox() {
  const b = map.getBounds();
  return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
}

/** Load lakes for what's on screen, and wind for it when online. */
async function refreshView() {
  const idx = await lakeIndex();
  if (!idx) return setBanner('Showing the lakes drawn on the map. For depth data and lakes at every zoom, go to Regions and click "Import lake zip".', 'regions');
  if (map.getZoom() < 5) return setBanner('Zoom in to see lakes and their kite scores.');
  const cells = cellsFor(viewBbox()).filter((c) => idx.cells[c]);
  if (cells.length > 6) return setBanner('Zoom in a little more to load lakes.');
  await ensureCells(cells);
  setBanner(null);
  autoWind();
}

let windBusy = false;
/** When online, fetch wind history for the lakes on screen (a few points at a time). */
async function autoWind() {
  if (windBusy || !navigator.onLine || map.getZoom() < 7) return;
  const vb = viewBbox();
  const pts = new Set();
  for (const f of state.lakes) {
    if (f.properties.basis !== 'shape' || f.properties.a < 0.2) continue;
    const [lon, lat] = lakeCenter(f);
    if (lon >= vb[0] && lon <= vb[2] && lat >= vb[1] && lat <= vb[3]) pts.add(windCellKey(lat, lon));
    if (pts.size >= 24) break;
  }
  if (!pts.size) return;
  windBusy = true;
  try {
    await downloadWind([...pts], (d, t) => setBanner(`Getting wind history for this area: ${d} of ${t} points...`), null, { retries: 0 });
    await rescoreAll();
  } catch {
  } finally {
    windBusy = false;
    setBanner(null);
  }
}

function setBanner(text, tab) {
  const el = $('banner');
  if (!text) return void (el.hidden = true);
  el.textContent = text;
  el.hidden = false;
  el.onclick = tab ? () => switchTab(tab) : null;
  el.style.cursor = tab ? 'pointer' : '';
}

async function loadRegions() {
  state.regions = (await backend.kvList('region/')).map(([, v]) => v).sort((a, b) => a.downloaded - b.downloaded);
  loadedCells.clear();
  const cells = new Set(state.regions.flatMap((r) => cellsFor(r.bbox)));
  if (await lakeIndex()) await ensureCells([...cells]);
  else {
    state.lakes = [];
    state.byId = new Map();
    map.getSource('lakes')?.setData(fc([]));
    renderSpots();
  }
  map.getSource('regions')?.setData(fc(state.regions.map((r) => boxFeature(r.bbox))));
  renderRegions();
  await refreshView();
}

// ---------- Tabs ----------

function switchTab(name) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
}
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

// ---------- Spots list ----------

const fmtKm = (km) => (km < 10 ? km.toFixed(1) : Math.round(km)) + ' km';
const fmtMi = (km) => Math.round(km * 0.621) + ' mi';
const lakeName = (p) => p.n || (p.t === 2 ? 'Unnamed reservoir' : 'Unnamed lake');

function renderSpots() {
  const minA = +$('f-area').value;
  const maxH = +$('f-drive').value;
  const q = $('f-name').value.trim().toLowerCase();
  const inView = $('f-view').checked;
  const b = map.getBounds();
  const vb = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  const list = state.lakes
    .filter((f) => f.properties.a >= minA)
    .filter((f) => !q || (f.properties.n || '').toLowerCase().includes(q))
    .filter((f) => !inView || bboxIntersects(f.properties._bbox, vb))
    .map((f) => ({ f, d: distanceFromHome(f, state.home) }))
    .filter((x) => estimateDriveHours(x.d) <= maxH)
    .sort((a, b) => b.f.properties.score - a.f.properties.score)
    .slice(0, 150);
  const ol = $('spot-list');
  ol.innerHTML = '';
  // Launch spots on coasts, bays and rivers (lake shores are covered by the lakes).
  const shoreSpots = (state.spots || [])
    .filter((sp) => !inView || (sp.c.lon >= vb[0] && sp.c.lon <= vb[2] && sp.c.lat >= vb[1] && sp.c.lat <= vb[3]))
    .filter((sp) => !q && !state.lakes.some((f) => pointInLake(f, sp.c.lon, sp.c.lat)))
    .map((sp) => ({ sp, d: distanceFromHome({ properties: { _c: [sp.c.lon, sp.c.lat] } }, state.home) }))
    .filter((x) => estimateDriveHours(x.d) <= maxH)
    .slice(0, 40);
  const rows = [...list.map((x) => ({ ...x, score: x.f.properties.score })), ...shoreSpots.map((x) => ({ ...x, score: x.sp.score }))].sort((a, b) => b.score - a.score);
  for (const r of rows) {
    if (r.sp) {
      const { sp, d } = r;
      const li = document.createElement('li');
      li.innerHTML = `<div class="score" style="background:${scoreColor(sp.score)}">${sp.score}</div>
        <div class="grow"><div class="name">${sp.c.river ? 'River launch' : 'Shore launch'}</div>
        <div class="sub">Shore facing ${sp.c.face} · ~${fmtH(estimateDriveHours(d))} drive</div></div>`;
      li.addEventListener('click', () => {
        map.flyTo({ center: [sp.c.lon, sp.c.lat], zoom: Math.max(map.getZoom(), 12) });
        showSpotPopup(sp.raw, sp.c.lon, sp.c.lat, 'Launch spot');
      });
      ol.appendChild(li);
      continue;
    }
    const { f, d } = r;
    const p = f.properties;
    const li = document.createElement('li');
    li.innerHTML = `<div class="score" style="background:${scoreColor(p.score)}">${p.score}</div>
      <div class="grow"><div class="name"></div>
      <div class="sub">${p.a.toFixed(1)} km² · ~${fmtH(estimateDriveHours(d))} drive${p.eff != null ? ` · ${p.eff} good hrs/yr` : ''}${p.wc === 'green' ? ' · green water' : p.wc === 'murky' ? ' · murky' : ''}</div></div>`;
    li.querySelector('.name').textContent = lakeName(p);
    li.addEventListener('click', () => focusLake(f));
    ol.appendChild(li);
  }
  $('spots-hint').textContent = state.lakes.length
    ? `${list.length} of ${state.lakes.length} lakes shown, best first, from ${state.home.name}.` +
      (state.mode === 'snow' ? ' Snowkite mode ranks lakes by open space and wind in months when they are likely frozen.' : '') +
      (state.mode === 'beginner' ? ' Beginner mode counts only lighter 12 to 22 kn wind.' : '')
    : 'No lakes loaded. Import the lake database in the Regions tab, then zoom the map to any area.';
}
['f-area', 'f-drive', 'f-name', 'f-view'].forEach((id) => $(id).addEventListener('input', renderSpots));
$('f-mode').addEventListener('change', async () => {
  state.mode = $('f-mode').value;
  await backend.kvSet('mode', state.mode);
  await rescoreAll();
});

const fmtH = (h) => (h < 1 ? Math.round(h * 60) + ' min' : h.toFixed(1).replace('.0', '') + ' h');
const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

function monthSvg(wind) {
  if (!wind?.byMonth) return '';
  const ice = iceMonths(wind);
  const max = Math.max(1, ...wind.byMonth);
  const W = 300, H = 70, bw = W / 12;
  let bars = '';
  wind.byMonth.forEach((v, m) => {
    const h = (v / max) * (H - 24);
    const x = m * bw + 2;
    bars += `<rect x="${x}" y="${H - 14 - h}" width="${bw - 4}" height="${h}" rx="2" fill="${ice.includes(m) ? '#7fb8e6' : '#12658f'}"><title>${v} kiteable hrs</title></rect>`;
    bars += `<text x="${x + (bw - 4) / 2}" y="${H - 3}" font-size="10" text-anchor="middle" fill="#5b6b7c">${MONTHS[m]}</text>`;
    if (ice.includes(m)) bars += `<text x="${x + (bw - 4) / 2}" y="${H - 16 - h}" font-size="10" text-anchor="middle">❄</text>`;
  });
  return `<div class="sub" style="margin-top:6px">Kiteable daylight hours by month${ice.length ? ' (❄ likely frozen, from air temperature)' : ''}</div>
    <svg width="100%" viewBox="0 0 ${W} ${H}">${bars}</svg>`;
}

/** Fill a popup element with the real road drive time when online. */
async function fillDrive(el, lon, lat) {
  const span = el.querySelector('.drive');
  if (!span) return;
  try {
    const r = await driveRoute(state.home, [lon, lat]);
    span.textContent = `${fmtH(r.hours)} drive (${Math.round(r.km * 0.621)} mi by road) from ${state.home.name}`;
  } catch {}
}

function focusLake(f) {
  const b = f.properties._bbox;
  map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 80, maxZoom: 13, duration: 800 });
  map.once('moveend', () => showLakePopup(f, lakeCenter(f)));
}

// ---------- Lake popup ----------

function roseSvg(wind, suit, size = 120) {
  const max = wind ? Math.max(1, ...wind.byDir) : 1;
  const c = size / 2;
  let petals = '';
  for (let d = 0; d < 16; d++) {
    const v = wind ? wind.byDir[d] / max : 0.6;
    const r = 8 + Math.sqrt(v) * (c - 16);
    const a0 = ((d * 22.5 - 10) * Math.PI) / 180;
    const a1 = ((d * 22.5 + 10) * Math.PI) / 180;
    const p = (a, rr) => `${(c + Math.sin(a) * rr).toFixed(1)},${(c - Math.cos(a) * rr).toFixed(1)}`;
    const col = suit[d] >= 0.6 ? '#2a9d55' : suit[d] >= 0.35 ? '#e0a92e' : '#b8c3cf';
    petals += `<path d="M${c},${c} L${p(a0, r)} A${r},${r} 0 0 1 ${p(a1, r)} Z" fill="${col}" stroke="#fff" stroke-width="0.5"/>`;
  }
  const lab = (t, x, y) => `<text x="${x}" y="${y}" font-size="10" text-anchor="middle" fill="#5b6b7c">${t}</text>`;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${c}" cy="${c}" r="${c - 8}" fill="none" stroke="#dde3ea"/>${petals}
    ${lab('N', c, 9)}${lab('S', c, size - 1)}${lab('W', 5, c + 3)}${lab('E', size - 5, c + 3)}</svg>`;
}

let popup = null;
async function showLakePopup(f, lngLat) {
  const p = f.properties;
  const [lon, lat] = lakeCenter(f);
  const wind = await getWind(lat, lon);
  const suit = p._suit;
  const best = bestDirs(suit, wind, DIRS16);
  const maxFetch = Math.max(...p._fetch) / 1000;
  const d = distanceFromHome(f, state.home);
  const site = lakeSites.get(p.id);
  let whyHtml = '<p class="sub">Checking the shoreline (wind angle, open water, trees and buildings)...</p>';
  let launchList = [];
  let siteScore = null;
  if (site?.ok) {
    const s = scoreSite(site, wind, state.mode, p);
    siteScore = s;
    whyHtml = reasonsHtml(explain(s, site, state.mode, p));
    launchList = launches(s, site);
  }
  const el = document.createElement('div');
  el.className = 'pop';
  el.innerHTML = `<h4></h4>
    <div class="sub">${p.t === 2 ? 'Reservoir' : 'Lake'}${p.c ? ' · ' + p.c : ''}${p.src === 'osm' ? ' · from OpenStreetMap' : ''}</div>
    <div class="sub drive">~${fmtH(estimateDriveHours(d))} drive (${fmtMi(d)} straight line) from ${esc(state.home.name)}</div>
    <div style="margin:4px 0">${badges(p, wind)}</div>
    <div class="rose">${roseSvg(wind, suit)}
      <div><div class="score" style="background:${scoreColor(p.score)};width:44px;height:44px;border-radius:22px;font-size:16px">${p.score}</div>
      <div class="sub" style="margin-top:4px">${scoreText(p)}</div></div></div>
    <div class="sub">Petal length: kiteable daylight wind (12 to 35 kn) from that direction. Green: the lake works well for that wind.</div>
    <h5>Why this score</h5><div class="whybox">${whyHtml}</div>
    ${siteScore ? '<div class="actions"><button class="view3d primary">3D spot view</button></div>' : ''}
    <table>
      <tr><td>Area</td><td>${p.a.toFixed(2)} km² (${Math.round(p.a * 247.1)} acres)</td></tr>
      <tr><td>Longest open run</td><td>${fmtKm(maxFetch)} (${(maxFetch * 0.621).toFixed(1)} mi)</td></tr>
      <tr><td>Best wind from</td><td>${best.length ? best.slice(0, 5).join(', ') : 'none, the lake is small or narrow'}</td></tr>
      ${wind ? `<tr><td>Kiteable hours</td><td>${wind.kiteHours} daylight hrs/yr (${wind.year})</td></tr><tr><td>Mean wind</td><td>${wind.meanKn} kn</td></tr>` : ''}
      ${p.s ? `<tr><td>Shoreline</td><td>${fmtKm(p.s)}</td></tr>` : ''}
      ${p.d ? `<tr><td>Average depth</td><td>${p.d} m (${(p.d * 3.28).toFixed(0)} ft)</td></tr>` : ''}
      ${p.wc ? `<tr><td>Water colour</td><td>${{ clear: 'Clear / dark', green: 'Green', murky: 'Brown / murky' }[p.wc]} (summer satellite mosaic)</td></tr>` : ''}
      ${p.e != null ? `<tr><td>Elevation</td><td>${p.e} m</td></tr>` : ''}
    </table>
    ${monthSvg(wind)}
    <div class="actions"><button class="save">Save spot</button><button class="fcbtn">7-day forecast</button><button class="gmap">Copy coordinates</button></div>
    <div class="fc"></div>`;
  el.querySelector('h4').textContent = lakeName(p);
  if (siteScore) el.querySelector('.view3d').onclick = () => open3d(lakeName(p), site, siteScore, wind, lat, lon);
  el.querySelector('.save').onclick = () => saveSpot(lat, lon, lakeName(p), p.id);
  el.querySelector('.gmap').onclick = () => {
    navigator.clipboard?.writeText(`${lat.toFixed(5)}, ${lon.toFixed(5)}`);
    toast('Coordinates copied');
  };
  el.querySelector('.fcbtn').onclick = () => showForecast(el.querySelector('.fc'), lat, lon, suit);
  popup?.remove();
  popup = new maplibregl.Popup({ maxWidth: '380px' }).setLngLat(lngLat).setDOMContent(el).addTo(map);
  const mine = popup;
  popup.on('close', () => showLaunches([]));
  showLaunches(launchList);
  if (navigator.onLine) fillDrive(el, lon, lat);
  if (!site) {
    const raw = await analyzeLake(f).catch((e) => ({ ok: false, reason: String(e) }));
    if (raw.ok) {
      lakeSites.set(p.id, raw);
      await scoreFeatures([f], state.mode);
      map.getSource('lakes')?.setData(fc(state.lakes));
      if (popup === mine && mine.isOpen()) showLakePopup(f, lngLat);
    } else if (popup === mine) {
      el.querySelector('.whybox').innerHTML = reasonsHtml(explain({}, raw));
    }
  }
}

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function scoreText(p) {
  if (p.basis === 'wind') return `${p.eff} good kiting hrs/yr` + (state.mode === 'beginner' ? ' (beginner)' : '');
  if (p.basis === 'ice') return `${p.eff} good snowkite hrs/yr`;
  if (p.basis === 'no-ice') return 'Rarely freezes hard enough';
  return 'Shape only (no wind data)';
}

function badges(p, wind) {
  const out = [];
  const sw = p.wrgb ? `<span style="display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:3px;background:rgb(${p.wrgb.join(',')})"></span>` : '';
  if (p.wc === 'clear') out.push(`<span class="badge good">${sw}Clear water</span>`);
  if (p.wc === 'green') out.push(`<span class="badge warn">${sw}Green water (algae likely)</span>`);
  if (p.wc === 'murky') out.push(`<span class="badge warn">${sw}Murky water</span>`);
  if (p.d != null && p.d < 1.5) out.push('<span class="badge warn">Very shallow: likely weedy or mucky</span>');
  if (iceMonths(wind).length) out.push('<span class="badge">Freezes in winter</span>');
  return out.join('');
}


async function showForecast(box, lat, lon, suit) {
  box.textContent = 'Loading forecast...';
  try {
    const r = await forecast(lat, lon);
    const days = forecastDays(r, suit || null, state.mode);
    box.innerHTML = '<b>Next 7 days here</b> <span class="sub">(best window of daylight hours that work at this shore)</span>';
    for (const [day, v] of days) {
      const row = document.createElement('div');
      row.innerHTML = `<span><span class="v-${v.verdict}" style="padding:0 5px">${v.verdict.toUpperCase()}</span> ${new Date(day + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span><span>${v.window ? windowText(v.window) + (v.gusty ? ' · gusty' : '') : v.kite ? `${v.kite} h of wind, from a poor direction here` : 'too light or too strong'}</span>`;
      box.appendChild(row);
    }
  } catch (e) {
    box.textContent = 'Forecast needs an internet connection.';
  }
}

// ---------- Forecast tab ----------

function lakeAt(lon, lat, lakeId) {
  if (lakeId != null && state.byId.has(lakeId)) return state.byId.get(lakeId);
  return state.lakes.find((f) => pointInLake(f, lon, lat)) || null;
}

/** Name for a forecast target: the lake it is on, or its coordinates. */
function placeName(lat, lon) {
  const lake = lakeAt(lon, lat);
  return lake ? `${lakeName(lake.properties)} shore` : `Shore at ${lat.toFixed(3)}, ${lon.toFixed(3)}`;
}

function forecastTargets() {
  const t = state.saved.map((s) => {
    const lake = lakeAt(s.lon, s.lat, s.lakeId);
    return { name: s.name, lat: s.lat, lon: s.lon, lakeId: s.lakeId, suit: lake ? lake.properties._suit : null, saved: true };
  });
  if ($('fc-known').checked) {
    const vb = viewBbox();
    const top = state.spots.filter((sp) => sp.c.lon >= vb[0] && sp.c.lon <= vb[2] && sp.c.lat >= vb[1] && sp.c.lat <= vb[3]).slice(0, 20);
    for (const sp of top) t.push({ name: placeName(sp.c.lat, sp.c.lon), lat: sp.c.lat, lon: sp.c.lon, score: sp.score, suit: scoreSite(sp.raw, windAt(sp.c.lat, sp.c.lon), state.mode).Q });
  }
  return t;
}

async function checkForecast() {
  const targets = forecastTargets();
  if (!targets.length) return ($('fc-status').textContent = 'Move the map to some water (spots are found as you look around), or save a spot first.');
  $('fc-status').textContent = `Checking the forecast for ${targets.length} spots...`;
  try {
    const results = await forecastMany(targets.map((t) => [t.lat, t.lon]));
    state.fcData = { fetched: Date.now(), targets, results, mode: state.mode };
    await backend.kvSet('forecast/last', state.fcData);
    renderForecast();
  } catch (e) {
    $('fc-status').textContent = (navigator.onLine ? 'Could not reach the forecast service. Try again in a minute.' : 'The forecast needs an internet connection.') + (state.fcData ? ' Showing the last one.' : '');
  }
}
$('fc-refresh').onclick = checkForecast;
$('fc-known').onchange = checkForecast;
// Opening the tab fetches a fresh forecast when the saved one is old.
document.querySelector('#tabs button[data-tab="forecast"]').addEventListener('click', () => {
  const age = state.fcData ? (Date.now() - state.fcData.fetched) / 3600e3 : Infinity;
  if (age > 3 && navigator.onLine) checkForecast();
});

const dayName = (d, long) => new Date(d + 'T12:00').toLocaleDateString(undefined, long ? { weekday: 'long', month: 'short', day: 'numeric' } : { weekday: 'short' });

function renderForecast() {
  const data = state.fcData;
  if (!data) return;
  const age = (Date.now() - data.fetched) / 3600e3;
  $('fc-status').textContent = `Updated ${new Date(data.fetched).toLocaleString()}${age > 12 ? ' (old, check again when online)' : ''}. Drive times are estimates from ${state.home.name}.`;
  const rows = data.targets.map((t, i) => ({
    t,
    days: forecastDays(data.results[i], t.suit || null, data.mode || state.mode),
    drive: estimateDriveHours(distanceFromHome({ properties: { _c: [t.lon, t.lat] } }, state.home)),
  }));
  state.fcByKey = new Map(rows.map((r) => [accessKey(r.t.lat, r.t.lon), r.days]));
  const weight = (r, v) => v.good * (0.5 + (r.t.score ?? 70) / 200);
  rows.sort((a, b) => [...b.days.values()].reduce((s, v) => s + weight(b, v), 0) - [...a.days.values()].reduce((s, v) => s + weight(a, v), 0) || a.drive - b.drive);
  const dayKeys = [...(rows[0]?.days.keys() || [])].slice(0, 7);

  // Best sessions: the longest good windows across all spots and days.
  const sessions = [];
  for (const r of rows) for (const [d, v] of r.days) if (v.verdict === 'go' && v.window) sessions.push({ r, d, v });
  sessions.sort((a, b) => a.d.localeCompare(b.d) || weight(b.r, b.v) - weight(a.r, a.v));
  const perDay = new Map();
  for (const x of sessions) { const l = perDay.get(x.d) || []; if (l.length < 2) l.push(x); perDay.set(x.d, l); }
  const best = $('fc-best');
  best.innerHTML = '';
  if (!perDay.size) best.innerHTML = '<p class="hint">No good sessions in the next 7 days for these spots. Try moving the map to other water and checking again.</p>';
  else best.insertAdjacentHTML('beforeend', '<h5>Best sessions</h5>');
  for (const [d, list] of perDay) {
    for (const { r, v } of list) {
      const el = document.createElement('div');
      el.className = 'fc-session';
      el.innerHTML = `<div><b>${dayName(d, true)}</b> · ${fmtH(r.drive)} drive</div><div class="name"></div><div class="sub">${windowText(v.window)}${v.gusty ? ' · gusty' : ''}</div>`;
      el.querySelector('.name').textContent = r.t.name + (r.t.score != null ? ` (score ${r.t.score})` : '');
      el.onclick = () => { pickDay(d); map.flyTo({ center: [r.t.lon, r.t.lat], zoom: 12.5 }); };
      best.appendChild(el);
    }
  }

  // Day picker: colours the spots on the map for that day.
  const chips = $('fc-days');
  chips.innerHTML = '<span class="hint">Show on the map:</span>';
  for (const d of [null, ...dayKeys]) {
    const b = document.createElement('button');
    b.textContent = d ? `${dayName(d)} ${+d.slice(8)}` : 'Off';
    b.classList.toggle('on', (state.fcDay || null) === d);
    b.onclick = () => pickDay(d);
    chips.appendChild(b);
  }

  const table = document.createElement('table');
  table.className = 'fc-grid';
  table.innerHTML = `<tr><th></th><th>Drive</th>${dayKeys.map((d) => `<th class="${state.fcDay === d ? 'on' : ''}">${dayName(d)}<br>${+d.slice(8)}</th>`).join('')}</tr>`;
  for (const r of rows) {
    const tr = document.createElement('tr');
    const cells = dayKeys
      .map((d) => {
        const v = r.days.get(d);
        if (!v) return '<td></td>';
        const tip = v.window ? `Best: ${windowText(v.window)}. ${v.good} good hours.` : `${v.kite} kiteable hours${v.topDir != null ? ', mostly from ' + DIRS16[v.topDir] + ', a poor direction here' : ''}.`;
        return `<td title="${esc(tip)}"><span class="v-${v.verdict}" style="display:block;padding:2px 0">${v.verdict === 'no' ? '·' : v.good}${v.gusty && v.verdict !== 'no' ? '~' : ''}</span></td>`;
      })
      .join('');
    tr.innerHTML = `<td class="spot"></td><td>${fmtH(r.drive)}</td>${cells}`;
    tr.querySelector('.spot').textContent = r.t.name;
    tr.querySelector('.spot').title = r.t.name;
    tr.querySelector('.spot').onclick = () => map.flyTo({ center: [r.t.lon, r.t.lat], zoom: 12.5 });
    table.appendChild(tr);
  }
  $('fc-table').innerHTML = '';
  $('fc-table').appendChild(table);
  publishSpots();
}

function pickDay(d) {
  state.fcDay = d;
  renderForecast();
}


// ---------- Discovered launch spots ----------

state.spots = [];
const boxRaws = new Map();
const windCache = new Map();

async function preloadWind(points) {
  for (const [lat, lon] of points) {
    const k = windCellKey(lat, lon);
    if (!windCache.get(k)) windCache.set(k, await getWind(lat, lon));
  }
}
const windAt = (lat, lon) => windCache.get(windCellKey(lat, lon)) || null;

async function refreshSpots() {
  const raws = [...boxRaws.values()];
  const pts = new Set();
  for (const r of raws) for (const c of r?.cand || []) pts.add(windCellKey(c.lat, c.lon));
  await preloadWind([...pts].map((k) => k.split(',').map(Number)));
  // Wind history for the shores in view, when online (a few points at a time).
  const missing = [...pts].filter((k) => !windCache.get(k));
  if (missing.length && navigator.onLine && !windBusy) {
    windBusy = true;
    try {
      await downloadWind(missing.slice(0, 24), (d, t) => setBanner(`Getting wind history for these shores: ${d} of ${t} points...`), null, { retries: 0 });
      await preloadWind(missing.map((k) => k.split(',').map(Number)));
    } catch {
    } finally {
      windBusy = false;
    }
  }
  state.spots = pickSpots(raws, windAt, state.mode);
  await applyAccess(true);
  checkAccess();
}

// ---------- Launch access (OpenStreetMap) ----------

state.access = new Map();
/** Fold the saved access checks into the spot scores and redraw the spots. */
async function applyAccess(loadSaved = false) {
  if (loadSaved) {
    const got = await fetchAccess(state.spots.map((sp) => [sp.c.lat, sp.c.lon]), backend, null, { online: false });
    for (const [k, v] of got) state.access.set(k, v);
  }
  for (const sp of state.spots) {
    sp.base ??= sp.score;
    const a = state.access.get(accessKey(sp.c.lat, sp.c.lon));
    sp.access = a || null;
    sp.score = a ? Math.round(sp.base * a.factor) : sp.base;
  }
  state.spots.sort((a, b) => b.score - a.score);
  publishSpots();
}

function publishSpots() {
  const day = state.fcDay;
  const byKey = state.fcByKey || new Map();
  map.getSource('spots')?.setData(fc(state.spots.map((s, i) => {
    const props = { i, score: s.score, access: s.access?.level || '' };
    const f = day && byKey.get(accessKey(s.c.lat, s.c.lon))?.get(day);
    if (day) { props.fc = f ? f.verdict : 'none'; if (f?.window) props.fcText = `${s.score} · ${windowText(f.window).split(',')[0]}`; }
    return { type: 'Feature', id: i, properties: props, geometry: { type: 'Point', coordinates: [s.c.lon, s.c.lat] } };
  })));
  if ($('f-view').checked) renderSpots();
}

let accessBusy = false;
/** Check access online for the best spots that have not been checked yet. */
async function checkAccess() {
  if (accessBusy || !navigator.onLine) return;
  const todo = state.spots.filter((sp) => !state.access.has(accessKey(sp.c.lat, sp.c.lon))).slice(0, 25);
  if (!todo.length) return;
  accessBusy = true;
  try {
    const got = await fetchAccess(todo.map((sp) => [sp.c.lat, sp.c.lon]), backend, (u, o) => backend.httpJson(u, o), { online: true, max: 25 });
    for (const [k, v] of got) state.access.set(k, v);
    await applyAccess();
  } catch (e) {
    console.warn('access check', e);
  } finally {
    accessBusy = false;
  }
}

let scanBusy = false;
let scanGen = 0;
/** Scan the shores in view for launch spots, nearest the centre first. */
async function scanView() {
  if (map.getZoom() < 10) return;
  const gen = ++scanGen;
  if (scanBusy) return;
  scanBusy = true;
  try {
    let boxes = boxesIn(viewBbox()).filter((b) => !boxRaws.has(b.key));
    const c = map.getCenter();
    boxes.sort((a, b) => Math.hypot((a.bbox[0] + a.bbox[2]) / 2 - c.lng, (a.bbox[1] + a.bbox[3]) / 2 - c.lat) - Math.hypot((b.bbox[0] + b.bbox[2]) / 2 - c.lng, (b.bbox[1] + b.bbox[3]) / 2 - c.lat));
    boxes = boxes.slice(0, 40);
    for (let k = 0; k < boxes.length; k++) {
      if (gen !== scanGen && k > 0) break; // the view moved; start over there
      setBanner(`Checking shorelines for launch spots: ${k + 1} of ${boxes.length} areas...`);
      try {
        const raw = await scanBox(boxes[k]);
        if (raw) boxRaws.set(boxes[k].key, raw);
      } catch (e) {
        console.warn('scan', e);
      }
      if (k % 4 === 3) await refreshSpots();
      await new Promise((r) => setTimeout(r, 0));
    }
    await refreshSpots();
  } finally {
    scanBusy = false;
    setBanner(null);
  }
  if (gen !== scanGen) scanView();
}

/** Shore analysis for the best-looking lakes in view, a few at a time. */
let lakeBusy = false;
async function analyzeLakesInView() {
  if (lakeBusy || map.getZoom() < 9) return;
  lakeBusy = true;
  try {
    const vb = viewBbox();
    const todo = state.lakes
      .filter((f) => !lakeSites.has(f.properties.id) && bboxIntersects(f.properties._bbox, vb))
      .sort((a, b) => b.properties.score - a.properties.score)
      .slice(0, 12);
    for (const f of todo) {
      const raw = await analyzeLake(f).catch(() => null);
      if (raw?.ok) lakeSites.set(f.properties.id, raw);
    }
    if (todo.length) {
      await scoreFeatures(todo, state.mode);
      map.getSource('lakes')?.setData(fc(state.lakes));
      renderSpots();
    }
  } finally {
    lakeBusy = false;
  }
}

function showLaunches(list) {
  map.getSource('launch')?.setData(fc(list.map((l) => ({ type: 'Feature', properties: { label: l.dirs.slice(0, 3).join(' ') + ' wind' }, geometry: { type: 'Point', coordinates: [l.lon, l.lat] } }))));
}

function reasonsHtml(rs) {
  const icon = { good: '✔', bad: '✘', warn: '⚠', info: 'ℹ' };
  return `<ul class="why">${rs.map((r) => `<li class="why-${r.kind}"><span>${icon[r.kind]}</span> ${esc(r.text)}</li>`).join('')}</ul>`;
}

/** Open the 3D spot view for an analysed spot or lake. */
function open3d(title, raw, s, wind, lat, lon) {
  popup?.remove();
  showLaunches([]);
  enterSpotView(map, {
    title, raw, s, wind,
    forecastNow: async () => {
      const r = await forecast(lat, lon);
      const local = new Date(Date.now() + (r.utc_offset_seconds || 0) * 1000).toISOString().slice(0, 13);
      const i = r.hourly.time.findIndex((t) => t.startsWith(local));
      if (i < 0) return null;
      return { dir: r.hourly.wind_direction_10m[i], kn: r.hourly.wind_speed_10m[i], gust: r.hourly.wind_gusts_10m?.[i] };
    },
  });
}

/** Popup for a shore spot (a discovered launch or any point you check). */
async function showSpotPopup(raw, lon, lat, title) {
  const c0 = raw?.cand?.[0];
  await preloadWind([[lat, lon]]);
  const wind = windAt(lat, lon);
  const s = scoreSite(raw, wind, state.mode);
  const d = distanceFromHome({ properties: { _c: [lon, lat] } }, state.home);
  const el = document.createElement('div');
  el.className = 'pop';
  el.innerHTML = `<h4></h4>
    <div class="sub">${raw?.ok ? `${raw.cand.length > 1 ? raw.cand.length + ' launch points checked' : 'Shore facing ' + c0.face}${c0?.river ? ' · river' : ''}` : ''}</div>
    <div class="sub drive">~${fmtH(estimateDriveHours(d))} drive (${fmtMi(d)} straight line) from ${esc(state.home.name)}</div>
    <div class="rose">${roseSvg(wind, s.Q)}
      <div><div class="score" style="background:${scoreColor(s.score)};width:44px;height:44px;border-radius:22px;font-size:16px">${s.score}</div>
      <div class="sub" style="margin-top:4px">${scoreText({ basis: s.basis === 'site' ? 'wind' : s.basis, eff: s.eff })}</div></div></div>
    <div class="sub">Petals: how often the wind blows from there. Green: works well from this shore.</div>
    <h5>Why this score</h5>${reasonsHtml(explain(s, raw, state.mode))}
    <h5>Launch and access</h5><div class="access sub">Checking the map for beaches, ramps, parking and private land...</div>
    ${monthSvg(wind)}
    <div class="actions"><button class="view3d primary">3D spot view</button><button class="save">Save spot</button><button class="fcbtn">7-day forecast</button><button class="gmap">Copy coordinates</button></div>
    <div class="fc"></div>`;
  el.querySelector('h4').textContent = title;
  const v3 = el.querySelector('.view3d');
  if (raw?.ok) v3.onclick = () => open3d(title, raw, s, wind, lat, lon);
  else v3.remove();
  el.querySelector('.save').onclick = () => saveSpot(lat, lon, title === 'Launch spot' ? `Spot ${lat.toFixed(3)}, ${lon.toFixed(3)}` : title);
  el.querySelector('.gmap').onclick = () => {
    navigator.clipboard?.writeText(`${lat.toFixed(5)}, ${lon.toFixed(5)}`);
    toast('Coordinates copied');
  };
  el.querySelector('.fcbtn').onclick = () => showForecast(el.querySelector('.fc'), lat, lon, s.Q);
  popup?.remove();
  popup = new maplibregl.Popup({ maxWidth: '380px' }).setLngLat([lon, lat]).setDOMContent(el).addTo(map);
  popup.on('close', () => showLaunches([]));
  showLaunches(launches(s, raw));
  if (navigator.onLine) fillDrive(el, lon, lat);
  fillAccess(el, lat, lon, s.score);
}

async function fillAccess(el, lat, lon, score) {
  const box = el.querySelector('.access');
  const k = accessKey(lat, lon);
  try {
    let a = state.access.get(k);
    if (!a) {
      const got = await fetchAccess([[lat, lon]], backend, (u, o) => backend.httpJson(u, o), { online: navigator.onLine });
      a = got.get(k);
      if (a) { state.access.set(k, a); applyAccess(); }
    }
    if (!a) { box.textContent = 'Access check needs an internet connection the first time.'; return; }
    box.classList.remove('sub');
    box.innerHTML = reasonsHtml(accessReasons(a));
    if (a.factor < 1) {
      const sc = el.querySelector('.score');
      const adj = Math.round(score * a.factor);
      sc.textContent = adj;
      sc.style.background = scoreColor(adj);
      sc.title = `${score} for wind and shore, lowered to ${adj} for access and hazards`;
      box.insertAdjacentHTML('afterbegin', `<div class="sub">Score lowered from ${score} to ${adj} for access and hazards.</div>`);
    }
  } catch (e) {
    box.textContent = 'Could not check access right now.';
  }
}

map.on('click', 'spot-pt', (e) => {
  const sp = state.spots[e.features[0].properties.i];
  if (sp) showSpotPopup(sp.raw, sp.c.lon, sp.c.lat, 'Launch spot');
});
map.on('mouseenter', 'spot-pt', () => (map.getCanvas().style.cursor = 'pointer'));
map.on('mouseleave', 'spot-pt', () => (map.getCanvas().style.cursor = ''));

map.on('click', 'lake-fill', (e) => {
  if (map.queryRenderedFeatures(e.point, { layers: ['spot-pt', 'launch-pt'] }).length) return;
  if (state.drawing) return;
  const f = state.byId.get(e.features[0].properties.id);
  if (f) showLakePopup(f, e.lngLat);
});
let hoverId = null;
map.on('mousemove', 'lake-fill', (e) => {
  map.getCanvas().style.cursor = 'pointer';
  if (hoverId != null) map.setFeatureState({ source: 'lakes', id: hoverId }, { hover: false });
  hoverId = e.features[0].id;
  map.setFeatureState({ source: 'lakes', id: hoverId }, { hover: true });
});
map.on('mouseleave', 'lake-fill', () => {
  map.getCanvas().style.cursor = '';
  if (hoverId != null) map.setFeatureState({ source: 'lakes', id: hoverId }, { hover: false });
  hoverId = null;
});

// ---------- Right-click menu, home, saved spots ----------

map.on('contextmenu', (e) => {
  const ctx = $('ctx');
  ctx.innerHTML = '';
  const add = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => {
      ctx.hidden = true;
      fn();
    };
    ctx.appendChild(b);
  };
  const { lat, lng } = e.lngLat;
  add('Save a spot here', () => {
    const name = prompt('Name for this spot', 'My spot');
    if (name) saveSpot(lat, lng, name);
  });
  add('Rate this shore as a kite launch', async () => {
    toast('Checking the shoreline here...', 2500);
    try {
      const raw = await analyzePoint(lng, lat);
      if (!raw.ok) return toast('No shoreline found near here.');
      showSpotPopup(raw, lng, lat, 'Shore near here');
    } catch (err) {
      toast('Could not check this spot: ' + err);
    }
  });
  add('Start trips from here', async () => {
    const name = prompt('Name for this starting point (home, hotel, ...)', 'Home');
    if (!name) return;
    await addOrigin({ id: String(Date.now()), lat, lon: lng, name });
    toast(`Drive times are now from "${name}".`);
  });
  add(`Copy ${lat.toFixed(4)}, ${lng.toFixed(4)}`, () => navigator.clipboard?.writeText(`${lat.toFixed(5)}, ${lng.toFixed(5)}`));
  ctx.style.left = e.originalEvent.clientX + 'px';
  ctx.style.top = e.originalEvent.clientY + 'px';
  ctx.hidden = false;
});
document.addEventListener('click', (e) => {
  if (!$('ctx').contains(e.target)) $('ctx').hidden = true;
});

// ---------- Starting points ----------

function renderOrigins() {
  const sel = $('origin');
  sel.innerHTML = '';
  for (const o of state.origins) {
    const opt = document.createElement('option');
    opt.value = o.id;
    opt.textContent = o.name;
    opt.selected = o.id === state.home.id;
    sel.appendChild(opt);
  }
  $('origin-del').disabled = state.origins.length < 2;
}

async function setOrigin(id) {
  state.home = state.origins.find((o) => o.id === id) || state.origins[0];
  await backend.kvSet('originId', state.home.id);
  renderOrigins();
  renderHome();
  renderSpots();
  if (state.fcData) renderForecast();
}

async function addOrigin(o) {
  state.origins.push(o);
  await backend.kvSet('origins', state.origins);
  await setOrigin(o.id);
}

$('origin').onchange = (e) => setOrigin(e.target.value);
$('origin-del').onclick = async () => {
  if (state.origins.length < 2) return;
  state.origins = state.origins.filter((o) => o.id !== state.home.id);
  await backend.kvSet('origins', state.origins);
  await setOrigin(state.origins[0].id);
};
$('origin-here').onclick = () => {
  if (!navigator.geolocation) return toast('Location is not available. Right-click the map and choose "Start trips from here".');
  navigator.geolocation.getCurrentPosition(
    (pos) => addOrigin({ id: String(Date.now()), lat: pos.coords.latitude, lon: pos.coords.longitude, name: 'My location' }),
    () => toast('Could not get your location. Right-click the map and choose "Start trips from here".', 6000),
    { timeout: 10000 },
  );
};

function renderHome() {
  const h = state.home;
  map.getSource('home')?.setData(fc([{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [h.lon, h.lat] } }]));
}

async function saveSpot(lat, lon, name, lakeId = null) {
  state.saved.push({ id: Date.now(), lat, lon, name, lakeId, note: '' });
  await backend.kvSet('saved', state.saved);
  renderSaved();
  toast(`Saved "${name}"`);
}

function renderSaved() {
  const ul = $('saved-list');
  ul.innerHTML = '';
  for (const s of state.saved) {
    const li = document.createElement('li');
    li.innerHTML = `<div class="grow"><div class="name"></div><textarea rows="2" style="width:100%;font:inherit;font-size:12px" placeholder="Notes: parking, launch, hazards..."></textarea></div><button title="Delete">✕</button>`;
    li.querySelector('.name').textContent = s.name;
    const ta = li.querySelector('textarea');
    ta.value = s.note || '';
    ta.onclick = (e) => e.stopPropagation();
    ta.onchange = async () => {
      s.note = ta.value;
      await backend.kvSet('saved', state.saved);
    };
    li.querySelector('button').onclick = async (e) => {
      e.stopPropagation();
      state.saved = state.saved.filter((x) => x.id !== s.id);
      await backend.kvSet('saved', state.saved);
      renderSaved();
    };
    li.onclick = () => {
      const f = s.lakeId != null && state.byId.get(s.lakeId);
      if (f) focusLake(f);
      else map.flyTo({ center: [s.lon, s.lat], zoom: 13 });
    };
    ul.appendChild(li);
  }
  if (!state.saved.length) ul.innerHTML = '<li class="hint">No saved spots yet.</li>';
  map.getSource('saved')?.setData(
    fc(state.saved.map((s) => ({ type: 'Feature', properties: { name: s.name }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } }))),
  );
}

// ---------- Layers ----------

$('l-lakes').onchange = (e) => ['lake-fill', 'lake-line', 'lake-score'].forEach((id) => map.setLayoutProperty(id, 'visibility', e.target.checked ? 'visible' : 'none'));
$('l-hill').onchange = (e) => map.setLayoutProperty('hillshade', 'visibility', e.target.checked ? 'visible' : 'none');
$('l-known').onchange = (e) => ['spot-pt', 'spot-label'].forEach((id) => map.setLayoutProperty(id, 'visibility', e.target.checked ? 'visible' : 'none'));
$('l-sat').onchange = (e) => map.setLayoutProperty('satellite', 'visibility', e.target.checked ? 'visible' : 'none');
$('l-geo').onchange = (e) => map.setLayoutProperty('geology', 'visibility', e.target.checked ? 'visible' : 'none');

// ---------- Region download ----------

$('draw').onclick = () => {
  state.drawing = true;
  map.dragPan.disable();
  map.getCanvas().classList.add('boxdraw');
  toast('Drag a box on the map around the area you want.');
};

let dragStart = null;
map.on('mousedown', (e) => {
  if (!state.drawing) return;
  dragStart = e.lngLat;
});
map.on('mousemove', (e) => {
  if (!state.drawing || !dragStart) return;
  const b = [Math.min(dragStart.lng, e.lngLat.lng), Math.min(dragStart.lat, e.lngLat.lat), Math.max(dragStart.lng, e.lngLat.lng), Math.max(dragStart.lat, e.lngLat.lat)];
  state.drawBox = b;
  map.getSource('draw').setData(fc([boxFeature(b)]));
});
map.on('mouseup', () => {
  if (!state.drawing || !dragStart) return;
  dragStart = null;
  state.drawing = false;
  map.dragPan.enable();
  map.getCanvas().classList.remove('boxdraw');
  if (!state.drawBox) return;
  $('dl-panel').hidden = false;
  updateEstimate();
});

function regionOptions() {
  return { ...DEFAULTS, geology: $('dl-geo').checked, satellite: $('dl-sat').checked };
}
function updateEstimate() {
  const b = state.drawBox;
  if (!b) return;
  const est = estimate(b, regionOptions());
  const w = Math.round((b[2] - b[0]) * 111 * Math.cos(((b[1] + b[3]) / 2) * Math.PI / 180));
  const h = Math.round((b[3] - b[1]) * 111);
  $('dl-est').textContent = `About ${w} × ${h} km. Roughly ${est.tiles.toLocaleString()} map tiles, about ${est.mb >= 1024 ? (est.mb / 1024).toFixed(1) + ' GB' : est.mb + ' MB'}. ` +
    `Wind history download pauses between requests to respect the free weather service, so a large area can take 10 to 30 minutes.`;
  $('dl-start').disabled = est.mb > 20000;
  if (est.mb > 20000) $('dl-est').textContent += ' This is too big; draw a smaller box.';
}
$('dl-geo').onchange = updateEstimate;
$('dl-sat').onchange = updateEstimate;
$('dl-cancel').onclick = () => {
  $('dl-panel').hidden = true;
  state.drawBox = null;
  state.pendingId = null;
  map.getSource('draw').setData(fc([]));
};

$('dl-start').onclick = async () => {
  const region = { id: state.pendingId || String(Date.now()), name: $('dl-name').value || 'Region', bbox: state.drawBox.map((v) => +v.toFixed(4)), options: regionOptions() };
  $('dl-panel').hidden = true;
  $('dl-progress').hidden = false;
  $('draw').disabled = true;
  const ctrl = new AbortController();
  state.downloading = ctrl;
  try {
    const rec = await downloadRegion(
      region,
      (step, done, total, note) => {
        $('dl-step').textContent = `${step}: ${done.toLocaleString()} / ${total.toLocaleString()}`;
        $('dl-bar').value = total ? done / total : 0;
        $('dl-note').textContent = note || '';
      },
      ctrl.signal,
    );
    await loadRegions();
    const warn = [];
    if (rec.windError) warn.push('wind history could not be downloaded, so scores use lake shape only (try again later)');
    if (rec.failedTiles) warn.push(`${rec.failedTiles} map tiles failed`);
    toast(`"${rec.name}" is ready offline with ${rec.lakes.toLocaleString()} lakes.` + (warn.length ? ' Note: ' + warn.join('; ') + '.' : ''), 9000);
    switchTab('spots');
  } catch (e) {
    toast(String(e).includes('cancelled') ? 'Download stopped. Anything already downloaded is kept.' : 'Download failed: ' + e, 9000);
  } finally {
    state.downloading = null;
    state.pendingId = null;
    $('dl-progress').hidden = true;
    $('draw').disabled = false;
    map.getSource('draw').setData(fc([]));
    state.drawBox = null;
  }
};
// ---------- World map ----------

const fmtBytes = (b) => (b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : Math.round(b / 1048576) + ' MB');
const ZOOM_NAMES = { 8: 'Overview', 10: 'Standard', 12: 'Detailed' };

async function renderWorld() {
  if (!backend.isTauri) return ($('world-status').textContent = 'Available in the desktop app.');
  const p = await backend.call('planet_status').catch(() => null);
  $('world-status').textContent =
    p && p.complete
      ? `Downloaded: ${ZOOM_NAMES[p.maxzoom] || 'zoom ' + p.maxzoom} world map (${fmtBytes(p.data_bytes)}). The whole planet works offline at this detail.`
      : p
        ? `Paused at part of the ${ZOOM_NAMES[p.maxzoom] || ''} world map. Click Check size, then Download to resume.`
        : 'Not downloaded. Download the whole planet once, so the map works anywhere with no internet.';
}

$('world-size').onclick = async () => {
  $('world-go').hidden = true;
  $('world-status').textContent = 'Checking size...';
  try {
    const info = await backend.call('planet_info', { maxzoom: +$('world-zoom').value });
    $('world-status').textContent = `${ZOOM_NAMES[info.maxzoom]} world map: ${fmtBytes(info.bytes)} (OpenStreetMap build ${info.build.slice(0, 8)}).`;
    $('world-go').hidden = false;
  } catch (e) {
    $('world-status').textContent = 'Could not check: ' + e;
  }
};
$('world-zoom').onchange = () => ($('world-go').hidden = true);

$('world-go').onclick = async () => {
  $('world-go').hidden = true;
  $('world-size').disabled = true;
  $('world-progress').hidden = false;
  const stop = await backend.listen('planet-progress', ({ stage, done, total }) => {
    $('world-step').textContent = stage === 'index' ? 'Downloading the map index...' : `Downloading world map: ${fmtBytes(done)} of ${fmtBytes(total)}`;
    $('world-bar').value = total ? done / total : 0;
  });
  try {
    await backend.call('planet_download', { maxzoom: +$('world-zoom').value });
    toast('World map downloaded. The map now works anywhere offline.', 8000);
    map.getSource('protomaps')?.setTiles([tileTemplate('osm')]);
  } catch (e) {
    toast(String(e).includes('cancelled') ? 'Paused. Click Download again to resume.' : 'World map download failed: ' + e, 9000);
  } finally {
    stop();
    $('world-progress').hidden = true;
    $('world-size').disabled = false;
    renderWorld();
  }
};
$('world-stop').onclick = () => backend.call('planet_cancel');

// ---------- Lake database ----------

async function renderLakeDb() {
  const idx = await lakeIndex({ reload: true });
  const total = idx ? Object.values(idx.cells).reduce((a, b) => a + b, 0) : 0;
  $('lakedb-status').innerHTML = idx
    ? `Lake database ready: ${total.toLocaleString()} lakes worldwide.`
    : `<b>Needed once:</b> the HydroLAKES lake file (820 MB zip). If you already downloaded <code>HydroLAKES_polys_v10_shp.zip</code>, click <b>Import lake zip</b> and choose it. Otherwise click <b>Download it</b>, or get it from <a href="${HYDROLAKES_PAGE}" target="_blank">hydrosheds.org</a> ("Lake polygons ... shapefile format").`;
  $('lakedb-import').textContent = idx ? 'Re-import lake zip' : 'Import lake zip';
  $('lakedb-download').hidden = !!idx;
}

let lakeJobBusy = false;
async function runLakeJob(fn) {
  if (lakeJobBusy) return;
  lakeJobBusy = true;
  $('lakedb-progress').hidden = false;
  $('lakedb-import').disabled = $('lakedb-download').disabled = true;
  const labels = { download: 'Downloading', unzip: 'Unzipping', read: 'Reading lakes' };
  const stop = await backend.onLakesProgress(({ stage, done, total }) => {
    const mb = (v) => Math.round(v / 1048576).toLocaleString() + ' MB';
    $('lakedb-step').textContent = stage === 'read'
      ? `${labels[stage]}: ${done.toLocaleString()} of ${total.toLocaleString()}`
      : `${labels[stage] || stage}: ${mb(done)}${total ? ' of ' + mb(total) : ''}`;
    $('lakedb-bar').value = total ? done / total : 0;
  });
  try {
    const r = await fn();
    if (r) toast(`Lake database ready: ${r.lakes.toLocaleString()} lakes. Now click "Draw area" to download a region.`, 9000);
    await renderLakeDb();
    await loadRegions();
  } catch (e) {
    const msg = String(e);
    toast(
      /http 40[13]/.test(msg)
        ? 'The lake website refused the download. Download the zip in your browser from hydrosheds.org, then click "Import lake zip".'
        : 'Lake setup failed: ' + msg,
      12000,
    );
  } finally {
    stop();
    lakeJobBusy = false;
    $('lakedb-progress').hidden = true;
    $('lakedb-import').disabled = $('lakedb-download').disabled = false;
  }
}

$('lakedb-import').onclick = async () => {
  const path = await backend.pickLakeFile();
  if (!path) return;
  runLakeJob(() => backend.lakesImport(path));
};
$('lakedb-download').onclick = () => runLakeJob(() => backend.lakesDownload(HYDROLAKES_URL));

$('dl-abort').onclick = () => state.downloading?.abort();

async function renderRegions() {
  const ul = $('region-list');
  ul.innerHTML = '';
  for (const r of state.regions) {
    const li = document.createElement('li');
    li.innerHTML = `<div class="grow"><div class="name"></div><div class="sub">${r.lakes.toLocaleString()} lakes · ${new Date(r.downloaded).toLocaleDateString()}</div></div>
      <button class="upd" title="Download again to fill gaps and refresh wind">↻</button><button class="del" title="Remove">✕</button>`;
    li.querySelector('.name').textContent = r.name;
    li.onclick = () => map.fitBounds([[r.bbox[0], r.bbox[1]], [r.bbox[2], r.bbox[3]]], { padding: 40 });
    li.querySelector('.del').onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Remove "${r.name}" from the list? Map tiles stay saved until you delete all data.`)) return;
      await backend.kvDelete('region/' + r.id);
      await loadRegions();
    };
    li.querySelector('.upd').onclick = (e) => {
      e.stopPropagation();
      state.drawBox = r.bbox;
      $('dl-name').value = r.name;
      $('dl-panel').hidden = false;
      state.pendingId = r.id;
      updateEstimate();
    };
    ul.appendChild(li);
  }
  const st = await backend.cacheStats('');
  $('storage').textContent = `Saved data: ${(st.bytes / 1048576).toFixed(0)} MB in ${st.count.toLocaleString()} files.`;
}

$('clear-all').onclick = async () => {
  if (!confirm('Delete all downloaded maps and wind data? Saved spots and the lake database are kept.')) return;
  // Keep the lake database (lakes/), which takes a while to rebuild.
  for (const prefix of ['t/', 'a/', 'pm/']) await backend.cacheDeletePrefix(prefix);
  for (const [k] of await backend.kvList('region/')) await backend.kvDelete(k);
  for (const [k] of await backend.kvList('wind/')) await backend.kvDelete(k);
  await loadRegions();
};

// ---------- Status ----------

function renderNet() {
  const on = navigator.onLine;
  $('net').textContent = on ? 'online' : 'offline';
  $('net').classList.toggle('off', !on);
}
window.addEventListener('online', renderNet);
window.addEventListener('offline', renderNet);
renderNet();

let toastTimer = null;
function toast(msg, ms = 4000) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

window.__kite = {
  sv: spotViewControl,
  state, map, status, backend,
  // Used by tools/screenshots.cjs to show a discovered spot.
  spotPopup: (i = 0) => { const sp = state.spots[i]; if (sp) showSpotPopup(sp.raw, sp.c.lon, sp.c.lat, 'Launch spot'); },
  spotView: async (i = 0) => {
    const sp = state.spots[i];
    if (!sp) return false;
    await preloadWind([[sp.c.lat, sp.c.lon]]);
    const wind = windAt(sp.c.lat, sp.c.lon);
    open3d('Launch spot', sp.raw, scoreSite(sp.raw, wind, state.mode), wind, sp.c.lat, sp.c.lon);
    return true;
  },
};
