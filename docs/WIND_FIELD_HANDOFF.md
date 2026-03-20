# Wind Field Feature — Handoff for Next Agent

## Current State (branch: `feat/wind-field`)

The wind field feature fetches RTMA-RU 15-minute wind vectors from NOAA NOMADS,
stores them as time-indexed snapshots, and renders debug arrows on the map canvas.
The feature is **broken in the PyInstaller binary** and has **no smart scheduling**.

## What Works

- `mobileair/wind.py` — fetches GRIB2 from NOMADS, parses with xarray/cfgrib
- Server stores snapshots keyed by HHMM in memory + `~/.mobileair/wind_snapshots/`
- `/api/wind-field` serves `{"HHMM": [points...], ...}` dict
- Client parses both flat array (legacy) and dict format
- Client `_windFieldForTime(epochMs)` does exact 15-min slot matching
- Historical snapshot save/load includes `wind_snapshots` field
- Wind debug arrows render in `drawOverlay` (gated by `window._fieldDebug?.showWind`)

## What Is Broken — FIX THESE

### 1. PyInstaller Binary Cannot Import xarray (CRITICAL)

**Symptom:** `xarray/cfgrib not installed — cannot parse GRIB2` in binary logs.

**Root cause:** `build_binary.py` runs PyInstaller using the **pyenv Python 3.12.9**,
NOT the `.venv` Python 3.13.7. The spec file hardcodes `.venv/lib/python3.13/` paths
for eccodeslib/eckitlib datas — these paths don't exist in the 3.12 environment.

**Fix required:**
1. In `mobileair.spec`, replace all hardcoded `.venv/lib/python3.13/site-packages/`
   paths with dynamic detection. Use something like:
   ```python
   import eccodeslib, eckitlib
   _eccodeslib_dir = os.path.dirname(eccodeslib.__file__)
   _eckitlib_dir = os.path.dirname(eckitlib.__file__)
   ```
   Then reference `_eccodeslib_dir` and `_eckitlib_dir` in `datas` and `binaries`.

2. Remove the bad hidden import `'xarray.backends.cfgrib_'` — this module does not
   exist. The correct import path is `'cfgrib.xarray_store'` which is already listed.

3. Verify after rebuild: `mobileair --headless` should log
   `[Wind] Updated: XXXX pts, snapshot HHMM` instead of the cfgrib error.

### 2. Dumb Retry Loop — No Schedule Awareness

**Symptom:** On failure, retries every 2 minutes forever. No awareness of when
NOMADS actually publishes new data.

**Current code:** `dashboard_server.py` `wind_field_fetch_loop()` around line 3655.

**Fix required:** Match the pattern used by the AirNow/sensor fetch loops:
- RTMA-RU publishes every 15 minutes with ~20-30 minute lag
- After a successful fetch, compute the next expected publish time:
  `next_analysis = current_analysis + 15min`, expected available at `next_analysis + 25min`
- Sleep until that time instead of fixed 15-min intervals
- On failure, retry ONCE after 3 minutes, then wait for the next scheduled slot
- Log the next expected fetch time so the operator knows what's happening

### 3. "No data available" Log Message Is Misleading

**Symptom:** Log says "No data available" when the real problem is cfgrib can't parse.

**Fix:** `fetch_wind_field()` returns `[]` for both "NOMADS returned nothing" and
"cfgrib import failed." Change `parse_grib2()` to raise an exception on import
failure instead of silently returning `[]`. The fetch loop should catch and log
the actual error distinctly:
- `[Wind] GRIB2 download failed` vs `[Wind] GRIB2 parse failed: {error}`

## File Locations

| File | What |
|------|------|
| `mobileair/wind.py` | GRIB2 fetch + parse + snapshot disk I/O |
| `dashboard_server.py` ~line 3575 | `wind_field_fetch_loop()` background thread |
| `dashboard_server.py` ~line 4028 | `/api/wind-field` endpoint |
| `dashboard_server.py` ~line 495 | `AppState` wind fields |
| `dashboard/map_view.js` ~line 190 | Client wind state properties |
| `dashboard/map_view.js` ~line 5310 | `_fetchWindField()` client fetch |
| `dashboard/map_view.js` ~line 5357 | `_windFieldForTime()` playback lookup |
| `dashboard/map_view.js` ~line 7879 | Wind arrow debug overlay rendering |
| `dashboard/app.js` ~line 3418 | Historical snapshot wind loading |
| `dashboard/app.js` ~line 3105 | Live mode wind state reset |
| `mobileair.spec` ~line 95,115,116 | Broken hardcoded venv paths |
| `mobileair.spec` ~line 156 | Bad hidden import `xarray.backends.cfgrib_` |
| `requirements.txt` | xarray/cfgrib/eccodes deps (already added) |
| `dashboard/index.html` ~line 291,294 | Cache-bust versions for map_view.js, app.js |

## Architecture Constraints (DO NOT VIOLATE)

- **No fallback code paths.** If a dependency is missing, fail loudly. Do not add
  `try/except ImportError` branches that silently degrade. The user will kill you.
- **No backfill from NOAA.** Only store snapshots as they arrive in real-time.
  Historical days get wind data from their saved snapshot file, not from NOAA.
- **Pre-serialized JSON in AppState.** Wind snapshot values in `app_state.wind_snapshots`
  are `bytes` (pre-serialized JSON). Do not re-serialize on every request.
- **Day boundary is 5am-5am Mountain Time.** See `_current_day_window_5am()`.
- **Bump cache-bust versions** in `index.html` when editing any `.js` file.
- **Run `python run_tests.py`** before committing. 272 Python + 169 JS tests must pass.
- **`build_binary.py` uses pyenv 3.12**, not the venv 3.13. All spec paths must work
  with the pyenv site-packages, not the venv.

## Commit History on This Branch

```
a38d10f feat: wind snapshots respect snapshot day window
3945050 fix: add xarray/cfgrib/eccodes to requirements.txt, remove fallback sleep
46918a0 cleanup: remove duplicate comment line in _fetchWindField
c2ccafb fix: bundle xarray/cfgrib/eccodes in PyInstaller binary
1f733ba fix: wind arrows show nothing when playhead is before first snapshot
bb76832 feat: time-indexed wind snapshots for playback scrubbing
c681240 fix: do not replace IDW field with advection output
5f5343e fix: wind vector debug overlay + advection re-render triggers
e58585e feat: integrate advection-diffusion into map scalar field
3f696ba feat: add advection-diffusion PDE solver (JS module + 36 tests)
ec8eb4c feat: add /api/wind-field endpoint + background RTMA-RU fetch loop
b8edbc6 feat: add RTMA-RU wind vector field fetcher module
```
