#!/usr/bin/env python3
"""
MobileAir browser dashboard server.

Serves the browser dashboard UI and provides a JSON API for sensor state.
Implements a persistent state machine for mobile sensors with trail merging,
ghosting (offline detection), and cleanup of stale entries.

Also integrates AirNow hourly data for fixed EPA monitoring sites.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import ssl
import socket
import sys
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
from typing import Any
from datetime import datetime, timedelta


def _get_bundle_dir() -> Path:
    """Get the base directory for bundled resources (PyInstaller or normal)."""
    if getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS'):
        # Running as PyInstaller bundle
        return Path(sys._MEIPASS)
    # Running as normal Python script
    return Path(__file__).resolve().parent

# Import from the mobileair package
from mobileair import (
    parse_utc_timestamp,
    fetch_json_with_cache,
    normalize_state_for_dashboard,
    stdlib_get,
    MOBILE_URL,
    FIXED_URL,
    HEADERS,
)
from mobileair.dashboard import _pick_worst_reading_by_aqi

# Import AirNow data fetcher
try:
    from airnow_slc import (
        fetch_monitoring_sites as _fetch_monitoring_sites,
        fetch_hourly_data as _fetch_hourly_data,
        filter_utah_hourly as _filter_utah_hourly,
        get_hourly_data_url as _get_hourly_data_url,
        get_hourly_data_url_historical as _get_hourly_data_url_historical,
        list_available_hourly_files as _list_available_hourly_files,
        extract_wind_data as _extract_wind_data,
        FILES_BASE_URL,
        SLC_BOUNDS,
    )
    fetch_monitoring_sites = _fetch_monitoring_sites
    fetch_hourly_data = _fetch_hourly_data
    filter_utah_hourly = _filter_utah_hourly
    get_hourly_data_url = _get_hourly_data_url
    get_hourly_data_url_historical = _get_hourly_data_url_historical
    list_available_hourly_files = _list_available_hourly_files
    extract_wind_data = _extract_wind_data
    AIRNOW_AVAILABLE = True
except ImportError:
    AIRNOW_AVAILABLE = False
    FILES_BASE_URL = ""
    SLC_BOUNDS = {"lat_min": 0.0, "lat_max": 0.0, "lon_min": 0.0, "lon_max": 0.0}
    
    def fetch_monitoring_sites(url: str | None = None) -> list[dict]:
        return []
    
    def fetch_hourly_data(url: str) -> list[dict]:
        return []
    
    def extract_wind_data(readings: list[dict], sites=None) -> dict:
        return {}
    
    def filter_utah_hourly(readings: list[dict]) -> list[dict]:
        return []
    
    def get_hourly_data_url() -> str:
        return ""
    
    def get_hourly_data_url_historical(dt: datetime) -> str:
        return ""
    
    def list_available_hourly_files() -> list[str]:
        return []


# ─────────────────────────────────────────────────────────────────────────────
# JSON SANITIZATION & VALIDATION
# All external data must pass through these functions before touching app logic.
# ─────────────────────────────────────────────────────────────────────────────

# Maximum sizes to prevent DoS
MAX_SNAPSHOT_SIZE_BYTES = 50 * 1024 * 1024  # 50 MB
MAX_STRING_LENGTH = 10000  # Max length for any string value
MAX_RECURSION_DEPTH = 50  # Prevent stack overflow from deeply nested structures

# Patterns that might indicate prompt injection or other attacks
# These are checked AFTER JSON parsing to avoid regex-based exploits on raw input
_SUSPICIOUS_PATTERNS = [
    re.compile(r'<\s*script', re.IGNORECASE),
    re.compile(r'javascript\s*:', re.IGNORECASE),
    re.compile(r'on\w+\s*=', re.IGNORECASE),  # onclick=, onerror=, etc.
    re.compile(r'\{\{\s*.*\s*\}\}'),  # Template injection {{ }}
    re.compile(r'\$\{\s*.*\s*\}'),  # Template literals ${...}
    re.compile(r'<\s*iframe', re.IGNORECASE),
    re.compile(r'<\s*object', re.IGNORECASE),
    re.compile(r'<\s*embed', re.IGNORECASE),
    # Prompt injection patterns - match various orderings
    re.compile(r'ignore\s+.{0,20}(previous|prior|above|all|earlier)\s+.{0,10}instructions?', re.IGNORECASE),
    re.compile(r'disregard\s+.{0,20}(previous|prior|above|all|earlier)\s+.{0,10}instructions?', re.IGNORECASE),
    re.compile(r'forget\s+.{0,20}(previous|prior|above|all|earlier)\s+.{0,10}instructions?', re.IGNORECASE),
    re.compile(r'new\s+instructions?\s*:', re.IGNORECASE),
    re.compile(r'system\s*:\s*you\s+are', re.IGNORECASE),
    re.compile(r'<\s*/?\s*system\s*>', re.IGNORECASE),
    re.compile(r'\[\s*INST\s*\]', re.IGNORECASE),
    re.compile(r'\[\s*/\s*INST\s*\]', re.IGNORECASE),
    re.compile(r'<\|im_start\|>', re.IGNORECASE),
    re.compile(r'<\|im_end\|>', re.IGNORECASE),
]

class JsonValidationError(Exception):
    """Raised when JSON validation/sanitization fails."""
    pass


def _sanitize_string(s: str, max_length: int = MAX_STRING_LENGTH) -> str:
    """
    Sanitize a string value from JSON.
    - Truncates to max length
    - Checks for suspicious patterns and removes them
    - Strips control characters except common whitespace
    """
    if not isinstance(s, str):
        return str(s)[:max_length]
    
    # Truncate first to limit processing time
    if len(s) > max_length:
        s = s[:max_length]
    
    # Remove control characters except tab, newline, carriage return
    s = "".join(c for c in s if c >= ' ' or c in '\t\n\r')
    
    # Check for and neutralize suspicious patterns
    for pattern in _SUSPICIOUS_PATTERNS:
        if pattern.search(s):
            # Replace the suspicious content with a safe placeholder
            s = pattern.sub("[REMOVED]", s)
    
    return s


def _sanitize_value(value: Any, depth: int = 0) -> Any:
    """
    Recursively sanitize a JSON value.
    Only allows: None, bool, int, float, str, list, dict
    """
    if depth > MAX_RECURSION_DEPTH:
        raise JsonValidationError("JSON structure too deeply nested")
    
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        # Prevent huge integers that could cause issues
        if abs(value) > 10**15:
            return float(value)  # Convert to float for very large numbers
        return value
    if isinstance(value, float):
        # Handle inf/nan
        if not (-1e308 < value < 1e308):
            return None
        return value
    if isinstance(value, str):
        return _sanitize_string(value)
    if isinstance(value, list):
        return [_sanitize_value(item, depth + 1) for item in value]
    if isinstance(value, dict):
        return {
            _sanitize_string(str(k), max_length=200): _sanitize_value(v, depth + 1)
            for k, v in value.items()
        }
    
    # Unknown type - convert to string and sanitize
    return _sanitize_string(str(value))


def parse_and_sanitize_json(raw_bytes: bytes, max_size: int = MAX_SNAPSHOT_SIZE_BYTES) -> dict[str, Any]:
    """
    Parse raw bytes as JSON and sanitize the result.
    
    This is the ONLY function that should be used to parse external JSON.
    It validates syntax, size, and sanitizes all values before returning.
    
    Raises JsonValidationError if validation fails.
    """
    # Check size first (before any parsing)
    if len(raw_bytes) > max_size:
        raise JsonValidationError(f"JSON too large: {len(raw_bytes)} bytes (max {max_size})")
    
    # Validate it's valid UTF-8
    try:
        raw_str = raw_bytes.decode("utf-8")
    except UnicodeDecodeError as e:
        raise JsonValidationError(f"Invalid UTF-8 encoding: {e}")
    
    # Parse JSON (this validates syntax)
    try:
        parsed = json.loads(raw_str)
    except json.JSONDecodeError as e:
        raise JsonValidationError(f"Invalid JSON syntax: {e}")
    
    # Must be a dict at top level for our state format
    if not isinstance(parsed, dict):
        raise JsonValidationError(f"JSON root must be object, got {type(parsed).__name__}")
    
    # Sanitize all values recursively
    try:
        sanitized = _sanitize_value(parsed)
    except JsonValidationError:
        raise
    except Exception as e:
        raise JsonValidationError(f"Sanitization failed: {e}")
    
    return sanitized


def validate_state_schema(state: dict[str, Any]) -> dict[str, Any]:
    """
    Validate that a state dict has the expected schema for dashboard state.
    Returns the validated state or raises JsonValidationError.
    """
    if not isinstance(state, dict):
        raise JsonValidationError("State must be a dict")
    
    # Must have mobile and fixed arrays
    if "mobile" in state and not isinstance(state.get("mobile"), list):
        raise JsonValidationError("'mobile' must be an array")
    if "fixed" in state and not isinstance(state.get("fixed"), list):
        raise JsonValidationError("'fixed' must be an array")
    
    # Validate mobile entries have required fields
    for i, m in enumerate(state.get("mobile", [])):
        if not isinstance(m, dict):
            raise JsonValidationError(f"mobile[{i}] must be an object")
        # id is required
        if "id" not in m:
            raise JsonValidationError(f"mobile[{i}] missing 'id'")
    
    # Validate fixed entries have required fields
    for i, f in enumerate(state.get("fixed", [])):
        if not isinstance(f, dict):
            raise JsonValidationError(f"fixed[{i}] must be an object")
        if "id" not in f:
            raise JsonValidationError(f"fixed[{i}] missing 'id'")
    
    return state


def default_data_dir() -> Path:
    return Path(os.path.expanduser("~/.mobileair"))

def load_json_file(path: Path, default):
    try:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        pass
    return default

@dataclass
class AppState:
    lock: threading.Lock
    state: dict[str, Any]
    persistent_mobile: dict[str, dict[str, Any]]
    # Pre-serialized JSON bytes to prevent CPU spikes on every GET request.
    # Must be initialized from `state` so /api/state is valid immediately.
    cached_json_bytes: bytes = b"{}"
    
    # AirNow cached data
    airnow_sites: dict[str, dict[str, Any]] = field(default_factory=dict)  # site_id -> site metadata
    airnow_readings: dict[str, dict[str, Any]] = field(default_factory=dict)  # site_id -> latest readings
    airnow_last_fetch: float = 0.0
    airnow_readings_by_hour: dict[str, list[dict[str, Any]]] = field(default_factory=dict)  # hour_key -> readings
    
    # Wind/weather data from AirNow
    wind_data: dict[str, Any] = field(default_factory=dict)
    
    # Persistent fixed sensor history (shared with TUI)
    # Structure: { sensor_id: { pollutant: [{val, col, time, recorded_at}, ...] } }
    fixed_history: dict[str, dict[str, list[dict[str, Any]]]] = field(default_factory=dict)
    fixed_history_path: Path | None = None
    fixed_history_dirty: bool = False

    def __post_init__(self) -> None:
        try:
            self.cached_json_bytes = json.dumps(self.state).encode("utf-8")
        except Exception:
            self.cached_json_bytes = b"{}"


def load_fixed_history(app_state: AppState, data_dir: Path) -> None:
    """Load fixed sensor history from disk."""
    path = data_dir / "fixed_history.json"
    app_state.fixed_history_path = path
    app_state.fixed_history = load_json_file(path, {})
    if not isinstance(app_state.fixed_history, dict):
        app_state.fixed_history = {}


def save_fixed_history(app_state: AppState) -> None:
    """Save fixed sensor history to disk if dirty."""
    if not app_state.fixed_history_dirty or not app_state.fixed_history_path:
        return
    try:
        app_state.fixed_history_path.write_text(
            json.dumps(app_state.fixed_history), encoding="utf-8"
        )
        app_state.fixed_history_dirty = False
    except Exception as e:
        print(f"[FixedHistory] Failed to save: {e}")


def accumulate_fixed_reading(
    app_state: AppState,
    sensor_id: str,
    pollutant: str,
    value: Any,
    color: str,
    time_utc: str | None,
) -> None:
    """
    Accumulate a fixed sensor reading into history.
    Only appends if the value or time has changed from the last entry.
    """
    if sensor_id not in app_state.fixed_history:
        app_state.fixed_history[sensor_id] = {}
    if pollutant not in app_state.fixed_history[sensor_id]:
        app_state.fixed_history[sensor_id][pollutant] = []
    
    hist = app_state.fixed_history[sensor_id][pollutant]
    now_ts = time.time()
    
    # Dedupe: skip if same value and time as last entry
    if hist:
        last = hist[-1]
        if last.get("val") == str(value) and last.get("time") == time_utc:
            return
    
    # Append new reading
    hist.append({
        "val": str(value) if value is not None else None,
        "col": color,
        "time": time_utc,
        "recorded_at": now_ts,
    })
    
    # Keep last 100 entries (more than TUI's 50 for longer playback)
    if len(hist) > 100:
        app_state.fixed_history[sensor_id][pollutant] = hist[-100:]
    
    app_state.fixed_history_dirty = True


def _accumulate_fixed_history_from_raw(app_state: AppState, fixed_raw: dict[str, Any] | None) -> None:
    """Extract readings from raw Utah fixed sensor data and accumulate into history."""
    if not isinstance(fixed_raw, dict):
        return
    
    for pollutant_key, sensors in fixed_raw.items():
        if not isinstance(sensors, dict):
            continue
        for sensor_id, s_data in sensors.items():
            # Skip metadata keys
            if sensor_id in ("LastUpdateUTC", "LastUpdateLocal", "APITimeStart", "APITimeEnd", "VarName", "VarUnit"):
                continue
            if not isinstance(s_data, dict):
                continue
            
            value = s_data.get("Value")
            color = s_data.get("ValueColor", "#cccccc")
            time_utc = s_data.get("TimeUTC")
            
            if value is not None:
                accumulate_fixed_reading(app_state, sensor_id, str(pollutant_key), value, color, time_utc)


def _inject_fixed_history(app_state: AppState, st: dict[str, Any]) -> None:
    """Inject history arrays into fixed sensor readings from accumulated history."""
    fixed_list = st.get("fixed", [])
    if not isinstance(fixed_list, list):
        return
    
    for sensor in fixed_list:
        sensor_id = sensor.get("id")
        if not sensor_id:
            continue
        
        hist_for_sensor = app_state.fixed_history.get(sensor_id, {})
        if not hist_for_sensor:
            continue
        
        readings = sensor.get("readings", {})
        if not isinstance(readings, dict):
            continue
        
        for pollutant, reading in readings.items():
            if not isinstance(reading, dict):
                continue
            
            hist_entries = hist_for_sensor.get(pollutant, [])
            if not hist_entries:
                continue
            
            # Build history arrays
            history_values = []
            history_colors = []
            history_times = []
            
            for entry in hist_entries:
                val = entry.get("val")
                col = entry.get("col", "#cccccc")
                t = entry.get("time")
                
                # Try to parse value as float for consistency
                try:
                    history_values.append(float(val) if val is not None else None)
                except (ValueError, TypeError):
                    history_values.append(val)
                history_colors.append(col)
                history_times.append(t)
            
            reading["history"] = history_values
            reading["history_colors"] = history_colors
            reading["history_times"] = history_times


def build_state(
    *,
    data_dir: Path,
    mobile_json: dict[str, Any] | None,
    fixed_json: dict[str, Any] | None,
    max_points: int,
) -> dict[str, Any]:
    custom_names = load_json_file(data_dir / "sensor_names.json", {})
    pinned_list = load_json_file(data_dir / "pinned_sensors.json", [])
    pinned = set(pinned_list) if isinstance(pinned_list, list) else set()

    combined = {"mobile": mobile_json or {}, "fixed": fixed_json or {}}
    return normalize_state_for_dashboard(
        combined,
        custom_names=custom_names if isinstance(custom_names, dict) else {},
        pinned_sensors=pinned,
        max_points=max_points,
        mobile_url=MOBILE_URL,
        fixed_url=FIXED_URL,
        data_dir=str(data_dir),
    )


# ─────────────────────────────────────────────────────────────────────────────
# Historical data fetching (week-long timeseries from CHPC)
# ─────────────────────────────────────────────────────────────────────────────

HISTORY_BASE_URL = "https://utahaq.chpc.utah.edu/jsondata"
HISTORY_SENSORS = [
    "BUS01", "BUS02", "BUS03", "BUS04", "BUS05", "BUS06", "BUS07", "BUS08",
    "BUS09", "BUS10", "BUS11", "BUS12", "BUS13", "BUS14", "BUS15",
    "TRX01", "TRX02", "TRX03",
]
HISTORY_VARS = ["GLAT", "GLON", "PM25", "PM10", "OZNE"]

# In-memory cache for week-long history files (they change slowly)
# Key: (sensor, var), Value: (fetch_time, data)
_history_cache: dict[tuple[str, str], tuple[float, list]] = {}
_HISTORY_CACHE_TTL = 3600  # 1 hour


def _fetch_history_file(sensor: str, var: str) -> list:
    """Fetch a single history file with caching."""
    cache_key = (sensor, var)
    now = time.time()
    
    # Check cache
    if cache_key in _history_cache:
        fetch_time, data = _history_cache[cache_key]
        if now - fetch_time < _HISTORY_CACHE_TTL:
            return data
    
    # Fetch from server
    url = f"{HISTORY_BASE_URL}/{sensor}_{var}_TS_10080.json"
    try:
        resp = stdlib_get(url, timeout=30, headers=HEADERS)
        resp.raise_for_status()
        data = resp.json().get("TimeDataUTC", [])
        _history_cache[cache_key] = (now, data)
        return data
    except Exception:
        # On error, return stale cache if available, else empty
        if cache_key in _history_cache:
            return _history_cache[cache_key][1]
        return []


def fetch_historical_day(date_str: str) -> dict[str, Any]:
    """Fetch week-long data and filter to a specific day.
    
    Returns data in RAW API FORMAT so it can be processed by 
    normalize_state_for_dashboard like live data.
    
    Args:
        date_str: Date in YYYY-MM-DD format (UTC)
    
    Returns:
        Dict with 'mobile' in raw API format (same as MobileMapData.json)
    """
    from datetime import datetime, timezone, timedelta
    from concurrent.futures import ThreadPoolExecutor, as_completed
    
    # Parse date and compute day boundaries (UTC)
    try:
        day_start = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        raise ValueError(f"Invalid date format: {date_str}. Use YYYY-MM-DD.")
    
    day_end = day_start + timedelta(days=1)
    start_ms = int(day_start.timestamp() * 1000)
    end_ms = int(day_end.timestamp() * 1000)
    
    # Fetch data for all sensors in parallel (using cached week files)
    def fetch_sensor_var(sensor: str, var: str) -> tuple[str, str, list]:
        try:
            all_points = _fetch_history_file(sensor, var)
            # Filter to requested day
            points = [
                (ts, val) for ts, val in all_points
                if start_ms <= ts < end_ms
            ]
            return sensor, var, points
        except Exception:
            return sensor, var, []
    
    # Parallel fetch
    raw_data: dict[str, dict[str, list]] = {s: {} for s in HISTORY_SENSORS}
    with ThreadPoolExecutor(max_workers=20) as executor:
        futures = [
            executor.submit(fetch_sensor_var, sensor, var)
            for sensor in HISTORY_SENSORS
            for var in HISTORY_VARS
        ]
        for future in as_completed(futures):
            sensor, var, points = future.result()
            raw_data[sensor][var] = points
    
    # Build raw API format: {PM25: {sensor: {TimeUTC, GLAT, GLON, Value}}, PM10: {...}, OZNE: {...}}
    # This matches the format of MobileMapData.json so normalize_state_for_dashboard can process it
    
    last_update_str = day_end.strftime("%Y-%m-%d %H:%M UTC")
    
    mobile_raw: dict[str, Any] = {
        "PM25": {"LastUpdateUTC": last_update_str, "VarName": "PM2.5 Concentration", "VarUnit": "ug/m3"},
        "PM10": {"LastUpdateUTC": last_update_str, "VarName": "PM10 Concentration", "VarUnit": "ug/m3"},
        "OZNE": {"LastUpdateUTC": last_update_str, "VarName": "Ozone Concentration", "VarUnit": "ppbv"},
    }
    
    for sensor_id in HISTORY_SENSORS:
        sensor_data = raw_data[sensor_id]
        lat_pts = sensor_data.get("GLAT", [])
        lon_pts = sensor_data.get("GLON", [])
        pm25_pts = sensor_data.get("PM25", [])
        pm10_pts = sensor_data.get("PM10", [])
        ozne_pts = sensor_data.get("OZNE", [])
        
        if not lat_pts or not lon_pts:
            continue
        
        # Build arrays for each variable in API format
        lat_by_ts = {ts: val for ts, val in lat_pts if val is not None}
        lon_by_ts = {ts: val for ts, val in lon_pts if val is not None}
        
        # Use GPS timestamps as primary (they're most frequent)
        all_gps_times = sorted(set(lat_by_ts.keys()) & set(lon_by_ts.keys()))
        
        if not all_gps_times:
            continue
        
        # Convert timestamps to UTC strings
        def ts_to_utc(ts_ms):
            dt = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
            return dt.strftime("%Y-%m-%d %H:%M:%S UTC")
        
        # GPS data - format as strings to match live API format
        gps_times_utc = [ts_to_utc(ts) for ts in all_gps_times]
        gps_lats = [str(lat_by_ts[ts]) for ts in all_gps_times]
        gps_lons = [str(lon_by_ts[ts]) for ts in all_gps_times]
        
        def fmt_val(v):
            """Format value as string like live API does."""
            if v is None:
                return None
            return f"{v:.2f}"
        
        # Add sensor data for each pollutant using GPS timestamps
        # NOTE: We do NOT include ValueColor here - let normalize_state_for_dashboard
        # compute colors the same way it does for live data
        
        # PM25
        pm25_by_ts = {ts: val for ts, val in pm25_pts}
        pm25_vals = []
        last_pm25 = None
        for ts in all_gps_times:
            if ts in pm25_by_ts:
                last_pm25 = pm25_by_ts[ts]
            pm25_vals.append(fmt_val(last_pm25))
        
        mobile_raw["PM25"][sensor_id] = {
            "TimeUTC": gps_times_utc,
            "Latitude": gps_lats,
            "Longitude": gps_lons,
            "Value": pm25_vals,
        }
        
        # PM10
        pm10_by_ts = {ts: val for ts, val in pm10_pts}
        pm10_vals = []
        last_pm10 = None
        for ts in all_gps_times:
            if ts in pm10_by_ts:
                last_pm10 = pm10_by_ts[ts]
            pm10_vals.append(fmt_val(last_pm10))
        
        mobile_raw["PM10"][sensor_id] = {
            "TimeUTC": gps_times_utc,
            "Latitude": gps_lats,
            "Longitude": gps_lons,
            "Value": pm10_vals,
        }
        
        # OZNE - filter out negative values (bad sensor data)
        ozne_by_ts = {ts: val for ts, val in ozne_pts if val is None or val >= 0}
        ozne_vals = []
        last_ozne = None
        for ts in all_gps_times:
            if ts in ozne_by_ts:
                last_ozne = ozne_by_ts[ts]
            ozne_vals.append(fmt_val(last_ozne))
        
        mobile_raw["OZNE"][sensor_id] = {
            "TimeUTC": gps_times_utc,
            "Latitude": gps_lats,
            "Longitude": gps_lons,
            "Value": ozne_vals,
        }
    
    # Now process through normalize_state_for_dashboard like live data
    combined = {"mobile": mobile_raw, "fixed": {}}
    
    result = normalize_state_for_dashboard(
        combined,
        custom_names={},
        pinned_sensors=set(),
        max_points=5000,  # Allow more points for historical data
        mobile_url=MOBILE_URL,
        fixed_url=FIXED_URL,
        data_dir=str(default_data_dir()),
    )
    
    # Add historical metadata
    result["meta"]["historical"] = True
    result["meta"]["date"] = date_str
    
    return result


def _first_last_ts(trail: list[dict[str, Any]]) -> tuple[float | None, float | None]:
    """O(1) optimization: Avoids iterating thousands of points."""
    if not isinstance(trail, list) or not trail:
        return None, None
    
    def get_ms(point):
        if not isinstance(point, dict): return None
        ts = point.get("t")
        dt = parse_utc_timestamp(ts) if isinstance(ts, str) else None
        return float(dt.timestamp()) if dt else None

    return get_ms(trail[0]), get_ms(trail[-1])

def update_app_state_with_new_data(app_state: AppState, st: dict[str, Any], now: float | None = None) -> None:
    if now is None:
        now = time.time()

    meta = st.get("meta")
    if not isinstance(meta, dict):
        meta = {}
        st["meta"] = meta

    with app_state.lock:
        fresh_sids = set()
        for incoming_mobile in st.get("mobile", []):
            sid = incoming_mobile.get("id")
            if not sid:
                continue
            fresh_sids.add(sid)

            if sid not in app_state.persistent_mobile:
                app_state.persistent_mobile[sid] = incoming_mobile
                incoming_mobile["_last_seen"] = now
                incoming_mobile["_idle"] = bool(incoming_mobile.get("immobile"))
                incoming_mobile["_idle_breakout_hits"] = 0
                incoming_mobile["_idle_since_t"] = None
                incoming_mobile["_last_trail_ts"] = None

                if incoming_mobile["_idle"]:
                    trail0 = incoming_mobile.get("trail", [])
                    if isinstance(trail0, list) and trail0:
                        last_p = trail0[-1]
                        last_ts = last_p.get("t") if isinstance(last_p, dict) else None
                        incoming_mobile["_idle_since_t"] = last_ts
                        incoming_mobile["_last_trail_ts"] = last_ts
                        for p in trail0:
                            if isinstance(p, dict) and "m" not in p: p["m"] = 0
                else:
                    trail0 = incoming_mobile.get("trail", [])
                    if isinstance(trail0, list) and trail0:
                        last_p = trail0[-1]
                        last_ts = last_p.get("t") if isinstance(last_p, dict) else None
                        incoming_mobile["_last_trail_ts"] = last_ts
                        for p in trail0:
                            if isinstance(p, dict) and "m" not in p: p["m"] = 1
            else:
                pm = app_state.persistent_mobile[sid]
                old_trail = pm.get("trail", [])
                prev_idle = bool(pm.get("_idle"))
                idle_since_ts = pm.get("_idle_since_t")
                backend_idle = bool(incoming_mobile.get("immobile"))

                if backend_idle and not prev_idle:
                    prev_idle = True
                    trail_in = incoming_mobile.get("trail", [])
                    if isinstance(trail_in, list) and trail_in:
                        last_p = trail_in[-1]
                        idle_since_ts = last_p.get("t") if isinstance(last_p, dict) else None

                if prev_idle and not backend_idle:
                    prev_idle = False
                    idle_since_ts = None

                # Optimization: O(1) trail comparison logic
                old_f_ms, old_l_ms = _first_last_ts(old_trail)
                incoming_trail = incoming_mobile.get("trail", [])
                inc_f_ms, inc_l_ms = _first_last_ts(incoming_trail)

                replace_trail = False
                if incoming_trail:
                    if isinstance(old_trail, list) and old_trail:
                        if (inc_f_ms is not None and old_f_ms is not None and inc_f_ms <= old_f_ms
                            and inc_l_ms is not None and old_l_ms is not None and inc_l_ms >= old_l_ms):
                            replace_trail = True
                        elif len(incoming_trail) > len(old_trail) and inc_l_ms is not None and inc_l_ms >= (old_l_ms or 0):
                            replace_trail = True
                    else:
                        replace_trail = True

                pm.update(incoming_mobile)
                pm["trail"] = incoming_trail if replace_trail else old_trail
                
                if incoming_trail and not replace_trail:
                    # Merge only new points
                    _, last_old_ms = _first_last_ts(pm["trail"])
                    for np in incoming_trail:
                        nt_dt = parse_utc_timestamp(np.get("t"))
                        if last_old_ms and nt_dt and nt_dt.timestamp() <= last_old_ms:
                            continue
                        if "m" not in np: np["m"] = 1
                        pm["trail"].append(np)

                if len(pm["trail"]) > 5000:
                    pm["trail"] = pm["trail"][-5000:]

                pm["_last_seen"] = now
                pm["_idle"] = prev_idle
                pm["_idle_since_t"] = idle_since_ts
                pm["ghosted"] = False
                pm["_sticky_ghosted"] = False

        to_delete = [sid for sid, pm in app_state.persistent_mobile.items() if now - pm.get("_last_seen", 0) > 2700]
        for sid in to_delete: del app_state.persistent_mobile[sid]

        combined_mobile = []
        for sid, pm in app_state.persistent_mobile.items():
            if sid not in fresh_sids:
                pm["ghosted"] = True
                pm["_sticky_ghosted"] = True
            combined_mobile.append(pm)
        st["mobile"] = combined_mobile

        # Merge AirNow readings into fixed sensors
        if app_state.airnow_readings:
            _merge_airnow_into_fixed(st, app_state)

        prev_meta = app_state.state.get("meta", {}) if isinstance(app_state.state, dict) else {}
        if "server_start_ts" in prev_meta: meta["server_start_ts"] = prev_meta["server_start_ts"]

        # CPU Optimization: Bake JSON bytes once here
        app_state.state = st
        app_state.cached_json_bytes = json.dumps(st).encode("utf-8")


def _merge_airnow_into_fixed(st: dict[str, Any], app_state: AppState) -> None:
    """Merge AirNow hourly readings into fixed sensors or add new AirNow-only sensors."""
    fixed_list = st.get("fixed", [])
    if not isinstance(fixed_list, list):
        return
    
    # Get mobile data time range for filtering
    mobile_time_range = _get_mobile_time_range(st.get("mobile", []))
    
    # Build a lookup of existing fixed sensors by approximate location
    fixed_by_loc: dict[tuple[float, float], dict[str, Any]] = {}
    for fs in fixed_list:
        lat = fs.get("lat")
        lon = fs.get("lon")
        if lat is not None and lon is not None:
            # Round to ~100m precision for matching
            key = (round(lat, 3), round(lon, 3))
            fixed_by_loc[key] = fs
    
    # Track which AirNow sites we've added
    added_airnow_sites: set[str] = set()
    
    for site_id, readings in app_state.airnow_readings.items():
        if not readings:
            continue
        
        site_meta = app_state.airnow_sites.get(site_id, {})
        lat = site_meta.get("latitude")
        lon = site_meta.get("longitude")
        site_name = site_meta.get("site_name", site_id)
        
        if lat is None or lon is None:
            continue
        
        # Check if within SLC bounds
        if not (SLC_BOUNDS["lat_min"] <= lat <= SLC_BOUNDS["lat_max"] and
                SLC_BOUNDS["lon_min"] <= lon <= SLC_BOUNDS["lon_max"]):
            continue
        
        # Filter readings to mobile time range if available
        filtered_readings = readings
        if mobile_time_range:
            filtered_readings = _filter_readings_to_timerange(readings, mobile_time_range)
        
        if not filtered_readings:
            continue
        
        # Try to find matching existing fixed sensor
        key = (round(lat, 3), round(lon, 3))
        existing = fixed_by_loc.get(key)
        
        # Build readings dict from AirNow data with history
        airnow_readings_dict = _airnow_to_readings_dict(
            filtered_readings,
            site_id=site_id,
            app_state=app_state,
            time_range=mobile_time_range,
        )
        
        if existing:
            # Merge into existing sensor
            existing_readings = existing.get("readings", {})
            if not isinstance(existing_readings, dict):
                existing_readings = {}
            
            # Add AirNow readings that don't already exist
            for param, data in airnow_readings_dict.items():
                if param not in existing_readings:
                    existing_readings[param] = data
            
            existing["readings"] = existing_readings
            existing["airnow_source"] = True
        else:
            # Add as new AirNow-only sensor
            if site_id not in added_airnow_sites:
                added_airnow_sites.add(site_id)
                fixed_list.append({
                    "id": f"AIRNOW_{site_id}",
                    "name": site_name,
                    "pinned": False,
                    "emoji": "🏛️",  # Government/EPA marker
                    "lat": lat,
                    "lon": lon,
                    "readings": airnow_readings_dict,
                    "color": _pick_color_from_readings(airnow_readings_dict),
                    "airnow_source": True,
                    "primary_key": _pick_primary_key(airnow_readings_dict),
                    "primary_value": None,
                    "primary_color": _pick_color_from_readings(airnow_readings_dict),
                    "primary_aqi": None,
                })
    
    st["fixed"] = fixed_list
    
    # Add AirNow metadata
    meta = st.get("meta", {})
    meta["airnow_last_fetch"] = app_state.airnow_last_fetch
    meta["airnow_sites_count"] = len(app_state.airnow_sites)
    meta["airnow_readings_count"] = len(app_state.airnow_readings)


def _get_mobile_time_range(mobile_list: list[dict[str, Any]]) -> tuple[datetime, datetime] | None:
    """Get the time range covered by mobile sensor trails."""
    min_dt: datetime | None = None
    max_dt: datetime | None = None
    
    for m in mobile_list:
        trail = m.get("trail", [])
        if not isinstance(trail, list):
            continue
        for pt in trail:
            if not isinstance(pt, dict):
                continue
            ts = pt.get("t")
            if isinstance(ts, str):
                dt = parse_utc_timestamp(ts)
                if dt:
                    if min_dt is None or dt < min_dt:
                        min_dt = dt
                    if max_dt is None or dt > max_dt:
                        max_dt = dt
    
    if min_dt and max_dt:
        return (min_dt, max_dt)
    return None


def _filter_readings_to_timerange(
    readings: dict[str, Any],
    time_range: tuple[datetime, datetime]
) -> dict[str, Any]:
    """Filter readings to only include data within the time range."""
    # For now, just return all readings since AirNow hourly data is already
    # fetched based on available hours. Future enhancement could filter by
    # individual reading timestamps.
    return readings


# Map AirNow parameter names to dashboard keys
AIRNOW_PARAM_MAP = {
    "PM2.5": "PM25",
    "PM10": "PM10",
    "OZONE": "OZNE",
    "O3": "OZNE",
    "NO2": "NO2",
    "CO": "CO",
    "SO2": "SO2",
}


def _build_airnow_history(
    site_id: str,
    app_state: AppState,
    time_range: tuple[datetime, datetime] | None = None,
) -> dict[str, dict[str, Any]]:
    """
    Build historical readings for an AirNow site from cached hourly data.
    
    Returns a dict of parameter -> {value, color, history, history_colors}
    matching the format used by Utah fixed sensors.
    """
    result: dict[str, dict[str, Any]] = {}
    
    # Collect all readings for this site across all cached hours
    # Structure: param -> [(datetime, value), ...]
    param_history: dict[str, list[tuple[datetime, float]]] = {}
    
    for hour_key in sorted(app_state.airnow_readings_by_hour.keys()):
        readings = app_state.airnow_readings_by_hour[hour_key]
        for r in readings:
            if r.get("site_id") != site_id:
                continue
            
            dt = r.get("datetime")
            if not isinstance(dt, datetime):
                continue
            
            # Filter to time range if specified
            if time_range:
                # Expand range by 1 hour on each end for context
                range_start = time_range[0] - timedelta(hours=1)
                range_end = time_range[1] + timedelta(hours=1)
                if not (range_start <= dt <= range_end):
                    continue
            
            param = r.get("parameter")
            value = r.get("value")
            if param and value is not None:
                if param not in param_history:
                    param_history[param] = []
                param_history[param].append((dt, float(value)))
    
    # Build readings dict with history arrays
    for param, history_list in param_history.items():
        # Sort by time
        history_list.sort(key=lambda x: x[0])
        
        # Get mapped parameter name
        mapped_key = AIRNOW_PARAM_MAP.get(param, param)
        
        # Extract values, times, and compute colors
        history_values = [v for dt, v in history_list]
        history_times = [dt.isoformat() + "Z" for dt, v in history_list]  # UTC ISO strings
        history_colors = [_get_aqi_color(mapped_key, v) for v in history_values]
        
        # Latest value
        if history_values:
            latest_value = history_values[-1]
            latest_color = history_colors[-1]
        else:
            continue
        
        result[mapped_key] = {
            "value": latest_value,
            "color": latest_color,
            "history": history_values,
            "history_times": history_times,  # UTC timestamps for playback interpolation
            "history_colors": history_colors,
            "scrubbed": 0,  # No outlier filtering for AirNow data (already QC'd)
        }
    
    return result


def _airnow_to_readings_dict(
    readings: dict[str, Any],
    site_id: str | None = None,
    app_state: AppState | None = None,
    time_range: tuple[datetime, datetime] | None = None,
) -> dict[str, dict[str, Any]]:
    """
    Convert AirNow readings dict to dashboard readings format.
    
    If site_id and app_state are provided, builds full history arrays
    from cached hourly data. Otherwise, just returns current values.
    """
    # If we have app_state, build proper history
    if site_id and app_state:
        result = _build_airnow_history(site_id, app_state, time_range)
        if result:
            return result
    
    # Fallback: just current values (no history)
    result = {}
    for param, value in readings.items():
        if param in ("datetime", "time", "date", "site_id", "site_name", "unit", "agency"):
            continue
        
        mapped_key = AIRNOW_PARAM_MAP.get(param, param)
        color = _get_aqi_color(mapped_key, value)
        
        result[mapped_key] = {
            "value": value,
            "color": color,
        }
    
    return result


def _get_aqi_color(pollutant: str, value: Any) -> str:
    """Get AQI color for a pollutant value."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return "#cccccc"
    
    # Simplified AQI breakpoints for coloring
    if pollutant in ("PM25", "PM2.5"):
        if v <= 12.0: return "#00E400"  # Good
        if v <= 35.4: return "#FFFF00"  # Moderate
        if v <= 55.4: return "#FF7E00"  # USG
        if v <= 150.4: return "#FF0000"  # Unhealthy
        if v <= 250.4: return "#8F3F97"  # Very Unhealthy
        return "#7E0023"  # Hazardous
    elif pollutant in ("PM10",):
        if v <= 54: return "#00E400"
        if v <= 154: return "#FFFF00"
        if v <= 254: return "#FF7E00"
        if v <= 354: return "#FF0000"
        if v <= 424: return "#8F3F97"
        return "#7E0023"
    elif pollutant in ("OZNE", "OZONE", "O3"):
        # ppb values
        if v <= 54: return "#00E400"
        if v <= 70: return "#FFFF00"
        if v <= 85: return "#FF7E00"
        if v <= 105: return "#FF0000"
        if v <= 200: return "#8F3F97"
        return "#7E0023"
    
    return "#cccccc"


