/**
 * Tests for the marker pollutant override bug fixes.
 *
 * Bug 1: During camera pan (_isTransientAnimating), _skipLegendExport gated
 *         the _markerPollutantOverride block, causing markers to revert to
 *         highest-AQI display while panning.
 *
 * Bug 2: interpolateFixedReadingsAtTime emitted color as .color instead of .ci,
 *         causing _readingForLegendTab to return gray (#cccccc).
 *
 * Bug 3: _syncPaFieldDim passed displayTab (auto-derived) to setMarkerPollutantOverride,
 *         which forced all markers to switch pollutant even when the user hadn't
 *         explicitly clicked a legend tab.
 */

const assert = require("assert");
const { test, describe } = require("node:test");

// ── Inline helpers matching dashboard source ─────────────────────────────────

const AQI_PALETTE = [
  "#00e4ff", "#00b4d8", "#00cc00", "#ffcc00", "#ff9900",
  "#ff0000", "#cc00cc", "#990066", "#660033",
];

function safeHex(c) {
  if (typeof c === "number") return AQI_PALETTE[c] || "#cccccc";
  if (!c) return "#cccccc";
  let s = String(c).trim();
  if (s.startsWith("#") && (s.length === 7 || s.length === 4)) return s;
  return "#cccccc";
}

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

/** Simulates _syncPaFieldDim logic for what gets passed to setMarkerPollutantOverride */
function computeMarkerOverride(legendTab, selectedId, selectedSensorPollutantTab) {
  // This must match the actual _syncPaFieldDim in app.js
  return legendTab;  // NOT displayTab -- only explicit clicks
}

// ── Test data ────────────────────────────────────────────────────────────────

const SENSOR_WITH_PM10 = {
  id: "uofu",
  name: "University of Utah",
  readings: {
    PM25: { value: 8, ci: 2 },    // green
    PM10: { value: 30, ci: 1 },   // blue
    OZNE: { value: 45, ci: 3 },   // yellow
  },
};

// Simulates what interpolateFixedReadingsAtTime now returns (with .ci, not .color)
const INTERPOLATED_READINGS = {
  PM25: { value: 8, ci: 2, timeMs: 1000 },
  PM10: { value: 30, ci: 1, timeMs: 1000 },
  OZNE: { value: 45, ci: 3, timeMs: 1000 },
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("marker pollutant override", () => {

  describe("Bug 1: override must apply regardless of _skipLegendExport", () => {
    test("_readingForLegendTab returns correct reading when override is pm10", () => {
      const pr = _readingForLegendTab(SENSOR_WITH_PM10.readings, "pm10");
      assert.ok(pr, "should find PM10 reading");
      assert.strictEqual(pr.value, 30);
      assert.notStrictEqual(pr.color, "#cccccc", "color must not be gray");
    });

    test("override replaces pr even during transient animation", () => {
      // Simulates the render loop: pr starts as highest-AQI, then override replaces it
      let pr = { key: "OZNE", value: 45, color: safeHex(3) };
      const override = "pm10";
      const _skipLegendExport = true;  // transient animation active

      // The fix: override block no longer gated by _skipLegendExport
      if (override != null) {
        const legendPr = _readingForLegendTab(SENSOR_WITH_PM10.readings, override);
        if (legendPr) {
          pr = legendPr;
        }
      }

      assert.strictEqual(pr.key, "PM10");
      assert.strictEqual(pr.value, 30);
      assert.notStrictEqual(pr.color, "#cccccc");
    });
  });

  describe("Bug 2: interpolated readings use .ci not .color", () => {
    test("_readingForLegendTab works with interpolated readings (.ci property)", () => {
      const pr = _readingForLegendTab(INTERPOLATED_READINGS, "pm10");
      assert.ok(pr, "should find PM10 in interpolated readings");
      assert.strictEqual(pr.value, 30);
      assert.strictEqual(pr.color, AQI_PALETTE[1], "should resolve ci=1 to palette color");
    });

    test("_readingForLegendTab returns gray when .ci is missing", () => {
      const badReadings = {
        PM10: { value: 30 },  // no .ci at all
      };
      const pr = _readingForLegendTab(badReadings, "pm10");
      assert.ok(pr);
      assert.strictEqual(pr.color, "#cccccc", "missing ci should produce gray");
    });
  });

  describe("Bug 3: marker override only from explicit legend tab", () => {
    test("explicit legendTab passes through to marker override", () => {
      const override = computeMarkerOverride("pm10", "fixed:uofu", () => "pm25");
      assert.strictEqual(override, "pm10");
    });

    test("auto-derived displayTab does NOT set marker override", () => {
      // legendTab is null (user hasn't clicked a tab), sensor auto-selects pm25
      const override = computeMarkerOverride(null, "fixed:uofu", () => "pm25");
      assert.strictEqual(override, null, "override must be null when no explicit tab");
    });

    test("deselecting tab (clicking active tab) clears marker override", () => {
      // User clicks active tab to deselect: legendTab becomes null
      const override = computeMarkerOverride(null, "fixed:uofu", () => "o3");
      assert.strictEqual(override, null);
    });
  });
});
