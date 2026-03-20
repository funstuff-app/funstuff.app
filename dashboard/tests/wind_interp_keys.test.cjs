const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

function minToKey(m) {
  const h = Math.floor(m / 60) % 24;
  const mn = m % 60;
  return String(h).padStart(2, "0") + String(mn).padStart(2, "0");
}

function windKeys(epochMs) {
  const d = new Date(epochMs);
  const totalMinUTC = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  const floorMin = Math.floor(totalMinUTC / 15) * 15;
  const ceilMin = floorMin + 15;
  const keyFloor = minToKey(floorMin);
  const keyCeil = minToKey(ceilMin);
  const alpha = (totalMinUTC - floorMin) / 15;
  return { keyFloor, keyCeil, alpha };
}

describe("wind interpolation key computation", () => {
  it("mid-hour (21:47:30) → 2145/2200", () => {
    const r = windKeys(Date.UTC(2026, 2, 20, 21, 47, 30));
    assert.equal(r.keyFloor, "2145");
    assert.equal(r.keyCeil, "2200");
    assert.ok(r.alpha > 0.16 && r.alpha < 0.18, `alpha=${r.alpha}`);
  });

  it("minute >= 45 (21:58:00) → 2145/2200", () => {
    const r = windKeys(Date.UTC(2026, 2, 20, 21, 58, 0));
    assert.equal(r.keyFloor, "2145");
    assert.equal(r.keyCeil, "2200");
    assert.ok(r.alpha > 0.86 && r.alpha < 0.88, `alpha=${r.alpha}`);
  });

  it("midnight wrap (23:50:00) → 2345/0000", () => {
    const r = windKeys(Date.UTC(2026, 2, 20, 23, 50, 0));
    assert.equal(r.keyFloor, "2345");
    assert.equal(r.keyCeil, "0000");
    assert.ok(r.alpha > 0.33 && r.alpha < 0.34, `alpha=${r.alpha}`);
  });

  it("exact boundary (14:30:00) → 1430/1445, alpha=0", () => {
    const r = windKeys(Date.UTC(2026, 2, 20, 14, 30, 0));
    assert.equal(r.keyFloor, "1430");
    assert.equal(r.keyCeil, "1445");
    assert.ok(r.alpha < 0.001, `alpha=${r.alpha}`);
  });

  it("normal case (09:07:00) → 0900/0915", () => {
    const r = windKeys(Date.UTC(2026, 2, 20, 9, 7, 0));
    assert.equal(r.keyFloor, "0900");
    assert.equal(r.keyCeil, "0915");
    assert.ok(r.alpha > 0.46 && r.alpha < 0.48, `alpha=${r.alpha}`);
  });
});
