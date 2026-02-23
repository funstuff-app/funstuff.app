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

    /* "classic" = near-frontal, filling viewport like Win95, "rotate" = orbiting */
    var mode = (opts && opts.mode) || "classic";

    /* Classic-mode: 3/4 view with close camera so pipes fill the
       viewport and near ones look huge — like the original screensaver */
    var CLASSIC_RY = 0.55;
    var CLASSIC_RX = 0.45;

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

    /* Fixed world-space light direction (upper-left-front), normalized */
    var LIGHT = [0.48, -0.64, 0.6];

    /* For a cylinder along axis D with light L:
       brightness = sqrt(1 - dot(D,L)^2)
       This is how much light hits the curved surface.
       Precompute for all 6 directions. */
    var DIR_BRIGHT = [];
    for (var _di = 0; _di < 6; _di++) {
      var _d = DIRS[_di];
      var _dot = _d[0] * LIGHT[0] + _d[1] * LIGHT[1] + _d[2] * LIGHT[2];
      DIR_BRIGHT.push(Math.sqrt(1 - _dot * _dot));
    }

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
      var testCamD = Math.max(GX, GY, GZ) * GRID_SPACING * 0.8;
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
      var cf = fitCamera(CLASSIC_RY, CLASSIC_RX, -1.0);
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

    function drawBall(px, py, sz, zd, c) {
      var r = sz * 0.22;
      if (r < 2) r = 2;
      var fog = Math.max(0.35, Math.min(1.0, 1.0 - zd * 0.04));
      var g = ctx.createRadialGradient(px - r * 0.3, py - r * 0.3, r * 0.05, px, py, r);
      g.addColorStop(0, rgb(c, 1.8 * fog));
      g.addColorStop(0.4, rgb(c, 1.0 * fog));
      g.addColorStop(1, rgb(c, 0.3 * fog));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
    }

    function drawSegLine(pf, pt, c, bright) {
      /* Per-endpoint radius for perspective-correct tapering */
      var rf = pf.s * 0.15;
      var rt = pt.s * 0.15;
      if (rf < 1.5) rf = 1.5;
      if (rt < 1.5) rt = 1.5;

      var dx = pt.x - pf.x;
      var dy = pt.y - pf.y;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      /* Unit vectors: along the segment and perpendicular */
      var tx = dx / len;
      var ty = dy / len;
      var nx = -ty;
      var ny = tx;

      /* Extend each end slightly along the segment direction to overlap
         adjacent segments and hide seams */
      var ext = Math.max(rf, rt) * 0.4;
      var fx = pf.x - tx * ext, fy = pf.y - ty * ext;
      var ex = pt.x + tx * ext, ey = pt.y + ty * ext;

      /* Depth fog: attenuate far segments */
      var avgZ = (pf.z + pt.z) / 2;
      var fog = Math.max(0.35, Math.min(1.0, 1.0 - avgZ * 0.04));
      var b = bright * fog;

      /* Cross-section gradient modulated by computed brightness */
      var avgR = (rf + rt) / 2;
      var grad = ctx.createLinearGradient(
        fx + nx * avgR, fy + ny * avgR,
        fx - nx * avgR, fy - ny * avgR
      );
      grad.addColorStop(0, rgb(c, 0.15 * b));
      grad.addColorStop(0.25, rgb(c, 0.6 * b));
      grad.addColorStop(0.5, rgb(c, 1.4 * b));
      grad.addColorStop(0.75, rgb(c, 0.6 * b));
      grad.addColorStop(1, rgb(c, 0.15 * b));

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(fx + nx * rf, fy + ny * rf);
      ctx.lineTo(ex + nx * rt, ey + ny * rt);
      ctx.lineTo(ex - nx * rt, ey - ny * rt);
      ctx.lineTo(fx - nx * rf, fy - ny * rf);
      ctx.closePath();
      ctx.fill();
    }

    function draw() {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);

      /* Collect ALL drawable items from all pipes, then depth-sort */
      var items = []; /* { type, z, ... } */

      for (var i = 0; i < pipes.length; i++) {
        var pObj = pipes[i];
        var c = pObj.color;
        var sIds = pObj.segs;

        for (var j = 0; j < sIds.length; j++) {
          var s = segments[sIds[j]];
          var pf = project(s.fx, s.fy, s.fz);

          if (s.cap) {
            /* Bias ball z closer to camera so it draws after adjacent segments */
            items.push({ type: "ball", p: pf, c: c, z: pf.z - 0.5 });
            continue;
          }

          var pt = project(s.tx, s.ty, s.tz);
          var midZ = (pf.z + pt.z) / 2;
          var bright = DIR_BRIGHT[s.dir] || 0.7;
          items.push({ type: "seg", pf: pf, pt: pt, c: c, z: midZ, bright: bright });

          if (s.elbow) {
            items.push({ type: "ball", p: pf, c: c, z: pf.z - 0.5 });
          }
        }
      }

      /* Sort farthest first (painter's algorithm) */
      items.sort(function (a, b) { return b.z - a.z; });

      for (var k = 0; k < items.length; k++) {
        var it = items[k];
        if (it.type === "seg") {
          drawSegLine(it.pf, it.pt, it.c, it.bright);
        } else {
          drawBall(it.p.x, it.p.y, it.p.s, it.p.z, it.c);
        }
      }
    }

    /* ── Main loop ── */

    var paused = false;

    function loop(ts) {
      if (stopped) return;
      if (paused) return;
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
      pause: function () {
        paused = true;
        if (animId) { cancelAnimationFrame(animId); animId = null; }
      },
      resume: function () {
        if (stopped) return;
        paused = false;
        lastTs = 0;
        stepAccum = 0;
        /* Reinit canvas dimensions in case they were invalidated */
        var dpr = window.devicePixelRatio > 1 ? 1.5 : 1;
        var ow = canvas.offsetWidth;
        var oh = canvas.offsetHeight;
        if (ow && oh) {
          W = canvas.width = ow * dpr;
          H = canvas.height = oh * dpr;
          canvas.style.width = ow + "px";
          canvas.style.height = oh + "px";
          var cf = fitCamera(CLASSIC_RY, CLASSIC_RX, -0.4);
          _classicCamD = cf.camD;
          _classicFov = cf.fov;
          var of2 = fitCamera(rotY, rotX, 0.12);
          _orbitCamD = of2.camD;
          _orbitFov = of2.fov;
        }
        animId = requestAnimationFrame(loop);
      },
      resize: function () { if (!stopped && !paused) init(); },
      setMode: function (m) { mode = m; },
      getMode: function () { return mode; },
    };
  };
})();
