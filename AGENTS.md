# AI Agent Instructions for MobileAir

This document helps AI coding assistants understand and work with the MobileAir codebase effectively.

## Project Structure

```
mobileair/
├── mobile_air.py          # TUI application (Textual/Rich)
├── dashboard_server.py    # HTTP server + state management
├── mobileair_core.py      # Legacy core (being phased out)
├── airnow_slc.py          # AirNow data fetcher
├── mobileair/             # Core library package
│   ├── dashboard.py       # normalize_state_for_dashboard()
│   ├── mobility.py        # Movement/idle detection
│   ├── trails.py          # Trail processing
│   ├── aqi.py             # AQI calculations
│   └── ...
├── dashboard/             # Browser UI (vanilla JS, no framework)
│   ├── index.html
│   ├── app.js             # Main application (~5500 lines)
│   ├── map_nav_engine.js  # Map projection/navigation
│   └── tests/             # Node.js tests
└── tests/                 # Python unit tests
```

## Key Principles

### 1. Separation of Concerns

- **Pure logic** goes in `mobileair/` package - no UI dependencies
- **TUI code** stays in `mobile_air.py` - uses Textual/Rich
- **Server code** in `dashboard_server.py` - HTTP handling + state machine
- **Browser code** in `dashboard/` - vanilla JS, no build step

### 2. The State Contract

The JSON structure returned by `GET /api/state` is the contract between server and client. Changes must maintain compatibility:

```python
# Server: mobileair/dashboard.py
def normalize_state_for_dashboard(...) -> dict:
    return {
        "ts": float,           # Unix timestamp
        "mobile": [...],       # Mobile sensor array
        "fixed": [...],        # Fixed sensor array  
        "meta": {...}          # Metadata
    }
```

### 3. Trail Point `m` Flag

Every trail point must have an `m` flag:
- `m=1` → Moving (visible in playback)
- `m=0` → Idle (hidden in playback, marker dimmed)

This flag controls playback visibility. If you modify trail processing, ensure `m` is set correctly.

### 4. Performance Matters

The server handles many requests per second. Key optimizations:
- `cached_json_bytes`: Pre-serialized JSON, updated once per fetch cycle
- Avoid O(n) operations in request handlers
- Client caches static overlays as canvas images

## Common Tasks

### Adding a New Pollutant

1. Add breakpoints to `aqi_breakpoints.csv`
2. Update `mobileair/aqi.py` if special handling needed
3. Add color mapping in `dashboard_server.py:_get_aqi_color()`
4. Update client `app.js:valueToAqi()` if needed

### Modifying Mobility Detection

1. Edit `mobileair/mobility.py:evaluate_mobility()`
2. Update tests in `tests/test_mobility.py`
3. Consider impact on `m` flag assignment in `mobileair/dashboard.py`

### Adding a Data Source

1. Create fetcher module (like `airnow_slc.py`)
2. Add fetch loop in `dashboard_server.py`
3. Merge data in `update_app_state_with_new_data()` or via helper
4. Update `_inject_fixed_history()` if historical data is involved

### Client-Side Changes

1. Edit `dashboard/app.js` directly (no build step)
2. Test with `node --check dashboard/app.js`
3. Run JS tests: `cd dashboard/tests && node --test`

## Debugging Tips

### Check Raw API Data
```python
import requests
mobile = requests.get("https://utahaq.chpc.utah.edu/jsondata/MobileMapData.json").json()
fixed = requests.get("https://utahaq.chpc.utah.edu/jsondata/FixedSiteMapData.json").json()
```

### Test Normalization
```python
from mobileair import normalize_state_for_dashboard
result = normalize_state_for_dashboard(
    {"mobile": mobile, "fixed": fixed},
    custom_names={}, pinned_sensors=set(), max_points=5000,
    mobile_url="", fixed_url="", data_dir=""
)
```

### Check Specific Sensor
```python
for m in result["mobile"]:
    if m["id"] == "BUS10":
        print(m["mobility"])
        print(f"Trail points: {len(m['trail'])}")
        print(f"Moving points: {sum(1 for p in m['trail'] if p.get('m')==1)}")
```

### Server State Inspection
```python
import dashboard_server as ds
# Access app_state.fixed_history, app_state.airnow_readings, etc.
```

## Testing Requirements

Before submitting changes:

```bash
# Must pass
python -m unittest discover -s tests -p "test_*.py"

# Should pass (requires Node.js)
cd dashboard/tests && node --test
```

