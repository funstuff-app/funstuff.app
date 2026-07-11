(function (root, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else {
    root.FieldSensors = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Globals from earlier-loaded scripts (aqi.js, colors.js, projections.js,
  // data_utils.js, format_utils.js) are resolved lazily at call time — never
  // at module factory time (node tests have no browser globals).
  var g = (typeof window !== "undefined") ? window : globalThis;

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
  /**
   * Per-pollutant field kernel spread. PM2.5/PM10/CO are primary pollutants
   * emitted right at the source (tailpipes, roads) — a tight, peaky kernel
   * reads as a real plume, and PurpleAir gives them dense coverage anyway.
   * Ozone is secondary (forms photochemically over hours, often locally
   * SUPPRESSED near fresh NOx by titration) and has only sparse fixed-DAQ
   * coverage (no PurpleAir), so the same tight kernel renders it as isolated
   * bullseyes around single monitors instead of the smooth, regional field
   * ozone actually has. NO2 sits between the two: still road-primary, but
   * fixed-only coverage like ozone, so it gets a smaller bump.
   * sigmaMult widens the Gaussian falloff (bandwidth); cutMult widens the
   * radius a sensor's influence reaches before being excluded entirely —
   * both need to move together, or a wider falloff just fades to nothing
   * faster inside the same unchanged cutoff radius.
   */
  /**
   * neighborBlend: fraction of each station's FIELD input replaced by the
   * distance-weighted consensus of its neighbor stations before
   * interpolation (0 = off, field input is the raw reading). For regional
   * gases the monitors sample one shared airmass: station-to-station
   * disagreement is calibration scatter plus update cadence (MTMET updates
   * every few minutes, the DAQ/AirNow stations hourly on the hour), so a
   * single station's fresher or offset reading must NUDGE the field, never
   * restructure it into a local zone. Marker labels are untouched — the
   * newest raw reading still wins on the sensor itself. Trends supported by
   * SEVERAL stations survive the blend because their neighbors agree.
   */
  /**
   * gradient: true (ozone) = BASELINE + RESIDUAL surface (see
   * _gradientGrid). The wide kernel (sigmaMult) interpolates the smooth
   * regional level; each station then adds back its own deviation from
   * that level with a flat-top falloff that equals 1 AT the station, so a
   * monitor reading into the orange band renders its true band exactly at
   * its location (normalized interpolations shave the peak wherever
   * neighbors leak in — a reading 1 ppb into the band always came out
   * yellow) and the glow's reach scales with how far the reading sits
   * above the regional level, gliding back to baseline with no edge.
   * residualFrac sets the residual falloff radius as a fraction of the
   * cutoff. Coverage (covSigmaMult/coverageRef) only bounds WHERE the
   * field exists, fading softly past the network.
   */
  const _LEGEND_TAB_FIELD_SPREAD = {
    pm25: { sigmaMult: 1,    cutMult: 1,   neighborBlend: 0 },
    pm10: { sigmaMult: 1,    cutMult: 1,   neighborBlend: 0 },
    // Gases (o3, no2, co) mix regionally instead of clustering like
    // particulates, so they render through the gradient model: regional
    // baseline + elevated-only station residuals, coverage-bounded at the
    // network edge. Each gas keeps its OWN entry so its parameters tune
    // independently.
    o3:   { gradient: true, sigmaMult: 2.4, cutMult: 1.8, covSigmaMult: 1.4, coverageRef: 0.15, residualFrac: 0.05, neighborBlend: 0 },
    no2:  { gradient: true, sigmaMult: 2.4, cutMult: 1.8, covSigmaMult: 1.4, coverageRef: 0.15, residualFrac: 0.05, neighborBlend: 0 },
    co:   { gradient: true, sigmaMult: 2.4, cutMult: 1.8, covSigmaMult: 1.4, coverageRef: 0.15, residualFrac: 0.05, neighborBlend: 0 },
  };
  /** Pollutants composited in "no selection" max-mode field (one kernel each). */
  // Max-mode field groups. Particulates (PM2.5 + PM10) form ONE field: same
  // unit/scale and fixed sensors report both, so they blend smoothly instead of
  // competing cell-by-cell (which left black rings where sparse PM10 won the AQI
  // max at near-zero weight). Gases stay separate (different sensor sets), which
  // preserves "PA can't suppress ozone". `incl` drives sensor inclusion (pm25 ->
  // PurpleAir + nearby fixed); `tabs` are max'd per sensor in AQI space.
  const _MAX_MODE_GROUPS = [
    { incl: "pm25", tabs: ["pm25", "pm10"] },
    { incl: "o3",   tabs: ["o3"] },
    { incl: "no2",  tabs: ["no2"] },
    { incl: "co",   tabs: ["co"] },
  ];
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
        const aqi = g.valueToAqi(_LEGEND_TAB_AQI_KEY[legendTab] || "pm2.5", r.value);
        // Use the server's precomputed discrete band color (r.ci) for markers.
        // _aqiToRgb is a continuous ramp for the heatmap field; its intermediate
        // colors don't align with pollutant-specific band boundaries.
        const color = g.safeHex(r.ci);
        return { key: rk, value: r.value, color, aqi };
      }
    }
    return null;
  }

  function _collectPaFieldSensors(fixed, playbackTimeMs, centerW, zoom, cssW, cssH, pollutantTab, bufW, bufH, refNowMs, maxTabs) {
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

    const sensors = [];
    const _fixedSlot = new Map();  // sensors[] indices of non-PA fixed (stack-merge candidates)
    let fingerprint = "";
    for (const f of fixed) {
      if (!f) continue;
      if (f.outlier) continue;
      const lat = Number(f.lat);
      const lon = Number(f.lon);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      if (lat < _UT_MIN_LAT || lat > _UT_MAX_LAT || lon < _UT_MIN_LON || lon > _UT_MAX_LON) continue;

      if (isPm25) {
        // PM2.5 mode: PurpleAir + ALL non-PA fixed stations. An earlier
        // near-PA gate dropped fixed stations with no PurpleAir neighbor,
        // so a DAQ station with a real PM2.5 reading painted NO field —
        // everywhere on installs without a PurpleAir key, and in the west
        // desert on prod. Fixed stations feed every other pollutant's
        // field unconditionally; PM2.5 is no different.
      } else {
        // Non-PM2.5 mode: only non-PurpleAir fixed sensors (ghost markers)
        if (f.purpleair) continue;
      }

      // PurpleAir staleness: skip fully stale, decay weight in tail
      let staleWeight = 1.0;
      if (f.purpleair && refNowMs) {
        const sMs = f.last_seen ? f.last_seen * 1000 : null;
        // No last_seen at all (e.g. seeded from a snapshot while the PurpleAir
        // API was failing) — age is unknown, so it must not render as current.
        if (!sMs) continue;
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

      const interp = g.interpolateFixedReadingsAtTime(f, playbackTimeMs);
      let value = NaN;
      let maxAqi = null;
      let tMs = null;  // reading time of the value used — drives overlap recency
      if (maxTabs && maxTabs.length) {
        // Sensor contributes its WORST pollutant (highest AQI) across the group's
        // tabs — ['pm25','pm10'] merges both particulates into one field.
        for (const tab of maxTabs) {
          for (const rk of _LEGEND_TAB_READING_KEYS[tab]) {
            const r = interp && interp[rk];
            if (r && r.value != null) {
              if (!r.outlier) {
                const v = Number(r.value);
                if (isFinite(v) && v >= 0) {
                  const a = g.valueToAqi(_LEGEND_TAB_AQI_KEY[tab], v);
                  if (a != null && isFinite(a) && (maxAqi == null || a > maxAqi)) { maxAqi = a; value = v; tMs = r.timeMs; }
                }
              }
              break;
            }
          }
        }
        if (maxAqi == null) continue;
      } else {
        let readingOutlier = false;
        for (const rk of readingKeys) {
          const r = interp && interp[rk];
          if (r && r.value != null) { value = Number(r.value); readingOutlier = !!r.outlier; tMs = r.timeMs; break; }
        }
        if (!isFinite(value) || value < 0) continue;
        if (readingOutlier) continue;
      }

      const wp = g.latLonToWorld(lat, lon, zoom);
      const cand = {
        sx: wp.x - centerW.x + projW / 2,
        sy: wp.y - centerW.y + projH / 2,
        value,
        aqi: maxAqi,
        weightMultiplier: (f.purpleair ? 1 : _PA_FIELD_FIXED_WEIGHT_MULTIPLIER) * staleWeight,
      };
      if (f.purpleair) {
        // PurpleAir are server-thinned (~1 per 500 m) so they don't overlap.
        sensors.push(cand);
      } else {
        _fixedSlot.set(sensors.length, true);  // stack-merge candidate
        sensors.push(cand);
      }
    }

    // STACKED fixed stations (co-located within ~600 m, e.g. Viewmont +
    // Bountiful, or QUURB + MTMET sharing a DAQ site): conflicting readings
    // almost on top of each other force the exactness layer to honor both,
    // carving steep gradients and shadow rings between their halos. The
    // HIGHEST current reading wins the stack — worst-wins, the same contract
    // as max mode. Field input only; every marker still renders.
    if (_fixedSlot.size > 1) {
      const _sp0 = g.latLonToWorld(40.7, -111.9, zoom);
      const _sp1 = g.latLonToWorld(40.7, -111.894, zoom);
      const _sdx = _sp1.x - _sp0.x;
      const stackRSq = _sdx * _sdx;
      const idxs = [..._fixedSlot.keys()];
      const dropped = new Set();
      const aqiOf = (s) => (s.aqi != null && isFinite(s.aqi)) ? s.aqi : (g.valueToAqi(aqiKey, s.value) ?? 0);
      for (let a = 0; a < idxs.length; a++) {
        if (dropped.has(idxs[a])) continue;
        for (let b = a + 1; b < idxs.length; b++) {
          if (dropped.has(idxs[b])) continue;
          const sa = sensors[idxs[a]], sb = sensors[idxs[b]];
          const dx = sa.sx - sb.sx, dy = sa.sy - sb.sy;
          if (dx * dx + dy * dy > stackRSq) continue;
          dropped.add(aqiOf(sa) >= aqiOf(sb) ? idxs[b] : idxs[a]);
          if (dropped.has(idxs[a])) break;
        }
      }
      if (dropped.size) {
        const kept = [];
        for (let i = 0; i < sensors.length; i++) if (!dropped.has(i)) kept.push(sensors[i]);
        sensors.length = 0;
        sensors.push(...kept);
      }
    }

    // Fingerprint built AFTER dedup so it reflects only the kept sensors.
    // ALWAYS quantized at 4 AQI points, never at color-category granularity:
    // the field renders from continuous values, so a category-based
    // fingerprint let a sensor drift a whole band's width (15+ ppb of
    // ozone) without ever invalidating the cached field canvas — the field
    // froze until some unrelated sensor crossed a band, then "randomly"
    // caught up.
    for (const s of sensors) {
      fingerprint += (maxTabs && maxTabs.length) ? ("m" + Math.round(s.aqi / 4) + ",")
        : ("q" + Math.round((g.valueToAqi(aqiKey, s.value) ?? 0) / 4) + ",");
    }

    return { sensors, fingerprint };
  }

  /**
   * Collect virtual PA sensors from mobile trail GPS points.
   * Each trail point with a reading for the selected pollutant becomes a transient sensor
   * that decays over the same time window as the trail fade.
   */
  function _collectVirtualMobileSensors(mobiles, playbackTimeMs, isPlayback, centerW, zoom, cssW, cssH, refNowMs, pollutantTab, bufW, bufH, maxTabs) {
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

    const ws = g.worldSizeForZoom(zoom);

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
          tMs = (typeof p.t === "string") ? g.parseUtcMs(p.t) : null;
          try { p._tMs = tMs; } catch {}
        }
        if (tMs == null || !isFinite(tMs)) continue;

        const ageMs = refNowMs - tMs;
        if (ageMs < 0) continue;           // future point in playback
        if (ageMs >= FADE_TIME_MS) break;   // past fade window (older points only get older)

        // Extract reading for selected pollutant — skip if absent.
        // Derived values are cached on the (immutable) trail point: this
        // collector runs once for the rendered field AND once per pollutant in
        // the legend's per-pollutant max scan, so without the cache every trail
        // point gets re-parsed ~6x per recompute cycle.
        let rawVal = undefined;
        let trailMaxAqi = null;
        const rd = p.readings;
        if (rd && maxTabs && maxTabs.length) {
          // Worst pollutant (highest AQI) across the group's tabs at this point.
          // Cache per group key so each group memoizes once on the trail point.
          const _gk = maxTabs.join(",");
          const _gc = p._grpMax ? p._grpMax[_gk] : undefined;
          if (_gc !== undefined) {
            trailMaxAqi = _gc ? _gc.aqi : null;
            rawVal = _gc ? _gc.val : null;
          } else {
            for (const tab of maxTabs) {
              for (const rk of _LEGEND_TAB_TRAIL_KEYS[tab]) {
                let rv = rd[rk]?.value ?? rd[rk];
                if (rv != null && typeof rv === "object") rv = rv.value;
                if (rv == null) continue;
                const v = Number(rv);
                if (isFinite(v) && v >= 0) {
                  const a = g.valueToAqi(_LEGEND_TAB_AQI_KEY[tab], v);
                  if (a != null && isFinite(a) && (trailMaxAqi == null || a > trailMaxAqi)) { trailMaxAqi = a; rawVal = v; }
                }
                break;
              }
            }
            try { (p._grpMax || (p._grpMax = {}))[_gk] = (trailMaxAqi == null) ? null : { aqi: trailMaxAqi, val: rawVal }; } catch {}
          }
          if (trailMaxAqi == null) continue;
        } else if (rd) {
          const _tv = p._tabVals;
          if (_tv && pollutantTab in _tv) {
            rawVal = _tv[pollutantTab];
          } else {
            for (const rk of trailKeys) {
              const rv = rd[rk]?.value ?? rd[rk];
              if (rv != null && typeof rv !== "object") { rawVal = rv; break; }
              if (rv != null && typeof rv === "object" && rv.value != null) { rawVal = rv.value; break; }
            }
            try { (p._tabVals || (p._tabVals = {}))[pollutantTab] = rawVal ?? null; } catch {}
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
          const norm = g.latLonToNorm(lat, lon);
          u = norm.u; v = norm.v;
          try { p._u = u; p._v = v; } catch {}
        }
        const wx = u * ws, wy = v * ws;
        const sx = wx - centerW.x + projW / 2;
        const sy = wy - centerW.y + projH / 2;

        sensorMap.set(slotKey, { sx, sy, value: pollVal, aqi: trailMaxAqi, weightMultiplier: _PA_FIELD_FIXED_WEIGHT_MULTIPLIER * decayWeight });
      }
    }

    const sensors = Array.from(sensorMap.values());
    let fingerprint = "";
    // Quantized-value fingerprint — see the fixed-sensor collector's note.
    for (const s of sensors) fingerprint += (maxTabs && maxTabs.length && s.aqi != null) ? ("m" + Math.round(s.aqi / 4) + ",")
      : ("q" + Math.round((g.valueToAqi(aqiKey, s.value) ?? 0) / 4) + ",");
    return { sensors, fingerprint };
  }

  /** Compute the playback time range over which the PA field fingerprint is unchanged.
   *  Scans each sensor's PM2.5 timeline to find the nearest past and future points
   *  where _pm25ColorCat would change. Returns { fromMs, toMs }. */
  function _findFingerprintValidRange(fixed, playbackTimeMs, tabs) {
    // The window in which the DISPLAYED pollutant's field cannot change.
    // MUST inspect the same pollutant series and the same quantization the
    // collector fingerprints with. The original version hardcoded PM2.5
    // color categories no matter what was displayed, so the O3/NO2/CO field
    // was declared "still valid" until some sensor's PM2.5 happened to
    // cross a band — scrubbing showed stale ozone until a random unrelated
    // repaint. tabs defaults to ["pm25"] for legacy callers.
    const tabList = (Array.isArray(tabs) && tabs.length) ? tabs : ["pm25"];
    let nextChangeMs = Infinity;
    let prevChangeMs = -Infinity;

    for (const f of fixed) {
      if (!f) continue;
      const readings = f && f.readings;
      if (!readings) continue;
      for (const tab of tabList) {
        const keys = _LEGEND_TAB_READING_KEYS[tab];
        const aqiKey = _LEGEND_TAB_AQI_KEY[tab] || "pm2.5";
        if (!keys) continue;
        let r = null;
        for (const rk of keys) { const cand = readings[rk]; if (cand) { r = cand; break; } }
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

        // Same 4-AQI quantization as the collector fingerprints.
        const qOf = (v) => Math.round((g.valueToAqi(aqiKey, v) ?? 0) / 4);
        const curQ = qOf(valuesF[idx]);

        // Forward: next sample that changes the quantized value
        for (let i = idx + 1; i < timesMs.length; i++) {
          if (qOf(valuesF[i]) !== curQ) {
            if (timesMs[i] < nextChangeMs) nextChangeMs = timesMs[i];
            break;
          }
        }
        // Backward: when the current quantized segment started
        for (let i = idx - 1; i >= 0; i--) {
          if (qOf(valuesF[i]) !== curQ) {
            if (timesMs[i + 1] > prevChangeMs) prevChangeMs = timesMs[i + 1];
            break;
          }
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

  return {
    _pm25ToRgb,
    _pm25ColorCat,
    _BAND_MIDS,
    _PA_FIELD_NON_PURPLEAIR_PROXIMITY_DEG,
    _PA_FIELD_FIXED_WEIGHT_MULTIPLIER,
    _OVERFETCH,
    _OVERFETCH_MAX_DEVICE_PX,
    _OVERFETCH_MARGIN_EXHAUST,
    _LEGEND_TAB_READING_KEYS,
    _LEGEND_TAB_AQI_KEY,
    _LEGEND_TAB_FIELD_SPREAD,
    _MAX_MODE_GROUPS,
    _LEGEND_TAB_LABEL,
    _LEGEND_TAB_TRAIL_KEYS,
    _readingForLegendTab,
    _collectPaFieldSensors,
    _collectVirtualMobileSensors,
    _findFingerprintValidRange,
    _PM25_SMOOTH_STOPS,
    _pm25ToRgbSmooth,
    _PM25_AQI_BP,
    _pm25ToAqi,
    _AQI_RGB_STOPS,
    _aqiColorCat,
    _aqiToRgb,
  };
});
