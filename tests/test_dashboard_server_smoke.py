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
                self.assertIn("no-store", cc)
                payload = resp.read().decode("utf-8")
                data = json.loads(payload)
                self.assertIn("mobile", data)
            finally:
                httpd.shutdown()
                th.join(timeout=2)


if __name__ == "__main__":
    unittest.main()


