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
import hashlib
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
from zoneinfo import ZoneInfo

_MOUNTAIN_TZ = ZoneInfo("America/Denver")


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
    color_to_idx,
    MOBILE_URL,
    FIXED_URL,
    HEADERS,
)
from mobileair.dashboard import _pick_worst_reading_by_aqi
from mobileair.trails import clean_trail
from mobileair.dirigera_home import HOME_LAT, HOME_LON

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


# ─────────────────────────────────────────────────────────────────────────────
# Geo-IP visitor logging
# Logs city/region/country to ~/.mobileair/visitors.log on each unique page load.
# The raw IP address is NEVER written to disk — only the resolved location.
# ─────────────────────────────────────────────────────────────────────────────

# In-memory de-duplicate cache: maps sha256(ip) → last-logged epoch (seconds).
# Prevents re-logging the same visitor within GEO_IP_CACHE_TTL_S seconds.
_geo_ip_cache: dict[str, float] = {}
_geo_ip_cache_lock = threading.Lock()
GEO_IP_CACHE_TTL_S = 3600  # 1 hour


def _resolve_client_ip(headers, client_address: tuple) -> str:
    """Return the real client IP, preferring X-Forwarded-For (set by Caddy)."""
    xff = headers.get("X-Forwarded-For", "").split(",")[0].strip()
    if xff:
        return xff
    return client_address[0]


def _log_visitor_geo(ip: str, data_dir: Path) -> None:
    """Background worker: geo-resolve *ip* and append location to visitors.log.
    The IP address is used only for the API call and is never persisted."""
    try:
        import urllib.request
        import urllib.error
        # Resolve geo location — city/region/country only, no ISP or ASN.
        url = f"http://ip-api.com/json/{ip}?fields=status,country,regionName,city,timezone"
        with urllib.request.urlopen(url, timeout=5) as resp:
            data = json.loads(resp.read().decode())
        if data.get("status") != "success":
            return
        country  = data.get("country", "Unknown")
        region   = data.get("regionName", "")
        city     = data.get("city", "")
        tz       = data.get("timezone", "")
        # Build a readable location string, omitting empty parts.
        parts = [p for p in [city, region, country] if p]
        location = ", ".join(parts) if parts else "Unknown"
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        line = f"{ts}  |  {location}  |  tz:{tz}\n"
        log_path = data_dir / "visitors.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(log_path, "a", encoding="utf-8") as fh:
            fh.write(line)
    except Exception:
        pass  # Never let logging errors affect the server


def maybe_log_visitor(headers, client_address: tuple, data_dir: Path) -> None:
    """Fire-and-forget geo-IP log for a page-load request.

    De-duplicates by IP within GEO_IP_CACHE_TTL_S so one person refreshing
    the page doesn't spam the log or the upstream API.
    """
    ip = _resolve_client_ip(headers, client_address)
    # Skip loopback / private network hits — those are local/dev.
    if ip in ("127.0.0.1", "::1") or ip.startswith("192.168.") or ip.startswith("10."):
        return
    # Use a hash so the IP never lives in a data structure that could be logged.
    ip_hash = hashlib.sha256(ip.encode()).hexdigest()
    now = time.monotonic()
    with _geo_ip_cache_lock:
        last = _geo_ip_cache.get(ip_hash, 0.0)
        if now - last < GEO_IP_CACHE_TTL_S:
            return
        _geo_ip_cache[ip_hash] = now
    # Do the network call off the request thread.
    threading.Thread(
        target=_log_visitor_geo,
        args=(ip, data_dir),
        daemon=True,
    ).start()


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
    purpleair_meta_last_fetch: float = 0.0  # last time we fetched name/lat/lon
    purpleair_last_seen_cache: dict[int, int] = field(default_factory=dict)  # sensor_index -> last_seen timestamp
    purpleair_pm25_cache: dict[int, float] = field(default_factory=dict)  # sensor_index -> last known pm2.5 value

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

    # Cached MT-day prefixes for fast history filtering (recomputed once per day)
    _today_mt_date: str = ""
    _today_mt_prefixes: tuple[str, ...] = ()

    # Bumped on-demand (e.g., from the TUI) to force the web client to treat the
    # next /api/state poll as a "new data" event even if timestamps/trails are unchanged.
    force_refresh_seq: int = 0

    # Monotonic counter bumped on EVERY state mutation (fetch loop, PurpleAir,
    # Home sensor, force-refresh).  Used as the ETag so clients skip unchanged
    # payloads via 304 regardless of which subsystem triggered the change.
    state_seq: int = 0

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
        app_state.state_seq = int(getattr(app_state, "state_seq", 0) or 0) + 1
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
    # Deduplicate each history list by time key.  The fixed_history.json can
    # accumulate duplicate timestamp entries when the server restarts and
    # re-fetches already-cached hours (the previous dedup only checked the
    # last list entry, so out-of-order re-inserts slipped through).  Scrub on
    # load so front-ends never see the sawtooth pattern in stored data.
    deduped_any = False
    for sensor_id, pols in app_state.fixed_history.items():
        if not isinstance(pols, dict):
            continue
        for param, entries in pols.items():
            if not isinstance(entries, list):
                continue
            seen: dict[str, dict] = {}
            for e in entries:
                t = e.get("time")
                if t:
                    seen[t] = e  # later entry wins (most recent correction)
                else:
                    # no time key — keep via a unique fallback key
                    seen[f"__no_time_{id(e)}"] = e
            if len(seen) != len(entries):
                pols[param] = list(seen.values())
                deduped_any = True
    if deduped_any:
        app_state.fixed_history_dirty = True  # flush scrubbed version to disk


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
    today_str = datetime.now(_MOUNTAIN_TZ).strftime("%Y-%m-%d")
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


def _utc_date_prefixes_for_mt_day(day_mt: datetime) -> tuple[str, ...]:
    """Return the 1-2 UTC date prefixes that cover a Mountain-time day.

    A single MT day (midnight to midnight) spans at most two UTC dates because
    MT is UTC-7 (or UTC-6 during DST).  For example, MT March 1 spans
    2026-03-01T07:00Z to 2026-03-02T07:00Z, so both "2026-03-01" and
    "2026-03-02" are valid UTC date prefixes.

    Using prefix matching instead of per-entry datetime parsing keeps the
    hot-path O(1) per entry (critical on Raspberry Pi with thousands of
    history entries every fetch cycle).
    """
    start_utc = day_mt.astimezone(timezone.utc)
    end_utc = (day_mt + timedelta(days=1)).astimezone(timezone.utc)
    d1 = start_utc.strftime("%Y-%m-%d")
    d2 = end_utc.strftime("%Y-%m-%d")
    return (d1, d2) if d1 != d2 else (d1,)


def _trim_history_to_date(state: dict[str, Any], date_str: str) -> None:
    """Strip history entries from fixed sensors that don't belong to date_str.

    Fixed sensor history arrays (history_values, history_colors, history_times)
    can span multiple days because fixed_history accumulates 48 hours of data.
    Before saving a snapshot we trim them to only the entries from date_str so
    loading a snapshot never shows data from other days.

    Timestamps are UTC but date_str is a Mountain-time date, so we accept any
    UTC date that falls within the MT day (at most 2 UTC dates due to offset).
    """
    try:
        day_mt = datetime.strptime(date_str, "%Y-%m-%d").replace(
            hour=0, minute=0, second=0, microsecond=0, tzinfo=_MOUNTAIN_TZ)
    except (ValueError, TypeError):
        return
    prefixes = _utc_date_prefixes_for_mt_day(day_mt)

    for sensor in (state.get("fixed") or []):
        if not isinstance(sensor, dict):
            continue
        if sensor.get("purpleair"):
            continue  # PA history is already day-scoped; skip expensive iteration
        for reading in (sensor.get("readings") or {}).values():
            if not isinstance(reading, dict):
                continue
            times = reading.get("history_times")
            values = reading.get("history_values") or reading.get("history")
            colors = reading.get("history_colors")
            if not isinstance(times, list):
                continue
            # Fast prefix check: keep entries whose UTC date is one of the
            # (at most 2) dates that cover this Mountain-time day.
            keep = [i for i, t in enumerate(times)
                    if isinstance(t, str) and t[:10] in prefixes]
            reading["history_times"]  = [times[i]  for i in keep]
            reading["history"]        = [values[i] for i in keep] if isinstance(values, list) and len(values) == len(times) else []
            reading["history_colors"] = [colors[i] for i in keep] if isinstance(colors, list) and len(colors) == len(times) else []


