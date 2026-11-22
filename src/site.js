// Kite launch analysis on a local grid.
//
// Water, land cover, buildings, roads and terrain around a lake (or a stretch
// of coast) are drawn onto a grid of cells a few tens of metres across. Then,
// for points along the shore and each of 16 wind directions, it measures:
//   - the wind angle to the shore (onshore, side-onshore, side-shore, offshore)
//   - how far the wind has blown over open water before reaching the launch
//   - the wind shadow of trees, buildings and hills on the upwind shore
//   - how much water there is to ride back and forth across the wind
//   - how far the launch is from a road
//   - what the shore is like: a sand beach, bare rock, a built-up waterfront
//     (seawalls and docks) or a steep bank or cliff, where you can't launch
//   - how deep the water is off the launch, where the terrain data has sea-floor
//     depths (most coasts): shallow flats you can stand on make even offshore
//     wind workable, as on the big lagoons
// Pure functions with no browser APIs, shared by the app and the calibration
// script (tools/calibrate.mjs).

export const SITE_VERSION = 3;

// How far behind an obstacle the wind stays gusty and weak, in multiples of its
// height. Kiting guides give 7 to 20 times; 10 is a common middle value. Hills
// and bluffs are smoother than tree lines, so their shadow is shorter.
export const SHADOW_K = { cover: 10, terrain: 6 };

// Typical heights (m) of land cover, by Protomaps / OpenStreetMap kind.
// Code 1 = trees, 2 = buildings.
const COVER = {
  wood: [18, 1], forest: [18, 1], orchard: [6, 1], scrub: [3, 1], park: [6, 1], golf_course: [5, 1],
  cemetery: [5, 1], nature_reserve: [0, 1], garden: [4, 1], zoo: [6, 1],
  residential: [9, 2], suburb: [9, 2], neighbourhood: [9, 2], urban_area: [9, 2], commercial: [12, 2], retail: [12, 2],
  industrial: [12, 2], school: [9, 2], university: [12, 2], college: [12, 2], hospital: [15, 2], theme_park: [8, 2],
  military: [6, 2], prison: [8, 2],
};
export function coverHeight(kind) {
  return COVER[kind] || null;
}

export const SOURCE_NAMES = { 1: 'trees', 2: 'buildings', 3: 'high ground' };

// ---------- grid ----------

export function makeGrid(bbox, maxCells = 1400, minCell = 15) {
  const [w, s, e, n] = bbox;
  const lat0 = (s + n) / 2;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110540;
  const cell = Math.max(minCell, Math.max((e - w) * kx, (n - s) * ky) / maxCells);
  const nx = Math.max(1, Math.ceil(((e - w) * kx) / cell));
  const ny = Math.max(1, Math.ceil(((n - s) * ky) / cell));
  return {
    bbox, cell, nx, ny, kx, ky,
    gx: (lon) => ((lon - w) * kx) / cell,
    gy: (lat) => ((n - lat) * ky) / cell,
    lon: (x) => w + (x * cell) / kx,
    lat: (y) => n - (y * cell) / ky,
  };
}

/** Fill polygons (arrays of rings in lon/lat) into the grid; set(idx) per cell. */
export function fillPolygon(g, poly, set) {
  const edges = [];
  let y0 = Infinity, y1 = -Infinity;
  for (const ring of poly) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const ax = g.gx(ring[j][0]), ay = g.gy(ring[j][1]);
      const bx = g.gx(ring[i][0]), by = g.gy(ring[i][1]);
      if (ay === by) continue;
      edges.push(ax, ay, bx, by);
      y0 = Math.min(y0, ay, by);
      y1 = Math.max(y1, ay, by);
    }
  }
  const r0 = Math.max(0, Math.floor(y0)), r1 = Math.min(g.ny - 1, Math.ceil(y1));
  const xs = [];
  for (let r = r0; r <= r1; r++) {
    const yc = r + 0.5;
    xs.length = 0;
    for (let k = 0; k < edges.length; k += 4) {
      const ay = edges[k + 1], by = edges[k + 3];
      if (ay <= yc !== by <= yc) xs.push(edges[k] + ((yc - ay) * (edges[k + 2] - edges[k])) / (by - ay));
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil(xs[k] - 0.5)), c1 = Math.min(g.nx - 1, Math.floor(xs[k + 1] - 0.5));
      for (let c = c0; c <= c1; c++) set(r * g.nx + c);
    }
  }
}

