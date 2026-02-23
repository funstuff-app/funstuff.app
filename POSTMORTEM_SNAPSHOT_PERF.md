# Post-Mortem: Snapshot Load Performance on Raspberry Pi

**Date:** February 22, 2026
**Severity:** User-facing latency (20–30s load time for embedded widget)
**Resolution:** Eliminated redundant sanitization pass, reduced from ~25s to <2s

---

## Timeline

1. **Feature deployed:** `?date=` URL parameter support added to DustyTrails dashboard, allowing the landing page iframe to load historical snapshots on weekends instead of showing "offline."

2. **First symptom ignored:** After deploying `dashboard_server.py` with `start`/`duration` trimming, the widget still loaded at 5:00 AM instead of 11:00 AM. Assumed the change was live because `rsync` succeeded. **Root cause: forgot to restart the systemd service.** The Python process was still running the old code in memory.

3. **Service restarted.** Widget now loads at 11:00 AM. But load time is 20–30 seconds for a 1-hour data window. This is worse than expected — the time window trim should have reduced payload significantly.

4. **Research pass requested.** Traced the full request path:
   - `load_snapshot()` reads file from disk
   - `parse_and_sanitize_json()` runs `_sanitize_value()` recursively on every value
   - `_sanitize_string()` applies **19 compiled regex patterns** to every string
   - `validate_state_schema()` type-checks top-level structure
   - `_trim_trails_to_day()` parses every trail timestamp (UTC→local comparison)
   - `_trim_trails_to_window()` parses every surviving trail timestamp **again**
   - `json.dumps()` serializes the result

5. **Root cause identified:** The sanitization pass was the bottleneck. A snapshot file contains thousands of trail points, each with a timestamp string. `_sanitize_string` was called on every one, running 19 regex `.search()` calls per string. On a Raspberry Pi's ARM CPU, this dominated the request time.

6. **Secondary issue:** `_trim_trails_to_day` and `_trim_trails_to_window` both parsed every timestamp. When both were called, the day trim (5AM–5AM) was entirely redundant because the window trim (11AM–12PM) produces a strict subset.

---

## Root Causes

### 1. Re-sanitizing trusted data

`parse_and_sanitize_json` was designed as a security boundary: "never parse external JSON without sanitization." But snapshot files are **not external** — they're written by `save_snapshot()`, which already sanitizes incoming data via the same function on the POST path.

The load path was:
```
Client POST → parse_and_sanitize_json() → save to disk
Client GET  → read from disk → parse_and_sanitize_json() → respond
```

The second sanitization was pure waste. The trust boundary is at the write path (client-submitted data), not the read path (self-written files).

**Fix:** `load_snapshot()` now does `json.loads()` + `validate_state_schema()` only. No recursive sanitization.

### 2. Double timestamp parsing

```
_trim_trails_to_day()    — iterates all trail points, calls parse_utc_timestamp() on each
_trim_trails_to_window() — iterates survivors, calls parse_utc_timestamp() on each again
```

When `start`/`duration` params are present, the window is always a subset of the day window (e.g., 11–12h ⊂ 5–29h). The day trim pass is redundant.

**Fix:** When `start`/`duration` are valid, skip `_trim_trails_to_day()` entirely and only call `_trim_trails_to_window()`.

### 3. Deploying without restarting

`rsync` succeeded, the file was on disk, but the running Python process still had the old code loaded. This wasted a full debug cycle before the actual performance issue was even testable.

**Fix:** Documented in deploy checklist — `dashboard_server.py` changes always require `sudo systemctl restart dustytrails`.

---

## Impact

- **Before fix:** Embedded widget on `funstuff.app` took 20–30 seconds to load a 1-hour snapshot on weekends. Users saw a blank map with a loading spinner.
- **After fix:** Same request completes in <2 seconds. The dominant cost is now `json.loads` + `json.dumps` + network transfer, all proportional to the (now much smaller) 1-hour data window.

---

## What Went Well

- The "research only" pass (analyzing the pipeline before making changes) caught both the sanitization waste and the double-parse issue in one look.
- Parameters were designed to be optional and backwards-compatible from the start, so deploying in any order was safe.
- The time window trim (`start`/`duration`) was already reducing payload size — the sanitization was just masking the benefit.

---

## What Went Wrong

- The sanitization-on-read pattern was written with good intent ("security boundary") but applied at the wrong layer. It's a textbook case of defensive code becoming a performance problem when the threat model doesn't justify it.
- No performance testing on Pi hardware during development. The sanitization overhead is invisible on a fast dev machine.
- No deploy script enforces "restart after backend change." It's manual and forgettable.

---

## Action Items

- [x] Remove sanitization from `load_snapshot()` read path
- [x] Single-pass trim when `start`/`duration` are provided
- [x] Document restart requirement in deploy playbook
- [ ] Consider adding a simple deploy script that rsyncs + restarts in one command
- [ ] Add request timing logs to `_handle_load_snapshot` so future regressions are visible in journal output

---

## Prompting Lessons (for AI-assisted code review)

This bug was found by asking the model to **trace the data flow** rather than do a generic code review. Effective prompts for finding performance issues like this:

| Prompt pattern | Why it works |
|---------------|-------------|
| "Trace the full path of X request from handler to response. What work is unnecessary?" | Forces the model to enumerate every step and evaluate each one |
| "What data gets processed and then thrown away?" | Directly targets wasted computation |
| "Where does the same data get processed more than once?" | Catches double-parse patterns |
| "This runs on a Raspberry Pi" | Changes what matters — regex overhead that's invisible on x86 is brutal on ARM |
| "Research only for this turn" | Separates analysis from implementation, produces deeper findings |

The anti-pattern is "review this code for issues" — too broad, produces style nits instead of structural findings. Constrain the axis (performance, trust boundaries, redundant work) and you get real results.
