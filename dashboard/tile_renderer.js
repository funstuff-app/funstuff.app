(function (root, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else {
    root.TileRenderer = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /**
   * TileRenderer — basemap tile loading, caching (LRU), rendering, and snapshot management.
   *
   * Extracted from MapView to isolate tile concerns. Operates on a dedicated tiles canvas.
   * Uses TILE_SIZE and TILE_THEMES globals from config.js, and latLonToWorld/clamp from
   * projections.js (both loaded earlier in script order).
   */
  class TileRenderer {
    constructor({ canvas, initialTheme, cacheSize, onRedrawNeeded }) {
      /** @type {HTMLCanvasElement} */
      this.canvas = canvas;
      /** @type {CanvasRenderingContext2D} */
      this.ctx = canvas.getContext("2d", { willReadFrequently: false });

      // Theme
      /** @type {string} */
      this.themeKey = initialTheme || "carto_dark_all";
      const t = TILE_THEMES[this.themeKey] || TILE_THEMES["carto_dark_all"];
      /** @type {string} */
      this.tileTemplate = t.template;
      /** @type {string[]} */
      this.tileSubdomains = t.subdomains;
      /** @type {number} */
      this._tileEpoch = 1;

      // LRU tile cache
      /** @type {Map<string, {img: HTMLImageElement, ok: boolean}>} */
      this.tileCache = new Map();
      /** @type {number} */
      this._tileCacheMax = (typeof cacheSize === "number" && cacheSize > 0) ? cacheSize : 420;

      // Snapshot for smooth pan/zoom transitions
      /** @type {HTMLCanvasElement|null} */
      this._snapshotCanvas = null;
      /** @type {{zoom: number, centerLat: number, centerLon: number}|null} */
      this._snapshotMeta = null;

      // Debounced tile-load redraw
      /** @type {number|null} */
      this._redrawTimer = null;
      /** @type {boolean} */
      this._redrawPending = false;

      /** @type {function|null} */
      this._onRedrawNeeded = onRedrawNeeded || null;
    }

    /**
     * Change tile theme. Clears cache, invalidates snapshots, increments epoch.
     * @param {string} themeKey
     */
    setTheme(themeKey) {
      const k = String(themeKey || "");
      const t = TILE_THEMES[k] || TILE_THEMES["carto_dark_all"];
      this.themeKey = TILE_THEMES[k] ? k : "carto_dark_all";
      this.tileTemplate = t.template;
      this.tileSubdomains = t.subdomains;
      this._tileEpoch++;
      this.tileCache.clear();
      this._snapshotCanvas = null;
      this._snapshotMeta = null;
    }

    /**
     * Main tile rendering pipeline.
     * @param {{lat: number, lon: number}} center
     * @param {number} zoom
     * @param {number} cssW - CSS pixel width
     * @param {number} cssH - CSS pixel height
     * @param {number} dpr - device pixel ratio
     * @param {boolean} pinchZooming - true during active pinch zoom
     * @param {boolean} touchActive - true when touch is in progress
     * @param {number} zoomMin
     * @param {number} zoomMax
     */
    render({ center, zoom, cssW, cssH, dpr, pinchZooming, touchActive, zoomMin, zoomMax }) {
      this._zoomMax = zoomMax;
      const ctx = this.ctx;
      if (!ctx) return;
      const w = cssW || 1;
      const h = cssH || 1;

      // Reset transform to canonical dpr-scaled state to prevent scaling bugs
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const c = latLonToWorld(center.lat, center.lon, zoom);

      // Backdrop: reuse previous frame so *panning* doesn't flicker while tiles stream in.
      // During active pinch/inertia we also reuse+scale the snapshot (fast path) so zooming
      // is closer to the OS-native feel and doesn't spend time drawing N tiles every event.
      const hasSnapshot = !!(this._snapshotCanvas && this._snapshotMeta);
      ctx.clearRect(0, 0, w, h);
      if (hasSnapshot) {
        try {
          const prev = this._snapshotMeta;
          ctx.save();
          if (pinchZooming) {
            // Scale around the screen center; also translate for center changes.
            const sZoom = Math.pow(2, zoom - prev.zoom);
            const prevC = latLonToWorld(prev.centerLat, prev.centerLon, prev.zoom);
            const currC = latLonToWorld(center.lat, center.lon, prev.zoom);
            const txPan = (prevC.x - currC.x) * sZoom;
            const tyPan = (prevC.y - currC.y) * sZoom;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.translate(w / 2, h / 2);
            ctx.scale(sZoom, sZoom);
            ctx.translate((-w / 2) + (txPan / sZoom), (-h / 2) + (tyPan / sZoom));
            ctx.drawImage(this._snapshotCanvas, 0, 0, w, h);
            ctx.restore();
            // Fast path: don't draw individual tiles while pinch-zooming. We'll do a full tiles
            // render once the gesture/inertia completes.
            return;
          }

          // Non-pinch: translate-only (same integer zoom snapshots).
          if (Math.floor(prev.zoom) !== Math.floor(zoom)) throw new Error("zoom changed");
          const prevC = latLonToWorld(prev.centerLat, prev.centerLon, prev.zoom);
          const currC = latLonToWorld(center.lat, center.lon, prev.zoom);
          const tx = (prevC.x - currC.x);
          const ty = (prevC.y - currC.y);
          ctx.setTransform(dpr, 0, 0, dpr, dpr * tx, dpr * ty);
          ctx.drawImage(this._snapshotCanvas, 0, 0, w, h);
          ctx.restore();
        } catch {
          // ignore snapshot issues
        }
      }

      const topLeftX = c.x - w / 2;
      const topLeftY = c.y - h / 2;

      // Use integer tile zoom for fetching, scaled to fractional zoom.
      const tileZ = clamp(Math.floor(zoom), zoomMin, zoomMax);
      const s = Math.pow(2, zoom - tileZ); // scale factor from tileZ world to zoom world

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

          this._renderTile(ctx, key, tileZ, wrappedX, ty, px, py, s, hasSnapshot, touchActive);
        }
      }

      // Capture snapshot for the next frame - but skip during active touch to avoid blocking input.
      if (!touchActive) this.captureSnapshot({ zoom, centerLat: center.lat, centerLon: center.lon });
    }

    /** Capture the tiles canvas into a snapshot for smooth pan/zoom transitions. */
    captureSnapshot({ zoom, centerLat, centerLon }) {
      try {
        const tw = this.canvas.width;
        const th = this.canvas.height;
        if (!this._snapshotCanvas) {
          this._snapshotCanvas = document.createElement("canvas");
          this._snapshotCanvas.width = tw;
          this._snapshotCanvas.height = th;
        } else if (this._snapshotCanvas.width !== tw || this._snapshotCanvas.height !== th) {
          this._snapshotCanvas.width = tw;
          this._snapshotCanvas.height = th;
        }
        const sctx = this._snapshotCanvas.getContext("2d");
        if (sctx) {
          sctx.setTransform(1, 0, 0, 1, 0, 0);
          sctx.clearRect(0, 0, tw, th);
          sctx.drawImage(this.canvas, 0, 0);
          this._snapshotMeta = { zoom, centerLat, centerLon };
        }
      } catch {
        // ignore snapshot capture errors
      }
    }

    _cacheGet(key) {
      if (!this.tileCache || !key) return null;
      const v = this.tileCache.get(key) || null;
      if (!v) return null;
      // LRU: refresh insertion order.
      this.tileCache.delete(key);
      this.tileCache.set(key, v);
      return v;
    }

    _cacheSet(key, value) {
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

    _renderTile(ctx, key, z, x, y, px, py, scale, hasSnapshot, touchActive) {
      const cached = this._cacheGet(key);
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
          this._cacheSet(key, { img, ok: true });
          this._scheduleRedraw(touchActive);
        };
        img.onerror = () => {
          if (epoch !== this._tileEpoch) return;
          this._cacheSet(key, { img, ok: false });
        };
        const subs = this.tileSubdomains || [""];
        const sub = subs[(x + y) % subs.length] || "";
        img.src = this.tileTemplate
          .replace("{s}", sub)
          .replace("{z}", z)
          .replace("{x}", x)
          .replace("{y}", y);
        if (epoch === this._tileEpoch) this._cacheSet(key, { img, ok: false });
      }

      // Tile not ready yet — try to draw a parent tile (lower zoom) scaled up as fallback.
      for (let pz = z - 1; pz >= Math.max(z - 4, 3); pz--) {
        const diff = z - pz;
        const parentX = x >> diff;
        const parentY = y >> diff;
        const parentKey = `${this.themeKey}:${pz}/${parentX}/${parentY}`;
        const parentCached = this._cacheGet(parentKey);
        if (parentCached && parentCached.ok) {
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

      // No parent available — try child tiles (higher zoom) scaled down.
      // When zooming out, child tiles from the previous zoom level are likely cached.
      const czMax = Math.min(z + 2, this._zoomMax || 19);
      for (let cz = z + 1; cz <= czMax; cz++) {
        const diff = cz - z;
        const childrenPerAxis = 1 << diff;
        const baseChildX = x << diff;
        const baseChildY = y << diff;
        let anyHit = false;
        for (let dy = 0; dy < childrenPerAxis; dy++) {
          for (let dx = 0; dx < childrenPerAxis; dx++) {
            const childKey = `${this.themeKey}:${cz}/${baseChildX + dx}/${baseChildY + dy}`;
            const childCached = this._cacheGet(childKey);
            if (childCached && childCached.ok) {
              const sz = TILE_SIZE * scale;
              const dstSize = sz / childrenPerAxis;
              ctx.filter = "none";
              ctx.drawImage(childCached.img,
                0, 0, TILE_SIZE, TILE_SIZE,
                Math.floor(px + dx * dstSize), Math.floor(py + dy * dstSize),
                Math.ceil(dstSize), Math.ceil(dstSize));
              anyHit = true;
            }
          }
        }
        if (anyHit) return;
      }

      // No parent or child available — only draw placeholder if there's no snapshot backdrop.
      if (!hasSnapshot) {
        const sz = TILE_SIZE * scale;
        ctx.fillStyle = "rgba(255,255,255,0.03)";
        ctx.fillRect(Math.floor(px), Math.floor(py), Math.ceil(sz), Math.ceil(sz));
        ctx.strokeStyle = "rgba(255,255,255,0.04)";
        ctx.strokeRect(Math.floor(px), Math.floor(py), Math.ceil(sz), Math.ceil(sz));
      }
    }

    _scheduleRedraw(touchActive) {
      if (touchActive) {
        this._redrawPending = true;
        return;
      }
      if (this._redrawTimer) return; // already scheduled
      this._redrawTimer = setTimeout(() => {
        this._redrawTimer = null;
        if (this._onRedrawNeeded) this._onRedrawNeeded();
      }, 50);
    }

    /** Call when touch ends to flush any deferred tile redraws. */
    flushPendingRedraw() {
      if (this._redrawPending) {
        this._redrawPending = false;
        this._scheduleRedraw(false);
      }
    }

    /** Invalidate snapshot (e.g. on resize). */
    invalidateSnapshot() {
      this._snapshotCanvas = null;
      this._snapshotMeta = null;
    }
  }

  return TileRenderer;
});
