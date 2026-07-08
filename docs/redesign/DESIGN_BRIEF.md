# DustyTrails front-end redesign — design brief

Branch: `claude/frontend-redesign-2026` (isolated worktree, branched clean from `main`).
Status: exploratory redesign, design-first, **not** feature-parity-constrained.
This document is the audit + synthesis that the rebuild below implements. It exists so
the reasoning survives past the session that produced it.

## Scope decision (the load-bearing call)

The canvas rendering engine (`map_view.js` + its 9 `engine_*` controllers: tiles, road
matching, vehicle motion, playback physics, wind advection, PA field kernel, overlay
rendering, camera/gestures) is mature, heavily tested, and was extensively hardened this
session (playback edge semantics, touch-scrub fixes). None of that is a "front-end
interface" problem — it's the data engine. Rewriting it would burn the entire time
budget on parity work with zero design payoff.

**This redesign touches the shell: `index.html` markup, `styles.css` (full rewrite as a
token system), and the thin DOM-wiring layer** (`app.js`, `ui_legend.js`,
`ui_playback.js`, `ui_snapshots_menus.js`, `ui_theme.js`, `sidebar_ui.js`) wherever it
references element ids/classes that the new markup renames. The rendering engines,
`playback_state.js`, workers, and data/projection/AQI math are untouched. This is a
skin-and-information-architecture redesign riding on a working data engine — genuinely
demoable against real data, not a static mock, and not an infeasible full rewrite.

## Audit findings (current app, read down to the CSS custom properties)

**Visual system.** Five CSS custom properties total (`--bg`, `--panel`, `--panel2`,
`--text`, `--muted`, `--accent`, `--border`); everything else is hardcoded
`rgba(...)`/`px` literals scattered file-wide. Measured sprawl: **10 distinct
border-radius values** (1–14px), **11 distinct font-sizes** (8–28px, no scale), **12+
distinct transition timing/easing pairs**. No light theme anywhere — `:root` is a single
dark palette, and the only two active map tile themes are both CARTO Dark variants
(Positron/light variants exist in `config.js` but are commented out). Icons are mixed:
hand-drawn inline SVGs for the hamburger/camera/share/collapse buttons, but raw emoji
(📅🎨🖥️🔧ℹ️) for the DVR menu — visually inconsistent icon language.

**Accessibility.** Zero `prefers-reduced-motion` handling. Zero `aria-live` regions (the
Live/Offline status text and playback clock update with no screen-reader announcement).
One `:focus` rule in 2,224 lines — keyboard focus is almost entirely unstyled. Several
label/value pairs run at 10–11px on a `--muted` (#93a4ba) gray that is worth re-checking
against AA at that size. All severity encoding (field color, marker rings, legend) is
hue-only with no redundant shape/pattern channel.

**Information architecture.** The DVR "Menu" button is a flat catch-all: Select Day,
Theme, Display, Debug, About, each behind a nested submenu (2 taps to reach anything).
Select Day is a *core* feature (historical playback) demoted to the same tier as Debug.
The playback bar auto-hides on an inactivity timer with an unclear reveal gesture. The
legend, when expanded, consumes ~35–40% of the viewport height on mobile for what is
structurally a 7-row lookup table (swatch · range · category label). A barrel jog-wheel
control exists fully built in CSS/JS (`.jogWheel`, `.jogBarrel`, `jog_wheel.js`) but is
feature-flagged off (`display:none`, "SHUNTED" in comments) — dead-but-present, and
actually a great fit for the DVR framing if revived as a clean shuttle-ring control.

**Data-viz clarity.** Screenshotted live: overlapping-sensor field blending produces
muddy olive/yellow-green washes that don't map cleanly back to any single legend swatch
at a glance — a real readability problem, not just a taste one. Vehicle trail dashes and
marker rings currently compete visually with the field itself; the field (the actual air
quality data) should have priority, with trails as secondary/on-demand detail.

## The committee (simulated, single-author synthesis — not spun up as separate agents per
instruction; five perspectives reasoned through explicitly before converging)

- **Visual/brand:** commit to an "atmospheric instrument" identity — near-monochrome ink
  chrome (blacks/near-blacks/off-white) so color stays *reserved* for data (the AQI
  ramp) and the live-state accent. Real type scale. Tabular-nums for every numeric
  readout. Retire backdrop-blur-glass-everywhere as the whole language; use it once,
  deliberately, not as the default panel treatment.
- **Interaction/UX:** promote Select Day out of the generic menu into its own primary
  affordance (it's a mode switch, not a setting). Collapse Theme/Display/Debug/About
  into a single settings surface. Replace CHROME emoji icons (menu items) with the
  existing inline-SVG language. **Decided against reviving the jog-wheel/barrel shuttle
  this pass**: it's fully built (`jog_wheel.js`, wired in `ui_playback.js`) but was
  deliberately feature-flagged off, for a reason this session doesn't have visibility
  into, and re-enabling disabled interaction code under time pressure is a functional-
  risk gamble that contradicts the "ride on a working, tested engine" scope boundary.
  Left untouched and still hidden; flagged as a good candidate for a *future*, focused
  pass with room to actually test it. The sensor-list `.emoji` glyph is data-driven
  (server can send any sensor-specific character) and is deliberately kept as emoji,
  given a proper icon-badge frame instead of a guessed SVG mapping.
- **Data-viz:** de-emphasize trails at rest (thin, low-opacity, brighten on
  hover/select) so the field reads first. Compress the legend into a gradient gauge with
  tick marks and a value pointer, with the full breakpoint table as an expandable detail
  — same information, a fraction of the vertical footprint.
- **Accessibility:** ship `prefers-reduced-motion` support, real focus-visible styling
  on every interactive element, `aria-live="polite"` on the status/clock readouts,
  44×44px minimum touch targets, and verified AA contrast for every text/background
  pairing in the new token set.
- **Engineering:** split the monolithic `styles.css` into token + per-component files
  (matching the existing per-file JS module convention — no bundler exists, so multiple
  `<link>` tags is the idiomatic answer here, same pattern as the 26 `<script defer>`
  tags already in `index.html`). Keep the canvas/data engine untouched.

## Design tokens (the new system)

Ink-dark neutral scale + a single reserved accent (`--live`, the electric cyan that
already read as "data/live" in the old palette) + the AQI ramp as its own named token
group so it's never hand-typed as a literal again. 8-step type scale with defined
line-heights. 5-step spacing scale (4/8/12/16/24px) replacing ad-hoc padding literals.
4-step radius scale (4/8/12/999px-pill) replacing the 10-value sprawl. Two motion
tokens: `--ease-standard` (0.2s cubic-bezier) and `--ease-emphasized` (0.4s
cubic-bezier), replacing the 12+ ad-hoc timings. Full token list lives in
`dashboard/styles/00-tokens.css`.

## File plan

```
dashboard/styles/
  00-tokens.css       design tokens: color, type, space, radius, motion, elevation
  01-base.css         reset, body, focus-visible, reduced-motion, scrollbars
  02-shell.css        #app, header/topbar, footer, status pill
  03-map.css          map root, canvases, loading/paused shades
  04-legend.css        legend gauge + expandable breakdown
  05-sidebar.css       sensor list panel + cards
  06-playback.css      transport bar, shuttle ring, scrub, speed
  07-menu.css          command surface (day picker / settings)
  08-modal.css          about modal, PWA install banner
  09-debug.css          field-debug panel (dev only, still isolated/consistent)
index.html            new semantic structure, same element ids where JS depends on
                        them, `<link>` chain replacing the single styles.css
```
