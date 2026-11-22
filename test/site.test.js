import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSite, rate } from '../src/site.js';
import { scoreSite, explain } from '../src/spotscore.js';

// A 4 km (east-west) by 1.2 km lake near 41N, with woods along the west shore.
const lat = 41, lon = -96;
const kx = 111.32 * Math.cos((lat * Math.PI) / 180), ky = 110.54;
const rect = (x0, y0, x1, y1) => [[[lon + x0 / kx, lat + y0 / ky], [lon + x1 / kx, lat + y0 / ky], [lon + x1 / kx, lat + y1 / ky], [lon + x0 / kx, lat + y1 / ky], [lon + x0 / kx, lat + y0 / ky]]];
const lake = rect(-2, -0.6, 2, 0.6);
const base = {
  bbox: [lon - 3.5 / kx, lat - 2 / ky, lon + 3.5 / kx, lat + 2 / ky],
  water: [{ poly: lake, river: false }],
  cover: [{ poly: rect(-2.6, -1, -2.0, 1), h: 20, code: 1 }],
  roads: [[[lon - 3 / kx, lat - 0.8 / ky], [lon + 3 / kx, lat - 0.8 / ky]]],
  point: [lon, lat], radiusM: 50000,
};

test('wind along a long lake beats wind across it', () => {
  const raw = analyzeSite(base);
  assert.ok(raw.ok && raw.cand.length > 20);
  const { Q } = rate(raw);
  // 4 = E, 0 = N
  assert.ok(Q[4] > Q[0], `E ${Q[4]} vs N ${Q[0]}`);
});

test('trees on the upwind shore shade the water', () => {
  const raw = analyzeSite(base);
  const open = analyzeSite({ ...base, cover: [] });
  const w = rate(raw).best[12], wo = rate(open).best[12]; // 12 = W wind, from the woods
  assert.ok(w.sh >= 150, `shadow ${w.sh}`);
  assert.ok(wo.sh === 0);
  assert.ok(rate(raw).Q[12] <= rate(open).Q[12]);
});

test('a score comes with reasons', () => {
  const raw = analyzeSite(base);
  const wind = { byDir: [50, 20, 20, 30, 200, 60, 30, 20, 50, 20, 20, 30, 200, 60, 30, 20], easyByDir: new Array(16).fill(20), byMonth: new Array(12).fill(70), tempByMonth: new Array(12).fill(15) };
  const s = scoreSite(raw, wind, 'water');
  assert.ok(s.score > 0 && s.score <= 100);
  const r = explain(s, raw);
  assert.ok(r.some((x) => x.kind === 'good'));
});

test('a river bank is flagged as river', () => {
  const river = rect(-3, -0.2, 3, 0.2); // 400 m wide channel
  const raw = analyzeSite({ ...base, water: [{ poly: river, river: true }], cover: [] , point: [lon, lat], radiusM: 1500 });
  assert.ok(raw.cand.every((c) => c.river));
  const { Q } = rate(raw);
  assert.ok(Q[4] > Q[0], 'wind along the channel beats wind across it');
});
