#!/usr/bin/env python3
"""
Build a TRAX line graph using corridor averaging with tiered data loading.

GPS traces from moving trams define track corridors; multiple traces are averaged
to create accurate centerlines. Data is loaded incrementally until track coverage
and separation quality thresholds are met.

Usage:
    python tools/build_trax_line_graph.py output.json
    python tools/build_trax_line_graph.py output.json --verbose
    python tools/build_trax_line_graph.py output.json --max-chunks 10
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

# Add parent to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from mobileair.config import HEADERS

# Import for HTTP requests
try:
    from urllib.request import urlopen, Request
    def fetch_json(url: str, timeout: int = 30) -> dict:
        req = Request(url, headers=HEADERS)
        with urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
except ImportError:
    import requests
    def fetch_json(url: str, timeout: int = 30) -> dict:
        resp = requests.get(url, headers=HEADERS, timeout=timeout)
        resp.raise_for_status()
        return resp.json()


HISTORY_BASE_URL = "https://utahaq.chpc.utah.edu/jsondata"
TRX_SENSORS = ["TRX01", "TRX02", "TRX03"]

# SLC bounding box for sanity checks
SLC_LAT_MIN, SLC_LAT_MAX = 40.5, 40.9
SLC_LON_MIN, SLC_LON_MAX = -112.1, -111.7

# Constants for corridor building
CORRIDOR_WIDTH_M = 40.0  # GPS error tolerance
MIN_VELOCITY_MPS = 2.0   # Minimum speed to consider "moving"
BIN_SIZE_M = 15.0        # Centerline averaging bin size
MIN_POINTS_PER_BIN = 2   # Minimum points to form a bin


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate distance in meters between two GPS points."""
    r = 6371000.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate bearing in degrees from point 1 to point 2."""
    dl = math.radians(lon2 - lon1)
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return math.degrees(math.atan2(x, y)) % 360


def angle_diff(a1: float, a2: float) -> float:
    """Calculate smallest angle difference between two bearings (0-180)."""
    diff = abs(a1 - a2) % 360
    return min(diff, 360 - diff)


# =============================================================================
# TimeChunkIndex - Tiered data loading
# =============================================================================

@dataclass
class TimeChunk:
    """A 4-hour block of GPS data."""
    chunk_id: int
    start_ts: int  # milliseconds
    end_ts: int    # milliseconds
    loaded: bool = False
    point_count: int = 0
    bounds: tuple[float, float, float, float] | None = None  # (min_lat, max_lat, min_lon, max_lon)
    coverage_value: float = 0.0  # Estimated coverage contribution
    
    @property
    def start_dt(self) -> datetime:
        return datetime.fromtimestamp(self.start_ts / 1000, tz=timezone.utc)
    
    @property
    def end_dt(self) -> datetime:
        return datetime.fromtimestamp(self.end_ts / 1000, tz=timezone.utc)


class TimeChunkIndex:
    """Manages tiered loading of GPS data by time chunks."""
    
    CHUNK_HOURS = 4  # 4-hour chunks
    
    def __init__(self):
        self.chunks: list[TimeChunk] = []
        self._raw_data: dict[str, dict[str, list]] = {}  # sensor -> var -> [(ts, val), ...]
        self._loaded_sensors: set[str] = set()
    
    def build_index(self, verbose: bool = False) -> None:
        """Fetch metadata and build chunk index from all TRX sensors."""
        if verbose:
            print("Building time chunk index...")
        
        # Fetch all raw data first (we need it to build the index)
        all_timestamps: set[int] = set()
        
        for sensor in TRX_SENSORS:
            if verbose:
                print(f"  Fetching {sensor} metadata...")
            
            self._raw_data[sensor] = {}
            
            for var in ["GLAT", "GLON", "GELV"]:
                url = f"{HISTORY_BASE_URL}/{sensor}_{var}_TS_10080.json"
                try:
                    data = fetch_json(url)
                    pts = data.get("TimeDataUTC", [])
                    self._raw_data[sensor][var] = pts
                    
                    if var == "GLAT":
                        all_timestamps.update(ts for ts, val in pts if val is not None)
                except Exception as e:
                    if verbose:
                        print(f"    Warning: Failed to fetch {sensor}_{var}: {e}")
                    self._raw_data[sensor][var] = []
            
            self._loaded_sensors.add(sensor)
        
        if not all_timestamps:
            if verbose:
                print("  No GPS data found!")
            return
        
        # Determine time range
        min_ts = min(all_timestamps)
        max_ts = max(all_timestamps)
        
        # Create chunks
        chunk_ms = self.CHUNK_HOURS * 3600 * 1000
        chunk_start = (min_ts // chunk_ms) * chunk_ms
        
        chunk_id = 0
        while chunk_start < max_ts:
            chunk_end = chunk_start + chunk_ms
            
            # Count points in this chunk and calculate bounds
            chunk_points = 0
            lats, lons = [], []
            
            for sensor in TRX_SENSORS:
                lat_pts = self._raw_data.get(sensor, {}).get("GLAT", [])
                lon_pts = self._raw_data.get(sensor, {}).get("GLON", [])
                
                lat_by_ts = {ts: val for ts, val in lat_pts if val is not None}
                lon_by_ts = {ts: val for ts, val in lon_pts if val is not None}
                
                for ts in lat_by_ts:
                    if chunk_start <= ts < chunk_end and ts in lon_by_ts:
                        lat, lon = lat_by_ts[ts], lon_by_ts[ts]
                        if SLC_LAT_MIN < lat < SLC_LAT_MAX and SLC_LON_MIN < lon < SLC_LON_MAX:
                            chunk_points += 1
                            lats.append(lat)
                            lons.append(lon)
            
            bounds = None
            if lats and lons:
                bounds = (min(lats), max(lats), min(lons), max(lons))
            
            # Estimate coverage value (geographic spread)
            coverage_value = 0.0
            if bounds:
                lat_span = bounds[1] - bounds[0]
                lon_span = bounds[3] - bounds[2]
                coverage_value = lat_span * lon_span * 1e6  # Scale for readability
            
            self.chunks.append(TimeChunk(
                chunk_id=chunk_id,
                start_ts=chunk_start,
                end_ts=chunk_end,
                point_count=chunk_points,
                bounds=bounds,
                coverage_value=coverage_value,
            ))
            
            chunk_start = chunk_end
            chunk_id += 1
        
        if verbose:
            total_points = sum(c.point_count for c in self.chunks)
            print(f"  Created {len(self.chunks)} chunks with {total_points} total points")
    
    def get_chunks_by_priority(self) -> list[TimeChunk]:
        """Return chunks sorted by coverage value (highest first)."""
        return sorted(
            [c for c in self.chunks if c.point_count > 0],
            key=lambda c: c.coverage_value,
            reverse=True
        )
    
    def load_chunk_paths(self, chunk: TimeChunk, min_velocity: float = MIN_VELOCITY_MPS, 
                         max_gap_s: float = 60.0) -> list[list[tuple[float, float, float, int, float, float]]]:
        """
        Load GPS data as continuous paths (not individual points).
        
        Returns list of paths, where each path is a list of (lat, lon, elev, ts, velocity, bearing).
        Paths are broken at time gaps or when velocity drops below threshold.
        """
        if chunk.loaded:
            return []
        
        all_paths: list[list[tuple[float, float, float, int, float, float]]] = []
        
        for sensor in TRX_SENSORS:
            lat_pts = self._raw_data.get(sensor, {}).get("GLAT", [])
            lon_pts = self._raw_data.get(sensor, {}).get("GLON", [])
            elev_pts = self._raw_data.get(sensor, {}).get("GELV", [])
            
            lat_by_ts = {ts: val for ts, val in lat_pts if val is not None}
            lon_by_ts = {ts: val for ts, val in lon_pts if val is not None}
            elev_by_ts = {ts: val for ts, val in elev_pts if val is not None}
            
            # Get timestamps in this chunk
            chunk_ts = sorted([
                ts for ts in lat_by_ts 
                if chunk.start_ts <= ts < chunk.end_ts and ts in lon_by_ts
            ])
            
            if not chunk_ts:
                continue
            
            # Build paths - break on time gaps or low velocity
            current_path: list[tuple[float, float, float, int, float, float]] = []
            prev_lat, prev_lon, prev_ts = None, None, None
            
            for ts in chunk_ts:
                lat = lat_by_ts[ts]
                lon = lon_by_ts[ts]
                elev = elev_by_ts.get(ts, 0.0) or 0.0
                
                # Sanity check
                if not (SLC_LAT_MIN < lat < SLC_LAT_MAX and SLC_LON_MIN < lon < SLC_LON_MAX):
                    continue
                
                velocity = 0.0
                bearing = 0.0
                
                if prev_lat is not None and prev_ts is not None:
                    dt_s = (ts - prev_ts) / 1000.0
                    
                    # Check for time gap - start new path
                    if dt_s > max_gap_s:
                        if len(current_path) >= 3:
                            all_paths.append(current_path)
                        current_path = []
                        prev_lat, prev_lon, prev_ts = None, None, None
                        continue
                    
                    if dt_s > 0:
                        dist = haversine_m(prev_lat, prev_lon, lat, lon)
                        velocity = dist / dt_s
                        bearing = bearing_deg(prev_lat, prev_lon, lat, lon)
                        
                        # Check for low velocity - start new path
                        if velocity < min_velocity:
                            if len(current_path) >= 3:
                                all_paths.append(current_path)
                            current_path = []
                            prev_lat, prev_lon, prev_ts = lat, lon, ts
                            continue
                
                current_path.append((lat, lon, elev, ts, velocity, bearing))
                prev_lat, prev_lon, prev_ts = lat, lon, ts
            
            # Don't forget last path
            if len(current_path) >= 3:
                all_paths.append(current_path)
        
        chunk.loaded = True
        return all_paths


# =============================================================================
# TrackCorridor - Represents a single track segment
# =============================================================================

@dataclass
class CorridorPoint:
    """A GPS point assigned to a corridor."""
    lat: float
    lon: float
    elev: float
    timestamp: int
    velocity: float
    bearing: float
    distance_along: float = 0.0  # Distance along corridor from start


@dataclass
class TrackCorridor:
    """
    Represents a track corridor - a tube around the actual rail line.
    
    Points within the corridor are averaged to produce the centerline.
    """
    corridor_id: int
    points: list[CorridorPoint] = field(default_factory=list)
    width_m: float = CORRIDOR_WIDTH_M
    
    # Running stats for matching
    _sum_lat: float = 0.0
    _sum_lon: float = 0.0
    _sum_elev: float = 0.0
    _sum_bearing_x: float = 0.0  # cos(bearing)
    _sum_bearing_y: float = 0.0  # sin(bearing)
    
    @property
    def point_count(self) -> int:
        return len(self.points)
    
    @property
    def center_lat(self) -> float:
        return self._sum_lat / len(self.points) if self.points else 0.0
    
    @property
    def center_lon(self) -> float:
        return self._sum_lon / len(self.points) if self.points else 0.0
    
    @property
    def avg_elev(self) -> float:
        return self._sum_elev / len(self.points) if self.points else 0.0
    
    @property
    def avg_bearing(self) -> float:
        """Average bearing in degrees."""
        if not self.points:
            return 0.0
        return math.degrees(math.atan2(self._sum_bearing_y, self._sum_bearing_x)) % 360
    
    def add_point(self, lat: float, lon: float, elev: float, ts: int, velocity: float, bearing: float) -> None:
        """Add a point to this corridor."""
        self.points.append(CorridorPoint(
            lat=lat, lon=lon, elev=elev, timestamp=ts, velocity=velocity, bearing=bearing
        ))
        self._sum_lat += lat
        self._sum_lon += lon
        self._sum_elev += elev
        self._sum_bearing_x += math.cos(math.radians(bearing))
        self._sum_bearing_y += math.sin(math.radians(bearing))
    
    def distance_to(self, lat: float, lon: float) -> float:
        """Distance from point to corridor center."""
        return haversine_m(lat, lon, self.center_lat, self.center_lon)
    
    def matches(self, lat: float, lon: float, elev: float, bearing: float, 
                max_dist_m: float = CORRIDOR_WIDTH_M, 
                max_bearing_diff: float = 45.0,
                max_elev_diff: float = 30.0) -> bool:
        """Check if a point matches this corridor."""
        if not self.points:
            return False
        
        # Distance check
        dist = self.distance_to(lat, lon)
        if dist > max_dist_m:
            return False
        
        # Bearing check (allow opposite direction too - same track)
        bearing_diff = angle_diff(bearing, self.avg_bearing)
        if bearing_diff > max_bearing_diff and bearing_diff < (180 - max_bearing_diff):
            return False
        
        # Elevation check
        if abs(elev - self.avg_elev) > max_elev_diff and elev > 0 and self.avg_elev > 0:
            return False
        
        return True
    
    def calculate_centerline(self, bin_size_m: float = BIN_SIZE_M) -> list[tuple[float, float, float]]:
        """
        Calculate the centerline by binning points spatially along the corridor direction.
        
        Returns list of (lat, lon, elev) points forming the centerline.
        """
        if len(self.points) < 2:
            if self.points:
                p = self.points[0]
                return [(p.lat, p.lon, p.elev)]
            return []
        
        # Calculate corridor direction from average bearing
        bearing_rad = math.radians(self.avg_bearing)
        dir_lat = math.cos(bearing_rad)  # North component  
        dir_lon = math.sin(bearing_rad)  # East component
        
        center_lat = self.center_lat
        center_lon = self.center_lon
        
        # Project each point onto the corridor direction to get "distance along"
        for p in self.points:
            dlat = p.lat - center_lat
            dlon = p.lon - center_lon
            p.distance_along = dlat * dir_lat + dlon * dir_lon
        
        # Sort points by position along corridor (spatial sort)
        sorted_points = sorted(self.points, key=lambda p: p.distance_along)
        
        # Convert bin size from meters to degrees
        bin_size_deg = bin_size_m / 111000.0
        
        # Bin points spatially
        centerline: list[tuple[float, float, float]] = []
        
        min_dist = sorted_points[0].distance_along
        max_dist = sorted_points[-1].distance_along
        
        if max_dist - min_dist < bin_size_deg:
            # Very short corridor - just average all
            avg_lat = sum(p.lat for p in sorted_points) / len(sorted_points)
            avg_lon = sum(p.lon for p in sorted_points) / len(sorted_points)
            avg_elev = sum(p.elev for p in sorted_points) / len(sorted_points)
            return [(avg_lat, avg_lon, avg_elev)]
        
        # Create bins along the corridor
        current_bin_start = min_dist
        point_idx = 0
        
        while current_bin_start < max_dist and point_idx < len(sorted_points):
            bin_end = current_bin_start + bin_size_deg
            
            # Collect points in this bin
            bin_points = []
            while point_idx < len(sorted_points) and sorted_points[point_idx].distance_along < bin_end:
                bin_points.append(sorted_points[point_idx])
                point_idx += 1
            
            if bin_points:
                avg_lat = sum(p.lat for p in bin_points) / len(bin_points)
                avg_lon = sum(p.lon for p in bin_points) / len(bin_points)
                avg_elev = sum(p.elev for p in bin_points) / len(bin_points)
                centerline.append((avg_lat, avg_lon, avg_elev))
            
            current_bin_start = bin_end
        
        # Ensure at least one point
        if not centerline and self.points:
            p = self.points[0]
            centerline.append((p.lat, p.lon, p.elev))
        
        return centerline


# =============================================================================
# CorridorBuilder - Main corridor building logic
# =============================================================================

class CorridorBuilder:
    """Builds track corridors from GPS data."""
    
    def __init__(self, verbose: bool = False):
        self.corridors: dict[int, TrackCorridor] = {}  # corridor_id -> corridor
        self.verbose = verbose
        self._next_corridor_id = 0
        # Spatial index for faster corridor matching
        self._grid: dict[tuple[int, int], set[int]] = {}
        self._grid_size = 0.005  # ~500m grid cells
    
    def _grid_key(self, lat: float, lon: float) -> tuple[int, int]:
        return (int(lat / self._grid_size), int(lon / self._grid_size))
    
    def _update_grid(self, corridor_id: int, lat: float, lon: float) -> None:
        key = self._grid_key(lat, lon)
        if key not in self._grid:
            self._grid[key] = set()
        self._grid[key].add(corridor_id)
    
    def find_matching_corridor(self, lat: float, lon: float, elev: float, bearing: float) -> TrackCorridor | None:
        """Find an existing corridor that matches the given point."""
        key = self._grid_key(lat, lon)
        
        # Check corridors in nearby grid cells
        candidates: list[tuple[float, TrackCorridor]] = []
        
        for di in range(-1, 2):
            for dj in range(-1, 2):
                check_key = (key[0] + di, key[1] + dj)
                for cid in self._grid.get(check_key, set()):
                    corridor = self.corridors.get(cid)
                    if corridor is None:
                        continue
                    if corridor.matches(lat, lon, elev, bearing):
                        dist = corridor.distance_to(lat, lon)
                        candidates.append((dist, corridor))
        
        if candidates:
            # Return closest matching corridor
            candidates.sort(key=lambda x: x[0])
            return candidates[0][1]
        
        return None
    
    def add_point(self, lat: float, lon: float, elev: float, ts: int, velocity: float, bearing: float) -> None:
        """Add a GPS point to the appropriate corridor, or create a new one."""
        # Skip stationary points
        if velocity < MIN_VELOCITY_MPS:
            return
        
        # Find matching corridor
        corridor = self.find_matching_corridor(lat, lon, elev, bearing)
        
        if corridor is None:
            # Create new corridor
            corridor = TrackCorridor(corridor_id=self._next_corridor_id)
            self.corridors[self._next_corridor_id] = corridor
            self._next_corridor_id += 1
        
        corridor.add_point(lat, lon, elev, ts, velocity, bearing)
        self._update_grid(corridor.corridor_id, lat, lon)
    
    def process_path(self, path: list[tuple[float, float, float, int, float, float]]) -> bool:
        """
        Process a single continuous path, adding all points to the same corridor.
        
        Returns True if path was added to a corridor.
        """
        if len(path) < 3:
            return False
        
        # Calculate path's average bearing and center point for matching
        mid_idx = len(path) // 2
        mid_lat, mid_lon, mid_elev, _, _, mid_bearing = path[mid_idx]
        
        # Find matching corridor for this path
        corridor = self.find_matching_corridor(mid_lat, mid_lon, mid_elev, mid_bearing)
        
        if corridor is None:
            # Create new corridor from this path
            corridor = TrackCorridor(corridor_id=self._next_corridor_id)
            self.corridors[self._next_corridor_id] = corridor
            self._next_corridor_id += 1
        
        # Add all points from the path to the corridor
        for lat, lon, elev, ts, velocity, bearing in path:
            corridor.add_point(lat, lon, elev, ts, velocity, bearing)
            self._update_grid(corridor.corridor_id, lat, lon)
        
        return True
    
    def process_paths(self, paths: list[list[tuple[float, float, float, int, float, float]]]) -> int:
        """
        Process all paths from a chunk.
        
        Returns number of points added.
        """
        added = 0
        for path in paths:
            if self.process_path(path):
                added += len(path)
        return added
    
    def merge_corridors(self, max_dist_m: float = CORRIDOR_WIDTH_M * 1.5) -> int:
        """
        Merge corridors that are close together and have similar bearings.
        
        Returns number of merges performed.
        """
        corridor_list = list(self.corridors.values())
        if len(corridor_list) < 2:
            return 0
        
        merged = 0
        merged_ids: set[int] = set()
        
        # Sort corridors by point count (merge smaller into larger)
        sorted_corridors = sorted(corridor_list, key=lambda c: c.point_count, reverse=True)
        
        for i, c1 in enumerate(sorted_corridors):
            if c1.corridor_id in merged_ids:
                continue
            
            for c2 in sorted_corridors[i+1:]:
                if c2.corridor_id in merged_ids:
                    continue
                
                # Check if corridors should merge
                dist = haversine_m(c1.center_lat, c1.center_lon, c2.center_lat, c2.center_lon)
                if dist > max_dist_m:
                    continue
                
                bearing_diff = angle_diff(c1.avg_bearing, c2.avg_bearing)
                if bearing_diff > 30 and bearing_diff < 150:
                    continue  # Different directions, different tracks
                
                # Merge c2 into c1
                for p in c2.points:
                    c1.add_point(p.lat, p.lon, p.elev, p.timestamp, p.velocity, p.bearing)
                
                merged_ids.add(c2.corridor_id)
                merged += 1
        
        # Remove merged corridors
        for cid in merged_ids:
            del self.corridors[cid]
        
        # Rebuild grid
        self._grid = {}
        for c in self.corridors.values():
            self._update_grid(c.corridor_id, c.center_lat, c.center_lon)
        
        return merged
    
    def get_stats(self) -> dict[str, Any]:
        """Get statistics about current corridors."""
        if not self.corridors:
            return {"corridors": 0, "total_points": 0}
        
        point_counts = [c.point_count for c in self.corridors.values()]
        return {
            "corridors": len(self.corridors),
            "total_points": sum(point_counts),
            "min_points": min(point_counts),
            "max_points": max(point_counts),
            "avg_points": sum(point_counts) / len(point_counts),
        }


# =============================================================================
# Quality Assessment
# =============================================================================

@dataclass
class QualityMetrics:
    """Quality metrics for the built graph."""
    coverage: float = 0.0      # 0-1, estimated coverage of TRAX network
    separation: float = 0.0    # 0-1, how well-separated parallel tracks are
    stability: float = 0.0     # 0-1, how stable centerlines are
    corridor_count: int = 0
    total_points: int = 0
    centerline_length_m: float = 0.0
    
    def is_sufficient(self, min_coverage: float = 0.6, min_separation: float = 0.8) -> bool:
        """Check if quality is sufficient."""
        return self.coverage >= min_coverage and self.separation >= min_separation


def assess_quality(corridors: list[TrackCorridor], verbose: bool = False) -> QualityMetrics:
    """
    Assess the quality of the built corridors.
    """
    if not corridors:
        return QualityMetrics()
    
    # Calculate centerlines for all corridors
    centerlines: list[list[tuple[float, float, float]]] = []
    total_length = 0.0
    
    for c in corridors:
        cl = c.calculate_centerline()
        if cl:
            centerlines.append(cl)
            # Calculate length
            for i in range(1, len(cl)):
                total_length += haversine_m(cl[i-1][0], cl[i-1][1], cl[i][0], cl[i][1])
    
    # Coverage estimation
    # TRAX network is roughly 70km total - but we want single centerlines, not duplicates
    # A good graph should have about 70-100km of centerline
    # If we have way more, we likely have parallel duplicates
    expected_length_m = 70000.0
    
    # Penalize if total length is way over expected (indicates duplicates)
    if total_length > expected_length_m * 1.5:
        coverage = expected_length_m / total_length  # Lower coverage if too much duplication
    else:
        coverage = min(1.0, total_length / expected_length_m)
    
    # Separation check
    # Check that parallel corridors maintain minimum separation
    separation_violations = 0
    separation_checks = 0
    min_separation_m = 50.0  # Minimum distance between parallel tracks
    
    for i, c1 in enumerate(corridors):
        for c2 in corridors[i+1:]:
            # Only check corridors with similar bearing (parallel)
            bearing_diff = angle_diff(c1.avg_bearing, c2.avg_bearing)
            if bearing_diff < 20 or bearing_diff > 160:
                # Parallel tracks - check separation
                dist = haversine_m(c1.center_lat, c1.center_lon, c2.center_lat, c2.center_lon)
                separation_checks += 1
                if dist < min_separation_m:
                    separation_violations += 1
    
    separation = 1.0 - (separation_violations / max(1, separation_checks))
    
    # Stability (placeholder - would need to compare with previous iteration)
    stability = 1.0 if len(corridors) > 10 else 0.5
    
    metrics = QualityMetrics(
        coverage=coverage,
        separation=separation,
        stability=stability,
        corridor_count=len(corridors),
        total_points=sum(c.point_count for c in corridors),
        centerline_length_m=total_length,
    )
    
    if verbose:
        print(f"  Quality: coverage={metrics.coverage:.2f}, separation={metrics.separation:.2f}, "
              f"corridors={metrics.corridor_count}, length={metrics.centerline_length_m/1000:.1f}km")
    
    return metrics


# =============================================================================
# Graph Output
# =============================================================================

def corridors_to_graph(
    corridors: list[TrackCorridor],
    verbose: bool = False,
) -> tuple[list[tuple[float, float, float]], list[list[tuple[int, float]]]]:
    """
    Convert corridors to graph format (nodes, adjacency list).
    
    Returns (nodes, adj) where:
    - nodes: list of (lat, lon, elev)
    - adj: adjacency list with [(neighbor_idx, distance), ...]
    """
    nodes: list[tuple[float, float, float]] = []
    adj: list[list[tuple[int, float]]] = []
    
    # Map from node position to index (for deduplication)
    node_key_to_idx: dict[tuple[int, int], int] = {}
    key_precision = 100000  # ~1m precision
    
    def get_node_key(lat: float, lon: float) -> tuple[int, int]:
        return (int(lat * key_precision), int(lon * key_precision))
    
    def add_node(lat: float, lon: float, elev: float) -> int:
        key = get_node_key(lat, lon)
        if key in node_key_to_idx:
            return node_key_to_idx[key]
        idx = len(nodes)
        nodes.append((lat, lon, elev))
        adj.append([])
        node_key_to_idx[key] = idx
        return idx
    
    def add_edge(idx1: int, idx2: int, dist: float) -> None:
        if idx1 == idx2:
            return
        # Check if edge already exists
        if not any(n == idx2 for n, _ in adj[idx1]):
            adj[idx1].append((idx2, dist))
        if not any(n == idx1 for n, _ in adj[idx2]):
            adj[idx2].append((idx1, dist))
    
    # Process each corridor's centerline
    corridors_processed = 0
    for corridor in corridors:
        centerline = corridor.calculate_centerline()
        if len(centerline) < 1:
            continue
        
        corridors_processed += 1
        prev_idx = None
        
        for lat, lon, elev in centerline:
            idx = add_node(lat, lon, elev)
            
            if prev_idx is not None:
                dist = haversine_m(nodes[prev_idx][0], nodes[prev_idx][1], lat, lon)
                add_edge(prev_idx, idx, dist)
            
            prev_idx = idx
    
    if verbose:
        total_edges = sum(len(neighbors) for neighbors in adj) // 2
        print(f"  Graph: {len(nodes)} nodes, {total_edges} edges from {corridors_processed} corridors")
    
    return nodes, adj


def remove_long_edges(
    nodes: list[tuple[float, float, float]],
    adj: list[list[tuple[int, float]]],
    max_edge_m: float = 500.0,
    force_max_m: float = 800.0,
    verbose: bool = False,
) -> int:
    """
    Remove edges longer than max_edge_m if there's an alternative, or longer than force_max_m regardless.
    """
    from collections import deque
    
    def has_short_path(start: int, end: int, max_hops: int = 5, exclude_direct: bool = True) -> bool:
        """Check if there's a path from start to end within max_hops."""
        queue = deque([(start, 0)])
        visited = {start}
        
        while queue:
            node, hops = queue.popleft()
            if hops >= max_hops:
                continue
            
            for neighbor, _ in adj[node]:
                if exclude_direct and node == start and neighbor == end:
                    continue
                if neighbor == end:
                    return True
                if neighbor not in visited:
                    visited.add(neighbor)
                    queue.append((neighbor, hops + 1))
        return False
    
    removed = 0
    edges_to_remove = []
    
    for i in range(len(nodes)):
        for j, d in adj[i]:
            if i >= j:
                continue
            
            # Force remove ALL edges > force_max_m (prevents zigzag paths)
            if d > force_max_m:
                edges_to_remove.append((i, j))
            # Remove long edges if there's an alternative path
            elif d > max_edge_m and has_short_path(i, j, max_hops=6, exclude_direct=True):
                edges_to_remove.append((i, j))
    
    for i, j in edges_to_remove:
        adj[i] = [(n, dist) for n, dist in adj[i] if n != j]
        adj[j] = [(n, dist) for n, dist in adj[j] if n != i]
        removed += 1
    
    if verbose and removed > 0:
        print(f"  Removed {removed} long edges (>{max_edge_m:.0f}m)")
    
    return removed


