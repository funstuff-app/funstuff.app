#!/usr/bin/env python3
"""
prefs_log.py — inspect and replay the prefs_log.ndjson written by /api/prefs/sync.

Commands
--------
  list   [--n N] [--log PATH]          Tabular view of last N sessions
  show   <index>  [--log PATH]          All prefs for one entry (0-indexed from tail)
  diff   <a> <b>  [--log PATH]          Keys that changed between two entries
  export <index>  [--log PATH]          JS snippet for DevTools console (restores prefs via localStorage)
  watch           [--log PATH]          Stream new entries as they arrive (tail -f style)

Index is 0 = newest, 1 = second-newest, etc.

Examples
--------
  python tools/prefs_log.py list
  python tools/prefs_log.py list --n 20
  python tools/prefs_log.py show 0
  python tools/prefs_log.py diff 0 3
  python tools/prefs_log.py export 0          # paste output in browser DevTools
  python tools/prefs_log.py watch
"""

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_LOG = Path.home() / ".mobileair" / "prefs_log.ndjson"

# Keys worth showing in the compact list view (in display order)
_LIST_KEYS = [
    "mobileair.mapView",
    "mobileair.mapTheme.dark",
    "mobileair.mapTheme.light",
    "mobileair.traceMode",
    "mobileair.liveFollow",
    "dusty_active_tab",
    "dusty_sidebar_open",
]

# ── helpers ──────────────────────────────────────────────────────────────────

def _load_entries(log: Path) -> list[dict]:
    if not log.exists():
        return []
    entries = []
    for raw in log.read_text(encoding="utf-8").splitlines():
        raw = raw.strip()
        if not raw:
            continue
        try:
            entries.append(json.loads(raw))
        except json.JSONDecodeError:
            pass
    return entries


def _fmt_ts(ts_float: float) -> str:
    dt = datetime.fromtimestamp(ts_float, tz=timezone.utc).astimezone()
    return dt.strftime("%Y-%m-%d %H:%M:%S %Z")


def _map_view_short(raw: str | None) -> str:
    if not raw:
        return "—"
    try:
        v = json.loads(raw)
        lat = round(float(v.get("lat", 0)), 4)
        lon = round(float(v.get("lon", 0)), 4)
        zoom = round(float(v.get("zoom", 0)), 1)
        return f"{lat},{lon} z{zoom}"
    except Exception:
        return raw[:30]


def _tail(entries: list[dict], n: int) -> list[dict]:
    """Return last n entries, reversed so index 0 = newest."""
    return list(reversed(entries[-n:] if n > 0 else entries))


# ── commands ─────────────────────────────────────────────────────────────────

def cmd_list(args):
    entries = _tail(_load_entries(args.log), args.n)
    if not entries:
        print("No entries found in", args.log)
        return

    # Column widths
    col_idx  = 5
    col_ts   = 25
    col_view = 24
    col_theme_d = 12
    col_theme_l = 12
    col_tab  = 8
    col_trace = 6
    col_live  = 5

    header = (
        f"{'#':<{col_idx}} "
        f"{'Timestamp':<{col_ts}} "
        f"{'Map view':<{col_view}} "
        f"{'Theme (dark)':<{col_theme_d}} "
        f"{'Theme (light)':<{col_theme_l}} "
        f"{'Tab':<{col_tab}} "
        f"{'Trc':<{col_trace}} "
        f"{'Live':<{col_live}}"
    )
    print(header)
    print("-" * len(header))

    for i, e in enumerate(entries):
        p = e.get("prefs", {})
        ts   = _fmt_ts(e.get("ts", 0))
        view = _map_view_short(p.get("mobileair.mapView"))
        td   = (p.get("mobileair.mapTheme.dark") or "—")[:col_theme_d]
        tl   = (p.get("mobileair.mapTheme.light") or "—")[:col_theme_l]
        tab  = (p.get("dusty_active_tab") or "—")[:col_tab]
        trc  = p.get("mobileair.traceMode") or "—"
        live = p.get("mobileair.liveFollow") or "—"
        print(
            f"{i:<{col_idx}} "
            f"{ts:<{col_ts}} "
            f"{view:<{col_view}} "
            f"{td:<{col_theme_d}} "
            f"{tl:<{col_theme_l}} "
            f"{tab:<{col_tab}} "
            f"{trc:<{col_trace}} "
            f"{live:<{col_live}}"
        )


