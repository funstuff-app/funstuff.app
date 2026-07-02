// integration_engine_seams.test.cjs
//
// Seam tests for the engine_* controllers extracted from map_view.js during the
// front-end modularization (stories S1–S10). Each engine module is require()d
// directly, constructed with a MINIMAL fake view, and exercised through ONE
// representative behavior to prove the controller/view seam still works from a
// bare node context (no browser globals at factory time).
//
// Hermetic: node stdlib only, no network, no timers left running.

const test = require("node:test");
const assert = require("node:assert/strict");

const TileRenderer   = require("../engine_tile_renderer.js");
const RoadMatcher    = require("../engine_road_matcher.js");
const VehicleMotion  = require("../engine_vehicle_motion.js");
const PlaybackEngine = require("../engine_playback_engine.js");
const WindAdvection  = require("../engine_wind_advection.js");
const PaFieldRenderer = require("../engine_pa_field.js");
const OverlayRenderer = require("../engine_overlay_renderer.js");
const CameraGestures  = require("../engine_camera_gestures.js");

// ── TileRenderer: cache get/set roundtrip + LRU eviction bound ──────────────
test("TileRenderer _tileCacheGet/_tileCacheSet roundtrip and LRU bound", () => {
  const view = { tileCache: new Map() };
  const tr = new TileRenderer(view);
  // Shrink the private bound so we can prove eviction deterministically.
  tr._tileCacheMax = 3;

  tr._tileCacheSet("a", { v: 1 });
  tr._tileCacheSet("b", { v: 2 });
  tr._tileCacheSet("c", { v: 3 });
  assert.deepEqual(tr._tileCacheGet("a"), { v: 1 }, "roundtrip returns stored value");
  assert.equal(view.tileCache.size, 3);

  // Getting "a" refreshed it to MRU; "b" is now the oldest. Adding a 4th entry
  // must evict "b" (LRU), not "a".
  tr._tileCacheSet("d", { v: 4 });
  assert.equal(view.tileCache.size, 3, "cache stays bounded at _tileCacheMax");
  assert.equal(tr._tileCacheGet("b"), null, "least-recently-used key evicted");
  assert.deepEqual(tr._tileCacheGet("a"), { v: 1 }, "recently-touched key survives");
  assert.deepEqual(tr._tileCacheGet("d"), { v: 4 }, "newest key present");
});

// ── RoadMatcher: matched-range bookkeeping + interval merge ─────────────────
test("RoadMatcher _isRangeMatched / _markRangeMatched bookkeeping", () => {
  const view = { _roadMatchedRangesById: new Map() };
  const rm = new RoadMatcher(view);

  assert.equal(rm._isRangeMatched("s1", 100, 200), false, "unknown sensor is unmatched");

  rm._markRangeMatched("s1", 100, 200);
  assert.equal(rm._isRangeMatched("s1", 120, 180), true, "sub-range is matched");
  assert.equal(rm._isRangeMatched("s1", 90, 210), false, "wider range not fully matched");

  // Overlapping mark merges into a single compact range.
  rm._markRangeMatched("s1", 150, 300);
  assert.equal(rm._isRangeMatched("s1", 100, 300), true, "merged range covers union");
  assert.equal(view._roadMatchedRangesById.get("s1").length, 1, "overlapping ranges merged");
});

// ── VehicleMotion: Catmull-Rom endpoint continuity ──────────────────────────
test("VehicleMotion _catmullRom passes through p1 at t=0 and p2 at t=1", () => {
  const vm = new VehicleMotion({});
  const pts = [
    { lat: 0, lon: 0 },
    { lat: 1, lon: 2 },
    { lat: 3, lon: 5 },
    { lat: 4, lon: 6 },
  ];
  const a = vm._catmullRom(pts, 0, 1, 2, 3, 0);
  assert.ok(Math.abs(a.lat - 1) < 1e-9 && Math.abs(a.lon - 2) < 1e-9, "t=0 → p1");
  const b = vm._catmullRom(pts, 0, 1, 2, 3, 1);
  assert.ok(Math.abs(b.lat - 3) < 1e-9 && Math.abs(b.lon - 5) < 1e-9, "t=1 → p2");
  // Midpoint stays between the two interior control points (continuity sanity).
  const m = vm._catmullRom(pts, 0, 1, 2, 3, 0.5);
  assert.ok(m.lat > 1 && m.lat < 3, "midpoint lat bounded by interior points");
});

// ── PlaybackEngine: isPlaybackAtEnd epsilon window ──────────────────────────
test("PlaybackEngine isPlaybackAtEnd respects epsilon window", () => {
  let timeMs = 0;
  const view = {
    getPlaybackBounds() { return { minMs: 0, maxMs: 10000 }; },
    getPlaybackTimeMs() { return timeMs; },
  };
  const pe = new PlaybackEngine(view);

  timeMs = 10000;
  assert.equal(pe.isPlaybackAtEnd(100), true, "exactly at maxMs is at-end");
  timeMs = 9950;
  assert.equal(pe.isPlaybackAtEnd(100), true, "within epsilon is at-end");
  timeMs = 9800;
  assert.equal(pe.isPlaybackAtEnd(100), false, "outside epsilon is not at-end");
  timeMs = null;
  assert.equal(pe.isPlaybackAtEnd(100), false, "null time is not at-end");
});

