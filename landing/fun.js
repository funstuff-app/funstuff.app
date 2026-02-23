/* funstuff.app — interactions */
(function () {
  "use strict";

  /* ── Weekend snapshot logic for embedded map widget ── */
  var _widgetLoadTime = Date.now();
  var _widgetSnapshotParams = null;
  var _snapshotIdx = 0;
  var _dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  function _snapshotDate(idx) {
    var now = new Date();
    var day = now.getDay();
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
    iframe.src = baseSrc + "?" + _snapshotParamStr(dateStr) + "&lite=1";
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
    var day = now.getDay();
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
      if (iframe) iframe.src = iframe.getAttribute("data-src") || "https://dustytrails.funstuff.app/";
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
      "Press any key to continue _";
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
    }, 220);
  }

  function restoreWindow() {
    if (!appWindow) return;
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

  function _bringToFront(id) {
    _topZ++;
    var w = _deskWins[id];
    if (w) w.el.style.zIndex = _topZ;
    _focusedWin = id;
    Object.keys(_deskWins).forEach(function (wid) {
      var dw = _deskWins[wid];
      if (dw.tbBtn) {
        if (wid === id && !dw.minimized) dw.tbBtn.classList.add("active");
        else dw.tbBtn.classList.remove("active");
      }
    });
  }

  function _toggleDeskMin(id) {
    var w = _deskWins[id];
    if (!w) return;
    if (w.minimized) {
      w.el.style.display = "";
      w.minimized = false;
      _bringToFront(id);
    } else {
      w.el.style.display = "none";
      w.minimized = true;
      _focusedWin = null;
      if (w.tbBtn) w.tbBtn.classList.remove("active");
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
      title: "Weezer — Buddy Holly",
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

  /* ── Wire up Start Menu items ── */
  var smPipes = document.getElementById("sm-pipes");
  var smVideos = document.getElementById("sm-videos");

  if (smPipes) smPipes.addEventListener("click", function (e) {
    e.preventDefault();
    openPipesWindow();
  });
  if (smVideos) smVideos.addEventListener("click", function (e) {
    e.preventDefault();
    openVideosWindow();
  });

})();
