"""Regression tests for daily-snapshot persistence gates.

During the Jul 8-10 2026 mobile-feed outage, save_today_snapshot's
mobile-only gate ("fewer than 10 trail points") blocked ALL snapshot saves
even though fixed/AirNow/PurpleAir data kept flowing, freezing Select Day
at the last pre-outage state.  These tests pin the fixed behavior:

- fixed data alone is enough to save (mobile outage can't block persistence)
- a truly empty boot state is still rejected
- mobile-rich saves keep working as before
- a fixed-only snapshot still seeds PurpleAir sensors and fixed history
  on boot (load_today_snapshot must not bail out when there are no mobiles)
"""

import unittest
import threading
import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from dashboard_server import (
    AppState,
    _MOUNTAIN_TZ,
    load_snapshot,
    load_today_snapshot,
    save_snapshot,
    save_today_snapshot,
)


def _today_mt() -> str:
    return datetime.now(_MOUNTAIN_TZ).strftime("%Y-%m-%d")


def _ts_today(hour_mt: int) -> str:
    """UTC timestamp string for hour_mt o'clock Mountain time today.

    Hours in [5, 24) stay inside both snapshot windows (midnight-midnight MT
    for fixed history, 5 AM - 5 AM MT for trails) regardless of when the
    test runs, so fixtures survive the save-time trimming.
    """
    dt = datetime.now(_MOUNTAIN_TZ).replace(
        hour=hour_mt, minute=0, second=0, microsecond=0)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def _fixed_sensor(sid: str = "UUPYA", value: float = 579.0) -> dict:
    """An AirNow-style fixed sensor with a real reading (outage shape)."""
    return {
        "id": sid,
        "name": "Farmington Bay",
        "lat": 40.98,
        "lon": -111.93,
        "readings": {
            "PM10": {
                "value": value,
                "history": [11.0, value],
                "history_times": [_ts_today(5), _ts_today(6)],
                "history_colors": ["green", "red"],
            }
        },
    }


def _pa_sensor(sensor_index: int = 12345, pm25: float = 42.0) -> dict:
    return {
        "id": f"PA_{sensor_index}",
        "name": "Rose Park",
        "lat": 40.79,
        "lon": -111.93,
        "purpleair": True,
        "last_seen": 1751980000,
        "readings": {
            "PM25": {
                "value": pm25,
                "history": [40.0, pm25],
                "history_times": [_ts_today(5), _ts_today(6)],
                "history_colors": ["yellow", "yellow"],
            }
        },
    }


def _mobile_sensor(sid: str = "BUS1", n_points: int = 12) -> dict:
    trail = [
        {"lat": 40.0 + i * 1e-4, "lon": -111.0, "t": _ts_today(6), "m": 1}
        for i in range(n_points)
    ]
    return {"id": sid, "trail": trail}


def _make_app_state(mobile: list, fixed: list) -> AppState:
    state = {"mobile": mobile, "fixed": fixed, "meta": {}}
    return AppState(
        lock=threading.Lock(),
        state=state,
        persistent_mobile={},
        cached_json_bytes=json.dumps(state).encode("utf-8"),
    )


