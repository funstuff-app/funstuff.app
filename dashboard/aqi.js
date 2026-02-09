// AQI calculation (EPA breakpoints from aqi_breakpoints.csv)
// Notes:
// - Ozone breakpoints are in ppm; our feed values are typically in ppb (e.g. 28-40).
// - Truncation rules (EPA): ozone -> 3 decimals ppm, PM2.5 -> 1 decimal, PM10 -> integer.
var AQI_LEVELS = [
  { label: "Good", aqi_hi: 50, color: "#00E400" },
  { label: "Moderate", aqi_hi: 100, color: "#FFFF00" },
  { label: "Sensitive Groups", aqi_hi: 150, color: "#FF7E00" },
  { label: "Unhealthy", aqi_hi: 200, color: "#FF0000" },
  { label: "Very Unhealthy", aqi_hi: 300, color: "#8F3F97" },
  { label: "Hazardous", aqi_hi: 500, color: "#7E0023" },
];

var AQI_BREAKPOINTS = {
  "pm2.5": [
    { c_low: 0.0, c_high: 9.0, aqi_low: 0, aqi_high: 50 },
    { c_low: 9.1, c_high: 35.4, aqi_low: 51, aqi_high: 100 },
    { c_low: 35.5, c_high: 55.4, aqi_low: 101, aqi_high: 150 },
    { c_low: 55.5, c_high: 125.4, aqi_low: 151, aqi_high: 200 },
    { c_low: 125.5, c_high: 225.4, aqi_low: 201, aqi_high: 300 },
    { c_low: 225.5, c_high: 325.4, aqi_low: 301, aqi_high: 500 },
  ],
  pm10: [
    { c_low: 0.0, c_high: 54.0, aqi_low: 0, aqi_high: 50 },
    { c_low: 55.0, c_high: 154.0, aqi_low: 51, aqi_high: 100 },
    { c_low: 155.0, c_high: 254.0, aqi_low: 101, aqi_high: 150 },
    { c_low: 255.0, c_high: 354.0, aqi_low: 151, aqi_high: 200 },
    { c_low: 355.0, c_high: 424.0, aqi_low: 201, aqi_high: 300 },
    { c_low: 425.0, c_high: 604.0, aqi_low: 301, aqi_high: 500 },
  ],
  ozone: [
    { c_low: 0.0, c_high: 0.054, aqi_low: 0, aqi_high: 50 },
    { c_low: 0.055, c_high: 0.07, aqi_low: 51, aqi_high: 100 },
    { c_low: 0.071, c_high: 0.085, aqi_low: 101, aqi_high: 150 },
    { c_low: 0.086, c_high: 0.105, aqi_low: 151, aqi_high: 200 },
    { c_low: 0.106, c_high: 0.2, aqi_low: 201, aqi_high: 300 },
  ],
};

function _normalizePollutantKeyForAqi(k) {
  const kk = String(k || "").trim().toLowerCase();
  if (kk === "pm25" || kk === "pm2.5" || kk === "pm2_5" || kk === "pm2-5" || kk === "pm 2.5") return "pm2.5";
  if (kk === "pm10" || kk === "pm 10") return "pm10";
  if (kk === "ozne" || kk === "ozone" || kk === "o3") return "ozone";
  return kk;
}

function valueToAqi(pollutantKey, value) {
  const k = _normalizePollutantKeyForAqi(pollutantKey);
  let v = Number(value);
  if (!isFinite(v)) return null;

  // unit normalization + truncation
  if (k === "ozone") {
    // Feed values are always in ppb; convert to ppm for AQI lookup.
    // Negative values are invalid sensor readings.
    if (v <= 0) return null;
    v = v / 1000.0;
    v = Math.floor(v * 1000) / 1000; // 3 decimals
  } else if (k === "pm2.5") {
    v = Math.floor(v * 10) / 10; // 1 decimal
  } else if (k === "pm10") {
    v = Math.floor(v); // integer
  }

  const bps = AQI_BREAKPOINTS[k];
  if (!bps || !bps.length) return null;
  for (const bp of bps) {
    if (v >= bp.c_low && v <= bp.c_high) {
      if (bp.c_high === bp.c_low) return bp.aqi_high;
      return ((bp.aqi_high - bp.aqi_low) / (bp.c_high - bp.c_low)) * (v - bp.c_low) + bp.aqi_low;
    }
  }
  if (v < bps[0].c_low) return bps[0].aqi_low;
  if (v > bps[bps.length - 1].c_high) return bps[bps.length - 1].aqi_high;
  return null;
}

function aqiLevel(aqi) {
  const a = Number(aqi);
  if (!isFinite(a)) return { label: "Unknown", color: "#AAAAAA", aqi_hi: null };
  for (const lvl of AQI_LEVELS) {
    if (a <= lvl.aqi_hi) return lvl;
  }
  return AQI_LEVELS[AQI_LEVELS.length - 1];
}

function pickWorstReadingKey(readings) {
  if (!readings) return null;
  let bestKey = null;
  let bestAqi = -1;
  for (const [k, r] of Object.entries(readings)) {
    const v = r && typeof r === "object" ? r.value : null;
    const aqi = valueToAqi(k, v);
    const aqiF = (aqi == null) ? -1 : Number(aqi);
    if (isFinite(aqiF) && aqiF > bestAqi) {
      bestAqi = aqiF;
      bestKey = k;
    }
  }
  if (bestKey) return { key: bestKey, aqi: bestAqi };

  // fallback (unknown AQI): stable ordering
  const order = ["PM25", "PM2.5", "PM10", "OZNE", "Ozone"];
  for (const k of order) if (readings[k]) return { key: k, aqi: null };
  const keys = Object.keys(readings);
  return keys.length ? { key: keys[0], aqi: null } : null;
}

function canonicalPollutantLabel(k) {
  const kk = _normalizePollutantKeyForAqi(k);
  if (kk === "pm2.5") return "PM2.5";
  if (kk === "pm10") return "PM10";
  if (kk === "ozone") return "Ozone";
  return String(k || "");
}
