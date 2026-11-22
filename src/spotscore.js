// Turn the shore analysis (site.js) and the local wind history into a score,
// and explain the score in plain words.

import { DIRS16 } from './geo.js';
import { PARAMS, SOURCE_NAMES, isShallow, rate, shoreFactor } from './site.js';
import { iceMonths, shallowFactor, toScore, waterFactor } from './scoring.js';

// On ice the launch angle hardly matters: you can walk out anywhere.
export const SNOW_PARAMS = { ...PARAMS, angle: [[181, 1]], shallowAngle: [[181, 1]] };

// Effective hours that score 50 (see toScore in scoring.js).
export const SCALE = { water: 220, beginner: 150, snow: 80 };

export function angleWord(th) {
  if (th < 15) return 'onshore';
  if (th < 65) return 'side-onshore';
  if (th < 95) return 'side-shore';
  if (th < 110) return 'side-offshore';
  return 'offshore';
}

const SHORE_WHY = {
  cliff: 'the shore where it would work is a cliff or steep bluff, with nowhere to launch',
  bank: 'the shore where it would work is a steep bank, with little room to launch',
  rock: 'the shore where it would work is bare rock',
  built: 'the shore where it would work is built up (seawalls, docks, buildings)',
};

const fmtM = (m) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m / 10) * 10} m`);

/** Hours per direction that count for the mode. */
function hoursFor(wind, mode) {
  if (!wind?.byDir) return null;
  if (mode === 'beginner') return wind.easyByDir || wind.byDir;
  if (mode === 'snow') {
    const ice = iceMonths(wind);
    const all = wind.byMonth ? wind.byMonth.reduce((a, b) => a + b, 0) : 0;
    const iceH = ice.reduce((s, m) => s + (wind.byMonth?.[m] || 0), 0);
    const k = all ? iceH / all : 0;
    return wind.byDir.map((h) => Math.round(h * k));
  }
  return wind.byDir;
}

/**
 * Score a launch analysis. raw = analyzeSite() result, props = lake properties
 * (depth, water colour) when it is a lake. Single = score one candidate only.
 */
export function scoreSite(raw, wind, mode = 'water', props = {}) {
  const P = mode === 'snow' ? SNOW_PARAMS : PARAMS;
  const { Q, best } = rate(raw, P);
  const hours = hoursFor(wind, mode);
  const quality = shallowFactor(props.d, mode) * waterFactor(props.wc);
  if (!hours) {
    const mean = Q.reduce((a, b) => a + b, 0) / 16;
    return { score: Math.min(100, Math.round(mean * 50 * quality)), Q, best, eff: null, total: null, basis: 'shape', quality };
  }
  const total = hours.reduce((a, b) => a + b, 0);
  const eff = hours.reduce((s, h, d) => s + h * Q[d], 0) * quality;
  let basis = 'site';
  if (mode === 'snow') basis = iceMonths(wind).length ? 'ice' : 'no-ice';
  return { score: toScore(eff, SCALE[mode] || SCALE.water), Q, best, eff: Math.round(eff), total, basis, quality, hours };
}

/** Plain-language reasons for a score: [{ kind: 'good' | 'bad' | 'warn' | 'info', text }]. */
export function explain(s, raw, mode = 'water', props = {}) {
  const out = [];
  if (!raw?.ok) return [{ kind: 'bad', text: raw?.reason ? `Could not analyse: ${raw.reason}.` : 'Could not analyse this spot.' }];
  if (!s.hours) {
    out.push({ kind: 'info', text: 'No wind history yet (it downloads when you are online), so this score is from the shoreline only.' });
  } else {
    const pct = s.total ? Math.round((100 * s.eff) / s.total) : 0;
    const what = mode === 'beginner' ? 'beginner-friendly (12 to 22 kn)' : mode === 'snow' ? 'frozen-season' : 'kiteable (12 to 35 kn)';
    out.push({ kind: pct >= 50 ? 'good' : pct >= 25 ? 'info' : 'bad', text: `${s.total} ${what} daylight hours a year here, and the shore setup makes ${s.eff} of them (${pct}%) good to ride.` });
  }
  const H = s.hours || new Array(16).fill(1);
  const order = [...Array(16).keys()].sort((a, b) => H[b] * s.Q[b] - H[a] * s.Q[a]);
  // Best wind directions.
  for (const d of order.slice(0, 3)) {
    const b = s.best[d];
    if (!b || s.Q[d] < 0.35 || (s.hours && H[d] < 10)) continue;
    const c = raw.cand[b.ci];
    let t = `${DIRS16[d]} wind${s.hours ? ` (${H[d]} h/yr)` : ''}: ${angleWord(b.th)} on a shore facing ${c.face}, ${b.open ? 'open water' : fmtM(b.W) + ' of open water'} upwind`;
    if (b.sh > 50 && !b.open) t += `, ${SOURCE_NAMES[b.src]} upwind make the first ${fmtM(b.sh)} gusty`;
    out.push({ kind: 'good', text: t + '.' });
  }
  // Common winds that don't work, and why.
  const common = [...Array(16).keys()].filter((d) => s.Q[d] < 0.45 && (!s.hours || H[d] >= 0.08 * (s.total || 0)) && (s.hours ? H[d] > 0 : true));
  common.sort((a, b) => H[b] - H[a]);
  for (const d of common.slice(0, s.hours ? 3 : 0)) {
    const b = s.best[d];
    if (!b) continue;
    const f = Math.min(b.fa, b.fc, Math.sqrt(b.fr), b.fx, b.fs ?? 1);
    let why;
    if (f === b.fa) why = `the wind is ${angleWord(b.th)} ${raw.cand.length > 1 ? 'at every shore here' : 'at this launch'}`;
    else if (f === b.fc) {
      why = b.sh > 50 && b.sh > 0.3 * b.W
        ? `${SOURCE_NAMES[b.src]} on the upwind shore (about ${b.shH} m high) leave it gusty for ${fmtM(b.sh)}, with only ${fmtM(b.W)} of water`
        : `only ${fmtM(b.W)} of open water upwind, so it stays gusty and light`;
    } else if (f === Math.sqrt(b.fr)) why = `only ${fmtM(b.reach)} of water to ride across the wind`;
    else if (f === b.fs) why = SHORE_WHY[shoreFactor(raw.cand[b.ci]).why] || 'the shore is hard to launch from';
    else why = `the nearest road is ${fmtM(raw.cand[b.ci].access)} from the launch that works`;
    out.push({ kind: 'bad', text: `${DIRS16[d]} wind (${H[d]} h/yr) doesn't work well: ${why}.` });
  }
  // Hazards and limits of the data.
  const top = s.best[order[0]];
  const c = top ? raw.cand[top.ci] : null;
  if (c?.river) {
    out.push({ kind: 'warn', text: `River, about ${fmtM(c.width || 0)} wide. Wind along the channel works best. Wind against the current kicks up steep chop, and you drift downstream, so plan a walk back or a pickup. Watch for barges, snags and sandbars.` });
  }
  if (c?.bridge != null) out.push({ kind: 'warn', text: `Bridge or causeway ${fmtM(c.bridge)} from the best launch: stay well clear.` });
  if (c && c.access != null && c.access > 800) out.push({ kind: 'warn', text: `Best launch is ${fmtM(c.access)} from the nearest road.` });
  if (!raw.roadsKnown) out.push({ kind: 'info', text: 'Road access unknown (no map detail saved here).' });
  if (props.d != null && props.d < 1.5) out.push(mode === 'beginner'
    ? { kind: 'good', text: `Average depth ${props.d} m: shallow water you can stand in, good for learning (estimate for small lakes).` }
    : { kind: 'warn', text: `Average depth ${props.d} m: may be weedy or mucky (score lowered a little; estimate for small lakes).` });
  if (props.wc === 'green') out.push({ kind: 'bad', text: 'Green water on satellite: algae likely (score lowered).' });
  if (props.wc === 'murky') out.push({ kind: 'bad', text: 'Brown, murky water on satellite (score lowered).' });
  if (raw.waterFromLake) out.push({ kind: 'info', text: 'Map detail is not saved here, so the coarse HydroLAKES outline was used.' });
  // What the shore is like at the best launch.
  if (c) {
    const sf = shoreFactor(c).why;
    if (sf === 'beach') out.push({ kind: 'good', text: 'Sand beach at the best launch: room to lay out and launch.' });
    else if (sf && sf in SHORE_WHY) out.push({ kind: 'warn', text: `${SHORE_WHY[sf].replace('the shore where it would work is', 'The best launch is on')}.`.replace('is on a cliff', 'is below a cliff') });
  }
  // Depth off the launches, where the terrain data has sea-floor depths.
  const shallowN = raw.cand.filter((c) => isShallow(c)).length;
  if (top && c && isShallow(c)) out.push({ kind: 'good', text: `Shallow water off the best launch (about ${c.depth[0]} m deep 150 m out, ${c.depth[1]} m at 300 m): you can stand up, so even side-offshore wind is workable.` });
  else if (shallowN) out.push({ kind: 'info', text: `${shallowN} of ${raw.cand.length} launch points here have water shallow enough to stand in.` });
  else if (raw.bathy && c?.depth?.[0] != null) out.push({ kind: 'info', text: `Water gets deep quickly off the best launch (about ${c.depth[0]} m deep 150 m out).` });
  if (!raw.bathy) out.push({ kind: 'info', text: 'Offshore launches are only safe on shallow flats you can stand on; depth is not known here, so they are scored low.' });
  return out;
}

/** The best launch point for each of the top wind directions. */
export function launches(s, raw, n = 3) {
  if (!raw?.ok) return [];
  const H = s.hours || new Array(16).fill(1);
  const order = [...Array(16).keys()].sort((a, b) => H[b] * s.Q[b] - H[a] * s.Q[a]);
  const out = [];
  for (const d of order) {
    const b = s.best[d];
    if (!b || s.Q[d] < 0.35) continue;
    const c = raw.cand[b.ci];
    const ex = out.find((o) => o.ci === b.ci);
    if (ex) { ex.dirs.push(DIRS16[d]); continue; }
    out.push({ ci: b.ci, lon: c.lon, lat: c.lat, dirs: [DIRS16[d]], q: b.q });
    if (out.length >= n) break;
  }
  return out;
}
