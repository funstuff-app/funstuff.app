/* funstuff.app — tiny interactions */
(function () {
  "use strict";

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

  // ── Map overlay → link to full app ──
  var mapOverlay = document.querySelector(".demo-overlay");
  if (mapOverlay) {
    mapOverlay.addEventListener("click", function () {
      window.open("https://dustytrails.funstuff.app/", "_blank", "noopener");
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
