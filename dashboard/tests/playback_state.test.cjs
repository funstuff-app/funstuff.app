const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const PlaybackState = require("../playback_state.js");

// Minimal MapView stub — supports mutable state for toggle sequence tests
function makeMap(overrides = {}) {
  const m = {
    _playbackMaxMs: overrides.dataEdge ?? 1000000,
    _playbackMinMs: overrides.minMs ?? 0,
    _playbackNowMs: overrides.playhead ?? 500000,
    _playbackLiveFollow: overrides.liveFollow ?? false,
    _historicalMode: overrides.historical ?? false,
    _playbackSpeed: overrides.speed ?? 1.0,
    _playing: overrides.playing ?? false,
    lastState: overrides.lastState ?? null,
    getPlaybackBounds() {
      let maxMs = this._playbackMaxMs;
      if (!this._historicalMode && maxMs != null) {
        maxMs = Math.max(maxMs, Date.now());
      }
      return { minMs: this._playbackMinMs, maxMs };
    },
    getPlaybackTimeMs() { return this._playbackNowMs; },
    setPlaybackTimeMs(t) { this._playbackNowMs = t; },
    getPlaybackSpeed() { return this._playbackSpeed; },
    getPlaybackPlaying() { return m._playing; },
    setPlaybackPlaying(v) { m._playing = !!v; },
  };
  return m;
}

