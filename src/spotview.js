// 3D spot view: stand on the shore of a launch, in 3D terrain with satellite
// imagery and 3D buildings and trees, with kite guidance drawn on the water:
// wind arrows, the launch, the riding area, the downwind keep-clear zone and
// the gusty wind shadow behind trees, buildings and hills. Everything comes
// from saved tiles and the shore analysis, so it works offline too (the
// satellite and terrain tiles need to have been downloaded for that area).

import { DIRS16 } from './geo.js';
import { SOURCE_NAMES } from './site.js';
import { angleWord } from './spotscore.js';
import { iceMonths } from './scoring.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fc = (features) => ({ type: 'FeatureCollection', features });
const fmtM = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`);
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Point `m` metres from [lon, lat] toward compass bearing `deg`. */
export function offset([lon, lat], deg, m) {
  const a = (deg * Math.PI) / 180;
  return [lon + (Math.sin(a) * m) / (111320 * Math.cos((lat * Math.PI) / 180)), lat + (Math.cos(a) * m) / 110540];
}

/** Rectangle around centre: `len` m along bearing `deg`, `wid` m across. */
function rect(center, deg, len, wid) {
  const a = offset(center, deg, len / 2), b = offset(center, deg + 180, len / 2);
  const ring = [offset(a, deg + 90, wid / 2), offset(a, deg - 90, wid / 2), offset(b, deg - 90, wid / 2), offset(b, deg + 90, wid / 2)];
  ring.push(ring[0]);
  return { type: 'Polygon', coordinates: [ring] };
}

function circle(center, r, n = 24) {
  const ring = [];
  for (let i = 0; i <= n; i++) ring.push(offset(center, (i * 360) / n, r));
  return { type: 'Polygon', coordinates: [ring] };
}

const feat = (geometry, properties = {}) => ({ type: 'Feature', geometry, properties });
const faceDeg = (face) => Math.max(0, DIRS16.indexOf(face)) * 22.5;

/** Kite guidance shapes for wind from direction d at launch candidate c. */
export function guideShapes(c, d) {
  const [th, W, open, sh, , , reach] = c.dirs[d];
  const from = d * 22.5, to = from + 180;
  const pt = [c.lon, c.lat];
  const water = faceDeg(c.face); // from the shore out over the water
  const zones = [];
  zones.push(feat(circle(pt, 35), { kind: 'launch', label: 'Launch / land' }));
  // Riding area: out from the shore, back and forth across the wind.
  const ride = offset(pt, water, 280);
  zones.push(feat(rect(ride, from + 90, Math.max(200, Math.min(reach || 400, 1400)), 420), { kind: 'ride', label: 'Riding area (approx.)' }));
  // Downwind of the launch: where you get dragged if the kite powers up.
  zones.push(feat(rect(offset(pt, to, 70), to, 140, 90), { kind: 'downwind', label: 'Keep clear downwind' }));
  // Wind shadow behind the upwind shore.
  if (!open && sh > 30 && W > 0) {
    const shore = offset(pt, from, W);
    const len = Math.min(sh, W);
    zones.push(feat(rect(offset(shore, to, len / 2), to, len, 350), { kind: 'shadow', label: 'Gusty wind shadow' }));
  }
  // Wind arrows over the water, flowing downwind.
  const arrows = [];
  for (let i = -2; i <= 2; i++) for (let j = 0; j < 3; j++) {
    const p = offset(offset(ride, from + 90, i * 260), from, (j - 1) * 300);
    const a = offset(p, from, 90), b = offset(p, to, 90);
    arrows.push(feat({ type: 'LineString', coordinates: [a, b] }));
    // Arrowhead as a chevron (drawn as lines, so no font is needed offline).
    arrows.push(feat({ type: 'LineString', coordinates: [offset(b, from + 35, 45), b, offset(b, from - 35, 45)] }));
  }
  return { zones, arrows, th, W, open, sh, reach, center: ride, water };
}

let saved = null;
let state = null;

const ensureLayers = (map) => {
  if (!map.getSource('dem3d')) {
    const dem = map.getStyle().sources.dem;
    map.addSource('dem3d', { ...dem });
  }
  if (!map.getSource('sv')) {
    map.addSource('sv', { type: 'geojson', data: fc([]) });
    map.addSource('sv-arrows', { type: 'geojson', data: fc([]) });
  }
  const add = (layer, before) => !map.getLayer(layer.id) && map.addLayer(layer, before);
  add({
    id: 'sv-trees', type: 'fill-extrusion', source: 'protomaps', 'source-layer': 'landuse', minzoom: 12,
    filter: ['in', ['get', 'kind'], ['literal', ['wood', 'forest', 'orchard', 'park']]],
    paint: { 'fill-extrusion-color': '#2f6b3a', 'fill-extrusion-height': ['match', ['get', 'kind'], 'orchard', 6, 'park', 8, 18], 'fill-extrusion-opacity': 0.55 },
  });
  add({
    id: 'sv-buildings', type: 'fill-extrusion', source: 'protomaps', 'source-layer': 'buildings', minzoom: 13,
    paint: { 'fill-extrusion-color': '#d9d4cc', 'fill-extrusion-height': ['coalesce', ['get', 'height'], 8], 'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0], 'fill-extrusion-opacity': 0.9 },
  });
  const zoneColor = ['match', ['get', 'kind'], 'launch', '#2a9d55', 'ride', '#1e88e5', 'downwind', '#e53935', 'shadow', '#7e57c2', '#999'];
  add({ id: 'sv-zone-fill', type: 'fill', source: 'sv', paint: { 'fill-color': zoneColor, 'fill-opacity': ['match', ['get', 'kind'], 'ride', 0.18, 0.3] } });
  add({ id: 'sv-zone-line', type: 'line', source: 'sv', paint: { 'line-color': zoneColor, 'line-width': 2, 'line-dasharray': [2, 1] } });
  add({ id: 'sv-arrow', type: 'line', source: 'sv-arrows', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 3, 'line-opacity': 0.95 } });
  add({
    id: 'sv-zone-label', type: 'symbol', source: 'sv',
    layout: { 'text-field': ['get', 'label'], 'text-size': 12, 'text-font': ['Noto Sans Medium'], 'text-allow-overlap': true },
    paint: { 'text-color': '#ffffff', 'text-halo-color': '#1d2733', 'text-halo-width': 1.5 },
  });
};

const SV_LAYERS = ['sv-trees', 'sv-buildings', 'sv-zone-fill', 'sv-zone-line', 'sv-arrow', 'sv-zone-label'];

/**
 * Open the 3D view. opts: { title, raw, s (scoreSite result), wind, ci (launch
 * candidate index, optional), forecastNow: async () => {dir, kn, gust} | null }
 */
export function enterSpotView(map, opts) {
  if (!saved) {
    saved = {
      camera: { center: map.getCenter(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() },
      sat: map.getLayoutProperty('satellite', 'visibility'),
      maxPitch: map.getMaxPitch(),
    };
  }
  ensureLayers(map);
  for (const id of SV_LAYERS) map.setLayoutProperty(id, 'visibility', 'visible');
  map.setMaxPitch(85);
  map.setTerrain({ source: 'dem3d', exaggeration: 1.4 });
  map.setLayoutProperty('satellite', 'visibility', 'visible');
  try { map.setSky({ 'sky-color': '#8cc4ef', 'horizon-color': '#dceefc', 'fog-color': '#e8f2fa', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.5, 'fog-ground-blend': 0.6 }); } catch {}

  const H = opts.s.hours || new Array(16).fill(1);
  const order = [...Array(16).keys()].sort((a, b) => H[b] * opts.s.Q[b] - H[a] * opts.s.Q[a]);
  state = { map, opts, order, d: order[0], live: null };
  buildPanel();
  setDir(state.d, true);
  if (navigator.onLine && opts.forecastNow) {
    opts.forecastNow().then((now) => {
      if (!now || !state) return;
      state.live = now;
      const kiteable = now.kn >= 12 && now.kn <= 35;
      const d = kiteable ? Math.round(now.dir / 22.5) % 16 : state.d;
      buildPanel();
      setDir(d, false);
    }).catch(() => {});
  }
}

export function exitSpotView() {
  if (!state) return;
  const { map } = state;
  for (const id of SV_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
  map.setTerrain(null);
  map.setLayoutProperty('satellite', 'visibility', saved.sat || 'none');
  map.setMaxPitch(saved.maxPitch);
  map.easeTo({ ...saved.camera, padding: { left: 0, top: 0, right: 0, bottom: 0 }, duration: 800 });
  document.getElementById('sv-panel')?.remove();
  saved = null;
  state = null;
}

export const inSpotView = () => !!state;

function launchFor(d) {
  const { raw, s, ci } = state.opts;
  const idx = ci ?? s.best[d]?.ci ?? 0;
  return raw.cand[idx];
}

// Keep the launch in the part of the map the guide panel does not cover.
const panelPadding = () => (window.innerWidth > 900 ? { left: 340, top: 0, right: 0, bottom: 0 } : { left: 0, top: 0, right: 0, bottom: 0 });

function setDir(d, fly) {
  state.d = d;
  const c = launchFor(d);
  const g = guideShapes(c, d);
  const { map } = state;
  map.getSource('sv').setData(fc(g.zones));
  map.getSource('sv-arrows').setData(fc(g.arrows));
  // Stand on the shore behind the launch, looking out over the water.
  map.easeTo({ center: offset([c.lon, c.lat], g.water, 220), zoom: 15.6, pitch: 72, bearing: g.water, padding: panelPadding(), duration: fly ? 1800 : 900 });
  // The ground height under the view only updates when the camera moves. If
  // the terrain tiles arrive after the flight ends, the camera can be left
  // below the ground (a blank view), so nudge it once they have loaded.
  map.once('moveend', () => {
    const fix = () => state && map.jumpTo({ center: map.getCenter() });
    fix();
    map.once('idle', fix);
  });
  renderGuide(c, d, g);
  document.querySelectorAll('#sv-panel .sv-dirs button').forEach((b) => b.classList.toggle('on', +b.dataset.d === d));
}

function buildPanel() {
  document.getElementById('sv-panel')?.remove();
  const { opts, order, live } = state;
  const H = opts.s.hours;
  const el = document.createElement('div');
  el.id = 'sv-panel';
  const chips = order.slice(0, 6).filter((d) => opts.s.Q[d] > 0.05 || d === order[0]);
  el.innerHTML = `<div class="sv-head"><b></b><button class="sv-exit" title="Back to the map">✕ Exit 3D</button></div>
    <div class="sv-sub">Score ${opts.s.score}${opts.s.eff != null ? ` · ${opts.s.eff} good hrs/yr` : ''}. Drag to pan, right-drag (or Ctrl+drag) to look around.</div>
    ${live ? `<div class="sv-live">Now: ${Math.round(live.kn)} kn from ${DIRS16[Math.round(live.dir / 22.5) % 16]}${live.gust ? `, gusts ${Math.round(live.gust)}` : ''} ${live.kn >= 12 && live.kn <= 35 ? '✔ kiteable' : live.kn < 12 ? '(too light)' : '(too strong)'}</div>` : ''}
    <div class="sv-label">Show the setup for wind from</div>
    <div class="sv-dirs">${chips.map((d) => `<button data-d="${d}">${DIRS16[d]}${H ? `<small>${H[d]} h</small>` : ''}</button>`).join('')}</div>
    <div class="sv-orbit"><button data-r="-30">⟲ Turn left</button><button data-r="30">Turn right ⟳</button><button data-top="1">Top view</button></div>
    <div class="sv-guide"></div>
    <div class="sv-legend"><span style="--c:#2a9d55"></span>Launch <span style="--c:#1e88e5"></span>Riding area <span style="--c:#e53935"></span>Keep clear <span style="--c:#7e57c2"></span>Gusty shadow <span style="--c:#2f6b3a"></span>Trees</div>`;
  el.querySelector('b').textContent = opts.title;
  el.querySelector('.sv-exit').onclick = exitSpotView;
  el.querySelectorAll('.sv-dirs button').forEach((b) => (b.onclick = () => setDir(+b.dataset.d, false)));
  el.querySelectorAll('.sv-orbit button').forEach((b) => (b.onclick = () => {
    const m = state.map;
    if (b.dataset.top) m.easeTo({ pitch: m.getPitch() > 30 ? 0 : 72, duration: 800 });
    else m.easeTo({ bearing: m.getBearing() + +b.dataset.r, duration: 700 });
  }));
  document.getElementById('map').appendChild(el);
}

function renderGuide(c, d, g) {
  const { opts } = state;
  const wind = opts.wind;
  const H = opts.s.hours;
  const q = opts.s.Q[d];
  const word = angleWord(g.th);
  const lines = [];
  lines.push(`<p><b>${DIRS16[d]} wind${H ? ` (${H[d]} kiteable h/yr)` : ''}:</b> ${word} at this launch (beach faces ${c.face}). ${q >= 0.6 ? 'Works well.' : q >= 0.35 ? 'Workable.' : 'Poor setup for this direction.'}</p>`);
  const items = [];
  items.push(g.open ? 'Open water upwind: clean, steady wind.' : `${fmtM(g.W)} of open water upwind.`);
  if (!g.open && g.sh > 30) items.push(`${SOURCE_NAMES[c.dirs[d][4]] || 'Obstacles'} on the upwind shore (about ${c.dirs[d][5]} m) make the first ${fmtM(Math.min(g.sh, g.W))} gusty (purple). Ride beyond it.`);
  items.push(`About ${fmtM(g.reach)} of water to ride back and forth.`);
  if (word === 'onshore' || word === 'side-onshore') items.push('Beginner-friendly direction: the wind pushes you back toward shore.');
  else if (word === 'side-shore') items.push('Side-shore: fine for most riders. Drift along the shore and walk back.');
  else items.push('<b>Not for beginners:</b> the wind blows you away from shore. Only on standable shallow flats or with a boat.');
  items.push('Keep the red zone clear: if the kite powers up while launching, you get dragged downwind into it. Leave 2 line lengths (50 m) of space.');
  if (c.access != null) items.push(c.access <= 300 ? `Road about ${fmtM(c.access)} away: park there and walk in.` : `Nearest road is about ${fmtM(c.access)} away: plan the walk in.`);
  if (c.river) items.push(`River about ${fmtM(c.width || 0)} wide: wind against the current makes steep chop, and you drift downstream. Watch for barges, snags and sandbars.`);
  if (c.bridge != null) items.push(`Bridge or causeway ${fmtM(c.bridge)} away: stay well clear.`);
  items.push('Not on the map: power lines, docks, swimmers, weed beds and depth. Look for them before you launch.');
  lines.push(`<ul>${items.map((t) => `<li>${t}</li>`).join('')}</ul>`);
  if (wind?.byMonth) {
    const best = [...Array(12).keys()].sort((a, b) => wind.byMonth[b] - wind.byMonth[a]).slice(0, 3).sort((a, b) => a - b);
    const ice = iceMonths(wind);
    lines.push(`<p><b>Windiest months:</b> ${best.map((m) => MONTHS[m]).join(', ')}.${ice.length ? ` Likely frozen (snowkiting): ${ice.map((m) => MONTHS[m]).join(', ')}.` : ''}</p>`);
  }
  document.querySelector('#sv-panel .sv-guide').innerHTML = lines.join('');
}

export { esc };
