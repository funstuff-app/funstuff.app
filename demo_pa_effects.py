"""Synthetic PurpleAir field effects for --demo-pa mode.

Generates a full day of pre-computed PM2.5 readings for every PA sensor,
using the real sensor coordinates fetched at startup.  The resulting
time-series is fed into the normal ``fixed_history`` / ``accumulate_fixed_reading``
path so playback, the sidebar, and the PA field worker all consume it
without any special-case code.

Effects
-------
1. **Baseline** – gentle random walk around clean-air levels (1–4 µg/m³).
2. **Starlight** – individual or small clusters spike for ~20 min, staggered.
3. **Wave** – a Gaussian blob sweeps west→east across the sensor field.
4. **Hotspot spike** – one sensor reports a wildly broken value (~3000+)
   while neighbors stay clean.  Tests outlier suppression.
5. **Localized event** – a tight cluster of nearby sensors all elevate
   together (simulates a real fire).  Tests that the outlier detector does
   NOT suppress correlated events.

All effects are additive on top of baseline and are time-windowed so the
user can scrub through distinct phases in the playback timeline.
"""

from __future__ import annotations

import math
import random
from datetime import datetime, timedelta, timezone, tzinfo
from typing import Any

# ── Mountain Time helper ────────────────────────────────────────────
try:
    from zoneinfo import ZoneInfo
    _MOUNTAIN_TZ: tzinfo = ZoneInfo("America/Denver")
except ImportError:
    from datetime import timezone as _tz
    _MOUNTAIN_TZ = _tz(timedelta(hours=-7))

# ── Constants ───────────────────────────────────────────────────────
STEP_MINUTES = 3          # resolution (matches PA fetch cadence)
STEPS_PER_DAY = 24 * 60 // STEP_MINUTES   # 480

# Baseline noise
BASELINE_MEAN = 2.5       # µg/m³
BASELINE_STD = 0.8

# Starlight effect
STARLIGHT_PEAK_MIN = 55.0
STARLIGHT_PEAK_MAX = 150.0
STARLIGHT_DURATION_STEPS = 7   # ~21 min
STARLIGHT_COUNT = 12           # number of starlight events across the day

# Wave effect
WAVE_PEAK = 80.0               # µg/m³ at centre
WAVE_SIGMA_KM = 4.0            # Gaussian radius in km
WAVE_SPEED_KM_PER_STEP = 1.5   # speed of blob movement

# Hotspot spike (broken sensor)
HOTSPOT_VALUE = 3200.0
HOTSPOT_DURATION_STEPS = 10    # ~30 min

# Localized event (real fire / construction)
LOCAL_EVENT_PEAK = 120.0
LOCAL_EVENT_DURATION_STEPS = 20  # ~60 min
LOCAL_EVENT_RADIUS_KM = 2.0


# ── Geometry helpers ────────────────────────────────────────────────