def remove_skip_edges(
    nodes: list[tuple[float, float, float]],
    adj: list[list[tuple[int, float]]],
    max_detour_ratio: float = 1.5,
    verbose: bool = False,
) -> int:
    """
    Remove redundant edges that skip over intermediate nodes.
    
    If A connects to both B and C, and B connects to C, and dist(A,B) + dist(B,C) < dist(A,C) * ratio,
    then the A->C edge is redundant and should be removed.
    """
    removed = 0
    edges_to_remove: set[tuple[int, int]] = set()
    
    for a in range(len(nodes)):
        neighbors_a = {n: d for n, d in adj[a]}
        
        for c, dist_ac in list(adj[a]):
            if c <= a:  # Process each edge once
                continue
            
            # Check if there's an intermediate node B
            for b, dist_ab in adj[a]:
                if b == c:
                    continue
                
                # Check if B connects to C
                dist_bc = None
                for n, d in adj[b]:
                    if n == c:
                        dist_bc = d
                        break
                
                if dist_bc is not None:
                    # We have A->B->C path
                    path_dist = dist_ab + dist_bc
                    
                    # If the path through B is not much longer than direct A->C,
                    # then A->C is a skip edge
                    if path_dist < dist_ac * max_detour_ratio:
                        edges_to_remove.add((min(a, c), max(a, c)))
                        break
    
    # Remove the skip edges
    for a, c in edges_to_remove:
        adj[a] = [(n, d) for n, d in adj[a] if n != c]
        adj[c] = [(n, d) for n, d in adj[c] if n != a]
        removed += 1
    
    if verbose and removed > 0:
        print(f"  Removed {removed} skip edges")
    
    return removed