## Common Pitfalls

### 1. Forgetting `m` Flag
If you create or modify trail points, always set the `m` flag. Missing `m` causes playback issues.

### 2. Breaking JSON Serialization
The server pre-serializes JSON. If you add non-serializable objects (datetime, custom classes), wrap them:
```python
# Bad
entry["timestamp"] = datetime.now()

# Good  
entry["timestamp"] = datetime.now().isoformat() + "Z"
```

### 3. Modifying Shared State Without Lock
```python
# Bad
app_state.fixed_history[sensor_id] = data

# Good
with app_state.lock:
    app_state.fixed_history[sensor_id] = data
```

### 4. Client Canvas Coordinate Confusion
The map uses multiple coordinate systems:
- **Lat/Lon**: Geographic coordinates
- **World coordinates**: Mercator-projected pixels at zoom level
- **Screen coordinates**: Canvas pixel positions

Use the conversion functions: `latLonToWorld()`, `worldToScreen()`, `worldToScreenFast()`

## Code Style

### Python
- Type hints for function signatures
- Docstrings for public functions
- `snake_case` for functions and variables

### JavaScript
- No framework, vanilla JS only
- `camelCase` for functions and variables
- JSDoc comments for complex functions

## File Locations for Common Changes

| Change | File(s) |
|--------|---------|
| Mobility thresholds | `mobileair/mobility.py` |
| Trail processing | `mobileair/dashboard.py`, `mobileair/trails.py` |
| AQI colors | `dashboard_server.py:_get_aqi_color()`, `app.js:valueToAqi()` |
| Playback behavior | `dashboard/app.js` (search `playback`) |
| Fixed sensor history | `dashboard_server.py` (search `fixed_history`) |
| Ghosting logic | `dashboard_server.py:update_app_state_with_new_data()` |
| Map rendering | `dashboard/app.js:_drawOverlay()` |

## Questions to Ask Before Changing

1. **Does this affect the JSON contract?** If so, ensure backward compatibility.
2. **Does this need to persist across restarts?** Use `fixed_history.json` or similar.
3. **Is this logic or UI?** Put logic in `mobileair/`, UI in respective frontend.
4. **Does this affect playback?** Check `m` flag handling.
5. **Could this be slow in a loop?** Consider caching or pre-computation.

### Widget Development Notes
When creating TUI widgets with Rich:
- Use `rich.panel.Panel` for bordered boxes - it handles alignment correctly
- Use `rich.text.Text` for styled content inside panels
- Do NOT manually draw box characters with Rich markup - the markup tags break width calculations
- Example:
```python
from rich.panel import Panel
from rich.text import Text

content = Text()
content.append("value", style="#b8bb26")
return Panel(content, title="TITLE", width=21, height=6)
```

## Building the Native macOS Binary

The TUI can be packaged as a standalone macOS executable using PyInstaller.

### Build Command
```bash
cd /Users/johusha/Stuff/mobileair
python -m PyInstaller --noconfirm mobileair.spec
```

### Deploy Command
```bash
sudo rm -rf /opt/mobileair && sudo mv dist/mobileair /opt/mobileair
```

### Run the Binary
```bash
/opt/mobileair/mobileair
```

### Headless Mode (Server Only)
To run the dashboard server without the TUI (useful for logging/debugging):
```bash
/opt/mobileair/mobileair --headless
```
This prints all stdout/stderr to the terminal instead of redirecting to a log file.

You can also specify host and port:
```bash
/opt/mobileair/mobileair --headless --host 0.0.0.0 --port 8766
```

### Build + Deploy One-Liner
```bash
cd /Users/johusha/Stuff/mobileair && python -m PyInstaller --noconfirm mobileair.spec 2>&1 | tail -3 && sudo rm -rf /opt/mobileair && sudo mv dist/mobileair /opt/mobileair && echo "Done"
```

### Key Details
- **Spec file**: `mobileair.spec` - PyInstaller configuration
- **Output**: `dist/mobileair/` directory containing the executable and dependencies
- **Install location**: `/opt/mobileair/`
- **Binary size**: ~34 MB
- **Startup time**: ~1.6s warm, ~2.5s cold

---

## POST-MORTEM: LIVE Mode Playback Bug (January 2026)

### The Bug
In LIVE mode, trails were not rendering on first load, and the playhead was stuck at stale times instead of playing through the buffered data.

### Root Cause Analysis
The dashboard has TWO playback modes that share code but have DIFFERENT semantics:

