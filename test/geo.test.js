import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchByAxis, countTiles, dirSuitability, haversineKm } from '../src/geo.js';
import { windStats, scoreLake } from '../src/scoring.js';

// A rectangle about 4 km east-west by 1 km north-south, near Omaha.
const lat = 41.3, lon = -96;
const dLon = 4000 / (111320 * Math.cos((lat * Math.PI) / 180));
const dLat = 1000 / 110540;
const rect = { type: 'Polygon', coordinates: [[[lon, lat], [lon + dLon, lat], [lon + dLon, lat + dLat], [lon, lat + dLat], [lon, lat]]] };

test('fetch matches rectangle sides', () => {
  const f = fetchByAxis(rect);
  assert.ok(Math.abs(f[0] - 1000) < 20, `N-S ${f[0]}`);
  assert.ok(Math.abs(f[4] - 4000) < 40, `E-W ${f[4]}`);
});

test('an island breaks the run', () => {
  const hole = [[lon + dLon * 0.45, lat - 0], [lon + dLon * 0.55, lat], [lon + dLon * 0.55, lat + dLat], [lon + dLon * 0.45, lat + dLat], [lon + dLon * 0.45, lat]];
  // island spanning the full height splits the lake into two ~1.8 km halves
  const poly = { type: 'Polygon', coordinates: [rect.coordinates[0], hole.map(([x, y], i) => [x, y + (i % 4 < 2 ? 1e-6 : -1e-6)])] };
  const f = fetchByAxis(poly);
  assert.ok(f[4] < 2000 && f[4] > 1600, `E-W with island ${f[4]}`);
});

test('west wind suits a long east-west lake', () => {
  const f = fetchByAxis(rect);
  assert.ok(dirSuitability(f, 12) > dirSuitability(f, 0));
});

test('wind stats and score', () => {
  const speeds = [5, 15, 20, 40, 18], dirs = [270, 270, 265, 270, 0], hours = [12, 12, 13, 14, 3];
  const w = windStats(speeds, dirs, hours);
  assert.equal(w.kiteHours, 2);
  assert.equal(w.byDir[12], 2);
  const s = scoreLake(fetchByAxis(rect), { kiteHours: 500, byDir: Array(16).fill(0).map((_, i) => (i === 12 ? 500 : 0)) });
  assert.ok(s.score > 55, `score ${s.score}`);
});

test('tile and distance math', () => {
  assert.equal(countTiles([-180, -85, 180, 85], 2), 16);
  assert.ok(Math.abs(haversineKm(41.2565, -95.9345, 39.0997, -94.5786) - 266) < 5);
});

import { iceMonths, dayVerdict, shallowFactor, estimateDriveHours } from '../src/scoring.js';

test('monthly stats and ice months', () => {
  const n = 24 * 365;
  const sp = [], dir = [], hrs = [], mon = [], tmp = [];
  for (let i = 0; i < n; i++) {
    const m = Math.floor((i / n) * 12);
    sp.push(15); dir.push(180); hrs.push(i % 24); mon.push(m);
    tmp.push(m <= 1 || m === 11 ? -10 : 15);
  }
  const w = windStats(sp, dir, hrs, 1, mon, tmp);
  assert.equal(w.byMonth.length, 12);
  assert.ok(w.byMonth[5] > 300);
  assert.deepEqual(iceMonths(w), [0, 1]); // Dec is the first cold month, so it doesn't count yet
  const snow = scoreLake(fetchByAxis(rect), w, 'snow', { a: 4 });
  assert.equal(snow.basis, 'ice');
  assert.ok(snow.score > 50);
});

test('green or very shallow water scores lower; deep clear water is not penalised', () => {
  const w = { kiteHours: 500, byDir: Array(16).fill(30), easyByDir: Array(16).fill(25) };
  const f = fetchByAxis(rect);
  const clearDeep = scoreLake(f, w, 'water', { d: 12, wc: 'clear' }).score;
  assert.ok(clearDeep > scoreLake(f, w, 'water', { d: 0.8, wc: 'clear' }).score);
  assert.ok(clearDeep > scoreLake(f, w, 'water', { d: 12, wc: 'green' }).score);
  assert.equal(shallowFactor(12), 1);
  assert.equal(shallowFactor(1, "beginner"), 1.1);
  assert.equal(shallowFactor(1), 0.85);
  assert.ok(scoreLake(f, w, 'beginner', { d: 12 }).effHours < scoreLake(f, w, 'water', { d: 12 }).effHours);
});

test('day verdicts and drive estimate', () => {
  const suit = Array(16).fill(0); suit[12] = 1;
  const west = Array(4).fill({ kn: 16, dir: 270 });
  const north = Array(4).fill({ kn: 16, dir: 0 });
  assert.equal(dayVerdict(west, suit).verdict, 'go');
  assert.equal(dayVerdict(north, suit).verdict, 'maybe');
  assert.equal(dayVerdict([{ kn: 5, dir: 270 }], suit).verdict, 'no');
  assert.equal(dayVerdict(north, null).verdict, 'go');
  const h = estimateDriveHours(266); // Omaha to Kansas City, about 3 h by road
  assert.ok(h > 2.8 && h < 3.6, String(h));
});

import { sunUp } from '../src/scoring.js';
test('sun: Omaha noon in June is day, 6 pm in December is night', () => {
  assert.equal(sunUp(Date.UTC(2025, 5, 21, 18) / 1000, 41.26, -95.94), true); // 1 pm CDT
  assert.equal(sunUp(Date.UTC(2025, 11, 21, 0) / 1000, 41.26, -95.94), false); // 6 pm CST
  assert.equal(sunUp(Date.UTC(2025, 5, 22, 1, 30) / 1000, 41.26, -95.94), true); // 8:30 pm CDT, still light
});
