#!/usr/bin/env python3
"""
AirNow data fetcher for Salt Lake City (Utah) air quality monitoring.

Supports two data sources:
1. File-based: Direct file downloads from files.airnowtech.org (no API key needed)
   - Site metadata: monitoring_site_locations.dat
   - Hourly readings: HourlyData_YYYYMMDDHH.dat
   
2. REST API: Official AirNow API at airnowapi.org (requires free API key)
   - Current observations with AQI
   - Forecasts
   - Historical data

Get a free API key at: https://docs.airnowapi.org/account/request/
Set via: export AIRNOW_API_KEY='your-key'
"""

import json
import os
import urllib.error
import urllib.request
import urllib.parse
from datetime import datetime, date, timedelta
from typing import Optional

# ─────────────────────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────────────────────

# File-based data source
FILES_BASE_URL = "https://files.airnowtech.org/airnow"

# REST API
API_BASE_URL = "https://www.airnowapi.org/aq"

# Utah state code (FIPS)
UTAH_STATE_CODE = "49"
UTAH_STATE_ABBREV = "UT"

# Salt Lake County FIPS code
SALT_LAKE_COUNTY_CODE = "49035"

# SLC coordinates
SLC_LAT = 40.7608
SLC_LON = -111.8910
SLC_ZIP = "84101"

# SLC metro bounding box
SLC_BOUNDS = {
    "lat_min": 40.4,
    "lat_max": 41.0,
    "lon_min": -112.2,
    "lon_max": -111.7,
}

# AQI color/category mapping
AQI_CATEGORIES = {
    1: {"name": "Good", "color": "#00E400", "range": (0, 50)},
    2: {"name": "Moderate", "color": "#FFFF00", "range": (51, 100)},
    3: {"name": "Unhealthy for Sensitive Groups", "color": "#FF7E00", "range": (101, 150)},
    4: {"name": "Unhealthy", "color": "#FF0000", "range": (151, 200)},
    5: {"name": "Very Unhealthy", "color": "#8F3F97", "range": (201, 300)},
    6: {"name": "Hazardous", "color": "#7E0023", "range": (301, 500)},
}


def get_api_key() -> Optional[str]:
    """Get API key from environment variable, or None if not set."""
    return os.environ.get("AIRNOW_API_KEY")


def has_api_key() -> bool:
    """Check if an API key is available."""
    return bool(get_api_key())


# ═══════════════════════════════════════════════════════════════════════════════
# FILE-BASED DATA SOURCE (no API key required)
# ═══════════════════════════════════════════════════════════════════════════════

def get_today_url() -> str:
    """Get URL for today's monitoring site locations file."""
    return f"{FILES_BASE_URL}/today/monitoring_site_locations.dat"


def get_historical_url(date: Optional[datetime] = None) -> str:
    """
    Get URL for a specific date's monitoring site locations file.
    
    Args:
        date: Date to fetch (defaults to today)
    
    Returns:
        URL string for the historical data file
    """
    if date is None:
        date = datetime.now()
    
    year = date.strftime("%Y")
    date_str = date.strftime("%Y%m%d")
    return f"{FILES_BASE_URL}/{year}/{date_str}/monitoring_site_locations.dat"


# ─────────────────────────────────────────────────────────────────────────────
# Hourly Data URLs (File-based)
# ─────────────────────────────────────────────────────────────────────────────

def get_hourly_data_url(dt: Optional[datetime] = None) -> str:
    """
    Get URL for hourly data file at a specific datetime.
    
    Args:
        dt: Datetime to fetch (defaults to ~2 hours ago for data availability)
    
    Returns:
        URL for HourlyData_YYYYMMDDHH.dat
    """
    if dt is None:
        # Data is typically delayed ~1-2 hours
        dt = datetime.now(tz=None) - timedelta(hours=2)
    
    timestamp = dt.strftime("%Y%m%d%H")
    return f"{FILES_BASE_URL}/today/HourlyData_{timestamp}.dat"


def get_hourly_data_url_historical(dt: datetime) -> str:
    """
    Get URL for historical hourly data file.
    
    Args:
        dt: Datetime to fetch
    
    Returns:
        URL for archived HourlyData file
    """
    year = dt.strftime("%Y")
    date_str = dt.strftime("%Y%m%d")
    timestamp = dt.strftime("%Y%m%d%H")
    return f"{FILES_BASE_URL}/{year}/{date_str}/HourlyData_{timestamp}.dat"


