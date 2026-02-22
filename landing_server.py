#!/usr/bin/env python3
"""
Minimal static file server for the funstuff.app landing page.

Serves files from the landing/ directory on a configurable port.
Intended to run behind cloudflared tunnel.
"""
from __future__ import annotations

import argparse
import mimetypes
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

STATIC_DIR = Path(__file__).resolve().parent / "landing"

# Ensure sensible MIME types
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/json", ".json")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("image/png", ".png")
mimetypes.add_type("image/x-icon", ".ico")


class LandingHandler(BaseHTTPRequestHandler):
    """Serve static files with caching headers and security headers."""

    server_version = "funstuff/1.0"

    def do_GET(self):
        # Strip query string
        path = self.path.split("?")[0].split("#")[0]

        # Normalize
        if path == "/" or path == "":
            path = "/index.html"

        # Prevent directory traversal
        requested = (STATIC_DIR / path.lstrip("/")).resolve()
        if not str(requested).startswith(str(STATIC_DIR)):
            self.send_error(403, "Forbidden")
            return

        if not requested.is_file():
            # Try .html extension
            html_path = requested.with_suffix(".html")
            if html_path.is_file():
                requested = html_path
            else:
                self.send_error(404, "Not Found")
                return

        mime, _ = mimetypes.guess_type(str(requested))
        if mime is None:
            mime = "application/octet-stream"

        try:
            data = requested.read_bytes()
        except OSError:
            self.send_error(500, "Internal Server Error")
            return

        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))

        # Cache: HTML short, assets longer
        if mime == "text/html":
            self.send_header("Cache-Control", "public, max-age=300")
        else:
            self.send_header("Cache-Control", "public, max-age=86400")

        # Security headers
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")

        self.end_headers()
        self.wfile.write(data)

    def do_HEAD(self):
        self.do_GET()

    def log_message(self, fmt, *args):
        msg = fmt % args if args else fmt
        sys.stdout.write(f"[landing] {msg}\n")
        sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser(description="funstuff.app landing page server")
    parser.add_argument("--host", default="0.0.0.0", help="Bind address (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=8767, help="Port (default: 8767)")
    args = parser.parse_args()

    if not STATIC_DIR.is_dir():
        print(f"[landing] ERROR: static dir not found: {STATIC_DIR}", file=sys.stderr)
        sys.exit(1)

    server = ThreadingHTTPServer((args.host, args.port), LandingHandler)
    print(f"[landing] Serving {STATIC_DIR} on {args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[landing] Shutting down.")
        server.shutdown()


if __name__ == "__main__":
    main()
