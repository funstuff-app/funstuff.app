/**
 * Web Worker for advection-diffusion simulation of the PurpleAir scalar field.
 *
 * Maintains a persistent concentration grid in geographic coordinates (lat/lon)
 * and evolves it via semi-Lagrangian advection + explicit diffusion + sensor nudging.
 *
 * Messages IN:
 *   init:   { type:"init", sensors, windPoints, params, fieldAlpha }
 *   tick:   { type:"tick", dt, sensors?, windPoints?, params?, fieldAlpha? }
 *   wind:   { type:"wind", windPoints }
 *   reset:  { type:"reset" }
 *
 * Messages OUT:
 *   { px: Uint8ClampedArray, gw, gh, type:"frame" }
 */

// ── Inline the solver (workers can't use ES modules in all browsers) ────────
// This is a copy of advection_solver.js core algorithms.
// Kept in sync manually — the test suite validates both.

const GEO_BOUNDS = { latMin: 39.5, latMax: 41.5, lonMin: -113.0, lonMax: -111.0 };
const DEFAULT_GW = 80;
const DEFAULT_GH = 60;
const DEFAULT_DIFFUSION = 500;
const DEFAULT_LAMBDA = 0.2;
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LON = 111320 * Math.cos(40.6 * Math.PI / 180);

const COLOR_STOPS = [
  [0,0x00,0xFF,0xFF],[1.0,0x00,0xFF,0xFF],[3.5,0x00,0xCC,0xFF],
  [7.0,0x00,0xE4,0x00],[22.2,0xFF,0xFF,0x00],[45.4,0xFF,0x7E,0x00],
  [90.4,0xFF,0x00,0x00],[175.4,0x8F,0x3F,0x97],[250.0,0x7E,0x00,0x23],
  [500,0x7E,0x00,0x23],
];

function pm25ToRgb(v) {
  const s = COLOR_STOPS;
  if (v <= s[0][0]) return [s[0][1], s[0][2], s[0][3]];
  for (let i = 1; i < s.length; i++) {
    if (v <= s[i][0]) {
      const t = (v - s[i-1][0]) / (s[i][0] - s[i-1][0]);
      return [
        Math.round(s[i-1][1] + t * (s[i][1] - s[i-1][1])),
        Math.round(s[i-1][2] + t * (s[i][2] - s[i-1][2])),
        Math.round(s[i-1][3] + t * (s[i][3] - s[i-1][3])),
      ];
    }
  }
  const last = s[s.length - 1];
  return [last[1], last[2], last[3]];
}

function cellSizeDeg(bounds, gw, gh) {
  return { dLon: (bounds.lonMax - bounds.lonMin) / gw, dLat: (bounds.latMax - bounds.latMin) / gh };
}

function bilinearSample(grid, gw, gh, fx, fy) {
  fx = Math.max(0, Math.min(gw - 1.001, fx));
  fy = Math.max(0, Math.min(gh - 1.001, fy));
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, gw - 1), y1 = Math.min(y0 + 1, gh - 1);
  const tx = fx - x0, ty = fy - y0;
  return (grid[y0*gw+x0]*(1-tx)*(1-ty) + grid[y0*gw+x1]*tx*(1-ty) +
          grid[y1*gw+x0]*(1-tx)*ty + grid[y1*gw+x1]*tx*ty);
}

function idwOnGeoGrid(sensors, gw, gh, bounds, cutoffDeg) {
  const values = new Float32Array(gw * gh);
  const wSum = new Float32Array(gw * gh);
  const alpha = new Float32Array(gw * gh);
  const cutoffSq = cutoffDeg * cutoffDeg;
  const sigmaFrac = cutoffDeg / 6;
  const twoSigSq = 2 * sigmaFrac * sigmaFrac;
  const eps2 = 0.0001;
  const { dLon, dLat } = cellSizeDeg(bounds, gw, gh);

  for (let iy = 0; iy < gh; iy++) {
    const lat = bounds.latMin + (iy + 0.5) * dLat;
    for (let ix = 0; ix < gw; ix++) {
      const lon = bounds.lonMin + (ix + 0.5) * dLon;
      let ws = 0, vs = 0, gs = 0;
      for (let si = 0; si < sensors.length; si++) {
        const s = sensors[si];
        const dlat = lat - s.lat, dlon = lon - s.lon;
        const d2 = dlat * dlat + dlon * dlon;
        if (d2 > cutoffSq) continue;
        const t = d2 / cutoffSq;
        const envelope = (1 - t) * (1 - t);
        const w = envelope / (d2 + eps2);
        ws += w; vs += w * s.value;
        gs += Math.exp(-d2 / twoSigSq);
      }
      const idx = iy * gw + ix;
      wSum[idx] = ws;
      if (ws > 1e-12) { values[idx] = vs / ws; alpha[idx] = Math.min(1, gs * 2); }
    }
  }
  return { values, wSum, alpha };
}

