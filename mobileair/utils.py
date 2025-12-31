"""
Pure utility functions for MobileAir.

These are low-level helpers with no domain-specific knowledge.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any


def parse_utc_timestamp(timestamp: str | None) -> datetime | None:
    """Parse various UTC timestamp formats into a timezone-aware datetime."""
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
    """Calculate the great-circle distance between two points in meters."""
    r = 6371000.0  # Earth's radius in meters
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lon2 - lon1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return r * c


def bounding_box_distance(coords: list[tuple[float, float, datetime | None]]) -> float:
    """Calculate the diagonal distance of the bounding box containing the coordinates."""
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


def coerce_float(x: Any) -> float | None:
    """Safely convert a value to float, returning None on failure."""
    try:
        return float(x)
    except Exception:
        return None


def median(values: list[float]) -> float | None:
    """Calculate the median of a list of values."""
    if not values:
        return None
    xs = sorted(values)
    n = len(xs)
    mid = n // 2
    if n % 2 == 1:
        return float(xs[mid])
    return float((xs[mid - 1] + xs[mid]) / 2.0)
