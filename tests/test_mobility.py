"""
Tests for mobileair/mobility.py - Mobility detection.
"""

import unittest
from datetime import datetime, timedelta, timezone

from mobileair.mobility import evaluate_mobility


class TestEvaluateMobilityBasic(unittest.TestCase):
    """Test basic mobility detection scenarios."""

    def test_empty_input(self):
        """Empty input returns non-immobile."""
        result = evaluate_mobility({})
        self.assertFalse(result.get("immobile"))

    def test_missing_coords(self):
        """Missing coordinates returns non-immobile."""
        result = evaluate_mobility({"TimeUTC": ["2025-12-29 10:00:00 UTC"]})
        self.assertFalse(result.get("immobile"))

    def test_single_point(self):
        """Single point assumes idle (sparse data)."""
        result = evaluate_mobility({
            "Latitude": [40.0],
            "Longitude": [-111.0],
            "TimeUTC": ["2025-12-29 10:00:00 UTC"],
        })
        self.assertTrue(result.get("immobile"))
        self.assertIn("stable_lat", result)
        self.assertIn("stable_lon", result)


class TestEvaluateMobilityStationary(unittest.TestCase):
    """Test stationary/parked detection."""

    def test_clearly_parked_many_samples(self):
        """Many samples in same location = parked."""
        base = datetime(2025, 12, 29, 10, 0, 0, tzinfo=timezone.utc)
        times = [(base + timedelta(minutes=i)).strftime("%Y-%m-%d %H:%M:%S UTC") for i in range(20)]
        
        result = evaluate_mobility({
            "Latitude": [40.0] * 20,
            "Longitude": [-111.0] * 20,
            "TimeUTC": times,
        })
        self.assertTrue(result.get("immobile"))

    def test_gps_drift_still_parked(self):
        """Small GPS drift doesn't indicate movement."""
        base = datetime(2025, 12, 29, 10, 0, 0, tzinfo=timezone.utc)
        times = [(base + timedelta(minutes=i)).strftime("%Y-%m-%d %H:%M:%S UTC") for i in range(15)]
        
        # Small drift within ~10m
        lats = [40.0 + (i % 3) * 0.00005 for i in range(15)]
        lons = [-111.0 + (i % 2) * 0.00005 for i in range(15)]
        
        result = evaluate_mobility({
            "Latitude": lats,
            "Longitude": lons,
            "TimeUTC": times,
        })
        self.assertTrue(result.get("immobile"))


class TestEvaluateMobilityMoving(unittest.TestCase):
    """Test moving detection."""

    def test_clearly_moving(self):
        """Clear movement across many samples = not immobile."""
        base = datetime(2025, 12, 29, 10, 0, 0, tzinfo=timezone.utc)
        times = [(base + timedelta(minutes=i)).strftime("%Y-%m-%d %H:%M:%S UTC") for i in range(10)]
        
        # Moving ~100m per sample
        lats = [40.0 + i * 0.001 for i in range(10)]
        lons = [-111.0 + i * 0.001 for i in range(10)]
        
        result = evaluate_mobility({
            "Latitude": lats,
            "Longitude": lons,
            "TimeUTC": times,
        })
        self.assertFalse(result.get("immobile"))

    def test_large_single_jump(self):
        """Large single jump indicates movement."""
        base = datetime(2025, 12, 29, 10, 0, 0, tzinfo=timezone.utc)
        times = [
            (base + timedelta(minutes=0)).strftime("%Y-%m-%d %H:%M:%S UTC"),
            (base + timedelta(minutes=1)).strftime("%Y-%m-%d %H:%M:%S UTC"),
        ]
        
        result = evaluate_mobility({
            "Latitude": [40.0, 40.01],  # ~1.1km jump
            "Longitude": [-111.0, -111.01],
            "TimeUTC": times,
        })
        self.assertFalse(result.get("immobile"))


