import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lakesFromWater, polygonKm2 } from '../src/osmwater.js';

const sq = (x0, y0, x1, y1) => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]];
const feat = (poly, props = { kind: 'lake' }) => ({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: poly } });

test('a lake split across two tiles comes back as one lake', () => {
  // 0.02 x 0.01 degrees near Omaha, cut in half at a tile edge (with overlap).
  const a = feat(sq(-96.02, 41.30, -96.0095, 41.31), { kind: 'lake', name: 'Sandpit' });
  const b = feat(sq(-96.0105, 41.30, -96.0, 41.31));
  const lakes = lakesFromWater([a, b], [-97, 41, -95, 42]);
  assert.equal(lakes.length, 1);
  assert.equal(lakes[0].properties.n, 'Sandpit');
  const area = polygonKm2(sq(-96.02, 41.30, -96.0, 41.31));
  assert.ok(Math.abs(lakes[0].properties.a - area) < 0.01, `${lakes[0].properties.a} vs ${area}`);
});

test('rivers, tiny ponds and lakes cut off by the view edge are left out', () => {
  const river = feat(sq(-96.1, 41.3, -96.0, 41.31), { kind: 'river' });
  const pond = feat(sq(-96.5, 41.5, -96.499, 41.501));
  const edge = feat(sq(-95.01, 41.3, -94.9, 41.4));
  const ok = feat(sq(-96.3, 41.6, -96.29, 41.61));
  const lakes = lakesFromWater([river, pond, edge, ok], [-97, 41, -95, 42]);
  assert.equal(lakes.length, 1);
  assert.ok(lakes[0].properties.a > 0.5);
});
