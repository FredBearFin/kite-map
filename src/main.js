import './style.css';
import maplibregl from 'maplibre-gl';
import { layers, namedFlavor } from '@protomaps/basemaps';
import { backend } from './backend.js';
import { DIRS16, bboxIntersects } from './geo.js';
import { bestDirs, dayVerdict, depthFactor, estimateDriveHours, iceMonths } from './scoring.js';
import { registerProtocol, glyphsTemplate, assetUrl, ASSETS, status } from './tiles.js';
import { cellsFor, distanceFromHome, driveRoute, filterBbox, forecast, forecastMany, getWind, lakeCenter, loadCell, pointInLake, scoreFeatures } from './lakes.js';
import { KNOWN_SPOTS } from './known-spots.js';
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
  return {
    version: 8,
    glyphs: glyphsTemplate(),
    sprite: assetUrl(ASSETS.sprite),
    sources: {
      protomaps: {
        type: 'vector',
        tiles: ['kt://osm/{z}/{x}/{y}'],
        maxzoom: 14,
        attribution: '© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>, Protomaps',
      },
      dem: { type: 'raster-dem', tiles: ['kt://dem/{z}/{x}/{y}'], tileSize: 256, maxzoom: 12, encoding: 'terrarium' },
      geo: { type: 'raster', tiles: ['kt://geo/{z}/{x}/{y}'], tileSize: 256, maxzoom: 12, attribution: 'Macrostrat' },
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
  map.addSource('known', {
    type: 'geojson',
    data: fc(KNOWN_SPOTS.map((k, i) => ({ type: 'Feature', id: i, properties: { i, name: k.name }, geometry: { type: 'Point', coordinates: [k.lon, k.lat] } }))),
  });
  map.addLayer({ id: 'known-pt', type: 'circle', source: 'known', paint: { 'circle-radius': 6, 'circle-color': '#ff7a00', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  map.addLayer({
    id: 'known-label',
    type: 'symbol',
    source: 'known',
    minzoom: 5,
    layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Medium'], 'text-size': 11, 'text-offset': [0, 1.2], 'text-anchor': 'top' },
    paint: { 'text-color': '#8a4300', 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
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
  });
  await loadRegions();
  renderHome();
  renderSaved();
  state.fcData = await backend.kvGet('forecast/last');
  renderForecast();
  $('folder').textContent = 'Data folder: ' + (await backend.dataFolder());
  if (!state.regions.length) {
    switchTab('regions');
    toast('Welcome! Download an area first: click "Draw area" and drag a box around the lakes you want to explore.', 9000);
  }
}

async function loadRegions() {
  state.regions = (await backend.kvList('region/')).map(([, v]) => v).sort((a, b) => a.downloaded - b.downloaded);
  const seen = new Map();
  for (const r of state.regions) {
    for (const cell of cellsFor(r.bbox)) {
      const feats = await loadCell(cell, { offlineOnly: true });
      for (const f of filterBbox(feats, r.bbox)) {
        if (f.properties.a < (r.options?.minAreaKm2 ?? DEFAULTS.minAreaKm2)) continue;
        if (!seen.has(f.properties.id)) seen.set(f.properties.id, f);
      }
    }
  }
  state.lakes = [...seen.values()];
  await scoreFeatures(state.lakes, state.mode);
  state.byId = new Map(state.lakes.map((f) => [f.properties.id, f]));
  map.getSource('lakes')?.setData(fc(state.lakes));
  map.getSource('regions')?.setData(fc(state.regions.map((r) => boxFeature(r.bbox))));
  renderRegions();
  renderSpots();
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
  for (const { f, d } of list) {
    const p = f.properties;
    const li = document.createElement('li');
    li.innerHTML = `<div class="score" style="background:${scoreColor(p.score)}">${p.score}</div>
      <div class="grow"><div class="name"></div>
      <div class="sub">${p.a.toFixed(1)} km² · ~${fmtH(estimateDriveHours(d))} drive${p.eff != null ? ` · ${p.eff} good hrs/yr` : ''}${state.mode === 'beginner' && p.d > 4 ? ' · deep' : ''}</div></div>`;
    li.querySelector('.name').textContent = lakeName(p);
    li.addEventListener('click', () => focusLake(f));
    ol.appendChild(li);
  }
  $('spots-hint').textContent = state.lakes.length
    ? `${list.length} of ${state.lakes.length} lakes shown, best first, from ${state.home.name}.` +
      (state.mode === 'snow' ? ' Snowkite mode ranks lakes by open space and wind in months when they are likely frozen.' : '') +
      (state.mode === 'beginner' ? ' Beginner mode favors shallow lakes and 12 to 22 kn wind.' : '')
    : 'No lakes yet. Download a region in the Regions tab.';
}
['f-area', 'f-drive', 'f-name', 'f-view'].forEach((id) => $(id).addEventListener('input', renderSpots));
$('f-mode').addEventListener('change', async () => {
  state.mode = $('f-mode').value;
  await backend.kvSet('mode', state.mode);
  await scoreFeatures(state.lakes, state.mode);
  map.getSource('lakes')?.setData(fc(state.lakes));
  renderSpots();
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
    const col = suit[d] >= 0.8 ? '#2a9d55' : suit[d] >= 0.5 ? '#e0a92e' : '#b8c3cf';
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
  const el = document.createElement('div');
  el.className = 'pop';
  el.innerHTML = `<h4></h4>
    <div class="sub">${p.t === 2 ? 'Reservoir' : 'Lake'}${p.c ? ' · ' + p.c : ''}</div>
    <div class="sub drive">~${fmtH(estimateDriveHours(d))} drive (${fmtMi(d)} straight line) from ${esc(state.home.name)}</div>
    <div style="margin:4px 0">${badges(p, wind)}</div>
    <div class="rose">${roseSvg(wind, suit)}
      <div><div class="score" style="background:${scoreColor(p.score)};width:44px;height:44px;border-radius:22px;font-size:16px">${p.score}</div>
      <div class="sub" style="margin-top:4px">${scoreText(p)}</div></div></div>
    <div class="sub">Petal length: kiteable daylight wind (12 to 35 kn) from that direction. Green: lake works well for that wind.</div>
    <table>
      <tr><td>Area</td><td>${p.a.toFixed(2)} km² (${Math.round(p.a * 247.1)} acres)</td></tr>
      <tr><td>Longest open run</td><td>${fmtKm(maxFetch)} (${(maxFetch * 0.621).toFixed(1)} mi)</td></tr>
      <tr><td>Best wind from</td><td>${best.length ? best.slice(0, 5).join(', ') : 'none, the lake is small or narrow'}</td></tr>
      ${wind ? `<tr><td>Kiteable hours</td><td>${wind.kiteHours} daylight hrs/yr (${wind.year})</td></tr><tr><td>Mean wind</td><td>${wind.meanKn} kn</td></tr>` : ''}
      ${p.s ? `<tr><td>Shoreline</td><td>${fmtKm(p.s)}</td></tr>` : ''}
      ${p.d ? `<tr><td>Average depth</td><td>${p.d} m (${(p.d * 3.28).toFixed(0)} ft)${p.d > 4 ? ', expect to swim after falls' : ''}</td></tr>` : ''}
      ${p.e != null ? `<tr><td>Elevation</td><td>${p.e} m</td></tr>` : ''}
    </table>
    ${monthSvg(wind)}
    <div class="actions"><button class="save">Save spot</button><button class="fcbtn">7-day forecast</button><button class="gmap">Copy coordinates</button></div>
    <div class="fc"></div>`;
  el.querySelector('h4').textContent = lakeName(p);
  el.querySelector('.save').onclick = () => saveSpot(lat, lon, lakeName(p), p.id);
  el.querySelector('.gmap').onclick = () => {
    navigator.clipboard?.writeText(`${lat.toFixed(5)}, ${lon.toFixed(5)}`);
    toast('Coordinates copied');
  };
  el.querySelector('.fcbtn').onclick = () => showForecast(el.querySelector('.fc'), lat, lon, suit);
  popup?.remove();
  popup = new maplibregl.Popup({ maxWidth: '360px' }).setLngLat(lngLat).setDOMContent(el).addTo(map);
  if (navigator.onLine) fillDrive(el, lon, lat);
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
  const known = KNOWN_SPOTS.find((k) => pointInLakeSafe(p, k));
  if (known) out.push(`<span class="badge good">Known kite spot</span>`);
  if (p.d != null) {
    const f = depthFactor(p.d);
    if (f >= 0.85) out.push('<span class="badge good">Shallow on average</span>');
    else if (f <= 0.45) out.push('<span class="badge warn">Deep</span>');
  }
  if (iceMonths(wind).length) out.push('<span class="badge">Freezes in winter</span>');
  return out.join('');
}

function pointInLakeSafe(p, k) {
  const f = state.byId.get(p.id);
  return f ? pointInLake(f, k.lon, k.lat) : false;
}

async function showForecast(box, lat, lon, suit) {
  box.textContent = 'Loading forecast...';
  try {
    const r = await forecast(lat, lon);
    const h = r.hourly;
    const days = new Map();
    for (let i = 0; i < h.time.length; i++) {
      const [day, time] = h.time[i].split('T');
      const hr = +time.slice(0, 2);
      if (hr < 9 || hr > 19) continue;
      const s = h.wind_speed_10m[i];
      const dir = Math.round((h.wind_direction_10m[i] % 360) / 22.5) % 16;
      const e = days.get(day) || { good: 0, ok: 0, max: 0, dirs: new Array(16).fill(0) };
      if (s >= 12 && s <= 35) {
        e.ok++;
        e.dirs[dir]++;
        if (!suit || suit[dir] >= 0.6) e.good++;
      }
      e.max = Math.max(e.max, h.wind_gusts_10m[i] ?? s);
      days.set(day, e);
    }
    box.innerHTML = '<b>Kiteable daylight hours (12 to 35 kn)</b>';
    const verdicts = groupDays(r, suit);
    for (const [day, e] of days) {
      const top = e.dirs.indexOf(Math.max(...e.dirs));
      const row = document.createElement('div');
      const name = new Date(day + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      const v = verdicts.get(day)?.verdict || 'no';
      row.innerHTML = `<span><span class="v-${v}" style="padding:0 5px">${v.toUpperCase()}</span> ${name}</span><span>${e.ok ? `${e.ok} h from ${DIRS16[top]}${e.good ? `, ${e.good} h good here` : ''}` : 'too light or too strong'} · gusts ${Math.round(e.max)} kn</span>`;
      box.appendChild(row);
    }
  } catch (e) {
    box.textContent = 'Forecast needs an internet connection.';
  }
}

/** Per-day verdicts from an Open-Meteo hourly forecast (local times). */
function groupDays(r, suit) {
  const h = r.hourly;
  const days = new Map();
  for (let i = 0; i < h.time.length; i++) {
    const [day, time] = h.time[i].split('T');
    const hr = +time.slice(0, 2);
    if (!days.has(day)) days.set(day, []);
    if (hr < 9 || hr > 19) continue;
    days.get(day).push({ kn: h.wind_speed_10m[i], dir: h.wind_direction_10m[i] });
  }
  const out = new Map();
  for (const [day, hours] of days) out.set(day, dayVerdict(hours, suit));
  return out;
}

// ---------- Forecast tab ----------

function lakeAt(lon, lat, lakeId) {
  if (lakeId != null && state.byId.has(lakeId)) return state.byId.get(lakeId);
  return state.lakes.find((f) => pointInLake(f, lon, lat)) || null;
}

function forecastTargets() {
  const t = state.saved.map((s) => ({ name: s.name, lat: s.lat, lon: s.lon, lakeId: s.lakeId }));
  if ($('fc-known').checked) for (const k of KNOWN_SPOTS) if (!t.some((x) => Math.abs(x.lat - k.lat) < 0.02 && Math.abs(x.lon - k.lon) < 0.02)) t.push({ name: k.name, lat: k.lat, lon: k.lon });
  return t;
}

$('fc-refresh').onclick = async () => {
  const targets = forecastTargets();
  if (!targets.length) return ($('fc-status').textContent = 'Save a spot first (click a lake, then Save spot).');
  $('fc-status').textContent = 'Checking forecast...';
  try {
    const results = await forecastMany(targets.map((t) => [t.lat, t.lon]));
    state.fcData = { fetched: Date.now(), targets, results };
    await backend.kvSet('forecast/last', state.fcData);
    renderForecast();
  } catch (e) {
    $('fc-status').textContent = 'The forecast needs an internet connection.' + (state.fcData ? ' Showing the last one.' : '');
  }
};
$('fc-known').onchange = () => $('fc-refresh').click();

function renderForecast() {
  const data = state.fcData;
  if (!data) return;
  const age = (Date.now() - data.fetched) / 3600e3;
  $('fc-status').textContent = `Updated ${new Date(data.fetched).toLocaleString()}${age > 12 ? ' (old, check again when online)' : ''}. Drive times are estimates from ${state.home.name}.`;
  const rows = data.targets.map((t, i) => {
    const lake = lakeAt(t.lon, t.lat, t.lakeId);
    const days = groupDays(data.results[i], lake ? lake.properties._suit : null);
    return { t, lake, days, drive: estimateDriveHours(distanceFromHome({ properties: { _c: [t.lon, t.lat] } }, state.home)) };
  });
  rows.sort((a, b) => countGo(b.days) - countGo(a.days) || a.drive - b.drive);
  const dayKeys = [...(rows[0]?.days.keys() || [])].slice(0, 7);
  const table = document.createElement('table');
  table.className = 'fc-grid';
  table.innerHTML = `<tr><th></th><th>Drive</th>${dayKeys.map((d) => `<th>${new Date(d + 'T12:00').toLocaleDateString(undefined, { weekday: 'short' })}<br>${+d.slice(8)}</th>`).join('')}</tr>`;
  for (const r of rows) {
    const tr = document.createElement('tr');
    const cells = dayKeys
      .map((d) => {
        const v = r.days.get(d);
        if (!v) return '<td></td>';
        const tip = `${v.kite} h kiteable${v.topDir != null ? ', mostly from ' + DIRS16[v.topDir] : ''}${r.lake ? `, ${v.good} h from a good direction here` : ''}`;
        return `<td title="${tip}"><span class="v-${v.verdict}" style="display:block;padding:2px 0">${v.verdict === 'no' ? '·' : r.lake ? v.good : v.kite}</span></td>`;
      })
      .join('');
    tr.innerHTML = `<td class="spot"></td><td>${fmtH(r.drive)}</td>${cells}`;
    tr.querySelector('.spot').textContent = r.t.name;
    tr.querySelector('.spot').title = r.lake ? 'Hours shown: good-direction kiteable hours' : 'No lake data here yet: hours shown are kiteable hours from any direction';
    tr.querySelector('.spot').onclick = () => (r.lake ? focusLake(r.lake) : map.flyTo({ center: [r.t.lon, r.t.lat], zoom: 11 }));
    table.appendChild(tr);
  }
  $('fc-table').innerHTML = '';
  $('fc-table').appendChild(table);
}

const countGo = (days) => [...days.values()].filter((v) => v.verdict === 'go').length;

// ---------- Reference spots ----------

map.on('click', 'known-pt', (e) => {
  const k = KNOWN_SPOTS[e.features[0].properties.i];
  const lake = lakeAt(k.lon, k.lat);
  if (lake) return showLakePopup(lake, [k.lon, k.lat]);
  const el = document.createElement('div');
  el.className = 'pop';
  const d = distanceFromHome({ properties: { _c: [k.lon, k.lat] } }, state.home);
  el.innerHTML = `<h4></h4><div class="sub"></div><p></p><div class="sub drive">~${fmtH(estimateDriveHours(d))} drive from ${esc(state.home.name)}</div>
    <p class="sub">Download this area in the Regions tab to see its lake score and wind.</p>
    <div class="actions"><button class="save">Save spot</button><button class="fcbtn">7-day forecast</button></div><div class="fc"></div>`;
  el.querySelector('h4').textContent = k.name;
  el.querySelector('.sub').textContent = k.region + (k.school ? ' · School: ' + k.school : '');
  el.querySelector('p').textContent = k.note;
  el.querySelector('.save').onclick = () => saveSpot(k.lat, k.lon, k.name);
  el.querySelector('.fcbtn').onclick = () => showForecast(el.querySelector('.fc'), k.lat, k.lon, null);
  popup?.remove();
  popup = new maplibregl.Popup({ maxWidth: '340px' }).setLngLat([k.lon, k.lat]).setDOMContent(el).addTo(map);
  if (navigator.onLine) fillDrive(el, k.lon, k.lat);
});
map.on('mouseenter', 'known-pt', () => (map.getCanvas().style.cursor = 'pointer'));
map.on('mouseleave', 'known-pt', () => (map.getCanvas().style.cursor = ''));

map.on('click', 'lake-fill', (e) => {
  if (map.queryRenderedFeatures(e.point, { layers: ['known-pt'] }).length) return;
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
$('l-known').onchange = (e) => ['known-pt', 'known-label'].forEach((id) => map.setLayoutProperty(id, 'visibility', e.target.checked ? 'visible' : 'none'));
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
  return { ...DEFAULTS, geology: $('dl-geo').checked };
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
  if (!confirm('Delete all downloaded maps, lakes and wind data? Saved spots are kept.')) return;
  await backend.cacheDeletePrefix('');
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

window.__kite = { state, map, status };
