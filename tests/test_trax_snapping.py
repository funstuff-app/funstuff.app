#!/usr/bin/env python3
"""
Test harness for TRX/bus road snapping parameter tuning.

This script fetches raw GPS data and compares it with road-snapped results
to help tune snapping parameters for optimal trail adherence.

Usage:
    # Test with default parameters
    python tests/test_trax_snapping.py
    
    # Test with custom snap distance
    python tests/test_trax_snapping.py --max-snap-m 30
    
    # Test specific date
    python tests/test_trax_snapping.py --date 2026-01-16
    
    # Test specific sensors
    python tests/test_trax_snapping.py --sensors TRX01,TRX02
    
    # Output to JSON files
    python tests/test_trax_snapping.py --output-dir tests/fixtures
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

# Add parent to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from mobileair.roads import RoadGraph, snap_points_to_roads
from mobileair.config import HEADERS

# Import requests
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


# Constants from dashboard_server
HISTORY_BASE_URL = "https://utahaq.chpc.utah.edu/jsondata"
HISTORY_SENSORS_TRX = ["TRX01", "TRX02", "TRX03"]
HISTORY_SENSORS_BUS = [
    "BUS01", "BUS02", "BUS03", "BUS04", "BUS05", "BUS06", "BUS07", "BUS08",
    "BUS09", "BUS10", "BUS11", "BUS12", "BUS13", "BUS14", "BUS15",
]
HISTORY_VARS = ["GLAT", "GLON"]


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate distance in meters between two GPS points."""
    r = 6371000.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def fetch_history_file(sensor: str, var: str) -> list[tuple[int, float]]:
    """Fetch a single history file from CHPC."""
    url = f"{HISTORY_BASE_URL}/{sensor}_{var}_TS_10080.json"
    try:
        data = fetch_json(url)
        return data.get("TimeDataUTC", [])
    except Exception as e:
        print(f"  Warning: Failed to fetch {sensor}_{var}: {e}")
        return []


