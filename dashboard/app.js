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
  // Mobile labels default OFF, fixed labels default ON
  map.showMobileLabels = localStorage.getItem(SHOW_MOBILE_LABELS_KEY) === "true";
  map.showFixedLabels = localStorage.getItem(SHOW_FIXED_LABELS_KEY) !== "false";

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
    var _scrubRAF = 0;
    pbScrubEl.addEventListener("input", () => {
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