def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in km."""
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _find_neighbors(sensors: list[dict], idx: int, radius_km: float) -> list[int]:
    """Return indices of sensors within *radius_km* of sensors[idx]."""
    s = sensors[idx]
    lat0, lon0 = s["latitude"], s["longitude"]
    return [
        j for j, o in enumerate(sensors)
        if j != idx and _haversine_km(lat0, lon0, o["latitude"], o["longitude"]) <= radius_km
    ]


def _find_cluster(sensors: list[dict], center_idx: int, radius_km: float, max_size: int = 5) -> list[int]:
    """Return a cluster of up to *max_size* sensors around *center_idx*."""
    nbrs = _find_neighbors(sensors, center_idx, radius_km)
    cluster = [center_idx] + nbrs[:max_size - 1]
    return cluster


# ── Effect generators ──────────────────────────────────────────────

def _generate_baseline(n_sensors: int, n_steps: int, rng: random.Random) -> list[list[float]]:
    """Gentle random-walk baseline for every sensor."""
    data = []
    for _ in range(n_sensors):
        series = [max(0.0, rng.gauss(BASELINE_MEAN, BASELINE_STD))]
        for _ in range(1, n_steps):
            prev = series[-1]
            delta = rng.gauss(0, 0.3)
            series.append(max(0.0, prev + delta))
        data.append(series)
    return data


def _apply_starlight(
    data: list[list[float]],
    sensors: list[dict],
    n_steps: int,
    rng: random.Random,
) -> None:
    """Random individual / small-cluster spikes across the day."""
    n = len(sensors)
    if n == 0:
        return
    # Spread events evenly across the day with some jitter
    interval = max(1, n_steps // STARLIGHT_COUNT)
    for event_i in range(STARLIGHT_COUNT):
        center_step = event_i * interval + rng.randint(0, max(1, interval // 2))
        if center_step >= n_steps:
            continue

        # Pick 1–3 sensors that are physically close
        anchor = rng.randint(0, n - 1)
        cluster_size = rng.choice([1, 1, 1, 2, 3])
        cluster = _find_cluster(sensors, anchor, 3.0, cluster_size)

        peak = rng.uniform(STARLIGHT_PEAK_MIN, STARLIGHT_PEAK_MAX)
        dur = STARLIGHT_DURATION_STEPS + rng.randint(-2, 2)

        for si in cluster:
            for t in range(max(0, center_step - dur // 2), min(n_steps, center_step + dur // 2 + 1)):
                # Smooth bell envelope
                dist_t = abs(t - center_step) / max(1, dur / 2)
                envelope = math.exp(-3.0 * dist_t * dist_t)
                jitter = rng.gauss(0, 2.0)
                data[si][t] = max(0.0, data[si][t] + peak * envelope + jitter)


def _apply_wave(
    data: list[list[float]],
    sensors: list[dict],
    n_steps: int,
    start_step: int,
    duration_steps: int,
    rng: random.Random,
) -> None:
    """Gaussian blob sweeping west→east across the sensor field."""
    if not sensors:
        return

    # Determine geographic extent
    lons = [s["longitude"] for s in sensors]
    lats = [s["latitude"] for s in sensors]
    lon_min, lon_max = min(lons), max(lons)
    lat_center = sum(lats) / len(lats)

    # Convert lat/lon extent to km (approximate at SLC latitude)
    km_per_deg_lon = 111.32 * math.cos(math.radians(lat_center))
    km_per_deg_lat = 110.57
    field_width_km = (lon_max - lon_min) * km_per_deg_lon

    for t_offset in range(duration_steps):
        t = start_step + t_offset
        if t >= n_steps:
            break

        # Wave center moves west→east
        progress = t_offset / max(1, duration_steps - 1)
        center_lon = lon_min + progress * (lon_max - lon_min)

        for si, s in enumerate(sensors):
            dx_km = (s["longitude"] - center_lon) * km_per_deg_lon
            dy_km = (s["latitude"] - lat_center) * km_per_deg_lat * 0.3  # compress lat influence
            dist_km = math.sqrt(dx_km ** 2 + dy_km ** 2)

            contribution = WAVE_PEAK * math.exp(-(dist_km ** 2) / (2 * WAVE_SIGMA_KM ** 2))
            jitter = rng.gauss(0, 1.5)
            data[si][t] = max(0.0, data[si][t] + contribution + jitter)


def _apply_hotspot_spike(
    data: list[list[float]],
    sensors: list[dict],
    n_steps: int,
    start_step: int,
    sensor_idx: int,
    rng: random.Random,
) -> None:
    """One sensor reports a wildly broken value while neighbors stay clean."""
    dur = HOTSPOT_DURATION_STEPS + rng.randint(-2, 3)
    for t in range(start_step, min(n_steps, start_step + dur)):
        # Broken sensor: oscillates around the spike value
        data[sensor_idx][t] = HOTSPOT_VALUE + rng.gauss(0, 50.0)


def _apply_localized_event(
    data: list[list[float]],
    sensors: list[dict],
    n_steps: int,
    start_step: int,
    center_idx: int,
    rng: random.Random,
) -> None:
    """A tight cluster of nearby sensors all elevate (real fire / construction)."""
    cluster = _find_cluster(sensors, center_idx, LOCAL_EVENT_RADIUS_KM, max_size=5)
    dur = LOCAL_EVENT_DURATION_STEPS + rng.randint(-3, 5)

    center_lat = sensors[center_idx]["latitude"]
    center_lon = sensors[center_idx]["longitude"]
    km_per_deg_lon = 111.32 * math.cos(math.radians(center_lat))

    for si in cluster:
        dist = _haversine_km(center_lat, center_lon,
                             sensors[si]["latitude"], sensors[si]["longitude"])
        # Closer sensors get higher readings
        falloff = math.exp(-(dist ** 2) / (2 * (LOCAL_EVENT_RADIUS_KM * 0.6) ** 2))
        peak = LOCAL_EVENT_PEAK * falloff + rng.gauss(0, 5.0)

        for t in range(max(0, start_step), min(n_steps, start_step + dur)):
            dist_t = abs(t - (start_step + dur // 2)) / max(1, dur / 2)
            envelope = math.exp(-2.0 * dist_t * dist_t)
            jitter = rng.gauss(0, 3.0)
            data[si][t] = max(0.0, data[si][t] + peak * envelope + jitter)


# ── Main orchestrator ──────────────────────────────────────────────

def generate_demo_day(
    sensors: list[dict[str, Any]],
    demo_date: datetime | None = None,
    seed: int = 42,
) -> dict[str, dict[str, list[dict[str, Any]]]]:
    """Generate a full day of synthetic PA readings.

    Parameters
    ----------
    sensors : list[dict]
        Real PA sensor metadata, each with at least
        ``sensor_index``, ``latitude``, ``longitude``, ``name``.
    demo_date : datetime, optional
        Base date for timestamps.  Defaults to today (Mountain time).
    seed : int
        RNG seed for reproducibility.

    Returns
    -------
    dict
        ``{ "PA_<sensor_index>": { "PM25": [ {val, ci, time, recorded_at}, ... ] } }``
        Ready to merge directly into ``app_state.fixed_history``.
    """
    rng = random.Random(seed)
    n = len(sensors)
    if n == 0:
        return {}

    if demo_date is None:
        demo_date = datetime.now(_MOUNTAIN_TZ).replace(hour=0, minute=0, second=0, microsecond=0)

    # ── Phase 1: baseline ──
    data = _generate_baseline(n, STEPS_PER_DAY, rng)

    # ── Phase 2: starlight events (distributed throughout the day) ──
    _apply_starlight(data, sensors, STEPS_PER_DAY, rng)

    # ── Phase 3: wave effect (mid-morning, ~60 min) ──
    wave_start = 60 // STEP_MINUTES  # step 20 → 1:00 AM MT → let's push to 9 AM
    wave_start = (9 * 60) // STEP_MINUTES  # step 180
    wave_duration = 60 // STEP_MINUTES     # 20 steps → 60 min
    _apply_wave(data, sensors, STEPS_PER_DAY, wave_start, wave_duration, rng)

    # ── Phase 4: hotspot spike (one broken sensor, late morning) ──
    hotspot_start = (10 * 60 + 30) // STEP_MINUTES  # 10:30 AM
    # Pick a sensor near the geographic center for visibility
    lats = [s["latitude"] for s in sensors]
    lons = [s["longitude"] for s in sensors]
    center_lat = sum(lats) / n
    center_lon = sum(lons) / n
    hotspot_idx = min(range(n), key=lambda i: _haversine_km(
        center_lat, center_lon, sensors[i]["latitude"], sensors[i]["longitude"]))
    _apply_hotspot_spike(data, sensors, STEPS_PER_DAY, hotspot_start, hotspot_idx, rng)

    # ── Phase 5: localized event (afternoon, cluster of sensors) ──
    event_start = (14 * 60) // STEP_MINUTES  # 2:00 PM
    # Pick a different sensor from the hotspot one, also somewhat central
    dists = [_haversine_km(center_lat, center_lon, s["latitude"], s["longitude"]) for s in sensors]
    sorted_by_dist = sorted(range(n), key=lambda i: dists[i])
    # Pick the 5th-closest to center (avoid overlap with hotspot)
    event_center = sorted_by_dist[min(4, n - 1)]
    if event_center == hotspot_idx and n > 1:
        event_center = sorted_by_dist[min(5, n - 1)]
    _apply_localized_event(data, sensors, STEPS_PER_DAY, event_start, event_center, rng)

    # ── Phase 6: second wave (evening, east→west this time, via reversed lon) ──
    wave2_start = (17 * 60) // STEP_MINUTES  # 5:00 PM
    wave2_duration = 40 // STEP_MINUTES
    # Reverse the sensor longitudes temporarily to make the wave go east→west
    for s in sensors:
        s["_orig_lon"] = s["longitude"]
        s["longitude"] = -s["longitude"]
    lon_range = max(s["_orig_lon"] for s in sensors) - min(s["_orig_lon"] for s in sensors)
    # Restore and apply manually for reversed wave
    for s in sensors:
        s["longitude"] = s["_orig_lon"]
        del s["_orig_lon"]
    # Instead of reversing, use a separate wave implementation
    _apply_wave_reverse(data, sensors, STEPS_PER_DAY, wave2_start, wave2_duration, rng)

    # ── Convert to fixed_history format ─────────────────────────────
    from mobileair import color_to_idx
    result: dict[str, dict[str, list[dict[str, Any]]]] = {}

    for si, s in enumerate(sensors):
        sid = f"PA_{s.get('sensor_index', si)}"
        entries = []
        for step in range(STEPS_PER_DAY):
            t = demo_date + timedelta(minutes=step * STEP_MINUTES)
            t_utc = t.astimezone(timezone.utc)
            pm25 = round(max(0.0, data[si][step]), 1)
            color = _pm25_to_color(pm25)
            ci = color_to_idx(color)
            entries.append({
                "val": str(pm25),
                "ci": ci,
                "time": t_utc.strftime("%Y-%m-%dT%H:%M:%S+00:00"),
                "recorded_at": t_utc.timestamp(),
            })
        result[sid] = {"PM25": entries}

    return result


def _apply_wave_reverse(
    data: list[list[float]],
    sensors: list[dict],
    n_steps: int,
    start_step: int,
    duration_steps: int,
    rng: random.Random,
) -> None:
    """Gaussian blob sweeping east→west (reverse of the normal wave)."""
    if not sensors:
        return

    lons = [s["longitude"] for s in sensors]
    lats = [s["latitude"] for s in sensors]
    lon_min, lon_max = min(lons), max(lons)
    lat_center = sum(lats) / len(lats)

    km_per_deg_lon = 111.32 * math.cos(math.radians(lat_center))
    km_per_deg_lat = 110.57

    for t_offset in range(duration_steps):
        t = start_step + t_offset
        if t >= n_steps:
            break

        progress = t_offset / max(1, duration_steps - 1)
        # East→west: start at lon_max, move to lon_min
        center_lon = lon_max - progress * (lon_max - lon_min)

        for si, s in enumerate(sensors):
            dx_km = (s["longitude"] - center_lon) * km_per_deg_lon
            dy_km = (s["latitude"] - lat_center) * km_per_deg_lat * 0.3
            dist_km = math.sqrt(dx_km ** 2 + dy_km ** 2)

            contribution = WAVE_PEAK * 0.7 * math.exp(-(dist_km ** 2) / (2 * WAVE_SIGMA_KM ** 2))
            jitter = rng.gauss(0, 1.5)
            data[si][t] = max(0.0, data[si][t] + contribution + jitter)


def _pm25_to_color(v: float) -> str:
    """PM2.5 → AQI hex color (must match dashboard_server._get_aqi_color for PM25)."""
    if v <= 2.0:   return "#00FFFF"
    if v <= 5.0:   return "#00CCFF"
    if v <= 9.0:   return "#00E400"
    if v <= 35.4:  return "#FFFF00"
    if v <= 55.4:  return "#FF7E00"
    if v <= 125.4: return "#FF0000"
    if v <= 225.4: return "#8F3F97"
    return "#7E0023"


def get_demo_day_label() -> str:
    """Return the date string used for the demo snapshot (today in MT)."""
    now_mt = datetime.now(_MOUNTAIN_TZ)
    return now_mt.strftime("%Y-%m-%d")
