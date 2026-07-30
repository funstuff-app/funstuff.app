/**
 * ui_playback.js — playback transport UI: slider/scrub, paging, the physics
 * playback loop, LIVE-mode buffer tracking, and the A/B barrel jog wheel.
 *
 * Extracted from app.js main().  Owns the playback DOM refs (pbScrub / pbPlay /
 * pbLeft / pbNow / pbRight / page arrows / barrel jog elements), the physics
 * and paging constants, and the scalars used ONLY by the moved functions
 * (_barrelMode, _jogWheel, _scrubRAF).  The mutable playback scalars live in
 * the shared `pb` object (landed by A4a) which is passed in BY REFERENCE:
 * out-of-scope handlers still in main() (pbPlay click, pbSpeed change,
 * pbScrub pointer/touch/wheel listeners, page prev/next, visibilitychange,
 * DVR trace toggle, screensaver) keep mutating the same `pb` object — that is
 * the design, so `pb` is recorded as shared state, not owned here.
 *
 * main() constructs one instance and keeps thin one-line delegate functions at
 * the original names (updatePlaybackUi, playbackLoop, _pbGetPageRange, …) so
 * the ~200 call sites in main() and the barrel jog closures are untouched.
 *
 * Cross-module wiring preserved: map._resetLiveTracking and
 * window.__ensurePlaybackLoop are still assigned in main() (they are consumed
 * by engine_camera_gestures.js / engine_playback_engine.js).
 */
