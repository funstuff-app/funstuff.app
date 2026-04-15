/**
 * Tests for the legend-dim PA-field-pollutant-mismatch bug.
 *
 * When the PA field renders one pollutant (e.g. PM2.5) but the legend tab is
 * displaying another (e.g. PM10 via viewport auto-detect), `_applyLegendDimming`
 * must NOT reinterpret the stored `_paFieldMaxAqi` through the mismatched
 * pollutant's AQI breakpoints — that produces the wrong bracket color. It
 * should instead fall back to a viewport sensor scan for the requested tab.
 *
 * Mirrors the core branch in app.js `_applyLegendDimming` after the fix.
 */

const assert = require("assert");
const { test, describe } = require("node:test");

const _DIM_READING_KEYS = {
  pm25: ["PM25", "PM2.5", "pm25", "pm2.5"],
  pm10: ["PM10", "pm10"],
  o3:   ["OZNE", "O3", "OZONE", "ozone", "o3"],
  no2:  ["NO2", "no2"],
  co:   ["CO", "co"],
};

// EPA-ish breakpoint mock — good enough to prove the bug path.
// pm2.5 AQI 10 ≈ 2.4 ug/m3; pm10 AQI 10 ≈ 5 ug/m3 (very different scales).
function aqiToValue(pollutant, aqi) {
  if (aqi == null) return null;
  if (pollutant === "pm2.5") return aqi * 0.24;   // ~PM2.5 ug/m3 at low AQI
  if (pollutant === "pm10") return aqi * 0.5;     // ~PM10 ug/m3 at low AQI
  return aqi;
}

/** Simulates the fixed branch of _applyLegendDimming (no sensor selected). */
function computeDimValue({ tabKey, paFieldPollutant, paFieldMaxAqi, sensors }) {
  let activeValue = null;
  const _paField = paFieldPollutant || "pm25";
  if (tabKey === _paField && paFieldMaxAqi != null && isFinite(paFieldMaxAqi)) {
    const aqiKey = { pm25: "pm2.5", pm10: "pm10", o3: "ozone", no2: "no2", co: "co" }[tabKey] || "pm2.5";
    activeValue = aqiToValue(aqiKey, paFieldMaxAqi);
    if (tabKey === "o3" && activeValue != null) activeValue *= 1000;
  } else {
    const keys = _DIM_READING_KEYS[tabKey] || [];
    let max = -Infinity;
    for (const s of sensors || []) {
      if (!s || s.outlier) continue;
      const r = s.readings;
      if (!r) continue;
      for (const rk of keys) {
        const rd = r[rk];
        if (rd && rd.value != null) {
          const n = parseFloat(rd.value);
          if (isFinite(n) && n > max) max = n;
          break;
        }
      }
    }
    if (max > -Infinity) activeValue = max;
  }
  return activeValue;
}

describe("legend dimming — PA field pollutant mismatch", () => {
  const sensors = [
    { id: "WBB",   readings: { PM25: { value: 1.0 }, PM10: { value: 16.8 } } },
    { id: "PA_1", readings: { PM25: { value: 2.5 } } },
  ];

  test("PM10 tab with PM2.5 field: uses viewport PM10 max, not reinterpreted field AQI", () => {
    // Bug scenario: PA field rendering pm25 (paFieldMaxAqi from PM2.5 data),
    // but the legend is auto-displaying pm10 via viewport-auto-detect.
    const v = computeDimValue({
      tabKey: "pm10",
      paFieldPollutant: "pm25",
      paFieldMaxAqi: 10,          // max AQI from PM2.5 field
      sensors,
    });
    // Correct: viewport max for PM10 (16.8), NOT aqiToValue("pm10", 10) = 5.0
    assert.strictEqual(v, 16.8);
  });

  test("PM2.5 tab with PM2.5 field: uses field AQI-derived value", () => {
    const v = computeDimValue({
      tabKey: "pm25",
      paFieldPollutant: "pm25",
      paFieldMaxAqi: 10,
      sensors,
    });
    // Matches: uses aqiToValue("pm2.5", 10) = 2.4
    assert.strictEqual(v, 10 * 0.24);
  });

  test("PM10 tab with null paFieldPollutant (defaults to pm25): falls back to sensor scan", () => {
    const v = computeDimValue({
      tabKey: "pm10",
      paFieldPollutant: null,     // default → pm25
      paFieldMaxAqi: 10,
      sensors,
    });
    assert.strictEqual(v, 16.8);
  });

  test("PM10 tab with PM10 field: uses field AQI-derived value", () => {
    const v = computeDimValue({
      tabKey: "pm10",
      paFieldPollutant: "pm10",
      paFieldMaxAqi: 10,
      sensors,
    });
    assert.strictEqual(v, 10 * 0.5);
  });

  test("mismatch with no sensors returns null (no false bracket)", () => {
    const v = computeDimValue({
      tabKey: "pm10",
      paFieldPollutant: "pm25",
      paFieldMaxAqi: 10,
      sensors: [],
    });
    assert.strictEqual(v, null);
  });
});
