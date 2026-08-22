// =============================================================
// TIDEWRECK ISLAND - boat.js
// The team's one shared boat: four hull tiers, buoyancy physics,
// wake foam, boarding affordance and networked driving.
// Owner module: exports initBoat(ctx).
// =============================================================
import * as THREE from 'three';
import { MSG, ECON } from '/shared/constants.js';

/* ------------------------------------------------------------------ *
 * Tuning tables
 * ------------------------------------------------------------------ */

// len/wid/depth in metres. free = freeboard (gunwale height above waterline).
const SPECS = {
  1: { name: 'Dinghy',       len: 4.4,  wid: 1.85, depth: 0.62, free: 0.50, seats: 2, maxSpeed: 8,  accel: 8.5,  turn: 1.70, drag: 0.36, quad: 0.0878 },
  2: { name: 'Skiff',        len: 6.3,  wid: 2.35, depth: 0.80, free: 0.62, seats: 4, maxSpeed: 12, accel: 12.5, turn: 1.45, drag: 0.30, quad: 0.0618 },
  3: { name: 'Cutter',       len: 8.4,  wid: 2.95, depth: 0.98, free: 0.76, seats: 6, maxSpeed: 16, accel: 15.5, turn: 1.20, drag: 0.26, quad: 0.0443 },
  4: { name: 'Abyss-Runner', len: 10.4, wid: 3.50, depth: 1.18, free: 0.90, seats: 8, maxSpeed: 20, accel: 19.0, turn: 1.02, drag: 0.24, quad: 0.0355 },
};

// Painted palettes per hull tier.
const PALETTES = {
  1: { hull: 0xc08a4e, hullDark: 0x8a5f34, stripe: 0xc4503c, deck: 0xd8b183, trim: 0x7d5230,
       metal: 0x9aa2a8, accent: 0xffc06a, glow: 0xffb44a },
  2: { hull: 0xeef2f4, hullDark: 0xb9c3c9, stripe: 0x2b7fa8, deck: 0xc79a63, trim: 0x1d5b7c,
       metal: 0xaeb6bc, accent: 0x5fd6ff, glow: 0x6fd8ff },
  3: { hull: 0xf3f5f6, hullDark: 0xc4ccd2, stripe: 0x1e3a63, deck: 0xb98c58, trim: 0x24406b,
       metal: 0xb6bec4, accent: 0xffd76a, glow: 0x9fd8ff },
  4: { hull: 0x232a34, hullDark: 0x141920, stripe: 0x15b8cc, deck: 0x2d3540, trim: 0x0f7f92,
       metal: 0x6b767f, accent: 0x2ae4ff, glow: 0x2ae4ff },
};

const SHALLOW_LIMIT = -0.6;   // terrain height above this = the boat runs aground
const WORLD_BOUND = 952;      // hard sailing limit on each axis
const WORLD_SOFT = 930;       // soft wall starts here (clears the Abyss ring)
const NET_INTERVAL = 1 / 12;  // DRIVE_BOAT send rate
const NET_SMOOTH = 0.15;      // passenger interpolation time constant (s)
const BOARD_RANGE = 6;        // metres, boarding affordance radius

/* ------------------------------------------------------------------ *
 * Module scratch (single boat instance -> safe to share, zero alloc)
 * ------------------------------------------------------------------ */
const _v1 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _cornerH = [0, 0, 0, 0];
const _cornerX = [0, 0, 0, 0];
const _cornerZ = [0, 0, 0, 0];

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function smoothstep(a, b, x) { const t = clamp((x - a) / (b - a || 1e-6), 0, 1); return t * t * (3 - 2 * t); }
function shortAngle(a) { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; }
function damp(rate, dt) { return 1 - Math.exp(-rate * dt); }

/* ------------------------------------------------------------------ *
 * Procedural canvas textures (built once, shared by every rebuild)
 * ------------------------------------------------------------------ */
let _plankTex = null, _deckTex = null, _glowTex = null, _scuffTex = null;

