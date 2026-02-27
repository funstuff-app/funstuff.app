"""
Dirigera Hub integration for home air quality sensor.

Reads PM2.5 from an IKEA Vindstyrka sensor via the Dirigera Hub API.
"""

from __future__ import annotations

import os
from collections import deque
from pathlib import Path
from typing import Any

import requests  # noqa: F401 - force PyInstaller to bundle

# Home location (read at import time from env; dirigera itself is lazy)
HOME_LAT = float(os.environ.get("HOME_SENSOR_LAT", "40.77153"))
HOME_LON = float(os.environ.get("HOME_SENSOR_LON", "-111.85868"))

_hub: Any = None
_readings: deque = deque(maxlen=2)


def _get_hub() -> Any | None:
    """Lazily initialise Hub; returns None if dirigera is unavailable or unconfigured."""
    global _hub
    if _hub is not None:
        return _hub
    try:
        from pathlib import Path as _Path
        from dotenv import load_dotenv
        load_dotenv(_Path.home() / ".mobileair" / ".env")
        token = os.environ.get("DIRIGERA_TOKEN")
        if not token:
            return None
        from dirigera import Hub
        _hub = Hub(token=token, ip_address=os.environ.get("DIRIGERA_IP", "192.168.10.182"))
        return _hub
    except Exception:
        return None


def get_pm25(second_latest: bool = False) -> float | None:
    hub = _get_hub()
    if hub is None:
        return None
    try:
        sensor = hub.get_environment_sensors()[0]
        _readings.append(sensor.attributes.current_p_m25)
        if second_latest and len(_readings) == 2:
            return _readings[0]
        return _readings[-1]
    except Exception:
        return None


def get_home_sensor_entry() -> dict[str, Any] | None:
    """Get the home sensor as a fixed sensor entry. Returns None when dirigera is unavailable."""
    pm25 = get_pm25()
    if pm25 is None:
        return None
    
    from .aqi import value_to_aqi, color_for_value, color_to_idx
    
    aqi = value_to_aqi("pm2.5", pm25)
    ci = color_to_idx(color_for_value("pm2.5", pm25))
    
    # Format value: integers without decimals, floats with decimals
    display_val = int(pm25) if pm25 == int(pm25) else pm25
    
    return {
        "id": "Home",
        "name": "Home (Indoor)",
        "pinned": True,
        "emoji": "🏰",
        "lat": HOME_LAT,
        "lon": HOME_LON,
        "readings": {
            "PM25": {
                "value": display_val,
                "ci": ci,
            }
        },
        "ci": ci,
        "primary_key": "PM25",
        "primary_value": display_val,
        "pci": ci,
        "primary_aqi": aqi,
    }
