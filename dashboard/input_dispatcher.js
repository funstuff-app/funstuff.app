(function (root, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else {
    root.InputDispatcher = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /**
   * InputDispatcher — DOM event handling, gesture state machines, pinch inertia,
   * and platform-aware input classification for the map canvas.
   *
   * Extracted from MapView. Communicates back through a `host` reference that must
   * implement the interface documented below.
   *
   * Host interface (MapView):
   *   Properties (read/write):
   *     host.center           — {lat, lon}
   *     host.zoom             — number
   *     host._pbDrag          — object|null  (DVR marker-drag state)
   *     host._playbackLiveFollow — boolean
   *   Properties (read):
   *     host._zoomMin, host._zoomMax — number
   *     host.overlayCanvas    — HTMLCanvasElement
   *     host.lastState        — object|null
   *     host.playbackMode     — boolean
   *   Methods:
   *     host._setZoomAroundScreenPoint(z, sx, sy)
   *     host._screenPointToLatLon(sx, sy) → {lat, lon}
   *     host._tileRenderer.invalidateSnapshot()
   *     host._tileRenderer.flushPendingRedraw()
   *     host._noteUserInteraction()
   *     host._notifyViewChanged()
   *     host._redrawViewOnly()
   *     host.draw(state)
   *     host.drawOverlay(state)
   *     host._handleTapSelection(sx, sy)
   *     host._closestPlaybackPathPointForMobileAtClientXY(m, cx, cy)
   *     host._startPbMarkerInertiaFromDrag(drag)
   *     host.setPlaybackTimeMs(ms)
   *     host.getPlaybackBounds() → {minMs, maxMs}
   *     host.setPlaybackPlaying(bool)
   *     host._resetLiveTracking()
   *
   * Globals required (loaded earlier in script order):
   *   latLonToWorld, worldToLatLon, clamp — from projections.js
   */
  class InputDispatcher {
    constructor(overlayCanvas, host) {
      this.canvas = overlayCanvas;
      this.host = host;

      // Platform detection
      this._isWindows = /Win/.test(navigator.platform || navigator.userAgent);
      this._isMac = /Mac/.test(navigator.platform || navigator.userAgent);

      // Touch state
      this._touchState = null;
      this._touchActive = false;

      // Safari gesture state
      this._gesture = null;

      // Mouse drag state
      this._mouseDragging = false;
      this._mouseDragStart = null;
      this._mouseDragCenterStart = null;
      this._mouseDragMoved = false;

      // Pinch/zoom state
      this._pinchZooming = false;
      this._pinchAnchorSX = null;
      this._pinchAnchorSY = null;
      this._pinchInertiaRAF = null;
      this._pinchVz = 0;
      this._pinchVelTs = 0;

      // Wheel state
      this._wheelPinchEndTimer = null;
      this._wheelPanning = false;
      this._wheelPanEndTimer = null;
      this._lastWheelPanTime = 0;

      // RAF coalescing
      this._zoomDrawRAF = null;
      this._panDrawRAF = null;

      // Bind events
      this.canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
      this.canvas.addEventListener("gesturestart", (e) => this.onGestureStart(e), { passive: false });
      this.canvas.addEventListener("gesturechange", (e) => this.onGestureChange(e), { passive: false });
      this.canvas.addEventListener("gestureend", (e) => this.onGestureEnd(e), { passive: false });
      this.canvas.addEventListener("click", (e) => this.host.onClick(e));
      this.canvas.addEventListener("mousedown", (e) => this.onMouseDown(e));
      this._onMouseMove = (e) => this.onMouseMove(e);
      this._onMouseUp = () => this.onMouseUp();
      window.addEventListener("mousemove", this._onMouseMove);
      window.addEventListener("mouseup", this._onMouseUp);
      this.canvas.addEventListener("touchstart", (e) => this.onTouchStart(e), { passive: false });
      this.canvas.addEventListener("touchmove", (e) => this.onTouchMove(e), { passive: false });
      this.canvas.addEventListener("touchend", (e) => this.onTouchEnd(e), { passive: false });
      this.canvas.addEventListener("touchcancel", (e) => this.onTouchEnd(e), { passive: false });
    }

    // ── Getters for MapView to read input state ──────────────────────────

    get touchActive() { return this._touchActive; }
    get pinchZooming() { return this._pinchZooming; }
    get mouseDragging() { return this._mouseDragging; }
    get mouseDragMoved() { return this._mouseDragMoved; }
    set mouseDragMoved(v) { this._mouseDragMoved = v; }

    // ── Helpers ──────────────────────────────────────────────────────────

    _eventToLocalXY(e) {
      const rect = this.canvas.getBoundingClientRect();
      const cx = (typeof e.clientX === "number") ? e.clientX : (rect.left + rect.width / 2);
      const cy = (typeof e.clientY === "number") ? e.clientY : (rect.top + rect.height / 2);
      return { sx: cx - rect.left, sy: cy - rect.top };
    }

    // ── Pinch inertia ────────────────────────────────────────────────────

    stopPinchInertia() {
      if (this._pinchInertiaRAF) cancelAnimationFrame(this._pinchInertiaRAF);
      this._pinchInertiaRAF = null;
      this._wheelPinchEndTimer = null;
      this._pinchVz = 0;
      this._pinchVelTs = 0;
    }

    _notePinchVelocity(dz, now) {
      const t = (typeof now === "number" && isFinite(now)) ? now : performance.now();
      const dt = (this._pinchVelTs > 0) ? (t - this._pinchVelTs) : 0;
      if (dt > 4 && dt < 120) {
        const v = dz / dt;
        this._pinchVz = (this._pinchVz * 0.65) + (v * 0.35);
      }
      this._pinchVelTs = t;
    }

    _startPinchInertia() {
      if (!isFinite(this._pinchVz) || Math.abs(this._pinchVz) < 0.00005 || !isFinite(this._pinchAnchorSX) || !isFinite(this._pinchAnchorSY)) {
        this._pinchZooming = false;
        this._requestZoomRedraw();
        return;
      }

      const h = this.host;
      let last = performance.now();
      const step = () => {
        const now = performance.now();
        const dt = now - last;
        last = now;

        const z2 = clamp(h.zoom + this._pinchVz * dt, h._zoomMin, h._zoomMax);
        h._setZoomAroundScreenPoint(z2, this._pinchAnchorSX, this._pinchAnchorSY);
        h._tileRenderer.invalidateSnapshot();
        this._requestZoomRedraw();
        h._notifyViewChanged();

        this._pinchVz *= 0.90;
        if (Math.abs(this._pinchVz) < 0.00005 || z2 === h._zoomMin || z2 === h._zoomMax) {
          this._pinchInertiaRAF = null;
          this._pinchZooming = false;
          this._requestZoomRedraw();
          return;
        }
        this._pinchInertiaRAF = requestAnimationFrame(step);
      };
      last = performance.now() - 16;
      step();
    }

    // ── Redraw coalescing ────────────────────────────────────────────────

    _requestZoomRedraw() {
      if (this._zoomDrawRAF) return;
      this._zoomDrawRAF = requestAnimationFrame(() => {
        this._zoomDrawRAF = null;
        this.host.draw(this.host.lastState);
      });
    }

    _requestPanRedraw() {
      if (this._panDrawRAF) return;
      this._panDrawRAF = requestAnimationFrame(() => {
        this._panDrawRAF = null;
        this.host._redrawViewOnly();
        this.host._notifyViewChanged();
      });
    }

    // ── Safari gesture events ────────────────────────────────────────────

    onGestureStart(e) {
      e.preventDefault();
      e.stopPropagation();
      this.host._noteUserInteraction();
      this.stopPinchInertia();
      this._pinchZooming = true;
      const { sx, sy } = this._eventToLocalXY(e);
      const ll = this.host._screenPointToLatLon(sx, sy);
      this._gesture = {
        startZoom: this.host.zoom,
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
      this.host._noteUserInteraction();
      this._pinchZooming = true;
      const { sx, sy } = this._eventToLocalXY(e);
      this._gesture.sx = sx;
      this._gesture.sy = sy;

      const h = this.host;
      const scale = (typeof e.scale === "number" && isFinite(e.scale) && e.scale > 0) ? e.scale : 1;
      const ratio = Math.max(0.2, Math.min(5, scale / (this._gesture.startScale || 1)));
      const dz = Math.log2(ratio);
      const z2 = clamp(this._gesture.startZoom + dz, h._zoomMin, h._zoomMax);
      const prevZ = h.zoom;
      h._setZoomAroundScreenPoint(z2, sx, sy);
      this._requestZoomRedraw();
      h._notifyViewChanged();
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

    // ── Touch events ─────────────────────────────────────────────────────

    onTouchStart(e) {
      e.preventDefault();
      this._touchActive = true;
      this.host._noteUserInteraction();
      this.stopPinchInertia();

      const touches = e.touches;
      if (touches.length === 0) return;

      const rect = this.canvas.getBoundingClientRect();

      let sumX = 0, sumY = 0;
      for (let i = 0; i < touches.length; i++) {
        sumX += touches[i].clientX - rect.left;
        sumY += touches[i].clientY - rect.top;
      }
      const midX = sumX / touches.length;
      const midY = sumY / touches.length;

      // Dead zone: ignore pinch-zoom attempts where any finger starts in the
      // bottom 130px of the canvas (playback bar area).
      if (touches.length >= 2) {
        const canvasH = rect.height;
        const deadZonePx = 130;
        for (let i = 0; i < touches.length; i++) {
          const ty = touches[i].clientY - rect.top;
          if (ty > canvasH - deadZonePx) {
            this._touchActive = false;
            return;
          }
        }
      }

      let pinchDist = 0;
      if (touches.length >= 2) {
        const dx = touches[0].clientX - touches[1].clientX;
        const dy = touches[0].clientY - touches[1].clientY;
        pinchDist = Math.sqrt(dx * dx + dy * dy);
        this._pinchZooming = true;
      }

      const h = this.host;
      const cw = latLonToWorld(h.center.lat, h.center.lon, h.zoom);
      this._touchState = {
        startTouches: touches.length,
        startMidpoint: { x: midX, y: midY },
        startCenterWorld: { x: cw.x, y: cw.y, ws: cw.ws },
        startZoom: h.zoom,
        lastPinchDist: pinchDist,
        lastMidpoint: { x: midX, y: midY },
        tapCandidate: touches.length === 1,
        tapStartTime: performance.now(),
        tapStartPos: { x: midX, y: midY },
      };

      this._pinchAnchorSX = midX;
      this._pinchAnchorSY = midY;
    }

    onTouchMove(e) {
      if (!this._touchState) return;
      e.preventDefault();
      this.host._noteUserInteraction();

      const touches = e.touches;
      if (touches.length === 0) return;

      const rect = this.canvas.getBoundingClientRect();
      let sumX = 0, sumY = 0;
      for (let i = 0; i < touches.length; i++) {
        sumX += touches[i].clientX - rect.left;
        sumY += touches[i].clientY - rect.top;
      }
      const midX = sumX / touches.length;
      const midY = sumY / touches.length;

      const h = this.host;

      // Pinch-zoom if 2+ fingers
      if (touches.length >= 2) {
        this._pinchZooming = true;
        const dx = touches[0].clientX - touches[1].clientX;
        const dy = touches[0].clientY - touches[1].clientY;
        const pinchDist = Math.sqrt(dx * dx + dy * dy);

        if (this._touchState.lastPinchDist > 0 && pinchDist > 0) {
          const scale = pinchDist / this._touchState.lastPinchDist;
          const dz = Math.log2(scale);
          const prevZ = h.zoom;
          const z2 = clamp(h.zoom + dz, h._zoomMin, h._zoomMax);
          h._setZoomAroundScreenPoint(z2, midX, midY);
          this._notePinchVelocity(z2 - prevZ, performance.now());
        }
        this._touchState.lastPinchDist = pinchDist;
      }

      // Pan
      const dmx = midX - this._touchState.lastMidpoint.x;
      const dmy = midY - this._touchState.lastMidpoint.y;

      if (Math.abs(dmx) > 0.5 || Math.abs(dmy) > 0.5) {
        const c = latLonToWorld(h.center.lat, h.center.lon, h.zoom);
        const nx = c.x - dmx;
        const ny = clamp(c.y - dmy, 0, c.ws - 1);
        const ll = worldToLatLon(nx, ny, h.zoom);
        h.center = { lat: ll.lat, lon: ll.lon };
      }

      // Invalidate tap if moved too far
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

      this._requestPanRedraw();
    }

    onTouchEnd(e) {
      if (!this._touchState) return;
      e.preventDefault();

      const remaining = e.touches.length;

      if (remaining === 0) {
        const wasTap = this._touchState.tapCandidate &&
          this._touchState.startTouches === 1 &&
          (performance.now() - this._touchState.tapStartTime) < 300;
        const tapPos = this._touchState.tapStartPos;

        this._touchActive = false;
        this.host._tileRenderer.flushPendingRedraw();

        if (this._pinchZooming && !this._pinchInertiaRAF) {
          this._startPinchInertia();
        } else if (!this._pinchZooming) {
          this._requestZoomRedraw();
        }

        if (wasTap && tapPos) {
          this.host._handleTapSelection(tapPos.x, tapPos.y);
        }

        this._touchState = null;
      } else if (remaining === 1 && this._touchState.startTouches >= 2) {
        const rect = this.canvas.getBoundingClientRect();
        const t = e.touches[0];
        const mx = t.clientX - rect.left;
        const my = t.clientY - rect.top;
        this._touchState.lastMidpoint = { x: mx, y: my };
        this._touchState.lastPinchDist = 0;
        this._touchState.startTouches = 1;
        this._pinchZooming = false;
        this.stopPinchInertia();
        this._requestZoomRedraw();
      }
    }

    // ── Mouse events ─────────────────────────────────────────────────────

    onMouseDown(e) {
      if (e.button !== 0) return;

      // DVR marker drag — currently disabled (commented out in MapView).
      // If host._pbDrag were set by external code, this path would handle it.

      this.host._noteUserInteraction();
      this.stopPinchInertia();
      this._pinchZooming = false;
      this._mouseDragging = true;
      this._mouseDragMoved = false;
      this._mouseDragStart = { x: e.clientX, y: e.clientY };
      const h = this.host;
      const cw = latLonToWorld(h.center.lat, h.center.lon, h.zoom);
      this._mouseDragCenterStart = { x: cw.x, y: cw.y, ws: cw.ws };
    }

    onMouseMove(e) {
      // DVR marker scrubbing (active when host._pbDrag is set)
      const h = this.host;
      if (h._pbDrag && h.playbackMode) {
        const nowMs = performance.now();
        const dx = e.clientX - (h._pbDrag.lastClient?.x ?? e.clientX);
        const dy = e.clientY - (h._pbDrag.lastClient?.y ?? e.clientY);
        if (Math.abs(dx) + Math.abs(dy) > 2) this._mouseDragMoved = true;

        const lastMoveMs = (h._pbDrag.lastMoveMs != null && isFinite(h._pbDrag.lastMoveMs)) ? h._pbDrag.lastMoveMs : nowMs;
        const dtMs = Math.max(1, nowMs - lastMoveMs);
        const vx = dx / dtMs;
        const vy = dy / dtMs;
        const prevV = h._pbDrag.vel || { x: 0, y: 0 };
        const a = 0.25;
        h._pbDrag.vel = {
          x: prevV.x * (1 - a) + vx * a,
          y: prevV.y * (1 - a) + vy * a,
        };
        h._pbDrag.lastMoveMs = nowMs;

        h._pbDrag.lastClient = { x: e.clientX, y: e.clientY };
        h._pbDrag.cursorClient = { x: e.clientX, y: e.clientY };
        const st = h.lastState;
        const mobiles = st && Array.isArray(st.mobile) ? st.mobile : [];
        const m = mobiles.find(mm => (mm && mm.id != null && String(mm.id) === String(h._pbDrag.id))) || null;
        if (m) {
          const closest = h._closestPlaybackPathPointForMobileAtClientXY(m, e.clientX, e.clientY);
          if (closest && isFinite(closest.tMs)) {
            const bounds = h.getPlaybackBounds();
            const tMs = closest.tMs;
            if (isFinite(bounds.minMs) && isFinite(bounds.maxMs)) {
              const clamped = clamp(tMs, bounds.minMs, bounds.maxMs);
              h.setPlaybackTimeMs(clamped);
              h._playbackLiveFollow = false;
              if (typeof h._resetLiveTracking === "function") h._resetLiveTracking();
            } else {
              h.setPlaybackTimeMs(tMs);
              h._playbackLiveFollow = false;
              if (typeof h._resetLiveTracking === "function") h._resetLiveTracking();
            }
          }
          h.drawOverlay(h.lastState);
        }
        return;
      }

      if (!this._mouseDragging || !this._mouseDragStart || !this._mouseDragCenterStart) return;
      h._noteUserInteraction();
      const dx = e.clientX - this._mouseDragStart.x;
      const dy = e.clientY - this._mouseDragStart.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) this._mouseDragMoved = true;

      const centerX = this._mouseDragCenterStart.x - dx;
      const centerY = clamp(this._mouseDragCenterStart.y - dy, 0, this._mouseDragCenterStart.ws - 1);
      const ll = worldToLatLon(centerX, centerY, h.zoom);
      h.center = { lat: ll.lat, lon: ll.lon };
      if (!this._pinchInertiaRAF) this._requestPanRedraw();
    }

    onMouseUp() {
      const h = this.host;
      if (h._pbDrag) {
        const drag = h._pbDrag;
        h._pbDrag = null;
        try { h._startPbMarkerInertiaFromDrag(drag); } catch {}
        h.setPlaybackPlaying(true);
        if (typeof window.__ensurePlaybackLoop === "function") window.__ensurePlaybackLoop();
        return;
      }
      this._mouseDragging = false;
      this._mouseDragStart = null;
      this._mouseDragCenterStart = null;
      h._redrawViewOnly();
    }

    // ── Wheel event ──────────────────────────────────────────────────────

    onWheel(e) {
      e.preventDefault();
      this.host._noteUserInteraction();

      const isMouseWheel = e.deltaMode !== 0;
      const isSmoothScrollZoom = !e.ctrlKey && Math.abs(e.deltaX) < 1 && Math.abs(e.deltaY) >= 4;

      let shouldZoom = isMouseWheel || e.ctrlKey || isSmoothScrollZoom;

      // Debounce pan→zoom transitions from trackpad finger-lift artifacts
      if (shouldZoom && !isMouseWheel && this._lastWheelPanTime
          && (performance.now() - this._lastWheelPanTime) < 100) {
        shouldZoom = false;
      }

      if (shouldZoom) {
        if (this._gesture) return;
        if (this._mouseDragging) return;

        if (this._wheelPinchEndTimer) window.clearTimeout(this._wheelPinchEndTimer);
        this._pinchZooming = true;

        const rect = this.canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        this._pinchAnchorSX = sx;
        this._pinchAnchorSY = sy;

        const h = this.host;
        const rawDy = clamp(e.deltaY, -300, 300);
        const dy = (isMouseWheel || isSmoothScrollZoom) ? -rawDy : rawDy;
        const dir = dy < 0 ? 1 : -1;
        const isChromePinch = e.ctrlKey && !isMouseWheel && /Chrome/.test(navigator.userAgent || "");
        const strength = (isMouseWheel || isSmoothScrollZoom) ? 0.018 : isChromePinch ? 0.055 : 0.020;
        const dz = dir * Math.log1p(Math.abs(dy)) * strength;
        const prevZ = h.zoom;
        const z2 = clamp(h.zoom + dz, h._zoomMin, h._zoomMax);
        h._setZoomAroundScreenPoint(z2, sx, sy);
        this._requestZoomRedraw();
        h._notifyViewChanged();
        this._notePinchVelocity(z2 - prevZ, performance.now());

        if (!isMouseWheel && !isSmoothScrollZoom) {
          this._wheelPinchEndTimer = window.setTimeout(() => this._startPinchInertia(), 28);
        } else {
          this._wheelPinchEndTimer = window.setTimeout(() => {
            this._pinchZooming = false;
            this._requestZoomRedraw();
          }, 150);
        }
        return;
      }

      // Trackpad two-finger pan
      this._lastWheelPanTime = performance.now();
      if (!this._wheelPanning) {
        this._wheelPanning = true;
      }
      if (this._wheelPanEndTimer) window.clearTimeout(this._wheelPanEndTimer);
      this._wheelPanEndTimer = window.setTimeout(() => {
        this._wheelPanning = false;
        this._wheelPanEndTimer = null;
        this.host._redrawViewOnly();
      }, 120);
      const h = this.host;
      const scale = 0.65;
      const c = latLonToWorld(h.center.lat, h.center.lon, h.zoom);
      const nx = c.x + e.deltaX * scale;
      const ny = clamp(c.y + e.deltaY * scale, 0, c.ws - 1);
      const ll = worldToLatLon(nx, ny, h.zoom);
      h.center = { lat: ll.lat, lon: ll.lon };
      if (!this._pinchInertiaRAF) this._requestPanRedraw();
    }
  }

  return InputDispatcher;
});
