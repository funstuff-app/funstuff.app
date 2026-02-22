/* funstuff.app — tiny interactions */
(function () {
  "use strict";

  // Track when the widget loaded (for syncing playhead on click-through)
  var _widgetLoadTime = Date.now();
  // Snapshot params set by setMapIframeSrc (null on weekdays/live)
  var _widgetSnapshotParams = null;
  // Current weekday cycle index (0=Fri, 1=Thu, 2=Wed, 3=Tue, 4=Mon)
  var _snapshotIdx = 0;

  var _dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  /** Compute the weekday snapshot date for a given index (0–4). */
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

  /** Build the param string for a snapshot (without leading ? or #). */
  function _snapshotParamStr(dateStr) {
    return "date=" + dateStr + "&start=10&duration=2&playhead=60&speed=20";
  }

  /** Full load a snapshot into the iframe (first load — sets src). */
  function _loadSnapshot(idx) {
    var iframe = document.getElementById("map-iframe");
    var indicator = document.getElementById("snapshot-indicator");
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

  /** Cycle to a new snapshot without reloading the iframe (hash change only). */
  function _cycleSnapshot(idx) {
    var iframe = document.getElementById("map-iframe");
    if (!iframe || !iframe.contentWindow) return;

    var target = _snapshotDate(idx);
    var dateStr = _formatDate(target);

    // Update iframe hash — triggers hashchange inside the dashboard, no reload
    iframe.contentWindow.location.hash = _snapshotParamStr(dateStr);

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

  // ── Weekend snapshot date logic for embedded map ──
  // On weekends, load a recent weekday snapshot so the iframe doesn't show "offline"
  (function setMapIframeSrc() {
    var now = new Date();
    var day = now.getDay(); // 0=Sun, 6=Sat

    if (day === 0 || day === 6) {
      // Weekend — pick a weekday snapshot, rotating through Mon-Fri across reloads
      var key = "funstuff_weekday_idx";
      var stored = sessionStorage.getItem(key);
      var idx = stored !== null ? (parseInt(stored, 10) + 1) % 5 : 0;
      sessionStorage.setItem(key, String(idx));

      _loadSnapshot(idx);

      var overlayLabel = document.getElementById("demo-overlay-label");
      if (overlayLabel) overlayLabel.textContent = "Recorded snapshot \u2014 click to open live app";
    } else {
      // Weekday — load live
      var iframe = document.getElementById("map-iframe");
      if (iframe) iframe.src = iframe.getAttribute("data-src") || "https://dustytrails.funstuff.app/";
      var overlayLabel = document.getElementById("demo-overlay-label");
      if (overlayLabel) overlayLabel.textContent = "Live preview \u2014 click to open full app";
      var indicator = document.getElementById("snapshot-indicator");
      if (indicator) indicator.style.display = "none";
    }
  })();

  // ── Snapshot indicator click → cycle to next weekday snapshot ──
  var indicatorEl = document.getElementById("snapshot-indicator");
  if (indicatorEl) {
    indicatorEl.addEventListener("click", function (e) {
      e.stopPropagation(); // don't trigger the overlay click-through
      var nextIdx = (_snapshotIdx + 1) % 5;
      _cycleSnapshot(nextIdx);
      // Persist so next page reload continues from here
      sessionStorage.setItem("funstuff_weekday_idx", String(_snapshotIdx));
    });
  }

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
