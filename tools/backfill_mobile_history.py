#!/usr/bin/env python3
"""Backfill mobile-sensor gaps from the CHPC upstream week-long timeseries.

The upstream serves rolling 7-day files per sensor per variable:
    https://utahaq.chpc.utah.edu/jsondata/{SENSOR}_{VAR}_TS_10080.json
This tool rebuilds the exact state shape the live poller produces
(normalize_state_for_dashboard) from those files and patches it into the
local store, which has two layers per Mountain-time day (5 AM -> 5 AM):

  * daily_snapshots row in dustytrails.db (what /api/day serves)
  * snapshots/{date}.json on disk       (what load_today_snapshot boots from)

Existing data always wins: backfilled trail points are only added into
minute-buckets the stored trail does not cover. A snapshot date with no
stored state at all (the outage skipped its save) is created from scratch,
with the fixed-sensor side rebuilt from the DB readings table and sensor
identity taken from the nearest existing snapshot.

Run it against a MIRROR copy of the DB while the server is stopped; it never
deletes anything, and every blob/file it replaces is first copied into
--archive-dir/pre_patch/ so the patch can be reversed.

Subcommands:
  fetch   download all sensor/var files into --archive-dir (bank the data
          before the 7-day window slides past the gap)
  patch   apply the archive to a DB + snapshots dir (--dry-run supported)
  report  per-hour trail coverage of stored snapshots, for before/after diffs

Typical use:
  python3 tools/backfill_mobile_history.py fetch --archive-dir ~/.mobileair/history_backfill
  python3 tools/backfill_mobile_history.py patch --db mirror.db \
      --archive-dir ~/.mobileair/history_backfill \
      --snapshots-dir ~/.mobileair/snapshots --out-snapshots-dir staged_snaps \
      --dates 2026-07-08,2026-07-09,2026-07-10 --dry-run
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT))

from mobileair.aqi import color_to_idx, color_for_value  # noqa: E402
from mobileair.config import HEADERS  # noqa: E402
from mobileair.dashboard import (  # noqa: E402
    _pick_worst_reading_by_aqi,
    normalize_state_for_dashboard,
)
from mobileair.utils import parse_utc_timestamp  # noqa: E402

BASE_URL = "https://utahaq.chpc.utah.edu/jsondata"
SENSORS = [f"BUS{i:02d}" for i in range(1, 16)] + ["TRX01", "TRX02", "TRX03"]
VARS = ["GLAT", "GLON", "PM25", "PM10", "OZNE"]
MOUNTAIN_TZ = ZoneInfo("America/Denver")
MAX_POINTS = 5000  # matches the original fetch_historical_day
BACKFILL_META = '{"backfill":1}'  # readings-table marker; enables clean undo
# Weather params never rendered as pollutants (mirrors dashboard_server)
_WEATHER_KEYS = {"BARPR", "DEWPOINT", "TEMP", "WD", "WS", "RHUM", "SOLAR",
                 "PRECIP", "CEIL", "VSBY", "BC_LC", "BC_DC"}


def _log(msg: str) -> None:
    print(msg, flush=True)


# ── upstream fetch ───────────────────────────────────────────────────────────

def _http_get_json(url: str, timeout: float = 20.0) -> Any:
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def cmd_fetch(args: argparse.Namespace) -> int:
    archive = Path(args.archive_dir).expanduser()
    archive.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, Any] = {
        "fetched_utc": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
        "base_url": BASE_URL,
        "files": {},
    }

    def fetch_one(sensor: str, var: str) -> tuple[str, dict[str, Any]]:
        name = f"{sensor}_{var}_TS_10080.json"
        url = f"{BASE_URL}/{name}"
        for attempt in (1, 2):
            try:
                data = _http_get_json(url)
                pts = data.get("TimeDataUTC", []) if isinstance(data, dict) else []
                (archive / name).write_text(
                    json.dumps(data, separators=(",", ":")), encoding="utf-8")
                info = {"status": 200, "points": len(pts)}
                if pts:
                    info["t0_ms"] = pts[0][0]
                    info["t1_ms"] = pts[-1][0]
                return name, info
            except urllib.error.HTTPError as e:
                return name, {"status": e.code, "points": 0}
            except Exception as e:
                if attempt == 2:
                    return name, {"status": f"error: {e}", "points": 0}
                time.sleep(1.0)
        return name, {"status": "unreachable", "points": 0}

    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(fetch_one, s, v) for s in SENSORS for v in VARS]
        for fut in futures:
            name, info = fut.result()
            manifest["files"][name] = info
            _log(f"  {name}: {info['status']} ({info['points']} pts)")

    (archive / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    ok = sum(1 for i in manifest["files"].values() if i["status"] == 200)
    total_pts = sum(i["points"] for i in manifest["files"].values())
    _log(f"[fetch] {ok}/{len(manifest['files'])} files, {total_pts} points -> {archive}")
    return 0 if ok else 1


def load_archive(archive_dir: Path) -> dict[str, dict[str, list[tuple[int, float]]]]:
    """Return {sensor: {var: [(ts_ms, value), ...]}} from a fetched archive."""
    series: dict[str, dict[str, list[tuple[int, float]]]] = {}
    missing = []
    for sensor in SENSORS:
        series[sensor] = {}
        for var in VARS:
            f = archive_dir / f"{sensor}_{var}_TS_10080.json"
            if not f.exists():
                missing.append(f.name)
                series[sensor][var] = []
                continue
            data = json.loads(f.read_text(encoding="utf-8"))
            pts = data.get("TimeDataUTC", []) if isinstance(data, dict) else []
            series[sensor][var] = [
                (int(p[0]), p[1]) for p in pts
                if isinstance(p, list) and len(p) >= 2 and p[0] is not None
            ]
    if missing:
        _log(f"[archive] missing {len(missing)} files (treated as empty): {missing[:6]}...")
    return series


# ── day-state synthesis (port of the original fetch_historical_day) ─────────

def day_window_ms(date_str: str) -> tuple[int, int]:
    """5 AM Mountain on date_str -> +24h, as epoch-ms (matches _trim_trails_to_day)."""
    day = datetime.strptime(date_str, "%Y-%m-%d").replace(
        hour=5, minute=0, second=0, microsecond=0, tzinfo=MOUNTAIN_TZ)
    start = day.astimezone(timezone.utc)
    end = start + timedelta(hours=24)
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000)


def _ts_to_utc_str(ts_ms: int) -> str:
    return datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime(
        "%Y-%m-%d %H:%M:%S UTC")


def build_mobile_raw(
    series: dict[str, dict[str, list[tuple[int, float]]]],
    start_ms: int,
    end_ms: int,
) -> dict[str, Any]:
    """Build a MobileMapData.json-shaped dict for one day window.

    GPS timestamps are the spine; pollutant values carry forward onto them.
    No ValueColor: normalize_state_for_dashboard computes colors on our scale.
    """
    last_update = _ts_to_utc_str(end_ms).rsplit(":", 1)[0] + " UTC"
    mobile_raw: dict[str, Any] = {
        "PM25": {"LastUpdateUTC": last_update, "VarName": "PM2.5 Concentration", "VarUnit": "ug/m3"},
        "PM10": {"LastUpdateUTC": last_update, "VarName": "PM10 Concentration", "VarUnit": "ug/m3"},
        "OZNE": {"LastUpdateUTC": last_update, "VarName": "Ozone Concentration", "VarUnit": "ppbv"},
    }

    def in_window(pts: list[tuple[int, float]]) -> list[tuple[int, float]]:
        return [(ts, v) for ts, v in pts if start_ms <= ts < end_ms]

    def fmt_val(v: Any) -> str | None:
        if v is None:
            return None
        try:
            return f"{float(v):.2f}"
        except (TypeError, ValueError):
            return None

    for sensor in SENSORS:
        s = series.get(sensor, {})
        lat_by_ts = {ts: v for ts, v in in_window(s.get("GLAT", [])) if v is not None}
        lon_by_ts = {ts: v for ts, v in in_window(s.get("GLON", [])) if v is not None}
        gps_times = sorted(set(lat_by_ts) & set(lon_by_ts))
        if not gps_times:
            continue

        times_utc = [_ts_to_utc_str(ts) for ts in gps_times]
        lats = [str(lat_by_ts[ts]) for ts in gps_times]
        lons = [str(lon_by_ts[ts]) for ts in gps_times]

        for var in ("PM25", "PM10", "OZNE"):
            pol_pts = in_window(s.get(var, []))
            if var == "OZNE":  # negative ozone = bad sensor data
                pol_pts = [(ts, v) for ts, v in pol_pts if v is None or v >= 0]
            by_ts = dict(pol_pts)
            vals: list[str | None] = []
            last = None
            for ts in gps_times:
                if ts in by_ts:
                    last = by_ts[ts]
                vals.append(fmt_val(last))
            mobile_raw[var][sensor] = {
                "TimeUTC": times_utc,
                "Latitude": lats,
                "Longitude": lons,
                "Value": vals,
            }
    return mobile_raw


def _load_json_file(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _load_graphs() -> tuple[Any, Any]:
    """Load road/tram graphs with the same env gating as dashboard_server."""
    from mobileair.roads import RoadGraph

    tram = None
    try:
        from mobileair.config import TRAM_LINE_GRAPH_PATH
        p = os.environ.get("MOBILEAIR_TRAM_LINE_GRAPH") or TRAM_LINE_GRAPH_PATH
        if p and os.path.exists(p):
            tram = RoadGraph.load(p)
    except Exception:
        tram = None

    road = None
    if os.environ.get("MOBILEAIR_ENABLE_ROAD_GRAPH", "") in ("1", "true", "yes"):
        try:
            p = os.environ.get("MOBILEAIR_ROAD_GRAPH") or RoadGraph.default_graph_path()
            if os.path.exists(p):
                road = RoadGraph.load(p)
        except Exception:
            road = None
    return road, tram


def build_synthetic_state(
    series: dict[str, dict[str, list[tuple[int, float]]]],
    date_str: str,
    data_dir: Path,
    graphs: tuple[Any, Any],
) -> dict[str, Any]:
    start_ms, end_ms = day_window_ms(date_str)
    mobile_raw = build_mobile_raw(series, start_ms, end_ms)
    custom_names = _load_json_file(data_dir / "sensor_names.json", {})
    pinned_list = _load_json_file(data_dir / "pinned_sensors.json", [])
    road, tram = graphs
    state = normalize_state_for_dashboard(
        {"mobile": mobile_raw, "fixed": {}},
        custom_names=custom_names if isinstance(custom_names, dict) else {},
        pinned_sensors=set(pinned_list) if isinstance(pinned_list, list) else set(),
        max_points=MAX_POINTS,
        road_graph=road,
        tram_line_graph=tram,
    )
    state["meta"]["historical"] = True
    state["meta"]["date"] = date_str
    return state


# ── snapshot store IO ────────────────────────────────────────────────────────

def read_snapshot_db(conn: sqlite3.Connection, date_str: str) -> dict[str, Any] | None:
    row = conn.execute(
        "SELECT data FROM daily_snapshots WHERE date = ?", (date_str,)).fetchone()
    if row is None:
        return None
    return json.loads(gzip.decompress(bytes(row[0])))


def write_snapshot_db(conn: sqlite3.Connection, date_str: str, state: dict[str, Any]) -> int:
    raw = json.dumps(state, separators=(",", ":"), allow_nan=False, default=str)
    blob = gzip.compress(raw.encode("utf-8"), compresslevel=6)
    conn.execute(
        "INSERT OR REPLACE INTO daily_snapshots (date, ts, data, size_bytes) "
        "VALUES (?, ?, ?, ?)",
        (date_str, time.time(), blob, len(raw)))
    return len(raw)


def write_snapshot_file(out_dir: Path, date_str: str, state: dict[str, Any]) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{date_str}.json"
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(state, separators=(",", ":"), allow_nan=False, default=str),
        encoding="utf-8")
    tmp.replace(path)
    return path


def backup_existing(archive_dir: Path, date_str: str,
                    conn: sqlite3.Connection, snapshots_dir: Path) -> None:
    """Copy the pre-patch DB blob and FS file into archive_dir/pre_patch once."""
    pre = archive_dir / "pre_patch"
    pre.mkdir(parents=True, exist_ok=True)
    blob_dst = pre / f"{date_str}.db-blob.gz"
    if not blob_dst.exists():
        row = conn.execute(
            "SELECT data FROM daily_snapshots WHERE date = ?", (date_str,)).fetchone()
        if row is not None:
            blob_dst.write_bytes(bytes(row[0]))
    fs_src = snapshots_dir / f"{date_str}.json"
    fs_dst = pre / f"{date_str}.json"
    if fs_src.exists() and not fs_dst.exists():
        fs_dst.write_bytes(fs_src.read_bytes())


# ── merge ────────────────────────────────────────────────────────────────────

def _point_minute(p: dict[str, Any]) -> int | None:
    t = p.get("t")
    if not isinstance(t, str):
        return None
    dt = parse_utc_timestamp(t)
    if dt is None:
        return None
    return int(dt.timestamp() // 60)


def merge_mobile(
    existing_mobile: list[dict[str, Any]],
    synthetic_mobile: list[dict[str, Any]],
    gap_range_min: tuple[int, int] | None,
) -> tuple[list[dict[str, Any]], dict[str, dict[str, int]], dict[str, list[dict[str, Any]]]]:
    """Fill holes in existing trails from synthetic ones. Existing points win.

    A synthetic point is added only when its minute-bucket has no existing
    point (and, if gap_range_min is given, only inside that bucket range).
    Returns (merged_mobile, per-sensor stats, added points per sensor).
    """
    by_id_existing = {m.get("id"): m for m in existing_mobile if isinstance(m, dict)}
    stats: dict[str, dict[str, int]] = {}
    added_by_sensor: dict[str, list[dict[str, Any]]] = {}
    merged_list: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    def in_gap(minute: int | None) -> bool:
        if minute is None:
            return False
        if gap_range_min is None:
            return True
        return gap_range_min[0] <= minute <= gap_range_min[1]

    for syn in synthetic_mobile:
        sid = syn.get("id")
        if not sid:
            continue
        seen_ids.add(sid)
        ex = by_id_existing.get(sid)
        if ex is None:
            trail = [p for p in syn.get("trail", []) if in_gap(_point_minute(p))]
            if not trail:
                continue
            entry = dict(syn)
            entry["trail"] = trail
            entry["lat"] = trail[-1].get("lat")
            entry["lon"] = trail[-1].get("lon")
            merged_list.append(entry)
            stats[sid] = {"existing": 0, "added": len(trail), "total": len(trail)}
            added_by_sensor[sid] = trail
            continue

        ex_trail = [p for p in ex.get("trail", []) if isinstance(p, dict)]
        ex_minutes = {m for m in (_point_minute(p) for p in ex_trail) if m is not None}
        additions = [
            p for p in syn.get("trail", [])
            if isinstance(p, dict)
            and (mi := _point_minute(p)) is not None
            and mi not in ex_minutes
            and in_gap(mi)
        ]
        if not additions:
            merged_list.append(ex)
            stats[sid] = {"existing": len(ex_trail), "added": 0, "total": len(ex_trail)}
            continue

        combined = ex_trail + additions
        combined.sort(key=lambda p: _point_minute(p) or 0)
        # Synthetic entry covers the whole day, so its summary fields
        # (mobility, readings history, staleness) describe the merged trail
        # better than the truncated existing entry does. Keep user-facing
        # identity fields from the stored entry.
        entry = dict(syn)
        entry["trail"] = combined
        for k in ("name", "pinned"):
            if ex.get(k):
                entry[k] = ex[k]
        entry["lat"] = combined[-1].get("lat")
        entry["lon"] = combined[-1].get("lon")
        merged_list.append(entry)
        stats[sid] = {
            "existing": len(ex_trail),
            "added": len(additions),
            "total": len(combined),
        }
        added_by_sensor[sid] = additions

    for m in existing_mobile:  # sensors upstream doesn't know about
        if isinstance(m, dict) and m.get("id") not in seen_ids:
            merged_list.append(m)
            n = len(m.get("trail", []) or [])
            stats[m.get("id") or "?"] = {"existing": n, "added": 0, "total": n}

    return merged_list, stats, added_by_sensor


# ── fixed-side rebuild (for dates whose snapshot save was skipped) ───────────

def _fixed_template(conn: sqlite3.Connection, snapshots_dir: Path,
                    date_str: str) -> list[dict[str, Any]]:
    """Fixed-sensor identity (id/name/coords/emoji) from the nearest snapshot."""
    base = datetime.strptime(date_str, "%Y-%m-%d")
    for delta in (1, -1, 2, -2, 3, -3):
        d = (base + timedelta(days=delta)).strftime("%Y-%m-%d")
        state = None
        try:
            state = read_snapshot_db(conn, d)
        except Exception:
            state = None
        if state is None:
            f = snapshots_dir / f"{d}.json"
            if f.exists():
                try:
                    state = json.loads(f.read_text(encoding="utf-8"))
                except Exception:
                    state = None
        if state and isinstance(state.get("fixed"), list) and state["fixed"]:
            _log(f"  [fixed] template from {d} ({len(state['fixed'])} sensors)")
            return state["fixed"]
    return []


def _num(v: Any) -> Any:
    try:
        f = float(v)
        return int(f) if f == int(f) else f
    except (TypeError, ValueError):
        return None


def _collect_fixed_day_entries(
    conn: sqlite3.Connection, date_str: str,
) -> dict[str, dict[str, list[dict[str, Any]]]]:
    """{sensor_id: {pollutant: [entries]}} from readings, windowed + sorted.

    Entry shape mirrors load_fixed_history: meta.time_utc is the measurement
    time; one entry per measurement time (freshest write wins).
    """
    start_ms, end_ms = day_window_ms(date_str)
    rows = conn.execute(
        "SELECT sensor_id, pollutant, value, color, ts, meta FROM readings "
        "WHERE source != 'mobile' AND ts >= ? AND ts < ? ORDER BY ts",
        (start_ms / 1000.0, end_ms / 1000.0)).fetchall()

    hist: dict[str, dict[str, list[dict[str, Any]]]] = {}
    for sensor_id, pollutant, value, color, ts, meta_raw in rows:
        time_utc = None
        if meta_raw:
            try:
                time_utc = json.loads(meta_raw).get("time_utc")
            except (json.JSONDecodeError, TypeError):
                pass
        if not time_utc:
            continue
        entries = hist.setdefault(sensor_id, {}).setdefault(pollutant, [])
        if entries and entries[-1]["time"] == time_utc:
            entries[-1].update(val=value, color=color, recorded_at=ts)
        else:
            entries.append({"val": value, "color": color,
                            "time": time_utc, "recorded_at": ts})

    for pols in hist.values():
        for pol, entries in pols.items():
            kept = []
            for e in entries:
                dt = parse_utc_timestamp(e.get("time") or "")
                if dt is None:
                    continue
                ms = dt.timestamp() * 1000
                if start_ms <= ms < end_ms:
                    e["_ms"] = ms
                    kept.append(e)
            kept.sort(key=lambda e: e["_ms"])
            pols[pol] = kept
    return hist


def _reading_from_entries(entries: list[dict[str, Any]]) -> dict[str, Any]:
    values = [_num(e["val"]) for e in entries]
    colors = [e.get("color") or "#cccccc" for e in entries]
    return {
        "value": values[-1],
        "ci": color_to_idx(colors[-1]),
        "history": values,
        "hci": [color_to_idx(c) for c in colors],
        "history_colors": colors,
        "history_times": [e["time"] for e in entries],
    }


def _apply_worst(entry: dict[str, Any]) -> None:
    worst = _pick_worst_reading_by_aqi(entry.get("readings") or {})
    entry["ci"] = worst.get("ci") or 0
    entry["pci"] = worst.get("ci")
    entry["primary_key"] = worst.get("key")
    entry["primary_value"] = worst.get("value")
    entry["primary_aqi"] = worst.get("aqi")


def build_fixed_from_readings(
    conn: sqlite3.Connection,
    date_str: str,
    template: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Rebuild fixed-sensor entries for a day from the readings table.

    Identity comes from the template; per-pollutant value/history arrays are
    reconstructed exactly like load_fixed_history + _inject_fixed_history do
    (meta.time_utc is the measurement time; color -> hci via color_to_idx).
    """
    hist = _collect_fixed_day_entries(conn, date_str)

    fixed_out: list[dict[str, Any]] = []
    for tmpl in template:
        sid = tmpl.get("id")
        if not sid or sid not in hist:
            continue
        readings: dict[str, Any] = {}
        for pol, entries in hist[sid].items():
            if pol in _WEATHER_KEYS or not entries:
                continue
            readings[pol] = _reading_from_entries(entries)
        if not readings:
            continue
        entry = {
            "id": sid,
            "name": tmpl.get("name", ""),
            "pinned": bool(tmpl.get("pinned")),
            "emoji": tmpl.get("emoji", "🏛️"),
            "lat": tmpl.get("lat"),
            "lon": tmpl.get("lon"),
            "readings": readings,
        }
        for extra in ("purpleair", "airnow", "meta_site"):
            if extra in tmpl:
                entry[extra] = tmpl[extra]
        if entry.get("purpleair"):
            last_rec = max(
                (e["recorded_at"] for pols in (hist[sid],) for es in pols.values()
                 for e in es), default=None)
            if last_rec:
                entry["last_seen"] = last_rec
        _apply_worst(entry)
        fixed_out.append(entry)
    return fixed_out


