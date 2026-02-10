(function (root, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else {
    root.CameraFitLogic = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DEFAULT_MIN_TRAIL_LENGTH_M = 50;
  const DEFAULT_MAX_SEGMENT_POINTS = 600;
  const DEFAULT_SIG_EPS_DEG = 1e-4; // ~11m lat; good enough for debouncing
  const DEFAULT_MIN_VISIBLE_SEGMENT_POINTS = 3;
  const DEFAULT_MIN_VISIBLE_SEGMENT_LENGTH_M = 120;
  const DEFAULT_MIN_VISIBLE_SEGMENT_DISPLACEMENT_M = 60;
  const DEFAULT_MIN_VISIBLE_SEGMENT_STRAIGHTNESS = 0.2;
  const DEFAULT_MIN_VISIBLE_SEGMENT_LENGTH_M_TWO_POINTS = 500;
  const DEFAULT_MIN_VISIBLE_SEGMENT_DISPLACEMENT_M_TWO_POINTS = 500;
  const DEFAULT_MAX_SEGMENT_LENGTH_M = 5000; // cap segment length to ~5km

  const _isFinite = (x) => typeof x === "number" && isFinite(x);

  const parseUtcMs = (tStr) => {
    if (typeof tStr !== "string" || !tStr) return null;
    const ms = Date.parse(tStr);
    return Number.isFinite(ms) ? ms : null;
  };

  const toRad = (deg) => (deg * Math.PI) / 180;

  const haversineMeters = (lat1, lon1, lat2, lon2) => {
    const R = 6371000;
    const p1 = toRad(lat1);
    const p2 = toRad(lat2);
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  };

  const isMovingPoint = (p) => !!(p && (p.m === 1 || p.m === "1" || p.m === true));

  function segmentStatsMeters(pts) {
    if (!Array.isArray(pts) || pts.length < 2) {
      return { totalM: 0, displacementM: 0, straightness: 0 };
    }
    let totalM = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const d = haversineMeters(Number(a?.lat), Number(a?.lon), Number(b?.lat), Number(b?.lon));
      if (_isFinite(d)) totalM += d;
    }
    const first = pts[0];
    const last = pts[pts.length - 1];
    const displacementM = haversineMeters(
      Number(first?.lat),
      Number(first?.lon),
      Number(last?.lat),
      Number(last?.lon)
    );
    const disp = _isFinite(displacementM) ? displacementM : 0;
    const straightness = totalM > 0 ? disp / totalM : 0;
    return { totalM, displacementM: disp, straightness };
  }

  function trailMeetsMinLength(trail, minMeters = DEFAULT_MIN_TRAIL_LENGTH_M) {
    if (!Array.isArray(trail) || trail.length < 2) return false;
    let totalM = 0;
    let prev = null;
    for (const p of trail) {
      const lat = Number(p?.lat);
      const lon = Number(p?.lon);
      if (!_isFinite(lat) || !_isFinite(lon)) continue;
      if (prev) {
        const d = haversineMeters(prev.lat, prev.lon, lat, lon);
        if (_isFinite(d)) totalM += d;
        if (totalM >= minMeters) return true;
      }
      prev = { lat, lon };
    }
    return totalM >= minMeters;
  }

  // Returns a *visible* segment to use for camera fit bounds.
  //
  // Rules:
  // - If the vehicle has any visible moving points within [windowStartMs, windowEndMs],
  //   include the full contiguous moving segment ending at/before windowEndMs. This
  //   naturally includes segments that started before windowStartMs.
  // - If it has no visible moving points within the window, include only a short
  //   recent visible segment (bounded by distance) so we don't drag ancient history
  //   into the bounds.
  function collectMostRecentVisibleSegment(trail, windowStartMs, windowEndMs, {
    includeDebugPath = false,
    maxPoints = DEFAULT_MAX_SEGMENT_POINTS,
    minTrailLengthM = DEFAULT_MIN_TRAIL_LENGTH_M,
    minVisibleSegmentPoints = DEFAULT_MIN_VISIBLE_SEGMENT_POINTS,
    minVisibleSegmentLengthM = DEFAULT_MIN_VISIBLE_SEGMENT_LENGTH_M,
    maxSegmentLengthM = DEFAULT_MAX_SEGMENT_LENGTH_M,
  } = {}) {
    if (!Array.isArray(trail) || trail.length < 2) return [];

    // Find the last visible point at/before windowEndMs.
    let endIdx = -1;
    for (let i = trail.length - 1; i >= 0; i--) {
      const p = trail[i];
      if (!p) continue;
      const tPointMs = parseUtcMs(p.t);
      if (windowEndMs != null && tPointMs != null && tPointMs > windowEndMs) continue;

      const moving = isMovingPoint(p);
      const visible = includeDebugPath || moving;
      if (!visible) continue;

      const lat = Number(p.lat);
      const lon = Number(p.lon);
      if (!_isFinite(lat) || !_isFinite(lon)) continue;
      endIdx = i;
      break;
    }

    if (endIdx < 0) return [];

    // Skip vehicles whose most recent visible point is stale — parked/idle for
    // a long time.  The strict single-point windowStartMs check was too aggressive
    // because server polling and vehicle reporting are asynchronous; a vehicle can
    // be actively moving yet its latest point may fall just before windowStartMs.
    // Instead, use a generous staleness threshold: if the newest point is >5 min
    // before the update window end, the vehicle is truly idle.
    if (!includeDebugPath) {
      const endPoint = trail[endIdx];
      const endPointMs = parseUtcMs(endPoint?.t);
      const MAX_STALE_MS = 5 * 60 * 1000; // 5 minutes
      if (windowEndMs != null && endPointMs != null && (windowEndMs - endPointMs) > MAX_STALE_MS) {
        return [];
      }
    }

    const out = [];
    let count = 0;
    let totalM = 0;
    let prev = null;

    for (let i = endIdx; i >= 0; i--) {
      const p = trail[i];
      if (!p) continue;
      const tPointMs = parseUtcMs(p.t);
      if (windowEndMs != null && tPointMs != null && tPointMs > windowEndMs) continue;

      const moving = isMovingPoint(p);
      const visible = includeDebugPath || moving;
      if (!visible) break; // segment boundary

      const lat = Number(p.lat);
      const lon = Number(p.lon);
      if (!_isFinite(lat) || !_isFinite(lon)) continue;

      out.push({ lat, lon });

      if (prev) {
        const d = haversineMeters(lat, lon, prev.lat, prev.lon);
        if (_isFinite(d)) totalM += d;
      }
      prev = { lat, lon };

      count++;
      if (count >= maxPoints) break;

      // Cap segment length so a single long-route vehicle (e.g. TRAX train)
      // doesn't span the entire metro area and drag the camera out.
      if (totalM >= maxSegmentLengthM) break;
    }

    return out;
  }

  function collectBoundsForMobilesNewSegment(mobiles, windowStartMs, windowEndMs, {
    includeDebugPath = false,
    minTrailLengthM = DEFAULT_MIN_TRAIL_LENGTH_M,
    maxSegmentPoints = DEFAULT_MAX_SEGMENT_POINTS,
    minVisibleSegmentPoints = DEFAULT_MIN_VISIBLE_SEGMENT_POINTS,
    minVisibleSegmentLengthM = DEFAULT_MIN_VISIBLE_SEGMENT_LENGTH_M,
    minVisibleSegmentDisplacementM = DEFAULT_MIN_VISIBLE_SEGMENT_DISPLACEMENT_M,
    minVisibleSegmentStraightness = DEFAULT_MIN_VISIBLE_SEGMENT_STRAIGHTNESS,
    minVisibleSegmentLengthM2 = DEFAULT_MIN_VISIBLE_SEGMENT_LENGTH_M_TWO_POINTS,
    minVisibleSegmentDisplacementM2 = DEFAULT_MIN_VISIBLE_SEGMENT_DISPLACEMENT_M_TWO_POINTS,
    maxSegmentLengthM = DEFAULT_MAX_SEGMENT_LENGTH_M,
  } = {}) {
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLon = Infinity;
    let maxLon = -Infinity;
    let visibleVehicleCount = 0;
    let visiblePointCount = 0;

    const arr = Array.isArray(mobiles) ? mobiles : [];

    for (const m of arr) {
      if (!m || m.ghosted) continue;

      const trail = Array.isArray(m.trail) ? m.trail : [];
      if (trail.length < 2) continue;

      // Eligibility: overall trail should show real movement (not pure jitter)
      if (!trailMeetsMinLength(trail, minTrailLengthM)) continue;

      // Build candidate points for bounds: include the most recent visible segment
      // ending at/before windowEndMs. This naturally includes segments that started
      // before windowStartMs.
      const pts = collectMostRecentVisibleSegment(trail, windowStartMs, windowEndMs, {
        includeDebugPath,
        maxPoints: maxSegmentPoints,
        minTrailLengthM,
        minVisibleSegmentPoints,
        minVisibleSegmentLengthM,
        maxSegmentLengthM,
      });

      if (pts.length === 0) continue;

      // Guard against false-positive "moving" slivers (e.g., a couple of m=1 points from GPS noise).
      // This prevents the camera from zooming way out to include a remote, tiny artifact.
      if (!includeDebugPath) {
        const st = segmentStatsMeters(pts);

        // 2-point segments can happen when we intentionally bound a recent segment.
        // Allow only if it represents a meaningful displacement (prevents tiny slivers).
        const allowTwoPoint =
          pts.length === 2 &&
          st.totalM >= minVisibleSegmentLengthM2 &&
          st.displacementM >= minVisibleSegmentDisplacementM2;

        if (!allowTwoPoint) {
          if (pts.length < minVisibleSegmentPoints) continue;
          if (st.totalM < minVisibleSegmentLengthM) continue;
          if (st.displacementM < minVisibleSegmentDisplacementM) continue;
          if (st.straightness < minVisibleSegmentStraightness) continue;
        }
      }

      // If the segment is entirely before windowStartMs, it can still be relevant;
      // the server meta window is authoritative, and we cap work via maxSegmentPoints.
      // (We do NOT invent client-side time windows.)

      for (const pt of pts) {
        minLat = Math.min(minLat, pt.lat);
        maxLat = Math.max(maxLat, pt.lat);
        minLon = Math.min(minLon, pt.lon);
        maxLon = Math.max(maxLon, pt.lon);
        visiblePointCount++;
      }

      visibleVehicleCount++;
    }

    return { minLat, minLon, maxLat, maxLon, visibleVehicleCount, visiblePointCount };
  }

  function boundsSignature(bounds, epsDeg = DEFAULT_SIG_EPS_DEG) {
    if (!bounds) return "";
    const q = (v) => {
      const x = Number(v);
      if (!_isFinite(x)) return "nan";
      const s = epsDeg > 0 ? epsDeg : DEFAULT_SIG_EPS_DEG;
      return String(Math.round(x / s));
    };
    return `${q(bounds.minLat)}|${q(bounds.minLon)}|${q(bounds.maxLat)}|${q(bounds.maxLon)}`;
  }

  return {
    parseUtcMs,
    haversineMeters,
    segmentStatsMeters,
    trailMeetsMinLength,
    collectMostRecentVisibleSegment,
    collectBoundsForMobilesNewSegment,
    boundsSignature,
    DEFAULT_MIN_TRAIL_LENGTH_M,
    DEFAULT_MAX_SEGMENT_POINTS,
    DEFAULT_SIG_EPS_DEG,
    DEFAULT_MIN_VISIBLE_SEGMENT_POINTS,
    DEFAULT_MIN_VISIBLE_SEGMENT_LENGTH_M,
    DEFAULT_MIN_VISIBLE_SEGMENT_DISPLACEMENT_M,
    DEFAULT_MIN_VISIBLE_SEGMENT_STRAIGHTNESS,
    DEFAULT_MIN_VISIBLE_SEGMENT_LENGTH_M_TWO_POINTS,
    DEFAULT_MIN_VISIBLE_SEGMENT_DISPLACEMENT_M_TWO_POINTS,
    DEFAULT_MAX_SEGMENT_LENGTH_M,
  };
});
