"""
Mobility detection for sensors.

Determines whether a sensor is stationary (parked/idle) or moving.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Any

from .config import (
    IMMOBILITY_LOOKBACK_MINUTES,
    IMMOBILITY_MIN_COVERAGE_MINUTES,
    IMMOBILITY_MIN_SAMPLES,
    IMMOBILITY_TOTAL_DISTANCE_THRESHOLD,
    IMMOBILITY_MAX_STEP_THRESHOLD,
    IMMOBILITY_BBOX_THRESHOLD,
    IMMOBILITY_RADIUS_THRESHOLD,
    IMMOBILITY_NET_DISTANCE_THRESHOLD,
    SPARSE_PROVE_MOVING_MAX_STEP_M,
    SPARSE_PROVE_MOVING_NET_M,
    SPARSE_ASSUME_IDLE_ROBUST_RADIUS_M,
)
from .utils import parse_utc_timestamp, haversine_distance, bounding_box_distance, median


def evaluate_mobility(
    sensor_blob: dict[str, Any],
    *,
    lookback_minutes: int = IMMOBILITY_LOOKBACK_MINUTES,
    min_coverage_minutes: int = IMMOBILITY_MIN_COVERAGE_MINUTES,
    min_samples: int = IMMOBILITY_MIN_SAMPLES,
    total_distance_threshold: float = IMMOBILITY_TOTAL_DISTANCE_THRESHOLD,
    max_step_threshold: float = IMMOBILITY_MAX_STEP_THRESHOLD,
    bbox_threshold: float = IMMOBILITY_BBOX_THRESHOLD,
    radius_threshold: float = IMMOBILITY_RADIUS_THRESHOLD,
    net_distance_threshold: float = IMMOBILITY_NET_DISTANCE_THRESHOLD,
    sparse_prove_moving_max_step_m: float = SPARSE_PROVE_MOVING_MAX_STEP_M,
    sparse_prove_moving_net_m: float = SPARSE_PROVE_MOVING_NET_M,
    sparse_not_idle_robust_radius_m: float = SPARSE_ASSUME_IDLE_ROBUST_RADIUS_M,
    assume_immobile_when_sparse: bool = True,
    assume_immobile_when_low_coverage: bool = True,
    allow_short_window_immobile: bool = True,
) -> dict[str, Any]:
    """Evaluate mobility status of a sensor based on its location history.
    
    Args:
        sensor_blob: Dict containing Latitude, Longitude, and TimeUTC lists.
        lookback_minutes: How far back to look in the history.
        min_coverage_minutes: Minimum time span required to make a determination.
        min_samples: Minimum number of samples required.
        *_threshold: Various distance thresholds for immobility detection.
        assume_immobile_when_sparse: Whether to assume idle when data is sparse.
        assume_immobile_when_low_coverage: Whether to assume idle when time coverage is low.
        allow_short_window_immobile: Whether to allow quick immobility detection.
    
    Returns:
        Dict with 'immobile' bool and various diagnostic fields.
    """
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
        med_lat = median([lat for lat, _, _ in coords0])
        med_lon = median([lon for _, lon, _ in coords0])
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

        # Also check speed: if recent movement speed exceeds walking pace, it's definitely moving.
        # This catches newly appearing sensors that are clearly in motion.
        speed_mps = 0.0
        if len(coords) >= 2 and steps:
            last_step = steps[-1] if steps else 0.0
            # Estimate time between last two points
            dt0 = coords[-2][2]
            dt1 = coords[-1][2]
            if dt0 is not None and dt1 is not None:
                dt_seconds = (dt1 - dt0).total_seconds()
                if dt_seconds > 0:
                    speed_mps = last_step / dt_seconds
        
        # ~2 m/s = ~4.5 mph = brisk walking. Anything faster is definitely moving.
        speed_threshold_mps = 2.0

        # Prove moving if there is meaningful displacement.
        # Check: net distance, max step, total distance traveled, OR speed.
        # Total distance catches cases where a bus moves in a curve (low net but high total).
        # Speed catches newly appearing sensors that are clearly in motion.
        sparse_prove_moving_total_m = sparse_prove_moving_net_m * 1.5  # 150m default
        if (net >= sparse_prove_moving_net_m or 
            total >= sparse_prove_moving_total_m or
            speed_mps >= speed_threshold_mps or
            (max_step >= sparse_prove_moving_max_step_m and net >= (sparse_prove_moving_net_m * 0.5))):
            return info

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
        strict_total = 100.0
        strict_max_step = 20.0
        strict_bbox = 60.0
        strict_radius = 30.0
        if tail_total <= strict_total and tail_max <= strict_max_step and tail_bbox <= strict_bbox and tail_radius <= strict_radius:
            info["samples"] = len(recent_tail)
            info["immobile"] = True
            info["window_samples"] = len(recent_tail)
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
            stable_lat, stable_lon = _stable_center_from(recent_coords)
            if stable_lat is not None and stable_lon is not None:
                rr = _robust_radius(recent_coords, stable_lat, stable_lon)
            else:
                rr = 0.0

            net = haversine_distance(recent_coords[0][0], recent_coords[0][1], recent_coords[-1][0], recent_coords[-1][1])
            net = float(net) if isinstance(net, (int, float)) and math.isfinite(net) else 0.0

            max_step = 0.0
            prev = None
            for lat_f, lon_f, _ in recent_coords:
                if prev is not None:
                    d = haversine_distance(prev[0], prev[1], lat_f, lon_f)
                    if isinstance(d, (int, float)) and math.isfinite(d):
                        max_step = max(max_step, float(d))
                prev = (lat_f, lon_f)

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
    bbox_distance_val = bounding_box_distance(recent_coords)
    centroid_lat = sum(lat for lat, _, _ in recent_coords) / len(recent_coords)
    centroid_lon = sum(lon for _, lon, _ in recent_coords) / len(recent_coords)
    max_radius = 0.0
    for lat_f, lon_f, _ in recent_coords:
        dist = haversine_distance(lat_f, lon_f, centroid_lat, centroid_lon)
        if dist > max_radius:
            max_radius = dist

    # Robust cluster center/radius
    med_lat = median([lat for lat, _, _ in recent_coords])
    med_lon = median([lon for _, lon, _ in recent_coords])
    robust_radius = max_radius
    if med_lat is not None and med_lon is not None:
        dists = [haversine_distance(lat, lon, float(med_lat), float(med_lon)) for lat, lon, _ in recent_coords]
        dists = [d for d in dists if isinstance(d, (int, float)) and math.isfinite(d)]
        if dists:
            dists.sort()
            if len(dists) >= 4:
                dists = dists[1:-1]
            robust_radius = dists[-1]

    # Net displacement (first->last)
    net_dist = 0.0
    if recent_coords:
        a0 = recent_coords[0]
        a1 = recent_coords[-1]
        net_dist = haversine_distance(a0[0], a0[1], a1[0], a1[1])

    stationary_by_travel = (
        trimmed_total < total_distance_threshold
        and trimmed_max < max_step_threshold
        and bbox_distance_val < bbox_threshold
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