def repair_fixed_histories(
    conn: sqlite3.Connection,
    date_str: str,
    state: dict[str, Any],
    snapshots_dir: Path,
) -> dict[str, int]:
    """Complete truncated fixed-sensor histories in an EXISTING snapshot.

    A snapshot saved mid-day (e.g. the server stopped saving during the
    Jul 2026 outage) freezes every fixed sensor at its last written reading,
    so playback shows that value for the rest of the day. The readings table
    has the full day: union each sensor's stored history with the DB rows
    per pollutant (DB wins on the same measurement time), refresh the
    current value/ci, and add sensors the stored snapshot is missing.
    Stored-only entries are never dropped.
    """
    hist = _collect_fixed_day_entries(conn, date_str)
    fixed = state.get("fixed")
    if not isinstance(fixed, list):
        fixed = state["fixed"] = []
    by_id = {f.get("id"): f for f in fixed if isinstance(f, dict)}

    stats = {"sensors_extended": 0, "entries_added": 0, "sensors_added": 0}
    for sid, pols in hist.items():
        entry = by_id.get(sid)
        if entry is None:
            continue
        readings = entry.get("readings")
        if not isinstance(readings, dict):
            readings = entry["readings"] = {}
        entry_changed = False
        for pol, db_entries in pols.items():
            if pol in _WEATHER_KEYS or not db_entries:
                continue
            reading = readings.get(pol)
            if not isinstance(reading, dict):
                reading = readings[pol] = {}
            stored_times = reading.get("history_times") or []
            stored_vals = reading.get("history") or []
            stored_hci = reading.get("hci") or []
            stored_cols = reading.get("history_colors") or []
            merged: dict[str, tuple[Any, Any, Any]] = {}
            for i, t in enumerate(stored_times):
                if not isinstance(t, str):
                    continue
                merged[t] = (
                    stored_vals[i] if i < len(stored_vals) else None,
                    stored_hci[i] if i < len(stored_hci) else 0,
                    stored_cols[i] if i < len(stored_cols) else "#cccccc",
                )
            before = len(merged)
            for e in db_entries:
                c = e.get("color") or "#cccccc"
                merged[e["time"]] = (_num(e["val"]), color_to_idx(c), c)
            if len(merged) == before:
                continue
            times = sorted(
                merged,
                key=lambda t: (parse_utc_timestamp(t) or datetime.min.replace(
                    tzinfo=timezone.utc)).timestamp())
            reading["history"] = [merged[t][0] for t in times]
            reading["hci"] = [merged[t][1] for t in times]
            reading["history_colors"] = [merged[t][2] for t in times]
            reading["history_times"] = times
            reading["value"] = merged[times[-1]][0]
            reading["ci"] = merged[times[-1]][1]
            stats["entries_added"] += len(merged) - before
            entry_changed = True
        if entry_changed:
            _apply_worst(entry)
            stats["sensors_extended"] += 1

    missing = [sid for sid in hist if sid not in by_id]
    if missing:
        template = _fixed_template(conn, snapshots_dir, date_str)
        tmpl_by_id = {t.get("id"): t for t in template if isinstance(t, dict)}
        buildable = [tmpl_by_id[sid] for sid in missing if sid in tmpl_by_id]
        for entry in build_fixed_from_readings(conn, date_str, buildable):
            fixed.append(entry)
            stats["sensors_added"] += 1
    return stats


