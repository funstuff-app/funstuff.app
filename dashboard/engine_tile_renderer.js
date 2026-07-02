/**
 * engine_tile_renderer.js — TileRenderer: basemap tile drawing, tile cache,
 * snapshot capture, and debounced redraw scheduling.
 *
 * PILOT for the controller extraction pattern: TileRenderer owns its private
 * state; MapView keeps shared view state (canvas/center/zoom/theme/etc.) and
 * exposes it via `this.view`. MapView's own drawTiles/drawTile/etc. become
 * one-line delegates to `this.tiles.<method>()`.
 *
 * Subsystem-private state (owned by TileRenderer, moved out of MapView in S10;
 * verified by grep as referenced only here): _tileCacheMax, _tileLoadRedrawTimer.
 *
 * Shared MapView fields read/written here (kept on MapView, not moved,
 * because non-moved code — constructor, setTheme, onTouchEnd, zoomBy, resize —
 * or another controller (CameraGestures) also touches them): tctx, _cssW,
 * _cssH, _dpr, center, zoom, themeKey, tileTemplate, tileSubdomains,
 * _pinchZooming, _touchActive, tilesCanvas, _zoomMin, _zoomMax, tileCache,
 * _tileEpoch, _tileRedrawPending, _tilesSnapshotCanvas, _tilesSnapshotMeta.
 */
