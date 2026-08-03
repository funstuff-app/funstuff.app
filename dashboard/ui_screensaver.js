/**
 * ui_screensaver.js — Screensaver / demo-mode: bottom-left hot-corner
 * detection, enter/exit transitions (60x auto-play from playback start,
 * loop-and-pause-at-end, restore-on-exit), and the ?demo=1 auto-enter path.
 *
 * Extracted from app.js main(): owns the screensaver activation state
 * (_ssActive/_ssTimer/_ssSnapshot/_ssLoopInterval/_ssLoopTimer/_ssEndMaxMs),
 * the demo-origin flag (_enteredViaDemo), and the hoisted demo-trigger handle
 * (_demoTriggerSS) used by the ?demo=1 auto-enter retry loop. `_screensaverActive`
 * is also read by ui_playback.js via a deps callback (PlaybackUI's
 * deps.getScreensaverActive) — main() keeps a thin `getScreensaverActive()`
 * delegate reading it off this module's instance so that wiring is untouched.
 * `map`, `pb`, `_pbPlaybackSpeed`, `pbSpeedEl`, `pbPlayEl`, `_performCameraFit`,
 * `updatePlaybackUi`, and `playbackLoop` are shared with unmoved main() code
 * and reached through injected deps rather than moved.
 *
 * main() constructs one instance and keeps thin one-line delegates
 * (_demoEnterWhenReady, getScreensaverActive) at the original call sites so
 * every original call site is untouched.
 */
