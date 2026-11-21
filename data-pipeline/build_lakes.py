"""Build the global lake pack used by Kite Map.

Reads HydroLAKES v1.0 polygons (Messager et al. 2016, CC BY 4.0), keeps lakes
big enough to kite on, simplifies outlines a little, and writes one gzipped
GeoJSON file per 10-degree cell (filed by the lake's outlet point), plus an
index.json listing the cells.

Usage: python build_lakes.py HydroLAKES_polys_v10.shp OUT_DIR [MIN_AREA_KM2]
"""

import gzip
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

import pyogrio
import shapely

SIMPLIFY_DEG = 0.00015  # about 15 m
DIGITS = 5  # about 1 m


def cell_name(lat, lon):
    lat0 = int(math.floor(lat / 10) * 10)
    lon0 = int(math.floor(lon / 10) * 10)
    lat0 = max(-90, min(80, lat0))
    lon0 = max(-180, min(170, lon0))
    ns = "n" if lat0 >= 0 else "s"
    ew = "e" if lon0 >= 0 else "w"
    return f"{ns}{abs(lat0):02d}{ew}{abs(lon0):03d}"


def text(v):
    return v.strip() or None if isinstance(v, str) else None


def num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) else f


def rnd(coords):
    if isinstance(coords[0], (float, int)):
        return [round(coords[0], DIGITS), round(coords[1], DIGITS)]
    return [rnd(c) for c in coords]


def main():
    src = sys.argv[1]
    out = Path(sys.argv[2])
    min_area = float(sys.argv[3]) if len(sys.argv) > 3 else 0.25
    out.mkdir(parents=True, exist_ok=True)

    cols = ["Hylak_id", "Lake_name", "Country", "Lake_type", "Lake_area", "Shore_len", "Depth_avg", "Elevation", "Pour_long", "Pour_lat"]
    df = pyogrio.read_dataframe(src, columns=cols, where=f"Lake_area >= {min_area}")
    print(f"{len(df)} lakes with area >= {min_area} km2", flush=True)

    geoms = shapely.simplify(df.geometry.values, SIMPLIFY_DEG, preserve_topology=True)
    cells = defaultdict(list)
    for i, row in enumerate(df.itertuples(index=False)):
        g = geoms[i]
        if g is None or g.is_empty:
            continue
        gj = shapely.geometry.mapping(g)
        props = {
            "id": int(row.Hylak_id),
            "n": text(row.Lake_name),
            "c": text(row.Country),
            "t": int(row.Lake_type),
            "a": round(float(row.Lake_area), 3),
            "s": round(float(row.Shore_len), 2),
            "d": round(num(row.Depth_avg), 1) if (num(row.Depth_avg) or 0) > 0 else None,
            "e": int(num(row.Elevation)) if num(row.Elevation) is not None and num(row.Elevation) > -1000 else None,
        }
        props = {k: v for k, v in props.items() if v is not None}
        feat = {"type": "Feature", "properties": props, "geometry": {"type": gj["type"], "coordinates": rnd(gj["coordinates"])}}
        cells[cell_name(row.Pour_lat, row.Pour_long)].append(feat)

    index = {"version": 1, "source": "HydroLAKES v1.0 (CC BY 4.0)", "min_area_km2": min_area, "cells": {}}
    for name, feats in sorted(cells.items()):
        data = json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")).encode()
        (out / f"{name}.geojson.gz").write_bytes(gzip.compress(data, 9))
        index["cells"][name] = len(feats)
    (out / "index.json").write_text(json.dumps(index, separators=(",", ":")))
    print(f"wrote {len(cells)} cells", flush=True)


if __name__ == "__main__":
    main()
