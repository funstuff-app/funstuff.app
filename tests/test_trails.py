"""
Tests for mobileair/trails.py - Trail extraction and cleaning.
"""

import unittest
from datetime import datetime, timezone

from mobileair.trails import (
    extract_mobile_tracks,
    clean_trail,
    collapse_stationary_suffix,
)


class TestExtractMobileTracks(unittest.TestCase):
    """Test breadcrumb track extraction from mobile API JSON."""

    def test_basic_extraction(self):
        """Extract a simple sensor track."""
        mobile_json = {
            "PM25": {
                "VarUnit": "ug/m3",
                "BUS01": {
                    "Latitude": [40.0, 40.001, 40.002],
                    "Longitude": [-111.0, -111.001, -111.002],
                    "TimeUTC": [
                        "2025-12-29 10:00:00 UTC",
                        "2025-12-29 10:01:00 UTC",
                        "2025-12-29 10:02:00 UTC",
                    ],
                    "Value": ["5.0", "6.0", "7.0"],
                    "ValueColor": ["#00ff00", "#00ff00", "#00ff00"],
                },
            }
        }
        tracks = extract_mobile_tracks(mobile_json)
        self.assertIn("BUS01", tracks)
        self.assertEqual(len(tracks["BUS01"]), 3)
        self.assertEqual(tracks["BUS01"][0]["lat"], 40.0)
        self.assertEqual(tracks["BUS01"][0]["lon"], -111.0)
        self.assertIn("readings", tracks["BUS01"][0])
        self.assertIn("PM25", tracks["BUS01"][0]["readings"])

    def test_multiple_sensors(self):
        """Extract tracks for multiple sensors."""
        mobile_json = {
            "PM25": {
                "BUS01": {
                    "Latitude": [40.0],
                    "Longitude": [-111.0],
                    "TimeUTC": ["2025-12-29 10:00:00 UTC"],
                    "Value": ["5.0"],
                    "ValueColor": ["#00ff00"],
                },
                "BUS02": {
                    "Latitude": [40.1],
                    "Longitude": [-111.1],
                    "TimeUTC": ["2025-12-29 10:00:00 UTC"],
                    "Value": ["6.0"],
                    "ValueColor": ["#00ff00"],
                },
            }
        }
        tracks = extract_mobile_tracks(mobile_json)
        self.assertIn("BUS01", tracks)
        self.assertIn("BUS02", tracks)

    def test_multiple_pollutants_merged(self):
        """Tracks from multiple pollutants are merged."""
        mobile_json = {
            "PM25": {
                "BUS01": {
                    "Latitude": [40.0],
                    "Longitude": [-111.0],
                    "TimeUTC": ["2025-12-29 10:00:00 UTC"],
                    "Value": ["5.0"],
                    "ValueColor": ["#00ff00"],
                },
            },
            "OZNE": {
                "BUS01": {
                    "Latitude": [40.0],
                    "Longitude": [-111.0],
                    "TimeUTC": ["2025-12-29 10:00:00 UTC"],
                    "Value": ["35.0"],
                    "ValueColor": ["#ffff00"],
                },
            },
        }
        tracks = extract_mobile_tracks(mobile_json)
        self.assertIn("BUS01", tracks)
        self.assertEqual(len(tracks["BUS01"]), 1)
        readings = tracks["BUS01"][0]["readings"]
        self.assertIn("PM25", readings)
        self.assertIn("OZNE", readings)

    def test_skips_metadata_keys(self):
        """Skips LastUpdateUTC, VarName, VarUnit."""
        mobile_json = {
            "PM25": {
                "LastUpdateUTC": "2025-12-29 10:05:00 UTC",
                "VarName": "PM2.5 Concentration",
                "VarUnit": "ug/m3",
                "BUS01": {
                    "Latitude": [40.0],
                    "Longitude": [-111.0],
                    "TimeUTC": ["2025-12-29 10:00:00 UTC"],
                    "Value": ["5.0"],
                    "ValueColor": ["#00ff00"],
                },
            }
        }
        tracks = extract_mobile_tracks(mobile_json)
        self.assertIn("BUS01", tracks)
        self.assertNotIn("LastUpdateUTC", tracks)
        self.assertNotIn("VarName", tracks)
        self.assertNotIn("VarUnit", tracks)

    def test_respects_max_points(self):
        """Respects max_points limit."""
        mobile_json = {
            "PM25": {
                "BUS01": {
                    "Latitude": [40.0 + i * 0.001 for i in range(50)],
                    "Longitude": [-111.0 + i * 0.001 for i in range(50)],
                    "TimeUTC": [f"2025-12-29 10:{i:02d}:00 UTC" for i in range(50)],
                    "Value": [str(i) for i in range(50)],
                    "ValueColor": ["#00ff00"] * 50,
                },
            }
        }
        tracks = extract_mobile_tracks(mobile_json, max_points=20)
        self.assertEqual(len(tracks["BUS01"]), 20)
        # Should keep the most recent (last) points
        self.assertEqual(tracks["BUS01"][-1]["t"], "2025-12-29 10:49:00 UTC")

    def test_empty_input(self):
        """Empty input returns empty dict."""
        self.assertEqual(extract_mobile_tracks({}), {})
        self.assertEqual(extract_mobile_tracks(None), {})

    def test_dedupe_consecutive_same_points(self):
        """Consecutive identical points are deduplicated."""
        mobile_json = {
            "PM25": {
                "BUS01": {
                    "Latitude": [40.0, 40.0, 40.001],
                    "Longitude": [-111.0, -111.0, -111.001],
                    "TimeUTC": [
                        "2025-12-29 10:00:00 UTC",
                        "2025-12-29 10:00:00 UTC",  # duplicate
                        "2025-12-29 10:01:00 UTC",
                    ],
                    "Value": ["5.0", "5.0", "6.0"],
                    "ValueColor": ["#00ff00"] * 3,
                },
            }
        }
        tracks = extract_mobile_tracks(mobile_json)
        self.assertEqual(len(tracks["BUS01"]), 2)


