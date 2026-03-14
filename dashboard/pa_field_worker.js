/**
 * Web Worker for PurpleAir scalar field IDW computation.
 * Offloads the O(gridCells × sensors) interpolation off the main thread
 * so scrubbing never blocks the UX.
 */

// PM2.5 → [r,g,b] — must match main-thread _pm25ToRgb exactly
function pm25ToRgb(v) {
  if (v <= 2.0)  return [0x00, 0xFF, 0xFF];
  if (v <= 5.0)  return [0x00, 0xCC, 0xFF];
  if (v <= 9.0)  return [0x00, 0xE4, 0x00];
  if (v <= 35.4) return [0xFF, 0xFF, 0x00];
  if (v <= 55.4) return [0xFF, 0x7E, 0x00];
  if (v <= 125.4) return [0xFF, 0x00, 0x00];
  if (v <= 225.4) return [0x8F, 0x3F, 0x97];
  return [0x7E, 0x00, 0x23];
}

// PM2.5 → color category index (0-7) — must match main-thread _pm25ColorCat
function pm25ColorCat(v) {
  if (v <= 2.0)  return 0;
  if (v <= 5.0)  return 1;
  if (v <= 9.0)  return 2;
  if (v <= 35.4) return 3;
  if (v <= 55.4) return 4;
  if (v <= 125.4) return 5;
  if (v <= 225.4) return 6;
  return 7;
}

const BAND_MIDS = [1.0, 3.5, 7.0, 22.2, 45.4, 90.4, 175.4, 250.0];

self.onmessage = function(e) {
  const { sensors, gw, gh, cellSize, cutoffSq, FIELD_ALPHA, jobId, medianV } = e.data;
  const px = new Uint8ClampedArray(gw * gh * 4);

  // Concordance-weighted IDW. sensors is stride-4: [sx, sy, value, concordance, ...]
  // Density-adaptive background anchor: wBg = wBgBase / cnt.
  const wBgBase = 10 / cutoffSq;
  for (let gy = 0; gy < gh; gy++) {
    const py = (gy + 0.5) * cellSize;
    for (let gx = 0; gx < gw; gx++) {
      const pxx = (gx + 0.5) * cellSize;

      let wSum = 0, vSum = 0, minD2 = Infinity, cnt = 0;
      for (let i = 0; i < sensors.length; i += 4) {
        const dx = pxx - sensors[i];
        const dy = py  - sensors[i + 1];
        const d2 = dx * dx + dy * dy;
        if (d2 > cutoffSq) continue;
        cnt++;
        if (d2 < minD2) minD2 = d2;
        const c = sensors[i + 3]; // concordance
        if (d2 < 1) { wSum = 1e9 * c; vSum = sensors[i + 2] * 1e9 * c; minD2 = 0; break; }
        const w = c / d2;
        wSum += w;
        vSum += w * sensors[i + 2];
      }

      const off = (gy * gw + gx) * 4;
      if (wSum === 0) {
        px[off] = 0; px[off + 1] = 0; px[off + 2] = 0; px[off + 3] = 0;
      } else {
        const wBg = wBgBase / (cnt || 1);
        const val = (vSum + wBg * medianV) / (wSum + wBg);
        const edgeFade = 1 - Math.sqrt(minD2 / cutoffSq);
        const alpha = Math.round(FIELD_ALPHA * Math.min(1, edgeFade * 2));
        const cat = pm25ColorCat(val);
        const rgb = pm25ToRgb(BAND_MIDS[cat]);
        px[off]     = (rgb[0] * 217) >> 8;
        px[off + 1] = (rgb[1] * 217) >> 8;
        px[off + 2] = (rgb[2] * 217) >> 8;
        px[off + 3] = alpha;
      }
    }
  }

  // ── Gaussian blur (radius 2) to soften jagged band edges ──
  const BLUR_R = 2;
  const tmp = new Uint8ClampedArray(px.length);
  // Horizontal pass
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      let rr = 0, gg = 0, bb = 0, aa = 0, ww = 0;
      for (let dx = -BLUR_R; dx <= BLUR_R; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx >= gw) continue;
        const off = (y * gw + nx) * 4;
        if (px[off + 3] === 0) continue;
        const g = 1.0 / (1 + dx * dx);
        rr += px[off] * g; gg += px[off+1] * g; bb += px[off+2] * g; aa += px[off+3] * g;
        ww += g;
      }
      const off = (y * gw + x) * 4;
      if (ww > 0) { tmp[off] = rr/ww; tmp[off+1] = gg/ww; tmp[off+2] = bb/ww; tmp[off+3] = aa/ww; }
    }
  }
  // Vertical pass
  for (let x = 0; x < gw; x++) {
    for (let y = 0; y < gh; y++) {
      let rr = 0, gg = 0, bb = 0, aa = 0, ww = 0;
      for (let dy = -BLUR_R; dy <= BLUR_R; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= gh) continue;
        const off = (ny * gw + x) * 4;
        if (tmp[off + 3] === 0) continue;
        const g = 1.0 / (1 + dy * dy);
        rr += tmp[off] * g; gg += tmp[off+1] * g; bb += tmp[off+2] * g; aa += tmp[off+3] * g;
        ww += g;
      }
      const off = (y * gw + x) * 4;
      if (ww > 0) { px[off] = rr/ww; px[off+1] = gg/ww; px[off+2] = bb/ww; px[off+3] = aa/ww; }
    }
  }

  self.postMessage({ px, gw, gh, jobId }, [px.buffer]);
};
