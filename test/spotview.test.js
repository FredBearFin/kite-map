import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guideShapes, windVerdict, _internal } from '../src/spotview.js';

const dirs = Array.from({ length: 16 }, (_, d) => [d * 10 % 180, 1200, d % 2 === 0, 300, 1, 18, 900]);
const c = { lon: -101.7, lat: 41.2, face: 'S', dirs, access: 100 };

test('guide shapes, wind bands and poses are sane for every direction', () => {
  for (let d = 0; d < 16; d++) {
    const g = guideShapes(c, d);
    const w = _internal.buildWind(g);
    assert.ok(w.bands.length >= 1);
    for (let i = 1; i < w.bands.length; i++) assert.ok(Math.abs(w.bands[i].a - w.bands[i - 1].b) < 1e-6);
    for (const p of w.parts.slice(0, 20)) for (const s of [0, 37, 999, 12345]) {
      const a = _internal.particleAt(p, w.bands, s);
      assert.ok(Number.isFinite(a.u) && a.u >= w.bands[0].a - 1e-6 && a.u <= w.bands.at(-1).b + 1e-6);
    }
    for (const step of ['ride', 'upwind', 'launch', 'land', 'bail']) for (const t of [0, 3.3, 17, 61]) {
      const P = _internal.pose(g, step, t, 18);
      for (const k of ['u', 'v', 'az', 'e']) assert.ok(Number.isFinite(P[k]), `${step} ${k}`);
    }
    if (g.shadow && g.shadow.end > g.rideU - 2600) assert.ok(w.bands.some((b) => b.zone === 'gust'));
  }
});

test('wind verdict ranges', () => {
  assert.equal(windVerdict(6).kind, 'bad');
  assert.equal(windVerdict(16).kind, 'good');
  assert.equal(windVerdict(40).kind, 'bad');
});