(function (root, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else {
    root.PlaybackUI = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const g = (typeof window !== "undefined") ? window : globalThis;

  function clamp(n, lo, hi) { return g.clamp ? g.clamp(n, lo, hi) : Math.max(lo, Math.min(hi, n)); }

  const PlaybackUI = {};

  /**
   * Pure transport-button state derivation — the single place the
   * Live/Play/Pause semantics live:
   *
   *   live view, active, at the wall-clock edge → "Live" (lit) at ANY speed —
   *       at the edge every speed rides wall rate, so it is live regardless
   *       of the speed setting (the setting only matters behind the edge,
   *       where only 1x is functionally real-time)
   *   active anywhere behind the edge           → "Pause" (unlit)
   *   paused                                    → "Play"  (unlit)
   *   historical snapshots                      → plain Play/Pause, never lit
   *
   * "active" means playing OR live-following (riding the edge counts).
   * `lit` is the .isLive glow.
   */
  /**
   * What a click on the transport button does. In server-sync mode (the lit
   * button — liveFollow) clicking RE-SYNCS to the server-polling runway point
   * (see computeRunwayTargetMs); it never pauses there. Outside that mode it
   * is a plain play/pause.
   *   liveFollow (server-sync, lit) → "sync"   (jump to runway point)
   *   playing, not synced (past)    → "pause"
   *   paused                        → "play"
   */
  PlaybackUI.computeClickAction = function ({ playing, liveFollow }) {
    if (liveFollow) return "sync";
    if (playing) return "pause";
    return "play";
  };

  /**
   * The server-polling runway/sync point: back off from the data edge by the
   * runway (predicted seconds until the next poll × playback speed), so
   * playing forward from here reaches the data edge right as the next poll
   * extends it — continuous playback. Clamped to minMs. Only the explicit
   * Live click uses this; new data arriving and drift catch-up never snap.
   *   remSec — seconds until the next server poll (server's planned time,
   *            corrected for wall time already elapsed since it was sent)
   */
  PlaybackUI.computeRunwayTargetMs = function ({ dataEdgeMs, minMs, remSec, speed }) {
    const s = (isFinite(speed) && speed > 0) ? speed : 1.0;
    const rem = (isFinite(remSec) && remSec > 0) ? remSec : 0;
    const runwayMs = rem * 1000 * s;
    const target = dataEdgeMs - runwayMs;
    return (isFinite(minMs) && target < minMs) ? minMs : target;
  };

  PlaybackUI.computeButtonState = function ({ historical, playing, liveFollow, atWallEdge, speed }) {
    const active = !!playing || !!liveFollow;
    if (historical) return { label: active ? "Pause" : "Play", lit: false };
    // AT the wall-clock edge = pinned to NOW = real time, whatever the speed
    // setting (the ride block moves at wall rate there) → "Live" at ANY speed.
    if (active && atWallEdge) return { label: "Live", lit: true };
    // Server-sync CATCH-UP (liveFollow but behind the edge, playing the
    // runway): LIT — keeping up with the server cadence. "Live" only at 1x;
    // above 1x it is a lit "Pause" (faster than real time, not live yet).
    if (liveFollow) return (speed === 1) ? { label: "Live", lit: true } : { label: "Pause", lit: true };
    if (active) return { label: "Pause", lit: false };   // playing in the past, not synced
    return { label: "Play", lit: false };
  };

  /**
   * @param {object} cfg
   *   map        — MapView instance
   *   document   — DOM document
   *   pb         — shared playback state object (BY REFERENCE; A4a)
   *   deps       — callbacks/getters into main() for shared state that stays
   *                there:
   *     getScreensaverActive()      — read _screensaverActive
   *     getSidebarOpen()            — read sidebarOpen
   *     getSelectedId()             — read selectedId
   *     getBarrelMode()             — read _barrelMode (module owns it; exposed
   *                                    so playbackLoop's barrel sync reads it)
   *     performCameraFit(opts)      — main()._performCameraFit
   *     animateFitBoundsLatLon(bb,opts) — main()._animateFitBoundsLatLon
   *     animateToStoredView(ms)     — main()._animateToStoredView
   *     syncMapPollutant()          — main()._syncMapPollutant
   *     syncLegendToMapSelection()  — main().syncLegendToMapSelection
   *     updateSidebarPlaybackValues() — main().updateSidebarPlaybackValues
   */
  PlaybackUI.create = function (cfg) {
    cfg = cfg || {};
    const map = cfg.map;
    const document = cfg.document;
    const pb = cfg.pb;
    const deps = cfg.deps || {};

    const LIVE_MODE_STORAGE_KEY = g.LIVE_MODE_STORAGE_KEY;

    // ── DOM refs ─────────────────────────────────────────────────────────────
    const pbPlayEl = document.getElementById("pbPlay");
    const pbScrubEl = document.getElementById("pbScrub");
    const pbSpeedEl = document.getElementById("pbSpeed");
    const pbLeftEl = document.getElementById("pbLeft");
    const pbNowEl = document.getElementById("pbNow");
    const pbRightEl = document.getElementById("pbRight");
    const pbPagePrevEl = document.getElementById("pbPagePrev");
    const pbPageNextEl = document.getElementById("pbPageNext");
    const pbPausedShadeEl = document.getElementById("pbPausedShade");
    const pbRewBadgeEl = document.getElementById("pbRewBadge");

    // ── A/B Barrel Jog Wheel ────────────────────────────────────────────────
    const pbJogWheelEl    = document.getElementById("pbJogWheel");
    const pbJogBarrelEl   = document.getElementById("pbJogBarrel");
    const pbBarrelClipEl  = document.getElementById("pbBarrelClip");
    const pbBarrelCanvas  = document.getElementById("pbBarrelCanvas");
    const pbBarrelToggle  = document.getElementById("pbBarrelToggle");
    let _jogWheel = null;          // JogWheel instance (created on first enable)
    let _barrelMode = false;       // current A/B state
    const _BARREL_STORAGE_KEY = "mobileair.barrelJogWheel";

    // Coalescing rAF flag for scrub renders — shared with the pbScrub pointer/
    // touch listeners that stay in main(); exposed via getScrubRAF/setScrubRAF.
    let _scrubRAF = 0;

    function _setBarrelMode(on) {
      return; // SHUNT: barrel feature bypassed — restore by removing this line
      _barrelMode = on;
      if (pbJogWheelEl) pbJogWheelEl.classList.toggle("hidden", on);
      if (pbJogBarrelEl) pbJogBarrelEl.classList.toggle("hidden", !on);
      if (pbBarrelToggle) pbBarrelToggle.checked = on;
      try { localStorage.setItem(_BARREL_STORAGE_KEY, on ? "1" : "0"); } catch {}

      if (on && !_jogWheel && pbJogBarrelEl && pbBarrelClipEl && pbBarrelCanvas && typeof JogWheel !== "undefined") {
        _jogWheel = JogWheel.create({
          wrapEl: pbJogBarrelEl,
          clipEl: pbBarrelClipEl,
          canvasEl: pbBarrelCanvas,
          onWheel(delta) {
            // Same physics as classic wheel handler on pbScrubEl
            pb._pbAtEndSincePerf = null;
            pb._pbArrivedAtEndViaPlayback = false;
            pb._pbIsRewinding = false;
            pb._pbPageAutoFollow = true;
            map.setPlaybackPlaying(false);
            map._playbackLiveFollow = false;
            try { localStorage.setItem(LIVE_MODE_STORAGE_KEY, "0"); } catch {}
            pb._pbIsWheelCoasting = true;
            pb._pbCommitLoopStartOnCoastEnd = true;
            if (_pbPagingActive() && pb._pbSlidingWindowCenter == null) {
              const pr = _pbGetPageRange();
              pb._pbSlidingWindowCenter = (pr.minMs + pr.maxMs) / 2;
            }
            const b = map.getPlaybackBounds();
            const durMs = (b.maxMs - b.minMs) || 1;
            const nudgeDur = Math.min(durMs, 21600000); // cap at 6h so scroll speed is consistent
            const nudge = (delta / 1000) * (nudgeDur / 480);
            const prevDir = Math.sign(pb._pbVelocity);
            pb._pbVelocity -= nudge;
            if (prevDir !== 0 && Math.sign(pb._pbVelocity) !== 0 && Math.sign(pb._pbVelocity) !== prevDir) {
              _pbSnapWindowToPlayhead();
              updatePlaybackUi();
            }
            if (!pb._pbRAF) {
              pb._pbLastPerf = performance.now();
              pb._pbRAF = requestAnimationFrame(playbackLoop);
            }
          },
          onDragStart() {
            // Same cancel-all-physics as classic pointerdown
            pb._pbVelocity = 0;
            pb._pbWheelAccum = 0;
            pb._pbPaused = false;
            pb._pbAtEndSincePerf = null;
            pb._pbArrivedAtEndViaPlayback = false;
            pb._pbIsRewinding = false;
            pb._pbEaseStartPerf = null;
            pb._pbIsWheelCoasting = false;
            pb._pbScrubbing = true;
            map._scrubbing = true;
            pb._pbDidDrag = false;
            map.setPlaybackPlaying(false);
            map._playbackLiveFollow = false;
            try { localStorage.setItem(LIVE_MODE_STORAGE_KEY, "0"); } catch {}
            _resetLiveTracking();
            if (_pbPagingActive() && pb._pbSlidingWindowCenter == null) {
              const pr = _pbGetPageRange();
              pb._pbSlidingWindowCenter = (pr.minMs + pr.maxMs) / 2;
            }
            updatePlaybackUi();
          },
          onPositionChange(deltaFrac) {
            // deltaFrac is already gear-reduced (dx / (width*8))
            // Map to timeline ms and apply
            pb._pbDidDrag = true;
            const b = map.getPlaybackBounds();
            const pr = _pbPagingActive() ? _pbGetPageRange() : b;
            const durMs = (pr.maxMs - pr.minMs) || 1;
            const tMs = map.getPlaybackTimeMs() || pr.minMs;
            // Live view: drags clamp to the DATA edge — no parking in the
            // dataless wall-extension zone (same rule as applyScrub).
            const jogEdge = (!map._historicalMode
              && map._playbackMaxMs != null && isFinite(map._playbackMaxMs))
              ? Math.min(pr.maxMs, map._playbackMaxMs) : pr.maxMs;
            const newT = clamp(tMs + deltaFrac * durMs, pr.minMs, jogEdge);
            map.setPlaybackTimeMs(newT);
            map.setPlaybackPlaying(false);
            // Coalesce render
            if (!_scrubRAF) {
              _scrubRAF = requestAnimationFrame(() => {
                _scrubRAF = 0;
                map.drawOverlay(map.lastState);
                updatePlaybackUi();
              });
            }
          },
          onDragEnd(vel) {
            _pbSnapWindowToPlayhead();
            pb._pbScrubbing = false;
            map._scrubbing = false;
            // Convert barrel velocity to timeline velocity for inertial coasting
            const b = map.getPlaybackBounds();
            const pr = _pbPagingActive() ? _pbGetPageRange() : b;
            const durMs = (pr.maxMs - pr.minMs) || 1;
            pb._pbVelocity = (vel * durMs) / 16;
            pb._pbIsWheelCoasting = false;
            pb._pbPageAutoFollow = true;
            map.setPlaybackPlaying(true);
            pb._pbLastPerf = performance.now();
            if (!pb._pbRAF) pb._pbRAF = requestAnimationFrame(playbackLoop);
          }
        });
      }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // PHYSICS-BASED PLAYBACK: Everything is driven by velocity and forces.
    // No state flags for "rewind" - just physics simulation.
    // ─────────────────────────────────────────────────────────────────────────────

    // Velocity in "playback ms per wall ms" (1.0 = real-time forward, -15 = fast rewind)

    // Track when we hit the end and are waiting for vehicles to physically reach the
    // end of their paths (no fixed pause; rewind triggers when vehicles are done).

    // Track when ease-in phase started (for wall-time-based easing)

    // Flag to track active rewind (not based on velocity)

    // Replay loop start ("point A"): where playback started / where the user last left the playhead.
    // Auto-rewind returns here instead of rewinding to the global min bound.

    // Track data bounds to detect new data / trimmed data

    // Wall-clock ms (Date.now) when last server response arrived

    // Server can bump this to force LIVE camera follow even if data timestamps are unchanged.

    // ─────────────────────────────────────────────────────────────────────────────
    // LIVE BUFFER: Track wall-clock time since app started to know how much data we have.
    // Buffer = time since first data arrival. Playback replays this accumulated buffer.
    // ─────────────────────────────────────────────────────────────────────────────
    const _pbLiveStallThreshold = 3;      // stalls before auto-rewind in LIVE mode

    // Helper to reset LIVE tracking (call when exiting LIVE mode)
    // Exposed on map object so class methods can call it
    function _resetLiveTracking() {
      pb._pbLiveStartWallMs = null;
      pb._pbLiveStartDataMs = null;
      pb._pbLiveStallCount = 0;
      pb._deferredCameraFit = null;
    }

    // LIVE camera follow: smooth pan/zoom to fit moving vehicles
    const _pbLiveFollowDurationMs = 2000; // animation duration for camera follow (slow, smooth)
    const _pbLiveFollowPadding = 0.15;    // extra padding around bounds (15%)

    // Deferred camera fit: when new data arrives while the user is panning/zooming
    // (or during post-interaction easing), we stash the intended camera fit here.
    // The playback loop drains it once _canRunAutoCamera() returns true.

    // Minimum geographic extent (in degrees) for bounds to be considered "meaningful" movement.
    // ~0.002° lat ≈ 220m. Below this the vehicles are just jittering in place (depot, parking lot).
    const _pbMinBoundsExtentDeg = 0.002;

    // Physics constants
    const _pbPlaybackSpeed = 1.0;       // target velocity when playing forward
    const _pbRewindSpeed = -100.0;      // target velocity when rewinding (negative = backward, FAST)
    const _pbFriction = 0.997;          // velocity decay per ms when coasting (drag inertia)
    const _pbWheelFriction = 0.985;     // velocity decay per ms for wheel scroll (stops faster)
    const _pbForceStrength = 0.008;     // how quickly velocity changes toward target (per ms)
    const _pbVelocityThreshold = 0.1;   // below this, considered "at rest"
    const _pbEdgeEpsMs = 3000;          // "reached the edge" tolerance (covers a fast frame)
    const _pbEaseInDistance = 0.02;     // start braking when within 2% of bounds (only near edges)
    // Repaint cap for the field+overlay canvases during playback, independent of
    // display refresh rate. The playhead itself still advances every RAF tick (time
    // stays accurate, UI labels stay smooth via their own uiMinDt gate below) — this
    // only throttles the expensive repaint, which a slow-moving vehicle map doesn't
    // need faster than ~30fps to read as smooth. Uncapped, this repainted once per
    // display refresh (up to 120Hz on ProMotion) for motion no one can perceive.
    const _pbDrawMinDt = 33;            // ~30fps ceiling on field/overlay repaint

    // When playhead hits end, wait until all vehicle physics states have reached
    // the end of their path, then trigger rewind.
    const _pbVehicleDoneEpsM = 1.0;
    const _pbVehicleDoneVelEpsMps = 0.05;

    function _pbAllVehiclesReachedPlaybackEnd(state) {
      try {
        const mobiles = Array.isArray(state?.mobile) ? state.mobile : [];
        let considered = 0;
        for (const m of mobiles) {
          if (!m || m.ghosted) continue;
          const id = (m.id != null) ? String(m.id) : "";
          if (!id) continue;

          const pts = (map && map._playbackPtsById) ? map._playbackPtsById.get(id) : null;
          if (!pts || pts.length < 1) continue;

          // Single-point paths are trivially "done".
          if (pts.length === 1) {
            considered++;
            continue;
          }

          const distInfo = (typeof map?._getPathDistances === "function") ? map._getPathDistances(id, pts) : null;
          const totalDist = distInfo && isFinite(distInfo.totalDist) ? distInfo.totalDist : 0;
          const phys = (typeof map?._getPhysicsState === "function") ? map._getPhysicsState(id) : null;
          const d = phys && isFinite(phys.d) ? phys.d : 0;
          const v = phys && isFinite(phys.v) ? phys.v : 0;

          considered++;
          if (!(d >= (totalDist - _pbVehicleDoneEpsM) && v <= _pbVehicleDoneVelEpsMps)) {
            return false;
          }
        }
        // If we had no vehicles to consider, don't stall.
        return true;
      } catch {
        return true;
      }
    }

    // Scroll wheel nudge (iPod-style momentum)
    const _pbWheelImpulse = 1.0;        // velocity added per wheel tick
    const _pbWheelDecay = 0.8;          // wheel accumulator decay per frame

    // Drag tracking

    // ─────────────────────────────────────────────────────────────────────────────
    // PAGING: Slider maps to an 8-hour page instead of the full day.
    // Keeps scrub resolution constant as data accumulates.
    // ─────────────────────────────────────────────────────────────────────────────
    const _pbPageSizeMs = 14400000;         // 4 hours in ms
    const _pbPageMinDurationMs = 0;          // paging always active

    // Sliding window: when set, overrides index-based paging for click-drag scrubbing.
    // The window is centered on this timestamp instead of a fixed page boundary.

    /** Compute total page count for current bounds.
     *  Uses floor so the last page absorbs any remainder < pageSize,
     *  keeping scrub resolution reasonable instead of creating a tiny final page. */
    function _pbPageCount() {
      const b = map.getPlaybackBounds();
      if (!isFinite(b.minMs) || !isFinite(b.maxMs) || b.maxMs <= b.minMs) return 0;
      return Math.max(1, Math.floor((b.maxMs - b.minMs) / _pbPageSizeMs));
    }

    /** Get the time range for the current page (or full range if paging disabled).
     *  When pb._pbSlidingWindowCenter is set, the window is centered on that point
     *  instead of using index-based page boundaries. */
    function _pbGetPageRange() {
      const b = map.getPlaybackBounds();
      if (!isFinite(b.minMs) || !isFinite(b.maxMs) || b.maxMs <= b.minMs) return b;
      if (pb._pbPageIndex < 0) return b; // "all" mode

      // Sliding window mode: center window on pb._pbSlidingWindowCenter
      if (pb._pbSlidingWindowCenter != null) {
        const half = _pbPageSizeMs / 2;
        let wMin = pb._pbSlidingWindowCenter - half;
        let wMax = pb._pbSlidingWindowCenter + half;
        // Clamp to global bounds, preserving window size when possible
        if (wMin < b.minMs) { wMin = b.minMs; wMax = Math.min(b.maxMs, wMin + _pbPageSizeMs); }
        if (wMax > b.maxMs) { wMax = b.maxMs; wMin = Math.max(b.minMs, wMax - _pbPageSizeMs); }
        return { minMs: wMin, maxMs: wMax };
      }

      const total = _pbPageCount();
      const idx = clamp(pb._pbPageIndex, 0, total - 1);
      const pageStart = b.minMs + idx * _pbPageSizeMs;
      // Last page extends to cover all remaining time (no short final page)
      const pageEnd = (idx === total - 1) ? b.maxMs : pageStart + _pbPageSizeMs;
      return { minMs: pageStart, maxMs: pageEnd };
    }

    /** Navigate to a specific page index, clamping to valid range. */
    function _pbSetPage(idx) {
      const total = _pbPageCount();
      if (total <= 0) { pb._pbPageIndex = -1; return; }
      pb._pbPageIndex = clamp(idx, 0, total - 1);
      pb._pbSlidingWindowCenter = null; // exit sliding window, use index-based page
      pb._pbPageAutoFollow = false; // user explicitly chose a page
      updatePlaybackUi();
    }

    /** Enable paging and jump to the page containing the given time. */
    function _pbPageForTime(tMs) {
      const b = map.getPlaybackBounds();
      if (!isFinite(b.minMs) || !isFinite(b.maxMs) || b.maxMs <= b.minMs) return;
      const total = _pbPageCount();
      if (total <= 0) return;
      const idx = Math.floor((tMs - b.minMs) / _pbPageSizeMs);
      pb._pbPageIndex = clamp(idx, 0, total - 1);
    }

    /** After user stops scrubbing, re-center the sliding window so the playhead
     *  sits at 15% (if user was dragging left) or 85% (if dragging right). */
    function _pbSnapWindowToPlayhead() {
      if (!_pbPagingActive() || pb._pbSlidingWindowCenter == null) return;
      const b = map.getPlaybackBounds();
      const tMs = map.getPlaybackTimeMs();
      if (tMs == null || !isFinite(tMs)) return;
      const pr = _pbGetPageRange();
      // Determine which edge the playhead is near
      const fracInPage = (pr.maxMs > pr.minMs) ? (tMs - pr.minMs) / (pr.maxMs - pr.minMs) : 0.5;
      // If near left edge (<25%), snap playhead to 15%; if near right (>75%), snap to 85%
      const targetFrac = (fracInPage < 0.25) ? 0.15 : (fracInPage > 0.75) ? 0.85 : fracInPage;
      pb._pbSlidingWindowCenter = tMs - targetFrac * _pbPageSizeMs + _pbPageSizeMs / 2;
      const half = _pbPageSizeMs / 2;
      pb._pbSlidingWindowCenter = clamp(pb._pbSlidingWindowCenter, b.minMs + half, b.maxMs - half);
    }

    /** Check if paging should be active based on data duration. */
    function _pbPagingActive() {
      const b = map.getPlaybackBounds();
      if (!isFinite(b.minMs) || !isFinite(b.maxMs)) return false;
      return (b.maxMs - b.minMs) >= _pbPageMinDurationMs;
    }

    const fmtTime = (ms) => {
      if (ms == null || !isFinite(ms)) return "—";
      try { return new Date(ms).toLocaleTimeString(); } catch { return "—"; }
    };

    const updatePlaybackUi = () => {
      const b = map.getPlaybackBounds();
      const tMs = map.getPlaybackTimeMs();
      const paging = _pbPagingActive();

      // Auto-enable paging when duration crosses threshold.
      // Initialize page index to the page containing the playhead.
      if (paging && pb._pbPageIndex < 0) {
        const t = (tMs != null && isFinite(tMs)) ? tMs : b.maxMs;
        _pbPageForTime(t);
        pb._pbPageAutoFollow = true; // started automatically, follow playhead
      } else if (!paging) {
        pb._pbPageIndex = -1; // disable paging when duration shrinks
        pb._pbSlidingWindowCenter = null;
      }

      // Auto-advance page to follow playhead during normal playback (not scrubbing/coasting)
      if (paging && pb._pbPageAutoFollow && tMs != null && isFinite(tMs) && !pb._pbScrubbing) {
        const pr = _pbGetPageRange();
        if (tMs >= pr.maxMs || tMs < pr.minMs) {
          if (pb._pbSlidingWindowCenter != null) {
            // Shift window just enough so playhead is inside, giving room in the direction of travel
            const frac = (tMs >= pr.maxMs) ? 0.85 : 0.15;
            pb._pbSlidingWindowCenter = tMs - frac * _pbPageSizeMs + _pbPageSizeMs / 2;
            const half = _pbPageSizeMs / 2;
            pb._pbSlidingWindowCenter = clamp(pb._pbSlidingWindowCenter, b.minMs + half, b.maxMs - half);
          } else {
            _pbPageForTime(tMs);
          }
        }
        pb._pbPageAutoFollow = true; // keep following
      }

      // Use page range for slider when paging is active
      const pr = paging ? _pbGetPageRange() : b;
      const sliderMinMs = pr.minMs;
      const sliderMaxMs = pr.maxMs;

      if (pbLeftEl) pbLeftEl.textContent = fmtTime(sliderMinMs);
      if (pbRightEl) pbRightEl.textContent = fmtTime(sliderMaxMs);
      if (pbNowEl) pbNowEl.textContent = fmtTime(tMs);

      if (pbScrubEl && isFinite(sliderMinMs) && isFinite(sliderMaxMs) && sliderMaxMs > sliderMinMs) {
        const durMs = Math.max(1, sliderMaxMs - sliderMinMs);
        const tRelMs = (tMs != null && isFinite(tMs)) ? (tMs - sliderMinMs) : durMs;
        // Freeze the slider's range while the user is scrubbing: the live
        // edge ticks with wall time, and re-basing max under the finger makes
        // the value→time mapping jitter against the drag (forward-swipe race).
        if (!pb._pbScrubbing) {
          pbScrubEl.min = "0";
          pbScrubEl.max = String(durMs);
          pbScrubEl.step = "100"; // 100ms steps for smoother scrubbing
          pbScrubEl.value = String(clamp(tRelMs, 0, durMs));
        }
        pbScrubEl.disabled = false;
        // Update progress fill for browsers without accent-color range support
        const pct = (clamp(Number(pbScrubEl.value), 0, durMs) / durMs) * 100;
        pbScrubEl.style.setProperty("--pct", pct + "%");
      } else if (pbScrubEl) {
        pbScrubEl.disabled = true;
        pbScrubEl.min = "0";
        pbScrubEl.max = "1";
        pbScrubEl.value = "0";
        pbScrubEl.style.setProperty("--pct", "0%");
      }

      // Page arrow visibility & disabled state
      if (pbPagePrevEl) {
        pbPagePrevEl.classList.toggle("hidden", !paging);
        pbPagePrevEl.disabled = pb._pbPageIndex <= 0;
      }
      if (pbPageNextEl) {
        pbPageNextEl.classList.toggle("hidden", !paging);
        pbPageNextEl.disabled = pb._pbPageIndex >= _pbPageCount() - 1;
      }

      const hasBounds = isFinite(b.minMs) && isFinite(b.maxMs) && b.maxMs > b.minMs;

      if (pbPlayEl) {
        const st = PlaybackUI.computeButtonState({
          historical: !!map._historicalMode,
          playing: map.getPlaybackPlaying(),
          liveFollow: !!map._playbackLiveFollow,
          // At the wall-clock edge (riding NOW) → real time at any speed.
          atWallEdge: hasBounds && !map._historicalMode && map.isPlaybackAtEnd(1500),
          speed: map.getPlaybackSpeed() || 1.0,
        });
        pbPlayEl.textContent = st.label;
        pbPlayEl.classList.toggle("isLive", st.lit);
      }
      if (pbSpeedEl) pbSpeedEl.value = String(map.getPlaybackSpeed() || 1.0);

      // PAUSED shade: dims the map and shows the word PAUSED (same code path
      // as the loading shade) whenever live-view playback is stopped. Pausing
      // only happens outside the live sync window (see computeClickAction), so
      // "stopped in live view" is a genuine pause. (The ◀◀ REW badge is kept
      // in the DOM but hidden for now.)
      const _stopped = !!map.playbackMode && !map._historicalMode
        && !map.getPlaybackPlaying() && !map._playbackLiveFollow
        && !pb._pbScrubbing && Math.abs(pb._pbVelocity) <= _pbVelocityThreshold;
      if (pbPausedShadeEl) pbPausedShadeEl.classList.toggle("hidden", !_stopped);
    };

    // Establish the riding / live state (idempotent). Reaching the leading
    // edge in live view is ALWAYS live, however we arrived — play, coast,
    // barrel fling, or a finger-scroll to the end. Clears any coasting so the
    // loop's ride pin (below) takes over and the wall clock keeps ticking.
    const _pbGoLive = () => {
      pb._pbIsWheelCoasting = false;
      pb._pbWheelAccum = 0;
      pb._pbAtEndSincePerf = null;
      pb._pbIsRewinding = false;
      pb._pbEaseStartPerf = null;
      pb._pbPaused = false;          // going live clears an explicit pause
      if (!map.getPlaybackPlaying()) map.setPlaybackPlaying(true);
      if (!map._playbackLiveFollow) {
        map._playbackLiveFollow = true;
        pb._pbPageAutoFollow = true;
        try { localStorage.setItem(LIVE_MODE_STORAGE_KEY, "1"); } catch {}
      }
    };

    // Explicit pause freezes the playhead IN PLACE (no skip-back). The paused
    // flag (pb._pbPaused, set by the pbPlay pause branch) suppresses the loop's
    // go-live so it isn't immediately re-ridden; the dim shade shows at once
    // and ◀◀ REW appears as wall time carries the edge past the frozen head.
    const playbackLoop = () => {
      pb._pbRAF = null;
      // Allow loop to run in DVR mode OR LIVE mode (both need playback time updates)
      if (!map.playbackMode && !map._playbackLiveFollow) return;

      try {
      const now = performance.now();
      const dt = (pb._pbLastPerf > 0) ? (now - pb._pbLastPerf) : 0;
      pb._pbLastPerf = now;

      const b = map.getPlaybackBounds();
      let tMs = map.getPlaybackTimeMs();
      const hasBounds = isFinite(b.minMs) && isFinite(b.maxMs) && b.maxMs > b.minMs;
      const durMs = hasBounds ? (b.maxMs - b.minMs) : 1;
      const prevKnownMaxMs = pb._pbLastKnownMaxMs;

      // Playhead initialization is handled in tick() when data arrives

      // ─────────────────────────────────────────────────────────────────────────
      // DETECT DATA CHANGES (new data arrived, or data trimmed)
      // ─────────────────────────────────────────────────────────────────────────
      let newDataArrived = false;
      let forceCameraFit = false;

      if (hasBounds) {
        // One-shot refresh resume (stashed by app.js boot from
        // mobileair.pbResume): restore a lit server-sync ride interrupted by
        // a refresh. Only a liveFollow+playing position still inside the
        // current poll window behind the data edge qualifies — paused,
        // rewound, historical, or aged-out states fall through and the boot
        // default (live) stands. Runs before the new-data auto-resume below
        // so the restored position wins the frame.
        if (pb._pbPendingResume) {
          const r = pb._pbPendingResume;
          pb._pbPendingResume = null;
          const _resumeEdge = (map._playbackMaxMs != null && isFinite(map._playbackMaxMs))
            ? map._playbackMaxMs : b.maxMs;
          if (r && r.live && r.playing && !r.hist && !map._historicalMode
              && isFinite(Number(r.t)) && Number(r.t) >= b.minMs
              && Number(r.t) < _resumeEdge - 1500) {
            tMs = Number(r.t);
            map.setPlaybackTimeMs(tMs);
            map._playbackLiveFollow = true;
            pb._pbPageAutoFollow = true;
            pb._pbPaused = false;
            pb._pbLoopStartMs = tMs;
            pb._pbVelocity = _pbPlaybackSpeed * (map.getPlaybackSpeed() || 1.0);
            map.setPlaybackPlaying(true);
          } else if (r && (!r.live || r.hist) && !map._historicalMode) {
            // They left the app NOT live (rewound, paused, or on a loaded
            // day): land on the actual live edge — not the runway point the
            // live-follow initializer would pick (the lit button is how you
            // enter that mode deliberately).
            tMs = b.maxMs;
            map.setPlaybackTimeMs(tMs);
            pb._pbLiveStartWallMs = null; // re-init live tracking from the edge
          }
          // else: they were live — the normal boot path stands, unchanged.
        }
        if (pb._pbLastKnownMaxMs != null && b.maxMs > pb._pbLastKnownMaxMs + 100) {
          newDataArrived = true;
          // Record the update window for future forced camera fits.
          // NOTE: in app.js these were undeclared assignments (implicit globals,
          // write-only, never read). This module is strict-mode, so we write
          // them as explicit globals to preserve the identical (no-op) effect.
          if (typeof prevKnownMaxMs === "number" && isFinite(prevKnownMaxMs)) {
            g._pbLastDataUpdateWindowStartMs = prevKnownMaxMs;
            g._pbLastDataUpdateWindowEndMs = b.maxMs;
          }
          // Reset stall counter when fresh data arrives
          pb._pbLiveStallCount = 0;
        }
        pb._pbLastKnownMinMs = b.minMs;
        pb._pbLastKnownMaxMs = b.maxMs;

        // If playhead is now outside bounds (data trimmed or server restarted), handle it
        if (tMs != null && isFinite(tMs)) {
          if (tMs < b.minMs) {
            // Data trimmed past the playhead: clamp to the new start and keep
            // playing. Never jump to the live edge — new server data must not
            // move the playhead; playback simply continues into it.
            tMs = b.minMs;
            map.setPlaybackTimeMs(tMs);
          }
          if (tMs > b.maxMs) {
            tMs = b.maxMs;
            map.setPlaybackTimeMs(tMs);
          }
        }
      }

      // (No pause-step-back here. The loop's job at the edge is to GO LIVE,
      // not to yank the playhead back — a finger-scroll that coasts to a rest
      // at the end must ride, not freeze. Explicit pause is the only step-back
      // and it happens synchronously in the button handler.)

      // Forced refresh: treat as a new-data event even if bounds didn't move.
      // This is used by the terminal TUI to request a camera fit/zoom in the web UI.
      try {
        const state = map.lastState;
        const seq = state?.meta?.force_refresh_seq;
        if (typeof seq === "number" && isFinite(seq)) {
          if (pb._pbLastForceRefreshSeq == null) {
            // If the server seq is already >0 when playback starts (e.g. TUI refresh happened first),
            // treat it as a one-time forced camera fit.
            if (seq > 0) {
              newDataArrived = true;
              forceCameraFit = true;
              pb._pbLiveStallCount = 0;
            }
          } else if (seq !== pb._pbLastForceRefreshSeq) {
            newDataArrived = true;
            forceCameraFit = true;
            pb._pbLiveStallCount = 0;
          }
          pb._pbLastForceRefreshSeq = seq;
        }
      } catch {
        // ignore
      }

      // When new data arrives in LIVE mode and playback is paused at the end,
      // resume playing so the new segment animates. Don't rewind the playhead —
      // let normal forward playback consume the new data naturally.
      if (hasBounds && (newDataArrived || forceCameraFit) && map._playbackLiveFollow && !map.getPlaybackPlaying()) {
        const speed = map.getPlaybackSpeed() || 1.0;
        pb._pbVelocity = _pbPlaybackSpeed * speed;
        map.setPlaybackPlaying(true);
        pb._pbLastPerf = 0;
        if (!pb._pbRAF) pb._pbRAF = requestAnimationFrame(playbackLoop);
      }

      // ─────────────────────────────────────────────────────────────────────────
      // LIVE BUFFER CALCULATION
      // Buffer = wall-clock time since LIVE started (how much data we've accumulated).
      // Playback consumes this buffer at playbackSpeed rate.
      // ─────────────────────────────────────────────────────────────────────────
      let liveBufferMs = 0;

      if (hasBounds && map._playbackLiveFollow) {
        // Initialize playhead if not set (handled above, but keep for safety)
        if (tMs == null || !isFinite(tMs)) {
          const meta = map.lastState?.meta;
          const nextInS = Number(meta?.polling_next_update_in_s) ?? Number(meta?.polling_predicted_interval_s) ?? 600;
          const speed = map.getPlaybackSpeed() || 1.0;
          const offsetMs = nextInS * 1000 * speed;
          tMs = Math.max(b.minMs, b.maxMs - offsetMs);
          map.setPlaybackTimeMs(tMs);
        }

        // Initialize LIVE tracking on first entry
        if (pb._pbLiveStartWallMs == null) {
          pb._pbLiveStartWallMs = now;
          pb._pbLiveStartDataMs = b.maxMs;
        }

        // Buffer = wall-clock time since we started LIVE mode
        // This is how much new data has accumulated since we began
        const wallElapsed = now - pb._pbLiveStartWallMs;
        liveBufferMs = wallElapsed;

        // Target = newest data minus the buffer (stay behind the live edge)
        // The buffer grows in real-time, so we always have runway
        pb._pbLiveTargetMs = b.maxMs - liveBufferMs;

        // Clamp: if rewind outpaces buffer accumulation, just use minMs
        if (pb._pbLiveTargetMs < b.minMs) {
          pb._pbLiveTargetMs = b.minMs;
        }
      }

      // ─────────────────────────────────────────────────────────────────────────
      // LIVE CAMERA FOLLOW: Frame where vehicles currently are, their visible
      // trails, and nearby fixed sensors. Uses median-based outlier trimming so
      // a distant long-route vehicle doesn't drag the camera to city scale.
      // ─────────────────────────────────────────────────────────────────────────
      {
        if (_getScreensaverActive() && (newDataArrived || forceCameraFit) && map._playbackLiveFollow) {
          _performCameraFit({ force: true });
        }
      }

      // ─────────────────────────────────────────────────────────────────────────
      // DEFERRED CAMERA FIT: If a live camera fit was blocked by user interaction,
      // replay it now that the interaction + easing has settled.
      // ─────────────────────────────────────────────────────────────────────────
      if (pb._deferredCameraFit && map._playbackLiveFollow
          && typeof map._canRunAutoCamera === "function" && map._canRunAutoCamera()) {
        const d = pb._deferredCameraFit;
        pb._deferredCameraFit = null;
        if (d.type === "bounds" && d.bb) {
          _animateFitBoundsLatLon(d.bb, { durationMs: d.durationMs || _pbLiveFollowDurationMs });
        } else if (d.type === "storedView") {
          _animateToStoredView(d.durationMs || _pbLiveFollowDurationMs);
        }
      }

      // ─────────────────────────────────────────────────────────────────────────
      // PHYSICS SIMULATION
      // ─────────────────────────────────────────────────────────────────────────
      let didAdvanceTime = false;
      const didMarkerInertia = (typeof map._stepPbMarkerInertia === "function")
        ? !!map._stepPbMarkerInertia(now, dt)
        : false;

      if (didMarkerInertia) {
        didAdvanceTime = true;
        tMs = map.getPlaybackTimeMs();
        pb._pbAtEndSincePerf = null; // user interaction resets end timer
      } else if (!pb._pbScrubbing && hasBounds && tMs != null && isFinite(tMs) && dt > 0) {
        // Apply wheel nudge to velocity
        if (Math.abs(pb._pbWheelAccum) > 0.1) {
          pb._pbVelocity += pb._pbWheelAccum * _pbWheelImpulse;
          pb._pbWheelAccum *= _pbWheelDecay;
          if (Math.abs(pb._pbWheelAccum) < 0.1) pb._pbWheelAccum = 0;
          pb._pbAtEndSincePerf = null; // wheel interaction resets end timer
        }

        // Determine velocity based on state
        const atEnd = (tMs >= b.maxMs - 1);
        const speedMult = map.getPlaybackSpeed() || 1.0;

        // ── RIDE THE LIVE EDGE ────────────────────────────────────────────
        // In live view the edge is wall-clock (getPlaybackBounds extends
        // maxMs to Date.now()), so a playhead that reaches it is pinned to
        // it and keeps moving with wall time — time never stops at the end,
        // cache keys keep advancing, and when the server update lands the
        // playhead is already there and playback continues seamlessly.
        // Pin at ~4 Hz (250 ms) rather than every frame: smooth enough for
        // clock labels and staleness fades, 15× cheaper than 60 fps.
        // ── RIDE / GO LIVE AT THE LEADING EDGE ────────────────────────────
        // Reaching the leading edge in live view is ALWAYS live, however we
        // got here: play, coast, barrel fling, or a finger-scroll to the end.
        // The edge is EITHER the data edge or the wall-clock max (no data
        // between them). We ride whenever the playhead is at/past that edge
        // and not actively moving BACKWARD (a backward fling escapes). Only
        // an explicit pause parks behind the edge, and it moves the playhead
        // there itself — so observing tMs at the edge always means forward
        // intent. Going live pins to the ticking wall edge at ~4 Hz, so the
        // wall clock never stops.
        const _dataEdgeRideMs = (!map._historicalMode
          && map._playbackMaxMs != null && isFinite(map._playbackMaxMs))
          ? map._playbackMaxMs : b.maxMs;
        // Ride only when the playhead has actually REACHED an edge (a few
        // seconds of it), not a big fraction of the timeline. A wider zone
        // would swallow the Live-click runway snap (which lands the playhead
        // a runway BEHIND the data edge on purpose). _pbEdgeEpsMs covers one
        // fast-speed frame so a high-speed playhead can't skip past the edge.
        const _atLeadingEdge = !map._historicalMode
          && !pb._pbPaused           // an explicit pause holds; don't re-ride it
          && !pb._pbScrubbing
          && !pb._pbIsRewinding
          && pb._pbVelocity >= -_pbVelocityThreshold
          && (tMs >= b.maxMs - 1000 || tMs >= _dataEdgeRideMs - _pbEdgeEpsMs);
        // Resolve loop start within current bounds.
        const loopStartMsRaw = (pb._pbLoopStartMs != null) ? Number(pb._pbLoopStartMs) : null;
        const loopStartMs = (isFinite(loopStartMsRaw)) ? clamp(loopStartMsRaw, b.minMs, b.maxMs) : b.minMs;

        if (_atLeadingEdge) {
          _pbGoLive();
          if (b.maxMs - tMs >= 250) {
            pb._pbMoveDeltaMs = b.maxMs - tMs;   // forward: riding the edge
            map.setPlaybackTimeMs(b.maxMs);
            tMs = b.maxMs;
            didAdvanceTime = true;
          }
          pb._pbVelocity = 0;
        } else if (pb._pbIsRewinding) {
          // Tape-reel rewind: ramp up, cruise, ease into start
          const totalDist = Math.max(1, b.maxMs - loopStartMs);
          const distFromStart = tMs - loopStartMs;
          const progress = 1 - (distFromStart / totalDist); // 0 at end, 1 at loop start

          // Base cruise speed: complete full rewind in ~4 seconds
          const cruiseSpeed = -totalDist / 4000;
          const playbackSpeed = _pbPlaybackSpeed * speedMult;

          // Ease duration in wall time
          const easeDurationMs = 1500;

          // Ease zone: last 15% of the recording (position-based trigger)
          // This is independent of speed - we ease over the final portion of the timeline
          const easeDistanceMs = totalDist * 0.15;

          const inEasePhase = pb._pbEaseStartPerf != null;
          const shouldStartEase = !inEasePhase && distFromStart <= easeDistanceMs;

          if (progress < 0.15 && !inEasePhase) {
            // Ramp up phase: accelerate from 0.3 to 1.0 of cruise speed
            const speedFactor = 0.3 + (progress / 0.15) * 0.7;
            pb._pbVelocity = cruiseSpeed * speedFactor;
          } else if (inEasePhase || shouldStartEase) {
            // NEWTONIAN PHYSICS: constant acceleration to reach playbackSpeed at loopStartMs
            if (pb._pbEaseStartPerf == null) {
              pb._pbEaseStartPerf = now;
              pb._pbEaseStartPos = tMs;
              pb._pbEaseStartVelocity = pb._pbVelocity;
            }

            // We want to go from v₀ (negative) to playbackSpeed (positive) over distance d
            // Average velocity = (v₀ + v_final) / 2
            // Time = d / |avg_v|
            // Acceleration = (v_final - v₀) / t
            const v0 = pb._pbEaseStartVelocity;
            const vFinal = playbackSpeed;
            const d = pb._pbEaseStartPos - loopStartMs;

            const avgVel = (v0 + vFinal) / 2;
            // Avoid division by zero
            const accel = Math.abs(avgVel) > 0.1 ? (vFinal - v0) / (d / Math.abs(avgVel)) : 0.01;

            // Apply acceleration
            pb._pbVelocity = pb._pbVelocity + accel * dt;

            // Clamp to not overshoot target velocity
            if (pb._pbVelocity >= vFinal) {
              pb._pbVelocity = vFinal;
            }

            // End ease when we reach start or velocity reaches target
            if (tMs <= loopStartMs + 10 || pb._pbVelocity >= vFinal) {
              pb._pbIsRewinding = false;
              pb._pbEaseStartPerf = null;
              pb._pbVelocity = playbackSpeed;
            }
          } else {
            // Cruise phase: full speed
            pb._pbVelocity = cruiseSpeed;
          }
        } else if (map._playbackLiveFollow || map.getPlaybackPlaying()) {
          // Forward playback toward the edge at the selected speed. In live
          // view, arriving at the wall-clock edge hands off to the RIDE block
          // above — playback never stops there. Historical snapshots park at
          // their fixed end (velocity 0).
          if (atEnd) {
            pb._pbVelocity = 0;
          } else {
            pb._pbVelocity = _pbPlaybackSpeed * speedMult;
            pb._pbAtEndSincePerf = null;
          }
        } else if (!map.getPlaybackPlaying() && Math.abs(pb._pbVelocity) > _pbVelocityThreshold) {
          // Coasting after wheel - apply friction
          const friction = pb._pbIsWheelCoasting ? _pbWheelFriction : _pbFriction;
          const frictionFactor = Math.pow(friction, dt);
          pb._pbVelocity *= frictionFactor;

          // When velocity decays to playback speed, resume playback
          const playbackSpeed = _pbPlaybackSpeed * speedMult;
          if (pb._pbVelocity > 0 && pb._pbVelocity <= playbackSpeed) {
            // Forward coasting reached playback speed - resume
            pb._pbIsWheelCoasting = false;
            _pbSnapWindowToPlayhead();
            if (pb._pbCommitLoopStartOnCoastEnd) {
              pb._pbLoopStartMs = tMs;
              pb._pbCommitLoopStartOnCoastEnd = false;
            }
            pb._pbVelocity = playbackSpeed;
            map.setPlaybackPlaying(true);
            updatePlaybackUi();
          } else if (pb._pbVelocity < 0 && Math.abs(pb._pbVelocity) < _pbVelocityThreshold) {
            // Backward coasting stopped - resume forward playback
            pb._pbIsWheelCoasting = false;
            _pbSnapWindowToPlayhead();
            if (pb._pbCommitLoopStartOnCoastEnd) {
              pb._pbLoopStartMs = tMs;
              pb._pbCommitLoopStartOnCoastEnd = false;
            }
            pb._pbVelocity = playbackSpeed;
            map.setPlaybackPlaying(true);
            updatePlaybackUi();
          }
        }

        // Note: No additional easing here - forward playback runs at constant speed
        // Rewind easing is handled inside the pb._pbIsRewinding block above

        // Snap to zero if very slow
        if (Math.abs(pb._pbVelocity) < _pbVelocityThreshold && pb._pbVelocity !== 0) {
          pb._pbVelocity = 0;
          // Final UI update so time labels reflect where the playhead landed
          if (!map.getPlaybackPlaying()) {
            updatePlaybackUi();
          }
        }

        // Move playhead
        if (Math.abs(pb._pbVelocity) > 0) {
          let nextMs = tMs + pb._pbVelocity * dt;

          // Clamp to bounds; during auto-rewind, clamp to loopStartMs instead of the global min.
          const rewindMinMs = (pb._pbIsRewinding && loopStartMs != null && isFinite(loopStartMs)) ? loopStartMs : b.minMs;
          nextMs = clamp(nextMs, rewindMinMs, b.maxMs);

          // Rewound INTO the start bound: resume forward playback from there
          // instead of parking (unless in active ease - let ease control it).
          // Parking here was the "pause on rewind" gate: the auto-rewind
          // arrival block below already resumed forward, but it is gated on
          // _pbIsRewinding, which is never set for a user rewind — so a
          // backward coast/fling that reached the start died at velocity 0
          // with playing=false and sat on the PAUSED shade.
          if (nextMs <= rewindMinMs && pb._pbVelocity < 0 && pb._pbEaseStartPerf == null) {
            pb._pbIsRewinding = false; // rewind complete
            pb._pbIsWheelCoasting = false;
            nextMs = rewindMinMs;
            pb._pbVelocity = _pbPlaybackSpeed * (map.getPlaybackSpeed() || 1.0);
            pb._pbAtEndSincePerf = null;
            if (!map.getPlaybackPlaying()) map.setPlaybackPlaying(true);
            updatePlaybackUi();
          }
          if (nextMs >= b.maxMs && pb._pbVelocity > 0) {
            pb._pbVelocity = 0;
            nextMs = b.maxMs;
            // Forward momentum into the end (wheel accumulator, barrel-jog
            // fling, coasting, finger-scroll) is the drag-into-the-live-edge
            // gesture: GO LIVE this same frame so it never parks frozen at the
            // wall edge. Historical keeps the old parking.
            if (!map._historicalMode) {
              _pbGoLive();
              updatePlaybackUi();
            }
          }

          if (nextMs !== tMs) {
            pb._pbMoveDeltaMs = nextMs - tMs;   // signed: which way the playhead went
            map.setPlaybackTimeMs(nextMs);
            tMs = nextMs;
            didAdvanceTime = true;

            // Force slider to update immediately during coasting
            if (!map.getPlaybackPlaying()) {
              updatePlaybackUi();
            }
          }

          // When AUTO-REWIND arrives at start, reset for forward playback
          // But NOT when user is manually coasting backward
          if (tMs <= b.minMs + 1 && pb._pbVelocity === 0 && pb._pbIsRewinding) {
            // We've hit the start from auto-rewind - start playing forward
            pb._pbVelocity = _pbPlaybackSpeed * (map.getPlaybackSpeed() || 1.0);
            pb._pbAtEndSincePerf = null;
            pb._pbIsRewinding = false;
            if (!map.getPlaybackPlaying()) {
              map.setPlaybackPlaying(true);
            }
            updatePlaybackUi();
          }
        }
      }

      // ─────────────────────────────────────────────────────────────────────────
      // FOVEATED ROAD MATCHING: Progressive snapping during playback
      // Only run when playing (not scrubbing) and time is advancing
      // ─────────────────────────────────────────────────────────────────────────
      if (map._historicalMode && map.getPlaybackPlaying() && !pb._pbScrubbing && !pb._pbIsRewinding) {
        map._requestFoveatedRoadMatching();
      }

      // ─────────────────────────────────────────────────────────────────────────
      // RENDER — capped to _pbDrawMinDt (see declaration above for why)
      // ─────────────────────────────────────────────────────────────────────────
      if (didAdvanceTime && (now - pb._pbLastDrawPerf) >= _pbDrawMinDt) {
        map._compositePaFieldOnTiles(map.lastState);
        map.drawOverlay(map.lastState, { cacheUnderlay: true });
        pb._pbLastDrawPerf = now;
      }

      // (The old "stop at the live buffer window and wait for a Live click"
      // gate is gone: playback that reaches the wall-clock edge now rides it
      // — see the RIDE block — so the catch-up lands on the end and simply
      // keeps going when the server update arrives. Stopping here was the
      // frozen-playhead bug: playback died at the buffer edge and the
      // new-data resume path required a live-follow flag that was never set.)

      // UI updates
      const isActive = Math.abs(pb._pbVelocity) > _pbVelocityThreshold || Math.abs(pb._pbWheelAccum) > 0.1;
      const uiMinDt = isActive ? 16 : 250;
      if ((didAdvanceTime || isActive) && (now - pb._pbLastUiPerf) >= uiMinDt) {
        updatePlaybackUi();
        if (_getSidebarOpen()) _updateSidebarPlaybackValues();
        pb._pbLastUiPerf = now;
      }

      // Sync legend + field only when not scrubbing with a sensor selected.
      // Legend title/bars and PA field update when scrubbing stops or vehicle resumes.
      if (!(pb._pbScrubbing || pb._pbIsWheelCoasting) || !_getSelectedId()) {
        _syncMapPollutant();
        _syncLegendToMapSelection();
      }

      // ── Barrel jog wheel: sync position & render ──
      if (_barrelMode && _jogWheel) {
        const b2 = map.getPlaybackBounds();
        const t2 = map.getPlaybackTimeMs();
        if (isFinite(b2.minMs) && isFinite(b2.maxMs) && b2.maxMs > b2.minMs && isFinite(t2)) {
          const frac = (t2 - b2.minMs) / (b2.maxMs - b2.minMs);
          if (!_jogWheel.isScrubbing()) _jogWheel.setPosition(frac);
        }
        _jogWheel.render();
      }

      // Keep loop running if there's any motion or pending state
      const markerInertiaActive = (typeof map._hasPbMarkerInertia === "function") ? !!map._hasPbMarkerInertia() : false;
      const hasMotion = Math.abs(pb._pbVelocity) > _pbVelocityThreshold;
      const hasWheelMomentum = Math.abs(pb._pbWheelAccum) > 0.1;
      const waitingToRewind = pb._pbAtEndSincePerf != null;
      const inLiveMode = map._playbackLiveFollow;  // LIVE mode always keeps loop running

      if (map.getPlaybackPlaying() || markerInertiaActive || hasMotion || hasWheelMomentum || waitingToRewind || inLiveMode) {
        pb._pbRAF = requestAnimationFrame(playbackLoop);
      } else {
        pb._pbLastPerf = 0;
      }

      } catch (e) {
        // Don't let errors kill the playback loop
        console.error("playbackLoop error:", e);
        pb._pbRAF = requestAnimationFrame(playbackLoop);
      }
    };

    function setMapLoadingShade(on) {
      const shade = document.getElementById("mapLoadingShade");
      if (shade) shade.classList.toggle("hidden", !on);
    }

    // ── Scrub apply + edge-jog (were nested in the pbScrub setup block) ───────
    const applyScrub = () => {
      const b = map.getPlaybackBounds();
      if (!isFinite(b.minMs) || !isFinite(b.maxMs) || !(b.maxMs > b.minMs)) return;
      // When paging is active, slider is relative to the page range
      const pr = _pbPagingActive() ? _pbGetPageRange() : b;
      const relMs = Number(pbScrubEl.value);
      if (!isFinite(relMs)) return;
      const tMs = pr.minMs + relMs;
      // Live view: the timeline's leading edge is wall-clock, but there is no
      // DATA past the server's newest point. Scrubbing clamps to the data
      // edge so the playhead can't be parked in the empty wall-extension
      // zone — only RIDING (playing at the edge) lives there. This kills the
      // forward-swipe flicker of rendering a dataless instant.
      const scrubEdge = (!map._historicalMode
        && map._playbackMaxMs != null && isFinite(map._playbackMaxMs))
        ? Math.min(b.maxMs, map._playbackMaxMs) : b.maxMs;
      const clampedT = clamp(tMs, b.minMs, scrubEdge);

      const _prevScrubT = map.getPlaybackTimeMs();
      if (_prevScrubT != null && isFinite(_prevScrubT)) {
        pb._pbMoveDeltaMs = clampedT - _prevScrubT;   // signed drag direction
      }
      map.setPlaybackTimeMs(clampedT);

      // Don't auto-enable LIVE mode when dragging - user must click the Live button.
      // Just track where the user left the playhead as replay point A.
      pb._pbLoopStartMs = clampedT;

      updatePlaybackUi();
      map._compositePaFieldOnTiles(map.lastState);
      map.drawOverlay(map.lastState);

      // Start or stop edge-jog during drag
      if (pb._pbScrubbing && pb._pbSlidingWindowCenter != null) {
        _pbStartEdgeJog();
      }
    };

    // Edge-jog: when the slider thumb is in the outer 10% during a drag,
    // continuously shift the sliding window in that direction.
    const _pbEdgeThreshold = 0.10; // outer 10% of slider triggers jog
    function _pbStartEdgeJog() {
      if (pb._pbJogRAF) return; // already running
      pb._pbJogLastPerf = performance.now();
      pb._pbJogRAF = requestAnimationFrame(_pbEdgeJogTick);
    }
    function _pbStopEdgeJog() {
      if (pb._pbJogRAF) { cancelAnimationFrame(pb._pbJogRAF); pb._pbJogRAF = null; }
    }
    function _pbEdgeJogTick(now) {
      pb._pbJogRAF = null;
      if (!pb._pbScrubbing || pb._pbSlidingWindowCenter == null) return;

      const maxVal = Number(pbScrubEl.max);
      const curVal = Number(pbScrubEl.value);
      if (!maxVal) return;
      const frac = curVal / maxVal; // 0..1 position within window

      // Determine jog direction and intensity
      let jogDir = 0;
      let intensity = 0;
      if (frac >= 1 - _pbEdgeThreshold) {
        jogDir = 1; // jog forward
        intensity = (frac - (1 - _pbEdgeThreshold)) / _pbEdgeThreshold; // 0..1
      } else if (frac <= _pbEdgeThreshold) {
        jogDir = -1; // jog backward
        intensity = (_pbEdgeThreshold - frac) / _pbEdgeThreshold; // 0..1
      }

      if (jogDir !== 0) {
        const dt = now - pb._pbJogLastPerf;
        // Jog speed: up to 1 page-width per second at full intensity
        const jogSpeed = _pbPageSizeMs * intensity * 1.0;
        const shift = jogDir * jogSpeed * (dt / 1000);

        const gb = map.getPlaybackBounds();
        const prevCenter = pb._pbSlidingWindowCenter;
        pb._pbSlidingWindowCenter = clamp(
          pb._pbSlidingWindowCenter + shift,
          gb.minMs + _pbPageSizeMs / 2,
          gb.maxMs - _pbPageSizeMs / 2
        );

        // Re-apply scrub with the new window position — the absolute time
        // the thumb maps to changes as the window shifts under it.
        const pr = _pbGetPageRange();
        const relMs = Number(pbScrubEl.value);
        const tMs = clamp(pr.minMs + relMs, gb.minMs, gb.maxMs);
        map.setPlaybackTimeMs(tMs);
        pb._pbLoopStartMs = tMs;

        // Always update timestamp display during jog, even if window is
        // clamped to the data boundary (so the user sees the time isn't moving).
        updatePlaybackUi();
        map.drawOverlay(map.lastState);
      } else {
        // Not in the jog zone — still update the timestamp so it's never stale
        // after the user drags out of the edge zone.
        updatePlaybackUi();
      }

      pb._pbJogLastPerf = now;
      // Keep ticking while dragging
      if (pb._pbScrubbing) {
        pb._pbJogRAF = requestAnimationFrame(_pbEdgeJogTick);
      }
    }

    // ── Injected shared-state accessors (state that stays in main()) ──────────
    function _getScreensaverActive() { return deps.getScreensaverActive ? deps.getScreensaverActive() : false; }
    function _getSidebarOpen() { return deps.getSidebarOpen ? deps.getSidebarOpen() : false; }
    function _getSelectedId() { return deps.getSelectedId ? deps.getSelectedId() : null; }
    function _performCameraFit(opts) { if (deps.performCameraFit) deps.performCameraFit(opts); }
    function _animateFitBoundsLatLon(bb, opts) { if (deps.animateFitBoundsLatLon) deps.animateFitBoundsLatLon(bb, opts); }
    function _animateToStoredView(ms) { if (deps.animateToStoredView) deps.animateToStoredView(ms); }
    function _syncMapPollutant() { if (deps.syncMapPollutant) deps.syncMapPollutant(); }
    function _syncLegendToMapSelection() { if (deps.syncLegendToMapSelection) deps.syncLegendToMapSelection(); }
    function _updateSidebarPlaybackValues() { if (deps.updateSidebarPlaybackValues) deps.updateSidebarPlaybackValues(); }

    // Restore saved preference (from _setBarrelMode's original setup site)
    {
      const saved = localStorage.getItem(_BARREL_STORAGE_KEY);
      if (saved === "1") _setBarrelMode(true);
    }

    if (pbBarrelToggle) {
      pbBarrelToggle.addEventListener("change", () => {
        _setBarrelMode(pbBarrelToggle.checked);
      });
    }

    return {
      // DOM refs main() still reads/writes directly (scrub listeners stay there)
      pbScrubEl,
      pbPlayEl,
      pbSpeedEl,
      pbLeftEl,
      pbNowEl,
      pbRightEl,
      pbPagePrevEl,
      pbPageNextEl,
      // Shared coalescing rAF flag (scrub pointer/touch listeners in main())
      getScrubRAF: () => _scrubRAF,
      setScrubRAF: (v) => { _scrubRAF = v; },
      getBarrelMode: () => _barrelMode,
      // Moved functions
      _resetLiveTracking,
      _pbAllVehiclesReachedPlaybackEnd,
      _pbPageCount,
      _pbGetPageRange,
      _pbSetPage,
      _pbPageForTime,
      _pbSnapWindowToPlayhead,
      _pbPagingActive,
      fmtTime,
      updatePlaybackUi,
      playbackLoop,
      _setBarrelMode,
      applyScrub,
      _pbStartEdgeJog,
      _pbStopEdgeJog,
      _pbEdgeJogTick,
      setMapLoadingShade,
    };
  };

  return PlaybackUI;
});