def _trim_trails_to_day(state: dict[str, Any], date_str: str) -> None:
    """Filter mobile sensor trails to the 5 AM – 5 AM MST window for date_str.

    The "day" for air-quality purposes runs from 5:00 AM Mountain on date_str
    to 5:00 AM Mountain on the following day, matching the client-side live
    playback window in map_view.js.  Trail timestamps use mixed formats
    ("2026-02-28 21:08:30 UTC", "2026-02-28T21:08:30Z") so we parse each
    with parse_utc_timestamp and compare datetimes.
    """
    try:
        requested_date = datetime.strptime(date_str, "%Y-%m-%d")
    except (ValueError, TypeError):
        return

    # 5 AM MT boundaries as UTC datetimes.
    # Trail timestamps come in multiple formats ("2026-02-28 21:08:30 UTC",
    # "2026-02-28T21:08:30Z", etc.) so lexicographic string comparison is
    # unreliable.  Parse each point with parse_utc_timestamp instead.
    day_start_utc = requested_date.replace(hour=5, minute=0, second=0, microsecond=0,
                                           tzinfo=_MOUNTAIN_TZ).astimezone(timezone.utc)
    day_end_utc = (day_start_utc + timedelta(hours=24))

    for sensor in (state.get("mobile") or []):
        if not isinstance(sensor, dict):
            continue
        trail = sensor.get("trail")
        if not isinstance(trail, list):
            continue
        filtered = []
        for p in trail:
            if not isinstance(p, dict):
                continue
            dt = parse_utc_timestamp(p.get("t"))
            if dt is None:
                continue
            if day_start_utc <= dt < day_end_utc:
                filtered.append(p)
        sensor["trail"] = filtered


def _trim_state_to_window(state: dict[str, Any], window_start_utc: datetime, window_end_utc: datetime) -> None:
    """Trim mobile trails and fixed history to a UTC time window.

    Used by the embed/widget loader to send only the data needed for the
    requested playback window instead of the entire day's snapshot.
    """
    for sensor in (state.get("mobile") or []):
        if not isinstance(sensor, dict):
            continue
        trail = sensor.get("trail")
        if not isinstance(trail, list):
            continue
        filtered = []
        for p in trail:
            if not isinstance(p, dict):
                continue
            dt = parse_utc_timestamp(p.get("t"))
            if dt is None:
                continue
            if window_start_utc <= dt < window_end_utc:
                filtered.append(p)
        sensor["trail"] = filtered

    # Trim fixed sensor history to the window as well
    for sensor in (state.get("fixed") or []):
        if not isinstance(sensor, dict):
            continue
        for reading in (sensor.get("readings") or {}).values():
            if not isinstance(reading, dict):
                continue
            times = reading.get("history_times")
            values = reading.get("history")
            hci = reading.get("hci")
            if not isinstance(times, list):
                continue
            keep = [i for i, t in enumerate(times)
                    if isinstance(t, str) and
                    (lambda dt: dt is not None and window_start_utc <= dt < window_end_utc)(parse_utc_timestamp(t))]
            reading["history_times"] = [times[i] for i in keep]
            if isinstance(values, list) and len(values) == len(times):
                reading["history"] = [values[i] for i in keep]
            if isinstance(hci, list) and len(hci) == len(times):
                reading["hci"] = [hci[i] for i in keep]


def save_today_snapshot(app_state: AppState, data_dir: Path) -> bool:
    """Save current state as today's snapshot.

    Called on graceful shutdown to persist the accumulated trail data.
    Returns True if saved successfully, False otherwise.
    """
    today_str = datetime.now(_MOUNTAIN_TZ).strftime("%Y-%m-%d")
    try:
        with app_state.lock:
            state_bytes = app_state.cached_json_bytes
            if not state_bytes:
                return False
            state = json.loads(state_bytes.decode("utf-8"))

        # Validate there's something worth saving
        mobiles = state.get("mobile", [])
        if not isinstance(mobiles, list) or not mobiles:
            _log("[Snapshot] Nothing to save (no mobile sensors)")
            return False

        total_points = sum(len(m.get("trail", [])) for m in mobiles if isinstance(m, dict))
        if total_points < 10:
            _log("[Snapshot] Not enough data to save (fewer than 10 trail points)")
            return False

        # Trim everything to today's 5 AM–5 AM MST window before saving
        # so loaded snapshots are already clean and need no re-filtering.
        _trim_trails_to_day(state, today_str)
        _trim_history_to_date(state, today_str)

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
            elif med <= 0 and fv >= floor:
                # When median is 0 (e.g. nighttime ozone), any reading above
                # the absolute floor is suspicious.  The floor alone (100 ppb
                # for OZNE) is a generous ceiling; no need to multiply by
                # ratio_thresh which made the threshold unreachably high.
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
    
    bounds = {"PM25": (0.0, 999.0), "PM10": (0.0, 2000.0), "OZNE": (0.0, 200.0)}
    
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
    is_pa = sensor_id.startswith("PA_")

    # Dedupe: skip if same value and time as last entry.
    # For PurpleAir sensors (accumulated every 30s from main loop), use
    # value-only dedup with a minimum time gap to prevent flooding history.
    if hist:
        last = hist[-1]
        if is_pa:
            # PA: skip if same value AND less than 5 minutes since last entry
            elapsed = now_ts - (last.get("recorded_at") or 0)
            if last.get("val") == str(value) and elapsed < 300:
                return
        elif sensor_id.startswith("AIRNOW_"):
            # AirNow: deduplicate by time across the entire list to prevent
            # re-fetched hours (e.g. after restart) from creating sawtooth
            # duplicates at historic positions.
            if time_utc and any(e.get("time") == time_utc for e in hist):
                return
        else:
            if last.get("val") == str(value) and last.get("time") == time_utc:
                return

    # Append new reading
    hist.append({
        "val": str(value) if value is not None else None,
        "ci": color_to_idx(color),
        "time": time_utc,
        "recorded_at": now_ts,
    })

    # Keep history based on sensor type:
    # - Home sensor: 5760 entries (~48 hours at 30-second intervals) to span today + yesterday
    # - PurpleAir: no cap — all readings accumulate into the snapshot
    # - Utah sensors: 2880 entries (~24 hours at 5-10 min intervals spans days anyway)
    if not is_pa:
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


def _get_today_prefixes(app_state: AppState) -> tuple[str, ...]:
    """Return cached UTC date prefixes for the current Mountain-time day.

    Recomputes only when the MT date rolls over (once per day).
    """
    today_mt_str = datetime.now(_MOUNTAIN_TZ).strftime("%Y-%m-%d")
    if today_mt_str != app_state._today_mt_date:
        day_mt = datetime.now(_MOUNTAIN_TZ).replace(hour=0, minute=0, second=0, microsecond=0)
        app_state._today_mt_prefixes = _utc_date_prefixes_for_mt_day(day_mt)
        app_state._today_mt_date = today_mt_str
    return app_state._today_mt_prefixes


def _inject_fixed_history(app_state: AppState, st: dict[str, Any]) -> None:
    """Inject history arrays into fixed sensor readings from accumulated history.

    Only injects entries from today (Mountain time date) so stale multi-day
    history accumulated in fixed_history.json doesn't bleed into the live state.

    Timestamps are UTC but the "day" boundary is midnight Mountain Time.  A
    single MT day spans at most 2 UTC dates (e.g. MT March 1 → UTC March 1 +
    March 2), so we use fast string prefix matching on the first 10 chars
    instead of per-entry datetime parsing (critical on Raspberry Pi).
    """
    fixed_list = st.get("fixed", [])
    if not isinstance(fixed_list, list):
        return

    prefixes = _get_today_prefixes(app_state)

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

        # Reverse lookup: mapped key -> possible raw keys stored in history
        _REVERSE_PARAM = {"PM25": ["PM25", "PM2.5"], "OZNE": ["OZNE", "OZONE", "O3"],
                          "PM10": ["PM10"], "NO2": ["NO2"], "CO": ["CO"], "SO2": ["SO2"]}

        for pollutant, reading in readings.items():
            if not isinstance(reading, dict):
                continue
            if pollutant in _WEATHER_KEYS:
                continue

            # Try the exact key first, then equivalent raw-API spellings
            hist_entries = hist_for_sensor.get(pollutant, [])
            if not hist_entries:
                for alt in _REVERSE_PARAM.get(pollutant, ()):
                    hist_entries = hist_for_sensor.get(alt, [])
                    if hist_entries:
                        break
            if not hist_entries:
                continue

            # Only include entries from today — never inject stale history
            # from previous days that lingers in fixed_history.json
            history_values = []
            hci = []
            history_times = []

            for entry in hist_entries:
                t = entry.get("time") or ""
                if t[:10] not in prefixes:
                    continue
                val = entry.get("val")
                try:
                    fval = float(val) if val is not None else None
                    if fval is not None and fval == int(fval):
                        fval = int(fval)
                except (ValueError, TypeError):
                    fval = None
                history_values.append(fval)
                hci.append(color_to_idx(_get_aqi_color(pollutant, fval)) if fval is not None else 0)
                history_times.append(t)

            reading["history"] = history_values
            reading["hci"] = hci
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
            hci = []
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
                hci.append(color_to_idx(_get_aqi_color(pollutant, fv)) if fv is not None else 0)
                history_times.append(entry.get("time"))
            last_val = history_values[-1] if history_values else None
            last_ci = color_to_idx(_get_aqi_color(pollutant, last_val)) if last_val is not None else 0
            display_val = last_val
            if display_val is not None:
                try:
                    if float(display_val) == int(float(display_val)):
                        display_val = int(float(display_val))
                except (ValueError, TypeError):
                    pass
            readings[pollutant] = {
                "value": display_val, "ci": last_ci,
                "history": history_values, "hci": hci,
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
            "ci": worst.get("ci", 0),
            "primary_key": worst.get("key"),
            "primary_value": worst.get("value"),
            "pci": worst.get("ci"),
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
        road_graph=get_cached_road_graph(),
        tram_line_graph=get_cached_tram_line_graph(),
    )


