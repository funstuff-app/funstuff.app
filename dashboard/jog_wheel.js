/* ═══════════════════════════════════════════════════════════════════════════════
 *  JOG WHEEL — Canvas-rendered barrel scrubber with toroidal normal mapping.
 *
 *  Exported as window.JogWheel. Manages its own canvas rendering + input
 *  handling. The host (app.js) provides callbacks for position changes and
 *  reads the current state for timeline sync.
 *
 *  Usage:
 *    const jw = JogWheel.create({
 *      wrapEl, clipEl, canvasEl,
 *      onPositionChange(deltaFraction),   // called during drag/wheel
 *      onDragStart(),                     // pointer down
 *      onDragEnd(velocity),               // pointer up — velocity for inertia
 *    });
 *    jw.setPosition(0..1);               // external sync (playback loop)
 *    jw.render();                         // call from rAF
 *    jw.destroy();                        // cleanup
 * ═══════════════════════════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  /* ── Geometry constants ─────────────────────────────────────────────────── */
  const MAJOR_R       = 6.0;
  const MINOR_R       = 0.42;
  const GROOVE_DEPTH  = 0.06;
  const NORMAL_STR    = 1.4;
  const GROOVE_SPACING = 0.14;
  const BARREL_ROTATIONS = 10;

  /* ── Groove profile: sprocket-tooth trapezoid ───────────────────────────── */
  function grooveProfile(u) {
    const wallW = 0.07;
    const ls = 0.38, le = ls + wallW;     // 0.45
    const rs = 0.55, re = rs + wallW;     // 0.62
    let depth, ddepth;
    if (u < ls) {
      depth = 0; ddepth = 0;
    } else if (u < le) {
      const t = (u - ls) / wallW;
      depth = t * t * (3 - 2 * t);
      ddepth = 6 * t * (1 - t) / wallW;
    } else if (u < rs) {
      depth = 1; ddepth = 0;
    } else if (u < re) {
      const t = (u - rs) / wallW;
      depth = 1 - t * t * (3 - 2 * t);
      ddepth = -6 * t * (1 - t) / wallW;
    } else {
      depth = 0; ddepth = 0;
    }
    return { depth, ddepth };
  }

  /* ── Barrel renderer ────────────────────────────────────────────────────── */
  function renderBarrel(ctx, clipEl, position, lightX) {
    const elW = clipEl.offsetWidth;
    const elH = clipEl.offsetHeight;
    if (elW < 10 || elH < 5) return;

    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(elW * dpr);
    const H = Math.round(elH * dpr);
    const canvas = ctx.canvas;

    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
      canvas.style.width  = elW + "px";
      canvas.style.height = elH + "px";
    }

    const imageData = ctx.createImageData(W, H);
    const data = imageData.data;
    const barrelAngle = -position * BARREL_ROTATIONS * 2 * Math.PI;

    // Light direction
    const lx = lightX * 1.2;
    const ly = 0.55;
    const lz = 0.65;
    const lLen = Math.sqrt(lx * lx + ly * ly + lz * lz);
    const Lx = lx / lLen, Ly = ly / lLen, Lz = lz / lLen;

    const barrelHalfH = H * 0.5;
    const cy = H * 0.5;
    const centerR = MAJOR_R + MINOR_R;

    for (let y = 0; y < H; y++) {
      const yNormGlobal = (y - cy) / barrelHalfH;
      if (yNormGlobal < -1.15 || yNormGlobal > 1.15) {
        for (let x = 0; x < W; x++) {
          const idx = (y * W + x) * 4;
          data[idx] = 2; data[idx + 1] = 4; data[idx + 2] = 6; data[idx + 3] = 255;
        }
        continue;
      }

      const yNC = Math.max(-0.999, Math.min(0.999, yNormGlobal));
      const phi = Math.asin(-yNC);
      const cosPhi = Math.cos(phi);
      const sinPhi = Math.sin(phi);
      const hRadius = MAJOR_R + MINOR_R * cosPhi;

      const yClip = y / (H - 1);
      const topOcc = yClip < 0.10 ? (1 - yClip / 0.10) * 0.65 : 0;
      const botOcc = yClip > 0.85 ? ((yClip - 0.85) / 0.15) * 0.50 : 0;
      const occlusion = 1 - topOcc - botOcc;

      for (let x = 0; x < W; x++) {
        const screenX = (x / (W - 1)) * 2 - 1;
        const sinT = screenX;
        if (sinT < -0.998 || sinT > 0.998) continue;
        const cosT = Math.sqrt(1 - sinT * sinT);

        const sinT_actual = screenX * centerR / hRadius;
        if (sinT_actual < -1.0 || sinT_actual > 1.0) {
          const idx = (y * W + x) * 4;
          data[idx] = 2; data[idx + 1] = 4; data[idx + 2] = 6; data[idx + 3] = 255;
          continue;
        }
        const cosT_actual = Math.sqrt(1 - sinT_actual * sinT_actual);

        const toroidAngle = Math.asin(sinT_actual) + barrelAngle;
        const rawPhase = ((toroidAngle / GROOVE_SPACING) % 1 + 1) % 1;
        const gp = grooveProfile(rawPhase);

        const effR = MINOR_R - gp.depth * GROOVE_DEPTH;
        const colHalfH = effR / MINOR_R * barrelHalfH;
        const yNormLocal = (y - cy) / colHalfH;
        if (yNormLocal < -1.0 || yNormLocal > 1.0) {
          const idx = (y * W + x) * 4;
          data[idx] = 2; data[idx + 1] = 4; data[idx + 2] = 6; data[idx + 3] = 255;
          continue;
        }

        const tilt = gp.ddepth * GROOVE_DEPTH * NORMAL_STR / GROOVE_SPACING;
        let nx = sinT_actual * cosPhi - tilt * cosPhi * cosT_actual;
        let ny = sinPhi;
        let nz = cosT_actual * cosPhi + tilt * cosPhi * sinT_actual;
        const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nx /= nLen; ny /= nLen; nz /= nLen;

        const NdL = nx * Lx + ny * Ly + nz * Lz;
        const diffuse = NdL > 0 ? NdL : 0;

        const rz = 2 * NdL * nz - Lz;
        const sp = rz > 0 ? rz : 0;
        const sp2 = sp * sp; const sp4 = sp2 * sp2;
        const sp8 = sp4 * sp4;
        const specular = sp8 * sp4;

        const L_tan = Lx * cosT_actual - Lz * sinT_actual;
        const valleyShadow = gp.depth * Math.min(1, Math.abs(L_tan) * 3.5) * 0.7;
        const aoValley = Math.max(0, 1 - gp.depth * 0.20 - valleyShadow);

        const hFalloff = 0.18 + 0.82 * cosT * cosT;

        const ambient = 0.14;
        let brightness = (ambient + diffuse * 0.70) * occlusion * aoValley * hFalloff;
        if (brightness < 0) brightness = 0;

        let r = 6  + brightness * 58;
        let g = 10 + brightness * 82;
        let b = 18 + brightness * 128;

        const sv = specular * 0.45 * occlusion * hFalloff;
        r += sv * 150; g += sv * 170; b += sv * 200;

        if (r > 255) r = 255;
        if (g > 255) g = 255;
        if (b > 255) b = 255;

        const idx = (y * W + x) * 4;
        data[idx]     = r | 0;
        data[idx + 1] = g | 0;
        data[idx + 2] = b | 0;
        data[idx + 3] = 255;
      }
    }

    ctx.putImageData(imageData, 0, 0);
  }

  /* ── Public API ─────────────────────────────────────────────────────────── */

  function create(opts) {
    const { wrapEl, clipEl, canvasEl, onPositionChange, onDragStart, onDragEnd, onWheel: onWheelCb } = opts;
    const ctx = canvasEl.getContext("2d");

    let _position = 0.5;
    let _lightX = 0.08;
    let _scrubbing = false;
    let _lastPtrX = 0;
    let _lastPtrTime = 0;
    let _dragVelocity = 0;
    let _destroyed = false;

    /* The barrel moves SLOWER than the mouse — 1/8 gear ratio, matching the
       classic scrubber's shiftPosition: dx / (width * 8).  This gives
       precision for scrubbing through the timeline. */
    const GEAR_RATIO = 8;

    /* ── Pointer events ───────────────────────────────────────────────────── */
    function onPointerDown(e) {
      if (_destroyed) return;
      e.preventDefault();
      _scrubbing = true;
      _lastPtrX = e.clientX;
      _lastPtrTime = performance.now();
      _dragVelocity = 0;
      wrapEl.setPointerCapture(e.pointerId);
      if (onDragStart) onDragStart();
    }

    function onPointerMove(e) {
      // Always update light
      _lightX = (e.clientX / window.innerWidth - 0.5);
      if (!_scrubbing) return;
      const dx = e.clientX - _lastPtrX;
      const now = performance.now();
      const dt = Math.max(1, now - _lastPtrTime);
      _dragVelocity = (dx / dt) * 16; // px per 16ms frame
      _lastPtrX = e.clientX;
      _lastPtrTime = now;

      // Shift position by gear-reduced dx
      const frac = dx / (wrapEl.offsetWidth * GEAR_RATIO);
      _position = Math.max(0, Math.min(1, _position + frac));
      if (onPositionChange) onPositionChange(frac);
    }

    function onPointerUp(e) {
      if (!_scrubbing) return;
      _scrubbing = false;
      // Convert drag velocity to timeline velocity for inertial coasting
      // Same formula as classic: (dragVelocity / (width * 8) * timelineMs) / 16
      const vel = _dragVelocity / (wrapEl.offsetWidth * GEAR_RATIO);
      if (onDragEnd) onDragEnd(vel);
    }

    /* ── Mouse move (light only, when not dragging) ───────────────────────── */
    function onMouseMove(e) {
      if (!_scrubbing) {
        _lightX = (e.clientX / window.innerWidth - 0.5);
      }
    }

    /* ── Wheel events ─────────────────────────────────────────────────────── */
    function onWheel(e) {
      if (_destroyed) return;
      e.preventDefault();
      const isH = Math.abs(e.deltaX) >= Math.abs(e.deltaY);
      const isMouseWheel = e.deltaMode !== 0 || (!e.ctrlKey && Math.abs(e.deltaX) < 1 && Math.abs(e.deltaY) >= 4);
      // Normalize line-mode (deltaMode=1) to ~pixel equivalent (×40), then
      // use a higher multiplier for mouse wheel vs trackpad.
      const rawDy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
      const rawDx = e.deltaMode === 1 ? e.deltaX * 40 : e.deltaX;
      const delta = isH ? rawDx : (isMouseWheel ? rawDy : -rawDy) * 0.15;
      if (onWheelCb) onWheelCb(delta);
    }

    /* ── Touch events (reduced sensitivity, same as classic) ──────────────── */
    let _touchStartX = null;
    let _touchStartPos = null;
    const TOUCH_SENSITIVITY = 0.3;

    function onTouchStart(e) {
      if (_destroyed) return;
      e.preventDefault();
      const touch = e.touches[0];
      _touchStartX = touch.clientX;
      _touchStartPos = _position;
      _scrubbing = true;
      _lastPtrX = touch.clientX;
      _lastPtrTime = performance.now();
      _dragVelocity = 0;
      if (onDragStart) onDragStart();
    }

    function onTouchMove(e) {
      if (_touchStartX == null) return;
      e.preventDefault();
      const touch = e.touches[0];
      const dx = touch.clientX - _lastPtrX;
      const now = performance.now();
      _dragVelocity = (dx / Math.max(1, now - _lastPtrTime)) * 16;
      _lastPtrX = touch.clientX;
      _lastPtrTime = now;

      const frac = dx / (wrapEl.offsetWidth * GEAR_RATIO) * TOUCH_SENSITIVITY;
      _position = Math.max(0, Math.min(1, _position + frac));
      if (onPositionChange) onPositionChange(frac);
    }

    function onTouchEnd() {
      _touchStartX = null;
      _touchStartPos = null;
      _scrubbing = false;
      const vel = _dragVelocity / (wrapEl.offsetWidth * GEAR_RATIO);
      if (onDragEnd) onDragEnd(vel);
    }

    /* ── Bind events ──────────────────────────────────────────────────────── */
    wrapEl.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    document.addEventListener("mousemove", onMouseMove);
    wrapEl.addEventListener("wheel", onWheel, { passive: false });
    wrapEl.addEventListener("touchstart", onTouchStart, { passive: false });
    wrapEl.addEventListener("touchmove", onTouchMove, { passive: false });
    wrapEl.addEventListener("touchend", onTouchEnd);

    /* ── Public interface ─────────────────────────────────────────────────── */
    return {
      /** Set position externally (0..1). Used by playbackLoop to sync. */
      setPosition(p) { _position = Math.max(0, Math.min(1, p)); },

      /** Get current position */
      getPosition() { return _position; },

      /** Get current light X */
      getLightX() { return _lightX; },

      /** Is user currently dragging? */
      isScrubbing() { return _scrubbing; },

      /** Render one frame */
      render() {
        if (_destroyed) return;
        renderBarrel(ctx, clipEl, _position, _lightX);
      },

      /** Handle wheel event — returns { delta } for app.js physics */
      handleWheel(e) { return onWheel(e); },

      /** Tear down */
      destroy() {
        _destroyed = true;
        wrapEl.removeEventListener("pointerdown", onPointerDown);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        document.removeEventListener("mousemove", onMouseMove);
        wrapEl.removeEventListener("wheel", onWheel);
        wrapEl.removeEventListener("touchstart", onTouchStart);
        wrapEl.removeEventListener("touchmove", onTouchMove);
        wrapEl.removeEventListener("touchend", onTouchEnd);
      }
    };
  }

  window.JogWheel = { create };
})();
