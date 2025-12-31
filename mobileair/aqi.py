"""
AQI (Air Quality Index) calculations.

Handles value-to-AQI conversion, level determination, and color mapping.
"""

from __future__ import annotations

import math
from typing import Any

from .config import AQI_LEVELS, POLLUTANT_BREAKPOINTS, TREND_THRESHOLDS


def normalize_pollutant_key(key: str) -> str:
    """Normalize pollutant key for consistent lookups."""
    kk = (key or "").strip().lower()
    if kk in ("pm25", "pm2.5", "pm2_5", "pm2-5", "pm 2.5"):
        return "pm2.5"
    if kk in ("pm10", "pm 10"):
        return "pm10"
    if kk in ("ozne", "ozone", "o3"):
        return "ozone"
    return kk


def value_to_aqi(pollutant_key: str, value: float | str | None) -> float | None:
    """Convert a pollutant concentration to its AQI value."""
    try:
        val = float(value)
    except (TypeError, ValueError):
        return None
    
    key = normalize_pollutant_key(pollutant_key)

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
    
    # Handle out-of-range values
    if breakpoints:
        if val < breakpoints[0]["c_low"]:
            return breakpoints[0]["aqi_low"]
        if val > breakpoints[-1]["c_high"]:
            return breakpoints[-1]["aqi_high"]
    return None


def aqi_level(aqi: float | None) -> dict[str, Any]:
    """Get the AQI level information (label, color, aqi_hi) for a given AQI value."""
    if aqi is None:
        return {"label": "Unknown", "color": "#AAAAAA", "aqi_hi": None}
    for level in AQI_LEVELS:
        if aqi <= level["aqi_hi"]:
            return level
    return AQI_LEVELS[-1]


def color_for_value(pollutant_key: str, value: float | str | None) -> str:
    """Get the AQI-based color for a pollutant value."""
    return aqi_level(value_to_aqi(pollutant_key, value))["color"]


def trend_threshold(pollutant_key: str) -> float:
    """Get the trend detection threshold for a pollutant."""
    return TREND_THRESHOLDS.get(pollutant_key.lower(), TREND_THRESHOLDS["default"])


def filter_history_outliers(
    pollutant_key: str,
    values: list[Any] | None,
    colors: list[Any] | None = None,
) -> tuple[list[Any], list[Any] | None, list[float]]:
    """Remove obvious single-sample glitches from history.

    This is intentionally conservative: it targets clearly impossible/implausible spikes
    (like OZNE=778) that otherwise dominate sparklines and trend indicators.

    Returns (filtered_values, filtered_colors, removed_values) and preserves alignment when colors provided.
    """
    if not isinstance(values, list) or not values:
        return ([], colors if isinstance(colors, list) else None, [])

    key = normalize_pollutant_key(pollutant_key)

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


def extract_numeric_history(history: Any) -> list[float]:
    """Extract numeric values from history, handling both dicts and direct values."""
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


def compute_trend_indicator(
    pollutant_key: str,
    unit: str,
    history: Any,
    current_value: Any,
) -> dict[str, Any] | None:
    """Compute a trend indicator (rising/falling/stable) from history data."""
    from .config import TREND_WINDOW_SAMPLES
    
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
