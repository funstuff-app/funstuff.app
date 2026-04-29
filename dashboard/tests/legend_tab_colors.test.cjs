/**
 * Tests for collapsed-legend tab coloring (`_applyLegendTabColors`).
 *
 * Contract after the field-only fix:
 *   - There is ONE rendered field with ONE max AQI (`map._paFieldMaxAqi`),
 *     sampled in `_computePaFieldSync` from the kernel-regressed grid over
 *     the viewport.
 *   - Every tab is colored by mapping that single field-AQI through that
 *     tab's own bracket scale. No tab is left gray when the field has data.
 *   - When a sensor is selected, every tab uses that sensor's own readings
 *     for its pollutant — sensor-focus overrides the field aggregate.
 *   - Trails / virtual mobile sensors / per-pollutant kernel regressions are
 *     NOT consulted from this code path.
 */

const assert = require("node:assert/strict");
const { test, describe } = require("node:test");

// ── Inline LEGEND_DATA + reading-key map (verbatim from app.js) ─────────────

const LEGEND_DATA = {
  pm25: {
    entries: [
      { color: "#00FFFF", lo: 0,   hi: 2 },
      { color: "#00CCFF", lo: 2,   hi: 5 },
      { color: "#00E400", lo: 5,   hi: 9 },
      { color: "#FFFF00", lo: 9,   hi: 35 },
      { color: "#FF7E00", lo: 35,  hi: 55 },
      { color: "#FF0000", lo: 55,  hi: 125 },
      { color: "#8F3F97", lo: 125, hi: 225 },
      { color: "#7E0023", lo: 225, hi: null },
    ],
  },
  pm10: {
    entries: [
      { color: "#00FFFF", lo: 0,   hi: 15 },
      { color: "#00CCFF", lo: 15,  hi: 30 },
      { color: "#0099FF", lo: 30,  hi: 40 },
      { color: "#00E400", lo: 40,  hi: 54 },
      { color: "#FFFF00", lo: 54,  hi: 154 },
      { color: "#FF7E00", lo: 154, hi: 254 },
      { color: "#FF0000", lo: 254, hi: 354 },
      { color: "#8F3F97", lo: 354, hi: 424 },
      { color: "#7E0023", lo: 424, hi: null },
    ],
  },
  o3: {
    entries: [
      { color: "#00CCFF", lo: 0,   hi: 15 },
      { color: "#0099FF", lo: 15,  hi: 25 },
      { color: "#009900", lo: 25,  hi: 35 },
      { color: "#006600", lo: 35,  hi: 54 },
      { color: "#FFFF00", lo: 54,  hi: 70 },
      { color: "#FF7E00", lo: 70,  hi: 85 },
      { color: "#FF0000", lo: 85,  hi: 105 },
      { color: "#8F3F97", lo: 105, hi: 200 },
      { color: "#7E0023", lo: 200, hi: null },
    ],
  },
  no2: {
    entries: [
      { color: "#00CCFF", lo: 0,   hi: 20 },
      { color: "#0099FF", lo: 20,  hi: 35 },
      { color: "#00E400", lo: 35,  hi: 53 },
      { color: "#FFFF00", lo: 53,  hi: 100 },
      { color: "#FF7E00", lo: 100, hi: 360 },
      { color: "#FF0000", lo: 360, hi: 649 },
      { color: "#8F3F97", lo: 649, hi: 1249 },
      { color: "#7E0023", lo: 1249, hi: null },
    ],
  },
  co: {
    entries: [
      { color: "#00CCFF", lo: 0,    hi: 1.5 },
      { color: "#0099FF", lo: 1.5,  hi: 3.0 },
      { color: "#00E400", lo: 3.0,  hi: 4.4 },
      { color: "#FFFF00", lo: 4.4,  hi: 9.4 },
      { color: "#FF7E00", lo: 9.4,  hi: 12.4 },
      { color: "#FF0000", lo: 12.4, hi: 15.4 },
      { color: "#8F3F97", lo: 15.4, hi: 30.4 },
      { color: "#7E0023", lo: 30.4, hi: null },
    ],
  },
};

const _DIM_READING_KEYS = {
  pm25: ["PM25", "PM2.5", "pm25", "pm2.5"],
  pm10: ["PM10", "pm10"],
  o3:   ["OZNE", "O3", "OZONE", "ozone", "o3"],
  no2:  ["NO2", "no2"],
  co:   ["CO", "co"],
};

// EPA-ish breakpoint mock — just enough to exercise the dispatch logic.
function aqiToValue(pollutant, aqi) {
  if (aqi == null) return null;
  if (pollutant === "pm2.5") return aqi * 0.24;
  if (pollutant === "pm10")  return aqi * 0.5;
  if (pollutant === "ozone") return aqi * 0.001; // ppm
  if (pollutant === "no2")   return aqi * 0.4;
  if (pollutant === "co")    return aqi * 0.03;
  return aqi;
}

const _TAB_AQI_KEY = { pm25: "pm2.5", pm10: "pm10", o3: "ozone", no2: "no2", co: "co" };
function _fieldAqiToLegendValue(tabKey, aqi) {
  if (aqi == null || !isFinite(aqi)) return null;
  const aqiKey = _TAB_AQI_KEY[tabKey] || "pm2.5";
  let v = aqiToValue(aqiKey, aqi);
  if (v == null || !isFinite(v)) return null;
  if (tabKey === "o3") v *= 1000; // legend bands authored in ppb
  return v;
}

// ── Mirror of the post-fix `_applyLegendTabColors` per-tab branch ───────────

