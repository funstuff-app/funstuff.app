// Owner token: read from URL hash (#tok=...) and persist in localStorage.
// On load, POST to /api/auth to set an HttpOnly cookie so the token is never
// exposed in URLs, logs, or Referer headers.  All subsequent fetches send the
// cookie automatically.
const _ownerTok = (() => {
  const KEY = "dusty_owner_tok";
  const hash = location.hash || "";
  const m = hash.match(/tok=([^&]+)/);
  if (m) {
    localStorage.setItem(KEY, m[1]);
    // Remove token from hash to keep URL clean
    history.replaceState(null, "", location.pathname + location.search);
    return m[1];
  }
  return localStorage.getItem(KEY) || "";
})();

/** Exchange the owner token for an HttpOnly auth cookie. */
const _authReady = (async () => {
  if (!_ownerTok) return;
  try {
    await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: _ownerTok }),
      credentials: "same-origin",
    });
  } catch (_) { /* server may not support it yet — silent fallback */ }
})();

// ── iOS orientation class toggling ──────────────────────────────────────
// Safari doesn't reliably re-evaluate nested @media inside @supports on
// viewport changes (toolbar show/hide). Use JS to toggle classes instead.
// Multiple detection paths: CSS.supports fails in PWA standalone, UA may
// omit device name on iPad, so also check navigator.standalone + touch.
(() => {
  const isIOS = CSS.supports("-webkit-touch-callout", "none")
    || /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.standalone !== undefined && navigator.maxTouchPoints > 1)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (!isIOS) return;
  document.documentElement.classList.add("ios");
  const mql = window.matchMedia("(orientation: landscape)");
  function applyOrientation(e) {
    document.documentElement.classList.toggle("ios-landscape", e.matches);
    if (e.matches) document.documentElement.classList.add("ios-was-landscape");
  }
  applyOrientation(mql);
  mql.addEventListener("change", applyOrientation);
})();

// ── Prefs sync ──────────────────────────────────────────────────────────────
// Collects all owner-namespaced localStorage keys and POSTs them to the
// server on page hide/unload. The server appends each entry as an NDJSON
// line to prefs_log.ndjson — a replay-able history of UI state over time.
// Only fires when the owner token is present; zero bytes sent otherwise.
function _syncPrefsToServer() {
  if (!_ownerTok) return;
  const prefs = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && (k.startsWith("dusty_") || k.startsWith("mobileair."))) {
      prefs[k] = localStorage.getItem(k);
    }
  }
  const payload = JSON.stringify({ client_ts: Date.now(), prefs });
  // Use fetch+keepalive instead of sendBeacon so the HttpOnly auth cookie is
  // sent automatically.  keepalive lets the request survive page unload.
  fetch("/api/prefs/sync", {
    method: "POST",
    body: payload,
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    keepalive: true,
  }).catch(() => {});
}

// visibilitychange covers tab switches, window minimize, and most close gestures.
// pagehide is the reliable iOS Safari / bfcache signal.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") _syncPrefsToServer();
});
window.addEventListener("pagehide", _syncPrefsToServer);

// ── View sync (all visitors) ────────────────────────────────────────────
// Every visitor gets a stable random client ID and syncs their map position
// to /api/view/sync on page hide. No auth required.
const _clientId = (() => {
  const KEY = "dusty_cid";
  let cid = localStorage.getItem(KEY);
  if (!cid) {
    cid = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
    localStorage.setItem(KEY, cid);
  }
  return cid;
})();

function _syncViewToServer() {
  if (_ownerTok) return; // owner's view is not logged
  const raw = localStorage.getItem("mobileair.mapView");
  if (!raw) return;
  let v;
  try { v = JSON.parse(raw); } catch { return; }
  const lat = Number(v.lat), lon = Number(v.lon), zoom = Number(v.zoom);
  if (!isFinite(lat) || !isFinite(lon) || !isFinite(zoom)) return;
  const payload = JSON.stringify({ client_id: _clientId, lat, lon, zoom });
  fetch("/api/view/sync", {
    method: "POST",
    body: payload,
    headers: { "Content-Type": "application/json" },
    keepalive: true,
  }).catch(() => {});
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") _syncViewToServer();
});
window.addEventListener("pagehide", _syncViewToServer);

// ETag for conditional polling — avoids re-downloading unchanged payloads.
let _stateEtag = null;
let _stateCached = null;

// Delta delivery: track newest trail timestamp so subsequent polls
// only receive new trail points (the server strips old ones via ?since_ms=).
let _newestTrailMs = null;
// Accumulated full state (trails grow across polls).
let _accumulatedState = null;

/** Extract the newest trail timestamp (epoch ms) from a state object. */
function _extractNewestTrailMs(st) {
  let best = null;
  const mobiles = Array.isArray(st?.mobile) ? st.mobile : [];
  for (const m of mobiles) {
    const trail = Array.isArray(m?.trail) ? m.trail : [];
    for (let i = trail.length - 1; i >= 0; i--) {
      const t = trail[i]?.t;
      if (typeof t === "string") {
        const ms = parseUtcMs(t);
        if (ms != null && (best == null || ms > best)) { best = ms; break; }
      }
    }
  }
  return best;
}

/** Merge a delta state into the accumulated state.
 *  - Mobile trails: append new points to existing vehicles.
 *  - Fixed sensors / meta: replace entirely (always current).
 */
function _mergeStateDelta(acc, delta) {
  // Replace top-level fields the server always sends in full.
  acc.ts = delta.ts;
  acc.meta = delta.meta;
  acc.fixed = delta.fixed;

  // Merge mobile trails.
  const deltaM = Array.isArray(delta.mobile) ? delta.mobile : [];
  const accById = new Map();
  const accMobiles = Array.isArray(acc.mobile) ? acc.mobile : [];
  for (const m of accMobiles) {
    if (m && m.id != null) accById.set(String(m.id), m);
  }

  for (const dm of deltaM) {
    if (!dm || dm.id == null) continue;
    const id = String(dm.id);
    const existing = accById.get(id);
    if (!existing) {
      // New vehicle — add as-is.
      accMobiles.push(dm);
      accById.set(id, dm);
      continue;
    }
    // Append new trail points, capping to prevent unbounded growth.
    const newPts = Array.isArray(dm.trail) ? dm.trail : [];
    if (newPts.length > 0) {
      const oldTrail = Array.isArray(existing.trail) ? existing.trail : [];
      const merged = oldTrail.concat(newPts);
      const cap = (typeof MAX_TRAIL_LEN === "number" && MAX_TRAIL_LEN > 0) ? MAX_TRAIL_LEN : 3000;
      existing.trail = merged.length > cap ? merged.slice(merged.length - cap) : merged;
    }
    // Update non-trail fields (readings, ghosted, color, etc.)
    for (const k of Object.keys(dm)) {
      if (k !== "trail" && k !== "id") existing[k] = dm[k];
    }
  }

  // Remove vehicles that disappeared from the server response.
  const deltaIds = new Set(deltaM.map(m => m && m.id != null ? String(m.id) : null).filter(Boolean));
  acc.mobile = accMobiles.filter(m => m && m.id != null && deltaIds.has(String(m.id)));

  return acc;
}

