/**
 * engine_vehicle_motion.js — VehicleMotion: per-vehicle autonomous physics,
 * progressive Catmull-Rom path smoothing, sliding-window waypoint steering,
 * and path-distance/curvature caches.
 *
 * MapView keeps shared view state (playback pts/keys/speed, scrub state, the
 * per-vehicle physics/path/smooth-path/path-distance caches — shared because
 * `clearVehicleCaches()`, `_prunePerMobileCachesForState()`, and the
 * not-yet-extracted `_playbackSampleForMobile`/`_requestFoveatedRoadMatching`
 * also read/write them directly) and exposes it via `this.view`. MapView's
 * own vehicle-physics/path methods become one-line delegates to
 * `this.vehicleMotion.<method>()`.
 *
 * Shared MapView fields read/written here (kept on MapView, not moved,
 * because non-moved code also touches them): _vehiclePhysicsCache,
 * _physicsStateById, _vehiclePathById, _smoothPathCache, _pathDistCache,
 * _playbackPtsKey, _playbackSpeed.
 *
 * Physics/waypoint tuning constants (CRUISE_SPEED, WAYPOINT_*, JITTER_*,
 * etc.) remain `static` on the MapView class itself (unit tests in
 * vehicle_physics.test.cjs mirror their values; other MapView code also
 * reads them via `MapView.XXX`) — resolved here via the global `MapView`.
 */
