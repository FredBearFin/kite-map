//! Build the offline lake database from the HydroLAKES polygons shapefile
//! (HydroLAKES_polys_v10_shp.zip, Messager et al. 2016, CC BY 4.0).
//!
//! Lakes of at least `min_area` km² are simplified slightly and filed into
//! 10-degree cells by their outlet point. Each cell is stored as gzipped
//! GeoJSON under `lakes/<cell>`, plus `lakes/index.json`, which is the same
//! layout the web UI reads.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use flate2::write::GzEncoder;
use flate2::Compression;
use serde_json::{json, Map, Value};
use shapefile::dbase::{FieldValue, Record};
use shapefile::{Polygon, PolygonRing};
use tauri::{AppHandle, Emitter};

const SIMPLIFY_DEG: f64 = 0.00015; // about 15 m

fn emit(app: &AppHandle, stage: &str, done: u64, total: u64) {
    let _ = app.emit("lakes-progress", json!({ "stage": stage, "done": done, "total": total }));
}

fn cell_name(lat: f64, lon: f64) -> String {
    let lat0 = ((lat / 10.0).floor() * 10.0).clamp(-90.0, 80.0) as i32;
    let lon0 = ((lon / 10.0).floor() * 10.0).clamp(-180.0, 170.0) as i32;
    format!(
        "{}{:02}{}{:03}",
        if lat0 >= 0 { 'n' } else { 's' },
        lat0.abs(),
        if lon0 >= 0 { 'e' } else { 'w' },
        lon0.abs()
    )
}

fn num(r: &Record, name: &str) -> Option<f64> {
    match r.get(name)? {
        FieldValue::Numeric(v) => *v,
        FieldValue::Float(v) => v.map(|f| f as f64),
        FieldValue::Integer(v) => Some(*v as f64),
        FieldValue::Double(v) => Some(*v),
        _ => None,
    }
    .filter(|v| v.is_finite())
}

fn text(r: &Record, name: &str) -> Option<String> {
    match r.get(name)? {
        FieldValue::Character(Some(s)) => {
            let t = s.trim();
            (!t.is_empty()).then(|| t.to_string())
        }
        _ => None,
    }
}

/// Douglas-Peucker on one ring (closed: first point == last point).
fn simplify(points: &[[f64; 2]], tol: f64) -> Vec<[f64; 2]> {
    if points.len() <= 4 {
        return points.to_vec();
    }
    let mut keep = vec![false; points.len()];
    keep[0] = true;
    keep[points.len() - 1] = true;
    // A closed ring's endpoints coincide, so also anchor the point farthest from the start.
    let far = (1..points.len() - 1)
        .max_by(|&a, &b| {
            let da = (points[a][0] - points[0][0]).hypot(points[a][1] - points[0][1]);
            let db = (points[b][0] - points[0][0]).hypot(points[b][1] - points[0][1]);
            da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
        })
        .unwrap_or(1);
    keep[far] = true;
    let mut stack = vec![(0usize, far), (far, points.len() - 1)];
    while let Some((s, e)) = stack.pop() {
        if e <= s + 1 {
            continue;
        }
        let [x1, y1] = points[s];
        let [x2, y2] = points[e];
        let (dx, dy) = (x2 - x1, y2 - y1);
        let len = dx.hypot(dy);
        let mut best = (0.0, 0usize);
        for i in s + 1..e {
            let [px, py] = points[i];
            let d = if len == 0.0 {
                (px - x1).hypot(py - y1)
            } else {
                ((px - x1) * dy - (py - y1) * dx).abs() / len
            };
            if d > best.0 {
                best = (d, i);
            }
        }
        if best.0 > tol {
            keep[best.1] = true;
            stack.push((s, best.1));
            stack.push((best.1, e));
        }
    }
    points.iter().zip(keep).filter(|(_, k)| *k).map(|(p, _)| *p).collect()
}

fn round5(v: f64) -> f64 {
    (v * 1e5).round() / 1e5
}

