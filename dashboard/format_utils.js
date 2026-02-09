function fmtTime(ts) {
  if (!ts) return "—";
  return String(ts).replace(" UTC", "");
}

function sparklineSvg(values, stroke, width = 140, height = 26) {
  const arr = Array.isArray(values) ? values.filter(v => typeof v === "number" && isFinite(v)) : [];
  if (arr.length < 2) {
    return `<svg class="spark" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true"></svg>`;
  }
  const w = width;
  const h = height;
  // AQI is 0..500
  const clampAqi = (v) => clamp(v, 0, 500);
  const n = arr.length;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const x = (n === 1) ? 0 : (i / (n - 1)) * (w - 2) + 1;
    const y = h - 1 - (clampAqi(arr[i]) / 500) * (h - 2);
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  const col = safeHex(stroke);
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">` +
    `<polyline fill="none" stroke="${col}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="${pts.join(" ")}" />` +
    `</svg>`;
}

function parseUtcMs(t) {
  if (!t) return null;
  const s0 = String(t).trim();
  if (!s0) return null;

  // Prefer a strict parser for common non-ISO formats (notably Safari can reject them).
  // Supports:
  // - "YYYY-MM-DD HH:MM:SS UTC"
  // - "YYYY-MM-DDTHH:MM:SSZ" (and with optional milliseconds)
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})[ T]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,3}))?(?:\s*(Z|UTC))?$/i.exec(s0);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const hour = Number(m[4]);
    const minute = Number(m[5]);
    const sec = Number(m[6]);
    const msPart = m[7] ? Number(String(m[7]).padEnd(3, "0")) : 0;
    if ([year, month, day, hour, minute, sec, msPart].every(n => isFinite(n))) {
      const ms = Date.UTC(year, month - 1, day, hour, minute, sec, msPart);
      return isFinite(ms) ? ms : null;
    }
  }

  // Fallback: try Date.parse with normalization.
  // "YYYY-MM-DD HH:MM:SS UTC" -> "YYYY-MM-DDTHH:MM:SSZ"
  const s1 = s0.replace(/\s+UTC$/i, "Z").replace(" ", "T");
  let ms = Date.parse(s1);
  if (!isFinite(ms)) ms = Date.parse(s0);
  return isFinite(ms) ? ms : null;
}

function formatTagValue(v) {
  if (v == null) return "";
  if (typeof v === "number" && isFinite(v)) {
    // If the value is already an integer, display without decimals
    if (Number.isInteger(v)) return String(v);
    // Show 1 decimal place for values < 10, integers for larger values
    if (v < 10) return v.toFixed(1);
    return String(Math.round(v));
  }
  const s = String(v).trim();
  if (!s) return "";
  const n = Number(s);
  if (isFinite(n)) {
    if (Number.isInteger(n)) return String(n);
    if (n < 10) return n.toFixed(1);
    return String(Math.round(n));
  }
  return s;
}
