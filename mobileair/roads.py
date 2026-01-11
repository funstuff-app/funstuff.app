from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from heapq import heappop, heappush
from typing import Any, Iterable

from .utils import parse_utc_timestamp


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    # Mean earth radius in meters
    r = 6371000.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _is_finite(x: Any) -> bool:
    try:
        return x is not None and math.isfinite(float(x))
    except Exception:
        return False


def _iso_utc_ms(dt: datetime) -> str:
    # Server uses Z-terminated strings. Keep ms resolution to avoid huge strings.
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _project_point_to_segment(
    lat: float, lon: float,
    a_lat: float, a_lon: float,
    b_lat: float, b_lon: float,
) -> tuple[float, float, float]:
    """Project point (lat, lon) onto segment A->B.
    
    Returns (proj_lat, proj_lon, distance_m).
    Uses simple linear interpolation in lat/lon space (fine for short segments).
    """
    # Vector from A to B
    ab_lat = b_lat - a_lat
    ab_lon = b_lon - a_lon
    ab_len_sq = ab_lat * ab_lat + ab_lon * ab_lon
    
    if ab_len_sq < 1e-14:
        # Degenerate segment - just return distance to A
        d = _haversine_m(lat, lon, a_lat, a_lon)
        return (a_lat, a_lon, d)
    
    # Vector from A to point
    ap_lat = lat - a_lat
    ap_lon = lon - a_lon
    
    # Project: t = (AP · AB) / |AB|²
    t = (ap_lat * ab_lat + ap_lon * ab_lon) / ab_len_sq
    t = max(0.0, min(1.0, t))  # Clamp to segment
    
    proj_lat = a_lat + t * ab_lat
    proj_lon = a_lon + t * ab_lon
    d = _haversine_m(lat, lon, proj_lat, proj_lon)
    return (proj_lat, proj_lon, d)


@dataclass(frozen=True)
class RoadGraphConfig:
    # Grid index bucket size in degrees; ~0.01deg ~= 1.1km latitude.
    grid_deg: float = 0.01
    # Search radius in grid cells (Manhattan distance).
    grid_radius: int = 2
    # Cap routing work.
    max_expansions: int = 25_000