// ── WindAdvection: grid-field alpha blend ───────────────────────────────────
test("WindAdvection _interpolateWindFields alpha-blends grid fields", () => {
  const wa = new WindAdvection({});
  const fieldA = { gw: 2, gh: 1, bounds: { n: 1 }, uGrid: [0, 10], vGrid: [0, -4] };
  const fieldB = { gw: 2, gh: 1, bounds: { n: 1 }, uGrid: [2, 20], vGrid: [4, 0] };

  const at0 = wa._interpolateWindFields(fieldA, fieldB, 0);
  assert.deepEqual(at0.uGrid, [0, 10], "alpha=0 yields fieldA");

  const at1 = wa._interpolateWindFields(fieldA, fieldB, 1);
  assert.deepEqual(at1.uGrid, [2, 20], "alpha=1 yields fieldB");

  const mid = wa._interpolateWindFields(fieldA, fieldB, 0.5);
  assert.deepEqual(mid.uGrid, [1, 15], "alpha=0.5 midpoint u blend");
  assert.deepEqual(mid.vGrid, [2, -2], "alpha=0.5 midpoint v blend");
  assert.equal(mid.gw, 2, "grid dims preserved");
  assert.equal(mid.bounds, fieldA.bounds, "bounds carried from fieldA");

  assert.equal(wa._interpolateWindFields(null, fieldB, 0.5), null, "missing field short-circuits");
});

// ── PaFieldRenderer: per-pollutant reuse rule (max mode ⇒ no reuse) ──────────
test("PaFieldRenderer getPerPollutantFieldMax returns cached bag with no inputs", () => {
  const view = { _paFieldKey: "k", _paFieldPollutant: null };
  const pf = new PaFieldRenderer(view);
  // No _perPollLastInputs recorded yet → returns the (null) stored bag rather
  // than attempting a recompute that would need browser globals.
  assert.ok(!pf._perPollLastInputs, "no per-pollutant inputs recorded yet");
  assert.equal(pf.getPerPollutantFieldMax(), null, "no inputs → returns stored bag");

  // Reuse gate: in MAX mode view._paFieldPollutant is null, so the rendered tab
  // matches no single pollutant ("pm25" !== null), meaning the main-pass max is
  // never reused as a per-pollutant stand-in.
  const renderedTab = view._paFieldPollutant; // null in max mode
  assert.equal(renderedTab, null);
  for (const tab of ["pm25", "pm10", "o3", "no2", "co"]) {
    assert.notEqual(tab, renderedTab, `${tab} does not reuse the max-mode field`);
  }
});

// ── OverlayRenderer: static-cache key stability ─────────────────────────────
test("OverlayRenderer _overlayStaticKeyForState is stable and view-sensitive", () => {
  const view = {
    _cssW: 800, _cssH: 600, zoom: 12.5,
    center: { lat: 40.76, lon: -111.89 },
    selectedId: "mobile:7",
    _persistedTrailRev: 3,
    showFixedLabels: true,
    _tracePointsKeyForState(state) { return `trace:${state ? state.rev : 0}`; },
    getPlaybackTimeMs() { return 1700000000000; },
  };
  const or = new OverlayRenderer(view);
  const state = { rev: 1 };

  const k1 = or._overlayStaticKeyForState(state);
  const k2 = or._overlayStaticKeyForState(state);
  assert.equal(k1, k2, "same view+state → identical key");

  view.zoom = 13.0;
  const k3 = or._overlayStaticKeyForState(state);
  assert.notEqual(k1, k3, "zoom change → different key");
});

// ── CameraGestures: auto-camera gating ──────────────────────────────────────
test("CameraGestures _canRunAutoCamera gates on interaction/follow flags", () => {
  const view = {
    _touchActive: false, _mouseDragging: false,
    _pinchZooming: false, _followRAF: null,
  };
  const cg = new CameraGestures(view);
  cg._autoCameraSuppressedUntilPerfMs = 0;
  assert.equal(cg._canRunAutoCamera(), true, "idle view allows auto-camera");

  view._touchActive = true;
  assert.equal(cg._canRunAutoCamera(), false, "active touch blocks auto-camera");
  view._touchActive = false;

  view._followRAF = 123;
  assert.equal(cg._canRunAutoCamera(), false, "follow loop owns the camera");
  view._followRAF = null;

  // Suppression window in the future blocks even an otherwise-idle view.
  cg._autoCameraSuppressedUntilPerfMs = performance.now() + 100000;
  assert.equal(cg._canRunAutoCamera(), false, "suppression window blocks auto-camera");
});