def prune_high_degree_nodes(
    nodes: list[tuple[float, float, float]],
    adj: list[list[tuple[int, float]]],
    max_degree: int = 3,
    verbose: bool = False,
) -> int:
    """
    Prune edges from high-degree nodes to keep only the most linear paths.
    
    For each node with degree > max_degree, keep only the edges that form
    the most linear path (closest to 180 degrees apart).
    """
    pruned = 0
    
    for i in range(len(nodes)):
        if len(adj[i]) <= max_degree:
            continue
        
        lat_i, lon_i, _ = nodes[i]
        
        # Calculate bearing to each neighbor
        neighbors_with_bearing = []
        for j, dist in adj[i]:
            lat_j, lon_j, _ = nodes[j]
            bear = bearing_deg(lat_i, lon_i, lat_j, lon_j)
            neighbors_with_bearing.append((j, dist, bear))
        
        # Find the pair of edges that are most opposite (closest to 180 degrees)
        # This represents the main line through this node
        best_pair = None
        best_score = 0
        
        for idx1 in range(len(neighbors_with_bearing)):
            for idx2 in range(idx1 + 1, len(neighbors_with_bearing)):
                j1, d1, b1 = neighbors_with_bearing[idx1]
                j2, d2, b2 = neighbors_with_bearing[idx2]
                
                # Score: how close to 180 degrees apart
                diff = abs(b1 - b2)
                if diff > 180:
                    diff = 360 - diff
                score = diff  # Higher is better (closer to 180)
                
                # Also prefer shorter edges
                score -= (d1 + d2) / 1000  # Small penalty for long edges
                
                if score > best_score:
                    best_score = score
                    best_pair = (j1, j2)
        
        if best_pair:
            # Keep only the best pair (and maybe one more for junctions)
            keep = set(best_pair)
            
            # For max_degree=3, also keep the shortest remaining edge
            if max_degree >= 3:
                remaining = [(j, d) for j, d, b in neighbors_with_bearing if j not in keep]
                if remaining:
                    remaining.sort(key=lambda x: x[1])
                    keep.add(remaining[0][0])
            
            # Remove edges not in keep set
            to_remove = [j for j, d in adj[i] if j not in keep]
            for j in to_remove:
                adj[i] = [(nb, d) for nb, d in adj[i] if nb != j]
                adj[j] = [(nb, d) for nb, d in adj[j] if nb != i]
                pruned += 1
    
    if verbose and pruned > 0:
        print(f"  Pruned {pruned} edges from high-degree nodes")
    
    return pruned


