import unittest
import threading
import time
import os
import json
import tempfile
from dashboard_server import AppState, update_app_state_with_new_data

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

if __name__ == "__main__":
    unittest.main()

