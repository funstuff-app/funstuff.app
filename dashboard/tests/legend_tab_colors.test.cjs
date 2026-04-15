/**
 * Tests for collapsed-legend tab coloring logic (_applyLegendTabColors).
 *
 * Extracts the pure color-lookup from app.js and verifies that each tab
 * gets a color matching its OWN pollutant's reading, not a shared AQI.
 */

const assert = require("node:assert/strict");
const { test, describe } = require("node:test");

// ── Inline LEGEND_DATA (verbatim from app.js) ───────────────────────────────

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

// ── Extract: FIXED logic -- scan per-pollutant max concentrations ────────────

function colorForTab_fixed(tabKey, perPollutantMax, persistedColors) {
  const data = LEGEND_DATA[tabKey];
  if (!data) return null;
  const entries = data.entries;

  const activeValue = perPollutantMax[tabKey] != null ? perPollutantMax[tabKey] : null;
  let color = null;
  if (activeValue != null) {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (activeValue >= entries[i].lo) {
        color = entries[i].color;
        break;
      }
    }
  }
  if (color) {
    persistedColors[tabKey] = color;
  } else {
    color = persistedColors[tabKey] || null;
  }
  return color;
}

// ── Extract: color from raw concentration (sensor-selected path) ────────────

function colorForConcentration(tabKey, concentration) {
  const data = LEGEND_DATA[tabKey];
  if (!data) return null;
  const entries = data.entries;
  let color = null;
  if (concentration != null) {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (concentration >= entries[i].lo) {
        color = entries[i].color;
        break;
      }
    }
  }
  return color;
}

// ═════════════════════════════════════════════════════════════════════════════
// TESTS
// ═════════════════════════════════════════════════════════════════════════════

describe("legend tab color: basic concentration-to-color mapping", () => {
  test("PM2.5 value 3 maps to #00CCFF (blue, lo=2)", () => {
    assert.equal(colorForConcentration("pm25", 3), "#00CCFF");
  });
  test("PM2.5 value 7 maps to #00E400 (green, lo=5)", () => {
    assert.equal(colorForConcentration("pm25", 7), "#00E400");
  });
  test("PM2.5 value 20 maps to #FFFF00 (yellow, lo=9)", () => {
    assert.equal(colorForConcentration("pm25", 20), "#FFFF00");
  });
  test("O3 value 30 maps to #009900 (dark green, lo=25)", () => {
    assert.equal(colorForConcentration("o3", 30), "#009900");
  });
  test("O3 value 60 maps to #FFFF00 (yellow, lo=54)", () => {
    assert.equal(colorForConcentration("o3", 60), "#FFFF00");
  });
  test("NO2 value 10 maps to #00CCFF (cyan, lo=0)", () => {
    assert.equal(colorForConcentration("no2", 10), "#00CCFF");
  });
  test("PM10 value 5 maps to #00FFFF (cyan, lo=0)", () => {
    assert.equal(colorForConcentration("pm10", 5), "#00FFFF");
  });
  test("null concentration returns null", () => {
    assert.equal(colorForConcentration("pm25", null), null);
  });
});

describe("legend tab color: per-pollutant max produces different colors per tab", () => {
  test("varied concentrations give different colors per tab", () => {
    const perPollutantMax = {
      pm25: 7,   // Green range (#00E400, lo=5)
      pm10: 20,  // Cyan-blue (#00CCFF, lo=15)
      o3: 30,    // Dark green (#009900, lo=25)
      no2: 10,   // Cyan (#00CCFF, lo=0)
      co: 2.0,   // Blue (#0099FF, lo=1.5)
    };
    const persisted = {};
    const colors = {};
    for (const tab of ["pm25", "pm10", "o3", "no2", "co"]) {
      colors[tab] = colorForTab_fixed(tab, perPollutantMax, persisted);
    }
    const uniqueColors = new Set(Object.values(colors));
    assert.ok(uniqueColors.size >= 3,
      `Expected at least 3 distinct colors but got ${uniqueColors.size}: ` +
      `${JSON.stringify(colors)}`);
  });

  test("same concentration on all pollutants still maps to different colors", () => {
    const perPollutantMax = { pm25: 10, pm10: 10, o3: 10, no2: 10, co: 10 };
    const persisted = {};
    const colors = {};
    for (const tab of ["pm25", "pm10", "o3", "no2", "co"]) {
      colors[tab] = colorForTab_fixed(tab, perPollutantMax, persisted);
    }
    assert.notEqual(colors.pm25, colors.pm10,
      `PM2.5 (${colors.pm25}) and PM10 (${colors.pm10}) should differ at value=10`);
  });
});