def collapse_parallel_nodes(
    nodes: list[tuple[float, float, float]],
    adj: list[list[tuple[int, float]]],
    max_dist_m: float = 50.0,
    verbose: bool = False,
) -> tuple[list[tuple[float, float, float]], list[list[tuple[int, float]]]]:
    """
    Collapse nodes that are close together into single nodes.
    
    This removes parallel lines by merging nearby nodes into their centroid.
    """
    n = len(nodes)
    if n == 0:
        return nodes, adj
    
    # Build clusters of nodes that should merge
    parent = list(range(n))  # Union-Find
    
    def find(x):
        if parent[x] != x:
            parent[x] = find(parent[x])
        return parent[x]
    
    def union(x, y):
        px, py = find(x), find(y)
        if px != py:
            parent[px] = py
    
    # Build spatial index
    grid_size = max_dist_m / 111000.0
    grid: dict[tuple[int, int], list[int]] = {}
    for i, (lat, lon, _) in enumerate(nodes):
        key = (int(lat / grid_size), int(lon / grid_size))
        if key not in grid:
            grid[key] = []
        grid[key].append(i)
    
    # Find nodes to merge
    merges = 0
    for i in range(n):
        lat1, lon1, elev1 = nodes[i]
        key = (int(lat1 / grid_size), int(lon1 / grid_size))
        
        for di in range(-1, 2):
            for dj in range(-1, 2):
                for j in grid.get((key[0] + di, key[1] + dj), []):
                    if j <= i:
                        continue
                    
                    lat2, lon2, elev2 = nodes[j]
                    dist = haversine_m(lat1, lon1, lat2, lon2)
                    
                    if dist < max_dist_m:
                        # Check if they should merge (similar elevation)
                        if abs(elev1 - elev2) < 20 or elev1 == 0 or elev2 == 0:
                            union(i, j)
                            merges += 1
    
    if merges == 0:
        if verbose:
            print(f"  No parallel nodes to collapse")
        return nodes, adj
    
    # Build clusters
    clusters: dict[int, list[int]] = {}
    for i in range(n):
        root = find(i)
        if root not in clusters:
            clusters[root] = []
        clusters[root].append(i)
    
    # Create new nodes (centroid of each cluster)
    old_to_new: dict[int, int] = {}
    new_nodes: list[tuple[float, float, float]] = []
    
    for root, members in clusters.items():
        new_idx = len(new_nodes)
        for m in members:
            old_to_new[m] = new_idx
        
        # Centroid
        avg_lat = sum(nodes[m][0] for m in members) / len(members)
        avg_lon = sum(nodes[m][1] for m in members) / len(members)
        avg_elev = sum(nodes[m][2] for m in members) / len(members)
        new_nodes.append((avg_lat, avg_lon, avg_elev))
    
    # Build new adjacency
    new_adj: list[list[tuple[int, float]]] = [[] for _ in new_nodes]
    
    for i in range(n):
        new_i = old_to_new[i]
        for j, dist in adj[i]:
            new_j = old_to_new[j]
            if new_i != new_j:  # Skip self-loops
                # Recalculate distance
                lat1, lon1, _ = new_nodes[new_i]
                lat2, lon2, _ = new_nodes[new_j]
                new_dist = haversine_m(lat1, lon1, lat2, lon2)
                
                # Add edge if not exists
                if not any(nb == new_j for nb, _ in new_adj[new_i]):
                    new_adj[new_i].append((new_j, new_dist))
    
    if verbose:
        print(f"  Collapsed {n} nodes into {len(new_nodes)} ({n - len(new_nodes)} removed)")
    
    return new_nodes, new_adj


