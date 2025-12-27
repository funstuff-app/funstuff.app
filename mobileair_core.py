"""
Core / pure logic for MobileAir.

This module intentionally avoids Textual/Rich imports so it can be unit-tested
without a TUI runtime.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
import os
import time
from typing import Any, Callable

try:
    import requests  # optional at import-time for tests; can be injected
except Exception:  # pragma: no cover
    requests = None  # type: ignore


# Trend / projection tuning
TREND_LOOKAHEAD_MINUTES = 15
TREND_WINDOW_SAMPLES = 15
TREND_THRESHOLDS = {
    "pm2.5": 1.0,
    "pm25": 1.0,
    "pm10": 2.0,
    "ozone": 2.0,
    "default": 1.0,
}


# Mobility detection tuning (meters/minutes); conservative to avoid false flags
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


AQI_LEVELS = [
    {"label": "Good", "aqi_hi": 50, "color": "#00E400"},
    {"label": "Moderate", "aqi_hi": 100, "color": "#FFFF00"},
    {"label": "USG", "aqi_hi": 150, "color": "#FF7E00"},
    {"label": "Unhealthy", "aqi_hi": 200, "color": "#FF0000"},
    {"label": "Very Unhealthy", "aqi_hi": 300, "color": "#8F3F97"},
    {"label": "Hazardous", "aqi_hi": 500, "color": "#7E0023"},
]


POLLUTANT_BREAKPOINTS = {
    "pm2.5": [
        # From aqi_breakpoints.csv (EPA AQS codetable): PM2.5 24-hour
        {"c_low": 0.0, "c_high": 9.0, "aqi_low": 0, "aqi_high": 50},
        {"c_low": 9.1, "c_high": 35.4, "aqi_low": 51, "aqi_high": 100},
        {"c_low": 35.5, "c_high": 55.4, "aqi_low": 101, "aqi_high": 150},
        {"c_low": 55.5, "c_high": 125.4, "aqi_low": 151, "aqi_high": 200},
        {"c_low": 125.5, "c_high": 225.4, "aqi_low": 201, "aqi_high": 300},
        {"c_low": 225.5, "c_high": 325.4, "aqi_low": 301, "aqi_high": 500},
    ],
    "pm10": [
        # From aqi_breakpoints.csv (EPA AQS codetable): PM10 24-hour
        {"c_low": 0.0, "c_high": 54.0, "aqi_low": 0, "aqi_high": 50},
        {"c_low": 55.0, "c_high": 154.0, "aqi_low": 51, "aqi_high": 100},
        {"c_low": 155.0, "c_high": 254.0, "aqi_low": 101, "aqi_high": 150},
        {"c_low": 255.0, "c_high": 354.0, "aqi_low": 151, "aqi_high": 200},
        {"c_low": 355.0, "c_high": 424.0, "aqi_low": 201, "aqi_high": 300},
        {"c_low": 425.0, "c_high": 604.0, "aqi_low": 301, "aqi_high": 500},
    ],
    "ozone": [
        # From aqi_breakpoints.csv (EPA AQS codetable): Ozone 8-hour (ppm)
        {"c_low": 0.000, "c_high": 0.054, "aqi_low": 0, "aqi_high": 50},
        {"c_low": 0.055, "c_high": 0.070, "aqi_low": 51, "aqi_high": 100},
        {"c_low": 0.071, "c_high": 0.085, "aqi_low": 101, "aqi_high": 150},
        {"c_low": 0.086, "c_high": 0.105, "aqi_low": 151, "aqi_high": 200},
        {"c_low": 0.106, "c_high": 0.200, "aqi_low": 201, "aqi_high": 300},
    ],
}


def parse_utc_timestamp(timestamp: str | None):
    if not timestamp:
        return None
    ts = timestamp.strip()
    if ts.endswith("UTC"):
        ts = ts[:-3].strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
        try:
            dt = datetime.strptime(ts, fmt)
            return dt.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    try:
        ts_norm = ts.replace("Z", "+00:00")
        dt = datetime.fromisoformat(ts_norm)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lon2 - lon1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return r * c


def bounding_box_distance(coords: list[tuple[float, float, datetime | None]]) -> float:
    if len(coords) < 2:
        return 0.0
    lats = sorted(lat for lat, _, _ in coords)
    lons = sorted(lon for _, lon, _ in coords)
    if len(lats) > 4:
        lats = lats[1:-1]
    if len(lons) > 4:
        lons = lons[1:-1]
    lat_range = (max(lats) - min(lats)) if lats else 0.0
    lon_range = (max(lons) - min(lons)) if lons else 0.0
    mean_lat = sum(lat for lat, _, _ in coords) / len(coords)
    ns = lat_range * 111320.0
    ew = lon_range * 111320.0 * math.cos(math.radians(mean_lat))
    return math.hypot(ns, ew)


def value_to_aqi(pollutant_key: str, value: float | str | None):
    try:
        val = float(value)
    except (TypeError, ValueError):
        return None
    key = pollutant_key.lower()

    # Normalize key for breakpoint lookup.
    if key in ("pm25", "pm2.5", "pm2_5", "pm2-5", "pm 2.5"):
        key = "pm2.5"
    elif key in ("pm10", "pm 10"):
        key = "pm10"
    elif key in ("ozne", "ozone", "o3"):
        key = "ozone"

    # Normalize units + apply EPA truncation rules.
    # Note: our OZNE feed values are typically in ppb (e.g. 28-40). EPA breakpoints are in ppm.
    if key == "ozone":
        if val > 1.0:
            val = val / 1000.0  # ppb -> ppm
        # truncate to 3 decimals (ppm)
        val = math.floor(val * 1000.0) / 1000.0
    elif key == "pm2.5":
        # truncate to 1 decimal
        val = math.floor(val * 10.0) / 10.0
    elif key == "pm10":
        # truncate to integer
        val = float(math.floor(val))

    breakpoints = POLLUTANT_BREAKPOINTS.get(key, [])
    if not breakpoints:
        return None
    for bp in breakpoints:
        if bp["c_low"] <= val <= bp["c_high"]:
            c_low = bp["c_low"]
            c_high = bp["c_high"]
            aqi_low = bp["aqi_low"]
            aqi_high = bp["aqi_high"]
            if c_high == c_low:
                return aqi_high
            return ((aqi_high - aqi_low) / (c_high - c_low)) * (val - c_low) + aqi_low
    if breakpoints:
        if val < breakpoints[0]["c_low"]:
            return breakpoints[0]["aqi_low"]
        if val > breakpoints[-1]["c_high"]:
            return breakpoints[-1]["aqi_high"]
    return None


def filter_history_outliers(
    pollutant_key: str,
    values: list[Any] | None,
    colors: list[Any] | None = None,
) -> tuple[list[Any], list[Any] | None, list[float]]:
    """Remove obvious single-sample glitches from history.

    This is intentionally conservative: it targets clearly impossible/implausible spikes
    (like OZNE=778) that otherwise dominate sparklines and trend indicators.

    Returns (filtered_values, filtered_colors) and preserves alignment when colors provided.
    """

    if not isinstance(values, list) or not values:
        return ([], colors if isinstance(colors, list) else None, [])

    key = (pollutant_key or "").lower()
    # Normalize key for bounds.
    if key in ("pm25", "pm2.5", "pm2_5", "pm2-5", "pm 2.5"):
        key = "pm2.5"
    elif key in ("pm10", "pm 10"):
        key = "pm10"
    elif key in ("ozne", "ozone", "o3"):
        key = "ozone"

    # Hard plausibility bounds in *feed units*.
    # These are not health breakpoints; they're "sanity" limits to drop obvious glitches.
    bounds = {
        # ug/m3
        "pm2.5": (0.0, 999.0),
        "pm10": (0.0, 2000.0),
        # ozone is typically ppb in our feeds; allow up to 600ppb (extreme) before dropping
        "ozone": (0.0, 600.0),
    }.get(key)

    out_vals: list[Any] = []
    out_cols: list[Any] | None = [] if isinstance(colors, list) else None
    removed: list[float] = []

    for i, v in enumerate(values):
        keep = True
        try:
            fv = float(v)
            if not math.isfinite(fv):
                keep = False
            elif bounds is not None:
                lo, hi = bounds
                if fv < lo or fv > hi:
                    keep = False
        except (TypeError, ValueError):
            # Non-numeric history is ignored by spark/trend; keep it out.
            keep = False

        if keep:
            out_vals.append(v)
            if out_cols is not None:
                out_cols.append(colors[i] if i < len(colors) else None)
        else:
            try:
                fv = float(v)
                if math.isfinite(fv):
                    removed.append(fv)
            except Exception:
                pass

    # If we filtered everything (e.g., all values malformed), fall back to original.
    if not out_vals:
        return (values, colors if isinstance(colors, list) else None, [])

    return (out_vals, out_cols, removed)


def aqi_level(aqi: float | None):
    if aqi is None:
        return {"label": "Unknown", "color": "#AAAAAA", "aqi_hi": None}
    for level in AQI_LEVELS:
        if aqi <= level["aqi_hi"]:
            return level
    return AQI_LEVELS[-1]


def color_for_value(pollutant_key: str, value: float | str | None) -> str:
    return aqi_level(value_to_aqi(pollutant_key, value))["color"]


def trend_threshold(pollutant_key: str) -> float:
    return TREND_THRESHOLDS.get(pollutant_key.lower(), TREND_THRESHOLDS["default"])


def extract_numeric_history(history) -> list[float]:
    values: list[float] = []
    if not history:
        return values
    for entry in history:
        if isinstance(entry, dict):
            entry = entry.get("val")
        if entry in (None, "None"):
            continue
        try:
            values.append(float(entry))
        except (TypeError, ValueError):
            continue
    return values


def compute_trend_indicator(pollutant_key: str, unit: str, history, current_value):
    numeric_history = extract_numeric_history(history)
    if not numeric_history:
        return None

    window = numeric_history[-TREND_WINDOW_SAMPLES:]
    n = len(window)
    if n < 5:
        return None

    try:
        current = float(current_value)
    except (TypeError, ValueError):
        current = window[-1]

    threshold = trend_threshold(pollutant_key)

    window_range = max(window) - min(window)
    if window_range < max(threshold * 1.5, 2.0):
        return {
            "symbol": "▬",
            "color": None,
            "delta": 0.0,
            "predicted_value": current,
            "summary": "Stable (Low Variance)",
            "predicted_label": aqi_level(value_to_aqi(pollutant_key, current))["label"],
        }

    last_5 = window[-5:]
    if last_5:
        range_5 = max(last_5) - min(last_5)
        if range_5 < threshold:
            return {
                "symbol": "▬",
                "color": None,
                "delta": 0.0,
                "predicted_value": current,
                "summary": "Stable",
                "predicted_label": aqi_level(value_to_aqi(pollutant_key, current))["label"],
            }

    diffs = []
    step_noise = max(threshold * 0.2, 0.1)
    for p, c in zip(window, window[1:]):
        d = c - p
        if abs(d) >= step_noise:
            diffs.append(d)

    start_val = window[0]
    delta = current - start_val

    pos_moves = sum(1 for d in diffs if d > 0)
    neg_moves = sum(1 for d in diffs if d < 0)

    symbol = "▬"
    direction_text = "stable"

    if delta > threshold and pos_moves > 1:
        symbol = "▲"
        direction_text = "rising"
    elif delta < -threshold and neg_moves > 1:
        symbol = "▼"
        direction_text = "falling"

    if symbol == "▼" and (current - window[-2]) > threshold * 0.5:
        symbol = "▬"
        direction_text = "stable (recovering)"
    elif symbol == "▲" and (current - window[-2]) < -threshold * 0.5:
        symbol = "▬"
        direction_text = "stable (recovering)"

    predicted_level = aqi_level(value_to_aqi(pollutant_key, current + delta))
    summary = f"{direction_text.title()} (Δ={delta:.1f})"

    return {
        "symbol": symbol,
        "color": None,
        "delta": delta,
        "predicted_value": current + delta,
        "summary": summary,
        "predicted_label": predicted_level["label"],
    }


def evaluate_mobility(
    sensor_blob: dict,
    *,
    lookback_minutes: int = IMMOBILITY_LOOKBACK_MINUTES,
    min_coverage_minutes: int = IMMOBILITY_MIN_COVERAGE_MINUTES,
    min_samples: int = IMMOBILITY_MIN_SAMPLES,
    total_distance_threshold: float = IMMOBILITY_TOTAL_DISTANCE_THRESHOLD,
    max_step_threshold: float = IMMOBILITY_MAX_STEP_THRESHOLD,
    bbox_threshold: float = IMMOBILITY_BBOX_THRESHOLD,
    radius_threshold: float = IMMOBILITY_RADIUS_THRESHOLD,
    net_distance_threshold: float = IMMOBILITY_NET_DISTANCE_THRESHOLD,
    # Sparse/low-coverage movement proof thresholds. These are intentionally conservative
    # to avoid classifying GPS jitter spikes as real movement.
    sparse_prove_moving_max_step_m: float = SPARSE_PROVE_MOVING_MAX_STEP_M,
    sparse_prove_moving_net_m: float = SPARSE_PROVE_MOVING_NET_M,
    sparse_not_idle_robust_radius_m: float = SPARSE_ASSUME_IDLE_ROBUST_RADIUS_M,
    # Policy controls:
    # - When True (default), we err toward marking a sensor immobile/idle when history is sparse.
    # - For transit sensors, this can hide a bus for a long time due to sparse updates, even though
    #   it is not truly idle. Callers may disable these to only mark idle when we have enough evidence.
    assume_immobile_when_sparse: bool = True,
    assume_immobile_when_low_coverage: bool = True,
    allow_short_window_immobile: bool = True,
) -> dict:
    info: dict[str, Any] = {"immobile": False, "samples": 0}
    lat_list = sensor_blob.get("Latitude")
    lon_list = sensor_blob.get("Longitude")
    time_list = sensor_blob.get("TimeUTC")
    if not (isinstance(lat_list, list) and isinstance(lon_list, list) and lat_list and lon_list):
        return info

    sample_len = min(len(lat_list), len(lon_list))
    lat_values = lat_list[-sample_len:]
    lon_values = lon_list[-sample_len:]

    if isinstance(time_list, list) and time_list:
        if len(time_list) >= sample_len:
            time_values = time_list[-sample_len:]
        else:
            time_values = [None] * (sample_len - len(time_list)) + time_list
    else:
        time_values = [None] * sample_len

    coords: list[tuple[float, float, datetime | None]] = []
    for lat, lon, ts in zip(lat_values, lon_values, time_values):
        try:
            lat_f = float(lat)
            lon_f = float(lon)
        except (TypeError, ValueError):
            continue
        coords.append((lat_f, lon_f, parse_utc_timestamp(ts)))

    def _stable_center_from(coords0: list[tuple[float, float, datetime | None]]) -> tuple[float | None, float | None]:
        if not coords0:
            return (None, None)
        med_lat = _median([lat for lat, _, _ in coords0])
        med_lon = _median([lon for _, lon, _ in coords0])
        if med_lat is None or med_lon is None:
            return (None, None)
        return (float(med_lat), float(med_lon))

    def _robust_radius(coords0: list[tuple[float, float, datetime | None]], center_lat: float, center_lon: float) -> float:
        ds = [haversine_distance(lat, lon, center_lat, center_lon) for lat, lon, _ in coords0]
        ds = [d for d in ds if isinstance(d, (int, float)) and math.isfinite(d)]
        if not ds:
            return 0.0
        ds.sort()
        if len(ds) >= 4:
            ds = ds[1:-1]
        return float(ds[-1])

    # Sparse-data policy: optionally assume idle unless movement is clearly proven.
    if len(coords) < min_samples:
        info["samples"] = len(coords)

        if len(coords) < 2:
            lat0, lon0, _ = coords[-1]
            if assume_immobile_when_sparse:
                info["immobile"] = True
            info["stable_lat"] = float(lat0)
            info["stable_lon"] = float(lon0)
            info["summary"] = "Insufficient movement history; assume idle" if assume_immobile_when_sparse else "Insufficient movement history; not enough evidence to mark idle"
            return info

        # With 2..(min_samples-1) points, only mark moving if a large jump occurs.
        steps = []
        total = 0.0
        prev = None
        for lat_f, lon_f, _ in coords:
            if prev is not None:
                d = haversine_distance(prev[0], prev[1], lat_f, lon_f)
                if isinstance(d, (int, float)) and math.isfinite(d):
                    steps.append(float(d))
                    total += float(d)
            prev = (lat_f, lon_f)
        max_step = max(steps) if steps else 0.0
        net = haversine_distance(coords[0][0], coords[0][1], coords[-1][0], coords[-1][1])
        net = float(net) if isinstance(net, (int, float)) and math.isfinite(net) else 0.0

        stable_lat, stable_lon = _stable_center_from(coords)
        if stable_lat is not None and stable_lon is not None:
            rr = _robust_radius(coords, stable_lat, stable_lon)
        else:
            rr = 0.0

        # Prove moving only if there is meaningful displacement.
        # A single large step can be GPS jitter; require at least some net displacement.
        if net >= sparse_prove_moving_net_m or (max_step >= sparse_prove_moving_max_step_m and net >= (sparse_prove_moving_net_m * 0.5)):
            # Proved moving.
            return info

        # Not proven moving:
        # - default: treat as idle (legacy behavior)
        # - transit override: do NOT mark idle without enough history
        if assume_immobile_when_sparse:
            info["immobile"] = True
        if stable_lat is not None and stable_lon is not None:
            info["stable_lat"] = stable_lat
            info["stable_lon"] = stable_lon
        else:
            info["stable_lat"] = float(coords[-1][0])
            info["stable_lon"] = float(coords[-1][1])
        info["window_samples"] = len(coords)
        info["summary"] = (
            f"Sparse updates (samples={len(coords)}); assume idle unless movement is proven"
            if assume_immobile_when_sparse
            else f"Sparse updates (samples={len(coords)}); not enough evidence to mark idle"
        )
        info["robust_radius_m"] = rr
        info["net_m"] = net
        info["max_step_m"] = float(max_step)
        return info

    if allow_short_window_immobile:
        # Debounced short-window check (movement-based, not TTL-based).
        # If the last several readings show essentially the same coordinates, treat as immobile
        # even when we don't have enough time coverage. This is useful for fixed sensors, but
        # for transit playback we disable it so short stops don't immediately become "idle".
        recent_tail = coords[-min_samples:]
        tail_steps: list[float] = []
        tail_total = 0.0
        tail_prev = None
        for lat_f, lon_f, _ in recent_tail:
            if tail_prev:
                d = haversine_distance(tail_prev[0], tail_prev[1], lat_f, lon_f)
                tail_steps.append(d)
                tail_total += d
            tail_prev = (lat_f, lon_f)
        tail_max = max(tail_steps) if tail_steps else 0.0
        tail_bbox = bounding_box_distance(recent_tail)
        tail_centroid_lat = sum(lat for lat, _, _ in recent_tail) / len(recent_tail)
        tail_centroid_lon = sum(lon for _, lon, _ in recent_tail) / len(recent_tail)
        tail_radius = 0.0
        for lat_f, lon_f, _ in recent_tail:
            tail_radius = max(tail_radius, haversine_distance(lat_f, lon_f, tail_centroid_lat, tail_centroid_lon))

        # "Clearly obvious" immobility thresholds (meters) over the last N samples.
        strict_total = 45.0
        strict_max_step = 18.0
        strict_bbox = 40.0
        strict_radius = 22.0
        if tail_total <= strict_total and tail_max <= strict_max_step and tail_bbox <= strict_bbox and tail_radius <= strict_radius:
            info["samples"] = len(recent_tail)
            info["immobile"] = True
            info["window_samples"] = len(recent_tail)
            # Provide a stable center for the UI to pin to.
            info["stable_lat"] = tail_centroid_lat
            info["stable_lon"] = tail_centroid_lon
            info["summary"] = f"No movement across last {len(recent_tail)} readings (values dimmed)"
            return info

    latest_time = next((dt for _, _, dt in reversed(coords) if dt), None)
    cutoff = latest_time - timedelta(minutes=lookback_minutes) if latest_time else None

    recent_coords: list[tuple[float, float, datetime | None]] = []
    for lat_f, lon_f, dt in coords:
        if cutoff and dt and dt < cutoff:
            continue
        recent_coords.append((lat_f, lon_f, dt))

    if not recent_coords:
        recent_coords = coords[-min_samples:]

    info["samples"] = len(recent_coords)
    if len(recent_coords) < min_samples:
        return info

    start_time = next((dt for _, _, dt in recent_coords if dt), None)
    end_time = next((dt for _, _, dt in reversed(recent_coords) if dt), None)
    coverage_minutes = None
    if start_time and end_time:
        coverage_minutes = max((end_time - start_time).total_seconds() / 60.0, 0.0)
        if coverage_minutes < min_coverage_minutes:
            # Low-coverage policy: optionally assume idle unless movement is clearly proven.
            stable_lat, stable_lon = _stable_center_from(recent_coords)
            if stable_lat is not None and stable_lon is not None:
                rr = _robust_radius(recent_coords, stable_lat, stable_lon)
            else:
                rr = 0.0

            net = haversine_distance(recent_coords[0][0], recent_coords[0][1], recent_coords[-1][0], recent_coords[-1][1])
            net = float(net) if isinstance(net, (int, float)) and math.isfinite(net) else 0.0

            # Compute max step quickly.
            max_step = 0.0
            prev = None
            for lat_f, lon_f, _ in recent_coords:
                if prev is not None:
                    d = haversine_distance(prev[0], prev[1], lat_f, lon_f)
                    if isinstance(d, (int, float)) and math.isfinite(d):
                        max_step = max(max_step, float(d))
                prev = (lat_f, lon_f)

            # Low-coverage policy: don't let one-off spikes prove movement.
            # Require meaningful net displacement, or both a big step and some net drift.
            if (
                net >= sparse_prove_moving_net_m
                or (max_step >= sparse_prove_moving_max_step_m and net >= (sparse_prove_moving_net_m * 0.5))
                or rr >= sparse_not_idle_robust_radius_m
            ):
                return info

            if assume_immobile_when_low_coverage:
                info["immobile"] = True
            info["window_minutes"] = max(0, int(round(float(coverage_minutes))))
            if stable_lat is not None and stable_lon is not None:
                info["stable_lat"] = stable_lat
                info["stable_lon"] = stable_lon
            info["summary"] = (
                f"Low time coverage (~{info['window_minutes']} min); assume idle unless movement is proven"
                if assume_immobile_when_low_coverage
                else f"Low time coverage (~{info['window_minutes']} min); not enough evidence to mark idle"
            )
            return info
    elif len(recent_coords) < lookback_minutes // 2:
        return info

    total_distance = 0.0
    step_distances: list[float] = []
    prev = None
    for lat_f, lon_f, _ in recent_coords:
        if prev:
            dist = haversine_distance(prev[0], prev[1], lat_f, lon_f)
            step_distances.append(dist)
            total_distance += dist
        prev = (lat_f, lon_f)

    if not step_distances:
        info["immobile"] = True
        info["summary"] = "No movement detected (static GPS fix)."
        return info

    trimmed_steps = step_distances[:]
    if len(trimmed_steps) > 2:
        trimmed_steps.sort()
        trimmed_steps = trimmed_steps[1:-1]

    trimmed_total = sum(trimmed_steps) if trimmed_steps else total_distance
    trimmed_max = max(trimmed_steps) if trimmed_steps else max(step_distances)
    bbox_distance = bounding_box_distance(recent_coords)
    centroid_lat = sum(lat for lat, _, _ in recent_coords) / len(recent_coords)
    centroid_lon = sum(lon for _, lon, _ in recent_coords) / len(recent_coords)
    max_radius = 0.0
    for lat_f, lon_f, _ in recent_coords:
        dist = haversine_distance(lat_f, lon_f, centroid_lat, centroid_lon)
        if dist > max_radius:
            max_radius = dist

    # Robust cluster center/radius: use median lat/lon and a trimmed max radius.
    # This is much less sensitive to one-off GPS spikes than centroid+max.
    med_lat = _median([lat for lat, _, _ in recent_coords])
    med_lon = _median([lon for _, lon, _ in recent_coords])
    robust_radius = max_radius
    if med_lat is not None and med_lon is not None:
        dists = [haversine_distance(lat, lon, float(med_lat), float(med_lon)) for lat, lon, _ in recent_coords]
        dists = [d for d in dists if isinstance(d, (int, float)) and math.isfinite(d)]
        if dists:
            dists.sort()
            # Drop one min and one max when possible.
            if len(dists) >= 4:
                dists = dists[1:-1]
            robust_radius = dists[-1]

    # Net displacement (first->last) helps distinguish drift from real travel.
    net_dist = 0.0
    if recent_coords:
        a0 = recent_coords[0]
        a1 = recent_coords[-1]
        net_dist = haversine_distance(a0[0], a0[1], a1[0], a1[1])

    stationary_by_travel = (
        trimmed_total < total_distance_threshold
        and trimmed_max < max_step_threshold
        and bbox_distance < bbox_threshold
    )
    stationary_by_radius = (robust_radius < radius_threshold) and (net_dist < net_distance_threshold)

    if stationary_by_travel or stationary_by_radius:
        window_minutes = coverage_minutes if coverage_minutes is not None else lookback_minutes
        info["immobile"] = True
        info["window_minutes"] = int(round(window_minutes))
        if med_lat is not None and med_lon is not None:
            info["stable_lat"] = float(med_lat)
            info["stable_lon"] = float(med_lon)
        else:
            info["stable_lat"] = float(centroid_lat)
            info["stable_lon"] = float(centroid_lon)
        info["summary"] = f"No movement in last ~{info['window_minutes']} min (values dimmed)"

    return info


def default_cache_path(url: str, *, mobile_url: str, fixed_url: str, data_dir: str) -> str:
    if url == mobile_url:
        return os.path.join(data_dir, "cache_mobile.json")
    if url == fixed_url:
        return os.path.join(data_dir, "cache_fixed.json")
    digest = hashlib.sha1(url.encode("utf-8")).hexdigest()[:12]
    return os.path.join(data_dir, f"cache_{digest}.json")


def fetch_json_with_cache(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    timeout: float = 10,
    cache_path: str | None = None,
    request_get: Callable[..., Any] | None = None,
    notify: Callable[[str, str], None] | None = None,
) -> Any | None:
    """
    Fetch JSON from a URL with a best-effort on-disk cache.

    - On success: caches response JSON to cache_path (if provided).
    - On failure: returns cached JSON if available, else None.

    notify(message, severity) is optional; severity is "error" or "warning".
    """
    if request_get is None:
        if requests is None:  # pragma: no cover
            raise RuntimeError("requests not available; pass request_get for tests.")
        request_get = requests.get

    def _notify(msg: str, severity: str) -> None:
        if notify:
            notify(msg, severity)

    try:
        resp = request_get(url, headers=headers, timeout=timeout)
        # requests.Response has raise_for_status; allow test doubles too
        if hasattr(resp, "raise_for_status"):
            resp.raise_for_status()
        data = resp.json() if hasattr(resp, "json") else json.loads(resp.text)

        if cache_path:
            try:
                os.makedirs(os.path.dirname(cache_path), exist_ok=True)
                with open(cache_path, "w") as f:
                    json.dump(data, f)
            except Exception:
                pass

        return data
    except Exception as e:
        _notify(f"Error fetching data from {url}: {e}", "error")

        if cache_path:
            try:
                if os.path.exists(cache_path):
                    with open(cache_path, "r") as f:
                        cached = json.load(f)
                    try:
                        age_s = max(0, int(time.time() - os.path.getmtime(cache_path)))
                        _notify(f"Using cached data ({age_s}s old) for {url}", "warning")
                    except Exception:
                        _notify(f"Using cached data for {url}", "warning")
                    return cached
            except Exception:
                pass

        return None


def generate_leaflet_map_html(
    points: list[dict[str, Any]],
    *,
    title: str = "MobileAir Map",
    center: tuple[float, float] | None = None,
    zoom: int = 10,
) -> str:
    """
    Generate a standalone HTML page that renders a Leaflet map with circle markers.

    Each point dict supports:
    - lat (float), lon (float)
    - label (str) shown in tooltip
    - popup_html (str) shown in popup
    - color (str) marker outline/fill (e.g. "#ff0000")
    """
    import json as _json

    safe_points = []
    for p in points:
        try:
            lat = float(p.get("lat"))
            lon = float(p.get("lon"))
        except Exception:
            continue
        safe_points.append(
            {
                "lat": lat,
                "lon": lon,
                "label": str(p.get("label", "")),
                "popup_html": str(p.get("popup_html", "")),
                "color": str(p.get("color", "#3388ff")),
            }
        )

    if center is None:
        if safe_points:
            center = (
                sum(p["lat"] for p in safe_points) / len(safe_points),
                sum(p["lon"] for p in safe_points) / len(safe_points),
            )
        else:
            center = (40.7608, -111.8910)  # SLC fallback

    payload = _json.dumps(safe_points)
    map_title = _json.dumps(title)

    return f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{title}</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
        integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin=""/>
  <style>
    html, body {{ height: 100%; margin: 0; }}
    #map {{ height: 100%; width: 100%; }}
    .titlebar {{
      position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
      z-index: 1000; background: rgba(0,0,0,0.75); color: #fff;
      padding: 6px 10px; border-radius: 8px; font-family: -apple-system, system-ui, sans-serif;
      font-size: 14px;
    }}
  </style>
</head>
<body>
  <div class="titlebar" id="title"></div>
  <div id="map"></div>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
          integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
  <script>
    const TITLE = {map_title};
    document.getElementById("title").textContent = TITLE;

    const map = L.map('map').setView([{center[0]}, {center[1]}], {int(zoom)});
    L.tileLayer('https://{{s}}.tile.openstreetmap.org/{{z}}/{{x}}/{{y}}.png', {{
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }}).addTo(map);

    const points = {payload};
    const bounds = [];

    for (const p of points) {{
      const ll = [p.lat, p.lon];
      bounds.push(ll);
      const m = L.circleMarker(ll, {{
        radius: 7,
        color: p.color || "#3388ff",
        weight: 2,
        fillColor: p.color || "#3388ff",
        fillOpacity: 0.85,
      }}).addTo(map);
      if (p.label) m.bindTooltip(p.label, {{ direction: "top", opacity: 0.9 }});
      if (p.popup_html) m.bindPopup(p.popup_html);
    }}

    if (bounds.length >= 2) {{
      map.fitBounds(bounds, {{ padding: [20, 20] }});
    }}
  </script>
</body>
</html>
"""


