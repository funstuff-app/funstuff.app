#!/usr/bin/env python3
"""
MobileAir browser dashboard server.

Serves the browser dashboard UI and provides a JSON API for sensor state.
Implements a persistent state machine for mobile sensors with trail merging,
ghosting (offline detection), and cleanup of stale entries.
"""

from __future__ import annotations

import argparse
import json
import os
import ssl
import socket
import threading
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
from typing import Any

import requests

# Import from the mobileair package
from mobileair import (
    parse_utc_timestamp,
    fetch_json_with_cache,
    normalize_state_for_dashboard,
    MOBILE_URL,
    FIXED_URL,
    HEADERS,
)

def default_data_dir() -> Path:
    return Path(os.path.expanduser("~/.mobileair"))

def load_json_file(path: Path, default):
    try:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        pass
    return default

@dataclass
class AppState:
    lock: threading.Lock
    state: dict[str, Any]
    persistent_mobile: dict[str, dict[str, Any]]
    # Pre-serialized JSON bytes to prevent CPU spikes on every GET request.
    # Must be initialized from `state` so /api/state is valid immediately.
    cached_json_bytes: bytes = b"{}"

    def __post_init__(self) -> None:
        try:
            self.cached_json_bytes = json.dumps(self.state).encode("utf-8")
        except Exception:
            self.cached_json_bytes = b"{}"

def build_state(
    *,
    data_dir: Path,
    mobile_json: dict[str, Any] | None,
    fixed_json: dict[str, Any] | None,
    max_points: int,
) -> dict[str, Any]:
    custom_names = load_json_file(data_dir / "sensor_names.json", {})
    pinned_list = load_json_file(data_dir / "pinned_sensors.json", [])
    pinned = set(pinned_list) if isinstance(pinned_list, list) else set()

    combined = {"mobile": mobile_json or {}, "fixed": fixed_json or {}}
    return normalize_state_for_dashboard(
        combined,
        custom_names=custom_names if isinstance(custom_names, dict) else {},
        pinned_sensors=pinned,
        max_points=max_points,
        mobile_url=MOBILE_URL,
        fixed_url=FIXED_URL,
        data_dir=str(data_dir),
    )

def _first_last_ts(trail: list[dict[str, Any]]) -> tuple[float | None, float | None]:
    """O(1) optimization: Avoids iterating thousands of points."""
    if not isinstance(trail, list) or not trail:
        return None, None
    
    def get_ms(point):
        if not isinstance(point, dict): return None
        ts = point.get("t")
        dt = parse_utc_timestamp(ts) if isinstance(ts, str) else None
        return float(dt.timestamp()) if dt else None

    return get_ms(trail[0]), get_ms(trail[-1])

