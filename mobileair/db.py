"""SQLite persistence layer for DustyTrails.

Provides:
- Schema creation and versioned migrations
- DbWorker — background writer thread with queue-based batching
- ReadPool — concurrent read-only connection pool for HTTP handler threads
- JSON-to-SQLite first-run migration from legacy file-based storage
"""

from __future__ import annotations

import gzip
import json
import logging
import queue
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Generator

from mobileair.config import (
    DB_READ_POOL_SIZE,
    DB_WAL_CHECKPOINT_INTERVAL_S,
    DB_WRITE_BATCH_SIZE,
    DB_WRITE_FLUSH_INTERVAL_S,
    DB_PRUNE_BATCH_SIZE,
    DB_RETENTION_DAYS,
)

log = logging.getLogger("dustytrails.db")

# ── Schema ────────────────────────────────────────────────────────────────────

_SCHEMA_V1 = """
-- Unified sensor readings (mobile, fixed, PA, AirNow)
CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY,
    sensor_id TEXT NOT NULL,
    source TEXT NOT NULL,
    ts REAL NOT NULL,
    lat REAL,
    lon REAL,
    pollutant TEXT NOT NULL,
    value REAL,
    aqi REAL,
    color TEXT,
    meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_readings_sensor_ts ON readings(sensor_id, ts);
CREATE INDEX IF NOT EXISTS idx_readings_source_ts ON readings(source, ts);
CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings(ts);

-- Trail breadcrumbs (mobile sensors only, high-volume)
CREATE TABLE IF NOT EXISTS trail_points (
    id INTEGER PRIMARY KEY,
    sensor_id TEXT NOT NULL,
    ts REAL NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    value REAL,
    color TEXT,
    snapped INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_trail_sensor_ts ON trail_points(sensor_id, ts);

-- Wind field snapshots (RTMA-RU, ~7920 points per 15-min snapshot)
CREATE TABLE IF NOT EXISTS wind_snapshots (
    key TEXT NOT NULL,
    date TEXT NOT NULL,
    ts REAL NOT NULL,
    point_count INTEGER,
    data BLOB NOT NULL,
    PRIMARY KEY (key, date)
);

-- Daily snapshot cache (replaces JSON files in snapshots/)
CREATE TABLE IF NOT EXISTS daily_snapshots (
    date TEXT PRIMARY KEY,
    ts REAL NOT NULL,
    data BLOB NOT NULL,
    size_bytes INTEGER
);

-- Analytics contributions from clients
CREATE TABLE IF NOT EXISTS client_analytics (
    id INTEGER PRIMARY KEY,
    client_id TEXT,
    ts REAL NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT
);
CREATE INDEX IF NOT EXISTS idx_analytics_ts ON client_analytics(ts);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at REAL NOT NULL
);
"""

_MIGRATIONS: dict[int, str] = {
    1: _SCHEMA_V1,
}

_CURRENT_VERSION = max(_MIGRATIONS)


def _apply_migrations(conn: sqlite3.Connection) -> None:
    """Apply any pending schema migrations."""
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_version "
        "(version INTEGER PRIMARY KEY, applied_at REAL NOT NULL)"
    )
    row = conn.execute("SELECT MAX(version) FROM schema_version").fetchone()
    current = row[0] if row and row[0] is not None else 0

    for ver in sorted(_MIGRATIONS):
        if ver > current:
            log.info("[DB] Applying migration v%d", ver)
            conn.executescript(_MIGRATIONS[ver])
            conn.execute(
                "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)",
                (ver, time.time()),
            )
            conn.commit()
    log.info("[DB] Schema at v%d", _CURRENT_VERSION)


def _configure_connection(conn: sqlite3.Connection) -> None:
    """Apply WAL mode and performance pragmas."""
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA cache_size=-8000")  # 8 MB
    conn.execute("PRAGMA temp_store=MEMORY")
    conn.execute("PRAGMA mmap_size=67108864")  # 64 MB mmap


# ── ReadPool ──────────────────────────────────────────────────────────────────


