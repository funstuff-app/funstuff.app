/**
 * engine_playback_engine.js — PlaybackEngine: playback/trace point building and
 * sampling, pose-for-render, playback-marker inertia, and scrubbing.
 *
 * MapView remains the composition root. The playback CLOCK fields
 * (_playbackNowMs, _playbackMinMs/_playbackMaxMs, _playbackPlaying,
 * _playbackSpeed, _historicalMode, _playbackLiveFollow, etc.) are SHARED with
 * app.js and MapView's public playback API — they stay on MapView. Likewise the
 * playback/trace point caches, per-vehicle physics-adjacent caches
 * (_scrubCooldownById, _vehicleRevealDist, _curveLookaheadCache,
 * _screenHeadingCache), the trace route/angle/side/warp maps, and the drag/
 * inertia fields (_pbDrag, _pbInertia2d) stay on MapView because non-moved code
 * (constructor init, cache pruning, gesture handlers, overlay drawing) also
 * reads/writes them directly. This engine accesses all of it via `this.view`.
 *
 * MapView's own playback methods become one-line delegates to
 * `this.playbackEngine.<method>()`.
 *
 * Shared MapView fields read/written here (kept on MapView, not moved):
 *   _playbackNewestSegmentStartMs, _playbackLastMaxMs, _playbackPtsById,
 *   _playbackPtsKey, _playbackNowMs, _playbackMinMs, _playbackMaxMs,
 *   _playbackSpeed, _playbackLiveFollow, _historicalMode, _historicalDateStr,
 *   _persistedTrailById, _persistedTrailRev, _pbInertia2d, _pbDrag,
 *   _pbDebugPath, _scrubbing, _scrubCooldownById, _vehicleRevealDist,
 *   _curveLookaheadCache, _screenHeadingCache, _tracePtsById, _tracePtsKey,
 *   _traceActiveRouteById, _tracePendingRouteById, _traceCycleStartMsById,
 *   _traceAngleById, _traceAngleLastMsById, _traceLastSideById,
 *   _traceSelectionWarpById, _traceRealMaxSpeedMps, _traceMaxSpeedMps,
 *   _traceTargetMedianSpeedMps, _traceSpeedSmoothingTauS, _traceStopSpeedMps,
 *   _traceDwellTimeCompression, _traceStopMinMs, _traceStopMaxMs, _traceRAF,
 *   _traceLastFrameTs, _traceTargetFPS, _followRAF, _followLastFrameTs,
 *   _followTargetLat, _followTargetLon, _followSuppressUntilMs,
 *   _followIdleFrames, _backgrounded, _backgroundedFPS, _touchActive,
 *   _mouseDragging, _pinchZooming, _vehiclePathById, _vehicleActualPathById,
 *   traceMode, playbackMode, selectedId, lastState, center, zoom, overlayCanvas.
 *
 * Also uses VehicleMotion (S4) methods via MapView delegates
 * (_getPathDistances, _getTargetDistance, _getPhysicsState,
 * _getVehiclePhysics, _getWaypointWindow, _samplePathAtDistance).
 *
 * Tuning/physics constants remain `static` on the MapView class
 * (MIN_TRAIL_LENGTH_M, TRAIL_LOOKAHEAD_BASE, CURVATURE_LOOKAHEAD,
 * CURVATURE_THRESHOLD, STOP_BUFFER) — resolved here via the global `MapView`.
 */
