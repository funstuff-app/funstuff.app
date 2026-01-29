#!/usr/bin/env python3
"""
SIMPLE TRAX graph builder.

Instead of complex corridor averaging, this takes raw GPS traces and:
1. Simplifies them with Douglas-Peucker to reduce noise
2. Connects paths that have overlapping endpoints
3. Outputs a clean, connected graph

This preserves the natural connectivity of the GPS data.
"""

import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen, Request

HEADERS = {"User-Agent": "MobileAir/1.0"}
HISTORY_BASE_URL = "https://utahaq.chpc.utah.edu/jsondata"
TRX_SENSORS = ["TRX01", "TRX02", "TRX03"]

# SLC bounds
SLC_LAT_MIN, SLC_LAT_MAX = 40.5, 40.9
SLC_LON_MIN, SLC_LON_MAX = -112.1, -111.7


def fetch_json(url: str, timeout: int = 30) -> dict:
    req = Request(url, headers=HEADERS)
    with urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2 * R * math.asin(math.sqrt(a))


def douglas_peucker(points: list[tuple[float, float]], epsilon_m: float) -> list[tuple[float, float]]:
    """Simplify a polyline using Douglas-Peucker algorithm."""
    if len(points) <= 2:
        return points
    
    # Find point with max distance from line between first and last
    max_dist = 0
    max_idx = 0
    
    start = points[0]
    end = points[-1]
    
    for i in range(1, len(points) - 1):
        p = points[i]
        # Point-to-line distance
        # Using simple Euclidean in degree space (good enough for short segments)
        line_len = math.sqrt((end[0] - start[0])**2 + (end[1] - start[1])**2)
        if line_len < 1e-10:
            dist = math.sqrt((p[0] - start[0])**2 + (p[1] - start[1])**2)
        else:
            # Cross product gives area of parallelogram, divide by base for height
            cross = abs((end[0] - start[0]) * (start[1] - p[1]) - (start[0] - p[0]) * (end[1] - start[1]))
            dist = cross / line_len
        
        # Convert to meters (rough)
        dist_m = dist * 111000
        
        if dist_m > max_dist:
            max_dist = dist_m
            max_idx = i
    
    if max_dist > epsilon_m:
        left = douglas_peucker(points[:max_idx + 1], epsilon_m)
        right = douglas_peucker(points[max_idx:], epsilon_m)
        return left[:-1] + right
    else:
        return [start, end]


def extract_paths(sensor: str, verbose: bool = False) -> list[list[tuple[float, float]]]:
    """Extract continuous GPS paths for a sensor."""
    if verbose:
        print(f"  Fetching {sensor}...")
    
    try:
        glat = fetch_json(f"{HISTORY_BASE_URL}/{sensor}_GLAT_TS_10080.json")
        glon = fetch_json(f"{HISTORY_BASE_URL}/{sensor}_GLON_TS_10080.json")
    except Exception as e:
        if verbose:
            print(f"    Failed: {e}")
        return []
    
    lat_pts = glat.get("TimeDataUTC", [])
    lon_pts = glon.get("TimeDataUTC", [])
    
    lat_by_ts = {ts: val for ts, val in lat_pts if val is not None}
    lon_by_ts = {ts: val for ts, val in lon_pts if val is not None}
    
    common_ts = sorted(set(lat_by_ts.keys()) & set(lon_by_ts.keys()))
    
    # Filter to after 5 AM (when trams are moving)
    relevant_ts = []
    for ts in common_ts:
        dt = datetime.fromtimestamp(ts / 1000, tz=timezone.utc)
        if dt.hour >= 5 and dt.hour < 23:  # 5 AM to 11 PM
            relevant_ts.append(ts)
    
    if verbose:
        print(f"    {len(relevant_ts)} points after filtering")
    
    # Extract continuous paths
    paths = []
    current_path = []
    prev_ts, prev_lat, prev_lon = None, None, None
    
    for ts in relevant_ts:
        lat = lat_by_ts[ts]
        lon = lon_by_ts[ts]
        
        # SLC bounds check
        if not (SLC_LAT_MIN < lat < SLC_LAT_MAX and SLC_LON_MIN < lon < SLC_LON_MAX):
            if current_path:
                paths.append(current_path)
                current_path = []
            prev_ts, prev_lat, prev_lon = None, None, None
            continue
        
        if prev_ts is not None:
            time_gap = (ts - prev_ts) / 1000
            dist = haversine_m(prev_lat, prev_lon, lat, lon)
            speed = dist / time_gap if time_gap > 0 else 0
            
            # Break on: large time gaps or large distance jumps
            # Don't break on slow speed - trams stop at stations but path continues
            if time_gap > 300 or dist > 800:
                if len(current_path) >= 10:  # Only keep paths with 10+ points
                    paths.append(current_path)
                current_path = []
        
        current_path.append((lat, lon))
        prev_ts, prev_lat, prev_lon = ts, lat, lon
    
    if len(current_path) >= 10:
        paths.append(current_path)
    
    if verbose:
        print(f"    {len(paths)} paths extracted")
    
    return paths