export function drawLine(g, line, set) {
  for (let i = 1; i < line.length; i++) {
    const ax = g.gx(line[i - 1][0]), ay = g.gy(line[i - 1][1]);
    const bx = g.gx(line[i][0]), by = g.gy(line[i][1]);
    const steps = Math.ceil(Math.hypot(bx - ax, by - ay) * 2) + 1;
    for (let k = 0; k <= steps; k++) {
      const x = Math.floor(ax + ((bx - ax) * k) / steps), y = Math.floor(ay + ((by - ay) * k) / steps);
      if (x >= 0 && y >= 0 && x < g.nx && y < g.ny) set(y * g.nx + x);
    }
  }
}

/** Distance in cells (8-connected steps) from any cell where src is set, up to cap. */
function distanceFrom(g, src, cap) {
  const N = g.nx * g.ny;
  const dist = new Uint16Array(N).fill(65535);
  const q = new Int32Array(N);
  let h = 0, t = 0;
  for (let i = 0; i < N; i++) if (src[i]) { dist[i] = 0; q[t++] = i; }
  while (h < t) {
    const i = q[h++];
    const d = dist[i];
    if (d >= cap) continue;
    const x = i % g.nx, y = (i / g.nx) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const X = x + dx, Y = y + dy;
      if (X < 0 || Y < 0 || X >= g.nx || Y >= g.ny) continue;
      const j = Y * g.nx + X;
      if (dist[j] > d + 1) { dist[j] = d + 1; q[t++] = j; }
    }
  }
  return dist;
}

function floodFill(g, water, seeds) {
  const comp = new Uint8Array(g.nx * g.ny);
  const q = new Int32Array(g.nx * g.ny);
  let h = 0, t = 0;
  for (const i of seeds) if (water[i] && !comp[i]) { comp[i] = 1; q[t++] = i; }
  let edge = false;
  while (h < t) {
    const i = q[h++];
    const x = i % g.nx, y = (i / g.nx) | 0;
    if (x === 0 || y === 0 || x === g.nx - 1 || y === g.ny - 1) edge = true;
    const nb = [x > 0 ? i - 1 : -1, x < g.nx - 1 ? i + 1 : -1, y > 0 ? i - g.nx : -1, y < g.ny - 1 ? i + g.nx : -1];
    for (const j of nb) if (j >= 0 && water[j] && !comp[j]) { comp[j] = 1; q[t++] = j; }
  }
  return { comp, size: t, edge };
}

// ---------- analysis ----------

const toCompass = (deg) => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

/**
 * input: {
 *   bbox, water: [{poly, river}], cover: [{poly, h, code}], roads: [line],
 *   dem: (lon, lat) => metres or null,
 *   lake: [polygon] or null  (analyse the shore of this lake),
 *   point: [lon, lat] or null, radiusM  (analyse the shore near this point),
 *   region: true  (analyse every shore in the box: lakes, coast and rivers),
 *   maxFetch (m)
 * }
 * Returns the raw measurements; rate() turns them into scores.
 */
