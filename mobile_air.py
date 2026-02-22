import json
import webbrowser
from datetime import datetime, timedelta, timezone
import os
import math
import hashlib
import time
import sys
import signal
import subprocess
import urllib.request
import urllib.error
from typing import Literal
from pathlib import Path

# Import from the mobileair package
from mobileair import (
    # Configuration
    IMMOBILITY_LOOKBACK_MINUTES,
    IMMOBILITY_MIN_COVERAGE_MINUTES,
    IMMOBILITY_MIN_SAMPLES,
    IMMOBILITY_TOTAL_DISTANCE_THRESHOLD,
    IMMOBILITY_MAX_STEP_THRESHOLD,
    IMMOBILITY_BBOX_THRESHOLD,
    IMMOBILITY_RADIUS_THRESHOLD,
    TREND_LOOKAHEAD_MINUTES,
    TREND_WINDOW_SAMPLES,
    TREND_THRESHOLDS,
    AQI_LEVELS,
    POLLUTANT_BREAKPOINTS,
    MOBILE_URL,
    FIXED_URL,
    HEADERS,
    # Functions
    parse_utc_timestamp,
    haversine_distance,
    bounding_box_distance,
    value_to_aqi,
    aqi_level,
    color_for_value,
    trend_threshold,
    compute_trend_indicator,
    evaluate_mobility,
    default_cache_path,
    fetch_json_with_cache,
    generate_leaflet_map_html,
    detect_spatial_outliers,
    stdlib_get,
    # TUI formatting (shared with web console)
    get_pollutant_columns,
    format_json_view,
    POLLUTANT_ORDER,
    VALUE_WIDTH,
    MAX_NAME_LEN,
)

# Optional runtime dependencies (TUI). If missing, fail with an actionable message.
try:
    from textual.app import App, ComposeResult
    from textual.widgets import Header, Footer, Static, Markdown, ListView, ListItem, Label, Input, Button
    from textual.containers import Horizontal, Container, Vertical, Grid, VerticalScroll
    from textual.screen import ModalScreen
    from textual.reactive import reactive
    from textual import work
    from rich.panel import Panel
    from rich.table import Table
    from rich.console import Group
    from rich.align import Align
    from rich.text import Text
    from rich.json import JSON
    from rich.theme import Theme
except ModuleNotFoundError as e:
    raise SystemExit(
        "Missing required dependency for the TUI.\n"
        "Install deps with:\n"
        "  python -m pip install -r requirements.txt\n"
    ) from e


def _dashboard_data_dir() -> Path:
    return Path(os.path.expanduser("~/.mobileair"))


def _is_bundled() -> bool:
    """Check if running as a PyInstaller bundle."""
    return getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS')


def _start_dashboard_server_process() -> subprocess.Popen | tuple | None:
    """Start the browser dashboard server in the background.

    When running normally, this starts a subprocess.
    When running as a PyInstaller bundle, this starts an in-process thread.
    
    Returns:
        - subprocess.Popen when running normally
        - (stop_event, httpd) tuple when bundled
        - None if disabled or failed
    """

    # Allow users to disable auto-start.
    if os.environ.get("MOBILEAIR_AUTO_DASHBOARD", "1").strip() in ("0", "false", "False", "no", "NO"):
        return None

    port = int(os.environ.get("MOBILEAIR_DASHBOARD_PORT", "8766"))
    # Default to LAN-accessible binding for dashboard access from other devices.
    # Users can still override via MOBILEAIR_DASHBOARD_HOST.
    host = os.environ.get("MOBILEAIR_DASHBOARD_HOST", "0.0.0.0")

    data_dir = _dashboard_data_dir()
    data_dir.mkdir(parents=True, exist_ok=True)
    
    # When bundled, run server in-process as a thread
    if _is_bundled():
        try:
            from dashboard_server import start_server_in_thread
            return start_server_in_thread(host=host, port=port)
        except Exception:
            return None

    # Normal mode: run as subprocess
    log_path = data_dir / "dashboard_server.log"

    # Keep server logs out of the TUI terminal by default.
    # If you want logs in-terminal, run `python dashboard_server.py` directly.
    try:
        log_fh = log_path.open("ab", buffering=0)
    except Exception:
        log_fh = subprocess.DEVNULL

    cmd = [sys.executable, str(Path(__file__).resolve().parent / "dashboard_server.py"), "--host", host, "--port", str(port)]
    try:
        proc = subprocess.Popen(cmd, stdout=log_fh, stderr=log_fh)
    except Exception:
        return None

    return proc

class NameInputScreen(ModalScreen):
    def __init__(self, sensor_name: str, current_name: str = ""):
        super().__init__()
        self.sensor_name = sensor_name
        self.current_name = current_name

    def compose(self) -> ComposeResult:
        yield Grid(
            Label(f"Enter name for {self.sensor_name}:", id="question"),
            Input(value=self.current_name, placeholder="Custom Name", id="name_input"),
            Button("Save", variant="primary", id="save"),
            Button("Cancel", variant="default", id="cancel"),
            id="dialog"
        )

    def on_mount(self) -> None:
        self.query_one(Input).focus()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "save":
            self.dismiss(self.query_one(Input).value)
        else:
            self.dismiss(None)
            
    def on_input_submitted(self, event: Input.Submitted) -> None:
        self.dismiss(event.value)

class SensorItem(ListItem):
    def __init__(
        self,
        sensor_name: str,
        sensor_readings: list,
        coords: tuple[float, float] | None = None,
        is_fixed: bool = False,
        custom_name: str = "",
        mobility_info: dict | None = None,
        ghosted: bool = False,
        pinned: bool = False,
    ) -> None:
        super().__init__()
        self.sensor_name = sensor_name
        self.sensor_readings = sensor_readings # list of tuples: (key, value, color, history, history_colors, trend_info)
        self.coords = coords # (lat, lon)
        self.is_fixed = is_fixed
        self.custom_name = custom_name
        self.mobility_info = mobility_info or {}
        self.is_ghost = ghosted
        self.pinned = pinned

    def _to_readings_dict(self) -> dict:
        """Convert sensor_readings list to dict format for shared formatting functions."""
        readings = {}
        for row_data in self.sensor_readings:
            if len(row_data) >= 3:
                key = row_data[0]
                value = row_data[1]
                color = row_data[2]
                history = row_data[3] if len(row_data) > 3 else []
                history_colors = row_data[4] if len(row_data) > 4 else []
                trend_info = row_data[5] if len(row_data) > 5 else None
                readings[key] = {
                    "value": value,
                    "color": color,
                    "history": history,
                    "history_colors": history_colors,
                    "trend": trend_info,
                }
        return readings

    def compose(self) -> ComposeResult:
        display_name = self.sensor_name
        if self.custom_name:
            display_name = f"{self.sensor_name} ({self.custom_name})"
            
        title = f"{display_name}"
        if self.pinned:
            title = f"📌 {title}"
        
        title_class = "fixed" if self.is_fixed else "mobile"
        yield Label(title, classes=f"sensor-title {title_class}")
        
        # Convert to dict format and use shared pollutant columns
        readings_dict = self._to_readings_dict()
        columns = get_pollutant_columns(readings_dict)
        
        # Build readings text with fixed-width columns (using shared format)
        readings_text = Text()
        for i, col in enumerate(columns):
            if i > 0:
                readings_text.append("  ")  # Column separator (2 spaces)
            
            if col["has_value"]:
                # Format: "PM25: 21.10 ▲" - uses shared VALUE_WIDTH
                readings_text.append(f"{col['label']}: ", style="#928374")
                readings_text.append(col["formatted"], style=col["color"])
                readings_text.append(" ")
                # Get trend from our stored data (more accurate than recalculating)
                reading = readings_dict.get(col["key"], {})
                trend_info = reading.get("trend")
                if trend_info and isinstance(trend_info, dict):
                    t_sym = trend_info.get("symbol", " ")
                    t_col = trend_info.get("color", col["color"])
                else:
                    t_sym = col["trend_symbol"]
                    t_col = col["trend_color"]
                readings_text.append(t_sym, style=t_col)
            else:
                # Empty placeholder - same width as filled column
                # label(4) + ": "(2) + value(VALUE_WIDTH) + " "(1) + trend(1) = 13
                placeholder_width = len(col["label"]) + 2 + VALUE_WIDTH + 2
                readings_text.append(" " * placeholder_width)
        
        yield Label(readings_text, classes="sensor-readings")

