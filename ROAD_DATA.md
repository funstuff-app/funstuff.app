# Offline Road Data (Utah Street Centerlines)

This repo can optionally map-match mobile trails to street centerlines so vehicles follow roads (reducing “cut through buildings”). This is designed to work offline.

## Data source

Preferred: **Utah official street centerlines** (AGRC / UDOT open data). You can typically find these under Utah AGRC’s transportation layers ("Roads" / "Streets" / "Street Centerlines").

If you can’t obtain or license that dataset, the fallback choice is OpenStreetMap (OSM), but the current implementation is built around a centerline polyline dataset.

## Install location

Place the built graph here:

- `~/.mobileair/roads/utah_centerlines_graph.json`

The app will use it automatically when present.

## How to build the graph

### 1) Get centerlines as GeoJSON (WGS84)

The build tool expects **GeoJSON** in EPSG:4326 with `LineString`/`MultiLineString` geometries.

#### Option A: Download from UtahRoads ArcGIS FeatureServer (no GIS tools needed)

This repo includes a paginated downloader for the official UtahRoads FeatureServer layer:

- `python tools/download_utah_roads_arcgis.py --out ~/.mobileair/roads/utah_centerlines.geojson`

You can also limit to a specific Utah county (by name or FIPS). Example (Salt Lake County):

- `python tools/download_utah_roads_arcgis.py --county "Salt Lake County" --out ~/.mobileair/roads/utah_centerlines.geojson`

It requests GeoJSON with `outSR=4326` and writes the file incrementally (safe for large datasets).

#### Option B: Convert an existing dataset (requires GDAL)

- `ogr2ogr -t_srs EPSG:4326 utah_centerlines.geojson input_centerlines.shp`

(You can also use QGIS to export to GeoJSON and set the output CRS to WGS84 / EPSG:4326.)

### 2) Build the routing graph

Run:

- `python tools/build_utah_centerlines_graph.py utah_centerlines.geojson ~/.mobileair/roads/utah_centerlines_graph.json`

This produces a lightweight JSON graph with nodes and weighted adjacency.

## Notes / limitations

- This is a pragmatic baseline, not a full “GIS topology” build.
- Nodes are built from polyline vertices; connectivity is best when centerlines share snapped endpoints.
- Map-matching is applied only to *new* trail segments (incremental), with caps to avoid exploding point counts.
