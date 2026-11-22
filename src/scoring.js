// Kite spot scoring: combines a lake's shape (open-water runs per direction)
// with the local wind history (kiteable hours per direction).

import { dirSuitability, fetchByAxis } from './geo.js';

export const KITE_MIN_KN = 12;
export const KITE_MAX_KN = 35;
export const EASY_MAX_KN = 22; // beginner-friendly upper limit
export const WIND_VERSION = 4; // 4: high-resolution, 3 years, real daylight

const dirOf = (deg) => Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;

/**
 * Is the sun up at this moment (unix seconds) and place? Used for kiteable
 * daylight, so short winter days count fewer hours than long summer ones, and
 * no time zone or daylight saving rules are needed. Accurate to a few minutes.
 */
export function sunUp(t, lat, lon, minElevDeg = 0) {
  const rad = Math.PI / 180;
  const d = t / 86400 - 10957.5; // days since 2000-01-01 12:00 UTC
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const ha = (gmst * 15 + lon) * rad - ra;
  const el = Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(ha));
  return el > minElevDeg * rad;
}

/**
 * Summarise hourly wind into kiteable hours per year by direction and month.
 * speeds in knots, dirs in degrees (direction wind comes FROM), day = per hour
 * true when it is daylight (or the local hour of day, then 9:00 to 19:59
 * counts), months = month 0-11, temps = air temperature in C, years = how many
 * years the data covers (results are per year).
 */
export function windStats(speeds, dirs, hours, years = 1, months = null, temps = null) {
  const byDir = new Array(16).fill(0);
  const easyByDir = new Array(16).fill(0);
  const byMonth = new Array(12).fill(0);
  const tSum = new Array(12).fill(0);
  const tN = new Array(12).fill(0);
  let daylight = 0, kite = 0, sum = 0, n = 0;
  for (let i = 0; i < speeds.length; i++) {
    const m = months ? months[i] : 0;
    if (temps && temps[i] != null) {
      tSum[m] += temps[i];
      tN[m]++;
    }
    const s = speeds[i];
    const d = dirs[i];
    if (s == null || d == null) continue;
    sum += s;
    n++;
    const h = hours[i];
    if (typeof h === 'boolean' ? !h : h < 9 || h > 19) continue;
    daylight++;
    if (s >= KITE_MIN_KN && s <= KITE_MAX_KN) {
      kite++;
      byDir[dirOf(d)]++;
      byMonth[m]++;
      if (s <= EASY_MAX_KN) easyByDir[dirOf(d)]++;
    }
  }
  const per = (v) => Math.round(v / years);
  const out = {
    v: WIND_VERSION,
    meanKn: n ? Math.round((sum / n) * 10) / 10 : 0,
    kiteHours: per(kite),
    daylightHours: per(daylight),
    byDir: byDir.map(per),
    easyByDir: easyByDir.map(per),
  };
  if (months) out.byMonth = byMonth.map(per);
  if (temps) out.tempByMonth = tSum.map((t, m) => (tN[m] ? Math.round((t / tN[m]) * 10) / 10 : null));
  return out;
}

/**
 * Months (0-11) when a lake is likely frozen hard enough to snowkite, from
 * mean air temperature: the month and the one before it must average below
 * freezing, and the month itself at or below -4 C. A rough guide only.
 */
export function iceMonths(wind) {
  const t = wind?.tempByMonth;
  if (!t) return [];
  const out = [];
  for (let m = 0; m < 12; m++) {
    const prev = t[(m + 11) % 12];
    if (t[m] != null && prev != null && t[m] <= -4 && prev < 0) out.push(m);
  }
  return out;
}

/** Geometry-only facts for a lake feature. Cached on the feature. */
export function lakeShape(feature) {
  if (!feature.properties._fetch) feature.properties._fetch = fetchByAxis(feature.geometry);
  return feature.properties._fetch;
}

/**
 * Very shallow lakes (average depth under about 1.5 m) in farm country tend
 * to be weedy, mucky and green by mid-summer, and are too shallow for fins in
 * places. A mild penalty; deep lakes are not penalised.
 */
