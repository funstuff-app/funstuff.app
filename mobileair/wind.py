"""
RTMA-RU wind vector field fetcher.

Downloads a subsetted GRIB2 file from NOAA NOMADS containing the 2.5 km
gridded 10 m wind analysis (U/V components) for the SLC region, parses it
with a built-in pure-Python GRIB2 decoder (no native libraries required),
and returns a flat list of {lat, lon, u, v} dicts ready for JSON
serialization to the browser.

RTMA-RU (Real-Time Mesoscale Analysis – Rapid Update) assimilates real
surface observations every 15 minutes.  New data is available with
15–20 minutes of latency.
"""

from __future__ import annotations

import json
import logging
import math
import os
import struct
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


def fetch_grib2(analysis_time: datetime,
                timeout_s: int = 30) -> bytes | None:
    """Download the RTMA-RU GRIB2 subset for SLC from NOMADS.

    Returns raw GRIB2 bytes on success, or None on failure.
    """
    url = _build_nomads_url(analysis_time)
    log.debug("Fetching RTMA-RU: %s", url)

    req = urllib.request.Request(url, headers={"User-Agent": "DustyTrails/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            content_type = resp.headers.get("Content-Type", "")
            if "text/html" in content_type:
                log.debug("NOMADS returned HTML (file not ready): %s", url)
                return None
            data = resp.read()
            if len(data) < 100:
                log.debug("NOMADS response too small (%d bytes)", len(data))
                return None
            log.info("RTMA-RU downloaded: %d bytes", len(data))
            return data
    except urllib.error.HTTPError as e:
        if e.code == 404:
            log.debug("RTMA-RU not available yet: %s", analysis_time.strftime("%H%M"))
        else:
            log.warning("RTMA-RU fetch failed: %s", e)
        return None
    except (urllib.error.URLError, OSError) as e:
        log.warning("RTMA-RU fetch failed: %s", e)
        return None


def parse_grib2(grib2_bytes: bytes) -> list[dict[str, float]]:
    """Parse GRIB2 bytes into a list of {lat, lon, u, v} dicts.

    Pure-Python implementation — no xarray, cfgrib, or eccodes needed.
    Supports Lambert Conformal (template 30) with simple packing (DRT 0),
    which is what NOMADS RTMA-RU returns for our SLC subregion.

    Returns an empty list if parsing fails.
    """
    try:
        messages = _parse_grib2_messages(grib2_bytes)
    except Exception as e:
        log.error("GRIB2 parse failed: %s", e)
        return []

    if len(messages) < 2:
        log.error("Expected 2 GRIB2 messages (U, V), got %d", len(messages))
        return []

    # Messages: cat=2/num=2 → UGRD, cat=2/num=3 → VGRD
    u_msg = v_msg = None
    for m in messages:
        if m["param"] == (2, 2):
            u_msg = m
        elif m["param"] == (2, 3):
            v_msg = m
    if u_msg is None or v_msg is None:
        log.error("Could not find U/V messages in GRIB2")
        return []

    grid = u_msg["grid"]
    u_vals = u_msg["values"]
    v_vals = v_msg["values"]

    ni, nj = grid["ni"], grid["nj"]
    if len(u_vals) != ni * nj or len(v_vals) != ni * nj:
        log.error("Grid size mismatch: ni*nj=%d, u=%d, v=%d",
                  ni * nj, len(u_vals), len(v_vals))
        return []

    # Compute lat/lon for each grid point using Lambert Conformal projection
    lats, lons = _lambert_conformal_grid(grid)

    points: list[dict[str, float]] = []
    for idx in range(ni * nj):
        lat = lats[idx]
        lon = lons[idx]
        u = u_vals[idx]
        v = v_vals[idx]
        if not (lat == lat and lon == lon and u == u and v == v):
            continue  # skip NaN
        points.append({
            "lat": round(lat, 4),
            "lon": round(lon, 4),
            "u": round(u, 2),
            "v": round(v, 2),
        })

    if not points:
        log.error("GRIB2 parsed but produced no valid wind points")
        return []

    log.info("Parsed %d wind grid points (%dx%d)", len(points), ni, nj)
    return points


# ─── Pure-Python GRIB2 binary parser ────────────────────────────────────────

def _parse_grib2_messages(data: bytes) -> list[dict]:
    """Walk a GRIB2 byte buffer and extract all messages."""
    messages = []
    offset = 0
    while offset < len(data) - 4:
        idx = data.find(b"GRIB", offset)
        if idx < 0:
            break
        if data[idx + 7] != 2:
            offset = idx + 4
            continue  # not GRIB edition 2
        msg_len = struct.unpack(">Q", data[idx + 8:idx + 16])[0]
        msg = _parse_single_message(data, idx, msg_len)
        if msg is not None:
            messages.append(msg)
        offset = idx + msg_len
    return messages


def _parse_single_message(data: bytes, start: int, msg_len: int) -> dict | None:
    """Parse one GRIB2 message starting at `start`."""
    pos = start + 16  # skip Section 0 (Indicator)

    # Section 1 (Identification)
    s1_len = struct.unpack(">I", data[pos:pos + 4])[0]
    pos += s1_len

    grid = None
    param = None
    ref_val = 0.0
    bin_scale = 0
    dec_scale = 0
    nbits = 0
    num_points = 0
    values = None

    end = start + msg_len
    while pos < end - 4:
        if data[pos:pos + 4] == b"7777":
            break
        sec_len = struct.unpack(">I", data[pos:pos + 4])[0]
        sec_num = data[pos + 4]

        if sec_num == 3:
            grid = _parse_grid_definition(data, pos, sec_len)

        elif sec_num == 4:
            pcat = data[pos + 9]
            pnum = data[pos + 10]
            param = (pcat, pnum)

        elif sec_num == 5:
            num_points = struct.unpack(">I", data[pos + 5:pos + 9])[0]
            drt = struct.unpack(">H", data[pos + 9:pos + 11])[0]
            if drt != 0:
                log.warning("Unsupported DRT %d (only simple packing supported)", drt)
                return None
            ref_val = struct.unpack(">f", data[pos + 11:pos + 15])[0]
            bin_scale = struct.unpack(">h", data[pos + 15:pos + 17])[0]
            dec_scale = struct.unpack(">h", data[pos + 17:pos + 19])[0]
            nbits = data[pos + 19]

        elif sec_num == 7:
            payload = data[pos + 5:pos + sec_len]
            values = _unpack_simple(payload, num_points, nbits,
                                    ref_val, bin_scale, dec_scale)

        pos += sec_len

    if grid is None or param is None or values is None:
        return None
    return {"grid": grid, "param": param, "values": values}


def _parse_grid_definition(data: bytes, pos: int, sec_len: int) -> dict:
    """Parse Section 3 grid definition. Supports template 30 (Lambert Conformal)."""
    num_pts = struct.unpack(">I", data[pos + 6:pos + 10])[0]
    template = struct.unpack(">H", data[pos + 12:pos + 14])[0]

    if template != 30:
        log.warning("Grid template %d not supported (expected 30)", template)
        return {"template": template, "ni": 0, "nj": 0}

    ni = struct.unpack(">I", data[pos + 30:pos + 34])[0]
    nj = struct.unpack(">I", data[pos + 34:pos + 38])[0]
    lat1 = struct.unpack(">i", data[pos + 38:pos + 42])[0] / 1e6
    lon1 = struct.unpack(">i", data[pos + 42:pos + 46])[0] / 1e6
    laD = struct.unpack(">i", data[pos + 47:pos + 51])[0] / 1e6
    loV = struct.unpack(">i", data[pos + 51:pos + 55])[0] / 1e6
    dx = struct.unpack(">I", data[pos + 55:pos + 59])[0] / 1e3
    dy = struct.unpack(">I", data[pos + 59:pos + 63])[0] / 1e3
    latin1 = struct.unpack(">i", data[pos + 65:pos + 69])[0] / 1e6
    latin2 = struct.unpack(">i", data[pos + 69:pos + 73])[0] / 1e6

    # Convert lon from 0–360 to -180–180
    if lon1 > 180:
        lon1 -= 360
    if loV > 180:
        loV -= 360

    return {
        "template": template,
        "ni": ni, "nj": nj,
        "lat1": lat1, "lon1": lon1,
        "laD": laD, "loV": loV,
        "dx": dx, "dy": dy,
        "latin1": latin1, "latin2": latin2,
    }


def _unpack_simple(payload: bytes, num_points: int, nbits: int,
                   R: float, E: int, D: int) -> list[float]:
    """Unpack GRIB2 simple packing (DRT 0) into float values.

    Formula: Y = (R + X * 2^E) / 10^D
    where X is the packed integer value.
    """
    if nbits == 0 or len(payload) == 0:
        return [R / (10 ** D)] * num_points

    factor_e = 2.0 ** E
    factor_d = 10.0 ** D

    # Bit-stream extraction
    values = []
    bit_pos = 0
    total_bits = len(payload) * 8
    for _ in range(num_points):
        if bit_pos + nbits > total_bits:
            break
        byte_idx = bit_pos >> 3
        bit_off = bit_pos & 7
        # Read up to 4 bytes to cover nbits
        raw = 0
        bits_remaining = nbits
        while bits_remaining > 0:
            available = 8 - bit_off
            take = min(available, bits_remaining)
            mask = (1 << take) - 1
            shift = available - take
            raw = (raw << take) | ((payload[byte_idx] >> shift) & mask)
            bits_remaining -= take
            bit_off = 0
            byte_idx += 1
        values.append((R + raw * factor_e) / factor_d)
        bit_pos += nbits

    return values


def _lambert_conformal_grid(grid: dict) -> tuple[list[float], list[float]]:
    """Compute lat/lon for each grid point on a Lambert Conformal Conic grid.

    Uses the standard GRIB2 Lambert Conformal formulas (template 3.30).
    Returns (lats, lons) as flat lists of length ni*nj.
    """
    ni = grid["ni"]
    nj = grid["nj"]
    lat1 = grid["lat1"]
    lon1 = grid["lon1"]
    loV = grid["loV"]
    latin1 = grid["latin1"]
    latin2 = grid["latin2"]
    dx = grid["dx"]
    dy = grid["dy"]

    deg2rad = math.pi / 180.0

    # Compute cone constant n
    if abs(latin1 - latin2) < 1e-6:
        n = math.sin(latin1 * deg2rad)
    else:
        n = (math.log(math.cos(latin1 * deg2rad) / math.cos(latin2 * deg2rad)) /
             math.log(math.tan((45 + latin2 / 2) * deg2rad) /
                      math.tan((45 + latin1 / 2) * deg2rad)))

    F = (math.cos(latin1 * deg2rad) *
         math.tan((45 + latin1 / 2) * deg2rad) ** n) / n

    R_earth = 6371229.0  # GRIB2 standard Earth radius in meters

    def _rho(lat_deg: float) -> float:
        return R_earth * F / (math.tan((45 + lat_deg / 2) * deg2rad) ** n)

    rho_origin = _rho(grid["laD"])  # rho at reference latitude (LaD)

    # Forward-project the first grid point to (x, y)
    rho1 = _rho(lat1)
    theta1 = n * (lon1 - loV) * deg2rad
    x0 = rho1 * math.sin(theta1)
    y0 = rho_origin - rho1 * math.cos(theta1)

    lats = []
    lons = []
    for j in range(nj):
        for i in range(ni):
            x = x0 + i * dx
            y = y0 + j * dy

            # Inverse projection: (x, y) → (lat, lon)
            dy_from_origin = rho_origin - y
            rho = math.copysign(math.sqrt(x * x + dy_from_origin * dy_from_origin), n)
            theta = math.atan2(x, dy_from_origin)

            if abs(rho) < 1e-10:
                lat = 90.0 if n > 0 else -90.0
            else:
                lat = (2 * math.atan((R_earth * F / rho) ** (1 / n)) - math.pi / 2) / deg2rad

            lon = loV + theta / (n * deg2rad)

            # Normalize longitude to -180..180
            while lon > 180:
                lon -= 360
            while lon < -180:
                lon += 360

            lats.append(lat)
            lons.append(lon)

    return lats, lons


def fetch_wind_field(analysis_time: datetime,
                     timeout_s: int = 30) -> list[dict[str, float]]:
    """Fetch + parse in one call.  Returns [] on any failure."""
    grib = fetch_grib2(analysis_time=analysis_time, timeout_s=timeout_s)
    if grib is None:
        return []
    return parse_grib2(grib)


# ─── Pre-interpolation to advection grid ─────────────────────────────────────

# Must match pa_advection_worker.js GEO_BOUNDS / DEFAULT_GW / DEFAULT_GH
_GRID_BOUNDS = {"latMin": 39.5, "latMax": 41.5, "lonMin": -113.0, "lonMax": -111.0}
_DEFAULT_GW = 80
_DEFAULT_GH = 60


def wind_to_grid(points: list[dict[str, float]],
                 gw: int = _DEFAULT_GW,
                 gh: int = _DEFAULT_GH,
                 bounds: dict | None = None) -> dict:
    """IDW-interpolate raw wind points onto a fixed advection grid.

    Returns ``{"gw": int, "gh": int, "bounds": {...},
               "uGrid": [float, ...], "vGrid": [float, ...]}``
    where uGrid/vGrid are flat row-major arrays of length gw*gh
    (m/s, NOT grid-cell-scaled — the worker applies its own scaling).

    The algorithm mirrors ``interpolateWindField()`` in
    ``pa_advection_worker.js`` but outputs in m/s so the worker can
    apply its own per-cell scaling without double-division.
    """
    b = bounds or _GRID_BOUNDS
    n = gw * gh
    u_grid = [0.0] * n
    v_grid = [0.0] * n

    if not points:
        return {"gw": gw, "gh": gh, "bounds": b,
                "uGrid": u_grid, "vGrid": v_grid}

    d_lon = (b["lonMax"] - b["lonMin"]) / gw
    d_lat = (b["latMax"] - b["latMin"]) / gh
    cutoff_sq = 1.0  # 1°² — matches JS cutoff

    for iy in range(gh):
        lat = b["latMin"] + (iy + 0.5) * d_lat
        for ix in range(gw):
            lon = b["lonMin"] + (ix + 0.5) * d_lon
            w_sum = 0.0
            u_sum = 0.0
            v_sum = 0.0
            for wp in points:
                dlat = lat - wp["lat"]
                dlon = lon - wp["lon"]
                d2 = dlat * dlat + dlon * dlon
                if d2 > cutoff_sq:
                    continue
                w = 1.0 / (d2 + 0.001)
                w_sum += w
                u_sum += w * wp["u"]
                v_sum += w * wp["v"]
            idx = iy * gw + ix
            if w_sum > 1e-12:
                u_grid[idx] = round(u_sum / w_sum, 3)
                v_grid[idx] = round(v_sum / w_sum, 3)

    return {"gw": gw, "gh": gh, "bounds": b,
            "uGrid": u_grid, "vGrid": v_grid}


# ─── JSON cache file management ─────────────────────────────────────────────

def _wind_cache_path(data_dir: Path) -> Path:
    return data_dir / "wind_field.json"


def _wind_snapshots_dir(data_dir: Path) -> Path:
    return data_dir / "wind_snapshots"


def save_wind_field(data: list | dict, data_dir: Path,
                    analysis_time: datetime | None = None) -> None:
    """Write wind field JSON with metadata to data_dir/wind_field.json.

    *data* may be either the legacy point list or a grid dict from
    ``wind_to_grid()``.
    """
    if isinstance(data, dict) and "gw" in data:
        # Grid format — store as-is with metadata
        payload = {
            "ts": time.time(),
            "analysis_time": analysis_time.isoformat() if analysis_time else None,
            "count": data["gw"] * data["gh"],
            "grid": data,
        }
    else:
        payload = {
            "ts": time.time(),
            "analysis_time": analysis_time.isoformat() if analysis_time else None,
            "count": len(data),
            "points": data,
        }
    path = _wind_cache_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload), encoding="utf-8")
    tmp.replace(path)


