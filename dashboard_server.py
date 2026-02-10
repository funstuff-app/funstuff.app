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
import math
import os
import re
import ssl
import socket
import sys
import signal
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
from typing import Any
from datetime import datetime, timedelta, timezone


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
    default_cache_path,
    normalize_state_for_dashboard,
    stdlib_get,
    coerce_float,
    MOBILE_URL,
    FIXED_URL,
    HEADERS,
)
from mobileair.dashboard import _pick_worst_reading_by_aqi
from mobileair.trails import clean_trail

# Optional offline road map-matching (see ROAD_DATA.md)
from mobileair.roads import RoadGraph, match_trail_segment_offline

# Module-level road graph cache (shared across historical and live data)
_cached_road_graph: RoadGraph | None = None
_road_graph_load_attempted: bool = False

# Tram line graph override for TRAX (synthetic line data)
# When provided, TRX vehicles will snap to this graph instead of road graph.
# Set via MOBILEAIR_TRAM_LINE_GRAPH env var or mobileair.config.TRAM_LINE_GRAPH_PATH.
_cached_tram_line_graph: RoadGraph | None = None
_tram_line_graph_load_attempted: bool = False


def get_cached_tram_line_graph() -> RoadGraph | None:
    """Get the cached tram line graph for TRAX vehicles.
    
    Returns None if no tram line graph is configured or can't be loaded.
    Uses same format as road graph (RoadGraph class).
    """
    global _cached_tram_line_graph, _tram_line_graph_load_attempted
    
    if _tram_line_graph_load_attempted:
        return _cached_tram_line_graph
    
    _tram_line_graph_load_attempted = True
    try:
        from mobileair.config import TRAM_LINE_GRAPH_PATH
        p = os.environ.get("MOBILEAIR_TRAM_LINE_GRAPH") or TRAM_LINE_GRAPH_PATH
        if p and os.path.exists(p):
            _cached_tram_line_graph = RoadGraph.load(p)
    except Exception:
        _cached_tram_line_graph = None
    
    return _cached_tram_line_graph

# When running in-process (bundled TUI mode), suppress stdout to avoid
# interfering with Textual's alternate screen mode.
_quiet_mode: bool = False


def _log(msg: str) -> None:
    """Print a log message unless running in quiet mode (in-process with TUI)."""
    if not _quiet_mode:
        print(msg, flush=True)


def get_cached_road_graph() -> RoadGraph | None:
    """Get the cached road graph, loading it if needed.
    
    Returns None if the graph file doesn't exist or can't be loaded.
    """
    global _cached_road_graph, _road_graph_load_attempted
    
    if _road_graph_load_attempted:
        return _cached_road_graph
    
    _road_graph_load_attempted = True
    try:
        p = os.environ.get("MOBILEAIR_ROAD_GRAPH") or RoadGraph.default_graph_path()
        if os.path.exists(p):
            _cached_road_graph = RoadGraph.load(p)
    except Exception:
        _cached_road_graph = None
    
    return _cached_road_graph