def _coerce_float(x):
    try:
        return float(x)
    except Exception:
        return None


def _median(values: list[float]) -> float | None:
    if not values:
        return None
    xs = sorted(values)
    n = len(xs)
    mid = n // 2
    if n % 2 == 1:
        return float(xs[mid])
    return float((xs[mid - 1] + xs[mid]) / 2.0)


def detect_spatial_outliers(
    sensors: list[dict[str, Any]],
    *,
    pollutant_keys: tuple[str, ...] = ("PM25", "PM2.5"),
    radius_m: float = 15000.0,
    max_radius_m: float = 80000.0,
    max_neighbors: int = 20,
    min_neighbors: int = 3,
    z_thresh: float = 6.0,
    ratio_thresh: float = 3.0,
    abs_thresh: float = 150.0,
) -> set[str]:
    """Detect spatial outliers by comparing a sensor to nearby neighbors.

    A sensor is flagged only when its value is *inconsistent with nearby sensors*
    (local neighborhood), not simply because it's "high".

    Designed for fixed-site PM2.5/PM25 spikes (e.g. one station at 900+ while
    neighbors remain normal). If the surrounding neighborhood is also elevated
    (dust storm / regional event), it should *not* be flagged.
    """

    candidates: list[dict[str, Any]] = []
    for s in sensors:
        if not isinstance(s, dict):
            continue
        sid = s.get("id")
        if not isinstance(sid, str) or not sid:
            continue
        lat = _coerce_float(s.get("lat"))
        lon = _coerce_float(s.get("lon"))
        if lat is None or lon is None:
            continue

        readings = s.get("readings") if isinstance(s.get("readings"), dict) else {}
        val_f: float | None = None
        for k in pollutant_keys:
            v = readings.get(k)
            if isinstance(v, dict):
                val_f = _coerce_float(v.get("value"))
            else:
                val_f = _coerce_float(v)
            if val_f is not None and math.isfinite(val_f):
                break
            val_f = None

        if val_f is None:
            continue

        candidates.append({"id": sid, "lat": float(lat), "lon": float(lon), "value": float(val_f)})

    outliers: set[str] = set()
    if len(candidates) < (min_neighbors + 1):
        return outliers

    for i, s in enumerate(candidates):
        sid = s["id"]
        lat = s["lat"]
        lon = s["lon"]
        val = s["value"]

        neigh_all: list[tuple[float, float]] = []  # (dist_m, neighbor_value)
        for j, o in enumerate(candidates):
            if i == j:
                continue
            d = haversine_distance(lat, lon, o["lat"], o["lon"])
            neigh_all.append((d, o["value"]))

        if len(neigh_all) < min_neighbors:
            continue

        neigh_all.sort(key=lambda t: t[0])

        # Adaptive neighborhood: in sparse regions, expand radius until we have enough neighbors,
        # but never beyond max_radius_m.
        r = float(radius_m)
        r_max = float(max_radius_m)
        r = max(1000.0, r)
        r_max = max(r, r_max)
        neigh: list[tuple[float, float]] = []
        for _ in range(6):
            neigh = [(d, v) for (d, v) in neigh_all if d <= r]
            if len(neigh) >= min_neighbors:
                break
            if r >= r_max:
                break
            r = min(r_max, r * 1.8)

        if len(neigh) < min_neighbors:
            continue

        vals = [v for _, v in neigh[:max_neighbors]]
        if len(vals) < min_neighbors:
            continue

        med = _median(vals)
        if med is None:
            continue

        # Robust scale: MAD (median absolute deviation).
        abs_dev = [abs(v - med) for v in vals]
        mad = _median(abs_dev) or 0.0
        sigma = 1.4826 * float(mad)
        sigma_eff = max(1.0, sigma)  # avoid divide-by-zero and over-triggering on flat neighborhoods

        if val <= med:
            continue

        robust_z = (val - med) / sigma_eff
        ratio = val / max(1.0, float(med))

        # Require multiple signals to reduce false positives:
        # - strongly above local median in robust std-deviations
        # - meaningfully larger in relative and absolute terms
        if robust_z >= z_thresh and ratio >= ratio_thresh and (val - med) >= abs_thresh:
            outliers.add(sid)

    return outliers


