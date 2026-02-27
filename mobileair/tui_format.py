"""
Shared TUI formatting logic for both terminal and web console interfaces.

This module provides data transformation functions that prepare sensor data
for display in a consistent format across both the Python Textual TUI and
the browser-based console interface.

The key principle is: format once, render anywhere. Both UIs consume the same
pre-formatted data structure, differing only in how they render it (Rich Text
vs DOM elements).
"""

from __future__ import annotations

from typing import Any

from .aqi import AQI_COLOR_PALETTE


# Pollutant display order - always show in this exact order
POLLUTANT_ORDER = ["PM25", "PM10", "OZNE"]

# Display labels for each pollutant
POLLUTANT_LABELS = {
    "PM25": "PM25",
    "PM10": "PM10",
    "OZNE": "OZNE",
}

# Column widths for alignment
VALUE_WIDTH = 5
MAX_NAME_LEN = 25

# Column width for each pollutant cell: "PM25: 21.10 ▲" = label(4) + ": "(2) + value(5) + " "(1) + trend(1) = 13
POLLUTANT_COLUMN_WIDTH = 13


def format_value(value: Any, width: int = VALUE_WIDTH) -> str:
    """Format a sensor value for display, right-aligned to width."""
    if value is None:
        return " " * width
    try:
        v = float(value)
        if v >= 100:
            formatted = f"{v:.0f}"
        elif v >= 10:
            formatted = f"{v:.1f}"
        else:
            formatted = f"{v:.2f}"
        return formatted.rjust(width)
    except (ValueError, TypeError):
        return str(value)[:width].rjust(width)


def get_trend_symbol(reading: dict[str, Any] | None, pollutant: str = "") -> tuple[str, str]:
    """
    Calculate trend symbol and color from reading history.
    
    Returns (symbol, color) tuple where symbol is one of: "▲", "▼", "-", " "
    """
    if not reading or not isinstance(reading, dict):
        return (" ", "#888888")
    
    history = reading.get("history", [])
    if not isinstance(history, list) or len(history) < 5:
        return ("-", "#888888")
    
    # Convert to floats, filtering invalid
    vals = []
    for v in history:
        try:
            n = float(v) if v is not None else None
            if n is not None and not (n != n):  # Check for NaN
                vals.append(n)
        except (ValueError, TypeError):
            pass
    
    if len(vals) < 5:
        return ("-", "#888888")
    
    # Use last 8 samples for responsiveness
    window_size = 8
    window = vals[-window_size:] if len(vals) >= window_size else vals
    
    current = window[-1]
    start_val = window[0]
    
    # Thresholds by pollutant
    pk = pollutant.lower()
    if "pm25" in pk or "pm2.5" in pk:
        threshold = 1.0
    elif "pm10" in pk:
        threshold = 2.0
    elif "ozne" in pk or "ozone" in pk:
        threshold = 2.0
    else:
        threshold = 1.0
    
    delta = current - start_val
    
    # Stable check: if last 3 samples are very close, it's unchanged
    last3 = window[-3:] if len(window) >= 3 else window
    if len(last3) >= 3:
        range3 = max(last3) - min(last3)
        if range3 < threshold * 0.5:
            return ("-", "#888888")
    
    # Count directional moves to filter noise
    step_noise = max(threshold * 0.2, 0.1)
    pos_moves = sum(1 for i in range(len(window) - 1) if window[i + 1] - window[i] >= step_noise)
    neg_moves = sum(1 for i in range(len(window) - 1) if window[i + 1] - window[i] <= -step_noise)
    
    symbol = "-"
    color = "#888888"
    
    if delta > threshold and pos_moves > 1:
        symbol = "▲"
        color = "#fb4934"  # Red for rising
    elif delta < -threshold and neg_moves > 1:
        symbol = "▼"
        color = "#b8bb26"  # Green for falling
    
    # Recovery logic: if last step contradicts trend, neutralize
    if len(window) >= 2:
        last_step = current - window[-2]
        if symbol == "▲" and last_step < -threshold * 0.5:
            symbol = "-"
            color = "#888888"
        if symbol == "▼" and last_step > threshold * 0.5:
            symbol = "-"
            color = "#888888"
    
    return (symbol, color)


