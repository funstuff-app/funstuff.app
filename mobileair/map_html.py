"""
Leaflet map HTML generation.

Generates standalone HTML pages for displaying sensors on a map.
"""

from __future__ import annotations

import json as _json
from typing import Any


def generate_leaflet_map_html(
    points: list[dict[str, Any]],
    *,
    title: str = "MobileAir Map",
    center: tuple[float, float] | None = None,
    zoom: int = 10,
) -> str:
    """Generate a standalone HTML page that renders a Leaflet map with circle markers.

    Each point dict supports:
    - lat (float), lon (float)
    - label (str) shown in tooltip
    - popup_html (str) shown in popup
    - color (str) marker outline/fill (e.g. "#ff0000")

    Args:
        points: List of point dicts with lat, lon, and optional label/popup/color.
        title: Page title.
        center: Optional center coordinates (lat, lon).
        zoom: Initial zoom level.

    Returns:
        Complete HTML page as a string.
    """
    safe_points = []
    for p in points:
        try:
            lat = float(p.get("lat"))
            lon = float(p.get("lon"))
        except Exception:
            continue
        safe_points.append(
            {
                "lat": lat,
                "lon": lon,
                "label": str(p.get("label", "")),
                "popup_html": str(p.get("popup_html", "")),
                "color": str(p.get("color", "#3388ff")),
            }
        )

    if center is None:
        if safe_points:
            center = (
                sum(p["lat"] for p in safe_points) / len(safe_points),
                sum(p["lon"] for p in safe_points) / len(safe_points),
            )
        else:
            center = (40.7608, -111.8910)  # SLC fallback

    payload = _json.dumps(safe_points)
    map_title = _json.dumps(title)

    return f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{title}</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
        integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin=""/>
  <style>
    html, body {{ height: 100%; margin: 0; }}
    #map {{ height: 100%; width: 100%; }}
    .titlebar {{
      position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
      z-index: 1000; background: rgba(0,0,0,0.75); color: #fff;
      padding: 6px 10px; border-radius: 8px; font-family: -apple-system, system-ui, sans-serif;
      font-size: 14px;
    }}
  </style>
</head>
<body>
  <div class="titlebar" id="title"></div>
  <div id="map"></div>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
          integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
  <script>
    const TITLE = {map_title};
    document.getElementById("title").textContent = TITLE;

    const map = L.map('map').setView([{center[0]}, {center[1]}], {int(zoom)});
    L.tileLayer('https://{{s}}.tile.openstreetmap.org/{{z}}/{{x}}/{{y}}.png', {{
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }}).addTo(map);

    const points = {payload};
    const bounds = [];

    for (const p of points) {{
      const ll = [p.lat, p.lon];
      bounds.push(ll);
      const m = L.circleMarker(ll, {{
        radius: 7,
        color: p.color || "#3388ff",
        weight: 2,
        fillColor: p.color || "#3388ff",
        fillOpacity: 0.85,
      }}).addTo(map);
      if (p.label) m.bindTooltip(p.label, {{ direction: "top", opacity: 0.9 }});
      if (p.popup_html) m.bindPopup(p.popup_html);
    }}

    if (bounds.length >= 2) {{
      map.fitBounds(bounds, {{ padding: [20, 20] }});
    }}
  </script>
</body>
</html>
"""
