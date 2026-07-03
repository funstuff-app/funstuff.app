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
      headers: { "Content-Type": "application/json", "X-App-Token": APP_TOKEN },
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
    headers: { "Content-Type": "application/json", "X-App-Token": APP_TOKEN },
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
    headers: { "Content-Type": "application/json", "X-App-Token": APP_TOKEN },
    keepalive: true,
  }).catch(() => {});
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") _syncViewToServer();
});
window.addEventListener("pagehide", _syncViewToServer);

// ── State sync (fetchState/etag/delta-merge/SSE/analytics) ────────────────
// Extracted to ui_state_sync.js (StateSync). Instantiated inside main() once
// `map`/`selectedId` exist; the module owns etag/accumulated-state/SSE/
// analytics fields internally. These top-level wrappers preserve the
// original call sites (fetchState(), newestReadingMsFromState()); both
// were only ever called from within main(), so they simply delegate to
// the StateSync instance created there.
function fetchState() { return window.__stateSync.fetchState(); }
function newestReadingMsFromState(st) { return StateSync.newestReadingMsFromState(st); }

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

  // Demo mode: start in the secret screensaver (as if triggered by the
  // bottom-left hot corner). Any user interaction (keydown / mousemove out
  // of the bottom strip / touchstart) restores the default view via _ssExit.
  const _demoParam = new URLSearchParams(window.location.search).get('demo') === '1';

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
  // Extracted to ui_legend.js (LegendUI). Instantiated here with the deps
  // it needs to reach into main()'s shared state (map, current selection,
  // current state snapshot). The module owns all legend DOM refs, tab/open/
  // collapsed state, row-tween caches, and the tab click/close/collapse/
  // toggle event wiring internally. These local consts preserve the
  // original call sites used elsewhere in main() (buildLegend(),
  // updateLegendVisibility(), syncLegendToSensor(), syncLegendToMapSelection(),
  // revertLegendTab(), _syncMapPollutant(), _syncLegendTabVisibility()).
  const legend = new LegendUI({
    map,
    document,
    getState: () => _currentState(),
    getSelectedId: () => selectedId,
    isMobileWidth: _isMobileWidth,
  });
  function buildLegend(animate = false) { legend.buildLegend(animate); }
  function updateLegendVisibility() { legend.updateLegendVisibility(); }
  function syncLegendToSensor(sensor) { legend.syncLegendToSensor(sensor); }
  function syncLegendToMapSelection() { legend.syncLegendToMapSelection(); }
  function revertLegendTab() { legend.revertLegendTab(); }
  function _syncMapPollutant() { legend._syncMapPollutant(); }
  function _syncLegendTabVisibility() { legend._syncLegendTabVisibility(); }

  legend.buildLegend();
  legend.updateLegendVisibility();

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
        const resp = await fetch(`/api/view/log?client=${encodeURIComponent(clientId)}&n=500`, { headers: { "X-App-Token": APP_TOKEN } });
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
        const resp = await fetch("/api/view/clients", { headers: { "X-App-Token": APP_TOKEN } });
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

  // ── Camera center button (all users) ────────────────────────────────────────
  // Camera center button disabled — keepCenter feature removed.
  // const camCenterBtn = document.getElementById("camCenterBtn");
  // if (camCenterBtn) {
  //   camCenterBtn.addEventListener("click", () => {
  //     _performCameraFit({ force: true });
  //   });
  // }

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

  map.setMaxTrailLen(MAX_TRAIL_LEN);

  // ── Theme + per-theme dimming/saturation sliders (persisted) ────────────
  // Extracted to ui_theme.js (ThemeUI). Instantiated here with callbacks so
  // it can read/write `_currentThemeKey`, which is also written by
  // updateThemeSubmenu's click handler (still in main()) and read at the
  // post-loadConfig re-apply below — it stays a main()-owned variable rather
  // than moving into ThemeUI. These local consts/wrappers preserve the
  // original call sites used elsewhere in main() (applyTheme,
  // applyThemeAndFilters, and the DOM refs themeEl/dimEl/satEl used by
  // updateThemeSubmenu). ThemeUI's constructor performs all of the original
  // module-load-time wiring (option population, initial applyTheme call,
  // change/input listeners) as a side effect of construction.
  let _currentThemeKey;
  const theme = new ThemeUI({
    map,
    document,
    setCurrentThemeKey: (k) => { _currentThemeKey = k; },
    getUpdateThemeSubmenu: () => window._updateThemeSubmenu,
  });
  const themeEl = theme.themeEl;
  const dimEl = theme.dimEl;
  const satEl = theme.satEl;
  function dimToBrightness(dim01) { return theme.dimToBrightness(dim01); }
  function getThemeSettingsKey(themeKey) { return theme.getThemeSettingsKey(themeKey); }
  function loadDimForTheme(themeKey) { return theme.loadDimForTheme(themeKey); }
  function loadSatForTheme(themeKey) { return theme.loadSatForTheme(themeKey); }
  function applyThemeAndFilters(themeKey, dimVal0to100, satVal0to150) { return theme.applyThemeAndFilters(themeKey, dimVal0to100, satVal0to150); }
  function isSystemDarkMode() { return theme.isSystemDarkMode(); }
  function isThemeDark(themeKey) { return theme.isThemeDark(themeKey); }
  function getThemeStorageKey() { return theme.getThemeStorageKey(); }
  function getDefaultThemeForMode() { return theme.getDefaultThemeForMode(); }
  function getSavedThemeForCurrentMode() { return theme.getSavedThemeForCurrentMode(); }
  function saveThemeForMode(themeKey) { return theme.saveThemeForMode(themeKey); }
  function getInitialTheme() { return theme.getInitialTheme(); }
  function applyTheme(themeKey, skipSubmenuUpdate) { return theme.applyTheme(themeKey, skipSubmenuUpdate); }

  // Restore view after map is initialized (theme/filter doesn't affect center/zoom).
  restoreViewIfAny();

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
      legend.legendUserOverride = false;
      _wasAlreadyDeselected = false;
      if (map && typeof map.cancelSelectionOrchestration === "function") map.cancelSelectionOrchestration();
      map.setSelected(null);
      buildLegend();
      _syncMapPollutant();
      renderLists(_currentState(), selectedId);
      renderDetails(_currentState(), selectedId);
      return;
    }

    selectedId = id || null;
    // Only reset legend override when on default (null);
    // if user has manually selected a pollutant, keep it.
    if (legend.legendTab == null) legend.legendUserOverride = false;
    if (!selectedId) {
      if (legend.legendTab != null && _wasAlreadyDeselected) {
        // Second background click: clear pollutant back to default
        legend.legendTab = null;
        legend.userLegendTab = null;
        legend.legendUserOverride = false;
      }
      // Track whether we were already deselected (for next click)
      _wasAlreadyDeselected = true;
      buildLegend();
      _syncMapPollutant();
    }
    map.setSelected(selectedId);
    if (selectedId) _wasAlreadyDeselected = false;

    const st = _currentState();
    const sel = parseKey(selectedId);
    let item = null;
    if (sel && sel.type === "mobile") item = (Array.isArray(st.mobile) ? st.mobile : []).find(x => x.id === sel.id) || null;
    if (sel && sel.type === "fixed") item = (Array.isArray(st.fixed) ? st.fixed : []).find(x => x.id === sel.id) || null;

    // Auto-open legend on first mobile/fixed selection this session (not PurpleAir)
    const isPurpleAir = item && item.purpleair;
    if (selectedId && !legend._legendAutoOpenedOnce && !legend.legendOpen && !isPurpleAir) {
      legend._legendAutoOpenedOnce = true;
      legend.legendOpen = true;
      updateLegendVisibility();
    }

    // Sync legend tab to selected marker's displayed pollutant
    // Only when on the default PM2.5 tab — don't override a user's manual pollutant choice
    if (legend.legendTab == null) {
      // Defer sync: the map needs to render one frame with the new selection
      // so _selectedPollutantKey reflects the actual displayed reading
      // (which may differ from live data during playback).
      requestAnimationFrame(() => { syncLegendToMapSelection(); });
    }
    
    // Center camera when selected from sidebar (any sensor type), or for mobile from map click with cmd+click for fit
    if (item && isFinite(Number(item.lat)) && isFinite(Number(item.lon))) {
      const isMobile = sel?.type === "mobile";
      const shouldCenter = fromPanel || isMobile;
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
      legend.legendUserOverride = false;
      _wasAlreadyDeselected = false;
      map.setSelected(null);
      buildLegend();
      _syncMapPollutant();
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
  const pbPagePrevEl = document.getElementById("pbPagePrev");
  const pbPageNextEl = document.getElementById("pbPageNext");

  const pb = {
    _pbRAF: null,
    _pbLastPerf: 0,
    _pbLastUiPerf: 0,
    _pbScrubbing: false,  // true when pointer is down on scrub bar
    _pbResumeAfterScrub: false,  // was playback active when the scrub began
    _pbMoveDeltaMs: 0,  // signed ms the playhead last moved (REW direction)
    _pbPaused: false,  // explicit pause hold — suppresses loop go-live at the edge
    _pbVelocity: 0,
    _pbAtEndSincePerf: null,  // performance.now() when we started waiting at end
    _pbArrivedAtEndViaPlayback: false,  // true only if we PLAYED to the end (not scrolled)
    _pbEaseStartPerf: null,
    _pbEaseStartVelocity: 0,
    _pbEaseStartPos: 0,  // playhead position when ease began
    _pbIsRewinding: false,
    _pbLoopStartMs: null,
    _pbLastKnownMinMs: null,
    _pbLastKnownMaxMs: null,
    _pbLastServerResponseMs: Date.now(),
    _pbLastForceRefreshSeq: null,
    _pbLiveStartWallMs: null,  // wall-clock time (perf.now) when LIVE mode started
    _pbLiveStartDataMs: null,  // data time (maxMs) when LIVE mode started
    _pbLiveTargetMs: null,  // where playback should aim in LIVE mode
    _pbLiveStallCount: 0,  // how many times we've hit end waiting for data
    _deferredCameraFit: null,  // { type: "bounds", bb, durationMs } | { type: "storedView", durationMs }
    _pbWheelAccum: 0,  // accumulated wheel delta
    _pbDidDrag: false,  // did the user actually drag (vs click)?
    _pbIsWheelCoasting: false,  // is current coast from wheel scroll?
    _pbCommitLoopStartOnCoastEnd: false,
    _pbMwAccum: 0,
    _pbMwLastTs: 0,  // mouse-wheel velocity accumulator for scrub bar
    _pbPageIndex: -1,  // -1 = "all" (no paging), 0..N = page index
    _pbPageAutoFollow: true,  // auto-advance page to follow playhead
    _pbSlidingWindowCenter: null,  // null = use index-based paging
    _pbJogRAF: null,  // rAF ID for edge-jog during drag
    _pbJogLastPerf: 0,  // last rAF timestamp for jog dt
  };
  let _pbLastScrubPos = 0;
  let _pbLastScrubTime = 0;

  // Extracted to ui_playback.js (PlaybackUI). The module owns the playback DOM
  // labels/page-arrow refs + barrel jog, the physics/paging constants, and the
  // scalars used only by the moved functions (_barrelMode, _jogWheel,
  // _scrubRAF). The shared `pb` object (A4a) is passed BY REFERENCE so the
  // scrub/click/speed/visibility handlers that stay in main() keep mutating it.
  // deps.* are lazy getters/callbacks into shared state and helpers that stay
  // in main() (screensaver flag, sidebar/selection, camera-fit cluster, legend
  // sync). One-line delegates below preserve the original call sites.
  const playback = PlaybackUI.create({
    map,
    document,
    pb,
    deps: {
      getScreensaverActive: () => _getScreensaverActive(),
      getSidebarOpen: () => sidebarOpen,
      getSelectedId: () => selectedId,
      performCameraFit: (opts) => _performCameraFit(opts),
      animateFitBoundsLatLon: (bb, opts) => _animateFitBoundsLatLon(bb, opts),
      animateToStoredView: (ms) => _animateToStoredView(ms),
      syncMapPollutant: () => _syncMapPollutant(),
      syncLegendToMapSelection: () => syncLegendToMapSelection(),
      updateSidebarPlaybackValues: () => updateSidebarPlaybackValues(),
    },
  });
  // Thin delegates keep every original call site in main() untouched.
  function _resetLiveTracking() { playback._resetLiveTracking(); }
  function _pbAllVehiclesReachedPlaybackEnd(state) { return playback._pbAllVehiclesReachedPlaybackEnd(state); }
  function _pbPageCount() { return playback._pbPageCount(); }
  function _pbGetPageRange() { return playback._pbGetPageRange(); }
  function _pbSetPage(idx) { return playback._pbSetPage(idx); }
  function _pbPageForTime(tMs) { return playback._pbPageForTime(tMs); }
  function _pbSnapWindowToPlayhead() { return playback._pbSnapWindowToPlayhead(); }
  function _pbPagingActive() { return playback._pbPagingActive(); }
  const fmtTime = (ms) => playback.fmtTime(ms);
  const updatePlaybackUi = () => playback.updatePlaybackUi();
  const playbackLoop = () => playback.playbackLoop();
  function _setBarrelMode(on) { return playback._setBarrelMode(on); }
  function setMapLoadingShade(on) { return playback.setMapLoadingShade(on); }
  const applyScrub = () => playback.applyScrub();
  function _pbStartEdgeJog() { return playback._pbStartEdgeJog(); }
  function _pbStopEdgeJog() { return playback._pbStopEdgeJog(); }
  function _pbEdgeJogTick(now) { return playback._pbEdgeJogTick(now); }
  // Playback DOM refs the module owns but staying handlers reference.
  const pbLeftEl = playback.pbLeftEl;
  const pbNowEl = playback.pbNowEl;
  const pbRightEl = playback.pbRightEl;
  // Shared coalescing rAF flag (the scrub pointer/touch listeners below use it).
  const _getScrubRAF = () => playback.getScrubRAF();
  const _setScrubRAF = (v) => playback.setScrubRAF(v);
  // Cross-module wiring (consumed by engine_camera_gestures.js / engine_playback_engine.js).
  map._resetLiveTracking = playback._resetLiveTracking;

  // playback_state.js (PlaybackState) — single source of truth for runway /
  // LIVE-mode calculations.  Wired in here (script tag added to index.html) so
  // it is no longer dead code.  The duplicated runway/live-window math in
  // updatePlaybackUi, the playbackLoop live-window block, and the pbPlay /
  // pbSpeed / visibilitychange handlers is the "exact-correspondence" set this
  // object DRYs up; those call sites are NOT rewritten in this story because
  // PlaybackState._metaPollSec (isFinite fallback) is not byte-identical to the
  // inline `?? … ?? 600` math (they differ when both meta poll fields are
  // absent → NaN vs 600), so substituting would change behavior. The consolidation
  // is left to a follow-up; instantiating here keeps the module live/available.
  const playbackState = new PlaybackState(map);
  window.__playbackState = playbackState;

  // ─────────────────────────────────────────────────────────────────────────────
  // PHYSICS-BASED PLAYBACK: Everything is driven by velocity and forces.
  // No state flags for "rewind" - just physics simulation.
  // ─────────────────────────────────────────────────────────────────────────────
  
  // Velocity in "playback ms per wall ms" (1.0 = real-time forward, -15 = fast rewind)
  
  // Track when we hit the end and are waiting for vehicles to physically reach the
  // end of their paths (no fixed pause; rewind triggers when vehicles are done).
  
  // Track when ease-in phase started (for wall-time-based easing)
  
  // Flag to track active rewind (not based on velocity)

  // Replay loop start ("point A"): where playback started / where the user last left the playhead.
  // Auto-rewind returns here instead of rewinding to the global min bound.
  
  // Track data bounds to detect new data / trimmed data

  // Wall-clock ms (Date.now) when last server response arrived

  // Server can bump this to force LIVE camera follow even if data timestamps are unchanged.
  
  // ─────────────────────────────────────────────────────────────────────────────
  // LIVE BUFFER: Track wall-clock time since app started to know how much data we have.
  // Buffer = time since first data arrival. Playback replays this accumulated buffer.
  // ─────────────────────────────────────────────────────────────────────────────
  // _resetLiveTracking moved to ui_playback.js (delegate above); map._resetLiveTracking
  // is assigned there too (consumed by engine modules).

  // LIVE camera follow: smooth pan/zoom to fit moving vehicles
  const _pbLiveFollowDurationMs = 2000; // animation duration for camera follow (slow, smooth)
  const _pbLiveFollowPadding = 0.15;    // extra padding around bounds (15%)

  // Deferred camera fit: when new data arrives while the user is panning/zooming
  // (or during post-interaction easing), we stash the intended camera fit here.
  // The playback loop drains it once _canRunAutoCamera() returns true.

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
      pb._deferredCameraFit = { type: "storedView", durationMs: durationMs || _pbLiveFollowDurationMs };
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
      pb._deferredCameraFit = { type: "bounds", bb: { minLat, minLon, maxLat, maxLon }, durationMs };
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

  // _pbAllVehiclesReachedPlaybackEnd moved to ui_playback.js (delegate above).

  // Scroll wheel nudge (iPod-style momentum)
  const _pbWheelImpulse = 1.0;        // velocity added per wheel tick
  const _pbWheelDecay = 0.8;          // wheel accumulator decay per frame

  // Drag tracking

  // ─────────────────────────────────────────────────────────────────────────────
  // PAGING: Slider maps to an 8-hour page instead of the full day.
  // Keeps scrub resolution constant as data accumulates.
  // ─────────────────────────────────────────────────────────────────────────────
  const _pbPageSizeMs = 14400000;         // 4 hours in ms
  const _pbPageMinDurationMs = 0;          // paging always active

  // Sliding window: when set, overrides index-based paging for click-drag scrubbing.
  // The window is centered on this timestamp instead of a fixed page boundary.

  // _pbPageCount / _pbGetPageRange / _pbSetPage / _pbPageForTime /
  // _pbSnapWindowToPlayhead / _pbPagingActive / fmtTime / updatePlaybackUi /
  // playbackLoop moved to ui_playback.js (delegates above).

  // Allow MapView to restart the loop after a drag release.
  window.__ensurePlaybackLoop = () => {
    if (!map.playbackMode) return;
    if (pb._pbRAF) return;
    pb._pbLastPerf = 0;
    pb._pbLastUiPerf = 0;
    pb._pbVelocity = 0;
    pb._pbWheelAccum = 0;
    pb._pbRAF = requestAnimationFrame(playbackLoop);
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
      pb._pbLastPerf = 0;
      pb._pbLastUiPerf = 0;
      if (!pb._pbRAF) pb._pbRAF = requestAnimationFrame(playbackLoop);
    }
    traceEl.addEventListener("change", () => {
      localStorage.setItem(TRACE_STORAGE_KEY, traceEl.checked ? "1" : "0");
      pb._pbVelocity = 0;
      pb._pbWheelAccum = 0;
      pb._pbAtEndSincePerf = null;
      map.setPlaybackMode(traceEl.checked);
      if (pbBarEl) pbBarEl.classList.toggle("hidden", !traceEl.checked);
      if (traceEl.checked) {
        map._ensurePlaybackPoints(window.__lastState || { mobile: [], fixed: [] });
        // Don't set playhead here - let the playback loop handle it
        map.setPlaybackPlaying(false);
        updatePlaybackUi();
        pb._pbLastPerf = 0;
        pb._pbLastUiPerf = 0;
        if (!pb._pbRAF) pb._pbRAF = requestAnimationFrame(playbackLoop);
      } else {
        map.setPlaybackPlaying(false);
        pb._pbLastPerf = 0;
        pb._pbLastUiPerf = 0;
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
    pb._pbLastPerf = 0;
    pb._pbLastUiPerf = 0;
    if (!pb._pbRAF) pb._pbRAF = requestAnimationFrame(playbackLoop);
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

      // Is the playhead inside the live sync window (at/near the wall-clock
      // edge)? Inside it there is NO pause — it is Live and stays Live; the
      // only way out is to scrub back. Pause exists only OUTSIDE the window.
      const _curMs = map.getPlaybackTimeMs();
      const _dataEdge = (map._playbackMaxMs != null && isFinite(map._playbackMaxMs))
        ? map._playbackMaxMs : b.maxMs;
      const _syncEps = Math.max(15000, (b.maxMs - b.minMs) * 0.005);
      const _inLiveWindow = !map._historicalMode
        && _curMs != null && isFinite(_curMs) && _curMs >= _dataEdge - _syncEps;

      const action = PlaybackUI.computeClickAction({
        playing: map.getPlaybackPlaying(),
        liveFollow: map._playbackLiveFollow,
        inLiveWindow: _inLiveWindow,
      });

      if (action === "none") {
        // Live within the sync window: clicking does nothing. Stay live.
        return;
      }

      if (action === "pause") {
        // PAUSE — only reachable OUTSIDE the live window (playing in the past).
        // Freeze the playhead exactly where it is: it is already behind the
        // live zone, so the dim shade + ◀◀ REW show without any skip-back.
        map._playbackLiveFollow = false;
        try { localStorage.setItem(LIVE_MODE_STORAGE_KEY, "0"); } catch {}
        if (typeof map._resetLiveTracking === "function") map._resetLiveTracking();
        map.setPlaybackPlaying(false);
        pb._pbPaused = true;
        pb._pbVelocity = 0;
        pb._pbWheelAccum = 0;
        pb._pbAtEndSincePerf = null;
        pb._pbIsRewinding = false;
        if (_curMs != null && isFinite(_curMs)) pb._pbLoopStartMs = _curMs;
        updatePlaybackUi();
        return;
      }

      // PLAY from the current position at the selected speed. If the playhead
      // is at the wall-clock edge, playing from here IS going live — the RIDE
      // block keeps it pinned to the ticking edge (Live at 1x, lit Pause above).
      pb._pbAtEndSincePerf = null;
      pb._pbWheelAccum = 0;
      pb._pbIsRewinding = false;
      pb._pbPaused = false;   // play clears the explicit pause hold
      // Capture replay point A if it hasn't been set via scrubbing.
      if (pb._pbLoopStartMs == null || !isFinite(Number(pb._pbLoopStartMs))) {
        const cur = map.getPlaybackTimeMs();
        pb._pbLoopStartMs = (cur != null && isFinite(Number(cur))) ? Number(cur) : b.minMs;
      }
      // Playing from the data edge IS going live (measured against the data
      // edge — the wall extension can run a full poll interval ahead of it).
      const _playDataEdge = (map._playbackMaxMs != null && isFinite(map._playbackMaxMs))
        ? map._playbackMaxMs : b.maxMs;
      const _playCur = map.getPlaybackTimeMs();
      if (!map._historicalMode && _playCur != null && isFinite(_playCur)
          && _playCur >= _playDataEdge - 1500) {
        map._playbackLiveFollow = true;
        pb._pbPageAutoFollow = true;
        try { localStorage.setItem(LIVE_MODE_STORAGE_KEY, "1"); } catch {}
      }
      pb._pbVelocity = _pbPlaybackSpeed * (map.getPlaybackSpeed() || 1.0);
      map.setPlaybackPlaying(true);
      pb._pbLastPerf = 0;
      // Always restart the loop
      if (pb._pbRAF) cancelAnimationFrame(pb._pbRAF);
      pb._pbRAF = requestAnimationFrame(playbackLoop);
      updatePlaybackUi();
    });
  }

  // ── Scrub-release resume ──────────────────────────────────────────────────
  // Edge proximity for the drag-to-live gesture: generous enough to hit at
  // slider pixel granularity (~0.5% of the visible range, 15 s minimum).
  const _pbEdgeSnapEpsMs = () => {
    const b = map.getPlaybackBounds();
    const dur = (isFinite(b.minMs) && isFinite(b.maxMs)) ? (b.maxMs - b.minMs) : 0;
    return Math.max(15000, dur * 0.005);
  };
  // Shared release handler for scrub gestures: commit the slider position,
  // then restore what the user was doing before grabbing it. Released at the
  // wall-clock edge → go Live (the "drag into the live edge" gesture).
  // Otherwise resume playing only if playback was active when the drag
  // started — a scrub while paused stays paused (button keeps "Play").
  const _pbResumeFromScrub = (resetPerfToNow) => {
    applyScrub();
    const wasActive = !!pb._pbResumeAfterScrub;
    pb._pbResumeAfterScrub = false;
    // "Released at the edge" is measured against the DATA edge, not the
    // wall-clock max — scrubs are clamped to the data edge (applyScrub), and
    // the wall extension can run up to a full poll interval ahead of it.
    const _dataEdge = (map._playbackMaxMs != null && isFinite(map._playbackMaxMs))
      ? map._playbackMaxMs : map.getPlaybackBounds().maxMs;
    const _cur = map.getPlaybackTimeMs();
    const goLive = !map._historicalMode && _cur != null && isFinite(_cur)
      && _cur >= _dataEdge - _pbEdgeSnapEpsMs();
    if (goLive) {
      map._playbackLiveFollow = true;
      pb._pbPageAutoFollow = true;
      try { localStorage.setItem(LIVE_MODE_STORAGE_KEY, "1"); } catch {}
      const bb = map.getPlaybackBounds();
      if (isFinite(bb.maxMs)) map.setPlaybackTimeMs(bb.maxMs);
    }
    if (goLive || wasActive) {
      map.setPlaybackPlaying(true);
      pb._pbLastPerf = resetPerfToNow ? performance.now() : 0;
      if (!pb._pbRAF) pb._pbRAF = requestAnimationFrame(playbackLoop);
    } else {
      map.setPlaybackPlaying(false);
    }
    updatePlaybackUi();
  };

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
      // Speed changes never move the playhead. Riding the wall-clock edge is
      // position-based, so the only visible effect there is the button label
      // flipping between "Live" (1x) and lit "Pause" (>1x) via updatePlaybackUi.
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
    // Snap straight to the wall-clock edge — that is where "live" is now.
    map.setPlaybackTimeMs(b.maxMs);
    // Restart LIVE tracking from current position
    pb._pbLiveStartWallMs = performance.now();
    pb._pbLiveStartDataMs = b.maxMs;
    // Reset the frame timer so dt doesn't include backgrounded time
    pb._pbLastPerf = 0;
    updatePlaybackUi();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // DAY SELECTOR: Load historical data for past days
  // ─────────────────────────────────────────────────────────────────────────────
  window._historicalState = null;  // Cached historical data when not "live"

  // ─────────────────────────────────────────────────────────────────────────────
  // SAVE/LOAD, DAY SELECTOR, PLAYBACK MENU: Extracted to ui_snapshots_menus.js
  // (SnapshotsMenusUI). The module owns the menu/submenu DOM refs, the menu-
  // close and submenu show/hide debounce timers, and (as instance properties,
  // not privately) the two mutable scalars also read/written by unmoved
  // main() code: `_isLoadingData` (StateSync's isLoadingData() getter below,
  // and tick()'s historical-mode skip check) and `_selectedDayValue` (the
  // embed ?date= URL-param handler further down). `traceEl`/`pbBarEl` are
  // DOM refs already looked up above; `tick` is defined later in main() but
  // only invoked (not called) at construction time, so forward reference via
  // a lazy wrapper is safe. `deps.dimEl`/`satEl`/`themeEl` are ThemeUI's refs.
  // ─────────────────────────────────────────────────────────────────────────────
  const snapshotsMenus = new SnapshotsMenusUI({
    map,
    document,
    pb,
    deps: {
      getSelectedId: () => selectedId,
      traceEl,
      pbBarEl,
      validateStateSchema: StateSync.validateStateSchema,
      newestReadingMsFromState,
      mapImmobileToParked: (state) => StateSync._mapImmobileToParked(state),
      renderLists,
      renderDetails,
      updatePlaybackUi: () => updatePlaybackUi(),
      playbackLoop: () => playbackLoop(),
      setMapLoadingShade: (on) => setMapLoadingShade(on),
      tick: () => tick(),
      getAutoCameraEnabled: () => _autoCameraEnabled,
      getCurrentThemeKey: () => _currentThemeKey,
      setCurrentThemeKey: (k) => { _currentThemeKey = k; },
      themeEl, dimEl, satEl,
      applyThemeAndFilters,
      loadDimForTheme,
      loadSatForTheme,
      saveThemeForMode,
    },
  });
  // Thin delegates keep every original call site in main() untouched.
  function canSaveSnapshot() { return snapshotsMenus.canSaveSnapshot(); }
  function updateSaveButtonState() { return snapshotsMenus.updateSaveButtonState(); }
  function loadHistoricalDay(dateStr) { return snapshotsMenus.loadHistoricalDay(dateStr); }
  function getSnapshotDateStr() { return snapshotsMenus.getSnapshotDateStr(); }
  function saveSnapshot() { return snapshotsMenus.saveSnapshot(); }
  function showLoadModal() { return snapshotsMenus.showLoadModal(); }
  function loadSnapshotByDate(dateStr, extraParams = "") { return snapshotsMenus.loadSnapshotByDate(dateStr, extraParams); }
  function _updateAutoCameraBtn() { return snapshotsMenus._updateAutoCameraBtn(); }
  function closePlaybackMenuImmediate() { return snapshotsMenus.closePlaybackMenuImmediate(); }
  function closePlaybackMenu() { return snapshotsMenus.closePlaybackMenu(); }
  function cancelMenuHide() { return snapshotsMenus.cancelMenuHide(); }
  function openPlaybackMenu() { return snapshotsMenus.openPlaybackMenu(); }
  function togglePlaybackMenu() { return snapshotsMenus.togglePlaybackMenu(); }
  function showSubmenuDebounced(submenuEl, parentEl, onShow) { return snapshotsMenus.showSubmenuDebounced(submenuEl, parentEl, onShow); }
  function hideSubmenuDebounced(submenuEl, parentEl, e) { return snapshotsMenus.hideSubmenuDebounced(submenuEl, parentEl, e); }
  function updateDaysSubmenu() { return snapshotsMenus.updateDaysSubmenu(); }
  function updateThemeSubmenu() { return snapshotsMenus.updateThemeSubmenu(); }
  function showAboutModal() { return snapshotsMenus.showAboutModal(); }
  function handleMenuAction(action) { return snapshotsMenus.handleMenuAction(action); }
  function syncDisplaySliders() { return snapshotsMenus.syncDisplaySliders(); }

  // Playback menu DOM refs main() still reads/writes directly (share button,
  // auto-camera click listener, days/theme submenu hover wiring below).
  const pbMenuBtn = snapshotsMenus.pbMenuBtn;
  const pbMenu = snapshotsMenus.pbMenu;
  const pbDaysSubmenu = snapshotsMenus.pbDaysSubmenu;
  const pbThemeSubmenu = snapshotsMenus.pbThemeSubmenu;
  const shareBtn = document.getElementById("shareBtn");
  const autoCameraBtn = document.getElementById("autoCameraBtn");

  _updateAutoCameraBtn();

  if (autoCameraBtn) {
    autoCameraBtn.addEventListener("click", () => {
      _autoCameraEnabled = !_autoCameraEnabled;
      _updateAutoCameraBtn();
      // Immediately fly camera to vehicles when toggling on.
      if (_autoCameraEnabled) _performCameraFit({ force: true });
    });
  }

  // Wire up Days submenu
  const pbMenuSubEl = document.querySelector(".pbMenuSub[data-submenu='days']");
  if (pbMenuSubEl && pbDaysSubmenu) {
    pbMenuSubEl.addEventListener("mouseenter", () => showSubmenuDebounced(pbDaysSubmenu, pbMenuSubEl, null));
    pbMenuSubEl.addEventListener("mouseleave", (e) => hideSubmenuDebounced(pbDaysSubmenu, pbMenuSubEl, e));
    pbDaysSubmenu.addEventListener("mouseenter", () => showSubmenuDebounced(pbDaysSubmenu, pbMenuSubEl, null));
    pbDaysSubmenu.addEventListener("mouseleave", (e) => hideSubmenuDebounced(pbDaysSubmenu, pbMenuSubEl, e));
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

  if (pbMenuBtn) {
    pbMenuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePlaybackMenu();
    });
  }

  // Debug is now in the menu (data-action="debug"), no standalone button
  
  // Share button - opens native share dialog.
  // Hidden on desktop (browser already has a share/URL bar).
  // Share button: Web Share API in standalone PWA mode, or keep visible on Safari for install hint.
  {
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
    const isMobileUA = /iPad|iPhone|iPod|Android/i.test(navigator.userAgent)
      || (navigator.maxTouchPoints > 1);
    const isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent);
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

  // (PWA install banner is initialized below, outside main(), so it can't be blocked by errors)

  // Display submenu (dim/sat sliders in three-dot menu)
  const pbDisplaySubmenu = document.getElementById("pbDisplaySubmenu");
  const menuDimEl = document.getElementById("menuDim");
  const menuSatEl = document.getElementById("menuSat");
  const menuAlphaEl = document.getElementById("menuAlpha");

  // PA field alpha: restore from localStorage (0-100%)
  {
    const raw = localStorage.getItem(PA_ALPHA_STORAGE_KEY);
    const v = raw != null ? Number(raw) : 27;
    const pct = Math.max(0, Math.min(100, isFinite(v) ? v : 27));
    window._paFieldAlpha = Math.round(pct * 2.55);
    if (menuAlphaEl) menuAlphaEl.value = pct;
  }

  // Wire up Display submenu hover (uses centralized debounce)
  // syncDisplaySliders moved to ui_snapshots_menus.js (file-scope delegate above).
  const pbDisplaySubEl = document.querySelector(".pbMenuSub[data-submenu='display']");
  if (pbDisplaySubEl && pbDisplaySubmenu) {
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
    // applyScrub / _pbStartEdgeJog / _pbStopEdgeJog / _pbEdgeJogTick moved to
    // ui_playback.js (file-scope delegates above); the scrub listeners below
    // call them through those delegates.

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
      pb._pbVelocity = 0;
      pb._pbWheelAccum = 0;
      pb._pbAtEndSincePerf = null;
      pb._pbArrivedAtEndViaPlayback = false; // user is scrubbing, not playing
      pb._pbIsRewinding = false;
      pb._pbEaseStartPerf = null;
      pb._pbIsWheelCoasting = false;
      pb._pbScrubbing = true;
      pb._pbPaused = false;
      map._scrubbing = true;
      pb._pbDidDrag = false; // track if user actually dragged
      _pbLastScrubPos = Number(pbScrubEl.value);
      _pbLastScrubTime = performance.now();
      // Remember whether playback was active so release can restore it —
      // a scrub started while paused stays paused (button keeps "Play").
      pb._pbResumeAfterScrub = map.getPlaybackPlaying() || map._playbackLiveFollow;
      map.setPlaybackPlaying(false);
      map._playbackLiveFollow = false; // exit live mode when user grabs slider
      try { localStorage.setItem(LIVE_MODE_STORAGE_KEY, "0"); } catch {}
      _resetLiveTracking();
      // Activate sliding window: freeze the current window in place for the drag.
      // If already in sliding window mode, keep the existing center.
      // If in index-based mode, convert the current page center to a sliding window.
      if (_pbPagingActive() && pb._pbSlidingWindowCenter == null) {
        const pr = _pbGetPageRange();
        pb._pbSlidingWindowCenter = (pr.minMs + pr.maxMs) / 2;
      }
      updatePlaybackUi();
    });
    // Prevent native range-input snap when clicking the track (not the nub)
    pbScrubEl.addEventListener("mousedown", (e) => {
      if (_scrubPointerOnTrack) e.preventDefault();
    }, { capture: true });
    // Jogger-sensitivity drag when pointer started on the track
    pbScrubEl.addEventListener("pointermove", (e) => {
      if (!_scrubPointerOnTrack || !pb._pbScrubbing) return;
      const dx = e.clientX - _scrubPointerStartX;
      const rect = pbScrubEl.getBoundingClientRect();
      const range = Number(pbScrubEl.max) - Number(pbScrubEl.min);
      const delta = (dx / rect.width) * range * _scrubPointerSensitivity;
      const newVal = clamp(_scrubPointerStartVal + delta, Number(pbScrubEl.min), Number(pbScrubEl.max));
      pbScrubEl.value = String(newVal);
      pb._pbDidDrag = true;
      _pbLastScrubPos = newVal;
      _pbLastScrubTime = performance.now();
      if (!_getScrubRAF()) {
        _setScrubRAF(requestAnimationFrame(() => {
          _setScrubRAF(0);
          applyScrub();
        }));
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
      pb._pbScrubbing = false;
      map._scrubbing = false;
      pb._pbVelocity = 0;
      pb._pbPageAutoFollow = true; // resume auto-following after manual scrub

      // Page back if slider is near the left edge (1% threshold)
      if (_pbPagingActive() && Number(pbScrubEl.value) <= Number(pbScrubEl.max) * 0.01) {
        const gb = map.getPlaybackBounds();
        const pr = _pbGetPageRange();
        if (pr.minMs > gb.minMs) {
          // Shift the sliding window left by one page
          if (pb._pbSlidingWindowCenter != null) {
            pb._pbSlidingWindowCenter = Math.max(gb.minMs + _pbPageSizeMs / 2, pb._pbSlidingWindowCenter - _pbPageSizeMs);
          } else if (pb._pbPageIndex > 0) {
            _pbSetPage(pb._pbPageIndex - 1);
          }
          const prev = _pbGetPageRange();
          map.setPlaybackTimeMs(prev.maxMs);
          pb._pbLoopStartMs = prev.maxMs;
          pbScrubEl.max = String(prev.maxMs - prev.minMs);
          pbScrubEl.value = pbScrubEl.max;
          map.setPlaybackPlaying(true);
          pb._pbLastPerf = performance.now();
          if (!pb._pbRAF) pb._pbRAF = requestAnimationFrame(playbackLoop);
          updatePlaybackUi();
          map.drawOverlay(map.lastState);
          return;
        }
      }

      _pbResumeFromScrub(true);

    });
    pbScrubEl.addEventListener("input", () => {
      if (_scrubPointerOnTrack) return; // track drag handled by pointermove
      const now = performance.now();
      const pos = Number(pbScrubEl.value);

      // User is dragging
      pb._pbDidDrag = true;
      _pbLastScrubPos = pos;
      _pbLastScrubTime = now;

      map.setPlaybackPlaying(false);
      // Coalesce rapid input events into a single rAF to avoid
      // overwhelming iPad Safari with drawOverlay() calls
      if (!_getScrubRAF()) {
        _setScrubRAF(requestAnimationFrame(() => {
          _setScrubRAF(0);
          applyScrub();
        }));
      }
    });
    pbScrubEl.addEventListener("change", () => {
      // 'change' fires on release - only handle clicks here
      // Drags with inertia are handled by pointerup
      if (pb._pbDidDrag) {
        // Drag was handled by pointerup - do nothing here
        return;
      }
      // For clicks on the track (not drags): commit and restore prior state
      pb._pbScrubbing = false;
      map._scrubbing = false;
      pb._pbVelocity = 0; // no inertia for clicks
      _pbResumeFromScrub(false);
    });

    // Scroll wheel on the scrub bar adds momentum (iPod-style)
    pbScrubEl.addEventListener("wheel", (e) => {
      e.preventDefault();
      // Cancel any pending rewind and stop normal playback
      pb._pbAtEndSincePerf = null;
      pb._pbArrivedAtEndViaPlayback = false; // user is scrolling, not playing
      pb._pbIsRewinding = false;
      pb._pbPageAutoFollow = true; // resume page tracking when scrolling
      map.setPlaybackPlaying(false); // Let wheel nudge control velocity
      // Exit LIVE mode on scroll
      map._playbackLiveFollow = false;
      try { localStorage.setItem(LIVE_MODE_STORAGE_KEY, "0"); } catch {}
      pb._pbIsWheelCoasting = true;
      pb._pbCommitLoopStartOnCoastEnd = true;
      // Activate sliding window so the playhead isn't clamped to a fixed page boundary
      if (_pbPagingActive() && pb._pbSlidingWindowCenter == null) {
        const pr = _pbGetPageRange();
        pb._pbSlidingWindowCenter = (pr.minMs + pr.maxMs) / 2;
      }
      // Two-finger swipe (deltaX) or vertical scroll wheel (deltaY): scrub through time.
      // deltaX > 0 = swipe right = backward; deltaY > 0 = scroll down = forward.
      const b = map.getPlaybackBounds();
      const durMs = (b.maxMs - b.minMs) || 1;
      const isHorizontal = Math.abs(e.deltaX) >= Math.abs(e.deltaY);
      const isMouseWheel = e.deltaMode !== 0 || (!e.ctrlKey && Math.abs(e.deltaX) < 1 && Math.abs(e.deltaY) >= 4);
      // Normalize line-mode (deltaMode=1) to ~pixel equivalent (×40)
      const rawDy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
      const rawDx = e.deltaMode === 1 ? e.deltaX * 40 : e.deltaX;
      // Windows mouse wheel: velocity-adaptive boost (OS provides no acceleration).
      // Mac mouse wheel: flat 3× boost (OS acceleration handles variable speed).
      const _isWin = /Win/.test(navigator.platform || "");
      const _isMac = /Mac/.test(navigator.platform || "");
      let mwBoost = 1;
      if (isMouseWheel && _isWin) {
        const now = performance.now();
        if (now - pb._pbMwLastTs > 80) pb._pbMwAccum = 0;
        pb._pbMwAccum += Math.abs(isHorizontal ? rawDx : rawDy);
        pb._pbMwLastTs = now;
        mwBoost = Math.max(0.55 * Math.sqrt(pb._pbMwAccum), 1);
        mwBoost = Math.min(mwBoost, 60);
      } else if (isMouseWheel && _isMac) {
        mwBoost = 1;
      }
      const delta = isHorizontal ? rawDx * mwBoost : (isMouseWheel ? rawDy * mwBoost : -rawDy) * 0.15;
      const nudgeDur = Math.min(durMs, 21600000); // cap at 6h so scroll speed is consistent
      const nudge = (delta / 1000) * (nudgeDur / 480);
      const prevDir = Math.sign(pb._pbVelocity);
      pb._pbVelocity -= nudge;
      // On direction reversal, snap window so playhead stays just outside the jog zone
      if (prevDir !== 0 && Math.sign(pb._pbVelocity) !== 0 && Math.sign(pb._pbVelocity) !== prevDir) {
        _pbSnapWindowToPlayhead();
        updatePlaybackUi();
      }
      // Ensure loop is running
      if (!pb._pbRAF) {
        pb._pbLastPerf = performance.now(); // valid dt for next frame
        pb._pbRAF = requestAnimationFrame(playbackLoop);
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
      pb._pbVelocity = 0;
      pb._pbWheelAccum = 0;
      pb._pbAtEndSincePerf = null;
      pb._pbArrivedAtEndViaPlayback = false;
      pb._pbIsRewinding = false;
      pb._pbEaseStartPerf = null;
      pb._pbIsWheelCoasting = false;
      pb._pbScrubbing = true;
      pb._pbPaused = false;
      map._scrubbing = true;
      pb._pbDidDrag = false;
      _pbLastScrubPos = Number(pbScrubEl.value);
      _pbLastScrubTime = performance.now();
      pb._pbResumeAfterScrub = map.getPlaybackPlaying() || map._playbackLiveFollow;
      map.setPlaybackPlaying(false);
      map._playbackLiveFollow = false;
      try { localStorage.setItem(LIVE_MODE_STORAGE_KEY, "0"); } catch {}
      _resetLiveTracking();
      // Activate sliding window
      if (_pbPagingActive() && pb._pbSlidingWindowCenter == null) {
        const pr = _pbGetPageRange();
        pb._pbSlidingWindowCenter = (pr.minMs + pr.maxMs) / 2;
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
      pb._pbDidDrag = true;
      _pbLastScrubPos = Number(pbScrubEl.value);
      _pbLastScrubTime = performance.now();
      if (!_getScrubRAF()) {
        _setScrubRAF(requestAnimationFrame(() => {
          _setScrubRAF(0);
          applyScrub();
        }));
      }
    }, { passive: false });

    pbScrubEl.addEventListener("touchend", () => {
      const rawTarget = _scrubTouchRawTarget;
      _scrubTouchStartX = null;
      _scrubTouchStartVal = null;
      _scrubTouchRawTarget = null;
      _scrubTouchOnThumb = false;
      // Cancel any pending applyScrub rAF so it doesn't overwrite page-back
      if (_getScrubRAF()) { cancelAnimationFrame(_getScrubRAF()); _setScrubRAF(0); }
      _pbStopEdgeJog();
      _pbSnapWindowToPlayhead();
      pb._pbScrubbing = false;
      map._scrubbing = false;
      pb._pbVelocity = 0;
      pb._pbPageAutoFollow = true;

      // Page back if user dragged past the left edge
      if (_pbPagingActive() && rawTarget != null && rawTarget < 0) {
        const gb = map.getPlaybackBounds();
        const pr = _pbGetPageRange();
        if (pr.minMs > gb.minMs) {
          if (pb._pbSlidingWindowCenter != null) {
            pb._pbSlidingWindowCenter = Math.max(gb.minMs + _pbPageSizeMs / 2, pb._pbSlidingWindowCenter - _pbPageSizeMs);
          } else if (pb._pbPageIndex > 0) {
            _pbSetPage(pb._pbPageIndex - 1);
          }
          const prev = _pbGetPageRange();
          map.setPlaybackTimeMs(prev.maxMs);
          pb._pbLoopStartMs = prev.maxMs;
          pbScrubEl.max = String(prev.maxMs - prev.minMs);
          pbScrubEl.value = pbScrubEl.max;
          map.setPlaybackPlaying(true);
          pb._pbLastPerf = performance.now();
          if (!pb._pbRAF) pb._pbRAF = requestAnimationFrame(playbackLoop);
          updatePlaybackUi();
          map.drawOverlay(map.lastState);
          return;
        }
      }

      _pbResumeFromScrub(true);
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
      if (pb._pbPageIndex <= 0) return;
      _pbSetPage(pb._pbPageIndex - 1);
      // Jump playhead to start of new page
      const pr = _pbGetPageRange();
      map.setPlaybackTimeMs(pr.minMs);
      pb._pbLoopStartMs = pr.minMs;
      map.drawOverlay(map.lastState);
    });
  }
  if (pbPageNextEl) {
    pbPageNextEl.addEventListener("click", () => {
      const total = _pbPageCount();
      if (pb._pbPageIndex >= total - 1) return;
      _pbSetPage(pb._pbPageIndex + 1);
      // Jump playhead to start of new page
      const pr = _pbGetPageRange();
      map.setPlaybackTimeMs(pr.minMs);
      pb._pbLoopStartMs = pr.minMs;
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

  // fetchState/etag/delta-merge/SSE/analytics moved to ui_state_sync.js
  // (StateSync). Instantiate here (once `map`/`selectedId`/`tick` exist in
  // this closure) and wire the callbacks it needs to reach into main()'s
  // state. window.__stateSync is used by the top-level fetchState()/
  // resetAccumulated() shims declared before main().
  const _mapImmobileToParked = StateSync._mapImmobileToParked;
  window.__stateSync = new StateSync({
    appToken: APP_TOKEN,
    apiBaseUrl: appConfig.apiBaseUrl,
    getMap: () => map,
    getSelectedId: () => selectedId,
    isLoadingData: () => snapshotsMenus._isLoadingData,
    getClientId: () => _clientId,
    rescheduleTick: (delayMs) => {
      if (_tickTimeout) clearTimeout(_tickTimeout);
      _tickTimeout = setTimeout(tick, delayMs);
    },
    tickNow: () => {
      if (_tickTimeout) clearTimeout(_tickTimeout);
      tick();
    },
    POLL_MS: POLL_MS,
    POLL_MS_SSE: POLL_MS_SSE,
  });
  const pushAnalyticsEvent = (type, payload) => window.__stateSync.pushAnalyticsEvent(type, payload);
  const connectSSE = () => window.__stateSync.connectSSE();

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
    if (window._historicalState || snapshotsMenus._isLoadingData) {
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
      window.__stateSync.resetAccumulated();
      // Reschedule with exponential backoff: 5s, 10s, 20s, 40s … capped at POLL_MS.
      const backoffMs = Math.min(POLL_MS, 5000 * Math.pow(2, Math.min(_tickConsecutiveFailures - 1, 5)));
      if (_tickTimeout) clearTimeout(_tickTimeout);
      _tickTimeout = setTimeout(tick, backoffMs);
      return;
    }

    try {
    // 304 fast-path: server confirmed nothing changed. Just heartbeat the
    // status indicators (so "Live" doesn't drift to "Offline") and reschedule.
    // Skip the full draw + sidebar re-render: same data → same pixels.
    if (window.__stateSync.wasNotModified()) {
      pb._pbLastServerResponseMs = Date.now();
      _tickConsecutiveFailures = 0;
      const statusElLive = document.getElementById("statusText");
      if (statusElLive && !statusElLive.classList.contains("live")) {
        statusElLive.textContent = "Live";
        statusElLive.classList.remove("offline");
        statusElLive.classList.add("live");
      }
      _tickInFlight = false;
      const pollMs = window.__stateSync.isSSEConnected() ? POLL_MS_SSE : POLL_MS;
      if (_tickTimeout) clearTimeout(_tickTimeout);
      _tickTimeout = setTimeout(tick, pollMs);
      return;
    }

    // Ensure st.fixed is always an array (Home sensor now provided by backend)
    if (!Array.isArray(st.fixed)) st.fixed = [];

    // Map backend "immobile" → frontend "parked" for all mobile sensors
    _mapImmobileToParked(st);

    window.__lastState = st;
    pb._pbLastServerResponseMs = Date.now();
    _tickConsecutiveFailures = 0; // reset backoff on success

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
        // ALL sources are stale
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
      const hasAnyData = (Array.isArray(st.mobile) && st.mobile.length > 0) ||
                          (Array.isArray(st.fixed) && st.fixed.length > 0);
      if (!map._playbackInitialized && hasAnyData) {
        const b = map.getPlaybackBounds();
        if (isFinite(b.minMs) && isFinite(b.maxMs) && b.maxMs > b.minMs) {
          const meta = st?.meta || {};
          const nextInS = Number(meta.polling_next_update_in_s) ?? Number(meta.polling_predicted_interval_s) ?? 600;
          const speed = map.getPlaybackSpeed() || 1.0;
          const offsetMs = nextInS * 1000 * speed;
          
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

      // Update legend tab visibility based on available pollutants
      _syncLegendTabVisibility();

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
      var basePollMs = window.__stateSync.isSSEConnected() ? POLL_MS_SSE : POLL_MS;
      const clientPollS = Number(window.__lastState?.meta?.client_poll_in_s);
      const nextMs = window.__stateSync.isSSEConnected() ? basePollMs
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

  // ── Screensaver mode (bottom-left hot corner → hide all UI) ──
  // Extracted to ui_screensaver.js (ScreensaverUI). The module owns the
  // screensaver activation state, the ?demo=1 auto-enter retry loop, and the
  // hot-corner mousemove/touchstart/keydown listeners internally. `map`, `pb`,
  // `pbSpeedEl`, `pbPlayEl`, `_performCameraFit`, `updatePlaybackUi`, and
  // `playbackLoop` are shared with unmoved main() code and passed via deps.
  // `getScreensaverActive` preserves the original call site used by
  // PlaybackUI's deps (see the `playback` construction above).
  const screensaver = new ScreensaverUI({
    map,
    document,
    pb,
    deps: {
      pbSpeedEl,
      pbPlayEl,
      performCameraFit: (opts) => _performCameraFit(opts),
      updatePlaybackUi: () => updatePlaybackUi(),
      playbackLoop: () => playbackLoop(),
      getDemoParam: () => _demoParam,
    },
  });
  // Thin delegates keep every original call site in main() untouched.
  function _demoEnterWhenReady() { return screensaver._demoEnterWhenReady(); }
  function _getScreensaverActive() { return screensaver.getScreensaverActive(); }

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
        snapshotsMenus._selectedDayValue = _urlDate;

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
        _demoEnterWhenReady();
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
    _demoEnterWhenReady();
  });
}

main();

// ── PWA install banner ──────────────────────────────────────────────────────
// Runs independently of main() so a JS error elsewhere can't suppress it.
(function initPWAInstallBanner() {
  const INSTALL_KEY = "dusty_install_toast_dismissed";
  const banner = document.getElementById("pwaInstallBanner");
  if (!banner) return;
  const pwaDebug = new URLSearchParams(window.location.search).has("pwa_debug");
  const isStandaloneNow = window.matchMedia("(display-mode: standalone)").matches
    || window.navigator.standalone === true;
  if (isStandaloneNow) return; // already installed
  // Safari detection: has 'Safari' in UA but not Chrome/CriOS/Firefox/Android browser
  const ua = navigator.userAgent;
  const isSafari = /Safari/i.test(ua) && !/Chrome|CriOS|FxiOS|EdgA|OPR|SamsungBrowser/i.test(ua);
  if (!pwaDebug && !isSafari) return;
  if (!pwaDebug && localStorage.getItem(INSTALL_KEY)) return;

  const isIOS = /iPad|iPhone|iPod/.test(ua)
    || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
  const actionEl = banner.querySelector(".pwaInstallAction");
  if (actionEl) actionEl.textContent = isIOS ? "Add to Home Screen" : "Add to Dock";

  banner.classList.remove("hidden");
  requestAnimationFrame(() => requestAnimationFrame(() => banner.classList.add("visible")));

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    banner.classList.remove("visible");
    if (!pwaDebug) localStorage.setItem(INSTALL_KEY, "1");
    setTimeout(() => banner.classList.add("hidden"), 400);
  };
  const dismissBtn = document.getElementById("pwaInstallDismiss");
  if (dismissBtn) dismissBtn.addEventListener("click", dismiss);

  // Dismiss 500ms after the user starts interacting with the map (pan/zoom)
  const mapRoot = document.getElementById("mapRoot");
  if (mapRoot) {
    const dismissOnInteract = () => setTimeout(dismiss, 500);
    mapRoot.addEventListener("wheel", dismissOnInteract, { once: true, passive: true });
    mapRoot.addEventListener("touchmove", dismissOnInteract, { once: true, passive: true });
    // pointerdown with movement = drag/pan
    let dragging = false;
    mapRoot.addEventListener("pointerdown", () => { dragging = true; }, { passive: true });
    mapRoot.addEventListener("pointermove", () => {
      if (dragging && !dismissed) { dragging = false; dismissOnInteract(); }
    }, { passive: true });
    mapRoot.addEventListener("pointerup", () => { dragging = false; }, { passive: true });
  }

  setTimeout(dismiss, 8000);
}());
