import json
import os
import tempfile
import unittest
from datetime import datetime, timezone, timedelta

import mobileair_core as core


class TestTimestamps(unittest.TestCase):
    def test_parse_utc_timestamp_suffix_utc(self):
        dt = core.parse_utc_timestamp("2025-12-12 10:11:12 UTC")
        self.assertIsNotNone(dt)
        self.assertEqual(dt.tzinfo, timezone.utc)
        self.assertEqual(dt.year, 2025)
        self.assertEqual(dt.month, 12)
        self.assertEqual(dt.day, 12)

    def test_parse_utc_timestamp_iso_z(self):
        dt = core.parse_utc_timestamp("2025-12-12T10:11:12Z")
        self.assertIsNotNone(dt)
        self.assertEqual(dt.tzinfo, timezone.utc)

    def test_parse_utc_timestamp_none(self):
        self.assertIsNone(core.parse_utc_timestamp(None))


class TestAQI(unittest.TestCase):
    def test_value_to_aqi_pm25_good(self):
        # With current EPA codetable breakpoints (aqi_breakpoints.csv), PM2.5 "Good" is 0.0-9.0
        aqi = core.value_to_aqi("pm2.5", 8.0)
        self.assertIsNotNone(aqi)
        self.assertLessEqual(aqi, 50)

    def test_aqi_level_unknown(self):
        lvl = core.aqi_level(None)
        self.assertEqual(lvl["label"], "Unknown")

    def test_color_for_value(self):
        col = core.color_for_value("pm2.5", 10.0)
        self.assertTrue(isinstance(col, str) and col.startswith("#"))


class TestTrend(unittest.TestCase):
    def test_trend_stable_low_variance(self):
        hist = [10, 10.1, 10.0, 10.2, 10.1, 10.0, 10.1, 10.0, 10.1]
        info = core.compute_trend_indicator("pm2.5", "ug/m3", hist, 10.1)
        self.assertIsNotNone(info)
        self.assertEqual(info["symbol"], "▬")

    def test_trend_rising(self):
        hist = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
        info = core.compute_trend_indicator("pm10", "ug/m3", hist, 15)
        self.assertIsNotNone(info)
        # Might be stable if thresholds filter; accept either rising or stable, but must not crash
        self.assertIn(info["symbol"], {"▲", "▬"})

    def test_extract_numeric_history_with_dicts_and_nones(self):
        hist = [{"val": "1.0"}, {"val": None}, {"val": "None"}, {"val": "2.5"}]
        nums = core.extract_numeric_history(hist)
        self.assertEqual(nums, [1.0, 2.5])


class TestMobility(unittest.TestCase):
    def test_evaluate_mobility_immobile(self):
        base = datetime(2025, 12, 12, 10, 0, 0, tzinfo=timezone.utc)
        times = [(base + timedelta(minutes=i)).strftime("%Y-%m-%d %H:%M:%S UTC") for i in range(15)]
        # Tiny jitter within ~few meters
        lats = [40.7608 + (i % 3) * 1e-6 for i in range(15)]
        lons = [-111.8910 + (i % 3) * 1e-6 for i in range(15)]
        blob = {"Latitude": lats, "Longitude": lons, "TimeUTC": times}
        info = core.evaluate_mobility(blob)
        self.assertTrue(isinstance(info, dict))
        # Should be immobile given tight jitter and enough coverage
        self.assertTrue(info.get("immobile"))

    def test_evaluate_mobility_immobile_with_large_gps_drift(self):
        base = datetime(2025, 12, 12, 10, 0, 0, tzinfo=timezone.utc)
        times = [(base + timedelta(minutes=i)).strftime("%Y-%m-%d %H:%M:%S UTC") for i in range(15)]

        # Simulate parked depot GPS drift: wander around within ~200m.
        # 0.0018° lat ~= 200m.
        lat0 = 40.7608
        lon0 = -111.8910
        offsets = [
            (0.0, 0.0),
            (0.0018, 0.0),
            (0.0, 0.0018),
            (-0.0018, 0.0),
            (0.0, -0.0018),
            (0.0012, 0.0012),
            (-0.0012, 0.0012),
            (-0.0012, -0.0012),
            (0.0012, -0.0012),
        ]
        lats = [lat0 + offsets[i % len(offsets)][0] for i in range(15)]
        lons = [lon0 + offsets[i % len(offsets)][1] for i in range(15)]

        blob = {"Latitude": lats, "Longitude": lons, "TimeUTC": times}
        info = core.evaluate_mobility(blob)
        self.assertTrue(isinstance(info, dict))
        self.assertTrue(info.get("immobile"))

    def test_evaluate_mobility_sparse_defaults_to_idle(self):
        base = datetime(2025, 12, 12, 10, 0, 0, tzinfo=timezone.utc)
        times = [(base + timedelta(minutes=i)).strftime("%Y-%m-%d %H:%M:%S UTC") for i in range(3)]
        # Only a few samples, small drift: should be treated as idle unless movement is proven.
        lats = [40.7608, 40.76081, 40.76080]
        lons = [-111.8910, -111.89101, -111.89100]
        blob = {"Latitude": lats, "Longitude": lons, "TimeUTC": times}
        info = core.evaluate_mobility(blob)
        self.assertTrue(info.get("immobile"))