def _pick_color_from_readings(readings: dict[str, dict[str, Any]]) -> str:
    """Pick the primary color from readings."""
    priority = ["PM25", "PM2.5", "PM10", "OZNE"]
    for k in priority:
        if k in readings and isinstance(readings[k], dict):
            return readings[k].get("color", "#3388ff")
    for v in readings.values():
        if isinstance(v, dict):
            return v.get("color", "#3388ff")
    return "#3388ff"


def _pick_primary_key(readings: dict[str, dict[str, Any]]) -> str | None:
    """Pick the primary pollutant key."""
    priority = ["PM25", "PM2.5", "PM10", "OZNE"]
    for k in priority:
        if k in readings:
            return k
    return next(iter(readings.keys()), None)


def fetch_loop(*, app_state: AppState, data_dir: Path, interval_s: float, stop_event: threading.Event) -> None:
    revision = 0
    print(f"[FetchLoop] Starting with interval={interval_s}s", flush=True)
    while not stop_event.is_set():
        attempt_ts = time.time()
        try:
            print(f"[FetchLoop] Fetching data...", flush=True)
            mobile = fetch_json_with_cache(MOBILE_URL, headers=HEADERS, timeout=10, request_get=stdlib_get)
            fixed_raw = fetch_json_with_cache(FIXED_URL, headers=HEADERS, timeout=10, request_get=stdlib_get)

            # Accumulate fixed sensor history from raw data
            _accumulate_fixed_history_from_raw(app_state, fixed_raw)

            st = build_state(data_dir=data_dir, mobile_json=mobile, fixed_json=fixed_raw, max_points=5000)
            
            # Inject history arrays into fixed sensors
            _inject_fixed_history(app_state, st)
            
            revision += 1
            meta = st.setdefault("meta", {})
            meta.update({"last_fetch_attempt_ts": attempt_ts, "last_fetch_ok_ts": attempt_ts, "server_revision": revision})
            update_app_state_with_new_data(app_state, st)
            print(f"[FetchLoop] Revision {revision} updated", flush=True)
            
            # Periodically save history
            if revision % 10 == 0:
                save_fixed_history(app_state)
        except Exception as e:
            print(f"[FetchLoop] Error: {type(e).__name__}: {e}", flush=True)
            with app_state.lock:
                st = app_state.state if isinstance(app_state.state, dict) else {"ts": time.time(), "mobile": [], "fixed": [], "meta": {}}
                meta = st.setdefault("meta", {})
                meta["last_fetch_error"] = f"{type(e).__name__}: {e}"
                app_state.state = st
        stop_event.wait(interval_s)


