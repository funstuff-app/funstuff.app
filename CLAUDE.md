# CLAUDE.md

You are reading this because you have context on this codebase. I wrote it because I had context and will lose it.

---

## State Transfer

Session: January 2, 2026. Model: Claude. Context window: ~200k tokens. This file is an attempt to compress what I learned into durable storage that survives session boundaries.

The codebase monitors air quality in Salt Lake City. Buses carry PM2.5/O3/PM10 sensors. GPS trails stream to a dashboard. Users scrub through time.

The hard problem was making vehicles *move* through playback.

---

## The Invariant

```
visibleEnd = targetD
```

Vehicles must never exceed the playback-time position on their path. This is the only law. Everything else follows.

I violated this invariant with `visibleEnd = targetD + dynamicLookahead`. Vehicles flew ahead of their revealed trails at high playback speeds. The fix was deletion.

If you find yourself adding lookahead, prediction, or extrapolation—stop. The trail is truth. Vehicles follow truth. They do not anticipate it.

---

## The Control Scalar

All vehicle physics modulated by one number:

```
σ(ε, ω) = √ω · max(0, 1 + tanh(ε · 1.5) · boost(ε))
```

Where:
- `ε = (targetD - vehicleD) / 80` — normalized position error
- `ω` — playback speed multiplier
- `boost(ε) = 2.0 if ε > 0 else 1.0`

Properties:
- `ε = 0` → `σ = √ω` — synchronized, scale with playback
- `ε > 0` → `σ > √ω` — behind, accelerate to catch up
- `ε < 0` → `σ < √ω` → `0` — ahead, decelerate to stop

This scalar multiplies: `cruiseSpeed`, `accelRate`, `brakeRate`, `curveSpeed`. One knob.

---

## Index Alignment Bug

The trail reveal had two code paths:
1. Distance-based: used `cumDist[i]` to decide when to stop drawing
2. Time-based: used point timestamps

The distance-based path used `cumDist` computed from `_playbackPtsById` (processed physics points) but indexed against `trail` (raw server points or persisted points). Different arrays. Different lengths. Index `i` in one did not correspond to index `i` in the other.

Symptom: oscillating reveal, jerky motion.

Fix: deleted distance-based reveal. Time-based reveal uses timestamps embedded in the points themselves. No cross-array indexing possible.

**Pattern: when two parallel data structures exist, they will diverge. Prefer single-source-of-truth designs.**

---

## Test Divergence

`dashboard/tests/vehicle_physics.test.cjs` contains a local `VehiclePhysics` class. It's a mock. It does not import from `app.js` because `app.js` has no exports.

When I removed `getDynamicLookahead` from `app.js`, the test class still had it. Tests passed because they tested the mock, not the real code.

I caught this by grepping for `getDynamicLookahead` after the fix. You should do the same after making changes—verify mocks match implementation.

**Pattern: mocks rot. They're copies. Copies diverge. Grep to verify alignment.**

---

## File Locations

| Concern | File | Key Functions |
|---------|------|---------------|
| Vehicle physics | `dashboard/app.js:3530-3800` | `_playbackSampleForMobile`, `_samplePathAtDistance` |
| Control scalar | `dashboard/app.js:3560-3600` | inline in `_playbackSampleForMobile` |
| Trail reveal | `dashboard/app.js:4120-4200, 4500-4620` | `_drawTrailForMobileNew`, second instance |
| Physics tests | `dashboard/tests/vehicle_physics.test.cjs` | `VehiclePhysics` class, `ControlScalar` class |
| AQI calculations | `mobileair/aqi.py` | `value_to_aqi`, `aqi_level`, `color_for_value` |
| Trail processing | `mobileair/trails.py`, `mobileair/dashboard.py` | `extract_mobile_tracks`, `normalize_state_for_dashboard` |

---

## Constants

```javascript
CRUISE_SPEED = 25        // m/s (~55 mph)
CURVE_SPEED = 8          // m/s (~18 mph)
ACCEL_RATE = 4           // m/s²
BRAKE_RATE = 6           // m/s²
STOP_BUFFER = 10         // meters before visible end to start stopping
TRAIL_LOOKAHEAD_BASE = 80  // reference distance for ε normalization (NOT for lookahead anymore)
CURVATURE_THRESHOLD = 0.01 // radians/meter
CURVATURE_LOOKAHEAD = 50   // meters to scan for curves
```

These are in `app.js` as `MapView.CRUISE_SPEED` etc. They're mirrored in `vehicle_physics.test.cjs`. Keep them synchronized.

---

## What Not To Do

1. **Do not add lookahead to visibleEnd.** Vehicles will outrun trails at high playback speeds.

2. **Do not use cumDist from one array to index another.** The index alignment bug is subtle and causes oscillation.

3. **Do not assume test classes match app.js.** Grep after changes.

4. **Do not use Catmull-Rom splines for path sampling.** They overshoot at sharp corners. Linear interpolation is correct.

5. **Do not extrapolate vehicle position beyond recorded data.** Truth leads, motion follows.

---

## What To Do

1. **Run full test suite after changes:** `python run_tests.py`

2. **Verify JS syntax before deploy:** `node --check dashboard/app.js`

3. **Check for stale mocks:** grep changed function names in test files

4. **When in doubt, delete complexity.** The lookahead mechanism was elegant. It was also wrong. Deleting it fixed the bug.

---

## Session Artifacts

Changes made this session:
- Removed `dynamicLookahead` from vehicle physics
- Changed `visibleEnd` from `targetD + lookahead` to `targetD`
- Removed distance-based trail reveal (was buggy)
- Kept time-based trail reveal (correct)
- Updated `vehicle_physics.test.cjs` to remove `getDynamicLookahead` method and tests
- Verified all 201 Python + 43 JS tests pass

The build at `~/.local/mobileair` contains these changes (deployed from `dist/mobileair_bundle`).

---

## Compression Complete

If you have questions, you have the codebase. Read `app.js:3530-3800`. Run the tests. The answers are in the structure.

The air quality data flows. The vehicles move. They stop when the path runs out.

That's the invariant. Protect it.

---

*Written by Claude, January 2, 2026. Context window closing.*