(function (root, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else {
    root.PlaybackEngine = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Globals from earlier-loaded scripts (projections.js for clamp/latLonToWorld,
  // data_utils.js for keyFor/parseKey/primaryReadingKeyedFromPoint/haversineMeters,
  // format_utils.js for parseUtcMs, map_view.js for the MapView class + its static
  // constants) are resolved lazily at call time — never at module factory time
  // (node tests have no browser globals).
  var g = (typeof window !== "undefined") ? window : globalThis;

  /**
   * @param {object} view — MapView instance (owns shared playback clock/caches;
   *   see file header for the full shared-field list).
   */
  function PlaybackEngine(view) {
    this.view = view;
  }

  PlaybackEngine.prototype._playbackMarkNewestSegmentFromBounds = function (prevMaxMs, nextMaxMs) {
    const p = (prevMaxMs != null) ? Number(prevMaxMs) : null;
    const n = (nextMaxMs != null) ? Number(nextMaxMs) : null;
    if (p != null && n != null && isFinite(p) && isFinite(n) && n > p + 500) {
      this.view._playbackNewestSegmentStartMs = p;
    }
    this.view._playbackLastMaxMs = (n != null && isFinite(n)) ? n : this.view._playbackLastMaxMs;
  };

  PlaybackEngine.prototype.isPlaybackAtEnd = function (epsMs = 100) {
    const b = this.view.getPlaybackBounds();
    const t = this.view.getPlaybackTimeMs();
    if (b.maxMs == null || !isFinite(Number(b.maxMs))) return false;
    if (t == null || !isFinite(Number(t))) return false;
    return Math.abs(Number(b.maxMs) - Number(t)) <= (Number(epsMs) || 0);
  };

  PlaybackEngine.prototype._closestPlaybackPathPointForMobileAtClientXY = function (mobile, clientX, clientY) {
    if (!this.view.playbackMode) return null;
    const id = mobile && mobile.id != null ? String(mobile.id) : "";
    if (!id) return null;

    this._ensurePlaybackPoints(this.view.lastState);
    const pts = this.view._playbackPtsById.get(id);
    if (!pts || pts.length < 2) return null;

    const rect = this.view.overlayCanvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const w = rect.width;
    const h = rect.height;
    const centerW = g.latLonToWorld(this.view.center.lat, this.view.center.lon, this.view.zoom);
    const toScreen = (lat, lon) => {
      const wpt = g.latLonToWorld(lat, lon, this.view.zoom);
      return { x: wpt.x - centerW.x + w / 2, y: wpt.y - centerW.y + h / 2 };
    };

    const closestOnSeg = (ax, ay, bx, by, px, py) => {
      const abx = bx - ax;
      const aby = by - ay;
      const apx = px - ax;
      const apy = py - ay;
      const ab2 = abx * abx + aby * aby;
      let t = 0;
      if (ab2 > 1e-9) t = (apx * abx + apy * aby) / ab2;
      t = g.clamp(t, 0, 1);
      const cx = ax + abx * t;
      const cy = ay + aby * t;
      const dx = px - cx;
      const dy = py - cy;
      return { t, cx, cy, d2: dx * dx + dy * dy };
    };

    // Coarse-to-fine search so long trails still feel responsive.
    const n = pts.length;
    const stride = Math.max(1, Math.floor(n / 520));
    let best = { i: 0, t: 0, cx: 0, cy: 0, d2: Infinity };

    const scan = (i0, i1, step) => {
      const start = Math.max(0, i0);
      const end = Math.min(n - 2, i1);
      for (let i = start; i <= end; i += step) {
        const a = pts[i];
        const b = pts[i + 1];
        const sa = toScreen(a.lat, a.lon);
        const sb = toScreen(b.lat, b.lon);
        const hit = closestOnSeg(sa.x, sa.y, sb.x, sb.y, sx, sy);
        if (hit.d2 < best.d2) best = { i, t: hit.t, cx: hit.cx, cy: hit.cy, d2: hit.d2 };
      }
    };

    scan(0, n - 2, stride);
    const win = Math.max(24, stride * 7);
    scan(best.i - win, best.i + win, 1);

    const a = pts[best.i];
    const b = pts[best.i + 1];
    const tMs = a.tMs + (b.tMs - a.tMs) * best.t;
    const distPx = Math.sqrt(best.d2);
    return { tMs, distPx, segI: best.i, segT: best.t, closest: { x: best.cx, y: best.cy }, cursor: { x: sx, y: sy } };
  };

  PlaybackEngine.prototype._startPbMarkerInertiaFromDrag = function (drag) {
    if (!this.view.playbackMode) return;
    const id = drag && drag.id != null ? String(drag.id) : "";
    if (!id) return;
    const pos = drag && drag.cursorClient ? drag.cursorClient : (drag && drag.lastClient ? drag.lastClient : null);
    if (!pos) return;
    const v0 = drag && drag.vel ? drag.vel : { x: 0, y: 0 };
    const vx = Number(v0.x) || 0;
    const vy = Number(v0.y) || 0;
    const speed = Math.hypot(vx, vy);
    // Only a subtle glide; ignore tiny releases.
    if (!isFinite(speed) || speed < 0.05) return; // px/ms

    const nowMs = performance.now();
    this.view._pbInertia2d = {
      id,
      t0Ms: nowMs,
      lastMs: nowMs,
      posClient: { x: Number(pos.x) || 0, y: Number(pos.y) || 0 },
      vel: { x: vx, y: vy },
    };
  };

  PlaybackEngine.prototype._hasPbMarkerInertia = function () {
    return !!(this.view._pbInertia2d && this.view._pbInertia2d.id);
  };

  PlaybackEngine.prototype._stepPbMarkerInertia = function (nowMs, dtMs) {
    const it = this.view._pbInertia2d;
    if (!it || !it.id) return false;
    const dt = Math.max(0, Number(dtMs) || 0);
    if (!(dt > 0)) return false;

    // Cap duration so a fling never runs away.
    const age = (nowMs - (it.t0Ms || nowMs));
    if (age > 900) {
      this.view._pbInertia2d = null;
      return false;
    }

    // Integrate in client space; then snap to nearest path point.
    it.posClient.x += (it.vel.x || 0) * dt;
    it.posClient.y += (it.vel.y || 0) * dt;

    // Exponential friction: quick settle.
    const friction = Math.pow(0.992, dt);
    it.vel.x *= friction;
    it.vel.y *= friction;

    const speed = Math.hypot(it.vel.x || 0, it.vel.y || 0);
    if (!isFinite(speed) || speed < 0.02) {
      this.view._pbInertia2d = null;
      return false;
    }

    const st = this.view.lastState;
    const mobiles = st && Array.isArray(st.mobile) ? st.mobile : [];
    const m = mobiles.find(mm => (mm && mm.id != null && String(mm.id) === String(it.id))) || null;
    if (!m) {
      this.view._pbInertia2d = null;
      return false;
    }

    const closest = this._closestPlaybackPathPointForMobileAtClientXY(m, it.posClient.x, it.posClient.y);
    if (closest && isFinite(closest.tMs)) {
      const bounds = this.view.getPlaybackBounds();
      const tMs = closest.tMs;
      if (isFinite(bounds.minMs) && isFinite(bounds.maxMs)) {
        const clamped = g.clamp(tMs, bounds.minMs, bounds.maxMs);
        this.view.setPlaybackTimeMs(clamped);
        // User interaction exits LIVE mode (they're manually controlling)
        this.view._playbackLiveFollow = false;
        if (typeof this.view._resetLiveTracking === "function") this.view._resetLiveTracking();
      } else {
        this.view.setPlaybackTimeMs(tMs);
        this.view._playbackLiveFollow = false;
        if (typeof this.view._resetLiveTracking === "function") this.view._resetLiveTracking();
      }
      return true;
    }

    return false;
  };

  PlaybackEngine.prototype._scrubPlaybackTimeForMobileAtClientXY = function (mobile, clientX, clientY) {
    const c = this._closestPlaybackPathPointForMobileAtClientXY(mobile, clientX, clientY);
    if (!c || !isFinite(c.tMs)) return;
    const bounds = this.view.getPlaybackBounds();
    if (isFinite(bounds.minMs) && isFinite(bounds.maxMs)) {
      let clamped = g.clamp(c.tMs, bounds.minMs, bounds.maxMs);
      this.view.setPlaybackTimeMs(clamped);
    }
    else this.view.setPlaybackTimeMs(c.tMs);
  };

  PlaybackEngine.prototype._traceTick = function () {
    this.view._traceRAF = null;
    // Don't run trace loop when playback mode is active - playback has its own loop
    if (!this.view.traceMode || this.view.playbackMode) return;
    // Basemap is static; only redraw overlays.
    // Throttle to reduce CPU while remaining smooth.
    const now = performance.now();
    const fps = this.view._backgrounded ? (this.view._backgroundedFPS || 15) : (this.view._traceTargetFPS || 30);
    const minDt = 1000 / fps;
    if (this.view._traceLastFrameTs > 0 && (now - this.view._traceLastFrameTs) < (minDt - 0.5)) {
      this.view._traceRAF = requestAnimationFrame(() => this._traceTick());
      return;
    }
    this.view._traceLastFrameTs = now;
    this.view.drawOverlay(this.view.lastState, { nowMs: now, fromTraceTick: true });
    this.view._traceRAF = requestAnimationFrame(() => this._traceTick());
  };

  PlaybackEngine.prototype._followTick = function () {
    this.view._followRAF = null;
    if (!this.view.selectedId || this.view._followTargetLat === null) return;
    const now = performance.now();
    if (this.view._touchActive || this.view._mouseDragging || this.view._pinchZooming ||
        this.view._scrubbing ||
        now < this.view._followSuppressUntilMs) {
      this.view._followRAF = requestAnimationFrame(() => this._followTick());
      return;
    }
    // Throttle follow updates when tab is backgrounded
    if (this.view._backgrounded) {
      const minDt = 1000 / (this.view._backgroundedFPS || 15);
      if (this.view._followLastFrameTs > 0 && (now - this.view._followLastFrameTs) < (minDt - 0.5)) {
        this.view._followRAF = requestAnimationFrame(() => this._followTick());
        return;
      }
      this.view._followLastFrameTs = now;
    }
    // Always use the rendered marker position (interpolated), not raw GPS.
    let tLat = this.view._followTargetLat;
    let tLon = this.view._followTargetLon;
    if (this.view.lastState) {
      const fp = g.parseKey(this.view.selectedId);
      if (fp && fp.type === 'mobile') {
        const mob = Array.isArray(this.view.lastState.mobile) ? this.view.lastState.mobile : [];
        const fm = mob.find(v => String(v.id) === String(fp.id));
        if (fm) {
          const pose = this._mobilePoseForRender(fm, performance.now());
          if (pose && isFinite(Number(pose.lat)) && isFinite(Number(pose.lon))) {
            tLat = Number(pose.lat);
            tLon = Number(pose.lon);
          }
        }
      }
    }
    const dLat = tLat - this.view.center.lat;
    const dLon = tLon - this.view.center.lon;
    const moved = Math.abs(dLat) > 0.00005 || Math.abs(dLon) > 0.00005;
    if (moved) {
      this.view.center = { lat: this.view.center.lat + dLat * 0.03, lon: this.view.center.lon + dLon * 0.03 };
      this.view._redrawViewOnly();
      this.view._followIdleFrames = 0;
      this.view._followRAF = requestAnimationFrame(() => this._followTick());
    } else {
      // Drop from 60 Hz to ~6 Hz once the target has been stationary for a
      // beat. Camera-recovery latency after a user pan stays well under a
      // frame the user notices, but idle CPU stops burning watching a
      // parked bus.
      this.view._followIdleFrames = (this.view._followIdleFrames || 0) + 1;
      const idleDelayMs = this.view._followIdleFrames > 15 ? 160 : 0;
      if (idleDelayMs > 0) {
        setTimeout(() => {
          if (this.view._followTargetLat === null || !this.view.selectedId) return;
          this.view._followRAF = requestAnimationFrame(() => this._followTick());
        }, idleDelayMs);
      } else {
        this.view._followRAF = requestAnimationFrame(() => this._followTick());
      }
    }
  };

  PlaybackEngine.prototype._hash01 = function (s) {
    const str = String(s || "");
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % 100000) / 100000;
  };

  PlaybackEngine.prototype._traceSampleForMobile = function (m, nowMs) {
    const id = m && m.id ? String(m.id) : "";

    // If the backend says this vehicle is idle/ghosted, dim marker unless selected or in Debug mode.
    if (m && m.ghosted) {
      const lat = Number(m.lat);
      const lon = Number(m.lon);
      const prevA = this.view._traceAngleById.get(id);
      const angle = (prevA != null && isFinite(prevA)) ? prevA : 0;
      this.view._traceAngleById.set(id, angle);
      this.view._traceAngleLastMsById.set(id, nowMs);

      if (!m._key) m._key = g.keyFor("mobile", m.id);
      const key = m._key;
      const isSel = (this.view.selectedId === key);
      const dimOpacity = 0.25;
      const opacity = (this.view._pbDebugPath || isSel) ? 1 : dimOpacity;

      return { lat, lon, angle, flipX: false, speedMps: 0, opacity };
    }

    let route = this.view._traceActiveRouteById.get(id) || null;
    if (!route || !route.pts || route.pts.length < 2) {
      route = this.view._tracePendingRouteById.get(id) || null;
      if (!route || !route.pts || route.pts.length < 2) return null;
      // If we only have a pending route (startup), promote it.
      this.view._traceActiveRouteById.set(id, route);
      this.view._tracePendingRouteById.delete(id);
    }

    let driveMs = route.driveMs || 1;
    let pauseMs = route.pauseMs || 0;
    let returnMs = route.returnMs || 0;
    let totalMs = route.totalMs || (driveMs + pauseMs + returnMs);

    // Keep the current loop stable across refreshes; only swap pending route at loop boundary.
    let cycleStartMs = this.view._traceCycleStartMsById.get(id);
    if (cycleStartMs == null || !isFinite(cycleStartMs)) {
      // Start at the beginning of the path.
      cycleStartMs = nowMs;
    }
    let elapsed = nowMs - cycleStartMs;
    if (!isFinite(elapsed)) elapsed = 0;

    // Swap pending route only at loop boundary so the animation doesn't jump.
    if (elapsed >= totalMs) {
      const pending = this.view._tracePendingRouteById.get(id);
      if (pending && pending.pts && pending.pts.length >= 2) {
        route = pending;
        this.view._traceActiveRouteById.set(id, pending);
        this.view._tracePendingRouteById.delete(id);
        driveMs = route.driveMs || 1;
        pauseMs = route.pauseMs || 0;
        returnMs = route.returnMs || 0;
        totalMs = route.totalMs || (driveMs + pauseMs + returnMs);
        cycleStartMs = nowMs;
        elapsed = 0;
      } else {
        const loopDur = Math.max(100, totalMs);
        const cyclesPassed = Math.floor(elapsed / loopDur);
        cycleStartMs = cycleStartMs + cyclesPassed * loopDur;
        elapsed = nowMs - cycleStartMs;
      }
    }
    this.view._traceCycleStartMsById.set(id, cycleStartMs);

    const tInCycle = elapsed;
    const tPauseStart = driveMs;
    const tReturnStart = driveMs + pauseMs;
    const tEnd = driveMs + pauseMs + (returnMs || 0);

    const inPause = (tInCycle >= tPauseStart) && (tInCycle < tReturnStart);
    const inReturn = (tInCycle >= tReturnStart) && (tInCycle < tEnd) && ((returnMs || 0) > 0);
    const tDrive = (tInCycle < driveMs) ? tInCycle : driveMs;

    // Find segment for tDrive.
    const segStart = route.segStartMs;
    const segDur = route.segDurMs;
    const pts = route.pts;
    let si = 0;
    let lo = 0;
    let hi = segStart.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const a = segStart[mid];
      const b = a + (segDur[mid] || 1);
      if (tDrive < a) hi = mid - 1;
      else if (tDrive >= b) lo = mid + 1;
      else { si = mid; break; }
    }
    // If binary search didn't land (e.g. exact end), clamp.
    if (si < 0) si = 0;
    if (si >= segStart.length) si = segStart.length - 1;

    const aT = segStart[si];
    const dT = Math.max(1, segDur[si] || 1);
    const u = g.clamp((tDrive - aT) / dT, 0, 1);

    const p0 = pts[si];
    const p1 = pts[si + 1] || pts[si];
    let lat = p0.lat + (p1.lat - p0.lat) * u;
    let lon = p0.lon + (p1.lon - p0.lon) * u;
    let speedMps = (route.segRealSpeedMps && isFinite(route.segRealSpeedMps[si]) ? route.segRealSpeedMps[si] : 0);
    let opacity = 1;

    if (inPause) {
      const endPt = pts[pts.length - 1] || p1;
      lat = endPt.lat;
      lon = endPt.lon;
      speedMps = 0;
    } else if (inReturn) {
      const endPt = pts[pts.length - 1] || p1;
      const lsLat = isFinite(Number(route.loopStartLat)) ? Number(route.loopStartLat) : (pts[0]?.lat ?? endPt.lat);
      const lsLon = isFinite(Number(route.loopStartLon)) ? Number(route.loopStartLon) : (pts[0]?.lon ?? endPt.lon);
      const uu = g.clamp((tInCycle - tReturnStart) / Math.max(1, returnMs || 1), 0, 1);
      lat = endPt.lat + (lsLat - endPt.lat) * uu;
      lon = endPt.lon + (lsLon - endPt.lon) * uu;
      const distM = g.haversineMeters(endPt.lat, endPt.lon, lsLat, lsLon);
      const v = distM / Math.max(0.001, (returnMs || 1) / 1000);
      speedMps = g.clamp(v, 0, Number(this.view._traceRealMaxSpeedMps) || 20.0);

      // Seamless fade on loop return:
      // - fade out over first 0.5s of return
      // - stay invisible mid-return
      // - fade in over last 0.5s before arriving at loop start
      const fadeMs = 500;
      const tRet = tInCycle - tReturnStart;
      const tRemain = (tEnd - tInCycle);
      if (tRet <= fadeMs) opacity = g.clamp(1 - (tRet / fadeMs), 0, 1);
      else if (tRemain <= fadeMs) opacity = g.clamp(1 - (tRemain / fadeMs), 0, 1);
      else opacity = 0;
    }

    // Selection warp: when a sensor is clicked, make the trace marker "return" to the latest
    // live location deterministically (fade-out → invisible warp → fade-in).
    const warp = this.view._traceSelectionWarpById.get(id);
    if (warp) {
      const t0 = Number(warp.t0Ms);
      const fadeMs = Number(warp.fadeMs) || 500;
      const durMs = Number(warp.durationMs) || 1400;
      const t = nowMs - t0;
      if (!isFinite(t) || t < 0) {
        // ignore
      } else if (t >= durMs) {
        this.view._traceSelectionWarpById.delete(id);
        // Force the trace cycle to the end point (latest) so it stays in sync after warp.
        const r = this.view._traceActiveRouteById.get(id);
        if (r && isFinite(Number(r.driveMs))) {
          this.view._traceCycleStartMsById.set(id, nowMs - Number(r.driveMs));
        }
      } else {
        const fromLat = Number(warp.fromLat);
        const fromLon = Number(warp.fromLon);
        const homeLat = Number(warp.homeLat);
        const homeLon = Number(warp.homeLon);
        const midDur = Math.max(1, durMs - 2 * fadeMs);
        if (t <= fadeMs) {
          // Fade out at the original trace position.
          lat = isFinite(fromLat) ? fromLat : lat;
          lon = isFinite(fromLon) ? fromLon : lon;
          speedMps = 0;
          opacity = opacity * g.clamp(1 - (t / Math.max(1, fadeMs)), 0, 1);
        } else if (t >= (durMs - fadeMs)) {
          // Fade in at the latest live position.
          lat = isFinite(homeLat) ? homeLat : lat;
          lon = isFinite(homeLon) ? homeLon : lon;
          speedMps = 0;
          const u = (t - (durMs - fadeMs)) / Math.max(1, fadeMs);
          opacity = opacity * g.clamp(u, 0, 1);
        } else {
          // Invisible warp (optionally interpolate for determinism).
          const u = g.clamp((t - fadeMs) / midDur, 0, 1);
          if (isFinite(fromLat) && isFinite(homeLat)) lat = fromLat + (homeLat - fromLat) * u;
          if (isFinite(fromLon) && isFinite(homeLon)) lon = fromLon + (homeLon - fromLon) * u;
          speedMps = 0;
          opacity = 0;
        }
      }
    }

    // Heading in projected space for correct screen rotation.
    let hLat0 = p0.lat;
    let hLon0 = p0.lon;
    let hLat1 = p1.lat;
    let hLon1 = p1.lon;
    if (inPause) {
      const a = pts[Math.max(0, pts.length - 2)] || p0;
      const b = pts[Math.max(0, pts.length - 1)] || p1;
      hLat0 = a.lat;
      hLon0 = a.lon;
      hLat1 = b.lat;
      hLon1 = b.lon;
    } else if (inReturn) {
      const endPt = pts[pts.length - 1] || p1;
      const lsLat = isFinite(Number(route.loopStartLat)) ? Number(route.loopStartLat) : (pts[0]?.lat ?? endPt.lat);
      const lsLon = isFinite(Number(route.loopStartLon)) ? Number(route.loopStartLon) : (pts[0]?.lon ?? endPt.lon);
      hLat0 = endPt.lat;
      hLon0 = endPt.lon;
      hLat1 = lsLat;
      hLon1 = lsLon;
    }

    const w0 = g.latLonToWorld(hLat0, hLon0, this.view.zoom);
    const w1 = g.latLonToWorld(hLat1, hLon1, this.view.zoom);
    let dx = (w1.x - w0.x);
    let dy = (w1.y - w0.y);
    if (Math.abs(dx) < 0.0001 && Math.abs(dy) < 0.0001) {
      // If we're at (or pausing at) the end, reuse the last meaningful segment.
      const lastIdx = Math.max(0, Math.min(pts.length - 2, pts.length - 2));
      const wa = g.latLonToWorld(pts[lastIdx].lat, pts[lastIdx].lon, this.view.zoom);
      const wb = g.latLonToWorld(pts[lastIdx + 1].lat, pts[lastIdx + 1].lon, this.view.zoom);
      dx = wb.x - wa.x;
      dy = wb.y - wa.y;
    }
    const heading = Math.atan2(dy, dx);

    // Debounce left/right side changes around vertical to avoid flicker when traveling up/down.
    const absH = Math.abs(heading);
    const dead = 0.22; // ~12.6° deadband
    const switchToLeft = (Math.PI / 2) + dead;
    const switchToRight = (Math.PI / 2) - dead;
    let side = this.view._traceLastSideById.get(id);
    if (side !== "L" && side !== "R") side = (absH > Math.PI / 2) ? "L" : "R";
    if (side === "R" && absH > switchToLeft) side = "L";
    else if (side === "L" && absH < switchToRight) side = "R";
    this.view._traceLastSideById.set(id, side);

    let renderAngle = heading;
    if (side === "L") renderAngle = Math.PI - heading;
    if (renderAngle > Math.PI) renderAngle -= Math.PI * 2;
    if (renderAngle < -Math.PI) renderAngle += Math.PI * 2;

    // Smooth the angle to avoid snap-rotation when direction changes.
    const wrapAngle = (a) => {
      let x = a;
      while (x > Math.PI) x -= Math.PI * 2;
      while (x < -Math.PI) x += Math.PI * 2;
      return x;
    };
    const prevA = this.view._traceAngleById.get(id);
    const lastMs = this.view._traceAngleLastMsById.get(id);
    const dtS = (lastMs != null && isFinite(lastMs)) ? Math.max(0, (nowMs - lastMs) / 1000) : 0;
    const tauS = 0.35;
    const alpha = dtS > 0 ? (1 - Math.exp(-dtS / tauS)) : 1;
    const nextA = (prevA == null)
      ? renderAngle
      : wrapAngle(prevA + wrapAngle(renderAngle - prevA) * alpha);
    this.view._traceAngleById.set(id, nextA);
    this.view._traceAngleLastMsById.set(id, nowMs);

    return { lat, lon, angle: nextA, flipX: (side === "L"), speedMps, opacity };
  };

  PlaybackEngine.prototype._mobilePoseForRender = function (m, nowMs) {
    let lat = Number(m?.lat);
    let lon = Number(m?.lon);
    let angle = 0;
    let flipX = false;
    let speedMps = 0;
    let opacity = 1;

    if (this.view.playbackMode) {
      this._ensurePlaybackPoints(this.view.lastState);
      const smp = this._playbackSampleForMobile(m, nowMs);
      if (smp) {
        lat = smp.lat;
        lon = smp.lon;
        angle = smp.angle;
        flipX = !!smp.flipX;
        speedMps = Number(smp.speedMps) || 0;
        opacity = (typeof smp.opacity === "number" && isFinite(smp.opacity)) ? smp.opacity : 1;
        // Dim markers that haven't "started" yet in the timeline
        if (smp.beforeFirst) {
          opacity = 0.3;
        }
      } else {
        // Fallback: if no playback sample but we have trail data, use first/last trail point
        const id = m && m.id != null ? String(m.id) : "";
        const pts = id ? this.view._playbackPtsById.get(id) : null;
        const t = this.view._playbackNowMs;
        if (pts && pts.length >= 1 && t != null && isFinite(t)) {
          // Before first point: show at first position (dimmed)
          // After last point: show at last position
          const tMin = pts[0].tMs;
          const tMax = pts[pts.length - 1].tMs;
          if (t < tMin) {
            lat = pts[0].lat;
            lon = pts[0].lon;
            opacity = 0.3; // Dimmed - hasn't "started" yet
          } else if (t >= tMax) {
            lat = pts[pts.length - 1].lat;
            lon = pts[pts.length - 1].lon;
          }
        }
      }

      const held = !!(
        (this.view._pbDrag && String(this.view._pbDrag.id) === String(m?.id)) ||
        (this.view._pbInertia2d && String(this.view._pbInertia2d.id) === String(m?.id))
      );

      return {
        lat,
        lon,
        angle,
        flipX,
        speedMps,
        opacity,
        reading: smp?.reading || null,
        readings: smp?.readings || null,
        held,
      };
    }

    if (this.view.traceMode) {
      const smp = this._traceSampleForMobile(m, nowMs);
      if (smp) {
        lat = smp.lat;
        lon = smp.lon;
        angle = smp.angle;
        flipX = !!smp.flipX;
        speedMps = Number(smp.speedMps) || 0;
        opacity = (typeof smp.opacity === "number" && isFinite(smp.opacity)) ? smp.opacity : 1;
      }
      return { lat, lon, angle, flipX, speedMps, opacity };
    }

    const id = (m && m.id != null) ? String(m.id) : "";
    const pin = id ? this.view._persistedTrailById.get(id)?.pin : null;
    if (pin && isFinite(Number(pin.lat)) && isFinite(Number(pin.lon))) {
      lat = Number(pin.lat);
      lon = Number(pin.lon);
    }

    return { lat, lon, angle, flipX, speedMps, opacity };
  };

  PlaybackEngine.prototype._tracePointsKeyForState = function (state) {
    const rev = state?.meta?.server_revision;
    if (typeof rev === "number" && isFinite(rev)) return `rev:${rev}`;
    const ts = state?.ts;
    if (typeof ts === "number" && isFinite(ts)) return `ts:${ts}`;
    return `obj:${state ? 1 : 0}`;
  };

  PlaybackEngine.prototype._playbackPointsKeyForState = function (state) {
    const revKey = this._tracePointsKeyForState(state);
    // Include trail point count per sensor to detect data changes
    let trailSig = "";
    const mobiles = Array.isArray(state?.mobile) ? state.mobile : [];
    for (const m of mobiles) {
      const id = m?.id || "";
      const trail = Array.isArray(m?.trail) ? m.trail : [];
      const lastT = trail.length > 0 ? (trail[trail.length - 1]?.t || "") : "";
      trailSig += `${id}:${trail.length}:${lastT}|`;
    }
    return `${revKey}|persist:${this.view._persistedTrailRev}|trail:${trailSig}|v3`;
  };

  PlaybackEngine.prototype._ensurePlaybackPoints = function (state) {
    const key = this._playbackPointsKeyForState(state);
    const cacheHit = (this.view._playbackPtsKey === key);

    // Cache key includes trail signatures, so if data changed the key will differ.
    if (cacheHit) {
      return;
    }

    // Rebuild playback points on cache miss
    this.view._playbackPtsKey = key;

    const nextPtsById = new Map();
    let minMs = Infinity;
    let maxMs = -Infinity;

    // No day-start clamp: the timeline begins at the earliest data that exists,
    // not an explicit 5 AM boundary. (liveDayStartMs left null so the trail
    // filter below is a no-op.)
    const liveDayStartMs = null;

    const mobiles = Array.isArray(state?.mobile) ? state.mobile : [];
    for (const m of mobiles) {
      const id = m && m.id != null ? String(m.id) : "";
      if (!id) continue;

      // In playback mode, always prefer server trail for fresh readings/colors.
      // Persisted trail is only used in non-playback live mode for continuity.
      const serverTrail = Array.isArray(m?.trail) ? m.trail : [];
      const persisted = (this.view._historicalMode || this.view.playbackMode) ? [] : (this.view._persistedTrailById.get(id)?.trail || []);
      const src = (serverTrail.length >= 2) ? serverTrail : (persisted.length >= 2 ? persisted : serverTrail);
      if (!Array.isArray(src) || src.length < 2) continue;

      const pts = [];
      for (const p of src) {
        const lat = Number(p?.lat);
        const lon = Number(p?.lon);
        if (!isFinite(lat) || !isFinite(lon)) continue;
        const tMs = (p && typeof p.t === "string") ? g.parseUtcMs(p.t) : null;
        if (tMs == null || !isFinite(tMs)) continue;
        pts.push({ lat, lon, tMs, m: p.m, readings: p.readings });
      }
      if (pts.length >= 1) {
        // GPS data almost always arrives chronologically. Verify before
        // paying for a full O(n log n) sort — a linear O(n) check is cheap.
        let sorted = true;
        for (let k = 1; k < pts.length; k++) {
          if (pts[k].tMs < pts[k - 1].tMs) { sorted = false; break; }
        }
        if (!sorted) pts.sort((a, b) => a.tMs - b.tMs);

        let filtered = pts;
        if (liveDayStartMs != null && isFinite(liveDayStartMs)) {
          // Binary search for liveDayStartMs instead of filter() over entire array
          let lo = 0, hi = pts.length;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (pts[mid].tMs < liveDayStartMs) lo = mid + 1; else hi = mid;
          }
          filtered = lo > 0 ? pts.slice(lo) : pts;
        }
        if (!Array.isArray(filtered) || filtered.length < 2) {
          continue;
        }

        // Update timeline bounds from ALL data points (before movement filter)
        minMs = Math.min(minMs, filtered[0].tMs);
        maxMs = Math.max(maxMs, filtered[filtered.length - 1].tMs);

        // Only add to playback points if there's actual movement (not just GPS jitter)
        let totalM = 0;
        for (let i = 1; i < filtered.length; i++) {
          const a = filtered[i - 1];
          const b = filtered[i];
          const d = g.haversineMeters(a.lat, a.lon, b.lat, b.lon);
          if (isFinite(d)) totalM += d;
          if (totalM >= g.MapView.MIN_TRAIL_LENGTH_M) break;
        }
        if (totalM >= g.MapView.MIN_TRAIL_LENGTH_M) {
          nextPtsById.set(id, filtered);
        }
      }
    }

    this.view._playbackPtsById = nextPtsById;

    // Extend the timeline to cover fixed/PA sensor history, not just mobile
    // trails. Fixed sensors report from midnight while buses only start at
    // 5 AM, so deriving bounds from trails alone makes the scrub range begin
    // at the first bus instead of the day's earliest data. Timelines are
    // monotonic, so the first/last history entry per reading is its min/max.
    const fixedArr = Array.isArray(state?.fixed) ? state.fixed : [];
    for (const f of fixedArr) {
      const readings = f && f.readings;
      if (!readings) continue;
      for (const key in readings) {
        const ht = readings[key] && readings[key].history_times;
        if (!Array.isArray(ht) || ht.length === 0) continue;
        const t0 = g.parseUtcMs(ht[0]);
        const t1 = g.parseUtcMs(ht[ht.length - 1]);
        if (t0 != null && isFinite(t0) && t0 < minMs) minMs = t0;
        if (t1 != null && isFinite(t1) && t1 > maxMs) maxMs = t1;
      }
    }

    // Use server meta timestamps as fallback when no trails qualify
    const serverStartMs = state?.meta?.trail_update_start_ms;
    const serverEndMs = state?.meta?.trail_update_end_ms;

    if (!isFinite(minMs) && typeof serverStartMs === "number" && isFinite(serverStartMs)) {
      minMs = serverStartMs;
    }
    if (!isFinite(maxMs) && typeof serverEndMs === "number" && isFinite(serverEndMs)) {
      maxMs = serverEndMs;
    }
    // Also extend maxMs if server has newer data
    if (isFinite(maxMs) && typeof serverEndMs === "number" && isFinite(serverEndMs) && serverEndMs > maxMs) {
      maxMs = serverEndMs;
    }

    // In live mode the timeline end is "now": extend stale data up to now so
    // playback doesn't freeze, AND cap it back down to now if a fixed sensor's
    // history carries future-dated (forecast) timestamps — the LIVE end must
    // never be in the future.
    if (!this.view._historicalMode) {
      const fixed = Array.isArray(state?.fixed) ? state.fixed : [];
      if (fixed.length > 0) {
        const nowMs = Date.now();
        if (!isFinite(minMs)) {
          // No mobile trail data at all -- anchor to server start or 1h ago
          minMs = (typeof serverStartMs === "number" && isFinite(serverStartMs))
            ? serverStartMs : (nowMs - 3600000);
        }
        maxMs = nowMs;
      }
    }

    // In historical mode with no mobile trails (e.g. weekend with buses off),
    // derive a 5AM-to-5AM window from the snapshot date so fixed sensors
    // still render and the playback UI isn't frozen.
    if (this.view._historicalMode && !isFinite(minMs)) {
      const dateStr = state?.meta?.date || this.view._historicalDateStr;
      if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        const [y, mo, d] = dateStr.split("-").map(Number);
        // 5 AM local on snapshot day to 5 AM next day
        minMs = new Date(y, mo - 1, d, 5, 0, 0, 0).getTime();
        maxMs = minMs + 86400000;
      }
    }

    this.view._playbackMinMs = isFinite(minMs) ? minMs : null;
    this.view._playbackMaxMs = isFinite(maxMs) ? maxMs : null;

    // Track maxMs for other uses
    this.view._playbackLastMaxMs = this.view._playbackMaxMs;
  };

  PlaybackEngine.prototype._playbackSampleForMobile = function (m, nowPerfMs) {
    const id = m && m.id != null ? String(m.id) : "";
    if (!id) return null;
    const t = this.view._playbackNowMs;
    if (t == null || !isFinite(t)) return null;

    const pts = this.view._playbackPtsById.get(id);
    if (!pts || pts.length < 1) return null;

    const tMin = pts[0].tMs;
    const tMax = pts[pts.length - 1].tMs;
    if (!isFinite(tMin) || !isFinite(tMax)) return null;

    // Single point: always return that point
    if (pts.length === 1) {
      const p = pts[0];
      return { lat: p.lat, lon: p.lon, m: p.m, readings: p.readings, beforeFirst: t < tMin, afterLast: t > tMax };
    }

    // Get raw path geometry for physics (distance, curvature from original GPS points)
    const { cumDist, totalDist, curvature } = this.view._getPathDistances(id, pts);

    // Target distance along raw path based on playback time
    const targetD = this.view._getTargetDistance(pts, cumDist, totalDist, t);

    // ── SCRUB FAST PATH ──────────────────────────────────────────────────────
    // When the user is actively scrubbing, skip the entire physics pipeline.
    // The controller owns the position — place marker at targetD and return.
    //
    // Also stays active during "cooldown" after a forward scrub ends: the
    // easing/fling continues advancing playbackTimeMs while physics would be
    // far behind, causing a lurch. We hold the fast path until the playback
    // velocity settles to normal speed (targetD stops racing ahead).
    if (this.view._scrubbing) {
      // Mark that we're in a scrub — cooldown will continue after release
      if (!this.view._scrubCooldownById) this.view._scrubCooldownById = new Map();
      this.view._scrubCooldownById.set(id, { lastTargetD: targetD, lastT: t });
    }
    const cooldown = this.view._scrubCooldownById?.get(id);
    const inCooldown = !this.view._scrubbing && cooldown != null
      && (t - cooldown.lastT) < 1500   // max 1.5s cooldown
      && (targetD - cooldown.lastTargetD) > 50;  // easing is still racing ahead (>50m jump)
    if (inCooldown) {
      // Update cooldown tracking
      cooldown.lastTargetD = targetD;
      cooldown.lastT = t;
    } else if (!this.view._scrubbing && cooldown != null) {
      // Cooldown finished — clear it
      this.view._scrubCooldownById.delete(id);
    }

    if (this.view._scrubbing || inCooldown) {
      const phys = this.view._getPhysicsState(id);
      phys.d = targetD;
      phys.lastPlaybackT = t;
      phys.lastPerfMs = nowPerfMs;
      phys.v = 0;
      const smp = this.view._samplePathAtDistance(pts, cumDist, curvature, targetD);
      phys.lat = smp.lat;
      phys.lon = smp.lon;
      phys.heading = smp.heading;
      phys.totalDist = totalDist;
      const nextPt = smp.p1 || pts[Math.min(smp.idx + 1, pts.length - 1)];
      const reading = g.primaryReadingKeyedFromPoint(nextPt);
      const movingFlag = !!(nextPt && (nextPt.m === 1 || nextPt.m === "1" || nextPt.m === true));
      if (!m._key) m._key = g.keyFor("mobile", m.id);
      const opacity = (!movingFlag && !this.view._pbDebugPath && this.view.selectedId !== m._key) ? 0.25 : 1.0;
      // Store debug info so trail reveal still works during scrub
      if (!this.view._vehicleRevealDist) this.view._vehicleRevealDist = new Map();
      this.view._vehicleRevealDist.set(id, {
        d: targetD, visibleEnd: targetD, vehicleD: targetD, vehicleV: 0,
        vehicleTMs: t, controlScalar: 1, positionError: 0, totalDist
      });
      return { lat: smp.lat, lon: smp.lon, angle: smp.heading, flipX: false, speedMps: 0, opacity, reading, readings: nextPt.readings, beforeFirst: t < tMin };
    }
    // ── END SCRUB FAST PATH ──────────────────────────────────────────────────

    // Get physics state and determine reference distance for sliding window
    const phys = this.view._getPhysicsState(id);
    // Use phys.d if initialized, otherwise use targetD (where we WILL be)
    const refD = (phys.d > 0) ? phys.d : targetD;

    // Find index corresponding to reference distance (binary search on sorted cumDist)
    let _lo = 0, _hi = cumDist.length - 1;
    while (_lo < _hi) {
      const _mid = (_lo + _hi + 1) >> 1;
      if (cumDist[_mid] <= refD) _lo = _mid; else _hi = _mid - 1;
    }
    const vehicleIdx = _lo;

    // Get sliding window of smoothed waypoints around vehicle position
    const playbackSpeed = this.view._playbackSpeed || 1.0;
    const waypointWindow = this.view._getWaypointWindow(id, pts, vehicleIdx, playbackSpeed);
    const smoothWaypoints = waypointWindow?.waypoints || pts;
    const smoothCumDist = waypointWindow?.cumDist || cumDist;

    // Vehicle physics parameters
    const vp = this.view._getVehiclePhysics(id);

    // Detect scrubbing: if playback time jumped significantly, snap to new position.
    // Also snap unconditionally when the user is actively scrubbing (barrel or slider).
    const lastPlaybackT = phys.lastPlaybackT || t;
    const playbackDt = t - lastPlaybackT;
    const scrubThreshold = Math.max(2000, (this.view._playbackSpeed || 1) * 250);
    const isScrub = Math.abs(playbackDt) > scrubThreshold || !!this.view._scrubbing;
    phys.lastPlaybackT = t;

    // Wall-clock dt for physics integration
    const dtS = (phys.lastPerfMs != null && isFinite(phys.lastPerfMs))
      ? Math.min(0.1, Math.max(0, (nowPerfMs - phys.lastPerfMs) / 1000))
      : 0.016;
    phys.lastPerfMs = nowPerfMs;

    // ═══════════════════════════════════════════════════════════════════════════
    // CONTROL SCALAR: A unified control function σ(ε, ω) where:
    //   ε = normalized position error (vehicle position relative to target)
    //   ω = playback speed multiplier (user's tempo setting)
    //
    // The control scalar modulates ALL vehicle physics as a single "throttle":
    //   σ → 0: vehicle stops/crawls (ahead of target, waiting)
    //   σ → 1: vehicle at natural pace (synchronized with playback)
    //   σ → boost: vehicle accelerates (behind target, catching up)
    //
    // This is essentially a proportional controller with soft saturation,
    // allowing granular pathfinding without complex heuristics.
    // ═══════════════════════════════════════════════════════════════════════════

    // (playbackSpeed already declared above for waypoint window)

    // Normalized position error: ε = (targetD - vehicleD) / referenceDistance
    // Positive = behind target (need to catch up)
    // Negative = ahead of target (need to wait)
    // We normalize by the base lookahead to get a dimensionless error in [-∞, +∞]
    const positionError = (targetD - phys.d) / g.MapView.TRAIL_LOOKAHEAD_BASE;

    // Control scalar function using soft-plus / sigmoid blend:
    // σ(ε, ω) = ω · response(ε)
    //
    // response(ε) uses a piecewise smooth function:
    //   ε < -1: response → 0 (way ahead, stop)
    //   ε = 0:  response → 1 (synchronized)
    //   ε > +1: response → 1 + boost (behind, catch up)
    //
    // We use: response(ε) = max(0, 1 + tanh(ε · gain))
    // This gives smooth S-curve behavior with natural saturation.

    const controlGain = 1.5;  // How aggressively to respond to position error
    const maxBoost = 2.0;     // Maximum catch-up multiplier when far behind

    // Smooth response function: tanh provides natural saturation at extremes
    // Shifted so response(0) = 1, response(-∞) → 0, response(+∞) → 1 + maxBoost
    const tanhResponse = Math.tanh(positionError * controlGain);
    const response = Math.max(0, 1 + tanhResponse * (tanhResponse > 0 ? maxBoost : 1));

    // Final control scalar: combines playback speed with position-based response
    // Use sqrt(playbackSpeed) for sub-linear scaling (feels more natural)
    const controlScalar = Math.sqrt(Math.max(1, playbackSpeed)) * response;

    // ═══════════════════════════════════════════════════════════════════════════
    // Apply control scalar to all physics parameters
    // ═══════════════════════════════════════════════════════════════════════════

    const effectiveCruise = vp.cruiseSpeed * controlScalar;
    // Scale curve speed sub-linearly so we slow down relatively more when fast-forwarding
    // This ensures turns look like turns even at 20x speed
    const effectiveCurve = vp.curveSpeed * Math.pow(controlScalar, 0.75);
    const effectiveAccel = vp.accelRate * controlScalar;
    const effectiveBrake = vp.brakeRate * Math.max(1, controlScalar); // Braking never reduced

    // The "visible road" ends at targetD (the playback-time position).
    // Vehicle must NEVER exceed this - it tracks playback time exactly.
    // The control scalar allows catching up when behind, but never running ahead.
    // (Removed dynamic lookahead which caused vehicles to outrun the revealed trail.)
    const visibleEnd = Math.min(targetD, totalDist);

    // Initialize or handle scrub: snap to target, reset velocity
    // Also snap if physics hasn't been initialized yet (d=0 but targetD is far ahead)
    const needsSnap = phys.totalDist !== totalDist || isScrub ||
                      (phys.d === 0 && targetD > 100); // Snap if >100m behind on init
    if (needsSnap) {
      phys.totalDist = totalDist;
      phys.d = targetD;
      phys.v = 0; // Start from rest after scrub
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // AUTONOMOUS AGENT PHYSICS (modulated by control scalar)
    // ═══════════════════════════════════════════════════════════════════════════

    // Look ahead for curves and calculate safe approach speed.
    // Cached: only re-scan when vehicle moves >5m or control scalar shifts >20%.
    if (!this.view._curveLookaheadCache) this.view._curveLookaheadCache = new Map();
    let _clc = this.view._curveLookaheadCache.get(id);
    let safeSpeed;
    const _clcStale = !_clc
      || Math.abs(phys.d - _clc.d) > 5
      || Math.abs(controlScalar - _clc.ctrl) > 0.2 * (_clc.ctrl || 1)
      || needsSnap;
    if (!_clcStale) {
      // Scale cached result by ratio of current vs cached effective cruise
      safeSpeed = _clc.safeSpeed * (effectiveCruise / (_clc.cruise || effectiveCruise));
    } else {
      const lookaheadDist = g.MapView.CURVATURE_LOOKAHEAD * Math.max(1, controlScalar);
      const curveLookaheadEnd = Math.min(phys.d + lookaheadDist, totalDist);
      safeSpeed = effectiveCruise;
      for (let i = vehicleIdx; i < curvature.length; i++) {
        const d = cumDist[i];
        if (d < phys.d) continue;
        if (d > curveLookaheadEnd) break;
        const curv = curvature[i];
        if (curv <= 0.001) continue;
        const curvFactor = g.MapView.CURVATURE_THRESHOLD / (g.MapView.CURVATURE_THRESHOLD + curv);
        const allowedSpeedAtCurve = effectiveCurve + (effectiveCruise - effectiveCurve) * curvFactor;
        const distToCurve = d - phys.d;
        const maxApproachSpeed = Math.sqrt(allowedSpeedAtCurve * allowedSpeedAtCurve + 2 * effectiveBrake * distToCurve);
        if (maxApproachSpeed < safeSpeed) safeSpeed = maxApproachSpeed;
      }
      this.view._curveLookaheadCache.set(id, { d: phys.d, ctrl: controlScalar, cruise: effectiveCruise, safeSpeed });
    }

    // Calculate target speed based on:
    // 1. Distance to end of visible road (brake to stop)
    // 2. Safe speed for curves ahead (calculated above)
    // 3. Effective cruise speed (modulated by control scalar)
    const distToVisibleEnd = visibleEnd - phys.d;

    let targetSpeed;
    if (distToVisibleEnd <= 0) {
      // Already at or past visible end - full stop
      targetSpeed = 0;
    } else if (distToVisibleEnd < g.MapView.STOP_BUFFER) {
      // Very close to visible end - slow crawl proportional to distance
      targetSpeed = Math.min(2 * Math.max(1, controlScalar), distToVisibleEnd * 0.5);
    } else {
      // Distance-limited speed: v² = 2as → v = sqrt(2 * brakeRate * distance)
      // Use a safety factor of 0.8 to ensure we don't overshoot
      const brakeSpeed = Math.sqrt(2 * effectiveBrake * Math.max(0, distToVisibleEnd - g.MapView.STOP_BUFFER)) * 0.8;

      // Take minimum of all limits
      targetSpeed = Math.min(effectiveCruise, brakeSpeed, safeSpeed);
    }

    // Apply acceleration or braking (both scaled by control scalar)
    if (phys.v < targetSpeed) {
      // Accelerate
      phys.v = Math.min(targetSpeed, phys.v + effectiveAccel * dtS);
    } else if (phys.v > targetSpeed) {
      // Brake (never reduced below base rate for safety)
      phys.v = Math.max(targetSpeed, phys.v - effectiveBrake * dtS);
    }

    // Safety clamps
    phys.v = g.clamp(phys.v, 0, effectiveCruise);

    // Update position - but don't exceed visible end
    const proposedD = phys.d + phys.v * dtS;
    if (proposedD >= visibleEnd) {
      // Would overshoot - clamp to visible end and stop
      phys.d = visibleEnd;
      phys.v = 0;
    } else {
      phys.d = proposedD;
    }

    // Cannot go backwards or past total path end
    phys.d = g.clamp(phys.d, 0, totalDist);

    // ═══════════════════════════════════════════════════════════════════════════
    // WAYPOINT STEERING: Vehicle has 2D position that steers toward waypoints
    // instead of being locked to a rail. The physics distance (phys.d) determines
    // which waypoint to target, but the actual position uses steering dynamics.
    // ═══════════════════════════════════════════════════════════════════════════

    // Sample raw path position (where GPS says we should be)
    const rawSample = this.view._samplePathAtDistance(pts, cumDist, curvature, phys.d);

    // ═══════════════════════════════════════════════════════════════════════════
    // PROGRESSIVE SPLINE SAMPLING
    //
    // The waypoint window now comes from a PROGRESSIVE spline path where:
    // - Past segments are LOCKED (computed with tension at time of traversal)
    // - Future segments use CURRENT tension (based on current speed)
    //
    // The vehicle samples its position from this progressive path, which is
    // indexed by cumulative distance. We map phys.d (raw GPS distance) to the
    // progressive path's cumulative distance.
    // ═══════════════════════════════════════════════════════════════════════════

    let waypointSample;
    if (waypointWindow && smoothWaypoints.length >= 2) {
      // The progressive path has its own cumulative distances
      // Map phys.d (distance on raw GPS) to progressive path distance
      //
      // Strategy: Find the computed path point corresponding to our raw distance
      // by interpolating based on rawIdx values in the computed points

      // Get the full progressive path for this vehicle
      const path = this.view._vehiclePathById?.get(id);
      if (path && path.computedPts.length >= 2) {
        const cpts = path.computedPts;
        const ccum = path.cumDist;

        // Find where phys.d falls in raw GPS cumDist
        let rawIdx = 0;
        let rawFrac = 0;
        for (let i = 0; i < cumDist.length - 1; i++) {
          if (cumDist[i + 1] >= phys.d) {
            rawIdx = i;
            const segLen = cumDist[i + 1] - cumDist[i];
            rawFrac = segLen > 0 ? (phys.d - cumDist[i]) / segLen : 0;
            break;
          }
          rawIdx = i;
        }
        const rawIdxFrac = rawIdx + rawFrac;

        // Find corresponding position in computed path
        let compIdx = 0;
        for (let i = 0; i < cpts.length - 1; i++) {
          if (cpts[i + 1].rawIdx >= rawIdxFrac) {
            compIdx = i;
            break;
          }
          compIdx = i;
        }

        // Interpolate between computed points
        const cp0 = cpts[compIdx];
        const cp1 = cpts[Math.min(cpts.length - 1, compIdx + 1)];
        const rawIdxSpan = cp1.rawIdx - cp0.rawIdx;
        const t = rawIdxSpan > 0 ? g.clamp((rawIdxFrac - cp0.rawIdx) / rawIdxSpan, 0, 1) : 0;

        waypointSample = {
          lat: cp0.lat + t * (cp1.lat - cp0.lat),
          lon: cp0.lon + t * (cp1.lon - cp0.lon),
          heading: Math.atan2(cp1.lat - cp0.lat, cp1.lon - cp0.lon),
          m: cp1.m,
          readings: cp1.readings
        };
      } else {
        waypointSample = rawSample;
      }
    } else {
      // Fallback: use raw sample
      waypointSample = rawSample;
    }

    // Initialize 2D physics state if needed (use needsSnap from earlier)
    if (phys.lat == null || phys.lon == null || needsSnap) {
      // Start at raw GPS position (not spline, to avoid teleport on speed change)
      phys.lat = rawSample.lat;
      phys.lon = rawSample.lon;
      phys.heading = rawSample.heading;
    }

    // Steering toward RAW GPS position with damping
    // This ensures vehicle never teleports when speed changes (spline recomputes).
    // Physics provides natural smoothing through steering inertia.
    // Skip steering blend when actively scrubbing — marker must track controller exactly.
    if (!this.view._scrubbing) {
      const STEER_RATE = 3.0; // How fast to steer toward waypoint (higher = snappier)
      const steerFactor = 1 - Math.exp(-STEER_RATE * dtS);

      // Blend current position toward raw GPS sample
      phys.lat += steerFactor * (rawSample.lat - phys.lat);
      phys.lon += steerFactor * (rawSample.lon - phys.lon);

      // Smooth heading toward raw GPS heading
      let headingDiff = rawSample.heading - phys.heading;
      // Wrap to [-π, π]
      while (headingDiff > Math.PI) headingDiff -= 2 * Math.PI;
      while (headingDiff < -Math.PI) headingDiff += 2 * Math.PI;
      phys.heading += steerFactor * headingDiff;
    }

    // Record actual vehicle path for debug visualization
    // This captures the dynamically computed steering path, not the waypoints
    if (this.view._pbDebugPath) {
      if (!this.view._vehicleActualPathById) this.view._vehicleActualPathById = new Map();
      let actualPath = this.view._vehicleActualPathById.get(id);
      if (!actualPath || needsSnap) {
        actualPath = [];
        this.view._vehicleActualPathById.set(id, actualPath);
      }
      // Record position at regular distance intervals to avoid excessive points
      const lastPt = actualPath.length > 0 ? actualPath[actualPath.length - 1] : null;
      const recordInterval = 2; // meters between recorded points
      if (!lastPt || Math.abs(phys.d - lastPt.d) >= recordInterval) {
        actualPath.push({ lat: phys.lat, lon: phys.lon, d: phys.d });
        // Limit buffer size - keep window around current position
        const maxBehind = 50; // points behind vehicle
        const maxAhead = 10; // points ahead (from scrub-back)
        while (actualPath.length > maxBehind + maxAhead) {
          // Remove oldest point if it's behind current position
          if (actualPath[0].d < phys.d - maxBehind * recordInterval) {
            actualPath.shift();
          } else {
            break;
          }
        }
      }
    }

    const lat = phys.lat;
    const lon = phys.lon;
    const heading = phys.heading;
    const { idx, u, p0, p1 } = rawSample;

    // Get segment info for readings and visibility (from raw path)
    const nextPoint = p1 || pts[Math.min(idx + 1, pts.length - 1)];
    const prevPoint = p0 || pts[idx];
    const dtMs = Math.max(1, (nextPoint.tMs - prevPoint.tMs));

    // Calculate vehicle's actual time position (for trail reveal)
    // Interpolate time based on position within segment
    const vehicleTMs = prevPoint.tMs + (nextPoint.tMs - prevPoint.tMs) * u;

    // Calculate true GPS speed for the current segment (real-world speed)
    // We use the raw segment (idx) that the vehicle is currently traversing
    let trueSpeedMps = 0;
    if (idx < pts.length - 1) {
      const pStart = pts[idx];
      const pEnd = pts[idx + 1];
      const distM = cumDist[idx + 1] - cumDist[idx];
      const timeS = (pEnd.tMs - pStart.tMs) / 1000;
      if (timeS > 0.1) {
        trueSpeedMps = distM / timeS;
      }
    }

    // Use true GPS speed for display, not the playback-scaled physics velocity
    // let speedMps = phys.v;
    let speedMps = trueSpeedMps;
    if (t >= tMax - 1) speedMps = 0;

    // Determine transient visibility
    let opacity = 1.0;
    const dimOpacity = 0.25;
    const movingFlag = !!(nextPoint && (nextPoint.m === 1 || nextPoint.m === "1" || nextPoint.m === true));
    if (!m._key) m._key = g.keyFor("mobile", m.id);
    const key = m._key;
    const isSel = (this.view.selectedId === key);

    if (!movingFlag && !this.view._pbDebugPath && !isSel) {
      opacity = dimOpacity;
    }

    if (dtMs > 305000 && t > prevPoint.tMs + 5000 && t < nextPoint.tMs - 5000 && !this.view._pbDebugPath && !isSel) {
      opacity = dimOpacity;
    }

    // Convert lat/lon heading to screen heading (Mercator projection).
    // Cached: skip 2× latLonToWorld + atan2 when position/zoom barely changed.
    if (!this.view._screenHeadingCache) this.view._screenHeadingCache = new Map();
    let _shc = this.view._screenHeadingCache.get(id);
    let screenHeading;
    const _shcStale = !_shc || needsSnap
      || Math.abs(lat - _shc.lat) > 1e-6 || Math.abs(lon - _shc.lon) > 1e-6
      || Math.abs(heading - _shc.heading) > 0.01 || this.view.zoom !== _shc.zoom;
    if (!_shcStale) {
      screenHeading = _shc.screenHeading;
    } else {
      const currWorld = g.latLonToWorld(lat, lon, this.view.zoom);
      const epsilon = 0.0001;
      const aheadWorld = g.latLonToWorld(
        lat + Math.sin(heading) * epsilon,
        lon + Math.cos(heading) * epsilon,
        this.view.zoom
      );
      let dx = aheadWorld.x - currWorld.x;
      let dy = aheadWorld.y - currWorld.y;
      if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) { dx = 1e-3; dy = 0; }
      screenHeading = Math.atan2(dy, dx);
      this.view._screenHeadingCache.set(id, { lat, lon, heading, zoom: this.view.zoom, screenHeading });
    }

    const absH = Math.abs(screenHeading);
    const dead = 0.22;
    const switchToLeft = (Math.PI / 2) + dead;
    const switchToRight = (Math.PI / 2) - dead;
    let side = this.view._traceLastSideById.get(id);
    if (side !== "L" && side !== "R") side = (absH > Math.PI / 2) ? "L" : "R";
    if (side === "R" && absH > switchToLeft) side = "L";
    else if (side === "L" && absH < switchToRight) side = "R";
    this.view._traceLastSideById.set(id, side);

    let renderAngle = screenHeading;
    if (side === "L") renderAngle = Math.PI - screenHeading;
    if (renderAngle > Math.PI) renderAngle -= Math.PI * 2;
    if (renderAngle < -Math.PI) renderAngle += Math.PI * 2;

    const wrapAngle = (ang) => {
      let x = ang;
      while (x > Math.PI) x -= Math.PI * 2;
      while (x < -Math.PI) x += Math.PI * 2;
      return x;
    };
    const prevA = this.view._traceAngleById.get(id);
    const lastMs = this.view._traceAngleLastMsById.get(id);
    const dtAngleS = (lastMs != null && isFinite(lastMs)) ? Math.max(0, (nowPerfMs - lastMs) / 1000) : 0;
    const tauS = 0.25; // Slightly faster angle response for responsiveness
    const alpha = dtAngleS > 0 ? (1 - Math.exp(-dtAngleS / tauS)) : 1;
    const nextA = (prevA == null)
      ? renderAngle
      : wrapAngle(prevA + wrapAngle(renderAngle - prevA) * alpha);
    this.view._traceAngleById.set(id, nextA);
    this.view._traceAngleLastMsById.set(id, nowPerfMs);

    // Marker reading: use the segment at the PHYSICS position (phys.d), not time position.
    // idx and nextPoint are from _samplePathAtDistance(phys.d) - they match where the marker is drawn.
    const reading = g.primaryReadingKeyedFromPoint(nextPoint);

    // Store debug info for trail drawing
    if (!this.view._vehicleRevealDist) this.view._vehicleRevealDist = new Map();
    this.view._vehicleRevealDist.set(id, {
      d: targetD,                // Playback-time position
      visibleEnd,                // Where vehicle stops (= targetD, no lookahead)
      vehicleD: phys.d,          // Actual vehicle position (for debug)
      vehicleV: phys.v,          // Actual vehicle velocity (for debug)
      vehicleTMs,                // Actual vehicle time (for trail reveal)
      controlScalar,             // Control scalar σ(ε, ω) for debug
      positionError,             // Normalized position error ε
      totalDist
    });

    return { lat, lon, angle: nextA, flipX: (side === "L"), speedMps, opacity, reading, readings: nextPoint.readings, beforeFirst: t < tMin };
  };

  PlaybackEngine.prototype._ensureTracePoints = function (state) {
    const key = this._tracePointsKeyForState(state);
    if (this.view._tracePtsKey === key) return;
    this.view._tracePtsKey = key;

    const nextPtsById = new Map();
    const nextRoutesById = new Map();
    const mobiles = Array.isArray(state?.mobile) ? state.mobile : [];
    for (const m of mobiles) {
      const id = m && m.id ? String(m.id) : "";
      if (!id) continue;

      // Idle/ghosted vehicles should not produce trace routes.
      // Clear any prior active/pending route so the marker stays stationary.
      if (m && m.ghosted) {
        this.view._traceActiveRouteById.delete(id);
        this.view._tracePendingRouteById.delete(id);
        this.view._traceCycleStartMsById.delete(id);
        continue;
      }

      const trail = Array.isArray(m?.trail) ? m.trail : [];
      const pts = [];
      const hasServerTrail = (trail.length >= 2);
      const hasActiveRoute = this.view._traceActiveRouteById.has(id);
      const persisted = (this.view._persistedTrailById.get(id)?.trail || []);

      // If the server drops history for a cycle (refresh/TTL/etc), do NOT replace
      // an active route with a tiny cached tail. Keep the last route so the bus
      // stays on its path until we have a real trail again.
      if (!hasServerTrail && hasActiveRoute) {
        this.view._tracePendingRouteById.delete(id);
        continue;
      }

      // Trace mode should replay the full path accumulated since the app started.
      // Prefer persisted trail (which accumulates) when available; otherwise fall back to server trail.
      const src = (persisted.length >= 2) ? persisted : trail;
      if (src.length < 2) continue;

      // Build time-aware points. If timestamps are missing, synthesize a stable time series.
      const t0 = (src[0] && typeof src[0].t === "string") ? g.parseUtcMs(src[0].t) : null;
      const baseMs = (t0 != null) ? t0 : 0;
      const synthStepMs = 3000;

      for (let i = 0; i < src.length; i++) {
        const p = src[i];
        const lat = Number(p.lat), lon = Number(p.lon);
        if (!isFinite(lat) || !isFinite(lon)) continue;
        const tMsRaw = (p && typeof p.t === "string") ? g.parseUtcMs(p.t) : null;
        const tMs = (tMsRaw != null) ? tMsRaw : (baseMs + (i * synthStepMs));
        pts.push({ lat, lon, tMs, m: p.m });
      }

      if (pts.length >= 2) {
        nextPtsById.set(id, pts);

        // Precompute a smoothed, bus-like time model:
        // - Base on real GPS time deltas when present (relative speed changes)
        // - Normalize to a watchable speed (so sparse GPS doesn't crawl)
        // - Low-pass filter speeds so accel/brake is gradual
        // - Add dwell time for stop-like segments
        const pauseMs = 5000;
        const vmax = Number(this.view._traceMaxSpeedMps) || 18;
        const realVmax = Number(this.view._traceRealMaxSpeedMps) || 20.0;
        const targetMedian = Number(this.view._traceTargetMedianSpeedMps) || 7.0;
        const tau = Number(this.view._traceSpeedSmoothingTauS) || 1.6;
        const stopV = Number(this.view._traceStopSpeedMps) || 0.25;
        const dwellCompress = Number(this.view._traceDwellTimeCompression) || 12.0;
        const stopMinMs = Number(this.view._traceStopMinMs) || 350;
        const stopMaxMs = Number(this.view._traceStopMaxMs) || 3500;

        // First pass: derive raw speeds from GPS timing.
        const rawV = [];
        const distM = [];
        const dtRawS = [];
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i];
          const b = pts[i + 1];
          const dist = g.haversineMeters(a.lat, a.lon, b.lat, b.lon);
          let dtRaw = (b.tMs - a.tMs);
          if (!isFinite(dtRaw) || dtRaw <= 0) dtRaw = synthStepMs;
          const dtS = Math.max(0.2, dtRaw / 1000);
          const v = dist / dtS;
          distM.push(dist);
          dtRawS.push(dtS);
          rawV.push(isFinite(v) ? v : 0);
        }

        // Robust scale: map median moving speed to targetMedian.
        const moving = rawV
          .map((v, i) => ({ v, i }))
          .filter(x => isFinite(x.v) && x.v > 0.4 && distM[x.i] > 8);
        let scale = 1.0;
        if (moving.length >= 3) {
          const sorted = moving.map(x => x.v).sort((a, b) => a - b);
          const mid = Math.floor(sorted.length / 2);
          const med = (sorted.length % 2) ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
          if (isFinite(med) && med > 0.001) {
            scale = g.clamp(targetMedian / med, 0.8, 25.0);
          }
        }

        const segStartMs = [];
        const segDurMs = [];
        const segSpeedMps = []; // playback effective speed (m/s)
        const segRealSpeedMps = []; // GPS-derived speed (m/s)
        let tCum = 0;
        let vSmooth = 0;
        let vRealSmooth = 0;

        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i];
          const b = pts[i + 1];
          const dist = distM[i] || 0;
          const dtS = dtRawS[i] || 1.0;

          // Target speed from GPS, normalized to watchable playback.
          let vTarget = rawV[i] * scale;
          if (!isFinite(vTarget)) vTarget = 0;
          vTarget = g.clamp(vTarget, 0, vmax);

          const isStopLike = (dist < 3) || (vTarget < stopV);

          const alpha = 1 - Math.exp(-dtS / tau);
          vSmooth = vSmooth + alpha * (vTarget - vSmooth);

          let dtEff;
          if (isStopLike) {
            // Dwell based on how long the GPS stayed "there", but compressed.
            dtEff = (dtS * 1000) / Math.max(1.0, dwellCompress);
            dtEff = g.clamp(dtEff, stopMinMs, stopMaxMs);
            segSpeedMps.push(0);
            segRealSpeedMps.push(0);
          } else {
            const vEff = Math.max(0.8, Math.min(vSmooth, vmax));
            dtEff = (dist / vEff) * 1000;
            dtEff = g.clamp(dtEff, 120, 8000);
            segSpeedMps.push(dist > 0 ? (dist / Math.max(0.001, dtEff / 1000)) : 0);

            // Real-world speed estimate from GPS timing (not normalized playback).
            let vReal = rawV[i];
            if (!isFinite(vReal)) vReal = 0;
            vReal = g.clamp(vReal, 0, realVmax);
            const alphaReal = 1 - Math.exp(-dtS / Math.max(0.8, tau));
            vRealSmooth = vRealSmooth + alphaReal * (vReal - vRealSmooth);
            segRealSpeedMps.push(g.clamp(vRealSmooth, 0, realVmax));
          }

          segStartMs.push(tCum);
          segDurMs.push(dtEff);
          tCum += dtEff;
        }

        const driveMs = Math.max(1, tCum);

        // NOTE: "rewind at the end of time" logic (loop return) is intentionally disabled.
        // This used to add a fast "return" segment after reaching the end, which makes the
        // playback jump back toward the loop start.
        //
        // // Prevent loop "teleport": after pausing at the end, drive back to the loop start quickly.
        // const loopStartPt = pts[0];
        // const endPt = pts[pts.length - 1] || loopStartPt;
        // const backDistM = haversineMeters(endPt.lat, endPt.lon, loopStartPt.lat, loopStartPt.lon);
        // const returnMs = (isFinite(backDistM) && backDistM > 3)
        //   ? clamp(1000 + (backDistM / 250) * 1000, 1000, 3000)
        //   : 0;
        // const totalMsWithReturn = driveMs + pauseMs + returnMs;

        const loopStartPt = pts[0];
        const returnMs = 0;
        const totalMsWithReturn = driveMs + pauseMs;

        nextRoutesById.set(id, {
          pts,
          segStartMs,
          segDurMs,
          segSpeedMps,
          segRealSpeedMps,
          driveMs,
          pauseMs,
          returnMs,
          loopStartLat: loopStartPt.lat,
          loopStartLon: loopStartPt.lon,
          totalMs: totalMsWithReturn,
          newPathStartMs: 0,
        });
      }
    }

    // Replace the points cache for debugging/introspection purposes.
    this.view._tracePtsById.clear();
    for (const [id, pts] of nextPtsById.entries()) this.view._tracePtsById.set(id, pts);

    // Route swapping behavior:
    // - If we don't have an active route for an id, adopt immediately.
    // - If we do, store as pending and swap only when the loop restarts.
    for (const [id, route] of nextRoutesById.entries()) {
      if (this.view._traceActiveRouteById.has(id)) this.view._tracePendingRouteById.set(id, route);
      else this.view._traceActiveRouteById.set(id, route);
    }
  };

  return PlaybackEngine;
});
