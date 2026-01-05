const test = require("node:test");
const assert = require("node:assert/strict");

const logic = require("../camera_fit_logic.js");

function iso(ms) {
  return new Date(ms).toISOString();
}

test("collectBoundsForMobilesNewSegment includes segment crossing windowStart", () => {
  const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
  const trail = [
    { lat: 40.0, lon: -111.0, t: iso(t0 + 0), m: 1 },
    { lat: 40.01, lon: -111.01, t: iso(t0 + 10_000), m: 1 },
    { lat: 40.02, lon: -111.02, t: iso(t0 + 20_000), m: 1 },
  ];

  const mobiles = [{ id: "A", ghosted: false, trail }];
  const bb = logic.collectBoundsForMobilesNewSegment(mobiles, t0 + 15_000, t0 + 25_000, {
    includeDebugPath: false,
    minTrailLengthM: 50,
    maxSegmentPoints: 100,
  });

  assert.equal(bb.visibleVehicleCount, 1);
  assert.ok(bb.visiblePointCount >= 2);
  assert.ok(bb.minLat <= 40.01);
  assert.ok(bb.maxLat >= 40.02);
});

test("collectBoundsForMobilesNewSegment ignores jitter-only trails", () => {
  const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
  // ~1-2m jitter
  const trail = [
    { lat: 40.0, lon: -111.0, t: iso(t0 + 0), m: 1 },
    { lat: 40.00001, lon: -111.00001, t: iso(t0 + 10_000), m: 1 },
    { lat: 40.00002, lon: -111.00002, t: iso(t0 + 20_000), m: 1 },
  ];

  const mobiles = [{ id: "J", ghosted: false, trail }];
  const bb = logic.collectBoundsForMobilesNewSegment(mobiles, t0 + 15_000, t0 + 25_000, {
    includeDebugPath: false,
    minTrailLengthM: 50,
  });

  assert.equal(bb.visibleVehicleCount, 0);
  assert.equal(bb.visiblePointCount, 0);
});

test("boundsSignature is stable under tiny changes", () => {
  const a = { minLat: 40.00001, minLon: -111.00001, maxLat: 40.00009, maxLon: -111.00009 };
  const b = { minLat: 40.00002, minLon: -111.00002, maxLat: 40.00008, maxLon: -111.00008 };
  const s1 = logic.boundsSignature(a, 1e-4);
  const s2 = logic.boundsSignature(b, 1e-4);
  assert.equal(s1, s2);
});

test("vehicles with no window-moving points contribute only a short recent segment", () => {
  const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
  // Moving far in the past, but no moving points inside the update window.
  const trail = [
    { lat: 40.0, lon: -111.0, t: iso(t0 + 0), m: 1 },
    { lat: 40.02, lon: -111.02, t: iso(t0 + 10_000), m: 1 },
    { lat: 40.04, lon: -111.04, t: iso(t0 + 20_000), m: 1 },
    { lat: 40.06, lon: -111.06, t: iso(t0 + 30_000), m: 1 },
  ];

  const mobiles = [{ id: "B", ghosted: false, trail }];
  const windowStart = t0 + 1_000_000; // far after the last point
  const windowEnd = t0 + 1_010_000;

  const bb = logic.collectBoundsForMobilesNewSegment(mobiles, windowStart, windowEnd, {
    includeDebugPath: false,
    minTrailLengthM: 50,
    maxSegmentPoints: 100,
  });

  // Still eligible (trail shows real movement), but segment should be bounded and non-empty.
  assert.equal(bb.visibleVehicleCount, 1);
  assert.ok(bb.visiblePointCount >= 2);
});
