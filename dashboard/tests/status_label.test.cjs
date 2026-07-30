// status_label.test.cjs
//
// Regression coverage for the stuck-"Offline" bug: one failed poll set the
// topbar label to Offline, then every SSE delta rescheduled the recovery
// poll another POLL_MS_SSE (10 min) into the future via rescheduleTick, so
// the only code path that repainted the label never ran — the map kept
// updating over SSE while the label said Offline indefinitely. The fix adds
// an onServerAlive cfg hook (called on SSE open + each accepted delta) that
// repaints the label from StateSync.computeStatusLabel, the same pure
// function tick()'s 200 and 304 paths now use.
//
// Hermetic: node stdlib only.

const test = require("node:test");
const assert = require("node:assert/strict");

const StateSync = require("../ui_state_sync.js");

test("computeStatusLabel: empty/absent state is Loading", () => {
  assert.deepEqual(StateSync.computeStatusLabel(null),
    { text: "Loading...", live: false, offline: false });
  assert.deepEqual(StateSync.computeStatusLabel({ mobile: [], fixed: [], meta: {} }),
    { text: "Loading...", live: false, offline: false });
});

test("computeStatusLabel: fresh data is Live (clears offline)", () => {
  const s = StateSync.computeStatusLabel({ mobile: [{ id: "BUS03" }], fixed: [], meta: {} });
  assert.deepEqual(s, { text: "Live", live: true, offline: false });
});

test("computeStatusLabel: stale data reports age and keeps offline styling", () => {
  const st = { mobile: [], fixed: [{ id: "Hawthorne" }], meta: { data_stale: true, data_age_s: 7500 } };
  assert.deepEqual(StateSync.computeStatusLabel(st),
    { text: "Stale (2h old)", live: false, offline: true });
  const stMin = { mobile: [], fixed: [{ id: "Hawthorne" }], meta: { data_stale: true, data_age_s: 480 } };
  assert.deepEqual(StateSync.computeStatusLabel(stMin),
    { text: "Stale (8m old)", live: false, offline: true });
});

test("delta-handler contract: label recomputes Live from a merged state", () => {
  // The wiring (cfg.onServerAlive → updateStatusIndicator) lives in app.js's
  // closure and needs a DOM; this asserts the data contract it depends on:
  // a state that just received a delta computes to Live, so the hook's
  // repaint clears "Offline" rather than leaving it in place.
  const acc = { mobile: [{ id: "BUS03", trail: [] }], fixed: [], meta: {} };
  const delta = { ts: 2, meta: {}, fixed: [{ id: "Hawthorne" }], mobile: [] };
  StateSync._mergeStateDelta(acc, delta);
  const s = StateSync.computeStatusLabel(acc);
  assert.equal(s.text, "Live");
  assert.equal(s.offline, false);
});