def list_available_hourly_files() -> list[str]:
    """
    List available hourly data files in today's directory.
    
    Returns:
        List of HourlyData filenames available
    """
    import xml.etree.ElementTree as ET
    
    s3_url = "https://s3-us-west-1.amazonaws.com/files.airnowtech.org/?prefix=airnow/today/&max-keys=500"
    
    try:
        with urllib.request.urlopen(s3_url, timeout=30) as response:
            content = response.read().decode("utf-8")
        
        # Parse S3 XML listing
        root = ET.fromstring(content)
        ns = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}
        
        files = []
        for key in root.findall(".//s3:Key", ns):
            if key.text and "HourlyData_" in key.text:
                files.append(key.text.split("/")[-1])
        
        return sorted(files)
    except Exception as e:
        print(f"Error listing files: {e}")
        return []


def parse_record(line: str) -> dict:
    """
    Parse a pipe-delimited record from the monitoring site file.
    
    Returns dict with fields:
        aqsid, parameter, site_code, site_name, status, agency_id, agency_name,
        epa_region, latitude, longitude, elevation, gmt_offset, country_code,
        msa_code, msa_name, state_code, state_name, county_code, county_name
    """
    fields = line.strip().split("|")
    if len(fields) < 19:
        return {}
    
    return {
        "aqsid": fields[0],
        "parameter": fields[1],
        "site_code": fields[2],
        "site_name": fields[3],
        "status": fields[4],
        "agency_id": fields[5],
        "agency_name": fields[6],
        "epa_region": fields[7],
        "latitude": float(fields[8]) if fields[8] else None,
        "longitude": float(fields[9]) if fields[9] else None,
        "elevation": float(fields[10]) if fields[10] else None,
        "gmt_offset": float(fields[11]) if fields[11] else None,
        "country_code": fields[12],
        "msa_code": fields[13],
        "msa_name": fields[14],
        "state_code": fields[15],
        "state_name": fields[16],
        "county_code": fields[17],
        "county_name": fields[18],
    }


def parse_hourly_record(line: str) -> dict:
    """
    Parse a pipe-delimited hourly data record.
    
    Format: Date|Time|SiteID|SiteName|GMTOffset|Parameter|Unit|Value|Agency
    Example: 12/31/25|03:00|490353006|Hawthorne|-7|PM2.5|UG/M3|15.2|Utah DAQ
    
    Returns dict with fields:
        date, time, datetime, site_id, site_name, gmt_offset, 
        parameter, unit, value, agency
    """
    from datetime import timezone, timedelta as td
    
    fields = line.strip().split("|")
    if len(fields) < 9:
        return {}
    
    try:
        # Parse date (MM/DD/YY format)
        date_str = fields[0]
        time_str = fields[1]
        
        # Handle 2-digit year - parse as naive first
        dt = datetime.strptime(f"{date_str} {time_str}", "%m/%d/%y %H:%M")
        
        # Convert to UTC using the GMT offset field (e.g., -7 for Utah local)
        gmt_offset = float(fields[4]) if fields[4] else 0
        local_tz = timezone(td(hours=gmt_offset))
        dt = dt.replace(tzinfo=local_tz).astimezone(timezone.utc)
        
        value = None
        try:
            value = float(fields[7])
        except (ValueError, IndexError):
            pass
        
        return {
            "date": date_str,
            "time": time_str,
            "datetime": dt,
            "site_id": fields[2],
            "site_name": fields[3].strip(),
            "gmt_offset": float(fields[4]) if fields[4] else None,
            "parameter": fields[5],
            "unit": fields[6],
            "value": value,
            "agency": fields[8] if len(fields) > 8 else "",
        }
    except Exception:
        return {}


def fetch_monitoring_sites(url: Optional[str] = None) -> list[dict]:
    """
    Fetch and parse all monitoring sites from AirNow.
    
    Args:
        url: Optional URL override (defaults to today's file)
    
    Returns:
        List of parsed site records
    """
    if url is None:
        url = get_today_url()
    
    print(f"Fetching: {url}")
    
    with urllib.request.urlopen(url, timeout=30) as response:
        content = response.read().decode("utf-8", errors="replace")
    
    sites = []
    for line in content.splitlines():
        if line.strip():
            record = parse_record(line)
            if record:
                sites.append(record)
    
    return sites


