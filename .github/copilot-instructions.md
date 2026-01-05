# Copilot instructions (MobileAir)

## Big picture
- This repo is a **Python TUI + lightweight HTTP dashboard + shared core logic**.
- Data source: Utah AQ endpoints
  - Mobile: `https://utahaq.chpc.utah.edu/jsondata/MobileMapData.json`
  - Fixed: `https://utahaq.chpc.utah.edu/jsondata/FixedSiteMapData.json`
- Keep UI concerns separate from logic:
  - **Pure/testable logic lives in** [mobileair_core.py](mobileair_core.py)
  - Textual/Rich TUI lives in [mobile_air.py](mobile_air.py)
  - Browser dashboard server lives in [dashboard_server.py](dashboard_server.py)
  - Browser UI is vanilla JS/CSS in [dashboard/](dashboard/)

## Core contracts (don’t break tests)
- `mobileair_core.normalize_state_for_dashboard(...)` defines the **JSON shape** consumed by the browser (`GET /api/state`).
  - Output includes `mobile`/`fixed` arrays plus `meta`.
  - Mobile entries include fields like `id`, `trail` (list of `{lat, lon, t, ...}`), `ghosted`, `pinned`, `emoji`, and pollutant readings.
- `dashboard_server.update_app_state_with_new_data(...)` maintains a **persistent mobile state-machine**:
  - Merges/extends `trail` efficiently and annotates points with `m` (movement marker).
  - Implements “sticky ghosting” when a sensor disappears and cleans up stale entries after ~1 hour.
  - Pre-serializes JSON into `AppState.cached_json_bytes` to avoid CPU spikes on each request.

## Persistence & caches
- User state is stored under `~/.mobileair/`:
  - `sensor_names.json`, `pinned_sensors.json`, `fixed_history.json`
  - API caches: `cache_mobile.json` / `cache_fixed.json` (used by `fetch_json_with_cache`)
- Prefer `mobileair_core.fetch_json_with_cache(...)` for network reads so offline/failure fallback stays consistent.

## How to run
- Install:
  - `python -m pip install -r requirements.txt`
- Start TUI (also auto-starts dashboard server by default):
  - `python mobile_air.py`
  - Disable dashboard auto-start: `MOBILEAIR_AUTO_DASHBOARD=0 python mobile_air.py`
  - Auto-start server host/port: `MOBILEAIR_DASHBOARD_HOST=127.0.0.1 MOBILEAIR_DASHBOARD_PORT=8766 python mobile_air.py`
    - Note: `mobile_air.py` defaults auto-start port to **8766**, while `dashboard_server.py` defaults to **8765** when run directly.
- Start dashboard server directly:
  - `python dashboard_server.py` (serves [dashboard/index.html](dashboard/index.html) and `GET /api/state`)

## Tests (preferred workflow)
- Run everything (Python + optional Node dashboard tests):
  - `python run_tests.py`
    - This runs `unittest` under [tests/](tests/) and, if `node` is available, `node --test` over [dashboard/tests/](dashboard/tests/).
- Python-only:
  - `python -m unittest discover -s tests -p "test_*.py"`

## Frontend conventions
- The dashboard is **framework-free**; do not introduce a bundler.
- Map overlay/projection is implemented in JS (no map overlay library):
  - Navigation/projection engine: [dashboard/map_nav_engine.js](dashboard/map_nav_engine.js) (unit-tested)
  - Main dashboard logic: [dashboard/app.js](dashboard/app.js)

## When changing behavior
- If you adjust mobility/ghosting/trail-cleaning logic, update corresponding tests in:
  - [tests/test_mobileair_core.py](tests/test_mobileair_core.py)
  - [tests/test_dashboard_server_logic.py](tests/test_dashboard_server_logic.py)

# AI Agent Instructions for MobileAir

You are an AI coding agent working in the MobileAir repo. Read this carefully and follow it exactly.

**Non-negotiables**
- Do NOT delete the target deploy directory during deploy. No `sudo rm -rf /opt/mobileair`. Deploy should replace/update artifacts without nuking the directory.
- Do NOT add new UX, fallbacks, or “helpful” extra behaviors. Implement only what is explicitly requested below.
- Do NOT lock or override user camera interaction (pan/zoom) with programmatic camera animations.
- Do NOT add arbitrary time windows (“fallback windows”) or client heuristics for “since last update”. Server meta is authoritative.
- Keep UI vs logic separation: client behavior in app.js; server state/meta in dashboard_server.py.

