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

  /* ── PWA install ── */
  var _installPrompt = null;

  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    _installPrompt = e;
  });

  window.addEventListener("appinstalled", function () {
    _installPrompt = null;
  });

})();