def cmd_show(args):
    entries = _tail(_load_entries(args.log), 0)
    if not entries:
        print("No entries found in", args.log)
        return
    idx = args.index
    if idx < 0 or idx >= len(entries):
        print(f"Index {idx} out of range (0–{len(entries)-1})")
        sys.exit(1)
    e = entries[idx]
    print(f"Entry #{idx}  —  {_fmt_ts(e.get('ts', 0))}")
    print(f"  server_ts : {e.get('ts', 0)}")
    print(f"  client_ts : {e.get('client_ts', 0)}")
    print()
    prefs = e.get("prefs", {})
    for k in sorted(prefs):
        v = prefs[k]
        # Pretty-print mapView JSON
        if k == "mobileair.mapView":
            try:
                v = json.dumps(json.loads(v))
            except Exception:
                pass
        print(f"  {k} = {v}")


def cmd_diff(args):
    entries = _tail(_load_entries(args.log), 0)
    if not entries:
        print("No entries found in", args.log)
        return
    n = len(entries)
    for label, idx in (("a", args.a), ("b", args.b)):
        if idx < 0 or idx >= n:
            print(f"Index {label}={idx} out of range (0–{n-1})")
            sys.exit(1)

    ea, eb = entries[args.a], entries[args.b]
    pa, pb = ea.get("prefs", {}), eb.get("prefs", {})
    all_keys = sorted(set(pa) | set(pb))
    changed = [(k, pa.get(k), pb.get(k)) for k in all_keys if pa.get(k) != pb.get(k)]

    print(f"Diff  #{args.a} ({_fmt_ts(ea.get('ts',0))})  →  #{args.b} ({_fmt_ts(eb.get('ts',0))})")
    if not changed:
        print("  (no differences)")
        return
    print()
    for k, va, vb in changed:
        if va is None:
            print(f"  + {k} = {vb}")
        elif vb is None:
            print(f"  - {k} (was {va})")
        else:
            print(f"  ~ {k}")
            print(f"      was : {va}")
            print(f"      now : {vb}")


def cmd_export(args):
    entries = _tail(_load_entries(args.log), 0)
    if not entries:
        print("No entries found in", args.log)
        return
    idx = args.index
    if idx < 0 or idx >= len(entries):
        print(f"Index {idx} out of range (0–{len(entries)-1})")
        sys.exit(1)
    e = entries[idx]
    prefs = e.get("prefs", {})

    print(f"// Prefs from entry #{idx} — {_fmt_ts(e.get('ts', 0))}")
    print("// Paste in browser DevTools console to restore this session state.")
    print("(function() {")
    for k, v in sorted(prefs.items()):
        ks = json.dumps(k)
        vs = json.dumps(str(v))
        print(f"  localStorage.setItem({ks}, {vs});")
    print("  location.reload();")
    print("})();")


def cmd_watch(args):
    log: Path = args.log
    print(f"Watching {log} (Ctrl-C to stop) …\n")
    last_size = log.stat().st_size if log.exists() else 0
    try:
        while True:
            time.sleep(1)
            if not log.exists():
                continue
            size = log.stat().st_size
            if size <= last_size:
                continue
            with open(log, "rb") as f:
                f.seek(last_size)
                new_bytes = f.read()
            last_size = size
            for raw in new_bytes.decode("utf-8", errors="replace").splitlines():
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    e = json.loads(raw)
                    p = e.get("prefs", {})
                    ts = _fmt_ts(e.get("ts", 0))
                    view = _map_view_short(p.get("mobileair.mapView"))
                    tab = p.get("dusty_active_tab", "—")
                    print(f"[{ts}]  view={view}  tab={tab}  ({len(p)} keys)")
                except json.JSONDecodeError:
                    pass
    except KeyboardInterrupt:
        print("\nStopped.")


# ── entry point ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Inspect and replay dashboard prefs_log.ndjson.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--log", type=Path, default=DEFAULT_LOG,
                        help=f"Path to prefs_log.ndjson (default: {DEFAULT_LOG})")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_list = sub.add_parser("list", help="Tabular view of last N sessions")
    p_list.add_argument("--n", type=int, default=50, help="Max entries to show (default 50)")
    p_list.set_defaults(func=cmd_list)

    p_show = sub.add_parser("show", help="All prefs for one entry")
    p_show.add_argument("index", type=int, help="0=newest, 1=second-newest, …")
    p_show.set_defaults(func=cmd_show)

    p_diff = sub.add_parser("diff", help="Changes between two entries")
    p_diff.add_argument("a", type=int, help="First entry index (0=newest)")
    p_diff.add_argument("b", type=int, help="Second entry index")
    p_diff.set_defaults(func=cmd_diff)

    p_export = sub.add_parser("export", help="JS snippet to paste in DevTools to restore state")
    p_export.add_argument("index", type=int, help="0=newest, 1=second-newest, …")
    p_export.set_defaults(func=cmd_export)

    p_watch = sub.add_parser("watch", help="Stream new entries as they arrive")
    p_watch.set_defaults(func=cmd_watch)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
