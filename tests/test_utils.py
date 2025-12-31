"""
Tests for mobileair/utils.py - Pure utility functions.
"""

import unittest
import math
from datetime import datetime, timezone

from mobileair.utils import (
    parse_utc_timestamp,
    haversine_distance,
    bounding_box_distance,
    coerce_float,
    median,
)


class TestParseUtcTimestamp(unittest.TestCase):
    """Test UTC timestamp parsing from various formats."""

    def test_standard_utc_format(self):
        """Parse 'YYYY-MM-DD HH:MM:SS UTC' format."""
        dt = parse_utc_timestamp("2025-12-29 21:00:00 UTC")
        self.assertIsNotNone(dt)
        self.assertEqual(dt.year, 2025)
        self.assertEqual(dt.month, 12)
        self.assertEqual(dt.day, 29)
        self.assertEqual(dt.hour, 21)
        self.assertEqual(dt.minute, 0)
        self.assertEqual(dt.tzinfo, timezone.utc)

    def test_iso_format_with_z(self):
        """Parse ISO format with Z suffix."""
        dt = parse_utc_timestamp("2025-12-29T21:00:00Z")
        self.assertIsNotNone(dt)
        self.assertEqual(dt.year, 2025)
        self.assertEqual(dt.hour, 21)
        self.assertEqual(dt.tzinfo, timezone.utc)

    def test_iso_format_with_offset(self):
        """Parse ISO format with timezone offset."""
        dt = parse_utc_timestamp("2025-12-29T21:00:00+00:00")
        self.assertIsNotNone(dt)
        self.assertEqual(dt.hour, 21)
        self.assertEqual(dt.tzinfo, timezone.utc)

    def test_without_utc_suffix(self):
        """Parse timestamp without UTC suffix."""
        dt = parse_utc_timestamp("2025-12-29 21:00:00")
        self.assertIsNotNone(dt)
        self.assertEqual(dt.year, 2025)
        self.assertEqual(dt.hour, 21)

    def test_empty_string(self):
        """Empty string returns None."""
        self.assertIsNone(parse_utc_timestamp(""))

    def test_none_input(self):
        """None input returns None."""
        self.assertIsNone(parse_utc_timestamp(None))

    def test_invalid_format(self):
        """Invalid format returns None."""
        self.assertIsNone(parse_utc_timestamp("not a timestamp"))

    def test_whitespace_handling(self):
        """Handles extra whitespace."""
        dt = parse_utc_timestamp("  2025-12-29 21:00:00 UTC  ")
        self.assertIsNotNone(dt)
        self.assertEqual(dt.year, 2025)


class TestHaversineDistance(unittest.TestCase):
    """Test great-circle distance calculations."""

    def test_same_point(self):
        """Distance between same point is zero."""
        d = haversine_distance(40.7608, -111.8910, 40.7608, -111.8910)
        self.assertAlmostEqual(d, 0.0, places=5)

    def test_known_distance(self):
        """Test against a known distance (SLC to Provo ~70km)."""
        # Salt Lake City coordinates
        slc_lat, slc_lon = 40.7608, -111.8910
        # Provo coordinates
        provo_lat, provo_lon = 40.2338, -111.6585
        d = haversine_distance(slc_lat, slc_lon, provo_lat, provo_lon)
        # Should be approximately 60-70 km
        self.assertGreater(d, 55000)
        self.assertLess(d, 75000)

    def test_small_distance_meters(self):
        """Test small distances (GPS drift range ~50m)."""
        lat1, lon1 = 40.7608, -111.8910
        # Move ~50m north
        lat2 = lat1 + (50 / 111320.0)
        lon2 = lon1
        d = haversine_distance(lat1, lon1, lat2, lon2)
        self.assertAlmostEqual(d, 50.0, delta=2.0)

    def test_symmetric(self):
        """Distance is symmetric (A to B == B to A)."""
        lat1, lon1 = 40.7608, -111.8910
        lat2, lon2 = 40.75, -111.88
        d1 = haversine_distance(lat1, lon1, lat2, lon2)
        d2 = haversine_distance(lat2, lon2, lat1, lon1)
        self.assertAlmostEqual(d1, d2, places=5)


class TestBoundingBoxDistance(unittest.TestCase):
    """Test bounding box diagonal distance calculation."""

    def test_empty_list(self):
        """Empty list returns 0."""
        self.assertEqual(bounding_box_distance([]), 0.0)

    def test_single_point(self):
        """Single point returns 0."""
        coords = [(40.7608, -111.8910, None)]
        self.assertEqual(bounding_box_distance(coords), 0.0)

    def test_two_points(self):
        """Two points returns their distance."""
        coords = [
            (40.7608, -111.8910, None),
            (40.7618, -111.8920, None),
        ]
        d = bounding_box_distance(coords)
        self.assertGreater(d, 0.0)

    def test_cluster_of_points(self):
        """Cluster should have small bounding box."""
        # All points within ~50m
        base_lat, base_lon = 40.7608, -111.8910
        coords = [
            (base_lat, base_lon, None),
            (base_lat + 0.0001, base_lon + 0.0001, None),
            (base_lat - 0.0001, base_lon - 0.0001, None),
        ]
        d = bounding_box_distance(coords)
        self.assertLess(d, 100.0)


class TestCoerceFloat(unittest.TestCase):
    """Test safe float coercion."""

    def test_int_to_float(self):
        """Integer converts to float."""
        self.assertEqual(coerce_float(42), 42.0)

    def test_string_to_float(self):
        """Numeric string converts to float."""
        self.assertEqual(coerce_float("3.14"), 3.14)

    def test_negative_string(self):
        """Negative string converts."""
        self.assertEqual(coerce_float("-5.5"), -5.5)

    def test_none_returns_none(self):
        """None returns None."""
        self.assertIsNone(coerce_float(None))

    def test_invalid_string_returns_none(self):
        """Invalid string returns None."""
        self.assertIsNone(coerce_float("not a number"))

    def test_empty_string_returns_none(self):
        """Empty string returns None."""
        self.assertIsNone(coerce_float(""))

    def test_list_returns_none(self):
        """List returns None."""
        self.assertIsNone(coerce_float([1, 2, 3]))


class TestMedian(unittest.TestCase):
    """Test median calculation."""

    def test_empty_list(self):
        """Empty list returns None."""
        self.assertIsNone(median([]))

    def test_single_element(self):
        """Single element is the median."""
        self.assertEqual(median([5.0]), 5.0)

    def test_odd_count(self):
        """Odd count returns middle element."""
        self.assertEqual(median([1.0, 3.0, 2.0]), 2.0)

    def test_even_count(self):
        """Even count returns average of two middle elements."""
        self.assertEqual(median([1.0, 2.0, 3.0, 4.0]), 2.5)

    def test_unsorted_input(self):
        """Works with unsorted input."""
        self.assertEqual(median([5.0, 1.0, 3.0]), 3.0)

    def test_all_same(self):
        """All same values returns that value."""
        self.assertEqual(median([7.0, 7.0, 7.0, 7.0]), 7.0)


if __name__ == "__main__":
    unittest.main()
