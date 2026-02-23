# Context Handoff: funstuff.app Landing Page + Snapshot URL Parameter

## Current State

The funstuff.app landing page is **live and deployed** on the same Raspberry Pi that hosts DustyTrails.

### Architecture

| URL | Service | Port | Server |
|-----|---------|------|--------|
| `dustytrails.funstuff.app` | DustyTrails dashboard | 8766 | `dashboard_server.py` (Python BaseHTTPRequestHandler) |
| `funstuff.app` / `www.funstuff.app` | Landing page | 8767 | `landing_server.py` (Python static file server) |

Both services run as systemd units on a Raspberry Pi at `192.168.1.xxx` (user `pi`), exposed via a **cloudflared tunnel** (tunnel name `dustytrails`, config at `/home/pi/.cloudflared/config.yml`).

### Landing Page

- **Files:** `landing/index.html`, `landing/style.css`, `landing/fun.js`, `landing/robots.txt`, `landing/sitemap.xml`
- **Server:** `landing_server.py` (root of repo), serves from `landing/` dir
- **Design:** Windows 95 aesthetic — teal desktop, beveled window chrome, VT323 monospace font, CRT scanlines, taskbar with clock, BSOD easter egg on close button
- **Deploy:** `deploy/landing/deploy_landing.sh`, service file at `deploy/landing/funstuff-landing.service`
- Quick redeploy: `./deploy_landing.sh --files-only` or just `rsync` individual files to `/home/pi/funstuff/landing/`

### Two Embedded Demos (iframes)

1. **Map preview** — `dustytrails.funstuff.app/` in a `.demo-window` with `pointer-events: none` and a clickable `.demo-overlay` that opens the full app. CSS class: `.map-viewport` (340px height, responsive).

2. **TUI terminal** — `dustytrails.funstuff.app/tui.html` in a terminal-styled `.demo-window`. Class: `.tui-viewport` (380px).

**Problem:** On weekends, the embedded map shows "offline" because there's no live mobile sensor data (buses/trains don't run). The map loads in live mode by default and there's nothing to show.

---

## Task: Add `?date=` URL Parameter Support

### Acceptance Criteria

1. **Landing page iframe uses a `?date=YYYY-MM-DD` URL parameter** to load a weekday snapshot when it's the weekend (or whenever there's no live data to show).

2. **DustyTrails frontend (`dashboard/app.js`) reads the `?date=` URL parameter on load** and passes it to the existing `/api/snapshot/load?date=YYYY-MM-DD` endpoint instead of starting in live mode.

3. **Day selection logic (client-side, in `landing/fun.js`):**
   - Only activates on weekends (Saturday/Sunday)
   - Picks the most recent Friday on first load
   - Each reload increments through the week's weekdays (e.g., Fri → Thu → Wed → Mon → Tue → back to Fri)
   - Rotation state can be stored in sessionStorage or similar

4. **Strict input sanitization on BOTH ends:**
   - **Frontend (app.js):** Validate `?date=` is exactly `YYYY-MM-DD` format, is a real date, falls within the last 7 days. If invalid, silently ignore and load live mode as if no parameter was passed.
   - **Backend (dashboard_server.py):** The `/api/snapshot/load` endpoint already sanitizes the date parameter (regex `[a-zA-Z0-9-]`, max 20 chars). If the snapshot file doesn't exist for that date, it returns 404. The frontend should handle 404 by falling back to live mode.
   - No arbitrary data should pass through. Any bad input → silent fallback to default behavior.

5. **Keep a compact display on the landing page** showing the hour/snapshot info for the currently loaded data.

### Existing Snapshot System (what already works)

**Backend endpoints:**
- `GET /api/snapshots` — returns list of available snapshot dates with metadata
- `GET /api/snapshot/load?date=YYYY-MM-DD` — loads snapshot, trims trails/history to that day, strips stale PurpleAir. Returns 400 if no `?date=`, 404 if file missing.
- `POST /api/snapshot/save?date=YYYY-MM-DD` — saves current state

**Frontend snapshot loading (`dashboard/app.js`):**
- `loadHistoricalDay(dateStr)` — fetches `/api/snapshot/load?date=YYYY-MM-DD`, sets `map._historicalMode = true`, builds playback points, sets playhead to **5 AM local**, auto-plays
- `loadSnapshotByDate(dateStr)` — similar but sets playhead to start of data
- Days menu fetches `/api/snapshots` to show available dates (7 days of history)
- Date format everywhere: `YYYY-MM-DD` strings

**Frontend startup (`app.js` ~L3960):**
```javascript
loadConfig().then(() => {
  applyTheme(_currentThemeKey, true);
  tick(); // starts live polling — NO URL param check currently
});
```

### What Changed

1. **`dashboard/app.js`:** After `loadConfig()` resolves, check `URLSearchParams` for a `date` param. Validate it (regex, date range, is a real date). If valid, call `loadHistoricalDay(dateStr)` instead of `tick()`. If invalid or missing, proceed with `tick()` as normal.

2. **`landing/fun.js`:** Compute the iframe `src` URL dynamically. On weekends, append `?date=YYYY-MM-DD` for a recent weekday. Rotate through weekdays across reloads.

3. **`landing/index.html`:** The iframe `src` should probably be set to a placeholder or empty, then set dynamically by `fun.js`. Add a small status indicator showing which day is loaded.

### Key Files Edited

| File | What to change |
|------|---------------|
| `dashboard/app.js` | Add URL param parsing at startup, validate, call `loadHistoricalDay()` |
| `landing/fun.js` | Compute `?date=` param for iframe src, weekday rotation logic |
| `landing/index.html` | Make iframe src dynamic, add snapshot date indicator |
| `landing/style.css` | Style the date indicator |

### Deployment

After changes, deployed both:
- **Landing page:** `rsync -avz landing/ pi@192.168.1.xxx:/home/pi/funstuff/landing/`
- **Dashboard:** Use existing `deploy/dustytrails/deploy_to_pi.sh` or targeted rsync of `dashboard/app.js` to `/home/pi/dustytrails/dashboard/app.js`

### SEO / Social Meta Tags

The landing page currently uses `https://dustytrails.funstuff.app/icon-512.png` as the `og:image` and `twitter:image` placeholder. A dedicated social preview image for `dustytrails.funstuff.app` just like the widget on the funstuff.app landing homepage (1200×630px) should be created and hosted at a stable URL, then updated for preview crawlers.

**Screenshot-based preview image:** The landing server should periodically capture a screenshot of the DustyTrails dashboard at the same size as the embedded widget, to use as the `og:image`. Key requirements:
- **Hit `localhost:8766` directly** — NOT the public `dustytrails.funstuff.app` URL. Both services run on the same Pi, so this avoids Cloudflare traffic/analytics/bot detection entirely.
- Use the same day-selection logic as the embedded widget (load a popular weekday snapshot on slow weekends, etc.)
- Chromium headless is needed on the Pi (`apt install chromium`) — not currently installed.
- Store the screenshot in `landing/` as a static file (e.g., `preview.png`) and serve it normally.

### Gotchas

- The iframe has `sandbox="allow-scripts allow-same-origin"` — this is fine for the app to function
- `pointer-events: none` on the map iframe means users can't interact — it's a preview only
- The Pi is at `192.168.1.xxx`, user `pi`, sudo requires password (use `ssh -t` for interactive sudo)
- The dashboard server does NOT set `X-Frame-Options`, so iframe embedding works
- The landing server sets `X-Frame-Options: DENY` but that only applies to the landing page itself, not the dashboard