def extract_mobile_tracks(
    mobile_json: dict[str, Any],
    *,
    max_points: int = 200,
) -> dict[str, list[dict[str, Any]]]:
    """
    Extract per-sensor breadcrumb points from the mobile API JSON.

    Returns:
      { sensor_id: [ {lat, lon, t}, ... ] }

    Points are sorted by time when TimeUTC is parseable; otherwise original order.
    Capped to max_points.
    """
    # sensor_id -> key(ts/idx) -> record
    per_sensor: dict[str, dict[str, dict[str, Any]]] = {}
    per_sensor_dt: dict[str, dict[str, datetime | None]] = {}
    per_sensor_order: dict[str, list[str]] = {}

    if not isinstance(mobile_json, dict):
        return {}

    for pollutant_key, details in mobile_json.items():
        if not isinstance(details, dict):
            continue
        for sensor_id, s_data in details.items():
            if sensor_id in ("LastUpdateUTC", "LastUpdateLocal", "VarName", "VarUnit"):
                continue
            if not isinstance(s_data, dict):
                continue

            lat_list = s_data.get("Latitude")
            lon_list = s_data.get("Longitude")
            time_list = s_data.get("TimeUTC")
            val_list = s_data.get("Value")
            col_list = s_data.get("ValueColor")

            if not (isinstance(lat_list, list) and isinstance(lon_list, list) and lat_list and lon_list):
                continue

            # Align common length; time/val/color may be shorter; we pad from the front.
            n = min(len(lat_list), len(lon_list))
            lat_values = lat_list[-n:]
            lon_values = lon_list[-n:]

            if isinstance(time_list, list) and time_list:
                time_values = time_list[-n:] if len(time_list) >= n else [None] * (n - len(time_list)) + time_list
            else:
                time_values = [None] * n

            if isinstance(val_list, list) and val_list:
                val_values = val_list[-n:] if len(val_list) >= n else [None] * (n - len(val_list)) + val_list
            else:
                val_values = [None] * n

            if isinstance(col_list, list) and col_list:
                col_values = col_list[-n:] if len(col_list) >= n else [None] * (n - len(col_list)) + col_list
            else:
                col_values = [None] * n

            s_map = per_sensor.setdefault(sensor_id, {})
            s_dt = per_sensor_dt.setdefault(sensor_id, {})
            s_order = per_sensor_order.setdefault(sensor_id, [])

            for idx, (lat, lon, ts, v, c) in enumerate(zip(lat_values, lon_values, time_values, val_values, col_values)):
                lat_f = _coerce_float(lat)
                lon_f = _coerce_float(lon)
                if lat_f is None or lon_f is None:
                    continue

                ts_str = ts if isinstance(ts, str) else None
                key = ts_str or f"idx:{idx}"
                if key not in s_map:
                    s_map[key] = {"lat": lat_f, "lon": lon_f, "t": ts_str, "readings": {}}
                    s_order.append(key)
                    s_dt[key] = parse_utc_timestamp(ts_str) if ts_str else None
                else:
                    # keep latest lat/lon if we see the same timestamp again
                    s_map[key]["lat"] = lat_f
                    s_map[key]["lon"] = lon_f

                if v is not None:
                    s_map[key]["readings"][str(pollutant_key)] = {"value": v, "color": c or "#ffffff"}

    out: dict[str, list[dict[str, Any]]] = {}
    for sensor_id, m in per_sensor.items():
        keys = per_sensor_order.get(sensor_id, list(m.keys()))
        dt_map = per_sensor_dt.get(sensor_id, {})

        # sort by time if any timestamp is parseable
        if any(dt_map.get(k) is not None for k in keys):
            keys = sorted(keys, key=lambda k: (dt_map.get(k) is None, dt_map.get(k) or datetime.min.replace(tzinfo=timezone.utc)))

        points: list[dict[str, Any]] = [m[k] for k in keys if k in m]

        # de-dupe consecutive identical lat/lon/t
        deduped: list[dict[str, Any]] = []
        last_key = None
        for p in points:
            k = (p.get("lat"), p.get("lon"), p.get("t"))
            if k == last_key:
                continue
            last_key = k
            deduped.append(p)

        # Carry-forward pollutant readings so each breadcrumb has a more complete picture.
        #
        # The upstream mobile feed often reports different pollutants on slightly different timestamps.
        # Without this, many trail points end up with ozone-only readings, and DVR/history labels can
        # misleadingly show OZNE even when PM10 is very high (but last updated a moment earlier).
        last_seen: dict[str, dict[str, Any]] = {}
        merged: list[dict[str, Any]] = []
        for p in deduped:
            r = p.get("readings")
            if isinstance(r, dict):
                for pk, pv in r.items():
                    if isinstance(pv, dict):
                        last_seen[str(pk)] = dict(pv)
            p2 = dict(p)
            p2["readings"] = {k: dict(v) for k, v in last_seen.items()}
            merged.append(p2)
        deduped = merged

        if len(deduped) > max_points:
            deduped = deduped[-max_points:]

        out[sensor_id] = deduped

    return out


