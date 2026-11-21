# Kite Map

A Windows desktop map for finding kite surfing spots anywhere in the world, built to work offline.

You draw a box on the map and download it once. The app saves the map, terrain, lake outlines and a year of local wind history, then ranks every lake in the box by how good it should be for kiting. After that it works with no internet.

## Features

- **Starting points.** Drive times are measured from whichever starting point you pick: home, a hotel on a trip, or your current location. Right-click the map and choose "Start trips from here" to add one.
- **Spots list** ranked best first, filtered by estimated drive time, size and name. Online, a spot's popup also shows the real road drive time (OSRM).
- **Three modes:** Water (any level), Beginner (counts only lighter 12 to 22 kn wind), and Snowkite (big lakes in months when they are likely frozen).
- **Water colour from satellite.** The Sentinel-2 cloudless mosaic is sampled inside each top lake: clear and dark, green (algae likely) or murky. Green and murky water lower the score. A satellite layer lets you check beaches and weed beds yourself.
- **Forecast tab.** Go / maybe / no for the next 7 days at your saved spots and the reference spots, based on daylight hours of 12 to 35 kn from directions that work on each lake. The last forecast stays available offline.
- **Seasons.** Each lake shows kiteable hours by month and the months it is likely frozen.
- **Reference spots and schools** (Iowa Great Lakes, Branched Oak, McConaughy, Lakawa's Minnesota lakes, South Padre, Bird Island Basin) as a map layer.

## How spots are scored

For each lake and each of 16 wind directions, the app measures:

- the longest clear run of water **along** the wind (1.5 km or more is ideal; clean wind and room to go downwind), and
- the width of water **across** the wind (800 m or more; room to ride back and forth).

Those are weighted by how many daylight hours per year the wind blows 12 to 35 knots from that direction, using ERA5 hourly data from last year. The result is "good kiting hours per year" and a 0 to 100 score.

Water quality lowers the score: green water x0.8, murky water x0.7, and very shallow lakes (HydroLAKES average depth under 1.5 m, often weedy and mucky in farm country, and green by late summer) x0.75. Deep, clear lakes are not penalised. Beginner mode counts only the lighter 12 to 22 kn hours.

Snowkite mode looks at months whose mean air temperature is -4 C or colder after a month below freezing, and ranks lakes by open space and kiteable hours in those months. Always check real ice thickness before going out.

Not yet included: shore access, upwind trees or bluffs, local rules. Always check the spot in person.

## Data sources (all free)

| What | Source | License |
| --- | --- | --- |
| Base map | OpenStreetMap via the daily [Protomaps](https://protomaps.com) build | ODbL |
| Lakes and reservoirs | [HydroLAKES](https://www.hydrosheds.org/products/hydrolakes) v1.0, about 1.4 million lakes worldwide | CC BY 4.0 |
| Wind history and forecast | [Open-Meteo](https://open-meteo.com) (ERA5 reanalysis) | CC BY 4.0 |
| Road drive times (online) | [OSRM](https://project-osrm.org) public router, OpenStreetMap | ODbL |
| Terrain shading | Mapzen / AWS Terrain Tiles | various, open |
| Geology (optional) | [Macrostrat](https://macrostrat.org) | CC BY 4.0 |
| Satellite imagery, water colour | [Sentinel-2 cloudless 2024](https://s2maps.eu) by EOX IT Services GmbH (contains modified Copernicus Sentinel data) | free for non-commercial use |

The lake database is built on your own computer, once. In the Regions tab, click **Import lake zip** and choose `HydroLAKES_polys_v10_shp.zip` (from the [HydroLAKES page](https://www.hydrosheds.org/products/hydrolakes), "Lake polygons ... shapefile format", 820 MB), or click **Download it** to let the app fetch it. The app keeps lakes of 0.25 km² or more, simplifies them slightly, and stores them in 10-degree cells. You can delete the zip afterwards.

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
