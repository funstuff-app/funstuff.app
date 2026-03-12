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

self.onmessage = function(e) {
  const { sensors, gw, gh, cellSize, cutoffSq, FIELD_ALPHA, jobId } = e.data;
  const px = new Uint8ClampedArray(gw * gh * 4);

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
        if (d2 < 1) { wSum = 1; vSum = sensors[i + 2]; break; }
        const w = 1 / d2;
        wSum += w;
        vSum += w * sensors[i + 2];
      }

      const off = (gy * gw + gx) * 4;
      if (wSum === 0) {
        px[off] = 0; px[off + 1] = 0; px[off + 2] = 0; px[off + 3] = 0;
      } else {
        const rgb = pm25ToRgb(vSum / wSum);
        px[off]     = (rgb[0] * 217) >> 8;
        px[off + 1] = (rgb[1] * 217) >> 8;
        px[off + 2] = (rgb[2] * 217) >> 8;
        px[off + 3] = FIELD_ALPHA;
      }
    }
  }

  self.postMessage({ px, gw, gh, jobId }, [px.buffer]);
};
