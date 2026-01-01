"""Tests for mobileair.tui_format shared formatting module."""

import unittest
from mobileair.tui_format import (
    format_value,
    get_trend_symbol,
    get_pollutant_columns,
    format_sensor_for_list,
    format_all_sensors,
    format_tui_state,
    format_json_view,
    POLLUTANT_ORDER,
    VALUE_WIDTH,
    MAX_NAME_LEN,
)


class TestFormatValue(unittest.TestCase):
    """Tests for format_value function."""
    
    def test_format_none(self):
        """None values should return spaces."""
        result = format_value(None)
        self.assertEqual(len(result), VALUE_WIDTH)
        self.assertEqual(result.strip(), "")
    
    def test_format_small_float(self):
        """Small floats should have 2 decimal places."""
        result = format_value(3.14)
        self.assertEqual(result.strip(), "3.14")
        self.assertEqual(len(result), VALUE_WIDTH)
    
    def test_format_medium_float(self):
        """Values >= 10 should have 1 decimal place."""
        result = format_value(25.678)
        self.assertEqual(result.strip(), "25.7")
    
    def test_format_large_float(self):
        """Values >= 100 should have 0 decimal places."""
        result = format_value(123.456)
        self.assertEqual(result.strip(), "123")
    
    def test_format_right_aligned(self):
        """Values should be right-aligned."""
        result = format_value(5.5)
        self.assertTrue(result.startswith(" "))


class TestGetTrendSymbol(unittest.TestCase):
    """Tests for get_trend_symbol function."""
    
    def test_none_reading(self):
        """None reading should return space."""
        symbol, color = get_trend_symbol(None)
        self.assertEqual(symbol, " ")
    
    def test_short_history(self):
        """Short history should return dash."""
        reading = {"value": 10, "history": [1, 2, 3]}
        symbol, color = get_trend_symbol(reading)
        self.assertEqual(symbol, "-")
    
    def test_stable_history(self):
        """Stable values should return dash."""
        reading = {"value": 10, "history": [10, 10.1, 10, 9.9, 10, 10.1, 10, 9.9]}
        symbol, color = get_trend_symbol(reading, "PM25")
        self.assertEqual(symbol, "-")
    
    def test_rising_history(self):
        """Rising values should return up arrow."""
        reading = {"value": 20, "history": [10, 11, 12, 14, 16, 18, 19, 20]}
        symbol, color = get_trend_symbol(reading, "PM25")
        self.assertEqual(symbol, "▲")
    
    def test_falling_history(self):
        """Falling values should return down arrow."""
        reading = {"value": 10, "history": [20, 19, 18, 16, 14, 12, 11, 10]}
        symbol, color = get_trend_symbol(reading, "PM25")
        self.assertEqual(symbol, "▼")


class TestGetPollutantColumns(unittest.TestCase):
    """Tests for get_pollutant_columns function."""
    
    def test_empty_readings(self):
        """Empty readings should return columns with has_value=False."""
        columns = get_pollutant_columns({})
        self.assertEqual(len(columns), 3)
        for col in columns:
            self.assertFalse(col["has_value"])
    
    def test_all_pollutants(self):
        """All pollutants should be included in order."""
        readings = {
            "PM25": {"value": 10.5, "color": "#00FF00"},
            "PM10": {"value": 20.3, "color": "#FFFF00"},
            "OZNE": {"value": 5.1, "color": "#00FFFF"},
        }
        columns = get_pollutant_columns(readings)
        
        self.assertEqual(len(columns), 3)
        self.assertEqual(columns[0]["key"], "PM25")
        self.assertEqual(columns[1]["key"], "PM10")
        self.assertEqual(columns[2]["key"], "OZNE")
        
        for col in columns:
            self.assertTrue(col["has_value"])
    
    def test_missing_pollutant(self):
        """Missing pollutants should have has_value=False."""
        readings = {
            "PM25": {"value": 10.5, "color": "#00FF00"},
            # PM10 missing
            "OZNE": {"value": 5.1, "color": "#00FFFF"},
        }
        columns = get_pollutant_columns(readings)
        
        self.assertTrue(columns[0]["has_value"])  # PM25
        self.assertFalse(columns[1]["has_value"])  # PM10 missing
        self.assertTrue(columns[2]["has_value"])  # OZNE
    
    def test_alternate_key_names(self):
        """Alternate key names should be recognized."""
        readings = {
            "PM2.5": {"value": 10.5, "color": "#00FF00"},  # Not PM25
            "Ozone": {"value": 5.1, "color": "#00FFFF"},   # Not OZNE
        }
        columns = get_pollutant_columns(readings)
        
        self.assertTrue(columns[0]["has_value"])  # PM25 from PM2.5
        self.assertTrue(columns[2]["has_value"])  # OZNE from Ozone