def build_raw_trail(sensor: str, date_str: str) -> list[dict[str, Any]]:
    """Build raw trail points for a sensor on a specific date."""
    # Parse date
    day_start = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    day_end = day_start + timedelta(days=1)
    start_ms = int(day_start.timestamp() * 1000)
    end_ms = int(day_end.timestamp() * 1000)
    
    # Fetch GPS data
    lat_pts = fetch_history_file(sensor, "GLAT")
    lon_pts = fetch_history_file(sensor, "GLON")
    
    if not lat_pts or not lon_pts:
        return []
    
    # Build lookup tables
    lat_by_ts = {ts: val for ts, val in lat_pts if val is not None}
    lon_by_ts = {ts: val for ts, val in lon_pts if val is not None}
    
    # Find common timestamps within date range
    common_ts = sorted(set(lat_by_ts.keys()) & set(lon_by_ts.keys()))
    day_ts = [ts for ts in common_ts if start_ms <= ts < end_ms]
    
    # Build trail points
    trail = []
    for ts in day_ts:
        lat = lat_by_ts[ts]
        lon = lon_by_ts[ts]
        if lat is not None and lon is not None:
            t_str = datetime.fromtimestamp(ts / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")
            trail.append({
                "lat": float(lat),
                "lon": float(lon),
                "t": t_str,
                "m": 1,  # Assume moving
            })
    
    return trail


def calculate_metrics(raw_trail: list[dict], snapped_trail: list[dict]) -> dict[str, Any]:
    """Calculate comparison metrics between raw and snapped trails."""
    if not raw_trail or not snapped_trail:
        return {"error": "Empty trail"}
    
    # Count snapped points (rm=1) and waypoints (wp=1)
    snapped_count = sum(1 for p in snapped_trail if p.get("rm") == 1)
    waypoint_count = sum(1 for p in snapped_trail if p.get("wp") == 1)
    
    # Calculate total path length for raw trail
    raw_length = 0.0
    for i in range(1, len(raw_trail)):
        raw_length += haversine_m(
            raw_trail[i-1]["lat"], raw_trail[i-1]["lon"],
            raw_trail[i]["lat"], raw_trail[i]["lon"]
        )
    
    # Calculate total path length for snapped trail
    snapped_length = 0.0
    for i in range(1, len(snapped_trail)):
        snapped_length += haversine_m(
            snapped_trail[i-1]["lat"], snapped_trail[i-1]["lon"],
            snapped_trail[i]["lat"], snapped_trail[i]["lon"]
        )
    
    # Calculate average displacement from raw to snapped
    # Match points by timestamp
    raw_by_t = {p["t"]: p for p in raw_trail}
    displacements = []
    for p in snapped_trail:
        if p.get("wp") == 1:
            continue  # Skip waypoints (they don't have raw equivalents)
        t = p.get("t")
        if t and t in raw_by_t:
            raw_p = raw_by_t[t]
            d = haversine_m(raw_p["lat"], raw_p["lon"], p["lat"], p["lon"])
            displacements.append(d)
    
    avg_displacement = sum(displacements) / len(displacements) if displacements else 0.0
    max_displacement = max(displacements) if displacements else 0.0
    
    # Detect sharp turns (potential artifacts)
    sharp_turns = 0
    for i in range(1, len(snapped_trail) - 1):
        p0 = snapped_trail[i-1]
        p1 = snapped_trail[i]
        p2 = snapped_trail[i+1]
        
        # Calculate bearing change
        d1_lat = p1["lat"] - p0["lat"]
        d1_lon = p1["lon"] - p0["lon"]
        d2_lat = p2["lat"] - p1["lat"]
        d2_lon = p2["lon"] - p1["lon"]
        
        # Dot product to find angle
        dot = d1_lat * d2_lat + d1_lon * d2_lon
        mag1 = math.sqrt(d1_lat**2 + d1_lon**2)
        mag2 = math.sqrt(d2_lat**2 + d2_lon**2)
        
        if mag1 > 1e-9 and mag2 > 1e-9:
            cos_angle = max(-1, min(1, dot / (mag1 * mag2)))
            angle_deg = math.degrees(math.acos(cos_angle))
            if angle_deg > 90:  # Sharp turn threshold
                sharp_turns += 1
    
    return {
        "raw_points": len(raw_trail),
        "snapped_points": len(snapped_trail),
        "snapped_count": snapped_count,
        "waypoint_count": waypoint_count,
        "raw_length_m": round(raw_length, 1),
        "snapped_length_m": round(snapped_length, 1),
        "length_ratio": round(snapped_length / raw_length, 3) if raw_length > 0 else 0,
        "avg_displacement_m": round(avg_displacement, 2),
        "max_displacement_m": round(max_displacement, 2),
        "sharp_turns": sharp_turns,
    }


def test_snapping(
    sensors: list[str],
    date_str: str,
    max_snap_m: float,
    road_graph: RoadGraph | None,
    output_dir: Path | None = None,
) -> dict[str, Any]:
    """Test snapping for given sensors with specified parameters."""
    results = {}
    
    for sensor in sensors:
        print(f"\nProcessing {sensor}...")
        
        # Fetch raw trail
        raw_trail = build_raw_trail(sensor, date_str)
        if not raw_trail:
            print(f"  No data for {sensor} on {date_str}")
            results[sensor] = {"error": "No data"}
            continue
        
        print(f"  Raw points: {len(raw_trail)}")
        
        # Apply snapping if road graph available
        if road_graph:
            snapped_trail = snap_points_to_roads(raw_trail, road_graph, max_snap_m=max_snap_m)
            print(f"  Snapped points: {len(snapped_trail)}")
            
            # Calculate metrics
            metrics = calculate_metrics(raw_trail, snapped_trail)
            results[sensor] = {
                "params": {"max_snap_m": max_snap_m},
                "metrics": metrics,
            }
            
            # Print key metrics
            print(f"  Snapped: {metrics['snapped_count']}, Waypoints: {metrics['waypoint_count']}")
            print(f"  Avg displacement: {metrics['avg_displacement_m']}m, Max: {metrics['max_displacement_m']}m")
            print(f"  Sharp turns (>90°): {metrics['sharp_turns']}")
            print(f"  Length ratio: {metrics['length_ratio']}")
            
            # Output to files if requested
            if output_dir:
                output_dir.mkdir(parents=True, exist_ok=True)
                
                raw_file = output_dir / f"{sensor.lower()}_raw_{date_str}.json"
                snapped_file = output_dir / f"{sensor.lower()}_snapped_{date_str}_snap{int(max_snap_m)}m.json"
                
                with open(raw_file, "w") as f:
                    json.dump({"sensor": sensor, "date": date_str, "trail": raw_trail}, f, indent=2)
                
                with open(snapped_file, "w") as f:
                    json.dump({
                        "sensor": sensor,
                        "date": date_str,
                        "params": {"max_snap_m": max_snap_m},
                        "metrics": metrics,
                        "trail": snapped_trail,
                    }, f, indent=2)
                
                print(f"  Wrote {raw_file.name} and {snapped_file.name}")
        else:
            results[sensor] = {
                "raw_points": len(raw_trail),
                "error": "No road graph - raw data only",
            }
            
            if output_dir:
                output_dir.mkdir(parents=True, exist_ok=True)
                raw_file = output_dir / f"{sensor.lower()}_raw_{date_str}.json"
                with open(raw_file, "w") as f:
                    json.dump({"sensor": sensor, "date": date_str, "trail": raw_trail}, f, indent=2)
                print(f"  Wrote {raw_file.name}")
    
    return results


def main():
    parser = argparse.ArgumentParser(description="Test TRX/bus road snapping parameters")
    parser.add_argument("--date", default=None, help="Date to test (YYYY-MM-DD), default: yesterday")
    parser.add_argument("--sensors", default=None, help="Comma-separated sensor IDs (default: all TRX)")
    parser.add_argument("--max-snap-m", type=float, default=75.0, help="Max snap distance in meters (default: 75)")
    parser.add_argument("--output-dir", default=None, help="Output directory for JSON files")
    parser.add_argument("--include-buses", action="store_true", help="Also test bus sensors")
    parser.add_argument("--road-graph", default=None, help="Path to road graph JSON (default: ~/.mobileair/roads/utah_centerlines_graph.json)")
    
    args = parser.parse_args()
    
    # Default to yesterday
    if args.date is None:
        yesterday = datetime.now(timezone.utc) - timedelta(days=1)
        args.date = yesterday.strftime("%Y-%m-%d")
    
    # Parse sensors
    if args.sensors:
        sensors = [s.strip().upper() for s in args.sensors.split(",")]
    else:
        sensors = HISTORY_SENSORS_TRX[:]
        if args.include_buses:
            sensors.extend(HISTORY_SENSORS_BUS)
    
    # Load road graph
    road_graph_path = args.road_graph or RoadGraph.default_graph_path()
    road_graph = None
    if os.path.exists(road_graph_path):
        print(f"Loading road graph from {road_graph_path}...")
        try:
            road_graph = RoadGraph.load(road_graph_path)
            print(f"  Loaded {len(road_graph.nodes)} nodes, {sum(len(a) for a in road_graph.adj)} edges")
        except Exception as e:
            print(f"  Warning: Failed to load road graph: {e}")
    else:
        print(f"Warning: Road graph not found at {road_graph_path}")
        print("  Will output raw data only (no snapping)")
    
    # Output directory
    output_dir = Path(args.output_dir) if args.output_dir else None
    
    print(f"\nTesting snapping for date: {args.date}")
    print(f"Sensors: {', '.join(sensors)}")
    print(f"Parameters: max_snap_m={args.max_snap_m}")
    
    # Run test
    results = test_snapping(
        sensors=sensors,
        date_str=args.date,
        max_snap_m=args.max_snap_m,
        road_graph=road_graph,
        output_dir=output_dir,
    )
    
    # Summary
    print("\n" + "="*60)
    print("SUMMARY")
    print("="*60)
    
    for sensor, data in results.items():
        if "error" in data and data["error"] != "No road graph - raw data only":
            print(f"{sensor}: {data['error']}")
        elif "metrics" in data:
            m = data["metrics"]
            status = "OK" if m["sharp_turns"] <= 3 else "ARTIFACTS"
            print(f"{sensor}: {m['raw_points']} pts, {m['sharp_turns']} sharp turns, "
                  f"avg displacement {m['avg_displacement_m']}m [{status}]")
        else:
            print(f"{sensor}: {data.get('raw_points', '?')} raw points (no snapping)")
    
    return 0


if __name__ == "__main__":
    sys.exit(main())