def find_components(adj):
    """Find connected components in the graph."""
    n = len(adj)
    visited = [False] * n
    components = []
    node_to_comp = [-1] * n
    
    for start in range(n):
        if visited[start]:
            continue
        comp = []
        stack = [start]
        while stack:
            node = stack.pop()
            if visited[node]:
                continue
            visited[node] = True
            comp.append(node)
            node_to_comp[node] = len(components)
            for neighbor, _ in adj[node]:
                if not visited[neighbor]:
                    stack.append(neighbor)
        components.append(comp)
    
    return components, node_to_comp


def build_graph(all_paths: list[list[tuple[float, float]]], 
                epsilon_m: float = 25.0,  # More aggressive simplification for cleaner lines
                connect_dist_m: float = 50.0,  # Tighter connection to avoid false links
                verbose: bool = False) -> tuple[list[tuple[float, float]], list[list[tuple[int, float]]]]:
    """Build a graph from paths."""
    
    # Step 1: Simplify all paths
    simplified = []
    for path in all_paths:
        simple = douglas_peucker(path, epsilon_m)
        if len(simple) >= 2:
            simplified.append(simple)
    
    if verbose:
        total_pts_before = sum(len(p) for p in all_paths)
        total_pts_after = sum(len(p) for p in simplified)
        print(f"  Simplified: {total_pts_before} -> {total_pts_after} points")
    
    # Step 2: Build node list with deduplication
    nodes: list[tuple[float, float]] = []
    node_key_to_idx: dict[tuple[int, int], int] = {}
    precision = 100000  # ~1m
    
    def get_key(lat: float, lon: float) -> tuple[int, int]:
        return (int(lat * precision), int(lon * precision))
    
    def add_node(lat: float, lon: float) -> int:
        key = get_key(lat, lon)
        if key in node_key_to_idx:
            return node_key_to_idx[key]
        idx = len(nodes)
        nodes.append((lat, lon))
        node_key_to_idx[key] = idx
        return idx
    
    # Step 3: Add all path points as nodes and create edges along paths
    adj: list[list[tuple[int, float]]] = []
    
    def ensure_adj(idx: int):
        while len(adj) <= idx:
            adj.append([])
    
    def add_edge(i: int, j: int, dist: float, max_dist: float = 600.0):
        if i == j or dist < 5.0:  # Skip self-loops and very short edges
            return False
        if dist > max_dist:
            return False
        ensure_adj(max(i, j))
        if not any(n == j for n, _ in adj[i]):
            adj[i].append((j, dist))
        if not any(n == i for n, _ in adj[j]):
            adj[j].append((i, dist))
        return True
    
    for path in simplified:
        prev_idx = None
        for lat, lon in path:
            idx = add_node(lat, lon)
            ensure_adj(idx)
            
            if prev_idx is not None:
                dist = haversine_m(nodes[prev_idx][0], nodes[prev_idx][1], lat, lon)
                add_edge(prev_idx, idx, dist, max_dist=1000.0)  # Allow long path edges
            
            prev_idx = idx
    
    if verbose:
        print(f"  Initial graph: {len(nodes)} nodes, {sum(len(a) for a in adj)//2} edges")
    
    # Step 4: Connect isolated nodes (degree 0) to nearest neighbor
    # Only connect if very close - otherwise it's probably noise
    isolated = [i for i in range(len(nodes)) if len(adj[i]) == 0]
    if verbose:
        print(f"  Isolated nodes: {len(isolated)}")
    
    for iso in isolated:
        lat1, lon1 = nodes[iso]
        best_dist = 30.0  # Max 30m - only connect truly nearby nodes
        best_node = None
        
        for j in range(len(nodes)):
            if j == iso:
                continue
            lat2, lon2 = nodes[j]
            dist = haversine_m(lat1, lon1, lat2, lon2)
            if dist < best_dist:
                best_dist = dist
                best_node = j
        
        if best_node is not None:
            add_edge(iso, best_node, best_dist, max_dist=30.0)
    
    # Step 5: Connect endpoints ONLY to the single nearest node (not all nearby nodes)
    # This preserves the linear nature of rail tracks
    endpoints = [i for i in range(len(nodes)) if len(adj[i]) == 1]
    if verbose:
        print(f"  Endpoints: {len(endpoints)}")
    
    connections_made = 0
    for ep in endpoints:
        lat1, lon1 = nodes[ep]
        neighbors = {n for n, _ in adj[ep]}
        
        # Find the SINGLE nearest non-neighbor node
        best_dist = connect_dist_m
        best_node = None
        
        for j in range(len(nodes)):
            if j == ep or j in neighbors:
                continue
            lat2, lon2 = nodes[j]
            dist = haversine_m(lat1, lon1, lat2, lon2)
            
            if dist < best_dist:
                best_dist = dist
                best_node = j
        
        if best_node is not None:
            if add_edge(ep, best_node, best_dist, max_dist=connect_dist_m):
                connections_made += 1
    
    if verbose:
        print(f"  Endpoint connections: {connections_made}")
    
    # Step 6: DO NOT force connectivity with long bridges
    # Long bridge edges cause incorrect pathfinding
    # Better to have disconnected components and fall back to raw GPS
    
    if verbose:
        components, _ = find_components(adj)
        sizes = sorted([len(c) for c in components], reverse=True)
        print(f"  Components: {len(components)}, sizes: {sizes[:5]}")
    
    if verbose:
        components, _ = find_components(adj)
        sizes = sorted([len(c) for c in components], reverse=True)
        print(f"  Final: {len(components)} components, sizes: {sizes[:10]}")
    
    return nodes, adj


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Build simple TRAX graph from GPS data")
    parser.add_argument("output", help="Output JSON file path")
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose output")
    parser.add_argument("--epsilon", type=float, default=15.0, help="Douglas-Peucker simplification (meters)")
    parser.add_argument("--connect", type=float, default=75.0, help="Max endpoint connection distance (meters)")
    args = parser.parse_args()
    
    verbose = args.verbose
    
    print("Building SIMPLE TRAX graph...")
    
    # Fetch all paths
    all_paths = []
    for sensor in TRX_SENSORS:
        paths = extract_paths(sensor, verbose=verbose)
        all_paths.extend(paths)
    
    print(f"Total paths: {len(all_paths)}")
    
    if not all_paths:
        print("No paths found!")
        sys.exit(1)
    
    # Build graph
    nodes, adj = build_graph(all_paths, epsilon_m=args.epsilon, 
                            connect_dist_m=args.connect, verbose=verbose)
    
    # Count components
    components, _ = find_components(adj)
    print(f"Components: {len(components)}")
    
    # Prepare output
    nodes_json = [[round(lat, 6), round(lon, 6), 0.0] for lat, lon in nodes]
    adj_json = [[[to, round(dist, 1)] for to, dist in neighbors] for neighbors in adj]
    
    graph_data = {
        "version": 2,
        "has_elevation": True,
        "source": "trax_simple_paths",
        "generated": datetime.now(timezone.utc).isoformat(),
        "nodes": nodes_json,
        "adj": adj_json,
    }
    
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    
    with open(output, "w") as f:
        json.dump(graph_data, f, indent=2)
    
    print(f"Wrote {output}")
    print(f"  Nodes: {len(nodes)}")
    print(f"  Edges: {sum(len(a) for a in adj)//2}")
    print(f"  Components: {len(components)}")


if __name__ == "__main__":
    main()
