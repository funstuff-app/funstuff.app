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
    // Mouse drag pan (optional). Does not affect trackpad controls.
    // _mouseDragging is shared (read by PlaybackEngine/PaFieldRenderer); the
    // drag start/center/moved bookkeeping is owned by CameraGestures.
    this._mouseDragging = false;
    this.center = { lat: 40.7608, lon: -111.8910 };
    // macOS trackpad UX: two-finger pan + pinch zoom (avoid mouse-drag schema)
    this._centerAnimRAF = null;

    // Auto-camera follow must never override user interaction.
    // Suppression window/cooldown are owned by CameraGestures (engine_camera_gestures.js).
    this._lastAutoFitSig = "";
    this._autoFitInFlightSig = "";
    this._pendingForcedFit = null; // { bounds, durationMs }
    this.selectedId = null;
    // Hover state: show label on mouseover with debounce.
    // _hoveredId is shared (read by OverlayRenderer); the show/hide debounce
    // timers are owned by CameraGestures (engine_camera_gestures.js).
    this._hoveredId = null;       // key currently showing hover label
    // Marker visibility toggles
    this.showFixed = true;
    this.showMobile = true;
    // Label visibility is per-sensor-type (mobile vs fixed)
    this.showMobileLabels = false;
    this.showFixedLabels = false;
    // PA field pollutant: which pollutant the field should display (null = default/highest AQI)
    // Shared with app.js + overlay/trail rendering; PaFieldRenderer reads it via view.
    this._paFieldPollutant = null;
    // Marker pollutant override: only set from explicit legend tab clicks
    // Shared with marker rendering; PaFieldRenderer reads/writes it via view.
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

    // PurpleAir scalar field underlay: cached offscreen canvas of radial gradient discs.
    // Shared with resize()/draw()/app.js; PaFieldRenderer reads/writes via view.
    // Remaining PA-field state (dim/cross-fade/validity/worker/pre-warm) is owned
    // by PaFieldRenderer (engine_pa_field.js).
    this._paFieldCanvas = null;
    this._paFieldCtx = null;
    this._paFieldKey = "";
    // Fingerprint validity window: playback time range where no sensor changes
    // color category, so _collectPaFieldSensors can be skipped entirely.
    this._paFieldValidRange = null; // { fromMs, toMs }

    // Playback-mode optimization: cache trails to offscreen canvas.
    // Trails only need redrawing when view changes; time advances use incremental updates.
    this._trailCacheCanvas = null;
    this._trailCacheViewKey = "";

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
    // The orchestration RAF/state (_selectOrchRAF/_selectOrch) is owned by
    // CameraGestures; the warp map is shared with OverlayRenderer/PlaybackEngine.
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

    // Touch pan/pinch state (iPad, iOS, Android).
    // _touchState is owned by CameraGestures; _touchActive is shared (read by
    // TileRenderer/PlaybackEngine).
    this._touchActive = false; // true while any touch is in progress (for skipping expensive ops)

    // Debounce tile-load redraws to avoid cascading redraws when multiple tiles load at once
    this._tileLoadRedrawTimer = null;
    // Snapshot of the last rendered basemap frame to avoid flicker while tiles load.
    this._tilesSnapshotCanvas = null; // offscreen canvas
    this._tilesSnapshotMeta = null; // { zoom, centerLat, centerLon }

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

    // PA scalar-field pipeline: kernel regression, per-pollutant maxima, worker
    // pre-warming, compositing (engine_pa_field.js).
    const PaFieldRendererCtor = (typeof window !== "undefined" ? window : globalThis).PaFieldRenderer;
    this.paField = new PaFieldRendererCtor(this);

    // Interactive overlay layer: markers, trails, selection/hover/labels,
    // static-overlay cache, persisted trails, per-mobile cache pruning
    // (engine_overlay_renderer.js).
    const OverlayRendererCtor = (typeof window !== "undefined" ? window : globalThis).OverlayRenderer;
    this.overlay = new OverlayRendererCtor(this);

    // All pointer/touch/wheel/gesture input, pinch-zoom inertia, hover/hit-test/
    // tap selection, and camera animation/fit/orchestration + auto-camera gating
    // live in CameraGestures (engine_camera_gestures.js). The redraw/inertia RAFs,
    // pinch-velocity/anchor state, wheel-pan debounce, and platform scroll-velocity
    // accumulators moved there. _pinchZooming and _scrubbing remain shared here
    // (read by TileRenderer/PlaybackEngine/PaFieldRenderer/app.js/jog_wheel).
    this._pinchZooming = false;
    this._scrubbing = false; // true during timeline scrub (slider/jog wheel drag)

    // Pointer/touch/wheel/gesture + camera animation/fit/orchestration controller
    // (engine_camera_gestures.js).
    const CameraGesturesCtor = (typeof window !== "undefined" ? window : globalThis).CameraGestures;
    this.gestures = new CameraGesturesCtor(this);

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

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  _cancelCameraAnimations(...args) { return this.gestures._cancelCameraAnimations(...args); }

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  _suppressAutoCamera(...args) { return this.gestures._suppressAutoCamera(...args); }

  // Shorten (never extend) the auto-camera cooldown for high-AQI alerts.
  // Does NOT cancel animations, set _autoCameraCooldownMs, or affect Live mode.
  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  _overrideCooldownForAlert(...args) { return this.gestures._overrideCooldownForAlert(...args); }

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  _noteUserInteraction(...args) { return this.gestures._noteUserInteraction(...args); }

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  _isGesturing(...args) { return this.gestures._isGesturing(...args); }

  /** True during any camera movement: user gestures, inertia, easing, follow, orchestration. */
  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  _isAnimating(...args) { return this.gestures._isAnimating(...args); }

  /** Like _isAnimating but excludes the persistent follow loop.
   *  Used by PA field to allow recomputation after user gestures while following a vehicle. */
  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  _isTransientAnimating(...args) { return this.gestures._isTransientAnimating(...args); }

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  _canRunAutoCamera(...args) { return this.gestures._canRunAutoCamera(...args); }

  _dataNowMs() {
    const baseMs = this._dataNowBaseMs;
    const basePerf = this._dataNowBasePerfMs;
    if (baseMs != null && isFinite(baseMs) && basePerf != null && isFinite(basePerf)) {
      return Number(baseMs) + Math.max(0, performance.now() - Number(basePerf));
    }
    return Date.now();
  }

  /** Delegates to OverlayRenderer (engine_overlay_renderer.js). */
  _invalidateOverlayStatic() { return this.overlay._invalidateOverlayStatic(); }

  _invalidatePaField() { this.paField._invalidatePaField(); }

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

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  _stopPinchInertia(...args) { return this.gestures._stopPinchInertia(...args); }

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  _notePinchVelocity(...args) { return this.gestures._notePinchVelocity(...args); }

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  _startPinchInertia(...args) { return this.gestures._startPinchInertia(...args); }

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  _requestZoomRedraw(...args) { return this.gestures._requestZoomRedraw(...args); }

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  _redrawViewOnly(...args) { return this.gestures._redrawViewOnly(...args); }

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  _requestPanRedraw(...args) { return this.gestures._requestPanRedraw(...args); }

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  _notifyViewChanged(...args) { return this.gestures._notifyViewChanged(...args); }

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  _eventToLocalXY(...args) { return this.gestures._eventToLocalXY(...args); }

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  onGestureStart(...args) { return this.gestures.onGestureStart(...args); }

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  onGestureChange(...args) { return this.gestures.onGestureChange(...args); }

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  onGestureEnd(...args) { return this.gestures.onGestureEnd(...args); }

  // Touch event handlers for iPad/iOS/Android pan and pinch-zoom
  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  onTouchStart(...args) { return this.gestures.onTouchStart(...args); }

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  onTouchMove(...args) { return this.gestures.onTouchMove(...args); }

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  onTouchEnd(...args) { return this.gestures.onTouchEnd(...args); }

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

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  onMouseDown(...args) { return this.gestures.onMouseDown(...args); }

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  onMouseMove(...args) { return this.gestures.onMouseMove(...args); }

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  onMouseUp(...args) { return this.gestures.onMouseUp(...args); }

  /** Delegates to OverlayRenderer (engine_overlay_renderer.js). */
  _getOverlayPaddingPx() { return this.overlay._getOverlayPaddingPx(); }

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  _animateTo(...args) { return this.gestures._animateTo(...args); }

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  fitTrailBounds(...args) { return this.gestures.fitTrailBounds(...args); }

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  fitBoundsLatLon(...args) { return this.gestures.fitBoundsLatLon(...args); }

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  _screenPointToLatLon(...args) { return this.gestures._screenPointToLatLon(...args); }

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  _setZoomAroundScreenPoint(...args) { return this.gestures._setZoomAroundScreenPoint(...args); }

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  centerOn(...args) { return this.gestures.centerOn(...args); }

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  cancelSelectionOrchestration(...args) { return this.gestures.cancelSelectionOrchestration(...args); }

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  _latLonComfortablyInView(...args) { return this.gestures._latLonComfortablyInView(...args); }

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  _computeFocusedCenterFor(...args) { return this.gestures._computeFocusedCenterFor(...args); }

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  orchestrateSelectionToLatest(...args) { return this.gestures.orchestrateSelectionToLatest(...args); }

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

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  _hitTestMobileAtClientXY(...args) { return this.gestures._hitTestMobileAtClientXY(...args); }

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

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  zoomBy(...args) { return this.gestures.zoomBy(...args); }

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


  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  onWheel(...args) { return this.gestures.onWheel(...args); }

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  _updateHoverAtClientXY(...args) { return this.gestures._updateHoverAtClientXY(...args); }

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  _scheduleHoverHide(...args) { return this.gestures._scheduleHoverHide(...args); }

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  _clearHover(...args) { return this.gestures._clearHover(...args); }

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  onClick(...args) { return this.gestures.onClick(...args); }

  /** Delegates to CameraGestures (engine_camera_gestures.js). */
  _handleTapSelection(...args) { return this.gestures._handleTapSelection(...args); }

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

  /** Delegates to OverlayRenderer (engine_overlay_renderer.js). */
  clearVehicleCaches() { return this.overlay.clearVehicleCaches(); }

  /** Delegates to OverlayRenderer (engine_overlay_renderer.js). */
  _prunePerMobileCachesForState(state) { return this.overlay._prunePerMobileCachesForState(state); }

  /** Delegates to OverlayRenderer (engine_overlay_renderer.js). */
  _getPersistedTrailEntry(id) { return this.overlay._getPersistedTrailEntry(id); }

  /** Delegates to OverlayRenderer (engine_overlay_renderer.js). */
  _updatePersistedTrails(state) { return this.overlay._updatePersistedTrails(state); }

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

  /** Switch PA field to a different pollutant. Invalidates field cache and redraws.
   *  @param {string} tab - Legend tab id: "pm25","pm10","o3","no2","co". */
  setPaFieldPollutant(tab) { this.paField.setPaFieldPollutant(tab); }

  getReadingForPollutant(tab) { return this.paField.getReadingForPollutant(tab); }

  setMarkerPollutantOverride(tab) { this.paField.setMarkerPollutantOverride(tab); }

  setPaFieldDim(target) { this.paField.setPaFieldDim(target); }

  _compositePaFieldOnTiles(state, tilesJustRedrawn = false) { this.paField._compositePaFieldOnTiles(state, tilesJustRedrawn); }

  _ensurePaField(state, playbackTimeMs) { this.paField._ensurePaField(state, playbackTimeMs); }

  /** Delegates to WindAdvection (engine_wind_advection.js). */
  _sampleWindAtCenter(centerW, z, clat, clon, playbackTimeMs, _fd) {
    return this.windAdvection._sampleWindAtCenter(centerW, z, clat, clon, playbackTimeMs, _fd);
  }

  /** Lazy per-pollutant field-max accessor; see PaFieldRenderer.getPerPollutantFieldMax. */
  getPerPollutantFieldMax() { return this.paField.getPerPollutantFieldMax(); }

  _computePerPollutantFieldMax(state, playbackTimeMs, centerW, z, cssW, cssH, bufW, bufH, paRefNowMs, virtualRefNowMs, cellSize, gw, gh, cutoffSq, effectiveCutoffSq, wind, twoSigmaSq) { this.paField._computePerPollutantFieldMax(state, playbackTimeMs, centerW, z, cssW, cssH, bufW, bufH, paRefNowMs, virtualRefNowMs, cellSize, gw, gh, cutoffSq, effectiveCutoffSq, wind, twoSigmaSq); }

  _ensurePaGrid(gw, gh) { return this.paField._ensurePaGrid(gw, gh); }

  _kernelGrid(sensors, gw, gh, cellSize, cutoffSq, isoCutoffSq, wind, outAqi, outW) { this.paField._kernelGrid(sensors, gw, gh, cellSize, cutoffSq, isoCutoffSq, wind, outAqi, outW); }

  _paintPaCells(aqiCell, wCell, gw, gh, cellSize, FIELD_ALPHA, dpr, vpCssW, vpCssH, cssW, cssH) { this.paField._paintPaCells(aqiCell, wCell, gw, gh, cellSize, FIELD_ALPHA, dpr, vpCssW, vpCssH, cssW, cssH); }

  _computePaFieldSync(sensors, gw, gh, cellSize, cutoffSq, isoCutoffSq, FIELD_ALPHA, cssW, cssH, dpr, wind, vpCssW, vpCssH) { this.paField._computePaFieldSync(sensors, gw, gh, cellSize, cutoffSq, isoCutoffSq, FIELD_ALPHA, cssW, cssH, dpr, wind, vpCssW, vpCssH); }

  _computeMaxModeFieldSync(perPollS5, gw, gh, cellSize, cutoffSq, isoCutoffSq, FIELD_ALPHA, cssW, cssH, dpr, wind, vpCssW, vpCssH) { this.paField._computeMaxModeFieldSync(perPollS5, gw, gh, cellSize, cutoffSq, isoCutoffSq, FIELD_ALPHA, cssW, cssH, dpr, wind, vpCssW, vpCssH); }

  _upscalePaField(tc, cssW, cssH, dpr) { this.paField._upscalePaField(tc, cssW, cssH, dpr); }

  _onPaWorkerResult(data) { this.paField._onPaWorkerResult(data); }

  _preWarmPaFields(state, playbackTimeMs) { this.paField._preWarmPaFields(state, playbackTimeMs); }

  /** Delegates to OverlayRenderer (engine_overlay_renderer.js). */
  _overlayStaticKeyForState(state) { return this.overlay._overlayStaticKeyForState(state); }

  /** Delegates to OverlayRenderer (engine_overlay_renderer.js). */
  _collectTrailData(m, toScreen) { return this.overlay._collectTrailData(m, toScreen); }

  /** Delegates to OverlayRenderer (engine_overlay_renderer.js). */
  _ensureOverlayStatic(state) { return this.overlay._ensureOverlayStatic(state); }

  /** Delegates to OverlayRenderer (engine_overlay_renderer.js). */
  drawOverlay(state, opts = {}) { return this.overlay.drawOverlay(state, opts); }
}
// Expose on window for cross-script access (class declarations don't auto-create window properties)
window.MapView = MapView;