/// GeoJSON coordinates (MultiPolygon) for a shapefile polygon: each outer ring
/// starts a polygon and the inner rings (islands) that follow belong to it.
fn polygon_coords(poly: &Polygon) -> Vec<Vec<Vec<[f64; 2]>>> {
    let mut out: Vec<Vec<Vec<[f64; 2]>>> = Vec::new();
    for ring in poly.rings() {
        let pts: Vec<[f64; 2]> = ring.points().iter().map(|p| [p.x, p.y]).collect();
        let simp: Vec<[f64; 2]> = simplify(&pts, SIMPLIFY_DEG)
            .into_iter()
            .map(|[x, y]| [round5(x), round5(y)])
            .collect();
        if simp.len() < 4 {
            continue;
        }
        match ring {
            PolygonRing::Outer(_) => out.push(vec![simp]),
            PolygonRing::Inner(_) => {
                if let Some(last) = out.last_mut() {
                    last.push(simp);
                }
            }
        }
    }
    out
}

/// Find the HydroLAKES .shp, extracting it from a zip if needed.
/// Returns (shp path, temp dir to delete afterwards).
fn locate_shapefile(app: &AppHandle, input: &Path, work: &Path) -> Result<(PathBuf, Option<PathBuf>), String> {
    let ext = input.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if ext == "shp" {
        if !input.with_extension("dbf").exists() {
            return Err("The .dbf file that belongs next to the .shp file is missing.".into());
        }
        return Ok((input.to_path_buf(), None));
    }
    if ext != "zip" {
        return Err("Pick HydroLAKES_polys_v10_shp.zip, or the HydroLAKES_polys_v10.shp file inside it.".into());
    }
    let file = File::open(input).map_err(|e| format!("Could not open the zip: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("Not a readable zip file: {e}"))?;
    let tmp = work.join("hydrolakes_tmp");
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let mut shp = None;
    let wanted: Vec<usize> = (0..zip.len())
        .filter(|&i| {
            zip.by_index(i)
                .map(|f| {
                    let n = f.name().to_ascii_lowercase();
                    n.contains("polys") && (n.ends_with(".shp") || n.ends_with(".shx") || n.ends_with(".dbf"))
                })
                .unwrap_or(false)
        })
        .collect();
    if wanted.is_empty() {
        return Err("This zip does not contain the HydroLAKES polygons shapefile.".into());
    }
    let total: u64 = wanted.iter().filter_map(|&i| zip.by_index(i).ok().map(|f| f.size())).sum();
    let mut done = 0u64;
    for i in wanted {
        let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = Path::new(f.name()).file_name().map(|n| n.to_owned()).ok_or("bad zip entry")?;
        let dest = tmp.join(&name);
        let mut out = BufWriter::new(File::create(&dest).map_err(|e| e.to_string())?);
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = std::io::Read::read(&mut f, &mut buf).map_err(|e| format!("Unzipping failed: {e}"))?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n]).map_err(|e| format!("Could not write (disk full?): {e}"))?;
            done += n as u64;
            if done % (64 << 20) < (1 << 20) {
                emit(app, "unzip", done, total);
            }
        }
        out.flush().map_err(|e| e.to_string())?;
        if dest.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("shp")).unwrap_or(false) {
            shp = Some(dest);
        }
    }
    let shp = shp.ok_or("No .shp file found in the zip.")?;
    Ok((shp, Some(tmp)))
}

pub struct ImportStats {
    pub lakes: u64,
    pub cells: usize,
}