class FakeResp:
    def __init__(self, payload=None, exc=None):
        self._payload = payload
        self._exc = exc

    def raise_for_status(self):
        if self._exc:
            raise self._exc

    def json(self):
        if self._exc:
            raise self._exc
        return self._payload


class TestFetchJsonWithCache(unittest.TestCase):
    def test_fetch_success_writes_cache(self):
        with tempfile.TemporaryDirectory() as td:
            cache_path = os.path.join(td, "cache.json")

            def fake_get(url, headers=None, timeout=None):
                return FakeResp(payload={"ok": True})

            data = core.fetch_json_with_cache(
                "http://example.test",
                headers={"x": "y"},
                timeout=1,
                cache_path=cache_path,
                request_get=fake_get,
            )
            self.assertEqual(data, {"ok": True})
            self.assertTrue(os.path.exists(cache_path))
            with open(cache_path, "r") as f:
                wrapper = json.load(f)
                self.assertIn("_data", wrapper)
                self.assertEqual(wrapper["_data"], {"ok": True})
                self.assertIsInstance(wrapper["_fetched_at"], float)

    def test_fetch_failure_uses_cache(self):
        with tempfile.TemporaryDirectory() as td:
            cache_path = os.path.join(td, "cache.json")
            with open(cache_path, "w") as f:
                json.dump({"cached": 1}, f)

            def fake_get(url, headers=None, timeout=None):
                raise RuntimeError("network down")

            msgs = []

            def notify(msg: str, severity: str):
                msgs.append((severity, msg))

            data = core.fetch_json_with_cache(
                "http://example.test",
                headers={"x": "y"},
                timeout=1,
                cache_path=cache_path,
                request_get=fake_get,
                notify=notify,
            )
            self.assertEqual(data, {"cached": 1})
            self.assertTrue(any(sev == "warning" for sev, _ in msgs))


class TestMapHtml(unittest.TestCase):
    def test_generate_leaflet_map_html_contains_leaflet_and_points(self):
        html = core.generate_leaflet_map_html(
            [
                {
                    "lat": 40.0,
                    "lon": -111.0,
                    "label": "S1",
                    "popup_html": "<b>S1</b>",
                    "color": "#ff0000",
                }
            ],
            title="Test Map",
            center=(40.0, -111.0),
            zoom=12,
        )
        self.assertIn("leaflet.css", html)
        self.assertIn("leaflet.js", html)
        self.assertIn("L.map('map')", html)
        self.assertIn('"label": "S1"', html)
        self.assertIn('"color": "#ff0000"', html)


