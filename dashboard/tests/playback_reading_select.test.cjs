/**
 * Unit tests for the reading-selection logic in drawMobileMarker.
 *
 * Bug: on initial load the marker shows the *live* sensor value (PM10 394)
 * instead of the *historical* trail value at the playhead position, because
 * _playbackLiveFollow is true even while the playhead is well behind the
 * trail end.  Scrubbing any amount fixes it because that clears
 * _playbackLiveFollow.
 *
 * This file extracts the pure reading-selection decision from map_view.js
 * so we can verify it against real BUS10 data captured from the server.
 */

const assert = require("assert");
const { test, describe } = require("node:test");

// ── Inline helpers (same logic as dashboard source) ──────────────────────────

function _normalizePollutantKeyForAqi(k) {
  const kk = String(k || "").trim().toLowerCase();
  if (kk === "pm25" || kk === "pm2.5") return "pm2.5";
  if (kk === "pm10") return "pm10";
  if (kk === "ozne" || kk === "ozone" || kk === "o3") return "ozone";
  return kk;
}

const AQI_BREAKPOINTS = {
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

function valueToAqi(pollutantKey, value) {
  const k = _normalizePollutantKeyForAqi(pollutantKey);
  let v = Number(value);
  if (!isFinite(v)) return null;
  if (k === "ozone") { if (v <= 0) return null; v = Math.floor((v / 1000) * 1000) / 1000; }
  else if (k === "pm2.5") { v = Math.floor(v * 10) / 10; }
  else if (k === "pm10") { v = Math.floor(v); }
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

// ── The actual reading-selection logic extracted from drawMobileMarker ────────
// This mirrors map_view.js lines ~7361-7394  **before the fix**.

function selectReadingBuggy(pr, prHist, opts) {
  const { playbackMode, historicalMode, playbackLiveFollow, atEnd } = opts;
  if (playbackMode && prHist) {
    if (historicalMode) return prHist;
    const followingLive = !!playbackLiveFollow || atEnd;
    if (followingLive) {
      const aNow  = (pr && pr.aqi != null) ? Number(pr.aqi) : valueToAqi(pr?.key, pr?.value);
      const aHist = (prHist && prHist.aqi != null) ? Number(prHist.aqi) : valueToAqi(prHist?.key, prHist?.value);
      const aNowF  = (aNow  != null && isFinite(Number(aNow)))  ? Number(aNow)  : -1;
      const aHistF = (aHist != null && isFinite(Number(aHist))) ? Number(aHist) : -1;
      if (!pr || !pr.key) return prHist;
      if (prHist && prHist.key && aHistF > aNowF) return prHist;
      return pr;  // live wins
    }
    return prHist;
  }
  return pr;
}

// Fixed version: when playbackLiveFollow is true but playhead is NOT at the
// trail end, the marker should show the historical reading — NOT the live one.
function selectReadingFixed(pr, prHist, opts) {
  const { playbackMode, historicalMode, playbackLiveFollow, atEnd } = opts;
  if (playbackMode && prHist) {
    if (historicalMode) return prHist;
    // Only use the "pick worse AQI" heuristic when playhead is actually at
    // the live edge.  _playbackLiveFollow means "will eventually get there",
    // not "is there now".
    const followingLive = atEnd;
    if (followingLive) {
      const aNow  = (pr && pr.aqi != null) ? Number(pr.aqi) : valueToAqi(pr?.key, pr?.value);
      const aHist = (prHist && prHist.aqi != null) ? Number(prHist.aqi) : valueToAqi(prHist?.key, prHist?.value);
      const aNowF  = (aNow  != null && isFinite(Number(aNow)))  ? Number(aNow)  : -1;
      const aHistF = (aHist != null && isFinite(Number(aHist))) ? Number(aHist) : -1;
      if (!pr || !pr.key) return prHist;
      if (prHist && prHist.key && aHistF > aNowF) return prHist;
      return pr;
    }
    return prHist;
  }
  return pr;
}

// ── Real BUS10 test data (captured from live server 2026-03-18 06:38 UTC) ────

// Top-level sensor object readings → primaryReadingForSensor picks PM10=394 (ci 10)
const BUS10_LIVE_PR = { key: "PM10", value: "394.00", color: "#8F3F97", aqi: valueToAqi("PM10", "394.00") };

// Trail point at ~06:00 UTC (≈17 min before end) — typical readings while driving
const BUS10_TRAIL_PR_EARLY = { key: "PM10", value: "5.50", color: "#00CCFF", aqi: valueToAqi("PM10", "5.50") };

// Trail point at the very end (last point 06:16:30) — same spike as live
const BUS10_TRAIL_PR_END = { key: "PM10", value: "394.00", color: "#8F3F97", aqi: valueToAqi("PM10", "394.00") };

// ── Tests ────────────────────────────────────────────────────────────────────

describe("playback reading selection — BUS10 initial-load bug", () => {

  test("BUGGY: liveFollow=true + NOT at end → incorrectly shows live PM10 394", () => {
    const result = selectReadingBuggy(BUS10_LIVE_PR, BUS10_TRAIL_PR_EARLY, {
      playbackMode: true,
      historicalMode: false,
      playbackLiveFollow: true,   // true on initial load
      atEnd: false,               // playhead starts offset behind trail end
    });
    // Bug: live reading (394) wins because followingLive is true via _playbackLiveFollow
    assert.strictEqual(result.value, "394.00", "buggy path picks live value");
    assert.strictEqual(result.key, "PM10");
  });

  test("BUGGY: after scrubbing liveFollow=false → correctly shows trail PM10 5.50", () => {
    const result = selectReadingBuggy(BUS10_LIVE_PR, BUS10_TRAIL_PR_EARLY, {
      playbackMode: true,
      historicalMode: false,
      playbackLiveFollow: false,  // scrubbing sets this to false
      atEnd: false,
    });
    assert.strictEqual(result.value, "5.50", "after scrub, trail reading used");
    assert.strictEqual(result.key, "PM10");
  });

  test("FIXED: liveFollow=true + NOT at end → shows historical trail reading", () => {
    const result = selectReadingFixed(BUS10_LIVE_PR, BUS10_TRAIL_PR_EARLY, {
      playbackMode: true,
      historicalMode: false,
      playbackLiveFollow: true,
      atEnd: false,
    });
    assert.strictEqual(result.value, "5.50", "fixed: trail reading when not at end");
    assert.strictEqual(result.key, "PM10");
  });

  test("FIXED: liveFollow=true + at end → correctly shows live (worst-AQI) reading", () => {
    // At the end, both live and trail have the same 394 value, so either is fine.
    // The logic correctly picks max-AQI which is 394.
    const result = selectReadingFixed(BUS10_LIVE_PR, BUS10_TRAIL_PR_END, {
      playbackMode: true,
      historicalMode: false,
      playbackLiveFollow: true,
      atEnd: true,
    });
    assert.strictEqual(result.value, "394.00", "at live edge, live/max wins");
  });

  test("FIXED: liveFollow=false + NOT at end → shows trail reading (scrub case)", () => {
    const result = selectReadingFixed(BUS10_LIVE_PR, BUS10_TRAIL_PR_EARLY, {
      playbackMode: true,
      historicalMode: false,
      playbackLiveFollow: false,
      atEnd: false,
    });
    assert.strictEqual(result.value, "5.50", "scrubbing shows trail reading");
  });

  test("FIXED: historical mode always uses trail reading", () => {
    const result = selectReadingFixed(BUS10_LIVE_PR, BUS10_TRAIL_PR_EARLY, {
      playbackMode: true,
      historicalMode: true,
      playbackLiveFollow: false,
      atEnd: false,
    });
    assert.strictEqual(result.value, "5.50");
  });

  test("FIXED: at end with low trail, high live → live (worst) wins", () => {
    // Hypothetical: playhead at end, trail says 5.50 but live sensor says 394.
    // This shouldn't happen in practice (end-of-trail matches current), but
    // the max-AQI heuristic should still pick the worse one at the live edge.
    const result = selectReadingFixed(BUS10_LIVE_PR, BUS10_TRAIL_PR_EARLY, {
      playbackMode: true,
      historicalMode: false,
      playbackLiveFollow: true,
      atEnd: true,
    });
    assert.strictEqual(result.value, "394.00", "at end, worse AQI wins");
  });

  test("FIXED: playbackMode off → always live reading", () => {
    const result = selectReadingFixed(BUS10_LIVE_PR, BUS10_TRAIL_PR_EARLY, {
      playbackMode: false,
      historicalMode: false,
      playbackLiveFollow: false,
      atEnd: false,
    });
    assert.strictEqual(result.value, "394.00", "no playback → live reading");
  });
});
