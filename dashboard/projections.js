// Navigation/projection engine (unit-tested) loaded via /map_nav_engine.js
const NAV = (typeof window !== "undefined" && window.MobileAirNavEngine) ? window.MobileAirNavEngine : null;
const NAV_PROJ = (NAV && typeof NAV.createProjector === "function") ? NAV.createProjector({ tileSize: TILE_SIZE }) : null;
function clamp(n, lo, hi) {
  if (NAV && typeof NAV.clamp === "function") return NAV.clamp(n, lo, hi);
  return Math.max(lo, Math.min(hi, n));
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

function latLonToNorm(lat, lon) {
  // Zoom-independent normalized WebMercator coordinates.
  // u,v are in [0,1] for the global world.
  const u = ((Number(lon) + 180) / 360);
  const rad = (Number(lat) * Math.PI) / 180;
  const merc = Math.log(Math.tan(Math.PI / 4 + rad / 2));
  const v = (1 - merc / Math.PI) / 2;
  return { u, v };
}

function normToLatLon(u, v) {
  const uu = Number(u);
  const vv = Number(v);
  const lon = uu * 360 - 180;
  const y = vv; // 0..1
  const n = Math.PI - 2 * Math.PI * y;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lon };
}

function worldSizeForZoom(z) {
  // allow fractional zoom for smooth zooming
  if (NAV_PROJ) return NAV_PROJ.worldSizeForZoom(z);
  return TILE_SIZE * Math.pow(2, z);
}

function latLonToWorld(lat, lon, z) {
  if (NAV_PROJ) return NAV_PROJ.latLonToWorld(lat, lon, z);
  const ws = worldSizeForZoom(z);
  return { x: lonToX(lon, ws), y: latToY(lat, ws), ws };
}

function worldToLatLon(x, y, z) {
  if (NAV_PROJ) return NAV_PROJ.worldToLatLon(x, y, z);
  const ws = worldSizeForZoom(z);
  return { lat: yToLat(y, ws), lon: xToLon(x, ws) };
}