function plankTexture() {
  if (_plankTex) return _plankTex;
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 256, 128);
  const bands = 7, bh = 128 / bands;
  for (let i = 0; i < bands; i++) {
    const y = i * bh;
    const shade = 0.88 + Math.random() * 0.12;
    g.fillStyle = 'rgba(0,0,0,' + ((1 - shade) * 1.1).toFixed(3) + ')';
    g.fillRect(0, y, 256, bh);
    g.fillStyle = 'rgba(0,0,0,0.30)';
    g.fillRect(0, y, 256, 1.4);
    g.fillStyle = 'rgba(255,255,255,0.20)';
    g.fillRect(0, y + 1.4, 256, 1.0);
    for (let k = 0; k < 10; k++) {
      const gy = y + 2 + Math.random() * (bh - 4);
      g.strokeStyle = 'rgba(0,0,0,' + (0.03 + Math.random() * 0.06).toFixed(3) + ')';
      g.lineWidth = 0.6 + Math.random() * 0.9;
      g.beginPath();
      g.moveTo(-4, gy);
      g.bezierCurveTo(70, gy + (Math.random() - 0.5) * 3, 170, gy + (Math.random() - 0.5) * 3, 260, gy);
      g.stroke();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  _plankTex = t;
  return t;
}

function deckTexture() {
  if (_deckTex) return _deckTex;
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 8; i++) {
    const x = i * 16;
    g.fillStyle = 'rgba(0,0,0,' + (0.04 + Math.random() * 0.08).toFixed(3) + ')';
    g.fillRect(x, 0, 16, 128);
    g.fillStyle = 'rgba(0,0,0,0.26)';
    g.fillRect(x, 0, 1.3, 128);
    for (let k = 0; k < 6; k++) {
      g.fillStyle = 'rgba(0,0,0,0.05)';
      g.fillRect(x + 2 + Math.random() * 11, Math.random() * 128, 1, 6 + Math.random() * 20);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  _deckTex = t;
  return t;
}

function glowTexture() {
  if (_glowTex) return _glowTex;
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0.00, 'rgba(255,255,255,1)');
  grd.addColorStop(0.22, 'rgba(255,255,255,0.72)');
  grd.addColorStop(0.55, 'rgba(255,255,255,0.18)');
  grd.addColorStop(1.00, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  _glowTex = t;
  return t;
}

function scuffTexture() {
  if (_scuffTex) return _scuffTex;
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 90; i++) {
    g.fillStyle = 'rgba(0,0,0,' + (0.05 + Math.random() * 0.13).toFixed(3) + ')';
    const x = Math.random() * 128, y = Math.random() * 128;
    g.fillRect(x, y, 1 + Math.random() * 9, 1 + Math.random() * 3);
  }
  for (let i = 0; i < 40; i++) {
    g.fillStyle = 'rgba(255,255,255,0.16)';
    g.fillRect(Math.random() * 128, Math.random() * 128, 1 + Math.random() * 5, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 2;
  _scuffTex = t;
  return t;
}

/* ------------------------------------------------------------------ *
 * Low-level geometry helpers (loft / tube). No addons, hand rolled.
 * ------------------------------------------------------------------ */

// rings: array of equal-length arrays of [x,y,z]. Builds a quad strip surface.
function addLoft(pos, idx, uv, rings, uRepeat, vRepeat) {
  const R = rings.length;
  if (R < 2) return;
  const n = rings[0].length;
  if (n < 2) return;
  const base = pos.length / 3;
  for (let i = 0; i < R; i++) {
    const ring = rings[i];
    const u = (i / (R - 1)) * uRepeat;
    for (let j = 0; j < n; j++) {
      const p = ring[j];
      pos.push(p[0], p[1], p[2]);
      uv.push(u, (j / (n - 1)) * vRepeat);
    }
  }
  for (let i = 0; i < R - 1; i++) {
    for (let j = 0; j < n - 1; j++) {
      const a = base + i * n + j, b = a + 1, c = a + n, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
}

function finishGeometry(pos, idx, uv) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

// Square/round tube swept along a polyline path of [x,y,z] points.
function buildTubeGeometry(path, radius, sides) {
  const rings = [];
  const last = path.length - 1;
  for (let i = 0; i <= last; i++) {
    const p = path[i];
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(last, i + 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2];
    const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
    // side = tangent x worldUp
    let sx = ty * 0 - tz * 1, sy = tz * 0 - tx * 0, sz = tx * 1 - ty * 0;
    let sl = Math.hypot(sx, sy, sz);
    if (sl < 1e-4) { sx = 1; sy = 0; sz = 0; sl = 1; }
    sx /= sl; sy /= sl; sz /= sl;
    const nx = sy * tz - sz * ty, ny = sz * tx - sx * tz, nz = sx * ty - sy * tx;
    const ring = [];
    for (let k = 0; k <= sides; k++) {
      const ang = (k / sides) * Math.PI * 2 + Math.PI * 0.25;
      const ca = Math.cos(ang) * radius, sa = Math.sin(ang) * radius;
      ring.push([p[0] + sx * ca + nx * sa, p[1] + sy * ca + ny * sa, p[2] + sz * ca + nz * sa]);
    }
    rings.push(ring);
  }
  const pos = [], idx = [], uv = [];
  addLoft(pos, idx, uv, rings, Math.max(1, path.length * 0.25), 1);
  return finishGeometry(pos, idx, uv);
}

/* ---- hull station profiles (u: 0 = transom, 1 = bow tip) ---- */
function widthProfile(u) {
  if (u < 0.42) { const k = u / 0.42; return 0.78 + 0.22 * (k * k * (3 - 2 * k)); }
  const k = (u - 0.42) / 0.58;
  return 1.0 - 0.94 * Math.pow(k, 1.7);
}
function keelProfile(u) {
  if (u < 0.5) return 0.86 + 0.14 * (u / 0.5);
  const k = (u - 0.5) / 0.5;
  return 1.0 - 0.82 * k * k;
}
function sheerProfile(u) {
  const bow = Math.max(0, (u - 0.45) / 0.55);
  const stern = Math.max(0, (0.45 - u) / 0.45);
  return 0.92 + 0.55 * bow * bow + 0.15 * stern * stern;
}

function deckY(spec) { return -spec.depth * 0.34; }

// Cross-section key points at station u, starboard(-x is starboard; +x is port).
function station(spec, u, out) {
  const hw = spec.wid * 0.5 * widthProfile(u);
  const gy = spec.free * sheerProfile(u);
  const keel = -spec.depth * keelProfile(u);
  out.hw = hw;
  out.gy = gy;
  out.keel = keel;
  out.chineY = gy - (gy - keel) * 0.62;
  out.chineX = hw * 0.90;
  out.z = -spec.len * 0.5 + u * spec.len;
  return out;
}

const _st = { hw: 0, gy: 0, keel: 0, chineY: 0, chineX: 0, z: 0 };

// Full hull shell: outer skin, inner cockpit, gunwale rim, transom + stem caps.
function buildHullGeometry(spec, stations) {
  const N = stations;
  const outer = [], inner = [];
  const floorY = deckY(spec);
  for (let i = 0; i < N; i++) {
    const u = i / (N - 1);
    station(spec, u, _st);
    const z = _st.z;
    outer.push([
      [_st.hw, _st.gy, z],
      [_st.chineX, _st.chineY, z],
      [0, _st.keel, z],
      [-_st.chineX, _st.chineY, z],
      [-_st.hw, _st.gy, z],
    ]);
    const inset = Math.min(_st.hw * 0.40, 0.09 + spec.wid * 0.030);
    const ihw = Math.max(0.012, _st.hw - inset);
    const ifl = Math.max(floorY, _st.keel + spec.depth * 0.15);
    inner.push([
      [ihw, _st.gy, z],
      [ihw * 0.95, ifl, z],
      [0, ifl, z],
      [-ihw * 0.95, ifl, z],
      [-ihw, _st.gy, z],
    ]);
  }
  const pos = [], idx = [], uv = [];
  addLoft(pos, idx, uv, outer, spec.len * 0.55, 2.2);          // outer skin
  addLoft(pos, idx, uv, inner, spec.len * 0.55, 2.2);          // cockpit interior
  const rimP = [], rimS = [];
  for (let i = 0; i < N; i++) {
    rimP.push([outer[i][0], inner[i][0]]);
    rimS.push([inner[i][4], outer[i][4]]);
  }
  addLoft(pos, idx, uv, rimP, spec.len * 0.55, 0.12);          // port gunwale cap
  addLoft(pos, idx, uv, rimS, spec.len * 0.55, 0.12);          // starboard gunwale cap
  addLoft(pos, idx, uv, [outer[0], inner[0]], 0.4, 2.2);       // transom
  addLoft(pos, idx, uv, [inner[N - 1], outer[N - 1]], 0.4, 2.2); // stem cap
  return finishGeometry(pos, idx, uv);
}

// Painted sheer stripe that hugs the hull sides just under the gunwale.
function buildStripeGeometry(spec, stations, f0, f1) {
  const N = stations;
  const port = [], stbd = [];
  for (let i = 0; i < N; i++) {
    const u = i / (N - 1);
    station(spec, u, _st);
    const ax = _st.hw, ay = _st.gy, bx = _st.chineX, by = _st.chineY;
    let dx = bx - ax, dy = by - ay;
    const m = Math.hypot(dx, dy) || 1; dx /= m; dy /= m;
    let nx = -dy, ny = dx;
    if (nx < 0) { nx = -nx; ny = -ny; }
    const off = 0.022;
    const p0x = ax + dx * m * f0 + nx * off, p0y = ay + dy * m * f0 + ny * off;
    const p1x = ax + dx * m * f1 + nx * off, p1y = ay + dy * m * f1 + ny * off;
    const z = _st.z;
    port.push([[p0x, p0y, z], [p1x, p1y, z]]);
    stbd.push([[-p1x, p1y, z], [-p0x, p0y, z]]);
  }
  const pos = [], idx = [], uv = [];
  addLoft(pos, idx, uv, port, spec.len * 0.4, 1);
  addLoft(pos, idx, uv, stbd, spec.len * 0.4, 1);
  return finishGeometry(pos, idx, uv);
}

// Continuous rail following the sheer: stern -> bow along port, back along starboard.
function buildRailGeometry(spec, stations, height, radius, fromU) {
  const path = [];
  const N = stations;
  const start = Math.max(0, Math.round(fromU * (N - 1)));
  for (let i = start; i < N; i++) {
    const u = i / (N - 1);
    station(spec, u, _st);
    path.push([_st.hw * 0.94, _st.gy + height, _st.z]);
  }
  for (let i = N - 2; i >= start; i--) {
    const u = i / (N - 1);
    station(spec, u, _st);
    path.push([-_st.hw * 0.94, _st.gy + height, _st.z]);
  }
  return buildTubeGeometry(path, radius, 4);
}
/* ------------------------------------------------------------------ *
 * Build helper: tracks geometries/materials so a rebuild can dispose.
 * ------------------------------------------------------------------ */
function makeBuilder(root) {
  return {
    root,
    _geoms: [],
    _mats: [],
    anim: { props: [], oars: [], wheel: null, motor: null, rudder: null, flags: [], beacons: [], lampSpot: null, lampCones: [], lampLens: [], sprites: [], crane: null },
    glowMats: [],
    seats: [],
    g(geom) { this._geoms.push(geom); return geom; },
    m(mat) { this._mats.push(mat); return mat; },
    box(w, h, d) { return this.g(new THREE.BoxGeometry(w, h, d)); },
    cyl(rt, rb, h, s) { return this.g(new THREE.CylinderGeometry(rt, rb, h, s || 10)); },
    sph(r, w, h) { return this.g(new THREE.SphereGeometry(r, w || 10, h || 7)); },
    mesh(geom, mat, x, y, z, parent) {
      const me = new THREE.Mesh(geom, mat);
      me.position.set(x || 0, y || 0, z || 0);
      me.castShadow = true;
      me.receiveShadow = true;
      (parent || this.root).add(me);
      return me;
    },
    sprite(color, size, x, y, z, parent) {
      const mat = this.m(new THREE.SpriteMaterial({
        map: glowTexture(), color: color, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.85,
      }));
      const sp = new THREE.Sprite(mat);
      sp.scale.set(size, size, 1);
      sp.position.set(x, y, z);
      (parent || this.root).add(sp);
      this.anim.sprites.push(sp);
      return sp;
    },
    dispose() {
      for (let i = 0; i < this._geoms.length; i++) this._geoms[i].dispose();
      for (let i = 0; i < this._mats.length; i++) this._mats[i].dispose();
      this._geoms.length = 0;
      this._mats.length = 0;
      this.root.clear();
    },
  };
}

function standard(B, opts) {
  return B.m(new THREE.MeshStandardMaterial(opts));
}

/* ------------------------------------------------------------------ *
 * Shared props
 * ------------------------------------------------------------------ */

// Outboard / pod motor with a spinning prop. Returns the steering pivot.
function buildMotor(B, mats, scale, x, y, z) {
  const pivot = new THREE.Group();
  pivot.position.set(x, y, z);
  B.root.add(pivot);
  const s = scale;
  B.mesh(B.box(0.46 * s, 0.56 * s, 0.52 * s), mats.motor, 0, 0.30 * s, -0.04 * s, pivot);
  B.mesh(B.box(0.40 * s, 0.10 * s, 0.46 * s), mats.trim, 0, 0.60 * s, -0.04 * s, pivot);
  B.mesh(B.box(0.16 * s, 0.62 * s, 0.18 * s), mats.metal, 0, -0.14 * s, 0, pivot);
  const case_ = B.mesh(B.cyl(0.11 * s, 0.13 * s, 0.62 * s, 10), mats.metal, 0, -0.50 * s, 0.02 * s, pivot);
  case_.rotation.x = Math.PI * 0.5;
  const nose = B.mesh(B.g(new THREE.ConeGeometry(0.13 * s, 0.28 * s, 10)), mats.metal, 0, -0.50 * s, 0.30 * s, pivot);
  nose.rotation.x = Math.PI * 0.5;
  const prop = new THREE.Group();
  prop.position.set(0, -0.50 * s, -0.34 * s);
  pivot.add(prop);
  const hub = B.mesh(B.cyl(0.05 * s, 0.05 * s, 0.10 * s, 8), mats.metal, 0, 0, 0, prop);
  hub.rotation.x = Math.PI * 0.5;
  const bladeGeo = B.box(0.06 * s, 0.30 * s, 0.02 * s);
  for (let i = 0; i < 3; i++) {
    const bl = B.mesh(bladeGeo, mats.metal, 0, 0, 0, prop);
    bl.rotation.z = (i / 3) * Math.PI * 2;
    bl.position.set(Math.sin((i / 3) * Math.PI * 2) * -0.15 * s, Math.cos((i / 3) * Math.PI * 2) * 0.15 * s, 0);
    bl.rotation.y = 0.5;
  }
  B.anim.props.push(prop);
  return pivot;
}

// Ship's wheel on a console.
function buildWheel(B, mats, r, x, y, z, tilt) {
  const grp = new THREE.Group();
  grp.position.set(x, y, z);
  grp.rotation.x = tilt || 0;
  B.root.add(grp);
  const rim = B.mesh(B.g(new THREE.TorusGeometry(r, r * 0.13, 6, 18)), mats.trim, 0, 0, 0, grp);
  rim.rotation.y = 0;
  const spokeGeo = B.box(r * 0.09, r * 1.85, r * 0.09);
  for (let i = 0; i < 3; i++) {
    const sp = B.mesh(spokeGeo, mats.trim, 0, 0, 0, grp);
    sp.rotation.z = (i / 3) * Math.PI;
  }
  B.mesh(B.cyl(r * 0.16, r * 0.16, r * 0.4, 8), mats.metal, 0, 0, -r * 0.2, grp).rotation.x = Math.PI * 0.5;
  B.anim.wheel = grp;
  return grp;
}

// Small waving pennant (vertices displaced per frame).
function buildFlag(B, mats, w, h, x, y, z, poleH) {
  B.mesh(B.cyl(0.03, 0.035, poleH, 6), mats.metal, x, y + poleH * 0.5, z);
  const geo = B.g(new THREE.PlaneGeometry(w, h, 7, 3));
  const m = new THREE.Mesh(geo, mats.flag);
  m.position.set(x - w * 0.5, y + poleH - h * 0.62, z);
  m.castShadow = true;
  B.root.add(m);
  const base = geo.attributes.position.array.slice();
  B.anim.flags.push({ mesh: m, geo, base, w });
  return m;
}

function buildLifeRing(B, mats, r, x, y, z, rotZ) {
  const ring = B.mesh(B.g(new THREE.TorusGeometry(r, r * 0.32, 6, 14)), mats.buoy, x, y, z);
  ring.rotation.set(0, Math.PI * 0.5, rotZ || 0);
  return ring;
}

function buildCleat(B, mats, x, y, z) {
  B.mesh(B.box(0.09, 0.10, 0.09), mats.metal, x, y, z);
  const top = B.mesh(B.box(0.34, 0.07, 0.09), mats.metal, x, y + 0.08, z);
  return top;
}

function buildNavLight(B, mats, color, x, y, z, size) {
  const mat = B.m(new THREE.MeshBasicMaterial({ color: color }));
  const bulb = B.mesh(B.sph(size, 8, 6), mat, x, y, z);
  bulb.castShadow = false;
  B.mesh(B.cyl(size * 1.25, size * 1.35, size * 1.1, 8), mats.metal, x, y - size * 1.1, z);
  const sp = B.sprite(color, size * 9, x, y, z);
  sp.material.opacity = 0.55;
  return { bulb: bulb, mat: mat, sprite: sp };
}

// Slatted bench with legs.
function buildBench(B, mats, w, d, x, y, z) {
  B.mesh(B.box(w, 0.075, d), mats.deck, x, y, z);
  const legGeo = B.box(0.08, 0.34, 0.08);
  B.mesh(legGeo, mats.trim, x + w * 0.42, y - 0.20, z);
  B.mesh(legGeo, mats.trim, x - w * 0.42, y - 0.20, z);
}
function uvScaled(geo, sx, sy) {
  const uv = geo.attributes.uv;
  if (!uv) return geo;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * sx, uv.getY(i) * sy);
  uv.needsUpdate = true;
  return geo;
}

function makeMaterials(B, pal, level) {
  const wood = level === 1;
  const mats = {};
  mats.hull = standard(B, {
    color: pal.hull, map: wood ? plankTexture() : scuffTexture(),
    roughness: wood ? 0.80 : (level === 4 ? 0.48 : 0.42),
    metalness: level === 4 ? 0.30 : 0.04,
    flatShading: true, side: THREE.DoubleSide,
    emissive: new THREE.Color(pal.glow), emissiveIntensity: 0,
  });
  mats.stripe = standard(B, {
    color: pal.stripe, roughness: 0.35, metalness: level === 4 ? 0.25 : 0.05,
    flatShading: true, side: THREE.DoubleSide,
    emissive: new THREE.Color(pal.glow), emissiveIntensity: level === 4 ? 0.55 : 0,
  });
  mats.deck = standard(B, { color: pal.deck, map: deckTexture(), roughness: 0.85, metalness: 0.02, flatShading: true });
  mats.trim = standard(B, { color: pal.trim, roughness: 0.6, metalness: 0.1, flatShading: true });
  mats.metal = standard(B, { color: pal.metal, roughness: 0.34, metalness: 0.85, flatShading: true });
  mats.motor = standard(B, { color: level === 4 ? 0x1b2028 : 0x2a3038, roughness: 0.4, metalness: 0.35, flatShading: true });
  mats.dark = standard(B, { color: 0x1a1e24, roughness: 0.7, metalness: 0.2, flatShading: true });
  mats.glass = standard(B, {
    color: 0x9fd4e8, roughness: 0.08, metalness: 0.15, transparent: true, opacity: 0.34,
    side: THREE.DoubleSide, emissive: new THREE.Color(0x0d2230), emissiveIntensity: 0.5,
  });
  mats.flag = standard(B, { color: pal.stripe, roughness: 0.85, side: THREE.DoubleSide, flatShading: false });
  mats.buoy = standard(B, { color: 0xe8543a, roughness: 0.7, flatShading: true });
  mats.rope = standard(B, { color: 0xcbb387, roughness: 0.95, flatShading: true });
  mats.lamp = B.m(new THREE.MeshBasicMaterial({ color: pal.accent }));
  mats.cone = B.m(new THREE.MeshBasicMaterial({
    color: pal.accent, transparent: true, opacity: 0.0,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  }));
  B.glowMats.push(mats.hull, mats.stripe);
  return mats;
}

// Deck sole plate over the flat part of the cockpit floor.
function buildSole(B, mats, spec, z0, z1) {
  station(spec, 0.45, _st);
  const w = Math.max(0.4, (_st.hw - Math.min(_st.hw * 0.40, 0.09 + spec.wid * 0.030)) * 1.86);
  const len = (z1 - z0) * spec.len;
  const geo = uvScaled(B.box(w, 0.05, len), spec.wid * 0.5, spec.len * 0.35);
  const m = B.mesh(geo, mats.deck, 0, deckY(spec) + 0.03, (z0 + z1) * 0.5 * spec.len);
  m.castShadow = false;
  return m;
}

/* ------------------------------------------------------------------ *
 * TIER 1 - Dinghy: tiny wooden rowboat, thwarts, oars, lantern.
 * ------------------------------------------------------------------ */
function buildDinghy(B, mats, spec, pal) {
  const L = spec.len, dY = deckY(spec);
  // ribs across the bare floor
  const ribGeo = B.box(spec.wid * 0.74, 0.05, 0.09);
  for (let i = -2; i <= 2; i++) {
    const m = B.mesh(ribGeo, mats.trim, 0, dY + 0.03, i * L * 0.13);
    m.scale.x = 0.72 + 0.28 * (1 - Math.abs(i) / 2.6);
    m.castShadow = false;
  }
  // thwarts (seat 0 aft at the tiller, seat 1 forward)
  buildBench(B, mats, spec.wid * 0.80, 0.30, 0, dY + 0.40, -L * 0.14);
  buildBench(B, mats, spec.wid * 0.72, 0.28, 0, dY + 0.40, L * 0.14);
  // transom knee + tiller
  B.mesh(B.box(spec.wid * 0.5, 0.10, 0.30), mats.trim, 0, dY + 0.44, -L * 0.42);
  const tiller = B.mesh(B.box(0.06, 0.06, 0.95), mats.trim, 0, dY + 0.60, -L * 0.30);
  tiller.rotation.x = -0.12;
  B.anim.rudder = B.mesh(B.box(0.05, 0.55, 0.34), mats.trim, 0, -spec.depth * 0.55, -L * 0.49);
  // oarlocks + oars
  const lockGeo = B.cyl(0.045, 0.05, 0.16, 8);
  for (let s = -1; s <= 1; s += 2) {
    station(spec, 0.47, _st);
    const lx = s * _st.hw * 0.98;
    B.mesh(lockGeo, mats.metal, lx, _st.gy + 0.06, -L * 0.02);
    const pivot = new THREE.Group();
    pivot.position.set(lx, _st.gy + 0.10, -L * 0.02);
    B.root.add(pivot);
    const shaft = B.mesh(B.cyl(0.035, 0.045, 2.5, 7), mats.deck, 0, 0, 0, pivot);
    shaft.rotation.z = Math.PI * 0.5;
    shaft.position.set(s * 0.75, 0, 0);
    const blade = B.mesh(B.box(0.03, 0.30, 0.44), mats.deck, s * 2.05, 0, 0, pivot);
    blade.rotation.z = s * 0.1;
    pivot.rotation.z = s * -0.16;
    pivot.rotation.y = s * 0.10;
    B.anim.oars.push({ pivot: pivot, side: s });
  }
  // bow rope coil + mooring cleat
  station(spec, 0.86, _st);
  const coil = B.mesh(B.g(new THREE.TorusGeometry(0.16, 0.045, 5, 12)), mats.rope, 0, _st.chineY + 0.14, L * 0.34);
  coil.rotation.x = Math.PI * 0.5;
  buildCleat(B, mats, 0, _st.gy + 0.04, L * 0.40);
  // bait bucket
  const bucket = B.mesh(B.cyl(0.17, 0.14, 0.30, 10), mats.metal, spec.wid * 0.18, dY + 0.18, -L * 0.30);
  bucket.material = mats.metal;
  B.mesh(B.g(new THREE.TorusGeometry(0.17, 0.015, 4, 10)), mats.trim, spec.wid * 0.18, dY + 0.32, -L * 0.30).rotation.x = Math.PI * 0.5;
  // bow lantern - warm and charming at night
  station(spec, 0.94, _st);
  const post = B.mesh(B.cyl(0.03, 0.035, 0.55, 6), mats.metal, 0, _st.gy + 0.28, L * 0.44);
  const lantern = B.mesh(B.box(0.16, 0.20, 0.16), mats.trim, 0, _st.gy + 0.64, L * 0.44);
  const lens = B.mesh(B.box(0.11, 0.13, 0.11), B.m(new THREE.MeshBasicMaterial({ color: 0xffc069 })), 0, _st.gy + 0.64, L * 0.44);
  lens.castShadow = false;
  const lsp = B.sprite(0xffb44a, 1.5, 0, _st.gy + 0.64, L * 0.44);
  B.anim.beacons.push({ sprite: lsp, mat: lens.material, col: new THREE.Color(0xffc069), base: 0.55, rate: 0, warm: true });
  void post; void lantern; void coil;
}

/* ------------------------------------------------------------------ *
 * TIER 2 - Skiff: outboard, console, windshield, benches.
 * ------------------------------------------------------------------ */
function buildSkiff(B, mats, spec, pal) {
  const L = spec.len, W = spec.wid, dY = deckY(spec);
  buildSole(B, mats, spec, -0.44, 0.20);
  // gunwale rub rail
  B.mesh(B.g(buildRailGeometry(spec, 16, 0.015, 0.055, 0)), mats.trim, 0, 0, 0);
  // console + windshield + wheel
  const cX = W * 0.02;
  B.mesh(uvScaled(B.box(0.78, 0.86, 0.60), 1, 1), mats.hull, cX, dY + 0.46, L * 0.20);
  B.mesh(B.box(0.86, 0.08, 0.68), mats.trim, cX, dY + 0.90, L * 0.20);
  const shield = B.mesh(B.g(new THREE.PlaneGeometry(0.80, 0.42)), mats.glass, cX, dY + 1.12, L * 0.235);
  shield.rotation.x = -0.42;
  shield.castShadow = false;
  const frame = B.mesh(B.box(0.86, 0.05, 0.05), mats.metal, cX, dY + 1.30, L * 0.20);
  frame.rotation.x = -0.42;
  buildWheel(B, mats, 0.20, cX, dY + 0.78, L * 0.14, 0.55);
  // throttle lever
  B.mesh(B.box(0.07, 0.07, 0.20), mats.metal, cX + 0.50, dY + 0.86, L * 0.20);
  B.mesh(B.cyl(0.022, 0.022, 0.30, 6), mats.trim, cX + 0.50, dY + 1.00, L * 0.18).rotation.x = 0.35;
  // benches
  buildBench(B, mats, W * 0.86, 0.40, 0, dY + 0.44, L * 0.12);
  buildBench(B, mats, W * 0.86, 0.42, 0, dY + 0.44, -L * 0.20);
  B.mesh(B.box(W * 0.86, 0.36, 0.07), mats.deck, 0, dY + 0.62, -L * 0.20 - 0.20);
  // side lockers
  const lockerGeo = uvScaled(B.box(0.34, 0.30, L * 0.30), 1, 2);
  for (let s = -1; s <= 1; s += 2) {
    station(spec, 0.35, _st);
    B.mesh(lockerGeo, mats.deck, s * (_st.hw - 0.30), dY + 0.18, -L * 0.05);
  }
  // outboard motor on the transom
  station(spec, 0.02, _st);
  B.anim.motor = buildMotor(B, mats, 1.0, 0, _st.gy - 0.02, -L * 0.50 - 0.16);
  // nav lights + bow rail + cleats
  station(spec, 0.88, _st);
  B.anim.navPort = buildNavLight(B, mats, 0xff4433, _st.hw * 0.9, _st.gy + 0.10, _st.z, 0.055);
  B.anim.navStbd = buildNavLight(B, mats, 0x44ff66, -_st.hw * 0.9, _st.gy + 0.10, _st.z, 0.055);
  B.mesh(B.g(buildRailGeometry(spec, 16, 0.34, 0.032, 0.72)), mats.metal, 0, 0, 0);
  station(spec, 0.94, _st);
  buildCleat(B, mats, 0, _st.gy + 0.05, L * 0.44);
  buildLifeRing(B, mats, 0.26, -W * 0.30, dY + 0.95, -L * 0.34, 0);
  // pennant
  station(spec, 0.90, _st);
  buildFlag(B, mats, 0.62, 0.34, 0, _st.gy + 0.05, L * 0.40, 1.05);
  void pal;
}
const _dummy = new THREE.Object3D();

// Posts standing on the sheer line, drawn as one instanced mesh.
function buildRailPosts(B, mats, spec, stations, height, radius, fromU) {
  const slots = [];
  for (let i = Math.max(1, Math.round(fromU * (stations - 1))); i < stations - 1; i += 2) {
    const u = i / (stations - 1);
    station(spec, u, _st);
    slots.push([_st.hw * 0.94, _st.gy, _st.z]);
    slots.push([-_st.hw * 0.94, _st.gy, _st.z]);
  }
  if (!slots.length) return null;
  const geo = B.cyl(radius, radius * 1.2, height, 6);
  const inst = new THREE.InstancedMesh(geo, mats.metal, slots.length);
  inst.castShadow = true;
  inst.receiveShadow = true;
  for (let i = 0; i < slots.length; i++) {
    _dummy.position.set(slots[i][0], slots[i][1] + height * 0.5, slots[i][2]);
    _dummy.rotation.set(0, 0, 0);
    _dummy.scale.set(1, 1, 1);
    _dummy.updateMatrix();
    inst.setMatrixAt(i, _dummy.matrix);
  }
  inst.instanceMatrix.needsUpdate = true;
  B.root.add(inst);
  return inst;
}

/* ------------------------------------------------------------------ *
 * TIER 3 - Cutter: forward cuddy cabin, T-top helm, rails, nav lights.
 * ------------------------------------------------------------------ */
function buildCutter(B, mats, spec, pal) {
  const L = spec.len, W = spec.wid, dY = deckY(spec);
  buildSole(B, mats, spec, -0.44, 0.22);
  B.mesh(B.g(buildRailGeometry(spec, 18, 0.018, 0.065, 0)), mats.trim, 0, 0, 0);

  // ---- forward cuddy cabin ----
  const cabZ = L * 0.29, cabD = L * 0.26, cabW = W * 0.66, cabH = 1.12;
  const cabin = B.mesh(uvScaled(B.box(cabW, cabH, cabD), 1, 1), mats.hull, 0, dY + cabH * 0.5 + 0.05, cabZ);
  cabin.name = 'cuddy';
  // sloped front face
  const front = B.mesh(B.box(cabW * 0.98, 0.09, 0.62), mats.hull, 0, dY + cabH + 0.02, cabZ + cabD * 0.42);
  front.rotation.x = 0.55;
  // roof + trim
  B.mesh(uvScaled(B.box(cabW * 1.06, 0.10, cabD * 1.05), 1, 1), mats.trim, 0, dY + cabH + 0.10, cabZ);
  // windows
  const winSide = B.g(new THREE.PlaneGeometry(cabD * 0.62, 0.38));
  for (let s = -1; s <= 1; s += 2) {
    const w = B.mesh(winSide, mats.glass, s * (cabW * 0.5 + 0.012), dY + cabH * 0.66, cabZ - cabD * 0.06);
    w.rotation.y = s * Math.PI * 0.5;
    w.castShadow = false;
  }
  const winFront = B.mesh(B.g(new THREE.PlaneGeometry(cabW * 0.74, 0.34)), mats.glass, 0, dY + cabH * 0.74, cabZ + cabD * 0.51);
  winFront.castShadow = false;
  // cabin door at the aft face
  B.mesh(B.box(cabW * 0.42, 0.86, 0.06), mats.dark, 0, dY + 0.48, cabZ - cabD * 0.5 - 0.02);

  // ---- helm station under a T-top ----
  const hz = L * 0.09;
  B.mesh(uvScaled(B.box(0.95, 0.94, 0.62), 1, 1), mats.hull, 0, dY + 0.50, hz + 0.14);
  B.mesh(B.box(1.02, 0.09, 0.72), mats.trim, 0, dY + 0.99, hz + 0.14);
  buildWheel(B, mats, 0.24, 0, dY + 0.86, hz - 0.08, 0.5);
  B.mesh(B.box(0.10, 0.09, 0.26), mats.metal, 0.56, dY + 0.95, hz + 0.14);
  B.mesh(B.cyl(0.026, 0.026, 0.34, 6), mats.trim, 0.56, dY + 1.12, hz + 0.10).rotation.x = 0.4;
  // canopy
  const postGeo = B.cyl(0.045, 0.05, 1.95, 7);
  for (let sx = -1; sx <= 1; sx += 2) {
    for (let sz = -1; sz <= 1; sz += 2) {
      B.mesh(postGeo, mats.metal, sx * W * 0.30, dY + 1.02, hz + sz * 0.52);
    }
  }
  B.mesh(uvScaled(B.box(W * 0.74, 0.10, 1.5), 1, 1), mats.trim, 0, dY + 2.02, hz);
  B.mesh(B.box(W * 0.68, 0.04, 1.36), mats.hull, 0, dY + 2.08, hz).castShadow = false;

  // ---- mast + lights ----
  B.mesh(B.cyl(0.05, 0.07, 1.5, 7), mats.metal, 0, dY + 2.80, hz);
  B.mesh(B.box(0.62, 0.05, 0.05), mats.metal, 0, dY + 3.35, hz);
  const mastLight = buildNavLight(B, mats, 0xfff0cc, 0, dY + 3.62, hz, 0.06);
  B.anim.beacons.push({ sprite: mastLight.sprite, mat: mastLight.mat, col: new THREE.Color(0xfff0cc), base: 0.5, rate: 0, warm: true });
  station(spec, 0.86, _st);
  B.anim.navPort = buildNavLight(B, mats, 0xff4433, _st.hw * 0.92, _st.gy + 0.12, _st.z, 0.06);
  B.anim.navStbd = buildNavLight(B, mats, 0x44ff66, -_st.hw * 0.92, _st.gy + 0.12, _st.z, 0.06);

  // ---- rails, hatch, gear ----
  B.mesh(B.g(buildRailGeometry(spec, 18, 0.66, 0.034, 0.10)), mats.metal, 0, 0, 0);
  buildRailPosts(B, mats, spec, 18, 0.66, 0.028, 0.10);
  B.mesh(uvScaled(B.box(W * 0.52, 0.12, 1.0), 1, 1), mats.deck, 0, dY + 0.10, -L * 0.30);
  B.mesh(B.box(0.14, 0.14, 0.14), mats.metal, W * 0.18, dY + 0.20, -L * 0.30);
  buildLifeRing(B, mats, 0.30, W * 0.34, dY + 1.30, hz + 0.70, 0);
  buildLifeRing(B, mats, 0.30, -W * 0.34, dY + 1.30, hz + 0.70, 0);
  station(spec, 0.94, _st);
  buildCleat(B, mats, 0, _st.gy + 0.06, L * 0.44);
  buildCleat(B, mats, W * 0.30, dY + 0.55, -L * 0.42);
  buildCleat(B, mats, -W * 0.30, dY + 0.55, -L * 0.42);
  // exhaust + rudder
  B.mesh(B.cyl(0.09, 0.09, 0.24, 8), mats.dark, W * 0.24, -0.10, -L * 0.49).rotation.x = Math.PI * 0.5;
  B.anim.rudder = B.mesh(B.box(0.07, 0.72, 0.46), mats.metal, 0, -spec.depth * 0.72, -L * 0.47);
  const propPivot = new THREE.Group();
  propPivot.position.set(0, -spec.depth * 0.66, -L * 0.44);
  B.root.add(propPivot);
  const hub = B.mesh(B.cyl(0.07, 0.07, 0.14, 8), mats.metal, 0, 0, 0, propPivot);
  hub.rotation.x = Math.PI * 0.5;
  const bladeGeo = B.box(0.07, 0.34, 0.03);
  for (let i = 0; i < 4; i++) {
    const bl = B.mesh(bladeGeo, mats.metal, 0, 0, 0, propPivot);
    const a = (i / 4) * Math.PI * 2;
    bl.position.set(Math.sin(a) * -0.17, Math.cos(a) * 0.17, 0);
    bl.rotation.z = a;
    bl.rotation.y = 0.5;
  }
  B.anim.props.push(propPivot);
  buildFlag(B, mats, 0.72, 0.40, 0, dY + 0.18, -L * 0.44, 1.35);
  void pal;
}

/* ------------------------------------------------------------------ *
 * TIER 4 - Abyss-Runner: armoured hull, deep-lamp gantry, crane, pods.
 * ------------------------------------------------------------------ */
function buildAbyssRunner(B, mats, spec, pal) {
  const L = spec.len, W = spec.wid, dY = deckY(spec);
  buildSole(B, mats, spec, -0.44, 0.20);
  B.mesh(B.g(buildRailGeometry(spec, 20, 0.02, 0.075, 0)), mats.trim, 0, 0, 0);

  // ---- armour plates + rivets along both flanks ----
  const plates = [];
  const rivets = [];
  for (let i = 3; i < 16; i++) {
    const u = i / 19;
    station(spec, u, _st);
    for (let s = -1; s <= 1; s += 2) {
      plates.push([s * (_st.hw + 0.03), (_st.gy + _st.chineY) * 0.5, _st.z, s]);
      rivets.push([s * (_st.hw + 0.07), _st.gy - 0.16, _st.z, s]);
      rivets.push([s * (_st.hw + 0.07), _st.chineY + 0.06, _st.z, s]);
    }
  }
  const plateGeo = B.box(0.07, 0.44, L / 19 * 1.15);
  const plateInst = new THREE.InstancedMesh(plateGeo, mats.metal, plates.length);
  plateInst.castShadow = true; plateInst.receiveShadow = true;
  for (let i = 0; i < plates.length; i++) {
    const p = plates[i];
    _dummy.position.set(p[0], p[1], p[2]);
    _dummy.rotation.set(0, 0, p[3] * 0.16);
    _dummy.scale.set(1, 1, 1);
    _dummy.updateMatrix();
    plateInst.setMatrixAt(i, _dummy.matrix);
  }
  plateInst.instanceMatrix.needsUpdate = true;
  B.root.add(plateInst);

  const rivGeo = B.cyl(0.035, 0.035, 0.05, 6);
  const rivInst = new THREE.InstancedMesh(rivGeo, mats.metal, rivets.length);
  rivInst.castShadow = false; rivInst.receiveShadow = true;
  for (let i = 0; i < rivets.length; i++) {
    const p = rivets[i];
    _dummy.position.set(p[0], p[1], p[2]);
    _dummy.rotation.set(0, 0, p[3] * Math.PI * 0.5);
    _dummy.scale.set(1, 1, 1);
    _dummy.updateMatrix();
    rivInst.setMatrixAt(i, _dummy.matrix);
  }
  rivInst.instanceMatrix.needsUpdate = true;
  B.root.add(rivInst);

  // ---- armoured wheelhouse ----
  const cabZ = L * 0.27, cabD = L * 0.24, cabW = W * 0.64, cabH = 1.24;
  B.mesh(uvScaled(B.box(cabW, cabH, cabD), 1, 1), mats.hull, 0, dY + cabH * 0.5 + 0.06, cabZ);
  const slope = B.mesh(B.box(cabW * 0.99, 0.10, 0.72), mats.hull, 0, dY + cabH + 0.02, cabZ + cabD * 0.40);
  slope.rotation.x = 0.62;
  B.mesh(uvScaled(B.box(cabW * 1.08, 0.12, cabD * 1.06), 1, 1), mats.trim, 0, dY + cabH + 0.12, cabZ);
  const winF = B.mesh(B.g(new THREE.PlaneGeometry(cabW * 0.72, 0.30)), mats.glass, 0, dY + cabH * 0.80, cabZ + cabD * 0.51);
  winF.castShadow = false;
  const winSide = B.g(new THREE.PlaneGeometry(cabD * 0.56, 0.28));
  for (let s = -1; s <= 1; s += 2) {
    const w = B.mesh(winSide, mats.glass, s * (cabW * 0.5 + 0.012), dY + cabH * 0.74, cabZ);
    w.rotation.y = s * Math.PI * 0.5;
    w.castShadow = false;
  }
  // cyan strip lighting along the cabin base
  const stripGeo = B.box(cabW * 1.02, 0.05, cabD * 1.0);
  const strip = B.mesh(stripGeo, mats.lamp, 0, dY + 0.10, cabZ);
  strip.castShadow = false;

  // ---- helm + canopy ----
  const hz = L * 0.06;
  B.mesh(uvScaled(B.box(1.05, 1.00, 0.66), 1, 1), mats.hull, 0, dY + 0.52, hz + 0.16);
  B.mesh(B.box(1.14, 0.10, 0.78), mats.trim, 0, dY + 1.05, hz + 0.16);
  buildWheel(B, mats, 0.26, 0, dY + 0.90, hz - 0.10, 0.5);
  const screen = B.mesh(B.g(new THREE.PlaneGeometry(0.34, 0.22)), mats.lamp, -0.34, dY + 1.14, hz + 0.10);
  screen.rotation.x = -0.5;
  screen.castShadow = false;
  const postGeo = B.cyl(0.055, 0.06, 2.05, 7);
  for (let sx = -1; sx <= 1; sx += 2) {
    for (let sz = -1; sz <= 1; sz += 2) {
      B.mesh(postGeo, mats.metal, sx * W * 0.30, dY + 1.06, hz + sz * 0.56);
    }
  }
  B.mesh(uvScaled(B.box(W * 0.76, 0.12, 1.6), 1, 1), mats.trim, 0, dY + 2.12, hz);

  // ---- bow gantry with deep-lamps ----
  station(spec, 0.78, _st);
  const gz = _st.z, gH = 2.3, gx = _st.hw * 0.80;
  const gPost = B.cyl(0.07, 0.08, gH, 7);
  B.mesh(gPost, mats.metal, gx, _st.gy + gH * 0.5, gz);
  B.mesh(gPost, mats.metal, -gx, _st.gy + gH * 0.5, gz);
  B.mesh(B.box(gx * 2.1, 0.13, 0.16), mats.metal, 0, _st.gy + gH, gz);
  B.mesh(B.box(0.10, 0.10, 1.1), mats.metal, gx, _st.gy + gH - 0.30, gz - 0.5).rotation.x = 0.5;
  B.mesh(B.box(0.10, 0.10, 1.1), mats.metal, -gx, _st.gy + gH - 0.30, gz - 0.5).rotation.x = 0.5;
  const lampY = _st.gy + gH - 0.22;
  for (let s = -1; s <= 1; s += 2) {
    const housing = B.mesh(B.cyl(0.20, 0.24, 0.36, 10), mats.motor, s * gx * 0.72, lampY, gz + 0.10);
    housing.rotation.x = Math.PI * 0.5 - 0.30;
    const lens = B.mesh(B.cyl(0.19, 0.19, 0.05, 10), mats.lamp, s * gx * 0.72, lampY - 0.06, gz + 0.28);
    lens.rotation.x = Math.PI * 0.5 - 0.30;
    lens.castShadow = false;
    B.anim.lampLens.push(lens);
    const sp = B.sprite(pal.accent, 2.2, s * gx * 0.72, lampY - 0.06, gz + 0.30);
    sp.material.opacity = 0;
    B.anim.beacons.push({ sprite: sp, mat: null, base: 0.0, rate: 0, lamp: true });
    // volumetric shaft
    const cone = new THREE.Mesh(B.g(new THREE.ConeGeometry(2.4, 16, 12, 1, true)), mats.cone);
    cone.position.set(s * gx * 0.72, lampY - 3.6, gz + 7.2);
    cone.rotation.x = Math.PI * 0.5 + 0.30;
    cone.castShadow = false;
    cone.renderOrder = 3;
    B.root.add(cone);
    B.anim.lampCones.push(cone);
  }
  // real light that actually pools on the water ahead
  const spot = new THREE.SpotLight(0x7bf0ff, 0, 70, Math.PI * 0.20, 0.55, 1.0);
  spot.position.set(0, lampY, gz);
  spot.castShadow = false;
  B.root.add(spot);
  spot.target.position.set(0, -7, gz + 26);
  B.root.add(spot.target);
  B.anim.lampSpot = spot;

  // ---- stern crane ----
  const crane = new THREE.Group();
  crane.position.set(W * 0.26, dY + 0.10, -L * 0.30);
  B.root.add(crane);
  B.mesh(B.cyl(0.22, 0.26, 0.20, 8), mats.metal, 0, 0.10, 0, crane);
  const mast = B.mesh(B.cyl(0.10, 0.12, 1.5, 8), mats.metal, 0, 0.90, 0, crane);
  const arm = B.mesh(B.box(0.14, 0.14, 1.9), mats.metal, 0, 1.58, -0.72, crane);
  arm.rotation.x = 0.30;
  const cable = B.mesh(B.cyl(0.014, 0.014, 0.95, 4), mats.dark, 0, 1.10, -1.55, crane);
  const hook = B.mesh(B.g(new THREE.TorusGeometry(0.09, 0.028, 5, 10)), mats.metal, 0, 0.62, -1.55, crane);
  hook.rotation.y = Math.PI * 0.5;
  B.anim.crane = { group: crane, hook: hook, cable: cable };
  void mast;

  // ---- twin pods ----
  station(spec, 0.02, _st);
  B.anim.motor = buildMotor(B, mats, 1.15, W * 0.24, _st.gy - 0.04, -L * 0.50 - 0.18);
  const pod2 = buildMotor(B, mats, 1.15, -W * 0.24, _st.gy - 0.04, -L * 0.50 - 0.18);
  B.anim.motor2 = pod2;

  // ---- rails, lights, gear ----
  B.mesh(B.g(buildRailGeometry(spec, 20, 0.72, 0.038, 0.10)), mats.metal, 0, 0, 0);
  buildRailPosts(B, mats, spec, 20, 0.72, 0.030, 0.10);
  station(spec, 0.86, _st);
  B.anim.navPort = buildNavLight(B, mats, 0xff4433, _st.hw * 0.92, _st.gy + 0.14, _st.z, 0.065);
  B.anim.navStbd = buildNavLight(B, mats, 0x44ff66, -_st.hw * 0.92, _st.gy + 0.14, _st.z, 0.065);
  const beacon = buildNavLight(B, mats, 0xff2a2a, 0, dY + 2.34, hz, 0.07);
  B.anim.beacons.push({ sprite: beacon.sprite, mat: beacon.mat, col: new THREE.Color(0xff2a2a), base: 0.8, rate: 2.2 });
  B.mesh(B.cyl(0.03, 0.03, 1.1, 5), mats.metal, W * 0.22, dY + 2.65, hz - 0.4);
  B.mesh(B.cyl(0.03, 0.03, 0.8, 5), mats.metal, -W * 0.22, dY + 2.50, hz - 0.4);
  buildLifeRing(B, mats, 0.32, -W * 0.32, dY + 1.36, hz + 0.74, 0);
  buildCleat(B, mats, 0, _st.gy + 0.07, L * 0.44);
  buildFlag(B, mats, 0.78, 0.42, 0, dY + 0.20, -L * 0.45, 1.5);
}
/* ------------------------------------------------------------------ *
 * Seats. Index 0 is always the helm. Positions are feet-level anchors
 * on the deck, in boat-local space.
 * ------------------------------------------------------------------ */
function seatLayout(level, spec) {
  const L = spec.len, W = spec.wid, y = deckY(spec) + 0.06;
  const raw = [];
  if (level === 1) {
    raw.push([0, -L * 0.14], [0, L * 0.14]);
  } else if (level === 2) {
    raw.push([W * 0.19, L * 0.12], [-W * 0.19, L * 0.12], [W * 0.21, -L * 0.20], [-W * 0.21, -L * 0.20]);
  } else if (level === 3) {
    raw.push([W * 0.17, L * 0.04], [-W * 0.17, L * 0.04],
             [W * 0.25, -L * 0.14], [-W * 0.25, -L * 0.14],
             [W * 0.25, -L * 0.30], [-W * 0.25, -L * 0.30]);
  } else {
    raw.push([W * 0.17, L * 0.01], [-W * 0.17, L * 0.01],
             [W * 0.25, -L * 0.13], [-W * 0.25, -L * 0.13],
             [W * 0.25, -L * 0.25], [-W * 0.25, -L * 0.25],
             [W * 0.25, -L * 0.37], [-W * 0.25, -L * 0.37]);
  }
  const out = [];
  for (let i = 0; i < raw.length; i++) out.push(new THREE.Vector3(raw[i][0], y, raw[i][1]));
  return out;
}

function buildBoatVisual(level) {
  const spec = SPECS[level];
  const pal = PALETTES[level];
  const root = new THREE.Group();
  const B = makeBuilder(root);
  const mats = makeMaterials(B, pal, level);
  const stations = level === 1 ? 15 : (level === 4 ? 21 : 19);
  const hull = B.mesh(B.g(buildHullGeometry(spec, stations)), mats.hull, 0, 0, 0);
  hull.name = 'hull';
  const stripe = B.mesh(B.g(buildStripeGeometry(spec, stations, 0.12, 0.36)), mats.stripe, 0, 0, 0);
  stripe.castShadow = false;
  const boot = B.mesh(B.g(buildStripeGeometry(spec, stations, 0.86, 1.0)), mats.trim, 0, 0, 0);
  boot.castShadow = false;
  if (level === 1) buildDinghy(B, mats, spec, pal);
  else if (level === 2) buildSkiff(B, mats, spec, pal);
  else if (level === 3) buildCutter(B, mats, spec, pal);
  else buildAbyssRunner(B, mats, spec, pal);
  B.seats = seatLayout(level, spec);
  B.mats = mats;
  B.spec = spec;
  B.pal = pal;
  return B;
}

/* ------------------------------------------------------------------ *
 * Wake: a V of foam sheets drawn in world space, draped over the waves.
 * ------------------------------------------------------------------ */
const WAKE_ALONG = 10;
const WAKE_ACROSS = 3;

function buildWake() {
  const arms = 2;
  const vertsPerArm = WAKE_ALONG * WAKE_ACROSS;
  const total = vertsPerArm * arms;
  const pos = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  const idx = [];
  for (let a = 0; a < arms; a++) {
    const base = a * vertsPerArm;
    for (let i = 0; i < WAKE_ALONG; i++) {
      for (let j = 0; j < WAKE_ACROSS; j++) {
        const v = base + i * WAKE_ACROSS + j;
        uv[v * 2] = j / (WAKE_ACROSS - 1);
        uv[v * 2 + 1] = i / (WAKE_ALONG - 1);
      }
    }
    for (let i = 0; i < WAKE_ALONG - 1; i++) {
      for (let j = 0; j < WAKE_ACROSS - 1; j++) {
        const p = base + i * WAKE_ACROSS + j;
        idx.push(p, p + WAKE_ACROSS, p + 1, p + 1, p + WAKE_ACROSS, p + WAKE_ACROSS + 1);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 0 } },
    vertexShader: [
      'varying vec2 vUv;',
      'void main() {',
      '  vUv = uv;',
      '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
      '}',
    ].join('\n'),
    fragmentShader: [
      'uniform float uOpacity;',
      'varying vec2 vUv;',
      'void main() {',
      '  float across = vUv.x;',
      '  float crest = smoothstep(0.30, 0.86, across) * smoothstep(1.0, 0.88, across);',
      '  float fill = sin(across * 3.14159) * 0.34;',
      '  float along = pow(1.0 - vUv.y, 1.3) * smoothstep(0.0, 0.07, vUv.y);',
      '  float a = (crest * 1.25 + fill) * along * uOpacity;',
      '  if (a < 0.004) discard;',
      '  gl_FragColor = vec4(1.0, 1.0, 1.0, a);',
      '}',
    ].join('\n'),
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  mesh.visible = false;
  return { mesh: mesh, geo: geo, mat: mat, pos: pos };
}

/* ------------------------------------------------------------------ *
 * Foam particles (spray + prop wash), world space, pooled.
 * ------------------------------------------------------------------ */
const FOAM_COUNT = 150;

function buildFoam() {
  const pos = new Float32Array(FOAM_COUNT * 3);
  const size = new Float32Array(FOAM_COUNT);
  const alpha = new Float32Array(FOAM_COUNT);
  for (let i = 0; i < FOAM_COUNT; i++) { pos[i * 3 + 1] = -9999; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTint: { value: new THREE.Color(0xffffff) } },
    vertexShader: [
      'attribute float aSize;',
      'attribute float aAlpha;',
      'varying float vAlpha;',
      'void main() {',
      '  vAlpha = aAlpha;',
      '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
      '  gl_PointSize = aSize * (330.0 / max(1.0, -mv.z));',
      '  gl_Position = projectionMatrix * mv;',
      '}',
    ].join('\n'),
    fragmentShader: [
      'uniform vec3 uTint;',
      'varying float vAlpha;',
      'void main() {',
      '  vec2 d = gl_PointCoord - 0.5;',
      '  float r = length(d);',
      '  if (r > 0.5) discard;',
      '  float a = smoothstep(0.5, 0.14, r) * vAlpha;',
      '  if (a < 0.01) discard;',
      '  gl_FragColor = vec4(uTint, a);',
      '}',
    ].join('\n'),
    transparent: true, depthWrite: false,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 3;
  const parts = new Array(FOAM_COUNT);
  for (let i = 0; i < FOAM_COUNT; i++) {
    parts[i] = { life: 0, max: 1, vx: 0, vy: 0, vz: 0, size: 1, alpha: 0 };
  }
  return { points: points, geo: geo, mat: mat, pos: pos, size: size, alpha: alpha, parts: parts, cursor: 0, live: 0 };
}
/* ================================================================== *
 * initBoat
 * ================================================================== */
export function initBoat(ctx) {
  const group = new THREE.Group();
  group.name = 'teamBoat';
  if (ctx.scene) ctx.scene.add(group);

  let level = 1;
  let spec = SPECS[level];
  let build = buildBoatVisual(level);
  group.add(build.root);

  const S = {
    pos: new THREE.Vector3(0, 0, -152),
    yaw: 0, pitch: 0, roll: 0,
    pitchV: 0, rollV: 0, vy: 0,
    vel: new THREE.Vector3(),
    speed: 0, fwd: 0, yawRate: 0,
    throttle: 0, steer: 0, throttleVis: 0, steerVis: 0,
    propSpin: 0, glow: 0, lamp: 0, bump: 0,
  };

  const net = {
    has: false, age: 0, r: 0,
    p: new THREE.Vector3(), v: new THREE.Vector3(),
    driverId: null, seats: [],
  };

  let moored = false;
  let moorTimer = 0;
  let rebuildTimer = 0;
  let firstBuild = true;
  let wasDriver = false;
  let netAcc = 0;
  let spawnAcc = 0;
  let nearTimer = 0;
  let nearCache = false;
  let sfxTimer = 0;
  let sfxOn = false;
  let sfxThr = -1;

  /* ---------------- world-space effects ---------------- */
  const wake = buildWake();
  const foam = buildFoam();
  const ringGeo = new THREE.RingGeometry(0.80, 1.0, 56, 1);
  const ringMat = new THREE.MeshBasicMaterial({
    color: PALETTES[1].glow, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI * 0.5;
  ring.visible = false;
  ring.frustumCulled = false;
  if (ctx.scene) { ctx.scene.add(wake.mesh); ctx.scene.add(foam.points); ctx.scene.add(ring); }
  ring.scale.setScalar(Math.max(spec.len, spec.wid) * 0.62);

  /* ---------------- small guarded helpers ---------------- */
  function waterAt(x, z, t) {
    const f = ctx.getWaterHeight;
    if (typeof f !== 'function') return 0;
    const h = f(x, z, t);
    return (typeof h === 'number' && isFinite(h)) ? h : 0;
  }
  function terrainAt(x, z) {
    const w = ctx.world;
    if (!w || typeof w.getTerrainHeight !== 'function') return -50;
    const h = w.getTerrainHeight(x, z);
    return (typeof h === 'number' && isFinite(h)) ? h : -50;
  }
  function safeSfx(name, opts) {
    const a = ctx.audio;
    if (!a || typeof a.sfx !== 'function') return;
    try { a.sfx(name, opts); } catch (e) { /* audio is optional */ }
  }
  function myId() {
    const st = ctx.state;
    if (st && st.myId) return st.myId;
    if (ctx.net && typeof ctx.net.id === 'function') { try { return ctx.net.id(); } catch (e) { return null; } }
    return null;
  }
  function asVec(c) {
    if (!c) return null;
    if (typeof c.x === 'number' && typeof c.z === 'number') return c;
    if (Array.isArray(c) && c.length >= 3) return _v3.set(c[0], c[1], c[2]);
    return null;
  }
  function vecOf(o) {
    if (!o) return null;
    let v = asVec(o.position);
    if (v) return v;
    v = asVec(o.pos);
    if (v) return v;
    if (o.group) { v = asVec(o.group.position); if (v) return v; }
    if (o.char && o.char.group) { v = asVec(o.char.group.position); if (v) return v; }
    return asVec(o.p);
  }
  function localPlayerPos() {
    const pm = ctx.playerMod;
    if (pm) {
      const v = vecOf(pm.local);
      if (v) return v;
    }
    return ctx.camera ? ctx.camera.position : null;
  }

  /* ---------------- boat level ---------------- */
  function readBoatLevel() {
    let lvl = 1;
    const w = ctx.state && ctx.state.world;
    if (w) {
      if (typeof w.boatLevel === 'number' && isFinite(w.boatLevel)) lvl = Math.max(lvl, w.boatLevel);
      if (w.gear && typeof w.gear.boat === 'number') lvl = Math.max(lvl, w.gear.boat);
      if (Array.isArray(w.players)) {
        for (let i = 0; i < w.players.length; i++) {
          const p = w.players[i];
          const g = p && p.gear;
          if (g && typeof g.boat === 'number' && isFinite(g.boat)) lvl = Math.max(lvl, g.boat);
        }
      }
    }
    const gear = ctx.state && ctx.state.gear;
    if (gear && typeof gear.boat === 'number' && isFinite(gear.boat)) lvl = Math.max(lvl, gear.boat);
    return clamp(Math.round(lvl), 1, 4);
  }

  function rebuild(newLevel) {
    level = newLevel;
    spec = SPECS[level];
    group.remove(build.root);
    build.dispose();
    build = buildBoatVisual(level);
    group.add(build.root);
    ring.scale.setScalar(Math.max(spec.len, spec.wid) * 0.62);
    ringMat.color.setHex(PALETTES[level].glow);
    if (!firstBuild) {
      safeSfx('upgrade', { kind: 'boat', level: level });
      if (ctx.ui && typeof ctx.ui.toast === 'function' && ctx.state && ctx.state.phase === 'playing') {
        try { ctx.ui.toast('The boat is now a ' + spec.name + '!', 'good'); } catch (e) { /* ui optional */ }
      }
    }
    firstBuild = false;
  }

  function maybeRebuild(dt) {
    rebuildTimer -= dt;
    if (rebuildTimer > 0) return;
    rebuildTimer = 0.5;
    const want = readBoatLevel();
    if (want !== level) rebuild(want);
  }

  /* ---------------- mooring ---------------- */
  function moorAtDock() {
    const w = ctx.world;
    const dock = w && w.dockPos;
    if (dock && typeof dock.x === 'number') {
      let ox = dock.x, oz = dock.z;
      const m = Math.hypot(ox, oz) || 1;
      ox /= m; oz /= m;                       // outward from island centre
      const sx = -oz, sz = ox;                // alongside the dock
      S.pos.set(dock.x + ox * (spec.len * 0.32) + sx * (spec.wid * 0.95 + 1.4),
                0,
                dock.z + oz * (spec.len * 0.32) + sz * (spec.wid * 0.95 + 1.4));
      S.yaw = Math.atan2(ox, oz);             // bow pointing out to sea
    } else {
      S.pos.set(6, 0, -152);
      S.yaw = Math.PI;
    }
    S.pos.y = waterAt(S.pos.x, S.pos.z, 0);
    S.vel.set(0, 0, 0);
    S.vy = 0; S.pitch = 0; S.roll = 0; S.pitchV = 0; S.rollV = 0;
    S.speed = 0; S.fwd = 0;
    net.has = false;
    moored = true;
  }

  function ensureMoored(dt) {
    if (moored) return;
    moorTimer += dt;
    const w = ctx.world;
    if ((w && w.dockPos) || moorTimer > 3) moorAtDock();
  }

  /* ---------------- seats / driver ---------------- */
  function seatCount() { return build.seats.length; }

  function seatWorld(i, out) {
    const o = out || new THREE.Vector3();
    const seats = build.seats;
    if (!seats.length) return o.copy(S.pos);
    const idx = clamp(Math.round(i) || 0, 0, seats.length - 1);
    const s = seats[idx];
    o.set(s.x, s.y, s.z);
    _euler.set(S.pitch, S.yaw, S.roll, 'YXZ');
    o.applyEuler(_euler);
    o.add(S.pos);
    return o;
  }

  function isDriver() {
    const id = myId();
    if (!id) return false;
    if (net.driverId) return net.driverId === id;
    if (net.seats && net.seats[0]) return net.seats[0] === id;
    const st = ctx.state;
    return !!(st && st.onBoat && st.seat === 0);
  }

  function nearBoat(p) {
    if (!p || typeof p.x !== 'number' || typeof p.z !== 'number') return false;
    const py = typeof p.y === 'number' ? p.y : S.pos.y;
    if (py - S.pos.y > 9 || py - S.pos.y < -9) return false;
    const dx = p.x - S.pos.x, dz = p.z - S.pos.z;
    const cy = Math.cos(S.yaw), sy = Math.sin(S.yaw);
    const lz = dx * sy + dz * cy;
    const lx = dx * cy - dz * sy;
    const half = spec.len * 0.42;
    const ez = lz > half ? lz - half : (lz < -half ? lz + half : 0);
    const hw = spec.wid * 0.5;
    const alx = Math.abs(lx);
    const ex = alx > hw ? alx - hw : 0;
    return (ex * ex + ez * ez) <= BOARD_RANGE * BOARD_RANGE;
  }
  /* ---------------- physics ---------------- */
  const COL_PTS = [[0, 1], [0, -1], [1, 0.72], [-1, 0.72], [1, -0.72], [-1, -0.72]];

  function readInput() {
    let thr = 0, str = 0;
    const st = ctx.state;
    const keys = ctx.input && ctx.input.keys;
    if (keys && typeof keys.has === 'function' && (!st || st.phase === 'playing')) {
      if (keys.has('KeyW') || keys.has('ArrowUp')) thr += 1;
      if (keys.has('KeyS') || keys.has('ArrowDown')) thr -= 1;
      if (keys.has('KeyA') || keys.has('ArrowLeft')) str += 1;
      if (keys.has('KeyD') || keys.has('ArrowRight')) str -= 1;
    }
    S.throttle = thr;
    S.steer = str;
  }

  function bounds(dt) {
    if (Math.abs(S.pos.x) > WORLD_SOFT) {
      const s = S.pos.x < 0 ? -1 : 1;
      S.vel.x -= s * (Math.abs(S.pos.x) - WORLD_SOFT) * 1.5 * dt;
      if (Math.abs(S.pos.x) > WORLD_BOUND) { S.pos.x = s * WORLD_BOUND; if (S.vel.x * s > 0) S.vel.x = 0; }
    }
    if (Math.abs(S.pos.z) > WORLD_SOFT) {
      const s = S.pos.z < 0 ? -1 : 1;
      S.vel.z -= s * (Math.abs(S.pos.z) - WORLD_SOFT) * 1.5 * dt;
      if (Math.abs(S.pos.z) > WORLD_BOUND) { S.pos.z = s * WORLD_BOUND; if (S.vel.z * s > 0) S.vel.z = 0; }
    }
  }

  function collide(dt, px, pz) {
    const cy = Math.cos(S.yaw), sy = Math.sin(S.yaw);
    const hl = spec.len * 0.46, hw = spec.wid * 0.46;
    let hit = false;
    for (let i = 0; i < COL_PTS.length; i++) {
      const lx = COL_PTS[i][0] * hw, lz = COL_PTS[i][1] * hl;
      const wx = S.pos.x + lx * cy + lz * sy;
      const wz = S.pos.z - lx * sy + lz * cy;
      if (terrainAt(wx, wz) > SHALLOW_LIMIT) { hit = true; break; }
    }
    if (!hit) return;
    S.pos.x = px; S.pos.z = pz;
    const e = 2.2;
    let dx = terrainAt(S.pos.x - e, S.pos.z) - terrainAt(S.pos.x + e, S.pos.z);
    let dz = terrainAt(S.pos.x, S.pos.z - e) - terrainAt(S.pos.x, S.pos.z + e);
    let m = Math.hypot(dx, dz);
    if (m < 1e-4) { dx = -S.vel.x; dz = -S.vel.z; m = Math.hypot(dx, dz) || 1; }
    dx /= m; dz /= m;
    const into = S.vel.x * dx + S.vel.z * dz;
    if (into < 0) { S.vel.x -= dx * into * 1.3; S.vel.z -= dz * into * 1.3; }
    S.pos.x += dx * 1.8 * dt;
    S.pos.z += dz * 1.8 * dt;
    if (S.bump <= 0 && Math.abs(into) > 1.8) {
      S.bump = 0.7;
      safeSfx('splash', { size: 1.5, source: 'boat' });
      if (ctx.water && typeof ctx.water.splash === 'function') {
        try { ctx.water.splash(_v1.set(S.pos.x, S.pos.y, S.pos.z), 2.0); } catch (err) { /* optional */ }
      }
    }
  }

  function simulateDriver(dt) {
    readInput();
    const cy = Math.cos(S.yaw), sy = Math.sin(S.yaw);
    let fwd = S.vel.x * sy + S.vel.z * cy;
    let lat = S.vel.x * cy - S.vel.z * sy;
    if (S.throttle > 0) fwd += spec.accel * dt;
    else if (S.throttle < 0) fwd -= spec.accel * 0.45 * dt;
    fwd -= (spec.drag * fwd + spec.quad * fwd * Math.abs(fwd)) * dt;
    const maxF = spec.maxSpeed * 1.02, maxR = spec.maxSpeed * 0.42;
    if (fwd > maxF) fwd = maxF;
    if (fwd < -maxR) fwd = -maxR;
    lat *= Math.exp(-4.5 * dt);
    const spdFrac = clamp(Math.abs(fwd) / (spec.maxSpeed * 0.42), 0, 1);
    S.yawRate = S.steer * spec.turn * (0.22 + 0.78 * spdFrac) * (fwd < -0.25 ? -1 : 1);
    S.yaw += S.yawRate * dt;
    const ncy = Math.cos(S.yaw), nsy = Math.sin(S.yaw);
    S.vel.x = fwd * nsy + lat * ncy;
    S.vel.z = fwd * ncy - lat * nsy;
    S.fwd = fwd;
    const px = S.pos.x, pz = S.pos.z;
    S.pos.x += S.vel.x * dt;
    S.pos.z += S.vel.z * dt;
    collide(dt, px, pz);
    bounds(dt);
    S.speed = Math.hypot(S.vel.x, S.vel.z);
  }

  function simulateRemote(dt) {
    S.throttle = 0;
    S.steer = 0;
    if (!net.has) {
      const d = Math.exp(-1.1 * dt);
      S.vel.x *= d; S.vel.z *= d;
      S.pos.x += S.vel.x * dt;
      S.pos.z += S.vel.z * dt;
      S.yawRate *= Math.exp(-4 * dt);
      S.speed = Math.hypot(S.vel.x, S.vel.z);
      S.fwd = S.speed;
      return;
    }
    net.age += dt;
    if (net.age < 0.5) { net.p.x += net.v.x * dt; net.p.z += net.v.z * dt; }
    let dxx = net.p.x - S.pos.x, dzz = net.p.z - S.pos.z;
    if (dxx * dxx + dzz * dzz > 900) {
      S.pos.x = net.p.x; S.pos.z = net.p.z; S.yaw = net.r;
      dxx = 0; dzz = 0;
    }
    const k = damp(1 / NET_SMOOTH, dt);
    S.pos.x += dxx * k;
    S.pos.z += dzz * k;
    const prevYaw = S.yaw;
    S.yaw += shortAngle(net.r - S.yaw) * k;
    S.yawRate = dt > 0 ? shortAngle(S.yaw - prevYaw) / dt : 0;
    S.vel.x += (net.v.x - S.vel.x) * k;
    S.vel.z += (net.v.z - S.vel.z) * k;
    S.pos.y += (net.p.y - S.pos.y) * clamp(dt * 0.3, 0, 1);
    bounds(dt);
    S.speed = Math.hypot(S.vel.x, S.vel.z);
    const cy = Math.cos(S.yaw), sy = Math.sin(S.yaw);
    S.fwd = S.vel.x * sy + S.vel.z * cy;
  }

  function applyBuoyancy(dt, t) {
    const cy = Math.cos(S.yaw), sy = Math.sin(S.yaw);
    const cx = spec.wid * 0.42, cz = spec.len * 0.45;
    for (let i = 0; i < 4; i++) {
      const lx = (i & 1) ? -cx : cx;
      const lz = (i < 2) ? cz : -cz;
      const wx = S.pos.x + lx * cy + lz * sy;
      const wz = S.pos.z - lx * sy + lz * cy;
      _cornerX[i] = wx; _cornerZ[i] = wz;
      _cornerH[i] = waterAt(wx, wz, t);
    }
    const hFwd = (_cornerH[0] + _cornerH[1]) * 0.5;
    const hAft = (_cornerH[2] + _cornerH[3]) * 0.5;
    const hPort = (_cornerH[0] + _cornerH[2]) * 0.5;
    const hStb = (_cornerH[1] + _cornerH[3]) * 0.5;
    const spdFrac = clamp(S.speed / spec.maxSpeed, 0, 1);
    const targetY = (hFwd + hAft) * 0.5 + spec.depth * 0.03 + spdFrac * 0.22;
    const prevVy = S.vy;
    S.vy += (targetY - S.pos.y) * 34 * dt;
    S.vy *= Math.exp(-5.2 * dt);
    S.vy = clamp(S.vy, -9, 9);
    S.pos.y += S.vy * dt;
    if (S.bump <= 0 && prevVy < -3.4 && S.vy > prevVy + 0.7) {
      S.bump = 0.45;
      if (ctx.water && typeof ctx.water.splash === 'function') {
        try { ctx.water.splash(_v1.set(S.pos.x, S.pos.y - 0.2, S.pos.z), 1.1 + spdFrac); } catch (err) { /* optional */ }
      }
      if (spdFrac > 0.25) safeSfx('splash', { size: 0.8, source: 'boat' });
    }
    let pitchT = Math.atan2(hAft - hFwd, cz * 2);
    let rollT = Math.atan2(hPort - hStb, cx * 2);
    pitchT -= (S.throttle > 0 ? 0.05 : 0) + spdFrac * 0.06;
    rollT -= S.yawRate * (0.06 + 0.05 * spdFrac);
    S.pitchV += (pitchT - S.pitch) * 30 * dt;
    S.pitchV *= Math.exp(-7 * dt);
    S.pitch = clamp(S.pitch + S.pitchV * dt, -0.55, 0.55);
    S.rollV += (rollT - S.roll) * 26 * dt;
    S.rollV *= Math.exp(-6.5 * dt);
    S.roll = clamp(S.roll + S.rollV * dt, -0.6, 0.6);
  }

  /* ---------------- night / lamps / animated details ---------------- */
  function nightFactor() {
    const st = ctx.state;
    if (st && st.eventActive) return 1;
    const tod = st && typeof st.timeOfDay === 'number' ? st.timeOfDay : 0.3;
    const ns = ECON.NIGHT_START;
    if (tod >= ns - 0.04) return smoothstep(ns - 0.04, ns + 0.04, tod);
    if (tod <= 0.20) return 1 - smoothstep(0.13, 0.20, tod);
    return 0;
  }

  function updateVisuals(dt, t) {
    const a = build.anim;
    S.throttleVis += (S.throttle - S.throttleVis) * damp(7, dt);
    S.steerVis += (S.steer - S.steerVis) * damp(8, dt);
    const spdFrac = clamp(S.speed / spec.maxSpeed, 0, 1);
    // propellers
    if (a.props.length) {
      S.propSpin += (0.6 + Math.abs(S.throttleVis) * 16 + spdFrac * 12) * dt;
      for (let i = 0; i < a.props.length; i++) a.props[i].rotation.z = S.propSpin;
    }
    if (a.motor) a.motor.rotation.y = S.steerVis * 0.42;
    if (a.motor2) a.motor2.rotation.y = S.steerVis * 0.42;
    if (a.rudder) a.rudder.rotation.y = S.steerVis * 0.5;
    if (a.wheel) a.wheel.rotation.z = S.steerVis * 1.9;
    // oars row when the dinghy is under way
    if (a.oars.length) {
      const drive = Math.abs(S.throttleVis) > 0.05 ? 1 : Math.min(1, spdFrac * 2);
      const dir = S.throttleVis < -0.05 ? -1 : 1;
      const ph = t * 2.6;
      // rotation.y sweeps the blade fore/aft, rotation.z lifts it clear of the water
      const sweep = Math.sin(ph) * 0.45 * drive * dir;
      const recovery = Math.max(0, Math.cos(ph)) * drive;
      for (let i = 0; i < a.oars.length; i++) {
        const o = a.oars[i];
        o.pivot.rotation.y = o.side * (0.10 + sweep);
        o.pivot.rotation.z = o.side * (-0.16 + recovery * 0.30);
      }
    }
    // flags
    for (let i = 0; i < a.flags.length; i++) {
      const f = a.flags[i];
      const arr = f.geo.attributes.position.array;
      const base = f.base;
      const gust = 0.5 + 0.5 * spdFrac + 0.25 * Math.sin(t * 0.7);
      for (let v = 0; v < arr.length; v += 3) {
        const bx = base[v], by = base[v + 1];
        const u = clamp((f.w * 0.5 - bx) / f.w, 0, 1);
        arr[v + 2] = (Math.sin(t * 6.5 + u * 8) * 0.10 + Math.sin(t * 3.3 + by * 5) * 0.04) * u * gust;
        arr[v + 1] = by + Math.sin(t * 5.2 + u * 6) * 0.035 * u * gust;
      }
      f.geo.attributes.position.needsUpdate = true;
    }
    // crane sway
    if (a.crane) {
      a.crane.group.rotation.z = -S.roll * 0.35;
      a.crane.hook.position.x = Math.sin(t * 1.3) * 0.06 - S.roll * 0.2;
    }
    // lights
    const night = nightFactor();
    S.lamp += (night - S.lamp) * damp(1.6, dt);
    const flick = 0.92 + 0.08 * Math.sin(t * 9.1) * Math.sin(t * 3.7);
    for (let i = 0; i < a.beacons.length; i++) {
      const b = a.beacons[i];
      if (b.rate > 0) {
        const on = Math.sin(t * b.rate * Math.PI) > 0.55 ? 1 : 0.06;
        b.sprite.material.opacity = b.base * on;
        if (b.mat && b.col) b.mat.color.copy(b.col).multiplyScalar(0.22 + 0.78 * on);
      } else if (b.lamp) {
        b.sprite.material.opacity = S.lamp * 0.9 * flick;
      } else {
        const lit = 0.25 + 0.75 * S.lamp;
        b.sprite.material.opacity = b.base * lit * flick;
        if (b.mat && b.col) b.mat.color.copy(b.col).multiplyScalar(0.30 + 0.70 * lit);
      }
    }
    if (a.navPort) { a.navPort.sprite.material.opacity = 0.18 + 0.62 * S.lamp; }
    if (a.navStbd) { a.navStbd.sprite.material.opacity = 0.18 + 0.62 * S.lamp; }
    if (a.lampSpot) {
      a.lampSpot.intensity = S.lamp * 46 * flick;
      a.lampSpot.visible = S.lamp > 0.02;
      const coneOp = S.lamp * 0.075;
      for (let i = 0; i < a.lampCones.length; i++) {
        a.lampCones[i].visible = S.lamp > 0.03;
        a.lampCones[i].material.opacity = coneOp;
      }
      for (let i = 0; i < a.lampLens.length; i++) {
        a.lampLens[i].material.color.setRGB(0.18 + 0.82 * S.lamp, 0.55 + 0.45 * S.lamp, 0.65 + 0.35 * S.lamp);
      }
    }
    // cabin glass warms up at night
    if (build.mats && build.mats.glass) {
      build.mats.glass.emissiveIntensity = 0.35 + S.lamp * 1.1;
    }
  }

  /* ---------------- wake + foam ---------------- */
  function emitWake(dt, t) {
    if (S.speed < 0.6) return;
    const frac = clamp(S.speed / spec.maxSpeed, 0, 1);
    spawnAcc += dt * (7 + 48 * frac);
    if (spawnAcc > 6) spawnAcc = 6;
    const cy = Math.cos(S.yaw), sy = Math.sin(S.yaw);
    while (spawnAcc >= 1) {
      spawnAcc -= 1;
      const side = Math.random() < 0.5 ? 1 : -1;
      const r = Math.random();
      let lx, lz, up;
      if (r < 0.55) {
        lx = side * spec.wid * (0.08 + Math.random() * 0.30);
        lz = -spec.len * (0.44 + Math.random() * 0.10);
        up = 0.4 + Math.random() * 1.1 * frac;
      } else if (r < 0.85) {
        lx = side * spec.wid * (0.38 + Math.random() * 0.18);
        lz = spec.len * (0.08 + Math.random() * 0.26);
        up = 0.3 + Math.random() * 1.4 * frac;
      } else {
        lx = side * spec.wid * (0.10 + Math.random() * 0.24);
        lz = spec.len * (0.40 + Math.random() * 0.10);
        up = 0.7 + Math.random() * 2.0 * frac;
      }
      const wx = S.pos.x + lx * cy + lz * sy;
      const wz = S.pos.z - lx * sy + lz * cy;
      const i = foam.cursor;
      foam.cursor = (foam.cursor + 1) % FOAM_COUNT;
      const p = foam.parts[i];
      p.max = 0.75 + Math.random() * 0.75;
      p.life = p.max;
      p.vx = (Math.random() - 0.5) * 1.1 + side * 0.7 * frac + S.vel.x * 0.10;
      p.vy = up;
      p.vz = (Math.random() - 0.5) * 1.1 + S.vel.z * 0.10;
      p.size = 0.30 + Math.random() * 0.45 + frac * 0.55;
      foam.pos[i * 3] = wx;
      foam.pos[i * 3 + 1] = waterAt(wx, wz, t) + 0.07;
      foam.pos[i * 3 + 2] = wz;
      foam.size[i] = p.size * 3.0;
      foam.alpha[i] = 0.85;
      foam.live = 1;
    }
  }

  function updateFoam(dt) {
    if (!foam.live) return;
    let live = 0;
    const P = foam.pos;
    for (let i = 0; i < FOAM_COUNT; i++) {
      const p = foam.parts[i];
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) { foam.alpha[i] = 0; P[i * 3 + 1] = -9999; continue; }
      live++;
      const k = p.life / p.max;
      const d = Math.exp(-2.4 * dt);
      p.vx *= d; p.vz *= d;
      p.vy = p.vy * Math.exp(-3.0 * dt) - 0.55 * dt;
      P[i * 3] += p.vx * dt;
      P[i * 3 + 1] += p.vy * dt;
      P[i * 3 + 2] += p.vz * dt;
      foam.size[i] = p.size * (1.5 - 0.6 * k) * 3.0;
      foam.alpha[i] = Math.pow(k, 0.6) * 0.8;
    }
    foam.live = live;
    foam.geo.attributes.position.needsUpdate = true;
    foam.geo.attributes.aSize.needsUpdate = true;
    foam.geo.attributes.aAlpha.needsUpdate = true;
  }

  function updateWake(dt, t) {
    const frac = clamp(S.speed / spec.maxSpeed, 0, 1);
    const target = S.speed > 0.7 ? Math.min(0.9, 0.16 + frac * 0.85) : 0;
    const u = wake.mat.uniforms.uOpacity;
    u.value += (target - u.value) * damp(4, dt);
    wake.mesh.visible = u.value > 0.006;
    if (!wake.mesh.visible) return;
    const cy = Math.cos(S.yaw), sy = Math.sin(S.yaw);
    const bowZ = spec.len * 0.34;
    const lenW = spec.len * (1.0 + 2.9 * frac);
    const spread = lenW * 0.30;
    const hullHalf = spec.wid * 0.40;
    const P = wake.pos;
    for (let arm = 0; arm < 2; arm++) {
      const s = arm === 0 ? 1 : -1;
      const base = arm * WAKE_ALONG * WAKE_ACROSS;
      for (let i = 0; i < WAKE_ALONG; i++) {
        const al = i / (WAKE_ALONG - 1);
        const lz = bowZ - al * lenW;
        const centre = s * (hullHalf + al * spread);
        const armW = 0.35 + al * (1.0 + spec.wid * 0.4);
        for (let j = 0; j < WAKE_ACROSS; j++) {
          const c = j / (WAKE_ACROSS - 1);
          const lx = centre + s * (c - 0.5) * armW;
          const wx = S.pos.x + lx * cy + lz * sy;
          const wz = S.pos.z - lx * sy + lz * cy;
          const v = (base + i * WAKE_ACROSS + j) * 3;
          P[v] = wx;
          P[v + 1] = waterAt(wx, wz, t) + 0.10;
          P[v + 2] = wz;
        }
      }
    }
    wake.geo.attributes.position.needsUpdate = true;
  }

  /* ---------------- boarding affordance ---------------- */
  function anyPlayerNear() {
    const lp = localPlayerPos();
    if (lp && nearBoat(lp)) return true;
    const pm = ctx.playerMod;
    const rem = pm && pm.remotes;
    if (!rem) return false;
    let found = false;
    try {
      if (typeof rem.forEach === 'function') {
        rem.forEach(function (r) { if (!found) { const v = vecOf(r); if (v && nearBoat(v)) found = true; } });
      } else {
        for (const key in rem) {
          const v = vecOf(rem[key]);
          if (v && nearBoat(v)) { found = true; break; }
        }
      }
    } catch (e) { /* remotes shape is not contractual */ }
    return found;
  }

  function updateAffordance(dt, t) {
    nearTimer -= dt;
    if (nearTimer <= 0) {
      nearTimer = 0.2;
      const st = ctx.state;
      const aboard = !!(st && st.onBoat);
      nearCache = !aboard && (!st || st.phase === 'playing') && anyPlayerNear();
    }
    S.glow += ((nearCache ? 1 : 0) - S.glow) * damp(5, dt);
    const pulse = 0.5 + 0.5 * Math.sin(t * 3.1);
    const gm = build.glowMats;
    const e = S.glow * (0.10 + 0.22 * pulse);
    for (let i = 0; i < gm.length; i++) {
      if (level === 4 && gm[i] === build.mats.stripe) gm[i].emissiveIntensity = 0.55 + e;
      else gm[i].emissiveIntensity = e;
    }
    ring.visible = S.glow > 0.02;
    if (ring.visible) {
      ring.position.set(S.pos.x, waterAt(S.pos.x, S.pos.z, t) + 0.14, S.pos.z);
      const sc = Math.max(spec.len, spec.wid) * 0.62 * (1 + 0.05 * pulse);
      ring.scale.set(sc, sc, 1);
      ringMat.opacity = S.glow * (0.14 + 0.20 * pulse);
    }
  }

  /* ---------------- audio ---------------- */
  function updateAudio(dt) {
    sfxTimer -= dt;
    const st = ctx.state;
    const aboard = !!(st && st.onBoat);
    let dist = 999;
    const lp = localPlayerPos();
    if (lp) dist = Math.hypot(lp.x - S.pos.x, lp.z - S.pos.z);
    const audible = aboard || dist < 65;
    const thr = clamp(Math.max(Math.abs(S.throttleVis), S.speed / spec.maxSpeed), 0, 1);
    const on = audible && (Math.abs(S.throttleVis) > 0.03 || S.speed > 1.0);
    if (on !== sfxOn || Math.abs(thr - sfxThr) > 0.08 || sfxTimer <= 0) {
      sfxOn = on;
      sfxThr = thr;
      sfxTimer = 0.25;
      safeSfx('motorLoop', { on: on, throttle: on ? thr : 0, level: level, speed: S.speed, dist: dist });
    }
  }

  /* ---------------- networking ---------------- */
  function onBoatState(d) {
    if (!d) return;
    if (Array.isArray(d.p) && d.p.length >= 3) net.p.set(d.p[0], d.p[1], d.p[2]);
    if (typeof d.r === 'number') net.r = d.r;
    if (Array.isArray(d.vel) && d.vel.length >= 3) net.v.set(d.vel[0], d.vel[1], d.vel[2]);
    net.driverId = d.driverId || null;
    if (Array.isArray(d.seats)) {
      net.seats.length = 0;
      for (let i = 0; i < d.seats.length; i++) net.seats.push(d.seats[i] || null);
    }
    net.age = 0;
    net.has = true;
    moored = true;
  }

  function netSend(dt, drv) {
    if (!drv) { netAcc = 0; return; }
    netAcc += dt;
    if (netAcc < NET_INTERVAL) return;
    netAcc = 0;
    const st = ctx.state;
    if (!st || st.phase !== 'playing') return;
    const n = ctx.net;
    if (!n || typeof n.send !== 'function') return;
    n.send(MSG.DRIVE_BOAT, {
      p: [Math.round(S.pos.x * 100) / 100, Math.round(S.pos.y * 100) / 100, Math.round(S.pos.z * 100) / 100],
      r: Math.round(S.yaw * 1000) / 1000,
      vel: [Math.round(S.vel.x * 100) / 100, Math.round(S.vy * 100) / 100, Math.round(S.vel.z * 100) / 100],
    });
  }

  /* ---------------- wiring ---------------- */
  const bus = ctx.bus;
  if (bus && typeof bus.on === 'function') {
    bus.on('boatState', onBoatState);
    bus.on('boardBoat', function (d) {
      const id = myId();
      const seat = d && typeof d.seat === 'number' ? d.seat : -1;
      if (id && seat >= 0) {
        while (net.seats.length <= seat) net.seats.push(null);
        if (!net.seats[seat]) net.seats[seat] = id;
      }
      S.glow = 0;
      nearCache = false;
      safeSfx('board', { seat: seat });
    });
    bus.on('leaveBoat', function () {
      const id = myId();
      for (let i = 0; i < net.seats.length; i++) if (net.seats[i] === id) net.seats[i] = null;
      if (net.driverId === id) net.driverId = null;
      S.throttle = 0;
      S.steer = 0;
    });
    bus.on('phase', function (p) {
      if (p === 'playing') {
        moored = false;
        moorTimer = 0;
        net.has = false;
        net.driverId = null;
        net.seats.length = 0;
      }
    });
  }
  if (ctx.net && typeof ctx.net.on === 'function') {
    try { ctx.net.on(MSG.BOAT_STATE, onBoatState); } catch (e) { /* net wiring is optional here */ }
  }

  /* ---------------- frame ---------------- */
  function update(dt, t) {
    if (!(dt > 0)) dt = 0.016;
    if (dt > 0.05) dt = 0.05;
    const time = typeof t === 'number' ? t : 0;
    if (S.bump > 0) S.bump -= dt;
    maybeRebuild(dt);
    ensureMoored(dt);
    const drv = isDriver();
    if (drv !== wasDriver) {
      wasDriver = drv;
      if (drv) { net.has = false; S.throttle = 0; S.steer = 0; }
    }
    if (drv) simulateDriver(dt); else simulateRemote(dt);
    applyBuoyancy(dt, time);
    group.position.copy(S.pos);
    group.rotation.set(S.pitch, S.yaw, S.roll, 'YXZ');
    updateVisuals(dt, time);
    emitWake(dt, time);
    updateWake(dt, time);
    updateFoam(dt);
    updateAffordance(dt, time);
    updateAudio(dt);
    netSend(dt, drv);
  }

  return {
    update: update,
    group: group,
    isDriver: isDriver,
    nearBoat: nearBoat,
    velocity: S.vel,
    seatWorld: seatWorld,
    seatCount: seatCount,
    // extras (safe additions, nothing in the contract depends on them)
    boatLevel: function () { return level; },
    boatName: function () { return spec.name; },
    maxSpeed: function () { return spec.maxSpeed; },
    speed: function () { return S.speed; },
    driverId: function () { return net.driverId; },
    seatOccupant: function (i) { return net.seats[i] || null; },
    moor: moorAtDock,
  };
}

