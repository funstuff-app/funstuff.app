"""
MobileAir - Air quality monitoring for Utah.

This package provides core functionality for processing air quality data
from Utah AQ endpoints, including:

- AQI calculations and level determination
- Mobility detection for mobile sensors
- Trail extraction and cleaning
- Spatial outlier detection
- Network fetching with caching
- Dashboard state normalization
"""

from __future__ import annotations

# Configuration
from .config import (
    TREND_LOOKAHEAD_MINUTES,
    TREND_WINDOW_SAMPLES,
    TREND_THRESHOLDS,
    IMMOBILITY_LOOKBACK_MINUTES,
    IMMOBILITY_MIN_COVERAGE_MINUTES,
    IMMOBILITY_MIN_SAMPLES,
    IMMOBILITY_TOTAL_DISTANCE_THRESHOLD,
    IMMOBILITY_MAX_STEP_THRESHOLD,
    IMMOBILITY_BBOX_THRESHOLD,
    IMMOBILITY_RADIUS_THRESHOLD,
    IMMOBILITY_NET_DISTANCE_THRESHOLD,
    SPARSE_PROVE_MOVING_MAX_STEP_M,
    SPARSE_PROVE_MOVING_NET_M,
    SPARSE_ASSUME_IDLE_ROBUST_RADIUS_M,
    STALE_DATA_THRESHOLD_MINUTES,
    AQI_LEVELS,
    POLLUTANT_BREAKPOINTS,
    MOBILE_URL,
    FIXED_URL,
    HEADERS,
)

# Utilities
from .utils import (
    parse_utc_timestamp,
    haversine_distance,
    bounding_box_distance,
    coerce_float,
    median,
)

# AQI
from .aqi import (
    normalize_pollutant_key,
    value_to_aqi,
    aqi_level,
    color_for_value,
    AQI_COLOR_PALETTE,
    color_to_idx,
    trend_threshold,
    filter_history_outliers,
    extract_numeric_history,
    compute_trend_indicator,
)

# Mobility
from .mobility import evaluate_mobility

# Trails
from .trails import (
    extract_mobile_tracks,
    clean_trail,
    collapse_stationary_suffix,
)

# Outliers
from .outliers import detect_spatial_outliers

# Network
from .network import (
    default_cache_path,
    fetch_json_with_cache,
    stdlib_get,
)

# Map HTML
from .map_html import generate_leaflet_map_html

# Dashboard
from .dashboard import normalize_state_for_dashboard

# TUI Formatting (shared between terminal and web TUI)
from .tui_format import (
    format_sensor_for_list,
    format_all_sensors,
    format_tui_state,
    format_json_view,
    get_pollutant_columns,
    get_trend_symbol,
    format_value,
    truncate_name,
    POLLUTANT_ORDER,
    POLLUTANT_LABELS,
    VALUE_WIDTH,
    MAX_NAME_LEN,
)


# For backwards compatibility, also expose private functions that may be used
# These are prefixed with underscore but were part of the old API
_coerce_float = coerce_float
_median = median
_clean_trail = clean_trail
_collapse_stationary_suffix = collapse_stationary_suffix


__all__ = [
    # Config
    "TREND_LOOKAHEAD_MINUTES",
    "TREND_WINDOW_SAMPLES",
    "TREND_THRESHOLDS",
    "IMMOBILITY_LOOKBACK_MINUTES",
    "IMMOBILITY_MIN_COVERAGE_MINUTES",
    "IMMOBILITY_MIN_SAMPLES",
    "IMMOBILITY_TOTAL_DISTANCE_THRESHOLD",
    "IMMOBILITY_MAX_STEP_THRESHOLD",
    "IMMOBILITY_BBOX_THRESHOLD",
    "IMMOBILITY_RADIUS_THRESHOLD",
    "IMMOBILITY_NET_DISTANCE_THRESHOLD",
    "SPARSE_PROVE_MOVING_MAX_STEP_M",
    "SPARSE_PROVE_MOVING_NET_M",
    "SPARSE_ASSUME_IDLE_ROBUST_RADIUS_M",
    "AQI_LEVELS",
    "POLLUTANT_BREAKPOINTS",
    "MOBILE_URL",
    "FIXED_URL",
    "HEADERS",
    # Utils
    "parse_utc_timestamp",
    "haversine_distance",
    "bounding_box_distance",
    "coerce_float",
    "median",
    # AQI
    "normalize_pollutant_key",
    "value_to_aqi",
    "aqi_level",
    "color_for_value",
    "AQI_COLOR_PALETTE",
    "color_to_idx",
    "trend_threshold",
    "filter_history_outliers",
    "extract_numeric_history",
    "compute_trend_indicator",
    # Mobility
    "evaluate_mobility",
    # Trails
    "extract_mobile_tracks",
    "clean_trail",
    "collapse_stationary_suffix",
    # Outliers
    "detect_spatial_outliers",
    # Network
    "default_cache_path",
    "fetch_json_with_cache",
    "stdlib_get",
    # Map HTML
    "generate_leaflet_map_html",
    # Dashboard
    "normalize_state_for_dashboard",
    # TUI Format
    "format_sensor_for_list",
    "format_all_sensors",
    "format_tui_state",
    "format_json_view",
    "get_pollutant_columns",
    "get_trend_symbol",
    "format_value",
    "truncate_name",
    "POLLUTANT_ORDER",
    "POLLUTANT_LABELS",
    "VALUE_WIDTH",
    "MAX_NAME_LEN",
    # Compat aliases
    "_coerce_float",
    "_median",
    "_clean_trail",
    "_collapse_stationary_suffix",
]
