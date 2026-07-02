/**
 * ui_theme.js — map theme + dim/saturation filter sliders + theme storage.
 *
 * Extracted from app.js main(): owns the theme <select>/dim/sat DOM refs,
 * per-theme dim/sat persistence, system-dark-mode detection, and the theme
 * apply/filter pipeline (map.setTheme + applyMapFilterVars). main() constructs
 * one instance and keeps thin one-line delegates at the original call sites
 * (applyTheme, applyThemeAndFilters, etc.) so the handful of touch points
 * shared with unmoved code (updateThemeSubmenu in the playback menu, the
 * post-loadConfig re-apply) are untouched. `_currentThemeKey` is read/written
 * by both this module (via applyTheme) and updateThemeSubmenu's click handler
 * (still in main()), so it stays a main()-owned variable reached through
 * injected get/set callbacks rather than moving into ThemeUI.
 */
(function (root, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else {
    root.ThemeUI = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const g = (typeof window !== "undefined") ? window : globalThis;

  function clamp(n, lo, hi) { return g.clamp ? g.clamp(n, lo, hi) : Math.max(lo, Math.min(hi, n)); }

  // ── Constructor ──────────────────────────────────────────────────────────

  /**
   * @param {object} cfg
   *   map                   — MapView instance
   *   document              — DOM document
   *   setCurrentThemeKey    — (key) => void, writes main()'s _currentThemeKey
   *   getUpdateThemeSubmenu — () => the window._updateThemeSubmenu fn (defined
   *                            later in main(), read lazily at call time)
   */
  function ThemeUI(cfg) {
    this.cfg = cfg || {};
    const document = this.cfg.document;
    const map = this.cfg.map;

    // Theme + per-theme dimming/saturation sliders (persisted).
    this.themeEl = document.getElementById("mapTheme");
    this.dimEl = document.getElementById("mapDim");
    this.satEl = document.getElementById("mapSat");

    const themeEl = this.themeEl;
    const dimEl = this.dimEl;
    const satEl = this.satEl;

    // updateThemeSubmenu is defined later in main() (assigned to
    // window._updateThemeSubmenu once the playback menu is built); read it
    // lazily so construction order doesn't matter.
    const updateThemeSubmenu = () => {
      const fn = this.cfg.getUpdateThemeSubmenu && this.cfg.getUpdateThemeSubmenu();
      if (fn) fn();
    };

    if (themeEl) {
      const keys = Object.keys(TILE_THEMES);
      for (const k of keys) {
        const opt = document.createElement("option");
        opt.value = k;
        opt.textContent = TILE_THEMES[k].label || k;
        themeEl.appendChild(opt);
      }

      // Load saved theme (prefers last user selection over system mode)
      const initialTheme = this.getInitialTheme();
      this.applyTheme(initialTheme, true); // skip submenu update on init (not created yet)

      themeEl.addEventListener("change", () => {
        const k = themeEl.value;
        this.cfg.setCurrentThemeKey(k);
        this.saveThemeForMode(k);
        const dim = this.loadDimForTheme(k);
        if (dimEl) dimEl.value = String(dim);
        const sat = this.loadSatForTheme(k);
        if (satEl) satEl.value = String(sat);
        this.applyThemeAndFilters(k, dim, sat);
        updateThemeSubmenu();
      });
    } else {
      // Fallback (no UI) - prefer last user selection
      const fallbackTheme = this.getInitialTheme();
      this.cfg.setCurrentThemeKey(fallbackTheme);
      const fallbackT = TILE_THEMES[fallbackTheme];
      this.applyThemeAndFilters(fallbackTheme, fallbackT.defaultDim ?? 70, Math.round(100 * (fallbackT.filter?.saturate ?? 1.30)));
    }

    // System theme auto-switching disabled (light themes disabled)
    // if (window.matchMedia) {
    //   window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    //     const newTheme = getSavedThemeForCurrentMode();
    //     applyTheme(newTheme);
    //   });
    // }

    // // Re-check system theme when app returns to foreground (PWA / tab switch).
    // // The matchMedia 'change' event may not fire while the app is backgrounded,
    // // so the theme can get out of sync until the user interacts.
    // {
    //   let _lastKnownSystemDark = isSystemDarkMode();
    //   document.addEventListener("visibilitychange", () => {
    //     if (document.visibilityState !== "visible") return;
    //     const nowDark = isSystemDarkMode();
    //     if (nowDark !== _lastKnownSystemDark) {
    //       _lastKnownSystemDark = nowDark;
    //       const newTheme = getSavedThemeForCurrentMode();
    //       // Only switch if the current theme's dark/light doesn't match system
    //       if (isThemeDark(_currentThemeKey) !== nowDark) {
    //         applyTheme(newTheme);
    //       }
    //     }
    //   });
    // }

    if (dimEl) {
      dimEl.addEventListener("input", () => {
        const themeKey = (themeEl && TILE_THEMES[themeEl.value]) ? themeEl.value : "carto_dark_all";
        const settingsKey = this.getThemeSettingsKey(themeKey);
        const isDark = this.isThemeDark(themeKey);
        const dimMax = isDark ? 150 : 100;
        const v = Number(dimEl.value);
        const clamped = Math.max(0, Math.min(dimMax, isFinite(v) ? v : 50));
        localStorage.setItem(DIM_STORAGE_PREFIX + settingsKey, String(clamped));
        const sat = satEl ? Number(satEl.value) : this.loadSatForTheme(themeKey);
        const satClamped = Math.max(0, Math.min(150, isFinite(sat) ? sat : this.loadSatForTheme(themeKey)));
        this.applyThemeAndFilters(themeKey, clamped, satClamped);
      });
    }

    if (satEl) {
      satEl.addEventListener("input", () => {
        const themeKey = (themeEl && TILE_THEMES[themeEl.value]) ? themeEl.value : "carto_dark_all";
        const settingsKey = this.getThemeSettingsKey(themeKey);
        const isDark = this.isThemeDark(themeKey);
        const dimMax = isDark ? 150 : 100;
        const v = Number(satEl.value);
        const clamped = Math.max(0, Math.min(150, isFinite(v) ? v : this.loadSatForTheme(themeKey)));
        localStorage.setItem(SAT_STORAGE_PREFIX + settingsKey, String(clamped));
        const dim = dimEl ? Number(dimEl.value) : this.loadDimForTheme(themeKey);
        const dimClamped = Math.max(0, Math.min(dimMax, isFinite(dim) ? dim : this.loadDimForTheme(themeKey)));
        this.applyThemeAndFilters(themeKey, dimClamped, clamped);
      });
    }
  }

  // ── Core queries ─────────────────────────────────────────────────────────

  ThemeUI.prototype.dimToBrightness = function (dim01) {
    // dim01: 0..1 where 1 == brightest; map to a conservative brightness range.
    // 0 -> 0.55, 1 -> 0.90
    return 0.55 + dim01 * 0.35;
  };

  // Map theme variants to shared settings key (e.g., carto_dark_all and carto_dark_nolabels share settings)
  ThemeUI.prototype.getThemeSettingsKey = function (themeKey) {
    const k = String(themeKey);
    if (k.startsWith("carto_dark")) return "carto_dark";
    if (k.startsWith("carto_positron")) return "carto_positron";
    return k; // osm, carto_voyager, etc. stay as-is
  };

  ThemeUI.prototype.loadDimForTheme = function (themeKey) {
    const settingsKey = this.getThemeSettingsKey(themeKey);
    const raw = localStorage.getItem(DIM_STORAGE_PREFIX + settingsKey);
    const t = TILE_THEMES[themeKey] || TILE_THEMES.carto_dark_all;
    const def = t.defaultDim ?? 50;
    const v = raw == null ? def : Number(raw);
    const dimMax = this.isThemeDark(themeKey) ? 150 : 100;
    const clamped = Math.max(0, Math.min(dimMax, isFinite(v) ? v : def));
    return clamped;
  };

  ThemeUI.prototype.loadSatForTheme = function (themeKey) {
    const settingsKey = this.getThemeSettingsKey(themeKey);
    const raw = localStorage.getItem(SAT_STORAGE_PREFIX + settingsKey);
    const t = TILE_THEMES[themeKey] || TILE_THEMES.carto_dark_all;
    const def = t.defaultSat ?? Math.round(100 * (t.filter?.saturate ?? 0.55));
    const v = raw == null ? def : Number(raw);
    const clamped = Math.max(0, Math.min(150, isFinite(v) ? v : def));
    return clamped;
  };

  ThemeUI.prototype.applyThemeAndFilters = function (themeKey, dimVal0to100, satVal0to150) {
    const map = this.cfg.map;
    const t = TILE_THEMES[themeKey] || TILE_THEMES.carto_dark_all;
    // Only call setTheme when the theme actually changes — it clears the tile
    // cache and forces a full reload, which causes visible flashing when just
    // adjusting dim/sat sliders.
    if (map.themeKey !== themeKey) {
      map.setTheme(themeKey);
    }

    const dim01 = (dimVal0to100 / 100);
    const brightness = this.dimToBrightness(dim01);
    const isDarkTheme = String(themeKey).includes("dark");
    // For dark themes, use Sat slider as a "shadow lift" mix (only tiles, overlays unaffected).
    // Saturation still applies, but we clamp it to avoid making dark basemaps neon.
    const sat = isDarkTheme ? Math.min(1.0, (satVal0to150 / 100)) : (satVal0to150 / 100);
    // Lift only kicks in above 100; 100..150 -> 0..0.28 opacity.
    const shadowLift = isDarkTheme ? clamp((satVal0to150 - 100) / 50, 0, 1) * 0.28 : 0;
    applyMapFilterVars({
      saturate: sat,
      brightness: brightness,
      contrast: t.filter?.contrast ?? 1.12,
      shadowLift,
    });
    // Set map background color to match theme (prevents flash while tiles load)
    if (t.bgColor) {
      document.documentElement.style.setProperty('--map-bg', t.bgColor);
    }
  };

  // Detect system color scheme preference
  ThemeUI.prototype.isSystemDarkMode = function () {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  };

  ThemeUI.prototype.isThemeDark = function (themeKey) {
    return String(themeKey).includes("dark");
  };

  ThemeUI.prototype.getThemeStorageKey = function () {
    return this.isSystemDarkMode() ? THEME_STORAGE_KEY_DARK : THEME_STORAGE_KEY_LIGHT;
  };

  ThemeUI.prototype.getDefaultThemeForMode = function () {
    // Light themes disabled — always default to dark
    return "carto_dark_all";
    // return isSystemDarkMode() ? "carto_dark_all" : "carto_voyager";
  };

  ThemeUI.prototype.getSavedThemeForCurrentMode = function () {
    const key = this.getThemeStorageKey();
    const saved = localStorage.getItem(key);
    return (saved && TILE_THEMES[saved]) ? saved : this.getDefaultThemeForMode();
  };

  ThemeUI.prototype.saveThemeForMode = function (themeKey) {
    // Save to the appropriate key based on whether this is a dark or light theme
    const isDark = this.isThemeDark(themeKey);
    const key = isDark ? THEME_STORAGE_KEY_DARK : THEME_STORAGE_KEY_LIGHT;
    localStorage.setItem(key, themeKey);
    // Also save as the last-active theme so launch doesn't override user choice
    localStorage.setItem("mobileair.mapTheme.last", themeKey);
  };

  ThemeUI.prototype.getInitialTheme = function () {
    // On launch, prefer the last theme the user actively selected.
    // Only fall back to system-mode default if user never chose a theme.
    const last = localStorage.getItem("mobileair.mapTheme.last");
    if (last && TILE_THEMES[last]) return last;
    return this.getSavedThemeForCurrentMode();
  };

  ThemeUI.prototype.applyTheme = function (themeKey, skipSubmenuUpdate) {
    this.cfg.setCurrentThemeKey(themeKey);
    if (this.themeEl) this.themeEl.value = themeKey;
    const dim = this.loadDimForTheme(themeKey);
    if (this.dimEl) this.dimEl.value = String(dim);
    const sat = this.loadSatForTheme(themeKey);
    if (this.satEl) this.satEl.value = String(sat);
    this.applyThemeAndFilters(themeKey, dim, sat);
    // updateThemeSubmenu is defined later, only call it when triggered by system theme change
    if (!skipSubmenuUpdate && window._updateThemeSubmenu) window._updateThemeSubmenu();
  };

  return ThemeUI;
});
