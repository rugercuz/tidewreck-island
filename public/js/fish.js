// =============================================================
// TIDEWRECK ISLAND - public/js/fish.js
// Procedural fish factory. Pure module: no init, no ctx, no state.
//
//   createFishMesh(fishDef, mutation, scaleMult) -> THREE.Group
//       * sized fishDef.model.size * scaleMult meters (length along Z)
//       * faces +Z, origin at body center
//       * group.userData.update(t) animates body/fins/tentacles + mutation FX
//   createFishIconDataURL(fishDef, mutation) -> 96x96 canvas 2D icon
//
// Everything is built in code. No addons, no external assets.
// Geometry is cached per species, materials per (species, mutation).
// =============================================================
import * as THREE from 'three';
import { MUTATIONS, FISH } from '/shared/constants.js';

// ---------------------------------------------------------------
// tiny math / temps (module scope: zero per-frame allocation)
// ---------------------------------------------------------------
const PI = Math.PI;
const TAU = PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);

const _v3 = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _m3 = new THREE.Matrix3();
const _tp = new THREE.Vector3();
const _ts = new THREE.Vector3();
const _tq = new THREE.Quaternion();
const _te = new THREE.Euler();
const _col = new THREE.Color();

function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rngFor(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// build-time transform helper -> returns the shared matrix, use immediately
function xform(px, py, pz, rx, ry, rz, sx, sy, sz) {
  _te.set(rx || 0, ry || 0, rz || 0);
  _tq.setFromEuler(_te);
  _tp.set(px || 0, py || 0, pz || 0);
  _ts.set(sx == null ? 1 : sx, sy == null ? 1 : sy, sz == null ? 1 : sz);
  return _m4.compose(_tp, _tq, _ts);
}

// ---------------------------------------------------------------
// caches
// ---------------------------------------------------------------
const primCache = new Map();   // shared unit primitives
const geoCache = new Map();    // 'fishId|key' -> BufferGeometry
const matCache = new Map();    // 'fishId|mutation' -> material set
const texCache = new Map();    // canvas textures
const iconCache = new Map();   // 'fishId|mutation' -> dataURL

function prim(key, make) {
  let g = primCache.get(key);
  if (!g) { g = make(); primCache.set(key, g); }
  return g;
}
const P = {
  sph: () => prim('sph', () => new THREE.SphereGeometry(0.5, 12, 9)),
  sphLo: () => prim('sphLo', () => new THREE.SphereGeometry(0.5, 8, 6)),
  sphTiny: () => prim('sphTiny', () => new THREE.SphereGeometry(0.5, 6, 4)),
  cone4: () => prim('cone4', () => new THREE.ConeGeometry(0.5, 1, 4)),
  cone6: () => prim('cone6', () => new THREE.ConeGeometry(0.5, 1, 6)),
  cone8: () => prim('cone8', () => new THREE.ConeGeometry(0.5, 1, 8)),
  cyl6: () => prim('cyl6', () => new THREE.CylinderGeometry(0.5, 0.5, 1, 6)),
  cyl8: () => prim('cyl8', () => new THREE.CylinderGeometry(0.5, 0.5, 1, 8)),
  box: () => prim('box', () => new THREE.BoxGeometry(1, 1, 1)),
  octa: () => prim('octa', () => new THREE.OctahedronGeometry(0.5, 0)),
  icos: () => prim('icos', () => new THREE.IcosahedronGeometry(0.5, 0)),
};

// ---------------------------------------------------------------
// Builder - merges transformed geometries into one buffer
// (replacement for the forbidden addons BufferGeometryUtils)
// ---------------------------------------------------------------
class Builder {
  constructor() { this.p = []; this.n = []; this.u = []; this.i = []; this.c = 0; }
  add(g, m) {
    const pos = g.attributes.position;
    const nor = g.attributes.normal;
    const uv = g.attributes.uv;
    const base = this.c;
    _m3.getNormalMatrix(m);
    for (let k = 0; k < pos.count; k++) {
      _v3.fromBufferAttribute(pos, k).applyMatrix4(m);
      this.p.push(_v3.x, _v3.y, _v3.z);
      if (nor) {
        _v3.fromBufferAttribute(nor, k).applyMatrix3(_m3).normalize();
        this.n.push(_v3.x, _v3.y, _v3.z);
      } else this.n.push(0, 1, 0);
      if (uv) this.u.push(uv.getX(k), uv.getY(k)); else this.u.push(0.5, 0.5);
      this.c++;
    }
    const idx = g.index;
    if (idx) { for (let k = 0; k < idx.count; k++) this.i.push(base + idx.getX(k)); }
    else { for (let k = 0; k < pos.count; k++) this.i.push(base + k); }
    return this;
  }
  build(recomputeNormals) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2));
    g.setIndex(this.i);
    if (recomputeNormals) g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

