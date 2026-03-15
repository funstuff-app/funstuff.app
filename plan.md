# PurpleAir Scalar Field — Precipitation-Radar-Style Interpolation

## What this IS
A continuous color field like weather radar. At every point on the map, the PM2.5
value is spatially interpolated from nearby sensors using IDW, then that
interpolated value is mapped to a color via the same PM2.5→palette breakpoints
the dots use. The result: you see pollution blobs move between sensors as readings
change over time.

## Approach: Coarse-grid IDW, rendered to small ImageData, upscaled

### Step 1: Compute interpolated values on a coarse grid
- Grid resolution: **one cell per ~16 CSS pixels** → ~49×26 = ~1274 cells for 781×411 viewport
- For each grid cell center, convert screen coords → lat/lon
- IDW with **power=2**, using **all sensors within a cutoff radius** (e.g. 0.15° ≈ 15km — roughly the SLC metro density)
- If no sensors within cutoff, cell is transparent (no extrapolation beyond sensor coverage)
- Interpolate the **raw PM2.5 value**, NOT colors

### Step 2: Map interpolated values to colors
- Use the same PM2.5→hex breakpoints from `color_for_value` (Python), ported to JS:
  - ≤2.0 → #00FFFF (cyan)
  - ≤5.0 → #00CCFF (lt-blue)
  - ≤9.0 → #00E400 (green)
  - ≤35.4 → #FFFF00 (yellow)
  - ≤55.4 → #FF7E00 (orange)
  - ≤125.4 → #FF0000 (red)
  - ≤225.4 → #8F3F97 (purple)
  - else → #7E0023 (maroon)
- Apply `darkenHex(..., 0.85)` to match dot appearance
- Write RGBA to ImageData (with fixed alpha ~0.18 for subtle underlay, 0 where no data)

### Step 3: Render to small offscreen canvas, upscale to full size
- Create a tiny canvas (49×26)
- putImageData the grid
- Draw that tiny canvas onto `_paFieldCanvas` (full viewport size) with `imageSmoothingEnabled = true`
  → Canvas bilinear interpolation handles the visual smoothing for free

### Step 4: Caching (same pattern as current, but correct)
- Cache key: `view center + zoom + viewport size + hour bucket + sensor count`
- Invalidated alongside `_overlayStaticCanvas`
- Null on resize
- Composited BEFORE PurpleAir dots in both trace and playback paths (same insertion points already in place)

## Performance
- IDW computation: 1274 grid cells × ~200 sensors × 1 distance calc = 254,800 multiplies → <2ms
- ImageData write: 1274 × 4 bytes → trivial
- putImageData + drawImage upscale: <0.5ms
- Total cache miss: <3ms
- Cache hit: string comparison + drawImage blit → 0ms
- Recomputes only on: view pan/zoom OR hour boundary change

## What changes in map_view.js
1. **Replace `_ensurePaField` method entirely** — new implementation with IDW grid
2. **Add `_pm25ToColor` helper** — the PM2.5→hex breakpoint lookup (mirrors Python `color_for_value` for pm2.5)
3. **No other changes** — constructor fields, invalidation, resize, compositing insertion points all stay as-is

## What does NOT change
- No backend changes
- No new constructor fields (reuse `_paFieldCanvas` + `_paFieldKey`)
- No changes to compositing points (already wired in from current disc implementation)
- No changes to invalidation or resize handling