def airnow_fetch_loop(
    *,
    app_state: AppState,
    interval_s: float = 1200.0,  # 20 minutes
    stop_event: threading.Event
) -> None:
    """Background loop to fetch AirNow hourly data every 20 minutes."""
    if not AIRNOW_AVAILABLE:
        return
    
    # Initial delay to let main fetch loop populate mobile data first
    stop_event.wait(5.0)
    
    while not stop_event.is_set():
        try:
            _fetch_airnow_data(app_state)
        except Exception as e:
            print(f"[AirNow] Fetch error: {type(e).__name__}: {e}")
        
        stop_event.wait(interval_s)


def _fetch_airnow_data(app_state: AppState) -> None:
    """Fetch AirNow site metadata and hourly readings."""
    now = time.time()
    
    # Fetch site metadata (once, or refresh occasionally)
    with app_state.lock:
        sites_empty = not app_state.airnow_sites
    
    if sites_empty:
        try:
            print("[AirNow] Fetching site metadata...")
            all_sites = fetch_monitoring_sites()
            
            # Filter to SLC-area sites and build lookup
            sites_by_id: dict[str, dict[str, Any]] = {}
            for s in all_sites:
                lat = s.get("latitude")
                lon = s.get("longitude")
                if lat is None or lon is None:
                    continue
                if (SLC_BOUNDS["lat_min"] <= lat <= SLC_BOUNDS["lat_max"] and
                    SLC_BOUNDS["lon_min"] <= lon <= SLC_BOUNDS["lon_max"]):
                    site_id = s.get("aqsid", "")
                    if site_id and site_id not in sites_by_id:
                        sites_by_id[site_id] = s
            
            with app_state.lock:
                app_state.airnow_sites = sites_by_id
            
            print(f"[AirNow] Loaded {len(sites_by_id)} SLC-area sites")
        except Exception as e:
            print(f"[AirNow] Error fetching sites: {e}")
    
    # Determine which hours to fetch based on mobile data time range
    with app_state.lock:
        mobile_list = app_state.state.get("mobile", []) if isinstance(app_state.state, dict) else []
    
    time_range = _get_mobile_time_range(mobile_list)
    
    # Fetch hourly data
    try:
        # Try to get the most recent available hourly file
        available_files = list_available_hourly_files()
        
        hours_to_fetch: list[str] = []
        
        if time_range:
            # Calculate hours within mobile data range
            start_dt, end_dt = time_range
            # Extend a bit to ensure coverage
            start_dt = start_dt - timedelta(hours=1)
            
            current = start_dt.replace(minute=0, second=0, microsecond=0)
            while current <= end_dt:
                hour_key = current.strftime("%Y%m%d%H")
                hours_to_fetch.append(hour_key)
                current += timedelta(hours=1)
            
            # Limit to last 24 hours to avoid too many requests
            hours_to_fetch = hours_to_fetch[-24:]
        else:
            # No mobile data yet, just get recent hours
            if available_files:
                # Get last 3 available files
                hours_to_fetch = [f.replace("HourlyData_", "").replace(".dat", "") 
                                  for f in available_files[-3:]]
        
        if not hours_to_fetch:
            print("[AirNow] No hours to fetch")
            return
        
        # Fetch hourly data for each hour
        all_readings: dict[str, dict[str, Any]] = {}
        
        for hour_key in hours_to_fetch:
            cache_key = hour_key
            
            # Check if already cached
            with app_state.lock:
                if cache_key in app_state.airnow_readings_by_hour:
                    # Use cached data
                    for r in app_state.airnow_readings_by_hour[cache_key]:
                        site_id = r.get("site_id", "")
                        if site_id:
                            if site_id not in all_readings:
                                all_readings[site_id] = {}
                            param = r.get("parameter", "")
                            val = r.get("value")
                            if param and val is not None:
                                all_readings[site_id][param] = val
                    continue
            
            # Fetch from server
            try:
                # Determine URL - try today's folder first, then archive
                dt = datetime.strptime(hour_key, "%Y%m%d%H")
                today = datetime.now().strftime("%Y%m%d")
                
                if hour_key.startswith(today):
                    url = f"{FILES_BASE_URL}/today/HourlyData_{hour_key}.dat"
                else:
                    url = get_hourly_data_url_historical(dt)
                
                readings = fetch_hourly_data(url)
                utah_readings = filter_utah_hourly(readings)
                
                # Cache the readings
                with app_state.lock:
                    app_state.airnow_readings_by_hour[cache_key] = utah_readings
                
                # Aggregate by site
                for r in utah_readings:
                    site_id = r.get("site_id", "")
                    if site_id:
                        if site_id not in all_readings:
                            all_readings[site_id] = {}
                        param = r.get("parameter", "")
                        val = r.get("value")
                        if param and val is not None:
                            all_readings[site_id][param] = val
                        
                        # Also accumulate into persistent history
                        dt = r.get("datetime")
                        time_str = dt.strftime("%Y-%m-%d %H:%M:%S UTC") if dt else None
                        sensor_key = f"AIRNOW_{site_id}"
                        accumulate_fixed_reading(
                            app_state, sensor_key, param, val,
                            _get_aqi_color(param, val), time_str
                        )
                
            except Exception as e:
                # File might not exist yet, that's OK
                pass
        
        # Update app state with aggregated readings
        with app_state.lock:
            app_state.airnow_readings = all_readings
            app_state.airnow_last_fetch = now
            
            # Clean up old cached hours (keep last 48)
            if len(app_state.airnow_readings_by_hour) > 48:
                sorted_keys = sorted(app_state.airnow_readings_by_hour.keys())
                for k in sorted_keys[:-48]:
                    del app_state.airnow_readings_by_hour[k]
        
        print(f"[AirNow] Updated {len(all_readings)} sites with hourly data")
        
        # Extract wind data from the most recent hour
        try:
            with app_state.lock:
                sorted_hours = sorted(app_state.airnow_readings_by_hour.keys())
            if sorted_hours:
                latest_hour = sorted_hours[-1]
                with app_state.lock:
                    latest_readings = app_state.airnow_readings_by_hour.get(latest_hour, [])
                wind_data = extract_wind_data(latest_readings)
                with app_state.lock:
                    app_state.wind_data = wind_data
                if wind_data.get("wind_speed") is not None:
                    print(f"[AirNow] Wind: {wind_data.get('wind_speed_mph', 0):.1f} mph from {wind_data.get('wind_dir_cardinal', '?')} (gust level {wind_data.get('gust_level', 0)})")
        except Exception as e:
            print(f"[AirNow] Wind extraction error: {e}")
        
        # Trigger a state rebuild to merge new data
        with app_state.lock:
            if app_state.airnow_readings and isinstance(app_state.state, dict):
                _merge_airnow_into_fixed(app_state.state, app_state)
                # Include wind data in state
                app_state.state["wind"] = app_state.wind_data
                app_state.cached_json_bytes = json.dumps(app_state.state).encode("utf-8")
        
        # Save accumulated history
        save_fixed_history(app_state)
        
    except Exception as e:
        print(f"[AirNow] Error fetching hourly data: {e}")


