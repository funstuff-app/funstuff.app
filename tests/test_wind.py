"""Tests for mobileair.wind — RTMA-RU wind field fetcher."""

import json
import unittest
from datetime import datetime, timezone
from unittest.mock import patch, MagicMock
from pathlib import Path
import tempfile


class TestHelpers(unittest.TestCase):
    """Unit tests for pure-logic helpers — no network, no cfgrib."""

    def test_round_to_15min(self):
        from mobileair.wind import _round_to_15min
        dt = datetime(2026, 3, 20, 15, 37, 42, tzinfo=timezone.utc)
        result = _round_to_15min(dt)
        self.assertEqual(result.minute, 30)
        self.assertEqual(result.second, 0)
        self.assertEqual(result.microsecond, 0)

    def test_round_to_15min_exact(self):
        from mobileair.wind import _round_to_15min
        dt = datetime(2026, 3, 20, 12, 0, 0, tzinfo=timezone.utc)
        result = _round_to_15min(dt)
        self.assertEqual(result.minute, 0)

    def test_round_to_15min_just_before(self):
        from mobileair.wind import _round_to_15min
        dt = datetime(2026, 3, 20, 12, 14, 59, tzinfo=timezone.utc)
        result = _round_to_15min(dt)
        self.assertEqual(result.minute, 0)

    def test_build_nomads_url(self):
        from mobileair.wind import _build_nomads_url
        dt = datetime(2026, 3, 20, 14, 30, 0, tzinfo=timezone.utc)
        url = _build_nomads_url(dt)
        self.assertIn("rtma2p5_ru.20260320", url)
        self.assertIn("rtma2p5_ru.t1430z", url)
        self.assertIn("2dvaranl_ndfd.grb2", url)
        self.assertIn("var_UGRD=on", url)
        self.assertIn("var_VGRD=on", url)
        self.assertIn("lev_10_m_above_ground=on", url)
        # subregion key must be present with empty value
        self.assertIn("subregion=", url)
        self.assertIn("toplat=41.5", url)
        self.assertIn("bottomlat=39.5", url)
        self.assertIn("leftlon=-113", url)
        self.assertIn("rightlon=-111", url)

    def test_build_nomads_url_midnight(self):
        from mobileair.wind import _build_nomads_url
        dt = datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
        url = _build_nomads_url(dt)
        self.assertIn("rtma2p5_ru.t0000z", url)
        self.assertIn("rtma2p5_ru.20260101", url)


