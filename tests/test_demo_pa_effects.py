"""Tests for the demo PA effects generator."""

import math
import sys
from pathlib import Path

# Ensure project root is on the path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from demo_pa_effects import (
    generate_demo_day,
    _generate_baseline,
    _haversine_km,
    _find_neighbors,
    _find_cluster,
    _pm25_to_color,
    STEPS_PER_DAY,
    BASELINE_MEAN,
)
import random
from datetime import datetime, timezone, timedelta


def _make_sensors(n=20, seed=99):
    """Create a grid of fake sensors around SLC."""
    rng = random.Random(seed)
    sensors = []
    for i in range(n):
        sensors.append({
            "sensor_index": 100000 + i,
            "name": f"TestSensor_{i}",
            "latitude": 40.6 + rng.uniform(0, 0.3),
            "longitude": -112.1 + rng.uniform(0, 0.4),
        })
    return sensors


def test_haversine_known_distance():
    # SLC airport to downtown: ~10 km
    d = _haversine_km(40.7899, -111.9791, 40.7608, -111.891)
    assert 5 < d < 15, f"Expected ~10 km, got {d}"


def test_haversine_same_point():
    d = _haversine_km(40.76, -111.89, 40.76, -111.89)
    assert d < 0.001


def test_find_neighbors():
    sensors = _make_sensors(10)
    nbrs = _find_neighbors(sensors, 0, 100.0)  # 100 km = all
    assert len(nbrs) == 9  # everyone except self


def test_find_cluster_max_size():
    sensors = _make_sensors(20)
    cluster = _find_cluster(sensors, 0, 100.0, max_size=3)
    assert len(cluster) <= 3
    assert 0 in cluster


def test_baseline_shape():
    rng = random.Random(42)
    data = _generate_baseline(5, 100, rng)
    assert len(data) == 5
    assert len(data[0]) == 100
    # All values should be non-negative
    for series in data:
        for v in series:
            assert v >= 0.0


def test_baseline_reasonable_range():
    rng = random.Random(42)
    data = _generate_baseline(50, STEPS_PER_DAY, rng)
    all_vals = [v for series in data for v in series]
    mean = sum(all_vals) / len(all_vals)
    # Mean should be close to BASELINE_MEAN
    assert abs(mean - BASELINE_MEAN) < 2.0, f"Mean {mean} too far from {BASELINE_MEAN}"


def test_pm25_to_color():
    assert _pm25_to_color(0.5) == "#00FFFF"   # cyan
    assert _pm25_to_color(3.0) == "#00CCFF"   # light blue
    assert _pm25_to_color(7.0) == "#00E400"   # green
    assert _pm25_to_color(20.0) == "#FFFF00"  # yellow
    assert _pm25_to_color(50.0) == "#FF7E00"  # orange
    assert _pm25_to_color(100.0) == "#FF0000" # red
    assert _pm25_to_color(200.0) == "#8F3F97" # purple
    assert _pm25_to_color(300.0) == "#7E0023" # maroon


def test_generate_demo_day_structure():
    sensors = _make_sensors(10)
    demo_date = datetime(2026, 3, 18, tzinfo=timezone(timedelta(hours=-7)))
    result = generate_demo_day(sensors, demo_date=demo_date, seed=42)

    assert len(result) == 10
    for sid, pollutants in result.items():
        assert sid.startswith("PA_")
        assert "PM25" in pollutants
        entries = pollutants["PM25"]
        assert len(entries) == STEPS_PER_DAY
        for e in entries:
            assert "val" in e
            assert "ci" in e
            assert "time" in e
            assert "recorded_at" in e
            assert float(e["val"]) >= 0.0


def test_generate_demo_day_has_spikes():
    """The demo day should have at least some values > 50 (starlight/wave/events)."""
    sensors = _make_sensors(30)
    demo_date = datetime(2026, 3, 18, tzinfo=timezone(timedelta(hours=-7)))
    result = generate_demo_day(sensors, demo_date=demo_date, seed=42)

    max_val = 0.0
    for sid, pollutants in result.items():
        for e in pollutants["PM25"]:
            v = float(e["val"])
            if v > max_val:
                max_val = v

    assert max_val > 50.0, f"Expected spikes, max was {max_val}"


def test_generate_demo_day_has_hotspot():
    """At least one sensor should have an extreme value (>1000) from the hotspot spike."""
    sensors = _make_sensors(30)
    demo_date = datetime(2026, 3, 18, tzinfo=timezone(timedelta(hours=-7)))
    result = generate_demo_day(sensors, demo_date=demo_date, seed=42)

    max_val = 0.0
    for sid, pollutants in result.items():
        for e in pollutants["PM25"]:
            v = float(e["val"])
            if v > max_val:
                max_val = v

    assert max_val > 1000.0, f"Expected hotspot value >1000, max was {max_val}"


def test_generate_demo_day_timestamps_utc():
    """All timestamps should be valid UTC strings."""
    sensors = _make_sensors(5)
    demo_date = datetime(2026, 3, 18, tzinfo=timezone(timedelta(hours=-7)))
    result = generate_demo_day(sensors, demo_date=demo_date, seed=42)

    for sid, pollutants in result.items():
        for e in pollutants["PM25"]:
            t_str = e["time"]
            # Should end with +00:00 (UTC)
            assert "+00:00" in t_str, f"Expected UTC timestamp, got {t_str}"


def test_generate_demo_day_empty_sensors():
    result = generate_demo_day([], seed=42)
    assert result == {}


def test_localized_event_cluster_elevated():
    """Multiple sensors near the event center should be elevated, not just one."""
    sensors = _make_sensors(40, seed=123)
    demo_date = datetime(2026, 3, 18, tzinfo=timezone(timedelta(hours=-7)))
    result = generate_demo_day(sensors, demo_date=demo_date, seed=42)

    # The localized event is at step (14*60)//3 = 280 → 2:00 PM MT
    event_step = (14 * 60) // 3
    # Find sensors that have elevated values around that time
    elevated_sensors = 0
    for sid, pollutants in result.items():
        entries = pollutants["PM25"]
        # Check a window around the event
        window = entries[max(0, event_step - 5):min(len(entries), event_step + 15)]
        max_in_window = max(float(e["val"]) for e in window)
        if max_in_window > 30.0:  # significantly above baseline
            elevated_sensors += 1

    # At least 2 sensors should be elevated (it's a cluster event)
    assert elevated_sensors >= 2, f"Expected cluster, only {elevated_sensors} elevated"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    passed = 0
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  PASS  {t.__name__}")
            passed += 1
        except Exception as e:
            print(f"  FAIL  {t.__name__}: {e}")
            failed += 1
    print(f"\n{passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)
