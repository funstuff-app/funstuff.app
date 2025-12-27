const test = require("node:test");
const assert = require("node:assert/strict");

// NOTE: This test suite is intentionally written before the engine exists.
// It should fail until we implement the navigation engine and wire it in.

test("map_nav_engine exports required API", () => {
  // eslint-disable-next-line global-require
  const eng = require("../map_nav_engine.js");
  assert.equal(typeof eng.createProjector, "function");
  assert.equal(typeof eng.zoomAroundScreenPoint, "function");
  assert.equal(typeof eng.panCenterByPixels, "function");
});

test("zoomAroundScreenPoint keeps the anchor lat/lon stable", () => {
  // eslint-disable-next-line global-require
  const eng = require("../map_nav_engine.js");
  const proj = eng.createProjector({ tileSize: 256 });

  const viewport = { w: 800, h: 600 };
  const center = { lat: 40.7608, lon: -111.8910 };
  const zoom0 = 12;
  const sx = 420;
  const sy = 310;

  const anchor0 = eng.screenPointToLatLon({ center, zoom: zoom0, sx, sy, viewport, projector: proj });
  const r = eng.zoomAroundScreenPoint({ center, zoom: zoom0, newZoom: 13.25, sx, sy, viewport, projector: proj });
  const anchor1 = eng.screenPointToLatLon({ center: r.center, zoom: r.zoom, sx, sy, viewport, projector: proj });

  assert.ok(Math.abs(anchor0.lat - anchor1.lat) < 1e-6);
  assert.ok(Math.abs(anchor0.lon - anchor1.lon) < 1e-6);
});

test("panCenterByPixels moves the center consistently", () => {
  // eslint-disable-next-line global-require
  const eng = require("../map_nav_engine.js");
  const proj = eng.createProjector({ tileSize: 256 });
  const center0 = { lat: 40.7608, lon: -111.8910 };
  const zoom = 12;
  const r = eng.panCenterByPixels({ center: center0, zoom, dx: 100, dy: 50, pixelToWorldScale: 0.65, projector: proj });
  assert.ok(r.center.lat !== center0.lat || r.center.lon !== center0.lon);
});

test("sampleAlongPoints interpolates linearly across segments", () => {
  // eslint-disable-next-line global-require
  const eng = require("../map_nav_engine.js");
  const pts = [{ lat: 0, lon: 0 }, { lat: 0, lon: 10 }];
  const mid = eng.sampleAlongPoints(pts, 0.5);
  assert.ok(mid);
  assert.equal(mid.lat, 0);
  assert.equal(mid.lon, 5);
});


