"""
Spatial outlier detection for sensors.

Detects sensors with readings inconsistent with nearby neighbors.
"""

from __future__ import annotations

import math
from typing import Any

from .utils import haversine_distance, coerce_float, median


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

    Args:
        sensors: List of sensor dicts with 'id', 'lat', 'lon', and 'readings' fields.
        pollutant_keys: Which pollutant keys to check.
        radius_m: Initial search radius for neighbors.
        max_radius_m: Maximum radius to expand to for sparse areas.
        max_neighbors: Maximum number of neighbors to consider.
        min_neighbors: Minimum neighbors required to make a determination.
        z_thresh: Robust Z-score threshold for flagging.
        ratio_thresh: Value/median ratio threshold for flagging.
        abs_thresh: Absolute difference threshold for flagging.

    Returns:
        Set of sensor IDs that are spatial outliers.
    """
    candidates: list[dict[str, Any]] = []
    for s in sensors:
        if not isinstance(s, dict):
            continue
        sid = s.get("id")
        if not isinstance(sid, str) or not sid:
            continue
        lat = coerce_float(s.get("lat"))
        lon = coerce_float(s.get("lon"))
        if lat is None or lon is None:
            continue

        readings = s.get("readings") if isinstance(s.get("readings"), dict) else {}
        val_f: float | None = None
        for k in pollutant_keys:
            v = readings.get(k)
            if isinstance(v, dict):
                val_f = coerce_float(v.get("value"))
            else:
                val_f = coerce_float(v)
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

        # Adaptive neighborhood: expand radius until we have enough neighbors.
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

        med = median(vals)
        if med is None:
            continue

        # Robust scale: MAD (median absolute deviation).
        abs_dev = [abs(v - med) for v in vals]
        mad = median(abs_dev) or 0.0
        sigma = 1.4826 * float(mad)
        sigma_eff = max(1.0, sigma)  # avoid divide-by-zero

        if val <= med:
            continue

        robust_z = (val - med) / sigma_eff
        ratio = val / max(1.0, float(med))

        # Require multiple signals to reduce false positives.
        if robust_z >= z_thresh and ratio >= ratio_thresh and (val - med) >= abs_thresh:
            outliers.add(sid)

    return outliers
