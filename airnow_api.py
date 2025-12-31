#!/usr/bin/env python3
"""
AirNow REST API client for Salt Lake City air quality data.

Uses the official AirNow API (https://docs.airnowapi.org/) which provides:
- Current observations by lat/lon, zip, or bounding box
- Historical observations
- Forecasts

Requires an API key from: https://docs.airnowapi.org/account/request/
Set via environment variable AIRNOW_API_KEY or pass directly to functions.
"""

import json
import os
import urllib.request
import urllib.parse
from datetime import datetime, date, timedelta
from typing import Optional

# API base URL
API_BASE = "https://www.airnowapi.org/aq"

# Salt Lake City coordinates
SLC_LAT = 40.7608
SLC_LON = -111.8910
SLC_ZIP = "84101"

# SLC bounding box (roughly Salt Lake Valley)
SLC_BBOX = {
    "minLat": 40.4,
    "maxLat": 41.0,
    "minLon": -112.2,
    "maxLon": -111.7,
}

# AQI color/category mapping
AQI_CATEGORIES = {
    1: {"name": "Good", "color": "#00E400", "rgb": (0, 228, 0)},
    2: {"name": "Moderate", "color": "#FFFF00", "rgb": (255, 255, 0)},
    3: {"name": "Unhealthy for Sensitive Groups", "color": "#FF7E00", "rgb": (255, 126, 0)},
    4: {"name": "Unhealthy", "color": "#FF0000", "rgb": (255, 0, 0)},
    5: {"name": "Very Unhealthy", "color": "#8F3F97", "rgb": (143, 63, 151)},
    6: {"name": "Hazardous", "color": "#7E0023", "rgb": (126, 0, 35)},
}


def get_api_key() -> str:
    """Get API key from environment variable."""
    key = os.environ.get("AIRNOW_API_KEY", "")
    if not key:
        raise ValueError(
            "AIRNOW_API_KEY environment variable not set. "
            "Get a free key at: https://docs.airnowapi.org/account/request/"
        )
    return key


def _api_request(endpoint: str, params: dict, api_key: Optional[str] = None) -> list:
    """
    Make a request to the AirNow API.
    
    Args:
        endpoint: API endpoint path (e.g., "observation/latLong/current")
        params: Query parameters
        api_key: Optional API key override
    
    Returns:
        Parsed JSON response (list of observations)
    """
    if api_key is None:
        api_key = get_api_key()
    
    params["API_KEY"] = api_key
    params["format"] = "application/json"
    
    query_string = urllib.parse.urlencode(params)
    url = f"{API_BASE}/{endpoint}/?{query_string}"
    
    print(f"API request: {API_BASE}/{endpoint}/")
    
    req = urllib.request.Request(url)
    req.add_header("User-Agent", "MobileAir/1.0")
    
    with urllib.request.urlopen(req, timeout=30) as response:
        content = response.read().decode("utf-8")
        return json.loads(content)


# ─────────────────────────────────────────────────────────────────────────────
# Current Observations
# ─────────────────────────────────────────────────────────────────────────────

def get_current_by_latlon(
    lat: float = SLC_LAT,
    lon: float = SLC_LON,
    distance: int = 25,
    api_key: Optional[str] = None
) -> list[dict]:
    """
    Get current AQ observations near a lat/lon point.
    
    Args:
        lat: Latitude
        lon: Longitude  
        distance: Search radius in miles (default 25)
        api_key: Optional API key override
    
    Returns:
        List of observation dicts with keys:
        - DateObserved, HourObserved, LocalTimeZone
        - ReportingArea, StateCode, Latitude, Longitude
        - ParameterName, AQI, Category (dict with Number, Name)
    """
    params = {
        "latitude": lat,
        "longitude": lon,
        "distance": distance,
    }
    return _api_request("observation/latLong/current", params, api_key)


def get_current_by_zip(
    zipcode: str = SLC_ZIP,
    distance: int = 25,
    api_key: Optional[str] = None
) -> list[dict]:
    """
    Get current AQ observations near a ZIP code.
    
    Args:
        zipcode: 5-digit ZIP code
        distance: Search radius in miles
        api_key: Optional API key override
    
    Returns:
        List of observation dicts
    """
    params = {
        "zipCode": zipcode,
        "distance": distance,
    }
    return _api_request("observation/zipCode/current", params, api_key)


def get_current_by_bbox(
    min_lat: float = SLC_BBOX["minLat"],
    max_lat: float = SLC_BBOX["maxLat"],
    min_lon: float = SLC_BBOX["minLon"],
    max_lon: float = SLC_BBOX["maxLon"],
    api_key: Optional[str] = None
) -> list[dict]:
    """
    Get current AQ observations within a bounding box.
    
    Args:
        min_lat, max_lat, min_lon, max_lon: Bounding box coordinates
        api_key: Optional API key override
    
    Returns:
        List of observation dicts for all monitors in the box
    """
    params = {
        "minLatitude": min_lat,
        "maxLatitude": max_lat,
        "minLongitude": min_lon,
        "maxLongitude": max_lon,
    }
    # Note: bbox endpoint doesn't exist in standard API, 
    # we'll iterate or use latLong with large distance instead
    # For now, use the latLong endpoint centered on SLC with large radius
    center_lat = (min_lat + max_lat) / 2
    center_lon = (min_lon + max_lon) / 2
    return get_current_by_latlon(center_lat, center_lon, distance=50, api_key=api_key)


