from __future__ import annotations

import gc
import json
import math
import os
from array import array


def _malloc_trim() -> None:
    """Best-effort return of freed heap pages to the OS (glibc/Linux only).

    After loading the graph we drop a ~400 MB JSON parse tree; without this the
    freed memory stays mapped to the process and inflates RSS. No-op elsewhere.
    """
    try:
        import ctypes
        import ctypes.util
        libc = ctypes.CDLL(ctypes.util.find_library("c") or "libc.so.6")
        if hasattr(libc, "malloc_trim"):
            libc.malloc_trim(0)
    except Exception:
        pass
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


class _NodesView:
    """Sequence view over parallel lat/lon arrays; ``nodes[i]`` -> ``(lat, lon)``.

    Backed by compact ``array('d')`` storage instead of a list of tuples, which
    cuts the Utah graph (~541k nodes) from hundreds of MB to a few MB while
    keeping every existing ``nodes[i]`` / ``enumerate(nodes)`` / ``len(nodes)``
    call site working unchanged.
    """
    __slots__ = ("_lat", "_lon")

    def __init__(self, lat, lon):
        self._lat = lat
        self._lon = lon

    def __len__(self):
        return len(self._lat)

    def __getitem__(self, i):
        return (self._lat[i], self._lon[i])

    def __iter__(self):
        lat = self._lat
        lon = self._lon
        for i in range(len(lat)):
            yield (lat[i], lon[i])

    def __eq__(self, other):
        try:
            n = len(other)
        except TypeError:
            return NotImplemented
        if n != len(self._lat):
            return False
        for i in range(n):
            o = other[i]
            if self._lat[i] != o[0] or self._lon[i] != o[1]:
                return False
        return True

    __hash__ = None


class _AdjView:
    """Sequence view over CSR arrays; ``adj[i]`` -> ``[(to, dist), ...]``."""
    __slots__ = ("_indptr", "_indices", "_wt")

    def __init__(self, indptr, indices, wt):
        self._indptr = indptr
        self._indices = indices
        self._wt = wt

    def __len__(self):
        return len(self._indptr) - 1

    def __getitem__(self, i):
        s = self._indptr[i]
        e = self._indptr[i + 1]
        idx = self._indices
        wt = self._wt
        return [(idx[k], wt[k]) for k in range(s, e)]

    def __iter__(self):
        indptr = self._indptr
        for i in range(len(indptr) - 1):
            yield self[i]