def apply_sensor_names_inplace(state: dict[str, Any], custom_names: dict[str, Any]) -> bool:
    if not isinstance(state, dict) or not isinstance(custom_names, dict): return False
    changed = False
    for key in ("mobile", "fixed"):
        for it in state.get(key, []):
            sid = it.get("id")
            new_name = custom_names.get(sid) or ""
            if it.get("name") != new_name:
                it["name"] = new_name
                changed = True
    return changed

def watch_sensor_names_loop(*, app_state: AppState, data_dir: Path, stop_event: threading.Event) -> None:
    path = data_dir / "sensor_names.json"
    last_mtime = None
    while not stop_event.is_set():
        try:
            if path.exists():
                mtime = path.stat().st_mtime
                if last_mtime is None or mtime > last_mtime + 1e-6:
                    last_mtime = mtime
                    custom_names = load_json_file(path, {})
                    with app_state.lock:
                        if apply_sensor_names_inplace(app_state.state, custom_names):
                            app_state.cached_json_bytes = json.dumps(app_state.state).encode("utf-8")
        except Exception: pass
        stop_event.wait(5.0)

def _get_snapshots_dir(data_dir: Path) -> Path:
    """Return the directory for saved snapshots."""
    snapshots_dir = data_dir / "snapshots"
    snapshots_dir.mkdir(parents=True, exist_ok=True)
    return snapshots_dir

