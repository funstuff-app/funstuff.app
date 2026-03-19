/**
 * playback_state.js — Single source of truth for playback / LIVE mode state.
 *
 * Consolidates the duplicated runway, live-window, and button-state calculations
 * that were scattered across app.js (updatePlaybackUi, playbackLoop, click
 * handler, speed handler, visibilitychange handler, tick).
 *
 * Concepts:
 *   dataEdgeMs   — newest trail timestamp from the server (_playbackMaxMs)
 *   wallEdgeMs   — Date.now()  (returned by getPlaybackBounds().maxMs in live)
 *   runwayMs     — predicted time between dataEdge and the next server poll
 *   runwayStart  — dataEdge − runwayMs  (where playback snaps on LIVE enter)
 *
 *   "Live glow"  — playhead ≥ dataEdge (past all server data, at wall clock)
 *   "Runway"     — playhead is between runwayStart and dataEdge, catching up
 */
(function (root, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else {
    root.PlaybackState = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ── Helpers ──────────────────────────────────────────────────────────────

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // ── Constructor ──────────────────────────────────────────────────────────

  /**
   * @param {object} map  — MapView instance (reads playback accessors)
   */
  function PlaybackState(map) {
    this.map = map;

    // Wall-clock ms (Date.now) when last /state response arrived.
    this.lastServerResponseMs = Date.now();

    // Absolute Unix-ms when the server predicts its next upstream data change.
    // Updated from SSE messages; falls back to meta fields from /state.
    this.serverNextUpdateTs = null;

    // LIVE buffer tracking (perf.now timeline).
    this._liveStartWallMs  = null;   // performance.now() when LIVE entered
    this._liveStartDataMs  = null;   // dataEdge at LIVE entry
    this._liveTargetMs     = null;   // computed target each frame
    this._liveStallCount   = 0;
    this._deferredCameraFit = null;
  }

  // ── Core queries (DRY replacements) ─────────────────────────────────────

  /** Data edge: newest server data timestamp (not wall-extended). */
  PlaybackState.prototype.dataEdgeMs = function () {
    return this.map._playbackMaxMs;
  };

  /** Wall edge: current wall-clock time. */
  PlaybackState.prototype.wallEdgeMs = function () {
    return Date.now();
  };

  /**
   * Predicted seconds until the server's next upstream data change.
   * Single implementation replacing 6+ duplicated runway calculations.
   */
  PlaybackState.prototype.predictedRemainingSec = function () {
    // Prefer absolute timestamp from SSE (most current).
    if (this.serverNextUpdateTs != null) {
      var rem = (this.serverNextUpdateTs - Date.now()) / 1000;
      return Math.max(0, rem);
    }
    // Fall back to relative fields from last /state response.
    var meta = this.map.lastState && this.map.lastState.meta;
    var nextInS = _metaPollSec(meta);
    var elapsed = (Date.now() - this.lastServerResponseMs) / 1000;
    return Math.max(0, nextInS - elapsed);
  };

  /**
   * Runway duration in map-time ms at the given speed multiplier.
   * This is how far behind the data edge the playhead should start
   * so it "catches up" right as the server polls.
   */
  PlaybackState.prototype.runwayMs = function (speed) {
    speed = speed || this.map.getPlaybackSpeed() || 1.0;
    return this.predictedRemainingSec() * 1000 * speed;
  };

  /**
   * The map-time ms where a LIVE-mode playhead should snap to when entering
   * runway.  Returns a value ≤ dataEdge.
   */
  PlaybackState.prototype.runwayStartMs = function (speed) {
    var de = this.dataEdgeMs();
    if (de == null || !isFinite(de)) return null;
    var b = this.map.getPlaybackBounds();
    return Math.max(b.minMs, de - this.runwayMs(speed));
  };

  // ── Playhead position classification ────────────────────────────────────

  /** True when the playhead is at or beyond the data edge (in the "future"). */
  PlaybackState.prototype.pastDataEdge = function () {
    var tMs = this.map.getPlaybackTimeMs();
    var de  = this.dataEdgeMs();
    return tMs != null && de != null && isFinite(tMs) && isFinite(de) && tMs >= de - 500;
  };

  /** True when the playhead is within 500 ms of wall-clock now. */
  PlaybackState.prototype.atWallEdge = function () {
    var tMs = this.map.getPlaybackTimeMs();
    return tMs != null && isFinite(tMs) && Math.abs(Date.now() - tMs) <= 500;
  };

  /** True when playhead is in the runway zone (past runway start, before data edge). */
  PlaybackState.prototype.inRunway = function () {
    if (this.map._historicalMode) return false;
    var tMs = this.map.getPlaybackTimeMs();
    var de  = this.dataEdgeMs();
    if (tMs == null || de == null || !isFinite(tMs) || !isFinite(de)) return false;
    var rs = this.runwayStartMs();
    return rs != null && tMs >= rs && tMs < de - 500;
  };

  /** True when in "Live glow" state: playhead at wall clock. */
  PlaybackState.prototype.inLiveGlow = function () {
    return !this.map._historicalMode && this.atWallEdge();
  };

  /**
   * Whether the click handler should enter runway catch-up mode.
   * True when: past data edge, not already in liveFollow, not historical.
   */
  PlaybackState.prototype.shouldEnterLive = function () {
    var m = this.map;
    return !m._playbackLiveFollow
      && !m._historicalMode
      && this.pastDataEdge();
  };

  /**
   * Determine the text and glow state for the play/pause/live button.
   *
   *   "Live"  + glow  → playhead at wall clock (atWallEdge)
   *   "Pause"         → playing (including runway catch-up)
   *   "Play"          → paused
   */
  PlaybackState.prototype.buttonState = function () {
    var m = this.map;
    if (m._historicalMode) {
      return m.getPlaybackPlaying()
        ? { text: "Pause", glow: false }
        : { text: "Play",  glow: false };
    }
    var result;
    // Live glow: playhead is at wall clock time. Not liveFollow (that's runway).
    if (this.atWallEdge()) {
      result = { text: "Live", glow: true };
    } else if (m.getPlaybackPlaying()) {
      result = { text: "Pause", glow: false };
    } else {
      result = { text: "Play", glow: false };
    }
    if (this._lastBtnText !== result.text) {
      console.log('[PS] buttonState %s → %s (liveFollow=%s atWall=%s playing=%s)', this._lastBtnText || '(init)', result.text, m._playbackLiveFollow, this.atWallEdge(), m.getPlaybackPlaying());
      this._lastBtnText = result.text;
    }
    return result;
  };

  // ── LIVE buffer helpers ─────────────────────────────────────────────────

  PlaybackState.prototype.resetLiveTracking = function () {
    this._liveStartWallMs  = null;
    this._liveStartDataMs  = null;
    this._liveStallCount   = 0;
    this._deferredCameraFit = null;
  };

  /**
   * Called each frame from the playback loop when _playbackLiveFollow is true.
   * Returns { liveBufferMs, liveTargetMs }.
   */
  PlaybackState.prototype.updateLiveBuffer = function (perfNow) {
    var b  = this.map.getPlaybackBounds();
    var tMs = this.map.getPlaybackTimeMs();

    if (tMs == null || !isFinite(tMs)) {
      var rs = this.runwayStartMs();
      if (rs != null) { this.map.setPlaybackTimeMs(rs); tMs = rs; }
    }
    if (this._liveStartWallMs == null) {
      this._liveStartWallMs = perfNow;
      this._liveStartDataMs = this.dataEdgeMs();
    }
    var wallElapsed = perfNow - this._liveStartWallMs;
    var bufferMs    = wallElapsed;
    var de = this.dataEdgeMs() || b.maxMs;
    this._liveTargetMs = Math.max(b.minMs, de - bufferMs);
    return { liveBufferMs: bufferMs, liveTargetMs: this._liveTargetMs };
  };

  /**
   * Snap the playhead to the runway start after a background-tab return or
   * when entering LIVE mode.  Returns the new playhead time.
   */
  PlaybackState.prototype.snapToRunway = function (speed) {
    var rs = this.runwayStartMs(speed);
    if (rs == null) return null;
    this.map.setPlaybackTimeMs(rs);
    this._liveStartWallMs = performance.now();
    this._liveStartDataMs = this.dataEdgeMs();
    return rs;
  };

  /**
   * Snap the playhead to wall-clock now (for "Live glow" state).
   */
  PlaybackState.prototype.snapToWallEdge = function () {
    this.map.setPlaybackTimeMs(Date.now());
  };

  // ── SSE integration ─────────────────────────────────────────────────────

  /**
   * Ingest an SSE message object.  Extracts `predicted_next_update_ts` if
   * present (absolute Unix seconds from the server).
   */
  PlaybackState.prototype.onSSEMessage = function (msg) {
    if (msg && typeof msg.predicted_next_update_ts === "number") {
      this.serverNextUpdateTs = msg.predicted_next_update_ts * 1000; // → ms
    }
  };

  /**
   * Call after a successful /state fetch completes.
   */
  PlaybackState.prototype.onServerResponse = function () {
    this.lastServerResponseMs = Date.now();
  };

  // ── Deferred camera fit ─────────────────────────────────────────────────

  PlaybackState.prototype.deferCameraFit = function (fit) {
    this._deferredCameraFit = fit;
  };

  PlaybackState.prototype.consumeDeferredCameraFit = function () {
    var f = this._deferredCameraFit;
    this._deferredCameraFit = null;
    return f;
  };

  // ── Private helpers ─────────────────────────────────────────────────────

  function _metaPollSec(meta) {
    if (!meta) return 600;
    var a = Number(meta.polling_next_update_in_s);
    if (isFinite(a)) return a;
    var b = Number(meta.polling_predicted_interval_s);
    if (isFinite(b)) return b;
    return 600;
  }

  return PlaybackState;
});
