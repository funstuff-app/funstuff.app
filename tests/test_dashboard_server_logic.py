import unittest
import threading
import time
import os
import json
import tempfile
from dashboard_server import AppState, update_app_state_with_new_data, _scrub_broken_mobile_sensors

class TestDashboardServerLogic(unittest.TestCase):
    def setUp(self):
        self.app_state = AppState(
            lock=threading.Lock(),
            state={"mobile": [], "fixed": [], "meta": {}},
            persistent_mobile={}
        )

    def test_update_app_state_initial_load(self):
        st = {
            "mobile": [
                {
                    "id": "BUS1",
                    "trail": [
                        {"lat": 40.0, "lon": -111.0, "t": "2025-12-23 10:00:00 UTC"}
                    ]
                }
            ]
        }
        now = time.time()
        update_app_state_with_new_data(self.app_state, st, now=now)
        
        self.assertEqual(len(self.app_state.state["mobile"]), 1)
        m = self.app_state.state["mobile"][0]
        self.assertEqual(m["id"], "BUS1")
        self.assertEqual(m["_last_seen"], now)
        # Initial trail points should be marked moving (m: 1)
        self.assertEqual(m["trail"][0]["m"], 1)

    def test_update_app_state_trail_merging(self):
        # Initial state
        st1 = {
            "mobile": [
                {
                    "id": "BUS1",
                    "trail": [
                        {"lat": 40.0, "lon": -111.0, "t": "2025-12-23 10:00:00 UTC"}
                    ]
                }
            ]
        }
        update_app_state_with_new_data(self.app_state, st1, now=time.time())
        
        # Second update with new trail point
        st2 = {
            "mobile": [
                {
                    "id": "BUS1",
                    "trail": [
                        {"lat": 40.001, "lon": -111.001, "t": "2025-12-23 10:01:00 UTC"}
                    ]
                }
            ]
        }
        update_app_state_with_new_data(self.app_state, st2, now=time.time())
        
        m = self.app_state.state["mobile"][0]
        self.assertEqual(len(m["trail"]), 2)
        self.assertEqual(m["trail"][0]["t"], "2025-12-23 10:00:00 UTC")
        self.assertEqual(m["trail"][1]["t"], "2025-12-23 10:01:00 UTC")

    def test_update_app_state_ghosting(self):
        # Initial state
        st1 = {
            "mobile": [
                {"id": "BUS1", "trail": []}
            ]
        }
        update_app_state_with_new_data(self.app_state, st1, now=time.time())
        
        # Second update without BUS1
        st2 = {"mobile": []}
        update_app_state_with_new_data(self.app_state, st2, now=time.time())
        
        self.assertEqual(len(self.app_state.state["mobile"]), 1)
        m = self.app_state.state["mobile"][0]
        self.assertEqual(m["id"], "BUS1")
        self.assertTrue(m["ghosted"])

    def test_update_app_state_cleanup_stale(self):
        # Initial state
        st1 = {
            "mobile": [
                {"id": "BUS1", "trail": []}
            ]
        }
        t0 = time.time()
        update_app_state_with_new_data(self.app_state, st1, now=t0)
        
        # Second update more than 1 hour later without BUS1
        st2 = {"mobile": []}
        update_app_state_with_new_data(self.app_state, st2, now=t0 + 3601)
        
        self.assertEqual(len(self.app_state.state["mobile"]), 0)
        self.assertEqual(len(self.app_state.persistent_mobile), 0)

    def test_apply_sensor_names_inplace(self):
        from dashboard_server import apply_sensor_names_inplace
        state = {
            "mobile": [{"id": "BUS1", "name": ""}],
            "fixed": [{"id": "FIXED1", "name": "Old Name"}]
        }
        custom_names = {"BUS1": "New Bus Name", "FIXED1": "New Fixed Name"}
        changed = apply_sensor_names_inplace(state, custom_names)
        
        self.assertTrue(changed)
        self.assertEqual(state["mobile"][0]["name"], "New Bus Name")
        self.assertEqual(state["fixed"][0]["name"], "New Fixed Name")

    def test_lazy_road_matching_backfill_today(self):
        # Build a tiny straight-line road graph along lon axis.
        # Nodes: (40.0, -111.0) -> (40.0, -110.99)
        road_obj = {
            "version": 1,
            "nodes": [[40.0, -111.0], [40.0, -110.99]],
            "adj": [[[1, 900.0]], [[0, 900.0]]],
        }

        with tempfile.TemporaryDirectory() as td:
            p = os.path.join(td, "g.json")
            with open(p, "w", encoding="utf-8") as f:
                json.dump(road_obj, f)

            old_env = os.environ.get("MOBILEAIR_ROAD_GRAPH")
            os.environ["MOBILEAIR_ROAD_GRAPH"] = p
            try:
                # Reset app_state to force road graph reload
                self.app_state = AppState(
                    lock=threading.Lock(),
                    state={"mobile": [], "fixed": [], "meta": {}},
                    persistent_mobile={}
                )
                
                # Point that is OFF the road (lat=40.0003 instead of 40.0)
                # Road is at lat=40.0, so this point should snap to lat=40.0
                # 0.0003 degrees ~= 33m, which is within the 50m snap distance
                st1 = {
                    "mobile": [
                        {
                            "id": "BUS1",
                            "trail": [
                                {"lat": 40.0003, "lon": -111.0, "t": "2026-01-09 15:00:00 UTC", "m": 1},
                            ],
                        }
                    ]
                }
                update_app_state_with_new_data(self.app_state, st1, now=time.time())
                m = self.app_state.state["mobile"][0]
                
                # The point should have been snapped to lat=40.0 (on the road)
                trail_pt = m["trail"][0]
                self.assertAlmostEqual(trail_pt["lat"], 40.0, places=4, 
                    msg=f"Point should be snapped to road at lat=40.0, got {trail_pt['lat']}")
                
            finally:
                if old_env is None:
                    os.environ.pop("MOBILEAIR_ROAD_GRAPH", None)
                else:
                    os.environ["MOBILEAIR_ROAD_GRAPH"] = old_env

    def test_road_snap_on_new_points(self):
        """Test that NEW points appended to existing trails are also snapped."""
        road_obj = {
            "version": 1,
            "nodes": [[40.0, -111.0], [40.0, -110.99]],
            "adj": [[[1, 900.0]], [[0, 900.0]]],
        }

        with tempfile.TemporaryDirectory() as td:
            p = os.path.join(td, "g.json")
            with open(p, "w", encoding="utf-8") as f:
                json.dump(road_obj, f)

            old_env = os.environ.get("MOBILEAIR_ROAD_GRAPH")
            os.environ["MOBILEAIR_ROAD_GRAPH"] = p
            try:
                self.app_state = AppState(
                    lock=threading.Lock(),
                    state={"mobile": [], "fixed": [], "meta": {}},
                    persistent_mobile={}
                )
                
                # Initial load with point ON the road
                st1 = {
                    "mobile": [
                        {
                            "id": "BUS1",
                            "trail": [
                                {"lat": 40.0, "lon": -111.0, "t": "2026-01-09 15:00:00 UTC", "m": 1},
                            ],
                        }
                    ]
                }
                update_app_state_with_new_data(self.app_state, st1, now=time.time())
                
                # Second update with NEW point OFF the road
                # 0.0003 degrees ~= 33m, within 50m snap distance
                st2 = {
                    "mobile": [
                        {
                            "id": "BUS1",
                            "trail": [
                                {"lat": 40.0003, "lon": -110.995, "t": "2026-01-09 15:10:00 UTC", "m": 1},
                            ],
                        }
                    ]
                }
                update_app_state_with_new_data(self.app_state, st2, now=time.time())
                m = self.app_state.state["mobile"][0]
                
                # Trail should now have 2 points
                self.assertEqual(len(m["trail"]), 2)
                
                # The NEW point should also be snapped to lat=40.0
                new_pt = m["trail"][1]
                self.assertAlmostEqual(new_pt["lat"], 40.0, places=4,
                    msg=f"New point should be snapped to road at lat=40.0, got {new_pt['lat']}")
                
            finally:
                if old_env is None:
                    os.environ.pop("MOBILEAIR_ROAD_GRAPH", None)
                else:
                    os.environ["MOBILEAIR_ROAD_GRAPH"] = old_env