def find_components(adj: list[list[tuple[int, float]]]) -> list[list[int]]:
    """Find connected components in the graph."""
    n = len(adj)
    visited = [False] * n
    components = []
    
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
            for neighbor, _ in adj[node]:
                if not visited[neighbor]:
                    stack.append(neighbor)
        if comp:
            components.append(comp)
    
    return components


def connect_components(
    nodes: list[tuple[float, float, float]],
    adj: list[list[tuple[int, float]]],
    max_dist_m: float = 500.0,
    verbose: bool = False,
) -> int:
    """
    Connect disconnected components by finding closest node pairs.
    
    Iteratively connects closest component pairs until all are connected or no pair is within max_dist_m.
    """
    connections = 0
    
    while True:
        components = find_components(adj)
        
        if len(components) <= 1:
            break
        
        # Find the two closest components
        best_dist = max_dist_m
        best_pair = None  # (node_a, node_b)
        
        for i, comp_a in enumerate(components):
            for j, comp_b in enumerate(components):
                if i >= j:
                    continue
                for node_a in comp_a:
                    lat_a, lon_a, _ = nodes[node_a]
                    for node_b in comp_b:
                        lat_b, lon_b, _ = nodes[node_b]
                        dist = haversine_m(lat_a, lon_a, lat_b, lon_b)
                        if dist < best_dist:
                            best_dist = dist
                            best_pair = (node_a, node_b)
        
        if best_pair is None:
            break
        
        # Connect the two closest nodes
        a, b = best_pair
        if not any(n == b for n, _ in adj[a]):
            adj[a].append((b, best_dist))
            adj[b].append((a, best_dist))
            connections += 1
    
    if verbose and connections > 0:
        print(f"  Connected {connections} components")
    
    return connections


