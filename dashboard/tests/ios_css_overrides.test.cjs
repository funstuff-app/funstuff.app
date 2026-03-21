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

test("no @supports (-webkit-touch-callout) block in CSS (JS handles iOS now)", () => {
  assert.ok(!css.includes("@supports (-webkit-touch-callout"),
    "CSS should not contain @supports (-webkit-touch-callout) — use class-based rules instead");
});

test("html.ios .playbackBar sets bottom: 100px", () => {
  const decls = getDeclarations(css, "html.ios .playbackBar");
  assert.equal(decls["bottom"], "100px");
});

test("html.ios-landscape hides #topbar and #appFooter", () => {
  // Check that both selectors exist with display: none
  assert.ok(css.includes("html.ios-landscape #topbar"), "should hide #topbar in landscape");
  assert.ok(css.includes("html.ios-landscape #appFooter"), "should hide #appFooter in landscape");
  const decls = getDeclarations(css, "html.ios-landscape #appFooter");
  assert.ok(decls["display"] && decls["display"].includes("none"),
    "html.ios-landscape #appFooter should have display: none");
});

test("html.ios-landscape .playbackBar sets bottom: 46px", () => {
  const decls = getDeclarations(css, "html.ios-landscape .playbackBar");
  assert.equal(decls["bottom"], "46px");
});

test("no portrait restore rule that overrides mobile footer sizing", () => {
  // There should be NO rule that sets font-size/padding on #appFooter
  // inside any iOS-specific context — the base @media (max-width:768px)
  // handles mobile footer sizing.
  const iosFooterRe = /html\.ios[^{]*#appFooter\s*\{([^}]+)\}/g;
  let m;
  while ((m = iosFooterRe.exec(css)) !== null) {
    const body = m[1];
    assert.ok(!body.includes("font-size"),
      "iOS #appFooter rule must not set font-size (overrides mobile responsive rules)");
    assert.ok(!body.includes("padding"),
      "iOS #appFooter rule must not set padding (overrides mobile responsive rules)");
  }
});

test("base @media (max-width: 768px) sets small footer sizing", () => {
  const mobileBlock = extractMediaBlock(css, "max-width: 768px");
  assert.ok(mobileBlock, "expected @media (max-width: 768px) block");
  const decls = getDeclarations(mobileBlock, "#appFooter");
  assert.equal(decls["font-size"], "10px", "mobile footer font-size should be 10px");
  assert.equal(decls["padding"], "4px 10px", "mobile footer padding should be 4px 10px");
});

// ── JS structural tests ─────────────────────────────────────────────────

test("app.js adds 'ios' class to documentElement", () => {
  assert.ok(appJs.includes("classList.add(\"ios\")") || appJs.includes("classList.add('ios')"),
    "app.js should add 'ios' class to html element");
});

test("app.js toggles 'ios-landscape' class on orientation change", () => {
  assert.ok(appJs.includes("ios-landscape"),
    "app.js should toggle 'ios-landscape' class");
  assert.ok(appJs.includes("matchMedia") && appJs.includes("orientation: landscape"),
    "app.js should use matchMedia for orientation detection");
  assert.ok(appJs.includes("addEventListener") && appJs.includes("\"change\""),
    "app.js should listen for matchMedia change events");
});
