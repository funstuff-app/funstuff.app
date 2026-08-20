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
    return subs.map((sub) => template.replace("{s}", sub));
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
    this.map.addSource("pa-field", {
      type: "canvas",
      canvas: this._fieldCanvas,
      coordinates: this._fieldCoordinates(),
      animate: true,
    });
    this.map.addLayer({
      id: "pa-field",
      type: "raster",
      source: "pa-field",
      paint: { "raster-fade-duration": 0 },
    });
    this.map.addSource("sensor-overlay", {
      type: "canvas",
      canvas: this.view.overlayCanvas,
      coordinates: this._canvasCoordinates(),
      animate: true,
    });
    this.map.addLayer({
      id: "sensor-overlay",
      type: "raster",
      source: "sensor-overlay",
      paint: { "raster-fade-duration": 0 },
    });
    this.ready = true;
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

  MapGLRenderer.prototype._fieldCoordinates = function () {
    const view = this.view;
    const computed = view.paField && view.paField._paFieldComputedView;
    const lat = computed ? computed.centerLat : view.center.lat;
    const lon = computed ? computed.centerLon : view.center.lon;
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
    const fadeKey = previousCanvas && fade < 1 ? Math.floor(fade * 60) : 60;
    const renderKey = sourceCanvas
      ? `${view._paFieldKey || ""}:${sourceCanvas.width}x${sourceCanvas.height}:${fadeKey}:${dim}`
      : "empty";
    if (!force && renderKey === this._fieldRenderKey) return;
    this._fieldRenderKey = renderKey;

    const ctx = this._fieldCtx;
    if (!ctx) return;
    if (!sourceCanvas) {
      ctx.clearRect(0, 0, this._fieldCanvas.width, this._fieldCanvas.height);
      return;
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
  };

  MapGLRenderer.prototype.sync = function (force = false) {
    if (!this.map) return false;
    if (!this.active && !force) return false;
    const sizeKey = `${this.view._cssW || 1}x${this.view._cssH || 1}`;
    if (sizeKey !== this._lastSizeKey) {
      this._lastSizeKey = sizeKey;
      this.map.resize();
    }
    const viewKey = `${this.view.center.lon}:${this.view.center.lat}:${this.view.zoom}:${sizeKey}`;
    const viewChanged = viewKey !== this._lastViewKey;
    if (viewChanged) {
      this._lastViewKey = viewKey;
      this.map.jumpTo({
        center: [this.view.center.lon, this.view.center.lat],
        zoom: this.view.zoom - 1,
      });
    }
    if (this.ready) {
      this._syncFieldCanvas(force);
      if (viewChanged) {
        const overlay = this.map.getSource("sensor-overlay");
        if (overlay) overlay.setCoordinates(this._canvasCoordinates());
      }
      this.map.triggerRepaint();
    }
    return this.active && this.ready;
  };

  MapGLRenderer.prototype.setTheme = function () {
    if (!this.map || !this.ready) return;
    const source = this.map.getSource("basemap");
    if (source && typeof source.setTiles === "function") source.setTiles(tileUrls(this.view));
    if (this.active) this.map.triggerRepaint();
  };

  MapGLRenderer.prototype.projectWorld = function (worldX, worldY) {
    if (!this.map || !this.ready || this.map.getPitch() < 0.5) return null;
    const ll = window.worldToLatLon(worldX, worldY, this.view.zoom);
    const point = this.map.project([ll.lon, ll.lat]);
    return { x: point.x, y: point.y };
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
    this.map.setTerrain({ source: "terrain", exaggeration: 1.15 });
    this.sync(true);
    this.map.jumpTo({ pitch: 0, bearing: 0 });

    const root = this.container.parentElement;
    root.classList.add("mapgl-visible");
    window.requestAnimationFrame(() => {
      this.map.easeTo({ pitch: PITCH_3D, bearing: 0, duration: 520 });
      root.classList.add("mapgl-active");
    });
    this._setButtonState(true);
  };

  MapGLRenderer.prototype.exit3d = function () {
    if (!this.map || !this.ready) return;
    if (this._transitionTimer) window.clearTimeout(this._transitionTimer);
    this.active = false;
    this.pitch = 0;
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

  return MapGLRenderer;
});
