# MobileAir Playbook

This is the general engineering playbook for working in the MobileAir repo: where code lives, how to make changes safely, how to test/build/deploy, and the guardrails that prevent regressions.

For session-by-session notes and incident writeups, use `HISTORY.md`.

## Repo Map (Where Things Live)

- Core pure logic (testable): `mobileair/`
- Legacy core (kept for compatibility/tests): `mobileair_core.py`
- TUI entrypoint: `mobile_air.py`
- Dashboard server + state machine: `dashboard_server.py`
- Dashboard client (vanilla JS/CSS): `dashboard/`
- JS unit tests: `dashboard/tests/*.cjs`
- Python unit tests: `tests/test_*.py`
- PyInstaller bundle config: `mobileair.spec`

## Contracts (Don’t Break)

- `/api/state` JSON shape is the contract between server and dashboard.
- Server-authoritative meta fields (examples):
  - `meta.trail_update_start_ms`
  - `meta.trail_update_end_ms`
  - `meta.force_refresh_seq`

If you must change the JSON contract, update both:
- Server normalization (typically `mobileair/dashboard.py` and/or `dashboard_server.py`)
- Client consumption in `dashboard/app.js`
- Relevant tests.

## Change Workflow (Recommended)

1) Locate the source of truth
- UI behavior: `dashboard/app.js` (or TUI files).
- State/merging: `dashboard_server.py`.
- Pure algorithms: prefer adding/refactoring into `mobileair/`.

2) Implement the smallest correct change
- Keep UI concerns in the client.
- Keep pure logic testable (small helper modules where practical).

3) Add/adjust tests
- If it’s JS math/logic, prefer Node tests under `dashboard/tests/`.
- If it’s server behavior, prefer Python unit tests under `tests/`.

4) Run the full test suite
- Use `run_tests.py` as the default pre-ship check.

5) Build and verify packaged assets
- If you touched the dashboard static files, ensure PyInstaller bundles them.

6) Deploy safely
- Never delete the deploy target directory as part of normal deploy.

## Tests

### Python

```bash
/Users/johusha/Stuff/mobileair/.venv/bin/python -m unittest discover -s tests -p "test_*.py"
```

### Dashboard JS

```bash
node --check dashboard/app.js
node --test dashboard/tests/*.cjs
```

### Everything

```bash
/Users/johusha/Stuff/mobileair/.venv/bin/python run_tests.py
```

## Build (PyInstaller)

```bash
cd /Users/johusha/Stuff/mobileair
rm -rf build/mobileair build/mobileair_bundle dist/mobileair dist/mobileair_bundle
/Users/johusha/Stuff/mobileair/.venv/bin/python -m PyInstaller --noconfirm --clean mobileair.spec
```

If you see a PyInstaller runtime error like `ArchiveReadError: Python magic pattern mismatch`, it usually indicates a stale/partial rebuild; do the clean rebuild above.

### Bundling Rule (Dashboard)

If you add any new file under `dashboard/` that must ship in the binary, you must also add it to `mobileair.spec` under `datas=[...]`.

Sanity check the bundled assets:

```bash
ls -la dist/mobileair_bundle/_internal/dashboard
```

## Deploy (Non-Destructive)

Do not delete the deploy target directory.

```bash
./deploy_local_safe.sh
```

Verify deployed assets:

```bash
ls -la ~/.local/mobileair/_internal/dashboard
```

## Verify / Troubleshoot Build & Deploy

Smoke-test the newly built binary before deploying:

```bash
./dist/mobileair_bundle/mobileair --help
```

Confirm the deployed binary matches the built artifact (useful when diagnosing “works in dist/ but not in /opt/”):

```bash
shasum -a 256 dist/mobileair_bundle/mobileair
shasum -a 256 ~/.local/mobileair/mobileair
```

Confirm what `mobileair` you are actually running (common when `/usr/local/bin/mobileair` is a symlink):

```bash
command -v mobileair
which -a mobileair
ls -la ~/.local/bin/mobileair
```

If `which -a mobileair` shows an older wrapper earlier on PATH (e.g. under `/usr/local/bin` or `/opt/homebrew/bin`), remove/rename it or adjust PATH so `~/.local/bin` wins.

## Debug/Validation Checklist (Generic)

- Confirm tests pass (`run_tests.py`).
- Confirm the UI you changed no longer regresses (manual smoke test).
- Confirm packaging includes new static assets (if any).
- Confirm deploy did not delete the deploy target directory.

---

## Road Matching Feature

### Background

