const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const css = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf-8");
const appJs = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf-8");

/**
 * Extract the content of a nested @media block within a parent block.
 */
function extractMediaBlock(src, mediaQuery) {
  const idx = src.indexOf(mediaQuery);
  if (idx === -1) return null;
  let depth = 0;
  let begin = -1;
  for (let i = idx; i < src.length; i++) {
    if (src[i] === "{") {
      if (depth === 0) begin = i + 1;
      depth++;
    } else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(begin, i);
    }
  }
  return null;
}

/**
 * Extract declarations for a given selector within a CSS block.
 * Returns an object of { property: value } pairs.
 */
function getDeclarations(block, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(escaped + "\\s*\\{([^}]+)\\}", "g");
  const match = re.exec(block);
  if (!match) return {};
  const decls = {};
  for (const line of match[1].split(";")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("/*")) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    decls[trimmed.slice(0, colon).trim()] = trimmed.slice(colon + 1).trim();
  }
  return decls;
}

// ── CSS structural tests ────────────────────────────────────────────────

test("base #appFooter is small by default (mobile-first)", () => {
  const decls = getDeclarations(css, "#appFooter");
  assert.equal(decls["font-size"], "10px");
  assert.equal(decls["padding"], "4px 10px");
  assert.equal(decls["line-height"], "1.35");
  assert.equal(decls["-webkit-text-size-adjust"], "100%",
    "footer must have -webkit-text-size-adjust: 100% to prevent Safari inflation after rotation");
});

test("desktop gets larger footer via @media (min-width: 769px)", () => {
  const desktopBlock = extractMediaBlock(css, "min-width: 769px");
  assert.ok(desktopBlock, "expected @media (min-width: 769px) block");
  const decls = getDeclarations(desktopBlock, "#appFooter");
  assert.equal(decls["font-size"], "12px");
  assert.equal(decls["padding"], "6px 16px");
  assert.equal(decls["line-height"], "1.45");
});

test("no @supports (-webkit-touch-callout) block in CSS", () => {
  assert.ok(!css.includes("@supports (-webkit-touch-callout"),
    "CSS should not contain @supports (-webkit-touch-callout)");
});

test("html.ios .playbackBar sets bottom: 100px", () => {
  const decls = getDeclarations(css, "html.ios .playbackBar");
  assert.equal(decls["bottom"], "100px");
});

test("html.ios-landscape hides #appFooter on iPhone (not topbar, not iPad)", () => {
  assert.ok(!css.includes("html.ios-landscape #topbar"), "topbar must NOT be hidden in landscape");
  assert.ok(css.includes("html.ios-landscape #appFooter"), "should hide #appFooter in landscape");
  // Footer hide must be scoped to iPhone heights (≤500px), not iPads
  assert.ok(/max-height[^}]+html\.ios-landscape #appFooter|html\.ios-landscape #appFooter[^}]+max-height/.test(css.replace(/\s+/g, " ")) || css.includes("max-height: 500px"), "footer hide must be scoped by max-height for iPhone-only");
});

test("html.ios-landscape .playbackBar sets bottom: 46px", () => {
  const decls = getDeclarations(css, "html.ios-landscape .playbackBar");
  assert.equal(decls["bottom"], "46px");
});

// ── JS structural tests ─────────────────────────────────────────────────

test("app.js adds 'ios' class to documentElement", () => {
  assert.ok(appJs.includes("classList.add(\"ios\")") || appJs.includes("classList.add('ios')"),
    "app.js should add 'ios' class to html element");
});

test("app.js iOS detection has UA fallback for PWA standalone mode", () => {
  assert.ok(appJs.includes("iPad|iPhone|iPod") || appJs.includes("navigator.userAgent"),
    "app.js should fall back to UA sniffing for iOS detection in PWA mode");
  // Also needs navigator.standalone + maxTouchPoints for WKWebView edge cases
  assert.ok(appJs.includes("navigator.standalone"),
    "app.js should check navigator.standalone for PWA detection");
  assert.ok(appJs.includes("maxTouchPoints"),
    "app.js should check maxTouchPoints for iPad-as-Mac detection");
});

test("app.js toggles 'ios-landscape' class on orientation change", () => {
  assert.ok(appJs.includes("ios-landscape"),
    "app.js should toggle 'ios-landscape' class");
  assert.ok(appJs.includes("matchMedia") && appJs.includes("orientation: landscape"),
    "app.js should use matchMedia for orientation detection");
  assert.ok(appJs.includes("addEventListener") && appJs.includes("\"change\""),
    "app.js should listen for matchMedia change events");
});
