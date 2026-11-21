//! Kite Map backend.
//!
//! Everything the map shows (vector tiles, terrain, fonts, lake data, wind
//! history) is stored in one SQLite file in the app data folder. The web UI
//! asks for data through these commands; when the network is down, anything
//! already saved keeps working.

mod lakes_import;

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Manager, State};

struct AppState {
    db: Mutex<Connection>,
    http: reqwest::Client,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Smallest string greater than every string starting with `prefix`.
fn prefix_end(prefix: &str) -> String {
    let mut s = prefix.to_string();
    s.push(char::MAX);
    s
}

fn open_db(path: &std::path::Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=NORMAL;
         CREATE TABLE IF NOT EXISTS blobs (key TEXT PRIMARY KEY, data BLOB NOT NULL, ts INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    )?;
    Ok(conn)
}

fn db_get(state: &AppState, key: &str) -> Result<Option<Vec<u8>>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.query_row("SELECT data FROM blobs WHERE key=?1", [key], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())
}

fn db_put(state: &AppState, key: &str, data: &[u8]) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT OR REPLACE INTO blobs (key, data, ts) VALUES (?1, ?2, ?3)",
        params![key, data, now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Return a saved blob, or the error "miss".
#[tauri::command]
fn cache_get(state: State<'_, AppState>, key: String) -> Result<Response, String> {
    match db_get(&state, &key)? {
        Some(d) => Ok(Response::new(d)),
        None => Err("miss".into()),
    }
}

/// Which of these keys are already saved.
#[tauri::command]
fn cache_has(state: State<'_, AppState>, keys: Vec<String>) -> Result<Vec<bool>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare_cached("SELECT 1 FROM blobs WHERE key=?1")
        .map_err(|e| e.to_string())?;
    keys.iter()
        .map(|k| stmt.exists([k]).map_err(|e| e.to_string()))
        .collect()
}

/// Save raw bytes sent as the request body; the key is in the `x-key` header.
#[tauri::command]
fn cache_put(state: State<'_, AppState>, request: Request<'_>) -> Result<(), String> {
    let key = request
        .headers()
        .get("x-key")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing x-key header")?
        .to_string();
    match request.body() {
        InvokeBody::Raw(bytes) => db_put(&state, &key, bytes),
        _ => Err("expected raw body".into()),
    }
}

#[derive(Serialize)]
struct Stats {
    count: i64,
    bytes: i64,
}

#[tauri::command]
fn cache_stats(state: State<'_, AppState>, prefix: String) -> Result<Stats, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.query_row(
        "SELECT COUNT(*), COALESCE(SUM(LENGTH(data)),0) FROM blobs WHERE key >= ?1 AND key < ?2",
        params![prefix, prefix_end(&prefix)],
        |r| Ok(Stats { count: r.get(0)?, bytes: r.get(1)? }),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn cache_delete_prefix(state: State<'_, AppState>, prefix: String) -> Result<usize, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "DELETE FROM blobs WHERE key >= ?1 AND key < ?2",
        params![prefix, prefix_end(&prefix)],
    )
    .map_err(|e| e.to_string())
}

/// Download a URL (optionally a byte range). With a `key`, the result is saved
/// and later calls return the saved copy without touching the network, unless
/// `refresh` is set. If the network fails, a saved copy is returned instead.
#[tauri::command]
async fn http_get(
    state: State<'_, AppState>,
    url: String,
    key: Option<String>,
    range_start: Option<u64>,
    range_len: Option<u64>,
    refresh: Option<bool>,
) -> Result<Response, String> {
    let refresh = refresh.unwrap_or(false);
    if let Some(k) = &key {
        if !refresh {
            if let Some(d) = db_get(&state, k)? {
                return Ok(Response::new(d));
            }
        }
    }
    let mut req = state.http.get(&url);
    if let (Some(start), Some(len)) = (range_start, range_len) {
        req = req.header("Range", format!("bytes={}-{}", start, start + len - 1));
    }
    let result: Result<Vec<u8>, String> = async {
        let resp = req.send().await.map_err(|e| format!("network: {e}"))?;
        let status = resp.status();
        if !status.is_success() {
            return Err(format!("http {}", status.as_u16()));
        }
        let bytes = resp.bytes().await.map_err(|e| format!("network: {e}"))?;
        Ok(bytes.to_vec())
    }
    .await;
    match result {
        Ok(bytes) => {
            if let Some(k) = &key {
                db_put(&state, k, &bytes)?;
            }
            Ok(Response::new(bytes))
        }
        Err(e) => {
            if let Some(k) = &key {
                if let Some(d) = db_get(&state, k)? {
                    return Ok(Response::new(d));
                }
            }
            Err(e)
        }
    }
}

#[tauri::command]
fn kv_get(state: State<'_, AppState>, key: String) -> Result<Option<String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.query_row("SELECT value FROM kv WHERE key=?1", [key], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn kv_set(state: State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT OR REPLACE INTO kv (key, value) VALUES (?1, ?2)",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn kv_delete(state: State<'_, AppState>, key: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute("DELETE FROM kv WHERE key=?1", [key])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn kv_list(state: State<'_, AppState>, prefix: String) -> Result<Vec<(String, String)>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare("SELECT key, value FROM kv WHERE key >= ?1 AND key < ?2 ORDER BY key")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![prefix, prefix_end(&prefix)], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct ImportResult {
    lakes: u64,
    cells: usize,
}

fn store_lakes(app: &tauri::AppHandle, input: &std::path::Path, min_area: f64) -> Result<ImportResult, String> {
    let work = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let (cells, index, stats) = lakes_import::build(app, input, &work, min_area)?;
    let state = app.state::<AppState>();
    let mut db = state.db.lock().map_err(|e| e.to_string())?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM blobs WHERE key >= ?1 AND key < ?2",
        params!["lakes/", prefix_end("lakes/")],
    )
    .map_err(|e| e.to_string())?;
    for (name, data) in &cells {
        tx.execute(
            "INSERT OR REPLACE INTO blobs (key, data, ts) VALUES (?1, ?2, ?3)",
            params![format!("lakes/{name}"), data, now()],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.execute(
        "INSERT OR REPLACE INTO blobs (key, data, ts) VALUES ('lakes/index.json', ?1, ?2)",
        params![index.as_bytes(), now()],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(ImportResult { lakes: stats.lakes, cells: stats.cells })
}

/// Build the lake database from a HydroLAKES zip or .shp on this computer.
#[tauri::command]
async fn lakes_import(app: tauri::AppHandle, path: String, min_area: Option<f64>) -> Result<ImportResult, String> {
    let min_area = min_area.unwrap_or(0.25);
    tauri::async_runtime::spawn_blocking(move || store_lakes(&app, std::path::Path::new(&path), min_area))
        .await
        .map_err(|e| e.to_string())?
}

/// Download the HydroLAKES zip into the app folder, then import it.
#[tauri::command]
async fn lakes_download(app: tauri::AppHandle, state: State<'_, AppState>, url: String) -> Result<ImportResult, String> {
    use tauri::Emitter;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dest = dir.join("HydroLAKES_polys_v10_shp.zip");
    let part = dir.join("HydroLAKES_polys_v10_shp.zip.part");
    if !dest.exists() {
        let mut resp = state.http.get(&url).timeout(std::time::Duration::from_secs(4 * 3600)).send().await.map_err(|e| format!("network: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("http {}", resp.status().as_u16()));
        }
        let total = resp.content_length().unwrap_or(0);
        let mut file = std::io::BufWriter::new(std::fs::File::create(&part).map_err(|e| e.to_string())?);
        let mut done = 0u64;
        let mut last = 0u64;
        while let Some(chunk) = resp.chunk().await.map_err(|e| format!("network: {e}"))? {
            std::io::Write::write_all(&mut file, &chunk).map_err(|e| format!("Could not save (disk full?): {e}"))?;
            done += chunk.len() as u64;
            if done - last > (8 << 20) {
                last = done;
                let _ = app.emit("lakes-progress", serde_json::json!({ "stage": "download", "done": done, "total": total }));
            }
        }
        std::io::Write::flush(&mut file).map_err(|e| e.to_string())?;
        drop(file);
        std::fs::rename(&part, &dest).map_err(|e| e.to_string())?;
    }
    let result = tauri::async_runtime::spawn_blocking(move || store_lakes(&app, &dest, 0.25))
        .await
        .map_err(|e| e.to_string())?;
    result
}

#[tauri::command]
fn data_folder(app: tauri::AppHandle) -> Result<String, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.display().to_string())
        .map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let db = open_db(&dir.join("kitemap.sqlite"))?;
            let http = reqwest::Client::builder()
                .user_agent(concat!("kite-map/", env!("CARGO_PKG_VERSION")))
                .connect_timeout(std::time::Duration::from_secs(15))
                .timeout(std::time::Duration::from_secs(120))
                .build()?;
            app.manage(AppState { db: Mutex::new(db), http });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            cache_get,
            cache_has,
            cache_put,
            cache_stats,
            cache_delete_prefix,
            http_get,
            kv_get,
            kv_set,
            kv_delete,
            kv_list,
            data_folder,
            lakes_import,
            lakes_download
        ])
        .run(tauri::generate_context!())
        .expect("error while running Kite Map");
}
