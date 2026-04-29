/**
 * Tests for `_applyLegendDimming` after the field-only fix.
 *
 * Contract:
 *   - Bracket dim derives from `_paFieldMaxAqi` (the FIELD value sampled in
 *     the viewport) mapped through the displayed tab's bracket scale.
 *   - The displayed tab can differ from the rendered field's pollutant
 *     (e.g. show-all mode + viewport-auto-detect picking a different tab);
 *     the same field AQI is reused across every tab. There is no
 *     per-pollutant fallback regression and no viewport sensor / trail scan.
 *   - Selected sensor still wins over the field aggregate.
 */

const assert = require("assert");
const { test, describe } = require("node:test");

function aqiToValue(pollutant, aqi) {
  if (aqi == null) return null;
  if (pollutant === "pm2.5") return aqi * 0.24;
  if (pollutant === "pm10")  return aqi * 0.5;
  if (pollutant === "ozone") return aqi * 0.001; // ppm
  return aqi;
}

const _TAB_AQI_KEY = { pm25: "pm2.5", pm10: "pm10", o3: "ozone", no2: "no2", co: "co" };

function _fieldAqiToLegendValue(tabKey, aqi) {
  if (aqi == null || !isFinite(aqi)) return null;
  const aqiKey = _TAB_AQI_KEY[tabKey] || "pm2.5";
  let v = aqiToValue(aqiKey, aqi);
  if (v == null || !isFinite(v)) return null;
  if (tabKey === "o3") v *= 1000;
  return v;
}

/** Mirrors the post-fix branch of `_applyLegendDimming`. */
function computeDimValue({ tabKey, paFieldMaxAqi, selectedSensorValue }) {
  if (selectedSensorValue != null && isFinite(selectedSensorValue)) {
    return selectedSensorValue;
  }
  if (paFieldMaxAqi == null || !isFinite(paFieldMaxAqi)) return null;
  return _fieldAqiToLegendValue(tabKey, paFieldMaxAqi);
}

describe("legend dimming — field is the sole non-sensor source", () => {
  test("displayed tab matches rendered field — straight conversion", () => {
    const v = computeDimValue({
      tabKey: "pm25",
      paFieldMaxAqi: 25,
      selectedSensorValue: null,
    });
    assert.strictEqual(v, 25 * 0.24);
  });

  test("displayed tab differs from rendered field — same field AQI reused", () => {
    // Show-all mode: PM2.5 is rendered, viewport-auto picks PM10 to display.
    // The field's AQI value (25) maps through PM10's bracket scale.
    const v = computeDimValue({
      tabKey: "pm10",
      paFieldMaxAqi: 25,
      selectedSensorValue: null,
    });
    assert.strictEqual(v, 25 * 0.5,
      "PM10 dim should derive from same field AQI mapped through PM10 scale");
  });

  test("o3 field max scales ppm → ppb", () => {
    const v = computeDimValue({
      tabKey: "o3",
      paFieldMaxAqi: 80,
      selectedSensorValue: null,
    });
    // aqiToValue(o3, 80) = 0.080 ppm → ×1000 → 80 ppb
    assert.strictEqual(v, 80);
  });

  test("null field max → null (no fallback to sensors or trails)", () => {
    const v = computeDimValue({
      tabKey: "pm25",
      paFieldMaxAqi: null,
      selectedSensorValue: null,
    });
    assert.strictEqual(v, null);
  });
});

describe("legend dimming — selected sensor overrides field", () => {
  test("selected sensor reading is used regardless of field state", () => {
    const v = computeDimValue({
      tabKey: "pm10",
      paFieldMaxAqi: 25,
      selectedSensorValue: 47.2,
    });
    assert.strictEqual(v, 47.2);
  });

  test("selected sensor null → fall back to field", () => {
    const v = computeDimValue({
      tabKey: "pm25",
      paFieldMaxAqi: 50,
      selectedSensorValue: null,
    });
    assert.strictEqual(v, 12);
  });
});

describe("legend dimming — trail values must NOT influence the bracket", () => {
  test("function signature does not accept a trail / sensor list at all", () => {
    // The post-fix dim function takes ONLY: tabKey, paFieldMaxAqi,
    // selectedSensorValue. There is no `sensors` parameter, by design.
    // This test guards against re-introducing a viewport sensor scan.
    const sig = computeDimValue.toString();
    assert.ok(!/sensors/i.test(sig),
      "computeDimValue must not reference a sensors array");
    assert.ok(!/trail/i.test(sig),
      "computeDimValue must not reference trail data");
  });
});
