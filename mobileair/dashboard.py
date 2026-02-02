"""
Dashboard state normalization.

Transforms raw API data into the JSON shape consumed by the browser dashboard.
"""

from __future__ import annotations

import time
from datetime import timedelta
from typing import Any

from .aqi import (
    value_to_aqi,
    aqi_level,
    filter_history_outliers,
    normalize_pollutant_key,
)
from .config import IMMOBILITY_LOOKBACK_MINUTES, STALE_DATA_THRESHOLD_MINUTES
from .mobility import evaluate_mobility
from .outliers import detect_spatial_outliers
from .trails import extract_mobile_tracks, clean_trail, collapse_stationary_suffix
from .utils import parse_utc_timestamp, coerce_float

# We only need checking type for annotation or logic if we import it.
# To avoid circular import at runtime if roads imports dashboard (unlikely but safe), we handle import inside.
from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from .roads import RoadGraph


def _pick_primary_reading_color(readings: dict[str, Any]) -> str:
    """Pick a color from readings, preferring PM25, then PM10, then OZNE."""
    priority = ["PM25", "PM2.5", "PM10", "OZNE", "Ozone"]
    for k in priority:
        v = readings.get(k)
        if isinstance(v, dict) and isinstance(v.get("color"), str):
            return v["color"]
    for v in readings.values():
        if isinstance(v, dict) and isinstance(v.get("color"), str):
            return v["color"]
    return "#3388ff"


def _pick_primary_pollutant_key(readings: dict[str, Any]) -> str | None:
    """Pick the primary pollutant key from readings."""
    priority = ["PM25", "PM2.5", "PM10", "OZNE", "Ozone"]
    for k in priority:
        if k in readings:
            return k
    return next(iter(readings.keys()), None)


def _is_plausible_value(pollutant_key: str, value: Any) -> bool:
    """Check if a pollutant value is plausible (not sensor noise)."""
    import math
    try:
        fv = float(value)
    except (TypeError, ValueError):
        return False
    if not math.isfinite(fv):
        return False
    key = normalize_pollutant_key(pollutant_key)
    bounds = {"pm2.5": (0.0, 999.0), "pm10": (0.0, 2000.0), "ozone": (0.0, 600.0)}.get(key)
    if bounds and not (bounds[0] <= fv <= bounds[1]):
        return False
    return True


def _pick_worst_reading_by_aqi(readings: dict[str, Any]) -> dict[str, Any]:
    """Pick the reading with the highest AQI (non-linear) among available pollutants.
    
    Returns {key, value, color, aqi} (aqi may be None).
    Filters out implausible values (sensor noise) before picking.
    """
    best = {"key": None, "value": None, "color": "#ffffff", "aqi": None}
    best_aqi = -1.0
    for k, v in readings.items():
        if not isinstance(v, dict):
            continue
        val = v.get("value")
        col = v.get("color") or "#ffffff"
        
        # Skip implausible values (sensor noise like OZNE=1472)
        if not _is_plausible_value(k, val):
            continue
        
        aqi = value_to_aqi(normalize_pollutant_key(str(k)), val)
        try:
            aqi_f = float(aqi) if aqi is not None else -1.0
        except Exception:
            aqi_f = -1.0
        if aqi_f > best_aqi:
            best_aqi = aqi_f
            best = {"key": str(k), "value": val, "color": col, "aqi": aqi_f if aqi_f >= 0 else None}

    # If no AQI could be computed, fall back to priority key ordering.
    if best["key"] is None:
        k0 = _pick_primary_pollutant_key(readings)
        if k0 and isinstance(readings.get(k0), dict):
            return {"key": k0, "value": readings[k0].get("value"), "color": readings[k0].get("color") or "#ffffff", "aqi": None}
    return best


