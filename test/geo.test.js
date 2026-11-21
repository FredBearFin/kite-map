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
  assert.ok(s.score > 70, `score ${s.score}`);
});

test('tile and distance math', () => {
  assert.equal(countTiles([-180, -85, 180, 85], 2), 16);
  assert.ok(Math.abs(haversineKm(41.2565, -95.9345, 39.0997, -94.5786) - 266) < 5);
});