(function (root, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else {
    root.ScreensaverUI = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const g = (typeof window !== "undefined") ? window : globalThis;

  // ── Constructor ──────────────────────────────────────────────────────────

  /**
   * @param {object} cfg
   *   map        — MapView instance
   *   document   — DOM document
   *   pb         — shared playback state object (BY REFERENCE; A4a)
   *   deps       — callbacks/getters into main() for shared state/behavior
   *                that stays there:
   *     pbSpeedEl, pbPlayEl         — DOM refs main() already looked up
   *     performCameraFit(opts)      — main()'s camera-fit cluster entry point
   *     updatePlaybackUi()          — PlaybackUI delegate
   *     playbackLoop()              — PlaybackUI delegate
   *     getDemoParam()              — read main()'s _demoParam
   */
  function ScreensaverUI(cfg) {
    this.cfg = cfg || {};
    this.map = this.cfg.map;
    this.document = this.cfg.document;
    this.pb = this.cfg.pb;
    this.deps = this.cfg.deps || {};

    // Constant duplicated from app.js's copy (see ui_snapshots_menus.js /
    // ui_playback.js for the same precedent) — used only by _ssEnter's
    // velocity seed.
    this._pbPlaybackSpeed = 1.0;

    // Screensaver mode flag (set by hot-corner code below, read by camera follow)
    this._screensaverActive = false;
    this._ssSnapshot = null;       // state snapshot taken on screensaver enter
    this._ssLoopInterval = null;   // poll interval that detects end-of-playback
    this._ssLoopTimer = null;      // 10s pause timer between loops
    this._ssEndMaxMs = null;       // maxMs when we started the 10s pause
    // Hoisted handle for the screensaver-enter function, assigned inside the
    // hot-corner block below so that ?demo=1 can trigger it on page load.
    this._demoTriggerSS = null;
    // Tracks whether the current screensaver session was entered via ?demo=1
    // (as opposed to the bottom-left hot corner). On exit, demo-origin sessions
    // use mode-appropriate defaults instead of restoring the stale entry-time
    // snapshot — in live mode the captured `timeMs` can be tens of minutes old.
    this._enteredViaDemo = false;

    this._initHotCorner();
  }

  ScreensaverUI.prototype._initHotCorner = function () {
    const self = this;
    const map = this.map;
    const document = this.document;
    const pb = this.pb;
    const deps = this.deps;

    // ── Screensaver mode (bottom-left hot corner → hide all UI) ──
    // Park the mouse in the bottom-left ~40px corner for 3 s to activate.
    // Uses a generous inset (not pixel 0,0) to avoid conflicting with OS hot corners.
    // Activating adds body.screensaver which fades all chrome, and triggers pb-hidden
    // on the playback bar so everything disappears together.
    {
      const SS_DELAY_MS = 3000;
      const SS_CORNER_PX = 40; // px from left edge and bottom edge
      let _ssTimer = null;
      let _ssActive = false;

      const _ssEnter = () => {
        if (_ssActive) return;
        _ssActive = true;
        self._screensaverActive = true;
        document.body.classList.add("screensaver");
        var pbBar = document.getElementById("playbackBar");
        if (pbBar) pbBar.classList.add("pb-ss-hidden");

        // Snapshot current state for restoration on exit
        var sb = map.getPlaybackBounds();
        self._ssSnapshot = {
          centerLat: map.center.lat, centerLon: map.center.lon, zoom: map.zoom,
          timeMs: map.getPlaybackTimeMs(), speed: map.getPlaybackSpeed(),
          playing: map.getPlaybackPlaying(), liveFollow: map._playbackLiveFollow,
        };

        // Configure: 60x from start.
        // Playhead: only rewind to the global earliest timestamp (sb.minMs)
        // for an organic hot-corner entry. A ?demo=1 entry arrives with a
        // playhead app.js already set deliberately from the URL's
        // start/playhead params — sb.minMs is the min across ALL sensors
        // (fixed sensors report from the window start; a given mobile's
        // own trail often begins later), so rewinding to it here could
        // land before that mobile's first point and clip its trail/marker
        // to nothing until playback catches back up.
        map._playbackLiveFollow = false;
        map.setPlaybackSpeed(60);
        if (deps.pbSpeedEl) deps.pbSpeedEl.value = "60";
        if (!self._enteredViaDemo && isFinite(sb.minMs)) map.setPlaybackTimeMs(sb.minMs);
        pb._pbVelocity = self._pbPlaybackSpeed * 60;
        map.setPlaybackPlaying(true);
        pb._pbLastPerf = 0;
        if (!pb._pbRAF) pb._pbRAF = requestAnimationFrame(deps.playbackLoop);

        // Poll for end-of-playback to trigger 10s pause then loop
        self._ssLoopInterval = setInterval(() => {
          if (!self._screensaverActive) return;
          // While waiting in the 10s pause, check if new data arrived
          if (self._ssLoopTimer != null) {
            var sb2 = map.getPlaybackBounds();
            if (isFinite(sb2.maxMs) && self._ssEndMaxMs != null && sb2.maxMs > self._ssEndMaxMs + 100) {
              clearTimeout(self._ssLoopTimer); self._ssLoopTimer = null;
              // Jump to where the new data begins and resume playing
              map.setPlaybackTimeMs(self._ssEndMaxMs);
              self._ssEndMaxMs = null;
              pb._pbVelocity = self._pbPlaybackSpeed * 60;
              map.setPlaybackPlaying(true);
              pb._pbLastPerf = 0;
              if (!pb._pbRAF) pb._pbRAF = requestAnimationFrame(deps.playbackLoop);
            }
            return;
          }
          // Detect playback stalled at end (velocity zeroed by physics loop)
          if (map.isPlaybackAtEnd(200) && Math.abs(pb._pbVelocity) < 0.1) {
            var sb3 = map.getPlaybackBounds();
            self._ssEndMaxMs = isFinite(sb3.maxMs) ? sb3.maxMs : null;
            self._ssLoopTimer = setTimeout(() => {
              self._ssLoopTimer = null; self._ssEndMaxMs = null;
              if (!self._screensaverActive) return;
              if (deps.pbPlayEl) deps.pbPlayEl.click();
            }, 10000);
          }
        }, 500);

        // Force camera follow on enter
        deps.performCameraFit({ force: true });
      };

      // Expose to the URL-param handler in loadConfig().then() so ?demo=1
      // can enter the screensaver once initial state is ready. Wrap so we can
      // tag this session as demo-origin for the exit path.
      self._demoTriggerSS = () => { self._enteredViaDemo = true; _ssEnter(); };

      const _ssExit = () => {
        clearTimeout(_ssTimer);
        _ssTimer = null;
        if (!_ssActive) return;
        _ssActive = false;
        self._screensaverActive = false;
        if (self._ssLoopInterval) { clearInterval(self._ssLoopInterval); self._ssLoopInterval = null; }
        if (self._ssLoopTimer) { clearTimeout(self._ssLoopTimer); self._ssLoopTimer = null; }
        self._ssEndMaxMs = null;
        document.body.classList.remove("screensaver");
        var pbBar = document.getElementById("playbackBar");
        if (pbBar) pbBar.classList.remove("pb-ss-hidden");

        // Restore pre-screensaver state.
        // Demo-origin sessions (?demo=1) skip the _ssSnapshot.timeMs restoration:
        // in live mode that captured time is the latest-sample timestamp at
        // entry — often tens of minutes behind real time and unchanged across
        // tick() arrivals during the demo run — so restoring it leaves the
        // playback bar stuck in the past until the user scrubs. Center/zoom/
        // speed from the snapshot are still sound (they reflect app defaults
        // captured on page load) and are restored.
        if (self._enteredViaDemo && self._ssSnapshot) {
          self._enteredViaDemo = false;
          map.center.lat = self._ssSnapshot.centerLat;
          map.center.lon = self._ssSnapshot.centerLon;
          map.zoom = self._ssSnapshot.zoom;
          map.setPlaybackSpeed(self._ssSnapshot.speed);
          if (deps.pbSpeedEl) deps.pbSpeedEl.value = String(self._ssSnapshot.speed);
          map.setPlaybackPlaying(false);
          pb._pbVelocity = 0;
          if (pb._pbRAF) { cancelAnimationFrame(pb._pbRAF); pb._pbRAF = null; }
          // Discriminate live vs snapshot mode via _historicalState, not
          // map.playbackMode (which is true for both once canvas playback is
          // initialized).
          if (g._historicalState) {
            // Snapshot mode (from ?date=...): live-follow stays off; leave the
            // playhead where the demo left it so the user sees a coherent frame.
            map._playbackLiveFollow = false;
          } else {
            // Live mode: re-engage live follow and snap to latest data so the
            // playback bar reflects true "now" instead of the stale entry time.
            // Next tick() keeps it synced.
            map._playbackLiveFollow = true;
            var _sb = map.getPlaybackBounds();
            if (_sb && isFinite(_sb.maxMs)) map.setPlaybackTimeMs(_sb.maxMs);
          }
          self._ssSnapshot = null;
          pb._pbLastPerf = 0;
          deps.updatePlaybackUi();
          map.drawOverlay(map.lastState, { cacheUnderlay: false });
        } else if (self._ssSnapshot) {
          map.center.lat = self._ssSnapshot.centerLat;
          map.center.lon = self._ssSnapshot.centerLon;
          map.zoom = self._ssSnapshot.zoom;
          map.setPlaybackSpeed(self._ssSnapshot.speed);
          if (deps.pbSpeedEl) deps.pbSpeedEl.value = String(self._ssSnapshot.speed);
          map.setPlaybackTimeMs(self._ssSnapshot.timeMs);
          map.setPlaybackPlaying(self._ssSnapshot.playing);
          map._playbackLiveFollow = self._ssSnapshot.liveFollow;
          pb._pbVelocity = self._ssSnapshot.playing ? self._pbPlaybackSpeed * (self._ssSnapshot.speed || 1) : 0;
          pb._pbLastPerf = 0;
          if (self._ssSnapshot.playing && !pb._pbRAF) pb._pbRAF = requestAnimationFrame(deps.playbackLoop);
          self._ssSnapshot = null;
          deps.updatePlaybackUi();
          map.drawOverlay(map.lastState, { cacheUnderlay: false });
        }
      };

      const _ssCheck = (x, y) => {
        const inCorner = x <= SS_CORNER_PX &&
          y >= window.innerHeight - SS_CORNER_PX;
        const inBottomStrip = y >= window.innerHeight - SS_CORNER_PX;
        if (inCorner && !_ssActive && !_ssTimer) {
          _ssTimer = setTimeout(_ssEnter, SS_DELAY_MS);
        } else if (!inCorner && !_ssActive) {
          if (_ssTimer) { clearTimeout(_ssTimer); _ssTimer = null; }
        } else if (_ssActive && !inBottomStrip) {
          _ssExit();
        }
      };

      document.addEventListener("mousemove", (e) => {
        _ssCheck(e.clientX, e.clientY);
      });

      document.addEventListener("touchstart", (e) => {
        var t = e.touches[0];
        if (t) _ssCheck(t.clientX, t.clientY);
      }, { passive: true });

      // Any key press exits screensaver
      document.addEventListener("keydown", () => {
        if (_ssActive) _ssExit();
      });
    }
  };

  // ── Demo auto-enter (?demo=1) ────────────────────────────────────────────

  // Defer screensaver entry until the map has a meaningful playback-bounds
  // span. Finite bounds alone aren't enough: the first tick() may produce
  // minMs≈maxMs (a single datapoint), so _ssEnter's "rewind to start" lands
  // right at the end and nothing animates. Require at least MIN_DEMO_SPAN_MS
  // before firing. Polls on a 100ms interval, giving up after ~10s so we
  // still enter even on a sparse/slow-loading day.
  ScreensaverUI.prototype._demoEnterWhenReady = function () {
    const self = this;
    const map = this.map;
    const deps = this.deps;
    const MIN_DEMO_SPAN_MS = 60 * 1000; // at least 60s of playback data
    if (!deps.getDemoParam() || !self._demoTriggerSS) return;
    let attempts = 0;
    const tryEnter = () => {
      if (!self._demoTriggerSS) return; // already fired or unavailable
      const sb = map.getPlaybackBounds();
      const hasSpan = sb && isFinite(sb.minMs) && isFinite(sb.maxMs)
        && (sb.maxMs - sb.minMs) >= MIN_DEMO_SPAN_MS;
      if (hasSpan || attempts++ > 100) {
        const fn = self._demoTriggerSS;
        self._demoTriggerSS = null; // fire exactly once
        try { fn(); } catch (e) { console.warn("[demo] _ssEnter failed:", e); }
      } else {
        setTimeout(tryEnter, 100);
      }
    };
    tryEnter();
  };

  ScreensaverUI.prototype.getScreensaverActive = function () {
    return this._screensaverActive;
  };

  return ScreensaverUI;
});
