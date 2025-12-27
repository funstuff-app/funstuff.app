(function (global) {
  "use strict";

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function createProjector({ tileSize = 256 } = {}) {
    const TILE_SIZE = tileSize;

    function worldSizeForZoom(z) {
      // allow fractional zoom
      return TILE_SIZE * Math.pow(2, z);
    }

    function lonToX(lon, worldSize) {
      return ((lon + 180) / 360) * worldSize;
    }

    function latToY(lat, worldSize) {
      const rad = (lat * Math.PI) / 180;
      const merc = Math.log(Math.tan(Math.PI / 4 + rad / 2));
      return (1 - merc / Math.PI) / 2 * worldSize;
    }

    function xToLon(x, worldSize) {
      return (x / worldSize) * 360 - 180;
    }

    function yToLat(y, worldSize) {
      const n = Math.PI - 2 * Math.PI * (y / worldSize);
      return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    }

    function latLonToWorld(lat, lon, z) {
      const ws = worldSizeForZoom(z);
      return { x: lonToX(lon, ws), y: latToY(lat, ws), ws };
    }

    function worldToLatLon(x, y, z) {
      const ws = worldSizeForZoom(z);
      return { lat: yToLat(y, ws), lon: xToLon(x, ws) };
    }

    return { TILE_SIZE, clamp, worldSizeForZoom, latLonToWorld, worldToLatLon };
  }

  function screenPointToLatLon({ center, zoom, sx, sy, viewport, projector }) {
    const proj = projector || createProjector();
    const w = viewport.w;
    const h = viewport.h;
    const c = proj.latLonToWorld(center.lat, center.lon, zoom);
    const wx = c.x - w / 2 + sx;
    const wy = c.y - h / 2 + sy;
    return proj.worldToLatLon(wx, wy, zoom);
  }

  function zoomAroundScreenPoint({ center, zoom, newZoom, sx, sy, viewport, projector }) {
    const proj = projector || createProjector();
    const w = viewport.w;
    const h = viewport.h;

    const before = screenPointToLatLon({ center, zoom, sx, sy, viewport, projector: proj });

    // Set new zoom; compute what center must be so that `before` stays under (sx,sy).
    const wpt = proj.latLonToWorld(before.lat, before.lon, newZoom);
    const cx = wpt.x - sx + w / 2;
    const cy = wpt.y - sy + h / 2;
    const llCenter = proj.worldToLatLon(cx, clamp(cy, 0, wpt.ws - 1), newZoom);
    return { center: { lat: llCenter.lat, lon: llCenter.lon }, zoom: newZoom };
  }

  function panCenterByPixels({ center, zoom, dx, dy, pixelToWorldScale = 0.65, projector }) {
    const proj = projector || createProjector();
    const c = proj.latLonToWorld(center.lat, center.lon, zoom);
    const nx = c.x + dx * pixelToWorldScale;
    const ny = clamp(c.y + dy * pixelToWorldScale, 0, c.ws - 1);
    const ll = proj.worldToLatLon(nx, ny, zoom);
    return { center: { lat: ll.lat, lon: ll.lon }, zoom };
  }

  function sampleAlongPoints(points, s01) {
    const pts = Array.isArray(points) ? points : [];
    if (pts.length < 2) return null;
    const s = clamp(Number(s01), 0, 1);
    const n = pts.length;
    const f = s * (n - 1);
    const i = Math.min(n - 2, Math.max(0, Math.floor(f)));
    const u = f - i;
    const a = pts[i];
    const b = pts[i + 1];
    const lat0 = Number(a.lat), lon0 = Number(a.lon);
    const lat1 = Number(b.lat), lon1 = Number(b.lon);
    if (!isFinite(lat0) || !isFinite(lon0) || !isFinite(lat1) || !isFinite(lon1)) return null;
    return {
      lat: lat0 + (lat1 - lat0) * u,
      lon: lon0 + (lon1 - lon0) * u,
      i,
      u,
      nextLat: lat1,
      nextLon: lon1,
    };
  }

  const api = {
    clamp,
    createProjector,
    screenPointToLatLon,
    zoomAroundScreenPoint,
    panCenterByPixels,
    sampleAlongPoints,
  };

  // Export for Node tests + attach to browser global.
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.MobileAirNavEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : window);