export function analyzeSite(input) {
  const g = makeGrid(input.bbox, input.maxCells || 1400);
  const N = g.nx * g.ny;
  const water = new Uint8Array(N); // 1 = still water or sea, 2 = river
  for (const w of input.water) fillPolygon(g, w.poly, (i) => { if (!water[i] || !w.river) water[i] = w.river ? 2 : 1; });
  const lakeMask = input.lake ? new Uint8Array(N) : null;
  if (lakeMask) for (const poly of input.lake) fillPolygon(g, poly, (i) => (lakeMask[i] = 1));

  // Seeds: the lake's own cells, or the water nearest the point.
  let seeds = [];
  let waterFromLake = false;
  if (lakeMask) {
    for (let i = 0; i < N; i++) if (lakeMask[i] && water[i]) seeds.push(i);
    if (seeds.length < 10) {
      // No map tiles for this area: use the lake outline as the water.
      for (let i = 0; i < N; i++) if (lakeMask[i]) { water[i] = 1; seeds.push(i); }
      waterFromLake = true;
    }
  } else if (input.region) {
    for (let i = 0; i < N; i++) if (water[i]) seeds.push(i);
  } else {
    const px = Math.floor(g.gx(input.point[0])), py = Math.floor(g.gy(input.point[1]));
    let best = -1, bd = Infinity;
    const R = Math.ceil(1500 / g.cell);
    for (let y = Math.max(0, py - R); y <= Math.min(g.ny - 1, py + R); y++)
      for (let x = Math.max(0, px - R); x <= Math.min(g.nx - 1, px + R); x++) {
        const d = (x - px) ** 2 + (y - py) ** 2;
        if (water[y * g.nx + x] && d < bd) { bd = d; best = y * g.nx + x; }
      }
    if (best >= 0) seeds = [best];
    if (input.pickLargest && best >= 0) {
      // The biggest water body within reach, not just the nearest pond.
      let bigN = 0;
      const tried = new Uint8Array(N);
      for (let y = Math.max(0, py - R); y <= Math.min(g.ny - 1, py + R); y += 2)
        for (let x = Math.max(0, px - R); x <= Math.min(g.nx - 1, px + R); x += 2) {
          const i = y * g.nx + x;
          if (!water[i] || tried[i]) continue;
          const f = floodFill(g, water, [i]);
          for (let k = 0; k < N; k++) if (f.comp[k]) tried[k] = 1;
          if (f.size > bigN) { bigN = f.size; seeds = [i]; }
        }
    }
  }
  if (!seeds.length) return { ok: false, reason: 'no water found here' };
  const { comp, size, edge } = floodFill(g, water, seeds);

  const coverH = new Uint8Array(N);
  const coverC = new Uint8Array(N);
  for (const c of input.cover) {
    fillPolygon(g, c.poly, (i) => {
      if (!water[i] && c.h > coverH[i]) { coverH[i] = c.h; coverC[i] = c.code; }
    });
  }
  const road = new Uint8Array(N);
  const bridge = new Uint8Array(N);
  let roadsKnown = false, bridges = false;
  for (const line of input.roads) drawLine(g, line, (i) => {
    // A road over open water is a bridge (or a causeway): a hazard to ride near.
    if (water[i]) { bridge[i] = 1; bridges = true; } else { road[i] = 1; roadsKnown = true; }
  });
  // Shore type: sand beaches, bare rock.
  const beachM = new Uint8Array(N);
  let beachesKnown = false;
  for (const poly of input.beach || []) fillPolygon(g, poly, (i) => { beachM[i] = 1; beachesKnown = true; });
  for (const poly of input.rock || []) fillPolygon(g, poly, (i) => { if (!beachM[i]) beachM[i] = 2; });
  const roadDist = roadsKnown ? distanceFrom(g, road, Math.ceil(2000 / g.cell)) : null;
  const bridgeDist = bridges ? distanceFrom(g, bridge, Math.ceil(1000 / g.cell)) : null;
  const nearLake = lakeMask ? distanceFrom(g, lakeMask, Math.ceil(300 / g.cell)) : null;

  // Shore cells of the water body.
  const shore = [];
  const R2 = 4;
  const px = input.point ? g.gx(input.point[0]) : 0, py = input.point ? g.gy(input.point[1]) : 0;
  const radC = input.point ? (input.radiusM || 2500) / g.cell : 0;
  for (let i = 0; i < N; i++) {
    if (!comp[i]) continue;
    const x = i % g.nx, y = (i / g.nx) | 0;
    if (x === 0 || y === 0 || x === g.nx - 1 || y === g.ny - 1) continue;
    if (water[i - 1] && water[i + 1] && water[i - g.nx] && water[i + g.nx]) continue;
    if (nearLake && nearLake[i] > Math.ceil(300 / g.cell)) continue;
    if (input.point && (x - px) ** 2 + (y - py) ** 2 > radC * radC) continue;
    shore.push(i);
  }
  if (!shore.length) return { ok: false, reason: 'no shoreline found' };

  // Spread launch candidates along the shore, at most about 150.
  let S = Math.max(1, Math.round(100 / g.cell));
  let picks;
  for (;;) {
    const seen = new Set();
    picks = [];
    for (const i of shore) {
      const x = i % g.nx, y = (i / g.nx) | 0;
      const k = Math.floor(x / S) * 100000 + Math.floor(y / S);
      if (seen.has(k)) continue;
      seen.add(k);
      picks.push(i);
    }
    if (picks.length <= (input.maxCand || 150)) break;
    S = Math.ceil(S * 1.3);
  }

  // Water level: median ground height at the shore.
  let waterElev = input.waterElev ?? null;
  if (waterElev == null && input.dem) {
    const hs = [];
    for (let k = 0; k < shore.length && hs.length < 300; k += Math.max(1, Math.floor(shore.length / 300))) {
      const i = shore[k];
      const v = input.dem(g.lon((i % g.nx) + 0.5), g.lat(((i / g.nx) | 0) + 0.5));
      if (v != null && isFinite(v)) hs.push(v);
    }
    hs.sort((a, b) => a - b);
    if (hs.length) waterElev = hs[Math.floor(hs.length / 2)];
  }
  const demCache = new Float32Array(N).fill(NaN);
  const terrainAt = (i) => {
    if (!input.dem || waterElev == null) return 0;
    if (Number.isNaN(demCache[i])) {
      const v = input.dem(g.lon((i % g.nx) + 0.5), g.lat(((i / g.nx) | 0) + 0.5));
      demCache[i] = v == null || !isFinite(v) ? waterElev : v;
    }
    return demCache[i] - waterElev;
  };

  // Depth off the shore. The terrain tiles carry sea-floor depths on most
  // coasts (below sea level), but lakes only show their surface. Depths count
  // only where the water body shows real depths somewhere.
  // Only below-sea-level depths count: inland lakes show just their surface.
  const seaLevel = waterElev != null && waterElev < 15 ? 0 : null;
  const depthAt = (x, y) => {
    if (!input.dem || seaLevel == null) return null;
    const v = input.dem(g.lon(x), g.lat(y));
    return v == null || !isFinite(v) ? null : seaLevel - v;
  };
  let bathy = false;
  if (input.dem && seaLevel != null) {
    let n = 0, deep = 0;
    const stepI = Math.max(1, Math.floor(N / 4000));
    for (let i = 0; i < N; i += stepI) {
      if (!comp[i]) continue;
      const dd = depthAt((i % g.nx) + 0.5, ((i / g.nx) | 0) + 0.5);
      if (dd == null) continue;
      n++;
      if (dd > 0.5) deep++;
    }
    bathy = n > 20 && deep / n > 0.1;
  }

  const maxFetch = input.maxFetch || 15000;
  const step = 0.5;
  const at = (x, y) => (x < 0 || y < 0 || x >= g.nx || y >= g.ny ? -1 : Math.floor(y) * g.nx + Math.floor(x));

  /** Walk from (x, y) along east/north unit vector (e, n) while on water. */
  function waterRun(x, y, e, n, maxM) {
    let d = 0;
    for (;;) {
      const nx = x + e * step, ny = y - n * step;
      const i = at(nx, ny);
      if (i < 0) return { d, open: true, x, y };
      if (!water[i]) return { d, open: false, x: nx, y: ny };
      x = nx; y = ny; d += step * g.cell;
      if (d >= maxM) return { d, open: true, x, y };
    }
  }

  const cand = [];
  for (const i of picks) {
    const cx = (i % g.nx) + 0.5, cy = ((i / g.nx) | 0) + 0.5;
    // Normal toward land, from the land cells around.
    let se = 0, sn = 0;
    for (let dy = -R2; dy <= R2; dy++) for (let dx = -R2; dx <= R2; dx++) {
      const r = Math.hypot(dx, dy);
      if (!r || r > R2) continue;
      const j = at(cx + dx, cy + dy);
      if (j >= 0 && !water[j]) { se += dx / r; sn += -dy / r; }
    }
    const len = Math.hypot(se, sn);
    if (len < 0.5) continue;
    const ne = se / len, nn = sn / len;
    const access = roadDist ? Math.min(2000, roadDist[i] * g.cell) : null;
    // The land right behind the launch: beach, rock, buildings, and how
    // steeply it rises (a bank or cliff leaves nowhere to lay out a kite).
    let beach = 0, rock = 0, built = 0, bank = 0;
    for (const off of [0, 20, 40, 70]) {
      const j = at(cx + (ne * off) / g.cell, cy - (nn * off) / g.cell);
      if (j < 0) continue;
      if (beachM[j] === 1) beach = 1;
      else if (beachM[j] === 2 && off <= 40) rock = 1;
      if (!water[j] && coverC[j] === 2 && off >= 20) built = 1;
    }
    for (const off of [60, 120]) {
      const j = at(cx + (ne * off) / g.cell, cy - (nn * off) / g.cell);
      if (j >= 0 && !water[j]) bank = Math.max(bank, Math.round(terrainAt(j)));
    }
    const dirs = [];
    for (let d = 0; d < 16; d++) {
      const B = (d * 22.5 * Math.PI) / 180;
      const ue = Math.sin(B), un = Math.cos(B); // toward where the wind comes from
      const te = -ue, tn = -un; // where the wind blows to
      const th = Math.round((Math.acos(Math.max(-1, Math.min(1, te * ne + tn * nn))) * 180) / Math.PI);
      // Open water upwind of the launch.
      const up = waterRun(cx, cy, ue, un, maxFetch);
      let sh = 0, src = 0, shH = 0;
      if (!up.open) {
        // Land beyond: trees, buildings and high ground cast a wind shadow.
        let x = up.x, y = up.y;
        for (let dist = 0; dist <= 600; dist += step * g.cell) {
          const j = at(x, y);
          if (j < 0 || water[j]) break;
          const hc = coverH[j];
          if (hc) { const s = SHADOW_K.cover * hc - dist; if (s > sh) { sh = s; src = coverC[j]; shH = hc; } }
          const ht = terrainAt(j);
          if (ht > 2) { const s = SHADOW_K.terrain * ht - dist; if (s > sh) { sh = s; src = 3; shH = Math.round(ht); } }
          x += ue * step; y -= un * step;
        }
      }
      // Room to ride back and forth across the wind, a little way out.
      let reach = 0;
      for (const off of [120, 60]) {
        const ox = cx - (ne * off) / g.cell, oy = cy + (nn * off) / g.cell;
        const j = at(ox, oy);
        if (j < 0 || !water[j]) continue;
        reach = waterRun(ox, oy, tn, -te, 3000).d + waterRun(ox, oy, -tn, te, 3000).d;
        break;
      }
      dirs.push([th, Math.round(up.d), up.open ? 1 : 0, Math.round(sh), src, shH, Math.round(reach)]);
    }
    const c = { lon: +g.lon(cx).toFixed(5), lat: +g.lat(cy).toFixed(5), face: toCompass((Math.atan2(-ne, -nn) * 180) / Math.PI), access, dirs, bank };
    if (beach) c.beach = 1;
    if (rock && !beach) c.rock = 1;
    if (built && !beach) c.built = 1;
    if (bathy) {
      // Depth 150, 300 and 600 m out from the shore (m, 0 when the data shows
      // none), so standable flats can be told from a drop-off.
      c.depth = [150, 300, 600].map((off) => {
        const ox = cx - (ne * off) / g.cell, oy = cy + (nn * off) / g.cell;
        const j = at(ox, oy);
        if (j < 0 || !water[j]) return null;
        const dd = depthAt(ox, oy);
        return dd == null ? null : Math.max(0, Math.round(dd * 10) / 10);
      });
    }
    if (water[i] === 2) {
      c.river = 1;
      // Channel width: shortest water crossing through this bank point.
      c.width = Math.round(waterRun(cx, cy, -ne, -nn, 5000).d);
    }
    if (bridgeDist && bridgeDist[i] * g.cell <= 1000) c.bridge = Math.round(bridgeDist[i] * g.cell);
    cand.push(c);
  }
  return {
    ok: cand.length > 0,
    v: SITE_VERSION,
    cell: Math.round(g.cell),
    waterKm2: Math.round(((size * g.cell * g.cell) / 1e6) * 100) / 100,
    touchesEdge: edge,
    waterFromLake,
    roadsKnown,
    waterElev: waterElev == null ? null : Math.round(waterElev),
    bathy,
    beachesKnown,
    cand,
  };
}