Vehicles (buses, trams) have GPS trails that don't align perfectly with roads. A bus might appear to drive through buildings. The goal is to snap GPS coordinates to the road network.

A road graph exists at `~/.mobileair/roads/utah_centerlines_graph.json` (146k nodes). The `RoadGraph` class in `mobileair/roads.py` loads this.

### The Client's Vehicle Physics System

**This is critical to understand before modifying road matching.**

The client (`dashboard/app.js`) has a vehicle animation system that takes sparse GPS and generates smooth paths:

1. **Playback Points** (`_playbackPtsById`, ~line 3320) - Stores sparse GPS per vehicle

2. **Progressive Spline Path** (`_getVehiclePath`, `_extendVehiclePath`, ~line 3520)
   - Computes Catmull-Rom splines between GPS points
   - Tension varies with playback speed
   - Paths computed incrementally as vehicle drives

3. **Vehicle Physics** (`_playbackSampleForMobile`, ~line 4170)
   - Each vehicle has position (`phys.d`) and velocity (`phys.v`)
   - `CURVATURE_LOOKAHEAD = 100` meters - how far ahead vehicle scans for curves
   - Vehicles brake for curves, accelerate on straights

4. **Lookahead Calculation** (~line 4318):
   ```javascript
   const lookaheadDist = MapView.CURVATURE_LOOKAHEAD * Math.max(1, controlScalar);
   const curveLookaheadEnd = Math.min(phys.d + lookaheadDist, totalDist);
   ```

5. **Debug Visualization** (`_pbDebugPath`, `_vehicleRevealDist`)
   - Cyan dots show computed path ahead of vehicle (visible when vehicle selected)
   - This shows what client ALREADY generates from sparse GPS

### What This Means

The client takes 100 sparse GPS points and generates smooth paths client-side. It does NOT need densified waypoints from the server. It only needs GPS coordinates snapped to roads so the splines follow roads.

### Failed Approaches

1. **`snap_trail_segments()` with densification** - Called `trace_road_between_gps_points()` which adds waypoint every 25m. Result: 100 pts → 10,000+ pts. Client can't handle.

2. **Foveated matching with arbitrary time windows** - Tried 10-minute lookahead. Time windows don't align with vehicle physics.

3. **Client-side progressive matching** - Added `_requestFoveatedRoadMatching()` but still called densifying function.

### Correct Approach

**Phase 1: Simple Point Snapping**

Create `snap_points_to_roads()` that:
- Takes trail array and road graph
- For each point with `m=1`, snap lat/lon to nearest road (within 40m)
- Returns SAME number of points
- Marks snapped points with `rm=1`

**Phase 2: Foveated Optimization (for large historical trails)**

Use client's existing lookahead:
1. Track matched segments in `_roadMatchedRangesById`
2. When vehicle's `curveLookaheadEnd` approaches unmatched segment, request match
3. Server returns snapped coordinates (same point count)
4. Client updates trail and invalidates spline cache

This leverages client's existing physics instead of reinventing lookahead.

### TRAX Exclusion

TRAX sensors (`TRX*`) are light rail on dedicated tracks. Must NOT be snapped:
```python
if not (sid.startswith("TRX") or sid.startswith("TRAX")):
```

### Verification

Test point snapping preserves count:
```bash
python3 -c "
from mobileair.roads import RoadGraph, snap_points_to_roads
rg = RoadGraph.load(RoadGraph.default_graph_path())
trail = [{'lat': 40.76, 'lon': -111.89, 'm': 1, 't': 'x'}] * 5
result = snap_points_to_roads(trail, rg)
assert len(result) == 5; print('PASS')
"
```

Test server endpoint:
```bash
curl -s "http://127.0.0.1:8766/api/history?date=2026-01-09" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for m in data.get('mobile', []):
    t = m.get('trail', [])
    wp = sum(1 for p in t if p.get('wp'))
    rm = sum(1 for p in t if p.get('rm'))
    print(f\"{m['id']}: {len(t)} pts, wp={wp}, rm={rm}\")
"
```

Expected: `wp=0` for all. `rm>0` for BUS sensors.

### Key Files

| File | What |
|------|------|
| `mobileair/roads.py` | `RoadGraph`, `snap_to_edge()` (~186), snapping functions |
| `mobileair/dashboard.py` | `normalize_state_for_dashboard()`, road matching call (~280) |
| `dashboard/app.js` | `_playbackSampleForMobile` (~4170), `CURVATURE_LOOKAHEAD`, `_vehicleRevealDist` |
