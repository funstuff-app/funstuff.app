/**
 * ui_legend.js — the color legend panel (tabs, brackets, dimming, tab colors).
 *
 * Extracted from app.js main(): owns the legend DOM refs, all legend state
 * (open/collapsed, active tab, viewport auto-tab, per-tab colors, row DOM
 * tweening caches), the LEGEND_DATA bracket table, and the legend tab click/
 * close/collapse/toggle event wiring. main() constructs one instance and
 * calls into it for the handful of touch points shared with unmoved code
 * (selection handling, keyboard deselect, playback loop, poll tick).
 */
(function (root, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else {
    root.LegendUI = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const g = (typeof window !== "undefined") ? window : globalThis;

  // ── Legend bracket data (pure, no closure state) ────────────────────────

  const LEGEND_DATA = {
    pm25: {
      name: "Fine Particles",
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
      name: "Coarse Particles",
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
      name: "Ozone",
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
      name: "Nitrogen Dioxide",
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
      name: "Carbon Monoxide",
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

  const LEGEND_TWEEN_MS = 300;

  /** Dim legend rows whose lo-bound exceeds the active sensor (or max-sensor) reading value. */
  const _DIM_READING_KEYS = {
    pm25: ["PM25", "PM2.5", "pm25", "pm2.5"],
    pm10: ["PM10", "pm10"],
    o3:   ["OZNE", "O3", "OZONE", "ozone", "o3"],
    no2:  ["NO2", "no2"],
    co:   ["CO", "co"],
  };

  /** aqi.js pollutant key per legend tab (for aqiToValue). */
  const _TAB_AQI_KEY = { pm25: "pm2.5", pm10: "pm10", o3: "ozone", no2: "no2", co: "co" };

  /** Hide legend tabs for pollutants not present in any sensor's readings.
   *  PM2.5 and O3 are always shown; others appear only when data exists. */
  const _ALWAYS_VISIBLE_TABS = new Set(["pm25", "o3"]);

  // ── Constructor ──────────────────────────────────────────────────────────

  /**
   * @param {object} cfg
   *   map          — MapView instance
   *   document     — DOM document
   *   getState     — () => current state object ({ mobile, fixed })
   *   getSelectedId — () => current selectedId
   *   isMobileWidth — boolean, window.innerWidth <= 768 at page load
   */
  function LegendUI(cfg) {
    this.cfg = cfg || {};
    const document = this.cfg.document;

    // ── Color legend panel ──────────────────────────────────────────
    this.legendEl = document.getElementById("legend");
    this.legendCloseEl = document.getElementById("legendClose");
    this.legendCollapseEl = document.getElementById("legendCollapse");
    this.legendToggleEl = document.getElementById("legendToggle");
    this.legendBodyEl = document.getElementById("legendBody");
    this.legendUnitEl = document.getElementById("legendUnit");
    this.LEGEND_OPEN_KEY = "dusty_legend_open";
    this.LEGEND_TAB_KEY = "dusty_legend_tab";
    this.LEGEND_COLLAPSED_KEY = "dusty_legend_collapsed";
    // If the legend would have started hidden (mobile default, or desktop
    // without an explicit open preference), start it open-but-collapsed instead
    // so the pollutant tabs remain visible at a glance.
    this._legendStartsHidden = this.cfg.isMobileWidth
      ? true
      : localStorage.getItem(this.LEGEND_OPEN_KEY) !== "true";
    this.legendOpen = true;
    this.legendCollapsed = this._legendStartsHidden
      ? true
      : localStorage.getItem(this.LEGEND_COLLAPSED_KEY) === "true";
    this.legendTab = null;
    this.userLegendTab = null; // what the user manually chose (restored on deselect)
    this.legendUserOverride = false; // true when user manually changed tab while marker selected
    this._lastBuiltDisplayTab = undefined; // cache key for buildLegend fast-skip
    this._lastSyncedPaTab = undefined; // cache key for _syncMapPollutant fast-skip
    this._lastDimKey = undefined; // cache key for _applyLegendDimming
    this._legendAutoOpenedOnce = this.legendOpen; // skip auto-open if user already kept legend open

    this._viewportAutoTab = null; // auto-derived from highest-AQI pollutant in viewport
    this._lastViewportAutoKey = undefined; // cache key to avoid redundant rebuilds

    // Track live row DOM nodes for tweening between pollutant tabs.
    this._legendRows = [];       // current row elements in the DOM
    this._legendEntryCount = 0;  // how many entries the current legend has

    this._lastAvailableTabs = null;

    this._lastTabColorKey = undefined;
    this._persistedTabColors = {}; // last-known color per tab key

    this._wireEvents();
  }

  // ── Core queries ─────────────────────────────────────────────────────────

  /** Map a pollutant key (PM25, PM10, OZNE, O3, etc.) to a legend tab id. */
  LegendUI.prototype.pollutantToLegendTab = function (key) {
    if (!key) return null;
    const k = key.toUpperCase();
    if (k === "PM25" || k === "PM2.5") return "pm25";
    if (k === "PM10") return "pm10";
    if (k === "OZNE" || k === "OZONE" || k === "O3") return "o3";
    if (k === "NO2") return "no2";
    if (k === "CO") return "co";
    return null;
  };

  /** Get the natural (highest-AQI) pollutant tab for the currently selected sensor at playback time. */
  LegendUI.prototype._selectedSensorPollutantTab = function () {
    const map = this.cfg.map;
    const selectedId = this.cfg.getSelectedId();
    if (!selectedId || !map) return null;
    const key = map.getSelectedNaturalPollutantKey();
    return this.pollutantToLegendTab(key);
  };

  /** The effective pollutant tab: explicit user choice wins, else auto-derived from selected sensor,
   *  else auto-derived from highest-AQI pollutant visible in the viewport. */
  LegendUI.prototype._displayTab = function () {
    const selectedId = this.cfg.getSelectedId();
    if (this.legendTab) return this.legendTab;
    if (selectedId) return this._selectedSensorPollutantTab();
    return this._viewportAutoTab || "pm25";
  };

  /** Scan visible sensors and pick the pollutant with the highest center-weighted AQI. */
  LegendUI.prototype._updateViewportAutoTab = function () {
    const map = this.cfg.map;
    const selectedId = this.cfg.getSelectedId();
    if (!map || !this.legendOpen) return;
    if (this.legendTab || selectedId) return;
    const st = this.cfg.getState();
    const all = (Array.isArray(st.fixed) ? st.fixed : []).concat(Array.isArray(st.mobile) ? st.mobile : []);
    const bounds = map.getViewportBounds();
    if (!bounds) return;
    const pbTimeMs = map.playbackMode ? map.getPlaybackTimeMs() : null;
    const cLat = (bounds.minLat + bounds.maxLat) / 2;
    const cLon = (bounds.minLon + bounds.maxLon) / 2;
    const rLat = (bounds.maxLat - bounds.minLat) / 2;
    const rLon = (bounds.maxLon - bounds.minLon) / 2;
    let bestScore = -1;
    let bestKey = null;
    for (const s of all) {
      if (s && s.outlier) continue;
      if (!isFinite(s.lat) || !isFinite(s.lon)) continue;
      // For mobile sensors in playback, skip the head-position viewport check
      // because trail points have their own lat/lon checked individually below.
      const isMobilePlayback = pbTimeMs != null && map && map._playbackPtsById
                               && map._playbackPtsById.has(String(s.id));
      if (!isMobilePlayback) {
        if (s.lat < bounds.minLat || s.lat > bounds.maxLat
            || s.lon < bounds.minLon || s.lon > bounds.maxLon) continue;
      }
      // Use interpolated readings during playback, live readings otherwise
      if (pbTimeMs != null && g.fixedSensorHasHistoryTimes(s)) {
        const dLat = rLat > 0 ? Math.abs(s.lat - cLat) / rLat : 0;
        const dLon = rLon > 0 ? Math.abs(s.lon - cLon) / rLon : 0;
        const dist = Math.min(1, Math.sqrt(dLat * dLat + dLon * dLon));
        const weight = 1.0 - 0.5 * dist;
        const r = g.interpolateFixedReadingsAtTime(s, pbTimeMs);
        if (r) {
          for (const k of Object.keys(r)) {
            const rd = r[k];
            if (!rd || rd.value == null || rd.outlier) continue;
            const aqi = g.valueToAqi(k, rd.value);
            if (aqi != null) {
              const score = aqi * weight;
              if (score > bestScore) { bestScore = score; bestKey = k; }
            }
          }
        }
      } else if (pbTimeMs != null && map && map._playbackPtsById
                 && map._playbackPtsById.has(String(s.id))) {
        // Mobile sensor in playback: use per-point lat/lon for viewport check
        // and center-distance weighting, with decay gating.
        const pts = map._playbackPtsById.get(String(s.id));
        const windowMs = 45 * 60 * 1000;
        const fadeStartMs = windowMs * 0.80;
        const minT = pbTimeMs - windowMs;
        for (let pi = pts.length - 1; pi >= 0; pi--) {
          const pt = pts[pi];
          if (pt.tMs > pbTimeMs) continue;
          if (pt.tMs < minT) break;
          const ageMs = pbTimeMs - pt.tMs;
          let decay = 1.0;
          if (ageMs > fadeStartMs) {
            const u = (ageMs - fadeStartMs) / (windowMs - fadeStartMs);
            decay = (1 - u) * (1 - u);
            if (decay < 0.25) continue;
          }
          if (!isFinite(pt.lat) || !isFinite(pt.lon)) continue;
          if (pt.lat < bounds.minLat || pt.lat > bounds.maxLat
              || pt.lon < bounds.minLon || pt.lon > bounds.maxLon) continue;
          const dLat = rLat > 0 ? Math.abs(pt.lat - cLat) / rLat : 0;
          const dLon = rLon > 0 ? Math.abs(pt.lon - cLon) / rLon : 0;
          const dist = Math.min(1, Math.sqrt(dLat * dLat + dLon * dLon));
          const weight = (1.0 - 0.5 * dist) * decay;
          const pr = pt.readings;
          if (!pr) continue;
          for (const k of Object.keys(pr)) {
            const rd = pr[k];
            if (!rd || rd.value == null || rd.outlier) continue;
            const aqi = g.valueToAqi(k, rd.value);
            if (aqi != null) {
              const score = aqi * weight;
              if (score > bestScore) { bestScore = score; bestKey = k; }
            }
          }
        }
      } else {
        const dLat = rLat > 0 ? Math.abs(s.lat - cLat) / rLat : 0;
        const dLon = rLon > 0 ? Math.abs(s.lon - cLon) / rLon : 0;
        const dist = Math.min(1, Math.sqrt(dLat * dLat + dLon * dLon));
        const weight = 1.0 - 0.5 * dist;
        const r = s && s.readings;
        if (r) {
          for (const k of Object.keys(r)) {
            const rd = r[k];
            if (!rd || rd.value == null || rd.outlier) continue;
            const aqi = g.valueToAqi(k, rd.value);
            if (aqi != null) {
              const score = aqi * weight;
              if (score > bestScore) { bestScore = score; bestKey = k; }
            }
          }
        }
      }
    }
    const newTab = this.pollutantToLegendTab(bestKey);
    const cacheKey = `${newTab}|${Math.round(bestScore)}`;
    if (cacheKey === this._lastViewportAutoKey) return;
    this._lastViewportAutoKey = cacheKey;
    const tabChanged = this._viewportAutoTab !== newTab;
    this._viewportAutoTab = newTab;
    if (tabChanged) {
      this._lastBuiltDisplayTab = undefined;
      this._lastDimKey = undefined;
      this.buildLegend(true);
    } else {
      this._lastDimKey = undefined;
      this._applyLegendDimming();
    }
  };

  /** Switch legend content to match a selected sensor's primary reading (without selecting the tab). */
  LegendUI.prototype.syncLegendToSensor = function (sensor) {
    if (!sensor || this.legendTab != null) return;
    this.buildLegend(true);
    this._syncMapPollutant();
  };

  /** Sync legend content to whatever pollutant the map is currently showing on the selected marker. */
  LegendUI.prototype.syncLegendToMapSelection = function () {
    const map = this.cfg.map;
    const selectedId = this.cfg.getSelectedId();
    if (!map) return;
    if (!this.legendOpen) return;
    if (map._isTransientAnimating && map._isTransientAnimating()) return;
    // Auto-detect highest-AQI pollutant in viewport when no explicit tab or sensor
    if (!this.legendTab && !selectedId) { /* this._updateViewportAutoTab(); */ this._applyLegendDimming(); return; }
    // Re-run dimming when a tab is active (viewport may have changed)
    if (this.legendTab != null) { this._applyLegendDimming(); if (!selectedId) return; }
    if (!selectedId) return;
    this.buildLegend(true);
    this._syncMapPollutant();
  };

  /** Revert legend tab to the user's manual choice. */
  LegendUI.prototype.revertLegendTab = function () {
    if (this.legendTab !== this.userLegendTab && LEGEND_DATA[this.userLegendTab]) {
      this.legendTab = this.userLegendTab;
      this.buildLegend(true);
      this._syncMapPollutant();
    }
  };

  LegendUI.prototype._buildBracketInfo = function (entries) {
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
  };

  LegendUI.prototype._makeBracketHtml = function (i, dimGroups) {
    const g2 = dimGroups.find(g2 => i >= g2.startIdx && i <= g2.endIdx);
    if (!g2) return `<div class="legendBracket"></div>`;
    const isFirst = (i === g2.startIdx), isLast = (i === g2.endIdx), isOnly = (g2.startIdx === g2.endIdx);
    let cls = "legendBracket";
    if (isOnly) cls += " legendBracketOnly";
    else if (isFirst) cls += " legendBracketTop";
    else if (isLast) cls += " legendBracketBot";
    else cls += " legendBracketMid";
    const midIdx = Math.floor((g2.startIdx + g2.endIdx) / 2);
    const lbl = (i === midIdx) ? `<span class="legendCatLabel">${g2.name}</span>` : "";
    return `<div class="${cls}">${lbl}</div>`;
  };

  // Subtle inner edge glow, colour-matched to the pill.
  // Pill is 16 px tall (8 px radius). Spread ≤1 px keeps the glow confined
  // to the perimeter; blur 3 px bleeds it gently inward without flooding the centre.
  LegendUI.prototype._pillInnerShadow = function (color) {
    const glow = g.hexToRgba(color, 0.30);  // ambient halo from all edges in pill hue
    const rim  = g.hexToRgba(color, 0.18);  // softer top-rim in same hue
    return `inset 0 0 3px 1px ${glow}, inset 0 1px 2px ${rim}`;
  };

  LegendUI.prototype._createLegendRow = function (entry, idx, dimGroups, useDecimal) {
    const document = this.cfg.document;
    const fmt = (v) => (useDecimal && v != null) ? Number(v).toFixed(1) : `${v}`;
    const e = entry;
    const loText = e.hi != null ? fmt(e.lo) : `${fmt(e.lo)}+`;
    const hiText = e.hi != null ? fmt(e.hi) : "";
    const row = document.createElement("div");
    row.className = "legendRow";
    const pillHtml = `<div class="legendPill" style="width:${e.w}px;background:${e.color};border-color:${g.darkenHex(e.color,0.55)};box-shadow:${this._pillInnerShadow(e.color)}"></div>`;
    const rangeInner = `<span class="legendLo">${loText}</span>` +
      (hiText ? `<span class="legendDash">\u2013</span><span class="legendHi">${hiText}</span>` : ``);
    const leftZone = `<div class="legendLeftZone">${pillHtml}</div><div class="legendRange"><div class="legendRangeBg">${rangeInner}</div></div>`;
    row.innerHTML = leftZone + this._makeBracketHtml(idx, dimGroups);
    return row;
  };

  LegendUI.prototype._updateRowContent = function (row, entry, idx, dimGroups, useDecimal) {
    const document = this.cfg.document;
    const fmt = (v) => (useDecimal && v != null) ? Number(v).toFixed(1) : `${v}`;
    const e = entry;
    // Tween the pill bar (CSS transition handles the back-in curve)
    const pill = row.querySelector(".legendPill");
    if (pill) {
      pill.style.width = `${e.w}px`;
      pill.style.background = e.color;
      pill.style.borderColor = g.darkenHex(e.color, 0.55);
      pill.style.boxShadow = this._pillInnerShadow(e.color);
    }
    // True crossfade for range text: ghost overlay inside oldBg fades out to reveal new content
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
          // Clone old content as ghost inside oldBg (which gets position:relative)
          const ghost = document.createElement("span");
          ghost.innerHTML = oldBg.innerHTML;
          ghost.style.cssText = "position:absolute;inset:0;display:inline-flex;align-items:center;opacity:1;transition:opacity 0.2s ease-out;pointer-events:none;";
          oldBg.style.position = "relative";
          oldBg.innerHTML = newInner;
          oldBg.appendChild(ghost);
          // Double-rAF: ghost fades out, new content is already visible underneath
          requestAnimationFrame(() => { requestAnimationFrame(() => {
            ghost.style.opacity = "0";
          }); });
          // Clean up ghost after transition
          setTimeout(() => {
            if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
            oldBg.removeAttribute("style");
          }, 250);
        }
      }
    }
    // Crossfade bracket labels
    const oldBracket = row.querySelector(".legendBracket");
    if (oldBracket) {
      const newHtml = this._makeBracketHtml(idx, dimGroups);
      const _tmp = document.createElement("div");
      _tmp.innerHTML = newHtml;
      const _ref = _tmp.firstChild;
      if (oldBracket.className !== _ref.className || oldBracket.innerHTML !== _ref.innerHTML) {
        // Clone old content as ghost inside the bracket (which has position:relative)
        const ghost = document.createElement("span");
        ghost.innerHTML = oldBracket.innerHTML;
        ghost.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:flex-end;opacity:1;transition:opacity 0.2s ease-out;pointer-events:none;";
        oldBracket.appendChild(ghost);
        // Replace bracket content in-place
        oldBracket.className = _ref.className;
        // Set new label content (ghost covers it during crossfade)
        const newLabel = _ref.innerHTML;
        oldBracket.innerHTML = newLabel;
        oldBracket.appendChild(ghost);
        oldBracket.style.opacity = "1";
        // Double-rAF crossfade
        requestAnimationFrame(() => { requestAnimationFrame(() => {
          ghost.style.opacity = "0";
        }); });
        setTimeout(() => {
          if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
          oldBracket.removeAttribute("style");
        }, 250);
      }
    }
  };

  /** Instant (no-transition) update of a legend row — sets properties directly, no ghosts. */
  LegendUI.prototype._updateRowInstant = function (row, entry, idx, dimGroups, useDecimal) {
    const document = this.cfg.document;
    const fmt = (v) => (useDecimal && v != null) ? Number(v).toFixed(1) : `${v}`;
    const e = entry;
    const pill = row.querySelector(".legendPill");
    if (pill) {
      pill.style.width = `${e.w}px`;
      pill.style.background = e.color;
      pill.style.borderColor = g.darkenHex(e.color, 0.55);
      pill.style.boxShadow = this._pillInnerShadow(e.color);
    }
    const rangeEl = row.querySelector(".legendRange");
    if (rangeEl) {
      const bg = rangeEl.querySelector(".legendRangeBg");
      if (bg) {
        const loText = e.hi != null ? fmt(e.lo) : `${fmt(e.lo)}+`;
        const hiText = e.hi != null ? fmt(e.hi) : "";
        bg.innerHTML = `<span class="legendLo">${loText}</span>` +
          (hiText ? `<span class="legendDash">\u2013</span><span class="legendHi">${hiText}</span>` : ``);
        bg.removeAttribute("style");
      }
    }
    const oldBracket = row.querySelector(".legendBracket");
    if (oldBracket) {
      const newHtml = this._makeBracketHtml(idx, dimGroups);
      const _tmp = document.createElement("div");
      _tmp.innerHTML = newHtml;
      const _ref = _tmp.firstChild;
      if (oldBracket.className !== _ref.className || oldBracket.innerHTML !== _ref.innerHTML) {
        oldBracket.outerHTML = newHtml;
      } else {
        oldBracket.removeAttribute("style");
      }
    }
  };

  /** Dim legend rows whose lo-bound exceeds the active sensor (or max-sensor) reading value. */
  LegendUI.prototype._applyLegendDimming = function () {
    const map = this.cfg.map;
    const selectedId = this.cfg.getSelectedId();
    if (!this._legendRows || this._legendRows.length === 0) return;
    const displayTab = this._displayTab();
    const tabKey = displayTab || "pm25";
    const data = (displayTab && LEGEND_DATA[displayTab]) || LEGEND_DATA.pm25;
    const entries = data.entries;
    // Active value:
    //   1. Selected sensor — its own reading for the displayed pollutant.
    //   2. Otherwise — the rendered FIELD's max AQI, mapped through the
    //      displayed tab's bracket scale. Sampled once in `_computePaFieldSync`
    //      from the kernel-regressed field grid over the viewport — never
    //      from raw trail readings.
    let activeValue = null;
    if (map && selectedId) {
      const v = map.getSelectedPollutantValue();
      if (v != null && isFinite(v)) activeValue = v;
    } else if (map && map._paFieldMaxAqi != null && isFinite(map._paFieldMaxAqi)) {
      activeValue = this._fieldAqiToLegendValue(tabKey, map._paFieldMaxAqi);
    }
    // Only touch row DOM when the value crosses a bracket boundary. Tab
    // colors depend on the selected sensor / per-pollutant data and must
    // refresh whenever this function runs, even if the dim bracket is
    // unchanged, so we update them ahead of the dim-row skip.
    this._applyLegendTabColors();
    // Find the first row that would dim (lo > activeValue) — that index IS the bracket.
    // When activeValue is null (no field data yet), keep the last bracket — never
    // revert to showing all rows undimmed.
    if (activeValue == null && this._lastDimKey != null) return;
    let bracket = -1;
    if (activeValue != null) {
      for (let i = 0; i < entries.length; i++) {
        if (entries[i].lo > activeValue) { bracket = i; break; }
      }
      if (bracket === -1) bracket = entries.length; // above all brackets
    }
    const dimKey = `${tabKey}|${bracket}`;
    if (dimKey === this._lastDimKey) return;
    this._lastDimKey = dimKey;
    for (let i = 0; i < this._legendRows.length; i++) {
      if (!entries[i]) continue;
      this._legendRows[i].classList.toggle("legendRow--dim", bracket >= 0 && i >= bracket);
    }
  };

  LegendUI.prototype.buildLegend = function (animate = false) {
    const document = this.cfg.document;
    const selectedId = this.cfg.getSelectedId();
    if (!this.legendBodyEl) return;
    // Explicit user action (tab click): always invalidate the dim cache so
    // stale values from the previous pollutant never persist.
    if (animate) this._lastDimKey = undefined;
    const displayTab = this._displayTab();
    // Fast-skip: nothing changed since last build.
    // Include selectedId so sensor selection always refreshes tab highlighting.
    const buildKey = `${this.legendTab}|${displayTab}|${selectedId || ""}`;
    if (this._legendEntryCount > 0 && buildKey === this._lastBuiltDisplayTab) { this._applyLegendDimming(); return; }
    this._lastBuiltDisplayTab = buildKey;
    const data = (displayTab && LEGEND_DATA[displayTab]) || LEGEND_DATA.pm25;
    const legendNameEl = document.getElementById("legendName");
    if (legendNameEl) legendNameEl.textContent = displayTab ? data.name : "Show All";
    if (this.legendUnitEl) this.legendUnitEl.textContent = data.unit;

    const entries = data.entries;
    const { dimGroups } = this._buildBracketInfo(entries);
    const useDecimal = entries.some(e =>
      (e.lo != null && e.lo % 1 !== 0) || (e.hi != null && e.hi % 1 !== 0)
    );

    const oldCount = this._legendEntryCount;
    const newCount = entries.length;
    const commonCount = Math.min(oldCount, newCount);

    // First render: full build (no existing DOM to tween from)
    if (oldCount === 0 || this._legendRows.length === 0) {
      this.legendBodyEl.innerHTML = "";
      this._legendRows = [];
      for (let i = 0; i < newCount; i++) {
        const row = this._createLegendRow(entries[i], i, dimGroups, useDecimal);
        this.legendBodyEl.appendChild(row);
        this._legendRows.push(row);
      }
      this._legendEntryCount = newCount;
      const tabs = this.legendEl ? this.legendEl.querySelectorAll(".legendTab") : [];
      const autoTabKey = this.legendTab == null ? displayTab : null;
      for (const t of tabs) {
        const k = t.dataset.legend;
        t.classList.toggle("active", k === this.legendTab);
        t.classList.toggle("auto-active", this.legendTab == null && k === autoTabKey);
        t.classList.toggle("tab-dim", (this.legendTab != null ? k !== this.legendTab : autoTabKey != null && k !== autoTabKey));
      }
      this._syncLegendTabVisibility();
      this._applyLegendDimming();
      return;
    }

    // ── Update existing DOM in place (always — never tear down) ──

    // When not animating, suppress CSS transitions so changes are instant
    if (!animate) {
      this.legendBodyEl.classList.add("legend-no-transition");
    }

    // Tween (or instant-set) existing rows: bar width/color + text
    for (let i = 0; i < commonCount; i++) {
      if (animate) {
        this._updateRowContent(this._legendRows[i], entries[i], i, dimGroups, useDecimal);
      } else {
        // Instant: set properties directly, no crossfade ghosts
        this._updateRowInstant(this._legendRows[i], entries[i], i, dimGroups, useDecimal);
      }
    }

    // Remove excess rows
    if (oldCount > newCount) {
      for (let i = newCount; i < oldCount; i++) {
        const row = this._legendRows[i];
        if (animate) {
          row.classList.add("leaving");
          setTimeout(() => { if (row.parentNode) row.parentNode.removeChild(row); }, LEGEND_TWEEN_MS);
        } else {
          if (row.parentNode) row.parentNode.removeChild(row);
        }
      }
      this._legendRows.length = newCount;
    }

    // Add new rows
    if (newCount > oldCount) {
      for (let i = oldCount; i < newCount; i++) {
        const row = this._createLegendRow(entries[i], i, dimGroups, useDecimal);
        if (animate) row.classList.add("entering");
        this.legendBodyEl.appendChild(row);
        this._legendRows.push(row);
        if (animate) requestAnimationFrame(() => { row.classList.remove("entering"); });
      }
    }

    this._legendEntryCount = newCount;
    const tabs = this.legendEl ? this.legendEl.querySelectorAll(".legendTab") : [];
    const autoTabKey = this.legendTab == null ? displayTab : null;
    for (const t of tabs) {
      const k = t.dataset.legend;
      t.classList.toggle("active", k === this.legendTab);
      t.classList.toggle("auto-active", this.legendTab == null && k === autoTabKey);
      t.classList.toggle("tab-dim", (this.legendTab != null ? k !== this.legendTab : autoTabKey != null && k !== autoTabKey));
    }
    this._syncLegendTabVisibility();
    this._applyLegendDimming();

    // Re-enable transitions after instant update completes
    if (!animate) {
      // Use rAF to ensure the browser has painted the instant values
      // before re-enabling transitions
      requestAnimationFrame(() => {
        this.legendBodyEl.classList.remove("legend-no-transition");
      });
    }
  };

  LegendUI.prototype._syncLegendTabVisibility = function () {
    if (!this.legendEl) return;
    const st = this.cfg.getState();
    const all = (Array.isArray(st.fixed) ? st.fixed : []).concat(Array.isArray(st.mobile) ? st.mobile : []);
    const found = new Set();
    for (const s of all) {
      const r = s && s.readings;
      if (!r) continue;
      for (const k of Object.keys(r)) {
        const tab = this.pollutantToLegendTab(k);
        if (tab) found.add(tab);
      }
    }
    // Build a stable key to skip DOM work when nothing changed
    const availKey = Array.from(found).sort().join(",");
    if (availKey === this._lastAvailableTabs) return;
    this._lastAvailableTabs = availKey;

    for (const t of this.legendEl.querySelectorAll(".legendTab")) {
      const tab = t.dataset.legend;
      const visible = _ALWAYS_VISIBLE_TABS.has(tab) || found.has(tab);
      t.style.display = visible ? "" : "none";
    }
  };

  LegendUI.prototype.updateLegendVisibility = function () {
    if (this.legendEl) {
      this.legendEl.classList.toggle("hidden", !this.legendOpen);
      this.legendEl.classList.toggle("legend--collapsed", this.legendOpen && this.legendCollapsed);
    }
    if (this.legendToggleEl) this.legendToggleEl.classList.toggle("active", this.legendOpen);
    if (this.legendCollapseEl) {
      const svg = this.legendCollapseEl.querySelector("svg");
      if (svg) svg.style.transform = this.legendCollapsed ? "rotate(180deg)" : "";
      this.legendCollapseEl.title = this.legendCollapsed ? "Expand legend" : "Collapse legend";
    }
    localStorage.setItem(this.LEGEND_OPEN_KEY, this.legendOpen ? "true" : "false");
    localStorage.setItem(this.LEGEND_COLLAPSED_KEY, this.legendCollapsed ? "true" : "false");
    if (this.legendOpen) this._applyLegendTabColors();
    else this._clearLegendTabColors();
  };

  /** Convert a per-pollutant field AQI to the concentration unit the legend
   *  brackets are authored in. O3 legend bands are in ppb but aqi.js works
   *  in ppm, so scale that one pollutant. */
  LegendUI.prototype._fieldAqiToLegendValue = function (tabKey, aqi) {
    if (aqi == null || !isFinite(aqi)) return null;
    const aqiKey = _TAB_AQI_KEY[tabKey] || "pm2.5";
    let v = g.aqiToValue(aqiKey, aqi);
    if (v == null || !isFinite(v)) return null;
    if (tabKey === "o3") v *= 1000;
    return v;
  };

  /** In collapsed mode, color each tab's text using the same AQI color logic as the bars.
   *  Sources, in priority order:
   *    1. Selected sensor — color each tab from that sensor's own readings.
   *    2. Otherwise — sample the rendered FIELD's max AQI (one value, set
   *       by `_computePaFieldSync` from the kernel-regressed grid) and map
   *       it through each tab's bracket scale. The field is authoritative;
   *       trails are not consulted directly. */
  LegendUI.prototype._applyLegendTabColors = function () {
    const map = this.cfg.map;
    const selectedId = this.cfg.getSelectedId();
    if (!this.legendEl) return;
    // Runs on every playback-loop iteration (rAF rate) while the legend is
    // open. Query once; and below, only touch a tab's inline style when the
    // resolved color/primary state actually changed: four style writes per
    // tab per frame at 120 Hz is a style recalc every frame for nothing.
    if (!this._legendTabEls) this._legendTabEls = Array.from(this.legendEl.querySelectorAll(".legendTab"));
    const tabs = this._legendTabEls;
    if (!this._legendTabApplied) this._legendTabApplied = new Map();

    const selectedSensor = (map && selectedId)
      ? (() => {
          const st = this.cfg.getState();
          const sel = g.parseKey(selectedId);
          if (!sel) return null;
          const list = sel.type === "mobile"
            ? (Array.isArray(st.mobile) ? st.mobile : [])
            : (Array.isArray(st.fixed) ? st.fixed : []);
          return list.find(s => s && String(s.id) === String(sel.id)) || null;
        })()
      : null;

    // Per-pollutant field maxes from the map — one AQI value per tab.
    // Lazy getter: only computes when stale; reuses memoized bag otherwise.
    // Keeps the field render path cheap when no one is reading legend colors.
    const perPollField = (map && typeof map.getPerPollutantFieldMax === "function")
      ? map.getPerPollutantFieldMax()
      : null;

    for (const tab of tabs) {
      const tabKey = tab.dataset.legend;
      if (!tabKey || !LEGEND_DATA[tabKey]) continue;
      const data = LEGEND_DATA[tabKey];
      const entries = data.entries;
      let activeValue = null;
      // Prefer the map's readings bag at the DISPLAYED time — same source as
      // the marker label and legend bars. The state snapshot is live-only and
      // diverges from the marker during playback (wrong title colors).
      const selReadings = (selectedId && map && typeof map.getSelectedReadings === "function" && map.getSelectedReadings())
        || (selectedSensor && selectedSensor.readings) || null;
      if (selReadings) {
        const keys = _DIM_READING_KEYS[tabKey] || [];
        for (const rk of keys) {
          let rd = selReadings[rk];
          if (rd != null && typeof rd !== "object") rd = { value: rd };
          if (rd && rd.value != null && isFinite(rd.value)) {
            const n = parseFloat(rd.value);
            if (isFinite(n)) { activeValue = n; break; }
          }
        }
      }
      if (activeValue == null && perPollField) {
        activeValue = this._fieldAqiToLegendValue(tabKey, perPollField[tabKey]);
      }
      let color = null;
      if (activeValue != null) {
        for (let i = entries.length - 1; i >= 0; i--) {
          if (activeValue >= entries[i].lo) {
            color = entries[i].color;
            break;
          }
        }
      }
      if (color) {
        this._persistedTabColors[tabKey] = color;
      } else {
        color = this._persistedTabColors[tabKey] || null;
      }
      // Preserve the pre-color dim contrast: the active/auto-active tab
      // reads full-strength, others read at reduced opacity so the
      // selected pollutant pops without graying out the others.
      const isPrimary = tab.classList.contains("active")
        || tab.classList.contains("auto-active");
      const sig = (color || "") + "|" + (isPrimary ? 1 : 0);
      if (this._legendTabApplied.get(tab) === sig) continue;
      this._legendTabApplied.set(tab, sig);
      if (color) {
        tab.style.color = color;
        tab.style.filter = "none";
        tab.style.textShadow = `0 0 6px ${g.hexToRgba(color, 0.4)}`;
        tab.style.opacity = isPrimary ? "" : "0.5";
      } else {
        tab.style.color = "";
        tab.style.filter = "";
        tab.style.textShadow = "";
        tab.style.opacity = "";
      }
    }
  };
  LegendUI.prototype._clearLegendTabColors = function () {
    if (!this.legendEl) return;
    if (this._legendTabApplied) this._legendTabApplied.clear();
    for (const tab of this.legendEl.querySelectorAll(".legendTab")) {
      tab.style.color = "";
      tab.style.filter = "";
      tab.style.textShadow = "";
    }
  };

  /** Sync PA field pollutant to match legend display (explicit tab or sensor-derived). */
  /** Sync map-layer pollutant state (PA field + marker override) to match legend.
   *  Only explicit tab clicks and sensor-derived tabs affect the map layers.
   *  Viewport auto-tab only drives the legend panel UI. */
  LegendUI.prototype._syncMapPollutant = function () {
    const map = this.cfg.map;
    const selectedId = this.cfg.getSelectedId();
    if (!map) return;
    const mapTab = this.legendTab || (selectedId ? this._selectedSensorPollutantTab() : null);
    const syncKey = `${this.legendTab}|${mapTab}`;
    if (syncKey === this._lastSyncedPaTab) return;
    this._lastSyncedPaTab = syncKey;
    if (typeof map.setPaFieldPollutant === "function") map.setPaFieldPollutant(mapTab);
    if (typeof map.setMarkerPollutantOverride === "function") map.setMarkerPollutantOverride(this.legendTab);
  };

  // ── Event wiring (attachment site stays with construction; bodies match originals) ──

  LegendUI.prototype._wireEvents = function () {
    const legendEl = this.legendEl;
    const self = this;

    // Legend tab clicks + hover highlight
    if (legendEl) {
      const allTabs = legendEl.querySelectorAll(".legendTab");
      for (const tab of allTabs) {
        // Activate on mousedown (not click) for snappier perceived response.
        // Button 0 only — ignore right/middle. preventDefault so a follow-up
        // click event doesn't double-fire the toggle.
        tab.addEventListener("mousedown", (ev) => {
          if (ev.button !== 0) return;
          ev.preventDefault();
          const clicked = tab.dataset.legend || "pm25";
          self.legendTab = (clicked === self.legendTab) ? null : clicked;
          self.userLegendTab = self.legendTab;
          self.legendUserOverride = !!self.cfg.getSelectedId();
          if (self.legendTab) localStorage.setItem(self.LEGEND_TAB_KEY, self.legendTab);
          else localStorage.removeItem(self.LEGEND_TAB_KEY);
          self._lastViewportAutoKey = undefined;
          self._syncMapPollutant();
          self.buildLegend(true);
        });
        tab.addEventListener("mouseenter", () => {
          if (self.legendTab != null) return; // user has a tab selected, don't interfere
          const hovered = tab.dataset.legend || "pm25";
          for (const t of allTabs) {
            const k = t.dataset.legend;
            t.classList.toggle("auto-active", k === hovered);
            t.classList.toggle("tab-dim", k !== hovered);
          }
        });
        tab.addEventListener("mouseleave", () => {
          if (self.legendTab != null) return;
          // Restore: re-derive from current state (selected sensor, or viewport auto)
          const autoTabKey = self.cfg.getSelectedId() ? self._selectedSensorPollutantTab() : self._viewportAutoTab;
          for (const t of allTabs) {
            const k = t.dataset.legend;
            t.classList.toggle("auto-active", k === autoTabKey);
            t.classList.toggle("tab-dim", autoTabKey != null && k !== autoTabKey);
          }
        });
      }
    }

    if (this.legendCloseEl) {
      this.legendCloseEl.addEventListener("click", () => {
        self.legendOpen = false;
        self.buildLegend();
        self.updateLegendVisibility();
      });
    }
    if (this.legendCollapseEl) {
      this.legendCollapseEl.addEventListener("click", () => {
        self.legendCollapsed = !self.legendCollapsed;
        self.updateLegendVisibility();
      });
    }
    if (this.legendToggleEl) {
      this.legendToggleEl.addEventListener("click", () => {
        self.legendOpen = !self.legendOpen;
        self.updateLegendVisibility();
        if (self.legendOpen) {
          self._lastViewportAutoKey = undefined;
          // self._updateViewportAutoTab();
          self._syncMapPollutant();
          self.buildLegend(true);
        }
      });
    }
  };

  return LegendUI;
});
