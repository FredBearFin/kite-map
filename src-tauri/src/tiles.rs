//! Map tiles served straight from the local database through the `ktiles`
//! URL scheme, so MapLibre loads saved tiles without going through
//! JavaScript. Missing tiles are fetched once (when online) and saved.
//!
//! Basemap vector tiles are read from the Protomaps OpenStreetMap build, a
//! single PMTiles v3 archive, with HTTP range requests.

use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, Mutex};

use flate2::read::GzDecoder;
use tauri::http::{Response, StatusCode};
use tauri::{AppHandle, Manager};

use crate::AppState;

#[derive(Clone, Copy)]
pub struct Header {
    root_off: u64,
    root_len: u64,
    leaf_off: u64,
    data_off: u64,
    internal_comp: u8,
    tile_comp: u8,
    max_zoom: u8,
}

#[derive(Clone, Copy)]
struct Entry {
    tile_id: u64,
    offset: u64,
    length: u64,
    run_length: u64,
}

/// A downloaded copy of the low zoom levels of one Protomaps build.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct Planet {
    pub url: String,
    pub build: String,
    pub maxzoom: u8,
    pub data_bytes: u64,
    pub complete: bool,
}

#[derive(Default)]
pub struct Basemap {
    /// The build used for tiles that are not in the planet file (url, build).
    online: Option<(String, String)>,
    planet: Option<Planet>,
    planet_file: Option<std::path::PathBuf>,
    headers: HashMap<String, Header>,
    dirs: HashMap<(String, u64, u64), Arc<Vec<Entry>>>,
}

pub type BasemapState = Mutex<Basemap>;

pub fn set_basemap(state: &BasemapState, url: String, build: String) {
    state.lock().unwrap().online = Some((url, build));
}

fn planet_paths(app: &AppHandle) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok((dir.join("planet.json"), dir.join("planet-tiles.bin")))
}

/// Load the saved planet download (if any) at startup.
pub fn load_planet(app: &AppHandle) {
    if let Ok((cfg, file)) = planet_paths(app) {
        if let Ok(text) = std::fs::read_to_string(cfg) {
            if let Ok(p) = serde_json::from_str::<Planet>(&text) {
                let bm = app.state::<BasemapState>();
                let mut b = bm.lock().unwrap();
                b.planet = Some(p);
                b.planet_file = Some(file);
            }
        }
    }
}

pub fn planet_status(app: &AppHandle) -> Option<Planet> {
    app.state::<BasemapState>().lock().unwrap().planet.clone()
}

fn raster_url(layer: &str) -> Option<&'static str> {
    Some(match layer {
        "dem" => "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
        "geo" => "https://tiles.macrostrat.org/carto/{z}/{x}/{y}.png",
        "sat" => "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg",
        _ => return None,
    })
}

fn u64_at(b: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(b[o..o + 8].try_into().unwrap())
}

fn parse_header(b: &[u8]) -> Result<Header, String> {
    if b.len() < 127 || &b[0..7] != b"PMTiles" || b[7] != 3 {
        return Err("not a PMTiles v3 archive".into());
    }
    Ok(Header {
        root_off: u64_at(b, 8),
        root_len: u64_at(b, 16),
        leaf_off: u64_at(b, 40),
        data_off: u64_at(b, 56),
        internal_comp: b[97],
        tile_comp: b[98],
        max_zoom: b[101],
    })
}

fn read_varint(buf: &[u8], pos: &mut usize) -> Result<u64, String> {
    let mut val = 0u64;
    let mut shift = 0;
    loop {
        let b = *buf.get(*pos).ok_or("truncated directory")?;
        *pos += 1;
        val |= ((b & 0x7f) as u64) << shift;
        if b < 0x80 {
            return Ok(val);
        }
        shift += 7;
        if shift > 63 {
            return Err("bad varint".into());
        }
    }
}