class RoadGraph:
    """Lightweight offline road graph.

    File format: JSON
    {
      "version": 1,
      "nodes": [[lat, lon], ...],
      "adj": [[ [to, dist_m], ... ], ...]
    }

    Nodes are indexed by position. Edges are undirected or directed depending
    on how the file is built; routing treats adjacency as given.
    """

    def __init__(self, nodes: list[tuple[float, float]], adj: list[list[tuple[int, float]]], *, cfg: RoadGraphConfig | None = None):
        self.nodes = nodes
        self.adj = adj
        self.cfg = cfg or RoadGraphConfig()
        self._grid: dict[tuple[int, int], list[int]] = {}
        self._build_grid_index()

    @staticmethod
    def default_graph_path() -> str:
        return os.path.expanduser("~/.mobileair/roads/utah_centerlines_graph.json")

    @classmethod
    def load(cls, path: str | None = None, *, cfg: RoadGraphConfig | None = None) -> "RoadGraph":
        p = path or cls.default_graph_path()
        with open(p, "r", encoding="utf-8") as f:
            obj = json.load(f)
        if not isinstance(obj, dict):
            raise ValueError("road graph must be a JSON object")
        if int(obj.get("version") or 0) != 1:
            raise ValueError("unsupported road graph version")
        nodes_raw = obj.get("nodes")
        adj_raw = obj.get("adj")
        if not isinstance(nodes_raw, list) or not isinstance(adj_raw, list):
            raise ValueError("invalid road graph shape")

        nodes: list[tuple[float, float]] = []
        for n in nodes_raw:
            if not isinstance(n, list) or len(n) != 2:
                raise ValueError("invalid node")
            lat, lon = float(n[0]), float(n[1])
            nodes.append((lat, lon))

        adj: list[list[tuple[int, float]]] = []
        for row in adj_raw:
            if not isinstance(row, list):
                raise ValueError("invalid adjacency")
            out: list[tuple[int, float]] = []
            for e in row:
                if not isinstance(e, list) or len(e) != 2:
                    raise ValueError("invalid edge")
                to = int(e[0])
                dist = float(e[1])
                out.append((to, dist))
            adj.append(out)

        if len(adj) != len(nodes):
            raise ValueError("adj length must equal nodes length")
        return cls(nodes, adj, cfg=cfg)

    def _build_grid_index(self) -> None:
        g = self.cfg.grid_deg
        for i, (lat, lon) in enumerate(self.nodes):
            key = (int(math.floor(lat / g)), int(math.floor(lon / g)))
            self._grid.setdefault(key, []).append(i)

    def nearest_node(self, lat: float, lon: float) -> int | None:
        if not self.nodes:
            return None
        g = self.cfg.grid_deg
        r = self.cfg.grid_radius
        base = (int(math.floor(lat / g)), int(math.floor(lon / g)))
        best_i: int | None = None
        best_d = float("inf")

        # Search nearby grid cells.
        for di in range(-r, r + 1):
            for dj in range(-r, r + 1):
                key = (base[0] + di, base[1] + dj)
                for idx in self._grid.get(key, []):
                    nlat, nlon = self.nodes[idx]
                    d = _haversine_m(lat, lon, nlat, nlon)
                    if d < best_d:
                        best_d = d
                        best_i = idx

        # If grid is sparse, fall back to a tiny global scan (bounded).
        if best_i is None:
            scan_n = min(5000, len(self.nodes))
            for idx in range(scan_n):
                nlat, nlon = self.nodes[idx]
                d = _haversine_m(lat, lon, nlat, nlon)
                if d < best_d:
                    best_d = d
                    best_i = idx

        return best_i

    def snap_to_nearest_road(
        self,
        lat: float,
        lon: float,
        *,
        max_snap_distance_m: float = 100.0,
    ) -> tuple[float, float] | None:
        """Snap a GPS point to the nearest road segment.
        
        Returns (snapped_lat, snapped_lon) or None if no road within max_snap_distance_m.
        This does NOT route - it just projects the point onto the closest road edge.
        """
        if not self.nodes or not self.adj:
            return None
        
        # Find candidate nodes near the point
        g = self.cfg.grid_deg
        r = self.cfg.grid_radius
        base = (int(math.floor(lat / g)), int(math.floor(lon / g)))
        
        candidate_nodes: set[int] = set()
        for di in range(-r, r + 1):
            for dj in range(-r, r + 1):
                key = (base[0] + di, base[1] + dj)
                for idx in self._grid.get(key, []):
                    candidate_nodes.add(idx)
        
        # If grid is sparse, include some nodes
        if not candidate_nodes:
            for idx in range(min(1000, len(self.nodes))):
                candidate_nodes.add(idx)
        
        best_lat: float | None = None
        best_lon: float | None = None
        best_dist = float("inf")
        
        # Check each edge from candidate nodes
        checked_edges: set[tuple[int, int]] = set()
        for node_idx in candidate_nodes:
            a_lat, a_lon = self.nodes[node_idx]
            for to_idx, _ in self.adj[node_idx]:
                # Avoid checking same edge twice
                edge_key = (min(node_idx, to_idx), max(node_idx, to_idx))
                if edge_key in checked_edges:
                    continue
                checked_edges.add(edge_key)
                
                b_lat, b_lon = self.nodes[to_idx]
                proj_lat, proj_lon, dist = _project_point_to_segment(
                    lat, lon, a_lat, a_lon, b_lat, b_lon
                )
                if dist < best_dist:
                    best_dist = dist
                    best_lat = proj_lat
                    best_lon = proj_lon
        
        if best_lat is None or best_dist > max_snap_distance_m:
            return None
        
        return (best_lat, best_lon)

    def snap_to_edge(
        self,
        lat: float,
        lon: float,
        *,
        max_snap_distance_m: float = 100.0,
    ) -> tuple[float, float, int, int] | None:
        """Snap a GPS point to the nearest road segment and return edge info.
        
        Returns (snapped_lat, snapped_lon, node_a_idx, node_b_idx) or None.
        node_a_idx and node_b_idx are the endpoints of the edge the point snapped to.
        """
        if not self.nodes or not self.adj:
            return None
        
        g = self.cfg.grid_deg
        r = self.cfg.grid_radius
        base = (int(math.floor(lat / g)), int(math.floor(lon / g)))
        
        candidate_nodes: set[int] = set()
        for di in range(-r, r + 1):
            for dj in range(-r, r + 1):
                key = (base[0] + di, base[1] + dj)
                for idx in self._grid.get(key, []):
                    candidate_nodes.add(idx)
        
        if not candidate_nodes:
            for idx in range(min(1000, len(self.nodes))):
                candidate_nodes.add(idx)
        
        best_lat: float | None = None
        best_lon: float | None = None
        best_dist = float("inf")
        best_edge: tuple[int, int] | None = None
        
        checked_edges: set[tuple[int, int]] = set()
        for node_idx in candidate_nodes:
            a_lat, a_lon = self.nodes[node_idx]
            for to_idx, _ in self.adj[node_idx]:
                edge_key = (min(node_idx, to_idx), max(node_idx, to_idx))
                if edge_key in checked_edges:
                    continue
                checked_edges.add(edge_key)
                
                b_lat, b_lon = self.nodes[to_idx]
                proj_lat, proj_lon, dist = _project_point_to_segment(
                    lat, lon, a_lat, a_lon, b_lat, b_lon
                )
                if dist < best_dist:
                    best_dist = dist
                    best_lat = proj_lat
                    best_lon = proj_lon
                    best_edge = (node_idx, to_idx)
        
        if best_lat is None or best_edge is None or best_dist > max_snap_distance_m:
            return None
        
        return (best_lat, best_lon, best_edge[0], best_edge[1])

    def route(self, start: int, goal: int) -> list[int] | None:
        if start == goal:
            return [start]

        # A* on node graph
        def h(n: int) -> float:
            a = self.nodes[n]
            b = self.nodes[goal]
            return _haversine_m(a[0], a[1], b[0], b[1])

        open_heap: list[tuple[float, int]] = []
        heappush(open_heap, (h(start), start))
        came_from: dict[int, int] = {}
        gscore: dict[int, float] = {start: 0.0}

        expansions = 0
        while open_heap:
            _, cur = heappop(open_heap)
            expansions += 1
            if expansions > self.cfg.max_expansions:
                return None
            if cur == goal:
                # Reconstruct
                path = [cur]
                while cur in came_from:
                    cur = came_from[cur]
                    path.append(cur)
                path.reverse()
                return path

            cur_g = gscore.get(cur)
            if cur_g is None:
                continue

            for nxt, w in self.adj[cur]:
                tentative = cur_g + float(w)
                old = gscore.get(nxt)
                if old is None or tentative < old:
                    came_from[nxt] = cur
                    gscore[nxt] = tentative
                    heappush(open_heap, (tentative + h(nxt), nxt))

        return None


