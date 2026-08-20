# DustyTrails — Real-Time Air Quality Dashboard

Real-time air quality monitoring for Salt Lake City and the Wasatch Front.
Aggregates mobile, fixed, and community sensors onto a live map with playback,
a terminal UI, and a retro landing page.

**Live:** [dustytrails.funstuff.app](https://dustytrails.funstuff.app)
&nbsp;|&nbsp; **Home:** [funstuff.app](https://funstuff.app)

---

## Data Sources

| Source | What | Interval |
|--------|------|----------|
| Utah DAQ mobile buses | PM2.5, PM10, O₃, NO₂ via `utahaq.chpc.utah.edu` | ~1 min |
| UTA TRAX light-rail | PM2.5 sensors on trains | ~1 min |
| EPA / DAQ fixed sites | Traditional monitors via AirNow | Hourly |
| PurpleAir | Community PM2.5 sensors (adaptive "slime-mold walk": probe + change-driven frontier) | ~3 min day / ~30 min night |
| IKEA Vindstyrka | Home PM2.5 via Dirigera Hub | Optional |

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Browser Dashboard  (dashboard/)                         │
│  Vanilla JS · MapLibre GL 3D map · Playback/DVR · PWA    │
│  Modular engine: MapView composition root delegating to  │
│  10 engine_* controllers + 7 ui_* modules (UMD, no build)│
└───────────────────────┬──────────────────────────────────┘
                        │ /api/state, /api/fixed, /api/snapshots …
┌───────────────────────▼──────────────────────────────────┐
│  dashboard_server.py  (ThreadingHTTPServer, port 8765)   │
│  AppState + thread lock · pre-serialized JSON cache      │
│  SQLite (dustytrails.db) via background DbWorker         │
│  AirNow poller · PurpleAir walk · snapshot save/load     │
│  Road-graph map-matching · TRAX tram snapping · wind     │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│  Terminal UI — mobile_air.py  (Textual / Rich)           │
│  Gruvbox-themed TUI · can embed the server in-process    │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│  Landing Page  (landing/)                                │
│  Win95 aesthetic · Start menu · screensavers · Webamp    │
│  landing_server.py  (port 8767)                          │
└──────────────────────────────────────────────────────────┘
```

---

## Quick Start

```bash
# Clone & set up
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Run the dashboard server
python dashboard_server.py          # http://localhost:8765

# Point a dev dashboard at the Pi's live DB (scp'd in before startup)
python dashboard_server.py --remote-data-dir 'jpark@aircheck-pi.local:~/.mobileair/'

# Run the terminal UI (starts the server automatically)
python mobile_air.py
```

Data lives in `~/.mobileair` (SQLite DB, snapshots, caches, road graphs).

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `DUSTY_PURPLEAIR_API_KEY` | PurpleAir API key (empty = skip fetch, no quota burn) |
| `DUSTY_OWNER_TOKEN` | Owner auth for gated API endpoints (empty = open) |
| `DIRIGERA_TOKEN` / `DIRIGERA_IP` | IKEA Dirigera Hub (home sensor) |
| `HOME_SENSOR_LAT` / `HOME_SENSOR_LON` | Home sensor coordinates |
| `MOBILEAIR_ENABLE_ROAD_GRAPH` | Set `1` to load the road graph (off by default in prod) |
| `MOBILEAIR_ROAD_GRAPH` | Road graph JSON path |
| `MOBILEAIR_TRAM_LINE_GRAPH` | TRAX tram line graph path |
| `DUSTY_DB_RETENTION_DAYS` / `DUSTY_DB_MAX_SIZE_MB` | DB pruning limits |

---

## Project Structure

```
dashboard_server.py        Main HTTP server + API + pollers
mobile_air.py              Textual TUI application
landing_server.py          Static file server for landing page
mobileair_core.py          Backward-compat façade → mobileair/

mobileair/                 Core Python package
├── config.py              Tuning constants, thresholds, URLs, AQI tables
├── aqi.py                 AQI calculation, levels, colors, trends
├── db.py                  SQLite worker thread (dustytrails.db), JSON migration
├── mobility.py            GPS-based idle/moving detection
├── trails.py              Track extraction, trail cleaning
├── outliers.py            Spatial outlier detection
├── network.py             HTTP helpers with caching
├── roads.py               Road graph + map-matching (compact typed arrays, ~35 MB RSS)
├── wind.py                GRIB2 wind-field parsing
├── dashboard.py           State normalization for the browser client
├── map_html.py            Leaflet map HTML generation
├── dirigera_home.py       IKEA Vindstyrka integration
├── tui_format.py          Shared TUI formatting
└── utils.py               Timestamps, haversine, coerce_float, median

dashboard/                 Browser dashboard (vanilla JS, no build step)
│                          Modules are UMD: browser globals via script tags,
│                          require()-able from node tests.
├── index.html             PWA shell; script tags define the load order
├── app.js                 Bootstrap + main() wiring of the ui_* modules
├── map_view.js            MapView composition root; delegates to controllers
├── engine_mapgl_renderer.js MapLibre GL basemap, terrain, canvas sources
│
├── engine_field_sensors.js    Sensor collection for the pollution field
├── engine_tile_renderer.js    Map tiles, tile cache, snapshots
├── engine_road_matcher.js     Road/tram edge fetch, walk, snap
├── engine_vehicle_motion.js   Vehicle physics, Catmull-Rom path smoothing
├── engine_playback_engine.js  Playback/trace sampling, scrubbing, inertia
├── engine_wind_advection.js   Wind fields + advection worker glue
├── engine_pa_field.js         Pollution field kernels, workers, compositing
├── engine_overlay_renderer.js Trails, markers, badges, overlay-static cache
├── engine_camera_gestures.js  Pointer/touch/wheel input, camera, auto-fit
│
├── ui_state_sync.js       /api/state polling, ETag deltas, SSE, analytics
├── ui_legend.js           Legend build/update, tab colors, dimming
├── ui_theme.js            Theme + map filter persistence
├── ui_playback.js         Playback bar UI + loop (uses playback_state.js)
├── ui_snapshots_menus.js  Day snapshots, menus, modals
├── ui_screensaver.js      Screensaver / demo mode
│
├── playback_state.js      Runway/live-window state machine (shared w/ tests)
├── map_nav_engine.js      Projection/nav primitives
├── camera_fit_logic.js    Auto-fit camera to data bounds
├── jog_wheel.js           Barrel jog-wheel scrubber
├── advection_solver.js    Advection-diffusion solver
├── pa_field_worker.js     Field kernel Web Worker
├── pa_advection_worker.js Advection Web Worker
├── projections.js         Mercator projection
├── aqi.js                 AQI breakpoints (JS port)
├── colors.js              Pollutant color ramps
├── sidebar_ui.js          Sensor list sidebar
├── config.js              Dashboard constants (APP_TOKEN, appConfig)
├── data_utils.js          Data transforms
├── format_utils.js        Number/time formatting
├── tui.html / tui.js      Terminal-style alternate UI
├── styles.css             Stylesheet
└── tests/                 node --test suites incl. integration seam tests

landing/                   Landing page (Win95 aesthetic)
├── index.html             Desktop, taskbar, Start menu, iframes
├── fun.js                 Screensavers, Webamp, BSOD, date rotation
├── pipes.js               3D Pipes screensaver
├── flowerbox.js           3D FlowerBox screensaver
├── style.css              Beveled chrome, CRT scanlines, VT323 font
├── manifest.json          PWA manifest
├── robots.txt / sitemap.xml

tests/                     Python unit tests (unittest, 19 files)
├── test_aqi.py            … test_wind.py
└── fixtures/              Test data

tools/                     Offline graph-building scripts
├── build_trax_line_graph.py
├── build_utah_centerlines_graph.py
└── download_utah_roads_arcgis.py
```

---

## Running Tests

```bash
python run_tests.py        # Python (unittest) + JS (node --test)
```

Python tests live in `tests/`, JS tests in `dashboard/tests/`.

---

## Deployment

### Raspberry Pi (production)

```bash
# Dashboard
deploy/dustytrails/deploy_to_pi.sh

# Landing page
deploy/landing/deploy_landing.sh
```

Both run as systemd services behind a **cloudflared** tunnel, reverse-proxied by
Caddy. Secrets (PurpleAir key, owner token) come from the gitignored
`deploy/dustytrails/deploy.secrets`, injected into the systemd unit — see
[deploy/dustytrails/README.md](deploy/dustytrails/README.md) for flags
(`--files-only`, `--dry-run`, `--host <ip>`). The deploy never writes the
Pi's `~/.mobileair` data directory.

### Docker

```bash
docker compose up -d
```

Persistent volume at `/data`. Optional env vars for API keys.

---

## Dashboard URL Parameters

| Parameter | Example | Effect |
|-----------|---------|--------|
| `date` | `?date=2026-02-20` | Load a historical snapshot |
| `start` | `?start=07:00` | Playback start time |
| `duration` | `?duration=8h` | Playback window |
| `playhead` | `?playhead=12:30` | Initial playhead position |
| `lite` | `?lite=1` | Minimal UI for embedding |

---

## Design Decisions

- **No frameworks** — vanilla JS frontend, stdlib Python backend
- **No build step** — front-end modules are UMD files loaded via script tags in
  `index.html` order; the same files `require()` cleanly in node tests. Top-level
  `const`/`let` don't attach to `window`, so cross-module values are mirrored
  onto the global explicitly (see `config.js`)
- **Composition-root engine** — `MapView` owns shared view state (camera,
  selection, playback clock) and wires controllers that own their subsystem
  state; public API methods are thin delegates
- **Single-process server** — `ThreadingHTTPServer` with `AppState` + thread lock
- **Pre-serialized JSON cache** — avoids CPU spikes on every GET (critical on Pi ARM)
- **Trust boundary at write path** — sanitize incoming POST data, serve self-written files as-is
- **Mountain Time** — day boundaries use `America/Denver`, day starts at 5 AM

---

## License

Copyright © 2026 funstuff.wtf — All rights reserved.

Contact: matt@funstuff.app