def _pick_primary_reading_color(readings: dict[str, Any]) -> str:
    # prefer PM25, then PM10, then OZNE, else first available
    priority = ["PM25", "PM2.5", "PM10", "OZNE", "Ozone"]
    for k in priority:
        v = readings.get(k)
        if isinstance(v, dict) and isinstance(v.get("color"), str):
            return v["color"]
    for v in readings.values():
        if isinstance(v, dict) and isinstance(v.get("color"), str):
            return v["color"]
    return "#3388ff"


def _pick_primary_pollutant_key(readings: dict[str, Any]) -> str | None:
    priority = ["PM25", "PM2.5", "PM10", "OZNE", "Ozone"]
    for k in priority:
        if k in readings:
            return k
    return next(iter(readings.keys()), None)


def _normalize_pollutant_key_for_aqi(k: str) -> str:
    kk = (k or "").strip().lower()
    if kk in ("pm25", "pm2.5", "pm2_5", "pm2-5", "pm2.5 ", "pm 2.5"):
        return "pm2.5"
    if kk in ("pm10", "pm 10"):
        return "pm10"
    if kk in ("ozne", "ozone", "o3"):
        return "ozone"
    # fall back (may still map to pm2.5 breakpoints in value_to_aqi)
    return kk


def _pick_worst_reading_by_aqi(readings: dict[str, Any]) -> dict[str, Any]:
    """
    Pick the reading with the highest AQI (non-linear) among available pollutants.
    Returns {key, value, color, aqi} (aqi may be None).
    """
    best = {"key": None, "value": None, "color": "#ffffff", "aqi": None}
    best_aqi = -1.0
    for k, v in readings.items():
        if not isinstance(v, dict):
            continue
        val = v.get("value")
        col = v.get("color") or "#ffffff"
        aqi = value_to_aqi(_normalize_pollutant_key_for_aqi(str(k)), val)
        try:
            aqi_f = float(aqi) if aqi is not None else -1.0
        except Exception:
            aqi_f = -1.0
        if aqi_f > best_aqi:
            best_aqi = aqi_f
            best = {"key": str(k), "value": val, "color": col, "aqi": aqi_f if aqi_f >= 0 else None}

    # If no AQI could be computed, fall back to priority key ordering.
    if best["key"] is None:
        k0 = _pick_primary_pollutant_key(readings)
        if k0 and isinstance(readings.get(k0), dict):
            return {"key": k0, "value": readings[k0].get("value"), "color": readings[k0].get("color") or "#ffffff", "aqi": None}
    return best


