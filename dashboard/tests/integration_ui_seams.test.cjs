// integration_ui_seams.test.cjs
//
// Seam tests for the ui_* modules extracted from app.js during the front-end
// modularization (stories A1–A6) plus the wired-in playback_state.js. Each
// module is require()d directly and exercised through ONE representative
// behavior with fake browser globals (fetch/localStorage/document supplied
// per-test, torn down afterward).
//
// Hermetic: node stdlib only, no real network, no timers left running.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// config.js is a plain (non-UMD) script that declares TILE_THEMES,
// THEME_STORAGE_KEY_*, MAX_TRAIL_LEN, etc. as top-level `var`s. Run it in the
// current global context so those names attach to globalThis — which is what
// the ui_* modules resolve `g` to under node (no `window`). No functions are
// invoked at load, so this has no side effects beyond the declarations.
vm.runInThisContext(
  fs.readFileSync(path.join(__dirname, "..", "config.js"), "utf-8"),
  { filename: "config.js" }
);

// parseUtcMs (format_utils.js) is consumed by StateSync's trail-timestamp
// helpers via `g.parseUtcMs`. Provide a minimal ISO-Z parser on the global.
if (typeof globalThis.parseUtcMs !== "function") {
  globalThis.parseUtcMs = function (t) {
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? ms : null;
  };
}

const StateSync = require("../ui_state_sync.js");
const ThemeUI = require("../ui_theme.js");
const LegendUI = require("../ui_legend.js");
const PlaybackState = require("../playback_state.js");

// ── Fake localStorage (installed/removed per test) ──────────────────────────
function makeLocalStorage() {
  const store = new Map();
  return {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    clear() { store.clear(); },
    _store: store,
  };
}

// ── StateSync: etag + delta-merge flow through fetchState ────────────────────
test("StateSync fetchState merges a delta and tracks etag/newest-trail", async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    if (calls.length === 1) {
      // First poll: full payload with one vehicle + one trail point.
      return {
        status: 200, ok: true,
        headers: { get: (h) => (h === "ETag" ? '"v1"' : null) },
        json: async () => ({
          ts: 1000,
          meta: {},
          fixed: [],
          mobile: [{ id: "m1", trail: [{ t: "2026-07-02T00:00:00Z", lat: 1, lon: 2 }] }],
        }),
      };
    }
    // Second poll: delta payload appending a new trail point to m1.
    return {
      status: 200, ok: true,
      headers: { get: (h) => (h === "ETag" ? '"v2"' : null) },
      json: async () => ({
        ts: 2000,
        meta: { delta: true },
        fixed: [],
        mobile: [{ id: "m1", trail: [{ t: "2026-07-02T00:01:00Z", lat: 3, lon: 4 }] }],
      }),
    };
  };

  const prevFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const ss = new StateSync({ apiBaseUrl: "/api", appToken: "tok" });

    const s1 = await ss.fetchState();
    assert.equal(s1.mobile[0].trail.length, 1, "first fetch stores full state");
    assert.equal(ss._stateEtag, '"v1"', "etag captured from first response");
    // Newest-trail tracking populates the since_ms cursor for the next poll.
    const newest = globalThis.parseUtcMs("2026-07-02T00:00:00Z");
    assert.equal(ss._newestTrailMs, newest, "newest trail ms tracked");

    const s2 = await ss.fetchState();
    assert.equal(s2.mobile[0].trail.length, 2, "delta appended to accumulated trail");
    assert.equal(ss._stateEtag, '"v2"', "etag updated from delta response");
    // Second request carried the delta cursor + If-None-Match header.
    assert.ok(calls[1].url.includes(`since_ms=${newest}`), "second poll requests only new points");
    assert.equal(calls[1].opts.headers["If-None-Match"], '"v1"', "conditional request sends prior etag");
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("StateSync fetchState honours 304 Not Modified without re-parsing", async () => {
  let jsonCalls = 0;
  const responses = [
    {
      status: 200, ok: true,
      headers: { get: () => '"e1"' },
      json: async () => { jsonCalls++; return { ts: 1, meta: {}, fixed: [], mobile: [] }; },
    },
    {
      status: 304, ok: false,
      headers: { get: () => null },
      json: async () => { jsonCalls++; return {}; },
    },
  ];
  let i = 0;
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => responses[i++];
  try {
    const ss = new StateSync({ apiBaseUrl: "/api", appToken: "tok" });
    const first = await ss.fetchState();
    const second = await ss.fetchState();
    assert.equal(second, first, "304 returns the cached accumulated state");
    assert.equal(ss.wasNotModified(), true, "wasNotModified flag set on 304");
    assert.equal(jsonCalls, 1, "304 body is not parsed");
  } finally {
    globalThis.fetch = prevFetch;
  }
});

