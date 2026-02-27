import json
import socket
import threading
import time
import unittest
from http.client import HTTPConnection
from pathlib import Path
from tempfile import TemporaryDirectory

import dashboard_server as srv


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    addr, port = s.getsockname()
    s.close()
    return port


class TestDashboardServerSmoke(unittest.TestCase):
    def test_api_state_serves_json(self):
        with TemporaryDirectory() as td:
            data_dir = Path(td) / "data"
            static_dir = Path(td) / "dashboard"
            data_dir.mkdir(parents=True, exist_ok=True)
            static_dir.mkdir(parents=True, exist_ok=True)

            # minimal static files required by handler
            (static_dir / "index.html").write_text("<html>ok</html>", encoding="utf-8")
            (static_dir / "app.js").write_text("console.log('ok')", encoding="utf-8")
            (static_dir / "styles.css").write_text("body{}", encoding="utf-8")

            app_state = srv.AppState(
                lock=threading.Lock(),
                state={"ts": time.time(), "mobile": [], "fixed": [], "meta": {}},
                persistent_mobile={}
            )

            # Instead of running fetch_loop, just set a known state once.
            with app_state.lock:
                app_state.state = {"ts": time.time(), "mobile": [{"id": "BUS1"}], "fixed": [], "meta": {}}

            handler = srv.make_handler(app_state=app_state, static_dir=static_dir, data_dir=static_dir)
            port = _free_port()
            httpd = srv.ThreadingHTTPServer(("127.0.0.1", port), handler)

            th = threading.Thread(target=httpd.serve_forever, daemon=True)
            th.start()
            try:
                conn = HTTPConnection("127.0.0.1", port, timeout=2)
                conn.request("GET", "/api/state")
                resp = conn.getresponse()
                self.assertEqual(resp.status, 200)
                cc = resp.getheader("Cache-Control") or ""
                self.assertIn("max-age=", cc)
                etag = resp.getheader("ETag")
                self.assertIsNotNone(etag, "Response should include an ETag header")
                payload = resp.read().decode("utf-8")
                data = json.loads(payload)
                self.assertIn("mobile", data)

                # Conditional GET with matching ETag should return 304
                conn2 = HTTPConnection("127.0.0.1", port, timeout=2)
                conn2.request("GET", "/api/state", headers={"If-None-Match": etag})
                resp2 = conn2.getresponse()
                self.assertEqual(resp2.status, 304)
                self.assertEqual(len(resp2.read()), 0)
            finally:
                httpd.shutdown()
                th.join(timeout=2)

    def test_api_state_delta_delivery(self):
        """Delta delivery: ?since_ms= strips old trail points and sets meta.delta."""
        with TemporaryDirectory() as td:
            data_dir = Path(td) / "data"
            static_dir = Path(td) / "dashboard"
            data_dir.mkdir(parents=True, exist_ok=True)
            static_dir.mkdir(parents=True, exist_ok=True)
            (static_dir / "index.html").write_text("<html>ok</html>", encoding="utf-8")

            # Trail with two points at known timestamps
            trail = [
                {"lat": 40.7, "lon": -111.9, "t": "2026-02-26 18:00:00 UTC", "m": 1},
                {"lat": 40.8, "lon": -111.8, "t": "2026-02-26 18:10:00 UTC", "m": 1},
            ]
            app_state = srv.AppState(
                lock=threading.Lock(),
                state={"ts": time.time(), "mobile": [{"id": "BUS1", "trail": trail}], "fixed": [], "meta": {}},
                persistent_mobile={},
            )

            handler = srv.make_handler(app_state=app_state, static_dir=static_dir, data_dir=static_dir)
            port = _free_port()
            httpd = srv.ThreadingHTTPServer(("127.0.0.1", port), handler)
            th = threading.Thread(target=httpd.serve_forever, daemon=True)
            th.start()
            try:
                # Full fetch — both points
                conn = HTTPConnection("127.0.0.1", port, timeout=2)
                conn.request("GET", "/api/state")
                resp = conn.getresponse()
                full = json.loads(resp.read().decode())
                self.assertEqual(len(full["mobile"][0]["trail"]), 2)
                self.assertNotIn("delta", full.get("meta", {}))

                # Delta fetch — since_ms = epoch ms of first point → only second point
                # 2026-02-26 18:00:00 UTC = 1772128800 seconds = 1772128800000 ms
                since_ms = 1772128800000
                conn2 = HTTPConnection("127.0.0.1", port, timeout=2)
                conn2.request("GET", f"/api/state?since_ms={since_ms}")
                resp2 = conn2.getresponse()
                delta = json.loads(resp2.read().decode())
                self.assertTrue(delta["meta"].get("delta"), "Response should have meta.delta=True")
                self.assertEqual(len(delta["mobile"][0]["trail"]), 1)
                self.assertEqual(delta["mobile"][0]["trail"][0]["t"], "2026-02-26 18:10:00 UTC")
            finally:
                httpd.shutdown()
                th.join(timeout=2)


if __name__ == "__main__":
    unittest.main()


