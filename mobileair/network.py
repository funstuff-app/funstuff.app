"""
Network operations for MobileAir.

Handles HTTP fetching with on-disk caching for resilience.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from typing import Any, Callable


# Optional requests import for tests/injection
try:
    import requests
except Exception:  # pragma: no cover
    requests = None  # type: ignore


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
        request_get: Optional replacement for requests.get (for testing).
        notify: Optional callback for status messages (message, severity).

    Returns:
        Parsed JSON data, or None on failure.
    """
    if request_get is None:
        if requests is None:  # pragma: no cover
            raise RuntimeError("requests not available; pass request_get for tests.")
        request_get = requests.get

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