# ─────────────────────────────────────────────────────────────────────────────
# Historical Observations
# ─────────────────────────────────────────────────────────────────────────────

def get_historical_by_latlon(
    lat: float = SLC_LAT,
    lon: float = SLC_LON,
    obs_date: Optional[date] = None,
    distance: int = 25,
    api_key: Optional[str] = None
) -> list[dict]:
    """
    Get historical AQ observations for a specific date.
    
    Args:
        lat: Latitude
        lon: Longitude
        obs_date: Date to fetch (defaults to yesterday)
        distance: Search radius in miles
        api_key: Optional API key override
    
    Returns:
        List of observation dicts
    """
    if obs_date is None:
        obs_date = date.today() - timedelta(days=1)
    
    params = {
        "latitude": lat,
        "longitude": lon,
        "distance": distance,
        "date": obs_date.strftime("%Y-%m-%dT00-0000"),
    }
    return _api_request("observation/latLong/historical", params, api_key)


def get_historical_by_zip(
    zipcode: str = SLC_ZIP,
    obs_date: Optional[date] = None,
    distance: int = 25,
    api_key: Optional[str] = None
) -> list[dict]:
    """
    Get historical AQ observations for a specific date by ZIP.
    
    Args:
        zipcode: 5-digit ZIP code
        obs_date: Date to fetch (defaults to yesterday)
        distance: Search radius in miles
        api_key: Optional API key override
    
    Returns:
        List of observation dicts
    """
    if obs_date is None:
        obs_date = date.today() - timedelta(days=1)
    
    params = {
        "zipCode": zipcode,
        "distance": distance,
        "date": obs_date.strftime("%Y-%m-%dT00-0000"),
    }
    return _api_request("observation/zipCode/historical", params, api_key)


def get_historical_range(
    lat: float = SLC_LAT,
    lon: float = SLC_LON,
    start_date: Optional[date] = None,
    end_date: Optional[date] = None,
    days: int = 7,
    distance: int = 25,
    api_key: Optional[str] = None
) -> list[dict]:
    """
    Get historical observations for a date range.
    
    Args:
        lat, lon: Location coordinates
        start_date: Start date (defaults to `days` ago)
        end_date: End date (defaults to yesterday)
        days: Number of days to fetch if start_date not specified
        distance: Search radius in miles
        api_key: Optional API key override
    
    Returns:
        Combined list of all observations in the range
    """
    if end_date is None:
        end_date = date.today() - timedelta(days=1)
    if start_date is None:
        start_date = end_date - timedelta(days=days - 1)
    
    all_obs = []
    current = start_date
    
    while current <= end_date:
        try:
            obs = get_historical_by_latlon(lat, lon, current, distance, api_key)
            all_obs.extend(obs)
        except Exception as e:
            print(f"  Error fetching {current}: {e}")
        current += timedelta(days=1)
    
    return all_obs


# ─────────────────────────────────────────────────────────────────────────────
# Forecasts
# ─────────────────────────────────────────────────────────────────────────────

def get_forecast_by_latlon(
    lat: float = SLC_LAT,
    lon: float = SLC_LON,
    forecast_date: Optional[date] = None,
    distance: int = 25,
    api_key: Optional[str] = None
) -> list[dict]:
    """
    Get AQ forecast for a location.
    
    Args:
        lat: Latitude
        lon: Longitude
        forecast_date: Date to get forecast for (defaults to today)
        distance: Search radius in miles
        api_key: Optional API key override
    
    Returns:
        List of forecast dicts with keys:
        - DateForecast, ReportingArea, StateCode
        - Latitude, Longitude, ParameterName
        - AQI, Category, ActionDay, Discussion
    """
    if forecast_date is None:
        forecast_date = date.today()
    
    params = {
        "latitude": lat,
        "longitude": lon,
        "distance": distance,
        "date": forecast_date.strftime("%Y-%m-%d"),
    }
    return _api_request("forecast/latLong", params, api_key)


def get_forecast_by_zip(
    zipcode: str = SLC_ZIP,
    forecast_date: Optional[date] = None,
    distance: int = 25,
    api_key: Optional[str] = None
) -> list[dict]:
    """
    Get AQ forecast by ZIP code.
    
    Args:
        zipcode: 5-digit ZIP code
        forecast_date: Date to get forecast for (defaults to today)
        distance: Search radius in miles
        api_key: Optional API key override
    
    Returns:
        List of forecast dicts
    """
    if forecast_date is None:
        forecast_date = date.today()
    
    params = {
        "zipCode": zipcode,
        "distance": distance,
        "date": forecast_date.strftime("%Y-%m-%d"),
    }
    return _api_request("forecast/zipCode", params, api_key)