def _clean_trail(
    pts: list[dict[str, Any]],
    *,
    dedup_m: float = 2.0,
    spike_out_m: float = 55.0,
    spike_ret_m: float = 22.0,
    spike_plateau_m: float = 30.0,
    parked_tail_n: int = 24,
    parked_radius_m: float = 90.0,
    parked_min_pts: int = 12,
    parked_min_span_s: float = 60.0,
    parked_max_travel_m: float = 260.0,
    parked_max_scan: int = 1200,
) -> list[dict[str, Any]]:
    if not isinstance(pts, list) or len(pts) < 2:
        return pts

    def _pt_latlon(p: dict[str, Any] | None) -> tuple[float | None, float | None]:
        if not isinstance(p, dict):
            return (None, None)
        lat = _coerce_float(p.get("lat"))
        lon = _coerce_float(p.get("lon"))
        return (lat, lon)

    def _pt_tms(p: dict[str, Any] | None) -> float | None:
        if not isinstance(p, dict):
            return None
        ts = p.get("t")
        if not isinstance(ts, str) or not ts:
            return None
        dt = parse_utc_timestamp(ts)
        if dt is None:
            return None
        try:
            return float(dt.timestamp())
        except Exception:
            return None

    # 1) Dedup consecutive tiny steps.
    out: list[dict[str, Any]] = []
    last_lat = None
    last_lon = None
    for p in pts:
        lat, lon = _pt_latlon(p)
        if lat is None or lon is None:
            continue
        if last_lat is not None and last_lon is not None:
            d = haversine_distance(float(last_lat), float(last_lon), float(lat), float(lon))
            if isinstance(d, (int, float)) and math.isfinite(d) and d <= dedup_m:
                continue
        out.append(p)
        last_lat, last_lon = lat, lon
    pts = out
    if len(pts) < 4:
        return pts

    # 2) Scrub short out-and-back spikes (A-B-C and A-B-C-D patterns).
    #    Only scan the recent window to keep it cheap.
    start = max(1, len(pts) - int(max(20, parked_max_scan)))

    changed = True
    while changed:
        changed = False
        # A-B-C
        i = start
        while i < len(pts) - 1:
            a = pts[i - 1]
            b = pts[i]
            c = pts[i + 1]
            latA, lonA = _pt_latlon(a)
            latB, lonB = _pt_latlon(b)
            latC, lonC = _pt_latlon(c)
            if None in (latA, lonA, latB, lonB, latC, lonC):
                i += 1
                continue
            dAB = haversine_distance(float(latA), float(lonA), float(latB), float(lonB))
            dBC = haversine_distance(float(latB), float(lonB), float(latC), float(lonC))
            dAC = haversine_distance(float(latA), float(lonA), float(latC), float(lonC))
            if (
                isinstance(dAB, (int, float))
                and isinstance(dBC, (int, float))
                and isinstance(dAC, (int, float))
                and math.isfinite(dAB)
                and math.isfinite(dBC)
                and math.isfinite(dAC)
                and dAB >= spike_out_m
                and dBC >= spike_out_m
                and dAC <= spike_ret_m
            ):
                del pts[i]
                changed = True
                i = max(start, i - 2)
                continue
            i += 1

        # A-B-C-D
        i = start
        while i < len(pts) - 2:
            a = pts[i - 1]
            b = pts[i]
            c = pts[i + 1]
            d = pts[i + 2]
            latA, lonA = _pt_latlon(a)
            latB, lonB = _pt_latlon(b)
            latC, lonC = _pt_latlon(c)
            latD, lonD = _pt_latlon(d)
            if None in (latA, lonA, latB, lonB, latC, lonC, latD, lonD):
                i += 1
                continue
            dAB = haversine_distance(float(latA), float(lonA), float(latB), float(lonB))
            dBC = haversine_distance(float(latB), float(lonB), float(latC), float(lonC))
            dCD = haversine_distance(float(latC), float(lonC), float(latD), float(lonD))
            dAD = haversine_distance(float(latA), float(lonA), float(latD), float(lonD))
            if (
                isinstance(dAB, (int, float))
                and isinstance(dBC, (int, float))
                and isinstance(dCD, (int, float))
                and isinstance(dAD, (int, float))
                and math.isfinite(dAB)
                and math.isfinite(dBC)
                and math.isfinite(dCD)
                and math.isfinite(dAD)
                and dAB >= spike_out_m
                and dCD >= spike_out_m
                and dAD <= spike_ret_m
                and dBC <= spike_plateau_m
            ):
                del pts[i : i + 2]
                changed = True
                i = max(start, i - 2)
                continue
            i += 1

    if len(pts) < (parked_min_pts + 2):
        return pts

    # 3) Collapse parked stationary suffix based on motion, independent of ghosted flag.
    tail = pts[max(0, len(pts) - int(max(6, parked_tail_n))) :]
    lats: list[float] = []
    lons: list[float] = []
    for p in tail:
        if not isinstance(p, dict):
            continue
        lat = _coerce_float(p.get("lat"))
        lon = _coerce_float(p.get("lon"))
        if lat is None or lon is None:
            continue
        lats.append(float(lat))
        lons.append(float(lon))
    med_lat = _median(lats)
    med_lon = _median(lons)
    if med_lat is None or med_lon is None:
        return pts
    center_lat = float(med_lat)
    center_lon = float(med_lon)

    scan_start = max(0, len(pts) - int(max(100, parked_max_scan)))
    i0 = len(pts) - 1
    while i0 - 1 >= scan_start:
        lat, lon = _pt_latlon(pts[i0 - 1])
        if lat is None or lon is None:
            break
        d = haversine_distance(center_lat, center_lon, float(lat), float(lon))
        if not (isinstance(d, (int, float)) and math.isfinite(d) and d <= parked_radius_m):
            break
        i0 -= 1

    suffix_len = len(pts) - i0
    if suffix_len < parked_min_pts:
        return pts

    t0 = _pt_tms(pts[i0])
    t1 = _pt_tms(pts[-1])
    if t0 is not None and t1 is not None and (t1 - t0) < parked_min_span_s:
        return pts

    travel = 0.0
    for k in range(i0 + 1, len(pts)):
        latA, lonA = _pt_latlon(pts[k - 1])
        latB, lonB = _pt_latlon(pts[k])
        if None in (latA, lonA, latB, lonB):
            continue
        d = haversine_distance(float(latA), float(lonA), float(latB), float(lonB))
        if isinstance(d, (int, float)) and math.isfinite(d):
            travel += float(d)
            if travel > parked_max_travel_m:
                return pts

    # Collapse tail to: entry point + one stable representative at the center.
    last = pts[-1]
    rep: dict[str, Any] = {"lat": center_lat, "lon": center_lon}
    if isinstance(last, dict) and isinstance(last.get("t"), str):
        rep["t"] = last.get("t")
    if isinstance(last, dict) and isinstance(last.get("readings"), dict):
        rep["readings"] = last.get("readings")
    if (len(pts) - (i0 + 1)) <= 1:
        return pts
    return pts[: i0 + 1] + [rep]


