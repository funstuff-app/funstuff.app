#!/usr/bin/env python3
"""Build a lightweight routing graph from a GeoJSON street centerlines file.

This is an OFFLINE preprocessing tool. It is intentionally dependency-free:
- Input must be GeoJSON in EPSG:4326 with LineString/MultiLineString geometries.

Recommended workflow (one option):
1) Download Utah street centerlines (see ROAD_DATA.md)
2) Convert to GeoJSON (WGS84):
   ogr2ogr -t_srs EPSG:4326 utah_centerlines.geojson input.shp
3) Build graph:
   python tools/build_utah_centerlines_graph.py utah_centerlines.geojson ~/.mobileair/roads/utah_centerlines_graph.json

Graph format (version 1):
{
  "version": 1,
  "nodes": [[lat, lon], ...],
  "adj": [[ [to, dist_m], ... ], ...]
}

Notes:
- Nodes are created from polyline vertices.
- Vertices are snapped/merged using rounding to reduce duplicates.
- This is a pragmatic baseline, not a full GIS topology build.
"""

from __future__ import annotations

import json
import math
import os
import sys
from typing import Any


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _snap_key(lat: float, lon: float, *, decimals: int) -> tuple[float, float]:
    return (round(lat, decimals), round(lon, decimals))


def iter_lines(geom: dict[str, Any]) -> list[list[list[float]]]:
    t = geom.get("type")
    coords = geom.get("coordinates")
    if t == "LineString" and isinstance(coords, list):
        return [coords]
    if t == "MultiLineString" and isinstance(coords, list):
        return coords
    return []


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: build_utah_centerlines_graph.py <input.geojson> <output.json>")
        return 2

    in_path = argv[1]
    out_path = argv[2]

    with open(in_path, "r", encoding="utf-8") as f:
        gj = json.load(f)

    feats = gj.get("features") if isinstance(gj, dict) else None
    if not isinstance(feats, list):
        raise SystemExit("GeoJSON must be a FeatureCollection")

    # Snap to ~1m. (1e-5 deg lat ~ 1.1m)
    snap_decimals = 5

    node_index: dict[tuple[float, float], int] = {}
    nodes: list[tuple[float, float]] = []
    adj: list[list[tuple[int, float]]] = []

    def get_node(lat: float, lon: float) -> int:
        key = _snap_key(lat, lon, decimals=snap_decimals)
        idx = node_index.get(key)
        if idx is not None:
            return idx
        idx = len(nodes)
        node_index[key] = idx
        nodes.append((key[0], key[1]))
        adj.append([])
        return idx

    edge_count = 0
    for feat in feats:
        if not isinstance(feat, dict):
            continue
        geom = feat.get("geometry")
        if not isinstance(geom, dict):
            continue
        for line in iter_lines(geom):
            if not isinstance(line, list) or len(line) < 2:
                continue
            prev = None
            for c in line:
                if not isinstance(c, list) or len(c) < 2:
                    prev = None
                    continue
                lon, lat = float(c[0]), float(c[1])
                if not (math.isfinite(lat) and math.isfinite(lon)):
                    prev = None
                    continue
                cur = get_node(lat, lon)
                if prev is not None and prev != cur:
                    a = nodes[prev]
                    b = nodes[cur]
                    w = haversine_m(a[0], a[1], b[0], b[1])
                    if math.isfinite(w) and w > 0:
                        adj[prev].append((cur, w))
                        adj[cur].append((prev, w))
                        edge_count += 2
                prev = cur

    # Convert adjacency to JSON-friendly lists.
    adj_json: list[list[list[float]]] = []
    for row in adj:
        adj_json.append([[int(to), float(w)] for (to, w) in row])

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"version": 1, "nodes": [[lat, lon] for (lat, lon) in nodes], "adj": adj_json}, f)

    print(f"Wrote {len(nodes)} nodes, {edge_count} directed edges -> {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
