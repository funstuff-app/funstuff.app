/**
 * Tests for PlaybackUI.computeButtonState — the Live/Play/Pause state machine.
 *
 * Contract (playback rework, 2026-07):
 *   - "Live" (lit) ONLY when active at the wall-clock edge at 1x. Faster than
 *     real time is not "Live" even when keeping up with the server.
 *   - Riding the edge at >1x → "Pause" LIT: the glow still hints in-sync with
 *     the server, the label is honest about what clicking does.
 *   - Active behind the edge (catching up / replaying) → "Pause" unlit.
 *   - Paused → "Play" unlit. There is no paused-at-the-edge state: the edge
 *     ticks with wall time and a paused view falls behind it.
 *   - Historical snapshots: plain Play/Pause transport, never lit.
 *   - "active" means playing OR live-following (riding the edge counts).
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const PlaybackUI = require("../ui_playback.js");
const compute = PlaybackUI.computeButtonState;

describe("computeButtonState — live view", () => {
  it("Live lit at the edge at 1x (playing)", () => {
    assert.deepEqual(
      compute({ historical: false, playing: true, liveFollow: false, atEnd: true, speed: 1 }),
      { label: "Live", lit: true });
  });

  it("Live lit at the edge at 1x (live-follow flag, not playing)", () => {
    assert.deepEqual(
      compute({ historical: false, playing: false, liveFollow: true, atEnd: true, speed: 1 }),
      { label: "Live", lit: true });
  });

  it("riding the edge above 1x is lit Pause, not Live", () => {
    for (const speed of [2, 5, 10, 60]) {
      assert.deepEqual(
        compute({ historical: false, playing: true, liveFollow: false, atEnd: true, speed }),
        { label: "Pause", lit: true }, `speed ${speed}x`);
    }
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
  it("playing → Pause, never lit (even at the end at 1x)", () => {
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
