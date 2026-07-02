/**
 * Behavioral tests for the REAL playback loop (ui_playback.js — no inline
 * copies). Drives PlaybackUI.create() with a stub MapView, a controllable
 * wall clock, and a manual requestAnimationFrame pump, then asserts the
 * invariants of the 2026-07 playback rework:
 *
 *   1. The live timeline's leading edge ticks with wall time, and a playhead
 *      riding it NEVER stops — at any speed. At the wall-clock edge the
 *      button says "Live" (lit) regardless of speed.
 *   2. Forward momentum (wheel accumulator / barrel fling coasting) into the
 *      end goes LIVE — it must not park paused at the wall edge with a dead
 *      loop (the "finger scroll to the end stops the wall clock" bug).
 *   3. Paused-at-the-edge is not a state: any pause landing inside the
 *      leading-edge sync window is stepped back behind the window.
 *   4. The ◀◀ REW badge is a POSITION indicator (playhead left of the live
 *      zone, playing or paused); the dim shade is a PAUSE indicator.
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

// ── Environment stubs (before requiring the module) ─────────────────────────
global.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };

let _pendingFrame = null;
let _rafId = 0;
global.requestAnimationFrame = (fn) => { _pendingFrame = fn; return ++_rafId; };
global.cancelAnimationFrame = () => { _pendingFrame = null; };

const clock = { wall: 1_800_000_000_000, perf: 100_000 };
// Node's performance is replaceable; the loop reads performance.now() for dt.
global.performance = { now: () => clock.perf };

const PlaybackUI = require("../ui_playback.js");

// ── Stub DOM ────────────────────────────────────────────────────────────────
function makeElement(id) {
  const classes = new Set(id === "pbPausedShade" || id === "pbRewBadge" || id === "pbJogBarrel" ? ["hidden"] : []);
  return {
    id, textContent: "", value: "0", min: "0", max: "1", step: "", disabled: false, checked: false,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, force) => { (force === undefined ? !classes.has(c) : force) ? classes.add(c) : classes.delete(c); },
      contains: (c) => classes.has(c),
    },
    style: { setProperty() {} },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 300, height: 10 }; },
    querySelector() { return null; },
  };
}
function makeDocument() {
  const els = new Map();
  return {
    getElementById(id) {
      if (!els.has(id)) els.set(id, makeElement(id));
      return els.get(id);
    },
  };
}

// ── Stub MapView with a wall-clock live edge ────────────────────────────────
function makeMap(dataEdgeLagMs) {
  return {
    playbackMode: true,
    _historicalMode: false,
    _scrubbing: false,
    _playbackMinMs: clock.wall - 12 * 3600_000, // 12h of timeline
    _playbackMaxMs: clock.wall - dataEdgeLagMs,  // data edge lags wall by this
    _playbackNowMs: clock.wall - 3600_000,
    _playing: false,
    _playbackLiveFollow: false,
    _playbackSpeed: 5,
    lastState: { meta: {} },
    getPlaybackBounds() {
      let maxMs = this._playbackMaxMs;
      if (!this._historicalMode && maxMs != null) maxMs = Math.max(maxMs, clock.wall);
      return { minMs: this._playbackMinMs, maxMs };
    },
    getPlaybackTimeMs() { return this._playbackNowMs; },
    setPlaybackTimeMs(t) { this._playbackNowMs = t; },
    getPlaybackPlaying() { return this._playing; },
    setPlaybackPlaying(v) { this._playing = !!v; },
    getPlaybackSpeed() { return this._playbackSpeed; },
    setPlaybackSpeed(v) { this._playbackSpeed = Number(v) || 1; },
    isPlaybackAtEnd(epsMs = 100) {
      const b = this.getPlaybackBounds();
      return this._playbackNowMs != null && this._playbackNowMs >= b.maxMs - epsMs;
    },
    _compositePaFieldOnTiles() {}, drawOverlay() {},
    _requestFoveatedRoadMatching() {},
    _stepPbMarkerInertia() { return false; },
    _hasPbMarkerInertia() { return false; },
    _canRunAutoCamera() { return true; },
  };
}

function makePb() {
  return {
    _pbRAF: null, _pbLastPerf: 0, _pbLastUiPerf: 0,
    _pbScrubbing: false, _pbResumeAfterScrub: false, _pbPaused: false, _pbMoveDeltaMs: 0,
    _pbVelocity: 0, _pbAtEndSincePerf: null, _pbArrivedAtEndViaPlayback: false,
    _pbEaseStartPerf: null, _pbEaseStartVelocity: 0, _pbEaseStartPos: 0,
    _pbIsRewinding: false, _pbIsWheelCoasting: false, _pbWheelAccum: 0,
    _pbLoopStartMs: null, _pbSlidingWindowCenter: null,
    _pbPageIndex: 0, _pbPageAutoFollow: true,
    _pbLiveStartWallMs: null, _pbLiveStartDataMs: null, _pbLiveTargetMs: null,
    _pbLiveStallCount: 0, _pbLastKnownMinMs: null, _pbLastKnownMaxMs: null,
    _pbLastForceRefreshSeq: null, _pbLastServerResponseMs: clock.perf,
    _pbDidDrag: false, _deferredCameraFit: null, _pbCommitLoopStartOnCoastEnd: false,
    _pbJogRAF: null, _pbJogLastPerf: 0, _pbMwAccum: 0, _pbMwLastTs: 0,
  };
}

function makeHarness({ dataEdgeLagMs = 20_000 } = {}) {
  const doc = makeDocument();
  const map = makeMap(dataEdgeLagMs);
  const pb = makePb();
  const playback = PlaybackUI.create({
    map, document: doc, pb,
    deps: {
      getScreensaverActive: () => false,
      getSidebarOpen: () => false,
      getSelectedId: () => null,
      performCameraFit() {}, animateFitBoundsLatLon() {}, animateToStoredView() {},
      syncMapPollutant() {}, syncLegendToMapSelection() {}, updateSidebarPlaybackValues() {},
    },
  });
  // step(): advance wall+perf clocks and run the pending rAF frame (if any).
  const step = (ms) => {
    clock.wall += ms; clock.perf += ms;
    const f = _pendingFrame; _pendingFrame = null;
    if (f) f();
    return f != null;
  };
  const startLoop = () => { pb._pbLastPerf = 0; playback.playbackLoop(); };
  const btn = doc.getElementById("pbPlay");
  const badge = doc.getElementById("pbRewBadge");
  const shade = doc.getElementById("pbPausedShade");
  const syncEps = () => {
    const b = map.getPlaybackBounds();
    return Math.max(15000, (b.maxMs - b.minMs) * 0.005);
  };
  return { doc, map, pb, playback, step, startLoop, btn, badge, shade, syncEps };
}

beforeEach(() => { _pendingFrame = null; });

// ─────────────────────────────────────────────────────────────────────────────
describe("riding the wall-clock edge (the wall clock NEVER stops at the end)", () => {
  for (const speed of [1, 5, 60]) {
    it(`playing at the edge keeps up with wall time at ${speed}x and shows lit Live`, () => {
      const h = makeHarness();
      h.map.setPlaybackSpeed(speed);
      h.map.setPlaybackPlaying(true);
      h.map.setPlaybackTimeMs(h.map.getPlaybackBounds().maxMs - 50);
      h.startLoop();
      // 20 frames × 300 ms = 6 s of wall time
      for (let i = 0; i < 20; i++) {
        assert.ok(h.step(300), `loop stayed alive at frame ${i} (${speed}x)`);
      }
      const b = h.map.getPlaybackBounds();
      const t = h.map.getPlaybackTimeMs();
      assert.ok(b.maxMs - t <= 1000,
        `playhead rides within 1s of the wall edge (gap ${Math.round(b.maxMs - t)}ms)`);
      h.playback.updatePlaybackUi();
      assert.equal(h.btn.textContent, "Live", `label is Live at ${speed}x at the edge`);
      assert.ok(h.btn.classList.contains("isLive"), `button is lit at ${speed}x at the edge`);
      assert.ok(h.badge.classList.contains("hidden"), "no REW badge while riding");
      assert.ok(h.shade.classList.contains("hidden"), "no dim shade while riding");
    });
  }
});

describe("forward momentum into the end goes LIVE (finger-scroll freeze bug)", () => {
  it("wheel-coast momentum that hits the wall edge resumes playing live, loop stays alive", () => {
    const h = makeHarness();
    // Simulate the wheel/barrel-fling state: paused, coasting, big forward velocity
    h.map.setPlaybackPlaying(false);
    h.map._playbackLiveFollow = false;
    h.pb._pbIsWheelCoasting = true;
    h.pb._pbVelocity = 50;              // 50x forward fling
    h.map.setPlaybackTimeMs(h.map.getPlaybackBounds().maxMs - 500);
    h.startLoop();                      // first call primes dt (dt=0)
    h.step(16);                         // 50x * 16ms = 800ms > 500ms gap → clamps at the end
    assert.equal(h.map.getPlaybackPlaying(), true, "playing after hitting the end");
    assert.equal(h.map._playbackLiveFollow, true, "went LIVE after hitting the end");
    assert.equal(h.pb._pbIsWheelCoasting, false, "coasting cleared");
    // and it RIDES: wall advances, playhead follows, loop never dies
    for (let i = 0; i < 10; i++) {
      assert.ok(h.step(300), `loop alive post-clamp frame ${i}`);
    }
    const b = h.map.getPlaybackBounds();
    assert.ok(b.maxMs - h.map.getPlaybackTimeMs() <= 1000,
      "playhead keeps up with the ticking wall edge after the fling");
    h.playback.updatePlaybackUi();
    assert.equal(h.btn.textContent, "Live");
    assert.ok(h.btn.classList.contains("isLive"));
  });

  it("a released jog/scrub at the data edge (playing, zero velocity) starts riding", () => {
    const h = makeHarness({ dataEdgeLagMs: 30_000 });
    // barrel onDragEnd semantics: playing=true, small velocity, at the data edge
    h.map.setPlaybackPlaying(true);
    h.pb._pbVelocity = 0;
    h.map.setPlaybackTimeMs(h.map._playbackMaxMs); // parked exactly at data edge
    h.startLoop();
    h.step(16);
    for (let i = 0; i < 5; i++) assert.ok(h.step(300), `alive frame ${i}`);
    const b = h.map.getPlaybackBounds();
    assert.ok(b.maxMs - h.map.getPlaybackTimeMs() <= 1000,
      "jumped from the data edge onto the ticking wall edge");
  });
});

describe("an idle playhead at the edge GOES LIVE (never freezes)", () => {
  it("a finger-scroll that coasts to rest AT the edge starts riding, not frozen", () => {
    const h = makeHarness();
    // The wheel/finger-scroll end state: NOT playing, NOT live, a small
    // forward coast decaying to rest right at the data edge. The old loop
    // yanked this backward (frozen); the new loop must GO LIVE.
    h.map.setPlaybackPlaying(false);
    h.map._playbackLiveFollow = false;
    h.pb._pbIsWheelCoasting = true;
    h.pb._pbVelocity = 0.5;                      // slow forward coast, loop alive
    h.map.setPlaybackTimeMs(h.map._playbackMaxMs); // resting at the data edge
    h.startLoop();
    h.step(16);
    assert.equal(h.map.getPlaybackPlaying(), true, "went live (playing) at the edge");
    assert.equal(h.map._playbackLiveFollow, true, "live-follow engaged");
    // and it keeps ticking with wall time — the wall clock does NOT stop
    const t1 = h.map.getPlaybackTimeMs();
    for (let i = 0; i < 8; i++) assert.ok(h.step(300), `loop alive frame ${i}`);
    assert.ok(h.map.getPlaybackTimeMs() > t1, "playhead advanced with wall time");
    h.playback.updatePlaybackUi();
    assert.equal(h.btn.textContent, "Live");
    assert.ok(h.badge.classList.contains("hidden"), "no REW badge while live at the edge");
    assert.ok(h.shade.classList.contains("hidden"), "no dim while live");
  });

  it("an explicit pause at the wall edge FREEZES IN PLACE — no skip-back", () => {
    const h = makeHarness();
    // Ride the edge, then pause exactly as the pbPlay button does: clear the
    // active flags, zero velocity, and SET the paused hold. The playhead must
    // NOT jump backward, and the loop must not re-ride it.
    h.map.setPlaybackPlaying(true);
    h.map.setPlaybackTimeMs(h.map.getPlaybackBounds().maxMs - 50);
    h.startLoop();
    h.step(300);
    const atEdge = h.map.getPlaybackTimeMs();
    // pause
    h.map._playbackLiveFollow = false;
    h.map.setPlaybackPlaying(false);
    h.pb._pbPaused = true;
    h.pb._pbVelocity = 0;
    h.playback.updatePlaybackUi();
    assert.ok(Math.abs(h.map.getPlaybackTimeMs() - atEdge) < 1000,
      "playhead frozen in place (no minutes-long skip-back)");
    assert.ok(!h.shade.classList.contains("hidden"), "dim shows immediately on pause, even at the edge");
    // the loop leaves it paused (the paused hold suppresses go-live)
    h.startLoop();
    h.step(16);
    assert.equal(h.map.getPlaybackPlaying(), false, "stays paused");
    assert.equal(h.map._playbackLiveFollow, false, "does not re-ride");
    assert.ok(Math.abs(h.map.getPlaybackTimeMs() - atEdge) < 1000, "still in place after a loop frame");
  });
});

describe("REW badge follows the PLAYHEAD MOVEMENT DELTA (direction), not flags", () => {
  // `behind` sits well behind the live zone so _behindLive holds throughout.
  const behind = (h) => h.map._playbackMaxMs - h.syncEps() - 3600_000;

  // Pin the OLDEST page (all of it is behind the live zone) and drive
  // applyScrub with page-relative slider values, exactly as a real drag does.
  const scrubTo = (h, absMs) => {
    h.pb._pbPageAutoFollow = false;
    h.pb._pbPageIndex = 0;
    h.pb._pbSlidingWindowCenter = null;
    const pr = h.playback._pbGetPageRange();
    h.doc.getElementById("pbScrub").value = String(absMs - pr.minMs);
    h.playback.applyScrub();                       // real move → sets move delta
  };

  it("NO badge while SCRUBBING FORWARD (positive move delta), even repeatedly", () => {
    // The exact reported bug: dragging the playhead forward must not show REW.
    const h = makeHarness();
    h.pb._pbScrubbing = true;
    const base = h.map._playbackMinMs;
    scrubTo(h, base + 0.25 * 3600_000);            // seed position inside the page
    for (const hrs of [0.5, 1.0, 1.5, 2.0]) {      // then drag FORWARD
      scrubTo(h, base + hrs * 3600_000);
      assert.ok(h.map._playbackMaxMs - h.map.getPlaybackTimeMs() > h.syncEps(),
        "still behind the live zone");
      assert.ok(h.badge.classList.contains("hidden"), `no REW at +${hrs}h`);
      assert.ok(h.shade.classList.contains("hidden"), `no dim at +${hrs}h`);
    }
  });

  it("NO badge while PLAYING FORWARD (loop advances the playhead)", () => {
    const h = makeHarness();
    h.map.setPlaybackPlaying(true);
    h.map.setPlaybackTimeMs(behind(h));
    h.startLoop();
    for (let i = 0; i < 6; i++) h.step(200);      // real forward playback
    assert.ok(h.map._playbackMaxMs - h.map.getPlaybackTimeMs() > h.syncEps(),
      "still behind the live zone");
    assert.ok(h.badge.classList.contains("hidden"), "no REW while playing forward");
    assert.ok(h.shade.classList.contains("hidden"), "no dim while playing forward");
  });

  it("badge, no dim, while SCRUBBING BACKWARD (negative move delta)", () => {
    const h = makeHarness();
    h.pb._pbScrubbing = true;
    const base = h.map._playbackMinMs;
    scrubTo(h, base + 2.0 * 3600_000);            // start forward
    for (const hrs of [1.5, 1.0, 0.5]) scrubTo(h, base + hrs * 3600_000); // then BACK
    assert.ok(!h.badge.classList.contains("hidden"), "REW visible while scrubbing back");
    assert.ok(h.shade.classList.contains("hidden"), "no dim while moving");
  });

  it("badge AND dim while STOPPED (paused) behind the live zone", () => {
    const h = makeHarness();
    h.map.setPlaybackPlaying(false);
    h.map._playbackLiveFollow = false;
    h.pb._pbVelocity = 0;
    h.map.setPlaybackTimeMs(behind(h));
    h.playback.updatePlaybackUi();
    assert.ok(!h.badge.classList.contains("hidden"), "badge visible (stopped, behind live)");
    assert.ok(!h.shade.classList.contains("hidden"), "dim visible (paused)");
    assert.equal(h.btn.textContent, "Play");
  });

  it("neither shows in historical snapshots", () => {
    const h = makeHarness();
    h.map._historicalMode = true;
    h.map.setPlaybackPlaying(false);
    h.map.setPlaybackTimeMs(h.map._playbackMinMs + 1000);
    h.playback.updatePlaybackUi();
    assert.ok(h.badge.classList.contains("hidden"));
    assert.ok(h.shade.classList.contains("hidden"));
  });
});