def update_app_state_with_new_data(app_state: AppState, st: dict[str, Any], now: float | None = None) -> None:
    if now is None:
        now = time.time()

    meta = st.get("meta")
    if not isinstance(meta, dict):
        meta = {}
        st["meta"] = meta

    with app_state.lock:
        fresh_sids = set()
        for incoming_mobile in st.get("mobile", []):
            sid = incoming_mobile.get("id")
            if not sid:
                continue
            fresh_sids.add(sid)

            if sid not in app_state.persistent_mobile:
                app_state.persistent_mobile[sid] = incoming_mobile
                incoming_mobile["_last_seen"] = now
                incoming_mobile["_idle"] = bool(incoming_mobile.get("immobile"))
                incoming_mobile["_idle_breakout_hits"] = 0
                incoming_mobile["_idle_since_t"] = None
                incoming_mobile["_last_trail_ts"] = None

                if incoming_mobile["_idle"]:
                    trail0 = incoming_mobile.get("trail", [])
                    if isinstance(trail0, list) and trail0:
                        last_p = trail0[-1]
                        last_ts = last_p.get("t") if isinstance(last_p, dict) else None
                        incoming_mobile["_idle_since_t"] = last_ts
                        incoming_mobile["_last_trail_ts"] = last_ts
                        for p in trail0:
                            if isinstance(p, dict) and "m" not in p: p["m"] = 0
                else:
                    trail0 = incoming_mobile.get("trail", [])
                    if isinstance(trail0, list) and trail0:
                        last_p = trail0[-1]
                        last_ts = last_p.get("t") if isinstance(last_p, dict) else None
                        incoming_mobile["_last_trail_ts"] = last_ts
                        for p in trail0:
                            if isinstance(p, dict) and "m" not in p: p["m"] = 1
            else:
                pm = app_state.persistent_mobile[sid]
                old_trail = pm.get("trail", [])
                prev_idle = bool(pm.get("_idle"))
                idle_since_ts = pm.get("_idle_since_t")
                backend_idle = bool(incoming_mobile.get("immobile"))

                if backend_idle and not prev_idle:
                    prev_idle = True
                    trail_in = incoming_mobile.get("trail", [])
                    if isinstance(trail_in, list) and trail_in:
                        last_p = trail_in[-1]
                        idle_since_ts = last_p.get("t") if isinstance(last_p, dict) else None

                if prev_idle and not backend_idle:
                    prev_idle = False
                    idle_since_ts = None

                # Optimization: O(1) trail comparison logic
                old_f_ms, old_l_ms = _first_last_ts(old_trail)
                incoming_trail = incoming_mobile.get("trail", [])
                inc_f_ms, inc_l_ms = _first_last_ts(incoming_trail)

                replace_trail = False
                if incoming_trail:
                    if isinstance(old_trail, list) and old_trail:
                        if (inc_f_ms is not None and old_f_ms is not None and inc_f_ms <= old_f_ms
                            and inc_l_ms is not None and old_l_ms is not None and inc_l_ms >= old_l_ms):
                            replace_trail = True
                        elif len(incoming_trail) > len(old_trail) and inc_l_ms is not None and inc_l_ms >= (old_l_ms or 0):
                            replace_trail = True
                    else:
                        replace_trail = True

                pm.update(incoming_mobile)
                pm["trail"] = incoming_trail if replace_trail else old_trail
                
                if incoming_trail and not replace_trail:
                    # Merge only new points
                    _, last_old_ms = _first_last_ts(pm["trail"])
                    for np in incoming_trail:
                        nt_dt = parse_utc_timestamp(np.get("t"))
                        if last_old_ms and nt_dt and nt_dt.timestamp() <= last_old_ms:
                            continue
                        if "m" not in np: np["m"] = 1
                        pm["trail"].append(np)

                if len(pm["trail"]) > 5000:
                    pm["trail"] = pm["trail"][-5000:]

                pm["_last_seen"] = now
                pm["_idle"] = prev_idle
                pm["_idle_since_t"] = idle_since_ts
                pm["ghosted"] = False
                pm["_sticky_ghosted"] = False

        to_delete = [sid for sid, pm in app_state.persistent_mobile.items() if now - pm.get("_last_seen", 0) > 2700]
        for sid in to_delete: del app_state.persistent_mobile[sid]

        combined_mobile = []
        for sid, pm in app_state.persistent_mobile.items():
            if sid not in fresh_sids:
                pm["ghosted"] = True
                pm["_sticky_ghosted"] = True
            combined_mobile.append(pm)
        st["mobile"] = combined_mobile

        prev_meta = app_state.state.get("meta", {}) if isinstance(app_state.state, dict) else {}
        if "server_start_ts" in prev_meta: meta["server_start_ts"] = prev_meta["server_start_ts"]

        # CPU Optimization: Bake JSON bytes once here
        app_state.state = st
        app_state.cached_json_bytes = json.dumps(st).encode("utf-8")

def fetch_loop(*, app_state: AppState, data_dir: Path, interval_s: float, stop_event: threading.Event) -> None:
    revision = 0
    while not stop_event.is_set():
        attempt_ts = time.time()
        try:
            mobile = fetch_json_with_cache(MOBILE_URL, headers=HEADERS, timeout=10, request_get=requests.get)
            fixed = fetch_json_with_cache(FIXED_URL, headers=HEADERS, timeout=10, request_get=requests.get)

            st = build_state(data_dir=data_dir, mobile_json=mobile, fixed_json=fixed, max_points=5000)
            revision += 1
            meta = st.setdefault("meta", {})
            meta.update({"last_fetch_attempt_ts": attempt_ts, "last_fetch_ok_ts": attempt_ts, "server_revision": revision})
            update_app_state_with_new_data(app_state, st)
        except Exception as e:
            with app_state.lock:
                st = app_state.state if isinstance(app_state.state, dict) else {"ts": time.time(), "mobile": [], "fixed": [], "meta": {}}
                meta = st.setdefault("meta", {})
                meta["last_fetch_error"] = f"{type(e).__name__}: {e}"
                app_state.state = st
        stop_event.wait(interval_s)

def apply_sensor_names_inplace(state: dict[str, Any], custom_names: dict[str, Any]) -> bool:
    if not isinstance(state, dict) or not isinstance(custom_names, dict): return False
    changed = False
    for key in ("mobile", "fixed"):
        for it in state.get(key, []):
            sid = it.get("id")
            new_name = custom_names.get(sid) or ""
            if it.get("name") != new_name:
                it["name"] = new_name
                changed = True
    return changed