# ─────────────────────────────────────────────────────────────────────────────
# Historical data fetching (week-long timeseries from CHPC) — DISABLED
# "Select Day" now loads from local snapshots instead of upstream servers.
# All upstream fetching, caching, lazy loading, and prefetch infrastructure
# is commented out since we already store this data locally from mobile,
# fixed, and PurpleAir sensor integrations.
# ─────────────────────────────────────────────────────────────────────────────

# HISTORY_BASE_URL = "https://utahaq.chpc.utah.edu/jsondata"
# HISTORY_SENSORS = [
#     "BUS01", "BUS02", "BUS03", "BUS04", "BUS05", "BUS06", "BUS07", "BUS08",
#     "BUS09", "BUS10", "BUS11", "BUS12", "BUS13", "BUS14", "BUS15",
#     "TRX01", "TRX02", "TRX03",
# ]
# HISTORY_VARS = ["GLAT", "GLON", "PM25", "PM10", "OZNE"]
#
# # In-memory cache for week-long history files (they change slowly)
# # Key: (sensor, var), Value: (fetch_time, data)
# _history_cache: dict[tuple[str, str], tuple[float, list, float]] = {}  # (fetch_time, data, ttl_seconds)
# _history_cache_lock = threading.Lock()
# _HISTORY_CACHE_TTL = 3600  # 1 hour
# _HISTORY_404_TTL = 86400   # 24 hours for 404s (not infinite — sensors may appear)
#
# # Track when history server was last known to be down (for fast-fail)
# _history_server_down_until = 0.0
#
#
# def _is_history_server_reachable() -> bool:
#     """Quick check if history server is reachable (2s timeout)."""
#     global _history_server_down_until
#     now = time.time()
#
#     # If we recently determined server is down, fast-fail
#     if now < _history_server_down_until:
#         return False
#
#     # HEAD request to a known file (lightweight, no body download)
#     import urllib.request
#     test_url = f"{HISTORY_BASE_URL}/BUS06_GLAT_TS_10080.json"
#     try:
#         req = urllib.request.Request(test_url, method='HEAD')
#         req.add_header("User-Agent", "MobileAir/1.0")
#         urllib.request.urlopen(req, timeout=2)
#         return True
#     except Exception:
#         _history_server_down_until = now + 60
#         return False
#
#
# def _fetch_history_file(sensor: str, var: str) -> list:
#     """Fetch a single history file with caching (thread-safe)."""
#     cache_key = (sensor, var)
#     now = time.time()
#
#     # Check cache (under lock for thread safety)
#     with _history_cache_lock:
#         if cache_key in _history_cache:
#             fetch_time, data, ttl = _history_cache[cache_key]
#             if now - fetch_time < ttl:
#                 return data
#
#     # Fetch from server (outside lock to avoid blocking other threads)
#     url = f"{HISTORY_BASE_URL}/{sensor}_{var}_TS_10080.json"
#     try:
#         resp = stdlib_get(url, timeout=3, headers=HEADERS)
#         resp.raise_for_status()
#         data = resp.json().get("TimeDataUTC", [])
#         with _history_cache_lock:
#             _history_cache[cache_key] = (now, data, _HISTORY_CACHE_TTL)
#         return data
#     except Exception as e:
#         is_404 = "404" in str(e)
#         if is_404:
#             # Cache 404s for 24 hours (sensors may appear later)
#             with _history_cache_lock:
#                 _history_cache[cache_key] = (now, [], _HISTORY_404_TTL)
#             return []
#         _log(f"[History] Failed to fetch {sensor}/{var}: {e}")
#         # On transient error, return stale cache if available, else empty
#         with _history_cache_lock:
#             if cache_key in _history_cache:
#                 return _history_cache[cache_key][1]
#         return []
#
#
# def _get_history_cache_dir(data_dir: Path) -> Path:
#     """Return the directory for cached historical day results."""
#     cache_dir = data_dir / "history_cache"
#     cache_dir.mkdir(parents=True, exist_ok=True)
#     return cache_dir
#
#
# def _load_cached_historical_day(data_dir: Path, date_str: str) -> dict[str, Any] | None:
#     """Load a cached historical day result from disk. Returns None if not cached."""
#     cache_dir = _get_history_cache_dir(data_dir)
#     safe_date = "".join(c for c in date_str if c.isalnum() or c == "-")
#     if not safe_date or len(safe_date) > 20:
#         return None
#     cache_file = cache_dir / f"{safe_date}.json"
#     if not cache_file.exists():
#         return None
#     try:
#         data = json.loads(cache_file.read_text(encoding="utf-8"))
#         if isinstance(data, dict) and isinstance(data.get("mobile"), list):
#             return data
#     except Exception as e:
#         _log(f"[History] Failed to load cache for {date_str}: {e}")
#     return None
#
#
# def _save_cached_historical_day(data_dir: Path, date_str: str, result: dict[str, Any]) -> None:
#     """Save a processed historical day result to disk cache."""
#     cache_dir = _get_history_cache_dir(data_dir)
#     safe_date = "".join(c for c in date_str if c.isalnum() or c == "-")
#     if not safe_date or len(safe_date) > 20:
#         return
#     cache_file = cache_dir / f"{safe_date}.json"
#     try:
#         cache_file.write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")
#         _log(f"[History] Cached day {date_str} ({cache_file.stat().st_size} bytes)")
#     except Exception as e:
#         _log(f"[History] Failed to cache {date_str}: {e}")


# def _apply_fixed_sensors_to_history(result, date_str, app_state, data_dir):
#     """DISABLED — snapshots already contain all fixed sensor data.
#     Previously reconstructed Home + DEQ + PurpleAir fixed sensors for upstream
#     historical day results. No longer needed since Select Day loads snapshots."""
#     pass


