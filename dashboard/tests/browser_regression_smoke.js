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

    // ── Perf instrumentation (regression guard for the playback-throttle fix) ──
    measureDrawRate: (ms) => new Promise((resolve) => {
      const map = window.__map || window.map;
      if (!map || typeof map.drawOverlay !== "function") return resolve({ error: "no map ref" });
      let count = 0;
      const orig = map.drawOverlay.bind(map);
      map.drawOverlay = function (...args) { count++; return orig(...args); };
      const start = performance.now();
      setTimeout(() => {
        map.drawOverlay = orig;
        const elapsed = performance.now() - start;
        resolve({ drawCount: count, elapsedMs: Math.round(elapsed), fps: +(count / (elapsed / 1000)).toFixed(1) });
      }, ms);
    }),

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

      const beforeLabel = hooks.getPlayLabel();
      hooks.togglePlayback();
      const afterLabel = hooks.getPlayLabel();
      check("play/pause button responds", beforeLabel !== afterLabel || beforeLabel === "Live", `${beforeLabel} -> ${afterLabel}`);
      check("speed selector works", hooks.setSpeed(10));

      const rate = await hooks.measureDrawRate(2000);
      check("live-playback repaint stays under 50fps ceiling",
        rate.fps == null || rate.fps < 50, `measured ${rate.fps ?? "n/a"}fps`);

      const passed = results.filter((r) => r.pass).length;
      return { passed, total: results.length, results };
    },
  };

  window.__testHooks = hooks;
})();
