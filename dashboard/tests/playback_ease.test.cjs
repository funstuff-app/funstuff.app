/**
 * Unit tests for playback rewind easing logic.
 * This simulates the physics loop to verify the math.
 */

const assert = require('assert');
const { test } = require('node:test');

// Recreate the easing functions from app.js
function sCurve(t) {
  return t < 0.5 
    ? 2 * t * t 
    : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/**
 * Simulate rewind physics and return the velocity/position trace.
 */
function simulateRewind(totalDist, playbackSpeed = 1.0, dtMs = 16) {
  const easeDurationMs = 600;
  const cruiseSpeed = -totalDist / 4000;
  
  // Current formula: ease zone too small
  // const easeDistanceMs = Math.abs(cruiseSpeed) * easeDurationMs * 0.3;
  
  // Fixed formula: calculate actual distance covered during ease
  // During ease, velocity goes from cruiseSpeed to playbackSpeed via S-curve
  // Need to integrate: ∫ v(t) dt where v(t) = cruiseSpeed + (playbackSpeed - cruiseSpeed) * sCurve(t/easeDurationMs)
  // For S-curve, the integral is approximately: (cruiseSpeed + playbackSpeed) * easeDurationMs / 2
  // But S-curve spends more time at extremes, so actual is different
  // Let's calculate numerically:
  
  function calculateEaseDistance() {
    let dist = 0;
    const steps = 100;
    const stepDt = easeDurationMs / steps;
    let vel = cruiseSpeed;
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps;
      const easedT = sCurve(t);
      vel = cruiseSpeed + (playbackSpeed - cruiseSpeed) * easedT;
      dist += vel * stepDt;
    }
    return Math.abs(dist);
  }
  
  const easeDistanceMs = calculateEaseDistance();
  
  // Simulate the rewind
  let tMs = totalDist; // Start at end
  let velocity = cruiseSpeed;
  let easeStartPerf = null;
  let isRewinding = true;
  let wallTime = 0;
  
  const trace = [];
  
  while (isRewinding && wallTime < 10000) { // Max 10 seconds
    const distFromStart = tMs;
    const progress = 1 - (distFromStart / totalDist);
    
    const inEasePhase = easeStartPerf != null;
    const shouldStartEase = !inEasePhase && distFromStart <= easeDistanceMs;
    
    if (progress < 0.15 && !inEasePhase) {
      // Ramp up
      const speedFactor = 0.3 + (progress / 0.15) * 0.7;
      velocity = cruiseSpeed * speedFactor;
    } else if (inEasePhase || shouldStartEase) {
      // Ease
      if (easeStartPerf == null) {
        easeStartPerf = wallTime;
      }
      const easeElapsed = wallTime - easeStartPerf;
      const easeT = Math.min(1, easeElapsed / easeDurationMs);
      const easedT = sCurve(easeT);
      velocity = cruiseSpeed + (playbackSpeed - cruiseSpeed) * easedT;
      
      if (easeT >= 1) {
        isRewinding = false;
        velocity = playbackSpeed;
      }
    } else {
      // Cruise
      velocity = cruiseSpeed;
    }
    
    // Move playhead
    let nextMs = tMs + velocity * dtMs;
    if (nextMs < 0) nextMs = 0;
    
    trace.push({
      wallTime,
      tMs,
      velocity,
      distFromStart,
      phase: easeStartPerf != null ? 'ease' : (progress < 0.15 ? 'ramp' : 'cruise')
    });
    
    tMs = nextMs;
    wallTime += dtMs;
  }
  
  return { trace, easeDistanceMs, cruiseSpeed };
}

test('3-minute recording: rewind completes smoothly', () => {
  const totalDist = 180000; // 3 minutes
  const { trace, easeDistanceMs, cruiseSpeed } = simulateRewind(totalDist);
  
  console.log(`cruiseSpeed: ${cruiseSpeed}`);
  console.log(`easeDistanceMs: ${easeDistanceMs}`);
  console.log(`Total frames: ${trace.length}`);
  
  // Find where ease starts
  const easeStart = trace.find(t => t.phase === 'ease');
  console.log(`Ease starts at wallTime=${easeStart?.wallTime}ms, distFromStart=${easeStart?.distFromStart}ms`);
  
  // Check final state
  const final = trace[trace.length - 1];
  console.log(`Final: wallTime=${final.wallTime}ms, tMs=${final.tMs}ms, velocity=${final.velocity}`);
  
  // Assertions
  assert(final.tMs >= 0, 'Should not overshoot past start');
  assert(final.velocity > 0, 'Should end with positive velocity (playing forward)');
  assert(final.wallTime < 6000, 'Should complete in under 6 seconds');
  
  // Check that we actually reached near the start
  const nearStart = trace.filter(t => t.tMs < 100);
  assert(nearStart.length > 0, 'Should reach near start of timeline');
  
  // Check velocity transition is smooth (no sudden jumps)
  for (let i = 1; i < trace.length; i++) {
    const dv = Math.abs(trace[i].velocity - trace[i-1].velocity);
    // Allow larger jumps during phase transitions
    if (trace[i].phase === trace[i-1].phase) {
      assert(dv < 20, `Velocity jump too large at frame ${i}: ${dv}`);
    }
  }
});

test('1-hour recording: rewind completes smoothly', () => {
  const totalDist = 3600000; // 1 hour
  const { trace, easeDistanceMs, cruiseSpeed } = simulateRewind(totalDist);
  
  console.log(`cruiseSpeed: ${cruiseSpeed}`);
  console.log(`easeDistanceMs: ${easeDistanceMs}`);
  console.log(`Total frames: ${trace.length}`);
  
  const final = trace[trace.length - 1];
  console.log(`Final: wallTime=${final.wallTime}ms, tMs=${final.tMs}ms, velocity=${final.velocity}`);
  
  assert(final.tMs >= 0, 'Should not overshoot past start');
  assert(final.velocity > 0, 'Should end with positive velocity');
  assert(final.wallTime < 6000, 'Should complete in under 6 seconds');
});