fn parse_dir(buf: &[u8]) -> Result<Vec<Entry>, String> {
    let mut p = 0;
    let n = read_varint(buf, &mut p)? as usize;
    let mut e = Vec::with_capacity(n);
    let mut last = 0u64;
    for _ in 0..n {
        last += read_varint(buf, &mut p)?;
        e.push(Entry { tile_id: last, offset: 0, length: 0, run_length: 1 });
    }
    for x in e.iter_mut() {
        x.run_length = read_varint(buf, &mut p)?;
    }
    for x in e.iter_mut() {
        x.length = read_varint(buf, &mut p)?;
    }
    for i in 0..n {
        let v = read_varint(buf, &mut p)?;
        e[i].offset = if v == 0 && i > 0 { e[i - 1].offset + e[i - 1].length } else { v.saturating_sub(1) };
    }
    Ok(e)
}

pub fn zxy_to_tile_id(z: u8, x: u64, y: u64) -> u64 {
    let n = 1u64 << z;
    let mut acc = (n * n - 1) / 3;
    let (mut tx, mut ty) = (x, y);
    let mut s = n >> 1;
    while s > 0 {
        let rx = tx & s;
        let ry = ty & s;
        acc += ((3 * rx) ^ ry) * s;
        if ry == 0 {
            if rx != 0 {
                let (nx, ny) = (s - 1 - (ty & (s - 1)), s - 1 - (tx & (s - 1)));
                // rotate within the current quadrant size (matches the reference implementation)
                tx = nx;
                ty = ny;
            } else {
                std::mem::swap(&mut tx, &mut ty);
            }
        }
        s >>= 1;
    }
    acc
}

fn find(entries: &[Entry], id: u64) -> Option<Entry> {
    let idx = match entries.binary_search_by(|e| e.tile_id.cmp(&id)) {
        Ok(i) => return Some(entries[i]),
        Err(0) => return None,
        Err(i) => i - 1,
    };
    let e = entries[idx];
    if e.run_length == 0 || id - e.tile_id < e.run_length {
        Some(e)
    } else {
        None
    }
}

fn gunzip(b: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    GzDecoder::new(b).read_to_end(&mut out).map_err(|e| format!("gzip: {e}"))?;
    Ok(out)
}

async fn http_range(app: &AppHandle, url: &str, off: u64, len: u64) -> Result<Vec<u8>, String> {
    let state = app.state::<AppState>();
    let resp = state
        .http
        .get(url)
        .header("Range", format!("bytes={}-{}", off, off + len - 1))
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("http {}", resp.status().as_u16()));
    }
    Ok(resp.bytes().await.map_err(|e| format!("network: {e}"))?.to_vec())
}

/// Bytes of an archive range, saved in the database (headers and directories only).
async fn saved_range(app: &AppHandle, url: &str, build: &str, off: u64, len: u64) -> Result<Vec<u8>, String> {
    let key = format!("pm/{build}/{off}/{len}");
    let state = app.state::<AppState>();
    if let Some(d) = crate::db_get(&state, &key)? {
        return Ok(d);
    }
    let d = http_range(app, url, off, len).await?;
    crate::db_put(&state, &key, &d)?;
    Ok(d)
}

async fn header(app: &AppHandle, url: &str, build: &str) -> Result<Header, String> {
    if let Some(h) = app.state::<BasemapState>().lock().unwrap().headers.get(build) {
        return Ok(*h);
    }
    let first = saved_range(app, url, build, 0, 16384).await?;
    let h = parse_header(&first)?;
    app.state::<BasemapState>().lock().unwrap().headers.insert(build.to_string(), h);
    Ok(h)
}

async fn directory(app: &AppHandle, url: &str, build: &str, h: &Header, off: u64, len: u64) -> Result<Arc<Vec<Entry>>, String> {
    let bm = app.state::<BasemapState>();
    if let Some(d) = bm.lock().unwrap().dirs.get(&(build.to_string(), off, len)) {
        return Ok(d.clone());
    }
    let raw = saved_range(app, url, build, off, len).await?;
    let buf = if h.internal_comp == 2 { gunzip(&raw)? } else { raw };
    let dir = Arc::new(parse_dir(&buf)?);
    let mut b = bm.lock().unwrap();
    if b.dirs.len() > 2000 {
        b.dirs.clear();
    }
    b.dirs.insert((build.to_string(), off, len), dir.clone());
    Ok(dir)
}