def fetch_hourly_data(url: Optional[str] = None) -> list[dict]:
    """
    Fetch and parse hourly AQ readings from AirNow.
    
    Args:
        url: Optional URL override (defaults to latest available)
    
    Returns:
        List of parsed hourly reading records
    """
    if url is None:
        url = get_hourly_data_url()
    
    print(f"Fetching hourly data: {url}")
    
    try:
        with urllib.request.urlopen(url, timeout=30) as response:
            content = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            print(f"  File not found (data may not be available yet)")
            return []
        raise
    
    readings = []
    for line in content.splitlines():
        if line.strip():
            record = parse_hourly_record(line)
            if record:
                readings.append(record)
    
    return readings


def fetch_hourly_data_range(
    start_dt: datetime,
    end_dt: Optional[datetime] = None,
    hours: int = 24
) -> list[dict]:
    """
    Fetch hourly data for a range of hours.
    
    Args:
        start_dt: Starting datetime (UTC)
        end_dt: Ending datetime (UTC), or None to use hours param
        hours: Number of hours to fetch if end_dt not specified
    
    Returns:
        Combined list of all hourly readings
    """
    if end_dt is None:
        end_dt = start_dt + timedelta(hours=hours)
    
    all_readings = []
    current = start_dt
    
    while current <= end_dt:
        url = get_hourly_data_url(current)
        try:
            readings = fetch_hourly_data(url)
            all_readings.extend(readings)
        except Exception as e:
            print(f"  Error fetching {current}: {e}")
        current += timedelta(hours=1)
    
    return all_readings


def filter_utah_sites(sites: list[dict]) -> list[dict]:
    """Filter sites to only Utah locations."""
    return [s for s in sites if s.get("state_name") == UTAH_STATE_ABBREV]


def filter_salt_lake_sites(sites: list[dict]) -> list[dict]:
    """Filter sites to only Salt Lake County locations."""
    return [s for s in sites if s.get("county_code") == SALT_LAKE_COUNTY_CODE]


def filter_slc_area(sites: list[dict]) -> list[dict]:
    """
    Filter sites to Salt Lake City metro area.
    Includes Salt Lake County and nearby areas based on lat/lon bounding box.
    
    SLC approximate bounds:
        Lat: 40.4 - 41.0
        Lon: -112.2 - -111.7
    """
    slc_sites = []
    for s in sites:
        lat = s.get("latitude")
        lon = s.get("longitude")
        if lat and lon:
            if (SLC_BOUNDS["lat_min"] <= lat <= SLC_BOUNDS["lat_max"] and 
                SLC_BOUNDS["lon_min"] <= lon <= SLC_BOUNDS["lon_max"]):
                slc_sites.append(s)
    return slc_sites


def filter_utah_hourly(readings: list[dict]) -> list[dict]:
    """
    Filter hourly readings to Utah sites.
    Utah site IDs start with '490' (49 = FIPS state code, 0 = padding).
    """
    return [r for r in readings if r.get("site_id", "").startswith("490")]


def filter_slc_hourly(readings: list[dict], site_ids: Optional[set[str]] = None) -> list[dict]:
    """
    Filter hourly readings to SLC-area sites.
    
    Args:
        readings: List of hourly reading records
        site_ids: Optional set of known SLC site IDs. If None, filters by 
                  Utah sites only (starts with '49').
    
    Returns:
        Filtered list of readings
    """
    if site_ids:
        return [r for r in readings if r.get("site_id") in site_ids]
    return filter_utah_hourly(readings)


def print_sites(sites: list[dict], title: str = "Monitoring Sites"):
    """Pretty-print a list of sites."""
    print(f"\n{'='*60}")
    print(f"{title} ({len(sites)} sites)")
    print('='*60)
    
    for s in sites:
        status_marker = "✓" if s.get("status") == "Active" else "✗"
        print(f"{status_marker} {s.get('site_name', 'Unknown'):25} | "
              f"{s.get('parameter', '?'):8} | "
              f"({s.get('latitude', 0):.4f}, {s.get('longitude', 0):.4f}) | "
              f"{s.get('county_name', '')}")


