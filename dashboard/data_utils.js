function haversineMeters(lat1, lon1, lat2, lon2) {
  // Great-circle distance (meters)
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dp = toRad(lat2 - lat1);
  const dl = toRad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * (Math.sin(dl / 2) ** 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function keyFor(type, id) {
  return `${type}:${id}`;
}

function parseKey(key) {
  if (!key) return null;
  const s = String(key);
  const i = s.indexOf(":");
  if (i === -1) return { type: "mobile", id: s };
  return { type: s.slice(0, i), id: s.slice(i + 1) };
}

function primaryReadingFromPoint(p) {
  const readings = p && p.readings ? p.readings : null;
  if (!readings) return null;
  const w = pickWorstReadingKey(readings);
  return w && w.key && readings[w.key] ? readings[w.key] : null;
}

function primaryReadingKeyedFromPoint(p) {
  const readings = p && p.readings ? p.readings : null;
  if (!readings) return null;
  const w = pickWorstReadingKey(readings);
  if (!w || !w.key || !readings[w.key]) return null;
  const r = readings[w.key];
  return { key: w.key, value: r?.value, color: safeHex(r?.color), aqi: w.aqi };
}

function primaryReadingForSensor(s) {
  const readings = s && s.readings ? s.readings : null;
  if (!readings) return { key: null, value: null, color: "#ffffff" };
  const w = pickWorstReadingKey(readings);
  if (w && w.key && readings[w.key]) {
    // Always trust the actual readings (same source used for trail coloring & details panel).
    // Server primary_key can be stale/mismatched vs readings and causes “ozone wins” labels.
    return { key: w.key, value: readings[w.key].value, color: safeHex(readings[w.key].color), aqi: w.aqi };
  }

  // Fallback: if AQI couldn't be computed, use server hint if present.
  if (s && s.primary_key != null) {
    return { key: s.primary_key, value: s.primary_value, color: safeHex(s.primary_color) };
  }
  return { key: null, value: null, color: "#ffffff" };
}

/**
 * Check if a fixed sensor has time-indexed history data (from AirNow).
 * @param {object} f - fixed sensor object
 * @returns {boolean}
 */
function fixedSensorHasHistoryTimes(f) {
  const readings = f && f.readings;
  if (!readings) return false;
  for (const key of Object.keys(readings)) {
    const r = readings[key];
    if (r && Array.isArray(r.history_times) && r.history_times.length >= 2) {
      return true;
    }
  }
  return false;
}

/**
 * Interpolate fixed sensor readings at a given playback time.
 * Uses history_times arrays to find the appropriate value for each pollutant.
 * 
 * @param {object} f - fixed sensor object with readings that have history_times
 * @param {number} playbackTimeMs - playback time in UTC milliseconds
 * @returns {object} - interpolated readings object in same format as original
 */
function interpolateFixedReadingsAtTime(f, playbackTimeMs) {
  const readings = f && f.readings;
  if (!readings || !isFinite(playbackTimeMs)) return readings;
  
  const result = {};
  
  for (const key of Object.keys(readings)) {
    const r = readings[key];
    if (!r) continue;
    
    // If no history_times, just copy the current value
    if (!Array.isArray(r.history_times) || !Array.isArray(r.history) || r.history_times.length < 2) {
      result[key] = r;
      continue;
    }
    
    const times = r.history_times;
    const values = r.history;
    const colors = r.history_colors || [];

    // Some feeds include null/invalid times (and sometimes null values) as padding.
    // Those break monotonic ordering and make binary search return wrong indices
    // (often yielding a null value), which makes fixed-marker labels show key-only.
    // Build a filtered, monotonic timeline for indexing, but keep original arrays
    // for sparklines.
    const timesMs = [];
    const valuesF = [];
    const colorsF = [];
    const n = Math.min(times.length, values.length);
    for (let i = 0; i < n; i++) {
      const tMs = parseUtcMs(times[i]);
      if (!(tMs != null && isFinite(tMs))) continue;
      const v = values[i];
      if (v == null) continue;
      timesMs.push(tMs);
      valuesF.push(v);
      colorsF.push(colors[i] || r.color || "#cccccc");
    }
    if (timesMs.length < 1) {
      result[key] = r;
      continue;
    }

    // Find the appropriate value for this time (timeline is monotonic)
    const tMin = timesMs[0];
    const tMax = timesMs[timesMs.length - 1];
    
    let idx;
    if (playbackTimeMs <= tMin) {
      idx = 0;
    } else if (playbackTimeMs >= tMax) {
      idx = valuesF.length - 1;
    } else {
      // Binary search for the right interval
      let lo = 0;
      let hi = timesMs.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (timesMs[mid] <= playbackTimeMs) lo = mid;
        else hi = mid - 1;
      }
      idx = lo;
    }
    
    result[key] = {
      value: valuesF[idx],
      color: colorsF[idx] || r.color || "#cccccc",
      // Keep original arrays for sparklines
      history: values,
      history_times: times,
      history_colors: colors,
      scrubbed: r.scrubbed || 0,
    };
  }
  
  return result;
}

/**
 * Get primary reading for a fixed sensor at a specific playback time.
 * Falls back to primaryReadingForSensor if no history_times.
 * 
 * @param {object} f - fixed sensor object
 * @param {number|null} playbackTimeMs - playback time in UTC ms, or null for current
 * @returns {object} - { key, value, color, aqi }
 */
function primaryReadingForFixedAtTime(f, playbackTimeMs) {
  if (playbackTimeMs == null || !fixedSensorHasHistoryTimes(f)) {
    return primaryReadingForSensor(f);
  }
  
  const interpolated = interpolateFixedReadingsAtTime(f, playbackTimeMs);
  const w = pickWorstReadingKey(interpolated);
  if (w && w.key && interpolated[w.key]) {
    return { key: w.key, value: interpolated[w.key].value, color: safeHex(interpolated[w.key].color), aqi: w.aqi };
  }
  return primaryReadingForSensor(f);
}
