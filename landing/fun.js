/* funstuff.app — interactions */
(function () {
  "use strict";

  /* ── Persist scroll position across reloads ── */
  var _mainWin = document.querySelector(".main-window");
  if (_mainWin) {
    _mainWin.addEventListener("scroll", function () {
      try { sessionStorage.setItem("_scrollY", _mainWin.scrollTop); } catch (e) {}
    }, { passive: true });
  }

  /* ── Weekend snapshot logic for embedded map widget ── */
  var _widgetLoadTime = Date.now();
  var _widgetSnapshotParams = null;
  var _snapshotIdx = 0;
  var _dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  function _snapshotDate(idx) {
    var now = new Date();
    /* 5 AM–5 AM day boundaries */
    var adjusted = new Date(now.getTime() - 5 * 60 * 60 * 1000);
    var day = adjusted.getDay();
    var daysSinceLastFriday = (day === 6) ? 1 : 2;
    var daysBack = daysSinceLastFriday + idx;
    var target = new Date(now);
    target.setDate(target.getDate() - daysBack);
    return target;
  }

  function _formatDate(d) {
    return d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
  }

  function _snapshotParamStr(dateStr) {
    return "date=" + dateStr + "&start=10&duration=2&playhead=60&speed=20";
  }

  function _loadSnapshot(idx) {
    var iframe = document.getElementById("map-iframe");
    if (!iframe) return;
    var baseSrc = iframe.getAttribute("data-src") || "https://dustytrails.funstuff.app/";
    var target = _snapshotDate(idx);
    var dateStr = _formatDate(target);
    iframe.src = baseSrc + "?" + _snapshotParamStr(dateStr) + "&lite=1&fresh=1";
    _widgetSnapshotParams = { date: dateStr, start: 10, duration: 2, basePlayhead: 60, speed: 20 };
    _widgetLoadTime = Date.now();
    _snapshotIdx = idx;
    _updateIndicator(target);
  }

  function _cycleSnapshot(idx) {
    var iframe = document.getElementById("map-iframe");
    if (!iframe || !iframe.contentWindow) return;
    var target = _snapshotDate(idx);
    var dateStr = _formatDate(target);
    try { iframe.contentWindow.location.hash = _snapshotParamStr(dateStr); } catch(e) { _loadSnapshot(idx); return; }
    _widgetSnapshotParams = { date: dateStr, start: 10, duration: 2, basePlayhead: 60, speed: 20 };
    _widgetLoadTime = Date.now();
    _snapshotIdx = idx;
    _updateIndicator(target);
  }

  function _updateIndicator(target) {
    var indicator = document.getElementById("snapshot-indicator");
    if (indicator) {
      indicator.textContent = "\u25B6 " + _dayNames[target.getDay()] + " " +
        (target.getMonth() + 1) + "/" + target.getDate() + " 11AM";
      indicator.style.display = "block";
    }
  }

  (function setMapIframeSrc() {
    var now = new Date();
    /* Use 5 AM–5 AM day boundaries instead of midnight–midnight.
       Subtracting 5 hours means e.g. Saturday 3 AM still counts as Friday. */
    var adjusted = new Date(now.getTime() - 5 * 60 * 60 * 1000);
    var day = adjusted.getDay();
    if (day === 0 || day === 6) {
      // Always load the most recent Friday (idx 0); cycling disabled for now
      var idx = 0;
      // var key = "funstuff_weekday_idx";
      // var stored = sessionStorage.getItem(key);
      // var idx = stored !== null ? (parseInt(stored, 10) + 1) % 5 : 0;
      // sessionStorage.setItem(key, String(idx));
      _loadSnapshot(idx);
      var overlayLabel = document.getElementById("demo-overlay-label");
      if (overlayLabel) overlayLabel.textContent = "Recorded snapshot \u2014 click to open live app";
    } else {
      var iframe = document.getElementById("map-iframe");
      if (iframe) iframe.src = (iframe.getAttribute("data-src") || "https://dustytrails.funstuff.app/") + "?lite=1&fresh=1";
      var overlayLabel = document.getElementById("demo-overlay-label");
      if (overlayLabel) overlayLabel.textContent = "Live preview \u2014 click to open full app";
      var indicator = document.getElementById("snapshot-indicator");
      if (indicator) {
        indicator.textContent = "\u25CF Live";
        indicator.style.display = "block";
      }
    }
  })();

  var indicatorEl = document.getElementById("snapshot-indicator");
  if (indicatorEl) {
    indicatorEl.addEventListener("click", function (e) {
      e.stopPropagation();
      // Open the full app synced to current snapshot playhead
      if (_widgetSnapshotParams) {
        var elapsedMin = Math.floor((Date.now() - _widgetLoadTime) / 60000);
        var simElapsed = elapsedMin * _widgetSnapshotParams.speed;
        var syncedPlayhead = _widgetSnapshotParams.basePlayhead + simElapsed;
        var p = _widgetSnapshotParams;
        var url = "https://dustytrails.funstuff.app/" +
          "?date=" + p.date +
          "&start=" + p.start +
          "&duration=" + p.duration +
          "&playhead=" + syncedPlayhead +
          "&speed=" + p.speed +
          "&fresh=1";
        window.location.href = url;
      }
      // Cycling disabled for now — will be re-enabled with a separate UI element
      // var nextIdx = (_snapshotIdx + 1) % 5;
      // _cycleSnapshot(nextIdx);
      // sessionStorage.setItem("funstuff_weekday_idx", String(_snapshotIdx));
    });
  }

  /* ── Taskbar clock ── */
  var clockEl = document.getElementById("tray-clock");
  function tickClock() {
    var now = new Date();
    var h = now.getHours();
    var m = String(now.getMinutes()).padStart(2, "0");
    var ampm = h >= 12 ? "PM" : "AM";
    var h12 = h % 12 || 12;
    if (clockEl) clockEl.textContent = h12 + ":" + m + " " + ampm;
  }
  tickClock();
  setInterval(tickClock, 15000);

  /* ── Map overlay → always opens plain live app (no params) ── */
  var mapOverlay = document.querySelector(".demo-overlay:not(.tui-overlay)");
  if (mapOverlay) {
    mapOverlay.addEventListener("click", function () {
      window.location.href = "https://dustytrails.funstuff.app/";
    });
  }

  /* ── TUI overlay → click to enable interaction ── */
  var tuiOverlay = document.getElementById("tui-overlay");
  var tuiIframe = document.getElementById("tui-iframe");
  if (tuiOverlay && tuiIframe) {
    tuiOverlay.addEventListener("click", function () {
      tuiOverlay.style.display = "none";
      tuiIframe.classList.add("interactive");
    });
  }

  /* ── BSOD ── */
  var appWindow  = document.getElementById("app-window");
  var mainWindow = document.querySelector(".main-window");
  var tbMainBtn  = document.getElementById("tb-main");

  function showBSOD() {
    var bsod = document.createElement("div");
    bsod.style.cssText =
      "position:fixed;inset:0;background:#000080;color:#fff;" +
      "font-family:'VT323',monospace;display:flex;align-items:center;" +
      "justify-content:center;font-size:1.6rem;text-align:center;" +
      "z-index:10000;padding:40px;line-height:1.8;cursor:default;";
    bsod.innerHTML =
      "A fatal exception 0E has occurred at 0028:C0011E36<br><br>" +
      "* Click to return to funstuff.app<br>" +
      "* CTRL+ALT+DEL to pretend this didn't happen<br><br>" +
      "Press the any key to continue _";
    document.body.appendChild(bsod);
    function dismiss() {
      bsod.remove();
      restoreWindow();
      document.removeEventListener("keydown", dismiss);
      document.removeEventListener("click", dismiss);
    }
    setTimeout(function () {
      document.addEventListener("keydown", dismiss, { once: true });
      document.addEventListener("click", dismiss, { once: true });
    }, 300);
  }

  /* ── Window minimize / restore ── */
  function minimizeWindow() {
    if (!appWindow) return;
    appWindow.style.transition = "opacity 0.2s, transform 0.2s";
    appWindow.style.opacity = "0";
    appWindow.style.transform = "scaleY(0.97) translateY(-4px)";
    setTimeout(function () {
      appWindow.style.display = "none";
      appWindow.style.transition = "";
      appWindow.style.transform = "";
      if (_pageEl) _pageEl.style.pointerEvents = "none";
    }, 220);
    /* Mark as minimized in the z-stack */
    var mw = _deskWins["__main"];
    if (mw) {
      mw.minimized = true;
      if (mw.tbBtn) mw.tbBtn.classList.remove("active");
    }
    /* Deactivate all section buttons */
    Object.keys(_sectionBtns).forEach(function (key) {
      var btn = _sectionBtns[key];
      if (btn) btn.classList.remove("active");
    });
    if (_focusedWin === "__main") {
      _focusedWin = null;
      var bestId = null, bestZ = -1;
      Object.keys(_deskWins).forEach(function (wid) {
        var dw = _deskWins[wid];
        if (wid !== "__main" && !dw.minimized) {
          var z = parseInt(dw.el.style.zIndex, 10) || 0;
          if (z > bestZ) { bestZ = z; bestId = wid; }
        }
      });
      if (bestId) _bringToFront(bestId);
    }
  }

  function restoreWindow() {
    if (!appWindow) return;
    if (_pageEl) _pageEl.style.pointerEvents = "";
    appWindow.style.display = "";
    appWindow.style.opacity = "0";
    appWindow.style.transform = "scaleY(0.97) translateY(-4px)";
    appWindow.style.transition = "opacity 0.2s, transform 0.2s";
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        appWindow.style.opacity = "1";
        appWindow.style.transform = "";
      });
    });
    if (mainWindow) mainWindow.scrollTop = 0;
    window.scrollTo({ top: 0, behavior: "smooth" });
    var mw = _deskWins["__main"];
    if (mw) mw.minimized = false;
    _bringToFront("__main");
  }

  /* ── Maximize button ── */
  var maximizeBtn = document.querySelector('.tb-btn[aria-label="Maximize"]');
  var minimizeBtn = document.querySelector('.tb-btn[aria-label="Minimize"]');
  var page = document.querySelector(".page");

  if (minimizeBtn) minimizeBtn.addEventListener("click", minimizeWindow);

  if (maximizeBtn && page) {
    maximizeBtn.addEventListener("click", function () {
      page.classList.toggle("maximized");
    });
  }

  /* Taskbar main-window button: part of the same group */
  if (tbMainBtn) {
    tbMainBtn.addEventListener("click", function () {
      if (appWindow && appWindow.style.display === "none") {
        restoreWindow();
      }
      _bringToFront("__main");
      _setActiveSection(null);
      if (mainWindow) mainWindow.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  /* ── Taskbar DustyTrails / TUI / About buttons (scroll to section) ── */
  var tbDustyTrails = document.getElementById("tb-dustytrails");
  var tbTui         = document.getElementById("tb-tui");
  var tbAbout       = document.getElementById("tb-about");

  // Map observed section IDs to taskbar buttons + scroll targets
  var _sectionBtns = {
    dustytrails: tbDustyTrails,
    "tui-demo": tbTui,
    about: tbAbout
  };
  // Scroll targets: app buttons scroll to their embedded windows, About scrolls to section
  var _scrollTargets = {
    dustytrails: "demo-dustytrails",
    "tui-demo": "demo-tui",
    about: "about"
  };
  var _activeSection = null;

  function _setActiveSection(id) {
    _activeSection = id;
    // All buttons are one group — only one active at a time
    // null means funstuff.app (top of page) is active
    if (tbMainBtn) {
      if (id === null) {
        tbMainBtn.classList.add("active");
      } else {
        tbMainBtn.classList.remove("active");
      }
    }
    Object.keys(_sectionBtns).forEach(function (key) {
      var btn = _sectionBtns[key];
      if (btn) {
        if (key === id) {
          btn.classList.add("active");
        } else {
          btn.classList.remove("active");
        }
      }
    });
  }

  function scrollToSection(id) {
    var wasHidden = appWindow && appWindow.style.display === "none";
    if (wasHidden) restoreWindow();
    var targetId = _scrollTargets[id] || id;
    setTimeout(function () {
      var el = document.getElementById(targetId);
      if (el && mainWindow) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }, wasHidden ? 260 : 0);
  }

  function _handleTaskbarBtn(id) {
    /* Always bring the main window to front first */
    _bringToFront("__main");
    if (_activeSection === id) {
      // Toggle off — scroll to top
      _setActiveSection(null);
      if (mainWindow) mainWindow.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      _setActiveSection(id);
      scrollToSection(id);
    }
  }

  if (tbDustyTrails) tbDustyTrails.addEventListener("click", function () { _handleTaskbarBtn("dustytrails"); });
  if (tbTui)         tbTui.addEventListener("click",         function () { _handleTaskbarBtn("tui-demo"); });
  if (tbAbout)       tbAbout.addEventListener("click",       function () { _handleTaskbarBtn("about"); });

  /* ── Update active taskbar button on scroll ── */
  (function () {
    var _sections = [
      { id: "dustytrails", el: document.getElementById("dustytrails") },
      { id: "tui-demo",    el: document.getElementById("tui-demo") },
      { id: "about",       el: document.getElementById("about") }
    ];
    var _scrollRaf = null;

    function _updateFromScroll() {
      _scrollRaf = null;
      if (!mainWindow) return;
      var mwTop = mainWindow.getBoundingClientRect().top;
      var halfH = mainWindow.clientHeight * 0.49;
      var active = null;
      /* Backward scan: deepest qualifying section wins */
      for (var i = _sections.length - 1; i >= 0; i--) {
        var sec = _sections[i];
        if (!sec.el) continue;
        var relTop = sec.el.getBoundingClientRect().top - mwTop;
        var threshold = (i === 0) ? 10 : halfH; /* dustytrails: top; tui-demo & about: halfway */
        if (relTop <= threshold) { active = sec.id; break; }
      }
      if (active !== _activeSection) _setActiveSection(active);
    }

    if (mainWindow) {
      mainWindow.addEventListener("scroll", function () {
        if (!_scrollRaf) _scrollRaf = requestAnimationFrame(_updateFromScroll);
      }, { passive: true });
    }
  }());

  /* ── Start Menu ── */
  var startBtn  = document.getElementById("start-btn");
  var startMenu = document.getElementById("start-menu");

  function openStartMenu() {
    if (!startMenu) return;
    startMenu.classList.add("open");
    startMenu.setAttribute("aria-hidden", "false");
    if (startBtn) { startBtn.classList.add("open"); startBtn.setAttribute("aria-expanded", "true"); }
  }
  function closeStartMenu() {
    if (!startMenu) return;
    startMenu.classList.remove("open");
    startMenu.setAttribute("aria-hidden", "true");
    if (startBtn) { startBtn.classList.remove("open"); startBtn.setAttribute("aria-expanded", "false"); }
    /* Also close any open submenus */
    var openFolders = startMenu.querySelectorAll(".submenu-open");
    for (var k = 0; k < openFolders.length; k++) openFolders[k].classList.remove("submenu-open");
  }

  if (startBtn) startBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    startMenu && startMenu.classList.contains("open") ? closeStartMenu() : openStartMenu();
  });
  document.addEventListener("click", function (e) {
    if (startMenu && startMenu.classList.contains("open") &&
        !startMenu.contains(e.target) && e.target !== startBtn) closeStartMenu();
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeStartMenu(); });

  var smShutdown = document.getElementById("sm-shutdown");
  var smInstagram = document.getElementById("sm-instagram");

  if (smInstagram) smInstagram.addEventListener("click", function () {
    closeStartMenu();
  });
  if (smShutdown) smShutdown.addEventListener("click", function () {
    closeStartMenu();
    minimizeWindow();
    setTimeout(showBSOD, 250);
  });

  /* Close start menu when any submenu link is clicked */
  var subMenuLinks = document.querySelectorAll(".start-submenu a");
  for (var i = 0; i < subMenuLinks.length; i++) {
    subMenuLinks[i].addEventListener("click", function () { closeStartMenu(); });
  }

  /* ── Submenu hover debounce ── */
  (function () {
    var folders = document.querySelectorAll(".start-menu-folder");
    var OPEN_DELAY = 250;
    var CLOSE_DELAY = 350;

    for (var fi = 0; fi < folders.length; fi++) {
      (function (folder) {
        var openTimer = null;
        var closeTimer = null;
        var sub = folder.querySelector(".start-submenu");

        function cancelTimers() {
          if (openTimer) { clearTimeout(openTimer); openTimer = null; }
          if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
        }

        folder.addEventListener("mouseenter", function () {
          cancelTimers();
          openTimer = setTimeout(function () {
            folder.classList.add("submenu-open");
          }, OPEN_DELAY);
        });

        folder.addEventListener("mouseleave", function () {
          cancelTimers();
          closeTimer = setTimeout(function () {
            folder.classList.remove("submenu-open");
          }, CLOSE_DELAY);
        });

        /* Keep submenu open while hovering it */
        if (sub) {
          sub.addEventListener("mouseenter", function () {
            cancelTimers();
          });
          sub.addEventListener("mouseleave", function () {
            cancelTimers();
            closeTimer = setTimeout(function () {
              folder.classList.remove("submenu-open");
            }, CLOSE_DELAY);
          });
        }
      })(folders[fi]);
    }
  })();

  /* ── PWA install ── */
  var _installPrompt = null;

  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    _installPrompt = e;
  });

  window.addEventListener("appinstalled", function () {
    _installPrompt = null;
  });

  /* ═══════════════════════════════════════════════════════════════════════
     Floating desktop windows (Win95-style draggable widgets)
     ═══════════════════════════════════════════════════════════════════════ */
  var _deskWins = {};
  var _topZ = 300;
  var _focusedWin = null;
  var _lastWinX = null;
  var _lastWinY = null;
  var CASCADE_OFFSET = 28;

  /* Register the main app-window (.page) in the z-stack */
  var _pageEl = document.querySelector(".page");
  if (_pageEl && appWindow) {
    _deskWins["__main"] = {
      el: _pageEl,
      tbBtn: tbMainBtn,
      minimized: false,
      isMain: true,
    };
    /* Clicking anywhere in the main window brings it to front */
    appWindow.addEventListener("mousedown", function () { _bringToFront("__main"); });
  }

  /* Transparent click-guard overlays over each iframe viewport.
     When main is not the focused window, the guards intercept the first
     mousedown, call _bringToFront("__main"), then get out of the way.
     This is purely parent-side and works in all browsers including Safari. */
  var _iframeGuards = [];
  document.querySelectorAll(".demo-viewport").forEach(function (vp) {
    var guard = document.createElement("div");
    guard.style.cssText = "position:absolute;inset:0;z-index:10;pointer-events:none;";
    guard.addEventListener("mousedown", function () {
      _bringToFront("__main");
    });
    vp.appendChild(guard);
    _iframeGuards.push(guard);
  });

  function _setIframeGuards(active) {
    for (var i = 0; i < _iframeGuards.length; i++) {
      _iframeGuards[i].style.pointerEvents = active ? "auto" : "none";
    }
  }

  function _bringToFront(id) {
    _topZ++;
    var w = _deskWins[id];
    if (w) w.el.style.zIndex = _topZ;
    _focusedWin = id;

    /* Update all taskbar button active states + titlebar colors */
    Object.keys(_deskWins).forEach(function (wid) {
      var dw = _deskWins[wid];
      var tb = dw.el && (dw.el.querySelector(".desktop-titlebar") || dw.el.querySelector(".titlebar"));
      if (wid === id && !dw.minimized) {
        if (dw.tbBtn) dw.tbBtn.classList.add("active");
        if (tb) tb.classList.remove("inactive");
      } else {
        if (dw.tbBtn) dw.tbBtn.classList.remove("active");
        if (tb) tb.classList.add("inactive");
      }
    });

    /* Winamp taskbar button: active only when winamp is focused */
    if (_winampTbBtn) {
      _winampTbBtn.classList.toggle("active", id === "__winamp");
    }

    /* When main window is focused, re-highlight the active section button.
       When any other window is focused, deactivate all section buttons. */
    if (id === "__main") {
      _setActiveSection(_activeSection);
      _setIframeGuards(false); /* main is active — let clicks reach iframes directly */
    } else {
      /* Deactivate main button and all section buttons */
      if (tbMainBtn) tbMainBtn.classList.remove("active");
      Object.keys(_sectionBtns).forEach(function (key) {
        var btn = _sectionBtns[key];
        if (btn) btn.classList.remove("active");
      });
      _setIframeGuards(true); /* main is inactive — intercept next iframe click */
    }
  }

  function _toggleDeskMin(id) {
    var w = _deskWins[id];
    if (!w) return;
    if (w.minimized) {
      w.el.style.display = "";
      w.minimized = false;
      _bringToFront(id);
      if (w.onRestore) w.onRestore();
    } else {
      if (w.onMinimize) w.onMinimize();
      w.el.style.display = "none";
      w.minimized = true;
      if (w.tbBtn) w.tbBtn.classList.remove("active");
      if (_focusedWin === id) {
        /* Focus the next topmost non-minimized window */
        _focusedWin = null;
        var bestId = null, bestZ = -1;
        Object.keys(_deskWins).forEach(function (wid) {
          var dw = _deskWins[wid];
          if (wid !== id && !dw.minimized) {
            var z = parseInt(dw.el.style.zIndex, 10) || 0;
            if (z > bestZ) { bestZ = z; bestId = wid; }
          }
        });
        if (bestId) _bringToFront(bestId);
      }
    }
  }

  function _recalcLastWinPos() {
    /* Recompute cascade position from remaining open windows */
    _lastWinX = null;
    _lastWinY = null;
    Object.keys(_deskWins).forEach(function (wid) {
      if (wid === "__main") return;
      var dw = _deskWins[wid];
      var r = dw.el.getBoundingClientRect();
      _lastWinX = Math.round(r.left);
      _lastWinY = Math.round(r.top);
    });
    /* Also account for Winamp if it's open */
    if (_webampContainer) {
      var wr = _webampContainer.getBoundingClientRect();
      _lastWinX = Math.round(wr.left);
      _lastWinY = Math.round(wr.top);
    }
  }

  function _closeDeskWin(id) {
    var w = _deskWins[id];
    if (!w) return;
    if (w.onClose) w.onClose();
    w.el.remove();
    if (w.tbBtn) w.tbBtn.remove();
    delete _deskWins[id];
    if (_focusedWin === id) _focusedWin = null;
    _recalcLastWinPos();
  }

  function _makeDraggable(win, handle) {
    var ox, oy, sx, sy, dragging = false;

    function setIframeBlock(block) {
      var iframes = win.querySelectorAll("iframe");
      for (var i = 0; i < iframes.length; i++)
        iframes[i].style.pointerEvents = block ? "none" : "";
    }

    function onDown(e) {
      if (e.target.closest(".desk-tb-btn")) return;
      dragging = true;
      var touch = e.touches ? e.touches[0] : e;
      ox = touch.clientX;
      oy = touch.clientY;
      var rect = win.getBoundingClientRect();
      sx = rect.left;
      sy = rect.top;
      setIframeBlock(true);
      e.preventDefault();
    }
    function onMove(e) {
      if (!dragging) return;
      var touch = e.touches ? e.touches[0] : e;
      var nx = sx + (touch.clientX - ox);
      var ny = sy + (touch.clientY - oy);
      nx = Math.max(-win.offsetWidth + 80, Math.min(window.innerWidth - 40, nx));
      ny = Math.max(0, Math.min(window.innerHeight - 40, ny));
      win.style.left = nx + "px";
      win.style.top = ny + "px";
      e.preventDefault();
    }
    function onUp() { if (dragging) setIframeBlock(false); dragging = false; }

    handle.addEventListener("mousedown", onDown);
    handle.addEventListener("touchstart", onDown, { passive: false });
    document.addEventListener("mousemove", onMove);
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("mouseup", onUp);
    document.addEventListener("touchend", onUp);
  }

  function openDesktopWindow(opts) {
    /* opts: id, title, icon, tbIconSVG, width, bodyEl, bodyHTML, onClose, onOpen */
    if (_deskWins[opts.id]) {
      var ew = _deskWins[opts.id];
      if (ew.minimized) _toggleDeskMin(opts.id);
      _bringToFront(opts.id);
      return ew.bodyEl;
    }

    var win = document.createElement("div");
    win.className = "desktop-window";
    win.id = "dwin-" + opts.id;
    win.style.width = opts.width + "px";

    /* Cascade from top-left, offset from last opened window */
    var baseX = 12, baseY = 32; /* below the main window titlebar */
    var x, y;
    if (_lastWinX !== null && _lastWinY !== null) {
      x = _lastWinX + CASCADE_OFFSET;
      y = _lastWinY + CASCADE_OFFSET;
    } else {
      x = baseX;
      y = baseY;
    }
    /* Wrap back if cascading off-screen */
    if (x + opts.width > window.innerWidth - 20 || y > window.innerHeight - 140) {
      x = baseX;
      y = baseY;
    }
    x = Math.max(0, Math.min(x, window.innerWidth - opts.width - 10));
    y = Math.max(0, Math.min(y, window.innerHeight - 80));
    _lastWinX = x;
    _lastWinY = y;
    win.style.left = x + "px";
    win.style.top = y + "px";

    /* Title bar */
    var tb = document.createElement("div");
    tb.className = "desktop-titlebar";
    tb.innerHTML =
      '<div class="desk-tb-left">' +
        '<span class="desk-tb-icon">' + (opts.icon || "&#128190;") + '</span>' +
        '<span class="desk-tb-text">' + opts.title + '</span>' +
      '</div>' +
      '<div class="desk-tb-btns">' +
        '<button class="desk-tb-btn" data-action="min" aria-label="Minimize">_</button>' +
        '<button class="desk-tb-btn desk-tb-close" data-action="close" aria-label="Close">&#10005;</button>' +
      '</div>';
    win.appendChild(tb);

    /* Body */
    var body = document.createElement("div");
    body.className = "desktop-window-body";
    if (opts.bodyHTML) body.innerHTML = opts.bodyHTML;
    if (opts.bodyEl) body.appendChild(opts.bodyEl);
    win.appendChild(body);

    /* Focus on click */
    win.addEventListener("mousedown", function () { _bringToFront(opts.id); });

    /* Title-bar buttons */
    tb.querySelector('[data-action="min"]').addEventListener("click", function (e) {
      e.stopPropagation();
      _toggleDeskMin(opts.id);
    });
    tb.querySelector('[data-action="close"]').addEventListener("click", function (e) {
      e.stopPropagation();
      _closeDeskWin(opts.id);
    });

    _makeDraggable(win, tb);

    /* Insert into DOM before the taskbar */
    document.body.insertBefore(win, document.getElementById("taskbar"));

    /* Taskbar button */
    var tbApps = document.getElementById("taskbar-apps");
    var tbBtn = document.createElement("button");
    tbBtn.className = "taskbar-app-btn";
    tbBtn.title = opts.title;
    tbBtn.innerHTML =
      (opts.tbIconSVG ? opts.tbIconSVG : "") +
      "<span>" + opts.title + "</span>";
    tbBtn.addEventListener("click", function () {
      var w = _deskWins[opts.id];
      if (!w) return;
      if (w.minimized) {
        _toggleDeskMin(opts.id);
      } else if (_focusedWin === opts.id) {
        _toggleDeskMin(opts.id);
      } else {
        _bringToFront(opts.id);
      }
    });
    tbApps.appendChild(tbBtn);

    _deskWins[opts.id] = {
      el: win,
      bodyEl: body,
      tbBtn: tbBtn,
      minimized: false,
      onClose: opts.onClose,
      onRestore: opts.onRestore,
      onMinimize: opts.onMinimize,
    };
    _bringToFront(opts.id);

    if (opts.onOpen) opts.onOpen(body);

    return body;
  }

  /* ── Pipes screensaver window ── */
  var _pipesInst = null;

  var PIPES_TB_ICON =
    '<svg class="tb-icon" width="14" height="14" viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true">' +
    '<rect width="16" height="16" fill="#000"/>' +
    '<rect x="3" y="2" width="3" height="8" fill="#c00"/>' +
    '<rect x="6" y="7" width="6" height="3" fill="#c00"/>' +
    '<rect x="9" y="5" width="3" height="8" fill="#2e8b57"/>' +
    '<rect x="1" y="10" width="8" height="3" fill="#2e8b57"/>' +
    '</svg>';

  function openPipesWindow() {
    closeStartMenu();
    if (_deskWins.pipes) {
      if (_deskWins.pipes.minimized) _toggleDeskMin("pipes");
      _bringToFront("pipes");
      return;
    }

    var w = Math.min(500, window.innerWidth - 40);
    var h = Math.min(380, window.innerHeight - 120);

    var wrap = document.createElement("div");
    wrap.style.position = "relative";

    var canvas = document.createElement("canvas");
    canvas.style.width = "100%";
    canvas.style.height = h + "px";
    canvas.style.display = "block";
    canvas.style.background = "#000";
    wrap.appendChild(canvas);

    /* Camera toggle button */
    var togBtn = document.createElement("button");
    togBtn.textContent = "\u21BB Orbit";
    togBtn.style.cssText =
      "position:absolute;top:6px;right:6px;z-index:2;" +
      "font-family:'VT323',monospace;font-size:0.8rem;padding:2px 8px;" +
      "background:rgba(192,192,192,0.85);border:1px solid #888;" +
      "cursor:pointer;color:#000;";
    wrap.appendChild(togBtn);

    togBtn.addEventListener("click", function () {
      if (!_pipesInst) return;
      var cur = _pipesInst.getMode();
      var next = cur === "classic" ? "rotate" : "classic";
      _pipesInst.setMode(next);
      togBtn.textContent = next === "classic" ? "\u21BB Orbit" : "\u25A3 Classic";
    });

    openDesktopWindow({
      id: "pipes",
      title: "3D Pipes",
      icon: "&#9883;",
      tbIconSVG: PIPES_TB_ICON,
      width: w,
      bodyEl: wrap,
      onClose: function () {
        if (_pipesInst) { _pipesInst.stop(); _pipesInst = null; }
      },
      onMinimize: function () {
        if (_pipesInst) _pipesInst.pause();
      },
      onRestore: function () {
        if (_pipesInst) _pipesInst.resume();
      },
      onOpen: function () {
        setTimeout(function () {
          if (typeof PipesScreensaver === "function") {
            _pipesInst = PipesScreensaver(canvas, { mode: "classic" });
          }
        }, 60);
      },
    });
  }

  /* ── YouTube / Weezer window ── */
  var VIDEOS_TB_ICON =
    '<svg class="tb-icon" width="14" height="14" viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true">' +
    '<rect x="1" y="3" width="14" height="10" rx="1" fill="#1a1a2e" stroke="#c0c0c0" stroke-width="1"/>' +
    '<polygon points="6,5 6,11 12,8" fill="#c0c0c0"/>' +
    '</svg>';

  /* ── FlowerBox screensaver window ── */
  var _flowerboxInst = null;

  var FLOWERBOX_TB_ICON =
    '<svg class="tb-icon" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">' +
    '<rect width="16" height="16" fill="#000"/>' +
    '<polygon points="8,2 14,8 8,14 2,8" fill="#0cc" stroke="#f0f" stroke-width="1"/>' +
    '</svg>';

  function openFlowerBoxWindow() {
    closeStartMenu();
    if (_deskWins.flowerbox) {
      if (_deskWins.flowerbox.minimized) _toggleDeskMin("flowerbox");
      _bringToFront("flowerbox");
      return;
    }

    var w = Math.min(500, window.innerWidth - 40);
    var h = Math.min(380, window.innerHeight - 120);

    var canvas = document.createElement("canvas");
    canvas.style.width = "100%";
    canvas.style.height = h + "px";
    canvas.style.display = "block";
    canvas.style.background = "#000";

    openDesktopWindow({
      id: "flowerbox",
      title: "3D FlowerBox",
      icon: "&#10022;",
      tbIconSVG: FLOWERBOX_TB_ICON,
      width: w,
      bodyEl: canvas,
      onClose: function () {
        if (_flowerboxInst) { _flowerboxInst.stop(); _flowerboxInst = null; }
      },
      onMinimize: function () {
        if (_flowerboxInst) _flowerboxInst.pause();
      },
      onRestore: function () {
        if (_flowerboxInst) _flowerboxInst.resume();
      },
      onOpen: function () {
        setTimeout(function () {
          if (typeof FlowerBoxScreensaver === "function") {
            _flowerboxInst = FlowerBoxScreensaver(canvas);
          }
        }, 60);
      },
    });
  }

  function openVideosWindow() {
    closeStartMenu();
    if (_deskWins.videos) {
      if (_deskWins.videos.minimized) _toggleDeskMin("videos");
      _bringToFront("videos");
      return;
    }

    var w = Math.min(520, window.innerWidth - 40);
    var aspectH = Math.round(w * 9 / 16);

    openDesktopWindow({
      id: "videos",
      title: "Videos",
      icon: "&#9654;",
      tbIconSVG: VIDEOS_TB_ICON,
      width: w,
      bodyHTML:
        '<iframe width="100%" height="' + aspectH + '" ' +
        'src="https://www.youtube.com/embed/kemivUKb4f4" ' +
        'title="Weezer — Buddy Holly" frameborder="0" ' +
        'allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" ' +
        'allowfullscreen style="display:block;"></iframe>',
    });
  }

  /* ── Winamp (Webamp) ── */
  var _webampInst = null;
  var _webampContainer = null;
  var _winampTbBtn = null;
  var _webampEl = null;

  var WINAMP_TB_ICON =
    '<svg class="tb-icon" width="14" height="14" viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true">' +
    '<rect width="16" height="16" rx="1" fill="#1a1a2e"/>' +
    '<rect x="2" y="6" width="3" height="5" fill="#f90"/>' +
    '<rect x="6" y="4" width="3" height="9" fill="#f90"/>' +
    '<rect x="10" y="2" width="4" height="12" fill="#f90"/>' +
    '</svg>';

  function _focusWinamp() {
    _topZ++;
    _focusedWin = "__winamp";
    /* Raise Webamp's actual DOM element into the stacking order */
    if (_webampEl) _webampEl.style.zIndex = _topZ;
    /* Deactivate all desktop-window taskbar buttons + gray out titlebars */
    Object.keys(_deskWins).forEach(function (wid) {
      var dw = _deskWins[wid];
      if (dw.tbBtn) dw.tbBtn.classList.remove("active");
      var tb = dw.el && (dw.el.querySelector(".desktop-titlebar") || dw.el.querySelector(".titlebar"));
      if (tb) tb.classList.add("inactive");
    });
    if (tbMainBtn) tbMainBtn.classList.remove("active");
    Object.keys(_sectionBtns).forEach(function (key) {
      if (_sectionBtns[key]) _sectionBtns[key].classList.remove("active");
    });
    if (_winampTbBtn) _winampTbBtn.classList.add("active");
  }

  function openWinampWindow() {
    closeStartMenu();

    /* If already open: taskbar click logic */
    if (_webampInst) {
      if (!_webampContainer) return;
      var isHidden = _webampContainer.style.display === "none";
      if (isHidden) {
        /* Restore from minimized */
        _webampContainer.style.display = "";
        _focusWinamp();
      } else if (_focusedWin === "__winamp") {
        /* Already focused — minimize */
        _webampContainer.style.display = "none";
        if (_winampTbBtn) _winampTbBtn.classList.remove("active");
        _focusedWin = null;
      } else {
        /* Visible but not focused — just focus */
        _focusWinamp();
      }
      return;
    }

    var Webamp = window._WebampClass;
    if (!Webamp) { console.warn("Webamp not loaded yet"); return; }

    /* Block text selection while dragging Webamp's own windows */
    var _blockSelect = function (e) { e.preventDefault(); };
    document.addEventListener("selectstart", _blockSelect);

    _webampContainer = document.createElement("div");
    _webampContainer.id = "winamp-container";
    /* Use the same cascade position as other desktop windows */
    var baseX = 12, baseY = 32;
    var wx, wy;
    if (_lastWinX !== null && _lastWinY !== null) {
      wx = _lastWinX + CASCADE_OFFSET;
      wy = _lastWinY + CASCADE_OFFSET;
    } else {
      wx = baseX;
      wy = baseY;
    }
    var ww = 275, wh = 232;
    if (wx + ww > window.innerWidth - 20 || wy > window.innerHeight - 140) {
      wx = baseX;
      wy = baseY;
    }
    wx = Math.max(0, Math.min(wx, window.innerWidth - ww - 10));
    wy = Math.max(0, Math.min(wy, window.innerHeight - 80));
    _lastWinX = wx;
    _lastWinY = wy;
    _webampContainer.style.cssText =
      "position:fixed;top:" + wy + "px;left:" + wx + "px;width:" + ww + "px;height:" + wh + "px;pointer-events:none;";
    document.body.appendChild(_webampContainer);

    _webampInst = new Webamp({
      initialTracks: [
        { metaData: { artist: "The Incredible Machine", title: "Title Screen Theme"           }, url: "mp3s/01_Title_Screen_Theme.mp3" },
        { metaData: { artist: "The Incredible Machine", title: "Unplugged (ft. Bill Barrett)" }, url: "mp3s/02_Unplugged_(ft._Bill_Barrett).mp3" },
        { metaData: { artist: "The Incredible Machine", title: "Steel Drums"                  }, url: "mp3s/03_Steel_Drums.mp3" },
        { metaData: { artist: "The Incredible Machine", title: "New Age"                      }, url: "mp3s/04_New_Age.mp3" },
        { metaData: { artist: "The Incredible Machine", title: "Hay Seed (ft. Bill Barrett)"  }, url: "mp3s/05_Hay_Seed_(ft._Bill_Barrett).mp3" },
        { metaData: { artist: "The Incredible Machine", title: "Progressive"                  }, url: "mp3s/06_Progressive.mp3" },
        { metaData: { artist: "The Incredible Machine", title: "Salsa"                        }, url: "mp3s/07_Salsa.mp3" },
        { metaData: { artist: "The Incredible Machine", title: "Techno Rave"                  }, url: "mp3s/08_Techno_Rave.mp3" },
        { metaData: { artist: "The Incredible Machine", title: "1959 Prom"                    }, url: "mp3s/09_1959_Prom.mp3" },
        { metaData: { artist: "The Incredible Machine", title: "Bongo Bango"                  }, url: "mp3s/10_Bongo_Bango.mp3" },
        { metaData: { artist: "The Incredible Machine", title: "Ragtime"                      }, url: "mp3s/11_Ragtime.mp3" },
        { metaData: { artist: "The Incredible Machine", title: "Hip Hop"                      }, url: "mp3s/12_Hip_Hop.mp3" },
        { metaData: { artist: "The Incredible Machine", title: "Keep Tryin'"                  }, url: "mp3s/13_Keep_Tryin'.mp3" },
        { metaData: { artist: "The Incredible Machine", title: "Detective Theme"              }, url: "mp3s/14_Detective_Theme.mp3" },
        { metaData: { artist: "The Incredible Machine", title: "Dreams"                       }, url: "mp3s/15_Dreams.mp3" },
        { metaData: { artist: "The Incredible Machine", title: "Tuna Loaf"                    }, url: "mp3s/16_Tuna_Loaf.mp3" },
        { metaData: { artist: "The Incredible Machine", title: "60s Rock"                     }, url: "mp3s/17_60s_Rock.mp3" },
        { metaData: { artist: "The Incredible Machine", title: "Pictures"                     }, url: "mp3s/18_Pictures.mp3" },
        { metaData: { artist: "The Incredible Machine", title: "Huey Dewey"                   }, url: "mp3s/19_Huey_Dewey.mp3" },
        { metaData: { artist: "The Incredible Machine", title: "Hip Hop (Reprise)"            }, url: "mp3s/20_Hip_Hop_(Reprise).mp3" },
      ],
      zIndex: 300,
      windowLayout: {
        main:      { position: { top: 0, left: 0 } },
        equalizer: { position: { top: 116, left: 0 } },
        playlist:  { position: { top: 232, left: 0 } },
      },
    });

    /* Expose to devtools for exploration */
    window._webamp = _webampInst;

    _webampInst.renderWhenReady(_webampContainer).then(function () {
      /* Webamp inserts its actual UI as a new direct child of <body>,
         NOT inside our container. Find it and attach focus listener. */
      var webampEl = document.body.lastElementChild;
      if (webampEl) {
        _webampEl = webampEl;
        webampEl.addEventListener("mousedown", function () {
          _focusWinamp();
        }, true);

        /* Tell Webamp's internal Redux store that the viewport stops
           at the taskbar.  Its built-in drag-snap logic will then
           prevent windows from going below the taskbar. */
        var taskbar = document.querySelector(".taskbar");
        var store = _webampInst.store;
        function correctBounds() {
          if (!taskbar || !store) return;
          var maxH = window.innerHeight - taskbar.offsetHeight;
          var state = store.getState();
          var bws = state.windows && state.windows.browserWindowSize;
          if (bws && bws.height > maxH) {
            store.dispatch({
              type: "BROWSER_WINDOW_SIZE_CHANGED",
              width: bws.width,
              height: maxH,
            });
          }
        }
        store.subscribe(correctBounds);
        correctBounds();
        var onResize = function () { correctBounds(); };
        window.addEventListener("resize", onResize);
        _webampInst.onClose(function () {
          window.removeEventListener("resize", onResize);
        });
      }
    });

    /* Add taskbar button matching our existing style */
    _winampTbBtn = document.createElement("button");
    _winampTbBtn.className = "taskbar-app-btn active";
    _winampTbBtn.title = "Winamp";
    _winampTbBtn.innerHTML = WINAMP_TB_ICON + "<span>Winamp</span>";
    _winampTbBtn.addEventListener("click", function () { openWinampWindow(); });
    document.getElementById("taskbar-apps").appendChild(_winampTbBtn);

    _focusWinamp();

    _webampInst.onClose(function () {
      document.removeEventListener("selectstart", _blockSelect);
      if (_webampContainer) { _webampContainer.remove(); _webampContainer = null; }
      if (_winampTbBtn) { _winampTbBtn.remove(); _winampTbBtn = null; }
      if (_focusedWin === "__winamp") _focusedWin = null;
      _webampInst = null;
      window._webamp = null;
      _webampEl = null;
      _recalcLastWinPos();
    });
  }

  /* ── Wire up Start Menu items ── */
  var smPipes = document.getElementById("sm-pipes");
  var smFlowerbox = document.getElementById("sm-flowerbox");
  var smVideos = document.getElementById("sm-videos");
  var smWinamp = document.getElementById("sm-winamp");

  if (smPipes) smPipes.addEventListener("click", function (e) {
    e.preventDefault();
    openPipesWindow();
  });
  if (smFlowerbox) smFlowerbox.addEventListener("click", function (e) {
    e.preventDefault();
    openFlowerBoxWindow();
  });
  if (smVideos) smVideos.addEventListener("click", function (e) {
    e.preventDefault();
    openVideosWindow();
  });
  if (smWinamp) smWinamp.addEventListener("click", function (e) {
    e.preventDefault();
    openWinampWindow();
  });

  /* ── On load: derive active taskbar button from restored scroll position ── */
  /* Stateless — no stored state; just read where we are and set the button once. */
  (function () {
    if (!mainWindow) return;
    var sections = [
      { id: "dustytrails", el: document.getElementById("demo-dustytrails") },
      { id: "tui-demo",    el: document.getElementById("demo-tui") },
      { id: "about",       el: document.getElementById("about") }
    ];
    var mwTop = mainWindow.getBoundingClientRect().top;
    var threshold = 120; /* section counts as active if its top is within this many px of the window top */
    var active = null;
    for (var i = 0; i < sections.length; i++) {
      var sec = sections[i];
      if (!sec.el) continue;
      if (sec.el.getBoundingClientRect().top - mwTop <= threshold) {
        active = sec.id;
      }
    }
    _setActiveSection(active);
  }());

})();
