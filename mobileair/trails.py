"""
Trail extraction and cleaning for mobile sensors.

Handles breadcrumb track extraction, spike scrubbing, and stationary suffix collapsing.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any

from .aqi import color_for_value
from .utils import parse_utc_timestamp, haversine_distance, coerce_float, median


def extract_mobile_tracks(
    mobile_json: dict[str, Any],
    *,
    max_points: int = 200,
) -> dict[str, list[dict[str, Any]]]:
    """Extract per-sensor breadcrumb points from the mobile API JSON.

    Returns:
        { sensor_id: [ {lat, lon, t, readings}, ... ] }

    Points are sorted by time when TimeUTC is parseable; otherwise original order.
    Capped to max_points.
    """
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
                lat_f = coerce_float(lat)
                lon_f = coerce_float(lon)
                if lat_f is None or lon_f is None:
                    continue

                ts_str = ts if isinstance(ts, str) else None
                key = ts_str or f"idx:{idx}"
                if key not in s_map:
                    s_map[key] = {"lat": lat_f, "lon": lon_f, "t": ts_str, "readings": {}}
                    s_order.append(key)
                    s_dt[key] = parse_utc_timestamp(ts_str) if ts_str else None
                else:
                    s_map[key]["lat"] = lat_f
                    s_map[key]["lon"] = lon_f

                if v is not None:
                    # Always compute color from value using our EPA 2024 scale.
                    # API ValueColor uses Utah AQ's own scale which differs.
                    color = color_for_value(pollutant_key, v)
                    s_map[key]["readings"][str(pollutant_key)] = {"value": v, "color": color}

    out: dict[str, list[dict[str, Any]]] = {}
    for sensor_id, m in per_sensor.items():
        keys = per_sensor_order.get(sensor_id, list(m.keys()))
        dt_map = per_sensor_dt.get(sensor_id, {})

        if any(dt_map.get(k) is not None for k in keys):
            keys = sorted(keys, key=lambda k: (dt_map.get(k) is None, dt_map.get(k) or datetime.min.replace(tzinfo=timezone.utc)))

        points: list[dict[str, Any]] = [m[k] for k in keys if k in m]

        # De-dupe consecutive identical lat/lon/t
        deduped: list[dict[str, Any]] = []
        last_key = None
        for p in points:
            k = (p.get("lat"), p.get("lon"), p.get("t"))
            if k == last_key:
                continue
            last_key = k
            deduped.append(p)

        # Carry-forward pollutant readings
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

        # Carry-backward: fill early points with first available readings
        # (handles case where e.g. OZNE starts before PM25 due to different update rates)
        if deduped:
            first_complete: dict[str, dict[str, Any]] = {}
            for p in deduped:
                r = p.get("readings")
                if isinstance(r, dict):
                    for pk, pv in r.items():
                        if pk not in first_complete and isinstance(pv, dict):
                            first_complete[str(pk)] = dict(pv)
            # Apply to points missing those readings
            for p in deduped:
                r = p.get("readings")
                if isinstance(r, dict):
                    for pk, pv in first_complete.items():
                        if pk not in r:
                            r[pk] = dict(pv)

        if len(deduped) > max_points:
            deduped = deduped[-max_points:]

        out[sensor_id] = deduped

    return out


def clean_trail(
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
    """Clean a trail by removing GPS spikes and collapsing stationary suffixes."""
    if not isinstance(pts, list) or len(pts) < 2:
        return pts

    def _pt_latlon(p: dict[str, Any] | None) -> tuple[float | None, float | None]:
        if not isinstance(p, dict):
            return (None, None)
        lat = coerce_float(p.get("lat"))
        lon = coerce_float(p.get("lon"))
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

    # 3) Collapse parked stationary suffix based on motion.
    tail = pts[max(0, len(pts) - int(max(6, parked_tail_n))) :]
    lats: list[float] = []
    lons: list[float] = []
    for p in tail:
        if not isinstance(p, dict):
            continue
        lat = coerce_float(p.get("lat"))
        lon = coerce_float(p.get("lon"))
        if lat is None or lon is None:
            continue
        lats.append(float(lat))
        lons.append(float(lon))
    med_lat = median(lats)
    med_lon = median(lons)
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


def collapse_stationary_suffix(
    pts: list[dict[str, Any]],
    *,
    center_lat: float,
    center_lon: float,
    radius_m: float = 70.0,
    min_pts: int = 10,
) -> list[dict[str, Any]]:
    """Collapse a stationary suffix of a trail around a known center point."""
    if not isinstance(pts, list) or len(pts) < (min_pts + 2):
        return pts
    if not (isinstance(center_lat, (int, float)) and isinstance(center_lon, (int, float))):
        return pts
    if not (math.isfinite(center_lat) and math.isfinite(center_lon) and radius_m > 0):
        return pts

    i0 = len(pts) - 1
    while i0 - 1 >= 0:
        p = pts[i0 - 1]
        lat = coerce_float(p.get("lat")) if isinstance(p, dict) else None
        lon = coerce_float(p.get("lon")) if isinstance(p, dict) else None
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

    if (len(pts) - (i0 + 1)) <= 1:
        return pts
    return pts[: i0 + 1] + [rep]