def _old_connect_components(
    nodes: list[tuple[float, float, float]],
    adj: list[list[tuple[int, float]]],
    max_dist_m: float = 500.0,
    verbose: bool = False,
) -> int:
    """Old version - only connects to main component."""
    components = find_components(adj)
    
    if len(components) <= 1:
        return 0
    
    if verbose:
        print(f"  Found {len(components)} disconnected components")
    
    connections = 0
    
    # Sort by size descending
    components.sort(key=len, reverse=True)
    
    # Try to connect each smaller component to the largest
    main_component = set(components[0])
    
    for comp in components[1:]:
        best_dist = max_dist_m
        best_pair = None
        
        for node_a in comp:
            lat_a, lon_a, _ = nodes[node_a]
            for node_b in main_component:
                lat_b, lon_b, _ = nodes[node_b]
                dist = haversine_m(lat_a, lon_a, lat_b, lon_b)
                if dist < best_dist:
                    best_dist = dist
                    best_pair = (node_a, node_b)
        
        if best_pair:
            a, b = best_pair
            if not any(n == b for n, _ in adj[a]):
                adj[a].append((b, best_dist))
                adj[b].append((a, best_dist))
                connections += 1
                main_component.update(comp)
    
    if verbose and connections > 0:
        print(f"  Connected {connections} components")
    
    return connections


