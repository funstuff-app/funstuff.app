"""
RTMA-RU wind vector field fetcher.

Downloads a subsetted GRIB2 file from NOAA NOMADS containing the 2.5 km
gridded 10 m wind analysis (U/V components) for the SLC region, parses it
with cfgrib/xarray, and returns a flat list of {lat, lon, u, v} dicts ready
for JSON serialization to the browser.

RTMA-RU (Real-Time Mesoscale Analysis – Rapid Update) assimilates real
surface observations every 15 minutes.  New data is available with
15–20 minutes of latency.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

# ── SLC bounding box (padded slightly beyond the dashboard SLC_BOUNDS) ───────
_TOP_LAT = 41.5
_BOTTOM_LAT = 39.5
_LEFT_LON = -113
_RIGHT_LON = -111

# ── NOMADS base URL ──────────────────────────────────────────────────────────
_NOMADS_BASE = "https://nomads.ncep.noaa.gov/cgi-bin/filter_rtma_ru.pl"

# ── Availability lag: how far behind UTC to request ──────────────────────────
_LAG_MINUTES = 30


def _round_to_15min(dt: datetime) -> datetime:
    """Round a datetime DOWN to the nearest 15-minute boundary."""
    minute = (dt.minute // 15) * 15
    return dt.replace(minute=minute, second=0, microsecond=0)


def _build_nomads_url(analysis_time: datetime) -> str:
    """Build the NOMADS grib-filter URL for a given analysis time (UTC)."""
    date_str = analysis_time.strftime("%Y%m%d")
    time_str = analysis_time.strftime("%H%M")
    return (
        f"{_NOMADS_BASE}"
        f"?dir=%2Frtma2p5_ru.{date_str}"
        f"&file=rtma2p5_ru.t{time_str}z.2dvaranl_ndfd.grb2"
        f"&var_UGRD=on"
        f"&var_VGRD=on"
        f"&lev_10_m_above_ground=on"
        f"&subregion="
        f"&toplat={_TOP_LAT}"
        f"&leftlon={_LEFT_LON}"
        f"&rightlon={_RIGHT_LON}"
        f"&bottomlat={_BOTTOM_LAT}"
    )


def _latest_analysis_time(now_utc: datetime | None = None) -> datetime:
    """Return the most recent analysis time likely to be available."""
    if now_utc is None:
        now_utc = datetime.now(timezone.utc)
    lagged = now_utc - timedelta(minutes=_LAG_MINUTES)
    return _round_to_15min(lagged)


def fetch_grib2(analysis_time: datetime | None = None,
                timeout_s: int = 30) -> bytes | None:
    """Download the RTMA-RU GRIB2 subset for SLC from NOMADS.

    Returns raw GRIB2 bytes on success, or None on failure.
    """
    if analysis_time is None:
        analysis_time = _latest_analysis_time()

    url = _build_nomads_url(analysis_time)
    log.info("Fetching RTMA-RU: %s", url)

    req = urllib.request.Request(url, headers={"User-Agent": "DustyTrails/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            content_type = resp.headers.get("Content-Type", "")
            if "text/html" in content_type:
                log.warning("NOMADS returned HTML (file not ready): %s", url)
                return None
            data = resp.read()
            if len(data) < 100:
                log.warning("NOMADS response too small (%d bytes)", len(data))
                return None
            log.info("RTMA-RU downloaded: %d bytes", len(data))
            return data
    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
        log.warning("RTMA-RU fetch failed: %s", e)
        return None


def parse_grib2(grib2_bytes: bytes) -> list[dict[str, float]]:
    """Parse GRIB2 bytes into a list of {lat, lon, u, v} dicts.

    Requires cfgrib and xarray to be installed.

    Raises RuntimeError when parsing fails or dependencies are missing.
    """
    try:
        import xarray as xr
    except ImportError as e:
        log.warning("xarray/cfgrib not available: %s — wind parsing disabled", e)
        return []

    # Write to a temp file in a writable directory so cfgrib can create
    # its .idx sidecar without errors.
    with tempfile.TemporaryDirectory(prefix="rtma_") as tmp_dir:
        grib_path = os.path.join(tmp_dir, "rtma.grib2")
        with open(grib_path, "wb") as f:
            f.write(grib2_bytes)

        try:
            ds = xr.open_dataset(grib_path, engine="cfgrib")
        except Exception as e:
            raise RuntimeError(f"cfgrib parse error: {e}") from e

        # Discover variable names (cfgrib naming varies)
        data_vars = list(ds.data_vars)
        log.info("GRIB2 data_vars: %s", data_vars)

        u_var = v_var = None
        for name in data_vars:
            low = str(name).lower()
            if low in ("u10", "u", "ugrd"):
                u_var = name
            elif low in ("v10", "v", "vgrd"):
                v_var = name

        if u_var is None or v_var is None:
            ds.close()
            raise RuntimeError(f"Could not find U/V variables in {data_vars}")

        u_vals = ds[u_var].values  # shape (y, x) — 2D
        v_vals = ds[v_var].values
        lat_vals = ds["latitude"].values  # shape (y, x)
        lon_vals = ds["longitude"].values  # shape (y, x)
        ds.close()

    # Longitude: RTMA-RU uses 0-360 internally
    if lon_vals.max() > 180:
        lon_vals = lon_vals - 360

    points: list[dict[str, float]] = []
    ny, nx = u_vals.shape
    for iy in range(ny):
        for ix in range(nx):
            lat = float(lat_vals[iy, ix])
            lon = float(lon_vals[iy, ix])
            u = float(u_vals[iy, ix])
            v = float(v_vals[iy, ix])
            if not (lat == lat and lon == lon and u == u and v == v):
                continue  # skip NaN
            points.append({
                "lat": round(lat, 4),
                "lon": round(lon, 4),
                "u": round(u, 2),
                "v": round(v, 2),
            })

    if not points:
        raise RuntimeError("GRIB2 parsed but produced no valid wind points")

    log.info("Parsed %d wind grid points (%dx%d)", len(points), nx, ny)
    return points


def fetch_wind_field(analysis_time: datetime | None = None,
                     timeout_s: int = 30) -> list[dict[str, float]]:
    """Fetch + parse in one call.

    Returns [] when the GRIB2 file is not available yet.
    Raises RuntimeError on parse/dependency failures.
    """
    grib = fetch_grib2(analysis_time=analysis_time, timeout_s=timeout_s)
    if grib is None:
        return []
    return parse_grib2(grib)


# ─── JSON cache file management ─────────────────────────────────────────────

def _wind_cache_path(data_dir: Path) -> Path:
    return data_dir / "wind_field.json"


def _wind_snapshots_dir(data_dir: Path) -> Path:
    return data_dir / "wind_snapshots"


def save_wind_field(points: list[dict[str, float]], data_dir: Path,
                    analysis_time: datetime | None = None) -> None:
    """Write wind field JSON with metadata to data_dir/wind_field.json."""
    payload = {
        "ts": time.time(),
        "analysis_time": analysis_time.isoformat() if analysis_time else None,
        "count": len(points),
        "points": points,
    }
    path = _wind_cache_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload), encoding="utf-8")
    tmp.replace(path)


def save_wind_snapshot(points: list[dict[str, float]], data_dir: Path,
                       analysis_time: datetime) -> str:
    """Save a wind snapshot keyed by HHMM.  Returns the HHMM key."""
    key = analysis_time.strftime("%H%M")
    snap_dir = _wind_snapshots_dir(data_dir)
    snap_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "ts": time.time(),
        "analysis_time": analysis_time.isoformat(),
        "count": len(points),
        "points": points,
    }
    path = snap_dir / f"{key}.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload), encoding="utf-8")
    tmp.replace(path)
    return key


def load_wind_snapshots(data_dir: Path) -> dict[str, list[dict[str, float]]]:
    """Load all wind snapshots from disk.  Returns {HHMM: points_list}."""
    snap_dir = _wind_snapshots_dir(data_dir)
    if not snap_dir.is_dir():
        return {}
    result: dict[str, list[dict[str, float]]] = {}
    for p in sorted(snap_dir.glob("*.json")):
        key = p.stem  # "0815" etc.
        if len(key) != 4 or not key.isdigit():
            continue
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            pts = data.get("points", [])
            if isinstance(pts, list) and pts:
                result[key] = pts
        except Exception:
            pass
    return result


def clear_wind_snapshots(data_dir: Path) -> None:
    """Remove all wind snapshot files (called on new day)."""
    snap_dir = _wind_snapshots_dir(data_dir)
    if not snap_dir.is_dir():
        return
    for p in snap_dir.glob("*.json"):
        try:
            p.unlink()
        except Exception:
            pass


def load_wind_field(data_dir: Path) -> dict[str, Any] | None:
    """Load cached wind field JSON.  Returns None if not present or corrupt."""
    path = _wind_cache_path(data_dir)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("points"), list):
            return data
    except Exception:
        pass
    return None
