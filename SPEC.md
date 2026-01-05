# MobileAir Technical Specification

## Overview

MobileAir is a real-time air quality monitoring system for Salt Lake City that visualizes data from mobile sensors (buses, TRAX trains) and fixed monitoring stations. It consists of:

1. **Python TUI** (`mobile_air.py`) - Terminal-based dashboard using Textual/Rich
2. **HTTP Dashboard Server** (`dashboard_server.py`) - Backend API + static file server
3. **Browser Dashboard** (`dashboard/`) - Canvas-based map visualization with playback
4. **Core Logic** (`mobileair/`) - Shared data processing, mobility detection, AQI calculation

## Data Sources

### Utah AQ (Primary)
- **Mobile sensors**: `https://utahaq.chpc.utah.edu/jsondata/MobileMapData.json`
- **Fixed sensors**: `https://utahaq.chpc.utah.edu/jsondata/FixedSiteMapData.json`
- Update frequency: ~60 seconds
- No API key required

### AirNow (Secondary)
- **File-based**: `https://files.airnowtech.org/airnow/` (hourly data files)
- **REST API**: `https://www.airnowapi.org/aq/` (requires API key)
- Update frequency: Hourly
- Provides EPA monitoring station data

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Data Sources                              │
│  Utah AQ API (60s)          AirNow Files (hourly)               │
└──────────────┬─────────────────────────┬────────────────────────┘
               │                         │
               ▼                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    dashboard_server.py                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │ fetch_loop  │  │airnow_loop  │  │ names_loop  │              │
