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
  } = {}) {
    if (!Array.isArray(trail) || trail.length < 2) return [];

    // Find the last visible point at/before windowEndMs.
    let endIdx = -1;
    let hasWindowMoving = false;
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

      if (moving && windowStartMs != null && tPointMs != null && tPointMs >= windowStartMs) {
        hasWindowMoving = true;
      }
      break;
    }

    if (endIdx < 0) return [];

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

      // If there's no movement in the server update window, only include a short recent
      // segment (bounded by distance) so old trails don't dominate the bounds.
      if (!hasWindowMoving && totalM >= minTrailLengthM) break;
    }

    return out;
  }

  function collectBoundsForMobilesNewSegment(mobiles, windowStartMs, windowEndMs, {
    includeDebugPath = false,
    minTrailLengthM = DEFAULT_MIN_TRAIL_LENGTH_M,
    maxSegmentPoints = DEFAULT_MAX_SEGMENT_POINTS,
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
      });

      if (pts.length === 0) continue;

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
    trailMeetsMinLength,
    collectMostRecentVisibleSegment,
    collectBoundsForMobilesNewSegment,
    boundsSignature,
    DEFAULT_MIN_TRAIL_LENGTH_M,
    DEFAULT_MAX_SEGMENT_POINTS,
    DEFAULT_SIG_EPS_DEG,
  };
});