class AirQualityApp(App):
    CSS = """
    Screen {
        layout: vertical;
        background: #1d2021;
        color: #ebdbb2;
        overflow: hidden;
    }

    Header {
        background: #32302f;
        color: #d5c4a1;
    }

    Footer {
        background: #32302f;
        color: #d5c4a1;
    }

    Footer .footer--key {
        color: #fabd2f;
        text-style: bold;
    }

    .footer-status {
        height: 1;
        background: #282828;
        color: #928374;
        padding: 0 1;
        text-align: center;
    }

    #dialog {
        grid-size: 2;
        grid-gutter: 1 2;
        grid-rows: 1fr 3;
        padding: 0 1;
        width: 60;
        height: 11;
        border: thick #458588;
        background: #1d2021;
        color: #ebdbb2;
    }
    #question {
        column-span: 2;
        height: 1fr;
        width: 1fr;
        content-align: center middle;
    }
    #name_input {
        column-span: 2;
        width: 1fr;
    }
    .main-content {
        height: 1fr;
        layout: vertical;
    }
    #details_container {
        width: 100%;
        height: auto;
        max-height: 50%;
        min-height: 14;
        padding: 0;
        border-bottom: solid #458588;
        scrollbar-gutter: stable;
    }
    #details_view {
        width: 100%;
        height: auto;
        padding: 0;
    }
    #bottom_pane {
        width: 100%;
        height: 1fr;
    }
    ListView {
        height: 100%;
        width: 1fr;
        max-width: 70;
        min-width: 45;
        border-right: solid #458588;
        background: #1d2021;
        scrollbar-gutter: stable;
    }
    #json_container {
        width: 1fr;
        height: 100%;
        background: #1d2021;
        padding: 0;
        overflow: hidden;
        scrollbar-gutter: stable;
    }
    #json_view {
        width: 100%;
        height: 100%;
        padding: 0;
        overflow: hidden auto;
    }
    ListItem {
        padding: 0 1;
        border-bottom: solid #32302f;
        height: auto;
        overflow: hidden;
    }

    ListItem.--highlight {
        background: #458588;
        color: #fbf1c7;
    }

    ListItem.--highlight .sensor-readings {
        color: #fbf1c7;
    }

    .sensor-title {
        text-style: bold;
        width: 100%;
        color: #ebdbb2;
        text-wrap: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .sensor-title.mobile {
        color: #b8bb26;
    }

    ListItem.--highlight .sensor-title {
        color: #fbf1c7;
    }
    .sensor-readings {
        width: 100%;
        color: #928374;
        text-wrap: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .sensor-ghost {
        background: #1d2021;
        color: #928374;
        text-style: dim italic;
    }
    .sensor-ghost .sensor-title,
    .sensor-ghost .sensor-readings {
        color: #928374;
        text-style: dim italic;
    }
    .status-bar {
        height: auto;
        padding: 0 1;
        background: #1d2021;
        color: #928374;
        border-bottom: solid #32302f;
        width: 100%;
    }
    .status-bar Static {
        width: auto;
        padding: 0 1;
    }
    .status-bar #wind_indicator {
        width: auto;
        padding: 0;
        color: #83a598;
    }
    """

    BINDINGS = [
        ("r", "force_refresh_data", "Refresh Data"),
        ("q", "quit", "Quit"),
        ("n", "rename_sensor", "Name Sensor"),
        ("m", "open_map", "Open Map"),
        ("M", "open_overview_map", "Open Overview Map"),
        ("h", "toggle_ghost_state", "Toggle Ghost State"),
        ("p", "toggle_pin", "Pin Sensor"),
    ]

    last_updated = reactive("Never")
    current_data = reactive({})
    custom_names = reactive({})
    forced_active_sensors = set()
    pinned_sensors = set()
    fixed_history = {}
    _refresh_token = 0
    _max_readings_count = 3  # minimum pad for details table

    def __init__(self, *, dashboard_handle=None, **kwargs):
        super().__init__(**kwargs)
        self.dashboard_handle = dashboard_handle

    def _request_web_force_refresh(self) -> None:
        """Force the served web dashboard to treat the next poll as "new data".

        No new HTTP endpoints: this uses in-process access when bundled
        (threaded server), and SIGUSR1 when the dashboard runs as a subprocess.
        """
        h = getattr(self, "dashboard_handle", None)
        if h is None:
            return

        # Bundled mode: in-process server via start_server_in_thread() returns (stop_event, httpd)
        if isinstance(h, tuple) and len(h) >= 2:
            httpd = h[1]
            app_state = getattr(httpd, "app_state", None)
            if app_state is None:
                return
            try:
                from dashboard_server import bump_force_refresh_seq
                bump_force_refresh_seq(app_state)
            except Exception:
                return
            return

        # Normal mode: dashboard server is a subprocess; signal it.
        pid = getattr(h, "pid", None)
        if isinstance(pid, int) and pid > 0:
            try:
                if hasattr(signal, "SIGUSR1"):
                    os.kill(pid, signal.SIGUSR1)
            except Exception:
                pass

    def compose(self) -> ComposeResult:
        # Theme is automatically handled by Textual for known themes like 'gruvbox',
        # but we need to ensure it's set on app startup if available, or define custom if not.
        # For simple usage, we can just set the app.theme property in on_mount.
        # Ensure mouse support is enabled (it is by default in Textual, but ensuring scrollable containers work)
        yield Header()
        with Horizontal(classes="status-bar"):
            yield Static("", id="summary_widget")
            yield Static("", id="sparkline_widget")
            yield Static("", id="pm10_widget")
            yield Static("", id="region_widget")
            yield Static("", id="wind_indicator")
        with Vertical(classes="main-content"):
            with VerticalScroll(id="details_container"):
                yield Static(id="details_view")
            with Horizontal(id="bottom_pane"):
                yield ListView(id="sensors_list")
                with VerticalScroll(id="json_container"):
                    yield Static(id="json_view")
        yield Static("", id="footer_status", classes="footer-status")
        yield Footer()

    def on_mount(self) -> None:
        # We fully control styling to match the web TUI palette.
        # Keep Textual theming from influencing colors.
        self.setup_data_dir()
        self.load_custom_names()
        self.load_fixed_history()
        self.load_pinned_sensors()

        # Match the web JSON syntax colors (see dashboard/tui.css + dashboard/tui.js).
        try:
            self.console.push_theme(
                Theme(
                    {
                        "json.brace": "#ebdbb2",
                        "json.bracket": "#ebdbb2",
                        "json.colon": "#ebdbb2",
                        "json.comma": "#ebdbb2",
                        "json.key": "#d3869b",
                        "json.string": "#b8bb26",
                        "json.number": "#83a598",
                        "json.boolean": "#d3869b",
                        "json.null": "#fabd2f",
                    }
                )
            )
        except Exception:
            pass

        self.action_refresh_data()
        # Poll every 1 minute (60 seconds)
        self.set_interval(60, self.action_refresh_data)

    def on_resize(self) -> None:
        """Handle terminal resize - force full repaint to prevent artifacts."""
        # Use Textual's built-in screen clearing instead of raw ANSI sequences
        # which bypass Textual's compositor and can cause artifacts
        self.screen.styles.background = self.screen.styles.background  # Force style recalc
        self.refresh(repaint=True, layout=True)

    def _bump_refresh_token(self) -> int:
        self._refresh_token += 1
        return self._refresh_token

    def _with_refresh_meta(self, data: dict, *, forced_refresh: bool, refreshed_at: datetime) -> dict:
        out = dict(data or {})
        meta = dict(out.get("meta") or {})
        meta["forced_refresh"] = bool(forced_refresh)
        meta["refreshed_at_ts"] = refreshed_at.timestamp()
        meta["refresh_token"] = self._bump_refresh_token()
        out["meta"] = meta
        return out
        
    def setup_data_dir(self):
        self.data_dir = os.path.expanduser("~/.mobileair")
        if not os.path.exists(self.data_dir):
            try:
                os.makedirs(self.data_dir)
            except Exception as e:
                self.notify(f"Failed to create data dir: {e}", severity="error")
                self.data_dir = "" # Fallback to CWD if fails

    def _parse_utc_timestamp(self, timestamp: str | None):
        return parse_utc_timestamp(timestamp)

    def _haversine_distance(self, lat1: float, lon1: float, lat2: float, lon2: float) -> float:
        return haversine_distance(lat1, lon1, lat2, lon2)

    def _bounding_box_distance(self, coords: list[tuple[float, float, datetime | None]]) -> float:
        return bounding_box_distance(coords)

    def _dim_color(self, color: str | None) -> str:
        base = color or "#888888"
        if isinstance(base, str) and base.strip().startswith("dim"):
            return base
        return f"dim {base}"

    def _value_to_aqi(self, pollutant_key: str, value: float | str | None):
        return value_to_aqi(pollutant_key, value)

    def _aqi_level(self, aqi: float | None):
        return aqi_level(aqi)

    def _color_for_value(self, pollutant_key: str, value: float | str | None) -> str:
        return color_for_value(pollutant_key, value)

    def _trend_threshold(self, pollutant_key: str) -> float:
        return trend_threshold(pollutant_key)

    def _extract_numeric_history(self, history) -> list[float]:
        from mobileair import extract_numeric_history
        return extract_numeric_history(history)

    def _compute_trend_indicator(self, pollutant_key: str, unit: str, history, current_value):
        return compute_trend_indicator(pollutant_key, unit, history, current_value)

    def _evaluate_mobility(self, sensor_blob: dict) -> dict:
        return evaluate_mobility(sensor_blob)

    def get_file_path(self, filename):
        if getattr(self, 'data_dir', None):
            return os.path.join(self.data_dir, filename)
        return filename

    def load_custom_names(self):
        try:
            path = self.get_file_path("sensor_names.json")
            if os.path.exists(path):
                with open(path, "r") as f:
                    self.custom_names = json.load(f)
        except Exception as e:
            self.notify(f"Failed to load names: {e}", severity="error")

    def save_custom_names(self):
        try:
            path = self.get_file_path("sensor_names.json")
            with open(path, "w") as f:
                json.dump(self.custom_names, f)
        except Exception as e:
            self.notify(f"Failed to save names: {e}", severity="error")

    def load_fixed_history(self):
        try:
            path = self.get_file_path("fixed_history.json")
            if os.path.exists(path):
                with open(path, "r") as f:
                    self.fixed_history = json.load(f)
        except Exception as e:
            self.notify(f"Failed to load history: {e}", severity="error")

    def save_fixed_history(self):
        try:
            path = self.get_file_path("fixed_history.json")
            with open(path, "w") as f:
                json.dump(self.fixed_history, f)
        except Exception as e:
            self.notify(f"Failed to save history: {e}", severity="error")

    def load_pinned_sensors(self):
        try:
            path = self.get_file_path("pinned_sensors.json")
            if os.path.exists(path):
                with open(path, "r") as f:
                    self.pinned_sensors = set(json.load(f))
        except Exception as e:
            self.notify(f"Failed to load pinned sensors: {e}", severity="error")

    def save_pinned_sensors(self):
        try:
            path = self.get_file_path("pinned_sensors.json")
            with open(path, "w") as f:
                json.dump(list(self.pinned_sensors), f)
        except Exception as e:
            self.notify(f"Failed to save pinned sensors: {e}", severity="error")

    def action_toggle_pin(self):
        list_view = self.query_one(ListView)
        if list_view.index is not None:
            item = list_view.children[list_view.index]
            if isinstance(item, SensorItem):
                s_name = item.sensor_name
                if s_name in self.pinned_sensors:
                    self.pinned_sensors.remove(s_name)
                    self.notify(f"Unpinned {s_name}")
                else:
                    self.pinned_sensors.add(s_name)
                    self.notify(f"Pinned {s_name}")
                self.save_pinned_sensors()
                self.update_list(self.current_data)
            
    def action_rename_sensor(self):
        list_view = self.query_one(ListView)
        if list_view.index is not None:
            item = list_view.children[list_view.index]
            if isinstance(item, SensorItem):
                s_name = item.sensor_name
                current = self.custom_names.get(s_name, "")
                
                def set_name(name: str | None) -> None:
                    if name is not None:
                        if name.strip():
                            self.custom_names[s_name] = name.strip()
                        elif s_name in self.custom_names:
                            del self.custom_names[s_name]
                        
                        self.save_custom_names()
                        self.update_list(self.current_data)
                        
                self.push_screen(NameInputScreen(s_name, current), set_name)

    def fetch_data(self, url):
        # Put caches in the same directory as the app's other state (~/.mobileair by default)
        data_dir = getattr(self, "data_dir", "") or os.getcwd()
        cache_path = default_cache_path(url, mobile_url=MOBILE_URL, fixed_url=FIXED_URL, data_dir=data_dir)

        def notify(msg: str, severity: str) -> None:
            sev: Literal["information", "warning", "error"]
            if severity == "error":
                sev = "error"
            elif severity == "warning":
                sev = "warning"
            else:
                sev = "information"
            self.notify(msg, severity=sev)

        return fetch_json_with_cache(
            url,
            headers=HEADERS,
            timeout=10,
            cache_path=cache_path,
            request_get=stdlib_get,
            notify=notify,
        )

    @work(thread=True)
    def action_refresh_data(self) -> None:
        self._refresh_data_common(forced_refresh=False)

    @work(thread=True)
    def action_force_refresh_data(self) -> None:
        self._request_web_force_refresh()
        self._refresh_data_common(forced_refresh=True)

    def _refresh_data_common(self, *, forced_refresh: bool) -> None:
        now = datetime.now()
        self.call_from_thread(self.update_status, f"Fetching data at {now.strftime('%H:%M:%S')}...")

        dashboard_fixed = []  # Enriched fixed sensors from /api/state (AirNow, Home, etc.)
        if _REMOTE_CONFIG["url"]:
            # Remote mode: fetch from server's /api/raw endpoint
            try:
                resp = stdlib_get(f"{_REMOTE_CONFIG['url']}/api/raw", timeout=10)
                if resp.status_code == 200:
                    raw = resp.json()
                    mobile_data = raw.get("mobile", {})
                    fixed_data = raw.get("fixed", {})
                else:
                    mobile_data = None
                    fixed_data = None
            except Exception:
                mobile_data = None
                fixed_data = None
            # Fetch enriched fixed sensors (AirNow, Home) from lightweight /api/fixed
            # Falls back to /api/state if the server hasn't been updated yet
            try:
                resp2 = stdlib_get(f"{_REMOTE_CONFIG['url']}/api/fixed", timeout=10)
                if resp2.status_code == 200:
                    dashboard_fixed = resp2.json()
                    if not isinstance(dashboard_fixed, list):
                        dashboard_fixed = []
            except Exception:
                # /api/fixed not available (404 or network error) — fall back to /api/state
                try:
                    resp2 = stdlib_get(f"{_REMOTE_CONFIG['url']}/api/state", timeout=15)
                    if resp2.status_code == 200:
                        state = resp2.json()
                        dashboard_fixed = state.get("fixed", [])
                except Exception:
                    pass
        else:
            mobile_data = self.fetch_data(MOBILE_URL)
            fixed_data = self.fetch_data(FIXED_URL)

        # Also fetch wind data
        self.fetch_wind_data()

        # Always drive the same "data refreshed" UI update routine.
        # If we couldn't fetch anything, reuse the existing state (don't mutate history).
        fetched_any = mobile_data is not None or fixed_data is not None
        if fetched_any:
            combined_data = {
                "mobile": mobile_data or {},
                "fixed": fixed_data or {},
                "dashboard_fixed": dashboard_fixed,
            }
            update_history = True
            status_msg = f"Last updated: {now.strftime('%Y-%m-%d %H:%M:%S')}"
        else:
            combined_data = self.current_data or {"mobile": {}, "fixed": {}}
            update_history = True if forced_refresh else False
            status_msg = f"Refreshed (no new fetch): {now.strftime('%Y-%m-%d %H:%M:%S')}"

        combined_data = self._with_refresh_meta(
            combined_data,
            forced_refresh=forced_refresh,
            refreshed_at=now,
        )

        if forced_refresh:
            status_msg = f"Forced refresh: {status_msg}"

        self.call_from_thread(self.update_data_state, combined_data, update_history=update_history)
        self.call_from_thread(self.update_status, status_msg)
        self.call_from_thread(self.update_last_updated, now.strftime('%H:%M:%S'))

    def fetch_wind_data(self) -> None:
        """Fetch wind data from dashboard server or directly from AirNow."""
        wind_data = None
        
        # Try dashboard server first (faster, already cached)
        if _REMOTE_CONFIG["url"]:
            server_url = f"{_REMOTE_CONFIG['url']}/api/state"
        else:
            port = int(os.environ.get("MOBILEAIR_DASHBOARD_PORT", "8766"))
            server_url = f"http://127.0.0.1:{port}/api/state"
        try:
            resp = stdlib_get(server_url, timeout=2)
            if resp.status_code == 200:
                state = resp.json()
                wind_data = state.get("wind", {})
        except Exception:
            pass
        
        # Fall back to direct AirNow fetch
        if not wind_data or wind_data.get("wind_speed") is None:
            try:
                from airnow_slc import fetch_hourly_data, filter_slc_hourly, get_hourly_data_url, extract_wind_data, fetch_monitoring_sites, filter_slc_area, get_slc_site_ids
                url = get_hourly_data_url()
                readings = fetch_hourly_data(url)
                # Filter to SLC area only, not all of Utah
                try:
                    sites = fetch_monitoring_sites()
                    slc_site_ids = get_slc_site_ids(sites)
                    slc_readings = filter_slc_hourly(readings, slc_site_ids)
                except Exception:
                    # Fall back to Utah filter if site fetch fails
                    from airnow_slc import filter_utah_hourly
                    slc_readings = filter_utah_hourly(readings)
                wind_data = extract_wind_data(slc_readings)
            except Exception:
                pass
        
        if wind_data:
            self.call_from_thread(self.update_wind_indicator, wind_data)
    
    def update_wind_indicator(self, wind_data: dict) -> None:
        """Store wind data and update the weather widget."""
        self._wind_data = wind_data
        try:
            self.query_one("#wind_indicator", Static).update(self._format_weather_widget())
        except Exception:
            pass
    
    def _format_weather_widget(self) -> Panel:
        """Create a weather widget using Rich Panel."""
        wind_data = getattr(self, '_wind_data', None)
        if not wind_data or wind_data.get("wind_speed") is None:
            return Panel("No data", title="WEATHER", width=21, height=6)
        
        speed_mph = wind_data.get("wind_speed_mph", 0) or 0
        direction = wind_data.get("wind_dir", 0) or 0
        cardinal = wind_data.get("wind_dir_cardinal", "?")
        gust_level = wind_data.get("gust_level", 0)
        temp_f = wind_data.get("temp_f")
        humidity = wind_data.get("humidity")
        
        # 8 cardinal directions - cardinal text provides the precision
        arrows_8 = ["↓", "↙", "←", "↖", "↑", "↗", "→", "↘"]  # N, NE, E, SE, S, SW, W, NW
        idx8 = round(direction / 45) % 8
        arrow = arrows_8[idx8]
        
        gust_blocks = ["▁", "▂", "▃", "▅", "▇"]
        gust_bar = "".join(gust_blocks[:gust_level + 1])
        gust_labels = ["Calm", "Light", "Moderate", "Strong", "Gale!"]
        gust_label = gust_labels[min(gust_level, 4)]
        
        gust_colors = ["#b8bb26", "#b8bb26", "#fabd2f", "#fe8019", "#fb4934"]
        gust_color = gust_colors[min(gust_level, 4)]
        
        content = Text()
        content.append(f"{arrow} ", style="bold #83a598")
        content.append(f"{cardinal:>3} ", style="#ebdbb2")
        content.append(f"{speed_mph:.1f}", style=gust_color)
        content.append(" mph\n")
        content.append(gust_bar, style=gust_color)
        content.append(f" {gust_label}\n")
        if temp_f is not None:
            content.append("T: ", style="#928374")
            content.append(f"{temp_f:.0f}°F", style="#ebdbb2")
            if humidity is not None:
                content.append(" RH: ", style="#928374")
                content.append(f"{humidity:.0f}%", style="#83a598")
        
        return Panel(content, title="WEATHER", width=21, height=6)

    def _get_latest_value(self, s_data: dict) -> float | None:
        """Extract the latest numeric value from sensor data (handles array or scalar)."""
        val = s_data.get('Value')
        if val is None:
            return None
        result = None
        # API returns Value as array of strings
        if isinstance(val, list) and len(val) > 0:
            try:
                result = float(val[-1])  # Latest value
            except (ValueError, TypeError):
                return None
        # Single value case
        elif isinstance(val, (int, float)):
            result = float(val)
        elif isinstance(val, str):
            try:
                result = float(val)
            except (ValueError, TypeError):
                return None
        # Filter outliers - PM2.5 > 500 µg/m³ or negative values are likely bad data
        if result is not None and (result < 0 or result > 500):
            return None
        return result

    def _format_summary_widget(self) -> Panel:
        """Create summary stats widget."""
        data = self.current_data
        if not data:
            return Panel("No data", title="SUMMARY", width=21, height=6)
        
        mobile_data = data.get("mobile", {})
        fixed_data = data.get("fixed", {})
        
        # Count sensors
        mobile_sensors = set()
        fixed_sensors = set()
        # Collect readings by pollutant: {pollutant: [(aqi, val, sensor), ...]}
        # Store both AQI (for sorting/coloring) and raw value (for display)
        readings_by_pollutant: dict[str, list[tuple[float, float, str]]] = {"PM25": [], "PM10": [], "OZNE": []}
        
        # Map API pollutant names to our AQI names
        poll_map = {"PM25": "PM2_5", "PM10": "PM10", "OZNE": "O3"}
        
        for p_key, details in mobile_data.items():
            if not isinstance(details, dict):
                continue
            aqi_key = poll_map.get(p_key, p_key)
            for s_key, s_data in details.items():
                if s_key in ['LastUpdateUTC', 'LastUpdateLocal', 'VarName', 'VarUnit']:
                    continue
                if isinstance(s_data, dict) and 'Value' in s_data:
                    mobile_sensors.add(s_key)
                    val = self._get_latest_value(s_data)
                    if val is not None:
                        aqi = self._value_to_aqi(aqi_key, val)
                        if aqi is not None and p_key in readings_by_pollutant:
                            readings_by_pollutant[p_key].append((aqi, val, s_key))
        
        for p_key, details in fixed_data.items():
            if not isinstance(details, dict):
                continue
            aqi_key = poll_map.get(p_key, p_key)
            for s_key, s_data in details.items():
                if s_key in ['LastUpdateUTC', 'LastUpdateLocal', 'VarName', 'VarUnit']:
                    continue
                if isinstance(s_data, dict) and 'Value' in s_data:
                    # Filter fixed sensors for SLC area only (same as sensor list)
                    # Approx Salt Lake Valley: Lat 40.4 to 41.0, Lon -112.25 to -111.7
                    try:
                        lat = s_data.get('Latitude') or s_data.get('GLAT')
                        lon = s_data.get('Longitude') or s_data.get('GLON')
                        if lat is None or lon is None:
                            continue
                        flat = float(lat[-1]) if isinstance(lat, list) else float(lat)
                        flon = float(lon[-1]) if isinstance(lon, list) else float(lon)
                        if not (40.4 <= flat <= 41.0 and -112.25 <= flon <= -111.7):
                            continue
                    except (ValueError, TypeError, IndexError):
                        continue
                    
                    fixed_sensors.add(s_key)
                    val = self._get_latest_value(s_data)
                    if val is not None:
                        aqi = self._value_to_aqi(aqi_key, val)
                        if aqi is not None and p_key in readings_by_pollutant:
                            readings_by_pollutant[p_key].append((aqi, val, s_key))
        
        n_mobile = len(mobile_sensors)
        n_fixed = len(fixed_sensors)
        
        # Find the primary pollutant: whichever has the highest single AQI reading
        primary_pollutant = None
        max_aqi_overall = -1.0
        for p_key, readings in readings_by_pollutant.items():
            for aqi, val, _ in readings:
                if aqi > max_aqi_overall:
                    max_aqi_overall = aqi
                    primary_pollutant = p_key
        
        # Calculate stats using ONLY the primary pollutant's readings
        # Use raw values for display, AQI for coloring
        avg_val = 0.0
        max_val = 0.0
        avg_aqi = 0.0
        max_aqi = 0.0
        if primary_pollutant and readings_by_pollutant[primary_pollutant]:
            primary_readings = readings_by_pollutant[primary_pollutant]
            avg_val = sum(r[1] for r in primary_readings) / len(primary_readings)
            max_val = max(r[1] for r in primary_readings)
            avg_aqi = sum(r[0] for r in primary_readings) / len(primary_readings)
            max_aqi = max(r[0] for r in primary_readings)
        
        level_info = self._aqi_level(avg_aqi)
        level = level_info.get("label", "Good") if isinstance(level_info, dict) else str(level_info)
        level_colors = {"Good": "#b8bb26", "Moderate": "#fabd2f", "Sensitive Groups": "#fe8019", 
                        "Unhealthy": "#fb4934", "Very Unhealthy": "#d3869b", "Hazardous": "#cc241d"}
        avg_color = level_colors.get(level, "#928374")
        
        content = Text()
        content.append(f"{n_mobile}", style="#83a598")
        content.append(" mob ")
        content.append(f"{n_fixed}", style="#fabd2f")
        content.append(" fix\n")
        content.append("Avg: ")
        content.append(f"{avg_val:.0f}", style=avg_color)
        content.append(f" {primary_pollutant[:4]}\n" if primary_pollutant else "\n")
        if primary_pollutant and max_val > 0:
            max_info = self._aqi_level(max_aqi)
            max_level = max_info.get("label", "Good") if isinstance(max_info, dict) else str(max_info)
            max_color = level_colors.get(max_level, "#928374")
            content.append("Max: ")
            content.append(f"{max_val:.0f}", style=max_color)
            content.append(f" {primary_pollutant[:4]}")
        else:
            content.append("Max: -")
        
        return Panel(content, title="SUMMARY", width=17, height=6)

    # Track shown alerts to avoid spamming toasts
    _last_alert_keys: set = set()

    def _show_alert_toasts(self) -> None:
        """Show air quality alerts as toast notifications."""
        data = self.current_data
        if not data:
            return
        
        alerts = []  # (aqi, sensor, pollutant, level_label)
        
        mobile_data = data.get("mobile", {})
        fixed_data = data.get("fixed", {})
        
        poll_map = {"PM25": "PM2_5", "PM10": "PM10", "OZNE": "O3"}
        
        for source in [mobile_data, fixed_data]:
            for p_key, details in source.items():
                if not isinstance(details, dict):
                    continue
                aqi_key = poll_map.get(p_key, p_key)
                for s_key, s_data in details.items():
                    if s_key in ['LastUpdateUTC', 'LastUpdateLocal', 'VarName', 'VarUnit']:
                        continue
                    if isinstance(s_data, dict) and 'Value' in s_data:
                        val = self._get_latest_value(s_data)
                        if val is not None:
                            aqi = self._value_to_aqi(aqi_key, val)
                            # Alert if USG or worse (AQI > 100)
                            if aqi and aqi > 100:
                                level_info = self._aqi_level(aqi)
                                level = level_info.get("label", "Sensitive Groups") if isinstance(level_info, dict) else "Sensitive Groups"
                                name = self.custom_names.get(s_key, s_key)
                                alerts.append((aqi, name, p_key, level, s_key))
        
        # Only show new alerts (not already shown)
        current_keys = {f"{a[4]}:{a[2]}" for a in alerts}  # sensor:pollutant
        new_alerts = [a for a in alerts if f"{a[4]}:{a[2]}" not in self._last_alert_keys]
        self._last_alert_keys = current_keys
        
        # Show top 3 new alerts as toasts - timeout=0 means user must dismiss
        new_alerts.sort(key=lambda x: x[0], reverse=True)
        for aqi, name, poll, level, _ in new_alerts[:3]:
            severity: Literal["information", "warning", "error"] = "warning"
            if level in ("Unhealthy", "Very Unhealthy", "Hazardous"):
                severity = "error"
            self.notify(
                f"{name}: {poll} AQI {aqi:.0f} ({level})",
                title="⚠️ Air Quality Alert",
                severity=severity,
                timeout=0,  # Stay until dismissed (click or press any key)
            )

    def _format_sparkline_widget(self) -> Panel:
        """Create sparkline trend widget for PM2.5."""
        data = self.current_data
        if not data:
            return Panel("No data", title="PM2.5", width=21, height=6)
        
        # Collect recent PM2.5 values - API uses "PM25" key
        pm25_values = []
        mobile_data = data.get("mobile", {})
        
        pm25_data = mobile_data.get("PM25", {})  # API uses PM25, not PM2_5
        if isinstance(pm25_data, dict):
            for s_key, s_data in pm25_data.items():
                if s_key in ['LastUpdateUTC', 'LastUpdateLocal', 'VarName', 'VarUnit']:
                    continue
                if isinstance(s_data, dict) and 'Value' in s_data:
                    val = self._get_latest_value(s_data)
                    if val is not None:
                        pm25_values.append(val)
        
        if not pm25_values:
            return Panel("No data", title="PM2.5", width=21, height=6)
        
        # Create sparkline from current values across sensors
        blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]
        min_val = min(pm25_values)
        max_val = max(pm25_values)
        avg_val = sum(pm25_values) / len(pm25_values)
        
        # Normalize and create sparkline
        spark = ""
        if max_val > min_val:
            for v in pm25_values[:10]:  # Limit to 10 points
                idx = int((v - min_val) / (max_val - min_val) * 7)
                idx = max(0, min(7, idx))
                spark += blocks[idx]
        else:
            spark = blocks[4] * min(len(pm25_values), 10)
        
        # Color based on avg AQI
        avg_aqi = self._value_to_aqi("PM2_5", avg_val) or 0
        level_info = self._aqi_level(avg_aqi)
        level = level_info.get("label", "Good") if isinstance(level_info, dict) else "Good"
        level_colors = {"Good": "#b8bb26", "Moderate": "#fabd2f", "Sensitive Groups": "#fe8019", 
                        "Unhealthy": "#fb4934", "Very Unhealthy": "#d3869b", "Hazardous": "#cc241d"}
        spark_color = level_colors.get(level, "#83a598")
        
        content = Text()
        content.append(spark, style=spark_color)
        content.append("\n")
        content.append("Lo: ")
        content.append(f"{min_val:.0f}", style="#b8bb26")
        content.append(" Hi: ")
        # Color Hi based on its actual AQI level, not hardcoded red
        max_aqi = self._value_to_aqi("PM2_5", max_val) or 0
        max_level_info = self._aqi_level(max_aqi)
        max_level = max_level_info.get("label", "Good") if isinstance(max_level_info, dict) else "Good"
        max_color = level_colors.get(max_level, "#b8bb26")
        content.append(f"{max_val:.0f}", style=max_color)
        content.append("\n")
        content.append("Avg: ")
        content.append(f"{avg_val:.0f}", style=spark_color)
        
        return Panel(content, title="PM2.5", width=17, height=6)

    def _format_pm10_widget(self) -> Panel:
        """Create PM10 sparkline trend widget."""
        data = self.current_data
        if not data:
            return Panel("No data", title="PM10", width=17, height=6)
        
        # Collect recent PM10 values - API uses "PM10" key
        pm10_values = []
        mobile_data = data.get("mobile", {})
        
        pm10_data = mobile_data.get("PM10", {})
        if isinstance(pm10_data, dict):
            for s_key, s_data in pm10_data.items():
                if s_key in ['LastUpdateUTC', 'LastUpdateLocal', 'VarName', 'VarUnit']:
                    continue
                if isinstance(s_data, dict) and 'Value' in s_data:
                    val = self._get_latest_value(s_data)
                    if val is not None:
                        pm10_values.append(val)
        
        if not pm10_values:
            return Panel("No data", title="PM10", width=17, height=6)
        
        # Create sparkline from current values across sensors
        blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]
        min_val = min(pm10_values)
        max_val = max(pm10_values)
        avg_val = sum(pm10_values) / len(pm10_values)
        
        # Normalize and create sparkline
        spark = ""
        if max_val > min_val:
            for v in pm10_values[:10]:  # Limit to 10 points
                idx = int((v - min_val) / (max_val - min_val) * 7)
                idx = max(0, min(7, idx))
                spark += blocks[idx]
        else:
            spark = blocks[4] * min(len(pm10_values), 10)
        
        # Color based on avg AQI
        avg_aqi = self._value_to_aqi("PM10", avg_val) or 0
        level_info = self._aqi_level(avg_aqi)
        level = level_info.get("label", "Good") if isinstance(level_info, dict) else "Good"
        level_colors = {"Good": "#b8bb26", "Moderate": "#fabd2f", "Sensitive Groups": "#fe8019", 
                        "Unhealthy": "#fb4934", "Very Unhealthy": "#d3869b", "Hazardous": "#cc241d"}
        spark_color = level_colors.get(level, "#83a598")
        
        content = Text()
        content.append(spark, style=spark_color)
        content.append("\n")
        content.append("Lo: ")
        content.append(f"{min_val:.0f}", style="#b8bb26")
        content.append(" Hi: ")
        max_aqi = self._value_to_aqi("PM10", max_val) or 0
        max_level_info = self._aqi_level(max_aqi)
        max_level = max_level_info.get("label", "Good") if isinstance(max_level_info, dict) else "Good"
        max_color = level_colors.get(max_level, "#b8bb26")
        content.append(f"{max_val:.0f}", style=max_color)
        content.append("\n")
        content.append("Avg: ")
        content.append(f"{avg_val:.0f}", style=spark_color)
        
        return Panel(content, title="PM10", width=17, height=6)

    def _format_region_widget(self) -> Panel:
        """Create region/location info widget."""
        content = Text()
        content.append("Salt Lake Valley\n", style="bold #ebdbb2")
        content.append("40.76°N 111.89°W\n", style="#83a598")
        content.append("Elev: ")
        content.append("4,226", style="#fabd2f")
        content.append(" ft")
        
        return Panel(content, title="REGION", width=21, height=6)

    def update_widgets(self) -> None:
        """Update all dashboard widgets."""
        try:
            self.query_one("#summary_widget", Static).update(self._format_summary_widget())
        except Exception:
            pass
        try:
            self.query_one("#sparkline_widget", Static).update(self._format_sparkline_widget())
        except Exception:
            pass
        try:
            self.query_one("#pm10_widget", Static).update(self._format_pm10_widget())
        except Exception:
            pass
        try:
            self.query_one("#region_widget", Static).update(self._format_region_widget())
        except Exception:
            pass
        try:
            self.query_one("#wind_indicator", Static).update(self._format_weather_widget())
        except Exception:
            pass
        # Show air quality alerts as toast notifications
        self._show_alert_toasts()

    def update_status(self, message: str) -> None:
        """Update the footer status line."""
        try:
            self.query_one("#footer_status", Static).update(message)
        except Exception:
            pass

    def update_last_updated(self, time_str: str) -> None:
        self.last_updated = time_str
        
    def update_data_state(self, data, update_history: bool = False):
        self.current_data = data
        self.update_list(data, update_history)
        self.update_widgets()

        # Client-side contract: forced refresh must behave like a "new data" event.
        # In particular, it must not rely on selection-change events to refresh details.
        try:
            meta = data.get("meta") if isinstance(data, dict) else None
            forced = bool(meta.get("forced_refresh")) if isinstance(meta, dict) else False
        except Exception:
            forced = False

        if forced:
            try:
                list_view = self.query_one(ListView)
                if list_view.index is not None and list_view.index < len(list_view.children):
                    item = list_view.children[list_view.index]
                    if isinstance(item, SensorItem):
                        self.update_details_view(item)
            except Exception:
                pass

            try:
                self.refresh()
            except Exception:
                pass

    def _apply_ghost_classes(self, list_view: ListView):
        current_idx = list_view.index
        for idx, child in enumerate(list_view.children):
            if isinstance(child, SensorItem):
                child.set_class(child.is_ghost and idx != current_idx, "sensor-ghost")

    def update_list(self, data, update_history: bool = False):
        list_view = self.query_one(ListView)
        
        # Capture current selection and scroll position
        selected_sensor_name = None
        saved_scroll_y = list_view.scroll_y
        if list_view.index is not None and list_view.index < len(list_view.children):
            item = list_view.children[list_view.index]
            if isinstance(item, SensorItem):
                selected_sensor_name = item.sensor_name
        
        # Suppress Textual's internal scroll_to_widget during rebuild.
        # Setting list_view.index triggers watch_index which queues
        # call_after_refresh(scroll_to_widget, ...) that would yank the
        # scroll position to the top. By replacing the method with a no-op
        # before clear/rebuild, both the direct call and the queued
        # callback become harmless.
        _orig_scroll_to_widget = list_view.scroll_to_widget
        if selected_sensor_name is not None:
            list_view.scroll_to_widget = lambda *a, **k: True  # type: ignore[assignment]
        
        list_view.clear()

        # Combine and normalize data
        # Structure: { sensor_name: { type: 'mobile'|'fixed', readings: { pollutant: (val, col, lat, lon, p_unit, history) } } }
        unified_sensors = {}
        
        # Process Mobile Data
        mobile_data = data.get("mobile", {})
        for p_key, details in mobile_data.items():
            if not isinstance(details, dict): continue
            p_unit = details.get('VarUnit', '')
            for s_key, s_data in details.items():
                if s_key in ['LastUpdateUTC', 'LastUpdateLocal', 'VarName', 'VarUnit']: continue
                if isinstance(s_data, dict) and 'Value' in s_data:
                    if s_key not in unified_sensors:
                        unified_sensors[s_key] = {'type': 'mobile', 'readings': {}}
                    sensor_entry = unified_sensors[s_key]
                    if 'mobility' not in sensor_entry:
                        sensor_entry['mobility'] = self._evaluate_mobility(s_data)
                    
                    vals = s_data['Value']
                    cols = s_data.get('ValueColor', [])
                    lats = s_data.get('Latitude', [])
                    lons = s_data.get('Longitude', [])
                    
                    if isinstance(vals, list) and vals:
                        # Clean negative values in history
                        cleaned_vals = []
                        for v in vals:
                            try:
                                fv = float(v)
                                cleaned_vals.append(str(max(0.0, fv)))
                            except (ValueError, TypeError):
                                cleaned_vals.append(v)

                        val = cleaned_vals[-1]
                        # Calculate color based on AQI rather than using API color
                        col = color_for_value(p_key, val)
                        # Calculate history colors based on values too
                        hist_cols = [color_for_value(p_key, v) for v in cleaned_vals]
                            
                        lat = lats[-1] if isinstance(lats, list) and lats else None
                        lon = lons[-1] if isinstance(lons, list) and lons else None
                        
                        unified_sensors[s_key]['readings'][p_key] = (val, col, lat, lon, p_unit, cleaned_vals, hist_cols)

        # Process Fixed Data
        fixed_data = data.get("fixed", {})
        history_updated = False

        for p_key, details in fixed_data.items():
            if not isinstance(details, dict): continue
            p_unit = details.get('VarUnit', '')
            for s_key, s_data in details.items():
                if s_key in ['LastUpdateUTC', 'LastUpdateLocal', 'APITimeStart', 'APITimeEnd', 'VarName', 'VarUnit']: continue
                if isinstance(s_data, dict) and 'Value' in s_data:
                    val = s_data['Value']
                    lat = s_data.get('Latitude')
                    lon = s_data.get('Longitude')
                    time_utc = s_data.get('TimeUTC')
                    
                    # Floor negative values
                    try:
                        val_num = float(val)
                    except (ValueError, TypeError):
                        val_num = 0.0
                    
                    original_val_num = val_num # Keep original for outlier check
                    
                    if val_num < 0:
                        val_num = 0.0
                        val = "0.0"
                    
                    # Calculate color based on AQI rather than using API color
                    col = color_for_value(p_key, val)
                    
                    # Filter Fixed Sensors for SLC area only
                    # Approx Salt Lake Valley: Lat 40.4 to 41.0, Lon -112.25 to -111.7
                    try:
                        if lat is None or lon is None:
                            continue
                        flat = float(lat)
                        flon = float(lon)
                        if not (40.4 <= flat <= 41.0 and -112.25 <= flon <= -111.7):
                            continue
                    except (ValueError, TypeError):
                        continue

                    if s_key not in unified_sensors:
                        unified_sensors[s_key] = {'type': 'fixed', 'readings': {}}
                    
                    # Update History
                    if s_key not in self.fixed_history:
                        self.fixed_history[s_key] = {}
                    if p_key not in self.fixed_history[s_key]:
                        self.fixed_history[s_key][p_key] = []
                    
                    hist_list = self.fixed_history[s_key][p_key]
                    
                    # Append to history only when the API timestamp advances
                    # (the fixed API returns the same value/timestamp on every poll until it updates)
                    if update_history:
                        now_ts = datetime.now().timestamp()
                        
                        # Deduplicate: skip if the API timestamp hasn't changed
                        last_api_time = hist_list[-1].get('time') if hist_list else None
                        if time_utc is not None and time_utc == last_api_time:
                            pass  # same reading, don't append
                        else:
                            # Only insert gap Nones when we know we actually missed
                            # readings (i.e. the API timestamp advanced by more than
                            # one interval).  Never gap-fill on startup/restart
                            # where recorded_at is stale — that floods history with
                            # Nones and kills sparklines.
                            if hist_list and last_api_time is not None and time_utc is not None:
                                try:
                                    from mobileair_core import parse_utc_timestamp as _parse_ts
                                    prev_dt = _parse_ts(last_api_time)
                                    curr_dt = _parse_ts(time_utc)
                                    if prev_dt and curr_dt:
                                        api_gap_s = (curr_dt - prev_dt).total_seconds()
                                        # Fixed sensors update roughly every 3600s;
                                        # insert Nones only for genuinely skipped intervals
                                        if api_gap_s > 5400:  # > 1.5 hours
                                            num_missing = min(int(api_gap_s / 3600) - 1, 5)
                                            for _ in range(num_missing):
                                                hist_list.append({'val': None, 'col': '#000000', 'time': None, 'recorded_at': now_ts})
                                except Exception:
                                    pass

                            # Ensure val is string format for consistency
                            hist_list.append({'val': str(val), 'col': col, 'time': time_utc, 'recorded_at': now_ts})
                            # Keep last 50
                            if len(hist_list) > 50:
                                self.fixed_history[s_key][p_key] = hist_list[-50:]
                            history_updated = True
                        
                    current_history = [x['val'] for x in self.fixed_history[s_key][p_key]]
                    # Recalculate history colors based on values for consistency
                    current_history_cols = [color_for_value(p_key, x['val']) for x in self.fixed_history[s_key][p_key]]
                    
                    unified_sensors[s_key]['readings'][p_key] = (val, col, lat, lon, p_unit, current_history, current_history_cols)
        
        if history_updated:
            self.save_fixed_history()

        # ── Merge enriched fixed sensors from dashboard server (AirNow, Home, etc.) ──
        # These are NOT in the raw Utah AQ data but the dashboard server provides them.
        # For sensors already in unified_sensors from raw data, merge in the server's
        # richer history (which has hourly AirNow data) when the local history is thin.
        # Skip known weather/meteorological params — everything else passes through
        _WEATHER_KEYS = {"BARPR", "DEWPOINT", "TEMP", "WD", "WS", "RHUM", "SOLAR", "PRECIP", "CEIL", "VSBY", "BC_LC", "BC_DC"}
        dashboard_fixed = data.get("dashboard_fixed", [])
        for df in dashboard_fixed:
            if not isinstance(df, dict):
                continue
            s_key = df.get("id", "")
            if not s_key:
                continue
            # Skip PurpleAir sensors — not wanted in TUI
            if s_key.startswith("PA_"):
                continue
            # Only include SLC-area sensors
            try:
                flat = float(df.get("lat", 0))
                flon = float(df.get("lon", 0))
                if not (40.4 <= flat <= 41.1 and -112.25 <= flon <= -111.7):
                    continue
            except (ValueError, TypeError):
                continue
            readings = df.get("readings", {})
            if not readings:
                continue

            # If sensor already exists from raw data, merge server history into
            # existing readings when the server has more history points.
            if s_key in unified_sensors:
                existing = unified_sensors[s_key]
                for p_key, r_data in readings.items():
                    if p_key in _WEATHER_KEYS:
                        continue
                    if not isinstance(r_data, dict):
                        continue
                    server_hist = r_data.get("history", [])
                    if not server_hist:
                        continue
                    if p_key in existing['readings']:
                        # readings tuple: (val, col, lat, lon, unit, history, history_cols)
                        cur = existing['readings'][p_key]
                        local_hist = cur[5] if len(cur) > 5 else []
                        if len(server_hist) > len(local_hist):
                            hist_strs = [str(v) if v is not None else None for v in server_hist]
                            hist_cols = [color_for_value(p_key, str(v)) if v is not None else '#000000' for v in server_hist]
                            existing['readings'][p_key] = (cur[0], cur[1], cur[2], cur[3], cur[4], hist_strs, hist_cols)
                continue

            sensor_entry = {'type': 'fixed', 'readings': {}}
            display_name = df.get("name", "")
            if display_name and display_name != s_key:
                sensor_entry['display_name'] = display_name
            for p_key, r_data in readings.items():
                # Skip known weather/met params
                if p_key in _WEATHER_KEYS:
                    continue
                if not isinstance(r_data, dict):
                    continue
                val = r_data.get("value")
                if val is None:
                    continue
                val_str = str(val)
                col = color_for_value(p_key, val_str)
                history = r_data.get("history", [])
                history_strs = [str(v) if v is not None else None for v in history]
                history_cols = [color_for_value(p_key, str(v)) if v is not None else '#000000' for v in history]
                unit = r_data.get("unit", "")
                sensor_entry['readings'][p_key] = (val_str, col, str(flat), str(flon), unit, history_strs, history_cols)
            if sensor_entry['readings']:
                unified_sensors[s_key] = sensor_entry

        # Sort Logic
        # Desired order: PM2.5, PM10, Ozone
        priority_map = {"pm2.5": 0, "pm25": 0, "pm10": 1, "ozone": 2, "ozne": 2}
        
        def get_sensor_score(item):
            s_name, data = item
            
            # Determine status for sorting priorities
            is_mobile = data.get('type') == 'mobile'
            mobility_info = data.get('mobility', {})
            is_immobile = bool(mobility_info.get('immobile'))
            is_forced_active = s_name in self.forced_active_sensors
            
            # Idle/Ghost mobile sensors
            is_idle = is_mobile and is_immobile and not is_forced_active
            is_pinned = s_name in self.pinned_sensors

            # Priority Tiers (lower = listed first):
            # 0. Pinned Sensors
            # 1. Active Mobile Sensors
            # 2. Fixed Sensors
            # 3. Idle/Ghost Mobile Sensors
            
            if is_pinned:
                tier = 0
            elif is_idle:
                tier = 3
            elif is_mobile:
                tier = 1
            else:
                tier = 2

            # Within each tier, sort alphabetically by display name
            display_name = self.custom_names.get(s_name, "") or data.get('display_name', "") or s_name
            return (tier, display_name.lower())

        # Filter fixed-site spatial outliers using neighbor-consensus (not absolute thresholds).
        # Example: a single station reporting PM25 900+ while nearby stations remain normal.
        fixed_candidates = []
        for s_name, s_info in unified_sensors.items():
            if s_info.get('type') != 'fixed':
                continue
            readings = s_info.get('readings') or {}
            # Prefer PM25 / PM2.5 if present.
            v = None
            lat = None
            lon = None
            if 'PM25' in readings:
                v, _, lat, lon, *_ = readings['PM25']
            elif 'PM2.5' in readings:
                v, _, lat, lon, *_ = readings['PM2.5']
            else:
                continue
            try:
                lat_f = float(lat)
                lon_f = float(lon)
                v_f = float(v)
            except (ValueError, TypeError):
                continue
            fixed_candidates.append({'id': s_name, 'lat': lat_f, 'lon': lon_f, 'readings': {'PM25': {'value': v_f}}})

        fixed_outliers = detect_spatial_outliers(fixed_candidates, pollutant_keys=("PM25", "PM2.5"))

        filtered_sensors = []
        for s_name, s_info in unified_sensors.items():
            readings = s_info.get('readings') or {}
            # Hide spatial outliers for fixed sensors.
            if s_info.get('type') == 'fixed' and s_name in fixed_outliers:
                continue

            # Keep the legacy safety check for lone "bad" readings (non-spatial):
            # if a sensor has only one pollutant and it's <= 0 after flooring, hide it.
            is_bad_lone = False
            if len(readings) == 1:
                try:
                    only_val = float(next(iter(readings.values()))[0])
                    if only_val <= 0.0:
                        is_bad_lone = True
                except Exception:
                    pass
            if is_bad_lone:
                continue

            filtered_sensors.append((s_name, s_info))

        sorted_sensors = sorted(filtered_sensors, key=get_sensor_score)

        # Track the max readings count across all sensors for stable details panel height
        max_r = max((len(s_info.get('readings', {})) for _, s_info in sorted_sensors), default=3)
        self._max_readings_count = max(max_r, 3)

        # Build List Items
        for s_name, s_info in sorted_sensors:
            readings_list = []
            coords = None
            mobility_info = s_info.get('mobility', {})
            is_mobile = s_info.get('type') == 'mobile'
            is_pinned = s_name in self.pinned_sensors
            
            # Determine stale state: Mobile + Immobile + Not Forced Active
            is_stale = (is_mobile and 
                       bool(mobility_info.get('immobile')) and 
                       s_name not in self.forced_active_sensors)
            
            # Sort readings for this sensor based on priority
            def reading_sort_key(k):
                lower = k.lower()
                return priority_map.get(lower, 100) # Default high index
            
            sorted_reading_keys = sorted(s_info['readings'].keys(), key=reading_sort_key)
            
            for p_key in sorted_reading_keys:
                val, col, lat, lon, unit, history, history_cols = s_info['readings'][p_key]
                
                # Map display keys
                display_key = p_key
                if p_key == "PM2.5": display_key = "PM25"
                elif p_key == "Ozone": display_key = "OZNE"

                display_color = self._dim_color(col) if is_stale else col
                history_colors = list(history_cols) if isinstance(history_cols, list) else history_cols
                if is_stale and isinstance(history_colors, list):
                    history_colors = [self._dim_color(c) for c in history_colors]

                trend_info = self._compute_trend_indicator(p_key, unit or "", history, val)
                if trend_info:
                    trend_info = trend_info.copy()
                    trend_info["color"] = col
                    if is_stale:
                        trend_info["color"] = "#666666"

                readings_list.append((display_key, val, display_color, history, history_colors, trend_info))
                
                # Capture coordinates (prefer latest valid ones)
                if lat is not None and lon is not None:
                    try:
                        coords = (float(lat), float(lon))
                    except (TypeError, ValueError):
                        pass
            
            if readings_list:
                c_name = self.custom_names.get(s_name, "") or s_info.get('display_name', "")
                list_view.append(
                    SensorItem(
                        s_name,
                        readings_list,
                        coords,
                        is_fixed=(s_info['type']=='fixed'),
                        custom_name=c_name,
                        mobility_info=mobility_info if is_mobile else {},
                        ghosted=is_stale,
                        pinned=is_pinned
                    )
                )
        
        # Restore selection or auto-select active
        new_index = None
        
        # 1. Try to find previously selected sensor
        if selected_sensor_name:
            for i, child in enumerate(list_view.children):
                if isinstance(child, SensorItem) and child.sensor_name == selected_sensor_name:
                    new_index = i
                    break
        
        # 2. If no selection found (or first launch), select first active (non-ghost) sensor
        if new_index is None:
            for i, child in enumerate(list_view.children):
                if isinstance(child, SensorItem) and not child.is_ghost:
                    new_index = i
                    break
            # Fallback to first item if no active sensors
            if new_index is None and len(list_view.children) > 0:
                new_index = 0
                
        if new_index is not None:
            list_view.index = new_index
            
        # Restore scroll_to_widget and scroll position
        list_view.scroll_to_widget = _orig_scroll_to_widget
        if selected_sensor_name is not None:
            # Restore scroll position after layout so virtual size is valid
            _sy = saved_scroll_y
            def _restore_scroll():
                try:
                    list_view.scroll_y = _sy
                except Exception:
                    pass
            self.call_after_refresh(_restore_scroll)
            
        # Ensure list has focus on first load (when we auto-selected)
        if selected_sensor_name is None:
            list_view.focus()

        self._apply_ghost_classes(list_view)

    def _truncate_raw_data(self, data):
        """
        Recursively traverse JSON data and truncate long lists for display.
        """
        if isinstance(data, dict):
            return {k: self._truncate_raw_data(v) for k, v in data.items()}
        elif isinstance(data, list):
            if len(data) > 10:
                # If it's a list of primitives (numbers/strings), summary is better
                first_type = type(data[0]) if data else None
                
                # Special handling for obvious parallel arrays
                if all(isinstance(x, (int, float, str)) or x is None for x in data[:10]):
                    return [
                        *data[:3], 
                        f"... <{len(data)-6} items truncated> ...", 
                        *data[-3:]
                    ]
                else:
                    return [
                        self._truncate_raw_data(x) for x in data[:3]
                    ] + [f"... <{len(data)-6} items truncated> ..."] + [
                        self._truncate_raw_data(x) for x in data[-3:]
                    ]
            return [self._truncate_raw_data(x) for x in data]
        else:
            return data

    def update_details_view(self, item: SensorItem):
        details_view = self.query_one("#details_view", Static)
        
        # Location Info
        location_text = Text(style="#ebdbb2")
        if item.coords:
            lat, lon = item.coords
            location_text.append("Location: ", style="#ebdbb2")
            location_text.append(f"{lat}, {lon}\n", style="#ebdbb2")
        else:
            location_text.append("Location unknown", style="dim")
            
        display_name = item.sensor_name
        if item.custom_name:
            display_name = f"{item.sensor_name} ({item.custom_name})"

        # Readings Table
        table = Table(expand=True, box=None, show_header=True)
        table.header_style = "#ebdbb2 bold"
        table.add_column("Pollutant", ratio=1)
        table.add_column("Value", justify="right", ratio=1)
        table.add_column("Level", ratio=2)
        table.add_column("History", ratio=2) # New column

        for row_data in item.sensor_readings:
            if len(row_data) >= 3:
                key = row_data[0]
                val = row_data[1]
                col = row_data[2]
                history = row_data[3] if len(row_data) > 3 else []
                history_cols = row_data[4] if len(row_data) > 4 else []
                trend_info = row_data[5] if len(row_data) > 5 else None
            else:
                continue

            # Level bar = severity by AQI (harm), using the shared core logic.
            # This keeps the TUI + dashboard consistent with aqi_breakpoints.csv and
            # handles ozone unit normalization/truncation.
            aqi_val = self._value_to_aqi(key, val)
            try:
                num_val = float(val)
            except Exception:
                num_val = 0.0

            try:
                # User intent: "A moderate reading is not 50%... it's much less"
                # Scaling to AQI 300 (Very Unhealthy top) makes Moderate (50-100) occupy roughly the 16%-33% range.
                # Unhealthy (150+) starts at 50% bar width.
                ratio = min((float(aqi_val) if aqi_val is not None else 0.0) / 300.0, 1.0)
                bar_len = int(ratio * 20)
                filled_bar = "█" * bar_len
                empty_bar = "░" * (20 - bar_len)

                # Keep a tiny visible stub for non-zero readings (like ▌).
                if (aqi_val is not None and aqi_val > 0) and bar_len == 0:
                    filled_bar = "▌"
                    empty_bar = "░" * 19

                bar = f"[{col}]{filled_bar}[/][dim]{empty_bar}[/]"
            except Exception:
                bar = "░" * 20
            
            # Generate Sparkline using explicit API colors
            spark = ""
            if history:
                try:
                    nums = [float(v) for v in history if v is not None]
                    if nums:
                        # Use Unicode block elements from 1/8 to 8/8 (U+2581 to U+2588)
                        blocks = "".join([chr(i) for i in range(9601, 9609)])

                        recent_nums = []
                        # Extract last 15 from history, handling Nones
                        raw_history = history[-15:]
                        raw_cols = history_cols[-15:] if history_cols else []
                        
                        for i in range(len(raw_history)):
                            v = raw_history[i]
                            if v is None:
                                recent_nums.append(None)
                            else:
                                try:
                                    recent_nums.append(float(v))
                                except:
                                    recent_nums.append(0.0) # Fallback
                        
                        recent_cols = raw_cols
                        
                        # Align lengths if mismatch (should match unless old data)
                        if len(recent_cols) < len(recent_nums):
                            recent_cols = ["#ffffff"] * (len(recent_nums) - len(recent_cols)) + recent_cols

                        # Sparkline scaling:
                        # - Default is anchored to 0 to avoid misleading "crashes".
                        # - If the recent series lives in a tight band near the max (looks flat due to 8-level quantization),
                        #   auto-zoom to recent min..max so small variations are still visible.
                        finite_recent = [n for n in recent_nums if isinstance(n, (int, float))]
                        max_v = max(finite_recent) if finite_recent else 0.0
                        min_recent = min(finite_recent) if finite_recent else 0.0

                        min_v = 0.0
                        if max_v <= 0:
                            max_v = 1.0
                        rng = max_v - min_v

                        recent_range = max_v - min_recent
                        if max_v > 0 and min_recent > 0 and recent_range > 0:
                            # Zoom only when variation is small relative to max and values are not near zero.
                            if (recent_range / max_v) < 0.35 and (min_recent / max_v) > 0.6:
                                # Add a little padding below the observed minimum so bottom-end variation
                                # doesn't collapse into a flat row of the lowest block due to quantization.
                                pad = max(recent_range * 0.15, max_v * 0.02)
                                min_v = max(0.0, min_recent - pad)
                                rng = max_v - min_v
                        if rng <= 0:
                            rng = 1.0
                            
                        for i, n in enumerate(recent_nums):
                            if n is None:
                                spark += " " # Empty space for missing data
                                continue
                                
                            # Scale height relative to 0..max
                            # Use rounding instead of floor to better match pixel-based rendering in the web UI.
                            idx = int(round((n - min_v) / rng * 7))
                            idx = min(max(idx, 0), 7)
                            
                            # Use provided color
                            bar_col = recent_cols[i] if i < len(recent_cols) else "#ffffff"
                            spark += f"[{bar_col}]{blocks[idx]}[/]"
                except:
                    pass

            value_text = Text(str(val), style=col)
            if trend_info and trend_info.get("symbol"):
                value_text.append(" ")
                value_text.append(trend_info["symbol"], style=trend_info.get("color", col))

            table.add_row(
                Text(key, style="#fabd2f bold"),
                value_text,
                Text.from_markup(bar), 
                Text.from_markup(spark)
            )

        # Pad table to the max observed reading count for consistent height
        rows_added = len(item.sensor_readings)
        pad_to = max(self._max_readings_count, 3)
        for _ in range(pad_to - rows_added):
            table.add_row("", "", "", "")

        sensor_type_label = "(Fixed Station)" if item.is_fixed else "(Mobile Sensor)"
        
        # Align location text with the second column (Value)
        # Main table cols: Ratio 1, 1, 2, 2.
        # Pollutant col is 1/6 (~16.7%). Value col is 1/6.
        # We want to indent to roughly the middle of the Value column (~25% of width).
        loc_table = Table(expand=True, box=None, show_header=False)
        loc_table.add_column(ratio=1)
        loc_table.add_column(ratio=3)
        loc_table.add_row("", location_text)

        content = [
            Align.center(Text(f"{display_name} {sensor_type_label}", style="bold underline #ebdbb2")),
            Text(""),
            loc_table,
        ]
        content.append(table)

        panel = Panel(
            Group(*content),
            title=Text("Sensor Details", style="#d3869b bold"),
            border_style="#d3869b",
            style="#ebdbb2 on #1d2021",
            padding=(0, 1),
        )
        
        details_view.update(panel)
        
        # Update JSON view - use shared format matching web TUI
        json_view = self.query_one("#json_view", Static)
        
        # Use shared format_json_view function for consistency with web TUI
        readings_dict = item._to_readings_dict()
        view = format_json_view(
            sensor_id=item.sensor_name,
            readings=readings_dict,
            coords=item.coords,
            mobility_info=item.mobility_info if item.mobility_info else None,
            is_ghosted=item.is_ghost,
            sensor_type="fixed" if item.is_fixed else "mobile",
        )
        
        if view:
            json_str = json.dumps(view, indent=2)
            json_view.update(
                Panel(
                    JSON(json_str),
                    title=Text("Raw API Data (Live)", style="#b8bb26 bold"),
                    border_style="#b8bb26",
                    style="#ebdbb2 on #1d2021",
                    padding=(0, 1),
                )
            )
        else:
            json_view.update(
                Panel(
                    "No data available",
                    title=Text("Raw API Data", style="#b8bb26 bold"),
                    border_style="#b8bb26",
                    style="#ebdbb2 on #1d2021",
                    padding=(0, 1),
                )
            )

    def on_list_view_highlighted(self, event: ListView.Highlighted) -> None:
        if isinstance(event.item, SensorItem):
            self.update_details_view(event.item)
        self._apply_ghost_classes(self.query_one(ListView))

    def action_open_map(self) -> None:
        list_view = self.query_one(ListView)
        if list_view.index is not None:
            item = list_view.children[list_view.index]
            if isinstance(item, SensorItem) and item.coords:
                lat, lon = item.coords
                url = f"http://maps.apple.com/?q={lat},{lon}"
                try:
                    webbrowser.open(url)
                except Exception:
                    self.notify("Failed to open browser", severity="error")

    def action_open_overview_map(self) -> None:
        """
        Open an overview map (Leaflet) showing all sensors currently in the list.

        - 'm' opens Apple Maps for the currently selected sensor
        - 'M' opens this overview map
        """
        list_view = self.query_one(ListView)
        points = []

        def normalize_hex_color(c: str | None) -> str:
            if not c:
                return "#3388ff"
            s = str(c).strip()
            if s.startswith("dim "):
                s = s[4:].strip()
            if s.startswith("#") and len(s) in (4, 7):
                return s
            return "#3388ff"

        for child in list_view.children:
            if not isinstance(child, SensorItem):
                continue
            if not child.coords:
                continue
            # Idle/ghosted mobile sensors should not be shown on the overview map.
            # Keep fixed sensors visible.
            if child.is_ghost and not child.is_fixed:
                continue
            lat, lon = child.coords

            display_name = child.sensor_name
            if child.custom_name:
                display_name = f"{child.sensor_name} ({child.custom_name})"

            # Marker color: use first reading's display color if available
            marker_color = "#3388ff"
            if child.sensor_readings:
                try:
                    marker_color = normalize_hex_color(child.sensor_readings[0][2])
                except Exception:
                    marker_color = "#3388ff"

            # Popup HTML: sensor title + readings
            popup_lines = [f"<b>{display_name}</b>"]
            popup_lines.append("<div style='margin-top:6px'>")
            for row in child.sensor_readings[:6]:  # keep it readable
                try:
                    key, val, col = row[0], row[1], row[2]
                except Exception:
                    continue
                col_hex = normalize_hex_color(col)
                popup_lines.append(
                    f"<div><span style='color:{col_hex};font-weight:600'>{key}</span>: {val}</div>"
                )
            popup_lines.append("</div>")

            points.append(
                {
                    "lat": lat,
                    "lon": lon,
                    "label": display_name,
                    "popup_html": "\n".join(popup_lines),
                    "color": marker_color,
                }
            )

        if not points:
            self.notify("No sensors with coordinates available to map.", severity="warning")
            return

        html = generate_leaflet_map_html(
            points,
            title=f"MobileAir Overview ({len(points)} sensors)",
            zoom=10,
        )

        # Write HTML into the app data directory so it can be re-opened.
        out_dir = Path(getattr(self, "data_dir", "") or os.getcwd())
        out_path = out_dir / f"mobileair_overview_map.html"
        try:
            out_dir.mkdir(parents=True, exist_ok=True)
            out_path.write_text(html, encoding="utf-8")
        except Exception as e:
            self.notify(f"Failed to write map HTML: {e}", severity="error")
            return

        try:
            webbrowser.open(f"file://{out_path}")
        except Exception:
            self.notify("Failed to open browser", severity="error")

    def action_toggle_ghost_state(self) -> None:
        list_view = self.query_one(ListView)
        if list_view.index is not None:
            item = list_view.children[list_view.index]
            if isinstance(item, SensorItem):
                s_name = item.sensor_name
                if s_name in self.forced_active_sensors:
                    self.forced_active_sensors.remove(s_name)
                    state = "restored (auto)"
                else:
                    self.forced_active_sensors.add(s_name)
                    state = "forced active"
                
                if self.current_data:
                    self.update_list(self.current_data)
                self.notify(f"Sensor {s_name} {state}")

