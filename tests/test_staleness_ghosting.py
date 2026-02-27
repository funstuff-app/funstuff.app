"""
Tests for staleness-based ghosting of mobile sensors.

When a sensor's last data point is significantly older than the API's 
last update time, it should be marked as ghosted even if the sensor
is still present in the API response.
"""

import unittest
from datetime import datetime, timezone

import sys
sys.path.insert(0, "/Users/johusha/Stuff/mobileair")

from mobileair.dashboard import normalize_state_for_dashboard


class TestStalenessGhosting(unittest.TestCase):
    """Test that sensors with stale data are properly ghosted."""

    def test_sensor_with_stale_data_should_be_ghosted(self):
        """
        BUS09 regression test: A sensor with only a few samples that are 
        almost an hour old should be marked as ghosted, not as active.
        
        This mimics the real-world scenario where BUS09 had only 3 samples
        from 21:00-21:01 UTC but the API's last update was 21:58 UTC.
        """
        # Simulated mobile data similar to what BUS09 was returning
        mobile_json = {
            "PM25": {
                "LastUpdateUTC": "2025-12-29 21:58 UTC",
                "VarName": "PM2.5 Concentration",
                "VarUnit": "ug/m3",
                # BUS09: Only 3 data points from ~1 hour ago
                "BUS09": {
                    "TimeLocal": [
                        "2025-12-29 13:59:00 MST",
                        "2025-12-29 14:00:00 MST", 
                        "2025-12-29 14:01:00 MST",
                    ],
                    "TimeUTC": [
                        "2025-12-29 20:59:00 UTC",
                        "2025-12-29 21:00:00 UTC",
                        "2025-12-29 21:01:00 UTC",
                    ],
                    "Latitude": ["40.76506", "40.76513", "40.76434"],
                    "Longitude": ["-111.90150", "-111.90462", "-111.90834"],
                    "Value": ["2.30", "2.30", "2.10"],
                    "ValueColor": ["#00CCFF", "#00CCFF", "#00CCFF"],
                },
                # BUS05: Fresh data (many points, up to current time)
                "BUS05": {
                    "TimeLocal": [f"2025-12-29 14:{i:02d}:00 MST" for i in range(50)],
                    "TimeUTC": [f"2025-12-29 21:{i:02d}:00 UTC" for i in range(50)],
                    "Latitude": [str(40.75 + i*0.001) for i in range(50)],
                    "Longitude": [str(-111.91) for i in range(50)],
                    "Value": [str(3.0) for i in range(50)],
                    "ValueColor": ["#00CCFF" for i in range(50)],
                },
            }
        }
        
        combined = {"mobile": mobile_json, "fixed": {}}
        
        result = normalize_state_for_dashboard(
            combined,
            custom_names={},
            pinned_sensors=set(),
            max_points=200,
        )
        
        mobile_sensors = result.get("mobile", [])
        
        # Find BUS09 and BUS05
        bus09 = next((s for s in mobile_sensors if s["id"] == "BUS09"), None)
        bus05 = next((s for s in mobile_sensors if s["id"] == "BUS05"), None)
        
        self.assertIsNotNone(bus09, "BUS09 should be in mobile sensors")
        self.assertIsNotNone(bus05, "BUS05 should be in mobile sensors")
        
        # BUS09 has stale data (~57 minutes old) - should be ghosted
        self.assertTrue(
            bus09.get("ghosted") or bus09.get("stale"),
            f"BUS09 should be ghosted/stale due to 57-minute data gap. Got: ghosted={bus09.get('ghosted')}, stale={bus09.get('stale')}"
        )
        
        # BUS05 has fresh data - should NOT be ghosted
        self.assertFalse(
            bus05.get("ghosted") or bus05.get("stale"),
            f"BUS05 should NOT be ghosted/stale since it has fresh data"
        )

    def test_sensor_staleness_threshold(self):
        """Sensors with data more than STALE_DATA_THRESHOLD_MINUTES old should be ghosted."""
        # Create data where sensor's last timestamp is 20 minutes behind LastUpdateUTC
        mobile_json = {
            "PM25": {
                "LastUpdateUTC": "2025-12-29 21:30 UTC",
                "BUS01": {
                    # Data from 20 minutes ago (should NOT be ghosted)
                    "TimeUTC": ["2025-12-29 21:10:00 UTC"],
                    "Latitude": ["40.76"],
                    "Longitude": ["-111.90"],
                    "Value": ["5.0"],
                    "ValueColor": ["#00CCFF"],
                },
                "BUS02": {
                    # Data from 35 minutes ago (should be ghosted with 30 min threshold)
                    "TimeUTC": ["2025-12-29 20:55:00 UTC"],
                    "Latitude": ["40.77"],
                    "Longitude": ["-111.91"],
                    "Value": ["4.0"],
                    "ValueColor": ["#00CCFF"],
                },
            }
        }
        
        combined = {"mobile": mobile_json, "fixed": {}}
        
        result = normalize_state_for_dashboard(
            combined,
            custom_names={},
            pinned_sensors=set(),
            max_points=200,
        )
        
        mobile_sensors = result.get("mobile", [])
        bus01 = next((s for s in mobile_sensors if s["id"] == "BUS01"), None)
        bus02 = next((s for s in mobile_sensors if s["id"] == "BUS02"), None)
        
        self.assertIsNotNone(bus01)
        self.assertIsNotNone(bus02)
        
        # BUS01 at 20 min should not be ghosted
        self.assertFalse(
            bus01.get("stale", False),
            "BUS01 (20 min old) should NOT be stale"
        )
        
        # BUS02 at 35 min should be ghosted 
        self.assertTrue(
            bus02.get("stale", False),
            "BUS02 (35 min old) should be stale"
        )


if __name__ == "__main__":
    unittest.main()