(function (root, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else {
    root.VehicleMotion = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Globals from earlier-loaded scripts (data_utils.js for haversineMeters,
  // projections.js for clamp, map_view.js for the MapView class + its static
  // physics/waypoint constants) are resolved lazily at call time — never at
  // module factory time (node tests have no browser globals).
  var g = (typeof window !== "undefined") ? window : globalThis;

  /**
   * @param {object} view — MapView instance (owns shared playback/cache
   *   state; see file header for the full shared-field list).
   */
  function VehicleMotion(view) {
    this.view = view;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // AUTONOMOUS AGENT PHYSICS: Vehicles behave like self-driving agents that see
  // the revealed trail ahead and drive naturally - accelerating on straights,
  // braking for curves, and stopping at the end of visible road.
  //
  // Key principles:
  // 1. Trail reveals at targetD + dynamic lookahead (the "visible road")
  // 2. Vehicle is FREE AGENT that follows visible road, not locked to playback time
  // 3. Physics match wall-clock time, but position decouples during scrubbing
  // 4. GPS data points act as checkpoints for ground truth
  // ─────────────────────────────────────────────────────────────────────────────

  // Deterministic hash for vehicle ID -> [0, 1)
  VehicleMotion.prototype._hashId = function (id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) {
      h = ((h << 5) - h + id.charCodeAt(i)) | 0;
    }
    return ((h & 0x7fffffff) % 10000) / 10000;
  };

  // Get per-vehicle physics parameters (deterministic variation from ID)
  VehicleMotion.prototype._getVehiclePhysics = function (id) {
    const view = this.view;
    if (!view._vehiclePhysicsCache) view._vehiclePhysicsCache = new Map();
    let vp = view._vehiclePhysicsCache.get(id);
    if (vp) return vp;

    const h1 = this._hashId(id);
    const h2 = this._hashId(id + "_2");
    const h3 = this._hashId(id + "_3");
    const vary = g.MapView.PHYSICS_VARIATION;

    // Each vehicle gets slightly different cruise/curve speeds and acceleration
    vp = {
      cruiseSpeed: g.MapView.CRUISE_SPEED * (1 + (h1 - 0.5) * 2 * vary),
      curveSpeed: g.MapView.CURVE_SPEED * (1 + (h2 - 0.5) * 2 * vary),
      accelRate: g.MapView.ACCEL_RATE * (1 + (h3 - 0.5) * 2 * vary),
      brakeRate: g.MapView.BRAKE_RATE * (1 + (this._hashId(id + "_4") - 0.5) * 2 * vary),
    };

    view._vehiclePhysicsCache.set(id, vp);
    return vp;
  };

  // Per-vehicle physics state: { d: current distance along path (meters),
  //                              v: velocity (m/s along path), lastPerfMs }

  VehicleMotion.prototype._getPhysicsState = function (id) {
    const view = this.view;
    if (!view._physicsStateById) view._physicsStateById = new Map();
    let st = view._physicsStateById.get(id);
    if (!st) {
      st = { d: 0, v: 0, lastPerfMs: null, totalDist: 0 };
      view._physicsStateById.set(id, st);
    }
    return st;
  };

  VehicleMotion.prototype._resetPhysicsState = function (id) {
    const view = this.view;
    if (view._physicsStateById) view._physicsStateById.delete(id);
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // SLIDING WINDOW WAYPOINT STEERING
  //
  // Waypoints are computed incrementally in sliding window chunks around the
  // vehicle position. Each chunk depends on previous waypoints (memoizable).
  // The look-ahead distance varies with playback speed.
  //
  // This avoids reprocessing the entire path - only computes what's needed.
  // ═══════════════════════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════════════════════
  // PROGRESSIVE SPLINE PATH
  //
  // The vehicle's path is computed PROGRESSIVELY as it advances. When the
  // vehicle passes a GPS waypoint, we compute the spline segment from that
  // waypoint to the next using the CURRENT tension (based on current speed).
  //
  // Key insight: Once a spline segment is computed, it's LOCKED. When speed
  // changes, only FUTURE segments (not yet reached) use the new tension.
  // This prevents the vehicle from "snapping" when speed changes.
  //
  // Structure:
  //   _vehiclePathById: Map<id, {
  //     computedPts: [{lat, lon, rawIdx, tMs, m, readings}],  // progressive spline
  //     cumDist: [],           // cumulative distances for computedPts
  //     lastRawIdx: number,    // last raw GPS index we've computed past
  //   }>
  // ═══════════════════════════════════════════════════════════════════════════

  // Get or create the progressive path for a vehicle
  VehicleMotion.prototype._getVehiclePath = function (id, pts) {
    const view = this.view;
    if (!view._vehiclePathById) view._vehiclePathById = new Map();

    let path = view._vehiclePathById.get(id);
    const ptsKey = view._playbackPtsKey;

    // Reset if pts changed (different recording loaded)
    if (path && path.ptsKey !== ptsKey) {
      path = null;
    }

    if (!path) {
      // Initialize with first GPS point
      const p0 = pts[0];
      path = {
        computedPts: [{
          lat: p0.lat,
          lon: p0.lon,
          rawIdx: 0,
          tMs: p0.tMs,
          m: p0.m,
          readings: p0.readings
        }],
        cumDist: [0],
        lastRawIdx: 0,
        ptsKey
      };
      view._vehiclePathById.set(id, path);
    }

    return path;
  };

  // Extend the progressive path up to (and past) targetRawIdx
  // Uses current playback speed to determine spline tension for NEW segments only
  // CRITICAL: If tension changed, invalidate segments AHEAD of vehicle and recompute
  VehicleMotion.prototype._extendVehiclePath = function (id, pts, targetRawIdx, playbackSpeed, vehicleRawIdx) {
    const path = this._getVehiclePath(id, pts);
    const n = pts.length;

    // Spline tension from current speed
    // HIGH tension = TIGHT curves (follows GPS closely) - for LOW speed
    // LOW tension = SMOOTH curves (wider arcs) - for HIGH speed
    // At 1x: tension = 0.85 (tight, follows GPS)
    // At 20x: tension ~ 0.33 (smooth, wide arcs)
    const tension = Math.max(0.2, 0.85 - 0.12 * Math.log2(Math.max(1, playbackSpeed)));
    const tensionKey = Math.round(tension * 100);

    // If tension changed and we have segments ahead of vehicle, invalidate them
    if (path.lastTensionKey !== undefined && path.lastTensionKey !== tensionKey) {
      // Find where vehicle is in computed path
      const vehRawIdx = vehicleRawIdx || 0;

      // Truncate: keep only points up to current vehicle position
      // Find the last computed point that's AT or BEFORE vehicle
      let keepUpToIdx = 0;
      for (let i = 0; i < path.computedPts.length; i++) {
        if (path.computedPts[i].rawIdx <= vehRawIdx) {
          keepUpToIdx = i;
        } else {
          break;
        }
      }

      // Truncate arrays
      if (keepUpToIdx < path.computedPts.length - 1) {
        path.computedPts = path.computedPts.slice(0, keepUpToIdx + 1);
        path.cumDist = path.cumDist.slice(0, keepUpToIdx + 1);
        path.lastRawIdx = Math.floor(path.computedPts[keepUpToIdx].rawIdx);
      }
    }
    path.lastTensionKey = tensionKey;

    // Already computed past this index?
    if (path.lastRawIdx >= targetRawIdx) {
      return path;
    }

    const s = (1 - tension) / 2;

    // Catmull-Rom interpolation
    const catmullRom = (p0, p1, p2, p3, t) => {
      const t2 = t * t;
      const t3 = t2 * t;
      const h1 = -s * t3 + 2 * s * t2 - s * t;
      const h2 = (2 - s) * t3 + (s - 3) * t2 + 1;
      const h3 = (s - 2) * t3 + (3 - 2 * s) * t2 + s * t;
      const h4 = s * t3 - s * t2;
      return {
        lat: h1 * p0.lat + h2 * p1.lat + h3 * p2.lat + h4 * p3.lat,
        lon: h1 * p0.lon + h2 * p1.lon + h3 * p2.lon + h4 * p3.lon
      };
    };

    const SAMPLES_PER_SEGMENT = 4;

    // Extend from lastRawIdx to targetRawIdx
    for (let i = path.lastRawIdx; i < targetRawIdx && i < n - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[i];
      const p2 = pts[Math.min(n - 1, i + 1)];
      const p3 = pts[Math.min(n - 1, i + 2)];

      // Add interpolated points for segment i → i+1
      for (let si = 1; si <= SAMPLES_PER_SEGMENT; si++) {
        const t = si / (SAMPLES_PER_SEGMENT + 1);
        const interp = catmullRom(p0, p1, p2, p3, t);

        const newPt = {
          lat: interp.lat,
          lon: interp.lon,
          rawIdx: i + t,
          tMs: p1.tMs + t * (p2.tMs - p1.tMs),
          m: p2.m,
          readings: p2.readings
        };

        // Compute distance from last point
        const lastPt = path.computedPts[path.computedPts.length - 1];
        const segDist = g.haversineMeters(lastPt.lat, lastPt.lon, newPt.lat, newPt.lon);

        path.computedPts.push(newPt);
        path.cumDist.push(path.cumDist[path.cumDist.length - 1] + segDist);
      }

      // Add the endpoint (GPS point i+1)
      const endPt = {
        lat: p2.lat,
        lon: p2.lon,
        rawIdx: i + 1,
        tMs: p2.tMs,
        m: p2.m,
        readings: p2.readings
      };

      const lastPt = path.computedPts[path.computedPts.length - 1];
      const segDist = g.haversineMeters(lastPt.lat, lastPt.lon, endPt.lat, endPt.lon);

      path.computedPts.push(endPt);
      path.cumDist.push(path.cumDist[path.cumDist.length - 1] + segDist);

      path.lastRawIdx = i + 1;
    }

    return path;
  };

  // Get sliding window of waypoints around vehicle position from PROGRESSIVE path
  // Returns { waypoints, startIdx, endIdx, cumDist, curvature }
  VehicleMotion.prototype._getWaypointWindow = function (id, pts, vehicleIdx, playbackSpeed) {
    const n = pts.length;
    if (n < 2) return null;

    // Extend progressive path to cover ahead of vehicle
    const aheadCount = g.MapView.WAYPOINT_AHEAD_BASE +
                       Math.floor(g.MapView.WAYPOINT_AHEAD_PER_SPEED * Math.max(1, playbackSpeed));
    const targetRawIdx = Math.min(n - 1, vehicleIdx + aheadCount);

    // Pass vehicleIdx so _extendVehiclePath can invalidate segments ahead when tension changes
    const path = this._extendVehiclePath(id, pts, targetRawIdx, playbackSpeed, vehicleIdx);

    // Find window in computed path
    const behindCount = g.MapView.WAYPOINT_BEHIND;
    const cpts = path.computedPts;
    const ccum = path.cumDist;

    // Find index in computed path corresponding to vehicleIdx
    let vehicleComputedIdx = 0;
    for (let i = 0; i < cpts.length; i++) {
      if (cpts[i].rawIdx >= vehicleIdx) {
        vehicleComputedIdx = i;
        break;
      }
      vehicleComputedIdx = i;
    }

    // Window bounds in computed path (5 samples per GPS segment)
    const SAMPLES_PER_SEG = 5; // 4 interpolated + 1 endpoint
    const startComputedIdx = Math.max(0, vehicleComputedIdx - behindCount * SAMPLES_PER_SEG);
    const endComputedIdx = Math.min(cpts.length - 1, vehicleComputedIdx + aheadCount * SAMPLES_PER_SEG);

    // Extract window
    const windowPts = cpts.slice(startComputedIdx, endComputedIdx + 1);
    const windowCumDist = [];
    const baseDist = ccum[startComputedIdx];
    for (let i = startComputedIdx; i <= endComputedIdx; i++) {
      windowCumDist.push(ccum[i] - baseDist);
    }
    const totalDist = windowCumDist[windowCumDist.length - 1] || 1;

    // Compute curvature for window
    const wn = windowPts.length;
    const curvature = new Array(wn).fill(0);
    if (wn >= 3) {
      for (let i = 1; i < wn - 1; i++) {
        const dx1 = windowPts[i].lon - windowPts[i-1].lon;
        const dy1 = windowPts[i].lat - windowPts[i-1].lat;
        const dx2 = windowPts[i+1].lon - windowPts[i].lon;
        const dy2 = windowPts[i+1].lat - windowPts[i].lat;

        const a1 = Math.atan2(dy1, dx1);
        const a2 = Math.atan2(dy2, dx2);
        let angleDiff = Math.abs(a2 - a1);
        if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;

        const dist = (windowCumDist[i] - windowCumDist[i-1] + windowCumDist[i+1] - windowCumDist[i]) / 2;
        curvature[i] = dist > 0.1 ? angleDiff / dist : 0;
      }
    }

    return {
      waypoints: windowPts,
      startIdx: startComputedIdx,
      endIdx: endComputedIdx,
      cumDist: windowCumDist,
      totalDist,
      curvature,
      // For mapping raw distance to window distance
      startRawIdx: cpts[startComputedIdx]?.rawIdx || 0,
      endRawIdx: cpts[endComputedIdx]?.rawIdx || n - 1,
      fullCumDist: ccum,
      fullStartIdx: startComputedIdx
    };
  };

  // Legacy: Get full smooth path (for compatibility with debug display)
  // Delegates to window-based computation
  VehicleMotion.prototype._getSmoothPath = function (id, pts) {
    const view = this.view;
    if (!view._smoothPathCache) view._smoothPathCache = new Map();
    const cached = view._smoothPathCache.get(id);
    if (cached && cached.ptsLen === pts.length && cached.ptsKey === view._playbackPtsKey) {
      return cached;
    }

    const n = pts.length;
    if (n < 2) {
      const single = {
        waypoints: pts.slice(),
        cumDist: [0],
        totalDist: 0,
        curvature: [0],
        origIdxMap: [0],
        ptsLen: n,
        ptsKey: view._playbackPtsKey
      };
      view._smoothPathCache.set(id, single);
      return single;
    }

    // Compute full path using window function (for debug display)
    const playbackSpeed = view._playbackSpeed || 1.0;
    const fullWindow = this._getWaypointWindow(id, pts, Math.floor(n / 2), playbackSpeed);

    // If window doesn't cover full path, compute remaining
    const waypoints = [];
    for (let i = 0; i < n; i++) {
      const p = pts[i];

      // Simple jitter smoothing for full path
      let sumLat = 0, sumLon = 0, count = 0;
      for (let j = Math.max(0, i - 1); j <= Math.min(n - 1, i + 1); j++) {
        sumLat += pts[j].lat;
        sumLon += pts[j].lon;
        count++;
      }
      const avgLat = sumLat / count;
      const avgLon = sumLon / count;

      const deviationM = g.haversineMeters(p.lat, p.lon, avgLat, avgLon);

      let smoothLat, smoothLon;
      if (deviationM < g.MapView.JITTER_THRESHOLD_M && i > 0 && i < n - 1) {
        const blend = g.MapView.JITTER_BLEND;
        smoothLat = p.lat + blend * (avgLat - p.lat);
        smoothLon = p.lon + blend * (avgLon - p.lon);
      } else {
        smoothLat = p.lat;
        smoothLon = p.lon;
      }

      waypoints.push({
        lat: smoothLat,
        lon: smoothLon,
        origIdx: i,
        tMs: p.tMs,
        m: p.m,
        readings: p.readings
      });
    }

    // Build distance table
    const wn = waypoints.length;
    const cumDist = new Array(wn);
    cumDist[0] = 0;
    for (let i = 1; i < wn; i++) {
      const segDist = g.haversineMeters(waypoints[i-1].lat, waypoints[i-1].lon, waypoints[i].lat, waypoints[i].lon);
      cumDist[i] = cumDist[i-1] + segDist;
    }
    const totalDist = cumDist[wn - 1] || 1;

    // Compute curvature
    const curvature = new Array(wn).fill(0);
    if (wn >= 3) {
      for (let i = 1; i < wn - 1; i++) {
        const dx1 = waypoints[i].lon - waypoints[i-1].lon;
        const dy1 = waypoints[i].lat - waypoints[i-1].lat;
        const dx2 = waypoints[i+1].lon - waypoints[i].lon;
        const dy2 = waypoints[i+1].lat - waypoints[i].lat;

        const a1 = Math.atan2(dy1, dx1);
        const a2 = Math.atan2(dy2, dx2);
        let angleDiff = Math.abs(a2 - a1);
        if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;

        const dist = (cumDist[i] - cumDist[i-1] + cumDist[i+1] - cumDist[i]) / 2;
        curvature[i] = dist > 0.1 ? angleDiff / dist : 0;
      }
    }

    const origIdxMap = waypoints.map(w => w.origIdx);

    const result = {
      waypoints,
      cumDist,
      totalDist,
      curvature,
      origIdxMap,
      ptsLen: n,
      ptsKey: view._playbackPtsKey
    };
    view._smoothPathCache.set(id, result);
    return result;
  };

  // Build cumulative distance array for a path (cached per vehicle)
  // Also computes per-point curvature for speed modulation
  VehicleMotion.prototype._getPathDistances = function (id, pts) {
    const view = this.view;
    if (!view._pathDistCache) view._pathDistCache = new Map();
    let cached = view._pathDistCache.get(id);
    if (cached && cached.ptsLen === pts.length) return cached;

    const n = pts.length;
    const prevLen = cached ? cached.ptsLen : 0;

    // Incremental: reuse existing arrays and only compute new appended points.
    // GPS trails only grow by appending — never insert into the middle.
    let cumDist, curvature;
    if (cached && prevLen > 0 && n > prevLen) {
      // Extend existing arrays
      cumDist = cached.cumDist;
      curvature = cached.curvature;
      // Grow arrays to new size
      cumDist.length = n;
      curvature.length = n;
      // Compute distances for new points only
      for (let i = prevLen; i < n; i++) {
        const segDist = g.haversineMeters(pts[i-1].lat, pts[i-1].lon, pts[i].lat, pts[i].lon);
        cumDist[i] = cumDist[i-1] + segDist;
      }
      // Recompute curvature only at boundary + new points
      const curvStart = Math.max(1, prevLen - 1);
      for (let i = curvStart; i < n - 1; i++) {
        const dx1 = pts[i].lon - pts[i-1].lon;
        const dy1 = pts[i].lat - pts[i-1].lat;
        const dx2 = pts[i+1].lon - pts[i].lon;
        const dy2 = pts[i+1].lat - pts[i].lat;
        const a1 = Math.atan2(dy1, dx1);
        const a2 = Math.atan2(dy2, dx2);
        let angleDiff = Math.abs(a2 - a1);
        if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
        const dist = (cumDist[i] - cumDist[i-1] + cumDist[i+1] - cumDist[i]) / 2;
        curvature[i] = dist > 0.1 ? angleDiff / dist : 0;
      }
      if (n > 0) curvature[n - 1] = 0;
    } else {
      // Full rebuild (first call or data replaced)
      cumDist = new Array(n);
      cumDist[0] = 0;
      for (let i = 1; i < n; i++) {
        const segDist = g.haversineMeters(pts[i-1].lat, pts[i-1].lon, pts[i].lat, pts[i].lon);
        cumDist[i] = cumDist[i-1] + segDist;
      }
      curvature = new Array(n).fill(0);
      if (n >= 3) {
        for (let i = 1; i < n - 1; i++) {
          const dx1 = pts[i].lon - pts[i-1].lon;
          const dy1 = pts[i].lat - pts[i-1].lat;
          const dx2 = pts[i+1].lon - pts[i].lon;
          const dy2 = pts[i+1].lat - pts[i].lat;
          const a1 = Math.atan2(dy1, dx1);
          const a2 = Math.atan2(dy2, dx2);
          let angleDiff = Math.abs(a2 - a1);
          if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
          const dist = (cumDist[i] - cumDist[i-1] + cumDist[i+1] - cumDist[i]) / 2;
          curvature[i] = dist > 0.1 ? angleDiff / dist : 0;
        }
      }
    }
    const totalDist = cumDist[n - 1] || 1;

    cached = { cumDist, totalDist, curvature, ptsLen: n };
    view._pathDistCache.set(id, cached);
    return cached;
  };

  // Catmull-Rom spline interpolation for smooth curves
  // Returns position and tangent at parameter t ∈ [0,1] between pts[p1] and pts[p2]
  VehicleMotion.prototype._catmullRom = function (pts, p0Idx, p1Idx, p2Idx, p3Idx, t) {
    const p0 = pts[p0Idx];
    const p1 = pts[p1Idx];
    const p2 = pts[p2Idx];
    const p3 = pts[p3Idx];

    const t2 = t * t;
    const t3 = t2 * t;

    // Catmull-Rom basis functions
    const lat = 0.5 * (
      (-p0.lat + 3*p1.lat - 3*p2.lat + p3.lat) * t3 +
      (2*p0.lat - 5*p1.lat + 4*p2.lat - p3.lat) * t2 +
      (-p0.lat + p2.lat) * t +
      2*p1.lat
    );
    const lon = 0.5 * (
      (-p0.lon + 3*p1.lon - 3*p2.lon + p3.lon) * t3 +
      (2*p0.lon - 5*p1.lon + 4*p2.lon - p3.lon) * t2 +
      (-p0.lon + p2.lon) * t +
      2*p1.lon
    );

    // Tangent (derivative of position)
    const dLat = 0.5 * (
      3*(-p0.lat + 3*p1.lat - 3*p2.lat + p3.lat) * t2 +
      2*(2*p0.lat - 5*p1.lat + 4*p2.lat - p3.lat) * t +
      (-p0.lat + p2.lat)
    );
    const dLon = 0.5 * (
      3*(-p0.lon + 3*p1.lon - 3*p2.lon + p3.lon) * t2 +
      2*(2*p0.lon - 5*p1.lon + 4*p2.lon - p3.lon) * t +
      (-p0.lon + p2.lon)
    );

    return { lat, lon, dLat, dLon };
  };

  // Sample position on path given distance along it using LINEAR interpolation
  // Catmull-Rom was causing loops at sharp corners - linear is more predictable
  // Returns position, tangent direction, and local curvature
  VehicleMotion.prototype._samplePathAtDistance = function (pts, cumDist, curvature, d) {
    const n = pts.length;
    if (n < 2) return { lat: pts[0].lat, lon: pts[0].lon, idx: 0, u: 0, heading: 0, curv: 0 };

    // Binary search for segment containing distance d
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cumDist[mid] <= d) lo = mid;
      else hi = mid - 1;
    }
    const idx = Math.min(lo, n - 2);

    const segStart = cumDist[idx];
    const segEnd = cumDist[idx + 1];
    const segLen = Math.max(0.001, segEnd - segStart);
    const u = g.clamp((d - segStart) / segLen, 0, 1);

    // Linear interpolation - no overshooting at corners
    const p0 = pts[idx];
    const p1 = pts[idx + 1];
    const lat = p0.lat + (p1.lat - p0.lat) * u;
    const lon = p0.lon + (p1.lon - p0.lon) * u;

    // Heading from segment direction
    const heading = Math.atan2(p1.lat - p0.lat, p1.lon - p0.lon);

    // Interpolate curvature between the two segment endpoints
    const curv = (curvature[idx] || 0) * (1 - u) + (curvature[idx + 1] || 0) * u;

    return {
      lat,
      lon,
      idx,
      u,
      heading,
      curv,
      p0,
      p1
    };
  };

  // Get target distance based on playback time
  VehicleMotion.prototype._getTargetDistance = function (pts, cumDist, totalDist, t) {
    const tMin = pts[0].tMs;
    const tMax = pts[pts.length - 1].tMs;

    if (t <= tMin) return 0;
    if (t >= tMax) return totalDist;

    // Binary search for segment containing time t
    let lo = 1, hi = pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].tMs >= t) hi = mid;
      else lo = mid + 1;
    }

    const p0 = pts[lo - 1];
    const p1 = pts[lo];
    const dtMs = Math.max(1, p1.tMs - p0.tMs);
    const u = g.clamp((t - p0.tMs) / dtMs, 0, 1);

    // Interpolate distance
    const d0 = cumDist[lo - 1];
    const d1 = cumDist[lo];
    return d0 + (d1 - d0) * u;
  };

  return VehicleMotion;
});