def watch_sensor_names_loop(*, app_state: AppState, data_dir: Path, stop_event: threading.Event) -> None:
    path = data_dir / "sensor_names.json"
    last_mtime = None
    while not stop_event.is_set():
        try:
            if path.exists():
                mtime = path.stat().st_mtime
                if last_mtime is None or mtime > last_mtime + 1e-6:
                    last_mtime = mtime
                    custom_names = load_json_file(path, {})
                    with app_state.lock:
                        if apply_sensor_names_inplace(app_state.state, custom_names):
                            app_state.cached_json_bytes = json.dumps(app_state.state).encode("utf-8")
        except Exception: pass
        stop_event.wait(5.0)

def make_handler(*, app_state: AppState, static_dir: Path):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, code: int, body: bytes, content_type: str):
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store, max-age=0")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path in ("/", "/index.html"):
                return self._send(200, (static_dir / "index.html").read_bytes(), "text/html")
            if self.path == "/app.js":
                return self._send(200, (static_dir / "app.js").read_bytes(), "text/javascript")
            if self.path == "/map_nav_engine.js":
                return self._send(200, (static_dir / "map_nav_engine.js").read_bytes(), "text/javascript")
            if self.path == "/styles.css":
                return self._send(200, (static_dir / "styles.css").read_bytes(), "text/css")
            if self.path == "/tui.html":
                return self._send(200, (static_dir / "tui.html").read_bytes(), "text/html")
            if self.path == "/tui.css":
                return self._send(200, (static_dir / "tui.css").read_bytes(), "text/css")
            if self.path == "/tui.js":
                return self._send(200, (static_dir / "tui.js").read_bytes(), "text/javascript")
            if self.path.startswith("/api/state"):
                with app_state.lock:
                    return self._send(200, app_state.cached_json_bytes, "application/json")
            return self._send(404, b"not found", "text/plain")

        def log_message(self, format, *args):
            return

    return Handler


def _guess_lan_ips() -> list[str]:
    """Best-effort list of LAN-reachable IPs for showing a usable URL.

    This does not change networking; it only inspects local interfaces.
    """
    ips: list[str] = []

    # Primary outbound interface (no packets are sent; connect() picks a route).
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("1.1.1.1", 80))
            ip = s.getsockname()[0]
            if ip and ip not in ips:
                ips.append(ip)
        finally:
            s.close()
    except Exception:
        pass

    # Enumerate all local addresses as a fallback.
    try:
        host = socket.gethostname()
        for family, _, _, _, sockaddr in socket.getaddrinfo(host, None):
            if family != socket.AF_INET:
                continue
            ip = str(sockaddr[0])
            if not ip or ip.startswith("127."):
                continue
            if ip not in ips:
                ips.append(ip)
    except Exception:
        pass

    return ips

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--https", action="store_true")
    parser.add_argument("--cert", default="")
    parser.add_argument("--key", default="")
    parser.add_argument("--interval", type=float, default=60.0)
    args = parser.parse_args()

    data_dir = default_data_dir()
    data_dir.mkdir(parents=True, exist_ok=True)
    static_dir = Path(__file__).resolve().parent / "dashboard"

    app_state = AppState(
        lock=threading.Lock(),
        state={"ts": time.time(), "mobile": [], "fixed": [], "meta": {"server_start_ts": time.time()}},
        persistent_mobile={},
    )
    stop_event = threading.Event()

    threading.Thread(target=fetch_loop, kwargs=dict(app_state=app_state, data_dir=data_dir, interval_s=args.interval, stop_event=stop_event), daemon=True).start()
    threading.Thread(target=watch_sensor_names_loop, kwargs=dict(app_state=app_state, data_dir=data_dir, stop_event=stop_event), daemon=True).start()

    httpd = ThreadingHTTPServer((args.host, args.port), make_handler(app_state=app_state, static_dir=static_dir))
    if args.https:
        cert_path = Path(args.cert) if args.cert else (data_dir / "dev-cert.pem")
        key_path = Path(args.key) if args.key else (data_dir / "dev-key.pem")
        if not (cert_path.exists() and key_path.exists()):
            subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "365", "-keyout", str(key_path), "-out", str(cert_path), "-subj", "/CN=mobileair-dev"], check=True)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(certfile=str(cert_path), keyfile=str(key_path))
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)

    # print(f"Server optimized. Dashboard: {'https' if args.https else 'http'}://{args.host}:{args.port}")
    scheme = "https" if args.https else "http"
    print(f"Server optimized. Dashboard listening on {args.host}:{args.port} ({scheme})")
    if scheme == "http":
        # Provide explicit http:// URLs to minimize client-side HTTPS auto-upgrade friction.
        ips = _guess_lan_ips()
        if args.host in ("0.0.0.0", "::"):
            for ip in ips[:5]:
                print(f"Open: http://{ip}:{args.port}/")
        elif args.host and args.host not in ("127.0.0.1", "localhost"):
            print(f"Open: http://{args.host}:{args.port}/")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt: pass
    finally:
        stop_event.set()
        httpd.shutdown()
    return 0

if __name__ == "__main__":
    main()