const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const PlaybackState = require("../playback_state.js");

// Minimal MapView stub
function makeMap(overrides = {}) {
  return {
    _playbackMaxMs: overrides.dataEdge ?? 1000000,
    _playbackMinMs: overrides.minMs ?? 0,
    _playbackNowMs: overrides.playhead ?? 500000,
    _playbackLiveFollow: overrides.liveFollow ?? false,
    _historicalMode: overrides.historical ?? false,
    _playbackSpeed: overrides.speed ?? 1.0,
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
    getPlaybackPlaying() { return overrides.playing ?? false; },
  };
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
    it("returns Live+glow when liveFollow and at wall edge", () => {
      const map = makeMap({ liveFollow: true, playhead: Date.now() });
      const ps = new PlaybackState(map);
      const bs = ps.buttonState();
      assert.equal(bs.text, "Live");
      assert.equal(bs.glow, true);
    });

    it("returns Pause when liveFollow but in runway (not at wall edge)", () => {
      const now = Date.now();
      const map = makeMap({ liveFollow: true, playing: true, playhead: now - 5000, dataEdge: now - 2000 });
      const ps = new PlaybackState(map);
      const bs = ps.buttonState();
      assert.equal(bs.text, "Pause");
      assert.equal(bs.glow, false);
    });

    it("returns Live (no glow) when paused past data edge", () => {
      const now = Date.now();
      const map = makeMap({ liveFollow: false, playing: false, playhead: now - 100, dataEdge: now - 200 });
      const ps = new PlaybackState(map);
      const bs = ps.buttonState();
      assert.equal(bs.text, "Live");
      assert.equal(bs.glow, false);
    });

    it("returns Play when paused behind data edge", () => {
      const now = Date.now();
      const map = makeMap({ liveFollow: false, playing: false, playhead: now - 60000, dataEdge: now });
      const ps = new PlaybackState(map);
      const bs = ps.buttonState();
      assert.equal(bs.text, "Play");
      assert.equal(bs.glow, false);
    });

    it("returns Pause when playing (not live)", () => {
      const now = Date.now();
      const map = makeMap({ liveFollow: false, playing: true, playhead: now - 60000, dataEdge: now });
      const ps = new PlaybackState(map);
      const bs = ps.buttonState();
      assert.equal(bs.text, "Pause");
      assert.equal(bs.glow, false);
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
    // Should be dataEdge - 120000
    assert.ok(t < now, "Playhead should be before data edge");
    assert.ok(t > now - 200000, "Playhead should be reasonably close to data edge");
  });

  it("onSSEMessage extracts predicted_next_update_ts", () => {
    const map = makeMap();
    const ps = new PlaybackState(map);
    ps.onSSEMessage({ seq: 1, ts: 1234567890, predicted_next_update_ts: 1234568000 });
    assert.equal(ps.serverNextUpdateTs, 1234568000 * 1000); // converted to ms
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
    assert.equal(ps.consumeDeferredCameraFit(), null); // consumed
  });
});
