"""
Tests for mobileair/outliers.py - Spatial outlier detection.
"""

import unittest

from mobileair.outliers import detect_spatial_outliers


class TestDetectSpatialOutliersBasic(unittest.TestCase):
    """Test basic spatial outlier detection scenarios."""

    def test_empty_input(self):
        """Empty input returns empty set."""
        result = detect_spatial_outliers([])
        self.assertEqual(result, set())

    def test_single_sensor(self):
        """Single sensor returns empty set (need neighbors)."""
        sensors = [
            {"id": "S1", "lat": 40.0, "lon": -111.0, "readings": {"PM25": {"value": 100}}}
        ]
        result = detect_spatial_outliers(sensors)
        self.assertEqual(result, set())

    def test_too_few_neighbors(self):
        """Returns empty if fewer than min_neighbors."""
        sensors = [
            {"id": "S1", "lat": 40.0, "lon": -111.0, "readings": {"PM25": {"value": 100}}},
            {"id": "S2", "lat": 40.001, "lon": -111.001, "readings": {"PM25": {"value": 30}}},
        ]
        result = detect_spatial_outliers(sensors, min_neighbors=3)
        self.assertEqual(result, set())


class TestDetectSpatialOutliersSpike(unittest.TestCase):
    """Test spike detection scenarios."""

    def test_flags_lone_spike(self):
        """Single sensor with extreme value among normal neighbors is flagged."""
        base_lat, base_lon = 40.7608, -111.8910
        sensors = [
            {"id": "N1", "lat": base_lat + 0.002, "lon": base_lon, "readings": {"PM25": {"value": 28}}},
            {"id": "N2", "lat": base_lat - 0.002, "lon": base_lon, "readings": {"PM25": {"value": 31}}},
            {"id": "N3", "lat": base_lat, "lon": base_lon + 0.002, "readings": {"PM25": {"value": 33}}},
            {"id": "N4", "lat": base_lat, "lon": base_lon - 0.002, "readings": {"PM25": {"value": 29}}},
            {"id": "SPIKE", "lat": base_lat + 0.001, "lon": base_lon + 0.001, "readings": {"PM25": {"value": 900}}},
        ]
        result = detect_spatial_outliers(sensors, min_neighbors=3)
        self.assertIn("SPIKE", result)
        # Normal sensors should not be flagged
        self.assertNotIn("N1", result)
        self.assertNotIn("N2", result)

    def test_does_not_flag_regional_event(self):
        """If all neighbors are elevated, no outlier is flagged."""
        base_lat, base_lon = 40.7608, -111.8910
        sensors = [
            {"id": f"S{i}", "lat": base_lat + (i * 0.002), "lon": base_lon - (i * 0.002), 
             "readings": {"PM25": {"value": v}}}
            for i, v in enumerate([650, 720, 810, 770, 690])
        ]
        result = detect_spatial_outliers(sensors, min_neighbors=3)
        self.assertEqual(result, set())

    def test_handles_pm2_5_key(self):
        """Handles 'PM2.5' pollutant key."""
        base_lat, base_lon = 40.7608, -111.8910
        sensors = [
            {"id": "N1", "lat": base_lat + 0.002, "lon": base_lon, "readings": {"PM2.5": {"value": 25}}},
            {"id": "N2", "lat": base_lat - 0.002, "lon": base_lon, "readings": {"PM2.5": {"value": 30}}},
            {"id": "N3", "lat": base_lat, "lon": base_lon + 0.002, "readings": {"PM2.5": {"value": 28}}},
            {"id": "N4", "lat": base_lat, "lon": base_lon - 0.002, "readings": {"PM2.5": {"value": 26}}},
            {"id": "SPIKE", "lat": base_lat, "lon": base_lon, "readings": {"PM2.5": {"value": 850}}},
        ]
        result = detect_spatial_outliers(sensors, pollutant_keys=("PM2.5", "PM25"), min_neighbors=3)
        self.assertIn("SPIKE", result)


