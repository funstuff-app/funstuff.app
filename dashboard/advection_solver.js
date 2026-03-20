(function (root, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else {
    root.AdvectionSolver = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ── Geographic grid bounds (matches SLC_BOUNDS with padding) ──────────────
  const GEO_BOUNDS = {
    latMin: 39.5,
    latMax: 41.5,
    lonMin: -113.0,
    lonMax: -111.0,
  };

  // Default grid dimensions: 80 cols × 60 rows ≈ 0.025° per cell ≈ 2km
  const DEFAULT_GW = 80;
  const DEFAULT_GH = 60;

  // ── Physics defaults ──────────────────────────────────────────────────────
  const DEFAULT_DIFFUSION = 500;    // m²/s (turbulent diffusion coefficient)
  const DEFAULT_LAMBDA = 0.2;       // nudging strength (s⁻¹)
  const DEFAULT_WIND_SCALE = 1.0;   // wind exaggeration multiplier

  // Meters per degree latitude (approximate for SLC ~40.6°N)
  const M_PER_DEG_LAT = 111320;
  // Meters per degree longitude at 40.6°N
  const M_PER_DEG_LON = 111320 * Math.cos(40.6 * Math.PI / 180);

  // ── PM2.5 → [r,g,b] — must match map_view.js _pm25ToRgbSmooth ───────────
  const COLOR_STOPS = [
    [0,     0x00,0xFF,0xFF],
    [1.0,   0x00,0xFF,0xFF],
    [3.5,   0x00,0xCC,0xFF],
    [7.0,   0x00,0xE4,0x00],
    [22.2,  0xFF,0xFF,0x00],
    [45.4,  0xFF,0x7E,0x00],
    [90.4,  0xFF,0x00,0x00],
    [175.4, 0x8F,0x3F,0x97],
    [250.0, 0x7E,0x00,0x23],
    [500,   0x7E,0x00,0x23],
  ];

  function pm25ToRgb(v) {
    const stops = COLOR_STOPS;
    if (v <= stops[0][0]) return [stops[0][1], stops[0][2], stops[0][3]];
    for (let i = 1; i < stops.length; i++) {
      if (v <= stops[i][0]) {
        const t = (v - stops[i-1][0]) / (stops[i][0] - stops[i-1][0]);
        return [
          Math.round(stops[i-1][1] + t * (stops[i][1] - stops[i-1][1])),
          Math.round(stops[i-1][2] + t * (stops[i][2] - stops[i-1][2])),
          Math.round(stops[i-1][3] + t * (stops[i][3] - stops[i-1][3])),
        ];
      }
    }
    const last = stops[stops.length - 1];
    return [last[1], last[2], last[3]];
  }

  // ── Grid helpers ──────────────────────────────────────────────────────────

  /** Cell size in degrees for a given grid + bounds. */
  function cellSizeDeg(bounds, gw, gh) {
    return {
      dLon: (bounds.lonMax - bounds.lonMin) / gw,
      dLat: (bounds.latMax - bounds.latMin) / gh,
    };
  }

  /** Geographic coordinate of cell center. */
  function cellCenter(ix, iy, bounds, gw, gh) {
    const { dLon, dLat } = cellSizeDeg(bounds, gw, gh);
    return {
      lon: bounds.lonMin + (ix + 0.5) * dLon,
      lat: bounds.latMin + (iy + 0.5) * dLat,
    };
  }

  /** Grid indices for a lat/lon (fractional, for bilinear interpolation). */
  function geoToGrid(lat, lon, bounds, gw, gh) {
    const { dLon, dLat } = cellSizeDeg(bounds, gw, gh);
    return {
      gx: (lon - bounds.lonMin) / dLon - 0.5,
      gy: (lat - bounds.latMin) / dLat - 0.5,
    };
  }

  /** Bilinear sample from a Float32Array grid. Returns 0 for out-of-bounds. */
  function bilinearSample(grid, gw, gh, fx, fy) {
    // Clamp to grid edges (Neumann BC)
    fx = Math.max(0, Math.min(gw - 1.001, fx));
    fy = Math.max(0, Math.min(gh - 1.001, fy));

    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, gw - 1);
    const y1 = Math.min(y0 + 1, gh - 1);
    const tx = fx - x0, ty = fy - y0;

    const v00 = grid[y0 * gw + x0];
    const v10 = grid[y0 * gw + x1];
    const v01 = grid[y1 * gw + x0];
    const v11 = grid[y1 * gw + x1];

    return (v00 * (1 - tx) * (1 - ty) +
            v10 * tx * (1 - ty) +
            v01 * (1 - tx) * ty +
            v11 * tx * ty);
  }

  // ── IDW interpolation on geographic grid ──────────────────────────────────

  /**
   * Compute IDW interpolation of sensor values onto the geographic grid.
   *
   * @param {Array} sensors - [{lat, lon, value}, ...]
   * @param {number} gw - grid width
   * @param {number} gh - grid height
   * @param {Object} bounds - {latMin, latMax, lonMin, lonMax}
   * @param {number} cutoffDeg - max influence distance in degrees
   * @returns {{values: Float32Array, wSum: Float32Array, alpha: Float32Array}}
   */
  function idwOnGeoGrid(sensors, gw, gh, bounds, cutoffDeg) {
    const values = new Float32Array(gw * gh);
    const wSum = new Float32Array(gw * gh);
    const alpha = new Float32Array(gw * gh);

    const cutoffSq = cutoffDeg * cutoffDeg;
    const sigmaFrac = cutoffDeg / 6;
    const twoSigSq = 2 * sigmaFrac * sigmaFrac;
    const eps2 = 0.0001; // regularisation in degrees²

    const { dLon, dLat } = cellSizeDeg(bounds, gw, gh);

    for (let iy = 0; iy < gh; iy++) {
      const lat = bounds.latMin + (iy + 0.5) * dLat;
      for (let ix = 0; ix < gw; ix++) {
        const lon = bounds.lonMin + (ix + 0.5) * dLon;
        let ws = 0, vs = 0, gs = 0;

        for (let si = 0; si < sensors.length; si++) {
          const s = sensors[si];
          const dlat = lat - s.lat;
          const dlon = lon - s.lon;
          const d2 = dlat * dlat + dlon * dlon;
          if (d2 > cutoffSq) continue;

          const t = d2 / cutoffSq;
          const envelope = (1 - t) * (1 - t);
          const w = envelope / (d2 + eps2);
          ws += w;
          vs += w * s.value;
          gs += Math.exp(-d2 / twoSigSq);
        }

        const idx = iy * gw + ix;
        wSum[idx] = ws;
        if (ws > 1e-12) {
          values[idx] = vs / ws;
          alpha[idx] = Math.min(1, gs * 2);
        }
      }
    }

    return { values, wSum, alpha };
  }

  // ── Semi-Lagrangian advection ─────────────────────────────────────────────

  /**
   * Semi-Lagrangian advection step.
   * For each grid cell, trace backward along wind vector, bilinear-sample.
   *
   * @param {Float32Array} c - concentration grid (gw × gh)
   * @param {Float32Array} u - eastward wind in cells/s (gw × gh)
   * @param {Float32Array} v - northward wind in cells/s (gw × gh)
   * @param {number} dt - timestep in seconds
   * @param {number} gw - grid width
   * @param {number} gh - grid height
   * @returns {Float32Array} new concentration grid
   */
  function semiLagrangianAdvect(c, u, v, dt, gw, gh) {
    const cNew = new Float32Array(gw * gh);
    for (let iy = 0; iy < gh; iy++) {
      for (let ix = 0; ix < gw; ix++) {
        const idx = iy * gw + ix;
        // Trace backward: departure point
        const fx = ix - u[idx] * dt;
        const fy = iy - v[idx] * dt;
        cNew[idx] = bilinearSample(c, gw, gh, fx, fy);
      }
    }
    return cNew;
  }

  // ── Explicit diffusion ────────────────────────────────────────────────────

  /**
   * Explicit diffusion step using 5-point Laplacian.
   * Mutates c in-place. Sub-steps if stability limit exceeded.
   *
   * @param {Float32Array} c - concentration grid (gw × gh) — mutated
   * @param {number} D - diffusion coefficient in m²/s
   * @param {number} dt - timestep in seconds
   * @param {number} gw - grid width
   * @param {number} gh - grid height
   * @param {Object} bounds - geographic bounds for cell-size calculation
   */
  function explicitDiffuse(c, D, dt, gw, gh, bounds) {
    const { dLon, dLat } = cellSizeDeg(bounds, gw, gh);
    const dxM = dLon * M_PER_DEG_LON;
    const dyM = dLat * M_PER_DEG_LAT;
    const Dx = D / (dxM * dxM);
    const Dy = D / (dyM * dyM);
    const maxD = Math.max(Dx, Dy);

    // Stability: maxD * subDt < 0.25
    let nSub = 1;
    if (maxD * dt > 0.25) {
      nSub = Math.ceil(maxD * dt / 0.25);
    }
    const subDt = dt / nSub;

    const tmp = new Float32Array(gw * gh);

    for (let sub = 0; sub < nSub; sub++) {
      // Copy c for Laplacian read (don't read from partially-updated grid)
      tmp.set(c);
      for (let iy = 1; iy < gh - 1; iy++) {
        for (let ix = 1; ix < gw - 1; ix++) {
          const idx = iy * gw + ix;
          const lap =
            Dx * (tmp[idx - 1] + tmp[idx + 1] - 2 * tmp[idx]) +
            Dy * (tmp[idx - gw] + tmp[idx + gw] - 2 * tmp[idx]);
          c[idx] = tmp[idx] + lap * subDt;
          if (c[idx] < 0) c[idx] = 0;
        }
      }
      // Neumann BC: copy from interior
      for (let ix = 0; ix < gw; ix++) {
        c[ix] = c[gw + ix];                         // bottom edge
        c[(gh - 1) * gw + ix] = c[(gh - 2) * gw + ix]; // top edge
      }
      for (let iy = 0; iy < gh; iy++) {
        c[iy * gw] = c[iy * gw + 1];                // left edge
        c[iy * gw + gw - 1] = c[iy * gw + gw - 2]; // right edge
      }
    }
  }

  // ── Sensor nudging ────────────────────────────────────────────────────────

  /**
   * Nudge concentration toward IDW observations.
   * Nudging strength is proportional to IDW weight-sum (strong near sensors).
   *
   * @param {Float32Array} c - concentration grid — mutated
   * @param {Float32Array} cIdw - IDW target values
   * @param {Float32Array} wSumGrid - IDW weight-sum per cell
   * @param {number} lambdaBase - base nudging strength (s⁻¹)
   * @param {number} dt - timestep in seconds
   * @param {number} gw - grid width
   * @param {number} gh - grid height
   */
  function nudge(c, cIdw, wSumGrid, lambdaBase, dt, gw, gh) {
    // wThreshold: weight-sum at half the cutoff distance for a single sensor
    // Using a reasonable default; actual value depends on cutoff + epsilon
    const wThreshold = 1.0;
    const n = gw * gh;
    for (let i = 0; i < n; i++) {
      const ws = wSumGrid[i];
      if (ws < 1e-12) continue; // no sensor coverage
      const lambda = lambdaBase * Math.min(1, ws / wThreshold);
      c[i] += lambda * dt * (cIdw[i] - c[i]);
      if (c[i] < 0) c[i] = 0;
    }
  }

  // ── Wind field interpolation ──────────────────────────────────────────────

  /**
   * Interpolate wind point data onto the geographic grid.
   * Wind points: [{lat, lon, u, v}, ...] where u=eastward, v=northward (m/s).
   * Returns u,v in cells/second (ready for semi-Lagrangian).
   *
   * @param {Array} windPoints - [{lat, lon, u, v}, ...]
   * @param {number} gw
   * @param {number} gh
   * @param {Object} bounds
   * @param {number} windScale - multiplier for visual exaggeration
   * @returns {{uGrid: Float32Array, vGrid: Float32Array}}
   */
  function interpolateWindField(windPoints, gw, gh, bounds, windScale) {
    const uGrid = new Float32Array(gw * gh);
    const vGrid = new Float32Array(gw * gh);

    if (!windPoints || windPoints.length === 0) return { uGrid, vGrid };

    const { dLon, dLat } = cellSizeDeg(bounds, gw, gh);
    // Convert m/s to cells/s
    const dxM = dLon * M_PER_DEG_LON;
    const dyM = dLat * M_PER_DEG_LAT;
    const scale = windScale || 1.0;

    // Simple IDW interpolation of wind components
    const cutoffDeg = 1.0; // 1° ≈ 85-111 km
    const cutoffSq = cutoffDeg * cutoffDeg;

    for (let iy = 0; iy < gh; iy++) {
      const lat = bounds.latMin + (iy + 0.5) * dLat;
      for (let ix = 0; ix < gw; ix++) {
        const lon = bounds.lonMin + (ix + 0.5) * dLon;
        const idx = iy * gw + ix;

        let wSum = 0, uSum = 0, vSum = 0;
        for (let wi = 0; wi < windPoints.length; wi++) {
          const wp = windPoints[wi];
          const dlat = lat - wp.lat;
          const dlon = lon - wp.lon;
          const d2 = dlat * dlat + dlon * dlon;
          if (d2 > cutoffSq) continue;
          const w = 1 / (d2 + 0.001);
          wSum += w;
          uSum += w * wp.u;
          vSum += w * wp.v;
        }

        if (wSum > 1e-12) {
          // Convert from m/s to cells/s
          // u_ms positive = eastward → positive gx direction
          // v_ms positive = northward → positive gy direction (lat increases with iy)
          uGrid[idx] = scale * (uSum / wSum) / dxM;
          vGrid[idx] = scale * (vSum / wSum) / dyM;
        }
      }
    }

    return { uGrid, vGrid };
  }

  /**
   * Build a uniform wind field from a single wind vector (AirNow fallback).
   *
   * @param {number} speedMs - wind speed in m/s
   * @param {number} dirDeg - wind direction in degrees (meteorological: FROM)
   * @param {number} gw
   * @param {number} gh
   * @param {Object} bounds
   * @param {number} windScale
   * @returns {{uGrid: Float32Array, vGrid: Float32Array}}
   */
  function uniformWindField(speedMs, dirDeg, gw, gh, bounds, windScale) {
    const scale = windScale || 1.0;
    const dirRad = dirDeg * Math.PI / 180;
    // Meteorological convention: "from" direction → negate for velocity
    const uMs = -speedMs * Math.sin(dirRad) * scale;
    const vMs = -speedMs * Math.cos(dirRad) * scale;

    const { dLon, dLat } = cellSizeDeg(bounds, gw, gh);
    const dxM = dLon * M_PER_DEG_LON;
    const dyM = dLat * M_PER_DEG_LAT;

    const uCells = uMs / dxM;
    const vCells = vMs / dyM;

    const n = gw * gh;
    const uGrid = new Float32Array(n);
    const vGrid = new Float32Array(n);
    uGrid.fill(uCells);
    vGrid.fill(vCells);

    return { uGrid, vGrid };
  }

  // ── Full simulation tick ──────────────────────────────────────────────────

  /**
   * Create a new simulation state.
   *
   * @param {number} [gw] - grid width (default 80)
   * @param {number} [gh] - grid height (default 60)
   * @param {Object} [bounds] - geographic bounds (default GEO_BOUNDS)
   * @returns {Object} simulation state
   */
  function createState(gw, gh, bounds) {
    gw = gw || DEFAULT_GW;
    gh = gh || DEFAULT_GH;
    bounds = bounds || GEO_BOUNDS;
    return {
      c: new Float32Array(gw * gh),
      uGrid: new Float32Array(gw * gh),
      vGrid: new Float32Array(gw * gh),
      cIdw: null,       // last IDW result (Float32Array)
      wSumGrid: null,   // last IDW weights
      alphaGrid: null,  // last alpha envelope
      gw,
      gh,
      bounds,
      initialized: false,
      lastTickMs: 0,
      sensorFingerprint: "",
    };
  }

  /**
   * Initialize (or re-initialize) the concentration field from IDW.
   * Runs a settling phase to develop wind-aligned structure.
   *
   * @param {Object} simState - from createState()
   * @param {Array} sensors - [{lat, lon, value}, ...]
   * @param {number} [cutoffDeg] - IDW cutoff (default 0.15)
   * @param {number} [settlingTicks] - number of settling ticks (default 20)
   * @param {number} [settlingDt] - seconds per settling tick (default 0.5)
   * @param {Object} [params] - {D, lambda, windScale}
   */
  function initFromIDW(simState, sensors, cutoffDeg, settlingTicks, settlingDt, params) {
    cutoffDeg = cutoffDeg || 0.15;
    settlingTicks = settlingTicks != null ? settlingTicks : 20;
    settlingDt = settlingDt || 0.5;
    params = params || {};

    const { gw, gh, bounds } = simState;
    const idw = idwOnGeoGrid(sensors, gw, gh, bounds, cutoffDeg);

    simState.c.set(idw.values);
    simState.cIdw = idw.values;
    simState.wSumGrid = idw.wSum;
    simState.alphaGrid = idw.alpha;
    simState.initialized = true;

    // Settling phase: run a few ticks to develop wind-aligned structure
    const D = params.D != null ? params.D : DEFAULT_DIFFUSION;
    const lambda = params.lambda != null ? params.lambda : DEFAULT_LAMBDA;
    for (let i = 0; i < settlingTicks; i++) {
      simState.c = semiLagrangianAdvect(
        simState.c, simState.uGrid, simState.vGrid, settlingDt, gw, gh
      );
      explicitDiffuse(simState.c, D, settlingDt, gw, gh, bounds);
      nudge(simState.c, simState.cIdw, simState.wSumGrid, lambda, settlingDt, gw, gh);
    }
  }

  /**
   * Advance the simulation by dt seconds.
   *
   * @param {Object} simState - simulation state
   * @param {number} dt - timestep in seconds (already scaled by playback speed)
   * @param {Object} [params] - {D, lambda}
   * @returns {Object} simState (same object, mutated)
   */
  function tick(simState, dt, params) {
    if (!simState.initialized) return simState;
    if (dt <= 0 || !isFinite(dt)) return simState;

    // Cap dt to prevent huge jumps
    dt = Math.min(dt, 2.0);

    const { gw, gh, bounds } = simState;
    const D = (params && params.D != null) ? params.D : DEFAULT_DIFFUSION;
    const lambda = (params && params.lambda != null) ? params.lambda : DEFAULT_LAMBDA;

    // 1. Advection
    simState.c = semiLagrangianAdvect(
      simState.c, simState.uGrid, simState.vGrid, dt, gw, gh
    );

    // 2. Diffusion
    explicitDiffuse(simState.c, D, dt, gw, gh, bounds);

    // 3. Nudging
    if (simState.cIdw && simState.wSumGrid) {
      nudge(simState.c, simState.cIdw, simState.wSumGrid, lambda, dt, gw, gh);
    }

    return simState;
  }

  /**
   * Render the concentration field to RGBA pixels.
   *
   * @param {Object} simState
   * @param {number} fieldAlpha - base alpha (0-255)
   * @returns {Uint8ClampedArray} RGBA pixel data (gw × gh × 4)
   */
  function renderToRGBA(simState, fieldAlpha) {
    const { c, alphaGrid, gw, gh } = simState;
    const px = new Uint8ClampedArray(gw * gh * 4);

    for (let i = 0; i < gw * gh; i++) {
      const off = i * 4;
      const a = alphaGrid ? alphaGrid[i] : 1;
      if (a < 0.001) {
        px[off] = 0; px[off + 1] = 0; px[off + 2] = 0; px[off + 3] = 0;
        continue;
      }
      const rgb = pm25ToRgb(c[i]);
      px[off]     = rgb[0];
      px[off + 1] = rgb[1];
      px[off + 2] = rgb[2];
      px[off + 3] = Math.round(fieldAlpha * a);
    }

    return px;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  return {
    // Constants
    GEO_BOUNDS,
    DEFAULT_GW,
    DEFAULT_GH,
    DEFAULT_DIFFUSION,
    DEFAULT_LAMBDA,
    DEFAULT_WIND_SCALE,
    M_PER_DEG_LAT,
    M_PER_DEG_LON,

    // Grid helpers
    cellSizeDeg,
    cellCenter,
    geoToGrid,
    bilinearSample,

    // Core algorithms
    idwOnGeoGrid,
    semiLagrangianAdvect,
    explicitDiffuse,
    nudge,

    // Wind field
    interpolateWindField,
    uniformWindField,

    // Simulation lifecycle
    createState,
    initFromIDW,
    tick,

    // Rendering
    pm25ToRgb,
    renderToRGBA,
  };
});
