"""Tests for mobileair.db — SQLite persistence layer."""

from __future__ import annotations

import gzip
import json
import os
import sqlite3
import tempfile
import threading
import time
import unittest
from pathlib import Path

# Ensure the project root is importable
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mobileair.db import DbWorker, ReadPool, _apply_migrations, migrate_from_json


class TestSchemaCreation(unittest.TestCase):
    """Verify that a fresh database has all expected tables and indices."""

    def test_schema_creation(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "test.db"
            conn = sqlite3.connect(str(db_path))
            conn.execute("PRAGMA journal_mode=WAL")
            _apply_migrations(conn)
            tables = {
                row[0]
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
            }
            expected = {
                "readings",
                "trail_points",
                "wind_snapshots",
                "daily_snapshots",
                "client_analytics",
                "schema_version",
            }
            self.assertTrue(expected.issubset(tables), f"Missing tables: {expected - tables}")

            # Check schema version
            ver = conn.execute("SELECT MAX(version) FROM schema_version").fetchone()[0]
            self.assertEqual(ver, 1)
            conn.close()


class TestDbWorkerReadings(unittest.TestCase):
    """Test enqueue_reading and query_readings."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.db_path = Path(self.tmpdir) / "test.db"
        self.worker = DbWorker(self.db_path)
        self.worker.start()

    def tearDown(self):
        self.worker.stop()
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_enqueue_and_query_reading(self):
        self.worker.enqueue_reading(
            sensor_id="mobile:UTA-1074",
            source="mobile",
            ts=1700000000.0,
            lat=40.76,
            lon=-111.89,
            pollutant="pm2.5",
            value=12.5,
            aqi=51.0,
            color="#FFFF00",
        )
        # Force flush
        self.worker.stop()
        self.worker.start()
        time.sleep(0.2)

        rows = self.worker.query_readings(sensor_id="mobile:UTA-1074")
        self.assertGreaterEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["sensor_id"], "mobile:UTA-1074")
        self.assertEqual(row["source"], "mobile")
        self.assertAlmostEqual(row["value"], 12.5)

    def test_query_by_source(self):
        self.worker.enqueue_reading(
            sensor_id="pa:12345", source="purpleair",
            ts=1700000001.0, lat=40.7, lon=-111.8,
            pollutant="pm2.5", value=8.0,
        )
        self.worker.enqueue_reading(
            sensor_id="fixed:Rose_Park", source="fixed",
            ts=1700000002.0, lat=40.8, lon=-111.9,
            pollutant="ozone", value=0.05,
        )
        self.worker.stop()
        self.worker.start()
        time.sleep(0.2)

        pa_rows = self.worker.query_readings(source="purpleair")
        self.assertTrue(any(r["sensor_id"] == "pa:12345" for r in pa_rows))


class TestDbWorkerTrailPoints(unittest.TestCase):
    """Test enqueue_trail_points and query_trail_since."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.db_path = Path(self.tmpdir) / "test.db"
        self.worker = DbWorker(self.db_path)
        self.worker.start()

    def tearDown(self):
        self.worker.stop()
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_enqueue_and_query_trail(self):
        points = [
            ("mobile:UTA-1074", 1700000000.0, 40.76, -111.89, 12.5, "#FFFF00", 0),
            ("mobile:UTA-1074", 1700000060.0, 40.77, -111.88, 15.0, "#FF7E00", 1),
            ("mobile:UTA-1074", 1700000120.0, 40.78, -111.87, 10.0, "#00E400", 0),
        ]
        self.worker.enqueue_trail_points(points)
        self.worker.stop()
        self.worker.start()
        time.sleep(0.2)

        rows = self.worker.query_trail_since("mobile:UTA-1074", 1700000050.0)
        self.assertEqual(len(rows), 2)
        self.assertAlmostEqual(rows[0]["ts"], 1700000060.0)


class TestDbWorkerWindSnapshots(unittest.TestCase):
    """Test wind snapshot roundtrip (gzip-compressed)."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.db_path = Path(self.tmpdir) / "test.db"
        self.worker = DbWorker(self.db_path)
        self.worker.start()

    def tearDown(self):
        self.worker.stop()
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_wind_snapshot_roundtrip(self):
        points = [
            {"lat": 40.76, "lon": -111.89, "u": 2.5, "v": -1.3},
            {"lat": 40.77, "lon": -111.88, "u": 3.1, "v": 0.8},
        ]
        self.worker.enqueue_wind_snapshot("1430", "20260324", points)
        self.worker.stop()
        self.worker.start()
        time.sleep(0.2)

        result = self.worker.get_wind_snapshots("20260324")
        self.assertIn("1430", result)
        self.assertEqual(len(result["1430"]), 2)
        self.assertAlmostEqual(result["1430"][0]["u"], 2.5)


class TestDbWorkerDailySnapshots(unittest.TestCase):
    """Test daily snapshot roundtrip (gzip-compressed)."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.db_path = Path(self.tmpdir) / "test.db"
        self.worker = DbWorker(self.db_path)
        self.worker.start()

    def tearDown(self):
        self.worker.stop()
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_daily_snapshot_roundtrip(self):
        state = {
            "ts": 1700000000.0,
            "mobile": [{"id": "UTA-1074", "lat": 40.76, "lon": -111.89}],
            "fixed": [{"id": "Rose_Park"}],
            "meta": {"server_start_ts": 1699999000.0},
        }
        self.worker.save_daily_snapshot("2024-11-14", state)
        self.worker.stop()
        self.worker.start()
        time.sleep(0.2)

        loaded = self.worker.get_daily_snapshot("2024-11-14")
        self.assertIsNotNone(loaded)
        self.assertEqual(loaded["ts"], 1700000000.0)
        self.assertEqual(len(loaded["mobile"]), 1)

    def test_list_daily_snapshots(self):
        self.worker.save_daily_snapshot("2024-11-14", {"ts": 1, "mobile": [{"id": "x"}], "fixed": []})
        self.worker.save_daily_snapshot("2024-11-15", {"ts": 2, "mobile": [{"id": "y"}], "fixed": []})
        self.worker.stop()
        self.worker.start()
        time.sleep(0.2)

        listing = self.worker.list_daily_snapshots()
        dates = [s["date"] for s in listing]
        self.assertIn("2024-11-14", dates)
        self.assertIn("2024-11-15", dates)

    def test_snapshot_not_found(self):
        result = self.worker.get_daily_snapshot("1999-01-01")
        self.assertIsNone(result)


class TestDbWorkerBatching(unittest.TestCase):
    """Verify that the writer batches commits correctly."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.db_path = Path(self.tmpdir) / "test.db"
        self.worker = DbWorker(self.db_path)
        self.worker.start()

    def tearDown(self):
        self.worker.stop()
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_many_items_flushed(self):
        """Enqueue 300 items (over the batch size) and verify they're all persisted."""
        for i in range(300):
            self.worker.enqueue_reading(
                sensor_id=f"test:{i}",
                source="test",
                ts=1700000000.0 + i,
                lat=40.0,
                lon=-111.0,
                pollutant="pm2.5",
                value=float(i),
            )
        # Stop flushes everything
        self.worker.stop()
        self.worker.start()
        time.sleep(0.2)

        rows = self.worker.query_readings(source="test", limit=500)
        self.assertEqual(len(rows), 300)


class TestReadPoolConcurrent(unittest.TestCase):
    """Verify that multiple threads can read concurrently."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.db_path = Path(self.tmpdir) / "test.db"
        self.worker = DbWorker(self.db_path)
        self.worker.start()
        # Insert some data
        for i in range(10):
            self.worker.enqueue_reading(
                sensor_id=f"test:{i}", source="test",
                ts=1700000000.0 + i, lat=40.0, lon=-111.0,
                pollutant="pm2.5", value=float(i),
            )
        self.worker.stop()
        self.worker.start()
        time.sleep(0.2)

    def tearDown(self):
        self.worker.stop()
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_concurrent_reads(self):
        results = [None] * 5
        errors = []

        def read_thread(idx):
            try:
                rows = self.worker.query_readings(source="test")
                results[idx] = len(rows)
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=read_thread, args=(i,)) for i in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=5)

        self.assertEqual(errors, [])
        for r in results:
            self.assertEqual(r, 10)


class TestMigrateFromJson(unittest.TestCase):
    """Test one-time JSON → SQLite migration."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.data_dir = Path(self.tmpdir) / "data"
        self.data_dir.mkdir()
        self.db_path = self.data_dir / "dustytrails.db"
        self.worker = DbWorker(self.db_path)
        self.worker.start()

    def tearDown(self):
        self.worker.stop()
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_migrate_daily_snapshots(self):
        # Create a mock snapshot file
        snap_dir = self.data_dir / "snapshots"
        snap_dir.mkdir()
        state = {"ts": 1700000000.0, "mobile": [{"id": "x"}], "fixed": [{"id": "y"}]}
        (snap_dir / "2024-11-14.json").write_text(json.dumps(state))

        migrate_from_json(self.worker, self.data_dir)
        self.worker.stop()
        self.worker.start()
        time.sleep(0.3)

        loaded = self.worker.get_daily_snapshot("2024-11-14")
        self.assertIsNotNone(loaded)
        self.assertEqual(loaded["ts"], 1700000000.0)

    def test_migrate_wind_snapshots(self):
        wind_dir = self.data_dir / "wind_snapshots"
        wind_dir.mkdir()
        snap_data = {"ts": 1700000000.0, "analysis_time": "2024-11-14T14:30:00Z",
                     "count": 2, "points": [{"lat": 40.76, "lon": -111.89, "u": 1.0, "v": 2.0}]}
        (wind_dir / "1430.json").write_text(json.dumps(snap_data))

        migrate_from_json(self.worker, self.data_dir)
        self.worker.stop()
        self.worker.start()
        time.sleep(0.3)

        # Wind snapshots use today's date as the key
        import datetime
        try:
            from zoneinfo import ZoneInfo
            mt = ZoneInfo("America/Denver")
        except ImportError:
            mt = None
        if mt:
            today = datetime.datetime.now(mt).strftime("%Y%m%d")
            result = self.worker.get_wind_snapshots(today)
            self.assertIn("1430", result)

    def test_migration_marker_prevents_rerun(self):
        snap_dir = self.data_dir / "snapshots"
        snap_dir.mkdir()
        state = {"ts": 1, "mobile": [{"id": "a"}], "fixed": []}
        (snap_dir / "2024-01-01.json").write_text(json.dumps(state))

        # First run
        migrate_from_json(self.worker, self.data_dir)
        # Marker should exist
        self.assertTrue((self.data_dir / ".db_migrated").exists())

        # Second run should skip
        migrate_from_json(self.worker, self.data_dir)  # no error


class TestAnalytics(unittest.TestCase):
    """Test analytics enqueue."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.db_path = Path(self.tmpdir) / "test.db"
        self.worker = DbWorker(self.db_path)
        self.worker.start()

    def tearDown(self):
        self.worker.stop()
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_enqueue_analytics(self):
        events = [
            {"type": "pa_field_cache", "payload": {"key": "test"}},
            {"type": "view_duration", "payload": {"ms": 30000}},
        ]
        self.worker.enqueue_analytics("client-abc", events)
        self.worker.stop()
        self.worker.start()
        time.sleep(0.2)

        # Query directly
        assert self.worker.read_pool is not None
        with self.worker.read_pool.connection() as conn:
            rows = conn.execute("SELECT * FROM client_analytics").fetchall()
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["client_id"], "client-abc")


if __name__ == "__main__":
    unittest.main()
