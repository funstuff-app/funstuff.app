/**
 * engine_overlay_renderer.js — OverlayRenderer: the interactive overlay layer.
 *
 * Owns drawOverlay (mobile/fixed markers, trails, selection/hover/labels, wind
 * arrows, debug steering/road/tram overlays), the trace-mode static-overlay
 * cache, the shared trail-collection helper, the persisted-trail store, and the
 * per-mobile cache pruning/clearing used when snapshots change.
 *
 * MapView remains the composition root and keeps the shared view state; its own
 * drawOverlay/clearVehicleCaches/_invalidateOverlayStatic/etc. become one-line
 * delegates to `this.overlay.<method>()`.
 *
 * State OWNED by OverlayRenderer (moved off MapView): the trace-mode static
 * overlay canvas + key + dirty flag (_overlayStaticCanvas/_overlayStaticKey/
 * _overlayStaticDirty), the per-frame dedupe stamp (_overlayLastDrawMs), the
 * per-frame emoji/text/fixed-interp caches (_emojiCanvasCache/_textWidthCache/
 * _fixedInterpCache), and the playback trail-cache bookkeeping that is read only
 * here (_trailCacheTimeMs/_trailCacheCenterW/_trailCacheZoom/_trailCacheBufW/
 * _trailCacheBufH/_lastTrailRedrawPerf).
 *
 * SHARED MapView fields read/written here (kept on MapView, not moved, because
 * unmoved MapView code, app.js, or other engine modules also touch them),
 * accessed via `view.<field>`:
 *   octx, overlayCanvas, center, zoom, _cssW, _cssH, _dpr, playbackMode,
 *   traceMode, _historicalMode, selectedId, _hoveredId, lastState,
 *   showFixed, showFixedLabels, showPublic, showPublicLabels, showMobile,
 *   showMobileLabels, maxTrailLen, _scrubbing, _pbDebugPath, _pbDebugRawGps,
 *   _pbDebugRoadLines, _paFieldPollutant, _markerPollutantOverride,
 *   _selectedPollutantKey, _selectedNaturalPollutantKey, _selectedPollutantValue,
 *   _selectedReadings, _fixedGeoOffsets, _virtualMobileSensors, _paFieldBufW,
 *   _paFieldBufH, _playbackSpeed, _currentPlaybackTimeMs, _pbDrag, _pbInertia2d,
 *   _persistedTrailById, _persistedTrailRev, _trailCacheCanvas, _trailCacheViewKey,
 *   _roadGraphEdges, _tramLineEdges, _tramLineHasElevation, _playbackPtsById,
 *   and every per-mobile cache map cleared/pruned here (_tracePtsById,
 *   _tracePtsKey, _traceLastSideById, _traceActiveRouteById, _tracePendingRouteById,
 *   _traceCycleStartMsById, _traceInitialRunDoneById, _traceAngleById,
 *   _traceAngleLastMsById, _traceSelectionWarpById, _physicsStateById,
 *   _roadMatchedRangesById, _roadMatchPending, _vehicleActualPathById,
 *   _smoothPathCache, _pathDistCache, _vehiclePhysicsCache, _vehiclePathById,
 *   _curveLookaheadCache, _screenHeadingCache, _vehicleRevealDist,
 *   _scrubCooldownById).
 * SHARED MapView methods used via view: getPlaybackTimeMs, getPlaybackBounds,
 *   isPlaybackAtEnd, worldToScreen, _dataNowMs, _isTransientAnimating,
 *   _tracePointsKeyForState, _ensureTracePoints, _mobilePoseForRender,
 *   _getPhysicsState, _getPathDistances, _getTargetDistance,
 *   _fetchRoadEdgesForViewport, _fetchTramLineEdgesForViewport,
 *   _windFieldForTime.
 *
 * Globals from earlier-loaded scripts (config.js, projections.js, colors.js,
 * aqi.js, format_utils.js, data_utils.js, sidebar_ui.js, engine_field_sensors.js)
 * are resolved lazily via `g` — never at module factory time (node tests have no
 * browser globals). Each method aliases the globals it needs into local consts at
 * the top so the moved bodies stay verbatim; FieldSensors consts are read as
 * `g.FieldSensors.<name>`.
 */