class ReadPool:
    """Pool of read-only SQLite connections for concurrent HTTP handler threads.

    Usage::

        with pool.connection() as conn:
            rows = conn.execute("SELECT ...").fetchall()
    """

    def __init__(self, db_path: Path, size: int = DB_READ_POOL_SIZE) -> None:
        self._db_path = db_path
        self._pool: queue.Queue[sqlite3.Connection] = queue.Queue(maxsize=size)
        for _ in range(size):
            uri = f"file:{db_path}?mode=ro"
            conn = sqlite3.connect(uri, uri=True, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA query_only=ON")
            self._pool.put(conn)

    @contextmanager
    def connection(self) -> Generator[sqlite3.Connection, None, None]:
        conn = self._pool.get(timeout=10)
        try:
            yield conn
        finally:
            self._pool.put(conn)

    def close(self) -> None:
        while not self._pool.empty():
            try:
                conn = self._pool.get_nowait()
                conn.close()
            except queue.Empty:
                break


# ── DbWorker ──────────────────────────────────────────────────────────────────

# Sentinel to signal the writer thread to stop.
_STOP = object()


class DbWorker:
    """Background writer thread with batched commits.

    All writes go through an in-process queue and are committed in batches
    (every ``DB_WRITE_FLUSH_INTERVAL_S`` seconds or ``DB_WRITE_BATCH_SIZE``
    items, whichever comes first).  Reads use a separate ``ReadPool``.
    """

    def __init__(self, db_path: Path) -> None:
        self._db_path = Path(db_path)
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._queue: queue.Queue = queue.Queue()
        self._thread: threading.Thread | None = None
        self._write_conn: sqlite3.Connection | None = None
        self.read_pool: ReadPool | None = None
        self._started = False

        # Bootstrap schema on the write connection so ReadPool can open
        conn = sqlite3.connect(str(self._db_path), check_same_thread=False)
        _configure_connection(conn)
        _apply_migrations(conn)
        conn.close()

    def start(self) -> None:
        """Spawn the background writer thread and open the read pool."""
        if self._started:
            return
        self._write_conn = sqlite3.connect(
            str(self._db_path), check_same_thread=False
        )
        _configure_connection(self._write_conn)
        self._write_conn.row_factory = sqlite3.Row
        self.read_pool = ReadPool(self._db_path)
        self._thread = threading.Thread(
            target=self._writer_loop, name="db-writer", daemon=True
        )
        self._thread.start()
        self._started = True
        log.info("[DB] DbWorker started — %s", self._db_path)

    def stop(self, timeout: float = 10.0) -> None:
        """Flush remaining writes and shut down."""
        if not self._started:
            return
        self._queue.put(_STOP)
        if self._thread:
            self._thread.join(timeout=timeout)
        if self._write_conn:
            try:
                self._write_conn.close()
            except Exception:
                pass
        if self.read_pool:
            self.read_pool.close()
        self._started = False
        log.info("[DB] DbWorker stopped")

    # ── Write API (enqueue) ───────────────────────────────────────────────

    def enqueue_reading(
        self,
        sensor_id: str,
        source: str,
        ts: float,
        lat: float | None,
        lon: float | None,
        pollutant: str,
        value: float | None,
        aqi: float | None = None,
        color: str | None = None,
        meta: dict | None = None,
    ) -> None:
        self._queue.put(
            (
                "reading",
                (
                    sensor_id,
                    source,
                    ts,
                    lat,
                    lon,
                    pollutant,
                    value,
                    aqi,
                    color,
                    json.dumps(meta) if meta else None,
                ),
            )
        )

    def enqueue_trail_points(
        self, points: list[tuple[str, float, float, float, float | None, str | None, int]]
    ) -> None:
        """Enqueue a batch of trail points.

        Each tuple: (sensor_id, ts, lat, lon, value, color, snapped).
        """
        for pt in points:
            self._queue.put(("trail", pt))

    def enqueue_wind_snapshot(
        self, key: str, date: str, points: list[dict[str, float]]
    ) -> None:
        """Enqueue a wind snapshot (gzip-compressed on the writer thread)."""
        self._queue.put(("wind", (key, date, time.time(), points)))

    def enqueue_analytics(
        self, client_id: str | None, events: list[dict[str, Any]]
    ) -> None:
        for ev in events:
            self._queue.put(
                (
                    "analytics",
                    (
                        client_id,
                        time.time(),
                        ev.get("type", "unknown"),
                        json.dumps(ev.get("payload")) if ev.get("payload") else None,
                    ),
                )
            )

    def save_daily_snapshot(self, date: str, state: dict[str, Any]) -> None:
        """Compress and store a daily snapshot (called from main thread)."""
        raw = json.dumps(state, separators=(",", ":"), allow_nan=False, default=str)
        blob = gzip.compress(raw.encode("utf-8"), compresslevel=6)
        self._queue.put(("snapshot", (date, time.time(), blob, len(raw))))

    # ── Read API (direct SELECT on ReadPool) ──────────────────────────────

    def query_readings(
        self,
        *,
        source: str | None = None,
        sensor_id: str | None = None,
        since_ts: float | None = None,
        limit: int = 10000,
    ) -> list[dict[str, Any]]:
        assert self.read_pool is not None
        clauses: list[str] = []
        params: list[Any] = []
        if source:
            clauses.append("source = ?")
            params.append(source)
        if sensor_id:
            clauses.append("sensor_id = ?")
            params.append(sensor_id)
        if since_ts is not None:
            clauses.append("ts >= ?")
            params.append(since_ts)
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        sql = f"SELECT * FROM readings{where} ORDER BY ts DESC LIMIT ?"
        params.append(limit)
        with self.read_pool.connection() as conn:
            rows = conn.execute(sql, params).fetchall()
            return [dict(r) for r in rows]

    def query_fixed_readings_since(
        self, since_ts: float
    ) -> list[dict[str, Any]]:
        """Return all non-mobile readings since *since_ts*, ordered by ts ascending."""
        assert self.read_pool is not None
        with self.read_pool.connection() as conn:
            rows = conn.execute(
                "SELECT sensor_id, pollutant, value, color, ts, meta "
                "FROM readings WHERE source != 'mobile' AND ts >= ? "
                "ORDER BY ts",
                (since_ts,),
            ).fetchall()
            return [dict(r) for r in rows]

    def query_trail_since(
        self, sensor_id: str, since_ts: float
    ) -> list[dict[str, Any]]:
        assert self.read_pool is not None
        with self.read_pool.connection() as conn:
            rows = conn.execute(
                "SELECT * FROM trail_points WHERE sensor_id = ? AND ts >= ? ORDER BY ts",
                (sensor_id, since_ts),
            ).fetchall()
            return [dict(r) for r in rows]

    def get_wind_snapshots(self, date: str) -> dict[str, Any]:
        """Load all wind snapshots for a given date.

        Returns ``{HHMM: grid_or_points}`` where each value is either
        a grid dict (``{gw, gh, bounds, uGrid, vGrid}``) for new data
        or a legacy point list for older entries.
        """
        assert self.read_pool is not None
        with self.read_pool.connection() as conn:
            rows = conn.execute(
                "SELECT key, data FROM wind_snapshots WHERE date = ? ORDER BY key",
                (date,),
            ).fetchall()
        result: dict[str, Any] = {}
        for row in rows:
            try:
                raw = gzip.decompress(bytes(row["data"]))
                result[row["key"]] = json.loads(raw)
            except Exception as e:
                log.warning("[DB] Bad wind snapshot %s: %s", row["key"], e)
        return result

    def get_daily_snapshot(self, date: str) -> dict[str, Any] | None:
        assert self.read_pool is not None
        with self.read_pool.connection() as conn:
            row = conn.execute(
                "SELECT data FROM daily_snapshots WHERE date = ?", (date,)
            ).fetchone()
        if row is None:
            return None
        try:
            raw = gzip.decompress(bytes(row["data"]))
            return json.loads(raw)
        except Exception as e:
            log.warning("[DB] Bad daily snapshot %s: %s", date, e)
            return None

    def list_daily_snapshots(self) -> list[dict[str, Any]]:
        """Return metadata for all stored daily snapshots."""
        assert self.read_pool is not None
        with self.read_pool.connection() as conn:
            rows = conn.execute(
                "SELECT date, ts, size_bytes FROM daily_snapshots ORDER BY date DESC"
            ).fetchall()
            return [dict(r) for r in rows]

    def has_readings_for_date(
        self, sensor_prefix: str, ts_start: float, ts_end: float
    ) -> bool:
        """Check whether any sensor matching *sensor_prefix* has readings in [ts_start, ts_end).

        Handles both new sensor_id format (e.g. ``PA_4059``) and the legacy
        prefixed format from ``_enqueue_state_to_db`` (e.g. ``pa:PA_4059``).
        """
        assert self.read_pool is not None
        with self.read_pool.connection() as conn:
            row = conn.execute(
                "SELECT 1 FROM readings "
                "WHERE (sensor_id LIKE ? OR sensor_id LIKE ?) "
                "AND ts >= ? AND ts < ? LIMIT 1",
                (
                    f"{sensor_prefix}%",
                    f"pa:{sensor_prefix}%",
                    ts_start,
                    ts_end,
                ),
            ).fetchone()
        return row is not None

    # ── Archival & pruning ────────────────────────────────────────────────

    def archive_month(self, year: int, month: int, archive_dir: Path) -> Path | None:
        """Export one calendar month of data to a standalone gzip'd SQLite file.

        Returns the archive path on success, None on failure.
        """
        import calendar

        archive_dir.mkdir(parents=True, exist_ok=True)
        archive_name = f"dustytrails-{year:04d}-{month:02d}.db.gz"
        archive_path = archive_dir / archive_name
        if archive_path.exists():
            log.info("[DB] Archive already exists: %s", archive_path)
            return archive_path

        # Month boundaries (UTC epoch)
        _, last_day = calendar.monthrange(year, month)
        from datetime import datetime, timezone
        ts_start = datetime(year, month, 1, tzinfo=timezone.utc).timestamp()
        if month == 12:
            ts_end = datetime(year + 1, 1, 1, tzinfo=timezone.utc).timestamp()
        else:
            ts_end = datetime(year, month + 1, 1, tzinfo=timezone.utc).timestamp()
        date_prefix = f"{year:04d}-{month:02d}"
        date_compact_prefix = f"{year:04d}{month:02d}"

        tmp_path = archive_dir / f".tmp_{archive_name.replace('.gz', '')}"
        try:
            # Create archive DB with same schema
            arc_conn = sqlite3.connect(str(tmp_path))
            _configure_connection(arc_conn)
            _apply_migrations(arc_conn)

            assert self.read_pool is not None
            with self.read_pool.connection() as src:
                # readings
                rows = src.execute(
                    "SELECT sensor_id, source, ts, lat, lon, pollutant, value, aqi, color, meta "
                    "FROM readings WHERE ts >= ? AND ts < ?",
                    (ts_start, ts_end),
                ).fetchall()
                arc_conn.executemany(
                    "INSERT INTO readings "
                    "(sensor_id, source, ts, lat, lon, pollutant, value, aqi, color, meta) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    rows,
                )
                readings_count = len(rows)

                # trail_points
                rows = src.execute(
                    "SELECT sensor_id, ts, lat, lon, value, color, snapped "
                    "FROM trail_points WHERE ts >= ? AND ts < ?",
                    (ts_start, ts_end),
                ).fetchall()
                arc_conn.executemany(
                    "INSERT INTO trail_points "
                    "(sensor_id, ts, lat, lon, value, color, snapped) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    rows,
                )

                # wind_snapshots (date column is YYYYMMDD string)
                rows = src.execute(
                    "SELECT key, date, ts, point_count, data "
                    "FROM wind_snapshots WHERE date LIKE ?",
                    (f"{date_compact_prefix}%",),
                ).fetchall()
                arc_conn.executemany(
                    "INSERT INTO wind_snapshots "
                    "(key, date, ts, point_count, data) VALUES (?, ?, ?, ?, ?)",
                    rows,
                )

                # daily_snapshots (date column is YYYY-MM-DD)
                rows = src.execute(
                    "SELECT date, ts, data, size_bytes "
                    "FROM daily_snapshots WHERE date LIKE ?",
                    (f"{date_prefix}%",),
                ).fetchall()
                arc_conn.executemany(
                    "INSERT OR REPLACE INTO daily_snapshots "
                    "(date, ts, data, size_bytes) VALUES (?, ?, ?, ?)",
                    rows,
                )

            arc_conn.commit()
            arc_conn.close()

            # Gzip the archive
            import shutil
            with open(tmp_path, "rb") as f_in:
                with gzip.open(str(archive_path), "wb", compresslevel=6) as f_out:
                    shutil.copyfileobj(f_in, f_out)
            tmp_path.unlink()

            log.info(
                "[DB] Archived %d readings for %s to %s",
                readings_count, date_prefix, archive_path,
            )
            return archive_path
        except Exception as e:
            log.warning("[DB] Archive failed for %s: %s", date_prefix, e)
            if tmp_path.exists():
                tmp_path.unlink(missing_ok=True)
            return None

    def prune_before(self, cutoff_ts: float) -> int:
        """Delete readings, trail_points, and analytics older than *cutoff_ts*.

        Deletes in batches to avoid long write-locks on the Pi.
        Returns the total number of rows deleted.
        """
        assert self._write_conn is not None
        conn = self._write_conn
        total = 0
        for table in ("readings", "trail_points", "client_analytics"):
            while True:
                cur = conn.execute(
                    f"DELETE FROM {table} WHERE rowid IN "
                    f"(SELECT rowid FROM {table} WHERE ts < ? LIMIT ?)",
                    (cutoff_ts, DB_PRUNE_BATCH_SIZE),
                )
                deleted = cur.rowcount
                conn.commit()
                total += deleted
                if deleted < DB_PRUNE_BATCH_SIZE:
                    break
                time.sleep(0.05)  # yield to writer thread

        # wind_snapshots uses date string (YYYYMMDD), not epoch ts
        from datetime import datetime, timezone
        cutoff_date = datetime.fromtimestamp(cutoff_ts, tz=timezone.utc).strftime("%Y%m%d")
        cur = conn.execute(
            "DELETE FROM wind_snapshots WHERE date < ?", (cutoff_date,)
        )
        conn.commit()
        total += cur.rowcount

        # Reclaim space gradually
        try:
            conn.execute("PRAGMA incremental_vacuum(100)")
        except Exception:
            pass

        log.info("[DB] Pruned %d rows older than %s", total, cutoff_date)
        return total

    def db_size_mb(self) -> float:
        """Return the current database file size in MB."""
        try:
            return self._db_path.stat().st_size / (1024 * 1024)
        except OSError:
            return 0.0

    # ── Writer loop ───────────────────────────────────────────────────────

    def _writer_loop(self) -> None:
        conn = self._write_conn
        assert conn is not None
        last_flush = time.time()
        last_checkpoint = time.time()
        pending = 0

        while True:
            try:
                item = self._queue.get(timeout=1.0)
            except queue.Empty:
                # Flush on idle if anything is pending
                if pending > 0:
                    conn.commit()
                    pending = 0
                    last_flush = time.time()
                # Periodic WAL checkpoint
                if time.time() - last_checkpoint > DB_WAL_CHECKPOINT_INTERVAL_S:
                    try:
                        conn.execute("PRAGMA wal_checkpoint(PASSIVE)")
                    except Exception as e:
                        log.warning("[DB] Checkpoint error: %s", e)
                    last_checkpoint = time.time()
                continue

            if item is _STOP:
                if pending > 0:
                    conn.commit()
                log.info("[DB] Writer flushed final %d items", pending)
                break

            try:
                kind, data = item
                self._execute_write(conn, kind, data)
                pending += 1
            except Exception as e:
                log.warning("[DB] Write error (%s): %s", item[0] if isinstance(item, tuple) else "?", e)

            # Batch commit policy
            now = time.time()
            if pending >= DB_WRITE_BATCH_SIZE or (now - last_flush) >= DB_WRITE_FLUSH_INTERVAL_S:
                conn.commit()
                pending = 0
                last_flush = now

            # Periodic WAL checkpoint
            if now - last_checkpoint > DB_WAL_CHECKPOINT_INTERVAL_S:
                try:
                    conn.execute("PRAGMA wal_checkpoint(PASSIVE)")
                except Exception as e:
                    log.warning("[DB] Checkpoint error: %s", e)
                last_checkpoint = now

    def _execute_write(
        self, conn: sqlite3.Connection, kind: str, data: tuple
    ) -> None:
        if kind == "reading":
            conn.execute(
                "INSERT INTO readings "
                "(sensor_id, source, ts, lat, lon, pollutant, value, aqi, color, meta) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                data,
            )
        elif kind == "trail":
            conn.execute(
                "INSERT INTO trail_points "
                "(sensor_id, ts, lat, lon, value, color, snapped) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                data,
            )
        elif kind == "wind":
            key, date, ts, points = data
            blob = gzip.compress(
                json.dumps(points, separators=(",", ":")).encode("utf-8"),
                compresslevel=6,
            )
            conn.execute(
                "INSERT OR REPLACE INTO wind_snapshots "
                "(key, date, ts, point_count, data) VALUES (?, ?, ?, ?, ?)",
                (key, date, ts, len(points), blob),
            )
        elif kind == "snapshot":
            date, ts, blob, raw_size = data
            conn.execute(
                "INSERT OR REPLACE INTO daily_snapshots "
                "(date, ts, data, size_bytes) VALUES (?, ?, ?, ?)",
                (date, ts, blob, raw_size),
            )
        elif kind == "analytics":
            conn.execute(
                "INSERT INTO client_analytics "
                "(client_id, ts, event_type, payload) VALUES (?, ?, ?, ?)",
                data,
            )
        else:
            log.warning("[DB] Unknown write kind: %s", kind)


# ── JSON-to-SQLite migration ─────────────────────────────────────────────────


def migrate_from_json(db_worker: DbWorker, data_dir: Path) -> None:
    """One-time import of legacy JSON files into SQLite.

    Idempotent: writes a ``.db_migrated`` marker file to skip on subsequent
    starts.  Does NOT delete the original JSON files.
    """
    marker = data_dir / ".db_migrated"
    if marker.exists():
        log.info("[DB] Migration marker found — skipping JSON import")
        return

    log.info("[DB] Starting JSON-to-SQLite migration...")
    imported = 0

    # 1. Daily snapshots  (snapshots/*.json)
    snapshots_dir = data_dir / "snapshots"
    if snapshots_dir.is_dir():
        for p in sorted(snapshots_dir.glob("*.json")):
            date_str = p.stem
            # Basic validation: expect YYYY-MM-DD
            if len(date_str) != 10 or date_str[4] != "-" or date_str[7] != "-":
                continue
            try:
                raw = p.read_text(encoding="utf-8")
                state = json.loads(raw)
                if isinstance(state, dict):
                    db_worker.save_daily_snapshot(date_str, state)
                    imported += 1
                    log.info("[DB] Imported snapshot %s", date_str)
            except Exception as e:
                log.warning("[DB] Failed to import snapshot %s: %s", p.name, e)

    # 2. Wind snapshots  (wind_snapshots/*.json)
    wind_dir = data_dir / "wind_snapshots"
    if wind_dir.is_dir():
        # Determine today's date string for the 'date' column
        import datetime

        try:
            from zoneinfo import ZoneInfo
            _mt = ZoneInfo("America/Denver")
        except ImportError:
            import pytz  # type: ignore[import-untyped]
            _mt = pytz.timezone("America/Denver")
        today_str = datetime.datetime.now(_mt).strftime("%Y%m%d")

        for p in sorted(wind_dir.glob("*.json")):
            key = p.stem
            if len(key) != 4 or not key.isdigit():
                continue
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                pts = data.get("points", [])
                if isinstance(pts, list) and pts:
                    db_worker.enqueue_wind_snapshot(key, today_str, pts)
                    imported += 1
            except Exception as e:
                log.warning("[DB] Failed to import wind snapshot %s: %s", p.name, e)

    # 3. Fixed history  (fixed_history.json)
    history_path = data_dir / "fixed_history.json"
    if history_path.exists():
        try:
            raw_bytes = history_path.read_bytes()
            if len(raw_bytes) < 500_000_000:  # skip if >500 MB
                history = json.loads(raw_bytes)
                if isinstance(history, dict):
                    count = 0
                    for sensor_id, pollutants in history.items():
                        if not isinstance(pollutants, dict):
                            continue
                        for pollutant, entries in pollutants.items():
                            if not isinstance(entries, list):
                                continue
                            for entry in entries:
                                if not isinstance(entry, dict):
                                    continue
                                ts = entry.get("recorded_at") or entry.get("time")
                                if ts is None:
                                    continue
                                try:
                                    ts = float(ts)
                                except (TypeError, ValueError):
                                    continue
                                db_worker.enqueue_reading(
                                    sensor_id=sensor_id,
                                    source="fixed",
                                    ts=ts,
                                    lat=None,
                                    lon=None,
                                    pollutant=pollutant,
                                    value=entry.get("val"),
                                    aqi=None,
                                    color=entry.get("col"),
                                    meta=None,
                                )
                                count += 1
                    imported += count
                    log.info("[DB] Imported %d fixed history readings", count)
        except Exception as e:
            log.warning("[DB] Failed to import fixed history: %s", e)

    # Write marker
    try:
        marker.write_text(f"migrated at {time.time()}\nimported {imported} items\n")
    except Exception:
        pass

    log.info("[DB] Migration complete — %d items imported", imported)
