// Which days (and which hours) a spot works in the wind forecast. Each daylight
// hour is rated with the spot's own shore analysis: how well that wind
// direction works at the launch (Q from spotscore.js), whether the speed is
// kiteable for the mode, and how gusty it is. The best run of good hours
// becomes the day's "window".

import { DIRS16 } from './geo.js';
import { EASY_MAX_KN, KITE_MAX_KN, KITE_MIN_KN } from './scoring.js';

const FIRST_HOUR = 9, LAST_HOUR = 19;

/** Quality 0..1 of one forecast hour at a spot. Q = per-direction shore quality (or null: any direction). */
export function hourQuality(kn, gust, dir, Q, mode = 'water') {
  const max = mode === 'beginner' ? EASY_MAX_KN : KITE_MAX_KN;
  if (!(kn >= KITE_MIN_KN && kn <= max)) return { q: 0, why: kn < KITE_MIN_KN ? 'light' : 'strong' };
  const d = Math.round((((dir % 360) + 360) % 360) / 22.5) % 16;
  let q = Q ? Q[d] : 0.7;
  // Gusty wind: a big spread between the mean and the gusts is hard work and
  // dangerous for beginners.
  const spread = gust != null ? gust - kn : 0;
  let gusty = false;
  if (spread > 12 || (gust != null && gust > max + 8)) { q *= 0.5; gusty = true; }
  else if (spread > 8) { q *= 0.8; gusty = true; }
  return { q, d, gusty };
}

/**
 * Per-day forecast for a spot. r = Open-Meteo hourly forecast (local times),
 * Q = per-direction shore quality. Returns Map(day 'YYYY-MM-DD' -> {verdict,
 * good, kite, topDir, window: {from, to, kn, gust, dir} | null, gusty}).
 */
export function forecastDays(r, Q, mode = 'water') {
  const h = r.hourly;
  const days = new Map();
  for (let i = 0; i < h.time.length; i++) {
    const [day, time] = h.time[i].split('T');
    const hr = +time.slice(0, 2);
    if (!days.has(day)) days.set(day, []);
    if (hr < FIRST_HOUR || hr > LAST_HOUR) continue;
    const kn = h.wind_speed_10m[i], gust = h.wind_gusts_10m?.[i] ?? null, dir = h.wind_direction_10m[i];
    days.get(day).push({ hr, kn, gust, dir, ...hourQuality(kn, gust, dir, Q, mode) });
  }
  const out = new Map();
  for (const [day, hours] of days) {
    let good = 0, kite = 0, gustyH = 0;
    const dirCount = new Array(16).fill(0);
    let best = null, run = null;
    for (const x of hours) {
      if (x.q > 0) { kite++; dirCount[x.d]++; }
      if (x.gusty) gustyH++;
      if (x.q >= 0.5) {
        good++;
        run = run ? { ...run, to: x.hr, list: [...run.list, x] } : { from: x.hr, to: x.hr, list: [x] };
        if (!best || run.list.length > best.list.length) best = run;
      } else run = null;
    }
    const window = best && {
      from: best.from,
      to: best.to + 1,
      kn: [Math.round(Math.min(...best.list.map((x) => x.kn))), Math.round(Math.max(...best.list.map((x) => x.kn)))],
      gust: Math.round(Math.max(...best.list.map((x) => x.gust ?? x.kn))),
      dir: DIRS16[best.list[Math.floor(best.list.length / 2)].d],
    };
    const len = best ? best.list.length : 0;
    const verdict = len >= 3 ? 'go' : good >= 1 || kite >= 3 ? 'maybe' : 'no';
    out.set(day, { verdict, good, kite, topDir: kite ? dirCount.indexOf(Math.max(...dirCount)) : null, window, gusty: gustyH >= 2 });
  }
  return out;
}

const fmtHr = (h) => `${((h + 11) % 12) + 1}${h < 12 || h === 24 ? 'am' : 'pm'}`;

/** "1pm–5pm, 15–19 kn NW, gusts 24" */
export function windowText(w) {
  if (!w) return '';
  return `${fmtHr(w.from)}–${fmtHr(w.to)}, ${w.kn[0] === w.kn[1] ? w.kn[0] : `${w.kn[0]}–${w.kn[1]}`} kn ${w.dir}, gusts ${w.gust}`;
}
