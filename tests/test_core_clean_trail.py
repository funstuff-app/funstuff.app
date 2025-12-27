import unittest
from mobileair_core import normalize_state_for_dashboard
import time

class TestCleanTrail(unittest.TestCase):
    def setUp(self):
        self.data_dir = "/tmp"
        self.mobile_url = "http://mobile.test"
        self.fixed_url = "http://fixed.test"

    def _get_trail(self, lats, lons, times):
        combined = {
            "mobile": {
                "PM25": {
                    "BUS1": {
                        "Latitude": lats,
                        "Longitude": lons,
                        "Value": ["10"] * len(lats),
                        "ValueColor": ["#00ff00"] * len(lats),
                        "TimeUTC": times,
                    }
                }
            },
            "fixed": {}
        }
        st = normalize_state_for_dashboard(
            combined,
            mobile_url=self.mobile_url,
            fixed_url=self.fixed_url,
            data_dir=self.data_dir
        )
        return st["mobile"][0]["trail"]

    def test_dedup_consecutive_points(self):
        # Two points very close to each other should be deduped
        lats = [40.0, 40.0000001, 40.001]
        lons = [-111.0, -111.0000001, -111.001]
        times = ["2025-12-23 10:00:00 UTC", "2025-12-23 10:01:00 UTC", "2025-12-23 10:02:00 UTC"]
        trail = self._get_trail(lats, lons, times)
        # Point 1 and 2 are almost identical, should be deduped
        self.assertEqual(len(trail), 2)
        self.assertEqual(trail[0]["lat"], 40.0)
        self.assertEqual(trail[1]["lat"], 40.001)

    def test_spike_scrubbing_abc(self):
        # A-B-C spike where B is far away but A and C are close
        lats = [40.0, 40.1, 40.0001, 40.0002]
        lons = [-111.0, -111.1, -111.0001, -111.0002]
        times = ["2025-12-23 10:00:00 UTC", "2025-12-23 10:01:00 UTC", "2025-12-23 10:02:00 UTC", "2025-12-23 10:03:00 UTC"]
        # Need at least 4 points for spike scrubbing to trigger in some paths, 
        # but let's see if 3 points A-B-C get scrubbed if we have 4 total.
        trail = self._get_trail(lats, lons, times)
        # 40.1, -111.1 is far (~15km), should be scrubbed
        lats_out = [p["lat"] for p in trail]
        self.assertNotIn(40.1, lats_out)

    def test_parked_collapse(self):
        # Many points in the same spot should be collapsed into one if they span enough time
        # Need at least parked_min_pts (12) points
        lats = [40.0] * 20
        lons = [-111.0] * 20
        # Times spanning more than parked_min_span_s (60s)
        times = [f"2025-12-23 10:{i:02d}:00 UTC" for i in range(20)]
        trail = self._get_trail(lats, lons, times)
        # Should be collapsed
        self.assertLess(len(trail), 10)

if __name__ == "__main__":
    unittest.main()