// ── LegendUI: bracket HTML for a known set of legend rows ────────────────────
test("LegendUI bracket HTML groups consecutive same-category rows", () => {
  const prevLS = globalThis.localStorage;
  globalThis.localStorage = makeLocalStorage();
  try {
    // getElementById → null puts the legend in its no-DOM path; _wireEvents
    // no-ops. Only the pure bracket helpers are exercised.
    const doc = { getElementById: () => null };
    const legend = new LegendUI({
      document: doc,
      isMobileWidth: false,
      map: null,
      getSelectedId: () => null,
    });

    // Rows are ordered high→low; each row's `label` starts a category that spans
    // downward until the next labelled row (the module walks bottom-up).
    const entries = [
      { label: "Good", lo: 0, hi: 12 },
      { label: "", lo: 12, hi: 35 },
      { label: "Moderate", lo: 35, hi: 55 },
    ];
    const { catAssign, dimGroups } = legend._buildBracketInfo(entries);
    assert.deepEqual(catAssign, ["Good", "Moderate", "Moderate"], "labels propagate downward");
    assert.deepEqual(
      dimGroups,
      [{ name: "Good", startIdx: 0, endIdx: 0 }, { name: "Moderate", startIdx: 1, endIdx: 2 }],
      "consecutive same-category rows grouped"
    );

    // "Good" is a solo group → the Only bracket variant with its label.
    const soloHtml = legend._makeBracketHtml(0, dimGroups);
    assert.ok(soloHtml.includes("legendBracketOnly"), "solo row uses Only bracket");
    assert.ok(soloHtml.includes("Good"), "solo bracket carries category label");

    // First row of the two-row "Moderate" group is the Top bracket.
    const topHtml = legend._makeBracketHtml(1, dimGroups);
    assert.ok(topHtml.includes("legendBracketTop"), "group start uses Top bracket");
    // Last row of that group is the Bottom bracket.
    const botHtml = legend._makeBracketHtml(2, dimGroups);
    assert.ok(botHtml.includes("legendBracketBot"), "group end uses Bot bracket");
  } finally {
    globalThis.localStorage = prevLS;
  }
});

