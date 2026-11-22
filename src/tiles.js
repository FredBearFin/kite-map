// Map tiles that keep working offline.
//
// MapLibre asks for tiles through a custom "kt://" protocol. Each tile is
// looked up in the local store first; if missing and online, it is fetched,
// saved, and returned. Basemap vector tiles are read out of the latest
// Protomaps OpenStreetMap build (one big PMTiles file) with HTTP range reads.

import maplibregl from 'maplibre-gl';
import { PMTiles, bytesToHeader } from 'pmtiles';
import { backend } from './backend.js';

export const SOURCES = {
  dem: {
    url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    maxzoom: 12,
  },
  geo: {
    url: 'https://tiles.macrostrat.org/carto/{z}/{x}/{y}.png',
    maxzoom: 12,
  },
  // Sentinel-2 cloudless 2024 by EOX IT Services GmbH (contains modified
  // Copernicus Sentinel data). Free for non-commercial use with attribution.
  sat: {
    url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg',
    maxzoom: 14,
  },
};

export const ASSETS = {
  glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
  sprite: 'https://protomaps.github.io/basemaps-assets/sprites/v4/light',
};

// The desktop app fetches these natively; a plain browser goes through the
// dev server's proxy (vite.config.js), as the host sends no CORS headers.
const BUILDS_URL = backend.isTauri ? 'https://build-metadata.protomaps.dev/builds.json' : '/protomaps-meta/builds.json';
const BUILD_BASE = backend.isTauri ? 'https://build.protomaps.com/' : new URL('/protomaps/', location.href).href;

export const status = { online: navigator.onLine, lastError: null };
window.addEventListener('online', () => (status.online = true));
window.addEventListener('offline', () => (status.online = false));