**Context / current behavior**
- The dashboard uses LIVE camera follow + a server-authoritative update window: `meta.trail_update_start_ms` and `meta.trail_update_end_ms` (epoch ms) from `/api/state`.
- TUI key `r` bumps `meta.force_refresh_seq` to request a camera refit even if timestamps didn’t advance.
- Camera fitting currently tends to center on a single vehicle because it only considers points strictly inside the update window, and it only includes points marked “moving” via trail point `m=1`. This misses visible trail history that should contribute to bounds.
- There is an “initial center on first mobile” behavior on app launch/poll start that must be removed.
- There were regressions introduced: camera animations can “fight” user panning/zooming.

**Tasks**
1) Deploy behavior (do not implement code here unless asked, just ensure future steps follow it)
- Stop deleting mobileair during deploy. Replace with a safe update approach (e.g., move to temp + swap, or copy over changed files). The key requirement: don’t blow away the target dir as part of normal deploy.

2) Remove auto-centering on launch
- Remove the “initial center: first mobile” logic in app.js (it sets `map.center` and toggles a `_centeredOnce` flag).
- Also remove any other “regressive” camera behavior that auto-recenters without an explicit user action (or explicit LIVE-follow mode behavior). The default on load should not hijack the view.

3) Never lock user interaction
- Ensure programmatic camera animations do not override the user if they are interacting.
- “User interacting” includes: active drag/pan, wheel zoom, touch gesture, or a short cooldown after an interaction ends.
- If the user interacts, LIVE-follow camera should either:
  - Temporarily disable camera-follow (best), or
  - Cancel any in-flight camera animation and refuse to start a new one until a cooldown passes.
- Requirement: user input must always win. No “snap back”.

4) Fix bounds: include relevant “past visible trail”, not only points strictly inside the update window
- The camera-fit bounds should represent “what’s visibly relevant since last update”, but it must not exclude a vehicle simply because it didn’t move inside that short update window.
- Concrete rule to implement:
  - For each non-ghosted mobile, consider the vehicle eligible if its overall trail indicates real movement (and not pure jitter).
  - When building bounds, include the most recent visible trail segment up to `trail_update_end_ms`, even if the segment started before `trail_update_start_ms`.
  - Do not include idle-only noise (points with `m=0`) unless debug mode already does so.
- The intent: camera fit should include vehicles with visible recent trails even when only one vehicle produced new data in the last poll.

5) Forced refresh `r`: add debouncing (don’t re-run same animation)
- Pressing `r` should cause a camera fit animation only when it would actually change the view.
- Add debouncing based on a stable “fit target signature”, e.g.:
  - the computed bounds (minLat/minLon/maxLat/maxLon) quantized to a small epsilon, OR
  - the resulting target `centerLat/centerLon/zoom` quantized.
- If the new target signature matches the last applied target signature (within epsilon), do nothing.
- Also: forced refresh should still work even if playback RAF is idle (poll/tick path must trigger it), but it must respect the “user interaction wins” rule.

**Implementation constraints**
- Keep the server meta contract: `meta.trail_update_start_ms`, `meta.trail_update_end_ms`, `meta.force_refresh_seq`. No new server fields unless absolutely necessary.
- Do not add new UI controls, settings, toggles, or new pages.
- Keep performance: avoid O(n²) scanning over huge trails per frame; do bounded work per poll/update.
- Keep code changes minimal and localized to the camera-fit logic and initial centering logic.

**Acceptance criteria**
- On dashboard load: the map does NOT auto-center on the first mobile.
- While the user pans/zooms: the camera does not “snap back” or animate against them.
- When LIVE-follow camera fit runs: it includes the relevant visible trails (including recent history up to `trail_update_end_ms`), not just the single vehicle that happened to advance the update window.
- Idle vehicles with only GPS jitter are ignored (good), but vehicles with real trails remain included.
- Pressing `r` triggers a camera animation only when it would materially change the camera (debounced).
- Deploy instructions never delete mobileair.

**How to validate**
- Open dashboard, pan/zoom manually, then press `r` and confirm it does not override interaction.
- Wait for new data; confirm camera fit includes multiple visible trail groups when appropriate.
- Press `r` repeatedly with no change; confirm no repeated animations occur.
- Confirm deploy procedure updates assets without deleting mobileair.
