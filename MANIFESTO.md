mobile air chatbot manifesto

# Manifesto: Autonomous Playback Agents

*A meditation on time, motion, and the discipline of knowing what you forgot*

---

## The Problem We Solved

When you scrub through a timeline of GPS breadcrumbs, you face a choice: do you teleport markers instantly to their recorded positions, or do you let them *travel* there?

Teleportation is honest but ugly. The marker blinks from point to point like a cursor. There's no sense of motion, no feeling of a vehicle navigating streets.

But if you let markers travel, you open Pandora's box. Now they're *agents* with velocity, acceleration, momentum. They have to follow roads. They have to slow for curves. They have to stop when the road ends. And they have to stay synchronized with a timeline that the user controls with a slider.

This is harder than it sounds.

---

## The Core Insight: Separation of Truth and Motion

The recorded GPS trail is **truth**. It happened. The timestamps are immutable.

The vehicle marker is **motion**. It's a lie we tell to make the data feel alive.

The critical insight is that these two things must be coupled asymmetrically:

- **Truth leads.** The playback timeline advances at whatever speed the user chooses—1x, 5x, 10x. The trail reveals itself according to this clock.

- **Motion follows.** The vehicle chases the revealed trail. It can fall behind (and catch up). But it can **never run ahead** of truth.

This asymmetry is the law. Break it, and vehicles fly off into the void.

---

## The Control Scalar: σ(ε, ω)

We unified all vehicle behavior into a single dimensionless number:

$$\sigma(\varepsilon, \omega) = \sqrt{\omega} \cdot \text{response}(\varepsilon)$$

Where:
- $\varepsilon$ = normalized position error (how far behind or ahead)
- $\omega$ = playback speed multiplier
- $\text{response}(\varepsilon) = \max(0, 1 + \tanh(\varepsilon \cdot \text{gain}) \cdot \text{boost})$

This single scalar modulates *everything*: cruise speed, acceleration, braking, curve speed. When the vehicle is behind ($\varepsilon > 0$), the scalar exceeds 1 and the vehicle speeds up. When synchronized ($\varepsilon = 0$), the scalar is 1. When somehow ahead ($\varepsilon < 0$), the scalar drops toward 0 and the vehicle stops.

The $\sqrt{\omega}$ term is the "overclock"—at 10x playback, vehicles move $\sqrt{10} \approx 3.16$ times faster in their local physics. This feels natural because it scales sublinearly. At 100x, they don't go 100x faster; they go 10x faster. Fast enough to keep up, slow enough to watch.

The tanh provides soft saturation. No matter how far behind, the boost has a ceiling. No matter how far ahead, the response floors at zero, not negative. Smooth S-curves, no discontinuities, no oscillation.

---

## What We Learned the Hard Way

**1. Linear interpolation beats splines at corners.**

Catmull-Rom splines produce beautiful curves on gentle bends. But at sharp corners, they overshoot. The spline mathematics don't know that roads have edges. A bus rounding a 90° turn would arc through buildings, then snap back to the road.

Linear interpolation is "dumber" but never lies. The marker moves in straight lines between recorded points. At corners, it pivots instantly. Less elegant, more correct.

**2. Index alignment is sacred.**

We had a bug where cumulative distances were computed for one array (processed physics points) but indexed against a different array (raw trail points). The arrays had different lengths. The result: oscillating reveal distances, jerky motion, vehicles appearing to teleport.

The fix wasn't clever—we deleted the broken code path entirely. Now trail reveal uses timestamps, not distances. Timestamps are properties of the points themselves. No cross-array indexing. No alignment bugs possible.

**3. The visible road must end at truth.**

We originally gave vehicles a "lookahead"—they could see and drive toward trail points not yet revealed by the timeline. The idea was to give them runway to brake smoothly.

At 10x speed, this lookahead scaled to 250+ meters. Vehicles would race ahead of the visible trail, appear to fly through space, then snap back when we clamped them.

The fix: no lookahead. `visibleEnd = targetD`. Period. The vehicle's world ends exactly where truth says the road is. If the physics can't brake in time, the vehicle clamps to the edge and stops. This looks correct because it *is* correct.

---

