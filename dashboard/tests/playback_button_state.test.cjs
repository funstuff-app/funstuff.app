/**
 * Tests for PlaybackUI.computeButtonState — the Live/Play/Pause state machine.
 *
 * Contract (playback rework, 2026-07, revised):
 *   - "Live" (lit) whenever active AT the wall-clock edge — at ANY speed. At
 *     the edge every speed rides wall rate, so it is live regardless of the
 *     speed setting; the setting only matters behind the edge, where only 1x
 *     is functionally real-time.
 *   - Active behind the edge (catching up / replaying) → "Pause" unlit.
 *   - Paused → "Play" unlit. There is no paused-at-the-edge state: the edge
 *     ticks with wall time and any pause is stepped back behind the live
 *     window (see playback_loop_behavior.test.cjs).
 *   - Historical snapshots: plain Play/Pause transport, never lit.
 *   - "active" means playing OR live-following (riding the edge counts).
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const PlaybackUI = require("../ui_playback.js");
const compute = PlaybackUI.computeButtonState;

describe("computeButtonState — live view", () => {
  it("Live lit at the edge at EVERY speed (playing)", () => {
    for (const speed of [1, 2, 5, 10, 60]) {
      assert.deepEqual(
        compute({ historical: false, playing: true, liveFollow: false, atEnd: true, speed }),
        { label: "Live", lit: true }, `speed ${speed}x`);
    }
  });

  it("Live lit at the edge via the live-follow flag (not playing)", () => {
    assert.deepEqual(
      compute({ historical: false, playing: false, liveFollow: true, atEnd: true, speed: 5 }),
      { label: "Live", lit: true });
  });

  it("catching up behind the edge is unlit Pause at any speed", () => {
    for (const speed of [1, 5, 60]) {
      assert.deepEqual(
        compute({ historical: false, playing: true, liveFollow: false, atEnd: false, speed }),
        { label: "Pause", lit: false }, `speed ${speed}x`);
    }
  });

  it("paused shows Play, unlit, regardless of position or speed", () => {
    for (const atEnd of [true, false]) {
      for (const speed of [1, 5]) {
        assert.deepEqual(
          compute({ historical: false, playing: false, liveFollow: false, atEnd, speed }),
          { label: "Play", lit: false }, `atEnd=${atEnd} speed=${speed}`);
      }
    }
  });
});

describe("computeButtonState — historical snapshots", () => {
  it("playing → Pause, never lit (even at the end)", () => {
    assert.deepEqual(
      compute({ historical: true, playing: true, liveFollow: false, atEnd: true, speed: 1 }),
      { label: "Pause", lit: false });
  });

  it("paused → Play, never lit", () => {
    assert.deepEqual(
      compute({ historical: true, playing: false, liveFollow: false, atEnd: false, speed: 1 }),
      { label: "Play", lit: false });
  });
});