# ── readings-table archival inserts ──────────────────────────────────────────

def insert_backfill_readings(
    conn: sqlite3.Connection,
    added_by_sensor: dict[str, list[dict[str, Any]]],
) -> int:
    """Archive backfilled points into readings (source='mobile').

    Live rows use poll-time ts; ours use measurement time and carry a marker
    meta so they can be identified (and deleted) as a unit:
        DELETE FROM readings WHERE meta = '{"backfill":1}'
    """
    inserted = 0
    for sid, points in added_by_sensor.items():
        sensor_id = f"mobile:{sid}"
        for p in points:
            dt = parse_utc_timestamp(p.get("t") or "")
            if dt is None:
                continue
            ts = dt.timestamp()
            rd = p.get("readings")
            if not isinstance(rd, dict):
                continue
            for pol, r in rd.items():
                if not isinstance(r, dict):
                    continue
                try:
                    val = float(r.get("value"))
                except (TypeError, ValueError):
                    continue
                dup = conn.execute(
                    "SELECT 1 FROM readings WHERE sensor_id = ? AND pollutant = ? "
                    "AND ts BETWEEN ? AND ? LIMIT 1",
                    (sensor_id, pol, ts - 45, ts + 45)).fetchone()
                if dup:
                    continue
                conn.execute(
                    "INSERT INTO readings (sensor_id, source, ts, lat, lon, "
                    "pollutant, value, aqi, color, meta) "
                    "VALUES (?, 'mobile', ?, ?, ?, ?, ?, NULL, NULL, ?)",
                    (sensor_id, ts, p.get("lat"), p.get("lon"), pol, val,
                     BACKFILL_META))
                inserted += 1
    return inserted


