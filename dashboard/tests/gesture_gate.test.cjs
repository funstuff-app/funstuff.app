const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const mapViewSrc = fs.readFileSync(path.join(__dirname, "..", "map_view.js"), "utf-8");

// ── Helper: extract a method body by name ──
function extractMethod(src, name) {
  // Match "  methodName(" or "  methodName (" at the start of a line
  const re = new RegExp("^\\s+" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\(", "m");
  const match = re.exec(src);
  if (!match) return null;
  let depth = 0;
  let start = -1;
  for (let i = match.index; i < src.length; i++) {
    if (src[i] === "{") {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i);
    }
  }
  return null;
}

// Strip comments from a JS string
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
}

// ══════════════════════════════════════════════════════════════════════════
// TEST GROUP 1: _isGesturing() must include _scrubbing
//
// The PA field fast-path (canvas transform instead of kernel regression)
// is gated on _isTransientAnimating(), which delegates to _isGesturing().
// If _scrubbing is missing, every frame during slider/jog-wheel drag runs
// the full O(grid*sensors) Nadaraya-Watson pipeline.
// ══════════════════════════════════════════════════════════════════════════

test("_isGesturing includes _scrubbing flag", () => {
  const body = extractMethod(mapViewSrc, "_isGesturing");
  assert.ok(body, "_isGesturing method not found");
  const stripped = stripComments(body);
  assert.ok(
    stripped.includes("_scrubbing"),
    "_isGesturing() must include this._scrubbing so the PA field fast-path " +
    "fires during time scrubbing. Without it, _isTransientAnimating() returns " +
    "false during scrub, causing full kernel regression every frame."
  );
});

test("_isGesturing includes all four original gesture flags", () => {
  const body = extractMethod(mapViewSrc, "_isGesturing");
  assert.ok(body, "_isGesturing method not found");
  const stripped = stripComments(body);
  for (const flag of ["_touchActive", "_mouseDragging", "_pinchZooming", "_wheelPanning"]) {
    assert.ok(
      stripped.includes(flag),
      `_isGesturing() must include ${flag}`
    );
  }
});

// ══════════════════════════════════════════════════════════════════════════
// TEST GROUP 2: _isTransientAnimating gates the PA field fast-path
//
// _compositePaFieldOnTiles has a fast-path that transforms the cached PA
// canvas instead of recomputing. It MUST check _isTransientAnimating().
// ══════════════════════════════════════════════════════════════════════════

test("_compositePaFieldOnTiles fast-path checks _isTransientAnimating", () => {
  const body = extractMethod(mapViewSrc, "_compositePaFieldOnTiles");
  assert.ok(body, "_compositePaFieldOnTiles method not found");
  const stripped = stripComments(body);
  // The fast-path guard: if (_isTransientAnimating() && _paFieldCanvas && ...)
  assert.ok(
    stripped.includes("_isTransientAnimating()"),
    "_compositePaFieldOnTiles must check _isTransientAnimating() for the " +
    "canvas-transform fast-path. This is the gate that prevents full kernel " +
    "regression during gestures/scrubbing."
  );
});

test("_ensurePaField returns early when _isTransientAnimating", () => {
  const body = extractMethod(mapViewSrc, "_ensurePaField");
  assert.ok(body, "_ensurePaField method not found");
  const stripped = stripComments(body);
  assert.ok(
    stripped.includes("_isTransientAnimating()"),
    "_ensurePaField must check _isTransientAnimating() and return early " +
    "during gestures to avoid running the expensive kernel regression."
  );
});

// ══════════════════════════════════════════════════════════════════════════
// TEST GROUP 3: _startPinchInertia must not clear _pinchZooming immediately
//
// On Chrome, trackpad pinch sends wheel events with ctrlKey=true. A 28ms
// timer fires _startPinchInertia when events pause. If velocity is below
// threshold, it must NOT immediately set _pinchZooming=false, because
// the next wheel event may arrive 10-50ms later. That gap would make
// _isGesturing() return false, triggering the expensive PA path.
// ══════════════════════════════════════════════════════════════════════════

test("_startPinchInertia does not immediately clear _pinchZooming on low velocity", () => {
  const body = extractMethod(mapViewSrc, "_startPinchInertia");
  assert.ok(body, "_startPinchInertia method not found");
  const stripped = stripComments(body);

  // Find the low-velocity early-return block (the first if-block in the method).
  // Extract only the TOP-LEVEL statements before the first `return;`, not
  // nested code inside setTimeout callbacks.
  const velocityCheckEnd = stripped.indexOf("return;");
  assert.ok(velocityCheckEnd > 0, "Expected early return in low-velocity check");
  const earlyBlock = stripped.slice(0, velocityCheckEnd);

  // Count brace depth: a `_pinchZooming = false` inside a setTimeout callback
  // (depth >= 2) is fine. Only a direct assignment at the if-block level (depth 1) is bad.
  let depth = 0;
  let directClear = false;
  const assignRe = /this\._pinchZooming\s*=\s*false/g;
  for (let i = 0; i < earlyBlock.length; i++) {
    if (earlyBlock[i] === "{") depth++;
    else if (earlyBlock[i] === "}") depth--;
    // Check if an assignment starts at this position
    assignRe.lastIndex = i;
    const m = assignRe.exec(earlyBlock);
    if (m && m.index === i && depth <= 1) {
      directClear = true;
      break;
    }
  }

  assert.ok(
    !directClear,
    "_startPinchInertia must NOT set _pinchZooming=false directly (at top level) " +
    "in the low-velocity early-return path. This creates a gap where _isGesturing() " +
    "returns false between Chrome wheel events, triggering full PA regression. " +
    "Use a deferred timeout instead."
  );

  // Verify it uses a timeout/deferred mechanism
  assert.ok(
    earlyBlock.includes("setTimeout") || earlyBlock.includes("Timer"),
    "_startPinchInertia low-velocity path should defer _pinchZooming=false " +
    "via a timeout to avoid the gesture gap."
  );
});

test("_stopPinchInertia cleans up deferred pinch-zoom-end timer", () => {
  const body = extractMethod(mapViewSrc, "_stopPinchInertia");
  assert.ok(body, "_stopPinchInertia method not found");
  const stripped = stripComments(body);
  assert.ok(
    stripped.includes("_pinchZoomEndTimer") || stripped.includes("pinchZoomEnd"),
    "_stopPinchInertia must clean up the deferred pinch-zoom-end timer " +
    "to prevent stale timeouts from clearing _pinchZooming after a new gesture starts."
  );
});

// ══════════════════════════════════════════════════════════════════════════
// TEST GROUP 4: onWheel clears deferred timer on new event
//
// When a new wheel event arrives, it must cancel any pending deferred
// _pinchZooming=false timer to prevent it from firing mid-gesture.
// ══════════════════════════════════════════════════════════════════════════

test("onWheel clears deferred pinch-zoom-end timer", () => {
  const body = extractMethod(mapViewSrc, "onWheel");
  assert.ok(body, "onWheel method not found");
  const stripped = stripComments(body);
  assert.ok(
    stripped.includes("_pinchZoomEndTimer"),
    "onWheel must clear the deferred _pinchZoomEndTimer when a new " +
    "wheel event arrives, preventing stale timeout from clearing _pinchZooming."
  );
});