def print_hourly_readings(readings: list[dict], title: str = "Hourly Readings"):
    """Pretty-print hourly readings grouped by site and parameter."""
    print(f"\n{'='*70}")
    print(f"{title} ({len(readings)} readings)")
    print('='*70)
    
    # Group by site
    by_site = {}
    for r in readings:
        site = r.get("site_name", "Unknown")
        if site not in by_site:
            by_site[site] = {}
        param = r.get("parameter", "?")
        by_site[site][param] = r
    
    for site_name in sorted(by_site.keys()):
        params = by_site[site_name]
        readings_str = ", ".join(
            f"{p}: {params[p].get('value', '?')} {params[p].get('unit', '')}"
            for p in sorted(params.keys())
            if params[p].get("value") is not None
        )
        if readings_str:
            # Get time from first reading
            first = list(params.values())[0]
            time_str = first.get("time", "??:??")
            print(f"{site_name:30} [{time_str}] {readings_str}")


def get_slc_site_ids(sites: list[dict]) -> set[str]:
    """
    Get set of AQS IDs for SLC-area sites.
    
    Args:
        sites: List of site metadata records
    
    Returns:
        Set of site IDs in SLC area
    """
    slc_sites = filter_slc_area(sites)
    return {aqsid for s in slc_sites if (aqsid := s.get("aqsid")) is not None}


def main():
    """Fetch and display SLC-area air quality data from both sources."""
    print("AirNow Data - Salt Lake City Area")
    print("=" * 60)
    
    # Check for API key
    if has_api_key():
        print(f"✓ REST API key configured")
    else:
        print("○ REST API key not set (file-based data only)")
        print("  Set AIRNOW_API_KEY for forecasts & AQI values")
    
    # ─────────────────────────────────────────────────────────────────────
    # REST API: Current observations with AQI (if API key available)
    # ─────────────────────────────────────────────────────────────────────
    if has_api_key():
        print("\n" + "─" * 60)
        print("REST API - Current Observations")
        print("─" * 60)
        
        try:
            current = api_get_current()
            print_api_observations(current, "Current AQ - Salt Lake City")
        except Exception as e:
            print(f"Error: {e}")
        
        # Forecast
        print("\n" + "─" * 60)
        print("REST API - Forecast")
        print("─" * 60)
        
        try:
            forecast = api_get_forecast_by_zip()
            print_api_forecast(forecast, "AQ Forecast - Salt Lake City")
        except Exception as e:
            print(f"Error: {e}")
    
    # ─────────────────────────────────────────────────────────────────────
    # File-based: Detailed hourly readings (no API key needed)
    # ─────────────────────────────────────────────────────────────────────
    print("\n" + "─" * 60)
    print("File-based Data - Detailed Hourly Readings")
    print("─" * 60)
    
    # Fetch site metadata
    try:
        all_sites = fetch_monitoring_sites()
        print(f"\nTotal sites in database: {len(all_sites)}")
        
        # Get SLC-area sites
        slc_sites = filter_slc_area(all_sites)
        slc_site_ids = get_slc_site_ids(all_sites)
        
        # Show unique SLC sites (dedupe by site name)
        unique_sites = {}
        for s in slc_sites:
            name = s.get("site_name")
            if name and name not in unique_sites:
                unique_sites[name] = s
        
        print(f"\n{'='*60}")
        print(f"SLC Metro Monitoring Sites ({len(unique_sites)} unique locations)")
        print('='*60)
        for name in sorted(unique_sites.keys()):
            s = unique_sites[name]
            print(f"  • {name:25} ({s.get('latitude', 0):.4f}, {s.get('longitude', 0):.4f})")
        
    except Exception as e:
        print(f"\nError fetching site data: {e}")
        slc_site_ids = set()
    
    # Fetch hourly data - try archived data from earlier today
    print("\n" + "-" * 50)
    print("Fetching latest hourly readings...")
    
    try:
        # Try to find data from today's archive (more complete than /today/)
        now = datetime.now()
        archive_url = f"{FILES_BASE_URL}/{now.year}/{now.strftime('%Y%m%d')}/HourlyData_{now.strftime('%Y%m%d')}20.dat"
        
        # List available files in today folder first
        available = list_available_hourly_files()
        if available:
            print(f"Files in /today/: {len(available)} ({available[-1]})")
        
        # Try archived file from 20:00 UTC (afternoon in Utah)
        print(f"\nTrying archived data: {archive_url}")
        readings = fetch_hourly_data(archive_url)
        
        if not readings and available:
            # Fall back to today's folder
            latest_file = available[-1]
            url = f"{FILES_BASE_URL}/today/{latest_file}"
            readings = fetch_hourly_data(url)
        
        # Filter to Utah
        utah_readings = filter_utah_hourly(readings)
        print(f"\nTotal readings: {len(readings)}, Utah readings: {len(utah_readings)}")
        
        if utah_readings:
            print_hourly_readings(utah_readings, "Utah Hourly AQ Readings")
            
            # Summary of key pollutants
            key_params = ["PM2.5", "OZONE", "PM10", "NO2", "CO", "SO2"]
            params = {}
            for r in utah_readings:
                p = r.get("parameter", "?")
                if p not in params:
                    params[p] = []
                if r.get("value") is not None:
                    params[p].append(r["value"])
            
            print(f"\n{'='*60}")
            print("Key Pollutant Summary (Utah)")
            print('='*60)
            for param in key_params:
                if param in params and params[param]:
                    values = params[param]
                    avg = sum(values) / len(values)
                    print(f"  {param:10}: {len(values):3} readings, "
                          f"avg={avg:.1f}, min={min(values):.1f}, max={max(values):.1f}")
        else:
            print("\nNo Utah readings in this file. Data may be delayed or unavailable.")
            
    except Exception as e:
        print(f"\nError fetching hourly data: {e}")
        import traceback
        traceback.print_exc()