# ─────────────────────────────────────────────────────────────────────────────
# Display Helpers
# ─────────────────────────────────────────────────────────────────────────────

def format_observation(obs: dict) -> str:
    """Format a single observation for display."""
    param = obs.get("ParameterName", "?")
    aqi = obs.get("AQI", "?")
    area = obs.get("ReportingArea", "Unknown")
    cat = obs.get("Category", {})
    cat_name = cat.get("Name", "?") if isinstance(cat, dict) else "?"
    
    date_str = obs.get("DateObserved", "")
    hour = obs.get("HourObserved", "")
    tz = obs.get("LocalTimeZone", "")
    
    return f"{area}: {param} AQI={aqi} ({cat_name}) [{date_str} {hour}:00 {tz}]"


def print_observations(observations: list[dict], title: str = "Observations"):
    """Pretty-print a list of observations."""
    print(f"\n{'='*70}")
    print(f"{title} ({len(observations)} records)")
    print('='*70)
    
    # Group by reporting area
    by_area = {}
    for obs in observations:
        area = obs.get("ReportingArea", "Unknown")
        if area not in by_area:
            by_area[area] = []
        by_area[area].append(obs)
    
    for area in sorted(by_area.keys()):
        area_obs = by_area[area]
        first = area_obs[0]
        lat = first.get("Latitude", "?")
        lon = first.get("Longitude", "?")
        state = first.get("StateCode", "?")
        
        print(f"\n{area}, {state} ({lat}, {lon})")
        for obs in area_obs:
            param = obs.get("ParameterName", "?")
            aqi = obs.get("AQI", -1)
            cat = obs.get("Category", {})
            cat_name = cat.get("Name", "?") if isinstance(cat, dict) else "?"
            
            # AQI indicator
            if aqi <= 50:
                indicator = "🟢"
            elif aqi <= 100:
                indicator = "🟡"
            elif aqi <= 150:
                indicator = "🟠"
            elif aqi <= 200:
                indicator = "🔴"
            elif aqi <= 300:
                indicator = "🟣"
            else:
                indicator = "🟤"
            
            print(f"  {indicator} {param:8} AQI: {aqi:3}  ({cat_name})")


def print_forecast(forecasts: list[dict], title: str = "Forecast"):
    """Pretty-print forecast data."""
    print(f"\n{'='*70}")
    print(f"{title} ({len(forecasts)} records)")
    print('='*70)
    
    for fc in forecasts:
        area = fc.get("ReportingArea", "Unknown")
        state = fc.get("StateCode", "?")
        forecast_date = fc.get("DateForecast", "?")
        param = fc.get("ParameterName", "?")
        aqi = fc.get("AQI", -1)
        cat = fc.get("Category", {})
        cat_name = cat.get("Name", "?") if isinstance(cat, dict) else "?"
        action_day = fc.get("ActionDay", False)
        discussion = fc.get("Discussion", "")
        
        action_marker = " ⚠️ ACTION DAY" if action_day else ""
        print(f"\n{area}, {state} - {forecast_date}{action_marker}")
        print(f"  {param}: AQI {aqi} ({cat_name})")
        if discussion:
            print(f"  📝 {discussion[:100]}...")


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main():
    """Demo the AirNow API for Salt Lake City."""
    print("AirNow API - Salt Lake City")
    print("=" * 50)
    print(f"Location: {SLC_LAT}, {SLC_LON} (ZIP: {SLC_ZIP})")
    
    try:
        api_key = get_api_key()
        print(f"API Key: {api_key[:8]}...{api_key[-4:]}")
    except ValueError as e:
        print(f"\n⚠️  {e}")
        print("\nTo use this tool:")
        print("  1. Get a free API key at: https://docs.airnowapi.org/account/request/")
        print("  2. Set the environment variable:")
        print("     export AIRNOW_API_KEY='your-api-key-here'")
        print("  3. Run this script again")
        return
    
    # Current observations
    print("\n" + "-" * 50)
    print("Fetching current observations...")
    try:
        current = get_current_by_latlon()
        print_observations(current, "Current AQ - Salt Lake City Area")
    except Exception as e:
        print(f"Error: {e}")
    
    # Forecast
    print("\n" + "-" * 50)
    print("Fetching forecast...")
    try:
        forecast = get_forecast_by_zip()
        print_forecast(forecast, "AQ Forecast - Salt Lake City")
    except Exception as e:
        print(f"Error: {e}")
    
    # Historical (yesterday)
    print("\n" + "-" * 50)
    yesterday = date.today() - timedelta(days=1)
    print(f"Fetching historical data ({yesterday})...")
    try:
        historical = get_historical_by_latlon(obs_date=yesterday)
        print_observations(historical, f"Historical AQ - {yesterday}")
    except Exception as e:
        print(f"Error: {e}")


if __name__ == "__main__":
    main()