class TestDetectSpatialOutliersExpand(unittest.TestCase):
    """Test radius expansion for sparse areas."""

    def test_expands_radius_in_sparse_area(self):
        """Expands search radius when neighbors are far away."""
        base_lat, base_lon = 40.7608, -111.8910
        # Neighbors are ~40km away (0.4 degrees)
        sensors = [
            {"id": "A", "lat": base_lat + 0.40, "lon": base_lon, "readings": {"PM25": {"value": 18}}},
            {"id": "B", "lat": base_lat, "lon": base_lon + 0.40, "readings": {"PM25": {"value": 22}}},
            {"id": "C", "lat": base_lat - 0.35, "lon": base_lon - 0.10, "readings": {"PM25": {"value": 25}}},
            {"id": "SPIKE", "lat": base_lat, "lon": base_lon, "readings": {"PM25": {"value": 900}}},
        ]
        # With small initial radius (5km), shouldn't find neighbors
        # With expanded max_radius_m (80km), should find them and flag spike
        result = detect_spatial_outliers(
            sensors,
            radius_m=5000,
            max_radius_m=80000,
            min_neighbors=3,
        )
        self.assertIn("SPIKE", result)


class TestDetectSpatialOutliersEdgeCases(unittest.TestCase):
    """Test edge cases."""

    def test_invalid_sensor_skipped(self):
        """Invalid sensor entries are skipped."""
        sensors = [
            None,
            "not a dict",
            {"id": "S1", "lat": 40.0, "lon": -111.0, "readings": {"PM25": {"value": 30}}},
            {"id": "S2", "lat": 40.001, "lon": -111.0, "readings": {"PM25": {"value": 32}}},
            {"id": "S3", "lat": 40.0, "lon": -111.001, "readings": {"PM25": {"value": 28}}},
            {"id": "S4", "lat": 40.001, "lon": -111.001, "readings": {"PM25": {"value": 31}}},
        ]
        result = detect_spatial_outliers(sensors, min_neighbors=3)
        # Should handle gracefully without errors
        self.assertIsInstance(result, set)

    def test_missing_id_skipped(self):
        """Sensors without ID are skipped."""
        sensors = [
            {"lat": 40.0, "lon": -111.0, "readings": {"PM25": {"value": 30}}},  # No ID
            {"id": "S1", "lat": 40.001, "lon": -111.0, "readings": {"PM25": {"value": 32}}},
            {"id": "S2", "lat": 40.0, "lon": -111.001, "readings": {"PM25": {"value": 28}}},
            {"id": "S3", "lat": 40.001, "lon": -111.001, "readings": {"PM25": {"value": 31}}},
        ]
        result = detect_spatial_outliers(sensors, min_neighbors=3)
        self.assertIsInstance(result, set)

    def test_missing_coords_skipped(self):
        """Sensors without coordinates are skipped."""
        sensors = [
            {"id": "S0", "readings": {"PM25": {"value": 30}}},  # No coords
            {"id": "S1", "lat": 40.001, "lon": -111.0, "readings": {"PM25": {"value": 32}}},
            {"id": "S2", "lat": 40.0, "lon": -111.001, "readings": {"PM25": {"value": 28}}},
            {"id": "S3", "lat": 40.001, "lon": -111.001, "readings": {"PM25": {"value": 31}}},
        ]
        result = detect_spatial_outliers(sensors, min_neighbors=3)
        self.assertIsInstance(result, set)

    def test_value_as_direct_number(self):
        """Handles readings where value is a direct number."""
        base_lat, base_lon = 40.7608, -111.8910
        sensors = [
            {"id": "N1", "lat": base_lat + 0.002, "lon": base_lon, "readings": {"PM25": 28}},  # Direct value
            {"id": "N2", "lat": base_lat - 0.002, "lon": base_lon, "readings": {"PM25": 31}},
            {"id": "N3", "lat": base_lat, "lon": base_lon + 0.002, "readings": {"PM25": 33}},
            {"id": "N4", "lat": base_lat, "lon": base_lon - 0.002, "readings": {"PM25": 29}},
            {"id": "SPIKE", "lat": base_lat, "lon": base_lon, "readings": {"PM25": 900}},
        ]
        result = detect_spatial_outliers(sensors, min_neighbors=3)
        self.assertIn("SPIKE", result)


if __name__ == "__main__":
    unittest.main()
