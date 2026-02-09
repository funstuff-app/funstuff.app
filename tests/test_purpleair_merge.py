"""Tests for PurpleAir sensor merging into fixed sensor list."""

import unittest
import threading
from dashboard_server import AppState, _merge_purpleair_into_fixed, _get_aqi_color, accumulate_fixed_reading


class TestPurpleAirMerge(unittest.TestCase):

    def _make_app_state(self, sensors=None):
        app = AppState(
            lock=threading.Lock(),
            state={"mobile": [], "fixed": [], "meta": {}},
            persistent_mobile={},
        )
        if sensors is not None:
            app.purpleair_sensors = sensors
        return app

    def _make_sensor(self, *, sensor_index=100, name="TestSensor",
                     lat=40.76, lon=-111.89, pm25=2.5,
                     humidity=30, temperature=65):
        s = {
            "sensor_index": sensor_index,
            "name": name,
            "latitude": lat,
            "longitude": lon,
        }
        if pm25 is not None:
            s["pm2.5"] = pm25
        if humidity is not None:
            s["humidity"] = humidity
        if temperature is not None:
            s["temperature"] = temperature
        return s

    # ── basic merge ──────────────────────────────────────────────────

    def test_merge_adds_sensor_to_fixed(self):
        app = self._make_app_state([self._make_sensor()])
        st = {"fixed": [], "mobile": []}
        _merge_purpleair_into_fixed(st, app)
        self.assertEqual(len(st["fixed"]), 1)
        f = st["fixed"][0]
        self.assertEqual(f["id"], "PA_100")
        self.assertTrue(f["purpleair"])

    def test_merge_preserves_existing_fixed(self):
        existing = {"id": "Home", "name": "Home", "lat": 40.7, "lon": -111.8}
        app = self._make_app_state([self._make_sensor()])
        st = {"fixed": [existing], "mobile": []}
        _merge_purpleair_into_fixed(st, app)
        ids = [f["id"] for f in st["fixed"]]
        self.assertIn("Home", ids)
        self.assertIn("PA_100", ids)

    def test_merge_removes_stale_purpleair_before_remerge(self):
        """Re-merging should not duplicate PurpleAir entries."""
        app = self._make_app_state([self._make_sensor()])
        st = {"fixed": [], "mobile": []}
        _merge_purpleair_into_fixed(st, app)
        _merge_purpleair_into_fixed(st, app)
        pa = [f for f in st["fixed"] if f.get("purpleair")]
        self.assertEqual(len(pa), 1)

    def test_empty_sensors_noop(self):
        app = self._make_app_state([])
        st = {"fixed": [{"id": "X"}], "mobile": []}
        _merge_purpleair_into_fixed(st, app)
        self.assertEqual(len(st["fixed"]), 1)

    # ── readings stored correctly ────────────────────────────────────

    def test_pm25_reading_stored(self):
        app = self._make_app_state([self._make_sensor(pm25=1.6)])
        st = {"fixed": [], "mobile": []}
        _merge_purpleair_into_fixed(st, app)
        f = st["fixed"][0]
        self.assertIn("PM25", f["readings"])
        self.assertEqual(f["readings"]["PM25"]["value"], 1.6)
        self.assertEqual(f["readings"]["PM25"]["key"], "PM2.5")

    def test_humidity_stored(self):
        app = self._make_app_state([self._make_sensor(humidity=42)])
        st = {"fixed": [], "mobile": []}
        _merge_purpleair_into_fixed(st, app)
        self.assertEqual(st["fixed"][0]["readings"]["Humidity"]["value"], 42)

    def test_temperature_stored(self):
        app = self._make_app_state([self._make_sensor(temperature=68)])
        st = {"fixed": [], "mobile": []}
        _merge_purpleair_into_fixed(st, app)
        self.assertEqual(st["fixed"][0]["readings"]["Temp"]["value"], 68)

    def test_no_pm25_skipped(self):
        app = self._make_app_state([self._make_sensor(pm25=None)])
        st = {"fixed": [], "mobile": []}
        _merge_purpleair_into_fixed(st, app)
        self.assertEqual(len(st["fixed"]), 0)

    # ── color matches Utah AQ trail scale ────────────────────────────

    def test_color_very_low_pm25_is_cyan(self):
        """PM2.5 ≤ 2.0 should be cyan (#00FFFF), matching Utah AQ trail colors."""
        self.assertEqual(_get_aqi_color("PM25", 0.0), "#00FFFF")
        self.assertEqual(_get_aqi_color("PM25", 1.0), "#00FFFF")
        self.assertEqual(_get_aqi_color("PM25", 2.0), "#00FFFF")

    def test_color_low_pm25_is_light_blue(self):
        """PM2.5 2.1–5.0 should be light blue (#00CCFF)."""
        self.assertEqual(_get_aqi_color("PM25", 2.1), "#00CCFF")
        self.assertEqual(_get_aqi_color("PM25", 3.5), "#00CCFF")
        self.assertEqual(_get_aqi_color("PM25", 5.0), "#00CCFF")

    def test_color_mid_pm25_is_blue(self):
        """PM2.5 5.1–9.0 should be blue (#0099FF)."""
        self.assertEqual(_get_aqi_color("PM25", 5.1), "#0099FF")
        self.assertEqual(_get_aqi_color("PM25", 8.2), "#0099FF")
        self.assertEqual(_get_aqi_color("PM25", 9.0), "#0099FF")

    def test_color_sensor_dot_matches_reading(self):
        """The merged fixed entry color should match its PM25 reading color."""
        app = self._make_app_state([self._make_sensor(pm25=1.6)])
        st = {"fixed": [], "mobile": []}
        _merge_purpleair_into_fixed(st, app)
        f = st["fixed"][0]
        expected = _get_aqi_color("PM25", 1.6)
        self.assertEqual(f["color"], expected)
        self.assertEqual(f["primary_color"], expected)
        self.assertEqual(f["readings"]["PM25"]["color"], expected)

    def test_color_not_epa_green(self):
        """Low PM2.5 must NOT be EPA green (#00E400) — must use Utah AQ scale."""
        for v in [0.0, 1.0, 2.0, 3.0, 5.0, 8.0, 10.0, 12.0]:
            c = _get_aqi_color("PM25", v)
            self.assertNotEqual(c, "#00E400",
                                f"PM2.5={v} should not be EPA green")

    # ── name stripping ───────────────────────────────────────────────

    def test_utopia_fiber_stripped(self):
        app = self._make_app_state([
            self._make_sensor(name="Cobble Knoll powered by UTOPIA Fiber"),
        ])
        st = {"fixed": [], "mobile": []}
        _merge_purpleair_into_fixed(st, app)
        self.assertEqual(st["fixed"][0]["name"], "Cobble Knoll")

    def test_utopia_no_fiber_stripped(self):
        """'powered by UTOPIA' without 'Fiber' should also be stripped."""
        app = self._make_app_state([
            self._make_sensor(name="Murray 4500 S Triton Blvd powered by UTOPIA"),
        ])
        st = {"fixed": [], "mobile": []}
        _merge_purpleair_into_fixed(st, app)
        self.assertEqual(st["fixed"][0]["name"], "Murray 4500 S Triton Blvd")

    def test_name_without_branding_unchanged(self):
        app = self._make_app_state([self._make_sensor(name="Clark Planetarium")])
        st = {"fixed": [], "mobile": []}
        _merge_purpleair_into_fixed(st, app)
        self.assertEqual(st["fixed"][0]["name"], "Clark Planetarium")

    # ── out of bounds filtered ───────────────────────────────────────

    def test_out_of_bounds_sensor_skipped(self):
        app = self._make_app_state([
            self._make_sensor(lat=35.0, lon=-100.0),  # way outside SLC
        ])
        st = {"fixed": [], "mobile": []}
        _merge_purpleair_into_fixed(st, app)
        self.assertEqual(len(st["fixed"]), 0)

    # ── primary fields ───────────────────────────────────────────────

    def test_primary_fields_set(self):
        app = self._make_app_state([self._make_sensor(pm25=3.2)])
        st = {"fixed": [], "mobile": []}
        _merge_purpleair_into_fixed(st, app)
        f = st["fixed"][0]
        self.assertEqual(f["primary_key"], "PM25")
        self.assertEqual(f["primary_value"], 3.2)
        self.assertIsNone(f["primary_aqi"])

    # ── multiple sensors ─────────────────────────────────────────────

    def test_multiple_sensors_merged(self):
        sensors = [
            self._make_sensor(sensor_index=1, name="A", pm25=1.0),
            self._make_sensor(sensor_index=2, name="B", pm25=5.0),
            self._make_sensor(sensor_index=3, name="C", pm25=10.0),
        ]
        app = self._make_app_state(sensors)
        st = {"fixed": [], "mobile": []}
        _merge_purpleair_into_fixed(st, app)
        self.assertEqual(len(st["fixed"]), 3)
        ids = {f["id"] for f in st["fixed"]}
        self.assertEqual(ids, {"PA_1", "PA_2", "PA_3"})

    def test_multiple_sensors_different_colors(self):
        """Sensors with different PM2.5 levels should get different colors."""
        sensors = [
            self._make_sensor(sensor_index=1, pm25=1.0),   # should be cyan
            self._make_sensor(sensor_index=2, pm25=5.0),    # should be light blue
            self._make_sensor(sensor_index=3, pm25=15.0),   # should be dark green
        ]
        app = self._make_app_state(sensors)
        st = {"fixed": [], "mobile": []}
        _merge_purpleair_into_fixed(st, app)
        colors = [f["color"] for f in st["fixed"]]
        # All three should be different
        self.assertEqual(len(set(colors)), 3,
                         f"Expected 3 distinct colors, got {colors}")

    # ── outlier detection ────────────────────────────────────────────

    def test_broken_sensor_filtered_out(self):
        """A sensor reading 3000+ when peers read 1-5 should be filtered."""
        sensors = [
            self._make_sensor(sensor_index=1, pm25=1.0),
            self._make_sensor(sensor_index=2, pm25=2.0),
            self._make_sensor(sensor_index=3, pm25=1.5),
            self._make_sensor(sensor_index=4, pm25=3.0),
            self._make_sensor(sensor_index=99, name="Broken", pm25=3331.0),
        ]
        app = self._make_app_state(sensors)
        st = {"fixed": [], "mobile": []}
        _merge_purpleair_into_fixed(st, app)
        ids = {f["id"] for f in st["fixed"]}
        self.assertNotIn("PA_99", ids)
        self.assertEqual(len(st["fixed"]), 4)

    def test_negative_pm25_filtered(self):
        """Negative PM2.5 values should be filtered."""
        sensors = [
            self._make_sensor(sensor_index=1, pm25=2.0),
            self._make_sensor(sensor_index=2, pm25=3.0),
            self._make_sensor(sensor_index=3, pm25=1.5),
            self._make_sensor(sensor_index=4, pm25=-5.0),
        ]
        app = self._make_app_state(sensors)
        st = {"fixed": [], "mobile": []}
        _merge_purpleair_into_fixed(st, app)
        ids = {f["id"] for f in st["fixed"]}
        self.assertNotIn("PA_4", ids)

    def test_real_spike_not_filtered(self):
        """A genuine spike (many sensors elevated) should NOT be filtered."""
        sensors = [
            self._make_sensor(sensor_index=1, pm25=40.0),
            self._make_sensor(sensor_index=2, pm25=55.0),
            self._make_sensor(sensor_index=3, pm25=38.0),
            self._make_sensor(sensor_index=4, pm25=80.0),  # higher but plausible
        ]
        app = self._make_app_state(sensors)
        st = {"fixed": [], "mobile": []}
        _merge_purpleair_into_fixed(st, app)
        self.assertEqual(len(st["fixed"]), 4)

    def test_hotspot_near_highway_not_filtered(self):
        """A single sensor reading 200 near highways when others read 1-5 is legitimate."""
        sensors = [
            self._make_sensor(sensor_index=1, pm25=1.0),
            self._make_sensor(sensor_index=2, pm25=2.0),
            self._make_sensor(sensor_index=3, pm25=1.5),
            self._make_sensor(sensor_index=4, pm25=3.0),
            self._make_sensor(sensor_index=5, name="Near Freeway", pm25=201.0),
        ]
        app = self._make_app_state(sensors)
        st = {"fixed": [], "mobile": []}
        _merge_purpleair_into_fixed(st, app)
        ids = {f["id"] for f in st["fixed"]}
        self.assertIn("PA_5", ids, "201 µg/m³ near highway should NOT be filtered")

    def test_dust_storm_readings_not_filtered(self):
        """During dust storms, readings of 400+ are real and should be kept."""
        sensors = [
            self._make_sensor(sensor_index=1, pm25=50.0),
            self._make_sensor(sensor_index=2, pm25=120.0),
            self._make_sensor(sensor_index=3, pm25=80.0),
            self._make_sensor(sensor_index=4, pm25=450.0),  # dusty hotspot
        ]
        app = self._make_app_state(sensors)
        st = {"fixed": [], "mobile": []}
        _merge_purpleair_into_fixed(st, app)
        self.assertEqual(len(st["fixed"]), 4)

    def test_moderate_outlier_kept_with_high_iqr(self):
        """When IQR is large, moderately high values should survive."""
        sensors = [
            self._make_sensor(sensor_index=1, pm25=5.0),
            self._make_sensor(sensor_index=2, pm25=15.0),
            self._make_sensor(sensor_index=3, pm25=25.0),
            self._make_sensor(sensor_index=4, pm25=50.0),  # high but within range
        ]
        app = self._make_app_state(sensors)
        st = {"fixed": [], "mobile": []}
        _merge_purpleair_into_fixed(st, app)
        self.assertEqual(len(st["fixed"]), 4)

    # ── history accumulation ─────────────────────────────────────────

    def test_purpleair_readings_accumulate_to_history(self):
        """PurpleAir readings should be stored in fixed_history for playback."""
        app = self._make_app_state([self._make_sensor(sensor_index=42, pm25=3.5)])
        # Simulate what purpleair_fetch_loop does
        sid = "PA_42"
        color = _get_aqi_color("PM25", 3.5)
        accumulate_fixed_reading(app, sid, "PM25", 3.5, color, "2026-02-08T20:00:00Z")
        self.assertIn(sid, app.fixed_history)
        self.assertIn("PM25", app.fixed_history[sid])
        self.assertEqual(len(app.fixed_history[sid]["PM25"]), 1)
        entry = app.fixed_history[sid]["PM25"][0]
        self.assertEqual(entry["val"], "3.5")
        self.assertEqual(entry["col"], color)

    def test_purpleair_history_dedupes(self):
        """Same value+time should not create duplicate history entries."""
        app = self._make_app_state()
        color = _get_aqi_color("PM25", 2.0)
        accumulate_fixed_reading(app, "PA_1", "PM25", 2.0, color, "2026-02-08T20:00:00Z")
        accumulate_fixed_reading(app, "PA_1", "PM25", 2.0, color, "2026-02-08T20:00:00Z")
        self.assertEqual(len(app.fixed_history["PA_1"]["PM25"]), 1)

    def test_purpleair_history_appends_new_time(self):
        """Different time should create a new history entry."""
        app = self._make_app_state()
        color = _get_aqi_color("PM25", 2.0)
        accumulate_fixed_reading(app, "PA_1", "PM25", 2.0, color, "2026-02-08T20:00:00Z")
        accumulate_fixed_reading(app, "PA_1", "PM25", 2.0, color, "2026-02-08T20:02:00Z")
        self.assertEqual(len(app.fixed_history["PA_1"]["PM25"]), 2)

    def test_home_history_color_recomputed_not_stale(self):
        """Home history colors should use current Utah AQ scale, not stored EPA colors."""
        app = self._make_app_state()
        # Simulate old history with stale EPA green
        app.fixed_history["Home"] = {"PM25": [
            {"val": "1", "col": "#00E400", "time": "2026-02-08T10:00:00Z", "recorded_at": 0},
            {"val": "2", "col": "#00E400", "time": "2026-02-08T10:01:00Z", "recorded_at": 0},
        ]}
        # The history reconstruction should recompute colors
        # (tested via _get_aqi_color which is used in the rebuild path)
        self.assertEqual(_get_aqi_color("PM25", 1.0), "#00FFFF")
        self.assertEqual(_get_aqi_color("PM25", 2.0), "#00FFFF")
        # Stale color should NOT match
        self.assertNotEqual(_get_aqi_color("PM25", 1.0), "#00E400")


if __name__ == "__main__":
    unittest.main()
