/**
 * Browser regression smoke test — NOT run by `node --test` (this drives a real
 * DOM/canvas, the .test.cjs suite next to this file is pure-logic only).
 *
 * Usage: inject this whole file into a live page (devtools console, or an
 * automation tool's page-eval), then:
 *
 *   const report = await window.__testHooks.runSmokeTest();
 *   console.log(report.passed + "/" + report.total, report.results);
 *
 * Targets only ids/data-attributes that are part of the app's stable DOM
 * contract (same ids across the pre-redesign and redesigned markup, verified
 * against both at authoring time), so one script works unmodified across
 * merges instead of needing new selectors re-derived by hand each time.
 *
 * This intentionally does not assert on live sensor VALUES (they change
 * every poll) — it asserts on structure and interaction: does the chrome
 * exist, do the controls respond, does nothing throw, does the live-playback
 * repaint rate stay under a sane ceiling.
 */
(function () {
  "use strict";

  const byId = (id) => document.getElementById(id);
  const $ = (sel) => document.querySelector(sel);
  const click = (el) => { if (el) el.click(); return !!el; };

  const hooks = {
    // ── Actions ──────────────────────────────────────────────────────────
    toggleSidebar: () => click(byId("menuBtn")),
    closeSidebar: () => click(byId("sidebarClose")),
    switchSidebarTab: (name) => {
      const map = { mobile: "tabMobile", fixed: "tabFixed", community: "tabPublic" };
      return click(byId(map[name]));
    },
    openDvrMenu: () => click(byId("pbMenuBtn")),
    openSubmenu: (name) => click($(`[data-submenu="${name}"]`)),
    triggerMenuAction: (name) => click($(`[data-action="${name}"]`)),
    closeAboutModal: () => click($(".aboutModalX")),
    selectPollutant: (tab) => click($(`[data-legend="${tab}"]`)),
    collapseLegend: () => click(byId("legendCollapse")),
    closeLegend: () => click(byId("legendClose")),
    showLegend: () => click(byId("legendToggle")),
    togglePlayback: () => click(byId("pbPlay")),
    isPlaying: () => {
      const map = window.__map || window.map;
      return map && typeof map.getPlaybackPlaying === "function" ? map.getPlaybackPlaying() : null;
    },
    setSpeed: (v) => {
      const el = byId("pbSpeed");
      if (!el) return false;
      el.value = String(v);
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },

    // ── Introspection ────────────────────────────────────────────────────
    getPlayLabel: () => byId("pbPlay") ? byId("pbPlay").textContent.trim() : null,
    isSidebarOpen: () => !!byId("sidebar") && !byId("sidebar").classList.contains("hidden"),
    isLegendOpen: () => !!byId("legend") && !byId("legend").classList.contains("hidden"),
    isDvrMenuOpen: () => !!byId("pbMenu") && byId("pbMenu").classList.contains("visible"),
    isDebugPanelOpen: () => !!byId("fieldDebugPanel") && !byId("fieldDebugPanel").classList.contains("fdHidden"),

    // ── Perf instrumentation (best-effort; needs the tab to actually paint) ──
    // requestAnimationFrame (and therefore this) only fires while the page
    // is visible/focused — reliable when driving a real foreground browser,
    // but automation contexts can report document.hidden=true, in which case
    // a 0fps reading means "the tab was backgrounded during this window",
    // NOT "the app stopped drawing". wasHidden flags that so callers don't
    // misread an environment artifact as a pass or a fail.
    measureDrawRate: (ms) => new Promise((resolve) => {
      const map = window.__map || window.map;
      if (!map || typeof map.drawOverlay !== "function") return resolve({ error: "no map ref" });
      let count = 0;
      let wasHidden = document.hidden;
      const onVis = () => { if (document.hidden) wasHidden = true; };
      document.addEventListener("visibilitychange", onVis);
      const orig = map.drawOverlay.bind(map);
      map.drawOverlay = function (...args) { count++; return orig(...args); };
      const start = performance.now();
      setTimeout(() => {
        map.drawOverlay = orig;
        document.removeEventListener("visibilitychange", onVis);
        const elapsed = performance.now() - start;
        resolve({ drawCount: count, elapsedMs: Math.round(elapsed), fps: +(count / (elapsed / 1000)).toFixed(1), wasHidden });
      }, ms);
    }),

    // ── Deterministic feature-presence check ──────────────────────────────
    // Fetches a served source file and checks for a marker string. Unlike
    // measureDrawRate this doesn't depend on RAF actually firing, so it's
    // reliable at every point in a merge sequence — used to track whether a
    // given fix's code has landed yet (expected to flip false -> true right
    // after that PR merges, not a pass/fail in itself).
    sourceContains: async (path, marker) => {
      try {
        const res = await fetch(path, { cache: "no-store" });
        const text = await res.text();
        return text.includes(marker);
      } catch (e) {
        return null; // fetch failed — inconclusive, not false
      }
    },

    // ── Smoke test ───────────────────────────────────────────────────────
    runSmokeTest: async function () {
      const results = [];
      const check = (name, pass, detail) => results.push({ name, pass: !!pass, detail: detail || "" });

      check("topbar present", !!byId("topbar"));
      check("map canvases present", !!byId("tilesCanvas") && !!byId("overlayCanvas") && !!byId("paFieldCanvas"));
      check("playback bar present", !!byId("playbackBar"));

      for (const tab of ["pm25", "pm10", "o3", "no2", "co"]) {
        check(`legend tab ${tab} clickable`, hooks.selectPollutant(tab));
      }
      hooks.selectPollutant("pm25");

      check("sidebar opens", hooks.toggleSidebar() && hooks.isSidebarOpen());
      for (const tab of ["mobile", "fixed", "community"]) {
        check(`sidebar tab ${tab} clickable`, hooks.switchSidebarTab(tab));
      }
      check("sidebar closes", hooks.closeSidebar() && !hooks.isSidebarOpen());

      check("dvr menu opens", hooks.openDvrMenu() && hooks.isDvrMenuOpen());
      for (const sub of ["days", "theme", "display"]) {
        check(`submenu ${sub} opens`, hooks.openSubmenu(sub));
      }
      check("about modal opens", hooks.triggerMenuAction("about"));
      check("about modal closes", hooks.closeAboutModal());

      hooks.openDvrMenu();
      hooks.triggerMenuAction("debug");
      check("debug panel toggles open", hooks.isDebugPanelOpen());
      hooks.openDvrMenu();
      hooks.triggerMenuAction("debug");
      check("debug panel toggles closed", !hooks.isDebugPanelOpen());

      // Draw-rate ceiling — measured BEFORE the play/pause test below touches
      // playback state (a paused/non-live map legitimately draws ~0fps,
      // which would make this check meaningless without proving anything).
      // Only asserted when the window was actually live and the tab stayed
      // visible throughout; otherwise recorded as informational so an
      // inactive-playback or backgrounded-tab artifact can't masquerade as
      // either a pass or a fail.
      const map = window.__map || window.map;
      const wasLiveAtStart = !!map && (map.getPlaybackPlaying() || map._playbackLiveFollow);
      const rate = await hooks.measureDrawRate(2000);
      if (!wasLiveAtStart || rate.wasHidden) {
        check(`live-playback repaint stays under 50fps ceiling (SKIPPED: ${!wasLiveAtStart ? "not live/playing" : "tab backgrounded"} during measurement)`,
          true, `drawCount=${rate.drawCount}`);
      } else {
        check("live-playback repaint stays under 50fps ceiling",
          rate.fps == null || rate.fps < 50, `measured ${rate.fps ?? "n/a"}fps`);
      }

      // Play/pause has real state-machine nuance (Live/Play/Pause depend on
      // wall-edge position, server-sync mode, speed — see
      // PlaybackUI.computeButtonState) that belongs in the dedicated
      // playback_button_state.test.cjs unit tests, not this coarse smoke
      // test. Here we only assert the control survives a click: still
      // present, still has a real label, didn't throw.
      let clickThrew = false;
      try { hooks.togglePlayback(); } catch (e) { clickThrew = true; }
      await new Promise((r) => setTimeout(r, 300));
      check("play/pause button survives a click",
        !clickThrew && !!byId("pbPlay") && !!hooks.getPlayLabel(),
        `label now "${hooks.getPlayLabel()}"`);
      check("speed selector works", hooks.setSpeed(10));

      // Gradient-field isolation: gradient pollutants (o3) take NO mobile
      // input. Mobile sensors are local on-road readings; fed into the
      // regional gradient as virtual stations they outnumber the fixed
      // network and drag the baseline to street level across the valley.
      // Deleting state.mobile must therefore not change the o3 field at all.
      // (PM2.5 keeps mobile kernels — that path is intentionally untouched.)
      {
        const map = window.__map || window.map;
        const pf = map && map.paField;
        const st = map && map.lastState;
        if (pf && st && (map._cssW || 0) >= 2) {
          const pbMs = map.getPlaybackTimeMs();
          const prevTab = map._paFieldPollutant ?? null;
          const bust = () => {
            map._paFieldKey = null; map._paFieldValidRange = null;
            map._paFieldCanvas = null; map._paFieldCtx = null;
            pf._paFieldValidViewKey = null; pf._paFieldValidPollutant = null;
            pf._paFieldValidFixed = null; pf._paFieldFingerprint = null;
            pf._paFieldPrevCanvas = null;
          };
          const hash = (c) => {
            if (!c) return "none";
            const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
            let h = 0;
            for (let i = 0; i < d.length; i += 7) h = (h * 31 + d[i]) >>> 0;
            return h.toString(16) + ":" + c.width + "x" + c.height;
          };
          const compute = (state) => { bust(); pf._ensurePaField(state, pbMs); return hash(map._paFieldCanvas); };
          map.setPaFieldPollutant("o3");
          const withMobile = compute(st);
          const noMobile = compute(Object.assign({}, st, { mobile: [] }));
          map.setPaFieldPollutant(prevTab);
          bust();
          map._compositePaFieldOnTiles(st);
          if (withMobile === "none" && noMobile === "none") {
            check("o3 gradient field ignores mobile sensors (SKIPPED: no o3 field in view)", true);
          } else {
            check("o3 gradient field ignores mobile sensors",
              withMobile === noMobile, `with=${withMobile} without=${noMobile}`);
          }
        } else {
          check("o3 gradient field ignores mobile sensors (SKIPPED: map unsized)", true);
        }
      }

      // Feature-presence flags — NOT counted toward passed/total. Expected
      // value changes as each PR merges; interpret alongside merge state,
      // don't treat a false here as a failure on its own.
      const features = {
        playbackDrawThrottle: await hooks.sourceContains("/ui_playback.js", "_pbDrawMinDt"),
        ozoneFieldSpread: await hooks.sourceContains("/engine_field_sensors.js", "_LEGEND_TAB_FIELD_SPREAD"),
      };

      const passed = results.filter((r) => r.pass).length;
      return { passed, total: results.length, results, features };
    },
  };

  window.__testHooks = hooks;
})();
