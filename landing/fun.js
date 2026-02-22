/* funstuff.app — interactions */
(function () {
  "use strict";

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

  /* ── Map overlay → link to full app ── */
  var mapOverlay = document.querySelector(".demo-overlay");
  if (mapOverlay) {
    mapOverlay.addEventListener("click", function () {
      window.open("https://dustytrails.funstuff.app/", "_blank", "noopener");
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
      "* Press any key to return to funstuff.app<br>" +
      "* Press CTRL+ALT+DEL to pretend this didn't happen<br><br>" +
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
    if (tbMainBtn) tbMainBtn.classList.remove("active");
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
    if (tbMainBtn) tbMainBtn.classList.add("active");
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

  /* Taskbar main-window button: toggle */
  if (tbMainBtn) {
    tbMainBtn.addEventListener("click", function () {
      if (appWindow && appWindow.style.display === "none") {
        restoreWindow();
      } else {
        minimizeWindow();
      }
    });
  }

  /* ── Taskbar DustyTrails / TUI buttons (scroll to section) ── */
  var tbDustyTrails = document.getElementById("tb-dustytrails");
  var tbTui         = document.getElementById("tb-tui");

  function scrollToSection(id) {
    var wasHidden = appWindow && appWindow.style.display === "none";
    if (wasHidden) restoreWindow();
    setTimeout(function () {
      var el = document.getElementById(id);
      if (el && mainWindow) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }, wasHidden ? 260 : 0);
  }

  if (tbDustyTrails) tbDustyTrails.addEventListener("click", function () { scrollToSection("dustytrails"); });
  if (tbTui)         tbTui.addEventListener("click",         function () { scrollToSection("tui-demo"); });

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

  var smShutdown    = document.getElementById("sm-shutdown");
  var smDustyTrails  = document.getElementById("sm-dustytrails");
  var smTui          = document.getElementById("sm-tui");

  if (smDustyTrails) smDustyTrails.addEventListener("click", function () {
    closeStartMenu();
    scrollToSection("dustytrails");
  });
  if (smTui) smTui.addEventListener("click", function () {
    closeStartMenu();
    scrollToSection("tui-demo");
  });
  if (smShutdown) smShutdown.addEventListener("click", function () {
    closeStartMenu();
    minimizeWindow();
    setTimeout(showBSOD, 250);
  });

  /* ── PWA install ── */
  var _installPrompt = null;

  function showPwaTaskbarButtons() {
    if (tbDustyTrails) tbDustyTrails.style.display = "";
    if (tbTui)         tbTui.style.display = "";
    localStorage.setItem("funstuff_pwa_installed", "1");
  }

  /* Already installed on a previous visit? */
  if (localStorage.getItem("funstuff_pwa_installed") === "1" ||
      window.matchMedia("(display-mode: standalone)").matches) {
    showPwaTaskbarButtons();
  }

  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    _installPrompt = e;
  });

  window.addEventListener("appinstalled", function () {
    _installPrompt = null;
    showPwaTaskbarButtons();
  });

})();
