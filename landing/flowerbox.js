/* funstuff.app — 3D FlowerBox screensaver (Windows 95 homage)
   Ported from kevin-shannon/3D-FlowerBox (WebGL) to Canvas 2D software renderer.
   A morphing cube↔sphere bounces inside the viewport with soft Phong lighting. */
(function () {
  "use strict";

  window.FlowerBoxScreensaver = function (canvas) {
    var ctx = canvas.getContext("2d");
    var W, H, aspect;
    var animId;
    var stopped = false;

    /* ── Morph / motion state ── */
    var time = 0.625;
    var dt = 0.01;
    var posX = 0, posY = 0;
    /* 45-degree movement, random quadrant */
    var speed = 0.008;
    var speedX = (Math.random() < 0.5 ? -1 : 1) * speed;
    var speedY = (Math.random() < 0.5 ? -1 : 1) * speed;
    var maxX, maxY;
    var speedR = 88;
    var sz = 0.65;

    /* ── Subdivision ── */
    var SUBDIV = 13;

    /* ── Face definitions: orientation angles (degrees) + color ── */
    var FACES = [
      { rx:   0, ry:   0, color: [0, 1, 1] },   /* front  — cyan    */
      { rx:   0, ry:  90, color: [1, 0, 1] },   /* left   — magenta */
      { rx:   0, ry: 180, color: [1, 1, 0] },   /* back   — yellow  */
      { rx:   0, ry: 270, color: [0, 0, 1] },   /* right  — blue    */
      { rx:  90, ry:   0, color: [1, 0, 0] },   /* top    — red     */
      { rx: 270, ry:   0, color: [0, 1, 0] },   /* bottom — green   */
    ];

    /* ── Light (original places light at origin in eye-space, which is the camera) ── */
    var lightPos = [0, 0, 5];
    var ambientK = 0.2;
    var diffuseK = 0.85;
    var specularK = 0.15;
    var shininess = 8;

    /* ── Vector helpers ── */
    function v3sub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
    function v3add(a, b) { return [a[0]+b[0], a[1]+b[1], a[2]+b[2]]; }
    function v3scale(a, s) { return [a[0]*s, a[1]*s, a[2]*s]; }
    function v3dot(a, b) { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
    function v3cross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
    function v3len(a) { return Math.sqrt(a[0]*a[0]+a[1]*a[1]+a[2]*a[2]); }
    function v3norm(a) { var l = v3len(a); return l > 0 ? [a[0]/l,a[1]/l,a[2]/l] : [0,0,0]; }
    function v3mix(a, b, t) { return [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t]; }

    /* ── 4×4 matrix (column-major, OpenGL convention) ── */
    /* Index: col*4 + row.  M[row][col] = m[col*4+row] */
    function mat4() { var m = new Float64Array(16); m[0]=m[5]=m[10]=m[15]=1; return m; }

    /* Column-major A*B */
    function m4mul(A, B) {
      var r = new Float64Array(16);
      for (var col = 0; col < 4; col++)
        for (var row = 0; row < 4; row++)
          r[col*4+row] = A[0*4+row]*B[col*4+0] + A[1*4+row]*B[col*4+1]
                       + A[2*4+row]*B[col*4+2] + A[3*4+row]*B[col*4+3];
      return r;
    }

    var DEG = Math.PI / 180;

    function m4rotX(a) {
      var c = Math.cos(a), s = Math.sin(a), m = mat4();
      m[5]=c; m[6]=s; m[9]=-s; m[10]=c; return m;
    }
    function m4rotY(a) {
      var c = Math.cos(a), s = Math.sin(a), m = mat4();
      m[0]=c; m[2]=-s; m[8]=s; m[10]=c; return m;
    }
    function m4rotZ(a) {
      var c = Math.cos(a), s = Math.sin(a), m = mat4();
      m[0]=c; m[1]=s; m[4]=-s; m[5]=c; return m;
    }
    function m4scale(sx, sy, sz2) {
      var m = mat4(); m[0]=sx; m[5]=sy; m[10]=sz2; return m;
    }
    function m4translate(tx, ty, tz) {
      var m = mat4(); m[12]=tx; m[13]=ty; m[14]=tz; return m;
    }

    /* M * point (homogeneous w=1) */
    function m4xPt(m, p) {
      return [
        m[0]*p[0] + m[4]*p[1] + m[8]*p[2]  + m[12],
        m[1]*p[0] + m[5]*p[1] + m[9]*p[2]  + m[13],
        m[2]*p[0] + m[6]*p[1] + m[10]*p[2] + m[14]
      ];
    }
    /* M * direction (w=0, no translation) */
    function m4xDir(m, n) {
      return v3norm([
        m[0]*n[0] + m[4]*n[1] + m[8]*n[2],
        m[1]*n[0] + m[5]*n[1] + m[9]*n[2],
        m[2]*n[0] + m[6]*n[1] + m[10]*n[2]
      ]);
    }

    /* ── Generate surface grid (matches original geometry.js) ── */
    function generateSurface(t) {
      var morph = -Math.abs(1.6 * (t % 7.5) - 6) + 5;
      var n = SUBDIV;
      var verts = [];
      var norms = [];
      var dx = 2 / (n - 1);

      for (var i = 0; i < n; i++) {
        for (var j = 0; j < n; j++) {
          var x = -1 + i * dx;
          var y = -1 + j * dx;
          var flat = [x, y, 1.0];
          var sph = v3norm([x, y, 1.0]);
          verts.push(v3mix(flat, sph, morph));
        }
      }

      /* Normals via central differences (matches original) */
      for (var ii = 0; ii < n; ii++) {
        for (var jj = 0; jj < n; jj++) {
          var v = verts[ii * n + jj];
          var px, py;
          if (jj === 0)        px = v3sub(verts[ii*n+jj+1], v);
          else if (jj === n-1) px = v3sub(v, verts[ii*n+jj-1]);
          else px = v3add(v3sub(verts[ii*n+jj+1], v), v3sub(v, verts[ii*n+jj-1]));
          if (ii === 0)        py = v3sub(verts[(ii+1)*n+jj], v);
          else if (ii === n-1) py = v3sub(v, verts[(ii-1)*n+jj]);
          else py = v3add(v3sub(verts[(ii+1)*n+jj], v), v3sub(v, verts[(ii-1)*n+jj]));
          norms.push(v3norm(v3cross(py, px)));
        }
      }

      /* Triangle indices */
      var idx = [];
      for (var a = 0; a < n-1; a++) {
        for (var b = 0; b < n-1; b++) {
          var tl = a*n+b, tr = a*n+b+1, br = (a+1)*n+b+1, bl = (a+1)*n+b;
          idx.push(tl, tr, br);
          idx.push(tl, br, bl);
        }
      }
      return { verts: verts, norms: norms, idx: idx };
    }

    /* ── Project 3D → 2D (proper perspective with aspect) ── */
    var eyeZ = 5;
    var fovY = 50 * DEG;

    function projectPt(p) {
      var z = eyeZ - p[2];
      if (z < 0.01) z = 0.01;
      var fy = (H / 2) / Math.tan(fovY / 2);
      var fx = fy; /* aspect handled by scaling x by H/W */
      return { x: W/2 + p[0] * fx / z, y: H/2 - p[1] * fy / z, z: z };
    }

    /* ── Phong shading ── */
    function shade(normal, worldPos, faceColor) {
      var L = v3norm(v3sub(lightPos, worldPos));
      var NdotL = Math.max(0, v3dot(normal, L));
      var V = v3norm(v3sub([0, 0, eyeZ], worldPos));
      var R = v3sub(v3scale(normal, 2 * v3dot(normal, L)), L);
      var spec = Math.pow(Math.max(0, v3dot(R, V)), shininess);
      var r = faceColor[0] * (ambientK + diffuseK * NdotL) + specularK * spec;
      var g = faceColor[1] * (ambientK + diffuseK * NdotL) + specularK * spec;
      var b = faceColor[2] * (ambientK + diffuseK * NdotL) + specularK * spec;
      return "rgb(" + Math.round(Math.min(255, r*255)) + "," +
                      Math.round(Math.min(255, g*255)) + "," +
                      Math.round(Math.min(255, b*255)) + ")";
    }

    /* ── Init ── */
    function init() {
      W = canvas.width = canvas.offsetWidth * (window.devicePixelRatio > 1 ? 1.5 : 1);
      H = canvas.height = canvas.offsetHeight * (window.devicePixelRatio > 1 ? 1.5 : 1);
      canvas.style.width = canvas.offsetWidth + "px";
      canvas.style.height = canvas.offsetHeight + "px";
      aspect = W / H;
      /* Compute visible world-space half-extents at z=0.
         In projection: screenX = W/2 + x * fy / eyeZ
         So visible half-width in world = (W/2) * eyeZ / fy
         where fy = (H/2) / tan(fovY/2)  →  visible half-height = eyeZ * tan(fovY/2) */
      var visHalfY = eyeZ * Math.tan(fovY / 2);
      var visHalfX = visHalfY * (W / H);
      /* Subtract shape radius so it stays on screen with room to bounce */
      maxX = visHalfX - sz * 1.3;
      maxY = visHalfY - sz * 1.3;
      /* Randomize starting position within bounds */
      posX = (Math.random() * 2 - 1) * maxX * 0.6;
      posY = (Math.random() * 2 - 1) * maxY * 0.6;
    }

    /* ── Render ── */
    function render() {
      if (stopped) return;

      time += dt;
      posX += speedX;
      posY += speedY;
      if (posX > maxX)  { posX = maxX;  speedX = -Math.abs(speedX); }
      if (posX < -maxX) { posX = -maxX; speedX =  Math.abs(speedX); }
      if (posY > maxY)  { posY = maxY;  speedY = -Math.abs(speedY); }
      if (posY < -maxY) { posY = -maxY; speedY =  Math.abs(speedY); }

      var surf = generateSurface(time);

      /* Build model matrix: uniform scale, then rotate.
         Aspect correction is in the projection, not the model. */
      var mBase = m4scale(sz, sz, sz);
      mBase = m4mul(mBase, m4rotY(speedR * time * DEG));
      mBase = m4mul(mBase, m4rotZ(speedR * time * DEG));

      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);

      var tris = [];

      for (var fi = 0; fi < FACES.length; fi++) {
        var face = FACES[fi];

        /* Per-face: mBase * rotX_face * rotY_face, then translate * that */
        var mFace = m4mul(mBase, m4rotX(face.rx * DEG));
        mFace = m4mul(mFace, m4rotY(face.ry * DEG));
        mFace = m4mul(m4translate(posX, posY, 0), mFace);

        /* Transform vertices & normals */
        var tv = new Array(surf.verts.length);
        var tn = new Array(surf.norms.length);
        for (var vi = 0; vi < surf.verts.length; vi++) {
          tv[vi] = m4xPt(mFace, surf.verts[vi]);
          tn[vi] = m4xDir(mFace, surf.norms[vi]);
        }

        /* Build & cull triangles */
        for (var ti = 0; ti < surf.idx.length; ti += 3) {
          var i0 = surf.idx[ti], i1 = surf.idx[ti+1], i2 = surf.idx[ti+2];
          var p0 = tv[i0], p1 = tv[i1], p2 = tv[i2];

          var centroid = v3scale(v3add(v3add(p0, p1), p2), 1/3);
          var triN = v3norm(v3cross(v3sub(p1, p0), v3sub(p2, p0)));
          var viewDir = v3sub([0, 0, eyeZ], centroid);
          if (v3dot(triN, viewDir) > 0) continue;

          var avgN = v3norm(v3add(v3add(tn[i0], tn[i1]), tn[i2]));
          var color = shade(avgN, centroid, face.color);

          var s0 = projectPt(p0), s1 = projectPt(p1), s2 = projectPt(p2);
          tris.push({ s0: s0, s1: s1, s2: s2, color: color, z: (s0.z+s1.z+s2.z)/3 });
        }
      }

      /* Depth sort — farthest first (painter's algorithm) */
      tris.sort(function (a, b) { return b.z - a.z; });

      for (var di = 0; di < tris.length; di++) {
        var t = tris[di];
        ctx.fillStyle = t.color;
        ctx.strokeStyle = t.color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(t.s0.x, t.s0.y);
        ctx.lineTo(t.s1.x, t.s1.y);
        ctx.lineTo(t.s2.x, t.s2.y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }

      animId = requestAnimationFrame(render);
    }

    init();
    animId = requestAnimationFrame(render);

    return {
      stop: function () { stopped = true; if (animId) cancelAnimationFrame(animId); },
      resize: function () { if (!stopped) init(); },
    };
  };
})();