class RoadGraph:
    """Lightweight offline road graph.

    File format: JSON
    {
      "version": 1,  // or 2 for elevation support
      "has_elevation": false,  // true if nodes have [lat, lon, elev]
      "nodes": [[lat, lon], ...],  // or [[lat, lon, elev], ...]
      "adj": [[ [to, dist_m], ... ], ...]
    }

    Nodes are indexed by position. Edges are undirected or directed depending
    on how the file is built; routing treats adjacency as given.
    """

    def __init__(self, nodes: list[tuple[float, float]], adj: list[list[tuple[int, float]]], *,
                 cfg: RoadGraphConfig | None = None,
                 elevations: list[float] | None = None):
        # Compatibility constructor: accept Python lists, store as compact arrays.
        lat = array("d")
        lon = array("d")
        for n in nodes:
            lat.append(float(n[0]))
            lon.append(float(n[1]))
        elev = array("d", (float(e) for e in elevations)) if elevations is not None else None
        indptr = array("l", [0])
        indices = array("l")
        wt = array("d")
        for row in adj:
            for to, dist in row:
                indices.append(int(to))
                wt.append(float(dist))
            indptr.append(len(indices))
        self._setup(lat, lon, indptr, indices, wt, elev, cfg)

    @classmethod
    def _from_arrays(cls, lat, lon, indptr, indices, wt, elev, cfg) -> "RoadGraph":
        self = cls.__new__(cls)
        self._setup(lat, lon, indptr, indices, wt, elev, cfg)
        return self

    def _setup(self, lat, lon, indptr, indices, wt, elev, cfg) -> None:
        self._lat = lat  # array('d')
        self._lon = lon  # array('d')
        self._indptr = indptr    # CSR row offsets, array('l'), len == n_nodes+1
        self._indices = indices  # CSR neighbor node ids, array('l')
        self._wt = wt            # CSR edge weights (meters), array('d')
        self.elevations = elev   # array('d') or None
        self.cfg = cfg or RoadGraphConfig()
        self.nodes = _NodesView(lat, lon)
        self.adj = _AdjView(indptr, indices, wt)
        self._grid: dict = {}
        self._build_grid_index()

    @staticmethod
    def default_graph_path() -> str:
        return os.path.expanduser("~/.mobileair/roads/utah_centerlines_graph.json")

    @classmethod
    def load(cls, path: str | None = None, *, cfg: RoadGraphConfig | None = None,
             bbox: tuple[float, float, float, float] | None = None) -> "RoadGraph":
        """Load a road graph into compact typed arrays (~35 MB for the full Utah
        graph, versus ~500 MB as Python lists of tuples).

        *bbox* = (lat_min, lat_max, lon_min, lon_max), if given, clips to that
        box at load time: nodes outside are dropped, edges are remapped to the
        kept-node index space, and edges leaving the box are dropped.
        """
        p = path or cls.default_graph_path()
        with open(p, "r", encoding="utf-8") as f:
            obj = json.load(f)
        if not isinstance(obj, dict):
            raise ValueError("road graph must be a JSON object")
        
        version = int(obj.get("version") or 0)
        if version not in (1, 2):
            raise ValueError(f"unsupported road graph version: {version}")
        
        has_elevation = obj.get("has_elevation", False)
        nodes_raw = obj.get("nodes")
        adj_raw = obj.get("adj")
        if not isinstance(nodes_raw, list) or not isinstance(adj_raw, list):
            raise ValueError("invalid road graph shape")
        if len(adj_raw) != len(nodes_raw):
            raise ValueError("adj length must equal nodes length")

        # Optional bbox clip: pick kept source indices and their old->new remap.
        keep_new_idx: dict[int, int] | None = None
        if bbox is not None:
            la0, la1, lo0, lo1 = bbox
            keep_new_idx = {}
            for i, n in enumerate(nodes_raw):
                if not isinstance(n, list) or len(n) < 2:
                    continue
                lat_i, lon_i = float(n[0]), float(n[1])
                if la0 <= lat_i <= la1 and lo0 <= lon_i <= lo1:
                    keep_new_idx[i] = len(keep_new_idx)

        # Build compact arrays directly from the parsed JSON so we never
        # materialize the ~500 MB list-of-tuples form.
        lat = array("d")
        lon = array("d")
        elev = array("d") if has_elevation else None
        for i, n in enumerate(nodes_raw):
            if keep_new_idx is not None and i not in keep_new_idx:
                continue
            if not isinstance(n, list) or len(n) < 2:
                raise ValueError("invalid node")
            lat.append(float(n[0]))
            lon.append(float(n[1]))
            if elev is not None:
                elev.append(float(n[2]) if len(n) >= 3 else 0.0)

        indptr = array("l", [0])
        indices = array("l")
        wt = array("d")
        for i, row in enumerate(adj_raw):
            if keep_new_idx is not None and i not in keep_new_idx:
                continue
            if not isinstance(row, list):
                raise ValueError("invalid adjacency")
            for e in row:
                if not isinstance(e, list) or len(e) != 2:
                    raise ValueError("invalid edge")
                to = int(e[0])
                if keep_new_idx is not None:
                    nt = keep_new_idx.get(to)
                    if nt is None:
                        continue  # edge leaves the clipped region
                    indices.append(nt)
                else:
                    indices.append(to)
                wt.append(float(e[1]))
            indptr.append(len(indices))

        # Release the ~400 MB JSON parse tree and hand the pages back to the OS
        # before building the grid, so steady-state RSS reflects the compact
        # arrays (~35 MB) rather than the transient parse peak.
        del obj, nodes_raw, adj_raw
        gc.collect()
        _malloc_trim()

        return cls._from_arrays(lat, lon, indptr, indices, wt, elev, cfg)

    def _build_grid_index(self) -> None:
        g = self.cfg.grid_deg
        lat = self._lat
        lon = self._lon
        grid = self._grid
        floor = math.floor
        for i in range(len(lat)):
            key = (int(floor(lat[i] / g)), int(floor(lon[i] / g)))
            cell = grid.get(key)
            if cell is None:
                cell = array("l")
                grid[key] = cell
            cell.append(i)

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

    def snap_to_edge_directed(
        self,
        lat: float,
        lon: float,
        *,
        travel_bearing: float | None = None,
        prev_edge: tuple[int, int] | None = None,
        max_snap_distance_m: float = 100.0,
    ) -> tuple[float, float, int, int] | None:
        """Snap using direction matching + continuity.
        
        Direction matching is crucial for parallel tracks in depots.
        An edge going the same direction as vehicle travel gets huge preference.
        """
        if not self.nodes or not self.adj:
            return None
        
        # Get candidate nodes from grid
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
        
        # Build set of connected nodes from prev_edge
        connected_nodes: set[int] = set()
        if prev_edge:
            pa, pb = prev_edge
            connected_nodes.add(pa)
            connected_nodes.add(pb)
            for neighbor, _ in self.adj[pa]:
                connected_nodes.add(neighbor)
            for neighbor, _ in self.adj[pb]:
                connected_nodes.add(neighbor)
        
        # Collect all candidate edges
        checked_edges: set[tuple[int, int]] = set()
        candidates: list[tuple[float, float, float, int, int, float, bool]] = []
        # lat, lon, dist, a, b, edge_bearing, connected
        
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
                
                if dist <= max_snap_distance_m:
                    edge_bearing = _bearing_between(a_lat, a_lon, b_lat, b_lon)
                    is_connected = (node_idx in connected_nodes or to_idx in connected_nodes)
                    candidates.append((proj_lat, proj_lon, dist, node_idx, to_idx, edge_bearing, is_connected))
        
        if not candidates:
            return None
        
        # Score each candidate
        best = None
        best_score = float('inf')
        
        for snap_lat, snap_lon, dist, a, b, edge_bearing, connected in candidates:
            # Base score is distance
            score = dist
            
            # Direction bonus: edges aligned with travel direction get huge preference
            # This is the KEY for selecting correct track among parallels
            if travel_bearing is not None:
                # Check both directions of edge (track is bidirectional)
                angle_diff = min(
                    _angle_diff(travel_bearing, edge_bearing),
                    _angle_diff(travel_bearing, (edge_bearing + 180) % 360)
                )
                # angle_diff is 0-90 (since we check both directions)
                # 0 = perfect match, 90 = perpendicular
                # Give MASSIVE preference to aligned edges
                if angle_diff < 30:  # Within 30 degrees
                    score *= 0.1  # 90% bonus
                elif angle_diff < 60:
                    score *= 0.5  # 50% bonus
                # Perpendicular edges get no bonus
            
            # Continuity bonus: connected edges get preference
            if connected:
                score *= 0.5  # Additional 50% bonus
            
            if score < best_score:
                best_score = score
                best = (snap_lat, snap_lon, a, b)
        
        return best

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
    max_walk_edges: int = 100,
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
    
    # Dijkstra (shortest path by distance) instead of BFS
    # This prevents zigzag paths through long crossing edges
    import heapq
    start_nodes = {edge0_a, edge0_b}
    goal_nodes = {edge1_a, edge1_b}
    
    # Priority queue: (distance, node, path)
    pq: list[tuple[float, int, list[int]]] = []
    dist: dict[int, float] = {}
    
    for sn in start_nodes:
        heapq.heappush(pq, (0.0, sn, [sn]))
        dist[sn] = 0.0
    
    found_path: list[int] | None = None
    edges_checked = 0
    
    while pq and edges_checked < max_walk_edges:
        d, cur, path = heapq.heappop(pq)
        
        if cur in goal_nodes:
            found_path = path
            break
        
        # Skip if we've found a better path to this node
        if d > dist.get(cur, float('inf')):
            continue
        
        for nxt, edge_dist in road.adj[cur]:
            edges_checked += 1
            if edges_checked >= max_walk_edges:
                break
            new_dist = d + edge_dist
            if new_dist < dist.get(nxt, float('inf')):
                dist[nxt] = new_dist
                heapq.heappush(pq, (new_dist, nxt, path + [nxt]))
    
    if found_path is None:
        return None
    
    # Sanity checks to prevent zigzag/triangular detour paths
    direct_dist = _haversine_m(snap0_lat, snap0_lon, snap1_lat, snap1_lon)
    path_dist = dist.get(found_path[-1], 0.0) if found_path else 0.0
    
    # Check 1: Path should not be much longer than direct distance (tightened from 3x to 1.8x)
    if direct_dist > 30 and path_dist > direct_dist * 1.8:
        return None
    
    # Check 2: No node in the path should deviate too far from the direct line
    # This prevents triangular detours where path goes perpendicular then back
    # Max allowed deviation: 150m or 50% of direct distance, whichever is larger
    max_deviation = max(150.0, direct_dist * 0.5)
    for node_idx in found_path:
        node_lat, node_lon = road.nodes[node_idx][:2]
        # Distance from node to line segment (snap0 -> snap1)
        proj_lat, proj_lon, _ = _project_point_to_segment(
            node_lat, node_lon, snap0_lat, snap0_lon, snap1_lat, snap1_lon
        )
        deviation = _haversine_m(node_lat, node_lon, proj_lat, proj_lon)
        if deviation > max_deviation:
            return None
        
    # Convert node indices to coords
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
    max_walk_edges: int = 100,
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
    # Use prev_point as base so waypoints inherit readings from where we're traveling FROM
    # (not next_point's future readings which would cause marker to show future values)
    base = dict(prev_point)
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