# ── coverage report ──────────────────────────────────────────────────────────

def coverage_by_hour(mobile: list[dict[str, Any]]) -> dict[str, int]:
    hours: dict[str, int] = {}
    for m in mobile or []:
        for p in m.get("trail", []) or []:
            t = p.get("t") if isinstance(p, dict) else None
            dt = parse_utc_timestamp(t) if isinstance(t, str) else None
            if dt is None:
                continue
            k = dt.strftime("%Y-%m-%d %H")
            hours[k] = hours.get(k, 0) + 1
    return hours


def print_coverage(label: str, mobile: list[dict[str, Any]]) -> None:
    hours = coverage_by_hour(mobile)
    total = sum(hours.values())
    sensors = sum(1 for m in mobile or [] if (m.get("trail") or []))
    _log(f"  [{label}] {sensors} sensors with trails, {total} points")
    for k in sorted(hours):
        _log(f"    {k}:00 UTC  {hours[k]:5d}")


def cmd_report(args: argparse.Namespace) -> int:
    conn = sqlite3.connect(f"file:{Path(args.db).expanduser()}?mode=ro", uri=True)
    for date_str in args.dates.split(","):
        date_str = date_str.strip()
        state = read_snapshot_db(conn, date_str)
        _log(f"[report] {date_str}:")
        if state is None:
            _log("  (no snapshot)")
            continue
        print_coverage("stored", state.get("mobile", []))
    return 0


