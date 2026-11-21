// Kite spot scoring: combines a lake's shape (open-water runs per direction)
// with the local wind history (kiteable hours per direction).

import { dirSuitability, fetchByAxis } from './geo.js';

export const KITE_MIN_KN = 12;
export const KITE_MAX_KN = 35;

/**
 * Summarise hourly wind into kiteable hours per year by direction.
 * speeds in knots, dirs in degrees (direction wind comes FROM), hours = local
 * hour of day for each sample. Only daylight hours (9:00 to 19:59) count.
 */
export function windStats(speeds, dirs, hours, years = 1) {
  const byDir = new Array(16).fill(0);
  let daylight = 0;
  let kite = 0;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < speeds.length; i++) {
    const s = speeds[i];
    const d = dirs[i];
    if (s == null || d == null) continue;
    sum += s;
    n++;
    const h = hours[i];
    if (h < 9 || h > 19) continue;
    daylight++;
    if (s >= KITE_MIN_KN && s <= KITE_MAX_KN) {
      kite++;
      byDir[Math.round((((d % 360) + 360) % 360) / 22.5) % 16]++;
    }
  }
  const per = (v) => Math.round(v / years);
  return {
    meanKn: n ? Math.round((sum / n) * 10) / 10 : 0,
    kiteHours: per(kite),
    daylightHours: per(daylight),
    byDir: byDir.map(per),
  };
}

/** Geometry-only facts for a lake feature. Cached on the feature. */
export function lakeShape(feature) {
  if (!feature.properties._fetch) feature.properties._fetch = fetchByAxis(feature.geometry);
  return feature.properties._fetch;
}

/**
 * Score one lake. Returns { score 0-100, effHours, suit[16], basis }.
 * Without wind data the score is from shape alone (all directions equal).
 */
export function scoreLake(fetch8, wind) {
  const suit = Array.from({ length: 16 }, (_, d) => dirSuitability(fetch8, d));
  if (!wind || !wind.kiteHours) {
    const mean = suit.reduce((a, b) => a + b, 0) / 16;
    return { score: Math.round(mean * 60), effHours: null, suit, basis: 'shape' };
  }
  let eff = 0;
  for (let d = 0; d < 16; d++) eff += wind.byDir[d] * suit[d];
  const score = Math.round(100 * (1 - Math.exp(-eff / 300)));
  return { score, effHours: Math.round(eff), suit, basis: 'wind' };
}

/** Wind directions (labels) where this lake works well, best first. */
export function bestDirs(suit, wind, labels) {
  return suit
    .map((s, d) => ({ d, s, h: wind ? wind.byDir[d] : 1 }))
    .filter((x) => x.s >= 0.6)
    .sort((a, b) => b.s * b.h - a.s * a.h)
    .map((x) => labels[x.d]);
}
