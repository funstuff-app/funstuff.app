// playback_phantom_existence.test.cjs
//
// Regression coverage for the resurrected-idle-sensor phantom (BUS03,
// 2026-07-09): a mobile whose 7-point trail spanned ~43 m of GPS jitter
// failed the 50 m movement filter in _ensurePlaybackPoints, so it carried
// NO time information downstream — the pose fell back to the live position
// at full opacity for EVERY playhead time, painting the sensor onto the map
// hours before its first data point existed, with a frozen live value.
//
// The fix records an existence window ({tMinMs, tMaxMs, staticPts}) for
// every mobile with parseable trail points, hides the marker when the
// playhead predates tMinMs, and time-indexes position/readings for
// movement-filtered sensors inside their window.
//
// Hermetic: node stdlib only. Real app code is used for timestamp parsing
// (format_utils.parseUtcMs) and distance math (data_utils.haversineMeters);
// only the AQI/color helper is stubbed.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// format_utils.js / data_utils.js are plain top-level function declarations
// (no module wrapper) — evaluate them and lift the two functions we need
// onto globalThis, where engine_playback_engine.js resolves them lazily.
const DASH = path.join(__dirname, "..");
(function loadPlainScripts() {
  const src =
    fs.readFileSync(path.join(DASH, "format_utils.js"), "utf8") +
    "\n" +
    fs.readFileSync(path.join(DASH, "data_utils.js"), "utf8") +
    "\nglobalThis.parseUtcMs = parseUtcMs; globalThis.haversineMeters = haversineMeters;";
  new Function(src)();
})();

globalThis.MapView = globalThis.MapView || {};
globalThis.MapView.MIN_TRAIL_LENGTH_M = 50; // mirrors map_view.js:968
// Stub: the real helper ranks pollutants by AQI; the tests only assert WHICH
// trail point the reading came from, so echoing OZNE is sufficient.
globalThis.primaryReadingKeyedFromPoint = (p) => {
  const r = p && p.readings && p.readings.OZNE;
  return r ? { key: "OZNE", value: r.value } : null;
};

const PlaybackEngine = require("../engine_playback_engine.js");

// The exact BUS03 trail from the production bug report: 7 points, 30 s apart,
// ~43 m total path (under the 50 m movement gate), 16:15:00–16:18:00 UTC.
const BUS03_TRAIL = [
  { lat: 40.76185, lon: -111.91064, t: "2026-07-09 16:15:00 UTC", m: 1, readings: { OZNE: { value: "53.50", ci: 6 } } },
  { lat: 40.76191, lon: -111.9107,  t: "2026-07-09 16:15:30 UTC", m: 1, readings: { OZNE: { value: "28.40", ci: 5 } } },
  { lat: 40.76186, lon: -111.91075, t: "2026-07-09 16:16:00 UTC", m: 1, readings: { OZNE: { value: "41.00", ci: 6 } } },
  { lat: 40.76176, lon: -111.91069, t: "2026-07-09 16:16:30 UTC", m: 1, readings: { OZNE: { value: "41.00", ci: 6 } } },
  { lat: 40.7617,  lon: -111.91066, t: "2026-07-09 16:17:00 UTC", m: 1, readings: { OZNE: { value: "41.00", ci: 6 } } },
  { lat: 40.76167, lon: -111.91071, t: "2026-07-09 16:17:30 UTC", m: 1, readings: { OZNE: { value: "39.20", ci: 6 } } },
  { lat: 40.76165, lon: -111.91069, t: "2026-07-09 16:18:00 UTC", m: 1, readings: { OZNE: { value: "35.50", ci: 6 } } },
];
const T_1615 = Date.UTC(2026, 6, 9, 16, 15, 0);
const T_1618 = Date.UTC(2026, 6, 9, 16, 18, 0);

function makeView(mobiles) {
  return {
    playbackMode: true,
    _historicalMode: false,
    lastState: { mobile: mobiles, fixed: [], meta: {} },
    _persistedTrailById: new Map(),
    _persistedTrailRev: 0,
    _playbackPtsById: new Map(),
    _playbackTrailRangeById: new Map(),
    _playbackPtsKey: "",
    _playbackNowMs: null,
    _playbackMinMs: null,
    _playbackMaxMs: null,
    _playbackLastMaxMs: null,
    _pbDrag: null,
    _pbInertia2d: null,
  };
}

const BUS03 = { id: "BUS03", lat: 40.76165, lon: -111.91069, trail: BUS03_TRAIL,
  readings: { OZNE: { value: "35.50", ci: 6 } } };

