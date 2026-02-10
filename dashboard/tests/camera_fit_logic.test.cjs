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

test("vehicles with no window-moving points are excluded from bounds", () => {
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

  // No moving points in the update window → vehicle should be excluded entirely.
  assert.equal(bb.visibleVehicleCount, 0);
  assert.equal(bb.visiblePointCount, 0);
});

test("idle vehicle excluded while active vehicle is included", () => {
  const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
  // Active vehicle: has moving points in the window
  const activeTrail = [
    { lat: 40.7, lon: -111.9, t: iso(t0 + 0), m: 1 },
    { lat: 40.71, lon: -111.91, t: iso(t0 + 10_000), m: 1 },
    { lat: 40.72, lon: -111.92, t: iso(t0 + 20_000), m: 1 },
  ];
  // Idle vehicle: all points well before the window (>5 min stale), far away
  const idleTrail = [
    { lat: 39.0, lon: -112.5, t: iso(t0 - 600_000), m: 1 },
    { lat: 39.01, lon: -112.51, t: iso(t0 - 590_000), m: 1 },
    { lat: 39.02, lon: -112.52, t: iso(t0 - 580_000), m: 1 },
  ];

  const mobiles = [
    { id: "ACTIVE", ghosted: false, trail: activeTrail },
    { id: "IDLE", ghosted: false, trail: idleTrail },
  ];
  const bb = logic.collectBoundsForMobilesNewSegment(mobiles, t0 + 5_000, t0 + 25_000, {
    minTrailLengthM: 50,
  });

  // Only the active vehicle should contribute
  assert.equal(bb.visibleVehicleCount, 1);
  // Bounds should be near the active vehicle, not dragged south
  assert.ok(bb.minLat >= 40.5, `minLat ${bb.minLat} should be >= 40.5 (not dragged to idle vehicle at 39.0)`);
});

test("long trail is capped by maxSegmentLengthM", () => {
  const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
  // Build a long trail: 100 points spanning ~50km (0.005° lat ≈ 556m per step)
  const trail = [];
  for (let i = 0; i < 100; i++) {
    trail.push({ lat: 40.0 + i * 0.005, lon: -111.9, t: iso(t0 + i * 1000), m: 1 });
  }

  const mobiles = [{ id: "LONG", ghosted: false, trail }];
  const bb = logic.collectBoundsForMobilesNewSegment(mobiles, t0, t0 + 200_000, {
    minTrailLengthM: 50,
    maxSegmentLengthM: 5000, // 5km cap
  });

  assert.equal(bb.visibleVehicleCount, 1);
  // The lat range should be capped well below the full 0.5° span
  const latSpan = bb.maxLat - bb.minLat;
  assert.ok(latSpan < 0.15, `lat span ${latSpan} should be < 0.15° (~16km) with 5km cap`);
});

test("ignores short out-and-back moving sliver (GPS noise) even if m=1", () => {
  const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
  // Artificial sliver: jump out and back, producing path length but low displacement.
  const trail = [
    { lat: 40.0, lon: -111.0, t: iso(t0 + 0), m: 1 },
    { lat: 40.001, lon: -111.0, t: iso(t0 + 10_000), m: 1 },
    { lat: 40.0, lon: -111.0, t: iso(t0 + 20_000), m: 1 },
  ];

  const mobiles = [{ id: "S", ghosted: false, trail }];
  const bb = logic.collectBoundsForMobilesNewSegment(mobiles, t0 + 5_000, t0 + 25_000, {
    includeDebugPath: false,
    // Keep overall trail eligibility permissive...
    minTrailLengthM: 50,
    // ...but require enough displacement/straightness to count as a real segment.
    minVisibleSegmentPoints: 3,
    minVisibleSegmentLengthM: 100,
    minVisibleSegmentDisplacementM: 80,
    minVisibleSegmentStraightness: 0.3,
  });

  assert.equal(bb.visibleVehicleCount, 0);
  assert.equal(bb.visiblePointCount, 0);
});

test("vehicle with recent points just before windowStart is included", () => {
  const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
  // Vehicle reporting every 30s. Most recent point is 5s before windowStart,
  // but well within 5 min of windowEnd — this vehicle is actively moving.
  const trail = [
    { lat: 40.0, lon: -111.0, t: iso(t0 + 0), m: 1 },
    { lat: 40.01, lon: -111.01, t: iso(t0 + 30_000), m: 1 },
    { lat: 40.02, lon: -111.02, t: iso(t0 + 60_000), m: 1 },
    { lat: 40.03, lon: -111.03, t: iso(t0 + 90_000), m: 1 },
  ];

  const mobiles = [{ id: "NEAR", ghosted: false, trail }];
  // Window starts just after the last point
  const windowStart = t0 + 95_000;
  const windowEnd = t0 + 125_000;

  const bb = logic.collectBoundsForMobilesNewSegment(mobiles, windowStart, windowEnd, {
    minTrailLengthM: 50,
  });

  // Should be included: most recent point (t0+90s) is only 35s before windowEnd
  assert.equal(bb.visibleVehicleCount, 1);
  assert.ok(bb.visiblePointCount >= 2);
});
