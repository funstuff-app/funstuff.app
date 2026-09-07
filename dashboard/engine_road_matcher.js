/**
 * engine_road_matcher.js — RoadMatcher: road/tram edge fetching, walking,
 * snapping, foveated road matching, and matched-range bookkeeping.
 *
 * MapView keeps shared view state (playback pts/keys, physics state, historical
 * mode flag, debug-path flags, road/tram edge caches drawn by the overlay
 * renderer, matched-range bookkeeping shared with cache-clearing code) and
 * exposes it via `this.view`. MapView's own road/tram methods become one-line
 * delegates to `this.roadMatcher.<method>()`.
 *
 * Shared MapView fields read/written here (kept on MapView, not moved, because
 * non-moved code also touches them): _pbDebugPath, _pbDebugRoadLines,
 * _hasTrxVehicles, _historicalMode, _physicsStateById, _playbackPtsById,
 * _playbackPtsKey, _roadGraphEdges, _tramLineEdges, _tramLineHasElevation,
 * _roadMatchedRangesById, _roadMatchPending, center, zoom, overlayCanvas,
 * playbackMode, lastState, drawOverlay(), getPlaybackTimeMs(),
 * _ensurePlaybackPoints().
 */
(function (root, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else {
    root.RoadMatcher = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Globals from earlier-loaded scripts (config.js, projections.js,
  // data_utils.js, format_utils.js) are resolved lazily at call time — never
  // at module factory time (node tests have no browser globals).
  var g = (typeof window !== "undefined") ? window : globalThis;

  /**
   * @param {object} view — MapView instance (owns shared playback/debug/cache
   *   state; see file header for the full shared-field list).
   */
  function RoadMatcher(view) {
    this.view = view;

    // Foveated road matching: progressively match segments during playback
    this._roadMatchLastRequestMs = 0; // throttle requests
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // DEBUG: Fetch road graph edges for visualization
  // ─────────────────────────────────────────────────────────────────────────────

  RoadMatcher.prototype._fetchRoadEdgesForViewport = async function () {
    const view = this.view;
    if (!view._pbDebugPath || !view._pbDebugRoadLines) return;
    if (this._roadEdgesFetching) return;

    // Get viewport bounds
    const rect = view.overlayCanvas.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    const centerW = g.latLonToWorld(view.center.lat, view.center.lon, view.zoom);

    // Convert corners to lat/lon
    const tl = g.worldToLatLon(centerW.x - w/2, centerW.y - h/2, view.zoom);
    const br = g.worldToLatLon(centerW.x + w/2, centerW.y + h/2, view.zoom);

    const minLat = Math.min(tl.lat, br.lat);
    const maxLat = Math.max(tl.lat, br.lat);
    const minLon = Math.min(tl.lon, br.lon);
    const maxLon = Math.max(tl.lon, br.lon);

    // Don't refetch if viewport hasn't changed much
    const key = `${minLat.toFixed(3)},${maxLat.toFixed(3)},${minLon.toFixed(3)},${maxLon.toFixed(3)}`;
    if (this._roadEdgesLastKey === key) return;

    this._roadEdgesFetching = true;

    try {
      const url = `${g.appConfig.apiBaseUrl}/road_edges?minLat=${minLat}&maxLat=${maxLat}&minLon=${minLon}&maxLon=${maxLon}&limit=8000`;
      const resp = await fetch(url);
      if (!resp.ok) return;
      const data = await resp.json();
      view._roadGraphEdges = data.edges || [];
      this._roadEdgesLastKey = key;
      // Trigger redraw
      view.drawOverlay(view.lastState);
    } catch (e) {
      console.warn("Failed to fetch road edges:", e);
    } finally {
      this._roadEdgesFetching = false;
    }
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // Walk between server-assigned edges (no re-snapping)
  // ─────────────────────────────────────────────────────────────────────────────

  RoadMatcher.prototype._walkBetweenServerEdges = function (t0, t1, edges, toScreen) {
    // t0 and t1 have ea=[lat,lon] and eb=[lat,lon] from server
    // Walk from t0's position to t1's position along track edges

    const distM = (lat1, lon1, lat2, lon2) => {
      const dlat = (lat2 - lat1) * 111000;
      const dlon = (lon2 - lon1) * 111000 * Math.cos(lat1 * Math.PI / 180);
      return Math.hypot(dlat, dlon);
    };

    const coordsMatch = (a, b, threshold = 0.0001) => {
      return Math.abs(a[0] - b[0]) < threshold && Math.abs(a[1] - b[1]) < threshold;
    };

    // Start point and its edge
    const startLat = t0.lat, startLon = t0.lon;
    const startEa = t0.ea, startEb = t0.eb;

    // End point and its edge
    const endLat = t1.lat, endLon = t1.lon;
    const endEa = t1.ea, endEb = t1.eb;

    // If on same edge, just return the two points
    if (coordsMatch(startEa, endEa) && coordsMatch(startEb, endEb)) {
      return [toScreen(startLat, startLon), toScreen(endLat, endLon)];
    }
    if (coordsMatch(startEa, endEb) && coordsMatch(startEb, endEa)) {
      return [toScreen(startLat, startLon), toScreen(endLat, endLon)];
    }

    // Find shared vertex between start and end edges
    let sharedVertex = null;
    if (coordsMatch(startEb, endEa)) sharedVertex = startEb;
    else if (coordsMatch(startEb, endEb)) sharedVertex = startEb;
    else if (coordsMatch(startEa, endEa)) sharedVertex = startEa;
    else if (coordsMatch(startEa, endEb)) sharedVertex = startEa;

    if (sharedVertex) {
      // Direct connection through shared vertex
      return [
        toScreen(startLat, startLon),
        toScreen(sharedVertex[0], sharedVertex[1]),
        toScreen(endLat, endLon)
      ];
    }

    // Need to walk through intermediate edges
    // Find which endpoint of start edge is closer to end
    const d1 = distM(startEa[0], startEa[1], endLat, endLon);
    const d2 = distM(startEb[0], startEb[1], endLat, endLon);
    let current = d1 < d2 ? startEa : startEb;

    const path = [toScreen(startLat, startLon)];
    const visited = new Set();
    visited.add(`${startEa[0]},${startEa[1]}-${startEb[0]},${startEb[1]}`);

    const CONNECT_THRESH = 0.0003; // ~30m in degrees

    for (let step = 0; step < 50; step++) {
      path.push(toScreen(current[0], current[1]));

      // Check if we reached end edge
      if (coordsMatch(current, endEa, CONNECT_THRESH) || coordsMatch(current, endEb, CONNECT_THRESH)) {
        path.push(toScreen(endLat, endLon));
        return path;
      }

      // Find connected edge closest to destination
      let bestEdge = null;
      let bestDist = Infinity;
      let bestNext = null;

      for (const e of edges) {
        const key = `${e.lat1},${e.lon1}-${e.lat2},${e.lon2}`;
        if (visited.has(key)) continue;

        const e1 = [e.lat1, e.lon1];
        const e2 = [e.lat2, e.lon2];

        // Check if edge connects to current position
        let nextPt = null;
        if (coordsMatch(current, e1, CONNECT_THRESH)) nextPt = e2;
        else if (coordsMatch(current, e2, CONNECT_THRESH)) nextPt = e1;

        if (nextPt) {
          const dist = distM(nextPt[0], nextPt[1], endLat, endLon);
          if (dist < bestDist) {
            bestDist = dist;
            bestEdge = e;
            bestNext = nextPt;
          }
        }
      }

      if (!bestEdge) {
        // Stuck - return what we have plus end point
        if (distM(current[0], current[1], endLat, endLon) < 200) {
          path.push(toScreen(endLat, endLon));
          return path;
        }
        return null; // Can't complete path
      }

      visited.add(`${bestEdge.lat1},${bestEdge.lon1}-${bestEdge.lat2},${bestEdge.lon2}`);
      current = bestNext;
    }

    return null; // Too many steps
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // DEBUG: Fetch tram line graph edges for visualization
  // ─────────────────────────────────────────────────────────────────────────────

  // Find the nearest track edge and snap point for a given lat/lon
  // Returns { edge, snapLat, snapLon, t } or null
  RoadMatcher.prototype._snapToTrackEdge = function (lat, lon, edges) {
    if (!edges || edges.length === 0) return null;

    let bestEdge = null;
    let bestDist = Infinity;
    let bestSnap = null;
    let bestT = 0;
    const MAX_DIST_DEG = 0.01; // ~1km in degrees

    for (const e of edges) {
      // Quick bounding box check
      const minLat = Math.min(e.lat1, e.lat2) - MAX_DIST_DEG;
      const maxLat = Math.max(e.lat1, e.lat2) + MAX_DIST_DEG;
      const minLon = Math.min(e.lon1, e.lon2) - MAX_DIST_DEG;
      const maxLon = Math.max(e.lon1, e.lon2) + MAX_DIST_DEG;

      if (lat < minLat || lat > maxLat || lon < minLon || lon > maxLon) continue;

      // Project point onto edge segment
      const ax = e.lon1, ay = e.lat1;
      const bx = e.lon2, by = e.lat2;
      const px = lon, py = lat;

      const abx = bx - ax, aby = by - ay;
      const apx = px - ax, apy = py - ay;
      const abLen2 = abx * abx + aby * aby;

      if (abLen2 < 1e-12) continue;

      const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / abLen2));
      const projLon = ax + t * abx;
      const projLat = ay + t * aby;

      const dist = Math.hypot(px - projLon, py - projLat);
      if (dist < bestDist && dist < MAX_DIST_DEG) {
        bestDist = dist;
        bestEdge = e;
        bestSnap = { lat: projLat, lon: projLon };
        bestT = t;
      }
    }

    if (!bestEdge) return null;
    return { edge: bestEdge, snapLat: bestSnap.lat, snapLon: bestSnap.lon, t: bestT };
  };

  // Walk along track edges from point A to point B using greedy edge-following
  // Returns array of screen points along the track, or null if can't find path
  RoadMatcher.prototype._walkTrackPath = function (lat1, lon1, lat2, lon2, edges, toScreen) {
    if (!edges || edges.length === 0) {
      if (!this._walkNoEdgesLogged) {
        console.log(`[WALK DEBUG] No edges available`);
        this._walkNoEdgesLogged = true;
      }
      return null;
    }

    // Snap both endpoints to nearest edge
    const snap1 = this._snapToTrackEdge(lat1, lon1, edges);
    const snap2 = this._snapToTrackEdge(lat2, lon2, edges);

    if (!snap1 || !snap2) {
      if (!this._walkDebugLogged) {
        console.log(`[WALK DEBUG] snap failed: snap1=${!!snap1}, snap2=${!!snap2}, pt1=(${lat1?.toFixed(5)},${lon1?.toFixed(5)}), pt2=(${lat2?.toFixed(5)},${lon2?.toFixed(5)}), edges=${edges.length}`);
        // Sample a few edges near the point
        const sampleEdges = edges.filter(e => {
          const d1 = Math.hypot(e.lat1 - lat1, e.lon1 - lon1);
          const d2 = Math.hypot(e.lat2 - lat1, e.lon2 - lon1);
          return d1 < 0.01 || d2 < 0.01;
        }).slice(0, 3);
        console.log(`[WALK DEBUG] Nearby edges for pt1: ${JSON.stringify(sampleEdges)}`);
        this._walkDebugLogged = true;
      }
      return null;
    }

    // Log first successful snap
    if (!this._walkSnapLogged) {
      console.log(`[WALK DEBUG] snap1: edge=(${snap1.edge.lat1.toFixed(5)},${snap1.edge.lon1.toFixed(5)})-(${snap1.edge.lat2.toFixed(5)},${snap1.edge.lon2.toFixed(5)}), snap=(${snap1.snapLat.toFixed(5)},${snap1.snapLon.toFixed(5)})`);
      console.log(`[WALK DEBUG] snap2: edge=(${snap2.edge.lat1.toFixed(5)},${snap2.edge.lon1.toFixed(5)})-(${snap2.edge.lat2.toFixed(5)},${snap2.edge.lon2.toFixed(5)}), snap=(${snap2.snapLat.toFixed(5)},${snap2.snapLon.toFixed(5)})`);
      this._walkSnapLogged = true;
    }

    // If both on same edge, just return the two snapped points
    if (snap1.edge === snap2.edge) {
      return [
        toScreen(snap1.snapLat, snap1.snapLon),
        toScreen(snap2.snapLat, snap2.snapLon)
      ];
    }

    // Helper: distance in meters (approximate)
    const distM = (lat1, lon1, lat2, lon2) => {
      const dlat = (lat2 - lat1) * 111000;
      const dlon = (lon2 - lon1) * 111000 * Math.cos(lat1 * Math.PI / 180);
      return Math.hypot(dlat, dlon);
    };

    // Helper: get endpoint of edge closer to target
    const closerEndpoint = (edge, targetLat, targetLon) => {
      const d1 = distM(edge.lat1, edge.lon1, targetLat, targetLon);
      const d2 = distM(edge.lat2, edge.lon2, targetLat, targetLon);
      return d1 < d2
        ? { lat: edge.lat1, lon: edge.lon1 }
        : { lat: edge.lat2, lon: edge.lon2 };
    };

    // Helper: check if point is an endpoint of edge (within threshold)
    const isOnEdge = (pt, edge) => {
      return distM(pt.lat, pt.lon, edge.lat1, edge.lon1) < 25 ||
             distM(pt.lat, pt.lon, edge.lat2, edge.lon2) < 25;
    };

    // Helper: find edges connected to a point (endpoint within threshold)
    const CONNECT_DIST = 25; // meters - increased for OSM data tolerance
    const findConnectedEdges = (pt, visitedEdges) => {
      const connected = [];
      for (const e of edges) {
        // Skip already visited edges
        const eKey = `${e.lat1},${e.lon1}-${e.lat2},${e.lon2}`;
        if (visitedEdges.has(eKey)) continue;

        const d1 = distM(pt.lat, pt.lon, e.lat1, e.lon1);
        const d2 = distM(pt.lat, pt.lon, e.lat2, e.lon2);

        if (d1 < CONNECT_DIST) {
          connected.push({ edge: e, otherEnd: { lat: e.lat2, lon: e.lon2 }, key: eKey, dist: d1 });
        } else if (d2 < CONNECT_DIST) {
          connected.push({ edge: e, otherEnd: { lat: e.lat1, lon: e.lon1 }, key: eKey, dist: d2 });
        }
      }
      return connected;
    };

    // Greedy walk: always move toward destination
    const path = [toScreen(snap1.snapLat, snap1.snapLon)];
    const visitedEdges = new Set();

    // Mark starting edge as visited
    const startEdgeKey = `${snap1.edge.lat1},${snap1.edge.lon1}-${snap1.edge.lat2},${snap1.edge.lon2}`;
    visitedEdges.add(startEdgeKey);

    // Start from endpoint of edge1 closer to destination
    let current = closerEndpoint(snap1.edge, lat2, lon2);
    path.push(toScreen(current.lat, current.lon));

    // Log the walk start
    if (!this._walkStartLogged) {
      const startDist = distM(snap1.snapLat, snap1.snapLon, snap2.snapLat, snap2.snapLon);
      console.log(`[WALK DEBUG] Starting walk: from (${current.lat.toFixed(5)},${current.lon.toFixed(5)}) to edge at (${snap2.edge.lat1.toFixed(5)},${snap2.edge.lon1.toFixed(5)}), direct=${startDist.toFixed(1)}m`);
      this._walkStartLogged = true;
    }

    for (let step = 0; step < 100; step++) {
      // Check if we reached edge2
      if (isOnEdge(current, snap2.edge)) {
        path.push(toScreen(snap2.snapLat, snap2.snapLon));
        if (!this._walkSuccessLogged) {
          console.log(`[WALK DEBUG] SUCCESS after ${step} steps, path length=${path.length}`);
          this._walkSuccessLogged = true;
        }
        return path;
      }

      // Find connected edges
      const connected = findConnectedEdges(current, visitedEdges);
      if (connected.length === 0) {
        // Stuck - complete path to destination and return what we have
        const directDist = distM(current.lat, current.lon, snap2.snapLat, snap2.snapLon);
        if (directDist < 500) {
          path.push(toScreen(snap2.snapLat, snap2.snapLon));
          return path;
        }
        if (!this._walkStuckLogged) {
          console.log(`[WALK DEBUG] STUCK at step ${step}: no connected edges from (${current.lat.toFixed(5)},${current.lon.toFixed(5)}), directDist=${directDist.toFixed(1)}m, visited=${visitedEdges.size}`);
          this._walkStuckLogged = true;
        }
        return null;
      }

      // Pick next edge - prefer continuing the track over jumping
      // If only one option, take it (this follows curves correctly)
      // If multiple options (junction), pick closest to destination
      let bestChoice = null;
      if (connected.length === 1) {
        // Only one option - follow it (this is the key to following curves!)
        bestChoice = connected[0];
      } else {
        // Multiple options (junction) - pick by distance, but prefer closer connections
        let bestScore = Infinity;
        for (const choice of connected) {
          // Score = distance to destination + penalty for loose connection
          const destDist = distM(choice.otherEnd.lat, choice.otherEnd.lon, lat2, lon2);
          const connDist = choice.dist; // How tightly connected (closer = better)
          const score = destDist + connDist * 10; // Penalize loose connections
          if (score < bestScore) {
            bestScore = score;
            bestChoice = choice;
          }
        }
      }

      if (!bestChoice) return null;

      visitedEdges.add(bestChoice.key);
      current = bestChoice.otherEnd;
      path.push(toScreen(current.lat, current.lon));
    }

    // Too many steps
    if (!this._walkTooManyLogged) {
      console.log(`[WALK DEBUG] TOO MANY STEPS (100), path length=${path.length}`);
      this._walkTooManyLogged = true;
    }
    return null;
  };

  RoadMatcher.prototype._fetchTramLineEdgesForViewport = async function () {
    const view = this.view;
    // Always fetch if we have TRX vehicles OR debug mode is on
    if (!view._pbDebugPath && !view._pbDebugRoadLines && !view._hasTrxVehicles) return;
    if (this._tramEdgesFetching) return;

    // Get viewport bounds
    const rect = view.overlayCanvas.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    const centerW = g.latLonToWorld(view.center.lat, view.center.lon, view.zoom);

    // Convert corners to lat/lon with 3x buffer for trail path walking
    // Trails can extend well beyond the visible viewport
    const bufferW = w * 1.5;
    const bufferH = h * 1.5;
    const tl = g.worldToLatLon(centerW.x - bufferW, centerW.y - bufferH, view.zoom);
    const br = g.worldToLatLon(centerW.x + bufferW, centerW.y + bufferH, view.zoom);

    const minLat = Math.min(tl.lat, br.lat);
    const maxLat = Math.max(tl.lat, br.lat);
    const minLon = Math.min(tl.lon, br.lon);
    const maxLon = Math.max(tl.lon, br.lon);

    // Don't refetch if viewport hasn't changed much (use coarse key to avoid excessive fetches)
    // Use .toFixed(1) (~11 km granularity) so smooth zoom/pan doesn't trigger a fetch every frame.
    const key = `${minLat.toFixed(1)},${maxLat.toFixed(1)},${minLon.toFixed(1)},${maxLon.toFixed(1)}`;
    if (this._tramEdgesLastKey === key) return;

    // Debounce: wait 300ms after last viewport change before fetching.
    if (this._tramEdgesDebounce) clearTimeout(this._tramEdgesDebounce);
    this._tramEdgesDebounce = setTimeout(() => {
      this._tramEdgesDebounce = null;
      this._doFetchTramLineEdges(minLat, maxLat, minLon, maxLon, key);
    }, 300);
  };

  RoadMatcher.prototype._doFetchTramLineEdges = async function (minLat, maxLat, minLon, maxLon, key) {
    const view = this.view;
    if (this._tramEdgesFetching) return;
    this._tramEdgesFetching = true;
    try {
      const url = `${g.appConfig.apiBaseUrl}/tram_line_edges?minLat=${minLat}&maxLat=${maxLat}&minLon=${minLon}&maxLon=${maxLon}&limit=8000`;
      const resp = await fetch(url);
      if (!resp.ok) return;
      const data = await resp.json();
      view._tramLineEdges = data.edges || [];
      view._tramLineHasElevation = data.has_elevation || false;
      this._tramEdgesLastKey = key;
      // Trigger redraw
      view.drawOverlay(view.lastState);
    } catch (e) {
      console.warn("Failed to fetch tram line edges:", e);
    } finally {
      this._tramEdgesFetching = false;
    }
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // FOVEATED ROAD MATCHING: Match segments progressively as vehicles drive.
  // Uses vehicle physics lookahead (not arbitrary time) to determine what to match.
  // ─────────────────────────────────────────────────────────────────────────────

  RoadMatcher.prototype._isRangeMatched = function (sensorId, fromMs, toMs) {
    const ranges = this.view._roadMatchedRangesById.get(sensorId);
    if (!ranges || ranges.length === 0) return false;
    for (const r of ranges) {
      if (r.fromMs <= fromMs && r.toMs >= toMs) return true;
    }
    return false;
  };

  RoadMatcher.prototype._markRangeMatched = function (sensorId, fromMs, toMs) {
    const view = this.view;
    if (!view._roadMatchedRangesById.has(sensorId)) {
      view._roadMatchedRangesById.set(sensorId, []);
    }
    const ranges = view._roadMatchedRangesById.get(sensorId);
    // Merge with any overlapping/adjacent existing ranges to keep array compact
    let newFrom = fromMs, newTo = toMs;
    let i = 0;
    while (i < ranges.length) {
      const r = ranges[i];
      if (r.toMs < newFrom || r.fromMs > newTo) { i++; continue; }
      newFrom = Math.min(newFrom, r.fromMs);
      newTo = Math.max(newTo, r.toMs);
      ranges.splice(i, 1);
    }
    ranges.push({ fromMs: newFrom, toMs: newTo });
  };

  /**
   * Request road matching for segments vehicles are about to drive through.
   * Uses vehicle position + physics lookahead distance.
   */
  RoadMatcher.prototype._requestFoveatedRoadMatching = async function () {
    const view = this.view;
    if (!view._historicalMode) return;
    if (!view.playbackMode) return;

    // Throttle: max 1 batch per 500ms
    const perfNow = performance.now();
    if (perfNow - this._roadMatchLastRequestMs < 500) return;
    this._roadMatchLastRequestMs = perfNow;

    const state = window._historicalState;
    const mobiles = Array.isArray(state?.mobile) ? state.mobile : [];

    for (const m of mobiles) {
      const id = m?.id;
      if (!id) continue;

      if (view._roadMatchPending.has(id)) continue;

      // Skip TRAX (rail) - COMMENTED OUT: will use tram line data instead of road graph
      // const sid = String(id).toUpperCase();
      // if (sid.startsWith("TRX") || sid.startsWith("TRAX")) continue;

      // Get vehicle physics state (or use playback time-based position)
      const phys = view._physicsStateById?.get(String(id));
      const pts = view._playbackPtsById.get(String(id));
      if (!pts || pts.length < 2) continue;

      // Use physics distance if available, otherwise estimate from playback time.
      // Both lookups ride the SAME cumulative-distance array _getPathDistances
      // already builds/maintains incrementally for rendering (engine_vehicle_
      // motion.js) — this function used to re-sum haversine distances from the
      // start of `pts` on every call instead, an O(trail-so-far) rescan that
      // this 500ms-throttled loop paid again and again, growing with every
      // point the vehicle had logged that day. Binary search replaces both
      // linear scans; `pts` is time-sorted, `cumDist` is distance-sorted.
      const { cumDist } = view._getPathDistances(String(id), pts);
      let currentD = 0;
      if (phys && phys.d > 0) {
        currentD = phys.d;
      } else {
        // Estimate position from playback time
        const pbTimeMs = view.getPlaybackTimeMs();
        if (pbTimeMs != null) {
          let lo = 0, hi = pts.length - 1;
          while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (pts[mid].tMs <= pbTimeMs) lo = mid; else hi = mid - 1;
          }
          currentD = pts[lo].tMs <= pbTimeMs ? cumDist[lo] : 0;
        }
      }

      // Find segment ahead of vehicle using lookahead distance
      const lookaheadD = currentD + g.MapView.CURVATURE_LOOKAHEAD * 2;

      // Find indices in trail corresponding to [currentD, lookaheadD]
      let startIdx = 0, hiS = pts.length - 1;
      while (startIdx < hiS) {
        const mid = (startIdx + hiS + 1) >> 1;
        if (cumDist[mid] <= currentD) startIdx = mid; else hiS = mid - 1;
      }
      let endIdx = pts.length - 1, loE = 0;
      while (loE < endIdx) {
        const mid = (loE + endIdx) >> 1;
        if (cumDist[mid] >= lookaheadD) endIdx = mid; else loE = mid + 1;
      }

      const fromMs = pts[startIdx]?.tMs;
      const toMs = pts[endIdx]?.tMs;
      if (!isFinite(fromMs) || !isFinite(toMs)) continue;
      if (this._isRangeMatched(id, fromMs, toMs)) continue;

      // Get raw trail segment
      const trail = Array.isArray(m?.trail) ? m.trail : [];
      const segmentPts = trail.filter(p => {
        const tMs = (p && typeof p.t === "string") ? g.parseUtcMs(p.t) : null;
        return tMs != null && tMs >= fromMs && tMs <= toMs;
      });

      if (segmentPts.length < 2) continue;
      if (segmentPts.some(p => p.wp === 1)) {
        this._markRangeMatched(id, fromMs, toMs);
        continue;
      }

      view._roadMatchPending.add(id);
      this._fetchAndApplyRoadMatch(id, segmentPts, fromMs, toMs);
    }
  };

  RoadMatcher.prototype._fetchAndApplyRoadMatch = async function (sensorId, trailSegment, fromMs, toMs) {
    const view = this.view;
    try {
      const trailJson = JSON.stringify(trailSegment);
      const url = `${g.appConfig.apiBaseUrl}/match_segment?sensor=${encodeURIComponent(sensorId)}&trail=${encodeURIComponent(trailJson)}`;
      const resp = await fetch(url, { headers: { "X-App-Token": g.APP_TOKEN } });
      if (!resp.ok) return;

      const data = await resp.json();
      const matchedTrail = data.trail;
      if (!Array.isArray(matchedTrail) || matchedTrail.length === 0) return;

      // Merge into state
      const state = window._historicalState;
      const mobiles = Array.isArray(state?.mobile) ? state.mobile : [];
      const mobile = mobiles.find(m => m?.id === sensorId);
      if (!mobile || !Array.isArray(mobile.trail)) return;

      // Build map of matched points by time
      const matchedByTime = new Map();
      for (const p of matchedTrail) {
        const tMs = (p && typeof p.t === "string") ? g.parseUtcMs(p.t) : null;
        if (tMs != null) {
          if (!matchedByTime.has(tMs)) matchedByTime.set(tMs, []);
          matchedByTime.get(tMs).push(p);
        }
      }

      // Splice matched points into trail
      const newTrail = [];
      for (const p of mobile.trail) {
        const tMs = (p && typeof p.t === "string") ? g.parseUtcMs(p.t) : null;
        if (tMs != null && matchedByTime.has(tMs)) {
          newTrail.push(...matchedByTime.get(tMs));
          matchedByTime.delete(tMs);
        } else if (!p.wp) {
          newTrail.push(p);
        }
      }

      mobile.trail = newTrail;
      view._playbackPtsKey = ""; // Invalidate cache
      view._ensurePlaybackPoints(state);
      this._markRangeMatched(sensorId, fromMs, toMs);

    } catch (e) {
      console.warn(`Road match error for ${sensorId}:`, e);
    } finally {
      view._roadMatchPending.delete(sensorId);
    }
  };

  return RoadMatcher;
});