(function (root, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else {
    root.TileRenderer = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Globals from earlier-loaded scripts (config.js, projections.js) are
  // resolved lazily at call time — never at module factory time (node tests
  // have no browser globals).
  var g = (typeof window !== "undefined") ? window : globalThis;

  // Mirror of map_view.js's file-scope _isMobileDevice, computed lazily so the
  // module factory stays browser-global-free (node tests have no navigator).
  function _isMobileDevice() {
    var nav = (typeof navigator !== "undefined") ? navigator : null;
    if (!nav) return false;
    return /iPad|iPhone|iPod|Android/i.test(nav.userAgent) || (nav.maxTouchPoints > 1);
  }

  /**
   * @param {object} view — MapView instance (owns shared canvas/center/zoom/
   *   theme/cache state; see file header for the full shared-field list).
   */
  function TileRenderer(view) {
    this.view = view;

    // Subsystem-private state (owned by TileRenderer; not shared with any
    // unmoved MapView code or other module — verified by grep in S10).
    this._tileCacheMax = _isMobileDevice() ? 180 : 420;
    this._tileLoadRedrawTimer = null;
  }

  TileRenderer.prototype.drawTiles = function () {
    const view = this.view;
    const ctx = view.tctx;
    if (!ctx) return;
    // Avoid per-frame layout reads during panning.
    const w = view._cssW || 1;
    const h = view._cssH || 1;
    const dpr = view._dpr || (window.devicePixelRatio || 1);

    // Reset transform to canonical dpr-scaled state to prevent scaling bugs
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const c = g.latLonToWorld(view.center.lat, view.center.lon, view.zoom);
    const ws = c.ws;

    // Backdrop: reuse previous frame so *panning* doesn't flicker while tiles stream in.
    // During active pinch/inertia we also reuse+scale the snapshot (fast path) so zooming
    // is closer to the OS-native feel and doesn't spend time drawing N tiles every event.
    const hasSnapshot = !!(view._tilesSnapshotCanvas && view._tilesSnapshotMeta);
    ctx.clearRect(0, 0, w, h);
    if (hasSnapshot) {
      try {
        const prev = view._tilesSnapshotMeta;
        ctx.save();
        if (view._pinchZooming) {
          // Scale around the screen center; also translate for center changes.
          const sZoom = Math.pow(2, view.zoom - prev.zoom);
          const prevC = g.latLonToWorld(prev.centerLat, prev.centerLon, prev.zoom);
          const currC = g.latLonToWorld(view.center.lat, view.center.lon, prev.zoom);
          const txPan = (prevC.x - currC.x) * sZoom;
          const tyPan = (prevC.y - currC.y) * sZoom;
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.translate(w / 2, h / 2);
          ctx.scale(sZoom, sZoom);
          ctx.translate((-w / 2) + (txPan / sZoom), (-h / 2) + (tyPan / sZoom));
          ctx.drawImage(view._tilesSnapshotCanvas, 0, 0, w, h);
          ctx.restore();
          // Fast path: don't draw individual tiles while pinch-zooming. We'll do a full tiles
          // render once the gesture/inertia completes.
          return;
        }

        // Non-pinch: translate-only (same integer zoom snapshots).
        if (Math.floor(prev.zoom) !== Math.floor(view.zoom)) throw new Error("zoom changed");
        const prevC = g.latLonToWorld(prev.centerLat, prev.centerLon, prev.zoom);
        const currC = g.latLonToWorld(view.center.lat, view.center.lon, prev.zoom);
        const tx = (prevC.x - currC.x);
        const ty = (prevC.y - currC.y);
        ctx.setTransform(dpr, 0, 0, dpr, dpr * tx, dpr * ty);
        ctx.drawImage(view._tilesSnapshotCanvas, 0, 0, w, h);
        ctx.restore();
      } catch {
        // ignore snapshot issues
      }
    }

    const topLeftX = c.x - w / 2;
    const topLeftY = c.y - h / 2;

    // Use integer tile zoom for fetching, scaled to fractional zoom.
    const tileZ = g.clamp(Math.floor(view.zoom), view._zoomMin, view._zoomMax);
    const s = Math.pow(2, view.zoom - tileZ); // scale factor from tileZ world to zoom world

    const topLeftX_Z = topLeftX / s;
    const topLeftY_Z = topLeftY / s;
    const w_Z = w / s;
    const h_Z = h / s;

    const minTileX = Math.floor(topLeftX_Z / g.TILE_SIZE);
    const minTileY = Math.floor(topLeftY_Z / g.TILE_SIZE);
    const maxTileX = Math.floor((topLeftX_Z + w_Z) / g.TILE_SIZE);
    const maxTileY = Math.floor((topLeftY_Z + h_Z) / g.TILE_SIZE);

    const tilesPerAxis = Math.pow(2, tileZ);
    for (let ty = minTileY; ty <= maxTileY; ty++) {
      if (ty < 0 || ty >= tilesPerAxis) continue;
      for (let tx = minTileX; tx <= maxTileX; tx++) {
        // wrap X
        let wrappedX = tx;
        while (wrappedX < 0) wrappedX += tilesPerAxis;
        while (wrappedX >= tilesPerAxis) wrappedX -= tilesPerAxis;

        // IMPORTANT: key includes theme to prevent "checkerboard" mixing when switching themes.
        const key = `${view.themeKey}:${tileZ}/${wrappedX}/${ty}`;
        const px = (tx * g.TILE_SIZE * s) - topLeftX;
        const py = (ty * g.TILE_SIZE * s) - topLeftY;

        this.drawTile(ctx, key, tileZ, wrappedX, ty, px, py, s, hasSnapshot);
      }
    }

    // Capture snapshot for the next frame - but skip during active touch to avoid blocking input.
    if (!view._touchActive) this._captureTilesSnapshot();
  };

  /** Capture the tiles canvas into a snapshot for smooth pan/zoom transitions. */
  TileRenderer.prototype._captureTilesSnapshot = function () {
    const view = this.view;
    try {
      const tw = view.tilesCanvas.width;
      const th = view.tilesCanvas.height;
      if (!view._tilesSnapshotCanvas) {
        view._tilesSnapshotCanvas = document.createElement("canvas");
        view._tilesSnapshotCanvas.width = tw;
        view._tilesSnapshotCanvas.height = th;
      } else if (view._tilesSnapshotCanvas.width !== tw || view._tilesSnapshotCanvas.height !== th) {
        view._tilesSnapshotCanvas.width = tw;
        view._tilesSnapshotCanvas.height = th;
      }
      const sctx = view._tilesSnapshotCanvas.getContext("2d");
      if (sctx) {
        sctx.setTransform(1, 0, 0, 1, 0, 0);
        sctx.clearRect(0, 0, tw, th);
        sctx.drawImage(view.tilesCanvas, 0, 0);
        view._tilesSnapshotMeta = { zoom: view.zoom, centerLat: view.center.lat, centerLon: view.center.lon };
      }
    } catch {
      // ignore snapshot capture errors
    }
  };

  TileRenderer.prototype._tileCacheGet = function (key) {
    const view = this.view;
    if (!view.tileCache || !key) return null;
    const v = view.tileCache.get(key) || null;
    if (!v) return null;
    // LRU: refresh insertion order.
    view.tileCache.delete(key);
    view.tileCache.set(key, v);
    return v;
  };

  TileRenderer.prototype._tileCacheSet = function (key, value) {
    const view = this.view;
    if (!view.tileCache || !key) return;
    if (view.tileCache.has(key)) view.tileCache.delete(key);
    view.tileCache.set(key, value);
    const max = (typeof this._tileCacheMax === "number" && isFinite(this._tileCacheMax) && this._tileCacheMax > 0)
      ? Math.floor(this._tileCacheMax)
      : 420;
    while (view.tileCache.size > max) {
      const oldestKey = view.tileCache.keys().next().value;
      if (oldestKey == null) break;
      view.tileCache.delete(oldestKey);
    }
  };

  TileRenderer.prototype.drawTile = function (ctx, key, z, x, y, px, py, scale, hasSnapshot) {
    const view = this.view;
    const cached = this._tileCacheGet(key);
    if (cached && cached.ok) {
      const sz = g.TILE_SIZE * scale;
      ctx.filter = "none";
      ctx.drawImage(cached.img, Math.floor(px), Math.floor(py), Math.ceil(sz), Math.ceil(sz));
      return;
    }

    if (!cached) {
      const img = new Image();
      const epoch = view._tileEpoch;
      img.crossOrigin = "anonymous";
      img.onload = () => {
        if (epoch !== view._tileEpoch) return;
        this._tileCacheSet(key, { img, ok: true });
        this._scheduleTileRedraw();
      };
      img.onerror = () => {
        if (epoch !== view._tileEpoch) return;
        this._tileCacheSet(key, { img, ok: false });
      };
      const subs = view.tileSubdomains || [""];
      const sub = subs[(x + y) % subs.length] || "";
      img.src = view.tileTemplate
        .replace("{s}", sub)
        .replace("{z}", z)
        .replace("{x}", x)
        .replace("{y}", y);
      if (epoch === view._tileEpoch) this._tileCacheSet(key, { img, ok: false });
    }

    // Tile not ready yet — try to draw a parent tile (lower zoom) scaled up as fallback.
    // Walk up zoom levels to find a cached ancestor tile covering this area.
    for (let pz = z - 1; pz >= Math.max(z - 4, view._zoomMin); pz--) {
      const diff = z - pz;
      const parentX = x >> diff;
      const parentY = y >> diff;
      const parentKey = `${view.themeKey}:${pz}/${parentX}/${parentY}`;
      const parentCached = this._tileCacheGet(parentKey);
      if (parentCached && parentCached.ok) {
        // Draw the sub-region of the parent tile that corresponds to this tile.
        const subScale = 1 << diff;
        const subX = x - (parentX << diff);
        const subY = y - (parentY << diff);
        const srcSize = g.TILE_SIZE / subScale;
        const srcX = subX * srcSize;
        const srcY = subY * srcSize;
        const sz = g.TILE_SIZE * scale;
        ctx.filter = "none";
        ctx.drawImage(parentCached.img, srcX, srcY, srcSize, srcSize,
          Math.floor(px), Math.floor(py), Math.ceil(sz), Math.ceil(sz));
        return;
      }
    }

    // No parent available — only draw placeholder if there's no snapshot backdrop.
    if (!hasSnapshot) {
      const sz = g.TILE_SIZE * scale;
      ctx.fillStyle = "rgba(255,255,255,0.03)";
      ctx.fillRect(Math.floor(px), Math.floor(py), Math.ceil(sz), Math.ceil(sz));
      ctx.strokeStyle = "rgba(255,255,255,0.04)";
      ctx.strokeRect(Math.floor(px), Math.floor(py), Math.ceil(sz), Math.ceil(sz));
    }
  };

  TileRenderer.prototype._scheduleTileRedraw = function () {
    const view = this.view;
    // Debounce tile-load redraws: wait a short time for more tiles to finish loading
    // before redrawing, to avoid N separate redraws when N tiles load in quick succession.
    if (view._touchActive) {
      // Mark pending so tiles redraw when touch ends
      view._tileRedrawPending = true;
      return;
    }
    if (this._tileLoadRedrawTimer) return; // already scheduled
    this._tileLoadRedrawTimer = setTimeout(() => {
      this._tileLoadRedrawTimer = null;
      this.drawTiles();
    }, 50);
  };

  return TileRenderer;
});
