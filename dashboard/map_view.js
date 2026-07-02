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

  /** Delegates to OverlayRenderer (engine_overlay_renderer.js). */
  _getOverlayPaddingPx() { return this.overlay._getOverlayPaddingPx(); }

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