def densify_polyline(
    coords: list[tuple[float, float]],
    *,
    max_points: int,
    spacing_m: float,
) -> list[tuple[float, float]]:
    if len(coords) < 2:
        return coords[:]

    out: list[tuple[float, float]] = [coords[0]]
    for i in range(1, len(coords)):
        a_lat, a_lon = coords[i - 1]
        b_lat, b_lon = coords[i]
        seg_len = _haversine_m(a_lat, a_lon, b_lat, b_lon)
        if not math.isfinite(seg_len) or seg_len <= 0:
            continue

        n = int(seg_len // max(1.0, spacing_m))
        # Insert at most (max_points - current - remaining endpoints) points.
        for k in range(1, n + 1):
            if len(out) >= max_points - 1:
                break
            t = k / (n + 1)
            out.append((a_lat + (b_lat - a_lat) * t, a_lon + (b_lon - a_lon) * t))

        if len(out) >= max_points:
            break
        out.append((b_lat, b_lon))

        if len(out) >= max_points:
            break

    # Ensure last endpoint is present.
    if out and out[-1] != coords[-1] and len(out) < max_points:
        out.append(coords[-1])

    # Deduplicate adjacent duplicates.
    dedup: list[tuple[float, float]] = []
    for ll in out:
        if not dedup or ll != dedup[-1]:
            dedup.append(ll)
    return dedup[:max_points]


def _trace_path_nodes(
    road: RoadGraph,
    snap0: tuple[float, float, int, int],
    snap1: tuple[float, float, int, int],
    max_walk_edges: int = 50,
) -> list[tuple[float, float]] | None:
    """Find intermediate geometry nodes between two snapped points.
    
    Returns list of (lat, lon) for intermediate nodes, or None if no path found.
    Does NOT include endpoints corresponding to snap0/snap1.
    """
    (snap0_lat, snap0_lon, edge0_a, edge0_b) = snap0
    (snap1_lat, snap1_lon, edge1_a, edge1_b) = snap1

    if {edge0_a, edge0_b} == {edge1_a, edge1_b}:
        return []

    # Shared node check
    shared_nodes = {edge0_a, edge0_b} & {edge1_a, edge1_b}
    if shared_nodes:
        corner = shared_nodes.pop()
        return [road.nodes[corner]]
    
    # BFS
    from collections import deque
    start_nodes = {edge0_a, edge0_b}
    goal_nodes = {edge1_a, edge1_b}
    
    queue: deque[tuple[int, list[int]]] = deque()
    visited: set[int] = set()
    
    for sn in start_nodes:
        queue.append((sn, [sn]))
        visited.add(sn)
    
    found_path: list[int] | None = None
    edges_checked = 0
    
    while queue and edges_checked < max_walk_edges:
        cur, path = queue.popleft()
        if cur in goal_nodes:
            found_path = path
            break
        
        for nxt, _ in road.adj[cur]:
            edges_checked += 1
            if edges_checked >= max_walk_edges:
                break
            if nxt not in visited:
                visited.add(nxt)
                queue.append((nxt, path + [nxt]))
    
    if found_path is None:
        return None
        
    # Convert node indices to coords
    # Note: path includes start_node (one of edge0's ends) and end_node (one of edge1's ends)
    # We want these because they are geometry points.
    coords = []
    for idx in found_path:
        coords.append(road.nodes[idx])
        
    return coords


def trace_road_between_gps_points(
    road: RoadGraph,
    prev_point: dict[str, Any],
    next_point: dict[str, Any],
    *,
    max_waypoints: int = 20,
    spacing_m: float = 25.0,
    max_snap_distance_m: float = 50.0,
    max_walk_edges: int = 50,
) -> list[dict[str, Any]] | None:
    """Add waypoints along the road geometry between two GPS points.
    
    This does NOT use A* routing. Instead:
    1. Snap both GPS points to their nearest road edges
    2. Walk along connected road edges from the first to the second
    3. Return intermediate waypoints that follow the road's actual curves
    
    Waypoints are marked with `wp: 1` to distinguish from raw GPS.
    Output EXCLUDES prev_point and INCLUDES next_point (snapped).
    
    Returns None if snapping fails or path cannot be traced.
    """
    lat0 = prev_point.get("lat")
    lon0 = prev_point.get("lon")
    lat1 = next_point.get("lat")
    lon1 = next_point.get("lon")
    if not (_is_finite(lat0) and _is_finite(lon0) and _is_finite(lat1) and _is_finite(lon1)):
        return None
    
    lat0, lon0, lat1, lon1 = float(lat0), float(lon0), float(lat1), float(lon1)
    
    # Only worth tracing if the segment is non-trivial
    direct_m = _haversine_m(lat0, lon0, lat1, lon1)
    if not math.isfinite(direct_m) or direct_m < 30:
        return None
    
    # Find the edge each GPS point snaps to
    snap0 = road.snap_to_edge(lat0, lon0, max_snap_distance_m=max_snap_distance_m)
    snap1 = road.snap_to_edge(lat1, lon1, max_snap_distance_m=max_snap_distance_m)
    if snap0 is None or snap1 is None:
        return None
    
    (snap0_lat, snap0_lon, edge0_a, edge0_b) = snap0
    (snap1_lat, snap1_lon, edge1_a, edge1_b) = snap1
    
    # Build the path of coordinates by walking the road edges
    # Start with the snapped position of prev_point
    path_coords: list[tuple[float, float]] = [(snap0_lat, snap0_lon)]
    
    # If on same edge, just go direct
    if {edge0_a, edge0_b} == {edge1_a, edge1_b}:
        path_coords.append((snap1_lat, snap1_lon))
    else:
        # Walk from edge0 to edge1 along connected edges (bounded BFS)
        # 
        # The key insight: we want the node path that takes us from edge0 to edge1.
        # We start by picking the "best" start node (closer to snap0's opposite end)
        # and the "best" goal node (the endpoint of edge1 that we need to reach).
        #
        # For a corner scenario: GPS goes from (0,0) to (2,2), snapping to edges 0-1 and 1-2.
        # The shared node (1) is the "corner" we need to include in the path.
        
        # Find shared corner node if edges share one
        shared_nodes = {edge0_a, edge0_b} & {edge1_a, edge1_b}
        
        if shared_nodes:
            # Edges share a corner node - we need to include it
            corner = shared_nodes.pop()
            path_coords.append(road.nodes[corner])
            path_coords.append((snap1_lat, snap1_lon))
        else:
            # Edges don't share a node - need BFS to find connecting path
            from collections import deque
            
            # Start from edge0's endpoints, goal is edge1's endpoints
            start_nodes = {edge0_a, edge0_b}
            goal_nodes = {edge1_a, edge1_b}
            
            queue: deque[tuple[int, list[int]]] = deque()
            visited: set[int] = set()
            
            for sn in start_nodes:
                queue.append((sn, [sn]))
                visited.add(sn)
            
            found_path: list[int] | None = None
            edges_checked = 0
            
            while queue and edges_checked < max_walk_edges:
                cur, path = queue.popleft()
                if cur in goal_nodes:
                    found_path = path
                    break
                
                for nxt, _ in road.adj[cur]:
                    edges_checked += 1
                    if edges_checked >= max_walk_edges:
                        break
                    if nxt not in visited:
                        visited.add(nxt)
                        queue.append((nxt, path + [nxt]))
            
            if found_path is None or len(found_path) < 1:
                # Can't trace - just return snapped endpoint
                path_coords.append((snap1_lat, snap1_lon))
            else:
                # Add all nodes in the path
                for node_idx in found_path:
                    node_coord = road.nodes[node_idx]
                    # Avoid duplicates
                    if not path_coords or path_coords[-1] != node_coord:
                        path_coords.append(node_coord)
                # End with snapped position
                if path_coords[-1] != (snap1_lat, snap1_lon):
                    path_coords.append((snap1_lat, snap1_lon))
    
    # Compute total path length and check sanity
    path_len = 0.0
    for i in range(1, len(path_coords)):
        path_len += _haversine_m(
            path_coords[i-1][0], path_coords[i-1][1],
            path_coords[i][0], path_coords[i][1]
        )
    
    # Reject if path is way longer than direct (indicates wrong path)
    if path_len > direct_m * 3.0:
        return None
    
    # Densify the path to add smooth waypoints
    densified = densify_polyline(path_coords, max_points=max_waypoints, spacing_m=spacing_m)
    if len(densified) < 2:
        return None
    
    # Time interpolation
    t0s = prev_point.get("t")
    t1s = next_point.get("t")
    if not isinstance(t0s, str) or not isinstance(t1s, str):
        return None
    
    t0p = parse_utc_timestamp(t0s)
    t1p = parse_utc_timestamp(t1s)
    if t0p is None or t1p is None:
        return None
    t0 = t0p.astimezone(timezone.utc)
    t1 = t1p.astimezone(timezone.utc)
    
    dt_s = (t1 - t0).total_seconds()
    if not math.isfinite(dt_s) or dt_s <= 0:
        return None
    
    # Build output points (excluding first, including last)
    base = dict(next_point)
    out: list[dict[str, Any]] = []
    n = len(densified)
    for i in range(1, n):
        frac = i / (n - 1) if n > 1 else 1.0
        lat, lon = densified[i]
        p = dict(base)
        p["lat"] = float(lat)
        p["lon"] = float(lon)
        p["t"] = _iso_utc_ms(t0 + (t1 - t0) * frac)
        p["wp"] = 1  # Mark as waypoint (not raw GPS)
        out.append(p)
    
    return out


def match_trail_segment_offline(
    road: RoadGraph,
    prev_point: dict[str, Any],
    next_point: dict[str, Any],
    *,
    max_output_points: int = 40,
    spacing_m: float = 25.0,
    max_route_len_factor: float = 6.0,
) -> list[dict[str, Any]] | None:
    """DEPRECATED: Use trace_road_between_gps_points instead.
    
    This function uses A* routing which can create arbitrary paths.
    Kept for backwards compatibility.
    """
    # Delegate to the new function
    return trace_road_between_gps_points(
        road, prev_point, next_point,
        max_waypoints=max_output_points,
        spacing_m=spacing_m,
    )


def snap_trail_segments(
    trail: list[dict[str, Any]],
    road: RoadGraph,
    *,
    max_snap_m: float = 50.0,
) -> list[dict[str, Any]]:
    """Snap trail points to roads WITHOUT adding waypoints.
    
    The client already handles sparse GPS with spline smoothing.
    This function only moves coordinates to nearest road - no densification.
    
    Args:
        trail: List of trail points with lat/lon/t/m keys
        road: RoadGraph instance
        max_snap_m: Maximum distance to snap a point to a road
        
    Returns:
        New trail list with snapped coordinates (same length as input)
    """
    if not trail or len(trail) < 1:
        return trail
    
    result: list[dict[str, Any]] = []
    
    for point in trail:
        if not isinstance(point, dict):
            result.append(point)
            continue
            
        lat = point.get("lat")
        lon = point.get("lon")
        
        if not (_is_finite(lat) and _is_finite(lon)):
            result.append(point)
            continue
        
        # Snap this point to nearest road
        snapped = road.snap_to_nearest_road(float(lat), float(lon), max_snap_distance_m=max_snap_m)
        if snapped is not None:
            # Create a copy with snapped coordinates
            snapped_point = dict(point)
            snapped_point["lat"] = snapped[0]
            snapped_point["lon"] = snapped[1]
            result.append(snapped_point)
        else:
            result.append(point)
    
    return result


def snap_points_to_roads(
    trail: list[dict[str, Any]],
    road: RoadGraph,
    *,
    max_snap_m: float = 40.0,
) -> list[dict[str, Any]]:
    """Snap trail point coordinates to nearest roads and include necessary geometry (corners).

    Does NOT densities straight lines. 
    Inserts 'wp': 1 points for road corners to allow client splines to follow curves.

    Args:
        trail: List of trail points.
        road: RoadGraph instance.
        max_snap_m: Maximum distance in meters to snap.

    Returns:
        List of trail points with coordinates validly snapped to road edges.
        Markers: 'rm': 1 if snapped. 'wp': 1 if inserted.
    """
    if not trail:
        return []

    # Helper to clean up trail points for output
    def make_pt(template_pt, lat, lon, is_snap=False):
        p = dict(template_pt)
        p["lat"] = float(lat)
        p["lon"] = float(lon)
        if is_snap:
            p["rm"] = 1
        return p

    # Pre-snap all points to find where they land
    snaps = []
    for pt in trail:
        lat = pt.get("lat")
        lon = pt.get("lon")
        s = None
        if _is_finite(lat) and _is_finite(lon):
             s = road.snap_to_edge(float(lat), float(lon), max_snap_distance_m=max_snap_m)
        snaps.append(s)

    result: list[dict[str, Any]] = []

    # First point
    if snaps[0]:
        result.append(make_pt(trail[0], snaps[0][0], snaps[0][1], is_snap=True))
    else:
        result.append(trail[0])

    for i in range(1, len(trail)):
        prev_pt = result[-1] # Use last added point for time interp base? No, use original time.
        # Ideally we use trail[i-1] time, but we might have inserted waypoints.
        # Let's use trail[i-1] and trail[i] for time basis.
        p_prev_orig = trail[i-1]
        p_curr_orig = trail[i]
        
        s_prev = snaps[i-1]
        s_curr = snaps[i]
        
        # If both snapped, try to trace geometry
        path_coords = None
        if s_prev and s_curr:
             path_coords = _trace_path_nodes(road, s_prev, s_curr)
        
        # If we found intermediate geometry
        if path_coords:
            # Interpolate times
            t0 = parse_utc_timestamp(p_prev_orig.get("t") or "")
            t1 = parse_utc_timestamp(p_curr_orig.get("t") or "")
            
            if t0 and t1:
                # Calculate total distance along path to do decent time interpolation
                # Path is: prev_snapped -> path_nodes... -> curr_snapped
                full_path = [(s_prev[0], s_prev[1])] + path_coords + [(s_curr[0], s_curr[1])]
                
                # dists[k] is distance from start to point k
                dists = [0.0]
                total_dist = 0.0
                for k in range(1, len(full_path)):
                    d = _haversine_m(full_path[k-1][0], full_path[k-1][1], full_path[k][0], full_path[k][1])
                    total_dist += d
                    dists.append(total_dist)
                
                # Insert waypoints
                # path_coords corresponds to full_path indices 1..len(path_coords)
                if total_dist > 0:
                    dt = (t1 - t0).total_seconds()
                    for k, coord in enumerate(path_coords):
                        # Index in full_path is k+1
                        d_frac = dists[k+1] / total_dist
                        t_wp = t0 + timedelta(seconds=dt * d_frac)
                        
                        wp = dict(p_curr_orig) # inherit attrs from next point
                        wp["lat"] = coord[0]
                        wp["lon"] = coord[1]
                        wp["t"] = _iso_utc_ms(t_wp)
                        wp["wp"] = 1
                        # Don't set 'rm' on waypoints (they are graph nodes, so effectively on road, but reserve rm for checks)
                        result.append(wp)

        # Add current point
        if s_curr:
            result.append(make_pt(p_curr_orig, s_curr[0], s_curr[1], is_snap=True))
        else:
            result.append(p_curr_orig)

    return result
