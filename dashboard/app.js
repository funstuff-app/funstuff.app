/* MobileAir dashboard JS
 * - Fetches /api/state
 * - Renders a slippy-tile basemap on tilesCanvas
 * - Draws dotted breadcrumb trails + emoji vehicle markers on overlayCanvas
 *
 * No map library is used for overlay/projection; we do Web Mercator ourselves.
 */

const TILE_SIZE = 256;

// Basemap is fixed to CARTO Voyager.
const TILE_THEMES = {
  carto_voyager: {
    label: "CARTO Voyager",
    template: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
    subdomains: ["a", "b", "c", "d"],
    filter: { saturate: 0.55, brightness: 0.72, contrast: 1.12 },
    bgColor: "#c4c0b8",
  },
  carto_dark_all: {
    label: "CARTO Dark (all)",
    template: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
    subdomains: ["a", "b", "c", "d"],
    filter: { saturate: 1.45, brightness: 0.80, contrast: 1.08 },
    defaultDim: 70,
    bgColor: "#282828", // CARTO Dark Matter background
  },
  carto_dark_nolabels: {
    label: "CARTO Dark (no labels)",
    template: "https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png",
    subdomains: ["a", "b", "c", "d"],
    filter: { saturate: 0.90, brightness: 0.95, contrast: 1.06 },
    bgColor: "#282828",
  },
  carto_positron_all: {
    label: "CARTO Positron (all)",
    template: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
    subdomains: ["a", "b", "c", "d"],
    filter: { saturate: 0.45, brightness: 0.60, contrast: 1.10 },
    bgColor: "#a8a8a6",
  },
  carto_positron_nolabels: {
    label: "CARTO Positron (no labels)",
    template: "https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png",
    subdomains: ["a", "b", "c", "d"],
    filter: { saturate: 0.45, brightness: 0.60, contrast: 1.10 },
    bgColor: "#a8a8a6",
  },
  osm: {
    label: "OSM Standard",
    template: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    subdomains: [""],
    filter: { saturate: 0.45, brightness: 0.62, contrast: 1.12 },
    bgColor: "#b5b2ab",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Server Configuration (loaded from /api/config for CDN/scaling support)
// ─────────────────────────────────────────────────────────────────────────────
let appConfig = {
  dataMode: "proxy",     // "proxy" = fetch via server, "direct" = fetch from .edu/.gov directly
  apiBaseUrl: "/api",    // Base URL for API calls (allows CDN prefix override)
  cacheTtl: 30,          // Server-side cache TTL hint (seconds)
  version: "1.0.0",      // Server version for compatibility checks
};

/**
 * Load server configuration from /api/config endpoint.
 * Falls back to defaults if unavailable (e.g., offline, older server).
 */
async function loadConfig() {
  try {
    const res = await fetch("/api/config", { cache: "no-store" });
    if (res.ok) {
      const cfg = await res.json();
      // Merge with defaults (server may not provide all fields)
      appConfig = { ...appConfig, ...cfg };
      console.log("[Config] Loaded:", appConfig);
    }
  } catch (e) {
    console.warn("[Config] Using defaults, server config unavailable:", e.message);
  }
}

const THEME_STORAGE_KEY_DARK = "mobileair.mapTheme.dark";
const THEME_STORAGE_KEY_LIGHT = "mobileair.mapTheme.light";
const DIM_STORAGE_PREFIX = "mobileair.mapDim."; // per theme (0..100)
const SAT_STORAGE_PREFIX = "mobileair.mapSat."; // per theme (0..150 => saturate factor = v/100)
const VIEW_STORAGE_KEY = "mobileair.mapView"; // {lat, lon, zoom}
const TRACE_STORAGE_KEY = "mobileair.traceMode"; // "1" or "0"
const LIVE_MODE_STORAGE_KEY = "mobileair.liveFollow"; // "1" = LIVE follow mode
const MAX_TRAIL_LEN = 1000;

function applyMapFilterVars({ saturate, brightness, contrast, shadowLift }) {
  const root = document.documentElement;
  if (!root) return;
  if (typeof saturate === "number") root.style.setProperty("--map-saturate", String(saturate));
  if (typeof brightness === "number") root.style.setProperty("--map-brightness", String(brightness));
  if (typeof contrast === "number") root.style.setProperty("--map-contrast", String(contrast));
  if (typeof shadowLift === "number") root.style.setProperty("--map-shadow-lift", String(shadowLift));
}

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

function fmtTime(ts) {
  if (!ts) return "—";
  return String(ts).replace(" UTC", "");
}

function safeHex(c) {
  if (!c) return "#3388ff";
  let s = String(c).trim();
  if (s.startsWith("dim ")) s = s.slice(4).trim();
  if (s.startsWith("#") && (s.length === 7 || s.length === 4)) return s;
  return "#3388ff";
}

function dimHex(hex, amt = 0.6) {
  // Mix a hex color toward a neutral gray (like the TUI "dim" behavior) without transparency.
  const h = safeHex(hex);
  const m = /^#([0-9a-f]{6})$/i.exec(h);
  if (!m) return "#6b7280";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const tr = 0x6b, tg = 0x72, tb = 0x80; // slate-ish target
  const rr = Math.round(r * (1 - amt) + tr * amt);
  const gg = Math.round(g * (1 - amt) + tg * amt);
  const bb = Math.round(b * (1 - amt) + tb * amt);
  return `#${((1 << 24) + (rr << 16) + (gg << 8) + bb).toString(16).slice(1)}`;
}

function grayHex(hex) {
  // Convert a hex color to grayscale (preserves luminance).
  const h = safeHex(hex);
  const m = /^#([0-9a-f]{6})$/i.exec(h);
  if (!m) return "#6b7280";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const y = Math.max(0, Math.min(255, Math.round((0.2126 * r) + (0.7152 * g) + (0.0722 * b))));
  const s = y.toString(16).padStart(2, "0");
  return `#${s}${s}${s}`;
}

function desatHex(hex, amt = 0.25) {
  // Desaturate by mixing toward grayscale while keeping luminance roughly stable.
  const a = clamp(Number(amt), 0, 1);
  const h = safeHex(hex);
  const m = /^#([0-9a-f]{6})$/i.exec(h);
  if (!m) return "#6b7280";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const gh = grayHex(h);
  const gm = /^#([0-9a-f]{6})$/i.exec(gh);
  if (!gm) return h;
  const gn = parseInt(gm[1], 16);
  const gr = (gn >> 16) & 255;
  const gg = (gn >> 8) & 255;
  const gb = gn & 255;
  const rr = Math.round(r * (1 - a) + gr * a);
  const gg2 = Math.round(g * (1 - a) + gg * a);
  const bb = Math.round(b * (1 - a) + gb * a);
  return `#${((1 << 24) + (rr << 16) + (gg2 << 8) + bb).toString(16).slice(1)}`;
}

// AQI calculation (EPA breakpoints from aqi_breakpoints.csv)
// Notes:
// - Ozone breakpoints are in ppm; our feed values are typically in ppb (e.g. 28-40).
// - Truncation rules (EPA): ozone -> 3 decimals ppm, PM2.5 -> 1 decimal, PM10 -> integer.
const AQI_LEVELS = [
  { label: "Good", aqi_hi: 50, color: "#00E400" },
  { label: "Moderate", aqi_hi: 100, color: "#FFFF00" },
  { label: "USG", aqi_hi: 150, color: "#FF7E00" },
  { label: "Unhealthy", aqi_hi: 200, color: "#FF0000" },
  { label: "Very Unhealthy", aqi_hi: 300, color: "#8F3F97" },
  { label: "Hazardous", aqi_hi: 500, color: "#7E0023" },
];

const AQI_BREAKPOINTS = {
  "pm2.5": [
    { c_low: 0.0, c_high: 9.0, aqi_low: 0, aqi_high: 50 },
    { c_low: 9.1, c_high: 35.4, aqi_low: 51, aqi_high: 100 },
    { c_low: 35.5, c_high: 55.4, aqi_low: 101, aqi_high: 150 },
    { c_low: 55.5, c_high: 125.4, aqi_low: 151, aqi_high: 200 },
    { c_low: 125.5, c_high: 225.4, aqi_low: 201, aqi_high: 300 },
    { c_low: 225.5, c_high: 325.4, aqi_low: 301, aqi_high: 500 },
  ],
  pm10: [
    { c_low: 0.0, c_high: 54.0, aqi_low: 0, aqi_high: 50 },
    { c_low: 55.0, c_high: 154.0, aqi_low: 51, aqi_high: 100 },
    { c_low: 155.0, c_high: 254.0, aqi_low: 101, aqi_high: 150 },
    { c_low: 255.0, c_high: 354.0, aqi_low: 151, aqi_high: 200 },
    { c_low: 355.0, c_high: 424.0, aqi_low: 201, aqi_high: 300 },
    { c_low: 425.0, c_high: 604.0, aqi_low: 301, aqi_high: 500 },
  ],
  ozone: [
    { c_low: 0.0, c_high: 0.054, aqi_low: 0, aqi_high: 50 },
    { c_low: 0.055, c_high: 0.07, aqi_low: 51, aqi_high: 100 },
    { c_low: 0.071, c_high: 0.085, aqi_low: 101, aqi_high: 150 },
    { c_low: 0.086, c_high: 0.105, aqi_low: 151, aqi_high: 200 },
    { c_low: 0.106, c_high: 0.2, aqi_low: 201, aqi_high: 300 },
  ],
};

function _normalizePollutantKeyForAqi(k) {
  const kk = String(k || "").trim().toLowerCase();
  if (kk === "pm25" || kk === "pm2.5" || kk === "pm2_5" || kk === "pm2-5" || kk === "pm 2.5") return "pm2.5";
  if (kk === "pm10" || kk === "pm 10") return "pm10";
  if (kk === "ozne" || kk === "ozone" || kk === "o3") return "ozone";
  return kk;
}

function valueToAqi(pollutantKey, value) {
  const k = _normalizePollutantKeyForAqi(pollutantKey);
  let v = Number(value);
  if (!isFinite(v)) return null;

  // unit normalization + truncation
  if (k === "ozone") {
    // Feed values are always in ppb; convert to ppm for AQI lookup.
    // Negative values are invalid sensor readings.
    if (v <= 0) return null;
    v = v / 1000.0;
    v = Math.floor(v * 1000) / 1000; // 3 decimals
  } else if (k === "pm2.5") {
    v = Math.floor(v * 10) / 10; // 1 decimal
  } else if (k === "pm10") {
    v = Math.floor(v); // integer
  }

  const bps = AQI_BREAKPOINTS[k];
  if (!bps || !bps.length) return null;
  for (const bp of bps) {
    if (v >= bp.c_low && v <= bp.c_high) {
      if (bp.c_high === bp.c_low) return bp.aqi_high;
      return ((bp.aqi_high - bp.aqi_low) / (bp.c_high - bp.c_low)) * (v - bp.c_low) + bp.aqi_low;
    }
  }
  if (v < bps[0].c_low) return bps[0].aqi_low;
  if (v > bps[bps.length - 1].c_high) return bps[bps.length - 1].aqi_high;
  return null;
}

function aqiLevel(aqi) {
  const a = Number(aqi);
  if (!isFinite(a)) return { label: "Unknown", color: "#AAAAAA", aqi_hi: null };
  for (const lvl of AQI_LEVELS) {
    if (a <= lvl.aqi_hi) return lvl;
  }
  return AQI_LEVELS[AQI_LEVELS.length - 1];
}

function pickWorstReadingKey(readings) {
  if (!readings) return null;
  let bestKey = null;
  let bestAqi = -1;
  for (const [k, r] of Object.entries(readings)) {
    const v = r && typeof r === "object" ? r.value : null;
    const aqi = valueToAqi(k, v);
    const aqiF = (aqi == null) ? -1 : Number(aqi);
    if (isFinite(aqiF) && aqiF > bestAqi) {
      bestAqi = aqiF;
      bestKey = k;
    }
  }
  if (bestKey) return { key: bestKey, aqi: bestAqi };

  // fallback (unknown AQI): stable ordering
  const order = ["PM25", "PM2.5", "PM10", "OZNE", "Ozone"];
  for (const k of order) if (readings[k]) return { key: k, aqi: null };
  const keys = Object.keys(readings);
  return keys.length ? { key: keys[0], aqi: null } : null;
}

function canonicalPollutantLabel(k) {
  const kk = _normalizePollutantKeyForAqi(k);
  if (kk === "pm2.5") return "PM2.5";
  if (kk === "pm10") return "PM10";
  if (kk === "ozone") return "Ozone";
  return String(k || "");
}

function sparklineSvg(values, stroke, width = 140, height = 26) {
  const arr = Array.isArray(values) ? values.filter(v => typeof v === "number" && isFinite(v)) : [];
  if (arr.length < 2) {
    return `<svg class="spark" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true"></svg>`;
  }
  const w = width;
  const h = height;
  // AQI is 0..500
  const clampAqi = (v) => clamp(v, 0, 500);
  const n = arr.length;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const x = (n === 1) ? 0 : (i / (n - 1)) * (w - 2) + 1;
    const y = h - 1 - (clampAqi(arr[i]) / 500) * (h - 2);
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  const col = safeHex(stroke);
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">` +
    `<polyline fill="none" stroke="${col}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="${pts.join(" ")}" />` +
    `</svg>`;
}

function parseUtcMs(t) {
  if (!t) return null;
  const s0 = String(t).trim();
  if (!s0) return null;

  // Prefer a strict parser for common non-ISO formats (notably Safari can reject them).
  // Supports:
  // - "YYYY-MM-DD HH:MM:SS UTC"
  // - "YYYY-MM-DDTHH:MM:SSZ" (and with optional milliseconds)
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})[ T]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,3}))?(?:\s*(Z|UTC))?$/i.exec(s0);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const hour = Number(m[4]);
    const minute = Number(m[5]);
    const sec = Number(m[6]);
    const msPart = m[7] ? Number(String(m[7]).padEnd(3, "0")) : 0;
    if ([year, month, day, hour, minute, sec, msPart].every(n => isFinite(n))) {
      const ms = Date.UTC(year, month - 1, day, hour, minute, sec, msPart);
      return isFinite(ms) ? ms : null;
    }
  }

  // Fallback: try Date.parse with normalization.
  // "YYYY-MM-DD HH:MM:SS UTC" -> "YYYY-MM-DDTHH:MM:SSZ"
  const s1 = s0.replace(/\s+UTC$/i, "Z").replace(" ", "T");
  let ms = Date.parse(s1);
  if (!isFinite(ms)) ms = Date.parse(s0);
  return isFinite(ms) ? ms : null;
}

function formatTagValue(v) {
  if (v == null) return "";
  if (typeof v === "number" && isFinite(v)) {
    // Show 1 decimal place for values < 10, integers for larger values
    if (v < 10) return v.toFixed(1);
    return String(Math.round(v));
  }
  const s = String(v).trim();
  if (!s) return "";
  const n = Number(s);
  if (isFinite(n)) {
    if (n < 10) return n.toFixed(1);
    return String(Math.round(n));
  }
  return s;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  // Great-circle distance (meters)
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dp = toRad(lat2 - lat1);
  const dl = toRad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * (Math.sin(dl / 2) ** 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function keyFor(type, id) {
  return `${type}:${id}`;
}

function parseKey(key) {
  if (!key) return null;
  const s = String(key);
  const i = s.indexOf(":");
  if (i === -1) return { type: "mobile", id: s };
  return { type: s.slice(0, i), id: s.slice(i + 1) };
}

function primaryReadingFromPoint(p) {
  const readings = p && p.readings ? p.readings : null;
  if (!readings) return null;
  const w = pickWorstReadingKey(readings);
  return w && w.key && readings[w.key] ? readings[w.key] : null;
}

function primaryReadingKeyedFromPoint(p) {
  const readings = p && p.readings ? p.readings : null;
  if (!readings) return null;
  const w = pickWorstReadingKey(readings);
  if (!w || !w.key || !readings[w.key]) return null;
  const r = readings[w.key];
  return { key: w.key, value: r?.value, color: safeHex(r?.color), aqi: w.aqi };
}

function primaryReadingForSensor(s) {
  const readings = s && s.readings ? s.readings : null;
  if (!readings) return { key: null, value: null, color: "#ffffff" };
  const w = pickWorstReadingKey(readings);
  if (w && w.key && readings[w.key]) {
    // Always trust the actual readings (same source used for trail coloring & details panel).
    // Server primary_key can be stale/mismatched vs readings and causes “ozone wins” labels.
    return { key: w.key, value: readings[w.key].value, color: safeHex(readings[w.key].color), aqi: w.aqi };
  }

  // Fallback: if AQI couldn't be computed, use server hint if present.
  if (s && s.primary_key != null) {
    return { key: s.primary_key, value: s.primary_value, color: safeHex(s.primary_color) };
  }
  return { key: null, value: null, color: "#ffffff" };
}

/**
 * Check if a fixed sensor has time-indexed history data (from AirNow).
 * @param {object} f - fixed sensor object
 * @returns {boolean}
 */
function fixedSensorHasHistoryTimes(f) {
  const readings = f && f.readings;
  if (!readings) return false;
  for (const key of Object.keys(readings)) {
    const r = readings[key];
    if (r && Array.isArray(r.history_times) && r.history_times.length >= 2) {
      return true;
    }
  }
  return false;
}

/**
 * Interpolate fixed sensor readings at a given playback time.
 * Uses history_times arrays to find the appropriate value for each pollutant.
 * 
 * @param {object} f - fixed sensor object with readings that have history_times
 * @param {number} playbackTimeMs - playback time in UTC milliseconds
 * @returns {object} - interpolated readings object in same format as original
 */
function interpolateFixedReadingsAtTime(f, playbackTimeMs) {
  const readings = f && f.readings;
  if (!readings || !isFinite(playbackTimeMs)) return readings;
  
  const result = {};
  
  for (const key of Object.keys(readings)) {
    const r = readings[key];
    if (!r) continue;
    
    // If no history_times, just copy the current value
    if (!Array.isArray(r.history_times) || !Array.isArray(r.history) || r.history_times.length < 2) {
      result[key] = r;
      continue;
    }
    
    const times = r.history_times;
    const values = r.history;
    const colors = r.history_colors || [];

    // Some feeds include null/invalid times (and sometimes null values) as padding.
    // Those break monotonic ordering and make binary search return wrong indices
    // (often yielding a null value), which makes fixed-marker labels show key-only.
    // Build a filtered, monotonic timeline for indexing, but keep original arrays
    // for sparklines.
    const timesMs = [];
    const valuesF = [];
    const colorsF = [];
    const n = Math.min(times.length, values.length);
    for (let i = 0; i < n; i++) {
      const tMs = parseUtcMs(times[i]);
      if (!(tMs != null && isFinite(tMs))) continue;
      const v = values[i];
      if (v == null) continue;
      timesMs.push(tMs);
      valuesF.push(v);
      colorsF.push(colors[i] || r.color || "#cccccc");
    }
    if (timesMs.length < 1) {
      result[key] = r;
      continue;
    }

    // Find the appropriate value for this time (timeline is monotonic)
    const tMin = timesMs[0];
    const tMax = timesMs[timesMs.length - 1];
    
    let idx;
    if (playbackTimeMs <= tMin) {
      idx = 0;
    } else if (playbackTimeMs >= tMax) {
      idx = valuesF.length - 1;
    } else {
      // Binary search for the right interval
      let lo = 0;
      let hi = timesMs.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (timesMs[mid] <= playbackTimeMs) lo = mid;
        else hi = mid - 1;
      }
      idx = lo;
    }
    
    result[key] = {
      value: valuesF[idx],
      color: colorsF[idx] || r.color || "#cccccc",
      // Keep original arrays for sparklines
      history: values,
      history_times: times,
      history_colors: colors,
      scrubbed: r.scrubbed || 0,
    };
  }
  
  return result;
}

/**
 * Get primary reading for a fixed sensor at a specific playback time.
 * Falls back to primaryReadingForSensor if no history_times.
 * 
 * @param {object} f - fixed sensor object
 * @param {number|null} playbackTimeMs - playback time in UTC ms, or null for current
 * @returns {object} - { key, value, color, aqi }
 */
function primaryReadingForFixedAtTime(f, playbackTimeMs) {
  if (playbackTimeMs == null || !fixedSensorHasHistoryTimes(f)) {
    return primaryReadingForSensor(f);
  }
  
  const interpolated = interpolateFixedReadingsAtTime(f, playbackTimeMs);
  const w = pickWorstReadingKey(interpolated);
  if (w && w.key && interpolated[w.key]) {
    return { key: w.key, value: interpolated[w.key].value, color: safeHex(interpolated[w.key].color), aqi: w.aqi };
  }
  return primaryReadingForSensor(f);
}

class MapView {
  constructor(tilesCanvas, overlayCanvas) {
    this.tilesCanvas = tilesCanvas;
    this.overlayCanvas = overlayCanvas;
    // Use willReadFrequently: false (default) to hint GPU-accelerated rendering.
    // This is especially important for iPad/iOS performance.
    this.tctx = tilesCanvas.getContext("2d", { willReadFrequently: false });
    this.octx = overlayCanvas.getContext("2d", { willReadFrequently: false });

    // fractional zoom for smooth pinch / button zooming
    this.zoom = 12;
    this._zoomMin = 3;
    this._zoomMax = 18;
    this._pinchAnchor = null; // { lat, lon, sx, sy, lastTs }
    // Prefer native macOS Safari pinch gesture events when available.
    this._gesture = null; // { startZoom, startScale, anchorLat, anchorLon, sx, sy }
    // Mouse drag pan (optional). Does not affect trackpad controls.
    this._mouseDragging = false;
    this._mouseDragStart = null; // {x,y}
    this._mouseDragCenterStart = null; // {x,y,ws}
    this._mouseDragMoved = false;
    this.center = { lat: 40.7608, lon: -111.8910 };
    // macOS trackpad UX: two-finger pan + pinch zoom (avoid mouse-drag schema)
    this._centerAnimRAF = null;

    // Auto-camera follow must never override user interaction.
    // Suppress live-follow/forced-fit animations during interaction + short cooldown.
    this._autoCameraSuppressedUntilPerfMs = 0;
    this._autoCameraCooldownMs = 1400;
    this._lastAutoFitSig = "";
    this._autoFitInFlightSig = "";
    this._pendingForcedFit = null; // { bounds, durationMs }
    this.selectedId = null;
    // Marker visibility toggles
    this.showFixed = true;
    this.showMobile = true;
    // Label visibility is per-sensor-type (mobile vs fixed)
    this.showMobileLabels = true;
    this.showFixedLabels = true;
    // Trace mode: animate the emoji along its own breadcrumb trail.
    this.traceMode = false;
    this._traceRAF = null;
    this._traceLastFrameTs = 0;
    this._traceTargetFPS = 30; // reduce CPU while staying smooth

    // Cached viewport metrics to avoid per-frame layout reads (getBoundingClientRect is expensive).
    this._dpr = window.devicePixelRatio || 1;
    this._cssW = 1;
    this._cssH = 1;

    // Trace-mode optimization: cache static overlay (trails + fixed markers).
    this._overlayStaticCanvas = null; // offscreen canvas in device pixels
    this._overlayStaticKey = "";
    this._overlayStaticDirty = true;

    // Playback-mode optimization: cache trails to offscreen canvas.
    // Trails only need redrawing when view changes or playback time advances significantly.
    this._trailCacheCanvas = null;
    this._trailCacheKey = "";
    this._trailCacheTimeMs = null;

    // Trace-mode optimization: cache cleaned point lists per mobile id for sampling.
    this._tracePtsById = new Map(); // id -> [{lat,lon}, ...]
    this._tracePtsKey = "";
    this._traceLastSideById = new Map(); // id -> "L" | "R"

    // Trace-route buffering: keep active route stable for the whole loop.
    this._traceActiveRouteById = new Map(); // id -> route
    this._tracePendingRouteById = new Map(); // id -> route
    this._traceCycleStartMsById = new Map(); // id -> cycleStartMs (performance.now timeline)
    this._traceInitialRunDoneById = new Map(); // id -> boolean

    // Rotation smoothing to prevent snapping when direction changes.
    this._traceAngleById = new Map(); // id -> filtered angle
    this._traceAngleLastMsById = new Map(); // id -> last nowMs

    // DVR playback: sample all vehicles against a shared global time.
    this.playbackMode = false;
    this._playbackPlaying = false;
    this._playbackSpeed = 1.0;
    this._playbackNowMs = null; // UTC epoch ms
    this._playbackMinMs = null;
    this._playbackMaxMs = null;
    this._playbackPtsById = new Map(); // id -> [{lat,lon,tMs}, ...]
    this._playbackPtsKey = "";
    this._physicsStateById = new Map(); // id -> {u, v, segIdx, lastPerfMs}
    // LIVE follow-tail: when true, keep playhead pinned to end-of-data (maxMs).
    // This is the default "LIVE" experience (no rewinds).
    this._playbackLiveFollow = true;
    // Track whether initial playback position has been set (to apply 10-min offset once)
    this._playbackInitialized = false;

    // Foveated road matching: progressively match segments during playback
    this._roadMatchedRangesById = new Map(); // id -> [{fromMs, toMs}] - already matched ranges
    this._roadMatchPending = new Set(); // sensor IDs currently being fetched
    this._roadMatchLastRequestMs = 0; // throttle requests

    // Data-time clock (UTC epoch ms) anchored to incoming trail timestamps.
    // This avoids using wall-clock Date.now() directly for decay timing.
    this._dataNowBaseMs = null; // UTC epoch ms
    this._dataNowBasePerfMs = null; // performance.now() at base capture

    // "Newest segment" replay:
    // When new data extends the global max timestamp, we record the previous max as the
    // start of the newest segment. Clicking Play seeks there and plays forward.
    this._playbackNewestSegmentStartMs = null;
    this._playbackLastMaxMs = null;

    // DVR drag-scrub: click-drag a vehicle along its path to scrub the global playhead.
    this._pbDrag = null; // { id, startedAtMs, lastClient:{x,y}, cursorClient:{x,y}, lastMoveMs, vel:{x,y}, wasPlaying }
    // DVR inertial glide: after releasing a dragged marker, keep a short 2D inertia cursor
    // and scrub the global playhead from it. Only the last-interacted marker uses this.
    this._pbInertia2d = null; // { id, t0Ms, lastMs, posClient:{x,y}, vel:{x,y} }
    this._pbDebugPath = false;
    this._pbDebugRawGps = true; // Show raw GPS path in debug mode (orange)
    this._pbDebugRoadLines = true; // Show road graph lines in debug mode (blue)
    // Vehicle actual path buffer: records the dynamically computed positions (phys.lat/lon)
    // This is the ACTUAL path the vehicle takes, which differs based on speed/steering
    this._vehicleActualPathById = new Map(); // id -> [{lat, lon, d}]
    // Raw GPS storage: original GPS coordinates before road snapping
    this._rawGpsById = new Map(); // id -> [{lat, lon, t, ...}]
    // Road graph edges cache (for debug visualization)
    this._roadGraphEdges = null; // [{lat1, lon1, lat2, lon2}, ...] or null
    // Tram line graph edges cache (for debug visualization)
    this._tramLineEdges = null; // [{lat1, lon1, lat2, lon2, elev1?, elev2?}, ...] or null
    this._tramLineHasElevation = false; // Whether elevation data is available

    // Selection orchestration (polished camera + trace sync).
    this._selectOrchRAF = null;
    this._selectOrch = null; // { id, t0Ms, homeLat, homeLon, camTo:{lat,lon}, camFrom:{lat,lon}, camDelayMs, camDurMs, warpDurMs }
    this._traceSelectionWarpById = new Map(); // id -> { t0Ms, fromLat, fromLon, homeLat, homeLon, fadeMs, durationMs }

    // Trace playback tuning (kept as fields so you can tweak later).
    // - We still base movement on GPS timestamps/distances, but we normalize to a
    //   human-watchable speed (otherwise real-world sparse updates look like crawling).
    this._traceTargetMedianSpeedMps = 7.0; // ~15.7 mph (playback median)
    this._traceMaxSpeedMps = 18.0; // ~40 mph (playback cap)
    this._traceRealMaxSpeedMps = 20.0; // ~45 mph (badge cap; filters GPS jumps)
    this._traceSpeedSmoothingTauS = 1.6; // smaller = snappier accel/brake
    this._traceStopSpeedMps = 0.25; // below this, treat as stop/dwell
    this._traceStopMinMs = 350;
    this._traceStopMaxMs = 3500;
    this._traceDwellTimeCompression = 12.0; // higher = shorter dwells

    // Persist trails on-screen across server history dropouts.
    // This is *not* a short tail cache or a faded fallback; it is the last known full
    // breadcrumb trail held in-memory until the page reloads.
    this._persistedTrailById = new Map(); // id -> { trail: [...], color?, ghosted? }
    this._persistedTrailRev = 0;
    this.maxTrailLen = 1000;

    // Basemap tile cache (LRU bounded). Without eviction this grows unbounded as you pan/zoom.
    // Lower limit on mobile/tablet for memory constraints; detect via coarse heuristic.
    this.tileCache = new Map(); // key -> {img, ok}
    const isMobileDevice = /iPad|iPhone|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1);
    this._tileCacheMax = isMobileDevice ? 180 : 420;

    // Touch pan/pinch state (iPad, iOS, Android)
    this._touchState = null; // null or { startTouches, startCenter, startZoom, startCenterLatLon, lastPinchDist, lastMidpoint }
    this._touchActive = false; // true while any touch is in progress (for skipping expensive ops)

    // Debounce tile-load redraws to avoid cascading redraws when multiple tiles load at once
    this._tileLoadRedrawTimer = null;
    // Snapshot of the last rendered basemap frame to avoid flicker while tiles load.
    this._tilesSnapshotCanvas = null; // offscreen canvas
    this._tilesSnapshotMeta = null; // { zoom, centerLat, centerLon }

    // Theme
    this.themeKey = "carto_voyager";
    const t = TILE_THEMES[this.themeKey];
    this.tileTemplate = t.template;
    this.tileSubdomains = t.subdomains;
    this._tileEpoch = 1; // increments on theme swap; used to ignore late tile loads

    // Coalesce pinch-zoom redraws to rAF for smoother feel (no extra easing math).
    this._zoomDrawRAF = null;

    // Coalesce pan redraws to rAF (Safari trackpad wheel-pan can be very high frequency).
    this._panDrawRAF = null;

    // Minimal pinch-zoom inertia (only for trackpad pinch streams; does not affect pan).
    this._pinchInertiaRAF = null;
    this._pinchVz = 0; // zoom units per ms
    this._pinchVelTs = 0;
    this._pinchAnchorSX = null;
    this._pinchAnchorSY = null;
    this._wheelPinchEndTimer = null;
    this._pinchZooming = false;

    window.addEventListener("resize", () => this.resize());
    
    this.overlayCanvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    // Safari (macOS) provides native trackpad pinch as gesture events.
    this.overlayCanvas.addEventListener("gesturestart", (e) => this.onGestureStart(e), { passive: false });
    this.overlayCanvas.addEventListener("gesturechange", (e) => this.onGestureChange(e), { passive: false });
    this.overlayCanvas.addEventListener("gestureend", (e) => this.onGestureEnd(e), { passive: false });
    this.overlayCanvas.addEventListener("click", (e) => this.onClick(e));
    this.overlayCanvas.addEventListener("mousedown", (e) => this.onMouseDown(e));
    window.addEventListener("mousemove", (e) => this.onMouseMove(e));
    window.addEventListener("mouseup", () => this.onMouseUp());
    // Touch events for iPad/iOS/Android pan and pinch-zoom
    this.overlayCanvas.addEventListener("touchstart", (e) => this.onTouchStart(e), { passive: false });
    this.overlayCanvas.addEventListener("touchmove", (e) => this.onTouchMove(e), { passive: false });
    this.overlayCanvas.addEventListener("touchend", (e) => this.onTouchEnd(e), { passive: false });
    this.overlayCanvas.addEventListener("touchcancel", (e) => this.onTouchEnd(e), { passive: false });

    this.resize();
  }

  _cancelCameraAnimations() {
    if (this._centerAnimRAF) cancelAnimationFrame(this._centerAnimRAF);
    this._centerAnimRAF = null;
  }

  _suppressAutoCamera({ cooldownMs } = {}) {
    const cd = (typeof cooldownMs === "number" && isFinite(cooldownMs)) ? cooldownMs : this._autoCameraCooldownMs;
    const until = performance.now() + Math.max(0, cd);
    if (!(until <= this._autoCameraSuppressedUntilPerfMs)) {
      this._autoCameraSuppressedUntilPerfMs = until;
    }
  }

  _noteUserInteraction() {
    // User input wins: cancel in-flight camera animations and suppress new auto-fits.
    this._cancelCameraAnimations();
    this._suppressAutoCamera();
  }

  _canRunAutoCamera() {
    const now = performance.now();
    if (this._touchActive || this._mouseDragging || this._pinchZooming) return false;
    return now >= (this._autoCameraSuppressedUntilPerfMs || 0);
  }

  _dataNowMs() {
    const baseMs = this._dataNowBaseMs;
    const basePerf = this._dataNowBasePerfMs;
    if (baseMs != null && isFinite(baseMs) && basePerf != null && isFinite(basePerf)) {
      return Number(baseMs) + Math.max(0, performance.now() - Number(basePerf));
    }
    return Date.now();
  }

  _invalidateOverlayStatic() {
    this._overlayStaticDirty = true;
    this._overlayUnderlayKey = "";
  }

  setMaxTrailLen(val) {
    const n = Number(val);
    if (!isFinite(n) || n < 2) return;
    if (this.maxTrailLen === n) return;
    this.maxTrailLen = n;

    // Prune existing trails immediately
    let changed = false;
    for (const [id, data] of this._persistedTrailById.entries()) {
      if (data.trail.length > n) {
        data.trail = data.trail.slice(-n);
        changed = true;
      }
    }
    if (changed) {
      this._persistedTrailRev++;
      this._invalidateOverlayStatic();
    }
  }

  _stopPinchInertia() {
    if (this._pinchInertiaRAF) cancelAnimationFrame(this._pinchInertiaRAF);
    this._pinchInertiaRAF = null;
    this._wheelPinchEndTimer = null;
    this._pinchVz = 0;
    this._pinchVelTs = 0;
  }

  _notePinchVelocity(dz, now) {
    const t = (typeof now === "number" && isFinite(now)) ? now : performance.now();
    const dt = (this._pinchVelTs > 0) ? (t - this._pinchVelTs) : 0;
    if (dt > 4 && dt < 120) {
      // Simple EMA-ish blend; keep it tiny and stable.
      const v = dz / dt;
      this._pinchVz = (this._pinchVz * 0.65) + (v * 0.35);
    }
    this._pinchVelTs = t;
  }

  _startPinchInertia() {
    // Only continue if we have meaningful velocity and an anchor.
    if (!isFinite(this._pinchVz) || Math.abs(this._pinchVz) < 0.00005 || !isFinite(this._pinchAnchorSX) || !isFinite(this._pinchAnchorSY)) {
      // No coast; end pinch mode and force a "real tiles" redraw.
      this._pinchZooming = false;
      this._requestZoomRedraw();
      return;
    }

    let last = performance.now();
    const step = () => {
      const now = performance.now();
      const dt = now - last;
      last = now;

      // Apply velocity, then decay it quickly (feels like native trackpad momentum).
      const z2 = clamp(this.zoom + this._pinchVz * dt, this._zoomMin, this._zoomMax);
      this._setZoomAroundScreenPoint(z2, this._pinchAnchorSX, this._pinchAnchorSY);
      this._tilesSnapshotCanvas = null;
      this._tilesSnapshotMeta = null;
      this._requestZoomRedraw();
      this._notifyViewChanged();

      this._pinchVz *= 0.90; // fast decay; keep minimal math
      if (Math.abs(this._pinchVz) < 0.00005 || z2 === this._zoomMin || z2 === this._zoomMax) {
        this._pinchInertiaRAF = null;
        this._pinchZooming = false;
        this._requestZoomRedraw(); // redraw with real tiles at final zoom
        return;
      }
      this._pinchInertiaRAF = requestAnimationFrame(step);
    };
    // Kick the first step immediately to avoid a perceptible "stutter" before inertia begins.
    last = performance.now() - 16;
    step();
  }

  _requestZoomRedraw() {
    if (this._zoomDrawRAF) return;
    this._zoomDrawRAF = requestAnimationFrame(() => {
      this._zoomDrawRAF = null;
      this.draw(this.lastState);
    });
  }

  _redrawViewOnly() {
    // Redraw basemap + overlay for view changes (center/zoom/theme/size) without
    // reprocessing state-derived caches. Used to throttle high-frequency pan events.
    const state = this.lastState;
    if (!state) return;

    // FAST PATH: During active touch, just translate/scale cached canvases instead of redrawing.
    // This avoids expensive path operations on every 120Hz touch event.
    if (this._touchActive && this._panSnapshotOverlay && this._panSnapshotTiles && this._panSnapshotCenter) {
      const dpr = this._dpr || 1;
      const w = this._cssW || 1;
      const h = this._cssH || 1;
      
      // Compute scale factor if zoom changed (pinch-zoom)
      const sZoom = Math.pow(2, this.zoom - this._panSnapshotZoom);
      
      // Compute pixel offset from snapshot center to current center (at snapshot zoom level)
      const prevC = latLonToWorld(this._panSnapshotCenter.lat, this._panSnapshotCenter.lon, this._panSnapshotZoom);
      const currC = latLonToWorld(this.center.lat, this.center.lon, this._panSnapshotZoom);
      const txPan = (prevC.x - currC.x) * sZoom;
      const tyPan = (prevC.y - currC.y) * sZoom;
      
      // Tiles: translate + scale snapshot
      if (this.tctx) {
        this.tctx.save();
        this.tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.tctx.clearRect(0, 0, w, h);
        this.tctx.translate(w / 2, h / 2);
        this.tctx.scale(sZoom, sZoom);
        this.tctx.translate(-w / 2 + txPan / sZoom, -h / 2 + tyPan / sZoom);
        this.tctx.drawImage(this._panSnapshotTiles, 0, 0, w, h);
        this.tctx.restore();
      }
      
      // Overlay: translate + scale snapshot  
      if (this.octx) {
        this.octx.save();
        this.octx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.octx.clearRect(0, 0, w, h);
        this.octx.translate(w / 2, h / 2);
        this.octx.scale(sZoom, sZoom);
        this.octx.translate(-w / 2 + txPan / sZoom, -h / 2 + tyPan / sZoom);
        this.octx.drawImage(this._panSnapshotOverlay, 0, 0, w, h);
        this.octx.restore();
      }
      return;
    }

    const viewSig = (() => {
      const z = Number(this.zoom);
      const lat = Number(this.center?.lat);
      const lon = Number(this.center?.lon);
      const w = Number(this._cssW);
      const h = Number(this._cssH);
      const dpr = Number(this._dpr || (window.devicePixelRatio || 1));
      const r = (x, p = 1e6) => (isFinite(x) ? (Math.round(x * p) / p) : x);
      return `${this.themeKey}|${r(z, 1e3)}|${r(lat)}|${r(lon)}|${w}x${h}|dpr:${r(dpr, 1e3)}|pinch:${this._pinchZooming ? 1 : 0}`;
    })();

    if (this._lastTilesViewSig !== viewSig) {
      this._lastTilesViewSig = viewSig;
      this.drawTiles();
    }
    this.drawOverlay(state, { cacheUnderlay: true });
  }

  _requestPanRedraw() {
    if (this._panDrawRAF) return;
    this._panDrawRAF = requestAnimationFrame(() => {
      this._panDrawRAF = null;
      this._redrawViewOnly();
      this._notifyViewChanged();
    });
  }

  _notifyViewChanged() {
    try {
      if (typeof window.__onMapViewChanged === "function") window.__onMapViewChanged();
    } catch {
      // ignore
    }
  }

  _eventToLocalXY(e) {
    const rect = this.overlayCanvas.getBoundingClientRect();
    const cx = (typeof e.clientX === "number") ? e.clientX : (rect.left + rect.width / 2);
    const cy = (typeof e.clientY === "number") ? e.clientY : (rect.top + rect.height / 2);
    return { sx: cx - rect.left, sy: cy - rect.top };
  }

  onGestureStart(e) {
    // Safari-only; prevent page zoom and handle pinch natively.
    e.preventDefault();
    e.stopPropagation();
    this._noteUserInteraction();
    this._stopPinchInertia();
    this._pinchZooming = true;
    const { sx, sy } = this._eventToLocalXY(e);
    const ll = this._screenPointToLatLon(sx, sy);
    this._gesture = {
      startZoom: this.zoom,
      startScale: (typeof e.scale === "number" && isFinite(e.scale) && e.scale > 0) ? e.scale : 1,
      anchorLat: ll.lat,
      anchorLon: ll.lon,
      sx,
      sy,
    };
    this._pinchAnchorSX = sx;
    this._pinchAnchorSY = sy;
  }

  onGestureChange(e) {
    if (!this._gesture) return;
    e.preventDefault();
    e.stopPropagation();
    this._noteUserInteraction();
    this._pinchZooming = true;
    const { sx, sy } = this._eventToLocalXY(e);
    // Update anchor screen point as the gesture midpoint moves.
    this._gesture.sx = sx;
    this._gesture.sy = sy;

    const scale = (typeof e.scale === "number" && isFinite(e.scale) && e.scale > 0) ? e.scale : 1;
    const ratio = Math.max(0.2, Math.min(5, scale / (this._gesture.startScale || 1)));
    const dz = Math.log2(ratio);
    const z2 = clamp(this._gesture.startZoom + dz, this._zoomMin, this._zoomMax);
    const prevZ = this.zoom;
    this._setZoomAroundScreenPoint(z2, sx, sy);
    this._requestZoomRedraw();
    this._notifyViewChanged();
    this._pinchAnchorSX = sx;
    this._pinchAnchorSY = sy;
    this._notePinchVelocity(z2 - prevZ, performance.now());
  }

  onGestureEnd(e) {
    if (!this._gesture) return;
    e.preventDefault();
    e.stopPropagation();
    this._gesture = null;
    this._startPinchInertia();
  }

  // Touch event handlers for iPad/iOS/Android pan and pinch-zoom
  onTouchStart(e) {
    // Prevent browser's default behavior (page scroll, zoom)
    e.preventDefault();
    
    // Mark touch as active to skip expensive operations during interaction
    this._touchActive = true;

    this._noteUserInteraction();
    
    // Cancel any in-progress pinch inertia
    this._stopPinchInertia();
    
    const touches = e.touches;
    if (touches.length === 0) return;

    const rect = this.overlayCanvas.getBoundingClientRect();
    
    // Compute touch midpoint in canvas-local coordinates
    let sumX = 0, sumY = 0;
    for (let i = 0; i < touches.length; i++) {
      sumX += touches[i].clientX - rect.left;
      sumY += touches[i].clientY - rect.top;
    }
    const midX = sumX / touches.length;
    const midY = sumY / touches.length;

    // For pinch: compute initial distance
    let pinchDist = 0;
    if (touches.length >= 2) {
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      pinchDist = Math.sqrt(dx * dx + dy * dy);
      this._pinchZooming = true;
    }

    // Store initial touch state
    const cw = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
    this._touchState = {
      startTouches: touches.length,
      startMidpoint: { x: midX, y: midY },
      startCenterWorld: { x: cw.x, y: cw.y, ws: cw.ws },
      startZoom: this.zoom,
      lastPinchDist: pinchDist,
      lastMidpoint: { x: midX, y: midY },
    };
    
    // Store anchor for inertia
    this._pinchAnchorSX = midX;
    this._pinchAnchorSY = midY;
    
    // Capture pan snapshots for fast-path translation during touch
    // This avoids expensive redraw operations on every touch move
    this._capturePanSnapshots();
  }
  
  _capturePanSnapshots() {
    const dpr = this._dpr || 1;
    const w = this._cssW || 1;
    const h = this._cssH || 1;
    const pw = Math.floor(w * dpr);
    const ph = Math.floor(h * dpr);
    
    // Capture current center and zoom for offset/scale calculation
    this._panSnapshotCenter = { lat: this.center.lat, lon: this.center.lon };
    this._panSnapshotZoom = this.zoom;
    
    // Snapshot tiles canvas
    if (!this._panSnapshotTiles || this._panSnapshotTiles.width !== pw || this._panSnapshotTiles.height !== ph) {
      this._panSnapshotTiles = document.createElement("canvas");
      this._panSnapshotTiles.width = pw;
      this._panSnapshotTiles.height = ph;
    }
    const tCtx = this._panSnapshotTiles.getContext("2d");
    if (tCtx && this.tilesCanvas) {
      tCtx.clearRect(0, 0, pw, ph);
      tCtx.drawImage(this.tilesCanvas, 0, 0);
    }
    
    // Snapshot overlay canvas
    if (!this._panSnapshotOverlay || this._panSnapshotOverlay.width !== pw || this._panSnapshotOverlay.height !== ph) {
      this._panSnapshotOverlay = document.createElement("canvas");
      this._panSnapshotOverlay.width = pw;
      this._panSnapshotOverlay.height = ph;
    }
    const oCtx = this._panSnapshotOverlay.getContext("2d");
    if (oCtx && this.overlayCanvas) {
      oCtx.clearRect(0, 0, pw, ph);
      oCtx.drawImage(this.overlayCanvas, 0, 0);
    }
  }

  onTouchMove(e) {
    if (!this._touchState) return;
    e.preventDefault();

    this._noteUserInteraction();

    const touches = e.touches;
    if (touches.length === 0) return;

    const rect = this.overlayCanvas.getBoundingClientRect();

    // Compute current touch midpoint
    let sumX = 0, sumY = 0;
    for (let i = 0; i < touches.length; i++) {
      sumX += touches[i].clientX - rect.left;
      sumY += touches[i].clientY - rect.top;
    }
    const midX = sumX / touches.length;
    const midY = sumY / touches.length;

    // Pinch-zoom if 2+ fingers
    if (touches.length >= 2) {
      this._pinchZooming = true;
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      const pinchDist = Math.sqrt(dx * dx + dy * dy);

      if (this._touchState.lastPinchDist > 0 && pinchDist > 0) {
        const scale = pinchDist / this._touchState.lastPinchDist;
        const dz = Math.log2(scale);
        const prevZ = this.zoom;
        const z2 = clamp(this.zoom + dz, this._zoomMin, this._zoomMax);
        this._setZoomAroundScreenPoint(z2, midX, midY);
        this._notePinchVelocity(z2 - prevZ, performance.now());
      }
      this._touchState.lastPinchDist = pinchDist;
    }

    // Pan: translate based on midpoint delta from last frame
    const dmx = midX - this._touchState.lastMidpoint.x;
    const dmy = midY - this._touchState.lastMidpoint.y;
    
    if (Math.abs(dmx) > 0.5 || Math.abs(dmy) > 0.5) {
      const c = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
      const nx = c.x - dmx;
      const ny = clamp(c.y - dmy, 0, c.ws - 1);
      const ll = worldToLatLon(nx, ny, this.zoom);
      this.center = { lat: ll.lat, lon: ll.lon };
    }

    this._touchState.lastMidpoint = { x: midX, y: midY };
    this._pinchAnchorSX = midX;
    this._pinchAnchorSY = midY;

    // Use lightweight redraw during touch - just reposition existing content
    this._requestPanRedraw();
  }

  onTouchEnd(e) {
    if (!this._touchState) return;
    e.preventDefault();

    const remaining = e.touches.length;
    
    if (remaining === 0) {
      // Mark touch as ended
      this._touchActive = false;
      // Clear pan snapshots so next redraw is full
      this._panSnapshotCenter = null;
      // All fingers lifted - start inertia if we were pinching
      if (this._pinchZooming) {
        this._startPinchInertia();
      } else {
        // No pinch inertia - do a full redraw now
        this._requestZoomRedraw();
      }
      this._touchState = null;
    } else if (remaining === 1 && this._touchState.startTouches >= 2) {
      // Went from 2+ fingers to 1 - reset pan origin to avoid jump
      // Also re-capture snapshots from current state for continued pan
      this._capturePanSnapshots();
      const rect = this.overlayCanvas.getBoundingClientRect();
      const t = e.touches[0];
      const mx = t.clientX - rect.left;
      const my = t.clientY - rect.top;
      this._touchState.lastMidpoint = { x: mx, y: my };
      this._touchState.lastPinchDist = 0;
      this._touchState.startTouches = 1;
      this._pinchZooming = false;
      // End zoom inertia; continue panning only
      this._stopPinchInertia();
      this._requestZoomRedraw();
    }
  }

  setTheme(themeKey) {
    const k = String(themeKey || "");
    const t = TILE_THEMES[k] || TILE_THEMES["carto_voyager"];
    this.themeKey = TILE_THEMES[k] ? k : "carto_voyager";
    this.tileTemplate = t.template;
    this.tileSubdomains = t.subdomains;
    this._tileEpoch++;
    this.tileCache.clear();
    // snapshot invalid across theme swaps
    this._tilesSnapshotCanvas = null;
    this._tilesSnapshotMeta = null;
    this.draw(this.lastState);
  }

  onMouseDown(e) {
    // Click-drag pan (mouse). Trackpad two-finger pan is still wheel-based.
    if (e.button !== 0) return;

    // DVR: drag a marker to scrub playback time along its path.
    // NOTE: Click-to-drag marker scrubbing is temporarily disabled.
    /*
    if (this.playbackMode) {
      const nowMs = performance.now();
      const hit = this._hitTestMobileAtClientXY(e.clientX, e.clientY, nowMs);
      if (hit && hit.id != null) {
        try { e.preventDefault(); e.stopPropagation(); } catch {}
        const id = String(hit.id);
        const wasPlaying = this.getPlaybackPlaying();
        // Stop playback while manipulating (like a DVR scrub).
        this.setPlaybackPlaying(false);

        // Cancel any existing inertia glide when a new interaction begins.
        this._pbInertia2d = null;

        // Bring the interacted marker to the top of the draw stack immediately.
        // (Do not call __selectSensor here; that may trigger camera orchestration.)
        try {
          const k = keyFor("mobile", id);
          if (this.selectedId !== k) this.selectedId = k;
        } catch {}

        this._pbDrag = {
          id,
          startedAtMs: nowMs,
          lastClient: { x: e.clientX, y: e.clientY },
          cursorClient: { x: e.clientX, y: e.clientY },
          lastMoveMs: nowMs,
          vel: { x: 0, y: 0 },
          wasPlaying,
        };

        // Immediately scrub to the closest point under the cursor.
        try { this._scrubPlaybackTimeForMobileAtClientXY(hit, e.clientX, e.clientY); } catch {}

        // Treat as a drag so onClick does not toggle selection.
        this._mouseDragMoved = false;
        this.drawOverlay(this.lastState);
        return;
      }
    }
    */

    this._noteUserInteraction();
    this._mouseDragging = true;
    this._mouseDragMoved = false;
    this._mouseDragStart = { x: e.clientX, y: e.clientY };
    const cw = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
    this._mouseDragCenterStart = { x: cw.x, y: cw.y, ws: cw.ws };
  }

  onMouseMove(e) {
    if (this._pbDrag && this.playbackMode) {
      const nowMs = performance.now();
      const dx = e.clientX - (this._pbDrag.lastClient?.x ?? e.clientX);
      const dy = e.clientY - (this._pbDrag.lastClient?.y ?? e.clientY);
      if (Math.abs(dx) + Math.abs(dy) > 2) this._mouseDragMoved = true;

      // Track drag velocity for inertial glide on release.
      const lastMoveMs = (this._pbDrag.lastMoveMs != null && isFinite(this._pbDrag.lastMoveMs)) ? this._pbDrag.lastMoveMs : nowMs;
      const dtMs = Math.max(1, nowMs - lastMoveMs);
      const vx = dx / dtMs;
      const vy = dy / dtMs;
      const prevV = this._pbDrag.vel || { x: 0, y: 0 };
      // Low-pass filter: stable velocity estimate without jitter.
      const a = 0.25;
      this._pbDrag.vel = {
        x: prevV.x * (1 - a) + vx * a,
        y: prevV.y * (1 - a) + vy * a,
      };
      this._pbDrag.lastMoveMs = nowMs;

      this._pbDrag.lastClient = { x: e.clientX, y: e.clientY };
      this._pbDrag.cursorClient = { x: e.clientX, y: e.clientY };
      const st = this.lastState;
      const mobiles = st && Array.isArray(st.mobile) ? st.mobile : [];
      const m = mobiles.find(mm => (mm && mm.id != null && String(mm.id) === String(this._pbDrag.id))) || null;
      if (m) {
        // Always scrub time to the closest point on the path (no distance gating).
        const closest = this._closestPlaybackPathPointForMobileAtClientXY(m, e.clientX, e.clientY);
        if (closest && isFinite(closest.tMs)) {
          const bounds = this.getPlaybackBounds();
          const tMs = closest.tMs;
          if (isFinite(bounds.minMs) && isFinite(bounds.maxMs)) {
            const clamped = clamp(tMs, bounds.minMs, bounds.maxMs);
            this.setPlaybackTimeMs(clamped);
            // User interaction exits LIVE mode (they're manually controlling)
            this._playbackLiveFollow = false;
            if (typeof this._resetLiveTracking === "function") this._resetLiveTracking();
          } else {
            this.setPlaybackTimeMs(tMs);
            this._playbackLiveFollow = false;
            if (typeof this._resetLiveTracking === "function") this._resetLiveTracking();
          }
        }
        this.drawOverlay(this.lastState);
      }
      return;
    }
    if (!this._mouseDragging || !this._mouseDragStart || !this._mouseDragCenterStart) return;
    this._noteUserInteraction();
    const dx = e.clientX - this._mouseDragStart.x;
    const dy = e.clientY - this._mouseDragStart.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) this._mouseDragMoved = true;

    const centerX = this._mouseDragCenterStart.x - dx;
    const centerY = clamp(this._mouseDragCenterStart.y - dy, 0, this._mouseDragCenterStart.ws - 1);
    const ll = worldToLatLon(centerX, centerY, this.zoom);
    this.center = { lat: ll.lat, lon: ll.lon };
    this._requestPanRedraw();
  }

  onMouseUp() {
    if (this._pbDrag) {
      const drag = this._pbDrag;
      this._pbDrag = null;

      // Start a short inertial glide for the interacted marker.
      // This continues scrubbing the global time for *all* markers.
      try { this._startPbMarkerInertiaFromDrag(drag); } catch {}

      // User request: always resume playback for all after interacting.
      this.setPlaybackPlaying(true);
      if (typeof window.__ensurePlaybackLoop === "function") window.__ensurePlaybackLoop();
      return;
    }
    this._mouseDragging = false;
    this._mouseDragStart = null;
    this._mouseDragCenterStart = null;
    // click behavior is handled in onClick; we just stop dragging here.
  }

  _getOverlayPaddingPx() {
    // Side-specific padding based on overlay panels that obscure the map.
    // This prevents “fit bounds” from centering under the left/right panels.
    const mapRect = this.overlayCanvas.getBoundingClientRect();
    const pad = { left: 24, right: 24, top: 24, bottom: 24 };
    const ids = ["sidebar", "details"];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const left = Math.max(mapRect.left, r.left);
      const right = Math.min(mapRect.right, r.right);
      const top = Math.max(mapRect.top, r.top);
      const bottom = Math.min(mapRect.bottom, r.bottom);
      if (right <= left || bottom <= top) continue;
      if (r.left <= mapRect.left + 40) {
        pad.left = Math.max(pad.left, right - mapRect.left + 14);
      } else if (r.right >= mapRect.right - 40) {
        pad.right = Math.max(pad.right, mapRect.right - left + 14);
      }
    }
    return pad;
  }

  _animateTo({ centerLat, centerLon, zoom }, { durationMs = 420 } = {}) {
    const lat0 = this.center.lat;
    const lon0 = this.center.lon;
    const z0 = this.zoom;
    const lat1 = Number(centerLat);
    const lon1 = Number(centerLon);
    const z1 = clamp(Number(zoom), this._zoomMin || 1, this._zoomMax || 20);
    if (!isFinite(lat1) || !isFinite(lon1) || !isFinite(z1)) return;
    if (!isFinite(lat0) || !isFinite(lon0) || !isFinite(z0)) return;

    const t0 = performance.now();
    // Only used for auto-centering / fit-to-bounds. Keep it snappy.
    const dur = Math.max(120, durationMs);

    if (this._centerAnimRAF) cancelAnimationFrame(this._centerAnimRAF);

    // Safety: limit animation frames to prevent runaway loops
    let frameCount = 0;
    const maxFrames = Math.ceil(dur / 8) + 60;

    const step = () => {
      frameCount++;
      if (frameCount > maxFrames) {
        console.warn('_animateTo: exceeded max frames, forcing completion');
        this.zoom = z1;
        this.center = { lat: lat1, lon: lon1 };
        this.draw(this.lastState);
        this._notifyViewChanged();
        this._centerAnimRAF = null;
        return;
      }

      const t = clamp((performance.now() - t0) / dur, 0, 1);
      // “light” ease-out (cubic)
      const ease = 1 - Math.pow(1 - t, 3);
      this.zoom = z0 + (z1 - z0) * ease;
      this.center = { lat: lat0 + (lat1 - lat0) * ease, lon: lon0 + (lon1 - lon0) * ease };
      this.draw(this.lastState);
      this._notifyViewChanged();
      if (t < 1) {
        this._centerAnimRAF = requestAnimationFrame(step);
      } else {
        this._centerAnimRAF = null;
      }
    };
    this._centerAnimRAF = requestAnimationFrame(step);
  }

  fitTrailBounds(trailPoints, { animate = true } = {}) {
    const pts = Array.isArray(trailPoints) ? trailPoints : [];
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    let count = 0;
    for (const p of pts) {
      const lat = Number(p.lat);
      const lon = Number(p.lon);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
      count++;
    }
    if (count === 0) return;
    this.fitBoundsLatLon({ minLat, minLon, maxLat, maxLon }, { animate });
  }

  fitBoundsLatLon({ minLat, minLon, maxLat, maxLon }, { animate = true } = {}) {
    // Compute zoom to fit bbox using WebMercator at z=0.
    const w0 = 256;
    const xMin0 = lonToX(minLon, w0);
    const xMax0 = lonToX(maxLon, w0);
    const yMin0 = latToY(maxLat, w0);
    const yMax0 = latToY(minLat, w0);
    const dx0 = Math.max(1e-6, Math.abs(xMax0 - xMin0));
    const dy0 = Math.max(1e-6, Math.abs(yMax0 - yMin0));

    const rect = this.overlayCanvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const pad = this._getOverlayPaddingPx();
    const availW = Math.max(40, w - pad.left - pad.right);
    const availH = Math.max(40, h - pad.top - pad.bottom);

    const scale = Math.min(availW / dx0, availH / dy0);
    let z = Math.log2(scale);
    // padding / breathing room
    z -= 0.18;
    z = clamp(z, this._zoomMin, this._zoomMax);

    // Center of bbox in world coords at z=0, then convert to lat/lon
    const cx0 = (xMin0 + xMax0) / 2;
    const cy0 = (yMin0 + yMax0) / 2;
    const center0 = worldToLatLon(cx0, cy0, 0);

    // Target screen center in the unobscured map area
    const targetScreenX = pad.left + availW / 2;
    const targetScreenY = pad.top + availH / 2;

    // Convert center0 to world at target zoom, then choose map center so center0 appears at targetScreen.
    const cWorld = latLonToWorld(center0.lat, center0.lon, z);
    const centerWorldX = cWorld.x - (targetScreenX - w / 2);
    const centerWorldY = cWorld.y - (targetScreenY - h / 2);
    const centerLL = worldToLatLon(centerWorldX, clamp(centerWorldY, 0, cWorld.ws - 1), z);

    if (animate) {
      this._animateTo({ centerLat: centerLL.lat, centerLon: centerLL.lon, zoom: z }, { durationMs: 320 });
    } else {
      this.center = { lat: centerLL.lat, lon: centerLL.lon };
      this.zoom = z;
      this.draw(this.lastState);
    }
  }

  _screenPointToLatLon(sx, sy) {
    const rect = this.tilesCanvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const c = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
    const wx = c.x - w / 2 + sx;
    const wy = c.y - h / 2 + sy;
    const clampedY = clamp(wy, 0, c.ws - 1);
    return worldToLatLon(wx, clampedY, this.zoom);
  }

  _setZoomAroundScreenPoint(newZoom, sx, sy) {
    const rect = this.tilesCanvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const z2 = clamp(newZoom, this._zoomMin, this._zoomMax);

    // Lat/Lon under cursor at current zoom
    const ll = this._screenPointToLatLon(sx, sy);

    // World point at new zoom
    const wpt2 = latLonToWorld(ll.lat, ll.lon, z2);
    const centerWorld2 = {
      x: wpt2.x - (sx - w / 2),
      y: wpt2.y - (sy - h / 2),
      ws: wpt2.ws,
    };
    const centerLL2 = worldToLatLon(centerWorld2.x, clamp(centerWorld2.y, 0, wpt2.ws - 1), z2);

    this.zoom = z2;
    this.center = { lat: centerLL2.lat, lon: centerLL2.lon };
  }

  centerOn(lat, lon, { animate = true } = {}) {
    const latN = Number(lat), lonN = Number(lon);
    if (!isFinite(latN) || !isFinite(lonN)) return;

    if (!animate) {
      this.center = { lat: latN, lon: lonN };
      this.draw(this.lastState);
      return;
    }

    // Animate center only (keep zoom)
    this._animateTo({ centerLat: latN, centerLon: lonN, zoom: this.zoom }, { durationMs: 220 });
  }

  cancelSelectionOrchestration() {
    if (this._selectOrchRAF) cancelAnimationFrame(this._selectOrchRAF);
    this._selectOrchRAF = null;
    this._selectOrch = null;
    // Do not clear all warps; only clear the currently-selected one if we know it.
    // (Leaving others would be harmless but is confusing.)
    // Clear any expired warps opportunistically.
    const nowMs = performance.now();
    for (const [id, w] of this._traceSelectionWarpById.entries()) {
      const t = nowMs - Number(w?.t0Ms);
      const dur = Number(w?.durationMs);
      if (!isFinite(t) || !isFinite(dur) || t >= dur) this._traceSelectionWarpById.delete(id);
    }
  }

  _latLonComfortablyInView(lat, lon) {
    const latN = Number(lat);
    const lonN = Number(lon);
    if (!isFinite(latN) || !isFinite(lonN)) return false;
    const w = this._cssW || 1;
    const h = this._cssH || 1;
    const centerW = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
    const tgtW = latLonToWorld(latN, lonN, this.zoom);
    const sx = tgtW.x - centerW.x + w / 2;
    const sy = tgtW.y - centerW.y + h / 2;
    // Comfortable inset region to avoid constant micro-panning.
    const mx = w * 0.22;
    const my = h * 0.22;
    return (sx >= mx && sx <= (w - mx) && sy >= my && sy <= (h - my));
  }

  _computeFocusedCenterFor(lat, lon) {
    // If the point is already well within the view, keep the current center.
    if (this._latLonComfortablyInView(lat, lon)) return { lat: this.center.lat, lon: this.center.lon, needsMove: false };

    const latN = Number(lat);
    const lonN = Number(lon);
    const w = this._cssW || 1;
    const h = this._cssH || 1;
    const centerW = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
    const tgtW = latLonToWorld(latN, lonN, this.zoom);
    const dx = (tgtW.x - centerW.x);
    const dy = (tgtW.y - centerW.y);

    // How far off-center is it (in screen space)?
    // Convert world delta to screen delta directly (1 world unit == 1 pixel at current zoom).
    const nx = Math.max(Math.abs(dx) / Math.max(1, w / 2), Math.abs(dy) / Math.max(1, h / 2));
    // Partial nudge when only slightly off; full center when far.
    const strength = (nx > 0.85) ? 1.0 : 0.72;
    const desiredCenterW = {
      x: centerW.x + dx * strength,
      y: centerW.y + dy * strength,
      ws: centerW.ws,
    };
    const ll = worldToLatLon(desiredCenterW.x, clamp(desiredCenterW.y, 0, centerW.ws - 1), this.zoom);
    return { lat: ll.lat, lon: ll.lon, needsMove: true };
  }

  orchestrateSelectionToLatest(mobile, { fitTrail = false } = {}) {
    if (!mobile || !mobile.id) return;
    if (fitTrail) return; // handled by fitTrailBounds at call site
    if (this.playbackMode) return;

    const id = String(mobile.id);
    const homeLat = Number(mobile.lat);
    const homeLon = Number(mobile.lon);
    if (!isFinite(homeLat) || !isFinite(homeLon)) return;

    // Cancel any previous orchestration.
    this.cancelSelectionOrchestration();

    const nowMs = performance.now();
    const focus = this._computeFocusedCenterFor(homeLat, homeLon);

    // If trace mode is active, and the replay marker is far from the latest point,
    // fade-out → invisible warp → fade-in at the latest point.
    let needsWarp = false;
    let fromLat = homeLat;
    let fromLon = homeLon;
    if (this.traceMode && this._traceActiveRouteById.has(id)) {
      const smp = this._traceSampleForMobile(mobile, nowMs);
      if (smp && isFinite(smp.lat) && isFinite(smp.lon)) {
        fromLat = smp.lat;
        fromLon = smp.lon;
        const d = haversineMeters(fromLat, fromLon, homeLat, homeLon);
        needsWarp = isFinite(d) && d > 25;
      }
    }

    // Orchestration timings (ms)
    const fadeMs = 500;
    const warpDurMs = needsWarp ? 1400 : 0;
    const camDelayMs = needsWarp ? fadeMs : 0;
    const camDurMs = focus.needsMove ? (needsWarp ? 420 : 320) : 0;

    if (needsWarp) {
      this._traceSelectionWarpById.set(id, {
        t0Ms: nowMs,
        fromLat,
        fromLon,
        homeLat,
        homeLon,
        fadeMs,
        durationMs: warpDurMs,
      });
    }

    this._selectOrch = {
      id,
      t0Ms: nowMs,
      homeLat,
      homeLon,
      camTo: { lat: focus.lat, lon: focus.lon },
      camFrom: null,
      camDelayMs,
      camDurMs,
      warpDurMs,
    };

    const step = () => {
      this._selectOrchRAF = null;
      const o = this._selectOrch;
      if (!o || o.id !== id) return;

      const t = performance.now() - o.t0Ms;
      const camStart = o.camDelayMs;
      const camEnd = o.camDelayMs + o.camDurMs;
      if (o.camDurMs > 0 && t >= camStart && t <= camEnd) {
        if (!o.camFrom) o.camFrom = { lat: this.center.lat, lon: this.center.lon };
        const u = clamp((t - camStart) / Math.max(1, o.camDurMs), 0, 1);
        const ease = 1 - Math.pow(1 - u, 3);
        const lat = o.camFrom.lat + (o.camTo.lat - o.camFrom.lat) * ease;
        const lon = o.camFrom.lon + (o.camTo.lon - o.camFrom.lon) * ease;
        this.center = { lat, lon };
        this._invalidateOverlayStatic();
        this.draw(this.lastState);
        this._notifyViewChanged();
      } else if (o.camDurMs > 0 && t > camEnd && o.camFrom) {
        // Snap to final to avoid a tiny drift.
        this.center = { lat: o.camTo.lat, lon: o.camTo.lon };
        o.camDurMs = 0;
        this._invalidateOverlayStatic();
        this.draw(this.lastState);
        this._notifyViewChanged();
      }

      const doneAt = Math.max(o.warpDurMs || 0, (o.camDelayMs || 0) + (o.camDurMs || 0));
      if (t < doneAt) {
        this._selectOrchRAF = requestAnimationFrame(step);
      } else {
        this._selectOrch = null;
      }
    };

    // Kick a RAF even if camera doesn't move; this keeps ordering consistent.
    this._selectOrchRAF = requestAnimationFrame(step);
  }

  setSelected(id) {
    // Called frequently from the polling loop; must be idempotent to avoid
    // redrawing the whole overlay every poll when selection hasn't changed.
    const next = id || null;
    if (this.selectedId === next) return;
    this.selectedId = next;
    this._invalidateOverlayStatic();
    this.drawOverlay(this.lastState);
  }

  setShowFixed(v) {
    const next = !!v;
    if (this.showFixed === next) return;
    this.showFixed = next;
    this._invalidateOverlayStatic();
    this.drawOverlay(this.lastState);
  }

  setTraceMode(v) {
    this.traceMode = !!v;
    if (this.traceMode) {
      this._traceLastFrameTs = 0;
      this._traceInitialRunDoneById.clear();
      this._traceCycleStartMsById.clear();
      this._invalidateOverlayStatic();
      if (!this._traceRAF) this._traceRAF = requestAnimationFrame(() => this._traceTick());
    } else {
      if (this._traceRAF) cancelAnimationFrame(this._traceRAF);
      this._traceRAF = null;
      this._traceLastFrameTs = 0;
      this.drawOverlay(this.lastState);
    }
  }

  setPlaybackMode(v) {
    this.playbackMode = !!v;
    if (!this.playbackMode) {
      this._playbackPlaying = false;
      this._playbackNewestSegmentStartMs = null;
      this._playbackLastMaxMs = null;
      this._playbackLiveFollow = true;
      this._playbackInitialized = false;
    } else {
      // Entering DVR starts in LIVE follow-tail at the end-of-data.
      this._playbackLiveFollow = true;
      this._playbackInitialized = false;  // Will be initialized by playback loop
      // Don't set _playbackNowMs here - let the playback loop handle it with 10-min offset
    }
    this._invalidateOverlayStatic();
    this.drawOverlay(this.lastState);
  }

  setPlaybackPlaying(v) {
    this._playbackPlaying = !!v;
  }

  _playbackMarkNewestSegmentFromBounds(prevMaxMs, nextMaxMs) {
    const p = (prevMaxMs != null) ? Number(prevMaxMs) : null;
    const n = (nextMaxMs != null) ? Number(nextMaxMs) : null;
    if (p != null && n != null && isFinite(p) && isFinite(n) && n > p + 500) {
      this._playbackNewestSegmentStartMs = p;
    }
    this._playbackLastMaxMs = (n != null && isFinite(n)) ? n : this._playbackLastMaxMs;
  }

  isPlaybackAtEnd(epsMs = 100) {
    const b = this.getPlaybackBounds();
    const t = this.getPlaybackTimeMs();
    if (b.maxMs == null || !isFinite(Number(b.maxMs))) return false;
    if (t == null || !isFinite(Number(t))) return false;
    return Math.abs(Number(b.maxMs) - Number(t)) <= (Number(epsMs) || 0);
  }

  setPlaybackSpeed(v) {
    const n = Number(v);
    this._playbackSpeed = (isFinite(n) && n > 0) ? n : 1.0;
  }

  setPlaybackTimeMs(tMs) {
    const n = Number(tMs);
    this._playbackNowMs = isFinite(n) ? n : null;
  }

  getPlaybackBounds() {
    return { minMs: this._playbackMinMs, maxMs: this._playbackMaxMs };
  }

  getPlaybackTimeMs() {
    return this._playbackNowMs;
  }

  getPlaybackPlaying() {
    return !!this._playbackPlaying;
  }

  getPlaybackSpeed() {
    return this._playbackSpeed;
  }

  _hitTestMobileAtClientXY(clientX, clientY, nowMs) {
    const st = this.lastState;
    const mobiles = st && Array.isArray(st.mobile) ? st.mobile : [];
    const rect = this.overlayCanvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;

    const w = rect.width;
    const h = rect.height;
    const centerW = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
    const worldToScreenFast = (wx, wy) => ({ x: wx - centerW.x + w / 2, y: wy - centerW.y + h / 2 });

    for (const m of mobiles) {
      const pose = this._mobilePoseForRender(m, nowMs);
      const lat = Number(pose?.lat);
      const lon = Number(pose?.lon);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      const wpt = latLonToWorld(lat, lon, this.zoom);
      const sp = worldToScreenFast(wpt.x, wpt.y);
      const dx = sp.x - sx;
      const dy = sp.y - sy;
      if ((dx * dx + dy * dy) <= (20 * 20)) {
        return m;
      }
    }
    return null;
  }

  _closestPlaybackPathPointForMobileAtClientXY(mobile, clientX, clientY) {
    if (!this.playbackMode) return null;
    const id = mobile && mobile.id != null ? String(mobile.id) : "";
    if (!id) return null;

    this._ensurePlaybackPoints(this.lastState);
    const pts = this._playbackPtsById.get(id);
    if (!pts || pts.length < 2) return null;

    const rect = this.overlayCanvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const w = rect.width;
    const h = rect.height;
    const centerW = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
    const toScreen = (lat, lon) => {
      const wpt = latLonToWorld(lat, lon, this.zoom);
      return { x: wpt.x - centerW.x + w / 2, y: wpt.y - centerW.y + h / 2 };
    };

    const closestOnSeg = (ax, ay, bx, by, px, py) => {
      const abx = bx - ax;
      const aby = by - ay;
      const apx = px - ax;
      const apy = py - ay;
      const ab2 = abx * abx + aby * aby;
      let t = 0;
      if (ab2 > 1e-9) t = (apx * abx + apy * aby) / ab2;
      t = clamp(t, 0, 1);
      const cx = ax + abx * t;
      const cy = ay + aby * t;
      const dx = px - cx;
      const dy = py - cy;
      return { t, cx, cy, d2: dx * dx + dy * dy };
    };

    // Coarse-to-fine search so long trails still feel responsive.
    const n = pts.length;
    const stride = Math.max(1, Math.floor(n / 520));
    let best = { i: 0, t: 0, cx: 0, cy: 0, d2: Infinity };

    const scan = (i0, i1, step) => {
      const start = Math.max(0, i0);
      const end = Math.min(n - 2, i1);
      for (let i = start; i <= end; i += step) {
        const a = pts[i];
        const b = pts[i + 1];
        const sa = toScreen(a.lat, a.lon);
        const sb = toScreen(b.lat, b.lon);
        const hit = closestOnSeg(sa.x, sa.y, sb.x, sb.y, sx, sy);
        if (hit.d2 < best.d2) best = { i, t: hit.t, cx: hit.cx, cy: hit.cy, d2: hit.d2 };
      }
    };

    scan(0, n - 2, stride);
    const win = Math.max(24, stride * 7);
    scan(best.i - win, best.i + win, 1);

    const a = pts[best.i];
    const b = pts[best.i + 1];
    const tMs = a.tMs + (b.tMs - a.tMs) * best.t;
    const distPx = Math.sqrt(best.d2);
    return { tMs, distPx, segI: best.i, segT: best.t, closest: { x: best.cx, y: best.cy }, cursor: { x: sx, y: sy } };
  }

  _startPbMarkerInertiaFromDrag(drag) {
    if (!this.playbackMode) return;
    const id = drag && drag.id != null ? String(drag.id) : "";
    if (!id) return;
    const pos = drag && drag.cursorClient ? drag.cursorClient : (drag && drag.lastClient ? drag.lastClient : null);
    if (!pos) return;
    const v0 = drag && drag.vel ? drag.vel : { x: 0, y: 0 };
    const vx = Number(v0.x) || 0;
    const vy = Number(v0.y) || 0;
    const speed = Math.hypot(vx, vy);
    // Only a subtle glide; ignore tiny releases.
    if (!isFinite(speed) || speed < 0.05) return; // px/ms

    const nowMs = performance.now();
    this._pbInertia2d = {
      id,
      t0Ms: nowMs,
      lastMs: nowMs,
      posClient: { x: Number(pos.x) || 0, y: Number(pos.y) || 0 },
      vel: { x: vx, y: vy },
    };
  }

  _hasPbMarkerInertia() {
    return !!(this._pbInertia2d && this._pbInertia2d.id);
  }

  _stepPbMarkerInertia(nowMs, dtMs) {
    const it = this._pbInertia2d;
    if (!it || !it.id) return false;
    const dt = Math.max(0, Number(dtMs) || 0);
    if (!(dt > 0)) return false;

    // Cap duration so a fling never runs away.
    const age = (nowMs - (it.t0Ms || nowMs));
    if (age > 900) {
      this._pbInertia2d = null;
      return false;
    }

    // Integrate in client space; then snap to nearest path point.
    it.posClient.x += (it.vel.x || 0) * dt;
    it.posClient.y += (it.vel.y || 0) * dt;

    // Exponential friction: quick settle.
    const friction = Math.pow(0.992, dt);
    it.vel.x *= friction;
    it.vel.y *= friction;

    const speed = Math.hypot(it.vel.x || 0, it.vel.y || 0);
    if (!isFinite(speed) || speed < 0.02) {
      this._pbInertia2d = null;
      return false;
    }

    const st = this.lastState;
    const mobiles = st && Array.isArray(st.mobile) ? st.mobile : [];
    const m = mobiles.find(mm => (mm && mm.id != null && String(mm.id) === String(it.id))) || null;
    if (!m) {
      this._pbInertia2d = null;
      return false;
    }

    const closest = this._closestPlaybackPathPointForMobileAtClientXY(m, it.posClient.x, it.posClient.y);
    if (closest && isFinite(closest.tMs)) {
      const bounds = this.getPlaybackBounds();
      const tMs = closest.tMs;
      if (isFinite(bounds.minMs) && isFinite(bounds.maxMs)) {
        const clamped = clamp(tMs, bounds.minMs, bounds.maxMs);
        this.setPlaybackTimeMs(clamped);
        // User interaction exits LIVE mode (they're manually controlling)
        this._playbackLiveFollow = false;
        if (typeof this._resetLiveTracking === "function") this._resetLiveTracking();
      } else {
        this.setPlaybackTimeMs(tMs);
        this._playbackLiveFollow = false;
        if (typeof this._resetLiveTracking === "function") this._resetLiveTracking();
      }
      return true;
    }

    return false;
  }

  _scrubPlaybackTimeForMobileAtClientXY(mobile, clientX, clientY) {
    const c = this._closestPlaybackPathPointForMobileAtClientXY(mobile, clientX, clientY);
    if (!c || !isFinite(c.tMs)) return;
    const bounds = this.getPlaybackBounds();
    if (isFinite(bounds.minMs) && isFinite(bounds.maxMs)) {
      let clamped = clamp(c.tMs, bounds.minMs, bounds.maxMs);
      this.setPlaybackTimeMs(clamped);
    }
    else this.setPlaybackTimeMs(c.tMs);
  }

  _traceTick() {
    this._traceRAF = null;
    if (!this.traceMode) return;
    // Basemap is static; only redraw overlays.
    // Throttle to reduce CPU while remaining smooth.
    const now = performance.now();
    const minDt = 1000 / (this._traceTargetFPS || 30);
    if (this._traceLastFrameTs > 0 && (now - this._traceLastFrameTs) < (minDt - 0.5)) {
      this._traceRAF = requestAnimationFrame(() => this._traceTick());
      return;
    }
    this._traceLastFrameTs = now;
    this.drawOverlay(this.lastState, { nowMs: now, fromTraceTick: true });
    this._traceRAF = requestAnimationFrame(() => this._traceTick());
  }

  _hash01(s) {
    const str = String(s || "");
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % 100000) / 100000;
  }

  _traceSampleForMobile(m, nowMs) {
    const id = m && m.id ? String(m.id) : "";

    // If the backend says this vehicle is idle/ghosted, dim marker unless selected or in Debug mode.
    if (m && m.ghosted) {
      const lat = Number(m.lat);
      const lon = Number(m.lon);
      const prevA = this._traceAngleById.get(id);
      const angle = (prevA != null && isFinite(prevA)) ? prevA : 0;
      this._traceAngleById.set(id, angle);
      this._traceAngleLastMsById.set(id, nowMs);
      
      const key = keyFor("mobile", m.id);
      const isSel = (this.selectedId === key);
      const dimOpacity = 0.25;
      const opacity = (this._pbDebugPath || isSel) ? 1 : dimOpacity;
      
      return { lat, lon, angle, flipX: false, speedMps: 0, opacity };
    }

    let route = this._traceActiveRouteById.get(id) || null;
    if (!route || !route.pts || route.pts.length < 2) {
      route = this._tracePendingRouteById.get(id) || null;
      if (!route || !route.pts || route.pts.length < 2) return null;
      // If we only have a pending route (startup), promote it.
      this._traceActiveRouteById.set(id, route);
      this._tracePendingRouteById.delete(id);
    }

    let driveMs = route.driveMs || 1;
    let pauseMs = route.pauseMs || 0;
    let returnMs = route.returnMs || 0;
    let totalMs = route.totalMs || (driveMs + pauseMs + returnMs);

    // Keep the current loop stable across refreshes; only swap pending route at loop boundary.
    let cycleStartMs = this._traceCycleStartMsById.get(id);
    if (cycleStartMs == null || !isFinite(cycleStartMs)) {
      // Start at the beginning of the path.
      cycleStartMs = nowMs;
    }
    let elapsed = nowMs - cycleStartMs;
    if (!isFinite(elapsed)) elapsed = 0;

    // Swap pending route only at loop boundary so the animation doesn't jump.
    if (elapsed >= totalMs) {
      const pending = this._tracePendingRouteById.get(id);
      if (pending && pending.pts && pending.pts.length >= 2) {
        route = pending;
        this._traceActiveRouteById.set(id, pending);
        this._tracePendingRouteById.delete(id);
        driveMs = route.driveMs || 1;
        pauseMs = route.pauseMs || 0;
        returnMs = route.returnMs || 0;
        totalMs = route.totalMs || (driveMs + pauseMs + returnMs);
        cycleStartMs = nowMs;
        elapsed = 0;
      } else {
        const loopDur = Math.max(100, totalMs);
        const cyclesPassed = Math.floor(elapsed / loopDur);
        cycleStartMs = cycleStartMs + cyclesPassed * loopDur;
        elapsed = nowMs - cycleStartMs;
      }
    }
    this._traceCycleStartMsById.set(id, cycleStartMs);

    const tInCycle = elapsed;
    const tPauseStart = driveMs;
    const tReturnStart = driveMs + pauseMs;
    const tEnd = driveMs + pauseMs + (returnMs || 0);

    const inPause = (tInCycle >= tPauseStart) && (tInCycle < tReturnStart);
    const inReturn = (tInCycle >= tReturnStart) && (tInCycle < tEnd) && ((returnMs || 0) > 0);
    const tDrive = (tInCycle < driveMs) ? tInCycle : driveMs;

    // Find segment for tDrive.
    const segStart = route.segStartMs;
    const segDur = route.segDurMs;
    const pts = route.pts;
    let si = 0;
    let lo = 0;
    let hi = segStart.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const a = segStart[mid];
      const b = a + (segDur[mid] || 1);
      if (tDrive < a) hi = mid - 1;
      else if (tDrive >= b) lo = mid + 1;
      else { si = mid; break; }
    }
    // If binary search didn't land (e.g. exact end), clamp.
    if (si < 0) si = 0;
    if (si >= segStart.length) si = segStart.length - 1;

    const aT = segStart[si];
    const dT = Math.max(1, segDur[si] || 1);
    const u = clamp((tDrive - aT) / dT, 0, 1);

    const p0 = pts[si];
    const p1 = pts[si + 1] || pts[si];
    let lat = p0.lat + (p1.lat - p0.lat) * u;
    let lon = p0.lon + (p1.lon - p0.lon) * u;
    let speedMps = (route.segRealSpeedMps && isFinite(route.segRealSpeedMps[si]) ? route.segRealSpeedMps[si] : 0);
    let opacity = 1;

    if (inPause) {
      const endPt = pts[pts.length - 1] || p1;
      lat = endPt.lat;
      lon = endPt.lon;
      speedMps = 0;
    } else if (inReturn) {
      const endPt = pts[pts.length - 1] || p1;
      const lsLat = isFinite(Number(route.loopStartLat)) ? Number(route.loopStartLat) : (pts[0]?.lat ?? endPt.lat);
      const lsLon = isFinite(Number(route.loopStartLon)) ? Number(route.loopStartLon) : (pts[0]?.lon ?? endPt.lon);
      const uu = clamp((tInCycle - tReturnStart) / Math.max(1, returnMs || 1), 0, 1);
      lat = endPt.lat + (lsLat - endPt.lat) * uu;
      lon = endPt.lon + (lsLon - endPt.lon) * uu;
      const distM = haversineMeters(endPt.lat, endPt.lon, lsLat, lsLon);
      const v = distM / Math.max(0.001, (returnMs || 1) / 1000);
      speedMps = clamp(v, 0, Number(this._traceRealMaxSpeedMps) || 20.0);

      // Seamless fade on loop return:
      // - fade out over first 0.5s of return
      // - stay invisible mid-return
      // - fade in over last 0.5s before arriving at loop start
      const fadeMs = 500;
      const tRet = tInCycle - tReturnStart;
      const tRemain = (tEnd - tInCycle);
      if (tRet <= fadeMs) opacity = clamp(1 - (tRet / fadeMs), 0, 1);
      else if (tRemain <= fadeMs) opacity = clamp(1 - (tRemain / fadeMs), 0, 1);
      else opacity = 0;
    }

    // Selection warp: when a sensor is clicked, make the trace marker "return" to the latest
    // live location deterministically (fade-out → invisible warp → fade-in).
    const warp = this._traceSelectionWarpById.get(id);
    if (warp) {
      const t0 = Number(warp.t0Ms);
      const fadeMs = Number(warp.fadeMs) || 500;
      const durMs = Number(warp.durationMs) || 1400;
      const t = nowMs - t0;
      if (!isFinite(t) || t < 0) {
        // ignore
      } else if (t >= durMs) {
        this._traceSelectionWarpById.delete(id);
        // Force the trace cycle to the end point (latest) so it stays in sync after warp.
        const r = this._traceActiveRouteById.get(id);
        if (r && isFinite(Number(r.driveMs))) {
          this._traceCycleStartMsById.set(id, nowMs - Number(r.driveMs));
        }
      } else {
        const fromLat = Number(warp.fromLat);
        const fromLon = Number(warp.fromLon);
        const homeLat = Number(warp.homeLat);
        const homeLon = Number(warp.homeLon);
        const midDur = Math.max(1, durMs - 2 * fadeMs);
        if (t <= fadeMs) {
          // Fade out at the original trace position.
          lat = isFinite(fromLat) ? fromLat : lat;
          lon = isFinite(fromLon) ? fromLon : lon;
          speedMps = 0;
          opacity = opacity * clamp(1 - (t / Math.max(1, fadeMs)), 0, 1);
        } else if (t >= (durMs - fadeMs)) {
          // Fade in at the latest live position.
          lat = isFinite(homeLat) ? homeLat : lat;
          lon = isFinite(homeLon) ? homeLon : lon;
          speedMps = 0;
          const u = (t - (durMs - fadeMs)) / Math.max(1, fadeMs);
          opacity = opacity * clamp(u, 0, 1);
        } else {
          // Invisible warp (optionally interpolate for determinism).
          const u = clamp((t - fadeMs) / midDur, 0, 1);
          if (isFinite(fromLat) && isFinite(homeLat)) lat = fromLat + (homeLat - fromLat) * u;
          if (isFinite(fromLon) && isFinite(homeLon)) lon = fromLon + (homeLon - fromLon) * u;
          speedMps = 0;
          opacity = 0;
        }
      }
    }

    // Heading in projected space for correct screen rotation.
    let hLat0 = p0.lat;
    let hLon0 = p0.lon;
    let hLat1 = p1.lat;
    let hLon1 = p1.lon;
    if (inPause) {
      const a = pts[Math.max(0, pts.length - 2)] || p0;
      const b = pts[Math.max(0, pts.length - 1)] || p1;
      hLat0 = a.lat;
      hLon0 = a.lon;
      hLat1 = b.lat;
      hLon1 = b.lon;
    } else if (inReturn) {
      const endPt = pts[pts.length - 1] || p1;
      const lsLat = isFinite(Number(route.loopStartLat)) ? Number(route.loopStartLat) : (pts[0]?.lat ?? endPt.lat);
      const lsLon = isFinite(Number(route.loopStartLon)) ? Number(route.loopStartLon) : (pts[0]?.lon ?? endPt.lon);
      hLat0 = endPt.lat;
      hLon0 = endPt.lon;
      hLat1 = lsLat;
      hLon1 = lsLon;
    }

    const w0 = latLonToWorld(hLat0, hLon0, this.zoom);
    const w1 = latLonToWorld(hLat1, hLon1, this.zoom);
    let dx = (w1.x - w0.x);
    let dy = (w1.y - w0.y);
    if (Math.abs(dx) < 0.0001 && Math.abs(dy) < 0.0001) {
      // If we're at (or pausing at) the end, reuse the last meaningful segment.
      const lastIdx = Math.max(0, Math.min(pts.length - 2, pts.length - 2));
      const wa = latLonToWorld(pts[lastIdx].lat, pts[lastIdx].lon, this.zoom);
      const wb = latLonToWorld(pts[lastIdx + 1].lat, pts[lastIdx + 1].lon, this.zoom);
      dx = wb.x - wa.x;
      dy = wb.y - wa.y;
    }
    const heading = Math.atan2(dy, dx);

    // Debounce left/right side changes around vertical to avoid flicker when traveling up/down.
    const absH = Math.abs(heading);
    const dead = 0.22; // ~12.6° deadband
    const switchToLeft = (Math.PI / 2) + dead;
    const switchToRight = (Math.PI / 2) - dead;
    let side = this._traceLastSideById.get(id);
    if (side !== "L" && side !== "R") side = (absH > Math.PI / 2) ? "L" : "R";
    if (side === "R" && absH > switchToLeft) side = "L";
    else if (side === "L" && absH < switchToRight) side = "R";
    this._traceLastSideById.set(id, side);

    let renderAngle = heading;
    if (side === "L") renderAngle = Math.PI - heading;
    if (renderAngle > Math.PI) renderAngle -= Math.PI * 2;
    if (renderAngle < -Math.PI) renderAngle += Math.PI * 2;

    // Smooth the angle to avoid snap-rotation when direction changes.
    const wrapAngle = (a) => {
      let x = a;
      while (x > Math.PI) x -= Math.PI * 2;
      while (x < -Math.PI) x += Math.PI * 2;
      return x;
    };
    const prevA = this._traceAngleById.get(id);
    const lastMs = this._traceAngleLastMsById.get(id);
    const dtS = (lastMs != null && isFinite(lastMs)) ? Math.max(0, (nowMs - lastMs) / 1000) : 0;
    const tauS = 0.35;
    const alpha = dtS > 0 ? (1 - Math.exp(-dtS / tauS)) : 1;
    const nextA = (prevA == null)
      ? renderAngle
      : wrapAngle(prevA + wrapAngle(renderAngle - prevA) * alpha);
    this._traceAngleById.set(id, nextA);
    this._traceAngleLastMsById.set(id, nowMs);

    return { lat, lon, angle: nextA, flipX: (side === "L"), speedMps, opacity };
  }

  _mobilePoseForRender(m, nowMs) {
    let lat = Number(m?.lat);
    let lon = Number(m?.lon);
    let angle = 0;
    let flipX = false;
    let speedMps = 0;
    let opacity = 1;

    if (this.playbackMode) {
      this._ensurePlaybackPoints(this.lastState);
      const smp = this._playbackSampleForMobile(m, nowMs);
      if (smp) {
        lat = smp.lat;
        lon = smp.lon;
        angle = smp.angle;
        flipX = !!smp.flipX;
        speedMps = Number(smp.speedMps) || 0;
        opacity = (typeof smp.opacity === "number" && isFinite(smp.opacity)) ? smp.opacity : 1;
        // Dim markers that haven't "started" yet in the timeline
        if (smp.beforeFirst) {
          opacity = 0.3;
        }
      } else {
        // Fallback: if no playback sample but we have trail data, use first/last trail point
        const id = m && m.id != null ? String(m.id) : "";
        const pts = id ? this._playbackPtsById.get(id) : null;
        const t = this._playbackNowMs;
        if (pts && pts.length >= 1 && t != null && isFinite(t)) {
          // Before first point: show at first position (dimmed)
          // After last point: show at last position
          const tMin = pts[0].tMs;
          const tMax = pts[pts.length - 1].tMs;
          if (t < tMin) {
            lat = pts[0].lat;
            lon = pts[0].lon;
            opacity = 0.3; // Dimmed - hasn't "started" yet
          } else if (t >= tMax) {
            lat = pts[pts.length - 1].lat;
            lon = pts[pts.length - 1].lon;
          }
        }
      }

      const held = !!(
        (this._pbDrag && String(this._pbDrag.id) === String(m?.id)) ||
        (this._pbInertia2d && String(this._pbInertia2d.id) === String(m?.id))
      );

      return {
        lat,
        lon,
        angle,
        flipX,
        speedMps,
        opacity,
        reading: smp?.reading || null,
        held,
      };
    }

    if (this.traceMode) {
      const smp = this._traceSampleForMobile(m, nowMs);
      if (smp) {
        lat = smp.lat;
        lon = smp.lon;
        angle = smp.angle;
        flipX = !!smp.flipX;
        speedMps = Number(smp.speedMps) || 0;
        opacity = (typeof smp.opacity === "number" && isFinite(smp.opacity)) ? smp.opacity : 1;
      }
      return { lat, lon, angle, flipX, speedMps, opacity };
    }

    const id = (m && m.id != null) ? String(m.id) : "";
    const pin = id ? this._persistedTrailById.get(id)?.pin : null;
    if (pin && isFinite(Number(pin.lat)) && isFinite(Number(pin.lon))) {
      lat = Number(pin.lat);
      lon = Number(pin.lon);
    }

    return { lat, lon, angle, flipX, speedMps, opacity };
  }

  zoomBy(delta) {
    // User interaction: immediate zoom (no easing).
    const target = clamp(Math.round(this.zoom) + delta, this._zoomMin, this._zoomMax);
    this.zoom = target;
    // Invalidate snapshot when zoom jumps (prevents “tunnel” feel).
    this._tilesSnapshotCanvas = null;
    this._tilesSnapshotMeta = null;
    this.draw(this.lastState);
    this._notifyViewChanged();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const parent = this.tilesCanvas.parentElement;
    // Use clientWidth/clientHeight (integers) - more stable than getBoundingClientRect
    const w = Math.max(1, parent.clientWidth);
    const h = Math.max(1, parent.clientHeight);

    // Guard: skip if nothing changed (prevents feedback loops)
    if (w === this._cssW && h === this._cssH && dpr === this._dpr) return;

    this._dpr = dpr;
    this._cssW = w;
    this._cssH = h;

    // Set internal canvas dimensions
    this.tilesCanvas.width = Math.floor(w * dpr);
    this.tilesCanvas.height = Math.floor(h * dpr);
    this.overlayCanvas.width = Math.floor(w * dpr);
    this.overlayCanvas.height = Math.floor(h * dpr);

    // Set explicit CSS pixel dimensions - critical for iOS PWA standalone mode
    // where percentage-based sizing can be calculated incorrectly
    this.tilesCanvas.style.width = w + 'px';
    this.tilesCanvas.style.height = h + 'px';
    this.overlayCanvas.style.width = w + 'px';
    this.overlayCanvas.style.height = h + 'px';

    this.tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.octx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Snapshot is tied to canvas size; reset on resize to avoid distortion.
    this._tilesSnapshotCanvas = null;
    this._tilesSnapshotMeta = null;
    this._invalidateOverlayStatic();
    // Invalidate trail cache on resize
    this._trailCacheCanvas = null;
    this._trailCacheKey = "";

    this.draw(this.lastState);
  }


  onWheel(e) {
    // macOS trackpad:
    // - two-finger drag -> wheel deltaX/deltaY (pan)
    // - pinch-to-zoom -> wheel with ctrlKey=true (zoom)
    e.preventDefault();

    this._noteUserInteraction();

    // IMPORTANT: user request: no mouse-wheel zoom and no “ctrl held to zoom”.
    // In browsers on macOS, *trackpad pinch* typically arrives as wheel events with ctrlKey=true
    // and deltaMode=0 (pixel scrolling). We treat ONLY that combination as pinch-zoom.
    const isLikelyTrackpadPinch = (e.ctrlKey === true && e.deltaMode === 0);
    if (isLikelyTrackpadPinch) {
      // If Safari gesture events are in play, ignore wheel-based pinch.
      if (this._gesture) return;
      // reset inertia timer; start it shortly after the last wheel-pinch event
      if (this._wheelPinchEndTimer) window.clearTimeout(this._wheelPinchEndTimer);
      this._pinchZooming = true;
      const rect = this.overlayCanvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      // Create / refresh anchor so zoom occurs “where the cursor is”.
      const now = performance.now();
      if (!this._pinchAnchor || (now - this._pinchAnchor.lastTs) > 180) {
        const ll = this._screenPointToLatLon(sx, sy);
        this._pinchAnchor = { lat: ll.lat, lon: ll.lon, sx, sy, lastTs: now };
      } else {
        this._pinchAnchor.sx = sx;
        this._pinchAnchor.sy = sy;
        this._pinchAnchor.lastTs = now;
      }

      // Fallback pinch zoom (Chrome/Firefox): wheel+ctrlKey.
      // Keep it minimal and direct (no custom inertia).
      const dy = clamp(e.deltaY, -400, 400);
      const dir = dy < 0 ? 1 : -1; // dy<0 means "zoom in" on most macOS trackpads
      const strength = 0.020; // slightly faster for wheel-based pinch
      const dz = dir * Math.log1p(Math.abs(dy)) * strength;
      const prevZ = this.zoom;
      const z2 = clamp(this.zoom + dz, this._zoomMin, this._zoomMax);
      this._setZoomAroundScreenPoint(z2, sx, sy);

      this._requestZoomRedraw();
      this._notifyViewChanged();
      this._pinchAnchorSX = sx;
      this._pinchAnchorSY = sy;
      this._notePinchVelocity(z2 - prevZ, performance.now());
      // Start inertia shortly after the pinch stream stops; keep the gap small to avoid a hitch.
      this._wheelPinchEndTimer = window.setTimeout(() => this._startPinchInertia(), 28);
      return;
    }

    // User interaction: immediate two-finger pan (no inertial smoothing).
    const scale = 0.65;
    const c = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
    const nx = c.x + e.deltaX * scale;
    const ny = clamp(c.y + e.deltaY * scale, 0, c.ws - 1);
    const ll = worldToLatLon(nx, ny, this.zoom);
    this.center = { lat: ll.lat, lon: ll.lon };
    this._requestPanRedraw();
  }

  onClick(e) {
    // Click empty map to deselect
    const st = this.lastState;
    const mobiles = st && Array.isArray(st.mobile) ? st.mobile : [];
    const fixed = st && Array.isArray(st.fixed) ? st.fixed : [];
    const rect = this.overlayCanvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    // Ignore click if it was part of a drag gesture.
    if (this._mouseDragMoved) {
      this._mouseDragMoved = false;
      return;
    }

    // hit test markers (emoji halo radius ~18), mobile + fixed
    let hit = null;
    const candidates = [
      ...mobiles.map(m => ({ type: "mobile", ...m })),
      ...fixed.map(f => ({ type: "fixed", ...f })),
    ];
    for (const m of candidates) {
      let lat = Number(m.lat), lon = Number(m.lon);
      if (m.type === "mobile") {
        const pose = this._mobilePoseForRender(m, performance.now());
        lat = pose.lat;
        lon = pose.lon;
      }
      if (!isFinite(lat) || !isFinite(lon)) continue;
      const wpt = latLonToWorld(lat, lon, this.zoom);
      const sp = this.worldToScreen(wpt.x, wpt.y);
      const dx = sp.x - sx;
      const dy = sp.y - sy;
      if ((dx*dx + dy*dy) <= (20*20)) {
        hit = keyFor(m.type, m.id);
        break;
      }
    }
    if (hit) {
      if (window.__selectSensor) window.__selectSensor(hit, { fitTrail: !!e.metaKey });
      return;
    }

    this.setSelected(null);
    if (window.__selectSensor) window.__selectSensor(null);
  }

  worldToScreen(wx, wy) {
    const w = this._cssW || 1;
    const h = this._cssH || 1;
    const c = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
    return { x: wx - c.x + w / 2, y: wy - c.y + h / 2 };
  }

  draw(state) {
    this.lastState = state;

    // Update the data-time clock from the newest trail timestamp we can see.
    // Use only the last point of each trail for efficiency.
    // Also detect if we have TRX vehicles (for track edge fetching)
    try {
      const mobiles = Array.isArray(state?.mobile) ? state.mobile : [];
      let maxT = null;
      let hasTrx = false;
      for (const m of mobiles) {
        const id = m?.id ? String(m.id).toUpperCase() : "";
        if (id.startsWith("TRX") || id.startsWith("TRAX")) hasTrx = true;
        
        const tr = Array.isArray(m?.trail) ? m.trail : null;
        if (!tr || tr.length < 1) continue;
        const last = tr[tr.length - 1];
        const tStr = (last && typeof last.t === "string") ? last.t : null;
        if (!tStr) continue;
        const tMs = parseUtcMs(tStr);
        if (tMs != null && isFinite(tMs)) maxT = (maxT == null) ? tMs : Math.max(maxT, tMs);
      }
      if (maxT != null && isFinite(maxT)) {
        this._dataNowBaseMs = maxT;
        this._dataNowBasePerfMs = performance.now();
      }
      this._hasTrxVehicles = hasTrx;
      // Fetch tram track edges for curve rendering when TRX vehicles present
      if (hasTrx) this._fetchTramLineEdgesForViewport();
    } catch {
      // ignore
    }

    this._prunePerMobileCachesForState(state);
    this._updatePersistedTrails(state);
    this._invalidateOverlayStatic();
    
    // In playback mode, ensure playback points are refreshed with new state data
    if (this.playbackMode) {
      this._ensurePlaybackPoints(state);
    }
    
    // Optimization: state polling updates trails/markers, but the basemap is tied only
    // to view (center/zoom/theme/size). Avoid redrawing tiles unless the view changed.
    const viewSig = (() => {
      const z = Number(this.zoom);
      const lat = Number(this.center?.lat);
      const lon = Number(this.center?.lon);
      const w = Number(this._cssW);
      const h = Number(this._cssH);
      const dpr = Number(this._dpr || (window.devicePixelRatio || 1));
      // Round to reduce float churn without affecting visual correctness.
      const r = (x, p = 1e6) => (isFinite(x) ? (Math.round(x * p) / p) : x);
      return `${this.themeKey}|${r(z, 1e3)}|${r(lat)}|${r(lon)}|${w}x${h}|dpr:${r(dpr, 1e3)}|pinch:${this._pinchZooming ? 1 : 0}`;
    })();

    if (this._lastTilesViewSig !== viewSig) {
      this._lastTilesViewSig = viewSig;
      this.drawTiles();
    }
    this.drawOverlay(state, { cacheUnderlay: true });
  }

  _prunePerMobileCachesForState(state) {
    // If a mobile disappears from the server payload, drop all cached state for it.
    // This prevents stale routes/pins/trails from being reused if it later returns.
    const mobiles = Array.isArray(state?.mobile) ? state.mobile : [];
    const present = new Set();
    for (const m of mobiles) {
      const id = (m && m.id != null) ? String(m.id) : "";
      if (id) present.add(id);
    }

    const pruneMap = (mp) => {
      if (!mp || typeof mp.entries !== "function") return false;
      let removed = false;
      for (const [id] of mp.entries()) {
        const sid = (id != null) ? String(id) : "";
        if (!sid || present.has(sid)) continue;
        mp.delete(id);
        removed = true;
      }
      return removed;
    };

    let removedAny = false;
    removedAny = pruneMap(this._persistedTrailById) || removedAny;
    removedAny = pruneMap(this._tracePtsById) || removedAny;
    removedAny = pruneMap(this._traceLastSideById) || removedAny;
    removedAny = pruneMap(this._traceActiveRouteById) || removedAny;
    removedAny = pruneMap(this._tracePendingRouteById) || removedAny;
    removedAny = pruneMap(this._traceCycleStartMsById) || removedAny;
    removedAny = pruneMap(this._traceInitialRunDoneById) || removedAny;
    removedAny = pruneMap(this._traceAngleById) || removedAny;
    removedAny = pruneMap(this._traceAngleLastMsById) || removedAny;

    if (removedAny) {
      this._persistedTrailRev++;
      this._invalidateOverlayStatic();
    }
  }

  _getPersistedTrailEntry(id) {
    if (!id) return null;
    return this._persistedTrailById.get(String(id)) || null;
  }

  _updatePersistedTrails(state) {
    const mobiles = Array.isArray(state?.mobile) ? state.mobile : [];
    let changed = false;
    const nowMs = performance.now();

    // User request: STOP using arbitrary radius/distance gating for trail persistence.
    // Keep all server-provided points and avoid distance-based "stationary" pin heuristics.
    const DISABLE_DISTANCE_BASED_TRAIL_FILTERS = true;
    const dedupMeters = DISABLE_DISTANCE_BASED_TRAIL_FILTERS ? 0 : 2.0;

    // Online simplification to avoid unbounded point growth from GPS jitter.
    // Keeps the visual path but collapses near-collinear samples.
    const collapseMeters = DISABLE_DISTANCE_BASED_TRAIL_FILTERS ? 0 : 1.6;
    const metersPerDegLat = 111320;
    const perpDistMeters = (a, b, c) => {
      // Distance from b to segment a-c in meters using equirectangular approx.
      const lat0 = Number(a?.lat);
      const lon0 = Number(a?.lon);
      const cl = Math.cos((lat0 * Math.PI) / 180) || 1;
      const ax = 0, ay = 0;
      const bx = (Number(b?.lon) - lon0) * metersPerDegLat * cl;
      const by = (Number(b?.lat) - lat0) * metersPerDegLat;
      const cx = (Number(c?.lon) - lon0) * metersPerDegLat * cl;
      const cy = (Number(c?.lat) - lat0) * metersPerDegLat;
      const abx = bx - ax, aby = by - ay;
      const acx = cx - ax, acy = cy - ay;
      const ac2 = (acx * acx) + (acy * acy);
      if (!(ac2 > 1e-6)) return Infinity;
      // project AB onto AC, clamp to segment.
      let t = ((abx * acx) + (aby * acy)) / ac2;
      t = Math.max(0, Math.min(1, t));
      const px = ax + acx * t;
      const py = ay + acy * t;
      const dx = bx - px;
      const dy = by - py;
      return Math.hypot(dx, dy);
    };

    const lastFinitePoint = (arr) => {
      if (!Array.isArray(arr) || !arr.length) return null;
      for (let i = arr.length - 1; i >= 0; i--) {
        const p = arr[i];
        const lat = Number(p?.lat);
        const lon = Number(p?.lon);
        if (isFinite(lat) && isFinite(lon)) return { lat, lon, t: p?.t };
      }
      return null;
    };

    const shouldAppend = (last, next) => {
      if (!last) return true;
      const lat = Number(next?.lat);
      const lon = Number(next?.lon);
      if (!isFinite(lat) || !isFinite(lon)) return false;
      if (!(dedupMeters > 0)) return true;
      const d = haversineMeters(last.lat, last.lon, lat, lon);
      return (d > dedupMeters);
    };

    const parseTms = (t) => (typeof t === "string") ? parseUtcMs(t) : null;

    const isEffectivelyStationary = (trail, opts) => {
      if (DISABLE_DISTANCE_BASED_TRAIL_FILTERS) return false;
      if (!Array.isArray(trail) || trail.length < 8) return false;
      const tailN = Math.max(8, Math.min(30, Number(opts?.tailN ?? 22)));
      const maxRadiusM = Number(opts?.maxRadiusM ?? 30);
      const maxNetM = Number(opts?.maxNetM ?? 20);
      const minSpanMs = Number(opts?.minSpanMs ?? 60_000);
      if (!(maxRadiusM > 0) || !(maxNetM > 0) || !(tailN > 0)) return false;

      const tail = trail.slice(Math.max(0, trail.length - tailN));
      const lats = [];
      const lons = [];
      for (const p of tail) {
        const lat = Number(p?.lat);
        const lon = Number(p?.lon);
        if (!isFinite(lat) || !isFinite(lon)) continue;
        lats.push(lat);
        lons.push(lon);
      }
      if (lats.length < 6) return false;

      const median = (nums) => {
        const a = nums.slice().sort((x, y) => x - y);
        const mid = Math.floor(a.length / 2);
        return (a.length % 2) ? a[mid] : 0.5 * (a[mid - 1] + a[mid]);
      };
      const latM = median(lats);
      const lonM = median(lons);
      if (!isFinite(latM) || !isFinite(lonM)) return false;

      let maxR = 0;
      for (const p of tail) {
        const lat = Number(p?.lat);
        const lon = Number(p?.lon);
        if (!isFinite(lat) || !isFinite(lon)) continue;
        const d = haversineMeters(latM, lonM, lat, lon);
        if (isFinite(d)) maxR = Math.max(maxR, d);
      }

      const first = lastFinitePoint(tail.slice(0, 1)) || lastFinitePoint(tail);
      const last = lastFinitePoint(tail);
      if (!first || !last) return false;
      const net = haversineMeters(first.lat, first.lon, last.lat, last.lon);

      const t0 = parseTms(tail[0]?.t);
      const t1 = parseTms(tail[tail.length - 1]?.t);
      const spanOk = (t0 != null && t1 != null) ? ((t1 - t0) >= minSpanMs) : (tail.length >= 16);

      return spanOk && (maxR <= maxRadiusM) && (net <= maxNetM);
    };

    // When a bus is parked, GPS jitter accumulates into a "birds nest".
    // Fix by compressing the *entire stationary suffix* into a single stable point.
    // This preserves the approach/arrival path (everything before the stop) and
    // keeps depots/stations working: as soon as the bus truly leaves the radius,
    // the suffix stops being stationary and we stop compressing.
    const collapseParkedSuffix = (trail, opts) => {
      if (!Array.isArray(trail) || trail.length < 12) return false;
      const tailN = Math.max(10, Math.min(40, Number(opts?.tailN ?? 24)));
      const radiusM = Number(opts?.radiusM ?? 38);
      const minPts = Number(opts?.minPts ?? 14);
      const minSpanMs = Number(opts?.minSpanMs ?? 120_000);
      const maxScan = Number(opts?.maxScan ?? 5000);
      const maxTravelM = Number(opts?.maxTravelM ?? 140);
      if (!(radiusM > 0) || !(minPts >= 6) || !(maxScan >= 100) || !(maxTravelM > 0)) return false;

      const median = (nums) => {
        if (!nums.length) return NaN;
        const a = nums.slice().sort((x, y) => x - y);
        const mid = Math.floor(a.length / 2);
        return (a.length % 2) ? a[mid] : 0.5 * (a[mid - 1] + a[mid]);
      };

      // 1) Compute a robust center from the most recent tail.
      const tail = trail.slice(Math.max(0, trail.length - tailN));
      const lats = [];
      const lons = [];
      for (const p of tail) {
        const lat = Number(p?.lat);
        const lon = Number(p?.lon);
        if (!isFinite(lat) || !isFinite(lon)) continue;
        lats.push(lat);
        lons.push(lon);
      }
      if (lats.length < 8) return false;
      const centerLat = median(lats);
      const centerLon = median(lons);
      if (!isFinite(centerLat) || !isFinite(centerLon)) return false;

      // 2) Walk backwards while points remain within radius of the center.
      const start = Math.max(0, trail.length - maxScan);
      let i0 = trail.length - 1;
      while (i0 - 1 >= start) {
        const p = trail[i0 - 1];
        const lat = Number(p?.lat);
        const lon = Number(p?.lon);
        if (!isFinite(lat) || !isFinite(lon)) break;
        const d = haversineMeters(centerLat, centerLon, lat, lon);
        if (!(isFinite(d) && d <= radiusM)) break;
        i0--;
      }

      const suffixLen = trail.length - i0;
      if (suffixLen < minPts) return false;

      // 3) Check time span and "actually parked" by path length.
      const t0 = parseTms(trail[i0]?.t);
      const t1 = parseTms(trail[trail.length - 1]?.t);
      if (t0 != null && t1 != null && (t1 - t0) < minSpanMs) return false;

      let travel = 0;
      for (let k = i0 + 1; k < trail.length; k++) {
        const a = trail[k - 1];
        const b = trail[k];
        const d = haversineMeters(Number(a?.lat), Number(a?.lon), Number(b?.lat), Number(b?.lon));
        if (isFinite(d)) travel += d;
        if (travel > maxTravelM) return false; // moving around, don't collapse
      }

      // 4) Collapse the suffix to two points: entry + stable parked point.
      // Keep the entry point (trail[i0]) so the arrival path still connects.
      const last = trail[trail.length - 1];
      const rep = {
        lat: centerLat,
        lon: centerLon,
        t: (last && typeof last.t === "string") ? last.t : undefined,
        readings: (last && last.readings && typeof last.readings === "object") ? last.readings : undefined,
      };

      // Replace points after the entry with the representative.
      const deleteCount = trail.length - (i0 + 1);
      if (deleteCount <= 1) {
        // Nothing substantial to collapse.
        return false;
      }
      trail.splice(i0 + 1, deleteCount, rep);
      return true;
    };

    // Remove short out-and-back GPS spikes from an otherwise stationary cluster.
    // Pattern:
    // - A -> B far away
    // - B -> C far away
    // - A -> C close (returned)
    // Optionally handles a 2-point excursion (A -> B -> C -> D where A~D and B~C).
    const scrubReturnSpikes = (trail, opts) => {
      if (!Array.isArray(trail) || trail.length < 4) return false;
      const outM = Number(opts?.outM ?? 45);
      const retM = Number(opts?.retM ?? 18);
      const plateauM = Number(opts?.plateauM ?? 25);
      const maxSpanMs = Number(opts?.maxSpanMs ?? 180_000);
      const maxScan = Number(opts?.maxScan ?? 1200);
      if (!(outM > 0) || !(retM > 0) || !(plateauM > 0) || !(maxSpanMs >= 0) || !(maxScan >= 20)) return false;

      const n0 = trail.length;
      const start = Math.max(1, n0 - maxScan);
      let changedLocal = false;

      const tmsAt = (idx) => {
        const t = trail[idx]?.t;
        const ms = parseTms(t);
        return (ms != null && isFinite(ms)) ? ms : null;
      };

      // First pass: single-point excursion A-B-C.
      for (let i = start; i < trail.length - 1; i++) {
        const a = trail[i - 1];
        const b = trail[i];
        const c = trail[i + 1];
        if (!a || !b || !c) continue;
        const dAB = haversineMeters(Number(a.lat), Number(a.lon), Number(b.lat), Number(b.lon));
        const dBC = haversineMeters(Number(b.lat), Number(b.lon), Number(c.lat), Number(c.lon));
        const dAC = haversineMeters(Number(a.lat), Number(a.lon), Number(c.lat), Number(c.lon));
        if (!(isFinite(dAB) && isFinite(dBC) && isFinite(dAC))) continue;

        if (dAB >= outM && dBC >= outM && dAC <= retM) {
          const ta = tmsAt(i - 1);
          const tc = tmsAt(i + 1);
          if (ta != null && tc != null && (tc - ta) > maxSpanMs) continue;
          trail.splice(i, 1);
          changedLocal = true;
          i = Math.max(start, i - 2);
        }
      }

      // Second pass: two-point excursion A-B-C-D.
      for (let i = start; i < trail.length - 2; i++) {
        const a = trail[i - 1];
        const b = trail[i];
        const c = trail[i + 1];
        const d = trail[i + 2];
        if (!a || !b || !c || !d) continue;
        const dAB = haversineMeters(Number(a.lat), Number(a.lon), Number(b.lat), Number(b.lon));
        const dBC = haversineMeters(Number(b.lat), Number(b.lon), Number(c.lat), Number(c.lon));
        const dCD = haversineMeters(Number(c.lat), Number(c.lon), Number(d.lat), Number(d.lon));
        const dAD = haversineMeters(Number(a.lat), Number(a.lon), Number(d.lat), Number(d.lon));
        if (!(isFinite(dAB) && isFinite(dBC) && isFinite(dCD) && isFinite(dAD))) continue;

        if (dAB >= outM && dCD >= outM && dAD <= retM && dBC <= plateauM) {
          const ta = tmsAt(i - 1);
          const td = tmsAt(i + 2);
          if (ta != null && td != null && (td - ta) > maxSpanMs) continue;
          trail.splice(i, 2);
          changedLocal = true;
          i = Math.max(start, i - 2);
        }
      }

      return changedLocal;
    };

    // Collapse stationary GPS jitter into a single stable point.
    // This fixes the "birds nest" when a bus is parked but GPS jitters.
    // It is per-bus and purely motion-based (so depots/stations are fine:
    // buses that truly leave will immediately exceed the radius and keep paths).
    const collapseStationaryClusters = (trail, opts) => {
      if (!Array.isArray(trail) || trail.length < 6) return false;
      const radiusM = Number(opts?.radiusM ?? 22);
      const minPts = Number(opts?.minPts ?? 10);
      const minSpanMs = Number(opts?.minSpanMs ?? 90_000);
      const maxScan = Number(opts?.maxScan ?? 1800);
      if (!(radiusM > 0) || !(minPts >= 3) || !(minSpanMs >= 0) || !(maxScan >= 50)) return false;

      const n = trail.length;
      const start = Math.max(0, n - maxScan);
      let changedLocal = false;

      const median = (nums) => {
        if (!nums.length) return NaN;
        const a = nums.slice().sort((x, y) => x - y);
        const mid = Math.floor(a.length / 2);
        return (a.length % 2) ? a[mid] : 0.5 * (a[mid - 1] + a[mid]);
      };

      const collapseRange = (i0, i1) => {
        // Collapse [i0, i1] inclusive into a single point placed at median(lat/lon).
        // Keep the latest timestamp/readings so the UI still reflects fresh data.
        const pts = trail.slice(i0, i1 + 1);
        const lats = [];
        const lons = [];
        for (const p of pts) {
          const lat = Number(p?.lat);
          const lon = Number(p?.lon);
          if (!isFinite(lat) || !isFinite(lon)) continue;
          lats.push(lat);
          lons.push(lon);
        }
        if (lats.length < 2) return false;
        const latM = median(lats);
        const lonM = median(lons);
        if (!isFinite(latM) || !isFinite(lonM)) return false;

        const last = pts[pts.length - 1];
        const rep = {
          lat: latM,
          lon: lonM,
          t: (last && typeof last.t === "string") ? last.t : undefined,
          readings: (last && last.readings && typeof last.readings === "object") ? last.readings : undefined,
        };
        trail.splice(i0, (i1 - i0 + 1), rep);
        return true;
      };

      // Scan for runs that stay within radius of their first point.
      // Any long-enough run is considered a stationary cluster.
      let i = start;
      while (i < trail.length - 1) {
        const p0 = trail[i];
        const lat0 = Number(p0?.lat);
        const lon0 = Number(p0?.lon);
        if (!isFinite(lat0) || !isFinite(lon0)) {
          i++;
          continue;
        }

        let j = i;
        let t0 = parseTms(p0?.t);
        let t1 = t0;
        while (j + 1 < trail.length) {
          const pj = trail[j + 1];
          const lat = Number(pj?.lat);
          const lon = Number(pj?.lon);
          if (!isFinite(lat) || !isFinite(lon)) break;
          const d = haversineMeters(lat0, lon0, lat, lon);
          if (!(d <= radiusM)) break;
          j++;
          const tj = parseTms(pj?.t);
          if (tj != null) t1 = tj;
        }

        const runLen = j - i + 1;
        const spanOk = (t0 != null && t1 != null) ? ((t1 - t0) >= minSpanMs) : (runLen >= (minPts * 2));
        if (runLen >= minPts && spanOk) {
          if (collapseRange(i, j)) {
            changedLocal = true;
            // After collapsing, continue from the collapsed point.
            i = Math.max(start, i - 1);
            continue;
          }
        }

        i = j + 1;
      }

      return changedLocal;
    };

    const mergeByTimestamp = (existingTrail, incomingTrail) => {
      // Append only points newer than our last timestamp (keeps growth even if server window is small).
      // If timestamps are missing/unparseable, we fall back to distance-based dedup.
      if (!Array.isArray(incomingTrail) || !incomingTrail.length) return false;
      if (!Array.isArray(existingTrail)) existingTrail = [];

      const last = lastFinitePoint(existingTrail);
      let cutoffTms = last && last.t ? parseTms(last.t) : null;
      let appended = 0;

      for (const p of incomingTrail) {
        const lat = Number(p?.lat);
        const lon = Number(p?.lon);
        if (!isFinite(lat) || !isFinite(lon)) continue;
        const tms = p?.t ? parseTms(p.t) : null;

        if (cutoffTms != null && tms != null) {
          if (tms <= cutoffTms) continue;
          existingTrail.push(p);
          appended++;
          cutoffTms = tms;
          continue;
        }

        const last2 = lastFinitePoint(existingTrail);
        if (!shouldAppend(last2, p)) continue;
        existingTrail.push(p);
        appended++;
      }

      return appended;
    };

    const tailMedianLatLon = (trail, tailN) => {
      if (!Array.isArray(trail) || !trail.length) return null;

      const median = (nums) => {
        if (!nums.length) return NaN;
        const a = nums.slice().sort((x, y) => x - y);
        const mid = Math.floor(a.length / 2);
        return (a.length % 2) ? a[mid] : 0.5 * (a[mid - 1] + a[mid]);
      };

      const n = Math.max(6, Math.min(60, Number(tailN || 24)));
      const tail = trail.slice(Math.max(0, trail.length - n));
      const lats = [];
      const lons = [];
      for (const p of tail) {
        const lat = Number(p?.lat);
        const lon = Number(p?.lon);
        if (!isFinite(lat) || !isFinite(lon)) continue;
        lats.push(lat);
        lons.push(lon);
      }
      if (lats.length < 6) return null;
      const latM = median(lats);
      const lonM = median(lons);
      if (!isFinite(latM) || !isFinite(lonM)) return null;
      return { lat: latM, lon: lonM };
    };

    const clearPerId = (id) => {
      const sid = (id != null) ? String(id) : "";
      if (!sid) return false;
      let any = false;
      const del = (mp) => {
        if (mp && typeof mp.delete === "function") {
          const had = mp.has ? mp.has(sid) : true;
          mp.delete(sid);
          return !!had;
        }
        return false;
      };

      any = del(this._persistedTrailById) || any;
      any = del(this._tracePtsById) || any;
      any = del(this._traceLastSideById) || any;
      any = del(this._traceActiveRouteById) || any;
      any = del(this._tracePendingRouteById) || any;
      any = del(this._traceCycleStartMsById) || any;
      any = del(this._traceInitialRunDoneById) || any;
      any = del(this._traceAngleById) || any;
      any = del(this._traceAngleLastMsById) || any;
      any = del(this._traceSelectionWarpById) || any;
      return any;
    };

    for (const m of mobiles) {
      const id = (m && m.id != null) ? String(m.id) : "";
      if (!id) continue;

      const serverTrail = Array.isArray(m?.trail) ? m.trail : [];
      const prev = this._persistedTrailById.get(id) || { trail: [], color: null, ghosted: false, parked: false, pin: null };

      // Trails now persist at the data level (server-side).
      // If the server trail is empty and we have no previous trail, skip.
      if (serverTrail.length < 2 && !prev.trail.length) {
        continue;
      }

      // Trust the server's trail directly for the historical record.
      const lastServerT = serverTrail.length ? serverTrail[serverTrail.length - 1]?.t : null;
      const lastPrevT = prev.trail.length ? prev.trail[prev.trail.length - 1]?.t : null;
      const serverGrew = (serverTrail.length > prev.trail.length) || (lastServerT !== lastPrevT && lastServerT !== null);

      let nextTrail = serverTrail;
      if (nextTrail.length > this.maxTrailLen) {
        nextTrail = nextTrail.slice(-this.maxTrailLen);
      }
      const appendedCount = serverGrew ? Math.max(1, nextTrail.length - prev.trail.length) : 0;

      // Parked marker debounce (existing logic, simplified).
      const prevPin = prev && prev.pin && isFinite(Number(prev.pin.lat)) && isFinite(Number(prev.pin.lon))
        ? { lat: Number(prev.pin.lat), lon: Number(prev.pin.lon) }
        : null;
      let nextPin = prevPin;
      const prevGhosted = !!prev?.ghosted;
      const nextGhosted = !!m?.ghosted;
      const prevParked = !!prev?.parked;
      const nextParked = !!m?.parked;

      // Pins are used only for the parked display (not for offline sensors).
      nextPin = null;
      if (!nextGhosted) {
        if (nextParked) {
          nextPin = tailMedianLatLon(nextTrail, 24);
        } else {
          // Fallback: if server doesn't provide parked, use a strict parked heuristic.
          const stationary = isEffectivelyStationary(nextTrail, { tailN: 28, maxRadiusM: 42, maxNetM: 30, minSpanMs: 900_000 });
          if (stationary) nextPin = tailMedianLatLon(nextTrail, 24);
        }
      }

      const pinChanged = (Boolean(prevPin) !== Boolean(nextPin))
        || (prevPin && nextPin && (haversineMeters(prevPin.lat, prevPin.lon, nextPin.lat, nextPin.lon) > 1.0));

      const nextColor = safeHex(m.color);
      const metaChanged = (prev.color !== nextColor) || (prev.ghosted !== nextGhosted) || (prevParked !== nextParked);

      if (appendedCount > 0 || metaChanged || pinChanged) {
        this._persistedTrailById.set(id, { trail: nextTrail, color: nextColor, ghosted: nextGhosted, parked: nextParked, pin: nextPin });
        changed = true;
      }
    }

    if (changed) {
      this._persistedTrailRev++;
    }
  }

  drawTiles() {
    const ctx = this.tctx;
    if (!ctx) return;
    // Avoid per-frame layout reads during panning.
    const w = this._cssW || 1;
    const h = this._cssH || 1;
    const dpr = this._dpr || (window.devicePixelRatio || 1);

    const c = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
    const ws = c.ws;

    // Backdrop: reuse previous frame so *panning* doesn't flicker while tiles stream in.
    // During active pinch/inertia we also reuse+scale the snapshot (fast path) so zooming
    // is closer to the OS-native feel and doesn't spend time drawing N tiles every event.
    const hasSnapshot = !!(this._tilesSnapshotCanvas && this._tilesSnapshotMeta);
    ctx.clearRect(0, 0, w, h);
    if (hasSnapshot) {
      try {
        const prev = this._tilesSnapshotMeta;
        ctx.save();
        if (this._pinchZooming) {
          // Scale around the screen center; also translate for center changes.
          const sZoom = Math.pow(2, this.zoom - prev.zoom);
          const prevC = latLonToWorld(prev.centerLat, prev.centerLon, prev.zoom);
          const currC = latLonToWorld(this.center.lat, this.center.lon, prev.zoom);
          const txPan = (prevC.x - currC.x) * sZoom;
          const tyPan = (prevC.y - currC.y) * sZoom;
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.translate(w / 2, h / 2);
          ctx.scale(sZoom, sZoom);
          ctx.translate((-w / 2) + (txPan / sZoom), (-h / 2) + (tyPan / sZoom));
          ctx.drawImage(this._tilesSnapshotCanvas, 0, 0, w, h);
          ctx.restore();
          // Fast path: don't draw individual tiles while pinch-zooming. We'll do a full tiles
          // render once the gesture/inertia completes.
          return;
        }

        // Non-pinch: translate-only (same integer zoom snapshots).
        if (Math.floor(prev.zoom) !== Math.floor(this.zoom)) throw new Error("zoom changed");
        const prevC = latLonToWorld(prev.centerLat, prev.centerLon, prev.zoom);
        const currC = latLonToWorld(this.center.lat, this.center.lon, prev.zoom);
        const tx = (prevC.x - currC.x);
        const ty = (prevC.y - currC.y);
        ctx.setTransform(dpr, 0, 0, dpr, dpr * tx, dpr * ty);
        ctx.drawImage(this._tilesSnapshotCanvas, 0, 0, w, h);
        ctx.restore();
      } catch {
        // ignore snapshot issues
      }
    }

    const topLeftX = c.x - w / 2;
    const topLeftY = c.y - h / 2;

    // Use integer tile zoom for fetching, scaled to fractional zoom.
    const tileZ = clamp(Math.floor(this.zoom), this._zoomMin, this._zoomMax);
    const s = Math.pow(2, this.zoom - tileZ); // scale factor from tileZ world to zoom world

    const topLeftX_Z = topLeftX / s;
    const topLeftY_Z = topLeftY / s;
    const w_Z = w / s;
    const h_Z = h / s;

    const minTileX = Math.floor(topLeftX_Z / TILE_SIZE);
    const minTileY = Math.floor(topLeftY_Z / TILE_SIZE);
    const maxTileX = Math.floor((topLeftX_Z + w_Z) / TILE_SIZE);
    const maxTileY = Math.floor((topLeftY_Z + h_Z) / TILE_SIZE);

    const tilesPerAxis = Math.pow(2, tileZ);
    for (let ty = minTileY; ty <= maxTileY; ty++) {
      if (ty < 0 || ty >= tilesPerAxis) continue;
      for (let tx = minTileX; tx <= maxTileX; tx++) {
        // wrap X
        let wrappedX = tx;
        while (wrappedX < 0) wrappedX += tilesPerAxis;
        while (wrappedX >= tilesPerAxis) wrappedX -= tilesPerAxis;

        // IMPORTANT: key includes theme to prevent "checkerboard" mixing when switching themes.
        const key = `${this.themeKey}:${tileZ}/${wrappedX}/${ty}`;
        const px = (tx * TILE_SIZE * s) - topLeftX;
        const py = (ty * TILE_SIZE * s) - topLeftY;

        this.drawTile(ctx, key, tileZ, wrappedX, ty, px, py, s, hasSnapshot);
      }
    }

    // No vignette: it reads like a “tunnel/bokeh” during zooming.

    // Capture snapshot for the next frame - but skip during active touch to avoid blocking input.
    // Also avoid resizing the snapshot canvas every frame (causes GPU texture reallocation).
    if (!this._touchActive) {
      try {
        const tw = this.tilesCanvas.width;
        const th = this.tilesCanvas.height;
        if (!this._tilesSnapshotCanvas) {
          this._tilesSnapshotCanvas = document.createElement("canvas");
          this._tilesSnapshotCanvas.width = tw;
          this._tilesSnapshotCanvas.height = th;
        } else if (this._tilesSnapshotCanvas.width !== tw || this._tilesSnapshotCanvas.height !== th) {
          // Only resize when dimensions actually change
          this._tilesSnapshotCanvas.width = tw;
          this._tilesSnapshotCanvas.height = th;
        }
        const sctx = this._tilesSnapshotCanvas.getContext("2d");
        if (sctx) {
          sctx.setTransform(1, 0, 0, 1, 0, 0);
          sctx.clearRect(0, 0, tw, th);
          sctx.drawImage(this.tilesCanvas, 0, 0);
          this._tilesSnapshotMeta = { zoom: this.zoom, centerLat: this.center.lat, centerLon: this.center.lon };
        }
      } catch {
        // ignore snapshot capture errors
      }
    }
  }

  _tileCacheGet(key) {
    if (!this.tileCache || !key) return null;
    const v = this.tileCache.get(key) || null;
    if (!v) return null;
    // LRU: refresh insertion order.
    this.tileCache.delete(key);
    this.tileCache.set(key, v);
    return v;
  }

  _tileCacheSet(key, value) {
    if (!this.tileCache || !key) return;
    if (this.tileCache.has(key)) this.tileCache.delete(key);
    this.tileCache.set(key, value);
    const max = (typeof this._tileCacheMax === "number" && isFinite(this._tileCacheMax) && this._tileCacheMax > 0)
      ? Math.floor(this._tileCacheMax)
      : 420;
    while (this.tileCache.size > max) {
      const oldestKey = this.tileCache.keys().next().value;
      if (oldestKey == null) break;
      this.tileCache.delete(oldestKey);
    }
  }

  drawTile(ctx, key, z, x, y, px, py, scale, hasSnapshot) {
    const cached = this._tileCacheGet(key);
    if (cached && cached.ok) {
      const sz = TILE_SIZE * scale;
      // Ensure canvas state isn't applying any accidental filter/desaturation.
      ctx.filter = "none";
      ctx.drawImage(cached.img, Math.floor(px), Math.floor(py), Math.ceil(sz), Math.ceil(sz));
      return;
    }

    if (!cached) {
      const img = new Image();
      const epoch = this._tileEpoch;
      // crossOrigin is best-effort; tiles may not set CORS, but drawing is fine unless you read pixels.
      img.crossOrigin = "anonymous";
      img.onload = () => {
        // Ignore late loads from a previous theme.
        if (epoch !== this._tileEpoch) return;
        this._tileCacheSet(key, { img, ok: true });
        // Debounce tile-load redraws to avoid cascading redraws when many tiles load at once
        this._scheduleTileRedraw();
      };
      img.onerror = () => {
        if (epoch !== this._tileEpoch) return;
        this._tileCacheSet(key, { img, ok: false });
      };
      const subs = this.tileSubdomains || [""];
      const sub = subs[(x + y) % subs.length] || "";
      img.src = this.tileTemplate
        .replace("{s}", sub)
        .replace("{z}", z)
        .replace("{x}", x)
        .replace("{y}", y);
      // Only track this request if it's for the current theme epoch.
      if (epoch === this._tileEpoch) this._tileCacheSet(key, { img, ok: false });
    }

    // Placeholder only when we don't have a prior snapshot (prevents flicker/grid flashes).
    if (!hasSnapshot) {
      const sz = TILE_SIZE * scale;
      ctx.fillStyle = "rgba(255,255,255,0.03)";
      ctx.fillRect(Math.floor(px), Math.floor(py), Math.ceil(sz), Math.ceil(sz));
      ctx.strokeStyle = "rgba(255,255,255,0.04)";
      ctx.strokeRect(Math.floor(px), Math.floor(py), Math.ceil(sz), Math.ceil(sz));
    }
  }

  _scheduleTileRedraw() {
    // Debounce tile-load redraws: wait a short time for more tiles to finish loading
    // before redrawing, to avoid N separate redraws when N tiles load in quick succession.
    if (this._tileLoadRedrawTimer) return; // already scheduled
    this._tileLoadRedrawTimer = setTimeout(() => {
      this._tileLoadRedrawTimer = null;
      // Skip if touch is active - will redraw when touch ends
      if (this._touchActive) return;
      this.drawTiles();
    }, 50); // 50ms debounce - batches tiles that load within this window
  }

  _tracePointsKeyForState(state) {
    const rev = state?.meta?.server_revision;
    if (typeof rev === "number" && isFinite(rev)) return `rev:${rev}`;
    const ts = state?.ts;
    if (typeof ts === "number" && isFinite(ts)) return `ts:${ts}`;
    return `obj:${state ? 1 : 0}`;
  }

  _playbackPointsKeyForState(state) {
    const revKey = this._tracePointsKeyForState(state);
    // Include trail point count per sensor to detect data changes
    let trailSig = "";
    const mobiles = Array.isArray(state?.mobile) ? state.mobile : [];
    for (const m of mobiles) {
      const id = m?.id || "";
      const trail = Array.isArray(m?.trail) ? m.trail : [];
      const lastT = trail.length > 0 ? (trail[trail.length - 1]?.t || "") : "";
      trailSig += `${id}:${trail.length}:${lastT}|`;
    }
    return `${revKey}|persist:${this._persistedTrailRev}|trail:${trailSig}|v3`;
  }

  _ensurePlaybackPoints(state) {
    const key = this._playbackPointsKeyForState(state);
    const cacheHit = (this._playbackPtsKey === key);
    
    // Cache key includes trail signatures, so if data changed the key will differ.
    if (cacheHit) {
      return;
    }
    
    // Rebuild playback points on cache miss
    this._playbackPtsKey = key;
    
    const nextPtsById = new Map();
    let minMs = Infinity;
    let maxMs = -Infinity;

    // Live playback is "today only"; clamp the window start to 5:00 AM local time.
    // Use the newest reading timestamp to determine what "today" means.
    const liveDayStartMs = (!this._historicalMode)
      ? (() => {
          const bestMs = newestReadingMsFromState(state);
          if (bestMs == null || !isFinite(bestMs)) return null;
          const d = new Date(bestMs);

          // If it's after midnight but before 5AM local time, "today's 5AM" is in the
          // future relative to bestMs; in that case the live window should start at
          // the previous day's 5AM.
          const localHour = d.getHours();
          if (localHour < 5) {
            d.setDate(d.getDate() - 1);
          }

          d.setHours(5, 0, 0, 0);
          const ms = d.getTime();
          return isFinite(ms) ? ms : null;
        })()
      : null;

    const mobiles = Array.isArray(state?.mobile) ? state.mobile : [];
    for (const m of mobiles) {
      const id = m && m.id != null ? String(m.id) : "";
      if (!id) continue;

      // In playback mode, always prefer server trail for fresh readings/colors.
      // Persisted trail is only used in non-playback live mode for continuity.
      const serverTrail = Array.isArray(m?.trail) ? m.trail : [];
      const persisted = (this._historicalMode || this.playbackMode) ? [] : (this._persistedTrailById.get(id)?.trail || []);
      const src = (serverTrail.length >= 2) ? serverTrail : (persisted.length >= 2 ? persisted : serverTrail);
      if (!Array.isArray(src) || src.length < 2) continue;

      const pts = [];
      for (const p of src) {
        const lat = Number(p?.lat);
        const lon = Number(p?.lon);
        if (!isFinite(lat) || !isFinite(lon)) continue;
        const tMs = (p && typeof p.t === "string") ? parseUtcMs(p.t) : null;
        if (tMs == null || !isFinite(tMs)) continue;
        pts.push({ lat, lon, tMs, m: p.m, readings: p.readings });
      }
      if (pts.length >= 1) {
        pts.sort((a, b) => a.tMs - b.tMs);

        let filtered = pts;
        if (liveDayStartMs != null && isFinite(liveDayStartMs)) {
          filtered = pts.filter(p => p.tMs >= liveDayStartMs);
        }
        if (!Array.isArray(filtered) || filtered.length < 2) {
          continue;
        }

        // Update timeline bounds from ALL data points (before movement filter)
        minMs = Math.min(minMs, filtered[0].tMs);
        maxMs = Math.max(maxMs, filtered[filtered.length - 1].tMs);

        // Only add to playback points if there's actual movement (not just GPS jitter)
        let totalM = 0;
        for (let i = 1; i < filtered.length; i++) {
          const a = filtered[i - 1];
          const b = filtered[i];
          const d = haversineMeters(a.lat, a.lon, b.lat, b.lon);
          if (isFinite(d)) totalM += d;
          if (totalM >= MapView.MIN_TRAIL_LENGTH_M) break;
        }
        if (totalM >= MapView.MIN_TRAIL_LENGTH_M) {
          nextPtsById.set(id, filtered);
        }
      }
    }

    this._playbackPtsById = nextPtsById;
    
    // Use server meta timestamps as fallback when no trails qualify
    const serverStartMs = state?.meta?.trail_update_start_ms;
    const serverEndMs = state?.meta?.trail_update_end_ms;
    
    if (!isFinite(minMs) && typeof serverStartMs === "number" && isFinite(serverStartMs)) {
      minMs = serverStartMs;
    }
    if (!isFinite(maxMs) && typeof serverEndMs === "number" && isFinite(serverEndMs)) {
      maxMs = serverEndMs;
    }
    // Also extend maxMs if server has newer data
    if (isFinite(maxMs) && typeof serverEndMs === "number" && isFinite(serverEndMs) && serverEndMs > maxMs) {
      maxMs = serverEndMs;
    }
    
    this._playbackMinMs = isFinite(minMs) ? minMs : null;
    this._playbackMaxMs = isFinite(maxMs) ? maxMs : null;

    // Track maxMs for other uses
    this._playbackLastMaxMs = this._playbackMaxMs;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // DEBUG: Fetch road graph edges for visualization
  // ─────────────────────────────────────────────────────────────────────────────
  
  async _fetchRoadEdgesForViewport() {
    if (!this._pbDebugPath || !this._pbDebugRoadLines) return;
    if (this._roadEdgesFetching) return;
    
    // Get viewport bounds
    const rect = this.overlayCanvas.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    const centerW = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
    
    // Convert corners to lat/lon
    const tl = worldToLatLon(centerW.x - w/2, centerW.y - h/2, this.zoom);
    const br = worldToLatLon(centerW.x + w/2, centerW.y + h/2, this.zoom);
    
    const minLat = Math.min(tl.lat, br.lat);
    const maxLat = Math.max(tl.lat, br.lat);
    const minLon = Math.min(tl.lon, br.lon);
    const maxLon = Math.max(tl.lon, br.lon);
    
    // Don't refetch if viewport hasn't changed much
    const key = `${minLat.toFixed(3)},${maxLat.toFixed(3)},${minLon.toFixed(3)},${maxLon.toFixed(3)}`;
    if (this._roadEdgesLastKey === key) return;
    
    this._roadEdgesFetching = true;
    
    try {
      const url = `${appConfig.apiBaseUrl}/road_edges?minLat=${minLat}&maxLat=${maxLat}&minLon=${minLon}&maxLon=${maxLon}&limit=8000`;
      const resp = await fetch(url);
      if (!resp.ok) return;
      const data = await resp.json();
      this._roadGraphEdges = data.edges || [];
      this._roadEdgesLastKey = key;
      // Trigger redraw
      this.drawOverlay(this.lastState);
    } catch (e) {
      console.warn("Failed to fetch road edges:", e);
    } finally {
      this._roadEdgesFetching = false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Walk between server-assigned edges (no re-snapping)
  // ─────────────────────────────────────────────────────────────────────────────
  
  _walkBetweenServerEdges(t0, t1, edges, toScreen) {
    // t0 and t1 have ea=[lat,lon] and eb=[lat,lon] from server
    // Walk from t0's position to t1's position along track edges
    
    const distM = (lat1, lon1, lat2, lon2) => {
      const dlat = (lat2 - lat1) * 111000;
      const dlon = (lon2 - lon1) * 111000 * Math.cos(lat1 * Math.PI / 180);
      return Math.hypot(dlat, dlon);
    };
    
    const coordsMatch = (a, b, threshold = 0.0001) => {
      return Math.abs(a[0] - b[0]) < threshold && Math.abs(a[1] - b[1]) < threshold;
    };
    
    // Start point and its edge
    const startLat = t0.lat, startLon = t0.lon;
    const startEa = t0.ea, startEb = t0.eb;
    
    // End point and its edge
    const endLat = t1.lat, endLon = t1.lon;
    const endEa = t1.ea, endEb = t1.eb;
    
    // If on same edge, just return the two points
    if (coordsMatch(startEa, endEa) && coordsMatch(startEb, endEb)) {
      return [toScreen(startLat, startLon), toScreen(endLat, endLon)];
    }
    if (coordsMatch(startEa, endEb) && coordsMatch(startEb, endEa)) {
      return [toScreen(startLat, startLon), toScreen(endLat, endLon)];
    }
    
    // Find shared vertex between start and end edges
    let sharedVertex = null;
    if (coordsMatch(startEb, endEa)) sharedVertex = startEb;
    else if (coordsMatch(startEb, endEb)) sharedVertex = startEb;
    else if (coordsMatch(startEa, endEa)) sharedVertex = startEa;
    else if (coordsMatch(startEa, endEb)) sharedVertex = startEa;
    
    if (sharedVertex) {
      // Direct connection through shared vertex
      return [
        toScreen(startLat, startLon),
        toScreen(sharedVertex[0], sharedVertex[1]),
        toScreen(endLat, endLon)
      ];
    }
    
    // Need to walk through intermediate edges
    // Find which endpoint of start edge is closer to end
    const d1 = distM(startEa[0], startEa[1], endLat, endLon);
    const d2 = distM(startEb[0], startEb[1], endLat, endLon);
    let current = d1 < d2 ? startEa : startEb;
    
    const path = [toScreen(startLat, startLon)];
    const visited = new Set();
    visited.add(`${startEa[0]},${startEa[1]}-${startEb[0]},${startEb[1]}`);
    
    const CONNECT_THRESH = 0.0003; // ~30m in degrees
    
    for (let step = 0; step < 50; step++) {
      path.push(toScreen(current[0], current[1]));
      
      // Check if we reached end edge
      if (coordsMatch(current, endEa, CONNECT_THRESH) || coordsMatch(current, endEb, CONNECT_THRESH)) {
        path.push(toScreen(endLat, endLon));
        return path;
      }
      
      // Find connected edge closest to destination
      let bestEdge = null;
      let bestDist = Infinity;
      let bestNext = null;
      
      for (const e of edges) {
        const key = `${e.lat1},${e.lon1}-${e.lat2},${e.lon2}`;
        if (visited.has(key)) continue;
        
        const e1 = [e.lat1, e.lon1];
        const e2 = [e.lat2, e.lon2];
        
        // Check if edge connects to current position
        let nextPt = null;
        if (coordsMatch(current, e1, CONNECT_THRESH)) nextPt = e2;
        else if (coordsMatch(current, e2, CONNECT_THRESH)) nextPt = e1;
        
        if (nextPt) {
          const dist = distM(nextPt[0], nextPt[1], endLat, endLon);
          if (dist < bestDist) {
            bestDist = dist;
            bestEdge = e;
            bestNext = nextPt;
          }
        }
      }
      
      if (!bestEdge) {
        // Stuck - return what we have plus end point
        if (distM(current[0], current[1], endLat, endLon) < 200) {
          path.push(toScreen(endLat, endLon));
          return path;
        }
        return null; // Can't complete path
      }
      
      visited.add(`${bestEdge.lat1},${bestEdge.lon1}-${bestEdge.lat2},${bestEdge.lon2}`);
      current = bestNext;
    }
    
    return null; // Too many steps
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // DEBUG: Fetch tram line graph edges for visualization
  // ─────────────────────────────────────────────────────────────────────────────
  
  // Find the nearest track edge and snap point for a given lat/lon
  // Returns { edge, snapLat, snapLon, t } or null
  _snapToTrackEdge(lat, lon, edges) {
    if (!edges || edges.length === 0) return null;
    
    let bestEdge = null;
    let bestDist = Infinity;
    let bestSnap = null;
    let bestT = 0;
    const MAX_DIST_DEG = 0.01; // ~1km in degrees
    
    for (const e of edges) {
      // Quick bounding box check
      const minLat = Math.min(e.lat1, e.lat2) - MAX_DIST_DEG;
      const maxLat = Math.max(e.lat1, e.lat2) + MAX_DIST_DEG;
      const minLon = Math.min(e.lon1, e.lon2) - MAX_DIST_DEG;
      const maxLon = Math.max(e.lon1, e.lon2) + MAX_DIST_DEG;
      
      if (lat < minLat || lat > maxLat || lon < minLon || lon > maxLon) continue;
      
      // Project point onto edge segment
      const ax = e.lon1, ay = e.lat1;
      const bx = e.lon2, by = e.lat2;
      const px = lon, py = lat;
      
      const abx = bx - ax, aby = by - ay;
      const apx = px - ax, apy = py - ay;
      const abLen2 = abx * abx + aby * aby;
      
      if (abLen2 < 1e-12) continue;
      
      const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / abLen2));
      const projLon = ax + t * abx;
      const projLat = ay + t * aby;
      
      const dist = Math.hypot(px - projLon, py - projLat);
      if (dist < bestDist && dist < MAX_DIST_DEG) {
        bestDist = dist;
        bestEdge = e;
        bestSnap = { lat: projLat, lon: projLon };
        bestT = t;
      }
    }
    
    if (!bestEdge) return null;
    return { edge: bestEdge, snapLat: bestSnap.lat, snapLon: bestSnap.lon, t: bestT };
  }
  
  // Walk along track edges from point A to point B using greedy edge-following
  // Returns array of screen points along the track, or null if can't find path
  _walkTrackPath(lat1, lon1, lat2, lon2, edges, toScreen) {
    if (!edges || edges.length === 0) {
      if (!this._walkNoEdgesLogged) {
        console.log(`[WALK DEBUG] No edges available`);
        this._walkNoEdgesLogged = true;
      }
      return null;
    }
    
    // Snap both endpoints to nearest edge
    const snap1 = this._snapToTrackEdge(lat1, lon1, edges);
    const snap2 = this._snapToTrackEdge(lat2, lon2, edges);
    
    if (!snap1 || !snap2) {
      if (!this._walkDebugLogged) {
        console.log(`[WALK DEBUG] snap failed: snap1=${!!snap1}, snap2=${!!snap2}, pt1=(${lat1?.toFixed(5)},${lon1?.toFixed(5)}), pt2=(${lat2?.toFixed(5)},${lon2?.toFixed(5)}), edges=${edges.length}`);
        // Sample a few edges near the point
        const sampleEdges = edges.filter(e => {
          const d1 = Math.hypot(e.lat1 - lat1, e.lon1 - lon1);
          const d2 = Math.hypot(e.lat2 - lat1, e.lon2 - lon1);
          return d1 < 0.01 || d2 < 0.01;
        }).slice(0, 3);
        console.log(`[WALK DEBUG] Nearby edges for pt1: ${JSON.stringify(sampleEdges)}`);
        this._walkDebugLogged = true;
      }
      return null;
    }
    
    // Log first successful snap
    if (!this._walkSnapLogged) {
      console.log(`[WALK DEBUG] snap1: edge=(${snap1.edge.lat1.toFixed(5)},${snap1.edge.lon1.toFixed(5)})-(${snap1.edge.lat2.toFixed(5)},${snap1.edge.lon2.toFixed(5)}), snap=(${snap1.snapLat.toFixed(5)},${snap1.snapLon.toFixed(5)})`);
      console.log(`[WALK DEBUG] snap2: edge=(${snap2.edge.lat1.toFixed(5)},${snap2.edge.lon1.toFixed(5)})-(${snap2.edge.lat2.toFixed(5)},${snap2.edge.lon2.toFixed(5)}), snap=(${snap2.snapLat.toFixed(5)},${snap2.snapLon.toFixed(5)})`);
      this._walkSnapLogged = true;
    }
    
    // If both on same edge, just return the two snapped points
    if (snap1.edge === snap2.edge) {
      return [
        toScreen(snap1.snapLat, snap1.snapLon),
        toScreen(snap2.snapLat, snap2.snapLon)
      ];
    }
    
    // Helper: distance in meters (approximate)
    const distM = (lat1, lon1, lat2, lon2) => {
      const dlat = (lat2 - lat1) * 111000;
      const dlon = (lon2 - lon1) * 111000 * Math.cos(lat1 * Math.PI / 180);
      return Math.hypot(dlat, dlon);
    };
    
    // Helper: get endpoint of edge closer to target
    const closerEndpoint = (edge, targetLat, targetLon) => {
      const d1 = distM(edge.lat1, edge.lon1, targetLat, targetLon);
      const d2 = distM(edge.lat2, edge.lon2, targetLat, targetLon);
      return d1 < d2 
        ? { lat: edge.lat1, lon: edge.lon1 }
        : { lat: edge.lat2, lon: edge.lon2 };
    };
    
    // Helper: check if point is an endpoint of edge (within threshold)
    const isOnEdge = (pt, edge) => {
      return distM(pt.lat, pt.lon, edge.lat1, edge.lon1) < 25 ||
             distM(pt.lat, pt.lon, edge.lat2, edge.lon2) < 25;
    };
    
    // Helper: find edges connected to a point (endpoint within threshold)
    const CONNECT_DIST = 25; // meters - increased for OSM data tolerance
    const findConnectedEdges = (pt, visitedEdges) => {
      const connected = [];
      for (const e of edges) {
        // Skip already visited edges
        const eKey = `${e.lat1},${e.lon1}-${e.lat2},${e.lon2}`;
        if (visitedEdges.has(eKey)) continue;
        
        const d1 = distM(pt.lat, pt.lon, e.lat1, e.lon1);
        const d2 = distM(pt.lat, pt.lon, e.lat2, e.lon2);
        
        if (d1 < CONNECT_DIST) {
          connected.push({ edge: e, otherEnd: { lat: e.lat2, lon: e.lon2 }, key: eKey, dist: d1 });
        } else if (d2 < CONNECT_DIST) {
          connected.push({ edge: e, otherEnd: { lat: e.lat1, lon: e.lon1 }, key: eKey, dist: d2 });
        }
      }
      return connected;
    };
    
    // Greedy walk: always move toward destination
    const path = [toScreen(snap1.snapLat, snap1.snapLon)];
    const visitedEdges = new Set();
    
    // Mark starting edge as visited
    const startEdgeKey = `${snap1.edge.lat1},${snap1.edge.lon1}-${snap1.edge.lat2},${snap1.edge.lon2}`;
    visitedEdges.add(startEdgeKey);
    
    // Start from endpoint of edge1 closer to destination
    let current = closerEndpoint(snap1.edge, lat2, lon2);
    path.push(toScreen(current.lat, current.lon));
    
    // Log the walk start
    if (!this._walkStartLogged) {
      const startDist = distM(snap1.snapLat, snap1.snapLon, snap2.snapLat, snap2.snapLon);
      console.log(`[WALK DEBUG] Starting walk: from (${current.lat.toFixed(5)},${current.lon.toFixed(5)}) to edge at (${snap2.edge.lat1.toFixed(5)},${snap2.edge.lon1.toFixed(5)}), direct=${startDist.toFixed(1)}m`);
      this._walkStartLogged = true;
    }
    
    for (let step = 0; step < 100; step++) {
      // Check if we reached edge2
      if (isOnEdge(current, snap2.edge)) {
        path.push(toScreen(snap2.snapLat, snap2.snapLon));
        if (!this._walkSuccessLogged) {
          console.log(`[WALK DEBUG] SUCCESS after ${step} steps, path length=${path.length}`);
          this._walkSuccessLogged = true;
        }
        return path;
      }
      
      // Find connected edges
      const connected = findConnectedEdges(current, visitedEdges);
      if (connected.length === 0) {
        // Stuck - complete path to destination and return what we have
        const directDist = distM(current.lat, current.lon, snap2.snapLat, snap2.snapLon);
        if (directDist < 500) {
          path.push(toScreen(snap2.snapLat, snap2.snapLon));
          return path;
        }
        if (!this._walkStuckLogged) {
          console.log(`[WALK DEBUG] STUCK at step ${step}: no connected edges from (${current.lat.toFixed(5)},${current.lon.toFixed(5)}), directDist=${directDist.toFixed(1)}m, visited=${visitedEdges.size}`);
          this._walkStuckLogged = true;
        }
        return null;
      }
      
      // Pick next edge - prefer continuing the track over jumping
      // If only one option, take it (this follows curves correctly)
      // If multiple options (junction), pick closest to destination
      let bestChoice = null;
      if (connected.length === 1) {
        // Only one option - follow it (this is the key to following curves!)
        bestChoice = connected[0];
      } else {
        // Multiple options (junction) - pick by distance, but prefer closer connections
        let bestScore = Infinity;
        for (const choice of connected) {
          // Score = distance to destination + penalty for loose connection
          const destDist = distM(choice.otherEnd.lat, choice.otherEnd.lon, lat2, lon2);
          const connDist = choice.dist; // How tightly connected (closer = better)
          const score = destDist + connDist * 10; // Penalize loose connections
          if (score < bestScore) {
            bestScore = score;
            bestChoice = choice;
          }
        }
      }
      
      if (!bestChoice) return null;
      
      visitedEdges.add(bestChoice.key);
      current = bestChoice.otherEnd;
      path.push(toScreen(current.lat, current.lon));
    }
    
    // Too many steps
    if (!this._walkTooManyLogged) {
      console.log(`[WALK DEBUG] TOO MANY STEPS (100), path length=${path.length}`);
      this._walkTooManyLogged = true;
    }
    return null;
  }
  
  async _fetchTramLineEdgesForViewport() {
    // Always fetch if we have TRX vehicles OR debug mode is on
    if (!this._pbDebugPath && !this._pbDebugRoadLines && !this._hasTrxVehicles) return;
    if (this._tramEdgesFetching) return;
    
    // Get viewport bounds
    const rect = this.overlayCanvas.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    const centerW = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
    
    // Convert corners to lat/lon with 3x buffer for trail path walking
    // Trails can extend well beyond the visible viewport
    const bufferW = w * 1.5;
    const bufferH = h * 1.5;
    const tl = worldToLatLon(centerW.x - bufferW, centerW.y - bufferH, this.zoom);
    const br = worldToLatLon(centerW.x + bufferW, centerW.y + bufferH, this.zoom);
    
    const minLat = Math.min(tl.lat, br.lat);
    const maxLat = Math.max(tl.lat, br.lat);
    const minLon = Math.min(tl.lon, br.lon);
    const maxLon = Math.max(tl.lon, br.lon);
    
    // Don't refetch if viewport hasn't changed much (use coarse key to avoid excessive fetches)
    const key = `${minLat.toFixed(2)},${maxLat.toFixed(2)},${minLon.toFixed(2)},${maxLon.toFixed(2)}`;
    if (this._tramEdgesLastKey === key) return;
    
    this._tramEdgesFetching = true;
    
    try {
      const url = `${appConfig.apiBaseUrl}/tram_line_edges?minLat=${minLat}&maxLat=${maxLat}&minLon=${minLon}&maxLon=${maxLon}&limit=8000`;
      const resp = await fetch(url);
      if (!resp.ok) return;
      const data = await resp.json();
      this._tramLineEdges = data.edges || [];
      this._tramLineHasElevation = data.has_elevation || false;
      this._tramEdgesLastKey = key;
      // Trigger redraw
      this.drawOverlay(this.lastState);
    } catch (e) {
      console.warn("Failed to fetch tram line edges:", e);
    } finally {
      this._tramEdgesFetching = false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // FOVEATED ROAD MATCHING: Match segments progressively as vehicles drive.
  // Uses vehicle physics lookahead (not arbitrary time) to determine what to match.
  // ─────────────────────────────────────────────────────────────────────────────

  _isRangeMatched(sensorId, fromMs, toMs) {
    const ranges = this._roadMatchedRangesById.get(sensorId);
    if (!ranges || ranges.length === 0) return false;
    for (const r of ranges) {
      if (r.fromMs <= fromMs && r.toMs >= toMs) return true;
    }
    return false;
  }

  _markRangeMatched(sensorId, fromMs, toMs) {
    if (!this._roadMatchedRangesById.has(sensorId)) {
      this._roadMatchedRangesById.set(sensorId, []);
    }
    this._roadMatchedRangesById.get(sensorId).push({ fromMs, toMs });
  }

  /**
   * Request road matching for segments vehicles are about to drive through.
   * Uses vehicle position + physics lookahead distance.
   */
  async _requestFoveatedRoadMatching() {
    if (!this._historicalMode) return;
    if (!this.playbackMode) return;
    
    // Throttle: max 1 batch per 500ms
    const perfNow = performance.now();
    if (perfNow - this._roadMatchLastRequestMs < 500) return;
    this._roadMatchLastRequestMs = perfNow;
    
    const state = window._historicalState;
    const mobiles = Array.isArray(state?.mobile) ? state.mobile : [];
    
    for (const m of mobiles) {
      const id = m?.id;
      if (!id) continue;
      
      if (this._roadMatchPending.has(id)) continue;
      
      // Skip TRAX (rail) - COMMENTED OUT: will use tram line data instead of road graph
      // const sid = String(id).toUpperCase();
      // if (sid.startsWith("TRX") || sid.startsWith("TRAX")) continue;
      
      // Get vehicle physics state (or use playback time-based position)
      const phys = this._physicsStateById?.get(String(id));
      const pts = this._playbackPtsById.get(String(id));
      if (!pts || pts.length < 2) continue;
      
      // Use physics distance if available, otherwise estimate from playback time
      let currentD = 0;
      if (phys && phys.d > 0) {
        currentD = phys.d;
      } else {
        // Estimate position from playback time
        const pbTimeMs = this.getPlaybackTimeMs();
        if (pbTimeMs != null) {
          let cumD = 0;
          for (let i = 1; i < pts.length; i++) {
            if (pts[i].tMs > pbTimeMs) break;
            const prev = pts[i - 1], curr = pts[i];
            const segD = haversineMeters(prev.lat, prev.lon, curr.lat, curr.lon);
            if (isFinite(segD)) cumD += segD;
          }
          currentD = cumD;
        }
      }
      
      // Find segment ahead of vehicle using lookahead distance
      const lookaheadD = currentD + MapView.CURVATURE_LOOKAHEAD * 2;
      
      // Find indices in trail corresponding to [currentD, lookaheadD]
      let startIdx = 0, endIdx = pts.length - 1, cumD = 0;
      for (let i = 1; i < pts.length; i++) {
        const prev = pts[i - 1], curr = pts[i];
        const segD = haversineMeters(prev.lat, prev.lon, curr.lat, curr.lon);
        if (isFinite(segD)) cumD += segD;
        if (cumD < currentD) startIdx = i;
        if (cumD >= lookaheadD) { endIdx = i; break; }
      }
      
      const fromMs = pts[startIdx]?.tMs;
      const toMs = pts[endIdx]?.tMs;
      if (!isFinite(fromMs) || !isFinite(toMs)) continue;
      if (this._isRangeMatched(id, fromMs, toMs)) continue;
      
      // Get raw trail segment
      const trail = Array.isArray(m?.trail) ? m.trail : [];
      const segmentPts = trail.filter(p => {
        const tMs = (p && typeof p.t === "string") ? parseUtcMs(p.t) : null;
        return tMs != null && tMs >= fromMs && tMs <= toMs;
      });
      
      if (segmentPts.length < 2) continue;
      if (segmentPts.some(p => p.wp === 1)) {
        this._markRangeMatched(id, fromMs, toMs);
        continue;
      }
      
      this._roadMatchPending.add(id);
      this._fetchAndApplyRoadMatch(id, segmentPts, fromMs, toMs);
    }
  }

  async _fetchAndApplyRoadMatch(sensorId, trailSegment, fromMs, toMs) {
    try {
      const trailJson = JSON.stringify(trailSegment);
      const url = `${appConfig.apiBaseUrl}/match_segment?sensor=${encodeURIComponent(sensorId)}&trail=${encodeURIComponent(trailJson)}`;
      const resp = await fetch(url);
      if (!resp.ok) return;
      
      const data = await resp.json();
      const matchedTrail = data.trail;
      if (!Array.isArray(matchedTrail) || matchedTrail.length === 0) return;
      
      // Merge into state
      const state = window._historicalState;
      const mobiles = Array.isArray(state?.mobile) ? state.mobile : [];
      const mobile = mobiles.find(m => m?.id === sensorId);
      if (!mobile || !Array.isArray(mobile.trail)) return;
      
      // Build map of matched points by time
      const matchedByTime = new Map();
      for (const p of matchedTrail) {
        const tMs = (p && typeof p.t === "string") ? parseUtcMs(p.t) : null;
        if (tMs != null) {
          if (!matchedByTime.has(tMs)) matchedByTime.set(tMs, []);
          matchedByTime.get(tMs).push(p);
        }
      }
      
      // Splice matched points into trail
      const newTrail = [];
      for (const p of mobile.trail) {
        const tMs = (p && typeof p.t === "string") ? parseUtcMs(p.t) : null;
        if (tMs != null && matchedByTime.has(tMs)) {
          newTrail.push(...matchedByTime.get(tMs));
          matchedByTime.delete(tMs);
        } else if (!p.wp) {
          newTrail.push(p);
        }
      }
      
      mobile.trail = newTrail;
      this._playbackPtsKey = ""; // Invalidate cache
      this._ensurePlaybackPoints(state);
      this._markRangeMatched(sensorId, fromMs, toMs);
      
    } catch (e) {
      console.warn(`Road match error for ${sensorId}:`, e);
    } finally {
      this._roadMatchPending.delete(sensorId);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // AUTONOMOUS AGENT PHYSICS: Vehicles behave like self-driving agents that see
  // the revealed trail ahead and drive naturally - accelerating on straights,
  // braking for curves, and stopping at the end of visible road.
  // 
  // Key principles:
  // 1. Trail reveals at targetD + dynamic lookahead (the "visible road")
  // 2. Vehicle is FREE AGENT that follows visible road, not locked to playback time
  // 3. Physics match wall-clock time, but position decouples during scrubbing
  // 4. GPS data points act as checkpoints for ground truth
  // ─────────────────────────────────────────────────────────────────────────────
  
  // Physics constants (matching unit tests in vehicle_physics.test.cjs)
  static CRUISE_SPEED = 12;           // m/s on straights (~25 mph)
  static CURVE_SPEED = 8;             // m/s in tight curves (~18 mph)
  static ACCEL_RATE = 4;              // m/s² acceleration
  static BRAKE_RATE = 6;              // m/s² braking (stronger than accel)
  static CURVATURE_LOOKAHEAD = 100;   // meters to scan ahead for curves
  static TRAIL_LOOKAHEAD_BASE = 80;   // base meters ahead of targetD for trail reveal
  static CURVATURE_THRESHOLD = 0.01;  // rad/m where we start slowing
  static STOP_BUFFER = 10;            // meters before visible end to start stopping
  static PHYSICS_VARIATION = 0.15;    // ±15% variation in physics params per vehicle
  
  // Deterministic hash for vehicle ID -> [0, 1)
  _hashId(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) {
      h = ((h << 5) - h + id.charCodeAt(i)) | 0;
    }
    return ((h & 0x7fffffff) % 10000) / 10000;
  }
  
  // Get per-vehicle physics parameters (deterministic variation from ID)
  _getVehiclePhysics(id) {
    if (!this._vehiclePhysicsCache) this._vehiclePhysicsCache = new Map();
    let vp = this._vehiclePhysicsCache.get(id);
    if (vp) return vp;
    
    const h1 = this._hashId(id);
    const h2 = this._hashId(id + "_2");
    const h3 = this._hashId(id + "_3");
    const vary = MapView.PHYSICS_VARIATION;
    
    // Each vehicle gets slightly different cruise/curve speeds and acceleration
    vp = {
      cruiseSpeed: MapView.CRUISE_SPEED * (1 + (h1 - 0.5) * 2 * vary),
      curveSpeed: MapView.CURVE_SPEED * (1 + (h2 - 0.5) * 2 * vary),
      accelRate: MapView.ACCEL_RATE * (1 + (h3 - 0.5) * 2 * vary),
      brakeRate: MapView.BRAKE_RATE * (1 + (this._hashId(id + "_4") - 0.5) * 2 * vary),
    };
    
    this._vehiclePhysicsCache.set(id, vp);
    return vp;
  }
  
  // Per-vehicle physics state: { d: current distance along path (meters),
  //                              v: velocity (m/s along path), lastPerfMs }
  
  _getPhysicsState(id) {
    if (!this._physicsStateById) this._physicsStateById = new Map();
    let st = this._physicsStateById.get(id);
    if (!st) {
      st = { d: 0, v: 0, lastPerfMs: null, totalDist: 0 };
      this._physicsStateById.set(id, st);
    }
    return st;
  }
  
  _resetPhysicsState(id) {
    if (this._physicsStateById) this._physicsStateById.delete(id);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SLIDING WINDOW WAYPOINT STEERING
  // 
  // Waypoints are computed incrementally in sliding window chunks around the
  // vehicle position. Each chunk depends on previous waypoints (memoizable).
  // The look-ahead distance varies with playback speed.
  // 
  // This avoids reprocessing the entire path - only computes what's needed.
  // ═══════════════════════════════════════════════════════════════════════════
  
  static WAYPOINT_CHUNK_SIZE = 50;      // Points per computed chunk
  static WAYPOINT_BEHIND = 5;           // Points behind vehicle to keep
  static WAYPOINT_AHEAD_BASE = 20;      // Base points ahead at 1x speed
  static WAYPOINT_AHEAD_PER_SPEED = 5;  // Additional points per speed multiplier
  static JITTER_THRESHOLD_M = 8;        // Only smooth deviations < 8 meters
  static JITTER_BLEND = 0.3;            // Blend factor for jitter smoothing
  static MIN_TRAIL_LENGTH_M = 50;      // Ignore tiny trails (GPS jitter)
  static MIN_CAMERA_FIT_SEGMENT_POINTS = 3;
  static MIN_CAMERA_FIT_SEGMENT_LENGTH_M = 120;
  static MIN_CAMERA_FIT_SEGMENT_DISPLACEMENT_M = 60;
  static MIN_CAMERA_FIT_SEGMENT_STRAIGHTNESS = 0.2;
  static MIN_CAMERA_FIT_SEGMENT_LENGTH_M_2PT = 500;
  static MIN_CAMERA_FIT_SEGMENT_DISPLACEMENT_M_2PT = 500;

  // ═══════════════════════════════════════════════════════════════════════════
  // PROGRESSIVE SPLINE PATH
  // 
  // The vehicle's path is computed PROGRESSIVELY as it advances. When the
  // vehicle passes a GPS waypoint, we compute the spline segment from that
  // waypoint to the next using the CURRENT tension (based on current speed).
  // 
  // Key insight: Once a spline segment is computed, it's LOCKED. When speed
  // changes, only FUTURE segments (not yet reached) use the new tension.
  // This prevents the vehicle from "snapping" when speed changes.
  //
  // Structure:
  //   _vehiclePathById: Map<id, { 
  //     computedPts: [{lat, lon, rawIdx, tMs, m, readings}],  // progressive spline
  //     cumDist: [],           // cumulative distances for computedPts
  //     lastRawIdx: number,    // last raw GPS index we've computed past
  //   }>
  // ═══════════════════════════════════════════════════════════════════════════

  // Get or create the progressive path for a vehicle
  _getVehiclePath(id, pts) {
    if (!this._vehiclePathById) this._vehiclePathById = new Map();
    
    let path = this._vehiclePathById.get(id);
    const ptsKey = this._playbackPtsKey;
    
    // Reset if pts changed (different recording loaded)
    if (path && path.ptsKey !== ptsKey) {
      path = null;
    }
    
    if (!path) {
      // Initialize with first GPS point
      const p0 = pts[0];
      path = {
        computedPts: [{
          lat: p0.lat,
          lon: p0.lon,
          rawIdx: 0,
          tMs: p0.tMs,
          m: p0.m,
          readings: p0.readings
        }],
        cumDist: [0],
        lastRawIdx: 0,
        ptsKey
      };
      this._vehiclePathById.set(id, path);
    }
    
    return path;
  }

  // Extend the progressive path up to (and past) targetRawIdx
  // Uses current playback speed to determine spline tension for NEW segments only
  // CRITICAL: If tension changed, invalidate segments AHEAD of vehicle and recompute
  _extendVehiclePath(id, pts, targetRawIdx, playbackSpeed, vehicleRawIdx) {
    const path = this._getVehiclePath(id, pts);
    const n = pts.length;
    
    // Spline tension from current speed
    // HIGH tension = TIGHT curves (follows GPS closely) - for LOW speed
    // LOW tension = SMOOTH curves (wider arcs) - for HIGH speed
    // At 1x: tension = 0.85 (tight, follows GPS)
    // At 20x: tension ~ 0.33 (smooth, wide arcs)
    const tension = Math.max(0.2, 0.85 - 0.12 * Math.log2(Math.max(1, playbackSpeed)));
    const tensionKey = Math.round(tension * 100);
    
    // If tension changed and we have segments ahead of vehicle, invalidate them
    if (path.lastTensionKey !== undefined && path.lastTensionKey !== tensionKey) {
      // Find where vehicle is in computed path
      const vehRawIdx = vehicleRawIdx || 0;
      
      // Truncate: keep only points up to current vehicle position
      // Find the last computed point that's AT or BEFORE vehicle
      let keepUpToIdx = 0;
      for (let i = 0; i < path.computedPts.length; i++) {
        if (path.computedPts[i].rawIdx <= vehRawIdx) {
          keepUpToIdx = i;
        } else {
          break;
        }
      }
      
      // Truncate arrays
      if (keepUpToIdx < path.computedPts.length - 1) {
        path.computedPts = path.computedPts.slice(0, keepUpToIdx + 1);
        path.cumDist = path.cumDist.slice(0, keepUpToIdx + 1);
        path.lastRawIdx = Math.floor(path.computedPts[keepUpToIdx].rawIdx);
      }
    }
    path.lastTensionKey = tensionKey;
    
    // Already computed past this index?
    if (path.lastRawIdx >= targetRawIdx) {
      return path;
    }
    
    const s = (1 - tension) / 2;
    
    // Catmull-Rom interpolation
    const catmullRom = (p0, p1, p2, p3, t) => {
      const t2 = t * t;
      const t3 = t2 * t;
      const h1 = -s * t3 + 2 * s * t2 - s * t;
      const h2 = (2 - s) * t3 + (s - 3) * t2 + 1;
      const h3 = (s - 2) * t3 + (3 - 2 * s) * t2 + s * t;
      const h4 = s * t3 - s * t2;
      return {
        lat: h1 * p0.lat + h2 * p1.lat + h3 * p2.lat + h4 * p3.lat,
        lon: h1 * p0.lon + h2 * p1.lon + h3 * p2.lon + h4 * p3.lon
      };
    };
    
    const SAMPLES_PER_SEGMENT = 4;
    
    // Extend from lastRawIdx to targetRawIdx
    for (let i = path.lastRawIdx; i < targetRawIdx && i < n - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[i];
      const p2 = pts[Math.min(n - 1, i + 1)];
      const p3 = pts[Math.min(n - 1, i + 2)];
      
      // Add interpolated points for segment i → i+1
      for (let si = 1; si <= SAMPLES_PER_SEGMENT; si++) {
        const t = si / (SAMPLES_PER_SEGMENT + 1);
        const interp = catmullRom(p0, p1, p2, p3, t);
        
        const newPt = {
          lat: interp.lat,
          lon: interp.lon,
          rawIdx: i + t,
          tMs: p1.tMs + t * (p2.tMs - p1.tMs),
          m: p2.m,
          readings: p2.readings
        };
        
        // Compute distance from last point
        const lastPt = path.computedPts[path.computedPts.length - 1];
        const segDist = haversineMeters(lastPt.lat, lastPt.lon, newPt.lat, newPt.lon);
        
        path.computedPts.push(newPt);
        path.cumDist.push(path.cumDist[path.cumDist.length - 1] + segDist);
      }
      
      // Add the endpoint (GPS point i+1)
      const endPt = {
        lat: p2.lat,
        lon: p2.lon,
        rawIdx: i + 1,
        tMs: p2.tMs,
        m: p2.m,
        readings: p2.readings
      };
      
      const lastPt = path.computedPts[path.computedPts.length - 1];
      const segDist = haversineMeters(lastPt.lat, lastPt.lon, endPt.lat, endPt.lon);
      
      path.computedPts.push(endPt);
      path.cumDist.push(path.cumDist[path.cumDist.length - 1] + segDist);
      
      path.lastRawIdx = i + 1;
    }
    
    return path;
  }

  // Get sliding window of waypoints around vehicle position from PROGRESSIVE path
  // Returns { waypoints, startIdx, endIdx, cumDist, curvature }
  _getWaypointWindow(id, pts, vehicleIdx, playbackSpeed) {
    const n = pts.length;
    if (n < 2) return null;
    
    // Extend progressive path to cover ahead of vehicle
    const aheadCount = MapView.WAYPOINT_AHEAD_BASE + 
                       Math.floor(MapView.WAYPOINT_AHEAD_PER_SPEED * Math.max(1, playbackSpeed));
    const targetRawIdx = Math.min(n - 1, vehicleIdx + aheadCount);
    
    // Pass vehicleIdx so _extendVehiclePath can invalidate segments ahead when tension changes
    const path = this._extendVehiclePath(id, pts, targetRawIdx, playbackSpeed, vehicleIdx);
    
    // Find window in computed path
    const behindCount = MapView.WAYPOINT_BEHIND;
    const cpts = path.computedPts;
    const ccum = path.cumDist;
    
    // Find index in computed path corresponding to vehicleIdx
    let vehicleComputedIdx = 0;
    for (let i = 0; i < cpts.length; i++) {
      if (cpts[i].rawIdx >= vehicleIdx) {
        vehicleComputedIdx = i;
        break;
      }
      vehicleComputedIdx = i;
    }
    
    // Window bounds in computed path (5 samples per GPS segment)
    const SAMPLES_PER_SEG = 5; // 4 interpolated + 1 endpoint
    const startComputedIdx = Math.max(0, vehicleComputedIdx - behindCount * SAMPLES_PER_SEG);
    const endComputedIdx = Math.min(cpts.length - 1, vehicleComputedIdx + aheadCount * SAMPLES_PER_SEG);
    
    // Extract window
    const windowPts = cpts.slice(startComputedIdx, endComputedIdx + 1);
    const windowCumDist = [];
    const baseDist = ccum[startComputedIdx];
    for (let i = startComputedIdx; i <= endComputedIdx; i++) {
      windowCumDist.push(ccum[i] - baseDist);
    }
    const totalDist = windowCumDist[windowCumDist.length - 1] || 1;
    
    // Compute curvature for window
    const wn = windowPts.length;
    const curvature = new Array(wn).fill(0);
    if (wn >= 3) {
      for (let i = 1; i < wn - 1; i++) {
        const dx1 = windowPts[i].lon - windowPts[i-1].lon;
        const dy1 = windowPts[i].lat - windowPts[i-1].lat;
        const dx2 = windowPts[i+1].lon - windowPts[i].lon;
        const dy2 = windowPts[i+1].lat - windowPts[i].lat;
        
        const a1 = Math.atan2(dy1, dx1);
        const a2 = Math.atan2(dy2, dx2);
        let angleDiff = Math.abs(a2 - a1);
        if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
        
        const dist = (windowCumDist[i] - windowCumDist[i-1] + windowCumDist[i+1] - windowCumDist[i]) / 2;
        curvature[i] = dist > 0.1 ? angleDiff / dist : 0;
      }
    }
    
    return {
      waypoints: windowPts,
      startIdx: startComputedIdx,
      endIdx: endComputedIdx,
      cumDist: windowCumDist,
      totalDist,
      curvature,
      // For mapping raw distance to window distance
      startRawIdx: cpts[startComputedIdx]?.rawIdx || 0,
      endRawIdx: cpts[endComputedIdx]?.rawIdx || n - 1,
      fullCumDist: ccum,
      fullStartIdx: startComputedIdx
    };
  }

  // Legacy: Get full smooth path (for compatibility with debug display)
  // Delegates to window-based computation
  _getSmoothPath(id, pts) {
    if (!this._smoothPathCache) this._smoothPathCache = new Map();
    const cached = this._smoothPathCache.get(id);
    if (cached && cached.ptsLen === pts.length && cached.ptsKey === this._playbackPtsKey) {
      return cached;
    }

    const n = pts.length;
    if (n < 2) {
      const single = { 
        waypoints: pts.slice(), 
        cumDist: [0], 
        totalDist: 0, 
        curvature: [0], 
        origIdxMap: [0],
        ptsLen: n,
        ptsKey: this._playbackPtsKey
      };
      this._smoothPathCache.set(id, single);
      return single;
    }

    // Compute full path using window function (for debug display)
    const playbackSpeed = this._playbackSpeed || 1.0;
    const fullWindow = this._getWaypointWindow(id, pts, Math.floor(n / 2), playbackSpeed);
    
    // If window doesn't cover full path, compute remaining
    const waypoints = [];
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      
      // Simple jitter smoothing for full path
      let sumLat = 0, sumLon = 0, count = 0;
      for (let j = Math.max(0, i - 1); j <= Math.min(n - 1, i + 1); j++) {
        sumLat += pts[j].lat;
        sumLon += pts[j].lon;
        count++;
      }
      const avgLat = sumLat / count;
      const avgLon = sumLon / count;
      
      const deviationM = haversineMeters(p.lat, p.lon, avgLat, avgLon);
      
      let smoothLat, smoothLon;
      if (deviationM < MapView.JITTER_THRESHOLD_M && i > 0 && i < n - 1) {
        const blend = MapView.JITTER_BLEND;
        smoothLat = p.lat + blend * (avgLat - p.lat);
        smoothLon = p.lon + blend * (avgLon - p.lon);
      } else {
        smoothLat = p.lat;
        smoothLon = p.lon;
      }
      
      waypoints.push({
        lat: smoothLat,
        lon: smoothLon,
        origIdx: i,
        tMs: p.tMs,
        m: p.m,
        readings: p.readings
      });
    }

    // Build distance table
    const wn = waypoints.length;
    const cumDist = new Array(wn);
    cumDist[0] = 0;
    for (let i = 1; i < wn; i++) {
      const segDist = haversineMeters(waypoints[i-1].lat, waypoints[i-1].lon, waypoints[i].lat, waypoints[i].lon);
      cumDist[i] = cumDist[i-1] + segDist;
    }
    const totalDist = cumDist[wn - 1] || 1;

    // Compute curvature
    const curvature = new Array(wn).fill(0);
    if (wn >= 3) {
      for (let i = 1; i < wn - 1; i++) {
        const dx1 = waypoints[i].lon - waypoints[i-1].lon;
        const dy1 = waypoints[i].lat - waypoints[i-1].lat;
        const dx2 = waypoints[i+1].lon - waypoints[i].lon;
        const dy2 = waypoints[i+1].lat - waypoints[i].lat;
        
        const a1 = Math.atan2(dy1, dx1);
        const a2 = Math.atan2(dy2, dx2);
        let angleDiff = Math.abs(a2 - a1);
        if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
        
        const dist = (cumDist[i] - cumDist[i-1] + cumDist[i+1] - cumDist[i]) / 2;
        curvature[i] = dist > 0.1 ? angleDiff / dist : 0;
      }
    }

    const origIdxMap = waypoints.map(w => w.origIdx);

    const result = { 
      waypoints, 
      cumDist, 
      totalDist, 
      curvature, 
      origIdxMap,
      ptsLen: n,
      ptsKey: this._playbackPtsKey
    };
    this._smoothPathCache.set(id, result);
    return result;
  }
  
  // Build cumulative distance array for a path (cached per vehicle)
  // Also computes per-point curvature for speed modulation
  _getPathDistances(id, pts) {
    if (!this._pathDistCache) this._pathDistCache = new Map();
    let cached = this._pathDistCache.get(id);
    if (cached && cached.ptsLen === pts.length) return cached;
    
    const n = pts.length;
    
    // Build cumulative distance array: cumDist[i] = distance from pts[0] to pts[i]
    const cumDist = new Array(n);
    cumDist[0] = 0;
    for (let i = 1; i < n; i++) {
      const segDist = haversineMeters(pts[i-1].lat, pts[i-1].lon, pts[i].lat, pts[i].lon);
      cumDist[i] = cumDist[i-1] + segDist;
    }
    const totalDist = cumDist[n - 1] || 1;
    
    // Compute curvature at each point using angle change between adjacent segments
    // Curvature[i] is angle change (radians) per meter at point i
    const curvature = new Array(n).fill(0);
    if (n >= 3) {
      for (let i = 1; i < n - 1; i++) {
        // Vectors for adjacent segments
        const dx1 = pts[i].lon - pts[i-1].lon;
        const dy1 = pts[i].lat - pts[i-1].lat;
        const dx2 = pts[i+1].lon - pts[i].lon;
        const dy2 = pts[i+1].lat - pts[i].lat;
        
        // Angles of segments
        const a1 = Math.atan2(dy1, dx1);
        const a2 = Math.atan2(dy2, dx2);
        
        // Angle change (absolute, wrapped to [0, π])
        let angleDiff = Math.abs(a2 - a1);
        if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
        
        // Distance over which this turn occurs
        const dist = (cumDist[i] - cumDist[i-1] + cumDist[i+1] - cumDist[i]) / 2;
        
        // Curvature = angle change per meter
        curvature[i] = dist > 0.1 ? angleDiff / dist : 0;
      }
    }
    
    cached = { cumDist, totalDist, curvature, ptsLen: n };
    this._pathDistCache.set(id, cached);
    return cached;
  }
  
  // Catmull-Rom spline interpolation for smooth curves
  // Returns position and tangent at parameter t ∈ [0,1] between pts[p1] and pts[p2]
  _catmullRom(pts, p0Idx, p1Idx, p2Idx, p3Idx, t) {
    const p0 = pts[p0Idx];
    const p1 = pts[p1Idx];
    const p2 = pts[p2Idx];
    const p3 = pts[p3Idx];
    
    const t2 = t * t;
    const t3 = t2 * t;
    
    // Catmull-Rom basis functions
    const lat = 0.5 * (
      (-p0.lat + 3*p1.lat - 3*p2.lat + p3.lat) * t3 +
      (2*p0.lat - 5*p1.lat + 4*p2.lat - p3.lat) * t2 +
      (-p0.lat + p2.lat) * t +
      2*p1.lat
    );
    const lon = 0.5 * (
      (-p0.lon + 3*p1.lon - 3*p2.lon + p3.lon) * t3 +
      (2*p0.lon - 5*p1.lon + 4*p2.lon - p3.lon) * t2 +
      (-p0.lon + p2.lon) * t +
      2*p1.lon
    );
    
    // Tangent (derivative of position)
    const dLat = 0.5 * (
      3*(-p0.lat + 3*p1.lat - 3*p2.lat + p3.lat) * t2 +
      2*(2*p0.lat - 5*p1.lat + 4*p2.lat - p3.lat) * t +
      (-p0.lat + p2.lat)
    );
    const dLon = 0.5 * (
      3*(-p0.lon + 3*p1.lon - 3*p2.lon + p3.lon) * t2 +
      2*(2*p0.lon - 5*p1.lon + 4*p2.lon - p3.lon) * t +
      (-p0.lon + p2.lon)
    );
    
    return { lat, lon, dLat, dLon };
  }
  
  // Sample position on path given distance along it using LINEAR interpolation
  // Catmull-Rom was causing loops at sharp corners - linear is more predictable
  // Returns position, tangent direction, and local curvature
  _samplePathAtDistance(pts, cumDist, curvature, d) {
    const n = pts.length;
    if (n < 2) return { lat: pts[0].lat, lon: pts[0].lon, idx: 0, u: 0, heading: 0, curv: 0 };
    
    // Binary search for segment containing distance d
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cumDist[mid] <= d) lo = mid;
      else hi = mid - 1;
    }
    const idx = Math.min(lo, n - 2);
    
    const segStart = cumDist[idx];
    const segEnd = cumDist[idx + 1];
    const segLen = Math.max(0.001, segEnd - segStart);
    const u = clamp((d - segStart) / segLen, 0, 1);
    
    // Linear interpolation - no overshooting at corners
    const p0 = pts[idx];
    const p1 = pts[idx + 1];
    const lat = p0.lat + (p1.lat - p0.lat) * u;
    const lon = p0.lon + (p1.lon - p0.lon) * u;
    
    // Heading from segment direction
    const heading = Math.atan2(p1.lat - p0.lat, p1.lon - p0.lon);
    
    // Interpolate curvature between the two segment endpoints
    const curv = (curvature[idx] || 0) * (1 - u) + (curvature[idx + 1] || 0) * u;
    
    return { 
      lat, 
      lon, 
      idx, 
      u, 
      heading,
      curv,
      p0, 
      p1 
    };
  }
  
  // Get target distance based on playback time
  _getTargetDistance(pts, cumDist, totalDist, t) {
    const tMin = pts[0].tMs;
    const tMax = pts[pts.length - 1].tMs;
    
    if (t <= tMin) return 0;
    if (t >= tMax) return totalDist;
    
    // Binary search for segment containing time t
    let lo = 1, hi = pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].tMs >= t) hi = mid;
      else lo = mid + 1;
    }
    
    const p0 = pts[lo - 1];
    const p1 = pts[lo];
    const dtMs = Math.max(1, p1.tMs - p0.tMs);
    const u = clamp((t - p0.tMs) / dtMs, 0, 1);
    
    // Interpolate distance
    const d0 = cumDist[lo - 1];
    const d1 = cumDist[lo];
    return d0 + (d1 - d0) * u;
  }

  _playbackSampleForMobile(m, nowPerfMs) {
    const id = m && m.id != null ? String(m.id) : "";
    if (!id) return null;
    const t = this._playbackNowMs;
    if (t == null || !isFinite(t)) return null;

    const pts = this._playbackPtsById.get(id);
    if (!pts || pts.length < 1) return null;

    const tMin = pts[0].tMs;
    const tMax = pts[pts.length - 1].tMs;
    if (!isFinite(tMin) || !isFinite(tMax)) return null;

    // Single point: always return that point
    if (pts.length === 1) {
      const p = pts[0];
      return { lat: p.lat, lon: p.lon, m: p.m, readings: p.readings, beforeFirst: t < tMin, afterLast: t > tMax };
    }

    // Get raw path geometry for physics (distance, curvature from original GPS points)
    const { cumDist, totalDist, curvature } = this._getPathDistances(id, pts);
    
    // Target distance along raw path based on playback time
    const targetD = this._getTargetDistance(pts, cumDist, totalDist, t);
    
    // Get physics state and determine reference distance for sliding window
    const phys = this._getPhysicsState(id);
    // Use phys.d if initialized, otherwise use targetD (where we WILL be)
    const refD = (phys.d > 0) ? phys.d : targetD;
    
    // Find index corresponding to reference distance
    let vehicleIdx = 0;
    for (let i = 0; i < cumDist.length - 1; i++) {
      if (cumDist[i + 1] >= refD) {
        vehicleIdx = i;
        break;
      }
      vehicleIdx = i;
    }
    
    // Get sliding window of smoothed waypoints around vehicle position
    const playbackSpeed = this._playbackSpeed || 1.0;
    const waypointWindow = this._getWaypointWindow(id, pts, vehicleIdx, playbackSpeed);
    const smoothWaypoints = waypointWindow?.waypoints || pts;
    const smoothCumDist = waypointWindow?.cumDist || cumDist;
    
    // Vehicle physics parameters
    const vp = this._getVehiclePhysics(id);
    
    // Detect scrubbing: if playback time jumped significantly, snap to new position
    const lastPlaybackT = phys.lastPlaybackT || t;
    const playbackDt = t - lastPlaybackT;
    const isScrub = Math.abs(playbackDt) > 2000; // >2 second jump = scrub
    phys.lastPlaybackT = t;
    
    // Wall-clock dt for physics integration
    const dtS = (phys.lastPerfMs != null && isFinite(phys.lastPerfMs)) 
      ? Math.min(0.1, Math.max(0, (nowPerfMs - phys.lastPerfMs) / 1000))
      : 0.016;
    phys.lastPerfMs = nowPerfMs;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CONTROL SCALAR: A unified control function σ(ε, ω) where:
    //   ε = normalized position error (vehicle position relative to target)
    //   ω = playback speed multiplier (user's tempo setting)
    //
    // The control scalar modulates ALL vehicle physics as a single "throttle":
    //   σ → 0: vehicle stops/crawls (ahead of target, waiting)
    //   σ → 1: vehicle at natural pace (synchronized with playback)
    //   σ → boost: vehicle accelerates (behind target, catching up)
    //
    // This is essentially a proportional controller with soft saturation,
    // allowing granular pathfinding without complex heuristics.
    // ═══════════════════════════════════════════════════════════════════════════
    
    // (playbackSpeed already declared above for waypoint window)
    
    // Normalized position error: ε = (targetD - vehicleD) / referenceDistance
    // Positive = behind target (need to catch up)
    // Negative = ahead of target (need to wait)
    // We normalize by the base lookahead to get a dimensionless error in [-∞, +∞]
    const positionError = (targetD - phys.d) / MapView.TRAIL_LOOKAHEAD_BASE;
    
    // Control scalar function using soft-plus / sigmoid blend:
    // σ(ε, ω) = ω · response(ε)
    //
    // response(ε) uses a piecewise smooth function:
    //   ε < -1: response → 0 (way ahead, stop)
    //   ε = 0:  response → 1 (synchronized)
    //   ε > +1: response → 1 + boost (behind, catch up)
    //
    // We use: response(ε) = max(0, 1 + tanh(ε · gain))
    // This gives smooth S-curve behavior with natural saturation.
    
    const controlGain = 1.5;  // How aggressively to respond to position error
    const maxBoost = 2.0;     // Maximum catch-up multiplier when far behind
    
    // Smooth response function: tanh provides natural saturation at extremes
    // Shifted so response(0) = 1, response(-∞) → 0, response(+∞) → 1 + maxBoost
    const tanhResponse = Math.tanh(positionError * controlGain);
    const response = Math.max(0, 1 + tanhResponse * (tanhResponse > 0 ? maxBoost : 1));
    
    // Final control scalar: combines playback speed with position-based response
    // Use sqrt(playbackSpeed) for sub-linear scaling (feels more natural)
    const controlScalar = Math.sqrt(Math.max(1, playbackSpeed)) * response;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // Apply control scalar to all physics parameters
    // ═══════════════════════════════════════════════════════════════════════════
    
    const effectiveCruise = vp.cruiseSpeed * controlScalar;
    // Scale curve speed sub-linearly so we slow down relatively more when fast-forwarding
    // This ensures turns look like turns even at 20x speed
    const effectiveCurve = vp.curveSpeed * Math.pow(controlScalar, 0.75);
    const effectiveAccel = vp.accelRate * controlScalar;
    const effectiveBrake = vp.brakeRate * Math.max(1, controlScalar); // Braking never reduced
    
    // The "visible road" ends at targetD (the playback-time position).
    // Vehicle must NEVER exceed this - it tracks playback time exactly.
    // The control scalar allows catching up when behind, but never running ahead.
    // (Removed dynamic lookahead which caused vehicles to outrun the revealed trail.)
    const visibleEnd = Math.min(targetD, totalDist);
    
    // Initialize or handle scrub: snap to target, reset velocity
    // Also snap if physics hasn't been initialized yet (d=0 but targetD is far ahead)
    const needsSnap = phys.totalDist !== totalDist || isScrub || 
                      (phys.d === 0 && targetD > 100); // Snap if >100m behind on init
    if (needsSnap) {
      phys.totalDist = totalDist;
      phys.d = targetD;
      phys.v = 0; // Start from rest after scrub
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // AUTONOMOUS AGENT PHYSICS (modulated by control scalar)
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Look ahead for curves and calculate safe approach speed
    // Instead of just finding max curvature, we find the most restrictive speed limit
    // based on distance to each curve.
    // v_safe = sqrt(v_curve^2 + 2 * a_brake * distance)
    
    const lookaheadDist = MapView.CURVATURE_LOOKAHEAD * Math.max(1, controlScalar);
    const curveLookaheadEnd = Math.min(phys.d + lookaheadDist, totalDist);
    
    // Start scanning from the vehicle's current segment
    let safeSpeed = effectiveCruise;
    
    for (let i = vehicleIdx; i < curvature.length; i++) {
      const d = cumDist[i];
      if (d < phys.d) continue; // Skip points behind us
      if (d > curveLookaheadEnd) break; // Stop at lookahead horizon
      
      const curv = curvature[i];
      if (curv <= 0.001) continue; // Skip straights
      
      // Calculate speed limit for this specific curve point
      const curvFactor = MapView.CURVATURE_THRESHOLD / (MapView.CURVATURE_THRESHOLD + curv);
      const allowedSpeedAtCurve = effectiveCurve + (effectiveCruise - effectiveCurve) * curvFactor;
      
      // Calculate max speed allowed NOW to safely brake to that speed by distance d
      // v_now = sqrt(v_target^2 + 2 * a * d)
      const distToCurve = d - phys.d;
      const maxApproachSpeed = Math.sqrt(allowedSpeedAtCurve * allowedSpeedAtCurve + 2 * effectiveBrake * distToCurve);
      
      if (maxApproachSpeed < safeSpeed) {
        safeSpeed = maxApproachSpeed;
      }
    }
    
    // Calculate target speed based on:
    // 1. Distance to end of visible road (brake to stop)
    // 2. Safe speed for curves ahead (calculated above)
    // 3. Effective cruise speed (modulated by control scalar)
    const distToVisibleEnd = visibleEnd - phys.d;
    
    let targetSpeed;
    if (distToVisibleEnd <= 0) {
      // Already at or past visible end - full stop
      targetSpeed = 0;
    } else if (distToVisibleEnd < MapView.STOP_BUFFER) {
      // Very close to visible end - slow crawl proportional to distance
      targetSpeed = Math.min(2 * Math.max(1, controlScalar), distToVisibleEnd * 0.5);
    } else {
      // Distance-limited speed: v² = 2as → v = sqrt(2 * brakeRate * distance)
      // Use a safety factor of 0.8 to ensure we don't overshoot
      const brakeSpeed = Math.sqrt(2 * effectiveBrake * Math.max(0, distToVisibleEnd - MapView.STOP_BUFFER)) * 0.8;
      
      // Take minimum of all limits
      targetSpeed = Math.min(effectiveCruise, brakeSpeed, safeSpeed);
    }
    
    // Apply acceleration or braking (both scaled by control scalar)
    if (phys.v < targetSpeed) {
      // Accelerate
      phys.v = Math.min(targetSpeed, phys.v + effectiveAccel * dtS);
    } else if (phys.v > targetSpeed) {
      // Brake (never reduced below base rate for safety)
      phys.v = Math.max(targetSpeed, phys.v - effectiveBrake * dtS);
    }
    
    // Safety clamps
    phys.v = clamp(phys.v, 0, effectiveCruise);
    
    // Update position - but don't exceed visible end
    const proposedD = phys.d + phys.v * dtS;
    if (proposedD >= visibleEnd) {
      // Would overshoot - clamp to visible end and stop
      phys.d = visibleEnd;
      phys.v = 0;
    } else {
      phys.d = proposedD;
    }
    
    // Cannot go backwards or past total path end
    phys.d = clamp(phys.d, 0, totalDist);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // WAYPOINT STEERING: Vehicle has 2D position that steers toward waypoints
    // instead of being locked to a rail. The physics distance (phys.d) determines
    // which waypoint to target, but the actual position uses steering dynamics.
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Sample raw path position (where GPS says we should be)
    const rawSample = this._samplePathAtDistance(pts, cumDist, curvature, phys.d);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // PROGRESSIVE SPLINE SAMPLING
    // 
    // The waypoint window now comes from a PROGRESSIVE spline path where:
    // - Past segments are LOCKED (computed with tension at time of traversal)
    // - Future segments use CURRENT tension (based on current speed)
    // 
    // The vehicle samples its position from this progressive path, which is
    // indexed by cumulative distance. We map phys.d (raw GPS distance) to the
    // progressive path's cumulative distance.
    // ═══════════════════════════════════════════════════════════════════════════
    
    let waypointSample;
    if (waypointWindow && smoothWaypoints.length >= 2) {
      // The progressive path has its own cumulative distances
      // Map phys.d (distance on raw GPS) to progressive path distance
      //
      // Strategy: Find the computed path point corresponding to our raw distance
      // by interpolating based on rawIdx values in the computed points
      
      // Get the full progressive path for this vehicle
      const path = this._vehiclePathById?.get(id);
      if (path && path.computedPts.length >= 2) {
        const cpts = path.computedPts;
        const ccum = path.cumDist;
        
        // Find where phys.d falls in raw GPS cumDist
        let rawIdx = 0;
        let rawFrac = 0;
        for (let i = 0; i < cumDist.length - 1; i++) {
          if (cumDist[i + 1] >= phys.d) {
            rawIdx = i;
            const segLen = cumDist[i + 1] - cumDist[i];
            rawFrac = segLen > 0 ? (phys.d - cumDist[i]) / segLen : 0;
            break;
          }
          rawIdx = i;
        }
        const rawIdxFrac = rawIdx + rawFrac;
        
        // Find corresponding position in computed path
        let compIdx = 0;
        for (let i = 0; i < cpts.length - 1; i++) {
          if (cpts[i + 1].rawIdx >= rawIdxFrac) {
            compIdx = i;
            break;
          }
          compIdx = i;
        }
        
        // Interpolate between computed points
        const cp0 = cpts[compIdx];
        const cp1 = cpts[Math.min(cpts.length - 1, compIdx + 1)];
        const rawIdxSpan = cp1.rawIdx - cp0.rawIdx;
        const t = rawIdxSpan > 0 ? clamp((rawIdxFrac - cp0.rawIdx) / rawIdxSpan, 0, 1) : 0;
        
        waypointSample = {
          lat: cp0.lat + t * (cp1.lat - cp0.lat),
          lon: cp0.lon + t * (cp1.lon - cp0.lon),
          heading: Math.atan2(cp1.lat - cp0.lat, cp1.lon - cp0.lon),
          m: cp1.m,
          readings: cp1.readings
        };
      } else {
        waypointSample = rawSample;
      }
    } else {
      // Fallback: use raw sample
      waypointSample = rawSample;
    }
    
    // Initialize 2D physics state if needed (use needsSnap from earlier)
    if (phys.lat == null || phys.lon == null || needsSnap) {
      // Start at raw GPS position (not spline, to avoid teleport on speed change)
      phys.lat = rawSample.lat;
      phys.lon = rawSample.lon;
      phys.heading = rawSample.heading;
    }
    
    // Steering toward RAW GPS position with damping
    // This ensures vehicle never teleports when speed changes (spline recomputes).
    // Physics provides natural smoothing through steering inertia.
    const STEER_RATE = 3.0; // How fast to steer toward waypoint (higher = snappier)
    const steerFactor = 1 - Math.exp(-STEER_RATE * dtS);
    
    // Blend current position toward raw GPS sample
    phys.lat += steerFactor * (rawSample.lat - phys.lat);
    phys.lon += steerFactor * (rawSample.lon - phys.lon);
    
    // Smooth heading toward raw GPS heading
    let headingDiff = rawSample.heading - phys.heading;
    // Wrap to [-π, π]
    while (headingDiff > Math.PI) headingDiff -= 2 * Math.PI;
    while (headingDiff < -Math.PI) headingDiff += 2 * Math.PI;
    phys.heading += steerFactor * headingDiff;
    
    // Record actual vehicle path for debug visualization
    // This captures the dynamically computed steering path, not the waypoints
    if (this._pbDebugPath) {
      if (!this._vehicleActualPathById) this._vehicleActualPathById = new Map();
      let actualPath = this._vehicleActualPathById.get(id);
      if (!actualPath || needsSnap) {
        actualPath = [];
        this._vehicleActualPathById.set(id, actualPath);
      }
      // Record position at regular distance intervals to avoid excessive points
      const lastPt = actualPath.length > 0 ? actualPath[actualPath.length - 1] : null;
      const recordInterval = 2; // meters between recorded points
      if (!lastPt || Math.abs(phys.d - lastPt.d) >= recordInterval) {
        actualPath.push({ lat: phys.lat, lon: phys.lon, d: phys.d });
        // Limit buffer size - keep window around current position
        const maxBehind = 50; // points behind vehicle
        const maxAhead = 10; // points ahead (from scrub-back)
        while (actualPath.length > maxBehind + maxAhead) {
          // Remove oldest point if it's behind current position
          if (actualPath[0].d < phys.d - maxBehind * recordInterval) {
            actualPath.shift();
          } else {
            break;
          }
        }
      }
    }
    
    const lat = phys.lat;
    const lon = phys.lon;
    const heading = phys.heading;
    const { idx, u, p0, p1 } = rawSample;
    
    // Get segment info for readings and visibility (from raw path)
    const nextPoint = p1 || pts[Math.min(idx + 1, pts.length - 1)];
    const prevPoint = p0 || pts[idx];
    const dtMs = Math.max(1, (nextPoint.tMs - prevPoint.tMs));
    
    // Calculate vehicle's actual time position (for trail reveal)
    // Interpolate time based on position within segment
    const vehicleTMs = prevPoint.tMs + (nextPoint.tMs - prevPoint.tMs) * u;
    
    // Calculate true GPS speed for the current segment (real-world speed)
    // We use the raw segment (idx) that the vehicle is currently traversing
    let trueSpeedMps = 0;
    if (idx < pts.length - 1) {
      const pStart = pts[idx];
      const pEnd = pts[idx + 1];
      const distM = cumDist[idx + 1] - cumDist[idx];
      const timeS = (pEnd.tMs - pStart.tMs) / 1000;
      if (timeS > 0.1) {
        trueSpeedMps = distM / timeS;
      }
    }

    // Use true GPS speed for display, not the playback-scaled physics velocity
    // let speedMps = phys.v;
    let speedMps = trueSpeedMps;
    if (t >= tMax - 1) speedMps = 0;

    // Determine transient visibility
    let opacity = 1.0;
    const dimOpacity = 0.25;
    const movingFlag = !!(nextPoint && (nextPoint.m === 1 || nextPoint.m === "1" || nextPoint.m === true));
    const key = keyFor("mobile", m.id);
    const isSel = (this.selectedId === key);

    if (!movingFlag && !this._pbDebugPath && !isSel) {
      opacity = dimOpacity;
    }

    if (dtMs > 305000 && t > prevPoint.tMs + 5000 && t < nextPoint.tMs - 5000 && !this._pbDebugPath && !isSel) {
      opacity = dimOpacity;
    }

    // Use smooth spline heading (already in lat/lon space, convert to screen space)
    // The spline gives us dLat/dLon, but screen Y is inverted, so we need atan2(-dLat, dLon)
    // Actually heading is already atan2(dLat, dLon) from _samplePathAtDistance
    // We need to convert to screen heading which accounts for Mercator projection
    const currWorld = latLonToWorld(lat, lon, this.zoom);
    const epsilon = 0.0001;
    const aheadWorld = latLonToWorld(
      lat + Math.sin(heading) * epsilon, 
      lon + Math.cos(heading) * epsilon, 
      this.zoom
    );
    let dx = aheadWorld.x - currWorld.x;
    let dy = aheadWorld.y - currWorld.y;
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) {
      dx = 1e-3;
      dy = 0;
    }
    const screenHeading = Math.atan2(dy, dx);

    const absH = Math.abs(screenHeading);
    const dead = 0.22;
    const switchToLeft = (Math.PI / 2) + dead;
    const switchToRight = (Math.PI / 2) - dead;
    let side = this._traceLastSideById.get(id);
    if (side !== "L" && side !== "R") side = (absH > Math.PI / 2) ? "L" : "R";
    if (side === "R" && absH > switchToLeft) side = "L";
    else if (side === "L" && absH < switchToRight) side = "R";
    this._traceLastSideById.set(id, side);

    let renderAngle = screenHeading;
    if (side === "L") renderAngle = Math.PI - screenHeading;
    if (renderAngle > Math.PI) renderAngle -= Math.PI * 2;
    if (renderAngle < -Math.PI) renderAngle += Math.PI * 2;

    const wrapAngle = (ang) => {
      let x = ang;
      while (x > Math.PI) x -= Math.PI * 2;
      while (x < -Math.PI) x += Math.PI * 2;
      return x;
    };
    const prevA = this._traceAngleById.get(id);
    const lastMs = this._traceAngleLastMsById.get(id);
    const dtAngleS = (lastMs != null && isFinite(lastMs)) ? Math.max(0, (nowPerfMs - lastMs) / 1000) : 0;
    const tauS = 0.25; // Slightly faster angle response for responsiveness
    const alpha = dtAngleS > 0 ? (1 - Math.exp(-dtAngleS / tauS)) : 1;
    const nextA = (prevA == null)
      ? renderAngle
      : wrapAngle(prevA + wrapAngle(renderAngle - prevA) * alpha);
    this._traceAngleById.set(id, nextA);
    this._traceAngleLastMsById.set(id, nowPerfMs);

    // Marker reading: use the segment at the PHYSICS position (phys.d), not time position.
    // idx and nextPoint are from _samplePathAtDistance(phys.d) - they match where the marker is drawn.
    const reading = primaryReadingKeyedFromPoint(nextPoint);

    // Store debug info for trail drawing
    if (!this._vehicleRevealDist) this._vehicleRevealDist = new Map();
    this._vehicleRevealDist.set(id, {
      d: targetD,                // Playback-time position
      visibleEnd,                // Where vehicle stops (= targetD, no lookahead)
      vehicleD: phys.d,          // Actual vehicle position (for debug)
      vehicleV: phys.v,          // Actual vehicle velocity (for debug)
      vehicleTMs,                // Actual vehicle time (for trail reveal)
      controlScalar,             // Control scalar σ(ε, ω) for debug
      positionError,             // Normalized position error ε
      totalDist
    });

    return { lat, lon, angle: nextA, flipX: (side === "L"), speedMps, opacity, reading, beforeFirst: t < tMin };
  }

  _ensureTracePoints(state) {
    const key = this._tracePointsKeyForState(state);
    if (this._tracePtsKey === key) return;
    this._tracePtsKey = key;

    const nextPtsById = new Map();
    const nextRoutesById = new Map();
    const mobiles = Array.isArray(state?.mobile) ? state.mobile : [];
    for (const m of mobiles) {
      const id = m && m.id ? String(m.id) : "";
      if (!id) continue;

      // Idle/ghosted vehicles should not produce trace routes.
      // Clear any prior active/pending route so the marker stays stationary.
      if (m && m.ghosted) {
        this._traceActiveRouteById.delete(id);
        this._tracePendingRouteById.delete(id);
        this._traceCycleStartMsById.delete(id);
        continue;
      }

      const trail = Array.isArray(m?.trail) ? m.trail : [];
      const pts = [];
      const hasServerTrail = (trail.length >= 2);
      const hasActiveRoute = this._traceActiveRouteById.has(id);
      const persisted = (this._persistedTrailById.get(id)?.trail || []);

      // If the server drops history for a cycle (refresh/TTL/etc), do NOT replace
      // an active route with a tiny cached tail. Keep the last route so the bus
      // stays on its path until we have a real trail again.
      if (!hasServerTrail && hasActiveRoute) {
        this._tracePendingRouteById.delete(id);
        continue;
      }

      // Trace mode should replay the full path accumulated since the app started.
      // Prefer persisted trail (which accumulates) when available; otherwise fall back to server trail.
      const src = (persisted.length >= 2) ? persisted : trail;
      if (src.length < 2) continue;

      // Build time-aware points. If timestamps are missing, synthesize a stable time series.
      const t0 = (src[0] && typeof src[0].t === "string") ? parseUtcMs(src[0].t) : null;
      const baseMs = (t0 != null) ? t0 : 0;
      const synthStepMs = 3000;

      for (let i = 0; i < src.length; i++) {
        const p = src[i];
        const lat = Number(p.lat), lon = Number(p.lon);
        if (!isFinite(lat) || !isFinite(lon)) continue;
        const tMsRaw = (p && typeof p.t === "string") ? parseUtcMs(p.t) : null;
        const tMs = (tMsRaw != null) ? tMsRaw : (baseMs + (i * synthStepMs));
        pts.push({ lat, lon, tMs, m: p.m });
      }

      if (pts.length >= 2) {
        nextPtsById.set(id, pts);

        // Precompute a smoothed, bus-like time model:
        // - Base on real GPS time deltas when present (relative speed changes)
        // - Normalize to a watchable speed (so sparse GPS doesn't crawl)
        // - Low-pass filter speeds so accel/brake is gradual
        // - Add dwell time for stop-like segments
        const pauseMs = 5000;
        const vmax = Number(this._traceMaxSpeedMps) || 18;
        const realVmax = Number(this._traceRealMaxSpeedMps) || 20.0;
        const targetMedian = Number(this._traceTargetMedianSpeedMps) || 7.0;
        const tau = Number(this._traceSpeedSmoothingTauS) || 1.6;
        const stopV = Number(this._traceStopSpeedMps) || 0.25;
        const dwellCompress = Number(this._traceDwellTimeCompression) || 12.0;
        const stopMinMs = Number(this._traceStopMinMs) || 350;
        const stopMaxMs = Number(this._traceStopMaxMs) || 3500;

        // First pass: derive raw speeds from GPS timing.
        const rawV = [];
        const distM = [];
        const dtRawS = [];
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i];
          const b = pts[i + 1];
          const dist = haversineMeters(a.lat, a.lon, b.lat, b.lon);
          let dtRaw = (b.tMs - a.tMs);
          if (!isFinite(dtRaw) || dtRaw <= 0) dtRaw = synthStepMs;
          const dtS = Math.max(0.2, dtRaw / 1000);
          const v = dist / dtS;
          distM.push(dist);
          dtRawS.push(dtS);
          rawV.push(isFinite(v) ? v : 0);
        }

        // Robust scale: map median moving speed to targetMedian.
        const moving = rawV
          .map((v, i) => ({ v, i }))
          .filter(x => isFinite(x.v) && x.v > 0.4 && distM[x.i] > 8);
        let scale = 1.0;
        if (moving.length >= 3) {
          const sorted = moving.map(x => x.v).sort((a, b) => a - b);
          const mid = Math.floor(sorted.length / 2);
          const med = (sorted.length % 2) ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
          if (isFinite(med) && med > 0.001) {
            scale = clamp(targetMedian / med, 0.8, 25.0);
          }
        }

        const segStartMs = [];
        const segDurMs = [];
        const segSpeedMps = []; // playback effective speed (m/s)
        const segRealSpeedMps = []; // GPS-derived speed (m/s)
        let tCum = 0;
        let vSmooth = 0;
        let vRealSmooth = 0;

        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i];
          const b = pts[i + 1];
          const dist = distM[i] || 0;
          const dtS = dtRawS[i] || 1.0;

          // Target speed from GPS, normalized to watchable playback.
          let vTarget = rawV[i] * scale;
          if (!isFinite(vTarget)) vTarget = 0;
          vTarget = clamp(vTarget, 0, vmax);

          const isStopLike = (dist < 3) || (vTarget < stopV);

          const alpha = 1 - Math.exp(-dtS / tau);
          vSmooth = vSmooth + alpha * (vTarget - vSmooth);

          let dtEff;
          if (isStopLike) {
            // Dwell based on how long the GPS stayed "there", but compressed.
            dtEff = (dtS * 1000) / Math.max(1.0, dwellCompress);
            dtEff = clamp(dtEff, stopMinMs, stopMaxMs);
            segSpeedMps.push(0);
            segRealSpeedMps.push(0);
          } else {
            const vEff = Math.max(0.8, Math.min(vSmooth, vmax));
            dtEff = (dist / vEff) * 1000;
            dtEff = clamp(dtEff, 120, 8000);
            segSpeedMps.push(dist > 0 ? (dist / Math.max(0.001, dtEff / 1000)) : 0);

            // Real-world speed estimate from GPS timing (not normalized playback).
            let vReal = rawV[i];
            if (!isFinite(vReal)) vReal = 0;
            vReal = clamp(vReal, 0, realVmax);
            const alphaReal = 1 - Math.exp(-dtS / Math.max(0.8, tau));
            vRealSmooth = vRealSmooth + alphaReal * (vReal - vRealSmooth);
            segRealSpeedMps.push(clamp(vRealSmooth, 0, realVmax));
          }

          segStartMs.push(tCum);
          segDurMs.push(dtEff);
          tCum += dtEff;
        }

        const driveMs = Math.max(1, tCum);

        // NOTE: "rewind at the end of time" logic (loop return) is intentionally disabled.
        // This used to add a fast "return" segment after reaching the end, which makes the
        // playback jump back toward the loop start.
        //
        // // Prevent loop "teleport": after pausing at the end, drive back to the loop start quickly.
        // const loopStartPt = pts[0];
        // const endPt = pts[pts.length - 1] || loopStartPt;
        // const backDistM = haversineMeters(endPt.lat, endPt.lon, loopStartPt.lat, loopStartPt.lon);
        // const returnMs = (isFinite(backDistM) && backDistM > 3)
        //   ? clamp(1000 + (backDistM / 250) * 1000, 1000, 3000)
        //   : 0;
        // const totalMsWithReturn = driveMs + pauseMs + returnMs;

        const loopStartPt = pts[0];
        const returnMs = 0;
        const totalMsWithReturn = driveMs + pauseMs;

        nextRoutesById.set(id, {
          pts,
          segStartMs,
          segDurMs,
          segSpeedMps,
          segRealSpeedMps,
          driveMs,
          pauseMs,
          returnMs,
          loopStartLat: loopStartPt.lat,
          loopStartLon: loopStartPt.lon,
          totalMs: totalMsWithReturn,
          newPathStartMs: 0,
        });
      }
    }

    // Replace the points cache for debugging/introspection purposes.
    this._tracePtsById.clear();
    for (const [id, pts] of nextPtsById.entries()) this._tracePtsById.set(id, pts);

    // Route swapping behavior:
    // - If we don't have an active route for an id, adopt immediately.
    // - If we do, store as pending and swap only when the loop restarts.
    for (const [id, route] of nextRoutesById.entries()) {
      if (this._traceActiveRouteById.has(id)) this._tracePendingRouteById.set(id, route);
      else this._traceActiveRouteById.set(id, route);
    }
  }

  _overlayStaticKeyForState(state) {
    const w = this._cssW || 1;
    const h = this._cssH || 1;
    const z = Number(this.zoom);
    const clat = Number(this.center?.lat);
    const clon = Number(this.center?.lon);
    const sel = this.selectedId || "";
    const fixed = 1;
    const revKey = this._tracePointsKeyForState(state);
    // Include persisted trail rev so cached overlay updates even when the server drops history.
    const persistKey = `persist:${this._persistedTrailRev}`;
    return `${revKey}|${persistKey}|w:${w}|h:${h}|z:${z.toFixed(4)}|c:${clat.toFixed(6)},${clon.toFixed(6)}|sel:${sel}|fixed:${fixed}`;
  }

  /**
   * Collect trail data for rendering. Shared by both _ensureOverlayStatic and drawOverlay.
   * Returns { pts, cols, times, trail, isGhost } or null if trail is invalid.
   */
  _collectTrailData(m, toScreen) {
    const id = m && m.id != null ? String(m.id) : "";
    
// Get reveal time (for clipping trail at vehicle position)
    // Use playback time directly - vehicle physics are synced to this
    const pbTimeMs = this.getPlaybackTimeMs();
    const revealTimeMs = pbTimeMs;
    
    // Get trail source
    // In playback mode, always prefer server trail for fresh readings/colors.
    // Persisted trail is only used in non-playback live mode for continuity.
    const serverTrail = Array.isArray(m?.trail) ? m.trail : [];
    const hasServerTrail = serverTrail.length >= 2;
    const useServerTrail = this.playbackMode || hasServerTrail;
    const persistedTrail = (id && !this._historicalMode && !this.playbackMode) ? (this._persistedTrailById.get(id)?.trail || []) : [];
    const trail = useServerTrail ? (hasServerTrail ? serverTrail : persistedTrail) : (persistedTrail.length >= 2 ? persistedTrail : serverTrail);
    if (!Array.isArray(trail) || trail.length < 2) return null;
    
    const isGhost = !!m.ghosted;
    const pts = [];
    const cols = [];
    const times = [];
    
    const getSp = toScreen || this.worldToScreen.bind(this);
    const ws = worldSizeForZoom(this.zoom);
    
    const shouldClipTrail = revealTimeMs != null && isFinite(revealTimeMs);
    let prevTMs = null;
    let prevU = null, prevV = null;
    
    for (let i = 0; i < trail.length; i++) {
      const p = trail[i];
      
      // Get normalized world coordinates (cached on point)
      let u = p._u, v = p._v;
      if (u === undefined) {
        const lat = Number(p.lat), lon = Number(p.lon);
        if (p.lat == null || p.lon == null || !isFinite(lat) || !isFinite(lon)) {
          pts.push(null);
          cols.push(null);
          times.push(null);
          prevTMs = null;
          prevU = null;
          prevV = null;
          continue;
        }
        const norm = latLonToNorm(lat, lon);
        u = norm.u; v = norm.v;
        p._u = u; p._v = v;
      }
      
      // Get timestamp (cached on point)
      let tMs = p?._tMs;
      if (tMs === undefined) {
        tMs = (p && typeof p.t === "string") ? parseUtcMs(p.t) : null;
        try { p._tMs = tMs; } catch {}
      }
      
      // Get color from point's recorded readings ONLY (immutable historical data)
      const pr = primaryReadingFromPoint(p);
      const base = safeHex(pr?.color);
      
      // Calculate screen position
      const sp = getSp(u * ws, v * ws);

      // Clip trail at vehicle's time position
      if (shouldClipTrail && tMs != null && isFinite(tMs) && tMs > revealTimeMs) {
        if (prevTMs != null && isFinite(prevTMs) && prevTMs <= revealTimeMs && prevU != null && prevV != null) {
          const dt = tMs - prevTMs;
          const t = dt > 0 ? (revealTimeMs - prevTMs) / dt : 0;
          const interpU = prevU + t * (u - prevU);
          const interpV = prevV + t * (v - prevV);
          pts.push(getSp(interpU * ws, interpV * ws));
          // Use destination point's color for the clipped segment
          cols.push(base);
          times.push(revealTimeMs);
        }
        break; // Stop collecting
      }
      
      pts.push(sp);
      cols.push(base);
      times.push(tMs);
      
      prevTMs = tMs;
      prevU = u;
      prevV = v;
    }
    
    if (pts.length < 2) return null;
    return { pts, cols, times, trail, isGhost };
  }

  _ensureOverlayStatic(state) {
    const dpr = this._dpr || (window.devicePixelRatio || 1);
    const cssW = this._cssW || 1;
    const cssH = this._cssH || 1;
    const key = this._overlayStaticKeyForState(state);
    if (!this._overlayStaticDirty && this._overlayStaticCanvas && this._overlayStaticKey === key) return;
    this._overlayStaticDirty = false;
    this._overlayStaticKey = key;

    if (!this._overlayStaticCanvas) this._overlayStaticCanvas = document.createElement("canvas");
    this._overlayStaticCanvas.width = Math.floor(cssW * dpr);
    this._overlayStaticCanvas.height = Math.floor(cssH * dpr);
    const ctx = this._overlayStaticCanvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    if (!state) return;
    const mobiles = Array.isArray(state.mobile) ? state.mobile : [];
    const fixed = Array.isArray(state.fixed) ? state.fixed : [];

    // Precompute center world once; avoid repeated center projection.
    const centerW = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
    const worldToScreenFast = (wx, wy) => ({ x: wx - centerW.x + cssW / 2, y: wy - centerW.y + cssH / 2 });

    // Fixed markers - same interaction model as mobile
    if (this.showFixed) {
    for (const f of fixed) {
        const lat = Number(f.lat), lon = Number(f.lon);
        if (!isFinite(lat) || !isFinite(lon)) continue;
        const wpt = latLonToWorld(lat, lon, this.zoom);
        const sp = worldToScreenFast(wpt.x, wpt.y);
        if (sp.x < -50 || sp.y < -50 || sp.x > cssW + 50 || sp.y > cssH + 50) continue;

        const keyF = keyFor("fixed", f.id);
        const isSel = (this.selectedId === keyF);
        const emoji = f.emoji || "📍";
        const label = (f.name && f.name.length && String(f.name) !== String(f.id)) ? `${f.id} (${f.name})` : f.id;
        const color = safeHex(f.color);
        const pr = primaryReadingForSensor(f);

        // halo
        ctx.save();
        ctx.beginPath();
        ctx.fillStyle = isSel ? "rgba(16, 20, 28, 0.78)" : "rgba(16, 20, 28, 0.68)";
        ctx.arc(sp.x, sp.y, 16, 0, Math.PI * 2);
        ctx.fill();
        // Border matches AQI color (like label pills)
        ctx.strokeStyle = isSel ? "rgba(108,195,255,0.90)" : safeHex((pr && pr.color) || color);
        ctx.lineWidth = 2.0;
        ctx.stroke();

        // emoji
        ctx.font = "20px Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(emoji, sp.x, sp.y);

        // label pill (2 lines): ID line (white) + reading value line (colored)
        // Use web-safe font stack that works reliably on iOS Safari
        ctx.font = "600 12px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
        const line1 = label;
        const line2Key = pr.key ? String(pr.key) : "";
        const line2Val = formatTagValue(pr.value);
        // Ensure we have actual text widths (iOS Safari can return 0 for some fonts)
        const m1 = ctx.measureText(line1);
        const m2a = ctx.measureText(line2Key ? `${line2Key} ` : "");
        const m2b = ctx.measureText(line2Val);
        const m1w = m1.width > 0 ? m1.width : (line1.length * 7);
        const m2aw = m2a.width > 0 ? m2a.width : ((line2Key ? line2Key.length + 1 : 0) * 7);
        const m2bw = m2b.width > 0 ? m2b.width : (line2Val.length * 7);
        const padX = 8;
        const bw = Math.max(m1w, (m2aw + m2bw)) + padX * 2;
        const bh = (line2Key || line2Val) ? 30 : 18;
        const bx = sp.x - bw / 2;
        const by = sp.y + 18;
        ctx.fillStyle = "rgba(16, 20, 28, 0.82)";
        ctx.strokeStyle = safeHex((pr && pr.color) || color);
        ctx.lineWidth = 1.8;
        roundRect(ctx, bx, by, bw, bh, 9);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#e8eef7";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const padY = 4;
        const lineH = (bh - padY * 2) / ((line2Key || line2Val) ? 2 : 1);
        const y1 = by + padY + lineH * 0.5;
        const y2 = by + padY + lineH * 1.5;
        ctx.fillText(line1, sp.x, y1);
        if (line2Key || line2Val) {
          // draw key in muted, value in pollutant color - use safe widths
          const x0 = sp.x - (m2aw + m2bw) / 2;
          ctx.fillStyle = "rgba(232,238,247,0.70)";
          ctx.fillText(line2Key ? `${line2Key} ` : "", x0 + m2aw / 2, y2);
          ctx.fillStyle = pr.color || "#ffffff";
          ctx.fillText(line2Val, x0 + m2aw + m2bw / 2, y2);
        }
        ctx.restore();
    }
    } // end if showFixed

    // Trails:
    const sel = parseKey(this.selectedId);
    const hasSelectedMobile = (sel && sel.type === "mobile" && sel.id);
    const selectedId = hasSelectedMobile ? sel.id : null;

    const drawTrailFor = (m, alphaMul, toScreen) => {
      const id = m && m.id != null ? String(m.id) : "";
      const isLive = !this.playbackMode;
      
      // Use shared trail collection logic
      const data = this._collectTrailData(m, toScreen);
      if (!data) return false;
      const { pts, cols, times, trail, isGhost } = data;
      
      const isSel2 = (selectedId && m.id === selectedId);

      // Tail fade should be based on the *visible* (drawn) trail only.
      // Otherwise, long idle/hidden periods (which are rendered transparent) stretch the time window
      // and the "new tail" appears to not fade.
      let visMinT = Infinity, visMaxT = -Infinity;
      for (let i = 1; i < pts.length; i++) {
        if (!pts[i - 1] || !pts[i]) continue;
        const p1 = trail[i];
        // IMPORTANT: "moving" must be explicit. Missing/undefined m is treated as idle.
        const isMoving = !!(p1 && (p1.m === 1 || p1.m === "1" || p1.m === true));
        const willDraw = this._pbDebugPath || isMoving;
        if (!willDraw) continue;
        const t1 = times[i];
        if (t1 != null && isFinite(t1)) {
          if (t1 < visMinT) visMinT = t1;
          if (t1 > visMaxT) visMaxT = t1;
        }
      }
      // Fallback: if we can't compute visible bounds, use the whole set.
      if (!(visMaxT > visMinT)) {
        for (const t of times) {
          if (t != null && isFinite(t)) {
            if (t < visMinT) visMinT = t;
            if (t > visMaxT) visMaxT = t;
          }
        }
      }
      const totalDur = (visMaxT > visMinT) ? (visMaxT - visMinT) : 0;

      const alpha = (isSel2 ? 1.0 : 0.85) * alphaMul;
      const lw = isSel2 ? 4.2 : 3.4;
      const dash = [2, 10];

      // Tail fade tuning:
      // Fade is strictly time-based decay:
      // - total decay window: 45 minutes
      // - fade begins only in the last 20% of that window (tail)
      const FADE_TIME_MS = 20 * 60 * 1000; // 20 minutes -> fully expired
      const FADE_TAIL_FRAC = 0.20; // fade over the last 20% of FADE_TIME_MS
      const FADE_START_FRAC = 1.0 - FADE_TAIL_FRAC; // e.g. 0.80
      // Reference time: use playback time, trail's max time, or playback bounds (NOT wall clock)
      const livePlaybackTimeMs = this.getPlaybackTimeMs();
      const hasPlaybackTime = livePlaybackTimeMs != null && isFinite(livePlaybackTimeMs);
      const pbBounds = this.getPlaybackBounds();
      const boundsMaxMs = (pbBounds.maxMs != null && isFinite(pbBounds.maxMs)) ? pbBounds.maxMs : null;
      const refNowMs = hasPlaybackTime ? Number(livePlaybackTimeMs) 
        : (isFinite(visMaxT) ? visMaxT 
        : (boundsMaxMs != null ? boundsMaxMs 
        : this._dataNowMs()));

      for (let i = 1; i < pts.length; i++) {
        if (!pts[i - 1] || !pts[i]) continue;

        // Use the 'm' (moving) flag from the server point to determine if
        // this segment should be hidden/faded (jitter) or bright (historical data).
        const trailPt = trail[i];
        // IMPORTANT: "moving" must be explicit. Missing/undefined m is treated as idle.
        const isMoving = !!(trailPt && (trailPt.m === 1 || trailPt.m === "1" || trailPt.m === true));
        
        const segColor0 = cols[i] || cols[i - 1] || "#ffffff";
        let segColor = segColor0;
        let alphaMul2 = 1.0;

        if (!isMoving) {
          if (this._pbDebugPath) {
            segColor = dimHex(segColor0, 0.25);
          } else {
            // Previously hidden: keep visible, but fade + desaturate.
            segColor = desatHex(dimHex(segColor0, 0.35), 0.30);
            alphaMul2 = 0.5;
          }
        } else if (isGhost && isLive) {
          segColor = desatHex(dimHex(segColor0, 0.65), 0.25); // Dim + slight desat for offline sensors
          alphaMul2 = 0.5;
        }

        // colored segment
        ctx.save();
        const t1 = times[i];
        if (!(t1 != null && isFinite(t1) && isFinite(refNowMs))) {
          ctx.restore();
          continue;
        }

        // Hide leading trail: skip points ahead of the vehicle's time position (unless debug)
        // (Trail is already clipped during collection, but this handles edge cases)

        const ageMs = Math.max(0, Number(refNowMs) - Number(t1));
        const fTime = clamp(ageMs / Math.max(1, FADE_TIME_MS), 0, 1);

        // Fully expired => don't render (keep in data).
        if (fTime >= 1) {
          ctx.restore();
          continue;
        }

        // Fade only in the last 20% of the decay window.
        let tailAlpha = 1.0;
        if (fTime > FADE_START_FRAC) {
          const u = clamp((fTime - FADE_START_FRAC) / Math.max(1e-6, FADE_TAIL_FRAC), 0, 1);
          // Keep the head bright; push the very tail toward invisible.
          tailAlpha = Math.pow(1 - u, 2);
        }

        if (tailAlpha <= 0.01) {
          ctx.restore();
          continue;
        }

        ctx.globalAlpha = alpha * tailAlpha * alphaMul2;
        ctx.strokeStyle = segColor;
        ctx.lineWidth = lw;
        ctx.setLineDash(dash);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        
        const p0 = pts[i - 1];
        const p1 = pts[i];
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
        ctx.restore();
      }

      return true;
    };

    // Note: we intentionally do not render trails for mobiles missing from the payload.
    // When a mobile disappears, we prune its cached state so it can't return on a stale route.

    const mobileHasServerTrail = (m) => {
      const t = Array.isArray(m?.trail) ? m.trail : [];
      return t.length >= 2;
    };

    // Draw order: oldest trails first, newest trails last, so newly-arrived data is on top
    // even when it overlaps other sensors' trails.
    const trailLastMs = (m) => {
      const id = (m && m.id != null) ? String(m.id) : "";
      const serverTrail = Array.isArray(m?.trail) ? m.trail : [];
      const persistedTrail = id ? (this._persistedTrailById.get(id)?.trail || []) : [];
      const src = (persistedTrail.length >= 2) ? persistedTrail : serverTrail;
      if (!Array.isArray(src) || src.length < 1) return Number.NEGATIVE_INFINITY;
      const last = src[src.length - 1];
      if (last && last._tMs !== undefined) {
        const t = last._tMs;
        return (t == null || !isFinite(t)) ? Number.NEGATIVE_INFINITY : Number(t);
      }
      const tStr = (last && typeof last.t === "string") ? last.t : null;
      const tMs = tStr ? parseUtcMs(tStr) : null;
      try { if (last) last._tMs = tMs; } catch {}
      return (tMs == null || !isFinite(tMs)) ? Number.NEGATIVE_INFINITY : Number(tMs);
    };

    const alphaOther = selectedId ? 0.35 : 1.0;
    const nonSelected = mobiles
      .filter(m => !(selectedId && m.id === selectedId))
      .slice()
      .sort((a, b) => trailLastMs(a) - trailLastMs(b));

    for (const m of nonSelected) {
      drawTrailFor(m, alphaOther, worldToScreenFast);
    }

    // Selected trail always on top at full strength.
    if (selectedId) {
      const m = mobiles.find(x => x.id === selectedId);
      if (m) drawTrailFor(m, 1.0, worldToScreenFast);
    }
    
  }

  drawOverlay(state, opts = {}) {
    const ctx = this.octx;
    if (!ctx) return;
    const w = this._cssW || 1;
    const h = this._cssH || 1;
    const dpr = this._dpr || (window.devicePixelRatio || 1);

    // In playback mode, trails must be redrawn each frame (time-clipped).
    // Static overlay caching is only valid for trace mode without playback.
    const useStaticOverlay = this.traceMode && !this.playbackMode;

    if (useStaticOverlay) {
      this._ensureTracePoints(state);
      this._ensureOverlayStatic(state);
      const pw = this.overlayCanvas.width;
      const ph = this.overlayCanvas.height;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, pw, ph);
      if (this._overlayStaticCanvas) ctx.drawImage(this._overlayStaticCanvas, 0, 0);
      ctx.restore();
    } else {
      ctx.clearRect(0, 0, w, h);
    }

    if (!state) return;
    const mobiles = Array.isArray(state.mobile) ? state.mobile : [];
    const fixed = Array.isArray(state.fixed) ? state.fixed : [];

    // Playback-mode trail caching: redraw trails only when view changes or time advances by 500ms+
    // This dramatically reduces CPU/GPU load since trail rendering is expensive.
    const pbTimeMs = this.playbackMode ? this.getPlaybackTimeMs() : null;
    const trailCacheKey = `${this.center.lat.toFixed(6)}|${this.center.lon.toFixed(6)}|${this.zoom.toFixed(3)}|${w}|${h}|${this.selectedId || ''}`;
    const trailTimeDelta = (pbTimeMs != null && this._trailCacheTimeMs != null) ? Math.abs(pbTimeMs - this._trailCacheTimeMs) : Infinity;
    const trailCacheValid = this._trailCacheCanvas && 
                            this._trailCacheKey === trailCacheKey && 
                            trailTimeDelta < 500; // Redraw trails every 500ms of playback time

    // Precompute center world once per frame; avoids repeated center projection in worldToScreen().
    const centerW = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
    const worldToScreenFast = (wx, wy) => ({ x: wx - centerW.x + w / 2, y: wy - centerW.y + h / 2 });

    // Fixed markers - same interaction model as mobile
    // In trace mode (without playback), fixed markers are part of the cached static overlay.
    // In playback underlay mode, fixed markers are already present.
    // Get playback time for fixed sensors with history
    const fixedPbTimeMs = this.playbackMode ? this.getPlaybackTimeMs() : null;
    const canUseUnderlay = false; // Underlay mode not currently implemented
    
    if (!useStaticOverlay && !canUseUnderlay && this.showFixed) {
      for (const f of fixed) {
        const lat = Number(f.lat), lon = Number(f.lon);
        if (!isFinite(lat) || !isFinite(lon)) continue;
        const wpt = latLonToWorld(lat, lon, this.zoom);
        const sp = worldToScreenFast(wpt.x, wpt.y);
        if (sp.x < -50 || sp.y < -50 || sp.x > w+50 || sp.y > h+50) continue;

        const key = keyFor("fixed", f.id);
        const isSel = (this.selectedId === key);
        const emoji = f.emoji || "📍";
        const label = (f.name && f.name.length && String(f.name) !== String(f.id)) ? `${f.id} (${f.name})` : f.id;
        const color = safeHex(f.color);
        // Use time-indexed reading in playback mode
        const pr = primaryReadingForFixedAtTime(f, fixedPbTimeMs);

        // halo
        ctx.save();
        ctx.beginPath();
        // “Dark glass” (not pure black), with strong outline so it’s not ghosty.
        ctx.fillStyle = isSel ? "rgba(16, 20, 28, 0.78)" : "rgba(16, 20, 28, 0.68)";
        ctx.arc(sp.x, sp.y, 16, 0, Math.PI*2);
        ctx.fill();
        // Border matches AQI color (like label pills)
        ctx.strokeStyle = isSel ? "rgba(108,195,255,0.90)" : safeHex((pr && pr.color) || color);
        ctx.lineWidth = 2.0;
        ctx.stroke();

        // emoji
        ctx.font = "20px Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(emoji, sp.x, sp.y);

        // label pill (2 lines): ID line (white) + reading value line (colored)
        // Use web-safe font stack that works reliably on iOS Safari
        ctx.font = "600 12px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
        const line1 = label;
        const line2Key = pr.key ? String(pr.key) : "";
        const line2Val = formatTagValue(pr.value);
        // Ensure we have actual text widths (iOS Safari can return 0 for some fonts)
        const m1 = ctx.measureText(line1);
        const m2a = ctx.measureText(line2Key ? `${line2Key} ` : "");
        const m2b = ctx.measureText(line2Val);
        const m1w = m1.width > 0 ? m1.width : (line1.length * 7);
        const m2aw = m2a.width > 0 ? m2a.width : ((line2Key ? line2Key.length + 1 : 0) * 7);
        const m2bw = m2b.width > 0 ? m2b.width : (line2Val.length * 7);
        const padX = 8;
        const bw = Math.max(m1w, (m2aw + m2bw)) + padX*2;
        const bh = (line2Key || line2Val) ? 30 : 18;
        const bx = sp.x - bw/2;
        const by = sp.y + 18;
        ctx.fillStyle = "rgba(16, 20, 28, 0.82)";
        ctx.strokeStyle = safeHex((pr && pr.color) || color);
        ctx.lineWidth = 1.8;
        roundRect(ctx, bx, by, bw, bh, 9);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#e8eef7";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const padY = 4;
        const lineH = (bh - padY * 2) / ((line2Key || line2Val) ? 2 : 1);
        const y1 = by + padY + lineH * 0.5;
        const y2 = by + padY + lineH * 1.5;
        ctx.fillText(line1, sp.x, y1);
        if (line2Key || line2Val) {
          // draw key in muted, value in pollutant color - use safe widths
          const x0 = sp.x - (m2aw + m2bw) / 2;
          ctx.fillStyle = "rgba(232,238,247,0.70)";
          ctx.fillText(line2Key ? `${line2Key} ` : "", x0 + m2aw / 2, y2);
          ctx.fillStyle = pr.color || "#ffffff";
          ctx.fillText(line2Val, x0 + m2aw + m2bw / 2, y2);
        }
        ctx.restore();
      }
    }

    // Trails:
    // - if none selected: show ALL trails
    // - if selected: show ALL trails, but dim others and draw selected last on top
    const sel = parseKey(this.selectedId);
    const hasSelectedMobile = (sel && sel.type === "mobile" && sel.id);
    const selectedId = hasSelectedMobile ? sel.id : null;

    // Reveal trail up to playback time (works in both DVR and LIVE modes).
    // LIVE mode uses playback time at the live edge.
    const isLive = !this.playbackMode;
    const trailRevealTimeMs = this.getPlaybackTimeMs();

    const drawTrailFor = (m, alphaMul, toScreen) => {
      const id = m && m.id != null ? String(m.id) : "";
      
      // Use shared trail collection logic
      const data = this._collectTrailData(m, toScreen);
      if (!data) return false;
      const { pts, cols, times, trail, isGhost } = data;
      
      const isSelTrail = (selectedId && m.id === selectedId);

      // Tail fade should be based on the *visible* (drawn) trail only.
      let visMinT = Infinity, visMaxT = -Infinity;
      for (let i = 1; i < pts.length; i++) {
        if (!pts[i - 1] || !pts[i]) continue;
        const p1 = trail[i];
        const isMoving = !!(p1 && (p1.m === 1 || p1.m === "1" || p1.m === true));
        const willDraw = this._pbDebugPath || isMoving;
        if (!willDraw) continue;
        const t1 = times[i];
        if (t1 != null && isFinite(t1)) {
          if (t1 < visMinT) visMinT = t1;
          if (t1 > visMaxT) visMaxT = t1;
        }
      }
      if (!(visMaxT > visMinT)) {
        for (const t of times) {
          if (t != null && isFinite(t)) {
            if (t < visMinT) visMinT = t;
            if (t > visMaxT) visMaxT = t;
          }
        }
      }
      const totalDur = (visMaxT > visMinT) ? (visMaxT - visMinT) : 0;

      // Render as a dotted line, but color each segment by the reading at that time.
      // User request: maximize contrast + opacity on trails.
      const alpha = (isSelTrail ? 1.0 : 0.85) * alphaMul;
      const lw = isSelTrail ? 4.2 : 3.4;
      const dash = [2, 10];

      // Strictly time-based trail decay (matches the static overlay trail behavior):
      // - total decay window: 45 minutes
      // - fade begins only in the last 20% of that window
      const FADE_TIME_MS = 45 * 60 * 1000; // 45 minutes -> fully expired
      const FADE_TAIL_FRAC = 0.20;
      const FADE_START_FRAC = 1.0 - FADE_TAIL_FRAC;
      // Reference time: use playback time, trail's max time, or playback bounds (NOT wall clock)
      const livePlaybackTimeMs = this.getPlaybackTimeMs();
      const hasPlaybackTime = livePlaybackTimeMs != null && isFinite(livePlaybackTimeMs);
      const pbBounds = this.getPlaybackBounds();
      const boundsMaxMs = (pbBounds.maxMs != null && isFinite(pbBounds.maxMs)) ? pbBounds.maxMs : null;
      const refNowMs = hasPlaybackTime ? Number(livePlaybackTimeMs) 
        : (isFinite(visMaxT) ? visMaxT 
        : (boundsMaxMs != null ? boundsMaxMs 
        : this._dataNowMs()));

      // Calculate pixels per meter at the trail's location (approximate using first point).
      // This is needed to convert the pruned world distance into a screen-space dash offset.
      let pixelsPerMeter = 1.0;
      if (pts.length > 0) {
        const lat = Number(trail[0].lat);
        if (isFinite(lat)) {
            const c = latLonToWorld(lat, 0, this.zoom);
            // Earth circumference ~40,075,016m.
            // World size at zoom = c.ws.
            // Scale factor = ws / (40075016 * cos(lat)).
            const cosLat = Math.cos(lat * Math.PI / 180);
            if (cosLat > 1e-6) {
                pixelsPerMeter = c.ws / (40075016 * cosLat);
            }
        }
      }

      let batchColor = null;
      let batchAlpha = null;
      let batchPts = [];

      // Set up trail drawing context once, only change what varies per batch
      ctx.lineWidth = lw;
      ctx.setLineDash(dash);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      const flushBatch = () => {
        if (batchPts.length < 2) {
            batchPts = [];
            return;
        }
        ctx.globalAlpha = batchAlpha;
        ctx.strokeStyle = batchColor;
        ctx.beginPath();
        // Draw disconnected segments to ensure dash pattern resets at every vertex.
        for (let k = 0; k < batchPts.length - 1; k++) {
            ctx.moveTo(batchPts[k].x, batchPts[k].y);
            ctx.lineTo(batchPts[k+1].x, batchPts[k+1].y);
        }
        ctx.stroke();
        batchPts = [];
      };

      // Pre-compute fade threshold: points newer than this don't need fade calculation
      const fadeStartAgeMs = FADE_TIME_MS * FADE_START_FRAC;

      for (let i = 1; i < pts.length; i++) {
        const ptPrev = pts[i-1];
        const ptCurr = pts[i];
        
        if (!ptPrev || !ptCurr) {
            flushBatch();
            continue;
        }

        // Use the 'm' (moving) flag from the server point to determine if 
        // this segment should be hidden/faded (jitter) or bright (historical data).
        const p1 = trail[i];
        const isMoving = !!(p1 && (p1.m === 1 || p1.m === "1" || p1.m === true));
        
        const segColor0 = cols[i] || cols[i - 1] || "#ffffff";
        let segColor = segColor0;
        let alphaMul2 = 1.0;

        if (!isMoving) {
          if (this._pbDebugPath) {
            segColor = dimHex(segColor0, 0.25);
          } else {
            // Previously hidden: keep visible, but fade + desaturate.
            segColor = desatHex(dimHex(segColor0, 0.35), 0.30);
            alphaMul2 = 0.5;
          }
        } else if (isGhost && isLive) {
          segColor = desatHex(dimHex(segColor0, 0.65), 0.25); // Dim + slight desat for offline sensors
          alphaMul2 = 0.5;
        }

        const t1 = times[i];
        if (!(t1 != null && isFinite(t1) && isFinite(refNowMs))) {
          flushBatch();
          continue;
        }

        // Hide leading trail: skip points ahead of the vehicle's time position (unless debug)
        // (Trail is already clipped during collection, but this handles edge cases)

        const ageMs = refNowMs - t1;
        
        // Skip points older than fade window
        if (ageMs >= FADE_TIME_MS) {
          flushBatch();
          continue;
        }

        // Only compute fade for points in the last 20% of the window
        let tailAlpha = 1.0;
        if (ageMs > fadeStartAgeMs) {
          const u = (ageMs - fadeStartAgeMs) / (FADE_TIME_MS - fadeStartAgeMs);
          tailAlpha = (1 - u) * (1 - u); // squared falloff
          if (tailAlpha <= 0.01) {
            flushBatch();
            continue;
          }
        }

        const finalAlpha = alpha * tailAlpha * alphaMul2;

        if (segColor !== batchColor || Math.abs(finalAlpha - batchAlpha) > 0.01) {
            flushBatch();
            batchColor = segColor;
            batchAlpha = finalAlpha;
            batchPts = [];
        }
        
        batchPts.push(ptPrev);
        batchPts.push(ptCurr);
      }
      flushBatch();
      // Reset context state for subsequent drawing
      ctx.setLineDash([]);
      ctx.globalAlpha = 1.0;

      return true;
    };

    const mobileHasServerTrail = (m) => {
      const t = Array.isArray(m?.trail) ? m.trail : [];
      return t.length >= 2;
    };

    // In trace mode (without playback), trails are part of the cached static overlay.
    // In playback mode, use trail caching to avoid redrawing every frame.
    if (!useStaticOverlay) {
      // Trail cache: only redraw when view changes or playback time advances significantly
      if (!trailCacheValid) {
        // Create or resize the trail cache canvas
        if (!this._trailCacheCanvas) this._trailCacheCanvas = document.createElement("canvas");
        this._trailCacheCanvas.width = Math.floor(w * dpr);
        this._trailCacheCanvas.height = Math.floor(h * dpr);
        const tctx = this._trailCacheCanvas.getContext("2d");
        if (tctx) {
          tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          tctx.clearRect(0, 0, w, h);

          // Draw order: oldest trails first, newest trails last.
          const trailLastMs = (m) => {
            const id = (m && m.id != null) ? String(m.id) : "";
            const serverTrail = Array.isArray(m?.trail) ? m.trail : [];
            const persistedTrail = id ? (this._persistedTrailById.get(id)?.trail || []) : [];
            const src = (persistedTrail.length >= 2) ? persistedTrail : serverTrail;
            if (!Array.isArray(src) || src.length < 1) return Number.NEGATIVE_INFINITY;
            const last = src[src.length - 1];
            if (last && last._tMs !== undefined) {
              const t = last._tMs;
              return (t == null || !isFinite(t)) ? Number.NEGATIVE_INFINITY : Number(t);
            }
            const tStr = (last && typeof last.t === "string") ? last.t : null;
            const tMs = tStr ? parseUtcMs(tStr) : null;
            try { if (last) last._tMs = tMs; } catch {}
            return (tMs == null || !isFinite(tMs)) ? Number.NEGATIVE_INFINITY : Number(tMs);
          };

          // Temporarily redirect drawTrailFor to use the cache canvas context
          const origCtx = ctx;
          const drawTrailForCached = (m, alphaMul, toScreen) => {
            const id = m && m.id != null ? String(m.id) : "";
            const data = this._collectTrailData(m, toScreen);
            if (!data) return false;
            const { pts, cols, times, trail, isGhost } = data;
            const isSelTrail = (selectedId && m.id === selectedId);

            let visMinT = Infinity, visMaxT = -Infinity;
            for (let i = 1; i < pts.length; i++) {
              if (!pts[i - 1] || !pts[i]) continue;
              const p1 = trail[i];
              const isMoving = !!(p1 && (p1.m === 1 || p1.m === "1" || p1.m === true));
              const willDraw = this._pbDebugPath || isMoving;
              if (!willDraw) continue;
              const t1 = times[i];
              if (t1 != null && isFinite(t1)) {
                if (t1 < visMinT) visMinT = t1;
                if (t1 > visMaxT) visMaxT = t1;
              }
            }
            if (!(visMaxT > visMinT)) {
              for (const t of times) {
                if (t != null && isFinite(t)) {
                  if (t < visMinT) visMinT = t;
                  if (t > visMaxT) visMaxT = t;
                }
              }
            }

            const alpha = (isSelTrail ? 1.0 : 0.85) * alphaMul;
            const lw = isSelTrail ? 4.2 : 3.4;
            const dash = [2, 10];
            const FADE_TIME_MS = 45 * 60 * 1000;
            const FADE_TAIL_FRAC = 0.20;
            const FADE_START_FRAC = 1.0 - FADE_TAIL_FRAC;
            const livePlaybackTimeMs = this.getPlaybackTimeMs();
            const hasPlaybackTime = livePlaybackTimeMs != null && isFinite(livePlaybackTimeMs);
            const pbBounds = this.getPlaybackBounds();
            const boundsMaxMs = (pbBounds.maxMs != null && isFinite(pbBounds.maxMs)) ? pbBounds.maxMs : null;
            const refNowMs = hasPlaybackTime ? Number(livePlaybackTimeMs) 
              : (isFinite(visMaxT) ? visMaxT 
              : (boundsMaxMs != null ? boundsMaxMs 
              : this._dataNowMs()));

            let batchColor = null;
            let batchAlpha = null;
            let batchPts = [];

            tctx.lineWidth = lw;
            tctx.setLineDash(dash);
            tctx.lineCap = "round";
            tctx.lineJoin = "round";

            const flushBatch = () => {
              if (batchPts.length < 2) { batchPts = []; return; }
              tctx.globalAlpha = batchAlpha;
              tctx.strokeStyle = batchColor;
              tctx.beginPath();
              for (let k = 0; k < batchPts.length - 1; k++) {
                tctx.moveTo(batchPts[k].x, batchPts[k].y);
                tctx.lineTo(batchPts[k+1].x, batchPts[k+1].y);
              }
              tctx.stroke();
              batchPts = [];
            };

            const fadeStartAgeMs = FADE_TIME_MS * FADE_START_FRAC;
            const isLive = !this.playbackMode;

            for (let i = 1; i < pts.length; i++) {
              const ptPrev = pts[i-1];
              const ptCurr = pts[i];
              if (!ptPrev || !ptCurr) { flushBatch(); continue; }

              const p1 = trail[i];
              const isMoving = !!(p1 && (p1.m === 1 || p1.m === "1" || p1.m === true));
              const segColor0 = cols[i] || cols[i - 1] || "#ffffff";
              let segColor = segColor0;
              let alphaMul2 = 1.0;

              if (!isMoving) {
                if (this._pbDebugPath) {
                  segColor = dimHex(segColor0, 0.25);
                } else {
                  segColor = desatHex(dimHex(segColor0, 0.35), 0.30);
                  alphaMul2 = 0.5;
                }
              } else if (isGhost && isLive) {
                segColor = desatHex(dimHex(segColor0, 0.65), 0.25);
              }

              const t1 = times[i];
              if (!(t1 != null && isFinite(t1) && isFinite(refNowMs))) { flushBatch(); continue; }

              const ageMs = refNowMs - t1;
              if (ageMs >= FADE_TIME_MS) { flushBatch(); continue; }

              let tailAlpha = 1.0;
              if (ageMs > fadeStartAgeMs) {
                const u = (ageMs - fadeStartAgeMs) / (FADE_TIME_MS - fadeStartAgeMs);
                tailAlpha = (1 - u) * (1 - u);
                if (tailAlpha <= 0.01) { flushBatch(); continue; }
              }

              const finalAlpha = alpha * tailAlpha * alphaMul2;
              if (segColor !== batchColor || Math.abs(finalAlpha - batchAlpha) > 0.01) {
                flushBatch();
                batchColor = segColor;
                batchAlpha = finalAlpha;
                batchPts = [];
              }
              batchPts.push(ptPrev);
              batchPts.push(ptCurr);
            }
            flushBatch();
            tctx.setLineDash([]);
            tctx.globalAlpha = 1.0;
            return true;
          };

          const alphaOther = selectedId ? 0.35 : 1.0;
          const nonSelected = mobiles
            .filter(m => !(selectedId && m.id === selectedId))
            .slice()
            .sort((a, b) => trailLastMs(a) - trailLastMs(b));

          for (const m of nonSelected) {
            drawTrailForCached(m, alphaOther, worldToScreenFast);
          }

          if (selectedId) {
            const m = mobiles.find(x => x.id === selectedId);
            if (m) drawTrailForCached(m, 1.0, worldToScreenFast);
          }
        }
        this._trailCacheKey = trailCacheKey;
        this._trailCacheTimeMs = pbTimeMs;
      }

      // Blit cached trails to main canvas
      if (this._trailCacheCanvas) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(this._trailCacheCanvas, 0, 0);
        ctx.restore();
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DEBUG: Draw RAW GPS PATH (original GPS before road snapping) - orange dashed
    // This shows the original GPS coordinates from the server, before any
    // road-matching optimization is applied.
    // ═══════════════════════════════════════════════════════════════════════════
    if (this._pbDebugPath && this._pbDebugRawGps && this.playbackMode) {
      const sel = parseKey(this.selectedId);
      const selId = (sel && sel.type === "mobile" && sel.id) ? sel.id : null;
      if (selId) {
        const rawGps = this._rawGpsById.get(String(selId));
        if (rawGps && rawGps.length >= 2) {
          const ws = worldSizeForZoom(this.zoom);
          const pbTimeMs = this.getPlaybackTimeMs();
          
          ctx.save();
          ctx.strokeStyle = "#ff8800"; // Orange for raw GPS
          ctx.lineWidth = 2;
          ctx.globalAlpha = 0.6;
          ctx.setLineDash([4, 6]);
          ctx.lineCap = "round";
          ctx.beginPath();
          
          let started = false;
          for (let i = 0; i < rawGps.length; i++) {
            const pt = rawGps[i];
            const lat = Number(pt.lat), lon = Number(pt.lon);
            if (!isFinite(lat) || !isFinite(lon)) continue;
            
            // Clip to playback time
            const tMs = (pt && typeof pt.t === "string") ? parseUtcMs(pt.t) : null;
            if (pbTimeMs != null && tMs != null && tMs > pbTimeMs) break;
            
            const norm = latLonToNorm(lat, lon);
            const sp = worldToScreenFast(norm.u * ws, norm.v * ws);
            if (!started) {
              ctx.moveTo(sp.x, sp.y);
              started = true;
            } else {
              ctx.lineTo(sp.x, sp.y);
            }
          }
          ctx.stroke();
          
          // Draw small markers at each raw GPS point
          ctx.fillStyle = "#ff8800";
          ctx.globalAlpha = 0.8;
          for (let i = 0; i < rawGps.length; i++) {
            const pt = rawGps[i];
            const lat = Number(pt.lat), lon = Number(pt.lon);
            if (!isFinite(lat) || !isFinite(lon)) continue;
            
            const tMs = (pt && typeof pt.t === "string") ? parseUtcMs(pt.t) : null;
            if (pbTimeMs != null && tMs != null && tMs > pbTimeMs) break;
            
            const norm = latLonToNorm(lat, lon);
            const sp = worldToScreenFast(norm.u * ws, norm.v * ws);
            ctx.beginPath();
            ctx.arc(sp.x, sp.y, 3, 0, 2 * Math.PI);
            ctx.fill();
          }
          
          ctx.restore();
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DEBUG: Draw ROAD GRAPH EDGES (street centerlines from road graph)
    // This shows the actual road network the server uses for snapping.
    // ═══════════════════════════════════════════════════════════════════════════
    if (this._pbDebugPath && this._pbDebugRoadLines && this.playbackMode) {
      // Fetch road edges for current viewport if needed (async, won't block)
      this._fetchRoadEdgesForViewport();
      
      const edges = this._roadGraphEdges;
      if (edges && edges.length > 0) {
        const ws = worldSizeForZoom(this.zoom);
        
        ctx.save();
        ctx.strokeStyle = "#444488"; // Dim blue for road lines
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.4;
        ctx.setLineDash([]);
        
        for (const e of edges) {
          const lat1 = Number(e.lat1), lon1 = Number(e.lon1);
          const lat2 = Number(e.lat2), lon2 = Number(e.lon2);
          if (!isFinite(lat1) || !isFinite(lon1) || !isFinite(lat2) || !isFinite(lon2)) continue;
          
          const n1 = latLonToNorm(lat1, lon1);
          const n2 = latLonToNorm(lat2, lon2);
          const sp1 = worldToScreenFast(n1.u * ws, n1.v * ws);
          const sp2 = worldToScreenFast(n2.u * ws, n2.v * ws);
          
          // Skip if off-screen
          if ((sp1.x < -50 && sp2.x < -50) || (sp1.x > w + 50 && sp2.x > w + 50)) continue;
          if ((sp1.y < -50 && sp2.y < -50) || (sp1.y > h + 50 && sp2.y > h + 50)) continue;
          
          ctx.beginPath();
          ctx.moveTo(sp1.x, sp1.y);
          ctx.lineTo(sp2.x, sp2.y);
          ctx.stroke();
        }
        
        ctx.restore();
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DEBUG: Draw TRAM LINE GRAPH EDGES (rail lines from tram line graph)
    // This shows the tram network used for TRAX snapping.
    // Color by elevation: green (low/ground) -> cyan (high/elevated tracks)
    // ═══════════════════════════════════════════════════════════════════════════
    if (this._pbDebugPath && this._pbDebugRoadLines && this.playbackMode) {
      // Fetch tram line edges for current viewport if needed (async, won't block)
      this._fetchTramLineEdgesForViewport();
      
      const tramEdges = this._tramLineEdges;
      const hasElevation = this._tramLineHasElevation;
      if (tramEdges && tramEdges.length > 0) {
        const ws = worldSizeForZoom(this.zoom);
        
        // Elevation color mapping: green (1280m) -> cyan (1500m)
        // SLC base elevation ~1280m, elevated tracks can be 1400m+
        const minElev = 1280, maxElev = 1500;
        const elevRange = maxElev - minElev;
        
        const elevToColor = (elev) => {
          if (!hasElevation || elev == null) return "#44aa66"; // Default green
          const t = Math.max(0, Math.min(1, (elev - minElev) / elevRange));
          // Interpolate: green (68, 170, 102) -> cyan (68, 200, 220)
          const r = 68;
          const g = Math.round(170 + t * 30);
          const b = Math.round(102 + t * 118);
          return `rgb(${r},${g},${b})`;
        };
        
        ctx.save();
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.7;
        ctx.setLineDash([]);
        
        for (const e of tramEdges) {
          const lat1 = Number(e.lat1), lon1 = Number(e.lon1);
          const lat2 = Number(e.lat2), lon2 = Number(e.lon2);
          if (!isFinite(lat1) || !isFinite(lon1) || !isFinite(lat2) || !isFinite(lon2)) continue;
          
          const n1 = latLonToNorm(lat1, lon1);
          const n2 = latLonToNorm(lat2, lon2);
          const sp1 = worldToScreenFast(n1.u * ws, n1.v * ws);
          const sp2 = worldToScreenFast(n2.u * ws, n2.v * ws);
          
          // Skip if off-screen
          if ((sp1.x < -50 && sp2.x < -50) || (sp1.x > w + 50 && sp2.x > w + 50)) continue;
          if ((sp1.y < -50 && sp2.y < -50) || (sp1.y > h + 50 && sp2.y > h + 50)) continue;
          
          // Color by average elevation of edge
          const avgElev = (e.elev1 != null && e.elev2 != null) ? (e.elev1 + e.elev2) / 2 : null;
          ctx.strokeStyle = elevToColor(avgElev);
          
          ctx.beginPath();
          ctx.moveTo(sp1.x, sp1.y);
          ctx.lineTo(sp2.x, sp2.y);
          ctx.stroke();
        }
        
        ctx.restore();
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DEBUG: Draw the STEERING PATH - predicted trajectory based on current physics
    // This shows where the vehicle WILL go based on current heading and steering.
    // Like a racing game steering trainer - shows the predicted path ahead.
    //
    // The path is computed by simulating the vehicle forward from current position,
    // steering toward lookahead points on the raw GPS path.
    // ═══════════════════════════════════════════════════════════════════════════
    if (this._pbDebugPath && this.playbackMode) {
      const sel = parseKey(this.selectedId);
      const selId = (sel && sel.type === "mobile" && sel.id) ? sel.id : null;
      if (selId) {
        const ws = worldSizeForZoom(this.zoom);
        const mid = String(selId);
        
        const mobs = Array.isArray(state.mobile) ? state.mobile : [];
        const mm = mobs.find(x => x.id === selId);
        if (mm) {
          const playbackPts = this._playbackPtsById.get(mid);
          if (playbackPts && playbackPts.length >= 2) {
            const phys = this._getPhysicsState(mid);
            const { cumDist, totalDist, curvature } = this._getPathDistances(mid, playbackPts);
            const physD = (phys.d != null && isFinite(phys.d)) ? phys.d : 0;
            const playbackSpeed = this._playbackSpeed || 1.0;
            
            // Calculate visible end - same as vehicle physics uses
            const tMin = playbackPts[0].tMs;
            const tMax = playbackPts[playbackPts.length - 1].tMs;
            const playT = this._currentPlaybackTimeMs || tMax;
            const visibleTargetD = this._getTargetDistance(playbackPts, cumDist, totalDist, playT);
            
            // ═══════════════════════════════════════════════════════════════════
            // PRECOMPUTE SMOOTH CURVE using Catmull-Rom spline interpolation
            // This creates the path the vehicle WOULD take based on GPS waypoints
            // ═══════════════════════════════════════════════════════════════════
            
            // Find which GPS points are ahead of vehicle (within visible range)
            const startIdx = cumDist.findIndex(d => d >= physD);
            const endIdx = cumDist.findIndex(d => d >= visibleTargetD);
            const visibleStartIdx = Math.max(0, (startIdx === -1 ? 0 : startIdx) - 1);
            const visibleEndIdx = endIdx === -1 ? playbackPts.length - 1 : Math.min(playbackPts.length - 1, endIdx + 1);
            
            // Generate smooth curve waypoints using Catmull-Rom spline
            const smoothCurve = [];
            const SAMPLES_PER_SEGMENT = 8; // More samples = smoother curve
            
            for (let i = visibleStartIdx; i < visibleEndIdx; i++) {
              const p0 = playbackPts[Math.max(0, i - 1)];
              const p1 = playbackPts[i];
              const p2 = playbackPts[Math.min(playbackPts.length - 1, i + 1)];
              const p3 = playbackPts[Math.min(playbackPts.length - 1, i + 2)];
              
              // Catmull-Rom interpolation with tension 0.5 (standard)
              const tension = 0.5;
              const s = (1 - tension) / 2;
              
              for (let j = 0; j <= SAMPLES_PER_SEGMENT; j++) {
                const t = j / SAMPLES_PER_SEGMENT;
                const t2 = t * t;
                const t3 = t2 * t;
                
                const h1 = -s * t3 + 2 * s * t2 - s * t;
                const h2 = (2 - s) * t3 + (s - 3) * t2 + 1;
                const h3 = (s - 2) * t3 + (3 - 2 * s) * t2 + s * t;
                const h4 = s * t3 - s * t2;
                
                const lat = h1 * p0.lat + h2 * p1.lat + h3 * p2.lat + h4 * p3.lat;
                const lon = h1 * p0.lon + h2 * p1.lon + h3 * p2.lon + h4 * p3.lon;
                
                // Calculate distance along curve for this point
                const segDist = cumDist[i] + (cumDist[Math.min(i + 1, cumDist.length - 1)] - cumDist[i]) * t;
                
                // Only include points within visible range and ahead of vehicle
                if (segDist >= physD && segDist <= visibleTargetD) {
                  smoothCurve.push({ lat, lon, d: segDist });
                }
              }
            }
            
            // Remove duplicate points (from overlapping segments)
            const deduped = [];
            for (let i = 0; i < smoothCurve.length; i++) {
              if (i === 0 || 
                  Math.abs(smoothCurve[i].lat - deduped[deduped.length - 1].lat) > 1e-7 ||
                  Math.abs(smoothCurve[i].lon - deduped[deduped.length - 1].lon) > 1e-7) {
                deduped.push(smoothCurve[i]);
              }
            }
            
            // ═══════════════════════════════════════════════════════════════════
            // STEERING SIMULATION: Vehicle steers toward precomputed curve
            // All parameters SCALE WITH PLAYBACK SPEED to maintain realistic physics
            // ═══════════════════════════════════════════════════════════════════
            
            const sqrtSpeed = Math.sqrt(Math.max(1, playbackSpeed));
            
            // Lookahead INCREASES with speed - need to see curves earlier at high speed
            const LOOKAHEAD_BASE = 30;      // meters at 1x
            const LOOKAHEAD_PER_SQRT = 20;  // additional meters per sqrt(speed)
            const lookaheadD_base = LOOKAHEAD_BASE + LOOKAHEAD_PER_SQRT * sqrtSpeed;
            
            // Steering rate DECREASES with speed - more inertia at high speed
            const STEER_RATE_BASE = 6.0;
            const steerRate = STEER_RATE_BASE / sqrtSpeed;
            
            // Lateral pull-back DECREASES with speed - can't correct as sharply
            const PULLBACK_BASE = 1.0;
            const pullbackScale = PULLBACK_BASE / sqrtSpeed;
            
            const metersPerDegLat = 111320;
            const metersPerDegLon = 111320 * Math.cos((phys.lat || 40.7) * Math.PI / 180);
            
            // Sample the precomputed curve at a given distance
            const sampleCurveAtD = (targetD) => {
              if (deduped.length < 2) return deduped[0] || { lat: phys.lat, lon: phys.lon };
              for (let i = 0; i < deduped.length - 1; i++) {
                if (deduped[i + 1].d >= targetD) {
                  const u = (deduped[i + 1].d - deduped[i].d) > 0.1 
                    ? (targetD - deduped[i].d) / (deduped[i + 1].d - deduped[i].d)
                    : 0;
                  return {
                    lat: deduped[i].lat + u * (deduped[i + 1].lat - deduped[i].lat),
                    lon: deduped[i].lon + u * (deduped[i + 1].lon - deduped[i].lon)
                  };
                }
              }
              return deduped[deduped.length - 1];
            };
            
            let simLat = phys.lat || 0;
            let simLon = phys.lon || 0;
            let simHeading = phys.heading || 0;
            let simD = physD;
            let simV = phys.v || 15;
            
            // ═══════════════════════════════════════════════════════════════════
            // EMERGENT PHYSICS: No precalculation. Just react to visible trail.
            // 
            // curveDebt = distance lost from slowing for curves
            // - Paid back by accelerating on straightaways
            // - Stops: just wait (no debt - we're honoring the GPS data)
            // ═══════════════════════════════════════════════════════════════════
            
            let curveDebt = 0;
            const CRUISE_SPEED = 15; // Base cruise speed in m/s
            
            const steeringPath = [{ lat: simLat, lon: simLon }];
            const SIM_STEPS = 30;
            const SIM_DT = 0.1;
            
            for (let step = 0; step < SIM_STEPS && simD < visibleTargetD; step++) {
              // Lookahead scales with speed, clamped to visible trail
              const lookaheadD = Math.min(lookaheadD_base, visibleTargetD - simD);
              if (lookaheadD <= 0) break;
              
              const targetD = Math.min(simD + lookaheadD, visibleTargetD);
              
              // Sample from PRECOMPUTED SMOOTH CURVE
              const lookaheadSample = sampleCurveAtD(targetD);
                            // Also get the curve point at our CURRENT distance (for lateral correction)
              const currentCurvePt = sampleCurveAtD(simD);
              
              // Calculate lateral offset from curve
              const latOffsetM = (simLat - currentCurvePt.lat) * metersPerDegLat;
              const lonOffsetM = (simLon - currentCurvePt.lon) * metersPerDegLon;
              const lateralOffset = Math.sqrt(latOffsetM * latOffsetM + lonOffsetM * lonOffsetM);
              
              // Look ahead for curves within braking distance (scales with speed)
              const brakeLookahead = Math.min(simV * playbackSpeed * 2, visibleTargetD - simD);
              let maxCurvAhead = 0;
              for (let i = 0; i < curvature.length; i++) {
                const d = cumDist[i];
                if (d >= simD && d <= simD + brakeLookahead) {
                  if (curvature[i] > maxCurvAhead) maxCurvAhead = curvature[i];
                }
              }
              
              // Steer toward a BLEND of lookahead point and current curve point
              // Pull-back scales inversely with speed - less aggressive correction at high speed
              const rawPullBack = Math.min(1, lateralOffset / 50);
              const pullBack = rawPullBack * pullbackScale; // Scale by 1/sqrt(speed)
              const blendLat = lookaheadSample.lat * (1 - pullBack) + currentCurvePt.lat * pullBack;
              const blendLon = lookaheadSample.lon * (1 - pullBack) + currentCurvePt.lon * pullBack;
              
              const dLat = blendLat - simLat;
              const dLon = blendLon - simLon;
              const targetHeading = Math.atan2(dLat, dLon);
              
              let headingDiff = targetHeading - simHeading;
              while (headingDiff > Math.PI) headingDiff -= 2 * Math.PI;
              while (headingDiff < -Math.PI) headingDiff += 2 * Math.PI;
              const headingError = Math.abs(headingDiff);
              
              // Curvature and heading factors for curve detection
              const curveFactor = 0.0003 / (0.0003 + maxCurvAhead);
              const headingFactor = Math.max(0.1, 1.0 - headingError * 1.8);
              const lateralFactor = Math.max(0.3, 1.0 - lateralOffset / (50 * sqrtSpeed));
              
              // ═══════════════════════════════════════════════════════════════════
              // EMERGENT SPEED: No precalculation. Just physics.
              // ═══════════════════════════════════════════════════════════════════
              
              const onCurve = curveFactor < 0.7 || headingFactor < 0.7 || lateralFactor < 0.7;
              
              // Distance to where we can go
              const distanceToEnd = visibleTargetD - simD;
              
              let targetSimV;
              // If we're close to the end, slow down / stop
              if (distanceToEnd < 10) {
                // At or near the end - stop
                targetSimV = Math.max(0, distanceToEnd * 0.5);
              } else if (onCurve) {
                // On curve - slow for physics
                targetSimV = CRUISE_SPEED * curveFactor * headingFactor * lateralFactor;
                // Accumulate curve debt (we're going slower than cruise)
                const expectedDist = CRUISE_SPEED * SIM_DT * playbackSpeed;
                const actualDist = targetSimV * SIM_DT * playbackSpeed;
                curveDebt += (expectedDist - actualDist);
              } else {
                // Straightaway - cruise + pay back curve debt
                const debtPayback = Math.min(curveDebt, CRUISE_SPEED * 0.5 * SIM_DT * playbackSpeed);
                curveDebt -= debtPayback;
                const boostRatio = 1.0 + (debtPayback / (CRUISE_SPEED * SIM_DT * playbackSpeed));
                targetSimV = CRUISE_SPEED * boostRatio;
              }
              
              // Smooth velocity
              const blendRate = simV > targetSimV ? 0.6 : 0.4;
              simV = simV + blendRate * (targetSimV - simV);
              simV = Math.max(0, Math.min(40, simV));
              
              // Steer toward target - steerRate already scaled by 1/sqrt(speed)
              const speedFactor = Math.max(0.5, 15 / Math.max(5, simV));
              const steerFactor = 1 - Math.exp(-steerRate * speedFactor * SIM_DT);
              simHeading += steerFactor * headingDiff;
              
              // Move forward
              const moveDistM = simV * SIM_DT * playbackSpeed;
              simLat += (moveDistM * Math.sin(simHeading)) / metersPerDegLat;
              simLon += (moveDistM * Math.cos(simHeading)) / metersPerDegLon;
              simD += moveDistM;
              
              steeringPath.push({ lat: simLat, lon: simLon });
            }
            
            // Draw the precomputed smooth curve (the "road" based on GPS data)
            if (deduped.length >= 2) {
              ctx.save();
              
              // Draw smooth curve line (cyan)
              ctx.strokeStyle = "#00ffff";
              ctx.lineWidth = 3;
              ctx.globalAlpha = 0.7;
              ctx.setLineDash([]);
              ctx.beginPath();
              
              for (let i = 0; i < deduped.length; i++) {
                const pt = deduped[i];
                const norm = latLonToNorm(pt.lat, pt.lon);
                const sp = worldToScreenFast(norm.u * ws, norm.v * ws);
                if (i === 0) ctx.moveTo(sp.x, sp.y);
                else ctx.lineTo(sp.x, sp.y);
              }
              ctx.stroke();
              
              // Draw waypoint markers along the curve (every ~50m)
              ctx.fillStyle = "#00ffff";
              let lastMarkerD = -Infinity;
              const MARKER_SPACING = 50; // meters between markers
              for (let i = 0; i < deduped.length; i++) {
                const pt = deduped[i];
                if (pt.d - lastMarkerD >= MARKER_SPACING) {
                  const norm = latLonToNorm(pt.lat, pt.lon);
                  const sp = worldToScreenFast(norm.u * ws, norm.v * ws);
                  ctx.beginPath();
                  ctx.arc(sp.x, sp.y, 4, 0, 2 * Math.PI);
                  ctx.globalAlpha = 0.9 - (pt.d - physD) / (visibleTargetD - physD + 1) * 0.6;
                  ctx.fill();
                  lastMarkerD = pt.d;
                }
              }
              
              ctx.restore();
            }
            
            // Draw the steering simulation path (where vehicle will actually go)
            if (steeringPath.length >= 2) {
              ctx.save();
              
              // Draw steering path as dashed line
              ctx.strokeStyle = "#ff00ff"; // Magenta to distinguish from curve
              ctx.lineWidth = 2;
              ctx.globalAlpha = 0.5;
              ctx.setLineDash([5, 5]);
              ctx.beginPath();
              
              for (let i = 0; i < steeringPath.length; i++) {
                const pt = steeringPath[i];
                const norm = latLonToNorm(pt.lat, pt.lon);
                const sp = worldToScreenFast(norm.u * ws, norm.v * ws);
                if (i === 0) ctx.moveTo(sp.x, sp.y);
                else ctx.lineTo(sp.x, sp.y);
              }
              ctx.stroke();
              
              ctx.restore();
            }
          }
        }
      }
    }

    // Emoji markers
    const nowMs = (opts && typeof opts.nowMs === "number" && isFinite(opts.nowMs)) ? opts.nowMs : performance.now();
    if (this.traceMode || this.playbackMode) {
      // Set emoji font once per frame (hot path).
      ctx.font = "22px Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
    }
    const topMobileId = (() => {
      // Priority: actively dragged/inertial marker, then selected marker.
      if (this._pbDrag && this._pbDrag.id != null) return String(this._pbDrag.id);
      if (this._pbInertia2d && this._pbInertia2d.id != null) return String(this._pbInertia2d.id);
      if (selectedId != null) return String(selectedId);
      return null;
    })();

    const drawMobileMarker = (m) => {
      const pose = this._mobilePoseForRender(m, nowMs);
      let lat = pose.lat;
      let lon = pose.lon;
      let angle = pose.angle;
      let flipX = pose.flipX;
      let speedMps = pose.speedMps;
      const opacity = (typeof pose.opacity === "number" && isFinite(pose.opacity)) ? pose.opacity : 1;
      const key = keyFor("mobile", m.id);
      const isSel = (this.selectedId === key);
      const debug = !!this._pbDebugPath;
      // In playback mode, show ghosted sensors if they have trail data (they were active in the past).
      // In live mode, hide ghosted sensors unless Debug/Selected.
      const hasPlaybackData = this.playbackMode && this._playbackPtsById.has(String(m.id));
      if (!!m.ghosted && !debug && !isSel && !hasPlaybackData) return;
      const isParked = !!m.parked;
      const dimmed = (!debug && !isSel && isParked);
      if (!isFinite(lat) || !isFinite(lon)) return;
      const wpt = latLonToWorld(lat, lon, this.zoom);
      const sp = worldToScreenFast(wpt.x, wpt.y);
      if (sp.x < -50 || sp.y < -50 || sp.x > w+50 || sp.y > h+50) return;

      const held = !!pose.held;
      const id = (m && m.id != null) ? String(m.id) : "";

      const emoji = m.emoji || "🚌";
      const label = (m.name && m.name.length && String(m.name) !== String(m.id)) ? `${m.id} (${m.name})` : m.id;
      const color0 = safeHex(m.color);
      const color = isParked ? dimHex(color0, 0.65) : color0;
      // Base reading: worst AQI from the *full* sensor readings snapshot.
      // Important: trail points often carry only a subset of pollutants (commonly ozone-only),
      // so in DVR live-follow that subset must not override the actual current readings.
      let pr = primaryReadingForSensor(m);
      if (this.playbackMode && pose && pose.reading) {
        const prHist = pose.reading;
        // When in historical mode (viewing past days), always use historical trail reading.
        // Only compare with live sensor readings when viewing today's live data.
        if (this._historicalMode) {
          pr = prHist;
        } else {
          const followingLive = !!this._playbackLiveFollow || this.isPlaybackAtEnd(200);
          if (followingLive) {
            const aNow = (pr && pr.aqi != null) ? Number(pr.aqi) : valueToAqi(pr?.key, pr?.value);
            const aHist = (prHist && prHist.aqi != null) ? Number(prHist.aqi) : valueToAqi(prHist?.key, prHist?.value);
            const aNowF = (aNow != null && isFinite(Number(aNow))) ? Number(aNow) : -1;
            const aHistF = (aHist != null && isFinite(Number(aHist))) ? Number(aHist) : -1;
            // Choose the worse (higher AQI). If either is missing, keep the one that exists.
            if (!pr || !pr.key) pr = prHist;
            else if (prHist && prHist.key && aHistF > aNowF) pr = prHist;
          } else {
            // While scrubbing history, show the per-point reading (historical).
            pr = prHist;
          }
        }
      }
      const prColor = isParked ? dimHex(pr.color || "#ffffff", 0.65) : (pr.color || "#ffffff");
      const colorUse = dimmed ? desatHex(color, 0.25) : color;
      const prColorUse = dimmed ? desatHex(prColor, 0.25) : prColor;

      ctx.save();
      const baseAlpha = clamp(opacity, 0, 1);
      if (baseAlpha < 1) ctx.globalAlpha = ctx.globalAlpha * baseAlpha;
      if (dimmed) {
        ctx.globalAlpha = ctx.globalAlpha * 0.5;
        // NOTE: ctx.filter is expensive on iPad - we already desaturated colors above
      }

      const liftScale = (this.playbackMode && held) ? 1.16 : 1.0;
      const liftY = (this.playbackMode && held) ? -8 : 0;
      const spx = sp.x;
      const spy = sp.y + liftY;

      // halo
      ctx.beginPath();
      ctx.fillStyle = (this.selectedId === key) ? "rgba(16, 20, 28, 0.78)" : "rgba(16, 20, 28, 0.68)";
      ctx.arc(spx, spy, 18 * liftScale, 0, Math.PI*2);
      ctx.fill();
      // Border matches AQI color (like label pills)
      ctx.strokeStyle = (this.selectedId === key) ? "rgba(108,195,255,0.90)" : safeHex(prColorUse);
      ctx.lineWidth = 2.2;
      ctx.stroke();

      // emoji
      ctx.save();
      ctx.font = "22px Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      if (this.traceMode || this.playbackMode) {
        ctx.translate(spx, spy);
        if (liftScale !== 1.0) ctx.scale(liftScale, liftScale);
        if (flipX) ctx.scale(-1, 1);
        ctx.rotate(angle);
        ctx.fillText(emoji, 0, 0);
      } else {
        ctx.fillText(emoji, spx, spy);
      }
      ctx.restore();

      // Trace-mode speed indicator (buses only): show reproduced playback speed.
      // TODO: also for trax.
      if ((this.traceMode || this.playbackMode) && this.showMobileLabels) {
        const sid = (m && m.id != null) ? String(m.id).toUpperCase() : "";
        const isBus = (emoji === "🚍") || sid.startsWith("BUS");
        if (isBus) {
          const mph = Math.max(0, Math.round((isFinite(speedMps) ? speedMps : 0) * 2.236936));
          const txt = `${mph} mph`;
          ctx.save();
          ctx.font = "10px -apple-system, system-ui, sans-serif";
          const tw = ctx.measureText(txt).width;
          const padX = 6;
          const bw = tw + padX * 2;
          const bh = 14;
          const bx = spx - bw / 2;
          const by = spy - 32;
          ctx.fillStyle = "rgba(16, 20, 28, 0.72)";
          ctx.strokeStyle = "rgba(232,238,247,0.22)";
          ctx.lineWidth = 1.0;
          roundRect(ctx, bx, by, bw, bh, 7);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = "rgba(232,238,247,0.90)";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(txt, spx, by + bh / 2);
          ctx.restore();
        }
      }

      // tiny label pill (hideable via showLabels toggle)
      if (this.showMobileLabels) {
        const txt1 = label;
        const txt2Key = pr.key ? String(pr.key) : "";
        const txt2Val = formatTagValue(pr.value);
        ctx.font = "12px -apple-system, system-ui, sans-serif";
        const m1 = ctx.measureText(txt1);
        const m2a = ctx.measureText(txt2Key ? `${txt2Key} ` : "");
        const m2b = ctx.measureText(txt2Val);
        const padX = 8;
        const bw = Math.max(m1.width, (m2a.width + m2b.width)) + padX*2;
        const bh = (txt2Key || txt2Val) ? 30 : 18;
        const bx = spx - bw/2;
        const by = spy + 18;
        ctx.fillStyle = "rgba(16, 20, 28, 0.82)";
        ctx.strokeStyle = safeHex(prColorUse || colorUse);
        ctx.lineWidth = 1.8;
        roundRect(ctx, bx, by, bw, bh, 9);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#e8eef7";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const padY = 4;
        const lineH = (bh - padY * 2) / ((txt2Key || txt2Val) ? 2 : 1);
        const y1 = by + padY + lineH * 0.5;
        const y2 = by + padY + lineH * 1.5;
        ctx.fillText(txt1, spx, y1);
        if (txt2Key || txt2Val) {
          const x0 = spx - (m2a.width + m2b.width) / 2;
          ctx.fillStyle = "rgba(232,238,247,0.70)";
          ctx.fillText(txt2Key ? `${txt2Key} ` : "", x0 + m2a.width / 2, y2);
          ctx.fillStyle = prColorUse;
          ctx.fillText(txt2Val, x0 + m2a.width + m2b.width / 2, y2);
        }
      }
      ctx.restore();
    };

    // Draw mobiles in two passes so the interacted/selected marker is on top.
    if (this.showMobile) {
      for (const m of mobiles) {
        if (topMobileId && m && m.id != null && String(m.id) === String(topMobileId)) continue;
        drawMobileMarker(m);
      }
      if (topMobileId) {
        const top = mobiles.find(mm => (mm && mm.id != null && String(mm.id) === String(topMobileId))) || null;
        if (top) drawMobileMarker(top);
      }
    }
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x+rr, y);
  ctx.arcTo(x+w, y, x+w, y+h, rr);
  ctx.arcTo(x+w, y+h, x, y+h, rr);
  ctx.arcTo(x, y+h, x, y, rr);
  ctx.arcTo(x, y, x+w, y, rr);
  ctx.closePath();
}

function generateItemHTML(item, type, order) {
  const isGhost = !!item.ghosted;
  const isParked = !!item.parked;
  const emoji = item.emoji || (type === "mobile" ? "🚌" : "📍");
  const nameText = item.name ? `${item.id} (${item.name})` : item.id;
  
  let pinText = "";
  if (type === "mobile") {
    pinText = item.pinned ? (isParked ? "pinned · parked" : "pinned") : (isParked ? "parked" : "");
  }

  const readings = item.readings || {};
  const keys = Object.keys(readings);
  keys.sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
  const show = keys.slice(0, 3);
  
  let rowsHTML = "";
  rowsHTML += `<div class="row1">`;
  rowsHTML += `<div class="emoji">${emoji}</div>`;
  rowsHTML += `<div class="name">${escapeHtml(nameText)}</div>`;
  rowsHTML += `<div class="pin">${escapeHtml(pinText)}</div>`;
  rowsHTML += `</div>`;
  
  rowsHTML += `<div class="row2">`;
  for (const k of show) {
    const val = readings[k]?.value ?? "—";
    const c = safeHex(readings[k]?.color);
    const outC = isParked ? dimHex(c, 0.65) : c;
    rowsHTML += `<div class="reading">`;
    rowsHTML += `<span class="k">${escapeHtml(k)}</span>`;
    rowsHTML += `<span class="v" style="color:${outC}">${escapeHtml(String(val))}</span>`;
    rowsHTML += `</div>`;
  }
  rowsHTML += `</div>`;
  return rowsHTML;
}

function reconcileList(container, items, type, selectedId, order) {
  const existingMap = new Map();
  let child = container.firstElementChild;
  while (child) {
    if (child.dataset.id) existingMap.set(child.dataset.id, child);
    child = child.nextElementSibling;
  }

  const seenIds = new Set();
  items.forEach(item => {
    // Offline sensors are hidden from the UI.
    if (item && item.ghosted) return;
    const id = item.id;
    seenIds.add(id);
    const k = keyFor(type, id);
    
    let el = existingMap.get(id);
    if (!el) {
      el = document.createElement("div");
      el.dataset.id = id;
      el.addEventListener("click", (e) => {
        const isMobile = (type === "mobile");
        window.__selectSensor(k, { fitTrail: isMobile && !!e.metaKey });
      });
      container.appendChild(el);
    } else {
      container.appendChild(el);
    }

    const isSelected = (k === selectedId);
    const className = "item" + (isSelected ? " selected" : "") + (item.parked ? " parked" : "");
    if (el.className !== className) el.className = className;

    const html = generateItemHTML(item, type, order);
    if (el.innerHTML !== html) el.innerHTML = html;
  });

  existingMap.forEach((el, id) => {
    if (!seenIds.has(id)) el.remove();
  });
}

/**
 * Update sidebar reading values during playback without full re-render.
 * This is called from the playback loop to show interpolated values at current playback time.
 */
function updateSidebarPlaybackValues() {
  const map = window.__map;
  if (!map || !map.playbackMode) return;
  
  const listMobileEl = document.getElementById("sensorListMobile");
  if (!listMobileEl) return;
  
  const state = map._historicalMode ? window._historicalState : window.__lastState;
  if (!state || !Array.isArray(state.mobile)) return;
  
  const t = map.getPlaybackTimeMs();
  if (t == null || !isFinite(t)) return;
  
  // At the live edge, use live values - don't update readings
  const atEnd = map.isPlaybackAtEnd(100);
  if (atEnd) return;
  
  for (const m of state.mobile) {
    if (!m || m.id == null) continue;
    
    // Find the DOM element for this sensor
    const itemEl = listMobileEl.querySelector(`[data-id="${m.id}"]`);
    if (!itemEl) continue;
    
    // Always show sensor - never hide
    if (itemEl.classList.contains("hidden")) {
      itemEl.classList.remove("hidden");
    }
    
    // Get playback points for this sensor
    const pts = map._playbackPtsById.get(String(m.id));
    if (!pts || !pts.length) continue;
    
    // Binary search for current point
    let idxHi = 1;
    const tMin = pts[0].tMs;
    const tMax = pts[pts.length - 1].tMs;
    if (t <= tMin) idxHi = 1;
    else if (t >= tMax) idxHi = pts.length - 1;
    else {
      let lo = 1, hi = pts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (pts[mid].tMs >= t) hi = mid;
        else lo = mid + 1;
      }
      idxHi = lo;
    }
    
    const currentPt = pts[idxHi];
    if (!currentPt || !currentPt.readings) continue;
    
    // Update the reading values in the DOM
    const row2 = itemEl.querySelector(".row2");
    if (!row2) continue;
    
    const readingEls = row2.querySelectorAll(".reading");
    for (const rEl of readingEls) {
      const kEl = rEl.querySelector(".k");
      const vEl = rEl.querySelector(".v");
      if (!kEl || !vEl) continue;
      
      const k = kEl.textContent;
      const r = currentPt.readings[k];
      if (r && r.value != null) {
        const newVal = String(r.value);
        if (vEl.textContent !== newVal) {
          vEl.textContent = newVal;
        }
        const newColor = safeHex(r.color);
        if (vEl.style.color !== newColor) {
          vEl.style.color = newColor;
        }
      }
    }
  }
}

function renderLists(state, selectedId) {
  const listMobileEl = document.getElementById("sensorListMobile");
  const listFixedEl = document.getElementById("sensorListFixed");

  const DOWNTOWN_SLC = { lat: 40.7608, lon: -111.8910 };

  const mobilesRaw = Array.isArray(state.mobile) ? state.mobile : [];
  const fixedRaw = Array.isArray(state.fixed) ? state.fixed : [];

  // Sorting is based on latest reported lat/lon, not animated marker positions.
  const mobiles = mobilesRaw.slice().sort((a, b) => {
    const la = Number(a?.lat);
    const lb = Number(b?.lat);
    const aOk = isFinite(la);
    const bOk = isFinite(lb);
    if (aOk && bOk) return lb - la; // north -> south
    if (aOk) return -1;
    if (bOk) return 1;
    return String(a?.id || "").localeCompare(String(b?.id || ""));
  });

  const fixed = fixedRaw
    .map((f) => {
      const lat = Number(f?.lat);
      const lon = Number(f?.lon);
      const d = (isFinite(lat) && isFinite(lon))
        ? haversineMeters(DOWNTOWN_SLC.lat, DOWNTOWN_SLC.lon, lat, lon)
        : Number.POSITIVE_INFINITY;
      return { f, d };
    })
    .sort((a, b) => {
      if (a.d !== b.d) return a.d - b.d; // closest -> farthest
      return String(a.f?.id || "").localeCompare(String(b.f?.id || ""));
    })
    .map((x) => x.f);

  // prefer a stable pollutant order like the TUI
  const order = ["PM25", "PM2.5", "PM10", "OZNE", "Ozone"];

  if (listMobileEl) reconcileList(listMobileEl, mobiles, "mobile", selectedId, order);
  if (listFixedEl) reconcileList(listFixedEl, fixed, "fixed", selectedId, order);
}

function renderDetails(state, selectedId) {
  const body = document.getElementById("detailsBody");
  if (!body) return;
  const mobiles = Array.isArray(state.mobile) ? state.mobile : [];
  const fixed = Array.isArray(state.fixed) ? state.fixed : [];
  const sel = parseKey(selectedId);
  const m = sel && sel.type === "mobile" ? mobiles.find(x => x.id === sel.id) : null;
  const f = sel && sel.type === "fixed" ? fixed.find(x => x.id === sel.id) : null;
  const item = m || f;
  if (!item) {
    body.innerHTML = `<div class="muted">Select a vehicle…</div>`;
    return;
  }

  const title = item.name ? `${item.id} (${item.name})` : item.id;
  const updated = m ? fmtTime(m.trail?.[m.trail.length - 1]?.t) : "—";
  const lat = (item.lat != null) ? Number(item.lat).toFixed(5) : "—";
  const lon = (item.lon != null) ? Number(item.lon).toFixed(5) : "—";

  const readings = item.readings || {};
  const keys = Object.keys(readings);
  keys.sort();

  let html = "";
  html += `<div class="kv"><div class="k">Vehicle</div><div class="v">${escapeHtml(title)}</div></div>`;
  html += `<div class="kv"><div class="k">Last reading</div><div class="v">${escapeHtml(updated)}</div></div>`;
  html += `<div class="kv"><div class="k">Lat</div><div class="v">${lat}</div></div>`;
  html += `<div class="kv"><div class="k">Lon</div><div class="v">${lon}</div></div>`;
  html += `<div class="panelTitle" style="margin-top:10px">AQI Legend</div>`;

  // Build per-pollutant AQI summary from current readings
  const metrics = [];
  for (const k of keys) {
    const val = readings[k]?.value;
    const col = safeHex(readings[k]?.color);
    const aqi = valueToAqi(k, val);
    const lvl = aqiLevel(aqi);
    metrics.push({
      key: k,
      label: canonicalPollutantLabel(k),
      value: val,
      color: col,
      aqi: (aqi == null || !isFinite(Number(aqi))) ? null : Number(aqi),
      lvlLabel: lvl?.label || "Unknown",
      lvlColor: lvl?.color || "#AAAAAA",
    });
  }
  metrics.sort((a, b) => (b.aqi ?? -1) - (a.aqi ?? -1));

  // Use AQI to choose which ones to chart/display: top 3 by current AQI
  const top = metrics.slice(0, 3);
  const rest = metrics.slice(3);

  // Sparkline series from trail history (mobile only): chart AQI (0..500) so scales are comparable.
  const trail = (m && Array.isArray(m.trail)) ? m.trail : [];
  const MAX_PTS = 90;
  const tail = trail.length > MAX_PTS ? trail.slice(trail.length - MAX_PTS) : trail;
  const seriesFor = (pollKey) => {
    const out = [];
    for (const p of tail) {
      const rv = p?.readings?.[pollKey]?.value;
      const aqi = valueToAqi(pollKey, rv);
      if (aqi != null && isFinite(Number(aqi))) out.push(Number(aqi));
    }
    return out;
  };

  if (!top.length) {
    html += `<div class="muted">No readings</div>`;
  } else {
    html += `<div class="aqiLegend">`;
    for (const it of top) {
      const aqiTxt = (it.aqi == null) ? "—" : String(Math.round(it.aqi));
      const spark = (m && tail.length >= 2) ? sparklineSvg(seriesFor(it.key), it.color) : "";
      html += `<div class="aqiRow">`;
      html += `<div class="swatch" style="background:${it.color}"></div>`;
      html += `<div class="aqiMain">`;
      html += `<div class="aqiName">${escapeHtml(it.label)}</div>`;
      html += `<div class="aqiMeta"><span class="aqiVal" style="color:${it.color}">${escapeHtml(String(it.value ?? "—"))}</span><span class="aqiSep">·</span><span class="aqiNum">AQI ${escapeHtml(aqiTxt)}</span><span class="aqiSep">·</span><span class="aqiCat" style="color:${it.lvlColor}">${escapeHtml(it.lvlLabel)}</span></div>`;
      html += `</div>`;
      if (spark) html += `<div class="aqiSpark">${spark}</div>`;
      html += `</div>`;
    }
    html += `</div>`;
  }

  html += `<div class="panelTitle" style="margin-top:10px">Readings</div>`;

  if (!keys.length) {
    html += `<div class="muted">No readings</div>`;
  } else {
    // Put the remaining (non-top) pollutants first, then the top ones, so the legend feels authoritative.
    const ordered = [...rest, ...top].map(x => x.key);
    const renderOrder = (ordered.length === keys.length) ? ordered : keys;
    for (const k of renderOrder) {
      const v = readings[k]?.value ?? "—";
      const c = safeHex(readings[k]?.color);
      // Key stays neutral; value carries the color signal.
      html += `<div class="kv"><div class="k">${escapeHtml(k)}</div><div class="v" style="color:${c}">${escapeHtml(String(v))}</div></div>`;
    }
  }
  body.innerHTML = html;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function fetchState() {
  const url = `${appConfig.apiBaseUrl}/state`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

// injectCastleFixedMarker removed - Home sensor now provided by backend with real PM2.5 data

function newestReadingMsFromState(st) {
  // Prefer the most recent timestamp from any mobile breadcrumb point.
  // Fixed sensors currently do not include timestamps in the normalized payload.
  let bestMs = null;
  const mobiles = Array.isArray(st?.mobile) ? st.mobile : [];
  for (const m of mobiles) {
    const trail = Array.isArray(m?.trail) ? m.trail : [];
    const last = trail.length ? trail[trail.length - 1] : null;
    const t = last && typeof last.t === "string" ? last.t : null;
    const ms = t ? parseUtcMs(t) : null;
    if (ms != null && (bestMs == null || ms > bestMs)) bestMs = ms;
  }
  if (bestMs != null) return bestMs;

  // Fallbacks: server meta (seconds) or state ts.
  const sec = (st && st.meta && typeof st.meta.last_position_change_ts === "number")
    ? st.meta.last_position_change_ts
    : (typeof st?.ts === "number" ? st.ts : null);
  return (sec != null && isFinite(sec)) ? (sec * 1000) : null;
}

function main() {
  const tiles = document.getElementById("tilesCanvas");
  const overlay = document.getElementById("overlayCanvas");
  const map = new MapView(tiles, overlay);
  window.__map = map;  // Expose for updateSidebarPlaybackValues

  let selectedId = null; // key: "mobile:ID" or "fixed:ID"

  const TAB_STORAGE_KEY = "mobileair.sidebarTab";
  const SIDEBAR_OPEN_KEY = "mobileair.sidebarOpen";
  const SHOW_MOBILE_KEY = "mobileair.showMobile";
  const SHOW_FIXED_KEY = "mobileair.showFixed";
  // Labels are now per-type; keep legacy key as a migration fallback.
  const SHOW_LABELS_LEGACY_KEY = "mobileair.showLabels";
  const SHOW_MOBILE_LABELS_KEY = "mobileair.showMobileLabels";
  const SHOW_FIXED_LABELS_KEY = "mobileair.showFixedLabels";
  const tabMobileEl = document.getElementById("tabMobile");
  const tabFixedEl = document.getElementById("tabPermanent");
  const tabLabelsEl = document.getElementById("tabLabels");
  const listMobileEl = document.getElementById("sensorListMobile");
  const listFixedEl = document.getElementById("sensorListFixed");
  const sidebarEl = document.getElementById("sidebar");
  const menuBtnEl = document.getElementById("menuBtn");
  const sidebarCloseEl = document.getElementById("sidebarClose");
  
  let activeTab = (localStorage.getItem(TAB_STORAGE_KEY) === "fixed") ? "fixed" : "mobile";
  let sidebarOpen = localStorage.getItem(SIDEBAR_OPEN_KEY) !== "false"; // Default open
  
  // Restore visibility states
  map.showMobile = localStorage.getItem(SHOW_MOBILE_KEY) !== "false";
  map.showFixed = localStorage.getItem(SHOW_FIXED_KEY) !== "false";
  const legacyShowLabels = localStorage.getItem(SHOW_LABELS_LEGACY_KEY);
  map.showMobileLabels = localStorage.getItem(SHOW_MOBILE_LABELS_KEY) != null
    ? (localStorage.getItem(SHOW_MOBILE_LABELS_KEY) !== "false")
    : (legacyShowLabels !== "false");
  map.showFixedLabels = localStorage.getItem(SHOW_FIXED_LABELS_KEY) != null
    ? (localStorage.getItem(SHOW_FIXED_LABELS_KEY) !== "false")
    : (legacyShowLabels !== "false");

  function updateSidebarVisibility() {
    if (sidebarEl) sidebarEl.classList.toggle("hidden", !sidebarOpen);
    localStorage.setItem(SIDEBAR_OPEN_KEY, sidebarOpen ? "true" : "false");
  }
  
  function toggleSidebar() {
    sidebarOpen = !sidebarOpen;
    updateSidebarVisibility();
  }

  function applySidebarTab() {
    const isMobile = (activeTab === "mobile");
    const labelsOn = isMobile ? map.showMobileLabels : map.showFixedLabels;
    // "active" = which list is shown in sidebar
    // "disabled" = markers hidden on map (dimmed look)
    if (tabMobileEl) {
      tabMobileEl.classList.toggle("active", isMobile);
      tabMobileEl.classList.toggle("disabled", !map.showMobile);
      tabMobileEl.setAttribute("aria-selected", isMobile ? "true" : "false");
    }
    if (tabFixedEl) {
      tabFixedEl.classList.toggle("active", !isMobile);
      tabFixedEl.classList.toggle("disabled", !map.showFixed);
      tabFixedEl.setAttribute("aria-selected", !isMobile ? "true" : "false");
    }
    if (tabLabelsEl) {
      tabLabelsEl.classList.toggle("active", labelsOn);
      tabLabelsEl.classList.toggle("disabled", !labelsOn);
    }
    if (listMobileEl) listMobileEl.classList.toggle("hidden", !isMobile);
    if (listFixedEl) listFixedEl.classList.toggle("hidden", isMobile);
    localStorage.setItem(TAB_STORAGE_KEY, isMobile ? "mobile" : "fixed");
    localStorage.setItem(SHOW_MOBILE_KEY, map.showMobile ? "true" : "false");
    localStorage.setItem(SHOW_FIXED_KEY, map.showFixed ? "true" : "false");
    localStorage.setItem(SHOW_MOBILE_LABELS_KEY, map.showMobileLabels ? "true" : "false");
    localStorage.setItem(SHOW_FIXED_LABELS_KEY, map.showFixedLabels ? "true" : "false");
  }

  // Hamburger menu button toggles sidebar
  if (menuBtnEl) {
    menuBtnEl.addEventListener("click", toggleSidebar);
  }
  
  // Close button in sidebar
  if (sidebarCloseEl) {
    sidebarCloseEl.addEventListener("click", () => {
      sidebarOpen = false;
      updateSidebarVisibility();
    });
  }

  // Tab click behavior:
  // - Click inactive tab: switch to that list, make markers visible if hidden
  // - Click active tab: toggle marker visibility on/off
  if (tabMobileEl) {
    tabMobileEl.addEventListener("click", () => {
      if (activeTab === "mobile") {
        // Already on this tab - toggle visibility
        map.showMobile = !map.showMobile;
      } else {
        // Switch to this tab
        activeTab = "mobile";
        // Make visible if hidden
        if (!map.showMobile) map.showMobile = true;
      }
      applySidebarTab();
      map._invalidateOverlayStatic();
      map.drawOverlay(map.lastState);
    });
  }
  
  if (tabFixedEl) {
    tabFixedEl.addEventListener("click", () => {
      if (activeTab === "fixed") {
        // Already on this tab - toggle visibility
        map.showFixed = !map.showFixed;
      } else {
        // Switch to this tab
        activeTab = "fixed";
        // Make visible if hidden
        if (!map.showFixed) map.showFixed = true;
      }
      applySidebarTab();
      map._invalidateOverlayStatic();
      map.drawOverlay(map.lastState);
    });
  }
  
  if (tabLabelsEl) {
    tabLabelsEl.addEventListener("click", () => {
      if (activeTab === "mobile") {
        map.showMobileLabels = !map.showMobileLabels;
      } else {
        map.showFixedLabels = !map.showFixedLabels;
      }
      applySidebarTab();
      map._invalidateOverlayStatic();
      map.drawOverlay(map.lastState);
    });
  }
  
  applySidebarTab();
  updateSidebarVisibility();

  // Persist and restore view (pan/zoom). Keep it simple: store center+zoom with debounce.
  let _viewSaveTimer = null;
  let _viewLastChangedAt = 0;
  const _viewDebounceMs = 250;
  const _nowMs = () => (typeof performance !== "undefined" && performance && typeof performance.now === "function")
    ? performance.now()
    : Date.now();

  function _commitViewToStorage() {
    try {
      const lat = Number(map.center?.lat);
      const lon = Number(map.center?.lon);
      const zoom = Number(map.zoom);
      if (!isFinite(lat) || !isFinite(lon) || !isFinite(zoom)) return;
      localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({ lat, lon, zoom }));
    } catch {
      // ignore
    }
  }

  function _scheduleViewSaveCheck() {
    if (_viewSaveTimer) return; // already scheduled
    const tick = () => {
      _viewSaveTimer = null;
      const dt = _nowMs() - _viewLastChangedAt;
      if (dt >= _viewDebounceMs) {
        _commitViewToStorage();
        return;
      }
      // Still changing: re-arm for the full debounce interval.
      // This avoids frequent short timeouts near the tail end of a long pan stream
      // (Safari can spend noticeable CPU in timer bookkeeping).
      _viewSaveTimer = window.setTimeout(tick, _viewDebounceMs);
    };
    _viewSaveTimer = window.setTimeout(tick, _viewDebounceMs);
  }

  function saveViewSoon() {
    _viewLastChangedAt = _nowMs();
    _scheduleViewSaveCheck();
  }

  // Called from MapView on any pan/zoom change (gesture/wheel/drag/buttons/animations).
  window.__onMapViewChanged = () => saveViewSoon();

  function restoreViewIfAny() {
    try {
      const raw = localStorage.getItem(VIEW_STORAGE_KEY);
      if (!raw) return false;
      const v = JSON.parse(raw);
      const lat = Number(v?.lat);
      const lon = Number(v?.lon);
      const zoom = Number(v?.zoom);
      if (!isFinite(lat) || !isFinite(lon) || !isFinite(zoom)) return false;
      map.center = { lat, lon };
      map.zoom = clamp(zoom, map._zoomMin ?? 3, map._zoomMax ?? 18);
      return true;
    } catch {
      return false;
    }
  }

  // Theme + per-theme dimming/saturation sliders (persisted).
  const themeEl = document.getElementById("mapTheme");
  const dimEl = document.getElementById("mapDim");
  const satEl = document.getElementById("mapSat");

  map.setMaxTrailLen(MAX_TRAIL_LEN);

  function dimToBrightness(dim01) {
    // dim01: 0..1 where 1 == brightest; map to a conservative brightness range.
    // 0 -> 0.55, 1 -> 0.90
    return 0.55 + dim01 * 0.35;
  }

  // Map theme variants to shared settings key (e.g., carto_dark_all and carto_dark_nolabels share settings)
  function getThemeSettingsKey(themeKey) {
    const k = String(themeKey);
    if (k.startsWith("carto_dark")) return "carto_dark";
    if (k.startsWith("carto_positron")) return "carto_positron";
    return k; // osm, carto_voyager, etc. stay as-is
  }

  function loadDimForTheme(themeKey) {
    const settingsKey = getThemeSettingsKey(themeKey);
    const raw = localStorage.getItem(DIM_STORAGE_PREFIX + settingsKey);
    const t = TILE_THEMES[themeKey] || TILE_THEMES.carto_dark_all;
    const def = t.defaultDim ?? 50;
    const v = raw == null ? def : Number(raw);
    const dimMax = isThemeDark(themeKey) ? 150 : 100;
    const clamped = Math.max(0, Math.min(dimMax, isFinite(v) ? v : def));
    return clamped;
  }

  function loadSatForTheme(themeKey) {
    const settingsKey = getThemeSettingsKey(themeKey);
    const raw = localStorage.getItem(SAT_STORAGE_PREFIX + settingsKey);
    const t = TILE_THEMES[themeKey] || TILE_THEMES.carto_dark_all;
    const def = Math.round(100 * (t.filter?.saturate ?? 0.55));
    const v = raw == null ? def : Number(raw);
    const clamped = Math.max(0, Math.min(150, isFinite(v) ? v : def));
    return clamped;
  }

  function applyThemeAndFilters(themeKey, dimVal0to100, satVal0to150) {
    const t = TILE_THEMES[themeKey] || TILE_THEMES.carto_dark_all;
    map.setTheme(themeKey);

    const dim01 = (dimVal0to100 / 100);
    const brightness = dimToBrightness(dim01);
    const isDarkTheme = String(themeKey).includes("dark");
    // For dark themes, use Sat slider as a "shadow lift" mix (only tiles, overlays unaffected).
    // Saturation still applies, but we clamp it to avoid making dark basemaps neon.
    const sat = isDarkTheme ? Math.min(1.0, (satVal0to150 / 100)) : (satVal0to150 / 100);
    // Lift only kicks in above 100; 100..150 -> 0..0.28 opacity.
    const shadowLift = isDarkTheme ? clamp((satVal0to150 - 100) / 50, 0, 1) * 0.28 : 0;
    applyMapFilterVars({
      saturate: sat,
      brightness: brightness,
      contrast: t.filter?.contrast ?? 1.12,
      shadowLift,
    });
    // Set map background color to match theme (prevents flash while tiles load)
    if (t.bgColor) {
      document.documentElement.style.setProperty('--map-bg', t.bgColor);
    }
  }

  // Detect system color scheme preference
  function isSystemDarkMode() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  
  function isThemeDark(themeKey) {
    return String(themeKey).includes("dark");
  }
  
  function getThemeStorageKey() {
    return isSystemDarkMode() ? THEME_STORAGE_KEY_DARK : THEME_STORAGE_KEY_LIGHT;
  }
  
  function getDefaultThemeForMode() {
    return isSystemDarkMode() ? "carto_dark_all" : "carto_voyager";
  }
  
  function getSavedThemeForCurrentMode() {
    const key = getThemeStorageKey();
    const saved = localStorage.getItem(key);
    return (saved && TILE_THEMES[saved]) ? saved : getDefaultThemeForMode();
  }
  
  function saveThemeForMode(themeKey) {
    // Save to the appropriate key based on whether this is a dark or light theme
    const isDark = isThemeDark(themeKey);
    const key = isDark ? THEME_STORAGE_KEY_DARK : THEME_STORAGE_KEY_LIGHT;
    localStorage.setItem(key, themeKey);
  }

  // Track current theme for menu updates
  let _currentThemeKey = getSavedThemeForCurrentMode();

  function applyTheme(themeKey, skipSubmenuUpdate) {
    _currentThemeKey = themeKey;
    if (themeEl) themeEl.value = themeKey;
    const dim = loadDimForTheme(themeKey);
    if (dimEl) dimEl.value = String(dim);
    const sat = loadSatForTheme(themeKey);
    if (satEl) satEl.value = String(sat);
    applyThemeAndFilters(themeKey, dim, sat);
    // updateThemeSubmenu is defined later, only call it when triggered by system theme change
    if (!skipSubmenuUpdate && window._updateThemeSubmenu) window._updateThemeSubmenu();
  }

  if (themeEl) {
    const keys = Object.keys(TILE_THEMES);
    for (const k of keys) {
      const opt = document.createElement("option");
      opt.value = k;
      opt.textContent = TILE_THEMES[k].label || k;
      themeEl.appendChild(opt);
    }

    // Load saved theme for current system mode
    const initialTheme = getSavedThemeForCurrentMode();
    applyTheme(initialTheme, true); // skip submenu update on init (not created yet)

    themeEl.addEventListener("change", () => {
      const k = themeEl.value;
      _currentThemeKey = k;
      saveThemeForMode(k);
      const dim = loadDimForTheme(k);
      if (dimEl) dimEl.value = String(dim);
      const sat = loadSatForTheme(k);
      if (satEl) satEl.value = String(sat);
      applyThemeAndFilters(k, dim, sat);
      updateThemeSubmenu();
    });
  } else {
    // Fallback (no UI) - use system preference
    const fallbackTheme = getSavedThemeForCurrentMode();
    _currentThemeKey = fallbackTheme;
    const fallbackT = TILE_THEMES[fallbackTheme];
    applyThemeAndFilters(fallbackTheme, fallbackT.defaultDim ?? 70, Math.round(100 * (fallbackT.filter?.saturate ?? 1.30)));
  }
  
  // Listen for system theme changes
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      const newTheme = getSavedThemeForCurrentMode();
      applyTheme(newTheme);
    });
  }

  // Restore view after map is initialized (theme/filter doesn't affect center/zoom).
  restoreViewIfAny();

  if (dimEl) {
    dimEl.addEventListener("input", () => {
      const themeKey = (themeEl && TILE_THEMES[themeEl.value]) ? themeEl.value : "carto_dark_all";
      const settingsKey = getThemeSettingsKey(themeKey);
      const isDark = isThemeDark(themeKey);
      const dimMax = isDark ? 150 : 100;
      const v = Number(dimEl.value);
      const clamped = Math.max(0, Math.min(dimMax, isFinite(v) ? v : 50));
      localStorage.setItem(DIM_STORAGE_PREFIX + settingsKey, String(clamped));
      const sat = satEl ? Number(satEl.value) : loadSatForTheme(themeKey);
      const satClamped = Math.max(0, Math.min(150, isFinite(sat) ? sat : loadSatForTheme(themeKey)));
      applyThemeAndFilters(themeKey, clamped, satClamped);
    });
  }

  if (satEl) {
    satEl.addEventListener("input", () => {
      const themeKey = (themeEl && TILE_THEMES[themeEl.value]) ? themeEl.value : "carto_dark_all";
      const settingsKey = getThemeSettingsKey(themeKey);
      const isDark = isThemeDark(themeKey);
      const dimMax = isDark ? 150 : 100;
      const v = Number(satEl.value);
      const clamped = Math.max(0, Math.min(150, isFinite(v) ? v : loadSatForTheme(themeKey)));
      localStorage.setItem(SAT_STORAGE_PREFIX + settingsKey, String(clamped));
      const dim = dimEl ? Number(dimEl.value) : loadDimForTheme(themeKey);
      const dimClamped = Math.max(0, Math.min(dimMax, isFinite(dim) ? dim : loadDimForTheme(themeKey)));
      applyThemeAndFilters(themeKey, dimClamped, clamped);
    });
  }

  window.__selectSensor = (id, opts = {}) => {
    const fitTrail = !!opts.fitTrail;
    // Toggle: clicking the selected sensor again deselects.
    if (id && selectedId === id) {
      selectedId = null;
      if (map && typeof map.cancelSelectionOrchestration === "function") map.cancelSelectionOrchestration();
      map.setSelected(null);
      renderLists(window.__lastState || { mobile: [], fixed: [] }, selectedId);
      renderDetails(window.__lastState || { mobile: [] }, selectedId);
      return;
    }

    selectedId = id || null;
    map.setSelected(selectedId);

    const st = window.__lastState || { mobile: [], fixed: [] };
    const sel = parseKey(selectedId);
    let item = null;
    if (sel && sel.type === "mobile") item = (Array.isArray(st.mobile) ? st.mobile : []).find(x => x.id === sel.id) || null;
    if (sel && sel.type === "fixed") item = (Array.isArray(st.fixed) ? st.fixed : []).find(x => x.id === sel.id) || null;
    if (item && isFinite(Number(item.lat)) && isFinite(Number(item.lon))) {
      // Default: center on the marker.
      // Cmd+click: fit to breadcrumb path bbox (mobile only).
      if (fitTrail && sel?.type === "mobile" && Array.isArray(item.trail) && item.trail.length >= 2) {
        map.fitTrailBounds(item.trail, { animate: true });
      } else if (sel?.type === "mobile" && map.playbackMode) {
        const pose = map._mobilePoseForRender(item, performance.now());
        if (pose && isFinite(Number(pose.lat)) && isFinite(Number(pose.lon))) {
          map.centerOn(Number(pose.lat), Number(pose.lon), { animate: true });
        } else {
          map.centerOn(Number(item.lat), Number(item.lon), { animate: true });
        }
      } else if (sel?.type === "mobile" && typeof map.orchestrateSelectionToLatest === "function") {
        // Polished selection: focus camera on latest data location and keep trace marker in sync.
        map.orchestrateSelectionToLatest(item, { fitTrail: false });
      } else {
        map.centerOn(Number(item.lat), Number(item.lon), { animate: true });
      }
      saveViewSoon();
    }
    renderLists(st, selectedId);
    renderDetails(st, selectedId);
  };

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      selectedId = null;
      map.setSelected(null);
      renderLists(window.__lastState || { mobile: [], fixed: [] }, selectedId);
      renderDetails(window.__lastState || { mobile: [] }, selectedId);
    }
  });

  const zoomInEl = document.getElementById("zoomIn");
  const zoomOutEl = document.getElementById("zoomOut");
  if (zoomInEl) zoomInEl.addEventListener("click", () => map.zoomBy(1));
  if (zoomOutEl) zoomOutEl.addEventListener("click", () => map.zoomBy(-1));
  const traceEl = document.getElementById("toggleTrace");
  const pbBarEl = document.getElementById("playbackBar");
  const pbPlayEl = document.getElementById("pbPlay");
  const pbScrubEl = document.getElementById("pbScrub");
  const pbSpeedEl = document.getElementById("pbSpeed");
  const pbDebugEl = document.getElementById("pbDebugPath");
  const pbLeftEl = document.getElementById("pbLeft");
  const pbNowEl = document.getElementById("pbNow");
  const pbRightEl = document.getElementById("pbRight");

  let _pbRAF = null;
  let _pbLastPerf = 0;
  let _pbLastUiPerf = 0;
  let _pbScrubbing = false;      // true when pointer is down on scrub bar
  let _pbLastScrubPos = 0;
  let _pbLastScrubTime = 0;

  // ─────────────────────────────────────────────────────────────────────────────
  // PHYSICS-BASED PLAYBACK: Everything is driven by velocity and forces.
  // No state flags for "rewind" - just physics simulation.
  // ─────────────────────────────────────────────────────────────────────────────
  
  // Velocity in "playback ms per wall ms" (1.0 = real-time forward, -15 = fast rewind)
  let _pbVelocity = 0;
  
  // Track when we hit the end and are waiting for vehicles to physically reach the
  // end of their paths (no fixed pause; rewind triggers when vehicles are done).
  let _pbAtEndSincePerf = null;   // performance.now() when we started waiting at end
  let _pbArrivedAtEndViaPlayback = false; // true only if we PLAYED to the end (not scrolled)
  
  // Track when ease-in phase started (for wall-time-based easing)
  let _pbEaseStartPerf = null;
  let _pbEaseStartVelocity = 0;
  let _pbEaseStartPos = 0;  // playhead position when ease began
  
  // Flag to track active rewind (not based on velocity)
  let _pbIsRewinding = false;

  // Replay loop start ("point A"): where playback started / where the user last left the playhead.
  // Auto-rewind returns here instead of rewinding to the global min bound.
  let _pbLoopStartMs = null;
  
  // Track data bounds to detect new data / trimmed data
  let _pbLastKnownMinMs = null;
  let _pbLastKnownMaxMs = null;

  // Server can bump this to force LIVE camera follow even if data timestamps are unchanged.
  let _pbLastForceRefreshSeq = null;
  
  // ─────────────────────────────────────────────────────────────────────────────
  // LIVE BUFFER: Track wall-clock time since app started to know how much data we have.
  // Buffer = time since first data arrival. Playback replays this accumulated buffer.
  // ─────────────────────────────────────────────────────────────────────────────
  let _pbLiveStartWallMs = null;        // wall-clock time (perf.now) when LIVE mode started
  let _pbLiveStartDataMs = null;        // data time (maxMs) when LIVE mode started
  const _pbLiveStallThreshold = 3;      // stalls before auto-rewind in LIVE mode
  let _pbLiveTargetMs = null;           // where playback should aim in LIVE mode
  let _pbLiveStallCount = 0;            // how many times we've hit end waiting for data
  
  // Helper to reset LIVE tracking (call when exiting LIVE mode)
  // Exposed on map object so class methods can call it
  function _resetLiveTracking() {
    _pbLiveStartWallMs = null;
    _pbLiveStartDataMs = null;
    _pbLiveStallCount = 0;
  }
  map._resetLiveTracking = _resetLiveTracking;
  
  // LIVE camera follow: smooth pan/zoom to fit moving vehicles
  const _pbLiveFollowDurationMs = 2000; // animation duration for camera follow (slow, smooth)
  const _pbLiveFollowPadding = 0.15;    // extra padding around bounds (15%)

  function _animateFitBoundsLatLon({ minLat, minLon, maxLat, maxLon }, { durationMs = _pbLiveFollowDurationMs } = {}) {
    if (!isFinite(minLat) || !isFinite(maxLat) || !isFinite(minLon) || !isFinite(maxLon)) return;

    // User interaction always wins: do not start/continue auto camera fits while the user
    // is actively panning/zooming, or during the post-interaction cooldown.
    if (map && typeof map._canRunAutoCamera === "function" && !map._canRunAutoCamera()) return;

    // Add padding
    const latRange = maxLat - minLat;
    const lonRange = maxLon - minLon;
    const latPad = Math.max(latRange * _pbLiveFollowPadding, 0.01); // minimum ~1km
    const lonPad = Math.max(lonRange * _pbLiveFollowPadding, 0.01);

    minLat -= latPad;
    maxLat += latPad;
    minLon -= lonPad;
    maxLon += lonPad;

    // Compute target zoom and center (similar to fitBoundsLatLon but with custom animation)
    const w0 = 256;
    const xMin0 = lonToX(minLon, w0);
    const xMax0 = lonToX(maxLon, w0);
    const yMin0 = latToY(maxLat, w0);
    const yMax0 = latToY(minLat, w0);
    const dx0 = Math.max(1e-6, Math.abs(xMax0 - xMin0));
    const dy0 = Math.max(1e-6, Math.abs(yMax0 - yMin0));

    const rect = map.overlayCanvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const pad = map._getOverlayPaddingPx ? map._getOverlayPaddingPx() : { left: 0, right: 0, top: 0, bottom: 0 };
    const availW = Math.max(40, w - pad.left - pad.right);
    const availH = Math.max(40, h - pad.top - pad.bottom);

    const scale = Math.min(availW / dx0, availH / dy0);
    let targetZoom = Math.log2(scale);
    targetZoom -= 0.18; // breathing room
    targetZoom = clamp(targetZoom, map._zoomMin || 1, map._zoomMax || 20);

    // Center of bbox
    const cx0 = (xMin0 + xMax0) / 2;
    const cy0 = (yMin0 + yMax0) / 2;
    const centerLL = worldToLatLon(cx0, cy0, 0);

    // Adjust for panel offset
    const targetScreenX = pad.left + availW / 2;
    const targetScreenY = pad.top + availH / 2;
    const cWorld = latLonToWorld(centerLL.lat, centerLL.lon, targetZoom);
    const centerWorldX = cWorld.x - (targetScreenX - w / 2);
    const centerWorldY = cWorld.y - (targetScreenY - h / 2);
    const finalCenter = worldToLatLon(centerWorldX, clamp(centerWorldY, 0, cWorld.ws - 1), targetZoom);

    // Debounce: only animate if it would materially change the camera.
    try {
      const qLatLon = (x) => (isFinite(x) ? Math.round(x * 1e5) : NaN);
      const qZoom = (x) => (isFinite(x) ? Math.round(x * 1e3) : NaN);
      const curr = map && map.center ? map.center : { lat: NaN, lon: NaN };
      const currentSig = `${qLatLon(Number(curr.lat))}|${qLatLon(Number(curr.lon))}|${qZoom(Number(map?.zoom))}`;
      const targetSig = `${qLatLon(Number(finalCenter.lat))}|${qLatLon(Number(finalCenter.lon))}|${qZoom(Number(targetZoom))}`;

      if (currentSig === targetSig) return;
      if (map && map._centerAnimRAF && map._autoFitInFlightSig === targetSig) return;
      if (map) {
        map._autoFitInFlightSig = targetSig;
        map._lastAutoFitSig = targetSig;
      }
    } catch {
      // ignore
    }

    map._animateTo(
      { centerLat: finalCenter.lat, centerLon: finalCenter.lon, zoom: targetZoom },
      { durationMs }
    );
  }

  function _collectBoundsForMobilesNewSegment(mobiles, windowStartMs, windowEndMs) {
    try {
      const logic = (typeof window !== "undefined") ? window.CameraFitLogic : null;
      if (logic && typeof logic.collectBoundsForMobilesNewSegment === "function") {
        return logic.collectBoundsForMobilesNewSegment(mobiles, windowStartMs, windowEndMs, {
          includeDebugPath: !!map._pbDebugPath,
          minTrailLengthM: MapView.MIN_TRAIL_LENGTH_M,
          minVisibleSegmentPoints: MapView.MIN_CAMERA_FIT_SEGMENT_POINTS,
          minVisibleSegmentLengthM: MapView.MIN_CAMERA_FIT_SEGMENT_LENGTH_M,
          minVisibleSegmentDisplacementM: MapView.MIN_CAMERA_FIT_SEGMENT_DISPLACEMENT_M,
          minVisibleSegmentStraightness: MapView.MIN_CAMERA_FIT_SEGMENT_STRAIGHTNESS,
          minVisibleSegmentLengthM2: MapView.MIN_CAMERA_FIT_SEGMENT_LENGTH_M_2PT,
          minVisibleSegmentDisplacementM2: MapView.MIN_CAMERA_FIT_SEGMENT_DISPLACEMENT_M_2PT,
        });
      }
    } catch {
      // fall through to legacy implementation
    }

    let minLat = Infinity, maxLat = -Infinity;
    let minLon = Infinity, maxLon = -Infinity;
    let visibleVehicleCount = 0;
    let visiblePointCount = 0;

    const _trailMeetsMinLength = (trail) => {
      if (!Array.isArray(trail) || trail.length < 2) return false;
      let totalM = 0;
      let prev = null;
      for (const p of trail) {
        const lat = Number(p?.lat);
        const lon = Number(p?.lon);
        if (!isFinite(lat) || !isFinite(lon)) continue;
        if (prev) {
          const d = haversineMeters(prev.lat, prev.lon, lat, lon);
          if (isFinite(d)) totalM += d;
          if (totalM >= MapView.MIN_TRAIL_LENGTH_M) return true;
        }
        prev = { lat, lon };
      }
      return (totalM >= MapView.MIN_TRAIL_LENGTH_M);
    };

    // Collect a recent visible (moving) segment ending at/before windowEndMs.
    // Used when a vehicle has no points inside the update window, but still has a
    // visible trail we should consider for camera fit.
    const _collectRecentVisibleSegment = (trail) => {
      if (!Array.isArray(trail) || trail.length < 2) return [];
      const out = [];
      let totalM = 0;
      let prev = null;
      for (let i = trail.length - 1; i >= 0; i--) {
        const p = trail[i];
        if (!p) continue;
        const tStr = (typeof p.t === "string") ? p.t : null;
        const tPointMs = tStr ? parseUtcMs(tStr) : null;
        if (windowEndMs != null && tPointMs != null && tPointMs > windowEndMs) continue;

        const isMoving = !!(p && (p.m === 1 || p.m === "1" || p.m === true));
        const isVisiblePt = !!map._pbDebugPath || isMoving;
        if (!isVisiblePt) continue;

        const lat = Number(p.lat);
        const lon = Number(p.lon);
        if (!isFinite(lat) || !isFinite(lon)) continue;

        if (prev) {
          const d = haversineMeters(lat, lon, prev.lat, prev.lon);
          if (isFinite(d)) totalM += d;
        }
        out.push({ lat, lon });
        prev = { lat, lon };

        if (totalM >= MapView.MIN_TRAIL_LENGTH_M) break;
      }
      return out;
    };

    const _segmentStatsMeters = (pts) => {
      if (!Array.isArray(pts) || pts.length < 2) return { totalM: 0, displacementM: 0, straightness: 0 };
      let totalM = 0;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const d = haversineMeters(Number(a?.lat), Number(a?.lon), Number(b?.lat), Number(b?.lon));
        if (isFinite(d)) totalM += d;
      }
      const first = pts[0];
      const last = pts[pts.length - 1];
      const displacementM = haversineMeters(
        Number(first?.lat),
        Number(first?.lon),
        Number(last?.lat),
        Number(last?.lon)
      );
      const disp = isFinite(displacementM) ? displacementM : 0;
      const straightness = totalM > 0 ? disp / totalM : 0;
      return { totalM, displacementM: disp, straightness };
    };

    for (const m of mobiles) {
      if (!m || m.ghosted) continue;

      const trail = Array.isArray(m.trail) ? m.trail : [];
      if (trail.length === 0) continue;

      // Ignore jitter-only trails based on overall trail length.
      // Do NOT filter on per-update segment length; real movement per poll can be short.
      if (!_trailMeetsMinLength(trail)) continue;

      const candidate = [];

      for (let i = trail.length - 1; i >= 0; i--) {
        const p = trail[i];
        if (!p) continue;

        const tStr = (p && typeof p.t === "string") ? p.t : null;
        const tPointMs = tStr ? parseUtcMs(tStr) : null;
        if (windowEndMs != null && tPointMs != null && tPointMs > windowEndMs) {
          continue;
        }
        if (windowStartMs != null && tPointMs != null && tPointMs < windowStartMs) {
          if (candidate.length > 0) {
            const isMoving = !!(p && (p.m === 1 || p.m === "1" || p.m === true));
            const isVisiblePt = !!map._pbDebugPath || isMoving;
            if (isVisiblePt) {
              const lat = Number(p.lat);
              const lon = Number(p.lon);
              if (isFinite(lat) && isFinite(lon)) {
                candidate.push({ lat, lon });
              }
            }
          }
          break;
        }

        const isMoving = !!(p && (p.m === 1 || p.m === "1" || p.m === true));
        const isVisiblePt = !!map._pbDebugPath || isMoving;
        if (!isVisiblePt) continue;

        const lat = Number(p.lat);
        const lon = Number(p.lon);
        if (!isFinite(lat) || !isFinite(lon)) continue;

        candidate.push({ lat, lon });
      }

      // If this vehicle had no points inside the update window, include a recent
      // visible (moving) segment from the past so the camera fit reflects what’s
      // actually visible on the map.
      if (candidate.length === 0) {
        const recent = _collectRecentVisibleSegment(trail);
        if (recent.length > 0) {
          candidate.push(...recent);
        }
      }

      // Guard against false-positive tiny "moving" slivers from GPS noise.
      if (!map._pbDebugPath) {
        const st = _segmentStatsMeters(candidate);

        const allowTwoPoint =
          candidate.length === 2 &&
          st.totalM >= MapView.MIN_CAMERA_FIT_SEGMENT_LENGTH_M_2PT &&
          st.displacementM >= MapView.MIN_CAMERA_FIT_SEGMENT_DISPLACEMENT_M_2PT;

        if (!allowTwoPoint) {
          if (candidate.length < MapView.MIN_CAMERA_FIT_SEGMENT_POINTS) continue;
          if (st.totalM < MapView.MIN_CAMERA_FIT_SEGMENT_LENGTH_M) continue;
          if (st.displacementM < MapView.MIN_CAMERA_FIT_SEGMENT_DISPLACEMENT_M) continue;
          if (st.straightness < MapView.MIN_CAMERA_FIT_SEGMENT_STRAIGHTNESS) continue;
        }
      }

      for (const pt of candidate) {
        minLat = Math.min(minLat, pt.lat);
        maxLat = Math.max(maxLat, pt.lat);
        minLon = Math.min(minLon, pt.lon);
        maxLon = Math.max(maxLon, pt.lon);
        visiblePointCount++;
      }
      visibleVehicleCount++;
    }

    return { minLat, minLon, maxLat, maxLon, visibleVehicleCount, visiblePointCount };
  }
  
  // Physics constants
  const _pbPlaybackSpeed = 1.0;       // target velocity when playing forward
  const _pbRewindSpeed = -100.0;      // target velocity when rewinding (negative = backward, FAST)
  const _pbFriction = 0.997;          // velocity decay per ms when coasting (drag inertia)
  const _pbWheelFriction = 0.985;     // velocity decay per ms for wheel scroll (stops faster)
  const _pbForceStrength = 0.008;     // how quickly velocity changes toward target (per ms)
  const _pbVelocityThreshold = 0.1;   // below this, considered "at rest"
  const _pbEaseInDistance = 0.02;     // start braking when within 2% of bounds (only near edges)

  // When playhead hits end, wait until all vehicle physics states have reached
  // the end of their path, then trigger rewind.
  const _pbVehicleDoneEpsM = 1.0;
  const _pbVehicleDoneVelEpsMps = 0.05;

  function _pbAllVehiclesReachedPlaybackEnd(state) {
    try {
      const mobiles = Array.isArray(state?.mobile) ? state.mobile : [];
      let considered = 0;
      for (const m of mobiles) {
        if (!m || m.ghosted) continue;
        const id = (m.id != null) ? String(m.id) : "";
        if (!id) continue;

        const pts = (map && map._playbackPtsById) ? map._playbackPtsById.get(id) : null;
        if (!pts || pts.length < 1) continue;

        // Single-point paths are trivially "done".
        if (pts.length === 1) {
          considered++;
          continue;
        }

        const distInfo = (typeof map?._getPathDistances === "function") ? map._getPathDistances(id, pts) : null;
        const totalDist = distInfo && isFinite(distInfo.totalDist) ? distInfo.totalDist : 0;
        const phys = (typeof map?._getPhysicsState === "function") ? map._getPhysicsState(id) : null;
        const d = phys && isFinite(phys.d) ? phys.d : 0;
        const v = phys && isFinite(phys.v) ? phys.v : 0;

        considered++;
        if (!(d >= (totalDist - _pbVehicleDoneEpsM) && v <= _pbVehicleDoneVelEpsMps)) {
          return false;
        }
      }
      // If we had no vehicles to consider, don't stall.
      return true;
    } catch {
      return true;
    }
  }
  
  // Scroll wheel nudge (iPod-style momentum)
  let _pbWheelAccum = 0;              // accumulated wheel delta
  const _pbWheelImpulse = 1.0;        // velocity added per wheel tick
  const _pbWheelDecay = 0.8;          // wheel accumulator decay per frame

  // Drag tracking
  let _pbDidDrag = false;             // did the user actually drag (vs click)?
  let _pbIsWheelCoasting = false;     // is current coast from wheel scroll?
  let _pbCommitLoopStartOnCoastEnd = false;

  const fmtTime = (ms) => {
    if (ms == null || !isFinite(ms)) return "—";
    try { return new Date(ms).toLocaleTimeString(); } catch { return "—"; }
  };

  const updatePlaybackUi = () => {
    const b = map.getPlaybackBounds();
    const tMs = map.getPlaybackTimeMs();
    if (pbLeftEl) pbLeftEl.textContent = fmtTime(b.minMs);
    if (pbRightEl) pbRightEl.textContent = fmtTime(b.maxMs);
    if (pbNowEl) pbNowEl.textContent = fmtTime(tMs);

    if (pbScrubEl && isFinite(b.minMs) && isFinite(b.maxMs) && b.maxMs > b.minMs) {
      const durMs = Math.max(1, b.maxMs - b.minMs);
      const tRelMs = (tMs != null && isFinite(tMs)) ? (tMs - b.minMs) : durMs;
      pbScrubEl.min = "0";
      pbScrubEl.max = String(durMs);
      pbScrubEl.step = "100"; // 100ms steps for smoother scrubbing
      pbScrubEl.disabled = false;
      if (!_pbScrubbing) {
        // Show actual playhead position (don't force to end in LIVE mode)
        pbScrubEl.value = String(clamp(tRelMs, 0, durMs));
      }
    } else if (pbScrubEl) {
      pbScrubEl.disabled = true;
      pbScrubEl.min = "0";
      pbScrubEl.max = "1";
      pbScrubEl.value = "0";
    }

    const hasBounds = isFinite(b.minMs) && isFinite(b.maxMs) && b.maxMs > b.minMs;
    const atEnd = !hasBounds || map.isPlaybackAtEnd(200);
    // LIVE mode is based on the flag, not position - we're replaying the buffer
    const followingLive = map._playbackLiveFollow;

    if (pbPlayEl) {
      if (followingLive) {
        // LIVE mode enabled: show Live button highlighted
        pbPlayEl.textContent = "Live";
        pbPlayEl.classList.add("isLive");
      } else if (atEnd) {
        // At end but LIVE not enabled: show Live button (not highlighted)
        pbPlayEl.textContent = "Live";
        pbPlayEl.classList.remove("isLive");
      } else if (map.getPlaybackPlaying()) {
        // Playing but not at end: show Pause
        pbPlayEl.textContent = "Pause";
        pbPlayEl.classList.remove("isLive");
      } else {
        // Paused: show Play
        pbPlayEl.textContent = "Play";
        pbPlayEl.classList.remove("isLive");
      }
    }
    if (pbSpeedEl) pbSpeedEl.value = String(map.getPlaybackSpeed() || 1.0);
  };

  const playbackLoop = () => {
    _pbRAF = null;
    // Allow loop to run in DVR mode OR LIVE mode (both need playback time updates)
    if (!map.playbackMode && !map._playbackLiveFollow) return;
    
    try {
    const now = performance.now();
    const dt = (_pbLastPerf > 0) ? (now - _pbLastPerf) : 0;
    _pbLastPerf = now;

    const b = map.getPlaybackBounds();
    let tMs = map.getPlaybackTimeMs();
    const hasBounds = isFinite(b.minMs) && isFinite(b.maxMs) && b.maxMs > b.minMs;
    const durMs = hasBounds ? (b.maxMs - b.minMs) : 1;
    const prevKnownMaxMs = _pbLastKnownMaxMs;
    
    // Playhead initialization is handled in tick() when data arrives

    // ─────────────────────────────────────────────────────────────────────────
    // DETECT DATA CHANGES (new data arrived, or data trimmed)
    // ─────────────────────────────────────────────────────────────────────────
    let newDataArrived = false;
    let forceCameraFit = false;
    
    if (hasBounds) {
      if (_pbLastKnownMaxMs != null && b.maxMs > _pbLastKnownMaxMs + 100) {
        newDataArrived = true;
        // Record the update window for future forced camera fits.
        if (typeof prevKnownMaxMs === "number" && isFinite(prevKnownMaxMs)) {
          _pbLastDataUpdateWindowStartMs = prevKnownMaxMs;
          _pbLastDataUpdateWindowEndMs = b.maxMs;
        }
        // Reset stall counter when fresh data arrives
        _pbLiveStallCount = 0;
      }
      _pbLastKnownMinMs = b.minMs;
      _pbLastKnownMaxMs = b.maxMs;
      
      // If playhead is now outside bounds (data trimmed or server restarted), handle it
      if (tMs != null && isFinite(tMs)) {
        if (tMs < b.minMs) {
          // In LIVE mode, jump to live edge; otherwise clamp to minMs
          if (map._playbackLiveFollow) {
            tMs = b.maxMs;
          } else {
            tMs = b.minMs;
          }
          map.setPlaybackTimeMs(tMs);
        }
        if (tMs > b.maxMs) {
          tMs = b.maxMs;
          map.setPlaybackTimeMs(tMs);
        }
      }
    }

    // Forced refresh: treat as a new-data event even if bounds didn't move.
    // This is used by the terminal TUI to request a camera fit/zoom in the web UI.
    try {
      const state = map.lastState;
      const seq = state?.meta?.force_refresh_seq;
      if (typeof seq === "number" && isFinite(seq)) {
        if (_pbLastForceRefreshSeq == null) {
          // If the server seq is already >0 when playback starts (e.g. TUI refresh happened first),
          // treat it as a one-time forced camera fit.
          if (seq > 0) {
            newDataArrived = true;
            forceCameraFit = true;
            _pbLiveStallCount = 0;
          }
        } else if (seq !== _pbLastForceRefreshSeq) {
          newDataArrived = true;
          forceCameraFit = true;
          _pbLiveStallCount = 0;
        }
        _pbLastForceRefreshSeq = seq;
      }
    } catch {
      // ignore
    }

    // When new server data arrives (or TUI forces a refresh), rewind the playhead so the
    // newest segment gets replayed.
    //
    // Important: scale the rewind by the current playback speed.
    // If the server updates every ~10 minutes and playback speed is 5x, the client will
    // have consumed ~50 minutes of data-time between updates; we must rewind ~50 minutes
    // of data-time to replay what happened since the last update.
    // When new data arrives, rewind playback to give runway for animation
    // We just got fresh data, so time until next update is the full predicted interval
    // Account for playback speed: at 5x, we consume data 5x faster, so need 5x runway
    // Check both playing AND liveFollow since LIVE mode at end has playing=false
    if (hasBounds && (newDataArrived || forceCameraFit) && (map.getPlaybackPlaying() || map._playbackLiveFollow)) {
      const meta = map.lastState?.meta;
      const predictedIntervalS = Number(meta?.polling_predicted_interval_s) || 600;
      const timeSinceChangeS = Number(meta?.polling_time_since_change_s) || 0;
      const timeUntilNextMs = Math.max(60000, (predictedIntervalS - timeSinceChangeS) * 1000);
      const speed = map.getPlaybackSpeed() || 1.0;
      const offsetMs = timeUntilNextMs * speed;
      
      const targetMs = b.maxMs - offsetMs;
      const nextMs = clamp(targetMs, b.minMs, b.maxMs);
      
      if (tMs == null || !isFinite(tMs) || Math.abs(nextMs - tMs) > 200) {
        tMs = nextMs;
        map.setPlaybackTimeMs(tMs);
        _pbLoopStartMs = tMs;
        // Start playback if we were waiting in LIVE mode
        if (map._playbackLiveFollow && !map.getPlaybackPlaying()) {
          _pbVelocity = _pbPlaybackSpeed * speed;
          map.setPlaybackPlaying(true);
        }
      }
    }
    
    // ─────────────────────────────────────────────────────────────────────────
    // LIVE BUFFER CALCULATION
    // Buffer = wall-clock time since LIVE started (how much data we've accumulated).
    // Playback consumes this buffer at playbackSpeed rate.
    // ─────────────────────────────────────────────────────────────────────────
    let liveBufferMs = 0;
    
    if (hasBounds && map._playbackLiveFollow) {
      // Initialize playhead if not set (handled above, but keep for safety)
      if (tMs == null || !isFinite(tMs)) {
        const meta = map.lastState?.meta;
        const predictedIntervalS = Number(meta?.polling_predicted_interval_s) || 600;
        const speed = map.getPlaybackSpeed() || 1.0;
        const offsetMs = predictedIntervalS * 1000 * speed;
        tMs = Math.max(b.minMs, b.maxMs - offsetMs);
        map.setPlaybackTimeMs(tMs);
      }
      
      // Initialize LIVE tracking on first entry
      if (_pbLiveStartWallMs == null) {
        _pbLiveStartWallMs = now;
        _pbLiveStartDataMs = b.maxMs;
      }
      
      // Buffer = wall-clock time since we started LIVE mode
      // This is how much new data has accumulated since we began
      const wallElapsed = now - _pbLiveStartWallMs;
      liveBufferMs = wallElapsed;
      
      // Target = newest data minus the buffer (stay behind the live edge)
      // The buffer grows in real-time, so we always have runway
      _pbLiveTargetMs = b.maxMs - liveBufferMs;
      
      // Clamp: if rewind outpaces buffer accumulation, just use minMs
      if (_pbLiveTargetMs < b.minMs) {
        _pbLiveTargetMs = b.minMs;
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // LIVE CAMERA FOLLOW: Smooth pan/zoom to fit the *newly updated* visible trail.
    // The server is authoritative for the update window (meta.trail_update_*_ms).
    // ─────────────────────────────────────────────────────────────────────────
    {
      const state = map.lastState;
      const meta = state?.meta;
      const sMs = (meta && typeof meta.trail_update_start_ms === "number" && isFinite(meta.trail_update_start_ms)) ? meta.trail_update_start_ms : null;
      const eMs = (meta && typeof meta.trail_update_end_ms === "number" && isFinite(meta.trail_update_end_ms)) ? meta.trail_update_end_ms : null;
      if ((newDataArrived || forceCameraFit) && map._playbackLiveFollow && state && sMs != null && eMs != null) {
        const mobiles = Array.isArray(state.mobile) ? state.mobile : [];
        const bb = _collectBoundsForMobilesNewSegment(mobiles, sMs, eMs);
        if (bb && bb.visibleVehicleCount > 0 && bb.visiblePointCount > 0 && isFinite(bb.minLat) && isFinite(bb.maxLat)) {
          _animateFitBoundsLatLon(bb, { durationMs: _pbLiveFollowDurationMs });
        }
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PHYSICS SIMULATION
    // ─────────────────────────────────────────────────────────────────────────
    let didAdvanceTime = false;
    const didMarkerInertia = (typeof map._stepPbMarkerInertia === "function")
      ? !!map._stepPbMarkerInertia(now, dt)
      : false;

    if (didMarkerInertia) {
      didAdvanceTime = true;
      tMs = map.getPlaybackTimeMs();
      _pbAtEndSincePerf = null; // user interaction resets end timer
    } else if (!_pbScrubbing && hasBounds && tMs != null && isFinite(tMs) && dt > 0) {
      // Apply wheel nudge to velocity
      if (Math.abs(_pbWheelAccum) > 0.1) {
        _pbVelocity += _pbWheelAccum * _pbWheelImpulse;
        _pbWheelAccum *= _pbWheelDecay;
        if (Math.abs(_pbWheelAccum) < 0.1) _pbWheelAccum = 0;
        _pbAtEndSincePerf = null; // wheel interaction resets end timer
      }

      // Determine velocity based on state
      const atEnd = (tMs >= b.maxMs - 1);
      const speedMult = map.getPlaybackSpeed() || 1.0;

      // Resolve loop start within current bounds.
      const loopStartMsRaw = (_pbLoopStartMs != null) ? Number(_pbLoopStartMs) : null;
      const loopStartMs = (isFinite(loopStartMsRaw)) ? clamp(loopStartMsRaw, b.minMs, b.maxMs) : b.minMs;
      
      if (_pbIsRewinding) {
        // Tape-reel rewind: ramp up, cruise, ease into start
        const totalDist = Math.max(1, b.maxMs - loopStartMs);
        const distFromStart = tMs - loopStartMs;
        const progress = 1 - (distFromStart / totalDist); // 0 at end, 1 at loop start
        
        // Base cruise speed: complete full rewind in ~4 seconds
        const cruiseSpeed = -totalDist / 4000;
        const playbackSpeed = _pbPlaybackSpeed * speedMult;
        
        // Ease duration in wall time
        const easeDurationMs = 1500;
        
        // Ease zone: last 15% of the recording (position-based trigger)
        // This is independent of speed - we ease over the final portion of the timeline
        const easeDistanceMs = totalDist * 0.15;
        
        const inEasePhase = _pbEaseStartPerf != null;
        const shouldStartEase = !inEasePhase && distFromStart <= easeDistanceMs;
        
        if (progress < 0.15 && !inEasePhase) {
          // Ramp up phase: accelerate from 0.3 to 1.0 of cruise speed
          const speedFactor = 0.3 + (progress / 0.15) * 0.7;
          _pbVelocity = cruiseSpeed * speedFactor;
        } else if (inEasePhase || shouldStartEase) {
          // NEWTONIAN PHYSICS: constant acceleration to reach playbackSpeed at loopStartMs
          if (_pbEaseStartPerf == null) {
            _pbEaseStartPerf = now;
            _pbEaseStartPos = tMs;
            _pbEaseStartVelocity = _pbVelocity;
          }
          
          // We want to go from v₀ (negative) to playbackSpeed (positive) over distance d
          // Average velocity = (v₀ + v_final) / 2
          // Time = d / |avg_v|
          // Acceleration = (v_final - v₀) / t
          const v0 = _pbEaseStartVelocity;
          const vFinal = playbackSpeed;
          const d = _pbEaseStartPos - loopStartMs;
          
          const avgVel = (v0 + vFinal) / 2;
          // Avoid division by zero
          const accel = Math.abs(avgVel) > 0.1 ? (vFinal - v0) / (d / Math.abs(avgVel)) : 0.01;
          
          // Apply acceleration
          _pbVelocity = _pbVelocity + accel * dt;
          
          // Clamp to not overshoot target velocity
          if (_pbVelocity >= vFinal) {
            _pbVelocity = vFinal;
          }
          
          // End ease when we reach start or velocity reaches target
          if (tMs <= loopStartMs + 10 || _pbVelocity >= vFinal) {
            _pbIsRewinding = false;
            _pbEaseStartPerf = null;
            _pbVelocity = playbackSpeed;
          }
        } else {
          // Cruise phase: full speed
          _pbVelocity = cruiseSpeed;
        }
      } else if (map._playbackLiveFollow) {
        // ─────────────────────────────────────────────────────────────────────
        // LIVE MODE: Play forward until we hit maxMs, then stall waiting for
        // new data. When new data arrives, resume playing.
        // ─────────────────────────────────────────────────────────────────────
        if (atEnd) {
          // At live edge, waiting for new data - just hold position
          _pbVelocity = 0;
        } else {
          // Have data ahead - play toward live edge at user-selected speed
          _pbVelocity = _pbPlaybackSpeed * speedMult;
        }
      } else if (map.getPlaybackPlaying()) {
        // Normal forward playback
        if (atEnd) {
          // At end, not LIVE, not rewinding: hold playhead and let vehicle physics
          // finish moving to the end of their paths; rewind will trigger when all
          // vehicles are actually at the end.
          if (_pbAtEndSincePerf == null) _pbAtEndSincePerf = now;
          _pbVelocity = 0;
        } else {
          // Normal forward - maintain playback speed
          _pbVelocity = _pbPlaybackSpeed * speedMult;
          _pbAtEndSincePerf = null;
        }
      } else if (!map.getPlaybackPlaying() && Math.abs(_pbVelocity) > _pbVelocityThreshold) {
        // Coasting after wheel - apply friction
        const friction = _pbIsWheelCoasting ? _pbWheelFriction : _pbFriction;
        const frictionFactor = Math.pow(friction, dt);
        _pbVelocity *= frictionFactor;
        
        // When velocity decays to playback speed, resume playback
        const playbackSpeed = _pbPlaybackSpeed * speedMult;
        if (_pbVelocity > 0 && _pbVelocity <= playbackSpeed) {
          // Forward coasting reached playback speed - resume
          _pbIsWheelCoasting = false;
          if (_pbCommitLoopStartOnCoastEnd) {
            _pbLoopStartMs = tMs;
            _pbCommitLoopStartOnCoastEnd = false;
          }
          _pbVelocity = playbackSpeed;
          map.setPlaybackPlaying(true);
          updatePlaybackUi();
        } else if (_pbVelocity < 0 && Math.abs(_pbVelocity) < _pbVelocityThreshold) {
          // Backward coasting stopped - resume forward playback
          _pbIsWheelCoasting = false;
          if (_pbCommitLoopStartOnCoastEnd) {
            _pbLoopStartMs = tMs;
            _pbCommitLoopStartOnCoastEnd = false;
          }
          _pbVelocity = playbackSpeed;
          map.setPlaybackPlaying(true);
          updatePlaybackUi();
        }
      }
      
      // Note: No additional easing here - forward playback runs at constant speed
      // Rewind easing is handled inside the _pbIsRewinding block above
      
      // Snap to zero if very slow
      if (Math.abs(_pbVelocity) < _pbVelocityThreshold) {
        _pbVelocity = 0;
      }
      
      // Move playhead
      if (Math.abs(_pbVelocity) > 0) {
        let nextMs = tMs + _pbVelocity * dt;

        // Clamp to bounds; during auto-rewind, clamp to loopStartMs instead of the global min.
        const rewindMinMs = (_pbIsRewinding && loopStartMs != null && isFinite(loopStartMs)) ? loopStartMs : b.minMs;
        nextMs = clamp(nextMs, rewindMinMs, b.maxMs);
        
        // If we hit a bound, zero velocity (unless in active ease - let ease control it)
        if (nextMs <= rewindMinMs && _pbVelocity < 0 && _pbEaseStartPerf == null) {
          _pbVelocity = 0;
          _pbIsRewinding = false; // rewind complete
          nextMs = rewindMinMs;
        }
        if (nextMs >= b.maxMs && _pbVelocity > 0) {
          _pbVelocity = 0;
          nextMs = b.maxMs;
        }
        
        if (nextMs !== tMs) {
          map.setPlaybackTimeMs(nextMs);
          tMs = nextMs;
          didAdvanceTime = true;
          // Force slider to update immediately during coasting
          if (!map.getPlaybackPlaying()) {
            updatePlaybackUi();
          }
        }
        
        // When AUTO-REWIND arrives at start, reset for forward playback
        // But NOT when user is manually coasting backward
        if (tMs <= b.minMs + 1 && _pbVelocity === 0 && _pbIsRewinding) {
          // We've hit the start from auto-rewind - start playing forward
          _pbVelocity = _pbPlaybackSpeed * (map.getPlaybackSpeed() || 1.0);
          _pbAtEndSincePerf = null;
          _pbIsRewinding = false;
          if (!map.getPlaybackPlaying()) {
            map.setPlaybackPlaying(true);
          }
          updatePlaybackUi();
        }
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FOVEATED ROAD MATCHING: Progressive snapping during playback
    // Only run when playing (not scrubbing) and time is advancing
    // ─────────────────────────────────────────────────────────────────────────
    if (map._historicalMode && map.getPlaybackPlaying() && !_pbScrubbing && !_pbIsRewinding) {
      map._requestFoveatedRoadMatching();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // RENDER
    // ─────────────────────────────────────────────────────────────────────────
    const waitingForVehiclesAtEnd =
      !_pbIsRewinding &&
      map.getPlaybackPlaying() &&
      !map._playbackLiveFollow &&
      hasBounds &&
      tMs != null &&
      isFinite(tMs) &&
      (tMs >= b.maxMs - 1) &&
      (_pbAtEndSincePerf != null);

    if (didAdvanceTime || waitingForVehiclesAtEnd) {
      map.drawOverlay(map.lastState, { cacheUnderlay: true });
    }

    // If we're waiting at the end (no fixed pause), start rewind exactly when
    // the last vehicle reaches the end of its path.
    if (waitingForVehiclesAtEnd) {
      if (_pbAllVehiclesReachedPlaybackEnd(map.lastState)) {
        _pbIsRewinding = true;
        _pbVelocity = _pbRewindSpeed;
        _pbAtEndSincePerf = null;
      }
    }

    // UI updates
    const isActive = Math.abs(_pbVelocity) > _pbVelocityThreshold || Math.abs(_pbWheelAccum) > 0.1;
    const uiMinDt = isActive ? 16 : 250;
    if ((didAdvanceTime || isActive) && (now - _pbLastUiPerf) >= uiMinDt) {
      updatePlaybackUi();
      updateSidebarPlaybackValues();
      _pbLastUiPerf = now;
    }

    // Keep loop running if there's any motion or pending state
    const markerInertiaActive = (typeof map._hasPbMarkerInertia === "function") ? !!map._hasPbMarkerInertia() : false;
    const hasMotion = Math.abs(_pbVelocity) > _pbVelocityThreshold;
    const hasWheelMomentum = Math.abs(_pbWheelAccum) > 0.1;
    const waitingToRewind = _pbAtEndSincePerf != null;
    const inLiveMode = map._playbackLiveFollow;  // LIVE mode always keeps loop running
    
    if (map.getPlaybackPlaying() || markerInertiaActive || hasMotion || hasWheelMomentum || waitingToRewind || inLiveMode) {
      _pbRAF = requestAnimationFrame(playbackLoop);
    } else {
      _pbLastPerf = 0;
    }
    
    } catch (e) {
      // Don't let errors kill the playback loop
      console.error("playbackLoop error:", e);
      _pbRAF = requestAnimationFrame(playbackLoop);
    }
  };

  // Allow MapView to restart the loop after a drag release.
  window.__ensurePlaybackLoop = () => {
    if (!map.playbackMode) return;
    if (_pbRAF) return;
    _pbLastPerf = 0;
    _pbLastUiPerf = 0;
    _pbVelocity = 0;
    _pbWheelAccum = 0;
    _pbRAF = requestAnimationFrame(playbackLoop);
  };

  if (traceEl) {
    const saved = localStorage.getItem(TRACE_STORAGE_KEY);
    // Default DVR to ON (LIVE-at-end). Respect explicit user choice when stored.
    traceEl.checked = (saved == null) ? true : (saved === "1");
    if (saved == null) localStorage.setItem(TRACE_STORAGE_KEY, "1");
    map.setPlaybackMode(traceEl.checked);
    // Restore LIVE mode state from localStorage (default to LIVE=true)
    try {
      const savedLive = localStorage.getItem(LIVE_MODE_STORAGE_KEY);
      if (savedLive === "0") {
        map._playbackLiveFollow = false;
      }
    } catch {}
    if (pbBarEl) pbBarEl.classList.toggle("hidden", !traceEl.checked);
    if (traceEl.checked) {
      map._ensurePlaybackPoints(window.__lastState || { mobile: [], fixed: [] });
      map.setPlaybackPlaying(false);
      updatePlaybackUi();
      _pbLastPerf = 0;
      _pbLastUiPerf = 0;
      if (!_pbRAF) _pbRAF = requestAnimationFrame(playbackLoop);
    }
    traceEl.addEventListener("change", () => {
      localStorage.setItem(TRACE_STORAGE_KEY, traceEl.checked ? "1" : "0");
      _pbVelocity = 0;
      _pbWheelAccum = 0;
      _pbAtEndSincePerf = null;
      map.setPlaybackMode(traceEl.checked);
      if (pbBarEl) pbBarEl.classList.toggle("hidden", !traceEl.checked);
      if (traceEl.checked) {
        map._ensurePlaybackPoints(window.__lastState || { mobile: [], fixed: [] });
        // Don't set playhead here - let the playback loop handle it
        map.setPlaybackPlaying(false);
        updatePlaybackUi();
        _pbLastPerf = 0;
        _pbLastUiPerf = 0;
        if (!_pbRAF) _pbRAF = requestAnimationFrame(playbackLoop);
      } else {
        map.setPlaybackPlaying(false);
        _pbLastPerf = 0;
        _pbLastUiPerf = 0;
      }
    });
  } else {
    // DVR toggle hidden - default to playback mode always ON
    map.setPlaybackMode(true);
    // Restore LIVE mode state from localStorage (default to LIVE=true)
    try {
      const savedLive = localStorage.getItem(LIVE_MODE_STORAGE_KEY);
      if (savedLive === "0") {
        map._playbackLiveFollow = false;
      }
    } catch {}
    if (pbBarEl) pbBarEl.classList.remove("hidden");
    map._ensurePlaybackPoints(window.__lastState || { mobile: [], fixed: [] });
    map.setPlaybackPlaying(false);
    updatePlaybackUi();
    _pbLastPerf = 0;
    _pbLastUiPerf = 0;
    if (!_pbRAF) _pbRAF = requestAnimationFrame(playbackLoop);
  }

  if (pbPlayEl) {
    // iOS fix: handle touchend to avoid 300ms delay and text click issues
    pbPlayEl.addEventListener("touchend", (e) => {
      e.preventDefault();
      pbPlayEl.click();
    }, { passive: false });
    
    pbPlayEl.addEventListener("click", () => {
      // Enable playback mode if not already (e.g. historical data)
      if (!map.playbackMode) {
        map.setPlaybackMode(true);
      }
      const b = map.getPlaybackBounds();
      if (!isFinite(b.minMs) || !isFinite(b.maxMs) || !(b.maxMs > b.minMs)) return;

      const atEnd = map.isPlaybackAtEnd(100);
      
      // If in LIVE mode, clicking turns OFF live camera follow (but keeps playback running).
      // This allows the user to stay at the end receiving new data, but without the camera auto-following.
      if (map._playbackLiveFollow) {
        map._playbackLiveFollow = false;
        try { localStorage.setItem(LIVE_MODE_STORAGE_KEY, "0"); } catch {}
        if (typeof map._resetLiveTracking === "function") map._resetLiveTracking();
        // Set loop start to current position so rewind doesn't go to beginning of time
        const curMs = map.getPlaybackTimeMs();
        if (curMs != null && isFinite(curMs)) {
          _pbLoopStartMs = curMs;
        }
        // Keep playback running (or start it if paused)
        if (!map.getPlaybackPlaying()) {
          _pbVelocity = _pbPlaybackSpeed * (map.getPlaybackSpeed() || 1.0);
          map.setPlaybackPlaying(true);
          _pbLastPerf = 0;
          if (!_pbRAF) _pbRAF = requestAnimationFrame(playbackLoop);
        }
        updatePlaybackUi();
        return;
      }

      // If at end and paused (button shows "Live" but not highlighted), enable LIVE mode
      if (atEnd && !map.getPlaybackPlaying()) {
        map._playbackLiveFollow = true;
        try { localStorage.setItem(LIVE_MODE_STORAGE_KEY, "1"); } catch {}
        _pbVelocity = 0;
        _pbAtEndSincePerf = null;
        _pbIsRewinding = false;
        map.setPlaybackPlaying(true);
        _pbLastPerf = 0;
        if (!_pbRAF) _pbRAF = requestAnimationFrame(playbackLoop);
        updatePlaybackUi();
        return;
      }

      // If currently playing (not LIVE mode), pause
      if (map.getPlaybackPlaying()) {
        map.setPlaybackPlaying(false);
        _pbVelocity = 0;
        _pbWheelAccum = 0;
        _pbAtEndSincePerf = null;
        _pbIsRewinding = false;
        updatePlaybackUi();
        return;
      }

      // Paused - just play from current position
      _pbAtEndSincePerf = null;
      _pbWheelAccum = 0;
      _pbIsRewinding = false;
      // Capture replay point A if it hasn't been set via scrubbing.
      if (_pbLoopStartMs == null || !isFinite(Number(_pbLoopStartMs))) {
        const cur = map.getPlaybackTimeMs();
        _pbLoopStartMs = (cur != null && isFinite(Number(cur))) ? Number(cur) : b.minMs;
      }
      _pbVelocity = _pbPlaybackSpeed * (map.getPlaybackSpeed() || 1.0);
      map.setPlaybackPlaying(true);
      _pbLastPerf = 0;
      // Always restart the loop
      if (_pbRAF) cancelAnimationFrame(_pbRAF);
      _pbRAF = requestAnimationFrame(playbackLoop);
      updatePlaybackUi();
    });
  }

  if (pbSpeedEl) {
    // Restore saved speed
    const savedSpeed = localStorage.getItem("mobileair.playbackSpeed");
    if (savedSpeed) {
      const n = Number(savedSpeed);
      if (isFinite(n) && n > 0) {
        map.setPlaybackSpeed(n);
        pbSpeedEl.value = String(n);
      }
    }
    pbSpeedEl.addEventListener("change", () => {
      map.setPlaybackSpeed(pbSpeedEl.value);
      localStorage.setItem("mobileair.playbackSpeed", pbSpeedEl.value);
      updatePlaybackUi();
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // DAY SELECTOR: Load historical data for past days
  // ─────────────────────────────────────────────────────────────────────────────
  window._historicalState = null;  // Cached historical data when not "live"
  
  // Loading state tracking - shared between historical and snapshot loading
  let _isLoadingData = false;
  
  // Track current selected day for menu display
  let _selectedDayValue = "live";
  
  /**
   * Validate that a state object has the expected schema.
   * Returns true if valid, false if not.
   * This is a security boundary - validates structure before any processing.
   */
  function validateStateSchema(state) {
    if (!state || typeof state !== "object") return false;
    // Must have mobile or fixed arrays
    if (!Array.isArray(state.mobile) && !Array.isArray(state.fixed)) return false;
    // Check mobile entries have id
    if (Array.isArray(state.mobile)) {
      for (const m of state.mobile) {
        if (!m || typeof m !== "object" || !("id" in m)) return false;
      }
    }
    // Check fixed entries have id
    if (Array.isArray(state.fixed)) {
      for (const f of state.fixed) {
        if (!f || typeof f !== "object" || !("id" in f)) return false;
      }
    }
    return true;
  }
  
  /**
   * Check if we have valid data that can be saved.
   */
  function canSaveSnapshot() {
    if (_isLoadingData) return false;
    const state = map._historicalMode ? window._historicalState : window.__lastState;
    if (!state) return false;
    if (!validateStateSchema(state)) return false;
    // Must have at least some data
    const mobileCount = Array.isArray(state.mobile) ? state.mobile.length : 0;
    const fixedCount = Array.isArray(state.fixed) ? state.fixed.length : 0;
    return (mobileCount > 0 || fixedCount > 0);
  }

  function updateSaveButtonState() {
    // No-op: old button removed, menu handles state dynamically
  }
  
  async function loadHistoricalDay(dateStr) {
    if (dateStr === "live") {
      window._historicalState = null;
      map._historicalMode = false;
      // Clear persisted trails so old data doesn't linger
      map._persistedTrailById = new Map();
      updateSaveButtonState();
      return;
    }
    
    const statusEl = document.getElementById("statusText");
    if (statusEl) {
      statusEl.textContent = "Loading...";
      statusEl.classList.remove("live");
    }
    
    // Disable save while loading
    _isLoadingData = true;
    updateSaveButtonState();
    
    try {
      const resp = await fetch(`${appConfig.apiBaseUrl}/history?date=${encodeURIComponent(dateStr)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const loadedState = await resp.json();
      
      // Check for server-side error (e.g., Utah AQ down)
      if (loadedState?.meta?.data_unavailable) {
        const errMsg = loadedState.meta.error || "Historical data unavailable";
        throw new Error(errMsg);
      }
      
      // Validate the loaded data before using it
      if (!validateStateSchema(loadedState)) {
        throw new Error("Invalid data structure received from server");
      }
      
      window._historicalState = loadedState;
      
      // Cache raw GPS coordinates only if debug mode is enabled
      // (Deep copying all trails is expensive and only needed for debug visualization)
      if (map._pbDebugPath) {
        map._rawGpsById = new Map();
        const mobs = Array.isArray(loadedState?.mobile) ? loadedState.mobile : [];
        for (const m of mobs) {
          if (m?.id && Array.isArray(m.trail)) {
            const rawTrail = m.trail.map(pt => ({...pt}));
            map._rawGpsById.set(String(m.id), rawTrail);
          }
        }
      }
      
      // Reset ALL playback state for fresh historical data
      map._historicalMode = true;
      map._playbackPtsById = new Map();
      map._playbackPtsKey = null;
      map._persistedTrailById = new Map();  // Clear persisted trails
      map._playbackNowMs = null;  // Reset playback time
      
      // Enable DVR/playback mode for historical data
      // NOTE: setPlaybackMode(true) sets _playbackLiveFollow=true and draws overlay,
      // so we must disable live follow AFTER and avoid the internal draw.
      map.playbackMode = true;  // Set directly to avoid immediate draw
      map._playbackLiveFollow = false;  // Historical always starts at beginning, not live tail
      if (traceEl) traceEl.checked = true;
      if (pbBarEl) pbBarEl.classList.remove("hidden");
      
      // Build playback points and set time to START
      map._ensurePlaybackPoints(window._historicalState);
      const b = map.getPlaybackBounds();
      if (isFinite(b.minMs)) {
        map.setPlaybackTimeMs(b.minMs);
      }
      
      // Store state, render sidebar, draw ONLY tiles (no overlay yet)
      map.lastState = window._historicalState;
      map.drawTiles();
      renderLists(window._historicalState, selectedId);
      
      if (statusEl) {
        statusEl.textContent = `Historical: ${dateStr}`;
        statusEl.classList.remove("live");
      }
      
      updatePlaybackUi();
      
      // Draw overlay NOW with playback time already set
      map.drawOverlay(window._historicalState);
      
      // Fetch road edges for debug visualization if enabled
      if (map._pbDebugPath && map._pbDebugRoadLines) {
        map._fetchRoadEdgesForViewport();
      }
      
      // Start playback loop
      _pbLastPerf = 0;
      _pbLastUiPerf = 0;
      _pbRAF = requestAnimationFrame(playbackLoop);
    } catch (e) {
      console.error("Failed to load historical data:", e);
      if (statusEl) {
        statusEl.textContent = e.message || "Error loading history";
        statusEl.classList.add("offline");
      }
      // Show alert for user visibility
      alert(`Failed to load historical data:\n${e.message}`);
    } finally {
      _isLoadingData = false;
      updateSaveButtonState();
    }
  }
  
  // ─────────────────────────────────────────────────────────────────────────────
  // SAVE/LOAD: Persist and restore daily snapshots
  // ─────────────────────────────────────────────────────────────────────────────

  function getSnapshotDateStr() {
    // Determine the date to use for saving based on the data being viewed
    // 1. If viewing a historical day via the menu, use that date
    if (_selectedDayValue && _selectedDayValue !== "live") {
      return _selectedDayValue;  // Already in YYYY-MM-DD format
    }
    
    // 2. Otherwise, derive from the newest reading timestamp in the current state
    const state = map._historicalMode ? window._historicalState : window.__lastState;
    const newestMs = newestReadingMsFromState(state);
    if (newestMs != null && isFinite(newestMs)) {
      const d = new Date(newestMs);
      return d.toISOString().split("T")[0];
    }
    
    // 3. Fallback to today
    return new Date().toISOString().split("T")[0];
  }

  async function saveSnapshot() {
    if (!canSaveSnapshot()) {
      console.warn("Cannot save: no valid data loaded");
      return;
    }
    
    const statusEl = document.getElementById("statusText");
    const dateStr = getSnapshotDateStr();
    
    // Get the state to save - historical if viewing historical, else live
    const stateToSave = map._historicalMode ? window._historicalState : window.__lastState;
    if (!stateToSave) {
      console.warn("Cannot save: no state data available");
      return;
    }
    
    try {
      const resp = await fetch(`${appConfig.apiBaseUrl}/snapshot/save?date=${encodeURIComponent(dateStr)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(stateToSave)
      });
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${resp.status}`);
      }
      const result = await resp.json();
      
      if (statusEl) {
        const prevText = statusEl.textContent;
        statusEl.textContent = `Saved ${dateStr}`;
        setTimeout(() => {
          if (statusEl.textContent === `Saved ${dateStr}`) {
            statusEl.textContent = prevText;
          }
        }, 2000);
      }
      console.log("Snapshot saved:", result);
    } catch (e) {
      console.error("Failed to save snapshot:", e);
      if (statusEl) {
        statusEl.textContent = "Save failed";
        statusEl.classList.add("offline");
      }
    } finally {
      updateSaveButtonState();
    }
  }

  async function showLoadModal() {
    // Fetch available snapshots
    let snapshots = [];
    try {
      const resp = await fetch(`${appConfig.apiBaseUrl}/snapshots`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      snapshots = data.snapshots || [];
    } catch (e) {
      console.error("Failed to list snapshots:", e);
      return;
    }

    // Create modal
    const modal = document.createElement("div");
    modal.className = "snapshotModal";
    
    const content = document.createElement("div");
    content.className = "snapshotModalContent";
    
    const title = document.createElement("h3");
    title.textContent = "Load Saved Day";
    content.appendChild(title);
    
    const list = document.createElement("div");
    list.className = "snapshotList";
    
    if (snapshots.length === 0) {
      const empty = document.createElement("div");
      empty.className = "snapshotEmpty";
      empty.textContent = "No saved snapshots found";
      list.appendChild(empty);
    } else {
      for (const snap of snapshots) {
        const item = document.createElement("div");
        item.className = "snapshotItem";
        
        const dateSpan = document.createElement("span");
        dateSpan.className = "date";
        // Format date nicely
        const d = new Date(snap.date + "T12:00:00");
        const dayName = d.toLocaleDateString("en-US", { weekday: "short" });
        const monthDay = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
        dateSpan.textContent = `${dayName} ${monthDay}`;
        
        const sizeSpan = document.createElement("span");
        sizeSpan.className = "size";
        const sizeMB = (snap.size_bytes / (1024 * 1024)).toFixed(1);
        sizeSpan.textContent = `${sizeMB} MB`;
        
        item.appendChild(dateSpan);
        item.appendChild(sizeSpan);
        
        item.addEventListener("click", async () => {
          modal.remove();
          await loadSnapshotByDate(snap.date);
        });
        
        list.appendChild(item);
      }
    }
    content.appendChild(list);
    
    const closeBtn = document.createElement("button");
    closeBtn.className = "snapshotModalClose";
    closeBtn.textContent = "Cancel";
    closeBtn.addEventListener("click", () => modal.remove());
    content.appendChild(closeBtn);
    
    modal.appendChild(content);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.remove();
    });
    
    document.body.appendChild(modal);
  }

  async function loadSnapshotByDate(dateStr) {
    const statusEl = document.getElementById("statusText");
    if (statusEl) {
      statusEl.textContent = "Loading...";
      statusEl.classList.remove("live");
    }
    
    // Disable save while loading
    _isLoadingData = true;
    updateSaveButtonState();
    
    try {
      const resp = await fetch(`${appConfig.apiBaseUrl}/snapshot/load?date=${encodeURIComponent(dateStr)}`);
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${resp.status}`);
      }
      const loadedState = await resp.json();
      
      // Validate the loaded data before using it
      if (!validateStateSchema(loadedState)) {
        throw new Error("Invalid data structure in snapshot");
      }
      
      window._historicalState = loadedState;
      
      // Cache raw GPS coordinates only if debug mode is enabled
      if (map._pbDebugPath) {
        map._rawGpsById = new Map();
        const mobs = Array.isArray(loadedState?.mobile) ? loadedState.mobile : [];
        for (const m of mobs) {
          if (m?.id && Array.isArray(m.trail)) {
            const rawTrail = m.trail.map(pt => ({...pt}));
            map._rawGpsById.set(String(m.id), rawTrail);
          }
        }
      }
      
      // Reset ALL playback state for fresh historical data
      map._historicalMode = true;
      map._playbackPtsById = new Map();
      map._playbackPtsKey = null;
      map._persistedTrailById = new Map();
      map._playbackNowMs = null;
      
      // Enable DVR/playback mode
      map.playbackMode = true;
      map._playbackLiveFollow = false;
      if (traceEl) traceEl.checked = true;
      if (pbBarEl) pbBarEl.classList.remove("hidden");
      
      // Build playback points and set time to START
      map._ensurePlaybackPoints(window._historicalState);
      const b = map.getPlaybackBounds();
      if (isFinite(b.minMs)) {
        map.setPlaybackTimeMs(b.minMs);
      }
      
      // Store state, render sidebar, draw
      map.lastState = window._historicalState;
      map.drawTiles();
      renderLists(window._historicalState, selectedId);
      
      if (statusEl) {
        statusEl.textContent = `Snapshot: ${dateStr}`;
        statusEl.classList.remove("live");
      }
      
      updatePlaybackUi();
      map.drawOverlay(window._historicalState);
      
      // Start playback loop
      _pbLastPerf = 0;
      _pbLastUiPerf = 0;
      _pbRAF = requestAnimationFrame(playbackLoop);
    } catch (e) {
      console.error("Failed to load snapshot:", e);
      if (statusEl) {
        statusEl.textContent = "Load failed";
        statusEl.classList.add("offline");
      }
    } finally {
      _isLoadingData = false;
      updateSaveButtonState();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PLAYBACK MENU: Dropup menu for save/load/days
  // ─────────────────────────────────────────────────────────────────────────────
  const pbMenuBtn = document.getElementById("pbMenuBtn");
  const pbMenu = document.getElementById("pbMenu");
  const pbDaysSubmenu = document.getElementById("pbDaysSubmenu");
  const shareBtn = document.getElementById("shareBtn");
  
  // Menu close delay for better UX
  let _menuHideTimer = null;
  const MENU_HIDE_DELAY = 150; // ms before hiding main menu
  
  function closePlaybackMenuImmediate() {
    if (_menuHideTimer) {
      clearTimeout(_menuHideTimer);
      _menuHideTimer = null;
    }
    if (pbMenu) {
      pbMenu.classList.remove("visible");
      pbMenu.classList.add("hidden");
    }
    if (pbMenuBtn) pbMenuBtn.classList.remove("open");
    // Also hide submenus
    if (pbDaysSubmenu) pbDaysSubmenu.classList.remove("visible");
    const pbThemeSubmenuEl = document.getElementById("pbThemeSubmenu");
    if (pbThemeSubmenuEl) pbThemeSubmenuEl.classList.remove("visible");
    const pbDisplaySubmenuEl = document.getElementById("pbDisplaySubmenu");
    if (pbDisplaySubmenuEl) pbDisplaySubmenuEl.classList.remove("visible");
  }
  
  function closePlaybackMenu() {
    closePlaybackMenuImmediate();
  }
  
  function cancelMenuHide() {
    if (_menuHideTimer) {
      clearTimeout(_menuHideTimer);
      _menuHideTimer = null;
    }
  }
  
  function openPlaybackMenu() {
    if (!pbMenu) return;
    cancelMenuHide();
    pbMenu.classList.remove("hidden");
    pbMenu.classList.add("visible");
    if (pbMenuBtn) pbMenuBtn.classList.add("open");
    updateDaysSubmenu();
  }
  
  function togglePlaybackMenu() {
    if (!pbMenu) return;
    const isOpen = pbMenu.classList.contains("visible");
    if (isOpen) {
      closePlaybackMenu();
    } else {
      openPlaybackMenu();;
    }
  }
  
  // Centralized submenu show/hide with debouncing
  const SUBMENU_SHOW_DELAY = 80; // ms before showing a different submenu
  const SUBMENU_HIDE_DELAY = 200; // ms before hiding submenu
  let _submenuShowTimer = null;
  let _submenuHideTimer = null;
  let _currentSubmenu = null; // track which submenu is open
  
  function showSubmenuDebounced(submenuEl, parentEl, onShow) {
    // Cancel any pending hide
    if (_submenuHideTimer) {
      clearTimeout(_submenuHideTimer);
      _submenuHideTimer = null;
    }
    // If this submenu is already open, no delay needed
    if (_currentSubmenu === submenuEl) {
      if (_submenuShowTimer) clearTimeout(_submenuShowTimer);
      _submenuShowTimer = null;
      return;
    }
    // Cancel any pending show of a different submenu
    if (_submenuShowTimer) clearTimeout(_submenuShowTimer);
    _submenuShowTimer = setTimeout(() => {
      _submenuShowTimer = null;
      // Hide all submenus
      const pbThemeSubmenu = document.getElementById("pbThemeSubmenu");
      if (pbThemeSubmenu) pbThemeSubmenu.classList.remove("visible");
      const pbDisplaySubmenu = document.getElementById("pbDisplaySubmenu");
      if (pbDisplaySubmenu) pbDisplaySubmenu.classList.remove("visible");
      if (pbDaysSubmenu) pbDaysSubmenu.classList.remove("visible");
      // Show requested submenu
      if (onShow) onShow();
      submenuEl.classList.add("visible");
      _currentSubmenu = submenuEl;
    }, SUBMENU_SHOW_DELAY);
  }
  
  function hideSubmenuDebounced(submenuEl, parentEl, e) {
    // Don't hide if moving to parent menu item or submenu itself
    if (e && e.relatedTarget && (parentEl.contains(e.relatedTarget) || submenuEl.contains(e.relatedTarget))) {
      return;
    }
    // Cancel pending show
    if (_submenuShowTimer) {
      clearTimeout(_submenuShowTimer);
      _submenuShowTimer = null;
    }
    if (_submenuHideTimer) clearTimeout(_submenuHideTimer);
    _submenuHideTimer = setTimeout(() => {
      submenuEl.classList.remove("visible");
      if (_currentSubmenu === submenuEl) _currentSubmenu = null;
      _submenuHideTimer = null;
    }, SUBMENU_HIDE_DELAY);
  }
  
  // Wire up Days submenu
  const pbMenuSubEl = document.querySelector(".pbMenuSub[data-submenu='days']");
  if (pbMenuSubEl && pbDaysSubmenu) {
    pbMenuSubEl.addEventListener("mouseenter", () => showSubmenuDebounced(pbDaysSubmenu, pbMenuSubEl, null));
    pbMenuSubEl.addEventListener("mouseleave", (e) => hideSubmenuDebounced(pbDaysSubmenu, pbMenuSubEl, e));
    pbDaysSubmenu.addEventListener("mouseenter", () => showSubmenuDebounced(pbDaysSubmenu, pbMenuSubEl, null));
    pbDaysSubmenu.addEventListener("mouseleave", (e) => hideSubmenuDebounced(pbDaysSubmenu, pbMenuSubEl, e));
  }
  
  function updateDaysSubmenu() {
    if (!pbDaysSubmenu) return;
    pbDaysSubmenu.innerHTML = "";
    
    const now = new Date();
    const options = [];
    
    // Today (live)
    options.push({ value: "live", label: "🔮 Today (Live)" });
    
    // Past 6 days
    for (let i = 1; i <= 6; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split("T")[0];
      const dayName = d.toLocaleDateString("en-US", { weekday: "short" });
      const monthDay = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const label = i === 1 ? `Yesterday (${monthDay})` : `${dayName} ${monthDay}`;
      options.push({ value: dateStr, label });
    }
    
    for (const opt of options) {
      const item = document.createElement("div");
      item.className = "pbSubmenuItem";
      if (opt.value === _selectedDayValue) {
        item.classList.add("active");
      }
      item.textContent = opt.label;
      item.dataset.value = opt.value;
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        _selectedDayValue = opt.value;
        loadHistoricalDay(opt.value);
        closePlaybackMenu();
      });
      pbDaysSubmenu.appendChild(item);
    }
  }
  
  // Theme submenu
  const pbThemeSubmenu = document.getElementById("pbThemeSubmenu");
  
  function updateThemeSubmenu() {
    if (!pbThemeSubmenu) return;
    pbThemeSubmenu.innerHTML = "";
    
    const keys = Object.keys(TILE_THEMES);
    for (const k of keys) {
      const item = document.createElement("div");
      item.className = "pbSubmenuItem";
      if (k === _currentThemeKey) {
        item.classList.add("active");
      }
      item.textContent = TILE_THEMES[k].label || k;
      item.dataset.value = k;
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        _currentThemeKey = k;
        saveThemeForMode(k);
        if (themeEl) themeEl.value = k;
        const dim = loadDimForTheme(k);
        if (dimEl) dimEl.value = String(dim);
        const sat = loadSatForTheme(k);
        if (satEl) satEl.value = String(sat);
        applyThemeAndFilters(k, dim, sat);
        updateThemeSubmenu();
        // Keep menu open so user can easily try different themes
      });
      pbThemeSubmenu.appendChild(item);
    }
  }
  // Register for use by applyTheme (defined earlier)
  window._updateThemeSubmenu = updateThemeSubmenu;
  
  // Wire up Theme submenu hover (uses centralized debounce)
  const pbThemeSubEl = document.querySelector(".pbMenuSub[data-submenu='theme']");
  if (pbThemeSubEl && pbThemeSubmenu) {
    pbThemeSubEl.addEventListener("mouseenter", () => showSubmenuDebounced(pbThemeSubmenu, pbThemeSubEl, updateThemeSubmenu));
    pbThemeSubEl.addEventListener("mouseleave", (e) => hideSubmenuDebounced(pbThemeSubmenu, pbThemeSubEl, e));
    pbThemeSubmenu.addEventListener("mouseenter", () => showSubmenuDebounced(pbThemeSubmenu, pbThemeSubEl, updateThemeSubmenu));
    pbThemeSubmenu.addEventListener("mouseleave", (e) => hideSubmenuDebounced(pbThemeSubmenu, pbThemeSubEl, e));
  }
  
  function handleMenuAction(action) {
    switch (action) {
      case "save":
        saveSnapshot();
        break;
      case "load":
        showLoadModal();
        break;
    }
    closePlaybackMenu();
  }
  
  if (pbMenuBtn) {
    pbMenuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePlaybackMenu();
    });
  }
  
  // Share button - opens native share dialog
  if (shareBtn) {
    shareBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!navigator.share) return;
      shareBtn.classList.add("open");
      try {
        await navigator.share({ title: "DustyTrails", url: window.location.href });
      } catch (_) {}
      shareBtn.classList.remove("open");
    });
  }
  
  // Display submenu (dim/sat sliders in three-dot menu)
  const pbDisplaySubmenu = document.getElementById("pbDisplaySubmenu");
  const menuDimEl = document.getElementById("menuDim");
  const menuSatEl = document.getElementById("menuSat");
  
  // Wire up Display submenu hover (uses centralized debounce)
  const pbDisplaySubEl = document.querySelector(".pbMenuSub[data-submenu='display']");
  if (pbDisplaySubEl && pbDisplaySubmenu) {
    function syncDisplaySliders() {
      if (menuDimEl && dimEl) menuDimEl.value = dimEl.value;
      if (menuSatEl && satEl) menuSatEl.value = satEl.value;
    }
    
    pbDisplaySubEl.addEventListener("mouseenter", () => showSubmenuDebounced(pbDisplaySubmenu, pbDisplaySubEl, syncDisplaySliders));
    pbDisplaySubEl.addEventListener("mouseleave", (e) => hideSubmenuDebounced(pbDisplaySubmenu, pbDisplaySubEl, e));
    pbDisplaySubmenu.addEventListener("mouseenter", () => showSubmenuDebounced(pbDisplaySubmenu, pbDisplaySubEl, syncDisplaySliders));
    pbDisplaySubmenu.addEventListener("mouseleave", (e) => hideSubmenuDebounced(pbDisplaySubmenu, pbDisplaySubEl, e));
    
    // Wire up menu sliders to control the hidden original sliders
    if (menuDimEl) {
      menuDimEl.addEventListener("input", () => {
        if (dimEl) {
          dimEl.value = menuDimEl.value;
          dimEl.dispatchEvent(new Event("input"));
        }
      });
    }
    if (menuSatEl) {
      menuSatEl.addEventListener("input", () => {
        if (satEl) {
          satEl.value = menuSatEl.value;
          satEl.dispatchEvent(new Event("input"));
        }
      });
    }
  }
  
  // Handle clicks on menu items
  if (pbMenu) {
    pbMenu.addEventListener("click", (e) => {
      const item = e.target.closest(".pbMenuItem");
      if (!item) return;
      // Skip if it's the submenu parent (handled by hover)
      if (item.classList.contains("pbMenuSub")) return;
      const action = item.dataset.action;
      if (action) handleMenuAction(action);
    });
  }
  
  // Close menu when clicking outside
  document.addEventListener("click", (e) => {
    if (pbMenu && pbMenu.classList.contains("visible")) {
      if (!e.target.closest(".pbMenuWrap")) {
        closePlaybackMenu();
      }
    }
  });
  
  // Close menu when mouse leaves viewport (use documentElement for reliability)
  document.documentElement.addEventListener("mouseleave", () => {
    if (pbMenu && pbMenu.classList.contains("visible")) {
      closePlaybackMenuImmediate();
    }
  });
  
  // Close menu when window loses focus (clicking outside browser, switching tabs, etc.)
  window.addEventListener("blur", () => {
    if (pbMenu && pbMenu.classList.contains("visible")) {
      closePlaybackMenuImmediate();
    }
  });

  if (pbScrubEl) {
    const applyScrub = () => {
      const b = map.getPlaybackBounds();
      if (!isFinite(b.minMs) || !isFinite(b.maxMs) || !(b.maxMs > b.minMs)) return;
      const relMs = Number(pbScrubEl.value);
      if (!isFinite(relMs)) return;
      const tMs = b.minMs + relMs;
      const clampedT = clamp(tMs, b.minMs, b.maxMs);
      map.setPlaybackTimeMs(clampedT);

      // Don't auto-enable LIVE mode when dragging - user must click the Live button.
      // Just track where the user left the playhead as replay point A.
      _pbLoopStartMs = clampedT;

      updatePlaybackUi();
      map.drawOverlay(map.lastState);
    };

    pbScrubEl.addEventListener("pointerdown", () => {
      // Cancel ALL physics immediately - user is taking control
      _pbVelocity = 0;
      _pbWheelAccum = 0;
      _pbAtEndSincePerf = null;
      _pbArrivedAtEndViaPlayback = false; // user is scrubbing, not playing
      _pbIsRewinding = false;
      _pbEaseStartPerf = null;
      _pbIsWheelCoasting = false;
      _pbScrubbing = true;
      _pbDidDrag = false; // track if user actually dragged
      _pbLastScrubPos = Number(pbScrubEl.value);
      _pbLastScrubTime = performance.now();
      map.setPlaybackPlaying(false);
      map._playbackLiveFollow = false; // exit live mode when user grabs slider
      try { localStorage.setItem(LIVE_MODE_STORAGE_KEY, "0"); } catch {}
      _resetLiveTracking();
      updatePlaybackUi();
    });
    pbScrubEl.addEventListener("pointerup", () => {
      _pbScrubbing = false;
      _pbVelocity = 0;
      // Don't auto-enable LIVE mode when released at end - user must click Live button.
      map.setPlaybackPlaying(true);
      _pbLastPerf = performance.now();
      if (!_pbRAF) _pbRAF = requestAnimationFrame(playbackLoop);
      applyScrub();
    });
    pbScrubEl.addEventListener("input", () => {
      const now = performance.now();
      const pos = Number(pbScrubEl.value);

      // User is dragging
      _pbDidDrag = true;
      _pbLastScrubPos = pos;
      _pbLastScrubTime = now;

      map.setPlaybackPlaying(false);
      applyScrub();
    });
    pbScrubEl.addEventListener("change", () => {
      // 'change' fires on release - only handle clicks here
      // Drags with inertia are handled by pointerup
      if (_pbDidDrag) {
        // Drag was handled by pointerup - do nothing here
        return;
      }
      // For clicks on the track (not drags), just resume playing
      _pbScrubbing = false;
      _pbVelocity = 0; // no inertia for clicks
      map.setPlaybackPlaying(true);
      _pbLastPerf = 0;
      if (!_pbRAF) _pbRAF = requestAnimationFrame(playbackLoop);
      applyScrub();
    });

    // Scroll wheel on the scrub bar adds momentum (iPod-style)
    pbScrubEl.addEventListener("wheel", (e) => {
      e.preventDefault();
      // Cancel any pending rewind and stop normal playback
      _pbAtEndSincePerf = null;
      _pbArrivedAtEndViaPlayback = false; // user is scrolling, not playing
      _pbIsRewinding = false;
      map.setPlaybackPlaying(false); // Let wheel nudge control velocity
      // Exit LIVE mode on scroll
      map._playbackLiveFollow = false;
      try { localStorage.setItem(LIVE_MODE_STORAGE_KEY, "0"); } catch {}
      _pbIsWheelCoasting = true;
      _pbCommitLoopStartOnCoastEnd = true;
      // Horizontal scroll (two-finger swipe): deltaX > 0 = swipe right = backward in time
      // Scale by timeline duration for proportional movement, reduced sensitivity
      const b = map.getPlaybackBounds();
      const durMs = (b.maxMs - b.minMs) || 1;
      const nudge = (e.deltaX / 1000) * (durMs / 30); // ~0.3% of timeline per scroll tick
      _pbVelocity -= nudge;
      // Ensure loop is running
      if (!_pbRAF) {
        _pbLastPerf = performance.now(); // valid dt for next frame
        _pbRAF = requestAnimationFrame(playbackLoop);
      }
    }, { passive: false });
  }

  if (pbDebugEl) {
    const key = "mobileair.pbDebugPath";
    const saved = localStorage.getItem(key);
    pbDebugEl.checked = (saved === "1");
    map._pbDebugPath = pbDebugEl.checked;
    pbDebugEl.addEventListener("change", () => {
      localStorage.setItem(key, pbDebugEl.checked ? "1" : "0");
      map._pbDebugPath = pbDebugEl.checked;
      // Fetch road edges when debug mode is enabled
      if (map._pbDebugPath && map._pbDebugRoadLines) {
        map._fetchRoadEdgesForViewport();
      }
      map.drawOverlay(map.lastState);
    });
  }

  const POLL_MS = 30000;  // 30 seconds
  let _tickInFlight = false;
  let _tickLastForceRefreshSeq = null;

  async function tick() {
    if (_tickInFlight) return;
    
    // Skip live data fetching when viewing historical data OR while loading it
    // Playback loop handles all drawing in historical mode
    if (window._historicalState || _isLoadingData) {
      return;
    }
    
    _tickInFlight = true;
    let st = null;
    const statusEl = document.getElementById("statusText");
    try {
      st = await fetchState();
    } catch (e) {
      if (statusEl) {
        statusEl.textContent = "Offline";
        statusEl.classList.remove("live");
        statusEl.classList.add("offline");
      }
      // Even if we're offline, keep redrawing the overlay so time-based fades continue.
      try { map.drawOverlay(map.lastState); } catch {}
      _tickInFlight = false;
      return;
    }

    // Ensure st.fixed is always an array (Home sensor now provided by backend)
    if (!Array.isArray(st.fixed)) st.fixed = [];

    window.__lastState = st;
    
    // Update save button now that we have data
    updateSaveButtonState();
    
    if (statusEl) {
      const meta = st.meta || {};
      const mobileCount = Array.isArray(st.mobile) ? st.mobile.length : 0;
      const fixedCount = Array.isArray(st.fixed) ? st.fixed.length : 0;
      const hasData = mobileCount > 0 || fixedCount > 0;
      
      if (!hasData) {
        // No data yet - still loading
        statusEl.textContent = "Loading...";
        statusEl.classList.remove("live");
        statusEl.classList.remove("offline");
      } else if (meta.data_stale) {
        // Data is stale - show age from actual data timestamps
        const ageS = meta.data_age_s || 0;
        const ageMin = Math.floor(ageS / 60);
        const ageHr = Math.floor(ageMin / 60);
        const ageStr = ageHr > 0 ? `${ageHr}h` : `${ageMin}m`;
        statusEl.textContent = `Stale (${ageStr} old)`;
        statusEl.classList.remove("live");
        statusEl.classList.add("offline");
      } else {
        statusEl.textContent = "Live";
        statusEl.classList.remove("offline");
        statusEl.classList.add("live");
      }
    }
    const bestMs = newestReadingMsFromState(st);
    if (bestMs != null) {
      document.getElementById("lastUpdated").textContent = new Date(bestMs).toLocaleTimeString();
    }

    try {
      // keep selection if possible; DO NOT auto-select anything
      const mobiles = Array.isArray(st.mobile) ? st.mobile : [];
      if (selectedId) {
        const sel = parseKey(selectedId);
        if (sel?.type === "mobile" && !mobiles.some(m => m.id === sel.id)) selectedId = null;
        if (sel?.type === "fixed") {
          const fixed = Array.isArray(st.fixed) ? st.fixed : [];
          if (!fixed.some(f => f.id === sel.id)) selectedId = null;
        }
      }

      // Compute playback points BEFORE drawing.
      map._ensurePlaybackPoints(st);
      
      // Initialize playhead on first data load: offset based on time until next server update
      // Use timeSinceChangeS here since we don't know how stale the initial data is
      // Account for playback speed: at 5x, we consume data 5x faster, so need 5x runway
      if (!map._playbackInitialized) {
        const b = map.getPlaybackBounds();
        if (isFinite(b.minMs) && isFinite(b.maxMs) && b.maxMs > b.minMs) {
          const meta = st?.meta || {};
          const predictedIntervalS = Number(meta.polling_predicted_interval_s) || 600;
          const timeSinceChangeS = Number(meta.polling_time_since_change_s) || 0;
          const timeUntilNextMs = Math.max(60000, (predictedIntervalS - timeSinceChangeS) * 1000);
          const speed = map.getPlaybackSpeed() || 1.0;
          const offsetMs = timeUntilNextMs * speed;
          
          const initMs = map._playbackLiveFollow 
            ? Math.max(b.minMs, b.maxMs - offsetMs)
            : b.maxMs;
          map.setPlaybackTimeMs(initMs);
          map._playbackInitialized = true;
        }
      }

      // Forced refresh (from the TUI): trigger a camera refit using the server-provided
      // update window. This must work even if playback/live-follow RAF is idle.
      try {
        const meta = st?.meta;
        const seqRaw = meta?.force_refresh_seq;
        const seqNum = (typeof seqRaw === "number" && isFinite(seqRaw)) ? seqRaw : null;
        let bumped = false;
        if (seqNum != null) {
          if (_tickLastForceRefreshSeq == null) {
            // If the user pressed 'r' before our first successful poll, seq may already be >0.
            bumped = (seqNum > 0);
          } else {
            bumped = (seqNum !== _tickLastForceRefreshSeq);
          }
          _tickLastForceRefreshSeq = seqNum;
        }

        if (bumped) {
          const sMs = (typeof meta?.trail_update_start_ms === "number" && isFinite(meta.trail_update_start_ms)) ? meta.trail_update_start_ms : null;
          const eMs = (typeof meta?.trail_update_end_ms === "number" && isFinite(meta.trail_update_end_ms)) ? meta.trail_update_end_ms : null;
          if (sMs != null && eMs != null) {
            // Also rewind playback time to replay the newest segment.
            // Must account for playback speed (data-time consumed between server updates).
            // Respect active scrub/drag so user interaction wins.
            try {
              if (!_pbScrubbing && !(typeof map?._hasPbMarkerInertia === "function" && map._hasPbMarkerInertia())) {
                const bounds = map.getPlaybackBounds();
                const hasPbBounds = isFinite(bounds?.minMs) && isFinite(bounds?.maxMs) && Number(bounds.maxMs) > Number(bounds.minMs);
                if (hasPbBounds) {
                  const updateIntervalMs = Number(eMs) - Number(sMs);
                  const speedMult = map.getPlaybackSpeed() || 1.0;
                  if (isFinite(updateIntervalMs) && updateIntervalMs > 0 && isFinite(speedMult) && speedMult > 0) {
                    const targetMs = Number(bounds.maxMs) - updateIntervalMs * speedMult;
                    const nextMs = clamp(targetMs, Number(bounds.minMs), Number(bounds.maxMs));
                    const cur = map.getPlaybackTimeMs();
                    if (cur == null || !isFinite(Number(cur)) || Math.abs(nextMs - Number(cur)) > 200) {
                      map.setPlaybackTimeMs(nextMs);
                    }
                  }
                }
              }
            } catch {}

            const bb = _collectBoundsForMobilesNewSegment(mobiles, sMs, eMs);
            if (bb && bb.visibleVehicleCount > 0 && bb.visiblePointCount > 0 && isFinite(bb.minLat) && isFinite(bb.maxLat)) {
              // Respect user interaction: if the user is panning/zooming, defer until after cooldown.
              if (typeof map?._canRunAutoCamera === "function" && !map._canRunAutoCamera()) {
                map._pendingForcedFit = { bounds: bb, durationMs: _pbLiveFollowDurationMs };
              } else {
                _animateFitBoundsLatLon(bb, { durationMs: _pbLiveFollowDurationMs });
              }
            }
          }
        }
      } catch {}

      // If a forced refresh was requested during user interaction, apply it once we can.
      try {
        if (map && map._pendingForcedFit && typeof map._canRunAutoCamera === "function" && map._canRunAutoCamera()) {
          const p = map._pendingForcedFit;
          map._pendingForcedFit = null;
          if (p && p.bounds) _animateFitBoundsLatLon(p.bounds, { durationMs: p.durationMs || _pbLiveFollowDurationMs });
        }
      } catch {}

      // Avoid forcing an extra overlay redraw every poll.
      // Selection is applied before draw() so the single drawOverlay pass uses the right styling.
      if (map.selectedId !== selectedId) {
        map.selectedId = selectedId || null;
        map._invalidateOverlayStatic();
      }
      map.draw(st);

      renderLists(st, selectedId);
      renderDetails(st, selectedId);

      // Keep DVR UI in sync even when the RAF loop is idle.
      if (map.playbackMode) {
        try { 
          updatePlaybackUi(); 
          updateSidebarPlaybackValues(); // Apply playback-time visibility to sidebar
        } catch {}
      }
      saveViewSoon();
    } catch (e) {
      // Rendering issues should not flip the connection status.
      try { console.error(e); } catch {}
    } finally {
      _tickInFlight = false;
    }
  }

  // Load server config before starting data polling
  // This allows the server to control CDN/caching behavior
  loadConfig().then(() => {
    tick();
    setInterval(tick, POLL_MS);
  });
}

main();