def connect_nearby_nodes(
    nodes: list[tuple[float, float, float]],
    adj: list[list[tuple[int, float]]],
    max_dist_m: float = 100.0,
    verbose: bool = False,
) -> int:
    """
    Connect nearby nodes to create a connected graph.
    
    Connects:
    1. Isolated nodes (degree 0) to nearest neighbor
    2. Endpoints (degree 1) to nearby endpoints
    
    Returns number of connections made.
    """
    connections = 0
    
    # Build spatial index for fast lookup
    grid_size = 0.005  # ~500m
    grid: dict[tuple[int, int], list[int]] = {}
    for i, (lat, lon, _) in enumerate(nodes):
        key = (int(lat / grid_size), int(lon / grid_size))
        if key not in grid:
            grid[key] = []
        grid[key].append(i)
    
    def find_nearby(idx: int, max_m: float) -> list[tuple[int, float]]:
        lat, lon, _ = nodes[idx]
        key = (int(lat / grid_size), int(lon / grid_size))
        candidates = []
        for di in range(-2, 3):
            for dj in range(-2, 3):
                for other in grid.get((key[0] + di, key[1] + dj), []):
                    if other != idx:
                        dist = haversine_m(lat, lon, nodes[other][0], nodes[other][1])
                        if dist < max_m:
                            candidates.append((other, dist))
        return sorted(candidates, key=lambda x: x[1])
    
    # First: Connect isolated nodes (degree 0) to nearest neighbor
    isolated = [i for i, neighbors in enumerate(adj) if len(neighbors) == 0]
    if verbose:
        print(f"  Found {len(isolated)} isolated nodes")
    
    for iso in isolated:
        nearby = find_nearby(iso, max_dist_m * 2)  # Larger radius for isolated
        for other, dist in nearby:
            if not any(n == other for n, _ in adj[iso]):
                adj[iso].append((other, dist))
                adj[other].append((iso, dist))
                connections += 1
                break  # Just connect to nearest
    
    # Second: Connect endpoints (degree 1) to nearby endpoints
    endpoints = [i for i, neighbors in enumerate(adj) if len(neighbors) == 1]
    if verbose:
        print(f"  Found {len(endpoints)} endpoints")
    
    # First pass: connect endpoints to other endpoints
    for ep1 in endpoints:
        nearby = find_nearby(ep1, max_dist_m)
        for other, dist in nearby:
            if len(adj[other]) <= 1:  # Other is also an endpoint or isolated
                if not any(n == other for n, _ in adj[ep1]):
                    adj[ep1].append((other, dist))
                    adj[other].append((ep1, dist))
                    connections += 1
    
    # Second pass: connect remaining dead ends to ANY nearby node
    remaining_dead_ends = [i for i, neighbors in enumerate(adj) if len(neighbors) == 1]
    for dead_end in remaining_dead_ends:
        nearby = find_nearby(dead_end, max_dist_m)
        for other, dist in nearby:
            # Connect to any nearby node (regardless of its degree)
            if not any(n == other for n, _ in adj[dead_end]):
                adj[dead_end].append((other, dist))
                adj[other].append((dead_end, dist))
                connections += 1
                break  # Just connect to the nearest one
    
    if verbose and connections > 0:
        print(f"  Made {connections} connections")
    
    return connections


# =============================================================================
# Main Build Function
# =============================================================================

