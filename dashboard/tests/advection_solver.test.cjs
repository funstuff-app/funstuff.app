/**
 * Tests for advection_solver.js — the advection-diffusion PDE solver.
 * Uses Node.js built-in test runner.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const AS = require("../advection_solver.js");

// ════════════════════════════════════════════════════════════════════════════
// GRID HELPERS
// ════════════════════════════════════════════════════════════════════════════

describe("Grid helpers", () => {
  it("cellSizeDeg computes correct cell sizes", () => {
    const { dLon, dLat } = AS.cellSizeDeg(AS.GEO_BOUNDS, 80, 60);
    assert.ok(Math.abs(dLon - 0.025) < 1e-6, `dLon=${dLon}`);
    assert.ok(Math.abs(dLat - 2 / 60) < 1e-6, `dLat=${dLat}`);
  });

  it("cellCenter returns center of first and last cell", () => {
    const b = { latMin: 0, latMax: 10, lonMin: 0, lonMax: 20 };
    const c0 = AS.cellCenter(0, 0, b, 4, 2);
    assert.ok(Math.abs(c0.lon - 2.5) < 1e-6);
    assert.ok(Math.abs(c0.lat - 2.5) < 1e-6);
    const c1 = AS.cellCenter(3, 1, b, 4, 2);
    assert.ok(Math.abs(c1.lon - 17.5) < 1e-6);
    assert.ok(Math.abs(c1.lat - 7.5) < 1e-6);
  });

  it("geoToGrid inverse of cellCenter", () => {
    const b = { latMin: 0, latMax: 10, lonMin: 0, lonMax: 20 };
    const c = AS.cellCenter(2, 1, b, 4, 2);
    const g = AS.geoToGrid(c.lat, c.lon, b, 4, 2);
    assert.ok(Math.abs(g.gx - 2) < 1e-6);
    assert.ok(Math.abs(g.gy - 1) < 1e-6);
  });

  it("bilinearSample exact cell center", () => {
    const gw = 4, gh = 3;
    const grid = new Float32Array(gw * gh);
    grid[1 * gw + 2] = 10; // (2, 1) = 10
    const v = AS.bilinearSample(grid, gw, gh, 2, 1);
    assert.ok(Math.abs(v - 10) < 1e-6);
  });

  it("bilinearSample interpolates between cells", () => {
    const gw = 3, gh = 1;
    const grid = new Float32Array([0, 10, 20]);
    // Midpoint between cell 0 and cell 1
    const v = AS.bilinearSample(grid, gw, gh, 0.5, 0);
    assert.ok(Math.abs(v - 5) < 1e-3, `v=${v}`);
  });

  it("bilinearSample clamps out-of-bounds (Neumann BC)", () => {
    const gw = 2, gh = 2;
    const grid = new Float32Array([5, 5, 5, 5]);
    const v = AS.bilinearSample(grid, gw, gh, -10, -10);
    assert.ok(Math.abs(v - 5) < 1e-3);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// IDW ON GEO GRID
// ════════════════════════════════════════════════════════════════════════════

describe("IDW on geographic grid", () => {
  it("single sensor dominates its own cell", () => {
    const bounds = { latMin: 40, latMax: 41, lonMin: -112, lonMax: -111 };
    const sensors = [{ lat: 40.5, lon: -111.5, value: 20 }];
    const { values, wSum } = AS.idwOnGeoGrid(sensors, 10, 10, bounds, 0.3);

    // Find cell closest to sensor
    const g = AS.geoToGrid(40.5, -111.5, bounds, 10, 10);
    const ix = Math.round(g.gx), iy = Math.round(g.gy);
    const v = values[iy * 10 + ix];
    assert.ok(Math.abs(v - 20) < 2, `value at sensor=${v}`);
    assert.ok(wSum[iy * 10 + ix] > 0, "wSum should be positive near sensor");
  });

  it("two sensors create a gradient", () => {
    const bounds = { latMin: 40, latMax: 41, lonMin: -112, lonMax: -111 };
    const sensors = [
      { lat: 40.25, lon: -111.5, value: 0 },
      { lat: 40.75, lon: -111.5, value: 20 },
    ];
    const { values } = AS.idwOnGeoGrid(sensors, 10, 10, bounds, 0.5);

    // Bottom row should be closer to 0, top row closer to 20
    const g0 = AS.geoToGrid(40.25, -111.5, bounds, 10, 10);
    const g1 = AS.geoToGrid(40.75, -111.5, bounds, 10, 10);
    const v0 = values[Math.round(g0.gy) * 10 + Math.round(g0.gx)];
    const v1 = values[Math.round(g1.gy) * 10 + Math.round(g1.gx)];
    assert.ok(v1 > v0, `top=${v1} should be > bottom=${v0}`);
  });

  it("returns zero alpha where no sensors are near", () => {
    const bounds = { latMin: 0, latMax: 10, lonMin: 0, lonMax: 10 };
    const sensors = [{ lat: 5, lon: 5, value: 10 }];
    const { alpha } = AS.idwOnGeoGrid(sensors, 20, 20, bounds, 0.5);
    // Far corner (0,0) should have zero alpha
    assert.ok(alpha[0] < 0.01, `corner alpha=${alpha[0]}`);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SEMI-LAGRANGIAN ADVECTION
// ════════════════════════════════════════════════════════════════════════════

describe("Semi-Lagrangian advection", () => {
  it("uniform field is unchanged by advection", () => {
    const gw = 5, gh = 5, n = gw * gh;
    const c = new Float32Array(n).fill(10);
    const u = new Float32Array(n).fill(1);
    const v = new Float32Array(n).fill(0);
    const cNew = AS.semiLagrangianAdvect(c, u, v, 1.0, gw, gh);
    for (let i = 0; i < n; i++) {
      assert.ok(Math.abs(cNew[i] - 10) < 0.1, `cell ${i}: ${cNew[i]}`);
    }
  });

  it("translates a pulse in the u direction", () => {
    const gw = 10, gh = 1, n = gw * gh;
    const c = new Float32Array(n);
    c[5] = 10; // pulse at cell 5
    const u = new Float32Array(n).fill(1); // 1 cell/s eastward
    const v = new Float32Array(n);

    const cNew = AS.semiLagrangianAdvect(c, u, v, 1.0, gw, gh);
    // Pulse should have moved +1 cell → now at cell 6
    assert.ok(cNew[6] > cNew[5], `cell6=${cNew[6]} should be > cell5=${cNew[5]}`);
    assert.ok(cNew[6] > 5, `cell6=${cNew[6]} should retain most of the pulse`);
  });

  it("translates a pulse in the v direction", () => {
    const gw = 1, gh = 10, n = gw * gh;
    const c = new Float32Array(n);
    c[5] = 10; // pulse at row 5
    const u = new Float32Array(n);
    const v = new Float32Array(n).fill(1); // 1 cell/s northward

    const cNew = AS.semiLagrangianAdvect(c, u, v, 1.0, gw, gh);
    // Pulse should have moved +1 row → now at row 6
    assert.ok(cNew[6] > cNew[5], `row6=${cNew[6]} should be > row5=${cNew[5]}`);
  });

  it("zero wind leaves field unchanged", () => {
    const gw = 5, gh = 5, n = gw * gh;
    const c = new Float32Array(n);
    c[12] = 42;
    const u = new Float32Array(n);
    const v = new Float32Array(n);
    const cNew = AS.semiLagrangianAdvect(c, u, v, 1.0, gw, gh);
    assert.ok(Math.abs(cNew[12] - 42) < 1e-6);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// EXPLICIT DIFFUSION
// ════════════════════════════════════════════════════════════════════════════

describe("Explicit diffusion", () => {
  it("point source spreads to neighbors", () => {
    const gw = 5, gh = 5;
    const bounds = { latMin: 40, latMax: 41, lonMin: -112, lonMax: -111 };
    const c = new Float32Array(gw * gh);
    c[2 * gw + 2] = 100; // center

    AS.explicitDiffuse(c, 500, 0.1, gw, gh, bounds);

    // Center should have decreased
    assert.ok(c[2 * gw + 2] < 100, `center=${c[2 * gw + 2]}`);
    // Neighbors should have increased from 0
    assert.ok(c[2 * gw + 3] > 0, `right neighbor=${c[2 * gw + 3]}`);
    assert.ok(c[1 * gw + 2] > 0, `top neighbor=${c[1 * gw + 2]}`);
  });

  it("uniform field is unchanged by diffusion", () => {
    const gw = 5, gh = 5;
    const bounds = { latMin: 40, latMax: 41, lonMin: -112, lonMax: -111 };
    const c = new Float32Array(gw * gh).fill(10);
    AS.explicitDiffuse(c, 500, 0.1, gw, gh, bounds);
    for (let i = 0; i < gw * gh; i++) {
      assert.ok(Math.abs(c[i] - 10) < 0.1, `cell ${i}: ${c[i]}`);
    }
  });

  it("conserves total mass (approximately)", () => {
    const gw = 10, gh = 10;
    const bounds = { latMin: 40, latMax: 41, lonMin: -112, lonMax: -111 };
    const c = new Float32Array(gw * gh);
    c[5 * gw + 5] = 100;
    const totalBefore = c.reduce((a, b) => a + b, 0);

    AS.explicitDiffuse(c, 200, 0.1, gw, gh, bounds);

    const totalAfter = c.reduce((a, b) => a + b, 0);
    // Mass is approximately conserved (small losses at boundaries)
    assert.ok(Math.abs(totalAfter - totalBefore) / totalBefore < 0.1,
      `mass change: ${totalBefore} → ${totalAfter}`);
  });

  it("sub-steps for stability", () => {
    const gw = 3, gh = 3;
    const bounds = { latMin: 40, latMax: 41, lonMin: -112, lonMax: -111 };
    const c = new Float32Array(gw * gh);
    c[4] = 100; // center
    // Large D and dt that would be unstable without sub-stepping
    AS.explicitDiffuse(c, 5000, 1.0, gw, gh, bounds);
    // Should not blow up — all values should be finite and non-negative
    for (let i = 0; i < gw * gh; i++) {
      assert.ok(isFinite(c[i]) && c[i] >= 0, `cell ${i}: ${c[i]}`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// NUDGING
// ════════════════════════════════════════════════════════════════════════════

describe("Nudging", () => {
  it("relaxes toward IDW target", () => {
    const gw = 3, gh = 3, n = gw * gh;
    const c = new Float32Array(n).fill(0);
    const cIdw = new Float32Array(n).fill(10);
    const wSum = new Float32Array(n).fill(1);

    AS.nudge(c, cIdw, wSum, 0.5, 1.0, gw, gh);

    // After one tick at λ=0.5, dt=1: c += 0.5 * 1.0 * (10 - 0) = 5
    for (let i = 0; i < n; i++) {
      assert.ok(Math.abs(c[i] - 5) < 0.1, `cell ${i}: ${c[i]}`);
    }
  });

  it("does nothing where wSum is zero", () => {
    const gw = 2, gh = 2, n = gw * gh;
    const c = new Float32Array(n).fill(5);
    const cIdw = new Float32Array(n).fill(20);
    const wSum = new Float32Array(n).fill(0); // no sensors

    AS.nudge(c, cIdw, wSum, 1.0, 1.0, gw, gh);

    for (let i = 0; i < n; i++) {
      assert.ok(Math.abs(c[i] - 5) < 1e-6, `cell ${i}: ${c[i]}`);
    }
  });

  it("converges to target over multiple ticks", () => {
    const gw = 1, gh = 1;
    const c = new Float32Array([0]);
    const cIdw = new Float32Array([10]);
    const wSum = new Float32Array([1]);

    for (let t = 0; t < 200; t++) {
      AS.nudge(c, cIdw, wSum, 0.2, 0.1, gw, gh);
    }

    // After 200 ticks at λ=0.2, dt=0.1: 1-(1-0.02)^200 ≈ 0.982 → ~9.82
    assert.ok(Math.abs(c[0] - 10) < 1, `converged to ${c[0]}`);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// WIND FIELD
// ════════════════════════════════════════════════════════════════════════════

describe("Wind field", () => {
  it("uniformWindField creates correct cells/s", () => {
    const gw = 4, gh = 4;
    const bounds = { latMin: 40, latMax: 41, lonMin: -112, lonMax: -111 };
    // 10 m/s from the north (dir=0°) → wind blowing southward
    // u_ms = -10*sin(0) = 0, v_ms = -10*cos(0) = -10
    const { uGrid, vGrid } = AS.uniformWindField(10, 0, gw, gh, bounds, 1.0);
    assert.ok(Math.abs(uGrid[0]) < 0.001, `u should be ~0: ${uGrid[0]}`);
    assert.ok(vGrid[0] < 0, `v should be negative (southward): ${vGrid[0]}`);
  });

  it("uniformWindField from west creates positive u", () => {
    const gw = 4, gh = 4;
    const bounds = { latMin: 40, latMax: 41, lonMin: -112, lonMax: -111 };
    // Wind from west (dir=270°) → blowing east
    // u_ms = -10*sin(270°*pi/180) = -10*(-1) = 10, v_ms ≈ 0
    const { uGrid, vGrid } = AS.uniformWindField(10, 270, gw, gh, bounds, 1.0);
    assert.ok(uGrid[0] > 0, `u should be positive (eastward): ${uGrid[0]}`);
    assert.ok(Math.abs(vGrid[0]) < 0.001, `v should be ~0: ${vGrid[0]}`);
  });

  it("interpolateWindField handles empty input", () => {
    const { uGrid, vGrid } = AS.interpolateWindField([], 4, 4, AS.GEO_BOUNDS, 1.0);
    assert.equal(uGrid.length, 16);
    assert.equal(uGrid[0], 0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SIMULATION LIFECYCLE
// ════════════════════════════════════════════════════════════════════════════

describe("Simulation lifecycle", () => {
  it("createState returns properly sized arrays", () => {
    const s = AS.createState(10, 8);
    assert.equal(s.c.length, 80);
    assert.equal(s.uGrid.length, 80);
    assert.equal(s.gw, 10);
    assert.equal(s.gh, 8);
    assert.equal(s.initialized, false);
  });

  it("initFromIDW initializes from sensor data", () => {
    const s = AS.createState(10, 10, { latMin: 40, latMax: 41, lonMin: -112, lonMax: -111 });
    const sensors = [{ lat: 40.5, lon: -111.5, value: 15 }];
    AS.initFromIDW(s, sensors, 0.3, 0, 0); // no settling
    assert.equal(s.initialized, true);
    // At least one cell should be near the sensor value
    let found = false;
    for (let i = 0; i < s.c.length; i++) {
      if (s.c[i] > 10) { found = true; break; }
    }
    assert.ok(found, "should have values near sensor");
  });

  it("tick does nothing if not initialized", () => {
    const s = AS.createState(5, 5);
    AS.tick(s, 1.0);
    const allZero = s.c.every(v => v === 0);
    assert.ok(allZero, "should remain zero");
  });

  it("tick with zero wind and no sensors leaves field unchanged", () => {
    const bounds = { latMin: 40, latMax: 41, lonMin: -112, lonMax: -111 };
    const s = AS.createState(5, 5, bounds);
    s.c.fill(10);
    s.initialized = true;
    // No IDW data → no nudging
    s.cIdw = null;
    s.wSumGrid = null;

    AS.tick(s, 0.1, { D: 0, lambda: 0 });
    // With zero diffusion and zero wind, field should stay at 10
    for (let i = 0; i < s.c.length; i++) {
      assert.ok(Math.abs(s.c[i] - 10) < 0.5, `cell ${i}: ${s.c[i]}`);
    }
  });

  it("tick caps dt at 2 seconds", () => {
    const bounds = { latMin: 40, latMax: 41, lonMin: -112, lonMax: -111 };
    const s = AS.createState(5, 5, bounds);
    const sensors = [{ lat: 40.5, lon: -111.5, value: 10 }];
    AS.initFromIDW(s, sensors, 0.3, 0, 0);

    // Huge dt should not blow up
    AS.tick(s, 1000); // would be capped to 2
    for (let i = 0; i < s.c.length; i++) {
      assert.ok(isFinite(s.c[i]) && s.c[i] >= 0, `cell ${i}: ${s.c[i]}`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// COLOR MAPPING
// ════════════════════════════════════════════════════════════════════════════

describe("Color mapping", () => {
  it("pm25ToRgb returns cyan for clean air", () => {
    const [r, g, b] = AS.pm25ToRgb(0);
    assert.equal(r, 0x00);
    assert.equal(g, 0xFF);
    assert.equal(b, 0xFF);
  });

  it("pm25ToRgb returns maroon for hazardous", () => {
    const [r, g, b] = AS.pm25ToRgb(300);
    assert.equal(r, 0x7E);
    assert.equal(g, 0x00);
    assert.equal(b, 0x23);
  });

  it("pm25ToRgb interpolates smoothly", () => {
    const [r1, g1, b1] = AS.pm25ToRgb(3.5);
    const [r2, g2, b2] = AS.pm25ToRgb(5.0);
    // At 3.5 we're at a stop (lt-blue), at 5.0 midway to green
    // Just check it doesn't blow up and values are in range
    assert.ok(r1 >= 0 && r1 <= 255);
    assert.ok(g1 >= 0 && g1 <= 255);
    assert.ok(b1 >= 0 && b1 <= 255);
    // Green component should increase toward green stop
    assert.ok(g2 >= g1, `g should increase: ${g1} → ${g2}`);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// RENDERING
// ════════════════════════════════════════════════════════════════════════════

describe("renderToRGBA", () => {
  it("produces correct-sized output", () => {
    const s = AS.createState(4, 3);
    s.c.fill(5);
    s.alphaGrid = new Float32Array(12).fill(1);
    const px = AS.renderToRGBA(s, 46);
    assert.equal(px.length, 4 * 3 * 4);
  });

  it("zero alpha produces transparent pixels", () => {
    const s = AS.createState(2, 2);
    s.c.fill(10);
    s.alphaGrid = new Float32Array(4).fill(0);
    const px = AS.renderToRGBA(s, 46);
    for (let i = 0; i < 4; i++) {
      assert.equal(px[i * 4 + 3], 0, `pixel ${i} should be transparent`);
    }
  });

  it("positive values produce colored pixels", () => {
    const s = AS.createState(2, 2);
    s.c.fill(10);
    s.alphaGrid = new Float32Array(4).fill(1);
    const px = AS.renderToRGBA(s, 100);
    for (let i = 0; i < 4; i++) {
      assert.ok(px[i * 4 + 3] > 0, `pixel ${i} should have alpha`);
      // At PM2.5=10, should be greenish-to-yellow (between stops at 7.0 and 22.2)
      // Just verify non-zero RGB
      const r = px[i * 4], g = px[i * 4 + 1];
      assert.ok(r > 0 || g > 0, `pixel ${i} should have color`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// INTEGRATION: full simulation cycle
// ════════════════════════════════════════════════════════════════════════════

describe("Integration: full simulation cycle", () => {
  it("sensor value propagates downwind over multiple ticks", () => {
    const bounds = { latMin: 40, latMax: 41, lonMin: -112, lonMax: -111 };
    const s = AS.createState(20, 20, bounds);
    const sensors = [
      { lat: 40.5, lon: -111.5, value: 50 },  // point source
    ];

    // East wind: 2 cells/s
    const n = s.gw * s.gh;
    s.uGrid = new Float32Array(n).fill(2);
    s.vGrid = new Float32Array(n).fill(0);

    AS.initFromIDW(s, sensors, 0.3, 0, 0); // no settling

    // Find initial sensor cell
    const g = AS.geoToGrid(40.5, -111.5, bounds, 20, 20);
    const sIx = Math.round(g.gx);
    const sIy = Math.round(g.gy);
    const valueAtSource = s.c[sIy * 20 + sIx];

    // Run 5 ticks at dt=0.5 with no nudging (to see pure advection + diffusion)
    for (let t = 0; t < 5; t++) {
      AS.tick(s, 0.5, { D: 100, lambda: 0 });
    }

    // Check that concentration has appeared east (higher ix) of source
    const downwindIx = Math.min(sIx + 3, 19);
    const downwindVal = s.c[sIy * 20 + downwindIx];
    // The original source area should have less (it advected away)
    // and downwind should have some value
    assert.ok(downwindVal > 0.1, `downwind value=${downwindVal} should be > 0`);
  });

  it("steady state with nudging matches IDW approximately", () => {
    const bounds = { latMin: 40, latMax: 41, lonMin: -112, lonMax: -111 };
    const s = AS.createState(10, 10, bounds);
    const sensors = [
      { lat: 40.5, lon: -111.5, value: 15 },
    ];
    AS.initFromIDW(s, sensors, 0.3, 0, 0);

    // Run 100 ticks with zero wind, strong nudging
    for (let t = 0; t < 100; t++) {
      AS.tick(s, 0.1, { D: 100, lambda: 0.5 });
    }

    // Near the sensor, value should be close to 15
    const g = AS.geoToGrid(40.5, -111.5, bounds, 10, 10);
    const ix = Math.round(g.gx), iy = Math.round(g.gy);
    const v = s.c[iy * 10 + ix];
    assert.ok(Math.abs(v - 15) < 3, `near-sensor value=${v} should be ≈15`);
  });
});
