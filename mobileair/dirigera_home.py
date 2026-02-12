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
from dotenv import load_dotenv
from dirigera import Hub

# Load .env from ~/.mobileair/
_env_path = Path.home() / ".mobileair" / ".env"
load_dotenv(_env_path)

# Home location
HOME_LAT = float(os.environ.get("HOME_SENSOR_LAT", "40.77153"))
HOME_LON = float(os.environ.get("HOME_SENSOR_LON", "-111.85868"))

_hub = Hub(token=os.environ['DIRIGERA_TOKEN'], ip_address="192.168.10.182")
_readings = deque(maxlen=2)


def get_pm25(second_latest=False):
    sensor = _hub.get_environment_sensors()[0]
    _readings.append(sensor.attributes.current_p_m25)
    if second_latest and len(_readings) == 2:
        return _readings[0]
    return _readings[-1]


def get_home_sensor_entry() -> dict[str, Any] | None:
    """Get the home sensor as a fixed sensor entry."""
    pm25 = get_pm25()
    
    from .aqi import value_to_aqi, color_for_value
    
    aqi = value_to_aqi("pm2.5", pm25)
    color = color_for_value("pm2.5", pm25)
    
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
                "color": color,
            }
        },
        "color": color,
        "primary_key": "PM25",
        "primary_value": display_val,
        "primary_color": color,
        "primary_aqi": aqi,
    }