def _run_headless_server(host: str, port: int):
    """Run the dashboard server in headless mode (no TUI, stdout/stderr visible)."""
    from dashboard_server import main as dashboard_main
    print("[Headless] Starting MobileAir dashboard server (no TUI)...")
    print("[Headless] Press Ctrl+C to stop.")
    # Replace sys.argv so dashboard_server.main() sees the right args
    sys.argv = [sys.argv[0], "--host", host, "--port", str(port)]
    try:
        sys.exit(dashboard_main())
    except KeyboardInterrupt:
        print("\n[Headless] Shutting down...")
        sys.exit(0)


_REMOTE_CONFIG = {"url": None}  # Set by --remote flag


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="MobileAir TUI and dashboard server")
    parser.add_argument("--headless", action="store_true",
                        help="Run dashboard server only (no TUI). Stdout/stderr visible.")
    parser.add_argument("--remote", type=str, metavar="URL",
                        help="Connect to remote server (e.g. https://dustytrails.funstuff.app)")
    parser.add_argument("--host", default=os.environ.get("MOBILEAIR_DASHBOARD_HOST", "0.0.0.0"),
                        help="Dashboard server host (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=int(os.environ.get("MOBILEAIR_DASHBOARD_PORT", "8766")),
                        help="Dashboard server port (default: 8766)")
    args = parser.parse_args()

    if args.remote:
        _REMOTE_CONFIG["url"] = args.remote.rstrip('/')
        # Run full TUI in remote mode (no local server)
        app = AirQualityApp(dashboard_handle=None)
        app.run()
    elif args.headless:
        _run_headless_server(args.host, args.port)
    else:
        dashboard_handle = _start_dashboard_server_process()
        try:
            app = AirQualityApp(dashboard_handle=dashboard_handle)
            app.run()
        finally:
            # Clean up dashboard server
            if dashboard_handle is not None:
                if isinstance(dashboard_handle, tuple):
                    # Bundled mode: (stop_event, httpd)
                    stop_event, httpd = dashboard_handle
                    try:
                        stop_event.set()
                        httpd.shutdown()
                    except Exception:
                        pass
                elif hasattr(dashboard_handle, 'poll'):
                    # Subprocess mode
                    if dashboard_handle.poll() is None:
                        try:
                            dashboard_handle.terminate()
                            dashboard_handle.wait(timeout=2.0)
                        except Exception:
                            try:
                                dashboard_handle.kill()
                            except Exception:
                                pass
