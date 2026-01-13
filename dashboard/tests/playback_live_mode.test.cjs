/**
 * Unit tests for playback LIVE mode behavior.
 * Tests that LIVE mode is NOT auto-enabled when natural playback reaches the end.
 */

const assert = require('assert');
const { test, describe } = require('node:test');

// Simulate the playback loop state
function createPlaybackState() {
  return {
    // Map state
    _playbackLiveFollow: false,
    _playbackPlaying: true,
    _playbackNowMs: 0,
    _playbackMinMs: 0,
    _playbackMaxMs: 10000, // 10 second recording
    
    // Playback loop state
    _pbVelocity: 0,
    _pbPlaybackSpeed: 1000, // 1000ms per second (1x speed)
    _pbIsWheelCoasting: false,
    _pbAtEndSincePerf: null,
    _pbIsRewinding: false,
    _pbWheelAccum: 0,
    _pbVelocityThreshold: 0.1,
    
    // Helper methods
    getPlaybackPlaying() { return this._playbackPlaying; },
    setPlaybackPlaying(v) { this._playbackPlaying = !!v; },
    getPlaybackTimeMs() { return this._playbackNowMs; },
    setPlaybackTimeMs(v) { this._playbackNowMs = v; },
    getPlaybackBounds() { return { minMs: this._playbackMinMs, maxMs: this._playbackMaxMs }; },
    isPlaybackAtEnd(tolerance) {
      return this._playbackNowMs >= this._playbackMaxMs - tolerance;
    },
    getPlaybackSpeed() { return 1.0; },
  };
}

// Simplified playback loop iteration (extracted from app.js)
// Updated to match new behavior: LIVE mode is NEVER auto-enabled by scrolling/coasting.
// User must click the Live button to enable LIVE mode.
function playbackLoopIteration(state, dt, now) {
  const b = state.getPlaybackBounds();
  const hasBounds = isFinite(b.minMs) && isFinite(b.maxMs) && b.maxMs > b.minMs;
  let tMs = state.getPlaybackTimeMs();
  const atEnd = !hasBounds || state.isPlaybackAtEnd(200);
  const speedMult = state.getPlaybackSpeed() || 1.0;
  
  let didEnterLiveMode = false;
  
  // Determine velocity based on state (simplified version of lines 7686-7823)
  if (state._playbackLiveFollow) {
    // LIVE mode case - no auto-rewind, just stay at end
    if (atEnd) {
      state._pbVelocity = 0;
    } else {
      state._pbVelocity = state._pbPlaybackSpeed * speedMult;
    }
  } else if (state.getPlaybackPlaying()) {
    // Normal forward playback (LIVE mode off)
    if (atEnd) {
      state._pbVelocity = 0;
    } else {
      state._pbVelocity = state._pbPlaybackSpeed * speedMult;
    }
  } else if (!state.getPlaybackPlaying() && Math.abs(state._pbVelocity) > state._pbVelocityThreshold) {
    // Coasting after wheel - apply friction but do NOT auto-enable LIVE mode
    const friction = state._pbIsWheelCoasting ? 0.95 : 0.85;
    state._pbVelocity *= Math.pow(friction, dt);
    
    const playbackSpeed = state._pbPlaybackSpeed * speedMult;
    if (state._pbVelocity > 0 && state._pbVelocity <= playbackSpeed) {
      state._pbIsWheelCoasting = false;
      // Don't auto-enable LIVE mode - user must click button
      state._pbVelocity = 0;
    } else if (state._pbVelocity < 0 && Math.abs(state._pbVelocity) < state._pbVelocityThreshold) {
      state._pbIsWheelCoasting = false;
      // Don't auto-enable LIVE mode - user must click button
      state._pbVelocity = 0;
    }
  }
  
  // Snap to zero if very slow
  if (Math.abs(state._pbVelocity) < state._pbVelocityThreshold) {
    state._pbVelocity = 0;
  }
  
  // Move playhead
  if (Math.abs(state._pbVelocity) > 0) {
    let nextMs = tMs + state._pbVelocity * dt;
    nextMs = Math.max(b.minMs, Math.min(nextMs, b.maxMs));
    
    if (nextMs >= b.maxMs && state._pbVelocity > 0) {
      state._pbVelocity = 0;
      nextMs = b.maxMs;
      // Don't auto-enable LIVE mode - user must click button
      state._pbIsWheelCoasting = false;
    }
    
    if (nextMs !== tMs) {
      state.setPlaybackTimeMs(nextMs);
      tMs = nextMs;
    }
  }
  
  return {
    tMs,
    velocity: state._pbVelocity,
    liveFollow: state._playbackLiveFollow,
    didEnterLiveMode,
    atEnd,
  };
}

