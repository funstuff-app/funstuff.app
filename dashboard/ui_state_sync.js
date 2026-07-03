/**
 * ui_state_sync.js — fetchState / etag / delta-merge / SSE / analytics.
 *
 * Extracted from app.js top level + main(): owns the polling fetch path
 * (etag-conditional, delta-merge, trail accumulation), the SSE push path,
 * and the analytics event batching that used to live as closures inside
 * main(). app.js wires this module in via a callback config and keeps its
 * own tick()/poll-scheduling loop, calling into StateSync for the actual
 * network + merge work.
 */
(function (root, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else {
    root.StateSync = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const g = (typeof window !== "undefined") ? window : globalThis;

  // ── Pure helpers (no closure state) ─────────────────────────────────────

  /** Extract the newest trail timestamp (epoch ms) from a state object. */
  function _extractNewestTrailMs(st) {
    let best = null;
    const mobiles = Array.isArray(st?.mobile) ? st.mobile : [];
    for (const m of mobiles) {
      const trail = Array.isArray(m?.trail) ? m.trail : [];
      for (let i = trail.length - 1; i >= 0; i--) {
        const t = trail[i]?.t;
        if (typeof t === "string") {
          const ms = g.parseUtcMs(t);
          if (ms != null && (best == null || ms > best)) { best = ms; break; }
        }
      }
    }
    return best;
  }

  /** Merge a delta state into the accumulated state.
   *  - Mobile trails: append new points to existing vehicles.
   *  - Fixed sensors / meta: replace entirely (always current).
   */
  function _mergeStateDelta(acc, delta) {
    // Replace top-level fields the server always sends in full.
    acc.ts = delta.ts;
    acc.meta = delta.meta;
    acc.fixed = delta.fixed;

    // Merge mobile trails.
    const deltaM = Array.isArray(delta.mobile) ? delta.mobile : [];
    const accById = new Map();
    const accMobiles = Array.isArray(acc.mobile) ? acc.mobile : [];
    for (const m of accMobiles) {
      if (m && m.id != null) accById.set(String(m.id), m);
    }

    for (const dm of deltaM) {
      if (!dm || dm.id == null) continue;
      const id = String(dm.id);
      const existing = accById.get(id);
      if (!existing) {
        // New vehicle — add as-is.
        accMobiles.push(dm);
        accById.set(id, dm);
        continue;
      }
      // Append new trail points, capping to prevent unbounded growth.
      const newPts = Array.isArray(dm.trail) ? dm.trail : [];
      if (newPts.length > 0) {
        const oldTrail = Array.isArray(existing.trail) ? existing.trail : [];
        const merged = oldTrail.concat(newPts);
        const cap = (typeof g.MAX_TRAIL_LEN === "number" && g.MAX_TRAIL_LEN > 0) ? g.MAX_TRAIL_LEN : 3000;
        existing.trail = merged.length > cap ? merged.slice(merged.length - cap) : merged;
      }
      // Update non-trail fields (readings, ghosted, color, etc.)
      for (const k of Object.keys(dm)) {
        if (k !== "trail" && k !== "id") existing[k] = dm[k];
      }
    }

    // Remove vehicles that disappeared from the server response.
    const deltaIds = new Set(deltaM.map(m => m && m.id != null ? String(m.id) : null).filter(Boolean));
    acc.mobile = accMobiles.filter(m => m && m.id != null && deltaIds.has(String(m.id)));

    return acc;
  }

  function newestReadingMsFromState(st) {
    // Prefer the most recent timestamp from any mobile breadcrumb point.
    // Fixed sensors currently do not include timestamps in the normalized payload.
    let bestMs = null;
    const mobiles = Array.isArray(st?.mobile) ? st.mobile : [];
    for (const m of mobiles) {
      const trail = Array.isArray(m?.trail) ? m.trail : [];
      const last = trail.length ? trail[trail.length - 1] : null;
      const t = last && typeof last.t === "string" ? last.t : null;
      const ms = t ? g.parseUtcMs(t) : null;
      if (ms != null && (bestMs == null || ms > bestMs)) bestMs = ms;
    }
    if (bestMs != null) return bestMs;

    // Fallbacks: server meta (seconds) or state ts.
    const sec = (st && st.meta && typeof st.meta.last_position_change_ts === "number")
      ? st.meta.last_position_change_ts
      : (typeof st?.ts === "number" ? st.ts : null);
    return (sec != null && isFinite(sec)) ? (sec * 1000) : null;
  }

  /**
   * Validate that a state object has the expected schema.
   * Returns true if valid, false if not.
   * This is a security boundary - validates structure before any processing.
   */
  function validateStateSchema(state) {
    if (!state || typeof state !== "object") return false;
    // Must have mobile or fixed arrays
    if (!Array.isArray(state.mobile) && !Array.isArray(state.fixed)) return false;
    // Check mobile entries have id
    if (Array.isArray(state.mobile)) {
      for (const m of state.mobile) {
        if (!m || typeof m !== "object" || !("id" in m)) return false;
      }
    }
    // Check fixed entries have id
    if (Array.isArray(state.fixed)) {
      for (const f of state.fixed) {
        if (!f || typeof f !== "object" || !("id" in f)) return false;
      }
    }
    return true;
  }

  /**
   * Map backend "immobile" field → frontend "parked" field on all mobile sensors.
   * The backend sends `immobile: bool` but the UI reads `parked`.
   */
  function _mapImmobileToParked(st) {
    if (!st || !Array.isArray(st.mobile)) return;
    for (var i = 0; i < st.mobile.length; i++) {
      var m = st.mobile[i];
      if (m && m.immobile != null) m.parked = !!m.immobile;
    }
  }

  // ── Constructor ──────────────────────────────────────────────────────────

  /**
   * @param {object} cfg
   *   appToken     — APP_TOKEN header value
   *   apiBaseUrl   — appConfig.apiBaseUrl
   *   getMap       — () => MapView instance (may be null before construction)
   *   getSelectedId — () => current selectedId
   *   isLoadingData — () => whether historical data is currently loading
   *   getClientId  — () => _clientId for analytics payloads
   *   rescheduleTick — (delayMs) => clear + reschedule app.js's tick() timer
   *   tickNow      — () => cancel pending timer and run tick() immediately
   *   POLL_MS      — fallback poll interval
   *   POLL_MS_SSE  — safety-net poll interval while SSE connected
   */
  function StateSync(cfg) {
    this.cfg = cfg || {};

    // ETag for conditional polling — avoids re-downloading unchanged payloads.
    this._stateEtag = null;
    this._stateCached = null;

    // Delta delivery: track newest trail timestamp so subsequent polls
    // only receive new trail points (the server strips old ones via ?since_ms=).
    this._newestTrailMs = null;
    // Accumulated full state (trails grow across polls).
    this._accumulatedState = null;

    this._lastStateWasNotModified = false;

    // ── SSE (Server-Sent Events) — push-based state change notifications ──
    this._sseConnected = false;
    this._sseLastSeq = null;
    this._sseSource = null;
    this._sseDeferTimer = null; // deferred render after gesture settles

    // ── Analytics batching ──
    this._analyticsQueue = [];
    this._analyticsLastFlush = 0;
    this._ANALYTICS_FLUSH_MS = 300000; // 5 min
  }

  StateSync.prototype.wasNotModified = function () {
    return this._lastStateWasNotModified;
  };

  StateSync.prototype.isSSEConnected = function () {
    return this._sseConnected;
  };

  /** Release accumulated live-polling state (e.g. before switching to historical). */
  StateSync.prototype.resetAccumulated = function () {
    this._accumulatedState = null;
    this._newestTrailMs = null;
    this._stateEtag = null;
  };

  StateSync.prototype.fetchState = async function () {
    const cfg = this.cfg;
    this._lastStateWasNotModified = false;
    let url = `${cfg.apiBaseUrl}/state`;
    // Delta delivery: ask the server to strip trail points we already have.
    if (this._newestTrailMs != null) {
      const sep = url.includes("?") ? "&" : "?";
      url = `${url}${sep}since_ms=${this._newestTrailMs}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000); // 15s timeout
    try {
      const headers = { "X-App-Token": cfg.appToken };
      if (this._stateEtag) headers["If-None-Match"] = this._stateEtag;
      const res = await fetch(url, { cache: "no-store", signal: controller.signal, headers, credentials: "same-origin" });
      if (res.status === 304 && this._accumulatedState) {
        this._lastStateWasNotModified = true;
        return this._accumulatedState;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this._stateEtag = res.headers.get("ETag") || null;
      const payload = await res.json();

      // Merge or replace accumulated state.
      if (payload.meta?.delta && this._accumulatedState) {
        _mergeStateDelta(this._accumulatedState, payload);
      } else {
        // First fetch or full payload — replace entirely.
        this._accumulatedState = payload;
      }

      // Track newest trail timestamp for next delta request.
      const nms = _extractNewestTrailMs(this._accumulatedState);
      if (nms != null) this._newestTrailMs = nms;

      this._stateCached = this._accumulatedState;
      return this._accumulatedState;
    } finally {
      clearTimeout(timer);
    }
  };

  // ── Analytics ────────────────────────────────────────────────────────────

  StateSync.prototype._flushAnalytics = function () {
    const cfg = this.cfg;
    if (!this._analyticsQueue.length) return;
    var events = this._analyticsQueue.splice(0, 50);
    var body = JSON.stringify({ client_id: cfg.getClientId ? cfg.getClientId() : undefined, events: events });
    try {
      fetch((cfg.apiBaseUrl || "/api") + "/analytics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body
      }).catch(function() {});
    } catch (e) {}
    this._analyticsLastFlush = Date.now();
  };

  StateSync.prototype.pushAnalyticsEvent = function (type, payload) {
    this._analyticsQueue.push({ type: type, payload: payload });
    if (Date.now() - this._analyticsLastFlush > this._ANALYTICS_FLUSH_MS) {
      this._flushAnalytics();
    }
  };

  // ── SSE delta merge ──────────────────────────────────────────────────────

  /**
   * Merge an SSE delta into the current live state.
   * delta.trail_new: { sensorId: [points...], ... }
   * delta.mobile: [ { id, lat, lon, idle, readings }, ... ]
   */
  StateSync.prototype._mergeDelta = function (delta) {
    var st = g.__lastState;
    if (!st || !st.mobile) return false;

    var changed = false;

    // Merge new trail points
    var trailNew = delta.trail_new;
    if (trailNew && typeof trailNew === "object") {
      var mobileById = {};
      for (var i = 0; i < st.mobile.length; i++) {
        var m = st.mobile[i];
        if (m && m.id) mobileById[m.id] = m;
      }
      for (var sid in trailNew) {
        var sensor = mobileById[sid] || mobileById["mobile:" + sid];
        if (!sensor) continue;
        var existing = sensor.trail || [];
        var incoming = trailNew[sid];
        if (!Array.isArray(incoming) || !incoming.length) continue;
        // Find the latest timestamp in existing trail to avoid duplicates
        var maxExistingT = 0;
        for (var j = existing.length - 1; j >= 0 && j >= existing.length - 5; j--) {
          var pt = existing[j];
          if (pt && typeof pt.t === "number" && pt.t > maxExistingT) maxExistingT = pt.t;
        }
        var appended = 0;
        for (var k = 0; k < incoming.length; k++) {
          var np = incoming[k];
          if (np && typeof np.t === "number" && np.t > maxExistingT) {
            existing.push(np);
            appended++;
          }
        }
        if (appended > 0) {
          sensor.trail = existing;
          changed = true;
        }
      }
    }

    // Merge mobile sensor summaries (readings, position)
    var mobileSummaries = delta.mobile;
    if (Array.isArray(mobileSummaries)) {
      var byId = {};
      for (var mi = 0; mi < st.mobile.length; mi++) {
        if (st.mobile[mi] && st.mobile[mi].id) byId[st.mobile[mi].id] = st.mobile[mi];
      }
      for (var si = 0; si < mobileSummaries.length; si++) {
        var summ = mobileSummaries[si];
        if (!summ || !summ.id) continue;
        var target = byId[summ.id];
        if (!target) continue;
        if (summ.lat != null) target.lat = summ.lat;
        if (summ.lon != null) target.lon = summ.lon;
        if (summ.immobile != null) { target.immobile = summ.immobile; target.parked = !!summ.immobile; }
        if (summ.readings) target.readings = summ.readings;
        changed = true;
      }
    }

    // Update meta timestamps
    if (delta.ts) {
      st.ts = delta.ts;
      if (st.meta) st.meta.ts = delta.ts;
    }

    return changed;
  };

  // ── SSE connection ───────────────────────────────────────────────────────

  StateSync.prototype.connectSSE = function () {
    const self = this;
    const cfg = this.cfg;
    if (this._sseSource) { try { this._sseSource.close(); } catch {} }
    var url = (cfg.apiBaseUrl || "/api") + "/events";
    this._sseSource = new EventSource(url);

    this._sseSource.onopen = function () {
      self._sseConnected = true;
      // Shorten the next scheduled poll now that SSE is live.
      cfg.rescheduleTick(cfg.POLL_MS_SSE);
    };

    // Named event: "delta" — incremental state update pushed by server
    this._sseSource.addEventListener("delta", function (ev) {
      try {
        var delta = JSON.parse(ev.data);
        var seq = delta.seq;
        if (seq != null && seq !== self._sseLastSeq) {
          self._sseLastSeq = seq;
          // Skip delta merge if viewing historical data
          if (g._historicalState || cfg.isLoadingData()) return;
          var map = cfg.getMap();
          if (self._mergeDelta(delta) && map) {
            if (map._isGesturing()) {
              // State merged in-place; gesture redraws reflect it via lastState ref.
              // Defer full render + sidebar until gesture settles.
              clearTimeout(self._sseDeferTimer);
              self._sseDeferTimer = setTimeout(function() {
                map.draw(g.__lastState);
                try { renderLists(g.__lastState, cfg.getSelectedId()); } catch (e) {}
                try { renderDetails(g.__lastState, cfg.getSelectedId()); } catch (e) {}
              }, 300);
            } else {
              map.draw(g.__lastState);
              try { renderLists(g.__lastState, cfg.getSelectedId()); } catch (e) {}
              try { renderDetails(g.__lastState, cfg.getSelectedId()); } catch (e) {}
            }
          }
          // Reschedule safety-net poll
          cfg.rescheduleTick(cfg.POLL_MS_SSE);
        }
      } catch (e) { try { console.warn("[SSE delta]", e); } catch {} }
    });

    // Named event: "wind" — new wind snapshot pushed by server
    this._sseSource.addEventListener("wind", function (ev) {
      try {
        var snap = JSON.parse(ev.data);
        var map = cfg.getMap();
        if (snap.key && snap.points && map) {
          map.mergeWindSnapshot(snap.key, snap.points);
        }
      } catch (e) { try { console.warn("[SSE wind]", e); } catch {} }
    });

    // Default "message" event — backward-compatible notification
    this._sseSource.onmessage = function (ev) {
      try {
        var msg = JSON.parse(ev.data);
        var seq = msg.seq;
        if (seq != null && seq !== self._sseLastSeq) {
          self._sseLastSeq = seq;
          // New data available — fetch immediately.
          cfg.tickNow();
        }
      } catch {}
    };

    this._sseSource.onerror = function () {
      self._sseConnected = false;
      // EventSource auto-reconnects; revert to normal polling in the meantime.
      cfg.rescheduleTick(cfg.POLL_MS);
    };
  };

  // ── Static pure-function exports (for app.js call sites outside fetchState) ──
  StateSync._extractNewestTrailMs = _extractNewestTrailMs;
  StateSync._mergeStateDelta = _mergeStateDelta;
  StateSync.newestReadingMsFromState = newestReadingMsFromState;
  StateSync.validateStateSchema = validateStateSchema;
  StateSync._mapImmobileToParked = _mapImmobileToParked;

  return StateSync;
});
