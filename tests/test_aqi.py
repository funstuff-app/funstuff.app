"""
Tests for mobileair/aqi.py - AQI calculations and color mapping.
"""

import unittest

from mobileair.aqi import (
    normalize_pollutant_key,
    value_to_aqi,
    aqi_level,
    color_for_value,
    trend_threshold,
    filter_history_outliers,
)


class TestNormalizePollutantKey(unittest.TestCase):
    """Test pollutant key normalization."""

    def test_pm25_variations(self):
        """All PM2.5 variations normalize to 'pm2.5'."""
        for key in ["PM25", "pm25", "PM2.5", "pm2.5", "pm2_5", "pm2-5", "pm 2.5"]:
            with self.subTest(key=key):
                self.assertEqual(normalize_pollutant_key(key), "pm2.5")

    def test_pm10_variations(self):
        """PM10 variations normalize to 'pm10'."""
        for key in ["PM10", "pm10", "pm 10"]:
            with self.subTest(key=key):
                self.assertEqual(normalize_pollutant_key(key), "pm10")

    def test_ozone_variations(self):
        """Ozone variations normalize to 'ozone'."""
        for key in ["OZNE", "ozne", "ozone", "OZONE", "O3", "o3"]:
            with self.subTest(key=key):
                self.assertEqual(normalize_pollutant_key(key), "ozone")

    def test_unknown_passthrough(self):
        """Unknown keys are lowercased and passed through."""
        self.assertEqual(normalize_pollutant_key("CO2"), "co2")
        self.assertEqual(normalize_pollutant_key("NO2"), "no2")

    def test_empty_string(self):
        """Empty string returns empty string."""
        self.assertEqual(normalize_pollutant_key(""), "")

    def test_whitespace_handling(self):
        """Handles whitespace."""
        self.assertEqual(normalize_pollutant_key("  PM25  "), "pm2.5")


class TestValueToAqi(unittest.TestCase):
    """Test pollutant concentration to AQI conversion."""

    def test_pm25_good(self):
        """PM2.5 in Good range (0-9.0 µg/m³)."""
        aqi = value_to_aqi("PM25", 5.0)
        self.assertIsNotNone(aqi)
        self.assertLessEqual(aqi, 50)

    def test_pm25_moderate(self):
        """PM2.5 in Moderate range (9.1-35.4 µg/m³)."""
        aqi = value_to_aqi("PM25", 20.0)
        self.assertIsNotNone(aqi)
        self.assertGreater(aqi, 50)
        self.assertLessEqual(aqi, 100)

    def test_pm25_unhealthy(self):
        """PM2.5 in Unhealthy range (55.5-125.4 µg/m³)."""
        aqi = value_to_aqi("PM25", 80.0)
        self.assertIsNotNone(aqi)
        self.assertGreater(aqi, 150)
        self.assertLessEqual(aqi, 200)

    def test_pm10_good(self):
        """PM10 in Good range (0-54 µg/m³)."""
        aqi = value_to_aqi("PM10", 30)
        self.assertIsNotNone(aqi)
        self.assertLessEqual(aqi, 50)

    def test_pm10_hazardous(self):
        """PM10 at hazardous levels (>425 µg/m³)."""
        aqi = value_to_aqi("PM10", 500)
        self.assertIsNotNone(aqi)
        self.assertGreater(aqi, 300)

    def test_ozone_ppb_conversion(self):
        """Ozone in ppb is converted to ppm internally."""
        # 50 ppb = 0.050 ppm -> Good (0-50 AQI)
        aqi = value_to_aqi("OZNE", 50)
        self.assertIsNotNone(aqi)
        self.assertLessEqual(aqi, 50)

    def test_ozone_high(self):
        """Ozone at high levels."""
        # 85 ppb = 0.085 ppm -> USG (101-150 AQI)
        aqi = value_to_aqi("OZNE", 85)
        self.assertIsNotNone(aqi)
        self.assertGreater(aqi, 100)
        self.assertLessEqual(aqi, 150)

    def test_string_value(self):
        """Handles string values."""
        aqi = value_to_aqi("PM25", "10.5")
        self.assertIsNotNone(aqi)
        self.assertGreater(aqi, 0)

    def test_none_value(self):
        """None value returns None."""
        self.assertIsNone(value_to_aqi("PM25", None))

    def test_invalid_value(self):
        """Invalid value returns None."""
        self.assertIsNone(value_to_aqi("PM25", "not a number"))

    def test_unknown_pollutant(self):
        """Unknown pollutant returns None."""
        self.assertIsNone(value_to_aqi("UNKNOWN", 50))

    def test_zero_value(self):
        """Zero value returns AQI 0."""
        aqi = value_to_aqi("PM25", 0)
        self.assertEqual(aqi, 0)

    def test_below_range(self):
        """Value below minimum returns lowest AQI."""
        aqi = value_to_aqi("PM25", -1)
        self.assertEqual(aqi, 0)


