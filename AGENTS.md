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
