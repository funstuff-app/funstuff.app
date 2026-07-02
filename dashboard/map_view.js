const _isLite = new URLSearchParams(window.location.search).get('lite') === '1';
const _isWindows = /Win/.test(navigator.platform || navigator.userAgent);
const _isMac = /Mac/.test(navigator.platform || navigator.userAgent);
const _isMobileDevice = /iPad|iPhone|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1);

// Wind loading kill switch: no-ops all wind data ingestion (fetch, SSE merge,
// historical snapshot wind) to save load time. Code paths kept intact.
const WIND_LOADING_DISABLED = true;
window.WIND_LOADING_DISABLED = WIND_LOADING_DISABLED;

// FieldSensors (engine_field_sensors.js) owns the PM2.5/AQI color scales,
// legend-tab lookup tables, and PA-field sensor-collection helpers that used
// to live here as top-level functions/consts. Destructure them back into
// file-scope bindings so the 100+ internal call sites below are untouched.
const {
  _pm25ToRgb,
  _pm25ColorCat,
  _BAND_MIDS,
  _PA_FIELD_NON_PURPLEAIR_PROXIMITY_DEG,
  _PA_FIELD_FIXED_WEIGHT_MULTIPLIER,
  _OVERFETCH,
  _OVERFETCH_MAX_DEVICE_PX,
  _OVERFETCH_MARGIN_EXHAUST,
  _LEGEND_TAB_READING_KEYS,
  _LEGEND_TAB_AQI_KEY,
  _MAX_MODE_GROUPS,
  _LEGEND_TAB_LABEL,
  _LEGEND_TAB_TRAIL_KEYS,
  _readingForLegendTab,
  _collectPaFieldSensors,
  _collectVirtualMobileSensors,
  _findFingerprintValidRange,
  _PM25_SMOOTH_STOPS,
  _pm25ToRgbSmooth,
  _PM25_AQI_BP,
  _pm25ToAqi,
  _AQI_RGB_STOPS,
  _aqiColorCat,
  _aqiToRgb,
} = (typeof window !== "undefined" ? window : globalThis).FieldSensors;