def get_pollutant_columns(readings: dict[str, Any]) -> list[dict[str, Any]]:
    """
    Extract pollutant columns from readings dict in consistent order.
    
    Returns list of dicts with:
        - key: pollutant key (PM25, PM10, OZNE)
        - label: display label
        - value: raw numeric value or None
        - formatted: right-aligned formatted string
        - color: hex color for value
        - has_value: boolean indicating if value exists
        - trend_symbol: trend indicator (▲, ▼, -, or space)
        - trend_color: hex color for trend symbol
    """
    if not isinstance(readings, dict):
        readings = {}
    
    columns = []
    for pollutant in POLLUTANT_ORDER:
        # Try various key formats for compatibility
        reading = readings.get(pollutant)
        if not reading:
            reading = readings.get(pollutant.lower())
        if not reading and pollutant == "PM25":
            reading = readings.get("PM2.5")
        if not reading and pollutant == "OZNE":
            reading = readings.get("Ozone") or readings.get("ozone")
        
        if reading and isinstance(reading, dict):
            value = reading.get("value")
            color = AQI_COLOR_PALETTE[reading.get("ci", 0)]
            has_value = value is not None
            formatted = format_value(value)
            trend_symbol, trend_color = get_trend_symbol(reading, pollutant)
        else:
            value = None
            color = "#888888"
            has_value = False
            formatted = " " * VALUE_WIDTH
            trend_symbol = " "
            trend_color = "#888888"
        
        columns.append({
            "key": pollutant,
            "label": POLLUTANT_LABELS.get(pollutant, pollutant),
            "value": value,
            "formatted": formatted,
            "color": color,
            "has_value": has_value,
            "trend_symbol": trend_symbol,
            "trend_color": trend_color,
        })
    
    return columns


def truncate_name(name: str, max_len: int = MAX_NAME_LEN) -> str:
    """Truncate name with ellipsis if too long."""
    if len(name) > max_len:
        return name[:max_len - 1] + "…"
    return name


def format_sensor_for_list(sensor: dict[str, Any], sensor_type: str = "mobile") -> dict[str, Any]:
    """
    Format a sensor for display in the sensor list.
    
    This is the primary formatting function - it produces a consistent data
    structure that both Python Textual and browser JS can consume.
    
    Args:
        sensor: Raw sensor dict from API state
        sensor_type: "mobile" or "fixed"
    
    Returns:
        Dict with display-ready data including formatted columns
    """
    sensor_id = sensor.get("id", "")
    name = sensor.get("name", "")
    emoji = sensor.get("emoji", "")
    pinned = sensor.get("pinned", False)
    ghosted = sensor.get("ghosted", False)
    lat = sensor.get("lat")
    lon = sensor.get("lon")
    
    # Build display name
    if name:
        display_name = f"{sensor_id} ({name})"
    else:
        display_name = sensor_id
    
    return {
        "id": sensor_id,
        "name": name,
        "display_name": display_name,
        "truncated_name": truncate_name(display_name),
        "emoji": emoji,
        "pinned": pinned,
        "ghosted": ghosted,
        "type": sensor_type,
        "type_label": "Fixed Station" if sensor_type == "fixed" else "Mobile",
        "lat": lat,
        "lon": lon,
        "purpleair": bool(sensor.get("purpleair", False)),
        "columns": get_pollutant_columns(sensor.get("readings", {})),
        # Pass through raw readings for detail views that need history
        "readings": sensor.get("readings", {}),
    }


