/* funstuff.app — 3D Pipes screensaver (Windows 95 homage)
   Two camera modes: classic (fixed perspective, fills viewport) and orbiting */
(function () {
  "use strict";

  window.PipesScreensaver = function (canvas, opts) {
    var ctx = canvas.getContext("2d");
    var W, H;
    var grid, segments, pipe, animId, lastTs, stepAccum;
    var pipes; /* array of pipe objects: { color, segs: [indices into segments] } */
    var pipeId;
    var colorIdx;
    var stopped = false;
    var STEP_MS = 42;
    var MAX_SEGS = 600;

    /* Grid dimensions and spacing */
    var GX = 9, GY = 7, GZ = 9;
    var GRID_SPACING = 2.0;  /* world units between cells — controls how spread out pipes are */

    /* Camera */
    var cx, cy, cz;
    var rotY = 0.6;
    var rotX = 0.55;     /* positive = looking down from above */
    var PIPE_R = 0.22;
    var JOINT_R = 0.34;

    /* "classic" = fixed perspective filling viewport, "rotate" = orbiting */
    var mode = (opts && opts.mode) || "classic";

    /* Classic-mode fixed angles (like the Win95 screensaver — slight perspective,
       looking down from above-right, zoomed in so pipes fill the whole window) */
    var CLASSIC_RY = 0.62;
    var CLASSIC_RX = 0.50;

    var PALETTE = [
      [220, 40, 40],
      [30, 160, 30],
      [50, 50, 210],
      [210, 170, 30],
      [170, 50, 170],
      [30, 170, 170],
      [180, 180, 180],
    ];

    /* 6 directions: +X, -X, +Y, -Y, +Z, -Z */
    var DIRS = [
      [1, 0, 0], [-1, 0, 0],
      [0, 1, 0], [0, -1, 0],
      [0, 0, 1], [0, 0, -1],
    ];

    function rgb(c, f) {
      f = f === undefined ? 1 : f;
      return "rgb(" +
        Math.round(Math.min(255, c[0] * f)) + "," +
        Math.round(Math.min(255, c[1] * f)) + "," +
        Math.round(Math.min(255, c[2] * f)) + ")";
    }

    /* Shared perspective projection — uses current rotY/rotX or the classic angles */
    function projectWith(gx, gy, gz, ry, rx, camD, fovVal) {
      var x = gx - cx, y = gy - cy, z = gz - cz;
      var cosY = Math.cos(ry), sinY = Math.sin(ry);
      var x1 = x * cosY - z * sinY;
      var z1 = x * sinY + z * cosY;
      var cosX = Math.cos(rx), sinX = Math.sin(rx);
      var y1 = y * cosX - z1 * sinX;
      var z2 = y * sinX + z1 * cosX;
      var d = camD + z2;
      if (d < 0.5) d = 0.5;
      var scale = fovVal / d;
      return { x: W / 2 + x1 * scale, y: H / 2 + y1 * scale, z: z2, s: scale };
    }

    /* Compute fov/camDist that makes grid fill the viewport for given angles */
    var _classicCamD, _classicFov, _orbitCamD, _orbitFov;

    function fitCamera(ry, rx, margin) {
      /* project all 8 corners with a test fov, then scale to fill */
      var testCamD = Math.max(GX, GY, GZ) * GRID_SPACING * 1.6;
      var testFov = 100;
      var minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
      for (var i = 0; i < 8; i++) {
        var gx = ((i & 1) ? GX - 1 : 0) * GRID_SPACING;
        var gy = ((i & 2) ? GY - 1 : 0) * GRID_SPACING;
        var gz = ((i & 4) ? GZ - 1 : 0) * GRID_SPACING;
        var p = projectWith(gx, gy, gz, ry, rx, testCamD, testFov);
        /* p.x = W/2 + x1 * scale; we want the x1*scale part */
        var sx = p.x - W / 2;
        var sy = p.y - H / 2;
        if (sx < minX) minX = sx;
        if (sx > maxX) maxX = sx;
        if (sy < minY) minY = sy;
        if (sy > maxY) maxY = sy;
      }
      var extentX = maxX - minX || 1;
      var extentY = maxY - minY || 1;
      var scaleNeeded = Math.min(
        (W * (1 - margin)) / extentX,
        (H * (1 - margin)) / extentY
      );
      return { camD: testCamD, fov: testFov * scaleNeeded };
    }

    function project(gx, gy, gz) {
      var wx = gx * GRID_SPACING, wy = gy * GRID_SPACING, wz = gz * GRID_SPACING;
      if (mode === "classic") {
        return projectWith(wx, wy, wz, CLASSIC_RY, CLASSIC_RX, _classicCamD, _classicFov);
      } else {
        return projectWith(wx, wy, wz, rotY, rotX, _orbitCamD, _orbitFov);
      }
    }

    function init() {
      var dpr = window.devicePixelRatio > 1 ? 1.5 : 1;
      W = canvas.width = canvas.offsetWidth * dpr;
      H = canvas.height = canvas.offsetHeight * dpr;
      canvas.style.width = canvas.offsetWidth + "px";
      canvas.style.height = canvas.offsetHeight + "px";
      if (!W || !H) return;

      cx = (GX - 1) * GRID_SPACING / 2;
      cy = (GY - 1) * GRID_SPACING / 2;
      cz = (GZ - 1) * GRID_SPACING / 2;

      /* Fit cameras so grid fills the viewport */
      var cf = fitCamera(CLASSIC_RY, CLASSIC_RX, -0.4);
      _classicCamD = cf.camD;
      _classicFov = cf.fov;
      var of = fitCamera(rotY, rotX, 0.12);
      _orbitCamD = of.camD;
      _orbitFov = of.fov;

      grid = new Uint8Array(GX * GY * GZ);
      segments = [];
      pipes = [];
      pipeId = 0;
      colorIdx = (Math.random() * PALETTE.length) | 0;
      pipe = null;
      stepAccum = 0;
      lastTs = 0;
      spawn();
    }

    function gIdx(x, y, z) { return x + y * GX + z * GX * GY; }

    function spawn() {
      for (var t = 0; t < 800; t++) {
        var x = (Math.random() * GX) | 0;
        var y = (Math.random() * GY) | 0;
        var z = (Math.random() * GZ) | 0;
        if (!grid[gIdx(x, y, z)]) {
          var col = PALETTE[colorIdx % PALETTE.length];
          colorIdx++;
          pipeId++;
          pipes.push({ id: pipeId, color: col, segs: [] });
          pipe = {
            x: x, y: y, z: z,
            dir: (Math.random() * 6) | 0,
            color: col,
            len: 0,
            maxLen: 20 + ((Math.random() * 50) | 0),
            prevDir: -1,
            pid: pipeId,
          };
          grid[gIdx(x, y, z)] = 1;
          var si = segments.length;
          segments.push({
            fx: x, fy: y, fz: z, tx: x, ty: y, tz: z,
            dir: pipe.dir, elbow: false, cap: true, color: col, pid: pipeId,
          });
          pipes[pipes.length - 1].segs.push(si);
          return;
        }
      }
      init();
    }

    function step() {
      if (!pipe) return;
      var p = pipe;
      var cands = [];
      for (var d = 0; d < 6; d++) {
        var nx = p.x + DIRS[d][0], ny = p.y + DIRS[d][1], nz = p.z + DIRS[d][2];
        if (nx >= 0 && nx < GX && ny >= 0 && ny < GY && nz >= 0 && nz < GZ && !grid[gIdx(nx, ny, nz)])
          cands.push(d);
      }
      if (!cands.length || p.len >= p.maxLen) {
        var si = segments.length;
        segments.push({
          fx: p.x, fy: p.y, fz: p.z, tx: p.x, ty: p.y, tz: p.z,
          dir: p.dir, elbow: false, cap: true, color: p.color, pid: p.pid,
        });
        var pp = pipes[pipes.length - 1];
        if (pp && pp.id === p.pid) pp.segs.push(si);
        spawn();
        return;
      }
      var nd;
      if (cands.indexOf(p.dir) !== -1 && Math.random() < 0.72) nd = p.dir;
      else nd = cands[(Math.random() * cands.length) | 0];

      var fx = p.x, fy = p.y, fz = p.z;
      p.x += DIRS[nd][0]; p.y += DIRS[nd][1]; p.z += DIRS[nd][2];
      grid[gIdx(p.x, p.y, p.z)] = 1;
      var si2 = segments.length;
      segments.push({
        fx: fx, fy: fy, fz: fz, tx: p.x, ty: p.y, tz: p.z,
        dir: nd,
        elbow: p.prevDir !== -1 && p.prevDir !== nd,
        cap: false, color: p.color, pid: p.pid,
      });
      var pp2 = pipes[pipes.length - 1];
      if (pp2 && pp2.id === p.pid) pp2.segs.push(si2);
      p.prevDir = nd; p.dir = nd; p.len++;
      if (segments.length >= MAX_SEGS) init();
    }

    /* ── Rendering ── */

    function drawBall(px, py, sz, c) {
      var r = sz * 0.22;
      if (r < 2) r = 2;
      var g = ctx.createRadialGradient(px - r * 0.3, py - r * 0.3, r * 0.05, px, py, r);
      g.addColorStop(0, rgb(c, 1.8));
      g.addColorStop(0.4, rgb(c, 1.0));
      g.addColorStop(1, rgb(c, 0.3));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
    }

    function strokePath(pts, style, width) {
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }

    function drawPipeContinuous(pipeObj) {
      var sIds = pipeObj.segs;
      var c = pipeObj.color;
      var pts = [];
      var elbows = [];
      var caps = [];

      for (var i = 0; i < sIds.length; i++) {
        var s = segments[sIds[i]];
        var pf = project(s.fx, s.fy, s.fz);
        if (s.cap) { caps.push(pf); continue; }
        var pt = project(s.tx, s.ty, s.tz);
        if (pts.length === 0) pts.push(pf);
        pts.push(pt);
        if (s.elbow) elbows.push(pf);
      }

      if (pts.length >= 2) {
        var totalS = 0;
        for (var k = 0; k < pts.length; k++) totalS += pts[k].s;
        var avgS = totalS / pts.length;
        var r = avgS * 0.15;
        if (r < 1.5) r = 1.5;

        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        /* 3-pass cylinder shading on the whole continuous path */
        strokePath(pts, rgb(c, 0.3), r * 2);
        strokePath(pts, rgb(c, 0.85), r * 1.5);
        strokePath(pts, rgb(c, 1.5), r * 0.6);
      }

      for (var e = 0; e < elbows.length; e++)
        drawBall(elbows[e].x, elbows[e].y, elbows[e].s, c);
      for (var f = 0; f < caps.length; f++)
        drawBall(caps[f].x, caps[f].y, caps[f].s, c);
    }

    function draw() {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);

      /* Sort whole pipes by average z — farthest first */
      var order = [];
      for (var i = 0; i < pipes.length; i++) {
        var sIds = pipes[i].segs;
        var tz = 0;
        for (var j = 0; j < sIds.length; j++) {
          var s = segments[sIds[j]];
          tz += project(s.fx, s.fy, s.fz).z;
        }
        order.push({ idx: i, z: sIds.length ? tz / sIds.length : 0 });
      }
      order.sort(function (a, b) { return b.z - a.z; });

      for (var k = 0; k < order.length; k++) {
        drawPipeContinuous(pipes[order[k].idx]);
      }
    }

    /* ── Main loop ── */

    function loop(ts) {
      if (stopped) return;
      if (!lastTs) lastTs = ts;
      stepAccum += ts - lastTs;
      lastTs = ts;
      var steps = 0;
      while (stepAccum >= STEP_MS && steps < 4) {
        step(); stepAccum -= STEP_MS; steps++;
      }
      if (mode === "rotate") {
        rotY += 0.0007;
        var of = fitCamera(rotY, rotX, 0.12);
        _orbitCamD = of.camD;
        _orbitFov = of.fov;
      }
      draw();
      animId = requestAnimationFrame(loop);
    }

    init();
    animId = requestAnimationFrame(loop);

    return {
      stop: function () { stopped = true; if (animId) cancelAnimationFrame(animId); },
      resize: function () { if (!stopped) init(); },
      setMode: function (m) { mode = m; },
      getMode: function () { return mode; },
    };
  };
})();
