// AQI color palette — must stay in sync with mobileair/aqi.py AQI_COLOR_PALETTE.
// Server sends integer indices; safeHex() expands them to hex strings.
const AQI_PALETTE = [
  "#cccccc",  // 0  unknown / no data
  "#00FFFF",  // 1  cyan    – Good (very low)
  "#00CCFF",  // 2  lt-blue – Good
  "#0099FF",  // 3  blue    – Good
  "#00E400",  // 4  green   – Good
  "#009900",  // 5  dk-green– O3 Good
  "#006600",  // 6  dkr-green–O3 Good
  "#FFFF00",  // 7  yellow  – Moderate
  "#FF7E00",  // 8  orange  – USG
  "#FF0000",  // 9  red     – Unhealthy
  "#8F3F97",  // 10 purple  – Very Unhealthy
  "#7E0023",  // 11 maroon  – Hazardous
];

function safeHex(c) {
  if (typeof c === "number") return AQI_PALETTE[c] || "#cccccc";
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

function outlierHex(hex) {
  // Slightly desaturate (~30%) for outlier markers.
  return desatHex(hex, 0.30);
}

function darkenHex(hex, factor = 0.75) {
  // Darken a hex color by multiplying RGB by factor (0 = black, 1 = original).
  const h = safeHex(hex);
  const m = /^#([0-9a-f]{6})$/i.exec(h);
  if (!m) return "#3388ff";
  const n = parseInt(m[1], 16);
  const r = Math.round(((n >> 16) & 255) * factor);
  const g = Math.round(((n >> 8) & 255) * factor);
  const b = Math.round((n & 255) * factor);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

function hexToRgba(hex, alpha = 1) {
  // Convert a hex color to rgba format with specified alpha (0-1).
  const h = safeHex(hex);
  const m = /^#([0-9a-f]{6})$/i.exec(h);
  if (!m) return `rgba(51, 136, 255, ${alpha})`;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