class TestCleanTrail(unittest.TestCase):
    """Test trail cleaning (spike removal, deduplication, parking collapse)."""

    def test_empty_trail(self):
        """Empty trail returns as-is."""
        self.assertEqual(clean_trail([]), [])

    def test_single_point(self):
        """Single point returns as-is."""
        pts = [{"lat": 40.0, "lon": -111.0, "t": "2025-12-29 10:00:00 UTC"}]
        self.assertEqual(clean_trail(pts), pts)

    def test_dedup_tiny_steps(self):
        """Consecutive points within dedup_m are merged."""
        pts = [
            {"lat": 40.0, "lon": -111.0, "t": "2025-12-29 10:00:00 UTC"},
            {"lat": 40.0000001, "lon": -111.0000001, "t": "2025-12-29 10:01:00 UTC"},  # <2m
            {"lat": 40.001, "lon": -111.001, "t": "2025-12-29 10:02:00 UTC"},
        ]
        cleaned = clean_trail(pts)
        self.assertEqual(len(cleaned), 2)

    def test_spike_removal(self):
        """GPS spikes (far out and back) are removed."""
        # A-B-C pattern: B is a spike (far from A and C, but A and C are close)
        pts = [
            {"lat": 40.0, "lon": -111.0, "t": "2025-12-29 10:00:00 UTC"},
            {"lat": 40.1, "lon": -111.1, "t": "2025-12-29 10:01:00 UTC"},  # spike ~15km away
            {"lat": 40.0001, "lon": -111.0001, "t": "2025-12-29 10:02:00 UTC"},
            {"lat": 40.0002, "lon": -111.0002, "t": "2025-12-29 10:03:00 UTC"},
        ]
        cleaned = clean_trail(pts)
        lats = [p["lat"] for p in cleaned]
        self.assertNotIn(40.1, lats)

    def test_normal_movement_preserved(self):
        """Normal movement patterns are preserved."""
        pts = [
            {"lat": 40.0, "lon": -111.0, "t": "2025-12-29 10:00:00 UTC"},
            {"lat": 40.001, "lon": -111.001, "t": "2025-12-29 10:01:00 UTC"},
            {"lat": 40.002, "lon": -111.002, "t": "2025-12-29 10:02:00 UTC"},
            {"lat": 40.003, "lon": -111.003, "t": "2025-12-29 10:03:00 UTC"},
        ]
        cleaned = clean_trail(pts)
        self.assertEqual(len(cleaned), 4)


class TestCollapseStationarySuffix(unittest.TestCase):
    """Test stationary suffix collapsing for parked sensors."""

    def test_collapses_long_parked_suffix(self):
        """Many parked points collapse to a few."""
        # 20 points in same location over 20 minutes
        pts = [
            {"lat": 40.0, "lon": -111.0, "t": f"2025-12-29 10:{i:02d}:00 UTC"}
            for i in range(20)
        ]
        collapsed = collapse_stationary_suffix(
            pts,
            center_lat=40.0,
            center_lon=-111.0,
            radius_m=50.0,
            min_pts=12,
        )
        self.assertLess(len(collapsed), len(pts))
        # Should keep at least first and last
        self.assertEqual(collapsed[0]["t"], pts[0]["t"])
        self.assertEqual(collapsed[-1]["t"], pts[-1]["t"])

    def test_preserves_movement(self):
        """Movement is not collapsed when points are far from center."""
        # Points with significant movement - use center at one end
        pts = [
            {"lat": 40.0 + i * 0.01, "lon": -111.0, "t": f"2025-12-29 10:{i:02d}:00 UTC"}
            for i in range(15)
        ]
        # Center at starting point - later points are far away
        collapsed = collapse_stationary_suffix(
            pts,
            center_lat=40.0,
            center_lon=-111.0,
            radius_m=50.0,
            min_pts=10,
        )
        # Should not collapse movement since points move away from center
        self.assertEqual(len(collapsed), len(pts))

    def test_short_trail_unchanged(self):
        """Short trails (below threshold) are unchanged."""
        pts = [
            {"lat": 40.0, "lon": -111.0, "t": "2025-12-29 10:00:00 UTC"},
            {"lat": 40.0, "lon": -111.0, "t": "2025-12-29 10:01:00 UTC"},
        ]
        collapsed = collapse_stationary_suffix(
            pts,
            center_lat=40.0,
            center_lon=-111.0,
            radius_m=50.0,
            min_pts=12,
        )
        self.assertEqual(len(collapsed), len(pts))


if __name__ == "__main__":
    unittest.main()