test("movement-filtered idle sensor still records an existence window", () => {
  const view = makeView([BUS03]);
  const pe = new PlaybackEngine(view);
  pe._ensurePlaybackPoints(view.lastState);

  assert.equal(view._playbackPtsById.has("BUS03"), false,
    "jitter trail (~43m < 50m) stays excluded from the physics points map");
  const rng = view._playbackTrailRangeById.get("BUS03");
  assert.ok(rng, "existence window recorded despite movement filter");
  assert.equal(rng.tMinMs, T_1615);
  assert.equal(rng.tMaxMs, T_1618);
  assert.equal(rng.staticPts.length, 7, "parsed points retained for static sampling");
});

test("pose is hidden at playhead times before the sensor's first point", () => {
  const view = makeView([BUS03]);
  const pe = new PlaybackEngine(view);
  view._playbackNowMs = T_1615 - 3 * 3600000; // 3 hours before the sensor existed
  const pose = pe._mobilePoseForRender(BUS03, 1000);
  assert.equal(pose.hidden, true, "sensor must not exist before its first data point");
  assert.equal(pose.opacity, 0);
  assert.equal(pose.reading, null);
});

test("pose inside the window is time-indexed, not the frozen live snapshot", () => {
  const view = makeView([BUS03]);
  const pe = new PlaybackEngine(view);
  view._playbackNowMs = Date.UTC(2026, 6, 9, 16, 16, 15); // between points 3 and 4
  const pose = pe._mobilePoseForRender(BUS03, 1000);
  assert.ok(!pose.hidden, "sensor exists inside its window");
  assert.equal(pose.lat, 40.76186, "position pinned to newest point at-or-before playhead");
  assert.equal(pose.reading.value, "41.00", "reading comes from that trail point");
  assert.equal(pose.readings.OZNE.value, "41.00");
});

test("pose at/after the last point holds the last known point", () => {
  const view = makeView([BUS03]);
  const pe = new PlaybackEngine(view);
  view._playbackNowMs = T_1618 + 3600000;
  const pose = pe._mobilePoseForRender(BUS03, 1000);
  assert.ok(!pose.hidden);
  assert.equal(pose.lat, 40.76165, "clamps to the last real point");
  assert.equal(pose.reading.value, "35.50");
});

test("a MOVING sensor is also hidden before its first point", () => {
  // ~330m of real movement — passes the movement gate into _playbackPtsById.
  const movingTrail = [
    { lat: 40.7600, lon: -111.9100, t: "2026-07-09 10:00:00 UTC", m: 1 },
    { lat: 40.7615, lon: -111.9100, t: "2026-07-09 10:01:00 UTC", m: 1 },
    { lat: 40.7630, lon: -111.9100, t: "2026-07-09 10:02:00 UTC", m: 1 },
  ];
  const mv = { id: "BUS99", lat: 40.7630, lon: -111.9100, trail: movingTrail };
  const view = makeView([mv]);
  const pe = new PlaybackEngine(view);
  pe._ensurePlaybackPoints(view.lastState);
  assert.equal(view._playbackPtsById.has("BUS99"), true, "moving trail passes the gate");

  view._playbackNowMs = Date.UTC(2026, 6, 9, 9, 0, 0); // an hour before it started
  const pose = pe._mobilePoseForRender(mv, 1000);
  assert.equal(pose.hidden, true,
    "gated-in sensors were previously dimmed to 0.3 before their start; now hidden");
});

test("single-point trail records a window and gates existence", () => {
  const one = { id: "BUS1PT", lat: 40.75, lon: -111.9,
    trail: [{ lat: 40.75, lon: -111.9, t: "2026-07-09 12:00:00 UTC", m: 1,
      readings: { OZNE: { value: "22.00", ci: 3 } } }] };
  const view = makeView([one]);
  const pe = new PlaybackEngine(view);
  pe._ensurePlaybackPoints(view.lastState);

  const rng = view._playbackTrailRangeById.get("BUS1PT");
  assert.ok(rng, "single-point trail still defines when the sensor exists");
  assert.equal(rng.staticPts.length, 1);

  view._playbackNowMs = Date.UTC(2026, 6, 9, 11, 0, 0);
  assert.equal(pe._mobilePoseForRender(one, 1000).hidden, true, "hidden before its only point");
  view._playbackNowMs = Date.UTC(2026, 6, 9, 12, 30, 0);
  const pose = pe._mobilePoseForRender(one, 1000);
  assert.ok(!pose.hidden, "visible after its only point");
  assert.equal(pose.reading.value, "22.00");
});
