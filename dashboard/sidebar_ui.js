function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x+rr, y);
  ctx.arcTo(x+w, y, x+w, y+h, rr);
  ctx.arcTo(x+w, y+h, x, y+h, rr);
  ctx.arcTo(x, y+h, x, y, rr);
  ctx.arcTo(x, y, x+w, y, rr);
  ctx.closePath();
}

function generateItemHTML(item, type, order) {
  const isGhost = !!item.ghosted;
  const isParked = !!item.parked;
  const emoji = item.purpleair ? "🟣" : (item.emoji || (type === "mobile" ? "🚌" : "📍"));
  const nameText = ((item.name && String(item.name) !== String(item.id)) ? item.name : item.id) + (item.outlier ? " (Outlier)" : "");
  
  let pinText = "";
  if (type === "mobile") {
    pinText = item.pinned ? (isParked ? "pinned · parked" : "pinned") : (isParked ? "parked" : "");
  }

  const readings = item.readings || {};
  const keys = Object.keys(readings);
  // Sort by AQI descending so the 3 most concerning pollutants are shown
  keys.sort((a, b) => {
    const aqiA = typeof valueToAqi === "function" ? (valueToAqi(a, readings[a]?.value) ?? -1) : -1;
    const aqiB = typeof valueToAqi === "function" ? (valueToAqi(b, readings[b]?.value) ?? -1) : -1;
    if (aqiB !== aqiA) return aqiB - aqiA;
    // tie-break by preferred display order
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
  const show = keys.slice(0, 3);
  
  let rowsHTML = "";
  rowsHTML += `<div class="row1">`;
  rowsHTML += `<div class="emoji">${emoji}</div>`;
  rowsHTML += `<div class="name">${escapeHtml(nameText)}</div>`;
  rowsHTML += `<div class="pin">${escapeHtml(pinText)}</div>`;
  rowsHTML += `</div>`;
  
  rowsHTML += `<div class="row2">`;
  for (const k of show) {
    const val = readings[k]?.value ?? "—";
    const c = safeHex(readings[k]?.ci != null ? readings[k].ci : readings[k]?.color);
    const outC = isParked ? dimHex(c, 0.65) : c;
    rowsHTML += `<div class="reading">`;
    rowsHTML += `<span class="k">${escapeHtml(k)}</span>`;
    rowsHTML += `<span class="v" style="color:${outC}">${escapeHtml(String(val))}</span>`;
    rowsHTML += `</div>`;
  }
  rowsHTML += `</div>`;
  return rowsHTML;
}

function reconcileList(container, items, type, selectedId, order) {
  const existingMap = new Map();
  let child = container.firstElementChild;
  while (child) {
    if (child.dataset.id) existingMap.set(child.dataset.id, child);
    child = child.nextElementSibling;
  }

  const seenIds = new Set();
  items.forEach(item => {
    // Offline sensors are hidden from the UI.
    if (item && item.ghosted) return;
    const id = item.id;
    seenIds.add(id);
    const k = keyFor(type, id);
    
    let el = existingMap.get(id);
    if (!el) {
      el = document.createElement("div");
      el.dataset.id = id;
      el.addEventListener("click", (e) => {
        const isMobile = (type === "mobile");
        window.__selectSensor(k, { fitTrail: isMobile && !!e.metaKey, fromPanel: true });
      });
      container.appendChild(el);
    } else {
      container.appendChild(el);
    }

    const isSelected = (k === selectedId);
    const className = "item" + (isSelected ? " selected" : "") + (item.parked ? " parked" : "");
    if (el.className !== className) el.className = className;

    const html = generateItemHTML(item, type, order);
    if (el.innerHTML !== html) el.innerHTML = html;
  });

  existingMap.forEach((el, id) => {
    if (!seenIds.has(id)) el.remove();
  });
}

/**
 * Update sidebar reading values during playback without full re-render.
 * This is called from the playback loop to show interpolated values at current playback time.
 */
// Cached DOM element map — avoids ~90 querySelector calls per update.
// Invalidated when sidebar re-renders (see renderLists).
var _sidebarElCache = null;

function _buildSidebarCache() {
  const cache = new Map();
  // Index both mobile and community (public) sensor lists
  for (const listId of ["sensorListMobile", "sensorListPublic"]) {
    const listEl = document.getElementById(listId);
    if (!listEl) continue;
    for (const itemEl of listEl.querySelectorAll("[data-id]")) {
      const id = itemEl.getAttribute("data-id");
      const row2 = itemEl.querySelector(".row2");
      if (!row2) continue;
      const readings = [];
      for (const rEl of row2.querySelectorAll(".reading")) {
        const kEl = rEl.querySelector(".k");
        const vEl = rEl.querySelector(".v");
        if (kEl && vEl) readings.push({ k: kEl.textContent, vEl });
      }
      cache.set(id, { itemEl, readings });
    }
  }
  return cache.size > 0 ? cache : null;
}

function updateSidebarPlaybackValues() {
  const map = window.__map;
  if (!map || !map.playbackMode) return;

  const state = map._historicalMode ? window._historicalState : window.__lastState;
  if (!state || !Array.isArray(state.mobile)) return;

  const t = map.getPlaybackTimeMs();
  if (t == null || !isFinite(t)) return;

  // At the live edge, use live values - don't update readings
  const atEnd = map.isPlaybackAtEnd(100);
  if (atEnd) return;

  // Build or reuse cached DOM references
  if (!_sidebarElCache) _sidebarElCache = _buildSidebarCache();
  if (!_sidebarElCache) return;

  for (const m of state.mobile) {
    if (!m || m.id == null) continue;

    const cached = _sidebarElCache.get(String(m.id));
    if (!cached) continue;

    // Always show sensor - never hide
    if (cached.itemEl.classList.contains("hidden")) {
      cached.itemEl.classList.remove("hidden");
    }

    // Get playback points for this sensor
    const pts = map._playbackPtsById.get(String(m.id));
    if (!pts || !pts.length) continue;

    // Binary search for current point
    let idxHi = 1;
    const tMin = pts[0].tMs;
    const tMax = pts[pts.length - 1].tMs;
    if (t <= tMin) idxHi = 1;
    else if (t >= tMax) idxHi = pts.length - 1;
    else {
      let lo = 1, hi = pts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (pts[mid].tMs >= t) hi = mid;
        else lo = mid + 1;
      }
      idxHi = lo;
    }

    const currentPt = pts[idxHi];
    if (!currentPt || !currentPt.readings) continue;

    // Update the reading values in the DOM using cached element references
    for (const { k, vEl } of cached.readings) {
      const r = currentPt.readings[k];
      if (r && r.value != null) {
        const newVal = String(r.value);
        if (vEl.textContent !== newVal) {
          vEl.textContent = newVal;
        }
        const newColor = safeHex(r.ci);
        if (vEl.style.color !== newColor) {
          vEl.style.color = newColor;
        }
      }
    }
  }

  // ── Update community (PurpleAir / fixed) sensor readings ──
  const fixedArr = Array.isArray(state.fixed) ? state.fixed : [];
  for (const f of fixedArr) {
    if (!f || !f.id) continue;
    const cached = _sidebarElCache.get(String(f.id));
    if (!cached) continue;

    // Use the same interpolation the field uses
    const interp = typeof interpolateFixedReadingsAtTime === "function"
      ? interpolateFixedReadingsAtTime(f, t)
      : null;
    if (!interp) continue;

    for (const { k, vEl } of cached.readings) {
      const r = interp[k];
      if (r && r.value != null) {
        const newVal = String(r.value);
        if (vEl.textContent !== newVal) {
          vEl.textContent = newVal;
        }
        const newColor = safeHex(r.color != null ? r.color : r.ci);
        if (vEl.style.color !== newColor) {
          vEl.style.color = newColor;
        }
      }
    }
  }
}

function renderLists(state, selectedId) {
  _sidebarElCache = null; // Invalidate cached DOM refs — list is about to be rebuilt
  const listMobileEl = document.getElementById("sensorListMobile");
  const listFixedEl = document.getElementById("sensorListFixed");
  const listPublicEl = document.getElementById("sensorListPublic");

  const DOWNTOWN_SLC = { lat: 40.7608, lon: -111.8910 };

  const mobilesRaw = Array.isArray(state.mobile) ? state.mobile : [];
  const fixedRaw = Array.isArray(state.fixed) ? state.fixed : [];

  // Split fixed into non-purpleair (fixed) and purpleair (public)
  const fixedOnly = fixedRaw.filter(f => !f.purpleair);
  const publicOnly = fixedRaw.filter(f => !!f.purpleair);

  // Sorting is based on latest reported lat/lon, not animated marker positions.
  const mobiles = mobilesRaw.slice().sort((a, b) => {
    const la = Number(a?.lat);
    const lb = Number(b?.lat);
    const aOk = isFinite(la);
    const bOk = isFinite(lb);
    if (aOk && bOk) return lb - la; // north -> south
    if (aOk) return -1;
    if (bOk) return 1;
    return String(a?.id || "").localeCompare(String(b?.id || ""));
  });

  const sortByDistance = (arr) => arr
    .map((f) => {
      const lat = Number(f?.lat);
      const lon = Number(f?.lon);
      const d = (isFinite(lat) && isFinite(lon))
        ? haversineMeters(DOWNTOWN_SLC.lat, DOWNTOWN_SLC.lon, lat, lon)
        : Number.POSITIVE_INFINITY;
      return { f, d };
    })
    .sort((a, b) => {
      if (a.d !== b.d) return a.d - b.d; // closest -> farthest
      return String(a.f?.id || "").localeCompare(String(b.f?.id || ""));
    })
    .map((x) => x.f);

  const fixed = sortByDistance(fixedOnly);
  const publicSensors = [...publicOnly].sort((a, b) => {
    const na = String(a.name || a.id || "").toLowerCase();
    const nb = String(b.name || b.id || "").toLowerCase();
    return na.localeCompare(nb);
  });

  // prefer a stable pollutant order like the TUI
  const order = ["PM25", "PM2.5", "PM10", "OZNE", "Ozone"];

  if (listMobileEl) reconcileList(listMobileEl, mobiles, "mobile", selectedId, order);
  if (listFixedEl) reconcileList(listFixedEl, fixed, "fixed", selectedId, order);
  if (listPublicEl) reconcileList(listPublicEl, publicSensors, "fixed", selectedId, order);
}

function renderDetails(state, selectedId) {
  const body = document.getElementById("detailsBody");
  if (!body) return;
  const mobiles = Array.isArray(state.mobile) ? state.mobile : [];
  const fixed = Array.isArray(state.fixed) ? state.fixed : [];
  const sel = parseKey(selectedId);
  const m = sel && sel.type === "mobile" ? mobiles.find(x => x.id === sel.id) : null;
  const f = sel && sel.type === "fixed" ? fixed.find(x => x.id === sel.id) : null;
  const item = m || f;
  if (!item) {
    body.innerHTML = `<div class="muted">Select a vehicle…</div>`;
    return;
  }

  const title = item.name ? `${item.id} (${item.name})` : item.id;
  const updated = m ? fmtTime(m.trail?.[m.trail.length - 1]?.t) : "—";
  const lat = (item.lat != null) ? Number(item.lat).toFixed(5) : "—";
  const lon = (item.lon != null) ? Number(item.lon).toFixed(5) : "—";

  const readings = item.readings || {};
  const keys = Object.keys(readings);
  keys.sort();

  let html = "";
  html += `<div class="kv"><div class="k">Vehicle</div><div class="v">${escapeHtml(title)}</div></div>`;
  html += `<div class="kv"><div class="k">Last reading</div><div class="v">${escapeHtml(updated)}</div></div>`;
  html += `<div class="kv"><div class="k">Lat</div><div class="v">${lat}</div></div>`;
  html += `<div class="kv"><div class="k">Lon</div><div class="v">${lon}</div></div>`;
  html += `<div class="panelTitle" style="margin-top:10px">AQI Legend</div>`;

  // Build per-pollutant AQI summary from current readings
  const metrics = [];
  for (const k of keys) {
    const val = readings[k]?.value;
    const col = safeHex(readings[k]?.ci);
    const aqi = valueToAqi(k, val);
    const lvl = aqiLevel(aqi);
    metrics.push({
      key: k,
      label: canonicalPollutantLabel(k),
      value: val,
      color: col,
      aqi: (aqi == null || !isFinite(Number(aqi))) ? null : Number(aqi),
      lvlLabel: lvl?.label || "Unknown",
      lvlColor: lvl?.color || "#AAAAAA",
    });
  }
  metrics.sort((a, b) => (b.aqi ?? -1) - (a.aqi ?? -1));

  // Use AQI to choose which ones to chart/display: top 3 by current AQI
  const top = metrics.slice(0, 3);
  const rest = metrics.slice(3);

  // Sparkline series from trail history (mobile only): chart AQI (0..500) so scales are comparable.
  const trail = (m && Array.isArray(m.trail)) ? m.trail : [];
  const MAX_PTS = 90;
  const tail = trail.length > MAX_PTS ? trail.slice(trail.length - MAX_PTS) : trail;
  const seriesFor = (pollKey) => {
    const out = [];
    for (const p of tail) {
      const rv = p?.readings?.[pollKey]?.value;
      const aqi = valueToAqi(pollKey, rv);
      if (aqi != null && isFinite(Number(aqi))) out.push(Number(aqi));
    }
    return out;
  };

  if (!top.length) {
    html += `<div class="muted">No readings</div>`;
  } else {
    html += `<div class="aqiLegend">`;
    for (const it of top) {
      const aqiTxt = (it.aqi == null) ? "—" : String(Math.round(it.aqi));
      const spark = (m && tail.length >= 2) ? sparklineSvg(seriesFor(it.key), it.color) : "";
      html += `<div class="aqiRow">`;
      html += `<div class="swatch" style="background:${it.color}"></div>`;
      html += `<div class="aqiMain">`;
      html += `<div class="aqiName">${escapeHtml(it.label)}</div>`;
      html += `<div class="aqiMeta"><span class="aqiVal" style="color:${it.color}">${escapeHtml(String(it.value ?? "—"))}</span><span class="aqiSep">·</span><span class="aqiNum">AQI ${escapeHtml(aqiTxt)}</span><span class="aqiSep">·</span><span class="aqiCat" style="color:${it.lvlColor}">${escapeHtml(it.lvlLabel)}</span></div>`;
      html += `</div>`;
      if (spark) html += `<div class="aqiSpark">${spark}</div>`;
      html += `</div>`;
    }
    html += `</div>`;
  }

  html += `<div class="panelTitle" style="margin-top:10px">Readings</div>`;

  if (!keys.length) {
    html += `<div class="muted">No readings</div>`;
  } else {
    // Put the remaining (non-top) pollutants first, then the top ones, so the legend feels authoritative.
    const ordered = [...rest, ...top].map(x => x.key);
    const renderOrder = (ordered.length === keys.length) ? ordered : keys;
    for (const k of renderOrder) {
      const v = readings[k]?.value ?? "—";
      const c = safeHex(readings[k]?.ci != null ? readings[k].ci : readings[k]?.color);
      // Key stays neutral; value carries the color signal.
      html += `<div class="kv"><div class="k">${escapeHtml(k)}</div><div class="v" style="color:${c}">${escapeHtml(String(v))}</div></div>`;
    }
  }
  body.innerHTML = html;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