async function fetchState() {
  let url = `${appConfig.apiBaseUrl}/state`;
  // Delta delivery: ask the server to strip trail points we already have.
  if (_newestTrailMs != null) {
    const sep = url.includes("?") ? "&" : "?";
    url = `${url}${sep}since_ms=${_newestTrailMs}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000); // 15s timeout
  try {
    const headers = {};
    if (_stateEtag) headers["If-None-Match"] = _stateEtag;
    const res = await fetch(url, { cache: "no-store", signal: controller.signal, headers, credentials: "same-origin" });
    if (res.status === 304 && _accumulatedState) return _accumulatedState;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    _stateEtag = res.headers.get("ETag") || null;
    const payload = await res.json();

    // Merge or replace accumulated state.
    if (payload.meta?.delta && _accumulatedState) {
      _mergeStateDelta(_accumulatedState, payload);
    } else {
      // First fetch or full payload — replace entirely.
      _accumulatedState = payload;
    }

    // Track newest trail timestamp for next delta request.
    const nms = _extractNewestTrailMs(_accumulatedState);
    if (nms != null) _newestTrailMs = nms;

    _stateCached = _accumulatedState;
    return _accumulatedState;
  } finally {
    clearTimeout(timer);
  }
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
  const paField = document.getElementById("paFieldCanvas");
  const overlay = document.getElementById("overlayCanvas");
  const map = new MapView(tiles, paField, overlay);
  window.__map = map;  // Expose for updateSidebarPlaybackValues

  // Lite mode: hide all chrome (sidebar, controls, legend, menu button)
  const _liteParam = new URLSearchParams(window.location.search).get('lite') === '1';
  if (_liteParam) {
    document.body.classList.add('lite');
  }

  // Force repaint of fixed elements on bfcache restore (fixes footer jumping to top on alt-tab)
  window.addEventListener('pageshow', function(e) {
    if (e.persisted) {
      var footer = document.getElementById('appFooter');
      if (footer) { footer.style.display = 'none'; footer.offsetHeight; footer.style.display = ''; }
    }
  });

  let selectedId = null; // key: "mobile:ID" or "fixed:ID"

  const TAB_STORAGE_KEY = "mobileair.sidebarTab";
  const SIDEBAR_OPEN_KEY = "mobileair.sidebarOpen";
  const SHOW_MOBILE_KEY = "mobileair.showMobile";
  const SHOW_FIXED_KEY = "mobileair.showFixed";
  const SHOW_PUBLIC_KEY = "mobileair.showPublic";
  // Labels are now per-type; keep legacy key as a migration fallback.
  const SHOW_LABELS_LEGACY_KEY = "mobileair.showLabels";
  const SHOW_MOBILE_LABELS_KEY = "mobileair.showMobileLabels";
  const SHOW_FIXED_LABELS_KEY = "mobileair.showFixedLabels";
  const SHOW_PUBLIC_LABELS_KEY = "mobileair.showPublicLabels";
  const tabMobileEl = document.getElementById("tabMobile");
  const tabFixedEl = document.getElementById("tabFixed");
  const tabPublicEl = document.getElementById("tabPublic");
  const tabLabelsEl = document.getElementById("tabLabels");
  const listMobileEl = document.getElementById("sensorListMobile");
  const listFixedEl = document.getElementById("sensorListFixed");
  const listPublicEl = document.getElementById("sensorListPublic");
  const sidebarEl = document.getElementById("sidebar");
  const menuBtnEl = document.getElementById("menuBtn");
  const sidebarCloseEl = document.getElementById("sidebarClose");
  
  const validTabs = ["mobile", "fixed", "public"];
  const savedTab = localStorage.getItem(TAB_STORAGE_KEY);
  let activeTab = validTabs.includes(savedTab) ? savedTab : "mobile";
  // On mobile / narrow screens, default sidebar closed to reduce clutter.
  const _isMobileWidth = window.innerWidth <= 768;
  let sidebarOpen = _isMobileWidth
    ? false
    : localStorage.getItem(SIDEBAR_OPEN_KEY) === "true"; // Default closed
  
  // Restore visibility states
  map.showMobile = localStorage.getItem(SHOW_MOBILE_KEY) !== "false";
  map.showFixed = localStorage.getItem(SHOW_FIXED_KEY) !== "false";
  map.showPublic = localStorage.getItem(SHOW_PUBLIC_KEY) !== "false";
  const legacyShowLabels = localStorage.getItem(SHOW_LABELS_LEGACY_KEY);
  // Mobile labels default OFF, fixed labels default ON
  map.showMobileLabels = localStorage.getItem(SHOW_MOBILE_LABELS_KEY) === "true";
  map.showFixedLabels = localStorage.getItem(SHOW_FIXED_LABELS_KEY) === "true";
  // PurpleAir (public) labels always start OFF — too noisy on a crowded map.
  // Users can toggle them on via the sidebar; that preference is not persisted.
  map.showPublicLabels = false;

  function updateSidebarVisibility() {
    if (sidebarEl) sidebarEl.classList.toggle("hidden", !sidebarOpen);
    localStorage.setItem(SIDEBAR_OPEN_KEY, sidebarOpen ? "true" : "false");
  }
  
  function toggleSidebar() {
    sidebarOpen = !sidebarOpen;
    updateSidebarVisibility();
  }

  function applySidebarTab() {
    const labelsOn = activeTab === "mobile" ? map.showMobileLabels
      : activeTab === "public" ? map.showPublicLabels
      : map.showFixedLabels;
    // "active" = which list is shown in sidebar
    // "disabled" = markers hidden on map (dimmed look)
    if (tabMobileEl) {
      tabMobileEl.classList.toggle("active", activeTab === "mobile");
      tabMobileEl.classList.toggle("disabled", !map.showMobile);
      tabMobileEl.setAttribute("aria-selected", activeTab === "mobile" ? "true" : "false");
    }
    if (tabFixedEl) {
      tabFixedEl.classList.toggle("active", activeTab === "fixed");
      tabFixedEl.classList.toggle("disabled", !map.showFixed);
      tabFixedEl.setAttribute("aria-selected", activeTab === "fixed" ? "true" : "false");
    }
    if (tabPublicEl) {
      tabPublicEl.classList.toggle("active", activeTab === "public");
      tabPublicEl.classList.toggle("disabled", !map.showPublic);
      tabPublicEl.setAttribute("aria-selected", activeTab === "public" ? "true" : "false");
    }
    if (tabLabelsEl) {
      tabLabelsEl.classList.toggle("active", labelsOn);
      tabLabelsEl.classList.toggle("disabled", !labelsOn);
    }
    if (listMobileEl) listMobileEl.classList.toggle("hidden", activeTab !== "mobile");
    if (listFixedEl) listFixedEl.classList.toggle("hidden", activeTab !== "fixed");
    if (listPublicEl) listPublicEl.classList.toggle("hidden", activeTab !== "public");
    localStorage.setItem(TAB_STORAGE_KEY, activeTab === "public" ? "mobile" : activeTab);
    localStorage.setItem(SHOW_MOBILE_KEY, map.showMobile ? "true" : "false");
    localStorage.setItem(SHOW_FIXED_KEY, map.showFixed ? "true" : "false");
    localStorage.setItem(SHOW_PUBLIC_KEY, map.showPublic ? "true" : "false");
    localStorage.setItem(SHOW_MOBILE_LABELS_KEY, map.showMobileLabels ? "true" : "false");
    localStorage.setItem(SHOW_FIXED_LABELS_KEY, map.showFixedLabels ? "true" : "false");
    localStorage.setItem(SHOW_PUBLIC_LABELS_KEY, map.showPublicLabels ? "true" : "false");
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

  // ── Color legend panel ──────────────────────────────────────────
  const legendEl = document.getElementById("legend");
  const legendCloseEl = document.getElementById("legendClose");
  const legendToggleEl = document.getElementById("legendToggle");
  const legendBodyEl = document.getElementById("legendBody");
  const legendUnitEl = document.getElementById("legendUnit");
  const LEGEND_OPEN_KEY = "dusty_legend_open";
  const LEGEND_TAB_KEY = "dusty_legend_tab";
  let legendOpen = _isMobileWidth
    ? false
    : localStorage.getItem(LEGEND_OPEN_KEY) === "true";
  let legendTab = "pm25";
  let userLegendTab = "pm25"; // what the user manually chose (restored on deselect)
  let legendUserOverride = false; // true when user manually changed tab while marker selected
  let _legendAutoOpenedOnce = legendOpen; // skip auto-open if user already kept legend open

  /** Map a pollutant key (PM25, PM10, OZNE, O3, etc.) to a legend tab id. */
  function pollutantToLegendTab(key) {
    if (!key) return null;
    const k = key.toUpperCase();
    if (k === "PM25" || k === "PM2.5") return "pm25";
    if (k === "PM10") return "pm10";
    if (k === "OZNE" || k === "OZONE" || k === "O3") return "o3";
    if (k === "NO2") return "no2";
    if (k === "CO") return "co";
    return null;
  }

  /** Switch legend tab to match a selected sensor's primary reading. */
  function syncLegendToSensor(sensor) {
    if (!sensor) return;
    const pr = primaryReadingForSensor(sensor);
    const tab = pollutantToLegendTab(pr && pr.key);
    if (tab && tab !== legendTab && LEGEND_DATA[tab]) {
      legendTab = tab;
      buildLegend(true);
      _syncPaFieldDim();
    }
  }

  /** Sync legend tab to whatever pollutant the map is currently showing on the selected marker. */
  function syncLegendToMapSelection() {
    if (!map || !selectedId || legendUserOverride) return;
    const key = map.getSelectedPollutantKey();
    const tab = pollutantToLegendTab(key);
    if (tab && tab !== legendTab && LEGEND_DATA[tab]) {
      legendTab = tab;
      buildLegend(true);
      _syncPaFieldDim();
    }
  }

  /** Revert legend tab to the user's manual choice. */
  function revertLegendTab() {
    if (legendTab !== userLegendTab && LEGEND_DATA[userLegendTab]) {
      legendTab = userLegendTab;
      buildLegend(true);
      _syncPaFieldDim();
    }
  }

  const LEGEND_DATA = {
    pm25: {
      unit: "\u00b5g/m\u00b3",
      // EPA AQI standard – colors match server _get_aqi_color
      // Sub-gradients within Good match Utah AQ API trail colors
      // EPA 2024 PM2.5 (24-hr) breakpoints with clean sub-gradients within Good.
      // Good: 0–9.0, Moderate: 9.1–35.4, USG: 35.5–55.4, Unhealthy: 55.5–125.4,
      // V.Unhealthy: 125.5–225.4, Hazardous: 225.5+
      entries: [
        { color: "#00FFFF", lo: 0,   hi: 2,   w: 12 },
        { color: "#00CCFF", lo: 2,   hi: 5,   w: 12 },
        { color: "#00E400", lo: 5,   hi: 9,   w: 12,  label: "Good" },
        { color: "#FFFF00", lo: 9,   hi: 35,  w: 18,  label: "Moderate" },
        { color: "#FF7E00", lo: 35,  hi: 55,  w: 29,  label: "Sensitive Groups" },
        { color: "#FF0000", lo: 55,  hi: 125, w: 65,  label: "Unhealthy" },
        { color: "#8F3F97", lo: 125, hi: 225, w: 117, label: "Very Unhealthy" },
        { color: "#7E0023", lo: 225, hi: null, w: 260, label: "Hazardous" },
      ],
    },
    pm10: {
      unit: "\u00b5g/m\u00b3",
      // Pill widths proportional to concentration within PM10's own scale
      // (~600 µg/m³ max, 260px). PM10 harm rises more steadily than PM2.5.
      entries: [
        { color: "#00FFFF", lo: 0,   hi: 15,  w: 12 },
        { color: "#00CCFF", lo: 15,  hi: 30,  w: 13 },
        { color: "#0099FF", lo: 30,  hi: 40,  w: 17 },
        { color: "#00E400", lo: 40,  hi: 54,  w: 23,  label: "Good" },
        { color: "#FFFF00", lo: 54,  hi: 154, w: 66,  label: "Moderate" },
        { color: "#FF7E00", lo: 154, hi: 254, w: 110, label: "Sensitive Groups" },
        { color: "#FF0000", lo: 254, hi: 354, w: 153, label: "Unhealthy" },
        { color: "#8F3F97", lo: 354, hi: 424, w: 183, label: "Very Unhealthy" },
        { color: "#7E0023", lo: 424, hi: null, w: 260, label: "Hazardous" },
      ],
    },
    o3: {
      unit: "ppb",
      entries: [
        // Pill widths proportional to concentration within O3's own scale
        // (~400 ppb max, 260px). Ozone climbs gradually then jumps.
        { color: "#00CCFF", lo: 0,   hi: 15,  w: 12 },
        { color: "#0099FF", lo: 15,  hi: 25,  w: 16 },
        { color: "#009900", lo: 25,  hi: 35,  w: 23 },
        { color: "#006600", lo: 35,  hi: 54,  w: 35,  label: "Good" },
        { color: "#FFFF00", lo: 54,  hi: 70,  w: 46,  label: "Moderate" },
        { color: "#FF7E00", lo: 70,  hi: 85,  w: 55,  label: "Sensitive Groups" },
        { color: "#FF0000", lo: 85,  hi: 105, w: 68,  label: "Unhealthy" },
        { color: "#8F3F97", lo: 105, hi: 200, w: 130, label: "Very Unhealthy" },
        { color: "#7E0023", lo: 200, hi: null, w: 260, label: "Hazardous" },
      ],
    },
    no2: {
      unit: "ppb",
      // EPA NO2 1-hour breakpoints (ppb).
      // Good: 0–53, Moderate: 54–100, USG: 101–360, Unhealthy: 361–649,
      // V.Unhealthy: 650–1249, Hazardous: 1250+
      entries: [
        { color: "#00CCFF", lo: 0,   hi: 20,  w: 12 },
        { color: "#0099FF", lo: 20,  hi: 35,  w: 15 },
        { color: "#00E400", lo: 35,  hi: 53,  w: 21,  label: "Good" },
        { color: "#FFFF00", lo: 53,  hi: 100, w: 35,  label: "Moderate" },
        { color: "#FF7E00", lo: 100, hi: 360, w: 75,  label: "Sensitive Groups" },
        { color: "#FF0000", lo: 360, hi: 649, w: 130, label: "Unhealthy" },
        { color: "#8F3F97", lo: 649, hi: 1249, w: 195, label: "Very Unhealthy" },
        { color: "#7E0023", lo: 1249, hi: null, w: 260, label: "Hazardous" },
      ],
    },
    co: {
      unit: "ppm",
      // EPA CO 8-hour breakpoints (ppm).
      // Good: 0–4.4, Moderate: 4.5–9.4, USG: 9.5–12.4, Unhealthy: 12.5–15.4,
      // V.Unhealthy: 15.5–30.4, Hazardous: 30.5+
      entries: [
        { color: "#00CCFF", lo: 0,    hi: 1.5,  w: 12 },
        { color: "#0099FF", lo: 1.5,  hi: 3.0,  w: 15 },
        { color: "#00E400", lo: 3.0,  hi: 4.4,  w: 21,  label: "Good" },
        { color: "#FFFF00", lo: 4.4,  hi: 9.4,  w: 46,  label: "Moderate" },
        { color: "#FF7E00", lo: 9.4,  hi: 12.4, w: 60,  label: "Sensitive Groups" },
        { color: "#FF0000", lo: 12.4, hi: 15.4, w: 75,  label: "Unhealthy" },
        { color: "#8F3F97", lo: 15.4, hi: 30.4, w: 148, label: "Very Unhealthy" },
        { color: "#7E0023", lo: 30.4, hi: null,  w: 260, label: "Hazardous" },
      ],
    },
  };

  // Track live row DOM nodes for tweening between pollutant tabs.
  let _legendRows = [];       // current row elements in the DOM
  let _legendEntryCount = 0;  // how many entries the current legend has
  const LEGEND_TWEEN_MS = 300;

  function _buildBracketInfo(entries) {
    const catAssign = new Array(entries.length).fill("");
    let currentCat = "";
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].label) currentCat = entries[i].label;
      catAssign[i] = currentCat;
    }
    const dimGroups = [];
    let groupStart = 0;
    for (let i = 0; i < entries.length; i++) {
      if (i === entries.length - 1 || catAssign[i] !== catAssign[i + 1]) {
        if (catAssign[i]) dimGroups.push({ name: catAssign[i], startIdx: groupStart, endIdx: i });
        groupStart = i + 1;
      }
    }
    return { catAssign, dimGroups };
  }

  function _makeBracketHtml(i, dimGroups) {
    const g = dimGroups.find(g => i >= g.startIdx && i <= g.endIdx);
    if (!g) return `<div class="legendBracket"></div>`;
    const isFirst = (i === g.startIdx), isLast = (i === g.endIdx), isOnly = (g.startIdx === g.endIdx);
    let cls = "legendBracket";
    if (isOnly) cls += " legendBracketOnly";
    else if (isFirst) cls += " legendBracketTop";
    else if (isLast) cls += " legendBracketBot";
    else cls += " legendBracketMid";
    const midIdx = Math.floor((g.startIdx + g.endIdx) / 2);
    const lbl = (i === midIdx) ? `<span class="legendCatLabel">${g.name}</span>` : "";
    return `<div class="${cls}">${lbl}</div>`;
  }

  function _createLegendRow(entry, idx, dimGroups, useDecimal) {
    const fmt = (v) => (useDecimal && v != null) ? Number(v).toFixed(1) : `${v}`;
    const e = entry;
    const loText = e.hi != null ? fmt(e.lo) : `${fmt(e.lo)}+`;
    const hiText = e.hi != null ? fmt(e.hi) : "";
    const row = document.createElement("div");
    row.className = "legendRow";
    const pillHtml = `<div class="legendPill" style="width:${e.w}px;background:${e.color};border-color:${darkenHex(e.color,0.55)}"></div>`;
    const rangeInner = `<span class="legendLo">${loText}</span>` +
      (hiText ? `<span class="legendDash">\u2013</span><span class="legendHi">${hiText}</span>` : ``);
    const leftZone = `<div class="legendLeftZone">${pillHtml}</div><div class="legendRange"><div class="legendRangeBg">${rangeInner}</div></div>`;
    row.innerHTML = leftZone + _makeBracketHtml(idx, dimGroups);
    return row;
  }

  function _updateRowContent(row, entry, idx, dimGroups, useDecimal) {
    const fmt = (v) => (useDecimal && v != null) ? Number(v).toFixed(1) : `${v}`;
    const e = entry;
    // Tween the pill bar (CSS transition handles the back-in curve)
    const pill = row.querySelector(".legendPill");
    if (pill) {
      pill.style.width = `${e.w}px`;
      pill.style.background = e.color;
      pill.style.borderColor = darkenHex(e.color, 0.55);
    }
    // True crossfade for range text: clone old, stack it, fade old out + new in simultaneously
    const rangeEl = row.querySelector(".legendRange");
    if (rangeEl) {
      const oldBg = rangeEl.querySelector(".legendRangeBg");
      if (oldBg) {
        const loText = e.hi != null ? fmt(e.lo) : `${fmt(e.lo)}+`;
        const hiText = e.hi != null ? fmt(e.hi) : "";
        const newInner = `<span class="legendLo">${loText}</span>` +
          (hiText ? `<span class="legendDash">\u2013</span><span class="legendHi">${hiText}</span>` : ``);
        // Skip if text unchanged
        if (oldBg.innerHTML !== newInner) {
          // Clone old text as a fading-out ghost
          const ghost = oldBg.cloneNode(true);
          ghost.style.cssText = "position:absolute;top:0;left:0;right:0;opacity:1;transition:opacity 0.2s ease-out;pointer-events:none;";
          rangeEl.style.position = "relative";
          rangeEl.appendChild(ghost);
          // Set new text immediately, start invisible
          oldBg.innerHTML = newInner;
          oldBg.style.opacity = "0";
          oldBg.style.transition = "opacity 0.2s ease-out";
          // Crossfade: old ghost fades out, new fades in
          requestAnimationFrame(() => {
            ghost.style.opacity = "0";
            oldBg.style.opacity = "1";
          });
          // Clean up ghost after transition
          setTimeout(() => { if (ghost.parentNode) ghost.parentNode.removeChild(ghost); }, 220);
        }
      }
    }
    // Crossfade bracket labels the same way
    const oldBracket = row.querySelector(".legendBracket");
    if (oldBracket) {
      const newHtml = _makeBracketHtml(idx, dimGroups);
      if (oldBracket.outerHTML !== newHtml) {
        const ghost = oldBracket.cloneNode(true);
        ghost.style.cssText += ";position:absolute;right:0;top:0;bottom:0;opacity:1;transition:opacity 0.2s ease-out;pointer-events:none;";
        oldBracket.parentNode.insertBefore(ghost, oldBracket.nextSibling);
        oldBracket.outerHTML = newHtml;
        const newBracket = row.querySelector(".legendBracket");
        if (newBracket) {
          newBracket.style.opacity = "0";
          newBracket.style.transition = "opacity 0.2s ease-out";
          requestAnimationFrame(() => {
            ghost.style.opacity = "0";
            newBracket.style.opacity = "1";
          });
        }
        setTimeout(() => { if (ghost.parentNode) ghost.parentNode.removeChild(ghost); }, 220);
      }
    }
  }

  /** Instant (no-transition) update of a legend row — sets properties directly, no ghosts. */
  function _updateRowInstant(row, entry, idx, dimGroups, useDecimal) {
    const fmt = (v) => (useDecimal && v != null) ? Number(v).toFixed(1) : `${v}`;
    const e = entry;
    const pill = row.querySelector(".legendPill");
    if (pill) {
      pill.style.width = `${e.w}px`;
      pill.style.background = e.color;
      pill.style.borderColor = darkenHex(e.color, 0.55);
    }
    const rangeEl = row.querySelector(".legendRange");
    if (rangeEl) {
      const bg = rangeEl.querySelector(".legendRangeBg");
      if (bg) {
        const loText = e.hi != null ? fmt(e.lo) : `${fmt(e.lo)}+`;
        const hiText = e.hi != null ? fmt(e.hi) : "";
        bg.innerHTML = `<span class="legendLo">${loText}</span>` +
          (hiText ? `<span class="legendDash">\u2013</span><span class="legendHi">${hiText}</span>` : ``);
        bg.style.opacity = "1";
      }
    }
    const oldBracket = row.querySelector(".legendBracket");
    if (oldBracket) {
      const newHtml = _makeBracketHtml(idx, dimGroups);
      if (oldBracket.outerHTML !== newHtml) {
        oldBracket.outerHTML = newHtml;
      }
    }
  }

  function buildLegend(animate = false) {
    if (!legendBodyEl) return;
    const data = LEGEND_DATA[legendTab] || LEGEND_DATA.pm25;
    if (legendUnitEl) legendUnitEl.textContent = data.unit;

    const entries = data.entries;
    const { dimGroups } = _buildBracketInfo(entries);
    const useDecimal = entries.some(e =>
      (e.lo != null && e.lo % 1 !== 0) || (e.hi != null && e.hi % 1 !== 0)
    );

    const oldCount = _legendEntryCount;
    const newCount = entries.length;
    const commonCount = Math.min(oldCount, newCount);

    // First render: full build (no existing DOM to tween from)
    if (oldCount === 0 || _legendRows.length === 0) {
      legendBodyEl.innerHTML = "";
      _legendRows = [];
      for (let i = 0; i < newCount; i++) {
        const row = _createLegendRow(entries[i], i, dimGroups, useDecimal);
        legendBodyEl.appendChild(row);
        _legendRows.push(row);
      }
      _legendEntryCount = newCount;
      const tabs = legendEl ? legendEl.querySelectorAll(".legendTab") : [];
      for (const t of tabs) t.classList.toggle("active", t.dataset.legend === legendTab);
      return;
    }

    // ── Update existing DOM in place (always — never tear down) ──

    // When not animating, suppress CSS transitions so changes are instant
    if (!animate) {
      legendBodyEl.classList.add("legend-no-transition");
    }

    // Tween (or instant-set) existing rows: bar width/color + text
    for (let i = 0; i < commonCount; i++) {
      if (animate) {
        _updateRowContent(_legendRows[i], entries[i], i, dimGroups, useDecimal);
      } else {
        // Instant: set properties directly, no crossfade ghosts
        _updateRowInstant(_legendRows[i], entries[i], i, dimGroups, useDecimal);
      }
    }

    // Remove excess rows
    if (oldCount > newCount) {
      for (let i = newCount; i < oldCount; i++) {
        const row = _legendRows[i];
        if (animate) {
          row.classList.add("leaving");
          setTimeout(() => { if (row.parentNode) row.parentNode.removeChild(row); }, LEGEND_TWEEN_MS);
        } else {
          if (row.parentNode) row.parentNode.removeChild(row);
        }
      }
      _legendRows.length = newCount;
    }

    // Add new rows
    if (newCount > oldCount) {
      for (let i = oldCount; i < newCount; i++) {
        const row = _createLegendRow(entries[i], i, dimGroups, useDecimal);
        if (animate) row.classList.add("entering");
        legendBodyEl.appendChild(row);
        _legendRows.push(row);
        if (animate) requestAnimationFrame(() => { row.classList.remove("entering"); });
      }
    }

    _legendEntryCount = newCount;
    const tabs = legendEl ? legendEl.querySelectorAll(".legendTab") : [];
    for (const t of tabs) t.classList.toggle("active", t.dataset.legend === legendTab);

    // Re-enable transitions after instant update completes
    if (!animate) {
      // Use rAF to ensure the browser has painted the instant values
      // before re-enabling transitions
      requestAnimationFrame(() => {
        legendBodyEl.classList.remove("legend-no-transition");
      });
    }
  }

  function updateLegendVisibility() {
    if (legendEl) legendEl.classList.toggle("hidden", !legendOpen);
    if (legendToggleEl) legendToggleEl.classList.toggle("hidden", legendOpen);
    localStorage.setItem(LEGEND_OPEN_KEY, legendOpen ? "true" : "false");
  }

  /** Sync PA field pollutant to match legend tab selection. */
  function _syncPaFieldDim() {
    if (!map) return;
    // Switch field to show the selected pollutant (with correct sensors + color ramp)
    const tab = (legendOpen && legendTab) ? legendTab : "pm25";
    if (typeof map.setPaFieldPollutant === "function") map.setPaFieldPollutant(tab);
  }

  buildLegend();
  updateLegendVisibility();

  // Legend tab clicks
  if (legendEl) {
    for (const tab of legendEl.querySelectorAll(".legendTab")) {
      tab.addEventListener("click", () => {
        const clicked = tab.dataset.legend || "pm25";
        // Clicking the active non-PM2.5 tab deselects back to PM2.5
        legendTab = (clicked === legendTab && clicked !== "pm25") ? "pm25" : clicked;
        userLegendTab = legendTab;
        legendUserOverride = !!selectedId; // override auto-sync while a marker is selected
        localStorage.setItem(LEGEND_TAB_KEY, legendTab);
        buildLegend(true);
        _syncPaFieldDim();
      });
    }
  }

  if (legendCloseEl) {
    legendCloseEl.addEventListener("click", () => {
      legendOpen = false;
      // Reset to PM2.5 on close so PA field is never hidden when legend is closed
      legendTab = "pm25";
      userLegendTab = "pm25";
      buildLegend();
      _syncPaFieldDim();
      updateLegendVisibility();
    });
  }
  if (legendToggleEl) {
    legendToggleEl.addEventListener("click", () => {
      legendOpen = true;
      updateLegendVisibility();
      _syncPaFieldDim();
    });
  }

  // ── Camera history replay (owner only) ──────────────────────────────────────
  // Fetches /api/view/clients, shows a picker of client IDs, and
  // replays the selected client's camera positions on the map.
  const camReplayBtn = document.getElementById("camReplayBtn");
  const camClientPicker = document.getElementById("camClientPicker");
  if (camReplayBtn && _ownerTok) {
    camReplayBtn.classList.add("visible");
    let _camReplaying = false;
    let _camReplayStopped = false;
    let _pickerOpen = false;

    function _closePicker() {
      _pickerOpen = false;
      if (camClientPicker) camClientPicker.classList.add("hidden");
    }

    function _stopCamReplay() {
      _camReplayStopped = true;
      _camReplaying = false;
      camReplayBtn.classList.remove("replaying");
      camReplayBtn.title = "Replay visitor camera history";
      camReplayBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>`;
    }

    async function _runCamReplay(clientId) {
      _closePicker();
      let entries;
      try {
        const resp = await fetch(`/api/view/log?client=${encodeURIComponent(clientId)}&n=500`);
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        entries = await resp.json();
      } catch (e) {
        console.warn("[CamReplay] Failed to load view log:", e);
        _stopCamReplay();
        return;
      }

      // Deduplicate near-identical positions
      const snapshots = [];
      let prevLat = null, prevLon = null, prevZoom = null;
      for (const entry of entries) {
        const lat = Number(entry.lat), lon = Number(entry.lon), zoom = Number(entry.zoom);
        if (!isFinite(lat) || !isFinite(lon) || !isFinite(zoom)) continue;
        if (prevLat !== null &&
            Math.abs(lat - prevLat) < 0.002 &&
            Math.abs(lon - prevLon) < 0.002 &&
            Math.abs(zoom - prevZoom) < 0.3) continue;
        snapshots.push({ lat, lon, zoom });
        prevLat = lat; prevLon = lon; prevZoom = zoom;
      }

      if (snapshots.length === 0) {
        console.warn("[CamReplay] No snapshots for client", clientId);
        _stopCamReplay();
        return;
      }

      for (let i = 0; i < snapshots.length; i++) {
        if (_camReplayStopped) break;
        const snap = snapshots[i];
        camReplayBtn.innerHTML = `<span>${i + 1}/${snapshots.length}</span>`;
        map._animateTo(
          { centerLat: snap.lat, centerLon: snap.lon, zoom: snap.zoom },
          { durationMs: 1200 }
        );
        await new Promise(r => setTimeout(r, 1800));
      }
      _stopCamReplay();
    }

    async function _showPicker() {
      if (!camClientPicker) return;
      camClientPicker.innerHTML = `<div class="camClientItem" style="opacity:0.5">Loading…</div>`;
      camClientPicker.classList.remove("hidden");
      _pickerOpen = true;
      try {
        const resp = await fetch("/api/view/clients");
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const clients = await resp.json();
        if (!clients.length) {
          camClientPicker.innerHTML = `<div class="camClientItem" style="opacity:0.5">No visitors yet</div>`;
          return;
        }
        camClientPicker.innerHTML = "";
        for (const c of clients) {
          const item = document.createElement("div");
          item.className = "camClientItem";
          const label = c.client_id === _clientId ? `${c.client_id} (you)` : c.client_id;
          item.innerHTML = `<span>${label}</span><span class="count">${c.count}</span>`;
          item.addEventListener("click", () => {
            _camReplaying = true;
            _camReplayStopped = false;
            camReplayBtn.classList.add("replaying");
            camReplayBtn.title = "Stop replay";
            camReplayBtn.innerHTML = `<span>■ …</span>`;
            _runCamReplay(c.client_id);
          });
          camClientPicker.appendChild(item);
        }
      } catch (e) {
        console.warn("[CamReplay] Failed to load clients:", e);
        camClientPicker.innerHTML = `<div class="camClientItem" style="color:#d06060">Error loading</div>`;
      }
    }

    // Click outside picker closes it
    document.addEventListener("click", (e) => {
      if (_pickerOpen && camClientPicker && !camClientPicker.contains(e.target) && e.target !== camReplayBtn) {
        _closePicker();
      }
    });

    camReplayBtn.addEventListener("click", () => {
      if (_camReplaying) {
        _stopCamReplay();
      } else if (_pickerOpen) {
        _closePicker();
      } else {
        _showPicker();
      }
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

  if (tabPublicEl) {
    tabPublicEl.addEventListener("click", () => {
      if (activeTab === "public") {
        map.showPublic = !map.showPublic;
      } else {
        activeTab = "public";
        if (!map.showPublic) map.showPublic = true;
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
      } else if (activeTab === "public") {
        map.showPublicLabels = !map.showPublicLabels;
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
      if (new URLSearchParams(window.location.search).get('fresh') === '1') return;
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
  // Skip localStorage persistence during auto-camera animations so the user's
  // manually-chosen view is preserved as the fallback.
  window.__onMapViewChanged = () => {
    if (map && map._isAutoCameraAnimating) return;
    saveViewSoon();
  };

  function restoreViewIfAny() {
    if (new URLSearchParams(window.location.search).get('fresh') === '1') return false;
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
    const def = t.defaultSat ?? Math.round(100 * (t.filter?.saturate ?? 0.55));
    const v = raw == null ? def : Number(raw);
    const clamped = Math.max(0, Math.min(150, isFinite(v) ? v : def));
    return clamped;
  }

  function applyThemeAndFilters(themeKey, dimVal0to100, satVal0to150) {
    const t = TILE_THEMES[themeKey] || TILE_THEMES.carto_dark_all;
    // Only call setTheme when the theme actually changes — it clears the tile
    // cache and forces a full reload, which causes visible flashing when just
    // adjusting dim/sat sliders.
    if (map.themeKey !== themeKey) {
      map.setTheme(themeKey);
    }

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
    // Light themes disabled — always default to dark
    return "carto_dark_all";
    // return isSystemDarkMode() ? "carto_dark_all" : "carto_voyager";
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
    // Also save as the last-active theme so launch doesn't override user choice
    localStorage.setItem("mobileair.mapTheme.last", themeKey);
  }

  function getInitialTheme() {
    // On launch, prefer the last theme the user actively selected.
    // Only fall back to system-mode default if user never chose a theme.
    const last = localStorage.getItem("mobileair.mapTheme.last");
    if (last && TILE_THEMES[last]) return last;
    return getSavedThemeForCurrentMode();
  }

  // Track current theme for menu updates
  let _currentThemeKey = getInitialTheme();

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

    // Load saved theme (prefers last user selection over system mode)
    const initialTheme = getInitialTheme();
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
    // Fallback (no UI) - prefer last user selection
    const fallbackTheme = getInitialTheme();
    _currentThemeKey = fallbackTheme;
    const fallbackT = TILE_THEMES[fallbackTheme];
    applyThemeAndFilters(fallbackTheme, fallbackT.defaultDim ?? 70, Math.round(100 * (fallbackT.filter?.saturate ?? 1.30)));
  }
  
  // System theme auto-switching disabled (light themes disabled)
  // if (window.matchMedia) {
  //   window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  //     const newTheme = getSavedThemeForCurrentMode();
  //     applyTheme(newTheme);
  //   });
  // }

  // // Re-check system theme when app returns to foreground (PWA / tab switch).
  // // The matchMedia 'change' event may not fire while the app is backgrounded,
  // // so the theme can get out of sync until the user interacts.
  // {
  //   let _lastKnownSystemDark = isSystemDarkMode();
  //   document.addEventListener("visibilitychange", () => {
  //     if (document.visibilityState !== "visible") return;
  //     const nowDark = isSystemDarkMode();
  //     if (nowDark !== _lastKnownSystemDark) {
  //       _lastKnownSystemDark = nowDark;
  //       const newTheme = getSavedThemeForCurrentMode();
  //       // Only switch if the current theme's dark/light doesn't match system
  //       if (isThemeDark(_currentThemeKey) !== nowDark) {
  //         applyTheme(newTheme);
  //       }
  //     }
  //   });
  // }

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

  /** Return the correct state object for the current mode (historical or live). */
  function _currentState() {
    if (map._historicalMode && window._historicalState) return window._historicalState;
    return window.__lastState || { mobile: [], fixed: [] };
  }

  window.__selectSensor = (id, opts = {}) => {
    const fitTrail = !!opts.fitTrail;
    const fromPanel = !!opts.fromPanel;  // True only when selected from sidebar, not from map
    
    // Toggle: clicking the selected sensor again deselects.
    if (id && selectedId === id) {
      selectedId = null;
      legendUserOverride = false;
      if (map && typeof map.cancelSelectionOrchestration === "function") map.cancelSelectionOrchestration();
      map.setSelected(null);
      legendTab = "pm25";
      userLegendTab = "pm25";
      buildLegend();
      _syncPaFieldDim();
      renderLists(_currentState(), selectedId);
      renderDetails(_currentState(), selectedId);
      return;
    }

    selectedId = id || null;
    legendUserOverride = false; // reset override on new selection
    if (!selectedId) {
      legendTab = "pm25";
      userLegendTab = "pm25";
      buildLegend();
      _syncPaFieldDim();
    }
    map.setSelected(selectedId);

    const st = _currentState();
    const sel = parseKey(selectedId);
    let item = null;
    if (sel && sel.type === "mobile") item = (Array.isArray(st.mobile) ? st.mobile : []).find(x => x.id === sel.id) || null;
    if (sel && sel.type === "fixed") item = (Array.isArray(st.fixed) ? st.fixed : []).find(x => x.id === sel.id) || null;

    // Auto-open legend on first mobile/fixed selection this session (not PurpleAir)
    const isPurpleAir = item && item.purpleair;
    if (selectedId && !_legendAutoOpenedOnce && !legendOpen && !isPurpleAir) {
      _legendAutoOpenedOnce = true;
      legendOpen = true;
      updateLegendVisibility();
    }

    // Sync legend tab to selected marker's displayed pollutant
    // Use item data directly (map render state may not be updated yet)
    if (item) syncLegendToSensor(item);
    // Also try map's render-resolved key as a fallback
    syncLegendToMapSelection();
    
    // Center camera when selected from sidebar (any sensor type), or for mobile from map click with cmd+click for fit
    if (item && isFinite(Number(item.lat)) && isFinite(Number(item.lon))) {
      const shouldCenter = fromPanel || (sel?.type === "mobile");
      if (shouldCenter) {
        // Default: center on the marker.
        // Cmd+click: fit to breadcrumb path bbox (mobile only).
        if (fitTrail && sel?.type === "mobile" && Array.isArray(item.trail) && item.trail.length >= 2) {
          map.fitTrailBounds(item.trail, { animate: true });
        } else if (map.playbackMode) {
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
    }
    // Switch sidebar tab to match selected sensor type (when selected from map)
    // PurpleAir sensors: only switch if the user is already on the Community tab
    if (sel && !fromPanel && !(item && item.purpleair && activeTab !== "public")) {
      let targetTab = sel.type === "mobile" ? "mobile" : (item && item.purpleair ? "public" : "fixed");
      if (activeTab !== targetTab) {
        activeTab = targetTab;
        applySidebarTab();
      }
    }

    renderLists(st, selectedId);
    renderDetails(st, selectedId);

    // Scroll the selected item into view in the sidebar (only when selected from map)
    // PurpleAir sensors: only scroll if the user is already on the Community tab
    if (sel && !fromPanel) {
      const isPurpleair = item && item.purpleair;
      if (!isPurpleair || activeTab === "public") {
        const listEl = sel.type === "mobile" ? listMobileEl
          : (isPurpleair ? listPublicEl : listFixedEl);
        if (listEl) {
          const selEl = listEl.querySelector(`[data-id="${CSS.escape(sel.id)}"]`);
          if (selEl) selEl.scrollIntoView({ block: "start", behavior: "smooth" });
        }
      }
    }
  };

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      selectedId = null;
      legendUserOverride = false;
      map.setSelected(null);
      legendTab = "pm25";
      userLegendTab = "pm25";
      buildLegend();
      renderLists(_currentState(), selectedId);
      renderDetails(_currentState(), selectedId);
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
  const pbPagePrevEl = document.getElementById("pbPagePrev");
  const pbPageNextEl = document.getElementById("pbPageNext");

  // ── A/B Barrel Jog Wheel ────────────────────────────────────────────────
  const pbJogWheelEl    = document.getElementById("pbJogWheel");
  const pbJogBarrelEl   = document.getElementById("pbJogBarrel");
  const pbBarrelClipEl  = document.getElementById("pbBarrelClip");
  const pbBarrelCanvas  = document.getElementById("pbBarrelCanvas");
  const pbBarrelToggle  = document.getElementById("pbBarrelToggle");
  let _jogWheel = null;          // JogWheel instance (created on first enable)
  let _barrelMode = false;       // current A/B state
  const _BARREL_STORAGE_KEY = "mobileair.barrelJogWheel";

  function _setBarrelMode(on) {
    return; // SHUNT: barrel feature bypassed — restore by removing this line
    _barrelMode = on;
    if (pbJogWheelEl) pbJogWheelEl.classList.toggle("hidden", on);
    if (pbJogBarrelEl) pbJogBarrelEl.classList.toggle("hidden", !on);
    if (pbBarrelToggle) pbBarrelToggle.checked = on;
    try { localStorage.setItem(_BARREL_STORAGE_KEY, on ? "1" : "0"); } catch {}

    if (on && !_jogWheel && pbJogBarrelEl && pbBarrelClipEl && pbBarrelCanvas && typeof JogWheel !== "undefined") {
      _jogWheel = JogWheel.create({
        wrapEl: pbJogBarrelEl,
        clipEl: pbBarrelClipEl,
        canvasEl: pbBarrelCanvas,
        onWheel(delta) {
          // Same physics as classic wheel handler on pbScrubEl
          _pbAtEndSincePerf = null;
          _pbArrivedAtEndViaPlayback = false;
          _pbIsRewinding = false;
          _pbPageAutoFollow = true;
          map.setPlaybackPlaying(false);
          map._playbackLiveFollow = false;
          try { localStorage.setItem(LIVE_MODE_STORAGE_KEY, "0"); } catch {}
          _pbIsWheelCoasting = true;
          _pbCommitLoopStartOnCoastEnd = true;
          if (_pbPagingActive() && _pbSlidingWindowCenter == null) {
            const pr = _pbGetPageRange();
            _pbSlidingWindowCenter = (pr.minMs + pr.maxMs) / 2;
          }
          const b = map.getPlaybackBounds();
          const durMs = (b.maxMs - b.minMs) || 1;
          const nudge = (delta / 1000) * (durMs / 480);
          const prevDir = Math.sign(_pbVelocity);
          _pbVelocity -= nudge;
          if (prevDir !== 0 && Math.sign(_pbVelocity) !== 0 && Math.sign(_pbVelocity) !== prevDir) {
            _pbSnapWindowToPlayhead();
            updatePlaybackUi();
          }
          if (!_pbRAF) {
            _pbLastPerf = performance.now();
            _pbRAF = requestAnimationFrame(playbackLoop);
          }
        },
        onDragStart() {
          // Same cancel-all-physics as classic pointerdown
          _pbVelocity = 0;
          _pbWheelAccum = 0;
          _pbAtEndSincePerf = null;
          _pbArrivedAtEndViaPlayback = false;
          _pbIsRewinding = false;
          _pbEaseStartPerf = null;
          _pbIsWheelCoasting = false;
          _pbScrubbing = true;
          map._scrubbing = true;
          _pbDidDrag = false;
          map.setPlaybackPlaying(false);
          map._playbackLiveFollow = false;
          try { localStorage.setItem(LIVE_MODE_STORAGE_KEY, "0"); } catch {}
          _resetLiveTracking();
          if (_pbPagingActive() && _pbSlidingWindowCenter == null) {
            const pr = _pbGetPageRange();
            _pbSlidingWindowCenter = (pr.minMs + pr.maxMs) / 2;
          }
          updatePlaybackUi();
        },
        onPositionChange(deltaFrac) {
          // deltaFrac is already gear-reduced (dx / (width*8))
          // Map to timeline ms and apply
          _pbDidDrag = true;
          const b = map.getPlaybackBounds();
          const pr = _pbPagingActive() ? _pbGetPageRange() : b;
          const durMs = (pr.maxMs - pr.minMs) || 1;
          const tMs = map.getPlaybackTimeMs() || pr.minMs;
          const newT = clamp(tMs + deltaFrac * durMs, pr.minMs, pr.maxMs);
          map.setPlaybackTimeMs(newT);
          map.setPlaybackPlaying(false);
          // Coalesce render
          if (!_scrubRAF) {
            _scrubRAF = requestAnimationFrame(() => {
              _scrubRAF = 0;
              map.drawOverlay(map.lastState);
              updatePlaybackUi();
            });
          }
        },
        onDragEnd(vel) {
          _pbSnapWindowToPlayhead();
          _pbScrubbing = false;
          map._scrubbing = false;
          // Convert barrel velocity to timeline velocity for inertial coasting
          const b = map.getPlaybackBounds();
          const pr = _pbPagingActive() ? _pbGetPageRange() : b;
          const durMs = (pr.maxMs - pr.minMs) || 1;
          _pbVelocity = (vel * durMs) / 16;
          _pbIsWheelCoasting = false;
          _pbPageAutoFollow = true;
          map.setPlaybackPlaying(true);
          _pbLastPerf = performance.now();
          if (!_pbRAF) _pbRAF = requestAnimationFrame(playbackLoop);
        }
      });
    }
  }

  // Restore saved preference
  {
    const saved = localStorage.getItem(_BARREL_STORAGE_KEY);
    if (saved === "1") _setBarrelMode(true);
  }

  if (pbBarrelToggle) {
    pbBarrelToggle.addEventListener("change", () => {
      _setBarrelMode(pbBarrelToggle.checked);
    });
  }

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

  // Wall-clock ms (Date.now) when last server response arrived
  let _pbLastServerResponseMs = Date.now();

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
    _deferredCameraFit = null;
  }
  map._resetLiveTracking = _resetLiveTracking;
  
  // LIVE camera follow: smooth pan/zoom to fit moving vehicles
  const _pbLiveFollowDurationMs = 2000; // animation duration for camera follow (slow, smooth)
  const _pbLiveFollowPadding = 0.15;    // extra padding around bounds (15%)

  // Deferred camera fit: when new data arrives while the user is panning/zooming
  // (or during post-interaction easing), we stash the intended camera fit here.
  // The playback loop drains it once _canRunAutoCamera() returns true.
  let _deferredCameraFit = null; // { type: "bounds", bb, durationMs } | { type: "storedView", durationMs }

  // Minimum geographic extent (in degrees) for bounds to be considered "meaningful" movement.
  // ~0.002° lat ≈ 220m. Below this the vehicles are just jittering in place (depot, parking lot).
  const _pbMinBoundsExtentDeg = 0.002;

  // High-AQI alert camera override: sensors at or above this AQI within SLC metro
  // bounds are force-included in camera fit, bypassing cluster-radius gating.
  const _HIGH_ALERT_AQI_THRESHOLD = 151; // EPA "Unhealthy"
  const _HIGH_ALERT_COOLDOWN_MS = 1200;  // 1.2s override cooldown
  const _SLC_BOUNDS = { minLat: 40.4, maxLat: 41.0, minLon: -112.2, maxLon: -111.7 };

  // Whether the auto-center camera follow is enabled. Toggled by #autoCameraBtn.
  let _autoCameraEnabled = true;

  // Perform a live camera fit: compute bounds from current vehicle/sensor state
  // and animate the camera to frame them. When force=true, bypasses _canRunAutoCamera
  // and signature-dedup guards (used for explicit user action).
  // In playback mode, uses the time-clipped trail data so the camera frames
  // where vehicles are at the current scrub time, not the latest data.
  function _performCameraFit({ force = false } = {}) {
    const state = map.lastState;
    const mobiles = state && Array.isArray(state.mobile) ? state.mobile : [];
    const fixed = state && Array.isArray(state.fixed) ? state.fixed : [];
    const logic = (typeof window !== "undefined") ? window.CameraFitLogic : null;
    let bb = null;

    // In playback mode, resolve each vehicle's position at the current playback time
    // using _playbackPtsById (the same time-sorted data the renderer uses).
    const pbTimeMs = map.playbackMode ? map.getPlaybackTimeMs() : null;
    const usePbTime = pbTimeMs != null && isFinite(pbTimeMs) && map._playbackPtsById;

    if (logic && typeof logic.collectRobustLiveBounds === "function") {
      const vehicleEntries = [];
      for (const m of mobiles) {
        if (!m || m.ghosted) continue;
        const id = m.id != null ? String(m.id) : "";

        let headLat = NaN, headLon = NaN;
        let trail = Array.isArray(m.trail) ? m.trail : [];

        if (usePbTime && id) {
          // Use playback points clipped to current scrub time
          const pts = map._playbackPtsById.get(id);
          if (pts && pts.length > 0) {
            // Binary search for last point <= pbTimeMs
            let lo = 0, hi = pts.length - 1;
            while (lo < hi) {
              const mid = (lo + hi + 1) >> 1;
              if (pts[mid].tMs <= pbTimeMs) lo = mid; else hi = mid - 1;
            }
            if (pts[lo].tMs <= pbTimeMs) {
              headLat = pts[lo].lat;
              headLon = pts[lo].lon;
              // Build a clipped trail for bounds calculation
              trail = pts.slice(0, lo + 1).map(p => ({ lat: p.lat, lon: p.lon, t: p.t }));
            }
          }
        }

        // Fallback: walk raw trail backwards (live mode / no playback data)
        if (!isFinite(headLat) || !isFinite(headLon)) {
          if (trail.length === 0) continue;
          for (let i = trail.length - 1; i >= 0; i--) {
            const p = trail[i];
            if (!p) continue;
            const lat = Number(p.lat);
            const lon = Number(p.lon);
            if (isFinite(lat) && isFinite(lon)) { headLat = lat; headLon = lon; break; }
          }
        }
        if (!isFinite(headLat) || !isFinite(headLon)) continue;
        vehicleEntries.push({ id: m.id, lat: headLat, lon: headLon, trail });
      }

      const mustIncludePoints = [];
      const _inSlc = (lat, lon) => lat >= _SLC_BOUNDS.minLat && lat <= _SLC_BOUNDS.maxLat
        && lon >= _SLC_BOUNDS.minLon && lon <= _SLC_BOUNDS.maxLon;
      for (const f of fixed) {
        if (!f || f.purpleair) continue;
        const flat = Number(f.lat), flon = Number(f.lon);
        if (!isFinite(flat) || !isFinite(flon) || !_inSlc(flat, flon)) continue;
        const w = (typeof pickWorstReadingKey === "function") ? pickWorstReadingKey(f.readings) : null;
        if (w && typeof w.aqi === "number" && w.aqi >= _HIGH_ALERT_AQI_THRESHOLD) {
          mustIncludePoints.push({ lat: flat, lon: flon });
        }
      }
      for (const m of mobiles) {
        if (!m || m.ghosted) continue;
        const mlat = Number(m.lat), mlon = Number(m.lon);
        if (!isFinite(mlat) || !isFinite(mlon) || !_inSlc(mlat, mlon)) continue;
        const w = (typeof pickWorstReadingKey === "function") ? pickWorstReadingKey(m.readings) : null;
        if (w && typeof w.aqi === "number" && w.aqi >= _HIGH_ALERT_AQI_THRESHOLD) {
          mustIncludePoints.push({ lat: mlat, lon: mlon });
        }
      }

      if (mustIncludePoints.length > 0 && map && typeof map._overrideCooldownForAlert === "function") {
        map._overrideCooldownForAlert(_HIGH_ALERT_COOLDOWN_MS);
      }

      bb = logic.collectRobustLiveBounds(vehicleEntries, {
        fixedSensors: fixed,
        includeDebugPath: !!map._pbDebugPath,
        maxSegmentLengthM: MapView.MAX_CAMERA_FIT_SEGMENT_LENGTH_M,
        mustIncludePoints: mustIncludePoints.length > 0 ? mustIncludePoints : null,
      });
    } else {
      bb = _collectHeadPositionBounds(mobiles);
    }

    if (bb && bb.visibleVehicleCount >= 2 && isFinite(bb.minLat) && isFinite(bb.maxLat)) {
      _animateFitBoundsLatLon(bb, { durationMs: _pbLiveFollowDurationMs, force });
    } else {
      _animateToStoredView(_pbLiveFollowDurationMs);
    }
  }

  // Returns true if the user is zoomed in enough that SLC extends beyond the
  // viewport — i.e. they're looking at vehicle-level detail, not the whole metro.
  // If SLC fits entirely on screen, the user is zoomed out and auto-camera should not fire.
  function _slcInView() {
    if (!map || !map.tilesCanvas) return true; // fail open
    const rect = map.tilesCanvas.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    if (w <= 0 || h <= 0) return true;
    const z = map.zoom;
    const centerW = latLonToWorld(map.center.lat, map.center.lon, z);
    const toScreen = (lat, lon) => {
      const wpt = latLonToWorld(lat, lon, z);
      return { x: wpt.x - centerW.x + w / 2, y: wpt.y - centerW.y + h / 2 };
    };
    const tl = toScreen(_SLC_BOUNDS.maxLat, _SLC_BOUNDS.minLon);
    const br = toScreen(_SLC_BOUNDS.minLat, _SLC_BOUNDS.maxLon);
    // Must overlap viewport at all
    if (br.x <= 0 || tl.x >= w || br.y <= 0 || tl.y >= h) return false;
    // SLC must be larger than the viewport in at least one axis (zoomed in)
    const slcW = br.x - tl.x;
    const slcH = br.y - tl.y;
    return slcW > w || slcH > h;
  }

  // Smoothly animate back to the user's stored view (from localStorage) when no
  // meaningful vehicle movement is detected. Acts as a screensaver-like idle return.
  function _animateToStoredView(durationMs) {
    if (new URLSearchParams(window.location.search).get('fresh') === '1') return;
    if (!map || typeof map._canRunAutoCamera !== "function") return;
    if (!map._canRunAutoCamera()) {
      // User is interacting — defer until interaction + easing finishes.
      _deferredCameraFit = { type: "storedView", durationMs: durationMs || _pbLiveFollowDurationMs };
      return;
    }
    try {
      const raw = localStorage.getItem(VIEW_STORAGE_KEY);
      if (!raw) return;
      const v = JSON.parse(raw);
      const lat = Number(v?.lat);
      const lon = Number(v?.lon);
      const zoom = Number(v?.zoom);
      if (!isFinite(lat) || !isFinite(lon) || !isFinite(zoom)) return;

      // Already there? Skip.
      const curr = map.center;
      if (curr && Math.abs(Number(curr.lat) - lat) < 1e-5 && Math.abs(Number(curr.lon) - lon) < 1e-5
          && Math.abs(Number(map.zoom) - zoom) < 1e-3) return;

      map._animateTo(
        { centerLat: lat, centerLon: lon, zoom },
        { durationMs, isAutoCamera: true }
      );
    } catch {
      // ignore
    }
  }

  function _animateFitBoundsLatLon({ minLat, minLon, maxLat, maxLon }, { durationMs = _pbLiveFollowDurationMs, force = false } = {}) {
    if (!isFinite(minLat) || !isFinite(maxLat) || !isFinite(minLon) || !isFinite(maxLon)) return;

    // User interaction always wins: do not start/continue auto camera fits while the user
    // is actively panning/zooming, or during the post-interaction cooldown.
    // Exception: force=true (explicit user button click) overrides the cooldown.
    if (!force && map && typeof map._canRunAutoCamera === "function" && !map._canRunAutoCamera()) {
      // Defer: replay this fit once the user stops interacting.
      _deferredCameraFit = { type: "bounds", bb: { minLat, minLon, maxLat, maxLon }, durationMs };
      return;
    }

    // If the bounds are too small (depot jitter, parked vehicles shuffling), don't zoom
    // into that tiny area — fall back to the user's stored view instead.
    const latRange = maxLat - minLat;
    const lonRange = maxLon - minLon;
    if (latRange < _pbMinBoundsExtentDeg && lonRange < _pbMinBoundsExtentDeg) {
      _animateToStoredView(durationMs);
      return;
    }

    // Add padding
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

    // Account for the playback bar at the bottom so the camera centers in the visible map area.
    const pbBarEl = document.getElementById("playbackBar");
    if (pbBarEl) {
      const pbRect = pbBarEl.getBoundingClientRect();
      if (pbRect.height > 0) {
        const overlap = Math.max(0, rect.bottom - pbRect.top);
        if (overlap > 0) pad.bottom = Math.max(pad.bottom, overlap + 10);
      }
    }

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

      if (!force && currentSig === targetSig) return;
      if (!force && map && map._centerAnimRAF && map._autoFitInFlightSig === targetSig) return;
      if (map) {
        map._autoFitInFlightSig = targetSig;
        map._lastAutoFitSig = targetSig;
      }
    } catch {
      // ignore
    }

    map._animateTo(
      { centerLat: finalCenter.lat, centerLon: finalCenter.lon, zoom: targetZoom },
      { durationMs, isAutoCamera: true }
    );
  }

  // Collect a bounding box from just the latest (head) position of each active,
  // non-ghosted vehicle whose trail meets the minimum length threshold.
  // Used for LIVE camera follow so the camera frames where vehicles ARE, not the
  // full extent of their historical trails.
  function _collectHeadPositionBounds(mobiles) {
    let minLat = Infinity, maxLat = -Infinity;
    let minLon = Infinity, maxLon = -Infinity;
    let visibleVehicleCount = 0;
    let visiblePointCount = 0;

    for (const m of mobiles) {
      if (!m || m.ghosted) continue;
      const trail = Array.isArray(m.trail) ? m.trail : [];
      if (trail.length === 0) continue;

      // Find the latest point with valid coordinates
      let headLat = NaN, headLon = NaN;
      for (let i = trail.length - 1; i >= 0; i--) {
        const p = trail[i];
        if (!p) continue;
        const lat = Number(p.lat);
        const lon = Number(p.lon);
        if (isFinite(lat) && isFinite(lon)) {
          headLat = lat;
          headLon = lon;
          break;
        }
      }
      if (!isFinite(headLat) || !isFinite(headLon)) continue;

      minLat = Math.min(minLat, headLat);
      maxLat = Math.max(maxLat, headLat);
      minLon = Math.min(minLon, headLon);
      maxLon = Math.max(maxLon, headLon);
      visibleVehicleCount++;
      visiblePointCount++;
    }

    return { minLat, minLon, maxLat, maxLon, visibleVehicleCount, visiblePointCount };
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
          maxSegmentLengthM: MapView.MAX_CAMERA_FIT_SEGMENT_LENGTH_M,
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

  // ─────────────────────────────────────────────────────────────────────────────
  // PAGING: Slider maps to an 8-hour page instead of the full day.
  // Keeps scrub resolution constant as data accumulates.
  // ─────────────────────────────────────────────────────────────────────────────
  const _pbPageSizeMs = 14400000;         // 4 hours in ms
  const _pbPageMinDurationMs = 0;          // paging always active
  let _pbPageIndex = -1;                  // -1 = "all" (no paging), 0..N = page index
  let _pbPageAutoFollow = true;           // auto-advance page to follow playhead

  // Sliding window: when set, overrides index-based paging for click-drag scrubbing.
  // The window is centered on this timestamp instead of a fixed page boundary.
  let _pbSlidingWindowCenter = null;      // null = use index-based paging
  let _pbJogRAF = null;                   // rAF ID for edge-jog during drag
  let _pbJogLastPerf = 0;                 // last rAF timestamp for jog dt

  /** Compute total page count for current bounds.
   *  Uses floor so the last page absorbs any remainder < pageSize,
   *  keeping scrub resolution reasonable instead of creating a tiny final page. */
  function _pbPageCount() {
    const b = map.getPlaybackBounds();
    if (!isFinite(b.minMs) || !isFinite(b.maxMs) || b.maxMs <= b.minMs) return 0;
    return Math.max(1, Math.floor((b.maxMs - b.minMs) / _pbPageSizeMs));
  }

  /** Get the time range for the current page (or full range if paging disabled).
   *  When _pbSlidingWindowCenter is set, the window is centered on that point
   *  instead of using index-based page boundaries. */
  function _pbGetPageRange() {
    const b = map.getPlaybackBounds();
    if (!isFinite(b.minMs) || !isFinite(b.maxMs) || b.maxMs <= b.minMs) return b;
    if (_pbPageIndex < 0) return b; // "all" mode

    // Sliding window mode: center window on _pbSlidingWindowCenter
    if (_pbSlidingWindowCenter != null) {
      const half = _pbPageSizeMs / 2;
      let wMin = _pbSlidingWindowCenter - half;
      let wMax = _pbSlidingWindowCenter + half;
      // Clamp to global bounds, preserving window size when possible
      if (wMin < b.minMs) { wMin = b.minMs; wMax = Math.min(b.maxMs, wMin + _pbPageSizeMs); }
      if (wMax > b.maxMs) { wMax = b.maxMs; wMin = Math.max(b.minMs, wMax - _pbPageSizeMs); }
      return { minMs: wMin, maxMs: wMax };
    }

    const total = _pbPageCount();
    const idx = clamp(_pbPageIndex, 0, total - 1);
    const pageStart = b.minMs + idx * _pbPageSizeMs;
    // Last page extends to cover all remaining time (no short final page)
    const pageEnd = (idx === total - 1) ? b.maxMs : pageStart + _pbPageSizeMs;
    return { minMs: pageStart, maxMs: pageEnd };
  }

  /** Navigate to a specific page index, clamping to valid range. */
  function _pbSetPage(idx) {
    const total = _pbPageCount();
    if (total <= 0) { _pbPageIndex = -1; return; }
    _pbPageIndex = clamp(idx, 0, total - 1);
    _pbSlidingWindowCenter = null; // exit sliding window, use index-based page
    _pbPageAutoFollow = false; // user explicitly chose a page
    updatePlaybackUi();
  }

  /** Enable paging and jump to the page containing the given time. */
  function _pbPageForTime(tMs) {
    const b = map.getPlaybackBounds();
    if (!isFinite(b.minMs) || !isFinite(b.maxMs) || b.maxMs <= b.minMs) return;
    const total = _pbPageCount();
    if (total <= 0) return;
    const idx = Math.floor((tMs - b.minMs) / _pbPageSizeMs);
    _pbPageIndex = clamp(idx, 0, total - 1);
  }

  /** After user stops scrubbing, re-center the sliding window so the playhead
   *  sits at 15% (if user was dragging left) or 85% (if dragging right). */
  function _pbSnapWindowToPlayhead() {
    if (!_pbPagingActive() || _pbSlidingWindowCenter == null) return;
    const b = map.getPlaybackBounds();
    const tMs = map.getPlaybackTimeMs();
    if (tMs == null || !isFinite(tMs)) return;
    const pr = _pbGetPageRange();
    // Determine which edge the playhead is near
    const fracInPage = (pr.maxMs > pr.minMs) ? (tMs - pr.minMs) / (pr.maxMs - pr.minMs) : 0.5;
    // If near left edge (<25%), snap playhead to 15%; if near right (>75%), snap to 85%
    const targetFrac = (fracInPage < 0.25) ? 0.15 : (fracInPage > 0.75) ? 0.85 : fracInPage;
    _pbSlidingWindowCenter = tMs - targetFrac * _pbPageSizeMs + _pbPageSizeMs / 2;
    const half = _pbPageSizeMs / 2;
    _pbSlidingWindowCenter = clamp(_pbSlidingWindowCenter, b.minMs + half, b.maxMs - half);
  }

  /** Check if paging should be active based on data duration. */
  function _pbPagingActive() {
    const b = map.getPlaybackBounds();
    if (!isFinite(b.minMs) || !isFinite(b.maxMs)) return false;
    return (b.maxMs - b.minMs) >= _pbPageMinDurationMs;
  }

  const fmtTime = (ms) => {
    if (ms == null || !isFinite(ms)) return "—";
    try { return new Date(ms).toLocaleTimeString(); } catch { return "—"; }
  };

  const updatePlaybackUi = () => {
    const b = map.getPlaybackBounds();
    const tMs = map.getPlaybackTimeMs();
    const paging = _pbPagingActive();

    // Auto-enable paging when duration crosses threshold.
    // Initialize page index to the page containing the playhead.
    if (paging && _pbPageIndex < 0) {
      const t = (tMs != null && isFinite(tMs)) ? tMs : b.maxMs;
      _pbPageForTime(t);
      _pbPageAutoFollow = true; // started automatically, follow playhead
    } else if (!paging) {
      _pbPageIndex = -1; // disable paging when duration shrinks
      _pbSlidingWindowCenter = null;
    }

    // Auto-advance page to follow playhead during normal playback (not scrubbing/coasting)
    if (paging && _pbPageAutoFollow && tMs != null && isFinite(tMs) && !_pbScrubbing) {
      const pr = _pbGetPageRange();
      if (tMs >= pr.maxMs || tMs < pr.minMs) {
        if (_pbSlidingWindowCenter != null) {
          // Shift window just enough so playhead is inside, giving room in the direction of travel
          const frac = (tMs >= pr.maxMs) ? 0.85 : 0.15;
          _pbSlidingWindowCenter = tMs - frac * _pbPageSizeMs + _pbPageSizeMs / 2;
          const half = _pbPageSizeMs / 2;
          _pbSlidingWindowCenter = clamp(_pbSlidingWindowCenter, b.minMs + half, b.maxMs - half);
        } else {
          _pbPageForTime(tMs);
        }
      }
      _pbPageAutoFollow = true; // keep following
    }

    // Use page range for slider when paging is active
    const pr = paging ? _pbGetPageRange() : b;
    const sliderMinMs = pr.minMs;
    const sliderMaxMs = pr.maxMs;

    if (pbLeftEl) pbLeftEl.textContent = fmtTime(sliderMinMs);
    if (pbRightEl) pbRightEl.textContent = fmtTime(sliderMaxMs);
    if (pbNowEl) pbNowEl.textContent = fmtTime(tMs);

    if (pbScrubEl && isFinite(sliderMinMs) && isFinite(sliderMaxMs) && sliderMaxMs > sliderMinMs) {
      const durMs = Math.max(1, sliderMaxMs - sliderMinMs);
      const tRelMs = (tMs != null && isFinite(tMs)) ? (tMs - sliderMinMs) : durMs;
      pbScrubEl.min = "0";
      pbScrubEl.max = String(durMs);
      pbScrubEl.step = "100"; // 100ms steps for smoother scrubbing
      pbScrubEl.disabled = false;
      if (!_pbScrubbing) {
        pbScrubEl.value = String(clamp(tRelMs, 0, durMs));
      }
      // Update progress fill for browsers without accent-color range support
      const pct = (clamp(Number(pbScrubEl.value), 0, durMs) / durMs) * 100;
      pbScrubEl.style.setProperty("--pct", pct + "%");
    } else if (pbScrubEl) {
      pbScrubEl.disabled = true;
      pbScrubEl.min = "0";
      pbScrubEl.max = "1";
      pbScrubEl.value = "0";
      pbScrubEl.style.setProperty("--pct", "0%");
    }

    // Page arrow visibility & disabled state
    if (pbPagePrevEl) {
      pbPagePrevEl.classList.toggle("hidden", !paging);
      pbPagePrevEl.disabled = _pbPageIndex <= 0;
    }
    if (pbPageNextEl) {
      pbPageNextEl.classList.toggle("hidden", !paging);
      pbPageNextEl.disabled = _pbPageIndex >= _pbPageCount() - 1;
    }

    const hasBounds = isFinite(b.minMs) && isFinite(b.maxMs) && b.maxMs > b.minMs;
    const atEnd = !hasBounds || map.isPlaybackAtEnd(200);
    // Live window: playhead is close enough to maxMs that continuing playback
    // would naturally reach the end before the next server update.
    // Only applies at 1x and 5x; higher speeds don't get the buffer.
    const _speed = map.getPlaybackSpeed() || 1.0;
    const _nextInS = Number(map.lastState?.meta?.polling_next_update_in_s) ?? Number(map.lastState?.meta?.polling_predicted_interval_s) ?? 600;
    const _wallElapsed2 = (Date.now() - _pbLastServerResponseMs) / 1000;
    const _remS2 = Math.max(0, _nextInS - _wallElapsed2);
    const _liveWindowMs = (_speed <= 5) ? _remS2 * 1000 * _speed : 0;
    const inLiveWindow = !hasBounds || atEnd || (
      _liveWindowMs > 0 && tMs != null && isFinite(tMs) && tMs >= b.maxMs - _liveWindowMs
    );
    // LIVE mode is based on the flag, not position - we're replaying the buffer
    const followingLive = map._playbackLiveFollow;

    if (pbPlayEl) {
      if (followingLive && !map._historicalMode) {
        // LIVE mode enabled: show Live button highlighted
        pbPlayEl.textContent = "Live";
        pbPlayEl.classList.add("isLive");
      } else if (inLiveWindow && !map._historicalMode) {
        // In live buffer window but LIVE not enabled: show Live button (not highlighted)
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
    const tMsBefore = tMs; // snapshot before advancement, for edge-crossing detection
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

    // When new data arrives in LIVE mode and playback is paused at the end,
    // resume playing so the new segment animates. Don't rewind the playhead —
    // let normal forward playback consume the new data naturally.
    if (hasBounds && (newDataArrived || forceCameraFit) && map._playbackLiveFollow && !map.getPlaybackPlaying()) {
      const speed = map.getPlaybackSpeed() || 1.0;
      _pbVelocity = _pbPlaybackSpeed * speed;
      map.setPlaybackPlaying(true);
      _pbLastPerf = 0;
      if (!_pbRAF) _pbRAF = requestAnimationFrame(playbackLoop);
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
        const nextInS = Number(meta?.polling_next_update_in_s) ?? Number(meta?.polling_predicted_interval_s) ?? 600;
        const speed = map.getPlaybackSpeed() || 1.0;
        const offsetMs = nextInS * 1000 * speed;
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
    // LIVE CAMERA FOLLOW: Frame where vehicles currently are, their visible
    // trails, and nearby fixed sensors. Uses median-based outlier trimming so
    // a distant long-route vehicle doesn't drag the camera to city scale.
    // ─────────────────────────────────────────────────────────────────────────
    {
      if (_autoCameraEnabled && (newDataArrived || forceCameraFit) && map._playbackLiveFollow && _slcInView()) {
        _performCameraFit();
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DEFERRED CAMERA FIT: If a live camera fit was blocked by user interaction,
    // replay it now that the interaction + easing has settled.
    // ─────────────────────────────────────────────────────────────────────────
    if (_deferredCameraFit && map._playbackLiveFollow
        && typeof map._canRunAutoCamera === "function" && map._canRunAutoCamera()) {
      const d = _deferredCameraFit;
      _deferredCameraFit = null;
      if (d.type === "bounds" && d.bb) {
        _animateFitBoundsLatLon(d.bb, { durationMs: d.durationMs || _pbLiveFollowDurationMs });
      } else if (d.type === "storedView") {
        _animateToStoredView(d.durationMs || _pbLiveFollowDurationMs);
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
          // At end — velocity zeroed; the Live-mode switch below will activate.
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
          _pbSnapWindowToPlayhead();
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
          _pbSnapWindowToPlayhead();
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
      if (Math.abs(_pbVelocity) < _pbVelocityThreshold && _pbVelocity !== 0) {
        _pbVelocity = 0;
        // Final UI update so time labels reflect where the playhead landed
        if (!map.getPlaybackPlaying()) {
          updatePlaybackUi();
        }
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
    if (didAdvanceTime) {
      map._compositePaFieldOnTiles(map.lastState);
      map.drawOverlay(map.lastState, { cacheUnderlay: true });
    }

    // When playback enters the live buffer window, stop and show Live button.
    // Buffer window = predictedInterval * speed, but only for 1x and 5x.
    {
      const _spd2 = map.getPlaybackSpeed() || 1.0;
      const _nextInS2 = Number(map.lastState?.meta?.polling_next_update_in_s) ?? Number(map.lastState?.meta?.polling_predicted_interval_s) ?? 600;
      const _wallElapsed3 = (Date.now() - _pbLastServerResponseMs) / 1000;
      const _remS3 = Math.max(0, _nextInS2 - _wallElapsed3);
      const _lwMs2 = (_spd2 <= 5) ? _remS3 * 1000 * _spd2 : 0;
      const bufferEdge = (_lwMs2 > 0) ? (b.maxMs - _lwMs2) : (b.maxMs - 1);
      var _inLiveWindow2 = hasBounds && tMs != null && isFinite(tMs) && tMs >= bufferEdge;
      // Only trigger if we CROSSED into the window this frame (were below, now at/above).
      // If the user scrubbed into the window, let playback continue to maxMs.
      var _crossedIntoLiveWindow = _inLiveWindow2 && isFinite(tMsBefore) && tMsBefore < bufferEdge;
    }
    if (!_pbIsRewinding &&
        map.getPlaybackPlaying() &&
        !map._playbackLiveFollow &&
        !_pbIsWheelCoasting &&
        didAdvanceTime && _pbVelocity >= 0 &&
        _crossedIntoLiveWindow) {
      // Don't auto-activate Live mode — just stop playback at the buffer edge.
      // The button will show "Live" (not highlighted) so the user can opt in.
      // map._playbackLiveFollow = true;
      // _pbPageAutoFollow = true;
      // try { localStorage.setItem(LIVE_MODE_STORAGE_KEY, "1"); } catch {}
      _pbVelocity = 0;
      _pbAtEndSincePerf = null;
      _pbIsRewinding = false;
      map.setPlaybackPlaying(false);
      updatePlaybackUi();
    }

    // UI updates
    const isActive = Math.abs(_pbVelocity) > _pbVelocityThreshold || Math.abs(_pbWheelAccum) > 0.1;
    const uiMinDt = isActive ? 16 : 250;
    if ((didAdvanceTime || isActive) && (now - _pbLastUiPerf) >= uiMinDt) {
      updatePlaybackUi();
      updateSidebarPlaybackValues();
      _pbLastUiPerf = now;
    }

    // Sync legend tab to selected marker's displayed pollutant (changes during scrub)
    syncLegendToMapSelection();

    // ── Barrel jog wheel: sync position & render ──
    if (_barrelMode && _jogWheel) {
      const b2 = map.getPlaybackBounds();
      const t2 = map.getPlaybackTimeMs();
      if (isFinite(b2.minMs) && isFinite(b2.maxMs) && b2.maxMs > b2.minMs && isFinite(t2)) {
        const frac = (t2 - b2.minMs) / (b2.maxMs - b2.minMs);
        if (!_jogWheel.isScrubbing()) _jogWheel.setPosition(frac);
      }
      _jogWheel.render();
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
    map._playbackLiveFollow = true;
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
      // Buffer snap target: always calculated regardless of speed.
      // Live window (button shows "Live"): only for 1x and 5x.
      const _spd = map.getPlaybackSpeed() || 1.0;
      const _nextInS3 = Number(map.lastState?.meta?.polling_next_update_in_s) ?? Number(map.lastState?.meta?.polling_predicted_interval_s) ?? 600;
      const _wallElapsed = (Date.now() - _pbLastServerResponseMs) / 1000;
      const _remS = Math.max(0, _nextInS3 - _wallElapsed);
      const _snapMs = _remS * 1000 * _spd;
      const _lwMs = (_spd <= 5) ? _snapMs : 0;
      const curMs = map.getPlaybackTimeMs();
      const inLiveWindow = atEnd || (
        _lwMs > 0 && curMs != null && isFinite(curMs) && curMs >= b.maxMs - _lwMs
      );
      
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

      // If in live window (1x/5x), enable LIVE mode (not available for historical replays)
      if (inLiveWindow && _spd <= 5 && !map._playbackLiveFollow && !map._historicalMode) {
        map._playbackLiveFollow = true;
        _pbPageAutoFollow = true; // resume page tracking in LIVE mode
        try { localStorage.setItem(LIVE_MODE_STORAGE_KEY, "1"); } catch {}
        // Snap playhead to leading edge of buffer
        if (_snapMs > 0) {
          const bufferStart = Math.max(b.minMs, b.maxMs - _snapMs);
          map.setPlaybackTimeMs(bufferStart);
        }
        _pbVelocity = 0;
        _pbAtEndSincePerf = null;
        _pbIsRewinding = false;
        map.setPlaybackPlaying(true);
        _pbLastPerf = 0;
        if (!_pbRAF) _pbRAF = requestAnimationFrame(playbackLoop);
        updatePlaybackUi();
        return;
      }

      // >5x at end: snap to buffer position and play (no Live mode)
      if (atEnd && _spd > 5 && _snapMs > 0) {
        const bufferStart = Math.max(b.minMs, b.maxMs - _snapMs);
        map.setPlaybackTimeMs(bufferStart);
        _pbVelocity = _pbPlaybackSpeed * _spd;
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
      const prevSpeed = map.getPlaybackSpeed() || 1.0;
      map.setPlaybackSpeed(pbSpeedEl.value);
      localStorage.setItem("mobileair.playbackSpeed", pbSpeedEl.value);
      const newSpeed = map.getPlaybackSpeed() || 1.0;

      // If in LIVE mode, recalculate buffer position when speed changes.
      if (map._playbackLiveFollow) {
        // Speeds >5x don't support Live mode
        if (newSpeed > 5) {
          map._playbackLiveFollow = false;
          try { localStorage.setItem(LIVE_MODE_STORAGE_KEY, "0"); } catch {}
          _resetLiveTracking();
        } else {
          // Recalculate buffer start for the new speed.
          // Larger speed = larger buffer window = playhead must move back.
          // Smaller speed = smaller buffer window = playhead should move forward
          //   (otherwise it's behind the new buffer start and Live button state
          //   becomes inconsistent — the user expects to be "caught up").
          const b = map.getPlaybackBounds();
          if (isFinite(b.minMs) && isFinite(b.maxMs) && b.maxMs > b.minMs) {
            const meta = map.lastState?.meta || {};
            const nextInS = Number(meta.polling_next_update_in_s) ?? Number(meta.polling_predicted_interval_s) ?? 600;
            const wallElapsed = (Date.now() - _pbLastServerResponseMs) / 1000;
            const remS = Math.max(0, nextInS - wallElapsed);
            const snapMs = remS * 1000 * newSpeed;
            if (snapMs > 0) {
              const bufferStart = Math.max(b.minMs, b.maxMs - snapMs);
              const curMs = map.getPlaybackTimeMs();
              if (curMs != null && isFinite(curMs)) {
                // Speed increased: snap back if ahead of new (larger) buffer start
                // Speed decreased: snap forward if behind new (smaller) buffer start
                if (curMs > bufferStart || curMs < bufferStart) {
                  map.setPlaybackTimeMs(bufferStart);
                  // Reset LIVE tracking so buffer accumulation restarts from here
                  _pbLiveStartWallMs = performance.now();
                  _pbLiveStartDataMs = b.maxMs;
                }
              }
            }
          }
        }
      }

      updatePlaybackUi();
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // BACKGROUND RESYNC: When app returns to foreground, snap playhead forward.
  // requestAnimationFrame pauses when backgrounded, so the playhead freezes
  // while real time keeps flowing.  On reactivation, jump to where we should be.
  // ─────────────────────────────────────────────────────────────────────────────
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (!map._playbackLiveFollow) return; // only applies in LIVE mode
    const b = map.getPlaybackBounds();
    if (!isFinite(b.minMs) || !isFinite(b.maxMs) || b.maxMs <= b.minMs) return;
    const speed = map.getPlaybackSpeed() || 1.0;
    const meta = map.lastState?.meta || {};
    const nextInS = Number(meta.polling_next_update_in_s) ?? Number(meta.polling_predicted_interval_s) ?? 600;
    const wallElapsed = (Date.now() - _pbLastServerResponseMs) / 1000;
    const remS = Math.max(0, nextInS - wallElapsed);
    const bufferMs = remS * 1000 * speed;
    if (bufferMs > 0) {
      const bufferStart = Math.max(b.minMs, b.maxMs - bufferMs);
      map.setPlaybackTimeMs(bufferStart);
      // Restart LIVE tracking from current position
      _pbLiveStartWallMs = performance.now();
      _pbLiveStartDataMs = b.maxMs;
      // Reset the frame timer so dt doesn't include backgrounded time
      _pbLastPerf = 0;
      updatePlaybackUi();
    }
  });

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
      // Clear all per-vehicle caches from historical viewing
      map.clearVehicleCaches();
      map._playbackPtsById = new Map();
      map._playbackPtsKey = null;
      map._playbackNowMs = null;
      map._playbackInitialized = false;
      map._playbackLiveFollow = true;
      // Clear historical wind — live fetch will repopulate
      map._windSnapshots = null;
      map._windSnapshotKeys = [];
      map._windField = null;
      map._windFieldEtag = null;
      map._windFieldLastFetch = 0;
      // Restore live state to the map immediately
      const liveSt = window.__lastState || { mobile: [], fixed: [] };
      map.lastState = liveSt;
      map._ensurePlaybackPoints(liveSt);
      map.drawOverlay(liveSt);
      renderLists(liveSt, selectedId);
      renderDetails(liveSt, selectedId);
      // Update status bar
      const statusEl = document.getElementById("statusText");
      if (statusEl) {
        statusEl.textContent = "Live";
        statusEl.classList.add("live");
        statusEl.classList.remove("offline");
      }
      updateSaveButtonState();
      // Trigger an immediate live poll to get fresh data
      setTimeout(tick, 100);
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
      // Load from local snapshots — we already store all data (mobile, fixed,
      // purpleair, etc.) so there's no need to fetch from upstream history servers.
      const resp = await fetch(`${appConfig.apiBaseUrl}/snapshot/load?date=${encodeURIComponent(dateStr)}`);
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.error || `No snapshot for ${dateStr}`);
      }
      const loadedState = await resp.json();

      // Validate the loaded data before using it
      if (!validateStateSchema(loadedState)) {
        throw new Error("Invalid data structure in snapshot");
      }
      
      _mapImmobileToParked(loadedState);
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
      
      // Release accumulated live-polling state — not needed during history
      // and can be very large (unbounded trail concatenation).
      _accumulatedState = null;
      _newestTrailMs = null;
      _stateEtag = null;

      // Reset ALL playback state and per-vehicle caches for fresh historical data.
      // Without this, smooth-path, physics, and trace caches from prior snapshots
      // accumulate and progressively slow the render loop.
      map.clearVehicleCaches();
      map._historicalMode = true;
      map._playbackPtsById = new Map();
      map._playbackPtsKey = null;
      map._persistedTrailById = new Map();  // Clear persisted trails
      map._playbackNowMs = null;  // Reset playback time
      _pbPageIndex = -1;  // Reset paging for new data
      _pbPageAutoFollow = true;
      _pbSlidingWindowCenter = null;

      // Enable DVR/playback mode for historical data
      // NOTE: setPlaybackMode(true) sets _playbackLiveFollow=true and draws overlay,
      // so we must disable live follow AFTER and avoid the internal draw.
      map.playbackMode = true;  // Set directly to avoid immediate draw
      map._playbackLiveFollow = false;  // Historical always starts at beginning, not live tail
      if (traceEl) traceEl.checked = true;
      if (pbBarEl) pbBarEl.classList.remove("hidden");
      
      // Build playback points and set time to 5AM
      map._ensurePlaybackPoints(window._historicalState);
      const b = map.getPlaybackBounds();
      if (isFinite(b.minMs)) {
        // Set playhead to 5AM local on the loaded day
        let initMs;
        if (dateStr === "demo") {
          // Demo snapshot: start at 5AM using bounds
          const startDate = new Date(b.minMs);
          const fiveAM = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate(), 5, 0, 0, 0).getTime();
          initMs = clamp(fiveAM, b.minMs, b.maxMs);
        } else {
          const baseDateStr = dateStr.replace(/\s*\(.*\)$/, "");
          const [_y, _mo, _d] = baseDateStr.split("-").map(Number);
          const fiveAM = new Date(_y, _mo - 1, _d, 5, 0, 0, 0).getTime();
          initMs = clamp(fiveAM, b.minMs, b.maxMs);
        }
        map.setPlaybackTimeMs(initMs);
      }
      
      // Store state, render sidebar, draw ONLY tiles (no overlay yet)
      map.lastState = window._historicalState;
      map.drawTiles();
      renderLists(window._historicalState, selectedId);
      
      if (statusEl) {
        statusEl.textContent = `Snapshot: ${dateStr}`;
        statusEl.classList.remove("live");
      }
      
      updatePlaybackUi();
      
      // Draw overlay NOW with playback time already set
      map.drawOverlay(window._historicalState);
      
      // Fetch road edges for debug visualization if enabled
      if (map._pbDebugPath && map._pbDebugRoadLines) {
        map._fetchRoadEdgesForViewport();
      }
      
      // Start playback loop (auto-play)
      _pbLastPerf = 0;
      _pbLastUiPerf = 0;
      _pbVelocity = _pbPlaybackSpeed * (map.getPlaybackSpeed() || 1.0);
      map.setPlaybackPlaying(true);
      updatePlaybackUi();
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
    if (map._historicalMode) {
      console.warn("Cannot save: viewing historical snapshot");
      return;
    }
    const statusEl = document.getElementById("statusText");
    const dateStr = getSnapshotDateStr();
    
    try {
      const resp = await fetch(`${appConfig.apiBaseUrl}/snapshot/save?date=${encodeURIComponent(dateStr)}`, {
        method: "POST",
        headers: { "Content-Length": "0" },
        credentials: "same-origin",
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

  async function loadSnapshotByDate(dateStr, extraParams = "") {
    const statusEl = document.getElementById("statusText");
    if (statusEl) {
      statusEl.textContent = "Loading...";
      statusEl.classList.remove("live");
    }
    
    // Disable save while loading
    _isLoadingData = true;
    updateSaveButtonState();
    
    try {
      const resp = await fetch(`${appConfig.apiBaseUrl}/snapshot/load?date=${encodeURIComponent(dateStr)}${extraParams}`);
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${resp.status}`);
      }
      const loadedState = await resp.json();
      
      // Validate the loaded data before using it
      if (!validateStateSchema(loadedState)) {
        throw new Error("Invalid data structure in snapshot");
      }
      
      _mapImmobileToParked(loadedState);
      window._historicalState = loadedState;

      // Load wind snapshots from the historical snapshot if present
      if (loadedState.wind_snapshots && typeof loadedState.wind_snapshots === "object") {
        map._windSnapshots = loadedState.wind_snapshots;
        map._windSnapshotKeys = Object.keys(loadedState.wind_snapshots).sort();
        if (map._windSnapshotKeys.length > 0) {
          const latest = map._windSnapshotKeys[map._windSnapshotKeys.length - 1];
          map._windField = loadedState.wind_snapshots[latest];
        }
      } else {
        map._windSnapshots = null;
        map._windSnapshotKeys = [];
        map._windField = null;
      }

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
      _pbPageIndex = -1;  // Reset paging for new data
      _pbPageAutoFollow = true;
      _pbSlidingWindowCenter = null;

      // Enable DVR/playback mode
      map.playbackMode = true;
      map._playbackLiveFollow = false;
      if (traceEl) traceEl.checked = true;
      if (pbBarEl) pbBarEl.classList.remove("hidden");
      
      // Build playback points and set time to 30 min in (so trails are visible)
      map._ensurePlaybackPoints(window._historicalState);
      const b = map.getPlaybackBounds();
      if (isFinite(b.minMs)) {
        map.setPlaybackTimeMs(b.minMs + 30 * 60000);
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
      
      // Start playback loop (auto-play)
      _pbLastPerf = 0;
      _pbLastUiPerf = 0;
      _pbVelocity = _pbPlaybackSpeed * (map.getPlaybackSpeed() || 1.0);
      map.setPlaybackPlaying(true);
      updatePlaybackUi();
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
  const autoCameraBtn = document.getElementById("autoCameraBtn");

  function _updateAutoCameraBtn() {
    if (!autoCameraBtn) return;
    autoCameraBtn.classList.toggle("active", _autoCameraEnabled);
    autoCameraBtn.title = `Auto-center camera: ${_autoCameraEnabled ? "on" : "off"}`;
    autoCameraBtn.setAttribute("aria-label", `Toggle auto-center camera (currently ${_autoCameraEnabled ? "on" : "off"})`);
  }
  _updateAutoCameraBtn();

  if (autoCameraBtn) {
    autoCameraBtn.addEventListener("click", () => {
      _autoCameraEnabled = !_autoCameraEnabled;
      _updateAutoCameraBtn();
      // Immediately fly camera to vehicles when toggling on.
      if (_autoCameraEnabled) _performCameraFit({ force: true });
    });
  }
  
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
  
  async function updateDaysSubmenu() {
    if (!pbDaysSubmenu) return;
    pbDaysSubmenu.innerHTML = "";

    // Fetch available snapshots to know which days have data
    const snapshotDates = new Map(); // dateStr -> {size_bytes, demo}
    try {
      const resp = await fetch(`${appConfig.apiBaseUrl}/snapshots`);
      if (resp.ok) {
        const data = await resp.json();
        for (const snap of (data.snapshots || [])) {
          snapshotDates.set(snap.date, { size_bytes: snap.size_bytes, demo: !!snap.demo });
        }
      }
    } catch (e) {
      console.warn("Failed to fetch snapshot list:", e);
    }

    // Always show Today (Live) first
    const liveItem = document.createElement("div");
    liveItem.className = "pbSubmenuItem" + (_selectedDayValue === "live" ? " active" : "");
    liveItem.textContent = "🔮 Today (Live)";
    liveItem.addEventListener("click", (e) => {
      e.stopPropagation();
      _selectedDayValue = "live";
      loadHistoricalDay("live");
      closePlaybackMenu();
    });
    pbDaysSubmenu.appendChild(liveItem);

    // Show demo entries from the snapshot list (if any)
    for (const [snap, info] of snapshotDates.entries()) {
      if (!info.demo) continue;
      const item = document.createElement("div");
      item.className = "pbSubmenuItem";
      if (_selectedDayValue === snap) item.classList.add("active");
      item.textContent = `🧪 ${snap} (demo)`;
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        _selectedDayValue = snap;
        loadHistoricalDay(snap);
        closePlaybackMenu();
      });
      pbDaysSubmenu.appendChild(item);
    }

    // Show the past 7 days, every day, snapshot or not
    const now = new Date();
    for (let i = 1; i <= 7; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      const dateStr = `${yyyy}-${mm}-${dd}`;
      const dayName = d.toLocaleDateString("en-US", { weekday: "short" });
      const monthDay = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const snapInfo = snapshotDates.get(dateStr);
      const hasSnapshot = snapInfo && !snapInfo.demo;

      const item = document.createElement("div");
      item.className = "pbSubmenuItem";
      if (hasSnapshot) {
        const sizeMB = (snapInfo.size_bytes / (1024 * 1024)).toFixed(1);
        item.textContent = `${dayName} ${monthDay} (${sizeMB} MB)`;
        if (_selectedDayValue === dateStr) item.classList.add("active");
        item.addEventListener("click", (e) => {
          e.stopPropagation();
          _selectedDayValue = dateStr;
          loadHistoricalDay(dateStr);
          closePlaybackMenu();
        });
      } else {
        item.textContent = `${dayName} ${monthDay}`;
        item.style.opacity = "0.35";
        item.style.pointerEvents = "none";
      }
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
  
  // ── Owner token secret tap state ──
  let _aboutTapCount = 0;
  let _aboutTapTimer = null;

  function showAboutModal() {
    const modal = document.getElementById("aboutModal");
    if (!modal) return;
    modal.classList.remove("hidden");

    // Reset token section visibility each time modal opens
    const tokenSection = document.getElementById("ownerTokenSection");
    const tokenInput = document.getElementById("ownerTokenInput");
    const tokenSaveBtn = document.getElementById("ownerTokenSave");
    const tokenStatus = document.getElementById("ownerTokenStatus");
    if (tokenSection) tokenSection.classList.add("hidden");
    _aboutTapCount = 0;

    // Tap version label 5 times to reveal token input
    const versionEl = modal.querySelector(".aboutVersion");
    if (versionEl) {
      versionEl.style.cursor = "default";
      versionEl.onclick = () => {
        _aboutTapCount++;
        clearTimeout(_aboutTapTimer);
        _aboutTapTimer = setTimeout(() => { _aboutTapCount = 0; }, 2000);
        if (_aboutTapCount >= 5) {
          _aboutTapCount = 0;
          if (tokenSection) {
            tokenSection.classList.remove("hidden");
            if (tokenInput) tokenInput.value = localStorage.getItem("dusty_owner_tok") || "";
            if (tokenStatus) tokenStatus.textContent = "";
          }
        }
      };
    }

    // Save token button
    if (tokenSaveBtn && tokenInput) {
      tokenSaveBtn.onclick = async () => {
        const val = (tokenInput.value || "").trim();
        if (val) {
          localStorage.setItem("dusty_owner_tok", val);
          // Exchange for HttpOnly cookie immediately
          try {
            const res = await fetch("/api/auth", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ token: val }),
              credentials: "same-origin",
            });
            if (tokenStatus) tokenStatus.textContent = res.ok ? "Saved & authenticated. Reload to apply." : "Saved but auth failed — check token.";
          } catch (_) {
            if (tokenStatus) tokenStatus.textContent = "Saved. Reload to apply.";
          }
        } else {
          localStorage.removeItem("dusty_owner_tok");
          // Clear the auth cookie
          try { await fetch("/api/auth", { method: "DELETE", credentials: "same-origin" }); } catch (_) {}
          if (tokenStatus) tokenStatus.textContent = "Cleared.";
        }
      };
    }

    const closeBtn = modal.querySelector(".aboutModalClose");
    const onClose = () => {
      modal.classList.add("hidden");
      closeBtn.removeEventListener("click", onClose);
    };
    closeBtn.addEventListener("click", onClose);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) onClose();
    }, { once: true });
  }

  function handleMenuAction(action) {
    switch (action) {
      case "save":
        saveSnapshot();
        break;
      case "load":
        showLoadModal();
        break;
      case "about":
        showAboutModal();
        break;
      case "debug":
        if (window._fdToggle) window._fdToggle();
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

  // Debug button in playback bar
  {
    const dbBtn = document.getElementById("pbDebugBtn");
    if (dbBtn) dbBtn.addEventListener("click", () => { if (window._fdToggle) window._fdToggle(); });
  }
  
  // Share button - opens native share dialog.
  // Hidden on desktop (browser already has a share/URL bar).
  // Only shown in standalone PWA mode on mobile/tablet.
  {
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
    const isMobileUA = /iPad|iPhone|iPod|Android/i.test(navigator.userAgent)
      || (navigator.maxTouchPoints > 1);
    if (shareBtn && navigator.share && isStandalone && isMobileUA) {
      shareBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        shareBtn.classList.add("open");
        try {
          await navigator.share({ title: "DustyTrails", url: window.location.href });
        } catch (_) {}
        shareBtn.classList.remove("open");
      });
    } else if (shareBtn) {
      shareBtn.style.display = "none";
    }
  }
  
  // Display submenu (dim/sat sliders in three-dot menu)
  const pbDisplaySubmenu = document.getElementById("pbDisplaySubmenu");
  const menuDimEl = document.getElementById("menuDim");
  const menuSatEl = document.getElementById("menuSat");
  const menuAlphaEl = document.getElementById("menuAlpha");

  // PA field alpha: restore from localStorage (0-100%)
  {
    const raw = localStorage.getItem(PA_ALPHA_STORAGE_KEY);
    const v = raw != null ? Number(raw) : 18;
    const pct = Math.max(0, Math.min(100, isFinite(v) ? v : 18));
    window._paFieldAlpha = Math.round(pct * 2.55);
    if (menuAlphaEl) menuAlphaEl.value = pct;
  }

  // Wire up Display submenu hover (uses centralized debounce)
  const pbDisplaySubEl = document.querySelector(".pbMenuSub[data-submenu='display']");
  if (pbDisplaySubEl && pbDisplaySubmenu) {
    function syncDisplaySliders() {
      if (menuDimEl && dimEl) menuDimEl.value = dimEl.value;
      if (menuSatEl && satEl) menuSatEl.value = satEl.value;
      if (menuAlphaEl) {
        const raw = localStorage.getItem(PA_ALPHA_STORAGE_KEY);
        const v = raw != null ? Number(raw) : 18;
        menuAlphaEl.value = Math.max(0, Math.min(100, isFinite(v) ? v : 18));
      }
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
    if (menuAlphaEl) {
      menuAlphaEl.addEventListener("input", () => {
        const pct = Math.max(0, Math.min(100, Number(menuAlphaEl.value) || 0));
        window._paFieldAlpha = Math.round(pct * 2.55);
        localStorage.setItem(PA_ALPHA_STORAGE_KEY, String(pct));
        if (map) { map._paFieldKey = null; map._paFieldValidRange = null; map._redrawViewOnly(); }
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
      // When paging is active, slider is relative to the page range
      const pr = _pbPagingActive() ? _pbGetPageRange() : b;
      const relMs = Number(pbScrubEl.value);
      if (!isFinite(relMs)) return;
      const tMs = pr.minMs + relMs;
      const clampedT = clamp(tMs, b.minMs, b.maxMs);

      map.setPlaybackTimeMs(clampedT);

      // Don't auto-enable LIVE mode when dragging - user must click the Live button.
      // Just track where the user left the playhead as replay point A.
      _pbLoopStartMs = clampedT;

      updatePlaybackUi();
      map._compositePaFieldOnTiles(map.lastState);
      map.drawOverlay(map.lastState);

      // Start or stop edge-jog during drag
      if (_pbScrubbing && _pbSlidingWindowCenter != null) {
        _pbStartEdgeJog();
      }
    };

    // Edge-jog: when the slider thumb is in the outer 10% during a drag,
    // continuously shift the sliding window in that direction.
    const _pbEdgeThreshold = 0.10; // outer 10% of slider triggers jog
    function _pbStartEdgeJog() {
      if (_pbJogRAF) return; // already running
      _pbJogLastPerf = performance.now();
      _pbJogRAF = requestAnimationFrame(_pbEdgeJogTick);
    }
    function _pbStopEdgeJog() {
      if (_pbJogRAF) { cancelAnimationFrame(_pbJogRAF); _pbJogRAF = null; }
    }
    function _pbEdgeJogTick(now) {
      _pbJogRAF = null;
      if (!_pbScrubbing || _pbSlidingWindowCenter == null) return;

      const maxVal = Number(pbScrubEl.max);
      const curVal = Number(pbScrubEl.value);
      if (!maxVal) return;
      const frac = curVal / maxVal; // 0..1 position within window

      // Determine jog direction and intensity
      let jogDir = 0;
      let intensity = 0;
      if (frac >= 1 - _pbEdgeThreshold) {
        jogDir = 1; // jog forward
        intensity = (frac - (1 - _pbEdgeThreshold)) / _pbEdgeThreshold; // 0..1
      } else if (frac <= _pbEdgeThreshold) {
        jogDir = -1; // jog backward
        intensity = (_pbEdgeThreshold - frac) / _pbEdgeThreshold; // 0..1
      }

      if (jogDir !== 0) {
        const dt = now - _pbJogLastPerf;
        // Jog speed: up to 1 page-width per second at full intensity
        const jogSpeed = _pbPageSizeMs * intensity * 1.0;
        const shift = jogDir * jogSpeed * (dt / 1000);

        const gb = map.getPlaybackBounds();
        const prevCenter = _pbSlidingWindowCenter;
        _pbSlidingWindowCenter = clamp(
          _pbSlidingWindowCenter + shift,
          gb.minMs + _pbPageSizeMs / 2,
          gb.maxMs - _pbPageSizeMs / 2
        );

        // Re-apply scrub with the new window position — the absolute time
        // the thumb maps to changes as the window shifts under it.
        const pr = _pbGetPageRange();
        const relMs = Number(pbScrubEl.value);
        const tMs = clamp(pr.minMs + relMs, gb.minMs, gb.maxMs);
        map.setPlaybackTimeMs(tMs);
        _pbLoopStartMs = tMs;

        // Always update timestamp display during jog, even if window is
        // clamped to the data boundary (so the user sees the time isn't moving).
        updatePlaybackUi();
        map.drawOverlay(map.lastState);
      } else {
        // Not in the jog zone — still update the timestamp so it's never stale
        // after the user drags out of the edge zone.
        updatePlaybackUi();
      }

      _pbJogLastPerf = now;
      // Keep ticking while dragging
      if (_pbScrubbing) {
        _pbJogRAF = requestAnimationFrame(_pbEdgeJogTick);
      }
    }

    // ─── Mouse/pen track-drag: jogger sensitivity for clicks outside the nub ──
    let _scrubPointerOnTrack = false;
    let _scrubPointerStartX = null;
    let _scrubPointerStartVal = null;
    const _scrubPointerSensitivity = 0.3;

    pbScrubEl.addEventListener("pointerdown", (e) => {
      // Detect if pointer landed on the thumb vs the track (mouse/pen only)
      _scrubPointerOnTrack = false;
      if (e.pointerType !== "touch") {
        const rect = pbScrubEl.getBoundingClientRect();
        const range = Number(pbScrubEl.max) - Number(pbScrubEl.min);
        const curVal = Number(pbScrubEl.value);
        const thumbFrac = range > 0 ? (curVal - Number(pbScrubEl.min)) / range : 0;
        const thumbX = rect.left + thumbFrac * rect.width;
        if (Math.abs(e.clientX - thumbX) >= 12) {
          _scrubPointerOnTrack = true;
          _scrubPointerStartX = e.clientX;
          _scrubPointerStartVal = curVal;
          pbScrubEl.setPointerCapture(e.pointerId);
        }
      }
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
      // Activate sliding window: freeze the current window in place for the drag.
      // If already in sliding window mode, keep the existing center.
      // If in index-based mode, convert the current page center to a sliding window.
      if (_pbPagingActive() && _pbSlidingWindowCenter == null) {
        const pr = _pbGetPageRange();
        _pbSlidingWindowCenter = (pr.minMs + pr.maxMs) / 2;
      }
      updatePlaybackUi();
    });
    // Prevent native range-input snap when clicking the track (not the nub)
    pbScrubEl.addEventListener("mousedown", (e) => {
      if (_scrubPointerOnTrack) e.preventDefault();
    }, { capture: true });
    // Jogger-sensitivity drag when pointer started on the track
    pbScrubEl.addEventListener("pointermove", (e) => {
      if (!_scrubPointerOnTrack || !_pbScrubbing) return;
      const dx = e.clientX - _scrubPointerStartX;
      const rect = pbScrubEl.getBoundingClientRect();
      const range = Number(pbScrubEl.max) - Number(pbScrubEl.min);
      const delta = (dx / rect.width) * range * _scrubPointerSensitivity;
      const newVal = clamp(_scrubPointerStartVal + delta, Number(pbScrubEl.min), Number(pbScrubEl.max));
      pbScrubEl.value = String(newVal);
      _pbDidDrag = true;
      _pbLastScrubPos = newVal;
      _pbLastScrubTime = performance.now();
      if (!_scrubRAF) {
        _scrubRAF = requestAnimationFrame(() => {
          _scrubRAF = 0;
          applyScrub();
        });
      }
    });
    pbScrubEl.addEventListener("pointerup", () => {
      // On iOS Safari, pointerup fires BEFORE touchend during touch interactions.
      // Let touchend handle all cleanup/page-back to avoid double-fire issues
      // (e.g. pointerup pages back, then touchend undoes it via auto-follow).
      if (_scrubTouchStartX != null) return;

      _scrubPointerOnTrack = false;
      _scrubPointerStartX = null;
      _scrubPointerStartVal = null;
      _pbStopEdgeJog();
      _pbSnapWindowToPlayhead();
      _pbScrubbing = false;
      _pbVelocity = 0;
      _pbPageAutoFollow = true; // resume auto-following after manual scrub

      // Page back if slider is near the left edge (1% threshold)
      if (_pbPagingActive() && Number(pbScrubEl.value) <= Number(pbScrubEl.max) * 0.01) {
        const gb = map.getPlaybackBounds();
        const pr = _pbGetPageRange();
        if (pr.minMs > gb.minMs) {
          // Shift the sliding window left by one page
          if (_pbSlidingWindowCenter != null) {
            _pbSlidingWindowCenter = Math.max(gb.minMs + _pbPageSizeMs / 2, _pbSlidingWindowCenter - _pbPageSizeMs);
          } else if (_pbPageIndex > 0) {
            _pbSetPage(_pbPageIndex - 1);
          }
          const prev = _pbGetPageRange();
          map.setPlaybackTimeMs(prev.maxMs);
          _pbLoopStartMs = prev.maxMs;
          pbScrubEl.max = String(prev.maxMs - prev.minMs);
          pbScrubEl.value = pbScrubEl.max;
          map.setPlaybackPlaying(true);
          _pbLastPerf = performance.now();
          if (!_pbRAF) _pbRAF = requestAnimationFrame(playbackLoop);
          updatePlaybackUi();
          map.drawOverlay(map.lastState);
          return;
        }
      }

      // Don't auto-enable LIVE mode when released at end - user must click Live button.
      map.setPlaybackPlaying(true);
      _pbLastPerf = performance.now();
      if (!_pbRAF) _pbRAF = requestAnimationFrame(playbackLoop);
      applyScrub();

    });
    var _scrubRAF = 0;
    pbScrubEl.addEventListener("input", () => {
      if (_scrubPointerOnTrack) return; // track drag handled by pointermove
      const now = performance.now();
      const pos = Number(pbScrubEl.value);

      // User is dragging
      _pbDidDrag = true;
      _pbLastScrubPos = pos;
      _pbLastScrubTime = now;

      map.setPlaybackPlaying(false);
      // Coalesce rapid input events into a single rAF to avoid
      // overwhelming iPad Safari with drawOverlay() calls
      if (!_scrubRAF) {
        _scrubRAF = requestAnimationFrame(() => {
          _scrubRAF = 0;
          applyScrub();
        });
      }
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
      _pbPageAutoFollow = true; // resume page tracking when scrolling
      map.setPlaybackPlaying(false); // Let wheel nudge control velocity
      // Exit LIVE mode on scroll
      map._playbackLiveFollow = false;
      try { localStorage.setItem(LIVE_MODE_STORAGE_KEY, "0"); } catch {}
      _pbIsWheelCoasting = true;
      _pbCommitLoopStartOnCoastEnd = true;
      // Activate sliding window so the playhead isn't clamped to a fixed page boundary
      if (_pbPagingActive() && _pbSlidingWindowCenter == null) {
        const pr = _pbGetPageRange();
        _pbSlidingWindowCenter = (pr.minMs + pr.maxMs) / 2;
      }
      // Two-finger swipe (deltaX) or vertical scroll wheel (deltaY): scrub through time.
      // deltaX > 0 = swipe right = backward; deltaY > 0 = scroll down = forward.
      const b = map.getPlaybackBounds();
      const durMs = (b.maxMs - b.minMs) || 1;
      const isHorizontal = Math.abs(e.deltaX) >= Math.abs(e.deltaY);
      const isMouseWheel = e.deltaMode !== 0 || (!e.ctrlKey && Math.abs(e.deltaX) < 1 && Math.abs(e.deltaY) >= 4);
      // Mouse wheel: flip direction (scroll down = forward). Trackpad swipe: keep native.
      const delta = isHorizontal ? e.deltaX : (isMouseWheel ? e.deltaY : -e.deltaY) * 0.15;
      const nudge = (delta / 1000) * (durMs / 480);
      const prevDir = Math.sign(_pbVelocity);
      _pbVelocity -= nudge;
      // On direction reversal, snap window so playhead stays just outside the jog zone
      if (prevDir !== 0 && Math.sign(_pbVelocity) !== 0 && Math.sign(_pbVelocity) !== prevDir) {
        _pbSnapWindowToPlayhead();
        updatePlaybackUi();
      }
      // Ensure loop is running
      if (!_pbRAF) {
        _pbLastPerf = performance.now(); // valid dt for next frame
        _pbRAF = requestAnimationFrame(playbackLoop);
      }
    }, { passive: false });

    // ─── Touch drag override: reduce scrub sensitivity on mobile ───────────
    // Native range inputs track the finger 1:1, making long timelines
    // impossible to scrub precisely.  We intercept touch events, prevent
    // the default 1:1 tracking, and apply a 4× sensitivity reduction.
    let _scrubTouchStartX = null;
    let _scrubTouchStartVal = null;
    let _scrubTouchRawTarget = null;
    let _scrubTouchOnThumb = false;
    const _scrubTouchSensitivity = 0.3;

    pbScrubEl.addEventListener("touchstart", (e) => {
      e.preventDefault();  // stop native 1:1 range tracking
      const touch = e.touches[0];
      _scrubTouchStartX = touch.clientX;
      _scrubTouchStartVal = Number(pbScrubEl.value);
      // Detect if touch landed on the thumb: 1:1 tracking for thumb, reduced for track
      const rect = pbScrubEl.getBoundingClientRect();
      const range = Number(pbScrubEl.max) - Number(pbScrubEl.min);
      const thumbFrac = range > 0 ? (_scrubTouchStartVal - Number(pbScrubEl.min)) / range : 0;
      const thumbX = rect.left + thumbFrac * rect.width;
      _scrubTouchOnThumb = Math.abs(touch.clientX - thumbX) < 24;
      // Run the same setup as pointerdown (which won't fire since we prevented default)
      _pbVelocity = 0;
      _pbWheelAccum = 0;
      _pbAtEndSincePerf = null;
      _pbArrivedAtEndViaPlayback = false;
      _pbIsRewinding = false;
      _pbEaseStartPerf = null;
      _pbIsWheelCoasting = false;
      _pbScrubbing = true;
      _pbDidDrag = false;
      _pbLastScrubPos = Number(pbScrubEl.value);
      _pbLastScrubTime = performance.now();
      map.setPlaybackPlaying(false);
      map._playbackLiveFollow = false;
      try { localStorage.setItem(LIVE_MODE_STORAGE_KEY, "0"); } catch {}
      _resetLiveTracking();
      // Activate sliding window
      if (_pbPagingActive() && _pbSlidingWindowCenter == null) {
        const pr = _pbGetPageRange();
        _pbSlidingWindowCenter = (pr.minMs + pr.maxMs) / 2;
      }
      updatePlaybackUi();
    }, { passive: false });

    pbScrubEl.addEventListener("touchmove", (e) => {
      if (_scrubTouchStartX == null) return;
      e.preventDefault();
      const touch = e.touches[0];
      const dx = touch.clientX - _scrubTouchStartX;
      const rect = pbScrubEl.getBoundingClientRect();
      const range = Number(pbScrubEl.max) - Number(pbScrubEl.min);
      const sens = _scrubTouchOnThumb ? 1.0 : _scrubTouchSensitivity;
      const delta = (dx / rect.width) * range * sens;
      _scrubTouchRawTarget = _scrubTouchStartVal + delta;
      pbScrubEl.value = String(clamp(_scrubTouchRawTarget, Number(pbScrubEl.min), Number(pbScrubEl.max)));
      _pbDidDrag = true;
      _pbLastScrubPos = Number(pbScrubEl.value);
      _pbLastScrubTime = performance.now();
      if (!_scrubRAF) {
        _scrubRAF = requestAnimationFrame(() => {
          _scrubRAF = 0;
          applyScrub();
        });
      }
    }, { passive: false });

    pbScrubEl.addEventListener("touchend", () => {
      const rawTarget = _scrubTouchRawTarget;
      _scrubTouchStartX = null;
      _scrubTouchStartVal = null;
      _scrubTouchRawTarget = null;
      _scrubTouchOnThumb = false;
      // Cancel any pending applyScrub rAF so it doesn't overwrite page-back
      if (_scrubRAF) { cancelAnimationFrame(_scrubRAF); _scrubRAF = 0; }
      _pbStopEdgeJog();
      _pbSnapWindowToPlayhead();
      _pbScrubbing = false;
      _pbVelocity = 0;
      _pbPageAutoFollow = true;

      // Page back if user dragged past the left edge
      if (_pbPagingActive() && rawTarget != null && rawTarget < 0) {
        const gb = map.getPlaybackBounds();
        const pr = _pbGetPageRange();
        if (pr.minMs > gb.minMs) {
          if (_pbSlidingWindowCenter != null) {
            _pbSlidingWindowCenter = Math.max(gb.minMs + _pbPageSizeMs / 2, _pbSlidingWindowCenter - _pbPageSizeMs);
          } else if (_pbPageIndex > 0) {
            _pbSetPage(_pbPageIndex - 1);
          }
          const prev = _pbGetPageRange();
          map.setPlaybackTimeMs(prev.maxMs);
          _pbLoopStartMs = prev.maxMs;
          pbScrubEl.max = String(prev.maxMs - prev.minMs);
          pbScrubEl.value = pbScrubEl.max;
          map.setPlaybackPlaying(true);
          _pbLastPerf = performance.now();
          if (!_pbRAF) _pbRAF = requestAnimationFrame(playbackLoop);
          updatePlaybackUi();
          map.drawOverlay(map.lastState);
          return;
        }
      }

      map.setPlaybackPlaying(true);
      _pbLastPerf = performance.now();
      if (!_pbRAF) _pbRAF = requestAnimationFrame(playbackLoop);
      applyScrub();
    });
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

  // ─────────────────────────────────────────────────────────────────────────────
  // PAGE NAVIGATION BUTTONS
  // ─────────────────────────────────────────────────────────────────────────────
  if (pbPagePrevEl) {
    pbPagePrevEl.addEventListener("click", () => {
      if (_pbPageIndex <= 0) return;
      _pbSetPage(_pbPageIndex - 1);
      // Jump playhead to start of new page
      const pr = _pbGetPageRange();
      map.setPlaybackTimeMs(pr.minMs);
      _pbLoopStartMs = pr.minMs;
      map.drawOverlay(map.lastState);
    });
  }
  if (pbPageNextEl) {
    pbPageNextEl.addEventListener("click", () => {
      const total = _pbPageCount();
      if (_pbPageIndex >= total - 1) return;
      _pbSetPage(_pbPageIndex + 1);
      // Jump playhead to start of new page
      const pr = _pbGetPageRange();
      map.setPlaybackTimeMs(pr.minMs);
      _pbLoopStartMs = pr.minMs;
      map.drawOverlay(map.lastState);
    });
  }

  const POLL_MS = 120000;  // 2-min fallback poll interval (PurpleAir updates ~every 2 min)
  const POLL_MS_SSE = 600000; // 10-min safety-net poll when SSE is connected
  let _tickTimeout = null; // dynamic poll scheduler handle
  let _tickInFlight = false;
  let _tickInFlightSince = 0;  // perf timestamp when _tickInFlight was set
  let _tickLastForceRefreshSeq = null;
  let _tickConsecutiveFailures = 0; // for exponential backoff on errors

  /**
   * Map backend "immobile" field → frontend "parked" field on all mobile sensors.
   * The backend sends `immobile: bool` but the UI reads `parked`.
   */
  function _mapImmobileToParked(st) {
    if (!st || !Array.isArray(st.mobile)) return;
    for (var i = 0; i < st.mobile.length; i++) {
      var m = st.mobile[i];
      if (m && m.immobile != null) m.parked = !!m.immobile;
    }
  }

  // ── SSE (Server-Sent Events) — push-based state change notifications ──
  let _sseConnected = false;
  let _sseLastSeq = null;
  let _sseSource = null;

  // ── Client ID (persistent across sessions) ──
  var _clientId = localStorage.getItem("dusty_client_id");
  if (!_clientId) {
    _clientId = (typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID()
      : "c_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem("dusty_client_id", _clientId);
  }

  // ── Analytics batching ──
  var _analyticsQueue = [];
  var _analyticsLastFlush = 0;
  var _ANALYTICS_FLUSH_MS = 300000; // 5 min

  function _flushAnalytics() {
    if (!_analyticsQueue.length) return;
    var events = _analyticsQueue.splice(0, 50);
    var body = JSON.stringify({ client_id: _clientId, events: events });
    try {
      fetch((appConfig.apiBaseUrl || "/api") + "/analytics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body
      }).catch(function() {});
    } catch (e) {}
    _analyticsLastFlush = Date.now();
  }

  function pushAnalyticsEvent(type, payload) {
    _analyticsQueue.push({ type: type, payload: payload });
    if (Date.now() - _analyticsLastFlush > _ANALYTICS_FLUSH_MS) {
      _flushAnalytics();
    }
  }

  /**
   * Merge an SSE delta into the current live state.
   * delta.trail_new: { sensorId: [points...], ... }
   * delta.mobile: [ { id, lat, lon, idle, readings }, ... ]
   */
  function _mergeDelta(delta) {
    var st = window.__lastState;
    if (!st || !st.mobile) return false;

    var changed = false;

    // Merge new trail points
    var trailNew = delta.trail_new;
    if (trailNew && typeof trailNew === "object") {
      var mobileById = {};
      for (var i = 0; i < st.mobile.length; i++) {
        var m = st.mobile[i];
        if (m && m.id) mobileById[m.id] = m;
      }
      for (var sid in trailNew) {
        var sensor = mobileById[sid] || mobileById["mobile:" + sid];
        if (!sensor) continue;
        var existing = sensor.trail || [];
        var incoming = trailNew[sid];
        if (!Array.isArray(incoming) || !incoming.length) continue;
        // Find the latest timestamp in existing trail to avoid duplicates
        var maxExistingT = 0;
        for (var j = existing.length - 1; j >= 0 && j >= existing.length - 5; j--) {
          var pt = existing[j];
          if (pt && typeof pt.t === "number" && pt.t > maxExistingT) maxExistingT = pt.t;
        }
        var appended = 0;
        for (var k = 0; k < incoming.length; k++) {
          var np = incoming[k];
          if (np && typeof np.t === "number" && np.t > maxExistingT) {
            existing.push(np);
            appended++;
          }
        }
        if (appended > 0) {
          sensor.trail = existing;
          changed = true;
        }
      }
    }

    // Merge mobile sensor summaries (readings, position)
    var mobileSummaries = delta.mobile;
    if (Array.isArray(mobileSummaries)) {
      var byId = {};
      for (var mi = 0; mi < st.mobile.length; mi++) {
        if (st.mobile[mi] && st.mobile[mi].id) byId[st.mobile[mi].id] = st.mobile[mi];
      }
      for (var si = 0; si < mobileSummaries.length; si++) {
        var summ = mobileSummaries[si];
        if (!summ || !summ.id) continue;
        var target = byId[summ.id];
        if (!target) continue;
        if (summ.lat != null) target.lat = summ.lat;
        if (summ.lon != null) target.lon = summ.lon;
        if (summ.immobile != null) { target.immobile = summ.immobile; target.parked = !!summ.immobile; }
        if (summ.readings) target.readings = summ.readings;
        changed = true;
      }
    }

    // Update meta timestamps
    if (delta.ts) {
      st.ts = delta.ts;
      if (st.meta) st.meta.ts = delta.ts;
    }

    return changed;
  }

  var _sseDeferTimer = null; // deferred render after gesture settles

  function connectSSE() {
    if (_sseSource) { try { _sseSource.close(); } catch {} }
    var url = (appConfig.apiBaseUrl || "/api") + "/events";
    _sseSource = new EventSource(url);

    _sseSource.onopen = function () {
      _sseConnected = true;
      // Shorten the next scheduled poll now that SSE is live.
      if (_tickTimeout) {
        clearTimeout(_tickTimeout);
        _tickTimeout = setTimeout(tick, POLL_MS_SSE);
      }
    };

    // Named event: "delta" — incremental state update pushed by server
    _sseSource.addEventListener("delta", function (ev) {
      try {
        var delta = JSON.parse(ev.data);
        var seq = delta.seq;
        if (seq != null && seq !== _sseLastSeq) {
          _sseLastSeq = seq;
          // Skip delta merge if viewing historical data
          if (window._historicalState || _isLoadingData) return;
          if (_mergeDelta(delta) && map) {
            if (map._isGesturing()) {
              // State merged in-place; gesture redraws reflect it via lastState ref.
              // Defer full render + sidebar until gesture settles.
              clearTimeout(_sseDeferTimer);
              _sseDeferTimer = setTimeout(function() {
                map.draw(window.__lastState);
                try { renderLists(window.__lastState, selectedId); } catch (e) {}
                try { renderDetails(window.__lastState, selectedId); } catch (e) {}
              }, 300);
            } else {
              map.draw(window.__lastState);
              try { renderLists(window.__lastState, selectedId); } catch (e) {}
              try { renderDetails(window.__lastState, selectedId); } catch (e) {}
            }
          }
          // Reschedule safety-net poll
          if (_tickTimeout) clearTimeout(_tickTimeout);
          _tickTimeout = setTimeout(tick, POLL_MS_SSE);
        }
      } catch (e) { try { console.warn("[SSE delta]", e); } catch {} }
    });

    // Named event: "wind" — new wind snapshot pushed by server
    _sseSource.addEventListener("wind", function (ev) {
      try {
        var snap = JSON.parse(ev.data);
        if (snap.key && snap.points && map) {
          map.mergeWindSnapshot(snap.key, snap.points);
        }
      } catch (e) { try { console.warn("[SSE wind]", e); } catch {} }
    });

    // Default "message" event — backward-compatible notification
    _sseSource.onmessage = function (ev) {
      try {
        var msg = JSON.parse(ev.data);
        var seq = msg.seq;
        if (seq != null && seq !== _sseLastSeq) {
          _sseLastSeq = seq;
          // New data available — fetch immediately.
          if (_tickTimeout) clearTimeout(_tickTimeout);
          tick();
        }
      } catch {}
    };

    _sseSource.onerror = function () {
      _sseConnected = false;
      // EventSource auto-reconnects; revert to normal polling in the meantime.
      if (_tickTimeout) {
        clearTimeout(_tickTimeout);
        _tickTimeout = setTimeout(tick, POLL_MS);
      }
    };
  }

  async function tick() {
    // Safety valve: if _tickInFlight has been true for over 60 seconds, force-reset it.
    // This prevents a permanently wedged poll loop from a hung fetch or unhandled error.
    if (_tickInFlight) {
      const stuckMs = performance.now() - _tickInFlightSince;
      if (stuckMs > 60000) {
        console.warn(`[tick] _tickInFlight stuck for ${Math.round(stuckMs / 1000)}s, force-resetting`);
        _tickInFlight = false;
      } else {
        return;
      }
    }
    
    // Skip live data fetching when viewing historical data OR while loading it
    // Playback loop handles all drawing in historical mode
    if (window._historicalState || _isLoadingData) {
      if (_tickTimeout) clearTimeout(_tickTimeout);
      _tickTimeout = setTimeout(tick, POLL_MS);
      return;
    }
    
    _tickInFlight = true;
    _tickInFlightSince = performance.now();
    let st = null;
    const statusEl = document.getElementById("statusText");
    try {
      st = await fetchState();
    } catch (e) {
      _tickConsecutiveFailures++;
      if (statusEl) {
        statusEl.textContent = "Offline";
        statusEl.classList.remove("live");
        statusEl.classList.add("offline");
      }
      // Even if we're offline, keep redrawing the overlay so time-based fades continue.
      try { map.drawOverlay(map.lastState); } catch {}
      _tickInFlight = false;
      // Reset delta/etag state so recovery gets a full refresh
      // (server may have restarted with different state).
      _stateEtag = null;
      _newestTrailMs = null;
      _accumulatedState = null;
      // Reschedule with exponential backoff: 5s, 10s, 20s, 40s … capped at POLL_MS.
      const backoffMs = Math.min(POLL_MS, 5000 * Math.pow(2, Math.min(_tickConsecutiveFailures - 1, 5)));
      if (_tickTimeout) clearTimeout(_tickTimeout);
      _tickTimeout = setTimeout(tick, backoffMs);
      return;
    }

    try {
    // Ensure st.fixed is always an array (Home sensor now provided by backend)
    if (!Array.isArray(st.fixed)) st.fixed = [];

    // Map backend "immobile" → frontend "parked" for all mobile sensors
    _mapImmobileToParked(st);

    window.__lastState = st;
    _pbLastServerResponseMs = Date.now();
    _tickConsecutiveFailures = 0; // reset backoff on success

    // Update save button now that we have data
    updateSaveButtonState();
    
    if (statusEl) {
      const meta = st.meta || {};
      const mobileCount = Array.isArray(st.mobile) ? st.mobile.length : 0;
      const fixedCount = Array.isArray(st.fixed) ? st.fixed.length : 0;
      const hasData = mobileCount > 0;
      
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
      if (!map._playbackInitialized && Array.isArray(st.mobile) && st.mobile.length > 0) {
        const b = map.getPlaybackBounds();
        if (isFinite(b.minMs) && isFinite(b.maxMs) && b.maxMs > b.minMs) {
          const meta = st?.meta || {};
          const nextInS = Number(meta.polling_next_update_in_s) ?? Number(meta.polling_predicted_interval_s) ?? 600;
          const speed = map.getPlaybackSpeed() || 1.0;
          const offsetMs = nextInS * 1000 * speed;
          
          // Only activate Live mode for speeds 1-5x
          if (speed > 5) {
            map._playbackLiveFollow = false;
          }
          
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
            const bb = _collectHeadPositionBounds(mobiles);
            if (bb && bb.visibleVehicleCount > 0 && isFinite(bb.minLat) && isFinite(bb.maxLat)) {
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

      // Sync legend tab to selected marker's current pollutant
      syncLegendToMapSelection();

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
    }
    } catch (e) {
      // Status update or data processing error — must not wedge _tickInFlight.
      try { console.error("[tick] outer error:", e); } catch {}
    } finally {
      _tickInFlight = false;
      // Always reschedule. Use server-provided timing if available, else fallback.
      // When SSE is connected, use a long safety-net interval (SSE drives timely updates).
      var basePollMs = _sseConnected ? POLL_MS_SSE : POLL_MS;
      const clientPollS = Number(window.__lastState?.meta?.client_poll_in_s);
      const nextMs = _sseConnected ? basePollMs
        : (isFinite(clientPollS) && clientPollS > 0) ? clientPollS * 1000 : basePollMs;
      if (_tickTimeout) clearTimeout(_tickTimeout);
      _tickTimeout = setTimeout(tick, nextMs);
    }
  }

  // ── Playback-bar auto-hide (10 s idle → slide down + fade out) ──
  // Only hides when the pointer is in the top 2/3 of the viewport.
  // A 15 px buffer keeps the boundary from overlapping the bar.
  {
    const PB_HIDE_MS = 10000;
    const bar = document.getElementById("playbackBar");
    if (bar) {
      let _lastMouseY = 0;
      let _hideTimer = null;

      const inBottomZone = () =>
        _lastMouseY > window.innerHeight * (2 / 3) - 15;

      const tryHide = () => {
        if (!inBottomZone()) bar.classList.add("pb-hidden");
      };

      const resetHide = () => {
        bar.classList.remove("pb-hidden");
        clearTimeout(_hideTimer);
        _hideTimer = setTimeout(tryHide, PB_HIDE_MS);
      };

      _hideTimer = setTimeout(tryHide, PB_HIDE_MS);

      // Any interaction with the bar itself resets the timer
      bar.addEventListener("pointerdown", resetHide);
      bar.addEventListener("input", resetHide);

      // Track pointer position & re-show when entering bottom third
      document.addEventListener("mousemove", (e) => {
        _lastMouseY = e.clientY;
        if (inBottomZone()) resetHide();
      });

      // Touch in the lower third also re-shows
      document.addEventListener("touchstart", (e) => {
        const t = e.touches[0];
        if (t) {
          _lastMouseY = t.clientY;
          if (inBottomZone()) resetHide();
        }
      }, { passive: true });
    }
  }

  // Load server config before starting data polling
  // This allows the server to control CDN/caching behavior
  loadConfig().then(async () => {
    // Ensure the auth cookie is set before any API call
    await _authReady;

    // Re-apply theme in case config pushed new localStorage defaults
    applyTheme(_currentThemeKey, true);

    // ── Embed / iframe URL parameter handling ────────────────────────────────
    // The landing page (fun.js) passes ?date=YYYY-MM-DD&start=10&speed=10 etc.
    // to load a historical snapshot in the embedded widget.
    const _urlParams = new URLSearchParams(window.location.search);
    const _urlDate = _urlParams.get('date');
    console.log("[EmbedParam] search:", window.location.search, "date:", _urlDate);
    if (_urlDate && /^\d{4}-\d{2}-\d{2}$/.test(_urlDate)) {
      console.log("[EmbedParam] Valid date, calling loadSnapshotByDate:", _urlDate);
      try {
        // Pass start/duration to server so it trims the snapshot before sending
        const _urlStart = Number(_urlParams.get('start'));
        const _urlDuration = Number(_urlParams.get('duration'));
        let _extraParams = "";
        if (isFinite(_urlStart) && _urlStart >= 0 && isFinite(_urlDuration) && _urlDuration > 0) {
          _extraParams = `&start=${_urlStart}&duration=${_urlDuration}`;
        }
        await loadSnapshotByDate(_urlDate, _extraParams);
        console.log("[EmbedParam] loadSnapshotByDate resolved. _historicalState:", !!window._historicalState, "playbackMode:", map.playbackMode);
        _selectedDayValue = _urlDate;

        // Override playhead: start hour + playhead offset in minutes
        if (isFinite(_urlStart) && _urlStart >= 0 && _urlStart <= 23) {
          const [_uy, _umo, _ud] = _urlDate.split("-").map(Number);
          const _urlPlayhead = Number(_urlParams.get('playhead')) || 0;
          const startMs = new Date(_uy, _umo - 1, _ud, _urlStart, 0, 0, 0).getTime() + (_urlPlayhead * 60000);
          const b = map.getPlaybackBounds();
          if (isFinite(b.minMs)) {
            map.setPlaybackTimeMs(clamp(startMs, b.minMs, b.maxMs));
          }
        }

        // Override playback speed (e.g. speed=20 → 20x)
        const _urlSpeed = Number(_urlParams.get('speed'));
        if (isFinite(_urlSpeed) && _urlSpeed > 0) {
          map.setPlaybackSpeed(_urlSpeed);
          if (pbSpeedEl) pbSpeedEl.value = String(_urlSpeed);
        }

        updatePlaybackUi();
        console.log("[EmbedParam] Done. Skipping tick() — snapshot loaded.");
        return; // Do NOT start live polling when viewing a snapshot
      } catch (e) {
        console.error("[EmbedParam] Failed to load snapshot for date:", _urlDate, e);
        // Fall through to normal live tick
      }
    } else if (_urlDate) {
      console.warn("[EmbedParam] date param failed regex:", _urlDate);
    }

    tick(); // finally block inside tick() schedules all subsequent polls
    connectSSE(); // open SSE stream for push-based updates
  });
}

main();
