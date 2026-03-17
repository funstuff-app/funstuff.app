/* MobileAir dashboard JS
 * - Fetches /api/state
 * - Renders a slippy-tile basemap on tilesCanvas
 * - Draws dotted breadcrumb trails + emoji vehicle markers on overlayCanvas
 *
 * No map library is used for overlay/projection; we do Web Mercator ourselves.
 */

var TILE_SIZE = 256;

// Basemap is fixed to CARTO Voyager.
var TILE_THEMES = {
  // carto_voyager: {
  //   label: "CARTO Voyager",
  //   template: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
  //   subdomains: ["a", "b", "c", "d"],
  //   filter: { saturate: 0.55, brightness: 0.72, contrast: 1.12 },
  //   defaultDim: 25,
  //   bgColor: "#c4c0b8",
  // },
  carto_dark_all: {
    label: "CARTO Dark (all)",
    template: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
    subdomains: ["a", "b", "c", "d"],
    filter: { saturate: 1.45, brightness: 0.80, contrast: 1.08 },
    defaultDim: 101,
    defaultSat: 118,
    bgColor: "#282828", // CARTO Dark Matter background
  },
  carto_dark_nolabels: {
    label: "CARTO Dark (no labels)",
    template: "https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png",
    subdomains: ["a", "b", "c", "d"],
    filter: { saturate: 0.90, brightness: 0.95, contrast: 1.06 },
    defaultDim: 101,
    defaultSat: 118,
    bgColor: "#282828",
  },
  // carto_positron_all: {
  //   label: "CARTO Positron (all)",
  //   template: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
  //   subdomains: ["a", "b", "c", "d"],
  //   filter: { saturate: 0.55, brightness: 0.72, contrast: 1.12 },
  //   defaultDim: 25,
  //   bgColor: "#a8a8a6",
  // },
  // carto_positron_nolabels: {
  //   label: "CARTO Positron (no labels)",
  //   template: "https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png",
  //   subdomains: ["a", "b", "c", "d"],
  //   filter: { saturate: 0.55, brightness: 0.72, contrast: 1.12 },
  //   defaultDim: 25,
  //   bgColor: "#a8a8a6",
  // },
  // osm: {
  //   label: "OSM Standard",
  //   template: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  //   subdomains: [""],
  //   filter: { saturate: 0.55, brightness: 0.72, contrast: 1.12 },
  //   defaultDim: 25,
  //   bgColor: "#b5b2ab",
  // },
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

      // Apply server-pushed localStorage defaults.
      // Only writes keys prefixed with "mobileair." (app namespace).
      // Each key is written at most once per config version — tracked by
      // storing the version that last wrote each key. If the user later
      // changes the value (via slider, etc.), the next deploy with the
      // SAME configVersion won't overwrite it. Bump configVersion to push
      // a new value.
      const lsOverrides = cfg.localStorage;
      const cfgVer = cfg.configVersion;
      if (lsOverrides && typeof lsOverrides === "object" && cfgVer != null) {
        for (const [k, v] of Object.entries(lsOverrides)) {
          if (typeof k !== "string" || !k.startsWith("mobileair.")) continue;
          const verKey = k + ".__cfgv";
          const appliedVer = localStorage.getItem(verKey);
          if (appliedVer === String(cfgVer)) continue; // already applied this version
          localStorage.setItem(k, String(v));
          localStorage.setItem(verKey, String(cfgVer));
        }
      }
    }
  } catch (e) {
    console.warn("[Config] Using defaults, server config unavailable:", e.message);
  }
}

var THEME_STORAGE_KEY_DARK = "mobileair.mapTheme.dark";
var THEME_STORAGE_KEY_LIGHT = "mobileair.mapTheme.light";
var DIM_STORAGE_PREFIX = "mobileair.mapDim."; // per theme (0..100)
var SAT_STORAGE_PREFIX = "mobileair.mapSat."; // per theme (0..150 => saturate factor = v/100)
var VIEW_STORAGE_KEY = "mobileair.mapView"; // {lat, lon, zoom}
var TRACE_STORAGE_KEY = "mobileair.traceMode"; // "1" or "0"
var LIVE_MODE_STORAGE_KEY = "mobileair.liveFollow"; // "1" = LIVE follow mode
var MAX_TRAIL_LEN = 1000;

function applyMapFilterVars({ saturate, brightness, contrast, shadowLift }) {
  const root = document.documentElement;
  if (!root) return;
  if (typeof saturate === "number") root.style.setProperty("--map-saturate", String(saturate));
  if (typeof brightness === "number") root.style.setProperty("--map-brightness", String(brightness));
  if (typeof contrast === "number") root.style.setProperty("--map-contrast", String(contrast));
  if (typeof shadowLift === "number") root.style.setProperty("--map-shadow-lift", String(shadowLift));
}