(function (root, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else {
    root.OverlayRenderer = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

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

  /**
   * @param {object} view — MapView instance (owns the shared canvas/center/zoom/
   *   playback/lastState state; see file header for the full shared-field list).
   */
  function OverlayRenderer(view) {
    this.view = view;

    // Trace-mode optimization: cache static overlay (trails + fixed markers).
    this._overlayStaticCanvas = null; // offscreen canvas in device pixels
    this._overlayStaticKey = "";
    this._overlayStaticDirty = true;

    // Playback-mode optimization: cache trails to offscreen canvas.
    this._trailCacheTimeMs = null;
    this._lastTrailRedrawPerf = 0;
  }


  OverlayRenderer.prototype._invalidateOverlayStatic = function() {
    const view = this.view;
    this._overlayStaticDirty = true;
  };

  OverlayRenderer.prototype._getOverlayPaddingPx = function() {
    const view = this.view;
    // Side-specific padding based on overlay panels that obscure the map.
    // This prevents “fit bounds” from centering under the left/right panels.
    const mapRect = view.overlayCanvas.getBoundingClientRect();
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
  };

  /** Clear all per-vehicle caches. Called when switching snapshots to prevent
   *  stale data from prior loads accumulating in memory. */
  OverlayRenderer.prototype.clearVehicleCaches = function() {
    const view = this.view;
    view._tracePtsById = new Map();
    view._tracePtsKey = "";
    view._traceLastSideById = new Map();
    view._traceActiveRouteById = new Map();
    view._tracePendingRouteById = new Map();
    view._traceCycleStartMsById = new Map();
    view._traceInitialRunDoneById = new Map();
    view._traceAngleById = new Map();
    view._traceAngleLastMsById = new Map();
    view._traceSelectionWarpById = new Map();
    view._physicsStateById = new Map();
    view._roadMatchedRangesById = new Map();
    view._roadMatchPending = new Set();
    view._vehicleActualPathById = new Map();
    view._smoothPathCache = new Map();
    view._pathDistCache = new Map();
    view._vehiclePhysicsCache = new Map();
    view._vehiclePathById = new Map();
    view._curveLookaheadCache = new Map();
    view._screenHeadingCache = new Map();
    view._vehicleRevealDist = new Map();
    view._scrubCooldownById = new Map();
    view._trailCacheCanvas = null;
    view._trailCacheViewKey = "";
    this._trailCacheTimeMs = null;
  };


  OverlayRenderer.prototype._prunePerMobileCachesForState = function(state) {
    const view = this.view;
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
    removedAny = pruneMap(view._persistedTrailById) || removedAny;
    removedAny = pruneMap(view._tracePtsById) || removedAny;
    removedAny = pruneMap(view._traceLastSideById) || removedAny;
    removedAny = pruneMap(view._traceActiveRouteById) || removedAny;
    removedAny = pruneMap(view._tracePendingRouteById) || removedAny;
    removedAny = pruneMap(view._traceCycleStartMsById) || removedAny;
    removedAny = pruneMap(view._traceInitialRunDoneById) || removedAny;
    removedAny = pruneMap(view._traceAngleById) || removedAny;
    removedAny = pruneMap(view._traceAngleLastMsById) || removedAny;
    // Playback physics / path caches (added later, were previously missed)
    removedAny = pruneMap(view._vehiclePathById) || removedAny;
    removedAny = pruneMap(view._smoothPathCache) || removedAny;
    removedAny = pruneMap(view._pathDistCache) || removedAny;
    removedAny = pruneMap(view._vehiclePhysicsCache) || removedAny;
    removedAny = pruneMap(view._curveLookaheadCache) || removedAny;
    removedAny = pruneMap(view._screenHeadingCache) || removedAny;
    removedAny = pruneMap(view._vehicleRevealDist) || removedAny;
    removedAny = pruneMap(view._roadMatchedRangesById) || removedAny;
    removedAny = pruneMap(view._scrubCooldownById) || removedAny;
    removedAny = pruneMap(view._physicsStateById) || removedAny;
    removedAny = pruneMap(view._vehicleActualPathById) || removedAny;
    removedAny = pruneMap(view._traceSelectionWarpById) || removedAny;

    if (removedAny) {
      view._persistedTrailRev++;
      this._invalidateOverlayStatic();
    }
  };


  OverlayRenderer.prototype._getPersistedTrailEntry = function(id) {
    const view = this.view;
    if (!id) return null;
    return view._persistedTrailById.get(String(id)) || null;
  };


  OverlayRenderer.prototype._updatePersistedTrails = function(state) {
    const view = this.view;
    const safeHex = g.safeHex;
    const haversineMeters = g.haversineMeters;
    const parseUtcMs = g.parseUtcMs;
    const clamp = g.clamp;
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

      any = del(view._persistedTrailById) || any;
      any = del(view._tracePtsById) || any;
      any = del(view._traceLastSideById) || any;
      any = del(view._traceActiveRouteById) || any;
      any = del(view._tracePendingRouteById) || any;
      any = del(view._traceCycleStartMsById) || any;
      any = del(view._traceInitialRunDoneById) || any;
      any = del(view._traceAngleById) || any;
      any = del(view._traceAngleLastMsById) || any;
      any = del(view._traceSelectionWarpById) || any;
      return any;
    };

    for (const m of mobiles) {
      const id = (m && m.id != null) ? String(m.id) : "";
      if (!id) continue;

      const serverTrail = Array.isArray(m?.trail) ? m.trail : [];
      const prev = view._persistedTrailById.get(id) || { trail: [], color: null, ghosted: false, parked: false, pin: null };

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
      if (nextTrail.length > view.maxTrailLen) {
        nextTrail = nextTrail.slice(-view.maxTrailLen);
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
        view._persistedTrailById.set(id, { trail: nextTrail, color: nextColor, ghosted: nextGhosted, parked: nextParked, pin: nextPin });
        changed = true;
      }
    }

    if (changed) {
      view._persistedTrailRev++;
    }
  };

  OverlayRenderer.prototype._overlayStaticKeyForState = function(state) {
    const view = this.view;
    const w = view._cssW || 1;
    const h = view._cssH || 1;
    const z = Number(view.zoom);
    const clat = Number(view.center?.lat);
    const clon = Number(view.center?.lon);
    const sel = view.selectedId || "";
    const fixed = 1;
    const revKey = view._tracePointsKeyForState(state);
    // Include persisted trail rev so cached overlay updates even when the server drops history.
    const persistKey = `persist:${view._persistedTrailRev}`;
    const fl = view.showFixedLabels ? 1 : 0;
    // Include playback time (rounded to 1s) so fixed sensor dots update when scrubbing
    const pbT = view.getPlaybackTimeMs();
    const pbKey = (pbT != null && isFinite(pbT)) ? Math.round(pbT / 1000) : "live";
    return `${revKey}|${persistKey}|w:${w}|h:${h}|z:${z.toFixed(4)}|c:${clat.toFixed(6)},${clon.toFixed(6)}|sel:${sel}|fixed:${fixed}|fl:${fl}|pb:${pbKey}`;
  };


  /**
   * Collect trail data for rendering. Shared by both _ensureOverlayStatic and drawOverlay.
   * Returns { pts, cols, times, trail, isGhost } or null if trail is invalid.
   */
  OverlayRenderer.prototype._collectTrailData = function(m, toScreen) {
    const view = this.view;
    const safeHex = g.safeHex;
    const primaryReadingFromPoint = g.primaryReadingFromPoint;
    const parseUtcMs = g.parseUtcMs;
    const latLonToNorm = g.latLonToNorm;
    const worldSizeForZoom = g.worldSizeForZoom;
    const valueToAqi = g.valueToAqi;
    const _aqiToRgb = g.FieldSensors._aqiToRgb;
    const _LEGEND_TAB_READING_KEYS = g.FieldSensors._LEGEND_TAB_READING_KEYS;
    const _LEGEND_TAB_AQI_KEY = g.FieldSensors._LEGEND_TAB_AQI_KEY;
    const id = m && m.id != null ? String(m.id) : "";
    
// Get reveal time (for clipping trail at vehicle position)
    // Use playback time directly - vehicle physics are synced to this
    const pbTimeMs = view.getPlaybackTimeMs();
    const revealTimeMs = pbTimeMs;
    
    // Get trail source
    // In playback mode, always prefer server trail for fresh readings/colors.
    // Persisted trail is only used in non-playback live mode for continuity.
    const serverTrail = Array.isArray(m?.trail) ? m.trail : [];
    const hasServerTrail = serverTrail.length >= 2;
    const useServerTrail = view.playbackMode || hasServerTrail;
    const persistedTrail = (id && !view._historicalMode && !view.playbackMode) ? (view._persistedTrailById.get(id)?.trail || []) : [];
    const trail = useServerTrail ? (hasServerTrail ? serverTrail : persistedTrail) : (persistedTrail.length >= 2 ? persistedTrail : serverTrail);
    if (!Array.isArray(trail) || trail.length < 2) return null;
    
    const isGhost = !!m.ghosted;
    const pts = [];
    const cols = [];
    const times = [];
    
    const getSp = toScreen || view.worldToScreen.bind(view);
    const ws = worldSizeForZoom(view.zoom);
    
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
      const pollTab = view._paFieldPollutant;
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
  };


  OverlayRenderer.prototype._ensureOverlayStatic = function(state) {
    const view = this.view;
    const _isLite = _liteFlag();
    const keyFor = g.keyFor;
    const parseKey = g.parseKey;
    const roundRect = g.roundRect;
    const dimHex = g.dimHex;
    const desatHex = g.desatHex;
    const darkenHex = g.darkenHex;
    const hexToRgba = g.hexToRgba;
    const outlierHex = g.outlierHex;
    const safeHex = g.safeHex;
    const formatTagValue = g.formatTagValue;
    const primaryReadingForFixedAtTime = g.primaryReadingForFixedAtTime;
    const parseUtcMs = g.parseUtcMs;
    const latLonToWorld = g.latLonToWorld;
    const dpr = view._dpr || (window.devicePixelRatio || 1);
    const cssW = view._cssW || 1;
    const cssH = view._cssH || 1;
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
    const centerW = latLonToWorld(view.center.lat, view.center.lon, view.zoom);
    const worldToScreenFast = (wx, wy) => ({ x: wx - centerW.x + cssW / 2, y: wy - centerW.y + cssH / 2 });

    // Fixed markers - render PurpleAir first (so they don't draw over others), then other markers
    if (view.showFixed) {
      // Declutter: nudge co-located non-PurpleAir fixed markers apart.
      // Offsets are in lat/lon so the bearing is geographic and zoom-independent.
      view._fixedGeoOffsets = new Map();
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
          if (e.dlat || e.dlon) view._fixedGeoOffsets.set(e.f._key, { dlat: e.dlat, dlon: e.dlon });
        }
      }

      // Helper to render a single fixed marker
      const renderFixedMarker = (f) => {
        let lat = Number(f.lat), lon = Number(f.lon);
        if (!isFinite(lat) || !isFinite(lon)) return;
        if (!f._key) f._key = keyFor("fixed", f.id);
        const geo = view._fixedGeoOffsets && view._fixedGeoOffsets.get(f._key);
        if (geo) { lat += geo.dlat; lon += geo.dlon; }
        const wpt = latLonToWorld(lat, lon, view.zoom);
        const sp = worldToScreenFast(wpt.x, wpt.y);
        if (sp.x < -50 || sp.y < -50 || sp.x > cssW + 50 || sp.y > cssH + 50) return;

        if (!f._key) f._key = keyFor("fixed", f.id);
        const keyF = f._key;
        const isSel = (view.selectedId === keyF);
        const emoji = f.purpleair ? "" : (f.emoji || "📍");
        const color = safeHex(f.ci);
        const pr = primaryReadingForFixedAtTime(f, view.getPlaybackTimeMs());
        const isOutlier = f.outlier || (pr && pr.outlier);
        const label = ((f.name && f.name.length && String(f.name) !== String(f.id)) ? f.name : f.id) + (isOutlier ? " (Outlier)" : "");

        ctx.save();
        const isPurpleAir = !!f.purpleair;
        if (isPurpleAir) {
          // Fade PurpleAir dots when a non-PM2.5 pollutant is active (PA sensors report PM2.5)
          const paFadedForPollutant = !isSel && view._paFieldPollutant != null && view._paFieldPollutant !== "pm25";
          // Outlier PurpleAir sensors still render (grey dot) so user can investigate
          // ── Per-sensor staleness fade matching trail duration ──
          let staleAlpha = 1.0;
          // Wall clock in live view (see paRefNowMs note in _ensurePaField).
          const _refMs = view._historicalMode
            ? (view.getPlaybackTimeMs() || view._dataNowMs())
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

        const isHov = (view._hoveredId === keyF);
        if ((view.showFixedLabels && !isPurpleAir) || isSel || isHov || String(f.id) === "Home") {
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
    const sel = parseKey(view.selectedId);
    const hasSelectedMobile = (sel && sel.type === "mobile" && sel.id);
    const selectedId = hasSelectedMobile ? sel.id : null;

    const drawTrailFor = (m, alphaMul, toScreen) => {
      const id = m && m.id != null ? String(m.id) : "";
      const isLive = !view.playbackMode;
      
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
        const willDraw = view._pbDebugPath || isMoving;
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
      const livePlaybackTimeMs = view.getPlaybackTimeMs();
      const hasPlaybackTime = livePlaybackTimeMs != null && isFinite(livePlaybackTimeMs);
      const pbBounds = view.getPlaybackBounds();
      const boundsMaxMs = (pbBounds.maxMs != null && isFinite(pbBounds.maxMs)) ? pbBounds.maxMs : null;
      const refNowMs = hasPlaybackTime ? Number(livePlaybackTimeMs) 
        : (isFinite(visMaxT) ? visMaxT 
        : (boundsMaxMs != null ? boundsMaxMs 
        : view._dataNowMs()));

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
          if (view._pbDebugPath) {
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
      const persistedTrail = id ? (view._persistedTrailById.get(id)?.trail || []) : [];
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
    const refTimeMs = view.getPlaybackTimeMs();
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
    
  };

  OverlayRenderer.prototype.drawOverlay = function(state, opts = {}) {
    const view = this.view;
    const _isLite = _liteFlag();
    const keyFor = g.keyFor;
    const parseKey = g.parseKey;
    const roundRect = g.roundRect;
    const dimHex = g.dimHex;
    const desatHex = g.desatHex;
    const darkenHex = g.darkenHex;
    const hexToRgba = g.hexToRgba;
    const outlierHex = g.outlierHex;
    const safeHex = g.safeHex;
    const formatTagValue = g.formatTagValue;
    const primaryReadingForFixedAtTime = g.primaryReadingForFixedAtTime;
    const primaryReadingForSensor = g.primaryReadingForSensor;
    const parseUtcMs = g.parseUtcMs;
    const latLonToNorm = g.latLonToNorm;
    const latLonToWorld = g.latLonToWorld;
    const worldSizeForZoom = g.worldSizeForZoom;
    const interpolateFixedReadingsAtTime = g.interpolateFixedReadingsAtTime;
    const valueToAqi = g.valueToAqi;
    const clamp = g.clamp;
    const _aqiToRgb = g.FieldSensors._aqiToRgb;
    const _LEGEND_TAB_AQI_KEY = g.FieldSensors._LEGEND_TAB_AQI_KEY;
    const _LEGEND_TAB_LABEL = g.FieldSensors._LEGEND_TAB_LABEL;
    const _readingForLegendTab = g.FieldSensors._readingForLegendTab;
    const _OVERFETCH = g.FieldSensors._OVERFETCH;
    const _OVERFETCH_MAX_DEVICE_PX = g.FieldSensors._OVERFETCH_MAX_DEVICE_PX;
    const _OVERFETCH_MARGIN_EXHAUST = g.FieldSensors._OVERFETCH_MARGIN_EXHAUST;
    const ctx = view.octx;
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
    const _skipLegendExport = view._isTransientAnimating();
    // Only reset per-frame when nothing is selected.
    // When a sensor is selected but off-screen (user panned away),
    // keep the last-known values so the legend doesn't jump back to PM2.5.
    if (!view.selectedId && !_skipLegendExport) {
      view._selectedPollutantKey = null;
      view._selectedNaturalPollutantKey = null;
      view._selectedPollutantValue = null;
    }
    const w = view._cssW || 1;
    const h = view._cssH || 1;
    const dpr = view._dpr || (window.devicePixelRatio || 1);

    // CRITICAL: Reset transform to canonical dpr-scaled state at the start of every drawOverlay.
    // This prevents marker scaling bugs if any code path corrupts the transform and fails to restore.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // In playback mode, trails must be redrawn each frame (time-clipped).
    // Static overlay caching is only valid for trace mode without playback.
    const useStaticOverlay = view.traceMode && !view.playbackMode;

    if (useStaticOverlay) {
      view._ensureTracePoints(state);
      this._ensureOverlayStatic(state);
      const pw = view.overlayCanvas.width;
      const ph = view.overlayCanvas.height;
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
    const _framePbTimeMs = view.playbackMode ? view.getPlaybackTimeMs() : null;
    const _framePbBounds = view.playbackMode ? view.getPlaybackBounds() : null;
    const _frameSel = parseKey(view.selectedId);
    const _frameHasSelectedMobile = (_frameSel && _frameSel.type === "mobile" && _frameSel.id);
    const _frameSelectedId = _frameHasSelectedMobile ? _frameSel.id : null;

    // Playback-mode trail caching:
    // Cache trails to offscreen canvas; only redraw when view or time changes significantly.
    const pbTimeMs = _framePbTimeMs;
    const trailViewKey = `${view.center.lat.toFixed(6)}|${view.center.lon.toFixed(6)}|${view.zoom.toFixed(3)}|${w}|${h}|${view.selectedId || ''}|${view._paFieldPollutant || 'default'}`;
    const viewChanged = view._trailCacheViewKey !== trailViewKey;
    const timeDelta = (pbTimeMs != null && this._trailCacheTimeMs != null) ? (pbTimeMs - this._trailCacheTimeMs) : 0;
    // Trail fading uses a 45-min window with fade in the last 9 minutes — that's
    // ~1% alpha drop per 5.4 seconds, so the rebuild cadence can be coarse and
    // still look smooth. 30s during active scrub, 8s during normal playback.
    // (Was 2s, which redrew the O(vehicles*points) trail cache ~30× per minute
    // during playback even at 1× speed — measurable laptop heat.)
    const timeThreshold = view._scrubbing ? 30000 : 8000;
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
    const centerW = latLonToWorld(view.center.lat, view.center.lon, view.zoom);
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
    const isLive = !view.playbackMode;
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
        const willDraw = view._pbDebugPath || isMoving;
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
        : view._dataNowMs()));

      // Calculate pixels per meter at the trail's location (approximate using first point).
      // This is needed to convert the pruned world distance into a screen-space dash offset.
      let pixelsPerMeter = 1.0;
      if (pts.length > 0) {
        const lat = Number(trail[0].lat);
        if (isFinite(lat)) {
            const c = latLonToWorld(lat, 0, view.zoom);
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
          if (view._pbDebugPath) {
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
      let skipTrailsForGesture = view._isTransientAnimating() && viewChanged && !timeChanged
        && view._trailCacheCanvas && this._trailCacheCenterW;
      if (skipTrailsForGesture) {
        const cachedCW = this._trailCacheCenterW;
        const cachedZ = this._trailCacheZoom || view.zoom;
        const currCW = latLonToWorld(view.center.lat, view.center.lon, cachedZ);
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
      if (!view._trailCacheCanvas) {
        view._trailCacheCanvas = document.createElement("canvas");
        view._trailCacheCanvas.width = targetW;
        view._trailCacheCanvas.height = targetH;
      } else if (view._trailCacheCanvas.width !== targetW || view._trailCacheCanvas.height !== targetH) {
        view._trailCacheCanvas.width = targetW;
        view._trailCacheCanvas.height = targetH;
      }

      if ((needsFullRedraw && !skipTrailsForGesture) || needsIncrementalUpdate) {
        const tctx = view._trailCacheCanvas.getContext("2d");
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
            const persistedTrail = id ? (view._persistedTrailById.get(id)?.trail || []) : [];
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
              const willDraw = view._pbDebugPath || isMoving;
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
              : view._dataNowMs()));

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
            const isLive = !view.playbackMode;

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
                if (view._pbDebugPath) {
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
        view._trailCacheViewKey = trailViewKey;
        this._trailCacheTimeMs = pbTimeMs;
        this._trailCacheCenterW = { x: centerW.x, y: centerW.y };
        this._trailCacheZoom = view.zoom;
        this._trailCacheBufW = trailBufW;
        this._trailCacheBufH = trailBufH;
        this._lastTrailRedrawPerf = performance.now();
      }

      // Blit cached trails to main canvas
      if (view._trailCacheCanvas) {
        const tBufW = this._trailCacheBufW || w;
        const tBufH = this._trailCacheBufH || h;
        const tOffX = (tBufW - w) / 2;
        const tOffY = (tBufH - h) / 2;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (skipTrailsForGesture && this._trailCacheCenterW) {
          const cachedZ = this._trailCacheZoom || view.zoom;
          const sZoom = Math.pow(2, view.zoom - cachedZ);
          const cachedCW = this._trailCacheCenterW;
          const currCW = latLonToWorld(view.center.lat, view.center.lon, cachedZ);
          if (Math.abs(sZoom - 1) > 0.001) {
            // Pinch-zoom: match tiles transform exactly (CSS coordinate space)
            const txPan = (cachedCW.x - currCW.x) * sZoom;
            const tyPan = (cachedCW.y - currCW.y) * sZoom;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.translate(w / 2, h / 2);
            ctx.scale(sZoom, sZoom);
            ctx.translate(-w / 2 + txPan / sZoom, -h / 2 + tyPan / sZoom);
            ctx.drawImage(view._trailCacheCanvas, -tOffX, -tOffY, tBufW, tBufH);
          } else {
            // Pan only: simple translate in physical pixel space with overfetch offset
            const dx = (cachedCW.x - currCW.x - tOffX) * dpr;
            const dy = (cachedCW.y - currCW.y - tOffY) * dpr;
            ctx.drawImage(view._trailCacheCanvas, dx, dy);
          }
        } else {
          // Static: draw the overfetch buffer offset so viewport sees center
          ctx.drawImage(view._trailCacheCanvas, -tOffX * dpr, -tOffY * dpr);
        }
        ctx.restore();
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DEBUG: Draw RAW GPS PATH (original GPS before road snapping) - orange dashed
    // This shows the original GPS coordinates from the server, before any
    // road-matching optimization is applied.
    // ═══════════════════════════════════════════════════════════════════════════
    if (view._pbDebugPath && view._pbDebugRawGps && view.playbackMode) {
      const selId = _frameSelectedId;
      if (selId) {
        const rawGps = view._playbackPtsById?.get(String(selId));
        if (rawGps && rawGps.length >= 2) {
          const ws = worldSizeForZoom(view.zoom);
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
    if (view._pbDebugPath && view._pbDebugRoadLines && view.playbackMode) {
      // Fetch road edges for current viewport if needed (async, won't block)
      view._fetchRoadEdgesForViewport();
      
      const edges = view._roadGraphEdges;
      if (edges && edges.length > 0) {
        const ws = worldSizeForZoom(view.zoom);
        
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
    if (view._pbDebugPath && view._pbDebugRoadLines && view.playbackMode) {
      // Fetch tram line edges for current viewport if needed (async, won't block)
      view._fetchTramLineEdgesForViewport();
      
      const tramEdges = view._tramLineEdges;
      const hasElevation = view._tramLineHasElevation;
      if (tramEdges && tramEdges.length > 0) {
        const ws = worldSizeForZoom(view.zoom);
        
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
    if (view._pbDebugPath && view.playbackMode) {
      const selId = _frameSelectedId;
      if (selId) {
        const ws = worldSizeForZoom(view.zoom);
        const mid = String(selId);
        
        const mobs = Array.isArray(state.mobile) ? state.mobile : [];
        const mm = mobs.find(x => x.id === selId);
        if (mm) {
          const playbackPts = view._playbackPtsById.get(mid);
          if (playbackPts && playbackPts.length >= 2) {
            const phys = view._getPhysicsState(mid);
            const { cumDist, totalDist, curvature } = view._getPathDistances(mid, playbackPts);
            const physD = (phys.d != null && isFinite(phys.d)) ? phys.d : 0;
            const playbackSpeed = view._playbackSpeed || 1.0;
            
            // Calculate visible end - same as vehicle physics uses
            const tMin = playbackPts[0].tMs;
            const tMax = playbackPts[playbackPts.length - 1].tMs;
            const playT = view._currentPlaybackTimeMs || tMax;
            const visibleTargetD = view._getTargetDistance(playbackPts, cumDist, totalDist, playT);
            
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
        view._fixedGeoOffsets = new Map();
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
          if (e.dlat || e.dlon) view._fixedGeoOffsets.set(e.key, { dlat: e.dlat, dlon: e.dlon });
        }
      }

      const renderPbFixedMarker = (f) => {
        let lat = Number(f.lat), lon = Number(f.lon);
        if (!isFinite(lat) || !isFinite(lon)) return;
        if (!f._key) f._key = keyFor("fixed", f.id);
        const geo = view._fixedGeoOffsets && view._fixedGeoOffsets.get(f._key);
        if (geo) { lat += geo.dlat; lon += geo.dlon; }
        const wpt = latLonToWorld(lat, lon, view.zoom);
        const sp = worldToScreenFast(wpt.x, wpt.y);
        if (sp.x < -50 || sp.y < -50 || sp.x > w+50 || sp.y > h+50) return;

        const key = f._key;
        const isSel = (view.selectedId === key);
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
          if (isSel && pr && pr.key) view._selectedPollutantKey = pr.key;
          if (isSel && pr && pr.key) view._selectedNaturalPollutantKey = pr.key;
          if (isSel && pr && pr.key) view._selectedPollutantValue = parseFloat(pr.value);
          // Full readings bag at the displayed time (see mobile path note).
          if (isSel) view._selectedReadings = (fixedPbTimeMs != null)
            ? (interpolateFixedReadingsAtTime(f, fixedPbTimeMs) || f.readings)
            : f.readings;
        }

        // Legend pollutant override: show the selected pollutant on ALL non-PurpleAir markers
        if (view._markerPollutantOverride != null && !f.purpleair) {
          const src = (fixedPbTimeMs != null)
            ? (interpolateFixedReadingsAtTime(f, fixedPbTimeMs) || f.readings)
            : f.readings;
          const legendPr = _readingForLegendTab(src, view._markerPollutantOverride);
          if (legendPr) {
            pr = legendPr;
            if (!_skipLegendExport && isSel) view._selectedPollutantKey = legendPr.key;
            if (!_skipLegendExport && isSel) view._selectedPollutantValue = parseFloat(legendPr.value);
          } else {
            const lbl = _LEGEND_TAB_LABEL[view._markerPollutantOverride] || view._markerPollutantOverride.toUpperCase();
            pr = { key: lbl, value: "\u2014", color: "#666666" };
            if (!_skipLegendExport && isSel) view._selectedPollutantKey = null;
            if (!_skipLegendExport && isSel) view._selectedPollutantValue = null;
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
          const paFadedForPollutant = !isSel && view._paFieldPollutant != null && view._paFieldPollutant !== "pm25";
          // Outlier PurpleAir sensors still render (grey dot) so user can investigate
          // ── Per-sensor staleness fade matching trail duration ──
          let staleAlpha = 1.0;
          // Wall clock in live view (see paRefNowMs note in _ensurePaField).
          const _refMs = view._historicalMode
            ? (view.getPlaybackTimeMs() || view._dataNowMs())
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

        const showLabel = isPurpleAir ? view.showPublicLabels : view.showFixedLabels;
        const isHov = !isPurpleAir && (view._hoveredId === key);
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
      if (view.showPublic) {
        for (const f of fixed) {
          if (f.purpleair) renderPbFixedMarker(f);
        }
      }
      // Second pass: others (fixed)
      if (view.showFixed) {
        for (const f of fixed) {
          if (!f.purpleair) renderPbFixedMarker(f);
        }
      }
    }

    // Mobile emoji markers
    const nowMs = (opts && typeof opts.nowMs === "number" && isFinite(opts.nowMs)) ? opts.nowMs : performance.now();
    if (view.traceMode || view.playbackMode) {
      ctx.font = "22px Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
    }
    const topMobileId = (() => {
      // Priority: actively dragged/inertial marker, then selected marker.
      if (view._pbDrag && view._pbDrag.id != null) return String(view._pbDrag.id);
      if (view._pbInertia2d && view._pbInertia2d.id != null) return String(view._pbInertia2d.id);
      if (selectedId != null) return String(selectedId);
      return null;
    })();

    const drawMobileMarker = (m) => {
      const pose = view._mobilePoseForRender(m, nowMs);
      let lat = pose.lat;
      let lon = pose.lon;
      let angle = pose.angle;
      let flipX = pose.flipX;
      let speedMps = pose.speedMps;
      const opacity = (typeof pose.opacity === "number" && isFinite(pose.opacity)) ? pose.opacity : 1;
      if (!m._key) m._key = keyFor("mobile", m.id);
      const key = m._key;
      const isSel = (view.selectedId === key);
      const debug = !!view._pbDebugPath;
      // In playback mode, show ghosted sensors if they have trail data (they were active in the past).
      // In live mode, hide ghosted sensors unless Debug/Selected.
      const hasPlaybackData = view.playbackMode && view._playbackPtsById.has(String(m.id));
      if (!!m.ghosted && !debug && !isSel && !hasPlaybackData) return;
      // In playback mode, ignore live parked state — vehicle was active at the playback time
      const isParked = hasPlaybackData ? false : !!m.parked;
      const dimmed = (!debug && !isSel && isParked);
      if (!isFinite(lat) || !isFinite(lon)) return;
      const wpt = latLonToWorld(lat, lon, view.zoom);
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
      if (view.playbackMode && pose && pose.reading) {
        const prHist = pose.reading;
        // When in historical mode (viewing past days), always use historical trail reading.
        // Only compare with live sensor readings when viewing today's live data.
        if (view._historicalMode) {
          pr = prHist;
        } else {
          // Only blend with live readings when the playhead is actually at the trail end.
          // _playbackLiveFollow means "will eventually reach the end", not "is there now";
          // using it here caused the marker to show the current live value (e.g. PM10 394)
          // when the playhead was still minutes behind the end on initial load.
          const followingLive = view.isPlaybackAtEnd(200);
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
      } else if (view.playbackMode && !view.isPlaybackAtEnd(200) && !view._playbackPtsById.has(String(m.id))) {
        // Sensor has no playback trail data (e.g. parked at depot) — show "--" instead of frozen live value
        pr = { key: "", value: "--", color: "#666666" };
      }
      // Expose the selected sensor's displayed pollutant key for legend sync
      if (!_skipLegendExport) {
        if (isSel && pr && pr.key) view._selectedPollutantKey = pr.key;
        if (isSel && pr && pr.key) view._selectedNaturalPollutantKey = pr.key;
        if (isSel && pr && pr.key) view._selectedPollutantValue = parseFloat(pr.value);
        // Full readings bag at the displayed time — legend tab colors must use
        // the same source as the marker, not the live state snapshot.
        if (isSel) view._selectedReadings = (view.playbackMode && pose && pose.readings) ? pose.readings : m.readings;
      }

      // Legend pollutant override: show the legend's chosen pollutant on ALL mobile markers
      // In playback mode, prefer trail-point readings (historical) over live m.readings
      if (view._markerPollutantOverride != null) {
        const src = (view.playbackMode && pose && pose.readings) ? pose.readings : m.readings;
        const legendPr = _readingForLegendTab(src, view._markerPollutantOverride);
        if (legendPr) {
          pr = legendPr;
          if (!_skipLegendExport && isSel) view._selectedPollutantKey = legendPr.key;
          if (!_skipLegendExport && isSel) view._selectedPollutantValue = parseFloat(legendPr.value);
        } else {
          const lbl = _LEGEND_TAB_LABEL[view._markerPollutantOverride] || view._markerPollutantOverride.toUpperCase();
          pr = { key: lbl, value: "\u2014", color: "#666666" };
          if (!_skipLegendExport && isSel) view._selectedPollutantKey = null;
          if (!_skipLegendExport && isSel) view._selectedPollutantValue = null;
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

      const liftScale = (view.playbackMode && held) ? 1.16 : 1.0;
      const liftY = (view.playbackMode && held) ? -8 : 0;
      const spx = sp.x;
      const spy = sp.y + liftY;

      // Marker sizes: lite mode (embedded widget) vs normal
      const _mHalo   = _isLite ? 11 : 16;
      const _mCircle = _isLite ?  9 : 13;
      const _mEmoji  = _isLite ? 11 : 16;

      // halo
      ctx.beginPath();
      if (view.selectedId === key) {
        ctx.fillStyle = "rgba(56, 140, 220, 0.38)";
        ctx.arc(spx, spy, _mHalo * liftScale, 0, Math.PI*2);
        ctx.fill();
        ctx.beginPath();
      }
      ctx.fillStyle = "rgba(16, 20, 28, 0.68)";
      ctx.arc(spx, spy, _mCircle * liftScale, 0, Math.PI*2);
      ctx.fill();
      // Border matches AQI color (selected gets brighter ring)
      ctx.strokeStyle = (view.selectedId === key) ? "#5bb8f5" : safeHex(prColorUse);
      ctx.lineWidth = (view.selectedId === key) ? 2.8 : 2.2;
      ctx.stroke();

      // emoji (pre-rendered to offscreen canvas; drawImage is ~10x faster than
      // fillText with color-emoji fonts on iOS Safari)
      const emojiC = getEmojiCanvas(emoji, _mEmoji);
      const emojiHalf = _mEmoji / 2;
      ctx.save();
      if (view.traceMode || view.playbackMode) {
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
      if ((view.traceMode || view.playbackMode) && view.showMobileLabels) {
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
      const isHov = (view._hoveredId === key);
      const shouldShowLabel = view.showMobileLabels || isSel || isHov;
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
    if (view.windAdvection._windSnapshots && window._fieldDebug?.showWind) {
      const _playbackActive = view.playbackMode && _framePbTimeMs != null && isFinite(_framePbTimeMs);
      const wfData = view._windFieldForTime(_framePbTimeMs, _playbackActive);
      if (wfData) {
        const _wCenter = latLonToWorld(view.center.lat, view.center.lon, view.zoom);
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
              const wpt = latLonToWorld(lat, lon, view.zoom);
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
            const wpt = latLonToWorld(wp.lat, wp.lon, view.zoom);
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
    if (view.showMobile) {
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
    if (window._fieldDebug?.showVirtual && view._virtualMobileSensors?.length > 0) {
      // vs.sx/sy are in overfetch buffer space; shift to viewport space.
      const _bufW = view._paFieldBufW || (view._cssW || 1);
      const _bufH = view._paFieldBufH || (view._cssH || 1);
      const _vw = view._cssW || 1;
      const _vh = view._cssH || 1;
      const _offX = (_bufW - _vw) / 2;
      const _offY = (_bufH - _vh) / 2;
      ctx.save();
      for (const vs of view._virtualMobileSensors) {
        const _ghostAqiKey = _LEGEND_TAB_AQI_KEY[view._paFieldPollutant || "pm25"] || "pm2.5";
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
  };

  return OverlayRenderer;
});
