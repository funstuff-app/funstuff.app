const _isLite = new URLSearchParams(window.location.search).get('lite') === '1';
const _isWindows = /Win/.test(navigator.platform || navigator.userAgent);
const _isMac = /Mac/.test(navigator.platform || navigator.userAgent);
const _isMobileDevice = /iPad|iPhone|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1);

/**
 * PM2.5 concentration → [r, g, b], matching Python color_for_value("pm2.5", v).
 * Same breakpoints so scalar field colors match dot colors exactly.
 */
function _pm25ToRgb(v) {
  if (v <= 2.0)  return [0x00, 0xFF, 0xFF]; // cyan
  if (v <= 5.0)  return [0x00, 0xCC, 0xFF]; // lt-blue
  if (v <= 9.0)  return [0x00, 0xE4, 0x00]; // green
  if (v <= 35.4) return [0xFF, 0xFF, 0x00]; // yellow
  if (v <= 55.4) return [0xFF, 0x7E, 0x00]; // orange
  if (v <= 125.4) return [0xFF, 0x00, 0x00]; // red
  if (v <= 225.4) return [0x8F, 0x3F, 0x97]; // purple
  return [0x7E, 0x00, 0x23];                 // maroon
}

/** PM2.5 → color category index (0-7). Same breakpoints as _pm25ToRgb. */
function _pm25ColorCat(v) {
  if (v <= 2.0)  return 0;
  if (v <= 5.0)  return 1;
  if (v <= 9.0)  return 2;
  if (v <= 35.4) return 3;
  if (v <= 55.4) return 4;
  if (v <= 125.4) return 5;
  if (v <= 225.4) return 6;
  return 7;
}

const _BAND_MIDS = [1.0, 3.5, 7.0, 22.2, 45.4, 90.4, 175.4, 250.0];
const _PA_FIELD_NON_PURPLEAIR_PROXIMITY_DEG = 0.55;
const _PA_FIELD_FIXED_WEIGHT_MULTIPLIER = 10;

// ── Overfetch constants: render PA field & trails on a buffer larger than the
// viewport so gesture panning reveals pre-rendered content instead of blank edges.
const _OVERFETCH = 1.5;              // buffer = viewport × this factor
const _OVERFETCH_MAX_DEVICE_PX = 4096; // hard cap to avoid GPU OOM
const _OVERFETCH_MARGIN_EXHAUST = 0.65; // re-render when pan consumes this fraction of margin

/** Map legend tab id → array of reading keys to search for in fixed sensor data. */
const _LEGEND_TAB_READING_KEYS = {
  pm25: ["PM25", "PM2.5", "pm25", "pm2.5"],
  pm10: ["PM10", "pm10"],
  o3:   ["OZNE", "O3", "OZONE", "ozone", "o3"],
  no2:  ["NO2", "no2"],
  co:   ["CO", "co"],
};
/** Map legend tab id → aqi.js pollutant key for valueToAqi(). */
const _LEGEND_TAB_AQI_KEY = {
  pm25: "pm2.5", pm10: "pm10", o3: "ozone", no2: "no2", co: "co",
};
/** Map legend tab id → display label for marker. */
const _LEGEND_TAB_LABEL = {
  pm25: "PM25", pm10: "PM10", o3: "O\u2083", no2: "NO\u2082", co: "CO",
};
/** Map legend tab id → mobile trail reading keys. */
const _LEGEND_TAB_TRAIL_KEYS = {
  pm25: ["PM25", "PM2.5", "pm25"],
  pm10: ["PM10", "pm10"],
  o3:   ["OZNE", "O3", "OZONE", "ozone", "o3"],
  no2:  ["NO2", "no2"],
  co:   ["CO", "co"],
};

/** Extract a specific pollutant's reading from a sensor readings object.
 *  Returns { key, value, color, aqi } or null if that pollutant isn't present. */
function _readingForLegendTab(readings, legendTab) {
  if (!readings || !legendTab) return null;
  const keys = _LEGEND_TAB_READING_KEYS[legendTab];
  if (!keys) return null;
  for (const rk of keys) {
    const r = readings[rk];
    if (r && r.value != null) {
      const aqi = valueToAqi(_LEGEND_TAB_AQI_KEY[legendTab] || "pm2.5", r.value);
      // Use the server's precomputed discrete band color (r.ci) for markers.
      // _aqiToRgb is a continuous ramp for the heatmap field; its intermediate
      // colors don't align with pollutant-specific band boundaries.
      const color = safeHex(r.ci);
      return { key: rk, value: r.value, color, aqi };
    }
  }
  return null;
}

function _collectPaFieldSensors(fixed, playbackTimeMs, centerW, zoom, cssW, cssH, pollutantTab, bufW, bufH, refNowMs) {
  const isPm25 = !pollutantTab || pollutantTab === "pm25";
  const aqiKey = _LEGEND_TAB_AQI_KEY[pollutantTab || "pm25"] || "pm2.5";
  const readingKeys = _LEGEND_TAB_READING_KEYS[pollutantTab || "pm25"] || _LEGEND_TAB_READING_KEYS.pm25;
  // Utah bounding box: skip sensors outside the Wasatch Front / Utah region
  const _UT_MIN_LAT = 36.9, _UT_MAX_LAT = 42.1, _UT_MIN_LON = -114.1, _UT_MAX_LON = -109.0;
  // Project to buffer center when overfetch dimensions supplied
  const projW = bufW || cssW;
  const projH = bufH || cssH;

  // Staleness fade for PurpleAir sensors (matches dot rendering in drawOverlay)
  const PA_FADE_MS = 45 * 60 * 1000;
  const PA_FADE_TAIL = 0.20;
  const paFadeStart = PA_FADE_MS * (1.0 - PA_FADE_TAIL);

  const paLatLons = [];
  for (const f of fixed) {
    if (!f || !f.purpleair) continue;
    const lat = Number(f.lat);
    const lon = Number(f.lon);
    if (isFinite(lat) && isFinite(lon)) paLatLons.push(lat, lon);
  }

  const sensors = [];
  let fingerprint = "";
  for (const f of fixed) {
    if (!f) continue;
    if (f.outlier) continue;
    const lat = Number(f.lat);
    const lon = Number(f.lon);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    if (lat < _UT_MIN_LAT || lat > _UT_MAX_LAT || lon < _UT_MIN_LON || lon > _UT_MAX_LON) continue;

    if (isPm25) {
      // PM2.5 mode: PurpleAir + nearby non-PA fixed (original behavior)
      if (!f.purpleair) {
        let nearPA = false;
        for (let pi = 0; pi < paLatLons.length; pi += 2) {
          const dlat = lat - paLatLons[pi];
          const dlon = lon - paLatLons[pi + 1];
          if (dlat * dlat + dlon * dlon < _PA_FIELD_NON_PURPLEAIR_PROXIMITY_DEG * _PA_FIELD_NON_PURPLEAIR_PROXIMITY_DEG) {
            nearPA = true;
            break;
          }
        }
        if (!nearPA) continue;
      }
    } else {
      // Non-PM2.5 mode: only non-PurpleAir fixed sensors (ghost markers)
      if (f.purpleair) continue;
    }

    // PurpleAir staleness: skip fully stale, decay weight in tail
    let staleWeight = 1.0;
    if (f.purpleair && refNowMs) {
      const sMs = f.last_seen ? f.last_seen * 1000 : null;
      if (sMs) {
        const ageMs = refNowMs - sMs;
        if (ageMs >= PA_FADE_MS) continue;
        if (ageMs > paFadeStart) {
          const u = (ageMs - paFadeStart) / (PA_FADE_MS - paFadeStart);
          staleWeight = (1 - u) * (1 - u);
          if (staleWeight <= 0.01) continue;
        }
      }
    }

    const interp = interpolateFixedReadingsAtTime(f, playbackTimeMs);
    let value = NaN;
    let readingOutlier = false;
    for (const rk of readingKeys) {
      const r = interp && interp[rk];
      if (r && r.value != null) { value = Number(r.value); readingOutlier = !!r.outlier; break; }
    }
    if (!isFinite(value) || value < 0) continue;
    if (readingOutlier) continue;

    const wp = latLonToWorld(lat, lon, zoom);
    sensors.push({
      sx: wp.x - centerW.x + projW / 2,
      sy: wp.y - centerW.y + projH / 2,
      value,
      weightMultiplier: (f.purpleair ? 1 : _PA_FIELD_FIXED_WEIGHT_MULTIPLIER) * staleWeight,
    });
    fingerprint += isPm25 ? _pm25ColorCat(value) : _aqiColorCat(valueToAqi(aqiKey, value) ?? 0);
  }

  return { sensors, fingerprint };
}

/**
 * Collect virtual PA sensors from mobile trail GPS points.
 * Each trail point with a reading for the selected pollutant becomes a transient sensor
 * that decays over the same time window as the trail fade.
 */
function _collectVirtualMobileSensors(mobiles, playbackTimeMs, isPlayback, centerW, zoom, cssW, cssH, refNowMs, pollutantTab, bufW, bufH) {
  const isPm25 = !pollutantTab || pollutantTab === "pm25";
  const aqiKey = _LEGEND_TAB_AQI_KEY[pollutantTab || "pm25"] || "pm2.5";
  const trailKeys = _LEGEND_TAB_TRAIL_KEYS[pollutantTab || "pm25"] || _LEGEND_TAB_TRAIL_KEYS.pm25;
  // Project to buffer center when overfetch dimensions supplied
  const projW = bufW || cssW;
  const projH = bufH || cssH;
  // Map keyed by quantized lat/lon — at most 1 virtual sensor per spatial slot.
  // Iterating newest-first means the freshest reading at each location wins.
  const sensorMap = new Map();

  // Match trail fade timing exactly
  const FADE_TIME_MS = isPlayback ? 45 * 60 * 1000 : 20 * 60 * 1000;
  const FADE_TAIL_FRAC = 0.20;
  const fadeStartAgeMs = FADE_TIME_MS * (1.0 - FADE_TAIL_FRAC);

  if (!refNowMs || !isFinite(refNowMs)) return { sensors: [], fingerprint: "" };

  const ws = worldSizeForZoom(zoom);

  for (const m of mobiles) {
    if (!m) continue;
    const trail = Array.isArray(m.trail) ? m.trail : [];
    if (trail.length < 1) continue;

    // Iterate from newest (end) backward; break once past fade window
    for (let i = trail.length - 1; i >= 0; i--) {
      const p = trail[i];
      if (!p) continue;

      // Parse timestamp (use cached _tMs when available)
      let tMs = p._tMs;
      if (tMs === undefined) {
        tMs = (typeof p.t === "string") ? parseUtcMs(p.t) : null;
        try { p._tMs = tMs; } catch {}
      }
      if (tMs == null || !isFinite(tMs)) continue;

      const ageMs = refNowMs - tMs;
      if (ageMs < 0) continue;           // future point in playback
      if (ageMs >= FADE_TIME_MS) break;   // past fade window (older points only get older)

      // Extract reading for selected pollutant — skip if absent
      let rawVal = undefined;
      const rd = p.readings;
      if (rd) {
        for (const rk of trailKeys) {
          const rv = rd[rk]?.value ?? rd[rk];
          if (rv != null && typeof rv !== "object") { rawVal = rv; break; }
          if (rv != null && typeof rv === "object" && rv.value != null) { rawVal = rv.value; break; }
        }
      }
      if (rawVal == null) continue;
      const pollVal = Number(rawVal);
      if (!isFinite(pollVal) || pollVal < 0) continue;

      // Decay weight: full for fresh, quadratic falloff in tail
      let decayWeight = 1.0;
      if (ageMs > fadeStartAgeMs) {
        const u = (ageMs - fadeStartAgeMs) / (FADE_TIME_MS - fadeStartAgeMs);
        decayWeight = (1 - u) * (1 - u);
        if (decayWeight <= 0.01) continue;
      }

      // Spatial dedup: 1 sensor per ~220m cell. Newest-first → skip if slot taken.
      // Reduced to half for performance diagnostics
      const lat = Number(p.lat), lon = Number(p.lon);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      const slotKey = `${(lat * 250) | 0},${(lon * 250) | 0}`;
      if (sensorMap.has(slotKey)) continue;

      // Project GPS to screen coords (use cached norm when available)
      let u = p._u, v = p._v;
      if (u === undefined) {
        const norm = latLonToNorm(lat, lon);
        u = norm.u; v = norm.v;
        try { p._u = u; p._v = v; } catch {}
      }
      const wx = u * ws, wy = v * ws;
      const sx = wx - centerW.x + projW / 2;
      const sy = wy - centerW.y + projH / 2;

      sensorMap.set(slotKey, { sx, sy, value: pollVal, weightMultiplier: _PA_FIELD_FIXED_WEIGHT_MULTIPLIER * decayWeight });
    }
  }

  const sensors = Array.from(sensorMap.values());
  let fingerprint = "";
  for (const s of sensors) fingerprint += isPm25 ? _pm25ColorCat(s.value) : _aqiColorCat(valueToAqi(aqiKey, s.value) ?? 0);
  return { sensors, fingerprint };
}

/** Compute the playback time range over which the PA field fingerprint is unchanged.
 *  Scans each sensor's PM2.5 timeline to find the nearest past and future points
 *  where _pm25ColorCat would change. Returns { fromMs, toMs }. */
function _findFingerprintValidRange(fixed, playbackTimeMs) {
  let nextChangeMs = Infinity;
  let prevChangeMs = -Infinity;

  for (const f of fixed) {
    if (!f) continue;
    const readings = f && f.readings;
    if (!readings) continue;
    // Check PM2.5-like keys (same keys _collectPaFieldSensors uses)
    const r = readings["PM25"] || readings["PM2.5"] || readings["pm25"] || readings["pm2.5"];
    if (!r || !r._parsedTimeline) continue;
    const { timesMs, valuesF } = r._parsedTimeline;
    if (!timesMs || timesMs.length < 2) continue;

    // Binary search for current index
    let idx;
    if (playbackTimeMs <= timesMs[0]) {
      idx = 0;
    } else if (playbackTimeMs >= timesMs[timesMs.length - 1]) {
      idx = timesMs.length - 1;
    } else {
      let lo = 0, hi = timesMs.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (timesMs[mid] <= playbackTimeMs) lo = mid;
        else hi = mid - 1;
      }
      idx = lo;
    }

    const curCat = _pm25ColorCat(valuesF[idx]);

    // Forward: find the next data point that changes color category
    for (let i = idx + 1; i < timesMs.length; i++) {
      if (_pm25ColorCat(valuesF[i]) !== curCat) {
        if (timesMs[i] < nextChangeMs) nextChangeMs = timesMs[i];
        break;
      }
    }
    // Backward: find when the current category segment started
    for (let i = idx - 1; i >= 0; i--) {
      if (_pm25ColorCat(valuesF[i]) !== curCat) {
        // Current segment started at timesMs[i+1]
        if (timesMs[i + 1] > prevChangeMs) prevChangeMs = timesMs[i + 1];
        break;
      }
    }
  }

  return { fromMs: prevChangeMs, toMs: nextChangeMs };
}

const _PM25_SMOOTH_STOPS = [
  [0,     0x00,0xFF,0xFF],
  [1.0,   0x00,0xFF,0xFF],  // cyan   – mid of 0–2
  [3.5,   0x00,0xCC,0xFF],  // lt-blue– mid of 2–5
  [7.0,   0x00,0xE4,0x00],  // green  – mid of 5–9
  [22.2,  0xFF,0xFF,0x00],  // yellow – mid of 9–35.4
  [45.4,  0xFF,0x7E,0x00],  // orange – mid of 35.4–55.4
  [90.4,  0xFF,0x00,0x00],  // red    – mid of 55.4–125.4
  [175.4, 0x8F,0x3F,0x97],  // purple – mid of 125.4–225.4
  [250.0, 0x7E,0x00,0x23],  // maroon – mid of 225.4+
  [500,   0x7E,0x00,0x23]
];

/** PM2.5 → [r,g,b] with continuous linear interpolation between AQI color stops.
 *  Stops placed at band midpoints (_BAND_MIDS) so colors match dot palette at
 *  typical readings; transitions occur near band boundaries. */
function _pm25ToRgbSmooth(v) {
  const stops = _PM25_SMOOTH_STOPS;
  if (v <= stops[0][0]) return [stops[0][1], stops[0][2], stops[0][3]];
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const t = (v - stops[i-1][0]) / (stops[i][0] - stops[i-1][0]);
      return [
        Math.round(stops[i-1][1] + t * (stops[i][1] - stops[i-1][1])),
        Math.round(stops[i-1][2] + t * (stops[i][2] - stops[i-1][2])),
        Math.round(stops[i-1][3] + t * (stops[i][3] - stops[i-1][3]))
      ];
    }
  }
  const last = stops[stops.length - 1];
  return [last[1], last[2], last[3]];
}

const _PM25_AQI_BP = [
  [0.0,   9.0,   0,   50],
  [9.1,   35.4,  51,  100],
  [35.5,  55.4,  101, 150],
  [55.5,  125.4, 151, 200],
  [125.5, 225.4, 201, 300],
  [225.5, 325.4, 301, 500],
];

/** PM2.5 concentration → AQI index (EPA piecewise-linear, PM2.5 24-hr breakpoints). */
function _pm25ToAqi(v) {
  const bp = _PM25_AQI_BP;
  if (v < 0) return 0;
  for (let i = 0; i < bp.length; i++) {
    if (v <= bp[i][1]) {
      const [cLo, cHi, aLo, aHi] = bp[i];
      return cHi === cLo ? aHi : (aHi - aLo) / (cHi - cLo) * (v - cLo) + aLo;
    }
  }
  return 500;
}

const _AQI_RGB_STOPS = [
  [0,     0x00,0xFF,0xFF],
  [6,     0x00,0xFF,0xFF],  // cyan    – AQI ~6
  [19,    0x00,0xCC,0xFF],  // lt-blue – AQI ~19
  [50,    0x00,0xE4,0x00],  // green   – AQI 50 (top of Good)
  [51,    0xFF,0xFF,0x00],  // yellow  – AQI 51 (Moderate)
  [100,   0xFF,0xFF,0x00],  // yellow  – AQI 100 (top of Moderate)
  [101,   0xFF,0x7E,0x00],  // orange  – AQI 101 (USG)
  [150,   0xFF,0x7E,0x00],  // orange  – AQI 150 (top of USG)
  [151,   0xFF,0x00,0x00],  // red     – AQI 151 (Unhealthy)
  [200,   0xFF,0x00,0x00],  // red     – AQI 200 (top of Unhealthy)
  [201,   0x8F,0x3F,0x97],  // purple  – AQI 201 (Very Unhealthy)
  [300,   0x8F,0x3F,0x97],  // purple  – AQI 300 (top of Very Unhealthy)
  [500,   0x7E,0x00,0x23]   // maroon  – Hazardous (301+)
];

/** AQI → color-category index matching _AQI_RGB_STOPS band boundaries. Used for fingerprinting. */
function _aqiColorCat(aqi) {
  if (aqi <= 6)   return 0;
  if (aqi <= 19)  return 1;
  if (aqi <= 50)  return 2;
  if (aqi <= 100) return 3;
  if (aqi <= 150) return 4;
  if (aqi <= 200) return 5;
  if (aqi <= 300) return 6;
  return 7;
}

/** AQI index → RGB color.  Same colors as _pm25ToRgbSmooth, stops at AQI equivalents. */
function _aqiToRgb(aqi) {
  const stops = _AQI_RGB_STOPS;
  if (aqi <= stops[0][0]) return [stops[0][1], stops[0][2], stops[0][3]];
  for (let i = 1; i < stops.length; i++) {
    if (aqi <= stops[i][0]) {
      const t = (aqi - stops[i-1][0]) / (stops[i][0] - stops[i-1][0]);
      return [
        Math.round(stops[i-1][1] + t * (stops[i][1] - stops[i-1][1])),
        Math.round(stops[i-1][2] + t * (stops[i][2] - stops[i-1][2])),
        Math.round(stops[i-1][3] + t * (stops[i][3] - stops[i-1][3]))
      ];
    }
  }
  const last = stops[stops.length - 1];
  return [last[1], last[2], last[3]];
}

class MapView {
  constructor(tilesCanvas, paFieldCanvas, overlayCanvas) {
    this.tilesCanvas = tilesCanvas;
    this.paFieldCanvasEl = paFieldCanvas;
    this.overlayCanvas = overlayCanvas;
    // Use willReadFrequently: false (default) to hint GPU-accelerated rendering.
    // This is especially important for iPad/iOS performance.
    this.tctx = tilesCanvas.getContext("2d", { willReadFrequently: false });
    this.pfctx = paFieldCanvas.getContext("2d", { willReadFrequently: false });
    this.octx = overlayCanvas.getContext("2d", { willReadFrequently: false });

    // fractional zoom for smooth pinch / button zooming
    this.zoom = 12.58; // 50% more zoomed in than the original 12 (log2 scale: +log2(1.5))
    this._zoomMin = 3;
    this._zoomMax = 18;
    this._pinchAnchor = null; // { lat, lon, sx, sy, lastTs }
    // Prefer native macOS Safari pinch gesture events when available.
    this._gesture = null; // { startZoom, startScale, anchorLat, anchorLon, sx, sy }
    // Mouse drag pan (optional). Does not affect trackpad controls.
    this._mouseDragging = false;
    this._mouseDragStart = null; // {x,y}
    this._mouseDragCenterStart = null; // {x,y,ws}
    this._mouseDragMoved = false;
    this.center = { lat: 40.7608, lon: -111.8910 };
    // macOS trackpad UX: two-finger pan + pinch zoom (avoid mouse-drag schema)
    this._centerAnimRAF = null;

    // Auto-camera follow must never override user interaction.
    // Suppress live-follow/forced-fit animations during interaction + short cooldown.
    this._autoCameraSuppressedUntilPerfMs = 0;
    this._autoCameraCooldownMs = 1400;
    this._lastAutoFitSig = "";
    this._autoFitInFlightSig = "";
    this._pendingForcedFit = null; // { bounds, durationMs }
    this.selectedId = null;
    // Hover state: show label on mouseover with debounce
    this._hoveredId = null;       // key currently showing hover label
    this._hoverShowTimer = null;  // setTimeout id for show debounce
    this._hoverHideTimer = null;  // setTimeout id for hide debounce
    // Marker visibility toggles
    this.showFixed = true;
    this.showMobile = true;
    // Label visibility is per-sensor-type (mobile vs fixed)
    this.showMobileLabels = false;
    this.showFixedLabels = false;
    // PA field dim: 1.0 = full (PM2.5 selected or legend closed), 0.05 = dimmed (other pollutant)
    this._paFieldDimTarget = 1.0;
    this._paFieldDimCurrent = 1.0;
    this._paFieldDimRAF = null;
    // PA field pollutant: which pollutant the field should display (null = default/highest AQI)
    this._paFieldPollutant = null;
    // Marker pollutant override: only set from explicit legend tab clicks
    this._markerPollutantOverride = null;
    // Trace mode: animate the emoji along its own breadcrumb trail.
    this.traceMode = false;
    this._traceRAF = null;
    this._traceLastFrameTs = 0;
    this._traceTargetFPS = 30; // reduce CPU while staying smooth
    this._backgroundedFPS = 15; // throttle when tab is hidden
    this._backgrounded = document.visibilityState === "hidden";

    this._followRAF = null;
    this._followLastFrameTs = 0;
    this._followSuppressUntilMs = 0;
    this._followTargetLat = null;
    this._followTargetLon = null;

    // Cached viewport metrics to avoid per-frame layout reads (getBoundingClientRect is expensive).
    this._dpr = window.devicePixelRatio || 1;
    this._cssW = 1;
    this._cssH = 1;

    // OS detection for platform-specific input handling (module-level constants)
    this._isWindows = _isWindows;
    this._isMac = _isMac;

    // Trace-mode optimization: cache static overlay (trails + fixed markers).
    this._overlayStaticCanvas = null; // offscreen canvas in device pixels
    this._overlayStaticKey = "";
    this._overlayStaticDirty = true;

    // PurpleAir scalar field underlay: cached offscreen canvas of radial gradient discs.
    this._paFieldCanvas = null;
    this._paFieldCtx = null;
    this._paFieldKey = "";
    // Cross-fade: previous field canvas + transition timing.
    // The fade uses "lighter" (additive) compositing so prev*(1-t) + new*t
    // produces a linear color blend. In cells where prev == new this collapses
    // to a single draw at dimAlpha (no visible effect); in cells that changed
    // you get a smooth color transition with no luminance dip.
    this._paFieldPrevCanvas = null;
    this._paFieldFadeStart = 0;
    this._paFieldFadeMs = 300;
    // Fingerprint validity window: playback time range where no sensor changes
    // color category, so _collectPaFieldSensors can be skipped entirely.
    this._paFieldValidRange = null; // { fromMs, toMs }
    this._paFieldValidViewKey = null;
    this._paFieldValidFixed = null; // reference to fixed array (invalidates on new data)
    // Worker-based pre-warming: compute upcoming color transition fields off-thread.
    this._paWorker = null;
    this._paWorkerJobId = 0;
    this._paWorkerPending = false;
    this._paWorkerFingerprint = ""; // fingerprint of the in-flight pre-warm job
    // Pre-warmed pixel buffers keyed by color fingerprint (view-independent).
    this._paFieldPrewarmed = new Map(); // fingerprint → { px, gw, gh }
    this._paFieldCacheMax = 16;
    // Pre-warm scan throttle: avoid re-scanning sensor history every frame.
    this._preWarmScanValidUntilMs = null;
    this._preWarmScanFixed = null;
    // View state when PA field was last computed (for gesture translate)
    this._paFieldComputedView = null; // { centerLat, centerLon, zoom }

    // ── Advection-diffusion wind field state ──────────────────────────────
    this._advectionWorker = null;
    this._advectionFrame = null;    // latest { px, gw, gh } from worker
    this._advectionCanvas = null;   // offscreen canvas for upscaling
    this._advectionInitialized = false;
    this._advectionLastTickMs = 0;  // performance.now() of last tick
    this._advectionSensorFP = "";   // fingerprint to detect sensor changes
    this._windField = null;         // current [{lat,lon,u,v}, ...] for rendering
    this._windSnapshots = null;      // {"HHMM": [{lat,lon,u,v},...], ...} all day's snapshots
    this._windSnapshotKeys = [];     // sorted ["0000","0015",...]
    this._windFieldEtag = null;
    this._windFieldLastFetch = 0;   // performance.now() of last fetch
    this._windFieldFetchInterval = 900000; // 15 min
    this._windFieldFetchInFlight = false;

    // Playback-mode optimization: cache trails to offscreen canvas.
    // Trails only need redrawing when view changes; time advances use incremental updates.
    this._trailCacheCanvas = null;
    this._trailCacheViewKey = "";
    this._trailCacheTimeMs = null;
    this._lastTrailRedrawPerf = 0;

    // Trace-mode optimization: cache cleaned point lists per mobile id for sampling.
    this._tracePtsById = new Map(); // id -> [{lat,lon}, ...]
    this._tracePtsKey = "";
    this._traceLastSideById = new Map(); // id -> "L" | "R"

    // Trace-route buffering: keep active route stable for the whole loop.
    this._traceActiveRouteById = new Map(); // id -> route
    this._tracePendingRouteById = new Map(); // id -> route
    this._traceCycleStartMsById = new Map(); // id -> cycleStartMs (performance.now timeline)
    this._traceInitialRunDoneById = new Map(); // id -> boolean

    // Rotation smoothing to prevent snapping when direction changes.
    this._traceAngleById = new Map(); // id -> filtered angle
    this._traceAngleLastMsById = new Map(); // id -> last nowMs

    // DVR playback: sample all vehicles against a shared global time.
    this.playbackMode = false;
    this._playbackPlaying = false;
    this._playbackSpeed = 5.0;
    this._playbackNowMs = null; // UTC epoch ms
    this._playbackMinMs = null;
    this._playbackMaxMs = null;
    this._playbackPtsById = new Map(); // id -> [{lat,lon,tMs}, ...]
    this._playbackPtsKey = "";
    this._physicsStateById = new Map(); // id -> {u, v, segIdx, lastPerfMs}
    // LIVE follow-tail: when true, keep playhead pinned to end-of-data (maxMs).
    // This is the default "LIVE" experience (no rewinds).
    this._playbackLiveFollow = true;
    // Track whether initial playback position has been set (to apply 10-min offset once)
    this._playbackInitialized = false;

    // Foveated road matching: progressively match segments during playback
    this._roadMatchedRangesById = new Map(); // id -> [{fromMs, toMs}] - already matched ranges
    this._roadMatchPending = new Set(); // sensor IDs currently being fetched
    this._roadMatchLastRequestMs = 0; // throttle requests

    // Data-time clock (UTC epoch ms) anchored to incoming trail timestamps.
    // This avoids using wall-clock Date.now() directly for decay timing.
    this._dataNowBaseMs = null; // UTC epoch ms
    this._dataNowBasePerfMs = null; // performance.now() at base capture

    // "Newest segment" replay:
    // When new data extends the global max timestamp, we record the previous max as the
    // start of the newest segment. Clicking Play seeks there and plays forward.
    this._playbackNewestSegmentStartMs = null;
    this._playbackLastMaxMs = null;

    // DVR drag-scrub: click-drag a vehicle along its path to scrub the global playhead.
    this._pbDrag = null; // { id, startedAtMs, lastClient:{x,y}, cursorClient:{x,y}, lastMoveMs, vel:{x,y}, wasPlaying }
    // DVR inertial glide: after releasing a dragged marker, keep a short 2D inertia cursor
    // and scrub the global playhead from it. Only the last-interacted marker uses this.
    this._pbInertia2d = null; // { id, t0Ms, lastMs, posClient:{x,y}, vel:{x,y} }
    this._pbDebugPath = false;
    this._pbDebugRawGps = true; // Show raw GPS path in debug mode (orange)
    this._pbDebugRoadLines = true; // Show road graph lines in debug mode (blue)
    // Vehicle actual path buffer: records the dynamically computed positions (phys.lat/lon)
    // This is the ACTUAL path the vehicle takes, which differs based on speed/steering
    this._vehicleActualPathById = new Map(); // id -> [{lat, lon, d}]
    // Road graph edges cache (for debug visualization)
    this._roadGraphEdges = null; // [{lat1, lon1, lat2, lon2}, ...] or null
    // Tram line graph edges cache (for debug visualization)
    this._tramLineEdges = null; // [{lat1, lon1, lat2, lon2, elev1?, elev2?}, ...] or null
    this._tramLineHasElevation = false; // Whether elevation data is available

    // Selection orchestration (polished camera + trace sync).
    this._selectOrchRAF = null;
    this._selectOrch = null; // { id, t0Ms, homeLat, homeLon, camTo:{lat,lon}, camFrom:{lat,lon}, camDelayMs, camDurMs, warpDurMs }
    this._traceSelectionWarpById = new Map(); // id -> { t0Ms, fromLat, fromLon, homeLat, homeLon, fadeMs, durationMs }

    // Trace playback tuning (kept as fields so you can tweak later).
    // - We still base movement on GPS timestamps/distances, but we normalize to a
    //   human-watchable speed (otherwise real-world sparse updates look like crawling).
    this._traceTargetMedianSpeedMps = 7.0; // ~15.7 mph (playback median)
    this._traceMaxSpeedMps = 18.0; // ~40 mph (playback cap)
    this._traceRealMaxSpeedMps = 20.0; // ~45 mph (badge cap; filters GPS jumps)
    this._traceSpeedSmoothingTauS = 1.6; // smaller = snappier accel/brake
    this._traceStopSpeedMps = 0.25; // below this, treat as stop/dwell
    this._traceStopMinMs = 350;
    this._traceStopMaxMs = 3500;
    this._traceDwellTimeCompression = 12.0; // higher = shorter dwells

    // Persist trails on-screen across server history dropouts.
    // This is *not* a short tail cache or a faded fallback; it is the last known full
    // breadcrumb trail held in-memory until the page reloads.
    this._persistedTrailById = new Map(); // id -> { trail: [...], color?, ghosted? }
    this._persistedTrailRev = 0;
    this.maxTrailLen = 1000;

    // Basemap tile cache (LRU bounded). Without eviction this grows unbounded as you pan/zoom.
    // Lower limit on mobile/tablet for memory constraints; detect via coarse heuristic.
    this.tileCache = new Map(); // key -> {img, ok}
    this._tileCacheMax = _isMobileDevice ? 180 : 420;

    // Touch pan/pinch state (iPad, iOS, Android)
    this._touchState = null; // null or { startTouches, startCenter, startZoom, startCenterLatLon, lastPinchDist, lastMidpoint }
    this._touchActive = false; // true while any touch is in progress (for skipping expensive ops)

    // Debounce tile-load redraws to avoid cascading redraws when multiple tiles load at once
    this._tileLoadRedrawTimer = null;
    // Snapshot of the last rendered basemap frame to avoid flicker while tiles load.
    this._tilesSnapshotCanvas = null; // offscreen canvas
    this._tilesSnapshotMeta = null; // { zoom, centerLat, centerLon }
    this._paFieldComputedView = null; // { zoom, centerLat, centerLon } — for gesture fast-path

    // Theme
    this.themeKey = "carto_dark_all";
    const t = TILE_THEMES[this.themeKey];
    this.tileTemplate = t.template;
    this.tileSubdomains = t.subdomains;
    this._tileEpoch = 1; // increments on theme swap; used to ignore late tile loads

    // Coalesce pinch-zoom redraws to rAF for smoother feel (no extra easing math).
    this._zoomDrawRAF = null;

    // Coalesce pan redraws to rAF (Safari trackpad wheel-pan can be very high frequency).
    this._panDrawRAF = null;

    // Minimal pinch-zoom inertia (only for trackpad pinch streams; does not affect pan).
    this._pinchInertiaRAF = null;
    this._pinchVz = 0; // zoom units per ms
    this._pinchVelTs = 0;
    this._pinchAnchorSX = null;
    this._pinchAnchorSY = null;
    this._wheelPinchEndTimer = null;
    this._pinchZooming = false;
    this._lastWheelPanTime = 0; // debounce pan→zoom from trackpad finger-lift artifacts
    this._wheelPanning = false; // true during trackpad/keyboard-trackpad wheel-pan streams
    this._wheelPanEndTimer = null; // debounce timer to exit wheel-pan mode
    this._scrubbing = false; // true during timeline scrub (slider/jog wheel drag)

    // Windows scroll-velocity accumulator for adaptive zoom
    this._winScrollAccum = 0;      // accumulated deltaY in current burst
    this._winScrollLastTs = 0;      // timestamp of last wheel event
    this._winScrollFlushTimer = null;

    // macOS scroll-velocity accumulator for adaptive zoom (mouse wheel only)
    this._macScrollAccum = 0;
    this._macScrollLastTs = 0;

    // ResizeObserver fires after layout settles — catches window resize, devtools
    // show/hide, and fullscreen toggle more reliably than window "resize".
    // Pass contentRect dimensions directly to avoid reading stale clientHeight:
    // -webkit-fill-available (used as a PWA fix on html/body) doesn't reflow
    // reliably in Chrome/Safari when devtools or the browser chrome changes size,
    // so parent.clientHeight can return the old value even after a layout pass.
    this._ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) this.resize(width, height);
      }
    });
    this._ro.observe(this.tilesCanvas.parentElement);

    // Any viewport change: fullscreen, window resize, display switch.
    // Bust the guard so the next resize applies the correct size.
    this._forceResize = () => {
      this._cssW = 0;
      this._cssH = 0;
      const parent = this.tilesCanvas.parentElement;
      if (parent) {
        this._ro.observe(parent);
        const w = parent.clientWidth;
        const h = parent.clientHeight;
        if (w > 0 && h > 0) this.resize(w, h);
      }
    };
    window.addEventListener("resize", () => this._forceResize());
    document.addEventListener("fullscreenchange", () => this._forceResize());
    document.addEventListener("webkitfullscreenchange", () => this._forceResize());
    document.addEventListener("visibilitychange", () => {
      this._backgrounded = document.visibilityState === "hidden";
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", () => this._forceResize());
    }
    // DPR change watcher (display switches).
    this._watchDpr = () => {
      const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      mq.addEventListener("change", () => {
        this._forceResize();
        this._watchDpr();
      }, { once: true });
    };
    this._watchDpr();

    this.overlayCanvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    // Safari (macOS) provides native trackpad pinch as gesture events.
    this.overlayCanvas.addEventListener("gesturestart", (e) => this.onGestureStart(e), { passive: false });
    this.overlayCanvas.addEventListener("gesturechange", (e) => this.onGestureChange(e), { passive: false });
    this.overlayCanvas.addEventListener("gestureend", (e) => this.onGestureEnd(e), { passive: false });
    this.overlayCanvas.addEventListener("click", (e) => this.onClick(e));
    this.overlayCanvas.addEventListener("mousedown", (e) => this.onMouseDown(e));
    window.addEventListener("mousemove", (e) => this.onMouseMove(e));
    window.addEventListener("mouseup", () => this.onMouseUp());
    // Touch events for iPad/iOS/Android pan and pinch-zoom
    this.overlayCanvas.addEventListener("touchstart", (e) => this.onTouchStart(e), { passive: false });
    this.overlayCanvas.addEventListener("touchmove", (e) => this.onTouchMove(e), { passive: false });
    this.overlayCanvas.addEventListener("touchend", (e) => this.onTouchEnd(e), { passive: false });
    this.overlayCanvas.addEventListener("touchcancel", (e) => this.onTouchEnd(e), { passive: false });

    this.resize();
  }

  _cancelCameraAnimations() {
    if (this._centerAnimRAF) {
      cancelAnimationFrame(this._centerAnimRAF);
      this._centerAnimRAF = null;
    }
    // Pinch-zoom inertia is NOT cancelled here.
  }

  _suppressAutoCamera({ cooldownMs } = {}) {
    const cd = (typeof cooldownMs === "number" && isFinite(cooldownMs)) ? cooldownMs : this._autoCameraCooldownMs;
    const until = performance.now() + Math.max(0, cd);
    if (!(until <= this._autoCameraSuppressedUntilPerfMs)) {
      this._autoCameraSuppressedUntilPerfMs = until;
    }
  }

  // Shorten (never extend) the auto-camera cooldown for high-AQI alerts.
  // Does NOT cancel animations, set _autoCameraCooldownMs, or affect Live mode.
  _overrideCooldownForAlert(cooldownMs) {
    const until = performance.now() + Math.max(0, cooldownMs);
    if (this._autoCameraSuppressedUntilPerfMs > until) {
      this._autoCameraSuppressedUntilPerfMs = until;
    }
  }

  _noteUserInteraction() {
    // User input wins: cancel in-flight camera animations and suppress new auto-fits.
    this._cancelCameraAnimations();
    this._autoCameraCooldownMs = 300000; // 5 minutes after any user interaction
    this._suppressAutoCamera();
    this._followSuppressUntilMs = performance.now() + 4000;
  }

  _isGesturing() {
    return this._touchActive || this._mouseDragging || this._pinchZooming || this._wheelPanning || this._scrubbing;
  }

  /** True during any camera movement: user gestures, inertia, easing, follow, orchestration. */
  _isAnimating() {
    return this._isGesturing() || !!this._centerAnimRAF || !!this._selectOrchRAF || !!this._followRAF;
  }

  /** Like _isAnimating but excludes the persistent follow loop.
   *  Used by PA field to allow recomputation after user gestures while following a vehicle. */
  _isTransientAnimating() {
    return this._isGesturing() || !!this._centerAnimRAF || !!this._selectOrchRAF;
  }

  _canRunAutoCamera() {
    const now = performance.now();
    if (this._touchActive || this._mouseDragging || this._pinchZooming) return false;
    if (this._followRAF) return false; // follow loop is running — it owns the camera
    return now >= (this._autoCameraSuppressedUntilPerfMs || 0);
  }

  _dataNowMs() {
    const baseMs = this._dataNowBaseMs;
    const basePerf = this._dataNowBasePerfMs;
    if (baseMs != null && isFinite(baseMs) && basePerf != null && isFinite(basePerf)) {
      return Number(baseMs) + Math.max(0, performance.now() - Number(basePerf));
    }
    return Date.now();
  }

  _invalidateOverlayStatic() {
    this._overlayStaticDirty = true;
  }

  _invalidatePaField() {
    this._paFieldKey = "";
    this._paFieldValidRange = null;
    this._preWarmScanValidUntilMs = null;
  }

  setMaxTrailLen(val) {
    const n = Number(val);
    if (!isFinite(n) || n < 2) return;
    if (this.maxTrailLen === n) return;
    this.maxTrailLen = n;

    // Prune existing trails immediately
    let changed = false;
    for (const [id, data] of this._persistedTrailById.entries()) {
      if (data.trail.length > n) {
        data.trail = data.trail.slice(-n);
        changed = true;
      }
    }
    if (changed) {
      this._persistedTrailRev++;
      this._invalidateOverlayStatic();
    }
  }

  _stopPinchInertia() {
    if (this._pinchInertiaRAF) cancelAnimationFrame(this._pinchInertiaRAF);
    this._pinchInertiaRAF = null;
    this._wheelPinchEndTimer = null;
    if (this._pinchZoomEndTimer) { window.clearTimeout(this._pinchZoomEndTimer); this._pinchZoomEndTimer = null; }
    this._pinchVz = 0;
    this._pinchVelTs = 0;
  }

  _notePinchVelocity(dz, now) {
    const t = (typeof now === "number" && isFinite(now)) ? now : performance.now();
    const dt = (this._pinchVelTs > 0) ? (t - this._pinchVelTs) : 0;
    if (dt > 4 && dt < 120) {
      // Simple EMA-ish blend; keep it tiny and stable.
      const v = dz / dt;
      this._pinchVz = (this._pinchVz * 0.65) + (v * 0.35);
    }
    this._pinchVelTs = t;
  }

  _startPinchInertia() {
    // Only continue if we have meaningful velocity and an anchor.
    if (!isFinite(this._pinchVz) || Math.abs(this._pinchVz) < 0.00005 || !isFinite(this._pinchAnchorSX) || !isFinite(this._pinchAnchorSY)) {
      // No coast. Keep _pinchZooming alive briefly so the expensive PA field
      // path doesn't fire in the gap before the next wheel event arrives.
      // If no event arrives within 80ms, then truly end pinch mode.
      if (!this._pinchZoomEndTimer) {
        this._pinchZoomEndTimer = window.setTimeout(() => {
          this._pinchZoomEndTimer = null;
          this._pinchZooming = false;
          this._requestZoomRedraw();
        }, 80);
      }
      return;
    }

    let last = performance.now();
    const step = () => {
      const now = performance.now();
      const dt = now - last;
      last = now;

      // Apply velocity, then decay it quickly (feels like native trackpad momentum).
      const z2 = clamp(this.zoom + this._pinchVz * dt, this._zoomMin, this._zoomMax);
      this._setZoomAroundScreenPoint(z2, this._pinchAnchorSX, this._pinchAnchorSY);
      // Keep tile snapshot alive so drawTiles fast-path (scale + return) fires.
      // The snapshot is recaptured with real tiles once inertia ends.
      this._requestZoomRedraw();
      this._notifyViewChanged();

      this._pinchVz *= 0.90; // fast decay; keep minimal math
      if (Math.abs(this._pinchVz) < 0.00005 || z2 === this._zoomMin || z2 === this._zoomMax) {
        this._pinchInertiaRAF = null;
        this._pinchZooming = false;
        this._requestZoomRedraw(); // redraw with real tiles at final zoom
        return;
      }
      this._pinchInertiaRAF = requestAnimationFrame(step);
    };
    // Kick the first step immediately to avoid a perceptible "stutter" before inertia begins.
    last = performance.now() - 16;
    step();
  }

  _requestZoomRedraw() {
    if (this._zoomDrawRAF) return;
    this._zoomDrawRAF = requestAnimationFrame(() => {
      this._zoomDrawRAF = null;
      this.draw(this.lastState);
    });
  }

  _redrawViewOnly() {
    // Redraw basemap + overlay for view changes (center/zoom/theme/size) without
    // reprocessing state-derived caches. Used to throttle high-frequency pan events.
    const state = this.lastState;
    if (!state) return;

    const viewSig = (() => {
      const z = Number(this.zoom);
      const lat = Number(this.center?.lat);
      const lon = Number(this.center?.lon);
      const w = Number(this._cssW);
      const h = Number(this._cssH);
      const dpr = Number(this._dpr || (window.devicePixelRatio || 1));
      const r = (x, p = 1e6) => (isFinite(x) ? (Math.round(x * p) / p) : x);
      return `${this.themeKey}|${r(z, 1e3)}|${r(lat)}|${r(lon)}|${w}x${h}|dpr:${r(dpr, 1e3)}|pinch:${this._pinchZooming ? 1 : 0}`;
    })();

    let tilesRedrawn = false;
    if (this._lastTilesViewSig !== viewSig) {
      this._lastTilesViewSig = viewSig;
      this.drawTiles();
      tilesRedrawn = true;
    }
    // PA scalar field: above tiles, below trails/markers. Composite onto tiles canvas.
    this._compositePaFieldOnTiles(state, tilesRedrawn);
    this.drawOverlay(state, { cacheUnderlay: true });
  }

  _requestPanRedraw() {
    if (this._panDrawRAF) return;
    this._panDrawRAF = requestAnimationFrame(() => {
      this._panDrawRAF = null;
      this._redrawViewOnly();
      this._notifyViewChanged();
    });
  }

  _notifyViewChanged() {
    try {
      if (typeof window.__onMapViewChanged === "function") window.__onMapViewChanged();
    } catch {
      // ignore
    }
  }

  _eventToLocalXY(e) {
    const rect = this.overlayCanvas.getBoundingClientRect();
    const cx = (typeof e.clientX === "number") ? e.clientX : (rect.left + rect.width / 2);
    const cy = (typeof e.clientY === "number") ? e.clientY : (rect.top + rect.height / 2);
    return { sx: cx - rect.left, sy: cy - rect.top };
  }

  onGestureStart(e) {
    // Safari-only; prevent page zoom and handle pinch natively.
    e.preventDefault();
    e.stopPropagation();
    this._noteUserInteraction();
    this._stopPinchInertia();
    this._pinchZooming = true;
    const { sx, sy } = this._eventToLocalXY(e);
    const ll = this._screenPointToLatLon(sx, sy);
    this._gesture = {
      startZoom: this.zoom,
      startScale: (typeof e.scale === "number" && isFinite(e.scale) && e.scale > 0) ? e.scale : 1,
      anchorLat: ll.lat,
      anchorLon: ll.lon,
      sx,
      sy,
    };
    this._pinchAnchorSX = sx;
    this._pinchAnchorSY = sy;
  }

  onGestureChange(e) {
    if (!this._gesture) return;
    e.preventDefault();
    e.stopPropagation();
    this._noteUserInteraction();
    this._pinchZooming = true;
    const { sx, sy } = this._eventToLocalXY(e);
    // Update anchor screen point as the gesture midpoint moves.
    this._gesture.sx = sx;
    this._gesture.sy = sy;

    const scale = (typeof e.scale === "number" && isFinite(e.scale) && e.scale > 0) ? e.scale : 1;
    const ratio = Math.max(0.2, Math.min(5, scale / (this._gesture.startScale || 1)));
    const dz = Math.log2(ratio);
    const z2 = clamp(this._gesture.startZoom + dz, this._zoomMin, this._zoomMax);
    const prevZ = this.zoom;
    this._setZoomAroundScreenPoint(z2, sx, sy);
    this._requestZoomRedraw();
    this._notifyViewChanged();
    this._pinchAnchorSX = sx;
    this._pinchAnchorSY = sy;
    this._notePinchVelocity(z2 - prevZ, performance.now());
  }

  onGestureEnd(e) {
    if (!this._gesture) return;
    e.preventDefault();
    e.stopPropagation();
    this._gesture = null;
    this._startPinchInertia();
  }

  // Touch event handlers for iPad/iOS/Android pan and pinch-zoom
  onTouchStart(e) {
    // Prevent browser's default behavior (page scroll, zoom)
    e.preventDefault();
    
    // Mark touch as active to skip expensive operations during interaction
    this._touchActive = true;

    this._noteUserInteraction();
    
    // Cancel any in-progress pinch inertia
    this._stopPinchInertia();
    
    const touches = e.touches;
    if (touches.length === 0) return;

    const rect = this.overlayCanvas.getBoundingClientRect();
    
    // Compute touch midpoint in canvas-local coordinates
    let sumX = 0, sumY = 0;
    for (let i = 0; i < touches.length; i++) {
      sumX += touches[i].clientX - rect.left;
      sumY += touches[i].clientY - rect.top;
    }
    const midX = sumX / touches.length;
    const midY = sumY / touches.length;

    // Dead zone: ignore pinch-zoom attempts where any finger starts in the
    // bottom 130px of the canvas (playback bar area).  Single-finger pans are
    // still allowed so the user can swipe-to-jog on the edge of the bar.
    if (touches.length >= 2) {
      const canvasH = rect.height;
      const deadZonePx = 130;
      for (let i = 0; i < touches.length; i++) {
        const ty = touches[i].clientY - rect.top;
        if (ty > canvasH - deadZonePx) {
          // Finger is in the dead zone — abort pinch-zoom entirely
          this._touchActive = false;
          return;
        }
      }
    }

    // For pinch: compute initial distance
    let pinchDist = 0;
    if (touches.length >= 2) {
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      pinchDist = Math.sqrt(dx * dx + dy * dy);
      this._pinchZooming = true;
    }

    // Store initial touch state
    const cw = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
    this._touchState = {
      startTouches: touches.length,
      startMidpoint: { x: midX, y: midY },
      startCenterWorld: { x: cw.x, y: cw.y, ws: cw.ws },
      startZoom: this.zoom,
      lastPinchDist: pinchDist,
      lastMidpoint: { x: midX, y: midY },
      // Track for tap detection (single touch, minimal movement)
      tapCandidate: touches.length === 1,
      tapStartTime: performance.now(),
      tapStartPos: { x: midX, y: midY },
    };
    
    // Store anchor for inertia
    this._pinchAnchorSX = midX;
    this._pinchAnchorSY = midY;
    
  }

  onTouchMove(e) {
    if (!this._touchState) return;
    e.preventDefault();

    this._noteUserInteraction();

    const touches = e.touches;
    if (touches.length === 0) return;

    const rect = this.overlayCanvas.getBoundingClientRect();

    // Compute current touch midpoint
    let sumX = 0, sumY = 0;
    for (let i = 0; i < touches.length; i++) {
      sumX += touches[i].clientX - rect.left;
      sumY += touches[i].clientY - rect.top;
    }
    const midX = sumX / touches.length;
    const midY = sumY / touches.length;

    // Pinch-zoom if 2+ fingers.
    // Skip when Safari gesture events are active (_gesture set by onGestureStart) —
    // on iPad both gesture and touch events fire for the same pinch, and the two
    // zoom computations (absolute vs incremental) fight each other.
    if (touches.length >= 2 && !this._gesture) {
      this._pinchZooming = true;
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      const pinchDist = Math.sqrt(dx * dx + dy * dy);

      if (this._touchState.lastPinchDist > 0 && pinchDist > 0) {
        const scale = pinchDist / this._touchState.lastPinchDist;
        const dz = Math.log2(scale);
        const prevZ = this.zoom;
        const z2 = clamp(this.zoom + dz, this._zoomMin, this._zoomMax);
        this._setZoomAroundScreenPoint(z2, midX, midY);
        this._notePinchVelocity(z2 - prevZ, performance.now());
      }
      this._touchState.lastPinchDist = pinchDist;
    }

    // Pan: translate based on midpoint delta from last frame
    const dmx = midX - this._touchState.lastMidpoint.x;
    const dmy = midY - this._touchState.lastMidpoint.y;

    if (Math.abs(dmx) > 0.5 || Math.abs(dmy) > 0.5) {
      const c = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
      const nx = c.x - dmx;
      const ny = clamp(c.y - dmy, 0, c.ws - 1);
      const ll = worldToLatLon(nx, ny, this.zoom);
      this.center = { lat: ll.lat, lon: ll.lon };
    }

    // Invalidate tap if moved too far from start (use 25px threshold for iOS finger drift)
    if (this._touchState.tapCandidate && this._touchState.tapStartPos) {
      const tdx = midX - this._touchState.tapStartPos.x;
      const tdy = midY - this._touchState.tapStartPos.y;
      if (Math.abs(tdx) > 25 || Math.abs(tdy) > 25) {
        this._touchState.tapCandidate = false;
      }
    }

    this._touchState.lastMidpoint = { x: midX, y: midY };
    this._pinchAnchorSX = midX;
    this._pinchAnchorSY = midY;

    // Use lightweight redraw during touch - just reposition existing content
    this._requestPanRedraw();
  }

  onTouchEnd(e) {
    if (!this._touchState) return;
    e.preventDefault();

    const remaining = e.touches.length;

    if (remaining === 0) {
      // Check for tap gesture before clearing state
      const wasTap = this._touchState.tapCandidate &&
        this._touchState.startTouches === 1 &&
        (performance.now() - this._touchState.tapStartTime) < 300;
      const tapPos = this._touchState.tapStartPos;

      // Mark touch as ended
      this._touchActive = false;
      // Flush any tile redraws that were deferred during touch
      if (this._tileRedrawPending) {
        this._tileRedrawPending = false;
        this._scheduleTileRedraw();
      }
      // All fingers lifted - start inertia if we were pinching.
      // Guard: on iOS Safari, gestureEnd fires before touchEnd for the same
      // pinch release, so _startPinchInertia() may already be running.
      // Starting a second chain corrupts shared state (snapshot, velocity)
      // and causes blown-out PA field alpha.
      if (this._pinchZooming && !this._pinchInertiaRAF) {
        this._startPinchInertia();
      } else if (!this._pinchZooming) {
        // No pinch inertia - do a full redraw now
        this._requestZoomRedraw();
      }

      // Handle tap for marker selection
      if (wasTap && tapPos) {
        this._handleTapSelection(tapPos.x, tapPos.y);
      }

      this._touchState = null;
    } else if (remaining === 1 && this._touchState.startTouches >= 2) {
      // Went from 2+ fingers to 1 - reset pan origin to avoid jump
      const rect = this.overlayCanvas.getBoundingClientRect();
      const t = e.touches[0];
      const mx = t.clientX - rect.left;
      const my = t.clientY - rect.top;
      this._touchState.lastMidpoint = { x: mx, y: my };
      this._touchState.lastPinchDist = 0;
      this._touchState.startTouches = 1;
      this._pinchZooming = false;
      // End zoom inertia; continue panning only
      this._stopPinchInertia();
      this._requestZoomRedraw();
    }
  }

  setTheme(themeKey) {
    const k = String(themeKey || "");
    const t = TILE_THEMES[k] || TILE_THEMES["carto_dark_all"];
    this.themeKey = TILE_THEMES[k] ? k : "carto_dark_all";
    this.tileTemplate = t.template;
    this.tileSubdomains = t.subdomains;
    this._tileEpoch++;
    this.tileCache.clear();
    // snapshot invalid across theme swaps
    this._tilesSnapshotCanvas = null;
    this._tilesSnapshotMeta = null;
    // Force drawTiles() inside draw(): cache/epoch were invalidated, so even if
    // center/zoom/theme-key haven't changed the old tiles are gone and we must
    // start new requests at the current epoch.
    this._lastTilesViewSig = null;
    this.draw(this.lastState);
  }

  onMouseDown(e) {
    // Click-drag pan (mouse). Trackpad two-finger pan is still wheel-based.
    if (e.button !== 0) return;

    // DVR: drag a marker to scrub playback time along its path.
    // NOTE: Click-to-drag marker scrubbing is temporarily disabled.
    /*
    if (this.playbackMode) {
      const nowMs = performance.now();
      const hit = this._hitTestMobileAtClientXY(e.clientX, e.clientY, nowMs);
      if (hit && hit.id != null) {
        try { e.preventDefault(); e.stopPropagation(); } catch {}
        const id = String(hit.id);
        const wasPlaying = this.getPlaybackPlaying();
        // Stop playback while manipulating (like a DVR scrub).
        this.setPlaybackPlaying(false);

        // Cancel any existing inertia glide when a new interaction begins.
        this._pbInertia2d = null;

        // Bring the interacted marker to the top of the draw stack immediately.
        // (Do not call __selectSensor here; that may trigger camera orchestration.)
        try {
          const k = keyFor("mobile", id);
          if (this.selectedId !== k) this.selectedId = k;
        } catch {}

        this._pbDrag = {
          id,
          startedAtMs: nowMs,
          lastClient: { x: e.clientX, y: e.clientY },
          cursorClient: { x: e.clientX, y: e.clientY },
          lastMoveMs: nowMs,
          vel: { x: 0, y: 0 },
          wasPlaying,
        };

        // Immediately scrub to the closest point under the cursor.
        try { this._scrubPlaybackTimeForMobileAtClientXY(hit, e.clientX, e.clientY); } catch {}

        // Treat as a drag so onClick does not toggle selection.
        this._mouseDragMoved = false;
        this.drawOverlay(this.lastState);
        return;
      }
    }
    */

    this._noteUserInteraction();
    this._stopPinchInertia();
    this._pinchZooming = false;
    this._mouseDragging = true;
    this._mouseDragMoved = false;
    this._mouseDragStart = { x: e.clientX, y: e.clientY };
    const cw = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
    this._mouseDragCenterStart = { x: cw.x, y: cw.y, ws: cw.ws };
  }

  onMouseMove(e) {
    if (this._pbDrag && this.playbackMode) {
      const nowMs = performance.now();
      const dx = e.clientX - (this._pbDrag.lastClient?.x ?? e.clientX);
      const dy = e.clientY - (this._pbDrag.lastClient?.y ?? e.clientY);
      if (Math.abs(dx) + Math.abs(dy) > 2) this._mouseDragMoved = true;

      // Track drag velocity for inertial glide on release.
      const lastMoveMs = (this._pbDrag.lastMoveMs != null && isFinite(this._pbDrag.lastMoveMs)) ? this._pbDrag.lastMoveMs : nowMs;
      const dtMs = Math.max(1, nowMs - lastMoveMs);
      const vx = dx / dtMs;
      const vy = dy / dtMs;
      const prevV = this._pbDrag.vel || { x: 0, y: 0 };
      // Low-pass filter: stable velocity estimate without jitter.
      const a = 0.25;
      this._pbDrag.vel = {
        x: prevV.x * (1 - a) + vx * a,
        y: prevV.y * (1 - a) + vy * a,
      };
      this._pbDrag.lastMoveMs = nowMs;

      this._pbDrag.lastClient = { x: e.clientX, y: e.clientY };
      this._pbDrag.cursorClient = { x: e.clientX, y: e.clientY };
      const st = this.lastState;
      const mobiles = st && Array.isArray(st.mobile) ? st.mobile : [];
      const m = mobiles.find(mm => (mm && mm.id != null && String(mm.id) === String(this._pbDrag.id))) || null;
      if (m) {
        // Always scrub time to the closest point on the path (no distance gating).
        const closest = this._closestPlaybackPathPointForMobileAtClientXY(m, e.clientX, e.clientY);
        if (closest && isFinite(closest.tMs)) {
          const bounds = this.getPlaybackBounds();
          const tMs = closest.tMs;
          if (isFinite(bounds.minMs) && isFinite(bounds.maxMs)) {
            const clamped = clamp(tMs, bounds.minMs, bounds.maxMs);
            this.setPlaybackTimeMs(clamped);
            // User interaction exits LIVE mode (they're manually controlling)
            this._playbackLiveFollow = false;
            if (typeof this._resetLiveTracking === "function") this._resetLiveTracking();
          } else {
            this.setPlaybackTimeMs(tMs);
            this._playbackLiveFollow = false;
            if (typeof this._resetLiveTracking === "function") this._resetLiveTracking();
          }
        }
        this.drawOverlay(this.lastState);
      }
      return;
    }
    if (!this._mouseDragging || !this._mouseDragStart || !this._mouseDragCenterStart) {
      // Hover hit-test for mobile/fixed (non-PurpleAir) marker labels
      this._updateHoverAtClientXY(e.clientX, e.clientY);
      return;
    }
    this._noteUserInteraction();
    const dx = e.clientX - this._mouseDragStart.x;
    const dy = e.clientY - this._mouseDragStart.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) this._mouseDragMoved = true;

    const centerX = this._mouseDragCenterStart.x - dx;
    const centerY = clamp(this._mouseDragCenterStart.y - dy, 0, this._mouseDragCenterStart.ws - 1);
    const ll = worldToLatLon(centerX, centerY, this.zoom);
    this.center = { lat: ll.lat, lon: ll.lon };
    // If zoom inertia is running, its RAF already calls draw() which reads this.center —
    // no separate pan redraw needed (avoids two full draws fighting per frame).
    if (!this._pinchInertiaRAF) this._requestPanRedraw();
  }

  onMouseUp() {
    if (this._pbDrag) {
      const drag = this._pbDrag;
      this._pbDrag = null;

      // Start a short inertial glide for the interacted marker.
      // This continues scrubbing the global time for *all* markers.
      try { this._startPbMarkerInertiaFromDrag(drag); } catch {}

      // User request: always resume playback for all after interacting.
      this.setPlaybackPlaying(true);
      if (typeof window.__ensurePlaybackLoop === "function") window.__ensurePlaybackLoop();
      return;
    }
    this._mouseDragging = false;
    this._mouseDragStart = null;
    this._mouseDragCenterStart = null;
    this._redrawViewOnly();
    // click behavior is handled in onClick; we just stop dragging here.
  }

  _getOverlayPaddingPx() {
    // Side-specific padding based on overlay panels that obscure the map.
    // This prevents “fit bounds” from centering under the left/right panels.
    const mapRect = this.overlayCanvas.getBoundingClientRect();
    const pad = { left: 24, right: 24, top: 24, bottom: 24 };
    const ids = ["sidebar", "details"];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const left = Math.max(mapRect.left, r.left);
      const right = Math.min(mapRect.right, r.right);
      const top = Math.max(mapRect.top, r.top);
      const bottom = Math.min(mapRect.bottom, r.bottom);
      if (right <= left || bottom <= top) continue;
      if (r.left <= mapRect.left + 40) {
        pad.left = Math.max(pad.left, right - mapRect.left + 14);
      } else if (r.right >= mapRect.right - 40) {
        pad.right = Math.max(pad.right, mapRect.right - left + 14);
      }
    }
    return pad;
  }

  _animateTo({ centerLat, centerLon, zoom }, { durationMs = 420, isAutoCamera = false } = {}) {
    const lat0 = this.center.lat;
    const lon0 = this.center.lon;
    const z0 = this.zoom;
    const lat1 = Number(centerLat);
    const lon1 = Number(centerLon);
    const z1 = clamp(Number(zoom), this._zoomMin || 1, this._zoomMax || 20);
    if (!isFinite(lat1) || !isFinite(lon1) || !isFinite(z1)) return;
    if (!isFinite(lat0) || !isFinite(lon0) || !isFinite(z0)) return;

    const t0 = performance.now();
    // Only used for auto-centering / fit-to-bounds. Keep it snappy.
    const dur = Math.max(120, durationMs);

    if (this._centerAnimRAF) cancelAnimationFrame(this._centerAnimRAF);

    // Track whether this animation is auto-camera so that view-change
    // listeners (e.g. localStorage persistence) can ignore it.
    this._isAutoCameraAnimating = isAutoCamera;

    const zoomChanging = Math.abs(z1 - z0) > 1e-6;

    // Safety: limit animation frames to prevent runaway loops
    let frameCount = 0;
    const maxFrames = Math.ceil(dur / 8) + 60;

    const finish = () => {
      this._centerAnimRAF = null;
      // Keep _isAutoCameraAnimating true through the final draw + notify so that
      // view-change listeners (e.g. localStorage persistence) don't overwrite the
      // user's manually-chosen view with the auto-camera destination.
      this.draw(this.lastState);
      this._notifyViewChanged();
      this._isAutoCameraAnimating = false;
      // After the first auto-camera animation, extend cooldown to 5 minutes
      // so subsequent user interactions suppress auto-camera for much longer.
      if (isAutoCamera) this._autoCameraCooldownMs = 300000;
    };

    const step = () => {
      frameCount++;
      if (frameCount > maxFrames) {
        console.warn('_animateTo: exceeded max frames, forcing completion');
        this.zoom = z1;
        this.center = { lat: lat1, lon: lon1 };
        finish();
        return;
      }

      const t = clamp((performance.now() - t0) / dur, 0, 1);
      // smoothstep ease-in-out: zoom and pan arrive together, no swoop
      const ease = t * t * (3 - 2 * t);
      this.zoom = z0 + (z1 - z0) * ease;
      this.center = { lat: lat0 + (lat1 - lat0) * ease, lon: lon0 + (lon1 - lon0) * ease };
      if (zoomChanging) {
        // Zoom is changing — need full redraw for correct scale
        this.draw(this.lastState);
      } else {
        // Pan-only — use fast snapshot translate path
        this._redrawViewOnly();
      }
      this._notifyViewChanged();
      if (t < 1) {
        this._centerAnimRAF = requestAnimationFrame(step);
      } else {
        finish();
      }
    };
    this._centerAnimRAF = requestAnimationFrame(step);
  }

  fitTrailBounds(trailPoints, { animate = true } = {}) {
    const pts = Array.isArray(trailPoints) ? trailPoints : [];
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    let count = 0;
    for (const p of pts) {
      const lat = Number(p.lat);
      const lon = Number(p.lon);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
      count++;
    }
    if (count === 0) return;
    this.fitBoundsLatLon({ minLat, minLon, maxLat, maxLon }, { animate });
  }

  fitBoundsLatLon({ minLat, minLon, maxLat, maxLon }, { animate = true } = {}) {
    // Compute zoom to fit bbox using WebMercator at z=0.
    const w0 = 256;
    const xMin0 = lonToX(minLon, w0);
    const xMax0 = lonToX(maxLon, w0);
    const yMin0 = latToY(maxLat, w0);
    const yMax0 = latToY(minLat, w0);
    const dx0 = Math.max(1e-6, Math.abs(xMax0 - xMin0));
    const dy0 = Math.max(1e-6, Math.abs(yMax0 - yMin0));

    const rect = this.overlayCanvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const pad = this._getOverlayPaddingPx();
    const availW = Math.max(40, w - pad.left - pad.right);
    const availH = Math.max(40, h - pad.top - pad.bottom);

    const scale = Math.min(availW / dx0, availH / dy0);
    let z = Math.log2(scale);
    // padding / breathing room
    z -= 0.18;
    z = clamp(z, this._zoomMin, this._zoomMax);

    // Center of bbox in world coords at z=0, then convert to lat/lon
    const cx0 = (xMin0 + xMax0) / 2;
    const cy0 = (yMin0 + yMax0) / 2;
    const center0 = worldToLatLon(cx0, cy0, 0);

    // Target screen center in the unobscured map area
    const targetScreenX = pad.left + availW / 2;
    const targetScreenY = pad.top + availH / 2;

    // Convert center0 to world at target zoom, then choose map center so center0 appears at targetScreen.
    const cWorld = latLonToWorld(center0.lat, center0.lon, z);
    const centerWorldX = cWorld.x - (targetScreenX - w / 2);
    const centerWorldY = cWorld.y - (targetScreenY - h / 2);
    const centerLL = worldToLatLon(centerWorldX, clamp(centerWorldY, 0, cWorld.ws - 1), z);

    if (animate) {
      this._animateTo({ centerLat: centerLL.lat, centerLon: centerLL.lon, zoom: z }, { durationMs: 320 });
    } else {
      this.center = { lat: centerLL.lat, lon: centerLL.lon };
      this.zoom = z;
      this.draw(this.lastState);
    }
  }

  _screenPointToLatLon(sx, sy) {
    const rect = this.tilesCanvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const c = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
    const wx = c.x - w / 2 + sx;
    const wy = c.y - h / 2 + sy;
    const clampedY = clamp(wy, 0, c.ws - 1);
    return worldToLatLon(wx, clampedY, this.zoom);
  }

  _setZoomAroundScreenPoint(newZoom, sx, sy) {
    const rect = this.tilesCanvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const z2 = clamp(newZoom, this._zoomMin, this._zoomMax);

    // Lat/Lon under cursor at current zoom
    const ll = this._screenPointToLatLon(sx, sy);

    // World point at new zoom
    const wpt2 = latLonToWorld(ll.lat, ll.lon, z2);
    const centerWorld2 = {
      x: wpt2.x - (sx - w / 2),
      y: wpt2.y - (sy - h / 2),
      ws: wpt2.ws,
    };
    const centerLL2 = worldToLatLon(centerWorld2.x, clamp(centerWorld2.y, 0, wpt2.ws - 1), z2);

    this.zoom = z2;
    this.center = { lat: centerLL2.lat, lon: centerLL2.lon };
  }

  centerOn(lat, lon, { animate = true } = {}) {
    const latN = Number(lat), lonN = Number(lon);
    if (!isFinite(latN) || !isFinite(lonN)) return;

    if (!animate) {
      this.center = { lat: latN, lon: lonN };
      this.draw(this.lastState);
      return;
    }

    // Animate center only (keep zoom)
    this._animateTo({ centerLat: latN, centerLon: lonN, zoom: this.zoom }, { durationMs: 220 });
  }

  cancelSelectionOrchestration() {
    if (this._selectOrchRAF) cancelAnimationFrame(this._selectOrchRAF);
    this._selectOrchRAF = null;
    this._selectOrch = null;
    // Do not clear all warps; only clear the currently-selected one if we know it.
    // (Leaving others would be harmless but is confusing.)
    // Clear any expired warps opportunistically.
    const nowMs = performance.now();
    for (const [id, w] of this._traceSelectionWarpById.entries()) {
      const t = nowMs - Number(w?.t0Ms);
      const dur = Number(w?.durationMs);
      if (!isFinite(t) || !isFinite(dur) || t >= dur) this._traceSelectionWarpById.delete(id);
    }
  }

  _latLonComfortablyInView(lat, lon) {
    const latN = Number(lat);
    const lonN = Number(lon);
    if (!isFinite(latN) || !isFinite(lonN)) return false;
    const w = this._cssW || 1;
    const h = this._cssH || 1;
    const centerW = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
    const tgtW = latLonToWorld(latN, lonN, this.zoom);
    const sx = tgtW.x - centerW.x + w / 2;
    const sy = tgtW.y - centerW.y + h / 2;
    // Comfortable inset region to avoid constant micro-panning.
    const mx = w * 0.22;
    const my = h * 0.22;
    return (sx >= mx && sx <= (w - mx) && sy >= my && sy <= (h - my));
  }

  _computeFocusedCenterFor(lat, lon) {
    // If the point is already well within the view, keep the current center.
    if (this._latLonComfortablyInView(lat, lon)) return { lat: this.center.lat, lon: this.center.lon, needsMove: false };

    const latN = Number(lat);
    const lonN = Number(lon);
    const w = this._cssW || 1;
    const h = this._cssH || 1;
    const centerW = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
    const tgtW = latLonToWorld(latN, lonN, this.zoom);
    const dx = (tgtW.x - centerW.x);
    const dy = (tgtW.y - centerW.y);

    // How far off-center is it (in screen space)?
    // Convert world delta to screen delta directly (1 world unit == 1 pixel at current zoom).
    const nx = Math.max(Math.abs(dx) / Math.max(1, w / 2), Math.abs(dy) / Math.max(1, h / 2));
    // Partial nudge when only slightly off; full center when far.
    const strength = (nx > 0.85) ? 1.0 : 0.72;
    const desiredCenterW = {
      x: centerW.x + dx * strength,
      y: centerW.y + dy * strength,
      ws: centerW.ws,
    };
    const ll = worldToLatLon(desiredCenterW.x, clamp(desiredCenterW.y, 0, centerW.ws - 1), this.zoom);
    return { lat: ll.lat, lon: ll.lon, needsMove: true };
  }

  orchestrateSelectionToLatest(mobile, { fitTrail = false } = {}) {
    if (!mobile || !mobile.id) return;
    if (fitTrail) return; // handled by fitTrailBounds at call site
    if (this.playbackMode) return;

    const id = String(mobile.id);
    const homeLat = Number(mobile.lat);
    const homeLon = Number(mobile.lon);
    if (!isFinite(homeLat) || !isFinite(homeLon)) return;

    // Cancel any previous orchestration.
    this.cancelSelectionOrchestration();

    const nowMs = performance.now();
    const focus = this._computeFocusedCenterFor(homeLat, homeLon);

    // If trace mode is active, and the replay marker is far from the latest point,
    // fade-out → invisible warp → fade-in at the latest point.
    let needsWarp = false;
    let fromLat = homeLat;
    let fromLon = homeLon;
    if (this.traceMode && this._traceActiveRouteById.has(id)) {
      const smp = this._traceSampleForMobile(mobile, nowMs);
      if (smp && isFinite(smp.lat) && isFinite(smp.lon)) {
        fromLat = smp.lat;
        fromLon = smp.lon;
        const d = haversineMeters(fromLat, fromLon, homeLat, homeLon);
        needsWarp = isFinite(d) && d > 25;
      }
    }

    // Orchestration timings (ms)
    const fadeMs = 500;
    const warpDurMs = needsWarp ? 1400 : 0;
    const camDelayMs = needsWarp ? fadeMs : 0;
    const camDurMs = focus.needsMove ? (needsWarp ? 420 : 320) : 0;

    if (needsWarp) {
      this._traceSelectionWarpById.set(id, {
        t0Ms: nowMs,
        fromLat,
        fromLon,
        homeLat,
        homeLon,
        fadeMs,
        durationMs: warpDurMs,
      });
    }

    this._selectOrch = {
      id,
      t0Ms: nowMs,
      homeLat,
      homeLon,
      camTo: { lat: focus.lat, lon: focus.lon },
      camFrom: null,
      camDelayMs,
      camDurMs,
      warpDurMs,
    };

    const step = () => {
      this._selectOrchRAF = null;
      const o = this._selectOrch;
      if (!o || o.id !== id) return;

      const t = performance.now() - o.t0Ms;
      const camStart = o.camDelayMs;
      const camEnd = o.camDelayMs + o.camDurMs;
      if (o.camDurMs > 0 && t >= camStart && t <= camEnd) {
        if (!o.camFrom) o.camFrom = { lat: this.center.lat, lon: this.center.lon };
        const u = clamp((t - camStart) / Math.max(1, o.camDurMs), 0, 1);
        const ease = 1 - Math.pow(1 - u, 3);
        const lat = o.camFrom.lat + (o.camTo.lat - o.camFrom.lat) * ease;
        const lon = o.camFrom.lon + (o.camTo.lon - o.camFrom.lon) * ease;
        this.center = { lat, lon };
        this._invalidateOverlayStatic();
        this.draw(this.lastState);
        this._notifyViewChanged();
      } else if (o.camDurMs > 0 && t > camEnd && o.camFrom) {
        // Snap to final to avoid a tiny drift.
        this.center = { lat: o.camTo.lat, lon: o.camTo.lon };
        o.camDurMs = 0;
        this._invalidateOverlayStatic();
        this.draw(this.lastState);
        this._notifyViewChanged();
      }

      const doneAt = Math.max(o.warpDurMs || 0, (o.camDelayMs || 0) + (o.camDurMs || 0));
      if (t < doneAt) {
        this._selectOrchRAF = requestAnimationFrame(step);
      } else {
        this._selectOrch = null;
      }
    };

    // Kick a RAF even if camera doesn't move; this keeps ordering consistent.
    this._selectOrchRAF = requestAnimationFrame(step);
  }

  setSelected(id) {
    // Called frequently from the polling loop; must be idempotent to avoid
    // redrawing the whole overlay every poll when selection hasn't changed.
    const next = id || null;
    if (this.selectedId === next) return;
    this.selectedId = next;
    if (!next) this._selectedPollutantKey = null;
    if (!next) this._selectedNaturalPollutantKey = null;
    if (!next) this._selectedPollutantValue = null;
    this._followSuppressUntilMs = 0;
    this._invalidateOverlayStatic();
    this.drawOverlay(this.lastState);
  }

  /** Returns the pollutant key currently displayed on the selected marker (e.g. "PM25", "PM10", "OZNE"). */
  getSelectedPollutantKey() {
    return this._selectedPollutantKey || null;
  }

  getSelectedNaturalPollutantKey() {
    return this._selectedNaturalPollutantKey || null;
  }

  getSelectedPollutantValue() {
    return this._selectedPollutantValue ?? null;
  }

  /** Return lat/lon bounds of the viewport with _OVERFETCH buffer.
   *  Returns { minLat, maxLat, minLon, maxLon } or null if not sized. */
  getBufferedBounds() {
    const w = this._cssW || 0;
    const h = this._cssH || 0;
    if (w < 2 || h < 2) return null;
    const cw = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
    const bw = w * _OVERFETCH / 2;
    const bh = h * _OVERFETCH / 2;
    const tl = worldToLatLon(cw.x - bw, cw.y - bh, this.zoom);
    const br = worldToLatLon(cw.x + bw, cw.y + bh, this.zoom);
    return {
      minLat: Math.min(tl.lat, br.lat),
      maxLat: Math.max(tl.lat, br.lat),
      minLon: Math.min(tl.lon, br.lon),
      maxLon: Math.max(tl.lon, br.lon),
    };
  }

  /** Return lat/lon bounds of the visible viewport (no buffer). */
  getViewportBounds() {
    const w = this._cssW || 0;
    const h = this._cssH || 0;
    if (w < 2 || h < 2) return null;
    const cw = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
    const tl = worldToLatLon(cw.x - w / 2, cw.y - h / 2, this.zoom);
    const br = worldToLatLon(cw.x + w / 2, cw.y + h / 2, this.zoom);
    return {
      minLat: Math.min(tl.lat, br.lat),
      maxLat: Math.max(tl.lat, br.lat),
      minLon: Math.min(tl.lon, br.lon),
      maxLon: Math.max(tl.lon, br.lon),
    };
  }

  setShowFixed(v) {
    const next = !!v;
    if (this.showFixed === next) return;
    this.showFixed = next;
    this._invalidateOverlayStatic();
    this.drawOverlay(this.lastState);
  }

  setTraceMode(v) {
    this.traceMode = !!v;
    if (this.traceMode) {
      this._traceLastFrameTs = 0;
      this._traceInitialRunDoneById.clear();
      this._traceCycleStartMsById.clear();
      this._invalidateOverlayStatic();
      if (!this._traceRAF) this._traceRAF = requestAnimationFrame(() => this._traceTick());
    } else {
      if (this._traceRAF) cancelAnimationFrame(this._traceRAF);
      this._traceRAF = null;
      this._traceLastFrameTs = 0;
      this.drawOverlay(this.lastState);
    }
  }

  setPlaybackMode(v) {
    this.playbackMode = !!v;
    if (!this.playbackMode) {
      this._playbackPlaying = false;
      this._playbackNewestSegmentStartMs = null;
      this._playbackLastMaxMs = null;
      this._playbackInitialized = false;
    } else {
      this._playbackInitialized = false;  // Will be initialized by playback loop
      // Don't set _playbackNowMs here - let the playback loop handle it with 10-min offset
    }
    this._invalidateOverlayStatic();
    this.drawOverlay(this.lastState);
  }

  setPlaybackPlaying(v) {
    this._playbackPlaying = !!v;
  }

  _playbackMarkNewestSegmentFromBounds(prevMaxMs, nextMaxMs) {
    const p = (prevMaxMs != null) ? Number(prevMaxMs) : null;
    const n = (nextMaxMs != null) ? Number(nextMaxMs) : null;
    if (p != null && n != null && isFinite(p) && isFinite(n) && n > p + 500) {
      this._playbackNewestSegmentStartMs = p;
    }
    this._playbackLastMaxMs = (n != null && isFinite(n)) ? n : this._playbackLastMaxMs;
  }

  isPlaybackAtEnd(epsMs = 100) {
    const b = this.getPlaybackBounds();
    const t = this.getPlaybackTimeMs();
    if (b.maxMs == null || !isFinite(Number(b.maxMs))) return false;
    if (t == null || !isFinite(Number(t))) return false;
    return Math.abs(Number(b.maxMs) - Number(t)) <= (Number(epsMs) || 0);
  }

  setPlaybackSpeed(v) {
    const n = Number(v);
    this._playbackSpeed = (isFinite(n) && n > 0) ? n : 1.0;
  }

  setPlaybackTimeMs(tMs) {
    const n = Number(tMs);
    this._playbackNowMs = isFinite(n) ? n : null;
  }

  getPlaybackBounds() {
    return { minMs: this._playbackMinMs, maxMs: this._playbackMaxMs };
  }

  getPlaybackTimeMs() {
    return this._playbackNowMs;
  }

  getPlaybackPlaying() {
    return !!this._playbackPlaying;
  }

  getPlaybackSpeed() {
    return this._playbackSpeed;
  }

  _hitTestMobileAtClientXY(clientX, clientY, nowMs) {
    const st = this.lastState;
    const mobiles = st && Array.isArray(st.mobile) ? st.mobile : [];
    const rect = this.overlayCanvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;

    const w = rect.width;
    const h = rect.height;
    const centerW = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
    const worldToScreenFast = (wx, wy) => ({ x: wx - centerW.x + w / 2, y: wy - centerW.y + h / 2 });

    for (const m of mobiles) {
      const pose = this._mobilePoseForRender(m, nowMs);
      const lat = Number(pose?.lat);
      const lon = Number(pose?.lon);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      const wpt = latLonToWorld(lat, lon, this.zoom);
      const sp = worldToScreenFast(wpt.x, wpt.y);
      const dx = sp.x - sx;
      const dy = sp.y - sy;
      if ((dx * dx + dy * dy) <= (20 * 20)) {
        return m;
      }
    }
    return null;
  }

  _closestPlaybackPathPointForMobileAtClientXY(mobile, clientX, clientY) {
    if (!this.playbackMode) return null;
    const id = mobile && mobile.id != null ? String(mobile.id) : "";
    if (!id) return null;

    this._ensurePlaybackPoints(this.lastState);
    const pts = this._playbackPtsById.get(id);
    if (!pts || pts.length < 2) return null;

    const rect = this.overlayCanvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const w = rect.width;
    const h = rect.height;
    const centerW = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
    const toScreen = (lat, lon) => {
      const wpt = latLonToWorld(lat, lon, this.zoom);
      return { x: wpt.x - centerW.x + w / 2, y: wpt.y - centerW.y + h / 2 };
    };

    const closestOnSeg = (ax, ay, bx, by, px, py) => {
      const abx = bx - ax;
      const aby = by - ay;
      const apx = px - ax;
      const apy = py - ay;
      const ab2 = abx * abx + aby * aby;
      let t = 0;
      if (ab2 > 1e-9) t = (apx * abx + apy * aby) / ab2;
      t = clamp(t, 0, 1);
      const cx = ax + abx * t;
      const cy = ay + aby * t;
      const dx = px - cx;
      const dy = py - cy;
      return { t, cx, cy, d2: dx * dx + dy * dy };
    };

    // Coarse-to-fine search so long trails still feel responsive.
    const n = pts.length;
    const stride = Math.max(1, Math.floor(n / 520));
    let best = { i: 0, t: 0, cx: 0, cy: 0, d2: Infinity };

    const scan = (i0, i1, step) => {
      const start = Math.max(0, i0);
      const end = Math.min(n - 2, i1);
      for (let i = start; i <= end; i += step) {
        const a = pts[i];
        const b = pts[i + 1];
        const sa = toScreen(a.lat, a.lon);
        const sb = toScreen(b.lat, b.lon);
        const hit = closestOnSeg(sa.x, sa.y, sb.x, sb.y, sx, sy);
        if (hit.d2 < best.d2) best = { i, t: hit.t, cx: hit.cx, cy: hit.cy, d2: hit.d2 };
      }
    };

    scan(0, n - 2, stride);
    const win = Math.max(24, stride * 7);
    scan(best.i - win, best.i + win, 1);

    const a = pts[best.i];
    const b = pts[best.i + 1];
    const tMs = a.tMs + (b.tMs - a.tMs) * best.t;
    const distPx = Math.sqrt(best.d2);
    return { tMs, distPx, segI: best.i, segT: best.t, closest: { x: best.cx, y: best.cy }, cursor: { x: sx, y: sy } };
  }

  _startPbMarkerInertiaFromDrag(drag) {
    if (!this.playbackMode) return;
    const id = drag && drag.id != null ? String(drag.id) : "";
    if (!id) return;
    const pos = drag && drag.cursorClient ? drag.cursorClient : (drag && drag.lastClient ? drag.lastClient : null);
    if (!pos) return;
    const v0 = drag && drag.vel ? drag.vel : { x: 0, y: 0 };
    const vx = Number(v0.x) || 0;
    const vy = Number(v0.y) || 0;
    const speed = Math.hypot(vx, vy);
    // Only a subtle glide; ignore tiny releases.
    if (!isFinite(speed) || speed < 0.05) return; // px/ms

    const nowMs = performance.now();
    this._pbInertia2d = {
      id,
      t0Ms: nowMs,
      lastMs: nowMs,
      posClient: { x: Number(pos.x) || 0, y: Number(pos.y) || 0 },
      vel: { x: vx, y: vy },
    };
  }

  _hasPbMarkerInertia() {
    return !!(this._pbInertia2d && this._pbInertia2d.id);
  }

  _stepPbMarkerInertia(nowMs, dtMs) {
    const it = this._pbInertia2d;
    if (!it || !it.id) return false;
    const dt = Math.max(0, Number(dtMs) || 0);
    if (!(dt > 0)) return false;

    // Cap duration so a fling never runs away.
    const age = (nowMs - (it.t0Ms || nowMs));
    if (age > 900) {
      this._pbInertia2d = null;
      return false;
    }

    // Integrate in client space; then snap to nearest path point.
    it.posClient.x += (it.vel.x || 0) * dt;
    it.posClient.y += (it.vel.y || 0) * dt;

    // Exponential friction: quick settle.
    const friction = Math.pow(0.992, dt);
    it.vel.x *= friction;
    it.vel.y *= friction;

    const speed = Math.hypot(it.vel.x || 0, it.vel.y || 0);
    if (!isFinite(speed) || speed < 0.02) {
      this._pbInertia2d = null;
      return false;
    }

    const st = this.lastState;
    const mobiles = st && Array.isArray(st.mobile) ? st.mobile : [];
    const m = mobiles.find(mm => (mm && mm.id != null && String(mm.id) === String(it.id))) || null;
    if (!m) {
      this._pbInertia2d = null;
      return false;
    }

    const closest = this._closestPlaybackPathPointForMobileAtClientXY(m, it.posClient.x, it.posClient.y);
    if (closest && isFinite(closest.tMs)) {
      const bounds = this.getPlaybackBounds();
      const tMs = closest.tMs;
      if (isFinite(bounds.minMs) && isFinite(bounds.maxMs)) {
        const clamped = clamp(tMs, bounds.minMs, bounds.maxMs);
        this.setPlaybackTimeMs(clamped);
        // User interaction exits LIVE mode (they're manually controlling)
        this._playbackLiveFollow = false;
        if (typeof this._resetLiveTracking === "function") this._resetLiveTracking();
      } else {
        this.setPlaybackTimeMs(tMs);
        this._playbackLiveFollow = false;
        if (typeof this._resetLiveTracking === "function") this._resetLiveTracking();
      }
      return true;
    }

    return false;
  }

  _scrubPlaybackTimeForMobileAtClientXY(mobile, clientX, clientY) {
    const c = this._closestPlaybackPathPointForMobileAtClientXY(mobile, clientX, clientY);
    if (!c || !isFinite(c.tMs)) return;
    const bounds = this.getPlaybackBounds();
    if (isFinite(bounds.minMs) && isFinite(bounds.maxMs)) {
      let clamped = clamp(c.tMs, bounds.minMs, bounds.maxMs);
      this.setPlaybackTimeMs(clamped);
    }
    else this.setPlaybackTimeMs(c.tMs);
  }

  _traceTick() {
    this._traceRAF = null;
    // Don't run trace loop when playback mode is active - playback has its own loop
    if (!this.traceMode || this.playbackMode) return;
    // Basemap is static; only redraw overlays.
    // Throttle to reduce CPU while remaining smooth.
    const now = performance.now();
    const fps = this._backgrounded ? (this._backgroundedFPS || 15) : (this._traceTargetFPS || 30);
    const minDt = 1000 / fps;
    if (this._traceLastFrameTs > 0 && (now - this._traceLastFrameTs) < (minDt - 0.5)) {
      this._traceRAF = requestAnimationFrame(() => this._traceTick());
      return;
    }
    this._traceLastFrameTs = now;
    this.drawOverlay(this.lastState, { nowMs: now, fromTraceTick: true });
    this._traceRAF = requestAnimationFrame(() => this._traceTick());
  }

  _followTick() {
    this._followRAF = null;
    if (!this.selectedId || this._followTargetLat === null) return;
    const now = performance.now();
    if (this._touchActive || this._mouseDragging || this._pinchZooming ||
        this._scrubbing ||
        now < this._followSuppressUntilMs) {
      this._followRAF = requestAnimationFrame(() => this._followTick());
      return;
    }
    // Throttle follow updates when tab is backgrounded
    if (this._backgrounded) {
      const minDt = 1000 / (this._backgroundedFPS || 15);
      if (this._followLastFrameTs > 0 && (now - this._followLastFrameTs) < (minDt - 0.5)) {
        this._followRAF = requestAnimationFrame(() => this._followTick());
        return;
      }
      this._followLastFrameTs = now;
    }
    // Always use the rendered marker position (interpolated), not raw GPS.
    let tLat = this._followTargetLat;
    let tLon = this._followTargetLon;
    if (this.lastState) {
      const fp = parseKey(this.selectedId);
      if (fp && fp.type === 'mobile') {
        const mob = Array.isArray(this.lastState.mobile) ? this.lastState.mobile : [];
        const fm = mob.find(v => String(v.id) === String(fp.id));
        if (fm) {
          const pose = this._mobilePoseForRender(fm, performance.now());
          if (pose && isFinite(Number(pose.lat)) && isFinite(Number(pose.lon))) {
            tLat = Number(pose.lat);
            tLon = Number(pose.lon);
          }
        }
      }
    }
    const dLat = tLat - this.center.lat;
    const dLon = tLon - this.center.lon;
    if (Math.abs(dLat) > 0.00005 || Math.abs(dLon) > 0.00005) {
      this.center = { lat: this.center.lat + dLat * 0.03, lon: this.center.lon + dLon * 0.03 };
      this._redrawViewOnly();
    }
    this._followRAF = requestAnimationFrame(() => this._followTick());
  }

  _hash01(s) {
    const str = String(s || "");
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % 100000) / 100000;
  }

  _traceSampleForMobile(m, nowMs) {
    const id = m && m.id ? String(m.id) : "";

    // If the backend says this vehicle is idle/ghosted, dim marker unless selected or in Debug mode.
    if (m && m.ghosted) {
      const lat = Number(m.lat);
      const lon = Number(m.lon);
      const prevA = this._traceAngleById.get(id);
      const angle = (prevA != null && isFinite(prevA)) ? prevA : 0;
      this._traceAngleById.set(id, angle);
      this._traceAngleLastMsById.set(id, nowMs);
      
      if (!m._key) m._key = keyFor("mobile", m.id);
      const key = m._key;
      const isSel = (this.selectedId === key);
      const dimOpacity = 0.25;
      const opacity = (this._pbDebugPath || isSel) ? 1 : dimOpacity;
      
      return { lat, lon, angle, flipX: false, speedMps: 0, opacity };
    }

    let route = this._traceActiveRouteById.get(id) || null;
    if (!route || !route.pts || route.pts.length < 2) {
      route = this._tracePendingRouteById.get(id) || null;
      if (!route || !route.pts || route.pts.length < 2) return null;
      // If we only have a pending route (startup), promote it.
      this._traceActiveRouteById.set(id, route);
      this._tracePendingRouteById.delete(id);
    }

    let driveMs = route.driveMs || 1;
    let pauseMs = route.pauseMs || 0;
    let returnMs = route.returnMs || 0;
    let totalMs = route.totalMs || (driveMs + pauseMs + returnMs);

    // Keep the current loop stable across refreshes; only swap pending route at loop boundary.
    let cycleStartMs = this._traceCycleStartMsById.get(id);
    if (cycleStartMs == null || !isFinite(cycleStartMs)) {
      // Start at the beginning of the path.
      cycleStartMs = nowMs;
    }
    let elapsed = nowMs - cycleStartMs;
    if (!isFinite(elapsed)) elapsed = 0;

    // Swap pending route only at loop boundary so the animation doesn't jump.
    if (elapsed >= totalMs) {
      const pending = this._tracePendingRouteById.get(id);
      if (pending && pending.pts && pending.pts.length >= 2) {
        route = pending;
        this._traceActiveRouteById.set(id, pending);
        this._tracePendingRouteById.delete(id);
        driveMs = route.driveMs || 1;
        pauseMs = route.pauseMs || 0;
        returnMs = route.returnMs || 0;
        totalMs = route.totalMs || (driveMs + pauseMs + returnMs);
        cycleStartMs = nowMs;
        elapsed = 0;
      } else {
        const loopDur = Math.max(100, totalMs);
        const cyclesPassed = Math.floor(elapsed / loopDur);
        cycleStartMs = cycleStartMs + cyclesPassed * loopDur;
        elapsed = nowMs - cycleStartMs;
      }
    }
    this._traceCycleStartMsById.set(id, cycleStartMs);

    const tInCycle = elapsed;
    const tPauseStart = driveMs;
    const tReturnStart = driveMs + pauseMs;
    const tEnd = driveMs + pauseMs + (returnMs || 0);

    const inPause = (tInCycle >= tPauseStart) && (tInCycle < tReturnStart);
    const inReturn = (tInCycle >= tReturnStart) && (tInCycle < tEnd) && ((returnMs || 0) > 0);
    const tDrive = (tInCycle < driveMs) ? tInCycle : driveMs;

    // Find segment for tDrive.
    const segStart = route.segStartMs;
    const segDur = route.segDurMs;
    const pts = route.pts;
    let si = 0;
    let lo = 0;
    let hi = segStart.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const a = segStart[mid];
      const b = a + (segDur[mid] || 1);
      if (tDrive < a) hi = mid - 1;
      else if (tDrive >= b) lo = mid + 1;
      else { si = mid; break; }
    }
    // If binary search didn't land (e.g. exact end), clamp.
    if (si < 0) si = 0;
    if (si >= segStart.length) si = segStart.length - 1;

    const aT = segStart[si];
    const dT = Math.max(1, segDur[si] || 1);
    const u = clamp((tDrive - aT) / dT, 0, 1);

    const p0 = pts[si];
    const p1 = pts[si + 1] || pts[si];
    let lat = p0.lat + (p1.lat - p0.lat) * u;
    let lon = p0.lon + (p1.lon - p0.lon) * u;
    let speedMps = (route.segRealSpeedMps && isFinite(route.segRealSpeedMps[si]) ? route.segRealSpeedMps[si] : 0);
    let opacity = 1;

    if (inPause) {
      const endPt = pts[pts.length - 1] || p1;
      lat = endPt.lat;
      lon = endPt.lon;
      speedMps = 0;
    } else if (inReturn) {
      const endPt = pts[pts.length - 1] || p1;
      const lsLat = isFinite(Number(route.loopStartLat)) ? Number(route.loopStartLat) : (pts[0]?.lat ?? endPt.lat);
      const lsLon = isFinite(Number(route.loopStartLon)) ? Number(route.loopStartLon) : (pts[0]?.lon ?? endPt.lon);
      const uu = clamp((tInCycle - tReturnStart) / Math.max(1, returnMs || 1), 0, 1);
      lat = endPt.lat + (lsLat - endPt.lat) * uu;
      lon = endPt.lon + (lsLon - endPt.lon) * uu;
      const distM = haversineMeters(endPt.lat, endPt.lon, lsLat, lsLon);
      const v = distM / Math.max(0.001, (returnMs || 1) / 1000);
      speedMps = clamp(v, 0, Number(this._traceRealMaxSpeedMps) || 20.0);

      // Seamless fade on loop return:
      // - fade out over first 0.5s of return
      // - stay invisible mid-return
      // - fade in over last 0.5s before arriving at loop start
      const fadeMs = 500;
      const tRet = tInCycle - tReturnStart;
      const tRemain = (tEnd - tInCycle);
      if (tRet <= fadeMs) opacity = clamp(1 - (tRet / fadeMs), 0, 1);
      else if (tRemain <= fadeMs) opacity = clamp(1 - (tRemain / fadeMs), 0, 1);
      else opacity = 0;
    }

    // Selection warp: when a sensor is clicked, make the trace marker "return" to the latest
    // live location deterministically (fade-out → invisible warp → fade-in).
    const warp = this._traceSelectionWarpById.get(id);
    if (warp) {
      const t0 = Number(warp.t0Ms);
      const fadeMs = Number(warp.fadeMs) || 500;
      const durMs = Number(warp.durationMs) || 1400;
      const t = nowMs - t0;
      if (!isFinite(t) || t < 0) {
        // ignore
      } else if (t >= durMs) {
        this._traceSelectionWarpById.delete(id);
        // Force the trace cycle to the end point (latest) so it stays in sync after warp.
        const r = this._traceActiveRouteById.get(id);
        if (r && isFinite(Number(r.driveMs))) {
          this._traceCycleStartMsById.set(id, nowMs - Number(r.driveMs));
        }
      } else {
        const fromLat = Number(warp.fromLat);
        const fromLon = Number(warp.fromLon);
        const homeLat = Number(warp.homeLat);
        const homeLon = Number(warp.homeLon);
        const midDur = Math.max(1, durMs - 2 * fadeMs);
        if (t <= fadeMs) {
          // Fade out at the original trace position.
          lat = isFinite(fromLat) ? fromLat : lat;
          lon = isFinite(fromLon) ? fromLon : lon;
          speedMps = 0;
          opacity = opacity * clamp(1 - (t / Math.max(1, fadeMs)), 0, 1);
        } else if (t >= (durMs - fadeMs)) {
          // Fade in at the latest live position.
          lat = isFinite(homeLat) ? homeLat : lat;
          lon = isFinite(homeLon) ? homeLon : lon;
          speedMps = 0;
          const u = (t - (durMs - fadeMs)) / Math.max(1, fadeMs);
          opacity = opacity * clamp(u, 0, 1);
        } else {
          // Invisible warp (optionally interpolate for determinism).
          const u = clamp((t - fadeMs) / midDur, 0, 1);
          if (isFinite(fromLat) && isFinite(homeLat)) lat = fromLat + (homeLat - fromLat) * u;
          if (isFinite(fromLon) && isFinite(homeLon)) lon = fromLon + (homeLon - fromLon) * u;
          speedMps = 0;
          opacity = 0;
        }
      }
    }

    // Heading in projected space for correct screen rotation.
    let hLat0 = p0.lat;
    let hLon0 = p0.lon;
    let hLat1 = p1.lat;
    let hLon1 = p1.lon;
    if (inPause) {
      const a = pts[Math.max(0, pts.length - 2)] || p0;
      const b = pts[Math.max(0, pts.length - 1)] || p1;
      hLat0 = a.lat;
      hLon0 = a.lon;
      hLat1 = b.lat;
      hLon1 = b.lon;
    } else if (inReturn) {
      const endPt = pts[pts.length - 1] || p1;
      const lsLat = isFinite(Number(route.loopStartLat)) ? Number(route.loopStartLat) : (pts[0]?.lat ?? endPt.lat);
      const lsLon = isFinite(Number(route.loopStartLon)) ? Number(route.loopStartLon) : (pts[0]?.lon ?? endPt.lon);
      hLat0 = endPt.lat;
      hLon0 = endPt.lon;
      hLat1 = lsLat;
      hLon1 = lsLon;
    }

    const w0 = latLonToWorld(hLat0, hLon0, this.zoom);
    const w1 = latLonToWorld(hLat1, hLon1, this.zoom);
    let dx = (w1.x - w0.x);
    let dy = (w1.y - w0.y);
    if (Math.abs(dx) < 0.0001 && Math.abs(dy) < 0.0001) {
      // If we're at (or pausing at) the end, reuse the last meaningful segment.
      const lastIdx = Math.max(0, Math.min(pts.length - 2, pts.length - 2));
      const wa = latLonToWorld(pts[lastIdx].lat, pts[lastIdx].lon, this.zoom);
      const wb = latLonToWorld(pts[lastIdx + 1].lat, pts[lastIdx + 1].lon, this.zoom);
      dx = wb.x - wa.x;
      dy = wb.y - wa.y;
    }
    const heading = Math.atan2(dy, dx);

    // Debounce left/right side changes around vertical to avoid flicker when traveling up/down.
    const absH = Math.abs(heading);
    const dead = 0.22; // ~12.6° deadband
    const switchToLeft = (Math.PI / 2) + dead;
    const switchToRight = (Math.PI / 2) - dead;
    let side = this._traceLastSideById.get(id);
    if (side !== "L" && side !== "R") side = (absH > Math.PI / 2) ? "L" : "R";
    if (side === "R" && absH > switchToLeft) side = "L";
    else if (side === "L" && absH < switchToRight) side = "R";
    this._traceLastSideById.set(id, side);

    let renderAngle = heading;
    if (side === "L") renderAngle = Math.PI - heading;
    if (renderAngle > Math.PI) renderAngle -= Math.PI * 2;
    if (renderAngle < -Math.PI) renderAngle += Math.PI * 2;

    // Smooth the angle to avoid snap-rotation when direction changes.
    const wrapAngle = (a) => {
      let x = a;
      while (x > Math.PI) x -= Math.PI * 2;
      while (x < -Math.PI) x += Math.PI * 2;
      return x;
    };
    const prevA = this._traceAngleById.get(id);
    const lastMs = this._traceAngleLastMsById.get(id);
    const dtS = (lastMs != null && isFinite(lastMs)) ? Math.max(0, (nowMs - lastMs) / 1000) : 0;
    const tauS = 0.35;
    const alpha = dtS > 0 ? (1 - Math.exp(-dtS / tauS)) : 1;
    const nextA = (prevA == null)
      ? renderAngle
      : wrapAngle(prevA + wrapAngle(renderAngle - prevA) * alpha);
    this._traceAngleById.set(id, nextA);
    this._traceAngleLastMsById.set(id, nowMs);

    return { lat, lon, angle: nextA, flipX: (side === "L"), speedMps, opacity };
  }

  _mobilePoseForRender(m, nowMs) {
    let lat = Number(m?.lat);
    let lon = Number(m?.lon);
    let angle = 0;
    let flipX = false;
    let speedMps = 0;
    let opacity = 1;

    if (this.playbackMode) {
      this._ensurePlaybackPoints(this.lastState);
      const smp = this._playbackSampleForMobile(m, nowMs);
      if (smp) {
        lat = smp.lat;
        lon = smp.lon;
        angle = smp.angle;
        flipX = !!smp.flipX;
        speedMps = Number(smp.speedMps) || 0;
        opacity = (typeof smp.opacity === "number" && isFinite(smp.opacity)) ? smp.opacity : 1;
        // Dim markers that haven't "started" yet in the timeline
        if (smp.beforeFirst) {
          opacity = 0.3;
        }
      } else {
        // Fallback: if no playback sample but we have trail data, use first/last trail point
        const id = m && m.id != null ? String(m.id) : "";
        const pts = id ? this._playbackPtsById.get(id) : null;
        const t = this._playbackNowMs;
        if (pts && pts.length >= 1 && t != null && isFinite(t)) {
          // Before first point: show at first position (dimmed)
          // After last point: show at last position
          const tMin = pts[0].tMs;
          const tMax = pts[pts.length - 1].tMs;
          if (t < tMin) {
            lat = pts[0].lat;
            lon = pts[0].lon;
            opacity = 0.3; // Dimmed - hasn't "started" yet
          } else if (t >= tMax) {
            lat = pts[pts.length - 1].lat;
            lon = pts[pts.length - 1].lon;
          }
        }
      }

      const held = !!(
        (this._pbDrag && String(this._pbDrag.id) === String(m?.id)) ||
        (this._pbInertia2d && String(this._pbInertia2d.id) === String(m?.id))
      );

      return {
        lat,
        lon,
        angle,
        flipX,
        speedMps,
        opacity,
        reading: smp?.reading || null,
        readings: smp?.readings || null,
        held,
      };
    }

    if (this.traceMode) {
      const smp = this._traceSampleForMobile(m, nowMs);
      if (smp) {
        lat = smp.lat;
        lon = smp.lon;
        angle = smp.angle;
        flipX = !!smp.flipX;
        speedMps = Number(smp.speedMps) || 0;
        opacity = (typeof smp.opacity === "number" && isFinite(smp.opacity)) ? smp.opacity : 1;
      }
      return { lat, lon, angle, flipX, speedMps, opacity };
    }

    const id = (m && m.id != null) ? String(m.id) : "";
    const pin = id ? this._persistedTrailById.get(id)?.pin : null;
    if (pin && isFinite(Number(pin.lat)) && isFinite(Number(pin.lon))) {
      lat = Number(pin.lat);
      lon = Number(pin.lon);
    }

    return { lat, lon, angle, flipX, speedMps, opacity };
  }

  zoomBy(delta) {
    // User interaction: immediate zoom (no easing).
    const target = clamp(Math.round(this.zoom) + delta, this._zoomMin, this._zoomMax);
    this.zoom = target;
    // Invalidate snapshot when zoom jumps (prevents “tunnel” feel).
    this._tilesSnapshotCanvas = null;
    this._tilesSnapshotMeta = null;
    this.draw(this.lastState);
    this._notifyViewChanged();
  }

  resize(cssW, cssH) {
    const dpr = window.devicePixelRatio || 1;
    const parent = this.tilesCanvas.parentElement;
    // Prefer caller-supplied dimensions (e.g. from ResizeObserver contentRect or
    // visualViewport) over reading clientWidth/clientHeight.  The CSS height chain
    // (html/body use -webkit-fill-available as a PWA fix) can return a stale value
    // in Chrome and Safari when devtools or the browser chrome changes size.
    const w = Math.max(1, cssW != null ? Math.round(cssW) : parent.clientWidth);
    const h = Math.max(1, cssH != null ? Math.round(cssH) : parent.clientHeight);

    // Guard: skip if nothing changed (prevents feedback loops)
    if (w === this._cssW && h === this._cssH && dpr === this._dpr) return;

    this._dpr = dpr;
    this._cssW = w;
    this._cssH = h;

    // Set internal canvas dimensions
    this.tilesCanvas.width = Math.floor(w * dpr);
    this.tilesCanvas.height = Math.floor(h * dpr);
    this.paFieldCanvasEl.width = Math.floor(w * dpr);
    this.paFieldCanvasEl.height = Math.floor(h * dpr);
    this.overlayCanvas.width = Math.floor(w * dpr);
    this.overlayCanvas.height = Math.floor(h * dpr);

    // Set explicit CSS pixel dimensions - critical for iOS PWA standalone mode
    // where percentage-based sizing can be calculated incorrectly
    this.tilesCanvas.style.width = w + 'px';
    this.tilesCanvas.style.height = h + 'px';
    this.paFieldCanvasEl.style.width = w + 'px';
    this.paFieldCanvasEl.style.height = h + 'px';
    this.overlayCanvas.style.width = w + 'px';
    this.overlayCanvas.style.height = h + 'px';

    this.tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.pfctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.octx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Snapshot is tied to canvas size; reset on resize to avoid distortion.
    this._tilesSnapshotCanvas = null;
    this._tilesSnapshotMeta = null;
    this._paFieldCanvas = null;
    this._paFieldCtx = null;
    this._paGrid = null;
    this._invalidateOverlayStatic();
    this._invalidatePaField();
    // Invalidate trail cache on resize
    this._trailCacheCanvas = null;
    this._trailCacheViewKey = "";
    // Force drawTiles() in draw() even if viewSig matches (canvas was cleared above).
    this._lastTilesViewSig = null;

    this.draw(this.lastState);
  }


  onWheel(e) {
    // Platform-aware wheel handling:
    // - Windows: scroll wheel = zoom (no Ctrl needed), trackpad pan = pan
    // - macOS: trackpad pinch (ctrlKey) = zoom, trackpad pan = pan, mouse wheel = zoom
    e.preventDefault();
    this._noteUserInteraction();

    // deltaMode !== 0 means mouse wheel (line or page scrolling mode)
    const isMouseWheel = e.deltaMode !== 0;

    // Smooth-scroll mice (Windows/Linux only): vertical-only with significant delta.
    // Catches mice that report deltaMode=0 (Logitech, Razer, etc).
    // NOT applied on macOS — two-finger vertical trackpad pan is indistinguishable,
    // and macOS convention is scroll=pan, pinch=zoom (like Apple Maps).
    const isSmoothScrollZoom = !e.ctrlKey && Math.abs(e.deltaX) < 1 && Math.abs(e.deltaY) >= 4;

    // macOS mouse wheel: deltaMode is always 0, no ctrlKey. Detect via vertical-only
    // + significant delta. Same heuristic as isSmoothScrollZoom but Mac-specific flag
    // so it gets its own code path and isn't suppressed by the pan→zoom debounce.
    // Exclude if we're already in a trackpad pan stream (_wheelPanning) — a vertical
    // portion of a two-finger swipe must not be hijacked as zoom.
    const isMacMouseWheel = this._isMac && !this._wheelPanning && !e.ctrlKey && Math.abs(e.deltaX) < 1 && Math.abs(e.deltaY) >= 4;

    // Determine if this should be a zoom event:
    // 1. True mouse wheel (deltaMode !== 0) → zoom
    // 2. Ctrl+wheel (trackpad pinch gesture) → zoom
    // 3. Windows/Linux: vertical smooth-scroll (smooth-scroll mice) → zoom
    // 4. macOS mouse wheel (detected via heuristic) → zoom
    let shouldZoom = isMouseWheel || e.ctrlKey || isSmoothScrollZoom || isMacMouseWheel;

    // Debounce pan→zoom transitions: when lifting one finger during a two-finger
    // trackpad pan, macOS briefly interprets the finger separation as a pinch gesture,
    // firing ctrlKey=true wheel events. Ignore these artifacts if we were panning
    // within the last 100ms (a real intentional pinch starts well after pan ends).
    // Do NOT suppress isMacMouseWheel — that's a real mouse wheel, not a finger-lift.
    if (shouldZoom && !isMouseWheel && !isMacMouseWheel && this._lastWheelPanTime
        && (performance.now() - this._lastWheelPanTime) < 100) {
      shouldZoom = false;
    }

    if (shouldZoom) {
      if (this._gesture) return;
      if (this._mouseDragging) return; // Don't zoom while user is panning
      if (this._wheelPanning) return;  // Don't zoom while user is trackpad-panning

      if (this._wheelPinchEndTimer) window.clearTimeout(this._wheelPinchEndTimer);
      if (this._pinchZoomEndTimer) { window.clearTimeout(this._pinchZoomEndTimer); this._pinchZoomEndTimer = null; }
      this._pinchZooming = true;

      const rect = this.overlayCanvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      this._pinchAnchorSX = sx;
      this._pinchAnchorSY = sy;

      const rawDy = clamp(e.deltaY, -300, 300);

      // Platform-specific mouse-wheel flags (separate code paths, not combined)
      const isWinWheel = this._isWindows && (isMouseWheel || isSmoothScrollZoom);

      // Direction: mouse wheel on Win/Mac is reversed; everything else uses raw or inverted convention
      const dy = isWinWheel ? rawDy
              : isMacMouseWheel ? rawDy
              : (isMouseWheel || isSmoothScrollZoom) ? -rawDy : rawDy;
      const dir = dy < 0 ? 1 : -1;

      // Windows mouse-wheel: velocity-adaptive zoom.
      // Accumulate deltas over a short burst window; fast scrolling ramps up
      // non-linearly but is capped so you never blow past the map.
      let dz;
      if (isWinWheel) {
        const now = performance.now();
        const gap = now - this._winScrollLastTs;
        if (gap > 80) this._winScrollAccum = 0;
        this._winScrollAccum += Math.abs(dy);
        this._winScrollLastTs = now;
        const v = this._winScrollAccum;
        dz = dir * Math.min(0.015 * Math.sqrt(v), 0.45);

      // macOS mouse-wheel: same velocity-adaptive zoom, separate accumulator.
      } else if (isMacMouseWheel) {
        const now = performance.now();
        const gap = now - this._macScrollLastTs;
        if (gap > 80) this._macScrollAccum = 0;
        this._macScrollAccum += Math.abs(dy);
        this._macScrollLastTs = now;
        const v = this._macScrollAccum;
        dz = dir * Math.min(0.015 * Math.sqrt(v), 0.45);

      } else {
        // Trackpad pinch (any OS) or Linux mouse wheel — original behavior
        const isChromePinch = e.ctrlKey && !isMouseWheel && /Chrome/.test(navigator.userAgent || "");
        const strength = (isMouseWheel || isSmoothScrollZoom) ? 0.018 : isChromePinch ? 0.055 : 0.020;
        dz = dir * Math.log1p(Math.abs(dy)) * strength;
      }
      const prevZ = this.zoom;
      const z2 = clamp(this.zoom + dz, this._zoomMin, this._zoomMax);
      this._setZoomAroundScreenPoint(z2, sx, sy);
      this._requestZoomRedraw();
      this._notifyViewChanged();
      this._notePinchVelocity(z2 - prevZ, performance.now());

      // Trackpad pinch needs inertia; mouse wheel doesn't
      if (!isMouseWheel && !isSmoothScrollZoom && !isMacMouseWheel) {
        this._wheelPinchEndTimer = window.setTimeout(() => this._startPinchInertia(), 28);
      } else {
        this._wheelPinchEndTimer = window.setTimeout(() => {
          this._pinchZooming = false;
          this._requestZoomRedraw(); // Final redraw with crisp tiles at settled zoom
        }, 150);
      }
      return;
    }

    // Trackpad two-finger pan (deltaMode = 0, no ctrlKey, has horizontal component on macOS)
    // Also covers iPad keyboard trackpad which fires wheel events, not touch events.
    this._lastWheelPanTime = performance.now();
    if (!this._wheelPanning) {
      this._wheelPanning = true;
    }
    if (this._wheelPanEndTimer) window.clearTimeout(this._wheelPanEndTimer);
    this._wheelPanEndTimer = window.setTimeout(() => {
      this._wheelPanning = false;
      this._wheelPanEndTimer = null;
      this._redrawViewOnly();
    }, 120);
    const scale = 0.65;
    const c = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
    const nx = c.x + e.deltaX * scale;
    const ny = clamp(c.y + e.deltaY * scale, 0, c.ws - 1);
    const ll = worldToLatLon(nx, ny, this.zoom);
    this.center = { lat: ll.lat, lon: ll.lon };
    if (!this._pinchInertiaRAF) this._requestPanRedraw();
  }

  _updateHoverAtClientXY(clientX, clientY) {
    const st = this.lastState;
    if (!st) return;
    const rect = this.overlayCanvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    // Only test if cursor is within the canvas bounds
    if (sx < 0 || sy < 0 || sx > rect.width || sy > rect.height) {
      this._scheduleHoverHide();
      return;
    }
    const mobiles = Array.isArray(st.mobile) ? st.mobile : [];
    const fixed = Array.isArray(st.fixed) ? st.fixed : [];

    // Hit-test in reverse render order (same as onClick), but exclude PurpleAir
    let hit = null;
    const selParsed = parseKey(this.selectedId);
    const selMobileId = (selParsed && selParsed.type === "mobile") ? String(selParsed.id) : null;
    const allMobileCands = mobiles.map(m => ({ type: "mobile", ...m }));
    const topMobileCand = selMobileId ? allMobileCands.find(m => String(m.id) === selMobileId) : null;
    const otherMobileCands = selMobileId ? allMobileCands.filter(m => String(m.id) !== selMobileId) : [...allMobileCands];
    const candidates = [
      ...(topMobileCand ? [topMobileCand] : []),
      ...[...otherMobileCands].reverse(),
      ...[...fixed.filter(f => !f.purpleair)].reverse().map(f => ({ type: "fixed", ...f })),
    ];
    for (const m of candidates) {
      let lat = Number(m.lat), lon = Number(m.lon);
      if (m.type === "mobile") {
        const pose = this._mobilePoseForRender(m, performance.now());
        lat = pose.lat;
        lon = pose.lon;
      }
      if (m.type === "fixed" && this._fixedGeoOffsets) {
        const fKey = m._key || keyFor("fixed", m.id);
        const geo = this._fixedGeoOffsets.get(fKey);
        if (geo) { lat += geo.dlat; lon += geo.dlon; }
      }
      if (!isFinite(lat) || !isFinite(lon)) continue;
      const wpt = latLonToWorld(lat, lon, this.zoom);
      const sp = this.worldToScreen(wpt.x, wpt.y);
      const dx = sp.x - sx;
      const dy = sp.y - sy;
      if ((dx*dx + dy*dy) <= (20*20)) {
        hit = keyFor(m.type, m.id);
        break;
      }
    }

    // Update pointer cursor for marker hover
    this.overlayCanvas.style.cursor = hit ? "pointer" : "";

    // Suppress hover labels while a marker is selected
    if (this.selectedId) {
      this._clearHover();
      return;
    }

    if (hit) {
      // Clear hide timer if re-entering same or new marker
      if (this._hoverHideTimer) { clearTimeout(this._hoverHideTimer); this._hoverHideTimer = null; }
      if (this._hoveredId === hit) return; // already showing this one
      // Clear previous show timer
      if (this._hoverShowTimer) { clearTimeout(this._hoverShowTimer); this._hoverShowTimer = null; }
      this._hoverShowTimer = setTimeout(() => {
        this._hoverShowTimer = null;
        this._hoveredId = hit;
        this._invalidateOverlayStatic();
        this.drawOverlay(this.lastState);
      }, 333);
    } else {
      // Not over any marker — schedule hide
      if (this._hoverShowTimer) { clearTimeout(this._hoverShowTimer); this._hoverShowTimer = null; }
      this._scheduleHoverHide();
    }
  }

  _scheduleHoverHide() {
    if (!this._hoveredId) return;
    if (this._hoverHideTimer) return; // already scheduled
    this._hoverHideTimer = setTimeout(() => {
      this._hoverHideTimer = null;
      this._hoveredId = null;
      this._invalidateOverlayStatic();
      this.drawOverlay(this.lastState);
    }, 333);
  }

  _clearHover() {
    if (this._hoverShowTimer) { clearTimeout(this._hoverShowTimer); this._hoverShowTimer = null; }
    if (this._hoverHideTimer) { clearTimeout(this._hoverHideTimer); this._hoverHideTimer = null; }
    if (this._hoveredId) {
      this._hoveredId = null;
      this._invalidateOverlayStatic();
      this.drawOverlay(this.lastState);
    }
  }

  onClick(e) {
    // Click empty map to deselect
    const st = this.lastState;
    const mobiles = st && Array.isArray(st.mobile) ? st.mobile : [];
    const fixed = st && Array.isArray(st.fixed) ? st.fixed : [];
    const rect = this.overlayCanvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    // Ignore click if it was part of a drag gesture.
    if (this._mouseDragMoved) {
      this._mouseDragMoved = false;
      return;
    }

    // hit test markers (emoji halo radius ~18), mobile + fixed
    // Search in reverse render order so the topmost (last-drawn) marker wins.
    // Render order (bottom→top): PurpleAir fixed → other fixed → non-selected mobiles → selected mobile.
    // Hit-test order is the exact reverse.
    let hit = null;
    const selParsed = parseKey(this.selectedId);
    const selMobileId = (selParsed && selParsed.type === "mobile") ? String(selParsed.id) : null;
    const allMobileCands = mobiles.map(m => ({ type: "mobile", ...m }));
    const topMobileCand = selMobileId ? allMobileCands.find(m => String(m.id) === selMobileId) : null;
    const otherMobileCands = selMobileId ? allMobileCands.filter(m => String(m.id) !== selMobileId) : [...allMobileCands];
    const candidates = [
      ...(topMobileCand ? [topMobileCand] : []),
      ...[...otherMobileCands].reverse(),
      ...[...fixed.filter(f => !f.purpleair)].reverse().map(f => ({ type: "fixed", ...f })),
      ...(this._paFieldPollutant == null || this._paFieldPollutant === "pm25" ? [...fixed.filter(f => f.purpleair)].reverse().map(f => ({ type: "fixed", ...f })) : []),
    ];
    const _clickRefMs = this.getPlaybackTimeMs() || this._dataNowMs();
    const _PA_FADE_MS = 45 * 60 * 1000;
    for (const m of candidates) {
      // Skip fully-faded PurpleAir sensors
      if (m.purpleair) {
        const sMs = m.last_seen ? m.last_seen * 1000 : null;
        if (sMs && (_clickRefMs - sMs) >= _PA_FADE_MS) continue;
      }
      let lat = Number(m.lat), lon = Number(m.lon);
      if (m.type === "mobile") {
        const pose = this._mobilePoseForRender(m, performance.now());
        lat = pose.lat;
        lon = pose.lon;
      }
      if (m.type === "fixed" && this._fixedGeoOffsets) {
        const fKey = m._key || keyFor("fixed", m.id);
        const geo = this._fixedGeoOffsets.get(fKey);
        if (geo) { lat += geo.dlat; lon += geo.dlon; }
      }
      if (!isFinite(lat) || !isFinite(lon)) continue;
      const wpt = latLonToWorld(lat, lon, this.zoom);
      const sp = this.worldToScreen(wpt.x, wpt.y);
      const dx = sp.x - sx;
      const dy = sp.y - sy;
      if ((dx*dx + dy*dy) <= (20*20)) {
        hit = keyFor(m.type, m.id);
        break;
      }
    }
    if (hit) {
      if (window.__selectSensor) window.__selectSensor(hit, { fitTrail: !!e.metaKey });
      return;
    }

    this.setSelected(null);
    if (window.__selectSensor) window.__selectSensor(null);
  }

  _handleTapSelection(sx, sy) {
    // Handle tap on touch devices - same hit testing as onClick
    const st = this.lastState;
    const mobiles = st && Array.isArray(st.mobile) ? st.mobile : [];
    const fixed = st && Array.isArray(st.fixed) ? st.fixed : [];

    // Search in reverse render order so the topmost (last-drawn) marker wins.
    // Render order (bottom→top): PurpleAir fixed → other fixed → non-selected mobiles → selected mobile.
    let hit = null;
    const tapSelParsed = parseKey(this.selectedId);
    const tapSelMobileId = (tapSelParsed && tapSelParsed.type === "mobile") ? String(tapSelParsed.id) : null;
    const tapAllMobileCands = mobiles.map(m => ({ type: "mobile", ...m }));
    const tapTopMobileCand = tapSelMobileId ? tapAllMobileCands.find(m => String(m.id) === tapSelMobileId) : null;
    const tapOtherMobileCands = tapSelMobileId ? tapAllMobileCands.filter(m => String(m.id) !== tapSelMobileId) : [...tapAllMobileCands];
    const candidates = [
      ...(tapTopMobileCand ? [tapTopMobileCand] : []),
      ...[...tapOtherMobileCands].reverse(),
      ...[...fixed.filter(f => !f.purpleair)].reverse().map(f => ({ type: "fixed", ...f })),
      ...(this._paFieldPollutant == null || this._paFieldPollutant === "pm25" ? [...fixed.filter(f => f.purpleair)].reverse().map(f => ({ type: "fixed", ...f })) : []),
    ];
    const _tapRefMs = this.getPlaybackTimeMs() || this._dataNowMs();
    const _TAP_PA_FADE_MS = 45 * 60 * 1000;
    for (const m of candidates) {
      // Skip fully-faded PurpleAir sensors
      if (m.purpleair) {
        const sMs = m.last_seen ? m.last_seen * 1000 : null;
        if (sMs && (_tapRefMs - sMs) >= _TAP_PA_FADE_MS) continue;
      }
      let lat = Number(m.lat), lon = Number(m.lon);
      if (m.type === "mobile") {
        const pose = this._mobilePoseForRender(m, performance.now());
        lat = pose.lat;
        lon = pose.lon;
      }
      if (m.type === "fixed" && this._fixedGeoOffsets) {
        const fKey = m._key || keyFor("fixed", m.id);
        const geo = this._fixedGeoOffsets.get(fKey);
        if (geo) { lat += geo.dlat; lon += geo.dlon; }
      }
      if (!isFinite(lat) || !isFinite(lon)) continue;
      const wpt = latLonToWorld(lat, lon, this.zoom);
      const sp = this.worldToScreen(wpt.x, wpt.y);
      const dx = sp.x - sx;
      const dy = sp.y - sy;
      if ((dx*dx + dy*dy) <= (35*35)) { // Large hit area for iOS touch accuracy
        hit = keyFor(m.type, m.id);
        break;
      }
    }
    if (hit) {
      if (window.__selectSensor) window.__selectSensor(hit, { fitTrail: false });
      return;
    }

    this.setSelected(null);
    if (window.__selectSensor) window.__selectSensor(null);
  }

  worldToScreen(wx, wy) {
    const w = this._cssW || 1;
    const h = this._cssH || 1;
    const c = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
    return { x: wx - c.x + w / 2, y: wy - c.y + h / 2 };
  }

  draw(state) {
    this.lastState = state;

    // Fast path: skip overlay/composite work when no data has arrived yet.
    // Tile prefetch is preserved so it overlaps with the config/data fetch.
    if (!state && !this.lastState) {
      this.drawTiles();
      return;
    }

    // Soft-follow: keep target fresh and ensure the loop is running.
    {
      const _fp = this.selectedId ? parseKey(this.selectedId) : null;
      if (_fp && _fp.type === 'mobile') {
        const _mob = Array.isArray(state?.mobile) ? state.mobile : [];
        const _fm = _mob.find(v => String(v.id) === String(_fp.id));
        if (_fm) {
          const _pose = this.playbackMode ? this._mobilePoseForRender(_fm, performance.now()) : null;
          const _tlat = _pose ? Number(_pose.lat) : Number(_fm.lat);
          const _tlon = _pose ? Number(_pose.lon) : Number(_fm.lon);
          if (isFinite(_tlat) && isFinite(_tlon)) {
            this._followTargetLat = _tlat;
            this._followTargetLon = _tlon;
          }
        }
        if (!this._followRAF) this._followRAF = requestAnimationFrame(() => this._followTick());
      } else {
        this._followTargetLat = null;
        this._followTargetLon = null;
        if (this._followRAF) { cancelAnimationFrame(this._followRAF); this._followRAF = null; }
      }
    }

    // Update the data-time clock from the newest trail timestamp we can see.
    // Use only the last point of each trail for efficiency.
    // Also detect if we have TRX vehicles (for track edge fetching)
    try {
      const mobiles = Array.isArray(state?.mobile) ? state.mobile : [];
      let maxT = null;
      let hasTrx = false;
      for (const m of mobiles) {
        const id = m?.id ? String(m.id).toUpperCase() : "";
        if (id.startsWith("TRX") || id.startsWith("TRAX")) hasTrx = true;
        
        const tr = Array.isArray(m?.trail) ? m.trail : null;
        if (!tr || tr.length < 1) continue;
        const last = tr[tr.length - 1];
        const tStr = (last && typeof last.t === "string") ? last.t : null;
        if (!tStr) continue;
        const tMs = parseUtcMs(tStr);
        if (tMs != null && isFinite(tMs)) maxT = (maxT == null) ? tMs : Math.max(maxT, tMs);
      }
      if (maxT != null && isFinite(maxT)) {
        this._dataNowBaseMs = maxT;
        this._dataNowBasePerfMs = performance.now();
      }
      this._hasTrxVehicles = hasTrx;
      // Only fetch tram track edges when debug path overlay is active (debug-only visualizer)
      if (hasTrx && this._pbDebugPath) this._fetchTramLineEdgesForViewport();
    } catch {
      // ignore
    }

    this._prunePerMobileCachesForState(state);
    this._updatePersistedTrails(state);
    this._invalidateOverlayStatic();
    
    // In playback mode, ensure playback points are refreshed with new state data
    if (this.playbackMode) {
      this._ensurePlaybackPoints(state);
    }
    
    // Optimization: state polling updates trails/markers, but the basemap is tied only
    // to view (center/zoom/theme/size). Avoid redrawing tiles unless the view changed.
    const viewSig = (() => {
      const z = Number(this.zoom);
      const lat = Number(this.center?.lat);
      const lon = Number(this.center?.lon);
      const w = Number(this._cssW);
      const h = Number(this._cssH);
      const dpr = Number(this._dpr || (window.devicePixelRatio || 1));
      // Round to reduce float churn without affecting visual correctness.
      const r = (x, p = 1e6) => (isFinite(x) ? (Math.round(x * p) / p) : x);
      return `${this.themeKey}|${r(z, 1e3)}|${r(lat)}|${r(lon)}|${w}x${h}|dpr:${r(dpr, 1e3)}|pinch:${this._pinchZooming ? 1 : 0}`;
    })();

    let tilesRedrawn = false;
    if (this._lastTilesViewSig !== viewSig) {
      this._lastTilesViewSig = viewSig;
      this.drawTiles();
      tilesRedrawn = true;
    }
    this._compositePaFieldOnTiles(state, tilesRedrawn);
    this.drawOverlay(state, { cacheUnderlay: true });
  }

  /** Clear all per-vehicle caches. Called when switching snapshots to prevent
   *  stale data from prior loads accumulating in memory. */
  clearVehicleCaches() {
    this._tracePtsById = new Map();
    this._tracePtsKey = "";
    this._traceLastSideById = new Map();
    this._traceActiveRouteById = new Map();
    this._tracePendingRouteById = new Map();
    this._traceCycleStartMsById = new Map();
    this._traceInitialRunDoneById = new Map();
    this._traceAngleById = new Map();
    this._traceAngleLastMsById = new Map();
    this._traceSelectionWarpById = new Map();
    this._physicsStateById = new Map();
    this._roadMatchedRangesById = new Map();
    this._roadMatchPending = new Set();
    this._vehicleActualPathById = new Map();
    this._smoothPathCache = new Map();
    this._pathDistCache = new Map();
    this._vehiclePhysicsCache = new Map();
    this._vehiclePathById = new Map();
    this._curveLookaheadCache = new Map();
    this._screenHeadingCache = new Map();
    this._vehicleRevealDist = new Map();
    this._scrubCooldownById = new Map();
    this._trailCacheCanvas = null;
    this._trailCacheViewKey = "";
    this._trailCacheTimeMs = null;
  }

  _prunePerMobileCachesForState(state) {
    // If a mobile disappears from the server payload, drop all cached state for it.
    // This prevents stale routes/pins/trails from being reused if it later returns.
    const mobiles = Array.isArray(state?.mobile) ? state.mobile : [];
    const present = new Set();
    for (const m of mobiles) {
      const id = (m && m.id != null) ? String(m.id) : "";
      if (id) present.add(id);
    }

    const pruneMap = (mp) => {
      if (!mp || typeof mp.entries !== "function") return false;
      let removed = false;
      for (const [id] of mp.entries()) {
        const sid = (id != null) ? String(id) : "";
        if (!sid || present.has(sid)) continue;
        mp.delete(id);
        removed = true;
      }
      return removed;
    };

    let removedAny = false;
    removedAny = pruneMap(this._persistedTrailById) || removedAny;
    removedAny = pruneMap(this._tracePtsById) || removedAny;
    removedAny = pruneMap(this._traceLastSideById) || removedAny;
    removedAny = pruneMap(this._traceActiveRouteById) || removedAny;
    removedAny = pruneMap(this._tracePendingRouteById) || removedAny;
    removedAny = pruneMap(this._traceCycleStartMsById) || removedAny;
    removedAny = pruneMap(this._traceInitialRunDoneById) || removedAny;
    removedAny = pruneMap(this._traceAngleById) || removedAny;
    removedAny = pruneMap(this._traceAngleLastMsById) || removedAny;
    // Playback physics / path caches (added later, were previously missed)
    removedAny = pruneMap(this._vehiclePathById) || removedAny;
    removedAny = pruneMap(this._smoothPathCache) || removedAny;
    removedAny = pruneMap(this._pathDistCache) || removedAny;
    removedAny = pruneMap(this._vehiclePhysicsCache) || removedAny;
    removedAny = pruneMap(this._curveLookaheadCache) || removedAny;
    removedAny = pruneMap(this._screenHeadingCache) || removedAny;
    removedAny = pruneMap(this._vehicleRevealDist) || removedAny;
    removedAny = pruneMap(this._roadMatchedRangesById) || removedAny;
    removedAny = pruneMap(this._scrubCooldownById) || removedAny;
    removedAny = pruneMap(this._physicsStateById) || removedAny;
    removedAny = pruneMap(this._vehicleActualPathById) || removedAny;
    removedAny = pruneMap(this._traceSelectionWarpById) || removedAny;

    if (removedAny) {
      this._persistedTrailRev++;
      this._invalidateOverlayStatic();
    }
  }

  _getPersistedTrailEntry(id) {
    if (!id) return null;
    return this._persistedTrailById.get(String(id)) || null;
  }

  _updatePersistedTrails(state) {
    const mobiles = Array.isArray(state?.mobile) ? state.mobile : [];
    let changed = false;
    const nowMs = performance.now();

    // User request: STOP using arbitrary radius/distance gating for trail persistence.
    // Keep all server-provided points and avoid distance-based "stationary" pin heuristics.
    const DISABLE_DISTANCE_BASED_TRAIL_FILTERS = true;
    const dedupMeters = DISABLE_DISTANCE_BASED_TRAIL_FILTERS ? 0 : 2.0;

    // Online simplification to avoid unbounded point growth from GPS jitter.
    // Keeps the visual path but collapses near-collinear samples.
    const collapseMeters = DISABLE_DISTANCE_BASED_TRAIL_FILTERS ? 0 : 1.6;
    const metersPerDegLat = 111320;
    const perpDistMeters = (a, b, c) => {
      // Distance from b to segment a-c in meters using equirectangular approx.
      const lat0 = Number(a?.lat);
      const lon0 = Number(a?.lon);
      const cl = Math.cos((lat0 * Math.PI) / 180) || 1;
      const ax = 0, ay = 0;
      const bx = (Number(b?.lon) - lon0) * metersPerDegLat * cl;
      const by = (Number(b?.lat) - lat0) * metersPerDegLat;
      const cx = (Number(c?.lon) - lon0) * metersPerDegLat * cl;
      const cy = (Number(c?.lat) - lat0) * metersPerDegLat;
      const abx = bx - ax, aby = by - ay;
      const acx = cx - ax, acy = cy - ay;
      const ac2 = (acx * acx) + (acy * acy);
      if (!(ac2 > 1e-6)) return Infinity;
      // project AB onto AC, clamp to segment.
      let t = ((abx * acx) + (aby * acy)) / ac2;
      t = Math.max(0, Math.min(1, t));
      const px = ax + acx * t;
      const py = ay + acy * t;
      const dx = bx - px;
      const dy = by - py;
      return Math.hypot(dx, dy);
    };

    const lastFinitePoint = (arr) => {
      if (!Array.isArray(arr) || !arr.length) return null;
      for (let i = arr.length - 1; i >= 0; i--) {
        const p = arr[i];
        const lat = Number(p?.lat);
        const lon = Number(p?.lon);
        if (isFinite(lat) && isFinite(lon)) return { lat, lon, t: p?.t };
      }
      return null;
    };

    const shouldAppend = (last, next) => {
      if (!last) return true;
      const lat = Number(next?.lat);
      const lon = Number(next?.lon);
      if (!isFinite(lat) || !isFinite(lon)) return false;
      if (!(dedupMeters > 0)) return true;
      const d = haversineMeters(last.lat, last.lon, lat, lon);
      return (d > dedupMeters);
    };

    const parseTms = (t) => (typeof t === "string") ? parseUtcMs(t) : null;

    const isEffectivelyStationary = (trail, opts) => {
      if (DISABLE_DISTANCE_BASED_TRAIL_FILTERS) return false;
      if (!Array.isArray(trail) || trail.length < 8) return false;
      const tailN = Math.max(8, Math.min(30, Number(opts?.tailN ?? 22)));
      const maxRadiusM = Number(opts?.maxRadiusM ?? 30);
      const maxNetM = Number(opts?.maxNetM ?? 20);
      const minSpanMs = Number(opts?.minSpanMs ?? 60_000);
      if (!(maxRadiusM > 0) || !(maxNetM > 0) || !(tailN > 0)) return false;

      const tail = trail.slice(Math.max(0, trail.length - tailN));
      const lats = [];
      const lons = [];
      for (const p of tail) {
        const lat = Number(p?.lat);
        const lon = Number(p?.lon);
        if (!isFinite(lat) || !isFinite(lon)) continue;
        lats.push(lat);
        lons.push(lon);
      }
      if (lats.length < 6) return false;

      const median = (nums) => {
        const a = nums.slice().sort((x, y) => x - y);
        const mid = Math.floor(a.length / 2);
        return (a.length % 2) ? a[mid] : 0.5 * (a[mid - 1] + a[mid]);
      };
      const latM = median(lats);
      const lonM = median(lons);
      if (!isFinite(latM) || !isFinite(lonM)) return false;

      let maxR = 0;
      for (const p of tail) {
        const lat = Number(p?.lat);
        const lon = Number(p?.lon);
        if (!isFinite(lat) || !isFinite(lon)) continue;
        const d = haversineMeters(latM, lonM, lat, lon);
        if (isFinite(d)) maxR = Math.max(maxR, d);
      }

      const first = lastFinitePoint(tail.slice(0, 1)) || lastFinitePoint(tail);
      const last = lastFinitePoint(tail);
      if (!first || !last) return false;
      const net = haversineMeters(first.lat, first.lon, last.lat, last.lon);

      const t0 = parseTms(tail[0]?.t);
      const t1 = parseTms(tail[tail.length - 1]?.t);
      const spanOk = (t0 != null && t1 != null) ? ((t1 - t0) >= minSpanMs) : (tail.length >= 16);

      return spanOk && (maxR <= maxRadiusM) && (net <= maxNetM);
    };

    // When a bus is parked, GPS jitter accumulates into a "birds nest".
    // Fix by compressing the *entire stationary suffix* into a single stable point.
    // This preserves the approach/arrival path (everything before the stop) and
    // keeps depots/stations working: as soon as the bus truly leaves the radius,
    // the suffix stops being stationary and we stop compressing.
    const collapseParkedSuffix = (trail, opts) => {
      if (!Array.isArray(trail) || trail.length < 12) return false;
      const tailN = Math.max(10, Math.min(40, Number(opts?.tailN ?? 24)));
      const radiusM = Number(opts?.radiusM ?? 38);
      const minPts = Number(opts?.minPts ?? 14);
      const minSpanMs = Number(opts?.minSpanMs ?? 120_000);
      const maxScan = Number(opts?.maxScan ?? 5000);
      const maxTravelM = Number(opts?.maxTravelM ?? 140);
      if (!(radiusM > 0) || !(minPts >= 6) || !(maxScan >= 100) || !(maxTravelM > 0)) return false;

      const median = (nums) => {
        if (!nums.length) return NaN;
        const a = nums.slice().sort((x, y) => x - y);
        const mid = Math.floor(a.length / 2);
        return (a.length % 2) ? a[mid] : 0.5 * (a[mid - 1] + a[mid]);
      };

      // 1) Compute a robust center from the most recent tail.
      const tail = trail.slice(Math.max(0, trail.length - tailN));
      const lats = [];
      const lons = [];
      for (const p of tail) {
        const lat = Number(p?.lat);
        const lon = Number(p?.lon);
        if (!isFinite(lat) || !isFinite(lon)) continue;
        lats.push(lat);
        lons.push(lon);
      }
      if (lats.length < 8) return false;
      const centerLat = median(lats);
      const centerLon = median(lons);
      if (!isFinite(centerLat) || !isFinite(centerLon)) return false;

      // 2) Walk backwards while points remain within radius of the center.
      const start = Math.max(0, trail.length - maxScan);
      let i0 = trail.length - 1;
      while (i0 - 1 >= start) {
        const p = trail[i0 - 1];
        const lat = Number(p?.lat);
        const lon = Number(p?.lon);
        if (!isFinite(lat) || !isFinite(lon)) break;
        const d = haversineMeters(centerLat, centerLon, lat, lon);
        if (!(isFinite(d) && d <= radiusM)) break;
        i0--;
      }

      const suffixLen = trail.length - i0;
      if (suffixLen < minPts) return false;

      // 3) Check time span and "actually parked" by path length.
      const t0 = parseTms(trail[i0]?.t);
      const t1 = parseTms(trail[trail.length - 1]?.t);
      if (t0 != null && t1 != null && (t1 - t0) < minSpanMs) return false;

      let travel = 0;
      for (let k = i0 + 1; k < trail.length; k++) {
        const a = trail[k - 1];
        const b = trail[k];
        const d = haversineMeters(Number(a?.lat), Number(a?.lon), Number(b?.lat), Number(b?.lon));
        if (isFinite(d)) travel += d;
        if (travel > maxTravelM) return false; // moving around, don't collapse
      }

      // 4) Collapse the suffix to two points: entry + stable parked point.
      // Keep the entry point (trail[i0]) so the arrival path still connects.
      const last = trail[trail.length - 1];
      const rep = {
        lat: centerLat,
        lon: centerLon,
        t: (last && typeof last.t === "string") ? last.t : undefined,
        readings: (last && last.readings && typeof last.readings === "object") ? last.readings : undefined,
      };

      // Replace points after the entry with the representative.
      const deleteCount = trail.length - (i0 + 1);
      if (deleteCount <= 1) {
        // Nothing substantial to collapse.
        return false;
      }
      trail.splice(i0 + 1, deleteCount, rep);
      return true;
    };

    // Remove short out-and-back GPS spikes from an otherwise stationary cluster.
    // Pattern:
    // - A -> B far away
    // - B -> C far away
    // - A -> C close (returned)
    // Optionally handles a 2-point excursion (A -> B -> C -> D where A~D and B~C).
    const scrubReturnSpikes = (trail, opts) => {
      if (!Array.isArray(trail) || trail.length < 4) return false;
      const outM = Number(opts?.outM ?? 45);
      const retM = Number(opts?.retM ?? 18);
      const plateauM = Number(opts?.plateauM ?? 25);
      const maxSpanMs = Number(opts?.maxSpanMs ?? 180_000);
      const maxScan = Number(opts?.maxScan ?? 1200);
      if (!(outM > 0) || !(retM > 0) || !(plateauM > 0) || !(maxSpanMs >= 0) || !(maxScan >= 20)) return false;

      const n0 = trail.length;
      const start = Math.max(1, n0 - maxScan);
      let changedLocal = false;

      const tmsAt = (idx) => {
        const t = trail[idx]?.t;
        const ms = parseTms(t);
        return (ms != null && isFinite(ms)) ? ms : null;
      };

      // First pass: single-point excursion A-B-C.
      for (let i = start; i < trail.length - 1; i++) {
        const a = trail[i - 1];
        const b = trail[i];
        const c = trail[i + 1];
        if (!a || !b || !c) continue;
        const dAB = haversineMeters(Number(a.lat), Number(a.lon), Number(b.lat), Number(b.lon));
        const dBC = haversineMeters(Number(b.lat), Number(b.lon), Number(c.lat), Number(c.lon));
        const dAC = haversineMeters(Number(a.lat), Number(a.lon), Number(c.lat), Number(c.lon));
        if (!(isFinite(dAB) && isFinite(dBC) && isFinite(dAC))) continue;

        if (dAB >= outM && dBC >= outM && dAC <= retM) {
          const ta = tmsAt(i - 1);
          const tc = tmsAt(i + 1);
          if (ta != null && tc != null && (tc - ta) > maxSpanMs) continue;
          trail.splice(i, 1);
          changedLocal = true;
          i = Math.max(start, i - 2);
        }
      }

      // Second pass: two-point excursion A-B-C-D.
      for (let i = start; i < trail.length - 2; i++) {
        const a = trail[i - 1];
        const b = trail[i];
        const c = trail[i + 1];
        const d = trail[i + 2];
        if (!a || !b || !c || !d) continue;
        const dAB = haversineMeters(Number(a.lat), Number(a.lon), Number(b.lat), Number(b.lon));
        const dBC = haversineMeters(Number(b.lat), Number(b.lon), Number(c.lat), Number(c.lon));
        const dCD = haversineMeters(Number(c.lat), Number(c.lon), Number(d.lat), Number(d.lon));
        const dAD = haversineMeters(Number(a.lat), Number(a.lon), Number(d.lat), Number(d.lon));
        if (!(isFinite(dAB) && isFinite(dBC) && isFinite(dCD) && isFinite(dAD))) continue;

        if (dAB >= outM && dCD >= outM && dAD <= retM && dBC <= plateauM) {
          const ta = tmsAt(i - 1);
          const td = tmsAt(i + 2);
          if (ta != null && td != null && (td - ta) > maxSpanMs) continue;
          trail.splice(i, 2);
          changedLocal = true;
          i = Math.max(start, i - 2);
        }
      }

      return changedLocal;
    };

    // Collapse stationary GPS jitter into a single stable point.
    // This fixes the "birds nest" when a bus is parked but GPS jitters.
    // It is per-bus and purely motion-based (so depots/stations are fine:
    // buses that truly leave will immediately exceed the radius and keep paths).
    const collapseStationaryClusters = (trail, opts) => {
      if (!Array.isArray(trail) || trail.length < 6) return false;
      const radiusM = Number(opts?.radiusM ?? 22);
      const minPts = Number(opts?.minPts ?? 10);
      const minSpanMs = Number(opts?.minSpanMs ?? 90_000);
      const maxScan = Number(opts?.maxScan ?? 1800);
      if (!(radiusM > 0) || !(minPts >= 3) || !(minSpanMs >= 0) || !(maxScan >= 50)) return false;

      const n = trail.length;
      const start = Math.max(0, n - maxScan);
      let changedLocal = false;

      const median = (nums) => {
        if (!nums.length) return NaN;
        const a = nums.slice().sort((x, y) => x - y);
        const mid = Math.floor(a.length / 2);
        return (a.length % 2) ? a[mid] : 0.5 * (a[mid - 1] + a[mid]);
      };

      const collapseRange = (i0, i1) => {
        // Collapse [i0, i1] inclusive into a single point placed at median(lat/lon).
        // Keep the latest timestamp/readings so the UI still reflects fresh data.
        const pts = trail.slice(i0, i1 + 1);
        const lats = [];
        const lons = [];
        for (const p of pts) {
          const lat = Number(p?.lat);
          const lon = Number(p?.lon);
          if (!isFinite(lat) || !isFinite(lon)) continue;
          lats.push(lat);
          lons.push(lon);
        }
        if (lats.length < 2) return false;
        const latM = median(lats);
        const lonM = median(lons);
        if (!isFinite(latM) || !isFinite(lonM)) return false;

        const last = pts[pts.length - 1];
        const rep = {
          lat: latM,
          lon: lonM,
          t: (last && typeof last.t === "string") ? last.t : undefined,
          readings: (last && last.readings && typeof last.readings === "object") ? last.readings : undefined,
        };
        trail.splice(i0, (i1 - i0 + 1), rep);
        return true;
      };

      // Scan for runs that stay within radius of their first point.
      // Any long-enough run is considered a stationary cluster.
      let i = start;
      while (i < trail.length - 1) {
        const p0 = trail[i];
        const lat0 = Number(p0?.lat);
        const lon0 = Number(p0?.lon);
        if (!isFinite(lat0) || !isFinite(lon0)) {
          i++;
          continue;
        }

        let j = i;
        let t0 = parseTms(p0?.t);
        let t1 = t0;
        while (j + 1 < trail.length) {
          const pj = trail[j + 1];
          const lat = Number(pj?.lat);
          const lon = Number(pj?.lon);
          if (!isFinite(lat) || !isFinite(lon)) break;
          const d = haversineMeters(lat0, lon0, lat, lon);
          if (!(d <= radiusM)) break;
          j++;
          const tj = parseTms(pj?.t);
          if (tj != null) t1 = tj;
        }

        const runLen = j - i + 1;
        const spanOk = (t0 != null && t1 != null) ? ((t1 - t0) >= minSpanMs) : (runLen >= (minPts * 2));
        if (runLen >= minPts && spanOk) {
          if (collapseRange(i, j)) {
            changedLocal = true;
            // After collapsing, continue from the collapsed point.
            i = Math.max(start, i - 1);
            continue;
          }
        }

        i = j + 1;
      }

      return changedLocal;
    };

    const mergeByTimestamp = (existingTrail, incomingTrail) => {
      // Append only points newer than our last timestamp (keeps growth even if server window is small).
      // If timestamps are missing/unparseable, we fall back to distance-based dedup.
      if (!Array.isArray(incomingTrail) || !incomingTrail.length) return false;
      if (!Array.isArray(existingTrail)) existingTrail = [];

      const last = lastFinitePoint(existingTrail);
      let cutoffTms = last && last.t ? parseTms(last.t) : null;
      let appended = 0;

      for (const p of incomingTrail) {
        const lat = Number(p?.lat);
        const lon = Number(p?.lon);
        if (!isFinite(lat) || !isFinite(lon)) continue;
        const tms = p?.t ? parseTms(p.t) : null;

        if (cutoffTms != null && tms != null) {
          if (tms <= cutoffTms) continue;
          existingTrail.push(p);
          appended++;
          cutoffTms = tms;
          continue;
        }

        const last2 = lastFinitePoint(existingTrail);
        if (!shouldAppend(last2, p)) continue;
        existingTrail.push(p);
        appended++;
      }

      return appended;
    };

    const tailMedianLatLon = (trail, tailN) => {
      if (!Array.isArray(trail) || !trail.length) return null;

      const median = (nums) => {
        if (!nums.length) return NaN;
        const a = nums.slice().sort((x, y) => x - y);
        const mid = Math.floor(a.length / 2);
        return (a.length % 2) ? a[mid] : 0.5 * (a[mid - 1] + a[mid]);
      };

      const n = Math.max(6, Math.min(60, Number(tailN || 24)));
      const tail = trail.slice(Math.max(0, trail.length - n));
      const lats = [];
      const lons = [];
      for (const p of tail) {
        const lat = Number(p?.lat);
        const lon = Number(p?.lon);
        if (!isFinite(lat) || !isFinite(lon)) continue;
        lats.push(lat);
        lons.push(lon);
      }
      if (lats.length < 6) return null;
      const latM = median(lats);
      const lonM = median(lons);
      if (!isFinite(latM) || !isFinite(lonM)) return null;
      return { lat: latM, lon: lonM };
    };

    const clearPerId = (id) => {
      const sid = (id != null) ? String(id) : "";
      if (!sid) return false;
      let any = false;
      const del = (mp) => {
        if (mp && typeof mp.delete === "function") {
          const had = mp.has ? mp.has(sid) : true;
          mp.delete(sid);
          return !!had;
        }
        return false;
      };

      any = del(this._persistedTrailById) || any;
      any = del(this._tracePtsById) || any;
      any = del(this._traceLastSideById) || any;
      any = del(this._traceActiveRouteById) || any;
      any = del(this._tracePendingRouteById) || any;
      any = del(this._traceCycleStartMsById) || any;
      any = del(this._traceInitialRunDoneById) || any;
      any = del(this._traceAngleById) || any;
      any = del(this._traceAngleLastMsById) || any;
      any = del(this._traceSelectionWarpById) || any;
      return any;
    };

    for (const m of mobiles) {
      const id = (m && m.id != null) ? String(m.id) : "";
      if (!id) continue;

      const serverTrail = Array.isArray(m?.trail) ? m.trail : [];
      const prev = this._persistedTrailById.get(id) || { trail: [], color: null, ghosted: false, parked: false, pin: null };

      // Trails now persist at the data level (server-side).
      // If the server trail is empty and we have no previous trail, skip.
      if (serverTrail.length < 2 && !prev.trail.length) {
        continue;
      }

      // Trust the server's trail directly for the historical record.
      const lastServerT = serverTrail.length ? serverTrail[serverTrail.length - 1]?.t : null;
      const lastPrevT = prev.trail.length ? prev.trail[prev.trail.length - 1]?.t : null;
      const serverGrew = (serverTrail.length > prev.trail.length) || (lastServerT !== lastPrevT && lastServerT !== null);

      let nextTrail = serverTrail;
      if (nextTrail.length > this.maxTrailLen) {
        nextTrail = nextTrail.slice(-this.maxTrailLen);
      }
      const appendedCount = serverGrew ? Math.max(1, nextTrail.length - prev.trail.length) : 0;

      // Parked marker debounce (existing logic, simplified).
      const prevPin = prev && prev.pin && isFinite(Number(prev.pin.lat)) && isFinite(Number(prev.pin.lon))
        ? { lat: Number(prev.pin.lat), lon: Number(prev.pin.lon) }
        : null;
      let nextPin = prevPin;
      const prevGhosted = !!prev?.ghosted;
      const nextGhosted = !!m?.ghosted;
      const prevParked = !!prev?.parked;
      const nextParked = !!m?.parked;

      // Pins are used only for the parked display (not for offline sensors).
      nextPin = null;
      if (!nextGhosted) {
        if (nextParked) {
          nextPin = tailMedianLatLon(nextTrail, 24);
        } else {
          // Fallback: if server doesn't provide parked, use a strict parked heuristic.
          const stationary = isEffectivelyStationary(nextTrail, { tailN: 28, maxRadiusM: 42, maxNetM: 30, minSpanMs: 900_000 });
          if (stationary) nextPin = tailMedianLatLon(nextTrail, 24);
        }
      }

      const pinChanged = (Boolean(prevPin) !== Boolean(nextPin))
        || (prevPin && nextPin && (haversineMeters(prevPin.lat, prevPin.lon, nextPin.lat, nextPin.lon) > 1.0));

      const nextColor = safeHex(m.ci);
      const metaChanged = (prev.color !== nextColor) || (prev.ghosted !== nextGhosted) || (prevParked !== nextParked);

      if (appendedCount > 0 || metaChanged || pinChanged) {
        this._persistedTrailById.set(id, { trail: nextTrail, color: nextColor, ghosted: nextGhosted, parked: nextParked, pin: nextPin });
        changed = true;
      }
    }

    if (changed) {
      this._persistedTrailRev++;
    }
  }

  drawTiles() {
    const ctx = this.tctx;
    if (!ctx) return;
    // Avoid per-frame layout reads during panning.
    const w = this._cssW || 1;
    const h = this._cssH || 1;
    const dpr = this._dpr || (window.devicePixelRatio || 1);

    // Reset transform to canonical dpr-scaled state to prevent scaling bugs
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const c = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
    const ws = c.ws;

    // Backdrop: reuse previous frame so *panning* doesn't flicker while tiles stream in.
    // During active pinch/inertia we also reuse+scale the snapshot (fast path) so zooming
    // is closer to the OS-native feel and doesn't spend time drawing N tiles every event.
    const hasSnapshot = !!(this._tilesSnapshotCanvas && this._tilesSnapshotMeta);
    ctx.clearRect(0, 0, w, h);
    if (hasSnapshot) {
      try {
        const prev = this._tilesSnapshotMeta;
        ctx.save();
        if (this._pinchZooming) {
          // Scale around the screen center; also translate for center changes.
          const sZoom = Math.pow(2, this.zoom - prev.zoom);
          const prevC = latLonToWorld(prev.centerLat, prev.centerLon, prev.zoom);
          const currC = latLonToWorld(this.center.lat, this.center.lon, prev.zoom);
          const txPan = (prevC.x - currC.x) * sZoom;
          const tyPan = (prevC.y - currC.y) * sZoom;
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.translate(w / 2, h / 2);
          ctx.scale(sZoom, sZoom);
          ctx.translate((-w / 2) + (txPan / sZoom), (-h / 2) + (tyPan / sZoom));
          ctx.drawImage(this._tilesSnapshotCanvas, 0, 0, w, h);
          ctx.restore();
          // Fast path: don't draw individual tiles while pinch-zooming. We'll do a full tiles
          // render once the gesture/inertia completes.
          return;
        }

        // Non-pinch: translate-only (same integer zoom snapshots).
        if (Math.floor(prev.zoom) !== Math.floor(this.zoom)) throw new Error("zoom changed");
        const prevC = latLonToWorld(prev.centerLat, prev.centerLon, prev.zoom);
        const currC = latLonToWorld(this.center.lat, this.center.lon, prev.zoom);
        const tx = (prevC.x - currC.x);
        const ty = (prevC.y - currC.y);
        ctx.setTransform(dpr, 0, 0, dpr, dpr * tx, dpr * ty);
        ctx.drawImage(this._tilesSnapshotCanvas, 0, 0, w, h);
        ctx.restore();
      } catch {
        // ignore snapshot issues
      }
    }

    const topLeftX = c.x - w / 2;
    const topLeftY = c.y - h / 2;

    // Use integer tile zoom for fetching, scaled to fractional zoom.
    const tileZ = clamp(Math.floor(this.zoom), this._zoomMin, this._zoomMax);
    const s = Math.pow(2, this.zoom - tileZ); // scale factor from tileZ world to zoom world

    const topLeftX_Z = topLeftX / s;
    const topLeftY_Z = topLeftY / s;
    const w_Z = w / s;
    const h_Z = h / s;

    const minTileX = Math.floor(topLeftX_Z / TILE_SIZE);
    const minTileY = Math.floor(topLeftY_Z / TILE_SIZE);
    const maxTileX = Math.floor((topLeftX_Z + w_Z) / TILE_SIZE);
    const maxTileY = Math.floor((topLeftY_Z + h_Z) / TILE_SIZE);

    const tilesPerAxis = Math.pow(2, tileZ);
    for (let ty = minTileY; ty <= maxTileY; ty++) {
      if (ty < 0 || ty >= tilesPerAxis) continue;
      for (let tx = minTileX; tx <= maxTileX; tx++) {
        // wrap X
        let wrappedX = tx;
        while (wrappedX < 0) wrappedX += tilesPerAxis;
        while (wrappedX >= tilesPerAxis) wrappedX -= tilesPerAxis;

        // IMPORTANT: key includes theme to prevent "checkerboard" mixing when switching themes.
        const key = `${this.themeKey}:${tileZ}/${wrappedX}/${ty}`;
        const px = (tx * TILE_SIZE * s) - topLeftX;
        const py = (ty * TILE_SIZE * s) - topLeftY;

        this.drawTile(ctx, key, tileZ, wrappedX, ty, px, py, s, hasSnapshot);
      }
    }

    // Capture snapshot for the next frame - but skip during active touch to avoid blocking input.
    if (!this._touchActive) this._captureTilesSnapshot();
  }

  /** Capture the tiles canvas into a snapshot for smooth pan/zoom transitions. */
  _captureTilesSnapshot() {
    try {
      const tw = this.tilesCanvas.width;
      const th = this.tilesCanvas.height;
      if (!this._tilesSnapshotCanvas) {
        this._tilesSnapshotCanvas = document.createElement("canvas");
        this._tilesSnapshotCanvas.width = tw;
        this._tilesSnapshotCanvas.height = th;
      } else if (this._tilesSnapshotCanvas.width !== tw || this._tilesSnapshotCanvas.height !== th) {
        this._tilesSnapshotCanvas.width = tw;
        this._tilesSnapshotCanvas.height = th;
      }
      const sctx = this._tilesSnapshotCanvas.getContext("2d");
      if (sctx) {
        sctx.setTransform(1, 0, 0, 1, 0, 0);
        sctx.clearRect(0, 0, tw, th);
        sctx.drawImage(this.tilesCanvas, 0, 0);
        this._tilesSnapshotMeta = { zoom: this.zoom, centerLat: this.center.lat, centerLon: this.center.lon };
      }
    } catch {
      // ignore snapshot capture errors
    }
  }

  _tileCacheGet(key) {
    if (!this.tileCache || !key) return null;
    const v = this.tileCache.get(key) || null;
    if (!v) return null;
    // LRU: refresh insertion order.
    this.tileCache.delete(key);
    this.tileCache.set(key, v);
    return v;
  }

  _tileCacheSet(key, value) {
    if (!this.tileCache || !key) return;
    if (this.tileCache.has(key)) this.tileCache.delete(key);
    this.tileCache.set(key, value);
    const max = (typeof this._tileCacheMax === "number" && isFinite(this._tileCacheMax) && this._tileCacheMax > 0)
      ? Math.floor(this._tileCacheMax)
      : 420;
    while (this.tileCache.size > max) {
      const oldestKey = this.tileCache.keys().next().value;
      if (oldestKey == null) break;
      this.tileCache.delete(oldestKey);
    }
  }

  drawTile(ctx, key, z, x, y, px, py, scale, hasSnapshot) {
    const cached = this._tileCacheGet(key);
    if (cached && cached.ok) {
      const sz = TILE_SIZE * scale;
      ctx.filter = "none";
      ctx.drawImage(cached.img, Math.floor(px), Math.floor(py), Math.ceil(sz), Math.ceil(sz));
      return;
    }

    if (!cached) {
      const img = new Image();
      const epoch = this._tileEpoch;
      img.crossOrigin = "anonymous";
      img.onload = () => {
        if (epoch !== this._tileEpoch) return;
        this._tileCacheSet(key, { img, ok: true });
        this._scheduleTileRedraw();
      };
      img.onerror = () => {
        if (epoch !== this._tileEpoch) return;
        this._tileCacheSet(key, { img, ok: false });
      };
      const subs = this.tileSubdomains || [""];
      const sub = subs[(x + y) % subs.length] || "";
      img.src = this.tileTemplate
        .replace("{s}", sub)
        .replace("{z}", z)
        .replace("{x}", x)
        .replace("{y}", y);
      if (epoch === this._tileEpoch) this._tileCacheSet(key, { img, ok: false });
    }

    // Tile not ready yet — try to draw a parent tile (lower zoom) scaled up as fallback.
    // Walk up zoom levels to find a cached ancestor tile covering this area.
    for (let pz = z - 1; pz >= Math.max(z - 4, this._zoomMin); pz--) {
      const diff = z - pz;
      const parentX = x >> diff;
      const parentY = y >> diff;
      const parentKey = `${this.themeKey}:${pz}/${parentX}/${parentY}`;
      const parentCached = this._tileCacheGet(parentKey);
      if (parentCached && parentCached.ok) {
        // Draw the sub-region of the parent tile that corresponds to this tile.
        const subScale = 1 << diff;
        const subX = x - (parentX << diff);
        const subY = y - (parentY << diff);
        const srcSize = TILE_SIZE / subScale;
        const srcX = subX * srcSize;
        const srcY = subY * srcSize;
        const sz = TILE_SIZE * scale;
        ctx.filter = "none";
        ctx.drawImage(parentCached.img, srcX, srcY, srcSize, srcSize,
          Math.floor(px), Math.floor(py), Math.ceil(sz), Math.ceil(sz));
        return;
      }
    }

    // No parent available — only draw placeholder if there's no snapshot backdrop.
    if (!hasSnapshot) {
      const sz = TILE_SIZE * scale;
      ctx.fillStyle = "rgba(255,255,255,0.03)";
      ctx.fillRect(Math.floor(px), Math.floor(py), Math.ceil(sz), Math.ceil(sz));
      ctx.strokeStyle = "rgba(255,255,255,0.04)";
      ctx.strokeRect(Math.floor(px), Math.floor(py), Math.ceil(sz), Math.ceil(sz));
    }
  }

  _scheduleTileRedraw() {
    // Debounce tile-load redraws: wait a short time for more tiles to finish loading
    // before redrawing, to avoid N separate redraws when N tiles load in quick succession.
    if (this._touchActive) {
      // Mark pending so tiles redraw when touch ends
      this._tileRedrawPending = true;
      return;
    }
    if (this._tileLoadRedrawTimer) return; // already scheduled
    this._tileLoadRedrawTimer = setTimeout(() => {
      this._tileLoadRedrawTimer = null;
      this.drawTiles();
    }, 50);
  }

  _tracePointsKeyForState(state) {
    const rev = state?.meta?.server_revision;
    if (typeof rev === "number" && isFinite(rev)) return `rev:${rev}`;
    const ts = state?.ts;
    if (typeof ts === "number" && isFinite(ts)) return `ts:${ts}`;
    return `obj:${state ? 1 : 0}`;
  }

  _playbackPointsKeyForState(state) {
    const revKey = this._tracePointsKeyForState(state);
    // Include trail point count per sensor to detect data changes
    let trailSig = "";
    const mobiles = Array.isArray(state?.mobile) ? state.mobile : [];
    for (const m of mobiles) {
      const id = m?.id || "";
      const trail = Array.isArray(m?.trail) ? m.trail : [];
      const lastT = trail.length > 0 ? (trail[trail.length - 1]?.t || "") : "";
      trailSig += `${id}:${trail.length}:${lastT}|`;
    }
    return `${revKey}|persist:${this._persistedTrailRev}|trail:${trailSig}|v3`;
  }

  _ensurePlaybackPoints(state) {
    const key = this._playbackPointsKeyForState(state);
    const cacheHit = (this._playbackPtsKey === key);
    
    // Cache key includes trail signatures, so if data changed the key will differ.
    if (cacheHit) {
      return;
    }
    
    // Rebuild playback points on cache miss
    this._playbackPtsKey = key;
    
    const nextPtsById = new Map();
    let minMs = Infinity;
    let maxMs = -Infinity;

    // Live playback is "today only"; clamp the window start to 5:00 AM Mountain Time.
    // Use wall-clock time (not data timestamps) to determine what "today" means,
    // so the scrub range stays anchored even when buses aren't running.
    const liveDayStartMs = (!this._historicalMode)
      ? (() => {
          // Get current date/time in Mountain Time via toLocaleString.
          // This survives JS obfuscation (no property-name lookups on Intl objects).
          const mtStr = new Date().toLocaleString("en-US", { timeZone: "America/Denver", hour12: false });
          // Format: "M/D/YYYY, HH:MM:SS"
          const parts = mtStr.split(/[/,: ]+/);
          const mtMonth = Number(parts[0]) - 1;
          const mtDay = Number(parts[1]);
          const mtYear = Number(parts[2]);
          const mtHour = Number(parts[3]);

          // Build 5:00 AM Mountain Time as an epoch-ms value.
          // Create a local Date for the MT calendar date at noon, then use
          // toLocaleString round-trip to derive the UTC offset for that day.
          const noonLocal = new Date(mtYear, mtMonth, mtDay, 12, 0, 0, 0);
          const noonUtcStr = noonLocal.toLocaleString("en-US", { timeZone: "UTC", hour12: false });
          const utcParts = noonUtcStr.split(/[/,: ]+/);
          const noonUtcRecon = new Date(Date.UTC(
            Number(utcParts[2]), Number(utcParts[0]) - 1, Number(utcParts[1]),
            Number(utcParts[3]), Number(utcParts[4]), Number(utcParts[5])
          ));
          const offsetMs = noonUtcRecon.getTime() - noonLocal.getTime();

          // 5 AM MT = local-constructed 5 AM + offset
          let fiveAmMs = new Date(mtYear, mtMonth, mtDay, 5, 0, 0, 0).getTime() + offsetMs;

          // If it's currently before 5 AM MT, the window started at yesterday's 5 AM.
          if (mtHour < 5) {
            fiveAmMs -= 86400000;
          }

          return isFinite(fiveAmMs) ? fiveAmMs : null;
        })()
      : null;

    const mobiles = Array.isArray(state?.mobile) ? state.mobile : [];
    for (const m of mobiles) {
      const id = m && m.id != null ? String(m.id) : "";
      if (!id) continue;

      // In playback mode, always prefer server trail for fresh readings/colors.
      // Persisted trail is only used in non-playback live mode for continuity.
      const serverTrail = Array.isArray(m?.trail) ? m.trail : [];
      const persisted = (this._historicalMode || this.playbackMode) ? [] : (this._persistedTrailById.get(id)?.trail || []);
      const src = (serverTrail.length >= 2) ? serverTrail : (persisted.length >= 2 ? persisted : serverTrail);
      if (!Array.isArray(src) || src.length < 2) continue;

      const pts = [];
      for (const p of src) {
        const lat = Number(p?.lat);
        const lon = Number(p?.lon);
        if (!isFinite(lat) || !isFinite(lon)) continue;
        const tMs = (p && typeof p.t === "string") ? parseUtcMs(p.t) : null;
        if (tMs == null || !isFinite(tMs)) continue;
        pts.push({ lat, lon, tMs, m: p.m, readings: p.readings });
      }
      if (pts.length >= 1) {
        // GPS data almost always arrives chronologically. Verify before
        // paying for a full O(n log n) sort — a linear O(n) check is cheap.
        let sorted = true;
        for (let k = 1; k < pts.length; k++) {
          if (pts[k].tMs < pts[k - 1].tMs) { sorted = false; break; }
        }
        if (!sorted) pts.sort((a, b) => a.tMs - b.tMs);

        let filtered = pts;
        if (liveDayStartMs != null && isFinite(liveDayStartMs)) {
          // Binary search for liveDayStartMs instead of filter() over entire array
          let lo = 0, hi = pts.length;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (pts[mid].tMs < liveDayStartMs) lo = mid + 1; else hi = mid;
          }
          filtered = lo > 0 ? pts.slice(lo) : pts;
        }
        if (!Array.isArray(filtered) || filtered.length < 2) {
          continue;
        }

        // Update timeline bounds from ALL data points (before movement filter)
        minMs = Math.min(minMs, filtered[0].tMs);
        maxMs = Math.max(maxMs, filtered[filtered.length - 1].tMs);

        // Only add to playback points if there's actual movement (not just GPS jitter)
        let totalM = 0;
        for (let i = 1; i < filtered.length; i++) {
          const a = filtered[i - 1];
          const b = filtered[i];
          const d = haversineMeters(a.lat, a.lon, b.lat, b.lon);
          if (isFinite(d)) totalM += d;
          if (totalM >= MapView.MIN_TRAIL_LENGTH_M) break;
        }
        if (totalM >= MapView.MIN_TRAIL_LENGTH_M) {
          nextPtsById.set(id, filtered);
        }
      }
    }

    this._playbackPtsById = nextPtsById;
    
    // Use server meta timestamps as fallback when no trails qualify
    const serverStartMs = state?.meta?.trail_update_start_ms;
    const serverEndMs = state?.meta?.trail_update_end_ms;
    
    if (!isFinite(minMs) && typeof serverStartMs === "number" && isFinite(serverStartMs)) {
      minMs = serverStartMs;
    }
    if (!isFinite(maxMs) && typeof serverEndMs === "number" && isFinite(serverEndMs)) {
      maxMs = serverEndMs;
    }
    // Also extend maxMs if server has newer data
    if (isFinite(maxMs) && typeof serverEndMs === "number" && isFinite(serverEndMs) && serverEndMs > maxMs) {
      maxMs = serverEndMs;
    }

    // In live mode, if fixed sensors exist but mobile data is stale,
    // extend the timeline to now so playback doesn't freeze.
    if (!this._historicalMode) {
      const fixed = Array.isArray(state?.fixed) ? state.fixed : [];
      if (fixed.length > 0) {
        const nowMs = Date.now();
        if (!isFinite(minMs)) {
          // No mobile trail data at all -- anchor to server start or 1h ago
          minMs = (typeof serverStartMs === "number" && isFinite(serverStartMs))
            ? serverStartMs : (nowMs - 3600000);
        }
        if (!isFinite(maxMs) || nowMs > maxMs) {
          maxMs = nowMs;
        }
      }
    }

    // In historical mode with no mobile trails (e.g. weekend with buses off),
    // derive a 5AM-to-5AM window from the snapshot date so fixed sensors
    // still render and the playback UI isn't frozen.
    if (this._historicalMode && !isFinite(minMs)) {
      const dateStr = state?.meta?.date || this._historicalDateStr;
      if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        const [y, mo, d] = dateStr.split("-").map(Number);
        // 5 AM local on snapshot day to 5 AM next day
        minMs = new Date(y, mo - 1, d, 5, 0, 0, 0).getTime();
        maxMs = minMs + 86400000;
      }
    }
    
    this._playbackMinMs = isFinite(minMs) ? minMs : null;
    this._playbackMaxMs = isFinite(maxMs) ? maxMs : null;

    // Track maxMs for other uses
    this._playbackLastMaxMs = this._playbackMaxMs;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // DEBUG: Fetch road graph edges for visualization
  // ─────────────────────────────────────────────────────────────────────────────
  
  async _fetchRoadEdgesForViewport() {
    if (!this._pbDebugPath || !this._pbDebugRoadLines) return;
    if (this._roadEdgesFetching) return;
    
    // Get viewport bounds
    const rect = this.overlayCanvas.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    const centerW = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
    
    // Convert corners to lat/lon
    const tl = worldToLatLon(centerW.x - w/2, centerW.y - h/2, this.zoom);
    const br = worldToLatLon(centerW.x + w/2, centerW.y + h/2, this.zoom);
    
    const minLat = Math.min(tl.lat, br.lat);
    const maxLat = Math.max(tl.lat, br.lat);
    const minLon = Math.min(tl.lon, br.lon);
    const maxLon = Math.max(tl.lon, br.lon);
    
    // Don't refetch if viewport hasn't changed much
    const key = `${minLat.toFixed(3)},${maxLat.toFixed(3)},${minLon.toFixed(3)},${maxLon.toFixed(3)}`;
    if (this._roadEdgesLastKey === key) return;
    
    this._roadEdgesFetching = true;
    
    try {
      const url = `${appConfig.apiBaseUrl}/road_edges?minLat=${minLat}&maxLat=${maxLat}&minLon=${minLon}&maxLon=${maxLon}&limit=8000`;
      const resp = await fetch(url);
      if (!resp.ok) return;
      const data = await resp.json();
      this._roadGraphEdges = data.edges || [];
      this._roadEdgesLastKey = key;
      // Trigger redraw
      this.drawOverlay(this.lastState);
    } catch (e) {
      console.warn("Failed to fetch road edges:", e);
    } finally {
      this._roadEdgesFetching = false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Walk between server-assigned edges (no re-snapping)
  // ─────────────────────────────────────────────────────────────────────────────
  
  _walkBetweenServerEdges(t0, t1, edges, toScreen) {
    // t0 and t1 have ea=[lat,lon] and eb=[lat,lon] from server
    // Walk from t0's position to t1's position along track edges
    
    const distM = (lat1, lon1, lat2, lon2) => {
      const dlat = (lat2 - lat1) * 111000;
      const dlon = (lon2 - lon1) * 111000 * Math.cos(lat1 * Math.PI / 180);
      return Math.hypot(dlat, dlon);
    };
    
    const coordsMatch = (a, b, threshold = 0.0001) => {
      return Math.abs(a[0] - b[0]) < threshold && Math.abs(a[1] - b[1]) < threshold;
    };
    
    // Start point and its edge
    const startLat = t0.lat, startLon = t0.lon;
    const startEa = t0.ea, startEb = t0.eb;
    
    // End point and its edge
    const endLat = t1.lat, endLon = t1.lon;
    const endEa = t1.ea, endEb = t1.eb;
    
    // If on same edge, just return the two points
    if (coordsMatch(startEa, endEa) && coordsMatch(startEb, endEb)) {
      return [toScreen(startLat, startLon), toScreen(endLat, endLon)];
    }
    if (coordsMatch(startEa, endEb) && coordsMatch(startEb, endEa)) {
      return [toScreen(startLat, startLon), toScreen(endLat, endLon)];
    }
    
    // Find shared vertex between start and end edges
    let sharedVertex = null;
    if (coordsMatch(startEb, endEa)) sharedVertex = startEb;
    else if (coordsMatch(startEb, endEb)) sharedVertex = startEb;
    else if (coordsMatch(startEa, endEa)) sharedVertex = startEa;
    else if (coordsMatch(startEa, endEb)) sharedVertex = startEa;
    
    if (sharedVertex) {
      // Direct connection through shared vertex
      return [
        toScreen(startLat, startLon),
        toScreen(sharedVertex[0], sharedVertex[1]),
        toScreen(endLat, endLon)
      ];
    }
    
    // Need to walk through intermediate edges
    // Find which endpoint of start edge is closer to end
    const d1 = distM(startEa[0], startEa[1], endLat, endLon);
    const d2 = distM(startEb[0], startEb[1], endLat, endLon);
    let current = d1 < d2 ? startEa : startEb;
    
    const path = [toScreen(startLat, startLon)];
    const visited = new Set();
    visited.add(`${startEa[0]},${startEa[1]}-${startEb[0]},${startEb[1]}`);
    
    const CONNECT_THRESH = 0.0003; // ~30m in degrees
    
    for (let step = 0; step < 50; step++) {
      path.push(toScreen(current[0], current[1]));
      
      // Check if we reached end edge
      if (coordsMatch(current, endEa, CONNECT_THRESH) || coordsMatch(current, endEb, CONNECT_THRESH)) {
        path.push(toScreen(endLat, endLon));
        return path;
      }
      
      // Find connected edge closest to destination
      let bestEdge = null;
      let bestDist = Infinity;
      let bestNext = null;
      
      for (const e of edges) {
        const key = `${e.lat1},${e.lon1}-${e.lat2},${e.lon2}`;
        if (visited.has(key)) continue;
        
        const e1 = [e.lat1, e.lon1];
        const e2 = [e.lat2, e.lon2];
        
        // Check if edge connects to current position
        let nextPt = null;
        if (coordsMatch(current, e1, CONNECT_THRESH)) nextPt = e2;
        else if (coordsMatch(current, e2, CONNECT_THRESH)) nextPt = e1;
        
        if (nextPt) {
          const dist = distM(nextPt[0], nextPt[1], endLat, endLon);
          if (dist < bestDist) {
            bestDist = dist;
            bestEdge = e;
            bestNext = nextPt;
          }
        }
      }
      
      if (!bestEdge) {
        // Stuck - return what we have plus end point
        if (distM(current[0], current[1], endLat, endLon) < 200) {
          path.push(toScreen(endLat, endLon));
          return path;
        }
        return null; // Can't complete path
      }
      
      visited.add(`${bestEdge.lat1},${bestEdge.lon1}-${bestEdge.lat2},${bestEdge.lon2}`);
      current = bestNext;
    }
    
    return null; // Too many steps
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // DEBUG: Fetch tram line graph edges for visualization
  // ─────────────────────────────────────────────────────────────────────────────
  
  // Find the nearest track edge and snap point for a given lat/lon
  // Returns { edge, snapLat, snapLon, t } or null
  _snapToTrackEdge(lat, lon, edges) {
    if (!edges || edges.length === 0) return null;
    
    let bestEdge = null;
    let bestDist = Infinity;
    let bestSnap = null;
    let bestT = 0;
    const MAX_DIST_DEG = 0.01; // ~1km in degrees
    
    for (const e of edges) {
      // Quick bounding box check
      const minLat = Math.min(e.lat1, e.lat2) - MAX_DIST_DEG;
      const maxLat = Math.max(e.lat1, e.lat2) + MAX_DIST_DEG;
      const minLon = Math.min(e.lon1, e.lon2) - MAX_DIST_DEG;
      const maxLon = Math.max(e.lon1, e.lon2) + MAX_DIST_DEG;
      
      if (lat < minLat || lat > maxLat || lon < minLon || lon > maxLon) continue;
      
      // Project point onto edge segment
      const ax = e.lon1, ay = e.lat1;
      const bx = e.lon2, by = e.lat2;
      const px = lon, py = lat;
      
      const abx = bx - ax, aby = by - ay;
      const apx = px - ax, apy = py - ay;
      const abLen2 = abx * abx + aby * aby;
      
      if (abLen2 < 1e-12) continue;
      
      const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / abLen2));
      const projLon = ax + t * abx;
      const projLat = ay + t * aby;
      
      const dist = Math.hypot(px - projLon, py - projLat);
      if (dist < bestDist && dist < MAX_DIST_DEG) {
        bestDist = dist;
        bestEdge = e;
        bestSnap = { lat: projLat, lon: projLon };
        bestT = t;
      }
    }
    
    if (!bestEdge) return null;
    return { edge: bestEdge, snapLat: bestSnap.lat, snapLon: bestSnap.lon, t: bestT };
  }
  
  // Walk along track edges from point A to point B using greedy edge-following
  // Returns array of screen points along the track, or null if can't find path
  _walkTrackPath(lat1, lon1, lat2, lon2, edges, toScreen) {
    if (!edges || edges.length === 0) {
      if (!this._walkNoEdgesLogged) {
        console.log(`[WALK DEBUG] No edges available`);
        this._walkNoEdgesLogged = true;
      }
      return null;
    }
    
    // Snap both endpoints to nearest edge
    const snap1 = this._snapToTrackEdge(lat1, lon1, edges);
    const snap2 = this._snapToTrackEdge(lat2, lon2, edges);
    
    if (!snap1 || !snap2) {
      if (!this._walkDebugLogged) {
        console.log(`[WALK DEBUG] snap failed: snap1=${!!snap1}, snap2=${!!snap2}, pt1=(${lat1?.toFixed(5)},${lon1?.toFixed(5)}), pt2=(${lat2?.toFixed(5)},${lon2?.toFixed(5)}), edges=${edges.length}`);
        // Sample a few edges near the point
        const sampleEdges = edges.filter(e => {
          const d1 = Math.hypot(e.lat1 - lat1, e.lon1 - lon1);
          const d2 = Math.hypot(e.lat2 - lat1, e.lon2 - lon1);
          return d1 < 0.01 || d2 < 0.01;
        }).slice(0, 3);
        console.log(`[WALK DEBUG] Nearby edges for pt1: ${JSON.stringify(sampleEdges)}`);
        this._walkDebugLogged = true;
      }
      return null;
    }
    
    // Log first successful snap
    if (!this._walkSnapLogged) {
      console.log(`[WALK DEBUG] snap1: edge=(${snap1.edge.lat1.toFixed(5)},${snap1.edge.lon1.toFixed(5)})-(${snap1.edge.lat2.toFixed(5)},${snap1.edge.lon2.toFixed(5)}), snap=(${snap1.snapLat.toFixed(5)},${snap1.snapLon.toFixed(5)})`);
      console.log(`[WALK DEBUG] snap2: edge=(${snap2.edge.lat1.toFixed(5)},${snap2.edge.lon1.toFixed(5)})-(${snap2.edge.lat2.toFixed(5)},${snap2.edge.lon2.toFixed(5)}), snap=(${snap2.snapLat.toFixed(5)},${snap2.snapLon.toFixed(5)})`);
      this._walkSnapLogged = true;
    }
    
    // If both on same edge, just return the two snapped points
    if (snap1.edge === snap2.edge) {
      return [
        toScreen(snap1.snapLat, snap1.snapLon),
        toScreen(snap2.snapLat, snap2.snapLon)
      ];
    }
    
    // Helper: distance in meters (approximate)
    const distM = (lat1, lon1, lat2, lon2) => {
      const dlat = (lat2 - lat1) * 111000;
      const dlon = (lon2 - lon1) * 111000 * Math.cos(lat1 * Math.PI / 180);
      return Math.hypot(dlat, dlon);
    };
    
    // Helper: get endpoint of edge closer to target
    const closerEndpoint = (edge, targetLat, targetLon) => {
      const d1 = distM(edge.lat1, edge.lon1, targetLat, targetLon);
      const d2 = distM(edge.lat2, edge.lon2, targetLat, targetLon);
      return d1 < d2 
        ? { lat: edge.lat1, lon: edge.lon1 }
        : { lat: edge.lat2, lon: edge.lon2 };
    };
    
    // Helper: check if point is an endpoint of edge (within threshold)
    const isOnEdge = (pt, edge) => {
      return distM(pt.lat, pt.lon, edge.lat1, edge.lon1) < 25 ||
             distM(pt.lat, pt.lon, edge.lat2, edge.lon2) < 25;
    };
    
    // Helper: find edges connected to a point (endpoint within threshold)
    const CONNECT_DIST = 25; // meters - increased for OSM data tolerance
    const findConnectedEdges = (pt, visitedEdges) => {
      const connected = [];
      for (const e of edges) {
        // Skip already visited edges
        const eKey = `${e.lat1},${e.lon1}-${e.lat2},${e.lon2}`;
        if (visitedEdges.has(eKey)) continue;
        
        const d1 = distM(pt.lat, pt.lon, e.lat1, e.lon1);
        const d2 = distM(pt.lat, pt.lon, e.lat2, e.lon2);
        
        if (d1 < CONNECT_DIST) {
          connected.push({ edge: e, otherEnd: { lat: e.lat2, lon: e.lon2 }, key: eKey, dist: d1 });
        } else if (d2 < CONNECT_DIST) {
          connected.push({ edge: e, otherEnd: { lat: e.lat1, lon: e.lon1 }, key: eKey, dist: d2 });
        }
      }
      return connected;
    };
    
    // Greedy walk: always move toward destination
    const path = [toScreen(snap1.snapLat, snap1.snapLon)];
    const visitedEdges = new Set();
    
    // Mark starting edge as visited
    const startEdgeKey = `${snap1.edge.lat1},${snap1.edge.lon1}-${snap1.edge.lat2},${snap1.edge.lon2}`;
    visitedEdges.add(startEdgeKey);
    
    // Start from endpoint of edge1 closer to destination
    let current = closerEndpoint(snap1.edge, lat2, lon2);
    path.push(toScreen(current.lat, current.lon));
    
    // Log the walk start
    if (!this._walkStartLogged) {
      const startDist = distM(snap1.snapLat, snap1.snapLon, snap2.snapLat, snap2.snapLon);
      console.log(`[WALK DEBUG] Starting walk: from (${current.lat.toFixed(5)},${current.lon.toFixed(5)}) to edge at (${snap2.edge.lat1.toFixed(5)},${snap2.edge.lon1.toFixed(5)}), direct=${startDist.toFixed(1)}m`);
      this._walkStartLogged = true;
    }
    
    for (let step = 0; step < 100; step++) {
      // Check if we reached edge2
      if (isOnEdge(current, snap2.edge)) {
        path.push(toScreen(snap2.snapLat, snap2.snapLon));
        if (!this._walkSuccessLogged) {
          console.log(`[WALK DEBUG] SUCCESS after ${step} steps, path length=${path.length}`);
          this._walkSuccessLogged = true;
        }
        return path;
      }
      
      // Find connected edges
      const connected = findConnectedEdges(current, visitedEdges);
      if (connected.length === 0) {
        // Stuck - complete path to destination and return what we have
        const directDist = distM(current.lat, current.lon, snap2.snapLat, snap2.snapLon);
        if (directDist < 500) {
          path.push(toScreen(snap2.snapLat, snap2.snapLon));
          return path;
        }
        if (!this._walkStuckLogged) {
          console.log(`[WALK DEBUG] STUCK at step ${step}: no connected edges from (${current.lat.toFixed(5)},${current.lon.toFixed(5)}), directDist=${directDist.toFixed(1)}m, visited=${visitedEdges.size}`);
          this._walkStuckLogged = true;
        }
        return null;
      }
      
      // Pick next edge - prefer continuing the track over jumping
      // If only one option, take it (this follows curves correctly)
      // If multiple options (junction), pick closest to destination
      let bestChoice = null;
      if (connected.length === 1) {
        // Only one option - follow it (this is the key to following curves!)
        bestChoice = connected[0];
      } else {
        // Multiple options (junction) - pick by distance, but prefer closer connections
        let bestScore = Infinity;
        for (const choice of connected) {
          // Score = distance to destination + penalty for loose connection
          const destDist = distM(choice.otherEnd.lat, choice.otherEnd.lon, lat2, lon2);
          const connDist = choice.dist; // How tightly connected (closer = better)
          const score = destDist + connDist * 10; // Penalize loose connections
          if (score < bestScore) {
            bestScore = score;
            bestChoice = choice;
          }
        }
      }
      
      if (!bestChoice) return null;
      
      visitedEdges.add(bestChoice.key);
      current = bestChoice.otherEnd;
      path.push(toScreen(current.lat, current.lon));
    }
    
    // Too many steps
    if (!this._walkTooManyLogged) {
      console.log(`[WALK DEBUG] TOO MANY STEPS (100), path length=${path.length}`);
      this._walkTooManyLogged = true;
    }
    return null;
  }
  
  async _fetchTramLineEdgesForViewport() {
    // Always fetch if we have TRX vehicles OR debug mode is on
    if (!this._pbDebugPath && !this._pbDebugRoadLines && !this._hasTrxVehicles) return;
    if (this._tramEdgesFetching) return;
    
    // Get viewport bounds
    const rect = this.overlayCanvas.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    const centerW = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
    
    // Convert corners to lat/lon with 3x buffer for trail path walking
    // Trails can extend well beyond the visible viewport
    const bufferW = w * 1.5;
    const bufferH = h * 1.5;
    const tl = worldToLatLon(centerW.x - bufferW, centerW.y - bufferH, this.zoom);
    const br = worldToLatLon(centerW.x + bufferW, centerW.y + bufferH, this.zoom);
    
    const minLat = Math.min(tl.lat, br.lat);
    const maxLat = Math.max(tl.lat, br.lat);
    const minLon = Math.min(tl.lon, br.lon);
    const maxLon = Math.max(tl.lon, br.lon);
    
    // Don't refetch if viewport hasn't changed much (use coarse key to avoid excessive fetches)
    // Use .toFixed(1) (~11 km granularity) so smooth zoom/pan doesn't trigger a fetch every frame.
    const key = `${minLat.toFixed(1)},${maxLat.toFixed(1)},${minLon.toFixed(1)},${maxLon.toFixed(1)}`;
    if (this._tramEdgesLastKey === key) return;

    // Debounce: wait 300ms after last viewport change before fetching.
    if (this._tramEdgesDebounce) clearTimeout(this._tramEdgesDebounce);
    this._tramEdgesDebounce = setTimeout(() => {
      this._tramEdgesDebounce = null;
      this._doFetchTramLineEdges(minLat, maxLat, minLon, maxLon, key);
    }, 300);
  }

  async _doFetchTramLineEdges(minLat, maxLat, minLon, maxLon, key) {
    if (this._tramEdgesFetching) return;
    this._tramEdgesFetching = true;
    try {
      const url = `${appConfig.apiBaseUrl}/tram_line_edges?minLat=${minLat}&maxLat=${maxLat}&minLon=${minLon}&maxLon=${maxLon}&limit=8000`;
      const resp = await fetch(url);
      if (!resp.ok) return;
      const data = await resp.json();
      this._tramLineEdges = data.edges || [];
      this._tramLineHasElevation = data.has_elevation || false;
      this._tramEdgesLastKey = key;
      // Trigger redraw
      this.drawOverlay(this.lastState);
    } catch (e) {
      console.warn("Failed to fetch tram line edges:", e);
    } finally {
      this._tramEdgesFetching = false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // FOVEATED ROAD MATCHING: Match segments progressively as vehicles drive.
  // Uses vehicle physics lookahead (not arbitrary time) to determine what to match.
  // ─────────────────────────────────────────────────────────────────────────────

  _isRangeMatched(sensorId, fromMs, toMs) {
    const ranges = this._roadMatchedRangesById.get(sensorId);
    if (!ranges || ranges.length === 0) return false;
    for (const r of ranges) {
      if (r.fromMs <= fromMs && r.toMs >= toMs) return true;
    }
    return false;
  }

  _markRangeMatched(sensorId, fromMs, toMs) {
    if (!this._roadMatchedRangesById.has(sensorId)) {
      this._roadMatchedRangesById.set(sensorId, []);
    }
    const ranges = this._roadMatchedRangesById.get(sensorId);
    // Merge with any overlapping/adjacent existing ranges to keep array compact
    let newFrom = fromMs, newTo = toMs;
    let i = 0;
    while (i < ranges.length) {
      const r = ranges[i];
      if (r.toMs < newFrom || r.fromMs > newTo) { i++; continue; }
      newFrom = Math.min(newFrom, r.fromMs);
      newTo = Math.max(newTo, r.toMs);
      ranges.splice(i, 1);
    }
    ranges.push({ fromMs: newFrom, toMs: newTo });
  }

  /**
   * Request road matching for segments vehicles are about to drive through.
   * Uses vehicle position + physics lookahead distance.
   */
  async _requestFoveatedRoadMatching() {
    if (!this._historicalMode) return;
    if (!this.playbackMode) return;
    
    // Throttle: max 1 batch per 500ms
    const perfNow = performance.now();
    if (perfNow - this._roadMatchLastRequestMs < 500) return;
    this._roadMatchLastRequestMs = perfNow;
    
    const state = window._historicalState;
    const mobiles = Array.isArray(state?.mobile) ? state.mobile : [];
    
    for (const m of mobiles) {
      const id = m?.id;
      if (!id) continue;
      
      if (this._roadMatchPending.has(id)) continue;
      
      // Skip TRAX (rail) - COMMENTED OUT: will use tram line data instead of road graph
      // const sid = String(id).toUpperCase();
      // if (sid.startsWith("TRX") || sid.startsWith("TRAX")) continue;
      
      // Get vehicle physics state (or use playback time-based position)
      const phys = this._physicsStateById?.get(String(id));
      const pts = this._playbackPtsById.get(String(id));
      if (!pts || pts.length < 2) continue;
      
      // Use physics distance if available, otherwise estimate from playback time
      let currentD = 0;
      if (phys && phys.d > 0) {
        currentD = phys.d;
      } else {
        // Estimate position from playback time
        const pbTimeMs = this.getPlaybackTimeMs();
        if (pbTimeMs != null) {
          let cumD = 0;
          for (let i = 1; i < pts.length; i++) {
            if (pts[i].tMs > pbTimeMs) break;
            const prev = pts[i - 1], curr = pts[i];
            const segD = haversineMeters(prev.lat, prev.lon, curr.lat, curr.lon);
            if (isFinite(segD)) cumD += segD;
          }
          currentD = cumD;
        }
      }
      
      // Find segment ahead of vehicle using lookahead distance
      const lookaheadD = currentD + MapView.CURVATURE_LOOKAHEAD * 2;
      
      // Find indices in trail corresponding to [currentD, lookaheadD]
      let startIdx = 0, endIdx = pts.length - 1, cumD = 0;
      for (let i = 1; i < pts.length; i++) {
        const prev = pts[i - 1], curr = pts[i];
        const segD = haversineMeters(prev.lat, prev.lon, curr.lat, curr.lon);
        if (isFinite(segD)) cumD += segD;
        if (cumD < currentD) startIdx = i;
        if (cumD >= lookaheadD) { endIdx = i; break; }
      }
      
      const fromMs = pts[startIdx]?.tMs;
      const toMs = pts[endIdx]?.tMs;
      if (!isFinite(fromMs) || !isFinite(toMs)) continue;
      if (this._isRangeMatched(id, fromMs, toMs)) continue;
      
      // Get raw trail segment
      const trail = Array.isArray(m?.trail) ? m.trail : [];
      const segmentPts = trail.filter(p => {
        const tMs = (p && typeof p.t === "string") ? parseUtcMs(p.t) : null;
        return tMs != null && tMs >= fromMs && tMs <= toMs;
      });
      
      if (segmentPts.length < 2) continue;
      if (segmentPts.some(p => p.wp === 1)) {
        this._markRangeMatched(id, fromMs, toMs);
        continue;
      }
      
      this._roadMatchPending.add(id);
      this._fetchAndApplyRoadMatch(id, segmentPts, fromMs, toMs);
    }
  }

  async _fetchAndApplyRoadMatch(sensorId, trailSegment, fromMs, toMs) {
    try {
      const trailJson = JSON.stringify(trailSegment);
      const url = `${appConfig.apiBaseUrl}/match_segment?sensor=${encodeURIComponent(sensorId)}&trail=${encodeURIComponent(trailJson)}`;
      const resp = await fetch(url, { headers: { "X-App-Token": APP_TOKEN } });
      if (!resp.ok) return;
      
      const data = await resp.json();
      const matchedTrail = data.trail;
      if (!Array.isArray(matchedTrail) || matchedTrail.length === 0) return;
      
      // Merge into state
      const state = window._historicalState;
      const mobiles = Array.isArray(state?.mobile) ? state.mobile : [];
      const mobile = mobiles.find(m => m?.id === sensorId);
      if (!mobile || !Array.isArray(mobile.trail)) return;
      
      // Build map of matched points by time
      const matchedByTime = new Map();
      for (const p of matchedTrail) {
        const tMs = (p && typeof p.t === "string") ? parseUtcMs(p.t) : null;
        if (tMs != null) {
          if (!matchedByTime.has(tMs)) matchedByTime.set(tMs, []);
          matchedByTime.get(tMs).push(p);
        }
      }
      
      // Splice matched points into trail
      const newTrail = [];
      for (const p of mobile.trail) {
        const tMs = (p && typeof p.t === "string") ? parseUtcMs(p.t) : null;
        if (tMs != null && matchedByTime.has(tMs)) {
          newTrail.push(...matchedByTime.get(tMs));
          matchedByTime.delete(tMs);
        } else if (!p.wp) {
          newTrail.push(p);
        }
      }
      
      mobile.trail = newTrail;
      this._playbackPtsKey = ""; // Invalidate cache
      this._ensurePlaybackPoints(state);
      this._markRangeMatched(sensorId, fromMs, toMs);
      
    } catch (e) {
      console.warn(`Road match error for ${sensorId}:`, e);
    } finally {
      this._roadMatchPending.delete(sensorId);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // AUTONOMOUS AGENT PHYSICS: Vehicles behave like self-driving agents that see
  // the revealed trail ahead and drive naturally - accelerating on straights,
  // braking for curves, and stopping at the end of visible road.
  // 
  // Key principles:
  // 1. Trail reveals at targetD + dynamic lookahead (the "visible road")
  // 2. Vehicle is FREE AGENT that follows visible road, not locked to playback time
  // 3. Physics match wall-clock time, but position decouples during scrubbing
  // 4. GPS data points act as checkpoints for ground truth
  // ─────────────────────────────────────────────────────────────────────────────
  
  // Physics constants (matching unit tests in vehicle_physics.test.cjs)
  static CRUISE_SPEED = 25;           // m/s on straights (~56 mph)
  static CURVE_SPEED = 8;             // m/s in tight curves (~18 mph)
  static ACCEL_RATE = 4;              // m/s² acceleration
  static BRAKE_RATE = 6;              // m/s² braking (stronger than accel)
  static CURVATURE_LOOKAHEAD = 100;   // meters to scan ahead for curves
  static TRAIL_LOOKAHEAD_BASE = 80;   // base meters ahead of targetD for trail reveal
  static CURVATURE_THRESHOLD = 0.01;  // rad/m where we start slowing
  static STOP_BUFFER = 10;            // meters before visible end to start stopping
  static PHYSICS_VARIATION = 0.15;    // ±15% variation in physics params per vehicle
  
  // Deterministic hash for vehicle ID -> [0, 1)
  _hashId(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) {
      h = ((h << 5) - h + id.charCodeAt(i)) | 0;
    }
    return ((h & 0x7fffffff) % 10000) / 10000;
  }
  
  // Get per-vehicle physics parameters (deterministic variation from ID)
  _getVehiclePhysics(id) {
    if (!this._vehiclePhysicsCache) this._vehiclePhysicsCache = new Map();
    let vp = this._vehiclePhysicsCache.get(id);
    if (vp) return vp;
    
    const h1 = this._hashId(id);
    const h2 = this._hashId(id + "_2");
    const h3 = this._hashId(id + "_3");
    const vary = MapView.PHYSICS_VARIATION;
    
    // Each vehicle gets slightly different cruise/curve speeds and acceleration
    vp = {
      cruiseSpeed: MapView.CRUISE_SPEED * (1 + (h1 - 0.5) * 2 * vary),
      curveSpeed: MapView.CURVE_SPEED * (1 + (h2 - 0.5) * 2 * vary),
      accelRate: MapView.ACCEL_RATE * (1 + (h3 - 0.5) * 2 * vary),
      brakeRate: MapView.BRAKE_RATE * (1 + (this._hashId(id + "_4") - 0.5) * 2 * vary),
    };
    
    this._vehiclePhysicsCache.set(id, vp);
    return vp;
  }
  
  // Per-vehicle physics state: { d: current distance along path (meters),
  //                              v: velocity (m/s along path), lastPerfMs }
  
  _getPhysicsState(id) {
    if (!this._physicsStateById) this._physicsStateById = new Map();
    let st = this._physicsStateById.get(id);
    if (!st) {
      st = { d: 0, v: 0, lastPerfMs: null, totalDist: 0 };
      this._physicsStateById.set(id, st);
    }
    return st;
  }
  
  _resetPhysicsState(id) {
    if (this._physicsStateById) this._physicsStateById.delete(id);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SLIDING WINDOW WAYPOINT STEERING
  // 
  // Waypoints are computed incrementally in sliding window chunks around the
  // vehicle position. Each chunk depends on previous waypoints (memoizable).
  // The look-ahead distance varies with playback speed.
  // 
  // This avoids reprocessing the entire path - only computes what's needed.
  // ═══════════════════════════════════════════════════════════════════════════
  
  static WAYPOINT_CHUNK_SIZE = 50;      // Points per computed chunk
  static WAYPOINT_BEHIND = 5;           // Points behind vehicle to keep
  static WAYPOINT_AHEAD_BASE = 20;      // Base points ahead at 1x speed
  static WAYPOINT_AHEAD_PER_SPEED = 5;  // Additional points per speed multiplier
  static JITTER_THRESHOLD_M = 8;        // Only smooth deviations < 8 meters
  static JITTER_BLEND = 0.3;            // Blend factor for jitter smoothing
  static MIN_TRAIL_LENGTH_M = 50;      // Ignore tiny trails (GPS jitter)
  static MIN_CAMERA_FIT_SEGMENT_POINTS = 3;
  static MIN_CAMERA_FIT_SEGMENT_LENGTH_M = 120;
  static MIN_CAMERA_FIT_SEGMENT_DISPLACEMENT_M = 60;
  static MIN_CAMERA_FIT_SEGMENT_STRAIGHTNESS = 0.2;
  static MIN_CAMERA_FIT_SEGMENT_LENGTH_M_2PT = 500;
  static MIN_CAMERA_FIT_SEGMENT_DISPLACEMENT_M_2PT = 500;
  static MAX_CAMERA_FIT_SEGMENT_LENGTH_M = 5000; // cap per-vehicle segment to ~5km

  // ═══════════════════════════════════════════════════════════════════════════
  // PROGRESSIVE SPLINE PATH
  // 
  // The vehicle's path is computed PROGRESSIVELY as it advances. When the
  // vehicle passes a GPS waypoint, we compute the spline segment from that
  // waypoint to the next using the CURRENT tension (based on current speed).
  // 
  // Key insight: Once a spline segment is computed, it's LOCKED. When speed
  // changes, only FUTURE segments (not yet reached) use the new tension.
  // This prevents the vehicle from "snapping" when speed changes.
  //
  // Structure:
  //   _vehiclePathById: Map<id, { 
  //     computedPts: [{lat, lon, rawIdx, tMs, m, readings}],  // progressive spline
  //     cumDist: [],           // cumulative distances for computedPts
  //     lastRawIdx: number,    // last raw GPS index we've computed past
  //   }>
  // ═══════════════════════════════════════════════════════════════════════════

  // Get or create the progressive path for a vehicle
  _getVehiclePath(id, pts) {
    if (!this._vehiclePathById) this._vehiclePathById = new Map();
    
    let path = this._vehiclePathById.get(id);
    const ptsKey = this._playbackPtsKey;
    
    // Reset if pts changed (different recording loaded)
    if (path && path.ptsKey !== ptsKey) {
      path = null;
    }
    
    if (!path) {
      // Initialize with first GPS point
      const p0 = pts[0];
      path = {
        computedPts: [{
          lat: p0.lat,
          lon: p0.lon,
          rawIdx: 0,
          tMs: p0.tMs,
          m: p0.m,
          readings: p0.readings
        }],
        cumDist: [0],
        lastRawIdx: 0,
        ptsKey
      };
      this._vehiclePathById.set(id, path);
    }
    
    return path;
  }

  // Extend the progressive path up to (and past) targetRawIdx
  // Uses current playback speed to determine spline tension for NEW segments only
  // CRITICAL: If tension changed, invalidate segments AHEAD of vehicle and recompute
  _extendVehiclePath(id, pts, targetRawIdx, playbackSpeed, vehicleRawIdx) {
    const path = this._getVehiclePath(id, pts);
    const n = pts.length;
    
    // Spline tension from current speed
    // HIGH tension = TIGHT curves (follows GPS closely) - for LOW speed
    // LOW tension = SMOOTH curves (wider arcs) - for HIGH speed
    // At 1x: tension = 0.85 (tight, follows GPS)
    // At 20x: tension ~ 0.33 (smooth, wide arcs)
    const tension = Math.max(0.2, 0.85 - 0.12 * Math.log2(Math.max(1, playbackSpeed)));
    const tensionKey = Math.round(tension * 100);
    
    // If tension changed and we have segments ahead of vehicle, invalidate them
    if (path.lastTensionKey !== undefined && path.lastTensionKey !== tensionKey) {
      // Find where vehicle is in computed path
      const vehRawIdx = vehicleRawIdx || 0;
      
      // Truncate: keep only points up to current vehicle position
      // Find the last computed point that's AT or BEFORE vehicle
      let keepUpToIdx = 0;
      for (let i = 0; i < path.computedPts.length; i++) {
        if (path.computedPts[i].rawIdx <= vehRawIdx) {
          keepUpToIdx = i;
        } else {
          break;
        }
      }
      
      // Truncate arrays
      if (keepUpToIdx < path.computedPts.length - 1) {
        path.computedPts = path.computedPts.slice(0, keepUpToIdx + 1);
        path.cumDist = path.cumDist.slice(0, keepUpToIdx + 1);
        path.lastRawIdx = Math.floor(path.computedPts[keepUpToIdx].rawIdx);
      }
    }
    path.lastTensionKey = tensionKey;
    
    // Already computed past this index?
    if (path.lastRawIdx >= targetRawIdx) {
      return path;
    }
    
    const s = (1 - tension) / 2;
    
    // Catmull-Rom interpolation
    const catmullRom = (p0, p1, p2, p3, t) => {
      const t2 = t * t;
      const t3 = t2 * t;
      const h1 = -s * t3 + 2 * s * t2 - s * t;
      const h2 = (2 - s) * t3 + (s - 3) * t2 + 1;
      const h3 = (s - 2) * t3 + (3 - 2 * s) * t2 + s * t;
      const h4 = s * t3 - s * t2;
      return {
        lat: h1 * p0.lat + h2 * p1.lat + h3 * p2.lat + h4 * p3.lat,
        lon: h1 * p0.lon + h2 * p1.lon + h3 * p2.lon + h4 * p3.lon
      };
    };
    
    const SAMPLES_PER_SEGMENT = 4;
    
    // Extend from lastRawIdx to targetRawIdx
    for (let i = path.lastRawIdx; i < targetRawIdx && i < n - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[i];
      const p2 = pts[Math.min(n - 1, i + 1)];
      const p3 = pts[Math.min(n - 1, i + 2)];
      
      // Add interpolated points for segment i → i+1
      for (let si = 1; si <= SAMPLES_PER_SEGMENT; si++) {
        const t = si / (SAMPLES_PER_SEGMENT + 1);
        const interp = catmullRom(p0, p1, p2, p3, t);
        
        const newPt = {
          lat: interp.lat,
          lon: interp.lon,
          rawIdx: i + t,
          tMs: p1.tMs + t * (p2.tMs - p1.tMs),
          m: p2.m,
          readings: p2.readings
        };
        
        // Compute distance from last point
        const lastPt = path.computedPts[path.computedPts.length - 1];
        const segDist = haversineMeters(lastPt.lat, lastPt.lon, newPt.lat, newPt.lon);
        
        path.computedPts.push(newPt);
        path.cumDist.push(path.cumDist[path.cumDist.length - 1] + segDist);
      }
      
      // Add the endpoint (GPS point i+1)
      const endPt = {
        lat: p2.lat,
        lon: p2.lon,
        rawIdx: i + 1,
        tMs: p2.tMs,
        m: p2.m,
        readings: p2.readings
      };
      
      const lastPt = path.computedPts[path.computedPts.length - 1];
      const segDist = haversineMeters(lastPt.lat, lastPt.lon, endPt.lat, endPt.lon);
      
      path.computedPts.push(endPt);
      path.cumDist.push(path.cumDist[path.cumDist.length - 1] + segDist);
      
      path.lastRawIdx = i + 1;
    }
    
    return path;
  }

  // Get sliding window of waypoints around vehicle position from PROGRESSIVE path
  // Returns { waypoints, startIdx, endIdx, cumDist, curvature }
  _getWaypointWindow(id, pts, vehicleIdx, playbackSpeed) {
    const n = pts.length;
    if (n < 2) return null;
    
    // Extend progressive path to cover ahead of vehicle
    const aheadCount = MapView.WAYPOINT_AHEAD_BASE + 
                       Math.floor(MapView.WAYPOINT_AHEAD_PER_SPEED * Math.max(1, playbackSpeed));
    const targetRawIdx = Math.min(n - 1, vehicleIdx + aheadCount);
    
    // Pass vehicleIdx so _extendVehiclePath can invalidate segments ahead when tension changes
    const path = this._extendVehiclePath(id, pts, targetRawIdx, playbackSpeed, vehicleIdx);
    
    // Find window in computed path
    const behindCount = MapView.WAYPOINT_BEHIND;
    const cpts = path.computedPts;
    const ccum = path.cumDist;
    
    // Find index in computed path corresponding to vehicleIdx
    let vehicleComputedIdx = 0;
    for (let i = 0; i < cpts.length; i++) {
      if (cpts[i].rawIdx >= vehicleIdx) {
        vehicleComputedIdx = i;
        break;
      }
      vehicleComputedIdx = i;
    }
    
    // Window bounds in computed path (5 samples per GPS segment)
    const SAMPLES_PER_SEG = 5; // 4 interpolated + 1 endpoint
    const startComputedIdx = Math.max(0, vehicleComputedIdx - behindCount * SAMPLES_PER_SEG);
    const endComputedIdx = Math.min(cpts.length - 1, vehicleComputedIdx + aheadCount * SAMPLES_PER_SEG);
    
    // Extract window
    const windowPts = cpts.slice(startComputedIdx, endComputedIdx + 1);
    const windowCumDist = [];
    const baseDist = ccum[startComputedIdx];
    for (let i = startComputedIdx; i <= endComputedIdx; i++) {
      windowCumDist.push(ccum[i] - baseDist);
    }
    const totalDist = windowCumDist[windowCumDist.length - 1] || 1;
    
    // Compute curvature for window
    const wn = windowPts.length;
    const curvature = new Array(wn).fill(0);
    if (wn >= 3) {
      for (let i = 1; i < wn - 1; i++) {
        const dx1 = windowPts[i].lon - windowPts[i-1].lon;
        const dy1 = windowPts[i].lat - windowPts[i-1].lat;
        const dx2 = windowPts[i+1].lon - windowPts[i].lon;
        const dy2 = windowPts[i+1].lat - windowPts[i].lat;
        
        const a1 = Math.atan2(dy1, dx1);
        const a2 = Math.atan2(dy2, dx2);
        let angleDiff = Math.abs(a2 - a1);
        if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
        
        const dist = (windowCumDist[i] - windowCumDist[i-1] + windowCumDist[i+1] - windowCumDist[i]) / 2;
        curvature[i] = dist > 0.1 ? angleDiff / dist : 0;
      }
    }
    
    return {
      waypoints: windowPts,
      startIdx: startComputedIdx,
      endIdx: endComputedIdx,
      cumDist: windowCumDist,
      totalDist,
      curvature,
      // For mapping raw distance to window distance
      startRawIdx: cpts[startComputedIdx]?.rawIdx || 0,
      endRawIdx: cpts[endComputedIdx]?.rawIdx || n - 1,
      fullCumDist: ccum,
      fullStartIdx: startComputedIdx
    };
  }

  // Legacy: Get full smooth path (for compatibility with debug display)
  // Delegates to window-based computation
  _getSmoothPath(id, pts) {
    if (!this._smoothPathCache) this._smoothPathCache = new Map();
    const cached = this._smoothPathCache.get(id);
    if (cached && cached.ptsLen === pts.length && cached.ptsKey === this._playbackPtsKey) {
      return cached;
    }

    const n = pts.length;
    if (n < 2) {
      const single = { 
        waypoints: pts.slice(), 
        cumDist: [0], 
        totalDist: 0, 
        curvature: [0], 
        origIdxMap: [0],
        ptsLen: n,
        ptsKey: this._playbackPtsKey
      };
      this._smoothPathCache.set(id, single);
      return single;
    }

    // Compute full path using window function (for debug display)
    const playbackSpeed = this._playbackSpeed || 1.0;
    const fullWindow = this._getWaypointWindow(id, pts, Math.floor(n / 2), playbackSpeed);
    
    // If window doesn't cover full path, compute remaining
    const waypoints = [];
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      
      // Simple jitter smoothing for full path
      let sumLat = 0, sumLon = 0, count = 0;
      for (let j = Math.max(0, i - 1); j <= Math.min(n - 1, i + 1); j++) {
        sumLat += pts[j].lat;
        sumLon += pts[j].lon;
        count++;
      }
      const avgLat = sumLat / count;
      const avgLon = sumLon / count;
      
      const deviationM = haversineMeters(p.lat, p.lon, avgLat, avgLon);
      
      let smoothLat, smoothLon;
      if (deviationM < MapView.JITTER_THRESHOLD_M && i > 0 && i < n - 1) {
        const blend = MapView.JITTER_BLEND;
        smoothLat = p.lat + blend * (avgLat - p.lat);
        smoothLon = p.lon + blend * (avgLon - p.lon);
      } else {
        smoothLat = p.lat;
        smoothLon = p.lon;
      }
      
      waypoints.push({
        lat: smoothLat,
        lon: smoothLon,
        origIdx: i,
        tMs: p.tMs,
        m: p.m,
        readings: p.readings
      });
    }

    // Build distance table
    const wn = waypoints.length;
    const cumDist = new Array(wn);
    cumDist[0] = 0;
    for (let i = 1; i < wn; i++) {
      const segDist = haversineMeters(waypoints[i-1].lat, waypoints[i-1].lon, waypoints[i].lat, waypoints[i].lon);
      cumDist[i] = cumDist[i-1] + segDist;
    }
    const totalDist = cumDist[wn - 1] || 1;

    // Compute curvature
    const curvature = new Array(wn).fill(0);
    if (wn >= 3) {
      for (let i = 1; i < wn - 1; i++) {
        const dx1 = waypoints[i].lon - waypoints[i-1].lon;
        const dy1 = waypoints[i].lat - waypoints[i-1].lat;
        const dx2 = waypoints[i+1].lon - waypoints[i].lon;
        const dy2 = waypoints[i+1].lat - waypoints[i].lat;
        
        const a1 = Math.atan2(dy1, dx1);
        const a2 = Math.atan2(dy2, dx2);
        let angleDiff = Math.abs(a2 - a1);
        if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
        
        const dist = (cumDist[i] - cumDist[i-1] + cumDist[i+1] - cumDist[i]) / 2;
        curvature[i] = dist > 0.1 ? angleDiff / dist : 0;
      }
    }

    const origIdxMap = waypoints.map(w => w.origIdx);

    const result = { 
      waypoints, 
      cumDist, 
      totalDist, 
      curvature, 
      origIdxMap,
      ptsLen: n,
      ptsKey: this._playbackPtsKey
    };
    this._smoothPathCache.set(id, result);
    return result;
  }
  
  // Build cumulative distance array for a path (cached per vehicle)
  // Also computes per-point curvature for speed modulation
  _getPathDistances(id, pts) {
    if (!this._pathDistCache) this._pathDistCache = new Map();
    let cached = this._pathDistCache.get(id);
    if (cached && cached.ptsLen === pts.length) return cached;

    const n = pts.length;
    const prevLen = cached ? cached.ptsLen : 0;

    // Incremental: reuse existing arrays and only compute new appended points.
    // GPS trails only grow by appending — never insert into the middle.
    let cumDist, curvature;
    if (cached && prevLen > 0 && n > prevLen) {
      // Extend existing arrays
      cumDist = cached.cumDist;
      curvature = cached.curvature;
      // Grow arrays to new size
      cumDist.length = n;
      curvature.length = n;
      // Compute distances for new points only
      for (let i = prevLen; i < n; i++) {
        const segDist = haversineMeters(pts[i-1].lat, pts[i-1].lon, pts[i].lat, pts[i].lon);
        cumDist[i] = cumDist[i-1] + segDist;
      }
      // Recompute curvature only at boundary + new points
      const curvStart = Math.max(1, prevLen - 1);
      for (let i = curvStart; i < n - 1; i++) {
        const dx1 = pts[i].lon - pts[i-1].lon;
        const dy1 = pts[i].lat - pts[i-1].lat;
        const dx2 = pts[i+1].lon - pts[i].lon;
        const dy2 = pts[i+1].lat - pts[i].lat;
        const a1 = Math.atan2(dy1, dx1);
        const a2 = Math.atan2(dy2, dx2);
        let angleDiff = Math.abs(a2 - a1);
        if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
        const dist = (cumDist[i] - cumDist[i-1] + cumDist[i+1] - cumDist[i]) / 2;
        curvature[i] = dist > 0.1 ? angleDiff / dist : 0;
      }
      if (n > 0) curvature[n - 1] = 0;
    } else {
      // Full rebuild (first call or data replaced)
      cumDist = new Array(n);
      cumDist[0] = 0;
      for (let i = 1; i < n; i++) {
        const segDist = haversineMeters(pts[i-1].lat, pts[i-1].lon, pts[i].lat, pts[i].lon);
        cumDist[i] = cumDist[i-1] + segDist;
      }
      curvature = new Array(n).fill(0);
      if (n >= 3) {
        for (let i = 1; i < n - 1; i++) {
          const dx1 = pts[i].lon - pts[i-1].lon;
          const dy1 = pts[i].lat - pts[i-1].lat;
          const dx2 = pts[i+1].lon - pts[i].lon;
          const dy2 = pts[i+1].lat - pts[i].lat;
          const a1 = Math.atan2(dy1, dx1);
          const a2 = Math.atan2(dy2, dx2);
          let angleDiff = Math.abs(a2 - a1);
          if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
          const dist = (cumDist[i] - cumDist[i-1] + cumDist[i+1] - cumDist[i]) / 2;
          curvature[i] = dist > 0.1 ? angleDiff / dist : 0;
        }
      }
    }
    const totalDist = cumDist[n - 1] || 1;

    cached = { cumDist, totalDist, curvature, ptsLen: n };
    this._pathDistCache.set(id, cached);
    return cached;
  }
  
  // Catmull-Rom spline interpolation for smooth curves
  // Returns position and tangent at parameter t ∈ [0,1] between pts[p1] and pts[p2]
  _catmullRom(pts, p0Idx, p1Idx, p2Idx, p3Idx, t) {
    const p0 = pts[p0Idx];
    const p1 = pts[p1Idx];
    const p2 = pts[p2Idx];
    const p3 = pts[p3Idx];
    
    const t2 = t * t;
    const t3 = t2 * t;
    
    // Catmull-Rom basis functions
    const lat = 0.5 * (
      (-p0.lat + 3*p1.lat - 3*p2.lat + p3.lat) * t3 +
      (2*p0.lat - 5*p1.lat + 4*p2.lat - p3.lat) * t2 +
      (-p0.lat + p2.lat) * t +
      2*p1.lat
    );
    const lon = 0.5 * (
      (-p0.lon + 3*p1.lon - 3*p2.lon + p3.lon) * t3 +
      (2*p0.lon - 5*p1.lon + 4*p2.lon - p3.lon) * t2 +
      (-p0.lon + p2.lon) * t +
      2*p1.lon
    );
    
    // Tangent (derivative of position)
    const dLat = 0.5 * (
      3*(-p0.lat + 3*p1.lat - 3*p2.lat + p3.lat) * t2 +
      2*(2*p0.lat - 5*p1.lat + 4*p2.lat - p3.lat) * t +
      (-p0.lat + p2.lat)
    );
    const dLon = 0.5 * (
      3*(-p0.lon + 3*p1.lon - 3*p2.lon + p3.lon) * t2 +
      2*(2*p0.lon - 5*p1.lon + 4*p2.lon - p3.lon) * t +
      (-p0.lon + p2.lon)
    );
    
    return { lat, lon, dLat, dLon };
  }
  
  // Sample position on path given distance along it using LINEAR interpolation
  // Catmull-Rom was causing loops at sharp corners - linear is more predictable
  // Returns position, tangent direction, and local curvature
  _samplePathAtDistance(pts, cumDist, curvature, d) {
    const n = pts.length;
    if (n < 2) return { lat: pts[0].lat, lon: pts[0].lon, idx: 0, u: 0, heading: 0, curv: 0 };
    
    // Binary search for segment containing distance d
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cumDist[mid] <= d) lo = mid;
      else hi = mid - 1;
    }
    const idx = Math.min(lo, n - 2);
    
    const segStart = cumDist[idx];
    const segEnd = cumDist[idx + 1];
    const segLen = Math.max(0.001, segEnd - segStart);
    const u = clamp((d - segStart) / segLen, 0, 1);
    
    // Linear interpolation - no overshooting at corners
    const p0 = pts[idx];
    const p1 = pts[idx + 1];
    const lat = p0.lat + (p1.lat - p0.lat) * u;
    const lon = p0.lon + (p1.lon - p0.lon) * u;
    
    // Heading from segment direction
    const heading = Math.atan2(p1.lat - p0.lat, p1.lon - p0.lon);
    
    // Interpolate curvature between the two segment endpoints
    const curv = (curvature[idx] || 0) * (1 - u) + (curvature[idx + 1] || 0) * u;
    
    return { 
      lat, 
      lon, 
      idx, 
      u, 
      heading,
      curv,
      p0, 
      p1 
    };
  }
  
  // Get target distance based on playback time
  _getTargetDistance(pts, cumDist, totalDist, t) {
    const tMin = pts[0].tMs;
    const tMax = pts[pts.length - 1].tMs;
    
    if (t <= tMin) return 0;
    if (t >= tMax) return totalDist;
    
    // Binary search for segment containing time t
    let lo = 1, hi = pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].tMs >= t) hi = mid;
      else lo = mid + 1;
    }
    
    const p0 = pts[lo - 1];
    const p1 = pts[lo];
    const dtMs = Math.max(1, p1.tMs - p0.tMs);
    const u = clamp((t - p0.tMs) / dtMs, 0, 1);
    
    // Interpolate distance
    const d0 = cumDist[lo - 1];
    const d1 = cumDist[lo];
    return d0 + (d1 - d0) * u;
  }

  _playbackSampleForMobile(m, nowPerfMs) {
    const id = m && m.id != null ? String(m.id) : "";
    if (!id) return null;
    const t = this._playbackNowMs;
    if (t == null || !isFinite(t)) return null;

    const pts = this._playbackPtsById.get(id);
    if (!pts || pts.length < 1) return null;

    const tMin = pts[0].tMs;
    const tMax = pts[pts.length - 1].tMs;
    if (!isFinite(tMin) || !isFinite(tMax)) return null;

    // Single point: always return that point
    if (pts.length === 1) {
      const p = pts[0];
      return { lat: p.lat, lon: p.lon, m: p.m, readings: p.readings, beforeFirst: t < tMin, afterLast: t > tMax };
    }

    // Get raw path geometry for physics (distance, curvature from original GPS points)
    const { cumDist, totalDist, curvature } = this._getPathDistances(id, pts);
    
    // Target distance along raw path based on playback time
    const targetD = this._getTargetDistance(pts, cumDist, totalDist, t);
    
    // ── SCRUB FAST PATH ──────────────────────────────────────────────────────
    // When the user is actively scrubbing, skip the entire physics pipeline.
    // The controller owns the position — place marker at targetD and return.
    //
    // Also stays active during "cooldown" after a forward scrub ends: the
    // easing/fling continues advancing playbackTimeMs while physics would be
    // far behind, causing a lurch. We hold the fast path until the playback
    // velocity settles to normal speed (targetD stops racing ahead).
    if (this._scrubbing) {
      // Mark that we're in a scrub — cooldown will continue after release
      if (!this._scrubCooldownById) this._scrubCooldownById = new Map();
      this._scrubCooldownById.set(id, { lastTargetD: targetD, lastT: t });
    }
    const cooldown = this._scrubCooldownById?.get(id);
    const inCooldown = !this._scrubbing && cooldown != null
      && (t - cooldown.lastT) < 1500   // max 1.5s cooldown
      && (targetD - cooldown.lastTargetD) > 50;  // easing is still racing ahead (>50m jump)
    if (inCooldown) {
      // Update cooldown tracking
      cooldown.lastTargetD = targetD;
      cooldown.lastT = t;
    } else if (!this._scrubbing && cooldown != null) {
      // Cooldown finished — clear it
      this._scrubCooldownById.delete(id);
    }
    
    if (this._scrubbing || inCooldown) {
      const phys = this._getPhysicsState(id);
      phys.d = targetD;
      phys.lastPlaybackT = t;
      phys.lastPerfMs = nowPerfMs;
      phys.v = 0;
      const smp = this._samplePathAtDistance(pts, cumDist, curvature, targetD);
      phys.lat = smp.lat;
      phys.lon = smp.lon;
      phys.heading = smp.heading;
      phys.totalDist = totalDist;
      const nextPt = smp.p1 || pts[Math.min(smp.idx + 1, pts.length - 1)];
      const reading = primaryReadingKeyedFromPoint(nextPt);
      const movingFlag = !!(nextPt && (nextPt.m === 1 || nextPt.m === "1" || nextPt.m === true));
      if (!m._key) m._key = keyFor("mobile", m.id);
      const opacity = (!movingFlag && !this._pbDebugPath && this.selectedId !== m._key) ? 0.25 : 1.0;
      // Store debug info so trail reveal still works during scrub
      if (!this._vehicleRevealDist) this._vehicleRevealDist = new Map();
      this._vehicleRevealDist.set(id, {
        d: targetD, visibleEnd: targetD, vehicleD: targetD, vehicleV: 0,
        vehicleTMs: t, controlScalar: 1, positionError: 0, totalDist
      });
      return { lat: smp.lat, lon: smp.lon, angle: smp.heading, flipX: false, speedMps: 0, opacity, reading, readings: nextPt.readings, beforeFirst: t < tMin };
    }
    // ── END SCRUB FAST PATH ──────────────────────────────────────────────────
    
    // Get physics state and determine reference distance for sliding window
    const phys = this._getPhysicsState(id);
    // Use phys.d if initialized, otherwise use targetD (where we WILL be)
    const refD = (phys.d > 0) ? phys.d : targetD;
    
    // Find index corresponding to reference distance (binary search on sorted cumDist)
    let _lo = 0, _hi = cumDist.length - 1;
    while (_lo < _hi) {
      const _mid = (_lo + _hi + 1) >> 1;
      if (cumDist[_mid] <= refD) _lo = _mid; else _hi = _mid - 1;
    }
    const vehicleIdx = _lo;
    
    // Get sliding window of smoothed waypoints around vehicle position
    const playbackSpeed = this._playbackSpeed || 1.0;
    const waypointWindow = this._getWaypointWindow(id, pts, vehicleIdx, playbackSpeed);
    const smoothWaypoints = waypointWindow?.waypoints || pts;
    const smoothCumDist = waypointWindow?.cumDist || cumDist;
    
    // Vehicle physics parameters
    const vp = this._getVehiclePhysics(id);
    
    // Detect scrubbing: if playback time jumped significantly, snap to new position.
    // Also snap unconditionally when the user is actively scrubbing (barrel or slider).
    const lastPlaybackT = phys.lastPlaybackT || t;
    const playbackDt = t - lastPlaybackT;
    const scrubThreshold = Math.max(2000, (this._playbackSpeed || 1) * 250);
    const isScrub = Math.abs(playbackDt) > scrubThreshold || !!this._scrubbing;
    phys.lastPlaybackT = t;
    
    // Wall-clock dt for physics integration
    const dtS = (phys.lastPerfMs != null && isFinite(phys.lastPerfMs)) 
      ? Math.min(0.1, Math.max(0, (nowPerfMs - phys.lastPerfMs) / 1000))
      : 0.016;
    phys.lastPerfMs = nowPerfMs;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CONTROL SCALAR: A unified control function σ(ε, ω) where:
    //   ε = normalized position error (vehicle position relative to target)
    //   ω = playback speed multiplier (user's tempo setting)
    //
    // The control scalar modulates ALL vehicle physics as a single "throttle":
    //   σ → 0: vehicle stops/crawls (ahead of target, waiting)
    //   σ → 1: vehicle at natural pace (synchronized with playback)
    //   σ → boost: vehicle accelerates (behind target, catching up)
    //
    // This is essentially a proportional controller with soft saturation,
    // allowing granular pathfinding without complex heuristics.
    // ═══════════════════════════════════════════════════════════════════════════
    
    // (playbackSpeed already declared above for waypoint window)
    
    // Normalized position error: ε = (targetD - vehicleD) / referenceDistance
    // Positive = behind target (need to catch up)
    // Negative = ahead of target (need to wait)
    // We normalize by the base lookahead to get a dimensionless error in [-∞, +∞]
    const positionError = (targetD - phys.d) / MapView.TRAIL_LOOKAHEAD_BASE;
    
    // Control scalar function using soft-plus / sigmoid blend:
    // σ(ε, ω) = ω · response(ε)
    //
    // response(ε) uses a piecewise smooth function:
    //   ε < -1: response → 0 (way ahead, stop)
    //   ε = 0:  response → 1 (synchronized)
    //   ε > +1: response → 1 + boost (behind, catch up)
    //
    // We use: response(ε) = max(0, 1 + tanh(ε · gain))
    // This gives smooth S-curve behavior with natural saturation.
    
    const controlGain = 1.5;  // How aggressively to respond to position error
    const maxBoost = 2.0;     // Maximum catch-up multiplier when far behind
    
    // Smooth response function: tanh provides natural saturation at extremes
    // Shifted so response(0) = 1, response(-∞) → 0, response(+∞) → 1 + maxBoost
    const tanhResponse = Math.tanh(positionError * controlGain);
    const response = Math.max(0, 1 + tanhResponse * (tanhResponse > 0 ? maxBoost : 1));
    
    // Final control scalar: combines playback speed with position-based response
    // Use sqrt(playbackSpeed) for sub-linear scaling (feels more natural)
    const controlScalar = Math.sqrt(Math.max(1, playbackSpeed)) * response;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // Apply control scalar to all physics parameters
    // ═══════════════════════════════════════════════════════════════════════════
    
    const effectiveCruise = vp.cruiseSpeed * controlScalar;
    // Scale curve speed sub-linearly so we slow down relatively more when fast-forwarding
    // This ensures turns look like turns even at 20x speed
    const effectiveCurve = vp.curveSpeed * Math.pow(controlScalar, 0.75);
    const effectiveAccel = vp.accelRate * controlScalar;
    const effectiveBrake = vp.brakeRate * Math.max(1, controlScalar); // Braking never reduced
    
    // The "visible road" ends at targetD (the playback-time position).
    // Vehicle must NEVER exceed this - it tracks playback time exactly.
    // The control scalar allows catching up when behind, but never running ahead.
    // (Removed dynamic lookahead which caused vehicles to outrun the revealed trail.)
    const visibleEnd = Math.min(targetD, totalDist);
    
    // Initialize or handle scrub: snap to target, reset velocity
    // Also snap if physics hasn't been initialized yet (d=0 but targetD is far ahead)
    const needsSnap = phys.totalDist !== totalDist || isScrub || 
                      (phys.d === 0 && targetD > 100); // Snap if >100m behind on init
    if (needsSnap) {
      phys.totalDist = totalDist;
      phys.d = targetD;
      phys.v = 0; // Start from rest after scrub
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // AUTONOMOUS AGENT PHYSICS (modulated by control scalar)
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Look ahead for curves and calculate safe approach speed.
    // Cached: only re-scan when vehicle moves >5m or control scalar shifts >20%.
    if (!this._curveLookaheadCache) this._curveLookaheadCache = new Map();
    let _clc = this._curveLookaheadCache.get(id);
    let safeSpeed;
    const _clcStale = !_clc
      || Math.abs(phys.d - _clc.d) > 5
      || Math.abs(controlScalar - _clc.ctrl) > 0.2 * (_clc.ctrl || 1)
      || needsSnap;
    if (!_clcStale) {
      // Scale cached result by ratio of current vs cached effective cruise
      safeSpeed = _clc.safeSpeed * (effectiveCruise / (_clc.cruise || effectiveCruise));
    } else {
      const lookaheadDist = MapView.CURVATURE_LOOKAHEAD * Math.max(1, controlScalar);
      const curveLookaheadEnd = Math.min(phys.d + lookaheadDist, totalDist);
      safeSpeed = effectiveCruise;
      for (let i = vehicleIdx; i < curvature.length; i++) {
        const d = cumDist[i];
        if (d < phys.d) continue;
        if (d > curveLookaheadEnd) break;
        const curv = curvature[i];
        if (curv <= 0.001) continue;
        const curvFactor = MapView.CURVATURE_THRESHOLD / (MapView.CURVATURE_THRESHOLD + curv);
        const allowedSpeedAtCurve = effectiveCurve + (effectiveCruise - effectiveCurve) * curvFactor;
        const distToCurve = d - phys.d;
        const maxApproachSpeed = Math.sqrt(allowedSpeedAtCurve * allowedSpeedAtCurve + 2 * effectiveBrake * distToCurve);
        if (maxApproachSpeed < safeSpeed) safeSpeed = maxApproachSpeed;
      }
      this._curveLookaheadCache.set(id, { d: phys.d, ctrl: controlScalar, cruise: effectiveCruise, safeSpeed });
    }
    
    // Calculate target speed based on:
    // 1. Distance to end of visible road (brake to stop)
    // 2. Safe speed for curves ahead (calculated above)
    // 3. Effective cruise speed (modulated by control scalar)
    const distToVisibleEnd = visibleEnd - phys.d;
    
    let targetSpeed;
    if (distToVisibleEnd <= 0) {
      // Already at or past visible end - full stop
      targetSpeed = 0;
    } else if (distToVisibleEnd < MapView.STOP_BUFFER) {
      // Very close to visible end - slow crawl proportional to distance
      targetSpeed = Math.min(2 * Math.max(1, controlScalar), distToVisibleEnd * 0.5);
    } else {
      // Distance-limited speed: v² = 2as → v = sqrt(2 * brakeRate * distance)
      // Use a safety factor of 0.8 to ensure we don't overshoot
      const brakeSpeed = Math.sqrt(2 * effectiveBrake * Math.max(0, distToVisibleEnd - MapView.STOP_BUFFER)) * 0.8;
      
      // Take minimum of all limits
      targetSpeed = Math.min(effectiveCruise, brakeSpeed, safeSpeed);
    }
    
    // Apply acceleration or braking (both scaled by control scalar)
    if (phys.v < targetSpeed) {
      // Accelerate
      phys.v = Math.min(targetSpeed, phys.v + effectiveAccel * dtS);
    } else if (phys.v > targetSpeed) {
      // Brake (never reduced below base rate for safety)
      phys.v = Math.max(targetSpeed, phys.v - effectiveBrake * dtS);
    }
    
    // Safety clamps
    phys.v = clamp(phys.v, 0, effectiveCruise);
    
    // Update position - but don't exceed visible end
    const proposedD = phys.d + phys.v * dtS;
    if (proposedD >= visibleEnd) {
      // Would overshoot - clamp to visible end and stop
      phys.d = visibleEnd;
      phys.v = 0;
    } else {
      phys.d = proposedD;
    }
    
    // Cannot go backwards or past total path end
    phys.d = clamp(phys.d, 0, totalDist);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // WAYPOINT STEERING: Vehicle has 2D position that steers toward waypoints
    // instead of being locked to a rail. The physics distance (phys.d) determines
    // which waypoint to target, but the actual position uses steering dynamics.
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Sample raw path position (where GPS says we should be)
    const rawSample = this._samplePathAtDistance(pts, cumDist, curvature, phys.d);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // PROGRESSIVE SPLINE SAMPLING
    // 
    // The waypoint window now comes from a PROGRESSIVE spline path where:
    // - Past segments are LOCKED (computed with tension at time of traversal)
    // - Future segments use CURRENT tension (based on current speed)
    // 
    // The vehicle samples its position from this progressive path, which is
    // indexed by cumulative distance. We map phys.d (raw GPS distance) to the
    // progressive path's cumulative distance.
    // ═══════════════════════════════════════════════════════════════════════════
    
    let waypointSample;
    if (waypointWindow && smoothWaypoints.length >= 2) {
      // The progressive path has its own cumulative distances
      // Map phys.d (distance on raw GPS) to progressive path distance
      //
      // Strategy: Find the computed path point corresponding to our raw distance
      // by interpolating based on rawIdx values in the computed points
      
      // Get the full progressive path for this vehicle
      const path = this._vehiclePathById?.get(id);
      if (path && path.computedPts.length >= 2) {
        const cpts = path.computedPts;
        const ccum = path.cumDist;
        
        // Find where phys.d falls in raw GPS cumDist
        let rawIdx = 0;
        let rawFrac = 0;
        for (let i = 0; i < cumDist.length - 1; i++) {
          if (cumDist[i + 1] >= phys.d) {
            rawIdx = i;
            const segLen = cumDist[i + 1] - cumDist[i];
            rawFrac = segLen > 0 ? (phys.d - cumDist[i]) / segLen : 0;
            break;
          }
          rawIdx = i;
        }
        const rawIdxFrac = rawIdx + rawFrac;
        
        // Find corresponding position in computed path
        let compIdx = 0;
        for (let i = 0; i < cpts.length - 1; i++) {
          if (cpts[i + 1].rawIdx >= rawIdxFrac) {
            compIdx = i;
            break;
          }
          compIdx = i;
        }
        
        // Interpolate between computed points
        const cp0 = cpts[compIdx];
        const cp1 = cpts[Math.min(cpts.length - 1, compIdx + 1)];
        const rawIdxSpan = cp1.rawIdx - cp0.rawIdx;
        const t = rawIdxSpan > 0 ? clamp((rawIdxFrac - cp0.rawIdx) / rawIdxSpan, 0, 1) : 0;
        
        waypointSample = {
          lat: cp0.lat + t * (cp1.lat - cp0.lat),
          lon: cp0.lon + t * (cp1.lon - cp0.lon),
          heading: Math.atan2(cp1.lat - cp0.lat, cp1.lon - cp0.lon),
          m: cp1.m,
          readings: cp1.readings
        };
      } else {
        waypointSample = rawSample;
      }
    } else {
      // Fallback: use raw sample
      waypointSample = rawSample;
    }
    
    // Initialize 2D physics state if needed (use needsSnap from earlier)
    if (phys.lat == null || phys.lon == null || needsSnap) {
      // Start at raw GPS position (not spline, to avoid teleport on speed change)
      phys.lat = rawSample.lat;
      phys.lon = rawSample.lon;
      phys.heading = rawSample.heading;
    }
    
    // Steering toward RAW GPS position with damping
    // This ensures vehicle never teleports when speed changes (spline recomputes).
    // Physics provides natural smoothing through steering inertia.
    // Skip steering blend when actively scrubbing — marker must track controller exactly.
    if (!this._scrubbing) {
      const STEER_RATE = 3.0; // How fast to steer toward waypoint (higher = snappier)
      const steerFactor = 1 - Math.exp(-STEER_RATE * dtS);
      
      // Blend current position toward raw GPS sample
      phys.lat += steerFactor * (rawSample.lat - phys.lat);
      phys.lon += steerFactor * (rawSample.lon - phys.lon);

      // Smooth heading toward raw GPS heading
      let headingDiff = rawSample.heading - phys.heading;
      // Wrap to [-π, π]
      while (headingDiff > Math.PI) headingDiff -= 2 * Math.PI;
      while (headingDiff < -Math.PI) headingDiff += 2 * Math.PI;
      phys.heading += steerFactor * headingDiff;
    }
    
    // Record actual vehicle path for debug visualization
    // This captures the dynamically computed steering path, not the waypoints
    if (this._pbDebugPath) {
      if (!this._vehicleActualPathById) this._vehicleActualPathById = new Map();
      let actualPath = this._vehicleActualPathById.get(id);
      if (!actualPath || needsSnap) {
        actualPath = [];
        this._vehicleActualPathById.set(id, actualPath);
      }
      // Record position at regular distance intervals to avoid excessive points
      const lastPt = actualPath.length > 0 ? actualPath[actualPath.length - 1] : null;
      const recordInterval = 2; // meters between recorded points
      if (!lastPt || Math.abs(phys.d - lastPt.d) >= recordInterval) {
        actualPath.push({ lat: phys.lat, lon: phys.lon, d: phys.d });
        // Limit buffer size - keep window around current position
        const maxBehind = 50; // points behind vehicle
        const maxAhead = 10; // points ahead (from scrub-back)
        while (actualPath.length > maxBehind + maxAhead) {
          // Remove oldest point if it's behind current position
          if (actualPath[0].d < phys.d - maxBehind * recordInterval) {
            actualPath.shift();
          } else {
            break;
          }
        }
      }
    }
    
    const lat = phys.lat;
    const lon = phys.lon;
    const heading = phys.heading;
    const { idx, u, p0, p1 } = rawSample;
    
    // Get segment info for readings and visibility (from raw path)
    const nextPoint = p1 || pts[Math.min(idx + 1, pts.length - 1)];
    const prevPoint = p0 || pts[idx];
    const dtMs = Math.max(1, (nextPoint.tMs - prevPoint.tMs));
    
    // Calculate vehicle's actual time position (for trail reveal)
    // Interpolate time based on position within segment
    const vehicleTMs = prevPoint.tMs + (nextPoint.tMs - prevPoint.tMs) * u;
    
    // Calculate true GPS speed for the current segment (real-world speed)
    // We use the raw segment (idx) that the vehicle is currently traversing
    let trueSpeedMps = 0;
    if (idx < pts.length - 1) {
      const pStart = pts[idx];
      const pEnd = pts[idx + 1];
      const distM = cumDist[idx + 1] - cumDist[idx];
      const timeS = (pEnd.tMs - pStart.tMs) / 1000;
      if (timeS > 0.1) {
        trueSpeedMps = distM / timeS;
      }
    }

    // Use true GPS speed for display, not the playback-scaled physics velocity
    // let speedMps = phys.v;
    let speedMps = trueSpeedMps;
    if (t >= tMax - 1) speedMps = 0;

    // Determine transient visibility
    let opacity = 1.0;
    const dimOpacity = 0.25;
    const movingFlag = !!(nextPoint && (nextPoint.m === 1 || nextPoint.m === "1" || nextPoint.m === true));
    if (!m._key) m._key = keyFor("mobile", m.id);
    const key = m._key;
    const isSel = (this.selectedId === key);

    if (!movingFlag && !this._pbDebugPath && !isSel) {
      opacity = dimOpacity;
    }

    if (dtMs > 305000 && t > prevPoint.tMs + 5000 && t < nextPoint.tMs - 5000 && !this._pbDebugPath && !isSel) {
      opacity = dimOpacity;
    }

    // Convert lat/lon heading to screen heading (Mercator projection).
    // Cached: skip 2× latLonToWorld + atan2 when position/zoom barely changed.
    if (!this._screenHeadingCache) this._screenHeadingCache = new Map();
    let _shc = this._screenHeadingCache.get(id);
    let screenHeading;
    const _shcStale = !_shc || needsSnap
      || Math.abs(lat - _shc.lat) > 1e-6 || Math.abs(lon - _shc.lon) > 1e-6
      || Math.abs(heading - _shc.heading) > 0.01 || this.zoom !== _shc.zoom;
    if (!_shcStale) {
      screenHeading = _shc.screenHeading;
    } else {
      const currWorld = latLonToWorld(lat, lon, this.zoom);
      const epsilon = 0.0001;
      const aheadWorld = latLonToWorld(
        lat + Math.sin(heading) * epsilon,
        lon + Math.cos(heading) * epsilon,
        this.zoom
      );
      let dx = aheadWorld.x - currWorld.x;
      let dy = aheadWorld.y - currWorld.y;
      if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) { dx = 1e-3; dy = 0; }
      screenHeading = Math.atan2(dy, dx);
      this._screenHeadingCache.set(id, { lat, lon, heading, zoom: this.zoom, screenHeading });
    }

    const absH = Math.abs(screenHeading);
    const dead = 0.22;
    const switchToLeft = (Math.PI / 2) + dead;
    const switchToRight = (Math.PI / 2) - dead;
    let side = this._traceLastSideById.get(id);
    if (side !== "L" && side !== "R") side = (absH > Math.PI / 2) ? "L" : "R";
    if (side === "R" && absH > switchToLeft) side = "L";
    else if (side === "L" && absH < switchToRight) side = "R";
    this._traceLastSideById.set(id, side);

    let renderAngle = screenHeading;
    if (side === "L") renderAngle = Math.PI - screenHeading;
    if (renderAngle > Math.PI) renderAngle -= Math.PI * 2;
    if (renderAngle < -Math.PI) renderAngle += Math.PI * 2;

    const wrapAngle = (ang) => {
      let x = ang;
      while (x > Math.PI) x -= Math.PI * 2;
      while (x < -Math.PI) x += Math.PI * 2;
      return x;
    };
    const prevA = this._traceAngleById.get(id);
    const lastMs = this._traceAngleLastMsById.get(id);
    const dtAngleS = (lastMs != null && isFinite(lastMs)) ? Math.max(0, (nowPerfMs - lastMs) / 1000) : 0;
    const tauS = 0.25; // Slightly faster angle response for responsiveness
    const alpha = dtAngleS > 0 ? (1 - Math.exp(-dtAngleS / tauS)) : 1;
    const nextA = (prevA == null)
      ? renderAngle
      : wrapAngle(prevA + wrapAngle(renderAngle - prevA) * alpha);
    this._traceAngleById.set(id, nextA);
    this._traceAngleLastMsById.set(id, nowPerfMs);

    // Marker reading: use the segment at the PHYSICS position (phys.d), not time position.
    // idx and nextPoint are from _samplePathAtDistance(phys.d) - they match where the marker is drawn.
    const reading = primaryReadingKeyedFromPoint(nextPoint);

    // Store debug info for trail drawing
    if (!this._vehicleRevealDist) this._vehicleRevealDist = new Map();
    this._vehicleRevealDist.set(id, {
      d: targetD,                // Playback-time position
      visibleEnd,                // Where vehicle stops (= targetD, no lookahead)
      vehicleD: phys.d,          // Actual vehicle position (for debug)
      vehicleV: phys.v,          // Actual vehicle velocity (for debug)
      vehicleTMs,                // Actual vehicle time (for trail reveal)
      controlScalar,             // Control scalar σ(ε, ω) for debug
      positionError,             // Normalized position error ε
      totalDist
    });

    return { lat, lon, angle: nextA, flipX: (side === "L"), speedMps, opacity, reading, readings: nextPoint.readings, beforeFirst: t < tMin };
  }

  _ensureTracePoints(state) {
    const key = this._tracePointsKeyForState(state);
    if (this._tracePtsKey === key) return;
    this._tracePtsKey = key;

    const nextPtsById = new Map();
    const nextRoutesById = new Map();
    const mobiles = Array.isArray(state?.mobile) ? state.mobile : [];
    for (const m of mobiles) {
      const id = m && m.id ? String(m.id) : "";
      if (!id) continue;

      // Idle/ghosted vehicles should not produce trace routes.
      // Clear any prior active/pending route so the marker stays stationary.
      if (m && m.ghosted) {
        this._traceActiveRouteById.delete(id);
        this._tracePendingRouteById.delete(id);
        this._traceCycleStartMsById.delete(id);
        continue;
      }

      const trail = Array.isArray(m?.trail) ? m.trail : [];
      const pts = [];
      const hasServerTrail = (trail.length >= 2);
      const hasActiveRoute = this._traceActiveRouteById.has(id);
      const persisted = (this._persistedTrailById.get(id)?.trail || []);

      // If the server drops history for a cycle (refresh/TTL/etc), do NOT replace
      // an active route with a tiny cached tail. Keep the last route so the bus
      // stays on its path until we have a real trail again.
      if (!hasServerTrail && hasActiveRoute) {
        this._tracePendingRouteById.delete(id);
        continue;
      }

      // Trace mode should replay the full path accumulated since the app started.
      // Prefer persisted trail (which accumulates) when available; otherwise fall back to server trail.
      const src = (persisted.length >= 2) ? persisted : trail;
      if (src.length < 2) continue;

      // Build time-aware points. If timestamps are missing, synthesize a stable time series.
      const t0 = (src[0] && typeof src[0].t === "string") ? parseUtcMs(src[0].t) : null;
      const baseMs = (t0 != null) ? t0 : 0;
      const synthStepMs = 3000;

      for (let i = 0; i < src.length; i++) {
        const p = src[i];
        const lat = Number(p.lat), lon = Number(p.lon);
        if (!isFinite(lat) || !isFinite(lon)) continue;
        const tMsRaw = (p && typeof p.t === "string") ? parseUtcMs(p.t) : null;
        const tMs = (tMsRaw != null) ? tMsRaw : (baseMs + (i * synthStepMs));
        pts.push({ lat, lon, tMs, m: p.m });
      }

      if (pts.length >= 2) {
        nextPtsById.set(id, pts);

        // Precompute a smoothed, bus-like time model:
        // - Base on real GPS time deltas when present (relative speed changes)
        // - Normalize to a watchable speed (so sparse GPS doesn't crawl)
        // - Low-pass filter speeds so accel/brake is gradual
        // - Add dwell time for stop-like segments
        const pauseMs = 5000;
        const vmax = Number(this._traceMaxSpeedMps) || 18;
        const realVmax = Number(this._traceRealMaxSpeedMps) || 20.0;
        const targetMedian = Number(this._traceTargetMedianSpeedMps) || 7.0;
        const tau = Number(this._traceSpeedSmoothingTauS) || 1.6;
        const stopV = Number(this._traceStopSpeedMps) || 0.25;
        const dwellCompress = Number(this._traceDwellTimeCompression) || 12.0;
        const stopMinMs = Number(this._traceStopMinMs) || 350;
        const stopMaxMs = Number(this._traceStopMaxMs) || 3500;

        // First pass: derive raw speeds from GPS timing.
        const rawV = [];
        const distM = [];
        const dtRawS = [];
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i];
          const b = pts[i + 1];
          const dist = haversineMeters(a.lat, a.lon, b.lat, b.lon);
          let dtRaw = (b.tMs - a.tMs);
          if (!isFinite(dtRaw) || dtRaw <= 0) dtRaw = synthStepMs;
          const dtS = Math.max(0.2, dtRaw / 1000);
          const v = dist / dtS;
          distM.push(dist);
          dtRawS.push(dtS);
          rawV.push(isFinite(v) ? v : 0);
        }

        // Robust scale: map median moving speed to targetMedian.
        const moving = rawV
          .map((v, i) => ({ v, i }))
          .filter(x => isFinite(x.v) && x.v > 0.4 && distM[x.i] > 8);
        let scale = 1.0;
        if (moving.length >= 3) {
          const sorted = moving.map(x => x.v).sort((a, b) => a - b);
          const mid = Math.floor(sorted.length / 2);
          const med = (sorted.length % 2) ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
          if (isFinite(med) && med > 0.001) {
            scale = clamp(targetMedian / med, 0.8, 25.0);
          }
        }

        const segStartMs = [];
        const segDurMs = [];
        const segSpeedMps = []; // playback effective speed (m/s)
        const segRealSpeedMps = []; // GPS-derived speed (m/s)
        let tCum = 0;
        let vSmooth = 0;
        let vRealSmooth = 0;

        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i];
          const b = pts[i + 1];
          const dist = distM[i] || 0;
          const dtS = dtRawS[i] || 1.0;

          // Target speed from GPS, normalized to watchable playback.
          let vTarget = rawV[i] * scale;
          if (!isFinite(vTarget)) vTarget = 0;
          vTarget = clamp(vTarget, 0, vmax);

          const isStopLike = (dist < 3) || (vTarget < stopV);

          const alpha = 1 - Math.exp(-dtS / tau);
          vSmooth = vSmooth + alpha * (vTarget - vSmooth);

          let dtEff;
          if (isStopLike) {
            // Dwell based on how long the GPS stayed "there", but compressed.
            dtEff = (dtS * 1000) / Math.max(1.0, dwellCompress);
            dtEff = clamp(dtEff, stopMinMs, stopMaxMs);
            segSpeedMps.push(0);
            segRealSpeedMps.push(0);
          } else {
            const vEff = Math.max(0.8, Math.min(vSmooth, vmax));
            dtEff = (dist / vEff) * 1000;
            dtEff = clamp(dtEff, 120, 8000);
            segSpeedMps.push(dist > 0 ? (dist / Math.max(0.001, dtEff / 1000)) : 0);

            // Real-world speed estimate from GPS timing (not normalized playback).
            let vReal = rawV[i];
            if (!isFinite(vReal)) vReal = 0;
            vReal = clamp(vReal, 0, realVmax);
            const alphaReal = 1 - Math.exp(-dtS / Math.max(0.8, tau));
            vRealSmooth = vRealSmooth + alphaReal * (vReal - vRealSmooth);
            segRealSpeedMps.push(clamp(vRealSmooth, 0, realVmax));
          }

          segStartMs.push(tCum);
          segDurMs.push(dtEff);
          tCum += dtEff;
        }

        const driveMs = Math.max(1, tCum);

        // NOTE: "rewind at the end of time" logic (loop return) is intentionally disabled.
        // This used to add a fast "return" segment after reaching the end, which makes the
        // playback jump back toward the loop start.
        //
        // // Prevent loop "teleport": after pausing at the end, drive back to the loop start quickly.
        // const loopStartPt = pts[0];
        // const endPt = pts[pts.length - 1] || loopStartPt;
        // const backDistM = haversineMeters(endPt.lat, endPt.lon, loopStartPt.lat, loopStartPt.lon);
        // const returnMs = (isFinite(backDistM) && backDistM > 3)
        //   ? clamp(1000 + (backDistM / 250) * 1000, 1000, 3000)
        //   : 0;
        // const totalMsWithReturn = driveMs + pauseMs + returnMs;

        const loopStartPt = pts[0];
        const returnMs = 0;
        const totalMsWithReturn = driveMs + pauseMs;

        nextRoutesById.set(id, {
          pts,
          segStartMs,
          segDurMs,
          segSpeedMps,
          segRealSpeedMps,
          driveMs,
          pauseMs,
          returnMs,
          loopStartLat: loopStartPt.lat,
          loopStartLon: loopStartPt.lon,
          totalMs: totalMsWithReturn,
          newPathStartMs: 0,
        });
      }
    }

    // Replace the points cache for debugging/introspection purposes.
    this._tracePtsById.clear();
    for (const [id, pts] of nextPtsById.entries()) this._tracePtsById.set(id, pts);

    // Route swapping behavior:
    // - If we don't have an active route for an id, adopt immediately.
    // - If we do, store as pending and swap only when the loop restarts.
    for (const [id, route] of nextRoutesById.entries()) {
      if (this._traceActiveRouteById.has(id)) this._tracePendingRouteById.set(id, route);
      else this._traceActiveRouteById.set(id, route);
    }
  }

  // ─── Advection-diffusion wind field integration ─────────────────────────

  /**
   * Collect sensor data in geographic coordinates for the advection worker.
   * Returns [{lat, lon, value}, ...] — all fixed+PA sensors with valid PM2.5.
   */
  _collectGeoSensors(state, playbackTimeMs) {
    const fixed = Array.isArray(state && state.fixed) ? state.fixed : [];
    const paLatLons = [];
    for (const f of fixed) {
      if (!f || !f.purpleair) continue;
      const lat = Number(f.lat), lon = Number(f.lon);
      if (isFinite(lat) && isFinite(lon)) paLatLons.push(lat, lon);
    }
    const sensors = [];
    for (const f of fixed) {
      if (!f) continue;
      if (f.outlier) continue;
      const lat = Number(f.lat), lon = Number(f.lon);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      if (!f.purpleair) {
        let nearPA = false;
        for (let pi = 0; pi < paLatLons.length; pi += 2) {
          const dlat = lat - paLatLons[pi], dlon = lon - paLatLons[pi + 1];
          if (dlat * dlat + dlon * dlon < _PA_FIELD_NON_PURPLEAIR_PROXIMITY_DEG * _PA_FIELD_NON_PURPLEAIR_PROXIMITY_DEG) { nearPA = true; break; }
        }
        if (!nearPA) continue;
      }
      const interp = interpolateFixedReadingsAtTime(f, playbackTimeMs);
      const pm = interp && (interp["PM25"] || interp["PM2.5"] || interp["pm25"] || interp["pm2.5"]);
      if (pm && pm.outlier) continue;
      const value = pm && pm.value != null ? Number(pm.value) : NaN;
      if (!isFinite(value) || value < 0) continue;
      sensors.push({ lat, lon, value });
    }
    return sensors;
  }

  /** Build a color-category fingerprint for geo sensors. */
  _geoSensorFingerprint(sensors) {
    let fp = "";
    for (const s of sensors) fp += _pm25ColorCat(s.value);
    return fp;
  }

  /** Fetch all wind snapshots from /api/wind-field (returns {HHMM: points[]}). */
  /**
   * Merge a single wind snapshot received via SSE into the existing snapshots.
   * Avoids a full /api/wind-field refetch.
   * @param {string} key - HHMM key (e.g. "1430")
   * @param {Array} points - Array of {lat, lon, u, v} objects
   */
  mergeWindSnapshot(key, points) {
    if (!key || !points) return;
    // Accept both grid objects and legacy point arrays
    if (Array.isArray(points) && !points.length) return;
    if (typeof points === "object" && !Array.isArray(points) && !points.uGrid) return;
    if (!this._windSnapshots) this._windSnapshots = {};
    this._windSnapshots[key] = points;
    this._windSnapshotKeys = Object.keys(this._windSnapshots).sort();
    // Update current field to latest snapshot
    if (this._windSnapshotKeys.length > 0) {
      const latest = this._windSnapshotKeys[this._windSnapshotKeys.length - 1];
      this._windField = this._windSnapshots[latest];
    }
    // Bump the etag so the next _fetchWindField doesn't overwrite with stale data
    this._windFieldEtag = null;
    // Trigger a redraw if we have state (skip during gestures — next frame picks it up)
    if (this.lastState && !this._isGesturing()) {
      requestAnimationFrame(() => {
        this._compositePaFieldOnTiles(this.lastState);
        this.drawOverlay(this.lastState, { cacheUnderlay: true });
      });
    }
  }

  _fetchWindField() {
    if (this._windFieldFetchInFlight) return;
    const now = performance.now();
    if (now - this._windFieldLastFetch < this._windFieldFetchInterval && this._windSnapshots) return;
    this._windFieldFetchInFlight = true;
    this._windFieldLastFetch = now;
    const headers = { "X-App-Token": APP_TOKEN };
    if (this._windFieldEtag) headers["If-None-Match"] = this._windFieldEtag;
    fetch("/api/wind-field", { headers })
      .then(res => {
        if (res.status === 304) return null;
        if (!res.ok) return null;
        this._windFieldEtag = res.headers.get("ETag") || null;
        return res.json();
      })
      .then(data => {
        if (!data || typeof data !== "object") return;
        const wasNull = !this._windSnapshots;
        if (Array.isArray(data)) {
          // Legacy flat point array — treat as single "now" entry
          if (data.length > 0) {
            this._windSnapshots = { "0000": data };
            this._windSnapshotKeys = ["0000"];
            this._windField = data;
          }
        } else if (data.gw != null && data.uGrid != null) {
          // Single grid object (legacy fallback from wind_field_json)
          this._windSnapshots = { "0000": data };
          this._windSnapshotKeys = ["0000"];
          this._windField = data;
        } else {
          // Time-indexed: {"HHMM": grid_or_array, ...}
          this._windSnapshots = data;
          this._windSnapshotKeys = Object.keys(data).sort();
          // Set current field to latest snapshot
          if (this._windSnapshotKeys.length > 0) {
            const latest = this._windSnapshotKeys[this._windSnapshotKeys.length - 1];
            this._windField = data[latest];
          }
        }
        if (wasNull && this.lastState) {
          requestAnimationFrame(() => {
            this._compositePaFieldOnTiles(this.lastState);
            this.drawOverlay(this.lastState, { cacheUnderlay: true });
          });
        }
      })
      .catch(() => { /* silent */ })
      .finally(() => { this._windFieldFetchInFlight = false; });
  }

  /** Interpolate u,v components between two wind field snapshots.
   *  Supports both grid objects {gw, gh, uGrid, vGrid, bounds} and
   *  legacy point arrays [{lat, lon, u, v}, ...].
   *  Returns an interpolated snapshot in the same format as the inputs. */
  _interpolateWindFields(fieldA, fieldB, alpha) {
    if (!fieldA || !fieldB) return fieldA;
    // Grid object path
    if (fieldA.gw != null && fieldA.uGrid && fieldB.gw != null && fieldB.uGrid) {
      const n = fieldA.gw * fieldA.gh;
      const uA = fieldA.uGrid, vA = fieldA.vGrid;
      const uB = fieldB.uGrid, vB = fieldB.vGrid;
      if (uA.length !== n || uB.length !== n) return fieldA;
      const uGrid = new Array(n), vGrid = new Array(n);
      for (let i = 0; i < n; i++) {
        uGrid[i] = Math.round(((1 - alpha) * (uA[i] || 0) + alpha * (uB[i] || 0)) * 1000) / 1000;
        vGrid[i] = Math.round(((1 - alpha) * (vA[i] || 0) + alpha * (vB[i] || 0)) * 1000) / 1000;
      }
      return { gw: fieldA.gw, gh: fieldA.gh, bounds: fieldA.bounds, uGrid, vGrid };
    }
    // Legacy point-array path
    if (!Array.isArray(fieldA) || !Array.isArray(fieldB)) return fieldA;
    if (fieldA.length !== fieldB.length) return fieldA;
    
    const result = [];
    for (let i = 0; i < fieldA.length; i++) {
      const ptA = fieldA[i], ptB = fieldB[i];
      if (!ptA || !ptB) continue;
      const lat = Number(ptA.lat), lon = Number(ptA.lon);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      const uA = Number(ptA.u) || 0;
      const vA = Number(ptA.v) || 0;
      const uB = Number(ptB.u) || 0;
      const vB = Number(ptB.v) || 0;
      // Linear interpolation: (1-α)·u_A + α·u_B
      const u = (1 - alpha) * uA + alpha * uB;
      const v = (1 - alpha) * vA + alpha * vB;
      result.push({ lat, lon, u, v });
    }
    return result.length > 0 ? result : fieldA;
  }

  /** Pick the wind snapshot active at a given epoch-ms time (or latest if live).
   *  Interpolates between snapshots during playback; returns discrete snapshot if scrubbing.
   *  Returns null if no snapshots available. */
  _windFieldForTime(epochMs, doInterpolate = false) {
    if (!this._windSnapshots || this._windSnapshotKeys.length === 0) return this._windField;
    if (epochMs == null || !isFinite(epochMs)) {
      // Live mode — use latest
      const latest = this._windSnapshotKeys[this._windSnapshotKeys.length - 1];
      return this._windSnapshots[latest] || this._windField;
    }
    
    // Convert epoch ms to minutes since midnight UTC
    const d = new Date(epochMs);
    const totalMinUTC = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
    
    // Floor/ceil to 15-min boundaries (in total minutes)
    const floorMin = Math.floor(totalMinUTC / 15) * 15;
    const ceilMin = floorMin + 15;
    
    // Convert total minutes → "HHMM" key
    const minToKey = (m) => {
      const h = Math.floor(m / 60) % 24;
      const mn = m % 60;
      return String(h).padStart(2, "0") + String(mn).padStart(2, "0");
    };
    const keyFloor = minToKey(floorMin);
    const keyCeil = minToKey(ceilMin);
    
    // Look up snapshot indices
    let keyFloorIndex = -1, keyCeilIndex = -1;
    for (let i = 0; i < this._windSnapshotKeys.length; i++) {
      if (this._windSnapshotKeys[i] === keyFloor) keyFloorIndex = i;
      if (this._windSnapshotKeys[i] === keyCeil) keyCeilIndex = i;
    }
    
    // If we don't have both snapshots, return the latest one we have <= target
    if (keyFloorIndex < 0 || keyCeilIndex < 0) {
      let best = null;
      for (let i = this._windSnapshotKeys.length - 1; i >= 0; i--) {
        if (this._windSnapshotKeys[i] <= keyFloor) {
          best = this._windSnapshotKeys[i];
          break;
        }
      }
      return best ? this._windSnapshots[best] : null;
    }
    
    // Interpolate if requested and we have both boundaries
    if (doInterpolate) {
      const fieldA = this._windSnapshots[keyFloor];
      const fieldB = this._windSnapshots[keyCeil];
      if (fieldA && fieldB) {
        // Alpha: progress from floor to ceil (0 at floor, 1 at ceil)
        const alpha = (totalMinUTC - floorMin) / 15;
        return this._interpolateWindFields(fieldA, fieldB, Math.max(0, Math.min(1, alpha)));
      }
    }
    
    // No interpolation: return floor snapshot
    return this._windSnapshots[keyFloor];
  }

  /** Initialize or re-initialize the advection worker with current sensors + wind. */
  _initAdvectionWorker(sensors, fieldAlpha) {
    if (!this._advectionWorker) {
      try {
        this._advectionWorker = new Worker("pa_advection_worker.js?v=20260327a");
        this._advectionWorker.onmessage = (e) => this._onAdvectionFrame(e.data);
      } catch (_) {
        this._advectionWorker = false;
        return;
      }
    }
    if (!this._advectionWorker) return;

    const params = {
      cutoffDeg: 0.5,
      D: 500,
      lambda: 0.2,
      windScale: 1.0,
      settlingTicks: 20,
    };
    // Apply field debug overrides
    const _fd = window._fieldDebug;
    if (_fd.cutoffDeg != null) params.cutoffDeg = _fd.cutoffDeg;
    if (_fd.diffusion != null) params.D = _fd.diffusion;
    if (_fd.lambda != null) params.lambda = _fd.lambda;
    if (_fd.windScale != null) params.windScale = _fd.windScale;

    this._advectionWorker.postMessage({
      type: "init",
      sensors,
      windPoints: this._windField || [],
      params,
      fieldAlpha: fieldAlpha || 46,
    });

    this._advectionInitialized = true;
    this._advectionLastTickMs = performance.now();
  }

  /** Handle a rendered frame from the advection worker. */
  _onAdvectionFrame(data) {
    if (data.type !== "frame") return;
    const { px, gw, gh } = data;
    this._advectionFrame = { px: new Uint8ClampedArray(px), gw, gh };
    // Upscale to screen and store as offscreen canvas for compositing
    this._projectAdvectionToScreen();
    // Schedule a re-composite so the frame actually appears on screen
    if (!this._advectionRAF) {
      this._advectionRAF = requestAnimationFrame(() => {
        this._advectionRAF = null;
        if (this.lastState) {
          this._compositePaFieldOnTiles(this.lastState);
          this.drawOverlay(this.lastState, { cacheUnderlay: true });
        }
      });
    }
  }

  /**
   * Project the geographic-grid advection frame onto screen coordinates.
   * Uses the current view (center, zoom) to map each geo-cell onto the canvas.
   */
  _projectAdvectionToScreen() {
    const frame = this._advectionFrame;
    if (!frame) return;
    const { px, gw, gh } = frame;
    const cssW = this._cssW || 1;
    const cssH = this._cssH || 1;
    const dpr = this._dpr || (window.devicePixelRatio || 1);

    // Create a tiny canvas at geo-grid resolution
    if (!this._advGeoCanvas) {
      this._advGeoCanvas = document.createElement("canvas");
    }
    const gc = this._advGeoCanvas;
    if (gc.width !== gw || gc.height !== gh) {
      gc.width = gw; gc.height = gh;
    }
    const gctx = gc.getContext("2d");
    const imgData = gctx.createImageData(gw, gh);
    imgData.data.set(px);
    gctx.putImageData(imgData, 0, 0);

    // Now project geo grid onto screen: find the screen rect for the geo bounds
    const AS = typeof AdvectionSolver !== "undefined" ? AdvectionSolver : null;
    if (!AS) return;
    const bounds = AS.GEO_BOUNDS;
    const z = Number(this.zoom);
    const clat = Number(this.center?.lat);
    const clon = Number(this.center?.lon);
    const centerW = latLonToWorld(clat, clon, z);

    // Geo bounds corners → screen
    const topLeft = latLonToWorld(bounds.latMax, bounds.lonMin, z);
    const botRight = latLonToWorld(bounds.latMin, bounds.lonMax, z);
    const sx = topLeft.x - centerW.x + cssW / 2;
    const sy = topLeft.y - centerW.y + cssH / 2;
    const sw = botRight.x - topLeft.x;
    const sh = botRight.y - topLeft.y;

    // Upscale to full viewport canvas
    if (!this._advectionCanvas) this._advectionCanvas = document.createElement("canvas");
    const pw = Math.floor(cssW * dpr), ph = Math.floor(cssH * dpr);
    if (this._advectionCanvas.width !== pw || this._advectionCanvas.height !== ph) {
      this._advectionCanvas.width = pw;
      this._advectionCanvas.height = ph;
    }
    const ctx = this._advectionCanvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    // Draw the geo-grid canvas stretched to the screen projection rect
    ctx.drawImage(gc, sx, sy, sw, sh);
  }

  /**
   * Tick the advection simulation and re-render.
   * Called from _compositePaFieldOnTiles when advection mode is active.
   * During playback, uses interpolated wind field; otherwise discrete snapshot.
   */
  _tickAdvection(state, playbackTimeMs) {
    if (!this._advectionWorker || !this._advectionInitialized) return;

    const nowPerf = performance.now();
    // Real-time dt (capped to 2s by worker)
    let dt = (nowPerf - this._advectionLastTickMs) / 1000;
    this._advectionLastTickMs = nowPerf;
    if (dt <= 0 || dt > 5) dt = 0.016; // default ~60fps

    // Check if sensors changed → update IDW nudging target
    const geoSensors = this._collectGeoSensors(state, playbackTimeMs);
    const fp = this._geoSensorFingerprint(geoSensors);
    const sensorsChanged = fp !== this._advectionSensorFP;
    this._advectionSensorFP = fp;

    const _fd = window._fieldDebug;
    const FIELD_ALPHA = _fd.alpha != null ? _fd.alpha : (window._paFieldAlpha ?? 46);
    
    // During playback, interpolate between wind snapshots; otherwise use discrete snapshot
    const isPlaybackTick = this.playbackMode && playbackTimeMs != null && isFinite(playbackTimeMs);
    const windField = isPlaybackTick 
      ? this._windFieldForTime(playbackTimeMs, true) 
      : this._windField;

    this._advectionWorker.postMessage({
      type: "tick",
      dt,
      sensors: sensorsChanged ? geoSensors : undefined,
      windPoints: windField || [],
      fieldAlpha: FIELD_ALPHA,
    });
  }

  /**
   * Switch PA field to a different pollutant. Invalidates field cache and redraws.
   * @param {string} tab - Legend tab id: "pm25", "pm10", "o3", "no2", "co"
   */
  setPaFieldPollutant(tab) {
    const prev = this._paFieldPollutant;
    this._paFieldPollutant = tab || null;
    if (prev !== this._paFieldPollutant) {
      this._invalidateOverlayStatic();
      this._invalidatePaField();
      // Invalidate trail canvas cache so trails redraw with new pollutant colors
      this._trailCacheViewKey = "";
      this._trailCacheCanvas = null;
      this._redrawViewOnly();
    }
  }

  /** Synchronously look up the selected sensor's reading for a specific pollutant tab.
   *  Returns the numeric value or null. Does NOT require a render cycle. */
  getReadingForPollutant(tab) {
    if (!this.selectedId || !this.lastState || !tab) return null;
    const parsed = parseKey(this.selectedId);
    if (!parsed) return null;
    const list = (parsed.type === "mobile")
      ? (this.lastState.mobile || [])
      : (this.lastState.fixed || []);
    const sensor = list.find(s => s && String(s.id) === String(parsed.id));
    if (!sensor) return null;
    const pr = _readingForLegendTab(sensor.readings, tab);
    return (pr && pr.value != null) ? parseFloat(pr.value) : null;
  }

  /** Set marker pollutant override (only from explicit legend tab clicks). */
  setMarkerPollutantOverride(tab) {
    const prev = this._markerPollutantOverride;
    this._markerPollutantOverride = tab || null;
    if (prev !== this._markerPollutantOverride) {
      this._invalidateOverlayStatic();
      if (this.lastState) this.drawOverlay(this.lastState);
    }
  }

  /**
   * Animate PA field dim alpha toward target. Called from app.js when legend tab changes.
   * @param {number} target - 1.0 for full, 0.05 for dimmed
   */
  setPaFieldDim(target) {
    this._paFieldDimTarget = target;
    if (this._paFieldDimRAF) return; // animation already running
    const animate = () => {
      const diff = this._paFieldDimTarget - this._paFieldDimCurrent;
      if (Math.abs(diff) < 0.01) {
        this._paFieldDimCurrent = this._paFieldDimTarget;
        this._paFieldDimRAF = null;
        this._redrawViewOnly();
        return;
      }
      // Ease toward target (~200ms settle)
      this._paFieldDimCurrent += diff * 0.15;
      this._redrawViewOnly();
      this._paFieldDimRAF = requestAnimationFrame(animate);
    };
    this._paFieldDimRAF = requestAnimationFrame(animate);
  }

  /**
   * Composite the PA scalar field onto the tiles canvas (above tiles, below overlay).
   * Restores tiles from snapshot first to avoid opacity accumulation on repeated calls.
   */
  _compositePaFieldOnTiles(state, tilesJustRedrawn = false) {
    // Per-frame deduplication: skip if already composited this frame.
    {
      const _now = performance.now();
      if (!tilesJustRedrawn && this._compositeLastDrawMs && (_now - this._compositeLastDrawMs) < 4) return;
      this._compositeLastDrawMs = _now;
    }
    const pbMs = this.playbackMode ? this.getPlaybackTimeMs() : null;

    // Fetch wind field in background for debug vector overlay (does not affect PA field rendering)
    if (!_isLite) this._fetchWindField();

    // ── PERF PROBE ──
    {
      if (!this._perfProbe) this._perfProbe = { fastPath: 0, slowPath: 0, lastReport: 0, ensureMs: 0, ensureCalls: 0 };
      const _pp = this._perfProbe;
      const _now2 = performance.now();
      if (_now2 - _pp.lastReport > 2000) {
        if (_pp.fastPath + _pp.slowPath > 0) {
          // console.log(`[PA-PROBE] fast:${_pp.fastPath} slow:${_pp.slowPath} ensureAvg:${_pp.ensureCalls ? (_pp.ensureMs/_pp.ensureCalls).toFixed(1) : '-'}ms gesturing:${this._isGesturing()} transient:${this._isTransientAnimating()} scrub:${!!this._scrubbing} pinch:${this._pinchZooming} drag:${this._mouseDragging}`);
        }
        _pp.fastPath = 0; _pp.slowPath = 0; _pp.ensureMs = 0; _pp.ensureCalls = 0; _pp.lastReport = _now2;
      }
    }

    // ── Animation fast-path: transform existing PA field canvas instead of recomputing ──
    if (this._isTransientAnimating() && this._paFieldCanvas && this._paFieldComputedView) {
      if (this._perfProbe) this._perfProbe.fastPath++;
      const ctx = this.pfctx;
      if (!ctx) return;
      const pw = this.paFieldCanvasEl.width;
      const ph = this.paFieldCanvasEl.height;
      const dpr = this._dpr || (window.devicePixelRatio || 1);
      const cssW = this._cssW || 1;
      const cssH = this._cssH || 1;
      const prev = this._paFieldComputedView;
      const bufW = this._paFieldBufW || cssW;
      const bufH = this._paFieldBufH || cssH;
      const offX = (bufW - cssW) / 2;
      const offY = (bufH - cssH) / 2;

      // Margin exhaustion: if pan delta exceeds the overfetch margin, fall through
      // to the static path which will recompute the field centered on current view.
      const prevC = latLonToWorld(prev.centerLat, prev.centerLon, prev.zoom);
      const currC = latLonToWorld(this.center.lat, this.center.lon, prev.zoom);
      const absTx = Math.abs(prevC.x - currC.x);
      const absTy = Math.abs(prevC.y - currC.y);
      if (absTx >= offX * _OVERFETCH_MARGIN_EXHAUST || absTy >= offY * _OVERFETCH_MARGIN_EXHAUST) {
        // Force _ensurePaField to recompute despite animating
        this._paFieldMarginExhausted = true;
      } else {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, pw, ph);
        const sZoom = Math.pow(2, this.zoom - prev.zoom);
        if (Math.abs(sZoom - 1) > 0.001) {
          // Scale + translate around viewport center (mirrors drawTiles pinch path)
          const txPan = (prevC.x - currC.x) * sZoom;
          const tyPan = (prevC.y - currC.y) * sZoom;
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.translate(cssW / 2, cssH / 2);
          ctx.scale(sZoom, sZoom);
          ctx.translate((-cssW / 2) + (txPan / sZoom), (-cssH / 2) + (tyPan / sZoom));
        } else {
          // Pan only: translate
          const tx = prevC.x - currC.x;
          const ty = prevC.y - currC.y;
          ctx.setTransform(dpr, 0, 0, dpr, dpr * tx, dpr * ty);
        }
        ctx.globalAlpha = this._paFieldDimCurrent;
        const _uq = (window._fieldDebug && window._fieldDebug.upscaleQuality) || "high";
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = (_uq === "2pass") ? "medium" : _uq;
        ctx.drawImage(this._paFieldCanvas, -offX, -offY, bufW, bufH);
        ctx.restore();
        // Drop in-progress cross-fade to avoid stale fades during gesture
        this._paFieldPrevCanvas = null;
        return;
      }
    }

    // ── Static Nadaraya-Watson interpolation path ──
    if (this._perfProbe) this._perfProbe.slowPath++;
    {
      const _t0 = performance.now();
      this._ensurePaField(state, pbMs);
      const _dur = performance.now() - _t0;
      if (this._perfProbe) { this._perfProbe.ensureMs += _dur; this._perfProbe.ensureCalls++; }
    }
    if (pbMs != null && isFinite(pbMs)) this._preWarmPaFields(state, pbMs);
    const ctx = this.pfctx;
    if (!ctx) return;
    const pw = this.paFieldCanvasEl.width;
    const ph = this.paFieldCanvasEl.height;
    // Clear the dedicated PA field canvas every frame (no snapshot restore needed)
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pw, ph);
    if (!this._paFieldCanvas) { ctx.restore(); return; }

    // Overfetch offset: the field canvas is larger than the viewport.
    // Draw it shifted so the viewport windows over the center portion.
    // Use 9-param drawImage so source canvas can be any resolution (2pass = small).
    const _dpr = this._dpr || (window.devicePixelRatio || 1);
    const _cssW = this._cssW || 1;
    const _cssH = this._cssH || 1;
    const _bw = this._paFieldBufW || _cssW;
    const _bh = this._paFieldBufH || _cssH;
    const _offPx = (_bw - _cssW) / 2 * _dpr;
    const _offPy = (_bh - _cssH) / 2 * _dpr;
    const _uq = (window._fieldDebug && window._fieldDebug.upscaleQuality) || "high";
    const _iq = (_uq === "2pass") ? "medium" : _uq;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = _iq;

    // Helper: draw a PA field canvas (any resolution) into the viewport.
    const _drawPaCanvas = (src, alpha) => {
      ctx.globalAlpha = alpha;
      ctx.drawImage(src, 0, 0, src.width, src.height,
                    -_offPx, -_offPy, _bw * _dpr, _bh * _dpr);
    };

    // Cross-fade from previous field canvas to current one
    const dimAlpha = this._paFieldDimCurrent;
    const fadeT = this._paFieldPrevCanvas
      ? Math.min(1, (performance.now() - this._paFieldFadeStart) / this._paFieldFadeMs)
      : 1;
    if (this._paFieldPrevCanvas && fadeT < 1) {
      // Additive crossfade: prev*(1-t) + new*t under "lighter" composite gives
      // a linear color blend with constant alpha. In cells where prev == new
      // this collapses to exactly new*dimAlpha (no visible fade), so unchanged
      // regions stay still while changed regions smoothly morph. No masking,
      // no cell-boundary banding.
      _drawPaCanvas(this._paFieldPrevCanvas, (1 - fadeT) * dimAlpha);
      const prevOp = ctx.globalCompositeOperation;
      ctx.globalCompositeOperation = "lighter";
      _drawPaCanvas(this._paFieldCanvas, fadeT * dimAlpha);
      ctx.globalCompositeOperation = prevOp;
      ctx.globalAlpha = 1;
      // Schedule another frame to complete the fade (no-op if playback loop is running)
      if (!this._paFieldFadeRAF) {
        this._paFieldFadeRAF = requestAnimationFrame(() => {
          this._paFieldFadeRAF = null;
          this._compositePaFieldOnTiles(this.lastState);
          this.drawOverlay(this.lastState, { cacheUnderlay: true });
        });
      }
    } else {
      if (this._paFieldPrevCanvas) this._paFieldPrevCanvas = null;
      _drawPaCanvas(this._paFieldCanvas, dimAlpha);
    }
    ctx.restore();
  }

  /**
   * Precipitation-radar style: Nadaraya-Watson kernel regression of PM2.5 values
   * on a coarse grid, map each to a color via _pm25ToRgbSmooth, bilinear-upscale.
   *
   * V(P) = Σ(w_i · AQI_i) / Σ(w_i),  w_i = exp(-d²/2σ²)
   * (Gaussian kernel, AQI-space weighted mean)
   *
   * Optimized for real-time scrubbing:
   *  - Always synchronous (kernel regression is <2ms on a 16px grid)
   *  - Color-fingerprint cache: only recompute when a sensor changes AQI
   *    color category, not on every minor PM2.5 fluctuation
   *  - Web Worker pre-warms upcoming color transitions ahead of playhead
   *  - Reuses tiny canvas + ImageData across frames
   */
  _ensurePaField(state, playbackTimeMs) {
    const cssW = this._cssW || 1;
    const cssH = this._cssH || 1;
    if (cssW < 2 || cssH < 2) return; // not sized yet

    // During transient animations (gestures, easing), reuse cached PA field.
    // The composite step translates the cached canvas to match the current view.
    // Exception: if margin is exhausted, fall through to recompute centered on new view.
    if (this._isTransientAnimating() && this._paFieldCanvas && !this._paFieldMarginExhausted) return;
    this._paFieldMarginExhausted = false;

    const dpr = this._dpr || (window.devicePixelRatio || 1);
    const z = Number(this.zoom);
    const clat = Number(this.center?.lat);
    const clon = Number(this.center?.lon);
    const fixed = Array.isArray(state && state.fixed) ? state.fixed : [];

    // ── Viewport / reference-time setup (shared between the per-pollutant
    // max scan and the main single-pollutant field compute) ──
    const centerW = latLonToWorld(clat, clon, z);
    // Overfetch: collect sensors and compute the field on a buffer larger than
    // the viewport so gesture pans reveal pre-rendered content at the edges.
    const maxDevPx = _OVERFETCH_MAX_DEVICE_PX;
    const bufW = Math.min(Math.ceil(cssW * _OVERFETCH), Math.floor(maxDevPx / dpr));
    const bufH = Math.min(Math.ceil(cssH * _OVERFETCH), Math.floor(maxDevPx / dpr));

    // Reference time for PA staleness fade: use data "now", NOT the playback
    // scrub position.  last_seen is a live snapshot (not historical), so
    // comparing it against the scrub position causes all PA sensors to vanish
    // once the bar advances 45 min past last_seen.
    const _pbBounds = this.playbackMode ? this.getPlaybackBounds() : null;
    const _boundsMaxMs = (_pbBounds?.maxMs != null && isFinite(_pbBounds.maxMs)) ? _pbBounds.maxMs : null;
    const paRefNowMs = _boundsMaxMs ?? this._dataNowMs();
    // Virtual mobile sensors measure age against the scrub position so they
    // decay as the user moves the playhead (not pinned to data-max).
    const virtualRefNowMs = (this.playbackMode && playbackTimeMs != null && isFinite(playbackTimeMs))
      ? playbackTimeMs : paRefNowMs;

    // ── Fast skip: if view and data are unchanged and playback time is within
    // the validity window of the current fingerprint, no sensor can have changed
    // color category — skip the expensive _collectPaFieldSensors entirely. ──
    const viewKey = `${cssW}|${cssH}|${z.toFixed(4)}|${clat.toFixed(6)},${clon.toFixed(6)}`;
    const pollutantTab = this._paFieldPollutant || "pm25";
    if (this._paFieldCanvas
        && this._paFieldValidPollutant === pollutantTab
        && this._paFieldValidViewKey === viewKey
        && this._paFieldValidFixed === fixed
        && this._paFieldValidRange
        && playbackTimeMs >= this._paFieldValidRange.fromMs
        && playbackTimeMs < this._paFieldValidRange.toMs) {
      return;
    }

    const paField = _collectPaFieldSensors(fixed, playbackTimeMs, centerW, z, cssW, cssH, pollutantTab, bufW, bufH, paRefNowMs);
    const paSensors = paField.sensors;

    // ── Inject virtual sensors from mobile trail GPS points ──
    const mobiles = Array.isArray(state?.mobile) ? state.mobile : [];
    const virtualField = _collectVirtualMobileSensors(
      mobiles, playbackTimeMs, !!this.playbackMode, centerW, z, cssW, cssH, virtualRefNowMs, pollutantTab, bufW, bufH
    );
    this._virtualMobileSensors = virtualField.sensors;

    const allSensors = paSensors.concat(virtualField.sensors);
    const fingerprint = paField.fingerprint + (virtualField.fingerprint ? "|v:" + virtualField.fingerprint : "");
    const nSensors = allSensors.length;
    if (nSensors === 0) { this._paFieldCanvas = null; this._paFieldCtx = null; return; }

    const hasVirtuals = virtualField.sensors.length > 0;

    // ── Cache key: view geometry + color fingerprint + pollutant ──
    const key = `pa:${viewKey}|p:${pollutantTab}|f:${fingerprint}`;
    if (this._paFieldCanvas && this._paFieldKey === key) {
      // Cache hit -- update validity window so future frames skip
      // _collectPaFieldSensors.  Skip when virtual sensors are present:
      // their ages change every frame so the fast-skip must stay disabled.
      if (!hasVirtuals && !this._paFieldValidRange) {
        this._paFieldValidRange = _findFingerprintValidRange(fixed, playbackTimeMs);
        this._paFieldValidViewKey = viewKey;
        this._paFieldValidFixed = fixed;
        this._paFieldValidPollutant = pollutantTab;
      }
      return;
    }
    // Only cross-fade when the color fingerprint changes (sensor crosses AQI
    // boundary).  View-only changes (zoom/pan) recompute silently — no fade,
    // no stacking.
    const prevFingerprint = this._paFieldFingerprint || "";
    const fingerprintChanged = fingerprint !== prevFingerprint;
    if (this._paFieldCanvas && fingerprintChanged) {
      this._paFieldPrevCanvas = this._paFieldCanvas;
      this._paFieldCanvas = null;
      this._paFieldCtx = null;
      this._paFieldFadeStart = performance.now();
    } else {
      // View-only change — drop the previous canvas to avoid stale fades
      this._paFieldPrevCanvas = null;
    }
    this._paFieldKey = key;
    this._paFieldFingerprint = fingerprint;

    // ── Grid dimensions (based on overfetch buffer, not viewport) ──
    // Scale cell size with viewport area to keep per-cell density constant.
    const cellSize = Math.max(16, Math.ceil(Math.sqrt(cssW * cssH / 1400)));
    const gw = Math.ceil(bufW / cellSize);
    const gh = Math.ceil(bufH / cellSize);

    // ── Cutoff in screen pixels ──
    const _fd = window._fieldDebug;
    const cutoffDeg = _fd.cutoffDeg;
    const refW = latLonToWorld(clat, clon + cutoffDeg, z);
    const cutoffPx = Math.abs(refW.x - centerW.x);
    const cutoffSq = cutoffPx * cutoffPx;
    const FIELD_ALPHA = _fd.alpha != null ? _fd.alpha : (window._paFieldAlpha ?? 46);
    // Nadaraya-Watson Gaussian kernel bandwidth: σ = cutoff/sigmaDivisor (~2.5km 2σ-radius per sensor).
    const sigmaDivisor = _fd.sigmaDivisor;
    const sigma = cutoffPx / sigmaDivisor;
    const twoSigmaSq = 2 * sigma * sigma;

    // ── Build stride-5 sensor array: [sx, sy, aqi, twoSigSq, weightMultiplier, ...] ──
    // Blend in AQI space: the non-linear concentration→AQI transform gives high
    // concentrations proportionally more weight in the kernel average,
    // so a local spike stays visible instead of being diluted by neighbors.
    const aqiKey = _LEGEND_TAB_AQI_KEY[pollutantTab] || "pm2.5";
    const s5 = new Float64Array(nSensors * 5);
    for (let i = 0; i < nSensors; i++) {
      const sensor = allSensors[i];
      const si5 = i * 5;
      s5[si5] = sensor.sx;
      s5[si5 + 1] = sensor.sy;
      const aqi = valueToAqi(aqiKey, sensor.value);
      s5[si5 + 2] = (aqi != null && isFinite(aqi)) ? aqi : 0;
      s5[si5 + 3] = twoSigmaSq;
      s5[si5 + 4] = sensor.weightMultiplier;
    }

    // ── Wind-anisotropic kernel: single wind vector at map center ──
    // Wind field is smooth (~10s of km scale) — uniform across viewport at zoom 11-13.
    // No per-cell grid needed; one sample avoids view-dependent recomputation on pan.
    const wind = this._sampleWindAtCenter(centerW, z, clat, clon, playbackTimeMs, _fd);
    const effectiveCutoffSq = wind ? cutoffSq * wind.stretch * wind.stretch : cutoffSq;

    // ── Always synchronous — kernel regression is fast (<2ms on 16px grid) ──
    this._computePaFieldSync(s5, gw, gh, cellSize, effectiveCutoffSq, cutoffSq, FIELD_ALPHA, bufW, bufH, dpr, wind, cssW, cssH);

    // ── Per-pollutant field max: run the same kernel regression (viewport-
    // cells only, max AQI only) for each non-rendered pollutant so each
    // legend tab's color reflects its own pollutant's field data. Rendered
    // pollutant reuses the max from the main pass above. ──
    this._computePerPollutantFieldMax(
      state, playbackTimeMs, centerW, z, cssW, cssH, bufW, bufH,
      paRefNowMs, virtualRefNowMs,
      cellSize, gw, gh, cutoffSq, effectiveCutoffSq, wind, twoSigmaSq
    );

    // ── Store overfetch buffer dimensions for composite offset ──
    this._paFieldBufW = bufW;
    this._paFieldBufH = bufH;

    // ── Update fingerprint validity window for fast-path skipping ──
    // When virtual sensors are present their ages shift every frame, so the
    // fast-skip must stay disabled (no valid range).
    if (!hasVirtuals) {
      this._paFieldValidRange = _findFingerprintValidRange(fixed, playbackTimeMs);
      this._paFieldValidViewKey = viewKey;
      this._paFieldValidFixed = fixed;
      this._paFieldValidPollutant = pollutantTab;
    } else {
      this._paFieldValidRange = null;
    }
    // Store view state for gesture-time translate offset
    this._paFieldComputedView = { centerLat: clat, centerLon: clon, zoom: z };
  }

  /** Sample wind at map center, return { wx, wy, stretch, upwindShrink } in screen-pixel
   *  space, or null if no wind data / calm. Cached on wind field identity + zoom. */
  _sampleWindAtCenter(centerW, z, clat, clon, playbackTimeMs, _fd) {
    const windField = (this.playbackMode && playbackTimeMs != null && isFinite(playbackTimeMs))
      ? this._windFieldForTime(playbackTimeMs, true) : this._windField;
    if (!windField || !Array.isArray(windField) || windField.length < 2) return null;

    // Cache on wind field identity + zoom (not center — wind direction doesn't change on pan)
    if (this._windVecCache && this._windVecField === windField && this._windVecZoom === z)
      return this._windVecCache;

    const wspdMin  = _fd.wspdMin != null ? _fd.wspdMin : 0.3;
    const wspdMax  = _fd.wspdMax != null ? _fd.wspdMax : 5.0;
    const stretchMax   = _fd.stretchMax != null ? _fd.stretchMax : 2.5;
    const upwindShrink = _fd.upwindShrink != null ? _fd.upwindShrink : 0.5;

    // IDW sample wind at map center from existing wind field points
    let uSum = 0, vSum = 0, wt = 0;
    for (let i = 0; i < windField.length; i++) {
      const wp = windField[i];
      const dlat = clat - wp.lat, dlon = clon - wp.lon;
      const d2 = dlat * dlat + dlon * dlon + 1e-8;
      const w = 1 / d2;
      uSum += w * wp.u; vSum += w * wp.v; wt += w;
    }
    if (wt < 1e-12) { this._windVecCache = null; this._windVecField = windField; this._windVecZoom = z; return null; }

    const u = uSum / wt, v = vSum / wt;
    const wspd = Math.sqrt(u * u + v * v);
    if (wspd < wspdMin) { this._windVecCache = null; this._windVecField = windField; this._windVecZoom = z; return null; }

    // Transform u/v (m/s geographic) → screen-pixel unit vector
    const eps = 0.001;
    const dxPerDegLon = (latLonToWorld(clat, clon + eps, z).x - centerW.x) / eps;
    const dyPerDegLat = (latLonToWorld(clat + eps, clon, z).y - centerW.y) / eps;
    const cosLat = Math.cos(clat * Math.PI / 180);
    const pxU = u * dxPerDegLon / (111320 * cosLat);
    const pxV = v * dyPerDegLat / 111320;
    const pxSpd = Math.sqrt(pxU * pxU + pxV * pxV);
    if (pxSpd < 1e-9) { this._windVecCache = null; this._windVecField = windField; this._windVecZoom = z; return null; }

    const t = Math.max(0, Math.min(1, (wspd - wspdMin) / (wspdMax - wspdMin)));
    const stretch = 1.0 + (stretchMax - 1.0) * t * t * (3 - 2 * t);
    const result = { wx: pxU / pxSpd, wy: pxV / pxSpd, stretch, upwindShrink };
    this._windVecCache = result;
    this._windVecField = windField;
    this._windVecZoom = z;
    return result;
  }

  /**
   * Compute max AQI per pollutant from the kernel-regression field grid
   * (Nadaraya-Watson, same formulation as _computePaFieldSync) within the
   * viewport — one max per pollutant, independent of which pollutant is
   * currently being rendered.  This lets legend tab colors reflect each
   * tab's own pollutant field data.
   *
   * For the currently-rendered pollutant, reuses `this._paFieldMaxAqi`
   * already computed by the main pass.  For the other four pollutants, runs
   * the regression inner loop over viewport cells only (no rendering, no
   * blur) — ~0.5ms each on a 16px grid.
   */
  _computePerPollutantFieldMax(state, playbackTimeMs, centerW, z, cssW, cssH, bufW, bufH, paRefNowMs, virtualRefNowMs, cellSize, gw, gh, cutoffSq, effectiveCutoffSq, wind, twoSigmaSq) {
    const fixed = Array.isArray(state && state.fixed) ? state.fixed : [];
    const mobiles = Array.isArray(state && state.mobile) ? state.mobile : [];
    const result = {};
    const pollutants = ["pm25", "pm10", "o3", "no2", "co"];
    const renderedTab = this._paFieldPollutant || "pm25";

    // Viewport bounds in grid cells (match _computePaFieldSync's viewport logic)
    const vpMarginX = (bufW - cssW) / 2;
    const vpMarginY = (bufH - cssH) / 2;
    const vpGxMin = Math.max(0, Math.floor(vpMarginX / cellSize));
    const vpGyMin = Math.max(0, Math.floor(vpMarginY / cellSize));
    const vpGxMax = Math.min(gw, Math.ceil((vpMarginX + cssW) / cellSize));
    const vpGyMax = Math.min(gh, Math.ceil((vpMarginY + cssH) / cellSize));

    const isAniso = wind != null && wind.stretch > 1.001;
    const wwx = isAniso ? wind.wx : 0;
    const wwy = isAniso ? wind.wy : 0;
    const wStretch = isAniso ? wind.stretch : 1;
    const wUpwind = isAniso ? wind.upwindShrink : 1;

    for (const tab of pollutants) {
      // Rendered pollutant: reuse the main pass's _paFieldMaxAqi. It is the
      // max of the same kernel regression computed over the same viewport,
      // so re-running would be redundant.
      if (tab === renderedTab && this._paFieldMaxAqi != null && isFinite(this._paFieldMaxAqi)) {
        result[tab] = this._paFieldMaxAqi;
        continue;
      }

      // Collect sensors for this pollutant (same rules as the rendered field)
      const paField = _collectPaFieldSensors(
        fixed, playbackTimeMs, centerW, z, cssW, cssH, tab, bufW, bufH, paRefNowMs
      );
      const virtualField = _collectVirtualMobileSensors(
        mobiles, playbackTimeMs, !!this.playbackMode, centerW, z, cssW, cssH,
        virtualRefNowMs, tab, bufW, bufH
      );
      const allSensors = paField.sensors.concat(virtualField.sensors);
      if (allSensors.length === 0) { result[tab] = null; continue; }

      // Build stride-5 sensor array matching _computePaFieldSync's preparation
      const aqiKey = _LEGEND_TAB_AQI_KEY[tab] || "pm2.5";
      const s5 = new Float64Array(allSensors.length * 5);
      for (let i = 0; i < allSensors.length; i++) {
        const s = allSensors[i];
        const si5 = i * 5;
        s5[si5]     = s.sx;
        s5[si5 + 1] = s.sy;
        const aqi = valueToAqi(aqiKey, s.value);
        s5[si5 + 2] = (aqi != null && isFinite(aqi)) ? aqi : 0;
        s5[si5 + 3] = twoSigmaSq;
        s5[si5 + 4] = s.weightMultiplier;
      }

      // Kernel regression inner loop — viewport cells only, max AQI only.
      // Same math as _computePaFieldSync; skips rendering, blur, and composite.
      let fieldMaxAqi = -Infinity;
      for (let gy = vpGyMin; gy < vpGyMax; gy++) {
        const py = (gy + 0.5) * cellSize;
        for (let gx = vpGxMin; gx < vpGxMax; gx++) {
          const pxx = (gx + 0.5) * cellSize;
          let wSum = 0, vSum = 0;
          for (let i = 0; i < s5.length; i += 5) {
            const dx = pxx - s5[i];
            const dy = py  - s5[i + 1];
            const rawD2 = dx * dx + dy * dy;
            if (rawD2 > effectiveCutoffSq) continue;
            let d2;
            if (isAniso) {
              const along = dx * wwx + dy * wwy;
              if (rawD2 > cutoffSq && along <= 0) continue;
              const cross = dx * (-wwy) + dy * wwx;
              const sf = along > 0 ? wStretch : wStretch * wUpwind;
              const ea = along / sf;
              d2 = ea * ea + cross * cross;
            } else {
              d2 = rawD2;
            }
            const w = s5[i + 4] * Math.exp(-d2 / s5[i + 3]);
            wSum += w;
            vSum += w * s5[i + 2];
          }
          if (wSum >= 0.001) {
            const val = vSum / wSum;
            if (val > fieldMaxAqi) fieldMaxAqi = val;
          }
        }
      }
      result[tab] = (fieldMaxAqi > -Infinity) ? fieldMaxAqi : null;
    }
    this._paFieldMaxAqiPerPollutant = result;
  }

  /** Synchronous Nadaraya-Watson kernel regression with Gaussian weights.
   *  Optionally wind-anisotropic: kernels stretch along wind direction (teardrop shape).
   *  Blends in AQI space so high concentrations retain visual weight.
   *  sensors: stride-5 Float64Array [sx, sy, aqi, twoSigSq, weightMultiplier, ...]
   *  cutoffSq: max range² for early-out (expanded by stretch² when wind active).
   *  isoCutoffSq: original isotropic range² — tight early-out for upwind/crosswind sensors.
   *  wind: { wx, wy, stretch, upwindShrink } or null for isotropic. */
  _computePaFieldSync(sensors, gw, gh, cellSize, cutoffSq, isoCutoffSq, FIELD_ALPHA, cssW, cssH, dpr, wind, vpCssW, vpCssH) {
    // ── Reuse tiny canvas + ImageData if grid size unchanged ──
    if (!this._paGrid || this._paGrid.gw !== gw || this._paGrid.gh !== gh) {
      const tc = document.createElement("canvas");
      tc.width = gw; tc.height = gh;
      const tctx = tc.getContext("2d");
      this._paGrid = { tc, tctx, imgData: tctx.createImageData(gw, gh), gw, gh };
    }
    const { tc, tctx, imgData } = this._paGrid;
    const px = imgData.data;

    // Hoist wind parameters — uniform across viewport, no per-cell lookup
    const isAniso = wind != null && wind.stretch > 1.001;
    const wwx = isAniso ? wind.wx : 0;
    const wwy = isAniso ? wind.wy : 0;
    const wStretch = isAniso ? wind.stretch : 1;
    const wUpwind  = isAniso ? wind.upwindShrink : 1;

    // ── Nadaraya-Watson kernel regression with optional wind-anisotropic Gaussian weights ──
    // Track max interpolated AQI within the actual viewport (not overfetch margin)
    let fieldMaxAqi = -Infinity;
    const vpW = vpCssW || cssW;
    const vpH = vpCssH || cssH;
    const vpMarginX = (cssW - vpW) / 2;
    const vpMarginY = (cssH - vpH) / 2;
    // Sample only the viewport region (exclude overfetch margins)
    const vpGxMin = Math.floor(vpMarginX / cellSize);
    const vpGyMin = Math.floor(vpMarginY / cellSize);
    const vpGxMax = Math.min(gw, Math.ceil((vpMarginX + vpW) / cellSize));
    const vpGyMax = Math.min(gh, Math.ceil((vpMarginY + vpH) / cellSize));

    for (let gy = 0; gy < gh; gy++) {
      const py = (gy + 0.5) * cellSize;
      const inVpY = gy >= vpGyMin && gy <= vpGyMax;
      for (let gx = 0; gx < gw; gx++) {
        const pxx = (gx + 0.5) * cellSize;

        let wSum = 0, vSum = 0;
        for (let i = 0; i < sensors.length; i += 5) {
          const dx = pxx - sensors[i];
          const dy = py  - sensors[i + 1];
          const rawD2 = dx * dx + dy * dy;
          if (rawD2 > cutoffSq) {
            // Beyond expanded cutoff — always skip
            continue;
          }

          let d2;
          if (isAniso) {
            const along = dx * wwx + dy * wwy;
            if (rawD2 > isoCutoffSq && along <= 0) continue; // upwind/crosswind beyond iso range — skip
            // Decompose into wind-parallel and perpendicular components.
            // Downwind (along > 0): full stretch. Upwind: partial (teardrop kernel).
            const cross = dx * (-wwy) + dy * wwx;
            const sf = along > 0 ? wStretch : wStretch * wUpwind;
            const ea = along / sf;
            d2 = ea * ea + cross * cross;
          } else {
            d2 = rawD2;
          }

          const w = sensors[i + 4] * Math.exp(-d2 / sensors[i + 3]);
          wSum += w;
          vSum += w * sensors[i + 2];
        }

        const off = (gy * gw + gx) * 4;
        if (wSum < 0.001) {
          px[off] = 0; px[off+1] = 0; px[off+2] = 0; px[off+3] = 0;
        } else {
          const fade = Math.min(1, wSum * 2);
          const alpha = Math.round(FIELD_ALPHA * fade);
          const val = vSum / wSum;
          if (inVpY && gx >= vpGxMin && gx < vpGxMax && val > fieldMaxAqi) {
            fieldMaxAqi = val;
          }
          const rgb = _aqiToRgb(val);
          px[off]   = rgb[0];
          px[off+1] = rgb[1];
          px[off+2] = rgb[2];
          px[off+3] = alpha;
        }
      }
    }
    this._paFieldMaxAqi = fieldMaxAqi > -Infinity ? fieldMaxAqi : null;

    // ── Cauchy blur (1/(1+d²) kernel) to soften band-edge staircase artifacts ──
    const _fd = window._fieldDebug;
    const BLUR_R = _fd ? _fd.blur : 2;
    // Reuse blur buffer across frames when grid dimensions match
    const bufLen = px.length;
    if (!this._paGrid.blurBuf || this._paGrid.blurBuf.length !== bufLen) {
      this._paGrid.blurBuf = new Uint8ClampedArray(bufLen);
    }
    const tmp = this._paGrid.blurBuf;
    tmp.fill(0);
    // Horizontal pass
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        let rr = 0, gg = 0, bb = 0, aa = 0, ww = 0;
        for (let dx = -BLUR_R; dx <= BLUR_R; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= gw) continue;
          const off = (y * gw + nx) * 4;
          if (px[off + 3] === 0) continue;
          const g = 1.0 / (1 + dx * dx);
          rr += px[off] * g; gg += px[off+1] * g; bb += px[off+2] * g; aa += px[off+3] * g;
          ww += g;
        }
        const off = (y * gw + x) * 4;
        if (ww > 0) { tmp[off] = rr/ww; tmp[off+1] = gg/ww; tmp[off+2] = bb/ww; tmp[off+3] = aa/ww; }
      }
    }
    // Vertical pass
    for (let x = 0; x < gw; x++) {
      for (let y = 0; y < gh; y++) {
        let rr = 0, gg = 0, bb = 0, aa = 0, ww = 0;
        for (let dy = -BLUR_R; dy <= BLUR_R; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= gh) continue;
          const off = (ny * gw + x) * 4;
          if (tmp[off + 3] === 0) continue;
          const g = 1.0 / (1 + dy * dy);
          rr += tmp[off] * g; gg += tmp[off+1] * g; bb += tmp[off+2] * g; aa += tmp[off+3] * g;
          ww += g;
        }
        const off = (y * gw + x) * 4;
        if (ww > 0) { px[off] = rr/ww; px[off+1] = gg/ww; px[off+2] = bb/ww; px[off+3] = aa/ww; }
      }
    }

    tctx.putImageData(imgData, 0, 0);
    this._upscalePaField(tc, cssW, cssH, dpr);
  }

  /** Upscale the coarse interpolation grid to viewport size with bilinear smoothing. */
  _upscalePaField(tc, cssW, cssH, dpr) {
    const _fd = window._fieldDebug;
    const mode = (_fd && _fd.upscaleQuality) || "high";

    if (mode === "2pass") {
      // Store grid-x4 intermediate as _paFieldCanvas (~272x172 instead of ~4320x2700).
      // The composite path does the final upscale to viewport via pfctx.drawImage,
      // so the fast-path blit during zoom operates on a tiny texture.
      const iw = tc.width * 4, ih = tc.height * 4;
      if (!this._paFieldCanvas || this._paFieldCanvas.width !== iw || this._paFieldCanvas.height !== ih) {
        this._paFieldCanvas = document.createElement("canvas");
        this._paFieldCanvas.width = iw;
        this._paFieldCanvas.height = ih;
        this._paFieldCtx = this._paFieldCanvas.getContext("2d");
      }
      const ctx = this._paFieldCtx;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "medium";
      ctx.clearRect(0, 0, iw, ih);
      ctx.drawImage(tc, 0, 0, iw, ih);
      return;
    }

    // Single-pass modes: full device-pixel resolution
    if (!this._paFieldCanvas) {
      this._paFieldCanvas = document.createElement("canvas");
      this._paFieldCtx = this._paFieldCanvas.getContext("2d");
    }
    const pw = Math.floor(cssW * dpr), ph = Math.floor(cssH * dpr);
    if (this._paFieldCanvas.width !== pw || this._paFieldCanvas.height !== ph) {
      this._paFieldCanvas.width = pw;
      this._paFieldCanvas.height = ph;
    }
    const ctx = this._paFieldCtx;
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = mode;
    ctx.drawImage(tc, 0, 0, cssW, cssH);
  }

  /** Handle worker result — cache pre-warmed pixel data for future scrub hits. */
  _onPaWorkerResult(data) {
    const { px, gw, gh, jobId } = data;
    if (jobId !== this._paWorkerJobId) return;
    this._paWorkerPending = false;

    const fp = this._paWorkerFingerprint;
    if (!fp) return;

    // Store the raw pixel data keyed by fingerprint only (view-independent).
    // _ensurePaField will project + upscale synchronously when the fingerprint matches.
    this._paFieldPrewarmed.set(fp, { px: new Uint8ClampedArray(px), gw, gh });
    // Evict oldest if over limit
    if (this._paFieldPrewarmed.size > this._paFieldCacheMax) {
      const first = this._paFieldPrewarmed.keys().next().value;
      this._paFieldPrewarmed.delete(first);
    }
    // Allow _preWarmPaFields to re-scan for more transitions on the next frame.
    this._preWarmScanValidUntilMs = null;
  }

  /**
   * Pre-warm scalar fields for upcoming color transitions.
   * Scans PurpleAir sensor history to find the next times ANY sensor crosses
   * a color category boundary, then dispatches worker jobs to pre-compute
   * those fields. Called periodically from the playback render loop.
   */
  _preWarmPaFields(state, playbackTimeMs) {
    // Initialize worker on first use
    if (!this._paWorker) {
      try {
        this._paWorker = new Worker("pa_field_worker.js?v=20260322b");
        this._paWorker.onmessage = (e) => this._onPaWorkerResult(e.data);
      } catch (_) {
        this._paWorker = false;
      }
    }
    if (!this._paWorker || this._paWorkerPending) return;
    const fixed = Array.isArray(state && state.fixed) ? state.fixed : [];
    const cssW = this._cssW || 1;
    const cssH = this._cssH || 1;
    if (cssW < 2 || cssH < 2) return;
    const z = Number(this.zoom);
    const clat = Number(this.center?.lat);
    const clon = Number(this.center?.lon);

    // Find sensor color transition times ahead of the playhead (up to 30 min).
    const lookAheadMs = 30 * 60 * 1000;
    const maxTime = playbackTimeMs + lookAheadMs;

    // Skip re-scanning if we already scanned this time window and found nothing
    // new to pre-warm. Only re-scan when playback advances past the horizon or
    // new data arrives (different fixed array).
    if (this._preWarmScanValidUntilMs != null
        && this._preWarmScanFixed === fixed
        && playbackTimeMs < this._preWarmScanValidUntilMs
        && playbackTimeMs >= (this._preWarmScanFromMs || -Infinity)) {
      return;
    }

    // Collect unique transition fingerprints and their sensor arrays
    // Walk forward in time through each sensor's history and find points
    // where the color category changes.
    const transitionTimes = new Set();
    for (const f of fixed) {
      const readings = f && f.readings;
      if (!readings) continue;
      for (const key of Object.keys(readings)) {
        const r = readings[key];
        if (!r || !r._parsedTimeline) continue;
        const { timesMs, valuesF } = r._parsedTimeline;
        if (!timesMs || timesMs.length < 2) continue;
        // Find the current index
        let idx = 0;
        for (let i = 0; i < timesMs.length; i++) {
          if (timesMs[i] <= playbackTimeMs) idx = i; else break;
        }
        const curCat = _pm25ColorCat(valuesF[idx]);
        // Walk forward to find next color change
        for (let i = idx + 1; i < timesMs.length; i++) {
          if (timesMs[i] > maxTime) break;
          if (_pm25ColorCat(valuesF[i]) !== curCat) {
            transitionTimes.add(timesMs[i]);
            break;
          }
        }
      }
    }

    // Pick the nearest transition time not already cached
    const sorted = Array.from(transitionTimes).sort((a, b) => a - b);
    for (const tMs of sorted) {
      // Build sensor array and fingerprint at this time
      const centerW = latLonToWorld(clat, clon, z);
      const dpr = this._dpr || (window.devicePixelRatio || 1);
      const bufW = Math.min(Math.ceil(cssW * _OVERFETCH), Math.floor(_OVERFETCH_MAX_DEVICE_PX / dpr));
      const bufH = Math.min(Math.ceil(cssH * _OVERFETCH), Math.floor(_OVERFETCH_MAX_DEVICE_PX / dpr));
      const paField = _collectPaFieldSensors(fixed, tMs, centerW, z, cssW, cssH, undefined, bufW, bufH, tMs);
      const paSensors = paField.sensors;
      const fp = paField.fingerprint;
      if (paSensors.length === 0) continue;
      if (this._paFieldPrewarmed.has(fp)) continue;

      // Dispatch this one to the worker
      const cellSize = Math.max(16, Math.ceil(Math.sqrt(cssW * cssH / 1400)));
      const gw = Math.ceil(bufW / cellSize);
      const gh = Math.ceil(bufH / cellSize);
      const refW = latLonToWorld(clat, clon + 0.15, z);
      const cutoffPx = Math.abs(refW.x - centerW.x);
      const cutoffSq = cutoffPx * cutoffPx;
      const sigma = cutoffPx / 12;
      const twoSigmaSq = 2 * sigma * sigma;
      const FIELD_ALPHA = 46;

      // Build stride-4 array: [sx, sy, aqi, weightMultiplier, ...]
      const nPw = paSensors.length;
      const s4pw = new Float64Array(nPw * 4);
      for (let i = 0; i < nPw; i++) {
        const sensor = paSensors[i];
        const si = i * 4;
        s4pw[si] = sensor.sx;
        s4pw[si + 1] = sensor.sy;
        s4pw[si + 2] = _pm25ToAqi(Math.min(sensor.value, 75));
        s4pw[si + 3] = sensor.weightMultiplier;
      }

      const jobId = ++this._paWorkerJobId;
      this._paWorkerPending = true;
      this._paWorkerFingerprint = fp;
      this._paWorker.postMessage({
        sensors: s4pw,
        gw, gh, cellSize, cutoffSq, twoSigmaSq, FIELD_ALPHA, jobId
      });
      // Dispatched a job — don't cache scan result yet (more transitions may
      // become uncached after this job completes).
      return; // one at a time
    }

    // All upcoming transitions are already pre-warmed. Cache the scan window
    // so we don't re-scan every frame.
    this._preWarmScanValidUntilMs = maxTime;
    this._preWarmScanFromMs = playbackTimeMs;
    this._preWarmScanFixed = fixed;
  }

  _overlayStaticKeyForState(state) {
    const w = this._cssW || 1;
    const h = this._cssH || 1;
    const z = Number(this.zoom);
    const clat = Number(this.center?.lat);
    const clon = Number(this.center?.lon);
    const sel = this.selectedId || "";
    const fixed = 1;
    const revKey = this._tracePointsKeyForState(state);
    // Include persisted trail rev so cached overlay updates even when the server drops history.
    const persistKey = `persist:${this._persistedTrailRev}`;
    const fl = this.showFixedLabels ? 1 : 0;
    // Include playback time (rounded to 1s) so fixed sensor dots update when scrubbing
    const pbT = this.getPlaybackTimeMs();
    const pbKey = (pbT != null && isFinite(pbT)) ? Math.round(pbT / 1000) : "live";
    return `${revKey}|${persistKey}|w:${w}|h:${h}|z:${z.toFixed(4)}|c:${clat.toFixed(6)},${clon.toFixed(6)}|sel:${sel}|fixed:${fixed}|fl:${fl}|pb:${pbKey}`;
  }

  /**
   * Collect trail data for rendering. Shared by both _ensureOverlayStatic and drawOverlay.
   * Returns { pts, cols, times, trail, isGhost } or null if trail is invalid.
   */
  _collectTrailData(m, toScreen) {
    const id = m && m.id != null ? String(m.id) : "";
    
// Get reveal time (for clipping trail at vehicle position)
    // Use playback time directly - vehicle physics are synced to this
    const pbTimeMs = this.getPlaybackTimeMs();
    const revealTimeMs = pbTimeMs;
    
    // Get trail source
    // In playback mode, always prefer server trail for fresh readings/colors.
    // Persisted trail is only used in non-playback live mode for continuity.
    const serverTrail = Array.isArray(m?.trail) ? m.trail : [];
    const hasServerTrail = serverTrail.length >= 2;
    const useServerTrail = this.playbackMode || hasServerTrail;
    const persistedTrail = (id && !this._historicalMode && !this.playbackMode) ? (this._persistedTrailById.get(id)?.trail || []) : [];
    const trail = useServerTrail ? (hasServerTrail ? serverTrail : persistedTrail) : (persistedTrail.length >= 2 ? persistedTrail : serverTrail);
    if (!Array.isArray(trail) || trail.length < 2) return null;
    
    const isGhost = !!m.ghosted;
    const pts = [];
    const cols = [];
    const times = [];
    
    const getSp = toScreen || this.worldToScreen.bind(this);
    const ws = worldSizeForZoom(this.zoom);
    
    const shouldClipTrail = revealTimeMs != null && isFinite(revealTimeMs);
    let prevTMs = null;
    let prevU = null, prevV = null;

    // Skip trail points before the visible window.  Renderers fade out points
    // older than 45 minutes — no need to iterate hours of invisible data.
    // Uses cached _tMs (available after first frame); falls back to i=0 otherwise.
    let startIdx = 0;
    if (shouldClipTrail && trail.length > 50) {
      const windowStartMs = revealTimeMs - 50 * 60 * 1000; // 45-min fade + 5-min margin
      const first = trail[0];
      if (first && first._tMs !== undefined) {
        let lo = 0, hi = trail.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          const t = trail[mid]._tMs;
          if (t != null && t < windowStartMs) lo = mid + 1; else hi = mid;
        }
        startIdx = Math.max(0, lo - 1); // -1 for segment continuity
      }
    }

    for (let i = startIdx; i < trail.length; i++) {
      const p = trail[i];

      // Cache properties in consistent order: _tMs → _u/_v → _cachedColor
      // This MUST match the order in _collectVirtualMobileSensors to avoid
      // V8 hidden class divergence (different insertion orders → different
      // hidden classes → megamorphic inline caches → progressive slowdown).

      // 1. Timestamp first (matches _collectVirtualMobileSensors)
      let tMs = p._tMs;
      if (tMs === undefined) {
        tMs = (p && typeof p.t === "string") ? parseUtcMs(p.t) : null;
        try { p._tMs = tMs; } catch {}
      }

      // 2. World coords second (matches _collectVirtualMobileSensors)
      let u = p._u, v = p._v;
      if (u === undefined) {
        const lat = Number(p.lat), lon = Number(p.lon);
        if (p.lat == null || p.lon == null || !isFinite(lat) || !isFinite(lon)) {
          pts.push(null);
          cols.push(null);
          times.push(null);
          prevTMs = null;
          prevU = null;
          prevV = null;
          continue;
        }
        const norm = latLonToNorm(lat, lon);
        u = norm.u; v = norm.v;
        p._u = u; p._v = v;
      }

      // 3. Color last — pollutant-aware: use selected pollutant when explicitly chosen
      const pollTab = this._paFieldPollutant;
      const usePollutantColor = pollTab != null;
      let base;
      if (usePollutantColor) {
        // Per-pollutant color cache: _cachedColorByTab = { pm10: "#hex", o3: "#hex", ... }
        const cbt = p._cachedColorByTab;
        base = cbt && cbt[pollTab];
        if (base === undefined) {
          const rKeys = _LEGEND_TAB_READING_KEYS[pollTab];
          let found = null;
          if (rKeys && p.readings) {
            for (const rk of rKeys) {
              const r = p.readings[rk];
              if (r && r.value != null) { found = r; break; }
            }
          }
          if (found) {
            if (pollTab !== "pm25") {
              // Non-PM2.5: use the same AQI continuous ramp as the field so trail dots
              // match the heatmap color (server discrete palette uses pollutant-specific
              // sub-band greens that diverge from the AQI ramp in the Good range).
              const _tAqiKey = _LEGEND_TAB_AQI_KEY[pollTab] || "pm2.5";
              const _tAqi = valueToAqi(_tAqiKey, found.value);
              if (_tAqi != null && isFinite(_tAqi)) {
                const [_tr, _tg, _tb] = _aqiToRgb(_tAqi);
                base = '#' + ((1 << 24) + (_tr << 16) + (_tg << 8) + _tb).toString(16).slice(1);
              } else {
                base = safeHex(found.ci != null ? found.ci : found.color);
              }
            } else {
              base = safeHex(found.ci != null ? found.ci : found.color);
            }
          } else {
            base = "#333333";
          }
          try {
            if (!p._cachedColorByTab) p._cachedColorByTab = {};
            p._cachedColorByTab[pollTab] = base;
          } catch {}
        }
      } else {
        base = p._cachedColor;
        if (base === undefined) {
          const pr = primaryReadingFromPoint(p);
          base = safeHex(pr?.ci != null ? pr.ci : pr?.color);
          try { p._cachedColor = base; } catch {}
        }
      }
      
      // Calculate screen position
      const sp = getSp(u * ws, v * ws);

      // Clip trail at vehicle's time position
      if (shouldClipTrail && tMs != null && isFinite(tMs) && tMs > revealTimeMs) {
        if (prevTMs != null && isFinite(prevTMs) && prevTMs <= revealTimeMs && prevU != null && prevV != null) {
          const dt = tMs - prevTMs;
          const t = dt > 0 ? (revealTimeMs - prevTMs) / dt : 0;
          const interpU = prevU + t * (u - prevU);
          const interpV = prevV + t * (v - prevV);
          pts.push(getSp(interpU * ws, interpV * ws));
          // Use destination point's color for the clipped segment
          cols.push(base);
          times.push(revealTimeMs);
        }
        break; // Stop collecting
      }
      
      pts.push(sp);
      cols.push(base);
      times.push(tMs);
      
      prevTMs = tMs;
      prevU = u;
      prevV = v;
    }
    
    if (pts.length < 2) return null;
    return { pts, cols, times, trail, isGhost };
  }

  _ensureOverlayStatic(state) {
    const dpr = this._dpr || (window.devicePixelRatio || 1);
    const cssW = this._cssW || 1;
    const cssH = this._cssH || 1;
    const key = this._overlayStaticKeyForState(state);
    if (!this._overlayStaticDirty && this._overlayStaticCanvas && this._overlayStaticKey === key) return;
    this._overlayStaticDirty = false;
    this._overlayStaticKey = key;

    if (!this._overlayStaticCanvas) this._overlayStaticCanvas = document.createElement("canvas");
    this._overlayStaticCanvas.width = Math.floor(cssW * dpr);
    this._overlayStaticCanvas.height = Math.floor(cssH * dpr);
    const ctx = this._overlayStaticCanvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    if (!state) return;
    const mobiles = Array.isArray(state.mobile) ? state.mobile : [];
    const fixed = Array.isArray(state.fixed) ? state.fixed : [];

    // Precompute center world once; avoid repeated center projection.
    const centerW = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
    const worldToScreenFast = (wx, wy) => ({ x: wx - centerW.x + cssW / 2, y: wy - centerW.y + cssH / 2 });

    // Fixed markers - render PurpleAir first (so they don't draw over others), then other markers
    if (this.showFixed) {
      // Declutter: nudge co-located non-PurpleAir fixed markers apart.
      // Offsets are in lat/lon so the bearing is geographic and zoom-independent.
      this._fixedGeoOffsets = new Map();
      {
        const nudgeDeg = 0.0003; // ~33m — enough to separate at high zoom, subtle at low zoom
        const colocThresh = 0.002; // ~200m
        const ents = [];
        for (const f of fixed) {
          if (f.purpleair) continue;
          const lat = Number(f.lat), lon = Number(f.lon);
          if (!isFinite(lat) || !isFinite(lon)) continue;
          if (!f._key) f._key = keyFor("fixed", f.id);
          ents.push({ f, lat, lon, dlat: 0, dlon: 0 });
        }
        for (let i = 0; i < ents.length; i++) {
          for (let j = i + 1; j < ents.length; j++) {
            const a = ents[i], b = ents[j];
            if (Math.abs(a.lat - b.lat) + Math.abs(a.lon - b.lon) < colocThresh) {
              // Bearing from a→b in geographic coords; default NE when coincident
              const dl = b.lat - a.lat, dn = b.lon - a.lon;
              const ang = (Math.abs(dl) + Math.abs(dn) > 1e-7)
                ? Math.atan2(dn, dl)
                : Math.PI / 4; // 45° NE default
              a.dlat -= Math.cos(ang) * nudgeDeg;
              a.dlon -= Math.sin(ang) * nudgeDeg;
              b.dlat += Math.cos(ang) * nudgeDeg;
              b.dlon += Math.sin(ang) * nudgeDeg;
            }
          }
        }
        for (const e of ents) {
          if (e.dlat || e.dlon) this._fixedGeoOffsets.set(e.f._key, { dlat: e.dlat, dlon: e.dlon });
        }
      }

      // Helper to render a single fixed marker
      const renderFixedMarker = (f) => {
        let lat = Number(f.lat), lon = Number(f.lon);
        if (!isFinite(lat) || !isFinite(lon)) return;
        if (!f._key) f._key = keyFor("fixed", f.id);
        const geo = this._fixedGeoOffsets && this._fixedGeoOffsets.get(f._key);
        if (geo) { lat += geo.dlat; lon += geo.dlon; }
        const wpt = latLonToWorld(lat, lon, this.zoom);
        const sp = worldToScreenFast(wpt.x, wpt.y);
        if (sp.x < -50 || sp.y < -50 || sp.x > cssW + 50 || sp.y > cssH + 50) return;

        if (!f._key) f._key = keyFor("fixed", f.id);
        const keyF = f._key;
        const isSel = (this.selectedId === keyF);
        const emoji = f.purpleair ? "" : (f.emoji || "📍");
        const color = safeHex(f.ci);
        const pr = primaryReadingForFixedAtTime(f, this.getPlaybackTimeMs());
        const isOutlier = f.outlier || (pr && pr.outlier);
        const label = ((f.name && f.name.length && String(f.name) !== String(f.id)) ? f.name : f.id) + (isOutlier ? " (Outlier)" : "");

        ctx.save();
        const isPurpleAir = !!f.purpleair;
        if (isPurpleAir) {
          // Fade PurpleAir dots when a non-PM2.5 pollutant is active (PA sensors report PM2.5)
          const paFadedForPollutant = !isSel && this._paFieldPollutant != null && this._paFieldPollutant !== "pm25";
          // Outlier PurpleAir sensors still render (grey dot) so user can investigate
          // ── Per-sensor staleness fade matching trail duration ──
          let staleAlpha = 1.0;
          const _refMs = this.getPlaybackTimeMs() || this._dataNowMs();
          const _sensorMs = (pr && pr.timeMs) || (f.last_seen ? f.last_seen * 1000 : null);
          if (!isSel && _sensorMs) {
            const PA_FADE_MS = 45 * 60 * 1000;
            const PA_FADE_TAIL = 0.20;
            const ageMs = _refMs - _sensorMs;
            if (ageMs >= PA_FADE_MS) { ctx.restore(); return; }
            const fadeStart = PA_FADE_MS * (1.0 - PA_FADE_TAIL);
            if (ageMs > fadeStart) {
              const u = (ageMs - fadeStart) / (PA_FADE_MS - fadeStart);
              staleAlpha = (1 - u) * (1 - u);
            }
          }
          if (paFadedForPollutant) staleAlpha *= 0.3;
          const dotR = isSel ? 8 : 6;
          const dotColor = paFadedForPollutant ? dimHex(safeHex((pr && pr.color) || color), 0.65) : safeHex((pr && pr.color) || color);
          if (isSel) {
            ctx.beginPath();
            ctx.fillStyle = "rgba(56, 140, 220, 0.38)";
            ctx.arc(sp.x, sp.y, dotR + 4, 0, Math.PI*2);
            ctx.fill();
          }
          ctx.beginPath();
          // When not selected: make PurpleAir subtle but still visible
          if (!isSel) {
            const darkened = darkenHex(dotColor, 0.85);
            ctx.fillStyle = hexToRgba(darkened, 0.45 * staleAlpha);
          } else {
            ctx.fillStyle = dotColor;
          }
          ctx.arc(sp.x, sp.y, dotR, 0, Math.PI*2);
          ctx.fill();
          ctx.strokeStyle = isSel ? "#5bb8f5" : darkenHex(dotColor, 0.7);
          ctx.globalAlpha = (isSel ? 1 : 0.5) * staleAlpha;
          ctx.lineWidth = isSel ? 1.8 : 1.2;
          ctx.stroke();
        } else {
          const _fHalo2   = _isLite ? 10 : 15;
          const _fCircle2 = _isLite ?  8 : 12;
          const _fFont2   = _isLite ? 10 : 15;
          if (isSel) {
            ctx.beginPath();
            ctx.fillStyle = "rgba(56, 140, 220, 0.38)";
            ctx.arc(sp.x, sp.y, _fHalo2, 0, Math.PI*2);
            ctx.fill();
          }
          ctx.beginPath();
          ctx.fillStyle = "rgba(16, 20, 28, 0.68)";
          ctx.arc(sp.x, sp.y, _fCircle2, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = isSel ? "#5bb8f5" : safeHex((pr && pr.color) || color);
          ctx.lineWidth = isSel ? 2.4 : 2.0;
          ctx.stroke();

          ctx.font = `${_fFont2}px Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(emoji, sp.x, sp.y);
        }

        const isHov = (this._hoveredId === keyF);
        if ((this.showFixedLabels && !isPurpleAir) || isSel || isHov || String(f.id) === "Home") {
          ctx.font = "600 12px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
          const line1 = label;
          const line2Key = pr.key ? String(pr.key) : "";
          const line2Val = formatTagValue(pr.value);
          const m1 = ctx.measureText(line1);
          const m2a = ctx.measureText(line2Key ? `${line2Key} ` : "");
          const m2b = ctx.measureText(line2Val);
          const m1w = m1.width > 0 ? m1.width : (line1.length * 7);
          const m2aw = m2a.width > 0 ? m2a.width : ((line2Key ? line2Key.length + 1 : 0) * 7);
          const m2bw = m2b.width > 0 ? m2b.width : (line2Val.length * 7);
          const padX = 8;
          const bw = Math.max(m1w, (m2aw + m2bw)) + padX * 2;
          const bh = (line2Key || line2Val) ? 30 : 18;
          const bx = sp.x - bw / 2;
          const by = sp.y + 18;
          const _markerColor = safeHex((pr && pr.color) || color);
          const markerColor = isOutlier ? outlierHex(_markerColor) : _markerColor;
          if (isOutlier) ctx.globalAlpha = 0.5;
          ctx.fillStyle = "rgba(16, 20, 28, 0.82)";
          ctx.strokeStyle = markerColor;
          ctx.lineWidth = 1.8;
          roundRect(ctx, bx, by, bw, bh, 9);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = "#e8eef7";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          const padY = 4;
          const lineH = (bh - padY * 2) / ((line2Key || line2Val) ? 2 : 1);
          const y1 = by + padY + lineH * 0.5;
          const y2 = by + padY + lineH * 1.5;
          ctx.fillText(line1, sp.x, y1);
          if (line2Key || line2Val) {
            const x0 = sp.x - (m2aw + m2bw) / 2;
            ctx.fillStyle = "rgba(232,238,247,0.70)";
            ctx.fillText(line2Key ? `${line2Key} ` : "", x0 + m2aw / 2, y2);
            ctx.fillStyle = isOutlier ? markerColor : (pr.color || "#ffffff");
            ctx.fillText(line2Val, x0 + m2aw + m2bw / 2, y2);
          }
        }
        ctx.restore();
      };

      // First pass: render PurpleAir markers (drawn first, so they appear behind)
      // (PA scalar field is rendered below, on PA field canvas — see _compositePaFieldOnTiles)
      for (const f of fixed) {
        if (f.purpleair) renderFixedMarker(f);
      }

      // Second pass: render non-PurpleAir markers
      for (const f of fixed) {
        if (!f.purpleair) renderFixedMarker(f);
      }
    } // end if showFixed

    // Trails:
    const sel = parseKey(this.selectedId);
    const hasSelectedMobile = (sel && sel.type === "mobile" && sel.id);
    const selectedId = hasSelectedMobile ? sel.id : null;

    const drawTrailFor = (m, alphaMul, toScreen) => {
      const id = m && m.id != null ? String(m.id) : "";
      const isLive = !this.playbackMode;
      
      // Use shared trail collection logic
      const data = this._collectTrailData(m, toScreen);
      if (!data) return false;
      const { pts, cols, times, trail, isGhost } = data;
      
      const isSel2 = (selectedId && m.id === selectedId);

      // Tail fade should be based on the *visible* (drawn) trail only.
      // Otherwise, long idle/hidden periods (which are rendered transparent) stretch the time window
      // and the "new tail" appears to not fade.
      let visMinT = Infinity, visMaxT = -Infinity;
      for (let i = 1; i < pts.length; i++) {
        if (!pts[i - 1] || !pts[i]) continue;
        const p1 = trail[i];
        // IMPORTANT: "moving" must be explicit. Missing/undefined m is treated as idle.
        const isMoving = !!(p1 && (p1.m === 1 || p1.m === "1" || p1.m === true));
        const willDraw = this._pbDebugPath || isMoving;
        if (!willDraw) continue;
        const t1 = times[i];
        if (t1 != null && isFinite(t1)) {
          if (t1 < visMinT) visMinT = t1;
          if (t1 > visMaxT) visMaxT = t1;
        }
      }
      // Fallback: if we can't compute visible bounds, use the whole set.
      if (!(visMaxT > visMinT)) {
        for (const t of times) {
          if (t != null && isFinite(t)) {
            if (t < visMinT) visMinT = t;
            if (t > visMaxT) visMaxT = t;
          }
        }
      }
      const totalDur = (visMaxT > visMinT) ? (visMaxT - visMinT) : 0;

      const alpha = (isSel2 ? 1.0 : 0.85) * alphaMul;
      const lw = isSel2 ? 4.2 : 3.4;
      const dash = [2, 10];

      // Tail fade tuning:
      // Fade is strictly time-based decay:
      // - total decay window: 45 minutes
      // - fade begins only in the last 20% of that window (tail)
      const FADE_TIME_MS = 20 * 60 * 1000; // 20 minutes -> fully expired
      const FADE_TAIL_FRAC = 0.20; // fade over the last 20% of FADE_TIME_MS
      const FADE_START_FRAC = 1.0 - FADE_TAIL_FRAC; // e.g. 0.80
      // Reference time: use playback time, trail's max time, or playback bounds (NOT wall clock)
      const livePlaybackTimeMs = this.getPlaybackTimeMs();
      const hasPlaybackTime = livePlaybackTimeMs != null && isFinite(livePlaybackTimeMs);
      const pbBounds = this.getPlaybackBounds();
      const boundsMaxMs = (pbBounds.maxMs != null && isFinite(pbBounds.maxMs)) ? pbBounds.maxMs : null;
      const refNowMs = hasPlaybackTime ? Number(livePlaybackTimeMs) 
        : (isFinite(visMaxT) ? visMaxT 
        : (boundsMaxMs != null ? boundsMaxMs 
        : this._dataNowMs()));

      // Batched trail rendering: collect segments with same color/alpha,
      // stroke in a single beginPath() to avoid per-segment save/restore.
      ctx.lineWidth = lw;
      ctx.setLineDash(dash);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      let sBatchColor = null;
      let sBatchAlpha = null;
      let sBatchPts = [];

      const sFlushBatch = () => {
        if (sBatchPts.length < 2) { sBatchPts = []; return; }
        ctx.globalAlpha = sBatchAlpha;
        ctx.strokeStyle = sBatchColor;
        ctx.beginPath();
        for (let k = 0; k < sBatchPts.length; k += 2) {
          ctx.moveTo(sBatchPts[k].x, sBatchPts[k].y);
          ctx.lineTo(sBatchPts[k+1].x, sBatchPts[k+1].y);
        }
        ctx.stroke();
        sBatchPts = [];
      };

      const fadeStartAgeMs = FADE_TIME_MS * FADE_START_FRAC;

      for (let i = 1; i < pts.length; i++) {
        if (!pts[i - 1] || !pts[i]) { sFlushBatch(); continue; }

        const trailPt = trail[i];
        const isMoving = !!(trailPt && (trailPt.m === 1 || trailPt.m === "1" || trailPt.m === true));

        const segColor0 = cols[i] || cols[i - 1] || "#ffffff";
        let segColor = segColor0;
        let alphaMul2 = 1.0;

        if (!isMoving) {
          if (this._pbDebugPath) {
            segColor = dimHex(segColor0, 0.25);
          } else {
            segColor = desatHex(dimHex(segColor0, 0.35), 0.30);
            alphaMul2 = 0.5;
          }
        } else if (isGhost && isLive) {
          segColor = desatHex(dimHex(segColor0, 0.65), 0.25);
          alphaMul2 = 0.5;
        }

        const t1 = times[i];
        if (!(t1 != null && isFinite(t1) && isFinite(refNowMs))) { sFlushBatch(); continue; }

        const ageMs = Math.max(0, Number(refNowMs) - Number(t1));
        if (ageMs >= FADE_TIME_MS) { sFlushBatch(); continue; }

        let tailAlpha = 1.0;
        if (ageMs > fadeStartAgeMs) {
          const u = (ageMs - fadeStartAgeMs) / (FADE_TIME_MS - fadeStartAgeMs);
          tailAlpha = (1 - u) * (1 - u);
          if (tailAlpha <= 0.01) { sFlushBatch(); continue; }
        }

        const finalAlpha = alpha * tailAlpha * alphaMul2;
        if (segColor !== sBatchColor || Math.abs(finalAlpha - (sBatchAlpha || 0)) > 0.01) {
          sFlushBatch();
          sBatchColor = segColor;
          sBatchAlpha = finalAlpha;
        }
        sBatchPts.push(pts[i - 1]);
        sBatchPts.push(pts[i]);
      }
      sFlushBatch();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1.0;

      return true;
    };

    // Note: we intentionally do not render trails for mobiles missing from the payload.
    // When a mobile disappears, we prune its cached state so it can't return on a stale route.

    const mobileHasServerTrail = (m) => {
      const t = Array.isArray(m?.trail) ? m.trail : [];
      return t.length >= 2;
    };

    // Draw order: oldest trails first, newest trails last, so newly-arrived data is on top
    // even when it overlaps other sensors' trails.
    const trailLastMs = (m) => {
      const id = (m && m.id != null) ? String(m.id) : "";
      const serverTrail = Array.isArray(m?.trail) ? m.trail : [];
      const persistedTrail = id ? (this._persistedTrailById.get(id)?.trail || []) : [];
      const src = (persistedTrail.length >= 2) ? persistedTrail : serverTrail;
      if (!Array.isArray(src) || src.length < 1) return Number.NEGATIVE_INFINITY;
      const last = src[src.length - 1];
      if (last && last._tMs !== undefined) {
        const t = last._tMs;
        return (t == null || !isFinite(t)) ? Number.NEGATIVE_INFINITY : Number(t);
      }
      const tStr = (last && typeof last.t === "string") ? last.t : null;
      const tMs = tStr ? parseUtcMs(tStr) : null;
      try { if (last) last._tMs = tMs; } catch {}
      return (tMs == null || !isFinite(tMs)) ? Number.NEGATIVE_INFINITY : Number(tMs);
    };

    // Pre-filter: skip mobiles whose trail is entirely expired (>45 min old).
    // During evening playback, most morning/afternoon vehicles are expired —
    // this avoids _collectTrailData + array allocs + projection for each.
    const TRAIL_EXPIRE_MS = 45 * 60 * 1000;
    const refTimeMs = this.getPlaybackTimeMs();
    const hasRefTime = refTimeMs != null && isFinite(refTimeMs);

    const alphaOther = selectedId ? 0.35 : 1.0;
    const candidates = [];
    for (const m of mobiles) {
      if (selectedId && m.id === selectedId) continue;
      const lastMs = trailLastMs(m);
      m._cachedTrailLastMs = lastMs;
      // Skip if trail ended >45 min before playback time
      if (hasRefTime && isFinite(lastMs) && refTimeMs - lastMs > TRAIL_EXPIRE_MS) continue;
      candidates.push(m);
    }
    candidates.sort((a, b) => a._cachedTrailLastMs - b._cachedTrailLastMs);

    for (const m of candidates) {
      drawTrailFor(m, alphaOther, worldToScreenFast);
    }

    // Selected trail always on top at full strength.
    if (selectedId) {
      const m = mobiles.find(x => x.id === selectedId);
      if (m) drawTrailFor(m, 1.0, worldToScreenFast);
    }
    
  }

  drawOverlay(state, opts = {}) {
    const ctx = this.octx;
    if (!ctx) return;
    // ── Per-frame deduplication ──
    // Multiple RAF chains (playbackLoop, _followTick, _paFieldFadeRAF, _requestZoomRedraw)
    // can all call drawOverlay in the same animation frame. The work is identical for a
    // given (view + playbackTime) so skip redundant calls within the same frame.
    {
      const _now = performance.now();
      if (this._overlayLastDrawMs && (_now - this._overlayLastDrawMs) < 4) return;
      this._overlayLastDrawMs = _now;
    }
    // During gestures/easing, skip legend-export work (no one reads these values).
    const _skipLegendExport = this._isTransientAnimating();
    // Only reset per-frame when nothing is selected.
    // When a sensor is selected but off-screen (user panned away),
    // keep the last-known values so the legend doesn't jump back to PM2.5.
    if (!this.selectedId && !_skipLegendExport) {
      this._selectedPollutantKey = null;
      this._selectedNaturalPollutantKey = null;
      this._selectedPollutantValue = null;
    }
    const w = this._cssW || 1;
    const h = this._cssH || 1;
    const dpr = this._dpr || (window.devicePixelRatio || 1);

    // CRITICAL: Reset transform to canonical dpr-scaled state at the start of every drawOverlay.
    // This prevents marker scaling bugs if any code path corrupts the transform and fails to restore.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // In playback mode, trails must be redrawn each frame (time-clipped).
    // Static overlay caching is only valid for trace mode without playback.
    const useStaticOverlay = this.traceMode && !this.playbackMode;

    if (useStaticOverlay) {
      this._ensureTracePoints(state);
      this._ensureOverlayStatic(state);
      const pw = this.overlayCanvas.width;
      const ph = this.overlayCanvas.height;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, pw, ph);
      if (this._overlayStaticCanvas) ctx.drawImage(this._overlayStaticCanvas, 0, 0);
      ctx.restore();
    } else {
      ctx.clearRect(0, 0, w, h);
    }

    if (!state) return;
    const mobiles = Array.isArray(state.mobile) ? state.mobile : [];
    const fixed = Array.isArray(state.fixed) ? state.fixed : [];

    // --- Per-frame caches (reset each drawOverlay call) ---
    // Emoji pre-render cache: drawImage of a cached canvas is far cheaper than
    // fillText with color-emoji fonts on iOS Safari (~1-3ms per fillText avoided).
    if (!this._emojiCanvasCache) this._emojiCanvasCache = new Map();
    const getEmojiCanvas = (emoji, size) => {
      const key = `${emoji}|${size}`;
      let c = this._emojiCanvasCache.get(key);
      if (c) return c;
      const px = size * 2; // 2x for clarity at retina
      c = document.createElement("canvas");
      c.width = px; c.height = px;
      const ec = c.getContext("2d");
      // Render at native canvas pixels so downscaling preserves the intended size.
      ec.font = `${px}px Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif`;
      ec.textAlign = "center";
      ec.textBaseline = "middle";
      ec.fillText(emoji, px / 2, px / 2);
      this._emojiCanvasCache.set(key, c);
      // Evict oldest entries if cache grows too large
      while (this._emojiCanvasCache.size > 200) {
        const oldest = this._emojiCanvasCache.keys().next().value;
        if (oldest == null) break;
        this._emojiCanvasCache.delete(oldest);
      }
      return c;
    };

    // measureText cache: avoids repeated glyph layout for identical strings.
    if (!this._textWidthCache) this._textWidthCache = new Map();
    const measureTextCached = (text, font) => {
      const key = `${font}|${text}`;
      let width = this._textWidthCache.get(key);
      if (width !== undefined) return width;
      ctx.font = font;
      width = ctx.measureText(text).width;
      if (!(width > 0)) width = text.length * 7; // iOS fallback
      this._textWidthCache.set(key, width);
      // Evict oldest entries if cache grows too large
      while (this._textWidthCache.size > 2000) {
        const oldest = this._textWidthCache.keys().next().value;
        if (oldest == null) break;
        this._textWidthCache.delete(oldest);
      }
      return width;
    };

    // dimHex/desatHex color cache: these do regex + parseInt + Math.round per call.
    const _colorXformCache = new Map();
    const colorXform = (baseColor, dimAmt, desatAmt) => {
      const key = `${baseColor}|${dimAmt}|${desatAmt}`;
      let r = _colorXformCache.get(key);
      if (r !== undefined) return r;
      r = desatAmt > 0 ? desatHex(dimHex(baseColor, dimAmt), desatAmt) : dimHex(baseColor, dimAmt);
      _colorXformCache.set(key, r);
      return r;
    };

    // Fixed sensor interpolation cache: avoids re-parsing history timestamps every frame.
    if (!this._fixedInterpCache) this._fixedInterpCache = { timeKey: null, map: new Map() };

    // Hoist values called redundantly per-mobile inside closures.
    const _framePbTimeMs = this.playbackMode ? this.getPlaybackTimeMs() : null;
    const _framePbBounds = this.playbackMode ? this.getPlaybackBounds() : null;
    const _frameSel = parseKey(this.selectedId);
    const _frameHasSelectedMobile = (_frameSel && _frameSel.type === "mobile" && _frameSel.id);
    const _frameSelectedId = _frameHasSelectedMobile ? _frameSel.id : null;

    // Playback-mode trail caching:
    // Cache trails to offscreen canvas; only redraw when view or time changes significantly.
    const pbTimeMs = _framePbTimeMs;
    const trailViewKey = `${this.center.lat.toFixed(6)}|${this.center.lon.toFixed(6)}|${this.zoom.toFixed(3)}|${w}|${h}|${this.selectedId || ''}|${this._paFieldPollutant || 'default'}`;
    const viewChanged = this._trailCacheViewKey !== trailViewKey;
    const timeDelta = (pbTimeMs != null && this._trailCacheTimeMs != null) ? (pbTimeMs - this._trailCacheTimeMs) : 0;
    // Trail fading uses 45-min window. During active scrubbing, widen the threshold
    // so trails aren't fully redrawn every frame (the expensive O(vehicles*points) path).
    // 30s during scrub still gives smooth visual feedback; 2s during playback keeps fading smooth.
    const timeThreshold = this._scrubbing ? 30000 : 2000;
    // Sim-time gate: has enough simulated time elapsed to warrant a redraw?
    const simTimeElapsed = Math.abs(timeDelta) > timeThreshold;
    // Wall-time floor: at high playback speeds (60x screensaver), the sim-time gate
    // trips every ~33ms wall, causing the full O(vehicles*points) trail rebuild to
    // run 30x/sec. Rate-limit sim-driven redraws to ~10 Hz wall. View changes
    // (pan/zoom) still bypass this gate so interactive response stays snappy.
    const nowPerf = performance.now();
    const wallSinceRedraw = nowPerf - (this._lastTrailRedrawPerf || 0);
    const timeChanged = simTimeElapsed && wallSinceRedraw > 100;

    // Precompute center world once per frame; avoids repeated center projection in worldToScreen().
    const centerW = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
    const worldToScreenFast = (wx, wy) => ({ x: wx - centerW.x + w / 2, y: wy - centerW.y + h / 2 });

    // Overfetch: trail cache buffer is larger than viewport
    const trailBufW = Math.min(Math.ceil(w * _OVERFETCH), Math.floor(_OVERFETCH_MAX_DEVICE_PX / dpr));
    const trailBufH = Math.min(Math.ceil(h * _OVERFETCH), Math.floor(_OVERFETCH_MAX_DEVICE_PX / dpr));
    const worldToScreenBuf = (wx, wy) => ({ x: wx - centerW.x + trailBufW / 2, y: wy - centerW.y + trailBufH / 2 });

    // Fixed markers are drawn AFTER trails (below)

    // Trails:
    // - if none selected: show ALL trails
    // - if selected: show ALL trails, but dim others and draw selected last on top
    const sel = _frameSel;
    const hasSelectedMobile = _frameHasSelectedMobile;
    const selectedId = _frameSelectedId;

    // Reveal trail up to playback time (works in both DVR and LIVE modes).
    // LIVE mode uses playback time at the live edge.
    const isLive = !this.playbackMode;
    const trailRevealTimeMs = _framePbTimeMs;

    const drawTrailFor = (m, alphaMul, toScreen) => {
      const id = m && m.id != null ? String(m.id) : "";
      
      // Use shared trail collection logic
      const data = this._collectTrailData(m, toScreen);
      if (!data) return false;
      const { pts, cols, times, trail, isGhost } = data;
      
      const isSelTrail = (selectedId && m.id === selectedId);

      // Tail fade should be based on the *visible* (drawn) trail only.
      let visMinT = Infinity, visMaxT = -Infinity;
      for (let i = 1; i < pts.length; i++) {
        if (!pts[i - 1] || !pts[i]) continue;
        const p1 = trail[i];
        const isMoving = !!(p1 && (p1.m === 1 || p1.m === "1" || p1.m === true));
        const willDraw = this._pbDebugPath || isMoving;
        if (!willDraw) continue;
        const t1 = times[i];
        if (t1 != null && isFinite(t1)) {
          if (t1 < visMinT) visMinT = t1;
          if (t1 > visMaxT) visMaxT = t1;
        }
      }
      if (!(visMaxT > visMinT)) {
        for (const t of times) {
          if (t != null && isFinite(t)) {
            if (t < visMinT) visMinT = t;
            if (t > visMaxT) visMaxT = t;
          }
        }
      }
      const totalDur = (visMaxT > visMinT) ? (visMaxT - visMinT) : 0;

      // Render as a dotted line, but color each segment by the reading at that time.
      // User request: maximize contrast + opacity on trails.
      const alpha = (isSelTrail ? 1.0 : 0.85) * alphaMul;
      const lw = isSelTrail ? 4.2 : 3.4;
      const dash = [2, 10];

      // Strictly time-based trail decay (matches the static overlay trail behavior):
      // - total decay window: 45 minutes
      // - fade begins only in the last 20% of that window
      const FADE_TIME_MS = 45 * 60 * 1000; // 45 minutes -> fully expired
      const FADE_TAIL_FRAC = 0.20;
      const FADE_START_FRAC = 1.0 - FADE_TAIL_FRAC;
      // Reference time: use playback time, trail's max time, or playback bounds (NOT wall clock)
      const livePlaybackTimeMs = _framePbTimeMs;
      const hasPlaybackTime = livePlaybackTimeMs != null && isFinite(livePlaybackTimeMs);
      const boundsMaxMs = (_framePbBounds && _framePbBounds.maxMs != null && isFinite(_framePbBounds.maxMs)) ? _framePbBounds.maxMs : null;
      const refNowMs = hasPlaybackTime ? Number(livePlaybackTimeMs)
        : (isFinite(visMaxT) ? visMaxT
        : (boundsMaxMs != null ? boundsMaxMs
        : this._dataNowMs()));

      // Calculate pixels per meter at the trail's location (approximate using first point).
      // This is needed to convert the pruned world distance into a screen-space dash offset.
      let pixelsPerMeter = 1.0;
      if (pts.length > 0) {
        const lat = Number(trail[0].lat);
        if (isFinite(lat)) {
            const c = latLonToWorld(lat, 0, this.zoom);
            // Earth circumference ~40,075,016m.
            // World size at zoom = c.ws.
            // Scale factor = ws / (40075016 * cos(lat)).
            const cosLat = Math.cos(lat * Math.PI / 180);
            if (cosLat > 1e-6) {
                pixelsPerMeter = c.ws / (40075016 * cosLat);
            }
        }
      }

      let batchColor = null;
      let batchAlpha = null;
      let batchPts = [];

      // Set up trail drawing context once, only change what varies per batch
      ctx.lineWidth = lw;
      ctx.setLineDash(dash);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      const flushBatch = () => {
        if (batchPts.length < 2) {
            batchPts = [];
            return;
        }
        ctx.globalAlpha = batchAlpha;
        ctx.strokeStyle = batchColor;
        ctx.beginPath();
        // Draw disconnected segments to ensure dash pattern resets at every vertex.
        for (let k = 0; k < batchPts.length - 1; k++) {
            ctx.moveTo(batchPts[k].x, batchPts[k].y);
            ctx.lineTo(batchPts[k+1].x, batchPts[k+1].y);
        }
        ctx.stroke();
        batchPts = [];
      };

      // Pre-compute fade threshold: points newer than this don't need fade calculation
      const fadeStartAgeMs = FADE_TIME_MS * FADE_START_FRAC;

      // Binary search: skip old points outside the fade window entirely.
      // times[] is chronological (ascending). Find first index where age < FADE_TIME_MS.
      let _fadeStart = 1;
      if (times.length > 20 && isFinite(refNowMs)) {
        const cutoffT = refNowMs - FADE_TIME_MS;
        let _fl = 1, _fh = times.length - 1;
        while (_fl < _fh) {
          const _fm = (_fl + _fh) >> 1;
          if ((times[_fm] || 0) < cutoffT) _fl = _fm + 1; else _fh = _fm;
        }
        _fadeStart = Math.max(1, _fl);
      }

      for (let i = _fadeStart; i < pts.length; i++) {
        const ptPrev = pts[i-1];
        const ptCurr = pts[i];
        
        if (!ptPrev || !ptCurr) {
            flushBatch();
            continue;
        }

        // Use the 'm' (moving) flag from the server point to determine if 
        // this segment should be hidden/faded (jitter) or bright (historical data).
        const p1 = trail[i];
        const isMoving = !!(p1 && (p1.m === 1 || p1.m === "1" || p1.m === true));
        
        const segColor0 = cols[i] || cols[i - 1] || "#ffffff";
        let segColor = segColor0;
        let alphaMul2 = 1.0;

        if (!isMoving) {
          if (this._pbDebugPath) {
            segColor = colorXform(segColor0, 0.25, 0);
          } else {
            // Previously hidden: keep visible, but fade + desaturate.
            segColor = colorXform(segColor0, 0.35, 0.30);
            alphaMul2 = 0.5;
          }
        } else if (isGhost && isLive) {
          segColor = colorXform(segColor0, 0.65, 0.25); // Dim + slight desat for offline sensors
          alphaMul2 = 0.5;
        }

        const t1 = times[i];
        if (!(t1 != null && isFinite(t1) && isFinite(refNowMs))) {
          flushBatch();
          continue;
        }

        // Hide leading trail: skip points ahead of the vehicle's time position (unless debug)
        // (Trail is already clipped during collection, but this handles edge cases)

        const ageMs = refNowMs - t1;
        
        // Skip points older than fade window
        if (ageMs >= FADE_TIME_MS) {
          flushBatch();
          continue;
        }

        // Only compute fade for points in the last 20% of the window
        let tailAlpha = 1.0;
        if (ageMs > fadeStartAgeMs) {
          const u = (ageMs - fadeStartAgeMs) / (FADE_TIME_MS - fadeStartAgeMs);
          tailAlpha = (1 - u) * (1 - u); // squared falloff
          if (tailAlpha <= 0.01) {
            flushBatch();
            continue;
          }
        }

        const finalAlpha = alpha * tailAlpha * alphaMul2;

        if (segColor !== batchColor || Math.abs(finalAlpha - batchAlpha) > 0.01) {
            flushBatch();
            batchColor = segColor;
            batchAlpha = finalAlpha;
            batchPts = [];
        }
        
        batchPts.push(ptPrev);
        batchPts.push(ptCurr);
      }
      flushBatch();
      // Reset context state for subsequent drawing
      ctx.setLineDash([]);
      ctx.globalAlpha = 1.0;

      return true;
    };

    const mobileHasServerTrail = (m) => {
      const t = Array.isArray(m?.trail) ? m.trail : [];
      return t.length >= 2;
    };

    // In trace mode (without playback), trails are part of the cached static overlay.
    // In playback mode, use trail caching to avoid redrawing every frame.
    if (!useStaticOverlay) {
      // Trail cache: full redraw on view change OR any time change.
      // Time-based fading requires full redraw whenever playback time changes so all
      // trail segments get redrawn with correct fade alpha relative to current time.
      const needsFullRedraw = viewChanged || timeChanged;
      // During gestures, skip full trail redraw for pan-only view changes;
      // translate the cached canvas instead (saves ~5ms/frame on iPad).
      // If pan exceeds overfetch margin, force full redraw.
      let skipTrailsForGesture = this._isTransientAnimating() && viewChanged && !timeChanged
        && this._trailCacheCanvas && this._trailCacheCenterW;
      if (skipTrailsForGesture) {
        const cachedCW = this._trailCacheCenterW;
        const cachedZ = this._trailCacheZoom || this.zoom;
        const currCW = latLonToWorld(this.center.lat, this.center.lon, cachedZ);
        const tMarginX = (trailBufW - w) / 2;
        const tMarginY = (trailBufH - h) / 2;
        if (Math.abs(cachedCW.x - currCW.x) >= tMarginX * _OVERFETCH_MARGIN_EXHAUST
            || Math.abs(cachedCW.y - currCW.y) >= tMarginY * _OVERFETCH_MARGIN_EXHAUST) {
          skipTrailsForGesture = false; // margin exhausted — force redraw
        }
      }
      const needsIncrementalUpdate = false; // Disabled: incremental breaks fade animation

      // Ensure trail cache canvas exists and is correctly sized (overfetch buffer)
      const targetW = Math.floor(trailBufW * dpr);
      const targetH = Math.floor(trailBufH * dpr);
      if (!this._trailCacheCanvas) {
        this._trailCacheCanvas = document.createElement("canvas");
        this._trailCacheCanvas.width = targetW;
        this._trailCacheCanvas.height = targetH;
      } else if (this._trailCacheCanvas.width !== targetW || this._trailCacheCanvas.height !== targetH) {
        this._trailCacheCanvas.width = targetW;
        this._trailCacheCanvas.height = targetH;
      }

      if ((needsFullRedraw && !skipTrailsForGesture) || needsIncrementalUpdate) {
        const tctx = this._trailCacheCanvas.getContext("2d");
        if (tctx) {
          tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          // Only clear on full redraw; incremental mode draws on top of existing cache
          if (needsFullRedraw) {
            tctx.clearRect(0, 0, trailBufW, trailBufH);
          }

          // Draw order: oldest trails first, newest trails last.
          const trailLastMs = (m) => {
            const id = (m && m.id != null) ? String(m.id) : "";
            const serverTrail = Array.isArray(m?.trail) ? m.trail : [];
            const persistedTrail = id ? (this._persistedTrailById.get(id)?.trail || []) : [];
            const src = (persistedTrail.length >= 2) ? persistedTrail : serverTrail;
            if (!Array.isArray(src) || src.length < 1) return Number.NEGATIVE_INFINITY;
            const last = src[src.length - 1];
            if (last && last._tMs !== undefined) {
              const t = last._tMs;
              return (t == null || !isFinite(t)) ? Number.NEGATIVE_INFINITY : Number(t);
            }
            const tStr = (last && typeof last.t === "string") ? last.t : null;
            const tMs = tStr ? parseUtcMs(tStr) : null;
            try { if (last) last._tMs = tMs; } catch {}
            return (tMs == null || !isFinite(tMs)) ? Number.NEGATIVE_INFINITY : Number(tMs);
          };

          // Temporarily redirect drawTrailFor to use the cache canvas context
          // minTimeMs: if set, only draw segments with time > minTimeMs (incremental mode)
          const origCtx = ctx;
          const drawTrailForCached = (m, alphaMul, toScreen, minTimeMs = null) => {
            const id = m && m.id != null ? String(m.id) : "";
            const data = this._collectTrailData(m, toScreen);
            if (!data) return false;
            const { pts, cols, times, trail, isGhost } = data;
            const isSelTrail = (selectedId && m.id === selectedId);
            const useIncrementalFilter = minTimeMs != null && isFinite(minTimeMs);

            let visMinT = Infinity, visMaxT = -Infinity;
            for (let i = 1; i < pts.length; i++) {
              if (!pts[i - 1] || !pts[i]) continue;
              const p1 = trail[i];
              const isMoving = !!(p1 && (p1.m === 1 || p1.m === "1" || p1.m === true));
              const willDraw = this._pbDebugPath || isMoving;
              if (!willDraw) continue;
              const t1 = times[i];
              if (t1 != null && isFinite(t1)) {
                if (t1 < visMinT) visMinT = t1;
                if (t1 > visMaxT) visMaxT = t1;
              }
            }
            if (!(visMaxT > visMinT)) {
              for (const t of times) {
                if (t != null && isFinite(t)) {
                  if (t < visMinT) visMinT = t;
                  if (t > visMaxT) visMaxT = t;
                }
              }
            }

            const alpha = (isSelTrail ? 1.0 : 0.85) * alphaMul;
            const lw = isSelTrail ? 4.2 : 3.4;
            const dash = [2, 10];
            const FADE_TIME_MS = 45 * 60 * 1000;
            const FADE_TAIL_FRAC = 0.20;
            const FADE_START_FRAC = 1.0 - FADE_TAIL_FRAC;
            const livePlaybackTimeMs = _framePbTimeMs;
            const hasPlaybackTime = livePlaybackTimeMs != null && isFinite(livePlaybackTimeMs);
            const boundsMaxMs = (_framePbBounds && _framePbBounds.maxMs != null && isFinite(_framePbBounds.maxMs)) ? _framePbBounds.maxMs : null;
            const refNowMs = hasPlaybackTime ? Number(livePlaybackTimeMs) 
              : (isFinite(visMaxT) ? visMaxT 
              : (boundsMaxMs != null ? boundsMaxMs 
              : this._dataNowMs()));

            let batchColor = null;
            let batchAlpha = null;
            let batchPts = [];

            tctx.lineWidth = lw;
            tctx.setLineDash(dash);
            tctx.lineCap = "round";
            tctx.lineJoin = "round";

            const flushBatch = () => {
              if (batchPts.length < 2) { batchPts = []; return; }
              tctx.globalAlpha = batchAlpha;
              tctx.strokeStyle = batchColor;
              tctx.beginPath();
              for (let k = 0; k < batchPts.length - 1; k++) {
                tctx.moveTo(batchPts[k].x, batchPts[k].y);
                tctx.lineTo(batchPts[k+1].x, batchPts[k+1].y);
              }
              tctx.stroke();
              batchPts = [];
            };

            const fadeStartAgeMs = FADE_TIME_MS * FADE_START_FRAC;
            const isLive = !this.playbackMode;

            for (let i = 1; i < pts.length; i++) {
              const ptPrev = pts[i-1];
              const ptCurr = pts[i];
              if (!ptPrev || !ptCurr) { flushBatch(); continue; }

              const p1 = trail[i];
              const isMoving = !!(p1 && (p1.m === 1 || p1.m === "1" || p1.m === true));
              const segColor0 = cols[i] || cols[i - 1] || "#ffffff";
              let segColor = segColor0;
              let alphaMul2 = 1.0;

              if (!isMoving) {
                if (this._pbDebugPath) {
                  segColor = colorXform(segColor0, 0.25, 0);
                } else {
                  segColor = colorXform(segColor0, 0.35, 0.30);
                  alphaMul2 = 0.5;
                }
              } else if (isGhost && isLive) {
                segColor = colorXform(segColor0, 0.65, 0.25);
              }

              const t1 = times[i];
              if (!(t1 != null && isFinite(t1) && isFinite(refNowMs))) { flushBatch(); continue; }

              // Incremental mode: skip segments already drawn in previous cache
              if (useIncrementalFilter && t1 <= minTimeMs) { continue; }

              const ageMs = refNowMs - t1;
              if (ageMs >= FADE_TIME_MS) { flushBatch(); continue; }

              let tailAlpha = 1.0;
              if (ageMs > fadeStartAgeMs) {
                const u = (ageMs - fadeStartAgeMs) / (FADE_TIME_MS - fadeStartAgeMs);
                tailAlpha = (1 - u) * (1 - u);
                if (tailAlpha <= 0.01) { flushBatch(); continue; }
              }

              const finalAlpha = alpha * tailAlpha * alphaMul2;
              if (segColor !== batchColor || Math.abs(finalAlpha - batchAlpha) > 0.01) {
                flushBatch();
                batchColor = segColor;
                batchAlpha = finalAlpha;
                batchPts = [];
              }
              batchPts.push(ptPrev);
              batchPts.push(ptCurr);
            }
            flushBatch();
            tctx.setLineDash([]);
            tctx.globalAlpha = 1.0;
            return true;
          };

          // Pre-filter expired trails (>45 min old) to avoid array
          // allocations and projection work for vehicles no longer visible.
          const TRAIL_EXPIRE_MS = 45 * 60 * 1000;
          const hasRefTime = pbTimeMs != null && isFinite(pbTimeMs);

          const alphaOther = selectedId ? 0.35 : 1.0;
          const candidates = [];
          for (const m of mobiles) {
            if (selectedId && m.id === selectedId) continue;
            const lastMs = trailLastMs(m);
            m._cachedTrailLastMs = lastMs;
            if (hasRefTime && isFinite(lastMs) && pbTimeMs - lastMs > TRAIL_EXPIRE_MS) continue;
            candidates.push(m);
          }
          candidates.sort((a, b) => a._cachedTrailLastMs - b._cachedTrailLastMs);

          const timeFilter = null;
          for (const m of candidates) {
            drawTrailForCached(m, alphaOther, worldToScreenBuf, timeFilter);
          }

          if (selectedId) {
            const m = mobiles.find(x => x.id === selectedId);
            if (m) drawTrailForCached(m, 1.0, worldToScreenBuf, timeFilter);
          }
        }
        this._trailCacheViewKey = trailViewKey;
        this._trailCacheTimeMs = pbTimeMs;
        this._trailCacheCenterW = { x: centerW.x, y: centerW.y };
        this._trailCacheZoom = this.zoom;
        this._trailCacheBufW = trailBufW;
        this._trailCacheBufH = trailBufH;
        this._lastTrailRedrawPerf = performance.now();
      }

      // Blit cached trails to main canvas
      if (this._trailCacheCanvas) {
        const tBufW = this._trailCacheBufW || w;
        const tBufH = this._trailCacheBufH || h;
        const tOffX = (tBufW - w) / 2;
        const tOffY = (tBufH - h) / 2;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (skipTrailsForGesture && this._trailCacheCenterW) {
          const cachedZ = this._trailCacheZoom || this.zoom;
          const sZoom = Math.pow(2, this.zoom - cachedZ);
          const cachedCW = this._trailCacheCenterW;
          const currCW = latLonToWorld(this.center.lat, this.center.lon, cachedZ);
          if (Math.abs(sZoom - 1) > 0.001) {
            // Pinch-zoom: match tiles transform exactly (CSS coordinate space)
            const txPan = (cachedCW.x - currCW.x) * sZoom;
            const tyPan = (cachedCW.y - currCW.y) * sZoom;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.translate(w / 2, h / 2);
            ctx.scale(sZoom, sZoom);
            ctx.translate(-w / 2 + txPan / sZoom, -h / 2 + tyPan / sZoom);
            ctx.drawImage(this._trailCacheCanvas, -tOffX, -tOffY, tBufW, tBufH);
          } else {
            // Pan only: simple translate in physical pixel space with overfetch offset
            const dx = (cachedCW.x - currCW.x - tOffX) * dpr;
            const dy = (cachedCW.y - currCW.y - tOffY) * dpr;
            ctx.drawImage(this._trailCacheCanvas, dx, dy);
          }
        } else {
          // Static: draw the overfetch buffer offset so viewport sees center
          ctx.drawImage(this._trailCacheCanvas, -tOffX * dpr, -tOffY * dpr);
        }
        ctx.restore();
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DEBUG: Draw RAW GPS PATH (original GPS before road snapping) - orange dashed
    // This shows the original GPS coordinates from the server, before any
    // road-matching optimization is applied.
    // ═══════════════════════════════════════════════════════════════════════════
    if (this._pbDebugPath && this._pbDebugRawGps && this.playbackMode) {
      const selId = _frameSelectedId;
      if (selId) {
        const rawGps = this._playbackPtsById?.get(String(selId));
        if (rawGps && rawGps.length >= 2) {
          const ws = worldSizeForZoom(this.zoom);
          const pbTimeMs = _framePbTimeMs;

          ctx.save();
          ctx.strokeStyle = "#ff8800"; // Orange for raw GPS
          ctx.lineWidth = 2;
          ctx.globalAlpha = 0.6;
          ctx.setLineDash([4, 6]);
          ctx.lineCap = "round";
          ctx.beginPath();
          
          let started = false;
          for (let i = 0; i < rawGps.length; i++) {
            const pt = rawGps[i];
            const lat = Number(pt.lat), lon = Number(pt.lon);
            if (!isFinite(lat) || !isFinite(lon)) continue;
            
            // Clip to playback time
            const tMs = (pt && typeof pt.t === "string") ? parseUtcMs(pt.t) : null;
            if (pbTimeMs != null && tMs != null && tMs > pbTimeMs) break;
            
            const norm = latLonToNorm(lat, lon);
            const sp = worldToScreenFast(norm.u * ws, norm.v * ws);
            if (!started) {
              ctx.moveTo(sp.x, sp.y);
              started = true;
            } else {
              ctx.lineTo(sp.x, sp.y);
            }
          }
          ctx.stroke();
          
          // Draw small markers at each raw GPS point
          ctx.fillStyle = "#ff8800";
          ctx.globalAlpha = 0.8;
          for (let i = 0; i < rawGps.length; i++) {
            const pt = rawGps[i];
            const lat = Number(pt.lat), lon = Number(pt.lon);
            if (!isFinite(lat) || !isFinite(lon)) continue;
            
            const tMs = (pt && typeof pt.t === "string") ? parseUtcMs(pt.t) : null;
            if (pbTimeMs != null && tMs != null && tMs > pbTimeMs) break;
            
            const norm = latLonToNorm(lat, lon);
            const sp = worldToScreenFast(norm.u * ws, norm.v * ws);
            ctx.beginPath();
            ctx.arc(sp.x, sp.y, 3, 0, 2 * Math.PI);
            ctx.fill();
          }
          
          ctx.restore();
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DEBUG: Draw ROAD GRAPH EDGES (street centerlines from road graph)
    // This shows the actual road network the server uses for snapping.
    // ═══════════════════════════════════════════════════════════════════════════
    if (this._pbDebugPath && this._pbDebugRoadLines && this.playbackMode) {
      // Fetch road edges for current viewport if needed (async, won't block)
      this._fetchRoadEdgesForViewport();
      
      const edges = this._roadGraphEdges;
      if (edges && edges.length > 0) {
        const ws = worldSizeForZoom(this.zoom);
        
        ctx.save();
        ctx.strokeStyle = "#444488"; // Dim blue for road lines
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.4;
        ctx.setLineDash([]);
        
        for (const e of edges) {
          const lat1 = Number(e.lat1), lon1 = Number(e.lon1);
          const lat2 = Number(e.lat2), lon2 = Number(e.lon2);
          if (!isFinite(lat1) || !isFinite(lon1) || !isFinite(lat2) || !isFinite(lon2)) continue;
          
          const n1 = latLonToNorm(lat1, lon1);
          const n2 = latLonToNorm(lat2, lon2);
          const sp1 = worldToScreenFast(n1.u * ws, n1.v * ws);
          const sp2 = worldToScreenFast(n2.u * ws, n2.v * ws);
          
          // Skip if off-screen
          if ((sp1.x < -50 && sp2.x < -50) || (sp1.x > w + 50 && sp2.x > w + 50)) continue;
          if ((sp1.y < -50 && sp2.y < -50) || (sp1.y > h + 50 && sp2.y > h + 50)) continue;
          
          ctx.beginPath();
          ctx.moveTo(sp1.x, sp1.y);
          ctx.lineTo(sp2.x, sp2.y);
          ctx.stroke();
        }
        
        ctx.restore();
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DEBUG: Draw TRAM LINE GRAPH EDGES (rail lines from tram line graph)
    // This shows the tram network used for TRAX snapping.
    // Color by elevation: green (low/ground) -> cyan (high/elevated tracks)
    // ═══════════════════════════════════════════════════════════════════════════
    if (this._pbDebugPath && this._pbDebugRoadLines && this.playbackMode) {
      // Fetch tram line edges for current viewport if needed (async, won't block)
      this._fetchTramLineEdgesForViewport();
      
      const tramEdges = this._tramLineEdges;
      const hasElevation = this._tramLineHasElevation;
      if (tramEdges && tramEdges.length > 0) {
        const ws = worldSizeForZoom(this.zoom);
        
        // Elevation color mapping: green (1280m) -> cyan (1500m)
        // SLC base elevation ~1280m, elevated tracks can be 1400m+
        const minElev = 1280, maxElev = 1500;
        const elevRange = maxElev - minElev;
        
        const elevToColor = (elev) => {
          if (!hasElevation || elev == null) return "#44aa66"; // Default green
          const t = Math.max(0, Math.min(1, (elev - minElev) / elevRange));
          // Interpolate: green (68, 170, 102) -> cyan (68, 200, 220)
          const r = 68;
          const g = Math.round(170 + t * 30);
          const b = Math.round(102 + t * 118);
          return `rgb(${r},${g},${b})`;
        };
        
        ctx.save();
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.7;
        ctx.setLineDash([]);
        
        for (const e of tramEdges) {
          const lat1 = Number(e.lat1), lon1 = Number(e.lon1);
          const lat2 = Number(e.lat2), lon2 = Number(e.lon2);
          if (!isFinite(lat1) || !isFinite(lon1) || !isFinite(lat2) || !isFinite(lon2)) continue;
          
          const n1 = latLonToNorm(lat1, lon1);
          const n2 = latLonToNorm(lat2, lon2);
          const sp1 = worldToScreenFast(n1.u * ws, n1.v * ws);
          const sp2 = worldToScreenFast(n2.u * ws, n2.v * ws);
          
          // Skip if off-screen
          if ((sp1.x < -50 && sp2.x < -50) || (sp1.x > w + 50 && sp2.x > w + 50)) continue;
          if ((sp1.y < -50 && sp2.y < -50) || (sp1.y > h + 50 && sp2.y > h + 50)) continue;
          
          // Color by average elevation of edge
          const avgElev = (e.elev1 != null && e.elev2 != null) ? (e.elev1 + e.elev2) / 2 : null;
          ctx.strokeStyle = elevToColor(avgElev);
          
          ctx.beginPath();
          ctx.moveTo(sp1.x, sp1.y);
          ctx.lineTo(sp2.x, sp2.y);
          ctx.stroke();
        }
        
        ctx.restore();
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DEBUG: Draw the STEERING PATH - predicted trajectory based on current physics
    // This shows where the vehicle WILL go based on current heading and steering.
    // Like a racing game steering trainer - shows the predicted path ahead.
    //
    // The path is computed by simulating the vehicle forward from current position,
    // steering toward lookahead points on the raw GPS path.
    // ═══════════════════════════════════════════════════════════════════════════
    if (this._pbDebugPath && this.playbackMode) {
      const selId = _frameSelectedId;
      if (selId) {
        const ws = worldSizeForZoom(this.zoom);
        const mid = String(selId);
        
        const mobs = Array.isArray(state.mobile) ? state.mobile : [];
        const mm = mobs.find(x => x.id === selId);
        if (mm) {
          const playbackPts = this._playbackPtsById.get(mid);
          if (playbackPts && playbackPts.length >= 2) {
            const phys = this._getPhysicsState(mid);
            const { cumDist, totalDist, curvature } = this._getPathDistances(mid, playbackPts);
            const physD = (phys.d != null && isFinite(phys.d)) ? phys.d : 0;
            const playbackSpeed = this._playbackSpeed || 1.0;
            
            // Calculate visible end - same as vehicle physics uses
            const tMin = playbackPts[0].tMs;
            const tMax = playbackPts[playbackPts.length - 1].tMs;
            const playT = this._currentPlaybackTimeMs || tMax;
            const visibleTargetD = this._getTargetDistance(playbackPts, cumDist, totalDist, playT);
            
            // ═══════════════════════════════════════════════════════════════════
            // PRECOMPUTE SMOOTH CURVE using Catmull-Rom spline interpolation
            // This creates the path the vehicle WOULD take based on GPS waypoints
            // ═══════════════════════════════════════════════════════════════════
            
            // Find which GPS points are ahead of vehicle (within visible range)
            const startIdx = cumDist.findIndex(d => d >= physD);
            const endIdx = cumDist.findIndex(d => d >= visibleTargetD);
            const visibleStartIdx = Math.max(0, (startIdx === -1 ? 0 : startIdx) - 1);
            const visibleEndIdx = endIdx === -1 ? playbackPts.length - 1 : Math.min(playbackPts.length - 1, endIdx + 1);
            
            // Generate smooth curve waypoints using Catmull-Rom spline
            const smoothCurve = [];
            const SAMPLES_PER_SEGMENT = 8; // More samples = smoother curve
            
            for (let i = visibleStartIdx; i < visibleEndIdx; i++) {
              const p0 = playbackPts[Math.max(0, i - 1)];
              const p1 = playbackPts[i];
              const p2 = playbackPts[Math.min(playbackPts.length - 1, i + 1)];
              const p3 = playbackPts[Math.min(playbackPts.length - 1, i + 2)];
              
              // Catmull-Rom interpolation with tension 0.5 (standard)
              const tension = 0.5;
              const s = (1 - tension) / 2;
              
              for (let j = 0; j <= SAMPLES_PER_SEGMENT; j++) {
                const t = j / SAMPLES_PER_SEGMENT;
                const t2 = t * t;
                const t3 = t2 * t;
                
                const h1 = -s * t3 + 2 * s * t2 - s * t;
                const h2 = (2 - s) * t3 + (s - 3) * t2 + 1;
                const h3 = (s - 2) * t3 + (3 - 2 * s) * t2 + s * t;
                const h4 = s * t3 - s * t2;
                
                const lat = h1 * p0.lat + h2 * p1.lat + h3 * p2.lat + h4 * p3.lat;
                const lon = h1 * p0.lon + h2 * p1.lon + h3 * p2.lon + h4 * p3.lon;
                
                // Calculate distance along curve for this point
                const segDist = cumDist[i] + (cumDist[Math.min(i + 1, cumDist.length - 1)] - cumDist[i]) * t;
                
                // Only include points within visible range and ahead of vehicle
                if (segDist >= physD && segDist <= visibleTargetD) {
                  smoothCurve.push({ lat, lon, d: segDist });
                }
              }
            }
            
            // Remove duplicate points (from overlapping segments)
            const deduped = [];
            for (let i = 0; i < smoothCurve.length; i++) {
              if (i === 0 || 
                  Math.abs(smoothCurve[i].lat - deduped[deduped.length - 1].lat) > 1e-7 ||
                  Math.abs(smoothCurve[i].lon - deduped[deduped.length - 1].lon) > 1e-7) {
                deduped.push(smoothCurve[i]);
              }
            }
            
            // ═══════════════════════════════════════════════════════════════════
            // STEERING SIMULATION: Vehicle steers toward precomputed curve
            // All parameters SCALE WITH PLAYBACK SPEED to maintain realistic physics
            // ═══════════════════════════════════════════════════════════════════
            
            const sqrtSpeed = Math.sqrt(Math.max(1, playbackSpeed));
            
            // Lookahead INCREASES with speed - need to see curves earlier at high speed
            const LOOKAHEAD_BASE = 30;      // meters at 1x
            const LOOKAHEAD_PER_SQRT = 20;  // additional meters per sqrt(speed)
            const lookaheadD_base = LOOKAHEAD_BASE + LOOKAHEAD_PER_SQRT * sqrtSpeed;
            
            // Steering rate DECREASES with speed - more inertia at high speed
            const STEER_RATE_BASE = 6.0;
            const steerRate = STEER_RATE_BASE / sqrtSpeed;
            
            // Lateral pull-back DECREASES with speed - can't correct as sharply
            const PULLBACK_BASE = 1.0;
            const pullbackScale = PULLBACK_BASE / sqrtSpeed;
            
            const metersPerDegLat = 111320;
            const metersPerDegLon = 111320 * Math.cos((phys.lat || 40.7) * Math.PI / 180);
            
            // Sample the precomputed curve at a given distance
            const sampleCurveAtD = (targetD) => {
              if (deduped.length < 2) return deduped[0] || { lat: phys.lat, lon: phys.lon };
              for (let i = 0; i < deduped.length - 1; i++) {
                if (deduped[i + 1].d >= targetD) {
                  const u = (deduped[i + 1].d - deduped[i].d) > 0.1 
                    ? (targetD - deduped[i].d) / (deduped[i + 1].d - deduped[i].d)
                    : 0;
                  return {
                    lat: deduped[i].lat + u * (deduped[i + 1].lat - deduped[i].lat),
                    lon: deduped[i].lon + u * (deduped[i + 1].lon - deduped[i].lon)
                  };
                }
              }
              return deduped[deduped.length - 1];
            };
            
            let simLat = phys.lat || 0;
            let simLon = phys.lon || 0;
            let simHeading = phys.heading || 0;
            let simD = physD;
            let simV = phys.v || 15;
            
            // ═══════════════════════════════════════════════════════════════════
            // EMERGENT PHYSICS: No precalculation. Just react to visible trail.
            // 
            // curveDebt = distance lost from slowing for curves
            // - Paid back by accelerating on straightaways
            // - Stops: just wait (no debt - we're honoring the GPS data)
            // ═══════════════════════════════════════════════════════════════════
            
            let curveDebt = 0;
            const CRUISE_SPEED = 65; // Base cruise speed in m/s (~145 mph, TRAX light-rail)
            
            const steeringPath = [{ lat: simLat, lon: simLon }];
            const SIM_STEPS = 30;
            const SIM_DT = 0.1;
            
            for (let step = 0; step < SIM_STEPS && simD < visibleTargetD; step++) {
              // Lookahead scales with speed, clamped to visible trail
              const lookaheadD = Math.min(lookaheadD_base, visibleTargetD - simD);
              if (lookaheadD <= 0) break;
              
              const targetD = Math.min(simD + lookaheadD, visibleTargetD);
              
              // Sample from PRECOMPUTED SMOOTH CURVE
              const lookaheadSample = sampleCurveAtD(targetD);
                            // Also get the curve point at our CURRENT distance (for lateral correction)
              const currentCurvePt = sampleCurveAtD(simD);
              
              // Calculate lateral offset from curve
              const latOffsetM = (simLat - currentCurvePt.lat) * metersPerDegLat;
              const lonOffsetM = (simLon - currentCurvePt.lon) * metersPerDegLon;
              const lateralOffset = Math.sqrt(latOffsetM * latOffsetM + lonOffsetM * lonOffsetM);
              
              // Look ahead for curves within braking distance (scales with speed)
              const brakeLookahead = Math.min(simV * playbackSpeed * 2, visibleTargetD - simD);
              let maxCurvAhead = 0;
              for (let i = 0; i < curvature.length; i++) {
                const d = cumDist[i];
                if (d >= simD && d <= simD + brakeLookahead) {
                  if (curvature[i] > maxCurvAhead) maxCurvAhead = curvature[i];
                }
              }
              
              // Steer toward a BLEND of lookahead point and current curve point
              // Pull-back scales inversely with speed - less aggressive correction at high speed
              const rawPullBack = Math.min(1, lateralOffset / 50);
              const pullBack = rawPullBack * pullbackScale; // Scale by 1/sqrt(speed)
              const blendLat = lookaheadSample.lat * (1 - pullBack) + currentCurvePt.lat * pullBack;
              const blendLon = lookaheadSample.lon * (1 - pullBack) + currentCurvePt.lon * pullBack;
              
              const dLat = blendLat - simLat;
              const dLon = blendLon - simLon;
              const targetHeading = Math.atan2(dLat, dLon);
              
              let headingDiff = targetHeading - simHeading;
              while (headingDiff > Math.PI) headingDiff -= 2 * Math.PI;
              while (headingDiff < -Math.PI) headingDiff += 2 * Math.PI;
              const headingError = Math.abs(headingDiff);
              
              // Curvature and heading factors for curve detection
              const curveFactor = 0.0003 / (0.0003 + maxCurvAhead);
              const headingFactor = Math.max(0.1, 1.0 - headingError * 1.8);
              const lateralFactor = Math.max(0.3, 1.0 - lateralOffset / (50 * sqrtSpeed));
              
              // ═══════════════════════════════════════════════════════════════════
              // EMERGENT SPEED: No precalculation. Just physics.
              // ═══════════════════════════════════════════════════════════════════
              
              const onCurve = curveFactor < 0.7 || headingFactor < 0.7 || lateralFactor < 0.7;
              
              // Distance to where we can go
              const distanceToEnd = visibleTargetD - simD;
              
              let targetSimV;
              // If we're close to the end, slow down / stop
              if (distanceToEnd < 10) {
                // At or near the end - stop
                targetSimV = Math.max(0, distanceToEnd * 0.5);
              } else if (onCurve) {
                // On curve - slow for physics
                targetSimV = CRUISE_SPEED * curveFactor * headingFactor * lateralFactor;
                // Accumulate curve debt (we're going slower than cruise)
                const expectedDist = CRUISE_SPEED * SIM_DT * playbackSpeed;
                const actualDist = targetSimV * SIM_DT * playbackSpeed;
                curveDebt += (expectedDist - actualDist);
              } else {
                // Straightaway - cruise + pay back curve debt
                const debtPayback = Math.min(curveDebt, CRUISE_SPEED * 0.5 * SIM_DT * playbackSpeed);
                curveDebt -= debtPayback;
                const boostRatio = 1.0 + (debtPayback / (CRUISE_SPEED * SIM_DT * playbackSpeed));
                targetSimV = CRUISE_SPEED * boostRatio;
              }
              
              // Smooth velocity
              const blendRate = simV > targetSimV ? 0.6 : 0.4;
              simV = simV + blendRate * (targetSimV - simV);
              simV = Math.max(0, Math.min(40, simV));
              
              // Steer toward target - steerRate already scaled by 1/sqrt(speed)
              const speedFactor = Math.max(0.5, 15 / Math.max(5, simV));
              const steerFactor = 1 - Math.exp(-steerRate * speedFactor * SIM_DT);
              simHeading += steerFactor * headingDiff;
              
              // Move forward
              const moveDistM = simV * SIM_DT * playbackSpeed;
              simLat += (moveDistM * Math.sin(simHeading)) / metersPerDegLat;
              simLon += (moveDistM * Math.cos(simHeading)) / metersPerDegLon;
              simD += moveDistM;
              
              steeringPath.push({ lat: simLat, lon: simLon });
            }
            
            // Draw the precomputed smooth curve (the "road" based on GPS data)
            if (deduped.length >= 2) {
              ctx.save();
              
              // Draw smooth curve line (cyan)
              ctx.strokeStyle = "#00ffff";
              ctx.lineWidth = 3;
              ctx.globalAlpha = 0.7;
              ctx.setLineDash([]);
              ctx.beginPath();
              
              for (let i = 0; i < deduped.length; i++) {
                const pt = deduped[i];
                const norm = latLonToNorm(pt.lat, pt.lon);
                const sp = worldToScreenFast(norm.u * ws, norm.v * ws);
                if (i === 0) ctx.moveTo(sp.x, sp.y);
                else ctx.lineTo(sp.x, sp.y);
              }
              ctx.stroke();
              
              // Draw waypoint markers along the curve (every ~50m)
              ctx.fillStyle = "#00ffff";
              let lastMarkerD = -Infinity;
              const MARKER_SPACING = 50; // meters between markers
              for (let i = 0; i < deduped.length; i++) {
                const pt = deduped[i];
                if (pt.d - lastMarkerD >= MARKER_SPACING) {
                  const norm = latLonToNorm(pt.lat, pt.lon);
                  const sp = worldToScreenFast(norm.u * ws, norm.v * ws);
                  ctx.beginPath();
                  ctx.arc(sp.x, sp.y, 4, 0, 2 * Math.PI);
                  ctx.globalAlpha = 0.9 - (pt.d - physD) / (visibleTargetD - physD + 1) * 0.6;
                  ctx.fill();
                  lastMarkerD = pt.d;
                }
              }
              
              ctx.restore();
            }
            
            // Draw the steering simulation path (where vehicle will actually go)
            if (steeringPath.length >= 2) {
              ctx.save();
              
              // Draw steering path as dashed line
              ctx.strokeStyle = "#ff00ff"; // Magenta to distinguish from curve
              ctx.lineWidth = 2;
              ctx.globalAlpha = 0.5;
              ctx.setLineDash([5, 5]);
              ctx.beginPath();
              
              for (let i = 0; i < steeringPath.length; i++) {
                const pt = steeringPath[i];
                const norm = latLonToNorm(pt.lat, pt.lon);
                const sp = worldToScreenFast(norm.u * ws, norm.v * ws);
                if (i === 0) ctx.moveTo(sp.x, sp.y);
                else ctx.lineTo(sp.x, sp.y);
              }
              ctx.stroke();
              
              ctx.restore();
            }
          }
        }
      }
    }

    // Fixed markers - drawn AFTER trails so they appear on top
    // Render PurpleAir (public) first (so they don't draw over other markers), then others
    const fixedPbTimeMs = _framePbTimeMs;
    if (!useStaticOverlay) {
      // Recompute declutter offsets (needed in non-trace mode where _drawStaticOverlay doesn't run).
      // Uses lat/lon proximity so only truly co-located stations get nudged.
      {
        const nudgeDeg = 0.0003;
        const colocThresh = 0.002;
        this._fixedGeoOffsets = new Map();
        const ents = [];
        for (const f of fixed) {
          if (f.purpleair) continue;
          const lat = Number(f.lat), lon = Number(f.lon);
          if (!isFinite(lat) || !isFinite(lon)) continue;
          if (!f._key) f._key = keyFor("fixed", f.id);
          ents.push({ key: f._key, lat, lon, dlat: 0, dlon: 0 });
        }
        for (let i = 0; i < ents.length; i++) {
          for (let j = i + 1; j < ents.length; j++) {
            const a = ents[i], b = ents[j];
            if (Math.abs(a.lat - b.lat) + Math.abs(a.lon - b.lon) < colocThresh) {
              const dl = b.lat - a.lat, dn = b.lon - a.lon;
              const ang = (Math.abs(dl) + Math.abs(dn) > 1e-7)
                ? Math.atan2(dn, dl)
                : Math.PI / 4;
              a.dlat -= Math.cos(ang) * nudgeDeg;
              a.dlon -= Math.sin(ang) * nudgeDeg;
              b.dlat += Math.cos(ang) * nudgeDeg;
              b.dlon += Math.sin(ang) * nudgeDeg;
            }
          }
        }
        for (const e of ents) {
          if (e.dlat || e.dlon) this._fixedGeoOffsets.set(e.key, { dlat: e.dlat, dlon: e.dlon });
        }
      }

      const renderPbFixedMarker = (f) => {
        let lat = Number(f.lat), lon = Number(f.lon);
        if (!isFinite(lat) || !isFinite(lon)) return;
        if (!f._key) f._key = keyFor("fixed", f.id);
        const geo = this._fixedGeoOffsets && this._fixedGeoOffsets.get(f._key);
        if (geo) { lat += geo.dlat; lon += geo.dlon; }
        const wpt = latLonToWorld(lat, lon, this.zoom);
        const sp = worldToScreenFast(wpt.x, wpt.y);
        if (sp.x < -50 || sp.y < -50 || sp.x > w+50 || sp.y > h+50) return;

        const key = f._key;
        const isSel = (this.selectedId === key);
        const emoji = f.purpleair ? "" : (f.emoji || "📍");
        const color = safeHex(f.ci);
        let pr;
        const interpCacheKey = (fixedPbTimeMs != null && isFinite(fixedPbTimeMs))
          ? `${f.id}|${Math.round(fixedPbTimeMs / 1000)}`
          : null;
        if (interpCacheKey) {
          const timeKey = Math.round(fixedPbTimeMs / 1000);
          if (this._fixedInterpCache.timeKey !== timeKey) {
            this._fixedInterpCache.timeKey = timeKey;
            this._fixedInterpCache.map.clear();
          }
          pr = this._fixedInterpCache.map.get(f.id);
          if (pr === undefined) {
            pr = primaryReadingForFixedAtTime(f, fixedPbTimeMs);
            this._fixedInterpCache.map.set(f.id, pr);
          }
        } else {
          pr = primaryReadingForFixedAtTime(f, fixedPbTimeMs);
        }

        // Expose the selected sensor's displayed pollutant key for legend sync
        if (!_skipLegendExport) {
          if (isSel && pr && pr.key) this._selectedPollutantKey = pr.key;
          if (isSel && pr && pr.key) this._selectedNaturalPollutantKey = pr.key;
          if (isSel && pr && pr.key) this._selectedPollutantValue = parseFloat(pr.value);
        }

        // Legend pollutant override: show the selected pollutant on ALL non-PurpleAir markers
        if (this._markerPollutantOverride != null && !f.purpleair) {
          const src = (fixedPbTimeMs != null)
            ? (interpolateFixedReadingsAtTime(f, fixedPbTimeMs) || f.readings)
            : f.readings;
          const legendPr = _readingForLegendTab(src, this._markerPollutantOverride);
          if (legendPr) {
            pr = legendPr;
            if (!_skipLegendExport && isSel) this._selectedPollutantKey = legendPr.key;
            if (!_skipLegendExport && isSel) this._selectedPollutantValue = parseFloat(legendPr.value);
          } else {
            const lbl = _LEGEND_TAB_LABEL[this._markerPollutantOverride] || this._markerPollutantOverride.toUpperCase();
            pr = { key: lbl, value: "\u2014", color: "#666666" };
            if (!_skipLegendExport && isSel) this._selectedPollutantKey = null;
            if (!_skipLegendExport && isSel) this._selectedPollutantValue = null;
          }
        }

        // No data for this sensor at the current scrub time — skip drawing
        if (!pr) { return; }

        const isOutlier = f.outlier || (pr && pr.outlier);
        const label = ((f.name && f.name.length && String(f.name) !== String(f.id)) ? f.name : f.id) + (isOutlier ? " (Outlier)" : "");

        ctx.save();
        const isPurpleAir = !!f.purpleair;
        if (isPurpleAir) {
          // Fade PurpleAir dots when a non-PM2.5 pollutant is active (PA sensors report PM2.5)
          const paFadedForPollutant = !isSel && this._paFieldPollutant != null && this._paFieldPollutant !== "pm25";
          // Outlier PurpleAir sensors still render (grey dot) so user can investigate
          // ── Per-sensor staleness fade matching trail duration ──
          let staleAlpha = 1.0;
          const _refMs = this.getPlaybackTimeMs() || this._dataNowMs();
          const _sensorMs = (pr && pr.timeMs) || (f.last_seen ? f.last_seen * 1000 : null);
          if (!isSel && _sensorMs) {
            const PA_FADE_MS = 45 * 60 * 1000;
            const PA_FADE_TAIL = 0.20;
            const ageMs = _refMs - _sensorMs;
            if (ageMs >= PA_FADE_MS) { ctx.restore(); return; }
            const fadeStart = PA_FADE_MS * (1.0 - PA_FADE_TAIL);
            if (ageMs > fadeStart) {
              const u = (ageMs - fadeStart) / (PA_FADE_MS - fadeStart);
              staleAlpha = (1 - u) * (1 - u);
            }
          }
          if (paFadedForPollutant) staleAlpha *= 0.3;
          const dotR = isSel ? 8 : 6;
          const dotColor = paFadedForPollutant ? dimHex(safeHex((pr && pr.color) || color), 0.65) : safeHex((pr && pr.color) || color);
          if (isSel) {
            ctx.beginPath();
            ctx.fillStyle = "rgba(56, 140, 220, 0.38)";
            ctx.arc(sp.x, sp.y, dotR + 4, 0, Math.PI*2);
            ctx.fill();
          }
          ctx.beginPath();
          if (!isSel) {
            const darkened = darkenHex(dotColor, 0.85);
            ctx.fillStyle = hexToRgba(darkened, 0.45 * staleAlpha);
          } else {
            ctx.fillStyle = dotColor;
          }
          ctx.arc(sp.x, sp.y, dotR, 0, Math.PI*2);
          ctx.fill();
          ctx.strokeStyle = isSel ? "#5bb8f5" : darkenHex(dotColor, 0.7);
          ctx.globalAlpha = (isSel ? 1 : 0.5) * staleAlpha;
          ctx.lineWidth = isSel ? 1.8 : 1.2;
          ctx.stroke();
        } else {
          const _fHalo   = _isLite ? 10 : 15;
          const _fCircle = _isLite ?  8 : 12;
          const _fEmoji  = _isLite ? 10 : 15;
          if (isSel) {
            ctx.beginPath();
            ctx.fillStyle = "rgba(56, 140, 220, 0.38)";
            ctx.arc(sp.x, sp.y, _fHalo, 0, Math.PI*2);
            ctx.fill();
          }
          ctx.beginPath();
          ctx.fillStyle = "rgba(16, 20, 28, 0.68)";
          ctx.arc(sp.x, sp.y, _fCircle, 0, Math.PI*2);
          ctx.fill();
          ctx.strokeStyle = isSel ? "#5bb8f5" : safeHex((pr && pr.color) || color);
          ctx.lineWidth = isSel ? 2.4 : 2.0;
          ctx.stroke();

          const fixedEmojiC = getEmojiCanvas(emoji, _fEmoji);
          ctx.drawImage(fixedEmojiC, sp.x - _fEmoji/2, sp.y - _fEmoji/2, _fEmoji, _fEmoji);
        }

        const showLabel = isPurpleAir ? this.showPublicLabels : this.showFixedLabels;
        const isHov = !isPurpleAir && (this._hoveredId === key);
        if (showLabel || isSel || isHov || String(f.id) === "Home") {
          const labelFont = "600 12px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
          const line1 = label;
          const line2Key = pr.key ? String(pr.key) : "";
          const line2Val = formatTagValue(pr.value);
          const m1w = measureTextCached(line1, labelFont);
          const m2aw = measureTextCached(line2Key ? `${line2Key} ` : "", labelFont);
          const m2bw = measureTextCached(line2Val, labelFont);
          const padX = 8;
          const bw = Math.max(m1w, (m2aw + m2bw)) + padX*2;
          const bh = (line2Key || line2Val) ? 30 : 18;
          const bx = sp.x - bw/2;
          const by = sp.y + 18;
          const _markerColor = safeHex((pr && pr.color) || color);
          const markerColor = isOutlier ? outlierHex(_markerColor) : _markerColor;
          if (isOutlier) ctx.globalAlpha = 0.5;
          ctx.fillStyle = "rgba(16, 20, 28, 0.82)";
          ctx.strokeStyle = markerColor;
          ctx.lineWidth = 1.8;
          roundRect(ctx, bx, by, bw, bh, 9);
          ctx.fill();
          ctx.stroke();
          ctx.font = labelFont;
          ctx.fillStyle = "#e8eef7";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          const padY = 4;
          const lineH = (bh - padY * 2) / ((line2Key || line2Val) ? 2 : 1);
          const y1 = by + padY + lineH * 0.5;
          const y2 = by + padY + lineH * 1.5;
          ctx.fillText(line1, sp.x, y1);
          if (line2Key || line2Val) {
            const x0 = sp.x - (m2aw + m2bw) / 2;
            ctx.fillStyle = "rgba(232,238,247,0.70)";
            ctx.fillText(line2Key ? `${line2Key} ` : "", x0 + m2aw / 2, y2);
            ctx.fillStyle = isOutlier ? markerColor : (pr.color || "#ffffff");
            ctx.fillText(line2Val, x0 + m2aw + m2bw / 2, y2);
          }
        }
        ctx.restore();
      };

      // First pass: PurpleAir (public)
      // (PA scalar field is rendered below, on PA field canvas — see _compositePaFieldOnTiles)
      if (this.showPublic) {
        for (const f of fixed) {
          if (f.purpleair) renderPbFixedMarker(f);
        }
      }
      // Second pass: others (fixed)
      if (this.showFixed) {
        for (const f of fixed) {
          if (!f.purpleair) renderPbFixedMarker(f);
        }
      }
    }

    // Mobile emoji markers
    const nowMs = (opts && typeof opts.nowMs === "number" && isFinite(opts.nowMs)) ? opts.nowMs : performance.now();
    if (this.traceMode || this.playbackMode) {
      ctx.font = "22px Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
    }
    const topMobileId = (() => {
      // Priority: actively dragged/inertial marker, then selected marker.
      if (this._pbDrag && this._pbDrag.id != null) return String(this._pbDrag.id);
      if (this._pbInertia2d && this._pbInertia2d.id != null) return String(this._pbInertia2d.id);
      if (selectedId != null) return String(selectedId);
      return null;
    })();

    const drawMobileMarker = (m) => {
      const pose = this._mobilePoseForRender(m, nowMs);
      let lat = pose.lat;
      let lon = pose.lon;
      let angle = pose.angle;
      let flipX = pose.flipX;
      let speedMps = pose.speedMps;
      const opacity = (typeof pose.opacity === "number" && isFinite(pose.opacity)) ? pose.opacity : 1;
      if (!m._key) m._key = keyFor("mobile", m.id);
      const key = m._key;
      const isSel = (this.selectedId === key);
      const debug = !!this._pbDebugPath;
      // In playback mode, show ghosted sensors if they have trail data (they were active in the past).
      // In live mode, hide ghosted sensors unless Debug/Selected.
      const hasPlaybackData = this.playbackMode && this._playbackPtsById.has(String(m.id));
      if (!!m.ghosted && !debug && !isSel && !hasPlaybackData) return;
      // In playback mode, ignore live parked state — vehicle was active at the playback time
      const isParked = hasPlaybackData ? false : !!m.parked;
      const dimmed = (!debug && !isSel && isParked);
      if (!isFinite(lat) || !isFinite(lon)) return;
      const wpt = latLonToWorld(lat, lon, this.zoom);
      const sp = worldToScreenFast(wpt.x, wpt.y);
      if (sp.x < -50 || sp.y < -50 || sp.x > w+50 || sp.y > h+50) return;

      const held = !!pose.held;
      const id = (m && m.id != null) ? String(m.id) : "";

      const emoji = m.emoji || "🚌";
      const label = (m.name && m.name.length && String(m.name) !== String(m.id)) ? m.name : m.id;
      const color0 = safeHex(m.ci);
      const color = isParked ? dimHex(color0, 0.65) : color0;
      // Base reading: worst AQI from the *full* sensor readings snapshot.
      // Important: trail points often carry only a subset of pollutants (commonly ozone-only),
      // so in DVR live-follow that subset must not override the actual current readings.
      let pr = primaryReadingForSensor(m);
      if (this.playbackMode && pose && pose.reading) {
        const prHist = pose.reading;
        // When in historical mode (viewing past days), always use historical trail reading.
        // Only compare with live sensor readings when viewing today's live data.
        if (this._historicalMode) {
          pr = prHist;
        } else {
          // Only blend with live readings when the playhead is actually at the trail end.
          // _playbackLiveFollow means "will eventually reach the end", not "is there now";
          // using it here caused the marker to show the current live value (e.g. PM10 394)
          // when the playhead was still minutes behind the end on initial load.
          const followingLive = this.isPlaybackAtEnd(200);
          if (followingLive) {
            const aNow = (pr && pr.aqi != null) ? Number(pr.aqi) : valueToAqi(pr?.key, pr?.value);
            const aHist = (prHist && prHist.aqi != null) ? Number(prHist.aqi) : valueToAqi(prHist?.key, prHist?.value);
            const aNowF = (aNow != null && isFinite(Number(aNow))) ? Number(aNow) : -1;
            const aHistF = (aHist != null && isFinite(Number(aHist))) ? Number(aHist) : -1;
            // Choose the worse (higher AQI). If either is missing, keep the one that exists.
            if (!pr || !pr.key) pr = prHist;
            else if (prHist && prHist.key && aHistF > aNowF) pr = prHist;
          } else {
            // While scrubbing history, show the per-point reading (historical).
            pr = prHist;
          }
        }
      } else if (this.playbackMode && !this.isPlaybackAtEnd(200) && !this._playbackPtsById.has(String(m.id))) {
        // Sensor has no playback trail data (e.g. parked at depot) — show "--" instead of frozen live value
        pr = { key: "", value: "--", color: "#666666" };
      }
      // Expose the selected sensor's displayed pollutant key for legend sync
      if (!_skipLegendExport) {
        if (isSel && pr && pr.key) this._selectedPollutantKey = pr.key;
        if (isSel && pr && pr.key) this._selectedNaturalPollutantKey = pr.key;
        if (isSel && pr && pr.key) this._selectedPollutantValue = parseFloat(pr.value);
      }

      // Legend pollutant override: show the legend's chosen pollutant on ALL mobile markers
      // In playback mode, prefer trail-point readings (historical) over live m.readings
      if (this._markerPollutantOverride != null) {
        const src = (this.playbackMode && pose && pose.readings) ? pose.readings : m.readings;
        const legendPr = _readingForLegendTab(src, this._markerPollutantOverride);
        if (legendPr) {
          pr = legendPr;
          if (!_skipLegendExport && isSel) this._selectedPollutantKey = legendPr.key;
          if (!_skipLegendExport && isSel) this._selectedPollutantValue = parseFloat(legendPr.value);
        } else {
          const lbl = _LEGEND_TAB_LABEL[this._markerPollutantOverride] || this._markerPollutantOverride.toUpperCase();
          pr = { key: lbl, value: "\u2014", color: "#666666" };
          if (!_skipLegendExport && isSel) this._selectedPollutantKey = null;
          if (!_skipLegendExport && isSel) this._selectedPollutantValue = null;
        }
      }

      const prColor = isParked ? dimHex(pr.color || "#ffffff", 0.65) : (pr.color || "#ffffff");
      const colorUse = dimmed ? desatHex(color, 0.25) : color;
      const prColorUse = dimmed ? desatHex(prColor, 0.25) : prColor;

      ctx.save();
      const baseAlpha = clamp(opacity, 0, 1);
      if (baseAlpha < 1) ctx.globalAlpha = ctx.globalAlpha * baseAlpha;
      if (dimmed) {
        ctx.globalAlpha = ctx.globalAlpha * 0.5;
        // NOTE: ctx.filter is expensive on iPad - we already desaturated colors above
      }

      const liftScale = (this.playbackMode && held) ? 1.16 : 1.0;
      const liftY = (this.playbackMode && held) ? -8 : 0;
      const spx = sp.x;
      const spy = sp.y + liftY;

      // Marker sizes: lite mode (embedded widget) vs normal
      const _mHalo   = _isLite ? 11 : 16;
      const _mCircle = _isLite ?  9 : 13;
      const _mEmoji  = _isLite ? 11 : 16;

      // halo
      ctx.beginPath();
      if (this.selectedId === key) {
        ctx.fillStyle = "rgba(56, 140, 220, 0.38)";
        ctx.arc(spx, spy, _mHalo * liftScale, 0, Math.PI*2);
        ctx.fill();
        ctx.beginPath();
      }
      ctx.fillStyle = "rgba(16, 20, 28, 0.68)";
      ctx.arc(spx, spy, _mCircle * liftScale, 0, Math.PI*2);
      ctx.fill();
      // Border matches AQI color (selected gets brighter ring)
      ctx.strokeStyle = (this.selectedId === key) ? "#5bb8f5" : safeHex(prColorUse);
      ctx.lineWidth = (this.selectedId === key) ? 2.8 : 2.2;
      ctx.stroke();

      // emoji (pre-rendered to offscreen canvas; drawImage is ~10x faster than
      // fillText with color-emoji fonts on iOS Safari)
      const emojiC = getEmojiCanvas(emoji, _mEmoji);
      const emojiHalf = _mEmoji / 2;
      ctx.save();
      if (this.traceMode || this.playbackMode) {
        ctx.translate(spx, spy);
        if (liftScale !== 1.0) ctx.scale(liftScale, liftScale);
        if (flipX) ctx.scale(-1, 1);
        ctx.rotate(angle);
        ctx.drawImage(emojiC, -emojiHalf, -emojiHalf, _mEmoji, _mEmoji);
      } else {
        ctx.drawImage(emojiC, spx - emojiHalf, spy - emojiHalf, _mEmoji, _mEmoji);
      }
      ctx.restore();

      // Trace-mode speed indicator (buses only): show reproduced playback speed.
      // TODO: also for trax.
      if ((this.traceMode || this.playbackMode) && this.showMobileLabels) {
        const sid = (m && m.id != null) ? String(m.id).toUpperCase() : "";
        const isBus = (emoji === "🚍") || sid.startsWith("BUS");
        if (isBus) {
          const mph = Math.max(0, Math.round((isFinite(speedMps) ? speedMps : 0) * 2.236936));
          const txt = `${mph} mph`;
          ctx.save();
          const speedFont = "10px -apple-system, system-ui, sans-serif";
          ctx.font = speedFont;
          const tw = measureTextCached(txt, speedFont);
          const padX = 6;
          const bw = tw + padX * 2;
          const bh = 14;
          const bx = spx - bw / 2;
          const by = spy - 32;
          ctx.fillStyle = "rgba(16, 20, 28, 0.72)";
          ctx.strokeStyle = "rgba(232,238,247,0.22)";
          ctx.lineWidth = 1.0;
          roundRect(ctx, bx, by, bw, bh, 7);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = "rgba(232,238,247,0.90)";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(txt, spx, by + bh / 2);
          ctx.restore();
        }
      }

      // tiny label pill (show for selected, hovered, or when labels toggle is on)
      const isHov = (this._hoveredId === key);
      const shouldShowLabel = this.showMobileLabels || isSel || isHov;
      if (shouldShowLabel) {
        ctx.save();
        // Reset transform and alpha for label drawing
        ctx.globalAlpha = 1.0;
        const txt1 = label || id || "?";
        const txt2Key = pr.key ? String(pr.key) : "";
        const txt2Val = formatTagValue(pr.value);
        const mobileLabelFont = "600 12px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
        const m1w = measureTextCached(txt1, mobileLabelFont);
        const m2aw = measureTextCached(txt2Key ? `${txt2Key} ` : "", mobileLabelFont);
        const m2bw = measureTextCached(txt2Val, mobileLabelFont);
        const padX = 8;
        const bw = Math.max(m1w, (m2aw + m2bw)) + padX*2;
        const bh = (txt2Key || txt2Val) ? 30 : 18;
        const bx = spx - bw/2;
        const by = spy + 18;
        ctx.fillStyle = "rgba(16, 20, 28, 0.82)";
        ctx.strokeStyle = safeHex(prColorUse || colorUse);
        ctx.lineWidth = 1.8;
        roundRect(ctx, bx, by, bw, bh, 9);
        ctx.fill();
        ctx.stroke();
        ctx.font = mobileLabelFont;
        ctx.fillStyle = "#e8eef7";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const padY = 4;
        const lineH = (bh - padY * 2) / ((txt2Key || txt2Val) ? 2 : 1);
        const y1 = by + padY + lineH * 0.5;
        const y2 = by + padY + lineH * 1.5;
        ctx.fillText(txt1, spx, y1);
        if (txt2Key || txt2Val) {
          const x0 = spx - (m2aw + m2bw) / 2;
          ctx.fillStyle = "rgba(232,238,247,0.70)";
          ctx.fillText(txt2Key ? `${txt2Key} ` : "", x0 + m2aw / 2, y2);
          ctx.fillStyle = prColorUse;
          ctx.fillText(txt2Val, x0 + m2aw + m2bw / 2, y2);
        }
        ctx.restore();
      }
      ctx.restore();
    };

    // ── Wind vector debug overlay ─────────────────────────────────────────
    if (this._windSnapshots && window._fieldDebug?.showWind) {
      const _playbackActive = this.playbackMode && _framePbTimeMs != null && isFinite(_framePbTimeMs);
      const wfData = this._windFieldForTime(_framePbTimeMs, _playbackActive);
      if (wfData) {
        const _wCenter = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
        ctx.save();
        ctx.strokeStyle = "rgba(80,180,255,0.6)";
        ctx.fillStyle = "rgba(80,180,255,0.6)";
        ctx.lineWidth = 1.2;
        const arrowScale = window._fieldDebug.windArrowScale || 6;

        const _drawArrow = (sx, sy, u, v) => {
          const speed = Math.sqrt(u * u + v * v);
          if (speed < 0.3) return;
          const len = Math.min(speed * arrowScale, 30);
          const dx = (u / speed) * len;
          const dy = -(v / speed) * len;
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(sx + dx, sy + dy);
          ctx.stroke();
          const headLen = Math.min(4, len * 0.35);
          const angle = Math.atan2(dy, dx);
          ctx.beginPath();
          ctx.moveTo(sx + dx, sy + dy);
          ctx.lineTo(sx + dx - headLen * Math.cos(angle - 0.5), sy + dy - headLen * Math.sin(angle - 0.5));
          ctx.lineTo(sx + dx - headLen * Math.cos(angle + 0.5), sy + dy - headLen * Math.sin(angle + 0.5));
          ctx.closePath();
          ctx.fill();
        };

        if (wfData.gw != null && wfData.uGrid) {
          // Grid format — derive arrow positions from cell centers
          const gw2 = wfData.gw, gh2 = wfData.gh, b = wfData.bounds;
          const dLon = (b.lonMax - b.lonMin) / gw2;
          const dLat = (b.latMax - b.latMin) / gh2;
          for (let iy = 0; iy < gh2; iy++) {
            const lat = b.latMin + (iy + 0.5) * dLat;
            for (let ix = 0; ix < gw2; ix++) {
              const lon = b.lonMin + (ix + 0.5) * dLon;
              const idx = iy * gw2 + ix;
              const wpt = latLonToWorld(lat, lon, this.zoom);
              const sx = wpt.x - _wCenter.x + w / 2;
              const sy = wpt.y - _wCenter.y + h / 2;
              if (sx < -20 || sx > w + 20 || sy < -20 || sy > h + 20) continue;
              _drawArrow(sx, sy, wfData.uGrid[idx] || 0, wfData.vGrid[idx] || 0);
            }
          }
        } else if (Array.isArray(wfData) && wfData.length > 0) {
          // Legacy point array
          for (let i = 0; i < wfData.length; i++) {
            const wp = wfData[i];
            const wpt = latLonToWorld(wp.lat, wp.lon, this.zoom);
            const sx = wpt.x - _wCenter.x + w / 2;
            const sy = wpt.y - _wCenter.y + h / 2;
            if (sx < -20 || sx > w + 20 || sy < -20 || sy > h + 20) continue;
            _drawArrow(sx, sy, wp.u || 0, wp.v || 0);
          }
        }
        ctx.restore();
      }
    }

    // Draw mobiles in two passes so the interacted/selected marker is on top.
    if (this.showMobile) {
      for (const m of mobiles) {
        if (topMobileId && m && m.id != null && String(m.id) === String(topMobileId)) continue;
        drawMobileMarker(m);
      }
      if (topMobileId) {
        const top = mobiles.find(mm => (mm && mm.id != null && String(mm.id) === String(topMobileId))) || null;
        if (top) drawMobileMarker(top);
      }
    }

    // Debug: render virtual mobile sensors as ghost dots
    if (window._fieldDebug?.showVirtual && this._virtualMobileSensors?.length > 0) {
      // vs.sx/sy are in overfetch buffer space; shift to viewport space.
      const _bufW = this._paFieldBufW || (this._cssW || 1);
      const _bufH = this._paFieldBufH || (this._cssH || 1);
      const _vw = this._cssW || 1;
      const _vh = this._cssH || 1;
      const _offX = (_bufW - _vw) / 2;
      const _offY = (_bufH - _vh) / 2;
      ctx.save();
      for (const vs of this._virtualMobileSensors) {
        const _ghostAqiKey = _LEGEND_TAB_AQI_KEY[this._paFieldPollutant || "pm25"] || "pm2.5";
        const _ghostAqi = valueToAqi(_ghostAqiKey, vs.value);
        const rgb = _aqiToRgb(_ghostAqi != null && isFinite(_ghostAqi) ? _ghostAqi : 0);
        const tint = 0.35;
        const cr = Math.round(128 * (1 - tint) + rgb[0] * tint);
        const cg = Math.round(128 * (1 - tint) + rgb[1] * tint);
        const cb = Math.round(128 * (1 - tint) + rgb[2] * tint);
        ctx.globalAlpha = 0.5 * (vs.weightMultiplier || 0.01);
        ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
        ctx.beginPath();
        ctx.arc(vs.sx - _offX, vs.sy - _offY, 4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }
}
// Expose on window for cross-script access (class declarations don't auto-create window properties)
window.MapView = MapView;
