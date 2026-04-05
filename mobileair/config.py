"""
Configuration constants for MobileAir.

All tuning parameters, thresholds, and fixed data are centralized here.
"""

from __future__ import annotations

# ============================================================================
# Trend / Projection Tuning
# ============================================================================
TREND_LOOKAHEAD_MINUTES = 15
TREND_WINDOW_SAMPLES = 15
TREND_THRESHOLDS = {
    "pm2.5": 1.0,
    "pm25": 1.0,
    "pm10": 2.0,
    "ozone": 2.0,
    "default": 1.0,
}

# ============================================================================
# Mobility Detection Tuning
# ============================================================================
# Conservative to avoid false flags (meters/minutes)
IMMOBILITY_LOOKBACK_MINUTES = 15
IMMOBILITY_MIN_COVERAGE_MINUTES = 12
IMMOBILITY_MIN_SAMPLES = 6

IMMOBILITY_TOTAL_DISTANCE_THRESHOLD = 250  # Relaxed to allow more GPS drift
IMMOBILITY_MAX_STEP_THRESHOLD = 150
IMMOBILITY_BBOX_THRESHOLD = 300
IMMOBILITY_RADIUS_THRESHOLD = 220
IMMOBILITY_NET_DISTANCE_THRESHOLD = 260

# When data is sparse, default to "idle" unless movement is clearly proven.
# This matches the dashboard intent: avoid showing parked vehicles "driving" due to GPS drift.
SPARSE_PROVE_MOVING_MAX_STEP_M = 60
SPARSE_PROVE_MOVING_NET_M = 100
SPARSE_ASSUME_IDLE_ROBUST_RADIUS_M = 120

# ============================================================================
# Data Staleness Detection
# ============================================================================
# A sensor is considered "stale" if its last data point is this many minutes
# older than the API's last update timestamp. Stale sensors should be dimmed/ghosted.
STALE_DATA_THRESHOLD_MINUTES = 30

# ============================================================================
# AQI Levels (EPA-based)
# ============================================================================
AQI_LEVELS = [
    {"label": "Good", "aqi_hi": 50, "color": "#00E400"},
    {"label": "Moderate", "aqi_hi": 100, "color": "#FFFF00"},
    {"label": "Sensitive Groups", "aqi_hi": 150, "color": "#FF7E00"},
    {"label": "Unhealthy", "aqi_hi": 200, "color": "#FF0000"},
    {"label": "Very Unhealthy", "aqi_hi": 300, "color": "#8F3F97"},
    {"label": "Hazardous", "aqi_hi": 500, "color": "#7E0023"},
]

