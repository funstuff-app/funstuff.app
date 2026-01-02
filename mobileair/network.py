"""
Network operations for MobileAir.

Handles HTTP fetching with on-disk caching for resilience.
Uses Python stdlib (urllib.request) to avoid heavy dependencies like requests/urllib3.
"""

from __future__ import annotations

import hashlib
import json
import os
import ssl
import sys
import time
import urllib.request
import urllib.error
from typing import Any, Callable


def _get_ssl_context() -> ssl.SSLContext:
    """Get SSL context with proper CA certificates for PyInstaller bundles."""
    ctx = ssl.create_default_context()
    
    # For PyInstaller bundles, try to find bundled certifi CA bundle
    if getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS'):
        # Look for bundled certifi CA bundle
        bundle_dir = sys._MEIPASS
        certifi_path = os.path.join(bundle_dir, 'certifi', 'cacert.pem')
        if os.path.exists(certifi_path):
            ctx.load_verify_locations(certifi_path)
            return ctx
    
    # Try certifi if available (normal Python environment)
    try:
        import certifi
        ctx.load_verify_locations(certifi.where())
    except ImportError:
        pass  # Use system certs
    
    return ctx


class StdlibResponse:
    """Simple response wrapper to match requests-like interface."""
    def __init__(self, data: bytes, status: int):
        self.content = data
        self.text = data.decode("utf-8", errors="replace")
        self.status_code = status
    
    def json(self) -> Any:
        return json.loads(self.text)
    
    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise urllib.error.HTTPError(
                None, self.status_code, f"HTTP {self.status_code}", {}, None
            )


# Cache SSL context to avoid recreating it on every request
_SSL_CONTEXT: ssl.SSLContext | None = None


def stdlib_get(url: str, headers: dict | None = None, timeout: float = 10) -> StdlibResponse:
    """Simple HTTP GET using Python stdlib (no requests/urllib3 needed)."""
    global _SSL_CONTEXT
    
    req = urllib.request.Request(url)
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    req.add_header("User-Agent", "MobileAir/1.0")
    
    # Use cached SSL context for HTTPS requests
    context = None
    if url.startswith('https://'):
        if _SSL_CONTEXT is None:
            _SSL_CONTEXT = _get_ssl_context()
        context = _SSL_CONTEXT
    
    with urllib.request.urlopen(req, timeout=timeout, context=context) as resp:
        data = resp.read()
        return StdlibResponse(data, resp.status)


def default_cache_path(url: str, *, mobile_url: str, fixed_url: str, data_dir: str) -> str:
    """Generate a default cache file path for a given URL."""
    if url == mobile_url:
        return os.path.join(data_dir, "cache_mobile.json")
    if url == fixed_url:
        return os.path.join(data_dir, "cache_fixed.json")
    digest = hashlib.sha1(url.encode("utf-8")).hexdigest()[:12]
    return os.path.join(data_dir, f"cache_{digest}.json")


def fetch_json_with_cache(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    timeout: float = 10,
    cache_path: str | None = None,
    request_get: Callable[..., Any] | None = None,
    notify: Callable[[str, str], None] | None = None,
) -> Any | None:
    """Fetch JSON from a URL with a best-effort on-disk cache.

    - On success: caches response JSON to cache_path (if provided).
    - On failure: returns cached JSON if available, else None.

    Args:
        url: The URL to fetch.
        headers: Optional HTTP headers.
        timeout: Request timeout in seconds.
        cache_path: Path to cache file (optional).
        request_get: Optional replacement for stdlib_get (for testing).
        notify: Optional callback for status messages (message, severity).

    Returns:
        Parsed JSON data, or None on failure.
    """
    if request_get is None:
        request_get = stdlib_get

    def _notify(msg: str, severity: str) -> None:
        if notify:
            notify(msg, severity)

    try:
        resp = request_get(url, headers=headers, timeout=timeout)
        if hasattr(resp, "raise_for_status"):
            resp.raise_for_status()
        data = resp.json() if hasattr(resp, "json") else json.loads(resp.text)

        if cache_path:
            try:
                os.makedirs(os.path.dirname(cache_path), exist_ok=True)
                with open(cache_path, "w") as f:
                    json.dump(data, f)
            except Exception:
                pass

        return data
    except Exception as e:
        _notify(f"Error fetching data from {url}: {e}", "error")

        if cache_path:
            try:
                if os.path.exists(cache_path):
                    with open(cache_path, "r") as f:
                        cached = json.load(f)
                    try:
                        age_s = max(0, int(time.time() - os.path.getmtime(cache_path)))
                        _notify(f"Using cached data ({age_s}s old) for {url}", "warning")
                    except Exception:
                        _notify(f"Using cached data for {url}", "warning")
                    return cached
            except Exception:
                pass

        return None