class TestScrubBrokenMobileSensors(unittest.TestCase):
    """Tests for _scrub_broken_mobile_sensors peer-based outlier removal."""

    def _make_sensor(self, sid, pm25=None, pm10=None, ozne=None, ghosted=False):
        readings = {}
        if pm25 is not None:
            readings["PM25"] = {"value": pm25, "color": "#fff"}
        if pm10 is not None:
            readings["PM10"] = {"value": pm10, "color": "#fff"}
        if ozne is not None:
            readings["OZNE"] = {"value": ozne, "color": "#fff"}
        return {"id": sid, "readings": readings, "ghosted": ghosted, "trail": []}

    def test_broken_sensor_removed(self):
        """A sensor with ALL pollutants wildly elevated (including ozone) is removed."""
        mobiles = [
            self._make_sensor("BUS06", pm25=1.5, pm10=10.0, ozne=26.4),
            self._make_sensor("BUS08", pm25=1.7, pm10=18.0, ozne=35.5),
            self._make_sensor("BUS10", pm25=1.3, pm10=21.5, ozne=31.3),
            self._make_sensor("BUS11", pm25=1.0, pm10=10.6, ozne=35.5),
            self._make_sensor("BUS13", pm25=3.1, pm10=54.3, ozne=8.5),
            # BUS07: broken — PM AND ozone all wildly higher than peers
            self._make_sensor("BUS07", pm25=95.8, pm10=608.3, ozne=589.6),
        ]
        broken = _scrub_broken_mobile_sensors(mobiles)
        self.assertIn("BUS07", broken)
        remaining_ids = {m["id"] for m in mobiles}
        self.assertNotIn("BUS07", remaining_ids)

    def test_normal_sensors_not_removed(self):
        """All-normal sensors should all remain."""
        mobiles = [
            self._make_sensor("BUS06", pm25=1.5, pm10=10.0, ozne=26.4),
            self._make_sensor("BUS08", pm25=1.7, pm10=18.0, ozne=35.5),
            self._make_sensor("BUS10", pm25=1.3, pm10=21.5, ozne=31.3),
            self._make_sensor("BUS11", pm25=1.0, pm10=10.6, ozne=35.5),
        ]
        broken = _scrub_broken_mobile_sensors(mobiles)
        self.assertEqual(broken, set())
        self.assertEqual(len(mobiles), 4)

    def test_too_few_peers_no_removal(self):
        """With fewer than min_peers+1 sensors, nothing is removed."""
        mobiles = [
            self._make_sensor("BUS06", pm25=1.5, pm10=10.0, ozne=26.4),
            self._make_sensor("BUS07", pm25=95.8, pm10=608.3, ozne=589.6),
        ]
        broken = _scrub_broken_mobile_sensors(mobiles)
        self.assertEqual(broken, set())
        self.assertEqual(len(mobiles), 2)

    def test_legitimate_hotspot_not_removed(self):
        """A sensor 2-3x peers should NOT be removed (could be real)."""
        mobiles = [
            self._make_sensor("BUS06", pm25=5.0, pm10=20.0, ozne=30.0),
            self._make_sensor("BUS08", pm25=6.0, pm10=25.0, ozne=35.0),
            self._make_sensor("BUS10", pm25=4.0, pm10=18.0, ozne=28.0),
            self._make_sensor("BUS11", pm25=5.5, pm10=22.0, ozne=32.0),
            # Elevated but plausible — near a construction site, say
            self._make_sensor("BUS07", pm25=15.0, pm10=60.0, ozne=70.0),
        ]
        broken = _scrub_broken_mobile_sensors(mobiles)
        self.assertEqual(broken, set())
        self.assertEqual(len(mobiles), 5)

    def test_ozone_only_spike_removed(self):
        """Ozone can't spike from local sources — high OZNE alone means broken sensor."""
        mobiles = [
            self._make_sensor("BUS06", pm25=1.5, pm10=10.0, ozne=26.0),
            self._make_sensor("BUS08", pm25=1.7, pm10=18.0, ozne=35.0),
            self._make_sensor("BUS10", pm25=1.3, pm10=21.0, ozne=31.0),
            self._make_sensor("BUS11", pm25=1.0, pm10=10.0, ozne=35.0),
            # Only ozone is broken, PM is normal
            self._make_sensor("BUS07", pm25=2.0, pm10=15.0, ozne=500.0),
        ]
        broken = _scrub_broken_mobile_sensors(mobiles)
        self.assertIn("BUS07", broken)
        remaining_ids = {m["id"] for m in mobiles}
        self.assertNotIn("BUS07", remaining_ids)

    def test_broken_sensor_evicted_from_persistent_state(self):
        """Integration: broken sensor is removed from both mobile list and persistent_mobile."""
        app_state = AppState(
            lock=threading.Lock(),
            state={"mobile": [], "fixed": [], "meta": {}},
            persistent_mobile={},
        )
        st = {
            "mobile": [
                {"id": "BUS06", "trail": [{"lat": 40.0, "lon": -111.0, "t": "2026-02-09 10:00:00 UTC"}],
                 "readings": {"PM25": {"value": 1.5}, "PM10": {"value": 10.0}, "OZNE": {"value": 26.0}}},
                {"id": "BUS08", "trail": [{"lat": 40.01, "lon": -111.01, "t": "2026-02-09 10:00:00 UTC"}],
                 "readings": {"PM25": {"value": 1.7}, "PM10": {"value": 18.0}, "OZNE": {"value": 35.0}}},
                {"id": "BUS10", "trail": [{"lat": 40.02, "lon": -111.02, "t": "2026-02-09 10:00:00 UTC"}],
                 "readings": {"PM25": {"value": 1.3}, "PM10": {"value": 21.0}, "OZNE": {"value": 31.0}}},
                {"id": "BUS11", "trail": [{"lat": 40.03, "lon": -111.03, "t": "2026-02-09 10:00:00 UTC"}],
                 "readings": {"PM25": {"value": 1.0}, "PM10": {"value": 10.0}, "OZNE": {"value": 35.0}}},
                {"id": "BUS07", "trail": [{"lat": 40.04, "lon": -111.04, "t": "2026-02-09 10:00:00 UTC"}],
                 "readings": {"PM25": {"value": 95.8}, "PM10": {"value": 608.0}, "OZNE": {"value": 589.0}}},
            ],
        }
        update_app_state_with_new_data(app_state, st)
        mobile_ids = {m["id"] for m in app_state.state["mobile"]}
        self.assertNotIn("BUS07", mobile_ids)
        self.assertNotIn("BUS07", app_state.persistent_mobile)
        self.assertIn("BUS06", mobile_ids)


    def test_high_particles_normal_ozone_not_removed(self):
        """High PM with normal ozone = real local source (train, dust). Keep it."""
        mobiles = [
            self._make_sensor("TRX01", pm25=1.4, pm10=14.8, ozne=39.8),
            self._make_sensor("BUS12", pm25=2.1, pm10=18.7, ozne=26.9),
            self._make_sensor("BUS11", pm25=0.7, pm10=10.2, ozne=35.3),
            self._make_sensor("TRX02", pm25=1.5, pm10=17.1, ozne=31.2),
            # High PM but ozone is normal — near a freight train / dust source
            self._make_sensor("BUS06", pm25=64.3, pm10=290.6, ozne=31.2),
            self._make_sensor("BUS07", pm25=87.6, pm10=556.1, ozne=30.3),
        ]
        broken = _scrub_broken_mobile_sensors(mobiles)
        self.assertEqual(broken, set())
        self.assertEqual(len(mobiles), 6)

    def test_multiple_broken_sensors_both_removed(self):
        """Two sensors with BOTH particles and ozone wildly elevated are removed."""
        mobiles = [
            self._make_sensor("TRX01", pm25=1.4, pm10=14.8, ozne=39.8),
            self._make_sensor("BUS12", pm25=2.1, pm10=18.7, ozne=26.9),
            self._make_sensor("BUS11", pm25=0.7, pm10=10.2, ozne=35.3),
            self._make_sensor("TRX02", pm25=1.5, pm10=17.1, ozne=31.2),
            # Both broken: particles AND ozone all spiked
            self._make_sensor("BUS06", pm25=64.3, pm10=290.6, ozne=550.0),
            self._make_sensor("BUS07", pm25=87.6, pm10=556.1, ozne=480.0),
        ]
        broken = _scrub_broken_mobile_sensors(mobiles)
        self.assertIn("BUS06", broken)
        self.assertIn("BUS07", broken)
        remaining_ids = {m["id"] for m in mobiles}
        self.assertNotIn("BUS06", remaining_ids)
        self.assertNotIn("BUS07", remaining_ids)
        self.assertEqual(remaining_ids, {"TRX01", "BUS12", "BUS11", "TRX02"})

    def test_extreme_pm10_only_single_sensor_removed(self):
        """A lone sensor with PM10 ≥40x median (OZNE normal) is broken hardware."""
        mobiles = [
            self._make_sensor("TRX01", pm25=1.1, pm10=10.1, ozne=18.9),
            self._make_sensor("TRX03", pm25=1.1, pm10=5.3, ozne=22.1),
            self._make_sensor("BUS08", pm25=0.9, pm10=8.3, ozne=25.0),
            self._make_sensor("BUS11", pm25=1.0, pm10=9.2, ozne=20.0),
            # TRX02: PM10=406 vs median ~8, ratio ~50x. Single outlier.
            self._make_sensor("TRX02", pm25=13.9, pm10=405.8, ozne=0.5),
        ]
        broken = _scrub_broken_mobile_sensors(mobiles)
        self.assertIn("TRX02", broken)
        remaining_ids = {m["id"] for m in mobiles}
        self.assertNotIn("TRX02", remaining_ids)


