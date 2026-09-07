/**
 * engine_camera_gestures.js — CameraGestures: all pointer/touch/wheel/gesture
 * input, pinch-zoom inertia, hover/hit-testing/tap selection, camera
 * animation/fit/orchestration, and auto-camera gating.
 *
 * MapView remains the composition root and keeps the shared view state; its own
 * event-handler entry points and public camera API (onWheel/onClick, the
 * onTouch/onMouse/onGesture handlers, _animateTo/fitTrailBounds/centerOn/zoomBy/
 * orchestrateSelectionToLatest/cancelSelectionOrchestration/_redrawViewOnly/
 * _isGesturing/_isTransientAnimating/_canRunAutoCamera/_overrideCooldownForAlert
 * etc.) become one-line delegates to `this.gestures.<method>()`. The DOM event
 * listeners stay attached in the MapView constructor and dispatch to those
 * delegates.
 *
 * State OWNED by CameraGestures (moved off MapView): the Safari-gesture handle
 * (_gesture) + legacy pinch-anchor (_pinchAnchor), mouse-drag pan bookkeeping
 * (_mouseDragStart/_mouseDragCenterStart/_mouseDragMoved), the auto-camera
 * suppression window/cooldown (_autoCameraSuppressedUntilPerfMs/
 * _autoCameraCooldownMs), the hover show/hide debounce timers
 * (_hoverShowTimer/_hoverHideTimer), selection-orchestration RAF+state
 * (_selectOrchRAF/_selectOrch), the pinch-zoom/pan redraw RAFs and inertia
 * (_zoomDrawRAF/_panDrawRAF/_pinchInertiaRAF/_pinchVz/_pinchVelTs/
 * _pinchAnchorSX/_pinchAnchorSY/_wheelPinchEndTimer/_pinchZoomEndTimer), the
 * wheel-pan debounce (_lastWheelPanTime/_wheelPanning/_wheelPanEndTimer), the
 * platform scroll-velocity accumulators (_winScrollAccum/_winScrollLastTs/
 * _winScrollFlushTimer/_macScrollAccum/_macScrollLastTs), and the touch state
 * (_touchState).
 *
 * SHARED MapView fields read/written here (kept on MapView, not moved, because
 * unmoved MapView code, app.js, or other engine modules also touch them),
 * accessed via `view.<field>`:
 *   zoom, center, _zoomMin, _zoomMax, _cssW, _cssH, _dpr, themeKey, lastState,
 *   overlayCanvas, tilesCanvas, selectedId, _hoveredId, _mouseDragging,
 *   _touchActive, _pinchZooming, _scrubbing,
 *   _centerAnimRAF, _isAutoCameraAnimating, _followRAF, _followSuppressUntilMs,
 *   _traceSelectionWarpById, _lastTilesViewSig,
 *   _tilesSnapshotCanvas, _tilesSnapshotMeta, _isMac, _isWindows, playbackMode,
 *   traceMode, _historicalMode, _paFieldPollutant, _fixedGeoOffsets,
 *   _traceActiveRouteById, _pbDrag, _pbInertia2d, _playbackLiveFollow,
 *   and the monkey-patched view._resetLiveTracking (set by app.js).
 * SHARED MapView methods used via view: draw, drawTiles, drawOverlay,
 *   worldToScreen, setSelected, _compositePaFieldOnTiles,
 *   _invalidateOverlayStatic, _getOverlayPaddingPx, _dataNowMs, _scheduleTileRedraw,
 *   getPlaybackBounds/getPlaybackTimeMs/setPlaybackTimeMs/getPlaybackPlaying/
 *   setPlaybackPlaying, _mobilePoseForRender, _traceSampleForMobile,
 *   _closestPlaybackPathPointForMobileAtClientXY, _startPbMarkerInertiaFromDrag,
 *   and the tile-redraw-pending flag view._tileRedrawPending.
 *
 * Globals from earlier-loaded scripts (projections.js, data_utils.js) are
 * resolved lazily via `g` — never at module factory time (node tests have no
 * browser globals). Each method aliases the globals it needs into local consts
 * at the top so the moved bodies stay verbatim.
 */
