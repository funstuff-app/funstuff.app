/**
 * MapLibre GL basemap and terrain adapter.
 *
 * The existing field and overlay canvases remain the application render
 * surfaces. MapLibre consumes them as canvas sources, which keeps playback
 * and sensor rendering georeferenced when the camera is pitched over terrain.
 */
(function (root, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else {
    root.MapGLRenderer = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const TERRAIN_URL = "https://tiles.mapterhorn.com/tilejson.json";
  const PITCH_3D = 58;

  function tileUrls(view) {
    const template = String(view.tileTemplate || "");
    const subs = Array.isArray(view.tileSubdomains) && view.tileSubdomains.length
      ? view.tileSubdomains
      : [""];
    return subs.map((sub) => window.tileUrlWithKey(template.replace("{s}", sub)));
  }

  function styleFor(view) {
    return {
      version: 8,
      sources: {
        basemap: {
          type: "raster",
          tiles: tileUrls(view),
          tileSize: 256,
          minzoom: view._zoomMin,
          maxzoom: view._zoomMax,
          attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
        },
        terrain: { type: "raster-dem", url: TERRAIN_URL },
      },
      layers: [
        { id: "basemap", type: "raster", source: "basemap" },
        {
          id: "hillshade",
          type: "hillshade",
          source: "terrain",
          paint: {
            "hillshade-shadow-color": "#101318",
            "hillshade-highlight-color": "#aeb9c8",
            "hillshade-accent-color": "#596575",
            "hillshade-exaggeration": 0.32,
          },
        },
      ],
    };
  }

  function MapGLRenderer(view, container) {
    this.view = view;
    this.container = container;
    this.map = null;
    this.ready = false;
    this.active = false;
    this.pitch = 0;
    this._lastSizeKey = "";
    this._lastViewKey = "";
    this._transitionTimer = null;
    this._pending3d = false;
    this._fieldCanvas = document.createElement("canvas");
    this._fieldCanvas.width = 1;
    this._fieldCanvas.height = 1;
    this._fieldCtx = this._fieldCanvas.getContext("2d");
    this._fieldRenderKey = "";
    // The pa-field and sensor-overlay canvas sources are both created paused
    // (animate:false) — see _flagFieldDrawn/_syncOverlayPlaying. GL canvas
    // sources re-upload their full pixel buffer to the GPU on every render
    // frame while playing; re-uploading either one on every frame regardless
    // of whether its content actually changed was pure waste (worse on
    // Safari, where texture upload is slower, but measurable in Chrome too).
    // Both use a generation counter rather than map.off() to cancel a pending
    // pause: MapLibre's Evented.once() registers an internal wrapper closure,
    // not the listener passed in, so map.off(type, ourListener) does not
    // reliably remove it. A stale pause callback instead checks its captured
    // generation against the current one and no-ops if it's been superseded.
    this._fieldPlaying = false;
    this._fieldPlayGen = 0;
    this._overlayPlaying = false;
    this._overlayPlayGen = 0;
    this._overlayPausePending = false;
    this._overlayAnchor = null;
    this._button = document.getElementById("map3dToggle");

    if (!container || typeof maplibregl === "undefined" || typeof maplibregl.Map !== "function") {
      if (this._button) this._button.hidden = true;
      return;
    }

    try {
      this.map = new maplibregl.Map({
        container,
        style: styleFor(view),
        center: [view.center.lon, view.center.lat],
        zoom: view.zoom - 1,
        pitch: 0,
        bearing: 0,
        minZoom: view._zoomMin - 1,
        maxZoom: view._zoomMax - 1,
        maxPitch: 75,
        interactive: false,
        attributionControl: false,
        fadeDuration: 0,
        maxTileCacheSize: 96,
        renderWorldCopies: false,
      });

      this.map.on("load", () => this._onLoad());
      this.map.on("error", (event) => {
        if (event && event.error) console.warn("[MapLibre]", event.error.message || event.error);
      });
      if (this._button) this._button.addEventListener("click", () => this.toggle3d());
    } catch (error) {
      console.warn("[MapLibre] Falling back to canvas tiles:", error);
      this.map = null;
      if (this._button) this._button.hidden = true;
    }
  }

  MapGLRenderer.prototype._onLoad = function () {
    if (!this.map) return;
    // With terrain on, MapLibre drapes raster layers by rendering them into
    // per-terrain-tile textures, and it does so per STACK of consecutive
    // draped layers: whenever any source in a stack changes, every visible
    // terrain tile re-renders the whole stack. With basemap, hillshade,
    // field and overlay in one stack, each overlay upload (30/s in playback,
    // every frame in a pan) re-rendered basemap + hillshade + field into
    // every tile too. A non-draped layer (circle/symbol) ends a stack, so
    // two empty circle layers split it into [basemap, hillshade] |
    // [pa-field] | [sensor-overlay]: an overlay change re-renders only the
    // overlay quad per tile, a field change only the field.
    this.map.addSource("rtt-split", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    this.map.addLayer({ id: "rtt-split-1", type: "circle", source: "rtt-split" });
    this.map.addSource("pa-field", {
      type: "canvas",
      canvas: this._fieldCanvas,
      coordinates: this._fieldCoordinates(),
      animate: false,
    });
    this.map.addLayer({
      id: "pa-field",
      type: "raster",
      source: "pa-field",
      paint: { "raster-fade-duration": 0 },
    });
    this.map.addLayer({ id: "rtt-split-2", type: "circle", source: "rtt-split" });
    // Draped layer = trails only. The overlay canvas itself (markers, labels)
    // stays on screen above the GL map in 3D, drawn through the pitched
    // camera projection, so marker glyphs are orthogonal to the camera
    // instead of foreshortened into the ground. Source is the trail cache
    // buffer (its own center/zoom/size, see _trailCoordinates); until the
    // first playback draw creates it, a 1x1 placeholder is used.
    this._trailPlaceholder = document.createElement("canvas");
    this._trailPlaceholder.width = 1; this._trailPlaceholder.height = 1;
    this.map.addSource("sensor-overlay", {
      type: "canvas",
      canvas: this.view._trailCacheCanvas || this._trailPlaceholder,
      coordinates: this._trailCoordinates(),
      animate: false,
    });
    this.map.addLayer({
      id: "sensor-overlay",
      type: "raster",
      source: "sensor-overlay",
      paint: { "raster-fade-duration": 0 },
    });
    this.ready = true;
    // 3D marker sync: the screen-aligned overlay canvas and the GL map are
    // two surfaces. A camera change pushed with jumpTo() is painted by
    // MapLibre in ITS next animation frame, so an overlay drawn from the pan
    // rAF (same task as jumpTo) is one frame ahead of the terrain: markers
    // slide off their vehicles while panning. Draw the overlay from inside
    // MapLibre's render callback instead, after it painted the camera, still
    // inside the same task, so the browser composites both surfaces together.
    this._cameraDirty = false;
    this.map.on("render", () => {
      if (!this.active) return;
      const m = this.map;
      const c = m.getCenter();
      const key = `${c.lng}:${c.lat}:${m.getZoom()}:${m.getPitch()}:${m.getBearing()}`;
      if (key === this._renderedCamKey && !this._cameraDirty) return;
      this._renderedCamKey = key;
      this._cameraDirty = false;
      this._drawingFromRender = true;
      try { this.view.drawOverlay(this.view.lastState, { cacheUnderlay: true, forceFrame: true }); }
      finally { this._drawingFromRender = false; }
    });
    // The style's tile URLs were built in the constructor; if /api/config
    // (CARTO key) answered before the GL map finished loading, the key-aware
    // setTheme() from app.js hit the !ready early-return. Re-point now.
    this.setTheme();
    this.sync(true);
    if (this._pending3d) {
      this._pending3d = false;
      this.enter3d();
    }
  };

  MapGLRenderer.prototype._canvasCoordinates = function (scale = 1) {
    const view = this.view;
    const w = view._cssW || 1;
    const h = view._cssH || 1;
    const center = window.latLonToWorld(view.center.lat, view.center.lon, view.zoom);
    const tl = window.worldToLatLon(center.x - w * scale / 2, center.y - h * scale / 2, view.zoom);
    const br = window.worldToLatLon(center.x + w * scale / 2, center.y + h * scale / 2, view.zoom);
    return [
      [tl.lon, tl.lat],
      [br.lon, tl.lat],
      [br.lon, br.lat],
      [tl.lon, br.lat],
    ];
  };

  /** Corners of the trail cache buffer: centered on the world point and zoom
   *  it was rendered for (OverlayRenderer._trailCacheCenterW/_trailCacheZoom),
   *  trailBufW x trailBufH css px. Falls back to the viewport rect. */
  MapGLRenderer.prototype._trailCoordinates = function () {
    const view = this.view;
    const ov = view.overlay;
    const c = ov && ov._trailCacheCenterW;
    if (!c) return this._canvasCoordinates();
    const zoom = ov._trailCacheZoom || view.zoom;
    const w = ov._trailCacheBufW || view._cssW || 1;
    const h = ov._trailCacheBufH || view._cssH || 1;
    const tl = window.worldToLatLon(c.x - w / 2, c.y - h / 2, zoom);
    const br = window.worldToLatLon(c.x + w / 2, c.y + h / 2, zoom);
    return [[tl.lon, tl.lat], [br.lon, tl.lat], [br.lon, br.lat], [tl.lon, br.lat]];
  };

  MapGLRenderer.prototype._fieldCoordinates = function () {
    const view = this.view;
    const computed = view.paField && view.paField._paFieldComputedView;
    const lat = computed ? (computed.bufLat != null ? computed.bufLat : computed.centerLat) : view.center.lat;
    const lon = computed ? (computed.bufLon != null ? computed.bufLon : computed.centerLon) : view.center.lon;
    const zoom = computed ? computed.zoom : view.zoom;
    const w = view._paFieldBufW || view._cssW || 1;
    const h = view._paFieldBufH || view._cssH || 1;
    const center = window.latLonToWorld(lat, lon, zoom);
    const tl = window.worldToLatLon(center.x - w / 2, center.y - h / 2, zoom);
    const br = window.worldToLatLon(center.x + w / 2, center.y + h / 2, zoom);
    return [
      [tl.lon, tl.lat],
      [br.lon, tl.lat],
      [br.lon, br.lat],
      [tl.lon, br.lat],
    ];
  };

  MapGLRenderer.prototype._syncFieldCanvas = function (force = false) {
    const view = this.view;
    const sourceCanvas = view._paFieldCanvas;
    const fieldRenderer = view.paField;
    const previousCanvas = fieldRenderer && fieldRenderer._paFieldPrevCanvas;
    const fadeMs = fieldRenderer ? fieldRenderer._paFieldFadeMs : 0;
    const fadeStart = fieldRenderer ? fieldRenderer._paFieldFadeStart : 0;
    const fade = previousCanvas && fadeMs
      ? Math.min(1, (performance.now() - fadeStart) / fadeMs)
      : 1;
    const dim = fieldRenderer ? fieldRenderer._paFieldDimCurrent : 1;
    const fading = !!(previousCanvas && fade < 1);
    // Every distinct fadeKey is a redraw + full texture re-upload of this
    // canvas. 60 steps over the 300 ms cross-fade meant ~18 uploads per
    // field recompute, and live playback recomputes about once a second
    // (a trail point aging in/out of the 45 min window changes the sensor
    // fingerprint). 4 steps is visually the same blend on terrain.
    const fadeKey = fading ? Math.floor(fade * 4) : 4;
    const renderKey = sourceCanvas
      ? `${view._paFieldKey || ""}:${sourceCanvas.width}x${sourceCanvas.height}:${fadeKey}:${dim}`
      : "empty";
    if (!force && renderKey === this._fieldRenderKey) return false;
    this._fieldRenderKey = renderKey;

    const ctx = this._fieldCtx;
    if (!ctx) return false;
    if (!sourceCanvas) {
      ctx.clearRect(0, 0, this._fieldCanvas.width, this._fieldCanvas.height);
      this._flagFieldDrawn(fading);
      return true;
    }
    if (this._fieldCanvas.width !== sourceCanvas.width || this._fieldCanvas.height !== sourceCanvas.height) {
      this._fieldCanvas.width = sourceCanvas.width;
      this._fieldCanvas.height = sourceCanvas.height;
      this._fieldCtx = this._fieldCanvas.getContext("2d");
    }
    const drawCtx = this._fieldCtx;
    drawCtx.setTransform(1, 0, 0, 1, 0, 0);
    drawCtx.clearRect(0, 0, this._fieldCanvas.width, this._fieldCanvas.height);
    drawCtx.globalCompositeOperation = "lighter";
    if (previousCanvas && fade < 1) {
      drawCtx.globalAlpha = (1 - fade) * dim;
      drawCtx.drawImage(previousCanvas, 0, 0, this._fieldCanvas.width, this._fieldCanvas.height);
    }
    drawCtx.globalAlpha = fade * dim;
    drawCtx.drawImage(sourceCanvas, 0, 0, this._fieldCanvas.width, this._fieldCanvas.height);
    drawCtx.globalAlpha = 1;
    drawCtx.globalCompositeOperation = "source-over";
    const source = this.map && this.map.getSource("pa-field");
    if (source) source.setCoordinates(this._fieldCoordinates());
    this._flagFieldDrawn(fading);
    return true;
  };

  /**
   * New pixels just landed in _fieldCanvas (or it was cleared) — resume the
   * canvas source for exactly the frames that need to see them, then pause it
   * again so MapLibre stops re-uploading a texture that isn't changing.
   * During an active cross-fade (`fading`), _syncFieldCanvas re-enters every
   * frame anyway (the fade key changes each call), so playback stays on for
   * the whole transition; a one-shot recompute pauses again right after the
   * single frame that shows it.
   */
  MapGLRenderer.prototype._flagFieldDrawn = function (fading) {
    this._setFieldPlaying(true);
    if (fading || !this.map) return;
    const gen = ++this._fieldPlayGen;
    // Pause on the SECOND render after the draw, not the first: Safari has
    // been observed firing the first 'render' for a frame whose source
    // prepare() ran before play() took effect, so pausing there dropped the
    // upload and the texture kept the previous pixels.
    this._afterTwoRenders(() => {
      if (gen !== this._fieldPlayGen) return; // superseded by a later draw — stay playing
      this._setFieldPlaying(false);
    });
  };

  MapGLRenderer.prototype._afterTwoRenders = function (fn) {
    // No forced repaint here: while the source is playing MapLibre keeps
    // rendering on its own (hasTransition), so the second render arrives by
    // itself. Forcing one doubled terrain renders per overlay draw.
    this.map.once("render", () => { this.map.once("render", fn); });
  };

  MapGLRenderer.prototype._setFieldPlaying = function (playing) {
    if (this._fieldPlaying === playing) return;
    this._fieldPlaying = playing;
    const source = this.map && this.map.getSource("pa-field");
    if (!source) return;
    if (playing) source.play();
    else source.pause();
  };

  /**
   * One-shot upload of the sensor-overlay canvas, exactly like _flagFieldDrawn:
   * play the source for the single frame that shows the new pixels, then pause.
   *
   * A playing canvas source makes MapLibre re-render (terrain + hillshade +
   * basemap + both textures) and re-upload the full overlay canvas on EVERY
   * animation frame, but the overlay is only repainted on the playback loop's
   * capped draw tick (~30/s). Leaving it playing for the whole time playback
   * ran (the previous design) meant 2-4x more terrain renders and full-size
   * texture uploads than there were new pixels to show — measured 120 GL
   * renders/s against 30 overlay draws/s. Tying the upload to the draw
   * instead makes GL work track overlay redraws 1:1.
   *
   * sync() is called from three composition-root sites (drawTiles/
   * _compositePaFieldOnTiles/drawOverlay); only drawOverlay changes this
   * canvas, and it passes overlayDrawn=true. The pending flag collapses the
   * up-to-3 sync() calls per tick into one pause listener; the generation
   * check keeps a stale pause from firing after a newer draw re-played it.
   */
  MapGLRenderer.prototype._syncOverlayPlaying = function (overlayDrawn) {
    if (!overlayDrawn || !this.map) return false;
    // Upload only when the draped trail buffer was rebuilt; marker draws no
    // longer touch this source (they are on the screen-aligned canvas).
    const ov = this.view.overlay;
    const stamp = ov ? ov._lastTrailRedrawPerf : 0;
    if (stamp === this._overlayUploadStamp) return false;
    this._overlayUploadStamp = stamp;
    this._setOverlayPlaying(true);
    const gen = ++this._overlayPlayGen;
    if (this._overlayPausePending) return;
    this._overlayPausePending = true;
    this._afterTwoRenders(() => {
      this._overlayPausePending = false;
      if (gen !== this._overlayPlayGen) { this._syncOverlayPlaying(true); return; } // newer draw landed — one more frame
      this._setOverlayPlaying(false);
    });
  };

  MapGLRenderer.prototype._setOverlayPlaying = function (playing) {
    if (this._overlayPlaying === playing) return;
    this._overlayPlaying = playing;
    const source = this.map && this.map.getSource("sensor-overlay");
    if (!source) return;
    if (playing) source.play();
    else source.pause();
  };

  /** Camera only: size + jumpTo when view.center/zoom moved. No texture
   *  work, no repaint request. Returns whether the camera moved. */
  MapGLRenderer.prototype._pushCamera = function () {
    const sizeKey = `${this.view._cssW || 1}x${this.view._cssH || 1}`;
    if (sizeKey !== this._lastSizeKey) {
      this._lastSizeKey = sizeKey;
      this.map.resize();
    }
    const viewKey = `${this.view.center.lon}:${this.view.center.lat}:${this.view.zoom}:${sizeKey}`;
    if (viewKey === this._lastViewKey) return false;
    this._lastViewKey = viewKey;
    this.map.jumpTo({
      center: [this.view.center.lon, this.view.center.lat],
      zoom: this.view.zoom - 1,
    });
    this._cameraDirty = true;
    return true;
  };

  MapGLRenderer.prototype.sync = function (force = false, overlayDrawn = false) {
    if (!this.map) return false;
    if (!this.active && !force) return false;
    const viewChanged = this._pushCamera();
    if (this.ready) {
      const fieldDrawn = this._syncFieldCanvas(force);
      const trailUploaded = this._syncOverlayPlaying(overlayDrawn || force) !== false;
      if (overlayDrawn || force) {
        // Anchor the draped trail texture to the buffer it was rendered
        // for, never on camera moves. The cache only changes on a rebuild
        // (view/time), so re-anchor (and swap in the canvas the first time)
        // only when its stamp moved.
        const ov = this.view.overlay;
        const c = ov && ov._trailCacheCenterW;
        const stamp = c ? `${c.x}:${c.y}:${ov._trailCacheZoom}:${ov._trailCacheBufW}x${ov._trailCacheBufH}:${ov._lastTrailRedrawPerf}` : "";
        if (force || stamp !== this._overlayAnchor) {
          const overlay = this.map.getSource("sensor-overlay");
          if (overlay) {
            const cache = this.view._trailCacheCanvas;
            // CanvasSource.prepare() re-reads .canvas every frame and
            // re-uploads when its width/height differ from what it last saw.
            if (cache && overlay.canvas !== cache) { overlay.canvas = cache; overlay.width = 0; overlay.height = 0; }
            overlay.setCoordinates(this._trailCoordinates());
          }
          this._overlayAnchor = stamp;
        }
      }
      // A render re-draws terrain/hillshade/basemap and re-uploads whatever
      // is playing. Only ask for one when this call changed something the
      // frame would show; the drawTiles/composite call sites fire sync() on
      // ticks where neither texture nor camera moved.
      // Not on every overlay draw: in 3D the overlay is drawn FROM the render
      // callback, so requesting a repaint per draw would loop forever.
      if (force || viewChanged || fieldDrawn || trailUploaded) this.map.triggerRepaint();
    }
    return this.active && this.ready;
  };

  MapGLRenderer.prototype.setTheme = function () {
    if (!this.map || !this.ready) return;
    const source = this.map.getSource("basemap");
    if (source && typeof source.setTiles === "function") source.setTiles(tileUrls(this.view));
    if (this.active) this.map.triggerRepaint();
  };

  /** Inverse of projectWorld: lat/lon of the ground under a screen point in
   *  the pitched view. null when 3D is not active so callers fall back to the
   *  flat math — same contract as projectWorld/worldToScreen. */
  MapGLRenderer.prototype.unprojectScreen = function (sx, sy) {
    if (!this.map || !this.ready || this.map.getPitch() < 0.5) return null;
    // Several wheel/pinch events can land between frames; each one moves
    // view.center/zoom. Push that to the GL camera first or the unproject
    // answers against the previous event's camera.
    this._pushCamera();
    const ll = this.map.unproject([sx, sy]);
    if (!ll || !isFinite(ll.lat) || !isFinite(ll.lng)) return null;
    return { lat: ll.lat, lon: ll.lng };
  };

  MapGLRenderer.prototype.projectWorld = function (worldX, worldY) {
    if (!this.map || !this.ready || this.map.getPitch() < 0.5) return null;
    const ll = window.worldToLatLon(worldX, worldY, this.view.zoom);
    const map = this.map;
    const t = map.transform;
    const M = t._pixelMatrix3D;
    const terrain = map.terrain;
    // Same arithmetic as map.project() with terrain, minus its per-point
    // elevation lookup through the covering-tile search (that path costs
    // ~0.1 ms per marker; hundreds of markers per overlay draw made every
    // 3D pan frame a 40+ ms frame).
    const lngLat = new maplibregl.LngLat(ll.lon, ll.lat);
    const c = maplibregl.MercatorCoordinate.fromLngLat(lngLat);
    const ws = t.worldSize;
    const px = c.x * ws, py = c.y * ws;
    const pz = terrain.getElevationForLngLatZoom(lngLat, t.tileZoom);
    const w = M[3] * px + M[7] * py + M[11] * pz + M[15];
    if (!(w > 0)) return null;
    return {
      x: (M[0] * px + M[4] * py + M[8] * pz + M[12]) / w,
      y: (M[1] * px + M[5] * py + M[9] * pz + M[13]) / w,
    };
  };

  MapGLRenderer.prototype._setButtonState = function (active) {
    if (this._button) {
      this._button.classList.toggle("active", active);
      this._button.setAttribute("aria-pressed", active ? "true" : "false");
      this._button.setAttribute("aria-label", active ? "Exit 3D terrain view" : "Enter 3D terrain view");
      this._button.title = active ? "Exit 3D terrain view" : "Enter 3D terrain view";
      this._button.textContent = active ? "2D" : "3D";
    }
  };

  MapGLRenderer.prototype.enter3d = function () {
    if (!this.map || !this.ready) {
      this._pending3d = true;
      return;
    }
    if (this._transitionTimer) {
      window.clearTimeout(this._transitionTimer);
      this._transitionTimer = null;
    }
    this.active = true;
    this.pitch = PITCH_3D;
    this._lastViewKey = "";
    // Zoom ceiling for 3D (every zoom gesture clamps to view._zoomMax).
    this.view._zoomMax = this.view._zoomMax3d;
    if (this.view.zoom > this.view._zoomMax) {
      // Entering from a closer 2D zoom: back the app out to the 3D ceiling
      // BEFORE the camera is pushed, and redraw so every zoom-derived cache
      // (tiles snapshot, trail cache, field, playback points) is rebuilt for
      // the new zoom instead of waiting for the next gesture. Kill any
      // in-flight zoom inertia/easing that would write the old zoom back.
      this.view._stopPinchInertia();
      this.view._cancelCameraAnimations();
      this.view.zoom = this.view._zoomMax;
      this.view._lastTilesViewSig = null;
      this.view.draw(this.view.lastState);
      try { if (typeof window.__onMapViewChanged === "function") window.__onMapViewChanged(); } catch {}
    }
    this.map.setTerrain({ source: "terrain", exaggeration: 1.15 });
    this.sync(true);
    this.map.jumpTo({ pitch: 0, bearing: 0 });

    const root = this.container.parentElement;
    root.classList.add("mapgl-visible");
    window.requestAnimationFrame(() => {
      this.map.easeTo({ pitch: PITCH_3D, bearing: 0, duration: 520 });
      root.classList.add("mapgl-active");
    });
    // If MapLibre's terrain correction fired during the ease with the DEM not
    // yet loaded (center elevation 0), it left a lowered pitch/zoom behind.
    // Re-apply the requested camera once the map is idle (DEM present); if
    // it is still under terrain then, the correction runs again with real data.
    this.map.once("idle", () => {
      if (!this.active) return;
      this._lastViewKey = "";
      this.map.jumpTo({
        center: [this.view.center.lon, this.view.center.lat],
        zoom: this.view.zoom - 1,
        pitch: PITCH_3D,
        bearing: 0,
      });
      this._lastViewKey = `${this.view.center.lon}:${this.view.center.lat}:${this.view.zoom}:${this._lastSizeKey}`;
      this._cameraDirty = true;
    });
    this._setButtonState(true);
  };

  MapGLRenderer.prototype.exit3d = function () {
    if (!this.map || !this.ready) return;
    if (this._transitionTimer) window.clearTimeout(this._transitionTimer);
    this.active = false;
    this.pitch = 0;
    this.view._zoomMax = this.view._zoomMax2d;
    this.view.tiles.drawTiles();

    const root = this.container.parentElement;
    root.classList.remove("mapgl-active");
    this.map.easeTo({ pitch: 0, bearing: 0, duration: 220 });
    this._transitionTimer = window.setTimeout(() => {
      root.classList.remove("mapgl-visible");
      this.map.stop();
      this.map.setTerrain(null);
      this._transitionTimer = null;
    }, 240);
    this._setButtonState(false);
  };

  MapGLRenderer.prototype.toggle3d = function () {
    if (this.active) this.exit3d();
    else this.enter3d();
  };

  // Exposed so PaFieldRenderer (engine_pa_field.js) can size the 3D render
  // distance off the same pitch this renderer actually uses, instead of a
  // second hardcoded copy of the angle drifting out of sync with this one.
  MapGLRenderer.PITCH_3D = PITCH_3D;

  return MapGLRenderer;
});