# Import AirNow data fetcher
try:
    from airnow_slc import (
        fetch_monitoring_sites as _fetch_monitoring_sites,
        fetch_hourly_data as _fetch_hourly_data,
        filter_utah_hourly as _filter_utah_hourly,
        filter_slc_hourly as _filter_slc_hourly,
        get_slc_site_ids as _get_slc_site_ids,
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
    filter_slc_hourly = _filter_slc_hourly
    get_slc_site_ids = _get_slc_site_ids
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
    
    def filter_slc_hourly(readings: list[dict], site_ids=None) -> list[dict]:
        return []
    
    def get_slc_site_ids(sites: list[dict]) -> set[str]:
        return set()
    
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
    
    # Raw Utah AQ data (for TUI remote mode)
    raw_mobile: dict[str, Any] = field(default_factory=dict)
    raw_fixed: dict[str, Any] = field(default_factory=dict)
    
    # AirNow cached data
    airnow_sites: dict[str, dict[str, Any]] = field(default_factory=dict)  # site_id -> site metadata
    airnow_readings: dict[str, dict[str, Any]] = field(default_factory=dict)  # site_id -> latest readings
    airnow_last_fetch: float = 0.0
    airnow_readings_by_hour: dict[str, list[dict[str, Any]]] = field(default_factory=dict)  # hour_key -> readings
    
    # Wind/weather data from AirNow
    wind_data: dict[str, Any] = field(default_factory=dict)

    # PurpleAir cached data
    purpleair_sensors: list[dict[str, Any]] = field(default_factory=list)
    purpleair_last_fetch: float = 0.0

    # Optional offline road graph cache for map-matching.
    road_graph: Any | None = None
    
    # Persistent fixed sensor history (shared with TUI)
    # Structure: { sensor_id: { pollutant: [{val, col, time, recorded_at}, ...] } }
    fixed_history: dict[str, dict[str, list[dict[str, Any]]]] = field(default_factory=dict)
    fixed_history_path: Path | None = None
    fixed_history_dirty: bool = False

    # Cached fixed sensor locations so offline sensors can still be rendered.
    # Structure: { sensor_id: { "lat": float, "lon": float, "name": str } }
    fixed_sensor_locations: dict[str, dict[str, Any]] = field(default_factory=dict)

    # Bumped on-demand (e.g., from the TUI) to force the web client to treat the
    # next /api/state poll as a "new data" event even if timestamps/trails are unchanged.
    force_refresh_seq: int = 0

    # Server-authoritative "since last update" window for mobile trail timestamps.
    # Values are epoch milliseconds (UTC).
    last_mobile_max_ms: int | None = None
    trail_update_start_ms: int | None = None
    trail_update_end_ms: int | None = None

    def __post_init__(self) -> None:
        try:
            self.cached_json_bytes = json.dumps(self.state).encode("utf-8")
        except Exception:
            self.cached_json_bytes = b"{}"


def bump_force_refresh_seq(app_state: AppState) -> int:
    """Bump the server-side force-refresh sequence.

    This is consumed by the web dashboard client to treat the next poll as a
    "new data" event (e.g., re-run LIVE camera fit/zoom) even if timestamps
    and trails are unchanged.

    Important: This function is safe to call from a signal handler; it does not
    acquire locks or serialize JSON. The next /api/state request will sync
    cached JSON bytes under the normal lock.
    """
    try:
        app_state.force_refresh_seq = int(getattr(app_state, "force_refresh_seq", 0) or 0) + 1
    except Exception:
        try:
            app_state.force_refresh_seq = 1
        except Exception:
            pass
    return int(getattr(app_state, "force_refresh_seq", 0) or 0)


def _ensure_force_refresh_seq_cached(app_state: AppState) -> None:
    """Ensure cached JSON reflects app_state.force_refresh_seq (and related meta).

    Must be called under app_state.lock.
    """
    st = app_state.state if isinstance(app_state.state, dict) else {"ts": time.time(), "mobile": [], "fixed": [], "meta": {}}
    meta = st.get("meta")
    if not isinstance(meta, dict):
        meta = {}
        st["meta"] = meta

    seq = int(getattr(app_state, "force_refresh_seq", 0) or 0)
    dirty = False
    if int(meta.get("force_refresh_seq") or 0) != seq:
        meta["force_refresh_seq"] = seq
        dirty = True

    # Always include server-authoritative trail update window when known.
    s_ms = getattr(app_state, "trail_update_start_ms", None)
    e_ms = getattr(app_state, "trail_update_end_ms", None)
    if s_ms is not None and int(meta.get("trail_update_start_ms") or 0) != int(s_ms):
        meta["trail_update_start_ms"] = int(s_ms)
        dirty = True
    if e_ms is not None and int(meta.get("trail_update_end_ms") or 0) != int(e_ms):
        meta["trail_update_end_ms"] = int(e_ms)
        dirty = True

    if dirty:
        st["meta"] = meta
        app_state.state = st
        try:
            app_state.cached_json_bytes = json.dumps(st).encode("utf-8")
        except Exception:
            pass


# Skip known weather/meteorological parameters — everything else passes through
_WEATHER_KEYS = {"BARPR", "DEWPOINT", "TEMP", "WD", "WS", "RHUM", "SOLAR", "PRECIP", "CEIL", "VSBY", "BC_LC", "BC_DC"}


def load_fixed_history(app_state: AppState, data_dir: Path) -> None:
    """Load fixed sensor history from disk."""
    path = data_dir / "fixed_history.json"
    app_state.fixed_history_path = path
    app_state.fixed_history = load_json_file(path, {})
    if not isinstance(app_state.fixed_history, dict):
        app_state.fixed_history = {}
    # Purge any weather/met keys that were persisted before filtering was added
    for sensor_id in list(app_state.fixed_history):
        pols = app_state.fixed_history[sensor_id]
        if isinstance(pols, dict):
            for wk in _WEATHER_KEYS:
                pols.pop(wk, None)


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
        _log(f"[FixedHistory] Failed to save: {e}")


def load_today_snapshot(app_state: AppState, data_dir: Path) -> bool:
    """Load today's saved snapshot and seed persistent_mobile state.
    
    This enables seamless continuity when the server restarts: the saved trail
    data is merged with incoming live data instead of starting from scratch.
    
    Returns True if snapshot was loaded, False otherwise (fails silently).
    """
    today_str = datetime.now().strftime("%Y-%m-%d")
    try:
        snapshot = load_snapshot(data_dir, today_str)
        if snapshot is None:
            return False
        
        mobiles = snapshot.get("mobile", [])
        if not isinstance(mobiles, list) or not mobiles:
            return False
        
        now = time.time()
        loaded_count = 0
        
        with app_state.lock:
            for m in mobiles:
                sid = m.get("id")
                if not sid:
                    continue
                
                # Only load if not already present in persistent_mobile
                if sid in app_state.persistent_mobile:
                    continue
                
                # Initialize the mobile entry from snapshot
                trail = m.get("trail", [])
                if not isinstance(trail, list):
                    trail = []
                
                # Ensure trail points have movement markers
                for p in trail:
                    if isinstance(p, dict) and "m" not in p:
                        p["m"] = 1  # Assume moving for historical data
                
                # Get last trail timestamp
                last_ts = None
                if trail:
                    last_p = trail[-1]
                    last_ts = last_p.get("t") if isinstance(last_p, dict) else None
                
                # Set up persistent mobile state
                m["_last_seen"] = now
                m["_idle"] = bool(m.get("immobile"))
                m["_idle_breakout_hits"] = 0
                m["_idle_since_t"] = last_ts if m.get("_idle") else None
                m["_last_trail_ts"] = last_ts
                m["trail"] = trail
                
                # Mark as ghosted initially - live data will clear this if sensor is online
                m["ghosted"] = True
                m["_sticky_ghosted"] = True
                m["_from_snapshot"] = True  # Mark origin for debugging
                
                app_state.persistent_mobile[sid] = m
                loaded_count += 1
        
        if loaded_count > 0:
            _log(f"[Snapshot] Loaded {loaded_count} mobiles from today's snapshot ({today_str})")
        return loaded_count > 0
        
    except Exception as e:
        # Fail silently - this is optional persistence
        _log(f"[Snapshot] Could not load today's snapshot: {e}")
        return False


def save_today_snapshot(app_state: AppState, data_dir: Path) -> bool:
    """Save current state as today's snapshot.
    
    Called on graceful shutdown to persist the accumulated trail data.
    Returns True if saved successfully, False otherwise.
    """
    today_str = datetime.now().strftime("%Y-%m-%d")
    try:
        with app_state.lock:
            # Build state from persistent_mobile
            state_bytes = app_state.cached_json_bytes
            if not state_bytes:
                return False
            state = json.loads(state_bytes.decode("utf-8"))
        
        # Validate there's something worth saving
        mobiles = state.get("mobile", [])
        if not isinstance(mobiles, list) or not mobiles:
            _log("[Snapshot] Nothing to save (no mobile sensors)")
            return False
        
        # Check if we have any trails worth saving
        total_points = sum(len(m.get("trail", [])) for m in mobiles if isinstance(m, dict))
        if total_points < 10:
            _log("[Snapshot] Not enough data to save (fewer than 10 trail points)")
            return False
        
        result = save_snapshot(data_dir, today_str, state)
        _log(f"[Snapshot] Saved today's state: {result.get('filename')} ({result.get('size_bytes')} bytes)")
        return True
        
    except Exception as e:
        _log(f"[Snapshot] Failed to save today's snapshot: {e}")
        return False


def _scrub_broken_mobile_sensors(
    mobiles: list[dict[str, Any]],
    *,
    min_peers: int = 3,
    ratio_thresh: float = 8.0,
    abs_floor: dict[str, float] | None = None,
) -> set[str]:
    """Detect mobile sensors with hardware-broken readings and remove them.

    A sensor is considered broken only when *uncorrelated* pollutants are all
    wildly elevated vs peers.  Specifically, ozone (O3) is a secondary
    photochemical pollutant — it is NOT emitted by local particle sources like
    freight trains, construction, or dust.  So:

    - PM25 + PM10 high, OZNE normal → legitimate local particle source.  Keep.
    - OZNE high alone → also broken (ozone doesn't spike from local sources).  Remove.
    - PM + OZNE all wildly elevated → hardware is broken.  Remove.

    Removes broken sensors from *mobiles* in-place.
    Returns the set of sensor IDs that were removed.
    """
    if abs_floor is None:
        abs_floor = {"PM25": 50.0, "PM10": 100.0, "OZNE": 100.0}

    _POLLUTANTS = ("PM25", "PM10", "OZNE")
    _PARTICLE_KEYS = ("PM25", "PM10")

    # 1. Collect per-pollutant values from non-ghosted sensors
    per_poll: dict[str, list[tuple[str, float]]] = {k: [] for k in _POLLUTANTS}
    for m in mobiles:
        if not isinstance(m, dict) or m.get("ghosted"):
            continue
        sid = m.get("id")
        readings = m.get("readings")
        if not isinstance(readings, dict) or not sid:
            continue
        for pk in _POLLUTANTS:
            r = readings.get(pk)
            if not isinstance(r, dict):
                continue
            v = r.get("value")
            if v is None:
                continue
            try:
                fv = float(v)
                if fv >= 0 and math.isfinite(fv):
                    per_poll[pk].append((sid, fv))
            except (TypeError, ValueError):
                pass

    # 2. Per-pollutant: compute median and identify which sensors are flagged
    flagged_polls: dict[str, set[str]] = {k: set() for k in _POLLUTANTS}
    flagged_details: dict[str, list[str]] = {}
    for pk, entries in per_poll.items():
        if len(entries) < (min_peers + 1):
            continue
        vals_only = sorted(v for _, v in entries)
        n = len(vals_only)
        med = vals_only[n // 2] if n % 2 else (vals_only[n // 2 - 1] + vals_only[n // 2]) / 2.0
        floor = abs_floor.get(pk, 100.0)
        for sid, fv in entries:
            if med > 0 and fv > med * ratio_thresh and fv >= floor:
                flagged_polls[pk].add(sid)
                flagged_details.setdefault(sid, []).append(
                    f"{pk}: {fv:.1f} vs median {med:.1f}"
                )
            elif med <= 0 and fv >= floor * ratio_thresh:
                flagged_polls[pk].add(sid)
                flagged_details.setdefault(sid, []).append(
                    f"{pk}: {fv:.1f} vs median {med:.1f}"
                )

    # 3. Ozone is a secondary photochemical pollutant — it cannot spike from
    #    any local emission source.  If OZNE is wildly elevated, the sensor
    #    is broken regardless of what PM is doing.  If only PM is elevated
    #    and OZNE is normal, that's a real local source (train, dust, etc.).
    broken = flagged_polls.get("OZNE", set()).copy()

    # 4. Remove broken sensors from the list entirely
    if broken:
        for sid in broken:
            details = flagged_details.get(sid, [])
            _log(f"[Outlier] Removing broken mobile sensor {sid}: {'; '.join(details)}")
        mobiles[:] = [m for m in mobiles if m.get("id") not in broken]

    return broken


def _clamp_impossible_values(data: dict[str, Any] | None) -> dict[str, Any] | None:
    """NULL out impossible sensor values at the source.
    
    Modifies data in-place, setting values outside plausible ranges to None:
    - PM2.5: 0-999 ug/m3
    - PM10: 0-2000 ug/m3  
    - OZNE: 0-600 ppb
    """
    if not isinstance(data, dict):
        return data
    
    bounds = {"PM25": (0.0, 999.0), "PM10": (0.0, 2000.0), "OZNE": (0.0, 600.0)}
    
    for pollutant, (lo, hi) in bounds.items():
        section = data.get(pollutant)
        if not isinstance(section, dict):
            continue
        for sensor_id, sensor_data in section.items():
            if sensor_id in ("LastUpdateUTC", "LastUpdateLocal", "VarName", "VarUnit"):
                continue
            if not isinstance(sensor_data, dict):
                continue
            vals = sensor_data.get("Value")
            if isinstance(vals, list):
                def nullify(v):
                    if v is None:
                        return None
                    try:
                        fv = float(v)
                        return v if lo <= fv <= hi else None
                    except (ValueError, TypeError):
                        return v
                sensor_data["Value"] = [nullify(v) for v in vals]
            elif vals is not None:
                try:
                    fv = float(vals)
                    if fv < lo or fv > hi:
                        sensor_data["Value"] = None
                except (ValueError, TypeError):
                    pass
    return data


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
    
    # Keep history based on sensor type:
    # - Home sensor: 5760 entries (~48 hours at 30-second intervals) to span today + yesterday
    # - Utah sensors: 2880 entries (~24 hours at 5-10 min intervals spans days anyway)
    max_entries = 5760 if sensor_id == "Home" else 2880
    if len(hist) > max_entries:
        app_state.fixed_history[sensor_id][pollutant] = hist[-max_entries:]
    
    app_state.fixed_history_dirty = True


def _accumulate_fixed_history_from_raw(app_state: AppState, fixed_raw: dict[str, Any] | None) -> None:
    """Extract readings from raw Utah fixed sensor data and accumulate into history."""
    if not isinstance(fixed_raw, dict):
        return
    
    for pollutant_key, sensors in fixed_raw.items():
        if str(pollutant_key) in _WEATHER_KEYS:
            continue
        if not isinstance(sensors, dict):
            continue
        for sensor_id, s_data in sensors.items():
            # Skip metadata keys
            if sensor_id in ("LastUpdateUTC", "LastUpdateLocal", "APITimeStart", "APITimeEnd", "VarName", "VarUnit"):
                continue
            if not isinstance(s_data, dict):
                continue
            
            # Cache sensor location so we can reconstruct offline sensors
            lat_f = coerce_float(s_data.get("Latitude"))
            lon_f = coerce_float(s_data.get("Longitude"))
            if lat_f is not None and lon_f is not None:
                app_state.fixed_sensor_locations[sensor_id] = {
                    "lat": lat_f, "lon": lon_f, "name": "",
                }
            
            value = s_data.get("Value")
            color = _get_aqi_color(str(pollutant_key), value)
            time_utc = s_data.get("TimeUTC")
            
            if value is not None:
                accumulate_fixed_reading(app_state, sensor_id, str(pollutant_key), value, color, time_utc)


def _accumulate_home_sensor_reading(app_state: AppState, st: dict[str, Any]) -> None:
    """Accumulate the home sensor reading into history (same as other fixed sensors)."""
    fixed_list = st.get("fixed", [])
    if not isinstance(fixed_list, list):
        return
    
    for sensor in fixed_list:
        if sensor.get("id") != "Home":
            continue
        
        readings = sensor.get("readings", {})
        if not isinstance(readings, dict):
            return
        
        pm25 = readings.get("PM25", {})
        if not isinstance(pm25, dict):
            return
        
        value = pm25.get("value")
        # Always recompute color from value (don't trust stored color)
        color = _get_aqi_color("PM25", value) if value is not None else "#cccccc"
        time_utc = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        
        if value is not None:
            accumulate_fixed_reading(app_state, "Home", "PM25", value, color, time_utc)
        return


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
            if pollutant in _WEATHER_KEYS:
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
                t = entry.get("time")
                
                # Parse value; preserve integer-ness (e.g. Home sensor reports ints)
                try:
                    fval = float(val) if val is not None else None
                    if fval is not None and fval == int(fval):
                        fval = int(fval)
                except (ValueError, TypeError):
                    fval = None
                history_values.append(fval)
                # Recompute color from value (stored colors may be stale)
                history_colors.append(_get_aqi_color(pollutant, fval) if fval is not None else "#cccccc")
                history_times.append(t)
            
            reading["history"] = history_values
            reading["history_colors"] = history_colors
            reading["history_times"] = history_times


def _reinject_offline_fixed_sensors(app_state: AppState, st: dict[str, Any]) -> None:
    """Re-inject fixed sensors that have accumulated history but are missing from the live API.

    When an upstream sensor goes offline (maintenance, etc.), its raw data disappears
    from FixedSiteMapData.json.  We still have its history in ``fixed_history`` and its
    location in ``fixed_sensor_locations``, so we can keep showing it with its last-known
    readings and full sparkline history.
    """
    fixed_list = st.get("fixed", [])
    if not isinstance(fixed_list, list):
        fixed_list = []
        st["fixed"] = fixed_list

    already_present = {f.get("id") for f in fixed_list if isinstance(f, dict)}

    for sensor_id, pollutants in app_state.fixed_history.items():
        # Skip sensors already in the live state, Home, PurpleAir
        if sensor_id in already_present:
            continue
        if sensor_id == "Home" or sensor_id.startswith("PA_"):
            continue
        # Skip AirNow-derived sensors — the AirNow merge recreates them each poll
        if sensor_id.startswith("AIRNOW_"):
            continue
            continue
        if not isinstance(pollutants, dict) or not pollutants:
            continue

        # Need a cached location to render
        loc = app_state.fixed_sensor_locations.get(sensor_id)
        if not loc:
            continue
        lat = coerce_float(loc.get("lat"))
        lon = coerce_float(loc.get("lon"))
        if lat is None or lon is None:
            continue

        # Build readings from history (use most recent value per pollutant)
        readings: dict[str, Any] = {}
        for pollutant, hist_entries in pollutants.items():
            if not hist_entries:
                continue
            if pollutant in _WEATHER_KEYS:
                continue
            history_values = []
            history_colors = []
            history_times = []
            for entry in hist_entries:
                v = entry.get("val")
                try:
                    fv = float(v) if v is not None else None
                    if fv is not None and fv == int(fv):
                        fv = int(fv)
                except (TypeError, ValueError):
                    fv = None
                history_values.append(fv)
                history_colors.append(_get_aqi_color(pollutant, fv) if fv is not None else "#cccccc")
                history_times.append(entry.get("time"))
            last_val = history_values[-1] if history_values else None
            last_col = _get_aqi_color(pollutant, last_val) if last_val is not None else "#cccccc"
            display_val = last_val
            if display_val is not None:
                try:
                    if float(display_val) == int(float(display_val)):
                        display_val = int(float(display_val))
                except (ValueError, TypeError):
                    pass
            readings[pollutant] = {
                "value": display_val, "color": last_col,
                "history": history_values, "history_colors": history_colors,
                "history_times": history_times,
            }

        if not readings:
            continue

        worst = _pick_worst_reading_by_aqi(readings)
        name = loc.get("name") or ""
        fixed_list.append({
            "id": sensor_id, "name": name, "pinned": False, "emoji": "📍",
            "lat": lat, "lon": lon,
            "readings": readings,
            "color": worst.get("color") or "#cccccc",
            "primary_key": worst.get("key"),
            "primary_value": worst.get("value"),
            "primary_color": worst.get("color"),
            "primary_aqi": worst.get("aqi"),
            "offline": True,  # marker for UI: sensor is offline from upstream
        })


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
        road_graph=get_cached_road_graph(),
        tram_line_graph=get_cached_tram_line_graph(),
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

# Track when history server was last known to be down (for fast-fail)
_history_server_down_until = 0.0


def _is_history_server_reachable() -> bool:
    """Quick check if history server is reachable (2s timeout)."""
    global _history_server_down_until
    now = time.time()
    
    # If we recently determined server is down, fast-fail
    if now < _history_server_down_until:
        return False
    
    # HEAD request to a known file (lightweight, no body download)
    import urllib.request
    test_url = f"{HISTORY_BASE_URL}/BUS06_GLAT_TS_10080.json"
    try:
        req = urllib.request.Request(test_url, method='HEAD')
        req.add_header("User-Agent", "MobileAir/1.0")
        urllib.request.urlopen(req, timeout=2)
        return True
    except Exception:
        _history_server_down_until = now + 60
        return False


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
        resp = stdlib_get(url, timeout=3, headers=HEADERS)
        resp.raise_for_status()
        data = resp.json().get("TimeDataUTC", [])
        _history_cache[cache_key] = (now, data)
        return data
    except Exception as e:
        _log(f"[History] Failed to fetch {sensor}/{var}: {e}")
        # On error, return stale cache if available, else empty
        if cache_key in _history_cache:
            return _history_cache[cache_key][1]
        return []


def _get_history_cache_dir(data_dir: Path) -> Path:
    """Return the directory for cached historical day results."""
    cache_dir = data_dir / "history_cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir


def _load_cached_historical_day(data_dir: Path, date_str: str) -> dict[str, Any] | None:
    """Load a cached historical day result from disk. Returns None if not cached."""
    cache_dir = _get_history_cache_dir(data_dir)
    safe_date = "".join(c for c in date_str if c.isalnum() or c == "-")
    if not safe_date or len(safe_date) > 20:
        return None
    cache_file = cache_dir / f"{safe_date}.json"
    if not cache_file.exists():
        return None
    try:
        data = json.loads(cache_file.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("mobile"), list):
            return data
    except Exception as e:
        _log(f"[History] Failed to load cache for {date_str}: {e}")
    return None


def _save_cached_historical_day(data_dir: Path, date_str: str, result: dict[str, Any]) -> None:
    """Save a processed historical day result to disk cache."""
    cache_dir = _get_history_cache_dir(data_dir)
    safe_date = "".join(c for c in date_str if c.isalnum() or c == "-")
    if not safe_date or len(safe_date) > 20:
        return
    cache_file = cache_dir / f"{safe_date}.json"
    try:
        cache_file.write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")
        _log(f"[History] Cached day {date_str} ({cache_file.stat().st_size} bytes)")
    except Exception as e:
        _log(f"[History] Failed to cache {date_str}: {e}")


def _apply_fixed_sensors_to_history(result: dict[str, Any], date_str: str,
                                     app_state: AppState | None, data_dir: Path) -> None:
    """Add Home + DEQ + PurpleAir fixed sensors to a historical day result.
    
    Called both for freshly-fetched days and for disk-cached days.
    Reconstructs fixed sensors from fixed_history (which accumulates over time)
    and saved snapshots, so cached mobile-only results still get fixed sensors.
    """
    if "fixed" not in result:
        result["fixed"] = []
    
    # Remove any stale fixed entries so we rebuild fresh
    existing_fixed_ids = {f.get("id") for f in result["fixed"] if not f.get("purpleair") and f.get("id") != "Home"}
    result["fixed"] = [f for f in result["fixed"] if f.get("id") not in {"Home"} and not f.get("purpleair")]
    
    # ── Home sensor ──
    home_entry = None
    if app_state:
        home_hist = app_state.fixed_history.get("Home", {}).get("PM25", [])
        if home_hist:
            filtered_hist = [
                e for e in home_hist
                if e.get("time") and e["time"].startswith(date_str)
            ]
            if filtered_hist:
                history_values = []
                history_colors = []
                history_times = []
                for entry in filtered_hist:
                    val = entry.get("val")
                    try:
                        fval = float(val) if val is not None else None
                        if fval is not None and fval == int(fval):
                            fval = int(fval)
                    except (ValueError, TypeError):
                        fval = None
                    history_values.append(fval)
                    history_colors.append(_get_aqi_color("PM25", fval) if fval is not None else "#cccccc")
                    history_times.append(entry.get("time"))
                last_val = history_values[-1] if history_values else None
                last_col = _get_aqi_color("PM25", last_val) if last_val is not None else "#cccccc"
                display_val = int(last_val) if last_val is not None and last_val == int(last_val) else last_val
                home_entry = {
                    "id": "Home", "name": "Home", "pinned": True, "emoji": "\U0001f3f0",
                    "lat": 40.7608, "lon": -111.891,
                    "readings": {"PM25": {"value": display_val, "color": last_col,
                                          "history": history_values, "history_colors": history_colors,
                                          "history_times": history_times}},
                    "color": last_col, "primary_key": "PM25", "primary_value": display_val,
                    "primary_color": last_col, "primary_aqi": None,
                }
    if not home_entry:
        try:
            snapshot = load_snapshot(data_dir, date_str)
            if snapshot and isinstance(snapshot.get("fixed"), list):
                for sensor in snapshot["fixed"]:
                    if sensor.get("id") == "Home":
                        home_entry = sensor
                        break
        except Exception:
            pass
    if home_entry:
        result["fixed"].insert(0, home_entry)
    
    # ── PurpleAir sensors from fixed_history ──
    if app_state:
        for sensor_id, pollutants in app_state.fixed_history.items():
            if not sensor_id.startswith("PA_"):
                continue
            pm25_hist = pollutants.get("PM25", [])
            if not pm25_hist:
                continue
            day_entries = [e for e in pm25_hist if e.get("time") and e["time"].startswith(date_str)]
            if not day_entries:
                continue
            last = day_entries[-1]
            val_str = last.get("val")
            try:
                pm25_val = float(val_str) if val_str is not None else None
            except (TypeError, ValueError):
                pm25_val = None
            if pm25_val is None:
                continue
            color = _get_aqi_color("PM25", pm25_val)
            lat, lon = None, None
            sensor_idx = sensor_id[3:]
            for s in app_state.purpleair_sensors:
                if str(s.get("sensor_index", "")) == sensor_idx:
                    lat = s.get("latitude")
                    lon = s.get("longitude")
                    break
            if lat is None or lon is None:
                continue
            history_values, history_colors, history_times = [], [], []
            for entry in day_entries:
                v = entry.get("val")
                try:
                    fv = float(v) if v is not None else None
                    if fv is not None and fv == int(fv):
                        fv = int(fv)
                except (TypeError, ValueError):
                    fv = None
                history_values.append(fv)
                history_colors.append(_get_aqi_color("PM25", fv) if fv is not None else "#cccccc")
                history_times.append(entry.get("time"))
            display_val = round(pm25_val, 1)
            name = sensor_id
            for s in app_state.purpleair_sensors:
                if str(s.get("sensor_index", "")) == sensor_idx:
                    name = s.get("name", sensor_id)
                    name = re.sub(r'(?:\s*-\s*|\s+)power(?:ed)?\s+by\s+uto[pi]{2}a(?:\s+fiber)?', '', name, flags=re.IGNORECASE).strip()
                    break
            result["fixed"].append({
                "id": sensor_id, "name": name, "pinned": False, "emoji": "",
                "lat": lat, "lon": lon,
                "readings": {"PM25": {"value": display_val, "color": color, "key": "PM2.5",
                                      "history": history_values, "history_colors": history_colors,
                                      "history_times": history_times}},
                "color": color, "purpleair": True, "primary_key": "PM25",
                "primary_value": display_val, "primary_color": color, "primary_aqi": None,
            })
    
    # ── DEQ / Utah AQ fixed stations from fixed_history ──
    # These are the stationary government sensors (Hawthorne, Rose Park, etc.)
    # accumulated from live FixedSiteMapData.json polls.
    # Get lat/lon from the current live state (locations are static).
    if app_state:
        # Build a lookup of lat/lon/name from the current live fixed sensor state
        live_fixed_lookup: dict[str, dict[str, Any]] = {}
        live_state = app_state.state if isinstance(app_state.state, dict) else {}
        for f in (live_state.get("fixed") or []):
            if isinstance(f, dict) and f.get("id"):
                live_fixed_lookup[f["id"]] = f
        
        # Also check raw_fixed for lat/lon (more reliable source)
        if isinstance(app_state.raw_fixed, dict):
            for _pollutant_key, sensors in app_state.raw_fixed.items():
                if not isinstance(sensors, dict):
                    continue
                for sid, s_data in sensors.items():
                    if sid in ("LastUpdateUTC", "LastUpdateLocal", "APITimeStart", "APITimeEnd", "VarName", "VarUnit"):
                        continue
                    if not isinstance(s_data, dict):
                        continue
                    lat_f = coerce_float(s_data.get("Latitude"))
                    lon_f = coerce_float(s_data.get("Longitude"))
                    if lat_f is not None and lon_f is not None and sid not in live_fixed_lookup:
                        live_fixed_lookup[sid] = {"id": sid, "lat": lat_f, "lon": lon_f, "name": ""}
        
        # IDs already in result (Home, PurpleAir) — skip these
        already_added = {f.get("id") for f in result["fixed"]}
        
        for sensor_id, pollutants in app_state.fixed_history.items():
            # Skip Home, PurpleAir (already handled above), and anything already added
            if sensor_id == "Home" or sensor_id.startswith("PA_") or sensor_id in already_added:
                continue
            
            # Need lat/lon from live state
            live_info = live_fixed_lookup.get(sensor_id)
            if not live_info:
                continue
            lat = coerce_float(live_info.get("lat"))
            lon = coerce_float(live_info.get("lon"))
            if lat is None or lon is None:
                continue
            
            # Build readings for each pollutant that has history for this day
            readings: dict[str, Any] = {}
            for pollutant, hist_entries in pollutants.items():
                if not hist_entries:
                    continue
                day_entries = [e for e in hist_entries if e.get("time") and e["time"].startswith(date_str)]
                if not day_entries:
                    continue
                history_values = []
                history_colors = []
                history_times = []
                for entry in day_entries:
                    v = entry.get("val")
                    try:
                        fv = float(v) if v is not None else None
                        if fv is not None and fv == int(fv):
                            fv = int(fv)
                    except (TypeError, ValueError):
                        fv = None
                    history_values.append(fv)
                    history_colors.append(_get_aqi_color(pollutant, fv) if fv is not None else "#cccccc")
                    history_times.append(entry.get("time"))
                last_val = history_values[-1] if history_values else None
                last_col = _get_aqi_color(pollutant, last_val) if last_val is not None else "#cccccc"
                display_val = last_val
                if display_val is not None:
                    try:
                        if float(display_val) == int(float(display_val)):
                            display_val = int(float(display_val))
                    except (ValueError, TypeError):
                        pass
                readings[pollutant] = {
                    "value": display_val, "color": last_col,
                    "history": history_values, "history_colors": history_colors,
                    "history_times": history_times,
                }
            
            if not readings:
                continue
            
            worst = _pick_worst_reading_by_aqi(readings)
            name = live_info.get("name") or ""
            pinned = bool(live_info.get("pinned"))
            result["fixed"].append({
                "id": sensor_id, "name": name, "pinned": pinned, "emoji": "📍",
                "lat": lat, "lon": lon,
                "readings": readings,
                "color": worst.get("color") or "#cccccc",
                "primary_key": worst.get("key"),
                "primary_value": worst.get("value"),
                "primary_color": worst.get("color"),
                "primary_aqi": worst.get("aqi"),
            })


def fetch_historical_day(date_str: str, app_state: AppState | None = None, data_dir: Path | None = None, start_ms: int | None = None, end_ms: int | None = None) -> dict[str, Any]:
    """Fetch week-long data and filter to a specific day.
    
    Day boundaries are 4 AM local time to 4 AM the next day.
    If start_ms/end_ms are provided (from client), use them directly.
    Otherwise fall back to server-side computation (MST, UTC-7).
    Past days are cached on disk so upstream data is only fetched once.
    
    Returns data in RAW API FORMAT so it can be processed by 
    normalize_state_for_dashboard like live data.
    
    Args:
        date_str: Date in YYYY-MM-DD format
        app_state: Optional AppState for accessing Home sensor history
        data_dir: Data directory for loading snapshots (defaults to ~/.mobileair)
        start_ms: Optional day-start epoch ms from client (4 AM local)
        end_ms: Optional day-end epoch ms from client (next 4 AM local)
    
    Returns:
        Dict with 'mobile' in raw API format (same as MobileMapData.json)
    """
    # Default data_dir if not provided
    if data_dir is None:
        data_dir = default_data_dir()
    from datetime import datetime, timezone, timedelta
    from concurrent.futures import ThreadPoolExecutor, as_completed
    
    # Use client-provided boundaries if available, else compute server-side.
    if start_ms is not None and end_ms is not None:
        day_start = datetime.fromtimestamp(start_ms / 1000, tz=timezone.utc)
        day_end = datetime.fromtimestamp(end_ms / 1000, tz=timezone.utc)
    else:
        # Fallback: Parse date and compute day boundaries at 4 AM local (MST = UTC-7).
        # 4 AM MST = 11:00 UTC, so add 11 hours to midnight UTC of the selected date.
        try:
            day_start = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError:
            raise ValueError(f"Invalid date format: {date_str}. Use YYYY-MM-DD.")
        day_start = day_start + timedelta(hours=11)  # 4 AM MST = 11:00 UTC
        day_end = day_start + timedelta(days=1)
        start_ms = int(day_start.timestamp() * 1000)
        end_ms = int(day_end.timestamp() * 1000)
    
    # For past days (not today), check disk cache first.
    # Past days are immutable once complete — no need to re-fetch.
    today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    is_past_day = (date_str < today_str)
    
    if is_past_day:
        cached = _load_cached_historical_day(data_dir, date_str)
        if cached is not None:
            _log(f"[History] Serving {date_str} from disk cache")
            # Always reconstruct fixed sensors from current fixed_history
            # (cache only stores mobile data; fixed history accumulates over time)
            _apply_fixed_sensors_to_history(cached, date_str, app_state, data_dir)
            return cached
    
    # Check if history server is reachable (will use AirNow-only if not)
    utah_aq_available = _is_history_server_reachable()
    if not utah_aq_available:
        _log(f"[History] Utah AQ server unreachable, will use AirNow-only for {date_str}")
    
    # Fetch data for all sensors in parallel (using cached week files)
    # Skip if Utah AQ is unavailable - we'll still have Home sensor + AirNow
    raw_data: dict[str, dict[str, list]] = {s: {} for s in HISTORY_SENSORS}
    
    if utah_aq_available:
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
        with ThreadPoolExecutor(max_workers=10) as executor:
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
        
        # OZNE - filter out negative values and statistical outliers (sensor glitches)
        # Use IQR-based outlier detection: values beyond Q3 + 10*IQR are sensor errors
        ozne_valid = [val for ts, val in ozne_pts if val is not None and val >= 0]
        ozne_upper = float('inf')
        if len(ozne_valid) >= 10:
            sorted_vals = sorted(ozne_valid)
            q1 = sorted_vals[len(sorted_vals) // 4]
            q3 = sorted_vals[(3 * len(sorted_vals)) // 4]
            iqr = q3 - q1
            ozne_upper = q3 + 10 * max(iqr, 20)  # At least 20 ppb margin
        ozne_by_ts = {ts: val for ts, val in ozne_pts if val is None or (0 <= val <= ozne_upper)}
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
    # NOTE: For historical data on past days, we do NOT apply road graph snapping
    # (too slow). The client progressively snaps during playback.
    # For TODAY's historical data, we DO apply road snapping (same as live).
    # Override: MOBILEAIR_FORCE_ROAD_SNAP_HISTORICAL=1 forces snapping for all dates (testing)
    combined = {"mobile": mobile_raw, "fixed": {}}
    
    force_snap = os.environ.get("MOBILEAIR_FORCE_ROAD_SNAP_HISTORICAL", "").strip() == "1"
    use_road_graph = (date_str == today_str) or force_snap
    
    result = normalize_state_for_dashboard(
        combined,
        custom_names={},
        pinned_sensors=set(),
        max_points=5000,  # Allow more points for historical data
        mobile_url=MOBILE_URL,
        fixed_url=FIXED_URL,
        data_dir=str(default_data_dir()),
        road_graph=get_cached_road_graph() if use_road_graph else None,
        tram_line_graph=get_cached_tram_line_graph() if use_road_graph else None,
    )
    
    # Add historical metadata
    result["meta"]["historical"] = True
    result["meta"]["date"] = date_str
    
    # Track data availability
    mobile_count = len(result.get("mobile", []))
    if not utah_aq_available:
        result["meta"]["utah_aq_unavailable"] = True
        if mobile_count == 0:
            result["meta"]["mobile_data_unavailable"] = True
    
    # Add fixed sensors (Home + PurpleAir) from fixed_history / snapshots
    _apply_fixed_sensors_to_history(result, date_str, app_state, data_dir)
    
    # Cache past days to disk for instant future loads
    # Only cache mobile data — fixed sensors are reconstructed on serve
    # Only cache if Utah AQ was reachable and we got actual mobile data
    if is_past_day:
        if utah_aq_available and mobile_count > 0:
            _save_cached_historical_day(data_dir, date_str, result)
        else:
            _log(f"[History] Skipping cache for {date_str} (utah_aq_available={utah_aq_available}, mobile_count={mobile_count})")
    
    return result


_history_prefetch_last_date: str | None = None  # last MST date we checked

def _maybe_prefetch_history(app_state: AppState, data_dir: Path) -> None:
    """Cache any uncached days in the past 6 days. Only runs once per day transition."""
    global _history_prefetch_last_date
    mst_tz = timezone(timedelta(hours=-7))
    today_str = datetime.now(timezone.utc).astimezone(mst_tz).strftime("%Y-%m-%d")
    if today_str == _history_prefetch_last_date:
        return  # already checked today
    _history_prefetch_last_date = today_str
    today = datetime.now(timezone.utc).astimezone(mst_tz).date()
    for days_ago in range(1, 7):
        date_str = (today - timedelta(days=days_ago)).strftime("%Y-%m-%d")
        if _load_cached_historical_day(data_dir, date_str) is not None:
            continue
        try:
            fetch_historical_day(date_str, app_state=app_state, data_dir=data_dir)
            if _load_cached_historical_day(data_dir, date_str) is not None:
                _log(f"[HistoryPrefetch] Cached {date_str}")
        except Exception as e:
            _log(f"[HistoryPrefetch] {date_str}: {e}")
            return


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


def _max_mobile_trail_ms(mobiles: Any) -> int | None:
    """Return the newest breadcrumb timestamp across all mobiles as epoch milliseconds."""
    if not isinstance(mobiles, list):
        return None
    best_s: float | None = None
    for m in mobiles:
        if not isinstance(m, dict):
            continue
        trail = m.get("trail")
        if not isinstance(trail, list) or not trail:
            continue
        _, last_s = _first_last_ts(trail)
        if last_s is None:
            continue
        if best_s is None or last_s > best_s:
            best_s = last_s
    if best_s is None:
        return None
    return int(best_s * 1000)


def _point_ms(p: Any) -> int | None:
    if not isinstance(p, dict):
        return None
    t = p.get("t")
    if not isinstance(t, str):
        return None
    dt = parse_utc_timestamp(t)
    if dt is None:
        return None
    return int(dt.timestamp() * 1000)


def _day_start_4am_local_ms(anchor_ms: int) -> int | None:
    try:
        d = datetime.fromtimestamp(anchor_ms / 1000.0, tz=timezone.utc).astimezone()
        d = d.replace(hour=4, minute=0, second=0, microsecond=0)
        return int(d.timestamp() * 1000)
    except Exception:
        return None


def _is_moving_point(p: Any) -> bool:
    if not isinstance(p, dict):
        return False
    m = p.get("m")
    return bool(m == 1 or m == "1" or m is True)


def _lazy_backfill_road_matching_today(
    pm: dict[str, Any],
    road_graph: RoadGraph,
    *,
    max_segments: int = 3,
    max_points_total: int = 5000,
    max_points_per_seg: int = 40,
) -> None:
    """Incrementally map-match older (today-only) segments, walking backwards.

    This is bounded work per update cycle and avoids reprocessing points.
    Generated points are marked with rm=1.
    """

    trail = pm.get("trail")
    if not isinstance(trail, list) or len(trail) < 2:
        return

    # Determine "today" based on the newest timestamp in the trail.
    newest_ms: int | None = None
    for k in range(len(trail) - 1, -1, -1):
        newest_ms = _point_ms(trail[k])
        if newest_ms is not None:
            break
    if newest_ms is None:
        return

    day_start_ms = _day_start_4am_local_ms(newest_ms)
    if day_start_ms is None:
        return

    # Walk backwards over *raw* points (rm!=1) and replace raw segments.
    segs_done = 0
    cursor = len(trail) - 1
    while segs_done < max_segments and cursor > 0 and len(trail) >= 2:
        # Find the next raw point to snap (as the segment "next_point").
        i = cursor
        while i > 0:
            pi = trail[i]
            if isinstance(pi, dict) and pi.get("rm") == 1:
                i -= 1
                continue
            i_ms = _point_ms(pi)
            if i_ms is None:
                i -= 1
                continue
            if i_ms < day_start_ms:
                return
            break

        if i <= 0:
            return

        # Find previous raw point.
        j = i - 1
        while j >= 0:
            pj = trail[j]
            if isinstance(pj, dict) and pj.get("rm") == 1:
                j -= 1
                continue
            if _point_ms(pj) is None:
                j -= 1
                continue
            break

        if j < 0:
            return

        prev_p = trail[j]
        next_p = trail[i]

        # Only map-match moving segments (avoid densifying idle jitter).
        if not (_is_moving_point(prev_p) and _is_moving_point(next_p)):
            cursor = j
            continue

        headroom = max(0, max_points_total - len(trail))
        max_out = max(0, min(max_points_per_seg, headroom))
        if max_out < 2:
            return

        try:
            seg = match_trail_segment_offline(
                road_graph,
                prev_p,
                next_p,
                max_output_points=max_out,
                spacing_m=25.0,
            )
        except Exception:
            seg = None

        if seg:
            for p in seg:
                if isinstance(p, dict):
                    p["rm"] = 1
            # Replace everything after prev up through next.
            trail[j + 1 : i + 1] = seg
            segs_done += 1

        cursor = j

def update_app_state_with_new_data(app_state: AppState, st: dict[str, Any], now: float | None = None) -> None:
    if now is None:
        now = time.time()

    meta = st.get("meta")
    if not isinstance(meta, dict):
        meta = {}
        st["meta"] = meta

    with app_state.lock:
        # Lazy-load offline road graph (optional). If missing/unavailable, map-matching is skipped.
        road_graph: RoadGraph | None = None
        try:
            rg = getattr(app_state, "road_graph", None)
            if isinstance(rg, RoadGraph):
                road_graph = rg
            else:
                p = os.environ.get("MOBILEAIR_ROAD_GRAPH") or RoadGraph.default_graph_path()
                if os.path.exists(p):
                    road_graph = RoadGraph.load(p)
                    app_state.road_graph = road_graph
        except Exception:
            road_graph = None

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
                            # Snap moving points to nearest road
                            if road_graph is not None and isinstance(p, dict) and p.get("m") == 1:
                                lat = p.get("lat")
                                lon = p.get("lon")
                                if isinstance(lat, (int, float)) and isinstance(lon, (int, float)):
                                    snapped = road_graph.snap_to_nearest_road(float(lat), float(lon), max_snap_distance_m=50.0)
                                    if snapped is not None:
                                        p["lat"] = snapped[0]
                                        p["lon"] = snapped[1]
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

                        if "m" not in np:
                            np["m"] = 1

                        # Snap GPS point to nearest road (if graph available and point is moving)
                        if road_graph is not None and np.get("m") == 1:
                            lat = np.get("lat")
                            lon = np.get("lon")
                            if isinstance(lat, (int, float)) and isinstance(lon, (int, float)):
                                snapped = road_graph.snap_to_nearest_road(float(lat), float(lon), max_snap_distance_m=50.0)
                                if snapped is not None:
                                    np["lat"] = snapped[0]
                                    np["lon"] = snapped[1]

                        pm["trail"].append(np)

                        # Keep last_old_ms in sync so we don't re-append the same segment.
                        try:
                            _, last_old_ms2 = _first_last_ts(pm["trail"])
                            last_old_ms = last_old_ms2
                        except Exception:
                            pass

                # Scrub out-and-back GPS spikes (A→B→C where A≈C) that
                # span poll boundaries.  clean_trail's spike scan is bounded
                # to the last ~1200 points so this is cheap.
                pm["trail"] = clean_trail(pm["trail"])

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

        # Detect broken mobile sensors (peer-based outlier detection).
        # Removes them from the list AND from persistent state so they
        # don't linger as ghosts — they come back when readings normalize.
        broken_sids = _scrub_broken_mobile_sensors(combined_mobile)
        for sid in broken_sids:
            app_state.persistent_mobile.pop(sid, None)

        st["mobile"] = combined_mobile

        # Compute and publish the server-authoritative "since last update" window.
        # This is consumed by the dashboard camera-follow to fit only the newly
        # revealed trail segment.
        new_max_ms = _max_mobile_trail_ms(st.get("mobile"))
        if new_max_ms is not None:
            prev_max_ms = app_state.last_mobile_max_ms
            if prev_max_ms is None:
                # First observation: define a minimal window at the end.
                app_state.trail_update_start_ms = new_max_ms - 1
                app_state.trail_update_end_ms = new_max_ms
            elif new_max_ms > prev_max_ms:
                app_state.trail_update_start_ms = prev_max_ms
                app_state.trail_update_end_ms = new_max_ms
            # Always keep last_mobile_max_ms in sync.
            app_state.last_mobile_max_ms = new_max_ms

            if app_state.trail_update_start_ms is not None:
                meta["trail_update_start_ms"] = int(app_state.trail_update_start_ms)
            if app_state.trail_update_end_ms is not None:
                meta["trail_update_end_ms"] = int(app_state.trail_update_end_ms)

        # Merge AirNow readings into fixed sensors
        if app_state.airnow_readings:
            _merge_airnow_into_fixed(st, app_state)

        # Merge PurpleAir sensors into fixed sensors
        if app_state.purpleair_sensors:
            # Accumulate current PA values into history so history stays
            # in sync with live readings (PA fetch loop runs on its own
            # 2-min cycle, but the main fetch loop can run more often).
            time_utc = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            for s in app_state.purpleair_sensors:
                pm25 = s.get("pm2.5")
                if pm25 is None:
                    continue
                sid = f"PA_{s.get('sensor_index', '')}"
                try:
                    pm25_val = float(pm25)
                except (TypeError, ValueError):
                    continue
                color = _get_aqi_color("PM25", pm25_val)
                accumulate_fixed_reading(app_state, sid, "PM25", round(pm25_val, 1), color, time_utc)

            _merge_purpleair_into_fixed(st, app_state)
            # Inject history into PurpleAir sensors (they were added after the
            # earlier _inject_fixed_history call, so they missed it)
            _inject_fixed_history(app_state, st)

        prev_meta = app_state.state.get("meta", {}) if isinstance(app_state.state, dict) else {}
        if "server_start_ts" in prev_meta: meta["server_start_ts"] = prev_meta["server_start_ts"]

        # Cache locations from live fixed sensors so we can reconstruct offline ones
        for fs in (st.get("fixed") or []):
            if isinstance(fs, dict) and fs.get("id"):
                sid = fs["id"]
                if sid == "Home" or sid.startswith("PA_"):
                    continue
                lat = coerce_float(fs.get("lat"))
                lon = coerce_float(fs.get("lon"))
                if lat is not None and lon is not None and sid not in app_state.fixed_sensor_locations:
                    app_state.fixed_sensor_locations[sid] = {
                        "lat": lat, "lon": lon, "name": fs.get("name") or "",
                    }

        # Re-apply custom sensor names after AirNow/PurpleAir merges
        # (those merges add sensors with their upstream names, overriding any
        # custom names that normalize_state_for_dashboard applied earlier)
        _dd = app_state.fixed_history_path.parent if app_state.fixed_history_path else default_data_dir()
        names = load_json_file(_dd / "sensor_names.json", {})
        if isinstance(names, dict):
            apply_sensor_names_inplace(st, names)

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
            
            # Add AirNow readings that don't already exist.
            # Check canonical equivalents (e.g. PM25 ≡ PM2.5, OZNE ≡ OZONE/O3)
            _EQUIV = {"PM25": {"PM2.5"}, "PM2.5": {"PM25"}, "OZNE": {"OZONE", "O3"}, "OZONE": {"OZNE", "O3"}, "O3": {"OZNE", "OZONE"}}
            for param, data in airnow_readings_dict.items():
                if param in existing_readings:
                    continue
                # Also skip if an equivalent key already exists
                if any(eq in existing_readings for eq in _EQUIV.get(param, ())):
                    continue
                existing_readings[param] = data
            
            existing["readings"] = existing_readings
            existing["airnow_source"] = True
            # Update name/emoji from AirNow if existing sensor has no name
            if not existing.get("name") and site_name:
                existing["name"] = site_name
            existing["emoji"] = "🏛️"
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


# ─────────────────────────────────────────────────────────────────────────────
# PurpleAir Integration
# ─────────────────────────────────────────────────────────────────────────────

PURPLEAIR_API_KEY = "C2922794-0519-11F1-B596-4201AC1DC123"
PURPLEAIR_API_URL = "https://api.purpleair.com/v1/sensors"


def _fetch_purpleair_sensors() -> list[dict[str, Any]]:
    """Fetch PurpleAir sensors in the SLC bounding box."""
    params = {
        "fields": "name,latitude,longitude,pm2.5,pm2.5_10minute,humidity,temperature,last_seen",
        "nwlng": str(SLC_BOUNDS["lon_min"]),
        "nwlat": str(SLC_BOUNDS["lat_max"]),
        "selng": str(SLC_BOUNDS["lon_max"]),
        "selat": str(SLC_BOUNDS["lat_min"]),
        "location_type": "0",  # outdoor only
    }
    qs = "&".join(f"{k}={v}" for k, v in params.items())
    url = f"{PURPLEAIR_API_URL}?{qs}"
    try:
        resp = stdlib_get(url, timeout=10, headers={
            "X-API-Key": PURPLEAIR_API_KEY,
            "Accept": "application/json",
        })
        resp.raise_for_status()
        data = resp.json()
        fields = data.get("fields", [])
        results = []
        for row in data.get("data", []):
            sensor = dict(zip(fields, row))
            sensor["sensor_index"] = row[0] if row else None
            results.append(sensor)
        return results
    except Exception as e:
        _log(f"[PurpleAir] Fetch error: {type(e).__name__}: {e}")
        return []


def _merge_purpleair_into_fixed(st: dict[str, Any], app_state: AppState) -> None:
    """Merge PurpleAir sensors into fixed list as dot markers."""
    sensors = app_state.purpleair_sensors
    if not sensors:
        return

    fixed_list = st.get("fixed", [])
    if not isinstance(fixed_list, list):
        return

    # Remove any existing PurpleAir sensors to avoid duplicates on re-merge
    fixed_list = [f for f in fixed_list if not f.get("purpleair")]

    # ── Outlier detection: compare each sensor against peers ─────────
    # Collect all valid PM2.5 values in-bounds
    valid_values: list[float] = []
    for s in sensors:
        lat = s.get("latitude")
        lon = s.get("longitude")
        if lat is None or lon is None:
            continue
        if not (SLC_BOUNDS["lat_min"] <= lat <= SLC_BOUNDS["lat_max"] and
                SLC_BOUNDS["lon_min"] <= lon <= SLC_BOUNDS["lon_max"]):
            continue
        pm25 = s.get("pm2.5")
        if pm25 is None:
            continue
        try:
            valid_values.append(float(pm25))
        except (TypeError, ValueError):
            pass

    # Compute outlier threshold from peer readings using IQR method
    # Only filters truly broken hardware (e.g., 3000+ when median is 2).
    # Must NOT filter legitimate hotspots near highways, construction,
    # or during dust storms/inversions (200+ is realistic).
    outlier_threshold = float("inf")
    if len(valid_values) >= 3:
        sv = sorted(valid_values)
        n = len(sv)
        q1 = sv[n // 4]
        q3 = sv[(3 * n) // 4]
        iqr = q3 - q1
        # Floor of 500 µg/m³: never filter readings below 500.
        # Above 500, must exceed Q3 + 10× IQR to be considered broken.
        outlier_threshold = max(500.0, q3 + iqr * 10.0)
    # ─────────────────────────────────────────────────────────────────

    for s in sensors:
        lat = s.get("latitude")
        lon = s.get("longitude")
        if lat is None or lon is None:
            continue
        if not (SLC_BOUNDS["lat_min"] <= lat <= SLC_BOUNDS["lat_max"] and
                SLC_BOUNDS["lon_min"] <= lon <= SLC_BOUNDS["lon_max"]):
            continue

        pm25 = s.get("pm2.5")
        if pm25 is None:
            continue
        try:
            pm25_val = float(pm25)
        except (TypeError, ValueError):
            continue

        # Skip outlier sensors (broken hardware reporting wildly wrong values)
        if pm25_val < 0 or pm25_val > outlier_threshold:
            continue

        sid = f"PA_{s.get('sensor_index', '')}"
        name = s.get("name", sid)
        # Strip branding from name
        name = re.sub(r'(?:\s*-\s*|\s+)power(?:ed)?\s+by\s+uto[pi]{2}a(?:\s+fiber)?', '', name, flags=re.IGNORECASE).strip()
        color = _get_aqi_color("PM25", pm25_val)
        readings = {
            "PM25": {
                "value": round(pm25_val, 1),
                "color": color,
                "key": "PM2.5",
            }
        }
        # Add humidity/temperature if available
        humidity = s.get("humidity")
        if humidity is not None:
            try:
                readings["Humidity"] = {"value": round(float(humidity), 0), "color": "#88bbdd", "key": "RH%"}
            except (TypeError, ValueError):
                pass
        temp = s.get("temperature")
        if temp is not None:
            try:
                readings["Temp"] = {"value": round(float(temp), 0), "color": "#ddaa66", "key": "°F"}
            except (TypeError, ValueError):
                pass

        fixed_list.append({
            "id": sid,
            "name": name,
            "pinned": False,
            "emoji": "",  # empty = render as dot, not emoji
            "lat": lat,
            "lon": lon,
            "readings": readings,
            "color": color,
            "purpleair": True,
            "primary_key": "PM25",
            "primary_value": round(pm25_val, 1),
            "primary_color": color,
            "primary_aqi": None,
        })

    st["fixed"] = fixed_list


def purpleair_fetch_loop(
    *,
    app_state: AppState,
    interval_s: float = 300.0,  # 5 minutes
    stop_event: threading.Event,
) -> None:
    """Background loop to fetch PurpleAir sensor data."""
    # Wait for main fetch loop to start
    stop_event.wait(20.0)

    while not stop_event.is_set():
        try:
            sensors = _fetch_purpleair_sensors()
            if sensors:
                with app_state.lock:
                    app_state.purpleair_sensors = sensors
                    app_state.purpleair_last_fetch = time.time()
                    # Accumulate PurpleAir readings into fixed_history for playback
                    for s in sensors:
                        pm25 = s.get("pm2.5")
                        if pm25 is None:
                            continue
                        sid = f"PA_{s.get('sensor_index', '')}"
                        try:
                            pm25_val = float(pm25)
                        except (TypeError, ValueError):
                            continue
                        # Use sensor's last_seen timestamp instead of poll time
                        last_seen = s.get("last_seen")
                        if last_seen is not None:
                            try:
                                last_seen_int = int(last_seen)
                                dt = datetime.fromtimestamp(last_seen_int, tz=timezone.utc)
                                time_utc = dt.strftime("%Y-%m-%dT%H:%M:%SZ")
                            except (TypeError, ValueError):
                                time_utc = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                        else:
                            time_utc = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                        color = _get_aqi_color("PM25", pm25_val)
                        accumulate_fixed_reading(app_state, sid, "PM25", round(pm25_val, 1), color, time_utc)
                    # Merge into current state immediately
                    if isinstance(app_state.state, dict):
                        _merge_purpleair_into_fixed(app_state.state, app_state)
                        _inject_fixed_history(app_state, app_state.state)
                        app_state.cached_json_bytes = json.dumps(app_state.state).encode("utf-8")
                _log(f"[PurpleAir] Updated {len(sensors)} sensors")
        except Exception as e:
            _log(f"[PurpleAir] Error: {type(e).__name__}: {e}")

        # Determine wait interval: 10 minutes (1am-8am MST), otherwise 5 minutes
        mst_tz = timezone(timedelta(hours=-7))
        now_mst = datetime.now(timezone.utc).astimezone(mst_tz)
        if 1 <= now_mst.hour < 8:
            wait_interval_s = 600.0  # 10 minutes off-peak
        else:
            wait_interval_s = 300.0  # 5 minutes peak hours
        stop_event.wait(wait_interval_s)


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
            if param and value is not None and param in AIRNOW_PARAM_MAP:
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
        if param not in AIRNOW_PARAM_MAP:
            continue
        
        mapped_key = AIRNOW_PARAM_MAP[param]
        color = _get_aqi_color(mapped_key, value)
        
        result[mapped_key] = {
            "value": value,
            "color": color,
        }
    
    return result


def _get_aqi_color(pollutant: str, value: Any) -> str:
    """Get AQI color for a pollutant value.

    PM2.5 uses EPA AQI standard colors and breakpoints.
    PM10 and O3 use the Utah AQ / CHPC color scale.
    """
    try:
        v = float(value)
    except (TypeError, ValueError):
        return "#cccccc"
    
    # EPA 2024 PM2.5 (24-hr) with clean sub-gradients within Good
    if pollutant in ("PM25", "PM2.5"):
        if v <= 2.0:  return "#00FFFF"   # cyan   – Good (very low)
        if v <= 5.0:  return "#00CCFF"   # lt blue – Good
        if v <= 9.0:  return "#00E400"   # green  – Good
        if v <= 35.4: return "#FFFF00"   # yellow – Moderate
        if v <= 55.4: return "#FF7E00"   # orange – USG
        if v <= 125.4: return "#FF0000"  # red    – Unhealthy
        if v <= 225.4: return "#8F3F97"  # purple – Very Unhealthy
        return "#7E0023"                 # maroon – Hazardous
    elif pollutant in ("PM10",):
        # EPA AQI with clean sub-gradients
        if v <= 15.0:  return "#00FFFF"   # cyan   – Good (very low)
        if v <= 30.0:  return "#00CCFF"   # lt blue – Good
        if v <= 40.0:  return "#0099FF"   # blue   – Good
        if v <= 54:    return "#00E400"   # green  – Good
        if v <= 154:   return "#FFFF00"   # yellow – Moderate
        if v <= 254:   return "#FF7E00"   # orange – USG
        if v <= 354:   return "#FF0000"   # red    – Unhealthy
        if v <= 424:   return "#8F3F97"   # purple – Very Unhealthy
        return "#7E0023"                  # maroon – Hazardous
    elif pollutant in ("OZNE", "OZONE", "O3"):
        # ppb values
        if v <= 15:  return "#00CCFF"
        if v <= 25:  return "#0099FF"
        if v <= 35:  return "#009900"
        if v <= 54:  return "#006600"
        if v <= 70:  return "#FFFF00"
        if v <= 85:  return "#FF7E00"
        if v <= 105: return "#FF0000"
        if v <= 200: return "#8F3F97"
        return "#7E0023"
    elif pollutant in ("NO2",):
        # NO2 ppb – EPA 1-hour breakpoints
        if v <= 20:   return "#00CCFF"
        if v <= 35:   return "#0099FF"
        if v <= 53:   return "#00E400"
        if v <= 100:  return "#FFFF00"
        if v <= 360:  return "#FF7E00"
        if v <= 649:  return "#FF0000"
        if v <= 1249: return "#8F3F97"
        return "#7E0023"
    elif pollutant in ("CO",):
        # CO ppm – EPA 8-hour breakpoints
        if v <= 1.5:  return "#00CCFF"
        if v <= 3.0:  return "#0099FF"
        if v <= 4.4:  return "#00E400"
        if v <= 9.4:  return "#FFFF00"
        if v <= 12.4: return "#FF7E00"
        if v <= 15.4: return "#FF0000"
        if v <= 30.4: return "#8F3F97"
        return "#7E0023"
    
    return "#cccccc"


def _pick_color_from_readings(readings: dict[str, dict[str, Any]]) -> str:
    """Pick the primary color from readings."""
    priority = ["PM25", "PM2.5", "PM10", "OZNE", "NO2", "CO"]
    for k in priority:
        if k in readings and isinstance(readings[k], dict):
            return readings[k].get("color", "#3388ff")
    for v in readings.values():
        if isinstance(v, dict):
            return v.get("color", "#3388ff")
    return "#3388ff"


def _pick_primary_key(readings: dict[str, dict[str, Any]]) -> str | None:
    """Pick the primary pollutant key."""
    priority = ["PM25", "PM2.5", "PM10", "OZNE", "NO2", "CO"]
    for k in priority:
        if k in readings:
            return k
    return next(iter(readings.keys()), None)


# ─────────────────────────────────────────────────────────────────────────────
# Adaptive Polling for Upstream Data
# The upstream .edu/.gov servers update approximately every 10 minutes.
# We use adaptive polling to minimize requests while staying responsive.
# ─────────────────────────────────────────────────────────────────────────────

class AdaptivePoller:
    """Learns upstream update patterns and adapts polling frequency.
    
    Strategy:
    - After detecting a data change, back off and wait ~8-9 minutes
    - As we approach the predicted update time, increase polling frequency
    - Track observed intervals to learn the actual update schedule
    - Allow for significant variance (upstream can drift by several minutes)
    """
    
    # Upstream updates roughly every 10 minutes, but can vary
    DEFAULT_INTERVAL_S = 600.0  # 10 minutes
    MIN_INTERVAL_S = 300.0      # 5 minutes (minimum expected)
    MAX_INTERVAL_S = 900.0      # 15 minutes (maximum expected)
    
    # Polling rates
    BACKOFF_POLL_S = 120.0      # Poll every 2 min during backoff (just in case)
    APPROACH_POLL_S = 30.0      # Poll every 30s when approaching expected update
    ACTIVE_POLL_S = 15.0        # Poll every 15s when within the update window
    
    # When to start ramping up polling (seconds before predicted update)
    APPROACH_WINDOW_S = 120.0   # Start polling faster 2 min before predicted
    ACTIVE_WINDOW_S = 60.0      # Poll most frequently 1 min before/after predicted
    
    # How many intervals to remember for learning
    MAX_HISTORY = 10
    
    def __init__(self):
        self.last_update_utc: str | None = None  # Last seen LastUpdateUTC
        self.last_change_ts: float | None = None  # When we detected the change
        self.observed_intervals: list[float] = []  # Learned intervals
        self.predicted_interval: float = self.DEFAULT_INTERVAL_S
        self.poll_count = 0
        
    def _extract_last_update_utc(self, data: dict | None) -> str | None:
        """Extract LastUpdateUTC string from upstream data."""
        if not isinstance(data, dict):
            return None
        # Check PM25 section (most reliable)
        pm25 = data.get("PM25", {})
        if isinstance(pm25, dict):
            return pm25.get("LastUpdateUTC")
        return None
    
    def _parse_update_timestamp(self, utc_str: str) -> float | None:
        """Parse LastUpdateUTC string to Unix timestamp."""
        try:
            # Format: "2026-01-25 05:08 UTC"
            dt = datetime.strptime(utc_str.replace(" UTC", ""), "%Y-%m-%d %H:%M")
            dt = dt.replace(tzinfo=timezone.utc)
            return dt.timestamp()
        except Exception:
            return None
    
    def _update_prediction(self):
        """Update predicted interval based on observed history."""
        if not self.observed_intervals:
            return
        
        # Use weighted average favoring recent observations
        weights = [1.0 + 0.5 * i for i in range(len(self.observed_intervals))]
        total_weight = sum(weights)
        weighted_sum = sum(w * v for w, v in zip(weights, self.observed_intervals))
        avg = weighted_sum / total_weight
        
        # Clamp to reasonable bounds
        self.predicted_interval = max(self.MIN_INTERVAL_S, min(self.MAX_INTERVAL_S, avg))
    
    def check_for_change(self, mobile_data: dict | None, fixed_data: dict | None) -> bool:
        """Check if upstream data changed. Returns True if changed."""
        # Get the latest LastUpdateUTC from either dataset
        mobile_utc = self._extract_last_update_utc(mobile_data)
        fixed_utc = self._extract_last_update_utc(fixed_data)
        
        # Use whichever is available (prefer mobile, it updates more reliably)
        current_utc = mobile_utc or fixed_utc
        if not current_utc:
            return False
        
        if self.last_update_utc is None:
            # First fetch - initialize
            self.last_update_utc = current_utc
            self.last_change_ts = time.time()
            return True
        
        if current_utc != self.last_update_utc:
            # Data changed! Learn from this interval
            now = time.time()
            if self.last_change_ts:
                interval = now - self.last_change_ts
                # Only learn from reasonable intervals (ignore outliers)
                if self.MIN_INTERVAL_S * 0.5 <= interval <= self.MAX_INTERVAL_S * 2:
                    self.observed_intervals.append(interval)
                    if len(self.observed_intervals) > self.MAX_HISTORY:
                        self.observed_intervals.pop(0)
                    self._update_prediction()
                    _log(f"[AdaptivePoller] Learned interval: {interval:.0f}s, predicted: {self.predicted_interval:.0f}s")
            
            self.last_update_utc = current_utc
            self.last_change_ts = now
            return True
        
        return False
    
    def get_next_poll_delay(self) -> float:
        """Calculate how long to wait before the next poll."""
        self.poll_count += 1
        
        if self.last_change_ts is None:
            # No data yet - poll at normal rate
            return self.APPROACH_POLL_S
        
        now = time.time()
        time_since_change = now - self.last_change_ts
        time_until_predicted = self.predicted_interval - time_since_change
        
        # Determine polling rate based on where we are in the cycle
        if time_until_predicted > self.APPROACH_WINDOW_S:
            # Well before expected update - back off
            delay = self.BACKOFF_POLL_S
            phase = "backoff"
        elif time_until_predicted > self.ACTIVE_WINDOW_S:
            # Approaching expected update - moderate polling
            delay = self.APPROACH_POLL_S
            phase = "approach"
        elif time_until_predicted > -self.ACTIVE_WINDOW_S:
            # Within active window (before or just after predicted) - poll frequently
            delay = self.ACTIVE_POLL_S
            phase = "active"
        else:
            # Past the predicted window - something's off, poll moderately
            # but increase frequency gradually (upstream might be delayed)
            overdue = -time_until_predicted
            if overdue < 120:
                delay = self.ACTIVE_POLL_S
            elif overdue < 300:
                delay = self.APPROACH_POLL_S
            else:
                # Very overdue - maybe upstream is down, back off
                delay = self.BACKOFF_POLL_S
            phase = "overdue"
        
        # Log occasionally (every 5th poll or on phase changes)
        if self.poll_count % 5 == 0:
            _log(f"[AdaptivePoller] Phase: {phase}, next poll in {delay:.0f}s, "
                 f"time since change: {time_since_change:.0f}s, predicted interval: {self.predicted_interval:.0f}s")
        
        return delay


def _update_home_sensor_in_state(app_state: AppState) -> None:
    """Poll the Home sensor and update its value in app_state without full rebuild."""
    try:
        from mobileair.dirigera_home import get_home_sensor_entry
        home_entry = get_home_sensor_entry()
        if not home_entry:
            return
        
        # Accumulate the reading into history (every 30s poll)
        pm25_reading = home_entry.get("readings", {}).get("PM25", {})
        value = pm25_reading.get("value")
        color = pm25_reading.get("color", "#cccccc")
        if value is not None:
            time_utc = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            accumulate_fixed_reading(app_state, "Home", "PM25", value, color, time_utc)
        
        with app_state.lock:
            st = app_state.state
            if not st or not isinstance(st.get("fixed"), list):
                return
            
            # Find and update Home sensor in fixed list
            for i, sensor in enumerate(st["fixed"]):
                if sensor.get("id") == "Home":
                    # Preserve history from existing entry
                    old_readings = sensor.get("readings", {})
                    new_readings = home_entry.get("readings", {})
                    for key, reading in new_readings.items():
                        if key in old_readings and isinstance(old_readings[key], dict):
                            reading["history"] = old_readings[key].get("history", [])
                            reading["history_colors"] = old_readings[key].get("history_colors", [])
                            reading["history_times"] = old_readings[key].get("history_times", [])
                    home_entry["readings"] = new_readings
                    st["fixed"][i] = home_entry
                    break
    except Exception as e:
        _log(f"[HomeSensor] Update error: {e}")


def fetch_loop(*, app_state: AppState, data_dir: Path, interval_s: float, stop_event: threading.Event) -> None:
    revision = 0
    poller = AdaptivePoller()
    last_home_poll = 0.0
    last_snapshot_save = 0.0
    HOME_POLL_INTERVAL = 30.0  # Poll Home sensor every 30 seconds
    SNAPSHOT_SAVE_INTERVAL = 300.0  # Auto-save snapshot every 5 minutes
    _log(f"[FetchLoop] Starting with adaptive polling (base interval ~{poller.DEFAULT_INTERVAL_S:.0f}s)")
    
    while not stop_event.is_set():
        attempt_ts = time.time()
        
        # Poll Home sensor frequently regardless of AirNow timing
        if attempt_ts - last_home_poll >= HOME_POLL_INTERVAL:
            _update_home_sensor_in_state(app_state)
            last_home_poll = attempt_ts
        
        # Auto-save snapshot every 5 minutes to prevent data loss on crash/restart
        if attempt_ts - last_snapshot_save >= SNAPSHOT_SAVE_INTERVAL:
            try:
                save_fixed_history(app_state)
                if save_today_snapshot(app_state, data_dir):
                    _log(f"[FetchLoop] Auto-saved today's snapshot")
                last_snapshot_save = attempt_ts
            except Exception as e:
                _log(f"[FetchLoop] Auto-save error: {e}")
        
        try:
            _log(f"[FetchLoop] Fetching data...")
            mobile_cache = default_cache_path(MOBILE_URL, mobile_url=MOBILE_URL, fixed_url=FIXED_URL, data_dir=str(data_dir))
            fixed_cache = default_cache_path(FIXED_URL, mobile_url=MOBILE_URL, fixed_url=FIXED_URL, data_dir=str(data_dir))
            # Uses 6s timeout when cache exists (see fetch_json_with_cache), falls back to cache on failure
            mobile = fetch_json_with_cache(MOBILE_URL, headers=HEADERS, timeout=10, request_get=stdlib_get, cache_path=mobile_cache)
            fixed_raw = fetch_json_with_cache(FIXED_URL, headers=HEADERS, timeout=10, request_get=stdlib_get, cache_path=fixed_cache)

            # Clamp impossible sensor values at the source
            mobile = _clamp_impossible_values(mobile)

            # Remove any cache tracking metadata (we use the data's own timestamps now)
            if isinstance(mobile, dict):
                mobile.pop("_cache_age_s", None)
            if isinstance(fixed_raw, dict):
                fixed_raw.pop("_cache_age_s", None)
            
            # Check if upstream data changed (for adaptive polling)
            data_changed = poller.check_for_change(mobile, fixed_raw)
            if data_changed:
                _log(f"[FetchLoop] Upstream data changed!")
            
            # Get data age from the actual LastUpdateUTC in the data
            def get_data_age_s(data: dict | None) -> int | None:
                if not isinstance(data, dict):
                    return None
                # Check PM25 section for LastUpdateUTC
                pm25 = data.get("PM25", {})
                if isinstance(pm25, dict):
                    last_update = pm25.get("LastUpdateUTC")
                    if last_update:
                        try:
                            # Parse "2026-01-25 05:08 UTC" format
                            dt = datetime.strptime(last_update.replace(" UTC", ""), "%Y-%m-%d %H:%M")
                            dt = dt.replace(tzinfo=timezone.utc)
                            age = int(time.time() - dt.timestamp())
                            return max(0, age)
                        except Exception:
                            pass
                return None
            
            mobile_data_age = get_data_age_s(mobile)
            fixed_data_age = get_data_age_s(fixed_raw)
            # Data is stale if older than 30 minutes
            data_stale = (mobile_data_age is not None and mobile_data_age > 1800) or \
                         (fixed_data_age is not None and fixed_data_age > 1800)
            data_age_s = max(mobile_data_age or 0, fixed_data_age or 0) if data_stale else None

            # Accumulate fixed sensor history from raw data
            _accumulate_fixed_history_from_raw(app_state, fixed_raw)

            # Store raw data for TUI remote mode
            with app_state.lock:
                app_state.raw_mobile = mobile if isinstance(mobile, dict) else {}
                app_state.raw_fixed = fixed_raw if isinstance(fixed_raw, dict) else {}
            
            st = build_state(data_dir=data_dir, mobile_json=mobile, fixed_json=fixed_raw, max_points=5000)
            
            # Accumulate home sensor reading into history (uses same mechanism as other fixed sensors)
            _accumulate_home_sensor_reading(app_state, st)
            
            # Inject history arrays into fixed sensors
            _inject_fixed_history(app_state, st)
            
            # Re-inject offline sensors that have history but are missing from the live API
            _reinject_offline_fixed_sensors(app_state, st)
            
            revision += 1
            meta = st.setdefault("meta", {})
            meta.update({"last_fetch_attempt_ts": attempt_ts, "last_fetch_ok_ts": attempt_ts, "server_revision": revision})
            # Use actual data timestamps to determine staleness
            if data_stale:
                meta["data_stale"] = True
                meta["data_age_s"] = data_age_s
            if mobile_data_age is not None:
                meta["mobile_data_age_s"] = mobile_data_age
            if fixed_data_age is not None:
                meta["fixed_data_age_s"] = fixed_data_age
            # Include adaptive polling info in meta
            meta["polling_predicted_interval_s"] = poller.predicted_interval
            if poller.last_change_ts:
                meta["polling_time_since_change_s"] = int(time.time() - poller.last_change_ts)
            # Preserve the force-refresh sequence across rebuild_state() calls.
            meta["force_refresh_seq"] = int(getattr(app_state, "force_refresh_seq", 0) or 0)
            update_app_state_with_new_data(app_state, st)
            _log(f"[FetchLoop] Revision {revision} updated")

            # Cache historical days — gated internally to once per MST day transition
            try:
                _maybe_prefetch_history(app_state, data_dir)
            except Exception as pfx_e:
                _log(f"[HistoryPrefetch] Error: {pfx_e}")

            # Periodically save history and snapshot
            if revision % 10 == 0:
                save_fixed_history(app_state)
            # Save today's snapshot every 30 revisions (~5 hours with adaptive polling)
            # This preserves mobile trails across unexpected restarts
            if revision % 30 == 0 and revision > 0:
                try:
                    save_today_snapshot(app_state, data_dir)
                except Exception as snap_e:
                    _log(f"[FetchLoop] Snapshot save error: {snap_e}")
        except Exception as e:
            _log(f"[FetchLoop] Error: {type(e).__name__}: {e}")
            # Still build state with empty data so Home sensor from Dirigera is included
            try:
                st = build_state(data_dir=data_dir, mobile_json=None, fixed_json=None, max_points=5000)
                meta = st.setdefault("meta", {})
                meta["last_fetch_error"] = f"{type(e).__name__}: {e}"
                meta["force_refresh_seq"] = int(getattr(app_state, "force_refresh_seq", 0) or 0)
                # Use update_app_state_with_new_data so AirNow sensors get merged in
                update_app_state_with_new_data(app_state, st)
            except Exception as inner_e:
                _log(f"[FetchLoop] Inner error: {type(inner_e).__name__}: {inner_e}")
                with app_state.lock:
                    st = {"ts": time.time(), "mobile": [], "fixed": [], "meta": {"last_fetch_error": str(e)}}
                    app_state.state = st
                    try:
                        app_state.cached_json_bytes = json.dumps(st).encode("utf-8")
                    except Exception:
                        pass
        
        # Use adaptive polling delay, but wake up every 30s to poll Home sensor
        next_delay = poller.get_next_poll_delay()
        next_airnow_poll = time.time() + next_delay
        
        while not stop_event.is_set() and time.time() < next_airnow_poll:
            # Poll Home sensor every 30 seconds
            if time.time() - last_home_poll >= HOME_POLL_INTERVAL:
                _update_home_sensor_in_state(app_state)
                last_home_poll = time.time()
            
            # Sleep until next Home poll or AirNow poll, whichever is sooner
            time_to_airnow = next_airnow_poll - time.time()
            time_to_home = HOME_POLL_INTERVAL - (time.time() - last_home_poll)
            sleep_time = max(1.0, min(time_to_airnow, time_to_home))
            stop_event.wait(sleep_time)


def airnow_fetch_loop(
    *,
    app_state: AppState,
    interval_s: float = 1200.0,  # 20 minutes
    stop_event: threading.Event
) -> None:
    """Background loop to fetch AirNow hourly data every 20 minutes."""
    if not AIRNOW_AVAILABLE:
        return
    
    # First iteration waits the full interval (initial fetch already done at startup)
    stop_event.wait(interval_s)
    
    while not stop_event.is_set():
        try:
            _fetch_airnow_data(app_state)
        except Exception as e:
            _log(f"[AirNow] Fetch error: {type(e).__name__}: {e}")
        
        stop_event.wait(interval_s)


def _fetch_airnow_data(app_state: AppState) -> None:
    """Fetch AirNow site metadata and hourly readings."""
    now = time.time()
    
    # Fetch site metadata (once, or refresh occasionally)
    with app_state.lock:
        sites_empty = not app_state.airnow_sites
    
    if sites_empty:
        try:
            _log("[AirNow] Fetching site metadata...")
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
            
            _log(f"[AirNow] Loaded {len(sites_by_id)} SLC-area sites")
        except Exception as e:
            _log(f"[AirNow] Error fetching sites: {e}")
    
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
            _log("[AirNow] No hours to fetch")
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
        
        _log(f"[AirNow] Updated {len(all_readings)} sites with hourly data")
        
        # Extract wind data from the most recent hour (SLC area only)
        try:
            with app_state.lock:
                sorted_hours = sorted(app_state.airnow_readings_by_hour.keys())
            if sorted_hours:
                latest_hour = sorted_hours[-1]
                with app_state.lock:
                    latest_readings = app_state.airnow_readings_by_hour.get(latest_hour, [])
                # Filter to SLC area for wind - valley floor conditions during inversion
                try:
                    sites = fetch_monitoring_sites()
                    slc_site_ids = get_slc_site_ids(sites)
                    slc_readings = filter_slc_hourly(latest_readings, slc_site_ids)
                except Exception:
                    slc_readings = latest_readings  # Fallback to all Utah
                wind_data = extract_wind_data(slc_readings)
                with app_state.lock:
                    app_state.wind_data = wind_data
                if wind_data.get("wind_speed") is not None:
                    _log(f"[AirNow] Wind: {wind_data.get('wind_speed_mph', 0):.1f} mph from {wind_data.get('wind_dir_cardinal', '?')} (gust level {wind_data.get('gust_level', 0)}, {wind_data.get('stations', 0)} SLC stations)")
        except Exception as e:
            _log(f"[AirNow] Wind extraction error: {e}")
        
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
        _log(f"[AirNow] Error fetching hourly data: {e}")


def apply_sensor_names_inplace(state: dict[str, Any], custom_names: dict[str, Any]) -> bool:
    if not isinstance(state, dict) or not isinstance(custom_names, dict): return False
    changed = False
    for key in ("mobile", "fixed"):
        for it in state.get(key, []):
            sid = it.get("id")
            new_name = custom_names.get(sid)
            if not new_name:
                continue  # No custom name for this sensor — keep existing name
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
    if file_size == 0:
        return None  # Empty file treated as not found
    if file_size > MAX_SNAPSHOT_SIZE_BYTES:
        raise JsonValidationError(f"Snapshot file too large: {file_size} bytes")
    
    # Read raw bytes and sanitize (never parse without sanitization)
    raw_bytes = filepath.read_bytes()
    sanitized = parse_and_sanitize_json(raw_bytes, max_size=MAX_SNAPSHOT_SIZE_BYTES)
    
    # Validate schema
    validate_state_schema(sanitized)
    
    return sanitized

def make_handler(*, app_state: AppState, static_dir: Path, data_dir: Path, server_config: dict | None = None):
    """Create HTTP request handler with injected dependencies.
    
    Args:
        app_state: Shared application state
        static_dir: Path to static files (dashboard/)
        data_dir: Path to data directory (~/.mobileair)
        server_config: Server configuration for /api/config endpoint
    """
    # Default config for backwards compatibility
    if server_config is None:
        server_config = {
            "dataMode": "proxy",
            "apiBaseUrl": "/api",
            "cacheTtl": 30,
            "version": "1.0.0",
        }
    
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
        
        def _send(self, code: int, body: bytes, content_type: str, cache_control: str | None = None):
            """Send HTTP response with optional cache control.
            
            Args:
                code: HTTP status code
                body: Response body bytes
                content_type: Content-Type header value
                cache_control: Optional Cache-Control header value. If None, defaults to "no-store, max-age=0".
                              For CDN caching, use values like:
                              - "public, max-age=30, s-maxage=30" for API data (30s edge cache)
                              - "public, max-age=300" for config (5min cache)
                              - "public, max-age=86400, immutable" for static assets with cache-busting
            """
            if cache_control is None:
                cache_control = "no-store, max-age=0"
            try:
                self.send_response(code)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", cache_control)
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
            # Strip query string for path matching (cache-busting params like ?v=123)
            path_no_query = self.path.split('?')[0]
            
            # Static HTML - short cache, may change frequently during development
            if path_no_query in ("/", "/index.html"):
                return self._send(200, (static_dir / "index.html").read_bytes(), "text/html", cache_control="public, max-age=300")
            # JavaScript assets - serve any .js file from dashboard dir
            # Cache for 1 day (use cache-busting query params like ?v=20260205 for updates)
            if path_no_query.endswith(".js") and "/" not in path_no_query.lstrip("/"):
                js_file = static_dir / path_no_query.lstrip("/")
                if js_file.exists():
                    return self._send(200, js_file.read_bytes(), "text/javascript", cache_control="public, max-age=86400")
            # CSS - cache for 1 day
            if path_no_query == "/styles.css":
                return self._send(200, (static_dir / "styles.css").read_bytes(), "text/css", cache_control="public, max-age=86400")
            if path_no_query == "/manifest.json":
                # Generate manifest dynamically with explicit http:// URL for PWA
                host_header = self.headers.get("Host", "localhost:8765")
                base_url = f"http://{host_header}"
                manifest = {
                    "name": "DustyTrails",
                    "short_name": "DustyTrails",
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
            # Icons - cache for 1 week (rarely change)
            if self.path == "/icon.svg":
                return self._send(200, (static_dir / "icon.svg").read_bytes(), "image/svg+xml", cache_control="public, max-age=604800, immutable")
            if self.path.startswith("/icon-") and self.path.endswith(".png"):
                fname = self.path.lstrip("/")
                fpath = static_dir / fname
                if fpath.exists():
                    return self._send(200, fpath.read_bytes(), "image/png", cache_control="public, max-age=604800, immutable")
            # TUI interface files
            if self.path == "/tui.html":
                return self._send(200, (static_dir / "tui.html").read_bytes(), "text/html", cache_control="public, max-age=300")
            if self.path == "/tui.css":
                return self._send(200, (static_dir / "tui.css").read_bytes(), "text/css", cache_control="public, max-age=86400")
            if self.path == "/tui.js":
                return self._send(200, (static_dir / "tui.js").read_bytes(), "text/javascript", cache_control="public, max-age=86400")
            if self.path.startswith("/api/config"):
                # Return server configuration for client scaling/caching decisions
                # Cache for 5 minutes - config changes rarely
                body = json.dumps(server_config).encode("utf-8")
                return self._send(200, body, "application/json", cache_control="public, max-age=300")
            if self.path.startswith("/api/state"):
                # Short edge cache - data must stay fresh
                with app_state.lock:
                    _ensure_force_refresh_seq_cached(app_state)
                    return self._send(200, app_state.cached_json_bytes, "application/json", cache_control="public, max-age=15, s-maxage=30")
            if self.path.startswith("/api/fixed"):
                # Return just the fixed sensor array (lightweight for TUI remote mode)
                with app_state.lock:
                    fixed = app_state.state.get("fixed", []) if isinstance(app_state.state, dict) else []
                body = json.dumps(fixed).encode("utf-8")
                return self._send(200, body, "application/json", cache_control="public, max-age=15")
            if self.path.startswith("/api/raw"):
                # Return raw Utah AQ data for TUI remote mode
                with app_state.lock:
                    raw = {"mobile": app_state.raw_mobile, "fixed": app_state.raw_fixed}
                return self._send(200, json.dumps(raw).encode("utf-8"), "application/json")
            if self.path.startswith("/api/tui"):
                return self._handle_tui_state()
            if self.path.startswith("/api/history"):
                return self._handle_history_request()
            if self.path.startswith("/api/match_segment"):
                return self._handle_match_segment()
            if self.path.startswith("/api/road_edges"):
                return self._handle_road_edges()
            if self.path.startswith("/api/tram_line_edges"):
                return self._handle_tram_line_edges()
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
            
            # Parse optional client-provided day boundaries (4 AM local → next 4 AM local)
            client_start_ms = None
            client_end_ms = None
            try:
                s = query.get("start_ms", [None])[0]
                e = query.get("end_ms", [None])[0]
                if s is not None and e is not None:
                    client_start_ms = int(s)
                    client_end_ms = int(e)
            except (ValueError, TypeError):
                pass
            
            try:
                result = fetch_historical_day(date_str, app_state=app_state, data_dir=data_dir, start_ms=client_start_ms, end_ms=client_end_ms)
                body = json.dumps(result).encode("utf-8")
                return self._send(200, body, "application/json")
            except Exception as e:
                body = json.dumps({"error": str(e)}).encode("utf-8")
                return self._send(500, body, "application/json")

        def _handle_match_segment(self):
            """Road-match a trail segment for a sensor during playback.
            
            Query params:
                sensor: Sensor ID (e.g., BUS11)
                from_ms: Start timestamp (epoch ms)
                to_ms: End timestamp (epoch ms)
                trail: JSON-encoded trail points to match
            
            Returns matched trail segment with waypoints added.
            """
            from urllib.parse import urlparse, parse_qs
            query = parse_qs(urlparse(self.path).query)
            
            sensor_id = query.get("sensor", [None])[0]
            from_ms_str = query.get("from_ms", [None])[0]
            to_ms_str = query.get("to_ms", [None])[0]
            trail_json = query.get("trail", [None])[0]
            
            if not sensor_id or not trail_json:
                return self._send(400, b'{"error": "sensor and trail required"}', "application/json")
            
            try:
                trail = json.loads(trail_json)
                if not isinstance(trail, list):
                    raise ValueError("trail must be a list")
            except (json.JSONDecodeError, ValueError) as e:
                body = json.dumps({"error": f"Invalid trail: {e}"}).encode("utf-8")
                return self._send(400, body, "application/json")
            
            # Determine which graph to use based on vehicle type
            sid = sensor_id.upper()
            is_trax = sid.startswith("TRX") or sid.startswith("TRAX")
            
            if is_trax:
                # TRX: Use tram line graph ONLY
                graph = get_cached_tram_line_graph()
                snap_distance = 50.0
            else:
                # Buses: Use road graph
                graph = get_cached_road_graph()
                snap_distance = 75.0
            
            if not graph:
                # No appropriate graph, return original trail unchanged
                body = json.dumps({"sensor": sensor_id, "trail": trail}).encode("utf-8")
                return self._send(200, body, "application/json")
            
            try:
                from mobileair.roads import snap_points_to_roads
                matched = snap_points_to_roads(trail, graph, max_snap_m=snap_distance)
                result_trail = matched if matched else trail
            except Exception:
                result_trail = trail
            
            body = json.dumps({"sensor": sensor_id, "trail": result_trail}).encode("utf-8")
            return self._send(200, body, "application/json")

        def _handle_road_edges(self):
            """Return road graph edges for debug visualization.
            
            Query params:
                minLat, maxLat, minLon, maxLon: Bounding box to filter edges
                limit: Maximum number of edges to return (default 5000)
            
            Returns JSON array of edges: [{lat1, lon1, lat2, lon2}, ...]
            """
            from urllib.parse import urlparse, parse_qs
            query = parse_qs(urlparse(self.path).query)
            
            min_lat = float(query.get("minLat", ["-90"])[0])
            max_lat = float(query.get("maxLat", ["90"])[0])
            min_lon = float(query.get("minLon", ["-180"])[0])
            max_lon = float(query.get("maxLon", ["180"])[0])
            limit = int(query.get("limit", ["5000"])[0])
            
            road_graph = get_cached_road_graph()
            if not road_graph:
                return self._send(200, b'{"edges": []}', "application/json")
            
            edges = []
            seen = set()
            
            for i, (lat, lon) in enumerate(road_graph.nodes):
                # Skip nodes outside bounding box
                if lat < min_lat or lat > max_lat or lon < min_lon or lon > max_lon:
                    continue
                
                for j, _ in road_graph.adj[i]:
                    # Avoid duplicates (edges are bidirectional)
                    edge_key = (min(i, j), max(i, j))
                    if edge_key in seen:
                        continue
                    seen.add(edge_key)
                    
                    lat2, lon2 = road_graph.nodes[j]
                    edges.append({
                        "lat1": lat, "lon1": lon,
                        "lat2": lat2, "lon2": lon2
                    })
                    
                    if len(edges) >= limit:
                        break
                
                if len(edges) >= limit:
                    break
            
            body = json.dumps({"edges": edges}).encode("utf-8")
            return self._send(200, body, "application/json")

        def _handle_tram_line_edges(self):
            """Return tram line graph edges for debug visualization.
            
            Query params:
                minLat, maxLat, minLon, maxLon: Bounding box to filter edges
                limit: Maximum number of edges to return (default 5000)
            
            Returns JSON: {
                "edges": [{lat1, lon1, lat2, lon2, elev1?, elev2?}, ...],
                "has_elevation": bool
            }
            """
            from urllib.parse import urlparse, parse_qs
            query = parse_qs(urlparse(self.path).query)
            
            min_lat = float(query.get("minLat", ["-90"])[0])
            max_lat = float(query.get("maxLat", ["90"])[0])
            min_lon = float(query.get("minLon", ["-180"])[0])
            max_lon = float(query.get("maxLon", ["180"])[0])
            limit = int(query.get("limit", ["5000"])[0])
            
            tram_graph = get_cached_tram_line_graph()
            if not tram_graph:
                return self._send(200, b'{"edges": [], "has_elevation": false}', "application/json")
            
            has_elev = tram_graph.elevations is not None and len(tram_graph.elevations) > 0
            edges = []
            seen = set()
            
            for i, (lat, lon) in enumerate(tram_graph.nodes):
                # Skip nodes outside bounding box
                if lat < min_lat or lat > max_lat or lon < min_lon or lon > max_lon:
                    continue
                
                for j, _ in tram_graph.adj[i]:
                    # Avoid duplicates (edges are bidirectional)
                    edge_key = (min(i, j), max(i, j))
                    if edge_key in seen:
                        continue
                    seen.add(edge_key)
                    
                    lat2, lon2 = tram_graph.nodes[j]
                    edge = {
                        "lat1": lat, "lon1": lon,
                        "lat2": lat2, "lon2": lon2
                    }
                    
                    # Add elevation if available
                    if has_elev:
                        edge["elev1"] = tram_graph.elevations[i]
                        edge["elev2"] = tram_graph.elevations[j]
                    
                    edges.append(edge)
                    
                    if len(edges) >= limit:
                        break
                
                if len(edges) >= limit:
                    break
            
            body = json.dumps({"edges": edges, "has_elevation": has_elev}).encode("utf-8")
            return self._send(200, body, "application/json")

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
    parser = argparse.ArgumentParser(description="DustyTrails dashboard server")
    parser.add_argument("--host", default="0.0.0.0", help="Host to bind to")
    parser.add_argument("--port", type=int, default=8765, help="Port to listen on")
    parser.add_argument("--https", action="store_true", help="Enable HTTPS with self-signed cert")
    parser.add_argument("--cert", default="", help="Path to TLS certificate")
    parser.add_argument("--key", default="", help="Path to TLS private key")
    parser.add_argument("--interval", type=float, default=60.0, help="Data fetch interval in seconds")
    parser.add_argument(
        "--data-mode",
        choices=["proxy", "direct"],
        default="proxy",
        help="Data mode: 'proxy' = clients fetch via server API (default), 'direct' = clients fetch from .edu/.gov directly"
    )
    args = parser.parse_args()
    
    # Build server config for /api/config endpoint
    server_config = {
        "dataMode": args.data_mode,
        "apiBaseUrl": "/api",
        "cacheTtl": 30,
        "version": "1.0.0",
    }

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
    _log(f"[FixedHistory] Loaded {len(app_state.fixed_history)} sensors from history")
    
    # Load today's snapshot to restore trail history on restart
    load_today_snapshot(app_state, data_dir)
    
    stop_event = threading.Event()

    threading.Thread(target=fetch_loop, kwargs=dict(app_state=app_state, data_dir=data_dir, interval_s=args.interval, stop_event=stop_event), daemon=True).start()
    threading.Thread(target=watch_sensor_names_loop, kwargs=dict(app_state=app_state, data_dir=data_dir, stop_event=stop_event), daemon=True).start()
    
    # Start AirNow hourly data fetch loop (20-minute interval)
    if AIRNOW_AVAILABLE:
        # Eager initial fetch so AirNow sensor names/data are available on first poll
        try:
            _log("[AirNow] Performing initial fetch...")
            _fetch_airnow_data(app_state)
            _log(f"[AirNow] Initial fetch complete ({len(app_state.airnow_sites)} sites, {len(app_state.airnow_readings)} readings)")
        except Exception as e:
            _log(f"[AirNow] Initial fetch error (will retry in background): {e}")
        threading.Thread(
            target=airnow_fetch_loop,
            kwargs=dict(app_state=app_state, interval_s=1200.0, stop_event=stop_event),
            daemon=True
        ).start()
        _log("[AirNow] Hourly data integration enabled (20-min refresh)")
    else:
        _log("[AirNow] Integration not available (airnow_slc.py not found)")

    # Start PurpleAir fetch loop (5-minute interval)
    threading.Thread(
        target=purpleair_fetch_loop,
        kwargs=dict(app_state=app_state, interval_s=300.0, stop_event=stop_event),
        daemon=True
    ).start()
    _log("[PurpleAir] SLC sensor integration enabled (5-min refresh)")

    _log("[HistoryPrefetch] Enabled (runs inside fetch_loop)")

    httpd = ThreadingHTTPServer((args.host, args.port), make_handler(app_state=app_state, static_dir=static_dir, data_dir=data_dir, server_config=server_config))
    # Timeout for individual requests - helps with Safari/iOS connection issues
    httpd.timeout = 30

    # Allow a local controller process (e.g., the TUI) to request a force-refresh
    # without any new HTTP endpoint: `kill -USR1 <pid>`.
    try:
        if hasattr(signal, "SIGUSR1"):
            signal.signal(signal.SIGUSR1, lambda *_: bump_force_refresh_seq(app_state))
    except Exception:
        pass
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
        # Save today's snapshot on graceful shutdown
        save_today_snapshot(app_state, data_dir)
        save_fixed_history(app_state)
        httpd.shutdown()
    return 0


def start_server_in_thread(host: str = "0.0.0.0", port: int = 8766, interval: float = 60.0) -> tuple[threading.Event, ThreadingHTTPServer]:
    """Start the dashboard server in a background thread.
    
    Returns (stop_event, httpd) so the caller can stop it later.
    Used when running as a bundled executable where subprocess isn't available.
    """
    global _quiet_mode
    _quiet_mode = True  # Suppress stdout to avoid interfering with Textual TUI
    
    data_dir = default_data_dir()
    data_dir.mkdir(parents=True, exist_ok=True)
    static_dir = _get_bundle_dir() / "dashboard"

    app_state = AppState(
        lock=threading.Lock(),
        state={"ts": time.time(), "mobile": [], "fixed": [], "meta": {"server_start_ts": time.time()}},
        persistent_mobile={},
    )
    
    load_fixed_history(app_state, data_dir)
    
    # Load today's snapshot to restore trail history on restart
    load_today_snapshot(app_state, data_dir)
    
    stop_event = threading.Event()

    threading.Thread(target=fetch_loop, kwargs=dict(app_state=app_state, data_dir=data_dir, interval_s=interval, stop_event=stop_event), daemon=True).start()
    threading.Thread(target=watch_sensor_names_loop, kwargs=dict(app_state=app_state, data_dir=data_dir, stop_event=stop_event), daemon=True).start()
    
    if AIRNOW_AVAILABLE:
        try:
            _fetch_airnow_data(app_state)
        except Exception:
            pass
        threading.Thread(
            target=airnow_fetch_loop,
            kwargs=dict(app_state=app_state, interval_s=1200.0, stop_event=stop_event),
            daemon=True
        ).start()

    threading.Thread(
        target=purpleair_fetch_loop,
        kwargs=dict(app_state=app_state, interval_s=120.0, stop_event=stop_event),
        daemon=True
    ).start()

    # Default config for in-process server (TUI mode)
    server_config = {
        "dataMode": "proxy",
        "apiBaseUrl": "/api",
        "cacheTtl": 30,
        "version": "1.0.0",
    }
    httpd = ThreadingHTTPServer((host, port), make_handler(app_state=app_state, static_dir=static_dir, data_dir=data_dir, server_config=server_config))
    # Timeout for individual requests - helps with Safari/iOS connection issues
    httpd.timeout = 30

    # Expose app_state and data_dir for in-process callers (for shutdown save).
    try:
        setattr(httpd, "app_state", app_state)
        setattr(httpd, "data_dir", data_dir)
    except Exception:
        pass
    
    def serve():
        try:
            httpd.serve_forever()
        except Exception:
            pass
        finally:
            stop_event.set()
            # Save today's snapshot on shutdown
            try:
                save_today_snapshot(app_state, data_dir)
                save_fixed_history(app_state)
            except Exception:
                pass
    
    server_thread = threading.Thread(target=serve, daemon=True)
    server_thread.start()
    
    return stop_event, httpd


if __name__ == "__main__":
    main()