describe("legend tab color: sensor selected with per-pollutant readings", () => {
  const sensorReadings = {
    "PM2.5": { value: 7 },
    "PM10":  { value: 20 },
    "O3":    { value: 30 },
    "NO2":   { value: 10 },
    "CO":    { value: 2.0 },
  };

  function colorForTab_withSensor(tabKey, readings) {
    const data = LEGEND_DATA[tabKey];
    if (!data) return null;
    const entries = data.entries;
    const keys = _DIM_READING_KEYS[tabKey] || [];
    let activeValue = null;
    for (const rk of keys) {
      const rd = readings[rk];
      if (rd && rd.value != null && isFinite(rd.value)) {
        activeValue = rd.value;
        break;
      }
    }
    let color = null;
    if (activeValue != null) {
      for (let i = entries.length - 1; i >= 0; i--) {
        if (activeValue >= entries[i].lo) {
          color = entries[i].color;
          break;
        }
      }
    }
    return color;
  }

  test("PM2.5=7 should be green (#00E400)", () => {
    assert.equal(colorForTab_withSensor("pm25", sensorReadings), "#00E400");
  });
  test("PM10=20 should be cyan-blue (#00CCFF)", () => {
    assert.equal(colorForTab_withSensor("pm10", sensorReadings), "#00CCFF");
  });
  test("O3=30 should be dark green (#009900)", () => {
    assert.equal(colorForTab_withSensor("o3", sensorReadings), "#009900");
  });
  test("NO2=10 should be cyan (#00CCFF)", () => {
    assert.equal(colorForTab_withSensor("no2", sensorReadings), "#00CCFF");
  });
  test("CO=2.0 should be blue (#0099FF)", () => {
    assert.equal(colorForTab_withSensor("co", sensorReadings), "#0099FF");
  });
  test("each tab gets a DIFFERENT color for varied readings", () => {
    const colors = [];
    for (const tab of ["pm25", "pm10", "o3", "no2", "co"]) {
      colors.push(colorForTab_withSensor(tab, sensorReadings));
    }
    const uniqueColors = new Set(colors);
    assert.ok(uniqueColors.size >= 3,
      `Expected at least 3 distinct colors but got ${uniqueColors.size}: ${colors.join(", ")}`);
  });
});

describe("legend tab color: null/missing readings should persist last color", () => {
  test("sensor with no PM10 reading: persisted color is returned", () => {
    const persisted = { pm10: "#00CCFF" };
    const perPollutantMax = { pm25: 7 };
    const color = colorForTab_fixed("pm10", perPollutantMax, persisted);
    assert.equal(color, "#00CCFF",
      "Missing pollutant should return persisted color, not null");
  });

  test("first call with no data returns null (nothing persisted yet)", () => {
    const persisted = {};
    const perPollutantMax = {};
    const color = colorForTab_fixed("pm25", perPollutantMax, persisted);
    assert.equal(color, null);
  });

  test("new reading updates persisted color", () => {
    const persisted = { pm25: "#00CCFF" };
    const perPollutantMax = { pm25: 20 };
    const color = colorForTab_fixed("pm25", perPollutantMax, persisted);
    assert.equal(color, "#FFFF00", "New reading should produce yellow");
    assert.equal(persisted.pm25, "#FFFF00", "Persisted should update to yellow");
  });

  test("subsequent null reading keeps persisted color", () => {
    const persisted = { pm25: "#FFFF00" };
    const perPollutantMax = {};
    const color = colorForTab_fixed("pm25", perPollutantMax, persisted);
    assert.equal(color, "#FFFF00", "Null reading should keep persisted yellow");
  });
});

describe("legend tab color: show-all mode uses per-pollutant data, not shared AQI", () => {
  test("after deselecting a tab, tabs reflect their own pollutant concentrations", () => {
    const perPollutantMax = {
      pm25: 12,
      pm10: 25,
      o3: 40,
      no2: 5,
      co: 1.0,
    };
    const persisted = {};
    const colors = {};
    for (const tab of ["pm25", "pm10", "o3", "no2", "co"]) {
      colors[tab] = colorForTab_fixed(tab, perPollutantMax, persisted);
    }
    assert.equal(colors.pm25, "#FFFF00", "PM2.5=12 should be yellow");
    assert.equal(colors.o3, "#006600", "O3=40 should be dark green");
    assert.equal(colors.no2, "#00CCFF", "NO2=5 should be cyan");
    const uniqueColors = new Set(Object.values(colors));
    assert.ok(uniqueColors.size >= 3,
      `Expected varied colors in show-all mode, got ${uniqueColors.size}`);
  });
});
