/**
 * Web Worker for PurpleAir scalar field IDW computation.
 * Offloads the O(gridCells × sensors) interpolation off the main thread
 * so scrubbing never blocks the UX.
 */

// PM2.5 → [r,g,b] with continuous interpolation — must match main-thread _pm25ToRgbSmooth
function pm25ToRgbSmooth(v) {
  const stops = [
    [0,    0x00,0xFF,0xFF],
    [2.0,  0x00,0xFF,0xFF],
    [5.0,  0x00,0xCC,0xFF],
    [9.0,  0x00,0xE4,0x00],
    [35.4, 0xFF,0xFF,0x00],
    [55.4, 0xFF,0x7E,0x00],
    [125.4,0xFF,0x00,0x00],
    [225.4,0x8F,0x3F,0x97],
    [500,  0x7E,0x00,0x23]
  ];
  if (v <= stops[0][0]) return [stops[0][1], stops[0][2], stops[0][3]];
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const t = (v - stops[i-1][0]) / (stops[i][0] - stops[i-1][0]);
      return [
        Math.round(stops[i-1][1] + t * (stops[i][1] - stops[i-1][1])),
        Math.round(stops[i-1][2] + t * (stops[i][2] - stops[i-1][2])),
        Math.round(stops[i-1][3] + t * (stops[i][3] - stops[i-1][3]))
      ];
    }
  }
  const last = stops[stops.length - 1];
  return [last[1], last[2], last[3]];
}

self.onmessage = function(e) {
  const { sensors, gw, gh, cellSize, cutoffSq, twoSigmaSq, FIELD_ALPHA, jobId } = e.data;
  const px = new Uint8ClampedArray(gw * gh * 4);

  // Gaussian-kernel IDW with weight-sum fading.
  for (let gy = 0; gy < gh; gy++) {
    const py = (gy + 0.5) * cellSize;
    for (let gx = 0; gx < gw; gx++) {
      const pxx = (gx + 0.5) * cellSize;

      let wSum = 0, vSum = 0;
      for (let i = 0; i < sensors.length; i += 3) {
        const dx = pxx - sensors[i];
        const dy = py  - sensors[i + 1];
        const d2 = dx * dx + dy * dy;
        if (d2 > cutoffSq) continue;
        const w = Math.exp(-d2 / twoSigmaSq);
        wSum += w;
        vSum += w * sensors[i + 2];
      }

      const off = (gy * gw + gx) * 4;
      if (wSum < 0.001) {
        px[off] = 0; px[off + 1] = 0; px[off + 2] = 0; px[off + 3] = 0;
      } else {
        const fade = Math.min(1, wSum * 2);
        const alpha = Math.round(FIELD_ALPHA * fade);
        const val = vSum / wSum;
        const rgb = pm25ToRgbSmooth(val);
        px[off]     = rgb[0];
        px[off + 1] = rgb[1];
        px[off + 2] = rgb[2];
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