// ---------- rating ----------

export const PARAMS = {
  // Wind angle to the shore: 0 = straight onshore, 90 = side-shore, 180 = offshore.
  angle: [[15, 0.7], [65, 1], [95, 0.9], [110, 0.4], [130, 0.1], [181, 0]],
  // On flats you can stand on, offshore wind is far less dangerous: if you
  // drop the kite you walk back. Standable: up to shallowMax m deep 150 and
  // 300 m out.
  shallowAngle: [[15, 0.7], [65, 1], [95, 0.95], [110, 0.85], [130, 0.65], [181, 0.45]],
  shallowMax: 1.6,
  // Clean wind over water: below cleanMin m it is too gusty to use; beyond
  // that it gets steadier, about 63% of the way there after cleanScale m.
  cleanMin: 100,
  cleanScale: 1000,
  cleanOpen: 3000, // what open sea or water past the edge of the map counts as
  // Water to ride across the wind, same shape.
  reachScale: 900,
  river: 0.85, // current, barges, snags and sandbars
  accessNear: 300,
  accessFar: 800,
  accessFarF: 0.85,
  accessNoneF: 0.6,
  top: 2,
  // Shore type: a bank this many metres high within 120 m is a bluff or
  // cliff; bare rock and built-up waterfronts (seawalls, docks) are hard to
  // launch from; a sand beach is ideal.
  bankHigh: 15,
  bankMid: 8,
  shoreCliff: 0.3,
  shoreBank: 0.7,
  shoreRock: 0.5,
  shoreBuilt: 0.7,
};