# ── patch ────────────────────────────────────────────────────────────────────

def _parse_gap(args: argparse.Namespace) -> tuple[int, int] | None:
    if not args.gap_start and not args.gap_end:
        return None
    lo = 0
    hi = 2 ** 53
    if args.gap_start:
        dt = parse_utc_timestamp(args.gap_start)
        if dt is None:
            raise SystemExit(f"unparseable --gap-start: {args.gap_start!r}")
        lo = int(dt.timestamp() // 60)
    if args.gap_end:
        dt = parse_utc_timestamp(args.gap_end)
        if dt is None:
            raise SystemExit(f"unparseable --gap-end: {args.gap_end!r}")
        hi = int(dt.timestamp() // 60)
    return (lo, hi)


def cmd_patch(args: argparse.Namespace) -> int:
    db_path = Path(args.db).expanduser()
    if not db_path.exists():
        raise SystemExit(f"DB not found: {db_path}")
    archive_dir = Path(args.archive_dir).expanduser()
    if not (archive_dir / "manifest.json").exists():
        raise SystemExit(f"no manifest.json in {archive_dir}; run `fetch` first")
    data_dir = Path(args.data_dir).expanduser()
    snapshots_dir = Path(args.snapshots_dir).expanduser() if args.snapshots_dir \
        else data_dir / "snapshots"
    out_snapshots_dir = Path(args.out_snapshots_dir).expanduser() \
        if args.out_snapshots_dir else snapshots_dir
    dates = [d.strip() for d in args.dates.split(",") if d.strip()]
    gap_range = _parse_gap(args)

    manifest = json.loads((archive_dir / "manifest.json").read_text(encoding="utf-8"))
    _log(f"[patch] archive fetched {manifest.get('fetched_utc')} | db={db_path}")
    series = load_archive(archive_dir)
    graphs = _load_graphs()
    _log(f"[patch] graphs: road={'on' if graphs[0] else 'off'} "
         f"tram={'on' if graphs[1] else 'off'}")

    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA journal_mode=WAL")
    total_added = 0

    try:
        for date_str in dates:
            _log(f"[patch] === {date_str} ===")
            synthetic = build_synthetic_state(series, date_str, data_dir, graphs)
            syn_pts = sum(len(m.get("trail", [])) for m in synthetic["mobile"])
            _log(f"  upstream day-state: {len(synthetic['mobile'])} sensors, {syn_pts} points")
            if syn_pts == 0:
                _log("  nothing upstream for this window; skipping")
                continue

            existing = read_snapshot_db(conn, date_str)
            fs_path = snapshots_dir / f"{date_str}.json"
            if existing is None and fs_path.exists():
                existing = json.loads(fs_path.read_text(encoding="utf-8"))
                _log("  (snapshot found on disk only; DB row missing)")

            if existing is None:
                _log("  no stored snapshot: creating one from scratch")
                template = _fixed_template(conn, snapshots_dir, date_str)
                fixed = build_fixed_from_readings(conn, date_str, template)
                _log(f"  [fixed] rebuilt {len(fixed)} sensors from readings table")
                gap_filtered, stats, added_by_sensor = merge_mobile(
                    [], synthetic["mobile"], gap_range)
                new_state = {
                    "ts": time.time(),
                    "meta": {"max_points": MAX_POINTS, "historical": True,
                             "date": date_str, "backfilled": True},
                    "mobile": gap_filtered,
                    "fixed": fixed,
                }
            else:
                merged, stats, added_by_sensor = merge_mobile(
                    existing.get("mobile", []) or [], synthetic["mobile"], gap_range)
                new_state = existing
                new_state["mobile"] = merged
                new_state.setdefault("meta", {})["backfilled"] = True
                if not args.no_fixed_repair:
                    fstats = repair_fixed_histories(conn, date_str, new_state,
                                                    snapshots_dir)
                    _log(f"  [fixed] repaired: {fstats['sensors_extended']} sensors "
                         f"extended (+{fstats['entries_added']} history entries), "
                         f"{fstats['sensors_added']} sensors added")

            for sid in sorted(stats):
                s = stats[sid]
                if s["added"]:
                    _log(f"    {sid}: {s['existing']} kept + {s['added']} added = {s['total']}")
            day_added = sum(s["added"] for s in stats.values())
            total_added += day_added
            _log(f"  day total: +{day_added} trail points")
            print_coverage("after-merge", new_state["mobile"])

            if args.dry_run:
                _log("  [dry-run] no writes")
                continue

            backup_existing(archive_dir, date_str, conn, snapshots_dir)
            raw_size = write_snapshot_db(conn, date_str, new_state)
            out_path = write_snapshot_file(out_snapshots_dir, date_str, new_state)
            _log(f"  wrote DB blob ({raw_size} bytes raw) + {out_path}")

            if not args.no_readings and day_added:
                n = insert_backfill_readings(conn, added_by_sensor)
                _log(f"  readings table: +{n} archival rows (meta={BACKFILL_META})")

        if not args.dry_run:
            conn.commit()
            # round-trip sanity: every touched date must parse back
            for date_str in dates:
                st = read_snapshot_db(conn, date_str)
                if st is not None and not isinstance(st.get("mobile"), list):
                    raise SystemExit(f"post-write validation failed for {date_str}")
            _log(f"[patch] committed. total trail points added: {total_added}")
        else:
            conn.rollback()
            _log(f"[patch] dry-run complete. would add {total_added} trail points")
    finally:
        conn.close()
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    f = sub.add_parser("fetch", help="download upstream TS files into an archive dir")
    f.add_argument("--archive-dir", required=True)

    p = sub.add_parser("patch", help="apply archive to a DB mirror + snapshots dir")
    p.add_argument("--db", required=True, help="sqlite DB (patch a MIRROR, not the live file)")
    p.add_argument("--archive-dir", required=True)
    p.add_argument("--data-dir", default="~/.mobileair",
                   help="for sensor_names/pinned/roads (default ~/.mobileair)")
    p.add_argument("--snapshots-dir", default=None,
                   help="existing snapshot JSONs (default {data-dir}/snapshots)")
    p.add_argument("--out-snapshots-dir", default=None,
                   help="where to WRITE patched snapshot JSONs (default: same as --snapshots-dir)")
    p.add_argument("--dates", required=True, help="comma-separated YYYY-MM-DD (MT days)")
    p.add_argument("--gap-start", default=None, help="UTC; only add points at/after this")
    p.add_argument("--gap-end", default=None, help="UTC; only add points at/before this")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--no-readings", action="store_true",
                   help="skip archival inserts into the readings table")
    p.add_argument("--no-fixed-repair", action="store_true",
                   help="skip completing truncated fixed histories from the readings table")

    r = sub.add_parser("report", help="per-hour trail coverage of stored snapshots")
    r.add_argument("--db", required=True)
    r.add_argument("--dates", required=True)

    args = ap.parse_args()
    if args.cmd == "fetch":
        return cmd_fetch(args)
    if args.cmd == "patch":
        return cmd_patch(args)
    return cmd_report(args)


if __name__ == "__main__":
    sys.exit(main())