def _collapse_stationary_suffix(
    pts: list[dict[str, Any]],
    *,
    center_lat: float,
    center_lon: float,
    radius_m: float = 70.0,
    min_pts: int = 10,
) -> list[dict[str, Any]]:
    if not isinstance(pts, list) or len(pts) < (min_pts + 2):
        return pts
    if not (isinstance(center_lat, (int, float)) and isinstance(center_lon, (int, float))):
        return pts
    if not (math.isfinite(center_lat) and math.isfinite(center_lon) and radius_m > 0):
        return pts

    i0 = len(pts) - 1
    while i0 - 1 >= 0:
        p = pts[i0 - 1]
        lat = _coerce_float(p.get("lat")) if isinstance(p, dict) else None
        lon = _coerce_float(p.get("lon")) if isinstance(p, dict) else None
        if lat is None or lon is None:
            break
        d = haversine_distance(center_lat, center_lon, float(lat), float(lon))
        if not (isinstance(d, (int, float)) and math.isfinite(d) and d <= radius_m):
            break
        i0 -= 1

    suffix_len = len(pts) - i0
    if suffix_len < min_pts:
        return pts

    last = pts[-1] if pts else {}
    rep: dict[str, Any] = {
        "lat": float(center_lat),
        "lon": float(center_lon),
        "t": last.get("t") if isinstance(last, dict) else None,
    }
    if isinstance(last, dict) and isinstance(last.get("readings"), dict):
        rep["readings"] = last.get("readings")

    # Keep entry point (pts[i0]) so approach path still connects.
    if (len(pts) - (i0 + 1)) <= 1:
        return pts
    return pts[: i0 + 1] + [rep]