def format_all_sensors(
    state: dict[str, Any],
    *,
    slc_filter: bool = True,
) -> list[dict[str, Any]]:
    """
    Format all sensors from state for list display.
    
    Combines mobile and fixed sensors, optionally filters to SLC area,
    and sorts by ghosted, pinned, then ID.
    
    Args:
        state: Raw API state with 'mobile' and 'fixed' arrays
        slc_filter: If True, filter fixed sensors to SLC area
    
    Returns:
        List of formatted sensor dicts
    """
    sensors = []
    
    for m in state.get("mobile", []):
        sensors.append(format_sensor_for_list(m, "mobile"))
    
    for f in state.get("fixed", []):
        # Optionally filter to SLC area
        if slc_filter:
            lat = f.get("lat")
            lon = f.get("lon")
            if lat is None or lon is None:
                continue
            if not (40.4 <= lat <= 41.0 and -112.25 <= lon <= -111.7):
                continue
        sensors.append(format_sensor_for_list(f, "fixed"))
    
    # Sort: ghosted first (visible but dimmed), then pinned, then by ID
    sensors.sort(key=lambda s: (not s["ghosted"], not s["pinned"], s["id"]))
    
    return sensors


def format_json_view(
    sensor_id: str,
    readings: dict[str, Any],
    *,
    coords: tuple[float, float] | None = None,
    mobility_info: dict[str, Any] | None = None,
    is_ghosted: bool = False,
    sensor_type: str = "mobile",
    trail: list[dict] | None = None,
) -> dict[str, Any]:
    """
    Format sensor data for the JSON view panel.
    
    This creates the structured view used by both Python and web TUI
    for displaying raw API data in a readable format.
    
    Args:
        sensor_id: Sensor identifier
        readings: Dict of pollutant -> reading data
        coords: (lat, lon) tuple if available
        mobility_info: Mobility detection info (for mobile sensors)
        is_ghosted: Whether sensor is parked/ghosted
        sensor_type: "mobile" or "fixed"
        trail: Trail points array (for mobile sensors)
    
    Returns:
        Structured dict for JSON display
    """
    from datetime import datetime
    
    view: dict[str, Any] = {"id": sensor_id}
    
    # Metadata section
    view["_meta"] = {
        "fetched_at": datetime.now().strftime("%H:%M:%S"),
        "status": "PARKED" if is_ghosted else "ACTIVE",
        "type": sensor_type.upper(),
    }
    
    # Readings with partial history
    for key in POLLUTANT_ORDER:
        reading = readings.get(key)
        if not reading:
            # Try alternate key names
            if key == "PM25":
                reading = readings.get("PM2.5")
            elif key == "OZNE":
                reading = readings.get("Ozone") or readings.get("ozone")
        
        if reading and isinstance(reading, dict):
            history = reading.get("history", [])
            hist_len = len(history) if isinstance(history, list) else 0
            last5 = history[-5:] if isinstance(history, list) and history else []
            
            view[key] = {
                "value": reading.get("value"),
                "color": reading.get("color", "#888888"),
                "unit": "ppb" if key == "OZNE" else "µg/m³",
                "history_tail": last5,
                "history_count": hist_len,
            }
    
    # Mobility info (if available)
    if mobility_info:
        view["mobility"] = mobility_info
    
    # Location
    if coords:
        lat, lon = coords
        view["location"] = {"lat": lat, "lon": lon}
    
    # Trail info (for mobile sensors)
    if trail and len(trail) > 0:
        view["trail_points"] = len(trail)
        view["last_trail_point"] = trail[-1]
    
    return view


def format_tui_state(state: dict[str, Any]) -> dict[str, Any]:
    """
    Transform raw API state into a format optimized for TUI rendering.
    
    This provides a single endpoint that both Python and browser TUIs
    can consume directly, reducing duplication.
    
    Returns:
        {
            "ts": timestamp,
            "last_update": formatted time string,
            "sensors": [...],  # Pre-formatted sensor list
            "pollutant_order": [...],
            "meta": {...}
        }
    """
    from datetime import datetime
    
    ts = state.get("ts", 0)
    meta = state.get("meta", {})
    
    # Format timestamp
    try:
        dt = datetime.fromtimestamp(ts)
        last_update = dt.strftime("%Y-%m-%d %H:%M:%S")
    except (ValueError, TypeError, OSError):
        last_update = "Unknown"
    
    return {
        "ts": ts,
        "last_update": last_update,
        "sensors": format_all_sensors(state),
        "pollutant_order": POLLUTANT_ORDER,
        "pollutant_labels": POLLUTANT_LABELS,
        "value_width": VALUE_WIDTH,
        "max_name_len": MAX_NAME_LEN,
        "meta": meta,
    }
