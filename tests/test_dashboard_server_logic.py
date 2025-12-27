import unittest
import threading
import time
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

if __name__ == "__main__":
    unittest.main()

