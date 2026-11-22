// Launch and access check from OpenStreetMap. For each launch point it asks
// the Overpass API what is around: public beaches, parks and public land, boat
// ramps, parking, and the things that rule a launch out or make it risky:
// private land, military areas, places tagged no-kiting, power lines,
// swimming areas and airports. Nothing here is tied to particular places: it
// is the same check everywhere. Results are saved, so they work offline.

const OVERPASS = 'https://overpass-api.de/api/interpreter';

export const accessKey = (lat, lon) => `access/${lat.toFixed(4)},${lon.toFixed(4)}`;

/** Overpass query for several launch points. Each point's results follow a marker. */
export function buildQuery(points) {
  const parts = points.map(([lat, lon], i) => {
    const a = (r) => `(around:${r},${lat.toFixed(5)},${lon.toFixed(5)})`;
    return `make spot i=${i};out;
is_in(${lat.toFixed(5)},${lon.toFixed(5)})->.a;
area.a[~"^(leisure|landuse|boundary|access|military|natural|kitesurfing)$"~"."];out tags;
(nwr${a(400)}[leisure~"^(slipway|park|nature_reserve|beach_resort|swimming_area|marina|common|recreation_ground)$"];
nwr${a(400)}[natural=beach];
nwr${a(600)}[amenity=parking];
way${a(250)}[power~"^(line|minor_line)$"];
nwr${a(2500)}[sport~"kitesurfing"];
nwr${a(2500)}[kitesurfing];
nwr${a(5000)}[aeroway=aerodrome];
nwr${a(150)}[access~"^(private|no)$"][!highway][!barrier];
nwr${a(400)}[boundary~"^(protected_area|national_park)$"];
nwr${a(300)}[landuse=military];
);out tags center qt;`;
  });
  return `[out:json][timeout:60];\n${parts.join('\n')}`;
}

function distM(lat1, lon1, lat2, lon2) {
  const k = Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  return Math.hypot((lon2 - lon1) * 111320 * k, (lat2 - lat1) * 110540);
}

/** Split an Overpass answer into one summary per point. */
export function parseAccess(json, points) {
  const out = points.map(() => ({ items: [] }));
  let cur = -1;
  for (const e of json.elements || []) {
    if (e.type === 'spot') { cur = +e.tags.i; continue; }
    if (cur < 0 || !out[cur]) continue;
    const [lat, lon] = points[cur];
    const at = e.center || (e.lat != null ? { lat: e.lat, lon: e.lon } : null);
    const inside = e.type === 'area';
    const d = inside ? 0 : at ? Math.round(distM(lat, lon, at.lat, at.lon)) : null;
    const item = classify(e.tags || {});
    if (item) out[cur].items.push({ ...item, d, inside, name: e.tags?.name || null });
  }
  for (const s of out) s.items = dedupe(s.items);
  return out.map((s) => summarize(s.items));
}

/** What an OSM object means for a kite launch. */
export function classify(t) {
  const acc = t.access;
  const priv = acc === 'private' || acc === 'no';
  if (t.kitesurfing === 'no') return { kind: 'banned', label: 'Kiting not allowed (tagged on the map)' };
  if (t.kitesurfing === 'yes' || /(^|;)kitesurfing(;|$)/.test(t.sport || '')) return { kind: 'kitespot', label: 'Mapped as a kitesurfing spot' };
  if (t.landuse === 'military' || t.military) return { kind: 'military', label: 'Military area' };
  if (t.aeroway === 'aerodrome') return { kind: 'airport', label: t.name ? `Airport (${t.name})` : 'Airport' };
  if (t.power === 'line' || t.power === 'minor_line') return { kind: 'power', label: 'Power line' };
  if (t.leisure === 'swimming_area') return { kind: 'swim', label: 'Swimming area' };
  if (t.leisure === 'slipway') return priv ? { kind: 'private', label: 'Private boat ramp' } : { kind: 'ramp', label: 'Boat ramp' };
  if (t.natural === 'beach' || t.leisure === 'beach_resort') return priv ? { kind: 'private', label: 'Private beach' } : { kind: 'beach', label: 'Beach' };
  if (t.amenity === 'parking') return priv ? null : { kind: 'parking', label: 'Parking' };
  if (t.leisure === 'marina') return { kind: 'marina', label: 'Marina (boats)' };
  if (t.boundary === 'protected_area' || t.boundary === 'national_park' || t.leisure === 'nature_reserve') return { kind: 'protected', label: t.name ? `Protected area (${t.name})` : 'Protected area' };
  if (['park', 'common', 'recreation_ground'].includes(t.leisure)) return priv ? { kind: 'private', label: 'Private grounds' } : { kind: 'park', label: t.name ? `Park (${t.name})` : 'Park' };
  if (t.landuse === 'residential') return { kind: 'residential', label: 'Homes along the shore' };
  if (priv) return { kind: 'private', label: 'Private property' };
  return null;
}

