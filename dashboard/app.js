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
  },
  carto_dark_all: {
    label: "CARTO Dark (all)",
    template: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
    subdomains: ["a", "b", "c", "d"],
    filter: { saturate: 0.90, brightness: 0.92, contrast: 1.08 },
  },
  carto_dark_nolabels: {
    label: "CARTO Dark (no labels)",
    template: "https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png",
    subdomains: ["a", "b", "c", "d"],
    filter: { saturate: 0.90, brightness: 0.95, contrast: 1.06 },
  },
  carto_positron_all: {
    label: "CARTO Positron (all)",
    template: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
    subdomains: ["a", "b", "c", "d"],
    filter: { saturate: 0.45, brightness: 0.60, contrast: 1.10 },
  },
  carto_positron_nolabels: {
    label: "CARTO Positron (no labels)",
    template: "https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png",
    subdomains: ["a", "b", "c", "d"],
    filter: { saturate: 0.45, brightness: 0.60, contrast: 1.10 },
  },
  osm: {
    label: "OSM Standard",
    template: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    subdomains: [""],
    filter: { saturate: 0.45, brightness: 0.62, contrast: 1.12 },
  },
};

const THEME_STORAGE_KEY = "mobileair.mapTheme";
const DIM_STORAGE_PREFIX = "mobileair.mapDim."; // per theme (0..100)
const SAT_STORAGE_PREFIX = "mobileair.mapSat."; // per theme (0..150 => saturate factor = v/100)
const VIEW_STORAGE_KEY = "mobileair.mapView"; // {lat, lon, zoom}
const TRACE_STORAGE_KEY = "mobileair.traceMode"; // "1" or "0"
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
    if (v >= 1.0) v = v / 1000.0; // ppb -> ppm
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
    
    // Convert ISO strings to ms timestamps
    const timesMs = times.map(t => new Date(t).getTime());
    
    // Find the appropriate value for this time
    const tMin = timesMs[0];
    const tMax = timesMs[timesMs.length - 1];
    
    let idx;
    if (playbackTimeMs <= tMin) {
      idx = 0;
    } else if (playbackTimeMs >= tMax) {
      idx = values.length - 1;
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
      value: values[idx],
      color: colors[idx] || r.color || "#cccccc",
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
    this.selectedId = null;
    // Marker visibility toggles
    this.showFixed = true;
    this.showMobile = true;
    this.showLabels = true;
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

    // Playback-mode optimization: cache the static underlay (fixed markers + trails).
    // This lets us redraw only moving markers without re-stroking the whole trail layer.
    this._overlayUnderlayCanvas = null; // offscreen canvas in device pixels
    this._overlayUnderlayKey = "";

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
    // LIVE follow-tail: when true, keep playhead pinned to end-of-data (maxMs).
    // This is the default "LIVE" experience (no rewinds).
    this._playbackLiveFollow = true;

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
            // Follow live only when dragging near the absolute end.
            this._playbackLiveFollow = (clamped >= (bounds.maxMs - 1500));
          } else {
            this.setPlaybackTimeMs(tMs);
            this._playbackLiveFollow = false;
          }
        }
        this.drawOverlay(this.lastState);
      }
      return;
    }
    if (!this._mouseDragging || !this._mouseDragStart || !this._mouseDragCenterStart) return;
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
    const z1 = Number(zoom);
    if (!isFinite(lat1) || !isFinite(lon1) || !isFinite(z1)) return;

    const t0 = performance.now();
    // Only used for auto-centering / fit-to-bounds. Keep it snappy.
    const dur = Math.max(120, durationMs);

    if (this._centerAnimRAF) cancelAnimationFrame(this._centerAnimRAF);

    const step = () => {
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
    } else {
      // Entering DVR starts in LIVE follow-tail at the end-of-data.
      this._playbackLiveFollow = true;
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
        this._playbackLiveFollow = (clamped >= (bounds.maxMs - 1500));
      } else {
        this.setPlaybackTimeMs(tMs);
        this._playbackLiveFollow = false;
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
    const rect = this.tilesCanvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));

    this._dpr = dpr;
    this._cssW = w;
    this._cssH = h;

    this.tilesCanvas.width = Math.floor(w * dpr);
    this.tilesCanvas.height = Math.floor(h * dpr);
    this.overlayCanvas.width = Math.floor(w * dpr);
    this.overlayCanvas.height = Math.floor(h * dpr);

    this.tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.octx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Snapshot is tied to canvas size; reset on resize to avoid distortion.
    this._tilesSnapshotCanvas = null;
    this._tilesSnapshotMeta = null;
    this._invalidateOverlayStatic();

    this.draw(this.lastState);
  }


  onWheel(e) {
    // macOS trackpad:
    // - two-finger drag -> wheel deltaX/deltaY (pan)
    // - pinch-to-zoom -> wheel with ctrlKey=true (zoom)
    e.preventDefault();

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
    try {
      const mobiles = Array.isArray(state?.mobile) ? state.mobile : [];
      let maxT = null;
      for (const m of mobiles) {
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
    } catch {
      // ignore
    }

    this._prunePerMobileCachesForState(state);
    this._updatePersistedTrails(state);
    this._invalidateOverlayStatic();
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
    return `${revKey}|persist:${this._persistedTrailRev}|v2`;
  }

  _ensurePlaybackPoints(state) {
    const key = this._playbackPointsKeyForState(state);
    if (this._playbackPtsKey === key) return;
    this._playbackPtsKey = key;

    const nextPtsById = new Map();
    let minMs = Infinity;
    let maxMs = -Infinity;

    const mobiles = Array.isArray(state?.mobile) ? state.mobile : [];
    for (const m of mobiles) {
      const id = m && m.id != null ? String(m.id) : "";
      if (!id) continue;

      const serverTrail = Array.isArray(m?.trail) ? m.trail : [];
      // When viewing historical data, always use server trail (not live-accumulated persisted trail)
      const persisted = this._historicalMode ? [] : (this._persistedTrailById.get(id)?.trail || []);
      const src = (persisted.length >= 2) ? persisted : serverTrail;
      if (!Array.isArray(src) || src.length < 2) continue;

      const pts = [];
      for (const p of src) {
        const lat = Number(p?.lat);
        const lon = Number(p?.lon);
        if (!isFinite(lat) || !isFinite(lon)) continue;
        const tMs = (p && typeof p.t === "string") ? parseUtcMs(p.t) : null;
        if (tMs == null || !isFinite(tMs)) continue;
        pts.push({ lat, lon, tMs, m: p.m, readings: p.readings });
        minMs = Math.min(minMs, tMs);
        maxMs = Math.max(maxMs, tMs);
      }
      // Allow single-point trails so marker is visible at that position
      if (pts.length >= 1) {
        pts.sort((a, b) => a.tMs - b.tMs);
        nextPtsById.set(id, pts);
      }
    }

    this._playbackPtsById = nextPtsById;
    this._playbackMinMs = isFinite(minMs) ? minMs : null;
    this._playbackMaxMs = isFinite(maxMs) ? maxMs : null;

    // Default playhead to latest if unset.
    if (this._playbackNowMs == null && this._playbackMaxMs != null) this._playbackNowMs = this._playbackMaxMs;
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

    let idxHi = 1;
    if (t <= tMin) idxHi = 1;
    else if (t >= tMax) idxHi = pts.length - 1;
    else {
      let lo = 1;
      let hi = pts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (pts[mid].tMs >= t) hi = mid;
        else lo = mid + 1;
      }
      idxHi = lo;
    }

    const nextPoint = pts[idxHi];
    const prevPoint = pts[Math.max(0, idxHi - 1)];
    const dtMs = Math.max(1, (nextPoint.tMs - prevPoint.tMs));
    const u = clamp((t - prevPoint.tMs) / dtMs, 0, 1);
    const lat = prevPoint.lat + (nextPoint.lat - prevPoint.lat) * u;
    const lon = prevPoint.lon + (nextPoint.lon - prevPoint.lon) * u;
    const distM = haversineMeters(prevPoint.lat, prevPoint.lon, nextPoint.lat, nextPoint.lon);
    let speedMps = clamp(distM / Math.max(0.001, dtMs / 1000), 0, Number(this._traceRealMaxSpeedMps) || 20.0);
    // If we're at (or beyond) the end of data, the marker is not traversing a segment anymore.
    // Don't report the last segment's speed as current motion.
    if (t >= tMax - 1) speedMps = 0;

    // Determine transient visibility:
    // - Dim idle (non-moving) markers unless Debug/Selected.
    // Note: ghosted status is irrelevant here - it's current live state, not historical.
    // During playback, we use the trail's `m` flag to determine if it was moving at that time.
    let opacity = 1.0;
    const dimOpacity = 0.25;
    const movingFlag = !!(nextPoint && (nextPoint.m === 1 || nextPoint.m === "1" || nextPoint.m === true));
    const key = keyFor("mobile", m.id);
    const isSel = (this.selectedId === key);

    if (!movingFlag && !this._pbDebugPath && !isSel) {
      opacity = dimOpacity;
    }

    // Additional gap check (dim markers in large data gaps)
    if (dtMs > 305000 && t > prevPoint.tMs + 5000 && t < nextPoint.tMs - 5000 && !this._pbDebugPath && !isSel) {
      opacity = dimOpacity;
    }

    // Heading + flip side + smoothed render angle (reuse caches).
    const w0 = latLonToWorld(prevPoint.lat, prevPoint.lon, this.zoom);
    const w1 = latLonToWorld(nextPoint.lat, nextPoint.lon, this.zoom);
    let dx = (w1.x - w0.x);
    let dy = (w1.y - w0.y);
    if (Math.abs(dx) < 0.0001 && Math.abs(dy) < 0.0001) {
      dx = 1e-3;
      dy = 0;
    }
    const heading = Math.atan2(dy, dx);

    const absH = Math.abs(heading);
    const dead = 0.22;
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

    const wrapAngle = (ang) => {
      let x = ang;
      while (x > Math.PI) x -= Math.PI * 2;
      while (x < -Math.PI) x += Math.PI * 2;
      return x;
    };
    const prevA = this._traceAngleById.get(id);
    const lastMs = this._traceAngleLastMsById.get(id);
    const dtS = (lastMs != null && isFinite(lastMs)) ? Math.max(0, (nowPerfMs - lastMs) / 1000) : 0;
    const tauS = 0.35;
    const alpha = dtS > 0 ? (1 - Math.exp(-dtS / tauS)) : 1;
    const nextA = (prevA == null)
      ? renderAngle
      : wrapAngle(prevA + wrapAngle(renderAngle - prevA) * alpha);
    this._traceAngleById.set(id, nextA);
    this._traceAngleLastMsById.set(id, nowPerfMs);

    // Historical reading: always use the destination point's reading for the current segment
    // (idxHi) so the label matches the trail segment color (which is also based on the dest point).
    // Previously we snapped to nearest (idxPick), causing a mismatch for the first 50% of the segment.
    const pRaw = pts[idxHi];
    const reading = primaryReadingKeyedFromPoint(pRaw);

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

        // Prevent loop "teleport": after pausing at the end, drive back to the loop start quickly.
        const loopStartPt = pts[0];
        const endPt = pts[pts.length - 1] || loopStartPt;
        const backDistM = haversineMeters(endPt.lat, endPt.lon, loopStartPt.lat, loopStartPt.lon);
        const returnMs = (isFinite(backDistM) && backDistM > 3)
          ? clamp(1000 + (backDistM / 250) * 1000, 1000, 3000)
          : 0;
        const totalMsWithReturn = driveMs + pauseMs + returnMs;

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
      const key = keyFor("mobile", m && m.id != null ? m.id : "");
      const isSelUi = (this.selectedId === key);

      // We no longer hide trails globally based on the latest ghosted state.
      // Reveal logic handles time-based visibility, and the server handles jitter.
      // Idle trails remain visible as dimmed historical data.

      // DVR revealing-path logic:
      // When in playback mode, only show points up to the current playhead.
      // If we are LIVE (at the end), show the full path.
      const isLive = !this.playbackMode || !!this._playbackLiveFollow;
      const pbTimeMs = this.playbackMode ? this.getPlaybackTimeMs() : null;

      const serverTrail = Array.isArray(m?.trail) ? m.trail : [];
      const hasServerTrail = serverTrail.length >= 2;
      // When in historical mode, always use server trail (not live-accumulated persisted trail)
      const persistedTrail = (id && !this._historicalMode) ? (this._persistedTrailById.get(id)?.trail || []) : [];
      const trail = (persistedTrail.length >= 2) ? persistedTrail : (hasServerTrail ? serverTrail : []);
      if (!Array.isArray(trail) || trail.length < 2) return false;
      const isGhost = !!m.ghosted;
      const pts = [];
      const cols = [];
      const times = [];

      const getSp = (toScreen || this.worldToScreen.bind(this));

      let lastInterp = null;
      for (let i = 0; i < trail.length; i++) {
        const p = trail[i];
        const lat = Number(p.lat), lon = Number(p.lon);
        if (p.lat == null || p.lon == null || !isFinite(lat) || !isFinite(lon)) {
          pts.push(null);
          cols.push(null);
          continue;
        }

        const tMs = (p && typeof p.t === "string") ? parseUtcMs(p.t) : null;
        if (!isLive && pbTimeMs != null && tMs != null && tMs > pbTimeMs) {
          // Smooth reveal interpolation:
          const prev = trail[i - 1];
          const tPrev = (prev && typeof prev.t === "string") ? parseUtcMs(prev.t) : null;
          if (prev && tPrev != null && isFinite(Number(prev.lat)) && isFinite(Number(prev.lon))) {
            const u = clamp((pbTimeMs - tPrev) / (tMs - tPrev), 0, 1);
            const iLat = Number(prev.lat) + (lat - Number(prev.lat)) * u;
            const iLon = Number(prev.lon) + (lon - Number(prev.lon)) * u;
            const wpt = latLonToWorld(iLat, iLon, this.zoom);
            const sp = getSp(wpt.x, wpt.y);
            const pr = primaryReadingFromPoint(p);
            const base = safeHex(pr?.color || m.color);
            // No binary fading here; color is baked per segment below
            lastInterp = { sp, col: base };
          }
          break;
        }

        const wpt = latLonToWorld(lat, lon, this.zoom);
        pts.push(getSp(wpt.x, wpt.y));
        const pr = primaryReadingFromPoint(p);
        const base = safeHex(pr?.color || m.color);
        // No binary fading here; color is baked per segment below
        cols.push(base);
        times.push(tMs);
      }
      if (lastInterp) {
        pts.push(lastInterp.sp);
        cols.push(lastInterp.col);
        times.push(pbTimeMs);
      }

      if (pts.length < 2) return false;
      // selection handled above for early return; keep local isSel for styling
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
      const FADE_TIME_MS = 45 * 60 * 1000; // 45 minutes -> fully expired
      const FADE_TAIL_FRAC = 0.50; // fade over the last 20% of FADE_TIME_MS
      const FADE_START_FRAC = 1.0 - FADE_TAIL_FRAC; // e.g. 0.80
      // Reference time:
      // - In playback mode (including when "LIVE"/follow-tail at the end), fade follows the playhead time.
      //   This prevents the entire historical path from suddenly fading out when playback reaches the end
      //   and we transition into follow-tail.
      // - Outside playback mode, fade follows wall-clock time.
      const refNowMs = (this.playbackMode && pbTimeMs != null && isFinite(pbTimeMs))
        ? Number(pbTimeMs)
        : this._dataNowMs();

      for (let i = 1; i < pts.length; i++) {
        if (!pts[i - 1] || !pts[i]) continue;

        // Use the 'm' (moving) flag from the server point to determine if
        // this segment should be hidden/faded (jitter) or bright (historical data).
        const p1 = trail[i];
        // IMPORTANT: "moving" must be explicit. Missing/undefined m is treated as idle.
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

        // colored segment
        ctx.save();
        const t1 = times[i];
        if (!(t1 != null && isFinite(t1) && isFinite(refNowMs))) {
          ctx.restore();
          continue;
        }

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
        ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
        ctx.lineTo(pts[i].x, pts[i].y);
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

    if (this.traceMode) {
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

    // Playback-mode: trails are clipped to playback time, so we redraw them each frame.
    // Caching doesn't help here since the visible trail changes as time advances.
    const canUseUnderlay = false;

    // Precompute center world once per frame; avoids repeated center projection in worldToScreen().
    const centerW = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
    const worldToScreenFast = (wx, wy) => ({ x: wx - centerW.x + w / 2, y: wy - centerW.y + h / 2 });

    // Fixed markers - same interaction model as mobile
    // In trace mode, fixed markers are part of the cached static overlay.
    // In playback underlay mode, fixed markers are already present.
    // Get playback time for fixed sensors with history
    const fixedPbTimeMs = this.playbackMode ? this.getPlaybackTimeMs() : null;
    
    if (!this.traceMode && !canUseUnderlay && this.showFixed) {
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

    // DVR revealing-path logic:
    // When in playback mode, only show points up to the current playhead.
    // If we are LIVE (at the end), show the full path.
    const isLive = !this.playbackMode || !!this._playbackLiveFollow;
    const pbTimeMs = this.playbackMode ? this.getPlaybackTimeMs() : null;

    const drawTrailFor = (m, alphaMul, toScreen) => {
      const id = m && m.id != null ? String(m.id) : "";
      const key = keyFor("mobile", m && m.id != null ? m.id : "");
      const isSel = (this.selectedId === key);

      // We no longer hide trails globally based on the latest ghosted state.
      // Reveal logic handles time-based visibility, and the server handles jitter.
      // Idle trails remain visible as dimmed historical data.
      const serverTrail = Array.isArray(m?.trail) ? m.trail : [];
      const hasServerTrail = serverTrail.length >= 2;
      // When in historical mode, always use server trail (not live-accumulated persisted trail)
      const persistedTrail = (id && !this._historicalMode) ? (this._persistedTrailById.get(id)?.trail || []) : [];
      const trail = (persistedTrail.length >= 2) ? persistedTrail : (hasServerTrail ? serverTrail : []);
      if (!Array.isArray(trail) || trail.length < 2) return false;
      const isGhost = !!m.ghosted;
      const pts = [];
      const cols = [];
      const times = [];

      const getSp = (toScreen || this.worldToScreen.bind(this));

      // Optimization: calculate world size once per trail
      const ws = worldSizeForZoom(this.zoom);

      let lastInterp = null;
      for (let i = 0; i < trail.length; i++) {
        const p = trail[i];
        
        // OPTIMIZATION: Cache normalized world coordinates to avoid expensive trig per frame.
        let u = p._u, v = p._v;
        if (u === undefined) {
          const lat = Number(p.lat), lon = Number(p.lon);
          if (p.lat == null || p.lon == null || !isFinite(lat) || !isFinite(lon)) {
            pts.push(null);
            cols.push(null);
            continue;
          }
          const norm = latLonToNorm(lat, lon);
          u = norm.u; v = norm.v;
          p._u = u; p._v = v;
        }

        // Cache parsed timestamp on the point to avoid per-frame parsing work.
        let tMs = p?._tMs;
        if (tMs === undefined) {
          tMs = (p && typeof p.t === "string") ? parseUtcMs(p.t) : null;
          try { p._tMs = tMs; } catch {}
        }
        if (!isLive && pbTimeMs != null && tMs != null && tMs > pbTimeMs) {
          // Smooth reveal interpolation:
          const prev = trail[i - 1];
          let tPrev = prev?._tMs;
          if (tPrev === undefined) {
            tPrev = (prev && typeof prev.t === "string") ? parseUtcMs(prev.t) : null;
            try { if (prev) prev._tMs = tPrev; } catch {}
          }
          if (prev && tPrev != null) {
            const uTime = clamp((pbTimeMs - tPrev) / (tMs - tPrev), 0, 1);
            let pu = prev._u, pv = prev._v;
            if (pu === undefined) { const n = latLonToNorm(Number(prev.lat), Number(prev.lon)); pu = n.u; pv = n.v; }
            
            // Linear interpolate in projected space
            const i_u = pu + (u - pu) * uTime;
            const i_v = pv + (v - pv) * uTime;
            
            const sp = getSp(i_u * ws, i_v * ws);
            const pr = primaryReadingFromPoint(p);
            const base = safeHex(pr?.color || m.color);
            lastInterp = { sp, col: base };
          }
          break;
        }

        pts.push(getSp(u * ws, v * ws));
        const pr = primaryReadingFromPoint(p);
        const base = safeHex(pr?.color || m.color);
        // We no longer dim points globally here. 
        // Dimming is now handled per-segment in the drawing loop below.
        cols.push(base);
        times.push(tMs);
      }
      if (lastInterp) {
        pts.push(lastInterp.sp);
        cols.push(lastInterp.col);
        times.push(pbTimeMs);
      }

      if (pts.length < 2) return false;
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
      // In playback mode (even when following "LIVE" at end), key fading to the playhead time so we
      // don't fade the entire trail just because wall-clock time has advanced past the history window.
      const refNowMs = (this.playbackMode && pbTimeMs != null && isFinite(pbTimeMs))
        ? Number(pbTimeMs)
        : this._dataNowMs();

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

    // In trace mode, trails are part of the cached static overlay.
    // In playback underlay mode, trails are already present.
    if (!this.traceMode && !canUseUnderlay) {
      // Note: we intentionally do not render trails for mobiles missing from the payload.

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

      const alphaOther = selectedId ? 0.35 : 1.0;
      const nonSelected = mobiles
        .filter(m => !(selectedId && m.id === selectedId))
        .slice()
        .sort((a, b) => trailLastMs(a) - trailLastMs(b));

      for (const m of nonSelected) {
        drawTrailFor(m, alphaOther, worldToScreenFast);
      }

      if (selectedId) {
        const m = mobiles.find(x => x.id === selectedId);
        if (m) drawTrailFor(m, 1.0, worldToScreenFast);
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
      if ((this.traceMode || this.playbackMode) && this.showLabels) {
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
      if (this.showLabels) {
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
  
  const nowPerfMs = performance.now();
  const t = map.getPlaybackTimeMs();
  if (t == null || !isFinite(t)) return;
  
  for (const m of state.mobile) {
    if (!m || m.id == null) continue;
    
    // Find the DOM element for this sensor
    const itemEl = listMobileEl.querySelector(`[data-id="${m.id}"]`);
    if (!itemEl) continue;
    
    // Check if marker is visible at current playback time using the same logic as the map
    const sample = map._playbackSampleForMobile(m, nowPerfMs);
    const isVisible = sample && sample.visible !== false;
    
    if (!isVisible) {
      if (!itemEl.classList.contains("hidden")) {
        itemEl.classList.add("hidden");
      }
      continue;
    }
    
    if (itemEl.classList.contains("hidden")) {
      itemEl.classList.remove("hidden");
    }
    
    if (!sample || !sample.reading) continue;
    
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
  const res = await fetch("/api/state", { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

function injectCastleFixedMarker(state) {
  if (!state || typeof state !== "object") return state;
  const st = state;
  const fixed = Array.isArray(st.fixed) ? st.fixed : [];
  const id = "Home";
  const exists = fixed.some((f) => f && String(f.id) === id);
  if (exists) {
    if (!Array.isArray(st.fixed)) st.fixed = fixed;
    return st;
  }
  const marker = {
    id,
    name: "Home",
    lat: 40.77091,
    lon: -111.85921,
    emoji: "🏰",
    color: "#ffffff",
    readings: {},
  };
  st.fixed = [...fixed, marker];
  return st;
}

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
  const SHOW_LABELS_KEY = "mobileair.showLabels";
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
  map.showLabels = localStorage.getItem(SHOW_LABELS_KEY) !== "false";

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
      tabLabelsEl.classList.toggle("active", map.showLabels);
      tabLabelsEl.classList.toggle("disabled", !map.showLabels);
    }
    if (listMobileEl) listMobileEl.classList.toggle("hidden", !isMobile);
    if (listFixedEl) listFixedEl.classList.toggle("hidden", isMobile);
    localStorage.setItem(TAB_STORAGE_KEY, isMobile ? "mobile" : "fixed");
    localStorage.setItem(SHOW_MOBILE_KEY, map.showMobile ? "true" : "false");
    localStorage.setItem(SHOW_FIXED_KEY, map.showFixed ? "true" : "false");
    localStorage.setItem(SHOW_LABELS_KEY, map.showLabels ? "true" : "false");
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
      map.showLabels = !map.showLabels;
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
      map._centeredOnce = true; // prevent "auto center on first mobile" from overriding restore
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

  function loadDimForTheme(themeKey) {
    const raw = localStorage.getItem(DIM_STORAGE_PREFIX + themeKey);
    const v = raw == null ? 50 : Number(raw);
    const clamped = Math.max(0, Math.min(100, isFinite(v) ? v : 50));
    return clamped;
  }

  function loadSatForTheme(themeKey) {
    const raw = localStorage.getItem(SAT_STORAGE_PREFIX + themeKey);
    const t = TILE_THEMES[themeKey] || TILE_THEMES.carto_voyager;
    const def = Math.round(100 * (t.filter?.saturate ?? 0.55));
    const v = raw == null ? def : Number(raw);
    const clamped = Math.max(0, Math.min(150, isFinite(v) ? v : def));
    return clamped;
  }

  function applyThemeAndFilters(themeKey, dimVal0to100, satVal0to150) {
    const t = TILE_THEMES[themeKey] || TILE_THEMES.carto_voyager;
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
  }

  if (themeEl) {
    const keys = Object.keys(TILE_THEMES);
    for (const k of keys) {
      const opt = document.createElement("option");
      opt.value = k;
      opt.textContent = TILE_THEMES[k].label || k;
      themeEl.appendChild(opt);
    }

    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    const initialTheme = TILE_THEMES[savedTheme] ? savedTheme : "carto_voyager";
    themeEl.value = initialTheme;

    const initialDim = loadDimForTheme(initialTheme);
    if (dimEl) dimEl.value = String(initialDim);
    const initialSat = loadSatForTheme(initialTheme);
    if (satEl) satEl.value = String(initialSat);
    applyThemeAndFilters(initialTheme, initialDim, initialSat);

    themeEl.addEventListener("change", () => {
      const k = themeEl.value;
      localStorage.setItem(THEME_STORAGE_KEY, k);
      const dim = loadDimForTheme(k);
      if (dimEl) dimEl.value = String(dim);
      const sat = loadSatForTheme(k);
      if (satEl) satEl.value = String(sat);
      applyThemeAndFilters(k, dim, sat);
    });
  } else {
    // Fallback (no UI)
    applyThemeAndFilters("carto_voyager", 50, Math.round(100 * (TILE_THEMES.carto_voyager.filter?.saturate ?? 0.55)));
  }

  // Restore view after map is initialized (theme/filter doesn't affect center/zoom).
  restoreViewIfAny();

  if (dimEl) {
    dimEl.addEventListener("input", () => {
      const themeKey = (themeEl && TILE_THEMES[themeEl.value]) ? themeEl.value : "carto_voyager";
      const v = Number(dimEl.value);
      const clamped = Math.max(0, Math.min(100, isFinite(v) ? v : 50));
      localStorage.setItem(DIM_STORAGE_PREFIX + themeKey, String(clamped));
      const sat = satEl ? Number(satEl.value) : loadSatForTheme(themeKey);
      const satClamped = Math.max(0, Math.min(150, isFinite(sat) ? sat : loadSatForTheme(themeKey)));
      applyThemeAndFilters(themeKey, clamped, satClamped);
    });
  }

  if (satEl) {
    satEl.addEventListener("input", () => {
      const themeKey = (themeEl && TILE_THEMES[themeEl.value]) ? themeEl.value : "carto_voyager";
      const v = Number(satEl.value);
      const clamped = Math.max(0, Math.min(150, isFinite(v) ? v : loadSatForTheme(themeKey)));
      localStorage.setItem(SAT_STORAGE_PREFIX + themeKey, String(clamped));
      const dim = dimEl ? Number(dimEl.value) : loadDimForTheme(themeKey);
      const dimClamped = Math.max(0, Math.min(100, isFinite(dim) ? dim : loadDimForTheme(themeKey)));
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

  document.getElementById("zoomIn").addEventListener("click", () => map.zoomBy(1));
  document.getElementById("zoomOut").addEventListener("click", () => map.zoomBy(-1));
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
  
  // Track when we first came to rest at the end (for 1s pause before rewind)
  let _pbAtEndSincePerf = null;   // performance.now() when we first stopped at end
  
  // Track when ease-in phase started (for wall-time-based easing)
  let _pbEaseStartPerf = null;
  let _pbEaseStartVelocity = 0;
  let _pbEaseStartPos = 0;  // playhead position when ease began
  
  // Flag to track active rewind (not based on velocity)
  let _pbIsRewinding = false;
  
  // Track data bounds to detect new data / trimmed data
  let _pbLastKnownMinMs = null;
  let _pbLastKnownMaxMs = null;
  
  // Physics constants
  const _pbPlaybackSpeed = 1.0;       // target velocity when playing forward
  const _pbRewindSpeed = -100.0;      // target velocity when rewinding (negative = backward, FAST)
  const _pbFriction = 0.997;          // velocity decay per ms when coasting (drag inertia)
  const _pbWheelFriction = 0.985;     // velocity decay per ms for wheel scroll (stops faster)
  const _pbForceStrength = 0.008;     // how quickly velocity changes toward target (per ms)
  const _pbEndPauseMs = 1000;         // wait 1 second at end before rewinding
  const _pbVelocityThreshold = 0.1;   // below this, considered "at rest"
  const _pbEaseInDistance = 0.02;     // start braking when within 2% of bounds (only near edges)
  
  // Scroll wheel nudge (iPod-style momentum)
  let _pbWheelAccum = 0;              // accumulated wheel delta
  const _pbWheelImpulse = 1.0;        // velocity added per wheel tick
  const _pbWheelDecay = 0.8;          // wheel accumulator decay per frame

  // Drag tracking
  let _pbDidDrag = false;             // did the user actually drag (vs click)?
  let _pbIsWheelCoasting = false;     // is current coast from wheel scroll?

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
        // If we are following live, force the slider to the absolute end.
        const useMax = map._playbackLiveFollow || map.isPlaybackAtEnd(200);
        pbScrubEl.value = useMax ? String(durMs) : String(clamp(tRelMs, 0, durMs));
      }
    } else if (pbScrubEl) {
      pbScrubEl.disabled = true;
      pbScrubEl.min = "0";
      pbScrubEl.max = "1";
      pbScrubEl.value = "0";
    }

    const hasBounds = isFinite(b.minMs) && isFinite(b.maxMs) && b.maxMs > b.minMs;
    // If we don't have any bounds yet, we still consider ourselves "LIVE" at the end.
    const atEnd = !hasBounds || map.isPlaybackAtEnd(200);
    const followingLive = atEnd && map._playbackLiveFollow;

    if (pbPlayEl) {
      if (followingLive) {
        pbPlayEl.textContent = "Live";
        pbPlayEl.classList.add("isLive");
      } else {
        pbPlayEl.textContent = map.getPlaybackPlaying() ? "Pause" : (atEnd ? "Live" : "Play");
        pbPlayEl.classList.remove("isLive");
      }
    }
    if (pbSpeedEl) pbSpeedEl.value = String(map.getPlaybackSpeed() || 1.0);
  };

  const playbackLoop = () => {
    _pbRAF = null;
    if (!map.playbackMode) return;
    const now = performance.now();
    const dt = (_pbLastPerf > 0) ? (now - _pbLastPerf) : 0;
    _pbLastPerf = now;

    const b = map.getPlaybackBounds();
    let tMs = map.getPlaybackTimeMs();
    const hasBounds = isFinite(b.minMs) && isFinite(b.maxMs) && b.maxMs > b.minMs;
    const durMs = hasBounds ? (b.maxMs - b.minMs) : 1;

    // ─────────────────────────────────────────────────────────────────────────
    // DETECT DATA CHANGES (new data arrived, or data trimmed)
    // ─────────────────────────────────────────────────────────────────────────
    let newDataArrived = false;
    
    if (hasBounds) {
      if (_pbLastKnownMaxMs != null && b.maxMs > _pbLastKnownMaxMs + 100) {
        newDataArrived = true;
      }
      _pbLastKnownMinMs = b.minMs;
      _pbLastKnownMaxMs = b.maxMs;
      
      // If playhead is now outside bounds (data trimmed), clamp it
      if (tMs < b.minMs) {
        tMs = b.minMs;
        map.setPlaybackTimeMs(tMs);
      }
      if (tMs > b.maxMs) {
        tMs = b.maxMs;
        map.setPlaybackTimeMs(tMs);
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
      const atStart = (tMs <= b.minMs + 1);
      const atEnd = (tMs >= b.maxMs - 1);
      const speedMult = map.getPlaybackSpeed() || 1.0;
      
      if (_pbIsRewinding) {
        // Tape-reel rewind: ramp up, cruise, ease into start
        const distFromStart = tMs - b.minMs;
        const totalDist = durMs;
        const progress = 1 - (distFromStart / totalDist); // 0 at end, 1 at start
        
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
          // NEWTONIAN PHYSICS: constant acceleration to reach playbackSpeed at b.minMs
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
          const d = _pbEaseStartPos - b.minMs;
          
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
          if (tMs <= b.minMs + 10 || _pbVelocity >= vFinal) {
            _pbIsRewinding = false;
            _pbEaseStartPerf = null;
            _pbVelocity = playbackSpeed;
          }
        } else {
          // Cruise phase: full speed
          _pbVelocity = cruiseSpeed;
        }
      } else if (map._playbackLiveFollow && atEnd) {
        // LIVE mode at end: stay put, but resume when new data arrives
        _pbVelocity = 0;
        if (newDataArrived) {
          _pbVelocity = _pbPlaybackSpeed * speedMult;
        }
      } else if (map.getPlaybackPlaying()) {
        // Normal forward playback
        if (atEnd) {
          // At end, not LIVE, not rewinding: pause then auto-rewind
          if (_pbAtEndSincePerf == null) {
            _pbAtEndSincePerf = now;
            _pbVelocity = 0; // stop at end
          }
          const timeAtEnd = now - _pbAtEndSincePerf;
          if (timeAtEnd >= _pbEndPauseMs) {
            // Time's up - start rewinding
            _pbIsRewinding = true;
            _pbVelocity = _pbRewindSpeed;
            _pbAtEndSincePerf = null; // reset so we don't keep retriggering
          }
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
          _pbVelocity = playbackSpeed;
          map.setPlaybackPlaying(true);
          updatePlaybackUi();
        } else if (_pbVelocity < 0 && Math.abs(_pbVelocity) < _pbVelocityThreshold) {
          // Backward coasting stopped - resume forward playback
          _pbIsWheelCoasting = false;
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
        
        // Clamp to bounds
        nextMs = clamp(nextMs, b.minMs, b.maxMs);
        
        // If we hit a bound, zero velocity (unless in active ease - let ease control it)
        if (nextMs <= b.minMs && _pbVelocity < 0 && _pbEaseStartPerf == null) {
          _pbVelocity = 0;
          _pbIsRewinding = false; // rewind complete
          nextMs = b.minMs;
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
    // RENDER
    // ─────────────────────────────────────────────────────────────────────────
    if (didAdvanceTime) {
      map.drawOverlay(map.lastState, { cacheUnderlay: true });
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
    const liveWaitingForData = map._playbackLiveFollow && map.isPlaybackAtEnd(10);
    
    if (map.getPlaybackPlaying() || markerInertiaActive || hasMotion || hasWheelMomentum || waitingToRewind || liveWaitingForData) {
      _pbRAF = requestAnimationFrame(playbackLoop);
    } else {
      _pbLastPerf = 0;
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
    if (pbBarEl) pbBarEl.classList.toggle("hidden", !traceEl.checked);
    if (traceEl.checked) {
      map._ensurePlaybackPoints(window.__lastState || { mobile: [], fixed: [] });
      const b = map.getPlaybackBounds();
      // Always start at end-of-data when entering DVR (LIVE follow-tail).
      if (isFinite(b.maxMs)) {
        map.setPlaybackTimeMs(b.maxMs);
        map._playbackLastMaxMs = Number(b.maxMs);
      }
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
        const b = map.getPlaybackBounds();
        if (isFinite(b.maxMs)) {
          map.setPlaybackTimeMs(b.maxMs);
          map._playbackLastMaxMs = Number(b.maxMs);
        }
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
  }

  if (pbPlayEl) {
    pbPlayEl.addEventListener("click", () => {
      // Enable playback mode if not already (e.g. historical data)
      if (!map.playbackMode) {
        map.setPlaybackMode(true);
      }
      const b = map.getPlaybackBounds();
      if (!isFinite(b.minMs) || !isFinite(b.maxMs) || !(b.maxMs > b.minMs)) return;

      const atEnd = map.isPlaybackAtEnd(100);
      
      // If in LIVE follow mode (lit button), clicking initiates rewind
      if (map._playbackLiveFollow && atEnd) {
        map._playbackLiveFollow = false;
        _pbAtEndSincePerf = null;
        _pbWheelAccum = 0;
        _pbIsRewinding = true;
        _pbVelocity = _pbRewindSpeed;
        map.setPlaybackPlaying(true);
        _pbLastPerf = 0;
        if (!_pbRAF) _pbRAF = requestAnimationFrame(playbackLoop);
        updatePlaybackUi();
        return;
      }

      // If currently playing (not live-follow), pause
      if (map.getPlaybackPlaying()) {
        map.setPlaybackPlaying(false);
        map._playbackLiveFollow = false;
        _pbVelocity = 0;
        _pbWheelAccum = 0;
        _pbAtEndSincePerf = null;
        _pbIsRewinding = false;
        updatePlaybackUi();
        return;
      }

      // If at the end (paused), initiate immediate rewind
      if (atEnd) {
        map._playbackLiveFollow = false;
        _pbAtEndSincePerf = null;
        _pbWheelAccum = 0;
        _pbIsRewinding = true;
        _pbVelocity = _pbRewindSpeed; // immediate rewind velocity
        map.setPlaybackPlaying(true);
        _pbLastPerf = 0;
        if (!_pbRAF) _pbRAF = requestAnimationFrame(playbackLoop);
        updatePlaybackUi();
        return;
      }

      // Normal play from current position
      _pbAtEndSincePerf = null;
      _pbWheelAccum = 0;
      _pbIsRewinding = false;
      _pbVelocity = _pbPlaybackSpeed * (map.getPlaybackSpeed() || 1.0);
      map._playbackLiveFollow = false;
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
  const pbDaySelectEl = document.getElementById("pbDaySelect");
  window._historicalState = null;  // Cached historical data when not "live"
  
  // Loading state tracking - shared between historical and snapshot loading
  let _isLoadingData = false;
  
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
    const pbSaveEl = document.getElementById("pbSave");
    if (pbSaveEl) {
      pbSaveEl.disabled = !canSaveSnapshot();
    }
  }
  
  function populateDaySelector() {
    if (!pbDaySelectEl) return;
    pbDaySelectEl.innerHTML = "";
    
    const now = new Date();
    const options = [];
    
    // Today (live)
    options.push({ value: "live", label: "Today (Live)" });
    
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
      const el = document.createElement("option");
      el.value = opt.value;
      el.textContent = opt.label;
      pbDaySelectEl.appendChild(el);
    }
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
      const resp = await fetch(`/api/history?date=${encodeURIComponent(dateStr)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const loadedState = await resp.json();
      
      // Validate the loaded data before using it
      if (!validateStateSchema(loadedState)) {
        throw new Error("Invalid data structure received from server");
      }
      
      window._historicalState = loadedState;
      
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
      
      // Start playback loop
      _pbLastPerf = 0;
      _pbLastUiPerf = 0;
      _pbRAF = requestAnimationFrame(playbackLoop);
    } catch (e) {
      console.error("Failed to load historical data:", e);
      if (statusEl) {
        statusEl.textContent = "Error loading history";
        statusEl.classList.add("offline");
      }
    } finally {
      _isLoadingData = false;
      updateSaveButtonState();
    }
  }
  
  if (pbDaySelectEl) {
    populateDaySelector();
    pbDaySelectEl.addEventListener("change", () => {
      loadHistoricalDay(pbDaySelectEl.value);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SAVE/LOAD: Persist and restore daily snapshots
  // ─────────────────────────────────────────────────────────────────────────────
  const pbSaveEl = document.getElementById("pbSave");
  const pbLoadEl = document.getElementById("pbLoad");

  function getSnapshotDateStr() {
    // Determine the date to use for saving based on the data being viewed
    // 1. If viewing a historical day via the day selector, use that date
    if (pbDaySelectEl && pbDaySelectEl.value && pbDaySelectEl.value !== "live") {
      return pbDaySelectEl.value;  // Already in YYYY-MM-DD format
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
    
    if (pbSaveEl) pbSaveEl.disabled = true;
    
    try {
      const resp = await fetch(`/api/snapshot/save?date=${encodeURIComponent(dateStr)}`, {
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
      const resp = await fetch("/api/snapshots");
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
      const resp = await fetch(`/api/snapshot/load?date=${encodeURIComponent(dateStr)}`);
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

  if (pbSaveEl) {
    pbSaveEl.addEventListener("click", saveSnapshot);
    // Initialize button state
    updateSaveButtonState();
  }
  if (pbLoadEl) {
    pbLoadEl.addEventListener("click", showLoadModal);
  }

  if (pbScrubEl) {
    const applyScrub = () => {
      const b = map.getPlaybackBounds();
      if (!isFinite(b.minMs) || !isFinite(b.maxMs) || !(b.maxMs > b.minMs)) return;
      const relMs = Number(pbScrubEl.value);
      if (!isFinite(relMs)) return;
      const tMs = b.minMs + relMs;
      map.setPlaybackTimeMs(clamp(tMs, b.minMs, b.maxMs));

      // Entering LIVE state ONLY when the slider is dragged all the way to the end.
      const maxMs = Number(pbScrubEl.max);
      // Use a more generous epsilon (1.5s) for "snapping" to live follow when dragging near the end.
      map._playbackLiveFollow = (isFinite(maxMs) && relMs >= maxMs - 1500);

      updatePlaybackUi();
      map.drawOverlay(map.lastState);
    };

    pbScrubEl.addEventListener("pointerdown", () => {
      // Cancel ALL physics immediately - user is taking control
      _pbVelocity = 0;
      _pbWheelAccum = 0;
      _pbAtEndSincePerf = null;
      _pbIsRewinding = false;
      _pbEaseStartPerf = null;
      _pbIsWheelCoasting = false;
      _pbScrubbing = true;
      _pbDidDrag = false; // track if user actually dragged
      _pbLastScrubPos = Number(pbScrubEl.value);
      _pbLastScrubTime = performance.now();
      map.setPlaybackPlaying(false);
      map._playbackLiveFollow = false; // exit live mode when user grabs slider
      updatePlaybackUi();
    });
    pbScrubEl.addEventListener("pointerup", () => {
      _pbScrubbing = false;
      _pbVelocity = 0;
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
      _pbIsRewinding = false;
      map.setPlaybackPlaying(false); // Let wheel nudge control velocity
      // Exit LIVE mode on scroll
      map._playbackLiveFollow = false;
      _pbIsWheelCoasting = true;
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
      map.drawOverlay(map.lastState);
    });
  }

  const POLL_MS = 2000;
  let _tickInFlight = false;

  async function tick() {
    if (_tickInFlight) return;
    
    // Skip live data fetching when viewing historical data
    // Playback loop handles all drawing in historical mode
    if (window._historicalState) {
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

    // Add static POI marker(s) using existing fixed-marker overlay rendering.
    st = injectCastleFixedMarker(st);

    window.__lastState = st;
    
    // Update save button now that we have data
    updateSaveButtonState();
    
    if (statusEl) {
      statusEl.textContent = "Live";
      statusEl.classList.remove("offline");
      statusEl.classList.add("live");
    }
    const bestMs = newestReadingMsFromState(st);
    if (bestMs != null) {
      document.getElementById("lastUpdated").textContent = new Date(bestMs).toLocaleTimeString();
    }

    try {

      // initial center: first mobile
      if (!map._centeredOnce) {
        const first = Array.isArray(st.mobile) ? st.mobile[0] : null;
        if (first && isFinite(Number(first.lat)) && isFinite(Number(first.lon))) {
          map.center = { lat: Number(first.lat), lon: Number(first.lon) };
          map._centeredOnce = true;
        }
      }

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

      // IMPORTANT: If DVR/trace is enabled, compute playback points + any playhead pinning
      // BEFORE drawing. Otherwise the UI/map can look "pegged to the start" until a RAF
      // redraw happens (which we now avoid when idle to save CPU).
      if (map.playbackMode) {
        const before = map.getPlaybackBounds();
        map._ensurePlaybackPoints(st);
        const after = map.getPlaybackBounds();
        const nextMax = (after.maxMs != null && isFinite(Number(after.maxMs))) ? Number(after.maxMs) : null;

        // LIVE follow-tail: always pin playhead to the end-of-data.
        // This avoids any "rewind" behavior on load or when new data arrives.
        if (!map._pbDrag && map._playbackLiveFollow && nextMax != null) {
          map.setPlaybackTimeMs(nextMax);
        } else if (map.getPlaybackTimeMs() == null && nextMax != null) {
          // One-time initialization when entering DVR: start at the end-of-data.
          map.setPlaybackTimeMs(nextMax);
        }
        // If user is not at end, do not auto-jump or auto-play.
      }

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
        try { updatePlaybackUi(); } catch {}
      }
      saveViewSoon();
    } catch (e) {
      // Rendering issues should not flip the connection status.
      try { console.error(e); } catch {}
    } finally {
      _tickInFlight = false;
    }
  }

  tick();
  setInterval(tick, POLL_MS);
}

main();


