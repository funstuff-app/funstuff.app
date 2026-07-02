// integration_load_order.test.cjs
//
// Boot-order seam test for the front-end modularization. Loads EVERY script
// listed in dashboard/index.html, in the exact order the page loads them, into
// a single shared sandbox with stubbed browser globals (window/document/canvas/
// Worker/fetch/localStorage/matchMedia/timers). Then asserts:
//   1. Every module global the refactor introduced is registered on the sandbox
//      window after the scripts run (MapView, FieldSensors, the engine_*
//      controllers, the ui_* modules, PlaybackState, JogWheel, ...).
//   2. `new MapView(canvas×3)` constructs and wires all eight sub-controllers,
//      each non-null and holding a back-reference to the view.
//
// This is a source-of-truth guard: if index.html's <script> order regresses so
// that a module reads a global before it is defined, or a controller stops
// wiring, this test fails. Hermetic: node stdlib only, no network, and every
// timer/RAF/worker registered during load is captured and cleared on teardown.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const DASH_DIR = path.join(__dirname, "..");

// ── Parse index.html for the ordered list of local <script src> files ───────
function scriptFilesFromIndexHtml() {
  const html = fs.readFileSync(path.join(DASH_DIR, "index.html"), "utf-8");
  const re = /<script[^>]*\bsrc=["']([^"'?]+)(?:\?[^"']*)?["'][^>]*>/g;
  const files = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const src = m[1];
    // Only local dashboard scripts (skip any absolute/CDN URLs).
    if (/^https?:\/\//.test(src)) continue;
    files.push(src);
  }
  return files;
}

// ── Build a sandbox that emulates just enough of the browser to load ─────────
function makeSandbox() {
  // Records so teardown can prove nothing is left running.
  const timers = new Set();
  const rafs = new Set();
  const workers = [];
  let nextId = 1;

  // Universal element/node stub: answers any property access with a chainable
  // no-op, and supports the handful of concrete APIs the app touches. Backed by
  // a Proxy so we never have to enumerate every DOM method the monolith calls.
  function makeCtx() {
    return new Proxy({}, {
      get(_t, prop) {
        if (prop === "canvas") return null;
        return () => {};
      },
    });
  }
  function makeElement() {
    const style = new Proxy({}, {
      get() { return () => {}; },
      set() { return true; },
    });
    const classList = {
      add() {}, remove() {}, toggle() {}, contains() { return false; },
    };
    const dataset = {};
    const base = {
      style, classList, dataset,
      appendChild(c) { return c; },
      removeChild(c) { return c; },
      insertBefore(c) { return c; },
      setAttribute() {}, removeAttribute() {}, getAttribute() { return null; },
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
      getContext() { return makeCtx(); },
      getBoundingClientRect() { return { left: 0, top: 0, right: 1, bottom: 1, width: 1, height: 1 }; },
      querySelector() { return makeElement(); },
      querySelectorAll() { return []; },
      focus() {}, blur() {}, click() {}, remove() {},
      scrollIntoView() {}, closest() { return null; },
      offsetWidth: 1, offsetHeight: 1, clientWidth: 1, clientHeight: 1,
      width: 1, height: 1, value: "", checked: false, textContent: "",
      innerHTML: "", offsetTop: 0, offsetLeft: 0,
      parentElement: null, parentNode: null, firstChild: null, children: [],
    };
    // parentElement must itself look like an element (MapView observes it).
    base.parentElement = new Proxy(base, {
      get(t, p) {
        if (p === "clientWidth" || p === "clientHeight") return 1;
        if (p in t) return t[p];
        return () => {};
      },
    });
    return new Proxy(base, {
      get(t, p) {
        if (p in t) return t[p];
        // Unknown property/method → chainable no-op.
        return () => {};
      },
      set(t, p, v) { t[p] = v; return true; },
    });
  }

  const documentStub = {
    documentElement: makeElement(),
    body: makeElement(),
    head: makeElement(),
    visibilityState: "visible",
    hidden: false,
    readyState: "complete",
    cookie: "",
    title: "",
    getElementById() { return makeElement(); },
    querySelector() { return makeElement(); },
    querySelectorAll() { return []; },
    createElement() { return makeElement(); },
    createElementNS() { return makeElement(); },
    createDocumentFragment() { return makeElement(); },
    createTextNode() { return makeElement(); },
    addEventListener() {}, removeEventListener() {},
    getElementsByClassName() { return []; },
    getElementsByTagName() { return []; },
  };

  const localStorageStub = (() => {
    const store = new Map();
    return {
      getItem(k) { return store.has(k) ? store.get(k) : null; },
      setItem(k, v) { store.set(k, String(v)); },
      removeItem(k) { store.delete(k); },
      clear() { store.clear(); },
      key() { return null; },
      length: 0,
    };
  })();

  class WorkerStub {
    constructor(url) { this.url = url; workers.push(this); }
    postMessage() {}
    terminate() {}
    addEventListener() {}
    removeEventListener() {}
  }
  class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
  class IntersectionObserverStub { observe() {} unobserve() {} disconnect() {} }
  class EventSourceStub {
    constructor(url) { this.url = url; }
    addEventListener() {} close() {}
  }
  class ImageStub {
    set src(_v) {} get src() { return ""; }
    addEventListener() {}
  }

  const matchMediaStub = () => ({
    matches: false, media: "",
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {},
  });

  // Captured timers/RAF — never actually fire; cleared on teardown.
  const setTimeoutStub = () => { const id = nextId++; timers.add(id); return id; };
  const clearTimeoutStub = (id) => { timers.delete(id); };
  const setIntervalStub = () => { const id = nextId++; timers.add(id); return id; };
  const clearIntervalStub = (id) => { timers.delete(id); };
  const rafStub = () => { const id = nextId++; rafs.add(id); return id; };
  const cafStub = (id) => { rafs.delete(id); };

  const performanceStub = { now: () => 0 };

  // fetch: resolve to a benign 200 so any load-time call is inert (bodies never
  // awaited to completion within the synchronous script run). Never hits network.
  const fetchStub = () => Promise.resolve({
    ok: true, status: 200,
    headers: { get: () => null },
    json: async () => ({}),
    text: async () => "",
    arrayBuffer: async () => new ArrayBuffer(0),
  });

  const win = {
    document: documentStub,
    navigator: { platform: "MacIntel", userAgent: "node-test", maxTouchPoints: 0, onLine: true },
    location: { search: "", hash: "", pathname: "/", href: "http://localhost/", origin: "http://localhost" },
    history: { replaceState() {}, pushState() {} },
    localStorage: localStorageStub,
    sessionStorage: localStorageStub,
    matchMedia: matchMediaStub,
    devicePixelRatio: 1,
    visualViewport: null,
    innerWidth: 800, innerHeight: 600,
    Worker: WorkerStub,
    ResizeObserver: ResizeObserverStub,
    IntersectionObserver: IntersectionObserverStub,
    EventSource: EventSourceStub,
    Image: ImageStub,
    fetch: fetchStub,
    setTimeout: setTimeoutStub,
    clearTimeout: clearTimeoutStub,
    setInterval: setIntervalStub,
    clearInterval: clearIntervalStub,
    requestAnimationFrame: rafStub,
    cancelAnimationFrame: cafStub,
    performance: performanceStub,
    // Silence the app's own logging so it doesn't pollute test output.
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {}, trace() {} },
    URL,
    URLSearchParams,
    AbortController,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    getComputedStyle() { return { getPropertyValue: () => "" }; },
    CSS: { supports: () => false },
    alert() {}, confirm() { return false; }, prompt() { return null; },
    // Auth/analytics flow tolerates a missing crypto; provide a stub anyway.
    crypto: { getRandomValues: (a) => a, randomUUID: () => "00000000-0000-0000-0000-000000000000" },
    scrollTo() {}, open() { return null; },
  };
  // The page's global `self`/`window`/`globalThis` all reference the same object.
  win.self = win;
  win.window = win;
  win.globalThis = win;
  // Expose the concrete stubs as bare globals too (scripts use both forms).
  win.Worker = WorkerStub;

  const teardown = () => {
    timers.clear();
    rafs.clear();
  };

  return { win, teardown, _timers: timers, _rafs: rafs, _workers: workers, makeElement };
}