class TestGpsSpikeRemoval(unittest.TestCase):
    def setUp(self):
        self.app_state = AppState(
            lock=threading.Lock(),
            state={"mobile": [], "fixed": [], "meta": {}},
            persistent_mobile={}
        )

    def test_gps_spike_scrubbed_across_polls(self):
        """A GPS teleport that spans two polls (B arrives in poll 1, C in poll 2) gets removed."""
        st1 = {
            "mobile": [
                {
                    "id": "BUS1",
                    "trail": [
                        {"lat": 40.0, "lon": -111.0, "t": "2026-02-09 10:00:00 UTC"},
                        {"lat": 40.0001, "lon": -111.0001, "t": "2026-02-09 10:01:00 UTC"},
                        {"lat": 40.5, "lon": -111.5, "t": "2026-02-09 10:02:00 UTC"},
                    ],
                }
            ],
        }
        update_app_state_with_new_data(self.app_state, st1, now=1000.0)

        st2 = {
            "mobile": [
                {
                    "id": "BUS1",
                    "trail": [
                        {"lat": 40.0002, "lon": -111.0002, "t": "2026-02-09 10:03:00 UTC"},
                    ],
                }
            ],
        }
        update_app_state_with_new_data(self.app_state, st2, now=1001.0)

        lats = [p["lat"] for p in self.app_state.persistent_mobile["BUS1"]["trail"]]
        self.assertTrue(all(lat < 40.01 for lat in lats),
                        f"Teleport point should be removed, got lats: {lats}")

    def test_multi_poll_gps_spike(self):
        """A GPS teleport that persists for 3+ polls then returns still gets scrubbed."""
        # Poll 1: normal movement then teleport
        st1 = {
            "mobile": [{
                "id": "BUS1",
                "trail": [
                    {"lat": 40.0, "lon": -111.0, "t": "2026-02-09 10:00:00 UTC"},
                    {"lat": 40.0001, "lon": -111.0001, "t": "2026-02-09 10:01:00 UTC"},
                    # Teleport
                    {"lat": 40.5, "lon": -111.5, "t": "2026-02-09 10:02:00 UTC"},
                ],
            }],
        }
        update_app_state_with_new_data(self.app_state, st1, now=1000.0)

        # Polls 2-3: still reporting from the wrong location
        for i, minute in enumerate([3, 4], start=1):
            st = {
                "mobile": [{
                    "id": "BUS1",
                    "trail": [
                        {"lat": 40.5001 + i * 0.0001, "lon": -111.5001, "t": f"2026-02-09 10:0{minute}:00 UTC"},
                    ],
                }],
            }
            update_app_state_with_new_data(self.app_state, st, now=1000.0 + i)

        # Poll 4: returns to original position
        st_return = {
            "mobile": [{
                "id": "BUS1",
                "trail": [
                    {"lat": 40.0003, "lon": -111.0003, "t": "2026-02-09 10:05:00 UTC"},
                ],
            }],
        }
        update_app_state_with_new_data(self.app_state, st_return, now=1004.0)

        lats = [p["lat"] for p in self.app_state.persistent_mobile["BUS1"]["trail"]]
        self.assertTrue(all(lat < 40.01 for lat in lats),
                        f"Multi-poll teleport points should be removed, got lats: {lats}")


if __name__ == "__main__":
    unittest.main()