class TestFormatSensorForList(unittest.TestCase):
    """Tests for format_sensor_for_list function."""
    
    def test_basic_sensor(self):
        """Basic sensor should be formatted correctly."""
        sensor = {
            "id": "BUS01",
            "name": "",
            "lat": 40.75,
            "lon": -111.85,
            "readings": {"PM25": {"value": 15.2, "color": "#FFFF00"}},
        }
        result = format_sensor_for_list(sensor, "mobile")
        
        self.assertEqual(result["id"], "BUS01")
        self.assertEqual(result["display_name"], "BUS01")
        self.assertEqual(result["type"], "mobile")
        self.assertFalse(result["pinned"])
        self.assertFalse(result["ghosted"])
        self.assertEqual(len(result["columns"]), 3)
    
    def test_sensor_with_name(self):
        """Sensor with custom name should include it."""
        sensor = {
            "id": "WBB",
            "name": "University of Utah",
            "readings": {},
        }
        result = format_sensor_for_list(sensor, "fixed")
        
        self.assertEqual(result["display_name"], "WBB (University of Utah)")
        self.assertEqual(result["type"], "fixed")


class TestFormatAllSensors(unittest.TestCase):
    """Tests for format_all_sensors function."""
    
    def test_combines_mobile_and_fixed(self):
        """Should combine mobile and fixed sensors."""
        state = {
            "mobile": [{"id": "BUS01", "readings": {}}],
            "fixed": [{"id": "WBB", "lat": 40.76, "lon": -111.85, "readings": {}}],
        }
        sensors = format_all_sensors(state, slc_filter=True)
        
        self.assertEqual(len(sensors), 2)
        ids = [s["id"] for s in sensors]
        self.assertIn("BUS01", ids)
        self.assertIn("WBB", ids)
    
    def test_sorts_by_ghosted_pinned_id(self):
        """Should sort by ghosted first, then pinned, then ID."""
        state = {
            "mobile": [
                {"id": "C", "readings": {}, "ghosted": False, "pinned": False},
                {"id": "A", "readings": {}, "ghosted": True, "pinned": False},
                {"id": "B", "readings": {}, "ghosted": False, "pinned": True},
            ],
            "fixed": [],
        }
        sensors = format_all_sensors(state, slc_filter=False)
        
        ids = [s["id"] for s in sensors]
        # Ghosted first (A), then pinned (B), then regular (C)
        self.assertEqual(ids, ["A", "B", "C"])
    
    def test_filters_fixed_to_slc(self):
        """Should filter fixed sensors to SLC area when slc_filter=True."""
        state = {
            "mobile": [],
            "fixed": [
                {"id": "SLC", "lat": 40.75, "lon": -111.85, "readings": {}},  # In SLC
                {"id": "NYC", "lat": 40.71, "lon": -74.00, "readings": {}},   # Not in SLC
            ],
        }
        sensors = format_all_sensors(state, slc_filter=True)
        
        self.assertEqual(len(sensors), 1)
        self.assertEqual(sensors[0]["id"], "SLC")


class TestFormatTuiState(unittest.TestCase):
    """Tests for format_tui_state function."""
    
    def test_includes_all_fields(self):
        """Should include all required fields."""
        state = {
            "ts": 1704067200,  # 2024-01-01 00:00:00
            "mobile": [],
            "fixed": [],
            "meta": {"test": True},
        }
        result = format_tui_state(state)
        
        self.assertIn("ts", result)
        self.assertIn("last_update", result)
        self.assertIn("sensors", result)
        self.assertIn("pollutant_order", result)
        self.assertIn("meta", result)
        
        self.assertEqual(result["pollutant_order"], POLLUTANT_ORDER)
        self.assertEqual(result["value_width"], VALUE_WIDTH)
        self.assertEqual(result["max_name_len"], MAX_NAME_LEN)


