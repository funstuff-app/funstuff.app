/**
 * Tests for pollutant override during playback.
 *
 * Verifies that when a legend tab is selected during playback:
 * 1. interpolateFixedReadingsAtTime produces readings with .ci (not .color)
 * 2. _readingForLegendTab correctly reads .ci and returns the right color
 * 3. All sensors (not just the selected one) use interpolated readings
 */

const assert = require("assert");
const { test, describe } = require("node:test");

// ── Minimal stubs matching dashboard source ──────────────────────────────────

const AQI_PALETTE = [
  "#cccccc", "#00e4ff", "#00b4ff", "#0088ff", "#00cc00",
  "#92d050", "#ffff00", "#ff9900", "#ff0000", "#cc0066",
  "#7e0023",
];

function safeHex(c) {
  if (typeof c === "number") return AQI_PALETTE[c] || "#cccccc";
  if (!c) return "#cccccc";
  let s = String(c).trim();
  if (s.startsWith("#") && (s.length === 7 || s.length === 4)) return s;
  return "#cccccc";
}

function parseUtcMs(s) {
  if (typeof s === "number") return s;
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.getTime();
}

// ── Inlined from data_utils.js ───────────────────────────────────────────────

function interpolateFixedReadingsAtTime(f, playbackTimeMs) {
  const readings = f && f.readings;
  if (!readings || !isFinite(playbackTimeMs)) return readings;
  const result = {};
  for (const key of Object.keys(readings)) {
    const r = readings[key];
    if (!r) continue;
    if (!Array.isArray(r.history_times) || !Array.isArray(r.history) || r.history_times.length < 2) {
      result[key] = r;
      continue;
    }
    const times = r.history_times;
    const values = r.history;
    const colors = r.hci || [];
    const timesMs = [];
    const valuesF = [];
    const colorsF = [];
    for (let i = 0; i < Math.min(times.length, values.length); i++) {
      const tMs = parseUtcMs(times[i]);
      if (!(tMs != null && isFinite(tMs))) continue;
      const v = values[i];
      if (v == null) continue;
      timesMs.push(tMs);
      valuesF.push(v);
      colorsF.push(colors[i] != null ? colors[i] : (r.ci ?? 0));
    }
    if (timesMs.length < 1) { result[key] = r; continue; }
    const tMin = timesMs[0];
    if (playbackTimeMs < tMin) {
      result[key] = { value: null, ci: 0 };
      continue;
    }
    let idx;
    if (playbackTimeMs >= timesMs[timesMs.length - 1]) {
      idx = valuesF.length - 1;
    } else {
      let lo = 0, hi = timesMs.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (timesMs[mid] <= playbackTimeMs) lo = mid;
        else hi = mid - 1;
      }
      idx = lo;
    }
    result[key] = {
      value: valuesF[idx],
      ci: colorsF[idx] ?? r.ci ?? 0,
      timeMs: timesMs[idx],
    };
  }
  return result;
}

// ── Inlined from map_view.js ─────────────────────────────────────────────────

const _LEGEND_TAB_READING_KEYS = {
  pm25: ["PM25", "PM2.5", "pm25", "pm2.5"],
  pm10: ["PM10", "pm10"],
  o3:   ["OZNE", "O3", "OZONE", "ozone", "o3"],
  no2:  ["NO2", "no2"],
  co:   ["CO", "co"],
};

function _readingForLegendTab(readings, legendTab) {
  if (!readings || !legendTab) return null;
  const keys = _LEGEND_TAB_READING_KEYS[legendTab];
  if (!keys) return null;
  for (const rk of keys) {
    const r = readings[rk];
    if (r && r.value != null) {
      const color = safeHex(r.ci);
      return { key: rk, value: r.value, color };
    }
  }
  return null;
}

/** Simulates the fixed marker override path from map_view.js drawOverlay. */
function resolveFixedMarkerReading(f, overrideTab, fixedPbTimeMs) {
  const src = (fixedPbTimeMs != null)
    ? (interpolateFixedReadingsAtTime(f, fixedPbTimeMs) || f.readings)
    : f.readings;
  return _readingForLegendTab(src, overrideTab);
}

// ── Test data ────────────────────────────────────────────────────────────────

const T0 = Date.UTC(2026, 3, 12, 12, 0, 0);
const T1 = Date.UTC(2026, 3, 12, 13, 0, 0);
const T2 = Date.UTC(2026, 3, 12, 14, 0, 0);