function semiLagrangianAdvect(c, u, v, dt, gw, gh) {
  const cNew = new Float32Array(gw * gh);
  for (let iy = 0; iy < gh; iy++) {
    for (let ix = 0; ix < gw; ix++) {
      const idx = iy * gw + ix;
      cNew[idx] = bilinearSample(c, gw, gh, ix - u[idx] * dt, iy - v[idx] * dt);
    }
  }
  return cNew;
}

function explicitDiffuse(c, D, dt, gw, gh, bounds) {
  const { dLon, dLat } = cellSizeDeg(bounds, gw, gh);
  const Dx = D / ((dLon * M_PER_DEG_LON) ** 2);
  const Dy = D / ((dLat * M_PER_DEG_LAT) ** 2);
  const maxD = Math.max(Dx, Dy);
  let nSub = 1;
  if (maxD * dt > 0.25) nSub = Math.ceil(maxD * dt / 0.25);
  const subDt = dt / nSub;
  const tmp = new Float32Array(gw * gh);
  for (let sub = 0; sub < nSub; sub++) {
    tmp.set(c);
    for (let iy = 1; iy < gh - 1; iy++) {
      for (let ix = 1; ix < gw - 1; ix++) {
        const idx = iy * gw + ix;
        const lap = Dx*(tmp[idx-1]+tmp[idx+1]-2*tmp[idx]) + Dy*(tmp[idx-gw]+tmp[idx+gw]-2*tmp[idx]);
        c[idx] = tmp[idx] + lap * subDt;
        if (c[idx] < 0) c[idx] = 0;
      }
    }
    for (let ix = 0; ix < gw; ix++) { c[ix] = c[gw+ix]; c[(gh-1)*gw+ix] = c[(gh-2)*gw+ix]; }
    for (let iy = 0; iy < gh; iy++) { c[iy*gw] = c[iy*gw+1]; c[iy*gw+gw-1] = c[iy*gw+gw-2]; }
  }
}

function nudge(c, cIdw, wSumGrid, lambdaBase, dt, gw, gh) {
  const wThreshold = 1.0;
  const n = gw * gh;
  for (let i = 0; i < n; i++) {
    const ws = wSumGrid[i];
    if (ws < 1e-12) continue;
    const lambda = lambdaBase * Math.min(1, ws / wThreshold);
    c[i] += lambda * dt * (cIdw[i] - c[i]);
    if (c[i] < 0) c[i] = 0;
  }
}

function interpolateWindField(windPoints, gw, gh, bounds, windScale) {
  const uGrid = new Float32Array(gw * gh);
  const vGrid = new Float32Array(gw * gh);
  if (!windPoints || windPoints.length === 0) return { uGrid, vGrid };
  const { dLon, dLat } = cellSizeDeg(bounds, gw, gh);
  const dxM = dLon * M_PER_DEG_LON, dyM = dLat * M_PER_DEG_LAT;
  const scale = windScale || 1.0;
  const cutoffSq = 1.0; // 1°²

  for (let iy = 0; iy < gh; iy++) {
    const lat = bounds.latMin + (iy + 0.5) * dLat;
    for (let ix = 0; ix < gw; ix++) {
      const lon = bounds.lonMin + (ix + 0.5) * dLon;
      const idx = iy * gw + ix;
      let wSum = 0, uSum = 0, vSum = 0;
      for (let wi = 0; wi < windPoints.length; wi++) {
        const wp = windPoints[wi];
        const dlat = lat - wp.lat, dlon = lon - wp.lon;
        const d2 = dlat * dlat + dlon * dlon;
        if (d2 > cutoffSq) continue;
        const w = 1 / (d2 + 0.001);
        wSum += w; uSum += w * wp.u; vSum += w * wp.v;
      }
      if (wSum > 1e-12) {
        uGrid[idx] = scale * (uSum / wSum) / dxM;
        vGrid[idx] = scale * (vSum / wSum) / dyM;
      }
    }
  }
  return { uGrid, vGrid };
}