class TestSaveLoad(unittest.TestCase):
    """Test the JSON cache layer."""

    def test_save_load_roundtrip(self):
        from mobileair.wind import save_wind_field, load_wind_field
        points = [
            {"lat": 40.7, "lon": -111.9, "u": 1.5, "v": -0.3},
            {"lat": 40.8, "lon": -111.8, "u": 2.0, "v": 0.1},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            save_wind_field(points, data_dir)
            loaded = load_wind_field(data_dir)

            self.assertIsNotNone(loaded)
            self.assertEqual(loaded["count"], 2)
            self.assertEqual(len(loaded["points"]), 2)
            self.assertAlmostEqual(loaded["points"][0]["u"], 1.5)

    def test_load_missing(self):
        from mobileair.wind import load_wind_field
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(load_wind_field(Path(tmp)))

    def test_load_corrupt(self):
        from mobileair.wind import load_wind_field
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "wind_field.json"
            p.write_text("not json!!!")
            self.assertIsNone(load_wind_field(Path(tmp)))


class TestFetchGrib2(unittest.TestCase):
    """Test fetch_grib2 with mocked HTTP."""

    @patch("mobileair.wind.urllib.request.urlopen")
    def test_html_response_returns_none(self, mock_urlopen):
        from mobileair.wind import fetch_grib2
        mock_resp = MagicMock()
        mock_resp.__enter__ = MagicMock(return_value=mock_resp)
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_resp.headers = {"Content-Type": "text/html; charset=utf-8"}
        mock_resp.read.return_value = b"<html>File not found</html>"
        mock_urlopen.return_value = mock_resp

        result = fetch_grib2(datetime(2026, 3, 20, 14, 0, tzinfo=timezone.utc))
        self.assertIsNone(result)

    @patch("mobileair.wind.urllib.request.urlopen")
    def test_small_response_returns_none(self, mock_urlopen):
        from mobileair.wind import fetch_grib2
        mock_resp = MagicMock()
        mock_resp.__enter__ = MagicMock(return_value=mock_resp)
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_resp.headers = {"Content-Type": "application/octet-stream"}
        mock_resp.read.return_value = b"tiny"
        mock_urlopen.return_value = mock_resp

        result = fetch_grib2(datetime(2026, 3, 20, 14, 0, tzinfo=timezone.utc))
        self.assertIsNone(result)

    @patch("mobileair.wind.urllib.request.urlopen")
    def test_successful_fetch(self, mock_urlopen):
        from mobileair.wind import fetch_grib2
        fake_grib = b"\x00" * 500  # Just needs to be >100 bytes
        mock_resp = MagicMock()
        mock_resp.__enter__ = MagicMock(return_value=mock_resp)
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_resp.headers = {"Content-Type": "application/octet-stream"}
        mock_resp.read.return_value = fake_grib
        mock_urlopen.return_value = mock_resp

        result = fetch_grib2(datetime(2026, 3, 20, 14, 0, tzinfo=timezone.utc))
        self.assertEqual(result, fake_grib)

    @patch("mobileair.wind.urllib.request.urlopen")
    def test_network_error_returns_none(self, mock_urlopen):
        from mobileair.wind import fetch_grib2
        import urllib.error
        mock_urlopen.side_effect = urllib.error.URLError("Connection refused")

        result = fetch_grib2(datetime(2026, 3, 20, 14, 0, tzinfo=timezone.utc))
        self.assertIsNone(result)


class TestParseGrib2(unittest.TestCase):
    """Test parse_grib2 with mocked xarray."""

    def test_parse_with_mock_dataset(self):
        """Test parsing with a mock xarray dataset."""
        import numpy as np
        from mobileair.wind import parse_grib2

        # Create a mock dataset
        mock_ds = MagicMock()
        mock_ds.data_vars = ["u10", "v10"]
        mock_ds.__contains__ = lambda self, key: key in ["u10", "v10", "latitude", "longitude"]

        # 3x3 grid
        lats = np.array([[40.0, 40.0, 40.0],
                         [40.5, 40.5, 40.5],
                         [41.0, 41.0, 41.0]])
        lons = np.array([[247.0, 248.0, 249.0],  # 0-360 encoding
                         [247.0, 248.0, 249.0],
                         [247.0, 248.0, 249.0]])
        u_data = np.array([[1.0, 2.0, 3.0],
                           [1.5, 2.5, 3.5],
                           [1.0, 2.0, 3.0]])
        v_data = np.array([[-0.5, -0.3, -0.1],
                           [0.0, 0.2, 0.4],
                           [0.5, 0.7, 0.9]])

        mock_ds.__getitem__ = lambda self, key: {
            "u10": MagicMock(values=u_data),
            "v10": MagicMock(values=v_data),
            "latitude": MagicMock(values=lats),
            "longitude": MagicMock(values=lons),
        }[key]

        with patch("xarray.open_dataset", return_value=mock_ds):
            result = parse_grib2(b"\x00" * 100)

        self.assertEqual(len(result), 9)
        # Check longitude conversion: 247 - 360 = -113
        self.assertAlmostEqual(result[0]["lon"], -113.0, places=1)
        self.assertAlmostEqual(result[0]["lat"], 40.0, places=1)
        self.assertAlmostEqual(result[0]["u"], 1.0)
        self.assertAlmostEqual(result[0]["v"], -0.5)


if __name__ == "__main__":
    unittest.main()