(function (root, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else {
    root.CameraGestures = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var g = (typeof window !== "undefined") ? window : globalThis;

  class CameraGestures {
    /**
     * @param {object} view — MapView instance (owns the shared camera/view/
     *   playback state; see file header for the full shared-field list).
     */
    constructor(view) {
      this.view = view;

      // Prefer native macOS Safari pinch gesture events when available.
      this._gesture = null; // { startZoom, startScale, anchorLat, anchorLon, sx, sy }
      this._pinchAnchor = null; // { lat, lon, sx, sy, lastTs }

      // Mouse drag pan (optional). Does not affect trackpad controls.
      this._mouseDragStart = null; // {x,y}
      this._mouseDragCenterStart = null; // {x,y,ws}
      this._mouseDragMoved = false;

      // Auto-camera follow must never override user interaction.
      // Suppress live-follow/forced-fit animations during interaction + short cooldown.
      this._autoCameraSuppressedUntilPerfMs = 0;
      this._autoCameraCooldownMs = 1400;

      // Hover state: show label on mouseover with debounce
      this._hoverShowTimer = null;  // setTimeout id for show debounce
      this._hoverHideTimer = null;  // setTimeout id for hide debounce

      // Selection orchestration (polished camera + trace sync).
      this._selectOrchRAF = null;
      this._selectOrch = null; // { id, t0Ms, homeLat, homeLon, camTo:{lat,lon}, camFrom:{lat,lon}, camDelayMs, camDurMs, warpDurMs }

      // Touch pan/pinch state (iPad, iOS, Android)
      this._touchState = null; // null or { startTouches, startCenter, startZoom, startCenterLatLon, lastPinchDist, lastMidpoint }

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
      this._lastWheelPanTime = 0; // debounce pan→zoom from trackpad finger-lift artifacts
      this._wheelPanning = false; // true during trackpad/keyboard-trackpad wheel-pan streams
      this._wheelPanEndTimer = null; // debounce timer to exit wheel-pan mode

      // Windows scroll-velocity accumulator for adaptive zoom
      this._winScrollAccum = 0;      // accumulated deltaY in current burst
      this._winScrollLastTs = 0;      // timestamp of last wheel event
      this._winScrollFlushTimer = null;

      // macOS scroll-velocity accumulator for adaptive zoom (mouse wheel only)
      this._macScrollAccum = 0;
      this._macScrollLastTs = 0;
    }

    _cancelCameraAnimations() {
      const view = this.view;
      if (view._centerAnimRAF) {
        cancelAnimationFrame(view._centerAnimRAF);
        view._centerAnimRAF = null;
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
      const view = this.view;
      // User input wins: cancel in-flight camera animations and suppress new auto-fits.
      this._cancelCameraAnimations();
      this._autoCameraCooldownMs = 300000; // 5 minutes after any user interaction
      this._suppressAutoCamera();
      view._followSuppressUntilMs = performance.now() + 4000;
    }

    _isGesturing() {
      const view = this.view;
      return view._touchActive || view._mouseDragging || view._pinchZooming || this._wheelPanning || view._scrubbing;
    }

    /** True during any camera movement: user gestures, inertia, easing, follow, orchestration. */
    _isAnimating() {
      const view = this.view;
      return this._isGesturing() || !!view._centerAnimRAF || !!this._selectOrchRAF || !!view._followRAF;
    }

    /** Like _isAnimating but excludes the persistent follow loop.
     *  Used by PA field to allow recomputation after user gestures while following a vehicle. */
    _isTransientAnimating() {
      const view = this.view;
      return this._isGesturing() || !!view._centerAnimRAF || !!this._selectOrchRAF;
    }

    _canRunAutoCamera() {
      const view = this.view;
      const now = performance.now();
      if (view._touchActive || view._mouseDragging || view._pinchZooming) return false;
      if (view._followRAF) return false; // follow loop is running — it owns the camera
      return now >= (this._autoCameraSuppressedUntilPerfMs || 0);
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
      const view = this.view;
      const clamp = g.clamp;
      // Only continue if we have meaningful velocity and an anchor.
      if (!isFinite(this._pinchVz) || Math.abs(this._pinchVz) < 0.00005 || !isFinite(this._pinchAnchorSX) || !isFinite(this._pinchAnchorSY)) {
        // No coast. Keep _pinchZooming alive briefly so the expensive PA field
        // path doesn't fire in the gap before the next wheel event arrives.
        // If no event arrives within 80ms, then truly end pinch mode.
        if (!this._pinchZoomEndTimer) {
          this._pinchZoomEndTimer = window.setTimeout(() => {
            this._pinchZoomEndTimer = null;
            view._pinchZooming = false;
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
        const z2 = clamp(view.zoom + this._pinchVz * dt, view._zoomMin, view._zoomMax);
        this._setZoomAroundScreenPoint(z2, this._pinchAnchorSX, this._pinchAnchorSY);
        // Keep tile snapshot alive so drawTiles fast-path (scale + return) fires.
        // The snapshot is recaptured with real tiles once inertia ends.
        this._requestZoomRedraw();
        this._notifyViewChanged();

        this._pinchVz *= 0.90; // fast decay; keep minimal math
        if (Math.abs(this._pinchVz) < 0.00005 || z2 === view._zoomMin || z2 === view._zoomMax) {
          this._pinchInertiaRAF = null;
          view._pinchZooming = false;
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
      const view = this.view;
      if (this._zoomDrawRAF) return;
      this._zoomDrawRAF = requestAnimationFrame(() => {
        this._zoomDrawRAF = null;
        this._applyZoomAnchor3d();
        view.draw(view.lastState);
      });
    }

    _redrawViewOnly() {
      const view = this.view;
      // Redraw basemap + overlay for view changes (center/zoom/theme/size) without
      // reprocessing state-derived caches. Used to throttle high-frequency pan events.
      const state = view.lastState;
      if (!state) return;

      const viewSig = (() => {
        const z = Number(view.zoom);
        const lat = Number(view.center?.lat);
        const lon = Number(view.center?.lon);
        const w = Number(view._cssW);
        const h = Number(view._cssH);
        const dpr = Number(view._dpr || (window.devicePixelRatio || 1));
        const r = (x, p = 1e6) => (isFinite(x) ? (Math.round(x * p) / p) : x);
        return `${view.themeKey}|${r(z, 1e3)}|${r(lat)}|${r(lon)}|${w}x${h}|dpr:${r(dpr, 1e3)}|pinch:${view._pinchZooming ? 1 : 0}`;
      })();

      let tilesRedrawn = false;
      if (view._lastTilesViewSig !== viewSig) {
        view._lastTilesViewSig = viewSig;
        view.drawTiles();
        tilesRedrawn = true;
      }
      // PA scalar field: above tiles, below trails/markers. Composite onto tiles canvas.
      view._compositePaFieldOnTiles(state, tilesRedrawn);
      view.drawOverlay(state, { cacheUnderlay: true });
    }

    _requestPanRedraw() {
      if (this._panDrawRAF) return;
      this._panDrawRAF = requestAnimationFrame(() => {
        this._panDrawRAF = null;
        this._applyZoomAnchor3d();
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

    /** overlayCanvas bounding rect, read at most once per animation frame.
     *  Every pointer handler needs it, and at pointer rate (120+ events/s on
     *  a trackpad or touch screen) a layout read per event forces a
     *  synchronous layout flush each time the DOM is dirty. */
    _overlayRect() {
      const now = performance.now();
      if (!this._rectCache || (now - this._rectCacheAt) > 12) {
        this._rectCache = this.view.overlayCanvas.getBoundingClientRect();
        this._rectCacheAt = now;
      }
      return this._rectCache;
    }

    _eventToLocalXY(e) {
      const view = this.view;
      const rect = this._overlayRect();
      const cx = (typeof e.clientX === "number") ? e.clientX : (rect.left + rect.width / 2);
      const cy = (typeof e.clientY === "number") ? e.clientY : (rect.top + rect.height / 2);
      return { sx: cx - rect.left, sy: cy - rect.top };
    }

    onGestureStart(e) {
      const view = this.view;
      // Safari-only; prevent page zoom and handle pinch natively.
      e.preventDefault();
      e.stopPropagation();
      this._noteUserInteraction();
      this._stopPinchInertia();
      view._pinchZooming = true;
      const { sx, sy } = this._eventToLocalXY(e);
      const ll = this._screenPointToLatLon(sx, sy);
      this._gesture = {
        startZoom: view.zoom,
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
      const view = this.view;
      const clamp = g.clamp;
      if (!this._gesture) return;
      e.preventDefault();
      e.stopPropagation();
      this._noteUserInteraction();
      view._pinchZooming = true;
      const { sx, sy } = this._eventToLocalXY(e);
      // Update anchor screen point as the gesture midpoint moves.
      this._gesture.sx = sx;
      this._gesture.sy = sy;

      const scale = (typeof e.scale === "number" && isFinite(e.scale) && e.scale > 0) ? e.scale : 1;
      const ratio = Math.max(0.2, Math.min(5, scale / (this._gesture.startScale || 1)));
      const dz = Math.log2(ratio);
      const z2 = clamp(this._gesture.startZoom + dz, view._zoomMin, view._zoomMax);
      const prevZ = view.zoom;
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
      const view = this.view;
      const latLonToWorld = g.latLonToWorld;
      // Prevent browser's default behavior (page scroll, zoom)
      e.preventDefault();
    
      // Mark touch as active to skip expensive operations during interaction
      view._touchActive = true;

      this._noteUserInteraction();
    
      // Cancel any in-progress pinch inertia
      this._stopPinchInertia();
    
      const touches = e.touches;
      if (touches.length === 0) return;

      const rect = this._overlayRect();
    
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
            view._touchActive = false;
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
        view._pinchZooming = true;
      }

      // Store initial touch state
      const cw = latLonToWorld(view.center.lat, view.center.lon, view.zoom);
      this._touchState = {
        startTouches: touches.length,
        startMidpoint: { x: midX, y: midY },
        startCenterWorld: { x: cw.x, y: cw.y, ws: cw.ws },
        startZoom: view.zoom,
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
      const view = this.view;
      const clamp = g.clamp;
      const latLonToWorld = g.latLonToWorld;
      const worldToLatLon = g.worldToLatLon;
      if (!this._touchState) return;
      e.preventDefault();

      this._noteUserInteraction();

      const touches = e.touches;
      if (touches.length === 0) return;

      const rect = this._overlayRect();

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
        view._pinchZooming = true;
        const dx = touches[0].clientX - touches[1].clientX;
        const dy = touches[0].clientY - touches[1].clientY;
        const pinchDist = Math.sqrt(dx * dx + dy * dy);

        if (this._touchState.lastPinchDist > 0 && pinchDist > 0) {
          const scale = pinchDist / this._touchState.lastPinchDist;
          const dz = Math.log2(scale);
          const prevZ = view.zoom;
          const z2 = clamp(view.zoom + dz, view._zoomMin, view._zoomMax);
          this._setZoomAroundScreenPoint(z2, midX, midY);
          this._notePinchVelocity(z2 - prevZ, performance.now());
        }
        this._touchState.lastPinchDist = pinchDist;
      }

      // Pan: translate based on midpoint delta from last frame
      const dmx = midX - this._touchState.lastMidpoint.x;
      const dmy = midY - this._touchState.lastMidpoint.y;

      if (Math.abs(dmx) > 0.5 || Math.abs(dmy) > 0.5) {
        const c = latLonToWorld(view.center.lat, view.center.lon, view.zoom);
        const nx = c.x - dmx;
        const ny = clamp(c.y - dmy, 0, c.ws - 1);
        const ll = worldToLatLon(nx, ny, view.zoom);
        view.center = { lat: ll.lat, lon: ll.lon };
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
      const view = this.view;
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
        view._touchActive = false;
        // Flush any tile redraws that were deferred during touch
        if (view._tileRedrawPending) {
          view._tileRedrawPending = false;
          view._scheduleTileRedraw();
        }
        // All fingers lifted - start inertia if we were pinching.
        // Guard: on iOS Safari, gestureEnd fires before touchEnd for the same
        // pinch release, so _startPinchInertia() may already be running.
        // Starting a second chain corrupts shared state (snapshot, velocity)
        // and causes blown-out PA field alpha.
        if (view._pinchZooming && !this._pinchInertiaRAF) {
          this._startPinchInertia();
        } else if (!view._pinchZooming) {
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
        const rect = this._overlayRect();
        const t = e.touches[0];
        const mx = t.clientX - rect.left;
        const my = t.clientY - rect.top;
        this._touchState.lastMidpoint = { x: mx, y: my };
        this._touchState.lastPinchDist = 0;
        this._touchState.startTouches = 1;
        view._pinchZooming = false;
        // End zoom inertia; continue panning only
        this._stopPinchInertia();
        this._requestZoomRedraw();
      }
    }

    onMouseDown(e) {
      const view = this.view;
      const latLonToWorld = g.latLonToWorld;
      const keyFor = g.keyFor;
      // Click-drag pan (mouse). Trackpad two-finger pan is still wheel-based.
      if (e.button !== 0) return;

      // DVR: drag a marker to scrub playback time along its path.
      // NOTE: Click-to-drag marker scrubbing is temporarily disabled.
      /*
      if (view.playbackMode) {
        const nowMs = performance.now();
        const hit = this._hitTestMobileAtClientXY(e.clientX, e.clientY, nowMs);
        if (hit && hit.id != null) {
          try { e.preventDefault(); e.stopPropagation(); } catch {}
          const id = String(hit.id);
          const wasPlaying = view.getPlaybackPlaying();
          // Stop playback while manipulating (like a DVR scrub).
          view.setPlaybackPlaying(false);

          // Cancel any existing inertia glide when a new interaction begins.
          view._pbInertia2d = null;

          // Bring the interacted marker to the top of the draw stack immediately.
          // (Do not call __selectSensor here; that may trigger camera orchestration.)
          try {
            const k = keyFor("mobile", id);
            if (view.selectedId !== k) view.selectedId = k;
          } catch {}

          view._pbDrag = {
            id,
            startedAtMs: nowMs,
            lastClient: { x: e.clientX, y: e.clientY },
            cursorClient: { x: e.clientX, y: e.clientY },
            lastMoveMs: nowMs,
            vel: { x: 0, y: 0 },
            wasPlaying,
          };

          // Immediately scrub to the closest point under the cursor.
          try { view._scrubPlaybackTimeForMobileAtClientXY(hit, e.clientX, e.clientY); } catch {}

          // Treat as a drag so onClick does not toggle selection.
          this._mouseDragMoved = false;
          view.drawOverlay(view.lastState);
          return;
        }
      }
      */

      this._noteUserInteraction();
      this._stopPinchInertia();
      view._pinchZooming = false;
      view._mouseDragging = true;
      this._mouseDragMoved = false;
      this._mouseDragStart = { x: e.clientX, y: e.clientY };
      const cw = latLonToWorld(view.center.lat, view.center.lon, view.zoom);
      this._mouseDragCenterStart = { x: cw.x, y: cw.y, ws: cw.ws };
    }

    onMouseMove(e) {
      const view = this.view;
      const clamp = g.clamp;
      const worldToLatLon = g.worldToLatLon;
      if (view._pbDrag && view.playbackMode) {
        const nowMs = performance.now();
        const dx = e.clientX - (view._pbDrag.lastClient?.x ?? e.clientX);
        const dy = e.clientY - (view._pbDrag.lastClient?.y ?? e.clientY);
        if (Math.abs(dx) + Math.abs(dy) > 2) this._mouseDragMoved = true;

        // Track drag velocity for inertial glide on release.
        const lastMoveMs = (view._pbDrag.lastMoveMs != null && isFinite(view._pbDrag.lastMoveMs)) ? view._pbDrag.lastMoveMs : nowMs;
        const dtMs = Math.max(1, nowMs - lastMoveMs);
        const vx = dx / dtMs;
        const vy = dy / dtMs;
        const prevV = view._pbDrag.vel || { x: 0, y: 0 };
        // Low-pass filter: stable velocity estimate without jitter.
        const a = 0.25;
        view._pbDrag.vel = {
          x: prevV.x * (1 - a) + vx * a,
          y: prevV.y * (1 - a) + vy * a,
        };
        view._pbDrag.lastMoveMs = nowMs;

        view._pbDrag.lastClient = { x: e.clientX, y: e.clientY };
        view._pbDrag.cursorClient = { x: e.clientX, y: e.clientY };
        const st = view.lastState;
        const mobiles = st && Array.isArray(st.mobile) ? st.mobile : [];
        const m = mobiles.find(mm => (mm && mm.id != null && String(mm.id) === String(view._pbDrag.id))) || null;
        if (m) {
          // Always scrub time to the closest point on the path (no distance gating).
          const closest = view._closestPlaybackPathPointForMobileAtClientXY(m, e.clientX, e.clientY);
          if (closest && isFinite(closest.tMs)) {
            const bounds = view.getPlaybackBounds();
            const tMs = closest.tMs;
            if (isFinite(bounds.minMs) && isFinite(bounds.maxMs)) {
              const clamped = clamp(tMs, bounds.minMs, bounds.maxMs);
              view.setPlaybackTimeMs(clamped);
              // User interaction exits LIVE mode (they're manually controlling)
              view._playbackLiveFollow = false;
              if (typeof view._resetLiveTracking === "function") view._resetLiveTracking();
            } else {
              view.setPlaybackTimeMs(tMs);
              view._playbackLiveFollow = false;
              if (typeof view._resetLiveTracking === "function") view._resetLiveTracking();
            }
          }
          view.drawOverlay(view.lastState);
        }
        return;
      }
      if (!view._mouseDragging || !this._mouseDragStart || !this._mouseDragCenterStart) {
        // Hover hit-test for mobile/fixed (non-PurpleAir) marker labels.
        // mousemove fires at pointer rate (well above the frame rate on a
        // 120 Hz display); coalesce to one hit-test per frame, and none while
        // the camera is moving.
        this._hoverClient = { x: e.clientX, y: e.clientY };
        if (this._hoverRAF || this._isTransientAnimating()) return;
        this._hoverRAF = requestAnimationFrame(() => {
          this._hoverRAF = null;
          const c = this._hoverClient;
          if (c) this._updateHoverAtClientXY(c.x, c.y);
        });
        return;
      }
      this._noteUserInteraction();
      const dx = e.clientX - this._mouseDragStart.x;
      const dy = e.clientY - this._mouseDragStart.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) this._mouseDragMoved = true;

      const centerX = this._mouseDragCenterStart.x - dx;
      const centerY = clamp(this._mouseDragCenterStart.y - dy, 0, this._mouseDragCenterStart.ws - 1);
      const ll = worldToLatLon(centerX, centerY, view.zoom);
      view.center = { lat: ll.lat, lon: ll.lon };
      // If zoom inertia is running, its RAF already calls draw() which reads view.center —
      // no separate pan redraw needed (avoids two full draws fighting per frame).
      if (!this._pinchInertiaRAF) this._requestPanRedraw();
    }

    onMouseUp() {
      const view = this.view;
      if (view._pbDrag) {
        const drag = view._pbDrag;
        view._pbDrag = null;

        // Start a short inertial glide for the interacted marker.
        // This continues scrubbing the global time for *all* markers.
        try { view._startPbMarkerInertiaFromDrag(drag); } catch {}

        // User request: always resume playback for all after interacting.
        view.setPlaybackPlaying(true);
        if (typeof window.__ensurePlaybackLoop === "function") window.__ensurePlaybackLoop();
        return;
      }
      view._mouseDragging = false;
      this._mouseDragStart = null;
      this._mouseDragCenterStart = null;
      this._redrawViewOnly();
      // click behavior is handled in onClick; we just stop dragging here.
    }

    _animateTo({ centerLat, centerLon, zoom }, { durationMs = 420, isAutoCamera = false } = {}) {
      const view = this.view;
      const clamp = g.clamp;
      const lat0 = view.center.lat;
      const lon0 = view.center.lon;
      const z0 = view.zoom;
      const lat1 = Number(centerLat);
      const lon1 = Number(centerLon);
      const z1 = clamp(Number(zoom), view._zoomMin || 1, view._zoomMax || 20);
      if (!isFinite(lat1) || !isFinite(lon1) || !isFinite(z1)) return;
      if (!isFinite(lat0) || !isFinite(lon0) || !isFinite(z0)) return;

      const t0 = performance.now();
      // Only used for auto-centering / fit-to-bounds. Keep it snappy.
      const dur = Math.max(120, durationMs);

      if (view._centerAnimRAF) cancelAnimationFrame(view._centerAnimRAF);

      // Track whether this animation is auto-camera so that view-change
      // listeners (e.g. localStorage persistence) can ignore it.
      view._isAutoCameraAnimating = isAutoCamera;

      const zoomChanging = Math.abs(z1 - z0) > 1e-6;

      // Safety: limit animation frames to prevent runaway loops
      let frameCount = 0;
      const maxFrames = Math.ceil(dur / 8) + 60;

      const finish = () => {
        view._centerAnimRAF = null;
        // Keep _isAutoCameraAnimating true through the final draw + notify so that
        // view-change listeners (e.g. localStorage persistence) don't overwrite the
        // user's manually-chosen view with the auto-camera destination.
        view.draw(view.lastState);
        this._notifyViewChanged();
        view._isAutoCameraAnimating = false;
        // After the first auto-camera animation, extend cooldown to 5 minutes
        // so subsequent user interactions suppress auto-camera for much longer.
        if (isAutoCamera) this._autoCameraCooldownMs = 300000;
      };

      const step = () => {
        frameCount++;
        if (frameCount > maxFrames) {
          console.warn('_animateTo: exceeded max frames, forcing completion');
          view.zoom = z1;
          view.center = { lat: lat1, lon: lon1 };
          finish();
          return;
        }

        const t = clamp((performance.now() - t0) / dur, 0, 1);
        // smoothstep ease-in-out: zoom and pan arrive together, no swoop
        const ease = t * t * (3 - 2 * t);
        view.zoom = z0 + (z1 - z0) * ease;
        view.center = { lat: lat0 + (lat1 - lat0) * ease, lon: lon0 + (lon1 - lon0) * ease };
        if (zoomChanging) {
          // Zoom is changing — need full redraw for correct scale
          view.draw(view.lastState);
        } else {
          // Pan-only — use fast snapshot translate path
          this._redrawViewOnly();
        }
        this._notifyViewChanged();
        if (t < 1) {
          view._centerAnimRAF = requestAnimationFrame(step);
        } else {
          finish();
        }
      };
      view._centerAnimRAF = requestAnimationFrame(step);
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
      const view = this.view;
      const clamp = g.clamp;
      const latLonToWorld = g.latLonToWorld;
      const worldToLatLon = g.worldToLatLon;
      const lonToX = g.lonToX;
      const latToY = g.latToY;
      // Compute zoom to fit bbox using WebMercator at z=0.
      const w0 = 256;
      const xMin0 = lonToX(minLon, w0);
      const xMax0 = lonToX(maxLon, w0);
      const yMin0 = latToY(maxLat, w0);
      const yMax0 = latToY(minLat, w0);
      const dx0 = Math.max(1e-6, Math.abs(xMax0 - xMin0));
      const dy0 = Math.max(1e-6, Math.abs(yMax0 - yMin0));

      const rect = this._overlayRect();
      const w = rect.width;
      const h = rect.height;
      const pad = view._getOverlayPaddingPx();
      const availW = Math.max(40, w - pad.left - pad.right);
      const availH = Math.max(40, h - pad.top - pad.bottom);

      const scale = Math.min(availW / dx0, availH / dy0);
      let z = Math.log2(scale);
      // padding / breathing room
      z -= 0.18;
      z = clamp(z, view._zoomMin, view._zoomMax);

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
        view.center = { lat: centerLL.lat, lon: centerLL.lon };
        view.zoom = z;
        view.draw(view.lastState);
      }
    }

    _screenPointToLatLon(sx, sy) {
      const view = this.view;
      const clamp = g.clamp;
      const latLonToWorld = g.latLonToWorld;
      const worldToLatLon = g.worldToLatLon;
      // Pitched 3D camera: the ground under a screen point is not a flat
      // offset from center. Inverse of worldToScreen -> mapgl.projectWorld.
      const gl = view.mapgl ? view.mapgl.unprojectScreen(sx, sy) : null;
      if (gl) return gl;
      const w = view._cssW || 1;
      const h = view._cssH || 1;
      const c = latLonToWorld(view.center.lat, view.center.lon, view.zoom);
      const wx = c.x - w / 2 + sx;
      const wy = c.y - h / 2 + sy;
      const clampedY = clamp(wy, 0, c.ws - 1);
      return worldToLatLon(wx, clampedY, view.zoom);
    }

    _setZoomAroundScreenPoint(newZoom, sx, sy) {
      const view = this.view;
      const clamp = g.clamp;
      const latLonToWorld = g.latLonToWorld;
      const worldToLatLon = g.worldToLatLon;
      const z2 = clamp(newZoom, view._zoomMin, view._zoomMax);
      const gl = view.mapgl;
      const is3d = !!(gl && gl.active && gl.ready);

      // This runs per wheel/gesturechange/touchmove EVENT (pointer rate, well
      // above frame rate). Per event only the flat math below runs, in both
      // modes. In 3D the true ground point under the cursor is captured ONCE
      // per frame (one terrain unproject) and the flat result is corrected to
      // it in the redraw rAF (_applyZoomAnchor3d), never per event: a terrain
      // unproject needs the GL camera pushed first (jumpTo) and that per
      // event is what locked Safari up.
      if (is3d && !this._zoomAnchor3d) {
        const a = gl.unprojectScreen(sx, sy);
        if (a) this._zoomAnchor3d = { lat: a.lat, lon: a.lon };
      }

      const w = view._cssW || 1;
      const h = view._cssH || 1;
      const c = latLonToWorld(view.center.lat, view.center.lon, view.zoom);
      const ll = worldToLatLon(c.x - w / 2 + sx, clamp(c.y - h / 2 + sy, 0, c.ws - 1), view.zoom);
      const wpt2 = latLonToWorld(ll.lat, ll.lon, z2);
      const centerWorld2 = {
        x: wpt2.x - (sx - w / 2),
        y: wpt2.y - (sy - h / 2),
        ws: wpt2.ws,
      };
      const centerLL2 = worldToLatLon(centerWorld2.x, clamp(centerWorld2.y, 0, wpt2.ws - 1), z2);

      view.zoom = z2;
      view.center = { lat: centerLL2.lat, lon: centerLL2.lon };

      if (is3d) { this._zoomAnchorSX = sx; this._zoomAnchorSY = sy; }
    }

    /** Once per redraw frame in 3D: shift the center so the ground point
     *  captured at the first zoom event of the frame is back under the cursor
     *  (terrain relief makes the flat per-event result approximate). */
    _applyZoomAnchor3d() {
      const view = this.view;
      const a = this._zoomAnchor3d;
      this._zoomAnchor3d = null;
      const gl = view.mapgl;
      if (!a || !gl || !gl.active || !gl.ready) return;
      const clamp = g.clamp;
      const latLonToWorld = g.latLonToWorld;
      const worldToLatLon = g.worldToLatLon;
      const sx = this._zoomAnchorSX, sy = this._zoomAnchorSY;
      const z = view.zoom;
      for (let i = 0; i < 2; i++) {
        const m = gl.unprojectScreen(sx, sy);
        if (!m) break;
        const A = latLonToWorld(a.lat, a.lon, z);
        const Q = latLonToWorld(m.lat, m.lon, z);
        const ex = A.x - Q.x, ey = A.y - Q.y;
        if (!isFinite(ex) || !isFinite(ey) || Math.hypot(ex, ey) < 0.5) break;
        const c = latLonToWorld(view.center.lat, view.center.lon, z);
        const nc = worldToLatLon(c.x + ex, clamp(c.y + ey, 0, c.ws - 1), z);
        view.center = { lat: nc.lat, lon: nc.lon };
      }
    }

    centerOn(lat, lon, { animate = true } = {}) {
      const view = this.view;
      const latN = Number(lat), lonN = Number(lon);
      if (!isFinite(latN) || !isFinite(lonN)) return;

      if (!animate) {
        view.center = { lat: latN, lon: lonN };
        view.draw(view.lastState);
        return;
      }

      // Animate center only (keep zoom)
      this._animateTo({ centerLat: latN, centerLon: lonN, zoom: view.zoom }, { durationMs: 220 });
    }

    cancelSelectionOrchestration() {
      const view = this.view;
      if (this._selectOrchRAF) cancelAnimationFrame(this._selectOrchRAF);
      this._selectOrchRAF = null;
      this._selectOrch = null;
      // Do not clear all warps; only clear the currently-selected one if we know it.
      // (Leaving others would be harmless but is confusing.)
      // Clear any expired warps opportunistically.
      const nowMs = performance.now();
      for (const [id, w] of view._traceSelectionWarpById.entries()) {
        const t = nowMs - Number(w?.t0Ms);
        const dur = Number(w?.durationMs);
        if (!isFinite(t) || !isFinite(dur) || t >= dur) view._traceSelectionWarpById.delete(id);
      }
    }

    _latLonComfortablyInView(lat, lon) {
      const view = this.view;
      const latLonToWorld = g.latLonToWorld;
      const latN = Number(lat);
      const lonN = Number(lon);
      if (!isFinite(latN) || !isFinite(lonN)) return false;
      const w = view._cssW || 1;
      const h = view._cssH || 1;
      const centerW = latLonToWorld(view.center.lat, view.center.lon, view.zoom);
      const tgtW = latLonToWorld(latN, lonN, view.zoom);
      const sx = tgtW.x - centerW.x + w / 2;
      const sy = tgtW.y - centerW.y + h / 2;
      // Comfortable inset region to avoid constant micro-panning.
      const mx = w * 0.22;
      const my = h * 0.22;
      return (sx >= mx && sx <= (w - mx) && sy >= my && sy <= (h - my));
    }

    _computeFocusedCenterFor(lat, lon) {
      const view = this.view;
      const clamp = g.clamp;
      const latLonToWorld = g.latLonToWorld;
      const worldToLatLon = g.worldToLatLon;
      // If the point is already well within the view, keep the current center.
      if (this._latLonComfortablyInView(lat, lon)) return { lat: view.center.lat, lon: view.center.lon, needsMove: false };

      const latN = Number(lat);
      const lonN = Number(lon);
      const w = view._cssW || 1;
      const h = view._cssH || 1;
      const centerW = latLonToWorld(view.center.lat, view.center.lon, view.zoom);
      const tgtW = latLonToWorld(latN, lonN, view.zoom);
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
      const ll = worldToLatLon(desiredCenterW.x, clamp(desiredCenterW.y, 0, centerW.ws - 1), view.zoom);
      return { lat: ll.lat, lon: ll.lon, needsMove: true };
    }

    orchestrateSelectionToLatest(mobile, { fitTrail = false } = {}) {
      const view = this.view;
      const clamp = g.clamp;
      const haversineMeters = g.haversineMeters;
      if (!mobile || !mobile.id) return;
      if (fitTrail) return; // handled by fitTrailBounds at call site
      if (view.playbackMode) return;

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
      if (view.traceMode && view._traceActiveRouteById.has(id)) {
        const smp = view._traceSampleForMobile(mobile, nowMs);
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
        view._traceSelectionWarpById.set(id, {
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
          if (!o.camFrom) o.camFrom = { lat: view.center.lat, lon: view.center.lon };
          const u = clamp((t - camStart) / Math.max(1, o.camDurMs), 0, 1);
          const ease = 1 - Math.pow(1 - u, 3);
          const lat = o.camFrom.lat + (o.camTo.lat - o.camFrom.lat) * ease;
          const lon = o.camFrom.lon + (o.camTo.lon - o.camFrom.lon) * ease;
          view.center = { lat, lon };
          view._invalidateOverlayStatic();
          view.draw(view.lastState);
          this._notifyViewChanged();
        } else if (o.camDurMs > 0 && t > camEnd && o.camFrom) {
          // Snap to final to avoid a tiny drift.
          view.center = { lat: o.camTo.lat, lon: o.camTo.lon };
          o.camDurMs = 0;
          view._invalidateOverlayStatic();
          view.draw(view.lastState);
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

    _hitTestMobileAtClientXY(clientX, clientY, nowMs) {
      const view = this.view;
      const latLonToWorld = g.latLonToWorld;
      const st = view.lastState;
      const mobiles = st && Array.isArray(st.mobile) ? st.mobile : [];
      const rect = this._overlayRect();
      const sx = clientX - rect.left;
      const sy = clientY - rect.top;

      const w = rect.width;
      const h = rect.height;
      const centerW = latLonToWorld(view.center.lat, view.center.lon, view.zoom);
      const worldToScreenFast = (wx, wy) => ({ x: wx - centerW.x + w / 2, y: wy - centerW.y + h / 2 });

      for (const m of mobiles) {
        const pose = view._mobilePoseForRender(m, nowMs);
        const lat = Number(pose?.lat);
        const lon = Number(pose?.lon);
        if (!isFinite(lat) || !isFinite(lon)) continue;
        const wpt = latLonToWorld(lat, lon, view.zoom);
        const sp = worldToScreenFast(wpt.x, wpt.y);
        const dx = sp.x - sx;
        const dy = sp.y - sy;
        if ((dx * dx + dy * dy) <= (20 * 20)) {
          return m;
        }
      }
      return null;
    }

    zoomBy(delta) {
      const view = this.view;
      const clamp = g.clamp;
      // User interaction: immediate zoom (no easing).
      const target = clamp(Math.round(view.zoom) + delta, view._zoomMin, view._zoomMax);
      view.zoom = target;
      // Invalidate snapshot when zoom jumps (prevents “tunnel” feel).
      view._tilesSnapshotCanvas = null;
      view._tilesSnapshotMeta = null;
      view.draw(view.lastState);
      this._notifyViewChanged();
    }

    onWheel(e) {
      const view = this.view;
      const clamp = g.clamp;
      const latLonToWorld = g.latLonToWorld;
      const worldToLatLon = g.worldToLatLon;
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
      const isMacMouseWheel = view._isMac && !this._wheelPanning && !e.ctrlKey && Math.abs(e.deltaX) < 1 && Math.abs(e.deltaY) >= 4;

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
        if (view._mouseDragging) return; // Don't zoom while user is panning
        if (this._wheelPanning) return;  // Don't zoom while user is trackpad-panning

        if (this._wheelPinchEndTimer) window.clearTimeout(this._wheelPinchEndTimer);
        if (this._pinchZoomEndTimer) { window.clearTimeout(this._pinchZoomEndTimer); this._pinchZoomEndTimer = null; }
        view._pinchZooming = true;

        const rect = this._overlayRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        this._pinchAnchorSX = sx;
        this._pinchAnchorSY = sy;

        const rawDy = clamp(e.deltaY, -300, 300);

        // Platform-specific mouse-wheel flags (separate code paths, not combined)
        const isWinWheel = view._isWindows && (isMouseWheel || isSmoothScrollZoom);

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
        const prevZ = view.zoom;
        const z2 = clamp(view.zoom + dz, view._zoomMin, view._zoomMax);
        this._setZoomAroundScreenPoint(z2, sx, sy);
        this._requestZoomRedraw();
        this._notifyViewChanged();
        this._notePinchVelocity(z2 - prevZ, performance.now());

        // Trackpad pinch needs inertia; mouse wheel doesn't
        if (!isMouseWheel && !isSmoothScrollZoom && !isMacMouseWheel) {
          this._wheelPinchEndTimer = window.setTimeout(() => this._startPinchInertia(), 28);
        } else {
          this._wheelPinchEndTimer = window.setTimeout(() => {
            view._pinchZooming = false;
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
      const c = latLonToWorld(view.center.lat, view.center.lon, view.zoom);
      const nx = c.x + e.deltaX * scale;
      const ny = clamp(c.y + e.deltaY * scale, 0, c.ws - 1);
      const ll = worldToLatLon(nx, ny, view.zoom);
      view.center = { lat: ll.lat, lon: ll.lon };
      if (!this._pinchInertiaRAF) this._requestPanRedraw();
    }

    /** Cursor as a world point plus a hit tolerance in world px (radiusPx
     *  screen px at the cursor). One unproject instead of one MapLibre
     *  project() per candidate in 3D; identical arithmetic in 2D. */
    _cursorWorldHit(sx, sy, radiusPx = 20) {
      const latLonToWorld = g.latLonToWorld;
      const cursorLL = this._screenPointToLatLon(sx, sy);
      const cursorW = latLonToWorld(cursorLL.lat, cursorLL.lon, this.view.zoom);
      const edgeLL = this._screenPointToLatLon(sx + radiusPx, sy);
      const edgeW = latLonToWorld(edgeLL.lat, edgeLL.lon, this.view.zoom);
      const tolSq = Math.max(radiusPx * radiusPx, (edgeW.x - cursorW.x) ** 2 + (edgeW.y - cursorW.y) ** 2);
      return { cursorW, tolSq };
    }

    _updateHoverAtClientXY(clientX, clientY) {
      const view = this.view;
      const latLonToWorld = g.latLonToWorld;
      const keyFor = g.keyFor;
      const parseKey = g.parseKey;
      const st = view.lastState;
      if (!st) return;
      const rect = this._overlayRect();
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
      const selParsed = parseKey(view.selectedId);
      const selMobileId = (selParsed && selParsed.type === "mobile") ? String(selParsed.id) : null;
      const allMobileCands = mobiles.map(m => ({ type: "mobile", ...m }));
      const topMobileCand = selMobileId ? allMobileCands.find(m => String(m.id) === selMobileId) : null;
      const otherMobileCands = selMobileId ? allMobileCands.filter(m => String(m.id) !== selMobileId) : [...allMobileCands];
      const candidates = [
        ...(topMobileCand ? [topMobileCand] : []),
        ...[...otherMobileCands].reverse(),
        ...[...fixed.filter(f => !f.purpleair)].reverse().map(f => ({ type: "fixed", ...f })),
      ];
      // Project the CURSOR into the world once and compare in world px,
      // instead of projecting every candidate to the screen. In 2D that is
      // the same arithmetic; in 3D worldToScreen was a terrain-aware
      // MapLibre project() per candidate (hundreds of fixed sensors) per
      // pointer event.
      const { cursorW, tolSq } = this._cursorWorldHit(sx, sy);
      for (const m of candidates) {
        let lat = Number(m.lat), lon = Number(m.lon);
        if (m.type === "mobile") {
          const pose = view._mobilePoseForRender(m, performance.now());
          lat = pose.lat;
          lon = pose.lon;
        }
        if (m.type === "fixed" && view._fixedGeoOffsets) {
          const fKey = m._key || keyFor("fixed", m.id);
          const geo = view._fixedGeoOffsets.get(fKey);
          if (geo) { lat += geo.dlat; lon += geo.dlon; }
        }
        if (!isFinite(lat) || !isFinite(lon)) continue;
        const wpt = latLonToWorld(lat, lon, view.zoom);
        const dx = wpt.x - cursorW.x;
        const dy = wpt.y - cursorW.y;
        if ((dx*dx + dy*dy) <= tolSq) {
          hit = keyFor(m.type, m.id);
          break;
        }
      }

      // Update pointer cursor for marker hover
      view.overlayCanvas.style.cursor = hit ? "pointer" : "";

      // Suppress hover labels while a marker is selected
      if (view.selectedId) {
        this._clearHover();
        return;
      }

      if (hit) {
        // Clear hide timer if re-entering same or new marker
        if (this._hoverHideTimer) { clearTimeout(this._hoverHideTimer); this._hoverHideTimer = null; }
        if (view._hoveredId === hit) return; // already showing this one
        // Clear previous show timer
        if (this._hoverShowTimer) { clearTimeout(this._hoverShowTimer); this._hoverShowTimer = null; }
        this._hoverShowTimer = setTimeout(() => {
          this._hoverShowTimer = null;
          view._hoveredId = hit;
          view._invalidateOverlayStatic();
          view.drawOverlay(view.lastState);
        }, 333);
      } else {
        // Not over any marker — schedule hide
        if (this._hoverShowTimer) { clearTimeout(this._hoverShowTimer); this._hoverShowTimer = null; }
        this._scheduleHoverHide();
      }
    }

    _scheduleHoverHide() {
      const view = this.view;
      if (!view._hoveredId) return;
      if (this._hoverHideTimer) return; // already scheduled
      this._hoverHideTimer = setTimeout(() => {
        this._hoverHideTimer = null;
        view._hoveredId = null;
        view._invalidateOverlayStatic();
        view.drawOverlay(view.lastState);
      }, 333);
    }

    _clearHover() {
      const view = this.view;
      if (this._hoverShowTimer) { clearTimeout(this._hoverShowTimer); this._hoverShowTimer = null; }
      if (this._hoverHideTimer) { clearTimeout(this._hoverHideTimer); this._hoverHideTimer = null; }
      if (view._hoveredId) {
        view._hoveredId = null;
        view._invalidateOverlayStatic();
        view.drawOverlay(view.lastState);
      }
    }

    onClick(e) {
      const view = this.view;
      const latLonToWorld = g.latLonToWorld;
      const keyFor = g.keyFor;
      const parseKey = g.parseKey;
      // Click empty map to deselect
      const st = view.lastState;
      const mobiles = st && Array.isArray(st.mobile) ? st.mobile : [];
      const fixed = st && Array.isArray(st.fixed) ? st.fixed : [];
      const rect = this._overlayRect();
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
      const selParsed = parseKey(view.selectedId);
      const selMobileId = (selParsed && selParsed.type === "mobile") ? String(selParsed.id) : null;
      const allMobileCands = mobiles.map(m => ({ type: "mobile", ...m }));
      const topMobileCand = selMobileId ? allMobileCands.find(m => String(m.id) === selMobileId) : null;
      const otherMobileCands = selMobileId ? allMobileCands.filter(m => String(m.id) !== selMobileId) : [...allMobileCands];
      const candidates = [
        ...(topMobileCand ? [topMobileCand] : []),
        ...[...otherMobileCands].reverse(),
        ...[...fixed.filter(f => !f.purpleair)].reverse().map(f => ({ type: "fixed", ...f })),
        ...(view._paFieldPollutant == null || view._paFieldPollutant === "pm25" ? [...fixed.filter(f => f.purpleair)].reverse().map(f => ({ type: "fixed", ...f })) : []),
      ];
      const _clickRefMs = view._historicalMode ? (view.getPlaybackTimeMs() || view._dataNowMs()) : Date.now();
      const _PA_FADE_MS = 45 * 60 * 1000;
      const { cursorW: _hitW, tolSq: _hitTolSq } = this._cursorWorldHit(sx, sy, 20);
      for (const m of candidates) {
        // Skip fully-faded PurpleAir sensors
        if (m.purpleair) {
          const sMs = m.last_seen ? m.last_seen * 1000 : null;
          if (!sMs || (_clickRefMs - sMs) >= _PA_FADE_MS) continue;
        }
        let lat = Number(m.lat), lon = Number(m.lon);
        if (m.type === "mobile") {
          const pose = view._mobilePoseForRender(m, performance.now());
          lat = pose.lat;
          lon = pose.lon;
        }
        if (m.type === "fixed" && view._fixedGeoOffsets) {
          const fKey = m._key || keyFor("fixed", m.id);
          const geo = view._fixedGeoOffsets.get(fKey);
          if (geo) { lat += geo.dlat; lon += geo.dlon; }
        }
        if (!isFinite(lat) || !isFinite(lon)) continue;
        const wpt = latLonToWorld(lat, lon, view.zoom);
        const dx = wpt.x - _hitW.x;
        const dy = wpt.y - _hitW.y;
        if ((dx*dx + dy*dy) <= _hitTolSq) {
          hit = keyFor(m.type, m.id);
          break;
        }
      }
      if (hit) {
        if (window.__selectSensor) window.__selectSensor(hit, { fitTrail: !!e.metaKey });
        return;
      }

      view.setSelected(null);
      if (window.__selectSensor) window.__selectSensor(null);
    }

    _handleTapSelection(sx, sy) {
      const view = this.view;
      const latLonToWorld = g.latLonToWorld;
      const keyFor = g.keyFor;
      const parseKey = g.parseKey;
      // Handle tap on touch devices - same hit testing as onClick
      const st = view.lastState;
      const mobiles = st && Array.isArray(st.mobile) ? st.mobile : [];
      const fixed = st && Array.isArray(st.fixed) ? st.fixed : [];

      // Search in reverse render order so the topmost (last-drawn) marker wins.
      // Render order (bottom→top): PurpleAir fixed → other fixed → non-selected mobiles → selected mobile.
      let hit = null;
      const tapSelParsed = parseKey(view.selectedId);
      const tapSelMobileId = (tapSelParsed && tapSelParsed.type === "mobile") ? String(tapSelParsed.id) : null;
      const tapAllMobileCands = mobiles.map(m => ({ type: "mobile", ...m }));
      const tapTopMobileCand = tapSelMobileId ? tapAllMobileCands.find(m => String(m.id) === tapSelMobileId) : null;
      const tapOtherMobileCands = tapSelMobileId ? tapAllMobileCands.filter(m => String(m.id) !== tapSelMobileId) : [...tapAllMobileCands];
      const candidates = [
        ...(tapTopMobileCand ? [tapTopMobileCand] : []),
        ...[...tapOtherMobileCands].reverse(),
        ...[...fixed.filter(f => !f.purpleair)].reverse().map(f => ({ type: "fixed", ...f })),
        ...(view._paFieldPollutant == null || view._paFieldPollutant === "pm25" ? [...fixed.filter(f => f.purpleair)].reverse().map(f => ({ type: "fixed", ...f })) : []),
      ];
      const _tapRefMs = view._historicalMode ? (view.getPlaybackTimeMs() || view._dataNowMs()) : Date.now();
      const _TAP_PA_FADE_MS = 45 * 60 * 1000;
      const { cursorW: _hitW, tolSq: _hitTolSq } = this._cursorWorldHit(sx, sy, 35);
      for (const m of candidates) {
        // Skip fully-faded PurpleAir sensors
        if (m.purpleair) {
          const sMs = m.last_seen ? m.last_seen * 1000 : null;
          if (!sMs || (_tapRefMs - sMs) >= _TAP_PA_FADE_MS) continue;
        }
        let lat = Number(m.lat), lon = Number(m.lon);
        if (m.type === "mobile") {
          const pose = view._mobilePoseForRender(m, performance.now());
          lat = pose.lat;
          lon = pose.lon;
        }
        if (m.type === "fixed" && view._fixedGeoOffsets) {
          const fKey = m._key || keyFor("fixed", m.id);
          const geo = view._fixedGeoOffsets.get(fKey);
          if (geo) { lat += geo.dlat; lon += geo.dlon; }
        }
        if (!isFinite(lat) || !isFinite(lon)) continue;
        const wpt = latLonToWorld(lat, lon, view.zoom);
        const dx = wpt.x - _hitW.x;
        const dy = wpt.y - _hitW.y;
        if ((dx*dx + dy*dy) <= _hitTolSq) { // Large hit area for iOS touch accuracy
          hit = keyFor(m.type, m.id);
          break;
        }
      }
      if (hit) {
        if (window.__selectSensor) window.__selectSensor(hit, { fitTrail: false });
        return;
      }

      view.setSelected(null);
      if (window.__selectSensor) window.__selectSensor(null);
    }
  }

  return CameraGestures;
});