class MapView {
  constructor(tilesCanvas, paFieldCanvas, overlayCanvas) {
    this.tilesCanvas = tilesCanvas;
    this.paFieldCanvasEl = paFieldCanvas;
    this.overlayCanvas = overlayCanvas;
    // Use willReadFrequently: false (default) to hint GPU-accelerated rendering.
    // This is especially important for iPad/iOS performance.
    this.tctx = tilesCanvas.getContext("2d", { willReadFrequently: false });
    this.pfctx = paFieldCanvas.getContext("2d", { willReadFrequently: false });
    this.octx = overlayCanvas.getContext("2d", { willReadFrequently: false });

    // fractional zoom for smooth pinch / button zooming
    this.zoom = 12.58; // 50% more zoomed in than the original 12 (log2 scale: +log2(1.5))
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
    // Hover state: show label on mouseover with debounce
    this._hoveredId = null;       // key currently showing hover label
    this._hoverShowTimer = null;  // setTimeout id for show debounce
    this._hoverHideTimer = null;  // setTimeout id for hide debounce
    // Marker visibility toggles
    this.showFixed = true;
    this.showMobile = true;
    // Label visibility is per-sensor-type (mobile vs fixed)
    this.showMobileLabels = false;
    this.showFixedLabels = false;
    // PA field dim: 1.0 = full (PM2.5 selected or legend closed), 0.05 = dimmed (other pollutant)
    this._paFieldDimTarget = 1.0;
    this._paFieldDimCurrent = 1.0;
    this._paFieldDimRAF = null;
    // PA field pollutant: which pollutant the field should display (null = default/highest AQI)
    this._paFieldPollutant = null;
    // Marker pollutant override: only set from explicit legend tab clicks
    this._markerPollutantOverride = null;
    // Trace mode: animate the emoji along its own breadcrumb trail.
    this.traceMode = false;
    this._traceRAF = null;
    this._traceLastFrameTs = 0;
    this._traceTargetFPS = 30; // reduce CPU while staying smooth
    this._backgroundedFPS = 15; // throttle when tab is hidden
    this._backgrounded = document.visibilityState === "hidden";

    this._followRAF = null;
    this._followLastFrameTs = 0;
    this._followSuppressUntilMs = 0;
    this._followTargetLat = null;
    this._followTargetLon = null;

    // Cached viewport metrics to avoid per-frame layout reads (getBoundingClientRect is expensive).
    this._dpr = window.devicePixelRatio || 1;
    this._cssW = 1;
    this._cssH = 1;

    // OS detection for platform-specific input handling (module-level constants)
    this._isWindows = _isWindows;
    this._isMac = _isMac;

    // Trace-mode optimization: cache static overlay (trails + fixed markers).
    this._overlayStaticCanvas = null; // offscreen canvas in device pixels
    this._overlayStaticKey = "";
    this._overlayStaticDirty = true;

    // PurpleAir scalar field underlay: cached offscreen canvas of radial gradient discs.
    this._paFieldCanvas = null;
    this._paFieldCtx = null;
    this._paFieldKey = "";
    // Cross-fade: previous field canvas + transition timing.
    // The fade uses "lighter" (additive) compositing so prev*(1-t) + new*t
    // produces a linear color blend. In cells where prev == new this collapses
    // to a single draw at dimAlpha (no visible effect); in cells that changed
    // you get a smooth color transition with no luminance dip.
    this._paFieldPrevCanvas = null;
    this._paFieldFadeStart = 0;
    this._paFieldFadeMs = 300;
    // Fingerprint validity window: playback time range where no sensor changes
    // color category, so _collectPaFieldSensors can be skipped entirely.
    this._paFieldValidRange = null; // { fromMs, toMs }
    this._paFieldValidViewKey = null;
    this._paFieldValidFixed = null; // reference to fixed array (invalidates on new data)
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
    // View state when PA field was last computed (for gesture translate)
    this._paFieldComputedView = null; // { centerLat, centerLon, zoom }

    // Playback-mode optimization: cache trails to offscreen canvas.
    // Trails only need redrawing when view changes; time advances use incremental updates.
    this._trailCacheCanvas = null;
    this._trailCacheViewKey = "";
    this._trailCacheTimeMs = null;
    this._lastTrailRedrawPerf = 0;

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
    this._playbackSpeed = 5.0;
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
    this._tileCacheMax = _isMobileDevice ? 180 : 420;

    // Touch pan/pinch state (iPad, iOS, Android)
    this._touchState = null; // null or { startTouches, startCenter, startZoom, startCenterLatLon, lastPinchDist, lastMidpoint }
    this._touchActive = false; // true while any touch is in progress (for skipping expensive ops)

    // Debounce tile-load redraws to avoid cascading redraws when multiple tiles load at once
    this._tileLoadRedrawTimer = null;
    // Snapshot of the last rendered basemap frame to avoid flicker while tiles load.
    this._tilesSnapshotCanvas = null; // offscreen canvas
    this._tilesSnapshotMeta = null; // { zoom, centerLat, centerLon }
    this._paFieldComputedView = null; // { zoom, centerLat, centerLon } — for gesture fast-path

    // Theme
    this.themeKey = "carto_dark_all";
    const t = TILE_THEMES[this.themeKey];
    this.tileTemplate = t.template;
    this.tileSubdomains = t.subdomains;
    this._tileEpoch = 1; // increments on theme swap; used to ignore late tile loads

    // Tile drawing/cache/snapshot/redraw-scheduling controller (engine_tile_renderer.js).
    const TileRendererCtor = (typeof window !== "undefined" ? window : globalThis).TileRenderer;
    this.tiles = new TileRendererCtor(this);

    // Road/tram edge fetching, walking, snapping, foveated road matching (engine_road_matcher.js).
    const RoadMatcherCtor = (typeof window !== "undefined" ? window : globalThis).RoadMatcher;
    this.roadMatcher = new RoadMatcherCtor(this);

    // Per-vehicle physics, progressive path smoothing, waypoint windows (engine_vehicle_motion.js).
    const VehicleMotionCtor = (typeof window !== "undefined" ? window : globalThis).VehicleMotion;
    this.vehicleMotion = new VehicleMotionCtor(this);

    // Playback/trace point building & sampling, pose-for-render, playback-marker
    // inertia, scrubbing (engine_playback_engine.js).
    const PlaybackEngineCtor = (typeof window !== "undefined" ? window : globalThis).PlaybackEngine;
    this.playbackEngine = new PlaybackEngineCtor(this);

    // Wind field fetch/merge/interpolation and advection-worker glue (engine_wind_advection.js).
    const WindAdvectionCtor = (typeof window !== "undefined" ? window : globalThis).WindAdvection;
    this.windAdvection = new WindAdvectionCtor(this);

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
    this._lastWheelPanTime = 0; // debounce pan→zoom from trackpad finger-lift artifacts
    this._wheelPanning = false; // true during trackpad/keyboard-trackpad wheel-pan streams
    this._wheelPanEndTimer = null; // debounce timer to exit wheel-pan mode
    this._scrubbing = false; // true during timeline scrub (slider/jog wheel drag)

    // Windows scroll-velocity accumulator for adaptive zoom
    this._winScrollAccum = 0;      // accumulated deltaY in current burst
    this._winScrollLastTs = 0;      // timestamp of last wheel event
    this._winScrollFlushTimer = null;

    // macOS scroll-velocity accumulator for adaptive zoom (mouse wheel only)
    this._macScrollAccum = 0;
    this._macScrollLastTs = 0;

    // ResizeObserver fires after layout settles — catches window resize, devtools
    // show/hide, and fullscreen toggle more reliably than window "resize".
    // Pass contentRect dimensions directly to avoid reading stale clientHeight:
    // -webkit-fill-available (used as a PWA fix on html/body) doesn't reflow
    // reliably in Chrome/Safari when devtools or the browser chrome changes size,
    // so parent.clientHeight can return the old value even after a layout pass.
    this._ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) this.resize(width, height);
      }
    });
    this._ro.observe(this.tilesCanvas.parentElement);

    // Any viewport change: fullscreen, window resize, display switch.
    // Bust the guard so the next resize applies the correct size.
    this._forceResize = () => {
      this._cssW = 0;
      this._cssH = 0;
      const parent = this.tilesCanvas.parentElement;
      if (parent) {
        this._ro.observe(parent);
        const w = parent.clientWidth;
        const h = parent.clientHeight;
        if (w > 0 && h > 0) this.resize(w, h);
      }
    };
    window.addEventListener("resize", () => this._forceResize());
    document.addEventListener("fullscreenchange", () => this._forceResize());
    document.addEventListener("webkitfullscreenchange", () => this._forceResize());
    document.addEventListener("visibilitychange", () => {
      this._backgrounded = document.visibilityState === "hidden";
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", () => this._forceResize());
    }
    // DPR change watcher (display switches).
    this._watchDpr = () => {
      const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      mq.addEventListener("change", () => {
        this._forceResize();
        this._watchDpr();
      }, { once: true });
    };
    this._watchDpr();

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
    if (this._centerAnimRAF) {
      cancelAnimationFrame(this._centerAnimRAF);
      this._centerAnimRAF = null;
    }
    // Pinch-zoom inertia is NOT cancelled here.
  }

  _suppressAutoCamera({ cooldownMs } = {}) {
    const cd = (typeof cooldownMs === "number" && isFinite(cooldownMs)) ? cooldownMs : this._autoCameraCooldownMs;
    const until = performance.now() + Math.max(0, cd);
    if (!(until <= this._autoCameraSuppressedUntilPerfMs)) {
      this._autoCameraSuppressedUntilPerfMs = until;
    }
  }

  // Shorten (never extend) the auto-camera cooldown for high-AQI alerts.
  // Does NOT cancel animations, set _autoCameraCooldownMs, or affect Live mode.
  _overrideCooldownForAlert(cooldownMs) {
    const until = performance.now() + Math.max(0, cooldownMs);
    if (this._autoCameraSuppressedUntilPerfMs > until) {
      this._autoCameraSuppressedUntilPerfMs = until;
    }
  }

  _noteUserInteraction() {
    // User input wins: cancel in-flight camera animations and suppress new auto-fits.
    this._cancelCameraAnimations();
    this._autoCameraCooldownMs = 300000; // 5 minutes after any user interaction
    this._suppressAutoCamera();
    this._followSuppressUntilMs = performance.now() + 4000;
  }

  _isGesturing() {
    return this._touchActive || this._mouseDragging || this._pinchZooming || this._wheelPanning || this._scrubbing;
  }

  /** True during any camera movement: user gestures, inertia, easing, follow, orchestration. */
  _isAnimating() {
    return this._isGesturing() || !!this._centerAnimRAF || !!this._selectOrchRAF || !!this._followRAF;
  }

  /** Like _isAnimating but excludes the persistent follow loop.
   *  Used by PA field to allow recomputation after user gestures while following a vehicle. */
  _isTransientAnimating() {
    return this._isGesturing() || !!this._centerAnimRAF || !!this._selectOrchRAF;
  }

  _canRunAutoCamera() {
    const now = performance.now();
    if (this._touchActive || this._mouseDragging || this._pinchZooming) return false;
    if (this._followRAF) return false; // follow loop is running — it owns the camera
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
  }

  _invalidatePaField() {
    this._paFieldKey = "";
    this._paFieldValidRange = null;
    this._preWarmScanValidUntilMs = null;
    // The cached canvas pixels belong to the prior pollutant/view/state. Every
    // reuse path keys off `_paFieldCanvas` truthiness (animation fast-path
    // line ~6514, the transient-animating early-return in `_ensurePaField`
    // line ~6664, the cross-fade pickup line ~6745). Leaving stale pixels
    // here lets those paths replay the wrong pollutant's heatmap.
    this._paFieldCanvas = null;
    this._paFieldCtx = null;
    this._paFieldPrevCanvas = null;
    this._paFieldComputedView = null;
    this._paFieldValidPollutant = null;
    this._paFieldValidViewKey = null;
    this._paFieldValidFixed = null;
    this._paFieldFingerprint = "";
    // Per-pollutant max bag is populated lazily by getPerPollutantFieldMax()
    // and keyed by _paFieldKey. Clear both so the next legend read recomputes.
    this._paFieldMaxAqi = null;
    this._paFieldMaxAqiPerPollutant = null;
    this._perPollCacheKey = null;
    this._perPollLastInputs = null;
    // `_compositePaFieldOnTiles` dedups itself within a 4 ms window. After an
    // invalidation we want the *next* composite to actually run, even if
    // another RAF chain (playback loop, follow, scrub) composited a moment ago.
    this._compositeLastDrawMs = 0;
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
    if (this._pinchZoomEndTimer) { window.clearTimeout(this._pinchZoomEndTimer); this._pinchZoomEndTimer = null; }
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
      // No coast. Keep _pinchZooming alive briefly so the expensive PA field
      // path doesn't fire in the gap before the next wheel event arrives.
      // If no event arrives within 80ms, then truly end pinch mode.
      if (!this._pinchZoomEndTimer) {
        this._pinchZoomEndTimer = window.setTimeout(() => {
          this._pinchZoomEndTimer = null;
          this._pinchZooming = false;
          this._requestZoomRedraw();
        }, 80);
      }
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
      // Keep tile snapshot alive so drawTiles fast-path (scale + return) fires.
      // The snapshot is recaptured with real tiles once inertia ends.
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

    let tilesRedrawn = false;
    if (this._lastTilesViewSig !== viewSig) {
      this._lastTilesViewSig = viewSig;
      this.drawTiles();
      tilesRedrawn = true;
    }
    // PA scalar field: above tiles, below trails/markers. Composite onto tiles canvas.
    this._compositePaFieldOnTiles(state, tilesRedrawn);
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

    // Dead zone: ignore pinch-zoom attempts where any finger starts in the
    // bottom 130px of the canvas (playback bar area).  Single-finger pans are
    // still allowed so the user can swipe-to-jog on the edge of the bar.
    if (touches.length >= 2) {
      const canvasH = rect.height;
      const deadZonePx = 130;
      for (let i = 0; i < touches.length; i++) {
        const ty = touches[i].clientY - rect.top;
        if (ty > canvasH - deadZonePx) {
          // Finger is in the dead zone — abort pinch-zoom entirely
          this._touchActive = false;
          return;
        }
      }
    }

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
      // Track for tap detection (single touch, minimal movement)
      tapCandidate: touches.length === 1,
      tapStartTime: performance.now(),
      tapStartPos: { x: midX, y: midY },
    };
    
    // Store anchor for inertia
    this._pinchAnchorSX = midX;
    this._pinchAnchorSY = midY;
    
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

    // Pinch-zoom if 2+ fingers.
    // Skip when Safari gesture events are active (_gesture set by onGestureStart) —
    // on iPad both gesture and touch events fire for the same pinch, and the two
    // zoom computations (absolute vs incremental) fight each other.
    if (touches.length >= 2 && !this._gesture) {
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

    // Invalidate tap if moved too far from start (use 25px threshold for iOS finger drift)
    if (this._touchState.tapCandidate && this._touchState.tapStartPos) {
      const tdx = midX - this._touchState.tapStartPos.x;
      const tdy = midY - this._touchState.tapStartPos.y;
      if (Math.abs(tdx) > 25 || Math.abs(tdy) > 25) {
        this._touchState.tapCandidate = false;
      }
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
      // Check for tap gesture before clearing state
      const wasTap = this._touchState.tapCandidate &&
        this._touchState.startTouches === 1 &&
        (performance.now() - this._touchState.tapStartTime) < 300;
      const tapPos = this._touchState.tapStartPos;

      // Mark touch as ended
      this._touchActive = false;
      // Flush any tile redraws that were deferred during touch
      if (this._tileRedrawPending) {
        this._tileRedrawPending = false;
        this._scheduleTileRedraw();
      }
      // All fingers lifted - start inertia if we were pinching.
      // Guard: on iOS Safari, gestureEnd fires before touchEnd for the same
      // pinch release, so _startPinchInertia() may already be running.
      // Starting a second chain corrupts shared state (snapshot, velocity)
      // and causes blown-out PA field alpha.
      if (this._pinchZooming && !this._pinchInertiaRAF) {
        this._startPinchInertia();
      } else if (!this._pinchZooming) {
        // No pinch inertia - do a full redraw now
        this._requestZoomRedraw();
      }

      // Handle tap for marker selection
      if (wasTap && tapPos) {
        this._handleTapSelection(tapPos.x, tapPos.y);
      }

      this._touchState = null;
    } else if (remaining === 1 && this._touchState.startTouches >= 2) {
      // Went from 2+ fingers to 1 - reset pan origin to avoid jump
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
    const t = TILE_THEMES[k] || TILE_THEMES["carto_dark_all"];
    this.themeKey = TILE_THEMES[k] ? k : "carto_dark_all";
    this.tileTemplate = t.template;
    this.tileSubdomains = t.subdomains;
    this._tileEpoch++;
    this.tileCache.clear();
    // snapshot invalid across theme swaps
    this._tilesSnapshotCanvas = null;
    this._tilesSnapshotMeta = null;
    // Force drawTiles() inside draw(): cache/epoch were invalidated, so even if
    // center/zoom/theme-key haven't changed the old tiles are gone and we must
    // start new requests at the current epoch.
    this._lastTilesViewSig = null;
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
    this._stopPinchInertia();
    this._pinchZooming = false;
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
    if (!this._mouseDragging || !this._mouseDragStart || !this._mouseDragCenterStart) {
      // Hover hit-test for mobile/fixed (non-PurpleAir) marker labels
      this._updateHoverAtClientXY(e.clientX, e.clientY);
      return;
    }
    this._noteUserInteraction();
    const dx = e.clientX - this._mouseDragStart.x;
    const dy = e.clientY - this._mouseDragStart.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) this._mouseDragMoved = true;

    const centerX = this._mouseDragCenterStart.x - dx;
    const centerY = clamp(this._mouseDragCenterStart.y - dy, 0, this._mouseDragCenterStart.ws - 1);
    const ll = worldToLatLon(centerX, centerY, this.zoom);
    this.center = { lat: ll.lat, lon: ll.lon };
    // If zoom inertia is running, its RAF already calls draw() which reads this.center —
    // no separate pan redraw needed (avoids two full draws fighting per frame).
    if (!this._pinchInertiaRAF) this._requestPanRedraw();
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
    this._redrawViewOnly();
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

  _animateTo({ centerLat, centerLon, zoom }, { durationMs = 420, isAutoCamera = false } = {}) {
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

    // Track whether this animation is auto-camera so that view-change
    // listeners (e.g. localStorage persistence) can ignore it.
    this._isAutoCameraAnimating = isAutoCamera;

    const zoomChanging = Math.abs(z1 - z0) > 1e-6;

    // Safety: limit animation frames to prevent runaway loops
    let frameCount = 0;
    const maxFrames = Math.ceil(dur / 8) + 60;

    const finish = () => {
      this._centerAnimRAF = null;
      // Keep _isAutoCameraAnimating true through the final draw + notify so that
      // view-change listeners (e.g. localStorage persistence) don't overwrite the
      // user's manually-chosen view with the auto-camera destination.
      this.draw(this.lastState);
      this._notifyViewChanged();
      this._isAutoCameraAnimating = false;
      // After the first auto-camera animation, extend cooldown to 5 minutes
      // so subsequent user interactions suppress auto-camera for much longer.
      if (isAutoCamera) this._autoCameraCooldownMs = 300000;
    };

    const step = () => {
      frameCount++;
      if (frameCount > maxFrames) {
        console.warn('_animateTo: exceeded max frames, forcing completion');
        this.zoom = z1;
        this.center = { lat: lat1, lon: lon1 };
        finish();
        return;
      }

      const t = clamp((performance.now() - t0) / dur, 0, 1);
      // smoothstep ease-in-out: zoom and pan arrive together, no swoop
      const ease = t * t * (3 - 2 * t);
      this.zoom = z0 + (z1 - z0) * ease;
      this.center = { lat: lat0 + (lat1 - lat0) * ease, lon: lon0 + (lon1 - lon0) * ease };
      if (zoomChanging) {
        // Zoom is changing — need full redraw for correct scale
        this.draw(this.lastState);
      } else {
        // Pan-only — use fast snapshot translate path
        this._redrawViewOnly();
      }
      this._notifyViewChanged();
      if (t < 1) {
        this._centerAnimRAF = requestAnimationFrame(step);
      } else {
        finish();
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
    if (!next) this._selectedPollutantKey = null;
    if (!next) this._selectedNaturalPollutantKey = null;
    if (!next) { this._selectedPollutantValue = null; this._selectedReadings = null; }
    this._followSuppressUntilMs = 0;
    this._invalidateOverlayStatic();
    this.drawOverlay(this.lastState);
  }

  /** Returns the pollutant key currently displayed on the selected marker (e.g. "PM25", "PM10", "OZNE"). */
  getSelectedPollutantKey() {
    return this._selectedPollutantKey || null;
  }

  getSelectedNaturalPollutantKey() {
    return this._selectedNaturalPollutantKey || null;
  }

  getSelectedPollutantValue() {
    return this._selectedPollutantValue ?? null;
  }

  /** Readings bag for the selected sensor at the displayed (playback) time. */
  getSelectedReadings() {
    return this._selectedReadings ?? null;
  }

  /** Return lat/lon bounds of the viewport with _OVERFETCH buffer.
   *  Returns { minLat, maxLat, minLon, maxLon } or null if not sized. */
  getBufferedBounds() {
    const w = this._cssW || 0;
    const h = this._cssH || 0;
    if (w < 2 || h < 2) return null;
    const cw = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
    const bw = w * _OVERFETCH / 2;
    const bh = h * _OVERFETCH / 2;
    const tl = worldToLatLon(cw.x - bw, cw.y - bh, this.zoom);
    const br = worldToLatLon(cw.x + bw, cw.y + bh, this.zoom);
    return {
      minLat: Math.min(tl.lat, br.lat),
      maxLat: Math.max(tl.lat, br.lat),
      minLon: Math.min(tl.lon, br.lon),
      maxLon: Math.max(tl.lon, br.lon),
    };
  }

  /** Return lat/lon bounds of the visible viewport (no buffer). */
  getViewportBounds() {
    const w = this._cssW || 0;
    const h = this._cssH || 0;
    if (w < 2 || h < 2) return null;
    const cw = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
    const tl = worldToLatLon(cw.x - w / 2, cw.y - h / 2, this.zoom);
    const br = worldToLatLon(cw.x + w / 2, cw.y + h / 2, this.zoom);
    return {
      minLat: Math.min(tl.lat, br.lat),
      maxLat: Math.max(tl.lat, br.lat),
      minLon: Math.min(tl.lon, br.lon),
      maxLon: Math.max(tl.lon, br.lon),
    };
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
      this._playbackInitialized = false;
    } else {
      this._playbackInitialized = false;  // Will be initialized by playback loop
      // Don't set _playbackNowMs here - let the playback loop handle it with 10-min offset
    }
    this._invalidateOverlayStatic();
    this.drawOverlay(this.lastState);
  }

  setPlaybackPlaying(v) {
    this._playbackPlaying = !!v;
  }

  /** Delegates to PlaybackEngine (engine_playback_engine.js). */
  _playbackMarkNewestSegmentFromBounds(prevMaxMs, nextMaxMs) { return this.playbackEngine._playbackMarkNewestSegmentFromBounds(prevMaxMs, nextMaxMs); }

  /** Delegates to PlaybackEngine (engine_playback_engine.js). */
  isPlaybackAtEnd(epsMs = 100) { return this.playbackEngine.isPlaybackAtEnd(epsMs); }

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

  /** Delegates to PlaybackEngine (engine_playback_engine.js). */
  _closestPlaybackPathPointForMobileAtClientXY(mobile, clientX, clientY) { return this.playbackEngine._closestPlaybackPathPointForMobileAtClientXY(mobile, clientX, clientY); }

  /** Delegates to PlaybackEngine (engine_playback_engine.js). */
  _startPbMarkerInertiaFromDrag(drag) { return this.playbackEngine._startPbMarkerInertiaFromDrag(drag); }

  /** Delegates to PlaybackEngine (engine_playback_engine.js). */
  _hasPbMarkerInertia() { return this.playbackEngine._hasPbMarkerInertia(); }

  /** Delegates to PlaybackEngine (engine_playback_engine.js). */
  _stepPbMarkerInertia(nowMs, dtMs) { return this.playbackEngine._stepPbMarkerInertia(nowMs, dtMs); }

  /** Delegates to PlaybackEngine (engine_playback_engine.js). */
  _scrubPlaybackTimeForMobileAtClientXY(mobile, clientX, clientY) { return this.playbackEngine._scrubPlaybackTimeForMobileAtClientXY(mobile, clientX, clientY); }

  /** Delegates to PlaybackEngine (engine_playback_engine.js). */
  _traceTick() { return this.playbackEngine._traceTick(); }

  /** Delegates to PlaybackEngine (engine_playback_engine.js). */
  _followTick() { return this.playbackEngine._followTick(); }

  /** Delegates to PlaybackEngine (engine_playback_engine.js). */
  _hash01(s) { return this.playbackEngine._hash01(s); }

  /** Delegates to PlaybackEngine (engine_playback_engine.js). */
  _traceSampleForMobile(m, nowMs) { return this.playbackEngine._traceSampleForMobile(m, nowMs); }

  /** Delegates to PlaybackEngine (engine_playback_engine.js). */
  _mobilePoseForRender(m, nowMs) { return this.playbackEngine._mobilePoseForRender(m, nowMs); }

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

  resize(cssW, cssH) {
    const dpr = window.devicePixelRatio || 1;
    const parent = this.tilesCanvas.parentElement;
    // Prefer caller-supplied dimensions (e.g. from ResizeObserver contentRect or
    // visualViewport) over reading clientWidth/clientHeight.  The CSS height chain
    // (html/body use -webkit-fill-available as a PWA fix) can return a stale value
    // in Chrome and Safari when devtools or the browser chrome changes size.
    const w = Math.max(1, cssW != null ? Math.round(cssW) : parent.clientWidth);
    const h = Math.max(1, cssH != null ? Math.round(cssH) : parent.clientHeight);

    // Guard: skip if nothing changed (prevents feedback loops)
    if (w === this._cssW && h === this._cssH && dpr === this._dpr) return;

    this._dpr = dpr;
    this._cssW = w;
    this._cssH = h;

    // Set internal canvas dimensions
    this.tilesCanvas.width = Math.floor(w * dpr);
    this.tilesCanvas.height = Math.floor(h * dpr);
    this.paFieldCanvasEl.width = Math.floor(w * dpr);
    this.paFieldCanvasEl.height = Math.floor(h * dpr);
    this.overlayCanvas.width = Math.floor(w * dpr);
    this.overlayCanvas.height = Math.floor(h * dpr);

    // Set explicit CSS pixel dimensions - critical for iOS PWA standalone mode
    // where percentage-based sizing can be calculated incorrectly
    this.tilesCanvas.style.width = w + 'px';
    this.tilesCanvas.style.height = h + 'px';
    this.paFieldCanvasEl.style.width = w + 'px';
    this.paFieldCanvasEl.style.height = h + 'px';
    this.overlayCanvas.style.width = w + 'px';
    this.overlayCanvas.style.height = h + 'px';

    this.tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.pfctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.octx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Snapshot is tied to canvas size; reset on resize to avoid distortion.
    this._tilesSnapshotCanvas = null;
    this._tilesSnapshotMeta = null;
    this._paFieldCanvas = null;
    this._paFieldCtx = null;
    this._paGrid = null;
    this._invalidateOverlayStatic();
    this._invalidatePaField();
    // Invalidate trail cache on resize
    this._trailCacheCanvas = null;
    this._trailCacheViewKey = "";
    // Force drawTiles() in draw() even if viewSig matches (canvas was cleared above).
    this._lastTilesViewSig = null;

    this.draw(this.lastState);
  }


  onWheel(e) {
    // Platform-aware wheel handling:
    // - Windows: scroll wheel = zoom (no Ctrl needed), trackpad pan = pan
    // - macOS: trackpad pinch (ctrlKey) = zoom, trackpad pan = pan, mouse wheel = zoom
    e.preventDefault();
    this._noteUserInteraction();

    // deltaMode !== 0 means mouse wheel (line or page scrolling mode)
    const isMouseWheel = e.deltaMode !== 0;

    // Smooth-scroll mice (Windows/Linux only): vertical-only with significant delta.
    // Catches mice that report deltaMode=0 (Logitech, Razer, etc).
    // NOT applied on macOS — two-finger vertical trackpad pan is indistinguishable,
    // and macOS convention is scroll=pan, pinch=zoom (like Apple Maps).
    const isSmoothScrollZoom = !e.ctrlKey && Math.abs(e.deltaX) < 1 && Math.abs(e.deltaY) >= 4;

    // macOS mouse wheel: deltaMode is always 0, no ctrlKey. Detect via vertical-only
    // + significant delta. Same heuristic as isSmoothScrollZoom but Mac-specific flag
    // so it gets its own code path and isn't suppressed by the pan→zoom debounce.
    // Exclude if we're already in a trackpad pan stream (_wheelPanning) — a vertical
    // portion of a two-finger swipe must not be hijacked as zoom.
    const isMacMouseWheel = this._isMac && !this._wheelPanning && !e.ctrlKey && Math.abs(e.deltaX) < 1 && Math.abs(e.deltaY) >= 4;

    // Determine if this should be a zoom event:
    // 1. True mouse wheel (deltaMode !== 0) → zoom
    // 2. Ctrl+wheel (trackpad pinch gesture) → zoom
    // 3. Windows/Linux: vertical smooth-scroll (smooth-scroll mice) → zoom
    // 4. macOS mouse wheel (detected via heuristic) → zoom
    let shouldZoom = isMouseWheel || e.ctrlKey || isSmoothScrollZoom || isMacMouseWheel;

    // Debounce pan→zoom transitions: when lifting one finger during a two-finger
    // trackpad pan, macOS briefly interprets the finger separation as a pinch gesture,
    // firing ctrlKey=true wheel events. Ignore these artifacts if we were panning
    // within the last 100ms (a real intentional pinch starts well after pan ends).
    // Do NOT suppress isMacMouseWheel — that's a real mouse wheel, not a finger-lift.
    if (shouldZoom && !isMouseWheel && !isMacMouseWheel && this._lastWheelPanTime
        && (performance.now() - this._lastWheelPanTime) < 100) {
      shouldZoom = false;
    }

    if (shouldZoom) {
      if (this._gesture) return;
      if (this._mouseDragging) return; // Don't zoom while user is panning
      if (this._wheelPanning) return;  // Don't zoom while user is trackpad-panning

      if (this._wheelPinchEndTimer) window.clearTimeout(this._wheelPinchEndTimer);
      if (this._pinchZoomEndTimer) { window.clearTimeout(this._pinchZoomEndTimer); this._pinchZoomEndTimer = null; }
      this._pinchZooming = true;

      const rect = this.overlayCanvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      this._pinchAnchorSX = sx;
      this._pinchAnchorSY = sy;

      const rawDy = clamp(e.deltaY, -300, 300);

      // Platform-specific mouse-wheel flags (separate code paths, not combined)
      const isWinWheel = this._isWindows && (isMouseWheel || isSmoothScrollZoom);

      // Direction: mouse wheel on Win/Mac is reversed; everything else uses raw or inverted convention
      const dy = isWinWheel ? rawDy
              : isMacMouseWheel ? rawDy
              : (isMouseWheel || isSmoothScrollZoom) ? -rawDy : rawDy;
      const dir = dy < 0 ? 1 : -1;

      // Windows mouse-wheel: velocity-adaptive zoom.
      // Accumulate deltas over a short burst window; fast scrolling ramps up
      // non-linearly but is capped so you never blow past the map.
      let dz;
      if (isWinWheel) {
        const now = performance.now();
        const gap = now - this._winScrollLastTs;
        if (gap > 80) this._winScrollAccum = 0;
        this._winScrollAccum += Math.abs(dy);
        this._winScrollLastTs = now;
        const v = this._winScrollAccum;
        dz = dir * Math.min(0.015 * Math.sqrt(v), 0.45);

      // macOS mouse-wheel: same velocity-adaptive zoom, separate accumulator.
      } else if (isMacMouseWheel) {
        const now = performance.now();
        const gap = now - this._macScrollLastTs;
        if (gap > 80) this._macScrollAccum = 0;
        this._macScrollAccum += Math.abs(dy);
        this._macScrollLastTs = now;
        const v = this._macScrollAccum;
        dz = dir * Math.min(0.015 * Math.sqrt(v), 0.45);

      } else {
        // Trackpad pinch (any OS) or Linux mouse wheel — original behavior
        const isChromePinch = e.ctrlKey && !isMouseWheel && /Chrome/.test(navigator.userAgent || "");
        const strength = (isMouseWheel || isSmoothScrollZoom) ? 0.018 : isChromePinch ? 0.055 : 0.020;
        dz = dir * Math.log1p(Math.abs(dy)) * strength;
      }
      const prevZ = this.zoom;
      const z2 = clamp(this.zoom + dz, this._zoomMin, this._zoomMax);
      this._setZoomAroundScreenPoint(z2, sx, sy);
      this._requestZoomRedraw();
      this._notifyViewChanged();
      this._notePinchVelocity(z2 - prevZ, performance.now());

      // Trackpad pinch needs inertia; mouse wheel doesn't
      if (!isMouseWheel && !isSmoothScrollZoom && !isMacMouseWheel) {
        this._wheelPinchEndTimer = window.setTimeout(() => this._startPinchInertia(), 28);
      } else {
        this._wheelPinchEndTimer = window.setTimeout(() => {
          this._pinchZooming = false;
          this._requestZoomRedraw(); // Final redraw with crisp tiles at settled zoom
        }, 150);
      }
      return;
    }

    // Trackpad two-finger pan (deltaMode = 0, no ctrlKey, has horizontal component on macOS)
    // Also covers iPad keyboard trackpad which fires wheel events, not touch events.
    this._lastWheelPanTime = performance.now();
    if (!this._wheelPanning) {
      this._wheelPanning = true;
    }
    if (this._wheelPanEndTimer) window.clearTimeout(this._wheelPanEndTimer);
    this._wheelPanEndTimer = window.setTimeout(() => {
      this._wheelPanning = false;
      this._wheelPanEndTimer = null;
      this._redrawViewOnly();
    }, 120);
    const scale = 0.65;
    const c = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
    const nx = c.x + e.deltaX * scale;
    const ny = clamp(c.y + e.deltaY * scale, 0, c.ws - 1);
    const ll = worldToLatLon(nx, ny, this.zoom);
    this.center = { lat: ll.lat, lon: ll.lon };
    if (!this._pinchInertiaRAF) this._requestPanRedraw();
  }

  _updateHoverAtClientXY(clientX, clientY) {
    const st = this.lastState;
    if (!st) return;
    const rect = this.overlayCanvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    // Only test if cursor is within the canvas bounds
    if (sx < 0 || sy < 0 || sx > rect.width || sy > rect.height) {
      this._scheduleHoverHide();
      return;
    }
    const mobiles = Array.isArray(st.mobile) ? st.mobile : [];
    const fixed = Array.isArray(st.fixed) ? st.fixed : [];

    // Hit-test in reverse render order (same as onClick), but exclude PurpleAir
    let hit = null;
    const selParsed = parseKey(this.selectedId);
    const selMobileId = (selParsed && selParsed.type === "mobile") ? String(selParsed.id) : null;
    const allMobileCands = mobiles.map(m => ({ type: "mobile", ...m }));
    const topMobileCand = selMobileId ? allMobileCands.find(m => String(m.id) === selMobileId) : null;
    const otherMobileCands = selMobileId ? allMobileCands.filter(m => String(m.id) !== selMobileId) : [...allMobileCands];
    const candidates = [
      ...(topMobileCand ? [topMobileCand] : []),
      ...[...otherMobileCands].reverse(),
      ...[...fixed.filter(f => !f.purpleair)].reverse().map(f => ({ type: "fixed", ...f })),
    ];
    for (const m of candidates) {
      let lat = Number(m.lat), lon = Number(m.lon);
      if (m.type === "mobile") {
        const pose = this._mobilePoseForRender(m, performance.now());
        lat = pose.lat;
        lon = pose.lon;
      }
      if (m.type === "fixed" && this._fixedGeoOffsets) {
        const fKey = m._key || keyFor("fixed", m.id);
        const geo = this._fixedGeoOffsets.get(fKey);
        if (geo) { lat += geo.dlat; lon += geo.dlon; }
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

    // Update pointer cursor for marker hover
    this.overlayCanvas.style.cursor = hit ? "pointer" : "";

    // Suppress hover labels while a marker is selected
    if (this.selectedId) {
      this._clearHover();
      return;
    }

    if (hit) {
      // Clear hide timer if re-entering same or new marker
      if (this._hoverHideTimer) { clearTimeout(this._hoverHideTimer); this._hoverHideTimer = null; }
      if (this._hoveredId === hit) return; // already showing this one
      // Clear previous show timer
      if (this._hoverShowTimer) { clearTimeout(this._hoverShowTimer); this._hoverShowTimer = null; }
      this._hoverShowTimer = setTimeout(() => {
        this._hoverShowTimer = null;
        this._hoveredId = hit;
        this._invalidateOverlayStatic();
        this.drawOverlay(this.lastState);
      }, 333);
    } else {
      // Not over any marker — schedule hide
      if (this._hoverShowTimer) { clearTimeout(this._hoverShowTimer); this._hoverShowTimer = null; }
      this._scheduleHoverHide();
    }
  }

  _scheduleHoverHide() {
    if (!this._hoveredId) return;
    if (this._hoverHideTimer) return; // already scheduled
    this._hoverHideTimer = setTimeout(() => {
      this._hoverHideTimer = null;
      this._hoveredId = null;
      this._invalidateOverlayStatic();
      this.drawOverlay(this.lastState);
    }, 333);
  }

  _clearHover() {
    if (this._hoverShowTimer) { clearTimeout(this._hoverShowTimer); this._hoverShowTimer = null; }
    if (this._hoverHideTimer) { clearTimeout(this._hoverHideTimer); this._hoverHideTimer = null; }
    if (this._hoveredId) {
      this._hoveredId = null;
      this._invalidateOverlayStatic();
      this.drawOverlay(this.lastState);
    }
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
    // Search in reverse render order so the topmost (last-drawn) marker wins.
    // Render order (bottom→top): PurpleAir fixed → other fixed → non-selected mobiles → selected mobile.
    // Hit-test order is the exact reverse.
    let hit = null;
    const selParsed = parseKey(this.selectedId);
    const selMobileId = (selParsed && selParsed.type === "mobile") ? String(selParsed.id) : null;
    const allMobileCands = mobiles.map(m => ({ type: "mobile", ...m }));
    const topMobileCand = selMobileId ? allMobileCands.find(m => String(m.id) === selMobileId) : null;
    const otherMobileCands = selMobileId ? allMobileCands.filter(m => String(m.id) !== selMobileId) : [...allMobileCands];
    const candidates = [
      ...(topMobileCand ? [topMobileCand] : []),
      ...[...otherMobileCands].reverse(),
      ...[...fixed.filter(f => !f.purpleair)].reverse().map(f => ({ type: "fixed", ...f })),
      ...(this._paFieldPollutant == null || this._paFieldPollutant === "pm25" ? [...fixed.filter(f => f.purpleair)].reverse().map(f => ({ type: "fixed", ...f })) : []),
    ];
    const _clickRefMs = this._historicalMode ? (this.getPlaybackTimeMs() || this._dataNowMs()) : Date.now();
    const _PA_FADE_MS = 45 * 60 * 1000;
    for (const m of candidates) {
      // Skip fully-faded PurpleAir sensors
      if (m.purpleair) {
        const sMs = m.last_seen ? m.last_seen * 1000 : null;
        if (!sMs || (_clickRefMs - sMs) >= _PA_FADE_MS) continue;
      }
      let lat = Number(m.lat), lon = Number(m.lon);
      if (m.type === "mobile") {
        const pose = this._mobilePoseForRender(m, performance.now());
        lat = pose.lat;
        lon = pose.lon;
      }
      if (m.type === "fixed" && this._fixedGeoOffsets) {
        const fKey = m._key || keyFor("fixed", m.id);
        const geo = this._fixedGeoOffsets.get(fKey);
        if (geo) { lat += geo.dlat; lon += geo.dlon; }
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

  _handleTapSelection(sx, sy) {
    // Handle tap on touch devices - same hit testing as onClick
    const st = this.lastState;
    const mobiles = st && Array.isArray(st.mobile) ? st.mobile : [];
    const fixed = st && Array.isArray(st.fixed) ? st.fixed : [];

    // Search in reverse render order so the topmost (last-drawn) marker wins.
    // Render order (bottom→top): PurpleAir fixed → other fixed → non-selected mobiles → selected mobile.
    let hit = null;
    const tapSelParsed = parseKey(this.selectedId);
    const tapSelMobileId = (tapSelParsed && tapSelParsed.type === "mobile") ? String(tapSelParsed.id) : null;
    const tapAllMobileCands = mobiles.map(m => ({ type: "mobile", ...m }));
    const tapTopMobileCand = tapSelMobileId ? tapAllMobileCands.find(m => String(m.id) === tapSelMobileId) : null;
    const tapOtherMobileCands = tapSelMobileId ? tapAllMobileCands.filter(m => String(m.id) !== tapSelMobileId) : [...tapAllMobileCands];
    const candidates = [
      ...(tapTopMobileCand ? [tapTopMobileCand] : []),
      ...[...tapOtherMobileCands].reverse(),
      ...[...fixed.filter(f => !f.purpleair)].reverse().map(f => ({ type: "fixed", ...f })),
      ...(this._paFieldPollutant == null || this._paFieldPollutant === "pm25" ? [...fixed.filter(f => f.purpleair)].reverse().map(f => ({ type: "fixed", ...f })) : []),
    ];
    const _tapRefMs = this._historicalMode ? (this.getPlaybackTimeMs() || this._dataNowMs()) : Date.now();
    const _TAP_PA_FADE_MS = 45 * 60 * 1000;
    for (const m of candidates) {
      // Skip fully-faded PurpleAir sensors
      if (m.purpleair) {
        const sMs = m.last_seen ? m.last_seen * 1000 : null;
        if (!sMs || (_tapRefMs - sMs) >= _TAP_PA_FADE_MS) continue;
      }
      let lat = Number(m.lat), lon = Number(m.lon);
      if (m.type === "mobile") {
        const pose = this._mobilePoseForRender(m, performance.now());
        lat = pose.lat;
        lon = pose.lon;
      }
      if (m.type === "fixed" && this._fixedGeoOffsets) {
        const fKey = m._key || keyFor("fixed", m.id);
        const geo = this._fixedGeoOffsets.get(fKey);
        if (geo) { lat += geo.dlat; lon += geo.dlon; }
      }
      if (!isFinite(lat) || !isFinite(lon)) continue;
      const wpt = latLonToWorld(lat, lon, this.zoom);
      const sp = this.worldToScreen(wpt.x, wpt.y);
      const dx = sp.x - sx;
      const dy = sp.y - sy;
      if ((dx*dx + dy*dy) <= (35*35)) { // Large hit area for iOS touch accuracy
        hit = keyFor(m.type, m.id);
        break;
      }
    }
    if (hit) {
      if (window.__selectSensor) window.__selectSensor(hit, { fitTrail: false });
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

    // Fast path: skip overlay/composite work when no data has arrived yet.
    // Tile prefetch is preserved so it overlaps with the config/data fetch.
    if (!state && !this.lastState) {
      this.drawTiles();
      return;
    }

    // Soft-follow: keep target fresh and ensure the loop is running.
    {
      const _fp = this.selectedId ? parseKey(this.selectedId) : null;
      if (_fp && _fp.type === 'mobile') {
        const _mob = Array.isArray(state?.mobile) ? state.mobile : [];
        const _fm = _mob.find(v => String(v.id) === String(_fp.id));
        if (_fm) {
          const _pose = this.playbackMode ? this._mobilePoseForRender(_fm, performance.now()) : null;
          const _tlat = _pose ? Number(_pose.lat) : Number(_fm.lat);
          const _tlon = _pose ? Number(_pose.lon) : Number(_fm.lon);
          if (isFinite(_tlat) && isFinite(_tlon)) {
            this._followTargetLat = _tlat;
            this._followTargetLon = _tlon;
          }
        }
        if (!this._followRAF) this._followRAF = requestAnimationFrame(() => this._followTick());
      } else {
        this._followTargetLat = null;
        this._followTargetLon = null;
        if (this._followRAF) { cancelAnimationFrame(this._followRAF); this._followRAF = null; }
      }
    }

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
      // Only fetch tram track edges when debug path overlay is active (debug-only visualizer)
      if (hasTrx && this._pbDebugPath) this._fetchTramLineEdgesForViewport();
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

    let tilesRedrawn = false;
    if (this._lastTilesViewSig !== viewSig) {
      this._lastTilesViewSig = viewSig;
      this.drawTiles();
      tilesRedrawn = true;
    }
    this._compositePaFieldOnTiles(state, tilesRedrawn);
    this.drawOverlay(state, { cacheUnderlay: true });
  }

  /** Clear all per-vehicle caches. Called when switching snapshots to prevent
   *  stale data from prior loads accumulating in memory. */
  clearVehicleCaches() {
    this._tracePtsById = new Map();
    this._tracePtsKey = "";
    this._traceLastSideById = new Map();
    this._traceActiveRouteById = new Map();
    this._tracePendingRouteById = new Map();
    this._traceCycleStartMsById = new Map();
    this._traceInitialRunDoneById = new Map();
    this._traceAngleById = new Map();
    this._traceAngleLastMsById = new Map();
    this._traceSelectionWarpById = new Map();
    this._physicsStateById = new Map();
    this._roadMatchedRangesById = new Map();
    this._roadMatchPending = new Set();
    this._vehicleActualPathById = new Map();
    this._smoothPathCache = new Map();
    this._pathDistCache = new Map();
    this._vehiclePhysicsCache = new Map();
    this._vehiclePathById = new Map();
    this._curveLookaheadCache = new Map();
    this._screenHeadingCache = new Map();
    this._vehicleRevealDist = new Map();
    this._scrubCooldownById = new Map();
    this._trailCacheCanvas = null;
    this._trailCacheViewKey = "";
    this._trailCacheTimeMs = null;
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
    // Playback physics / path caches (added later, were previously missed)
    removedAny = pruneMap(this._vehiclePathById) || removedAny;
    removedAny = pruneMap(this._smoothPathCache) || removedAny;
    removedAny = pruneMap(this._pathDistCache) || removedAny;
    removedAny = pruneMap(this._vehiclePhysicsCache) || removedAny;
    removedAny = pruneMap(this._curveLookaheadCache) || removedAny;
    removedAny = pruneMap(this._screenHeadingCache) || removedAny;
    removedAny = pruneMap(this._vehicleRevealDist) || removedAny;
    removedAny = pruneMap(this._roadMatchedRangesById) || removedAny;
    removedAny = pruneMap(this._scrubCooldownById) || removedAny;
    removedAny = pruneMap(this._physicsStateById) || removedAny;
    removedAny = pruneMap(this._vehicleActualPathById) || removedAny;
    removedAny = pruneMap(this._traceSelectionWarpById) || removedAny;

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

      const nextColor = safeHex(m.ci);
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

  /** Delegates to TileRenderer (engine_tile_renderer.js). */
  drawTiles() { this.tiles.drawTiles(); }

  /** Delegates to TileRenderer (engine_tile_renderer.js). */
  _captureTilesSnapshot() { this.tiles._captureTilesSnapshot(); }

  /** Delegates to TileRenderer (engine_tile_renderer.js). */
  _tileCacheGet(key) { return this.tiles._tileCacheGet(key); }

  /** Delegates to TileRenderer (engine_tile_renderer.js). */
  _tileCacheSet(key, value) { return this.tiles._tileCacheSet(key, value); }

  /** Delegates to TileRenderer (engine_tile_renderer.js). */
  drawTile(ctx, key, z, x, y, px, py, scale, hasSnapshot) {
    return this.tiles.drawTile(ctx, key, z, x, y, px, py, scale, hasSnapshot);
  }

  /** Delegates to TileRenderer (engine_tile_renderer.js). */
  _scheduleTileRedraw() { this.tiles._scheduleTileRedraw(); }

  /** Delegates to PlaybackEngine (engine_playback_engine.js). */
  _tracePointsKeyForState(state) { return this.playbackEngine._tracePointsKeyForState(state); }

  /** Delegates to PlaybackEngine (engine_playback_engine.js). */
  _playbackPointsKeyForState(state) { return this.playbackEngine._playbackPointsKeyForState(state); }

  /** Delegates to PlaybackEngine (engine_playback_engine.js). */
  _ensurePlaybackPoints(state) { return this.playbackEngine._ensurePlaybackPoints(state); }

  // ─────────────────────────────────────────────────────────────────────────────
  // Road/tram edge fetching, walking, snapping, and foveated road matching.
  // Delegates to RoadMatcher (engine_road_matcher.js).
  // ─────────────────────────────────────────────────────────────────────────────

  /** Delegates to RoadMatcher (engine_road_matcher.js). */
  async _fetchRoadEdgesForViewport() { return this.roadMatcher._fetchRoadEdgesForViewport(); }

  /** Delegates to RoadMatcher (engine_road_matcher.js). */
  _walkBetweenServerEdges(t0, t1, edges, toScreen) { return this.roadMatcher._walkBetweenServerEdges(t0, t1, edges, toScreen); }

  /** Delegates to RoadMatcher (engine_road_matcher.js). */
  _snapToTrackEdge(lat, lon, edges) { return this.roadMatcher._snapToTrackEdge(lat, lon, edges); }

  /** Delegates to RoadMatcher (engine_road_matcher.js). */
  _walkTrackPath(lat1, lon1, lat2, lon2, edges, toScreen) { return this.roadMatcher._walkTrackPath(lat1, lon1, lat2, lon2, edges, toScreen); }

  /** Delegates to RoadMatcher (engine_road_matcher.js). */
  async _fetchTramLineEdgesForViewport() { return this.roadMatcher._fetchTramLineEdgesForViewport(); }

  /** Delegates to RoadMatcher (engine_road_matcher.js). */
  async _doFetchTramLineEdges(minLat, maxLat, minLon, maxLon, key) { return this.roadMatcher._doFetchTramLineEdges(minLat, maxLat, minLon, maxLon, key); }

  /** Delegates to RoadMatcher (engine_road_matcher.js). */
  _isRangeMatched(sensorId, fromMs, toMs) { return this.roadMatcher._isRangeMatched(sensorId, fromMs, toMs); }

  /** Delegates to RoadMatcher (engine_road_matcher.js). */
  _markRangeMatched(sensorId, fromMs, toMs) { return this.roadMatcher._markRangeMatched(sensorId, fromMs, toMs); }

  /** Delegates to RoadMatcher (engine_road_matcher.js). */
  async _requestFoveatedRoadMatching() { return this.roadMatcher._requestFoveatedRoadMatching(); }

  /** Delegates to RoadMatcher (engine_road_matcher.js). */
  async _fetchAndApplyRoadMatch(sensorId, trailSegment, fromMs, toMs) { return this.roadMatcher._fetchAndApplyRoadMatch(sensorId, trailSegment, fromMs, toMs); }


  // ─────────────────────────────────────────────────────────────────────────────
  // AUTONOMOUS AGENT PHYSICS, progressive spline path, sliding-window waypoint
  // steering. Delegates to VehicleMotion (engine_vehicle_motion.js).
  // ─────────────────────────────────────────────────────────────────────────────

  // Physics constants (matching unit tests in vehicle_physics.test.cjs)
  static CRUISE_SPEED = 25;           // m/s on straights (~56 mph)
  static CURVE_SPEED = 8;             // m/s in tight curves (~18 mph)
  static ACCEL_RATE = 4;              // m/s² acceleration
  static BRAKE_RATE = 6;              // m/s² braking (stronger than accel)
  static CURVATURE_LOOKAHEAD = 100;   // meters to scan ahead for curves
  static TRAIL_LOOKAHEAD_BASE = 80;   // base meters ahead of targetD for trail reveal
  static CURVATURE_THRESHOLD = 0.01;  // rad/m where we start slowing
  static STOP_BUFFER = 10;            // meters before visible end to start stopping
  static PHYSICS_VARIATION = 0.15;    // ±15% variation in physics params per vehicle

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
  static MAX_CAMERA_FIT_SEGMENT_LENGTH_M = 5000; // cap per-vehicle segment to ~5km

  /** Delegates to VehicleMotion (engine_vehicle_motion.js). */
  _hashId(id) { return this.vehicleMotion._hashId(id); }

  /** Delegates to VehicleMotion (engine_vehicle_motion.js). */
  _getVehiclePhysics(id) { return this.vehicleMotion._getVehiclePhysics(id); }

  /** Delegates to VehicleMotion (engine_vehicle_motion.js). */
  _getPhysicsState(id) { return this.vehicleMotion._getPhysicsState(id); }

  /** Delegates to VehicleMotion (engine_vehicle_motion.js). */
  _resetPhysicsState(id) { return this.vehicleMotion._resetPhysicsState(id); }

  /** Delegates to VehicleMotion (engine_vehicle_motion.js). */
  _getVehiclePath(id, pts) { return this.vehicleMotion._getVehiclePath(id, pts); }

  /** Delegates to VehicleMotion (engine_vehicle_motion.js). */
  _extendVehiclePath(id, pts, targetRawIdx, playbackSpeed, vehicleRawIdx) { return this.vehicleMotion._extendVehiclePath(id, pts, targetRawIdx, playbackSpeed, vehicleRawIdx); }

  /** Delegates to VehicleMotion (engine_vehicle_motion.js). */
  _getWaypointWindow(id, pts, vehicleIdx, playbackSpeed) { return this.vehicleMotion._getWaypointWindow(id, pts, vehicleIdx, playbackSpeed); }

  /** Delegates to VehicleMotion (engine_vehicle_motion.js). */
  _getSmoothPath(id, pts) { return this.vehicleMotion._getSmoothPath(id, pts); }

  /** Delegates to VehicleMotion (engine_vehicle_motion.js). */
  _getPathDistances(id, pts) { return this.vehicleMotion._getPathDistances(id, pts); }

  /** Delegates to VehicleMotion (engine_vehicle_motion.js). */
  _catmullRom(pts, p0Idx, p1Idx, p2Idx, p3Idx, t) { return this.vehicleMotion._catmullRom(pts, p0Idx, p1Idx, p2Idx, p3Idx, t); }

  /** Delegates to VehicleMotion (engine_vehicle_motion.js). */
  _samplePathAtDistance(pts, cumDist, curvature, d) { return this.vehicleMotion._samplePathAtDistance(pts, cumDist, curvature, d); }

  /** Delegates to VehicleMotion (engine_vehicle_motion.js). */
  _getTargetDistance(pts, cumDist, totalDist, t) { return this.vehicleMotion._getTargetDistance(pts, cumDist, totalDist, t); }

  /** Delegates to PlaybackEngine (engine_playback_engine.js). */
  _playbackSampleForMobile(m, nowPerfMs) { return this.playbackEngine._playbackSampleForMobile(m, nowPerfMs); }

  /** Delegates to PlaybackEngine (engine_playback_engine.js). */
  _ensureTracePoints(state) { return this.playbackEngine._ensureTracePoints(state); }

  // ─────────────────────────────────────────────────────────────────────────────
  // Wind field fetch/merge/interpolation and advection-worker glue.
  // Delegates to WindAdvection (engine_wind_advection.js).
  // ─────────────────────────────────────────────────────────────────────────────

  /** Delegates to WindAdvection (engine_wind_advection.js). */
  _collectGeoSensors(state, playbackTimeMs) { return this.windAdvection._collectGeoSensors(state, playbackTimeMs); }

  /** Delegates to WindAdvection (engine_wind_advection.js). */
  _geoSensorFingerprint(sensors) { return this.windAdvection._geoSensorFingerprint(sensors); }

  /** Delegates to WindAdvection (engine_wind_advection.js). */
  mergeWindSnapshot(key, points) { return this.windAdvection.mergeWindSnapshot(key, points); }

  /** Delegates to WindAdvection (engine_wind_advection.js). */
  _fetchWindField() { return this.windAdvection._fetchWindField(); }

  /** Delegates to WindAdvection (engine_wind_advection.js). */
  _interpolateWindFields(fieldA, fieldB, alpha) { return this.windAdvection._interpolateWindFields(fieldA, fieldB, alpha); }

  /** Delegates to WindAdvection (engine_wind_advection.js). */
  _windFieldForTime(epochMs, doInterpolate = false) { return this.windAdvection._windFieldForTime(epochMs, doInterpolate); }

  /** Delegates to WindAdvection (engine_wind_advection.js). */
  _initAdvectionWorker(sensors, fieldAlpha) { return this.windAdvection._initAdvectionWorker(sensors, fieldAlpha); }

  /** Delegates to WindAdvection (engine_wind_advection.js). */
  _onAdvectionFrame(data) { return this.windAdvection._onAdvectionFrame(data); }

  /** Delegates to WindAdvection (engine_wind_advection.js). */
  _projectAdvectionToScreen() { return this.windAdvection._projectAdvectionToScreen(); }

  /** Delegates to WindAdvection (engine_wind_advection.js). */
  _tickAdvection(state, playbackTimeMs) { return this.windAdvection._tickAdvection(state, playbackTimeMs); }

  /**
   * Switch PA field to a different pollutant. Invalidates field cache and redraws.
   * @param {string} tab - Legend tab id: "pm25", "pm10", "o3", "no2", "co"
   */
  setPaFieldPollutant(tab) {
    const prev = this._paFieldPollutant;
    this._paFieldPollutant = tab || null;
    if (prev !== this._paFieldPollutant) {
      this._invalidateOverlayStatic();
      this._invalidatePaField();
      // Invalidate trail canvas cache so trails redraw with new pollutant colors
      this._trailCacheViewKey = "";
      this._trailCacheCanvas = null;
      this._redrawViewOnly();
    }
  }

  /** Synchronously look up the selected sensor's reading for a specific pollutant tab.
   *  Returns the numeric value or null. Does NOT require a render cycle. */
  getReadingForPollutant(tab) {
    if (!this.selectedId || !this.lastState || !tab) return null;
    const parsed = parseKey(this.selectedId);
    if (!parsed) return null;
    const list = (parsed.type === "mobile")
      ? (this.lastState.mobile || [])
      : (this.lastState.fixed || []);
    const sensor = list.find(s => s && String(s.id) === String(parsed.id));
    if (!sensor) return null;
    const pr = _readingForLegendTab(sensor.readings, tab);
    return (pr && pr.value != null) ? parseFloat(pr.value) : null;
  }

  /** Set marker pollutant override (only from explicit legend tab clicks). */
  setMarkerPollutantOverride(tab) {
    const prev = this._markerPollutantOverride;
    this._markerPollutantOverride = tab || null;
    if (prev !== this._markerPollutantOverride) {
      this._invalidateOverlayStatic();
      if (this.lastState) this.drawOverlay(this.lastState);
    }
  }

  /**
   * Animate PA field dim alpha toward target. Called from app.js when legend tab changes.
   * @param {number} target - 1.0 for full, 0.05 for dimmed
   */
  setPaFieldDim(target) {
    this._paFieldDimTarget = target;
    if (this._paFieldDimRAF) return; // animation already running
    const animate = () => {
      const diff = this._paFieldDimTarget - this._paFieldDimCurrent;
      if (Math.abs(diff) < 0.01) {
        this._paFieldDimCurrent = this._paFieldDimTarget;
        this._paFieldDimRAF = null;
        this._redrawViewOnly();
        return;
      }
      // Ease toward target (~200ms settle)
      this._paFieldDimCurrent += diff * 0.15;
      this._redrawViewOnly();
      this._paFieldDimRAF = requestAnimationFrame(animate);
    };
    this._paFieldDimRAF = requestAnimationFrame(animate);
  }

  /**
   * Composite the PA scalar field onto the tiles canvas (above tiles, below overlay).
   * Restores tiles from snapshot first to avoid opacity accumulation on repeated calls.
   */
  _compositePaFieldOnTiles(state, tilesJustRedrawn = false) {
    // Per-frame deduplication: skip if already composited this frame.
    {
      const _now = performance.now();
      if (!tilesJustRedrawn && this._compositeLastDrawMs && (_now - this._compositeLastDrawMs) < 4) return;
      this._compositeLastDrawMs = _now;
    }
    const pbMs = this.playbackMode ? this.getPlaybackTimeMs() : null;

    // Fetch wind field in background for debug vector overlay (does not affect PA field rendering)
    if (!_isLite) this._fetchWindField();

    // ── PERF PROBE ──
    {
      if (!this._perfProbe) this._perfProbe = { fastPath: 0, slowPath: 0, lastReport: 0, ensureMs: 0, ensureCalls: 0 };
      const _pp = this._perfProbe;
      const _now2 = performance.now();
      if (_now2 - _pp.lastReport > 2000) {
        if (_pp.fastPath + _pp.slowPath > 0) {
          // console.log(`[PA-PROBE] fast:${_pp.fastPath} slow:${_pp.slowPath} ensureAvg:${_pp.ensureCalls ? (_pp.ensureMs/_pp.ensureCalls).toFixed(1) : '-'}ms gesturing:${this._isGesturing()} transient:${this._isTransientAnimating()} scrub:${!!this._scrubbing} pinch:${this._pinchZooming} drag:${this._mouseDragging}`);
        }
        _pp.fastPath = 0; _pp.slowPath = 0; _pp.ensureMs = 0; _pp.ensureCalls = 0; _pp.lastReport = _now2;
      }
    }

    // ── Animation fast-path: transform existing PA field canvas instead of recomputing ──
    if (this._isTransientAnimating() && this._paFieldCanvas && this._paFieldComputedView) {
      if (this._perfProbe) this._perfProbe.fastPath++;
      const ctx = this.pfctx;
      if (!ctx) return;
      const pw = this.paFieldCanvasEl.width;
      const ph = this.paFieldCanvasEl.height;
      const dpr = this._dpr || (window.devicePixelRatio || 1);
      const cssW = this._cssW || 1;
      const cssH = this._cssH || 1;
      const prev = this._paFieldComputedView;
      const bufW = this._paFieldBufW || cssW;
      const bufH = this._paFieldBufH || cssH;
      const offX = (bufW - cssW) / 2;
      const offY = (bufH - cssH) / 2;

      // Margin exhaustion: if pan delta exceeds the overfetch margin, fall through
      // to the static path which will recompute the field centered on current view.
      const prevC = latLonToWorld(prev.centerLat, prev.centerLon, prev.zoom);
      const currC = latLonToWorld(this.center.lat, this.center.lon, prev.zoom);
      const absTx = Math.abs(prevC.x - currC.x);
      const absTy = Math.abs(prevC.y - currC.y);
      if (absTx >= offX * _OVERFETCH_MARGIN_EXHAUST || absTy >= offY * _OVERFETCH_MARGIN_EXHAUST) {
        // Force _ensurePaField to recompute despite animating
        this._paFieldMarginExhausted = true;
      } else {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, pw, ph);
        const sZoom = Math.pow(2, this.zoom - prev.zoom);
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
        ctx.drawImage(this._paFieldCanvas, -offX, -offY, bufW, bufH);
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
    const ctx = this.pfctx;
    if (!ctx) return;
    const pw = this.paFieldCanvasEl.width;
    const ph = this.paFieldCanvasEl.height;
    // Clear the dedicated PA field canvas every frame (no snapshot restore needed)
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pw, ph);
    if (!this._paFieldCanvas) { ctx.restore(); return; }

    // Overfetch offset: the field canvas is larger than the viewport.
    // Draw it shifted so the viewport windows over the center portion.
    // Use 9-param drawImage so source canvas can be any resolution (2pass = small).
    const _dpr = this._dpr || (window.devicePixelRatio || 1);
    const _cssW = this._cssW || 1;
    const _cssH = this._cssH || 1;
    const _bw = this._paFieldBufW || _cssW;
    const _bh = this._paFieldBufH || _cssH;
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
      _drawPaCanvas(this._paFieldCanvas, fadeT * dimAlpha);
      ctx.globalCompositeOperation = prevOp;
      ctx.globalAlpha = 1;
      // Schedule another frame to complete the fade (no-op if playback loop is running)
      if (!this._paFieldFadeRAF) {
        this._paFieldFadeRAF = requestAnimationFrame(() => {
          this._paFieldFadeRAF = null;
          this._compositePaFieldOnTiles(this.lastState);
          this.drawOverlay(this.lastState, { cacheUnderlay: true });
        });
      }
    } else {
      if (this._paFieldPrevCanvas) this._paFieldPrevCanvas = null;
      _drawPaCanvas(this._paFieldCanvas, dimAlpha);
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
    const cssW = this._cssW || 1;
    const cssH = this._cssH || 1;
    if (cssW < 2 || cssH < 2) return; // not sized yet

    // During transient animations (gestures, easing), reuse cached PA field.
    // The composite step translates the cached canvas to match the current view.
    // Exception: if margin is exhausted, fall through to recompute centered on new view.
    if (this._isTransientAnimating() && this._paFieldCanvas && !this._paFieldMarginExhausted) return;
    this._paFieldMarginExhausted = false;

    const dpr = this._dpr || (window.devicePixelRatio || 1);
    const z = Number(this.zoom);
    const clat = Number(this.center?.lat);
    const clon = Number(this.center?.lon);
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
    const _pbBounds = this.playbackMode ? this.getPlaybackBounds() : null;
    const _boundsMaxMs = (_pbBounds?.maxMs != null && isFinite(_pbBounds.maxMs)) ? _pbBounds.maxMs : null;
    // HISTORICAL snapshots: the data-max can sit far past when PA last reported
    // (other fixed/AirNow data extends later), so judging PA against it marks
    // every PA sensor >45 min stale and drops the entire PM2.5 field — even
    // though the dots still render. Reference the snapshot's own freshest PA
    // report instead, so PA feeds the field the same as other sensors.
    let paRefNowMs;
    if (this._historicalMode) {
      let _maxPaLs = -Infinity;
      for (const f of fixed) {
        if (f && f.purpleair && f.last_seen) {
          const _ms = Number(f.last_seen) * 1000;
          if (isFinite(_ms) && _ms > _maxPaLs) _maxPaLs = _ms;
        }
      }
      paRefNowMs = (_maxPaLs > -Infinity) ? _maxPaLs : (_boundsMaxMs ?? this._dataNowMs());
    } else {
      // LIVE view: PA staleness must be judged against the wall clock — data
      // time (_boundsMaxMs/_dataNowMs) goes stale together with a dead feed,
      // making day-old readings look fresh. Historical playback keeps data time.
      paRefNowMs = Date.now();
    }
    // Virtual mobile sensors measure age against the scrub position so they
    // decay as the user moves the playhead (not pinned to data-max).
    const virtualRefNowMs = (this.playbackMode && playbackTimeMs != null && isFinite(playbackTimeMs))
      ? playbackTimeMs : paRefNowMs;

    // ── Fast skip: if view and data are unchanged and playback time is within
    // the validity window of the current fingerprint, no sensor can have changed
    // color category — skip the expensive _collectPaFieldSensors entirely. ──
    const viewKey = `${cssW}|${cssH}|${z.toFixed(4)}|${clat.toFixed(6)},${clon.toFixed(6)}`;
    const pollutantTab = this._paFieldPollutant || "pm25";
    // No pollutant selected: render the worst pollutant per sensor (max AQI).
    const maxMode = this._paFieldPollutant == null;
    const renderTab = maxMode ? "max" : pollutantTab;
    if (this._paFieldCanvas
        && this._paFieldValidPollutant === renderTab
        && this._paFieldValidViewKey === viewKey
        && this._paFieldValidFixed === fixed
        && this._paFieldValidRange
        && playbackTimeMs >= this._paFieldValidRange.fromMs
        && playbackTimeMs < this._paFieldValidRange.toMs) {
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
        const vf = _collectVirtualMobileSensors(mobiles, playbackTimeMs, !!this.playbackMode, centerW, z, cssW, cssH, virtualRefNowMs, grp.incl, bufW, bufH, grp.tabs);
        const sensors = pf.sensors.concat(vf.sensors);
        if (vf.sensors.length) anyVirtual = true;
        total += sensors.length;
        fp += grp.incl + ":" + pf.fingerprint + (vf.fingerprint ? "|v" + vf.fingerprint : "") + ";";
        perPollSensors.push({ incl: grp.incl, sensors });
        if (grp.incl === "pm25") this._virtualMobileSensors = vf.sensors; // debug ghost overlay
      }
      fingerprint = fp;
      nSensors = total;
      hasVirtuals = anyVirtual;
    } else {
      const paField = _collectPaFieldSensors(fixed, playbackTimeMs, centerW, z, cssW, cssH, pollutantTab, bufW, bufH, paRefNowMs, maxMode);
      const virtualField = _collectVirtualMobileSensors(
        mobiles, playbackTimeMs, !!this.playbackMode, centerW, z, cssW, cssH, virtualRefNowMs, pollutantTab, bufW, bufH, maxMode
      );
      this._virtualMobileSensors = virtualField.sensors;
      allSensors = paField.sensors.concat(virtualField.sensors);
      fingerprint = paField.fingerprint + (virtualField.fingerprint ? "|v:" + virtualField.fingerprint : "");
      nSensors = allSensors.length;
      hasVirtuals = virtualField.sensors.length > 0;
    }
    if (nSensors === 0) { this._paFieldCanvas = null; this._paFieldCtx = null; return; }

    // ── Cache key: view geometry + color fingerprint + pollutant ──
    const key = `pa:${viewKey}|p:${renderTab}|f:${fingerprint}`;
    if (this._paFieldCanvas && this._paFieldKey === key) {
      // Cache hit -- update validity window so future frames skip
      // _collectPaFieldSensors.  Skip when virtual sensors are present:
      // their ages change every frame so the fast-skip must stay disabled.
      if (!hasVirtuals && !this._paFieldValidRange) {
        this._paFieldValidRange = _findFingerprintValidRange(fixed, playbackTimeMs);
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
    if (this._paFieldCanvas && fingerprintChanged) {
      this._paFieldPrevCanvas = this._paFieldCanvas;
      this._paFieldCanvas = null;
      this._paFieldCtx = null;
      this._paFieldFadeStart = performance.now();
    } else {
      // View-only change — drop the previous canvas to avoid stale fades
      this._paFieldPrevCanvas = null;
    }
    this._paFieldKey = key;
    this._paFieldFingerprint = fingerprint;

    // ── Grid dimensions (based on overfetch buffer, not viewport) ──
    // Scale cell size with viewport area to keep per-cell density constant.
    const cellSize = Math.max(16, Math.ceil(Math.sqrt(cssW * cssH / 1400)));
    const gw = Math.ceil(bufW / cellSize);
    const gh = Math.ceil(bufH / cellSize);

    // ── Cutoff in screen pixels ──
    const _fd = window._fieldDebug;
    const cutoffDeg = _fd.cutoffDeg;
    const refW = latLonToWorld(clat, clon + cutoffDeg, z);
    const cutoffPx = Math.abs(refW.x - centerW.x);
    const cutoffSq = cutoffPx * cutoffPx;
    const FIELD_ALPHA = _fd.alpha != null ? _fd.alpha : (window._paFieldAlpha ?? 46);
    // Nadaraya-Watson Gaussian kernel bandwidth: σ = cutoff/sigmaDivisor (~2.5km 2σ-radius per sensor).
    const sigmaDivisor = _fd.sigmaDivisor;
    const sigma = cutoffPx / sigmaDivisor;
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
    const wind = this._sampleWindAtCenter(centerW, z, clat, clon, playbackTimeMs, _fd);
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
    this._paFieldBufW = bufW;
    this._paFieldBufH = bufH;

    // ── Update fingerprint validity window for fast-path skipping ──
    // When virtual sensors are present their ages shift every frame, so the
    // fast-skip must stay disabled (no valid range).
    if (!hasVirtuals) {
      this._paFieldValidRange = _findFingerprintValidRange(fixed, playbackTimeMs);
      this._paFieldValidViewKey = viewKey;
      this._paFieldValidFixed = fixed;
      this._paFieldValidPollutant = renderTab;
    } else {
      this._paFieldValidRange = null;
    }
    // Store view state for gesture-time translate offset
    this._paFieldComputedView = { centerLat: clat, centerLon: clon, zoom: z };
  }

  /** Delegates to WindAdvection (engine_wind_advection.js). */
  _sampleWindAtCenter(centerW, z, clat, clon, playbackTimeMs, _fd) {
    return this.windAdvection._sampleWindAtCenter(centerW, z, clat, clon, playbackTimeMs, _fd);
  }

  /**
   * Lazy accessor for per-pollutant field maxes. Returns the memoized bag
   * if it's current with the last main-pass cache key; otherwise runs the
   * kernel regression for each non-rendered pollutant and caches the
   * result. Cheap when nothing changed since the last call (single key
   * comparison). Called from the legend code path only.
   */
  getPerPollutantFieldMax() {
    const inputs = this._perPollLastInputs;
    if (!inputs) return this._paFieldMaxAqiPerPollutant || null;
    const key = this._paFieldKey || "";
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
   * pollutant reuses `this._paFieldMaxAqi` already produced by the main pass.
   * Do not call this directly — go through getPerPollutantFieldMax() so the
   * result is cached against the current field key.
   */
  _computePerPollutantFieldMax(state, playbackTimeMs, centerW, z, cssW, cssH, bufW, bufH, paRefNowMs, virtualRefNowMs, cellSize, gw, gh, cutoffSq, effectiveCutoffSq, wind, twoSigmaSq) {
    const fixed = Array.isArray(state && state.fixed) ? state.fixed : [];
    const mobiles = Array.isArray(state && state.mobile) ? state.mobile : [];
    const result = {};
    const pollutants = ["pm25", "pm10", "o3", "no2", "co"];
    // In max mode the rendered field is the cross-pollutant max — it is NOT
    // a valid stand-in for any single pollutant's max, so no reuse (null
    // matches no tab and every pollutant computes its own pass).
    const renderedTab = this._paFieldPollutant;

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
      if (tab === renderedTab && this._paFieldMaxAqi != null && isFinite(this._paFieldMaxAqi)) {
        result[tab] = this._paFieldMaxAqi;
        continue;
      }

      const paField = _collectPaFieldSensors(
        fixed, playbackTimeMs, centerW, z, cssW, cssH, tab, bufW, bufH, paRefNowMs
      );
      const virtualField = _collectVirtualMobileSensors(
        mobiles, playbackTimeMs, !!this.playbackMode, centerW, z, cssW, cssH,
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

  /** Synchronous Nadaraya-Watson kernel regression with Gaussian weights.
   *  Optionally wind-anisotropic: kernels stretch along wind direction (teardrop shape).
   *  Blends in AQI space so high concentrations retain visual weight.
   *  sensors: stride-5 Float64Array [sx, sy, aqi, twoSigSq, weightMultiplier, ...]
   *  cutoffSq: max range² for early-out (expanded by stretch² when wind active).
   *  isoCutoffSq: original isotropic range² — tight early-out for upwind/crosswind sensors.
   *  wind: { wx, wy, stretch, upwindShrink } or null for isotropic. */
  /** Ensure the coarse grid canvas + reusable per-cell buffers exist for gw×gh. */
  _ensurePaGrid(gw, gh) {
    if (!this._paGrid || this._paGrid.gw !== gw || this._paGrid.gh !== gh) {
      const tc = document.createElement("canvas");
      tc.width = gw; tc.height = gh;
      const tctx = tc.getContext("2d");
      this._paGrid = { tc, tctx, imgData: tctx.createImageData(gw, gh), gw, gh };
    }
    const n = gw * gh;
    const g = this._paGrid;
    if (!g.aqiCell || g.aqiCell.length !== n) {
      g.aqiCell = new Float32Array(n);
      g.wCell = new Float32Array(n);
    }
    return g;
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
   *  Cauchy blur, commit, and upscale. Also sets this._paFieldMaxAqi to the
   *  max AQI within the viewport region. Shared painter for both render paths. */
  _paintPaCells(aqiCell, wCell, gw, gh, cellSize, FIELD_ALPHA, dpr, vpCssW, vpCssH, cssW, cssH) {
    const { tc, tctx, imgData } = this._paGrid;
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
    this._paFieldMaxAqi = fieldMaxAqi > -Infinity ? fieldMaxAqi : null;

    // ── Cauchy blur (1/(1+d²) kernel) to soften band-edge staircase artifacts ──
    const _fd = window._fieldDebug;
    const BLUR_R = _fd ? _fd.blur : 2;
    const bufLen = px.length;
    if (!this._paGrid.blurBuf || this._paGrid.blurBuf.length !== bufLen) {
      this._paGrid.blurBuf = new Uint8ClampedArray(bufLen);
    }
    const tmp = this._paGrid.blurBuf;
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
          const g = 1.0 / (1 + dx * dx);
          rr += px[off] * g; gg += px[off+1] * g; bb += px[off+2] * g; aa += px[off+3] * g;
          ww += g;
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
          const g = 1.0 / (1 + dy * dy);
          rr += tmp[off] * g; gg += tmp[off+1] * g; bb += tmp[off+2] * g; aa += tmp[off+3] * g;
          ww += g;
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
    const g = this._ensurePaGrid(gw, gh);
    this._kernelGrid(sensors, gw, gh, cellSize, cutoffSq, isoCutoffSq, wind, g.aqiCell, g.wCell);
    this._paintPaCells(g.aqiCell, g.wCell, gw, gh, cellSize, FIELD_ALPHA, dpr, vpCssW, vpCssH, cssW, cssH);
  }

  /** Max-mode field: render EACH pollutant's own kernel field independently
   *  (so PurpleAir, which only measures PM2.5, never enters other pollutants'
   *  fields), then composite the PER-CELL MAX AQI across pollutants. This is
   *  the true "worst pollutant wins" surface — a single blended pass over
   *  mixed per-sensor maxes instead averages dense low-PM2.5 PA sensors down
   *  and suppresses a region's high ozone/NO2/etc.
   *  perPollS5: array of stride-5 Float64Arrays, one per pollutant. */
  _computeMaxModeFieldSync(perPollS5, gw, gh, cellSize, cutoffSq, isoCutoffSq, FIELD_ALPHA, cssW, cssH, dpr, wind, vpCssW, vpCssH) {
    const g = this._ensurePaGrid(gw, gh);
    const n = gw * gh;
    if (!g.bestAqi || g.bestAqi.length !== n) {
      g.bestAqi = new Float32Array(n);
      g.bestW   = new Float32Array(n);
      g.tmpAqi  = new Float32Array(n);
      g.tmpW    = new Float32Array(n);
    }
    g.bestAqi.fill(0);
    g.bestW.fill(0);
    for (const s5 of perPollS5) {
      if (!s5 || !s5.length) continue;
      this._kernelGrid(s5, gw, gh, cellSize, cutoffSq, isoCutoffSq, wind, g.tmpAqi, g.tmpW);
      for (let c = 0; c < n; c++) {
        // A pollutant claims a cell only where it has coverage AND its AQI is
        // the highest seen there. The winning pollutant's own weight drives
        // fade, so the cell renders exactly as that pollutant's field would.
        if (g.tmpW[c] >= 0.001 && g.tmpAqi[c] > g.bestAqi[c]) {
          g.bestAqi[c] = g.tmpAqi[c];
          g.bestW[c]   = g.tmpW[c];
        }
      }
    }
    this._paintPaCells(g.bestAqi, g.bestW, gw, gh, cellSize, FIELD_ALPHA, dpr, vpCssW, vpCssH, cssW, cssH);
  }

  /** Upscale the coarse interpolation grid to viewport size with bilinear smoothing. */
  _upscalePaField(tc, cssW, cssH, dpr) {
    const _fd = window._fieldDebug;
    const mode = (_fd && _fd.upscaleQuality) || "high";

    if (mode === "2pass") {
      // Store grid-x4 intermediate as _paFieldCanvas (~272x172 instead of ~4320x2700).
      // The composite path does the final upscale to viewport via pfctx.drawImage,
      // so the fast-path blit during zoom operates on a tiny texture.
      const iw = tc.width * 4, ih = tc.height * 4;
      if (!this._paFieldCanvas || this._paFieldCanvas.width !== iw || this._paFieldCanvas.height !== ih) {
        this._paFieldCanvas = document.createElement("canvas");
        this._paFieldCanvas.width = iw;
        this._paFieldCanvas.height = ih;
        this._paFieldCtx = this._paFieldCanvas.getContext("2d");
      }
      const ctx = this._paFieldCtx;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "medium";
      ctx.clearRect(0, 0, iw, ih);
      ctx.drawImage(tc, 0, 0, iw, ih);
      return;
    }

    // Single-pass modes: full device-pixel resolution
    if (!this._paFieldCanvas) {
      this._paFieldCanvas = document.createElement("canvas");
      this._paFieldCtx = this._paFieldCanvas.getContext("2d");
    }
    const pw = Math.floor(cssW * dpr), ph = Math.floor(cssH * dpr);
    if (this._paFieldCanvas.width !== pw || this._paFieldCanvas.height !== ph) {
      this._paFieldCanvas.width = pw;
      this._paFieldCanvas.height = ph;
    }
    const ctx = this._paFieldCtx;
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
    const cssW = this._cssW || 1;
    const cssH = this._cssH || 1;
    if (cssW < 2 || cssH < 2) return;
    const z = Number(this.zoom);
    const clat = Number(this.center?.lat);
    const clon = Number(this.center?.lon);

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
      const dpr = this._dpr || (window.devicePixelRatio || 1);
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
    const fl = this.showFixedLabels ? 1 : 0;
    // Include playback time (rounded to 1s) so fixed sensor dots update when scrubbing
    const pbT = this.getPlaybackTimeMs();
    const pbKey = (pbT != null && isFinite(pbT)) ? Math.round(pbT / 1000) : "live";
    return `${revKey}|${persistKey}|w:${w}|h:${h}|z:${z.toFixed(4)}|c:${clat.toFixed(6)},${clon.toFixed(6)}|sel:${sel}|fixed:${fixed}|fl:${fl}|pb:${pbKey}`;
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

    // Skip trail points before the visible window.  Renderers fade out points
    // older than 45 minutes — no need to iterate hours of invisible data.
    // Uses cached _tMs (available after first frame); falls back to i=0 otherwise.
    let startIdx = 0;
    if (shouldClipTrail && trail.length > 50) {
      const windowStartMs = revealTimeMs - 50 * 60 * 1000; // 45-min fade + 5-min margin
      const first = trail[0];
      if (first && first._tMs !== undefined) {
        let lo = 0, hi = trail.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          const t = trail[mid]._tMs;
          if (t != null && t < windowStartMs) lo = mid + 1; else hi = mid;
        }
        startIdx = Math.max(0, lo - 1); // -1 for segment continuity
      }
    }

    for (let i = startIdx; i < trail.length; i++) {
      const p = trail[i];

      // Cache properties in consistent order: _tMs → _u/_v → _cachedColor
      // This MUST match the order in _collectVirtualMobileSensors to avoid
      // V8 hidden class divergence (different insertion orders → different
      // hidden classes → megamorphic inline caches → progressive slowdown).

      // 1. Timestamp first (matches _collectVirtualMobileSensors)
      let tMs = p._tMs;
      if (tMs === undefined) {
        tMs = (p && typeof p.t === "string") ? parseUtcMs(p.t) : null;
        try { p._tMs = tMs; } catch {}
      }

      // 2. World coords second (matches _collectVirtualMobileSensors)
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

      // 3. Color last — pollutant-aware: use selected pollutant when explicitly chosen
      const pollTab = this._paFieldPollutant;
      const usePollutantColor = pollTab != null;
      let base;
      if (usePollutantColor) {
        // Per-pollutant color cache: _cachedColorByTab = { pm10: "#hex", o3: "#hex", ... }
        const cbt = p._cachedColorByTab;
        base = cbt && cbt[pollTab];
        if (base === undefined) {
          const rKeys = _LEGEND_TAB_READING_KEYS[pollTab];
          let found = null;
          if (rKeys && p.readings) {
            for (const rk of rKeys) {
              const r = p.readings[rk];
              if (r && r.value != null) { found = r; break; }
            }
          }
          if (found) {
            if (pollTab !== "pm25") {
              // Non-PM2.5: use the same AQI continuous ramp as the field so trail dots
              // match the heatmap color (server discrete palette uses pollutant-specific
              // sub-band greens that diverge from the AQI ramp in the Good range).
              const _tAqiKey = _LEGEND_TAB_AQI_KEY[pollTab] || "pm2.5";
              const _tAqi = valueToAqi(_tAqiKey, found.value);
              if (_tAqi != null && isFinite(_tAqi)) {
                const [_tr, _tg, _tb] = _aqiToRgb(_tAqi);
                base = '#' + ((1 << 24) + (_tr << 16) + (_tg << 8) + _tb).toString(16).slice(1);
              } else {
                base = safeHex(found.ci != null ? found.ci : found.color);
              }
            } else {
              base = safeHex(found.ci != null ? found.ci : found.color);
            }
          } else {
            base = "#333333";
          }
          try {
            if (!p._cachedColorByTab) p._cachedColorByTab = {};
            p._cachedColorByTab[pollTab] = base;
          } catch {}
        }
      } else {
        base = p._cachedColor;
        if (base === undefined) {
          const pr = primaryReadingFromPoint(p);
          base = safeHex(pr?.ci != null ? pr.ci : pr?.color);
          try { p._cachedColor = base; } catch {}
        }
      }
      
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

    // Fixed markers - render PurpleAir first (so they don't draw over others), then other markers
    if (this.showFixed) {
      // Declutter: nudge co-located non-PurpleAir fixed markers apart.
      // Offsets are in lat/lon so the bearing is geographic and zoom-independent.
      this._fixedGeoOffsets = new Map();
      {
        const nudgeDeg = 0.0003; // ~33m — enough to separate at high zoom, subtle at low zoom
        const colocThresh = 0.002; // ~200m
        const ents = [];
        for (const f of fixed) {
          if (f.purpleair) continue;
          const lat = Number(f.lat), lon = Number(f.lon);
          if (!isFinite(lat) || !isFinite(lon)) continue;
          if (!f._key) f._key = keyFor("fixed", f.id);
          ents.push({ f, lat, lon, dlat: 0, dlon: 0 });
        }
        for (let i = 0; i < ents.length; i++) {
          for (let j = i + 1; j < ents.length; j++) {
            const a = ents[i], b = ents[j];
            if (Math.abs(a.lat - b.lat) + Math.abs(a.lon - b.lon) < colocThresh) {
              // Bearing from a→b in geographic coords; default NE when coincident
              const dl = b.lat - a.lat, dn = b.lon - a.lon;
              const ang = (Math.abs(dl) + Math.abs(dn) > 1e-7)
                ? Math.atan2(dn, dl)
                : Math.PI / 4; // 45° NE default
              a.dlat -= Math.cos(ang) * nudgeDeg;
              a.dlon -= Math.sin(ang) * nudgeDeg;
              b.dlat += Math.cos(ang) * nudgeDeg;
              b.dlon += Math.sin(ang) * nudgeDeg;
            }
          }
        }
        for (const e of ents) {
          if (e.dlat || e.dlon) this._fixedGeoOffsets.set(e.f._key, { dlat: e.dlat, dlon: e.dlon });
        }
      }

      // Helper to render a single fixed marker
      const renderFixedMarker = (f) => {
        let lat = Number(f.lat), lon = Number(f.lon);
        if (!isFinite(lat) || !isFinite(lon)) return;
        if (!f._key) f._key = keyFor("fixed", f.id);
        const geo = this._fixedGeoOffsets && this._fixedGeoOffsets.get(f._key);
        if (geo) { lat += geo.dlat; lon += geo.dlon; }
        const wpt = latLonToWorld(lat, lon, this.zoom);
        const sp = worldToScreenFast(wpt.x, wpt.y);
        if (sp.x < -50 || sp.y < -50 || sp.x > cssW + 50 || sp.y > cssH + 50) return;

        if (!f._key) f._key = keyFor("fixed", f.id);
        const keyF = f._key;
        const isSel = (this.selectedId === keyF);
        const emoji = f.purpleair ? "" : (f.emoji || "📍");
        const color = safeHex(f.ci);
        const pr = primaryReadingForFixedAtTime(f, this.getPlaybackTimeMs());
        const isOutlier = f.outlier || (pr && pr.outlier);
        const label = ((f.name && f.name.length && String(f.name) !== String(f.id)) ? f.name : f.id) + (isOutlier ? " (Outlier)" : "");

        ctx.save();
        const isPurpleAir = !!f.purpleair;
        if (isPurpleAir) {
          // Fade PurpleAir dots when a non-PM2.5 pollutant is active (PA sensors report PM2.5)
          const paFadedForPollutant = !isSel && this._paFieldPollutant != null && this._paFieldPollutant !== "pm25";
          // Outlier PurpleAir sensors still render (grey dot) so user can investigate
          // ── Per-sensor staleness fade matching trail duration ──
          let staleAlpha = 1.0;
          // Wall clock in live view (see paRefNowMs note in _ensurePaField).
          const _refMs = this._historicalMode
            ? (this.getPlaybackTimeMs() || this._dataNowMs())
            : Date.now();
          const _sensorMs = (pr && pr.timeMs) || (f.last_seen ? f.last_seen * 1000 : null);
          // Unknown age (no reading time, no last_seen) — hide rather than
          // showing a possibly day-old value as live.
          if (!isSel && !_sensorMs) { ctx.restore(); return; }
          if (!isSel && _sensorMs) {
            const PA_FADE_MS = 45 * 60 * 1000;
            const PA_FADE_TAIL = 0.20;
            const ageMs = _refMs - _sensorMs;
            if (ageMs >= PA_FADE_MS) { ctx.restore(); return; }
            const fadeStart = PA_FADE_MS * (1.0 - PA_FADE_TAIL);
            if (ageMs > fadeStart) {
              const u = (ageMs - fadeStart) / (PA_FADE_MS - fadeStart);
              staleAlpha = (1 - u) * (1 - u);
            }
          }
          if (paFadedForPollutant) staleAlpha *= 0.3;
          const dotR = isSel ? 8 : 6;
          const dotColor = paFadedForPollutant ? dimHex(safeHex((pr && pr.color) || color), 0.65) : safeHex((pr && pr.color) || color);
          if (isSel) {
            ctx.beginPath();
            ctx.fillStyle = "rgba(56, 140, 220, 0.38)";
            ctx.arc(sp.x, sp.y, dotR + 4, 0, Math.PI*2);
            ctx.fill();
          }
          ctx.beginPath();
          // When not selected: make PurpleAir subtle but still visible
          if (!isSel) {
            const darkened = darkenHex(dotColor, 0.85);
            ctx.fillStyle = hexToRgba(darkened, 0.45 * staleAlpha);
          } else {
            ctx.fillStyle = dotColor;
          }
          ctx.arc(sp.x, sp.y, dotR, 0, Math.PI*2);
          ctx.fill();
          ctx.strokeStyle = isSel ? "#5bb8f5" : darkenHex(dotColor, 0.7);
          ctx.globalAlpha = (isSel ? 1 : 0.5) * staleAlpha;
          ctx.lineWidth = isSel ? 1.8 : 1.2;
          ctx.stroke();
        } else {
          const _fHalo2   = _isLite ? 10 : 15;
          const _fCircle2 = _isLite ?  8 : 12;
          const _fFont2   = _isLite ? 10 : 15;
          if (isSel) {
            ctx.beginPath();
            ctx.fillStyle = "rgba(56, 140, 220, 0.38)";
            ctx.arc(sp.x, sp.y, _fHalo2, 0, Math.PI*2);
            ctx.fill();
          }
          ctx.beginPath();
          ctx.fillStyle = "rgba(16, 20, 28, 0.68)";
          ctx.arc(sp.x, sp.y, _fCircle2, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = isSel ? "#5bb8f5" : safeHex((pr && pr.color) || color);
          ctx.lineWidth = isSel ? 2.4 : 2.0;
          ctx.stroke();

          ctx.font = `${_fFont2}px Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(emoji, sp.x, sp.y);
        }

        const isHov = (this._hoveredId === keyF);
        if ((this.showFixedLabels && !isPurpleAir) || isSel || isHov || String(f.id) === "Home") {
          ctx.font = "600 12px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
          const line1 = label;
          const line2Key = pr.key ? String(pr.key) : "";
          const line2Val = formatTagValue(pr.value);
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
          const _markerColor = safeHex((pr && pr.color) || color);
          const markerColor = isOutlier ? outlierHex(_markerColor) : _markerColor;
          if (isOutlier) ctx.globalAlpha = 0.5;
          ctx.fillStyle = "rgba(16, 20, 28, 0.82)";
          ctx.strokeStyle = markerColor;
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
            const x0 = sp.x - (m2aw + m2bw) / 2;
            ctx.fillStyle = "rgba(232,238,247,0.70)";
            ctx.fillText(line2Key ? `${line2Key} ` : "", x0 + m2aw / 2, y2);
            ctx.fillStyle = isOutlier ? markerColor : (pr.color || "#ffffff");
            ctx.fillText(line2Val, x0 + m2aw + m2bw / 2, y2);
          }
        }
        ctx.restore();
      };

      // First pass: render PurpleAir markers (drawn first, so they appear behind)
      // (PA scalar field is rendered below, on PA field canvas — see _compositePaFieldOnTiles)
      for (const f of fixed) {
        if (f.purpleair) renderFixedMarker(f);
      }

      // Second pass: render non-PurpleAir markers
      for (const f of fixed) {
        if (!f.purpleair) renderFixedMarker(f);
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

      // Batched trail rendering: collect segments with same color/alpha,
      // stroke in a single beginPath() to avoid per-segment save/restore.
      ctx.lineWidth = lw;
      ctx.setLineDash(dash);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      let sBatchColor = null;
      let sBatchAlpha = null;
      let sBatchPts = [];

      const sFlushBatch = () => {
        if (sBatchPts.length < 2) { sBatchPts = []; return; }
        ctx.globalAlpha = sBatchAlpha;
        ctx.strokeStyle = sBatchColor;
        ctx.beginPath();
        for (let k = 0; k < sBatchPts.length; k += 2) {
          ctx.moveTo(sBatchPts[k].x, sBatchPts[k].y);
          ctx.lineTo(sBatchPts[k+1].x, sBatchPts[k+1].y);
        }
        ctx.stroke();
        sBatchPts = [];
      };

      const fadeStartAgeMs = FADE_TIME_MS * FADE_START_FRAC;

      for (let i = 1; i < pts.length; i++) {
        if (!pts[i - 1] || !pts[i]) { sFlushBatch(); continue; }

        const trailPt = trail[i];
        const isMoving = !!(trailPt && (trailPt.m === 1 || trailPt.m === "1" || trailPt.m === true));

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
          alphaMul2 = 0.5;
        }

        const t1 = times[i];
        if (!(t1 != null && isFinite(t1) && isFinite(refNowMs))) { sFlushBatch(); continue; }

        const ageMs = Math.max(0, Number(refNowMs) - Number(t1));
        if (ageMs >= FADE_TIME_MS) { sFlushBatch(); continue; }

        let tailAlpha = 1.0;
        if (ageMs > fadeStartAgeMs) {
          const u = (ageMs - fadeStartAgeMs) / (FADE_TIME_MS - fadeStartAgeMs);
          tailAlpha = (1 - u) * (1 - u);
          if (tailAlpha <= 0.01) { sFlushBatch(); continue; }
        }

        const finalAlpha = alpha * tailAlpha * alphaMul2;
        if (segColor !== sBatchColor || Math.abs(finalAlpha - (sBatchAlpha || 0)) > 0.01) {
          sFlushBatch();
          sBatchColor = segColor;
          sBatchAlpha = finalAlpha;
        }
        sBatchPts.push(pts[i - 1]);
        sBatchPts.push(pts[i]);
      }
      sFlushBatch();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1.0;

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

    // Pre-filter: skip mobiles whose trail is entirely expired (>45 min old).
    // During evening playback, most morning/afternoon vehicles are expired —
    // this avoids _collectTrailData + array allocs + projection for each.
    const TRAIL_EXPIRE_MS = 45 * 60 * 1000;
    const refTimeMs = this.getPlaybackTimeMs();
    const hasRefTime = refTimeMs != null && isFinite(refTimeMs);

    const alphaOther = selectedId ? 0.35 : 1.0;
    const candidates = [];
    for (const m of mobiles) {
      if (selectedId && m.id === selectedId) continue;
      const lastMs = trailLastMs(m);
      m._cachedTrailLastMs = lastMs;
      // Skip if trail ended >45 min before playback time
      if (hasRefTime && isFinite(lastMs) && refTimeMs - lastMs > TRAIL_EXPIRE_MS) continue;
      candidates.push(m);
    }
    candidates.sort((a, b) => a._cachedTrailLastMs - b._cachedTrailLastMs);

    for (const m of candidates) {
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
    // ── Per-frame deduplication ──
    // Multiple RAF chains (playbackLoop, _followTick, _paFieldFadeRAF, _requestZoomRedraw)
    // can all call drawOverlay in the same animation frame. The work is identical for a
    // given (view + playbackTime) so skip redundant calls within the same frame.
    {
      const _now = performance.now();
      if (this._overlayLastDrawMs && (_now - this._overlayLastDrawMs) < 4) return;
      this._overlayLastDrawMs = _now;
    }
    // During gestures/easing, skip legend-export work (no one reads these values).
    const _skipLegendExport = this._isTransientAnimating();
    // Only reset per-frame when nothing is selected.
    // When a sensor is selected but off-screen (user panned away),
    // keep the last-known values so the legend doesn't jump back to PM2.5.
    if (!this.selectedId && !_skipLegendExport) {
      this._selectedPollutantKey = null;
      this._selectedNaturalPollutantKey = null;
      this._selectedPollutantValue = null;
    }
    const w = this._cssW || 1;
    const h = this._cssH || 1;
    const dpr = this._dpr || (window.devicePixelRatio || 1);

    // CRITICAL: Reset transform to canonical dpr-scaled state at the start of every drawOverlay.
    // This prevents marker scaling bugs if any code path corrupts the transform and fails to restore.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

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

    // --- Per-frame caches (reset each drawOverlay call) ---
    // Emoji pre-render cache: drawImage of a cached canvas is far cheaper than
    // fillText with color-emoji fonts on iOS Safari (~1-3ms per fillText avoided).
    if (!this._emojiCanvasCache) this._emojiCanvasCache = new Map();
    const getEmojiCanvas = (emoji, size) => {
      const key = `${emoji}|${size}`;
      let c = this._emojiCanvasCache.get(key);
      if (c) return c;
      const px = size * 2; // 2x for clarity at retina
      c = document.createElement("canvas");
      c.width = px; c.height = px;
      const ec = c.getContext("2d");
      // Render at native canvas pixels so downscaling preserves the intended size.
      ec.font = `${px}px Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif`;
      ec.textAlign = "center";
      ec.textBaseline = "middle";
      ec.fillText(emoji, px / 2, px / 2);
      this._emojiCanvasCache.set(key, c);
      // Evict oldest entries if cache grows too large
      while (this._emojiCanvasCache.size > 200) {
        const oldest = this._emojiCanvasCache.keys().next().value;
        if (oldest == null) break;
        this._emojiCanvasCache.delete(oldest);
      }
      return c;
    };

    // measureText cache: avoids repeated glyph layout for identical strings.
    if (!this._textWidthCache) this._textWidthCache = new Map();
    const measureTextCached = (text, font) => {
      const key = `${font}|${text}`;
      let width = this._textWidthCache.get(key);
      if (width !== undefined) return width;
      ctx.font = font;
      width = ctx.measureText(text).width;
      if (!(width > 0)) width = text.length * 7; // iOS fallback
      this._textWidthCache.set(key, width);
      // Evict oldest entries if cache grows too large
      while (this._textWidthCache.size > 2000) {
        const oldest = this._textWidthCache.keys().next().value;
        if (oldest == null) break;
        this._textWidthCache.delete(oldest);
      }
      return width;
    };

    // dimHex/desatHex color cache: these do regex + parseInt + Math.round per call.
    const _colorXformCache = new Map();
    const colorXform = (baseColor, dimAmt, desatAmt) => {
      const key = `${baseColor}|${dimAmt}|${desatAmt}`;
      let r = _colorXformCache.get(key);
      if (r !== undefined) return r;
      r = desatAmt > 0 ? desatHex(dimHex(baseColor, dimAmt), desatAmt) : dimHex(baseColor, dimAmt);
      _colorXformCache.set(key, r);
      return r;
    };

    // Fixed sensor interpolation cache: avoids re-parsing history timestamps every frame.
    if (!this._fixedInterpCache) this._fixedInterpCache = { timeKey: null, map: new Map() };

    // Hoist values called redundantly per-mobile inside closures.
    const _framePbTimeMs = this.playbackMode ? this.getPlaybackTimeMs() : null;
    const _framePbBounds = this.playbackMode ? this.getPlaybackBounds() : null;
    const _frameSel = parseKey(this.selectedId);
    const _frameHasSelectedMobile = (_frameSel && _frameSel.type === "mobile" && _frameSel.id);
    const _frameSelectedId = _frameHasSelectedMobile ? _frameSel.id : null;

    // Playback-mode trail caching:
    // Cache trails to offscreen canvas; only redraw when view or time changes significantly.
    const pbTimeMs = _framePbTimeMs;
    const trailViewKey = `${this.center.lat.toFixed(6)}|${this.center.lon.toFixed(6)}|${this.zoom.toFixed(3)}|${w}|${h}|${this.selectedId || ''}|${this._paFieldPollutant || 'default'}`;
    const viewChanged = this._trailCacheViewKey !== trailViewKey;
    const timeDelta = (pbTimeMs != null && this._trailCacheTimeMs != null) ? (pbTimeMs - this._trailCacheTimeMs) : 0;
    // Trail fading uses a 45-min window with fade in the last 9 minutes — that's
    // ~1% alpha drop per 5.4 seconds, so the rebuild cadence can be coarse and
    // still look smooth. 30s during active scrub, 8s during normal playback.
    // (Was 2s, which redrew the O(vehicles*points) trail cache ~30× per minute
    // during playback even at 1× speed — measurable laptop heat.)
    const timeThreshold = this._scrubbing ? 30000 : 8000;
    // Sim-time gate: has enough simulated time elapsed to warrant a redraw?
    const simTimeElapsed = Math.abs(timeDelta) > timeThreshold;
    // Wall-time floor: at high playback speeds (60x screensaver), the sim-time gate
    // trips every ~33ms wall, causing the full O(vehicles*points) trail rebuild to
    // run 30x/sec. Rate-limit sim-driven redraws to ~10 Hz wall. View changes
    // (pan/zoom) still bypass this gate so interactive response stays snappy.
    const nowPerf = performance.now();
    const wallSinceRedraw = nowPerf - (this._lastTrailRedrawPerf || 0);
    const timeChanged = simTimeElapsed && wallSinceRedraw > 100;

    // Precompute center world once per frame; avoids repeated center projection in worldToScreen().
    const centerW = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
    const worldToScreenFast = (wx, wy) => ({ x: wx - centerW.x + w / 2, y: wy - centerW.y + h / 2 });

    // Overfetch: trail cache buffer is larger than viewport
    const trailBufW = Math.min(Math.ceil(w * _OVERFETCH), Math.floor(_OVERFETCH_MAX_DEVICE_PX / dpr));
    const trailBufH = Math.min(Math.ceil(h * _OVERFETCH), Math.floor(_OVERFETCH_MAX_DEVICE_PX / dpr));
    const worldToScreenBuf = (wx, wy) => ({ x: wx - centerW.x + trailBufW / 2, y: wy - centerW.y + trailBufH / 2 });

    // Fixed markers are drawn AFTER trails (below)

    // Trails:
    // - if none selected: show ALL trails
    // - if selected: show ALL trails, but dim others and draw selected last on top
    const sel = _frameSel;
    const hasSelectedMobile = _frameHasSelectedMobile;
    const selectedId = _frameSelectedId;

    // Reveal trail up to playback time (works in both DVR and LIVE modes).
    // LIVE mode uses playback time at the live edge.
    const isLive = !this.playbackMode;
    const trailRevealTimeMs = _framePbTimeMs;

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
      const livePlaybackTimeMs = _framePbTimeMs;
      const hasPlaybackTime = livePlaybackTimeMs != null && isFinite(livePlaybackTimeMs);
      const boundsMaxMs = (_framePbBounds && _framePbBounds.maxMs != null && isFinite(_framePbBounds.maxMs)) ? _framePbBounds.maxMs : null;
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

      // Binary search: skip old points outside the fade window entirely.
      // times[] is chronological (ascending). Find first index where age < FADE_TIME_MS.
      let _fadeStart = 1;
      if (times.length > 20 && isFinite(refNowMs)) {
        const cutoffT = refNowMs - FADE_TIME_MS;
        let _fl = 1, _fh = times.length - 1;
        while (_fl < _fh) {
          const _fm = (_fl + _fh) >> 1;
          if ((times[_fm] || 0) < cutoffT) _fl = _fm + 1; else _fh = _fm;
        }
        _fadeStart = Math.max(1, _fl);
      }

      for (let i = _fadeStart; i < pts.length; i++) {
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
            segColor = colorXform(segColor0, 0.25, 0);
          } else {
            // Previously hidden: keep visible, but fade + desaturate.
            segColor = colorXform(segColor0, 0.35, 0.30);
            alphaMul2 = 0.5;
          }
        } else if (isGhost && isLive) {
          segColor = colorXform(segColor0, 0.65, 0.25); // Dim + slight desat for offline sensors
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
      // Trail cache: full redraw on view change OR any time change.
      // Time-based fading requires full redraw whenever playback time changes so all
      // trail segments get redrawn with correct fade alpha relative to current time.
      const needsFullRedraw = viewChanged || timeChanged;
      // During gestures, skip full trail redraw for pan-only view changes;
      // translate the cached canvas instead (saves ~5ms/frame on iPad).
      // If pan exceeds overfetch margin, force full redraw.
      let skipTrailsForGesture = this._isTransientAnimating() && viewChanged && !timeChanged
        && this._trailCacheCanvas && this._trailCacheCenterW;
      if (skipTrailsForGesture) {
        const cachedCW = this._trailCacheCenterW;
        const cachedZ = this._trailCacheZoom || this.zoom;
        const currCW = latLonToWorld(this.center.lat, this.center.lon, cachedZ);
        const tMarginX = (trailBufW - w) / 2;
        const tMarginY = (trailBufH - h) / 2;
        if (Math.abs(cachedCW.x - currCW.x) >= tMarginX * _OVERFETCH_MARGIN_EXHAUST
            || Math.abs(cachedCW.y - currCW.y) >= tMarginY * _OVERFETCH_MARGIN_EXHAUST) {
          skipTrailsForGesture = false; // margin exhausted — force redraw
        }
      }
      const needsIncrementalUpdate = false; // Disabled: incremental breaks fade animation

      // Ensure trail cache canvas exists and is correctly sized (overfetch buffer)
      const targetW = Math.floor(trailBufW * dpr);
      const targetH = Math.floor(trailBufH * dpr);
      if (!this._trailCacheCanvas) {
        this._trailCacheCanvas = document.createElement("canvas");
        this._trailCacheCanvas.width = targetW;
        this._trailCacheCanvas.height = targetH;
      } else if (this._trailCacheCanvas.width !== targetW || this._trailCacheCanvas.height !== targetH) {
        this._trailCacheCanvas.width = targetW;
        this._trailCacheCanvas.height = targetH;
      }

      if ((needsFullRedraw && !skipTrailsForGesture) || needsIncrementalUpdate) {
        const tctx = this._trailCacheCanvas.getContext("2d");
        if (tctx) {
          tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          // Only clear on full redraw; incremental mode draws on top of existing cache
          if (needsFullRedraw) {
            tctx.clearRect(0, 0, trailBufW, trailBufH);
          }

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
          // minTimeMs: if set, only draw segments with time > minTimeMs (incremental mode)
          const origCtx = ctx;
          const drawTrailForCached = (m, alphaMul, toScreen, minTimeMs = null) => {
            const id = m && m.id != null ? String(m.id) : "";
            const data = this._collectTrailData(m, toScreen);
            if (!data) return false;
            const { pts, cols, times, trail, isGhost } = data;
            const isSelTrail = (selectedId && m.id === selectedId);
            const useIncrementalFilter = minTimeMs != null && isFinite(minTimeMs);

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
            const livePlaybackTimeMs = _framePbTimeMs;
            const hasPlaybackTime = livePlaybackTimeMs != null && isFinite(livePlaybackTimeMs);
            const boundsMaxMs = (_framePbBounds && _framePbBounds.maxMs != null && isFinite(_framePbBounds.maxMs)) ? _framePbBounds.maxMs : null;
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
                  segColor = colorXform(segColor0, 0.25, 0);
                } else {
                  segColor = colorXform(segColor0, 0.35, 0.30);
                  alphaMul2 = 0.5;
                }
              } else if (isGhost && isLive) {
                segColor = colorXform(segColor0, 0.65, 0.25);
              }

              const t1 = times[i];
              if (!(t1 != null && isFinite(t1) && isFinite(refNowMs))) { flushBatch(); continue; }

              // Incremental mode: skip segments already drawn in previous cache
              if (useIncrementalFilter && t1 <= minTimeMs) { continue; }

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

          // Pre-filter expired trails (>45 min old) to avoid array
          // allocations and projection work for vehicles no longer visible.
          const TRAIL_EXPIRE_MS = 45 * 60 * 1000;
          const hasRefTime = pbTimeMs != null && isFinite(pbTimeMs);

          const alphaOther = selectedId ? 0.35 : 1.0;
          const candidates = [];
          for (const m of mobiles) {
            if (selectedId && m.id === selectedId) continue;
            const lastMs = trailLastMs(m);
            m._cachedTrailLastMs = lastMs;
            if (hasRefTime && isFinite(lastMs) && pbTimeMs - lastMs > TRAIL_EXPIRE_MS) continue;
            candidates.push(m);
          }
          candidates.sort((a, b) => a._cachedTrailLastMs - b._cachedTrailLastMs);

          const timeFilter = null;
          for (const m of candidates) {
            drawTrailForCached(m, alphaOther, worldToScreenBuf, timeFilter);
          }

          if (selectedId) {
            const m = mobiles.find(x => x.id === selectedId);
            if (m) drawTrailForCached(m, 1.0, worldToScreenBuf, timeFilter);
          }
        }
        this._trailCacheViewKey = trailViewKey;
        this._trailCacheTimeMs = pbTimeMs;
        this._trailCacheCenterW = { x: centerW.x, y: centerW.y };
        this._trailCacheZoom = this.zoom;
        this._trailCacheBufW = trailBufW;
        this._trailCacheBufH = trailBufH;
        this._lastTrailRedrawPerf = performance.now();
      }

      // Blit cached trails to main canvas
      if (this._trailCacheCanvas) {
        const tBufW = this._trailCacheBufW || w;
        const tBufH = this._trailCacheBufH || h;
        const tOffX = (tBufW - w) / 2;
        const tOffY = (tBufH - h) / 2;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (skipTrailsForGesture && this._trailCacheCenterW) {
          const cachedZ = this._trailCacheZoom || this.zoom;
          const sZoom = Math.pow(2, this.zoom - cachedZ);
          const cachedCW = this._trailCacheCenterW;
          const currCW = latLonToWorld(this.center.lat, this.center.lon, cachedZ);
          if (Math.abs(sZoom - 1) > 0.001) {
            // Pinch-zoom: match tiles transform exactly (CSS coordinate space)
            const txPan = (cachedCW.x - currCW.x) * sZoom;
            const tyPan = (cachedCW.y - currCW.y) * sZoom;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.translate(w / 2, h / 2);
            ctx.scale(sZoom, sZoom);
            ctx.translate(-w / 2 + txPan / sZoom, -h / 2 + tyPan / sZoom);
            ctx.drawImage(this._trailCacheCanvas, -tOffX, -tOffY, tBufW, tBufH);
          } else {
            // Pan only: simple translate in physical pixel space with overfetch offset
            const dx = (cachedCW.x - currCW.x - tOffX) * dpr;
            const dy = (cachedCW.y - currCW.y - tOffY) * dpr;
            ctx.drawImage(this._trailCacheCanvas, dx, dy);
          }
        } else {
          // Static: draw the overfetch buffer offset so viewport sees center
          ctx.drawImage(this._trailCacheCanvas, -tOffX * dpr, -tOffY * dpr);
        }
        ctx.restore();
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DEBUG: Draw RAW GPS PATH (original GPS before road snapping) - orange dashed
    // This shows the original GPS coordinates from the server, before any
    // road-matching optimization is applied.
    // ═══════════════════════════════════════════════════════════════════════════
    if (this._pbDebugPath && this._pbDebugRawGps && this.playbackMode) {
      const selId = _frameSelectedId;
      if (selId) {
        const rawGps = this._playbackPtsById?.get(String(selId));
        if (rawGps && rawGps.length >= 2) {
          const ws = worldSizeForZoom(this.zoom);
          const pbTimeMs = _framePbTimeMs;

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
      const selId = _frameSelectedId;
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
            const CRUISE_SPEED = 65; // Base cruise speed in m/s (~145 mph, TRAX light-rail)
            
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

    // Fixed markers - drawn AFTER trails so they appear on top
    // Render PurpleAir (public) first (so they don't draw over other markers), then others
    const fixedPbTimeMs = _framePbTimeMs;
    if (!useStaticOverlay) {
      // Recompute declutter offsets (needed in non-trace mode where _drawStaticOverlay doesn't run).
      // Uses lat/lon proximity so only truly co-located stations get nudged.
      {
        const nudgeDeg = 0.0003;
        const colocThresh = 0.002;
        this._fixedGeoOffsets = new Map();
        const ents = [];
        for (const f of fixed) {
          if (f.purpleair) continue;
          const lat = Number(f.lat), lon = Number(f.lon);
          if (!isFinite(lat) || !isFinite(lon)) continue;
          if (!f._key) f._key = keyFor("fixed", f.id);
          ents.push({ key: f._key, lat, lon, dlat: 0, dlon: 0 });
        }
        for (let i = 0; i < ents.length; i++) {
          for (let j = i + 1; j < ents.length; j++) {
            const a = ents[i], b = ents[j];
            if (Math.abs(a.lat - b.lat) + Math.abs(a.lon - b.lon) < colocThresh) {
              const dl = b.lat - a.lat, dn = b.lon - a.lon;
              const ang = (Math.abs(dl) + Math.abs(dn) > 1e-7)
                ? Math.atan2(dn, dl)
                : Math.PI / 4;
              a.dlat -= Math.cos(ang) * nudgeDeg;
              a.dlon -= Math.sin(ang) * nudgeDeg;
              b.dlat += Math.cos(ang) * nudgeDeg;
              b.dlon += Math.sin(ang) * nudgeDeg;
            }
          }
        }
        for (const e of ents) {
          if (e.dlat || e.dlon) this._fixedGeoOffsets.set(e.key, { dlat: e.dlat, dlon: e.dlon });
        }
      }

      const renderPbFixedMarker = (f) => {
        let lat = Number(f.lat), lon = Number(f.lon);
        if (!isFinite(lat) || !isFinite(lon)) return;
        if (!f._key) f._key = keyFor("fixed", f.id);
        const geo = this._fixedGeoOffsets && this._fixedGeoOffsets.get(f._key);
        if (geo) { lat += geo.dlat; lon += geo.dlon; }
        const wpt = latLonToWorld(lat, lon, this.zoom);
        const sp = worldToScreenFast(wpt.x, wpt.y);
        if (sp.x < -50 || sp.y < -50 || sp.x > w+50 || sp.y > h+50) return;

        const key = f._key;
        const isSel = (this.selectedId === key);
        const emoji = f.purpleair ? "" : (f.emoji || "📍");
        const color = safeHex(f.ci);
        let pr;
        const interpCacheKey = (fixedPbTimeMs != null && isFinite(fixedPbTimeMs))
          ? `${f.id}|${Math.round(fixedPbTimeMs / 1000)}`
          : null;
        if (interpCacheKey) {
          const timeKey = Math.round(fixedPbTimeMs / 1000);
          if (this._fixedInterpCache.timeKey !== timeKey) {
            this._fixedInterpCache.timeKey = timeKey;
            this._fixedInterpCache.map.clear();
          }
          pr = this._fixedInterpCache.map.get(f.id);
          if (pr === undefined) {
            pr = primaryReadingForFixedAtTime(f, fixedPbTimeMs);
            this._fixedInterpCache.map.set(f.id, pr);
          }
        } else {
          pr = primaryReadingForFixedAtTime(f, fixedPbTimeMs);
        }

        // Expose the selected sensor's displayed pollutant key for legend sync
        if (!_skipLegendExport) {
          if (isSel && pr && pr.key) this._selectedPollutantKey = pr.key;
          if (isSel && pr && pr.key) this._selectedNaturalPollutantKey = pr.key;
          if (isSel && pr && pr.key) this._selectedPollutantValue = parseFloat(pr.value);
          // Full readings bag at the displayed time (see mobile path note).
          if (isSel) this._selectedReadings = (fixedPbTimeMs != null)
            ? (interpolateFixedReadingsAtTime(f, fixedPbTimeMs) || f.readings)
            : f.readings;
        }

        // Legend pollutant override: show the selected pollutant on ALL non-PurpleAir markers
        if (this._markerPollutantOverride != null && !f.purpleair) {
          const src = (fixedPbTimeMs != null)
            ? (interpolateFixedReadingsAtTime(f, fixedPbTimeMs) || f.readings)
            : f.readings;
          const legendPr = _readingForLegendTab(src, this._markerPollutantOverride);
          if (legendPr) {
            pr = legendPr;
            if (!_skipLegendExport && isSel) this._selectedPollutantKey = legendPr.key;
            if (!_skipLegendExport && isSel) this._selectedPollutantValue = parseFloat(legendPr.value);
          } else {
            const lbl = _LEGEND_TAB_LABEL[this._markerPollutantOverride] || this._markerPollutantOverride.toUpperCase();
            pr = { key: lbl, value: "\u2014", color: "#666666" };
            if (!_skipLegendExport && isSel) this._selectedPollutantKey = null;
            if (!_skipLegendExport && isSel) this._selectedPollutantValue = null;
          }
        }

        // No data for this sensor at the current scrub time — skip drawing
        if (!pr) { return; }

        const isOutlier = f.outlier || (pr && pr.outlier);
        const label = ((f.name && f.name.length && String(f.name) !== String(f.id)) ? f.name : f.id) + (isOutlier ? " (Outlier)" : "");

        ctx.save();
        const isPurpleAir = !!f.purpleair;
        if (isPurpleAir) {
          // Fade PurpleAir dots when a non-PM2.5 pollutant is active (PA sensors report PM2.5)
          const paFadedForPollutant = !isSel && this._paFieldPollutant != null && this._paFieldPollutant !== "pm25";
          // Outlier PurpleAir sensors still render (grey dot) so user can investigate
          // ── Per-sensor staleness fade matching trail duration ──
          let staleAlpha = 1.0;
          // Wall clock in live view (see paRefNowMs note in _ensurePaField).
          const _refMs = this._historicalMode
            ? (this.getPlaybackTimeMs() || this._dataNowMs())
            : Date.now();
          const _sensorMs = (pr && pr.timeMs) || (f.last_seen ? f.last_seen * 1000 : null);
          // Unknown age (no reading time, no last_seen) — hide rather than
          // showing a possibly day-old value as live.
          if (!isSel && !_sensorMs) { ctx.restore(); return; }
          if (!isSel && _sensorMs) {
            const PA_FADE_MS = 45 * 60 * 1000;
            const PA_FADE_TAIL = 0.20;
            const ageMs = _refMs - _sensorMs;
            if (ageMs >= PA_FADE_MS) { ctx.restore(); return; }
            const fadeStart = PA_FADE_MS * (1.0 - PA_FADE_TAIL);
            if (ageMs > fadeStart) {
              const u = (ageMs - fadeStart) / (PA_FADE_MS - fadeStart);
              staleAlpha = (1 - u) * (1 - u);
            }
          }
          if (paFadedForPollutant) staleAlpha *= 0.3;
          const dotR = isSel ? 8 : 6;
          const dotColor = paFadedForPollutant ? dimHex(safeHex((pr && pr.color) || color), 0.65) : safeHex((pr && pr.color) || color);
          if (isSel) {
            ctx.beginPath();
            ctx.fillStyle = "rgba(56, 140, 220, 0.38)";
            ctx.arc(sp.x, sp.y, dotR + 4, 0, Math.PI*2);
            ctx.fill();
          }
          ctx.beginPath();
          if (!isSel) {
            const darkened = darkenHex(dotColor, 0.85);
            ctx.fillStyle = hexToRgba(darkened, 0.45 * staleAlpha);
          } else {
            ctx.fillStyle = dotColor;
          }
          ctx.arc(sp.x, sp.y, dotR, 0, Math.PI*2);
          ctx.fill();
          ctx.strokeStyle = isSel ? "#5bb8f5" : darkenHex(dotColor, 0.7);
          ctx.globalAlpha = (isSel ? 1 : 0.5) * staleAlpha;
          ctx.lineWidth = isSel ? 1.8 : 1.2;
          ctx.stroke();
        } else {
          const _fHalo   = _isLite ? 10 : 15;
          const _fCircle = _isLite ?  8 : 12;
          const _fEmoji  = _isLite ? 10 : 15;
          if (isSel) {
            ctx.beginPath();
            ctx.fillStyle = "rgba(56, 140, 220, 0.38)";
            ctx.arc(sp.x, sp.y, _fHalo, 0, Math.PI*2);
            ctx.fill();
          }
          ctx.beginPath();
          ctx.fillStyle = "rgba(16, 20, 28, 0.68)";
          ctx.arc(sp.x, sp.y, _fCircle, 0, Math.PI*2);
          ctx.fill();
          ctx.strokeStyle = isSel ? "#5bb8f5" : safeHex((pr && pr.color) || color);
          ctx.lineWidth = isSel ? 2.4 : 2.0;
          ctx.stroke();

          const fixedEmojiC = getEmojiCanvas(emoji, _fEmoji);
          ctx.drawImage(fixedEmojiC, sp.x - _fEmoji/2, sp.y - _fEmoji/2, _fEmoji, _fEmoji);
        }

        const showLabel = isPurpleAir ? this.showPublicLabels : this.showFixedLabels;
        const isHov = !isPurpleAir && (this._hoveredId === key);
        if (showLabel || isSel || isHov || String(f.id) === "Home") {
          const labelFont = "600 12px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
          const line1 = label;
          const line2Key = pr.key ? String(pr.key) : "";
          const line2Val = formatTagValue(pr.value);
          const m1w = measureTextCached(line1, labelFont);
          const m2aw = measureTextCached(line2Key ? `${line2Key} ` : "", labelFont);
          const m2bw = measureTextCached(line2Val, labelFont);
          const padX = 8;
          const bw = Math.max(m1w, (m2aw + m2bw)) + padX*2;
          const bh = (line2Key || line2Val) ? 30 : 18;
          const bx = sp.x - bw/2;
          const by = sp.y + 18;
          const _markerColor = safeHex((pr && pr.color) || color);
          const markerColor = isOutlier ? outlierHex(_markerColor) : _markerColor;
          if (isOutlier) ctx.globalAlpha = 0.5;
          ctx.fillStyle = "rgba(16, 20, 28, 0.82)";
          ctx.strokeStyle = markerColor;
          ctx.lineWidth = 1.8;
          roundRect(ctx, bx, by, bw, bh, 9);
          ctx.fill();
          ctx.stroke();
          ctx.font = labelFont;
          ctx.fillStyle = "#e8eef7";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          const padY = 4;
          const lineH = (bh - padY * 2) / ((line2Key || line2Val) ? 2 : 1);
          const y1 = by + padY + lineH * 0.5;
          const y2 = by + padY + lineH * 1.5;
          ctx.fillText(line1, sp.x, y1);
          if (line2Key || line2Val) {
            const x0 = sp.x - (m2aw + m2bw) / 2;
            ctx.fillStyle = "rgba(232,238,247,0.70)";
            ctx.fillText(line2Key ? `${line2Key} ` : "", x0 + m2aw / 2, y2);
            ctx.fillStyle = isOutlier ? markerColor : (pr.color || "#ffffff");
            ctx.fillText(line2Val, x0 + m2aw + m2bw / 2, y2);
          }
        }
        ctx.restore();
      };

      // First pass: PurpleAir (public)
      // (PA scalar field is rendered below, on PA field canvas — see _compositePaFieldOnTiles)
      if (this.showPublic) {
        for (const f of fixed) {
          if (f.purpleair) renderPbFixedMarker(f);
        }
      }
      // Second pass: others (fixed)
      if (this.showFixed) {
        for (const f of fixed) {
          if (!f.purpleair) renderPbFixedMarker(f);
        }
      }
    }

    // Mobile emoji markers
    const nowMs = (opts && typeof opts.nowMs === "number" && isFinite(opts.nowMs)) ? opts.nowMs : performance.now();
    if (this.traceMode || this.playbackMode) {
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
      if (!m._key) m._key = keyFor("mobile", m.id);
      const key = m._key;
      const isSel = (this.selectedId === key);
      const debug = !!this._pbDebugPath;
      // In playback mode, show ghosted sensors if they have trail data (they were active in the past).
      // In live mode, hide ghosted sensors unless Debug/Selected.
      const hasPlaybackData = this.playbackMode && this._playbackPtsById.has(String(m.id));
      if (!!m.ghosted && !debug && !isSel && !hasPlaybackData) return;
      // In playback mode, ignore live parked state — vehicle was active at the playback time
      const isParked = hasPlaybackData ? false : !!m.parked;
      const dimmed = (!debug && !isSel && isParked);
      if (!isFinite(lat) || !isFinite(lon)) return;
      const wpt = latLonToWorld(lat, lon, this.zoom);
      const sp = worldToScreenFast(wpt.x, wpt.y);
      if (sp.x < -50 || sp.y < -50 || sp.x > w+50 || sp.y > h+50) return;

      const held = !!pose.held;
      const id = (m && m.id != null) ? String(m.id) : "";

      const emoji = m.emoji || "🚌";
      const label = (m.name && m.name.length && String(m.name) !== String(m.id)) ? m.name : m.id;
      const color0 = safeHex(m.ci);
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
          // Only blend with live readings when the playhead is actually at the trail end.
          // _playbackLiveFollow means "will eventually reach the end", not "is there now";
          // using it here caused the marker to show the current live value (e.g. PM10 394)
          // when the playhead was still minutes behind the end on initial load.
          const followingLive = this.isPlaybackAtEnd(200);
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
      } else if (this.playbackMode && !this.isPlaybackAtEnd(200) && !this._playbackPtsById.has(String(m.id))) {
        // Sensor has no playback trail data (e.g. parked at depot) — show "--" instead of frozen live value
        pr = { key: "", value: "--", color: "#666666" };
      }
      // Expose the selected sensor's displayed pollutant key for legend sync
      if (!_skipLegendExport) {
        if (isSel && pr && pr.key) this._selectedPollutantKey = pr.key;
        if (isSel && pr && pr.key) this._selectedNaturalPollutantKey = pr.key;
        if (isSel && pr && pr.key) this._selectedPollutantValue = parseFloat(pr.value);
        // Full readings bag at the displayed time — legend tab colors must use
        // the same source as the marker, not the live state snapshot.
        if (isSel) this._selectedReadings = (this.playbackMode && pose && pose.readings) ? pose.readings : m.readings;
      }

      // Legend pollutant override: show the legend's chosen pollutant on ALL mobile markers
      // In playback mode, prefer trail-point readings (historical) over live m.readings
      if (this._markerPollutantOverride != null) {
        const src = (this.playbackMode && pose && pose.readings) ? pose.readings : m.readings;
        const legendPr = _readingForLegendTab(src, this._markerPollutantOverride);
        if (legendPr) {
          pr = legendPr;
          if (!_skipLegendExport && isSel) this._selectedPollutantKey = legendPr.key;
          if (!_skipLegendExport && isSel) this._selectedPollutantValue = parseFloat(legendPr.value);
        } else {
          const lbl = _LEGEND_TAB_LABEL[this._markerPollutantOverride] || this._markerPollutantOverride.toUpperCase();
          pr = { key: lbl, value: "\u2014", color: "#666666" };
          if (!_skipLegendExport && isSel) this._selectedPollutantKey = null;
          if (!_skipLegendExport && isSel) this._selectedPollutantValue = null;
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

      // Marker sizes: lite mode (embedded widget) vs normal
      const _mHalo   = _isLite ? 11 : 16;
      const _mCircle = _isLite ?  9 : 13;
      const _mEmoji  = _isLite ? 11 : 16;

      // halo
      ctx.beginPath();
      if (this.selectedId === key) {
        ctx.fillStyle = "rgba(56, 140, 220, 0.38)";
        ctx.arc(spx, spy, _mHalo * liftScale, 0, Math.PI*2);
        ctx.fill();
        ctx.beginPath();
      }
      ctx.fillStyle = "rgba(16, 20, 28, 0.68)";
      ctx.arc(spx, spy, _mCircle * liftScale, 0, Math.PI*2);
      ctx.fill();
      // Border matches AQI color (selected gets brighter ring)
      ctx.strokeStyle = (this.selectedId === key) ? "#5bb8f5" : safeHex(prColorUse);
      ctx.lineWidth = (this.selectedId === key) ? 2.8 : 2.2;
      ctx.stroke();

      // emoji (pre-rendered to offscreen canvas; drawImage is ~10x faster than
      // fillText with color-emoji fonts on iOS Safari)
      const emojiC = getEmojiCanvas(emoji, _mEmoji);
      const emojiHalf = _mEmoji / 2;
      ctx.save();
      if (this.traceMode || this.playbackMode) {
        ctx.translate(spx, spy);
        if (liftScale !== 1.0) ctx.scale(liftScale, liftScale);
        if (flipX) ctx.scale(-1, 1);
        ctx.rotate(angle);
        ctx.drawImage(emojiC, -emojiHalf, -emojiHalf, _mEmoji, _mEmoji);
      } else {
        ctx.drawImage(emojiC, spx - emojiHalf, spy - emojiHalf, _mEmoji, _mEmoji);
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
          const speedFont = "10px -apple-system, system-ui, sans-serif";
          ctx.font = speedFont;
          const tw = measureTextCached(txt, speedFont);
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

      // tiny label pill (show for selected, hovered, or when labels toggle is on)
      const isHov = (this._hoveredId === key);
      const shouldShowLabel = this.showMobileLabels || isSel || isHov;
      if (shouldShowLabel) {
        ctx.save();
        // Reset transform and alpha for label drawing
        ctx.globalAlpha = 1.0;
        const txt1 = label || id || "?";
        const txt2Key = pr.key ? String(pr.key) : "";
        const txt2Val = formatTagValue(pr.value);
        const mobileLabelFont = "600 12px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
        const m1w = measureTextCached(txt1, mobileLabelFont);
        const m2aw = measureTextCached(txt2Key ? `${txt2Key} ` : "", mobileLabelFont);
        const m2bw = measureTextCached(txt2Val, mobileLabelFont);
        const padX = 8;
        const bw = Math.max(m1w, (m2aw + m2bw)) + padX*2;
        const bh = (txt2Key || txt2Val) ? 30 : 18;
        const bx = spx - bw/2;
        const by = spy + 18;
        ctx.fillStyle = "rgba(16, 20, 28, 0.82)";
        ctx.strokeStyle = safeHex(prColorUse || colorUse);
        ctx.lineWidth = 1.8;
        roundRect(ctx, bx, by, bw, bh, 9);
        ctx.fill();
        ctx.stroke();
        ctx.font = mobileLabelFont;
        ctx.fillStyle = "#e8eef7";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const padY = 4;
        const lineH = (bh - padY * 2) / ((txt2Key || txt2Val) ? 2 : 1);
        const y1 = by + padY + lineH * 0.5;
        const y2 = by + padY + lineH * 1.5;
        ctx.fillText(txt1, spx, y1);
        if (txt2Key || txt2Val) {
          const x0 = spx - (m2aw + m2bw) / 2;
          ctx.fillStyle = "rgba(232,238,247,0.70)";
          ctx.fillText(txt2Key ? `${txt2Key} ` : "", x0 + m2aw / 2, y2);
          ctx.fillStyle = prColorUse;
          ctx.fillText(txt2Val, x0 + m2aw + m2bw / 2, y2);
        }
        ctx.restore();
      }
      ctx.restore();
    };

    // ── Wind vector debug overlay ─────────────────────────────────────────
    if (this.windAdvection._windSnapshots && window._fieldDebug?.showWind) {
      const _playbackActive = this.playbackMode && _framePbTimeMs != null && isFinite(_framePbTimeMs);
      const wfData = this._windFieldForTime(_framePbTimeMs, _playbackActive);
      if (wfData) {
        const _wCenter = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
        ctx.save();
        ctx.strokeStyle = "rgba(80,180,255,0.6)";
        ctx.fillStyle = "rgba(80,180,255,0.6)";
        ctx.lineWidth = 1.2;
        const arrowScale = window._fieldDebug.windArrowScale || 6;

        const _drawArrow = (sx, sy, u, v) => {
          const speed = Math.sqrt(u * u + v * v);
          if (speed < 0.3) return;
          const len = Math.min(speed * arrowScale, 30);
          const dx = (u / speed) * len;
          const dy = -(v / speed) * len;
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(sx + dx, sy + dy);
          ctx.stroke();
          const headLen = Math.min(4, len * 0.35);
          const angle = Math.atan2(dy, dx);
          ctx.beginPath();
          ctx.moveTo(sx + dx, sy + dy);
          ctx.lineTo(sx + dx - headLen * Math.cos(angle - 0.5), sy + dy - headLen * Math.sin(angle - 0.5));
          ctx.lineTo(sx + dx - headLen * Math.cos(angle + 0.5), sy + dy - headLen * Math.sin(angle + 0.5));
          ctx.closePath();
          ctx.fill();
        };

        if (wfData.gw != null && wfData.uGrid) {
          // Grid format — derive arrow positions from cell centers
          const gw2 = wfData.gw, gh2 = wfData.gh, b = wfData.bounds;
          const dLon = (b.lonMax - b.lonMin) / gw2;
          const dLat = (b.latMax - b.latMin) / gh2;
          for (let iy = 0; iy < gh2; iy++) {
            const lat = b.latMin + (iy + 0.5) * dLat;
            for (let ix = 0; ix < gw2; ix++) {
              const lon = b.lonMin + (ix + 0.5) * dLon;
              const idx = iy * gw2 + ix;
              const wpt = latLonToWorld(lat, lon, this.zoom);
              const sx = wpt.x - _wCenter.x + w / 2;
              const sy = wpt.y - _wCenter.y + h / 2;
              if (sx < -20 || sx > w + 20 || sy < -20 || sy > h + 20) continue;
              _drawArrow(sx, sy, wfData.uGrid[idx] || 0, wfData.vGrid[idx] || 0);
            }
          }
        } else if (Array.isArray(wfData) && wfData.length > 0) {
          // Legacy point array
          for (let i = 0; i < wfData.length; i++) {
            const wp = wfData[i];
            const wpt = latLonToWorld(wp.lat, wp.lon, this.zoom);
            const sx = wpt.x - _wCenter.x + w / 2;
            const sy = wpt.y - _wCenter.y + h / 2;
            if (sx < -20 || sx > w + 20 || sy < -20 || sy > h + 20) continue;
            _drawArrow(sx, sy, wp.u || 0, wp.v || 0);
          }
        }
        ctx.restore();
      }
    }

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

    // Debug: render virtual mobile sensors as ghost dots
    if (window._fieldDebug?.showVirtual && this._virtualMobileSensors?.length > 0) {
      // vs.sx/sy are in overfetch buffer space; shift to viewport space.
      const _bufW = this._paFieldBufW || (this._cssW || 1);
      const _bufH = this._paFieldBufH || (this._cssH || 1);
      const _vw = this._cssW || 1;
      const _vh = this._cssH || 1;
      const _offX = (_bufW - _vw) / 2;
      const _offY = (_bufH - _vh) / 2;
      ctx.save();
      for (const vs of this._virtualMobileSensors) {
        const _ghostAqiKey = _LEGEND_TAB_AQI_KEY[this._paFieldPollutant || "pm25"] || "pm2.5";
        const _ghostAqi = valueToAqi(_ghostAqiKey, vs.value);
        const rgb = _aqiToRgb(_ghostAqi != null && isFinite(_ghostAqi) ? _ghostAqi : 0);
        const tint = 0.35;
        const cr = Math.round(128 * (1 - tint) + rgb[0] * tint);
        const cg = Math.round(128 * (1 - tint) + rgb[1] * tint);
        const cb = Math.round(128 * (1 - tint) + rgb[2] * tint);
        ctx.globalAlpha = 0.5 * (vs.weightMultiplier || 0.01);
        ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
        ctx.beginPath();
        ctx.arc(vs.sx - _offX, vs.sy - _offY, 4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }
}
// Expose on window for cross-script access (class declarations don't auto-create window properties)
window.MapView = MapView;
