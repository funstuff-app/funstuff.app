# History

## 2026-01-04 — Dashboard camera follow + deploy safety

(Archived from the previous PLAYBOOK.md)

# MobileAir Playbook

This playbook captures the repeatable steps we used to fix the dashboard camera-follow regressions and ship safely.

## Goals (Dashboard Camera)

- Do not auto-center on dashboard load.
- User interaction always wins: no camera “snap back” while panning/zooming.
- LIVE-follow bounds include relevant visible trail history up to `meta.trail_update_end_ms` (not only points strictly inside the narrow update window).
- TUI forced refresh (`r` → `meta.force_refresh_seq`) triggers a camera fit only if it would actually change the view (debounced).
- Keep work bounded per poll (avoid O(n²)).

## Where Things Live

- Client (camera + rendering): `dashboard/app.js`
- Client map/projection engine: `dashboard/map_nav_engine.js`
- Server state contract: `/api/state` → `meta.trail_update_start_ms`, `meta.trail_update_end_ms`, `meta.force_refresh_seq`
- PyInstaller bundle config: `mobileair.spec`

## How We Fixed It

### 1) Remove auto-centering on launch

- Deleted the “initial center: first mobile” logic in `tick()`.
- Removed the `_centeredOnce` flag and any related “override restore” guard.

Result: dashboard load does not hijack the camera.

### 2) Ensure user interaction always wins

In `MapView` (client-side):

- Added an auto-camera suppression window (cooldown) after any user interaction.
- On user interaction events (wheel, pinch gesture, touch start/move, mouse down/move):
  - Cancel in-flight camera animations.
  - Start/extend the suppression cooldown.

Result: no programmatic camera fit should run while the user is interacting or immediately afterward.

### 3) Improve LIVE-follow bounds selection

We extracted the camera-fit bounds logic into a small unit-testable module:

- `dashboard/camera_fit_logic.js`

Rules implemented:

- For each non-ghosted mobile, it’s eligible only if its overall trail indicates real movement (filters jitter-only tracks).
- When computing bounds, include the most relevant visible moving segment up to `trail_update_end_ms`:
  - If there are moving points within the server update window, include the contiguous moving segment even if it started before `trail_update_start_ms`.
  - If there are no moving points in the window, include only a short recent visible segment (bounded by distance) so we don’t drag ancient history into bounds.
- Do not include idle-only noise (`m=0`) unless debug mode already does.

`dashboard/app.js` uses `window.CameraFitLogic.collectBoundsForMobilesNewSegment()` when present.

### 4) Debounce forced refresh (`r`)

- Forced refresh is detected via `meta.force_refresh_seq` bump.
- Camera fit runs only if the computed target center/zoom differs from the current camera (quantized signature).
- If a forced refresh happens during user interaction cooldown, it’s queued and applied afterward (still debounced).

## Tests We Added

- `dashboard/tests/camera_fit_logic.test.cjs`
  - Segment crossing the server window start is included
  - Jitter-only trails are ignored
  - Signature quantization is stable

Run JS tests:

```bash
node --check dashboard/app.js
node --test dashboard/tests/*.cjs
```

Run full suite:

```bash
/Users/johusha/Stuff/mobileair/.venv/bin/python run_tests.py
```

## Build + Deploy (Safe)

### Build

```bash
cd /Users/johusha/Stuff/mobileair
rm -rf build/mobileair dist/mobileair
/Users/johusha/Stuff/mobileair/.venv/bin/python -m PyInstaller --noconfirm --clean mobileair.spec
```

### Quick Verify / Debug

Smoke-test the built binary before deploying:

```bash
./dist/mobileair/mobileair --help
```

Confirm the deployed binary matches what you built:

```bash
shasum -a 256 dist/mobileair/mobileair
sudo shasum -a 256 /opt/mobileair/mobileair
```

Confirm what `mobileair` you are running (PATH/symlink sanity):

```bash
command -v mobileair
which -a mobileair
ls -la /usr/local/bin/mobileair
```

### Verify bundled assets (important)

When adding any new file under `dashboard/`, it must be included in `mobileair.spec` under `datas=[...]`.

Sanity check:

```bash
ls -la dist/mobileair/_internal/dashboard
```

### Deploy (non-destructive)

Do not delete `/opt/mobileair`.

```bash
sudo mkdir -p /opt/mobileair && sudo rsync -a --delete dist/mobileair/ /opt/mobileair/
```

Verify deploy:

```bash
ls -la /opt/mobileair/_internal/dashboard
```

## Pitfalls We Hit (and how to avoid them)

- **PyInstaller didn’t bundle new dashboard file**: adding `dashboard/camera_fit_logic.js` required updating `mobileair.spec` `datas=[...]`.
  - Fix: always verify `dist/mobileair/_internal/dashboard` before deploying.
- **PyInstaller runtime error `Python magic pattern mismatch`**: caused by a stale/partial rebuild leaving the EXE and embedded archive out of sync.
  - Fix: always do a clean build (`rm -rf build/mobileair dist/mobileair` + `PyInstaller --clean`) before deploying.
- **Node test runner path**: `node --test` expects a file/glob in our setup.
  - Use: `node --test dashboard/tests/*.cjs`

## Quick Manual Validation Checklist

- Open dashboard: it should not auto-center.
- Pan/zoom: camera should not snap back or fight.
- Press `r` repeatedly with no changes: no repeated camera animation.
- Wait for new data: LIVE-follow fit includes relevant recent trails for multiple vehicles when appropriate.