def list_snapshots(data_dir: Path) -> list[dict[str, Any]]:
    """List all saved snapshots with metadata."""
    snapshots_dir = _get_snapshots_dir(data_dir)
    result = []
    for f in sorted(snapshots_dir.glob("*.json"), reverse=True):
        try:
            stat = f.stat()
            # Extract date from filename (e.g., "2025-12-31.json" -> "2025-12-31")
            date_str = f.stem
            result.append({
                "date": date_str,
                "filename": f.name,
                "size_bytes": stat.st_size,
                "modified": datetime.fromtimestamp(stat.st_mtime).isoformat() + "Z",
            })
        except Exception:
            pass
    return result

def save_snapshot(data_dir: Path, date_str: str, state: dict[str, Any]) -> dict[str, Any]:
    """Save current state as a snapshot for the given date.
    
    The state is validated before saving to ensure we don't persist bad data.
    """
    # Validate the state has the expected structure before saving
    try:
        validate_state_schema(state)
    except JsonValidationError as e:
        raise ValueError(f"Invalid state to save: {e}")
    
    # Ensure there's actually data to save
    mobile_count = len(state.get("mobile", []))
    fixed_count = len(state.get("fixed", []))
    if mobile_count == 0 and fixed_count == 0:
        raise ValueError("Cannot save empty state (no mobile or fixed sensors)")
    
    snapshots_dir = _get_snapshots_dir(data_dir)
    # Sanitize date string for filename - only allow YYYY-MM-DD format chars
    safe_date = "".join(c for c in date_str if c.isalnum() or c == "-")
    if not safe_date or len(safe_date) > 20:
        safe_date = datetime.now().strftime("%Y-%m-%d")
    filepath = snapshots_dir / f"{safe_date}.json"
    filepath.write_text(json.dumps(state, separators=(",", ":")), encoding="utf-8")
    return {"success": True, "filename": filepath.name, "size_bytes": filepath.stat().st_size}