# ═══════════════════════════════════════════════════════════════════════════════
# REST API DATA SOURCE (requires free API key)
# ═══════════════════════════════════════════════════════════════════════════════

def _api_request(endpoint: str, params: dict, api_key: Optional[str] = None) -> list:
    """
    Make a request to the AirNow REST API.
    
    Args:
        endpoint: API endpoint path (e.g., "observation/latLong/current")
        params: Query parameters
        api_key: Optional API key override
    
    Returns:
        Parsed JSON response (list of observations)
    """
    if api_key is None:
        api_key = get_api_key()
    
    if not api_key:
        raise ValueError(
            "AIRNOW_API_KEY not set. Get a free key at: "
            "https://docs.airnowapi.org/account/request/"
        )
    
    params["API_KEY"] = api_key
    params["format"] = "application/json"
    
    query_string = urllib.parse.urlencode(params)
    url = f"{API_BASE_URL}/{endpoint}/?{query_string}"
    
    req = urllib.request.Request(url)
    req.add_header("User-Agent", "MobileAir/1.0")
    
    with urllib.request.urlopen(req, timeout=30) as response:
        content = response.read().decode("utf-8")
        return json.loads(content)


# ─────────────────────────────────────────────────────────────────────────────
# Current Observations (REST API)
# ─────────────────────────────────────────────────────────────────────────────

def api_get_current(
    lat: float = SLC_LAT,
    lon: float = SLC_LON,
    distance: int = 25,
    api_key: Optional[str] = None
) -> list[dict]:
    """
    Get current AQ observations near a lat/lon point via REST API.
    
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


def api_get_current_by_zip(
    zipcode: str = SLC_ZIP,
    distance: int = 25,
    api_key: Optional[str] = None
) -> list[dict]:
    """
    Get current AQ observations near a ZIP code via REST API.
    
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


# ─────────────────────────────────────────────────────────────────────────────
# Historical Observations (REST API)
# ─────────────────────────────────────────────────────────────────────────────

def api_get_historical(
    lat: float = SLC_LAT,
    lon: float = SLC_LON,
    obs_date: Optional[date] = None,
    distance: int = 25,
    api_key: Optional[str] = None
) -> list[dict]:
    """
    Get historical AQ observations for a specific date via REST API.
    
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


def api_get_historical_range(
    lat: float = SLC_LAT,
    lon: float = SLC_LON,
    start_date: Optional[date] = None,
    end_date: Optional[date] = None,
    days: int = 7,
    distance: int = 25,
    api_key: Optional[str] = None
) -> list[dict]:
    """
    Get historical observations for a date range via REST API.
    
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
            obs = api_get_historical(lat, lon, current, distance, api_key)
            all_obs.extend(obs)
        except Exception as e:
            print(f"  Error fetching {current}: {e}")
        current += timedelta(days=1)
    
    return all_obs