function colorForTab({ tabKey, fieldAqi, selectedSensor, persistedColors }) {
  const data = LEGEND_DATA[tabKey];
  if (!data) return null;
  const entries = data.entries;

  let activeValue = null;
  if (selectedSensor && selectedSensor.readings) {
    const keys = _DIM_READING_KEYS[tabKey] || [];
    for (const rk of keys) {
      const rd = selectedSensor.readings[rk];
      if (rd && rd.value != null && isFinite(rd.value)) {
        activeValue = parseFloat(rd.value);
        break;
      }
    }
  } else {
    activeValue = _fieldAqiToLegendValue(tabKey, fieldAqi);
  }

  let color = null;
  if (activeValue != null) {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (activeValue >= entries[i].lo) { color = entries[i].color; break; }
    }
  }
  if (color) persistedColors[tabKey] = color;
  else color = persistedColors[tabKey] || null;
  return color;
}

// ═════════════════════════════════════════════════════════════════════════════
// TESTS
// ═════════════════════════════════════════════════════════════════════════════

describe("legend tab colors: every tab is colored from the single field max", () => {
  test("field AQI 25 colors all five tabs (no tab grays out)", () => {
    const persisted = {};
    const args = { fieldAqi: 25, selectedSensor: null, persistedColors: persisted };
    for (const tab of ["pm25", "pm10", "o3", "no2", "co"]) {
      assert.notEqual(colorForTab({ tabKey: tab, ...args }), null,
        `${tab} must be colored — there is field data`);
    }
  });

  test("field AQI 4 (low) → low-bracket cool colors across all tabs", () => {
    const persisted = {};
    const args = { fieldAqi: 4, selectedSensor: null, persistedColors: persisted };
    // PM2.5 = 0.96 → cyan (lo=0). PM10 = 2 → cyan (lo=0). O3 = 4 ppb → cyan.
    assert.equal(colorForTab({ tabKey: "pm25", ...args }), "#00FFFF");
    assert.equal(colorForTab({ tabKey: "pm10", ...args }), "#00FFFF");
    assert.equal(colorForTab({ tabKey: "o3",   ...args }), "#00CCFF");
  });

  test("field AQI 75 → mid-bracket warm colors across all tabs", () => {
    const persisted = {};
    const args = { fieldAqi: 75, selectedSensor: null, persistedColors: persisted };
    // PM2.5 = 18 → yellow (9-35). PM10 = 37.5 → blue (30-40).
    // O3 = 75 ppb → orange (70-85).
    assert.equal(colorForTab({ tabKey: "pm25", ...args }), "#FFFF00");
    assert.equal(colorForTab({ tabKey: "pm10", ...args }), "#0099FF");
    assert.equal(colorForTab({ tabKey: "o3",   ...args }), "#FF7E00");
  });

  test("varied field AQI yields a spread of colors across tabs (not all the same)", () => {
    const persisted = {};
    const args = { fieldAqi: 75, selectedSensor: null, persistedColors: persisted };
    const colors = new Set();
    for (const tab of ["pm25", "pm10", "o3", "no2", "co"]) {
      colors.add(colorForTab({ tabKey: tab, ...args }));
    }
    assert.ok(colors.size >= 3, `expected ≥3 distinct colors, got ${colors.size}`);
  });
});

describe("legend tab colors: null field falls back to persisted, never to trails", () => {
  test("null field with persisted colors keeps the last good color", () => {
    const persisted = { pm25: "#FFFF00", pm10: "#FF7E00" };
    const args = { fieldAqi: null, selectedSensor: null, persistedColors: persisted };
    assert.equal(colorForTab({ tabKey: "pm25", ...args }), "#FFFF00");
    assert.equal(colorForTab({ tabKey: "pm10", ...args }), "#FF7E00");
  });

  test("null field with empty persistence returns null (no error, no trail fallback)", () => {
    const persisted = {};
    const args = { fieldAqi: null, selectedSensor: null, persistedColors: persisted };
    for (const tab of ["pm25", "pm10", "o3", "no2", "co"]) {
      assert.equal(colorForTab({ tabKey: tab, ...args }), null);
    }
  });
});

describe("legend tab colors: a sensor selection beats the field for every tab", () => {
  const sensorReadings = {
    "PM2.5": { value: 7 },
    "PM10":  { value: 20 },
    "O3":    { value: 30 },
    "NO2":   { value: 10 },
    "CO":    { value: 2.0 },
  };
  const selectedSensor = { readings: sensorReadings };

  test("each tab uses the selected sensor's own pollutant reading", () => {
    const persisted = {};
    const args = { fieldAqi: 200, selectedSensor, persistedColors: persisted };
    assert.equal(colorForTab({ tabKey: "pm25", ...args }), "#00E400");
    assert.equal(colorForTab({ tabKey: "pm10", ...args }), "#00CCFF");
    assert.equal(colorForTab({ tabKey: "o3",   ...args }), "#009900");
    assert.equal(colorForTab({ tabKey: "no2",  ...args }), "#00CCFF");
    assert.equal(colorForTab({ tabKey: "co",   ...args }), "#0099FF");
  });
});

describe("legend tab colors: same field AQI re-mapped per tab gives different colors", () => {
  test("AQI 50 → PM2.5 yellow, O3 dark green (both Good→Moderate boundary)", () => {
    const persisted = {};
    const args = { fieldAqi: 50, selectedSensor: null, persistedColors: persisted };
    // PM2.5 = 12 → yellow (lo=9). O3 = 50 ppb → dark green (lo=35).
    assert.equal(colorForTab({ tabKey: "pm25", ...args }), "#FFFF00");
    assert.equal(colorForTab({ tabKey: "o3",   ...args }), "#006600");
  });
});