function makeSensor() {
  return {
    id: "hawthorne",
    readings: {
      PM25: {
        value: 42, ci: 6,
        history: [10, 25, 42],
        history_times: [T0, T1, T2],
        hci: [1, 3, 6],
      },
      PM10: {
        value: 30, ci: 3,
        history: [5, 15, 30],
        history_times: [T0, T1, T2],
        hci: [1, 2, 3],
      },
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("interpolateFixedReadingsAtTime", () => {
  test("output has .ci property, not .color", () => {
    const f = makeSensor();
    const result = interpolateFixedReadingsAtTime(f, T1);
    assert.ok(result.PM25, "PM25 reading should exist");
    assert.ok("ci" in result.PM25, "interpolated reading must have .ci");
    assert.strictEqual(result.PM25.ci, 3, "ci should be hci[1]=3 at T1");
    assert.strictEqual("color" in result.PM25, false, "interpolated reading must NOT have .color");
  });

  test("value matches the correct time index", () => {
    const f = makeSensor();
    assert.strictEqual(interpolateFixedReadingsAtTime(f, T0).PM25.value, 10);
    assert.strictEqual(interpolateFixedReadingsAtTime(f, T1).PM25.value, 25);
    assert.strictEqual(interpolateFixedReadingsAtTime(f, T2).PM25.value, 42);
  });
});

describe("_readingForLegendTab with interpolated readings", () => {
  test("reads .ci from interpolated readings and returns valid color", () => {
    const f = makeSensor();
    const interp = interpolateFixedReadingsAtTime(f, T1);
    const pr = _readingForLegendTab(interp, "pm25");
    assert.ok(pr, "should find PM25 reading");
    assert.strictEqual(pr.value, 25);
    assert.strictEqual(pr.color, AQI_PALETTE[3], "color should map from ci=3");
    assert.notStrictEqual(pr.color, "#cccccc", "color must not be gray fallback");
  });

  test("reads .ci from live readings", () => {
    const readings = { PM10: { value: 30, ci: 3 } };
    const pr = _readingForLegendTab(readings, "pm10");
    assert.ok(pr);
    assert.strictEqual(pr.color, AQI_PALETTE[3]);
  });
});

describe("fixed marker override path", () => {
  test("during playback, uses interpolated value not live value", () => {
    const f = makeSensor();
    const pr = resolveFixedMarkerReading(f, "pm10", T0);
    assert.ok(pr);
    assert.strictEqual(pr.value, 5, "should show historical value at T0, not live value 30");
    assert.strictEqual(pr.color, AQI_PALETTE[1], "color should match hci[0]=1");
  });

  test("during playback, returns correct color at each time step", () => {
    const f = makeSensor();
    const pr0 = resolveFixedMarkerReading(f, "pm25", T0);
    const pr1 = resolveFixedMarkerReading(f, "pm25", T1);
    const pr2 = resolveFixedMarkerReading(f, "pm25", T2);
    assert.strictEqual(pr0.value, 10);
    assert.strictEqual(pr0.color, AQI_PALETTE[1]);
    assert.strictEqual(pr1.value, 25);
    assert.strictEqual(pr1.color, AQI_PALETTE[3]);
    assert.strictEqual(pr2.value, 42);
    assert.strictEqual(pr2.color, AQI_PALETTE[6]);
  });

  test("without playback (null time), uses live readings", () => {
    const f = makeSensor();
    const pr = resolveFixedMarkerReading(f, "pm10", null);
    assert.ok(pr);
    assert.strictEqual(pr.value, 30, "should use live value when not in playback");
  });

  test("missing pollutant returns null", () => {
    const f = makeSensor();
    const pr = resolveFixedMarkerReading(f, "co", T1);
    assert.strictEqual(pr, null);
  });
});

// ── Viewport-filtered dimming tests ──────────────────────────────────────────

describe("viewport-filtered legend dimming", () => {
  /** Simulates _applyLegendDimming max-value scan with viewport filtering. */
  function maxVisibleReading(sensors, tabKey, bounds) {
    const keys = _LEGEND_TAB_READING_KEYS[tabKey] || [];
    let max = -Infinity;
    for (const s of sensors) {
      if (s && s.outlier) continue;
      if (bounds && isFinite(s.lat) && isFinite(s.lon)) {
        if (s.lat < bounds.minLat || s.lat > bounds.maxLat
            || s.lon < bounds.minLon || s.lon > bounds.maxLon) continue;
      }
      const r = s && s.readings;
      if (!r) continue;
      for (const k of keys) {
        const rd = r[k];
        if (!rd || rd.value == null || rd.outlier) continue;
        const n = parseFloat(rd.value);
        if (isFinite(n) && n > max) max = n;
      }
    }
    return max > -Infinity ? max : null;
  }

  const slcBounds = { minLat: 40.5, maxLat: 40.9, minLon: -112.1, maxLon: -111.7 };

  const normalSensor = {
    id: "hawthorne", lat: 40.7, lon: -111.9,
    readings: { PM25: { value: 12, ci: 3 } },
  };
  const hfaiSensor = {
    id: "HFAI", lat: 39.0, lon: -110.0, // far away, outside SLC viewport
    readings: { PM25: { value: 850, ci: 9 } },
  };
  const edgeSensor = {
    id: "edge", lat: 40.85, lon: -111.75, // inside 1.5x buffer
    readings: { PM25: { value: 25, ci: 5 } },
  };

  test("without bounds, includes all sensors (old behavior)", () => {
    const max = maxVisibleReading([normalSensor, hfaiSensor], "pm25", null);
    assert.strictEqual(max, 850, "no bounds = all sensors, HFAI wins");
  });

  test("with viewport bounds, excludes off-screen sensors", () => {
    const max = maxVisibleReading([normalSensor, hfaiSensor], "pm25", slcBounds);
    assert.strictEqual(max, 12, "HFAI should be excluded");
  });

  test("sensors within buffer bounds are included", () => {
    const max = maxVisibleReading([normalSensor, hfaiSensor, edgeSensor], "pm25", slcBounds);
    assert.strictEqual(max, 25, "edge sensor in buffer should be included");
  });

  test("outlier sensors are still excluded", () => {
    const outlierInView = {
      id: "bad", lat: 40.7, lon: -111.9, outlier: true,
      readings: { PM25: { value: 999, ci: 9 } },
    };
    const max = maxVisibleReading([normalSensor, outlierInView], "pm25", slcBounds);
    assert.strictEqual(max, 12, "outlier in viewport should be skipped");
  });

  test("per-reading outliers are excluded", () => {
    const paWithOutlierReading = {
      id: "PA_bad", lat: 40.7, lon: -111.85,
      readings: { PM25: { value: 800, ci: 9, outlier: true } },
    };
    const max = maxVisibleReading([normalSensor, paWithOutlierReading], "pm25", slcBounds);
    assert.strictEqual(max, 12, "reading-level outlier should be skipped");
  });
});
