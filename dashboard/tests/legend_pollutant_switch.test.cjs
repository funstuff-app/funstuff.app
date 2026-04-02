/**
 * Tests for the legend pollutant-switch bug fix.
 *
 * When a sensor is selected and the user switches the legend tab (e.g. O3 -> PM2.5),
 * the dimming value must reflect the NEWLY selected pollutant's reading, not the old one.
 *
 * Extracts the core lookup logic from map_view.js (getReadingForPollutant) and the
 * dimming value selection from app.js (_applyLegendDimming) to verify correctness.
 */

const assert = require("assert");
const { test, describe } = require("node:test");

// ── Inline helpers matching dashboard source ─────────────────────────────────

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
      return { key: rk, value: r.value, color: r.ci || "#fff" };
    }
  }
  return null;
}

/** Simulates map.getReadingForPollutant(tab) */
function getReadingForPollutant(selectedId, lastState, tab) {
  if (!selectedId || !lastState || !tab) return null;
  const colonIdx = selectedId.indexOf(":");
  const type = colonIdx === -1 ? "mobile" : selectedId.slice(0, colonIdx);
  const id = colonIdx === -1 ? selectedId : selectedId.slice(colonIdx + 1);
  const list = type === "mobile" ? (lastState.mobile || []) : (lastState.fixed || []);
  const sensor = list.find(s => s && String(s.id) === String(id));
  if (!sensor) return null;
  const pr = _readingForLegendTab(sensor.readings, tab);
  return (pr && pr.value != null) ? parseFloat(pr.value) : null;
}

/** Simulates the dimming value selection from _applyLegendDimming.
 *  allSensors is the full set of sensors to scan when the selected sensor
 *  doesn't have the requested pollutant (fallthrough). */
function getDimmingValue(opts) {
  const { legendTab, selectedId, map, getSelectedPollutantValue, allSensors } = opts;
  // "Show All" mode: no explicit tab, no selected sensor → no dimming
  if (!legendTab && !selectedId) return null;
  let activeValue = null;
  if (map && selectedId) {
    const v = legendTab
      ? getReadingForPollutant(selectedId, map.lastState, legendTab)
      : getSelectedPollutantValue();
    if (v != null && isFinite(v)) activeValue = v;
  }
  // Fall through: no selected sensor, or sensor lacks the requested pollutant.
  if (activeValue == null && allSensors) {
    const tabKey = legendTab || "pm25";
    const keys = _LEGEND_TAB_READING_KEYS[tabKey] || [];
    let max = -Infinity;
    for (const s of allSensors) {
      if (s && s.outlier) continue;
      const r = s && s.readings;
      if (!r) continue;
      for (const k of keys) {
        const rv = r[k] && r[k].value;
        if (rv != null) { const n = parseFloat(rv); if (isFinite(n) && n > max) max = n; }
      }
    }
    if (max > -Infinity) activeValue = max;
  }
  return activeValue;
}

// ── Test data ────────────────────────────────────────────────────────────────

const BUS06 = {
  id: "BUS06",
  name: "BUS06",
  readings: {
    OZNE: { value: 18, ci: "#00e4ff" },
    PM25: { value: 5.2, ci: "#00cc00" },
    PM10: { value: 12, ci: "#00e400" },
  },
};

