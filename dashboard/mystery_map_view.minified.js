const _isLite = "1" === new URLSearchParams(window.location.search).get("lite");
function _pm25ToRgb(t) {
    return t <= 2 ? [0, 255, 255] : t <= 5 ? [0, 204, 255] : t <= 9 ? [0, 228, 0] : t <= 35.4 ? [255, 255, 0] : t <= 55.4 ? [255, 126, 0] : t <= 125.4 ? [255, 0, 0] : t <= 225.4 ? [143, 63, 151] : [126, 0, 35]
}
const _PM25_STOPS = [[0, 0, 255, 255], [2, 0, 255, 255], [5, 0, 204, 255], [9, 0, 228, 0], [35.4, 255, 255, 0], [55.4, 255, 126, 0], [125.4, 255, 0, 0], [225.4, 143, 63, 151], [500, 126, 0, 35]];
function _pm25ToRgbSmooth(t) {
    if (t <= _PM25_STOPS[0][0])
        return [_PM25_STOPS[0][1], _PM25_STOPS[0][2], _PM25_STOPS[0][3]];
    for (let e = 1; e < _PM25_STOPS.length; e++)
        if (t <= _PM25_STOPS[e][0]) {
            const i = _PM25_STOPS[e - 1],
                s = _PM25_STOPS[e],
                a = (t - i[0]) / (s[0] - i[0]);
            return [Math.round(i[1] + (s[1] - i[1]) * a), Math.round(i[2] + (s[2] - i[2]) * a), Math.round(i[3] + (s[3] - i[3]) * a)]
        }
    const e = _PM25_STOPS[_PM25_STOPS.length - 1];
    return [e[1], e[2], e[3]]
}
function _pm25ColorCat(t) {
    return t <= 2 ? 0 : t <= 5 ? 1 : t <= 9 ? 2 : t <= 35.4 ? 3 : t <= 55.4 ? 4 : t <= 125.4 ? 5 : t <= 225.4 ? 6 : 7
}
const _BAND_MIDS = [1, 3.5, 7, 22.2, 45.4, 90.4, 175.4, 250];
class MapView {
    constructor(t, e)
    {
        this.tilesCanvas = t,
        this.overlayCanvas = e,
        this.tctx = t.getContext("2d", {
            willReadFrequently: !1
        }),
        this.octx = e.getContext("2d", {
            willReadFrequently: !1
        }),
        this.zoom = 12.58,
        this._zoomMin = 3,
        this._zoomMax = 18,
        this._pinchAnchor = null,
        this._gesture = null,
        this._mouseDragging = !1,
        this._mouseDragStart = null,
        this._mouseDragCenterStart = null,
        this._mouseDragMoved = !1,
        this.center = {
            lat: 40.7608,
            lon: -111.891
        },
        this._centerAnimRAF = null,
        this._frameSeq = 0,
        this._autoCameraSuppressedUntilPerfMs = 0,
        this._autoCameraCooldownMs = 1400,
        this._lastAutoFitSig = "",
        this._autoFitInFlightSig = "",
        this._pendingForcedFit = null,
        this.selectedId = null,
        this.showFixed = !0,
        this.showMobile = !0,
        this.showMobileLabels = !1,
        this.showFixedLabels = !1,
        this.traceMode = !1,
        this._traceRAF = null,
        this._traceLastFrameTs = 0,
        this._traceTargetFPS = 30,
        this._dpr = window.devicePixelRatio || 1,
        this._cssW = 1,
        this._cssH = 1,
        this._isWindows = /Win/.test(navigator.platform || navigator.userAgent),
        this._isMac = /Mac/.test(navigator.platform || navigator.userAgent),
        this._overlayStaticCanvas = null,
        this._overlayStaticKey = "",
        this._overlayStaticDirty = !0,
        this._paFieldCanvas = null,
        this._paFieldKey = "",
        this._paFieldPrevCanvas = null,
        this._paFieldFadeStart = 0,
        this._paFieldFadeMs = 300,
        this._paWorker = null,
        this._paWorkerJobId = 0,
        this._paWorkerPending = !1,
        this._paWorkerFingerprint = "",
        this._paFieldPrewarmed = new Map,
        this._paFieldCacheMax = 16,
        this._trailCacheCanvas = null,
        this._trailCacheViewKey = "",
        this._trailCacheTimeMs = null,
        this._lastTrailRedrawPerf = 0,
        this._tracePtsById = new Map,
        this._tracePtsKey = "",
        this._traceLastSideById = new Map,
        this._traceActiveRouteById = new Map,
        this._tracePendingRouteById = new Map,
        this._traceCycleStartMsById = new Map,
        this._traceInitialRunDoneById = new Map,
        this._traceAngleById = new Map,
        this._traceAngleLastMsById = new Map,
        this.playbackMode = !1,
        this._playbackPlaying = !1,
        this._playbackSpeed = 5,
        this._playbackNowMs = null,
        this._playbackMinMs = null,
        this._playbackMaxMs = null,
        this._playbackPtsById = new Map,
        this._playbackPtsKey = "",
        this._physicsStateById = new Map,
        this._playbackLiveFollow = !0,
        this._playbackInitialized = !1,
        this._roadMatchedRangesById = new Map,
        this._roadMatchPending = new Set,
        this._roadMatchLastRequestMs = 0,
        this._dataNowBaseMs = null,
        this._dataNowBasePerfMs = null,
        this._playbackNewestSegmentStartMs = null,
        this._playbackLastMaxMs = null,
        this._pbDrag = null,
        this._pbInertia2d = null,
        this._pbDebugPath = !1,
        this._pbDebugRawGps = !0,
        this._pbDebugRoadLines = !0,
        this._vehicleActualPathById = new Map,
        this._rawGpsById = new Map,
        this._roadGraphEdges = null,
        this._tramLineEdges = null,
        this._tramLineHasElevation = !1,
        this._selectOrchRAF = null,
        this._selectOrch = null,
        this._traceSelectionWarpById = new Map,
        this._traceTargetMedianSpeedMps = 7,
        this._traceMaxSpeedMps = 18,
        this._traceRealMaxSpeedMps = 20,
        this._traceSpeedSmoothingTauS = 1.6,
        this._traceStopSpeedMps = .25,
        this._traceStopMinMs = 350,
        this._traceStopMaxMs = 3500,
        this._traceDwellTimeCompression = 12,
        this._persistedTrailById = new Map,
        this._persistedTrailRev = 0,
        this.maxTrailLen = 1e3,
        this.tileCache = new Map;
        const i = /iPad|iPhone|iPod|Android/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1;
        this._tileCacheMax = i ? 180 : 420,
        this._touchState = null,
        this._touchActive = !1,
        this._tileLoadRedrawTimer = null,
        this._tilesSnapshotCanvas = null,
        this._tilesSnapshotMeta = null,
        this.themeKey = "carto_voyager";
        const s = TILE_THEMES[this.themeKey];
        this.tileTemplate = s.template,
        this.tileSubdomains = s.subdomains,
        this._tileEpoch = 1,
        this._zoomDrawRAF = null,
        this._panDrawRAF = null,
        this._pinchInertiaRAF = null,
        this._pinchVz = 0,
        this._pinchVelTs = 0,
        this._pinchAnchorSX = null,
        this._pinchAnchorSY = null,
        this._wheelPinchEndTimer = null,
        this._pinchZooming = !1,
        this._lastWheelPanTime = 0,
        this._wheelPanning = !1,
        this._wheelPanEndTimer = null,
        this._ro = new ResizeObserver(t => {
            for (const e of t) {
                const {width: t, height: i} = e.contentRect;
                t > 0 && i > 0 && this.resize(t, i)
            }
        }),
        this._ro.observe(this.tilesCanvas.parentElement),
        this._onFullscreenChange = () => {
            const t = this.tilesCanvas.parentElement;
            t && this._ro.observe(t),
            this._cssW = 0,
            this._cssH = 0;
            const e = window.visualViewport;
            requestAnimationFrame(() => {
                const t = e ? e.width : window.innerWidth,
                    i = e ? e.height : window.innerHeight;
                this.resize(t, i)
            })
        },
        document.addEventListener("fullscreenchange", this._onFullscreenChange),
        document.addEventListener("webkitfullscreenchange", this._onFullscreenChange),
        this.overlayCanvas.addEventListener("wheel", t => this.onWheel(t), {
            passive: !1
        }),
        this.overlayCanvas.addEventListener("gesturestart", t => this.onGestureStart(t), {
            passive: !1
        }),
        this.overlayCanvas.addEventListener("gesturechange", t => this.onGestureChange(t), {
            passive: !1
        }),
        this.overlayCanvas.addEventListener("gestureend", t => this.onGestureEnd(t), {
            passive: !1
        }),
        this.overlayCanvas.addEventListener("click", t => this.onClick(t)),
        this.overlayCanvas.addEventListener("mousedown", t => this.onMouseDown(t)),
        window.addEventListener("mousemove", t => this.onMouseMove(t)),
        window.addEventListener("mouseup", () => this.onMouseUp()),
        this.overlayCanvas.addEventListener("touchstart", t => this.onTouchStart(t), {
            passive: !1
        }),
        this.overlayCanvas.addEventListener("touchmove", t => this.onTouchMove(t), {
            passive: !1
        }),
        this.overlayCanvas.addEventListener("touchend", t => this.onTouchEnd(t), {
            passive: !1
        }),
        this.overlayCanvas.addEventListener("touchcancel", t => this.onTouchEnd(t), {
            passive: !1
        }),
        this.resize()
    }
    _cancelCameraAnimations()
    {
        this._centerAnimRAF && (cancelAnimationFrame(this._centerAnimRAF), this._centerAnimRAF = null)
    }
    _suppressAutoCamera({cooldownMs: t}={})
    {
        const e = "number" == typeof t && isFinite(t) ? t : this._autoCameraCooldownMs,
            i = performance.now() + Math.max(0, e);
        i <= this._autoCameraSuppressedUntilPerfMs || (this._autoCameraSuppressedUntilPerfMs = i)
    }
    _overrideCooldownForAlert(t)
    {
        const e = performance.now() + Math.max(0, t);
        this._autoCameraSuppressedUntilPerfMs > e && (this._autoCameraSuppressedUntilPerfMs = e)
    }
    _noteUserInteraction()
    {
        this._cancelCameraAnimations(),
        this._autoCameraCooldownMs = 3e5,
        this._suppressAutoCamera()
    }
    _canRunAutoCamera()
    {
        const t = performance.now();
        return !(this._touchActive || this._mouseDragging || this._pinchZooming) && t >= (this._autoCameraSuppressedUntilPerfMs || 0)
    }
    _dataNowMs()
    {
        const t = this._dataNowBaseMs,
            e = this._dataNowBasePerfMs;
        return null != t && isFinite(t) && null != e && isFinite(e) ? Number(t) + Math.max(0, performance.now() - Number(e)) : Date.now()
    }
    _invalidateOverlayStatic()
    {
        this._overlayStaticDirty = !0,
        this._paFieldKey = ""
    }
    setMaxTrailLen(t)
    {
        const e = Number(t);
        if (!isFinite(e) || e < 2)
            return;
        if (this.maxTrailLen === e)
            return;
        this.maxTrailLen = e;
        let i = !1;
        for (const [t, s] of this._persistedTrailById.entries())
            s.trail.length > e && (s.trail = s.trail.slice(-e), i = !0);
        i && (this._persistedTrailRev++, this._invalidateOverlayStatic())
    }
    _stopPinchInertia()
    {
        this._pinchInertiaRAF && cancelAnimationFrame(this._pinchInertiaRAF),
        this._pinchInertiaRAF = null,
        this._wheelPinchEndTimer = null,
        this._pinchVz = 0,
        this._pinchVelTs = 0
    }
    _notePinchVelocity(t, e)
    {
        const i = "number" == typeof e && isFinite(e) ? e : performance.now(),
            s = this._pinchVelTs > 0 ? i - this._pinchVelTs : 0;
        if (s > 4 && s < 120) {
            const e = t / s;
            this._pinchVz = .65 * this._pinchVz + .35 * e
        }
        this._pinchVelTs = i
    }
    _startPinchInertia()
    {
        if (!isFinite(this._pinchVz) || Math.abs(this._pinchVz) < 5e-5 || !isFinite(this._pinchAnchorSX) || !isFinite(this._pinchAnchorSY))
            return this._pinchZooming = !1, void this._requestZoomRedraw();
        let t = performance.now();
        const e = () => {
            const i = performance.now(),
                s = i - t;
            t = i;
            const a = clamp(this.zoom + this._pinchVz * s, this._zoomMin, this._zoomMax);
            if (this._setZoomAroundScreenPoint(a, this._pinchAnchorSX, this._pinchAnchorSY), this._tilesSnapshotCanvas = null, this._tilesSnapshotMeta = null, this._requestZoomRedraw(), this._notifyViewChanged(), this._pinchVz *= .9, Math.abs(this._pinchVz) < 5e-5 || a === this._zoomMin || a === this._zoomMax)
                return this._pinchInertiaRAF = null, this._pinchZooming = !1, void this._requestZoomRedraw();
            this._pinchInertiaRAF = requestAnimationFrame(e)
        };
        t = performance.now() - 16,
        e()
    }
    _requestZoomRedraw()
    {
        this._zoomDrawRAF || (this._zoomDrawRAF = requestAnimationFrame(() => {
            this._zoomDrawRAF = null,
            this.draw(this.lastState)
        }))
    }
    _redrawViewOnly()
    {
        this._frameSeq++;
        const t = this.lastState;
        if (!t)
            return;
        const e = (() => {
            const t = Number(this.zoom),
                e = Number(this.center?.lat),
                i = Number(this.center?.lon),
                s = Number(this._cssW),
                a = Number(this._cssH),
                n = Number(this._dpr || window.devicePixelRatio || 1),
                o = (t, e=1e6) => isFinite(t) ? Math.round(t * e) / e : t;
            return `${this.themeKey}|${o(t, 1e3)}|${o(e)}|${o(i)}|${s}x${a}|dpr:${o(n, 1e3)}|pinch:${this._pinchZooming ? 1 : 0}`
        })();
        let i = !1;
        this._lastTilesViewSig !== e && (this._lastTilesViewSig = e, this.drawTiles(), i = !0),
        this._compositePaFieldOnTiles(t, i),
        this.drawOverlay(t, {
            cacheUnderlay: !0
        })
    }
    _requestPanRedraw()
    {
        this._panDrawRAF || (this._panDrawRAF = requestAnimationFrame(() => {
            this._panDrawRAF = null,
            this._redrawViewOnly(),
            this._notifyViewChanged()
        }))
    }
    _notifyViewChanged()
    {
        try {
            "function" == typeof window.__onMapViewChanged && window.__onMapViewChanged()
        } catch {}
    }
    _eventToLocalXY(t)
    {
        const e = this.overlayCanvas.getBoundingClientRect(),
            i = "number" == typeof t.clientX ? t.clientX : e.left + e.width / 2,
            s = "number" == typeof t.clientY ? t.clientY : e.top + e.height / 2;
        return {
            sx: i - e.left,
            sy: s - e.top
        }
    }
    onGestureStart(t)
    {
        t.preventDefault(),
        t.stopPropagation(),
        this._noteUserInteraction(),
        this._stopPinchInertia(),
        this._pinchZooming = !0;
        const {sx: e, sy: i} = this._eventToLocalXY(t),
            s = this._screenPointToLatLon(e, i);
        this._gesture = {
            startZoom: this.zoom,
            startScale: "number" == typeof t.scale && isFinite(t.scale) && t.scale > 0 ? t.scale : 1,
            anchorLat: s.lat,
            anchorLon: s.lon,
            sx: e,
            sy: i
        },
        this._pinchAnchorSX = e,
        this._pinchAnchorSY = i
    }
    onGestureChange(t)
    {
        if (!this._gesture)
            return;
        t.preventDefault(),
        t.stopPropagation(),
        this._noteUserInteraction(),
        this._pinchZooming = !0;
        const {sx: e, sy: i} = this._eventToLocalXY(t);
        this._gesture.sx = e,
        this._gesture.sy = i;
        const s = "number" == typeof t.scale && isFinite(t.scale) && t.scale > 0 ? t.scale : 1,
            a = Math.max(.2, Math.min(5, s / (this._gesture.startScale || 1))),
            n = Math.log2(a),
            o = clamp(this._gesture.startZoom + n, this._zoomMin, this._zoomMax),
            l = this.zoom;
        this._setZoomAroundScreenPoint(o, e, i),
        this._requestZoomRedraw(),
        this._notifyViewChanged(),
        this._pinchAnchorSX = e,
        this._pinchAnchorSY = i,
        this._notePinchVelocity(o - l, performance.now())
    }
    onGestureEnd(t)
    {
        this._gesture && (t.preventDefault(), t.stopPropagation(), this._gesture = null, this._startPinchInertia())
    }
    onTouchStart(t)
    {
        t.preventDefault(),
        this._touchActive = !0,
        this._noteUserInteraction(),
        this._stopPinchInertia();
        const e = t.touches;
        if (0 === e.length)
            return;
        const i = this.overlayCanvas.getBoundingClientRect();
        let s = 0,
            a = 0;
        for (let t = 0; t < e.length; t++)
            s += e[t].clientX - i.left,
            a += e[t].clientY - i.top;
        const n = s / e.length,
            o = a / e.length;
        if (e.length >= 2) {
            const t = i.height,
                s = 130;
            for (let a = 0; a < e.length; a++) {
                if (e[a].clientY - i.top > t - s)
                    return void (this._touchActive = !1)
            }
        }
        let l = 0;
        if (e.length >= 2) {
            const t = e[0].clientX - e[1].clientX,
                i = e[0].clientY - e[1].clientY;
            l = Math.sqrt(t * t + i * i),
            this._pinchZooming = !0
        }
        const r = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
        this._touchState = {
            startTouches: e.length,
            startMidpoint: {
                x: n,
                y: o
            },
            startCenterWorld: {
                x: r.x,
                y: r.y,
                ws: r.ws
            },
            startZoom: this.zoom,
            lastPinchDist: l,
            lastMidpoint: {
                x: n,
                y: o
            },
            tapCandidate: 1 === e.length,
            tapStartTime: performance.now(),
            tapStartPos: {
                x: n,
                y: o
            }
        },
        this._pinchAnchorSX = n,
        this._pinchAnchorSY = o
    }
    onTouchMove(t)
    {
        if (!this._touchState)
            return;
        t.preventDefault(),
        this._noteUserInteraction();
        const e = t.touches;
        if (0 === e.length)
            return;
        const i = this.overlayCanvas.getBoundingClientRect();
        let s = 0,
            a = 0;
        for (let t = 0; t < e.length; t++)
            s += e[t].clientX - i.left,
            a += e[t].clientY - i.top;
        const n = s / e.length,
            o = a / e.length;
        if (e.length >= 2) {
            this._pinchZooming = !0;
            const t = e[0].clientX - e[1].clientX,
                i = e[0].clientY - e[1].clientY,
                s = Math.sqrt(t * t + i * i);
            if (this._touchState.lastPinchDist > 0 && s > 0) {
                const t = s / this._touchState.lastPinchDist,
                    e = Math.log2(t),
                    i = this.zoom,
                    a = clamp(this.zoom + e, this._zoomMin, this._zoomMax);
                this._setZoomAroundScreenPoint(a, n, o),
                this._notePinchVelocity(a - i, performance.now())
            }
            this._touchState.lastPinchDist = s
        }
        const l = n - this._touchState.lastMidpoint.x,
            r = o - this._touchState.lastMidpoint.y;
        if (Math.abs(l) > .5 || Math.abs(r) > .5) {
            const t = latLonToWorld(this.center.lat, this.center.lon, this.zoom),
                e = t.x - l,
                i = clamp(t.y - r, 0, t.ws - 1),
                s = worldToLatLon(e, i, this.zoom);
            this.center = {
                lat: s.lat,
                lon: s.lon
            }
        }
        if (this._touchState.tapCandidate && this._touchState.tapStartPos) {
            const t = n - this._touchState.tapStartPos.x,
                e = o - this._touchState.tapStartPos.y;
            (Math.abs(t) > 25 || Math.abs(e) > 25) && (this._touchState.tapCandidate = !1)
        }
        this._touchState.lastMidpoint = {
            x: n,
            y: o
        },
        this._pinchAnchorSX = n,
        this._pinchAnchorSY = o,
        this._requestPanRedraw()
    }
    onTouchEnd(t)
    {
        if (!this._touchState)
            return;
        t.preventDefault();
        const e = t.touches.length;
        if (0 === e) {
            const t = this._touchState.tapCandidate && 1 === this._touchState.startTouches && performance.now() - this._touchState.tapStartTime < 300,
                e = this._touchState.tapStartPos;
            this._touchActive = !1,
            this._tileRedrawPending && (this._tileRedrawPending = !1, this._scheduleTileRedraw()),
            this._pinchZooming && !this._pinchInertiaRAF ? this._startPinchInertia() : this._pinchZooming || this._requestZoomRedraw(),
            t && e && this._handleTapSelection(e.x, e.y),
            this._touchState = null
        } else if (1 === e && this._touchState.startTouches >= 2) {
            const e = this.overlayCanvas.getBoundingClientRect(),
                i = t.touches[0],
                s = i.clientX - e.left,
                a = i.clientY - e.top;
            this._touchState.lastMidpoint = {
                x: s,
                y: a
            },
            this._touchState.lastPinchDist = 0,
            this._touchState.startTouches = 1,
            this._pinchZooming = !1,
            this._stopPinchInertia(),
            this._requestZoomRedraw()
        }
    }
    setTheme(t)
    {
        const e = String(t || ""),
            i = TILE_THEMES[e] || TILE_THEMES.carto_voyager;
        this.themeKey = TILE_THEMES[e] ? e : "carto_voyager",
        this.tileTemplate = i.template,
        this.tileSubdomains = i.subdomains,
        this._tileEpoch++,
        this.tileCache.clear(),
        this._tilesSnapshotCanvas = null,
        this._tilesSnapshotMeta = null,
        this._lastTilesViewSig = null,
        this.draw(this.lastState)
    }
    onMouseDown(t)
    {
        if (0 !== t.button)
            return;
        this._noteUserInteraction(),
        this._stopPinchInertia(),
        this._pinchZooming = !1,
        this._mouseDragging = !0,
        this._mouseDragMoved = !1,
        this._mouseDragStart = {
            x: t.clientX,
            y: t.clientY
        };
        const e = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
        this._mouseDragCenterStart = {
            x: e.x,
            y: e.y,
            ws: e.ws
        }
    }
    onMouseMove(t)
    {
        if (this._pbDrag && this.playbackMode) {
            const e = performance.now(),
                i = t.clientX - (this._pbDrag.lastClient?.x ?? t.clientX),
                s = t.clientY - (this._pbDrag.lastClient?.y ?? t.clientY);
            Math.abs(i) + Math.abs(s) > 2 && (this._mouseDragMoved = !0);
            const a = null != this._pbDrag.lastMoveMs && isFinite(this._pbDrag.lastMoveMs) ? this._pbDrag.lastMoveMs : e,
                n = Math.max(1, e - a),
                o = i / n,
                l = s / n,
                r = this._pbDrag.vel || {
                    x: 0,
                    y: 0
                },
                h = .25;
            this._pbDrag.vel = {
                x: r.x * (1 - h) + o * h,
                y: r.y * (1 - h) + l * h
            },
            this._pbDrag.lastMoveMs = e,
            this._pbDrag.lastClient = {
                x: t.clientX,
                y: t.clientY
            },
            this._pbDrag.cursorClient = {
                x: t.clientX,
                y: t.clientY
            };
            const c = this.lastState,
                d = (c && Array.isArray(c.mobile) ? c.mobile : []).find(t => t && null != t.id && String(t.id) === String(this._pbDrag.id)) || null;
            if (d) {
                const e = this._closestPlaybackPathPointForMobileAtClientXY(d, t.clientX, t.clientY);
                if (e && isFinite(e.tMs)) {
                    const t = this.getPlaybackBounds(),
                        i = e.tMs;
                    if (isFinite(t.minMs) && isFinite(t.maxMs)) {
                        const e = clamp(i, t.minMs, t.maxMs);
                        this.setPlaybackTimeMs(e),
                        this._playbackLiveFollow = !1,
                        "function" == typeof this._resetLiveTracking && this._resetLiveTracking()
                    } else
                        this.setPlaybackTimeMs(i),
                        this._playbackLiveFollow = !1,
                        "function" == typeof this._resetLiveTracking && this._resetLiveTracking()
                }
                this.drawOverlay(this.lastState)
            }
            return
        }
        if (!this._mouseDragging || !this._mouseDragStart || !this._mouseDragCenterStart)
            return;
        this._noteUserInteraction();
        const e = t.clientX - this._mouseDragStart.x,
            i = t.clientY - this._mouseDragStart.y;
        Math.abs(e) + Math.abs(i) > 3 && (this._mouseDragMoved = !0);
        const s = this._mouseDragCenterStart.x - e,
            a = clamp(this._mouseDragCenterStart.y - i, 0, this._mouseDragCenterStart.ws - 1),
            n = worldToLatLon(s, a, this.zoom);
        this.center = {
            lat: n.lat,
            lon: n.lon
        },
        this._pinchInertiaRAF || this._requestPanRedraw()
    }
    onMouseUp()
    {
        if (this._pbDrag) {
            const t = this._pbDrag;
            this._pbDrag = null;
            try {
                this._startPbMarkerInertiaFromDrag(t)
            } catch {}
            return this.setPlaybackPlaying(!0), void ("function" == typeof window.__ensurePlaybackLoop && window.__ensurePlaybackLoop())
        }
        this._mouseDragging = !1,
        this._mouseDragStart = null,
        this._mouseDragCenterStart = null,
        this._redrawViewOnly()
    }
    _getOverlayPaddingPx()
    {
        const t = this.overlayCanvas.getBoundingClientRect(),
            e = {
                left: 24,
                right: 24,
                top: 24,
                bottom: 24
            },
            i = ["sidebar", "details"];
        for (const s of i) {
            const i = document.getElementById(s);
            if (!i)
                continue;
            const a = i.getBoundingClientRect();
            if (a.width <= 0 || a.height <= 0)
                continue;
            const n = Math.max(t.left, a.left),
                o = Math.min(t.right, a.right),
                l = Math.max(t.top, a.top),
                r = Math.min(t.bottom, a.bottom);
            o <= n || r <= l || (a.left <= t.left + 40 ? e.left = Math.max(e.left, o - t.left + 14) : a.right >= t.right - 40 && (e.right = Math.max(e.right, t.right - n + 14)))
        }
        return e
    }
    _animateTo({centerLat: t, centerLon: e, zoom: i}, {durationMs: s=420, isAutoCamera: a=!1}={})
    {
        const n = this.center.lat,
            o = this.center.lon,
            l = this.zoom,
            r = Number(t),
            h = Number(e),
            c = clamp(Number(i), this._zoomMin || 1, this._zoomMax || 20);
        if (!isFinite(r) || !isFinite(h) || !isFinite(c))
            return;
        if (!isFinite(n) || !isFinite(o) || !isFinite(l))
            return;
        const d = performance.now(),
            u = Math.max(120, s);
        this._centerAnimRAF && cancelAnimationFrame(this._centerAnimRAF),
        this._isAutoCameraAnimating = a;
        const _ = Math.abs(c - l) > 1e-6;
        let m = 0;
        const p = Math.ceil(u / 8) + 60,
            f = () => {
                this._centerAnimRAF = null,
                this.draw(this.lastState),
                this._notifyViewChanged(),
                this._isAutoCameraAnimating = !1,
                a && (this._autoCameraCooldownMs = 3e5)
            },
            g = () => {
                if (m++, m > p)
                    return console.warn("_animateTo: exceeded max frames, forcing completion"), this.zoom = c, this.center = {
                        lat: r,
                        lon: h
                    }, void f();
                const t = clamp((performance.now() - d) / u, 0, 1),
                    e = t * t * (3 - 2 * t);
                this.zoom = l + (c - l) * e,
                this.center = {
                    lat: n + (r - n) * e,
                    lon: o + (h - o) * e
                },
                _ ? this.draw(this.lastState) : this._redrawViewOnly(),
                this._notifyViewChanged(),
                t < 1 ? this._centerAnimRAF = requestAnimationFrame(g) : f()
            };
        this._centerAnimRAF = requestAnimationFrame(g)
    }
    fitTrailBounds(t, {animate: e=!0}={})
    {
        const i = Array.isArray(t) ? t : [];
        let s = 1 / 0,
            a = -1 / 0,
            n = 1 / 0,
            o = -1 / 0,
            l = 0;
        for (const t of i) {
            const e = Number(t.lat),
                i = Number(t.lon);
            isFinite(e) && isFinite(i) && (s = Math.min(s, e), a = Math.max(a, e), n = Math.min(n, i), o = Math.max(o, i), l++)
        }
        0 !== l && this.fitBoundsLatLon({
            minLat: s,
            minLon: n,
            maxLat: a,
            maxLon: o
        }, {
            animate: e
        })
    }
    fitBoundsLatLon({minLat: t, minLon: e, maxLat: i, maxLon: s}, {animate: a=!0}={})
    {
        const n = 256,
            o = lonToX(e, n),
            l = lonToX(s, n),
            r = latToY(i, n),
            h = latToY(t, n),
            c = Math.max(1e-6, Math.abs(l - o)),
            d = Math.max(1e-6, Math.abs(h - r)),
            u = this.overlayCanvas.getBoundingClientRect(),
            _ = u.width,
            m = u.height,
            p = this._getOverlayPaddingPx(),
            f = Math.max(40, _ - p.left - p.right),
            g = Math.max(40, m - p.top - p.bottom),
            M = Math.min(f / c, g / d);
        let y = Math.log2(M);
        y -= .18,
        y = clamp(y, this._zoomMin, this._zoomMax);
        const b = worldToLatLon((o + l) / 2, (r + h) / 2, 0),
            x = p.left + f / 2,
            S = p.top + g / 2,
            w = latLonToWorld(b.lat, b.lon, y),
            v = w.x - (x - _ / 2),
            F = w.y - (S - m / 2),
            P = worldToLatLon(v, clamp(F, 0, w.ws - 1), y);
        a ? this._animateTo({
            centerLat: P.lat,
            centerLon: P.lon,
            zoom: y
        }, {
            durationMs: 320
        }) : (this.center = {
            lat: P.lat,
            lon: P.lon
        }, this.zoom = y, this.draw(this.lastState))
    }
    _screenPointToLatLon(t, e)
    {
        const i = this.tilesCanvas.getBoundingClientRect(),
            s = i.width,
            a = i.height,
            n = latLonToWorld(this.center.lat, this.center.lon, this.zoom),
            o = n.x - s / 2 + t,
            l = n.y - a / 2 + e,
            r = clamp(l, 0, n.ws - 1);
        return worldToLatLon(o, r, this.zoom)
    }
    _setZoomAroundScreenPoint(t, e, i)
    {
        const s = this.tilesCanvas.getBoundingClientRect(),
            a = s.width,
            n = s.height,
            o = clamp(t, this._zoomMin, this._zoomMax),
            l = this._screenPointToLatLon(e, i),
            r = latLonToWorld(l.lat, l.lon, o),
            h = {
                x: r.x - (e - a / 2),
                y: r.y - (i - n / 2),
                ws: r.ws
            },
            c = worldToLatLon(h.x, clamp(h.y, 0, r.ws - 1), o);
        this.zoom = o,
        this.center = {
            lat: c.lat,
            lon: c.lon
        }
    }
    centerOn(t, e, {animate: i=!0}={})
    {
        const s = Number(t),
            a = Number(e);
        if (isFinite(s) && isFinite(a))
            return i ? void this._animateTo({
                centerLat: s,
                centerLon: a,
                zoom: this.zoom
            }, {
                durationMs: 220
            }) : (this.center = {
                lat: s,
                lon: a
            }, void this.draw(this.lastState))
    }
    cancelSelectionOrchestration()
    {
        this._selectOrchRAF && cancelAnimationFrame(this._selectOrchRAF),
        this._selectOrchRAF = null,
        this._selectOrch = null;
        const t = performance.now();
        for (const [e, i] of this._traceSelectionWarpById.entries()) {
            const s = t - Number(i?.t0Ms),
                a = Number(i?.durationMs);
            (!isFinite(s) || !isFinite(a) || s >= a) && this._traceSelectionWarpById.delete(e)
        }
    }
    _latLonComfortablyInView(t, e)
    {
        const i = Number(t),
            s = Number(e);
        if (!isFinite(i) || !isFinite(s))
            return !1;
        const a = this._cssW || 1,
            n = this._cssH || 1,
            o = latLonToWorld(this.center.lat, this.center.lon, this.zoom),
            l = latLonToWorld(i, s, this.zoom),
            r = l.x - o.x + a / 2,
            h = l.y - o.y + n / 2,
            c = .22 * a,
            d = .22 * n;
        return r >= c && r <= a - c && h >= d && h <= n - d
    }
    _computeFocusedCenterFor(t, e)
    {
        if (this._latLonComfortablyInView(t, e))
            return {
                lat: this.center.lat,
                lon: this.center.lon,
                needsMove: !1
            };
        const i = Number(t),
            s = Number(e),
            a = this._cssW || 1,
            n = this._cssH || 1,
            o = latLonToWorld(this.center.lat, this.center.lon, this.zoom),
            l = latLonToWorld(i, s, this.zoom),
            r = l.x - o.x,
            h = l.y - o.y,
            c = Math.max(Math.abs(r) / Math.max(1, a / 2), Math.abs(h) / Math.max(1, n / 2)) > .85 ? 1 : .72,
            d = {
                x: o.x + r * c,
                y: o.y + h * c,
                ws: o.ws
            },
            u = worldToLatLon(d.x, clamp(d.y, 0, o.ws - 1), this.zoom);
        return {
            lat: u.lat,
            lon: u.lon,
            needsMove: !0
        }
    }
    orchestrateSelectionToLatest(t, {fitTrail: e=!1}={})
    {
        if (!t || !t.id)
            return;
        if (e)
            return;
        if (this.playbackMode)
            return;
        const i = String(t.id),
            s = Number(t.lat),
            a = Number(t.lon);
        if (!isFinite(s) || !isFinite(a))
            return;
        this.cancelSelectionOrchestration();
        const n = performance.now(),
            o = this._computeFocusedCenterFor(s, a);
        let l = !1,
            r = s,
            h = a;
        if (this.traceMode && this._traceActiveRouteById.has(i)) {
            const e = this._traceSampleForMobile(t, n);
            if (e && isFinite(e.lat) && isFinite(e.lon)) {
                r = e.lat,
                h = e.lon;
                const t = haversineMeters(r, h, s, a);
                l = isFinite(t) && t > 25
            }
        }
        const c = l ? 1400 : 0,
            d = l ? 500 : 0,
            u = o.needsMove ? l ? 420 : 320 : 0;
        l && this._traceSelectionWarpById.set(i, {
            t0Ms: n,
            fromLat: r,
            fromLon: h,
            homeLat: s,
            homeLon: a,
            fadeMs: 500,
            durationMs: c
        }),
        this._selectOrch = {
            id: i,
            t0Ms: n,
            homeLat: s,
            homeLon: a,
            camTo: {
                lat: o.lat,
                lon: o.lon
            },
            camFrom: null,
            camDelayMs: d,
            camDurMs: u,
            warpDurMs: c
        };
        const _ = () => {
            this._selectOrchRAF = null;
            const t = this._selectOrch;
            if (!t || t.id !== i)
                return;
            const e = performance.now() - t.t0Ms,
                s = t.camDelayMs,
                a = t.camDelayMs + t.camDurMs;
            if (t.camDurMs > 0 && e >= s && e <= a) {
                t.camFrom || (t.camFrom = {
                    lat: this.center.lat,
                    lon: this.center.lon
                });
                const i = clamp((e - s) / Math.max(1, t.camDurMs), 0, 1),
                    a = 1 - Math.pow(1 - i, 3),
                    n = t.camFrom.lat + (t.camTo.lat - t.camFrom.lat) * a,
                    o = t.camFrom.lon + (t.camTo.lon - t.camFrom.lon) * a;
                this.center = {
                    lat: n,
                    lon: o
                },
                this._invalidateOverlayStatic(),
                this.draw(this.lastState),
                this._notifyViewChanged()
            } else
                t.camDurMs > 0 && e > a && t.camFrom && (this.center = {
                    lat: t.camTo.lat,
                    lon: t.camTo.lon
                }, t.camDurMs = 0, this._invalidateOverlayStatic(), this.draw(this.lastState), this._notifyViewChanged());
            e < Math.max(t.warpDurMs || 0, (t.camDelayMs || 0) + (t.camDurMs || 0)) ? this._selectOrchRAF = requestAnimationFrame(_) : this._selectOrch = null
        };
        this._selectOrchRAF = requestAnimationFrame(_)
    }
    setSelected(t)
    {
        const e = t || null;
        this.selectedId !== e && (this.selectedId = e, e || (this._selectedPollutantKey = null), this._invalidateOverlayStatic(), this.drawOverlay(this.lastState))
    }
    getSelectedPollutantKey()
    {
        return this._selectedPollutantKey || null
    }
    setShowFixed(t)
    {
        const e = !!t;
        this.showFixed !== e && (this.showFixed = e, this._invalidateOverlayStatic(), this.drawOverlay(this.lastState))
    }
    setTraceMode(t)
    {
        this.traceMode = !!t,
        this.traceMode ? (this._traceLastFrameTs = 0, this._traceInitialRunDoneById.clear(), this._traceCycleStartMsById.clear(), this._invalidateOverlayStatic(), this._traceRAF || (this._traceRAF = requestAnimationFrame(() => this._traceTick()))) : (this._traceRAF && cancelAnimationFrame(this._traceRAF), this._traceRAF = null, this._traceLastFrameTs = 0, this.drawOverlay(this.lastState))
    }
    setPlaybackMode(t)
    {
        this.playbackMode = !!t,
        this.playbackMode || (this._playbackPlaying = !1, this._playbackNewestSegmentStartMs = null, this._playbackLastMaxMs = null),
        this._playbackInitialized = !1,
        this._invalidateOverlayStatic(),
        this.drawOverlay(this.lastState)
    }
    setPlaybackPlaying(t)
    {
        this._playbackPlaying = !!t
    }
    _playbackMarkNewestSegmentFromBounds(t, e)
    {
        const i = null != t ? Number(t) : null,
            s = null != e ? Number(e) : null;
        null != i && null != s && isFinite(i) && isFinite(s) && s > i + 500 && (this._playbackNewestSegmentStartMs = i),
        this._playbackLastMaxMs = null != s && isFinite(s) ? s : this._playbackLastMaxMs
    }
    isPlaybackAtEnd(t=100)
    {
        const e = this.getPlaybackBounds(),
            i = this.getPlaybackTimeMs();
        return !(null == e.maxMs || !isFinite(Number(e.maxMs))) && (!(null == i || !isFinite(Number(i))) && Math.abs(Number(e.maxMs) - Number(i)) <= (Number(t) || 0))
    }
    setPlaybackSpeed(t)
    {
        const e = Number(t);
        this._playbackSpeed = isFinite(e) && e > 0 ? e : 1
    }
    setPlaybackTimeMs(t)
    {
        const e = Number(t);
        this._playbackNowMs = isFinite(e) ? e : null
    }
    getPlaybackBounds()
    {
        return {
            minMs: this._playbackMinMs,
            maxMs: this._playbackMaxMs
        }
    }
    getPlaybackTimeMs()
    {
        return this._playbackNowMs
    }
    getPlaybackPlaying()
    {
        return !!this._playbackPlaying
    }
    getPlaybackSpeed()
    {
        return this._playbackSpeed
    }
    _hitTestMobileAtClientXY(t, e, i)
    {
        const s = this.lastState,
            a = s && Array.isArray(s.mobile) ? s.mobile : [],
            n = this.overlayCanvas.getBoundingClientRect(),
            o = t - n.left,
            l = e - n.top,
            r = n.width,
            h = n.height,
            c = latLonToWorld(this.center.lat, this.center.lon, this.zoom),
            d = (t, e) => ({
                x: t - c.x + r / 2,
                y: e - c.y + h / 2
            });
        for (const t of a) {
            const e = this._mobilePoseForRender(t, i),
                s = Number(e?.lat),
                a = Number(e?.lon);
            if (!isFinite(s) || !isFinite(a))
                continue;
            const n = latLonToWorld(s, a, this.zoom),
                r = d(n.x, n.y),
                h = r.x - o,
                c = r.y - l;
            if (h * h + c * c <= 400)
                return t
        }
        return null
    }
    _closestPlaybackPathPointForMobileAtClientXY(t, e, i)
    {
        if (!this.playbackMode)
            return null;
        const s = t && null != t.id ? String(t.id) : "";
        if (!s)
            return null;
        this._ensurePlaybackPoints(this.lastState);
        const a = this._playbackPtsById.get(s);
        if (!a || a.length < 2)
            return null;
        const n = this.overlayCanvas.getBoundingClientRect(),
            o = e - n.left,
            l = i - n.top,
            r = n.width,
            h = n.height,
            c = latLonToWorld(this.center.lat, this.center.lon, this.zoom),
            d = (t, e) => {
                const i = latLonToWorld(t, e, this.zoom);
                return {
                    x: i.x - c.x + r / 2,
                    y: i.y - c.y + h / 2
                }
            },
            u = (t, e, i, s, a, n) => {
                const o = i - t,
                    l = s - e,
                    r = o * o + l * l;
                let h = 0;
                r > 1e-9 && (h = ((a - t) * o + (n - e) * l) / r),
                h = clamp(h, 0, 1);
                const c = t + o * h,
                    d = e + l * h,
                    u = a - c,
                    _ = n - d;
                return {
                    t: h,
                    cx: c,
                    cy: d,
                    d2: u * u + _ * _
                }
            },
            _ = a.length,
            m = Math.max(1, Math.floor(_ / 520));
        let p = {
            i: 0,
            t: 0,
            cx: 0,
            cy: 0,
            d2: 1 / 0
        };
        const f = (t, e, i) => {
            const s = Math.max(0, t),
                n = Math.min(_ - 2, e);
            for (let t = s; t <= n; t += i) {
                const e = a[t],
                    i = a[t + 1],
                    s = d(e.lat, e.lon),
                    n = d(i.lat, i.lon),
                    r = u(s.x, s.y, n.x, n.y, o, l);
                r.d2 < p.d2 && (p = {
                    i: t,
                    t: r.t,
                    cx: r.cx,
                    cy: r.cy,
                    d2: r.d2
                })
            }
        };
        f(0, _ - 2, m);
        const g = Math.max(24, 7 * m);
        f(p.i - g, p.i + g, 1);
        const M = a[p.i],
            y = a[p.i + 1];
        return {
            tMs: M.tMs + (y.tMs - M.tMs) * p.t,
            distPx: Math.sqrt(p.d2),
            segI: p.i,
            segT: p.t,
            closest: {
                x: p.cx,
                y: p.cy
            },
            cursor: {
                x: o,
                y: l
            }
        }
    }
    _startPbMarkerInertiaFromDrag(t)
    {
        if (!this.playbackMode)
            return;
        const e = t && null != t.id ? String(t.id) : "";
        if (!e)
            return;
        const i = t && t.cursorClient ? t.cursorClient : t && t.lastClient ? t.lastClient : null;
        if (!i)
            return;
        const s = t && t.vel ? t.vel : {
                x: 0,
                y: 0
            },
            a = Number(s.x) || 0,
            n = Number(s.y) || 0,
            o = Math.hypot(a, n);
        if (!isFinite(o) || o < .05)
            return;
        const l = performance.now();
        this._pbInertia2d = {
            id: e,
            t0Ms: l,
            lastMs: l,
            posClient: {
                x: Number(i.x) || 0,
                y: Number(i.y) || 0
            },
            vel: {
                x: a,
                y: n
            }
        }
    }
    _hasPbMarkerInertia()
    {
        return !(!this._pbInertia2d || !this._pbInertia2d.id)
    }
    _stepPbMarkerInertia(t, e)
    {
        const i = this._pbInertia2d;
        if (!i || !i.id)
            return !1;
        const s = Math.max(0, Number(e) || 0);
        if (!(s > 0))
            return !1;
        if (t - (i.t0Ms || t) > 900)
            return this._pbInertia2d = null, !1;
        i.posClient.x += (i.vel.x || 0) * s,
        i.posClient.y += (i.vel.y || 0) * s;
        const a = Math.pow(.992, s);
        i.vel.x *= a,
        i.vel.y *= a;
        const n = Math.hypot(i.vel.x || 0, i.vel.y || 0);
        if (!isFinite(n) || n < .02)
            return this._pbInertia2d = null, !1;
        const o = this.lastState,
            l = (o && Array.isArray(o.mobile) ? o.mobile : []).find(t => t && null != t.id && String(t.id) === String(i.id)) || null;
        if (!l)
            return this._pbInertia2d = null, !1;
        const r = this._closestPlaybackPathPointForMobileAtClientXY(l, i.posClient.x, i.posClient.y);
        if (r && isFinite(r.tMs)) {
            const t = this.getPlaybackBounds(),
                e = r.tMs;
            if (isFinite(t.minMs) && isFinite(t.maxMs)) {
                const i = clamp(e, t.minMs, t.maxMs);
                this.setPlaybackTimeMs(i),
                this._playbackLiveFollow = !1,
                "function" == typeof this._resetLiveTracking && this._resetLiveTracking()
            } else
                this.setPlaybackTimeMs(e),
                this._playbackLiveFollow = !1,
                "function" == typeof this._resetLiveTracking && this._resetLiveTracking();
            return !0
        }
        return !1
    }
    _scrubPlaybackTimeForMobileAtClientXY(t, e, i)
    {
        const s = this._closestPlaybackPathPointForMobileAtClientXY(t, e, i);
        if (!s || !isFinite(s.tMs))
            return;
        const a = this.getPlaybackBounds();
        if (isFinite(a.minMs) && isFinite(a.maxMs)) {
            let t = clamp(s.tMs, a.minMs, a.maxMs);
            this.setPlaybackTimeMs(t)
        } else
            this.setPlaybackTimeMs(s.tMs)
    }
    _traceTick()
    {
        if (this._traceRAF = null, !this.traceMode || this.playbackMode)
            return;
        const t = performance.now(),
            e = 1e3 / (this._traceTargetFPS || 30);
        this._traceLastFrameTs > 0 && t - this._traceLastFrameTs < e - .5 || (this._traceLastFrameTs = t, this.drawOverlay(this.lastState, {
            nowMs: t,
            fromTraceTick: !0
        })),
        this._traceRAF = requestAnimationFrame(() => this._traceTick())
    }
    _hash01(t)
    {
        const e = String(t || "");
        let i = 2166136261;
        for (let t = 0; t < e.length; t++)
            i ^= e.charCodeAt(t),
            i = Math.imul(i, 16777619);
        return (i >>> 0) % 1e5 / 1e5
    }
    _traceSampleForMobile(t, e)
    {
        const i = t && t.id ? String(t.id) : "";
        if (t && t.ghosted) {
            const s = Number(t.lat),
                a = Number(t.lon),
                n = this._traceAngleById.get(i),
                o = null != n && isFinite(n) ? n : 0;
            this._traceAngleById.set(i, o),
            this._traceAngleLastMsById.set(i, e),
            t._key || (t._key = keyFor("mobile", t.id));
            const l = t._key,
                r = this.selectedId === l,
                h = .25;
            return {
                lat: s,
                lon: a,
                angle: o,
                flipX: !1,
                speedMps: 0,
                opacity: this._pbDebugPath || r ? 1 : h
            }
        }
        let s = this._traceActiveRouteById.get(i) || null;
        if (!s || !s.pts || s.pts.length < 2) {
            if (s = this._tracePendingRouteById.get(i) || null, !s || !s.pts || s.pts.length < 2)
                return null;
            this._traceActiveRouteById.set(i, s),
            this._tracePendingRouteById.delete(i)
        }
        let a = s.driveMs || 1,
            n = s.pauseMs || 0,
            o = s.returnMs || 0,
            l = s.totalMs || a + n + o,
            r = this._traceCycleStartMsById.get(i);
        null != r && isFinite(r) || (r = e);
        let h = e - r;
        if (isFinite(h) || (h = 0), h >= l) {
            const t = this._tracePendingRouteById.get(i);
            if (t && t.pts && t.pts.length >= 2)
                s = t,
                this._traceActiveRouteById.set(i, t),
                this._tracePendingRouteById.delete(i),
                a = s.driveMs || 1,
                n = s.pauseMs || 0,
                o = s.returnMs || 0,
                l = s.totalMs || a + n + o,
                r = e,
                h = 0;
            else {
                const t = Math.max(100, l);
                r += Math.floor(h / t) * t,
                h = e - r
            }
        }
        this._traceCycleStartMsById.set(i, r);
        const c = h,
            d = a + n,
            u = a + n + (o || 0),
            _ = c >= a && c < d,
            m = c >= d && c < u && (o || 0) > 0,
            p = c < a ? c : a,
            f = s.segStartMs,
            g = s.segDurMs,
            M = s.pts;
        let y = 0,
            b = 0,
            x = f.length - 1;
        for (; b <= x;) {
            const t = b + x >> 1,
                e = f[t],
                i = e + (g[t] || 1);
            if (p < e)
                x = t - 1;
            else {
                if (!(p >= i)) {
                    y = t;
                    break
                }
                b = t + 1
            }
        }
        y < 0 && (y = 0),
        y >= f.length && (y = f.length - 1);
        const S = f[y],
            w = Math.max(1, g[y] || 1),
            v = clamp((p - S) / w, 0, 1),
            F = M[y],
            P = M[y + 1] || M[y];
        let T = F.lat + (P.lat - F.lat) * v,
            I = F.lon + (P.lon - F.lon) * v,
            A = s.segRealSpeedMps && isFinite(s.segRealSpeedMps[y]) ? s.segRealSpeedMps[y] : 0,
            C = 1;
        if (_) {
            const t = M[M.length - 1] || P;
            T = t.lat,
            I = t.lon,
            A = 0
        } else if (m) {
            const t = M[M.length - 1] || P,
                e = isFinite(Number(s.loopStartLat)) ? Number(s.loopStartLat) : M[0]?.lat ?? t.lat,
                i = isFinite(Number(s.loopStartLon)) ? Number(s.loopStartLon) : M[0]?.lon ?? t.lon,
                a = clamp((c - d) / Math.max(1, o || 1), 0, 1);
            T = t.lat + (e - t.lat) * a,
            I = t.lon + (i - t.lon) * a;
            const n = haversineMeters(t.lat, t.lon, e, i) / Math.max(.001, (o || 1) / 1e3);
            A = clamp(n, 0, Number(this._traceRealMaxSpeedMps) || 20);
            const l = 500,
                r = c - d,
                h = u - c;
            C = r <= l ? clamp(1 - r / l, 0, 1) : h <= l ? clamp(1 - h / l, 0, 1) : 0
        }
        const L = this._traceSelectionWarpById.get(i);
        if (L) {
            const t = Number(L.t0Ms),
                s = Number(L.fadeMs) || 500,
                a = Number(L.durationMs) || 1400,
                n = e - t;
            if (!isFinite(n) || n < 0)
                ;
            else if (n >= a) {
                this._traceSelectionWarpById.delete(i);
                const t = this._traceActiveRouteById.get(i);
                t && isFinite(Number(t.driveMs)) && this._traceCycleStartMsById.set(i, e - Number(t.driveMs))
            } else {
                const t = Number(L.fromLat),
                    e = Number(L.fromLon),
                    i = Number(L.homeLat),
                    o = Number(L.homeLon),
                    l = Math.max(1, a - 2 * s);
                if (n <= s)
                    T = isFinite(t) ? t : T,
                    I = isFinite(e) ? e : I,
                    A = 0,
                    C *= clamp(1 - n / Math.max(1, s), 0, 1);
                else if (n >= a - s) {
                    T = isFinite(i) ? i : T,
                    I = isFinite(o) ? o : I,
                    A = 0;
                    const t = (n - (a - s)) / Math.max(1, s);
                    C *= clamp(t, 0, 1)
                } else {
                    const a = clamp((n - s) / l, 0, 1);
                    isFinite(t) && isFinite(i) && (T = t + (i - t) * a),
                    isFinite(e) && isFinite(o) && (I = e + (o - e) * a),
                    A = 0,
                    C = 0
                }
            }
        }
        let k = F.lat,
            R = F.lon,
            N = P.lat,
            E = P.lon;
        if (_) {
            const t = M[Math.max(0, M.length - 2)] || F,
                e = M[Math.max(0, M.length - 1)] || P;
            k = t.lat,
            R = t.lon,
            N = e.lat,
            E = e.lon
        } else if (m) {
            const t = M[M.length - 1] || P,
                e = isFinite(Number(s.loopStartLat)) ? Number(s.loopStartLat) : M[0]?.lat ?? t.lat,
                i = isFinite(Number(s.loopStartLon)) ? Number(s.loopStartLon) : M[0]?.lon ?? t.lon;
            k = t.lat,
            R = t.lon,
            N = e,
            E = i
        }
        const D = latLonToWorld(k, R, this.zoom),
            B = latLonToWorld(N, E, this.zoom);
        let $ = B.x - D.x,
            z = B.y - D.y;
        if (Math.abs($) < 1e-4 && Math.abs(z) < 1e-4) {
            const t = Math.max(0, Math.min(M.length - 2, M.length - 2)),
                e = latLonToWorld(M[t].lat, M[t].lon, this.zoom),
                i = latLonToWorld(M[t + 1].lat, M[t + 1].lon, this.zoom);
            $ = i.x - e.x,
            z = i.y - e.y
        }
        const W = Math.atan2(z, $),
            O = Math.abs(W),
            V = Math.PI / 2 + .22,
            H = Math.PI / 2 - .22;
        let K = this._traceLastSideById.get(i);
        "L" !== K && "R" !== K && (K = O > Math.PI / 2 ? "L" : "R"),
        "R" === K && O > V ? K = "L" : "L" === K && O < H && (K = "R"),
        this._traceLastSideById.set(i, K);
        let U = W;
        "L" === K && (U = Math.PI - W),
        U > Math.PI && (U -= 2 * Math.PI),
        U < -Math.PI && (U += 2 * Math.PI);
        const G = t => {
                let e = t;
                for (; e > Math.PI;)
                    e -= 2 * Math.PI;
                for (; e < -Math.PI;)
                    e += 2 * Math.PI;
                return e
            },
            Y = this._traceAngleById.get(i),
            X = this._traceAngleLastMsById.get(i),
            Z = null != X && isFinite(X) ? Math.max(0, (e - X) / 1e3) : 0,
            q = Z > 0 ? 1 - Math.exp(-Z / .35) : 1,
            j = null == Y ? U : G(Y + G(U - Y) * q);
        return this._traceAngleById.set(i, j), this._traceAngleLastMsById.set(i, e), {
            lat: T,
            lon: I,
            angle: j,
            flipX: "L" === K,
            speedMps: A,
            opacity: C
        }
    }
    _mobilePoseForRender(t, e)
    {
        let i = Number(t?.lat),
            s = Number(t?.lon),
            a = 0,
            n = !1,
            o = 0,
            l = 1;
        if (this.playbackMode) {
            this._ensurePlaybackPoints(this.lastState);
            const r = this._playbackSampleForMobile(t, e);
            if (r)
                i = r.lat,
                s = r.lon,
                a = r.angle,
                n = !!r.flipX,
                o = Number(r.speedMps) || 0,
                l = "number" == typeof r.opacity && isFinite(r.opacity) ? r.opacity : 1,
                r.beforeFirst && (l = .3);
            else {
                const e = t && null != t.id ? String(t.id) : "",
                    a = e ? this._playbackPtsById.get(e) : null,
                    n = this._playbackNowMs;
                if (a && a.length >= 1 && null != n && isFinite(n)) {
                    const t = a[0].tMs,
                        e = a[a.length - 1].tMs;
                    n < t ? (i = a[0].lat, s = a[0].lon, l = .3) : n >= e && (i = a[a.length - 1].lat, s = a[a.length - 1].lon)
                }
            }
            const h = !!(this._pbDrag && String(this._pbDrag.id) === String(t?.id) || this._pbInertia2d && String(this._pbInertia2d.id) === String(t?.id));
            return {
                lat: i,
                lon: s,
                angle: a,
                flipX: n,
                speedMps: o,
                opacity: l,
                reading: r?.reading || null,
                held: h
            }
        }
        if (this.traceMode) {
            const r = this._traceSampleForMobile(t, e);
            return r && (i = r.lat, s = r.lon, a = r.angle, n = !!r.flipX, o = Number(r.speedMps) || 0, l = "number" == typeof r.opacity && isFinite(r.opacity) ? r.opacity : 1), {
                lat: i,
                lon: s,
                angle: a,
                flipX: n,
                speedMps: o,
                opacity: l
            }
        }
        const r = t && null != t.id ? String(t.id) : "",
            h = r ? this._persistedTrailById.get(r)?.pin : null;
        return h && isFinite(Number(h.lat)) && isFinite(Number(h.lon)) && (i = Number(h.lat), s = Number(h.lon)), {
            lat: i,
            lon: s,
            angle: a,
            flipX: n,
            speedMps: o,
            opacity: l
        }
    }
    zoomBy(t)
    {
        const e = clamp(Math.round(this.zoom) + t, this._zoomMin, this._zoomMax);
        this.zoom = e,
        this._tilesSnapshotCanvas = null,
        this._tilesSnapshotMeta = null,
        this.draw(this.lastState),
        this._notifyViewChanged()
    }
    resize(t, e)
    {
        const i = window.devicePixelRatio || 1,
            s = this.tilesCanvas.parentElement,
            a = Math.max(1, null != t ? Math.round(t) : s.clientWidth),
            n = Math.max(1, null != e ? Math.round(e) : s.clientHeight);
        a === this._cssW && n === this._cssH && i === this._dpr || (this._dpr = i, this._cssW = a, this._cssH = n, this.tilesCanvas.width = Math.floor(a * i), this.tilesCanvas.height = Math.floor(n * i), this.overlayCanvas.width = Math.floor(a * i), this.overlayCanvas.height = Math.floor(n * i), this.tilesCanvas.style.width = a + "px", this.tilesCanvas.style.height = n + "px", this.overlayCanvas.style.width = a + "px", this.overlayCanvas.style.height = n + "px", this.tctx.setTransform(i, 0, 0, i, 0, 0), this.octx.setTransform(i, 0, 0, i, 0, 0), this._tilesSnapshotCanvas = null, this._tilesSnapshotMeta = null, this._paFieldCanvas = null, this._paGrid = null, this._invalidateOverlayStatic(), this._trailCacheCanvas = null, this._trailCacheViewKey = "", this.draw(this.lastState))
    }
    onWheel(t)
    {
        t.preventDefault(),
        this._noteUserInteraction();
        const e = 0 !== t.deltaMode,
            i = !t.ctrlKey && Math.abs(t.deltaX) < 1 && Math.abs(t.deltaY) >= 4;
        let s = e || t.ctrlKey || i;
        if (s && !e && this._lastWheelPanTime && performance.now() - this._lastWheelPanTime < 100 && (s = !1), s) {
            if (this._gesture)
                return;
            if (this._mouseDragging)
                return;
            this._wheelPinchEndTimer && window.clearTimeout(this._wheelPinchEndTimer),
            this._pinchZooming = !0;
            const s = this.overlayCanvas.getBoundingClientRect(),
                a = t.clientX - s.left,
                n = t.clientY - s.top;
            this._pinchAnchorSX = a,
            this._pinchAnchorSY = n;
            const o = clamp(t.deltaY, -300, 300),
                l = e || i ? -o : o,
                r = l < 0 ? 1 : -1,
                h = t.ctrlKey && !e && /Chrome/.test(navigator.userAgent || ""),
                c = e || i ? .018 : h ? .055 : .02,
                d = r * Math.log1p(Math.abs(l)) * c,
                u = this.zoom,
                _ = clamp(this.zoom + d, this._zoomMin, this._zoomMax);
            return this._setZoomAroundScreenPoint(_, a, n), this._requestZoomRedraw(), this._notifyViewChanged(), this._notePinchVelocity(_ - u, performance.now()), void (this._wheelPinchEndTimer = e || i ? window.setTimeout(() => {
                this._pinchZooming = !1,
                this._requestZoomRedraw()
            }, 150) : window.setTimeout(() => this._startPinchInertia(), 28))
        }
        this._lastWheelPanTime = performance.now(),
        this._wheelPanning || (this._wheelPanning = !0),
        this._wheelPanEndTimer && window.clearTimeout(this._wheelPanEndTimer),
        this._wheelPanEndTimer = window.setTimeout(() => {
            this._wheelPanning = !1,
            this._wheelPanEndTimer = null,
            this._redrawViewOnly()
        }, 120);
        const a = latLonToWorld(this.center.lat, this.center.lon, this.zoom),
            n = a.x + .65 * t.deltaX,
            o = clamp(a.y + .65 * t.deltaY, 0, a.ws - 1),
            l = worldToLatLon(n, o, this.zoom);
        this.center = {
            lat: l.lat,
            lon: l.lon
        },
        this._pinchInertiaRAF || this._requestPanRedraw()
    }
    onClick(t)
    {
        const e = this.lastState,
            i = e && Array.isArray(e.mobile) ? e.mobile : [],
            s = e && Array.isArray(e.fixed) ? e.fixed : [],
            a = this.overlayCanvas.getBoundingClientRect(),
            n = t.clientX - a.left,
            o = t.clientY - a.top;
        if (this._mouseDragMoved)
            return void (this._mouseDragMoved = !1);
        let l = null;
        const r = parseKey(this.selectedId),
            h = r && "mobile" === r.type ? String(r.id) : null,
            c = i.map(t => ({
                type: "mobile",
                ...t
            })),
            d = h ? c.find(t => String(t.id) === h) : null,
            u = [...d ? [d] : [], ...[...h ? c.filter(t => String(t.id) !== h) : [...c]].reverse(), ...[...s.filter(t => !t.purpleair)].reverse().map(t => ({
                type: "fixed",
                ...t
            })), ...[...s.filter(t => t.purpleair)].reverse().map(t => ({
                type: "fixed",
                ...t
            }))];
        for (const t of u) {
            let e = Number(t.lat),
                i = Number(t.lon);
            if ("mobile" === t.type) {
                const s = this._mobilePoseForRender(t, performance.now());
                e = s.lat,
                i = s.lon
            }
            if ("fixed" === t.type && this._fixedGeoOffsets) {
                const s = t._key || keyFor("fixed", t.id),
                    a = this._fixedGeoOffsets.get(s);
                a && (e += a.dlat, i += a.dlon)
            }
            if (!isFinite(e) || !isFinite(i))
                continue;
            const s = latLonToWorld(e, i, this.zoom),
                a = this.worldToScreen(s.x, s.y),
                r = a.x - n,
                h = a.y - o;
            if (r * r + h * h <= 400) {
                l = keyFor(t.type, t.id);
                break
            }
        }
        l ? window.__selectSensor && window.__selectSensor(l, {
            fitTrail: !!t.metaKey
        }) : (this.setSelected(null), window.__selectSensor && window.__selectSensor(null))
    }
    _handleTapSelection(t, e)
    {
        const i = this.lastState,
            s = i && Array.isArray(i.mobile) ? i.mobile : [],
            a = i && Array.isArray(i.fixed) ? i.fixed : [];
        let n = null;
        const o = parseKey(this.selectedId),
            l = o && "mobile" === o.type ? String(o.id) : null,
            r = s.map(t => ({
                type: "mobile",
                ...t
            })),
            h = l ? r.find(t => String(t.id) === l) : null,
            c = [...h ? [h] : [], ...[...l ? r.filter(t => String(t.id) !== l) : [...r]].reverse(), ...[...a.filter(t => !t.purpleair)].reverse().map(t => ({
                type: "fixed",
                ...t
            })), ...[...a.filter(t => t.purpleair)].reverse().map(t => ({
                type: "fixed",
                ...t
            }))];
        for (const i of c) {
            let s = Number(i.lat),
                a = Number(i.lon);
            if ("mobile" === i.type) {
                const t = this._mobilePoseForRender(i, performance.now());
                s = t.lat,
                a = t.lon
            }
            if ("fixed" === i.type && this._fixedGeoOffsets) {
                const t = i._key || keyFor("fixed", i.id),
                    e = this._fixedGeoOffsets.get(t);
                e && (s += e.dlat, a += e.dlon)
            }
            if (!isFinite(s) || !isFinite(a))
                continue;
            const o = latLonToWorld(s, a, this.zoom),
                l = this.worldToScreen(o.x, o.y),
                r = l.x - t,
                h = l.y - e;
            if (r * r + h * h <= 1225) {
                n = keyFor(i.type, i.id);
                break
            }
        }
        n ? window.__selectSensor && window.__selectSensor(n, {
            fitTrail: !1
        }) : (this.setSelected(null), window.__selectSensor && window.__selectSensor(null))
    }
    worldToScreen(t, e)
    {
        const i = this._cssW || 1,
            s = this._cssH || 1,
            a = latLonToWorld(this.center.lat, this.center.lon, this.zoom);
        return {
            x: t - a.x + i / 2,
            y: e - a.y + s / 2
        }
    }
    draw(t)
    {
        this._frameSeq++,
        this.lastState = t;
        try {
            const e = Array.isArray(t?.mobile) ? t.mobile : [];
            let i = null,
                s = !1;
            for (const t of e) {
                const e = t?.id ? String(t.id).toUpperCase() : "";
                (e.startsWith("TRX") || e.startsWith("TRAX")) && (s = !0);
                const a = Array.isArray(t?.trail) ? t.trail : null;
                if (!a || a.length < 1)
                    continue;
                const n = a[a.length - 1],
                    o = n && "string" == typeof n.t ? n.t : null;
                if (!o)
                    continue;
                const l = parseUtcMs(o);
                null != l && isFinite(l) && (i = null == i ? l : Math.max(i, l))
            }
            null != i && isFinite(i) && (this._dataNowBaseMs = i, this._dataNowBasePerfMs = performance.now()),
            this._hasTrxVehicles = s,
            s && this._fetchTramLineEdgesForViewport()
        } catch {}
        this._prunePerMobileCachesForState(t),
        this._updatePersistedTrails(t),
        this._invalidateOverlayStatic(),
        this.playbackMode && this._ensurePlaybackPoints(t);
        const e = (() => {
            const t = Number(this.zoom),
                e = Number(this.center?.lat),
                i = Number(this.center?.lon),
                s = Number(this._cssW),
                a = Number(this._cssH),
                n = Number(this._dpr || window.devicePixelRatio || 1),
                o = (t, e=1e6) => isFinite(t) ? Math.round(t * e) / e : t;
            return `${this.themeKey}|${o(t, 1e3)}|${o(e)}|${o(i)}|${s}x${a}|dpr:${o(n, 1e3)}|pinch:${this._pinchZooming ? 1 : 0}`
        })();
        let i = !1;
        this._lastTilesViewSig !== e && (this._lastTilesViewSig = e, this.drawTiles(), i = !0),
        this._compositePaFieldOnTiles(t, i),
        this.drawOverlay(t, {
            cacheUnderlay: !0
        })
    }
    _prunePerMobileCachesForState(t)
    {
        const e = Array.isArray(t?.mobile) ? t.mobile : [],
            i = new Set;
        for (const t of e) {
            const e = t && null != t.id ? String(t.id) : "";
            e && i.add(e)
        }
        const s = t => {
            if (!t || "function" != typeof t.entries)
                return !1;
            let e = !1;
            for (const [s] of t.entries()) {
                const a = null != s ? String(s) : "";
                a && !i.has(a) && (t.delete(s), e = !0)
            }
            return e
        };
        let a = !1;
        a = s(this._persistedTrailById) || a,
        a = s(this._tracePtsById) || a,
        a = s(this._traceLastSideById) || a,
        a = s(this._traceActiveRouteById) || a,
        a = s(this._tracePendingRouteById) || a,
        a = s(this._traceCycleStartMsById) || a,
        a = s(this._traceInitialRunDoneById) || a,
        a = s(this._traceAngleById) || a,
        a = s(this._traceAngleLastMsById) || a,
        a && (this._persistedTrailRev++, this._invalidateOverlayStatic())
    }
    _getPersistedTrailEntry(t)
    {
        return t && this._persistedTrailById.get(String(t)) || null
    }
    _updatePersistedTrails(t)
    {
        const e = Array.isArray(t?.mobile) ? t.mobile : [];
        let i = !1;
        performance.now();
        const s = (t, e) => !1,
            a = (t, e) => {
                if (!Array.isArray(t) || !t.length)
                    return null;
                const i = t => {
                        if (!t.length)
                            return NaN;
                        const e = t.slice().sort((t, e) => t - e),
                            i = Math.floor(e.length / 2);
                        return e.length % 2 ? e[i] : .5 * (e[i - 1] + e[i])
                    },
                    s = Math.max(6, Math.min(60, Number(e || 24))),
                    a = t.slice(Math.max(0, t.length - s)),
                    n = [],
                    o = [];
                for (const t of a) {
                    const e = Number(t?.lat),
                        i = Number(t?.lon);
                    isFinite(e) && isFinite(i) && (n.push(e), o.push(i))
                }
                if (n.length < 6)
                    return null;
                const l = i(n),
                    r = i(o);
                return isFinite(l) && isFinite(r) ? {
                    lat: l,
                    lon: r
                } : null
            };
        for (const t of e) {
            const e = t && null != t.id ? String(t.id) : "";
            if (!e)
                continue;
            const n = Array.isArray(t?.trail) ? t.trail : [],
                o = this._persistedTrailById.get(e) || {
                    trail: [],
                    color: null,
                    ghosted: !1,
                    parked: !1,
                    pin: null
                };
            if (n.length < 2 && !o.trail.length)
                continue;
            const l = n.length ? n[n.length - 1]?.t : null,
                r = o.trail.length ? o.trail[o.trail.length - 1]?.t : null,
                h = n.length > o.trail.length || l !== r && null !== l;
            let c = n;
            c.length > this.maxTrailLen && (c = c.slice(-this.maxTrailLen));
            const d = h ? Math.max(1, c.length - o.trail.length) : 0,
                u = o && o.pin && isFinite(Number(o.pin.lat)) && isFinite(Number(o.pin.lon)) ? {
                    lat: Number(o.pin.lat),
                    lon: Number(o.pin.lon)
                } : null;
            let _ = u;
            const m = !!t?.ghosted,
                p = !!o?.parked,
                f = !!t?.parked;
            if (_ = null, !m)
                if (f)
                    _ = a(c, 24);
                else {
                    s() && (_ = a(c, 24))
                }
            const g = Boolean(u) !== Boolean(_) || u && _ && haversineMeters(u.lat, u.lon, _.lat, _.lon) > 1,
                M = safeHex(t.ci),
                y = o.color !== M || o.ghosted !== m || p !== f;
            (d > 0 || y || g) && (this._persistedTrailById.set(e, {
                trail: c,
                color: M,
                ghosted: m,
                parked: f,
                pin: _
            }), i = !0)
        }
        i && this._persistedTrailRev++
    }
    drawTiles()
    {
        const t = this.tctx;
        if (!t)
            return;
        const e = this._cssW || 1,
            i = this._cssH || 1,
            s = this._dpr || window.devicePixelRatio || 1;
        t.setTransform(s, 0, 0, s, 0, 0);
        const a = latLonToWorld(this.center.lat, this.center.lon, this.zoom),
            n = (a.ws, !(!this._tilesSnapshotCanvas || !this._tilesSnapshotMeta));
        if (t.clearRect(0, 0, e, i), n)
            try {
                const a = this._tilesSnapshotMeta;
                if (t.save(), this._pinchZooming) {
                    const n = Math.pow(2, this.zoom - a.zoom),
                        o = latLonToWorld(a.centerLat, a.centerLon, a.zoom),
                        l = latLonToWorld(this.center.lat, this.center.lon, a.zoom),
                        r = (o.x - l.x) * n,
                        h = (o.y - l.y) * n;
                    return t.setTransform(s, 0, 0, s, 0, 0), t.translate(e / 2, i / 2), t.scale(n, n), t.translate(-e / 2 + r / n, -i / 2 + h / n), t.drawImage(this._tilesSnapshotCanvas, 0, 0, e, i), void t.restore()
                }
                if (Math.floor(a.zoom) !== Math.floor(this.zoom))
                    throw new Error("zoom changed");
                const n = latLonToWorld(a.centerLat, a.centerLon, a.zoom),
                    o = latLonToWorld(this.center.lat, this.center.lon, a.zoom),
                    l = n.x - o.x,
                    r = n.y - o.y;
                t.setTransform(s, 0, 0, s, s * l, s * r),
                t.drawImage(this._tilesSnapshotCanvas, 0, 0, e, i),
                t.restore()
            } catch {}
        const o = a.x - e / 2,
            l = a.y - i / 2,
            r = clamp(Math.floor(this.zoom), this._zoomMin, this._zoomMax),
            h = Math.pow(2, this.zoom - r),
            c = o / h,
            d = l / h,
            u = e / h,
            _ = i / h,
            m = Math.floor(c / TILE_SIZE),
            p = Math.floor(d / TILE_SIZE),
            f = Math.floor((c + u) / TILE_SIZE),
            g = Math.floor((d + _) / TILE_SIZE),
            M = Math.pow(2, r);
        for (let e = p; e <= g; e++)
            if (!(e < 0 || e >= M))
                for (let i = m; i <= f; i++) {
                    let s = i;
                    for (; s < 0;)
                        s += M;
                    for (; s >= M;)
                        s -= M;
                    const a = `${this.themeKey}:${r}/${s}/${e}`,
                        c = i * TILE_SIZE * h - o,
                        d = e * TILE_SIZE * h - l;
                    this.drawTile(t, a, r, s, e, c, d, h, n)
                }
        this._touchActive || this._captureTilesSnapshot()
    }
    _captureTilesSnapshot()
    {
        try {
            const t = this.tilesCanvas.width,
                e = this.tilesCanvas.height;
            this._tilesSnapshotCanvas ? this._tilesSnapshotCanvas.width === t && this._tilesSnapshotCanvas.height === e || (this._tilesSnapshotCanvas.width = t, this._tilesSnapshotCanvas.height = e) : (this._tilesSnapshotCanvas = document.createElement("canvas"), this._tilesSnapshotCanvas.width = t, this._tilesSnapshotCanvas.height = e);
            const i = this._tilesSnapshotCanvas.getContext("2d");
            i && (i.setTransform(1, 0, 0, 1, 0, 0), i.clearRect(0, 0, t, e), i.drawImage(this.tilesCanvas, 0, 0), this._tilesSnapshotMeta = {
                zoom: this.zoom,
                centerLat: this.center.lat,
                centerLon: this.center.lon
            })
        } catch {}
    }
    _tileCacheGet(t)
    {
        if (!this.tileCache || !t)
            return null;
        const e = this.tileCache.get(t) || null;
        return e ? (this.tileCache.delete(t), this.tileCache.set(t, e), e) : null
    }
    _tileCacheSet(t, e)
    {
        if (!this.tileCache || !t)
            return;
        this.tileCache.has(t) && this.tileCache.delete(t),
        this.tileCache.set(t, e);
        const i = "number" == typeof this._tileCacheMax && isFinite(this._tileCacheMax) && this._tileCacheMax > 0 ? Math.floor(this._tileCacheMax) : 420;
        for (; this.tileCache.size > i;) {
            const t = this.tileCache.keys().next().value;
            if (null == t)
                break;
            this.tileCache.delete(t)
        }
    }
    drawTile(t, e, i, s, a, n, o, l, r)
    {
        const h = this._tileCacheGet(e);
        if (h && h.ok) {
            const e = TILE_SIZE * l;
            return t.filter = "none", void t.drawImage(h.img, Math.floor(n), Math.floor(o), Math.ceil(e), Math.ceil(e))
        }
        if (!h) {
            const t = new Image,
                n = this._tileEpoch;
            t.crossOrigin = "anonymous",
            t.onload = () => {
                n === this._tileEpoch && (this._tileCacheSet(e, {
                    img: t,
                    ok: !0
                }), this._scheduleTileRedraw())
            },
            t.onerror = () => {
                n === this._tileEpoch && this._tileCacheSet(e, {
                    img: t,
                    ok: !1
                })
            };
            const o = this.tileSubdomains || [""],
                l = o[(s + a) % o.length] || "";
            t.src = this.tileTemplate.replace("{s}", l).replace("{z}", i).replace("{x}", s).replace("{y}", a),
            n === this._tileEpoch && this._tileCacheSet(e, {
                img: t,
                ok: !1
            })
        }
        for (let e = i - 1; e >= Math.max(i - 4, this._zoomMin); e--) {
            const r = i - e,
                h = s >> r,
                c = a >> r,
                d = `${this.themeKey}:${e}/${h}/${c}`,
                u = this._tileCacheGet(d);
            if (u && u.ok) {
                const e = TILE_SIZE / (1 << r),
                    i = (s - (h << r)) * e,
                    d = (a - (c << r)) * e,
                    _ = TILE_SIZE * l;
                return t.filter = "none", void t.drawImage(u.img, i, d, e, e, Math.floor(n), Math.floor(o), Math.ceil(_), Math.ceil(_))
            }
        }
        if (!r) {
            const e = TILE_SIZE * l;
            t.fillStyle = "rgba(255,255,255,0.03)",
            t.fillRect(Math.floor(n), Math.floor(o), Math.ceil(e), Math.ceil(e)),
            t.strokeStyle = "rgba(255,255,255,0.04)",
            t.strokeRect(Math.floor(n), Math.floor(o), Math.ceil(e), Math.ceil(e))
        }
    }
    _scheduleTileRedraw()
    {
        this._touchActive ? this._tileRedrawPending = !0 : this._tileLoadRedrawTimer || (this._tileLoadRedrawTimer = setTimeout(() => {
            this._tileLoadRedrawTimer = null,
            this.drawTiles()
        }, 50))
    }
    _tracePointsKeyForState(t)
    {
        const e = t?.meta?.server_revision;
        if ("number" == typeof e && isFinite(e))
            return `rev:${e}`;
        const i = t?.ts;
        return "number" == typeof i && isFinite(i) ? `ts:${i}` : "obj:" + (t ? 1 : 0)
    }
    _playbackPointsKeyForState(t)
    {
        const e = this._tracePointsKeyForState(t);
        let i = "";
        const s = Array.isArray(t?.mobile) ? t.mobile : [];
        for (const t of s) {
            const e = t?.id || "",
                s = Array.isArray(t?.trail) ? t.trail : [],
                a = s.length > 0 && s[s.length - 1]?.t || "";
            i += `${e}:${s.length}:${a}|`
        }
        return `${e}|persist:${this._persistedTrailRev}|trail:${i}|v3`
    }
    _ensurePlaybackPoints(t)
    {
        const e = this._playbackPointsKeyForState(t);
        if (this._playbackPtsKey === e)
            return;
        this._playbackPtsKey = e;
        const i = new Map;
        let s = 1 / 0,
            a = -1 / 0;
        const n = this._historicalMode ? null : (() => {
                const e = newestReadingMsFromState(t);
                if (null == e || !isFinite(e))
                    return null;
                const i = new Date(e);
                i.getHours() < 5 && i.setDate(i.getDate() - 1),
                i.setHours(5, 0, 0, 0);
                const s = i.getTime();
                return isFinite(s) ? s : null
            })(),
            o = Array.isArray(t?.mobile) ? t.mobile : [];
        for (const t of o) {
            const e = t && null != t.id ? String(t.id) : "";
            if (!e)
                continue;
            const o = Array.isArray(t?.trail) ? t.trail : [],
                l = this._historicalMode || this.playbackMode ? [] : this._persistedTrailById.get(e)?.trail || [],
                r = o.length >= 2 ? o : l.length >= 2 ? l : o;
            if (!Array.isArray(r) || r.length < 2)
                continue;
            const h = [];
            for (const t of r) {
                const e = Number(t?.lat),
                    i = Number(t?.lon);
                if (!isFinite(e) || !isFinite(i))
                    continue;
                const s = t && "string" == typeof t.t ? parseUtcMs(t.t) : null;
                null != s && isFinite(s) && h.push({
                    lat: e,
                    lon: i,
                    tMs: s,
                    m: t.m,
                    readings: t.readings
                })
            }
            if (h.length >= 1) {
                let t = !0;
                for (let e = 1; e < h.length; e++)
                    if (h[e].tMs < h[e - 1].tMs) {
                        t = !1;
                        break
                    }
                t || h.sort((t, e) => t.tMs - e.tMs);
                let o = h;
                if (null != n && isFinite(n)) {
                    let t = 0,
                        e = h.length;
                    for (; t < e;) {
                        const i = t + e >> 1;
                        h[i].tMs < n ? t = i + 1 : e = i
                    }
                    o = t > 0 ? h.slice(t) : h
                }
                if (!Array.isArray(o) || o.length < 2)
                    continue;
                s = Math.min(s, o[0].tMs),
                a = Math.max(a, o[o.length - 1].tMs);
                let l = 0;
                for (let t = 1; t < o.length; t++) {
                    const e = o[t - 1],
                        i = o[t],
                        s = haversineMeters(e.lat, e.lon, i.lat, i.lon);
                    if (isFinite(s) && (l += s), l >= MapView.MIN_TRAIL_LENGTH_M)
                        break
                }
                l >= MapView.MIN_TRAIL_LENGTH_M && i.set(e, o)
            }
        }
        this._playbackPtsById = i;
        const l = t?.meta?.trail_update_start_ms,
            r = t?.meta?.trail_update_end_ms;
        !isFinite(s) && "number" == typeof l && isFinite(l) && (s = l),
        !isFinite(a) && "number" == typeof r && isFinite(r) && (a = r),
        isFinite(a) && "number" == typeof r && isFinite(r) && r > a && (a = r),
        this._playbackMinMs = isFinite(s) ? s : null,
        this._playbackMaxMs = isFinite(a) ? a : null,
        this._playbackLastMaxMs = this._playbackMaxMs
    }
    async _fetchRoadEdgesForViewport()
    {
        if (!this._pbDebugPath || !this._pbDebugRoadLines)
            return;
        if (this._roadEdgesFetching)
            return;
        const t = this.overlayCanvas.getBoundingClientRect(),
            e = t.width,
            i = t.height,
            s = latLonToWorld(this.center.lat, this.center.lon, this.zoom),
            a = worldToLatLon(s.x - e / 2, s.y - i / 2, this.zoom),
            n = worldToLatLon(s.x + e / 2, s.y + i / 2, this.zoom),
            o = Math.min(a.lat, n.lat),
            l = Math.max(a.lat, n.lat),
            r = Math.min(a.lon, n.lon),
            h = Math.max(a.lon, n.lon),
            c = `${o.toFixed(3)},${l.toFixed(3)},${r.toFixed(3)},${h.toFixed(3)}`;
        if (this._roadEdgesLastKey !== c) {
            this._roadEdgesFetching = !0;
            try {
                const t = `${appConfig.apiBaseUrl}/road_edges?minLat=${o}&maxLat=${l}&minLon=${r}&maxLon=${h}&limit=8000`,
                    e = await fetch(t);
                if (!e.ok)
                    return;
                const i = await e.json();
                this._roadGraphEdges = i.edges || [],
                this._roadEdgesLastKey = c,
                this.drawOverlay(this.lastState)
            } catch (t) {
                console.warn("Failed to fetch road edges:", t)
            } finally {
                this._roadEdgesFetching = !1
            }
        }
    }
    _walkBetweenServerEdges(t, e, i, s)
    {
        const a = (t, e, i, s) => {
                const a = 111e3 * (i - t),
                    n = 111e3 * (s - e) * Math.cos(t * Math.PI / 180);
                return Math.hypot(a, n)
            },
            n = (t, e, i=1e-4) => Math.abs(t[0] - e[0]) < i && Math.abs(t[1] - e[1]) < i,
            o = t.lat,
            l = t.lon,
            r = t.ea,
            h = t.eb,
            c = e.lat,
            d = e.lon,
            u = e.ea,
            _ = e.eb;
        if (n(r, u) && n(h, _))
            return [s(o, l), s(c, d)];
        if (n(r, _) && n(h, u))
            return [s(o, l), s(c, d)];
        let m = null;
        if (n(h, u) || n(h, _) ? m = h : (n(r, u) || n(r, _)) && (m = r), m)
            return [s(o, l), s(m[0], m[1]), s(c, d)];
        let p = a(r[0], r[1], c, d) < a(h[0], h[1], c, d) ? r : h;
        const f = [s(o, l)],
            g = new Set;
        g.add(`${r[0]},${r[1]}-${h[0]},${h[1]}`);
        const M = 3e-4;
        for (let t = 0; t < 50; t++) {
            if (f.push(s(p[0], p[1])), n(p, u, M) || n(p, _, M))
                return f.push(s(c, d)), f;
            let t = null,
                e = 1 / 0,
                o = null;
            for (const s of i) {
                const i = `${s.lat1},${s.lon1}-${s.lat2},${s.lon2}`;
                if (g.has(i))
                    continue;
                const l = [s.lat1, s.lon1],
                    r = [s.lat2, s.lon2];
                let h = null;
                if (n(p, l, M) ? h = r : n(p, r, M) && (h = l), h) {
                    const i = a(h[0], h[1], c, d);
                    i < e && (e = i, t = s, o = h)
                }
            }
            if (!t)
                return a(p[0], p[1], c, d) < 200 ? (f.push(s(c, d)), f) : null;
            g.add(`${t.lat1},${t.lon1}-${t.lat2},${t.lon2}`),
            p = o
        }
        return null
    }
    _snapToTrackEdge(t, e, i)
    {
        if (!i || 0 === i.length)
            return null;
        let s = null,
            a = 1 / 0,
            n = null,
            o = 0;
        const l = .01;
        for (const r of i) {
            const i = Math.min(r.lat1, r.lat2) - l,
                h = Math.max(r.lat1, r.lat2) + l,
                c = Math.min(r.lon1, r.lon2) - l,
                d = Math.max(r.lon1, r.lon2) + l;
            if (t < i || t > h || e < c || e > d)
                continue;
            const u = r.lon1,
                _ = r.lat1,
                m = e,
                p = t,
                f = r.lon2 - u,
                g = r.lat2 - _,
                M = m - u,
                y = p - _,
                b = f * f + g * g;
            if (b < 1e-12)
                continue;
            const x = Math.max(0, Math.min(1, (M * f + y * g) / b)),
                S = u + x * f,
                w = _ + x * g,
                v = Math.hypot(m - S, p - w);
            v < a && v < l && (a = v, s = r, n = {
                lat: w,
                lon: S
            }, o = x)
        }
        return s ? {
            edge: s,
            snapLat: n.lat,
            snapLon: n.lon,
            t: o
        } : null
    }
    _walkTrackPath(t, e, i, s, a, n)
    {
        if (!a || 0 === a.length)
            return this._walkNoEdgesLogged || (console.log("[WALK DEBUG] No edges available"), this._walkNoEdgesLogged = !0), null;
        const o = this._snapToTrackEdge(t, e, a),
            l = this._snapToTrackEdge(i, s, a);
        if (!o || !l) {
            if (!this._walkDebugLogged) {
                console.log(`[WALK DEBUG] snap failed: snap1=${!!o}, snap2=${!!l}, pt1=(${t?.toFixed(5)},${e?.toFixed(5)}), pt2=(${i?.toFixed(5)},${s?.toFixed(5)}), edges=${a.length}`);
                const n = a.filter(i => {
                    const s = Math.hypot(i.lat1 - t, i.lon1 - e),
                        a = Math.hypot(i.lat2 - t, i.lon2 - e);
                    return s < .01 || a < .01
                }).slice(0, 3);
                console.log(`[WALK DEBUG] Nearby edges for pt1: ${JSON.stringify(n)}`),
                this._walkDebugLogged = !0
            }
            return null
        }
        if (this._walkSnapLogged || (console.log(`[WALK DEBUG] snap1: edge=(${o.edge.lat1.toFixed(5)},${o.edge.lon1.toFixed(5)})-(${o.edge.lat2.toFixed(5)},${o.edge.lon2.toFixed(5)}), snap=(${o.snapLat.toFixed(5)},${o.snapLon.toFixed(5)})`), console.log(`[WALK DEBUG] snap2: edge=(${l.edge.lat1.toFixed(5)},${l.edge.lon1.toFixed(5)})-(${l.edge.lat2.toFixed(5)},${l.edge.lon2.toFixed(5)}), snap=(${l.snapLat.toFixed(5)},${l.snapLon.toFixed(5)})`), this._walkSnapLogged = !0), o.edge === l.edge)
            return [n(o.snapLat, o.snapLon), n(l.snapLat, l.snapLon)];
        const r = (t, e, i, s) => {
                const a = 111e3 * (i - t),
                    n = 111e3 * (s - e) * Math.cos(t * Math.PI / 180);
                return Math.hypot(a, n)
            },
            h = (t, e) => r(t.lat, t.lon, e.lat1, e.lon1) < 25 || r(t.lat, t.lon, e.lat2, e.lon2) < 25,
            c = (t, e) => {
                const i = [];
                for (const s of a) {
                    const a = `${s.lat1},${s.lon1}-${s.lat2},${s.lon2}`;
                    if (e.has(a))
                        continue;
                    const n = r(t.lat, t.lon, s.lat1, s.lon1),
                        o = r(t.lat, t.lon, s.lat2, s.lon2);
                    n < 25 ? i.push({
                        edge: s,
                        otherEnd: {
                            lat: s.lat2,
                            lon: s.lon2
                        },
                        key: a,
                        dist: n
                    }) : o < 25 && i.push({
                        edge: s,
                        otherEnd: {
                            lat: s.lat1,
                            lon: s.lon1
                        },
                        key: a,
                        dist: o
                    })
                }
                return i
            },
            d = [n(o.snapLat, o.snapLon)],
            u = new Set,
            _ = `${o.edge.lat1},${o.edge.lon1}-${o.edge.lat2},${o.edge.lon2}`;
        u.add(_);
        let m = (p = o.edge, f = i, g = s, r(p.lat1, p.lon1, f, g) < r(p.lat2, p.lon2, f, g) ? {
            lat: p.lat1,
            lon: p.lon1
        } : {
            lat: p.lat2,
            lon: p.lon2
        });
        var p,
            f,
            g;
        if (d.push(n(m.lat, m.lon)), !this._walkStartLogged) {
            const t = r(o.snapLat, o.snapLon, l.snapLat, l.snapLon);
            console.log(`[WALK DEBUG] Starting walk: from (${m.lat.toFixed(5)},${m.lon.toFixed(5)}) to edge at (${l.edge.lat1.toFixed(5)},${l.edge.lon1.toFixed(5)}), direct=${t.toFixed(1)}m`),
            this._walkStartLogged = !0
        }
        for (let t = 0; t < 100; t++) {
            if (h(m, l.edge))
                return d.push(n(l.snapLat, l.snapLon)), this._walkSuccessLogged || (console.log(`[WALK DEBUG] SUCCESS after ${t} steps, path length=${d.length}`), this._walkSuccessLogged = !0), d;
            const e = c(m, u);
            if (0 === e.length) {
                const e = r(m.lat, m.lon, l.snapLat, l.snapLon);
                return e < 500 ? (d.push(n(l.snapLat, l.snapLon)), d) : (this._walkStuckLogged || (console.log(`[WALK DEBUG] STUCK at step ${t}: no connected edges from (${m.lat.toFixed(5)},${m.lon.toFixed(5)}), directDist=${e.toFixed(1)}m, visited=${u.size}`), this._walkStuckLogged = !0), null)
            }
            let a = null;
            if (1 === e.length)
                a = e[0];
            else {
                let t = 1 / 0;
                for (const n of e) {
                    const e = r(n.otherEnd.lat, n.otherEnd.lon, i, s) + 10 * n.dist;
                    e < t && (t = e, a = n)
                }
            }
            if (!a)
                return null;
            u.add(a.key),
            m = a.otherEnd,
            d.push(n(m.lat, m.lon))
        }
        return this._walkTooManyLogged || (console.log(`[WALK DEBUG] TOO MANY STEPS (100), path length=${d.length}`), this._walkTooManyLogged = !0), null
    }
    async _fetchTramLineEdgesForViewport()
    {
        if (!this._pbDebugPath && !this._pbDebugRoadLines && !this._hasTrxVehicles)
            return;
        if (this._tramEdgesFetching)
            return;
        const t = this.overlayCanvas.getBoundingClientRect(),
            e = t.width,
            i = t.height,
            s = latLonToWorld(this.center.lat, this.center.lon, this.zoom),
            a = 1.5 * e,
            n = 1.5 * i,
            o = worldToLatLon(s.x - a, s.y - n, this.zoom),
            l = worldToLatLon(s.x + a, s.y + n, this.zoom),
            r = Math.min(o.lat, l.lat),
            h = Math.max(o.lat, l.lat),
            c = Math.min(o.lon, l.lon),
            d = Math.max(o.lon, l.lon),
            u = `${r.toFixed(2)},${h.toFixed(2)},${c.toFixed(2)},${d.toFixed(2)}`;
        if (this._tramEdgesLastKey !== u) {
            this._tramEdgesFetching = !0;
            try {
                const t = `${appConfig.apiBaseUrl}/tram_line_edges?minLat=${r}&maxLat=${h}&minLon=${c}&maxLon=${d}&limit=8000`,
                    e = await fetch(t);
                if (!e.ok)
                    return;
                const i = await e.json();
                this._tramLineEdges = i.edges || [],
                this._tramLineHasElevation = i.has_elevation || !1,
                this._tramEdgesLastKey = u,
                this.drawOverlay(this.lastState)
            } catch (t) {
                console.warn("Failed to fetch tram line edges:", t)
            } finally {
                this._tramEdgesFetching = !1
            }
        }
    }
    _isRangeMatched(t, e, i)
    {
        const s = this._roadMatchedRangesById.get(t);
        if (!s || 0 === s.length)
            return !1;
        for (const t of s)
            if (t.fromMs <= e && t.toMs >= i)
                return !0;
        return !1
    }
    _markRangeMatched(t, e, i)
    {
        this._roadMatchedRangesById.has(t) || this._roadMatchedRangesById.set(t, []),
        this._roadMatchedRangesById.get(t).push({
            fromMs: e,
            toMs: i
        })
    }
    async _requestFoveatedRoadMatching()
    {
        if (!this._historicalMode)
            return;
        if (!this.playbackMode)
            return;
        const t = performance.now();
        if (t - this._roadMatchLastRequestMs < 500)
            return;
        this._roadMatchLastRequestMs = t;
        const e = window._historicalState,
            i = Array.isArray(e?.mobile) ? e.mobile : [];
        for (const t of i) {
            const e = t?.id;
            if (!e)
                continue;
            if (this._roadMatchPending.has(e))
                continue;
            const i = this._physicsStateById?.get(String(e)),
                s = this._playbackPtsById.get(String(e));
            if (!s || s.length < 2)
                continue;
            let a = 0;
            if (i && i.d > 0)
                a = i.d;
            else {
                const t = this.getPlaybackTimeMs();
                if (null != t) {
                    let e = 0;
                    for (let i = 1; i < s.length && !(s[i].tMs > t); i++) {
                        const t = s[i - 1],
                            a = s[i],
                            n = haversineMeters(t.lat, t.lon, a.lat, a.lon);
                        isFinite(n) && (e += n)
                    }
                    a = e
                }
            }
            const n = a + 2 * MapView.CURVATURE_LOOKAHEAD;
            let o = 0,
                l = s.length - 1,
                r = 0;
            for (let t = 1; t < s.length; t++) {
                const e = s[t - 1],
                    i = s[t],
                    h = haversineMeters(e.lat, e.lon, i.lat, i.lon);
                if (isFinite(h) && (r += h), r < a && (o = t), r >= n) {
                    l = t;
                    break
                }
            }
            const h = s[o]?.tMs,
                c = s[l]?.tMs;
            if (!isFinite(h) || !isFinite(c))
                continue;
            if (this._isRangeMatched(e, h, c))
                continue;
            const d = (Array.isArray(t?.trail) ? t.trail : []).filter(t => {
                const e = t && "string" == typeof t.t ? parseUtcMs(t.t) : null;
                return null != e && e >= h && e <= c
            });
            d.length < 2 || (d.some(t => 1 === t.wp) ? this._markRangeMatched(e, h, c) : (this._roadMatchPending.add(e), this._fetchAndApplyRoadMatch(e, d, h, c)))
        }
    }
    async _fetchAndApplyRoadMatch(t, e, i, s)
    {
        try {
            const a = JSON.stringify(e),
                n = `${appConfig.apiBaseUrl}/match_segment?sensor=${encodeURIComponent(t)}&trail=${encodeURIComponent(a)}`,
                o = await fetch(n);
            if (!o.ok)
                return;
            const l = (await o.json()).trail;
            if (!Array.isArray(l) || 0 === l.length)
                return;
            const r = window._historicalState,
                h = (Array.isArray(r?.mobile) ? r.mobile : []).find(e => e?.id === t);
            if (!h || !Array.isArray(h.trail))
                return;
            const c = new Map;
            for (const t of l) {
                const e = t && "string" == typeof t.t ? parseUtcMs(t.t) : null;
                null != e && (c.has(e) || c.set(e, []), c.get(e).push(t))
            }
            const d = [];
            for (const t of h.trail) {
                const e = t && "string" == typeof t.t ? parseUtcMs(t.t) : null;
                null != e && c.has(e) ? (d.push(...c.get(e)), c.delete(e)) : t.wp || d.push(t)
            }
            h.trail = d,
            this._playbackPtsKey = "",
            this._ensurePlaybackPoints(r),
            this._markRangeMatched(t, i, s)
        } catch (e) {
            console.warn(`Road match error for ${t}:`, e)
        } finally {
            this._roadMatchPending.delete(t)
        }
    }
    static CRUISE_SPEED = 12;
    static CURVE_SPEED = 8;
    static ACCEL_RATE = 4;
    static BRAKE_RATE = 6;
    static CURVATURE_LOOKAHEAD = 100;
    static TRAIL_LOOKAHEAD_BASE = 80;
    static CURVATURE_THRESHOLD = .01;
    static STOP_BUFFER = 10;
    static PHYSICS_VARIATION = .15;
    _hashId(t)
    {
        let e = 0;
        for (let i = 0; i < t.length; i++)
            e = (e << 5) - e + t.charCodeAt(i) | 0;
        return (2147483647 & e) % 1e4 / 1e4
    }
    _getVehiclePhysics(t)
    {
        this._vehiclePhysicsCache || (this._vehiclePhysicsCache = new Map);
        let e = this._vehiclePhysicsCache.get(t);
        if (e)
            return e;
        const i = this._hashId(t),
            s = this._hashId(t + "_2"),
            a = this._hashId(t + "_3"),
            n = MapView.PHYSICS_VARIATION;
        return e = {
            cruiseSpeed: MapView.CRUISE_SPEED * (1 + 2 * (i - .5) * n),
            curveSpeed: MapView.CURVE_SPEED * (1 + 2 * (s - .5) * n),
            accelRate: MapView.ACCEL_RATE * (1 + 2 * (a - .5) * n),
            brakeRate: MapView.BRAKE_RATE * (1 + 2 * (this._hashId(t + "_4") - .5) * n)
        }, this._vehiclePhysicsCache.set(t, e), e
    }
    _getPhysicsState(t)
    {
        this._physicsStateById || (this._physicsStateById = new Map);
        let e = this._physicsStateById.get(t);
        return e || (e = {
            d: 0,
            v: 0,
            lastPerfMs: null,
            totalDist: 0
        }, this._physicsStateById.set(t, e)), e
    }
    _resetPhysicsState(t)
    {
        this._physicsStateById && this._physicsStateById.delete(t)
    }
    static WAYPOINT_CHUNK_SIZE = 50;
    static WAYPOINT_BEHIND = 5;
    static WAYPOINT_AHEAD_BASE = 20;
    static WAYPOINT_AHEAD_PER_SPEED = 5;
    static JITTER_THRESHOLD_M = 8;
    static JITTER_BLEND = .3;
    static MIN_TRAIL_LENGTH_M = 50;
    static MIN_CAMERA_FIT_SEGMENT_POINTS = 3;
    static MIN_CAMERA_FIT_SEGMENT_LENGTH_M = 120;
    static MIN_CAMERA_FIT_SEGMENT_DISPLACEMENT_M = 60;
    static MIN_CAMERA_FIT_SEGMENT_STRAIGHTNESS = .2;
    static MIN_CAMERA_FIT_SEGMENT_LENGTH_M_2PT = 500;
    static MIN_CAMERA_FIT_SEGMENT_DISPLACEMENT_M_2PT = 500;
    static MAX_CAMERA_FIT_SEGMENT_LENGTH_M = 5e3;
    _getVehiclePath(t, e)
    {
        this._vehiclePathById || (this._vehiclePathById = new Map);
        let i = this._vehiclePathById.get(t);
        const s = this._playbackPtsKey;
        if (i && i.ptsKey !== s && (i = null), !i) {
            const a = e[0];
            i = {
                computedPts: [{
                    lat: a.lat,
                    lon: a.lon,
                    rawIdx: 0,
                    tMs: a.tMs,
                    m: a.m,
                    readings: a.readings
                }],
                cumDist: [0],
                lastRawIdx: 0,
                ptsKey: s
            },
            this._vehiclePathById.set(t, i)
        }
        return i
    }
    _extendVehiclePath(t, e, i, s, a)
    {
        const n = this._getVehiclePath(t, e),
            o = e.length,
            l = Math.max(.2, .85 - .12 * Math.log2(Math.max(1, s))),
            r = Math.round(100 * l);
        if (void 0 !== n.lastTensionKey && n.lastTensionKey !== r) {
            const t = a || 0;
            let e = 0;
            for (let i = 0; i < n.computedPts.length && n.computedPts[i].rawIdx <= t; i++)
                e = i;
            e < n.computedPts.length - 1 && (n.computedPts = n.computedPts.slice(0, e + 1), n.cumDist = n.cumDist.slice(0, e + 1), n.lastRawIdx = Math.floor(n.computedPts[e].rawIdx))
        }
        if (n.lastTensionKey = r, n.lastRawIdx >= i)
            return n;
        const h = (1 - l) / 2,
            c = (t, e, i, s, a) => {
                const n = a * a,
                    o = n * a,
                    l = -h * o + 2 * h * n - h * a,
                    r = (2 - h) * o + (h - 3) * n + 1,
                    c = (h - 2) * o + (3 - 2 * h) * n + h * a,
                    d = h * o - h * n;
                return {
                    lat: l * t.lat + r * e.lat + c * i.lat + d * s.lat,
                    lon: l * t.lon + r * e.lon + c * i.lon + d * s.lon
                }
            };
        for (let t = n.lastRawIdx; t < i && t < o - 1; t++) {
            const i = e[Math.max(0, t - 1)],
                s = e[t],
                a = e[Math.min(o - 1, t + 1)],
                l = e[Math.min(o - 1, t + 2)];
            for (let e = 1; e <= 4; e++) {
                const o = e / 5,
                    r = c(i, s, a, l, o),
                    h = {
                        lat: r.lat,
                        lon: r.lon,
                        rawIdx: t + o,
                        tMs: s.tMs + o * (a.tMs - s.tMs),
                        m: a.m,
                        readings: a.readings
                    },
                    d = n.computedPts[n.computedPts.length - 1],
                    u = haversineMeters(d.lat, d.lon, h.lat, h.lon);
                n.computedPts.push(h),
                n.cumDist.push(n.cumDist[n.cumDist.length - 1] + u)
            }
            const r = {
                    lat: a.lat,
                    lon: a.lon,
                    rawIdx: t + 1,
                    tMs: a.tMs,
                    m: a.m,
                    readings: a.readings
                },
                h = n.computedPts[n.computedPts.length - 1],
                d = haversineMeters(h.lat, h.lon, r.lat, r.lon);
            n.computedPts.push(r),
            n.cumDist.push(n.cumDist[n.cumDist.length - 1] + d),
            n.lastRawIdx = t + 1
        }
        return n
    }
    _getWaypointWindow(t, e, i, s)
    {
        const a = e.length;
        if (a < 2)
            return null;
        const n = MapView.WAYPOINT_AHEAD_BASE + Math.floor(MapView.WAYPOINT_AHEAD_PER_SPEED * Math.max(1, s)),
            o = Math.min(a - 1, i + n),
            l = this._extendVehiclePath(t, e, o, s, i),
            r = MapView.WAYPOINT_BEHIND,
            h = l.computedPts,
            c = l.cumDist;
        let d = 0;
        for (let t = 0; t < h.length; t++) {
            if (h[t].rawIdx >= i) {
                d = t;
                break
            }
            d = t
        }
        const u = Math.max(0, d - 5 * r),
            _ = Math.min(h.length - 1, d + 5 * n),
            m = h.slice(u, _ + 1),
            p = [],
            f = c[u];
        for (let t = u; t <= _; t++)
            p.push(c[t] - f);
        const g = p[p.length - 1] || 1,
            M = m.length,
            y = new Array(M).fill(0);
        if (M >= 3)
            for (let t = 1; t < M - 1; t++) {
                const e = m[t].lon - m[t - 1].lon,
                    i = m[t].lat - m[t - 1].lat,
                    s = m[t + 1].lon - m[t].lon,
                    a = m[t + 1].lat - m[t].lat,
                    n = Math.atan2(i, e),
                    o = Math.atan2(a, s);
                let l = Math.abs(o - n);
                l > Math.PI && (l = 2 * Math.PI - l);
                const r = (p[t] - p[t - 1] + p[t + 1] - p[t]) / 2;
                y[t] = r > .1 ? l / r : 0
            }
        return {
            waypoints: m,
            startIdx: u,
            endIdx: _,
            cumDist: p,
            totalDist: g,
            curvature: y,
            startRawIdx: h[u]?.rawIdx || 0,
            endRawIdx: h[_]?.rawIdx || a - 1,
            fullCumDist: c,
            fullStartIdx: u
        }
    }
    _getSmoothPath(t, e)
    {
        this._smoothPathCache || (this._smoothPathCache = new Map);
        const i = this._smoothPathCache.get(t);
        if (i && i.ptsLen === e.length && i.ptsKey === this._playbackPtsKey)
            return i;
        const s = e.length;
        if (s < 2) {
            const i = {
                waypoints: e.slice(),
                cumDist: [0],
                totalDist: 0,
                curvature: [0],
                origIdxMap: [0],
                ptsLen: s,
                ptsKey: this._playbackPtsKey
            };
            return this._smoothPathCache.set(t, i), i
        }
        const a = this._playbackSpeed || 1,
            n = (this._getWaypointWindow(t, e, Math.floor(s / 2), a), []);
        for (let t = 0; t < s; t++) {
            const i = e[t];
            let a = 0,
                o = 0,
                l = 0;
            for (let i = Math.max(0, t - 1); i <= Math.min(s - 1, t + 1); i++)
                a += e[i].lat,
                o += e[i].lon,
                l++;
            const r = a / l,
                h = o / l;
            let c,
                d;
            if (haversineMeters(i.lat, i.lon, r, h) < MapView.JITTER_THRESHOLD_M && t > 0 && t < s - 1) {
                const t = MapView.JITTER_BLEND;
                c = i.lat + t * (r - i.lat),
                d = i.lon + t * (h - i.lon)
            } else
                c = i.lat,
                d = i.lon;
            n.push({
                lat: c,
                lon: d,
                origIdx: t,
                tMs: i.tMs,
                m: i.m,
                readings: i.readings
            })
        }
        const o = n.length,
            l = new Array(o);
        l[0] = 0;
        for (let t = 1; t < o; t++) {
            const e = haversineMeters(n[t - 1].lat, n[t - 1].lon, n[t].lat, n[t].lon);
            l[t] = l[t - 1] + e
        }
        const r = l[o - 1] || 1,
            h = new Array(o).fill(0);
        if (o >= 3)
            for (let t = 1; t < o - 1; t++) {
                const e = n[t].lon - n[t - 1].lon,
                    i = n[t].lat - n[t - 1].lat,
                    s = n[t + 1].lon - n[t].lon,
                    a = n[t + 1].lat - n[t].lat,
                    o = Math.atan2(i, e),
                    r = Math.atan2(a, s);
                let c = Math.abs(r - o);
                c > Math.PI && (c = 2 * Math.PI - c);
                const d = (l[t] - l[t - 1] + l[t + 1] - l[t]) / 2;
                h[t] = d > .1 ? c / d : 0
            }
        const c = n.map(t => t.origIdx),
            d = {
                waypoints: n,
                cumDist: l,
                totalDist: r,
                curvature: h,
                origIdxMap: c,
                ptsLen: s,
                ptsKey: this._playbackPtsKey
            };
        return this._smoothPathCache.set(t, d), d
    }
    _getPathDistances(t, e)
    {
        this._pathDistCache || (this._pathDistCache = new Map);
        let i = this._pathDistCache.get(t);
        if (i && i.ptsLen === e.length)
            return i;
        const s = e.length,
            a = i ? i.ptsLen : 0;
        let n,
            o;
        if (i && a > 0 && s > a) {
            n = i.cumDist,
            o = i.curvature,
            n.length = s,
            o.length = s;
            for (let t = a; t < s; t++) {
                const i = haversineMeters(e[t - 1].lat, e[t - 1].lon, e[t].lat, e[t].lon);
                n[t] = n[t - 1] + i
            }
            for (let t = Math.max(1, a - 1); t < s - 1; t++) {
                const i = e[t].lon - e[t - 1].lon,
                    s = e[t].lat - e[t - 1].lat,
                    a = e[t + 1].lon - e[t].lon,
                    l = e[t + 1].lat - e[t].lat,
                    r = Math.atan2(s, i),
                    h = Math.atan2(l, a);
                let c = Math.abs(h - r);
                c > Math.PI && (c = 2 * Math.PI - c);
                const d = (n[t] - n[t - 1] + n[t + 1] - n[t]) / 2;
                o[t] = d > .1 ? c / d : 0
            }
            s > 0 && (o[s - 1] = 0)
        } else {
            n = new Array(s),
            n[0] = 0;
            for (let t = 1; t < s; t++) {
                const i = haversineMeters(e[t - 1].lat, e[t - 1].lon, e[t].lat, e[t].lon);
                n[t] = n[t - 1] + i
            }
            if (o = new Array(s).fill(0), s >= 3)
                for (let t = 1; t < s - 1; t++) {
                    const i = e[t].lon - e[t - 1].lon,
                        s = e[t].lat - e[t - 1].lat,
                        a = e[t + 1].lon - e[t].lon,
                        l = e[t + 1].lat - e[t].lat,
                        r = Math.atan2(s, i),
                        h = Math.atan2(l, a);
                    let c = Math.abs(h - r);
                    c > Math.PI && (c = 2 * Math.PI - c);
                    const d = (n[t] - n[t - 1] + n[t + 1] - n[t]) / 2;
                    o[t] = d > .1 ? c / d : 0
                }
        }
        return i = {
            cumDist: n,
            totalDist: n[s - 1] || 1,
            curvature: o,
            ptsLen: s
        }, this._pathDistCache.set(t, i), i
    }
    _catmullRom(t, e, i, s, a, n)
    {
        const o = t[e],
            l = t[i],
            r = t[s],
            h = t[a],
            c = n * n,
            d = c * n;
        return {
            lat: .5 * ((-o.lat + 3 * l.lat - 3 * r.lat + h.lat) * d + (2 * o.lat - 5 * l.lat + 4 * r.lat - h.lat) * c + (-o.lat + r.lat) * n + 2 * l.lat),
            lon: .5 * ((-o.lon + 3 * l.lon - 3 * r.lon + h.lon) * d + (2 * o.lon - 5 * l.lon + 4 * r.lon - h.lon) * c + (-o.lon + r.lon) * n + 2 * l.lon),
            dLat: .5 * (3 * (-o.lat + 3 * l.lat - 3 * r.lat + h.lat) * c + 2 * (2 * o.lat - 5 * l.lat + 4 * r.lat - h.lat) * n + (-o.lat + r.lat)),
            dLon: .5 * (3 * (-o.lon + 3 * l.lon - 3 * r.lon + h.lon) * c + 2 * (2 * o.lon - 5 * l.lon + 4 * r.lon - h.lon) * n + (-o.lon + r.lon))
        }
    }
    _samplePathAtDistance(t, e, i, s)
    {
        const a = t.length;
        if (a < 2)
            return {
                lat: t[0].lat,
                lon: t[0].lon,
                idx: 0,
                u: 0,
                heading: 0,
                curv: 0
            };
        let n = 0,
            o = a - 1;
        for (; n < o;) {
            const t = n + o + 1 >> 1;
            e[t] <= s ? n = t : o = t - 1
        }
        const l = Math.min(n, a - 2),
            r = e[l],
            h = e[l + 1],
            c = Math.max(.001, h - r),
            d = clamp((s - r) / c, 0, 1),
            u = t[l],
            _ = t[l + 1];
        return {
            lat: u.lat + (_.lat - u.lat) * d,
            lon: u.lon + (_.lon - u.lon) * d,
            idx: l,
            u: d,
            heading: Math.atan2(_.lat - u.lat, _.lon - u.lon),
            curv: (i[l] || 0) * (1 - d) + (i[l + 1] || 0) * d,
            p0: u,
            p1: _
        }
    }
    _getTargetDistance(t, e, i, s)
    {
        const a = t[0].tMs,
            n = t[t.length - 1].tMs;
        if (s <= a)
            return 0;
        if (s >= n)
            return i;
        let o = 1,
            l = t.length - 1;
        for (; o < l;) {
            const e = o + l >> 1;
            t[e].tMs >= s ? l = e : o = e + 1
        }
        const r = t[o - 1],
            h = t[o],
            c = Math.max(1, h.tMs - r.tMs),
            d = clamp((s - r.tMs) / c, 0, 1),
            u = e[o - 1];
        return u + (e[o] - u) * d
    }
    _playbackSampleForMobile(t, e)
    {
        const i = t && null != t.id ? String(t.id) : "";
        if (!i)
            return null;
        const s = this._playbackNowMs;
        if (null == s || !isFinite(s))
            return null;
        const a = this._playbackPtsById.get(i);
        if (!a || a.length < 1)
            return null;
        const n = a[0].tMs,
            o = a[a.length - 1].tMs;
        if (!isFinite(n) || !isFinite(o))
            return null;
        if (1 === a.length) {
            const t = a[0];
            return {
                lat: t.lat,
                lon: t.lon,
                m: t.m,
                readings: t.readings,
                beforeFirst: s < n,
                afterLast: s > o
            }
        }
        const {cumDist: l, totalDist: r, curvature: h} = this._getPathDistances(i, a),
            c = this._getTargetDistance(a, l, r, s);
        this._scrubbing && (this._scrubCooldownById || (this._scrubCooldownById = new Map), this._scrubCooldownById.set(i, {
            lastTargetD: c,
            lastT: s
        }));
        const d = this._scrubCooldownById?.get(i),
            u = !this._scrubbing && null != d && s - d.lastT < 1500 && c - d.lastTargetD > 50;
        if (u ? (d.lastTargetD = c, d.lastT = s) : this._scrubbing || null == d || this._scrubCooldownById.delete(i), this._scrubbing || u) {
            const o = this._getPhysicsState(i);
            o.d = c,
            o.lastPlaybackT = s,
            o.lastPerfMs = e,
            o.v = 0;
            const d = this._samplePathAtDistance(a, l, h, c);
            o.lat = d.lat,
            o.lon = d.lon,
            o.heading = d.heading,
            o.totalDist = r;
            const u = d.p1 || a[Math.min(d.idx + 1, a.length - 1)],
                _ = primaryReadingKeyedFromPoint(u),
                m = !(!u || 1 !== u.m && "1" !== u.m && !0 !== u.m);
            t._key || (t._key = keyFor("mobile", t.id));
            const p = m || this._pbDebugPath || this.selectedId === t._key ? 1 : .25;
            return this._vehicleRevealDist || (this._vehicleRevealDist = new Map), this._vehicleRevealDist.set(i, {
                d: c,
                visibleEnd: c,
                vehicleD: c,
                vehicleV: 0,
                vehicleTMs: s,
                controlScalar: 1,
                positionError: 0,
                totalDist: r
            }), {
                lat: d.lat,
                lon: d.lon,
                angle: d.heading,
                flipX: !1,
                speedMps: 0,
                opacity: p,
                reading: _,
                beforeFirst: s < n
            }
        }
        const _ = this._getPhysicsState(i),
            m = _.d > 0 ? _.d : c;
        let p = 0,
            f = l.length - 1;
        for (; p < f;) {
            const t = p + f + 1 >> 1;
            l[t] <= m ? p = t : f = t - 1
        }
        const g = p,
            M = this._playbackSpeed || 1,
            y = this._getWaypointWindow(i, a, g, M),
            b = y?.waypoints || a,
            x = this._getVehiclePhysics(i),
            S = s - (_.lastPlaybackT || s),
            w = Math.max(2e3, 250 * (this._playbackSpeed || 1)),
            v = Math.abs(S) > w || !!this._scrubbing;
        _.lastPlaybackT = s;
        const F = null != _.lastPerfMs && isFinite(_.lastPerfMs) ? Math.min(.1, Math.max(0, (e - _.lastPerfMs) / 1e3)) : .016;
        _.lastPerfMs = e;
        const P = (c - _.d) / MapView.TRAIL_LOOKAHEAD_BASE,
            T = Math.tanh(1.5 * P),
            I = Math.max(0, 1 + T * (T > 0 ? 2 : 1)),
            A = Math.sqrt(Math.max(1, M)) * I,
            C = x.cruiseSpeed * A,
            L = x.curveSpeed * Math.pow(A, .75),
            k = x.accelRate * A,
            R = x.brakeRate * Math.max(1, A),
            N = Math.min(c, r),
            E = _.totalDist !== r || v || 0 === _.d && c > 100;
        E && (_.totalDist = r, _.d = c, _.v = 0),
        this._curveLookaheadCache || (this._curveLookaheadCache = new Map);
        let D,
            B = this._curveLookaheadCache.get(i);
        if (!B || Math.abs(_.d - B.d) > 5 || Math.abs(A - B.ctrl) > .2 * (B.ctrl || 1) || E) {
            const t = MapView.CURVATURE_LOOKAHEAD * Math.max(1, A),
                e = Math.min(_.d + t, r);
            D = C;
            for (let t = g; t < h.length; t++) {
                const i = l[t];
                if (i < _.d)
                    continue;
                if (i > e)
                    break;
                const s = h[t];
                if (s <= .001)
                    continue;
                const a = L + (C - L) * (MapView.CURVATURE_THRESHOLD / (MapView.CURVATURE_THRESHOLD + s)),
                    n = i - _.d,
                    o = Math.sqrt(a * a + 2 * R * n);
                o < D && (D = o)
            }
            this._curveLookaheadCache.set(i, {
                d: _.d,
                ctrl: A,
                cruise: C,
                safeSpeed: D
            })
        } else
            D = B.safeSpeed * (C / (B.cruise || C));
        const $ = N - _.d;
        let z;
        if ($ <= 0)
            z = 0;
        else if ($ < MapView.STOP_BUFFER)
            z = Math.min(2 * Math.max(1, A), .5 * $);
        else {
            const t = .8 * Math.sqrt(2 * R * Math.max(0, $ - MapView.STOP_BUFFER));
            z = Math.min(C, t, D)
        }
        _.v < z ? _.v = Math.min(z, _.v + k * F) : _.v > z && (_.v = Math.max(z, _.v - R * F)),
        _.v = clamp(_.v, 0, C);
        const W = _.d + _.v * F;
        W >= N ? (_.d = N, _.v = 0) : _.d = W,
        _.d = clamp(_.d, 0, r);
        const O = this._samplePathAtDistance(a, l, h, _.d);
        let V;
        if (y && b.length >= 2) {
            const t = this._vehiclePathById?.get(i);
            if (t && t.computedPts.length >= 2) {
                const e = t.computedPts;
                t.cumDist;
                let i = 0,
                    s = 0;
                for (let t = 0; t < l.length - 1; t++) {
                    if (l[t + 1] >= _.d) {
                        i = t;
                        const e = l[t + 1] - l[t];
                        s = e > 0 ? (_.d - l[t]) / e : 0;
                        break
                    }
                    i = t
                }
                const a = i + s;
                let n = 0;
                for (let t = 0; t < e.length - 1; t++) {
                    if (e[t + 1].rawIdx >= a) {
                        n = t;
                        break
                    }
                    n = t
                }
                const o = e[n],
                    r = e[Math.min(e.length - 1, n + 1)],
                    h = r.rawIdx - o.rawIdx,
                    c = h > 0 ? clamp((a - o.rawIdx) / h, 0, 1) : 0;
                V = {
                    lat: o.lat + c * (r.lat - o.lat),
                    lon: o.lon + c * (r.lon - o.lon),
                    heading: Math.atan2(r.lat - o.lat, r.lon - o.lon),
                    m: r.m,
                    readings: r.readings
                }
            } else
                V = O
        } else
            V = O;
        if ((null == _.lat || null == _.lon || E) && (_.lat = O.lat, _.lon = O.lon, _.heading = O.heading), !this._scrubbing) {
            const t = 3,
                e = 1 - Math.exp(-t * F);
            _.lat += e * (O.lat - _.lat),
            _.lon += e * (O.lon - _.lon);
            let i = O.heading - _.heading;
            for (; i > Math.PI;)
                i -= 2 * Math.PI;
            for (; i < -Math.PI;)
                i += 2 * Math.PI;
            _.heading += e * i
        }
        if (this._pbDebugPath) {
            this._vehicleActualPathById || (this._vehicleActualPathById = new Map);
            let t = this._vehicleActualPathById.get(i);
            t && !E || (t = [], this._vehicleActualPathById.set(i, t));
            const e = t.length > 0 ? t[t.length - 1] : null,
                s = 2;
            if (!e || Math.abs(_.d - e.d) >= s) {
                t.push({
                    lat: _.lat,
                    lon: _.lon,
                    d: _.d
                });
                const e = 50,
                    i = 10;
                for (; t.length > e + i && t[0].d < _.d - e * s;)
                    t.shift()
            }
        }
        const H = _.lat,
            K = _.lon,
            U = _.heading,
            {idx: G, u: Y, p0: X, p1: Z} = O,
            q = Z || a[Math.min(G + 1, a.length - 1)],
            j = X || a[G],
            J = Math.max(1, q.tMs - j.tMs),
            Q = j.tMs + (q.tMs - j.tMs) * Y;
        let tt = 0;
        if (G < a.length - 1) {
            const t = a[G],
                e = a[G + 1],
                i = l[G + 1] - l[G],
                s = (e.tMs - t.tMs) / 1e3;
            s > .1 && (tt = i / s)
        }
        let et = tt;
        s >= o - 1 && (et = 0);
        let it = 1;
        const st = !(!q || 1 !== q.m && "1" !== q.m && !0 !== q.m);
        t._key || (t._key = keyFor("mobile", t.id));
        const at = t._key,
            nt = this.selectedId === at;
        st || this._pbDebugPath || nt || (it = .25),
        J > 305e3 && s > j.tMs + 5e3 && s < q.tMs - 5e3 && !this._pbDebugPath && !nt && (it = .25),
        this._screenHeadingCache || (this._screenHeadingCache = new Map);
        let ot,
            lt = this._screenHeadingCache.get(i);
        if (!lt || E || Math.abs(H - lt.lat) > 1e-6 || Math.abs(K - lt.lon) > 1e-6 || Math.abs(U - lt.heading) > .01 || this.zoom !== lt.zoom) {
            const t = latLonToWorld(H, K, this.zoom),
                e = 1e-4,
                s = latLonToWorld(H + Math.sin(U) * e, K + Math.cos(U) * e, this.zoom);
            let a = s.x - t.x,
                n = s.y - t.y;
            Math.abs(a) < 1e-9 && Math.abs(n) < 1e-9 && (a = .001, n = 0),
            ot = Math.atan2(n, a),
            this._screenHeadingCache.set(i, {
                lat: H,
                lon: K,
                heading: U,
                zoom: this.zoom,
                screenHeading: ot
            })
        } else
            ot = lt.screenHeading;
        const rt = Math.abs(ot),
            ht = Math.PI / 2 + .22,
            ct = Math.PI / 2 - .22;
        let dt = this._traceLastSideById.get(i);
        "L" !== dt && "R" !== dt && (dt = rt > Math.PI / 2 ? "L" : "R"),
        "R" === dt && rt > ht ? dt = "L" : "L" === dt && rt < ct && (dt = "R"),
        this._traceLastSideById.set(i, dt);
        let ut = ot;
        "L" === dt && (ut = Math.PI - ot),
        ut > Math.PI && (ut -= 2 * Math.PI),
        ut < -Math.PI && (ut += 2 * Math.PI);
        const _t = t => {
                let e = t;
                for (; e > Math.PI;)
                    e -= 2 * Math.PI;
                for (; e < -Math.PI;)
                    e += 2 * Math.PI;
                return e
            },
            mt = this._traceAngleById.get(i),
            pt = this._traceAngleLastMsById.get(i),
            ft = null != pt && isFinite(pt) ? Math.max(0, (e - pt) / 1e3) : 0,
            gt = ft > 0 ? 1 - Math.exp(-ft / .25) : 1,
            Mt = null == mt ? ut : _t(mt + _t(ut - mt) * gt);
        this._traceAngleById.set(i, Mt),
        this._traceAngleLastMsById.set(i, e);
        const yt = primaryReadingKeyedFromPoint(q);
        return this._vehicleRevealDist || (this._vehicleRevealDist = new Map), this._vehicleRevealDist.set(i, {
            d: c,
            visibleEnd: N,
            vehicleD: _.d,
            vehicleV: _.v,
            vehicleTMs: Q,
            controlScalar: A,
            positionError: P,
            totalDist: r
        }), {
            lat: H,
            lon: K,
            angle: Mt,
            flipX: "L" === dt,
            speedMps: et,
            opacity: it,
            reading: yt,
            beforeFirst: s < n
        }
    }
    _ensureTracePoints(t)
    {
        const e = this._tracePointsKeyForState(t);
        if (this._tracePtsKey === e)
            return;
        this._tracePtsKey = e;
        const i = new Map,
            s = new Map,
            a = Array.isArray(t?.mobile) ? t.mobile : [];
        for (const t of a) {
            const e = t && t.id ? String(t.id) : "";
            if (!e)
                continue;
            if (t && t.ghosted) {
                this._traceActiveRouteById.delete(e),
                this._tracePendingRouteById.delete(e),
                this._traceCycleStartMsById.delete(e);
                continue
            }
            const a = Array.isArray(t?.trail) ? t.trail : [],
                n = [],
                o = a.length >= 2,
                l = this._traceActiveRouteById.has(e),
                r = this._persistedTrailById.get(e)?.trail || [];
            if (!o && l) {
                this._tracePendingRouteById.delete(e);
                continue
            }
            const h = r.length >= 2 ? r : a;
            if (h.length < 2)
                continue;
            const c = h[0] && "string" == typeof h[0].t ? parseUtcMs(h[0].t) : null,
                d = null != c ? c : 0,
                u = 3e3;
            for (let t = 0; t < h.length; t++) {
                const e = h[t],
                    i = Number(e.lat),
                    s = Number(e.lon);
                if (!isFinite(i) || !isFinite(s))
                    continue;
                const a = e && "string" == typeof e.t ? parseUtcMs(e.t) : null,
                    o = null != a ? a : d + t * u;
                n.push({
                    lat: i,
                    lon: s,
                    tMs: o,
                    m: e.m
                })
            }
            if (n.length >= 2) {
                i.set(e, n);
                const t = 5e3,
                    a = Number(this._traceMaxSpeedMps) || 18,
                    o = Number(this._traceRealMaxSpeedMps) || 20,
                    l = Number(this._traceTargetMedianSpeedMps) || 7,
                    r = Number(this._traceSpeedSmoothingTauS) || 1.6,
                    h = Number(this._traceStopSpeedMps) || .25,
                    c = Number(this._traceDwellTimeCompression) || 12,
                    d = Number(this._traceStopMinMs) || 350,
                    _ = Number(this._traceStopMaxMs) || 3500,
                    m = [],
                    p = [],
                    f = [];
                for (let t = 0; t < n.length - 1; t++) {
                    const e = n[t],
                        i = n[t + 1],
                        s = haversineMeters(e.lat, e.lon, i.lat, i.lon);
                    let a = i.tMs - e.tMs;
                    (!isFinite(a) || a <= 0) && (a = u);
                    const o = Math.max(.2, a / 1e3),
                        l = s / o;
                    p.push(s),
                    f.push(o),
                    m.push(isFinite(l) ? l : 0)
                }
                const g = m.map((t, e) => ({
                    v: t,
                    i: e
                })).filter(t => isFinite(t.v) && t.v > .4 && p[t.i] > 8);
                let M = 1;
                if (g.length >= 3) {
                    const t = g.map(t => t.v).sort((t, e) => t - e),
                        e = Math.floor(t.length / 2),
                        i = t.length % 2 ? t[e] : (t[e - 1] + t[e]) / 2;
                    isFinite(i) && i > .001 && (M = clamp(l / i, .8, 25))
                }
                const y = [],
                    b = [],
                    x = [],
                    S = [];
                let w = 0,
                    v = 0,
                    F = 0;
                for (let t = 0; t < n.length - 1; t++) {
                    n[t],
                    n[t + 1];
                    const e = p[t] || 0,
                        i = f[t] || 1;
                    let s = m[t] * M;
                    isFinite(s) || (s = 0),
                    s = clamp(s, 0, a);
                    const l = e < 3 || s < h;
                    let u;
                    if (v += (1 - Math.exp(-i / r)) * (s - v), l)
                        u = 1e3 * i / Math.max(1, c),
                        u = clamp(u, d, _),
                        x.push(0),
                        S.push(0);
                    else {
                        u = e / Math.max(.8, Math.min(v, a)) * 1e3,
                        u = clamp(u, 120, 8e3),
                        x.push(e > 0 ? e / Math.max(.001, u / 1e3) : 0);
                        let s = m[t];
                        isFinite(s) || (s = 0),
                        s = clamp(s, 0, o);
                        F += (1 - Math.exp(-i / Math.max(.8, r))) * (s - F),
                        S.push(clamp(F, 0, o))
                    }
                    y.push(w),
                    b.push(u),
                    w += u
                }
                const P = Math.max(1, w),
                    T = n[0],
                    I = 0,
                    A = P + t;
                s.set(e, {
                    pts: n,
                    segStartMs: y,
                    segDurMs: b,
                    segSpeedMps: x,
                    segRealSpeedMps: S,
                    driveMs: P,
                    pauseMs: t,
                    returnMs: I,
                    loopStartLat: T.lat,
                    loopStartLon: T.lon,
                    totalMs: A,
                    newPathStartMs: 0
                })
            }
        }
        this._tracePtsById.clear();
        for (const [t, e] of i.entries())
            this._tracePtsById.set(t, e);
        for (const [t, e] of s.entries())
            this._traceActiveRouteById.has(t) ? this._tracePendingRouteById.set(t, e) : this._traceActiveRouteById.set(t, e)
    }
    _compositePaFieldOnTiles(t, e=!1)
    {
        if (!e && this._touchActive)
            return;
        if (!e && !this._tilesSnapshotCanvas)
            return;
        const i = this.playbackMode ? this.getPlaybackTimeMs() : null;
        if (this._ensurePaField(t, i), null != i && isFinite(i) && this._preWarmPaFields(t, i), !this._paFieldCanvas)
            return;
        const s = this.tctx;
        if (!s)
            return;
        if (!e && this._tilesSnapshotCanvas) {
            const t = this._dpr || window.devicePixelRatio || 1,
                e = this.tilesCanvas.width,
                i = this.tilesCanvas.height,
                a = this._cssW || 1,
                n = this._cssH || 1;
            if (s.save(), s.setTransform(1, 0, 0, 1, 0, 0), s.clearRect(0, 0, e, i), this._pinchZooming && this._tilesSnapshotMeta) {
                const e = this._tilesSnapshotMeta,
                    i = Math.pow(2, this.zoom - e.zoom),
                    o = latLonToWorld(e.centerLat, e.centerLon, e.zoom),
                    l = latLonToWorld(this.center.lat, this.center.lon, e.zoom),
                    r = (o.x - l.x) * i,
                    h = (o.y - l.y) * i;
                s.setTransform(t, 0, 0, t, 0, 0),
                s.translate(a / 2, n / 2),
                s.scale(i, i),
                s.translate(-a / 2 + r / i, -n / 2 + h / i),
                s.drawImage(this._tilesSnapshotCanvas, 0, 0, a, n)
            } else if (this._tilesSnapshotMeta) {
                const e = this._tilesSnapshotMeta,
                    i = latLonToWorld(e.centerLat, e.centerLon, e.zoom),
                    a = latLonToWorld(this.center.lat, this.center.lon, e.zoom),
                    n = (i.x - a.x) * t,
                    o = (i.y - a.y) * t;
                s.drawImage(this._tilesSnapshotCanvas, n, o)
            } else
                s.drawImage(this._tilesSnapshotCanvas, 0, 0);
            s.restore()
        }
        s.save(),
        s.setTransform(1, 0, 0, 1, 0, 0);
        const a = this._paFieldPrevCanvas ? Math.min(1, (performance.now() - this._paFieldFadeStart) / this._paFieldFadeMs) : 1;
        this._paFieldPrevCanvas && a < 1 ? (s.globalAlpha = 1 - a, s.drawImage(this._paFieldPrevCanvas, 0, 0), s.globalAlpha = a, s.drawImage(this._paFieldCanvas, 0, 0), s.globalAlpha = 1, this._paFieldFadeRAF || (this._paFieldFadeRAF = requestAnimationFrame(() => {
            this._paFieldFadeRAF = null,
            this._compositePaFieldOnTiles(this.lastState),
            this.drawOverlay(this.lastState, {
                cacheUnderlay: !0
            })
        }))) : (this._paFieldPrevCanvas && (this._paFieldPrevCanvas = null), s.drawImage(this._paFieldCanvas, 0, 0)),
        s.restore()
    }
    _ensurePaField(t, e)
    {
        const i = this._cssW || 1,
            s = this._cssH || 1;
        if (i < 2 || s < 2)
            return;
        const a = this._dpr || window.devicePixelRatio || 1,
            n = Number(this.zoom),
            o = Number(this.center?.lat),
            l = Number(this.center?.lon),
            r = Array.isArray(t && t.fixed) ? t.fixed : [],
            h = latLonToWorld(o, l, n),
            c = [];
        let d = "";
        const u = [];
        for (const t of r) {
            if (!t.purpleair)
                continue;
            const e = Number(t.lat),
                i = Number(t.lon);
            isFinite(e) && isFinite(i) && u.push(e, i)
        }
        for (const t of r) {
            const a = Number(t.lat),
                o = Number(t.lon);
            if (!isFinite(a) || !isFinite(o))
                continue;
            if (!t.purpleair) {
                let t = !1;
                for (let e = 0; e < u.length; e += 2) {
                    const i = a - u[e],
                        s = o - u[e + 1];
                    if (i * i + s * s < .55 * .55) {
                        t = !0;
                        break
                    }
                }
                if (!t)
                    continue
            }
            const l = interpolateFixedReadingsAtTime(t, e),
                r = l && (l.PM25 || l["PM2.5"] || l.pm25 || l["pm2.5"]),
                _ = r && null != r.value ? Number(r.value) : NaN;
            if (!isFinite(_) || _ < 0)
                continue;
            const m = latLonToWorld(a, o, n),
                p = m.x - h.x + i / 2,
                f = m.y - h.y + s / 2;
            c.push(p, f, _),
            d += _pm25ColorCat(_)
        }
        const _ = c.length / 3;
        if (0 === _)
            return void (this._paFieldCanvas = null);
        const m = `pa:${`${i}|${s}|${n.toFixed(4)}|${o.toFixed(6)},${l.toFixed(6)}`}|f:${d}`;
        if (this._paFieldCanvas && this._paFieldKey === m)
            return;
        const p = d !== (this._paFieldFingerprint || "");
        this._paFieldCanvas && p ? (this._paFieldPrevCanvas = this._paFieldCanvas, this._paFieldCanvas = null, this._paFieldFadeStart = performance.now()) : this._paFieldPrevCanvas = null,
        this._paFieldKey = m,
        this._paFieldFingerprint = d;
        const f = Math.ceil(i / 16),
            g = Math.ceil(s / 16),
            M = latLonToWorld(o, l + .15, n),
            y = Math.abs(M.x - h.x),
            b = y * y,
            x = y / 3,
            S = 2 * x * x,
            w = new Float64Array(3 * _);
        for (let t = 0; t < _; t++) {
            const e = 3 * t;
            w[e] = c[e],
            w[e + 1] = c[e + 1],
            w[e + 2] = Math.min(c[e + 2], 75)
        }
        this._computePaFieldSync(w, f, g, 16, b, S, 46, i, s, a)
    }
    _computePaFieldSync(t, e, i, s, a, n, o, l, r, h)
    {
        if (!this._paGrid || this._paGrid.gw !== e || this._paGrid.gh !== i) {
            const t = document.createElement("canvas");
            t.width = e,
            t.height = i;
            const s = t.getContext("2d");
            this._paGrid = {
                tc: t,
                tctx: s,
                imgData: s.createImageData(e, i),
                gw: e,
                gh: i
            }
        }
        const {tc: c, tctx: d, imgData: u} = this._paGrid,
            _ = u.data;
        for (let l = 0; l < i; l++) {
            const i = (l + .5) * s;
            for (let r = 0; r < e; r++) {
                const h = (r + .5) * s;
                let c = 0,
                    d = 0;
                for (let e = 0; e < t.length; e += 3) {
                    const s = h - t[e],
                        o = i - t[e + 1],
                        l = s * s + o * o;
                    if (l > a)
                        continue;
                    const r = Math.exp(-l / n);
                    c += r,
                    d += r * t[e + 2]
                }
                const u = 4 * (l * e + r);
                if (c < .001)
                    _[u] = 0,
                    _[u + 1] = 0,
                    _[u + 2] = 0,
                    _[u + 3] = 0;
                else {
                    const t = Math.min(1, 2 * c),
                        e = Math.round(o * t),
                        i = _pm25ToRgbSmooth(d / c);
                    _[u] = i[0],
                    _[u + 1] = i[1],
                    _[u + 2] = i[2],
                    _[u + 3] = e
                }
            }
        }
        const m = _.length;
        this._paGrid.blurBuf && this._paGrid.blurBuf.length === m || (this._paGrid.blurBuf = new Uint8ClampedArray(m));
        const p = this._paGrid.blurBuf;
        p.fill(0);
        for (let t = 0; t < i; t++)
            for (let i = 0; i < e; i++) {
                let s = 0,
                    a = 0,
                    n = 0,
                    o = 0,
                    l = 0;
                for (let r = -2; r <= 2; r++) {
                    const h = i + r;
                    if (h < 0 || h >= e)
                        continue;
                    const c = 4 * (t * e + h);
                    if (0 === _[c + 3])
                        continue;
                    const d = 1 / (1 + r * r);
                    s += _[c] * d,
                    a += _[c + 1] * d,
                    n += _[c + 2] * d,
                    o += _[c + 3] * d,
                    l += d
                }
                const r = 4 * (t * e + i);
                l > 0 && (p[r] = s / l, p[r + 1] = a / l, p[r + 2] = n / l, p[r + 3] = o / l)
            }
        for (let t = 0; t < e; t++)
            for (let s = 0; s < i; s++) {
                let a = 0,
                    n = 0,
                    o = 0,
                    l = 0,
                    r = 0;
                for (let h = -2; h <= 2; h++) {
                    const c = s + h;
                    if (c < 0 || c >= i)
                        continue;
                    const d = 4 * (c * e + t);
                    if (0 === p[d + 3])
                        continue;
                    const u = 1 / (1 + h * h);
                    a += p[d] * u,
                    n += p[d + 1] * u,
                    o += p[d + 2] * u,
                    l += p[d + 3] * u,
                    r += u
                }
                const h = 4 * (s * e + t);
                r > 0 && (_[h] = a / r, _[h + 1] = n / r, _[h + 2] = o / r, _[h + 3] = l / r)
            }
        d.putImageData(u, 0, 0),
        this._upscalePaField(c, l, r, h)
    }
    _upscalePaField(t, e, i, s)
    {
        this._paFieldCanvas || (this._paFieldCanvas = document.createElement("canvas"));
        const a = Math.floor(e * s),
            n = Math.floor(i * s);
        this._paFieldCanvas.width === a && this._paFieldCanvas.height === n || (this._paFieldCanvas.width = a, this._paFieldCanvas.height = n);
        const o = this._paFieldCanvas.getContext("2d");
        o && (o.setTransform(s, 0, 0, s, 0, 0), o.clearRect(0, 0, e, i), o.imageSmoothingEnabled = !0, o.imageSmoothingQuality = "high", o.drawImage(t, 0, 0, e, i))
    }
    _onPaWorkerResult(t)
    {
        const {px: e, gw: i, gh: s, jobId: a} = t;
        if (a !== this._paWorkerJobId)
            return;
        this._paWorkerPending = !1;
        const n = this._paWorkerFingerprint;
        if (n && (this._paFieldPrewarmed.set(n, {
            px: new Uint8ClampedArray(e),
            gw: i,
            gh: s
        }), this._paFieldPrewarmed.size > this._paFieldCacheMax)) {
            const t = this._paFieldPrewarmed.keys().next().value;
            this._paFieldPrewarmed.delete(t)
        }
    }
    _preWarmPaFields(t, e)
    {
        if (!this._paWorker)
            try {
                this._paWorker = new Worker("pa_field_worker.js"),
                this._paWorker.onmessage = t => this._onPaWorkerResult(t.data)
            } catch (t) {
                this._paWorker = !1
            }
        if (!this._paWorker || this._paWorkerPending)
            return;
        const i = Array.isArray(t && t.fixed) ? t.fixed : [],
            s = this._cssW || 1,
            a = this._cssH || 1;
        if (s < 2 || a < 2)
            return;
        const n = Number(this.zoom),
            o = Number(this.center?.lat),
            l = Number(this.center?.lon),
            r = e + 18e5,
            h = new Set;
        for (const t of i) {
            const i = t && t.readings;
            if (i)
                for (const t of Object.keys(i)) {
                    const s = i[t];
                    if (!s || !s._parsedTimeline)
                        continue;
                    const {timesMs: a, valuesF: n} = s._parsedTimeline;
                    if (!a || a.length < 2)
                        continue;
                    let o = 0;
                    for (let t = 0; t < a.length && a[t] <= e; t++)
                        o = t;
                    const l = _pm25ColorCat(n[o]);
                    for (let t = o + 1; t < a.length && !(a[t] > r); t++)
                        if (_pm25ColorCat(n[t]) !== l) {
                            h.add(a[t]);
                            break
                        }
                }
        }
        const c = Array.from(h).sort((t, e) => t - e);
        for (const t of c) {
            const e = latLonToWorld(o, l, n),
                r = [];
            let h = "";
            const c = [];
            for (const t of i) {
                if (!t.purpleair)
                    continue;
                const e = Number(t.lat),
                    i = Number(t.lon);
                isFinite(e) && isFinite(i) && c.push(e, i)
            }
            const d = .55;
            for (const o of i) {
                const i = Number(o.lat),
                    l = Number(o.lon);
                if (!isFinite(i) || !isFinite(l))
                    continue;
                if (!o.purpleair) {
                    let t = !1;
                    for (let e = 0; e < c.length; e += 2) {
                        const s = i - c[e],
                            a = l - c[e + 1];
                        if (s * s + a * a < d * d) {
                            t = !0;
                            break
                        }
                    }
                    if (!t)
                        continue
                }
                const u = interpolateFixedReadingsAtTime(o, t),
                    _ = u && (u.PM25 || u["PM2.5"] || u.pm25 || u["pm2.5"]),
                    m = _ && null != _.value ? Number(_.value) : NaN;
                if (!isFinite(m) || m < 0)
                    continue;
                const p = latLonToWorld(i, l, n);
                r.push(p.x - e.x + s / 2, p.y - e.y + a / 2, m),
                h += _pm25ColorCat(m)
            }
            if (0 === r.length)
                continue;
            if (this._paFieldPrewarmed.has(h))
                continue;
            const u = 16,
                _ = Math.ceil(s / u),
                m = Math.ceil(a / u),
                p = latLonToWorld(o, l + .15, n),
                f = Math.abs(p.x - e.x),
                g = f * f,
                M = f / 3,
                y = 2 * M * M,
                b = 46,
                x = r.length / 3,
                S = new Float64Array(3 * x);
            for (let t = 0; t < x; t++) {
                const e = 3 * t;
                S[e] = r[e],
                S[e + 1] = r[e + 1],
                S[e + 2] = Math.min(r[e + 2], 75)
            }
            const w = ++this._paWorkerJobId;
            return this._paWorkerPending = !0, this._paWorkerFingerprint = h, void this._paWorker.postMessage({
                sensors: S,
                gw: _,
                gh: m,
                cellSize: u,
                cutoffSq: g,
                twoSigmaSq: y,
                FIELD_ALPHA: b,
                jobId: w
            })
        }
    }
    _overlayStaticKeyForState(t)
    {
        const e = this._cssW || 1,
            i = this._cssH || 1,
            s = Number(this.zoom),
            a = Number(this.center?.lat),
            n = Number(this.center?.lon),
            o = this.selectedId || "",
            l = this._tracePointsKeyForState(t),
            r = `persist:${this._persistedTrailRev}`,
            h = this.showFixedLabels ? 1 : 0,
            c = this.getPlaybackTimeMs(),
            d = null != c && isFinite(c) ? Math.round(c / 1e3) : "live";
        return `${l}|${r}|w:${e}|h:${i}|z:${s.toFixed(4)}|c:${a.toFixed(6)},${n.toFixed(6)}|sel:${o}|fixed:1|fl:${h}|pb:${d}`
    }
    _collectTrailData(t, e)
    {
        const i = t && null != t.id ? String(t.id) : "",
            s = this.getPlaybackTimeMs(),
            a = Array.isArray(t?.trail) ? t.trail : [],
            n = a.length >= 2,
            o = this.playbackMode || n,
            l = !i || this._historicalMode || this.playbackMode ? [] : this._persistedTrailById.get(i)?.trail || [],
            r = o ? n ? a : l : l.length >= 2 ? l : a;
        if (!Array.isArray(r) || r.length < 2)
            return null;
        const h = !!t.ghosted,
            c = [],
            d = [],
            u = [],
            _ = e || this.worldToScreen.bind(this),
            m = worldSizeForZoom(this.zoom),
            p = null != s && isFinite(s);
        let f = null,
            g = null,
            M = null,
            y = 0;
        if (p && r.length > 50) {
            const t = s - 3e6,
                e = r[0];
            if (e && void 0 !== e._tMs) {
                let e = 0,
                    i = r.length - 1;
                for (; e < i;) {
                    const s = e + i >> 1,
                        a = r[s]._tMs;
                    null != a && a < t ? e = s + 1 : i = s
                }
                y = Math.max(0, e - 1)
            }
        }
        for (let t = y; t < r.length; t++) {
            const e = r[t];
            let i = e._u,
                a = e._v;
            if (void 0 === i) {
                const t = Number(e.lat),
                    s = Number(e.lon);
                if (null == e.lat || null == e.lon || !isFinite(t) || !isFinite(s)) {
                    c.push(null),
                    d.push(null),
                    u.push(null),
                    f = null,
                    g = null,
                    M = null;
                    continue
                }
                const n = latLonToNorm(t, s);
                i = n.u,
                a = n.v,
                e._u = i,
                e._v = a
            }
            let n = e?._tMs;
            if (void 0 === n) {
                n = e && "string" == typeof e.t ? parseUtcMs(e.t) : null;
                try {
                    e._tMs = n
                } catch {}
            }
            let o = e._cachedColor;
            if (void 0 === o) {
                const t = primaryReadingFromPoint(e);
                o = safeHex(null != t?.ci ? t.ci : t?.color);
                try {
                    e._cachedColor = o
                } catch {}
            }
            const l = _(i * m, a * m);
            if (p && null != n && isFinite(n) && n > s) {
                if (null != f && isFinite(f) && f <= s && null != g && null != M) {
                    const t = n - f,
                        e = t > 0 ? (s - f) / t : 0,
                        l = g + e * (i - g),
                        r = M + e * (a - M);
                    c.push(_(l * m, r * m)),
                    d.push(o),
                    u.push(s)
                }
                break
            }
            c.push(l),
            d.push(o),
            u.push(n),
            f = n,
            g = i,
            M = a
        }
        return c.length < 2 ? null : {
            pts: c,
            cols: d,
            times: u,
            trail: r,
            isGhost: h
        }
    }
    _ensureOverlayStatic(t)
    {
        const e = this._dpr || window.devicePixelRatio || 1,
            i = this._cssW || 1,
            s = this._cssH || 1,
            a = this._overlayStaticKeyForState(t);
        if (!this._overlayStaticDirty && this._overlayStaticCanvas && this._overlayStaticKey === a)
            return;
        this._overlayStaticDirty = !1,
        this._overlayStaticKey = a,
        this._overlayStaticCanvas || (this._overlayStaticCanvas = document.createElement("canvas")),
        this._overlayStaticCanvas.width = Math.floor(i * e),
        this._overlayStaticCanvas.height = Math.floor(s * e);
        const n = this._overlayStaticCanvas.getContext("2d");
        if (!n)
            return;
        if (n.setTransform(e, 0, 0, e, 0, 0), n.clearRect(0, 0, i, s), !t)
            return;
        const o = Array.isArray(t.mobile) ? t.mobile : [],
            l = Array.isArray(t.fixed) ? t.fixed : [],
            r = latLonToWorld(this.center.lat, this.center.lon, this.zoom),
            h = (t, e) => ({
                x: t - r.x + i / 2,
                y: e - r.y + s / 2
            });
        if (this.showFixed) {
            this._fixedGeoOffsets = new Map;
            {
                const t = 3e-4,
                    e = .002,
                    i = [];
                for (const t of l) {
                    if (t.purpleair)
                        continue;
                    const e = Number(t.lat),
                        s = Number(t.lon);
                    isFinite(e) && isFinite(s) && (t._key || (t._key = keyFor("fixed", t.id)), i.push({
                        f: t,
                        lat: e,
                        lon: s,
                        dlat: 0,
                        dlon: 0
                    }))
                }
                for (let s = 0; s < i.length; s++)
                    for (let a = s + 1; a < i.length; a++) {
                        const n = i[s],
                            o = i[a];
                        if (Math.abs(n.lat - o.lat) + Math.abs(n.lon - o.lon) < e) {
                            const e = o.lat - n.lat,
                                i = o.lon - n.lon,
                                s = Math.abs(e) + Math.abs(i) > 1e-7 ? Math.atan2(i, e) : Math.PI / 4;
                            n.dlat -= Math.cos(s) * t,
                            n.dlon -= Math.sin(s) * t,
                            o.dlat += Math.cos(s) * t,
                            o.dlon += Math.sin(s) * t
                        }
                    }
                for (const t of i)
                    (t.dlat || t.dlon) && this._fixedGeoOffsets.set(t.f._key, {
                        dlat: t.dlat,
                        dlon: t.dlon
                    })
            }
            const t = t => {
                let e = Number(t.lat),
                    a = Number(t.lon);
                if (!isFinite(e) || !isFinite(a))
                    return;
                t._key || (t._key = keyFor("fixed", t.id));
                const o = this._fixedGeoOffsets && this._fixedGeoOffsets.get(t._key);
                o && (e += o.dlat, a += o.dlon);
                const l = latLonToWorld(e, a, this.zoom),
                    r = h(l.x, l.y);
                if (r.x < -50 || r.y < -50 || r.x > i + 50 || r.y > s + 50)
                    return;
                t._key || (t._key = keyFor("fixed", t.id));
                const c = t._key,
                    d = this.selectedId === c,
                    u = t.purpleair ? "" : t.emoji || "📍",
                    _ = t.name && t.name.length && String(t.name) !== String(t.id) ? t.name : t.id,
                    m = safeHex(t.ci),
                    p = primaryReadingForFixedAtTime(t, this.getPlaybackTimeMs());
                n.save();
                const f = !!t.purpleair;
                if (f) {
                    let e = 1;
                    if (!d && t.last_seen) {
                        const i = 27e5,
                            s = .2,
                            a = this._dataNowMs() - 1e3 * t.last_seen;
                        if (a >= i)
                            return void n.restore();
                        const o = i * (1 - s);
                        if (a > o) {
                            const t = (a - o) / (i - o);
                            e = (1 - t) * (1 - t)
                        }
                    }
                    const i = d ? 8 : 6,
                        s = safeHex(p && p.color || m);
                    if (d && (n.beginPath(), n.fillStyle = "rgba(56, 140, 220, 0.38)", n.arc(r.x, r.y, i + 4, 0, 2 * Math.PI), n.fill()), n.beginPath(), d)
                        n.fillStyle = s;
                    else {
                        const t = darkenHex(s, .85);
                        n.fillStyle = hexToRgba(t, .45 * e)
                    }
                    n.arc(r.x, r.y, i, 0, 2 * Math.PI),
                    n.fill(),
                    n.strokeStyle = d ? "#5bb8f5" : darkenHex(s, .7),
                    n.globalAlpha = (d ? 1 : .5) * e,
                    n.lineWidth = d ? 1.8 : 1.2,
                    n.stroke()
                } else {
                    const t = _isLite ? 10 : 15,
                        e = _isLite ? 8 : 12,
                        i = _isLite ? 10 : 15;
                    d && (n.beginPath(), n.fillStyle = "rgba(56, 140, 220, 0.38)", n.arc(r.x, r.y, t, 0, 2 * Math.PI), n.fill()),
                    n.beginPath(),
                    n.fillStyle = "rgba(16, 20, 28, 0.68)",
                    n.arc(r.x, r.y, e, 0, 2 * Math.PI),
                    n.fill(),
                    n.strokeStyle = d ? "#5bb8f5" : safeHex(p && p.color || m),
                    n.lineWidth = d ? 2.4 : 2,
                    n.stroke(),
                    n.font = `${i}px Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif`,
                    n.textAlign = "center",
                    n.textBaseline = "middle",
                    n.fillText(u, r.x, r.y)
                }
                if (this.showFixedLabels && !f || d || "Home" === String(t.id)) {
                    n.font = "600 12px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
                    const t = _,
                        e = p.key ? String(p.key) : "",
                        i = formatTagValue(p.value),
                        s = n.measureText(t),
                        a = n.measureText(e ? `${e} ` : ""),
                        o = n.measureText(i),
                        l = s.width > 0 ? s.width : 7 * t.length,
                        h = a.width > 0 ? a.width : 7 * (e ? e.length + 1 : 0),
                        c = o.width > 0 ? o.width : 7 * i.length,
                        d = 8,
                        u = Math.max(l, h + c) + 2 * d,
                        f = e || i ? 30 : 18,
                        g = r.x - u / 2,
                        M = r.y + 18;
                    n.fillStyle = "rgba(16, 20, 28, 0.82)",
                    n.strokeStyle = safeHex(p && p.color || m),
                    n.lineWidth = 1.8,
                    roundRect(n, g, M, u, f, 9),
                    n.fill(),
                    n.stroke(),
                    n.fillStyle = "#e8eef7",
                    n.textAlign = "center",
                    n.textBaseline = "middle";
                    const y = 4,
                        b = (f - 2 * y) / (e || i ? 2 : 1),
                        x = M + y + .5 * b,
                        S = M + y + 1.5 * b;
                    if (n.fillText(t, r.x, x), e || i) {
                        const t = r.x - (h + c) / 2;
                        n.fillStyle = "rgba(232,238,247,0.70)",
                        n.fillText(e ? `${e} ` : "", t + h / 2, S),
                        n.fillStyle = p.color || "#ffffff",
                        n.fillText(i, t + h + c / 2, S)
                    }
                }
                n.restore()
            };
            for (const e of l)
                e.purpleair && t(e);
            for (const e of l)
                e.purpleair || t(e)
        }
        const c = parseKey(this.selectedId),
            d = c && "mobile" === c.type && c.id ? c.id : null,
            u = (t, e, i) => {
                t && null != t.id && String(t.id);
                const s = !this.playbackMode,
                    a = this._collectTrailData(t, i);
                if (!a)
                    return !1;
                const {pts: o, cols: l, times: r, trail: h, isGhost: c} = a,
                    u = d && t.id === d;
                let _ = 1 / 0,
                    m = -1 / 0;
                for (let t = 1; t < o.length; t++) {
                    if (!o[t - 1] || !o[t])
                        continue;
                    const e = h[t],
                        i = !(!e || 1 !== e.m && "1" !== e.m && !0 !== e.m);
                    if (!(this._pbDebugPath || i))
                        continue;
                    const s = r[t];
                    null != s && isFinite(s) && (s < _ && (_ = s), s > m && (m = s))
                }
                if (!(m > _))
                    for (const t of r)
                        null != t && isFinite(t) && (t < _ && (_ = t), t > m && (m = t));
                const p = (u ? 1 : .85) * e,
                    f = u ? 4.2 : 3.4,
                    g = 12e5,
                    M = this.getPlaybackTimeMs(),
                    y = null != M && isFinite(M),
                    b = this.getPlaybackBounds(),
                    x = null != b.maxMs && isFinite(b.maxMs) ? b.maxMs : null,
                    S = y ? Number(M) : isFinite(m) ? m : null != x ? x : this._dataNowMs();
                n.lineWidth = f,
                n.setLineDash([2, 10]),
                n.lineCap = "round",
                n.lineJoin = "round";
                let w = null,
                    v = null,
                    F = [];
                const P = () => {
                        if (F.length < 2)
                            F = [];
                        else {
                            n.globalAlpha = v,
                            n.strokeStyle = w,
                            n.beginPath();
                            for (let t = 0; t < F.length; t += 2)
                                n.moveTo(F[t].x, F[t].y),
                                n.lineTo(F[t + 1].x, F[t + 1].y);
                            n.stroke(),
                            F = []
                        }
                    },
                    T = 96e4;
                for (let t = 1; t < o.length; t++) {
                    if (!o[t - 1] || !o[t]) {
                        P();
                        continue
                    }
                    const e = h[t],
                        i = !(!e || 1 !== e.m && "1" !== e.m && !0 !== e.m),
                        a = l[t] || l[t - 1] || "#ffffff";
                    let n = a,
                        d = 1;
                    i ? c && s && (n = desatHex(dimHex(a, .65), .25), d = .5) : this._pbDebugPath ? n = dimHex(a, .25) : (n = desatHex(dimHex(a, .35), .3), d = .5);
                    const u = r[t];
                    if (null == u || !isFinite(u) || !isFinite(S)) {
                        P();
                        continue
                    }
                    const _ = Math.max(0, Number(S) - Number(u));
                    if (_ >= g) {
                        P();
                        continue
                    }
                    let m = 1;
                    if (_ > T) {
                        const t = (_ - T) / 24e4;
                        if (m = (1 - t) * (1 - t), m <= .01) {
                            P();
                            continue
                        }
                    }
                    const f = p * m * d;
                    (n !== w || Math.abs(f - (v || 0)) > .01) && (P(), w = n, v = f),
                    F.push(o[t - 1]),
                    F.push(o[t])
                }
                return P(), n.setLineDash([]), n.globalAlpha = 1, !0
            },
            _ = t => {
                const e = t && null != t.id ? String(t.id) : "",
                    i = Array.isArray(t?.trail) ? t.trail : [],
                    s = e && this._persistedTrailById.get(e)?.trail || [],
                    a = s.length >= 2 ? s : i;
                if (!Array.isArray(a) || a.length < 1)
                    return Number.NEGATIVE_INFINITY;
                const n = a[a.length - 1];
                if (n && void 0 !== n._tMs) {
                    const t = n._tMs;
                    return null != t && isFinite(t) ? Number(t) : Number.NEGATIVE_INFINITY
                }
                const o = n && "string" == typeof n.t ? n.t : null,
                    l = o ? parseUtcMs(o) : null;
                try {
                    n && (n._tMs = l)
                } catch {}
                return null != l && isFinite(l) ? Number(l) : Number.NEGATIVE_INFINITY
            },
            m = d ? .35 : 1,
            p = o.filter(t => !(d && t.id === d)).slice().sort((t, e) => _(t) - _(e));
        for (const t of p)
            u(t, m, h);
        if (d) {
            const t = o.find(t => t.id === d);
            t && u(t, 1, h)
        }
    }
    drawOverlay(t, e={})
    {
        const i = this.octx;
        if (!i)
            return;
        this._selectedPollutantKey = null;
        const s = this._cssW || 1,
            a = this._cssH || 1,
            n = this._dpr || window.devicePixelRatio || 1;
        i.setTransform(n, 0, 0, n, 0, 0);
        const o = this.traceMode && !this.playbackMode;
        if (o) {
            this._ensureTracePoints(t),
            this._ensureOverlayStatic(t);
            const e = this.overlayCanvas.width,
                s = this.overlayCanvas.height;
            i.save(),
            i.setTransform(1, 0, 0, 1, 0, 0),
            i.clearRect(0, 0, e, s),
            this._overlayStaticCanvas && i.drawImage(this._overlayStaticCanvas, 0, 0),
            i.restore()
        } else
            i.clearRect(0, 0, s, a);
        if (!t)
            return;
        const l = Array.isArray(t.mobile) ? t.mobile : [],
            r = Array.isArray(t.fixed) ? t.fixed : [];
        this._emojiCanvasCache || (this._emojiCanvasCache = new Map);
        const h = (t, e) => {
            const i = `${t}|${e}`;
            let s = this._emojiCanvasCache.get(i);
            if (s)
                return s;
            const a = 2 * e;
            s = document.createElement("canvas"),
            s.width = a,
            s.height = a;
            const n = s.getContext("2d");
            return n.font = `${a}px Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif`, n.textAlign = "center", n.textBaseline = "middle", n.fillText(t, a / 2, a / 2), this._emojiCanvasCache.set(i, s), s
        };
        this._textWidthCache || (this._textWidthCache = new Map);
        const c = (t, e) => {
                const s = `${e}|${t}`;
                let a = this._textWidthCache.get(s);
                return void 0 !== a || (i.font = e, a = i.measureText(t).width, a > 0 || (a = 7 * t.length), this._textWidthCache.set(s, a)), a
            },
            d = new Map,
            u = (t, e, i) => {
                const s = `${t}|${e}|${i}`;
                let a = d.get(s);
                return void 0 !== a || (a = i > 0 ? desatHex(dimHex(t, e), i) : dimHex(t, e), d.set(s, a)), a
            };
        this._fixedInterpCache || (this._fixedInterpCache = {
            timeKey: null,
            map: new Map
        });
        const _ = this.playbackMode ? this.getPlaybackTimeMs() : null,
            m = this.playbackMode ? this.getPlaybackBounds() : null,
            p = parseKey(this.selectedId),
            f = p && "mobile" === p.type && p.id,
            g = f ? p.id : null,
            M = _,
            y = `${this.center.lat.toFixed(6)}|${this.center.lon.toFixed(6)}|${this.zoom.toFixed(3)}|${s}|${a}|${this.selectedId || ""}`,
            b = this._trailCacheViewKey !== y,
            x = null != M && null != this._trailCacheTimeMs ? M - this._trailCacheTimeMs : 0,
            S = Math.abs(x) > 2e3,
            w = latLonToWorld(this.center.lat, this.center.lon, this.zoom),
            v = (t, e) => ({
                x: t - w.x + s / 2,
                y: e - w.y + a / 2
            }),
            F = g;
        this.playbackMode;
        if (!o) {
            const t = b || S,
                e = !1,
                o = Math.floor(s * n),
                r = Math.floor(a * n);
            if (this._trailCacheCanvas ? this._trailCacheCanvas.width === o && this._trailCacheCanvas.height === r || (this._trailCacheCanvas.width = o, this._trailCacheCanvas.height = r) : (this._trailCacheCanvas = document.createElement("canvas"), this._trailCacheCanvas.width = o, this._trailCacheCanvas.height = r), t || e) {
                const e = this._trailCacheCanvas.getContext("2d");
                if (e) {
                    e.setTransform(n, 0, 0, n, 0, 0),
                    t && e.clearRect(0, 0, s, a);
                    const i = t => {
                            const e = t && null != t.id ? String(t.id) : "",
                                i = Array.isArray(t?.trail) ? t.trail : [],
                                s = e && this._persistedTrailById.get(e)?.trail || [],
                                a = s.length >= 2 ? s : i;
                            if (!Array.isArray(a) || a.length < 1)
                                return Number.NEGATIVE_INFINITY;
                            const n = a[a.length - 1];
                            if (n && void 0 !== n._tMs) {
                                const t = n._tMs;
                                return null != t && isFinite(t) ? Number(t) : Number.NEGATIVE_INFINITY
                            }
                            const o = n && "string" == typeof n.t ? n.t : null,
                                l = o ? parseUtcMs(o) : null;
                            try {
                                n && (n._tMs = l)
                            } catch {}
                            return null != l && isFinite(l) ? Number(l) : Number.NEGATIVE_INFINITY
                        },
                        o = (t, i, s, a=null) => {
                            t && null != t.id && String(t.id);
                            const n = this._collectTrailData(t, s);
                            if (!n)
                                return !1;
                            const {pts: o, cols: l, times: r, trail: h, isGhost: c} = n,
                                d = F && t.id === F,
                                p = null != a && isFinite(a);
                            let f = 1 / 0,
                                g = -1 / 0;
                            for (let t = 1; t < o.length; t++) {
                                if (!o[t - 1] || !o[t])
                                    continue;
                                const e = h[t],
                                    i = !(!e || 1 !== e.m && "1" !== e.m && !0 !== e.m);
                                if (!(this._pbDebugPath || i))
                                    continue;
                                const s = r[t];
                                null != s && isFinite(s) && (s < f && (f = s), s > g && (g = s))
                            }
                            if (!(g > f))
                                for (const t of r)
                                    null != t && isFinite(t) && (t < f && (f = t), t > g && (g = t));
                            const M = (d ? 1 : .85) * i,
                                y = d ? 4.2 : 3.4,
                                b = 27e5,
                                x = _,
                                S = null != x && isFinite(x),
                                w = m && null != m.maxMs && isFinite(m.maxMs) ? m.maxMs : null,
                                v = S ? Number(x) : isFinite(g) ? g : null != w ? w : this._dataNowMs();
                            let P = null,
                                T = null,
                                I = [];
                            e.lineWidth = y,
                            e.setLineDash([2, 10]),
                            e.lineCap = "round",
                            e.lineJoin = "round";
                            const A = () => {
                                    if (I.length < 2)
                                        I = [];
                                    else {
                                        e.globalAlpha = T,
                                        e.strokeStyle = P,
                                        e.beginPath();
                                        for (let t = 0; t < I.length - 1; t++)
                                            e.moveTo(I[t].x, I[t].y),
                                            e.lineTo(I[t + 1].x, I[t + 1].y);
                                        e.stroke(),
                                        I = []
                                    }
                                },
                                C = 216e4,
                                L = !this.playbackMode;
                            for (let t = 1; t < o.length; t++) {
                                const e = o[t - 1],
                                    i = o[t];
                                if (!e || !i) {
                                    A();
                                    continue
                                }
                                const s = h[t],
                                    n = !(!s || 1 !== s.m && "1" !== s.m && !0 !== s.m),
                                    d = l[t] || l[t - 1] || "#ffffff";
                                let _ = d,
                                    m = 1;
                                n ? c && L && (_ = u(d, .65, .25)) : this._pbDebugPath ? _ = u(d, .25, 0) : (_ = u(d, .35, .3), m = .5);
                                const f = r[t];
                                if (null == f || !isFinite(f) || !isFinite(v)) {
                                    A();
                                    continue
                                }
                                if (p && f <= a)
                                    continue;
                                const g = v - f;
                                if (g >= b) {
                                    A();
                                    continue
                                }
                                let y = 1;
                                if (g > C) {
                                    const t = (g - C) / 54e4;
                                    if (y = (1 - t) * (1 - t), y <= .01) {
                                        A();
                                        continue
                                    }
                                }
                                const x = M * y * m;
                                (_ !== P || Math.abs(x - T) > .01) && (A(), P = _, T = x, I = []),
                                I.push(e),
                                I.push(i)
                            }
                            return A(), e.setLineDash([]), e.globalAlpha = 1, !0
                        },
                        r = F ? .35 : 1,
                        h = l.filter(t => !(F && t.id === F)).slice().sort((t, e) => i(t) - i(e)),
                        c = null;
                    for (const t of h)
                        o(t, r, v, c);
                    if (F) {
                        const t = l.find(t => t.id === F);
                        t && o(t, 1, v, c)
                    }
                }
                this._trailCacheViewKey = y,
                this._trailCacheTimeMs = M,
                this._lastTrailRedrawPerf = performance.now()
            }
            this._trailCacheCanvas && (i.save(), i.setTransform(1, 0, 0, 1, 0, 0), i.drawImage(this._trailCacheCanvas, 0, 0), i.restore())
        }
        if (this._pbDebugPath && this._pbDebugRawGps && this.playbackMode) {
            const t = g;
            if (t) {
                const e = this._rawGpsById.get(String(t));
                if (e && e.length >= 2) {
                    const t = worldSizeForZoom(this.zoom),
                        s = _;
                    i.save(),
                    i.strokeStyle = "#ff8800",
                    i.lineWidth = 2,
                    i.globalAlpha = .6,
                    i.setLineDash([4, 6]),
                    i.lineCap = "round",
                    i.beginPath();
                    let a = !1;
                    for (let n = 0; n < e.length; n++) {
                        const o = e[n],
                            l = Number(o.lat),
                            r = Number(o.lon);
                        if (!isFinite(l) || !isFinite(r))
                            continue;
                        const h = o && "string" == typeof o.t ? parseUtcMs(o.t) : null;
                        if (null != s && null != h && h > s)
                            break;
                        const c = latLonToNorm(l, r),
                            d = v(c.u * t, c.v * t);
                        a ? i.lineTo(d.x, d.y) : (i.moveTo(d.x, d.y), a = !0)
                    }
                    i.stroke(),
                    i.fillStyle = "#ff8800",
                    i.globalAlpha = .8;
                    for (let a = 0; a < e.length; a++) {
                        const n = e[a],
                            o = Number(n.lat),
                            l = Number(n.lon);
                        if (!isFinite(o) || !isFinite(l))
                            continue;
                        const r = n && "string" == typeof n.t ? parseUtcMs(n.t) : null;
                        if (null != s && null != r && r > s)
                            break;
                        const h = latLonToNorm(o, l),
                            c = v(h.u * t, h.v * t);
                        i.beginPath(),
                        i.arc(c.x, c.y, 3, 0, 2 * Math.PI),
                        i.fill()
                    }
                    i.restore()
                }
            }
        }
        if (this._pbDebugPath && this._pbDebugRoadLines && this.playbackMode) {
            this._fetchRoadEdgesForViewport();
            const t = this._roadGraphEdges;
            if (t && t.length > 0) {
                const e = worldSizeForZoom(this.zoom);
                i.save(),
                i.strokeStyle = "#444488",
                i.lineWidth = 1,
                i.globalAlpha = .4,
                i.setLineDash([]);
                for (const n of t) {
                    const t = Number(n.lat1),
                        o = Number(n.lon1),
                        l = Number(n.lat2),
                        r = Number(n.lon2);
                    if (!(isFinite(t) && isFinite(o) && isFinite(l) && isFinite(r)))
                        continue;
                    const h = latLonToNorm(t, o),
                        c = latLonToNorm(l, r),
                        d = v(h.u * e, h.v * e),
                        u = v(c.u * e, c.v * e);
                    d.x < -50 && u.x < -50 || d.x > s + 50 && u.x > s + 50 || (d.y < -50 && u.y < -50 || d.y > a + 50 && u.y > a + 50 || (i.beginPath(), i.moveTo(d.x, d.y), i.lineTo(u.x, u.y), i.stroke()))
                }
                i.restore()
            }
        }
        if (this._pbDebugPath && this._pbDebugRoadLines && this.playbackMode) {
            this._fetchTramLineEdgesForViewport();
            const t = this._tramLineEdges,
                e = this._tramLineHasElevation;
            if (t && t.length > 0) {
                const n = worldSizeForZoom(this.zoom),
                    o = 1280,
                    l = 1500 - o,
                    r = t => {
                        if (!e || null == t)
                            return "#44aa66";
                        const i = Math.max(0, Math.min(1, (t - o) / l));
                        return `rgb(68,${Math.round(170 + 30 * i)},${Math.round(102 + 118 * i)})`
                    };
                i.save(),
                i.lineWidth = 2,
                i.globalAlpha = .7,
                i.setLineDash([]);
                for (const e of t) {
                    const t = Number(e.lat1),
                        o = Number(e.lon1),
                        l = Number(e.lat2),
                        h = Number(e.lon2);
                    if (!(isFinite(t) && isFinite(o) && isFinite(l) && isFinite(h)))
                        continue;
                    const c = latLonToNorm(t, o),
                        d = latLonToNorm(l, h),
                        u = v(c.u * n, c.v * n),
                        _ = v(d.u * n, d.v * n);
                    if (u.x < -50 && _.x < -50 || u.x > s + 50 && _.x > s + 50)
                        continue;
                    if (u.y < -50 && _.y < -50 || u.y > a + 50 && _.y > a + 50)
                        continue;
                    const m = null != e.elev1 && null != e.elev2 ? (e.elev1 + e.elev2) / 2 : null;
                    i.strokeStyle = r(m),
                    i.beginPath(),
                    i.moveTo(u.x, u.y),
                    i.lineTo(_.x, _.y),
                    i.stroke()
                }
                i.restore()
            }
        }
        if (this._pbDebugPath && this.playbackMode) {
            const e = g;
            if (e) {
                const s = worldSizeForZoom(this.zoom),
                    a = String(e);
                if ((Array.isArray(t.mobile) ? t.mobile : []).find(t => t.id === e)) {
                    const t = this._playbackPtsById.get(a);
                    if (t && t.length >= 2) {
                        const e = this._getPhysicsState(a),
                            {cumDist: n, totalDist: o, curvature: l} = this._getPathDistances(a, t),
                            r = null != e.d && isFinite(e.d) ? e.d : 0,
                            h = this._playbackSpeed || 1,
                            c = (t[0].tMs, t[t.length - 1].tMs),
                            d = this._currentPlaybackTimeMs || c,
                            u = this._getTargetDistance(t, n, o, d),
                            _ = n.findIndex(t => t >= r),
                            m = n.findIndex(t => t >= u),
                            p = Math.max(0, (-1 === _ ? 0 : _) - 1),
                            f = -1 === m ? t.length - 1 : Math.min(t.length - 1, m + 1),
                            g = [],
                            M = 8;
                        for (let e = p; e < f; e++) {
                            const i = t[Math.max(0, e - 1)],
                                s = t[e],
                                a = t[Math.min(t.length - 1, e + 1)],
                                o = t[Math.min(t.length - 1, e + 2)],
                                l = (1 - .5) / 2;
                            for (let t = 0; t <= M; t++) {
                                const h = t / M,
                                    c = h * h,
                                    d = c * h,
                                    _ = -l * d + 2 * l * c - l * h,
                                    m = (2 - l) * d + (l - 3) * c + 1,
                                    p = (l - 2) * d + (3 - 2 * l) * c + l * h,
                                    f = l * d - l * c,
                                    y = _ * i.lat + m * s.lat + p * a.lat + f * o.lat,
                                    b = _ * i.lon + m * s.lon + p * a.lon + f * o.lon,
                                    x = n[e] + (n[Math.min(e + 1, n.length - 1)] - n[e]) * h;
                                x >= r && x <= u && g.push({
                                    lat: y,
                                    lon: b,
                                    d: x
                                })
                            }
                        }
                        const y = [];
                        for (let t = 0; t < g.length; t++)
                            (0 === t || Math.abs(g[t].lat - y[y.length - 1].lat) > 1e-7 || Math.abs(g[t].lon - y[y.length - 1].lon) > 1e-7) && y.push(g[t]);
                        const b = Math.sqrt(Math.max(1, h)),
                            x = 30 + 20 * b,
                            S = 6 / b,
                            w = 1 / b,
                            F = 111320,
                            P = 111320 * Math.cos((e.lat || 40.7) * Math.PI / 180),
                            T = t => {
                                if (y.length < 2)
                                    return y[0] || {
                                            lat: e.lat,
                                            lon: e.lon
                                        };
                                for (let e = 0; e < y.length - 1; e++)
                                    if (y[e + 1].d >= t) {
                                        const i = y[e + 1].d - y[e].d > .1 ? (t - y[e].d) / (y[e + 1].d - y[e].d) : 0;
                                        return {
                                            lat: y[e].lat + i * (y[e + 1].lat - y[e].lat),
                                            lon: y[e].lon + i * (y[e + 1].lon - y[e].lon)
                                        }
                                    }
                                return y[y.length - 1]
                            };
                        let I = e.lat || 0,
                            A = e.lon || 0,
                            C = e.heading || 0,
                            L = r,
                            k = e.v || 15,
                            R = 0;
                        const N = 15,
                            E = [{
                                lat: I,
                                lon: A
                            }],
                            D = 30,
                            B = .1;
                        for (let t = 0; t < D && L < u; t++) {
                            const t = Math.min(x, u - L);
                            if (t <= 0)
                                break;
                            const e = T(Math.min(L + t, u)),
                                i = T(L),
                                s = (I - i.lat) * F,
                                a = (A - i.lon) * P,
                                o = Math.sqrt(s * s + a * a),
                                r = Math.min(k * h * 2, u - L);
                            let c = 0;
                            for (let t = 0; t < l.length; t++) {
                                const e = n[t];
                                e >= L && e <= L + r && l[t] > c && (c = l[t])
                            }
                            const d = Math.min(1, o / 50) * w,
                                _ = e.lat * (1 - d) + i.lat * d - I,
                                m = e.lon * (1 - d) + i.lon * d - A;
                            let p = Math.atan2(_, m) - C;
                            for (; p > Math.PI;)
                                p -= 2 * Math.PI;
                            for (; p < -Math.PI;)
                                p += 2 * Math.PI;
                            const f = Math.abs(p),
                                g = 3e-4 / (3e-4 + c),
                                M = Math.max(.1, 1 - 1.8 * f),
                                y = Math.max(.3, 1 - o / (50 * b)),
                                v = g < .7 || M < .7 || y < .7,
                                D = u - L;
                            let $;
                            if (D < 10)
                                $ = Math.max(0, .5 * D);
                            else if (v) {
                                $ = N * g * M * y;
                                R += N * B * h - $ * B * h
                            } else {
                                const t = Math.min(R, .5 * N * B * h);
                                R -= t;
                                $ = N * (1 + t / (N * B * h))
                            }
                            k += (k > $ ? .6 : .4) * ($ - k),
                            k = Math.max(0, Math.min(40, k));
                            const z = Math.max(.5, 15 / Math.max(5, k));
                            C += (1 - Math.exp(-S * z * B)) * p;
                            const W = k * B * h;
                            I += W * Math.sin(C) / F,
                            A += W * Math.cos(C) / P,
                            L += W,
                            E.push({
                                lat: I,
                                lon: A
                            })
                        }
                        if (y.length >= 2) {
                            i.save(),
                            i.strokeStyle = "#00ffff",
                            i.lineWidth = 3,
                            i.globalAlpha = .7,
                            i.setLineDash([]),
                            i.beginPath();
                            for (let t = 0; t < y.length; t++) {
                                const e = y[t],
                                    a = latLonToNorm(e.lat, e.lon),
                                    n = v(a.u * s, a.v * s);
                                0 === t ? i.moveTo(n.x, n.y) : i.lineTo(n.x, n.y)
                            }
                            i.stroke(),
                            i.fillStyle = "#00ffff";
                            let t = -1 / 0;
                            const e = 50;
                            for (let a = 0; a < y.length; a++) {
                                const n = y[a];
                                if (n.d - t >= e) {
                                    const e = latLonToNorm(n.lat, n.lon),
                                        a = v(e.u * s, e.v * s);
                                    i.beginPath(),
                                    i.arc(a.x, a.y, 4, 0, 2 * Math.PI),
                                    i.globalAlpha = .9 - (n.d - r) / (u - r + 1) * .6,
                                    i.fill(),
                                    t = n.d
                                }
                            }
                            i.restore()
                        }
                        if (E.length >= 2) {
                            i.save(),
                            i.strokeStyle = "#ff00ff",
                            i.lineWidth = 2,
                            i.globalAlpha = .5,
                            i.setLineDash([5, 5]),
                            i.beginPath();
                            for (let t = 0; t < E.length; t++) {
                                const e = E[t],
                                    a = latLonToNorm(e.lat, e.lon),
                                    n = v(a.u * s, a.v * s);
                                0 === t ? i.moveTo(n.x, n.y) : i.lineTo(n.x, n.y)
                            }
                            i.stroke(),
                            i.restore()
                        }
                    }
                }
            }
        }
        const P = _;
        if (!o) {
            {
                const t = 3e-4,
                    e = .002;
                this._fixedGeoOffsets = new Map;
                const i = [];
                for (const t of r) {
                    if (t.purpleair)
                        continue;
                    const e = Number(t.lat),
                        s = Number(t.lon);
                    isFinite(e) && isFinite(s) && (t._key || (t._key = keyFor("fixed", t.id)), i.push({
                        key: t._key,
                        lat: e,
                        lon: s,
                        dlat: 0,
                        dlon: 0
                    }))
                }
                for (let s = 0; s < i.length; s++)
                    for (let a = s + 1; a < i.length; a++) {
                        const n = i[s],
                            o = i[a];
                        if (Math.abs(n.lat - o.lat) + Math.abs(n.lon - o.lon) < e) {
                            const e = o.lat - n.lat,
                                i = o.lon - n.lon,
                                s = Math.abs(e) + Math.abs(i) > 1e-7 ? Math.atan2(i, e) : Math.PI / 4;
                            n.dlat -= Math.cos(s) * t,
                            n.dlon -= Math.sin(s) * t,
                            o.dlat += Math.cos(s) * t,
                            o.dlon += Math.sin(s) * t
                        }
                    }
                for (const t of i)
                    (t.dlat || t.dlon) && this._fixedGeoOffsets.set(t.key, {
                        dlat: t.dlat,
                        dlon: t.dlon
                    })
            }
            const t = t => {
                let e = Number(t.lat),
                    n = Number(t.lon);
                if (!isFinite(e) || !isFinite(n))
                    return;
                t._key || (t._key = keyFor("fixed", t.id));
                const o = this._fixedGeoOffsets && this._fixedGeoOffsets.get(t._key);
                o && (e += o.dlat, n += o.dlon);
                const l = latLonToWorld(e, n, this.zoom),
                    r = v(l.x, l.y);
                if (r.x < -50 || r.y < -50 || r.x > s + 50 || r.y > a + 50)
                    return;
                const d = t._key,
                    u = this.selectedId === d,
                    _ = t.purpleair ? "" : t.emoji || "📍",
                    m = t.name && t.name.length && String(t.name) !== String(t.id) ? t.name : t.id,
                    p = safeHex(t.ci);
                let f;
                if (null != P && isFinite(P) ? `${t.id}|${Math.round(P / 1e3)}` : null) {
                    const e = Math.round(P / 1e3);
                    this._fixedInterpCache.timeKey !== e && (this._fixedInterpCache.timeKey = e, this._fixedInterpCache.map.clear()),
                    f = this._fixedInterpCache.map.get(t.id),
                    f || (f = primaryReadingForFixedAtTime(t, P), this._fixedInterpCache.map.set(t.id, f))
                } else
                    f = primaryReadingForFixedAtTime(t, P);
                u && f && f.key && (this._selectedPollutantKey = f.key),
                i.save();
                const g = !!t.purpleair;
                if (g) {
                    let e = 1;
                    if (!u && t.last_seen) {
                        const s = 27e5,
                            a = .2,
                            n = this._dataNowMs() - 1e3 * t.last_seen;
                        if (n >= s)
                            return void i.restore();
                        const o = s * (1 - a);
                        if (n > o) {
                            const t = (n - o) / (s - o);
                            e = (1 - t) * (1 - t)
                        }
                    }
                    const s = u ? 8 : 6,
                        a = safeHex(f && f.color || p);
                    if (u && (i.beginPath(), i.fillStyle = "rgba(56, 140, 220, 0.38)", i.arc(r.x, r.y, s + 4, 0, 2 * Math.PI), i.fill()), i.beginPath(), u)
                        i.fillStyle = a;
                    else {
                        const t = darkenHex(a, .85);
                        i.fillStyle = hexToRgba(t, .45 * e)
                    }
                    i.arc(r.x, r.y, s, 0, 2 * Math.PI),
                    i.fill(),
                    i.strokeStyle = u ? "#5bb8f5" : darkenHex(a, .7),
                    i.globalAlpha = (u ? 1 : .5) * e,
                    i.lineWidth = u ? 1.8 : 1.2,
                    i.stroke()
                } else {
                    const t = _isLite ? 10 : 15,
                        e = _isLite ? 8 : 12,
                        s = _isLite ? 10 : 15;
                    u && (i.beginPath(), i.fillStyle = "rgba(56, 140, 220, 0.38)", i.arc(r.x, r.y, t, 0, 2 * Math.PI), i.fill()),
                    i.beginPath(),
                    i.fillStyle = "rgba(16, 20, 28, 0.68)",
                    i.arc(r.x, r.y, e, 0, 2 * Math.PI),
                    i.fill(),
                    i.strokeStyle = u ? "#5bb8f5" : safeHex(f && f.color || p),
                    i.lineWidth = u ? 2.4 : 2,
                    i.stroke();
                    const a = h(_, s);
                    i.drawImage(a, r.x - s / 2, r.y - s / 2, s, s)
                }
                if ((g ? this.showPublicLabels : this.showFixedLabels) || u || "Home" === String(t.id)) {
                    const t = "600 12px system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
                        e = m,
                        s = f.key ? String(f.key) : "",
                        a = formatTagValue(f.value),
                        n = c(e, t),
                        o = c(s ? `${s} ` : "", t),
                        l = c(a, t),
                        h = 8,
                        d = Math.max(n, o + l) + 2 * h,
                        u = s || a ? 30 : 18,
                        _ = r.x - d / 2,
                        g = r.y + 18;
                    i.fillStyle = "rgba(16, 20, 28, 0.82)",
                    i.strokeStyle = safeHex(f && f.color || p),
                    i.lineWidth = 1.8,
                    roundRect(i, _, g, d, u, 9),
                    i.fill(),
                    i.stroke(),
                    i.font = t,
                    i.fillStyle = "#e8eef7",
                    i.textAlign = "center",
                    i.textBaseline = "middle";
                    const M = 4,
                        y = (u - 2 * M) / (s || a ? 2 : 1),
                        b = g + M + .5 * y,
                        x = g + M + 1.5 * y;
                    if (i.fillText(e, r.x, b), s || a) {
                        const t = r.x - (o + l) / 2;
                        i.fillStyle = "rgba(232,238,247,0.70)",
                        i.fillText(s ? `${s} ` : "", t + o / 2, x),
                        i.fillStyle = f.color || "#ffffff",
                        i.fillText(a, t + o + l / 2, x)
                    }
                }
                i.restore()
            };
            if (this.showPublic)
                for (const e of r)
                    e.purpleair && t(e);
            if (this.showFixed)
                for (const e of r)
                    e.purpleair || t(e)
        }
        const T = e && "number" == typeof e.nowMs && isFinite(e.nowMs) ? e.nowMs : performance.now();
        (this.traceMode || this.playbackMode) && (i.font = "22px Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif", i.textAlign = "center", i.textBaseline = "middle");
        const I = (() => this._pbDrag && null != this._pbDrag.id ? String(this._pbDrag.id) : this._pbInertia2d && null != this._pbInertia2d.id ? String(this._pbInertia2d.id) : null != F ? String(F) : null)(),
            A = t => {
                const e = this._mobilePoseForRender(t, T);
                let n = e.lat,
                    o = e.lon,
                    l = e.angle,
                    r = e.flipX,
                    d = e.speedMps;
                const u = "number" == typeof e.opacity && isFinite(e.opacity) ? e.opacity : 1;
                t._key || (t._key = keyFor("mobile", t.id));
                const _ = t._key,
                    m = this.selectedId === _,
                    p = !!this._pbDebugPath,
                    f = this.playbackMode && this._playbackPtsById.has(String(t.id));
                if (t.ghosted && !p && !m && !f)
                    return;
                const g = !!t.parked,
                    M = !p && !m && g;
                if (!isFinite(n) || !isFinite(o))
                    return;
                const y = latLonToWorld(n, o, this.zoom),
                    b = v(y.x, y.y);
                if (b.x < -50 || b.y < -50 || b.x > s + 50 || b.y > a + 50)
                    return;
                const x = !!e.held,
                    S = t && null != t.id ? String(t.id) : "",
                    w = t.emoji || "🚌",
                    F = t.name && t.name.length && String(t.name) !== String(t.id) ? t.name : t.id,
                    P = safeHex(t.ci),
                    I = g ? dimHex(P, .65) : P;
                let A = primaryReadingForSensor(t);
                if (this.playbackMode && e && e.reading) {
                    const t = e.reading;
                    if (this._historicalMode)
                        A = t;
                    else {
                        if (!!this._playbackLiveFollow || this.isPlaybackAtEnd(200)) {
                            const e = A && null != A.aqi ? Number(A.aqi) : valueToAqi(A?.key, A?.value),
                                i = t && null != t.aqi ? Number(t.aqi) : valueToAqi(t?.key, t?.value),
                                s = null != e && isFinite(Number(e)) ? Number(e) : -1,
                                a = null != i && isFinite(Number(i)) ? Number(i) : -1;
                            A && A.key ? t && t.key && a > s && (A = t) : A = t
                        } else
                            A = t
                    }
                }
                const C = g ? dimHex(A.color || "#ffffff", .65) : A.color || "#ffffff",
                    L = M ? desatHex(I, .25) : I,
                    k = M ? desatHex(C, .25) : C;
                m && A && A.key && (this._selectedPollutantKey = A.key),
                i.save();
                const R = clamp(u, 0, 1);
                R < 1 && (i.globalAlpha = i.globalAlpha * R),
                M && (i.globalAlpha = .5 * i.globalAlpha);
                const N = this.playbackMode && x ? 1.16 : 1,
                    E = this.playbackMode && x ? -8 : 0,
                    D = b.x,
                    B = b.y + E,
                    $ = _isLite ? 11 : 16,
                    z = _isLite ? 9 : 13,
                    W = _isLite ? 11 : 16;
                i.beginPath(),
                this.selectedId === _ && (i.fillStyle = "rgba(56, 140, 220, 0.38)", i.arc(D, B, $ * N, 0, 2 * Math.PI), i.fill(), i.beginPath()),
                i.fillStyle = "rgba(16, 20, 28, 0.68)",
                i.arc(D, B, z * N, 0, 2 * Math.PI),
                i.fill(),
                i.strokeStyle = this.selectedId === _ ? "#5bb8f5" : safeHex(k),
                i.lineWidth = this.selectedId === _ ? 2.8 : 2.2,
                i.stroke();
                const O = h(w, W),
                    V = W / 2;
                if (i.save(), this.traceMode || this.playbackMode ? (i.translate(D, B), 1 !== N && i.scale(N, N), r && i.scale(-1, 1), i.rotate(l), i.drawImage(O, -V, -V, W, W)) : i.drawImage(O, D - V, B - V, W, W), i.restore(), (this.traceMode || this.playbackMode) && this.showMobileLabels) {
                    const e = t && null != t.id ? String(t.id).toUpperCase() : "";
                    if ("🚍" === w || e.startsWith("BUS")) {
                        const t = `${Math.max(0, Math.round(2.236936 * (isFinite(d) ? d : 0)))} mph`;
                        i.save();
                        const e = "10px -apple-system, system-ui, sans-serif";
                        i.font = e;
                        const s = c(t, e) + 2 * 6,
                            a = 14,
                            n = D - s / 2,
                            o = B - 32;
                        i.fillStyle = "rgba(16, 20, 28, 0.72)",
                        i.strokeStyle = "rgba(232,238,247,0.22)",
                        i.lineWidth = 1,
                        roundRect(i, n, o, s, a, 7),
                        i.fill(),
                        i.stroke(),
                        i.fillStyle = "rgba(232,238,247,0.90)",
                        i.textAlign = "center",
                        i.textBaseline = "middle",
                        i.fillText(t, D, o + a / 2),
                        i.restore()
                    }
                }
                if (this.showMobileLabels || m) {
                    i.save(),
                    i.globalAlpha = 1;
                    const t = F || S || "?",
                        e = A.key ? String(A.key) : "",
                        s = formatTagValue(A.value),
                        a = "600 12px system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
                        n = c(t, a),
                        o = c(e ? `${e} ` : "", a),
                        l = c(s, a),
                        r = 8,
                        h = Math.max(n, o + l) + 2 * r,
                        d = e || s ? 30 : 18,
                        u = D - h / 2,
                        _ = B + 18;
                    i.fillStyle = "rgba(16, 20, 28, 0.82)",
                    i.strokeStyle = safeHex(k || L),
                    i.lineWidth = 1.8,
                    roundRect(i, u, _, h, d, 9),
                    i.fill(),
                    i.stroke(),
                    i.font = a,
                    i.fillStyle = "#e8eef7",
                    i.textAlign = "center",
                    i.textBaseline = "middle";
                    const m = 4,
                        p = (d - 2 * m) / (e || s ? 2 : 1),
                        f = _ + m + .5 * p,
                        g = _ + m + 1.5 * p;
                    if (i.fillText(t, D, f), e || s) {
                        const t = D - (o + l) / 2;
                        i.fillStyle = "rgba(232,238,247,0.70)",
                        i.fillText(e ? `${e} ` : "", t + o / 2, g),
                        i.fillStyle = k,
                        i.fillText(s, t + o + l / 2, g)
                    }
                    i.restore()
                }
                i.restore()
            };
        if (this.showMobile) {
            for (const t of l)
                I && t && null != t.id && String(t.id) === String(I) || A(t);
            if (I) {
                const t = l.find(t => t && null != t.id && String(t.id) === String(I)) || null;
                t && A(t)
            }
        }
    }
}
window.MapView = MapView;