# def fetch_historical_day(date_str, app_state=None, data_dir=None, start_ms=None, end_ms=None):
#     """DISABLED — Select Day now loads from local snapshots.
#     Previously fetched week-long timeseries from CHPC upstream servers,
#     filtered to a specific day, and cached results on disk.
#     No longer needed since we already store all data locally."""
#     pass
#
# def _history_prefetch_loop(app_state, data_dir, stop_event):
#     """DISABLED — no upstream history data to prefetch.
#     Previously trickle-downloaded past 6 days from CHPC in the background.
#     No longer needed since Select Day loads from local snapshots."""
#     pass


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

        # Merge PurpleAir sensors into fixed sensors.
        # NOTE: PA history accumulation happens in purpleair_fetch_loop (not here)
        # to avoid flooding fixed_history with duplicate entries every 30s tick.
        if app_state.purpleair_sensors:
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
        app_state.state_seq += 1
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
        # if not (SLC_BOUNDS["lat_min"] <= lat <= SLC_BOUNDS["lat_max"] and
        #         SLC_BOUNDS["lon_min"] <= lon <= SLC_BOUNDS["lon_max"]):
        #     continue
        
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
                _pk = _pick_primary_key(airnow_readings_dict)
                _pci = airnow_readings_dict.get(_pk, {}).get("ci", 0) if _pk else 0
                fixed_list.append({
                    "id": f"AIRNOW_{site_id}",
                    "name": site_name,
                    "pinned": False,
                    "emoji": "🏛️",  # Government/EPA marker
                    "lat": lat,
                    "lon": lon,
                    "readings": airnow_readings_dict,
                    "ci": _pci,
                    "airnow_source": True,
                    "primary_key": _pk,
                    "primary_value": None,
                    "pci": _pci,
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

PURPLEAIR_API_KEY = os.environ.get("DUSTY_PURPLEAIR_API_KEY", "").strip()

# Owner token: when set, the Home sensor is only included in /api/state
# responses that carry a matching ?tok= query parameter.
OWNER_TOKEN = os.environ.get("DUSTY_OWNER_TOKEN", "").strip()
PURPLEAIR_API_URL = "https://api.purpleair.com/v1/sensors"


def _fetch_purpleair_sensors(fields: str = "pm2.5,last_seen",
                             sensor_indices: list[int] | None = None) -> list[dict[str, Any]]:
    """Fetch PurpleAir sensors in the SLC bounding box.

    *fields* controls which columns are requested.
    *sensor_indices* — if provided, uses the ``show_only`` parameter to fetch
    only those specific sensors (no bounding box needed).  Used for targeted
    neighbour refreshes so we don't burn points fetching the entire grid.
    """
    if sensor_indices is not None:
        # Targeted fetch: specific sensor indices only, no bbox
        params = {
            "fields": fields,
            "show_only": ",".join(str(i) for i in sensor_indices),
        }
    else:
        params = {
            "fields": fields,
            "nwlng": str(SLC_BOUNDS["lon_min"]),
            "nwlat": str(SLC_BOUNDS["lat_max"]),
            "selng": str(SLC_BOUNDS["lon_max"]),
            "selat": str(SLC_BOUNDS["lat_min"]),
            "location_type": "0",  # outdoor only
        }
    qs = "&".join(f"{k}={v}" for k, v in params.items())
    url = f"{PURPLEAIR_API_URL}?{qs}"
    if not PURPLEAIR_API_KEY:
        _log("[PurpleAir] DUSTY_PURPLEAIR_API_KEY not set — skipping fetch")
        return []
    try:
        resp = stdlib_get(url, timeout=10, headers={
            "X-API-Key": PURPLEAIR_API_KEY,
            "Accept": "application/json",
        })
        resp.raise_for_status()
        data = resp.json()
        fields_list = data.get("fields", [])
        results = []
        for row in data.get("data", []):
            sensor = dict(zip(fields_list, row))
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
                "ci": color_to_idx(color),
                "key": "PM2.5",
            }
        }

        fixed_list.append({
            "id": sid,
            "name": name,
            "pinned": False,
            "emoji": "",  # empty = render as dot, not emoji
            "lat": lat,
            "lon": lon,
            "readings": readings,
            "ci": color_to_idx(color),
            "purpleair": True,
            "primary_key": "PM25",
            "primary_value": round(pm25_val, 1),
            "pci": color_to_idx(color),
            "primary_aqi": None,
        })

    # ── Spatial thinning: keep one PurpleAir sensor per ~500 m grid cell ──
    # This prevents the map from being overwhelmed by dense clusters while
    # keeping the highest-reading sensor (most informative) in each cell.
    GRID_DEG = 0.005  # ~500 m at SLC latitude
    pa_cells: dict[tuple[int, int], int] = {}  # (grid_x, grid_y) → index into fixed_list
    drop_indices: set[int] = set()
    for i, f in enumerate(fixed_list):
        if not f.get("purpleair"):
            continue
        gx = int(f["lon"] / GRID_DEG)
        gy = int(f["lat"] / GRID_DEG)
        key = (gx, gy)
        if key in pa_cells:
            prev_i = pa_cells[key]
            prev_val = fixed_list[prev_i].get("primary_value", 0) or 0
            cur_val = f.get("primary_value", 0) or 0
            if cur_val > prev_val:
                drop_indices.add(prev_i)
                pa_cells[key] = i
            else:
                drop_indices.add(i)
        else:
            pa_cells[key] = i
    if drop_indices:
        fixed_list = [f for i, f in enumerate(fixed_list) if i not in drop_indices]

    st["fixed"] = fixed_list