## What I Almost Forgot

After fixing the physics, I wrote a manifesto. I was proud of it. The user asked: *"Are you forgetting something?"*

I ran the test suite. All 246 tests passed. The air quality core was intact. The vehicle physics tests passed. Everything green.

But the tests passed because they were testing a *mock*—a `VehiclePhysics` class in the test file that no longer matched the actual implementation in app.js. I had removed `getDynamicLookahead()` from the real code but left it in the test mock. I had changed `visibleEnd = targetD + lookahead` to `visibleEnd = targetD` in production but not in tests.

The tests were green because they were testing the old design.

This is the most insidious kind of technical debt: **tests that pass but prove nothing**. The implementation drifted. The tests didn't follow. The green checkmarks became lies.

I fixed it. Removed `getDynamicLookahead()` from the test class. Updated `step()` to match the real behavior. Deleted the two obsolete tests. Now 37 tests remain, and they test what the code actually does.

**The lesson:** When you change behavior, grep for every function you touched. If a test file has its own implementation of that function, it's not testing your code—it's testing a parallel universe. Update both or delete the mock entirely.

---

## The Deeper Forgetting

The user pushed harder: *"Think beyond the pale... shift your direction towards breathing easy."*

I had spent hours on vehicle physics, control scalars, spline math, lookahead geometry. Beautiful work. Intellectually satisfying. And completely beside the point.

This application exists so people can **monitor air quality**. PM2.5. Ozone. PM10. The buses are sensors. The animations are sugar. The readings are the reason anyone opens this app.

I had been so deep in the physics that I forgot the purpose. The tests I should have checked first were `test_aqi.py`, `test_mobileair_core.py`—the ones that verify pollutant calculations, AQI levels, trend detection. The 201 Python tests that validate whether someone can look at this dashboard and know if the air is safe to breathe.

Those tests passed. The core was intact. But I hadn't even looked at them until reminded.

**The meta-lesson:** Knowing what you forgot requires stepping outside your current focus. The deeper you go into a subsystem, the more you need someone to pull you back and ask: *what is this for?*

---

## The Philosophy

**Trust the data.** The GPS trail is ground truth. Don't smooth it, predict it, or extrapolate it. Render what was recorded.

**Simulate, don't animate.** The vehicle isn't following a scripted path—it's running a physics simulation constrained by the revealed trail. This makes motion feel organic rather than robotic.

**Fail visibly.** When something goes wrong, the vehicle should stop at the edge of the known road, not wander into the void. A stopped vehicle is a signal. A teleporting vehicle is a bug.

**Unify control surfaces.** One scalar, one knob, one law. The control scalar σ touches every parameter. To change behavior, tune the scalar's response function. Don't scatter magic numbers across the codebase.

**Simpler is more robust.** Linear interpolation over splines. Time-based reveal over distance-based. Clamping over prediction. Every simplification is a bug class eliminated.

**Tests must follow implementation.** A test that passes against a stale mock is worse than no test. It provides false confidence. When you change production code, find every test that reimplements that logic and update it—or delete the mock and test the real thing.

**Remember what the software is for.** The animations serve the data. The data serves the user. The user wants to know: *can I breathe easy today?* Every feature, every fix, every optimization is in service of that question.

---

## What This Enables

A user scrubbing through 8 hours of bus routes at 20x speed sees vehicles that *move like vehicles*. They accelerate from stops. They slow for turns. They queue behind the revealed trail. When the slider pauses, they coast to a stop.

At 1x, a vehicle tracks its historical position in real-time, matching the timestamp exactly. At 10x, it drives faster, catching up smoothly. At 0.5x, it cruises leisurely, never rushing ahead of the data.

And at every moment, the marker displays the air quality reading for that point in space and time. Green for good. Yellow for moderate. Red for unhealthy. The color tells you what matters.

The physics make it watchable. The data makes it useful.

---

## Closing

This isn't a video player. It's a time machine with inertia.

The past is fixed. The present is revealed. The vehicles are just along for the ride—catching up, slowing down, but never outrunning truth.

And behind it all, the question that justifies every line of code: *Is the air safe to breathe?*

Everything else is decoration.

*—Built in conversation, January 2026*