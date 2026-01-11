# Agent Handoff: Road Matching Feature

## Current State: BROKEN - DO NOT DEPLOY

The road matching feature is severely broken and causing the dashboard to soft-lock when loading historical data.

## Background: What We Were Trying To Do

The MobileAir dashboard shows air quality sensor vehicles (buses, trams) moving on a map. Each vehicle has a GPS trail showing where it's been. The raw GPS data is sparse (one point every 30 seconds) and often doesn't align perfectly with roads - a bus might appear to drive through buildings.

The goal was to **snap the GPS coordinates to the actual road network** so vehicles appear to drive on roads, not through them.

A road graph exists at `~/.mobileair/roads/utah_centerlines_graph.json` (146k nodes) representing Utah's road centerlines. The `RoadGraph` class in `mobileair/roads.py` can load this and snap points to the nearest road edge.

## What Went Wrong

The implementation in `mobileair/roads.py:snap_trail_segments()` (around line 656) does TWO things:

1. Snaps each GPS point to the nearest road ✓ (correct)
2. Calls `trace_road_between_gps_points()` which **densifies** the path by adding a waypoint every 25 meters between GPS points ✗ (WRONG)

This densification causes:
- A trail with 100 GPS points becomes 10,000+ points
- The trails render as solid lines instead of dashed (too many points)
- Historical data (which has thousands of GPS points per vehicle per day) takes forever to process
- The client was never designed to handle this point density

## What The Client Already Does

Look at `dashboard/app.js` around line 3500-3700 (search for `_getVehiclePath` and `_extendVehiclePath`). The client has a **progressive spline path system** that:

1. Takes sparse GPS points
2. Computes smooth Catmull-Rom splines between them
3. Reveals the path progressively as the vehicle drives
4. Shows a debug visualization (cyan dots) when a vehicle is selected

This spline system already makes vehicles drive smoothly between sparse GPS points. The cyan dots visible in screenshots (See HANDOFF_SCREENSHOTS directory) are this system working. It does NOT need densified server data - it generates smooth paths client-side from sparse GPS input.

## Screenshots
Screenshot 2026-01-10 at 2.13.18 PM:
The cyan path is seen showing the vehicle's lookahead heuristics (this is what you should be leveraging to optimize the GPS data, not arbitrary pathfinding algorithms)

Screenshot 2026-01-10 at 2.26.13 PM:
You can see the line segment density is exploding. Compare to the TRAXX path (still shows dotted when zoomed out) whose path optimization was intentionally skipped, so you're seeing the raw GPS Coordinates for only this path.

Screenshot 2026-01-10 at 12.36.45 PM:
Demonstrates an example of correct trail optimizing. Notice it smoothly follows curved roads (this data exists as city street lines in the local json)

Screenshot 2026-01-10 at 12.37.40 PM:
Same path as the screenshot above, but this is the raw GPS from an early passby. The vehicle has yet to return, so we are haven't applied the smoothing, or snapping to this older segment (for performance reasons we only optimize, or snap, the lookahead segment to the street, updating the data as the vehicle "drives" along the raw GPS path.)

Screenshot 2026-01-10 at 12.55.56 PM:
This is a failure case where overcomplicated and expensive A* pathfinding was used, causing even more unintended jitter from the clean GPS path (a straight line) these diverted paths are unintended and should be avoided.

## The Fix

The server should ONLY snap coordinates to roads, NOT add intermediate points. Specifically:

1. In `mobileair/dashboard.py` around line 280, there's a call to `snap_trail_segments()`. This needs to be replaced with a simpler function.

2. Create a new function in `mobileair/roads.py` like:

```python
def snap_points_to_roads(
    trail: list[dict],
    road: RoadGraph,
    max_snap_m: float = 40.0,
) -> list[dict]:
    """Snap trail point coordinates to nearest roads WITHOUT adding waypoints.
    
    Returns same number of points as input - only lat/lon are modified.
    """
    result = []
    for point in trail:
        if not isinstance(point, dict):
            result.append(point)
            continue
        
        lat = point.get("lat")
        lon = point.get("lon")
        is_moving = point.get("m") == 1
        
        if not (is_moving and _is_finite(lat) and _is_finite(lon)):
            result.append(point)
            continue
        
        # Snap to nearest road
        snapped = road.snap_to_nearest_road(float(lat), float(lon), max_snap_distance_m=max_snap_m)
        if snapped is not None:
            new_point = dict(point)
            new_point["lat"] = snapped[0]
            new_point["lon"] = snapped[1]
            new_point["rm"] = 1  # Mark as road-matched
            result.append(new_point)
        else:
            result.append(point)
    
    return result
```

3. Update `mobileair/dashboard.py` to call this instead of `snap_trail_segments()`.

## TRAX Exclusion

TRAX sensors (IDs starting with "TRX") are light rail vehicles that run on their own tracks, NOT roads. These must NOT be snapped. There's already a check for this:

```python
if not (sid.startswith("TRX") or sid.startswith("TRAX")):
```

## How To Test

```bash
# Check that historical data has SAME point count (no waypoint additions)
curl -s "http://127.0.0.1:8766/api/history?date=2026-01-09" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for m in data.get('mobile', []):
    trail = m.get('trail', [])
    wp_count = sum(1 for p in trail if p.get('wp') == 1)
    rm_count = sum(1 for p in trail if p.get('rm') == 1)
    print(f\"{m['id']}: {len(trail)} pts, waypoints={wp_count}, road-matched={rm_count}\")
"
```

Expected: `waypoints=0` for all sensors. `road-matched` should be > 0 for BUS sensors.

## Build & Deploy

```bash
cd /Users/johusha/Stuff/mobileair
rm -rf build/mobileair_bundle dist/mobileair_bundle
python -m PyInstaller --noconfirm --clean --workpath build/mobileair_bundle mobileair.spec
./deploy_local_safe.sh
# Then restart the mobileair process
```

## Files To Modify

1. `mobileair/roads.py` - Add `snap_points_to_roads()` function
2. `mobileair/dashboard.py` - Change call from `snap_trail_segments()` to `snap_points_to_roads()`

## Files To Read For Context

1. `mobileair/roads.py` - See `RoadGraph.snap_to_nearest_road()` method (~line 186) for how snapping works
2. `mobileair/dashboard.py` - See `normalize_state_for_dashboard()` and where road matching is called (~line 280)
3. `dashboard/app.js` - Search for `_playbackSampleForMobile` to see how the client interpolates vehicle positions
