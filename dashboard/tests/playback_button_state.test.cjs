/**
 * Tests for PlaybackUI.computeButtonState — the Live/Play/Pause state machine.
 *
 * Contract (server-sync mode + wall-edge, 2026-07):
 *   - AT the wall-clock edge (riding NOW) → "Live" LIT at ANY speed: pinned to
 *     now is real time whatever the speed setting.
 *   - Server-sync CATCH-UP (liveFollow but behind the edge, playing the
 *     runway) → LIT; "Live" only at 1x, lit "Pause" above 1x (faster than real
 *     time, keeping up with the server but not live yet).
 *   - Playing but not synced (in the past) → "Pause" unlit.
 *   - Paused → "Play" unlit.
 *   - Historical snapshots: plain Play/Pause transport, never lit.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const PlaybackUI = require("../ui_playback.js");
const compute = PlaybackUI.computeButtonState;

describe("computeButtonState — at the wall-clock edge = Live at any speed", () => {
  it("riding the wall edge → lit 'Live' at EVERY speed", () => {
    for (const speed of [1, 2, 5, 10, 60]) {
      assert.deepEqual(
        compute({ historical: false, playing: true, liveFollow: true, atWallEdge: true, speed }),
        { label: "Live", lit: true }, `speed ${speed}x at the wall edge`);
    }
  });
  it("at the wall edge via forward play before liveFollow is set → still Live", () => {
    assert.deepEqual(
      compute({ historical: false, playing: true, liveFollow: false, atWallEdge: true, speed: 10 }),
      { label: "Live", lit: true });
  });
});

describe("computeButtonState — server-sync catch-up (behind the edge)", () => {
  it("catch-up at 1x → lit 'Live'", () => {
    assert.deepEqual(
      compute({ historical: false, playing: true, liveFollow: true, atWallEdge: false, speed: 1 }),
      { label: "Live", lit: true });
  });
  it("catch-up above 1x → lit 'Pause' (keeping up, not real time yet)", () => {
    for (const speed of [2, 5, 10, 60]) {
      assert.deepEqual(
        compute({ historical: false, playing: true, liveFollow: true, atWallEdge: false, speed }),
        { label: "Pause", lit: true }, `catch-up ${speed}x`);
    }
  });
});

describe("computeButtonState — not synced", () => {
  it("playing in the past (not liveFollow, not at edge) → unlit 'Pause'", () => {
    for (const speed of [1, 5, 60]) {
      assert.deepEqual(
        compute({ historical: false, playing: true, liveFollow: false, atWallEdge: false, speed }),
        { label: "Pause", lit: false }, `speed ${speed}x`);
    }
  });
  it("paused → unlit 'Play'", () => {
    assert.deepEqual(
      compute({ historical: false, playing: false, liveFollow: false, atWallEdge: false, speed: 5 }),
      { label: "Play", lit: false });
  });
});

describe("computeButtonState — historical snapshots (never lit)", () => {
  it("playing → Pause, never lit (even at the data end)", () => {
    assert.deepEqual(
      compute({ historical: true, playing: true, liveFollow: false, atWallEdge: true, speed: 1 }),
      { label: "Pause", lit: false });
  });
  it("paused → Play, never lit", () => {
    assert.deepEqual(
      compute({ historical: true, playing: false, liveFollow: false, atWallEdge: false, speed: 1 }),
      { label: "Play", lit: false });
  });
});
