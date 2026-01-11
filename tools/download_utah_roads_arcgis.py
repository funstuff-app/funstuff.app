#!/usr/bin/env python3
"""Download Utah roads from an ArcGIS FeatureServer layer as GeoJSON.

This is an OFFLINE preprocessing tool intended to feed:
  tools/build_utah_centerlines_graph.py

Why this exists:
- ArcGIS layers often have a max page size (here: ~2000), so we must paginate.
- We avoid fetching all OBJECTIDs at once (huge response).
- We write GeoJSON incrementally to avoid holding ~400k features in memory.

Example:
  python tools/download_utah_roads_arcgis.py \
    --out ~/.mobileair/roads/utah_centerlines.geojson

Then:
  python tools/build_utah_centerlines_graph.py \
    ~/.mobileair/roads/utah_centerlines.geojson \
    ~/.mobileair/roads/utah_centerlines_graph.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from typing import Any

DEFAULT_LAYER_URL = (
    "https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services/UtahRoads/FeatureServer/0"
)


# Utah county FIPS codes (state 49 + county). Used for ArcGIS COUNTY_L/COUNTY_R.
# Values are integers like 49035.
UTAH_COUNTY_FIPS_BY_NAME: dict[str, int] = {
    "beaver": 49001,
    "box elder": 49003,
    "cache": 49005,
    "carbon": 49007,
    "daggett": 49009,
    "davis": 49011,
    "duchesne": 49013,
    "emery": 49015,
    "garfield": 49017,
    "grand": 49019,
    "iron": 49021,
    "kane": 49025,
    "millard": 49027,
    "morgan": 49029,
    "piute": 49031,
    "rich": 49033,
    "salt lake": 49035,
    "san juan": 49023,
    "sanpete": 49039,
    "san pete": 49039,
    "sevier": 49041,
    "summit": 49043,
    "tooele": 49045,
    "uintah": 49047,
    "utah": 49049,
    "wasatch": 49051,
    "washington": 49053,
    "wayne": 49055,
    "weber": 49057,
}


def _normalize_county_name(name: str) -> str:
    s = (name or "").strip().lower()
    if s.endswith(" county"):
        s = s[: -len(" county")].strip()
    s = " ".join(s.split())
    return s


def _parse_county_fips(county: str) -> int:
    s = (county or "").strip()
    if not s:
        raise ValueError("county must be non-empty")

    # Allow raw numeric FIPS.
    if s.isdigit():
        f = int(s)
        if f < 49000 or f > 49999:
            raise ValueError(f"unexpected Utah county FIPS: {f}")
        return f

    norm = _normalize_county_name(s)
    # Common abbreviations.
    if norm in {"slc", "salt lake city"}:
        norm = "salt lake"

    fips = UTAH_COUNTY_FIPS_BY_NAME.get(norm)
    if fips is None:
        raise ValueError(
            "unknown Utah county. Examples: --county 'Salt Lake County', --county slc, or --county 49035"
        )
    return fips


def _compose_where(base_where: str, county_fips: int | None) -> str:
    w = (base_where or "").strip() or "1=1"
    if county_fips is None:
        return w
    county_clause = f"(COUNTY_L = {int(county_fips)} OR COUNTY_R = {int(county_fips)})"
    if w == "1=1":
        return county_clause
    return f"({w}) AND {county_clause}"


def _http_get_json(url: str, *, timeout_s: float = 60.0) -> Any:
    req = urllib.request.Request(url, headers={"User-Agent": "MobileAir/road-data-tool"})
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        data = resp.read()
    return json.loads(data.decode("utf-8"))


def _build_query_url(layer_url: str, params: dict[str, Any]) -> str:
    base = layer_url.rstrip("/") + "/query"
    enc = urllib.parse.urlencode({k: str(v) for (k, v) in params.items()})
    return base + "?" + enc


def _is_arcgis_error(obj: Any) -> bool:
    return isinstance(obj, dict) and isinstance(obj.get("error"), dict)


def _raise_for_arcgis_error(obj: Any, url: str) -> None:
    if not _is_arcgis_error(obj):
        return
    err = obj.get("error") or {}
    msg = err.get("message") or "ArcGIS error"
    details = err.get("details")
    if isinstance(details, list) and details:
        msg = f"{msg}: {details[0]}"
    raise RuntimeError(f"{msg} (url={url})")


def _get_count(layer_url: str, where: str) -> int:
    params = {
        "where": where,
        "returnCountOnly": "true",
        "f": "pjson",
    }
    url = _build_query_url(layer_url, params)
    obj = _http_get_json(url)
    _raise_for_arcgis_error(obj, url)
    cnt = obj.get("count") if isinstance(obj, dict) else None
    return int(cnt or 0)


def _iter_pages(
    *,
    layer_url: str,
    where: str,
    page_size: int,
    out_sr: int,
    timeout_s: float,
    sleep_s: float,
    max_features: int | None,
) -> tuple[int, list[dict[str, Any]]]:
    """Yield (offset, features) pages."""

    offset = 0
    seen = 0
    while True:
        # Prefer a stable order so resultOffset pagination is deterministic.
        params: dict[str, Any] = {
            "where": where,
            "outFields": "OBJECTID",
            "returnGeometry": "true",
            "orderByFields": "OBJECTID",
            "resultOffset": offset,
            "resultRecordCount": page_size,
            "outSR": out_sr,
            "f": "geojson",
        }
        url = _build_query_url(layer_url, params)

        # Simple retry loop: ArcGIS can intermittently 429/5xx.
        last_exc: Exception | None = None
        for attempt in range(1, 6):
            try:
                obj = _http_get_json(url, timeout_s=timeout_s)
                _raise_for_arcgis_error(obj, url)
                feats = obj.get("features") if isinstance(obj, dict) else None
                if not isinstance(feats, list):
                    raise RuntimeError(f"unexpected response shape (url={url})")
                yield (offset, feats)
                break
            except Exception as e:  # noqa: BLE001 - CLI tool, we surface the error
                last_exc = e
                if attempt >= 5:
                    raise
                backoff = min(30.0, 0.75 * (2 ** (attempt - 1)))
                print(f"warn: request failed (attempt {attempt}/5): {e}")
                print(f"warn: sleeping {backoff:.2f}s then retrying")
                time.sleep(backoff)
        else:
            assert last_exc is not None
            raise last_exc

        # Update counters and stop condition.
        got = len(feats)
        seen += got
        if got == 0:
            return

        if max_features is not None and seen >= max_features:
            return

        offset += got

        if sleep_s > 0:
            time.sleep(sleep_s)


def _write_geojson_streaming(
    *,
    out_path: str,
    pages_iter: Any,
    max_features: int | None,
    expected_count: int | None,
) -> int:
    """Write a GeoJSON FeatureCollection incrementally.

    Writes to a temp file and swaps into place at the end.
    """

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    tmp_path = out_path + ".tmp"

    written = 0
    t0 = time.time()
    last_print = 0.0

    with open(tmp_path, "w", encoding="utf-8") as f:
        f.write('{"type":"FeatureCollection","features":[\n')
        first = True

        for offset, feats in pages_iter:
            for feat in feats:
                if max_features is not None and written >= max_features:
                    break
                if not isinstance(feat, dict) or feat.get("type") != "Feature":
                    continue
                if not first:
                    f.write(",\n")
                json.dump(feat, f, ensure_ascii=False, separators=(",", ":"))
                first = False
                written += 1

            now = time.time()
            if now - last_print > 1.5:
                rate = written / max(0.001, now - t0)
                if expected_count:
                    print(f"Wrote {written}/{expected_count} (offset {offset}, {rate:.1f}/s)")
                else:
                    print(f"Wrote {written} (offset {offset}, {rate:.1f}/s)")
                last_print = now

            if max_features is not None and written >= max_features:
                break

        f.write("\n]}\n")

    os.replace(tmp_path, out_path)
    return written


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--layer-url", default=DEFAULT_LAYER_URL, help="ArcGIS layer base URL (ending in /<layerId>)")
    parser.add_argument("--where", default="1=1", help="ArcGIS SQL where clause")
    parser.add_argument(
        "--county",
        default=None,
        help="Limit to a Utah county by name (e.g. 'Salt Lake County' or 'slc') or numeric FIPS (e.g. 49035)",
    )
    parser.add_argument(
        "--county-bounds",
        dest="county",
        help="Alias for --county (historical naming)",
    )
    parser.add_argument(
        "--out",
        required=True,
        help="Output GeoJSON path (EPSG:4326), e.g. ~/.mobileair/roads/utah_centerlines.geojson",
    )
    parser.add_argument("--page-size", type=int, default=2000, help="Features per request (ArcGIS max is often 2000)")
    parser.add_argument("--out-sr", type=int, default=4326, help="Output spatial reference WKID (recommend 4326 for GeoJSON)")
    parser.add_argument("--timeout", type=float, default=60.0, help="HTTP timeout seconds")
    parser.add_argument("--sleep", type=float, default=0.0, help="Sleep seconds between pages")
    parser.add_argument("--max-features", type=int, default=None, help="Debug: stop after this many features")

    args = parser.parse_args(argv[1:])

    page_size = int(args.page_size)
    if page_size <= 0:
        raise SystemExit("--page-size must be > 0")
    # The service we probed reports maxRecordCount=2000; clamp defensively.
    page_size = min(page_size, 2000)

    layer_url = str(args.layer_url).rstrip("/")
    out_path = os.path.expanduser(str(args.out))

    county_fips: int | None = None
    if args.county is not None:
        try:
            county_fips = _parse_county_fips(str(args.county))
        except Exception as e:
            raise SystemExit(f"invalid --county: {e}")

    where = _compose_where(str(args.where), county_fips)

    print(f"Layer: {layer_url}")
    print(f"Where: {where}")
    if county_fips is not None:
        print(f"County FIPS: {county_fips}")
    expected_count: int | None
    try:
        cnt = _get_count(layer_url, where)
        if args.max_features is not None:
            cnt = min(cnt, int(args.max_features))
        print(f"Count: {cnt}")
        expected_count = cnt
    except Exception as e:
        print(f"warn: failed to fetch count: {e}")
        expected_count = None

    pages_iter = _iter_pages(
        layer_url=layer_url,
        where=where,
        page_size=page_size,
        out_sr=int(args.out_sr),
        timeout_s=float(args.timeout),
        sleep_s=float(args.sleep),
        max_features=(int(args.max_features) if args.max_features is not None else None),
    )

    written = _write_geojson_streaming(
        out_path=out_path,
        pages_iter=pages_iter,
        max_features=(int(args.max_features) if args.max_features is not None else None),
        expected_count=expected_count,
    )
    print(f"Done: wrote {written} features -> {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