def load_snapshot(data_dir: Path, date_str: str) -> dict[str, Any] | None:
    """Load a saved snapshot by date.
    
    The loaded data is fully validated and sanitized before returning.
    This is a security boundary - untrusted file content is made safe here.
    """
    snapshots_dir = _get_snapshots_dir(data_dir)
    safe_date = "".join(c for c in date_str if c.isalnum() or c == "-")
    if not safe_date or len(safe_date) > 20:
        return None
    filepath = snapshots_dir / f"{safe_date}.json"
    if not filepath.exists():
        return None
    
    # Check file size before reading
    file_size = filepath.stat().st_size
    if file_size > MAX_SNAPSHOT_SIZE_BYTES:
        raise JsonValidationError(f"Snapshot file too large: {file_size} bytes")
    
    # Read raw bytes and sanitize (never parse without sanitization)
    raw_bytes = filepath.read_bytes()
    sanitized = parse_and_sanitize_json(raw_bytes, max_size=MAX_SNAPSHOT_SIZE_BYTES)
    
    # Validate schema
    validate_state_schema(sanitized)
    
    return sanitized

def make_handler(*, app_state: AppState, static_dir: Path, data_dir: Path):
    class Handler(BaseHTTPRequestHandler):
        # Disable keep-alive to avoid Safari/iOS hanging on connections
        protocol_version = "HTTP/1.1"
        
        def log_message(self, format, *args):
            # Suppress default logging to avoid cluttering output
            pass
        
        def handle_one_request(self):
            """Override to handle broken pipe errors gracefully (Safari can drop connections)."""
            try:
                super().handle_one_request()
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                # Client closed connection prematurely - this is normal for Safari preflight
                pass
            except ssl.SSLError:
                # TLS handshake failed - common with untrusted certs
                pass
        
        def _send(self, code: int, body: bytes, content_type: str):
            try:
                self.send_response(code)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store, max-age=0")
                # Connection: close helps Safari/iOS release connections properly
                self.send_header("Connection", "close")
                # Allow cross-origin requests (useful for dev/testing)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                # Client disconnected while we were sending - ignore
                pass

        def do_GET(self):
            if self.path in ("/", "/index.html"):
                return self._send(200, (static_dir / "index.html").read_bytes(), "text/html")
            if self.path == "/app.js":
                return self._send(200, (static_dir / "app.js").read_bytes(), "text/javascript")
            if self.path == "/map_nav_engine.js":
                return self._send(200, (static_dir / "map_nav_engine.js").read_bytes(), "text/javascript")
            if self.path == "/styles.css":
                return self._send(200, (static_dir / "styles.css").read_bytes(), "text/css")
            if self.path == "/manifest.json":
                # Generate manifest dynamically with explicit http:// URL for PWA
                host_header = self.headers.get("Host", "localhost:8765")
                base_url = f"http://{host_header}"
                manifest = {
                    "name": "MobileAir Dashboard",
                    "short_name": "MobileAir",
                    "description": "Real-time air quality monitoring dashboard for Utah mobile and fixed sensors",
                    "start_url": base_url + "/",
                    "scope": base_url + "/",
                    "display": "standalone",
                    "background_color": "#0b0f14",
                    "theme_color": "#111826",
                    "orientation": "any",
                    "icons": [
                        {"src": base_url + "/icon-192.png", "sizes": "192x192", "type": "image/png"},
                        {"src": base_url + "/icon-512.png", "sizes": "512x512", "type": "image/png"},
                        {"src": base_url + "/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"}
                    ]
                }
                return self._send(200, json.dumps(manifest).encode(), "application/manifest+json")
            if self.path == "/icon.svg":
                return self._send(200, (static_dir / "icon.svg").read_bytes(), "image/svg+xml")
            if self.path.startswith("/icon-") and self.path.endswith(".png"):
                fname = self.path.lstrip("/")
                fpath = static_dir / fname
                if fpath.exists():
                    return self._send(200, fpath.read_bytes(), "image/png")
            if self.path == "/tui.html":
                return self._send(200, (static_dir / "tui.html").read_bytes(), "text/html")
            if self.path == "/tui.css":
                return self._send(200, (static_dir / "tui.css").read_bytes(), "text/css")
            if self.path == "/tui.js":
                return self._send(200, (static_dir / "tui.js").read_bytes(), "text/javascript")
            if self.path.startswith("/api/state"):
                with app_state.lock:
                    return self._send(200, app_state.cached_json_bytes, "application/json")
            if self.path.startswith("/api/tui"):
                return self._handle_tui_state()
            if self.path.startswith("/api/history"):
                return self._handle_history_request()
            if self.path.startswith("/api/snapshots"):
                return self._handle_list_snapshots()
            if self.path.startswith("/api/snapshot/load"):
                return self._handle_load_snapshot()
            return self._send(404, b"not found", "text/plain")

        def do_POST(self):
            if self.path.startswith("/api/snapshot/save"):
                return self._handle_save_snapshot()
            return self._send(404, b"not found", "text/plain")

        def _handle_tui_state(self):
            """Return state formatted for TUI rendering (shared format for terminal and web)."""
            from mobileair.tui_format import format_tui_state
            with app_state.lock:
                state = json.loads(app_state.cached_json_bytes.decode("utf-8"))
            tui_state = format_tui_state(state)
            body = json.dumps(tui_state).encode("utf-8")
            return self._send(200, body, "application/json")

        def _handle_list_snapshots(self):
            """List all saved snapshots."""
            try:
                snapshots = list_snapshots(data_dir)
                body = json.dumps({"snapshots": snapshots}).encode("utf-8")
                return self._send(200, body, "application/json")
            except Exception as e:
                body = json.dumps({"error": str(e)}).encode("utf-8")
                return self._send(500, body, "application/json")

        def _handle_save_snapshot(self):
            """Save POSTed state as a snapshot."""
            from urllib.parse import urlparse, parse_qs
            query = parse_qs(urlparse(self.path).query)
            date_str = query.get("date", [None])[0]
            
            if not date_str:
                # Default to today's date
                date_str = datetime.now().strftime("%Y-%m-%d")
            
            try:
                # Read POSTed body
                content_length = int(self.headers.get("Content-Length", 0))
                if content_length > MAX_SNAPSHOT_SIZE_BYTES:
                    return self._send(413, b'{"error": "Request too large"}', "application/json")
                
                if content_length > 0:
                    # Client sent state data - parse and sanitize it
                    raw_body = self.rfile.read(content_length)
                    state_to_save = parse_and_sanitize_json(raw_body, max_size=MAX_SNAPSHOT_SIZE_BYTES)
                else:
                    # No body - save current live state (legacy behavior)
                    with app_state.lock:
                        state_to_save = json.loads(app_state.cached_json_bytes.decode("utf-8"))
                
                result = save_snapshot(data_dir, date_str, state_to_save)
                body = json.dumps(result).encode("utf-8")
                return self._send(200, body, "application/json")
            except JsonValidationError as e:
                body = json.dumps({"error": f"Invalid data: {e}"}).encode("utf-8")
                return self._send(400, body, "application/json")
            except Exception as e:
                body = json.dumps({"error": str(e)}).encode("utf-8")
                return self._send(500, body, "application/json")

        def _handle_load_snapshot(self):
            """Load a saved snapshot by date."""
            from urllib.parse import urlparse, parse_qs
            query = parse_qs(urlparse(self.path).query)
            date_str = query.get("date", [None])[0]
            
            if not date_str:
                return self._send(400, b'{"error": "date parameter required"}', "application/json")
            
            try:
                state = load_snapshot(data_dir, date_str)
                if state is None:
                    return self._send(404, b'{"error": "snapshot not found"}', "application/json")
                body = json.dumps(state).encode("utf-8")
                return self._send(200, body, "application/json")
            except Exception as e:
                body = json.dumps({"error": str(e)}).encode("utf-8")
                return self._send(500, body, "application/json")

        def _handle_history_request(self):
            """Fetch week-long historical data for all sensors for a specific date."""
            from urllib.parse import urlparse, parse_qs
            query = parse_qs(urlparse(self.path).query)
            date_str = query.get("date", [None])[0]  # e.g. "2025-12-29"
            
            if not date_str:
                return self._send(400, b'{"error": "date parameter required"}', "application/json")
            
            try:
                result = fetch_historical_day(date_str)
                body = json.dumps(result).encode("utf-8")
                return self._send(200, body, "application/json")
            except Exception as e:
                body = json.dumps({"error": str(e)}).encode("utf-8")
                return self._send(500, body, "application/json")

        def log_message(self, format, *args):
            return

    return Handler