def normalize_state_for_dashboard(
    combined_data: dict[str, Any],
    *,
    custom_names: dict[str, str] | None = None,
    pinned_sensors: set[str] | None = None,
    max_points: int = 200,
    mobile_url: str,
    fixed_url: str,
    data_dir: str,
    road_graph: "RoadGraph | None" = None,
    tram_line_graph: "RoadGraph | None" = None,
) -> dict[str, Any]:
    """Normalize combined API data into a dashboard-friendly JSON shape.

    Args:
        combined_data: Dict with 'mobile' and 'fixed' API responses.
        custom_names: Custom display names for sensors.
        pinned_sensors: Set of sensor IDs that are pinned.
        max_points: Maximum trail points per sensor.
        mobile_url: URL for mobile data (for metadata).
        fixed_url: URL for fixed data (for metadata).
        data_dir: Data directory path (for metadata).
        road_graph: Optional RoadGraph instance for map matching (buses, etc).
        tram_line_graph: Optional RoadGraph for TRAX/tram vehicles (built from GPS traces).

    Returns:
        Normalized state dict with 'ts', 'meta', 'mobile', and 'fixed' keys.
    """
    # Lazy import to avoid circular dependency
    if road_graph or tram_line_graph:
        from .roads import snap_vehicle_simple

    custom_names = custom_names or {}
    pinned_sensors = pinned_sensors or set()

    mobile_json = combined_data.get("mobile") if isinstance(combined_data, dict) else {}
    fixed_json = combined_data.get("fixed") if isinstance(combined_data, dict) else {}

    # Extract the API's last update timestamp for staleness detection
    api_last_update_dt = None
    if isinstance(mobile_json, dict):
        # Try to find LastUpdateUTC from any pollutant section
        for pollutant_key, details in mobile_json.items():
            if isinstance(details, dict):
                last_update_str = details.get("LastUpdateUTC")
                if isinstance(last_update_str, str):
                    api_last_update_dt = parse_utc_timestamp(last_update_str)
                    if api_last_update_dt is not None:
                        break

    tracks = extract_mobile_tracks(mobile_json if isinstance(mobile_json, dict) else {}, max_points=max_points)

    # Determine last position change timestamp
    def _pos_changed(a: dict[str, Any] | None, b: dict[str, Any] | None, eps: float = 1e-6) -> bool:
        if not isinstance(a, dict) or not isinstance(b, dict):
            return False
        try:
            lat1 = float(a.get("lat"))
            lon1 = float(a.get("lon"))
            lat2 = float(b.get("lat"))
            lon2 = float(b.get("lon"))
        except Exception:
            return False
        return (abs(lat2 - lat1) > eps) or (abs(lon2 - lon1) > eps)

    last_sample_dt = None
    last_move_dt = None
    for _sid, pts in tracks.items():
        if not isinstance(pts, list) or not pts:
            continue
        for p in pts:
            dt = parse_utc_timestamp(p.get("t")) if isinstance(p, dict) and isinstance(p.get("t"), str) else None
            if dt is not None and (last_sample_dt is None or dt > last_sample_dt):
                last_sample_dt = dt
        prev = None
        for p in pts:
            if _pos_changed(prev, p):
                dt = parse_utc_timestamp(p.get("t")) if isinstance(p, dict) and isinstance(p.get("t"), str) else None
                if dt is not None and (last_move_dt is None or dt > last_move_dt):
                    last_move_dt = dt
            prev = p
    ui_dt = last_move_dt or last_sample_dt
    ui_ts = float(ui_dt.timestamp()) if ui_dt is not None else time.time()

    # Build mobile sensors list
    mobile_sensors: list[dict[str, Any]] = []
    outlier_scrubs: list[dict[str, Any]] = []
    
    for sensor_id, pts in tracks.items():
        if not pts:
            continue
        pts = clean_trail(pts)
        last = pts[-1]
        name = custom_names.get(sensor_id) or ""

        # Mobility evaluation
        mobility_info: dict[str, Any] = {}
        trail_lat: list[float] = []
        trail_lon: list[float] = []
        trail_time: list[str] = []
        for trail_point in pts:
            if not isinstance(trail_point, dict):
                continue
            lat_f = coerce_float(trail_point.get("lat"))
            lon_f = coerce_float(trail_point.get("lon"))
            ts_str = trail_point.get("t") if isinstance(trail_point.get("t"), str) else None
            if lat_f is None or lon_f is None or not ts_str:
                continue
            trail_lat.append(float(lat_f))
            trail_lon.append(float(lon_f))
            trail_time.append(ts_str)

        if trail_lat and trail_lon:
            trail_blob = {"Latitude": trail_lat, "Longitude": trail_lon, "TimeUTC": trail_time}
            mobility_info = evaluate_mobility(trail_blob)

            # Per-point moving flag used by playback visibility.
            # Mark all points as moving - the playback physics handles realistic movement.
            for idx in range(len(pts)):
                if isinstance(pts[idx], dict):
                    pts[idx]["m"] = 1
            
            # DISABLED: Expensive per-point mobility evaluation (was taking minutes for historical data)
            # Uncomment to re-enable per-point moving/stopped classification:
            #
            # point_times = [parse_utc_timestamp(p.get("t")) if isinstance(p, dict) else None for p in pts]
            # lookback_s = float(max(60.0, IMMOBILITY_LOOKBACK_MINUTES * 120.0))
            # window_start_idx = 0
            # for idx in range(len(pts)):
            #     current_dt = point_times[idx]
            #     if current_dt is None:
            #         if isinstance(pts[idx], dict):
            #             pts[idx]["m"] = 0
            #         continue
            #
            #     cutoff_dt = current_dt - timedelta(seconds=lookback_s)
            #     while window_start_idx < idx and point_times[window_start_idx] is not None and point_times[window_start_idx] < cutoff_dt:
            #         window_start_idx += 1
            #
            #     window_points = pts[window_start_idx : idx + 1]
            #     window_latitudes: list[float] = []
            #     window_longitudes: list[float] = []
            #     window_timestamps: list[str] = []
            #     for window_point in window_points:
            #         if not isinstance(window_point, dict):
            #             continue
            #         lat_f = coerce_float(window_point.get("lat"))
            #         lon_f = coerce_float(window_point.get("lon"))
            #         ts_str = window_point.get("t") if isinstance(window_point.get("t"), str) else None
            #         if lat_f is None or lon_f is None or not ts_str:
            #             continue
            #         window_latitudes.append(float(lat_f))
            #         window_longitudes.append(float(lon_f))
            #         window_timestamps.append(ts_str)
            #     if len(window_latitudes) < 2:
            #         overall_immobile = bool(mobility_info.get("immobile"))
            #         if idx > 0 and isinstance(pts[idx-1], dict) and pts[idx-1].get("m") is not None:
            #             pts[idx]["m"] = pts[idx-1].get("m")
            #         else:
            #             pts[idx]["m"] = 0 if overall_immobile else 1
            #         continue
            #     window_blob = {"Latitude": window_latitudes, "Longitude": window_longitudes, "TimeUTC": window_timestamps}
            #
            #     window_mobility = evaluate_mobility(
            #         window_blob,
            #         assume_immobile_when_sparse=True,
            #         assume_immobile_when_low_coverage=True,
            #         allow_short_window_immobile=True,
            #     )
            #     is_window_immobile = bool(window_mobility.get("immobile"))
            #     pts[idx]["m"] = 0 if is_window_immobile else 1

        is_immobile = bool(mobility_info.get("immobile"))
        forced_active = False
        ghosted = False

        # Staleness detection: Mark sensor as stale if its last data point is
        # significantly older than the API's last update time
        stale = False
        sensor_last_dt = None
        if pts:
            last_ts = pts[-1].get("t") if isinstance(pts[-1], dict) else None
            if isinstance(last_ts, str):
                sensor_last_dt = parse_utc_timestamp(last_ts)
        
        if api_last_update_dt is not None and sensor_last_dt is not None:
            staleness_gap = api_last_update_dt - sensor_last_dt
            stale_threshold = timedelta(minutes=STALE_DATA_THRESHOLD_MINUTES)
            if staleness_gap > stale_threshold:
                stale = True
                # Also mark as ghosted since stale sensors should be dimmed
                ghosted = True

        stable_lat = coerce_float(mobility_info.get("stable_lat"))
        stable_lon = coerce_float(mobility_info.get("stable_lon"))
        pts2 = pts
        last2 = last
        if is_immobile and stable_lat is not None and stable_lon is not None:
            pts2 = collapse_stationary_suffix(pts, center_lat=float(stable_lat), center_lon=float(stable_lon), radius_m=70.0, min_pts=10)
            if pts2:
                last2 = pts2[-1]

        # Apply road/track snapping for vehicles
        # TRX = tram tracks ONLY, BUS = roads ONLY - NO FALLBACKS
        if pts2 and not is_immobile:
            sid = sensor_id.upper()
            is_trax = sid.startswith("TRX") or sid.startswith("TRAX")
            
            if is_trax:
                # Trams: ONLY use tram track graph (no fallback to roads)
                # Use large snap radius (200m) because GPS can drift significantly
                if tram_line_graph:
                    try:
                        snapped = snap_vehicle_simple(pts2, tram_line_graph, max_snap_m=200.0, lane_offset_m=0)
                        if snapped:
                            pts2 = snapped
                    except Exception:
                        pass
            elif road_graph:
                # Buses: ONLY use road graph (no fallback)
                try:
                    snapped = snap_vehicle_simple(pts2, road_graph, max_snap_m=75.0, lane_offset_m=2.5)
                    if snapped:
                        pts2 = snapped
                except Exception:
                    pass

        # Collect readings
        readings: dict[str, Any] = {}
        if isinstance(mobile_json, dict):
            for pollutant_key, details in mobile_json.items():
                if not isinstance(details, dict):
                    continue
                s_data = details.get(sensor_id)
                if not isinstance(s_data, dict):
                    continue
                vals = s_data.get("Value")
                cols = s_data.get("ValueColor")
                v = None
                c = None
                if isinstance(vals, list) and vals:
                    v = vals[-1]
                if isinstance(cols, list) and cols and isinstance(vals, list) and len(cols) == len(vals):
                    c = cols[-1]
                elif isinstance(cols, list) and cols:
                    c = cols[-1]
                if v is None and isinstance(s_data.get("Value"), (str, int, float)):
                    v = s_data.get("Value")
                if c is None and isinstance(s_data.get("ValueColor"), str):
                    c = s_data.get("ValueColor")
                if v is not None:
                    filtered_vals, filtered_cols, removed_vals = filter_history_outliers(
                        str(pollutant_key),
                        vals if isinstance(vals, list) else [v],
                        cols if isinstance(cols, list) else None,
                    )
                    if filtered_cols is None:
                        filtered_cols = [c or "#ffffff"] * len(filtered_vals)

                    if removed_vals:
                        outlier_scrubs.append(
                            {
                                "sensor_id": sensor_id,
                                "pollutant": str(pollutant_key),
                                "removed": removed_vals,
                                "ts": ui_ts,
                            }
                        )
                    readings[str(pollutant_key)] = {
                        "value": v,
                        "color": c or "#ffffff",
                        "history": filtered_vals,
                        "history_colors": filtered_cols,
                        "scrubbed": len(removed_vals),
                    }

        sid = sensor_id.upper()
        if sid.startswith("BUS"):
            emoji = "🚍"
        elif sid.startswith("TRX") or sid.startswith("TRAX"):
            emoji = "🚃"
        else:
            emoji = "📍"

        worst = _pick_worst_reading_by_aqi(readings)
        mobile_sensors.append(
            {
                "id": sensor_id,
                "name": name,
                "pinned": sensor_id in pinned_sensors,
                "emoji": emoji,
                "lat": last2.get("lat"),
                "lon": last2.get("lon"),
                "trail": pts2,
                "readings": readings,
                "mobility": mobility_info,
                "immobile": is_immobile,
                "forced_active": forced_active,
                "ghosted": ghosted,
                "stale": stale,
                "color": _pick_primary_reading_color(readings),
                "primary_key": worst.get("key"),
                "primary_value": worst.get("value"),
                "primary_color": worst.get("color"),
                "primary_aqi": worst.get("aqi"),
            }
        )

    # Fixed sensors
    fixed_sensors: list[dict[str, Any]] = []
    if isinstance(fixed_json, dict):
        fixed_by_sensor: dict[str, dict[str, Any]] = {}
        for pollutant_key, details in fixed_json.items():
            if not isinstance(details, dict):
                continue
            for sensor_id, s_data in details.items():
                if sensor_id in ("LastUpdateUTC", "LastUpdateLocal", "APITimeStart", "APITimeEnd", "VarName", "VarUnit"):
                    continue
                if not isinstance(s_data, dict):
                    continue
                lat = s_data.get("Latitude")
                lon = s_data.get("Longitude")
                lat_f = coerce_float(lat)
                lon_f = coerce_float(lon)
                if lat_f is None or lon_f is None:
                    continue
                entry = fixed_by_sensor.setdefault(sensor_id, {"id": sensor_id, "lat": lat_f, "lon": lon_f, "readings": {}})
                entry["readings"][str(pollutant_key)] = {"value": s_data.get("Value"), "color": s_data.get("ValueColor", "#cccccc")}
        
        for s_id, entry in fixed_by_sensor.items():
            name = custom_names.get(s_id) or ""
            readings = entry.get("readings", {}) if isinstance(entry.get("readings"), dict) else {}
            worst = _pick_worst_reading_by_aqi(readings)
            fixed_sensors.append(
                {
                    "id": s_id,
                    "name": name,
                    "pinned": s_id in pinned_sensors,
                    "emoji": "📍",
                    "lat": entry.get("lat"),
                    "lon": entry.get("lon"),
                    "readings": readings,
                    "color": _pick_primary_reading_color(readings),
                    "primary_key": worst.get("key"),
                    "primary_value": worst.get("value"),
                    "primary_color": worst.get("color"),
                    "primary_aqi": worst.get("aqi"),
                }
            )

    # Hide fixed-site spatial outliers
    fixed_outliers = detect_spatial_outliers(
        fixed_sensors,
        pollutant_keys=("PM25", "PM2.5"),
        radius_m=15000.0,
        max_radius_m=80000.0,
        min_neighbors=3,
    )
    if fixed_outliers:
        fixed_sensors = [s for s in fixed_sensors if str(s.get("id")) not in fixed_outliers]

    # Add home sensor from Dirigera hub
    from .dirigera_home import get_home_sensor_entry
    home_entry = get_home_sensor_entry()
    if home_entry:
        fixed_sensors.insert(0, home_entry)

    # Sort mobile sensors
    mobile_sensors.sort(
        key=lambda s: (
            not bool(s.get("ghosted")),
            not bool(s.get("pinned")),
            str(s.get("id")),
        )
    )

    meta: dict[str, Any] = {
        "max_points": max_points,
        "mobile_url": mobile_url,
        "fixed_url": fixed_url,
        "data_dir": data_dir,
        "last_position_change_ts": ui_ts,
        "fixed_outliers": sorted(list(fixed_outliers)) if fixed_outliers else [],
    }
    if outlier_scrubs:
        meta["outlier_scrubs"] = outlier_scrubs
        meta["outlier_scrubs_count"] = len(outlier_scrubs)

    return {
        "ts": time.time(),
        "meta": meta,
        "mobile": mobile_sensors,
        "fixed": fixed_sensors,
    }