// ── ThemeUI: per-mode theme storage roundtrip ───────────────────────────────
test("ThemeUI saveThemeForMode / getSavedThemeForCurrentMode roundtrip", () => {
  const prevLS = globalThis.localStorage;
  const prevWindow = globalThis.window;
  const prevDoc = globalThis.document;
  globalThis.localStorage = makeLocalStorage();
  // ui_theme.js reads `window.matchMedia` (bare global) in isSystemDarkMode.
  // Force a deterministic (dark) system mode so the storage key is stable.
  globalThis.window = { matchMedia: () => ({ matches: true, addEventListener() {} }) };
  // config.js's applyMapFilterVars (invoked via the ThemeUI fallback path) reads
  // the bare global `document.documentElement`.
  globalThis.document = { documentElement: { style: { setProperty() {} } } };

  // Fake map + document sufficient for the ThemeUI constructor's no-UI path
  // (getElementById → null takes the fallback branch: applyThemeAndFilters).
  const setThemeCalls = [];
  const fakeMap = { themeKey: null, setTheme(k) { this.themeKey = k; setThemeCalls.push(k); } };
  const fakeDoc = {
    getElementById: () => null,
    documentElement: { style: { setProperty() {} } },
  };

  try {
    const theme = new ThemeUI({
      document: fakeDoc,
      map: fakeMap,
      setCurrentThemeKey() {},
      getUpdateThemeSubmenu: () => null,
    });

    // Nothing saved yet → default dark theme.
    assert.equal(theme.getSavedThemeForCurrentMode(), "carto_dark_all", "default when unsaved");

    theme.saveThemeForMode("carto_dark_nolabels");
    assert.equal(
      theme.getSavedThemeForCurrentMode(), "carto_dark_nolabels",
      "saved dark-mode theme is read back"
    );
    // Persisted under the dark key and the last-active mirror.
    assert.equal(globalThis.localStorage.getItem("mobileair.mapTheme.dark"), "carto_dark_nolabels");
    assert.equal(globalThis.localStorage.getItem("mobileair.mapTheme.last"), "carto_dark_nolabels");

    // Unknown saved theme falls back to the default, not the garbage value.
    globalThis.localStorage.setItem("mobileair.mapTheme.dark", "not_a_real_theme");
    assert.equal(theme.getSavedThemeForCurrentMode(), "carto_dark_all", "invalid saved theme ignored");
  } finally {
    globalThis.localStorage = prevLS;
    globalThis.window = prevWindow;
    globalThis.document = prevDoc;
  }
});

// ── PlaybackUI ↔ PlaybackState runway handoff ───────────────────────────────
// PlaybackUI's inline LIVE/runway math corresponds (per SPEC A4b) to
// PlaybackState's runwayStartMs/predictedRemainingSec. app.js constructs the
// PlaybackState against the same MapView the PlaybackUI holds. This exercises
// that shared-map seam with the same stub shape used by playback_state.test.cjs.
test("PlaybackState runway handoff computes runwayStart from the shared map", () => {
  const now = Date.now();
  const map = {
    _playbackMaxMs: now,           // data edge = wall clock now (for determinism)
    _playbackMinMs: now - 3600000, // 1h of history
    _playbackNowMs: now - 60000,
    _historicalMode: false,
    _playbackLiveFollow: false,
    _playbackSpeed: 2.0,
    lastState: null,
    getPlaybackBounds() { return { minMs: this._playbackMinMs, maxMs: this._playbackMaxMs }; },
    getPlaybackTimeMs() { return this._playbackNowMs; },
    setPlaybackTimeMs(t) { this._playbackNowMs = t; },
    getPlaybackSpeed() { return this._playbackSpeed; },
  };
  const ps = new PlaybackState(map);
  // Server predicts its next data update 120s out (absolute SSE timestamp).
  ps.serverNextUpdateTs = now + 120000;

  const remSec = ps.predictedRemainingSec();
  assert.ok(remSec >= 119 && remSec <= 121, `predictedRemainingSec ~120, got ${remSec}`);

  // runwayMs = remSec * 1000 * speed(2) ≈ 240000ms.
  const runwayMs = ps.runwayMs();
  assert.ok(runwayMs >= 238000 && runwayMs <= 242000, `runwayMs ~240000, got ${runwayMs}`);

  // runwayStart = dataEdge − runwayMs, clamped to bounds.minMs.
  const rs = ps.runwayStartMs();
  const expected = map._playbackMaxMs - runwayMs;
  assert.ok(Math.abs(rs - expected) <= 2000, `runwayStart ~dataEdge-runway, got ${rs}`);
  assert.ok(rs >= map._playbackMinMs, "runwayStart clamped to bounds min");
});