def purpleair_fetch_loop(
    *,
    app_state: AppState,
    data_dir: Path,
    stop_event: threading.Event,
) -> None:
    """Background loop to fetch PurpleAir sensor data.

    SPARSE SENTINEL STRATEGY:
    Each cycle polls one sentinel sensor per ~2 km grid cell (typically ~30–50
    sentinels for SLC's ~242 outdoor sensors).  If a sentinel's pm2.5 crosses
    an AQI color boundary, every sensor in that cell is fetched immediately via
    show_only.  Cells whose sentinel didn't change color are skipped entirely.

    Metadata (name, lat, lon + full pm2.5 sweep) refreshes every 6 hours so
    the complete sensor picture stays current regardless of sentinel activity.

    Budget math (2,000,000 pts/month, 242 sensors, ~1 pt/sensor/field):
      Sentinel poll  ~50 pts/cycle (one per occupied grid cell)
      Cluster fetch  up to ~489 pts if ALL cells trigger (worst case)
      Metadata       ~970 pts per refresh (242 sensors × 4 fields)

      Day  (19h, 10 min):  114 cycles × 50  =  5,700 pts  (sentinel only)
                           114 cycles × 489 = 55,746 pts  (worst-case clusters)
      Night (5h, 30 min):   10 cycles × 50  =    500 pts
      Metadata (4×/day):     4         × 970 =  3,880 pts
      ──────────────────────────────────────────────────────
      Quiet day  (no clusters): ~10,080 pts/day →   ~307K/month
      Worst-case day (all clusters): ~60,126 pts/day → ~1.83M/month
      Budget: 2,000,000 pts/month ✓ even in worst case
    """
    _log("[PurpleAir] purpleair_fetch_loop thread STARTED")

    META_INTERVAL       = 10800.0  # 3 hours
    DATA_INTERVAL_DAY   = 300.0    # 5 min during day
    DATA_INTERVAL_NIGHT = 1800.0   # 30 min during night (1 AM – 6 AM MST)
    NEIGHBOR_RADIUS_DEG = 0.018    # ~2 km grid cell side length

    debug_log_path = data_dir / "purpleair_debug.json"

    def _is_night() -> bool:
        mst_hour = (datetime.now(timezone.utc).hour - 7) % 24
        return 1 <= mst_hour < 6

    def _current_interval() -> float:
        return DATA_INTERVAL_NIGHT if _is_night() else DATA_INTERVAL_DAY

    def _aqi_color_category(pm25: float) -> str:
        """Return the AQI color string for a pm2.5 value.  Only the COLOR
        matters — value changes within the same color are ignored."""
        return _get_aqi_color("PM25", pm25)

    def _build_grid(sensors: list[dict]) -> dict[tuple[int, int], list[int]]:
        """Divide all sensors into spatial grid cells (NEIGHBOR_RADIUS_DEG × NEIGHBOR_RADIUS_DEG).
        Returns a dict mapping (grid_x, grid_y) → list of sensor_index values in that cell.
        Sensors in adjacent cells breathe the same air, so when any sentinel in a cell
        detects a color change we fetch every sensor in that cell."""
        grid: dict[tuple[int, int], list[int]] = {}
        for s in sensors:
            lat = s.get("latitude")
            lon = s.get("longitude")
            sid = s.get("sensor_index")
            if lat is None or lon is None or sid is None:
                continue
            cell = (int(lat / NEIGHBOR_RADIUS_DEG), int(lon / NEIGHBOR_RADIUS_DEG))
            grid.setdefault(cell, []).append(sid)
        return grid

    def _pick_sentinels(sensors: list[dict], grid: dict[tuple[int, int], list[int]]) -> list[dict]:
        """Pick one sensor per grid cell as the sentinel for that cell.
        This guarantees every cluster has exactly one representative regardless
        of how densely packed sensors are in any particular area."""
        by_sid = {s["sensor_index"]: s for s in sensors if s.get("sensor_index") is not None}
        sentinels = []
        for cell_members in grid.values():
            # Pick whichever member we have full data for (lat/lon present)
            for sid in cell_members:
                s = by_sid.get(sid)
                if s and s.get("latitude") is not None and s.get("longitude") is not None:
                    sentinels.append(s)
                    break
        return sentinels

    def _cluster_of(sid: int, grid: dict[tuple[int, int], list[int]],
                    sensors: list[dict]) -> list[int]:
        """Return all sensor_index values in the same grid cell as sid.
        These are the sensors that breathe the same air and need updating
        when their sentinel detects an AQI color change."""
        by_sid = {s["sensor_index"]: s for s in sensors if s.get("sensor_index") is not None}
        s = by_sid.get(sid)
        if s is None:
            return []
        lat, lon = s.get("latitude"), s.get("longitude")
        if lat is None or lon is None:
            return []
        cell = (int(lat / NEIGHBOR_RADIUS_DEG), int(lon / NEIGHBOR_RADIUS_DEG))
        return grid.get(cell, [])

    def _apply_fetched(fetched: list[dict], now: float) -> None:
        """Merge fetched pm2.5 readings into app_state and accumulate history.
        Must be called with app_state.lock held."""
        time_utc = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        by_id = {s["sensor_index"]: s for s in fetched if s.get("sensor_index") is not None}
        existing_ids = {s.get("sensor_index") for s in app_state.purpleair_sensors}
        for s in app_state.purpleair_sensors:
            sid = s.get("sensor_index")
            if sid not in by_id:
                continue
            pm25_raw = by_id[sid].get("pm2.5")
            if pm25_raw is None:
                continue
            try:
                pm25_val = float(pm25_raw)
            except (TypeError, ValueError):
                continue
            s["pm2.5"] = pm25_val
            color = _get_aqi_color("PM25", pm25_val)
            accumulate_fixed_reading(app_state, f"PA_{sid}", "PM25", round(pm25_val, 1), color, time_utc)
        # Brand-new sensors not yet in cache
        for sid, s in by_id.items():
            if sid not in existing_ids:
                app_state.purpleair_sensors.append(s)
                pm25_raw = s.get("pm2.5")
                if pm25_raw is not None:
                    try:
                        pm25_val = float(pm25_raw)
                        color = _get_aqi_color("PM25", pm25_val)
                        accumulate_fixed_reading(app_state, f"PA_{sid}", "PM25", round(pm25_val, 1), color, time_utc)
                    except (TypeError, ValueError):
                        pass
        app_state.purpleair_last_fetch = now
        if isinstance(app_state.state, dict):
            _merge_purpleair_into_fixed(app_state.state, app_state)
            _inject_fixed_history(app_state, app_state.state)
            app_state.state.setdefault("meta", {})["state_seq"] = app_state.state_seq
            app_state.cached_json_bytes = json.dumps(app_state.state).encode("utf-8")
            app_state.state_seq += 1

    # Write initial debug file
    try:
        debug_log_path.write_text(json.dumps({
            "status": "initialized",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "interval_day_s": DATA_INTERVAL_DAY,
            "interval_night_s": DATA_INTERVAL_NIGHT,
            "neighbor_radius_deg": NEIGHBOR_RADIUS_DEG,
            "budget": "2M pts/month — worst-case ~1.83M, typical ~307K",
        }, indent=2), encoding="utf-8")
    except Exception as e:
        _log(f"[PurpleAir] Debug log init error: {e}")

    _log("[PurpleAir] Waiting 20s for main fetch loop to start...")
    stop_event.wait(20.0)
    _log("[PurpleAir] Starting PurpleAir fetch loop (sparse sentinel strategy)")

    while not stop_event.is_set():
        now = time.time()
        debug_info: dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "calls": [],
        }

        try:
            # ── Metadata refresh (every 6 hours) ──────────────────────────────
            # Also fetches all pm2.5 values so the full picture stays current.
            need_meta = (now - app_state.purpleair_meta_last_fetch) >= META_INTERVAL
            if need_meta:
                _log("[PurpleAir] Metadata refresh: fetching name,latitude,longitude,pm2.5 for all sensors")
                meta_sensors = _fetch_purpleair_sensors(fields="name,latitude,longitude,pm2.5")
                debug_info["calls"].append({"type": "metadata_full", "count": len(meta_sensors)})
                if meta_sensors:
                    with app_state.lock:
                        meta_by_id = {s["sensor_index"]: s for s in meta_sensors if s.get("sensor_index")}
                        for s in app_state.purpleair_sensors:
                            sid = s.get("sensor_index")
                            if sid and sid in meta_by_id:
                                m = meta_by_id.pop(sid)
                                s["name"]      = m.get("name",      s.get("name"))
                                s["latitude"]  = m.get("latitude",  s.get("latitude"))
                                s["longitude"] = m.get("longitude", s.get("longitude"))
                                if m.get("pm2.5") is not None:
                                    s["pm2.5"] = m["pm2.5"]
                        for sid, m in meta_by_id.items():
                            app_state.purpleair_sensors.append(m)
                        app_state.purpleair_meta_last_fetch = now
                        _apply_fetched(meta_sensors, now)
                    _log(f"[PurpleAir] Metadata+pm2.5 refreshed ({len(meta_sensors)} sensors)")

            # ── Sparse sentinel poll ───────────────────────────────────────────
            # Build the spatial grid fresh each cycle (sensors list may have grown
            # after a metadata refresh). One sentinel per grid cell.
            with app_state.lock:
                grid = _build_grid(app_state.purpleair_sensors)
                sentinels = _pick_sentinels(app_state.purpleair_sensors, grid)
            sentinel_ids = [s["sensor_index"] for s in sentinels]

            _log(f"[PurpleAir] Polling {len(sentinel_ids)} sentinels ({len(grid)} grid cells)")
            sentinel_data = _fetch_purpleair_sensors(fields="pm2.5", sensor_indices=sentinel_ids)
            debug_info["calls"].append({"type": "sentinel_poll", "count": len(sentinel_ids)})

            # Detect AQI color-category changes and queue full cluster fetches
            cluster_ids_to_fetch: set[int] = set()
            for s in sentinel_data:
                sid = s.get("sensor_index")
                pm25_raw = s.get("pm2.5")
                if sid is None or pm25_raw is None:
                    continue
                try:
                    pm25_val = float(pm25_raw)
                except (TypeError, ValueError):
                    continue
                new_color = _aqi_color_category(pm25_val)
                old_pm25  = app_state.purpleair_pm25_cache.get(sid)
                old_color = _aqi_color_category(old_pm25) if old_pm25 is not None else None
                app_state.purpleair_pm25_cache[sid] = pm25_val
                if old_color is None or new_color != old_color:
                    # First read (no baseline yet) or color changed — fetch the whole cluster
                    with app_state.lock:
                        cluster = _cluster_of(sid, grid, app_state.purpleair_sensors)
                    cluster_ids_to_fetch.update(cluster)
                    if old_color is not None:
                        _log(f"[PurpleAir] Sentinel {sid} color {old_color}→{new_color}, "
                             f"queuing {len(cluster)} cluster members")

            # Apply sentinel readings
            with app_state.lock:
                _apply_fetched(sentinel_data, now)

            # ── Cluster fetch (only for cells whose sentinel changed color) ────
            # Remove sentinels — already fetched above.
            cluster_ids_to_fetch -= set(sentinel_ids)
            if cluster_ids_to_fetch:
                cluster_list = list(cluster_ids_to_fetch)
                _log(f"[PurpleAir] Fetching {len(cluster_list)} cluster sensors (show_only)")
                cluster_data = _fetch_purpleair_sensors(fields="pm2.5",
                                                        sensor_indices=cluster_list)
                debug_info["calls"].append({"type": "cluster_fetch", "count": len(cluster_list)})
                with app_state.lock:
                    _apply_fetched(cluster_data, now)
            else:
                _log("[PurpleAir] No color-category changes, no cluster fetches needed")

            debug_info["sentinel_count"] = len(sentinel_ids)
            debug_info["cluster_sensors_fetched"] = len(cluster_ids_to_fetch)

        except Exception as e:
            _log(f"[PurpleAir] Error: {type(e).__name__}: {e}")
            debug_info["error"] = f"{type(e).__name__}: {e}"

        try:
            debug_log_path.write_text(json.dumps(debug_info, indent=2), encoding="utf-8")
        except Exception:
            pass

        stop_event.wait(_current_interval())


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
    
    # Collect all readings for this site across all cached hours.
    # Key by datetime to deduplicate: the same (site, param, hour) can appear
    # in multiple hour files (late arrivals, AirNow corrections).  Iterating in
    # sorted hour order means the last file wins, which is always the most
    # recent correction.
    # Structure: param -> {datetime: value}
    param_history: dict[str, dict[datetime, float]] = {}
    
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
                    param_history[param] = {}
                # Overwrite keeps the latest file's value (correction wins)
                param_history[param][dt] = float(value)
    
    # Build readings dict with history arrays
    for param, dt_value_map in param_history.items():
        # Sort by time (dict keys are datetime objects)
        history_list = sorted(dt_value_map.items(), key=lambda x: x[0])
        
        # Get mapped parameter name
        mapped_key = AIRNOW_PARAM_MAP.get(param, param)
        
        # Extract values, times, and compute colors
        history_values = [v for _, v in history_list]
        history_times = [dt.isoformat() + "Z" for dt, _ in history_list]  # UTC ISO strings
        hci = [color_to_idx(_get_aqi_color(mapped_key, v)) for v in history_values]
        
        # Latest value
        if history_values:
            latest_value = history_values[-1]
            latest_ci = hci[-1]
        else:
            continue
        
        result[mapped_key] = {
            "value": latest_value,
            "ci": latest_ci,
            "history": history_values,
            "history_times": history_times,  # UTC timestamps for playback interpolation
            "hci": hci,
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
            "ci": color_to_idx(color),
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
                    app_state.state_seq += 1
                    app_state.cached_json_bytes = json.dumps(st).encode("utf-8")
                    break
    except Exception as e:
        _log(f"[HomeSensor] Update error: {e}")


def _do_one_fetch(app_state: AppState, data_dir: Path) -> tuple:
    """Perform one data-fetch cycle: pull mobile/fixed JSON, build state, enrich it.

    Does NOT call ``update_app_state_with_new_data`` — the caller is responsible
    for adding any extra meta fields and calling that itself.

    Returns ``(mobile_raw, fixed_raw, state_dict)``.
    """
    mobile_cache = default_cache_path(MOBILE_URL, mobile_url=MOBILE_URL, fixed_url=FIXED_URL, data_dir=str(data_dir))
    fixed_cache = default_cache_path(FIXED_URL, mobile_url=MOBILE_URL, fixed_url=FIXED_URL, data_dir=str(data_dir))
    mobile = fetch_json_with_cache(MOBILE_URL, headers=HEADERS, timeout=10, request_get=stdlib_get, cache_path=mobile_cache)
    fixed_raw = fetch_json_with_cache(FIXED_URL, headers=HEADERS, timeout=10, request_get=stdlib_get, cache_path=fixed_cache)

    mobile = _clamp_impossible_values(mobile)

    if isinstance(mobile, dict):
        mobile.pop("_cache_age_s", None)
    if isinstance(fixed_raw, dict):
        fixed_raw.pop("_cache_age_s", None)

    # --- data-age / staleness ------------------------------------------------
    def _get_data_age_s(data: dict | None) -> int | None:
        if not isinstance(data, dict):
            return None
        pm25 = data.get("PM25", {})
        if isinstance(pm25, dict):
            last_update = pm25.get("LastUpdateUTC")
            if last_update:
                try:
                    dt = datetime.strptime(last_update.replace(" UTC", ""), "%Y-%m-%d %H:%M")
                    dt = dt.replace(tzinfo=timezone.utc)
                    age = int(time.time() - dt.timestamp())
                    return max(0, age)
                except Exception:
                    pass
        return None

    mobile_data_age = _get_data_age_s(mobile)
    fixed_data_age = _get_data_age_s(fixed_raw)
    data_stale = (mobile_data_age is not None and mobile_data_age > 1800) or \
                 (fixed_data_age is not None and fixed_data_age > 1800)
    data_age_s = max(mobile_data_age or 0, fixed_data_age or 0) if data_stale else None

    # --- accumulate history & raw storage ------------------------------------
    _accumulate_fixed_history_from_raw(app_state, fixed_raw)

    with app_state.lock:
        app_state.raw_mobile = mobile if isinstance(mobile, dict) else {}
        app_state.raw_fixed = fixed_raw if isinstance(fixed_raw, dict) else {}

    st = build_state(data_dir=data_dir, mobile_json=mobile, fixed_json=fixed_raw, max_points=5000)

    _accumulate_home_sensor_reading(app_state, st)
    _inject_fixed_history(app_state, st)
    _reinject_offline_fixed_sensors(app_state, st)

    # --- core meta -----------------------------------------------------------
    now = time.time()
    meta = st.setdefault("meta", {})
    meta["last_fetch_attempt_ts"] = now
    meta["last_fetch_ok_ts"] = now
    if data_stale:
        meta["data_stale"] = True
        meta["data_age_s"] = data_age_s
    if mobile_data_age is not None:
        meta["mobile_data_age_s"] = mobile_data_age
    if fixed_data_age is not None:
        meta["fixed_data_age_s"] = fixed_data_age
    meta["force_refresh_seq"] = int(getattr(app_state, "force_refresh_seq", 0) or 0)

    return mobile, fixed_raw, st


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
        # DISABLED — Home sensor polling is too frequent and not needed.
        # if attempt_ts - last_home_poll >= HOME_POLL_INTERVAL:
        #     _update_home_sensor_in_state(app_state)
        #     last_home_poll = attempt_ts
        
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
            mobile, fixed_raw, st = _do_one_fetch(app_state, data_dir)

            # Check if upstream data changed (for adaptive polling)
            data_changed = poller.check_for_change(mobile, fixed_raw)
            if data_changed:
                _log(f"[FetchLoop] Upstream data changed!")

            revision += 1
            meta = st.setdefault("meta", {})
            meta["server_revision"] = revision
            # Include adaptive polling info in meta
            meta["polling_predicted_interval_s"] = poller.predicted_interval
            meta["client_poll_in_s"] = 120  # 2-min client poll (PA updates every ~2 min)
            if poller.last_change_ts:
                time_since_change = time.time() - poller.last_change_ts
                meta["polling_time_since_change_s"] = int(time_since_change)
                meta["polling_next_update_in_s"] = max(0.0, poller.predicted_interval - time_since_change)
            update_app_state_with_new_data(app_state, st)
            _log(f"[FetchLoop] Revision {revision} updated")

            # Historical day prefetch DISABLED — Select Day loads from local snapshots

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
        
        # Use adaptive polling delay
        next_delay = poller.get_next_poll_delay()
        next_fetch = time.time() + next_delay
        
        while not stop_event.is_set() and time.time() < next_fetch:
            # Home sensor polling DISABLED — sleep until next main fetch (mobile/fixed from CHPC).
            # AirNow and PurpleAir each run on their own threads independently.
            # To re-enable Home sensor, uncomment the _update_home_sensor_in_state calls above
            # and restore the HOME_POLL_INTERVAL-based sleep logic.
            stop_event.wait(max(1.0, next_fetch - time.time()))


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
                today = datetime.now(_MOUNTAIN_TZ).strftime("%Y%m%d")
                
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
                        # Normalize AirNow param names (PM2.5→PM25, OZONE→OZNE)
                        # so history keys match the canonical reading keys.
                        acc_param = AIRNOW_PARAM_MAP.get(param, param)
                        accumulate_fixed_reading(
                            app_state, sensor_key, acc_param, val,
                            _get_aqi_color(acc_param, val), time_str
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
        safe_date = datetime.now(_MOUNTAIN_TZ).strftime("%Y-%m-%d")
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
    
    # Snapshots are written by our own server — skip expensive sanitization.
    # Just parse and do a lightweight schema check.
    raw_bytes = filepath.read_bytes()
    try:
        parsed = json.loads(raw_bytes)
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        raise JsonValidationError(f"Corrupt snapshot: {e}")
    if not isinstance(parsed, dict):
        raise JsonValidationError("Snapshot root must be object")
    validate_state_schema(parsed)
    return parsed

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
        
        def _send(self, code: int, body: bytes, content_type: str, cache_control: str | None = None, etag: str | None = None):
            """Send HTTP response with optional cache control and ETag.
            
            Args:
                code: HTTP status code
                body: Response body bytes
                content_type: Content-Type header value
                cache_control: Optional Cache-Control header value. If None, defaults to "no-store, max-age=0".
                etag: Optional ETag value (include quotes, e.g. '"rev-42"').
            """
            if cache_control is None:
                cache_control = "no-store, max-age=0"
            try:
                self.send_response(code)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", cache_control)
                if etag:
                    self.send_header("ETag", etag)
                # Connection: close helps Safari/iOS release connections properly
                self.send_header("Connection", "close")
                # Allow cross-origin requests (useful for dev/testing)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                # Client disconnected while we were sending - ignore
                pass

        def _send_304(self, etag: str, cache_control: str):
            """Send 304 Not Modified (no body)."""
            try:
                self.send_response(304)
                self.send_header("ETag", etag)
                self.send_header("Cache-Control", cache_control)
                self.send_header("Connection", "close")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass

        def do_GET(self):
            # Strip query string for path matching (cache-busting params like ?v=123)
            path_no_query = self.path.split('?')[0]
            
            # Static HTML - short cache, may change frequently during development
            if path_no_query in ("/", "/index.html"):
                maybe_log_visitor(self.headers, self.client_address, data_dir)
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
            if self.path == "/sitemap.xml":
                sitemap = ('<?xml version="1.0" encoding="UTF-8"?>\n'
                           '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
                           '  <url>\n'
                           '    <loc>https://dustytrails.funstuff.app/</loc>\n'
                           '    <changefreq>always</changefreq>\n'
                           '    <priority>1.0</priority>\n'
                           '  </url>\n'
                           '</urlset>\n')
                return self._send(200, sitemap.encode("utf-8"), "application/xml", cache_control="public, max-age=86400")
            if self.path.startswith("/api/config"):
                # Return server configuration for client scaling/caching decisions
                # Cache for 5 minutes - config changes rarely
                body = json.dumps(server_config).encode("utf-8")
                return self._send(200, body, "application/json", cache_control="public, max-age=300")
            if self.path.startswith("/api/state"):
                with app_state.lock:
                    _ensure_force_refresh_seq_cached(app_state)
                    # ETag from state_seq (bumped by ANY state mutation:
                    # fetch loop, PurpleAir, Home sensor, force-refresh)
                    _etag = f'"s{app_state.state_seq}"'
                    _cc_public = "public, max-age=0, s-maxage=30, stale-while-revalidate=5"

                    # Owner token path: no ETag, no CDN cache (debug gets full fresh data)
                    if OWNER_TOKEN:
                        from urllib.parse import urlparse, parse_qs
                        qs = parse_qs(urlparse(self.path).query)
                        tok = (qs.get("tok") or [""])[0]
                        if tok == OWNER_TOKEN:
                            st_copy = json.loads(app_state.cached_json_bytes)
                            if isinstance(st_copy.get("fixed"), list):
                                st_copy["fixed"] = [f for f in st_copy["fixed"] if f.get("id") != "Home"]
                            return self._send(200, json.dumps(st_copy).encode("utf-8"),
                                              "application/json", cache_control="private, no-store")

                    # Public path: ETag / 304 conditional GET
                    inm = self.headers.get("If-None-Match", "")
                    if inm == _etag:
                        return self._send_304(_etag, _cc_public)

                    st_copy = json.loads(app_state.cached_json_bytes)
                    if isinstance(st_copy.get("fixed"), list):
                        st_copy["fixed"] = [f for f in st_copy["fixed"] if f.get("id") != "Home"]

                    # Delta delivery: if client sends ?since_ms=<ts>, strip trail
                    # points the client already has (timestamp <= since_ms).
                    from urllib.parse import urlparse, parse_qs as _pqs
                    _qs = _pqs(urlparse(self.path).query)
                    _since_raw = (_qs.get("since_ms") or [None])[0]
                    if _since_raw is not None:
                        try:
                            _since_ms = int(_since_raw)
                        except (TypeError, ValueError):
                            _since_ms = None
                        if _since_ms is not None and isinstance(st_copy.get("mobile"), list):
                            for _mv in st_copy["mobile"]:
                                if not isinstance(_mv, dict):
                                    continue
                                _trail = _mv.get("trail")
                                if not isinstance(_trail, list):
                                    continue
                                # Keep only points with timestamp > since_ms.
                                # Trails are chronological; binary-search the cut point.
                                _cut = 0
                                for _ti, _tp in enumerate(_trail):
                                    _tt = _tp.get("t") if isinstance(_tp, dict) else None
                                    if isinstance(_tt, str):
                                        _tdt = parse_utc_timestamp(_tt)
                                        if _tdt is not None and int(_tdt.timestamp() * 1000) <= _since_ms:
                                            _cut = _ti + 1
                                        else:
                                            break
                                _mv["trail"] = _trail[_cut:]
                            st_copy.setdefault("meta", {})["delta"] = True

                    return self._send(200, json.dumps(st_copy).encode("utf-8"),
                                      "application/json", cache_control=_cc_public, etag=_etag)
            if self.path.startswith("/api/fixed"):
                # Return just the fixed sensor array (lightweight for TUI remote mode)
                with app_state.lock:
                    fixed = app_state.state.get("fixed", []) if isinstance(app_state.state, dict) else []
                # Strip Home sensor from browser-facing endpoint
                fixed = [f for f in fixed if f.get("id") != "Home"]
                body = json.dumps(fixed).encode("utf-8")
                return self._send(200, body, "application/json", cache_control="public, max-age=15")
            if self.path.startswith("/api/raw"):
                # Return raw Utah AQ data for TUI remote mode
                with app_state.lock:
                    raw = {"mobile": app_state.raw_mobile, "fixed": app_state.raw_fixed}
                return self._send(200, json.dumps(raw).encode("utf-8"), "application/json")
            if self.path.startswith("/api/tui"):
                return self._handle_tui_state()
            # /api/history disabled — Select Day now loads from /api/snapshot/load
            # if self.path.startswith("/api/history"):
            #     return self._handle_history_request()
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
            if self.path.startswith("/api/prefs/log"):
                return self._handle_prefs_log()
            return self._send(404, b"not found", "text/plain")

        def do_POST(self):
            if self.path.startswith("/api/prefs/sync"):
                return self._handle_prefs_sync()
            if self.path.startswith("/api/snapshot/save"):
                return self._handle_save_snapshot()
            return self._send(404, b"not found", "text/plain")

        def _handle_prefs_sync(self):
            """Append a prefs snapshot to prefs_log.ndjson (one JSON line per entry).

            Body: {"client_ts": <epoch_ms>, "prefs": {"dusty_...": "...", ...}}
            Token validated via ?tok= query param (same as snapshot/save).
            """
            from urllib.parse import urlparse, parse_qs
            qs = parse_qs(urlparse(self.path).query)
            tok = (qs.get("tok") or [""])[0]
            if OWNER_TOKEN and tok != OWNER_TOKEN:
                return self._send(403, b'{"error": "forbidden"}', "application/json")
            content_length = int(self.headers.get("Content-Length", 0))
            if not (0 < content_length <= 8192):
                return self._send(400, b'{"error": "bad length"}', "application/json")
            try:
                raw = self.rfile.read(content_length)
                incoming = json.loads(raw)
                if not isinstance(incoming.get("prefs"), dict):
                    raise ValueError("missing prefs")
                entry = {
                    "ts": time.time(),
                    "client_ts": int(incoming.get("client_ts") or 0),
                    "prefs": {k: v for k, v in incoming["prefs"].items()
                               if isinstance(k, str) and
                               (k.startswith("dusty_") or k.startswith("mobileair.")) and
                               not k.endswith(".__cfgv")},
                }
                log_path = Path(data_dir) / "prefs_log.ndjson"
                with open(log_path, "a", encoding="utf-8") as f:
                    f.write(json.dumps(entry) + "\n")
                return self._send(200, b'{"ok": true}', "application/json")
            except Exception as e:
                body = json.dumps({"error": str(e)}).encode()
                return self._send(500, body, "application/json")

        def _handle_prefs_log(self):
            """Return last N entries from prefs_log.ndjson as a JSON array.

            Query params:
              n=<int>   — number of tail entries to return (default 100, max 10000)
            """
            from urllib.parse import urlparse, parse_qs
            qs = parse_qs(urlparse(self.path).query)
            tok = (qs.get("tok") or [""])[0]
            if OWNER_TOKEN and tok != OWNER_TOKEN:
                return self._send(403, b'{"error": "forbidden"}', "application/json")
            try:
                n = min(int((qs.get("n") or ["100"])[0]), 10000)
            except (ValueError, TypeError):
                n = 100
            log_path = Path(data_dir) / "prefs_log.ndjson"
            entries = []
            if log_path.exists():
                lines = log_path.read_text(encoding="utf-8").splitlines()
                for line in lines[-n:]:
                    line = line.strip()
                    if line:
                        try:
                            entries.append(json.loads(line))
                        except json.JSONDecodeError:
                            pass
            body = json.dumps(entries).encode("utf-8")
            return self._send(200, body, "application/json")

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
                # Default to today's date (Mountain time — sensors are in Utah)
                date_str = datetime.now(_MOUNTAIN_TZ).strftime("%Y-%m-%d")

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

                # Trim to the snapshot's date window (5 AM–5 AM MST)
                _trim_trails_to_day(state_to_save, date_str)
                _trim_history_to_date(state_to_save, date_str)

                result = save_snapshot(data_dir, date_str, state_to_save)
                body = json.dumps(result).encode("utf-8")
                return self._send(200, body, "application/json")
            except JsonValidationError as e:
                body = json.dumps({"error": f"Invalid data: {e}"}).encode("utf-8")
                return self._send(400, body, "application/json")
            except Exception as e:
                body = json.dumps({"error": str(e)}).encode("utf-8")
                return self._send(500, body, "application/json")

        # In-memory cache for windowed snapshot responses.
        # Key: (date_str, start_hour, duration_h)  Value: bytes
        # Avoids re-parsing the full snapshot JSON on every widget load.
        _snapshot_window_cache: dict[tuple, bytes] = {}

        def _handle_load_snapshot(self):
            """Load a saved snapshot by date.

            PA sensors baked into old snapshot files are stripped unless
            fixed_history actually contains PA readings for that date —
            confirming the data existed at that time.
            """
            from urllib.parse import urlparse, parse_qs
            query = parse_qs(urlparse(self.path).query)
            date_str = query.get("date", [None])[0]

            if not date_str:
                return self._send(400, b'{"error": "date parameter required"}', "application/json")

            # Check window cache first (widget requests the same window all day)
            start_hour_raw = query.get("start", [None])[0]
            duration_raw = query.get("duration", [None])[0]
            if start_hour_raw is not None:
                try:
                    _sh = int(start_hour_raw)
                    _dh = int(duration_raw) if duration_raw is not None else 24
                    cache_key = (date_str, _sh, _dh)
                    cached = self._snapshot_window_cache.get(cache_key)
                    if cached is not None:
                        return self._send(200, cached, "application/json",
                                          cache_control="public, max-age=3600")
                except (ValueError, TypeError):
                    cache_key = None
            else:
                cache_key = None

            try:
                state = load_snapshot(data_dir, date_str)
                if state is None:
                    return self._send(404, b'{"error": "snapshot not found"}', "application/json")

                # Strip PA sensors from the snapshot unless fixed_history confirms
                # PA data actually existed on this date.  Old snapshot files may have
                # PA entries baked in from a time when the sensor list was different or
                # data was injected incorrectly.
                existing_pa = [f for f in (state.get("fixed") or []) if f.get("purpleair")]
                if existing_pa:
                    # Check fixed_history for any PA entry timestamped on this date.
                    # date_str is a Mountain-time date but timestamps are UTC, so
                    # we check both UTC dates that cover this MT day.
                    try:
                        _day_mt = datetime.strptime(date_str, "%Y-%m-%d").replace(
                            hour=0, minute=0, second=0, microsecond=0, tzinfo=_MOUNTAIN_TZ)
                        _pa_prefixes = _utc_date_prefixes_for_mt_day(_day_mt)
                    except (ValueError, TypeError):
                        _pa_prefixes = (date_str,)
                    pa_confirmed = False
                    with app_state.lock:
                        for sensor_id, pollutants in app_state.fixed_history.items():
                            if not sensor_id.startswith("PA_"):
                                continue
                            for entries in pollutants.values():
                                if any(e.get("time", "")[:10] in _pa_prefixes for e in entries):
                                    pa_confirmed = True
                                    break
                            if pa_confirmed:
                                break
                    if not pa_confirmed:
                        _log(f"[Snapshot] Stripping {len(existing_pa)} stale PA sensors from {date_str} (no fixed_history data for that date)")
                        state["fixed"] = [f for f in state["fixed"] if not f.get("purpleair")]

                # Trim to the requested day's 5 AM–5 AM MST window.
                # Current saves are pre-trimmed, but older snapshots may not be.
                _trim_trails_to_day(state, date_str)
                _trim_history_to_date(state, date_str)

                # If start (hour) is provided, trim to that window.
                # Used by the landing page embed widget.
                if start_hour_raw is not None:
                    try:
                        start_hour = int(start_hour_raw)
                        duration_h = int(duration_raw) if duration_raw is not None else 24
                        if 0 <= start_hour <= 23 and 0 < duration_h <= 24:
                            _day = datetime.strptime(date_str, "%Y-%m-%d")
                            win_start = _day.replace(hour=start_hour, minute=0, second=0,
                                                     microsecond=0, tzinfo=_MOUNTAIN_TZ).astimezone(timezone.utc)
                            win_end = win_start + timedelta(hours=duration_h)
                            _trim_state_to_window(state, win_start, win_end)
                    except (ValueError, TypeError):
                        pass  # Ignore bad params, serve full day

                body = json.dumps(state).encode("utf-8")
                # Cache windowed responses so subsequent widget loads are instant
                if cache_key is not None:
                    self._snapshot_window_cache[cache_key] = body
                    # Cap cache size: keep at most 10 entries
                    if len(self._snapshot_window_cache) > 10:
                        oldest = next(iter(self._snapshot_window_cache))
                        del self._snapshot_window_cache[oldest]
                    return self._send(200, body, "application/json",
                                      cache_control="public, max-age=3600")
                return self._send(200, body, "application/json")
            except Exception as e:
                body = json.dumps({"error": str(e)}).encode("utf-8")
                return self._send(500, body, "application/json")

        # def _handle_history_request(self):
        #     """DISABLED — Select Day now loads from /api/snapshot/load instead.
        #     Previously fetched week-long timeseries from CHPC upstream servers
        #     and reconstructed a day's worth of data for the dashboard."""
        #     pass

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
        # Bump configVersion to push new localStorage defaults to all clients.
        # Each key is written once per version; user changes are preserved
        # until the next version bump.
        "configVersion": 1,
        "localStorage": {
            "mobileair.mapDim.carto_dark": "101",
            "mobileair.mapSat.carto_dark": "118",
        },
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

    # Synchronous initial fetch so cached_json_bytes has real data before clients connect
    try:
        _log("[InitialFetch] Performing initial data fetch...")
        _, _, init_st = _do_one_fetch(app_state, data_dir)
        update_app_state_with_new_data(app_state, init_st)
        _log("[InitialFetch] Initial data loaded")
    except Exception as e:
        _log(f"[InitialFetch] Error (will retry in fetch_loop): {e}")

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

    # Eager initial PurpleAir fetch so first /api/state includes PA sensors.
    # Without this, clients connecting right after restart see no PurpleAir
    # sensors until the background thread runs (20s+ delay), and some clients
    # don't pick up the newly-appeared sensors without a full reload.
    try:
        _log("[PurpleAir] Performing initial fetch...")
        meta_sensors = _fetch_purpleair_sensors(fields="name,latitude,longitude")
        if meta_sensors:
            with app_state.lock:
                for s in meta_sensors:
                    if s.get("sensor_index"):
                        app_state.purpleair_sensors.append(s)
                app_state.purpleair_meta_last_fetch = time.time()
            _log(f"[PurpleAir] Metadata loaded ({len(meta_sensors)} sensors)")
        data_sensors = _fetch_purpleair_sensors(fields="pm2.5")
        if data_sensors:
            data_by_id = {s["sensor_index"]: s for s in data_sensors if s.get("sensor_index")}
            with app_state.lock:
                for s in app_state.purpleair_sensors:
                    sid = s.get("sensor_index")
                    if sid and sid in data_by_id:
                        s["pm2.5"] = data_by_id[sid].get("pm2.5")
                app_state.purpleair_last_fetch = time.time()
                # Re-bake state with PurpleAir included
                if isinstance(app_state.state, dict):
                    _merge_purpleair_into_fixed(app_state.state, app_state)
                    _inject_fixed_history(app_state, app_state.state)
                    app_state.cached_json_bytes = json.dumps(app_state.state).encode("utf-8")
            _log(f"[PurpleAir] Initial data loaded ({len(data_sensors)} sensors)")
    except Exception as e:
        _log(f"[PurpleAir] Initial fetch error (will retry in background): {e}")

    # Start PurpleAir fetch loop (10-min daytime / 30-min nighttime)
    threading.Thread(
        target=purpleair_fetch_loop,
        kwargs=dict(app_state=app_state, data_dir=data_dir, stop_event=stop_event),
        daemon=True
    ).start()
    _log("[PurpleAir] SLC sensor integration enabled (10-min daytime / 30-min nighttime, batched requests)")

    # History prefetch disabled — Select Day now loads from local snapshots
    # threading.Thread(
    #     target=_history_prefetch_loop,
    #     kwargs=dict(app_state=app_state, data_dir=data_dir, stop_event=stop_event),
    #     daemon=True
    # ).start()
    # _log("[HistoryPrefetch] Background trickle-download thread started")

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
    
    # Synchronous initial fetch so cached_json_bytes has real data before clients connect
    try:
        _log("[InitialFetch] Performing initial data fetch...")
        _, _, init_st = _do_one_fetch(app_state, data_dir)
        update_app_state_with_new_data(app_state, init_st)
        _log("[InitialFetch] Initial data loaded")
    except Exception as e:
        _log(f"[InitialFetch] Error (will retry in fetch_loop): {e}")

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

    # PurpleAir fetch loop with batched requests (10-min daytime / 30-min nighttime)
    threading.Thread(
        target=purpleair_fetch_loop,
        kwargs=dict(app_state=app_state, data_dir=data_dir, stop_event=stop_event),
        daemon=True
    ).start()

    # History prefetch disabled — Select Day now loads from local snapshots
    # threading.Thread(
    #     target=_history_prefetch_loop,
    #     kwargs=dict(app_state=app_state, data_dir=data_dir, stop_event=stop_event),
    #     daemon=True
    # ).start()

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