/// Read the shapefile and return (cell name -> gzipped GeoJSON, index JSON).
pub fn build(app: &AppHandle, input: &Path, work: &Path, min_area: f64) -> Result<(Vec<(String, Vec<u8>)>, String, ImportStats), String> {
    let (shp, tmp) = locate_shapefile(app, input, work)?;
    let result = (|| {
        let mut reader = shapefile::Reader::from_path(&shp).map_err(|e| format!("Could not read the shapefile: {e}"))?;
        let total = reader.shape_count().unwrap_or(0) as u64;
        let mut cells: HashMap<String, (GzEncoder<Vec<u8>>, u64)> = HashMap::new();
        let mut kept = 0u64;
        for (i, item) in reader.iter_shapes_and_records_as::<Polygon, Record>().enumerate() {
            if i % 20000 == 0 {
                emit(app, "read", i as u64, total);
            }
            let (poly, rec) = item.map_err(|e| format!("Shapefile error at lake {i}: {e}"))?;
            let area = num(&rec, "Lake_area").unwrap_or(0.0);
            if area < min_area {
                continue;
            }
            let coords = polygon_coords(&poly);
            if coords.is_empty() {
                continue;
            }
            let (Some(plat), Some(plon)) = (num(&rec, "Pour_lat"), num(&rec, "Pour_long")) else { continue };
            let mut props = Map::new();
            props.insert("id".into(), json!(num(&rec, "Hylak_id").unwrap_or(i as f64) as i64));
            if let Some(n) = text(&rec, "Lake_name") {
                props.insert("n".into(), json!(n));
            }
            if let Some(c) = text(&rec, "Country") {
                props.insert("c".into(), json!(c));
            }
            props.insert("t".into(), json!(num(&rec, "Lake_type").unwrap_or(1.0) as i64));
            props.insert("a".into(), json!((area * 1000.0).round() / 1000.0));
            if let Some(s) = num(&rec, "Shore_len") {
                props.insert("s".into(), json!((s * 100.0).round() / 100.0));
            }
            if let Some(d) = num(&rec, "Depth_avg").filter(|d| *d > 0.0) {
                props.insert("d".into(), json!((d * 10.0).round() / 10.0));
            }
            if let Some(e) = num(&rec, "Elevation").filter(|e| *e > -1000.0) {
                props.insert("e".into(), json!(e.round() as i64));
            }
            let geometry = if coords.len() == 1 {
                json!({ "type": "Polygon", "coordinates": coords[0] })
            } else {
                json!({ "type": "MultiPolygon", "coordinates": coords })
            };
            let feature = json!({ "type": "Feature", "properties": Value::Object(props), "geometry": geometry });
            let entry = cells.entry(cell_name(plat, plon)).or_insert_with(|| {
                let mut gz = GzEncoder::new(Vec::new(), Compression::default());
                let _ = gz.write_all(br#"{"type":"FeatureCollection","features":["#);
                (gz, 0)
            });
            if entry.1 > 0 {
                entry.0.write_all(b",").map_err(|e| e.to_string())?;
            }
            serde_json::to_writer(&mut entry.0, &feature).map_err(|e| e.to_string())?;
            entry.1 += 1;
            kept += 1;
        }
        emit(app, "read", total, total);
        let mut index_cells = Map::new();
        let mut out = Vec::new();
        let n_cells = cells.len();
        for (name, (mut gz, count)) in cells {
            gz.write_all(b"]}").map_err(|e| e.to_string())?;
            out.push((name.clone(), gz.finish().map_err(|e| e.to_string())?));
            index_cells.insert(name, json!(count));
        }
        let index = json!({
            "version": 1,
            "source": "HydroLAKES v1.0 (Messager et al. 2016), CC BY 4.0",
            "min_area_km2": min_area,
            "cells": Value::Object(index_cells),
        });
        Ok((out, index.to_string(), ImportStats { lakes: kept, cells: n_cells }))
    })();
    if let Some(t) = tmp {
        let _ = std::fs::remove_dir_all(t);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cells() {
        assert_eq!(cell_name(41.3, -96.1), "n40w100");
        assert_eq!(cell_name(-3.0, 5.0), "s10e000");
    }

    #[test]
    fn simplify_keeps_shape() {
        let mut ring = vec![];
        for i in 0..100 {
            let a = i as f64 / 100.0 * std::f64::consts::TAU;
            ring.push([a.cos() * 0.01, a.sin() * 0.01]);
        }
        ring.push(ring[0]);
        let s = simplify(&ring, SIMPLIFY_DEG);
        assert!(s.len() < ring.len() && s.len() >= 8, "{}", s.len());
        assert_eq!(s.first(), s.last());
    }
}
