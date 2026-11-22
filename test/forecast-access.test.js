import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forecastDays, windowText, hourQuality } from '../src/forecastscore.js';
import { buildQuery, parseAccess, summarize, accessReasons } from '../src/access.js';

function fakeForecast(fn) {
  const time = [], s = [], g = [], d = [];
  for (let day = 1; day <= 2; day++) for (let h = 0; h < 24; h++) {
    const x = fn(day, h);
    time.push(`2026-11-0${day}T${String(h).padStart(2, '0')}:00`);
    s.push(x.kn); g.push(x.gust); d.push(x.dir);
  }
  return { hourly: { time, wind_speed_10m: s, wind_gusts_10m: g, wind_direction_10m: d } };
}

test('forecast days use the shore quality per direction and find the window', () => {
  const Q = new Array(16).fill(0.1);
  Q[8] = 0.9; // south works
  const r = fakeForecast((day, h) => ({ kn: h >= 13 && h <= 16 ? 18 : 8, gust: 23, dir: day === 1 ? 180 : 0 }));
  const days = forecastDays(r, Q);
  const d1 = days.get('2026-11-01'), d2 = days.get('2026-11-02');
  assert.equal(d1.verdict, 'go');
  assert.equal(d1.good, 4);
  assert.deepEqual([d1.window.from, d1.window.to, d1.window.dir], [13, 17, 'S']);
  assert.match(windowText(d1.window), /1pm–5pm, 18 kn S, gusts 23/);
  assert.equal(d2.verdict, 'maybe'); // wind, but from the north: poor here
  assert.equal(d2.good, 0);
});

test('gusty and too strong hours are rated down', () => {
  assert.equal(hourQuality(40, 45, 180, null).q, 0);
  assert.ok(hourQuality(16, 32, 180, null).gusty);
  assert.equal(hourQuality(25, 28, 180, null, 'beginner').q, 0);
});

test('access: parse Overpass output per point and score it', () => {
  const pts = [[41.2, -101.7], [41.3, -101.6]];
  assert.match(buildQuery(pts), /make spot i=1/);
  const json = { elements: [
    { type: 'spot', tags: { i: '0' } },
    { type: 'node', lat: 41.2005, lon: -101.7, tags: { leisure: 'slipway' } },
    { type: 'way', center: { lat: 41.201, lon: -101.7 }, tags: { amenity: 'parking' } },
    { type: 'way', center: { lat: 41.2008, lon: -101.7 }, tags: { power: 'line' } },
    { type: 'spot', tags: { i: '1' } },
    { type: 'area', tags: { landuse: 'residential' } },
    { type: 'area', tags: { access: 'private', leisure: 'park' } },
  ] };
  const [a, b] = parseAccess(json, pts);
  assert.equal(a.level, 'public');
  assert.equal(a.factor, 0.85); // power line nearby
  assert.ok(accessReasons(a).some((r) => r.kind === 'bad' && /Power line/.test(r.text)));
  assert.equal(b.level, 'limited');
  assert.equal(b.factor, 0.5);
  assert.equal(summarize([{ kind: 'banned', d: 300 }]).level, 'no');
});