def normalize_state_for_dashboard(
    combined_data: dict[str, Any],
    *,
    custom_names: dict[str, str] | None = None,
    pinned_sensors: set[str] | None = None,
    max_points: int = 200,
    mobile_url: str,
    fixed_url: str,
    data_dir: str,
) -> dict[str, Any]:
    """
    Normalize combined API data into a dashboard-friendly JSON shape.
    """
    custom_names = custom_names or {}
    pinned_sensors = pinned_sensors or set()

    mobile_json = combined_data.get("mobile") if isinstance(combined_data, dict) else {}
    fixed_json = combined_data.get("fixed") if isinstance(combined_data, dict) else {}

    tracks = extract_mobile_tracks(mobile_json if isinstance(mobile_json, dict) else {}, max_points=max_points)

    # A single "last updated" value for the UI:
    # Prefer the most recent *position change* (lat/lon changed) across all mobile tracks.
    def _pos_changed(a: dict[str, Any] | None, b: dict[str, Any] | None, eps: float = 1e-6) -> bool:
        if not isinstance(a, dict) or not isinstance(b, dict):
            return False
        try:
            lat1 = float(a.get("lat"))
            lon1 = float(a.get("lon"))
            lat2 = float(b.get("lat"))
            lon2 = float(b.get("lon"))
        except Exception:
            return False
        return (abs(lat2 - lat1) > eps) or (abs(lon2 - lon1) > eps)

    last_sample_dt = None
    last_move_dt = None
    for _sid, pts in tracks.items():
        if not isinstance(pts, list) or not pts:
            continue
        for p in pts:
            dt = parse_utc_timestamp(p.get("t")) if isinstance(p, dict) and isinstance(p.get("t"), str) else None
            if dt is not None and (last_sample_dt is None or dt > last_sample_dt):
                last_sample_dt = dt
        prev = None
        for p in pts:
            if _pos_changed(prev, p):
                dt = parse_utc_timestamp(p.get("t")) if isinstance(p, dict) and isinstance(p.get("t"), str) else None
                if dt is not None and (last_move_dt is None or dt > last_move_dt):
                    last_move_dt = dt
            prev = p
    ui_dt = last_move_dt or last_sample_dt
    ui_ts = float(ui_dt.timestamp()) if ui_dt is not None else time.time()



    # Build mobile sensors list with current position = last track point
    mobile_sensors: list[dict[str, Any]] = []
    outlier_scrubs: list[dict[str, Any]] = []
    for sensor_id, pts in tracks.items():
        if not pts:
            continue
        pts = _clean_trail(pts)
        last = pts[-1]
        name = custom_names.get(sensor_id) or ""

        # Mobility (match the TUI semantics as closely as possible):
        # - We evaluate mobility from the merged breadcrumb trail (tracks) so it's consistent
        #   across pollutants and not sensitive to dict iteration order / per-pollutant cadence.
        # - A mobile sensor becomes "ghosted/stale" when immobile (dashboard has no forced-active toggle).
        mobility_info: dict[str, Any] = {}
        # Build a minimal sensor_blob from the trail points for mobility evaluation.
        trail_lat: list[float] = []
        trail_lon: list[float] = []
        trail_time: list[str] = []
        for trail_point in pts:
            if not isinstance(trail_point, dict):
                continue
            lat_f = _coerce_float(trail_point.get("lat"))
            lon_f = _coerce_float(trail_point.get("lon"))
            ts_str = trail_point.get("t") if isinstance(trail_point.get("t"), str) else None
            if lat_f is None or lon_f is None or not ts_str:
                continue
            trail_lat.append(float(lat_f))
            trail_lon.append(float(lon_f))
            trail_time.append(ts_str)

        if trail_lat and trail_lon:
            trail_blob = {"Latitude": trail_lat, "Longitude": trail_lon, "TimeUTC": trail_time}

            # No special-case mobility tuning here. Keep a single mobility policy so
            # we don't introduce per-sensor-type magic thresholds that cause regressions.
            mobility_info = evaluate_mobility(trail_blob)

            # Per-point moving flag used by playback visibility.
            point_times = [parse_utc_timestamp(p.get("t")) if isinstance(p, dict) else None for p in pts]
            # Trailing time window for per-point motion classification.
            lookback_s = float(max(60.0, IMMOBILITY_LOOKBACK_MINUTES * 120.0))
            window_start_idx = 0
            for idx in range(len(pts)):
                current_dt = point_times[idx]
                # If timestamps are missing, be conservative and treat as idle.
                if current_dt is None:
                    if isinstance(pts[idx], dict):
                        pts[idx]["m"] = 0
                    continue

                cutoff_dt = current_dt - timedelta(seconds=lookback_s)
                while window_start_idx < idx and point_times[window_start_idx] is not None and point_times[window_start_idx] < cutoff_dt:
                    window_start_idx += 1

                window_points = pts[window_start_idx : idx + 1]
                window_latitudes: list[float] = []
                window_longitudes: list[float] = []
                window_timestamps: list[str] = []
                for window_point in window_points:
                    if not isinstance(window_point, dict):
                        continue
                    lat_f = _coerce_float(window_point.get("lat"))
                    lon_f = _coerce_float(window_point.get("lon"))
                    ts_str = window_point.get("t") if isinstance(window_point.get("t"), str) else None
                    if lat_f is None or lon_f is None or not ts_str:
                        continue
                    window_latitudes.append(float(lat_f))
                    window_longitudes.append(float(lon_f))
                    window_timestamps.append(ts_str)
                if len(window_latitudes) < 2:
                    # Not enough to decide; treat as idle.
                    pts[idx]["m"] = 0
                    continue
                window_blob = {"Latitude": window_latitudes, "Longitude": window_longitudes, "TimeUTC": window_timestamps}
                window_mobility = evaluate_mobility(
                    window_blob,
                    # Default: assume idle unless movement is proven.
                    assume_immobile_when_sparse=True,
                    assume_immobile_when_low_coverage=True,
                    allow_short_window_immobile=True,
                )
                is_window_immobile = bool(window_mobility.get("immobile"))
                pts[idx]["m"] = 0 if is_window_immobile else 1
        is_immobile = bool(mobility_info.get("immobile"))
        forced_active = False
        ghosted = bool(is_immobile and not forced_active)

        stable_lat = _coerce_float(mobility_info.get("stable_lat"))
        stable_lon = _coerce_float(mobility_info.get("stable_lon"))
        pts2 = pts
        last2 = last
        if ghosted and stable_lat is not None and stable_lon is not None:
            # Replace the reported position with the stable center and collapse the
            # stationary tail of the breadcrumb trail.
            pts2 = _collapse_stationary_suffix(pts, center_lat=float(stable_lat), center_lon=float(stable_lon), radius_m=70.0, min_pts=10)
            if pts2:
                last2 = pts2[-1]

        readings: dict[str, Any] = {}
        # collect latest values/colors for key pollutants across the mobile payload
        if isinstance(mobile_json, dict):
            for pollutant_key, details in mobile_json.items():
                if not isinstance(details, dict):
                    continue
                s_data = details.get(sensor_id)
                if not isinstance(s_data, dict):
                    continue
                vals = s_data.get("Value")
                cols = s_data.get("ValueColor")
                v = None
                c = None
                if isinstance(vals, list) and vals:
                    v = vals[-1]
                if isinstance(cols, list) and cols and isinstance(vals, list) and len(cols) == len(vals):
                    c = cols[-1]
                elif isinstance(cols, list) and cols:
                    c = cols[-1]
                if v is None and isinstance(s_data.get("Value"), (str, int, float)):
                    v = s_data.get("Value")
                if c is None and isinstance(s_data.get("ValueColor"), str):
                    c = s_data.get("ValueColor")
                if v is not None:
                    filtered_vals, filtered_cols, removed_vals = filter_history_outliers(
                        str(pollutant_key),
                        vals if isinstance(vals, list) else [v],
                        cols if isinstance(cols, list) else None,
                    )
                    if filtered_cols is None:
                        # Ensure the UI always has a color entry per history value.
                        filtered_cols = [c or "#ffffff"] * len(filtered_vals)

                    if removed_vals:
                        outlier_scrubs.append(
                            {
                                "sensor_id": sensor_id,
                                "pollutant": str(pollutant_key),
                                "removed": removed_vals,
                                "ts": ui_ts,
                            }
                        )
                    readings[str(pollutant_key)] = {
                        "value": v,
                        "color": c or "#ffffff",
                        "history": filtered_vals,
                        "history_colors": filtered_cols,
                        "scrubbed": len(removed_vals),
                    }

        sid = sensor_id.upper()
        if sid.startswith("BUS"):
            emoji = "🚍"
        elif sid.startswith("TRX") or sid.startswith("TRAX"):
            emoji = "🚃"
        else:
            emoji = "📍"

        worst = _pick_worst_reading_by_aqi(readings)
        mobile_sensors.append(
            {
                "id": sensor_id,
                "name": name,
                "pinned": sensor_id in pinned_sensors,
                "emoji": emoji,
                "lat": last2.get("lat"),
                "lon": last2.get("lon"),
                "trail": pts2,
                "readings": readings,
                "mobility": mobility_info,
                "immobile": is_immobile,
                "forced_active": forced_active,
                "ghosted": ghosted,
                "color": _pick_primary_reading_color(readings),
                "primary_key": worst.get("key"),
                "primary_value": worst.get("value"),
                "primary_color": worst.get("color"),
                "primary_aqi": worst.get("aqi"),
            }
        )

    # Fixed sensors (optional context)
    fixed_sensors: list[dict[str, Any]] = []
    if isinstance(fixed_json, dict):
        # fixed payload is pollutant_key -> dict of sensors
        fixed_by_sensor: dict[str, dict[str, Any]] = {}
        for pollutant_key, details in fixed_json.items():
            if not isinstance(details, dict):
                continue
            for sensor_id, s_data in details.items():
                if sensor_id in ("LastUpdateUTC", "LastUpdateLocal", "APITimeStart", "APITimeEnd", "VarName", "VarUnit"):
                    continue
                if not isinstance(s_data, dict):
                    continue
                lat = s_data.get("Latitude")
                lon = s_data.get("Longitude")
                lat_f = _coerce_float(lat)
                lon_f = _coerce_float(lon)
                if lat_f is None or lon_f is None:
                    continue
                entry = fixed_by_sensor.setdefault(sensor_id, {"id": sensor_id, "lat": lat_f, "lon": lon_f, "readings": {}})
                entry["readings"][str(pollutant_key)] = {"value": s_data.get("Value"), "color": s_data.get("ValueColor", "#cccccc")}
        fixed_sensors = []
        for s_id, entry in fixed_by_sensor.items():
            name = custom_names.get(s_id) or ""
            readings = entry.get("readings", {}) if isinstance(entry.get("readings"), dict) else {}
            worst = _pick_worst_reading_by_aqi(readings)
            fixed_sensors.append(
                {
                    "id": s_id,
                    "name": name,
                    "pinned": s_id in pinned_sensors,
                    "emoji": "📍",
                    "lat": entry.get("lat"),
                    "lon": entry.get("lon"),
                    "readings": readings,
                    "color": _pick_primary_reading_color(readings),
                    "primary_key": worst.get("key"),
                    "primary_value": worst.get("value"),
                    "primary_color": worst.get("color"),
                    "primary_aqi": worst.get("aqi"),
                }
            )

    # Hide fixed-site spatial outliers (neighbor-consensus; avoids absolute-threshold filtering).
    fixed_outliers = detect_spatial_outliers(
        fixed_sensors,
        pollutant_keys=("PM25", "PM2.5"),
        radius_m=15000.0,
        max_radius_m=80000.0,
        min_neighbors=3,
    )
    if fixed_outliers:
        fixed_sensors = [s for s in fixed_sensors if str(s.get("id")) not in fixed_outliers]

    # Sort (match TUI intent): idle/ghosted first, then pinned, then active, then id.
    mobile_sensors.sort(
        key=lambda s: (
            not bool(s.get("ghosted")),
            not bool(s.get("pinned")),
            str(s.get("id")),
        )
    )

    meta: dict[str, Any] = {
            "max_points": max_points,
            "mobile_url": mobile_url,
            "fixed_url": fixed_url,
            "data_dir": data_dir,
            "last_position_change_ts": ui_ts,
            "fixed_outliers": sorted(list(fixed_outliers)) if fixed_outliers else [],
        }
    if outlier_scrubs:
        meta["outlier_scrubs"] = outlier_scrubs
        meta["outlier_scrubs_count"] = len(outlier_scrubs)

    return {
        "ts": time.time(),
        "meta": meta,
        "mobile": mobile_sensors,
        "fixed": fixed_sensors,
    }