/** How launchable the shore itself is (0..1), and why. */
export function shoreFactor(c, P = PARAMS) {
  if (c.beach) return { f: 1, why: 'beach' };
  let f = 1, why = null;
  if (c.bank != null && c.bank >= P.bankHigh) { f = P.shoreCliff; why = 'cliff'; }
  else if (c.bank != null && c.bank >= P.bankMid) { f = P.shoreBank; why = 'bank'; }
  if (c.rock && P.shoreRock < f) { f = P.shoreRock; why = 'rock'; }
  if (c.built && P.shoreBuilt < f) { f = P.shoreBuilt; why = 'built'; }
  return { f, why };
}

export function angleFactor(th, P = PARAMS, shallow = false) {
  for (const [lim, f] of shallow && P.shallowAngle ? P.shallowAngle : P.angle) if (th <= lim) return f;
  return 0;
}

/** True when the water off this launch is shallow enough to stand in. */
export function isShallow(c, P = PARAMS) {
  const d = c.depth;
  return !!d && d[0] != null && d[1] != null && d[0] <= P.shallowMax && d[1] <= P.shallowMax;
}

/** Score each launch candidate for each direction. Returns { Q[16], best[16] }. */
export function rate(raw, P = PARAMS) {
  const Q = new Array(16).fill(0);
  const best = new Array(16).fill(null);
  if (!raw?.ok) return { Q, best };
  for (let d = 0; d < 16; d++) {
    const qs = [];
    raw.cand.forEach((c, ci) => {
      const [th, W, open, sh, src, shH, reach] = c.dirs[d];
      const clean = open ? Math.max(W, P.cleanOpen) : W - sh;
      const shallow = isShallow(c, P);
      const fa = angleFactor(th, P, shallow);
      const fc = clean <= P.cleanMin ? 0 : 1 - Math.exp(-(clean - P.cleanMin) / P.cleanScale);
      const fr = 1 - Math.exp(-reach / P.reachScale);
      const fx = c.access == null ? 1 : c.access <= P.accessNear ? 1 : c.access <= P.accessFar ? P.accessFarF : P.accessNoneF;
      const fs = shoreFactor(c, P).f;
      const q = fa * fc * Math.sqrt(fr) * fx * fs * (c.river ? P.river : 1);
      qs.push({ ci, q, fa, fc, fr, fx, fs, th, W, open, sh, src, shH, reach, clean, shallow });
    });
    qs.sort((a, b) => b.q - a.q);
    const top = qs.slice(0, P.top);
    Q[d] = top.length ? top.reduce((s, t) => s + t.q, 0) / top.length : 0;
    best[d] = qs[0] || null;
  }
  return { Q, best };
}
