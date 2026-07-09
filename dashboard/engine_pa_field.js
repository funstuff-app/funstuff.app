/**
 * engine_pa_field.js — PaFieldRenderer: PurpleAir/pollution scalar-field pipeline.
 *
 * Nadaraya-Watson kernel-regression heatmap of PM2.5/AQI on a coarse grid,
 * per-pollutant field maxima, color-transition pre-warming via a Web Worker
 * (pa_field_worker.js), and compositing of the field canvas onto the tiles
 * layer.
 *
 * MapView remains the composition root and keeps the shared view state; its
 * own setPaFieldPollutant/_compositePaFieldOnTiles/_ensurePaField/etc. become
 * one-line delegates to `this.paField.<method>()`.
 *
 * Shared MapView fields read/written here (kept on MapView, not moved, because
 * non-moved MapView code and/or app.js also touch them): center, zoom, _cssW,
 * _cssH, _dpr, playbackMode, _historicalMode, lastState, selectedId, pfctx,
 * paFieldCanvasEl, _trailCacheViewKey, _trailCacheCanvas, _paFieldPollutant,
 * _markerPollutantOverride, _paFieldCanvas, _paFieldCtx, _paGrid, _paFieldBufW,
 * _paFieldBufH, _paFieldKey, _paFieldMaxAqi, _paFieldValidRange,
 * _virtualMobileSensors. Shared MapView methods used via view: getPlaybackTimeMs,
 * getPlaybackBounds, _isTransientAnimating, _isGesturing, _fetchWindField,
 * _sampleWindAtCenter, _dataNowMs, drawOverlay, _redrawViewOnly,
 * _invalidateOverlayStatic, parseKey (global).
 */