# ─────────────────────────────────────────────────────────────────────────────
# Forecasts (REST API)
# ─────────────────────────────────────────────────────────────────────────────

def api_get_forecast(
    lat: float = SLC_LAT,
    lon: float = SLC_LON,
    forecast_date: Optional[date] = None,
    distance: int = 25,
    api_key: Optional[str] = None
) -> list[dict]:
    """
    Get AQ forecast for a location via REST API.
    
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


def api_get_forecast_by_zip(
    zipcode: str = SLC_ZIP,
    forecast_date: Optional[date] = None,
    distance: int = 25,
    api_key: Optional[str] = None
) -> list[dict]:
    """
    Get AQ forecast by ZIP code via REST API.
    
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
# REST API Display Helpers
# ─────────────────────────────────────────────────────────────────────────────

def aqi_indicator(aqi: int) -> str:
    """Get emoji indicator for AQI value."""
    if aqi <= 50:
        return "🟢"
    elif aqi <= 100:
        return "🟡"
    elif aqi <= 150:
        return "🟠"
    elif aqi <= 200:
        return "🔴"
    elif aqi <= 300:
        return "🟣"
    else:
        return "🟤"


def print_api_observations(observations: list[dict], title: str = "Observations"):
    """Pretty-print REST API observations."""
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
            print(f"  {aqi_indicator(aqi)} {param:8} AQI: {aqi:3}  ({cat_name})")


def print_api_forecast(forecasts: list[dict], title: str = "Forecast"):
    """Pretty-print REST API forecast data."""
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
        
        action_marker = " ⚠️  ACTION DAY" if action_day else ""
        print(f"\n{area}, {state} - {forecast_date}{action_marker}")
        print(f"  {param}: AQI {aqi} ({cat_name})")
        if discussion:
            # Truncate long discussions
            print(f"  📝 {discussion[:100]}{'...' if len(discussion) > 100 else ''}")