class TestFormatJsonView(unittest.TestCase):
    """Tests for format_json_view function."""
    
    def test_basic_structure(self):
        """Should include id and _meta."""
        result = format_json_view(
            sensor_id="BUS01",
            readings={},
        )
        
        self.assertEqual(result["id"], "BUS01")
        self.assertIn("_meta", result)
        self.assertIn("fetched_at", result["_meta"])
        self.assertIn("status", result["_meta"])
        self.assertIn("type", result["_meta"])
    
    def test_status_active(self):
        """Active sensor should have ACTIVE status."""
        result = format_json_view(
            sensor_id="BUS01",
            readings={},
            is_ghosted=False,
        )
        self.assertEqual(result["_meta"]["status"], "ACTIVE")
    
    def test_status_parked(self):
        """Ghosted sensor should have PARKED status."""
        result = format_json_view(
            sensor_id="BUS01",
            readings={},
            is_ghosted=True,
        )
        self.assertEqual(result["_meta"]["status"], "PARKED")
    
    def test_type_mobile(self):
        """Mobile sensor should have MOBILE type."""
        result = format_json_view(
            sensor_id="BUS01",
            readings={},
            sensor_type="mobile",
        )
        self.assertEqual(result["_meta"]["type"], "MOBILE")
    
    def test_type_fixed(self):
        """Fixed sensor should have FIXED type."""
        result = format_json_view(
            sensor_id="WBB",
            readings={},
            sensor_type="fixed",
        )
        self.assertEqual(result["_meta"]["type"], "FIXED")
    
    def test_readings_with_history(self):
        """Should include readings with history_tail and history_count."""
        readings = {
            "PM25": {
                "value": 15.2,
                "color": "#FFFF00",
                "history": [10, 11, 12, 13, 14, 15, 15.2],
            }
        }
        result = format_json_view(
            sensor_id="BUS01",
            readings=readings,
        )
        
        self.assertIn("PM25", result)
        self.assertEqual(result["PM25"]["value"], 15.2)
        self.assertEqual(result["PM25"]["color"], "#FFFF00")
        self.assertEqual(result["PM25"]["unit"], "µg/m³")
        self.assertEqual(result["PM25"]["history_count"], 7)
        self.assertEqual(len(result["PM25"]["history_tail"]), 5)
        self.assertEqual(result["PM25"]["history_tail"][-1], 15.2)
    
    def test_ozone_unit(self):
        """OZNE should have ppb unit."""
        readings = {
            "OZNE": {"value": 42.0, "color": "#00FF00", "history": []}
        }
        result = format_json_view(
            sensor_id="BUS01",
            readings=readings,
        )
        self.assertEqual(result["OZNE"]["unit"], "ppb")
    
    def test_location(self):
        """Should include location if coords provided."""
        result = format_json_view(
            sensor_id="BUS01",
            readings={},
            coords=(40.75, -111.85),
        )
        
        self.assertIn("location", result)
        self.assertEqual(result["location"]["lat"], 40.75)
        self.assertEqual(result["location"]["lon"], -111.85)
    
    def test_mobility_info(self):
        """Should include mobility info if provided."""
        mobility = {"status": "moving", "speed": 25.5}
        result = format_json_view(
            sensor_id="BUS01",
            readings={},
            mobility_info=mobility,
        )
        
        self.assertIn("mobility", result)
        self.assertEqual(result["mobility"]["status"], "moving")
    
    def test_trail_info(self):
        """Should include trail summary if trail provided."""
        trail = [
            {"lat": 40.75, "lon": -111.85, "t": 1000},
            {"lat": 40.76, "lon": -111.84, "t": 1100},
        ]
        result = format_json_view(
            sensor_id="BUS01",
            readings={},
            trail=trail,
        )
        
        self.assertEqual(result["trail_points"], 2)
        self.assertEqual(result["last_trail_point"]["t"], 1100)


if __name__ == "__main__":
    unittest.main()
