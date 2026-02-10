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

## Building & deploying

### macOS native binary (PyInstaller)
- Build: `python build_binary.py`
  - **Incremental** — hashes all source files and skips the build if nothing changed since last successful build.
  - `--force` rebuilds even if hashes match.
  - `--clean` does a full clean rebuild (wipes PyInstaller cache).
- Deploy locally: `./deploy_local_safe.sh`
  - Copies `dist/mobileair_bundle/` to `~/.local/mobileair` via staging + atomic swap.
  - Does **not** delete the target directory (safe for repeated runs).
  - `--in-place` mode uses rsync without staging/swap.

### Raspberry Pi (Python source deploy)
No binary build needed — deploys Python source directly.

- **Dusty Trails (primary Pi deploy):** `deploy/dustytrails/deploy_to_pi.sh`
  - Stages files locally, patches for subpath, minifies JS (cached — only re-minifies changed files), then rsyncs to the Pi.
  - `--files-only` syncs files without restarting the service.
  - `--data-only` syncs only `~/.mobileair` data.
  - `--skip-data` skips data sync for code-only updates.
  - `--force` re-stages and re-minifies everything.
- **Generic Pi deploy:** `copy_to_pi.sh <user@host>` + `sudo ./deploy_raspberry_pi.sh`
  - `deploy_raspberry_pi.sh` auto-detects first run vs update — skips system package install, venv creation, and pip install on subsequent runs if nothing changed.
  - `--files-only` syncs without restarting the service.
  - `--restart-only` just restarts the service.
  - `--setup` forces the first-time setup steps.

### When do I need to rebuild?
| What changed | Pi deploy | Local macOS binary |
|---|---|---|
| Python code | Just re-deploy | `python build_binary.py` + `./deploy_local_safe.sh` |
| Dashboard JS/CSS/HTML | Just re-deploy | `python build_binary.py` + `./deploy_local_safe.sh` |
| `requirements.txt` | Re-deploy (pip auto-skipped if unchanged) | `python build_binary.py --clean` + `./deploy_local_safe.sh` |
| Nothing | No-ops / skips | No-ops |

## Frontend conventions
- The dashboard is **framework-free**; do not introduce a bundler.
- Map overlay/projection is implemented in JS (no map overlay library):
  - Navigation/projection engine: [dashboard/map_nav_engine.js](dashboard/map_nav_engine.js) (unit-tested)
  - Main dashboard logic: [dashboard/app.js](dashboard/app.js)
