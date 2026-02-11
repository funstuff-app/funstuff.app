const test = require("node:test");
const assert = require("node:assert/strict");

const logic = require("../camera_fit_logic.js");

function iso(ms) {
  return new Date(ms).toISOString();
}

test("collectBoundsForMobilesNewSegment includes points within the update window", () => {
  const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
  const trail = [
    { lat: 40.0, lon: -111.0, t: iso(t0 + 0), m: 1 },
    { lat: 40.01, lon: -111.01, t: iso(t0 + 10_000), m: 1 },
    { lat: 40.02, lon: -111.02, t: iso(t0 + 20_000), m: 1 },
    { lat: 40.03, lon: -111.03, t: iso(t0 + 30_000), m: 1 },
  ];

  const mobiles = [{ id: "A", ghosted: false, trail }];
  // Window covers last two points
  const bb = logic.collectBoundsForMobilesNewSegment(mobiles, t0 + 15_000, t0 + 35_000, {
    includeDebugPath: false,
    minTrailLengthM: 50,
    maxSegmentPoints: 100,
  });

  assert.equal(bb.visibleVehicleCount, 1);
  assert.ok(bb.visiblePointCount >= 2);
  // Should only include points in the window, not pre-window ones
  assert.ok(bb.minLat >= 40.019, `minLat ${bb.minLat} should be >= 40.019 (pre-window points excluded)`);
  assert.ok(bb.maxLat >= 40.03);
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

test("vehicle with all points before windowStart is excluded", () => {
  const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
  // Vehicle reporting every 30s. All points are before the update window.
  const trail = [
    { lat: 40.0, lon: -111.0, t: iso(t0 + 0), m: 1 },
    { lat: 40.01, lon: -111.01, t: iso(t0 + 30_000), m: 1 },
    { lat: 40.02, lon: -111.02, t: iso(t0 + 60_000), m: 1 },
    { lat: 40.03, lon: -111.03, t: iso(t0 + 90_000), m: 1 },
  ];

  const mobiles = [{ id: "NEAR", ghosted: false, trail }];
  const windowStart = t0 + 95_000;
  const windowEnd = t0 + 125_000;

  const bb = logic.collectBoundsForMobilesNewSegment(mobiles, windowStart, windowEnd, {
    minTrailLengthM: 50,
  });

  // No points in the update window — vehicle should be excluded
  assert.equal(bb.visibleVehicleCount, 0);
  assert.equal(bb.visiblePointCount, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// collectRecentSegmentPerVehicle + collectRobustLiveBounds
// ─────────────────────────────────────────────────────────────────────────────

test("collectRecentSegmentPerVehicle collects moving points from trail tail", () => {
  const trail = [
    { lat: 40.0, lon: -111.0, m: 0 },  // stationary gap
    { lat: 40.01, lon: -111.01, m: 1 },
    { lat: 40.02, lon: -111.02, m: 1 },
    { lat: 40.03, lon: -111.03, m: 1 },
  ];
  const mobiles = [{ id: "A", ghosted: false, trail }];
  const segs = logic.collectRecentSegmentPerVehicle(mobiles, { minTrailLengthM: 50 });

  assert.equal(segs.length, 1);
  assert.equal(segs[0].id, "A");
  // Should collect the 3 moving points, NOT the m=0 point
  assert.equal(segs[0].points.length, 3);
  assert.ok(segs[0].centroidLat > 40.0);
});

test("collectRecentSegmentPerVehicle stops at non-moving gap", () => {
  const trail = [
    { lat: 40.0, lon: -111.0, m: 1 },
    { lat: 40.01, lon: -111.01, m: 1 },
    { lat: 40.015, lon: -111.015, m: 0 }, // gap
    { lat: 40.02, lon: -111.02, m: 1 },
    { lat: 40.03, lon: -111.03, m: 1 },
  ];
  const mobiles = [{ id: "B", ghosted: false, trail }];
  const segs = logic.collectRecentSegmentPerVehicle(mobiles, { minTrailLengthM: 50 });

  assert.equal(segs.length, 1);
  // Should only have the last 2 moving points (stops at m=0 gap)
  assert.equal(segs[0].points.length, 2);
});

test("collectRecentSegmentPerVehicle respects maxSegmentLengthM", () => {
  // 50 points, each ~556m apart → ~28km total
  const trail = [];
  for (let i = 0; i < 50; i++) {
    trail.push({ lat: 40.0 + i * 0.005, lon: -111.9, m: 1 });
  }
  const mobiles = [{ id: "LONG", ghosted: false, trail }];
  const segs = logic.collectRecentSegmentPerVehicle(mobiles, {
    minTrailLengthM: 50,
    maxSegmentLengthM: 3000,
  });

  assert.equal(segs.length, 1);
  // Should be capped well below the full 50 points
  assert.ok(segs[0].points.length < 20, `got ${segs[0].points.length} points, expected < 20`);
});

test("collectRecentSegmentPerVehicle excludes ghosted vehicles", () => {
  const trail = [
    { lat: 40.0, lon: -111.0, m: 1 },
    { lat: 40.01, lon: -111.01, m: 1 },
    { lat: 40.02, lon: -111.02, m: 1 },
  ];
  const mobiles = [{ id: "G", ghosted: true, trail }];
  const segs = logic.collectRecentSegmentPerVehicle(mobiles, { minTrailLengthM: 50 });
  assert.equal(segs.length, 0);
});

test("collectRobustLiveBounds trims outlier vehicle far from cluster", () => {
  // 3 vehicles clustered near 40.76, -111.88 (South Temple area)
  // 1 outlier at 40.5, -111.9 (Draper, ~30km south)
  const vehicles = [
    { id: "BUS1", lat: 40.76, lon: -111.88 },
    { id: "BUS2", lat: 40.75, lon: -111.89 },
    { id: "BUS3", lat: 40.74, lon: -111.90 },
    { id: "TRAX", lat: 40.50, lon: -111.90 },
  ];

  const bb = logic.collectRobustLiveBounds(vehicles, { clusterRadiusM: 8000 });

  // The TRAX outlier (~27km from cluster center) should be excluded
  assert.equal(bb.visibleVehicleCount, 3);
  // Bounds should NOT extend to 40.5 (Draper)
  assert.ok(bb.minLat > 40.7, `minLat ${bb.minLat} should be > 40.7 (outlier trimmed)`);
});

test("collectRobustLiveBounds keeps all vehicles when tightly clustered", () => {
  const vehicles = [
    { id: "A", lat: 40.76, lon: -111.88 },
    { id: "B", lat: 40.77, lon: -111.87 },
    { id: "C", lat: 40.75, lon: -111.89 },
  ];

  const bb = logic.collectRobustLiveBounds(vehicles);
  assert.equal(bb.visibleVehicleCount, 3);
  assert.equal(bb.visiblePointCount, 3);
});

test("collectRobustLiveBounds handles single vehicle", () => {
  const vehicles = [
    { id: "SOLO", lat: 40.76, lon: -111.88 },
  ];

  const bb = logic.collectRobustLiveBounds(vehicles);
  assert.equal(bb.visibleVehicleCount, 1);
  assert.equal(bb.visiblePointCount, 1);
  assert.ok(bb.minLat <= 40.76);
  assert.ok(bb.maxLat >= 40.76);
});

test("collectRobustLiveBounds returns empty for no vehicles", () => {
  const bb = logic.collectRobustLiveBounds([]);
  assert.equal(bb.visibleVehicleCount, 0);
  assert.equal(bb.visiblePointCount, 0);
});

test("collectRobustLiveBounds keeps median vehicle when others are outliers", () => {
  const vehicles = [
    { id: "N", lat: 41.0, lon: -111.9 },
    { id: "S", lat: 40.0, lon: -111.9 },
  ];

  const bb = logic.collectRobustLiveBounds(vehicles, { clusterRadiusM: 1000 });
  assert.equal(bb.visibleVehicleCount, 1);
  assert.equal(bb.visiblePointCount, 1);
});

test("collectRobustLiveBounds includes nearby fixed sensors", () => {
  // 2 buses near 40.76, -111.88
  const vehicles = [
    { id: "BUS1", lat: 40.76, lon: -111.88 },
    { id: "BUS2", lat: 40.77, lon: -111.87 },
  ];
  // Home sensor nearby, plus a far-away fixed sensor that should be excluded
  const fixedSensors = [
    { id: "Home", lat: 40.765, lon: -111.875 },  // right in the cluster
    { id: "FarAway", lat: 39.5, lon: -112.0 },   // ~140km south
  ];

  const bb = logic.collectRobustLiveBounds(vehicles, { fixedSensors });

  // 2 buses + 1 nearby fixed = 3 contributors; far-away fixed excluded
  assert.equal(bb.visibleVehicleCount, 3);
  assert.ok(bb.minLat > 40.7, `minLat ${bb.minLat} should be > 40.7 (far fixed excluded)`);
});

test("collectRobustLiveBounds includes visible trail segments", () => {
  // Vehicle at 40.76, with a trail extending south to 40.73
  const trail = [
    { lat: 40.73, lon: -111.88, m: 1 },
    { lat: 40.74, lon: -111.88, m: 1 },
    { lat: 40.75, lon: -111.88, m: 1 },
    { lat: 40.76, lon: -111.88, m: 1 },
  ];
  const vehicles = [
    { id: "BUS1", lat: 40.76, lon: -111.88, trail },
    { id: "BUS2", lat: 40.77, lon: -111.87 },
  ];

  const bb = logic.collectRobustLiveBounds(vehicles);

  // Bounds should extend down to cover the trail, not just the head
  assert.ok(bb.minLat <= 40.73, `minLat ${bb.minLat} should be <= 40.73 (trail included)`);
  assert.ok(bb.maxLat >= 40.77);
});

test("collectRobustLiveBounds trail stops at non-moving gap", () => {
  const trail = [
    { lat: 40.70, lon: -111.88, m: 1 },  // old moving
    { lat: 40.72, lon: -111.88, m: 0 },  // gap — should stop here
    { lat: 40.74, lon: -111.88, m: 1 },
    { lat: 40.76, lon: -111.88, m: 1 },
  ];
  const vehicles = [
    { id: "BUS1", lat: 40.76, lon: -111.88, trail },
    { id: "BUS2", lat: 40.77, lon: -111.87 },
  ];

  const bb = logic.collectRobustLiveBounds(vehicles);

  // Should include 40.74-40.76 from trail but NOT 40.70 (before the gap)
  assert.ok(bb.minLat >= 40.74, `minLat ${bb.minLat} should be >= 40.74 (stops at gap)`);
});

test("mustIncludePoints bypasses cluster radius gating", () => {
  // Two buses clustered near 40.76, -111.88
  const vehicles = [
    { id: "BUS1", lat: 40.76, lon: -111.88 },
    { id: "BUS2", lat: 40.77, lon: -111.87 },
  ];
  // A sensor 20km away (far outside the default 8km cluster radius)
  const farSensor = { lat: 40.92, lon: -112.05 };

  const bb = logic.collectRobustLiveBounds(vehicles, {
    mustIncludePoints: [farSensor],
  });

  // The far sensor should be included in bounds despite being outside clusterRadiusM
  assert.ok(bb.maxLat >= 40.92, `maxLat ${bb.maxLat} should be >= 40.92 (mustInclude bypasses gating)`);
  assert.ok(bb.minLon <= -112.05, `minLon ${bb.minLon} should be <= -112.05`);
  // 2 buses + 1 must-include = 3 contributors
  assert.equal(bb.visibleVehicleCount, 3);
});

test("empty mustIncludePoints produces same results as omitting it", () => {
  const vehicles = [
    { id: "BUS1", lat: 40.76, lon: -111.88 },
    { id: "BUS2", lat: 40.77, lon: -111.87 },
  ];
  const fixedSensors = [
    { id: "Home", lat: 40.765, lon: -111.875 },
  ];

  const bbWithout = logic.collectRobustLiveBounds(vehicles, { fixedSensors });
  const bbEmpty = logic.collectRobustLiveBounds(vehicles, { fixedSensors, mustIncludePoints: [] });
  const bbNull = logic.collectRobustLiveBounds(vehicles, { fixedSensors, mustIncludePoints: null });

  assert.equal(bbWithout.visibleVehicleCount, bbEmpty.visibleVehicleCount);
  assert.equal(bbWithout.visiblePointCount, bbEmpty.visiblePointCount);
  assert.equal(bbWithout.minLat, bbEmpty.minLat);
  assert.equal(bbWithout.maxLat, bbEmpty.maxLat);

  assert.equal(bbWithout.visibleVehicleCount, bbNull.visibleVehicleCount);
  assert.equal(bbWithout.minLat, bbNull.minLat);
});

test("mustIncludePoints with invalid entries are ignored", () => {
  const vehicles = [
    { id: "BUS1", lat: 40.76, lon: -111.88 },
    { id: "BUS2", lat: 40.77, lon: -111.87 },
  ];

  const bb = logic.collectRobustLiveBounds(vehicles, {
    mustIncludePoints: [null, { lat: NaN, lon: -111.0 }, { lat: 40.5 }],
  });

  // All invalid — should produce same result as no mustIncludePoints
  assert.equal(bb.visibleVehicleCount, 2);
});
