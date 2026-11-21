# Kite Map

A Windows desktop map for finding kite surfing spots anywhere in the world, built to work offline.

You draw a box on the map and download it once. The app saves the map, terrain, lake outlines and a year of local wind history, then ranks every lake in the box by how good it should be for kiting. After that it works with no internet.

## How spots are scored

For each lake and each of 16 wind directions, the app measures:

- the longest clear run of water **along** the wind (1.5 km or more is ideal; clean wind and room to go downwind), and
- the width of water **across** the wind (800 m or more; room to ride back and forth).

Those are weighted by how many daylight hours per year the wind blows 12 to 35 knots from that direction, using ERA5 hourly data from last year. The result is "good kiting hours per year" and a 0 to 100 score.

Not yet included: shore access, upwind trees or bluffs, local rules. Always check the spot in person.

## Data sources (all free)

| What | Source | License |
| --- | --- | --- |
| Base map | OpenStreetMap via the daily [Protomaps](https://protomaps.com) build | ODbL |
| Lakes and reservoirs | [HydroLAKES](https://www.hydrosheds.org/products/hydrolakes) v1.0, about 1.4 million lakes worldwide | CC BY 4.0 |
| Wind history and forecast | [Open-Meteo](https://open-meteo.com) (ERA5 reanalysis) | CC BY 4.0 |
| Terrain shading | Mapzen / AWS Terrain Tiles | various, open |
| Geology (optional) | [Macrostrat](https://macrostrat.org) | CC BY 4.0 |

The lake pack is pre-built by the `Build lake data pack` GitHub Action (`data-pipeline/build_lakes.py`) and published on the `lakes-v1` release. The app downloads only the 10-degree cells it needs.

## Download

Get `KiteMap-x.y.z-setup.exe` (installer) or `KiteMap-x.y.z-portable.zip` (just unzip and run) from the [Releases](../../releases) page. Windows 10 or 11.

All downloaded data lives in one SQLite file in `%APPDATA%\com.fredbearfin.kitemap\`.

## Development

Needs Node 22 and Rust.

```
npm install
npm test           # geometry and scoring tests
npx tauri dev      # run the desktop app
npx tauri build    # build the Windows installer
```

`npm run dev` also runs the UI in a normal browser, with data kept in memory.

Every push to `main` builds Windows binaries in GitHub Actions. Pushing a `v*` tag publishes them as a release.