(function (root, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else {
    root.PaFieldRenderer = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Globals from earlier-loaded scripts (projections.js, aqi.js, data_utils.js,
  // engine_field_sensors.js) are resolved lazily at call time via `g` — never
  // at module factory time (node tests have no browser globals). FieldSensors
  // helpers/consts (the ones map_view.js destructures into file-scope) are read
  // as `g.FieldSensors.<name>` at call time.
  var g = (typeof window !== "undefined") ? window : globalThis;

  // Mirror map_view.js's module-scoped `_isLite` (URL ?lite=1). Computed lazily
  // so node (no window.location) does not throw.
  function _liteFlag() {
    try {
      return new URLSearchParams(g.location.search).get("lite") === "1";
    } catch (_) {
      return false;
    }
  }

  class PaFieldRenderer {
    /**
     * @param {object} view — MapView instance (owns the shared canvas/center/
     *   zoom/playback/lastState state; see file header for the full shared-field
     *   list).
     */
    constructor(view) {
      this.view = view;

      // PA field dim: 1.0 = full (PM2.5 selected or legend closed), 0.05 = dimmed (other pollutant)
      this._paFieldDimTarget = 1.0;
      this._paFieldDimCurrent = 1.0;
      this._paFieldDimRAF = null;
      // Cross-fade: previous field canvas + transition timing.
      // The fade uses "lighter" (additive) compositing so prev*(1-t) + new*t
      // produces a linear color blend. In cells where prev == new this collapses
      // to a single draw at dimAlpha (no visible effect); in cells that changed
      // you get a smooth color transition with no luminance dip.
      this._paFieldPrevCanvas = null;
      this._paFieldFadeStart = 0;
      this._paFieldFadeMs = 300;
      this._paFieldFadeRAF = null;
      // Fingerprint validity window: view key / fixed-array reference used by the
      // fast-skip path (the range itself lives on view, shared with app.js).
      this._paFieldValidViewKey = null;
      this._paFieldValidFixed = null; // reference to fixed array (invalidates on new data)
      this._paFieldValidPollutant = null;
      this._paFieldFingerprint = "";
      // Worker-based pre-warming: compute upcoming color transition fields off-thread.
      this._paWorker = null;
      this._paWorkerJobId = 0;
      this._paWorkerPending = false;
      this._paWorkerFingerprint = ""; // fingerprint of the in-flight pre-warm job
      // Pre-warmed pixel buffers keyed by color fingerprint (view-independent).
      this._paFieldPrewarmed = new Map(); // fingerprint → { px, gw, gh }
      this._paFieldCacheMax = 16;
      // Pre-warm scan throttle: avoid re-scanning sensor history every frame.
      this._preWarmScanValidUntilMs = null;
      this._preWarmScanFixed = null;
      this._preWarmScanFromMs = null;
      // View state when PA field was last computed (for gesture translate)
      this._paFieldComputedView = null; // { centerLat, centerLon, zoom }
      // Margin-exhaustion flag: forces _ensurePaField to recompute despite animating.
      this._paFieldMarginExhausted = false;
      // Per-frame dedup timestamp for _compositePaFieldOnTiles.
      this._compositeLastDrawMs = 0;
      // Per-pollutant field-max cache (lazy, keyed by _paFieldKey).
      this._paFieldMaxAqiPerPollutant = null;
      this._perPollCacheKey = null;
      this._perPollLastInputs = null;
      this._perPollLastComputeMs = 0;
      // Perf probe (self-initializes on first composite).
      this._perfProbe = null;
    }

    setPaFieldPollutant(tab) {
      const view = this.view;
      const prev = view._paFieldPollutant;
      view._paFieldPollutant = tab || null;
      if (prev !== view._paFieldPollutant) {
        view._invalidateOverlayStatic();
        this._invalidatePaField();
        // Invalidate trail canvas cache so trails redraw with new pollutant colors
        view._trailCacheViewKey = "";
        view._trailCacheCanvas = null;
        view._redrawViewOnly();
      }
    }

    /** Synchronously look up the selected sensor's reading for a specific pollutant tab.
     *  Returns the numeric value or null. Does NOT require a render cycle. */
    getReadingForPollutant(tab) {
      const view = this.view;
      if (!view.selectedId || !view.lastState || !tab) return null;
      const parsed = g.parseKey(view.selectedId);
      if (!parsed) return null;
      const list = (parsed.type === "mobile")
        ? (view.lastState.mobile || [])
        : (view.lastState.fixed || []);
      const sensor = list.find(s => s && String(s.id) === String(parsed.id));
      if (!sensor) return null;
      const pr = g.FieldSensors._readingForLegendTab(sensor.readings, tab);
      return (pr && pr.value != null) ? parseFloat(pr.value) : null;
    }

    /** Set marker pollutant override (only from explicit legend tab clicks). */
    setMarkerPollutantOverride(tab) {
      const view = this.view;
      const prev = view._markerPollutantOverride;
      view._markerPollutantOverride = tab || null;
      if (prev !== view._markerPollutantOverride) {
        view._invalidateOverlayStatic();
        if (view.lastState) view.drawOverlay(view.lastState);
      }
    }

    /**
     * Animate PA field dim alpha toward target. Called from app.js when legend tab changes.
     * @param {number} target - 1.0 for full, 0.05 for dimmed
     */
    setPaFieldDim(target) {
      const view = this.view;
      this._paFieldDimTarget = target;
      if (this._paFieldDimRAF) return; // animation already running
      const animate = () => {
        const diff = this._paFieldDimTarget - this._paFieldDimCurrent;
        if (Math.abs(diff) < 0.01) {
          this._paFieldDimCurrent = this._paFieldDimTarget;
          this._paFieldDimRAF = null;
          view._redrawViewOnly();
          return;
        }
        // Ease toward target (~200ms settle)
        this._paFieldDimCurrent += diff * 0.15;
        view._redrawViewOnly();
        this._paFieldDimRAF = requestAnimationFrame(animate);
      };
      this._paFieldDimRAF = requestAnimationFrame(animate);
    }

    _invalidatePaField() {
      const view = this.view;
      view._paFieldKey = "";
      view._paFieldValidRange = null;
      this._preWarmScanValidUntilMs = null;
      // The cached canvas pixels belong to the prior pollutant/view/state. Every
      // reuse path keys off `_paFieldCanvas` truthiness (animation fast-path
      // line ~6514, the transient-animating early-return in `_ensurePaField`
      // line ~6664, the cross-fade pickup line ~6745). Leaving stale pixels
      // here lets those paths replay the wrong pollutant's heatmap.
      view._paFieldCanvas = null;
      view._paFieldCtx = null;
      this._paFieldPrevCanvas = null;
      this._paFieldComputedView = null;
      this._paFieldValidPollutant = null;
      this._paFieldValidViewKey = null;
      this._paFieldValidFixed = null;
      this._paFieldFingerprint = "";
      // Per-pollutant max bag is populated lazily by getPerPollutantFieldMax()
      // and keyed by _paFieldKey. Clear both so the next legend read recomputes.
      view._paFieldMaxAqi = null;
      this._paFieldMaxAqiPerPollutant = null;
      this._perPollCacheKey = null;
      this._perPollLastInputs = null;
      // `_compositePaFieldOnTiles` dedups itself within a 4 ms window. After an
      // invalidation we want the *next* composite to actually run, even if
      // another RAF chain (playback loop, follow, scrub) composited a moment ago.
      this._compositeLastDrawMs = 0;
    }

    /**
     * Composite the PA scalar field onto the tiles canvas (above tiles, below overlay).
     * Restores tiles from snapshot first to avoid opacity accumulation on repeated calls.
     */
    _compositePaFieldOnTiles(state, tilesJustRedrawn = false) {
      const view = this.view;
      // Per-frame deduplication: skip if already composited this frame.
      {
        const _now = performance.now();
        if (!tilesJustRedrawn && this._compositeLastDrawMs && (_now - this._compositeLastDrawMs) < 4) return;
        this._compositeLastDrawMs = _now;
      }
      const pbMs = view.playbackMode ? view.getPlaybackTimeMs() : null;

      // Fetch wind field in background for debug vector overlay (does not affect PA field rendering)
      if (!_liteFlag()) view._fetchWindField();

      // ── PERF PROBE ──
      {
        if (!this._perfProbe) this._perfProbe = { fastPath: 0, slowPath: 0, lastReport: 0, ensureMs: 0, ensureCalls: 0 };
        const _pp = this._perfProbe;
        const _now2 = performance.now();
        if (_now2 - _pp.lastReport > 2000) {
          if (_pp.fastPath + _pp.slowPath > 0) {
            // console.log(`[PA-PROBE] fast:${_pp.fastPath} slow:${_pp.slowPath} ensureAvg:${_pp.ensureCalls ? (_pp.ensureMs/_pp.ensureCalls).toFixed(1) : '-'}ms gesturing:${view._isGesturing()} transient:${view._isTransientAnimating()} scrub:${!!view._scrubbing} pinch:${view._pinchZooming} drag:${view._mouseDragging}`);
          }
          _pp.fastPath = 0; _pp.slowPath = 0; _pp.ensureMs = 0; _pp.ensureCalls = 0; _pp.lastReport = _now2;
        }
      }

      // ── Animation fast-path: transform existing PA field canvas instead of recomputing ──
      if (view._isTransientAnimating() && view._paFieldCanvas && this._paFieldComputedView) {
        if (this._perfProbe) this._perfProbe.fastPath++;
        const ctx = view.pfctx;
        if (!ctx) return;
        const pw = view.paFieldCanvasEl.width;
        const ph = view.paFieldCanvasEl.height;
        const dpr = view._dpr || (window.devicePixelRatio || 1);
        const cssW = view._cssW || 1;
        const cssH = view._cssH || 1;
        const prev = this._paFieldComputedView;
        const bufW = view._paFieldBufW || cssW;
        const bufH = view._paFieldBufH || cssH;
        const offX = (bufW - cssW) / 2;
        const offY = (bufH - cssH) / 2;

        // Margin exhaustion: if pan delta exceeds the overfetch margin, fall through
        // to the static path which will recompute the field centered on current view.
        const prevC = g.latLonToWorld(prev.centerLat, prev.centerLon, prev.zoom);
        const currC = g.latLonToWorld(view.center.lat, view.center.lon, prev.zoom);
        const absTx = Math.abs(prevC.x - currC.x);
        const absTy = Math.abs(prevC.y - currC.y);
        if (absTx >= offX * g.FieldSensors._OVERFETCH_MARGIN_EXHAUST || absTy >= offY * g.FieldSensors._OVERFETCH_MARGIN_EXHAUST) {
          // Force _ensurePaField to recompute despite animating
          this._paFieldMarginExhausted = true;
        } else {
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, pw, ph);
          const sZoom = Math.pow(2, view.zoom - prev.zoom);
          if (Math.abs(sZoom - 1) > 0.001) {
            // Scale + translate around viewport center (mirrors drawTiles pinch path)
            const txPan = (prevC.x - currC.x) * sZoom;
            const tyPan = (prevC.y - currC.y) * sZoom;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.translate(cssW / 2, cssH / 2);
            ctx.scale(sZoom, sZoom);
            ctx.translate((-cssW / 2) + (txPan / sZoom), (-cssH / 2) + (tyPan / sZoom));
          } else {
            // Pan only: translate
            const tx = prevC.x - currC.x;
            const ty = prevC.y - currC.y;
            ctx.setTransform(dpr, 0, 0, dpr, dpr * tx, dpr * ty);
          }
          ctx.globalAlpha = this._paFieldDimCurrent;
          const _uq = (window._fieldDebug && window._fieldDebug.upscaleQuality) || "high";
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = (_uq === "2pass") ? "medium" : _uq;
          ctx.drawImage(view._paFieldCanvas, -offX, -offY, bufW, bufH);
          ctx.restore();
          // Drop in-progress cross-fade to avoid stale fades during gesture
          this._paFieldPrevCanvas = null;
          return;
        }
      }

      // ── Static Nadaraya-Watson interpolation path ──
      if (this._perfProbe) this._perfProbe.slowPath++;
      {
        const _t0 = performance.now();
        this._ensurePaField(state, pbMs);
        const _dur = performance.now() - _t0;
        if (this._perfProbe) { this._perfProbe.ensureMs += _dur; this._perfProbe.ensureCalls++; }
      }
      if (pbMs != null && isFinite(pbMs)) this._preWarmPaFields(state, pbMs);
      const ctx = view.pfctx;
      if (!ctx) return;
      const pw = view.paFieldCanvasEl.width;
      const ph = view.paFieldCanvasEl.height;
      // Clear the dedicated PA field canvas every frame (no snapshot restore needed)
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, pw, ph);
      if (!view._paFieldCanvas) { ctx.restore(); return; }

      // Overfetch offset: the field canvas is larger than the viewport.
      // Draw it shifted so the viewport windows over the center portion.
      // Use 9-param drawImage so source canvas can be any resolution (2pass = small).
      const _dpr = view._dpr || (window.devicePixelRatio || 1);
      const _cssW = view._cssW || 1;
      const _cssH = view._cssH || 1;
      const _bw = view._paFieldBufW || _cssW;
      const _bh = view._paFieldBufH || _cssH;
      const _offPx = (_bw - _cssW) / 2 * _dpr;
      const _offPy = (_bh - _cssH) / 2 * _dpr;
      const _uq = (window._fieldDebug && window._fieldDebug.upscaleQuality) || "high";
      const _iq = (_uq === "2pass") ? "medium" : _uq;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = _iq;

      // Helper: draw a PA field canvas (any resolution) into the viewport.
      const _drawPaCanvas = (src, alpha) => {
        ctx.globalAlpha = alpha;
        ctx.drawImage(src, 0, 0, src.width, src.height,
                      -_offPx, -_offPy, _bw * _dpr, _bh * _dpr);
      };

      // Cross-fade from previous field canvas to current one
      const dimAlpha = this._paFieldDimCurrent;
      const fadeT = this._paFieldPrevCanvas
        ? Math.min(1, (performance.now() - this._paFieldFadeStart) / this._paFieldFadeMs)
        : 1;
      if (this._paFieldPrevCanvas && fadeT < 1) {
        // Additive crossfade: prev*(1-t) + new*t under "lighter" composite gives
        // a linear color blend with constant alpha. In cells where prev == new
        // this collapses to exactly new*dimAlpha (no visible fade), so unchanged
        // regions stay still while changed regions smoothly morph. No masking,
        // no cell-boundary banding.
        _drawPaCanvas(this._paFieldPrevCanvas, (1 - fadeT) * dimAlpha);
        const prevOp = ctx.globalCompositeOperation;
        ctx.globalCompositeOperation = "lighter";
        _drawPaCanvas(view._paFieldCanvas, fadeT * dimAlpha);
        ctx.globalCompositeOperation = prevOp;
        ctx.globalAlpha = 1;
        // Schedule another frame to complete the fade (no-op if playback loop is running)
        if (!this._paFieldFadeRAF) {
          this._paFieldFadeRAF = requestAnimationFrame(() => {
            this._paFieldFadeRAF = null;
            this._compositePaFieldOnTiles(view.lastState);
            view.drawOverlay(view.lastState, { cacheUnderlay: true });
          });
        }
      } else {
        if (this._paFieldPrevCanvas) this._paFieldPrevCanvas = null;
        _drawPaCanvas(view._paFieldCanvas, dimAlpha);
      }
      ctx.restore();
    }

    /**
     * Precipitation-radar style: Nadaraya-Watson kernel regression of PM2.5 values
     * on a coarse grid, map each to a color via _pm25ToRgbSmooth, bilinear-upscale.
     *
     * V(P) = Σ(w_i · AQI_i) / Σ(w_i),  w_i = exp(-d²/2σ²)
     * (Gaussian kernel, AQI-space weighted mean)
     *
     * Optimized for real-time scrubbing:
     *  - Always synchronous (kernel regression is <2ms on a 16px grid)
     *  - Color-fingerprint cache: only recompute when a sensor changes AQI
     *    color category, not on every minor PM2.5 fluctuation
     *  - Web Worker pre-warms upcoming color transitions ahead of playhead
     *  - Reuses tiny canvas + ImageData across frames
     */
    _ensurePaField(state, playbackTimeMs) {
      const view = this.view;
      const _collectPaFieldSensors = g.FieldSensors._collectPaFieldSensors;
      const _collectVirtualMobileSensors = g.FieldSensors._collectVirtualMobileSensors;
      const _findFingerprintValidRange = g.FieldSensors._findFingerprintValidRange;
      const _MAX_MODE_GROUPS = g.FieldSensors._MAX_MODE_GROUPS;
      const _LEGEND_TAB_AQI_KEY = g.FieldSensors._LEGEND_TAB_AQI_KEY;
      const _LEGEND_TAB_FIELD_SPREAD = g.FieldSensors._LEGEND_TAB_FIELD_SPREAD;
      const _OVERFETCH = g.FieldSensors._OVERFETCH;
      const _OVERFETCH_MAX_DEVICE_PX = g.FieldSensors._OVERFETCH_MAX_DEVICE_PX;
      const latLonToWorld = g.latLonToWorld;
      const worldToLatLon = g.worldToLatLon;
      const valueToAqi = g.valueToAqi;

      const cssW = view._cssW || 1;
      const cssH = view._cssH || 1;
      if (cssW < 2 || cssH < 2) return; // not sized yet

      // During transient animations (gestures, easing), reuse cached PA field.
      // The composite step translates the cached canvas to match the current view.
      // Exception: if margin is exhausted, fall through to recompute centered on new view.
      if (view._isTransientAnimating() && view._paFieldCanvas && !this._paFieldMarginExhausted) return;
      this._paFieldMarginExhausted = false;

      const dpr = view._dpr || (window.devicePixelRatio || 1);
      const z = Number(view.zoom);
      const clat = Number(view.center?.lat);
      const clon = Number(view.center?.lon);
      const fixed = Array.isArray(state && state.fixed) ? state.fixed : [];

      // ── Viewport / reference-time setup (shared between the per-pollutant
      // max scan and the main single-pollutant field compute) ──
      const centerW = latLonToWorld(clat, clon, z);
      // Overfetch: collect sensors and compute the field on a buffer larger than
      // the viewport so gesture pans reveal pre-rendered content at the edges.
      const maxDevPx = _OVERFETCH_MAX_DEVICE_PX;
      const bufW = Math.min(Math.ceil(cssW * _OVERFETCH), Math.floor(maxDevPx / dpr));
      const bufH = Math.min(Math.ceil(cssH * _OVERFETCH), Math.floor(maxDevPx / dpr));

      // Reference time for PA staleness fade: use data "now", NOT the playback
      // scrub position.  last_seen is a live snapshot (not historical), so
      // comparing it against the scrub position causes all PA sensors to vanish
      // once the bar advances 45 min past last_seen.
      const _pbBounds = view.playbackMode ? view.getPlaybackBounds() : null;
      const _boundsMaxMs = (_pbBounds?.maxMs != null && isFinite(_pbBounds.maxMs)) ? _pbBounds.maxMs : null;
      // HISTORICAL snapshots: the data-max can sit far past when PA last reported
      // (other fixed/AirNow data extends later), so judging PA against it marks
      // every PA sensor >45 min stale and drops the entire PM2.5 field — even
      // though the dots still render. Reference the snapshot's own freshest PA
      // report instead, so PA feeds the field the same as other sensors.
      let paRefNowMs;
      if (view._historicalMode) {
        let _maxPaLs = -Infinity;
        for (const f of fixed) {
          if (f && f.purpleair && f.last_seen) {
            const _ms = Number(f.last_seen) * 1000;
            if (isFinite(_ms) && _ms > _maxPaLs) _maxPaLs = _ms;
          }
        }
        paRefNowMs = (_maxPaLs > -Infinity) ? _maxPaLs : (_boundsMaxMs ?? view._dataNowMs());
      } else {
        // LIVE view: PA staleness must be judged against the wall clock — data
        // time (_boundsMaxMs/_dataNowMs) goes stale together with a dead feed,
        // making day-old readings look fresh. Historical playback keeps data time.
        paRefNowMs = Date.now();
      }
      // Virtual mobile sensors measure age against the scrub position so they
      // decay as the user moves the playhead (not pinned to data-max).
      const virtualRefNowMs = (view.playbackMode && playbackTimeMs != null && isFinite(playbackTimeMs))
        ? playbackTimeMs : paRefNowMs;

      // ── Fast skip: if view and data are unchanged and playback time is within
      // the validity window of the current fingerprint, no sensor can have changed
      // color category — skip the expensive _collectPaFieldSensors entirely. ──
      const viewKey = `${cssW}|${cssH}|${z.toFixed(4)}|${clat.toFixed(6)},${clon.toFixed(6)}`;
      const pollutantTab = view._paFieldPollutant || "pm25";
      // No pollutant selected: render the worst pollutant per sensor (max AQI).
      const maxMode = view._paFieldPollutant == null;
      const renderTab = maxMode ? "max" : pollutantTab;
      if (view._paFieldCanvas
          && this._paFieldValidPollutant === renderTab
          && this._paFieldValidViewKey === viewKey
          && this._paFieldValidFixed === fixed
          && view._paFieldValidRange
          && playbackTimeMs >= view._paFieldValidRange.fromMs
          && playbackTimeMs < view._paFieldValidRange.toMs) {
        return;
      }

      const mobiles = Array.isArray(state?.mobile) ? state.mobile : [];
      let allSensors = null;          // single-pollutant: mixed sensor list
      let perPollSensors = null;      // max-mode: [{ tab, sensors }, ...]
      let fingerprint, nSensors, hasVirtuals;

      if (maxMode) {
        // Collect each pollutant's sensor set INDEPENDENTLY. PurpleAir is only
        // included in the pm25 set (non-max collection excludes PA for other
        // tabs), so PA can never bleed into ozone/NO2/etc. — that is the fix.
        perPollSensors = [];
        let fp = "", total = 0, anyVirtual = false;
        for (const grp of _MAX_MODE_GROUPS) {
          const pf = _collectPaFieldSensors(fixed, playbackTimeMs, centerW, z, cssW, cssH, grp.incl, bufW, bufH, paRefNowMs, grp.tabs);
          const vf = _collectVirtualMobileSensors(mobiles, playbackTimeMs, !!view.playbackMode, centerW, z, cssW, cssH, virtualRefNowMs, grp.incl, bufW, bufH, grp.tabs);
          const sensors = pf.sensors.concat(vf.sensors);
          if (vf.sensors.length) anyVirtual = true;
          total += sensors.length;
          fp += grp.incl + ":" + pf.fingerprint + (vf.fingerprint ? "|v" + vf.fingerprint : "") + ";";
          perPollSensors.push({ incl: grp.incl, sensors });
          if (grp.incl === "pm25") view._virtualMobileSensors = vf.sensors; // debug ghost overlay
        }
        fingerprint = fp;
        nSensors = total;
        hasVirtuals = anyVirtual;
      } else {
        const paField = _collectPaFieldSensors(fixed, playbackTimeMs, centerW, z, cssW, cssH, pollutantTab, bufW, bufH, paRefNowMs, maxMode);
        const virtualField = _collectVirtualMobileSensors(
          mobiles, playbackTimeMs, !!view.playbackMode, centerW, z, cssW, cssH, virtualRefNowMs, pollutantTab, bufW, bufH, maxMode
        );
        view._virtualMobileSensors = virtualField.sensors;
        allSensors = paField.sensors.concat(virtualField.sensors);
        fingerprint = paField.fingerprint + (virtualField.fingerprint ? "|v:" + virtualField.fingerprint : "");
        nSensors = allSensors.length;
        hasVirtuals = virtualField.sensors.length > 0;
      }
      if (nSensors === 0) { view._paFieldCanvas = null; view._paFieldCtx = null; return; }

      // ── Cache key: view geometry + color fingerprint + pollutant ──
      const key = `pa:${viewKey}|p:${renderTab}|f:${fingerprint}`;
      if (view._paFieldCanvas && view._paFieldKey === key) {
        // Cache hit -- update validity window so future frames skip
        // _collectPaFieldSensors.  Skip when virtual sensors are present:
        // their ages change every frame so the fast-skip must stay disabled.
        if (!hasVirtuals && !view._paFieldValidRange) {
          view._paFieldValidRange = _findFingerprintValidRange(fixed, playbackTimeMs);
          this._paFieldValidViewKey = viewKey;
          this._paFieldValidFixed = fixed;
          this._paFieldValidPollutant = renderTab;
        }
        return;
      }
      // Only cross-fade when the color fingerprint changes (sensor crosses AQI
      // boundary).  View-only changes (zoom/pan) recompute silently — no fade,
      // no stacking.
      const prevFingerprint = this._paFieldFingerprint || "";
      const fingerprintChanged = fingerprint !== prevFingerprint;
      if (view._paFieldCanvas && fingerprintChanged) {
        this._paFieldPrevCanvas = view._paFieldCanvas;
        view._paFieldCanvas = null;
        view._paFieldCtx = null;
        this._paFieldFadeStart = performance.now();
      } else {
        // View-only change — drop the previous canvas to avoid stale fades
        this._paFieldPrevCanvas = null;
      }
      view._paFieldKey = key;
      this._paFieldFingerprint = fingerprint;

      // ── Grid dimensions (based on overfetch buffer, not viewport) ──
      // Scale cell size with viewport area to keep per-cell density constant.
      const cellSize = Math.max(16, Math.ceil(Math.sqrt(cssW * cssH / 1400)));
      const gw = Math.ceil(bufW / cellSize);
      const gh = Math.ceil(bufH / cellSize);

      // ── Cutoff in screen pixels ──
      const _fd = window._fieldDebug;
      // Cut° scales with zoom: it is a linear function of the visible vertical
      // span (degrees of latitude filling the map height). Two zoom anchors, both
      // "this pair fills the screen vertically":
      //   QHV(41.3028) ↔ QP2(39.5958)            span≈1.707° → cut = ceil knob
      //   Rose Park QRP(40.7955) ↔ Herriman QH3  span≈0.299° → cut = floor knob
      // floor/ceil knobs set the ramp endpoints; delta multiplies the whole ramp.
      const _visTop = worldToLatLon(centerW.x, centerW.y - cssH / 2, z).lat;
      const _visBot = worldToLatLon(centerW.x, centerW.y + cssH / 2, z).lat;
      const _visVDeg = Math.abs(_visTop - _visBot);
      const _VIS_A = 1.707, _VIS_B = 0.299;
      const _delta = _fd.delta != null ? _fd.delta : 1;
      const _f0 = _fd.cutFloor != null ? _fd.cutFloor : 0.3;
      const _c0 = _fd.cutCeil  != null ? _fd.cutCeil  : 0.7;
      const _floor = Math.min(_f0, _c0), _ceil = Math.max(_f0, _c0);
      const _slope = (_ceil - _floor) / (_VIS_A - _VIS_B);
      // Per-pollutant spread (max-mode has no single selected pollutant to key
      // off of, so it keeps the unscaled default — see _LEGEND_TAB_FIELD_SPREAD).
      const _spread = (!maxMode && _LEGEND_TAB_FIELD_SPREAD[pollutantTab]) || { sigmaMult: 1, cutMult: 1 };
      let cutoffDeg = (_floor + _slope * (_visVDeg - _VIS_B)) * _delta;
      cutoffDeg = Math.max(0.02, Math.min(cutoffDeg, _ceil));
      cutoffDeg *= _spread.cutMult;
      const refW = latLonToWorld(clat, clon + cutoffDeg, z);
      const cutoffPx = Math.abs(refW.x - centerW.x);
      const cutoffSq = cutoffPx * cutoffPx;
      const FIELD_ALPHA = _fd.alpha != null ? _fd.alpha : (window._paFieldAlpha ?? 46);
      // Nadaraya-Watson Gaussian kernel bandwidth: σ = cutoff/sigmaDivisor (~2.5km 2σ-radius per sensor).
      const sigmaDivisor = _fd.sigmaDivisor;
      const sigma = (cutoffPx / sigmaDivisor) * _spread.sigmaMult;
      const twoSigmaSq = 2 * sigma * sigma;

      // ── Build stride-5 sensor array(s): [sx, sy, aqi, twoSigSq, weightMultiplier, ...] ──
      // Blend in AQI space: the non-linear concentration→AQI transform gives high
      // concentrations proportionally more weight in the kernel average,
      // so a local spike stays visible instead of being diluted by neighbors.
      const buildS5 = (sensors, aqiKey) => {
        const arr = new Float64Array(sensors.length * 5);
        for (let i = 0; i < sensors.length; i++) {
          const sensor = sensors[i];
          const si5 = i * 5;
          arr[si5] = sensor.sx;
          arr[si5 + 1] = sensor.sy;
          const aqi = (sensor.aqi != null && isFinite(sensor.aqi)) ? sensor.aqi : valueToAqi(aqiKey, sensor.value);
          arr[si5 + 2] = (aqi != null && isFinite(aqi)) ? aqi : 0;
          arr[si5 + 3] = twoSigmaSq;
          arr[si5 + 4] = sensor.weightMultiplier;
        }
        return arr;
      };

      // ── Wind-anisotropic kernel: single wind vector at map center ──
      // Wind field is smooth (~10s of km scale) — uniform across viewport at zoom 11-13.
      // No per-cell grid needed; one sample avoids view-dependent recomputation on pan.
      const wind = view._sampleWindAtCenter(centerW, z, clat, clon, playbackTimeMs, _fd);
      const effectiveCutoffSq = wind ? cutoffSq * wind.stretch * wind.stretch : cutoffSq;

      // ── Always synchronous — kernel regression is fast (<2ms on 16px grid) ──
      if (maxMode) {
        // One stride-5 array per pollutant; composite per-cell max across fields.
        const perPollS5 = perPollSensors.map(pp =>
          buildS5(pp.sensors, _LEGEND_TAB_AQI_KEY[pp.incl] || "pm2.5")
        );
        this._computeMaxModeFieldSync(perPollS5, gw, gh, cellSize, effectiveCutoffSq, cutoffSq, FIELD_ALPHA, bufW, bufH, dpr, wind, cssW, cssH);
      } else {
        const s5 = buildS5(allSensors, _LEGEND_TAB_AQI_KEY[pollutantTab] || "pm2.5");
        // Neighbor-consensus smoothing for regional gases — data-level, not
        // renderer-level (see _LEGEND_TAB_FIELD_SPREAD.neighborBlend). Each
        // station's FIELD input moves toward the distance-weighted mean of
        // the other stations, so one off-cadence or miscalibrated monitor
        // (MTMET updates every few minutes; the DAQ stations hourly) nudges
        // the shared airmass level instead of forming a local zone around
        // itself. Marker labels keep the raw newest reading.
        const _nb = _spread.neighborBlend;
        const nSens = s5.length / 5;
        if (_nb > 0 && nSens >= 3) {
          const blended = new Float64Array(nSens);
          for (let i = 0; i < nSens; i++) {
            const xi = s5[i * 5], yi = s5[i * 5 + 1];
            let wSum = 0, vSum = 0;
            for (let j = 0; j < nSens; j++) {
              if (j === i) continue;
              const dx = s5[j * 5] - xi;
              const dy = s5[j * 5 + 1] - yi;
              const w = s5[j * 5 + 4] * Math.exp(-(dx * dx + dy * dy) / s5[j * 5 + 3]);
              wSum += w;
              vSum += w * s5[j * 5 + 2];
            }
            // Isolated station (no meaningful neighbors in range): keep its
            // own value — there is no consensus to defer to.
            blended[i] = wSum > 0.05
              ? (1 - _nb) * s5[i * 5 + 2] + _nb * (vSum / wSum)
              : s5[i * 5 + 2];
          }
          for (let i = 0; i < nSens; i++) s5[i * 5 + 2] = blended[i];
        }
        this._computePaFieldSync(s5, gw, gh, cellSize, effectiveCutoffSq, cutoffSq, FIELD_ALPHA, bufW, bufH, dpr, wind, cssW, cssH);
      }

      // Stash the inputs needed to lazily compute per-pollutant field maxes
      // when the legend asks. Tying it to this code path inflated CPU by ~5ms
      // per field recompute even when no one was reading the legend colors.
      this._perPollLastInputs = {
        state, playbackTimeMs, centerW, z, cssW, cssH, bufW, bufH,
        paRefNowMs, virtualRefNowMs,
        cellSize, gw, gh, cutoffSq, effectiveCutoffSq, wind, twoSigmaSq,
      };
      // Drop the cached per-pollutant bag so the next legend read recomputes
      // against the new field state (the cache key advances with _paFieldKey).
      this._paFieldMaxAqiPerPollutant = null;
      this._perPollCacheKey = null;

      // Stash the inputs needed to lazily compute per-pollutant field maxes
      // when the legend asks. Tying it to this code path inflated CPU by ~5ms
      // per field recompute even when no one was reading the legend colors.
      this._perPollLastInputs = {
        state, playbackTimeMs, centerW, z, cssW, cssH, bufW, bufH,
        paRefNowMs, virtualRefNowMs,
        cellSize, gw, gh, cutoffSq, effectiveCutoffSq, wind, twoSigmaSq,
      };
      // Drop the cached per-pollutant bag so the next legend read recomputes
      // against the new field state (the cache key advances with _paFieldKey).
      this._paFieldMaxAqiPerPollutant = null;
      this._perPollCacheKey = null;

      // ── Store overfetch buffer dimensions for composite offset ──
      view._paFieldBufW = bufW;
      view._paFieldBufH = bufH;

      // ── Update fingerprint validity window for fast-path skipping ──
      // When virtual sensors are present their ages shift every frame, so the
      // fast-skip must stay disabled (no valid range).
      if (!hasVirtuals) {
        view._paFieldValidRange = _findFingerprintValidRange(fixed, playbackTimeMs);
        this._paFieldValidViewKey = viewKey;
        this._paFieldValidFixed = fixed;
        this._paFieldValidPollutant = renderTab;
      } else {
        view._paFieldValidRange = null;
      }
      // Store view state for gesture-time translate offset
      this._paFieldComputedView = { centerLat: clat, centerLon: clon, zoom: z };
    }

    /**
     * Lazy accessor for per-pollutant field maxes. Returns the memoized bag
     * if it's current with the last main-pass cache key; otherwise runs the
     * kernel regression for each non-rendered pollutant and caches the
     * result. Cheap when nothing changed since the last call (single key
     * comparison). Called from the legend code path only.
     */
    getPerPollutantFieldMax() {
      const view = this.view;
      const inputs = this._perPollLastInputs;
      if (!inputs) return this._paFieldMaxAqiPerPollutant || null;
      const key = view._paFieldKey || "";
      if (this._perPollCacheKey === key && this._paFieldMaxAqiPerPollutant) {
        return this._paFieldMaxAqiPerPollutant;
      }
      // Throttle: this runs 5 full kernel passes. During zoom/scrub the field
      // key churns every few frames — serve the stale bag (legend tint only)
      // rather than recomputing 5 passes per churn.
      {
        const _now = performance.now();
        if (this._paFieldMaxAqiPerPollutant && this._perPollLastComputeMs
            && (_now - this._perPollLastComputeMs) < 2000) {
          return this._paFieldMaxAqiPerPollutant;
        }
        this._perPollLastComputeMs = _now;
      }
      this._computePerPollutantFieldMax(
        inputs.state, inputs.playbackTimeMs, inputs.centerW, inputs.z,
        inputs.cssW, inputs.cssH, inputs.bufW, inputs.bufH,
        inputs.paRefNowMs, inputs.virtualRefNowMs,
        inputs.cellSize, inputs.gw, inputs.gh,
        inputs.cutoffSq, inputs.effectiveCutoffSq, inputs.wind, inputs.twoSigmaSq
      );
      this._perPollCacheKey = key;
      return this._paFieldMaxAqiPerPollutant;
    }

    /**
     * Sample max AQI per pollutant from the kernel-regression numerical field
     * within the viewport — one max per pollutant. The same Nadaraya-Watson
     * formulation as _computePaFieldSync, run for each pollutant's sensor set.
     * No pixels are painted; only the grid maxes are extracted. The rendered
     * pollutant reuses `view._paFieldMaxAqi` already produced by the main pass.
     * Do not call this directly — go through getPerPollutantFieldMax() so the
     * result is cached against the current field key.
     */
    _computePerPollutantFieldMax(state, playbackTimeMs, centerW, z, cssW, cssH, bufW, bufH, paRefNowMs, virtualRefNowMs, cellSize, gw, gh, cutoffSq, effectiveCutoffSq, wind, twoSigmaSq) {
      const view = this.view;
      const _collectPaFieldSensors = g.FieldSensors._collectPaFieldSensors;
      const _collectVirtualMobileSensors = g.FieldSensors._collectVirtualMobileSensors;
      const _LEGEND_TAB_AQI_KEY = g.FieldSensors._LEGEND_TAB_AQI_KEY;
      const valueToAqi = g.valueToAqi;
      const fixed = Array.isArray(state && state.fixed) ? state.fixed : [];
      const mobiles = Array.isArray(state && state.mobile) ? state.mobile : [];
      const result = {};
      const pollutants = ["pm25", "pm10", "o3", "no2", "co"];
      // In max mode the rendered field is the cross-pollutant max — it is NOT
      // a valid stand-in for any single pollutant's max, so no reuse (null
      // matches no tab and every pollutant computes its own pass).
      const renderedTab = view._paFieldPollutant;

      const vpMarginX = (bufW - cssW) / 2;
      const vpMarginY = (bufH - cssH) / 2;
      const vpGxMin = Math.max(0, Math.floor(vpMarginX / cellSize));
      const vpGyMin = Math.max(0, Math.floor(vpMarginY / cellSize));
      const vpGxMax = Math.min(gw, Math.ceil((vpMarginX + cssW) / cellSize));
      const vpGyMax = Math.min(gh, Math.ceil((vpMarginY + cssH) / cellSize));

      const isAniso = wind != null && wind.stretch > 1.001;
      const wwx = isAniso ? wind.wx : 0;
      const wwy = isAniso ? wind.wy : 0;
      const wStretch = isAniso ? wind.stretch : 1;
      const wUpwind = isAniso ? wind.upwindShrink : 1;

      for (const tab of pollutants) {
        if (tab === renderedTab && view._paFieldMaxAqi != null && isFinite(view._paFieldMaxAqi)) {
          result[tab] = view._paFieldMaxAqi;
          continue;
        }

        const paField = _collectPaFieldSensors(
          fixed, playbackTimeMs, centerW, z, cssW, cssH, tab, bufW, bufH, paRefNowMs
        );
        const virtualField = _collectVirtualMobileSensors(
          mobiles, playbackTimeMs, !!view.playbackMode, centerW, z, cssW, cssH,
          virtualRefNowMs, tab, bufW, bufH
        );
        const allSensors = paField.sensors.concat(virtualField.sensors);
        if (allSensors.length === 0) { result[tab] = null; continue; }

        const aqiKey = _LEGEND_TAB_AQI_KEY[tab] || "pm2.5";
        const s5 = new Float64Array(allSensors.length * 5);
        for (let i = 0; i < allSensors.length; i++) {
          const s = allSensors[i];
          const si5 = i * 5;
          s5[si5]     = s.sx;
          s5[si5 + 1] = s.sy;
          const aqi = valueToAqi(aqiKey, s.value);
          s5[si5 + 2] = (aqi != null && isFinite(aqi)) ? aqi : 0;
          s5[si5 + 3] = twoSigmaSq;
          s5[si5 + 4] = s.weightMultiplier;
        }

        let fieldMaxAqi = -Infinity;
        for (let gy = vpGyMin; gy < vpGyMax; gy++) {
          const py = (gy + 0.5) * cellSize;
          for (let gx = vpGxMin; gx < vpGxMax; gx++) {
            const pxx = (gx + 0.5) * cellSize;
            let wSum = 0, vSum = 0;
            for (let i = 0; i < s5.length; i += 5) {
              const dx = pxx - s5[i];
              const dy = py  - s5[i + 1];
              const rawD2 = dx * dx + dy * dy;
              if (rawD2 > effectiveCutoffSq) continue;
              let d2;
              if (isAniso) {
                const along = dx * wwx + dy * wwy;
                if (rawD2 > cutoffSq && along <= 0) continue;
                const cross = dx * (-wwy) + dy * wwx;
                const sf = along > 0 ? wStretch : wStretch * wUpwind;
                const ea = along / sf;
                d2 = ea * ea + cross * cross;
              } else {
                d2 = rawD2;
              }
              const w = s5[i + 4] * Math.exp(-d2 / s5[i + 3]);
              wSum += w;
              vSum += w * s5[i + 2];
            }
            if (wSum >= 0.001) {
              const val = vSum / wSum;
              if (val > fieldMaxAqi) fieldMaxAqi = val;
            }
          }
        }
        result[tab] = (fieldMaxAqi > -Infinity) ? fieldMaxAqi : null;
      }
      this._paFieldMaxAqiPerPollutant = result;
    }

    /** Ensure the coarse grid canvas + reusable per-cell buffers exist for gw×gh. */
    _ensurePaGrid(gw, gh) {
      const view = this.view;
      if (!view._paGrid || view._paGrid.gw !== gw || view._paGrid.gh !== gh) {
        const tc = document.createElement("canvas");
        tc.width = gw; tc.height = gh;
        const tctx = tc.getContext("2d");
        view._paGrid = { tc, tctx, imgData: tctx.createImageData(gw, gh), gw, gh };
      }
      const n = gw * gh;
      const gr = view._paGrid;
      if (!gr.aqiCell || gr.aqiCell.length !== n) {
        gr.aqiCell = new Float32Array(n);
        gr.wCell = new Float32Array(n);
      }
      return gr;
    }

    /** Nadaraya-Watson kernel regression over the whole grid for ONE sensor set.
     *  Fills outAqi[cell] = weighted-mean AQI (0 where uncovered) and
     *  outW[cell] = total kernel weight (used for fade/coverage). Pure numeric —
     *  no pixels. Shared by the single-pollutant and max-mode render paths.
     *  sensors: stride-5 Float64Array [sx, sy, aqi, twoSigSq, weightMultiplier, ...].
     *  cutoffSq: expanded range²; isoCutoffSq: isotropic range²; wind or null. */
    _kernelGrid(sensors, gw, gh, cellSize, cutoffSq, isoCutoffSq, wind, outAqi, outW) {
      const isAniso = wind != null && wind.stretch > 1.001;
      const wwx = isAniso ? wind.wx : 0;
      const wwy = isAniso ? wind.wy : 0;
      const wStretch = isAniso ? wind.stretch : 1;
      const wUpwind  = isAniso ? wind.upwindShrink : 1;
      for (let gy = 0; gy < gh; gy++) {
        const py = (gy + 0.5) * cellSize;
        for (let gx = 0; gx < gw; gx++) {
          const pxx = (gx + 0.5) * cellSize;
          let wSum = 0, vSum = 0;
          for (let i = 0; i < sensors.length; i += 5) {
            const dx = pxx - sensors[i];
            const dy = py  - sensors[i + 1];
            const rawD2 = dx * dx + dy * dy;
            if (rawD2 > cutoffSq) continue;
            let d2;
            if (isAniso) {
              const along = dx * wwx + dy * wwy;
              if (rawD2 > isoCutoffSq && along <= 0) continue;
              const cross = dx * (-wwy) + dy * wwx;
              const sf = along > 0 ? wStretch : wStretch * wUpwind;
              const ea = along / sf;
              d2 = ea * ea + cross * cross;
            } else {
              d2 = rawD2;
            }
            const w = sensors[i + 4] * Math.exp(-d2 / sensors[i + 3]);
            wSum += w;
            vSum += w * sensors[i + 2];
          }
          const cell = gy * gw + gx;
          outW[cell] = wSum;
          outAqi[cell] = wSum >= 0.001 ? vSum / wSum : 0;
        }
      }
    }

    /** Color a per-cell (aqi, weight) grid into the grid canvas, apply the
     *  Cauchy blur, commit, and upscale. Also sets view._paFieldMaxAqi to the
     *  max AQI within the viewport region. Shared painter for both render paths. */
    _paintPaCells(aqiCell, wCell, gw, gh, cellSize, FIELD_ALPHA, dpr, vpCssW, vpCssH, cssW, cssH) {
      const view = this.view;
      const _aqiToRgb = g.FieldSensors._aqiToRgb;
      const { tc, tctx, imgData } = view._paGrid;
      const px = imgData.data;

      let fieldMaxAqi = -Infinity;
      const vpW = vpCssW || cssW;
      const vpH = vpCssH || cssH;
      const vpMarginX = (cssW - vpW) / 2;
      const vpMarginY = (cssH - vpH) / 2;
      const vpGxMin = Math.floor(vpMarginX / cellSize);
      const vpGyMin = Math.floor(vpMarginY / cellSize);
      const vpGxMax = Math.min(gw, Math.ceil((vpMarginX + vpW) / cellSize));
      const vpGyMax = Math.min(gh, Math.ceil((vpMarginY + vpH) / cellSize));

      for (let gy = 0; gy < gh; gy++) {
        const inVpY = gy >= vpGyMin && gy <= vpGyMax;
        for (let gx = 0; gx < gw; gx++) {
          const cell = gy * gw + gx;
          const off = cell * 4;
          const wSum = wCell[cell];
          if (wSum < 0.001) {
            px[off] = 0; px[off+1] = 0; px[off+2] = 0; px[off+3] = 0;
          } else {
            const fade = Math.min(1, wSum * 2);
            const alpha = Math.round(FIELD_ALPHA * fade);
            const val = aqiCell[cell];
            if (inVpY && gx >= vpGxMin && gx < vpGxMax && val > fieldMaxAqi) {
              fieldMaxAqi = val;
            }
            const rgb = _aqiToRgb(val);
            px[off]   = rgb[0];
            px[off+1] = rgb[1];
            px[off+2] = rgb[2];
            px[off+3] = alpha;
          }
        }
      }
      view._paFieldMaxAqi = fieldMaxAqi > -Infinity ? fieldMaxAqi : null;

      // ── Cauchy blur (1/(1+d²) kernel) to soften band-edge staircase artifacts ──
      const _fd = window._fieldDebug;
      const BLUR_R = _fd ? _fd.blur : 2;
      const bufLen = px.length;
      if (!view._paGrid.blurBuf || view._paGrid.blurBuf.length !== bufLen) {
        view._paGrid.blurBuf = new Uint8ClampedArray(bufLen);
      }
      const tmp = view._paGrid.blurBuf;
      tmp.fill(0);
      // Horizontal pass
      for (let y = 0; y < gh; y++) {
        for (let x = 0; x < gw; x++) {
          let rr = 0, gg = 0, bb = 0, aa = 0, ww = 0;
          for (let dx = -BLUR_R; dx <= BLUR_R; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= gw) continue;
            const off = (y * gw + nx) * 4;
            if (px[off + 3] === 0) continue;
            const gk = 1.0 / (1 + dx * dx);
            rr += px[off] * gk; gg += px[off+1] * gk; bb += px[off+2] * gk; aa += px[off+3] * gk;
            ww += gk;
          }
          const off = (y * gw + x) * 4;
          if (ww > 0) { tmp[off] = rr/ww; tmp[off+1] = gg/ww; tmp[off+2] = bb/ww; tmp[off+3] = aa/ww; }
        }
      }
      // Vertical pass
      for (let x = 0; x < gw; x++) {
        for (let y = 0; y < gh; y++) {
          let rr = 0, gg = 0, bb = 0, aa = 0, ww = 0;
          for (let dy = -BLUR_R; dy <= BLUR_R; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= gh) continue;
            const off = (ny * gw + x) * 4;
            if (tmp[off + 3] === 0) continue;
            const gk = 1.0 / (1 + dy * dy);
            rr += tmp[off] * gk; gg += tmp[off+1] * gk; bb += tmp[off+2] * gk; aa += tmp[off+3] * gk;
            ww += gk;
          }
          const off = (y * gw + x) * 4;
          if (ww > 0) { px[off] = rr/ww; px[off+1] = gg/ww; px[off+2] = bb/ww; px[off+3] = aa/ww; }
        }
      }

      tctx.putImageData(imgData, 0, 0);
      this._upscalePaField(tc, cssW, cssH, dpr);
    }

    /** Synchronous Nadaraya-Watson kernel regression with Gaussian weights.
     *  Optionally wind-anisotropic: kernels stretch along wind direction (teardrop shape).
     *  Blends in AQI space so high concentrations retain visual weight.
     *  sensors: stride-5 Float64Array [sx, sy, aqi, twoSigSq, weightMultiplier, ...]
     *  cutoffSq: max range² for early-out (expanded by stretch² when wind active).
     *  isoCutoffSq: original isotropic range² — tight early-out for upwind/crosswind sensors.
     *  wind: { wx, wy, stretch, upwindShrink } or null for isotropic. */
    _computePaFieldSync(sensors, gw, gh, cellSize, cutoffSq, isoCutoffSq, FIELD_ALPHA, cssW, cssH, dpr, wind, vpCssW, vpCssH) {
      const gr = this._ensurePaGrid(gw, gh);
      this._kernelGrid(sensors, gw, gh, cellSize, cutoffSq, isoCutoffSq, wind, gr.aqiCell, gr.wCell);
      this._paintPaCells(gr.aqiCell, gr.wCell, gw, gh, cellSize, FIELD_ALPHA, dpr, vpCssW, vpCssH, cssW, cssH);
    }

    /** Max-mode field: render EACH pollutant's own kernel field independently
     *  (so PurpleAir, which only measures PM2.5, never enters other pollutants'
     *  fields), then composite the PER-CELL MAX AQI across pollutants. This is
     *  the true "worst pollutant wins" surface — a single blended pass over
     *  mixed per-sensor maxes instead averages dense low-PM2.5 PA sensors down
     *  and suppresses a region's high ozone/NO2/etc.
     *  perPollS5: array of stride-5 Float64Arrays, one per pollutant. */
    _computeMaxModeFieldSync(perPollS5, gw, gh, cellSize, cutoffSq, isoCutoffSq, FIELD_ALPHA, cssW, cssH, dpr, wind, vpCssW, vpCssH) {
      const gr = this._ensurePaGrid(gw, gh);
      const n = gw * gh;
      if (!gr.bestAqi || gr.bestAqi.length !== n) {
        gr.bestAqi = new Float32Array(n);
        gr.bestW   = new Float32Array(n);
        gr.tmpAqi  = new Float32Array(n);
        gr.tmpW    = new Float32Array(n);
      }
      gr.bestAqi.fill(0);
      gr.bestW.fill(0);
      for (const s5 of perPollS5) {
        if (!s5 || !s5.length) continue;
        this._kernelGrid(s5, gw, gh, cellSize, cutoffSq, isoCutoffSq, wind, gr.tmpAqi, gr.tmpW);
        for (let c = 0; c < n; c++) {
          // A pollutant claims a cell only where it has coverage AND its AQI is
          // the highest seen there. The winning pollutant's own weight drives
          // fade, so the cell renders exactly as that pollutant's field would.
          if (gr.tmpW[c] >= 0.001 && gr.tmpAqi[c] > gr.bestAqi[c]) {
            gr.bestAqi[c] = gr.tmpAqi[c];
            gr.bestW[c]   = gr.tmpW[c];
          }
        }
      }
      this._paintPaCells(gr.bestAqi, gr.bestW, gw, gh, cellSize, FIELD_ALPHA, dpr, vpCssW, vpCssH, cssW, cssH);
    }

    /** Upscale the coarse interpolation grid to viewport size with bilinear smoothing. */
    _upscalePaField(tc, cssW, cssH, dpr) {
      const view = this.view;
      const _fd = window._fieldDebug;
      const mode = (_fd && _fd.upscaleQuality) || "high";

      if (mode === "2pass") {
        // Store grid-x4 intermediate as _paFieldCanvas (~272x172 instead of ~4320x2700).
        // The composite path does the final upscale to viewport via pfctx.drawImage,
        // so the fast-path blit during zoom operates on a tiny texture.
        const iw = tc.width * 4, ih = tc.height * 4;
        if (!view._paFieldCanvas || view._paFieldCanvas.width !== iw || view._paFieldCanvas.height !== ih) {
          view._paFieldCanvas = document.createElement("canvas");
          view._paFieldCanvas.width = iw;
          view._paFieldCanvas.height = ih;
          view._paFieldCtx = view._paFieldCanvas.getContext("2d");
        }
        const ctx = view._paFieldCtx;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "medium";
        ctx.clearRect(0, 0, iw, ih);
        ctx.drawImage(tc, 0, 0, iw, ih);
        return;
      }

      // Single-pass modes: full device-pixel resolution
      if (!view._paFieldCanvas) {
        view._paFieldCanvas = document.createElement("canvas");
        view._paFieldCtx = view._paFieldCanvas.getContext("2d");
      }
      const pw = Math.floor(cssW * dpr), ph = Math.floor(cssH * dpr);
      if (view._paFieldCanvas.width !== pw || view._paFieldCanvas.height !== ph) {
        view._paFieldCanvas.width = pw;
        view._paFieldCanvas.height = ph;
      }
      const ctx = view._paFieldCtx;
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = mode;
      ctx.drawImage(tc, 0, 0, cssW, cssH);
    }

    /** Handle worker result — cache pre-warmed pixel data for future scrub hits. */
    _onPaWorkerResult(data) {
      const { px, gw, gh, jobId } = data;
      if (jobId !== this._paWorkerJobId) return;
      this._paWorkerPending = false;

      const fp = this._paWorkerFingerprint;
      if (!fp) return;

      // Store the raw pixel data keyed by fingerprint only (view-independent).
      // _ensurePaField will project + upscale synchronously when the fingerprint matches.
      this._paFieldPrewarmed.set(fp, { px: new Uint8ClampedArray(px), gw, gh });
      // Evict oldest if over limit
      if (this._paFieldPrewarmed.size > this._paFieldCacheMax) {
        const first = this._paFieldPrewarmed.keys().next().value;
        this._paFieldPrewarmed.delete(first);
      }
      // Allow _preWarmPaFields to re-scan for more transitions on the next frame.
      this._preWarmScanValidUntilMs = null;
    }

    /**
     * Pre-warm scalar fields for upcoming color transitions.
     * Scans PurpleAir sensor history to find the next times ANY sensor crosses
     * a color category boundary, then dispatches worker jobs to pre-compute
     * those fields. Called periodically from the playback render loop.
     */
    _preWarmPaFields(state, playbackTimeMs) {
      const view = this.view;
      const _collectPaFieldSensors = g.FieldSensors._collectPaFieldSensors;
      const _pm25ColorCat = g.FieldSensors._pm25ColorCat;
      const _pm25ToAqi = g.FieldSensors._pm25ToAqi;
      const _OVERFETCH = g.FieldSensors._OVERFETCH;
      const _OVERFETCH_MAX_DEVICE_PX = g.FieldSensors._OVERFETCH_MAX_DEVICE_PX;
      const latLonToWorld = g.latLonToWorld;
      // Initialize worker on first use
      if (!this._paWorker) {
        try {
          this._paWorker = new Worker("pa_field_worker.js?v=20260322b");
          this._paWorker.onmessage = (e) => this._onPaWorkerResult(e.data);
        } catch (_) {
          this._paWorker = false;
        }
      }
      if (!this._paWorker || this._paWorkerPending) return;
      const fixed = Array.isArray(state && state.fixed) ? state.fixed : [];
      const cssW = view._cssW || 1;
      const cssH = view._cssH || 1;
      if (cssW < 2 || cssH < 2) return;
      const z = Number(view.zoom);
      const clat = Number(view.center?.lat);
      const clon = Number(view.center?.lon);

      // Find sensor color transition times ahead of the playhead (up to 30 min).
      const lookAheadMs = 30 * 60 * 1000;
      const maxTime = playbackTimeMs + lookAheadMs;

      // Skip re-scanning if we already scanned this time window and found nothing
      // new to pre-warm. Only re-scan when playback advances past the horizon or
      // new data arrives (different fixed array).
      if (this._preWarmScanValidUntilMs != null
          && this._preWarmScanFixed === fixed
          && playbackTimeMs < this._preWarmScanValidUntilMs
          && playbackTimeMs >= (this._preWarmScanFromMs || -Infinity)) {
        return;
      }

      // Collect unique transition fingerprints and their sensor arrays
      // Walk forward in time through each sensor's history and find points
      // where the color category changes.
      const transitionTimes = new Set();
      for (const f of fixed) {
        const readings = f && f.readings;
        if (!readings) continue;
        for (const key of Object.keys(readings)) {
          const r = readings[key];
          if (!r || !r._parsedTimeline) continue;
          const { timesMs, valuesF } = r._parsedTimeline;
          if (!timesMs || timesMs.length < 2) continue;
          // Find the current index
          let idx = 0;
          for (let i = 0; i < timesMs.length; i++) {
            if (timesMs[i] <= playbackTimeMs) idx = i; else break;
          }
          const curCat = _pm25ColorCat(valuesF[idx]);
          // Walk forward to find next color change
          for (let i = idx + 1; i < timesMs.length; i++) {
            if (timesMs[i] > maxTime) break;
            if (_pm25ColorCat(valuesF[i]) !== curCat) {
              transitionTimes.add(timesMs[i]);
              break;
            }
          }
        }
      }

      // Pick the nearest transition time not already cached
      const sorted = Array.from(transitionTimes).sort((a, b) => a - b);
      for (const tMs of sorted) {
        // Build sensor array and fingerprint at this time
        const centerW = latLonToWorld(clat, clon, z);
        const dpr = view._dpr || (window.devicePixelRatio || 1);
        const bufW = Math.min(Math.ceil(cssW * _OVERFETCH), Math.floor(_OVERFETCH_MAX_DEVICE_PX / dpr));
        const bufH = Math.min(Math.ceil(cssH * _OVERFETCH), Math.floor(_OVERFETCH_MAX_DEVICE_PX / dpr));
        const paField = _collectPaFieldSensors(fixed, tMs, centerW, z, cssW, cssH, undefined, bufW, bufH, tMs);
        const paSensors = paField.sensors;
        const fp = paField.fingerprint;
        if (paSensors.length === 0) continue;
        if (this._paFieldPrewarmed.has(fp)) continue;

        // Dispatch this one to the worker
        const cellSize = Math.max(16, Math.ceil(Math.sqrt(cssW * cssH / 1400)));
        const gw = Math.ceil(bufW / cellSize);
        const gh = Math.ceil(bufH / cellSize);
        const refW = latLonToWorld(clat, clon + 0.15, z);
        const cutoffPx = Math.abs(refW.x - centerW.x);
        const cutoffSq = cutoffPx * cutoffPx;
        const sigma = cutoffPx / 12;
        const twoSigmaSq = 2 * sigma * sigma;
        const FIELD_ALPHA = 46;

        // Build stride-4 array: [sx, sy, aqi, weightMultiplier, ...]
        const nPw = paSensors.length;
        const s4pw = new Float64Array(nPw * 4);
        for (let i = 0; i < nPw; i++) {
          const sensor = paSensors[i];
          const si = i * 4;
          s4pw[si] = sensor.sx;
          s4pw[si + 1] = sensor.sy;
          s4pw[si + 2] = _pm25ToAqi(Math.min(sensor.value, 75));
          s4pw[si + 3] = sensor.weightMultiplier;
        }

        const jobId = ++this._paWorkerJobId;
        this._paWorkerPending = true;
        this._paWorkerFingerprint = fp;
        this._paWorker.postMessage({
          sensors: s4pw,
          gw, gh, cellSize, cutoffSq, twoSigmaSq, FIELD_ALPHA, jobId
        });
        // Dispatched a job — don't cache scan result yet (more transitions may
        // become uncached after this job completes).
        return; // one at a time
      }

      // All upcoming transitions are already pre-warmed. Cache the scan window
      // so we don't re-scan every frame.
      this._preWarmScanValidUntilMs = maxTime;
      this._preWarmScanFromMs = playbackTimeMs;
      this._preWarmScanFixed = fixed;
    }
  }

  return PaFieldRenderer;
});