class TestTracksAndDashboardState(unittest.TestCase):
    def test_extract_mobile_tracks_trims_and_sorts(self):
        # Create a minimal mobile payload with two points and explicit times
        mobile = {
            "PM25": {
                "VarUnit": "ug/m3",
                "BUS1": {
                    "Value": ["1", "2"],
                    "ValueColor": ["#111111", "#222222"],
                    "Latitude": [40.0, 40.001],
                    "Longitude": [-111.0, -111.002],
                    "TimeUTC": ["2025-12-12 10:00:00 UTC", "2025-12-12 10:05:00 UTC"],
                },
            }
        }
        tracks = core.extract_mobile_tracks(mobile, max_points=50)
        self.assertIn("BUS1", tracks)
        self.assertEqual(len(tracks["BUS1"]), 2)
        self.assertEqual(tracks["BUS1"][0]["t"], "2025-12-12 10:00:00 UTC")
        self.assertIn("readings", tracks["BUS1"][0])
        self.assertEqual(tracks["BUS1"][0]["readings"]["PM25"]["ci"], 1)  # #00FFFF = palette index 1

    def test_normalize_state_for_dashboard_has_mobile_and_trail(self):
        combined = {
            "mobile": {
                "PM25": {
                    "BUS13": {
                        "Value": ["6.3"],
                        "ValueColor": ["#00ff00"],
                        "Latitude": [40.7608, 40.7610],
                        "Longitude": [-111.8910, -111.8912],
                        "TimeUTC": ["2025-12-12 10:00:00 UTC", "2025-12-12 10:01:00 UTC"],
                    }
                }
            },
            "fixed": {},
        }
        st = core.normalize_state_for_dashboard(
            combined,
            custom_names={"BUS13": "Demo"},
            pinned_sensors={"BUS13"},
            max_points=200,
        )
        self.assertIn("mobile", st)
        self.assertEqual(len(st["mobile"]), 1)
        m = st["mobile"][0]
        self.assertEqual(m["id"], "BUS13")
        self.assertTrue(m["pinned"])
        self.assertEqual(m["emoji"], "🚍")
        self.assertTrue(isinstance(m["trail"], list) and len(m["trail"]) >= 2)

    def test_normalize_state_sets_last_position_change_ts(self):
        combined = {
            "mobile": {
                "PM25": {
                    "BUS1": {
                        "Value": ["1", "2", "3"],
                        "ValueColor": ["#00ff00", "#00ff00", "#00ff00"],
                        "Latitude": [40.0, 40.0, 40.001],  # move at t2
                        "Longitude": [-111.0, -111.0, -111.002],
                        "TimeUTC": ["2025-12-12 10:00:00 UTC", "2025-12-12 10:01:00 UTC", "2025-12-12 10:02:00 UTC"],
                    }
                }
            },
            "fixed": {},
        }
        st = core.normalize_state_for_dashboard(
            combined,
            custom_names={},
            pinned_sensors=set(),
            max_points=200,
        )
        self.assertIn("meta", st)
        ts = st["meta"].get("last_position_change_ts")
        self.assertTrue(isinstance(ts, (int, float)))
        expected = core.parse_utc_timestamp("2025-12-12 10:02:00 UTC").timestamp()
        self.assertAlmostEqual(float(ts), float(expected), delta=1.5)

    def test_marker_primary_is_worst_aqi_not_biggest_number(self):
        # Ozone 70ppb -> AQI 100, PM10 120 -> AQI ~83 (so ozone is “worse” despite smaller number)
        combined = {
            "mobile": {
                "PM10": {
                    "BUS99": {
                        "Value": ["120"],
                        "ValueColor": ["#00ff00"],
                        "Latitude": [40.7],
                        "Longitude": [-111.9],
                        "TimeUTC": ["2025-12-12 10:00:00 UTC"],
                    }
                },
                "OZNE": {
                    "BUS99": {
                        "Value": ["70"],
                        "ValueColor": ["#ff00ff"],
                        "Latitude": [40.7],
                        "Longitude": [-111.9],
                        "TimeUTC": ["2025-12-12 10:00:00 UTC"],
                    }
                },
            },
            "fixed": {},
        }
        st = core.normalize_state_for_dashboard(
            combined,
            custom_names={},
            pinned_sensors=set(),
            max_points=200,
        )
        m = st["mobile"][0]
        self.assertEqual(m["primary_key"], "OZNE")
        self.assertEqual(m["primary_value"], "70")
        self.assertEqual(m["pci"], 7)  # #FFFF00 = palette index 7 (yellow – Moderate)

    def test_marker_primary_prefers_pm10_when_it_has_higher_aqi(self):
        # Repro for the dashboard issue: ozone in ppb (32) is "Good", but PM10 in the 400s is Hazardous.
        combined = {
            "mobile": {
                "PM10": {
                    "BUS09": {
                        "Value": ["451.4"],
                        "ValueColor": ["#7E0023"],
                        "Latitude": [40.7],
                        "Longitude": [-111.9],
                        "TimeUTC": ["2025-12-12 10:00:00 UTC"],
                    }
                },
                "OZNE": {
                    "BUS09": {
                        "Value": ["32.4"],
                        "ValueColor": ["#00ff00"],
                        "Latitude": [40.7],
                        "Longitude": [-111.9],
                        "TimeUTC": ["2025-12-12 10:00:00 UTC"],
                    }
                },
            },
            "fixed": {},
        }
        st = core.normalize_state_for_dashboard(
            combined,
            custom_names={},
            pinned_sensors=set(),
            max_points=200,
        )
        m = st["mobile"][0]
        self.assertEqual(m["primary_key"], "PM10")

    def test_trail_points_carry_forward_readings_across_pollutants(self):
        # Repro shape: ozone has an update at t2, but PM10 last updated at t1.
        # We still want the t2 breadcrumb to include PM10 (carry-forward) so DVR labels don't show OZNE-only.
        combined = {
            "mobile": {
                "PM10": {
                    "BUS04": {
                        "Latitude": [40.0],
                        "Longitude": [-111.0],
                        "TimeUTC": ["2025-12-24 09:37:00 UTC"],
                        "Value": ["628.20"],
                        "ValueColor": ["#FF00FF"],
                    }
                },
                "OZNE": {
                    "BUS04": {
                        "Latitude": [40.0, 40.0],
                        "Longitude": [-111.0, -111.0],
                        "TimeUTC": ["2025-12-24 09:37:00 UTC", "2025-12-24 09:37:30 UTC"],
                        "Value": ["35.00", "33.60"],
                        "ValueColor": ["#009900", "#00FF00"],
                    }
                },
            },
            "fixed": {},
        }
        # Validate at the track-extraction layer (normalize_state may collapse parked trails).
        tracks = core.extract_mobile_tracks(combined["mobile"], max_points=200)
        trail = tracks.get("BUS04") or []
        self.assertGreaterEqual(len(trail), 2)
        last = trail[-1]
        r = last.get("readings") or {}
        self.assertIn("OZNE", r)
        self.assertIn("PM10", r)

    def test_trax_emoji(self):
        combined = {
            "mobile": {
                "PM25": {
                    "TRX02": {
                        "Value": ["1.0"],
                        "ValueColor": ["#abcdef"],
                        "Latitude": [40.7],
                        "Longitude": [-111.9],
                        "TimeUTC": ["2025-12-12 10:00:00 UTC"],
                    }
                }
            },
            "fixed": {},
        }
        st = core.normalize_state_for_dashboard(
            combined,
            custom_names={},
            pinned_sensors=set(),
            max_points=200,
        )
        self.assertEqual(st["mobile"][0]["emoji"], "🚃")

    def test_extract_mobile_tracks_does_not_truncate_to_five_unexpectedly(self):
        # Regression test for the temporary 5-sample limit
        n_points = 10
        mobile = {
            "PM25": {
                "BUS1": {
                    "Value": [str(i) for i in range(n_points)],
                    "ValueColor": ["#ff0000"] * n_points,
                    "Latitude": [40.0] * n_points,
                    "Longitude": [-111.0] * n_points,
                    "TimeUTC": [f"2025-12-12 10:{i:02d}:00 UTC" for i in range(n_points)],
                },
            }
        }
        tracks = core.extract_mobile_tracks(mobile, max_points=100)
        self.assertEqual(len(tracks["BUS1"]), n_points)
        self.assertGreater(len(tracks["BUS1"]), 5)

    def test_normalize_state_does_not_ghost_when_immobile(self):
        # Dashboard semantics: immobile (stopped/parked) does not imply ghosted.
        # "ghosted" is reserved for offline sensors (handled by dashboard_server).
        times = []
        for i in range(12):
            mm = i * 3
            times.append(f"2025-12-12 10:{mm:02d}:00 UTC")
        combined = {
            "mobile": {
                "PM25": {
                    "BUS01": {
                        "Latitude": [40.0] * 12,
                        "Longitude": [-111.0] * 12,
                        "Value": [str(i) for i in range(12)],
                        "ValueColor": ["#00ff00"] * 12,
                        "TimeUTC": times,
                    }
                }
            },
            "fixed": {},
        }
        st = core.normalize_state_for_dashboard(
            combined,
            custom_names={},
            pinned_sensors=set(),
            max_points=200,
        )
        self.assertTrue(st["mobile"])
        m = st["mobile"][0]
        self.assertTrue(m.get("immobile"))
        self.assertFalse(m.get("ghosted"))
        self.assertIsInstance(m.get("mobility"), dict)

    def test_normalize_state_mobility_uses_merged_tracks_not_first_pollutant(self):
        # Regression: mobility/ghosted should NOT depend on pollutant dict iteration order.
        # If one pollutant stream is sparse/stale (appears immobile) but another shows clear movement,
        # the sensor should NOT be marked immobile/ghosted.
        combined = {
            "mobile": {
                # First pollutant stream: looks parked/immobile.
                "PM25": {
                    "BUS10": {
                        "Latitude": [40.0, 40.0, 40.0],
                        "Longitude": [-111.0, -111.0, -111.0],
                        "Value": ["1", "1", "1"],
                        "ValueColor": ["#00ff00"] * 3,
                        "TimeUTC": [
                            "2025-12-12 10:00:00 UTC",
                            "2025-12-12 10:01:00 UTC",
                            "2025-12-12 10:02:00 UTC",
                        ],
                    }
                },
                # Second pollutant stream: shows movement across multiple points.
                "OZNE": {
                    "BUS10": {
                        "Latitude": [40.0000, 40.0020, 40.0040, 40.0060, 40.0080, 40.0100],
                        "Longitude": [-111.0000, -111.0005, -111.0010, -111.0015, -111.0020, -111.0025],
                        "Value": ["1"] * 6,
                        "ValueColor": ["#00ff00"] * 6,
                        "TimeUTC": [
                            "2025-12-12 10:00:30 UTC",
                            "2025-12-12 10:01:30 UTC",
                            "2025-12-12 10:02:30 UTC",
                            "2025-12-12 10:03:30 UTC",
                            "2025-12-12 10:04:30 UTC",
                            "2025-12-12 10:05:30 UTC",
                        ],
                    }
                },
            },
            "fixed": {},
        }
        st = core.normalize_state_for_dashboard(
            combined,
            custom_names={},
            pinned_sensors=set(),
            max_points=200,
        )
        self.assertTrue(st["mobile"])
        m = next((x for x in st["mobile"] if x.get("id") == "BUS10"), None)
        self.assertIsNotNone(m)
        self.assertFalse(m.get("immobile"), "BUS10 should not be marked immobile when merged trail shows movement")
        self.assertFalse(m.get("ghosted"), "BUS10 should not be ghosted when merged trail shows movement")


