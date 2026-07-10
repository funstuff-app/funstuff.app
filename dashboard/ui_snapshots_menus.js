/**
 * ui_snapshots_menus.js — snapshot save/load, historical day loading, the
 * load-saved-day modal, the playback three-dot menu (open/close/submenus),
 * menu action dispatch, and the Display submenu's slider sync.
 *
 * Extracted from app.js main(): owns the playback-menu / submenu DOM refs,
 * the menu-close and submenu show/hide debounce timers, and the two mutable
 * scalars used by both this module's methods and unmoved main() code
 * (`_isLoadingData`, `_selectedDayValue`) — those stay accessible as instance
 * properties (`this._isLoadingData` / `this._selectedDayValue`), read and
 * written directly by main()'s StateSync wiring, `tick()`, and the embed
 * ?date= URL-param handling, exactly as the plain closure variables were
 * before extraction. `canSaveSnapshot` is dead code (defined, never called)
 * in the original source; moved verbatim, not removed.
 *
 * main() constructs one instance and keeps thin one-line delegate functions
 * at the original names (loadHistoricalDay, saveSnapshot, handleMenuAction, …)
 * so every original call site is untouched.
 */
(function (root, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else {
    root.SnapshotsMenusUI = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const g = (typeof window !== "undefined") ? window : globalThis;

  // ── Constructor ──────────────────────────────────────────────────────────

  /**
   * @param {object} cfg
   *   map        — MapView instance
   *   document   — DOM document
   *   pb         — shared playback state object (BY REFERENCE; A4a)
   *   deps       — callbacks/getters into main() for shared state/behavior
   *                that stays there:
   *     getSelectedId()             — read selectedId
   *     traceEl, pbBarEl            — DOM refs main() already looked up
   *     validateStateSchema(state)  — StateSync.validateStateSchema
   *     newestReadingMsFromState(state)
   *     mapImmobileToParked(state)  — StateSync._mapImmobileToParked
   *     updatePlaybackUi()          — PlaybackUI delegate
   *     playbackLoop()              — PlaybackUI delegate
   *     setMapLoadingShade(on)      — PlaybackUI delegate
   *     tick()                      — main()'s poll-loop entry point
   *     getAutoCameraEnabled()      — read _autoCameraEnabled
   *     getCurrentThemeKey()        — read _currentThemeKey
   *     themeEl, dimEl, satEl       — ThemeUI's DOM refs
   *     applyThemeAndFilters(k, dim, sat)
   *     loadDimForTheme(k)
   *     loadSatForTheme(k)
   *     saveThemeForMode(k)
   */
  function SnapshotsMenusUI(cfg) {
    this.cfg = cfg || {};
    this.map = this.cfg.map;
    this.document = this.cfg.document;
    this.pb = this.cfg.pb;
    this.deps = this.cfg.deps || {};

    // Shared mutable scalars (read AND written by unmoved main() code too —
    // exposed as instance properties, not closed over privately).
    this._isLoadingData = false;
    this._selectedDayValue = "live";

    // ── DOM refs (menu / submenus) ──────────────────────────────────────────
    const document_ = this.document;
    this.pbMenuBtn = document_.getElementById("pbMenuBtn");
    this.pbMenu = document_.getElementById("pbMenu");
    this.pbDaysSubmenu = document_.getElementById("pbDaysSubmenu");
    this.pbThemeSubmenu = document_.getElementById("pbThemeSubmenu");
    this.pbDisplaySubmenu = document_.getElementById("pbDisplaySubmenu");
    this.menuDimEl = document_.getElementById("menuDim");
    this.menuSatEl = document_.getElementById("menuSat");
    this.menuAlphaEl = document_.getElementById("menuAlpha");

    // Menu close delay for better UX
    this._menuHideTimer = null;
    this._MENU_HIDE_DELAY = 150; // ms before hiding main menu

    // Centralized submenu show/hide debouncing
    this._SUBMENU_SHOW_DELAY = 80; // ms before showing a different submenu
    this._SUBMENU_HIDE_DELAY = 200; // ms before hiding submenu
    this._submenuShowTimer = null;
    this._submenuHideTimer = null;
    this._currentSubmenu = null; // track which submenu is open

    // Constant duplicated from ui_playback.js's copy (both app.js and that
    // module keep their own literal — see A4b); loadHistoricalDay/
    // loadSnapshotByDate multiply by it when kicking off auto-play.
    this._pbPlaybackSpeed = 1.0;

    // ── Owner token secret tap state (used by showAboutModal) ──
    this._aboutTapCount = 0;
    this._aboutTapTimer = null;
  }

  // ── Save/Load: Persist and restore daily snapshots ──────────────────────

  /**
   * Check if we have valid data that can be saved.
   */
  SnapshotsMenusUI.prototype.canSaveSnapshot = function () {
    if (this._isLoadingData) return false;
    const state = this.map._historicalMode ? g._historicalState : g.__lastState;
    if (!state) return false;
    if (!this.deps.validateStateSchema(state)) return false;
    // Must have at least some data
    const mobileCount = Array.isArray(state.mobile) ? state.mobile.length : 0;
    const fixedCount = Array.isArray(state.fixed) ? state.fixed.length : 0;
    return (mobileCount > 0 || fixedCount > 0);
  };

  SnapshotsMenusUI.prototype.updateSaveButtonState = function () {
    // No-op: old button removed, menu handles state dynamically
  };

  SnapshotsMenusUI.prototype.loadHistoricalDay = async function (dateStr) {
    const map = this.map;
    const document = this.document;
    const deps = this.deps;
    const pb = this.pb;
    const traceEl = deps.traceEl;
    const pbBarEl = deps.pbBarEl;
    const selectedId = deps.getSelectedId();

    if (dateStr === "live") {
      g._historicalState = null;
      map._historicalMode = false;
      map._historicalDateStr = null;
      // Clear all per-vehicle caches from historical viewing
      map.clearVehicleCaches();
      map._playbackPtsById = new Map();
      map._playbackTrailRangeById = new Map();
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
      const liveSt = g.__lastState || { mobile: [], fixed: [] };
      map.lastState = liveSt;
      map._ensurePlaybackPoints(liveSt);
      map.drawOverlay(liveSt);
      deps.renderLists(liveSt, selectedId);
      deps.renderDetails(liveSt, selectedId);
      // Update status bar
      const statusEl = document.getElementById("statusText");
      if (statusEl) {
        statusEl.textContent = "Live";
        statusEl.classList.add("live");
        statusEl.classList.remove("offline");
      }
      this.updateSaveButtonState();
      // Trigger an immediate live poll to get fresh data
      setTimeout(deps.tick, 100);
      return;
    }

    const statusEl = document.getElementById("statusText");
    if (statusEl) {
      statusEl.textContent = "Loading...";
      statusEl.classList.remove("live");
    }

    // Disable save while loading
    this._isLoadingData = true;
    deps.setMapLoadingShade(true);
    this.updateSaveButtonState();

    try {
      // Load from local snapshots — we already store all data (mobile, fixed,
      // purpleair, etc.) so there's no need to fetch from upstream history servers.
      // cv= busts caches poisoned by the old "immutable, max-age=86400" header
      // (removed 2026-07-10): those entries never revalidate, so only a new
      // URL gets past them. Bump cv when a served day changes under a cache.
      const resp = await fetch(`${g.appConfig.apiBaseUrl}/snapshot/load?date=${encodeURIComponent(dateStr)}&cv=2`, { headers: { "X-App-Token": g.APP_TOKEN } });
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.error || `No snapshot for ${dateStr}`);
      }
      const loadedState = await resp.json();

      // Validate the loaded data before using it
      if (!deps.validateStateSchema(loadedState)) {
        throw new Error("Invalid data structure in snapshot");
      }

      deps.mapImmobileToParked(loadedState);
      g._historicalState = loadedState;

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
      g.__stateSync.resetAccumulated();

      // Reset ALL playback state and per-vehicle caches for fresh historical data.
      // Without this, smooth-path, physics, and trace caches from prior snapshots
      // accumulate and progressively slow the render loop.
      map.clearVehicleCaches();
      map._historicalMode = true;
      map._historicalDateStr = dateStr;
      map._playbackPtsById = new Map();
      map._playbackTrailRangeById = new Map();
      map._playbackPtsKey = null;
      map._persistedTrailById = new Map();  // Clear persisted trails
      map._playbackNowMs = null;  // Reset playback time
      pb._pbPageIndex = -1;  // Reset paging for new data
      pb._pbPageAutoFollow = true;
      pb._pbSlidingWindowCenter = null;

      // Enable DVR/playback mode for historical data
      // NOTE: setPlaybackMode(true) sets _playbackLiveFollow=true and draws overlay,
      // so we must disable live follow AFTER and avoid the internal draw.
      map.playbackMode = true;  // Set directly to avoid immediate draw
      map._playbackLiveFollow = false;  // Historical always starts at beginning, not live tail
      if (traceEl) traceEl.checked = true;
      if (pbBarEl) pbBarEl.classList.remove("hidden");

      // Build playback points; start the playhead at the earliest data.
      map._ensurePlaybackPoints(g._historicalState);
      const b = map.getPlaybackBounds();
      if (isFinite(b.minMs)) map.setPlaybackTimeMs(b.minMs);

      // Store state, render sidebar, draw ONLY tiles (no overlay yet)
      map.lastState = g._historicalState;
      map.drawTiles();
      deps.renderLists(g._historicalState, selectedId);

      if (statusEl) {
        statusEl.textContent = `Snapshot: ${dateStr}`;
        statusEl.classList.remove("live");
      }

      deps.updatePlaybackUi();

      // Draw overlay NOW with playback time already set
      map.drawOverlay(g._historicalState);

      // Fetch road edges for debug visualization if enabled
      if (map._pbDebugPath && map._pbDebugRoadLines) {
        map._fetchRoadEdgesForViewport();
      }

      // Start playback loop (auto-play)
      pb._pbLastPerf = 0;
      pb._pbLastUiPerf = 0;
      pb._pbVelocity = this._pbPlaybackSpeed * (map.getPlaybackSpeed() || 1.0);
      map.setPlaybackPlaying(true);
      deps.updatePlaybackUi();
      pb._pbRAF = requestAnimationFrame(deps.playbackLoop);
    } catch (e) {
      console.error("Failed to load historical data:", e);
      if (statusEl) {
        statusEl.textContent = e.message || "Error loading history";
        statusEl.classList.add("offline");
      }
      // Show alert for user visibility
      alert(`Failed to load historical data:\n${e.message}`);
    } finally {
      this._isLoadingData = false;
      deps.setMapLoadingShade(false);
      this.updateSaveButtonState();
    }
  };

  SnapshotsMenusUI.prototype.getSnapshotDateStr = function () {
    // Determine the date to use for saving based on the data being viewed
    // 1. If viewing a historical day via the menu, use that date
    if (this._selectedDayValue && this._selectedDayValue !== "live") {
      return this._selectedDayValue;  // Already in YYYY-MM-DD format
    }

    // 2. Otherwise, derive from the newest reading timestamp in the current state
    const state = this.map._historicalMode ? g._historicalState : g.__lastState;
    const newestMs = this.deps.newestReadingMsFromState(state);
    if (newestMs != null && isFinite(newestMs)) {
      const d = new Date(newestMs);
      return d.toISOString().split("T")[0];
    }

    // 3. Fallback to today
    return new Date().toISOString().split("T")[0];
  };

  SnapshotsMenusUI.prototype.saveSnapshot = async function () {
    const map = this.map;
    const document = this.document;
    if (map._historicalMode) {
      console.warn("Cannot save: viewing historical snapshot");
      return;
    }
    const statusEl = document.getElementById("statusText");
    const dateStr = this.getSnapshotDateStr();

    try {
      const resp = await fetch(`${g.appConfig.apiBaseUrl}/snapshot/save?date=${encodeURIComponent(dateStr)}`, {
        method: "POST",
        headers: { "Content-Length": "0", "X-App-Token": g.APP_TOKEN },
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
      this.updateSaveButtonState();
    }
  };

  SnapshotsMenusUI.prototype.showLoadModal = async function () {
    const document = this.document;
    const self = this;
    // Fetch available snapshots
    let snapshots = [];
    try {
      const resp = await fetch(`${g.appConfig.apiBaseUrl}/snapshots`, { headers: { "X-App-Token": g.APP_TOKEN } });
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
          await self.loadSnapshotByDate(snap.date);
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
  };

  SnapshotsMenusUI.prototype.loadSnapshotByDate = async function (dateStr, extraParams = "") {
    const map = this.map;
    const document = this.document;
    const deps = this.deps;
    const pb = this.pb;
    const traceEl = deps.traceEl;
    const pbBarEl = deps.pbBarEl;
    const selectedId = deps.getSelectedId();

    const statusEl = document.getElementById("statusText");
    if (statusEl) {
      statusEl.textContent = "Loading...";
      statusEl.classList.remove("live");
    }

    // Disable save while loading
    this._isLoadingData = true;
    deps.setMapLoadingShade(true);
    this.updateSaveButtonState();

    try {
      // cv=2: cache-buster, see loadSnapshotForDate above.
      const resp = await fetch(`${g.appConfig.apiBaseUrl}/snapshot/load?date=${encodeURIComponent(dateStr)}${extraParams}&cv=2`, { headers: { "X-App-Token": g.APP_TOKEN } });
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${resp.status}`);
      }
      const loadedState = await resp.json();

      // Validate the loaded data before using it
      if (!deps.validateStateSchema(loadedState)) {
        throw new Error("Invalid data structure in snapshot");
      }

      deps.mapImmobileToParked(loadedState);
      g._historicalState = loadedState;

      // Load wind snapshots from the historical snapshot if present
      if (!g.WIND_LOADING_DISABLED && loadedState.wind_snapshots && typeof loadedState.wind_snapshots === "object") {
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
      map._historicalDateStr = dateStr;
      map._playbackPtsById = new Map();
      map._playbackTrailRangeById = new Map();
      map._playbackPtsKey = null;
      map._persistedTrailById = new Map();
      map._playbackNowMs = null;
      pb._pbPageIndex = -1;  // Reset paging for new data
      pb._pbPageAutoFollow = true;
      pb._pbSlidingWindowCenter = null;

      // Enable DVR/playback mode
      map.playbackMode = true;
      map._playbackLiveFollow = false;
      if (traceEl) traceEl.checked = true;
      if (pbBarEl) pbBarEl.classList.remove("hidden");

      // Build playback points; start the playhead at the earliest data.
      map._ensurePlaybackPoints(g._historicalState);
      const b = map.getPlaybackBounds();
      if (isFinite(b.minMs)) {
        map.setPlaybackTimeMs(b.minMs);
      }

      // Store state, render sidebar, draw
      map.lastState = g._historicalState;
      map.drawTiles();
      deps.renderLists(g._historicalState, selectedId);

      if (statusEl) {
        statusEl.textContent = `Snapshot: ${dateStr}`;
        statusEl.classList.remove("live");
      }

      deps.updatePlaybackUi();
      map.drawOverlay(g._historicalState);

      // Start playback loop (auto-play)
      pb._pbLastPerf = 0;
      pb._pbLastUiPerf = 0;
      pb._pbVelocity = this._pbPlaybackSpeed * (map.getPlaybackSpeed() || 1.0);
      map.setPlaybackPlaying(true);
      deps.updatePlaybackUi();
      pb._pbRAF = requestAnimationFrame(deps.playbackLoop);
    } catch (e) {
      console.error("Failed to load snapshot:", e);
      if (statusEl) {
        statusEl.textContent = "Load failed";
        statusEl.classList.add("offline");
      }
    } finally {
      this._isLoadingData = false;
      deps.setMapLoadingShade(false);
      this.updateSaveButtonState();
    }
  };

  // ── Playback menu: dropup menu for save/load/days ───────────────────────

  SnapshotsMenusUI.prototype._updateAutoCameraBtn = function () {
    const autoCameraBtn = this.document.getElementById("autoCameraBtn");
    if (!autoCameraBtn) return;
    const enabled = this.deps.getAutoCameraEnabled();
    autoCameraBtn.classList.toggle("active", enabled);
    autoCameraBtn.title = `Auto-center camera: ${enabled ? "on" : "off"}`;
    autoCameraBtn.setAttribute("aria-label", `Toggle auto-center camera (currently ${enabled ? "on" : "off"})`);
  };

  SnapshotsMenusUI.prototype.closePlaybackMenuImmediate = function () {
    if (this._menuHideTimer) {
      clearTimeout(this._menuHideTimer);
      this._menuHideTimer = null;
    }
    if (this.pbMenu) {
      this.pbMenu.classList.remove("visible");
      this.pbMenu.classList.add("hidden");
    }
    if (this.pbMenuBtn) this.pbMenuBtn.classList.remove("open");
    // Also hide submenus
    if (this.pbDaysSubmenu) this.pbDaysSubmenu.classList.remove("visible");
    const pbThemeSubmenuEl = this.document.getElementById("pbThemeSubmenu");
    if (pbThemeSubmenuEl) pbThemeSubmenuEl.classList.remove("visible");
    const pbDisplaySubmenuEl = this.document.getElementById("pbDisplaySubmenu");
    if (pbDisplaySubmenuEl) pbDisplaySubmenuEl.classList.remove("visible");
  };

  SnapshotsMenusUI.prototype.closePlaybackMenu = function () {
    this.closePlaybackMenuImmediate();
  };

  SnapshotsMenusUI.prototype.cancelMenuHide = function () {
    if (this._menuHideTimer) {
      clearTimeout(this._menuHideTimer);
      this._menuHideTimer = null;
    }
  };

  SnapshotsMenusUI.prototype.openPlaybackMenu = function () {
    if (!this.pbMenu) return;
    this.cancelMenuHide();
    this.pbMenu.classList.remove("hidden");
    this.pbMenu.classList.add("visible");
    if (this.pbMenuBtn) this.pbMenuBtn.classList.add("open");
    this.updateDaysSubmenu();
  };

  SnapshotsMenusUI.prototype.togglePlaybackMenu = function () {
    if (!this.pbMenu) return;
    const isOpen = this.pbMenu.classList.contains("visible");
    if (isOpen) {
      this.closePlaybackMenu();
    } else {
      this.openPlaybackMenu();;
    }
  };

  SnapshotsMenusUI.prototype.showSubmenuDebounced = function (submenuEl, parentEl, onShow) {
    const self = this;
    // Cancel any pending hide
    if (this._submenuHideTimer) {
      clearTimeout(this._submenuHideTimer);
      this._submenuHideTimer = null;
    }
    // If this submenu is already open, no delay needed
    if (this._currentSubmenu === submenuEl) {
      if (this._submenuShowTimer) clearTimeout(this._submenuShowTimer);
      this._submenuShowTimer = null;
      return;
    }
    // Cancel any pending show of a different submenu
    if (this._submenuShowTimer) clearTimeout(this._submenuShowTimer);
    this._submenuShowTimer = setTimeout(() => {
      self._submenuShowTimer = null;
      // Hide all submenus
      const pbThemeSubmenu = self.document.getElementById("pbThemeSubmenu");
      if (pbThemeSubmenu) pbThemeSubmenu.classList.remove("visible");
      const pbDisplaySubmenu = self.document.getElementById("pbDisplaySubmenu");
      if (pbDisplaySubmenu) pbDisplaySubmenu.classList.remove("visible");
      if (self.pbDaysSubmenu) self.pbDaysSubmenu.classList.remove("visible");
      // Show requested submenu
      if (onShow) onShow();
      submenuEl.classList.add("visible");
      self._currentSubmenu = submenuEl;
    }, this._SUBMENU_SHOW_DELAY);
  };

  SnapshotsMenusUI.prototype.hideSubmenuDebounced = function (submenuEl, parentEl, e) {
    const self = this;
    // Don't hide if moving to parent menu item or submenu itself
    if (e && e.relatedTarget && (parentEl.contains(e.relatedTarget) || submenuEl.contains(e.relatedTarget))) {
      return;
    }
    // Cancel pending show
    if (this._submenuShowTimer) {
      clearTimeout(this._submenuShowTimer);
      this._submenuShowTimer = null;
    }
    if (this._submenuHideTimer) clearTimeout(this._submenuHideTimer);
    this._submenuHideTimer = setTimeout(() => {
      submenuEl.classList.remove("visible");
      if (self._currentSubmenu === submenuEl) self._currentSubmenu = null;
      self._submenuHideTimer = null;
    }, this._SUBMENU_HIDE_DELAY);
  };

  SnapshotsMenusUI.prototype.updateDaysSubmenu = function () {
    const self = this;
    const document = this.document;
    const pbDaysSubmenu = this.pbDaysSubmenu;
    if (!pbDaysSubmenu) return;
    pbDaysSubmenu.innerHTML = "";

    // Always show Today (Live) first
    const liveItem = document.createElement("div");
    liveItem.className = "pbSubmenuItem" + (this._selectedDayValue === "live" ? " active" : "");
    liveItem.textContent = "🔮 Today (Live)";
    liveItem.addEventListener("click", (e) => {
      e.stopPropagation();
      self._selectedDayValue = "live";
      self.loadHistoricalDay("live");
      self.closePlaybackMenu();
    });
    pbDaysSubmenu.appendChild(liveItem);

    // Show the past 7 days, built purely from the local calendar — no network.
    // Whether a snapshot actually exists is discovered when the user clicks
    // (snapshot/load returns an error for missing days).
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
      const item = document.createElement("div");
      item.className = "pbSubmenuItem";
      item.textContent = `${dayName} ${monthDay}`;
      if (this._selectedDayValue === dateStr) item.classList.add("active");
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        self._selectedDayValue = dateStr;
        self.loadHistoricalDay(dateStr);
        self.closePlaybackMenu();
      });
      pbDaysSubmenu.appendChild(item);
    }
  };

  SnapshotsMenusUI.prototype.updateThemeSubmenu = function () {
    const self = this;
    const document = this.document;
    const deps = this.deps;
    const pbThemeSubmenu = this.pbThemeSubmenu;
    if (!pbThemeSubmenu) return;
    pbThemeSubmenu.innerHTML = "";

    const keys = Object.keys(g.TILE_THEMES);
    for (const k of keys) {
      const item = document.createElement("div");
      item.className = "pbSubmenuItem";
      if (k === deps.getCurrentThemeKey()) {
        item.classList.add("active");
      }
      item.textContent = g.TILE_THEMES[k].label || k;
      item.dataset.value = k;
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        deps.setCurrentThemeKey(k);
        deps.saveThemeForMode(k);
        if (deps.themeEl) deps.themeEl.value = k;
        const dim = deps.loadDimForTheme(k);
        if (deps.dimEl) deps.dimEl.value = String(dim);
        const sat = deps.loadSatForTheme(k);
        if (deps.satEl) deps.satEl.value = String(sat);
        deps.applyThemeAndFilters(k, dim, sat);
        self.updateThemeSubmenu();
        // Keep menu open so user can easily try different themes
      });
      pbThemeSubmenu.appendChild(item);
    }
  };

  SnapshotsMenusUI.prototype.showAboutModal = function () {
    const document = this.document;
    const modal = document.getElementById("aboutModal");
    if (!modal) return;
    modal.classList.remove("hidden");

    // Reset token section visibility each time modal opens
    const tokenSection = document.getElementById("ownerTokenSection");
    const tokenInput = document.getElementById("ownerTokenInput");
    const tokenSaveBtn = document.getElementById("ownerTokenSave");
    const tokenStatus = document.getElementById("ownerTokenStatus");
    if (tokenSection) tokenSection.classList.add("hidden");
    this._aboutTapCount = 0;

    // Tap version label 5 times to reveal token input
    const versionEl = modal.querySelector(".aboutVersion");
    const self = this;
    if (versionEl) {
      versionEl.style.cursor = "default";
      versionEl.onclick = () => {
        self._aboutTapCount++;
        clearTimeout(self._aboutTapTimer);
        self._aboutTapTimer = setTimeout(() => { self._aboutTapCount = 0; }, 2000);
        if (self._aboutTapCount >= 5) {
          self._aboutTapCount = 0;
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
              headers: { "Content-Type": "application/json", "X-App-Token": g.APP_TOKEN },
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
          try { await fetch("/api/auth", { method: "DELETE", headers: { "X-App-Token": g.APP_TOKEN }, credentials: "same-origin" }); } catch (_) {}
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
    modal.addEventListener("click", function handler(e) {
      if (e.target === modal || e.target.classList.contains("aboutModalX")) {
        onClose();
        modal.removeEventListener("click", handler);
      }
    });
  };

  SnapshotsMenusUI.prototype.handleMenuAction = function (action) {
    switch (action) {
      case "save":
        this.saveSnapshot();
        break;
      case "load":
        this.showLoadModal();
        break;
      case "about":
        this.showAboutModal();
        break;
      case "debug":
        if (g._fdToggle) g._fdToggle();
        break;
    }
    this.closePlaybackMenu();
  };

  SnapshotsMenusUI.prototype.syncDisplaySliders = function () {
    const deps = this.deps;
    const menuDimEl = this.menuDimEl;
    const menuSatEl = this.menuSatEl;
    const menuAlphaEl = this.menuAlphaEl;
    if (menuDimEl && deps.dimEl) menuDimEl.value = deps.dimEl.value;
    if (menuSatEl && deps.satEl) menuSatEl.value = deps.satEl.value;
    if (menuAlphaEl) {
      const raw = localStorage.getItem(g.PA_ALPHA_STORAGE_KEY);
      const v = raw != null ? Number(raw) : 27;
      menuAlphaEl.value = Math.max(0, Math.min(100, isFinite(v) ? v : 27));
    }
  };

  return SnapshotsMenusUI;
});