# ============================================================================
# Pollutant Breakpoints (from EPA AQS codetable / aqi_breakpoints.csv)
# ============================================================================
POLLUTANT_BREAKPOINTS = {
    "pm2.5": [
        # PM2.5 24-hour
        {"c_low": 0.0, "c_high": 9.0, "aqi_low": 0, "aqi_high": 50},
        {"c_low": 9.1, "c_high": 35.4, "aqi_low": 51, "aqi_high": 100},
        {"c_low": 35.5, "c_high": 55.4, "aqi_low": 101, "aqi_high": 150},
        {"c_low": 55.5, "c_high": 125.4, "aqi_low": 151, "aqi_high": 200},
        {"c_low": 125.5, "c_high": 225.4, "aqi_low": 201, "aqi_high": 300},
        {"c_low": 225.5, "c_high": 325.4, "aqi_low": 301, "aqi_high": 500},
    ],
    "pm10": [
        # PM10 24-hour
        {"c_low": 0.0, "c_high": 54.0, "aqi_low": 0, "aqi_high": 50},
        {"c_low": 55.0, "c_high": 154.0, "aqi_low": 51, "aqi_high": 100},
        {"c_low": 155.0, "c_high": 254.0, "aqi_low": 101, "aqi_high": 150},
        {"c_low": 255.0, "c_high": 354.0, "aqi_low": 151, "aqi_high": 200},
        {"c_low": 355.0, "c_high": 424.0, "aqi_low": 201, "aqi_high": 300},
        {"c_low": 425.0, "c_high": 604.0, "aqi_low": 301, "aqi_high": 500},
    ],
    "ozone": [
        # Ozone 8-hour (ppm)
        {"c_low": 0.000, "c_high": 0.054, "aqi_low": 0, "aqi_high": 50},
        {"c_low": 0.055, "c_high": 0.070, "aqi_low": 51, "aqi_high": 100},
        {"c_low": 0.071, "c_high": 0.085, "aqi_low": 101, "aqi_high": 150},
        {"c_low": 0.086, "c_high": 0.105, "aqi_low": 151, "aqi_high": 200},
        {"c_low": 0.106, "c_high": 0.200, "aqi_low": 201, "aqi_high": 300},
    ],
    "no2": [
        # NO2 1-hour (ppb)
        {"c_low": 0.0, "c_high": 53.0, "aqi_low": 0, "aqi_high": 50},
        {"c_low": 54.0, "c_high": 100.0, "aqi_low": 51, "aqi_high": 100},
        {"c_low": 101.0, "c_high": 360.0, "aqi_low": 101, "aqi_high": 150},
        {"c_low": 361.0, "c_high": 649.0, "aqi_low": 151, "aqi_high": 200},
        {"c_low": 650.0, "c_high": 1249.0, "aqi_low": 201, "aqi_high": 300},
        {"c_low": 1250.0, "c_high": 2049.0, "aqi_low": 301, "aqi_high": 500},
    ],
    "co": [
        # CO 8-hour (ppm)
        {"c_low": 0.0, "c_high": 4.4, "aqi_low": 0, "aqi_high": 50},
        {"c_low": 4.5, "c_high": 9.4, "aqi_low": 51, "aqi_high": 100},
        {"c_low": 9.5, "c_high": 12.4, "aqi_low": 101, "aqi_high": 150},
        {"c_low": 12.5, "c_high": 15.4, "aqi_low": 151, "aqi_high": 200},
        {"c_low": 15.5, "c_high": 30.4, "aqi_low": 201, "aqi_high": 300},
        {"c_low": 30.5, "c_high": 50.4, "aqi_low": 301, "aqi_high": 500},
    ],
}

# ============================================================================
# URLs for Utah AQ endpoints
# ============================================================================
MOBILE_URL = "https://utahaq.chpc.utah.edu/jsondata/MobileMapData.json"
FIXED_URL = "https://utahaq.chpc.utah.edu/jsondata/FixedSiteMapData.json"

# ============================================================================
# Tram/Rail Line Override (synthetic line data for TRAX)
# ============================================================================
# When set, TRX vehicles will use this line graph instead of the road graph.
# Format: same as road graph (JSON with nodes/edges), but for tram/rail lines.
# Set via MOBILEAIR_TRAM_LINE_GRAPH environment variable or override here.
# Default: ~/.mobileair/roads/trax_lines_graph.json (built from GPS traces)
import os as _os
TRAM_LINE_GRAPH_PATH: str | None = _os.path.expanduser("~/.mobileair/roads/trax_lines_graph.json")

# ============================================================================
# HTTP Headers for requests
# ============================================================================
HEADERS = {
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Sec-Fetch-Site": "same-origin",
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Fetch-Mode": "cors",
    "Accept-Encoding": "gzip, deflate, br",
    "User-Agent": "DustyTrails-AQI-Dashboard (contact: matt@funstuff.app)",
    "Referer": "https://utahaq.chpc.utah.edu/",
    "Connection": "keep-alive",
    "Sec-Fetch-Dest": "empty",
    "X-Requested-With": "XMLHttpRequest",
}

# ============================================================================
# Database (SQLite) Tuning
# ============================================================================
DB_WRITE_BATCH_SIZE = 200          # Commit after this many queued writes
DB_WRITE_FLUSH_INTERVAL_S = 30.0   # Commit at least this often (seconds)
DB_READ_POOL_SIZE = 3              # Concurrent read-only connections
DB_WAL_CHECKPOINT_INTERVAL_S = 300 # Passive WAL checkpoint every 5 min

# Archival & retention
import os as _os_db
DB_RETENTION_DAYS = int(_os_db.environ.get("DUSTY_DB_RETENTION_DAYS", "30"))
DB_MAX_SIZE_MB = int(_os_db.environ.get("DUSTY_DB_MAX_SIZE_MB", "1024"))
DB_BACKUP_TARGET = _os_db.environ.get("DUSTY_BACKUP_TARGET", "")  # rsync dest
DB_PRUNE_BATCH_SIZE = 1000        # rows per DELETE batch (avoid long locks)