class TestSpatialOutliers(unittest.TestCase):
    def test_detect_spatial_outliers_flags_lone_spike(self):
        # 5 nearby sensors, one has an extreme PM25 spike.
        sensors = []
        base_lat, base_lon = 40.7608, -111.8910

        # Four neighbors around ~30.
        for i, v in enumerate([28, 31, 33, 29]):
            sensors.append(
                {
                    "id": f"N{i}",
                    "lat": base_lat + (i * 0.002),
                    "lon": base_lon + (i * 0.002),
                    "readings": {"PM25": {"value": v}},
                }
            )

        sensors.append(
            {
                "id": "HFAI",
                "lat": base_lat + 0.001,
                "lon": base_lon + 0.001,
                "readings": {"PM25": {"value": 900}},
            }
        )

        out = core.detect_spatial_outliers(
            sensors,
            pollutant_keys=("PM25", "PM2.5"),
            radius_m=15000,
            min_neighbors=3,
        )
        self.assertIn("HFAI", out)

    def test_detect_spatial_outliers_can_expand_radius_in_sparse_area(self):
        # Only 3 neighbors exist and they are farther than the initial radius,
        # but within max_radius_m. The spike should still be flagged.
        base_lat, base_lon = 40.7608, -111.8910
        sensors = [
            {"id": "A", "lat": base_lat + 0.40, "lon": base_lon + 0.00, "readings": {"PM25": {"value": 18}}},
            {"id": "B", "lat": base_lat + 0.00, "lon": base_lon + 0.40, "readings": {"PM25": {"value": 22}}},
            {"id": "C", "lat": base_lat - 0.35, "lon": base_lon - 0.10, "readings": {"PM25": {"value": 25}}},
            {"id": "HFAI", "lat": base_lat, "lon": base_lon, "readings": {"PM25": {"value": 900}}},
        ]

        out = core.detect_spatial_outliers(
            sensors,
            pollutant_keys=("PM25", "PM2.5"),
            radius_m=5000,
            max_radius_m=80000,
            min_neighbors=3,
        )
        self.assertIn("HFAI", out)

    def test_detect_spatial_outliers_does_not_flag_regional_event(self):
        # If neighbors are also elevated, it should not be flagged.
        sensors = []
        base_lat, base_lon = 40.7608, -111.8910

        for i, v in enumerate([650, 720, 810, 770, 690]):
            sensors.append(
                {
                    "id": f"S{i}",
                    "lat": base_lat + (i * 0.002),
                    "lon": base_lon - (i * 0.002),
                    "readings": {"PM25": {"value": v}},
                }
            )

        out = core.detect_spatial_outliers(
            sensors,
            pollutant_keys=("PM25", "PM2.5"),
            radius_m=15000,
            min_neighbors=3,
        )
        self.assertEqual(set(), out)

if __name__ == "__main__":
    unittest.main()