def _offset_point_right(
    lat: float, lon: float,
    bearing_deg: float,
    offset_m: float,
) -> tuple[float, float]:
    """Offset a point perpendicular to a bearing (to the right).
    
    For right-hand drive (US), vehicles travel on the right side of the road.
    Bearing is the direction of travel (0=north, 90=east).
    """
    if offset_m == 0:
        return (lat, lon)
    
    # Perpendicular to the right means bearing + 90 degrees
    perp_bearing = math.radians((bearing_deg + 90) % 360)
    
    # Convert offset to degrees (rough approximation)
    # 1 degree latitude ≈ 111km
    # 1 degree longitude ≈ 111km * cos(lat)
    lat_rad = math.radians(lat)
    meters_per_deg_lat = 111320
    meters_per_deg_lon = 111320 * math.cos(lat_rad)
    
    # Offset in lat/lon
    dlat = (offset_m * math.cos(perp_bearing)) / meters_per_deg_lat
    dlon = (offset_m * math.sin(perp_bearing)) / meters_per_deg_lon
    
    return (lat + dlat, lon + dlon)


def _bearing_between(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate bearing in degrees from point 1 to point 2."""
    lat1_r = math.radians(lat1)
    lat2_r = math.radians(lat2)
    dlon = math.radians(lon2 - lon1)
    
    x = math.sin(dlon) * math.cos(lat2_r)
    y = math.cos(lat1_r) * math.sin(lat2_r) - math.sin(lat1_r) * math.cos(lat2_r) * math.cos(dlon)
    
    bearing = math.degrees(math.atan2(x, y))
    return (bearing + 360) % 360


def _angle_diff(a: float, b: float) -> float:
    """Smallest angle difference between two bearings (0-180)."""
    d = abs(a - b) % 360
    return d if d <= 180 else 360 - d


def snap_vehicle_simple(
    trail: list[dict[str, Any]],
    graph: "RoadGraph",
    *,
    max_snap_m: float = 50.0,
    lane_offset_m: float = 0.0,
) -> list[dict[str, Any]] | None:
    """Vehicle snapping with direction + continuity matching.
    
    Uses vehicle direction of travel to select correct track among parallels.
    Also prefers edges connected to previous snap for continuity.
    
    Args:
        trail: List of trail points with lat, lon, t keys.
        graph: RoadGraph instance (road or tram track).
        max_snap_m: Maximum distance to snap a point to an edge.
        lane_offset_m: Offset to the right side of the road (for right-hand drive).
    
    Returns:
        Snapped trail with same number of points, or None if too few snap.
    """
    if not trail:
        return None
    
    result: list[dict[str, Any]] = []
    snap_count = 0
    prev_edge: tuple[int, int] | None = None
    prev_lat: float | None = None
    prev_lon: float | None = None
    
    for pt in trail:
        lat = pt.get("lat")
        lon = pt.get("lon")
        
        if not (_is_finite(lat) and _is_finite(lon)):
            result.append(pt)
            prev_edge = None
            prev_lat = None
            prev_lon = None
            continue
        
        # Calculate direction of travel from previous point
        travel_bearing: float | None = None
        if prev_lat is not None and prev_lon is not None:
            # Only use direction if we moved at least 5m
            dist = _haversine_m(prev_lat, prev_lon, lat, lon)
            if dist > 5:
                travel_bearing = _bearing_between(prev_lat, prev_lon, lat, lon)
        
        # Try to snap with direction + continuity preference
        snap = graph.snap_to_edge_directed(
            float(lat), float(lon), 
            travel_bearing=travel_bearing,
            prev_edge=prev_edge,
            max_snap_distance_m=max_snap_m
        )
        
        if snap is None:
            result.append(pt)
            prev_lat = lat
            prev_lon = lon
            continue
        
        snap_lat, snap_lon, edge_a, edge_b = snap
        snap_count += 1
        prev_edge = (edge_a, edge_b)
        prev_lat = lat
        prev_lon = lon
        
        # Get edge endpoint coordinates for client-side track following
        a_lat, a_lon = graph.nodes[edge_a]
        b_lat, b_lon = graph.nodes[edge_b]
        
        # Apply lane offset for buses
        if lane_offset_m != 0:
            bearing = _bearing_between(a_lat, a_lon, b_lat, b_lon)
            snap_lat, snap_lon = _offset_point_right(snap_lat, snap_lon, bearing, lane_offset_m)
        
        new_pt = dict(pt)
        new_pt["lat"] = snap_lat
        new_pt["lon"] = snap_lon
        new_pt["rm"] = 1
        # Include edge coordinates for client to draw along track
        new_pt["ea"] = [a_lat, a_lon]  # edge point A
        new_pt["eb"] = [b_lat, b_lon]  # edge point B
        result.append(new_pt)
    
    if len(trail) > 1 and snap_count < len(trail) * 0.3:
        return None
    
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
        
        # If we found intermediate geometry, use snapped path
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
            
            # Add snapped current point (path was found)
            result.append(make_pt(p_curr_orig, s_curr[0], s_curr[1], is_snap=True))
        else:
            # NO PATH FOUND - fall back to original GPS coordinates
            # This prevents zigzag artifacts when snapped points are on disconnected components
            # or when the traced path was rejected by sanity checks.
            # Using raw GPS here ensures the trail follows the actual vehicle trajectory.
            result.append(p_curr_orig)

    return result
