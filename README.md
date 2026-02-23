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
| PurpleAir | Community PM2.5 sensors | 10 min |
| IKEA Vindstyrka | Home PM2.5 via Dirigera Hub | Optional |

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Browser Dashboard  (dashboard/)                         │
│  Vanilla JS · Canvas map · Playback/DVR · PWA            │
└───────────────────────┬──────────────────────────────────┘
                        │ /api/state, /api/fixed, /api/snapshots …
┌───────────────────────▼──────────────────────────────────┐
│  dashboard_server.py  (ThreadingHTTPServer, port 8766)   │
│  AppState + thread lock · pre-serialized JSON cache      │
│  AirNow poller · PurpleAir poller · snapshot save/load   │
│  Road-graph map-matching · TRAX tram snapping            │
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
python dashboard_server.py          # http://localhost:8766

# Run the terminal UI (starts the server automatically)
python mobile_air.py
```

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `AIRNOW_API_KEY` | AirNow REST API key (fixed-site data) |
| `DIRIGERA_TOKEN` | IKEA Dirigera Hub token (home sensor) |
| `HOME_SENSOR_LAT` / `HOME_SENSOR_LON` | Home sensor coordinates |
| `MOBILEAIR_DATA_DIR` | Override data directory (default `~/.mobileair`) |
| `MOBILEAIR_ROAD_GRAPH` | Road graph JSON path |
| `MOBILEAIR_TRAM_LINE_GRAPH` | TRAX tram line graph path |

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
├── mobility.py            GPS-based idle/moving detection
├── trails.py              Track extraction, trail cleaning
├── outliers.py            Spatial outlier detection
├── network.py             HTTP helpers with caching
├── roads.py               Road graph + map-matching (1 100 lines)
├── dashboard.py           State normalization for the browser client
├── map_html.py            Leaflet map HTML generation
├── dirigera_home.py       IKEA Vindstyrka integration
├── tui_format.py          Shared TUI formatting
└── utils.py               Timestamps, haversine, coerce_float, median

dashboard/                 Browser dashboard (vanilla JS)
├── app.js                 Entry point, state machine, pollers
├── map_view.js            Canvas map renderer
├── map_nav_engine.js      Camera, pan/zoom, keyboard nav
├── camera_fit_logic.js    Auto-fit camera to data bounds
├── projections.js         Mercator projection
├── aqi.js                 AQI breakpoints (JS port)
├── colors.js              Pollutant color ramps
├── sidebar_ui.js          Sensor list sidebar
├── config.js              Dashboard constants
├── data_utils.js          Data transforms
├── format_utils.js        Number/time formatting
├── styles.css             Stylesheet
├── index.html             PWA shell
└── tests/                 Node.js built-in test runner

landing/                   Landing page (Win95 aesthetic)
├── index.html             Desktop, taskbar, Start menu, iframes
├── fun.js                 Screensavers, Webamp, BSOD, date rotation
├── pipes.js               3D Pipes screensaver
├── flowerbox.js           3D FlowerBox screensaver
├── style.css              Beveled chrome, CRT scanlines, VT323 font
├── manifest.json          PWA manifest
├── robots.txt / sitemap.xml

tests/                     Python unit tests (unittest)
├── test_aqi.py            … test_utils.py  (15 files)
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
Caddy. See [deploy/dustytrails/README.md](deploy/dustytrails/README.md) for
flags (`--files-only`, `--data-only`, `--skip-data`, `--setup-only`).

### Docker

```bash
docker compose up -d
```

Persistent volume at `/data`. Optional env vars for API keys.

### Kubernetes

Full manifests in `deploy/k8s/` — namespace, configmap, PVC, deployment, service,
ingress (NGINX), HPA (2–10 replicas). Kustomize-based.

```bash
kubectl apply -k deploy/k8s/
```

See [deploy/k8s/README.md](deploy/k8s/README.md) for cloud-specific notes
(DOKS, EKS, GKE).

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
- **Single-process server** — `ThreadingHTTPServer` with `AppState` + thread lock
- **Pre-serialized JSON cache** — avoids CPU spikes on every GET (critical on Pi ARM)
- **Trust boundary at write path** — sanitize incoming POST data, serve self-written files as-is
- **Mountain Time** — day boundaries use `America/Denver`, day starts at 5 AM

---

## Additional Docs

| File | Topic |
|------|-------|
| [CICD_PLAYBOOK.md](CICD_PLAYBOOK.md) | Full deploy playbook, rollback procedures |
| [HANDOFF.md](HANDOFF.md) | Architecture context for `?date=` feature |
| [POSTMORTEM_SNAPSHOT_PERF.md](POSTMORTEM_SNAPSHOT_PERF.md) | Snapshot load perf fix (30 s → 2 s) |
| [PURPLEAIR_FIXES.md](PURPLEAIR_FIXES.md) | PurpleAir batched API optimization |

---

## License

Copyright © 2026 funstuff.wtf — All rights reserved.

Contact: matt@funstuff.app
