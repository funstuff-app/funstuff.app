/* funstuff.app — tiny interactions */
(function () {
  "use strict";

  // Track when the widget loaded (for syncing playhead on click-through)
  var _widgetLoadTime = Date.now();
  // Snapshot params set by setMapIframeSrc (null on weekdays/live)
  var _widgetSnapshotParams = null;

  // ── Weekend snapshot date logic for embedded map ──
  // On weekends, load a recent weekday snapshot so the iframe doesn't show "offline"
  (function setMapIframeSrc() {
    var iframe = document.getElementById("map-iframe");
    if (!iframe) return;
    var baseSrc = iframe.getAttribute("data-src") || "https://dustytrails.funstuff.app/";
    var indicator = document.getElementById("snapshot-indicator");
    var now = new Date();
    var day = now.getDay(); // 0=Sun, 6=Sat

    if (day === 0 || day === 6) {
      // Weekend — pick a weekday snapshot, rotating through Mon-Fri across reloads
      var key = "funstuff_weekday_idx";
      var stored = sessionStorage.getItem(key);
      // Weekday offsets from most-recent Friday, cycling: Fri(0), Thu(1), Wed(2), Tue(3), Mon(4)
      var idx = stored !== null ? (parseInt(stored, 10) + 1) % 5 : 0;
      sessionStorage.setItem(key, String(idx));

      // Calculate the target weekday date
      // daysSinceLastFriday: how many days back from today to reach last Friday
      var daysSinceLastFriday = (day === 6) ? 1 : 2; // Sat->1 back, Sun->2 back
      var daysBack = daysSinceLastFriday + idx; // then add rotation offset (0=Fri,1=Thu,...)
      var target = new Date(now);
      target.setDate(target.getDate() - daysBack);
      var dateStr = target.getFullYear() + "-" +
        String(target.getMonth() + 1).padStart(2, "0") + "-" +
        String(target.getDate()).padStart(2, "0");

      iframe.src = baseSrc + "?date=" + dateStr + "&start=10&duration=2&playhead=60&speed=20&lite=1";

      // Store params so the overlay click can sync playhead
      _widgetSnapshotParams = { date: dateStr, start: 10, duration: 2, basePlayhead: 60, speed: 20 };

      var overlayLabel = document.getElementById("demo-overlay-label");
      if (overlayLabel) overlayLabel.textContent = "Recorded snapshot \u2014 click to open live app";

      if (indicator) {
        var dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        indicator.textContent = "\u25B6 " + dayNames[target.getDay()] + " " +
          (target.getMonth() + 1) + "/" + target.getDate() + " 11AM";
        indicator.style.display = "block";
      }
    } else {
      // Weekday — load live
      iframe.src = baseSrc;
      var overlayLabel = document.getElementById("demo-overlay-label");
      if (overlayLabel) overlayLabel.textContent = "Live preview \u2014 click to open full app";
      if (indicator) indicator.style.display = "none";
    }
  })();

  // ── Taskbar clock ──
  const clockEl = document.getElementById("tray-clock");
  function tick() {
    const now = new Date();
    const h = now.getHours();
    const m = String(now.getMinutes()).padStart(2, "0");
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 || 12;
    clockEl.textContent = h12 + ":" + m + " " + ampm;
  }
  tick();
  setInterval(tick, 15000);

  // ── Title-bar buttons (just for fun) ──
  const closeBtn = document.querySelector(".tb-close");
  const mainWindow = document.querySelector(".main-window");

  // ── Map overlay → link to full app (synced to widget playhead on weekends) ──
  var mapOverlay = document.querySelector(".demo-overlay");
  if (mapOverlay) {
    mapOverlay.addEventListener("click", function () {
      if (_widgetSnapshotParams) {
        // Weekend: sync playhead to elapsed time since widget loaded
        var elapsedMin = Math.floor((Date.now() - _widgetLoadTime) / 60000);
        // Scale by playback speed to get simulated minutes elapsed
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
        window.open(url, "_blank", "noopener");
      } else {
        // Weekday: open live with no params
        window.open("https://dustytrails.funstuff.app/", "_blank", "noopener");
      }
    });
  }

  if (closeBtn && mainWindow) {
    closeBtn.addEventListener("click", function () {
      mainWindow.style.transition = "opacity 0.3s, transform 0.3s";
      mainWindow.style.opacity = "0";
      mainWindow.style.transform = "scale(0.95)";
      setTimeout(function () {
        mainWindow.style.display = "none";
        // Show a BSOD-style joke for 2 seconds then bring it back
        const bsod = document.createElement("div");
        bsod.style.cssText =
          "position:fixed;inset:0;background:#000080;color:#fff;font-family:'VT323',monospace;" +
          "display:flex;align-items:center;justify-content:center;font-size:1.6rem;" +
          "text-align:center;z-index:10000;padding:40px;line-height:1.8;";
        bsod.innerHTML =
          "A fatal exception 0E has occurred at 0028:C0011E36<br><br>" +
          "* Press any key to return to funstuff.app<br>" +
          "* Press CTRL+ALT+DEL to pretend this didn't happen<br><br>" +
          "Press any key to continue _";
        document.body.appendChild(bsod);

        function restore() {
          bsod.remove();
          mainWindow.style.display = "";
          mainWindow.style.opacity = "1";
          mainWindow.style.transform = "";
          document.removeEventListener("keydown", restore);
          document.removeEventListener("click", restore);
        }
        // Any key or click brings it back
        setTimeout(function () {
          document.addEventListener("keydown", restore, { once: true });
          document.addEventListener("click", restore, { once: true });
        }, 300);
      }, 350);
    });
  }
})();