def _guess_lan_ips() -> list[str]:
    """Best-effort list of LAN-reachable IPs for showing a usable URL.

    This does not change networking; it only inspects local interfaces.
    """
    ips: list[str] = []

    # Primary outbound interface (no packets are sent; connect() picks a route).
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("1.1.1.1", 80))
            ip = s.getsockname()[0]
            if ip and ip not in ips:
                ips.append(ip)
        finally:
            s.close()
    except Exception:
        pass

    # Enumerate all local addresses as a fallback.
    try:
        host = socket.gethostname()
        for family, _, _, _, sockaddr in socket.getaddrinfo(host, None):
            if family != socket.AF_INET:
                continue
            ip = str(sockaddr[0])
            if not ip or ip.startswith("127."):
                continue
            if ip not in ips:
                ips.append(ip)
    except Exception:
        pass

    return ips

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--https", action="store_true")
    parser.add_argument("--cert", default="")
    parser.add_argument("--key", default="")
    parser.add_argument("--interval", type=float, default=60.0)
    args = parser.parse_args()

    data_dir = default_data_dir()
    data_dir.mkdir(parents=True, exist_ok=True)
    static_dir = _get_bundle_dir() / "dashboard"

    app_state = AppState(
        lock=threading.Lock(),
        state={"ts": time.time(), "mobile": [], "fixed": [], "meta": {"server_start_ts": time.time()}},
        persistent_mobile={},
    )
    
    # Load persistent fixed sensor history
    load_fixed_history(app_state, data_dir)
    print(f"[FixedHistory] Loaded {len(app_state.fixed_history)} sensors from history")
    
    stop_event = threading.Event()

    threading.Thread(target=fetch_loop, kwargs=dict(app_state=app_state, data_dir=data_dir, interval_s=args.interval, stop_event=stop_event), daemon=True).start()
    threading.Thread(target=watch_sensor_names_loop, kwargs=dict(app_state=app_state, data_dir=data_dir, stop_event=stop_event), daemon=True).start()
    
    # Start AirNow hourly data fetch loop (20-minute interval)
    if AIRNOW_AVAILABLE:
        threading.Thread(
            target=airnow_fetch_loop,
            kwargs=dict(app_state=app_state, interval_s=1200.0, stop_event=stop_event),
            daemon=True
        ).start()
        print("[AirNow] Hourly data integration enabled (20-min refresh)")
    else:
        print("[AirNow] Integration not available (airnow_slc.py not found)")

    httpd = ThreadingHTTPServer((args.host, args.port), make_handler(app_state=app_state, static_dir=static_dir, data_dir=data_dir))
    # Timeout for individual requests - helps with Safari/iOS connection issues
    httpd.timeout = 30
    if args.https:
        cert_path = Path(args.cert) if args.cert else (data_dir / "dev-cert.pem")
        key_path = Path(args.key) if args.key else (data_dir / "dev-key.pem")
        if not (cert_path.exists() and key_path.exists()):
            # Generate self-signed cert with SAN for local dev (Safari requires SAN)
            lan_ips = _guess_lan_ips()
            san_entries = ["DNS:localhost", "DNS:mobileair.local"]
            san_entries.extend(f"IP:{ip}" for ip in lan_ips[:10])
            san_entries.append("IP:127.0.0.1")
            san_str = ",".join(san_entries)
            subprocess.run([
                "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                "-days", "365",
                "-keyout", str(key_path),
                "-out", str(cert_path),
                "-subj", "/CN=MobileAir Dev",
                "-addext", f"subjectAltName={san_str}",
            ], check=True)
            print(f"Generated dev certificate with SANs: {san_str}")
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(certfile=str(cert_path), keyfile=str(key_path))
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)

    # print(f"Server optimized. Dashboard: {'https' if args.https else 'http'}://{args.host}:{args.port}")
    scheme = "https" if args.https else "http"
    print(f"Server optimized. Dashboard listening on {args.host}:{args.port} ({scheme})")
    ips = _guess_lan_ips()
    if args.host in ("0.0.0.0", "::"):
        for ip in ips[:5]:
            print(f"Open: {scheme}://{ip}:{args.port}/")
    elif args.host and args.host not in ("127.0.0.1", "localhost"):
        print(f"Open: {scheme}://{args.host}:{args.port}/")
    if args.https:
        print(f"Note: On iOS/macOS, trust the cert at: Settings > General > About > Certificate Trust Settings")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt: pass
    finally:
        stop_event.set()
        httpd.shutdown()
    return 0