def iterative_build(
    output_path: str,
    max_chunks: int = 20,
    min_coverage: float = 0.5,
    verbose: bool = False,
) -> dict[str, Any]:
    """
    Iteratively build the tram line graph, loading data until quality is sufficient.
    
    Returns metadata about the build.
    """
    # Initialize
    index = TimeChunkIndex()
    index.build_index(verbose=verbose)
    
    if not index.chunks:
        raise RuntimeError("No GPS data available")
    
    builder = CorridorBuilder(verbose=verbose)
    
    # Get chunks sorted by priority
    priority_chunks = index.get_chunks_by_priority()
    
    if verbose:
        print(f"\nProcessing up to {min(max_chunks, len(priority_chunks))} chunks...")
    
    chunks_loaded = 0
    total_points_added = 0
    
    for chunk in priority_chunks[:max_chunks]:
        if verbose:
            print(f"\nChunk {chunk.chunk_id}: {chunk.start_dt.strftime('%Y-%m-%d %H:%M')} - "
                  f"{chunk.end_dt.strftime('%H:%M')} ({chunk.point_count} points)")
        
        # Load chunk data as continuous paths
        paths = index.load_chunk_paths(chunk)
        
        # Process paths (not individual points)
        added = builder.process_paths(paths)
        total_points_added += added
        chunks_loaded += 1
        
        if verbose:
            stats = builder.get_stats()
            print(f"  Added {added} points from {len(paths)} paths, total corridors: {stats['corridors']}")
        
        # Merge corridors periodically
        if chunks_loaded % 3 == 0:
            merged = builder.merge_corridors()
            if verbose and merged > 0:
                print(f"  Merged {merged} corridors")
        
        # Check quality
        metrics = assess_quality(list(builder.corridors.values()), verbose=verbose)
        
        if metrics.is_sufficient(min_coverage=min_coverage):
            if verbose:
                print(f"\nQuality threshold reached after {chunks_loaded} chunks")
            break
    
    # Final merge
    if verbose:
        print("\nFinal corridor merge...")
    merged = builder.merge_corridors()
    if verbose and merged > 0:
        print(f"  Merged {merged} corridors")
    
    # Filter corridors with too few points
    min_points = 5
    to_remove = [cid for cid, c in builder.corridors.items() if c.point_count < min_points]
    for cid in to_remove:
        del builder.corridors[cid]
    
    corridor_list = list(builder.corridors.values())
    
    if verbose:
        print(f"  Kept {len(corridor_list)} corridors with >= {min_points} points")
    
    # Convert to graph
    if verbose:
        print("\nConverting to graph...")
    
    nodes, adj = corridors_to_graph(corridor_list, verbose=verbose)
    
    # First: Collapse parallel edges (nodes that are close together)
    nodes, adj = collapse_parallel_nodes(nodes, adj, max_dist_m=60.0, verbose=verbose)
    
    # Prune high-degree nodes to keep only the most linear edges
    prune_high_degree_nodes(nodes, adj, max_degree=3, verbose=verbose)
    
    # Remove redundant "skip" edges (where A->C when A->B->C exists and is similar length)
    remove_skip_edges(nodes, adj, verbose=verbose)
    
    # Connect nearby nodes to form a connected graph
    connect_nearby_nodes(nodes, adj, max_dist_m=200.0, verbose=verbose)
    
    # Remove long edges - be aggressive to prevent zigzag paths
    # force_max_m=500 means edges >500m are removed even if it creates isolated nodes
    remove_long_edges(nodes, adj, max_edge_m=300.0, force_max_m=500.0, verbose=verbose)
    
    # Connect remaining disconnected components AFTER removing long edges
    # IMPORTANT: Limit max bridge to 500m to avoid creating crossing edges
    for max_bridge in [150, 250, 350, 500]:
        connected = connect_components(nodes, adj, max_dist_m=max_bridge, verbose=verbose)
        components = find_components(adj)
        if verbose:
            print(f"  After bridging at {max_bridge}m: {len(components)} components")
        if len(components) <= 1:
            break
    
    # Report if still disconnected (better than creating bad bridges)
    if verbose and len(components) > 1:
        print(f"  WARNING: {len(components)} components remain disconnected (max bridge 500m)")
    
    # Final quality
    final_metrics = assess_quality(corridor_list, verbose=verbose)
    
    # Build output
    nodes_json = [[lat, lon, round(elev, 1)] for lat, lon, elev in nodes]
    adj_json = [[[to, round(dist, 1)] for to, dist in neighbors] for neighbors in adj]
    
    graph_data = {
        "version": 2,
        "has_elevation": True,
        "source": "trax_corridor_average",
        "generated": datetime.now(timezone.utc).isoformat(),
        "quality": {
            "coverage": round(final_metrics.coverage, 3),
            "separation": round(final_metrics.separation, 3),
            "stability": round(final_metrics.stability, 3),
            "corridors": final_metrics.corridor_count,
            "centerline_length_km": round(final_metrics.centerline_length_m / 1000, 2),
        },
        "build": {
            "chunks_loaded": chunks_loaded,
            "total_points": total_points_added,
        },
        "nodes": nodes_json,
        "adj": adj_json,
    }
    
    # Write output
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    
    with open(output, "w") as f:
        json.dump(graph_data, f)
    
    if verbose:
        total_edges = sum(len(neighbors) for neighbors in adj) // 2
        file_size = output.stat().st_size
        print(f"\nWrote {output}")
        print(f"  Nodes: {len(nodes)}")
        print(f"  Edges: {total_edges}")
        print(f"  File size: {file_size / 1024:.1f} KB")
    
    return {
        "nodes": len(nodes),
        "edges": sum(len(neighbors) for neighbors in adj) // 2,
        "corridors": len(corridor_list),
        "chunks_loaded": chunks_loaded,
        "quality": final_metrics,
    }


# =============================================================================
# CLI
# =============================================================================

def main():
    parser = argparse.ArgumentParser(
        description="Build TRAX line graph using corridor averaging"
    )
    parser.add_argument("output", help="Output JSON file path")
    parser.add_argument("--max-chunks", type=int, default=20,
                        help="Maximum number of time chunks to load (default: 20)")
    parser.add_argument("--min-coverage", type=float, default=0.5,
                        help="Minimum coverage threshold to stop loading (default: 0.5)")
    parser.add_argument("--verbose", "-v", action="store_true",
                        help="Verbose output")
    
    args = parser.parse_args()
    
    try:
        result = iterative_build(
            args.output,
            max_chunks=args.max_chunks,
            min_coverage=args.min_coverage,
            verbose=args.verbose,
        )
        
        if not args.verbose:
            print(f"Built graph: {result['nodes']} nodes, {result['edges']} edges, "
                  f"coverage={result['quality'].coverage:.2f}")
        
        return 0
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        if args.verbose:
            import traceback
            traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
