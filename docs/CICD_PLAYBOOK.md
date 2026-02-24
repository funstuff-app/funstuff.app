# CI/CD Playbook: funstuff.app + DustyTrails

Written from the perspective of the automated deploy agent. This documents the deployment patterns, gotchas, and lessons learned from the `?date=` URL parameter feature rollout (Feb 2026).

---

## Architecture

| Service | Host | Port | Systemd Unit | Deploy Target |
|---------|------|------|-------------|---------------|
| DustyTrails dashboard | Pi `192.168.1.xxx` | 8766 | `dustytrails` | `/home/pi/dustytrails/` |
| Landing page | Pi `192.168.1.xxx` | 8767 | `funstuff-landing` | `/home/pi/funstuff/landing/` |

Both are exposed via a **cloudflared tunnel** (config at `/home/pi/.cloudflared/config.yml`).

User: `pi`. Sudo requires interactive password — no passwordless sudo.

---

## Deploy Checklist

### Landing page (static files — no restart needed)

```bash
rsync -avz landing/ pi@192.168.1.xxx:/home/pi/funstuff/landing/
```

Files are served directly by `landing_server.py`. No process restart required — changes are live immediately on next request.

### Dashboard frontend (app.js — no restart needed)

```bash
rsync -avz dashboard/app.js pi@192.168.1.xxx:/home/pi/dustytrails/dashboard/app.js
```

Served as a static file by `dashboard_server.py`. No restart needed — browser cache may delay pickup (Ctrl+Shift+R or wait for cache expiry).

### Dashboard backend (dashboard_server.py — RESTART REQUIRED)

```bash
rsync -avz dashboard_server.py pi@192.168.1.xxx:/home/pi/dustytrails/dashboard_server.py
ssh -t pi@192.168.1.xxx "sudo systemctl restart dustytrails"
```

**This is the one that bites you.** The Python process holds the old code in memory. If you deploy `dashboard_server.py` without restarting the service, nothing changes. I made this mistake — deployed the `start`/`duration` trim optimization, confirmed the file was on disk, and the user saw zero improvement because the process was still running the old code.

#### Verify after restart

```bash
ssh pi@192.168.1.xxx "systemctl is-active dustytrails"
# Should print: active
```

Journal logs require `adm` or `systemd-journal` group membership (pi has neither). This is cosmetic — don't chase it.

```bash
ssh pi@192.168.1.xxx "journalctl -u dustytrails --no-pager -n 5"
# Will fail with permission error — this is fine, service is running
```

---

## Three-Tier Deploy Pattern

When a feature spans all three tiers (landing JS → dashboard JS → backend Python), deploy in this order:

1. **Backend first** — deploy + restart. New params are ignored by old frontends (backwards compatible).
2. **Dashboard frontend second** — deploy app.js. It starts sending the new params.
3. **Landing page last** — deploy. It starts constructing iframe URLs with the new params.

This avoids the window where the frontend sends params the backend doesn't understand yet.

In practice, for this project, all three can be deployed simultaneously since we designed params to be optional and silently ignored if unrecognized. But the restart step is what matters — **don't forget step 1's restart**.

---

## Performance Lessons (Pi-Specific)

### Lesson 1: Sanitization cost is real on ARM

`parse_and_sanitize_json` recursively walks every value in the JSON and applies 19 compiled regex patterns to every string. On a snapshot with thousands of trail points (each with a timestamp string), this takes **20-30 seconds on a Raspberry Pi**.

**Fix:** Snapshots are written by `save_snapshot()`, which sanitizes on write. On read, skip sanitization entirely — just `json.loads` + schema validation. This is safe because we control the write path.

**Rule:** Never re-sanitize data you wrote yourself. Sanitize at the trust boundary (incoming POST from client), not at the storage boundary.

### Lesson 2: Don't double-parse timestamps

The original flow was:
1. `_trim_trails_to_day()` — parse every trail timestamp, keep 5AM–5AM window
2. `_trim_trails_to_window()` — parse every surviving timestamp again, keep 11AM–12PM window

The window is a strict subset of the day. When both are requested, skip step 1 entirely.

### Lesson 3: Send less data

For a preview widget that shows 30 seconds of animation, don't send 24 hours of trail data. The `start`/`duration` params let the server trim before serialization, reducing:
- JSON serialization time (`json.dumps` on a smaller dict)
- Network transfer (especially over Cloudflare tunnel → Pi's upload bandwidth)
- Client-side parsing and playback point construction

---

## URL Parameter Reference

All parameters are optional. Invalid values are silently ignored (fallback to defaults).

### Dashboard (`dustytrails.funstuff.app/?...`)

| Param | Format | Range | Default | Purpose |
|-------|--------|-------|---------|---------|
| `date` | `YYYY-MM-DD` | Last 7 days | (none → live mode) | Load historical snapshot |
| `start` | integer | 0–23 | 5 | Start hour (Mountain Time) for data window |
| `duration` | integer | 1–24 | 24 | Hours of trail data to include |
| `playhead` | integer | 0–1440 | 0 | Minutes offset from start hour for initial playhead position |

**Validation chain:**
- Frontend (`app.js`): regex + real-date check + 7-day range → silently falls back to live
- Backend (`dashboard_server.py`): filename sanitization + file existence check → 404 if missing
- Frontend handles 404 by falling back to `tick()` (live mode)

### Landing page iframe construction (`fun.js`)

On weekends: `?date=2026-02-20&start=11&duration=1&playhead=30`
On weekdays: no params (live mode)

Rotation: sessionStorage key `funstuff_weekday_idx` cycles through 0–4 (Fri→Thu→Wed→Tue→Mon) across reloads.

---

## Files Changed in This Feature

| File | What | Restart? |
|------|------|----------|
| `dashboard_server.py` | `_trim_trails_to_window()`, skip sanitization in `load_snapshot()`, single-pass trim optimization | **Yes** |
| `dashboard/app.js` | URL param parsing at startup, `loadHistoricalDay(dateStr, opts)` with `startHour`/`duration`/`playhead` | No |
| `landing/fun.js` | Weekend date computation, iframe src with `?date=&start=&duration=&playhead=` | No |
| `landing/index.html` | iframe `src` → `data-src` + `id`, snapshot indicator div | No |
| `landing/style.css` | `.snapshot-indicator` styling | No |

---

## Rollback

### Quick rollback (frontend only)
```bash
# Revert app.js to previous version
cd /Users/johusha/Stuff/mobileair
git checkout HEAD~1 -- dashboard/app.js landing/fun.js landing/index.html landing/style.css
rsync -avz dashboard/app.js pi@192.168.1.xxx:/home/pi/dustytrails/dashboard/app.js
rsync -avz landing/ pi@192.168.1.xxx:/home/pi/funstuff/landing/
```

### Full rollback (including backend)
```bash
git checkout HEAD~1 -- dashboard_server.py
rsync -avz dashboard_server.py pi@192.168.1.xxx:/home/pi/dustytrails/dashboard_server.py
ssh -t pi@192.168.1.xxx "sudo systemctl restart dustytrails"
```

### Verify rollback
- Landing page: refresh `funstuff.app`, iframe should load live mode
- Dashboard: open `dustytrails.funstuff.app`, should start in live mode with no URL params
- Backend: `systemctl is-active dustytrails` → `active`