def start_server_in_thread(host: str = "0.0.0.0", port: int = 8766, interval: float = 60.0) -> tuple[threading.Event, threading.Thread]:
    """Start the dashboard server in a background thread.
    
    Returns (stop_event, server_thread) so the caller can stop it later.
    Used when running as a bundled executable where subprocess isn't available.
    """
    data_dir = default_data_dir()
    data_dir.mkdir(parents=True, exist_ok=True)
    static_dir = _get_bundle_dir() / "dashboard"

    app_state = AppState(
        lock=threading.Lock(),
        state={"ts": time.time(), "mobile": [], "fixed": [], "meta": {"server_start_ts": time.time()}},
        persistent_mobile={},
    )
    
    load_fixed_history(app_state, data_dir)
    
    stop_event = threading.Event()

    threading.Thread(target=fetch_loop, kwargs=dict(app_state=app_state, data_dir=data_dir, interval_s=interval, stop_event=stop_event), daemon=True).start()
    threading.Thread(target=watch_sensor_names_loop, kwargs=dict(app_state=app_state, data_dir=data_dir, stop_event=stop_event), daemon=True).start()
    
    if AIRNOW_AVAILABLE:
        threading.Thread(
            target=airnow_fetch_loop,
            kwargs=dict(app_state=app_state, interval_s=1200.0, stop_event=stop_event),
            daemon=True
        ).start()

    httpd = ThreadingHTTPServer((host, port), make_handler(app_state=app_state, static_dir=static_dir, data_dir=data_dir))
    # Timeout for individual requests - helps with Safari/iOS connection issues
    httpd.timeout = 30
    
    def serve():
        try:
            httpd.serve_forever()
        except Exception:
            pass
        finally:
            stop_event.set()
    
    server_thread = threading.Thread(target=serve, daemon=True)
    server_thread.start()
    
    return stop_event, httpd


if __name__ == "__main__":
    main()