def save_wind_snapshot(data: list | dict, data_dir: Path,
                       analysis_time: datetime) -> str:
    """Save a wind snapshot keyed by HHMM.  Returns the HHMM key.

    *data* may be either the legacy point list or a grid dict from
    ``wind_to_grid()``.
    """
    key = analysis_time.strftime("%H%M")
    snap_dir = _wind_snapshots_dir(data_dir)
    snap_dir.mkdir(parents=True, exist_ok=True)
    if isinstance(data, dict) and "gw" in data:
        payload = {
            "ts": time.time(),
            "analysis_time": analysis_time.isoformat(),
            "count": data["gw"] * data["gh"],
            "grid": data,
        }
    else:
        payload = {
            "ts": time.time(),
            "analysis_time": analysis_time.isoformat(),
            "count": len(data),
            "points": data,
        }
    path = snap_dir / f"{key}.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload), encoding="utf-8")
    tmp.replace(path)
    return key


def load_wind_snapshots(data_dir: Path) -> dict[str, list | dict]:
    """Load all wind snapshots from disk.

    Returns ``{HHMM: grid_dict_or_points_list}``.
    """
    snap_dir = _wind_snapshots_dir(data_dir)
    if not snap_dir.is_dir():
        return {}
    result: dict[str, list | dict] = {}
    for p in sorted(snap_dir.glob("*.json")):
        key = p.stem  # "0815" etc.
        if len(key) != 4 or not key.isdigit():
            continue
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            # New grid format
            grid = data.get("grid")
            if isinstance(grid, dict) and "uGrid" in grid:
                result[key] = grid
                continue
            # Legacy point-list format
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
    """Load cached wind field JSON.  Returns None if not present or corrupt.

    The returned dict contains either ``"grid"`` (new format) or ``"points"``
    (legacy format) alongside metadata (``ts``, ``analysis_time``, ``count``).
    """
    path = _wind_cache_path(data_dir)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            if isinstance(data.get("grid"), dict) and "uGrid" in data["grid"]:
                return data
            if isinstance(data.get("points"), list):
                return data
    except Exception:
        pass
    return None


# ── DB-backed wind snapshot functions ─────────────────────────────────────────


def save_wind_snapshot_db(db_worker: Any, key: str, date: str,
                          points: list[dict[str, float]]) -> None:
    """Persist a wind snapshot to SQLite via the DbWorker queue."""
    db_worker.enqueue_wind_snapshot(key, date, points)


def load_wind_snapshots_db(db_worker: Any, date: str) -> dict[str, list[dict[str, float]]]:
    """Load all wind snapshots for a date from SQLite."""
    return db_worker.get_wind_snapshots(date)
