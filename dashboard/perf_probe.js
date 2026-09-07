/**
 * perf_probe.js — on-screen render-pipeline probe. Enable with ?probe=1 (or
 * localStorage "mobileair.probe" = "1"). Off by default: zero cost.
 *
 * Wraps the hot methods and prints a one-line-per-second summary to the
 * console and to a fixed HUD (readable on iPad, where there is no console).
 * Columns are per second: rAF fps, long tasks (>50ms) count/ms, draw()
 * calls, overlay draws/ms, field ensure/kernel/collect ms, GL renders/ms,
 * overlay + field texture uploads, plus sensor/trail sizes and mode flags.
 */
(function () {
  "use strict";
  const g = (typeof window !== "undefined") ? window : globalThis;
  let on = false;
  try {
    on = new URLSearchParams(location.search).get("probe") === "1"
      || localStorage.getItem("mobileair.probe") === "1";
  } catch {}
  if (!on) return;

  const stats = {};
  function bump(label, dt) {
    const s = stats[label] || (stats[label] = { n: 0, ms: 0, max: 0 });
    s.n++; s.ms += dt; if (dt > s.max) s.max = dt;
  }
  function wrap(obj, name, label) {
    if (!obj) return;
    const orig = obj[name];
    if (typeof orig !== "function" || orig.__probed) return;
    const f = function (...a) {
      const t0 = performance.now();
      try { return orig.apply(this, a); }
      finally { bump(label, performance.now() - t0); }
    };
    f.__probed = true;
    obj[name] = f;
  }

  let frames = 0;
  let longTasks = 0, longMs = 0;
  let uploads = { overlay: 0, field: 0 };
  let hud = null;

  function install() {
    const mv = g.__map;
    if (!mv) return false;
    const MV = g.MapView && g.MapView.prototype;
    wrap(MV, "draw", "draw");
    wrap(MV, "drawTiles", "drawTiles");
    if (mv.overlay) {
      const OR = Object.getPrototypeOf(mv.overlay);
      wrap(OR, "drawOverlay", "overlay");
      wrap(OR, "_ensureOverlayStatic", "ovStatic");
      wrap(OR, "_updatePersistedTrails", "ovTrails");
    }
    if (mv.paField) {
      const PF = Object.getPrototypeOf(mv.paField);
      wrap(PF, "_ensurePaField", "field");
      wrap(PF, "_kernelGrid", "kernel");
      wrap(PF, "_paintPaCells", "paint");
      wrap(PF, "_compositePaFieldOnTiles", "composite");
    }
    if (g.FieldSensors) {
      wrap(g.FieldSensors, "_collectPaFieldSensors", "collectPa");
      wrap(g.FieldSensors, "_collectVirtualMobileSensors", "collectMob");
    }
    if (mv.playbackEngine) {
      const PE = Object.getPrototypeOf(mv.playbackEngine);
      wrap(PE, "_ensurePlaybackPoints", "pbPoints");
      wrap(PE, "_playbackSampleForMobile", "pbSample");
    }
    if (mv.mapgl) {
      wrap(g.MapGLRenderer.prototype, "sync", "glSync");
      wrap(g.MapGLRenderer.prototype, "_syncFieldCanvas", "glField");
      const glmap = mv.mapgl.map;
      if (glmap) {
        wrap(glmap, "_render", "glRender");
        const hookSource = (id, key) => {
          const s = glmap.getSource && glmap.getSource(id);
          if (!s || s.__probed) return false;
          const prep = s.prepare.bind(s);
          s.prepare = function () { if (this._playing) uploads[key]++; return prep(); };
          s.__probed = true;
          return true;
        };
        const tryHook = () => {
          const a = hookSource("sensor-overlay", "overlay");
          const b = hookSource("pa-field", "field");
          if (!(a && b)) glmap.once("render", tryHook);
        };
        tryHook();
      }
    }
    return true;
  }

  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) { longTasks++; longMs += e.duration; }
    });
    po.observe({ entryTypes: ["longtask"] });
  } catch {}

  function raf() { frames++; requestAnimationFrame(raf); }
  requestAnimationFrame(raf);

  function fmt(label) {
    const s = stats[label];
    if (!s) return `${label}=0`;
    return `${label}=${s.n}/${s.ms.toFixed(0)}ms(max ${s.max.toFixed(0)})`;
  }

  function report() {
    const mv = g.__map;
    const st = g._historicalState || g.__lastState || {};
    const mobiles = Array.isArray(st.mobile) ? st.mobile : [];
    const trailPts = mobiles.reduce((a, m) => a + ((m && m.trail) ? m.trail.length : 0), 0);
    const fixed = Array.isArray(st.fixed) ? st.fixed.length : 0;
    const is3d = !!(mv && mv.mapgl && mv.mapgl.active);
    const flags = [
      is3d ? "3D" : "2D",
      mv && mv._historicalMode ? "hist" : "live",
      mv && mv._playbackPlaying ? "playing" : "paused",
      mv && mv._isGesturing && mv._isGesturing() ? "GESTURE" : "",

    ].filter(Boolean).join(" ");
    const size = mv ? `${mv._cssW}x${mv._cssH}@${mv._dpr}` : "";
    const line = [
      `fps=${frames}`,
      `long=${longTasks}/${longMs.toFixed(0)}ms`,
      fmt("draw"), fmt("overlay"), fmt("ovTrails"), fmt("ovStatic"),
      fmt("field"), fmt("kernel"), fmt("collectPa"), fmt("collectMob"), fmt("composite"),
      fmt("pbSample"), fmt("pbPoints"),
      fmt("glSync"), fmt("glRender"), `upl=ov${uploads.overlay}/fld${uploads.field}`,
      `fixed=${fixed} mob=${mobiles.length} trailPts=${trailPts} ${size} ${flags}`,
    ].join("  ");
    console.log("[PROBE] " + line);
    if (!hud) {
      hud = document.createElement("pre");
      hud.id = "perfProbeHud";
      hud.style.cssText = "position:fixed;left:4px;bottom:64px;z-index:99999;margin:0;padding:6px 8px;"
        + "font:11px/1.35 ui-monospace,Menlo,monospace;color:#dfe;background:rgba(0,0,0,.72);"
        + "white-space:pre-wrap;max-width:96vw;pointer-events:none;border-radius:6px";
      document.body.appendChild(hud);
    }
    hud.textContent = line.replace(/  /g, "\n");
    for (const k of Object.keys(stats)) delete stats[k];
    frames = 0; longTasks = 0; longMs = 0; uploads = { overlay: 0, field: 0 };
  }

  const start = () => {
    if (!install()) { setTimeout(start, 250); return; }
    setInterval(report, 1000);
  };
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start);
})();
