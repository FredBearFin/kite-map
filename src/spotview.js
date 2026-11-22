// 3D spot view: stand on the shore of a launch, in 3D terrain with satellite
// imagery and 3D buildings and trees, and watch how a kite session works there.
// Animated wind flows over the water (slow and gusty in the shadow of trees,
// buildings and hills), a rider and kite show the wind window, launching,
// riding, holding ground upwind, landing, and where you drift if it goes
// wrong. A step-by-step guide walks through it, and sliders change the wind
// direction and speed. Everything comes from saved tiles and the shore
// analysis, so it works offline too.

import { DIRS16 } from './geo.js';
import { SOURCE_NAMES } from './site.js';
import { angleWord } from './spotscore.js';
import { iceMonths } from './scoring.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fc = (features) => ({ type: 'FeatureCollection', features });
const fmtM = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`);
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const rad = (x) => (x * Math.PI) / 180;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, f) => a + (b - a) * f;
const ease = (f) => 0.5 - 0.5 * Math.cos(Math.PI * clamp(f, 0, 1));

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

/** Pie slice from bearing a0 to a1 (clockwise), radius r0..r. */
function sector(center, a0, a1, r, r0 = 0, n = 16) {
  const ring = [];
  for (let i = 0; i <= n; i++) ring.push(offset(center, lerp(a0, a1, i / n), r));
  if (r0 > 0) for (let i = n; i >= 0; i--) ring.push(offset(center, lerp(a0, a1, i / n), r0));
  else ring.push(center);
  ring.push(ring[0]);
  return { type: 'Polygon', coordinates: [ring] };
}

const feat = (geometry, properties = {}) => ({ type: 'Feature', geometry, properties });
const line = (coords, properties) => feat({ type: 'LineString', coordinates: coords }, properties);
const point = (c, properties) => feat({ type: 'Point', coordinates: c }, properties);
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
  let shadow = null;
  if (!open && sh > 30 && W > 0) {
    const shore = offset(pt, from, W);
    const len = Math.min(sh, W);
    shadow = { start: -W, end: -W + len };
    zones.push(feat(rect(offset(shore, to, len / 2), to, len, 350), { kind: 'shadow', label: 'Gusty wind shadow' }));
  }
  // Where you drift if you let go: straight downwind to the next shore. The
  // open water downwind of the launch is the fetch for the opposite wind.
  const opp = c.dirs[(d + 8) % 16];
  const rideU = 280 * Math.cos(rad(water - to)), rideV = 280 * Math.cos(rad(water - (from + 90)));
  const drift = opp ? (opp[2] ? Infinity : Math.max(40, opp[1] - rideU)) : 300;
  return { zones, th, W, open, sh, reach, center: ride, water, from, to, launch: pt, rideU, rideV, shadow, drift };
}

/** Wind speed verdict for a rider of about 80 kg. */
export function windVerdict(kn) {
  const size = clamp(Math.round((80 * 2.2) / Math.max(kn, 1)), 5, 17);
  if (kn < 10) return { kind: 'bad', text: 'Too light: the kite falls out of the sky.' };
  if (kn < 12) return { kind: 'warn', text: `Light: only with a big kite (${size}+ m²) and a light rider.` };
  if (kn <= 20) return { kind: 'good', text: `Good for learning. About a ${size} m² kite for an 80 kg rider.` };
  if (kn <= 28) return { kind: 'warn', text: `Strong: small kite (about ${size} m²), experienced riders.` };
  if (kn <= 35) return { kind: 'warn', text: `Very strong: experts only, ${size} m² or smaller.` };
  return { kind: 'bad', text: 'Too strong: stay on the beach.' };
}

let saved = null;
let state = null;

const ensureLayers = (map) => {
  if (!map.getSource('dem3d')) {
    const dem = map.getStyle().sources.dem;
    map.addSource('dem3d', { ...dem });
  }
  for (const id of ['sv', 'sv-wind', 'sv-fx', 'sv-3d', 'sv-labels']) if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: fc([]) });
  const add = (layer) => !map.getLayer(layer.id) && map.addLayer(layer);
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
  add({ id: 'sv-zone-fill', type: 'fill', source: 'sv', paint: { 'fill-color': zoneColor, 'fill-opacity': ['match', ['get', 'kind'], 'ride', 0.14, 0.28] } });
  add({ id: 'sv-zone-line', type: 'line', source: 'sv', paint: { 'line-color': zoneColor, 'line-width': 2, 'line-dasharray': [2, 1] } });
  // Wind window: power zone and the softer sides, drawn on the water.
  add({
    id: 'sv-window', type: 'fill', source: 'sv-fx', filter: ['==', ['geometry-type'], 'Polygon'],
    paint: { 'fill-color': ['match', ['get', 'kind'], 'power', '#ff6d00', '#ffd600'], 'fill-opacity': ['match', ['get', 'kind'], 'power', 0.5, 0.32] },
  });
  // Animated wind streaks.
  add({
    id: 'sv-wind', type: 'line', source: 'sv-wind', layout: { 'line-cap': 'round' },
    paint: {
      'line-color': ['match', ['get', 'zone'], 'gust', '#d1b3ff', 'land', '#e9f2e0', '#ffffff'],
      'line-width': ['match', ['get', 'zone'], 'gust', 1.8, 2.4],
      'line-opacity': ['*', ['get', 'a'], ['match', ['get', 'zone'], 'land', 0.55, 0.9]],
    },
  });
  // Paths: wake behind the rider, the riding path, drift, the window edge.
  add({
    id: 'sv-path', type: 'line', source: 'sv-fx', filter: ['all', ['==', ['geometry-type'], 'LineString'], ['!=', ['get', 'kind'], 'drifty']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['match', ['get', 'kind'], 'wake', '#ffffff', 'edge', '#fff176', 'drift', '#ff1744', 'drifty', '#ff8a80', 'upwind', '#69f0ae', '#80d8ff'],
      'line-width': ['match', ['get', 'kind'], 'wake', 2, 'edge', 3, 'drift', 4, 'upwind', 4, 2.5],
      'line-opacity': ['match', ['get', 'kind'], 'wake', 0.8, 1],
    },
  });
  add({
    id: 'sv-path-dash', type: 'line', source: 'sv-fx', filter: ['==', ['get', 'kind'], 'drifty'],
    paint: { 'line-color': '#ff8a80', 'line-width': 3, 'line-dasharray': [2, 2] },
  });
  // Rider, kite and lines, floating in 3D (drawn bigger than real).
  add({
    id: 'sv-3d', type: 'fill-extrusion', source: 'sv-3d',
    paint: {
      'fill-extrusion-color': ['match', ['get', 'part'], 'kite', '#ff2d78', 'rider', '#ffd400', 'helper', '#00e5ff', 'board', '#263238', '#ffffff'],
      'fill-extrusion-base': ['get', 'b'], 'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-opacity': 1,
    },
  });
  add({
    id: 'sv-zone-label', type: 'symbol', source: 'sv',
    layout: { 'text-field': ['get', 'label'], 'text-size': 12, 'text-font': ['Noto Sans Medium'], 'text-allow-overlap': true },
    paint: { 'text-color': '#ffffff', 'text-halo-color': '#1d2733', 'text-halo-width': 1.5 },
  });
  add({
    id: 'sv-label', type: 'symbol', source: 'sv-labels',
    layout: { 'text-field': ['get', 'label'], 'text-size': ['coalesce', ['get', 'size'], 13], 'text-font': ['Noto Sans Medium'], 'text-allow-overlap': true, 'text-offset': ['coalesce', ['get', 'off'], ['literal', [0, 0]]] },
    paint: { 'text-color': ['coalesce', ['get', 'color'], '#ffffff'], 'text-halo-color': '#1d2733', 'text-halo-width': 1.8 },
  });
};

const SV_LAYERS = ['sv-trees', 'sv-buildings', 'sv-zone-fill', 'sv-zone-line', 'sv-window', 'sv-wind', 'sv-path', 'sv-path-dash', 'sv-3d', 'sv-zone-label', 'sv-label'];

// The guided steps: which zones show, how the rider moves, where the camera goes.
const STEPS = [
  { key: 'wind', name: 'The wind', zones: ['shadow', 'launch'] },
  { key: 'launch', name: 'Launch', zones: ['launch', 'downwind'] },
  { key: 'ride', name: 'Ride', zones: ['ride', 'launch'] },
  { key: 'upwind', name: 'Stay upwind', zones: ['ride', 'launch'] },
  { key: 'land', name: 'Come back & land', zones: ['launch', 'downwind'] },
  { key: 'bail', name: 'If it goes wrong', zones: ['launch'] },
];

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
  // Let the satellite show through the flat map-colour water.
  if (!saved.water) {
    saved.water = [];
    for (const l of map.getStyle().layers) {
      if (l.type === 'fill' && l['source-layer'] === 'water') {
        saved.water.push([l.id, map.getPaintProperty(l.id, 'fill-opacity')]);
        map.setPaintProperty(l.id, 'fill-opacity', 0.15);
      }
    }
  }
  try { map.setSky({ 'sky-color': '#8cc4ef', 'horizon-color': '#dceefc', 'fog-color': '#e8f2fa', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.5, 'fog-ground-blend': 0.6 }); } catch {}

  const H = opts.s.hours || new Array(16).fill(1);
  const order = [...Array(16).keys()].sort((a, b) => H[b] * opts.s.Q[b] - H[a] * opts.s.Q[a]);
  stopAnim();
  state = { map, opts, order, d: order[0], kn: 18, step: 0, live: null, t: 0, playing: true, g: null, c: null };
  buildPanel();
  setDir(state.d);
  goStep(0, true);
  startAnim();
  if (navigator.onLine && opts.forecastNow) {
    opts.forecastNow().then((now) => {
      if (!now || !state) return;
      state.live = now;
      const kiteable = now.kn >= 12 && now.kn <= 35;
      if (kiteable) { state.kn = Math.round(now.kn); setDir(Math.round(now.dir / 22.5) % 16); }
      buildPanel();
      setDir(state.d);
      goStep(state.step, false);
    }).catch(() => {});
  }
}

export function exitSpotView() {
  if (!state) return;
  const { map } = state;
  stopAnim();
  for (const id of SV_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
  map.setTerrain(null);
  for (const [id, op] of saved.water || []) map.setPaintProperty(id, 'fill-opacity', op ?? 1);
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
const panelPadding = () => (window.innerWidth > 900 ? { left: 360, top: 0, right: 0, bottom: 0 } : { left: 0, top: 0, right: 0, bottom: 0 });

// ---------------------------------------------------------------------------
// Wind particles. Each streak travels downwind in its own lane. Its speed
// depends on where it is: full speed over open water, slow over the gusty
// strip behind the upwind shore, a bit slower over land. The position is a
// closed-form function of time, so any moment can be drawn exactly (the
// screenshots use that).

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function buildWind(g) {
  const r = rng(12345);
  // Reach back far enough upwind to show the gusty strip, when there is one.
  const u0 = Math.max(Math.min(g.rideU - 1000, g.shadow ? g.shadow.start - 250 : Infinity), g.rideU - 2600), u1 = g.rideU + 800;
  const v0 = g.rideV - 900, v1 = g.rideV + 900;
  // Speed bands along the wind (launch frame, u = metres downwind of the launch).
  const bands = [];
  const landEnd = g.open ? -Infinity : -g.W;
  const gust = g.shadow;
  const cuts = [u0, clamp(landEnd, u0, u1)];
  if (gust) cuts.push(clamp(gust.end, u0, u1));
  cuts.push(u1);
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i], b = cuts[i + 1];
    if (b - a < 1) continue;
    const zone = b <= landEnd + 1 ? 'land' : gust && a >= gust.start - 1 && b <= gust.end + 1 ? 'gust' : 'clean';
    bands.push({ a, b, zone, k: zone === 'gust' ? 0.38 : zone === 'land' ? 0.6 : 1 });
  }
  const parts = [];
  const n = Math.round(clamp((170 * (u1 - u0)) / 1800, 170, 300));
  for (let i = 0; i < n; i++) {
    const vary = 0.8 + 0.4 * r();
    let T = 0;
    for (const bd of bands) T += (bd.b - bd.a) / (bd.k * vary);
    parts.push({ v: lerp(v0, v1, r()), vary, T, ph: r(), seed: r() * 100 });
  }
  return { bands, parts };
}

/** u position (and zone) of a particle at time t, in m at a base speed of 1 m/s. */
function particleAt(p, bands, s) {
  let tau = (((s / p.T + p.ph) % 1) + 1) % 1 * p.T;
  for (const bd of bands) {
    const dt = (bd.b - bd.a) / (bd.k * p.vary);
    if (tau <= dt) return { u: bd.a + tau * bd.k * p.vary, zone: bd.zone, k: bd.k };
    tau -= dt;
  }
  const last = bands[bands.length - 1];
  return { u: last.b, zone: last.zone, k: last.k };
}

// ---------------------------------------------------------------------------
// Rider and kite.

const KITE_L = 60; // line length as drawn (real lines are about 22 m)

/** Point in the launch frame: u metres downwind, v metres across (to the right looking upwind... +v = from + 90). */
function at(g, u, v) {
  return offset(offset(g.launch, g.to, u), g.from + 90, v);
}

/** Riding loop around the ride centre: legs across the wind, turns at each end. */
function ridePose(g, t, kn) {
  const pace = kn < 10 ? 0.15 : clamp((kn - 6) / 12, 0.5, 1.3);
  const spd = 55 * pace;
  const A = clamp((g.reach || 400) / 2 - 80, 120, 520), b = 40;
  const leg = (2 * A) / spd, turn = (Math.PI * b) / spd, T = 2 * (leg + turn);
  let f = ((t % T) + T) % T;
  const low = kn < 10;
  const el = low ? 10 : 35;
  let u, v, az, e;
  if (f < leg) { const x = f / leg; v = -A + 2 * A * x; u = b - 2 * b * x; az = g.to - 50; e = el; }
  else if ((f -= leg) < turn) { const p = (f / turn) * Math.PI; u = -b * Math.cos(p); v = A + b * Math.sin(p); az = g.to - 50 + 100 * (p / Math.PI); e = el + (low ? 0 : 45) * Math.sin(p); }
  else if ((f -= turn) < leg) { const x = f / leg; v = A - 2 * A * x; u = b - 2 * b * x; az = g.to + 50; e = el; }
  else { f -= leg; const p = (f / turn) * Math.PI; u = -b * Math.cos(p); v = -A - b * Math.sin(p); az = g.to + 50 - 100 * (p / Math.PI); e = el + (low ? 0 : 45) * Math.sin(p); }
  return { u: g.rideU + u, v: g.rideV + v, az, e, T };
}

// Which side of the launch the kite goes up: toward the water side.
const kiteSide = (g) => (Math.cos(rad(g.water - (g.from + 90))) >= 0 ? -1 : 1);

function pose(g, step, t, kn) {
  const side = kiteSide(g);
  const edge = g.to + side * 85;
  if (step === 'ride' || step === 'upwind') return { ...ridePose(g, t, kn), window: true };
  if (step === 'launch') {
    const f = (t % 14) / 14;
    const e = f < 0.3 ? 3 : f < 0.75 ? lerp(3, 82, ease((f - 0.3) / 0.45)) : 82;
    const label = f < 0.3 ? 'Helper holds the kite at the edge' : f < 0.75 ? 'Fly it slowly up the edge' : 'Parked overhead: little pull';
    return { u: 0, v: 0, az: edge, e, window: true, helper: f < 0.3, label };
  }
  if (step === 'land') {
    const f = (t % 18) / 18;
    if (f < 0.55) {
      const x = ease(f / 0.55);
      return { u: lerp(g.rideU, -45, x), v: lerp(g.rideV, 0, x), az: g.to - side * 50, e: lerp(35, 70, x), window: true, label: 'Come in upwind of the launch' };
    }
    if (f < 0.7) { const x = ease((f - 0.55) / 0.15); return { u: lerp(-45, 0, x), v: 0, az: edge, e: lerp(70, 82, x), window: true, label: 'Board off, walk to the launch' }; }
    const x = ease((f - 0.7) / 0.25);
    return { u: 0, v: 0, az: edge, e: lerp(82, 3, x), window: true, helper: x > 0.7, label: 'Bring it down the edge to a helper' };
  }
  if (step === 'bail') {
    const f = (t % 16) / 16;
    const len = Math.min(g.drift, 2500);
    const x = f < 0.15 ? 0 : ease((f - 0.15) / 0.8);
    return { u: g.rideU + len * x, v: g.rideV, az: g.to, e: f < 0.15 ? lerp(35, 0, f / 0.15) : 0, down: true, label: f < 0.15 ? 'Let go and pull the quick release' : 'Kite depowered: you drift downwind' };
  }
  return null;
}

function riderFeatures(g, P) {
  const out = [];
  const p = at(g, P.u, P.v);
  // Rider and board (drawn about 3 times real size so they show).
  out.push(feat(rect(p, P.az - 90, 4, 4), { part: 'rider', b: 0, h: 6 }));
  out.push(feat(rect(p, P.az - 90, 9, 2.5), { part: 'board', b: 0, h: 0.8 }));
  const er = rad(P.e);
  const L = KITE_L;
  const kp = offset(p, P.az, L * Math.cos(er));
  const kh = 5 + L * Math.sin(er);
  if (P.down) out.push(feat(rect(kp, P.az, 4, 16), { part: 'kite', b: 0, h: 0.8 }));
  else out.push(feat(rect(kp, P.az, 4, 16), { part: 'kite', b: kh - 1.2, h: kh + 1.2 }));
  // Lines as a row of small floating dots from the rider up to the kite.
  for (let k = 1; k < 14; k++) {
    const f = k / 14;
    out.push(feat(rect(offset(p, P.az, L * Math.cos(er) * f), 0, 1.4, 1.4), { part: 'line', b: 5 + (kh - 5) * f - 0.35, h: 5 + (kh - 5) * f + 0.35 }));
  }
  if (P.helper) out.push(feat(rect(offset(kp, P.az + 180, 4), 0, 3, 3), { part: 'helper', b: 0, h: 5 }));
  return { out, p, kp };
}

function windowFeatures(center, g) {
  const R = KITE_L * 1.05;
  return [
    feat(sector(center, g.to - 90, g.to - 40, R), { kind: 'side' }),
    feat(sector(center, g.to - 40, g.to + 40, R), { kind: 'power' }),
    feat(sector(center, g.to + 40, g.to + 90, R), { kind: 'side' }),
    line([offset(center, g.to - 90, R), center, offset(center, g.to + 90, R)], { kind: 'edge' }),
  ];
}

function render() {
  if (!state?.g) return;
  const { map, g, step, t, kn, wind } = state;
  const key = STEPS[step].key;
  // Visual wind speed: about 5 m of travel per second per knot.
  const s = t * kn * 5;
  const gustK = kn > 25 ? 1.6 : 1;
  const streaks = [];
  for (let i = 0; i < wind.parts.length; i++) {
    const p = wind.parts[i];
    const a = particleAt(p, wind.bands, s);
    let v = p.v;
    if (a.zone === 'gust') v += gustK * (16 * Math.sin(t * 2.3 + p.seed) + 9 * Math.sin(t * 5.1 + p.seed * 1.7));
    else v += 3 * Math.sin(t * 0.9 + p.seed);
    const tail = (a.zone === 'gust' ? 18 : 42) * (0.6 + kn / 30);
    const fade = Math.min(1, (a.u - wind.bands[0].a) / 120, (wind.bands[wind.bands.length - 1].b - a.u) / 120);
    streaks.push(line([at(g, a.u - tail, v), at(g, a.u, v)], { zone: a.zone, a: clamp(fade, 0, 1) * (key === 'wind' ? 1 : 0.7) }));
  }
  map.getSource('sv-wind').setData(fc(streaks));

  const fx = [], solids = [], labels = [];
  const P = pose(g, key, t, kn);
  if (key === 'wind') {
    labels.push(point(at(g, g.rideU - 350, g.rideV), { label: `Wind from ${DIRS16[state.d]}, ${kn} kn ↓`, size: 15 }));
    labels.push(point(at(g, g.rideU + 120, g.rideV), { label: g.shadow ? 'Clean wind out here' : 'Clean, steady wind', size: 13, color: '#e3f2fd' }));
  }
  if (key === 'upwind') {
    // The path of a rider who holds ground, and one who doesn't.
    const T = ridePose(g, 0, kn).T;
    const ring = [];
    for (let i = 0; i <= 80; i++) { const q = ridePose(g, (i / 80) * T, kn); ring.push(at(g, q.u, q.v)); }
    fx.push(line(ring, { kind: 'path' }));
    const lost = [];
    const A = clamp((g.reach || 400) / 2 - 80, 120, 520);
    for (let i = 0; i <= 4; i++) lost.push(at(g, g.rideU + 25 + i * 70, g.rideV + (i % 2 ? A : -A)));
    fx.push(line(lost, { kind: 'drifty' }));
    labels.push(point(at(g, g.rideU + 330, g.rideV), { label: 'Without riding upwind you drift this way', size: 12, color: '#ffcdd2' }));
    const up0 = at(g, g.rideU - 70, g.rideV), up1 = at(g, g.rideU - 260, g.rideV);
    fx.push(line([up0, up1], { kind: 'upwind' }));
    fx.push(line([offset(up1, g.to + 30, 40), up1, offset(up1, g.to - 30, 40)], { kind: 'upwind' }));
    labels.push(point(at(g, g.rideU - 300, g.rideV), { label: 'Upwind', size: 14, color: '#b9f6ca' }));
  }
  if (key === 'bail') {
    const len = Math.min(g.drift, 2500);
    const a = at(g, g.rideU, g.rideV), b = at(g, g.rideU + len, g.rideV);
    fx.push(line([a, b], { kind: 'drift' }));
    fx.push(line([offset(b, g.from + 30, 50), b, offset(b, g.from - 30, 50)], { kind: 'drift' }));
    labels.push(point(b, { label: Number.isFinite(g.drift) ? `You wash up here (${fmtM(g.drift)})` : 'Open water: no shore for kilometres', size: 13, color: '#ffcdd2', off: [0, 1.4] }));
  }
  if (P) {
    const r = riderFeatures(g, P);
    solids.push(...r.out);
    if (P.window) fx.push(...windowFeatures(r.p, g));
    if (P.window && (key === 'launch' || key === 'ride')) {
      labels.push(point(offset(r.p, g.to, KITE_L * 0.55), { label: 'Power zone', size: 12, color: '#ffe0b2' }));
      labels.push(point(offset(r.p, g.to + 90, KITE_L * 1.15), { label: 'Edge', size: 12, color: '#fff9c4' }));
      labels.push(point(offset(r.p, g.to - 90, KITE_L * 1.15), { label: 'Edge', size: 12, color: '#fff9c4' }));
    }
    if (key === 'ride' || key === 'upwind' || key === 'bail') {
      const wake = [];
      for (let k = 0; k < 18; k++) {
        const q = key === 'bail' ? pose(g, key, Math.max(t - k * 0.2, 0), kn) : ridePose(g, t - k * 0.25, kn);
        wake.push(at(g, q.u, q.v));
      }
      fx.push(line(wake, { kind: 'wake' }));
    }
    if (P.label) labels.push(point(r.p, { label: P.label, size: 13, off: [0, -2.2] }));
  }
  map.getSource('sv-fx').setData(fc(fx));
  map.getSource('sv-3d').setData(fc(solids));
  map.getSource('sv-labels').setData(fc(labels));
}

let raf = 0, last = 0;
function startAnim() {
  stopAnim();
  last = performance.now();
  const tick = (now) => {
    raf = requestAnimationFrame(tick);
    if (!state || !state.playing || document.hidden) { last = now; return; }
    const dt = now - last;
    if (dt < 45) return; // about 20 frames a second is plenty
    last = now;
    state.t += Math.min(dt, 200) / 1000;
    render();
  };
  raf = requestAnimationFrame(tick);
}
function stopAnim() { if (raf) cancelAnimationFrame(raf); raf = 0; }

// ---------------------------------------------------------------------------

function setDir(d) {
  state.d = d;
  const c = launchFor(d);
  const g = guideShapes(c, d);
  state.c = c;
  state.g = g;
  state.wind = buildWind(g);
  state.map.getSource('sv').setData(fc(g.zones));
  applyStepFilter();
  render();
  updatePanel();
}

function applyStepFilter() {
  const kinds = ['literal', STEPS[state.step].zones];
  for (const id of ['sv-zone-fill', 'sv-zone-line', 'sv-zone-label']) state.map.setFilter(id, ['in', ['get', 'kind'], kinds]);
}

function camera(key, g) {
  const L = g.launch, R = g.center, w = g.water;
  switch (key) {
    case 'wind': {
      const u = clamp(g.shadow ? (g.shadow.end + g.rideU) / 2 : g.rideU - 150, g.rideU - 1200, g.rideU);
      return { center: at(g, u, g.rideV), zoom: 14.7, pitch: 58, bearing: w };
    }
    case 'launch': return { center: offset(L, w, 30), zoom: 17.3, pitch: 62, bearing: w };
    case 'upwind': return { center: R, zoom: 15.1, pitch: 30, bearing: g.from };
    case 'land': return { center: offset(L, w, 120), zoom: 16.2, pitch: 64, bearing: w };
    case 'bail': {
      const len = Math.min(g.drift, 2500);
      return { center: offset(R, g.to, len / 2), zoom: clamp(16.2 - Math.log2(Math.max(len, 150) / 150), 13.4, 16), pitch: 45, bearing: g.from };
    }
    default: return { center: offset(L, w, 220), zoom: 15.6, pitch: 70, bearing: w };
  }
}

function goStep(i, fly) {
  state.step = clamp(i, 0, STEPS.length - 1);
  state.t = 0;
  applyStepFilter();
  render();
  moveCamera(fly);
  updatePanel();
}

function moveCamera(fly) {
  const { map, g } = state;
  map.easeTo({ ...camera(STEPS[state.step].key, g), padding: panelPadding(), duration: fly ? 1800 : 1000 });
  // The ground height under the view only updates when the camera moves. If
  // the terrain tiles arrive after the flight ends, the camera can be left
  // below the ground (a blank view), so nudge it once they have loaded.
  map.once('moveend', () => {
    const fix = () => state && map.jumpTo({ center: map.getCenter() });
    fix();
    map.once('idle', fix);
  });
}

function buildPanel() {
  document.getElementById('sv-panel')?.remove();
  const { opts, order, live } = state;
  const el = document.createElement('div');
  el.id = 'sv-panel';
  const chips = order.slice(0, 5).filter((d) => opts.s.Q[d] > 0.05 || d === order[0]);
  el.innerHTML = `<div class="sv-head"><b></b><button class="sv-exit" title="Back to the map">✕ Exit 3D</button></div>
    <div class="sv-sub">Score ${opts.s.score}${opts.s.eff != null ? ` · ${opts.s.eff} good hrs/yr` : ''}. Drag to pan, right-drag (or Ctrl+drag) to look around.</div>
    ${live ? `<div class="sv-live">Now: ${Math.round(live.kn)} kn from ${DIRS16[Math.round(live.dir / 22.5) % 16]}${live.gust ? `, gusts ${Math.round(live.gust)}` : ''} ${live.kn >= 12 && live.kn <= 35 ? '✔ kiteable' : live.kn < 12 ? '(too light)' : '(too strong)'}</div>` : ''}
    <div class="sv-wind">
      <label>Wind from <b class="sv-dirname"></b> <small class="sv-dirq"></small>
        <input type="range" class="sv-dir" min="0" max="15" step="1"></label>
      <label>Wind speed <b class="sv-kn"></b>
        <input type="range" class="sv-speed" min="5" max="40" step="1"></label>
      <div class="sv-verdict"></div>
      <div class="sv-dirs"><span>Common here:</span>${chips.map((d) => `<button data-d="${d}">${DIRS16[d]}${opts.s.hours ? ` <small>${opts.s.hours[d]} h</small>` : ''}</button>`).join('')}</div>
    </div>
    <div class="sv-steps">${STEPS.map((s, i) => `<button data-i="${i}"><span>${i + 1}</span>${s.name}</button>`).join('')}</div>
    <div class="sv-card"><div class="sv-card-text"></div>
      <div class="sv-nav"><button class="sv-prev">◀ Back</button><button class="sv-play"></button><button class="sv-next">Next ▶</button></div></div>
    <details class="sv-more"><summary>All notes for this spot</summary><div class="sv-guide"></div></details>
    <div class="sv-orbit"><button data-r="-30">⟲ Turn left</button><button data-r="30">Turn right ⟳</button><button data-top="1">Top view</button></div>
    <div class="sv-legend"><span style="--c:#ffffff;outline:1px solid #aab"></span>Clean wind <span style="--c:#b48cff"></span>Gusty wind <span style="--c:#ff6d00"></span>Power zone <span style="--c:#ffd600"></span>Edge of window <span style="--c:#ff2d78"></span>Kite <span style="--c:#ffd400"></span>Rider <span style="--c:#2a9d55"></span>Launch <span style="--c:#e53935"></span>Keep clear <span style="--c:#1e88e5"></span>Riding area</div>
    <div class="sv-note">Rider and kite are drawn about 3× real size.</div>`;
  el.querySelector('b').textContent = opts.title;
  el.querySelector('.sv-exit').onclick = exitSpotView;
  const dir = el.querySelector('.sv-dir'), speed = el.querySelector('.sv-speed');
  dir.value = state.d;
  speed.value = state.kn;
  dir.oninput = () => setDir(+dir.value);
  dir.onchange = () => moveCamera(false);
  speed.oninput = () => { state.kn = +speed.value; render(); updatePanel(); };
  el.querySelectorAll('.sv-dirs button').forEach((b) => (b.onclick = () => { setDir(+b.dataset.d); moveCamera(false); }));
  el.querySelectorAll('.sv-steps button').forEach((b) => (b.onclick = () => goStep(+b.dataset.i, false)));
  el.querySelector('.sv-prev').onclick = () => goStep(state.step - 1, false);
  el.querySelector('.sv-next').onclick = () => goStep(state.step + 1, false);
  el.querySelector('.sv-play').onclick = () => { state.playing = !state.playing; updatePanel(); };
  el.querySelectorAll('.sv-orbit button').forEach((b) => (b.onclick = () => {
    const m = state.map;
    if (b.dataset.top) m.easeTo({ pitch: m.getPitch() > 30 ? 0 : 70, duration: 800 });
    else m.easeTo({ bearing: m.getBearing() + +b.dataset.r, duration: 700 });
  }));
  document.getElementById('map').appendChild(el);
}

function updatePanel() {
  const el = document.getElementById('sv-panel');
  if (!el || !state.g) return;
  const { d, kn, step, opts, g, c } = state;
  const q = opts.s.Q[d];
  el.querySelector('.sv-dirname').textContent = DIRS16[d];
  el.querySelector('.sv-dirq').textContent = `${angleWord(g.th)}${opts.s.hours ? `, ${opts.s.hours[d]} h/yr` : ''}, ${q >= 0.6 ? 'works well' : q >= 0.35 ? 'workable' : 'poor here'}`;
  el.querySelector('.sv-dir').value = d;
  el.querySelector('.sv-kn').textContent = `${kn} kn`;
  const v = windVerdict(kn);
  const vEl = el.querySelector('.sv-verdict');
  vEl.textContent = v.text;
  vEl.className = `sv-verdict sv-${v.kind}`;
  el.querySelectorAll('.sv-dirs button').forEach((b) => b.classList.toggle('on', +b.dataset.d === d));
  el.querySelectorAll('.sv-steps button').forEach((b) => b.classList.toggle('on', +b.dataset.i === step));
  el.querySelector('.sv-prev').disabled = step === 0;
  el.querySelector('.sv-next').disabled = step === STEPS.length - 1;
  el.querySelector('.sv-play').textContent = state.playing ? '❚❚ Pause' : '▶ Play';
  el.querySelector('.sv-card-text').innerHTML = `<h4>${step + 1}. ${STEPS[step].name}</h4>${stepText(STEPS[step].key, c, d, g, kn)}`;
  renderGuide(c, d, g);
}

function stepText(key, c, d, g, kn) {
  const word = angleWord(g.th);
  const src = SOURCE_NAMES[c.dirs[d][4]] || 'obstacles';
  const gusty = !g.open && g.sh > 30;
  const P = (t) => `<p>${t}</p>`;
  switch (key) {
    case 'wind': return [
      P(`The white streaks are the wind, blowing from the <b>${DIRS16[d]}</b> at ${kn} kn. Here that is <b>${word}</b>: the beach faces ${c.face}.`),
      gusty
        ? P(`The wind crosses ${src} on the upwind shore. Behind them it is slow and gusty for about ${fmtM(Math.min(g.sh, g.W))} (purple streaks). A kite in gusty wind pulls hard, then drops, so ride out beyond that strip.`)
        : P(g.open ? 'There is open water far upwind, so the wind arrives smooth and steady.' : `The wind has crossed ${fmtM(g.W)} of open water before it reaches you, which smooths it out.`),
      P('Drag the <b>Wind from</b> slider to see how other directions work at this spot.'),
    ].join('');
    case 'launch': return [
      P('Your kite flies in the <b>wind window</b>: the half circle downwind of you. In the middle, the <b>power zone</b> (orange), it pulls hard. Toward the <b>edge</b> (yellow line), it hardly pulls.'),
      P('Launch with the kite at the edge, never in the power zone. A helper holds it there. Then fly it slowly up the edge to straight overhead, where it is parked.'),
      P('Keep the red zone clear: if the kite powers up while launching, you get dragged downwind into it.'),
    ].join('');
    case 'ride': return [
      P('Walk in to waist deep, put the board on, and dive the kite through the power zone to get going.'),
      P(`Ride <b>across the wind</b>, back and forth, with the kite about 45° up on the side you are heading. At the end of each run send the kite over your head and turn. You have about ${fmtM(g.reach)} of water to ride across.`),
      kn < 10 ? P('<b>At this wind speed the kite cannot stay up.</b> Move the speed slider to 12 kn or more.') : '',
    ].join('');
    case 'upwind': return [
      P('Every turn and every fall costs you ground downwind (red dashed line). To stay level with the launch, ride each run slightly <b>upwind</b> (green arrow): dig in the heel side of the board and keep the kite a little lower.'),
      word === 'onshore' || word === 'side-onshore'
        ? P('With this wind, drifting downwind brings you back to the beach. That is the safe way to learn.')
        : word === 'side-shore'
          ? P('With this wind you drift along the shore. You come in downwind of the launch and walk back.')
          : P('<b>Careful:</b> with this wind, downwind is away from shore. Beginners who lose ground get blown out.'),
    ].join('');
    case 'land': return [
      P('Ride back with the kite high. Aim for a spot <b>upwind of the launch</b>, so you do not end up downwind of it or of other people.'),
      P('Take the board off in shallow water, walk up, and steer the kite down the edge of the window to a helper. Never bring it down through the power zone.'),
    ].join('');
    case 'bail': {
      const dist = Number.isFinite(g.drift) ? `about ${fmtM(g.drift)}` : 'many kilometres';
      const items = [
        P('If you lose control, let go of the bar and pull the <b>quick release</b>. The kite depowers and you float.'),
        P(`With ${DIRS16[d]} wind you drift <b>${word === 'offshore' || word === 'side-offshore' ? 'away from shore' : word === 'side-shore' ? 'along the shore' : 'back toward shore'}</b>, ${dist} before you reach land (red arrow).`),
        word === 'offshore' || word === 'side-offshore'
          ? P('<b>That is dangerous.</b> Only ride this wind with a boat or on flats you can stand on.')
          : P('Wind up the lines and body-drag downwind, or swim with the kite as a sail. Then walk back.'),
      ];
      if (c.river) items.push(P('On a river the current also carries you downstream: plan where you can get out.'));
      if (c.bridge != null) items.push(P(`A bridge or causeway is ${fmtM(c.bridge)} away. Do not drift toward it.`));
      return items.join('');
    }
  }
  return '';
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

/** Controls for screenshots and tests: pause the animation and draw a given moment. */
export const spotViewControl = {
  pause() { if (state) { state.playing = false; updatePanel(); } },
  play() { if (state) { state.playing = true; updatePanel(); } },
  setTime(t) { if (state) { state.t = t; render(); } },
  step(i) { if (state) goStep(i, false); },
  dir(d) { if (state) { setDir(d); moveCamera(false); } },
  speed(kn) { if (state) { state.kn = kn; const el = document.querySelector('#sv-panel .sv-speed'); if (el) el.value = kn; render(); updatePanel(); } },
  steps: STEPS.map((s) => s.key),
};

export { esc };
export const _internal = { buildWind, particleAt, pose, ridePose };