function dedupe(items) {
  const best = new Map();
  for (const it of items) {
    const ex = best.get(it.kind);
    if (!ex || (it.d ?? 1e9) < (ex.d ?? 1e9)) best.set(it.kind, it);
  }
  return [...best.values()];
}

const near = (it, m) => it && (it.inside || (it.d != null && it.d <= m));

/**
 * Summary: { items, factor (multiplies the spot score), level: 'public' |
 * 'unknown' | 'limited' | 'no' }
 */
export function summarize(items) {
  const get = (k) => items.find((i) => i.kind === k);
  const pub = ['beach', 'park', 'ramp'].some((k) => near(get(k), 400)) || near(get('protected'), 0) || near(get('kitespot'), 1500);
  let factor = pub ? 1 : 0.9;
  let level = pub ? 'public' : 'unknown';
  if (near(get('banned'), 1500)) { factor = 0.2; level = 'no'; }
  else if (near(get('military'), 300)) { factor = 0.2; level = 'no'; }
  else if (get('private')?.inside) { factor = 0.5; level = 'limited'; }
  else if (!pub && near(get('private'), 150)) { factor = 0.75; level = 'limited'; }
  else if (!pub && get('residential')?.inside) { factor = 0.8; level = 'limited'; }
  if (near(get('power'), 250)) factor *= 0.85;
  if (near(get('airport'), 5000)) factor *= 0.95;
  return { items, factor: Math.round(factor * 100) / 100, level };
}

/** Plain-language lines for the popup: [{kind: good|warn|bad|info, text}] */
export function accessReasons(sum) {
  if (!sum) return [];
  const fm = (d) => (d == null ? '' : d === 0 ? ' at the launch' : d >= 1000 ? ` ${(d / 1000).toFixed(1)} km away` : ` ${Math.round(d / 10) * 10} m away`);
  const out = [];
  for (const it of [...sum.items].sort((a, b) => (a.d ?? 0) - (b.d ?? 0))) {
    switch (it.kind) {
      case 'beach': case 'park': case 'ramp': out.push({ kind: 'good', text: `${it.label}${fm(it.d)}: a public place to launch.` }); break;
      case 'parking': out.push({ kind: 'good', text: `Parking${fm(it.d)}.` }); break;
      case 'kitespot': out.push({ kind: 'good', text: `${it.label}${fm(it.d)}.` }); break;
      case 'banned': out.push({ kind: 'bad', text: `${it.label}${fm(it.d)}.` }); break;
      case 'military': out.push({ kind: 'bad', text: `Military area${fm(it.d)}: no access.` }); break;
      case 'private': out.push({ kind: it.inside ? 'bad' : 'warn', text: `${it.label}${fm(it.d)}${it.inside ? ': you would need permission to launch here' : ''}.` }); break;
      case 'residential': out.push({ kind: 'warn', text: 'Homes along this shore: the waterfront is likely private. Look for a public access point.' }); break;
      case 'power': out.push({ kind: 'bad', text: `Power line${fm(it.d)}: deadly if your lines touch it. Launch well away from it.` }); break;
      case 'airport': out.push({ kind: 'warn', text: `${it.label}${fm(it.d)}: kites may be height-limited near airports.` }); break;
      case 'swim': out.push({ kind: 'warn', text: `Swimming area${fm(it.d)}: keep well clear of swimmers.` }); break;
      case 'protected': out.push({ kind: 'info', text: `${it.label}${fm(it.d)}: public land, but check its rules (some ban kiting or have nesting seasons).` }); break;
      case 'marina': out.push({ kind: 'info', text: `Marina${fm(it.d)}: watch for boat traffic.` }); break;
    }
  }
  if (sum.level === 'unknown') out.push({ kind: 'info', text: 'No public beach, park or ramp is mapped near this launch. Access is unknown.' });
  out.push({ kind: 'info', text: 'From OpenStreetMap. Always check local rules and signs.' });
  return out;
}

/**
 * Access summaries for launch points, from the saved copy when there is one,
 * otherwise from Overpass (online). kv = backend. Returns Map(key -> summary).
 */
export async function fetchAccess(points, kv, httpJson, { online = true, max = 25 } = {}) {
  const res = new Map();
  const todo = [];
  for (const p of points) {
    const k = accessKey(p[0], p[1]);
    const s = await kv.kvGet(k);
    if (s) res.set(k, s);
    else todo.push(p);
  }
  if (!online || !todo.length) return res;
  for (let i = 0; i < Math.min(todo.length, max); i += 25) {
    const part = todo.slice(i, Math.min(i + 25, max));
    const json = await httpJson(OVERPASS, { refresh: true, body: 'data=' + encodeURIComponent(buildQuery(part)) });
    const sums = parseAccess(json, part);
    for (let j = 0; j < part.length; j++) {
      const k = accessKey(part[j][0], part[j][1]);
      sums[j].fetched = Date.now();
      await kv.kvSet(k, sums[j]);
      res.set(k, sums[j]);
    }
  }
  return res;
}