// ---------------------------------------------------------------
// flat polygon (fins). Points authored in XY, base at x=0, tip toward +x.
// Fan-triangulated from pts[0] (author star-shaped polygons).
// bow: gentle bend out of plane so fins are not dead flat.
// ---------------------------------------------------------------
function flatShape(pts, bow) {
  bow = bow || 0;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    if (pts[i][0] < minX) minX = pts[i][0];
    if (pts[i][0] > maxX) maxX = pts[i][0];
    if (pts[i][1] < minY) minY = pts[i][1];
    if (pts[i][1] > maxY) maxY = pts[i][1];
  }
  const spanX = Math.max(1e-5, maxX - minX);
  const spanY = Math.max(1e-5, maxY - minY);
  const pos = [], uvs = [], idx = [];
  for (let i = 0; i < pts.length; i++) {
    const fx = (pts[i][0] - minX) / spanX;
    pos.push(pts[i][0], pts[i][1], bow * fx * fx);
    uvs.push(fx, (pts[i][1] - minY) / spanY);
  }
  for (let i = 1; i < pts.length - 1; i++) idx.push(0, i, i + 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------
// plate - solid thin slab from an XZ outline (ray wings, armour).
// vTop / vBot pick which band of the body texture each face samples.
// ---------------------------------------------------------------
function plateGeo(pts, thick, vTop, vBot) {
  const t = thick * 0.5;
  const n = pts.length;
  const pos = [], uvs = [], idx = [];
  let minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < n; i++) { if (pts[i][0] < minX) minX = pts[i][0]; if (pts[i][0] > maxX) maxX = pts[i][0]; }
  const span = Math.max(1e-5, maxX - minX);
  for (let i = 0; i < n; i++) { // top ring
    pos.push(pts[i][0], t, pts[i][1]);
    uvs.push((pts[i][0] - minX) / span, vTop);
  }
  for (let i = 0; i < n; i++) { // bottom ring
    pos.push(pts[i][0], -t, pts[i][1]);
    uvs.push((pts[i][0] - minX) / span, vBot);
  }
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area2 += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  const flip = area2 > 0;
  for (let i = 1; i < n - 1; i++) {
    if (flip) { idx.push(0, i + 1, i); idx.push(n, n + i, n + i + 1); }
    else { idx.push(0, i, i + 1); idx.push(n, n + i + 1, n + i); }
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (flip) { idx.push(i, j, n + i); idx.push(j, n + j, n + i); }
    else { idx.push(i, n + i, j); idx.push(j, n + i, n + j); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------
// tapered tube along +Z, pivot at the base. Used for tentacles,
// whiskers, tails, serpent horns.
// ---------------------------------------------------------------
function taperGeo(r0, r1, len, radial, suckers, bend) {
  const rings = 3;
  const pos = [], uvs = [], idx = [];
  const ring = radial + 1;
  for (let r = 0; r <= rings; r++) {
    const f = r / rings;
    const rad = lerp(r0, r1, smooth(f));
    const z = len * f;
    const yb = bend ? bend * f * f : 0;
    for (let j = 0; j <= radial; j++) {
      const th = (j / radial) * TAU;
      pos.push(Math.sin(th) * rad, Math.cos(th) * rad + yb, z);
      uvs.push(0.5 + f * 0.4, j / radial);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let j = 0; j < radial; j++) {
      const a = r * ring + j, b = a + 1, c = a + ring, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  // cap the far end
  const cIdx = pos.length / 3;
  pos.push(0, (bend || 0), len + r1 * 0.6); uvs.push(0.95, 0.5);
  const last = rings * ring;
  for (let j = 0; j < radial; j++) idx.push(cIdx, last + j + 1, last + j);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  if (!suckers) return g;
  // merge sucker bumps along the underside
  const B = new Builder();
  B.add(g, xform(0, 0, 0, 0, 0, 0, 1, 1, 1));
  g.dispose();
  const bump = P.sphTiny();
  for (let s = 0; s < suckers; s++) {
    const f = (s + 0.6) / (suckers + 0.2);
    const rad = lerp(r0, r1, f) * 0.55;
    B.add(bump, xform(0, -lerp(r0, r1, f) * 0.85, len * f, 0, 0, 0, rad, rad * 0.6, rad));
  }
  return B.build(true);
}

// ---------------------------------------------------------------
// body profile sampling. Row = [u, halfUp, halfDown, halfWidth]
// (fractions of total fish length). u = 0 nose -> 1 tail.
// ---------------------------------------------------------------
const _prof = { hu: 0, hd: 0, w: 0 };
function sampleProfile(Pf, u) {
  u = clamp(u, 0, 1);
  let i = 0;
  while (i < Pf.length - 2 && u > Pf[i + 1][0]) i++;
  const a = Pf[i], b = Pf[i + 1];
  let t = (u - a[0]) / Math.max(1e-6, b[0] - a[0]);
  t = smooth(clamp(t, 0, 1));
  _prof.hu = Math.max(0.0015, a[1] + (b[1] - a[1]) * t);
  _prof.hd = Math.max(0.0015, a[2] + (b[2] - a[2]) * t);
  _prof.w = Math.max(0.0015, a[3] + (b[3] - a[3]) * t);
  return _prof;
}

// one chain section of the body tube (ring mesh), pivot at its front ring
function sectionGeo(cfg, k) {
  const rps = cfg.rings, radial = cfg.radial, n = cfg.sections;
  const bodyLen = cfg.zNose - cfg.zTail;
  const secLen = bodyLen / n;
  const u0 = k / n, du = 1 / n;
  const ring = radial + 1;
  const pos = [], uvs = [], idx = [];
  for (let r = 0; r <= rps; r++) {
    const f = r / rps;
    const u = u0 + du * f;
    const p = sampleProfile(cfg.profile, u);
    const yo = cfg.yOff ? cfg.yOff(u) : 0;
    const z = -f * secLen;
    for (let j = 0; j <= radial; j++) {
      const th = (j / radial) * TAU;
      const cs = Math.cos(th), sn = Math.sin(th);
      let x = p.w * sn;
      let y = (cs >= 0 ? p.hu : p.hd) * cs;
      if (cfg.lump) { const L = cfg.lump(u, th); x *= L; y *= L; }
      pos.push(x, y + yo, z);
      uvs.push(u, j / radial);
    }
  }
  for (let r = 0; r < rps; r++) {
    for (let j = 0; j < radial; j++) {
      const a = r * ring + j, b = a + 1, c = a + ring, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  if (k === 0) { // nose cap
    const ci = pos.length / 3;
    const yo = cfg.yOff ? cfg.yOff(0) : 0;
    pos.push(0, yo, 0); uvs.push(0, 0.5);
    for (let j = 0; j < radial; j++) idx.push(ci, j + 1, j);
  }
  if (k === n - 1) { // tail cap
    const ci = pos.length / 3;
    const yo = cfg.yOff ? cfg.yOff(1) : 0;
    const last = rps * ring;
    pos.push(0, yo, -secLen); uvs.push(1, 0.5);
    for (let j = 0; j < radial; j++) idx.push(ci, last + j, last + j + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------
// canvas textures
// ---------------------------------------------------------------
function cssOf(hex, mul) {
  _col.setHex(hex >>> 0);
  if (mul != null) _col.multiplyScalar(mul);
  return '#' + _col.getHexString();
}
function canvasTex(key, w, h, draw) {
  if (texCache.has(key)) return texCache.get(key);
  if (typeof document === 'undefined') { texCache.set(key, null); return null; }
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  draw(g, w, h);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  texCache.set(key, t);
  return t;
}

// species skin: u = nose->tail, v = 0 top / 0.5 belly / 1 top
function bodyTexture(def, mut) {
  const key = 'B|' + def.id + '|' + (mut || '');
  return canvasTex(key, 256, 128, (g, w, h) => {
    const m = def.model;
    const cols = m.colors || [0x8899aa, 0x556677];
    const R = rngFor(hashStr(def.id + 'tex'));
    if (mut === 'golden' || mut === 'rainbow' || mut === 'crystal' || mut === 'spectral') {
      const pale = mut === 'golden' ? [0xfff0c0, 0xffd766, 0xc98a1e]
        : mut === 'crystal' ? [0xf2fdff, 0xcdefff, 0x8fc4e0]
          : mut === 'spectral' ? [0xf0faff, 0xcfe8ff, 0x9dc4e8]
            : [0xffffff, 0xf0f0f0, 0xcccccc];
      const gr = g.createLinearGradient(0, 0, 0, h);
      gr.addColorStop(0, cssOf(pale[2])); gr.addColorStop(0.22, cssOf(pale[1]));
      gr.addColorStop(0.5, cssOf(pale[0])); gr.addColorStop(0.78, cssOf(pale[1]));
      gr.addColorStop(1, cssOf(pale[2]));
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
      g.globalAlpha = 0.25; g.fillStyle = cssOf(pale[0]);
      for (let i = 0; i < 26; i++) {
        const y = R() * h, hh = 2 + R() * 5;
        g.fillRect(0, y, w, hh);
      }
      g.globalAlpha = 1;
    } else if (mut === 'void') {
      g.fillStyle = '#07030d'; g.fillRect(0, 0, w, h);
      g.globalAlpha = 0.5; g.fillStyle = '#160a24';
      for (let i = 0; i < 40; i++) g.fillRect(R() * w, R() * h, 6 + R() * 30, 2 + R() * 6);
      g.globalAlpha = 1;
    } else if (mut === 'molten') {
      g.fillStyle = '#231007'; g.fillRect(0, 0, w, h);
      g.globalAlpha = 0.55;
      for (let i = 0; i < 60; i++) {
        g.fillStyle = R() > 0.5 ? '#2e1608' : '#160a04';
        g.fillRect(R() * w, R() * h, 4 + R() * 22, 3 + R() * 10);
      }
      g.globalAlpha = 1;
    } else {
      const top = cssOf(cols[1] || cols[0], 0.72);
      const mid = cssOf(cols[0]);
      const mid2 = cssOf(cols[1] || cols[0]);
      const belly = cssOf(m.belly != null ? m.belly : 0xe8eef2);
      const gr = g.createLinearGradient(0, 0, 0, h);
      gr.addColorStop(0, top); gr.addColorStop(0.13, mid2);
      gr.addColorStop(0.3, mid); gr.addColorStop(0.44, belly);
      gr.addColorStop(0.56, belly); gr.addColorStop(0.7, mid);
      gr.addColorStop(0.87, mid2); gr.addColorStop(1, top);
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
      // scale speckle
      g.globalAlpha = 0.08;
      for (let i = 0; i < 700; i++) {
        const x = R() * w, y = R() * h;
        g.fillStyle = R() > 0.5 ? '#ffffff' : '#000000';
        g.fillRect(x, y, 2, 2);
      }
      g.globalAlpha = 1;
      // lateral line
      g.strokeStyle = cssOf(cols[1] || cols[0], 0.6);
      g.globalAlpha = 0.5; g.lineWidth = 2;
      for (const yy of [h * 0.3, h * 0.7]) {
        g.beginPath();
        for (let x = 0; x <= w; x += 16) g.lineTo(x, yy + Math.sin(x * 0.03) * 3);
        g.stroke();
      }
      g.globalAlpha = 1;
      // gill arc
      g.globalAlpha = 0.35; g.strokeStyle = cssOf(cols[1] || cols[0], 0.5);
      g.lineWidth = 4; g.beginPath();
      g.moveTo(w * 0.15, 0); g.quadraticCurveTo(w * 0.19, h * 0.5, w * 0.15, h);
      g.stroke(); g.globalAlpha = 1;
      if (m.stripes != null) {
        g.globalAlpha = 0.75; g.fillStyle = cssOf(m.stripes);
        const n = 9;
        for (let i = 0; i < n; i++) {
          const x = w * (0.14 + 0.78 * (i / n));
          const bw = w * (0.012 + R() * 0.02);
          g.beginPath();
          for (let s = 0; s <= 10; s++) {
            const yy = (s / 10) * h;
            g.lineTo(x + Math.sin(yy * 0.05 + i) * 5, yy);
          }
          for (let s = 10; s >= 0; s--) {
            const yy = (s / 10) * h;
            g.lineTo(x + bw + Math.sin(yy * 0.05 + i) * 5, yy);
          }
          g.closePath(); g.fill();
        }
        g.globalAlpha = 1;
      }
      if (m.spots != null) {
        g.fillStyle = cssOf(m.spots); g.globalAlpha = 0.6;
        for (let i = 0; i < 54; i++) {
          const y = R() * h;
          if (y > h * 0.42 && y < h * 0.58) continue;
          g.beginPath(); g.arc(R() * w, y, 1.5 + R() * 5, 0, TAU); g.fill();
        }
        g.globalAlpha = 1;
      }
      if (m.shape === 'flat') { // camo blotches
        g.globalAlpha = 0.4; g.fillStyle = cssOf(cols[1] || cols[0], 0.7);
        for (let i = 0; i < 30; i++) {
          g.beginPath(); g.arc(R() * w, R() * h, 3 + R() * 9, 0, TAU); g.fill();
        }
        g.fillStyle = cssOf(m.belly != null ? m.belly : 0xffffff, 1.1);
        for (let i = 0; i < 16; i++) {
          g.beginPath(); g.arc(R() * w, R() * h, 2 + R() * 4, 0, TAU); g.fill();
        }
        g.globalAlpha = 1;
      }
    }
  });
}

// glowing seam / crack mask used as emissiveMap for molten + void
function seamMask(def, style) {
  const key = 'S|' + def.id + '|' + style;
  return canvasTex(key, 256, 128, (g, w, h) => {
    const R = rngFor(hashStr(def.id + style));
    g.fillStyle = '#000000'; g.fillRect(0, 0, w, h);
    const hot = style === 'molten' ? '#ffb040' : '#a860ff';
    const core = style === 'molten' ? '#fff0c0' : '#e0c0ff';
    g.shadowColor = hot;
    g.shadowBlur = style === 'molten' ? 9 : 7;
    const lines = style === 'molten' ? 16 : 11;
    for (let i = 0; i < lines; i++) {
      let x = R() * w, y = R() * h;
      g.strokeStyle = hot;
      g.lineWidth = 1 + R() * 2.4;
      g.beginPath(); g.moveTo(x, y);
      const steps = 5 + Math.floor(R() * 6);
      for (let s = 0; s < steps; s++) {
        x += (R() - 0.5) * 46; y += (R() - 0.5) * 34;
        g.lineTo(x, y);
      }
      g.stroke();
      if (R() > 0.4) {
        g.strokeStyle = core; g.lineWidth = 1; g.stroke();
      }
    }
    g.shadowBlur = 0;
  });
}

// fin gradient (base -> tip)
function finTexture(base, tip) {
  const key = 'F|' + base + '|' + tip;
  return canvasTex(key, 64, 8, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, w, 0);
    gr.addColorStop(0, cssOf(base, 0.7));
    gr.addColorStop(0.45, cssOf(base));
    gr.addColorStop(1, cssOf(tip));
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    g.globalAlpha = 0.25; g.fillStyle = '#000000';
    for (let i = 0; i < 7; i++) g.fillRect(0, i * (h / 7), w, 1);
  });
}

function dotTex() {
  return canvasTex('dot', 32, 32, (g, w, h) => {
    const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.4, 'rgba(255,255,255,0.65)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  });
}
function haloTex() {
  return canvasTex('halo', 128, 128, (g, w, h) => {
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,255,255,0.95)');
    gr.addColorStop(0.25, 'rgba(255,255,255,0.42)');
    gr.addColorStop(0.6, 'rgba(255,255,255,0.12)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  });
}

// ---------------------------------------------------------------
// materials
// ---------------------------------------------------------------
function buildMaterials(def, mut) {
  const m = def.model;
  const cols = m.colors || [0x8899aa, 0x556677];
  const deep = (def.tier || 1) >= 7;
  const emis = m.emissive != null ? m.emissive : (deep ? 0x66ddff : 0x88ccff);
  const finBase = m.finTint != null ? m.finTint : (cols[1] != null ? cols[1] : cols[0]);
  const finTip = m.finTint != null ? m.finTint : cols[0];

  const body = new THREE.MeshStandardMaterial({
    color: 0xffffff, map: bodyTexture(def, mut),
    roughness: 0.6, metalness: 0.08, flatShading: true,
  });
  const fin = new THREE.MeshStandardMaterial({
    color: 0xffffff, map: finTexture(finBase, finTip),
    roughness: 0.75, metalness: 0.02, flatShading: true, side: THREE.DoubleSide,
  });
  const eye = new THREE.MeshStandardMaterial({
    color: 0xf6f8fa, roughness: 0.24, metalness: 0.0,
    emissive: deep ? 0x223344 : 0x000000, emissiveIntensity: deep ? 0.6 : 0,
  });
  const pupil = new THREE.MeshStandardMaterial({
    color: 0x0a0c10, roughness: 0.15, metalness: 0.1,
    emissive: deep ? emis : 0x000000, emissiveIntensity: deep ? 0.9 : 0,
  });
  const teeth = new THREE.MeshStandardMaterial({
    color: 0xf2ece0, roughness: 0.35, metalness: 0.0, flatShading: true,
  });
  const bone = new THREE.MeshStandardMaterial({
    color: 0xcfc7b4, roughness: 0.55, metalness: 0.12, flatShading: true,
  });
  const glow = new THREE.MeshStandardMaterial({
    color: 0x0b0b12, emissive: emis, emissiveIntensity: 2.1,
    roughness: 0.4, metalness: 0.0, flatShading: true,
  });
  const dark = new THREE.MeshStandardMaterial({
    color: 0x160c12, roughness: 0.9, metalness: 0.0, flatShading: true,
  });
  const set = { body, fin, eye, pupil, teeth, bone, glow, dark, emis };
  set.list = [body, fin, teeth, bone, dark];
  if (mut) applyMutation(set, mut, def);
  return set;
}

function applyMutation(s, mut, def) {
  const M = MUTATIONS[mut];
  if (!M) return;
  switch (M.fx) {
    case 'sparkle': { // golden
      for (const mat of [s.body, s.fin, s.bone, s.teeth]) {
        mat.color.setHex(mut === 'golden' ? 0xffc832 : 0xffffff);
        mat.emissive.setHex(0xaa7700); mat.emissiveIntensity = 0.32;
        mat.metalness = 0.95; mat.roughness = 0.18;
      }
      s.dark.color.setHex(0x6b4a00); s.dark.metalness = 0.8; s.dark.roughness = 0.3;
      s.pupil.color.setHex(0x3d2a00); s.pupil.metalness = 0.9; s.pupil.roughness = 0.2;
      s.eye.color.setHex(0xfff0c0); s.eye.metalness = 0.8; s.eye.roughness = 0.15;
      break;
    }
    case 'hueShift': { // rainbow
      for (const mat of [s.body, s.fin, s.bone, s.teeth]) {
        mat.color.setHex(0xffffff); mat.emissive.setHex(0x221133);
        mat.emissiveIntensity = 0.5; mat.metalness = 0.45; mat.roughness = 0.22;
      }
      break;
    }
    case 'voidParticles': { // void
      const seam = seamMask(def, 'void');
      s.body.color.setHex(0x0a0014); s.body.emissive.setHex(0x5511cc);
      s.body.emissiveMap = seam; s.body.emissiveIntensity = 1.5;
      s.body.roughness = 0.86; s.body.metalness = 0.0;
      s.fin.color.setHex(0x120022); s.fin.emissive.setHex(0x3a0088); s.fin.emissiveIntensity = 0.55;
      s.teeth.color.setHex(0x2a1440); s.bone.color.setHex(0x241038);
      s.dark.color.setHex(0x040008);
      s.eye.color.setHex(0x1a0030); s.eye.emissive.setHex(0x4400aa); s.eye.emissiveIntensity = 0.8;
      s.pupil.color.setHex(0x000000); s.pupil.emissive.setHex(0x6622ff); s.pupil.emissiveIntensity = 1.4;
      break;
    }
    case 'ghost': { // spectral
      for (const mat of s.list) {
        mat.color.setHex(0xaaddff); mat.emissive.setHex(0x3388cc); mat.emissiveIntensity = 0.9;
        mat.transparent = true; mat.opacity = 0.45; mat.depthWrite = false;
        mat.roughness = 0.5; mat.metalness = 0.0;
      }
      s.eye.color.setHex(0xdff2ff); s.eye.emissive.setHex(0x66bbff); s.eye.emissiveIntensity = 1.1;
      s.eye.transparent = true; s.eye.opacity = 0.6; s.eye.depthWrite = false;
      s.pupil.color.setHex(0x224466); s.pupil.emissive.setHex(0x3388cc); s.pupil.emissiveIntensity = 0.8;
      s.pupil.transparent = true; s.pupil.opacity = 0.6; s.pupil.depthWrite = false;
      break;
    }
    case 'embers': { // molten
      const crack = seamMask(def, 'molten');
      s.body.color.setHex(0x2a1207); s.body.emissive.setHex(0xff4400);
      s.body.emissiveMap = crack; s.body.emissiveIntensity = 1.7;
      s.body.roughness = 0.95; s.body.metalness = 0.05;
      s.fin.color.setHex(0x1c0d05); s.fin.emissive.setHex(0xdd3300); s.fin.emissiveIntensity = 0.7;
      s.teeth.color.setHex(0x2b2018); s.bone.color.setHex(0x33241a);
      s.dark.color.setHex(0x0a0402);
      s.eye.color.setHex(0xffb060); s.eye.emissive.setHex(0xff5500); s.eye.emissiveIntensity = 1.3;
      s.pupil.color.setHex(0x160800);
      break;
    }
    case 'facets': { // crystal
      for (const mat of [s.body, s.fin, s.bone, s.teeth]) {
        mat.color.setHex(0xbbeeff); mat.emissive.setHex(0x66aacc); mat.emissiveIntensity = 0.45;
        mat.roughness = 0.12; mat.metalness = 0.28; mat.flatShading = true;
      }
      s.dark.color.setHex(0x6f9fb8);
      s.eye.color.setHex(0xeafaff); s.eye.emissive.setHex(0x88ccee); s.eye.emissiveIntensity = 0.8;
      s.pupil.color.setHex(0x2a5a72); s.pupil.emissive.setHex(0x66aacc); s.pupil.emissiveIntensity = 0.6;
      break;
    }
    default: break;
  }
}

function materialSet(def, mut) {
  const key = def.id + '|' + (mut || '');
  let set = matCache.get(key);
  if (!set) { set = buildMaterials(def, mut); matCache.set(key, set); }
  if (!mut) return set;
  // mutated fish animate their materials -> give each instance its own copy
  const c = {
    body: set.body.clone(), fin: set.fin.clone(), eye: set.eye.clone(),
    pupil: set.pupil.clone(), teeth: set.teeth.clone(), bone: set.bone.clone(),
    glow: set.glow.clone(), dark: set.dark.clone(), emis: set.emis, owned: true,
  };
  c.list = [c.body, c.fin, c.teeth, c.bone, c.dark];
  return c;
}

// ---------------------------------------------------------------
// shape catalog: base silhouettes + swim parameters
// profile rows: [u, halfUp, halfDown, halfWidth] as fractions of length
// ---------------------------------------------------------------
const BASE = {
  slim: {
    profile: [[0, .010, .010, .008], [.06, .052, .044, .036], [.18, .088, .080, .050],
    [.34, .094, .086, .050], [.55, .076, .068, .040], [.75, .046, .040, .025],
    [.92, .026, .023, .014], [1, .016, .014, .010]],
    sections: 4, rings: 3, radial: 10, amp: .13, phase: .95, speedMul: 1.0, tailFrac: .19,
  },
  round: {
    profile: [[0, .014, .014, .011], [.06, .085, .075, .044], [.16, .150, .140, .060],
    [.32, .178, .162, .066], [.5, .162, .148, .060], [.7, .104, .094, .044],
    [.88, .054, .048, .027], [1, .026, .024, .016]],
    sections: 3, rings: 4, radial: 12, amp: .10, phase: 1.0, speedMul: .85, tailFrac: .17,
  },
  shark: {
    profile: [[0, .012, .012, .010], [.08, .062, .055, .052], [.2, .098, .090, .086],
    [.38, .100, .092, .086], [.58, .082, .072, .068], [.78, .052, .045, .042],
    [.92, .030, .026, .024], [1, .020, .017, .015]],
    sections: 4, rings: 3, radial: 12, amp: .085, phase: .8, speedMul: .6, tailFrac: .18,
  },
  angler: {
    profile: [[0, .075, .070, .068], [.1, .135, .120, .118], [.26, .150, .130, .124],
    [.45, .110, .095, .090], [.7, .060, .050, .046], [.88, .032, .026, .024],
    [1, .016, .014, .012]],
    sections: 3, rings: 3, radial: 12, amp: .10, phase: .9, speedMul: .55, tailFrac: .12,
  },
  eel: {
    profile: [[0, .028, .026, .026], [.05, .042, .040, .038], [.15, .040, .036, .032],
    [.4, .034, .030, .026], [.7, .024, .020, .017], [.9, .014, .012, .010],
    [1, .005, .005, .004]],
    sections: 9, rings: 2, radial: 8, amp: .22, phase: .75, speedMul: .9, tailFrac: .05,
  },
  serpent: {
    profile: [[0, .030, .028, .028], [.04, .056, .048, .048], [.1, .048, .042, .040],
    [.3, .042, .036, .034], [.6, .030, .025, .023], [.85, .016, .013, .012],
    [1, .005, .004, .004]],
    sections: 12, rings: 2, radial: 9, amp: .20, phase: .62, speedMul: .5, tailFrac: .04,
  },
  flat: {
    profile: [[0, .020, .012, .030], [.1, .032, .018, .120], [.3, .040, .022, .190],
    [.55, .038, .020, .185], [.8, .026, .014, .115], [1, .010, .006, .028]],
    sections: 3, rings: 4, radial: 12, amp: .07, phase: 1.1, speedMul: .7, tailFrac: .1,
  },
  blob: {
    profile: [[0, .120, .110, .112], [.15, .230, .222, .228], [.35, .272, .262, .270],
    [.55, .254, .242, .252], [.78, .168, .156, .166], [1, .050, .044, .048]],
    sections: 3, rings: 5, radial: 14, amp: .05, phase: 1.0, speedMul: .3, tailFrac: 0,
  },
  puffer: {
    profile: [[0, .140, .140, .135], [.18, .245, .250, .245], [.4, .262, .268, .262],
    [.62, .230, .232, .228], [.84, .130, .128, .128], [1, .038, .036, .036]],
    sections: 2, rings: 6, radial: 14, amp: .03, phase: 1.0, speedMul: .5, tailFrac: .12,
  },
  squid: {
    profile: [[0, .092, .088, .092], [.12, .118, .112, .118], [.35, .108, .102, .108],
    [.6, .082, .078, .082], [.85, .042, .040, .042], [1, .008, .008, .008]],
    sections: 3, rings: 3, radial: 12, amp: .04, phase: 1.0, speedMul: .5, tailFrac: 0,
  },
};

// per-species silhouette overrides (front = head bulk, nose = space left for a bill/snout)
const TWEAK = {
  minnow: { depth: .88 }, anchovy: { depth: .92 },
  mackerel: { depth: .95, width: .92 },
  salmon: { depth: 1.06, front: 1.06 },
  tuna: { depth: 1.16, width: 1.15, front: 1.1 },
  swordfish: { depth: .96, width: .95, nose: .24 },
  cod: { front: 1.12 }, snapper: { front: 1.08, depth: 1.04 },
  seabass: { front: 1.05 }, perch: { depth: 1.05 },
  mudwhisker: { front: 1.2, depth: .92, width: 1.15 },
  mahimahi: { front: 1.55, depth: 1.02 },
  opah: { depth: 1.24, width: .82 },
  grouper: { front: 1.18, depth: 1.05, width: 1.1 },
  lionfish: { depth: 1.04, front: 1.05 },
  fangtooth: { front: 1.5, depth: 1.02 },
  tidenibbler: { depth: .95 },
  barracuda: { front: 1.2, depth: 1.2, width: 1.05 },
  eleel: { front: 1.25, depth: 1.2, width: 1.15 },
  viperfish: { front: 1.4, depth: 1.1 },
  gulper: { front: 2.0, depth: 1.1, nose: .02 },
  oarfish: { depth: 1.4, width: .5 },
  frilledshark: { front: 1.3, depth: 1.1 },
  goblinshark: { front: .88, nose: .15 },
  dunkle: { front: 1.28, depth: 1.06, width: 1.12 },
  greatwhite: { front: 1.02 },
  megalodon: { depth: 1.08, width: 1.14, front: 1.05 },
};

// fin outlines: authored in XY, base at x=0, tip toward +x, fan-safe
const FIN = {
  dorsal: [[0, 0], [.12, .30], [.42, .42], [.85, .10], [1, 0]],
  dorsalLong: [[0, 0], [.06, .16], [.5, .21], [.94, .12], [1, 0]],
  dorsalSpiny: [[0, 0], [.05, .30], [.18, .22], [.32, .34], [.46, .24], [.6, .32], [.78, .18], [1, 0]],
  dorsalSickle: [[0, 0], [.06, .55], [.28, 1.0], [.5, .42], [.9, .06], [1, 0]],
  sharkDorsal: [[0, 0], [.05, .5], [.34, 1.0], [.78, .26], [1, .02]],
  pect: [[0, 0], [.2, .17], [.7, .2], [1, .04], [.72, -.1], [.25, -.13]],
  pectLong: [[0, 0], [.16, .13], [.72, .12], [1, .01], [.78, -.08], [.2, -.11]],
  pectRound: [[0, 0], [.18, .24], [.6, .3], [.95, .12], [1, -.02], [.6, -.16], [.2, -.2]],
  tailFork: [[0, 0], [.18, .06], [1, .62], [.62, .03], [1, -.62], [.18, -.06]],
  tailFan: [[0, 0], [.12, .1], [.85, .42], [1, .16], [1, -.16], [.85, -.42], [.12, -.1]],
  tailCrescent: [[0, 0], [.12, .08], [.7, 1.05], [.95, .92], [.5, .16], [.85, -.5], [.7, -.62], [.15, -.08]],
  tailPaddle: [[0, 0], [.1, .12], [.7, .22], [1, .1], [1, -.1], [.7, -.22], [.1, -.12]],
  tailLance: [[0, 0], [.15, .07], [1, .18], [1, -.18], [.15, -.07]],
  finlet: [[0, 0], [.35, .3], [1, .02]],
  spineRay: [[0, 0], [.1, .06], [1, .02], [1, -.02], [.1, -.06]],
  frill: [[0, 0], [.1, .5], [.42, .8], [.72, .5], [1, 0]],
  wingFan: [[0, 0], [.12, .5], [.55, .78], [.9, .4], [1, 0]],
};

// ---------------------------------------------------------------
// assembly helpers
// ---------------------------------------------------------------
function shapeCfg(C, shapeKey) {
  const base = BASE[shapeKey] || BASE.slim;
  const R = C.R;
  const tw = TWEAK[C.id] || {};
  const prof = base.profile.map((r) => r.slice());
  const jd = (tw.depth || 1) * (0.94 + R() * 0.12);
  const jw = (tw.width || 1) * (0.92 + R() * 0.16);
  const front = tw.front || 1;
  for (const r of prof) {
    const fm = lerp(front, 1, smooth(clamp(r[0] / 0.45, 0, 1)));
    const nz = 0.98 + R() * 0.04;
    r[1] *= jd * fm * nz; r[2] *= jd * fm * nz; r[3] *= jw * fm;
  }
  const nose = tw.nose || 0;
  return {
    profile: prof, sections: base.sections, rings: base.rings, radial: base.radial,
    zNose: 0.5 - nose, zTail: -0.5 + base.tailFrac, tailFrac: base.tailFrac, nose,
    amp: base.amp, phase: base.phase, speedMul: base.speedMul,
    secLen: (0.5 - nose - (-0.5 + base.tailFrac)) / base.sections,
  };
}

function anchorOf(cfg, u) {
  const n = cfg.sections;
  let k = Math.floor(u * n);
  if (k >= n) k = n - 1;
  if (k < 0) k = 0;
  const p = sampleProfile(cfg.profile, u);
  return { k, z: -(u - k / n) * (cfg.zNose - cfg.zTail), hu: p.hu, hd: p.hd, w: p.w };
}
function localZ(cfg, k, u) { return -(u - k / cfg.sections) * (cfg.zNose - cfg.zTail); }

function addChain(C, parent, rig, cfg, axis, ampMul) {
  const nodes = [];
  const secLen = (cfg.zNose - cfg.zTail) / cfg.sections;
  cfg.secLen = secLen;
  for (let k = 0; k < cfg.sections; k++) {
    const node = new THREE.Object3D();
    if (k === 0) { node.position.set(0, 0, cfg.zNose); parent.add(node); }
    else { node.position.set(0, 0, -secLen); nodes[k - 1].add(node); }
    nodes.push(node);
    const g = C.geo('body' + k, () => sectionGeo(cfg, k));
    const mesh = new THREE.Mesh(g, C.mats.body);
    mesh.castShadow = C.big;
    node.add(mesh);
  }
  const ax = axis || 'y';
  const am = ampMul == null ? 1 : ampMul;
  for (let k = 1; k < nodes.length; k++) {
    const f = k / Math.max(1, nodes.length - 1);
    rig.chain.push({
      o: nodes[k], ax, base: 0, rate: 1,
      amp: cfg.amp * am * (0.18 + 0.82 * f), ph: -k * cfg.phase,
    });
  }
  cfg.nodes = nodes;
  return nodes;
}

// merged static decoration (one draw call per node+material)
function addDeco(C, parent, role, key, fn) {
  const g = C.geo(key, () => { const B = new Builder(); fn(B); return B.build(false); });
  const mesh = new THREE.Mesh(g, C.mats[role] || C.mats.body);
  mesh.castShadow = C.big;
  parent.add(mesh);
  return mesh;
}
// add a fin polygon into a merged builder. negative sy flips it downward.
function finTo(B, pts, x, y, z, sx, sy, bow) {
  const g = flatShape(pts, bow || 0);
  B.add(g, xform(x, y, z, 0, PI / 2, 0, sx, sy, 1));
  g.dispose();
}

// standalone vertical fin (dorsal / anal / tail) with optional swish
function addVertFin(C, parent, key, pts, o) {
  const g = C.geo(key, () => flatShape(pts, o.bow || 0));
  const mesh = new THREE.Mesh(g, C.mats[o.role || 'fin']);
  mesh.rotation.y = PI / 2;
  mesh.scale.set(o.sx, o.sy == null ? o.sx : o.sy, 1);
  mesh.castShadow = C.big;
  const pivot = new THREE.Object3D();
  pivot.position.set(o.x || 0, o.y || 0, o.z || 0);
  pivot.add(mesh);
  parent.add(pivot);
  if (o.wob) {
    C.rig.wobble.push({
      o: pivot, ax: o.wob.ax || 'y', base: 0,
      amp: o.wob.amp, rate: o.wob.rate, ph: o.wob.ph || 0,
    });
  }
  return pivot;
}

// mirrored pair of horizontal fins (pectoral / pelvic), animated flap
function addPectoral(C, parent, key, pts, o) {
  const g = C.geo(key, () => flatShape(pts, o.bow || 0));
  const made = [];
  for (const side of [1, -1]) {
    const mir = new THREE.Object3D();
    mir.position.set((o.x || 0) * side, o.y || 0, o.z || 0);
    mir.scale.x = side;
    const sw = new THREE.Object3D();
    sw.rotation.y = o.sweep || 0;
    mir.add(sw);
    const inn = new THREE.Object3D();
    inn.rotation.z = o.droop || 0;
    sw.add(inn);
    const mesh = new THREE.Mesh(g, C.mats[o.role || 'fin']);
    mesh.rotation.x = -PI / 2;
    mesh.scale.set(o.sx, o.sy == null ? o.sx : o.sy, 1);
    mesh.castShadow = C.big;
    inn.add(mesh);
    parent.add(mir);
    if (o.wob !== false) {
      C.rig.wobble.push({
        o: inn, ax: 'z', base: inn.rotation.z,
        amp: o.amp == null ? 0.34 : o.amp,
        rate: o.rate == null ? 4.2 : o.rate,
        ph: side < 0 ? 0.5 : 0,
      });
    }
    made.push(inn);
  }
  return made;
}

function addEyes(C, parent, o) {
  const key = 'eye' + (o.key || '');
  addDeco(C, parent, 'eye', key + 'w', (B) => {
    for (const s of [1, -1]) {
      B.add(P.sph(), xform(s * o.x, o.y, o.z, 0, 0, 0, o.r * 2, o.r * 2 * (o.flat || 1), o.r * 2));
    }
  });
  addDeco(C, parent, 'pupil', key + 'p', (B) => {
    const pr = o.r * (o.pr == null ? 1.2 : o.pr);
    for (const s of [1, -1]) {
      B.add(P.sphLo(), xform(
        s * (o.x + o.r * 0.46), o.y + (o.py || 0), o.z + o.r * 0.42,
        0, 0, 0, pr, pr * (o.flat || 1), pr,
      ));
    }
  });
}

// teeth along a jaw arc. dir = -1 -> hanging down from an upper jaw.
function teethArc(B, o) {
  const cone = P.cone4();
  const R = o.rng || Math.random;
  const n = o.count;
  const dir = o.dir || -1;
  for (let i = 0; i < n; i++) {
    const f = n > 1 ? i / (n - 1) : 0.5;
    const a = f * 2 - 1;
    const len = o.len * (0.5 + 0.5 * (1 - a * a)) * (0.78 + 0.44 * R());
    const rad = o.rad * (0.65 + 0.35 * (1 - Math.abs(a)));
    B.add(cone, xform(
      a * o.halfW, o.y + dir * len * 0.5, o.z + (o.zBack || 0) * a * a,
      dir < 0 ? PI : 0, 0, -a * 0.25 * dir,
      rad * 2, len, rad * 2,
    ));
  }
}

// dark gill slits hugging the flank
function gillSlits(B, cfg, k, o) {
  const box = P.box();
  const n = o.count || 5;
  for (let i = 0; i < n; i++) {
    const u = o.u0 + (o.u1 - o.u0) * (i / Math.max(1, n - 1));
    const p = sampleProfile(cfg.profile, u);
    const z = localZ(cfg, k, u);
    for (const s of [1, -1]) {
      B.add(box, xform(
        s * p.w * 0.93, o.y != null ? o.y : -p.hd * 0.05, z,
        0, 0, o.tilt || 0.2,
        p.w * 0.12, (p.hu + p.hd) * (o.h || 0.62), p.w * 0.1,
      ));
    }
  }
}

function addWhiskers(C, node, o) {
  const g = C.geo('whisk', () => taperGeo(o.r, o.r * 0.22, o.len, 5, 0, 0));
  for (const s of [1, -1]) {
    for (let i = 0; i < o.pairs; i++) {
      const piv = new THREE.Object3D();
      piv.position.set(s * o.x * (0.55 + 0.45 * i), o.y - i * o.dy, o.z);
      piv.rotation.x = 0.45 + i * 0.3;
      const mesh = new THREE.Mesh(g, C.mats.body);
      piv.add(mesh);
      node.add(piv);
      C.rig.wobble.push({
        o: piv, ax: 'z', base: s * (0.4 + i * 0.22),
        amp: 0.18, rate: 2.4 + i * 0.5, ph: s * 1.2 + i * 0.7,
      });
    }
  }
}

function addTailFin(C, cfg, nodes, name, sx, sy, role) {
  const tailNode = nodes[nodes.length - 1];
  return addVertFin(C, tailNode, 'tail', FIN[name], {
    x: 0, y: 0, z: -cfg.secLen, sx, sy, role: role || 'fin',
    wob: { ax: 'y', amp: 0.14, rate: 5.0 },
  });
}

// ---------------------------------------------------------------
// SLIM / ROUND / SHARK / ANGLER
// ---------------------------------------------------------------
function buildFinned(C, parent, rig) {
  const shape = C.m.shape;
  const m = C.m, id = C.id;
  const cfg = shapeCfg(C, shape);
  const nodes = addChain(C, parent, rig, cfg);
  const head = nodes[0];
  const rr = C.rr;
  const R = C.R;

  if (shape === 'slim') {
    const isTuna = id === 'tuna';
    const isSword = id === 'swordfish';
    addTailFin(C, cfg, nodes, isTuna || isSword ? 'tailCrescent' : 'tailFork',
      rr(0.17, 0.21), rr(0.24, 0.30));
    const d = anchorOf(cfg, 0.34);
    addVertFin(C, nodes[d.k], 'dors', isTuna || isSword ? FIN.dorsalSickle : FIN.dorsal, {
      y: d.hu * 0.92, z: d.z, sx: isSword ? 0.3 : 0.21, sy: isSword ? 0.24 : 0.16,
      wob: { ax: 'y', amp: 0.07, rate: 3.4, ph: 1.2 },
    });
    const a2 = anchorOf(cfg, 0.7);
    const p2 = anchorOf(cfg, 0.55);
    addDeco(C, nodes[a2.k], 'fin', 'finsRear', (B) => {
      finTo(B, FIN.dorsal, 0, -a2.hd * 0.9, a2.z, 0.13, -0.11);
      if (a2.k === p2.k) finTo(B, FIN.dorsal, 0, -p2.hd * 0.92, p2.z, 0.09, -0.09);
      if (isTuna) {
        for (let i = 0; i < 5; i++) {
          const u = 0.66 + i * 0.05;
          const an = anchorOf(cfg, u);
          if (an.k !== a2.k) continue;
          finTo(B, FIN.finlet, 0, an.hu * 0.95, an.z, 0.035, 0.03);
          finTo(B, FIN.finlet, 0, -an.hd * 0.95, an.z, 0.035, -0.03);
        }
      }
    });
    const pc = anchorOf(cfg, 0.25);
    addPectoral(C, nodes[pc.k], 'pec', FIN.pect, {
      x: pc.w * 0.85, y: -pc.hd * 0.3, z: pc.z,
      sx: rr(0.16, 0.2), sy: rr(0.16, 0.2), sweep: 0.5, droop: -0.35, bow: 0.02, amp: 0.3, rate: 3.6,
    });
    const pv = anchorOf(cfg, 0.52);
    addPectoral(C, nodes[pv.k], 'pel', FIN.pect, {
      x: pv.w * 0.5, y: -pv.hd * 0.86, z: pv.z,
      sx: 0.085, sy: 0.085, sweep: 0.35, droop: -0.9, amp: 0.2, rate: 4.4,
    });
    const e = anchorOf(cfg, 0.08);
    addEyes(C, head, { x: e.w * 0.82, y: e.hu * 0.42, z: e.z, r: Math.max(0.011, e.w * 0.4) });
    addDeco(C, head, 'dark', 'mouth', (B) => {
      const mo = anchorOf(cfg, 0.045);
      B.add(P.box(), xform(0, -mo.hd * 0.42, mo.z + 0.005, 0, 0, 0, mo.w * 1.35, mo.hu * 0.16, mo.w * 0.5));
    });
    if (isSword) {
      const bl = C.geo('bill', () => taperGeo(0.018, 0.004, cfg.nose + 0.02, 6, 0, 0));
      const bill = new THREE.Mesh(bl, C.mats.bone);
      bill.scale.set(1, 0.42, 1);
      bill.castShadow = C.big;
      head.add(bill);
    }
    if (id === 'salmon') {
      const ad = anchorOf(cfg, 0.78);
      addDeco(C, nodes[ad.k], 'fin', 'adipose', (B) => {
        finTo(B, FIN.dorsal, 0, ad.hu * 0.95, ad.z, 0.05, 0.045);
      });
    }
  } else if (shape === 'round') {
    const spiky = !!m.spikes;
    const forked = id === 'mahimahi';
    addTailFin(C, cfg, nodes, forked ? 'tailFork' : 'tailFan', rr(0.15, 0.18), rr(0.26, 0.32));
    const d = anchorOf(cfg, forked ? 0.14 : 0.24);
    if (!spiky) {
      addVertFin(C, nodes[d.k], 'dors', forked ? FIN.dorsalLong : FIN.dorsalSpiny, {
        y: d.hu * 0.94, z: d.z, sx: forked ? 0.62 : 0.3, sy: forked ? 0.34 : 0.2,
        wob: { ax: 'y', amp: 0.05, rate: 2.8, ph: 0.7 },
      });
      const d2 = anchorOf(cfg, 0.6);
      addDeco(C, nodes[d2.k], 'fin', 'dors2', (B) => {
        if (!forked) finTo(B, FIN.dorsalLong, 0, d2.hu * 0.94, d2.z, 0.2, 0.13);
        const an = anchorOf(cfg, 0.74);
        if (an.k === d2.k) finTo(B, FIN.dorsalLong, 0, -an.hd * 0.94, an.z, 0.16, -0.13);
      });
    } else {
      // lionfish: fan of venomous dorsal spines + long anal spines
      addDeco(C, nodes[d.k], 'fin', 'spines', (B) => {
        for (let i = 0; i < 9; i++) {
          const u = 0.16 + i * 0.055;
          const an = anchorOf(cfg, u);
          if (an.k !== d.k) continue;
          const L = 0.34 - i * 0.018;
          finTo(B, FIN.spineRay, 0, an.hu * 0.95, an.z, L, 0.1 + i * 0.008, 0.01);
        }
      });
      const lo = anchorOf(cfg, 0.62);
      addDeco(C, nodes[lo.k], 'fin', 'spines2', (B) => {
        for (let i = 0; i < 4; i++) {
          const u = 0.6 + i * 0.05;
          const an = anchorOf(cfg, u);
          if (an.k !== lo.k) continue;
          finTo(B, FIN.spineRay, 0, -an.hd * 0.95, an.z, 0.2 - i * 0.02, -0.09, 0.01);
        }
      });
    }
    const pc = anchorOf(cfg, 0.3);
    if (spiky) {
      // huge feathered pectoral fans
      for (let i = 0; i < 5; i++) {
        addPectoral(C, nodes[pc.k], 'ray' + i, FIN.spineRay, {
          x: pc.w * 0.8, y: -pc.hd * 0.1 + i * 0.035 - 0.05, z: pc.z,
          sx: 0.3 - i * 0.02, sy: 0.055, sweep: 0.55 + i * 0.12, droop: -0.5 + i * 0.24,
          amp: 0.12, rate: 1.8 + i * 0.2,
        });
      }
    } else {
      addPectoral(C, nodes[pc.k], 'pec', FIN.pectRound, {
        x: pc.w * 0.88, y: -pc.hd * 0.16, z: pc.z,
        sx: rr(0.16, 0.2), sy: rr(0.14, 0.18), sweep: 0.45, droop: -0.4, bow: 0.03,
        amp: 0.36, rate: 3.2,
      });
      const pv = anchorOf(cfg, 0.5);
      addPectoral(C, nodes[pv.k], 'pel', FIN.pect, {
        x: pv.w * 0.45, y: -pv.hd * 0.9, z: pv.z,
        sx: 0.12, sy: 0.1, sweep: 0.25, droop: -1.0, amp: 0.22, rate: 4.0,
      });
    }
    const e = anchorOf(cfg, 0.1);
    addEyes(C, head, {
      x: e.w * 0.8, y: e.hu * 0.45, z: e.z,
      r: Math.max(0.012, e.w * (id === 'fangtooth' ? 0.5 : 0.42)),
    });
    const mo = anchorOf(cfg, 0.05);
    addDeco(C, head, 'dark', 'mouth', (B) => {
      B.add(P.sphLo(), xform(0, -mo.hd * 0.35, mo.z + 0.01, 0, 0, 0, mo.w * 1.5, mo.hu * 0.5, mo.w * 0.9));
    });
    if (m.teeth) {
      addDeco(C, head, 'teeth', 'teeth', (B) => {
        teethArc(B, { y: -mo.hd * 0.1, z: mo.z + 0.012, zBack: -0.045, halfW: mo.w * 0.95, count: 9, len: mo.hu * 0.85, rad: mo.w * 0.09, dir: -1, rng: R });
        teethArc(B, { y: -mo.hd * 0.62, z: mo.z + 0.012, zBack: -0.045, halfW: mo.w * 0.85, count: 8, len: mo.hu * 0.7, rad: mo.w * 0.09, dir: 1, rng: R });
      });
    }
    if (m.whiskers) {
      addWhiskers(C, head, {
        x: mo.w * 0.7, y: -mo.hd * 0.55, z: mo.z, r: mo.w * 0.09,
        len: 0.26, pairs: 2, dy: mo.hd * 0.3,
      });
    }
  } else if (shape === 'shark') {
    const armored = !!m.armored;
    addTailFin(C, cfg, nodes, 'tailCrescent', rr(0.18, 0.22), rr(0.2, 0.25));
    const d = anchorOf(cfg, 0.34);
    addVertFin(C, nodes[d.k], 'dors', FIN.sharkDorsal, {
      y: d.hu * 0.95, z: d.z, sx: 0.2, sy: 0.19,
      wob: { ax: 'y', amp: 0.05, rate: 2.2, ph: 0.9 },
    });
    const d2 = anchorOf(cfg, 0.74);
    addDeco(C, nodes[d2.k], 'fin', 'finsRear', (B) => {
      finTo(B, FIN.sharkDorsal, 0, d2.hu * 0.95, d2.z, 0.07, 0.06);
      const an = anchorOf(cfg, 0.78);
      if (an.k === d2.k) finTo(B, FIN.sharkDorsal, 0, -an.hd * 0.95, an.z, 0.07, -0.055);
    });
    const pc = anchorOf(cfg, 0.3);
    addPectoral(C, nodes[pc.k], 'pec', FIN.pectLong, {
      x: pc.w * 0.9, y: -pc.hd * 0.42, z: pc.z,
      sx: rr(0.26, 0.32), sy: 0.2, sweep: 0.72, droop: -0.28, bow: 0.03, amp: 0.16, rate: 1.9,
    });
    const pv = anchorOf(cfg, 0.6);
    addPectoral(C, nodes[pv.k], 'pel', FIN.pectLong, {
      x: pv.w * 0.6, y: -pv.hd * 0.85, z: pv.z,
      sx: 0.12, sy: 0.1, sweep: 0.5, droop: -0.8, amp: 0.12, rate: 2.4,
    });
    addDeco(C, head, 'dark', 'gills', (B) => {
      gillSlits(B, cfg, 0, { u0: 0.15, u1: 0.24, count: 5, h: 0.5, tilt: 0.22 });
    });
    const e = anchorOf(cfg, 0.12);
    addEyes(C, head, {
      x: e.w * 0.88, y: e.hu * 0.4, z: e.z, r: Math.max(0.008, e.w * 0.2), pr: 1.5,
    });
    const mo = anchorOf(cfg, id === 'goblinshark' ? 0.16 : 0.1);
    addDeco(C, head, 'dark', 'maw', (B) => {
      B.add(P.sphLo(), xform(0, -mo.hd * 0.55, mo.z + 0.01, 0, 0, 0, mo.w * 1.6, mo.hu * 0.55, mo.w * 1.1));
    });
    if (armored) {
      addDeco(C, head, 'bone', 'plates', (B) => {
        for (let i = 0; i < 5; i++) {
          const u = 0.04 + i * 0.045;
          const an = anchorOf(cfg, u);
          if (an.k !== 0) continue;
          B.add(P.box(), xform(0, an.hu * 0.86, an.z, 0.12 - i * 0.03, 0, 0,
            an.w * 1.5, an.hu * 0.3, 0.05));
        }
        // shearing jaw blades instead of teeth
        B.add(P.box(), xform(0, -mo.hd * 0.12, mo.z - 0.01, 0.25, 0, 0, mo.w * 1.7, mo.hu * 0.42, 0.075));
        B.add(P.box(), xform(0, -mo.hd * 0.72, mo.z - 0.012, -0.2, 0, 0, mo.w * 1.5, mo.hu * 0.34, 0.07));
        for (let i = 0; i < 4; i++) {
          const s = i < 2 ? 1 : -1;
          B.add(P.cone4(), xform(s * mo.w * (0.25 + (i % 2) * 0.42), -mo.hd * 0.32, mo.z + 0.005,
            PI, 0, 0, mo.w * 0.22, mo.hu * 0.55, mo.w * 0.22));
        }
      });
    } else if (m.teeth) {
      addDeco(C, head, 'teeth', 'teeth', (B) => {
        teethArc(B, { y: -mo.hd * 0.2, z: mo.z + 0.01, zBack: -0.07, halfW: mo.w * 1.0, count: 13, len: mo.hu * 0.4, rad: mo.w * 0.07, dir: -1, rng: R });
        teethArc(B, { y: -mo.hd * 0.86, z: mo.z + 0.01, zBack: -0.06, halfW: mo.w * 0.9, count: 11, len: mo.hu * 0.34, rad: mo.w * 0.065, dir: 1, rng: R });
      });
    }
    if (id === 'goblinshark') {
      addDeco(C, head, 'body', 'snout', (B) => {
        const sn = anchorOf(cfg, 0.02);
        B.add(P.cone4(), xform(0, sn.hu * 0.25, cfg.nose * 0.5 + 0.02, -PI / 2, 0, 0,
          sn.w * 1.6, cfg.nose + 0.14, sn.hu * 0.7));
      });
    }
  } else { // angler
    addTailFin(C, cfg, nodes, 'tailFan', 0.13, 0.2);
    const d = anchorOf(cfg, 0.5);
    addDeco(C, nodes[d.k], 'fin', 'finsRear', (B) => {
      finTo(B, FIN.dorsalLong, 0, d.hu * 0.96, d.z, 0.18, 0.1);
      const an = anchorOf(cfg, 0.62);
      if (an.k === d.k) finTo(B, FIN.dorsalLong, 0, -an.hd * 0.96, an.z, 0.14, -0.09);
    });
    const pc = anchorOf(cfg, 0.42);
    addPectoral(C, nodes[pc.k], 'pec', FIN.pect, {
      x: pc.w * 0.85, y: -pc.hd * 0.4, z: pc.z,
      sx: 0.15, sy: 0.13, sweep: 0.4, droop: -0.5, amp: 0.4, rate: 2.6,
    });
    const e = anchorOf(cfg, 0.1);
    addEyes(C, head, { x: e.w * 0.62, y: e.hu * 0.5, z: e.z, r: e.w * 0.19, pr: 1.5 });
    // gaping jaw
    const mo = anchorOf(cfg, 0.06);
    const jaw = new THREE.Object3D();
    jaw.position.set(0, -mo.hd * 0.55, mo.z + 0.02);
    head.add(jaw);
    rig.wobble.push({ o: jaw, ax: 'x', base: 0.16, amp: 0.14, rate: 0.9, ph: 0.4 });
    addDeco(C, jaw, 'body', 'jaw', (B) => {
      B.add(P.sphLo(), xform(0, -mo.hd * 0.2, -0.09, 0, 0, 0, mo.w * 1.7, mo.hd * 0.7, 0.24));
    });
    addDeco(C, head, 'dark', 'maw', (B) => {
      B.add(P.sphLo(), xform(0, -mo.hd * 0.25, mo.z - 0.05, 0, 0, 0, mo.w * 1.5, mo.hu * 0.9, 0.2));
    });
    addDeco(C, head, 'teeth', 'teeth', (B) => {
      teethArc(B, { y: -mo.hd * 0.02, z: mo.z + 0.02, zBack: -0.08, halfW: mo.w * 0.95, count: 11, len: mo.hu * 0.62, rad: mo.w * 0.06, dir: -1, rng: R });
    });
    addDeco(C, jaw, 'teeth', 'teethLow', (B) => {
      teethArc(B, { y: 0.005, z: -0.02, zBack: -0.07, halfW: mo.w * 0.9, count: 10, len: mo.hu * 0.55, rad: mo.w * 0.06, dir: 1, rng: R });
    });
    // illicium: stalk of chained segments with a glowing lure
    const stalkSeg = C.geo('stalk', () => taperGeo(0.012, 0.008, 0.1, 5, 0, 0));
    const top = anchorOf(cfg, 0.12);
    let cur = new THREE.Object3D();
    cur.position.set(0, top.hu * 0.98, top.z);
    cur.rotation.x = -1.15;
    head.add(cur);
    const stalk = [];
    for (let i = 0; i < 4; i++) {
      if (i > 0) {
        const n2 = new THREE.Object3D();
        n2.position.set(0, 0, 0.1);
        n2.rotation.x = 0.3;
        cur.add(n2);
        cur = n2;
      }
      const sm = new THREE.Mesh(stalkSeg, C.mats.body);
      cur.add(sm);
      stalk.push({ o: cur, bx: cur.rotation.x, by: 0 });
    }
    rig.tent.push({ segs: stalk, rate: 1.3, amp: 0.1, ph: 0.5 });
    const bulb = new THREE.Mesh(P.sph(), C.mats.glow);
    bulb.position.set(0, 0, 0.11);
    bulb.scale.setScalar(0.075);
    cur.add(bulb);
    rig.lure = { mat: C.mats.glow, base: 2.1 };
    const halo = makeHalo(C, m.emissive != null ? m.emissive : 0x88ddff, 0.55, 0.5);
    halo.position.set(0, 0, 0.11);
    cur.add(halo);
    rig.lureHalo = halo;
  }
  return cfg;
}

function makeHalo(C, color, scale, opacity) {
  const mat = new THREE.SpriteMaterial({
    map: haloTex(), color, transparent: true, opacity,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true,
  });
  const s = new THREE.Sprite(mat);
  s.scale.set(scale, scale, 1);
  C.owned.push(mat);
  return s;
}

// horizontal fin into a merged builder (negative sx mirrors to the other flank)
function finToH(B, pts, x, y, z, sx, sy, bow) {
  const g = flatShape(pts, bow || 0);
  B.add(g, xform(x, y, z, -PI / 2, 0, 0, sx, sy, 1));
  g.dispose();
}

// ---------------------------------------------------------------
// EEL / SERPENT - long undulating chains
// ---------------------------------------------------------------
function buildSerpentine(C, parent, rig) {
  const m = C.m, id = C.id;
  const isSerp = m.shape === 'serpent';
  const cfg = shapeCfg(C, isSerp ? 'serpent' : 'eel');
  const nodes = addChain(C, parent, rig, cfg);
  const head = nodes[0];
  const R = C.R;
  const n = cfg.sections;
  const glowCol = m.emissive;

  // ribbon fin (and belly ribbon) riding every segment
  for (let k = 1; k < n; k++) {
    const ua = k / n, ub = (k + 1) / n;
    const pa = sampleProfile(cfg.profile, ua);
    const pb = sampleProfile(cfg.profile, (ua + ub) * 0.5);
    const f = k / n;
    addDeco(C, nodes[k], 'fin', 'rib' + k, (B) => {
      const hgt = isSerp
        ? (0.09 + 0.05 * Math.sin(f * PI)) * (1 - f * 0.55)
        : (m.finTint != null ? 0.055 : 0.03) * (1 - f * 0.4) + 0.012;
      const pts = isSerp ? FIN.frill : [[0, 0], [.03, 1], [.97, 1], [1, 0]];
      finTo(B, pts, 0, pa.hu * 0.9, 0, cfg.secLen * 1.02, hgt);
      if (!isSerp) finTo(B, [[0, 0], [.03, 1], [.97, 1], [1, 0]], 0, -pa.hd * 0.9, 0, cfg.secLen * 1.02, -hgt * 0.55);
      if (isSerp && k < n - 2) {
        // side frills every other segment
        if (k % 2 === 1) {
          finToH(B, FIN.wingFan, pb.w * 0.85, 0, -cfg.secLen * 0.45, 0.1 * (1 - f * 0.5), 0.09);
          finToH(B, FIN.wingFan, -pb.w * 0.85, 0, -cfg.secLen * 0.45, -0.1 * (1 - f * 0.5), 0.09);
        }
      }
    });
    if (glowCol != null && k % 2 === 1 && k < n - 1) {
      addDeco(C, nodes[k], 'glow', 'spot' + k, (B) => {
        const r = pa.w * 0.34;
        for (const s of [1, -1]) {
          B.add(P.sphTiny(), xform(s * pa.w * 0.85, -pa.hd * 0.15, -cfg.secLen * 0.5, 0, 0, 0, r, r, r * 1.6));
        }
      });
    }
  }

  const e = anchorOf(cfg, isSerp ? 0.035 : 0.05);
  const mo = anchorOf(cfg, 0.02);

  if (isSerp) {
    // dragon head
    addDeco(C, head, 'body', 'dhead', (B) => {
      B.add(P.sphLo(), xform(0, e.hu * 0.1, -0.012, 0, 0, 0, e.w * 2.5, e.hu * 2.3, 0.11));
      B.add(P.cone4(), xform(0, -e.hu * 0.1, 0.045, -PI / 2, 0, 0, e.w * 1.9, 0.1, e.hu * 1.5));
      for (const s of [1, -1]) {
        B.add(P.box(), xform(s * e.w * 0.9, e.hu * 0.85, 0.0, 0, 0, s * 0.3, e.w * 0.75, e.hu * 0.5, 0.075));
      }
    });
    addDeco(C, head, 'bone', 'horns', (B) => {
      for (const s of [1, -1]) {
        B.add(P.cone4(), xform(s * e.w * 0.85, e.hu * 1.05, -0.03, -0.7, s * 0.35, 0, e.w * 0.4, 0.13, e.w * 0.4));
        B.add(P.cone4(), xform(s * e.w * 1.0, e.hu * 0.35, -0.05, -1.2, s * 0.5, 0, e.w * 0.3, 0.08, e.w * 0.3));
      }
    });
    // jaw + fangs
    const jaw = new THREE.Object3D();
    jaw.position.set(0, -e.hu * 0.42, 0.02);
    head.add(jaw);
    rig.wobble.push({ o: jaw, ax: 'x', base: 0.1, amp: 0.09, rate: 0.7, ph: 1.4 });
    addDeco(C, jaw, 'body', 'djaw', (B) => {
      B.add(P.cone4(), xform(0, 0, 0.01, -PI / 2, 0, 0, e.w * 1.5, 0.085, e.hu * 0.7));
    });
    addDeco(C, head, 'teeth', 'teeth', (B) => {
      teethArc(B, { y: -e.hu * 0.3, z: 0.03, zBack: -0.05, halfW: e.w * 0.85, count: 8, len: e.hu * 0.6, rad: e.w * 0.1, dir: -1, rng: R });
    });
    addDeco(C, jaw, 'teeth', 'teethLow', (B) => {
      teethArc(B, { y: 0, z: 0.02, zBack: -0.045, halfW: e.w * 0.75, count: 7, len: e.hu * 0.5, rad: e.w * 0.09, dir: 1, rng: R });
    });
    addEyes(C, head, { x: e.w * 0.85, y: e.hu * 0.55, z: 0.012, r: e.w * 0.35, pr: 1.3 });
    if (glowCol != null) {
      addDeco(C, head, 'glow', 'headglow', (B) => {
        for (const s of [1, -1]) {
          B.add(P.sphTiny(), xform(s * e.w * 0.7, e.hu * 0.95, -0.06, 0, 0, 0, e.w * 0.4, e.w * 0.3, e.w * 0.5));
        }
      });
    }
    addWhiskers(C, head, { x: e.w * 0.8, y: -e.hu * 0.3, z: 0.03, r: e.w * 0.11, len: 0.2, pairs: 1, dy: 0 });
    // neck frills
    addDeco(C, head, 'fin', 'necfrill', (B) => {
      for (const s of [1, -1]) {
        finToH(B, FIN.frill, s * e.w * 0.9, e.hu * 0.2, -0.05, s * 0.15, 0.12);
      }
      finTo(B, FIN.frill, 0, e.hu * 0.95, -0.02, cfg.secLen * 1.1, 0.12);
    });
  } else {
    // eel head: pointed skull, hinged jaw
    addDeco(C, head, 'body', 'ehead', (B) => {
      B.add(P.sphLo(), xform(0, 0, -0.01, 0, 0, 0, e.w * 2.1, e.hu * 2.0, 0.085));
      if (id === 'gulper') {
        B.add(P.cone8(), xform(0, -e.hu * 0.75, 0.02, -PI / 2 + 0.25, 0, 0, e.w * 3.4, 0.3, e.hu * 3.2));
      }
    });
    addEyes(C, head, {
      x: e.w * 0.78, y: e.hu * 0.4, z: 0.02,
      r: e.w * (id === 'gulper' ? 0.24 : 0.36), pr: 1.4,
    });
    const jaw = new THREE.Object3D();
    jaw.position.set(0, -e.hu * 0.35, 0.015);
    head.add(jaw);
    rig.wobble.push({ o: jaw, ax: 'x', base: 0.12, amp: 0.1, rate: 1.1, ph: 0.8 });
    addDeco(C, jaw, 'body', 'ejaw', (B) => {
      B.add(P.cone4(), xform(0, 0, 0.015, -PI / 2, 0, 0, e.w * 1.5, 0.075, e.hu * 0.8));
    });
    addDeco(C, head, 'dark', 'maw', (B) => {
      B.add(P.sphLo(), xform(0, -e.hu * 0.25, 0.03, 0, 0, 0, e.w * 1.3, e.hu * 0.8, 0.07));
    });
    if (m.teeth) {
      addDeco(C, head, 'teeth', 'teeth', (B) => {
        const long = id === 'viperfish' ? 1.9 : 1.0;
        teethArc(B, { y: -e.hu * 0.2, z: 0.04, zBack: -0.05, halfW: e.w * 0.8, count: 9, len: e.hu * 0.55 * long, rad: e.w * 0.1, dir: -1, rng: R });
      });
      addDeco(C, jaw, 'teeth', 'teethLow', (B) => {
        const long = id === 'viperfish' ? 2.2 : 1.0;
        teethArc(B, { y: 0, z: 0.03, zBack: -0.045, halfW: e.w * 0.72, count: 8, len: e.hu * 0.5 * long, rad: e.w * 0.09, dir: 1, rng: R });
      });
    }
    if (id === 'frilledshark') {
      addDeco(C, head, 'fin', 'gfrill', (B) => {
        for (let i = 0; i < 6; i++) {
          const u = 0.05 + i * 0.016;
          const p = sampleProfile(cfg.profile, u);
          const z = localZ(cfg, 0, u);
          finToH(B, FIN.wingFan, p.w * 0.85, -p.hd * 0.3, z, 0.045, 0.05);
          finToH(B, FIN.wingFan, -p.w * 0.85, -p.hd * 0.3, z, -0.045, 0.05);
        }
      });
    }
    if (id === 'oarfish') {
      // trailing pelvic oars + a crimson head crest
      addDeco(C, head, 'fin', 'oars', (B) => {
        for (const s of [1, -1]) {
          B.add(P.cyl8(), xform(s * e.w * 0.7, -e.hu * 0.6, -0.16, PI / 2, 0, 0, 0.008, 0.34, 0.008));
          finTo(B, FIN.tailPaddle, s * e.w * 0.7, -e.hu * 0.6, -0.34, 0.07, 0.05);
        }
        for (let i = 0; i < 5; i++) {
          finTo(B, FIN.spineRay, 0, e.hu * 0.95, -0.01 - i * 0.012, 0.13 - i * 0.01, 0.05, 0.008);
        }
      });
    }
    if (glowCol != null) {
      addDeco(C, head, 'glow', 'headglow', (B) => {
        for (const s of [1, -1]) {
          B.add(P.sphTiny(), xform(s * e.w * 0.55, -e.hu * 0.55, 0.03, 0, 0, 0, e.w * 0.3, e.w * 0.3, e.w * 0.3));
        }
        if (id === 'gulper') B.add(P.sphLo(), xform(0, 0, -0.02, 0, 0, 0, 0.03, 0.03, 0.03));
      });
    }
    // barracuda / predators keep proper fins
    if (id === 'barracuda' || id === 'eleel' || id === 'viperfish' || id === 'frilledshark') {
      const pc = anchorOf(cfg, 0.16);
      addPectoral(C, nodes[pc.k], 'pec', FIN.pect, {
        x: pc.w * 0.85, y: -pc.hd * 0.3, z: pc.z,
        sx: 0.11, sy: 0.09, sweep: 0.5, droop: -0.4, amp: 0.3, rate: 3.4,
      });
    }
    if (id === 'barracuda') {
      addTailFin(C, cfg, nodes, 'tailFork', 0.12, 0.16);
      const d = anchorOf(cfg, 0.42);
      addDeco(C, nodes[d.k], 'fin', 'bdors', (B) => {
        finTo(B, FIN.dorsal, 0, d.hu * 0.95, d.z, 0.1, 0.09);
      });
    } else if (id === 'gulper') {
      // whip tail ending in a glowing tip
      const tn = nodes[nodes.length - 1];
      addDeco(C, tn, 'glow', 'taillight', (B) => {
        B.add(P.sphTiny(), xform(0, 0, -cfg.secLen * 1.05, 0, 0, 0, 0.022, 0.022, 0.03));
      });
    } else {
      addTailFin(C, cfg, nodes, 'tailPaddle', 0.06, 0.05);
    }
  }
  return cfg;
}

// ---------------------------------------------------------------
// FLAT - flounder: flattened oval, both eyes topside
// ---------------------------------------------------------------
function buildFlat(C, parent, rig) {
  const cfg = shapeCfg(C, 'flat');
  const nodes = addChain(C, parent, rig, cfg, 'x', 1);
  const head = nodes[0];
  const R = C.R;
  const n = cfg.sections;
  for (let k = 0; k < n; k++) {
    const kk = k;
    addDeco(C, nodes[k], 'fin', 'fringe' + k, (B) => {
      for (let i = 0; i < 7; i++) {
        const u = (kk + (i + 0.5) / 7) / n;
        const p = sampleProfile(cfg.profile, u);
        const z = localZ(cfg, kk, u);
        const s = 0.05 + 0.03 * Math.sin(u * PI);
        finToH(B, FIN.wingFan, p.w * 0.95, p.hu * 0.1, z, s, cfg.secLen / 7 * 1.6);
        finToH(B, FIN.wingFan, -p.w * 0.95, p.hu * 0.1, z, -s, cfg.secLen / 7 * 1.6);
      }
    });
    if (k > 0) {
      rig.wobble.push({
        o: nodes[k], ax: 'z', base: 0, amp: 0.06, rate: 3.4, ph: -k * 1.1,
      });
    }
  }
  addTailFin(C, cfg, nodes, 'tailFan', 0.09, 0.1);
  const e = anchorOf(cfg, 0.12);
  // both eyes topside, offset like a real flatfish
  addDeco(C, head, 'eye', 'eyeball', (B) => {
    B.add(P.sph(), xform(e.w * 0.3, e.hu * 0.95, e.z, 0, 0, 0, 0.05, 0.045, 0.05));
    B.add(P.sph(), xform(-e.w * 0.12, e.hu * 1.0, e.z - 0.045, 0, 0, 0, 0.05, 0.045, 0.05));
  });
  addDeco(C, head, 'pupil', 'pup', (B) => {
    B.add(P.sphLo(), xform(e.w * 0.3, e.hu * 1.06, e.z + 0.008, 0, 0, 0, 0.028, 0.028, 0.028));
    B.add(P.sphLo(), xform(-e.w * 0.12, e.hu * 1.11, e.z - 0.037, 0, 0, 0, 0.028, 0.028, 0.028));
  });
  const mo = anchorOf(cfg, 0.03);
  addDeco(C, head, 'dark', 'mouth', (B) => {
    B.add(P.box(), xform(-mo.w * 0.2, -mo.hd * 0.2, mo.z + 0.005, 0, 0.4, 0, mo.w * 1.2, mo.hu * 0.5, mo.w * 0.4));
  });
  rig.wobble.push({ o: head, ax: 'z', base: 0, amp: 0.05, rate: 2.6, ph: 0 });
  return cfg;
}

// ---------------------------------------------------------------
// RAY - diamond wings + whip tail
// ---------------------------------------------------------------
function buildRay(C, parent, rig) {
  const m = C.m;
  const R = C.R;
  const disc = new THREE.Object3D();
  parent.add(disc);
  // central body
  addDeco(C, disc, 'body', 'core', (B) => {
    B.add(P.sph(), xform(0, 0, 0.06, 0, 0, 0, 0.17, 0.085, 0.5));
    B.add(P.cone4(), xform(0, 0, 0.42, -PI / 2, 0, 0, 0.13, 0.14, 0.06));
  });
  const WING = [
    [[0, .30], [.16, .245], [.16, -.155], [0, -.225]],
    [[0, .245], [.15, .14], [.15, -.115], [0, -.155]],
    [[0, .14], [.145, .0], [0, -.115]],
  ];
  const SPAN = [0.16, 0.15, 0.145];
  for (const side of [1, -1]) {
    const mir = new THREE.Object3D();
    mir.position.set(0.07 * side, 0, 0.02);
    mir.scale.x = side;
    disc.add(mir);
    let cur = mir;
    for (let i = 0; i < 3; i++) {
      const piv = new THREE.Object3D();
      if (i > 0) piv.position.set(SPAN[i - 1], 0, i === 1 ? 0.02 : 0.03);
      cur.add(piv);
      const g = C.geo('wing' + i, () => plateGeo(WING[i], 0.05 - i * 0.012, 0.14, 0.5));
      const mesh = new THREE.Mesh(g, C.mats.body);
      mesh.castShadow = C.big;
      piv.add(mesh);
      rig.wobble.push({
        o: piv, ax: 'z', base: i === 0 ? 0.05 : 0.08,
        amp: 0.2 + i * 0.16, rate: 1.5, ph: -i * 0.8,
      });
      cur = piv;
    }
  }
  // whip tail
  let cur = new THREE.Object3D();
  cur.position.set(0, 0.01, -0.24);
  disc.add(cur);
  const segs = [];
  for (let i = 0; i < 6; i++) {
    if (i > 0) {
      const n2 = new THREE.Object3D();
      n2.position.set(0, 0, -0.045);
      cur.add(n2);
      cur = n2;
    }
    const r0 = 0.026 * Math.pow(0.78, i);
    const g = C.geo('tseg' + i, () => taperGeo(r0, r0 * 0.78, 0.045, 6, 0, 0));
    const mesh = new THREE.Mesh(g, C.mats.body);
    mesh.rotation.y = PI; // taper points +Z -> flip to run backward
    cur.add(mesh);
    segs.push({ o: cur, bx: 0, by: 0 });
  }
  rig.tent.push({ segs, rate: 1.9, amp: 0.16, ph: 0 });
  addDeco(C, cur, 'bone', 'barb', (B) => {
    B.add(P.cone4(), xform(0, 0, -0.03, PI / 2, 0, 0, 0.016, 0.07, 0.016));
  });
  // eyes + spiracles topside, mouth + gills underneath
  addDeco(C, disc, 'eye', 'eyeball', (B) => {
    for (const s of [1, -1]) B.add(P.sph(), xform(s * 0.05, 0.055, 0.3, 0, 0, 0, 0.045, 0.04, 0.045));
  });
  addDeco(C, disc, 'pupil', 'pup', (B) => {
    for (const s of [1, -1]) B.add(P.sphLo(), xform(s * 0.055, 0.072, 0.31, 0, 0, 0, 0.026, 0.026, 0.026));
  });
  addDeco(C, disc, 'dark', 'under', (B) => {
    B.add(P.box(), xform(0, -0.05, 0.26, 0, 0, 0, 0.1, 0.012, 0.03));
    for (let i = 0; i < 5; i++) {
      for (const s of [1, -1]) {
        B.add(P.box(), xform(s * (0.05 + i * 0.012), -0.045, 0.16 - i * 0.035, 0, 0.3 * s, 0, 0.012, 0.01, 0.05));
      }
    }
    for (const s of [1, -1]) B.add(P.sphLo(), xform(s * 0.075, 0.045, 0.24, 0, 0, 0, 0.03, 0.02, 0.035));
  });
  rig.wobble.push({ o: disc, ax: 'x', base: 0, amp: 0.05, rate: 1.5, ph: 1.6 });
  return null;
}

// radial crown of tentacles / arms
function addArms(C, rig, parent, o) {
  for (let a = 0; a < o.count; a++) {
    const th = (a / o.count) * TAU + (o.rot || 0);
    const spin = new THREE.Object3D();
    spin.rotation.z = th;
    spin.position.set(Math.sin(th) * o.ringR, -Math.cos(th) * o.ringR * (o.yScale || 1), o.z);
    parent.add(spin);
    const long = o.longEvery ? (a % o.longEvery === 0) : false;
    const kind = long ? 'L' : 'A';
    let cur = spin;
    const segs = [];
    for (let i = 0; i < o.segs; i++) {
      const node = new THREE.Object3D();
      const segLen = o.len * Math.pow(o.taper || 0.88, i) * (long ? 1.55 : 1);
      if (i === 0) node.rotation.x = o.splay;
      else {
        node.position.set(0, 0, o.len * Math.pow(o.taper || 0.88, i - 1) * (long ? 1.55 : 1));
        node.rotation.x = o.curl;
      }
      cur.add(node);
      cur = node;
      const r0 = o.r0 * Math.pow(o.rTaper || 0.8, i) * (long ? 0.7 : 1);
      const r1 = o.r0 * Math.pow(o.rTaper || 0.8, i + 1) * (long ? 0.7 : 1);
      const g = C.geo('arm' + kind + i, () => taperGeo(r0, r1, segLen, 6, o.suckers && i < 3 ? 3 : 0, 0));
      const mesh = new THREE.Mesh(g, C.mats.body);
      mesh.castShadow = C.big;
      node.add(mesh);
      segs.push({ o: node, bx: node.rotation.x, by: 0 });
      if (long && i === o.segs - 1) {
        // club paddle at the tip of the long feeding tentacles
        addDeco(C, node, 'body', 'club', (B) => {
          B.add(P.sphLo(), xform(0, 0, segLen * 0.9, 0, 0, 0, r1 * 3.4, r1 * 1.6, segLen * 0.75));
        });
      }
    }
    rig.tent.push({
      segs, rate: o.rate, amp: o.amp,
      ph: a * (o.phaseStep == null ? 0.7 : o.phaseStep),
    });
  }
}

// ---------------------------------------------------------------
// SQUID - mantle cone, fins, big eyes, 8 arms + 2 tentacles
// ---------------------------------------------------------------
function buildSquid(C, parent, rig) {
  const cfg = shapeCfg(C, 'squid');
  cfg.zNose = 0.14;
  cfg.zTail = -0.5;
  const nodes = addChain(C, parent, rig, cfg, 'y', 0.5);
  const head = nodes[0];
  const tail = nodes[nodes.length - 1];
  // mantle fins near the tip
  const pf = sampleProfile(cfg.profile, 0.72);
  addPectoral(C, tail, 'mfin', FIN.wingFan, {
    x: pf.w * 0.5, y: 0, z: -cfg.secLen * 0.25,
    sx: 0.2, sy: 0.26, sweep: -0.35, droop: 0, bow: 0.03, amp: 0.28, rate: 1.4,
  });
  // head block + eyes
  const hp = sampleProfile(cfg.profile, 0.02);
  addDeco(C, head, 'body', 'shead', (B) => {
    B.add(P.sphLo(), xform(0, 0, 0.055, 0, 0, 0, hp.w * 1.9, hp.hu * 1.75, 0.16));
  });
  addEyes(C, head, { x: hp.w * 0.95, y: hp.hu * 0.1, z: 0.075, r: hp.w * 0.55, pr: 0.9, key: 'sq' });
  const crown = new THREE.Object3D();
  crown.position.set(0, 0, 0.12);
  head.add(crown);
  addDeco(C, crown, 'dark', 'beak', (B) => {
    B.add(P.cone4(), xform(0, 0, 0.02, -PI / 2, 0, 0, hp.w * 0.5, 0.05, hp.w * 0.5));
  });
  addArms(C, rig, crown, {
    count: 10, segs: 4, len: 0.085, r0: 0.03, ringR: hp.w * 0.62, yScale: 1,
    splay: 0.5, curl: 0.16, rate: 1.9, amp: 0.2, taper: 0.9, rTaper: 0.76,
    suckers: true, longEvery: 5, z: 0.01, phaseStep: 0.62,
  });
  return cfg;
}

// ---------------------------------------------------------------
// OCTOPUS - dome mantle, slit eyes, 8 curling arms
// ---------------------------------------------------------------
function buildOctopus(C, parent, rig) {
  const m = C.m;
  const body = new THREE.Object3D();
  parent.add(body);
  rig.pulse.push({ o: body, sx: 1, sy: 1, sz: 1, amp: 0.035, rate: 0.9, ph: 0 });
  addDeco(C, body, 'body', 'dome', (B) => {
    B.add(P.sph(), xform(0, 0.03, -0.12, 0, 0, 0, 0.42, 0.44, 0.62));
    B.add(P.sph(), xform(0, 0.0, 0.16, 0, 0, 0, 0.36, 0.3, 0.3));
    // brow ridges + skin papillae
    for (const s of [1, -1]) {
      B.add(P.sphLo(), xform(s * 0.14, 0.14, 0.13, 0, 0, s * 0.3, 0.16, 0.09, 0.14));
    }
    const R = C.R;
    for (let i = 0; i < 10; i++) {
      const th = R() * TAU, ph2 = 0.25 + R() * 0.9;
      const rr = 0.2;
      B.add(P.sphTiny(), xform(
        Math.sin(ph2) * Math.cos(th) * rr, Math.cos(ph2) * rr * 0.9, Math.sin(ph2) * Math.sin(th) * 0.3 - 0.1,
        0, 0, 0, 0.05, 0.03, 0.05,
      ));
    }
  });
  addDeco(C, body, 'eye', 'eyeball', (B) => {
    for (const s of [1, -1]) B.add(P.sph(), xform(s * 0.17, 0.1, 0.14, 0, 0, 0, 0.15, 0.13, 0.15));
  });
  addDeco(C, body, 'pupil', 'pup', (B) => {
    for (const s of [1, -1]) B.add(P.box(), xform(s * 0.2, 0.11, 0.16, 0, 0, s * 0.12, 0.1, 0.028, 0.09));
  });
  if (m.emissive != null) {
    addDeco(C, body, 'glow', 'gspots', (B) => {
      const R = C.R;
      for (let i = 0; i < 12; i++) {
        const th = R() * TAU, rr = 0.16 + R() * 0.12;
        B.add(P.sphTiny(), xform(Math.cos(th) * rr, 0.05 + Math.sin(th) * rr * 0.7, -0.1 - R() * 0.3,
          0, 0, 0, 0.035, 0.035, 0.035));
      }
    });
  }
  const crown = new THREE.Object3D();
  crown.position.set(0, -0.04, 0.2);
  body.add(crown);
  addDeco(C, crown, 'dark', 'beak', (B) => {
    B.add(P.cone4(), xform(0, 0, 0.02, -PI / 2, 0, 0, 0.07, 0.07, 0.07));
  });
  addArms(C, rig, crown, {
    count: 8, segs: 5, len: 0.115, r0: 0.055, ringR: 0.14, yScale: 0.85,
    splay: 0.75, curl: 0.3, rate: 1.35, amp: 0.24, taper: 0.87, rTaper: 0.78,
    suckers: true, z: 0, phaseStep: 0.78,
  });
  return null;
}

// ---------------------------------------------------------------
// PUFFER - spiky ball with a cute face
// ---------------------------------------------------------------
function buildPuffer(C, parent, rig) {
  const cfg = shapeCfg(C, 'puffer');
  const pulse = new THREE.Object3D();
  parent.add(pulse);
  rig.pulse.push({ o: pulse, sx: 1, sy: 1, sz: 1, amp: 0.05, rate: 1.6, ph: 0 });
  const nodes = addChain(C, pulse, rig, cfg, 'y', 0.6);
  const head = nodes[0];
  const R = C.R;
  addDeco(C, head, 'bone', 'spikes', (B) => {
    const cone = P.cone4();
    for (let i = 0; i < 46; i++) {
      const u = 0.1 + R() * 0.8;
      const th = R() * TAU;
      const p = sampleProfile(cfg.profile, u);
      const k = Math.floor(u * cfg.sections);
      if (k !== 0) continue;
      const x = Math.sin(th) * p.w, y = Math.cos(th) * (Math.cos(th) >= 0 ? p.hu : p.hd);
      const z = localZ(cfg, 0, u);
      const len = 0.075 + R() * 0.05;
      const ang = Math.atan2(x, y);
      B.add(cone, xform(x * 1.02, y * 1.02, z, 0, 0, -ang, 0.03, len, 0.03));
    }
  });
  addDeco(C, nodes[1], 'bone', 'spikes2', (B) => {
    const cone = P.cone4();
    for (let i = 0; i < 22; i++) {
      const u = 0.5 + R() * 0.38;
      const th = R() * TAU;
      const p = sampleProfile(cfg.profile, u);
      const k = Math.floor(u * cfg.sections);
      if (k !== 1) continue;
      const x = Math.sin(th) * p.w, y = Math.cos(th) * (Math.cos(th) >= 0 ? p.hu : p.hd);
      const len = 0.06 + R() * 0.04;
      const ang = Math.atan2(x, y);
      B.add(cone, xform(x * 1.02, y * 1.02, localZ(cfg, 1, u), 0, 0, -ang, 0.026, len, 0.026));
    }
  });
  addTailFin(C, cfg, nodes, 'tailFan', 0.13, 0.16);
  const e = anchorOf(cfg, 0.13);
  addEyes(C, head, { x: e.w * 0.72, y: e.hu * 0.42, z: e.z + 0.02, r: e.w * 0.3, pr: 1.15 });
  const mo = anchorOf(cfg, 0.02);
  addDeco(C, head, 'dark', 'mouth', (B) => {
    B.add(P.sphLo(), xform(0, -mo.hd * 0.32, mo.z + 0.02, 0, 0, 0, mo.w * 0.55, mo.hu * 0.38, mo.w * 0.3));
  });
  addDeco(C, head, 'teeth', 'beak', (B) => {
    B.add(P.box(), xform(0, -mo.hd * 0.22, mo.z + 0.03, 0, 0, 0, mo.w * 0.5, mo.hu * 0.1, mo.w * 0.16));
    B.add(P.box(), xform(0, -mo.hd * 0.42, mo.z + 0.03, 0, 0, 0, mo.w * 0.45, mo.hu * 0.09, mo.w * 0.16));
  });
  const pc = anchorOf(cfg, 0.4);
  addPectoral(C, nodes[pc.k], 'pec', FIN.pectRound, {
    x: pc.w * 0.9, y: 0, z: pc.z, sx: 0.13, sy: 0.11,
    sweep: 0.3, droop: 0, bow: 0.02, amp: 0.55, rate: 8.5,
  });
  return cfg;
}

// ---------------------------------------------------------------
// BLOB - leviathan / bloop calf: an unsettling mass
// ---------------------------------------------------------------
function buildBlob(C, parent, rig) {
  const m = C.m;
  const R = C.R;
  const cfg = shapeCfg(C, 'blob');
  const s1 = R() * TAU, s2 = R() * TAU, s3 = R() * TAU;
  cfg.lump = (u, th) => 1
    + 0.075 * Math.sin(3 * th + u * 9 + s1)
    + 0.055 * Math.sin(5 * th - u * 13 + s2)
    + 0.05 * Math.sin(u * 7 * PI + s3);
  const pulse = new THREE.Object3D();
  parent.add(pulse);
  rig.pulse.push({ o: pulse, sx: 1, sy: 1, sz: 1, amp: 0.03, rate: 0.62, ph: 0 });
  const nodes = addChain(C, pulse, rig, cfg, 'y', 0.7);
  const head = nodes[0];
  const e = anchorOf(cfg, 0.16);
  // a scatter of small deep-set eyes - never symmetric enough to feel right
  addDeco(C, head, 'eye', 'eyeball', (B) => {
    for (let i = 0; i < 7; i++) {
      const th = (R() - 0.5) * 2.1;
      const u = 0.08 + R() * 0.22;
      const p = sampleProfile(cfg.profile, u);
      const rr = 0.02 + R() * 0.022;
      B.add(P.sphLo(), xform(
        Math.sin(th) * p.w * 0.9, Math.cos(th) * p.hu * 0.85 * 0.6 + p.hu * 0.15,
        localZ(cfg, 0, u) + 0.01, 0, 0, 0, rr * 2, rr * 2, rr * 2,
      ));
    }
  });
  addDeco(C, head, 'glow', 'eyeglow', (B) => {
    const R2 = rngFor(hashStr(C.id + 'eyes'));
    for (let i = 0; i < 7; i++) {
      const th = (R2() - 0.5) * 2.1;
      const u = 0.08 + R2() * 0.22;
      const p = sampleProfile(cfg.profile, u);
      const rr = (0.02 + R2() * 0.022) * 0.62;
      B.add(P.sphTiny(), xform(
        Math.sin(th) * p.w * 0.94, Math.cos(th) * p.hu * 0.85 * 0.6 + p.hu * 0.15,
        localZ(cfg, 0, u) + 0.02 + rr, 0, 0, 0, rr * 2, rr * 2, rr * 2,
      ));
    }
  });
  // maw
  const mo = anchorOf(cfg, 0.06);
  const jaw = new THREE.Object3D();
  jaw.position.set(0, -mo.hd * 0.35, mo.z + 0.02);
  head.add(jaw);
  rig.wobble.push({ o: jaw, ax: 'x', base: 0.18, amp: 0.13, rate: 0.42, ph: 0.9 });
  addDeco(C, head, 'dark', 'maw', (B) => {
    B.add(P.sphLo(), xform(0, -mo.hd * 0.3, mo.z + 0.04, 0, 0, 0, mo.w * 1.15, mo.hu * 0.75, 0.2));
  });
  addDeco(C, jaw, 'body', 'jaw', (B) => {
    B.add(P.sphLo(), xform(0, -0.03, -0.06, 0, 0, 0, mo.w * 1.2, mo.hd * 0.5, 0.24));
  });
  if (m.teeth) {
    addDeco(C, head, 'teeth', 'teeth', (B) => {
      teethArc(B, { y: -mo.hd * 0.12, z: mo.z + 0.05, zBack: -0.11, halfW: mo.w * 0.85, count: 14, len: mo.hu * 0.42, rad: mo.w * 0.05, dir: -1, rng: R });
    });
    addDeco(C, jaw, 'teeth', 'teethLow', (B) => {
      teethArc(B, { y: 0.0, z: 0.02, zBack: -0.1, halfW: mo.w * 0.8, count: 12, len: mo.hu * 0.36, rad: mo.w * 0.05, dir: 1, rng: R });
    });
  }
  // glowing seams
  if (m.emissive != null) {
    for (let k = 0; k < cfg.sections; k++) {
      const kk = k;
      addDeco(C, nodes[k], 'glow', 'seam' + k, (B) => {
        const R2 = rngFor(hashStr(C.id + 'seam' + kk));
        for (let i = 0; i < 9; i++) {
          const u = (kk + R2()) / cfg.sections;
          const th = R2() * TAU;
          const p = sampleProfile(cfg.profile, u);
          const rr = 0.012 + R2() * 0.016;
          B.add(P.sphTiny(), xform(
            Math.sin(th) * p.w * 0.97, Math.cos(th) * (Math.cos(th) >= 0 ? p.hu : p.hd) * 0.97,
            localZ(cfg, kk, u), 0, 0, 0, rr * 2, rr * 2, rr * 2,
          ));
        }
      });
    }
  }
  // hanging bits
  const tailN = nodes[cfg.sections - 1];
  for (let a = 0; a < 12; a++) {
    const th = (a / 12) * TAU;
    const u = 0.4 + (a % 3) * 0.14;
    const p = sampleProfile(cfg.profile, u);
    const k = Math.min(cfg.sections - 1, Math.floor(u * cfg.sections));
    const spin = new THREE.Object3D();
    spin.rotation.z = th * 0.35 + (a % 2 ? 0.4 : -0.4);
    spin.position.set(Math.sin(th) * p.w * 0.8, -p.hd * (0.55 + 0.35 * Math.cos(th)), localZ(cfg, k, u));
    nodes[k].add(spin);
    let cur = spin;
    const segs = [];
    for (let i = 0; i < 4; i++) {
      const node = new THREE.Object3D();
      const L = 0.13 * Math.pow(0.85, i) * (0.7 + (a % 4) * 0.15);
      if (i === 0) node.rotation.x = 1.75;
      else { node.position.set(0, 0, 0.13 * Math.pow(0.85, i - 1) * (0.7 + (a % 4) * 0.15)); node.rotation.x = 0.12; }
      cur.add(node);
      cur = node;
      const r0 = 0.024 * Math.pow(0.72, i);
      const g = C.geo('bit' + (a % 4) + i, () => taperGeo(r0, r0 * 0.72, L, 5, 0, 0));
      const mesh = new THREE.Mesh(g, C.mats.body);
      node.add(mesh);
      segs.push({ o: node, bx: node.rotation.x, by: 0 });
    }
    rig.tent.push({ segs, rate: 0.55 + (a % 3) * 0.12, amp: 0.18, ph: a * 0.5 });
  }
  // tail nub fins
  addDeco(C, tailN, 'fin', 'nub', (B) => {
    finTo(B, FIN.tailPaddle, 0, 0, -cfg.secLen * 0.9, 0.14, 0.18);
  });
  if (m.emissive != null) {
    const halo = makeHalo(C, m.emissive, 1.9, 0.16);
    halo.position.set(0, 0, 0.05);
    pulse.add(halo);
    rig.bodyHalo = halo;
  }
  return cfg;
}

// ---------------------------------------------------------------
// mutation FX
// ---------------------------------------------------------------
function makePoints(C, count, color, sizeFrac, opacity, additive, vertexColors) {
  const pos = new Float32Array(count * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (vertexColors) {
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  }
  const mat = new THREE.PointsMaterial({
    size: Math.max(0.01, C.len * sizeFrac), map: dotTex(), color,
    transparent: true, opacity, depthWrite: false, sizeAttenuation: true,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    vertexColors: !!vertexColors,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  C.owned.push(mat, geo);
  return pts;
}

function addMutationFX(C, parent, rig, mut, cfg) {
  if (!mut) return;
  const M = MUTATIONS[mut];
  if (!M) return;
  const R = rngFor(hashStr(C.id + mut));
  const mats = C.mats;
  const st = { kind: M.fx, mats: mats.list, body: mats.body };
  const spin = new THREE.Object3D();
  parent.add(spin);
  st.spin = spin;

  const scatter = (arr, n, rx, ry, rz, inner) => {
    for (let i = 0; i < n; i++) {
      const th = R() * TAU;
      const ph = Math.acos(2 * R() - 1);
      const rad = inner + (1 - inner) * Math.pow(R(), 0.4);
      arr[i * 3] = Math.sin(ph) * Math.cos(th) * rx * rad;
      arr[i * 3 + 1] = Math.cos(ph) * ry * rad;
      arr[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * rz * rad;
    }
  };

  switch (M.fx) {
    case 'sparkle': {
      const pts = makePoints(C, 26, 0xffe9a0, 0.075, 0.9, true, false);
      scatter(pts.geometry.attributes.position.array, 26, 0.34, 0.26, 0.52, 0.62);
      spin.add(pts);
      st.pmat = pts.material;
      break;
    }
    case 'hueShift': {
      const pts = makePoints(C, 20, 0xffffff, 0.06, 0.75, true, false);
      scatter(pts.geometry.attributes.position.array, 20, 0.3, 0.24, 0.5, 0.7);
      spin.add(pts);
      st.pmat = pts.material;
      break;
    }
    case 'voidParticles': {
      const pts = makePoints(C, 28, 0x8a3cff, 0.09, 0.75, true, false);
      scatter(pts.geometry.attributes.position.array, 28, 0.4, 0.32, 0.6, 0.55);
      spin.add(pts);
      st.pmat = pts.material;
      const halo = makeHalo(C, 0x3a0d6e, 2.2, 0.3);
      parent.add(halo);
      st.halo = halo;
      break;
    }
    case 'ghost': {
      const pts = makePoints(C, 22, 0xaaddff, 0.085, 0.5, true, false);
      scatter(pts.geometry.attributes.position.array, 22, 0.33, 0.3, 0.55, 0.4);
      spin.add(pts);
      st.pmat = pts.material;
      const halo = makeHalo(C, 0x88ccff, 1.7, 0.2);
      parent.add(halo);
      st.halo = halo;
      st.gmats = mats.list.concat([mats.eye, mats.pupil]);
      break;
    }
    case 'embers': {
      const n = 24;
      const pts = makePoints(C, n, 0xffffff, 0.07, 0.95, true, true);
      const base = new Float32Array(n * 4);
      const pa = pts.geometry.attributes.position.array;
      for (let i = 0; i < n; i++) {
        base[i * 4] = (R() - 0.5) * 0.34;
        base[i * 4 + 1] = (R() - 0.5) * 0.8;
        base[i * 4 + 2] = 0.22 + R() * 0.3;
        base[i * 4 + 3] = R();
        pa[i * 3] = base[i * 4];
        pa[i * 3 + 2] = base[i * 4 + 1];
      }
      parent.add(pts);
      st.ebase = base;
      st.ecount = n;
      st.eattr = pts.geometry.attributes.position;
      st.ecattr = pts.geometry.attributes.color;
      st.pmat = pts.material;
      break;
    }
    case 'facets': {
      const pts = makePoints(C, 18, 0xdff6ff, 0.055, 0.7, true, false);
      scatter(pts.geometry.attributes.position.array, 18, 0.32, 0.26, 0.5, 0.7);
      spin.add(pts);
      st.pmat = pts.material;
      // chunky ice shards growing out of the body
      const nodes = cfg && cfg.nodes ? cfg.nodes : null;
      if (nodes) {
        for (let k = 0; k < nodes.length; k++) {
          const kk = k;
          addDeco(C, nodes[k], 'bone', 'shardX' + kk, (B) => {
            const R2 = rngFor(hashStr(C.id + 'shard' + kk));
            for (let i = 0; i < 3; i++) {
              const u = (kk + 0.15 + R2() * 0.7) / cfg.sections;
              const th = R2() * TAU;
              const p = sampleProfile(cfg.profile, u);
              const sz = 0.045 + R2() * 0.06;
              B.add(P.octa(), xform(
                Math.sin(th) * p.w * 0.8, Math.cos(th) * (Math.cos(th) >= 0 ? p.hu : p.hd) * 0.8,
                localZ(cfg, kk, u), R2() * 3, R2() * 3, R2() * 3,
                sz, sz * 1.7, sz,
              ));
            }
          });
        }
      } else {
        addDeco(C, parent, 'bone', 'shardX', (B) => {
          const R2 = rngFor(hashStr(C.id + 'shardB'));
          for (let i = 0; i < 9; i++) {
            const th = R2() * TAU, ph = Math.acos(2 * R2() - 1);
            const sz = 0.05 + R2() * 0.07;
            B.add(P.octa(), xform(
              Math.sin(ph) * Math.cos(th) * 0.26, Math.cos(ph) * 0.16, Math.sin(ph) * Math.sin(th) * 0.3,
              R2() * 3, R2() * 3, R2() * 3, sz, sz * 1.7, sz,
            ));
          }
        });
      }
      break;
    }
    default: break;
  }
  rig.mut = st;
}

function mutUpdate(s, t) {
  switch (s.kind) {
    case 'sparkle': {
      s.spin.rotation.y = t * 0.8;
      s.spin.rotation.x = Math.sin(t * 0.55) * 0.5;
      if (s.pmat) s.pmat.opacity = 0.55 + Math.sin(t * 5.5) * 0.35;
      s.body.emissiveIntensity = 0.3 + Math.sin(t * 2.2) * 0.15;
      break;
    }
    case 'hueShift': {
      const h = (t * 0.13) % 1;
      for (let i = 0; i < s.mats.length; i++) {
        s.mats[i].color.setHSL(h, 0.85, 0.58);
        s.mats[i].emissive.setHSL((h + 0.5) % 1, 0.9, 0.13);
      }
      s.spin.rotation.y = t * 0.6;
      if (s.pmat) s.pmat.color.setHSL((h + 0.35) % 1, 1, 0.72);
      break;
    }
    case 'voidParticles': {
      s.spin.rotation.y = -t * 0.32;
      s.spin.rotation.z = Math.sin(t * 0.4) * 0.35;
      s.body.emissiveIntensity = 1.25 + Math.sin(t * 1.3) * 0.35;
      if (s.halo) s.halo.material.opacity = 0.26 + Math.sin(t * 0.9) * 0.08;
      break;
    }
    case 'ghost': {
      const o = 0.34 + Math.sin(t * 1.7) * 0.13;
      for (let i = 0; i < s.gmats.length; i++) s.gmats[i].opacity = o;
      s.spin.rotation.y = t * 0.5;
      s.spin.rotation.x = Math.sin(t * 0.8) * 0.3;
      if (s.halo) s.halo.material.opacity = 0.18 + Math.sin(t * 1.1) * 0.07;
      if (s.pmat) s.pmat.opacity = 0.35 + Math.sin(t * 2.3) * 0.2;
      break;
    }
    case 'embers': {
      const a = s.eattr.array, c = s.ecattr.array, b = s.ebase, n = s.ecount;
      for (let i = 0; i < n; i++) {
        const bx = b[i * 4], bz = b[i * 4 + 1], sp = b[i * 4 + 2], off = b[i * 4 + 3];
        const life = (t * sp + off) % 1;
        a[i * 3] = bx + Math.sin((t + off * 9) * 1.7) * 0.05;
        a[i * 3 + 1] = -0.05 + life * 0.95;
        a[i * 3 + 2] = bz + Math.cos((t + off * 7) * 1.5) * 0.05;
        const f = (1 - life) * (life < 0.12 ? life / 0.12 : 1);
        c[i * 3] = f; c[i * 3 + 1] = f * 0.42; c[i * 3 + 2] = f * 0.1;
      }
      s.eattr.needsUpdate = true;
      s.ecattr.needsUpdate = true;
      s.body.emissiveIntensity = 1.5 + Math.sin(t * 5.3) * 0.3 + Math.sin(t * 11.7) * 0.16;
      break;
    }
    case 'facets': {
      const g = Math.pow(Math.max(0, Math.sin(t * 0.9)), 8);
      const em = 0.38 + g * 1.7;
      for (let i = 0; i < s.mats.length; i++) s.mats[i].emissiveIntensity = em;
      s.spin.rotation.y = t * 0.25;
      if (s.pmat) s.pmat.opacity = 0.4 + Math.sin(t * 3.1) * 0.3;
      break;
    }
    default: break;
  }
}

// ---------------------------------------------------------------
// per-frame animation (allocation free)
// ---------------------------------------------------------------
function makeUpdate(rig) {
  return function update(t) {
    if (typeof t !== 'number' || !isFinite(t)) t = 0;
    const sp = rig.speed, sw = rig.swim;
    const ch = rig.chain;
    for (let i = 0; i < ch.length; i++) {
      const c = ch[i];
      c.o.rotation[c.ax] = c.base + Math.sin(t * sp * c.rate + c.ph) * c.amp * sw;
    }
    const wb = rig.wobble;
    for (let i = 0; i < wb.length; i++) {
      const w = wb[i];
      w.o.rotation[w.ax] = w.base + Math.sin(t * w.rate + w.ph) * w.amp;
    }
    const tn = rig.tent;
    for (let i = 0; i < tn.length; i++) {
      const a = tn[i], segs = a.segs, n = segs.length;
      for (let j = 0; j < n; j++) {
        const s = segs[j];
        const f = 0.35 + 0.65 * (j / n);
        s.o.rotation.x = s.bx + Math.sin(t * a.rate + a.ph - j * 0.55) * a.amp * f;
        s.o.rotation.y = s.by + Math.cos(t * a.rate * 0.73 + a.ph * 1.3 - j * 0.42) * a.amp * f * 0.7;
      }
    }
    const pu = rig.pulse;
    for (let i = 0; i < pu.length; i++) {
      const p = pu[i];
      const s = 1 + Math.sin(t * p.rate + p.ph) * p.amp;
      p.o.scale.set(p.sx * s, p.sy * (2 - s), p.sz * s);
    }
    if (rig.body) {
      rig.body.rotation.z = Math.sin(t * sp * 0.45) * 0.05;
      rig.body.position.y = Math.sin(t * sp * 0.6) * 0.012;
    }
    if (rig.lure) {
      const f = 0.62 + Math.sin(t * 1.6) * 0.3 + Math.sin(t * 4.3) * 0.08;
      rig.lure.mat.emissiveIntensity = rig.lure.base * f;
      if (rig.lureHalo) {
        rig.lureHalo.material.opacity = 0.28 + f * 0.3;
        const s = 0.45 + f * 0.25;
        rig.lureHalo.scale.set(s, s, 1);
      }
    }
    if (rig.bodyHalo) {
      rig.bodyHalo.material.opacity = 0.12 + Math.sin(t * 0.5) * 0.06;
    }
    if (rig.mut) mutUpdate(rig.mut, t);
  };
}

// ---------------------------------------------------------------
// public API
// ---------------------------------------------------------------
const FALLBACK_DEF = {
  id: '_fish', name: 'Fish', tier: 1,
  model: { shape: 'slim', size: 0.35, colors: [0x88a8bb, 0x55707f], belly: 0xdfeef5 },
};

function resolveDef(d) {
  let def = d;
  if (typeof d === 'string') def = FISH.find((f) => f.id === d);
  if (!def || typeof def !== 'object') return FALLBACK_DEF;
  if (!def.model) {
    return { id: def.id || '_fish', name: def.name || 'Fish', tier: def.tier || 1, model: FALLBACK_DEF.model };
  }
  return def;
}

function buildShape(C, parent, rig) {
  switch (C.m.shape) {
    case 'round': case 'shark': case 'angler': case 'slim': return buildFinned(C, parent, rig);
    case 'eel': case 'serpent': return buildSerpentine(C, parent, rig);
    case 'flat': return buildFlat(C, parent, rig);
    case 'ray': return buildRay(C, parent, rig);
    case 'squid': return buildSquid(C, parent, rig);
    case 'octopus': return buildOctopus(C, parent, rig);
    case 'blob': return C.m.spikes ? buildPuffer(C, parent, rig) : buildBlob(C, parent, rig);
    default: return buildFinned(C, parent, rig);
  }
}

function buildFallback(C, parent) {
  const g = C.geo('fallback', () => {
    const B = new Builder();
    B.add(P.sph(), xform(0, 0, 0, 0, 0, 0, 0.2, 0.24, 0.7));
    const f = flatShape(FIN.tailFork, 0);
    B.add(f, xform(0, 0, -0.34, 0, PI / 2, 0, 0.18, 0.24, 1));
    f.dispose();
    return B.build(false);
  });
  parent.add(new THREE.Mesh(g, C.mats.body));
}

/**
 * Build a fish. Pure factory - safe to call at any time.
 * @param {object|string} fishDef entry from constants.FISH (or its id)
 * @param {string|null} mutation key into constants.MUTATIONS
 * @param {number} scaleMult extra size multiplier
 * @returns {THREE.Group} faces +Z, origin at body center, userData.update(t)
 */
export function createFishMesh(fishDef, mutation = null, scaleMult = 1) {
  const def = resolveDef(fishDef);
  const m = def.model;
  const mut = mutation && MUTATIONS[mutation] ? mutation : null;
  const len = Math.max(0.02, (m.size || 0.5) * (scaleMult || 1));

  const group = new THREE.Group();
  const root = new THREE.Object3D();
  root.scale.setScalar(len);
  group.add(root);
  const bodyRoot = new THREE.Object3D();
  root.add(bodyRoot);

  const rig = {
    chain: [], wobble: [], tent: [], pulse: [],
    mut: null, body: bodyRoot, speed: 3, swim: 1,
    lure: null, lureHalo: null, bodyHalo: null,
  };
  const R = rngFor(hashStr(def.id));
  const C = {
    def, m, id: def.id, mut, len, big: len >= 1.2, R, rig, owned: [],
    rr: (a, b) => a + R() * (b - a),
    geo(k, f) {
      const key = def.id + '|' + k;
      let g = geoCache.get(key);
      if (!g) { g = f(); geoCache.set(key, g); }
      return g;
    },
    mats: materialSet(def, mut),
  };

  let cfg = null;
  try {
    cfg = buildShape(C, bodyRoot, rig);
  } catch (err) {
    console.warn('[fish] build failed for ' + def.id, err);
    try { buildFallback(C, bodyRoot); } catch (e2) { /* nothing more we can do */ }
  }
  const speedMul = cfg && cfg.speedMul ? cfg.speedMul : 0.7;
  rig.speed = clamp(6.2 / (0.35 + len * 0.5), 0.7, 9.5) * speedMul;
  try { addMutationFX(C, bodyRoot, rig, mut, cfg); } catch (e) { /* FX are cosmetic */ }

  group.userData.fishId = def.id;
  group.userData.mutation = mut;
  group.userData.lengthM = len;
  group.userData.update = makeUpdate(rig);
  group.userData.dispose = function () {
    for (let i = 0; i < C.owned.length; i++) {
      const o = C.owned[i];
      if (o && typeof o.dispose === 'function') o.dispose();
    }
    C.owned.length = 0;
    if (C.mats.owned) {
      for (const k in C.mats) {
        const mm = C.mats[k];
        if (mm && mm.isMaterial) mm.dispose();
      }
    }
  };
  group.userData.update(0);
  return group;
}

// ---------------------------------------------------------------
// 2D inventory icon (96x96 canvas, stylized side view)
// ---------------------------------------------------------------
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
}

function iconPalette(def, mut) {
  const m = def.model;
  const c0 = m.colors && m.colors[0] != null ? m.colors[0] : 0x88a8bb;
  const c1 = m.colors && m.colors[1] != null ? m.colors[1] : 0x55707f;
  const be = m.belly != null ? m.belly : 0xe8f2f8;
  switch (mut) {
    case 'golden': return { top: 0xb8801a, mid: 0xffc832, low: 0xfff0b0, line: 0x6b4a00, eye: 0xfff8e0 };
    case 'rainbow': return { top: 0xff4d6d, mid: 0x4dd2ff, low: 0xfff36b, line: 0x3a2a55, eye: 0xffffff, rainbow: true };
    case 'void': return { top: 0x14001f, mid: 0x0a0014, low: 0x2a0a4a, line: 0x8a3cff, eye: 0xb98cff };
    case 'spectral': return { top: 0x6fa8d8, mid: 0xaaddff, low: 0xe6f7ff, line: 0x3388cc, eye: 0xffffff };
    case 'molten': return { top: 0x1c0c05, mid: 0x3a1a08, low: 0xff5a10, line: 0xff7a20, eye: 0xffd08a };
    case 'crystal': return { top: 0x7fb6cf, mid: 0xbbeeff, low: 0xf2fdff, line: 0x66aacc, eye: 0xffffff };
    default: return { top: c1, mid: c0, low: be, line: c1, eye: 0xffffff };
  }
}

function iconBodyFill(g, pal, x0, y0, x1, y1) {
  const gr = g.createLinearGradient(x0, y0, x1, y1);
  if (pal.rainbow) {
    gr.addColorStop(0, '#ff4d6d'); gr.addColorStop(0.3, '#ffd23f');
    gr.addColorStop(0.55, '#4dd2ff'); gr.addColorStop(0.8, '#9d6bff');
    gr.addColorStop(1, '#ff7bd5');
  } else {
    gr.addColorStop(0, cssOf(pal.top));
    gr.addColorStop(0.55, cssOf(pal.mid));
    gr.addColorStop(1, cssOf(pal.low));
  }
  g.fillStyle = gr;
}

function iconEye(g, pal, x, y, r) {
  g.fillStyle = cssOf(pal.eye);
  g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
  g.fillStyle = '#101418';
  g.beginPath(); g.arc(x + r * 0.25, y, r * 0.52, 0, TAU); g.fill();
  g.fillStyle = 'rgba(255,255,255,0.9)';
  g.beginPath(); g.arc(x + r * 0.05, y - r * 0.35, r * 0.22, 0, TAU); g.fill();
}

function iconTeeth(g, x0, x1, y, n, h) {
  g.fillStyle = '#f4efe2';
  for (let i = 0; i < n; i++) {
    const x = x0 + (x1 - x0) * (i / (n - 1 || 1));
    g.beginPath();
    g.moveTo(x - 2, y); g.lineTo(x, y + h); g.lineTo(x + 2, y);
    g.closePath(); g.fill();
  }
}

function drawIconBody(g, def, pal, mut) {
  const m = def.model;
  const shape = m.shape;
  g.lineWidth = 2;
  g.strokeStyle = cssOf(pal.line, mut === 'void' || mut === 'molten' ? 1 : 0.55);
  g.lineJoin = 'round';

  if (shape === 'eel' || shape === 'serpent') {
    const N = 26;
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const f = i / N;
      const x = 84 - f * 72;
      const y = 50 + Math.sin(f * 6.0 + 0.6) * (11 - f * 3);
      pts.push([x, y, (shape === 'serpent' ? 9.5 : 8) * (1 - f * 0.82) + 1.4]);
    }
    if (shape === 'serpent') { // dorsal frill
      g.fillStyle = cssOf(pal.low, 0.9);
      g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i += 2) {
        g.lineTo(pts[i][0] + 2, pts[i][1] - pts[i][2] - 6);
        g.lineTo(pts[i][0] - 2, pts[i][1] - pts[i][2]);
      }
      g.closePath(); g.fill();
    }
    iconBodyFill(g, pal, 20, 30, 84, 70);
    for (let i = 0; i < pts.length; i++) {
      g.beginPath(); g.arc(pts[i][0], pts[i][1], pts[i][2], 0, TAU); g.fill();
    }
    g.fillStyle = cssOf(pal.top, 0.85);
    g.beginPath(); g.ellipse(pts[0][0] - 1, pts[0][1], 11, 8, 0, 0, TAU); g.fill();
    if (shape === 'serpent') { // horns
      g.beginPath();
      g.moveTo(80, 44); g.lineTo(88, 34); g.lineTo(82, 44); g.closePath(); g.fill();
    }
    if (m.teeth || shape === 'serpent') iconTeeth(g, 78, 88, pts[0][1] + 3, 4, 5);
    iconEye(g, pal, 82, pts[0][1] - 2, 3.6);
    return;
  }

  if (shape === 'ray') {
    iconBodyFill(g, pal, 48, 18, 48, 82);
    g.beginPath();
    g.moveTo(80, 50);
    g.quadraticCurveTo(62, 20, 20, 26);
    g.quadraticCurveTo(38, 42, 40, 50);
    g.quadraticCurveTo(38, 58, 20, 74);
    g.quadraticCurveTo(62, 80, 80, 50);
    g.closePath(); g.fill(); g.stroke();
    g.strokeStyle = cssOf(pal.top, 0.9); g.lineWidth = 3;
    g.beginPath(); g.moveTo(42, 50);
    g.quadraticCurveTo(24, 50, 10, 62); g.stroke();
    iconEye(g, pal, 70, 44, 3.4);
    return;
  }

  if (shape === 'squid') {
    iconBodyFill(g, pal, 20, 26, 80, 74);
    g.beginPath();
    g.moveTo(10, 50);
    g.quadraticCurveTo(30, 24, 56, 34);
    g.quadraticCurveTo(64, 50, 56, 66);
    g.quadraticCurveTo(30, 76, 10, 50);
    g.closePath(); g.fill(); g.stroke();
    g.strokeStyle = cssOf(pal.mid, 0.85);
    g.lineWidth = 3.4; g.lineCap = 'round';
    for (let i = 0; i < 6; i++) {
      const y = 38 + i * 5;
      g.beginPath(); g.moveTo(58, y);
      g.quadraticCurveTo(74, y + (i - 2.5) * 3, 90, 42 + i * 3.4 + (i % 2) * 4);
      g.stroke();
    }
    iconEye(g, pal, 52, 42, 4.4);
    iconEye(g, pal, 52, 58, 4.4);
    return;
  }

  if (shape === 'octopus') {
    iconBodyFill(g, pal, 20, 18, 60, 80);
    g.beginPath();
    g.ellipse(38, 40, 26, 24, 0, 0, TAU);
    g.fill(); g.stroke();
    g.strokeStyle = cssOf(pal.mid, 0.9);
    g.lineWidth = 4; g.lineCap = 'round';
    for (let i = 0; i < 6; i++) {
      const a = -0.5 + i * 0.42;
      g.beginPath(); g.moveTo(38 + Math.cos(a) * 22, 52 + Math.sin(a) * 12);
      g.quadraticCurveTo(64 + i * 3, 60 + i * 4, 78 - (i % 2) * 8, 84 - i * 5);
      g.stroke();
    }
    iconEye(g, pal, 48, 36, 5);
    iconEye(g, pal, 30, 34, 4.4);
    return;
  }

  if (shape === 'blob' && !m.spikes) {
    iconBodyFill(g, pal, 24, 20, 72, 80);
    g.beginPath();
    for (let i = 0; i <= 40; i++) {
      const a = (i / 40) * TAU;
      const r = 27 + Math.sin(a * 3 + 1) * 3 + Math.sin(a * 5) * 2;
      const x = 48 + Math.cos(a) * r, y = 48 + Math.sin(a) * r * 0.92;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath(); g.fill(); g.stroke();
    g.strokeStyle = cssOf(pal.low, 0.9); g.lineWidth = 3; g.lineCap = 'round';
    for (let i = 0; i < 5; i++) {
      const x = 30 + i * 9;
      g.beginPath(); g.moveTo(x, 70);
      g.quadraticCurveTo(x + 4, 80, x - 2 + (i % 2) * 6, 90);
      g.stroke();
    }
    const glow = m.emissive != null ? m.emissive : 0xff4444;
    g.fillStyle = cssOf(glow);
    for (let i = 0; i < 5; i++) {
      const x = 42 + (i % 3) * 11 - (i > 2 ? 6 : 0);
      const y = 36 + (i % 2) * 9 + (i > 2 ? 8 : 0);
      g.beginPath(); g.arc(x, y, 2.6, 0, TAU); g.fill();
    }
    if (m.teeth) iconTeeth(g, 40, 62, 60, 6, 6);
    return;
  }

  if (shape === 'angler') {
    iconBodyFill(g, pal, 20, 24, 78, 76);
    g.beginPath();
    g.moveTo(74, 44);
    g.quadraticCurveTo(60, 18, 34, 34);
    g.quadraticCurveTo(16, 44, 20, 50);
    g.quadraticCurveTo(16, 58, 30, 64);
    g.quadraticCurveTo(56, 80, 76, 60);
    g.closePath(); g.fill(); g.stroke();
    // tail
    g.beginPath(); g.moveTo(22, 44); g.lineTo(8, 34); g.lineTo(10, 50); g.lineTo(8, 66); g.closePath();
    g.fill(); g.stroke();
    // jaw + fangs
    g.fillStyle = '#150a12';
    g.beginPath(); g.moveTo(74, 46); g.quadraticCurveTo(62, 58, 48, 62);
    g.quadraticCurveTo(64, 70, 76, 60); g.closePath(); g.fill();
    iconTeeth(g, 52, 74, 54, 6, 7);
    // lure
    const glow = m.emissive != null ? m.emissive : 0x88ddff;
    g.strokeStyle = cssOf(pal.top); g.lineWidth = 2.5;
    g.beginPath(); g.moveTo(52, 28); g.quadraticCurveTo(70, 12, 82, 22); g.stroke();
    const lg = g.createRadialGradient(82, 22, 0, 82, 22, 11);
    lg.addColorStop(0, cssOf(glow, 1.6)); lg.addColorStop(0.35, cssOf(glow));
    lg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = lg;
    g.beginPath(); g.arc(82, 22, 11, 0, TAU); g.fill();
    iconEye(g, pal, 62, 38, 3.6);
    return;
  }

  // --- finned silhouettes: slim / round / flat / shark / puffer ---
  const puffer = shape === 'blob' && m.spikes;
  const deep = shape === 'round' ? 26 : shape === 'flat' ? 17 : shape === 'shark' ? 20 : 21;
  const noseX = shape === 'shark' ? 86 : 82;
  iconBodyFill(g, pal, 48, 50 - deep, 48, 50 + deep + 6);

  if (puffer) {
    g.beginPath();
    for (let i = 0; i <= 36; i++) {
      const a = (i / 36) * TAU;
      const r = 25 + Math.sin(a * 6) * 1.5;
      const x = 46 + Math.cos(a) * r, y = 50 + Math.sin(a) * r;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
    g.save(); g.fill(); g.stroke(); g.restore();
    g.strokeStyle = cssOf(pal.top, 0.9); g.lineWidth = 2.4;
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * TAU;
      g.beginPath();
      g.moveTo(46 + Math.cos(a) * 24, 50 + Math.sin(a) * 24);
      g.lineTo(46 + Math.cos(a) * 32, 50 + Math.sin(a) * 32);
      g.stroke();
    }
    iconEye(g, pal, 62, 42, 5.2);
    g.fillStyle = '#2a1a1a';
    g.beginPath(); g.ellipse(70, 54, 4, 3, 0, 0, TAU); g.fill();
    return;
  }

  // dorsal fin first (behind body)
  g.save();
  if (shape === 'shark') {
    g.beginPath(); g.moveTo(52, 50 - deep + 4); g.lineTo(58, 50 - deep - 16); g.lineTo(40, 50 - deep + 6);
    g.closePath(); g.fill(); g.stroke();
  } else if (shape !== 'flat') {
    g.beginPath(); g.moveTo(56, 50 - deep + 3); g.lineTo(60, 50 - deep - 12); g.lineTo(38, 50 - deep + 5);
    g.closePath(); g.fill(); g.stroke();
  }
  g.restore();

  // tail
  g.beginPath();
  if (shape === 'shark') {
    g.moveTo(26, 50); g.lineTo(8, 26); g.lineTo(16, 50); g.lineTo(10, 66);
  } else if (shape === 'round' || shape === 'flat') {
    g.moveTo(26, 50); g.lineTo(10, 36); g.lineTo(14, 50); g.lineTo(10, 64);
  } else {
    g.moveTo(26, 50); g.lineTo(9, 32); g.lineTo(18, 50); g.lineTo(9, 68);
  }
  g.closePath(); g.fill(); g.stroke();

  // body
  g.beginPath();
  if (shape === 'flat') {
    g.ellipse(52, 50, 30, deep, 0, 0, TAU);
  } else {
    g.moveTo(noseX, 50 - (shape === 'shark' ? 2 : 0));
    g.quadraticCurveTo(60, 50 - deep - 4, 34, 50 - deep * 0.42);
    g.quadraticCurveTo(26, 50, 34, 50 + deep * 0.42);
    g.quadraticCurveTo(60, 50 + deep + 2, noseX, 50 + (shape === 'shark' ? 6 : 2));
    g.closePath();
  }
  g.fill(); g.stroke();

  // pectoral fin
  g.beginPath();
  g.moveTo(60, 52); g.quadraticCurveTo(56, 66, 44, 64); g.quadraticCurveTo(52, 56, 60, 52);
  g.closePath();
  g.fillStyle = cssOf(m.finTint != null ? m.finTint : pal.top, 0.95);
  g.fill();

  if (m.stripes != null && !mut) {
    g.strokeStyle = cssOf(m.stripes); g.lineWidth = 2.6;
    for (let i = 0; i < 5; i++) {
      const x = 40 + i * 8;
      g.beginPath(); g.moveTo(x, 50 - deep * 0.75); g.lineTo(x - 3, 50 + deep * 0.2); g.stroke();
    }
  }
  if (m.spots != null && !mut) {
    g.fillStyle = cssOf(m.spots);
    for (let i = 0; i < 9; i++) {
      g.beginPath();
      g.arc(38 + (i % 5) * 9, 40 + ((i * 7) % 3) * 8, 2, 0, TAU);
      g.fill();
    }
  }
  if (m.whiskers) {
    g.strokeStyle = cssOf(pal.top); g.lineWidth = 2; g.lineCap = 'round';
    g.beginPath(); g.moveTo(78, 56); g.quadraticCurveTo(84, 68, 74, 74); g.stroke();
    g.beginPath(); g.moveTo(76, 58); g.quadraticCurveTo(88, 66, 88, 76); g.stroke();
  }
  if (m.bill) {
    g.strokeStyle = cssOf(pal.top); g.lineWidth = 3; g.lineCap = 'round';
    g.beginPath(); g.moveTo(noseX - 2, 50); g.lineTo(94, 47); g.stroke();
  }
  if (m.teeth) iconTeeth(g, noseX - 20, noseX - 3, 54, 5, 6);
  if (shape === 'flat') {
    iconEye(g, pal, 66, 42, 4);
    iconEye(g, pal, 58, 38, 3.4);
  } else {
    iconEye(g, pal, noseX - 12, 45, shape === 'shark' ? 3.2 : 4.4);
  }
}

/**
 * Small stylized 2D icon for inventory cards.
 * @returns {string} data URL of a 96x96 PNG ('' when there is no DOM)
 */
export function createFishIconDataURL(fishDef, mutation) {
  const def = resolveDef(fishDef);
  const mut = mutation && MUTATIONS[mutation] ? mutation : null;
  const key = def.id + '|' + (mut || '');
  if (iconCache.has(key)) return iconCache.get(key);
  if (typeof document === 'undefined') return '';

  const cv = document.createElement('canvas');
  cv.width = 96; cv.height = 96;
  const g = cv.getContext('2d');
  const pal = iconPalette(def, mut);

  g.save();
  roundRect(g, 1.5, 1.5, 93, 93, 14);
  g.clip();
  // backdrop
  const bg = g.createLinearGradient(0, 0, 0, 96);
  bg.addColorStop(0, cssOf(pal.top, 0.5));
  bg.addColorStop(1, cssOf(pal.top, 0.16));
  g.fillStyle = bg; g.fillRect(0, 0, 96, 96);
  const vg = g.createRadialGradient(48, 42, 6, 48, 48, 56);
  vg.addColorStop(0, 'rgba(255,255,255,0.20)');
  vg.addColorStop(1, 'rgba(0,0,0,0.28)');
  g.fillStyle = vg; g.fillRect(0, 0, 96, 96);
  if (mut) { // mutation aura behind the fish
    const M = MUTATIONS[mut];
    const ag = g.createRadialGradient(48, 48, 4, 48, 48, 50);
    ag.addColorStop(0, cssOf(M.tint, 0.9));
    ag.addColorStop(1, 'rgba(0,0,0,0)');
    g.globalAlpha = mut === 'void' ? 0.5 : 0.35;
    g.fillStyle = ag; g.fillRect(0, 0, 96, 96);
    g.globalAlpha = 1;
  }
  g.shadowColor = 'rgba(0,0,0,0.35)';
  g.shadowBlur = 6;
  g.shadowOffsetY = 2;
  try { drawIconBody(g, def, pal, mut); } catch (e) { /* keep the card usable */ }
  g.shadowBlur = 0; g.shadowOffsetY = 0;
  if (mut === 'molten') { // crack overlay
    g.strokeStyle = '#ff7a20'; g.lineWidth = 1.4;
    const R = rngFor(hashStr(def.id + 'ic'));
    for (let i = 0; i < 7; i++) {
      let x = 26 + R() * 50, y = 30 + R() * 36;
      g.beginPath(); g.moveTo(x, y);
      for (let s = 0; s < 3; s++) { x += (R() - 0.5) * 20; y += (R() - 0.5) * 16; g.lineTo(x, y); }
      g.stroke();
    }
  }
  if (mut === 'spectral') { g.globalAlpha = 1; }
  g.restore();

  // border
  g.lineWidth = 2.5;
  if (mut) {
    const M = MUTATIONS[mut];
    if (mut === 'rainbow') {
      const rg = g.createLinearGradient(0, 0, 96, 96);
      rg.addColorStop(0, '#ff4d6d'); rg.addColorStop(0.33, '#ffd23f');
      rg.addColorStop(0.66, '#4dd2ff'); rg.addColorStop(1, '#9d6bff');
      g.strokeStyle = rg;
    } else g.strokeStyle = cssOf(M.tint);
  } else {
    g.strokeStyle = 'rgba(255,255,255,0.22)';
  }
  roundRect(g, 1.5, 1.5, 93, 93, 14);
  g.stroke();

  const url = cv.toDataURL();
  iconCache.set(key, url);
  return url;
}