│  │   (60s)     │  │  (20min)    │  │  (watch)    │              │
│  └──────┬──────┘  └──────┬──────┘  └─────────────┘              │
│         │                │                                       │
│         ▼                ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                      AppState                                ││
│  │  - persistent_mobile: trail merging, ghosting               ││
│  │  - fixed_history: persistent readings with timestamps       ││
│  │  - airnow_readings_by_hour: hourly cache                    ││
│  │  - cached_json_bytes: pre-serialized for performance        ││
│  └─────────────────────────────────────────────────────────────┘│
│                              │                                   │
│                              ▼                                   │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              GET /api/state → JSON                          ││
│  │              GET /* → static files                          ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Browser Dashboard                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │  MapView    │  │  Playback   │  │  Details    │              │
│  │  (Canvas)   │  │  (DVR)      │  │  Panel      │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
└─────────────────────────────────────────────────────────────────┘
```

## Core Data Structures

### Mobile Sensor (JSON)
```json
{
  "id": "BUS10",
  "name": "Bus 10",
  "emoji": "🚍",
  "lat": 40.7608,
  "lon": -111.8910,
  "trail": [
    {"lat": 40.76, "lon": -111.89, "t": "2025-01-01T00:00:00Z", "m": 1, "readings": {...}}
  ],
  "readings": {"PM25": {"value": 12.5, "color": "#00FF00"}},
  "immobile": false,
  "ghosted": false,
  "stale": false,
  "mobility": {"immobile": false, "net_m": 150.5, ...}
}
```

### Fixed Sensor (JSON)
```json
{
  "id": "QHW",
  "name": "Hawthorne",
  "emoji": "📍",
  "lat": 40.7340,
  "lon": -111.8720,
  "readings": {
    "PM25": {
      "value": 15.2,
      "color": "#FFFF00",
      "history": [12.1, 13.5, 15.2],
      "history_times": ["2025-01-01T00:00:00Z", "2025-01-01T01:00:00Z", ...],
      "history_colors": ["#00FF00", "#00FF00", "#FFFF00"]
    }
  },
  "airnow_source": false
}
```

### Trail Point
```json
{
  "lat": 40.7608,
  "lon": -111.8910,
  "t": "2025-01-01T00:00:00Z",
  "m": 1,  // 1=moving, 0=idle (controls visibility in playback)
  "readings": {
    "PM25": {"value": 12.5, "color": "#00FF00"},
    "OZNE": {"value": 45, "color": "#00CCFF"}
  }
}
```

## Key Algorithms

### Mobility Detection (`mobileair/mobility.py`)

Classifies sensors as moving or idle based on GPS trail analysis:

1. **Net displacement**: Distance from first to last point
2. **Robust radius**: Median distance from centroid (handles GPS jitter)
3. **Speed estimation**: Distance / time with outlier rejection
4. **Time coverage**: Fraction of expected updates received

Thresholds:
- `ROBUST_RADIUS_IDLE_M = 25.0` - Below this = likely idle
- `NET_M_THRESHOLD = 50.0` - Minimum net movement to be "moving"
- `IDLE_SPEED_THRESHOLD_MPS = 0.3` - Below this = idle

### Trail Point Movement Flag (`m`)

Each trail point has an `m` flag indicating if the sensor was moving at that time:
- `m=1`: Moving - trail segment is drawn, marker is visible
- `m=0`: Idle - trail segment hidden, marker dimmed

The flag is computed per-point using a sliding window of recent positions.

### Ghosting (Offline Detection)

Sensors are marked `ghosted=true` when:
1. They disappear from the API for >45 seconds
2. Their last data point is stale (>5 minutes behind API update time)

Ghosted sensors:
- Remain on map with dimmed opacity (0.25)
- Show last known position
- Are cleaned up after ~45 minutes of absence

### AQI Color Mapping

Uses EPA breakpoints from `aqi_breakpoints.csv`:

| Pollutant | Good | Moderate | USG | Unhealthy | Very Unhealthy | Hazardous |
|-----------|------|----------|-----|-----------|----------------|-----------|
| PM2.5 (µg/m³) | 0-12 | 12.1-35.4 | 35.5-55.4 | 55.5-150.4 | 150.5-250.4 | 250.5+ |
| PM10 (µg/m³) | 0-54 | 55-154 | 155-254 | 255-354 | 355-424 | 425+ |
| Ozone (ppb) | 0-54 | 55-70 | 71-85 | 86-105 | 106-200 | 201+ |

Colors: 🟢 Good → 🟡 Moderate → 🟠 USG → 🔴 Unhealthy → 🟣 Very Unhealthy → 🟤 Hazardous

## Playback System

The browser dashboard includes a DVR-style playback system:

1. **Time range**: Determined by mobile sensor trail timestamps
2. **Scrubbing**: Drag timeline or markers to navigate
3. **Trail revealing**: Only shows trail up to playback time
4. **Historical readings**: Fixed sensors show values at playback time using `history_times`
5. **Speed display**: Shows interpolated speed based on trail segments

### Performance Optimizations

- **Pre-serialized JSON**: `cached_json_bytes` avoids re-encoding on each request
- **Underlay caching**: Static elements (fixed markers, trails) cached as canvas image
- **Binary search**: Playback position lookup is O(log n)
- **Trail deduplication**: Consecutive duplicate positions removed

## Persistence

Files stored in `~/.mobileair/`:

| File | Purpose |
|------|---------|
| `sensor_names.json` | Custom display names for sensors |
| `pinned_sensors.json` | User-pinned sensors (show first) |
| `fixed_history.json` | Historical readings for fixed sensors |
| `cache_mobile.json` | Offline fallback for mobile data |
| `cache_fixed.json` | Offline fallback for fixed data |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MOBILEAIR_AUTO_DASHBOARD` | `1` | Auto-start dashboard server from TUI |
| `MOBILEAIR_DASHBOARD_HOST` | `127.0.0.1` | Dashboard server bind address |
| `MOBILEAIR_DASHBOARD_PORT` | `8766` | Dashboard server port (TUI auto-start) |
| `AIRNOW_API_KEY` | (none) | API key for AirNow REST API |

## Testing

```bash
# Run all tests
python run_tests.py

# Python tests only
python -m unittest discover -s tests -p "test_*.py"

# JavaScript tests (requires Node.js)
node --test dashboard/tests/*.cjs
```

## API Endpoints

### `GET /api/state`

Returns the current sensor state as JSON:

```json
{
  "ts": 1735600000.0,
  "mobile": [...],
  "fixed": [...],
  "meta": {
    "server_start_ts": 1735590000.0,
    "server_revision": 42,
    "last_fetch_ok_ts": 1735599940.0,
    "airnow_last_fetch": 1735598000.0,
    "airnow_sites_count": 16,
    "fixed_outliers": ["OUTLIER_SENSOR_ID"]
  }
}
```

### `GET /*`

Serves static files from `dashboard/` directory.
