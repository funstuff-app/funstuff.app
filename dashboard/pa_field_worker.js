/**
 * Web Worker for PurpleAir scalar field IDW computation.
 * Offloads the O(gridCells × sensors) interpolation off the main thread
 * so scrubbing never blocks the UX.
 */

// PM2.5 → [r,g,b] with continuous interpolation — must match main-thread _pm25ToRgbSmooth
// Stops at band midpoints so field colors match sensor dot palette.
function pm25ToRgbSmooth(v) {
  const stops = [
    [0,     0x00,0xFF,0xFF],
    [1.0,   0x00,0xFF,0xFF],  // cyan   – mid of 0–2
    [3.5,   0x00,0xCC,0xFF],  // lt-blue– mid of 2–5
    [7.0,   0x00,0xE4,0x00],  // green  – mid of 5–9
    [22.2,  0xFF,0xFF,0x00],  // yellow – mid of 9–35.4
    [45.4,  0xFF,0x7E,0x00],  // orange – mid of 35.4–55.4
    [90.4,  0xFF,0x00,0x00],  // red    – mid of 55.4–125.4
    [175.4, 0x8F,0x3F,0x97],  // purple – mid of 125.4–225.4
    [250.0, 0x7E,0x00,0x23],  // maroon – mid of 225.4+
    [500,   0x7E,0x00,0x23]
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
  const { sensors, gw, gh, cellSize, cutoffSq, twoSigmaSq, FIELD_ALPHA, blurRadius, jobId } = e.data;
  const px = new Uint8ClampedArray(gw * gh * 4);

  // KNN-IDW interpolation with Gaussian alpha.
  const K = 8;
  const eps2 = 1;
  const kD2  = new Float64Array(K);
  const kIdx = new Int32Array(K);
  for (let gy = 0; gy < gh; gy++) {
    const py = (gy + 0.5) * cellSize;
    for (let gx = 0; gx < gw; gx++) {
      const pxx = (gx + 0.5) * cellSize;

      let kCount = 0;
      for (let i = 0; i < sensors.length; i += 3) {
        const dx = pxx - sensors[i];
        const dy = py  - sensors[i + 1];
        const d2 = dx * dx + dy * dy;
        if (d2 > cutoffSq) continue;
        if (kCount < K) {
          kD2[kCount] = d2;
          kIdx[kCount] = i;
          kCount++;
        } else {
          let maxJ = 0;
          for (let j = 1; j < K; j++) { if (kD2[j] > kD2[maxJ]) maxJ = j; }
          if (d2 < kD2[maxJ]) {
            kD2[maxJ] = d2;
            kIdx[maxJ] = i;
          }
        }
      }

      let wSum = 0, vSum = 0, gSum = 0;
      for (let j = 0; j < kCount; j++) {
        const d2 = kD2[j];
        const si = kIdx[j];
        const t = d2 / cutoffSq;
        const envelope = (1 - t) * (1 - t);
        const w = envelope / (d2 + eps2);
        wSum += w;
        vSum += w * sensors[si + 2];
        gSum += Math.exp(-d2 / twoSigmaSq);
      }

      const off = (gy * gw + gx) * 4;
      if (wSum < 1e-12) {
        px[off] = 0; px[off + 1] = 0; px[off + 2] = 0; px[off + 3] = 0;
      } else {
        const fade = Math.min(1, gSum * 2);
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

  // ── Gaussian blur to soften jagged band edges ──
  const BLUR_R = blurRadius != null ? blurRadius : 2;
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
