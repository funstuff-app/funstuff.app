### MobileAir

Terminal UI for Utah air-quality **mobile + fixed** sensors, with:
- **Polling every 60s**
- **Pinned sensors**, **custom names**
- **Mobile “ghosting”** when a sensor appears immobile
- **Fixed-sensor history** persisted to disk
- **Offline/cache fallback** for transient endpoint failures

### Run

1) Install deps:

```bash
python -m pip install -r requirements.txt
```

2) Start the TUI:

```bash
python mobile_air.py
```

This also auto-starts the browser dashboard server on `http://0.0.0.0:8766`.

From another device on your LAN (e.g. iPhone), open:

`http://<raspberry-pi-ip>:8766`

To disable auto-start:

```bash
MOBILEAIR_AUTO_DASHBOARD=0 python mobile_air.py
```

To change host/port:

```bash
MOBILEAIR_DASHBOARD_HOST=127.0.0.1 MOBILEAIR_DASHBOARD_PORT=9000 python mobile_air.py
```

### Map

- Press **m** to open Apple Maps for the currently selected sensor.
- Press **Shift+M** to open an **overview map** in your browser showing all sensors currently listed.

### Dashboard (browser)

Start the dashboard server:

```bash
python dashboard_server.py
```

Then open `http://127.0.0.1:8765` in a browser.

### Data files

State is stored under `~/.mobileair/`:
- `sensor_names.json`: custom names
- `pinned_sensors.json`: pinned sensor IDs
- `fixed_history.json`: fixed-sensor history time series
- `cache_mobile.json` / `cache_fixed.json`: last successful API payloads (used on fetch failure)

### Tests

```bash
python -m unittest discover -s tests -p "test_*.py"
```

Or with per-test checkmarks:

```bash
python run_tests.py
```

If your terminal doesn’t show colors, ensure you’re not setting `NO_COLOR`, and that `TERM` is not `dumb`.