class TestAqiLevel(unittest.TestCase):
    """Test AQI level determination."""

    def test_good_level(self):
        """AQI 0-50 is Good."""
        level = aqi_level(25)
        self.assertEqual(level["label"], "Good")
        self.assertEqual(level["color"], "#00E400")

    def test_moderate_level(self):
        """AQI 51-100 is Moderate."""
        level = aqi_level(75)
        self.assertEqual(level["label"], "Moderate")
        self.assertEqual(level["color"], "#FFFF00")

    def test_usg_level(self):
        """AQI 101-150 is USG."""
        level = aqi_level(125)
        self.assertEqual(level["label"], "Sensitive Groups")

    def test_unhealthy_level(self):
        """AQI 151-200 is Unhealthy."""
        level = aqi_level(175)
        self.assertEqual(level["label"], "Unhealthy")

    def test_very_unhealthy_level(self):
        """AQI 201-300 is Very Unhealthy."""
        level = aqi_level(250)
        self.assertEqual(level["label"], "Very Unhealthy")

    def test_hazardous_level(self):
        """AQI 301-500 is Hazardous."""
        level = aqi_level(400)
        self.assertEqual(level["label"], "Hazardous")

    def test_above_max(self):
        """AQI above 500 returns Hazardous."""
        level = aqi_level(600)
        self.assertEqual(level["label"], "Hazardous")

    def test_none_aqi(self):
        """None AQI returns Unknown."""
        level = aqi_level(None)
        self.assertEqual(level["label"], "Unknown")

    def test_boundary_values(self):
        """Test boundary values."""
        # Exactly 50 should be Good
        self.assertEqual(aqi_level(50)["label"], "Good")
        # Exactly 100 should be Moderate
        self.assertEqual(aqi_level(100)["label"], "Moderate")


class TestColorForValue(unittest.TestCase):
    """Test color mapping for pollutant values (EPA AQI scale with clean sub-gradients)."""

    def test_pm25_good_color(self):
        """Low PM2.5 returns light blue (clean sub-gradient within Good)."""
        color = color_for_value("PM25", 5.0)
        self.assertEqual(color, "#00CCFF")

    def test_pm25_moderate_color(self):
        """PM2.5 10 returns yellow (EPA 2024 Moderate starts at 9.1)."""
        color = color_for_value("PM25", 10.0)
        self.assertEqual(color, "#FFFF00")

    def test_pm25_unhealthy_boundary(self):
        """PM2.5 126 returns purple (EPA 2024 Very Unhealthy starts at 125.5)."""
        color = color_for_value("PM25", 126.0)
        self.assertEqual(color, "#8F3F97")

    def test_unknown_pollutant_color(self):
        """Unknown pollutant returns gray."""
        color = color_for_value("UNKNOWN", 50)
        self.assertEqual(color, "#cccccc")


class TestTrendThreshold(unittest.TestCase):
    """Test trend detection thresholds."""

    def test_pm25_threshold(self):
        """PM2.5 has threshold of 1.0."""
        self.assertEqual(trend_threshold("pm25"), 1.0)
        self.assertEqual(trend_threshold("PM2.5"), 1.0)

    def test_pm10_threshold(self):
        """PM10 has threshold of 2.0."""
        self.assertEqual(trend_threshold("pm10"), 2.0)

    def test_ozone_threshold(self):
        """Ozone has threshold of 2.0."""
        self.assertEqual(trend_threshold("ozone"), 2.0)

    def test_unknown_default(self):
        """Unknown pollutant uses default threshold."""
        self.assertEqual(trend_threshold("UNKNOWN"), 1.0)


class TestFilterHistoryOutliers(unittest.TestCase):
    """Test history outlier filtering."""

    def test_normal_values_unchanged(self):
        """Normal values pass through unchanged."""
        values = [10.0, 12.0, 11.0, 13.0]
        colors = ["#00ff00"] * 4
        filtered_vals, filtered_cols, removed = filter_history_outliers("PM25", values, colors)
        self.assertEqual(filtered_vals, values)
        self.assertEqual(filtered_cols, colors)
        self.assertEqual(removed, [])

    def test_removes_extreme_pm25(self):
        """Extreme PM2.5 values (>999) are removed."""
        values = [10.0, 1500.0, 12.0]
        colors = ["#00ff00", "#ff0000", "#00ff00"]
        filtered_vals, filtered_cols, removed = filter_history_outliers("PM25", values, colors)
        self.assertEqual(len(filtered_vals), 2)
        self.assertNotIn(1500.0, filtered_vals)
        self.assertIn(1500.0, removed)

    def test_removes_extreme_ozone(self):
        """Extreme ozone values (>600 ppb) are removed."""
        values = [35.0, 778.0, 32.0]
        colors = ["#00ff00", "#ff0000", "#00ff00"]
        filtered_vals, filtered_cols, removed = filter_history_outliers("OZNE", values, colors)
        self.assertEqual(len(filtered_vals), 2)
        self.assertNotIn(778.0, filtered_vals)
        self.assertIn(778.0, removed)

    def test_removes_negative_values(self):
        """Negative values are removed."""
        values = [10.0, -5.0, 12.0]
        filtered_vals, _, removed = filter_history_outliers("PM25", values)
        self.assertNotIn(-5.0, filtered_vals)
        self.assertIn(-5.0, removed)

    def test_removes_non_numeric(self):
        """Non-numeric values are removed."""
        values = [10.0, "invalid", 12.0]
        filtered_vals, _, _ = filter_history_outliers("PM25", values)
        self.assertEqual(len(filtered_vals), 2)

    def test_empty_list(self):
        """Empty list returns empty."""
        filtered_vals, filtered_cols, removed = filter_history_outliers("PM25", [], [])
        self.assertEqual(filtered_vals, [])
        self.assertEqual(removed, [])

    def test_none_input(self):
        """None input returns empty."""
        filtered_vals, _, removed = filter_history_outliers("PM25", None)
        self.assertEqual(filtered_vals, [])
        self.assertEqual(removed, [])


if __name__ == "__main__":
    unittest.main()