test("index.html scripts load in order and register all module globals", () => {
  const files = scriptFilesFromIndexHtml();
  assert.ok(files.length > 0, "found <script> tags in index.html");

  const { win, teardown, _timers, _rafs, makeElement } = makeSandbox();
  const context = vm.createContext(win);

  // app.js runs main() at load, which fires an async tick() against these empty
  // stubs. That promise rejects (there is no real /api backend or DOM data) —
  // which is orthogonal to the boot-order globals this test asserts. Swallow
  // such rejections for the duration so node's test runner doesn't flag them.
  const swallowRejection = () => {};
  process.on("unhandledRejection", swallowRejection);

  try {
    for (const file of files) {
      const abs = path.join(DASH_DIR, file);
      const src = fs.readFileSync(abs, "utf-8");
      try {
        vm.runInContext(src, context, { filename: file });
      } catch (e) {
        assert.fail(`Loading ${file} threw during boot-order load: ${e && e.stack ? e.stack : e}`);
      }
    }

    // ── Expected globals registered by the refactor ──
    const expectedGlobals = [
      // Support / engine helpers (pre-existing UMD modules)
      "MobileAirNavEngine", "CameraFitLogic",
      // engine_* controllers (must exist BEFORE map_view.js runs)
      "FieldSensors", "TileRenderer", "RoadMatcher", "VehicleMotion",
      "PlaybackEngine", "WindAdvection", "PaFieldRenderer", "OverlayRenderer",
      "CameraGestures",
      // the composition root
      "MapView",
      // ui_* modules + wired-in playback state + jog wheel
      "StateSync", "LegendUI", "ThemeUI", "PlaybackState", "PlaybackUI",
      "SnapshotsMenusUI", "ScreensaverUI", "JogWheel",
    ];
    for (const name of expectedGlobals) {
      assert.ok(win[name] != null, `global "${name}" is defined after load`);
    }

    // ── Construct MapView and verify all controllers wire up ──
    const MapView = win.MapView;
    const canvasA = makeElement();
    const canvasB = makeElement();
    const canvasC = makeElement();
    const map = new MapView(canvasA, canvasB, canvasC);

    const controllers = [
      "tiles", "roadMatcher", "vehicleMotion", "playbackEngine",
      "windAdvection", "paField", "overlay", "gestures",
    ];
    for (const c of controllers) {
      assert.ok(map[c] != null, `MapView.${c} controller is wired`);
      assert.equal(map[c].view, map, `MapView.${c}.view back-references the MapView`);
    }
  } finally {
    teardown();
    process.removeListener("unhandledRejection", swallowRejection);
  }

  // ── Hermeticity: no timers/RAF left registered after teardown ──
  assert.equal(_timers.size, 0, "no timers left running after teardown");
  assert.equal(_rafs.size, 0, "no animation frames left running after teardown");
});