def extract_wind_data(readings: list[dict], sites: Optional[dict[str, dict]] = None) -> dict:
    """
    Extract wind data (speed, direction) from hourly readings.
    
    Aggregates wind data from all available stations, computing an average
    weighted by data freshness if multiple readings exist.
    
    Args:
        readings: List of hourly readings (from fetch_hourly_data)
        sites: Optional dict of site metadata keyed by site_id (for location info)
    
    Returns:
        Dict with keys:
            - wind_speed: Average wind speed in m/s (or None)
            - wind_speed_mph: Average wind speed in mph (or None)
            - wind_dir: Predominant wind direction in degrees (or None)
            - wind_dir_cardinal: Cardinal direction string (N, NE, etc.)
            - temp_c: Average temperature in Celsius (or None)
            - temp_f: Average temperature in Fahrenheit (or None)
            - humidity: Average relative humidity % (or None)
            - gust_level: 0-4 scale (calm, light, moderate, strong, gale)
            - stations: Number of stations reporting wind data
            - readings_time: ISO timestamp of most recent reading
    """
    import math
    
    wind_speeds: list[float] = []
    wind_dirs: list[float] = []
    temps: list[float] = []
    humidities: list[float] = []
    latest_time: Optional[datetime] = None
    
    for r in readings:
        param = r.get("parameter", "")
        val = r.get("value")
        dt = r.get("datetime")
        
        if val is None:
            continue
        
        if param == "WS":
            wind_speeds.append(val)
        elif param == "WD":
            wind_dirs.append(val)
        elif param == "TEMP":
            temps.append(val)
        elif param == "RHUM":
            humidities.append(val)
        
        if dt and (latest_time is None or dt > latest_time):
            latest_time = dt
    
    result: dict = {
        "wind_speed": None,
        "wind_speed_mph": None,
        "wind_dir": None,
        "wind_dir_cardinal": None,
        "temp_c": None,
        "temp_f": None,
        "humidity": None,
        "gust_level": 0,
        "stations": len(set(r.get("site_id") for r in readings if r.get("parameter") in ("WS", "WD"))),
        "readings_time": latest_time.isoformat() if latest_time else None,
    }
    
    # Calculate averages
    if wind_speeds:
        avg_speed = sum(wind_speeds) / len(wind_speeds)
        max_speed = max(wind_speeds)
        result["wind_speed"] = round(avg_speed, 1)
        result["wind_speed_mph"] = round(avg_speed * 2.237, 1)  # m/s to mph
        result["max_wind_speed"] = round(max_speed, 1)
        result["max_wind_speed_mph"] = round(max_speed * 2.237, 1)
        
        # Gust level based on max speed (Beaufort-inspired)
        # 0: Calm (<0.5 m/s, <1 mph)
        # 1: Light (0.5-3 m/s, 1-7 mph)  
        # 2: Moderate (3-8 m/s, 7-18 mph)
        # 3: Strong (8-14 m/s, 18-31 mph)
        # 4: Gale (>14 m/s, >31 mph)
        if max_speed < 0.5:
            result["gust_level"] = 0
        elif max_speed < 3:
            result["gust_level"] = 1
        elif max_speed < 8:
            result["gust_level"] = 2
        elif max_speed < 14:
            result["gust_level"] = 3
        else:
            result["gust_level"] = 4
    
    if wind_dirs:
        # Circular mean for wind direction
        sin_sum = sum(math.sin(math.radians(d)) for d in wind_dirs)
        cos_sum = sum(math.cos(math.radians(d)) for d in wind_dirs)
        avg_dir = math.degrees(math.atan2(sin_sum, cos_sum))
        if avg_dir < 0:
            avg_dir += 360
        result["wind_dir"] = round(avg_dir)
        
        # Cardinal direction
        cardinals = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                     "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
        idx = round(avg_dir / 22.5) % 16
        result["wind_dir_cardinal"] = cardinals[idx]
    
    if temps:
        avg_temp = sum(temps) / len(temps)
        result["temp_c"] = round(avg_temp, 1)
        result["temp_f"] = round(avg_temp * 9/5 + 32, 1)
    
    if humidities:
        result["humidity"] = round(sum(humidities) / len(humidities), 1)
    
    return result


def format_wind_ascii(wind_data: dict) -> str:
    """
    Create an ASCII art wind indicator.
    
    Returns a multi-line string with:
    - Wind direction arrow
    - Speed reading
    - Gust meter bar
    
    Example output:
        ╭─ WIND ──────╮
        │    ↗ NE     │
        │  5.2 mph    │
        │ ▂▃▅▇  Mod   │
        ╰─────────────╯
    """
    if wind_data.get("wind_speed") is None:
        return "╭─ WIND ─╮\n│  N/A   │\n╰────────╯"
    
    speed_mph = wind_data.get("wind_speed_mph", 0) or 0
    direction = wind_data.get("wind_dir", 0) or 0
    cardinal = wind_data.get("wind_dir_cardinal", "?")
    gust_level = wind_data.get("gust_level", 0)
    
    # Direction arrows (pointing where wind is going TO, i.e., opposite of "from")
    # Wind direction is where wind comes FROM, so arrow points opposite
    arrows = ["↓", "↙", "←", "↖", "↑", "↗", "→", "↘"]
    arrow_idx = round(direction / 45) % 8
    arrow = arrows[arrow_idx]
    
    # Gust meter using block characters
    gust_chars = ["▁", "▂", "▃", "▅", "▇"]
    gust_bar = "".join(gust_chars[:gust_level + 1])
    gust_labels = ["Calm", "Light", "Mod", "Strong", "Gale!"]
    gust_label = gust_labels[min(gust_level, 4)]
    
    # Format speed
    speed_str = f"{speed_mph:.0f}" if speed_mph >= 10 else f"{speed_mph:.1f}"
    
    # Build the box
    lines = [
        f"╭─ WIND ──────╮",
        f"│   {arrow} {cardinal:3}      │",
        f"│  {speed_str:>4} mph   │",
        f"│ {gust_bar:<5} {gust_label:<5} │",
        f"╰─────────────╯",
    ]
    
    return "\n".join(lines)


if __name__ == "__main__":
    main()