class TestEvaluateMobilitySparseData(unittest.TestCase):
    """Test behavior with sparse data (few samples)."""

    def test_sparse_with_no_movement(self):
        """Few samples with no movement = assume idle."""
        base = datetime(2025, 12, 29, 10, 0, 0, tzinfo=timezone.utc)
        times = [(base + timedelta(minutes=i)).strftime("%Y-%m-%d %H:%M:%S UTC") for i in range(3)]
        
        result = evaluate_mobility({
            "Latitude": [40.0, 40.0001, 40.0],  # tiny drift
            "Longitude": [-111.0, -111.0001, -111.0],
            "TimeUTC": times,
        })
        self.assertTrue(result.get("immobile"))

    def test_sparse_with_clear_movement(self):
        """Few samples with clear movement = not idle."""
        base = datetime(2025, 12, 29, 10, 0, 0, tzinfo=timezone.utc)
        times = [(base + timedelta(minutes=i)).strftime("%Y-%m-%d %H:%M:%S UTC") for i in range(3)]
        
        result = evaluate_mobility({
            "Latitude": [40.0, 40.005, 40.01],  # ~500m, then 1km
            "Longitude": [-111.0, -111.0, -111.0],
            "TimeUTC": times,
        })
        self.assertFalse(result.get("immobile"))

    def test_sparse_assume_not_idle_option(self):
        """Can configure to not assume idle when sparse."""
        base = datetime(2025, 12, 29, 10, 0, 0, tzinfo=timezone.utc)
        times = [(base + timedelta(minutes=i)).strftime("%Y-%m-%d %H:%M:%S UTC") for i in range(3)]
        
        result = evaluate_mobility(
            {
                "Latitude": [40.0, 40.0001, 40.0],
                "Longitude": [-111.0, -111.0001, -111.0],
                "TimeUTC": times,
            },
            assume_immobile_when_sparse=False,
        )
        # With assume_immobile_when_sparse=False, should not mark idle
        self.assertFalse(result.get("immobile"))


class TestEvaluateMobilityDiagnostics(unittest.TestCase):
    """Test diagnostic information returned."""

    def test_returns_samples_count(self):
        """Returns sample count."""
        result = evaluate_mobility({
            "Latitude": [40.0, 40.001, 40.002],
            "Longitude": [-111.0, -111.001, -111.002],
            "TimeUTC": ["2025-12-29 10:00:00 UTC", "2025-12-29 10:01:00 UTC", "2025-12-29 10:02:00 UTC"],
        })
        self.assertIn("samples", result)

    def test_returns_stable_position_when_parked(self):
        """Returns stable_lat/stable_lon when parked."""
        base = datetime(2025, 12, 29, 10, 0, 0, tzinfo=timezone.utc)
        times = [(base + timedelta(minutes=i)).strftime("%Y-%m-%d %H:%M:%S UTC") for i in range(15)]
        
        result = evaluate_mobility({
            "Latitude": [40.0] * 15,
            "Longitude": [-111.0] * 15,
            "TimeUTC": times,
        })
        self.assertTrue(result.get("immobile"))
        self.assertAlmostEqual(result.get("stable_lat"), 40.0, places=3)
        self.assertAlmostEqual(result.get("stable_lon"), -111.0, places=3)


class TestEvaluateMobilityEdgeCases(unittest.TestCase):
    """Test edge cases."""

    def test_invalid_coordinates(self):
        """Invalid coordinates are skipped."""
        result = evaluate_mobility({
            "Latitude": ["invalid", 40.0],
            "Longitude": [-111.0, -111.0],
            "TimeUTC": ["2025-12-29 10:00:00 UTC", "2025-12-29 10:01:00 UTC"],
        })
        # Should handle gracefully
        self.assertIn("samples", result)

    def test_mismatched_lengths(self):
        """Mismatched list lengths handled gracefully."""
        result = evaluate_mobility({
            "Latitude": [40.0, 40.001],
            "Longitude": [-111.0],  # Only one longitude
            "TimeUTC": ["2025-12-29 10:00:00 UTC"],
        })
        # Should handle gracefully (uses min length)
        self.assertIn("samples", result)

    def test_no_timestamps(self):
        """Works without timestamps."""
        result = evaluate_mobility({
            "Latitude": [40.0] * 10,
            "Longitude": [-111.0] * 10,
        })
        # Should still evaluate based on positions
        self.assertIn("immobile", result)


if __name__ == "__main__":
    unittest.main()