/** PMTiles byte source that goes through the Rust downloader and saves directories. */
class SavedSource {
  constructor(url, build) {
    this.url = url;
    this.build = build;
    this.tileDataOffset = null;
  }
  getKey() {
    return this.url;
  }
  async getBytes(offset, length) {
    // The header and directories sit before the tile data; save those so the
    // archive index survives restarts. Tile bytes are saved per tile instead.
    const isIndex = this.tileDataOffset == null || offset < this.tileDataOffset;
    const key = isIndex ? `pm/${this.build}/${offset}/${length}` : null;
    const data = await backend.httpGet(this.url, { key, range: [offset, length] });
    if (offset === 0 && this.tileDataOffset == null && data.length >= 127) {
      try {
        this.tileDataOffset = bytesToHeader(data.buffer.slice(data.byteOffset, data.byteOffset + data.length)).tileDataOffset;
      } catch {}
    }
    return { data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
  }
}

let pm = null;

/** Pick (and remember) the newest Protomaps build. */
async function currentBuild() {
  const saved = await backend.kvGet('basemap/build');
  const fresh = saved && Date.now() - saved.checked < 7 * 86400e3;
  if (fresh) return saved.name;
  try {
    const builds = await backend.httpJson(BUILDS_URL, { key: 'a/builds.json', refresh: true });
    const names = builds.map((b) => b.key).filter((k) => /^\d{8}\.pmtiles$/.test(k)).sort();
    const name = names[names.length - 1];
    if (name) {
      await backend.kvSet('basemap/build', { name, checked: Date.now() });
      return name;
    }
  } catch (e) {
    status.lastError = 'Could not check for map updates: ' + e;
  }
  if (saved) return saved.name;
  // Fall back to guessing a recent daily build.
  for (let d = 1; d <= 10; d++) {
    const t = new Date(Date.now() - d * 86400e3);
    const name = t.toISOString().slice(0, 10).replace(/-/g, '') + '.pmtiles';
    try {
      await backend.httpGet(BUILD_BASE + name, { range: [0, 127] });
      await backend.kvSet('basemap/build', { name, checked: Date.now() });
      return name;
    } catch {}
  }
  return null;
}

async function getPm() {
  if (pm) return pm;
  const build = await currentBuild();
  if (!build) throw new Error('no basemap build available');
  pm = new PMTiles(new SavedSource(BUILD_BASE + build, build));
  return pm;
}

/** Forget the current build (after a 404, builds are deleted after a while). */
async function resetBuild() {
  pm = null;
  await backend.kvDelete('basemap/build');
}

const tileKey = (layer, z, x, y) => `t/${layer}/${z}/${x}/${y}`;

// In the desktop app, tiles come from the native "ktiles" scheme: saved tiles
// are read straight from the database without passing through JavaScript.
const isWindows = /Windows/.test(navigator.userAgent);
export const NATIVE_TILES = backend.isTauri;
const NATIVE_BASE = isWindows ? 'http://ktiles.localhost' : 'ktiles://localhost';

/** URL template for a tile layer (osm, dem, geo, sat) for MapLibre. */
export function tileTemplate(layer) {
  return NATIVE_TILES ? `${NATIVE_BASE}/${layer}/{z}/{x}/{y}` : `kt://${layer}/{z}/{x}/{y}`;
}

/** Choose the basemap build and hand it to the native tile server. */
export async function initBasemap() {
  if (!NATIVE_TILES) return;
  const { invoke } = await import('@tauri-apps/api/core');
  const build = await currentBuild();
  if (build) await invoke('set_basemap', { url: BUILD_BASE + build, build });
}

/** Save the world at low zoom (z0-4, about 340 tiles) so zooming out is instant offline. */
export async function prefetchWorld() {
  const list = [];
  for (let z = 0; z <= 4; z++) for (let x = 0; x < 2 ** z; x++) for (let y = 0; y < 2 ** z; y++) list.push([z, x, y]);
  const has = await backend.cacheHas(list.map(([z, x, y]) => tileKey('osm', z, x, y)));
  const todo = list.filter((_, i) => !has[i]);
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const t = todo[i++];
      try { await fetchTile('osm', ...t); } catch {}
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

/** Fetch one tile into the store (if not there). Returns the bytes. */
export async function fetchTile(layer, z, x, y) {
  if (NATIVE_TILES) {
    const r = await fetch(`${NATIVE_BASE}/${layer}/${z}/${x}/${y}`);
    if (!r.ok) throw new Error(`tile ${layer}/${z}/${x}/${y}: ${await r.text()}`);
    return new Uint8Array(await r.arrayBuffer());
  }
  const key = tileKey(layer, z, x, y);
  const saved = await backend.cacheGet(key);
  if (saved) return saved;
  if (layer === 'osm') {
    let p = await getPm();
    let r;
    try {
      r = await p.getZxy(z, x, y);
    } catch (e) {
      if (/http 40[34]/.test(String(e))) {
        await resetBuild();
        p = await getPm();
        r = await p.getZxy(z, x, y);
      } else throw e;
    }
    const bytes = r ? new Uint8Array(r.data) : new Uint8Array(0);
    await backend.cachePut(key, bytes);
    return bytes;
  }
  const src = SOURCES[layer];
  const url = src.url.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  return backend.httpGet(url, { key });
}

/** Fetch a font or sprite file into the store. */
export async function fetchAsset(url) {
  return backend.httpGet(url, { key: 'a/' + url });
}

function asBuffer(u8) {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

export function registerProtocol() {
  maplibregl.addProtocol('kt', async (params) => {
    const path = params.url.slice('kt://'.length);
    if (path.startsWith('asset/')) {
      const url = decodeURIComponent(path.slice('asset/'.length));
      try {
        const b = await fetchAsset(url);
        if (url.endsWith('.json')) return { data: JSON.parse(new TextDecoder().decode(b)) };
        return { data: asBuffer(b) };
      } catch (e) {
        // A missing font range offline: return an empty glyph set so the
        // rest of the labels still draw.
        if (url.endsWith('.pbf')) return { data: new ArrayBuffer(0) };
        // Missing icons offline: an empty sprite keeps the map loading.
        if (url.endsWith('.json')) return { data: {} };
        if (url.endsWith('.png')) return { data: asBuffer(EMPTY_PNG) };
        throw e;
      }
    }
    const [layer, z, x, y] = path.split('/');
    try {
      const b = await fetchTile(layer, +z, +x, +y);
      return { data: asBuffer(b) };
    } catch (e) {
      status.lastError = String(e);
      if (layer === 'osm') return { data: new ArrayBuffer(0) };
      throw e;
    }
  });
}

// 1x1 transparent PNG
const EMPTY_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

export const assetUrl = (url) => 'kt://asset/' + encodeURIComponent(url);

/** Glyph URL template that MapLibre fills in, routed through the store. */
export function glyphsTemplate() {
  // MapLibre substitutes {fontstack} and {range} before calling the protocol,
  // so encode everything except those tokens.
  const [a, rest] = ASSETS.glyphs.split('{fontstack}');
  const [b, c] = rest.split('{range}');
  return 'kt://asset/' + encodeURIComponent(a) + '{fontstack}' + encodeURIComponent(b) + '{range}' + encodeURIComponent(c);
}