describe("PlaybackState module", () => {
  it("exports constructor", () => {
    assert.equal(typeof PlaybackState, "function");
  });

  it("dataEdgeMs returns _playbackMaxMs", () => {
    const map = makeMap({ dataEdge: 12345 });
    const ps = new PlaybackState(map);
    assert.equal(ps.dataEdgeMs(), 12345);
  });

  it("predictedRemainingSec uses SSE timestamp when available", () => {
    const map = makeMap();
    const ps = new PlaybackState(map);
    const futureTs = Date.now() + 300000; // 300s from now
    ps.serverNextUpdateTs = futureTs;
    const rem = ps.predictedRemainingSec();
    assert.ok(rem >= 299 && rem <= 301, `Expected ~300, got ${rem}`);
  });

  it("predictedRemainingSec falls back to meta fields", () => {
    const map = makeMap({
      lastState: { meta: { polling_next_update_in_s: 120 } }
    });
    const ps = new PlaybackState(map);
    ps.lastServerResponseMs = Date.now();
    const rem = ps.predictedRemainingSec();
    assert.ok(rem >= 119 && rem <= 121, `Expected ~120, got ${rem}`);
  });

  it("predictedRemainingSec returns 600 as ultimate fallback", () => {
    const map = makeMap({ lastState: { meta: {} } });
    const ps = new PlaybackState(map);
    ps.lastServerResponseMs = Date.now();
    const rem = ps.predictedRemainingSec();
    assert.ok(rem >= 599 && rem <= 601, `Expected ~600, got ${rem}`);
  });

  it("runwayMs scales by speed", () => {
    const map = makeMap({ speed: 5.0 });
    const ps = new PlaybackState(map);
    const futureTs = Date.now() + 60000; // 60s from now
    ps.serverNextUpdateTs = futureTs;
    const rw = ps.runwayMs(5.0);
    // 60s * 1000 * 5 = 300000ms
    assert.ok(rw >= 298000 && rw <= 302000, `Expected ~300000, got ${rw}`);
  });

  it("pastDataEdge true when playhead >= dataEdge", () => {
    const now = Date.now();
    const map = makeMap({ dataEdge: now - 1000, playhead: now - 500 });
    const ps = new PlaybackState(map);
    assert.equal(ps.pastDataEdge(), true);
  });

  it("pastDataEdge false when playhead is well before dataEdge", () => {
    const now = Date.now();
    const map = makeMap({ dataEdge: now, playhead: now - 10000 });
    const ps = new PlaybackState(map);
    assert.equal(ps.pastDataEdge(), false);
  });

  it("atWallEdge true when playhead is near Date.now()", () => {
    const map = makeMap({ playhead: Date.now() - 100 });
    const ps = new PlaybackState(map);
    assert.equal(ps.atWallEdge(), true);
  });

  it("atWallEdge false when playhead is far from Date.now()", () => {
    const map = makeMap({ playhead: Date.now() - 5000 });
    const ps = new PlaybackState(map);
    assert.equal(ps.atWallEdge(), false);
  });

  describe("buttonState", () => {
    it("Live glow: playhead at wall clock", () => {
      const now = Date.now();
      const map = makeMap({ liveFollow: false, playing: false, playhead: now });
      const ps = new PlaybackState(map);
      assert.deepEqual(ps.buttonState(), { text: "Live", glow: true });
    });

    it("Live glow: playhead at wall clock, playing=true still shows Live", () => {
      const now = Date.now();
      const map = makeMap({ liveFollow: false, playing: true, playhead: now });
      const ps = new PlaybackState(map);
      assert.deepEqual(ps.buttonState(), { text: "Live", glow: true });
    });

    it("Pause: liveFollow in runway (playing, NOT at wall)", () => {
      const now = Date.now();
      const dataEdge = now - 120000;
      const map = makeMap({ liveFollow: true, playing: true, playhead: dataEdge - 60000, dataEdge });
      const ps = new PlaybackState(map);
      assert.deepEqual(ps.buttonState(), { text: "Pause", glow: false });
    });

    it("Pause: playing normally, not at wall", () => {
      const now = Date.now();
      const map = makeMap({ liveFollow: false, playing: true, playhead: now - 60000, dataEdge: now });
      const ps = new PlaybackState(map);
      assert.deepEqual(ps.buttonState(), { text: "Pause", glow: false });
    });

    it("Play: paused, not at wall", () => {
      const now = Date.now();
      const map = makeMap({ liveFollow: false, playing: false, playhead: now - 60000, dataEdge: now });
      const ps = new PlaybackState(map);
      assert.deepEqual(ps.buttonState(), { text: "Play", glow: false });
    });

    it("historical mode: playing → Pause", () => {
      const map = makeMap({ historical: true, playing: true });
      const ps = new PlaybackState(map);
      assert.deepEqual(ps.buttonState(), { text: "Pause", glow: false });
    });

    it("historical mode: paused → Play", () => {
      const map = makeMap({ historical: true, playing: false });
      const ps = new PlaybackState(map);
      assert.deepEqual(ps.buttonState(), { text: "Play", glow: false });
    });
  });

  it("snapToRunway sets playhead before data edge", () => {
    const now = Date.now();
    const map = makeMap({ dataEdge: now, minMs: now - 600000, speed: 1.0 });
    const ps = new PlaybackState(map);
    ps.serverNextUpdateTs = now + 120000; // 120s from now
    ps.snapToRunway(1.0);
    const t = map.getPlaybackTimeMs();
    assert.ok(t < now, "Playhead should be before data edge");
    assert.ok(t > now - 200000, "Playhead should be reasonably close to data edge");
  });

  it("onSSEMessage extracts predicted_next_update_ts", () => {
    const map = makeMap();
    const ps = new PlaybackState(map);
    ps.onSSEMessage({ seq: 1, ts: 1234567890, predicted_next_update_ts: 1234568000 });
    assert.equal(ps.serverNextUpdateTs, 1234568000 * 1000);
  });

  it("resetLiveTracking clears tracking state", () => {
    const map = makeMap();
    const ps = new PlaybackState(map);
    ps._liveStartWallMs = 123;
    ps._liveStartDataMs = 456;
    ps._liveStallCount = 5;
    ps._deferredCameraFit = { type: "bounds" };
    ps.resetLiveTracking();
    assert.equal(ps._liveStartWallMs, null);
    assert.equal(ps._liveStartDataMs, null);
    assert.equal(ps._liveStallCount, 0);
    assert.equal(ps._deferredCameraFit, null);
  });

  it("deferred camera fit round-trips through store/consume", () => {
    const map = makeMap();
    const ps = new PlaybackState(map);
    const fit = { type: "bounds", bb: { minLat: 1, maxLat: 2, minLon: 3, maxLon: 4 } };
    ps.deferCameraFit(fit);
    assert.deepEqual(ps.consumeDeferredCameraFit(), fit);
    assert.equal(ps.consumeDeferredCameraFit(), null);
  });

  describe("inLiveGlow", () => {
    it("true: playhead at wall clock", () => {
      const now = Date.now();
      const map = makeMap({ playhead: now });
      const ps = new PlaybackState(map);
      assert.equal(ps.inLiveGlow(), true);
    });

    it("false: playhead not at wall", () => {
      const now = Date.now();
      const map = makeMap({ playhead: now - 5000 });
      const ps = new PlaybackState(map);
      assert.equal(ps.inLiveGlow(), false);
    });

    it("false: historical mode even at wall", () => {
      const now = Date.now();
      const map = makeMap({ historical: true, playhead: now });
      const ps = new PlaybackState(map);
      assert.equal(ps.inLiveGlow(), false);
    });
  });

  describe("shouldEnterLive", () => {
    it("true: past data edge, not liveFollow, playing", () => {
      const now = Date.now();
      const map = makeMap({ liveFollow: false, playing: true, playhead: now, dataEdge: now - 120000 });
      const ps = new PlaybackState(map);
      assert.equal(ps.shouldEnterLive(), true);
    });

    it("true: past data edge, not liveFollow, paused", () => {
      const now = Date.now();
      const map = makeMap({ liveFollow: false, playing: false, playhead: now, dataEdge: now - 120000 });
      const ps = new PlaybackState(map);
      assert.equal(ps.shouldEnterLive(), true);
    });

    it("false: already liveFollow", () => {
      const now = Date.now();
      const map = makeMap({ liveFollow: true, playing: false, playhead: now, dataEdge: now - 120000 });
      const ps = new PlaybackState(map);
      assert.equal(ps.shouldEnterLive(), false);
    });

    it("false: playhead behind data edge", () => {
      const now = Date.now();
      const map = makeMap({ liveFollow: false, playing: false, playhead: now - 300000, dataEdge: now });
      const ps = new PlaybackState(map);
      assert.equal(ps.shouldEnterLive(), false);
    });

    it("false: historical mode", () => {
      const now = Date.now();
      const map = makeMap({ liveFollow: false, playing: false, historical: true, playhead: now, dataEdge: now - 120000 });
      const ps = new PlaybackState(map);
      assert.equal(ps.shouldEnterLive(), false);
    });
  });

  describe("click toggle cycle", () => {
    // Start: playhead at wall → "Live" glow
    function setup() {
      const now = Date.now();
      const dataEdge = now - 120000;
      const map = makeMap({
        liveFollow: false, // at wall, liveFollow is OFF
        playing: false,
        playhead: now, // at wall clock
        dataEdge,
        minMs: now - 600000,
        speed: 1.0,
      });
      const ps = new PlaybackState(map);
      ps.lastServerResponseMs = now;
      ps.serverNextUpdateTs = now + 120000;
      return { map, ps, now, dataEdge };
    }

    it("at wall → Live glow", () => {
      const { ps } = setup();
      assert.deepEqual(ps.buttonState(), { text: "Live", glow: true });
    });

    it("click Live glow → snap to runway → Pause", () => {
      const { map, ps, dataEdge } = setup();
      // Click handler reads bs.text === "Live" → snap to runway, set liveFollow, play
      map._playbackLiveFollow = true;
      ps.snapToRunway(1.0);
      map._playing = true;
      assert.ok(map.getPlaybackTimeMs() < dataEdge, "Should be in runway");
      assert.equal(ps.atWallEdge(), false, "Not at wall after snap");
      assert.deepEqual(ps.buttonState(), { text: "Pause", glow: false });
    });

    it("click Pause (in runway) → pauses + clears liveFollow", () => {
      const { map, ps, dataEdge } = setup();
      // First enter runway
      map._playbackLiveFollow = true;
      ps.snapToRunway(1.0);
      map._playing = true;
      assert.deepEqual(ps.buttonState(), { text: "Pause", glow: false });
      // Click handler reads bs.text === "Pause" → pause + clear liveFollow
      map._playing = false;
      map._playbackLiveFollow = false;
      assert.deepEqual(ps.buttonState(), { text: "Play", glow: false });
    });

    it("click Pause (normal playback, past data edge) → just pauses, no snap", () => {
      const { map, ps, now, dataEdge } = setup();
      // Normal playback past data edge, no liveFollow
      map._playbackLiveFollow = false;
      map._playing = true;
      map._playbackNowMs = dataEdge + 5000; // past data edge but not at wall
      assert.deepEqual(ps.buttonState(), { text: "Pause", glow: false });
      // Click handler reads "Pause" → just pause
      map._playing = false;
      assert.deepEqual(ps.buttonState(), { text: "Play", glow: false });
      // Playhead should NOT have changed
      assert.equal(map.getPlaybackTimeMs(), dataEdge + 5000, "No runway snap");
    });

    it("runway reaches wall → liveFollow OFF → Live glow", () => {
      const { map, ps, now } = setup();
      map._playbackLiveFollow = true;
      map._playing = true;
      map._playbackNowMs = now;
      assert.equal(ps.atWallEdge(), true);
      map._playbackLiveFollow = false; // loop turns this off at wall
      assert.deepEqual(ps.buttonState(), { text: "Live", glow: true });
    });
  });

  // ── Playback loop simulation ────────────────────────────────────────────

  describe("data-edge crossing + wall-arrival (loop sim)", () => {
    /**
     * Simulates the loop's data-edge crossing check AND wall-arrival check.
     * Mirrors app.js exactly.
     */
    function simulateLoopFrame({ ps, map, tMsBefore, tMsAfter, isRewinding, isWheelCoasting, velocity }) {
      map._playbackNowMs = tMsAfter;
      const dataEdge = ps.dataEdgeMs();
      const pastDE = ps.pastDataEdge();
      const crossedPastDataEdge = pastDE && isFinite(tMsBefore) && tMsBefore < (dataEdge - 500);
      const didAdvanceTime = tMsAfter !== tMsBefore;

      const result = { enteredRunway: false, arrivedAtWall: false };

      // Crossing check
      if (!isRewinding && map.getPlaybackPlaying() && !map._playbackLiveFollow &&
          !map._historicalMode && !isWheelCoasting && didAdvanceTime && velocity >= 0 &&
          crossedPastDataEdge) {
        map._playbackLiveFollow = true;
        result.enteredRunway = true;
      }

      // Wall-arrival check
      if (map._playbackLiveFollow && ps.atWallEdge()) {
        map._playbackLiveFollow = false;
        result.arrivedAtWall = true;
      }

      result.buttonState = ps.buttonState();
      result.liveFollow = map._playbackLiveFollow;
      result.playing = map._playing;
      return result;
    }

    it("crosses data edge → enters runway (Pause), not at wall", () => {
      const now = Date.now();
      const dataEdge = now - 2000;
      const map = makeMap({ liveFollow: false, playing: true, playhead: dataEdge - 1000, dataEdge });
      const ps = new PlaybackState(map);

      const r = simulateLoopFrame({
        ps, map, tMsBefore: dataEdge - 1000, tMsAfter: dataEdge + 100,
        isRewinding: false, isWheelCoasting: false, velocity: 1.0,
      });

      assert.equal(r.enteredRunway, true);
      assert.equal(r.arrivedAtWall, false, "Not at wall yet");
      assert.equal(r.liveFollow, true, "In runway");
      assert.deepEqual(r.buttonState, { text: "Pause", glow: false });
    });

    it("runway playhead reaches wall → exits liveFollow → Live glow", () => {
      const now = Date.now();
      const map = makeMap({ liveFollow: true, playing: true, playhead: now - 100 });
      const ps = new PlaybackState(map);

      const r = simulateLoopFrame({
        ps, map, tMsBefore: now - 100, tMsAfter: now,
        isRewinding: false, isWheelCoasting: false, velocity: 1.0,
      });

      assert.equal(r.arrivedAtWall, true);
      assert.equal(r.liveFollow, false, "liveFollow OFF at wall");
      assert.deepEqual(r.buttonState, { text: "Live", glow: true });
    });

    it("playing stays true throughout crossing and wall arrival", () => {
      const now = Date.now();
      const dataEdge = now - 100;
      const map = makeMap({ liveFollow: false, playing: true, playhead: dataEdge - 1000, dataEdge });
      const ps = new PlaybackState(map);

      // Frame 1: cross data edge
      const r1 = simulateLoopFrame({
        ps, map, tMsBefore: dataEdge - 1000, tMsAfter: dataEdge + 50,
        isRewinding: false, isWheelCoasting: false, velocity: 5.0,
      });
      assert.equal(r1.playing, true, "Still playing after crossing");

      // Frame 2: reach wall
      const r2 = simulateLoopFrame({
        ps, map, tMsBefore: dataEdge + 50, tMsAfter: now,
        isRewinding: false, isWheelCoasting: false, velocity: 5.0,
      });
      assert.equal(r2.playing, true, "Still playing at wall");
      assert.deepEqual(r2.buttonState, { text: "Live", glow: true });
    });

    it("does NOT enter runway during rewind", () => {
      const now = Date.now();
      const dataEdge = now - 2000;
      const map = makeMap({ liveFollow: false, playing: true, playhead: dataEdge - 1000, dataEdge });
      const ps = new PlaybackState(map);
      const r = simulateLoopFrame({
        ps, map, tMsBefore: dataEdge - 1000, tMsAfter: dataEdge + 100,
        isRewinding: true, isWheelCoasting: false, velocity: -5.0,
      });
      assert.equal(r.enteredRunway, false);
    });

    it("does NOT enter runway in historical mode", () => {
      const now = Date.now();
      const dataEdge = now - 2000;
      const map = makeMap({ liveFollow: false, playing: true, historical: true, playhead: dataEdge - 1000, dataEdge });
      const ps = new PlaybackState(map);
      const r = simulateLoopFrame({
        ps, map, tMsBefore: dataEdge - 1000, tMsAfter: dataEdge + 100,
        isRewinding: false, isWheelCoasting: false, velocity: 1.0,
      });
      assert.equal(r.enteredRunway, false);
    });
  });

  // ── Full lifecycle ──────────────────────────────────────────────────────
  describe("full lifecycle", () => {
    it("play → cross edge → runway (Pause) → reach wall (Live) → click → runway (Pause) → click → pause (Play)", () => {
      const now = Date.now();
      const dataEdge = now - 1000;
      const map = makeMap({
        liveFollow: false,
        playing: true,
        playhead: dataEdge - 1000,
        dataEdge,
        minMs: now - 600000,
        speed: 1.0,
      });
      const ps = new PlaybackState(map);
      ps.serverNextUpdateTs = now + 120000;

      // Step 1: Playing before data edge → Pause
      assert.deepEqual(ps.buttonState(), { text: "Pause", glow: false }, "Step 1");

      // Step 2: Cross data edge → enter runway (liveFollow=true) → still Pause
      map._playbackNowMs = dataEdge + 100;
      map._playbackLiveFollow = true; // loop sets this
      assert.deepEqual(ps.buttonState(), { text: "Pause", glow: false }, "Step 2: runway = Pause");

      // Step 3: Reach wall → liveFollow off → Live glow
      map._playbackNowMs = now;
      map._playbackLiveFollow = false; // loop turns off at wall
      assert.deepEqual(ps.buttonState(), { text: "Live", glow: true }, "Step 3: at wall = Live glow");

      // Step 4: Click Live → snap to runway (liveFollow=true, playhead back)
      map._playbackLiveFollow = true;
      ps.snapToRunway(1.0);
      assert.ok(!ps.atWallEdge(), "Step 4: not at wall after snap");
      assert.deepEqual(ps.buttonState(), { text: "Pause", glow: false }, "Step 4: runway = Pause");

      // Step 5: Click Pause → stop + clear liveFollow
      map._playing = false;
      map._playbackLiveFollow = false; // click handler clears liveFollow on Pause
      assert.deepEqual(ps.buttonState(), { text: "Play", glow: false }, "Step 5: paused = Play");

      // Step 6: Click Play → resume
      map._playing = true;
      assert.deepEqual(ps.buttonState(), { text: "Pause", glow: false }, "Step 6: playing = Pause");
    });
  });
});
