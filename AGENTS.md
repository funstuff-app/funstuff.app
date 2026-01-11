# Agent Task: Fix Road Matching Feature

Read `HANDOFF.md` in this repo first. It contains full context including screenshots demonstrating the problem and expected behavior.

Read the **Road Matching Feature** section in `PLAYBOOK.md` for technical details about the client's vehicle physics system and why certain approaches failed.

## Your Task

Fix the road matching so that:
1. GPS coordinates are snapped to the nearest road centerline
2. NO additional waypoints are added between GPS points
3. The output trail has the SAME number of points as input

## Requirements

1. Add a `snap_points_to_roads()` function to `mobileair/roads.py` that ONLY moves coordinates, does NOT add points
2. Update `mobileair/dashboard.py` to use this function instead of `snap_trail_segments()`
3. Verify your fix works BEFORE building

## Verification Steps (YOU MUST DO THESE)

Before building, test your implementation directly:

```python
# Run this to verify your changes work
cd /Users/johusha/Stuff/mobileair && python3 -c "
from mobileair.roads import RoadGraph, snap_points_to_roads

rg = RoadGraph.load(RoadGraph.default_graph_path())

# Test trail - 5 points in, should be 5 points out
trail = [
    {'lat': 40.760, 'lon': -111.890, 'm': 1, 't': '2026-01-10 12:00:00 UTC'},
    {'lat': 40.761, 'lon': -111.888, 'm': 1, 't': '2026-01-10 12:01:00 UTC'},
    {'lat': 40.762, 'lon': -111.886, 'm': 1, 't': '2026-01-10 12:02:00 UTC'},
    {'lat': 40.763, 'lon': -111.884, 'm': 1, 't': '2026-01-10 12:03:00 UTC'},
    {'lat': 40.764, 'lon': -111.882, 'm': 1, 't': '2026-01-10 12:04:00 UTC'},
]

result = snap_points_to_roads(trail, rg)

# MUST pass these assertions
assert len(result) == len(trail), f'Point count changed: {len(trail)} -> {len(result)}'
assert not any(p.get('wp') == 1 for p in result), 'Waypoints were added - this is wrong'

# Check that some points were snapped
rm_count = sum(1 for p in result if p.get('rm') == 1)
print(f'Input: {len(trail)} pts, Output: {len(result)} pts, Road-matched: {rm_count}')
print('SUCCESS: Point count preserved, no waypoints added')
"
```

Run Python unit tests:
```bash
python -m unittest discover -s tests -p "test_*.py"
```

Only AFTER both pass, build and deploy:
```bash
rm -rf build/mobileair_bundle dist/mobileair_bundle
python -m PyInstaller --noconfirm --clean --workpath build/mobileair_bundle mobileair.spec
./deploy_local_safe.sh
```

Then verify the deployed server:
```bash
# After restarting mobileair, run this
curl -s "http://127.0.0.1:8766/api/history?date=2026-01-09" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for m in data.get('mobile', []):
    trail = m.get('trail', [])
    wp_count = sum(1 for p in trail if p.get('wp') == 1)
    rm_count = sum(1 for p in trail if p.get('rm') == 1)
    sid = m['id']
    # BUS sensors should have 0 waypoints and >0 road-matched
    # TRX sensors should have 0 of both (not snapped)
    if sid.startswith('BUS'):
        assert wp_count == 0, f'{sid}: has waypoints={wp_count}, expected 0'
        print(f'{sid}: {len(trail)} pts, road-matched={rm_count} ✓')
    elif sid.startswith('TRX'):
        assert wp_count == 0 and rm_count == 0, f'{sid}: should not be snapped'
        print(f'{sid}: {len(trail)} pts, not snapped (rail) ✓')
print('ALL CHECKS PASSED')
"
```

## Do NOT

- Do NOT use `snap_trail_segments()` - it adds waypoints
- Do NOT use `trace_road_between_gps_points()` - it densifies paths
- Do NOT add ANY waypoints or intermediate points
- Do NOT build and ask user to test - run the verification yourself
- Do NOT skip TRAX exclusion check

## Success Criteria

1. `snap_points_to_roads()` function exists and works
2. All verification commands pass without errors
3. Point counts are preserved (no waypoint additions)
4. BUS sensors have `rm=1` markers on snapped points
5. TRX sensors are unchanged (not snapped)
