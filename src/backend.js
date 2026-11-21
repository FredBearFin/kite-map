// Thin wrapper over the Rust commands. When the page runs in a plain browser
// (for development), it falls back to fetch() and an in-memory store.

const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;

let invoke = null;
if (isTauri) {
  ({ invoke } = await import('@tauri-apps/api/core'));
}

const mem = new Map();
const memKv = new Map();

function toBytes(v) {
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return new Uint8Array(v);
  return new Uint8Array(v);
}

export const backend = {
  isTauri,

  /** Saved bytes for key, or null. */
  async cacheGet(key) {
    if (!isTauri) return mem.get(key) ?? null;
    try {
      return toBytes(await invoke('cache_get', { key }));
    } catch (e) {
      if (String(e) === 'miss') return null;
      throw e;
    }
  },

  async cacheHas(keys) {
    if (!isTauri) return keys.map((k) => mem.has(k));
    return invoke('cache_has', { keys });
  },

  async cachePut(key, bytes) {
    if (!isTauri) return void mem.set(key, toBytes(bytes));
    await invoke('cache_put', toBytes(bytes), { headers: { 'x-key': key } });
  },

  async cacheStats(prefix = '') {
    if (!isTauri) {
      let count = 0, bytes = 0;
      for (const [k, v] of mem) if (k.startsWith(prefix)) { count++; bytes += v.length; }
      return { count, bytes };
    }
    return invoke('cache_stats', { prefix });
  },

  async cacheDeletePrefix(prefix) {
    if (!isTauri) {
      for (const k of [...mem.keys()]) if (k.startsWith(prefix)) mem.delete(k);
      return;
    }
    return invoke('cache_delete_prefix', { prefix });
  },

  /**
   * GET a URL. With key: saved, and served from the saved copy next time
   * (unless refresh). Range = [start, length] for partial reads.
   */
  async httpGet(url, { key = null, range = null, refresh = false } = {}) {
    if (!isTauri) {
      if (key && !refresh && mem.has(key)) return mem.get(key);
      const headers = range ? { Range: `bytes=${range[0]}-${range[0] + range[1] - 1}` } : {};
      try {
        const r = await fetch(url, { headers });
        if (!r.ok) throw new Error(`http ${r.status}`);
        const b = new Uint8Array(await r.arrayBuffer());
        if (key) mem.set(key, b);
        return b;
      } catch (e) {
        if (key && mem.has(key)) return mem.get(key);
        throw e;
      }
    }
    const out = await invoke('http_get', {
      url,
      key,
      rangeStart: range ? range[0] : null,
      rangeLen: range ? range[1] : null,
      refresh,
    });
    return toBytes(out);
  },

  async httpJson(url, opts) {
    return JSON.parse(new TextDecoder().decode(await this.httpGet(url, opts)));
  },

  async kvGet(key, fallback = null) {
    const v = isTauri ? await invoke('kv_get', { key }) : memKv.get(key) ?? localGet(key);
    if (v == null) return fallback;
    try {
      return JSON.parse(v);
    } catch {
      return fallback;
    }
  },

  async kvSet(key, value) {
    const s = JSON.stringify(value);
    if (!isTauri) {
      memKv.set(key, s);
      localSet(key, s);
      return;
    }
    await invoke('kv_set', { key, value: s });
  },

  async kvDelete(key) {
    if (!isTauri) {
      memKv.delete(key);
      try { localStorage.removeItem('kv:' + key); } catch {}
      return;
    }
    await invoke('kv_delete', { key });
  },

  async kvList(prefix) {
    let rows;
    if (isTauri) rows = await invoke('kv_list', { prefix });
    else rows = [...memKv.entries()].filter(([k]) => k.startsWith(prefix));
    return rows.map(([k, v]) => [k, JSON.parse(v)]);
  },

  /** Build the lake database from a HydroLAKES zip or .shp on this computer. */
  async lakesImport(path) {
    if (!isTauri) throw new Error('Lake import needs the desktop app.');
    return invoke('lakes_import', { path });
  },

  async lakesDownload(url) {
    if (!isTauri) throw new Error('Lake download needs the desktop app.');
    return invoke('lakes_download', { url });
  },

  async pickLakeFile() {
    if (!isTauri) return null;
    const { open } = await import('@tauri-apps/plugin-dialog');
    return open({
      title: 'Choose HydroLAKES_polys_v10_shp.zip (or the .shp inside it)',
      multiple: false,
      directory: false,
      filters: [{ name: 'HydroLAKES zip or shapefile', extensions: ['zip', 'shp'] }],
    });
  },

  async onLakesProgress(cb) {
    if (!isTauri) return () => {};
    const { listen } = await import('@tauri-apps/api/event');
    return listen('lakes-progress', (e) => cb(e.payload));
  },

  async dataFolder() {
    return isTauri ? invoke('data_folder') : '(browser memory)';
  },
};

function localGet(key) {
  try { return localStorage.getItem('kv:' + key); } catch { return null; }
}
function localSet(key, s) {
  try { localStorage.setItem('kv:' + key, s); } catch {}
}