class TestSnapshotSaveGate(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def _snapshot_path(self) -> Path:
        return self.data_dir / "snapshots" / f"{_today_mt()}.json"

    def test_fixed_only_state_saves(self):
        # Outage shape: mobile feed dead (no mobiles), fixed data flowing.
        app_state = _make_app_state(mobile=[], fixed=[_fixed_sensor()])
        self.assertTrue(save_today_snapshot(app_state, self.data_dir))
        self.assertTrue(self._snapshot_path().exists())

        snap = load_snapshot(self.data_dir, _today_mt())
        self.assertEqual(snap["mobile"], [])
        self.assertEqual(snap["fixed"][0]["id"], "UUPYA")
        self.assertEqual(snap["fixed"][0]["readings"]["PM10"]["value"], 579.0)
        # Today's history survives the save-time trim
        self.assertEqual(
            snap["fixed"][0]["readings"]["PM10"]["history"], [11.0, 579.0])

    def test_fixed_data_with_stalled_mobiles_saves(self):
        # Outage variant: mobile sensors still listed but frozen below the
        # old 10-point gate; fixed data must still be persisted.
        app_state = _make_app_state(
            mobile=[_mobile_sensor(n_points=3)], fixed=[_fixed_sensor()])
        self.assertTrue(save_today_snapshot(app_state, self.data_dir))
        self.assertTrue(self._snapshot_path().exists())

    def test_truly_empty_state_not_saved(self):
        app_state = _make_app_state(mobile=[], fixed=[])
        self.assertFalse(save_today_snapshot(app_state, self.data_dir))
        self.assertFalse(self._snapshot_path().exists())

    def test_fixed_without_reading_values_not_saved(self):
        # Boot skeleton: fixed sensors exist but carry no actual values yet.
        fixed = [
            {"id": "A1", "readings": {}},
            {"id": "A2", "readings": {"PM10": {"value": None}}},
        ]
        app_state = _make_app_state(mobile=[], fixed=fixed)
        self.assertFalse(save_today_snapshot(app_state, self.data_dir))
        self.assertFalse(self._snapshot_path().exists())

    def test_mobile_rich_state_still_saves(self):
        app_state = _make_app_state(
            mobile=[_mobile_sensor(n_points=12)], fixed=[])
        self.assertTrue(save_today_snapshot(app_state, self.data_dir))
        self.assertTrue(self._snapshot_path().exists())

    def test_sparse_mobile_without_fixed_still_rejected(self):
        app_state = _make_app_state(
            mobile=[_mobile_sensor(n_points=3)], fixed=[])
        self.assertFalse(save_today_snapshot(app_state, self.data_dir))
        self.assertFalse(self._snapshot_path().exists())


class TestFixedOnlySnapshotLoad(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def _boot_app_state(self) -> AppState:
        return AppState(
            lock=threading.Lock(),
            state={"mobile": [], "fixed": [], "meta": {}},
            persistent_mobile={},
        )

    def test_missing_snapshot_returns_false(self):
        self.assertFalse(load_today_snapshot(self._boot_app_state(), self.data_dir))

    def test_fixed_only_snapshot_seeds_purpleair_and_history(self):
        state = {
            "mobile": [],
            "fixed": [_pa_sensor(), _fixed_sensor()],
            "meta": {},
        }
        save_snapshot(self.data_dir, _today_mt(), state)

        app_state = self._boot_app_state()
        self.assertTrue(load_today_snapshot(app_state, self.data_dir))

        # PurpleAir sensors seeded despite zero mobiles in the snapshot
        self.assertEqual(len(app_state.purpleair_sensors), 1)
        pa = app_state.purpleair_sensors[0]
        self.assertEqual(pa["sensor_index"], 12345)
        self.assertEqual(pa["pm2.5"], 42.0)

        # Fixed history backfilled for both sensors
        self.assertIn("PA_12345", app_state.fixed_history)
        self.assertIn("UUPYA", app_state.fixed_history)
        self.assertEqual(
            [e["val"] for e in app_state.fixed_history["UUPYA"]["PM10"]],
            ["11.0", "579.0"],
        )

        self.assertEqual(app_state.persistent_mobile, {})

    def test_outage_roundtrip_save_then_boot_load(self):
        # The full outage sequence: fixed-only save, restart, boot load.
        app_state = _make_app_state(mobile=[], fixed=[_pa_sensor()])
        self.assertTrue(save_today_snapshot(app_state, self.data_dir))

        booted = self._boot_app_state()
        self.assertTrue(load_today_snapshot(booted, self.data_dir))
        self.assertEqual(len(booted.purpleair_sensors), 1)
        self.assertIn("PA_12345", booted.fixed_history)


if __name__ == "__main__":
    unittest.main()