/// Find the tile data entry (offset relative to the tile data section).
async fn lookup(app: &AppHandle, url: &str, build: &str, h: &Header, z: u8, x: u64, y: u64) -> Result<Option<Entry>, String> {
    let id = zxy_to_tile_id(z, x, y);
    let (mut off, mut len) = (h.root_off, h.root_len);
    for _ in 0..4 {
        let dir = directory(app, url, build, h, off, len).await?;
        let Some(e) = find(&dir, id) else { return Ok(None) };
        if e.run_length == 0 {
            off = h.leaf_off + e.offset;
            len = e.length;
            continue;
        }
        return Ok(Some(e));
    }
    Err("directory too deep".into())
}

fn read_file_range(path: &std::path::Path, off: u64, len: u64) -> Result<Vec<u8>, String> {
    use std::io::{Seek, SeekFrom};
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(off)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; len as usize];
    f.read_exact(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

async fn basemap_tile(app: &AppHandle, z: u8, x: u64, y: u64) -> Result<Vec<u8>, String> {
    let (online, planet, planet_file) = {
        let b = app.state::<BasemapState>();
        let b = b.lock().unwrap();
        (b.online.clone(), b.planet.clone(), b.planet_file.clone())
    };
    // 1. The downloaded world map, for low zoom levels.
    if let (Some(p), Some(file)) = (planet, planet_file) {
        if p.complete && z <= p.maxzoom {
            let h = header(app, &p.url, &p.build).await?;
            let Some(e) = lookup(app, &p.url, &p.build, &h, z, x, y).await? else { return Ok(Vec::new()) };
            let raw = read_file_range(&file, e.offset, e.length)?;
            return if h.tile_comp == 2 { gunzip(&raw) } else { Ok(raw) };
        }
    }
    // 2. Otherwise read the online build.
    let (url, build) = online.ok_or("offline: basemap not set")?;
    let h = header(app, &url, &build).await?;
    if z > h.max_zoom {
        return Ok(Vec::new());
    }
    let Some(e) = lookup(app, &url, &build, &h, z, x, y).await? else { return Ok(Vec::new()) };
    let raw = http_range(app, &url, h.data_off + e.offset, e.length).await?;
    if h.tile_comp == 2 { gunzip(&raw) } else { Ok(raw) }
}

/// Size of the world map download up to `maxzoom` and the leaf directories it needs.
pub struct PlanetPlan {
    pub url: String,
    pub build: String,
    pub data_bytes: u64,
    leaf_range: Option<(u64, u64)>,
    leaves: Vec<Entry>,
}

pub async fn planet_plan(app: &AppHandle, maxzoom: u8) -> Result<PlanetPlan, String> {
    let (url, build) = app.state::<BasemapState>().lock().unwrap().online.clone().ok_or("Connect to the internet to download the world map.")?;
    let h = header(app, &url, &build).await?;
    let maxzoom = maxzoom.min(h.max_zoom);
    let limit = zxy_to_tile_id(maxzoom + 1, 0, 0); // first tile id past maxzoom
    let root = directory(app, &url, &build, &h, h.root_off, h.root_len).await?;
    let mut end = 0u64;
    let mut leaves = Vec::new();
    for e in root.iter().filter(|e| e.tile_id < limit) {
        if e.run_length == 0 {
            leaves.push(*e);
        } else {
            end = end.max(e.offset + e.length);
        }
    }
    let leaf_range = if leaves.is_empty() {
        None
    } else {
        let a = leaves.iter().map(|e| e.offset).min().unwrap();
        let b = leaves.iter().map(|e| e.offset + e.length).max().unwrap();
        Some((a, b - a))
    };
    // Tile data is stored in tile-id order, so the last leaves below the limit
    // hold the end of the range we need.
    for e in leaves.iter().rev().take(3) {
        let dir = directory(app, &url, &build, &h, h.leaf_off + e.offset, e.length).await?;
        for t in dir.iter().filter(|t| t.tile_id < limit) {
            if t.run_length == 0 {
                return Err("This map build uses nested directories, which isn't supported yet.".into());
            }
            end = end.max(t.offset + t.length);
        }
    }
    Ok(PlanetPlan { url, build, data_bytes: end, leaf_range, leaves })
}

/// Download the world map up to `maxzoom`: leaf directories into the
/// database, tile data into planet-tiles.bin (resumable).
pub async fn planet_download(app: &AppHandle, maxzoom: u8, cancel: &std::sync::atomic::AtomicBool) -> Result<Planet, String> {
    use std::sync::atomic::Ordering;
    use tauri::Emitter;
    let plan = planet_plan(app, maxzoom).await?;
    let emit = |stage: &str, done: u64, total: u64| {
        let _ = app.emit("planet-progress", serde_json::json!({ "stage": stage, "done": done, "total": total }));
    };
    let h = header(app, &plan.url, &plan.build).await?;
    let state = app.state::<AppState>();
    // Leaf directories, in one request, sliced into their saved keys.
    if let Some((start, len)) = plan.leaf_range {
        let missing = plan.leaves.iter().any(|e| {
            crate::db_get(&state, &format!("pm/{}/{}/{}", plan.build, h.leaf_off + e.offset, e.length)).ok().flatten().is_none()
        });
        if missing {
            emit("index", 0, len);
            let bytes = http_range(app, &plan.url, h.leaf_off + start, len).await?;
            for e in &plan.leaves {
                let s = (e.offset - start) as usize;
                let slice = bytes.get(s..s + e.length as usize).ok_or("short directory download")?;
                crate::db_put(&state, &format!("pm/{}/{}/{}", plan.build, h.leaf_off + e.offset, e.length), slice)?;
            }
            emit("index", len, len);
        }
    }
    // Tile data, streamed to disk with resume.
    let (cfg_path, file_path) = planet_paths(app)?;
    let mut planet = Planet { url: plan.url.clone(), build: plan.build.clone(), maxzoom, data_bytes: plan.data_bytes, complete: false };
    // Start over if a different build or zoom was partly downloaded.
    if let Ok(text) = std::fs::read_to_string(&cfg_path) {
        if let Ok(old) = serde_json::from_str::<Planet>(&text) {
            if old.build != planet.build || old.maxzoom != planet.maxzoom {
                let _ = std::fs::remove_file(&file_path);
            }
        }
    }
    {
        let bm = app.state::<BasemapState>();
        let mut b = bm.lock().unwrap();
        b.planet = None; // not usable until complete
    }
    std::fs::write(&cfg_path, serde_json::to_string(&planet).unwrap()).map_err(|e| e.to_string())?;
    let mut have = std::fs::metadata(&file_path).map(|m| m.len()).unwrap_or(0);
    if have > plan.data_bytes {
        let _ = std::fs::remove_file(&file_path);
        have = 0;
    }
    if have < plan.data_bytes {
        let mut file = std::fs::OpenOptions::new().create(true).append(true).open(&file_path).map_err(|e| e.to_string())?;
        let mut tries = 0;
        while have < plan.data_bytes {
            let req = state
                .http
                .get(&plan.url)
                .header("Range", format!("bytes={}-{}", h.data_off + have, h.data_off + plan.data_bytes - 1))
                .timeout(std::time::Duration::from_secs(24 * 3600));
            let result: Result<(), String> = async {
                let mut resp = req.send().await.map_err(|e| format!("network: {e}"))?;
                if resp.status().as_u16() != 206 {
                    return Err(format!("http {}", resp.status().as_u16()));
                }
                let mut last = have;
                while let Some(chunk) = resp.chunk().await.map_err(|e| format!("network: {e}"))? {
                    if cancel.load(Ordering::Relaxed) {
                        return Err("cancelled".into());
                    }
                    std::io::Write::write_all(&mut file, &chunk).map_err(|e| format!("Could not save (disk full?): {e}"))?;
                    have += chunk.len() as u64;
                    if have - last > (16 << 20) {
                        last = have;
                        emit("tiles", have, plan.data_bytes);
                    }
                }
                Ok(())
            }
            .await;
            match result {
                Ok(()) => {}
                Err(e) if e == "cancelled" => return Err(e),
                Err(e) => {
                    tries += 1;
                    if tries > 5 {
                        return Err(e);
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(5 * tries)).await;
                }
            }
        }
        std::io::Write::flush(&mut file).map_err(|e| e.to_string())?;
    }
    emit("tiles", plan.data_bytes, plan.data_bytes);
    planet.complete = true;
    std::fs::write(&cfg_path, serde_json::to_string(&planet).unwrap()).map_err(|e| e.to_string())?;
    {
        let bm = app.state::<BasemapState>();
        let mut b = bm.lock().unwrap();
        b.planet = Some(planet.clone());
        b.planet_file = Some(file_path);
    }
    Ok(planet)
}

/// A tile for layer osm/dem/geo/sat: from the database, else downloaded and saved.
pub async fn get_tile(app: &AppHandle, layer: &str, z: u8, x: u64, y: u64) -> Result<Vec<u8>, String> {
    let key = format!("t/{layer}/{z}/{x}/{y}");
    let state = app.state::<AppState>();
    if let Some(d) = crate::db_get(&state, &key)? {
        return Ok(d);
    }
    let data = if layer == "osm" {
        basemap_tile(app, z, x, y).await?
    } else {
        let tpl = raster_url(layer).ok_or("unknown layer")?;
        let url = tpl.replace("{z}", &z.to_string()).replace("{x}", &x.to_string()).replace("{y}", &y.to_string());
        let resp = state.http.get(&url).send().await.map_err(|e| format!("network: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("http {}", resp.status().as_u16()));
        }
        resp.bytes().await.map_err(|e| format!("network: {e}"))?.to_vec()
    };
    crate::db_put(&state, &key, &data)?;
    Ok(data)
}

/// Handle `ktiles://localhost/<layer>/<z>/<x>/<y>` (http://ktiles.localhost/... on Windows).
pub async fn serve(app: &AppHandle, path: &str) -> Response<Vec<u8>> {
    let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
    let respond = |status: StatusCode, ctype: &str, body: Vec<u8>| {
        Response::builder()
            .status(status)
            .header("Content-Type", ctype)
            .header("Access-Control-Allow-Origin", "*")
            .body(body)
            .unwrap()
    };
    let parsed = (|| -> Option<(&str, u8, u64, u64)> {
        if parts.len() != 4 {
            return None;
        }
        let y = parts[3].split('.').next()?;
        Some((parts[0], parts[1].parse().ok()?, parts[2].parse().ok()?, y.parse().ok()?))
    })();
    let Some((layer, z, x, y)) = parsed else {
        return respond(StatusCode::BAD_REQUEST, "text/plain", b"bad tile path".to_vec());
    };
    if z > 22 || x >= (1u64 << z) || y >= (1u64 << z) {
        return respond(StatusCode::BAD_REQUEST, "text/plain", b"bad tile".to_vec());
    }
    let ctype = match layer {
        "osm" => "application/x-protobuf",
        "sat" => "image/jpeg",
        _ => "image/png",
    };
    match get_tile(app, layer, z, x, y).await {
        Ok(d) => respond(StatusCode::OK, ctype, d),
        // A missing vector tile offline: an empty tile keeps the map drawing.
        Err(_) if layer == "osm" => respond(StatusCode::OK, ctype, Vec::new()),
        Err(e) => respond(StatusCode::NOT_FOUND, "text/plain", e.into_bytes()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tile_ids_match_pmtiles_spec() {
        assert_eq!(zxy_to_tile_id(0, 0, 0), 0);
        assert_eq!(zxy_to_tile_id(1, 0, 0), 1);
        assert_eq!(zxy_to_tile_id(1, 0, 1), 2);
        assert_eq!(zxy_to_tile_id(1, 1, 1), 3);
        assert_eq!(zxy_to_tile_id(1, 1, 0), 4);
        assert_eq!(zxy_to_tile_id(2, 0, 0), 5);
    }
}
