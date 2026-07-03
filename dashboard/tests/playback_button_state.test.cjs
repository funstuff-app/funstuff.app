/**
 * Tests for PlaybackUI.computeButtonState — the Live/Play/Pause state machine.
 *
 * Contract (server-sync mode, 2026-07):
 *   - LIT = server-sync mode (liveFollow): tracking the live edge / server
 *     poll cadence, at ANY speed. Labelled "Live" only at 1x (functionally
 *     real time); above 1x it is a LIT "Pause" (keeping up with the server,
 *     but faster than real time is not "Live").
 *   - Playing but NOT synced (in the past) → "Pause" unlit.
 *   - Paused → "Play" unlit.
 *   - Historical snapshots: plain Play/Pause transport, never lit.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const PlaybackUI = require("../ui_playback.js");
const compute = PlaybackUI.computeButtonState;

describe("computeButtonState — server-sync mode is LIT", () => {
  it("server-sync at 1x → lit 'Live'", () => {
    assert.deepEqual(
      compute({ historical: false, playing: true, liveFollow: true, speed: 1 }),
      { label: "Live", lit: true });
    // live-follow flag alone (loop hasn't set playing yet) still lit Live at 1x
    assert.deepEqual(
      compute({ historical: false, playing: false, liveFollow: true, speed: 1 }),
      { label: "Live", lit: true });
  });

  it("server-sync above 1x → lit 'Pause' (keeping up, but not real time)", () => {
    for (const speed of [2, 5, 10, 60]) {
      assert.deepEqual(
        compute({ historical: false, playing: true, liveFollow: true, speed }),
        { label: "Pause", lit: true }, `speed ${speed}x`);
    }
  });

  it("playing but NOT synced (in the past) → unlit 'Pause' at any speed", () => {
    for (const speed of [1, 5, 60]) {
      assert.deepEqual(
        compute({ historical: false, playing: true, liveFollow: false, speed }),
        { label: "Pause", lit: false }, `speed ${speed}x`);
    }
  });

  it("paused → unlit 'Play' at any speed", () => {
    for (const speed of [1, 5]) {
      assert.deepEqual(
        compute({ historical: false, playing: false, liveFollow: false, speed }),
        { label: "Play", lit: false }, `speed ${speed}`);
    }
  });
});

describe("computeButtonState — historical snapshots (never lit)", () => {
  it("playing → Pause, never lit", () => {
    assert.deepEqual(
      compute({ historical: true, playing: true, liveFollow: false, speed: 1 }),
      { label: "Pause", lit: false });
  });

  it("paused → Play, never lit", () => {
    assert.deepEqual(
      compute({ historical: true, playing: false, liveFollow: false, speed: 1 }),
      { label: "Play", lit: false });
  });
});
