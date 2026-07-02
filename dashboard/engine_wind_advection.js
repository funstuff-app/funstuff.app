/**
 * engine_wind_advection.js — WindAdvection: wind field fetch/merge/interpolation
 * and advection-worker glue (pa_advection_worker.js).
 *
 * MapView keeps shared view state (canvas/center/zoom/dpr/playback clock/
 * lastState/gesture flags) and exposes it via `this.view`. MapView's own
 * mergeWindSnapshot/_fetchWindField/etc. become one-line delegates to
 * `this.windAdvection.<method>()`.
 *
 * Shared MapView fields read/written here (kept on MapView, not moved, because
 * non-moved code also touches them): lastState, playbackMode, center, zoom,
 * _cssW, _cssH, _dpr, _isGesturing(), _compositePaFieldOnTiles(), drawOverlay().
 */
(function (root, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else {
    root.WindAdvection = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Globals from earlier-loaded scripts (config.js, projections.js,
  // advection_solver.js, data_utils.js, engine_field_sensors.js) are resolved
  // lazily at call time — never at module factory time (node tests have no
  // browser globals).
  var g = (typeof window !== "undefined") ? window : globalThis;

  /**
   * @param {object} view — MapView instance (owns shared canvas/center/zoom/
   *   playback-clock/lastState state; see file header for the full shared-field
   *   list).
   */
  function WindAdvection(view) {
    this.view = view;

    // ── Advection-diffusion wind field state ──────────────────────────────
    this._advectionWorker = null;
    this._advectionFrame = null;    // latest { px, gw, gh } from worker
    this._advectionCanvas = null;   // offscreen canvas for upscaling
    this._advectionInitialized = false;
    this._advectionLastTickMs = 0;  // performance.now() of last tick
    this._advectionSensorFP = "";   // fingerprint to detect sensor changes
    this._windField = null;         // current [{lat,lon,u,v}, ...] for rendering
    this._windSnapshots = null;      // {"HHMM": [{lat,lon,u,v},...], ...} all day's snapshots
    this._windSnapshotKeys = [];     // sorted ["0000","0015",...]
    this._windFieldEtag = null;
    this._windFieldLastFetch = 0;   // performance.now() of last fetch
    this._windFieldFetchInterval = 900000; // 15 min
    this._windFieldFetchInFlight = false;
  }

  // ─── Advection-diffusion wind field integration ─────────────────────────

  /**
   * Collect sensor data in geographic coordinates for the advection worker.
   * Returns [{lat, lon, value}, ...] — all fixed+PA sensors with valid PM2.5.
   */
  WindAdvection.prototype._collectGeoSensors = function (state, playbackTimeMs) {
    const fixed = Array.isArray(state && state.fixed) ? state.fixed : [];
    const paLatLons = [];
    for (const f of fixed) {
      if (!f || !f.purpleair) continue;
      const lat = Number(f.lat), lon = Number(f.lon);
      if (isFinite(lat) && isFinite(lon)) paLatLons.push(lat, lon);
    }
    const sensors = [];
    for (const f of fixed) {
      if (!f) continue;
      if (f.outlier) continue;
      const lat = Number(f.lat), lon = Number(f.lon);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      if (!f.purpleair) {
        let nearPA = false;
        for (let pi = 0; pi < paLatLons.length; pi += 2) {
          const dlat = lat - paLatLons[pi], dlon = lon - paLatLons[pi + 1];
          if (dlat * dlat + dlon * dlon < g.FieldSensors._PA_FIELD_NON_PURPLEAIR_PROXIMITY_DEG * g.FieldSensors._PA_FIELD_NON_PURPLEAIR_PROXIMITY_DEG) { nearPA = true; break; }
        }
        if (!nearPA) continue;
      }
      const interp = g.interpolateFixedReadingsAtTime(f, playbackTimeMs);
      const pm = interp && (interp["PM25"] || interp["PM2.5"] || interp["pm25"] || interp["pm2.5"]);
      if (pm && pm.outlier) continue;
      const value = pm && pm.value != null ? Number(pm.value) : NaN;
      if (!isFinite(value) || value < 0) continue;
      sensors.push({ lat, lon, value });
    }
    return sensors;
  };

  /** Build a color-category fingerprint for geo sensors. */
  WindAdvection.prototype._geoSensorFingerprint = function (sensors) {
    let fp = "";
    for (const s of sensors) fp += g.FieldSensors._pm25ColorCat(s.value);
    return fp;
  };

  /** Fetch all wind snapshots from /api/wind-field (returns {HHMM: points[]}). */
  /**
   * Merge a single wind snapshot received via SSE into the existing snapshots.
   * Avoids a full /api/wind-field refetch.
   * @param {string} key - HHMM key (e.g. "1430")
   * @param {Array} points - Array of {lat, lon, u, v} objects
   */
  WindAdvection.prototype.mergeWindSnapshot = function (key, points) {
    if (g.WIND_LOADING_DISABLED) return;
    if (!key || !points) return;
    // Accept both grid objects and legacy point arrays
    if (Array.isArray(points) && !points.length) return;
    if (typeof points === "object" && !Array.isArray(points) && !points.uGrid) return;
    if (!this._windSnapshots) this._windSnapshots = {};
    this._windSnapshots[key] = points;
    this._windSnapshotKeys = Object.keys(this._windSnapshots).sort();
    // Update current field to latest snapshot
    if (this._windSnapshotKeys.length > 0) {
      const latest = this._windSnapshotKeys[this._windSnapshotKeys.length - 1];
      this._windField = this._windSnapshots[latest];
    }
    // Bump the etag so the next _fetchWindField doesn't overwrite with stale data
    this._windFieldEtag = null;
    // Trigger a redraw if we have state (skip during gestures — next frame picks it up)
    const view = this.view;
    if (view.lastState && !view._isGesturing()) {
      requestAnimationFrame(() => {
        view._compositePaFieldOnTiles(view.lastState);
        view.drawOverlay(view.lastState, { cacheUnderlay: true });
      });
    }
  };

  WindAdvection.prototype._fetchWindField = function () {
    if (g.WIND_LOADING_DISABLED) return;
    if (this._windFieldFetchInFlight) return;
    const now = performance.now();
    if (now - this._windFieldLastFetch < this._windFieldFetchInterval && this._windSnapshots) return;
    this._windFieldFetchInFlight = true;
    this._windFieldLastFetch = now;
    const headers = { "X-App-Token": g.APP_TOKEN };
    if (this._windFieldEtag) headers["If-None-Match"] = this._windFieldEtag;
    const view = this.view;
    fetch("/api/wind-field", { headers })
      .then(res => {
        if (res.status === 304) return null;
        if (!res.ok) return null;
        this._windFieldEtag = res.headers.get("ETag") || null;
        return res.json();
      })
      .then(data => {
        if (!data || typeof data !== "object") return;
        const wasNull = !this._windSnapshots;
        if (Array.isArray(data)) {
          // Legacy flat point array — treat as single "now" entry
          if (data.length > 0) {
            this._windSnapshots = { "0000": data };
            this._windSnapshotKeys = ["0000"];
            this._windField = data;
          }
        } else if (data.gw != null && data.uGrid != null) {
          // Single grid object (legacy fallback from wind_field_json)
          this._windSnapshots = { "0000": data };
          this._windSnapshotKeys = ["0000"];
          this._windField = data;
        } else {
          // Time-indexed: {"HHMM": grid_or_array, ...}
          this._windSnapshots = data;
          this._windSnapshotKeys = Object.keys(data).sort();
          // Set current field to latest snapshot
          if (this._windSnapshotKeys.length > 0) {
            const latest = this._windSnapshotKeys[this._windSnapshotKeys.length - 1];
            this._windField = data[latest];
          }
        }
        if (wasNull && view.lastState) {
          requestAnimationFrame(() => {
            view._compositePaFieldOnTiles(view.lastState);
            view.drawOverlay(view.lastState, { cacheUnderlay: true });
          });
        }
      })
      .catch(() => { /* silent */ })
      .finally(() => { this._windFieldFetchInFlight = false; });
  };

  /** Interpolate u,v components between two wind field snapshots.
   *  Supports both grid objects {gw, gh, uGrid, vGrid, bounds} and
   *  legacy point arrays [{lat, lon, u, v}, ...].
   *  Returns an interpolated snapshot in the same format as the inputs. */
  WindAdvection.prototype._interpolateWindFields = function (fieldA, fieldB, alpha) {
    if (!fieldA || !fieldB) return fieldA;
    // Grid object path
    if (fieldA.gw != null && fieldA.uGrid && fieldB.gw != null && fieldB.uGrid) {
      const n = fieldA.gw * fieldA.gh;
      const uA = fieldA.uGrid, vA = fieldA.vGrid;
      const uB = fieldB.uGrid, vB = fieldB.vGrid;
      if (uA.length !== n || uB.length !== n) return fieldA;
      const uGrid = new Array(n), vGrid = new Array(n);
      for (let i = 0; i < n; i++) {
        uGrid[i] = Math.round(((1 - alpha) * (uA[i] || 0) + alpha * (uB[i] || 0)) * 1000) / 1000;
        vGrid[i] = Math.round(((1 - alpha) * (vA[i] || 0) + alpha * (vB[i] || 0)) * 1000) / 1000;
      }
      return { gw: fieldA.gw, gh: fieldA.gh, bounds: fieldA.bounds, uGrid, vGrid };
    }
    // Legacy point-array path
    if (!Array.isArray(fieldA) || !Array.isArray(fieldB)) return fieldA;
    if (fieldA.length !== fieldB.length) return fieldA;

    const result = [];
    for (let i = 0; i < fieldA.length; i++) {
      const ptA = fieldA[i], ptB = fieldB[i];
      if (!ptA || !ptB) continue;
      const lat = Number(ptA.lat), lon = Number(ptA.lon);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      const uA = Number(ptA.u) || 0;
      const vA = Number(ptA.v) || 0;
      const uB = Number(ptB.u) || 0;
      const vB = Number(ptB.v) || 0;
      // Linear interpolation: (1-α)·u_A + α·u_B
      const u = (1 - alpha) * uA + alpha * uB;
      const v = (1 - alpha) * vA + alpha * vB;
      result.push({ lat, lon, u, v });
    }
    return result.length > 0 ? result : fieldA;
  };

  /** Pick the wind snapshot active at a given epoch-ms time (or latest if live).
   *  Interpolates between snapshots during playback; returns discrete snapshot if scrubbing.
   *  Returns null if no snapshots available. */
  WindAdvection.prototype._windFieldForTime = function (epochMs, doInterpolate = false) {
    if (!this._windSnapshots || this._windSnapshotKeys.length === 0) return this._windField;
    if (epochMs == null || !isFinite(epochMs)) {
      // Live mode — use latest
      const latest = this._windSnapshotKeys[this._windSnapshotKeys.length - 1];
      return this._windSnapshots[latest] || this._windField;
    }

    // Convert epoch ms to minutes since midnight UTC
    const d = new Date(epochMs);
    const totalMinUTC = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;

    // Floor/ceil to 15-min boundaries (in total minutes)
    const floorMin = Math.floor(totalMinUTC / 15) * 15;
    const ceilMin = floorMin + 15;

    // Convert total minutes → "HHMM" key
    const minToKey = (m) => {
      const h = Math.floor(m / 60) % 24;
      const mn = m % 60;
      return String(h).padStart(2, "0") + String(mn).padStart(2, "0");
    };
    const keyFloor = minToKey(floorMin);
    const keyCeil = minToKey(ceilMin);

    // Look up snapshot indices
    let keyFloorIndex = -1, keyCeilIndex = -1;
    for (let i = 0; i < this._windSnapshotKeys.length; i++) {
      if (this._windSnapshotKeys[i] === keyFloor) keyFloorIndex = i;
      if (this._windSnapshotKeys[i] === keyCeil) keyCeilIndex = i;
    }

    // If we don't have both snapshots, return the latest one we have <= target
    if (keyFloorIndex < 0 || keyCeilIndex < 0) {
      let best = null;
      for (let i = this._windSnapshotKeys.length - 1; i >= 0; i--) {
        if (this._windSnapshotKeys[i] <= keyFloor) {
          best = this._windSnapshotKeys[i];
          break;
        }
      }
      return best ? this._windSnapshots[best] : null;
    }

    // Interpolate if requested and we have both boundaries
    if (doInterpolate) {
      const fieldA = this._windSnapshots[keyFloor];
      const fieldB = this._windSnapshots[keyCeil];
      if (fieldA && fieldB) {
        // Alpha: progress from floor to ceil (0 at floor, 1 at ceil)
        const alpha = (totalMinUTC - floorMin) / 15;
        return this._interpolateWindFields(fieldA, fieldB, Math.max(0, Math.min(1, alpha)));
      }
    }

    // No interpolation: return floor snapshot
    return this._windSnapshots[keyFloor];
  };

  /** Initialize or re-initialize the advection worker with current sensors + wind. */
  WindAdvection.prototype._initAdvectionWorker = function (sensors, fieldAlpha) {
    if (!this._advectionWorker) {
      try {
        this._advectionWorker = new Worker("pa_advection_worker.js?v=20260327a");
        this._advectionWorker.onmessage = (e) => this._onAdvectionFrame(e.data);
      } catch (_) {
        this._advectionWorker = false;
        return;
      }
    }
    if (!this._advectionWorker) return;

    const params = {
      cutoffDeg: 0.5,
      D: 500,
      lambda: 0.2,
      windScale: 1.0,
      settlingTicks: 20,
    };
    // Apply field debug overrides
    const _fd = window._fieldDebug;
    if (_fd.cutoffDeg != null) params.cutoffDeg = _fd.cutoffDeg;
    if (_fd.diffusion != null) params.D = _fd.diffusion;
    if (_fd.lambda != null) params.lambda = _fd.lambda;
    if (_fd.windScale != null) params.windScale = _fd.windScale;

    this._advectionWorker.postMessage({
      type: "init",
      sensors,
      windPoints: this._windField || [],
      params,
      fieldAlpha: fieldAlpha || 46,
    });

    this._advectionInitialized = true;
    this._advectionLastTickMs = performance.now();
  };

  /** Handle a rendered frame from the advection worker. */
  WindAdvection.prototype._onAdvectionFrame = function (data) {
    if (data.type !== "frame") return;
    const { px, gw, gh } = data;
    this._advectionFrame = { px: new Uint8ClampedArray(px), gw, gh };
    // Upscale to screen and store as offscreen canvas for compositing
    this._projectAdvectionToScreen();
    // Schedule a re-composite so the frame actually appears on screen
    const view = this.view;
    if (!this._advectionRAF) {
      this._advectionRAF = requestAnimationFrame(() => {
        this._advectionRAF = null;
        if (view.lastState) {
          view._compositePaFieldOnTiles(view.lastState);
          view.drawOverlay(view.lastState, { cacheUnderlay: true });
        }
      });
    }
  };

  /**
   * Project the geographic-grid advection frame onto screen coordinates.
   * Uses the current view (center, zoom) to map each geo-cell onto the canvas.
   */
  WindAdvection.prototype._projectAdvectionToScreen = function () {
    const frame = this._advectionFrame;
    if (!frame) return;
    const { px, gw, gh } = frame;
    const view = this.view;
    const cssW = view._cssW || 1;
    const cssH = view._cssH || 1;
    const dpr = view._dpr || (window.devicePixelRatio || 1);

    // Create a tiny canvas at geo-grid resolution
    if (!this._advGeoCanvas) {
      this._advGeoCanvas = document.createElement("canvas");
    }
    const gc = this._advGeoCanvas;
    if (gc.width !== gw || gc.height !== gh) {
      gc.width = gw; gc.height = gh;
    }
    const gctx = gc.getContext("2d");
    const imgData = gctx.createImageData(gw, gh);
    imgData.data.set(px);
    gctx.putImageData(imgData, 0, 0);

    // Now project geo grid onto screen: find the screen rect for the geo bounds
    const AS = typeof AdvectionSolver !== "undefined" ? AdvectionSolver : null;
    if (!AS) return;
    const bounds = AS.GEO_BOUNDS;
    const z = Number(view.zoom);
    const clat = Number(view.center?.lat);
    const clon = Number(view.center?.lon);
    const centerW = g.latLonToWorld(clat, clon, z);

    // Geo bounds corners → screen
    const topLeft = g.latLonToWorld(bounds.latMax, bounds.lonMin, z);
    const botRight = g.latLonToWorld(bounds.latMin, bounds.lonMax, z);
    const sx = topLeft.x - centerW.x + cssW / 2;
    const sy = topLeft.y - centerW.y + cssH / 2;
    const sw = botRight.x - topLeft.x;
    const sh = botRight.y - topLeft.y;

    // Upscale to full viewport canvas
    if (!this._advectionCanvas) this._advectionCanvas = document.createElement("canvas");
    const pw = Math.floor(cssW * dpr), ph = Math.floor(cssH * dpr);
    if (this._advectionCanvas.width !== pw || this._advectionCanvas.height !== ph) {
      this._advectionCanvas.width = pw;
      this._advectionCanvas.height = ph;
    }
    const ctx = this._advectionCanvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    // Draw the geo-grid canvas stretched to the screen projection rect
    ctx.drawImage(gc, sx, sy, sw, sh);
  };

  /**
   * Tick the advection simulation and re-render.
   * Called from _compositePaFieldOnTiles when advection mode is active.
   * During playback, uses interpolated wind field; otherwise discrete snapshot.
   */
  WindAdvection.prototype._tickAdvection = function (state, playbackTimeMs) {
    if (!this._advectionWorker || !this._advectionInitialized) return;

    const nowPerf = performance.now();
    // Real-time dt (capped to 2s by worker)
    let dt = (nowPerf - this._advectionLastTickMs) / 1000;
    this._advectionLastTickMs = nowPerf;
    if (dt <= 0 || dt > 5) dt = 0.016; // default ~60fps

    // Check if sensors changed → update IDW nudging target
    const geoSensors = this._collectGeoSensors(state, playbackTimeMs);
    const fp = this._geoSensorFingerprint(geoSensors);
    const sensorsChanged = fp !== this._advectionSensorFP;
    this._advectionSensorFP = fp;

    const _fd = window._fieldDebug;
    const FIELD_ALPHA = _fd.alpha != null ? _fd.alpha : (window._paFieldAlpha ?? 46);

    // During playback, interpolate between wind snapshots; otherwise use discrete snapshot
    const isPlaybackTick = this.view.playbackMode && playbackTimeMs != null && isFinite(playbackTimeMs);
    const windField = isPlaybackTick
      ? this._windFieldForTime(playbackTimeMs, true)
      : this._windField;

    this._advectionWorker.postMessage({
      type: "tick",
      dt,
      sensors: sensorsChanged ? geoSensors : undefined,
      windPoints: windField || [],
      fieldAlpha: FIELD_ALPHA,
    });
  };

  /** Sample wind at map center, return { wx, wy, stretch, upwindShrink } in screen-pixel
   *  space, or null if no wind data / calm. Cached on wind field identity + zoom. */
  WindAdvection.prototype._sampleWindAtCenter = function (centerW, z, clat, clon, playbackTimeMs, _fd) {
    const windField = (this.view.playbackMode && playbackTimeMs != null && isFinite(playbackTimeMs))
      ? this._windFieldForTime(playbackTimeMs, true) : this._windField;
    if (!windField || !Array.isArray(windField) || windField.length < 2) return null;

    // Cache on wind field identity + zoom (not center — wind direction doesn't change on pan)
    if (this._windVecCache && this._windVecField === windField && this._windVecZoom === z)
      return this._windVecCache;

    const wspdMin  = _fd.wspdMin != null ? _fd.wspdMin : 0.3;
    const wspdMax  = _fd.wspdMax != null ? _fd.wspdMax : 5.0;
    const stretchMax   = _fd.stretchMax != null ? _fd.stretchMax : 2.5;
    const upwindShrink = _fd.upwindShrink != null ? _fd.upwindShrink : 0.5;

    // IDW sample wind at map center from existing wind field points
    let uSum = 0, vSum = 0, wt = 0;
    for (let i = 0; i < windField.length; i++) {
      const wp = windField[i];
      const dlat = clat - wp.lat, dlon = clon - wp.lon;
      const d2 = dlat * dlat + dlon * dlon + 1e-8;
      const w = 1 / d2;
      uSum += w * wp.u; vSum += w * wp.v; wt += w;
    }
    if (wt < 1e-12) { this._windVecCache = null; this._windVecField = windField; this._windVecZoom = z; return null; }

    const u = uSum / wt, v = vSum / wt;
    const wspd = Math.sqrt(u * u + v * v);
    if (wspd < wspdMin) { this._windVecCache = null; this._windVecField = windField; this._windVecZoom = z; return null; }

    // Transform u/v (m/s geographic) → screen-pixel unit vector
    const eps = 0.001;
    const dxPerDegLon = (g.latLonToWorld(clat, clon + eps, z).x - centerW.x) / eps;
    const dyPerDegLat = (g.latLonToWorld(clat + eps, clon, z).y - centerW.y) / eps;
    const cosLat = Math.cos(clat * Math.PI / 180);
    const pxU = u * dxPerDegLon / (111320 * cosLat);
    const pxV = v * dyPerDegLat / 111320;
    const pxSpd = Math.sqrt(pxU * pxU + pxV * pxV);
    if (pxSpd < 1e-9) { this._windVecCache = null; this._windVecField = windField; this._windVecZoom = z; return null; }

    const t = Math.max(0, Math.min(1, (wspd - wspdMin) / (wspdMax - wspdMin)));
    const stretch = 1.0 + (stretchMax - 1.0) * t * t * (3 - 2 * t);
    const result = { wx: pxU / pxSpd, wy: pxV / pxSpd, stretch, upwindShrink };
    this._windVecCache = result;
    this._windVecField = windField;
    this._windVecZoom = z;
    return result;
  };

  return WindAdvection;
});
