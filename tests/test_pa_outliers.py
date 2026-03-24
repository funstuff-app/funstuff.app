"""Tests for PA spatial outlier detection."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dashboard_server import detect_pa_outliers


# ── Helpers ─────────────────────────────────────────────────────────

def _cluster_at(center_lat, center_lon, n, spacing_deg=0.005, value=2.0):
    """Generate n sensors in a tight grid around center, all at `value`."""
    sensors = []
    side = int(n ** 0.5) + 1
    for i in range(n):
        row, col = divmod(i, side)
        sensors.append((
            center_lat + row * spacing_deg,
            center_lon + col * spacing_deg,
            value,
        ))
    return sensors


# ── Tests ───────────────────────────────────────────────────────────

def test_broken_sensor_flagged():
    """One sensor at 3000 among clean neighbors → outlier."""
    sensors = _cluster_at(40.76, -111.89, 10, value=2.0)
    # Replace center sensor with a broken value
    sensors[0] = (40.76, -111.89, 3000.0)
    outliers = detect_pa_outliers(sensors)
    assert 0 in outliers, f"Expected sensor 0 to be outlier, got {outliers}"


def test_moderate_spike_not_flagged():
    """One sensor at 200 among clean air (2 µg/m³) → NOT outlier.

    Moderate values are physically plausible for real local events
    (construction, idling trucks).  Spatial detection is reserved for
    implausibly high readings (>= 500); temporal checks handle the rest.
    """
    sensors = _cluster_at(40.76, -111.89, 8, value=2.0)
    sensors[0] = (40.76, -111.89, 200.0)
    outliers = detect_pa_outliers(sensors)
    assert 0 not in outliers


def test_extreme_spike_flagged():
    """One sensor at 600 among clean air (2 µg/m³) → outlier."""
    sensors = _cluster_at(40.76, -111.89, 8, value=2.0)
    sensors[0] = (40.76, -111.89, 600.0)
    outliers = detect_pa_outliers(sensors)
    assert 0 in outliers


def test_clean_air_no_outliers():
    """All sensors at similar clean-air levels → no outliers."""
    sensors = _cluster_at(40.76, -111.89, 10, value=3.0)
    # Add some natural variation
    sensors[1] = (sensors[1][0], sensors[1][1], 5.0)
    sensors[2] = (sensors[2][0], sensors[2][1], 1.0)
    outliers = detect_pa_outliers(sensors)
    assert len(outliers) == 0, f"Expected no outliers, got {outliers}"


def test_cluster_event_not_flagged():
    """Multiple nearby sensors all elevated → NOT outliers (real event)."""
    sensors = _cluster_at(40.76, -111.89, 10, value=2.0)
    # Elevate a cluster of 3 nearby sensors (simulating a fire)
    sensors[0] = (40.76, -111.89, 120.0)
    sensors[1] = (40.76 + 0.005, -111.89, 100.0)
    sensors[2] = (40.76, -111.89 + 0.005, 80.0)
    outliers = detect_pa_outliers(sensors)
    # None of the elevated sensors should be flagged
    assert 0 not in outliers, f"Sensor 0 wrongly flagged: {outliers}"
    assert 1 not in outliers, f"Sensor 1 wrongly flagged: {outliers}"
    assert 2 not in outliers, f"Sensor 2 wrongly flagged: {outliers}"


def test_too_few_neighbors_kept():
    """Sensor with < 3 neighbors is never flagged (insufficient evidence)."""
    sensors = [
        (40.76, -111.89, 3000.0),    # suspicious
        (40.76 + 0.01, -111.89, 2.0), # 1 neighbor
        (40.76, -111.89 + 0.01, 2.0), # 2 neighbors
    ]
    outliers = detect_pa_outliers(sensors)
    assert len(outliers) == 0, f"Expected no outliers (too few neighbors), got {outliers}"


def test_distant_spike_not_flagged():
    """Sensor far from others → no neighbors → not flagged."""
    sensors = _cluster_at(40.76, -111.89, 8, value=2.0)
    # Add a distant sensor with a spike
    sensors.append((41.5, -112.5, 3000.0))  # ~80 km away
    outliers = detect_pa_outliers(sensors)
    # The distant sensor should NOT be flagged (no neighbors to compare)
    distant_idx = len(sensors) - 1
    assert distant_idx not in outliers


def test_moderate_value_among_moderate():
    """Sensor at 40 among neighbors at 20–30 → NOT outlier (within range)."""
    sensors = _cluster_at(40.76, -111.89, 8, value=25.0)
    sensors[0] = (40.76, -111.89, 40.0)
    outliers = detect_pa_outliers(sensors)
    assert 0 not in outliers


def test_borderline_not_flagged():
    """Value just below ratio threshold → not flagged."""
    sensors = _cluster_at(40.76, -111.89, 8, value=10.0)
    # 4.9× median of 10 → below 5× ratio threshold
    sensors[0] = (40.76, -111.89, 49.0)
    outliers = detect_pa_outliers(sensors)
    assert 0 not in outliers


def test_empty_input():
    assert detect_pa_outliers([]) == set()


def test_single_sensor():
    assert detect_pa_outliers([(40.76, -111.89, 3000.0)]) == set()


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