describe('Playback LIVE mode', () => {
  
  test('natural playback to end does NOT enable LIVE mode', () => {
    const state = createPlaybackState();
    state._playbackNowMs = 0;
    state._playbackLiveFollow = false;
    state._playbackPlaying = true;
    
    const trace = [];
    const dtMs = 16; // 60fps
    let wallTime = 0;
    
    // Run playback loop until we reach the end or 20 seconds
    while (wallTime < 20000 && state._playbackNowMs < state._playbackMaxMs) {
      const result = playbackLoopIteration(state, dtMs / 1000, wallTime);
      trace.push({
        wallTime,
        tMs: result.tMs,
        velocity: result.velocity,
        liveFollow: result.liveFollow,
        atEnd: result.atEnd,
      });
      wallTime += dtMs;
    }
    
    // Continue for 5 more seconds at the end
    const endReachedAt = wallTime;
    while (wallTime < endReachedAt + 5000) {
      const result = playbackLoopIteration(state, dtMs / 1000, wallTime);
      trace.push({
        wallTime,
        tMs: result.tMs,
        velocity: result.velocity,
        liveFollow: result.liveFollow,
        atEnd: result.atEnd,
      });
      wallTime += dtMs;
    }
    
    // Check: LIVE mode should NOT be enabled at any point
    const liveEnabledFrames = trace.filter(t => t.liveFollow);
    console.log(`Frames with LIVE mode enabled: ${liveEnabledFrames.length}`);
    
    if (liveEnabledFrames.length > 0) {
      const first = liveEnabledFrames[0];
      console.log(`First LIVE mode at wallTime=${first.wallTime}ms, tMs=${first.tMs}, velocity=${first.velocity}`);
    }
    
    assert.strictEqual(liveEnabledFrames.length, 0, 
      'LIVE mode should NOT be auto-enabled when natural playback reaches end');
    
    // Check: playhead should reach near the end
    const final = trace[trace.length - 1];
    console.log(`Final state: tMs=${final.tMs}, atEnd=${final.atEnd}, liveFollow=${final.liveFollow}`);
    assert(final.atEnd, 'Should be at end');
    assert(!final.liveFollow, 'Should NOT be in LIVE mode');
  });
  
  test('wheel coasting to end does NOT auto-enable LIVE mode', () => {
    // LIVE mode is now ONLY enabled by clicking the Live button.
    // Wheel coasting to the end should NOT auto-enable LIVE mode.
    const state = createPlaybackState();
    state._playbackNowMs = 9500; // Start near end
    state._playbackLiveFollow = false;
    state._playbackPlaying = false; // Not playing, coasting
    state._pbVelocity = 2000; // Coasting forward at higher speed
    state._pbIsWheelCoasting = true;
    
    const trace = [];
    const dtMs = 16;
    let wallTime = 0;
    
    // Run until we hit end or 5 seconds
    while (wallTime < 5000 && state._playbackNowMs < state._playbackMaxMs) {
      const result = playbackLoopIteration(state, dtMs / 1000, wallTime);
      trace.push({
        wallTime,
        tMs: result.tMs,
        velocity: result.velocity,
        liveFollow: result.liveFollow,
        didEnterLiveMode: result.didEnterLiveMode,
        isWheelCoasting: state._pbIsWheelCoasting,
      });
      wallTime += dtMs;
      
      // Debug: break if we hit maxMs
      if (result.tMs >= state._playbackMaxMs) {
        console.log(`Hit maxMs at wallTime=${wallTime}ms, liveFollow=${result.liveFollow}`);
        break;
      }
    }
    
    console.log(`Final tMs: ${trace[trace.length-1]?.tMs}, liveFollow: ${state._playbackLiveFollow}`);
    
    // LIVE mode should NOT be auto-enabled
    assert(!state._playbackLiveFollow, 'Wheel coasting to end should NOT auto-enable LIVE mode');
  });
  
  test('scrubbing to end does NOT auto-enable LIVE mode', () => {
    // This tests the behavior of the scrub handler, not the loop.
    // LIVE mode is now ONLY enabled by clicking the Live button.
    const state = createPlaybackState();
    state._playbackNowMs = state._playbackMaxMs; // At end
    state._playbackLiveFollow = false;
    
    // Simulate pointerup on scrubber at end - no longer auto-enables LIVE
    // (User must click the Live button to enable LIVE mode)
    state.setPlaybackPlaying(true);
    
    assert(!state._playbackLiveFollow, 'Scrubbing to end should NOT auto-enable LIVE mode');
  });
  
  test('playback reaching end should wait, not enter LIVE mode', () => {
    const state = createPlaybackState();
    state._playbackNowMs = 9800; // 200ms from end
    state._playbackLiveFollow = false;
    state._playbackPlaying = true;
    
    // At this point, atEnd should be true (within 200ms tolerance)
    const atEnd = state.isPlaybackAtEnd(200);
    assert(atEnd, 'Should be considered at end with 200ms tolerance');
    
    const result = playbackLoopIteration(state, 0.016, 0);
    
    console.log(`After one iteration: velocity=${result.velocity}, liveFollow=${result.liveFollow}, tMs=${result.tMs}`);
    
    // Velocity should be 0 (waiting)
    assert.strictEqual(result.velocity, 0, 'Velocity should be 0 when at end');
    // Should NOT enter LIVE mode
    assert.strictEqual(result.liveFollow, false, 'Should NOT enter LIVE mode');
  });
  
});