export function shallowFactor(avgDepthM, mode = 'water') {
  if (avgDepthM == null) return 1;
  // Shallow water you can stand in is a plus for learning; for everyone else
  // a very shallow lake mostly means weeds and muck. (Small-lake depths in
  // HydroLAKES are modelled estimates, so the effect is kept mild.)
  if (avgDepthM < 1.5) return mode === 'beginner' ? 1.1 : 0.85;
  return 1;
}

/** Water colour from satellite imagery: clear water scores best. */
export function waterFactor(color) {
  if (color === 'green') return 0.8;
  if (color === 'murky') return 0.7;
  return 1;
}

// Score from effective hours: half of `scale` hours gives 33, `scale` gives 50,
// three times it 75, nine times it 90. It keeps rising for windier, bigger
// places instead of bunching up in the 90s.
export const toScore = (eff, scale) => Math.min(100, Math.round((100 * eff) / (eff + scale)));

/**
 * Score one lake. mode: 'water' (default), 'beginner' or 'snow'.
 * Returns { score 0-100, effHours, suit[16], basis }.
 * Without wind data the score is from shape alone (all directions equal).
 */
export function scoreLake(fetch8, wind, mode = 'water', props = {}) {
  const suit = Array.from({ length: 16 }, (_, d) => dirSuitability(fetch8, d));
  if (mode === 'snow') {
    // On ice you can ride anywhere; what matters is open space and wind in
    // the frozen months.
    const ice = iceMonths(wind);
    const space = Math.min(1, Math.max(...fetch8) / 2000) * Math.min(1, (props.a ?? 0) / 1.5);
    if (!wind?.byMonth) return { score: Math.round(space * 40), effHours: null, suit, basis: 'shape' };
    const hours = ice.reduce((s, m) => s + wind.byMonth[m], 0);
    const eff = hours * space;
    return { score: toScore(eff, 80), effHours: Math.round(eff), suit, basis: ice.length ? 'ice' : 'no-ice' };
  }
  const quality = shallowFactor(props.d, mode) * waterFactor(props.wc);
  if (!wind || !wind.kiteHours) {
    const mean = suit.reduce((a, b) => a + b, 0) / 16;
    return { score: Math.min(100, Math.round(mean * 60 * quality)), effHours: null, suit, basis: 'shape' };
  }
  // Beginners: count only lighter, more forgiving wind (12 to 22 kn).
  const dirs = mode === 'beginner' && wind.easyByDir ? wind.easyByDir : wind.byDir;
  let eff = 0;
  for (let d = 0; d < 16; d++) eff += dirs[d] * suit[d];
  eff *= quality;
  return { score: toScore(eff, mode === 'beginner' ? 120 : 180), effHours: Math.round(eff), suit, basis: 'wind' };
}

/** Wind directions (labels) where this lake works well, best first. */
export function bestDirs(suit, wind, labels) {
  return suit
    .map((s, d) => ({ d, s, h: wind ? wind.byDir[d] : 1 }))
    .filter((x) => x.s >= 0.6)
    .sort((a, b) => b.s * b.h - a.s * a.h)
    .map((x) => labels[x.d]);
}

/**
 * Go / maybe / no for one forecast day.
 * hours: [{ kn, dir }] for daylight hours; suit: per-direction suitability
 * (null for a spot that is not a known lake: any direction counts).
 */
export function dayVerdict(hours, suit) {
  let kite = 0, good = 0;
  const dirCount = new Array(16).fill(0);
  for (const h of hours) {
    if (h.kn < KITE_MIN_KN || h.kn > KITE_MAX_KN) continue;
    kite++;
    const d = dirOf(h.dir);
    dirCount[d]++;
    if (!suit || suit[d] >= 0.6) good++;
  }
  const verdict = good >= 3 ? 'go' : good >= 1 || kite >= 3 ? 'maybe' : 'no';
  return { verdict, good, kite, topDir: kite ? dirCount.indexOf(Math.max(...dirCount)) : null };
}

/** Rough drive time in hours from straight-line distance (roads wind around). */
export function estimateDriveHours(km) {
  return (km * 1.2) / 100 + 0.1;
}