| Mode | `playbackMode` | `_playbackLiveFollow` | Intended Behavior |
|------|----------------|----------------------|-------------------|
| **DVR** | `true` | `false` | User controls playhead, scrub anywhere |
| **LIVE** | `false` | `true` | Auto-play from buffer start, chase live edge |

The bug was caused by **over 20 locations** in `app.js` that checked `this.playbackMode` to decide whether to use playback time. In LIVE mode, `playbackMode === false`, so these checks fell through to wall-clock time or null, causing:

1. **Trails not rendering**: `refNowMs` fell back to `_dataNowMs()` (wall clock), making all trail points appear "expired" (age > 45 min decay window)
2. **Playhead stuck at stale time**: `_ensurePlaybackPoints` only initialized playhead on cache miss, but cached stale `maxMs` from first fetch
3. **Playback loop not running**: Early `if (!map.playbackMode) return;` killed the loop in LIVE mode

### The Correct Mental Model

**LIVE mode IS a playback mode** - it just auto-advances the playhead and snaps to new data. Both DVR and LIVE modes should:
- Use `getPlaybackTimeMs()` for time-based calculations
- Run the playback loop
- Initialize playhead from data bounds

The ONLY difference:
- **DVR**: Playhead controlled by user, `_playbackLiveFollow = false`
- **LIVE**: Playhead auto-advances, snaps to `maxMs` when new data arrives, `_playbackLiveFollow = true`

### Locations That Were Wrong (and why)

| Location | Bad Check | What Happened |
|----------|-----------|---------------|
| `pbTimeMs` in `drawTrailFor` (×2) | `this.playbackMode ? getPlaybackTimeMs() : null` | Trail clipping used null, showed nothing |
| `refNowMs` fallback (×2) | Fell back to `_dataNowMs()` | Wall clock expired all trails |
| `playbackLoop` early return | `if (!map.playbackMode) return` | Loop never ran in LIVE mode |
| `_ensurePlaybackPoints` wrapper | `if (map.playbackMode)` | Never built playback data in LIVE mode |

### The Fix Pattern

**DO NOT** check `this.playbackMode` to decide whether to use playback time.

**DO** use `getPlaybackTimeMs()` unconditionally for any time-based rendering:

```javascript
// BAD - breaks LIVE mode
const pbTimeMs = this.playbackMode ? this.getPlaybackTimeMs() : null;

// GOOD - works in both modes  
const pbTimeMs = this.getPlaybackTimeMs();
```

**DO** check `_playbackLiveFollow` when you need mode-specific behavior:

```javascript
// When new data arrives, snap playhead in LIVE mode only
if (this._playbackLiveFollow) {
  this._playbackNowMs = this._playbackMaxMs;
}
```

### Playhead Initialization Rules

1. **First load (LIVE)**: Set `_playbackNowMs = _playbackMaxMs` (start at live edge)
2. **First load (DVR)**: Set `_playbackNowMs = _playbackMaxMs` (start at end)
3. **New data arrives (LIVE)**: Snap `_playbackNowMs = _playbackMaxMs`
4. **New data arrives (DVR)**: Do NOT move playhead (user controls it)

### Trail Decay Reference Time (`refNowMs`)

The trail decay calculation uses `refNowMs` to determine point age. The fallback chain MUST be:

```javascript
const refNowMs = hasPlaybackTime ? Number(livePlaybackTimeMs) 
  : (isFinite(visMaxT) ? visMaxT 
  : (boundsMaxMs != null ? boundsMaxMs 
  : this._dataNowMs()));
```

**NEVER** fall back to wall clock (`_dataNowMs()`) if ANY data-based time is available. Wall clock is hours ahead of historical data.

### Testing Checklist for Playback Changes

Before deploying playback changes:

1. [ ] `node --check dashboard/app.js` passes
2. [ ] Fresh browser (incognito) shows trails on first load in LIVE mode
3. [ ] Playhead time matches header time on first load
4. [ ] Trails are visible immediately, not after waiting
5. [ ] DVR mode still works (click DVR toggle, scrub works)
6. [ ] No console errors about undefined variables

### Never Do These Things

1. **Never use `git checkout` on app.js** during a debugging session - it reverts ALL fixes
2. **Never remove variable declarations** without checking ALL usages first
3. **Never assume `playbackMode === false` means "not playing"** - LIVE mode plays with `playbackMode === false`
4. **Never fall back to wall clock time** for trail rendering - data timestamps are hours behind

---