/** Convert a pre-interpolated wind grid (m/s) to grid-cells/s.
 *  The server sends {gw, gh, bounds, uGrid, vGrid} in m/s;
 *  the solver needs velocities in grid-cells per second. */
function scaleWindGrid(gridObj, gw, gh, bounds, windScale) {
  const uOut = new Float32Array(gw * gh);
  const vOut = new Float32Array(gw * gh);
  if (!gridObj || !gridObj.uGrid) return { uGrid: uOut, vGrid: vOut };
  const { dLon, dLat } = cellSizeDeg(bounds, gw, gh);
  const dxM = dLon * M_PER_DEG_LON, dyM = dLat * M_PER_DEG_LAT;
  const scale = windScale || 1.0;
  const src_u = gridObj.uGrid, src_v = gridObj.vGrid;
  const n = gw * gh;
  for (let i = 0; i < n; i++) {
    uOut[i] = scale * (src_u[i] || 0) / dxM;
    vOut[i] = scale * (src_v[i] || 0) / dyM;
  }
  return { uGrid: uOut, vGrid: vOut };
}

/** Detect whether windPoints is a pre-interpolated grid object. */
function isWindGrid(wp) {
  return wp && typeof wp === "object" && !Array.isArray(wp) && wp.gw != null;
}

function uniformWindField(speedMs, dirDeg, gw, gh, bounds, windScale) {
  const scale = windScale || 1.0;
  const dirRad = dirDeg * Math.PI / 180;
  const uMs = -speedMs * Math.sin(dirRad) * scale;
  const vMs = -speedMs * Math.cos(dirRad) * scale;
  const { dLon, dLat } = cellSizeDeg(bounds, gw, gh);
  const n = gw * gh;
  const uGrid = new Float32Array(n);
  const vGrid = new Float32Array(n);
  uGrid.fill(uMs / (dLon * M_PER_DEG_LON));
  vGrid.fill(vMs / (dLat * M_PER_DEG_LAT));
  return { uGrid, vGrid };
}

// ── Worker state ────────────────────────────────────────────────────────────

let sim = null;  // { c, uGrid, vGrid, cIdw, wSumGrid, alphaGrid, gw, gh, bounds, initialized }

function initSim(sensors, windPoints, params, fieldAlpha) {
  const gw = DEFAULT_GW, gh = DEFAULT_GH, bounds = GEO_BOUNDS;
  const n = gw * gh;

  sim = {
    c: new Float32Array(n),
    uGrid: new Float32Array(n),
    vGrid: new Float32Array(n),
    cIdw: null,
    wSumGrid: null,
    alphaGrid: null,
    gw, gh, bounds,
    initialized: false,
    fieldAlpha: fieldAlpha || 46,
  };

  // Set up wind field
  if (isWindGrid(windPoints)) {
    const wf = scaleWindGrid(windPoints, gw, gh, bounds, (params && params.windScale) || 1.0);
    sim.uGrid = wf.uGrid;
    sim.vGrid = wf.vGrid;
  } else if (windPoints && windPoints.length > 0) {
    const wf = interpolateWindField(windPoints, gw, gh, bounds, (params && params.windScale) || 1.0);
    sim.uGrid = wf.uGrid;
    sim.vGrid = wf.vGrid;
  } else if (params && params.windSpeed != null && params.windDir != null) {
    const wf = uniformWindField(params.windSpeed, params.windDir, gw, gh, bounds, (params && params.windScale) || 1.0);
    sim.uGrid = wf.uGrid;
    sim.vGrid = wf.vGrid;
  }

  // Initialize from IDW
  if (sensors && sensors.length > 0) {
    const cutoffDeg = (params && params.cutoffDeg) || 0.15;
    const idw = idwOnGeoGrid(sensors, gw, gh, bounds, cutoffDeg);
    sim.c.set(idw.values);
    sim.cIdw = idw.values;
    sim.wSumGrid = idw.wSum;
    sim.alphaGrid = idw.alpha;
    sim.initialized = true;

    // Settling phase
    const D = (params && params.D != null) ? params.D : DEFAULT_DIFFUSION;
    const lambda = (params && params.lambda != null) ? params.lambda : DEFAULT_LAMBDA;
    const settlingTicks = (params && params.settlingTicks != null) ? params.settlingTicks : 20;
    for (let i = 0; i < settlingTicks; i++) {
      sim.c = semiLagrangianAdvect(sim.c, sim.uGrid, sim.vGrid, 0.5, gw, gh);
      explicitDiffuse(sim.c, D, 0.5, gw, gh, bounds);
      nudge(sim.c, sim.cIdw, sim.wSumGrid, lambda, 0.5, gw, gh);
    }
  }

  return renderFrame();
}