const FIXED_SENSOR = {
  id: "hawthorne",
  name: "Hawthorne",
  readings: {
    PM25: { value: 42, ci: "#ffcc00" },
    OZNE: { value: 55, ci: "#ff9900" },
  },
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("legend pollutant switch", () => {
  test("switching from O3 to PM2.5 returns PM2.5 value, not ozone", () => {
    const state = { mobile: [BUS06], fixed: [] };
    const selectedId = "mobile:BUS06";

    // Simulates the old (stale) value the render pipeline would return
    const staleOzoneValue = 18;

    // With legendTab = "pm25", getDimmingValue should use getReadingForPollutant
    // and return PM2.5 value (5.2), NOT the stale ozone value (18)
    const val = getDimmingValue({
      legendTab: "pm25",
      selectedId,
      map: { lastState: state },
      getSelectedPollutantValue: () => staleOzoneValue,
    });
    assert.strictEqual(val, 5.2);
  });

  test("switching from PM2.5 to O3 returns ozone value", () => {
    const state = { mobile: [BUS06], fixed: [] };
    const selectedId = "mobile:BUS06";

    const val = getDimmingValue({
      legendTab: "o3",
      selectedId,
      map: { lastState: state },
      getSelectedPollutantValue: () => 5.2, // stale PM2.5
    });
    assert.strictEqual(val, 18);
  });

  test("no explicit legend tab falls back to getSelectedPollutantValue", () => {
    const state = { mobile: [BUS06], fixed: [] };
    const selectedId = "mobile:BUS06";

    const val = getDimmingValue({
      legendTab: null,
      selectedId,
      map: { lastState: state },
      getSelectedPollutantValue: () => 18,
    });
    assert.strictEqual(val, 18);
  });

  test("fixed sensor lookup works for explicit tab", () => {
    const state = { mobile: [], fixed: [FIXED_SENSOR] };
    const selectedId = "fixed:hawthorne";

    const val = getDimmingValue({
      legendTab: "pm25",
      selectedId,
      map: { lastState: state },
      getSelectedPollutantValue: () => 55, // stale ozone
    });
    assert.strictEqual(val, 42);
  });

  test("sensor missing the requested pollutant falls through to all-sensors scan", () => {
    const sensorNoCO = {
      id: "BUS06",
      readings: { OZNE: { value: 18, ci: "#00e4ff" } },
    };
    const otherSensor = {
      id: "BUS07",
      readings: { CO: { value: 3.5, ci: "#00cc00" } },
    };
    const state = { mobile: [sensorNoCO, otherSensor], fixed: [] };
    const selectedId = "mobile:BUS06";

    const val = getDimmingValue({
      legendTab: "co",
      selectedId,
      map: { lastState: state },
      getSelectedPollutantValue: () => 18,
      allSensors: [sensorNoCO, otherSensor],
    });
    assert.strictEqual(val, 3.5);
  });

  test("sensor missing pollutant with no other sensors returns null", () => {
    const sensorNoCO = {
      id: "BUS06",
      readings: { OZNE: { value: 18, ci: "#00e4ff" } },
    };
    const state = { mobile: [sensorNoCO], fixed: [] };
    const selectedId = "mobile:BUS06";

    const val = getDimmingValue({
      legendTab: "co",
      selectedId,
      map: { lastState: state },
      getSelectedPollutantValue: () => 18,
      allSensors: [sensorNoCO],
    });
    assert.strictEqual(val, null);
  });

  test("show-all mode (no tab, no sensor) returns null (all bars lit)", () => {
    const val = getDimmingValue({
      legendTab: null,
      selectedId: null,
      map: { lastState: { mobile: [BUS06], fixed: [] } },
      getSelectedPollutantValue: () => 5.2,
      allSensors: [BUS06],
    });
    assert.strictEqual(val, null);
  });

  test("explicit tab with no sensor selected scans all sensors", () => {
    const pa1 = { id: "PA_123", readings: { PM25: { value: 8.3, ci: "#00e400" } } };
    const pa2 = { id: "PA_456", readings: { PM25: { value: 12.7, ci: "#ffff00" } } };
    const val = getDimmingValue({
      legendTab: "pm25",
      selectedId: null,
      map: null,
      getSelectedPollutantValue: () => null,
      allSensors: [pa1, pa2],
    });
    assert.strictEqual(val, 12.7);
  });

  test("all-sensors scan skips outliers", () => {
    const normal = { id: "PA_1", readings: { PM25: { value: 10, ci: "#fff" } } };
    const outlier = { id: "PA_2", readings: { PM25: { value: 500, ci: "#fff" } }, outlier: true };
    const val = getDimmingValue({
      legendTab: "pm25",
      selectedId: null,
      map: null,
      getSelectedPollutantValue: () => null,
      allSensors: [normal, outlier],
    });
    assert.strictEqual(val, 10);
  });

  test("getReadingForPollutant returns correct value for each tab", () => {
    const state = { mobile: [BUS06], fixed: [] };
    assert.strictEqual(getReadingForPollutant("mobile:BUS06", state, "pm25"), 5.2);
    assert.strictEqual(getReadingForPollutant("mobile:BUS06", state, "pm10"), 12);
    assert.strictEqual(getReadingForPollutant("mobile:BUS06", state, "o3"), 18);
    assert.strictEqual(getReadingForPollutant("mobile:BUS06", state, "co"), null);
    assert.strictEqual(getReadingForPollutant("mobile:BUS06", state, "no2"), null);
  });
});