function tickSim(dt, sensors, windPoints, params, fieldAlpha) {
  if (!sim || !sim.initialized) return null;

  if (fieldAlpha != null) sim.fieldAlpha = fieldAlpha;

  // Update sensors if provided
  if (sensors && sensors.length > 0) {
    const cutoffDeg = (params && params.cutoffDeg) || 0.15;
    const idw = idwOnGeoGrid(sensors, sim.gw, sim.gh, sim.bounds, cutoffDeg);
    sim.cIdw = idw.values;
    sim.wSumGrid = idw.wSum;
    sim.alphaGrid = idw.alpha;
  }

  // Update wind if provided
  if (isWindGrid(windPoints)) {
    const wf = scaleWindGrid(windPoints, sim.gw, sim.gh, sim.bounds, (params && params.windScale) || 1.0);
    sim.uGrid = wf.uGrid;
    sim.vGrid = wf.vGrid;
  } else if (windPoints && windPoints.length > 0) {
    const wf = interpolateWindField(windPoints, sim.gw, sim.gh, sim.bounds, (params && params.windScale) || 1.0);
    sim.uGrid = wf.uGrid;
    sim.vGrid = wf.vGrid;
  }

  // Cap dt
  dt = Math.min(dt, 2.0);
  if (dt <= 0 || !isFinite(dt)) return renderFrame();

  const D = (params && params.D != null) ? params.D : DEFAULT_DIFFUSION;
  const lambda = (params && params.lambda != null) ? params.lambda : DEFAULT_LAMBDA;

  // Advect → Diffuse → Nudge
  sim.c = semiLagrangianAdvect(sim.c, sim.uGrid, sim.vGrid, dt, sim.gw, sim.gh);
  explicitDiffuse(sim.c, D, dt, sim.gw, sim.gh, sim.bounds);
  if (sim.cIdw && sim.wSumGrid) {
    nudge(sim.c, sim.cIdw, sim.wSumGrid, lambda, dt, sim.gw, sim.gh);
  }

  return renderFrame();
}

function renderFrame() {
  if (!sim) return null;
  const { c, alphaGrid, gw, gh, fieldAlpha } = sim;
  const px = new Uint8ClampedArray(gw * gh * 4);

  for (let i = 0; i < gw * gh; i++) {
    const off = i * 4;
    const a = alphaGrid ? alphaGrid[i] : 0;
    if (a < 0.001) {
      px[off] = 0; px[off+1] = 0; px[off+2] = 0; px[off+3] = 0;
      continue;
    }
    const rgb = pm25ToRgb(c[i]);
    px[off] = rgb[0]; px[off+1] = rgb[1]; px[off+2] = rgb[2];
    px[off+3] = Math.round(fieldAlpha * a);
  }

  return { px, gw, gh };
}

// ── Message handler ─────────────────────────────────────────────────────────

self.onmessage = function(e) {
  const msg = e.data;
  let result = null;

  switch (msg.type) {
    case "init":
      result = initSim(msg.sensors, msg.windPoints, msg.params, msg.fieldAlpha);
      break;
    case "tick":
      result = tickSim(msg.dt, msg.sensors, msg.windPoints, msg.params, msg.fieldAlpha);
      break;
    case "wind":
      if (sim && msg.windPoints) {
        let wf;
        if (isWindGrid(msg.windPoints)) {
          wf = scaleWindGrid(msg.windPoints, sim.gw, sim.gh, sim.bounds,
            (msg.params && msg.params.windScale) || 1.0);
        } else {
          wf = interpolateWindField(msg.windPoints, sim.gw, sim.gh, sim.bounds,
            (msg.params && msg.params.windScale) || 1.0);
        }
        sim.uGrid = wf.uGrid;
        sim.vGrid = wf.vGrid;
      }
      return; // no frame needed
    case "reset":
      sim = null;
      return;
    default:
      return;
  }

  if (result) {
    self.postMessage({ ...result, type: "frame" }, [result.px.buffer]);
  }
};
