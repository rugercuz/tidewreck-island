// =============================================================
// TIDEWRECK ISLAND - world.js
// Island terrain, sky & day/night cycle, god rays, landmarks,
// area buoys, campfire, stone ring / portal.
// Owner module: exports initWorld(ctx).
// =============================================================
import * as THREE from 'three';
import { AREAS, ECON, MSG, WEATHER } from '/shared/constants.js';

// ------------------------------------------------------------
// tiny math helpers
// ------------------------------------------------------------
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function lerp(a, b, t) { return a + (b - a) * t; }
function smoothstep(e0, e1, x) {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  return t * t * (3 - 2 * t);
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// scratch objects (module scope, reused - zero per-frame allocation)
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3(1, 1, 1);
const _m4 = new THREE.Matrix4();
const _m3 = new THREE.Matrix3();
const _col = new THREE.Color();
const _colB = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);
const _white = new THREE.Color(1, 1, 1);

// =============================================================
// TERRAIN - analytic height field.
// getTerrainHeight() and the rendered mesh both use terrainHeight().
// No randomness anywhere in here: mesh and function always agree.
// =============================================================
const ISLAND_R = 120;

// three fixed hills (the north-west one carries the stone ring)
const HILLS = [
  { x: -52, z: 30, r: 48, h: 8.4 },
  { x: 46, z: 44, r: 42, h: 6.6 },
  { x: 30, z: -36, r: 34, h: 3.6 },
];

// seabed wells, one per fishing area (center reaches -depth)
const WELLS = AREAS.map(a => ({
  x: a.center[0], z: a.center[1], r: a.radius, d: a.depth,
}));

function shoreWobble(x, z) {
  const ang = Math.atan2(z, x);
  return 6.5 * Math.sin(ang * 3 + 0.6) + 4.0 * Math.sin(ang * 5 - 1.3) + 2.5 * Math.cos(ang * 7 + 2.2);
}

// island + shelf, before local flattening and area wells
function baseHeight(x, z) {
  const r = Math.sqrt(x * x + z * z);
  const rr = r - shoreWobble(x, z);
  const dome = smoothstep(126, 24, rr);
  let h = dome * 12.2;
  for (let i = 0; i < HILLS.length; i++) {
    const hl = HILLS[i];
    const dx = x - hl.x, dz = z - hl.z;
    h += hl.h * smoothstep(hl.r, hl.r * 0.14, Math.sqrt(dx * dx + dz * dz));
  }
  h += dome * (1.15 * Math.sin(x * 0.055 + 0.7) * Math.cos(z * 0.048 - 0.3)
    + 0.62 * Math.sin(x * 0.113 - 1.2) * Math.sin(z * 0.101 + 2.1));
  h -= 7.6 * smoothstep(112, 196, rr);   // beach shelf
  h -= 23.0 * smoothstep(196, 640, r);   // open-water slope to ~-30
  return h;
}

// flattened build sites (constants derived once from baseHeight)
const VILLAGE = { x: 2, z: -92, r: 34, s: 0.65, y: 0 };
const RINGSITE = { x: -52, z: 30, r: 26, s: 0.86, y: 0 };
VILLAGE.y = baseHeight(VILLAGE.x, VILLAGE.z);
RINGSITE.y = baseHeight(RINGSITE.x, RINGSITE.z);

function flattenSite(h, x, z, site) {
  const dx = x - site.x, dz = z - site.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d >= site.r) return h;
  const k = smoothstep(site.r, site.r * 0.35, d) * site.s;
  return h + (site.y - h) * k;
}

function terrainHeight(x, z) {
  let h = baseHeight(x, z);
  h = flattenSite(h, x, z, VILLAGE);
  h = flattenSite(h, x, z, RINGSITE);
  // area wells: blend the seabed toward -depth, never touching the island
  const r = Math.sqrt(x * x + z * z);
  const gate = smoothstep(104, 150, r);
  if (gate > 0) {
    for (let i = 0; i < WELLS.length; i++) {
      const w = WELLS[i];
      const dx = x - w.x, dz = z - w.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > w.r * 1.15) continue;
      const k = smoothstep(w.r * 1.15, w.r * 0.16, d) * gate;
      if (k > 0) h += (-w.d - h) * k;
    }
  }
  return h;
}

// =============================================================
// geometry merge helpers (no three/addons allowed)
// parts: { geo, color, m (Matrix4), sway?: [y0, y1, amount, phase] }
// =============================================================
const _idm = new THREE.Matrix4();

function push(list, geo, color, x, y, z, rx, ry, rz, sx, sy, sz, sway) {
  _e.set(rx || 0, ry || 0, rz || 0);
  _q.setFromEuler(_e);
  _v.set(x || 0, y || 0, z || 0);
  _s.set(sx === undefined ? 1 : sx, sy === undefined ? 1 : sy, sz === undefined ? 1 : sz);
  list.push({ geo, color, m: new THREE.Matrix4().compose(_v, _q, _s), sway });
  return list;
}

function mergeParts(parts) {
  let vc = 0, ic = 0, hasSway = false;
  for (let i = 0; i < parts.length; i++) {
    const g = parts[i].geo;
    vc += g.attributes.position.count;
    ic += g.index ? g.index.count : g.attributes.position.count;
    if (parts[i].sway) hasSway = true;
  }
  const pos = new Float32Array(vc * 3);
  const nor = new Float32Array(vc * 3);
  const col = new Float32Array(vc * 3);
  const swayA = hasSway ? new Float32Array(vc) : null;
  const phaseA = hasSway ? new Float32Array(vc) : null;
  const idx = new Uint32Array(ic);
  let vo = 0, io = 0;
  for (let p = 0; p < parts.length; p++) {
    const part = parts[p];
    const g = part.geo;
    const gp = g.attributes.position;
    const gn = g.attributes.normal;
    const m = part.m || _idm;
    _m3.getNormalMatrix(m);
    _col.set(part.color === undefined ? 0xffffff : part.color);
    const n = gp.count;
    for (let i = 0; i < n; i++) {
      const o = (vo + i) * 3;
      _v.fromBufferAttribute(gp, i).applyMatrix4(m);
      pos[o] = _v.x; pos[o + 1] = _v.y; pos[o + 2] = _v.z;
      if (gn) {
        _v2.fromBufferAttribute(gn, i).applyMatrix3(_m3).normalize();
        nor[o] = _v2.x; nor[o + 1] = _v2.y; nor[o + 2] = _v2.z;
      } else { nor[o] = 0; nor[o + 1] = 1; nor[o + 2] = 0; }
      col[o] = _col.r; col[o + 1] = _col.g; col[o + 2] = _col.b;
      if (hasSway) {
        const sw = part.sway;
        swayA[vo + i] = sw ? smoothstep(sw[0], sw[1], _v.y) * sw[2] : 0;
        phaseA[vo + i] = sw ? sw[3] : 0;
      }
    }
    if (g.index) {
      const ia = g.index.array;
      for (let i = 0; i < ia.length; i++) idx[io + i] = ia[i] + vo;
      io += ia.length;
    } else {
      for (let i = 0; i < n; i++) idx[io + i] = vo + i;
      io += n;
    }
    vo += n;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (hasSway) {
    out.setAttribute('aSway', new THREE.BufferAttribute(swayA, 1));
    out.setAttribute('aPhase', new THREE.BufferAttribute(phaseA, 1));
  }
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

// =============================================================
// canvas textures (everything procedural)
// =============================================================
function canvas2d(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return { c, x: c.getContext('2d') };
}
function finishTex(c, opts) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (opts && opts.repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(opts.repeat, opts.repeat);
  }
  t.needsUpdate = true;
  return t;
}

function makeGlowTexture(size, coreStop, tint) {
  const { c, x } = canvas2d(size, size);
  const g = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(coreStop, tint || 'rgba(255,240,200,0.55)');
  g.addColorStop(0.62, 'rgba(255,220,170,0.14)');
  g.addColorStop(1, 'rgba(255,200,140,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, size, size);
  return finishTex(c);
}

function makeDiscTexture(size) {
  const { c, x } = canvas2d(size, size);
  const g = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.72, 'rgba(255,252,240,1)');
  g.addColorStop(0.9, 'rgba(255,240,205,0.6)');
  g.addColorStop(1, 'rgba(255,225,170,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, size, size);
  return finishTex(c);
}

function makeMoonTexture(size) {
  const { c, x } = canvas2d(size, size);
  x.clearRect(0, 0, size, size);
  const r = size * 0.46;
  const g = x.createRadialGradient(size * 0.42, size * 0.4, r * 0.15, size / 2, size / 2, r);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.75, '#e6ecf5');
  g.addColorStop(1, '#b9c6d8');
  x.beginPath();
  x.arc(size / 2, size / 2, r, 0, Math.PI * 2);
  x.fillStyle = g; x.fill();
  const rnd = mulberry32(9182);
  x.globalCompositeOperation = 'source-atop';
  for (let i = 0; i < 16; i++) {
    const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * r * 0.86;
    const cr = size * (0.02 + rnd() * 0.055);
    x.beginPath();
    x.arc(size / 2 + Math.cos(a) * d, size / 2 + Math.sin(a) * d, cr, 0, Math.PI * 2);
    x.fillStyle = 'rgba(150,165,185,' + (0.18 + rnd() * 0.22) + ')';
    x.fill();
  }
  // soft edge fade so the disc never shows a hard aliased rim
  x.globalCompositeOperation = 'destination-in';
  const fg = x.createRadialGradient(size / 2, size / 2, r * 0.86, size / 2, size / 2, r);
  fg.addColorStop(0, 'rgba(0,0,0,1)');
  fg.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = fg;
  x.fillRect(0, 0, size, size);
  return finishTex(c);
}

function makeGroundNoiseTexture() {
  const size = 256;
  const { c, x } = canvas2d(size, size);
  x.fillStyle = '#ffffff';
  x.fillRect(0, 0, size, size);
  const rnd = mulberry32(4477);
  for (let i = 0; i < 190; i++) {
    const px = rnd() * size, py = rnd() * size, rr = 6 + rnd() * 34;
    const dark = rnd() < 0.55;
    const g = x.createRadialGradient(px, py, 0, px, py, rr);
    const a = 0.05 + rnd() * 0.07;
    g.addColorStop(0, dark ? 'rgba(120,110,95,' + a + ')' : 'rgba(255,255,250,' + a + ')');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g;
    x.fillRect(px - rr, py - rr, rr * 2, rr * 2);
  }
  // faint speckle
  const img = x.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * 14;
    d[i] = clamp(d[i] + n, 0, 255);
    d[i + 1] = clamp(d[i + 1] + n, 0, 255);
    d[i + 2] = clamp(d[i + 2] + n, 0, 255);
  }
  x.putImageData(img, 0, 0);
  return finishTex(c, { repeat: 1 });
}

// Tileable mottled alpha sheet used for the overcast / rain / storm deck.
// Blobs are stamped nine times (3x3 wrap) so the texture repeats seamlessly.
function makeCloudDeckTexture() {
  const size = 512;
  const { c, x } = canvas2d(size, size);
  x.clearRect(0, 0, size, size);
  const rnd = mulberry32(70707);
  x.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 140; i++) {
    const bx = rnd() * size, by = rnd() * size;
    const rr = size * (0.06 + rnd() * 0.15);
    const a = 0.10 + rnd() * 0.20;
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const gx = bx + ox * size, gy = by + oy * size;
        if (gx < -rr || gx > size + rr || gy < -rr || gy > size + rr) continue;
        const g = x.createRadialGradient(gx, gy, 0, gx, gy, rr);
        g.addColorStop(0, 'rgba(255,255,255,' + a.toFixed(3) + ')');
        g.addColorStop(0.5, 'rgba(255,255,255,' + (a * 0.5).toFixed(3) + ')');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        x.fillStyle = g;
        x.fillRect(gx - rr, gy - rr, rr * 2, rr * 2);
      }
    }
  }
  x.globalCompositeOperation = 'source-over';
  return finishTex(c, { repeat: 2 });
}

// neutral soft blob - rain splash flecks
function makeSoftTexture(size) {
  const { c, x } = canvas2d(size, size);
  x.clearRect(0, 0, size, size);
  const g = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.00, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.34, 'rgba(232,246,255,0.48)');
  g.addColorStop(0.70, 'rgba(210,236,255,0.13)');
  g.addColorStop(1.00, 'rgba(200,230,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, size, size);
  return finishTex(c);
}

function makeLabelTexture(name, sub, hexColor) {
  const { c, x } = canvas2d(512, 160);
  x.clearRect(0, 0, 512, 160);
  const col = '#' + hexColor.toString(16).padStart(6, '0');
  // pill
  x.fillStyle = 'rgba(6,10,18,0.55)';
  const r = 26;
  x.beginPath();
  x.moveTo(16 + r, 18);
  x.arcTo(496, 18, 496, 142, r);
  x.arcTo(496, 142, 16, 142, r);
  x.arcTo(16, 142, 16, 18, r);
  x.arcTo(16, 18, 496, 18, r);
  x.closePath();
  x.fill();
  x.strokeStyle = col;
  x.lineWidth = 3;
  x.globalAlpha = 0.75;
  x.stroke();
  x.globalAlpha = 1;
  x.textAlign = 'center';
  x.font = 'bold 54px Georgia, "Times New Roman", serif';
  x.shadowColor = col;
  x.shadowBlur = 18;
  x.fillStyle = '#ffffff';
  x.fillText(name, 256, 82);
  x.shadowBlur = 0;
  x.font = '600 26px Georgia, "Times New Roman", serif';
  x.fillStyle = col;
  x.fillText(sub, 256, 122);
  return finishTex(c);
}

// =============================================================
// TERRAIN MESH - 257x257 grid over 2000x2000, sampled from
// terrainHeight(). The grid is radially warped per axis so the
// island gets ~2.4 m triangles while open water gets ~15 m -
// still one continuous mesh, so there are no seams anywhere.
// =============================================================
const GRID_SEG = 256;
const GRID_HALF = 1000;
const WARP_LUT_N = 1024;
const WARP_LUT = new Float32Array(WARP_LUT_N + 1);
(function buildWarpLUT() {
  let acc = 0;
  let prev = 1;
  WARP_LUT[0] = 0;
  for (let i = 1; i <= WARP_LUT_N; i++) {
    const t = i / WARP_LUT_N;
    const s = 1 + 5.0 * smoothstep(0.42, 0.70, t);
    acc += (s + prev) * 0.5 / WARP_LUT_N;
    prev = s;
    WARP_LUT[i] = acc;
  }
  const scale = GRID_HALF / WARP_LUT[WARP_LUT_N];
  for (let i = 0; i <= WARP_LUT_N; i++) WARP_LUT[i] *= scale;
})();
function warpAxis(u) { // u in [-1,1] -> world coordinate
  const sgn = u < 0 ? -1 : 1;
  const t = Math.min(1, Math.abs(u));
  const f = t * WARP_LUT_N;
  const i = Math.min(WARP_LUT_N - 1, Math.floor(f));
  return sgn * (WARP_LUT[i] + (WARP_LUT[i + 1] - WARP_LUT[i]) * (f - i));
}

// terrain palette (created once)
const P_DEEP = new THREE.Color(0x12212e);
const P_SILT = new THREE.Color(0x2f5d57);
const P_WETSAND = new THREE.Color(0xc9a978);
const P_SAND = new THREE.Color(0xf0dda6);
const P_GRASS = new THREE.Color(0x69ad42);
const P_GRASSDK = new THREE.Color(0x3f7c34);
const P_DRY = new THREE.Color(0xb2b95c);
const P_ROCK = new THREE.Color(0x92887a);

function terrainColorAt(h, slope, x, z, out) {
  out.copy(P_SAND);
  out.lerp(P_GRASS, smoothstep(1.5, 3.8, h));
  out.lerp(P_GRASSDK, smoothstep(0.2, 0.75, slope) * smoothstep(1.4, 3.0, h));
  out.lerp(P_DRY, smoothstep(11.5, 17.5, h));
  out.lerp(P_WETSAND, smoothstep(0.55, -0.9, h));
  out.lerp(P_SILT, smoothstep(-1.6, -9.5, h));
  out.lerp(P_DEEP, smoothstep(-13, -42, h));
  out.lerp(P_ROCK, smoothstep(0.62, 1.25, slope) * (h > -1.5 ? 1 : 0.35));
  const n = 0.5 * Math.sin(x * 0.21 + z * 0.13) + 0.5 * Math.sin(x * 0.071 - z * 0.187 + 2.1);
  const m = 1 + n * 0.075;
  out.r = clamp(out.r * m, 0, 1);
  out.g = clamp(out.g * (m + n * 0.012), 0, 1);
  out.b = clamp(out.b * m, 0, 1);
  return out;
}

function buildTerrain(ctx) {
  const N = GRID_SEG + 1;
  const gx = new Float32Array(N);
  for (let i = 0; i < N; i++) gx[i] = warpAxis((i / GRID_SEG) * 2 - 1);
  const heights = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    const z = gx[j];
    for (let i = 0; i < N; i++) heights[j * N + i] = terrainHeight(gx[i], z);
  }
  const vc = N * N;
  const pos = new Float32Array(vc * 3);
  const nor = new Float32Array(vc * 3);
  const col = new Float32Array(vc * 3);
  const uv = new Float32Array(vc * 2);
  const idx = new Uint32Array(GRID_SEG * GRID_SEG * 6);
  const c = _col;
  for (let j = 0; j < N; j++) {
    const z = gx[j];
    const jm = j > 0 ? j - 1 : 0, jp = j < N - 1 ? j + 1 : N - 1;
    const dz = gx[jp] - gx[jm];
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      const x = gx[i];
      const h = heights[k];
      const im = i > 0 ? i - 1 : 0, ip = i < N - 1 ? i + 1 : N - 1;
      const dx = gx[ip] - gx[im];
      const ghx = (heights[j * N + ip] - heights[j * N + im]) / (dx || 1);
      const ghz = (heights[jp * N + i] - heights[jm * N + i]) / (dz || 1);
      const o = k * 3;
      pos[o] = x; pos[o + 1] = h; pos[o + 2] = z;
      const inv = 1 / Math.sqrt(ghx * ghx + 1 + ghz * ghz);
      nor[o] = -ghx * inv; nor[o + 1] = inv; nor[o + 2] = -ghz * inv;
      terrainColorAt(h, Math.sqrt(ghx * ghx + ghz * ghz), x, z, c);
      col[o] = c.r; col[o + 1] = c.g; col[o + 2] = c.b;
      uv[k * 2] = x / 42; uv[k * 2 + 1] = z / 42;
    }
  }
  let t = 0;
  for (let j = 0; j < GRID_SEG; j++) {
    for (let i = 0; i < GRID_SEG; i++) {
      const a = j * N + i, b = a + 1, cc = a + N, d = cc + 1;
      idx[t++] = a; idx[t++] = cc; idx[t++] = b;
      idx[t++] = b; idx[t++] = cc; idx[t++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();

  const tex = makeGroundNoiseTexture();
  try {
    if (ctx.renderer && ctx.renderer.capabilities) tex.anisotropy = ctx.renderer.capabilities.getMaxAnisotropy();
  } catch (e) { /* keep default anisotropy */ }
  const mat = new THREE.MeshLambertMaterial({
    vertexColors: true, flatShading: true, map: tex, fog: true,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'terrain';
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}

// =============================================================
// SKY - camera-locked dome with a gradient shader, sun, moon,
// stars and drifting low-poly clouds.
// =============================================================
const SKY_VERT = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SKY_FRAG = `
uniform vec3 uTop;
uniform vec3 uMid;
uniform vec3 uBot;
uniform vec3 uSunDir;
uniform vec3 uSunTint;
uniform float uGlow;
uniform float uBand;
varying vec3 vDir;
float hash12(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(uMid, uTop, smoothstep(0.015, 0.62, h));
  col = mix(uBot, col, smoothstep(-0.34, 0.02, h));
  float sd = max(dot(d, uSunDir), 0.0);
  col += uSunTint * uGlow * (pow(sd, 5.0) * 0.30 + pow(sd, 48.0) * 0.55 + pow(sd, 400.0) * 1.1);
  float band = pow(max(0.0, 1.0 - abs(h) * 2.6), 3.0) * pow(sd, 1.6);
  col += uSunTint * band * uBand;
  col += (hash12(gl_FragCoord.xy) - 0.5) * 0.014;
  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const STAR_VERT = `
attribute float aSize;
attribute float aPhase;
uniform float uTime;
uniform float uScale;
varying float vTw;
void main() {
  vTw = 0.65 + 0.35 * sin(uTime * 1.7 + aPhase * 6.283);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uScale * vTw;
  gl_Position = projectionMatrix * mv;
}`;

const STAR_FRAG = `
uniform float uOpacity;
uniform vec3 uTint;
varying float vTw;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float d = dot(p, p);
  if (d > 0.25) discard;
  float a = smoothstep(0.25, 0.0, d);
  gl_FragColor = vec4(uTint * (0.6 + vTw * 0.6), a * a * uOpacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function buildStars() {
  const n = 800;
  const pos = new Float32Array(n * 3);
  const size = new Float32Array(n);
  const phase = new Float32Array(n);
  const rnd = mulberry32(20260822);
  for (let i = 0; i < n; i++) {
    let y, x, z;
    do {
      x = rnd() * 2 - 1; y = rnd() * 2 - 1; z = rnd() * 2 - 1;
    } while (x * x + y * y + z * z > 1 || y < -0.06);
    const l = Math.sqrt(x * x + y * y + z * z) || 1;
    const R = 455;
    pos[i * 3] = x / l * R; pos[i * 3 + 1] = y / l * R; pos[i * 3 + 2] = z / l * R;
    const b = rnd();
    size[i] = 1.1 + b * b * 3.4;
    phase[i] = rnd();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 460);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uOpacity: { value: 0 },
      uScale: { value: 1 }, uTint: { value: new THREE.Color(0xdfe8ff) },
    },
    vertexShader: STAR_VERT, fragmentShader: STAR_FRAG,
    transparent: false, blending: THREE.AdditiveBlending,
    depthTest: false, depthWrite: false, fog: false,
  });
  const pts = new THREE.Points(geo, mat);
  pts.renderOrder = -995;
  pts.frustumCulled = false;
  return pts;
}

function buildClouds() {
  const group = new THREE.Group();
  const rnd = mulberry32(3141);
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.92,
    depthWrite: false, fog: true, color: 0xffffff,
  });
  const blob = new THREE.IcosahedronGeometry(1, 1);
  const clouds = [];
  for (let ci = 0; ci < 8; ci++) {
    const parts = [];
    const puffs = 5 + Math.floor(rnd() * 4);
    for (let p = 0; p < puffs; p++) {
      const px = (p - puffs * 0.5) * (10 + rnd() * 6);
      const py = (rnd() - 0.4) * 6;
      const pz = (rnd() - 0.5) * 14;
      const s = 12 + rnd() * 11 - Math.abs(p - puffs * 0.5) * 1.4;
      push(parts, blob, 0xffffff, px, py, pz, rnd() * 3, rnd() * 3, rnd() * 3,
        s, s * (0.55 + rnd() * 0.2), s * 0.85);
    }
    const geo = mergeParts(parts);
    // bake a vertical gradient: bright tops, shadowed undersides
    const cAttr = geo.attributes.color, pAttr = geo.attributes.position;
    let miny = Infinity, maxy = -Infinity;
    for (let i = 0; i < pAttr.count; i++) {
      const y = pAttr.getY(i);
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
    }
    for (let i = 0; i < cAttr.count; i++) {
      const k = smoothstep(miny, maxy, pAttr.getY(i));
      const v = 0.42 + k * 0.58;
      cAttr.setXYZ(i, v, v * 0.99 + 0.01, v * 0.97 + 0.03);
    }
    cAttr.needsUpdate = true;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set((rnd() - 0.5) * 1500, 150 + rnd() * 110, (rnd() - 0.5) * 1500);
    mesh.rotation.y = rnd() * Math.PI * 2;
    const sc = 0.75 + rnd() * 0.9;
    mesh.scale.setScalar(sc);
    mesh.renderOrder = -100;
    mesh.userData.speed = 1.6 + rnd() * 2.4;
    mesh.userData.baseScale = sc;
    mesh.userData.baseY = mesh.position.y;
    group.add(mesh);
    clouds.push(mesh);
  }
  return { group, mat, clouds };
}

// =============================================================
// PROP GEOMETRY BUILDERS
// =============================================================
function makeTrunkGeo(h, r0, r1, bendX, bendZ, segs) {
  const radial = 6;
  const rows = segs + 1;
  const vc = rows * radial + 1;
  const pos = new Float32Array(vc * 3);
  const idx = [];
  for (let i = 0; i < rows; i++) {
    const t = i / segs;
    const y = h * t;
    const r = lerp(r0, r1, Math.pow(t, 0.8));
    const cx = bendX * t * t, cz = bendZ * t * t;
    for (let k = 0; k < radial; k++) {
      const a = (k / radial) * Math.PI * 2 + t * 0.35;
      const o = (i * radial + k) * 3;
      const rr = r * (1 + 0.09 * Math.sin(t * 11 + k * 2.1));
      pos[o] = cx + Math.cos(a) * rr;
      pos[o + 1] = y;
      pos[o + 2] = cz + Math.sin(a) * rr;
    }
  }
  const top = vc - 1;
  pos[top * 3] = bendX; pos[top * 3 + 1] = h + r1 * 0.6; pos[top * 3 + 2] = bendZ;
  for (let i = 0; i < segs; i++) {
    for (let k = 0; k < radial; k++) {
      const k2 = (k + 1) % radial;
      const a = i * radial + k, b = i * radial + k2;
      const c = (i + 1) * radial + k, d = (i + 1) * radial + k2;
      idx.push(a, c, b, b, c, d);
    }
  }
  for (let k = 0; k < radial; k++) {
    const k2 = (k + 1) % radial;
    idx.push(segs * radial + k, top, segs * radial + k2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function makeFrondGeo(len, width, droop) {
  const segs = 6;
  const rows = segs + 1;
  const vc = rows * 3;
  const pos = new Float32Array(vc * 3);
  const idx = [];
  for (let i = 0; i < rows; i++) {
    const t = i / segs;
    const x = len * t;
    const y = -droop * t * t * t - 0.05;
    const w = width * Math.sin(Math.PI * Math.pow(t, 0.55)) * (1 - t * 0.2) + 0.02;
    const o = i * 9;
    pos[o] = x; pos[o + 1] = y - w * 0.28; pos[o + 2] = -w;
    pos[o + 3] = x; pos[o + 4] = y + w * 0.30; pos[o + 5] = 0;
    pos[o + 6] = x; pos[o + 7] = y - w * 0.28; pos[o + 8] = w;
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 3, b = a + 1, c = a + 2;
    const d = a + 3, e = a + 4, f = a + 5;
    idx.push(a, b, d, b, e, d, b, c, e, c, f, e);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const TUFT_BLADE = (function () {
  const pos = new Float32Array([
    -0.09, 0, 0, 0.09, 0, 0, 0.05, 0.55, 0.05, -0.05, 0.55, 0.05,
    0.0, 0.95, 0.16,
  ]);
  const idx = [0, 1, 2, 0, 2, 3, 3, 2, 4];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
})();

// shared primitive geometries (reused by every merged part)
const G_BOX = new THREE.BoxGeometry(1, 1, 1);
const G_CYL6 = new THREE.CylinderGeometry(0.5, 0.5, 1, 6);
const G_CYL8 = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
const G_CYL5 = new THREE.CylinderGeometry(0.42, 0.5, 1, 5);
const G_CYL12 = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
const G_ICO0 = new THREE.IcosahedronGeometry(1, 0);
const G_ICO1 = new THREE.IcosahedronGeometry(1, 1);
const G_CONE = new THREE.ConeGeometry(0.5, 1, 7);

// wood / stone palettes
const WOOD_A = 0x8a6440, WOOD_B = 0x6f4e30, WOOD_C = 0xa07a4e;
const STONE_A = 0x8e8b84, STONE_B = 0x6f6d68, STONE_C = 0xa5a096;

// ---- dock geometry (south shore, reaching toward Home Shallows) ----
const DECK_Y = 1.05;
let DOCK_START_Z = -104;
for (let z = -86; z > -178; z -= 0.5) {
  if (terrainHeight(0, z) < DECK_Y) { DOCK_START_Z = z + 1; break; }
}
const DOCK_END_Z = DOCK_START_Z - 27;
const DOCK_CZ = (DOCK_START_Z + DOCK_END_Z) * 0.5;
const SHOP_X = 19.5, SHOP_Z = -95;
const SHOP_Y = terrainHeight(SHOP_X, SHOP_Z);
const CAMP_X = -17, CAMP_Z = -85;
const CAMP_Y = terrainHeight(CAMP_X, CAMP_Z);
const RING_Y = terrainHeight(RINGSITE.x, RINGSITE.z);
const RING_R = 9.6;

function buildDock(parts) {
  const rnd = mulberry32(777);
  const w = 6.4;
  // planks
  for (let z = DOCK_START_Z; z > DOCK_END_Z; z -= 0.62) {
    const shade = rnd();
    const col = shade < 0.34 ? WOOD_A : (shade < 0.7 ? WOOD_B : WOOD_C);
    push(parts, G_BOX, col, (rnd() - 0.5) * 0.12, DECK_Y, z, 0, (rnd() - 0.5) * 0.02, 0,
      w + (rnd() - 0.5) * 0.2, 0.17, 0.52);
  }
  // stringers under the deck
  for (let sx = -1; sx <= 1; sx += 1) {
    push(parts, G_BOX, WOOD_B, sx * (w * 0.5 - 0.35), DECK_Y - 0.22, DOCK_CZ, 0, 0, 0,
      0.36, 0.3, Math.abs(DOCK_END_Z - DOCK_START_Z) + 0.3);
  }
  // posts
  for (let z = DOCK_START_Z - 0.6; z > DOCK_END_Z; z -= 4.4) {
    for (let s = -1; s <= 1; s += 2) {
      const px = s * (w * 0.5 - 0.5);
      const g = terrainHeight(px, z);
      const bot = Math.min(g - 0.7, DECK_Y - 1.4);
      const hgt = DECK_Y - 0.12 - bot;
      push(parts, G_CYL6, WOOD_B, px, bot + hgt * 0.5, z, 0, rnd() * 1.2, 0, 0.42, hgt, 0.42);
    }
  }
  // mooring posts at the seaward end
  for (let s = -1; s <= 1; s += 2) {
    const px = s * (w * 0.5 - 0.45);
    const g = terrainHeight(px, DOCK_END_Z + 0.4);
    const bot = Math.min(g - 0.7, DECK_Y - 1.4);
    const hgt = DECK_Y + 1.15 - bot;
    push(parts, G_CYL6, WOOD_C, px, bot + hgt * 0.5, DOCK_END_Z + 0.4, 0, 0.4, 0, 0.5, hgt, 0.5);
    push(parts, G_CYL8, 0x51402c, px, bot + hgt - 0.3, DOCK_END_Z + 0.4, 0, 0, 0, 0.66, 0.16, 0.66);
  }
  // a crate and two barrels waiting at the landward end
  push(parts, G_BOX, WOOD_C, -2.1, DECK_Y + 0.5, DOCK_START_Z - 1.6, 0, 0.32, 0, 1.0, 0.9, 1.0);
  push(parts, G_BOX, WOOD_B, -2.1, DECK_Y + 0.98, DOCK_START_Z - 1.6, 0, 0.32, 0, 1.05, 0.08, 1.05);
  for (let i = 0; i < 2; i++) {
    push(parts, G_CYL8, 0x7d5a38, 2.2, DECK_Y + 0.55, DOCK_START_Z - 1.2 - i * 1.25, 0, 0.2 * i, 0, 0.92, 1.1, 0.92);
    push(parts, G_CYL8, 0x4a4038, 2.2, DECK_Y + 0.55, DOCK_START_Z - 1.2 - i * 1.25, 0, 0.2 * i, 0, 0.98, 0.14, 0.98);
  }
}

function buildShopHut(parts) {
  const yaw = -0.55;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const g = SHOP_Y;
  // local -> world helper
  function P(geo, col, lx, ly, lz, rx, ry, rz, sx, syy, sz, sway) {
    push(parts, geo, col,
      SHOP_X + lx * cy + lz * sy, g + ly, SHOP_Z + (-lx * sy + lz * cy),
      rx || 0, (ry || 0) + yaw, rz || 0, sx, syy, sz, sway);
  }
  // stilts + floor
  for (let sx = -1; sx <= 1; sx += 2) {
    for (let sz = -1; sz <= 1; sz += 2) {
      P(G_CYL6, WOOD_B, sx * 3.1, 0.05, sz * 2.6, 0, 0, 0, 0.34, 1.0, 0.34);
    }
  }
  P(G_BOX, WOOD_A, 0, 0.62, 0, 0, 0, 0, 7.2, 0.28, 6.0);
  // deck planks on top of the floor slab
  const rnd = mulberry32(2024);
  for (let i = -5; i <= 5; i++) {
    P(G_BOX, rnd() < 0.5 ? WOOD_C : WOOD_A, 0, 0.79, i * 0.55, 0, 0, 0, 7.0, 0.07, 0.48);
  }
  // corner posts
  for (let sx = -1; sx <= 1; sx += 2) {
    for (let sz = -1; sz <= 1; sz += 2) {
      P(G_BOX, WOOD_B, sx * 3.35, 2.0, sz * 2.75, 0, 0, 0, 0.3, 2.4, 0.3);
    }
  }
  // back + side walls (front stays open, that is the counter)
  P(G_BOX, 0x9c7c52, 0, 1.95, 2.82, 0, 0, 0, 6.9, 2.3, 0.22);
  P(G_BOX, 0x8f7048, -3.32, 1.95, 1.2, 0, 0, 0, 0.2, 2.3, 3.1);
  P(G_BOX, 0x8f7048, 3.32, 1.95, 1.2, 0, 0, 0, 0.2, 2.3, 3.1);
  // shelves + wares on the back wall
  P(G_BOX, WOOD_C, 0, 1.55, 2.6, 0, 0, 0, 6.2, 0.12, 0.5);
  P(G_BOX, WOOD_C, 0, 2.35, 2.6, 0, 0, 0, 6.2, 0.12, 0.5);
  const jarCols = [0x6fc2b0, 0xd9b34a, 0xc06a5a, 0x7a9fd0, 0x9fd06a];
  for (let i = 0; i < 7; i++) {
    P(G_CYL8, jarCols[i % jarCols.length], -2.6 + i * 0.88, 1.85, 2.6, 0, 0, 0, 0.34, 0.44, 0.34);
    if (i % 2 === 0) P(G_BOX, WOOD_B, -2.4 + i * 0.9, 2.6, 2.6, 0, 0, 0, 0.5, 0.38, 0.36);
  }
  // counter
  P(G_BOX, WOOD_C, 0, 1.18, -2.35, 0, 0, 0, 6.6, 0.22, 0.75);
  P(G_BOX, WOOD_B, 0, 0.95, -2.35, 0, 0, 0, 6.2, 0.5, 0.3);
  // scales + a crate of fish on the counter
  P(G_CYL8, 0x8a8f96, -2.2, 1.42, -2.3, 0, 0, 0, 0.5, 0.26, 0.5);
  P(G_BOX, WOOD_A, 2.0, 1.5, -2.3, 0, 0.3, 0, 1.1, 0.42, 0.8);
  P(G_ICO1, 0xb9c6d0, 2.0, 1.78, -2.3, 0, 0.3, 0.4, 0.42, 0.2, 0.16);
  P(G_ICO1, 0xd0b070, 2.25, 1.78, -2.45, 0, 0.9, 0.3, 0.38, 0.18, 0.15);
  // roof: gable of two slabs + ridge beam
  P(G_BOX, 0xa8813c, -1.9, 3.55, 0.05, 0, 0, 0.62, 4.7, 0.24, 7.0);
  P(G_BOX, 0xb98f45, 1.9, 3.55, 0.05, 0, 0, -0.62, 4.7, 0.24, 7.0);
  P(G_BOX, WOOD_B, 0, 4.62, 0.05, 0, 0, 0, 0.3, 0.3, 7.2);
  // thatch trim
  for (let i = -3; i <= 3; i++) {
    P(G_BOX, 0x8f6a2e, -3.35, 2.68, i * 1.0, 0, 0, 0.62, 0.6, 0.1, 0.85);
    P(G_BOX, 0x8f6a2e, 3.35, 2.68, i * 1.0, 0, 0, -0.62, 0.6, 0.1, 0.85);
  }
  // hanging fish sign
  P(G_BOX, WOOD_B, -4.4, 2.35, -2.4, 0, 0, 0, 0.24, 3.2, 0.24);
  P(G_BOX, WOOD_B, -3.5, 3.85, -2.4, 0, 0, 0, 2.1, 0.2, 0.2);
  P(G_BOX, 0x3a2c20, -3.0, 3.72, -2.4, 0, 0, 0, 0.08, 0.42, 0.08);
  P(G_BOX, 0x3a2c20, -4.0, 3.72, -2.4, 0, 0, 0, 0.08, 0.42, 0.08);
  P(G_BOX, 0x6b4a2e, -3.5, 3.05, -2.4, 0, 0, 0, 2.3, 1.1, 0.14);
  // painted fish on the board
  P(G_ICO1, 0xf0a13c, -3.35, 3.05, -2.5, 0, 0, 0, 0.62, 0.36, 0.1);
  P(G_CONE, 0xf0a13c, -4.35, 3.05, -2.5, 0, 0, Math.PI * 0.5, 0.52, 0.5, 0.1);
  P(G_ICO0, 0x2a2018, -3.05, 3.14, -2.56, 0, 0, 0, 0.08, 0.08, 0.05);
  // barrels beside the hut
  P(G_CYL8, 0x7d5a38, 4.3, 0.6, -1.4, 0, 0, 0, 1.0, 1.2, 1.0);
  P(G_CYL8, 0x4a4038, 4.3, 0.6, -1.4, 0, 0, 0, 1.06, 0.16, 1.06);
  P(G_BOX, WOOD_C, -4.6, 0.45, 0.6, 0, 0.5, 0, 1.1, 0.9, 1.1);
}

function buildStoneRing(parts) {
  const rnd = mulberry32(1357);
  // altar plinth
  push(parts, G_CYL12, STONE_B, RINGSITE.x, RING_Y + 0.22, RINGSITE.z, 0, 0, 0, 7.4, 0.45, 7.4);
  push(parts, G_CYL12, STONE_C, RINGSITE.x, RING_Y + 0.5, RINGSITE.z, 0, 0.26, 0, 6.2, 0.2, 6.2);
  const stones = 9;
  for (let i = 0; i < stones; i++) {
    const a = (i / stones) * Math.PI * 2;
    const x = RINGSITE.x + Math.cos(a) * RING_R;
    const z = RINGSITE.z + Math.sin(a) * RING_R;
    const g = terrainHeight(x, z);
    const h = 3.6 + (i % 3) * 0.55 + rnd() * 0.5;
    const tilt = (rnd() - 0.5) * 0.13;
    push(parts, G_CYL5, i % 2 ? STONE_A : STONE_B, x, g + h * 0.45 - 0.35, z,
      tilt, a + rnd(), tilt * 0.6, 1.5 + rnd() * 0.4, h, 1.05 + rnd() * 0.3);
    // capstone on every third pair
    if (i % 3 === 0) {
      push(parts, G_BOX, STONE_C, x, g + h - 0.15, z, 0, a, tilt * 0.4, 2.0, 0.42, 1.3);
    }
    // rubble at the base
    push(parts, G_ICO0, STONE_B, x + (rnd() - 0.5) * 2.4, g + 0.12, z + (rnd() - 0.5) * 2.4,
      rnd(), rnd(), rnd(), 0.5 + rnd() * 0.4, 0.32, 0.5 + rnd() * 0.4);
  }
}

function buildCampfireBase(parts) {
  const rnd = mulberry32(8642);
  for (let i = 0; i < 11; i++) {
    const a = (i / 11) * Math.PI * 2 + 0.2;
    const x = CAMP_X + Math.cos(a) * 1.75, z = CAMP_Z + Math.sin(a) * 1.75;
    const g = terrainHeight(x, z);
    push(parts, G_ICO0, i % 2 ? STONE_A : STONE_C, x, g + 0.16, z, rnd(), rnd(), rnd(),
      0.42 + rnd() * 0.2, 0.34, 0.42 + rnd() * 0.2);
  }
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    push(parts, G_CYL6, i % 2 ? 0x5a4028 : 0x6e4e30,
      CAMP_X + Math.cos(a) * 0.4, CAMP_Y + 0.45, CAMP_Z + Math.sin(a) * 0.4,
      Math.cos(a) * 0.5, -a, Math.sin(a) * 0.5, 0.26, 2.1, 0.26);
  }
  push(parts, G_ICO0, 0x241a14, CAMP_X, CAMP_Y + 0.12, CAMP_Z, 0, 0, 0, 1.5, 0.16, 1.5);
  // log benches around the fire
  for (let i = 0; i < 3; i++) {
    const a = i * 2.3 + 0.6;
    const x = CAMP_X + Math.cos(a) * 3.6, z = CAMP_Z + Math.sin(a) * 3.6;
    const g = terrainHeight(x, z);
    push(parts, G_CYL8, 0x6e4e30, x, g + 0.4, z, 0, -a + Math.PI * 0.5, Math.PI * 0.5, 0.8, 3.4, 0.8);
  }
}

function buildScatter(staticParts, foliageParts) {
  const rnd = mulberry32(60607);
  // ---- rocks ----
  let placed = 0, guard = 0;
  while (placed < 30 && guard++ < 4000) {
    const a = rnd() * Math.PI * 2;
    const r = 18 + Math.sqrt(rnd()) * 116;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const h = terrainHeight(x, z);
    if (h < -3.2 || h > 17) continue;
    const dRing = Math.hypot(x - RINGSITE.x, z - RINGSITE.z);
    if (dRing < RING_R + 3) continue;
    if (Math.hypot(x - CAMP_X, z - CAMP_Z) < 5) continue;
    if (Math.hypot(x - SHOP_X, z - SHOP_Z) < 7) continue;
    if (Math.abs(x) < 5 && z < DOCK_START_Z + 6) continue;
    const s = 0.7 + rnd() * 2.6;
    push(staticParts, rnd() < 0.5 ? G_ICO0 : G_ICO1,
      rnd() < 0.4 ? STONE_A : (rnd() < 0.6 ? STONE_B : STONE_C),
      x, h + s * 0.32, z, rnd() * 3, rnd() * 3, rnd() * 3,
      s * (0.8 + rnd() * 0.5), s * (0.55 + rnd() * 0.5), s * (0.8 + rnd() * 0.5));
    placed++;
  }
  // ---- driftwood on the beach ----
  for (let i = 0; i < 9; i++) {
    const a = rnd() * Math.PI * 2;
    const r = 112 + rnd() * 12;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const h = terrainHeight(x, z);
    if (h < -1.2 || h > 2.2) continue;
    push(staticParts, G_CYL6, 0x9a8b74, x, h + 0.22, z,
      (rnd() - 0.5) * 0.3, rnd() * 3, Math.PI * 0.5 + (rnd() - 0.5) * 0.3,
      0.4 + rnd() * 0.2, 2 + rnd() * 3, 0.4 + rnd() * 0.2);
  }
  // ---- palms (foliage, swaying) ----
  let trees = 0;
  guard = 0;
  while (trees < 16 && guard++ < 6000) {
    const a = rnd() * Math.PI * 2;
    const r = 26 + Math.sqrt(rnd()) * 92;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const h = terrainHeight(x, z);
    if (h < 1.1 || h > 10.5) continue;
    const sl = Math.hypot(terrainHeight(x + 2, z) - terrainHeight(x - 2, z),
      terrainHeight(x, z + 2) - terrainHeight(x, z - 2)) / 4;
    if (sl > 0.42) continue;
    if (Math.hypot(x - RINGSITE.x, z - RINGSITE.z) < RING_R + 8) continue;
    if (Math.hypot(x - CAMP_X, z - CAMP_Z) < 8) continue;
    if (Math.hypot(x - SHOP_X, z - SHOP_Z) < 9) continue;
    if (Math.abs(x) < 6 && z < DOCK_START_Z + 8) continue;
    const th = 6.5 + rnd() * 4.2;
    const bendX = (rnd() - 0.5) * 2.4, bendZ = (rnd() - 0.5) * 2.4;
    const phase = rnd() * 6.283;
    const trunkGeo = makeTrunkGeo(th, 0.42 + rnd() * 0.1, 0.24, bendX, bendZ, 7);
    push(foliageParts, trunkGeo, rnd() < 0.5 ? 0x8a7050 : 0x77603f, x, h - 0.25, z,
      0, rnd() * 6.283, 0, 1, 1, 1, [h + th * 0.25, h + th, 0.22, phase]);
    const crownY = h - 0.25 + th;
    const fronds = 8 + Math.floor(rnd() * 3);
    for (let f = 0; f < fronds; f++) {
      const fa = (f / fronds) * Math.PI * 2 + rnd() * 0.25;
      const len = 3.3 + rnd() * 1.5;
      const geo = makeFrondGeo(len, 0.62 + rnd() * 0.2, 1.5 + rnd() * 1.1);
      const shade = rnd();
      push(foliageParts, geo,
        shade < 0.33 ? 0x4f9c34 : (shade < 0.7 ? 0x62b840 : 0x3f8a2e),
        x + bendX, crownY, z + bendZ, 0, -fa, 0.16 + rnd() * 0.22, 1, 1, 1,
        [crownY - 1.5, crownY + 1.5, 1.0, phase]);
    }
    for (let cnut = 0; cnut < 3; cnut++) {
      const ca = rnd() * 6.283;
      push(foliageParts, G_ICO0, 0x5f4a2c,
        x + bendX + Math.cos(ca) * 0.42, crownY - 0.42, z + bendZ + Math.sin(ca) * 0.42,
        rnd(), rnd(), rnd(), 0.28, 0.28, 0.28, [crownY - 2, crownY, 0.85, phase]);
    }
    trees++;
  }
  // ---- grass tufts (foliage, swaying) ----
  let tufts = 0;
  guard = 0;
  while (tufts < 260 && guard++ < 9000) {
    const a = rnd() * Math.PI * 2;
    const r = 12 + Math.sqrt(rnd()) * 108;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const h = terrainHeight(x, z);
    if (h < 1.4 || h > 15) continue;
    const shade = rnd();
    const col = shade < 0.25 ? 0x86c24a : (shade < 0.55 ? 0x5da33a : (shade < 0.85 ? 0x74b043 : 0xb9c05a));
    const s = 0.7 + rnd() * 0.9;
    const ph = rnd() * 6.283;
    for (let b = 0; b < 3; b++) {
      push(foliageParts, TUFT_BLADE, col,
        x + (rnd() - 0.5) * 0.7, h - 0.05, z + (rnd() - 0.5) * 0.7,
        0, rnd() * 6.283, (rnd() - 0.5) * 0.35, s, s * (0.8 + rnd() * 0.6), s,
        [h, h + 1.0, 0.32, ph]);
    }
    tufts++;
  }
}

// =============================================================
// GOD RAYS - additive vertex-coloured shafts, no depth write.
// =============================================================
function makeRayFan(seed, count, minLen, maxLen, minW, maxW) {
  const rnd = mulberry32(seed);
  const pos = new Float32Array(count * 6 * 3);
  const col = new Float32Array(count * 6 * 3);
  const idx = new Uint32Array(count * 4 * 3);
  let vi = 0, ii = 0;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rnd() * 0.35;
    const len = lerp(minLen, maxLen, rnd() * rnd());
    const wTip = lerp(minW, maxW, rnd());
    const wBase = wTip * 0.16 + 0.5;
    const bright = 0.35 + rnd() * 0.65;
    const dx = Math.cos(a), dy = Math.sin(a);
    const px = -dy, py = dx;
    const bs = len * 0.05;
    const v = [
      bs * dx + px * wBase * 0.5, bs * dy + py * wBase * 0.5,
      bs * dx, bs * dy,
      bs * dx - px * wBase * 0.5, bs * dy - py * wBase * 0.5,
      len * dx + px * wTip * 0.5, len * dy + py * wTip * 0.5,
      len * dx, len * dy,
      len * dx - px * wTip * 0.5, len * dy - py * wTip * 0.5,
    ];
    const cs = [0, bright, 0, 0, bright * 0.06, 0];
    for (let k = 0; k < 6; k++) {
      const o = (vi + k) * 3;
      pos[o] = v[k * 2]; pos[o + 1] = v[k * 2 + 1]; pos[o + 2] = 0;
      col[o] = cs[k]; col[o + 1] = cs[k]; col[o + 2] = cs[k];
    }
    const b = vi;
    idx[ii++] = b; idx[ii++] = b + 1; idx[ii++] = b + 3;
    idx[ii++] = b + 1; idx[ii++] = b + 4; idx[ii++] = b + 3;
    idx[ii++] = b + 1; idx[ii++] = b + 2; idx[ii++] = b + 4;
    idx[ii++] = b + 2; idx[ii++] = b + 5; idx[ii++] = b + 4;
    vi += 6;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

// vertical shafts descending from the surface (underwater look)
function makeUnderShafts(seed, count, rMin, rMax, depth) {
  const rnd = mulberry32(seed);
  const pos = new Float32Array(count * 6 * 3);
  const col = new Float32Array(count * 6 * 3);
  const idx = new Uint32Array(count * 4 * 3);
  let vi = 0, ii = 0;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rnd() * 0.5;
    const r = lerp(rMin, rMax, rnd());
    const w = 3.5 + rnd() * 9;
    const dpt = depth * (0.55 + rnd() * 0.45);
    const bright = 0.3 + rnd() * 0.7;
    const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
    const px = -Math.sin(a), pz = Math.cos(a);
    const tilt = (rnd() - 0.5) * 0.5;
    const v = [
      cx + px * w * 0.5, 1.5, cz + pz * w * 0.5,
      cx, 1.5, cz,
      cx - px * w * 0.5, 1.5, cz - pz * w * 0.5,
      cx + px * w * 0.9 + tilt * dpt, -dpt, cz + pz * w * 0.9,
      cx + tilt * dpt, -dpt, cz,
      cx - px * w * 0.9 + tilt * dpt, -dpt, cz - pz * w * 0.9,
    ];
    const cs = [0, bright, 0, 0, 0, 0];
    for (let k = 0; k < 6; k++) {
      const o = (vi + k) * 3;
      pos[o] = v[k * 3]; pos[o + 1] = v[k * 3 + 1]; pos[o + 2] = v[k * 3 + 2];
      col[o] = cs[k]; col[o + 1] = cs[k]; col[o + 2] = cs[k];
    }
    const b = vi;
    idx[ii++] = b; idx[ii++] = b + 1; idx[ii++] = b + 3;
    idx[ii++] = b + 1; idx[ii++] = b + 4; idx[ii++] = b + 3;
    idx[ii++] = b + 1; idx[ii++] = b + 2; idx[ii++] = b + 4;
    idx[ii++] = b + 2; idx[ii++] = b + 5; idx[ii++] = b + 4;
    vi += 6;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

// =============================================================
// PORTAL - spiral vortex shader
// =============================================================
const PORTAL_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const PORTAL_FRAG = `
uniform float uTime;
uniform float uPower;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float a = atan(p.y, p.x);
  float sw = a * 2.0 + uTime * 1.35 - pow(max(r, 0.02), 0.55) * 11.0;
  float arms = 0.5 + 0.5 * sin(sw * 1.5);
  float arms2 = 0.5 + 0.5 * sin(sw * 3.0 + 1.7);
  float core = smoothstep(0.95, 0.05, r);
  float edge = smoothstep(1.0, 0.82, r);
  float rim = smoothstep(0.72, 0.99, r) * (0.55 + 0.45 * sin(uTime * 2.0 + a * 5.0));
  vec3 cyan = vec3(0.18, 0.95, 1.05);
  vec3 violet = vec3(0.68, 0.22, 1.10);
  vec3 col = mix(cyan, violet, clamp(arms * 0.75 + r * 0.35, 0.0, 1.0));
  float mask = edge * (core * 0.35 + arms * arms2 * core * 0.95 + rim * 0.5);
  mask += pow(core, 6.0) * 0.85;
  mask *= uPower;
  gl_FragColor = vec4(col * mask * 1.9, clamp(mask, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// =============================================================
// BUOYS - one instanced set for every area ring
// =============================================================
const BUOY_KEYS = [1, 2, 4, 6, 8];
const BUOY_COLORS = [0x5ce06a, 0x3aa8f0, 0x9a5af0, 0xf04a5a, 0xc02aff];
function buoyColor(minTier, out) {
  if (minTier <= BUOY_KEYS[0]) return out.set(BUOY_COLORS[0]);
  for (let i = 1; i < BUOY_KEYS.length; i++) {
    if (minTier <= BUOY_KEYS[i]) {
      const t = (minTier - BUOY_KEYS[i - 1]) / (BUOY_KEYS[i] - BUOY_KEYS[i - 1]);
      out.set(BUOY_COLORS[i - 1]);
      _colB.set(BUOY_COLORS[i]);
      return out.lerp(_colB, t);
    }
  }
  return out.set(BUOY_COLORS[BUOY_COLORS.length - 1]);
}

function buildBuoyBodyGeo() {
  const parts = [];
  push(parts, G_CONE, 0xffffff, 0, 0.42, 0, Math.PI, 0, 0, 1.5, 1.1, 1.5);
  push(parts, G_CYL8, 0xf2f2f2, 0, 0.98, 0, 0, 0, 0, 1.15, 0.34, 1.15);
  push(parts, G_CYL6, 0x39424c, 0, 1.42, 0, 0, 0, 0, 0.16, 0.95, 0.16);
  push(parts, G_BOX, 0x2c343c, 0, 0.2, 0, 0, 0.4, 0, 1.25, 0.12, 1.25);
  return mergeParts(parts);
}

// =============================================================
// sun path: up exactly between dawn and dusk (ECON.NIGHT_START)
// =============================================================
const DAWN_T = 1 - ECON.NIGHT_START;
const DUSK_T = ECON.NIGHT_START;
function sunTheta(tod) {
  let x = tod - Math.floor(tod);
  if (x >= DAWN_T && x <= DUSK_T) return Math.PI * (x - DAWN_T) / (DUSK_T - DAWN_T);
  const nx = x > DUSK_T ? (x - DUSK_T) : (x + 1 - DUSK_T);
  return Math.PI + Math.PI * nx / (1 - (DUSK_T - DAWN_T));
}

// sky palettes  [top, mid(horizon), bot]
const SKY_DAY = [new THREE.Color(0x2f7fd6), new THREE.Color(0xa8d8f4), new THREE.Color(0xc9e6f2)];
const SKY_DAWN = [new THREE.Color(0x3f6fb8), new THREE.Color(0xffb066), new THREE.Color(0xf0956a)];
const SKY_DUSK = [new THREE.Color(0x37307e), new THREE.Color(0xf2704a), new THREE.Color(0x7a3055)];
const SKY_NIGHT = [new THREE.Color(0x050916), new THREE.Color(0x13203f), new THREE.Color(0x0a1024)];
const SKY_SNAP = [new THREE.Color(0x0a0002), new THREE.Color(0x3a0508), new THREE.Color(0x120001)];

const SUNC_DAY = new THREE.Color(0xfff4dc);
const SUNC_DAWN = new THREE.Color(0xffa055);
const SUNC_DUSK = new THREE.Color(0xff7a42);
const HEMI_SKY_DAY = new THREE.Color(0xa6d4ff), HEMI_GND_DAY = new THREE.Color(0x7c8a52);
const HEMI_SKY_TWI = new THREE.Color(0xff9d6a), HEMI_GND_TWI = new THREE.Color(0x5c4636);
const HEMI_SKY_NGT = new THREE.Color(0x18203c), HEMI_GND_NGT = new THREE.Color(0x0e1420);
const FOG_UNDER = new THREE.Color(0x0d4a52);
const FOG_UNDER_DEEP = new THREE.Color(0x03181f);
const FOG_SNAP = new THREE.Color(0x1a0407);

function blend3(out, a, b, c, wa, wb, wc) {
  out.setRGB(a.r * wa + b.r * wb + c.r * wc, a.g * wa + b.g * wb + c.g * wc, a.b * wa + b.b * wb + c.b * wc);
  return out;
}

// =============================================================
// WEATHER LOOK TABLE (shared/constants.js WEATHER holds the game
// data; this is purely how each type is rendered).
// Everything here MULTIPLIES the day/night result so weather and
// the sun cycle compose instead of fighting - and the whole effect
// is scaled by (1 - snapAmt) so setNightSnap always wins.
//   sun/hemi  : light intensity multipliers
//   mul/desat/tint : sky+fog colour grade (brightness, greyness, hue)
//   deck      : opacity of the overhead cloud sheets (also hides sun/stars)
//   dark      : how much the cloud bodies darken
//   fogNear/fogFar : scene fog distance multipliers
//   glow      : sky sun-bloom multiplier
//   rain      : rain density (0 = none, 1 = squall, 1.45 = storm)
//   wind/lean : palm sway amplitude + constant downwind lean
//   storm     : 1 while the sheet-lightning flicker may fire
// =============================================================
const WX_ORDER = ['clear', 'overcast', 'fog', 'rain', 'storm'];
const WX_LOOK = {
  clear: {
    sun: 1.00, hemi: 1.00, mul: 1.00, desat: 0.00, tint: [1.00, 1.00, 1.00],
    deck: 0.00, dark: 0.00, fogNear: 1.00, fogFar: 1.000, glow: 1.00,
    rain: 0.00, wind: 1.00, lean: 0.00, storm: 0,
  },
  overcast: {
    sun: 0.60, hemi: 0.86, mul: 0.78, desat: 0.60, tint: [0.98, 1.00, 1.05],
    deck: 0.82, dark: 0.38, fogNear: 0.80, fogFar: 0.580, glow: 0.30,
    rain: 0.00, wind: 1.35, lean: 0.10, storm: 0,
  },
  fog: {
    sun: 0.50, hemi: 0.80, mul: 0.94, desat: 0.86, tint: [1.00, 1.00, 1.02],
    deck: 0.42, dark: 0.10, fogNear: 0.07, fogFar: 0.100, glow: 0.22,
    rain: 0.00, wind: 0.45, lean: 0.00, storm: 0,
  },
  rain: {
    sun: 0.40, hemi: 0.70, mul: 0.52, desat: 0.62, tint: [0.95, 1.00, 1.08],
    deck: 1.00, dark: 0.62, fogNear: 0.45, fogFar: 0.330, glow: 0.16,
    rain: 1.00, wind: 2.05, lean: 0.34, storm: 0,
  },
  storm: {
    sun: 0.25, hemi: 0.52, mul: 0.24, desat: 0.55, tint: [0.80, 1.10, 0.90],
    deck: 1.00, dark: 0.88, fogNear: 0.34, fogFar: 0.230, glow: 0.10,
    rain: 1.45, wind: 3.10, lean: 0.82, storm: 1,
  },
};

// grade a colour by the blended weather look. amt fades the whole
// effect out (used to hand the sky over to the horror night snap).
function wxGrade(col, mul, desat, tr, tg, tb, amt) {
  if (amt <= 0.0005) return col;
  col.multiplyScalar(lerp(1, mul, amt));
  if (desat > 0) {
    const lum = col.r * 0.299 + col.g * 0.587 + col.b * 0.114;
    const d = desat * amt;
    col.setRGB(lerp(col.r, lum, d), lerp(col.g, lum, d), lerp(col.b, lum, d));
  }
  col.r *= lerp(1, tr, amt);
  col.g *= lerp(1, tg, amt);
  col.b *= lerp(1, tb, amt);
  return col;
}

// rain-splash sprites: per-point size + alpha (PointsMaterial has neither)
const SPLASH_VERT = `
attribute float aSize;
attribute float aAlpha;
uniform float uScale;
varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aSize * uScale / max(0.15, -mv.z), 1.0, 110.0);
  vA = aAlpha;
}`;

const SPLASH_FRAG = `
uniform sampler2D uTex;
uniform vec3 uColor;
varying float vA;
void main() {
  if (vA <= 0.003) discard;
  vec4 t = texture2D(uTex, gl_PointCoord);
  if (t.a <= 0.004) discard;
  gl_FragColor = vec4(uColor * t.rgb, t.a * vA);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// =============================================================
// initWorld
// =============================================================
export function initWorld(ctx) {
  const scene = ctx.scene;

  // ---------- fog ----------
  const fog = new THREE.Fog(0xa8d8f4, 150, 1250);
  scene.fog = fog;

  // ---------- terrain ----------
  const terrain = buildTerrain(ctx);
  scene.add(terrain);

  // ---------- static props ----------
  const staticParts = [];
  const foliageParts = [];
  buildDock(staticParts);
  buildShopHut(staticParts);
  buildStoneRing(staticParts);
  buildCampfireBase(staticParts);
  buildScatter(staticParts, foliageParts);

  const staticMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const staticMesh = new THREE.Mesh(mergeParts(staticParts), staticMat);
  staticMesh.castShadow = true;
  staticMesh.receiveShadow = true;
  staticMesh.matrixAutoUpdate = false;
  staticMesh.updateMatrix();
  scene.add(staticMesh);

  // ---------- foliage (wind-swayed in the vertex shader) ----------
  const windU = { value: 0 };
  const windAmpU = { value: 1 };                       // weather wind strength
  const windLeanU = { value: new THREE.Vector2(0, 0) }; // constant downwind lean
  const foliageMat = new THREE.MeshLambertMaterial({
    vertexColors: true, flatShading: true, side: THREE.DoubleSide,
  });
  foliageMat.onBeforeCompile = (sh) => {
    sh.uniforms.uWind = windU;
    sh.uniforms.uWindAmp = windAmpU;
    sh.uniforms.uWindLean = windLeanU;
    sh.vertexShader = 'attribute float aSway;\nattribute float aPhase;\nuniform float uWind;\n'
      + 'uniform float uWindAmp;\nuniform vec2 uWindLean;\n'
      + sh.vertexShader.replace('#include <begin_vertex>', [
        '#include <begin_vertex>',
        'float swPh = uWind + aPhase;',
        'float swA = aSway * uWindAmp;',
        'transformed.x += (sin(swPh) * 0.85 + sin(swPh * 2.7 + 1.3) * 0.3) * swA + uWindLean.x * aSway;',
        'transformed.z += (cos(swPh * 0.83 + 0.7) * 0.72 + sin(swPh * 3.1) * 0.18) * swA + uWindLean.y * aSway;',
        'transformed.y -= swA * swA * 0.22;',
      ].join('\n'));
  };
  foliageMat.customProgramCacheKey = () => 'tidewreck-foliage-wind2';
  const foliageMesh = new THREE.Mesh(mergeParts(foliageParts), foliageMat);
  foliageMesh.castShadow = true;
  foliageMesh.receiveShadow = true;
  foliageMesh.matrixAutoUpdate = false;
  foliageMesh.updateMatrix();
  scene.add(foliageMesh);

  // ---------- sky dome ----------
  const skyUniforms = {
    uTop: { value: new THREE.Color(0x2f7fd6) },
    uMid: { value: new THREE.Color(0xa8d8f4) },
    uBot: { value: new THREE.Color(0xc9e6f2) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunTint: { value: new THREE.Color(0xfff0d0) },
    uGlow: { value: 1 },
    uBand: { value: 0.4 },
  };
  const skyMat = new THREE.ShaderMaterial({
    uniforms: skyUniforms, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
    side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(500, 32, 20), skyMat);
  sky.renderOrder = -1000;
  sky.frustumCulled = false;
  scene.add(sky);

  // ---------- stars ----------
  const stars = buildStars();
  scene.add(stars);

  // ---------- sun & moon ----------
  const glowTex = makeGlowTexture(256, 0.16, 'rgba(255,238,190,0.6)');
  const discTex = makeDiscTexture(128);
  const moonTex = makeMoonTexture(128);
  const billboard = new THREE.PlaneGeometry(1, 1);

  const sunDiscMat = new THREE.MeshBasicMaterial({
    map: discTex, color: 0xfff2d2, transparent: false, blending: THREE.AdditiveBlending,
    depthTest: false, depthWrite: false, fog: false,
  });
  const sunDisc = new THREE.Mesh(billboard, sunDiscMat);
  sunDisc.scale.setScalar(19);
  sunDisc.renderOrder = -992;
  sunDisc.frustumCulled = false;
  scene.add(sunDisc);

  const sunGlowMat = new THREE.MeshBasicMaterial({
    map: glowTex, color: 0xffd79a, transparent: false, blending: THREE.AdditiveBlending,
    depthTest: false, depthWrite: false, fog: false,
  });
  const sunGlow = new THREE.Mesh(billboard, sunGlowMat);
  sunGlow.scale.setScalar(150);
  sunGlow.renderOrder = -993;
  sunGlow.frustumCulled = false;
  scene.add(sunGlow);

  const moonDiscMat = new THREE.MeshBasicMaterial({
    map: moonTex, color: 0xdfe8ff, transparent: false, blending: THREE.AdditiveBlending,
    depthTest: false, depthWrite: false, fog: false,
  });
  const moonDisc = new THREE.Mesh(billboard, moonDiscMat);
  moonDisc.scale.setScalar(16);
  moonDisc.renderOrder = -992;
  moonDisc.frustumCulled = false;
  scene.add(moonDisc);

  const moonGlowMat = new THREE.MeshBasicMaterial({
    map: glowTex, color: 0x9fc0ff, transparent: false, blending: THREE.AdditiveBlending,
    depthTest: false, depthWrite: false, fog: false,
  });
  const moonGlow = new THREE.Mesh(billboard, moonGlowMat);
  moonGlow.scale.setScalar(70);
  moonGlow.renderOrder = -993;
  moonGlow.frustumCulled = false;
  scene.add(moonGlow);

  // ---------- clouds ----------
  const cloudSet = buildClouds();
  scene.add(cloudSet.group);

  // ---------- weather: overhead cloud deck ----------
  // Two camera-following sheets. Fully transparent (and hidden) while the
  // weather is clear; the blend in update() fades them in and darkens them.
  const deckGeo = new THREE.PlaneGeometry(2800, 2800);
  deckGeo.rotateX(-Math.PI * 0.5);
  const deckTexA = makeCloudDeckTexture();
  const deckTexB = deckTexA.clone();
  deckTexB.needsUpdate = true;
  deckTexB.wrapS = deckTexB.wrapT = THREE.RepeatWrapping;
  deckTexB.repeat.set(1.3, 1.3);
  deckTexB.offset.set(0.37, 0.61);
  const deckMatA = new THREE.MeshBasicMaterial({
    map: deckTexA, color: 0x9fb0bd, transparent: true, opacity: 0,
    depthWrite: false, side: THREE.DoubleSide, fog: true,
  });
  const deckMatB = new THREE.MeshBasicMaterial({
    map: deckTexB, color: 0x8494a2, transparent: true, opacity: 0,
    depthWrite: false, side: THREE.DoubleSide, fog: true,
  });
  const deckA = new THREE.Mesh(deckGeo, deckMatA);
  deckA.position.y = 232;
  deckA.renderOrder = -99;
  deckA.frustumCulled = false;
  deckA.visible = false;
  scene.add(deckA);
  const deckB = new THREE.Mesh(deckGeo, deckMatB);
  deckB.position.y = 166;
  deckB.renderOrder = -98;
  deckB.frustumCulled = false;
  deckB.visible = false;
  scene.add(deckB);

  // ---------- weather: rain ----------
  // ~1500 short streaks living in a cylinder around the camera. Each drop
  // remembers the height it dies at (terrain or sea level) so rain lands.
  const RAIN_N = 1500;
  const RAIN_R = 38;
  const rndWx = mulberry32(24601);
  const rainPos = new Float32Array(RAIN_N * 6);
  const rainX = new Float32Array(RAIN_N);
  const rainY = new Float32Array(RAIN_N);
  const rainZ = new Float32Array(RAIN_N);
  const rainV = new Float32Array(RAIN_N);
  const rainKill = new Float32Array(RAIN_N);
  const rainSea = new Uint8Array(RAIN_N);   // 1 = dies on the swell, not on land

  function seedRain(i, cx, cy, cz, spread) {
    const a = rndWx() * 6.283;
    const r = Math.sqrt(rndWx()) * RAIN_R;
    const x = cx + Math.cos(a) * r;
    const z = cz + Math.sin(a) * r;
    rainX[i] = x;
    rainZ[i] = z;
    rainY[i] = cy + (spread ? (rndWx() * 62 - 26) : (24 + rndWx() * 30));
    rainV[i] = 26 + rndWx() * 17;
    const g = terrainHeight(x, z);
    rainSea[i] = g < 0.1 ? 1 : 0;
    rainKill[i] = g - 0.15;
  }
  for (let i = 0; i < RAIN_N; i++) {
    seedRain(i, 0, 6, 0, true);
    const o = i * 6;
    rainPos[o] = rainX[i]; rainPos[o + 1] = -9999; rainPos[o + 2] = rainZ[i];
    rainPos[o + 3] = rainX[i]; rainPos[o + 4] = -9999; rainPos[o + 5] = rainZ[i];
  }
  const rainGeo = new THREE.BufferGeometry();
  rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
  rainGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  const rainMat = new THREE.LineBasicMaterial({
    color: 0xc6dcee, transparent: true, opacity: 0, depthWrite: false, fog: true,
  });
  const rainMesh = new THREE.LineSegments(rainGeo, rainMat);
  rainMesh.frustumCulled = false;
  rainMesh.renderOrder = 3;
  rainMesh.visible = false;
  scene.add(rainMesh);

  // ---------- weather: ground splash flecks ----------
  const SPL_N = 200;
  const splTex = makeSoftTexture(64);
  const splPos = new Float32Array(SPL_N * 3);
  const splSize = new Float32Array(SPL_N);
  const splAlpha = new Float32Array(SPL_N);
  const splLife = new Float32Array(SPL_N);
  const splMax = new Float32Array(SPL_N);
  const splBase = new Float32Array(SPL_N);
  for (let i = 0; i < SPL_N; i++) splPos[i * 3 + 1] = -9999;
  const splGeo = new THREE.BufferGeometry();
  splGeo.setAttribute('position', new THREE.BufferAttribute(splPos, 3));
  splGeo.setAttribute('aSize', new THREE.BufferAttribute(splSize, 1));
  splGeo.setAttribute('aAlpha', new THREE.BufferAttribute(splAlpha, 1));
  splGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  const splMat = new THREE.ShaderMaterial({
    uniforms: {
      uTex: { value: splTex },
      uColor: { value: new THREE.Color(0xd6ecff) },
      uScale: { value: 600 },
    },
    vertexShader: SPLASH_VERT, fragmentShader: SPLASH_FRAG,
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.NormalBlending,
  });
  const splPts = new THREE.Points(splGeo, splMat);
  splPts.frustumCulled = false;
  splPts.renderOrder = 3;
  splPts.visible = false;
  scene.add(splPts);
  let splCursor = 0;
  function spawnSplash(x, y, z) {
    const i = splCursor;
    splCursor = (splCursor + 1) % SPL_N;
    splPos[i * 3] = x;
    splPos[i * 3 + 1] = y + 0.06;
    splPos[i * 3 + 2] = z;
    const life = 0.20 + rndWx() * 0.20;
    splLife[i] = life;
    splMax[i] = life;
    splBase[i] = 0.09 + rndWx() * 0.13;
    splSize[i] = splBase[i];
    splAlpha[i] = 0.6;
  }

  // ---------- weather: lightning ----------
  const BOLT_POOL = 3;
  const BOLT_SEGS = 11;
  const boltNodes = new Float32Array((BOLT_SEGS + 1) * 3);
  const bolts = [];
  for (let i = 0; i < BOLT_POOL; i++) {
    const grp = new THREE.Group();
    grp.visible = false;
    const mat = new THREE.MeshBasicMaterial({
      color: 0xe6f2ff, transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending, fog: false, toneMapped: false,
    });
    const haloMat = new THREE.MeshBasicMaterial({
      map: glowTex, color: 0xbcdcff, transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending, fog: false, toneMapped: false,
    });
    const segs = [];
    for (let s = 0; s < BOLT_SEGS; s++) {
      const m = new THREE.Mesh(G_CYL6, mat);
      m.visible = false;
      grp.add(m);
      segs.push(m);
    }
    const halo = new THREE.Mesh(billboard, haloMat);
    halo.scale.setScalar(34);
    grp.add(halo);
    scene.add(grp);
    bolts.push({ group: grp, segs, halo, mat, haloMat, life: 0, max: 0.16 });
  }
  let boltCursor = 0;

  // one always-present point light so the light count never changes
  const strikeLight = new THREE.PointLight(0xcfe4ff, 0, 300, 1.3);
  strikeLight.position.set(0, 80, 0);
  scene.add(strikeLight);

  // fullscreen white flash plane (camera locked, only shown mid-flash)
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0, depthTest: false,
    depthWrite: false, fog: false, toneMapped: false, side: THREE.DoubleSide,
  });
  const flashPlane = new THREE.Mesh(billboard, flashMat);
  flashPlane.renderOrder = 9999;
  flashPlane.frustumCulled = false;
  flashPlane.visible = false;
  scene.add(flashPlane);

  // ---------- lights ----------
  const sunLight = new THREE.DirectionalLight(0xfff4dc, 2.9);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.camera.left = -160;
  sunLight.shadow.camera.right = 160;
  sunLight.shadow.camera.top = 160;
  sunLight.shadow.camera.bottom = -160;
  sunLight.shadow.camera.near = 20;
  sunLight.shadow.camera.far = 760;
  sunLight.shadow.bias = -0.0006;
  sunLight.shadow.normalBias = 0.55;
  sunLight.shadow.camera.updateProjectionMatrix();
  sunLight.target.position.set(0, 6, 0);
  scene.add(sunLight);
  scene.add(sunLight.target);

  const moonLight = new THREE.DirectionalLight(0x9ab8ff, 0.35);
  moonLight.castShadow = false;
  moonLight.target.position.set(0, 6, 0);
  scene.add(moonLight);
  scene.add(moonLight.target);

  const hemi = new THREE.HemisphereLight(0xa6d4ff, 0x7c8a52, 1.1);
  hemi.position.set(0, 60, 0);
  scene.add(hemi);

  // ---------- god rays (above water) ----------
  const rayFanGeo = makeRayFan(5150, 11, 40, 190, 6, 34);
  const rayMat = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide, fog: false,
  });
  const rayFan = new THREE.Mesh(rayFanGeo, rayMat);
  rayFan.renderOrder = 6;
  rayFan.frustumCulled = false;
  scene.add(rayFan);

  const rayFan2 = new THREE.Mesh(makeRayFan(9021, 8, 60, 230, 10, 46), rayMat.clone());
  rayFan2.material.opacity = 0;
  rayFan2.renderOrder = 6;
  rayFan2.frustumCulled = false;
  scene.add(rayFan2);

  // ---------- god rays (underwater) ----------
  const underMat = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide, fog: false, color: 0xbff2ff,
  });
  const underShafts = new THREE.Mesh(makeUnderShafts(311, 14, 12, 46, 42), underMat);
  underShafts.renderOrder = 5;
  underShafts.frustumCulled = false;
  underShafts.visible = false;
  scene.add(underShafts);
  const underShafts2 = new THREE.Mesh(makeUnderShafts(977, 10, 26, 70, 60), underMat.clone());
  underShafts2.material.color.set(0x8fe0ff);
  underShafts2.renderOrder = 5;
  underShafts2.frustumCulled = false;
  underShafts2.visible = false;
  scene.add(underShafts2);

  // ---------- campfire ----------
  const campGroup = new THREE.Group();
  campGroup.position.set(CAMP_X, CAMP_Y, CAMP_Z);
  scene.add(campGroup);
  const flameGeo = new THREE.ConeGeometry(0.5, 1, 7);
  const flames = [];
  const flameCols = [0xff5a18, 0xff9a28, 0xffd86a];
  for (let i = 0; i < 3; i++) {
    const m = new THREE.MeshBasicMaterial({
      color: flameCols[i], transparent: true, opacity: 0.75 - i * 0.12,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    const f = new THREE.Mesh(flameGeo, m);
    f.position.set(0, 0.75 + i * 0.22, 0);
    f.scale.set(1.35 - i * 0.3, 1.7 - i * 0.35, 1.35 - i * 0.3);
    f.renderOrder = 4;
    campGroup.add(f);
    flames.push(f);
  }
  const emberCount = 46;
  const emberPos = new Float32Array(emberCount * 3);
  const emberSeed = new Float32Array(emberCount * 3);
  const rndE = mulberry32(5150);
  for (let i = 0; i < emberCount; i++) {
    emberSeed[i * 3] = rndE();
    emberSeed[i * 3 + 1] = 0.5 + rndE() * 0.9;
    emberSeed[i * 3 + 2] = rndE() * 6.283;
  }
  const emberGeo = new THREE.BufferGeometry();
  emberGeo.setAttribute('position', new THREE.BufferAttribute(emberPos, 3));
  emberGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 2, 0), 5);
  const emberMat = new THREE.PointsMaterial({
    map: glowTex, color: 0xff9a3a, size: 0.34, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true, fog: false,
  });
  const embers = new THREE.Points(emberGeo, emberMat);
  embers.frustumCulled = false;
  embers.renderOrder = 4;
  campGroup.add(embers);
  const campLight = new THREE.PointLight(0xff8a38, 14, 34, 1.6);
  campLight.position.set(0, 1.5, 0);
  campGroup.add(campLight);

  // ---------- shop lantern ----------
  const lanternMat = new THREE.MeshBasicMaterial({ color: 0xffb552, fog: false, transparent: true, opacity: 0.0 });
  const lantern = new THREE.Mesh(G_ICO0, lanternMat);
  const lanternYaw = -0.55;
  const lx = 3.0, lz = -2.2;
  lantern.position.set(
    SHOP_X + lx * Math.cos(lanternYaw) + lz * Math.sin(lanternYaw),
    SHOP_Y + 2.65,
    SHOP_Z + (-lx * Math.sin(lanternYaw) + lz * Math.cos(lanternYaw)));
  lantern.scale.set(0.22, 0.3, 0.22);
  scene.add(lantern);
  const lanternGlow = new THREE.Mesh(billboard, new THREE.MeshBasicMaterial({
    map: glowTex, color: 0xffb552, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  }));
  lanternGlow.position.copy(lantern.position);
  lanternGlow.scale.setScalar(4.5);
  lanternGlow.renderOrder = 4;
  scene.add(lanternGlow);
  const lanternLight = new THREE.PointLight(0xffa845, 0, 26, 1.7);
  lanternLight.position.copy(lantern.position);
  scene.add(lanternLight);

  // ---------- stone-ring glow + portal ----------
  const ringGlowMat = new THREE.MeshBasicMaterial({
    map: glowTex, color: 0x9a6aff, transparent: true, opacity: 0.16,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  });
  const ringGlows = [];
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    const gx = RINGSITE.x + Math.cos(a) * RING_R;
    const gz = RINGSITE.z + Math.sin(a) * RING_R;
    const g = new THREE.Mesh(billboard, ringGlowMat);
    g.position.set(gx, terrainHeight(gx, gz) + 3.5, gz);
    g.scale.setScalar(3.4);
    g.renderOrder = 4;
    scene.add(g);
    ringGlows.push(g);
  }

  const portalGroup = new THREE.Group();
  portalGroup.position.set(RINGSITE.x, RING_Y, RINGSITE.z);
  portalGroup.visible = false;
  scene.add(portalGroup);
  const portalU = { uTime: { value: 0 }, uPower: { value: 1 } };
  const portalMat = new THREE.ShaderMaterial({
    uniforms: portalU, vertexShader: PORTAL_VERT, fragmentShader: PORTAL_FRAG,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    side: THREE.DoubleSide, fog: false,
  });
  const portalDisc = new THREE.Mesh(new THREE.CircleGeometry(6.6, 56), portalMat);
  portalDisc.rotation.x = -Math.PI * 0.5;
  portalDisc.position.y = 0.85;
  portalDisc.renderOrder = 5;
  portalGroup.add(portalDisc);

  const beamGeo = new THREE.CylinderGeometry(4.6, 6.4, 30, 26, 1, true);
  {
    const bp = beamGeo.attributes.position;
    const bc = new Float32Array(bp.count * 3);
    for (let i = 0; i < bp.count; i++) {
      const k = 1 - smoothstep(-15, 15, bp.getY(i));
      bc[i * 3] = 0.42 * k; bc[i * 3 + 1] = 0.85 * k; bc[i * 3 + 2] = 1.0 * k;
    }
    beamGeo.setAttribute('color', new THREE.BufferAttribute(bc, 3));
  }
  const beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide, fog: false,
  }));
  beam.position.y = 15.6;
  beam.renderOrder = 5;
  portalGroup.add(beam);

  const ppCount = 150;
  const ppPos = new Float32Array(ppCount * 3);
  const ppSeed = new Float32Array(ppCount * 3);
  const rndP = mulberry32(31337);
  for (let i = 0; i < ppCount; i++) {
    ppSeed[i * 3] = rndP() * 6.283;
    ppSeed[i * 3 + 1] = 0.25 + rndP() * 0.85;
    ppSeed[i * 3 + 2] = 1.2 + rndP() * 5.6;
  }
  const ppGeo = new THREE.BufferGeometry();
  ppGeo.setAttribute('position', new THREE.BufferAttribute(ppPos, 3));
  ppGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 8, 0), 20);
  const portalParticles = new THREE.Points(ppGeo, new THREE.PointsMaterial({
    map: glowTex, color: 0xb07aff, size: 0.55, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true, fog: false,
  }));
  portalParticles.frustumCulled = false;
  portalParticles.renderOrder = 5;
  portalGroup.add(portalParticles);
  const portalLight = new THREE.PointLight(0x9a5aff, 0, 60, 1.4);
  portalLight.position.set(0, 4, 0);
  portalGroup.add(portalLight);

  // ---------- area buoys + labels ----------
  const buoys = [];
  const labels = [];
  for (let ai = 0; ai < AREAS.length; ai++) {
    const area = AREAS[ai];
    const cx = area.center[0], cz = area.center[1];
    buoyColor(area.tiers[0], _col);
    const hex = _col.getHex();
    // an even ring of 8 where the water allows it, otherwise the best arc of
    // floatable spots (Home Shallows overlaps the island's south beach)
    const ringPts = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + ai * 0.4;
      const bx = cx + Math.cos(a) * area.radius;
      const bz = cz + Math.sin(a) * area.radius;
      if (terrainHeight(bx, bz) > -0.9) { ringPts.length = 0; break; }
      ringPts.push([bx, bz]);
    }
    if (ringPts.length === 0) {
      const cand = [];
      for (let i = 0; i < 18; i++) {
        const a = (i / 18) * Math.PI * 2 + ai * 0.4;
        const bx = cx + Math.cos(a) * area.radius;
        const bz = cz + Math.sin(a) * area.radius;
        if (terrainHeight(bx, bz) > -0.9) continue;
        cand.push([bx, bz]);
      }
      const want = Math.min(8, cand.length);
      const stride = want > 0 ? cand.length / want : 1;
      for (let k = 0; k < want; k++) ringPts.push(cand[Math.floor(k * stride)]);
    }
    for (let i = 0; i < ringPts.length; i++) {
      buoys.push({ x: ringPts[i][0], z: ringPts[i][1], phase: (ai * 7 + i) * 1.37, color: hex });
    }
    // label floats on the island-facing edge of the ring, always over water
    const dl = Math.hypot(cx, cz) || 1;
    const nx = cx / dl, nz = cz / dl;
    let lxp = cx - nx * area.radius * 0.94;
    let lzp = cz - nz * area.radius * 0.94;
    for (let k = 0; k < 24 && terrainHeight(lxp, lzp) > -1.2; k++) {
      lxp += nx * 4; lzp += nz * 4;
    }
    const tierTxt = 'TIER ' + area.tiers[0] + '-' + area.tiers[1];
    const sprMat = new THREE.SpriteMaterial({
      map: makeLabelTexture(area.name, tierTxt, hex),
      transparent: true, depthWrite: false, fog: false, opacity: 0,
    });
    const spr = new THREE.Sprite(sprMat);
    spr.position.set(lxp, 8.5, lzp);
    spr.scale.set(30, 9.4, 1);
    spr.renderOrder = 7;
    spr.visible = false;
    scene.add(spr);
    labels.push({ spr, mat: sprMat, x: lxp, z: lzp });
  }

  const buoyCount = buoys.length;
  const bodyMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const buoyBody = new THREE.InstancedMesh(buildBuoyBodyGeo(), bodyMat, buoyCount);
  buoyBody.castShadow = false;
  buoyBody.receiveShadow = false;
  buoyBody.frustumCulled = false;
  buoyBody.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(buoyBody);

  const orbMat = new THREE.MeshBasicMaterial({ fog: true });
  const buoyOrb = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.42, 1), orbMat, buoyCount);
  buoyOrb.frustumCulled = false;
  buoyOrb.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(buoyOrb);

  const haloMat = new THREE.MeshBasicMaterial({
    map: glowTex, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending,
    depthWrite: false, fog: false,
  });
  const buoyHalo = new THREE.InstancedMesh(billboard, haloMat, buoyCount);
  buoyHalo.frustumCulled = false;
  buoyHalo.renderOrder = 4;
  buoyHalo.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(buoyHalo);

  for (let i = 0; i < buoyCount; i++) {
    _col.set(buoys[i].color);
    buoyBody.setColorAt(i, _col);
    buoyOrb.setColorAt(i, _col);
    buoyHalo.setColorAt(i, _col);
  }
  if (buoyBody.instanceColor) buoyBody.instanceColor.needsUpdate = true;
  if (buoyOrb.instanceColor) buoyOrb.instanceColor.needsUpdate = true;
  if (buoyHalo.instanceColor) buoyHalo.instanceColor.needsUpdate = true;

  // ---------- runtime state ----------
  const sunDirV = new THREE.Vector3(0, 1, 0);
  const moonDirV = new THREE.Vector3(0, -1, 0);
  const camFwd = new THREE.Vector3(0, 0, -1);
  const sunTint = new THREE.Color(0xfff4dc);
  const horizonCol = new THREE.Color(0xa8d8f4);
  const surfFog = new THREE.Color(0xa8d8f4);
  let underAmt = 0;
  let snapAmt = 0;
  let snapOn = false;
  let portalOn = false;
  let portalPower = 0;
  let playerUnder = false;

  // ---------- weather runtime ----------
  let wxType = 'clear';
  const wxW = [1, 0, 0, 0, 0];        // blend weights, same order as WX_ORDER
  const deckCol = new THREE.Color();
  let windPhase = 0;
  let flashAmt = 0;                   // sky / hemisphere flash (bolts + sheets)
  let flashFS = 0;                    // fullscreen white + strike light (bolts)
  let sheetT = 6 + Math.random() * 8;
  const thunderQ = [];

  function setWeather(type) {
    if (typeof type !== 'string' || !WEATHER[type]) return;
    if (WX_ORDER.indexOf(type) < 0) return;
    wxType = type;
  }

  function queueThunder(dist, vol) {
    if (thunderQ.length > 5) thunderQ.shift();
    thunderQ.push({ t: Math.min(2.2, Math.max(0, dist) / 340), dist, vol });
  }

  // jagged bolt from cloud height down to p, ~0.15 s, plus the flash
  function strike(px, py, pz) {
    const B = bolts[boltCursor];
    boltCursor = (boltCursor + 1) % BOLT_POOL;
    const topY = py + 165 + Math.random() * 70;
    const tx = px + (Math.random() - 0.5) * 52;
    const tz = pz + (Math.random() - 0.5) * 52;
    for (let s = 0; s <= BOLT_SEGS; s++) {
      const k = s / BOLT_SEGS;
      const j = (s === 0 || s === BOLT_SEGS) ? 0 : (1 - k) * 8.5 + 1.2;
      boltNodes[s * 3] = lerp(tx, px, k) + (Math.random() - 0.5) * j * 2;
      boltNodes[s * 3 + 1] = lerp(topY, py, k);
      boltNodes[s * 3 + 2] = lerp(tz, pz, k) + (Math.random() - 0.5) * j * 2;
    }
    for (let s = 0; s < BOLT_SEGS; s++) {
      const o = s * 3;
      const ax = boltNodes[o], ay = boltNodes[o + 1], az = boltNodes[o + 2];
      const bx = boltNodes[o + 3], by = boltNodes[o + 4], bz = boltNodes[o + 5];
      _v.set(bx - ax, by - ay, bz - az);
      const len = _v.length() || 0.01;
      _v.multiplyScalar(1 / len);
      _q.setFromUnitVectors(_up, _v);
      const m = B.segs[s];
      m.visible = true;
      m.position.set((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
      m.quaternion.copy(_q);
      const rad = lerp(2.2, 0.9, s / BOLT_SEGS);
      m.scale.set(rad, len * 1.03, rad);
    }
    B.halo.position.set(px, py + 1.4, pz);
    B.life = B.max;
    B.group.visible = true;

    const cam = ctx.camera;
    let dist = 200;
    if (cam) {
      const dx = px - cam.position.x, dy = py - cam.position.y, dz = pz - cam.position.z;
      dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    const near = clamp(1 - dist / 520, 0.12, 1);
    flashAmt = Math.max(flashAmt, 0.45 + near * 0.55);
    flashFS = Math.max(flashFS, near * near);
    strikeLight.position.set(px, py + 6, pz);
    queueThunder(dist);
  }

  function onLightning(m) {
    if (!m) return;
    const p = m.p;
    let px, py, pz;
    if (Array.isArray(p) && p.length >= 3) {
      px = Number(p[0]); py = Number(p[1]); pz = Number(p[2]);
    } else if (p && typeof p.x === 'number') {
      px = p.x; py = p.y; pz = p.z;
    } else return;
    if (!isFinite(px) || !isFinite(py) || !isFinite(pz)) return;
    strike(px, py, pz);
  }

  if (ctx.net && typeof ctx.net.on === 'function') {
    ctx.net.on(MSG.WEATHER, (m) => { if (m && m.type) setWeather(m.type); });
    ctx.net.on(MSG.LIGHTNING, onLightning);
  }
  try {
    const pr = (ctx.renderer && ctx.renderer.getPixelRatio) ? ctx.renderer.getPixelRatio() : 1;
    stars.material.uniforms.uScale.value = pr;
  } catch (e) { /* default scale */ }

  function setNightSnap(on) {
    snapOn = !!on;
    if (snapOn) snapAmt = 1; // horror override snaps instantly
  }
  function setPortalBuilt(on) {
    portalOn = !!on;
    if (portalOn) portalGroup.visible = true;
  }

  if (ctx.bus && ctx.bus.on) {
    ctx.bus.on('eventStart', () => setNightSnap(true));
    ctx.bus.on('eventEnd', () => setNightSnap(false));
    ctx.bus.on('underwater', (on) => { playerUnder = !!on; });
    ctx.bus.on('worldState', (w) => {
      if (!w) return;
      if (typeof w.portalBuilt === 'boolean' && w.portalBuilt !== portalOn) setPortalBuilt(w.portalBuilt);
      if (w.weather && w.weather.type) setWeather(w.weather.type);
    });
    ctx.bus.on('phase', (p) => {
      if (p === 'menu' || p === 'lobby') { setNightSnap(false); setWeather('clear'); }
    });
  }

  // ---------- per-frame ----------
  function update(dt, t) {
    const cam = ctx.camera;
    if (!cam) return;
    const step = clamp(dt, 0, 0.05);

    // ---- time of day -> sun / moon ----
    const tod = (ctx.state && typeof ctx.state.timeOfDay === 'number') ? ctx.state.timeOfDay : 0.3;
    const th = sunTheta(tod);
    sunDirV.set(Math.cos(th), Math.sin(th) * 0.93, -Math.sin(th) * 0.37).normalize();
    moonDirV.copy(sunDirV).multiplyScalar(-1);
    const sunUp = sunDirV.y;
    const dayF = smoothstep(0.02, 0.30, sunUp);
    const twiF = smoothstep(-0.26, 0.10, sunUp) * (1 - dayF);
    const nightF = clamp(1 - dayF - twiF, 0, 1);
    const rising = sunDirV.x > 0;
    const twiSky = rising ? SKY_DAWN : SKY_DUSK;
    const twiSun = rising ? SUNC_DAWN : SUNC_DUSK;

    // ---- night snap blend ----
    if (snapOn) snapAmt = 1;
    else if (snapAmt > 0) snapAmt = Math.max(0, snapAmt - step * 0.4);
    const inv = 1 - snapAmt;

    // ---- weather blend (~5 s crossfade, multiplies onto day/night) ----
    const wsrc = (ctx.state && ctx.state.world) ? ctx.state.world : null;
    if (wsrc && wsrc.weather && wsrc.weather.type) setWeather(wsrc.weather.type);
    const wxK = 1 - Math.pow(0.02, step / 5);
    let wsum = 0;
    for (let i = 0; i < WX_ORDER.length; i++) {
      wxW[i] += ((WX_ORDER[i] === wxType ? 1 : 0) - wxW[i]) * wxK;
      if (wxW[i] < 0.0005) wxW[i] = 0;
      wsum += wxW[i];
    }
    if (wsum <= 0.0001) { wxW[0] = 1; wsum = 1; }
    let wSun = 0, wHemi = 0, wMul = 0, wDesat = 0, wDeck = 0, wDark = 0;
    let wFogN = 0, wFogF = 0, wGlow = 0, wRain = 0, wWind = 0, wLean = 0, wStorm = 0;
    let wTr = 0, wTg = 0, wTb = 0;
    for (let i = 0; i < WX_ORDER.length; i++) {
      const w = wxW[i] / wsum;
      if (w <= 0) continue;
      const L = WX_LOOK[WX_ORDER[i]];
      wSun += L.sun * w; wHemi += L.hemi * w; wMul += L.mul * w; wDesat += L.desat * w;
      wDeck += L.deck * w; wDark += L.dark * w;
      wFogN += L.fogNear * w; wFogF += L.fogFar * w; wGlow += L.glow * w;
      wRain += L.rain * w; wWind += L.wind * w; wLean += L.lean * w; wStorm += L.storm * w;
      wTr += L.tint[0] * w; wTg += L.tint[1] * w; wTb += L.tint[2] * w;
    }
    // the horror snap always wins: weather influence fades out under it
    const wxAmt = inv;
    const wSunL = lerp(1, wSun, wxAmt);
    const wHemiL = lerp(1, wHemi, wxAmt);
    const deckAmt = wDeck * wxAmt;

    // ---- underwater blend ----
    const wh = ctx.getWaterHeight ? ctx.getWaterHeight(cam.position.x, cam.position.z, t) : 0;
    const camUnder = cam.position.y < wh - 0.12;
    const uTarget = (camUnder || (playerUnder && cam.position.y < wh + 0.4)) ? 1 : 0;
    underAmt += (uTarget - underAmt) * (1 - Math.exp(-step * 9));
    const depthBelow = Math.max(0, wh - cam.position.y);

    // ---- sky colours ----
    blend3(skyUniforms.uTop.value, SKY_DAY[0], twiSky[0], SKY_NIGHT[0], dayF, twiF, nightF);
    blend3(skyUniforms.uMid.value, SKY_DAY[1], twiSky[1], SKY_NIGHT[1], dayF, twiF, nightF);
    blend3(skyUniforms.uBot.value, SKY_DAY[2], twiSky[2], SKY_NIGHT[2], dayF, twiF, nightF);
    if (wxAmt > 0.001) {
      // the horizon stays a touch brighter than the zenith under cloud
      wxGrade(skyUniforms.uTop.value, wMul, wDesat, wTr, wTg, wTb, wxAmt);
      wxGrade(skyUniforms.uMid.value, lerp(1, wMul, 0.90), wDesat * 0.92, wTr, wTg, wTb, wxAmt);
      wxGrade(skyUniforms.uBot.value, lerp(1, wMul, 0.96), wDesat * 0.95, wTr, wTg, wTb, wxAmt);
    }
    if (snapAmt > 0) {
      skyUniforms.uTop.value.lerp(SKY_SNAP[0], snapAmt);
      skyUniforms.uMid.value.lerp(SKY_SNAP[1], snapAmt);
      skyUniforms.uBot.value.lerp(SKY_SNAP[2], snapAmt);
    }
    blend3(sunTint, SUNC_DAY, twiSun, SKY_NIGHT[1], dayF, twiF, nightF);
    if (wxAmt > 0.001) wxGrade(sunTint, wMul, wDesat * 0.7, wTr, wTg, wTb, wxAmt);
    if (snapAmt > 0) sunTint.lerp(SKY_SNAP[1], snapAmt);
    skyUniforms.uSunDir.value.copy(sunUp > -0.25 ? sunDirV : moonDirV);
    skyUniforms.uSunTint.value.copy(sunUp > -0.25 ? sunTint : moonDiscMat.color);
    skyUniforms.uGlow.value = (0.5 + 1.05 * twiF + 0.25 * dayF) * inv * lerp(1, wGlow, wxAmt)
      + snapAmt * 0.12;
    skyUniforms.uBand.value = (0.2 + 1.35 * twiF) * inv * lerp(1, wGlow, wxAmt);
    // lightning washes the whole sky out for a couple of frames
    if (flashAmt > 0.002) {
      const fk = clamp(flashAmt * 0.62, 0, 0.85);
      skyUniforms.uTop.value.lerp(_white, fk * 0.7);
      skyUniforms.uMid.value.lerp(_white, fk);
      skyUniforms.uBot.value.lerp(_white, fk * 0.85);
    }
    sky.position.copy(cam.position);

    horizonCol.copy(skyUniforms.uMid.value).lerp(skyUniforms.uBot.value, 0.4);

    // ---- stars ----
    stars.position.copy(cam.position);
    stars.material.uniforms.uTime.value = t;
    stars.material.uniforms.uOpacity.value = clamp(nightF * 1.05 - 0.05, 0, 1)
      * (1 - snapAmt * 0.82) * (1 - deckAmt * 0.94);

    // ---- sun & moon billboards ----
    const sunVis = smoothstep(-0.14, 0.02, sunUp) * inv * (1 - deckAmt * 0.88);
    _v.copy(sunDirV).multiplyScalar(455).add(cam.position);
    sunDisc.position.copy(_v);
    sunDisc.quaternion.copy(cam.quaternion);
    sunGlow.position.copy(_v);
    sunGlow.quaternion.copy(cam.quaternion);
    sunDisc.visible = sunGlow.visible = sunVis > 0.01;
    sunDiscMat.color.copy(sunTint).multiplyScalar(1.55 * sunVis);
    sunGlowMat.color.copy(sunTint).multiplyScalar((0.30 + 0.55 * twiF) * sunVis);
    sunGlow.scale.setScalar(120 + twiF * 130);

    const moonVis = clamp(1 - dayF * 0.9, 0, 1) * (1 - deckAmt * 0.9);
    _v.copy(moonDirV).multiplyScalar(455).add(cam.position);
    moonDisc.position.copy(_v);
    moonDisc.quaternion.copy(cam.quaternion);
    moonGlow.position.copy(_v);
    moonGlow.quaternion.copy(cam.quaternion);
    const moonUp = smoothstep(-0.12, 0.05, moonDirV.y);
    moonDisc.visible = moonGlow.visible = moonUp * moonVis > 0.01;
    _colB.setRGB(0.82, 0.88, 1.0).lerp(_col.setRGB(1.0, 0.12, 0.06), snapAmt);
    moonDiscMat.color.copy(_colB).multiplyScalar(moonVis * moonUp * (1 - snapAmt * 0.45));
    moonGlowMat.color.copy(_colB).multiplyScalar(moonVis * moonUp * (0.22 + snapAmt * 0.5));
    moonGlow.scale.setScalar(66 + snapAmt * 40);

    // ---- clouds + weather deck ----
    blend3(_col, SKY_DAY[2], twiSky[1], SKY_NIGHT[1], dayF, twiF, nightF);
    if (wxAmt > 0.001) wxGrade(_col, wMul, wDesat, wTr, wTg, wTb, wxAmt);
    _col.lerp(SKY_SNAP[1], snapAmt * 0.9);
    deckCol.copy(_col).multiplyScalar(1 - wDark * 0.62 * wxAmt);
    if (flashAmt > 0.002) deckCol.lerp(_white, clamp(flashAmt * 0.55, 0, 0.8));
    cloudSet.mat.color.copy(deckCol).multiplyScalar(1.06);
    cloudSet.mat.opacity = 0.9 - snapAmt * 0.25 + deckAmt * 0.09;
    const puffGrow = 1 + deckAmt * 0.85;
    for (let i = 0; i < cloudSet.clouds.length; i++) {
      const c = cloudSet.clouds[i];
      c.position.x += c.userData.speed * step * (0.6 + wWind * 0.5);
      if (c.position.x > 900) c.position.x = -900;
      c.position.y = c.userData.baseY - deckAmt * 46 + Math.sin(t * 0.13 + i) * 3.0;
      c.scale.setScalar(c.userData.baseScale * puffGrow);
    }
    // overhead sheets
    const deckOp = deckAmt * 0.94;
    deckA.visible = deckOp > 0.01;
    deckB.visible = deckOp > 0.02;
    if (deckA.visible) {
      deckA.position.x = cam.position.x;
      deckA.position.z = cam.position.z;
      deckMatA.opacity = deckOp;
      deckMatA.color.copy(deckCol).multiplyScalar(1.02);
      deckTexA.offset.x += step * 0.0035 * (0.5 + wWind * 0.55);
      deckTexA.offset.y += step * 0.0018 * (0.5 + wWind * 0.4);
    }
    if (deckB.visible) {
      deckB.position.x = cam.position.x;
      deckB.position.z = cam.position.z;
      deckMatB.opacity = deckOp * 0.72;
      deckMatB.color.copy(deckCol).multiplyScalar(0.82);
      deckTexB.offset.x += step * 0.0062 * (0.5 + wWind * 0.6);
      deckTexB.offset.y -= step * 0.0026 * (0.5 + wWind * 0.4);
    }

    // ---- lights ----
    sunLight.position.copy(sunDirV).multiplyScalar(330);
    sunLight.position.y += 6;
    sunLight.intensity = (2.85 * dayF + 1.25 * twiF) * inv * wSunL;
    blend3(_col, SUNC_DAY, twiSun, SUNC_DAY, dayF, twiF, nightF);
    if (wxAmt > 0.001) wxGrade(_col, 1, wDesat * 0.8, wTr, wTg, wTb, wxAmt);
    sunLight.color.copy(_col);

    moonLight.position.copy(moonDirV).multiplyScalar(330);
    moonLight.position.y += 6;
    moonLight.color.copy(_colB);
    moonLight.intensity = (0.42 * nightF + 0.12 * twiF) * inv * wSunL + snapAmt * 0.30;

    blend3(_col, HEMI_SKY_DAY, HEMI_SKY_TWI, HEMI_SKY_NGT, dayF, twiF, nightF);
    if (wxAmt > 0.001) wxGrade(_col, lerp(1, wMul, 0.72), wDesat, wTr, wTg, wTb, wxAmt);
    if (snapAmt > 0) _col.lerp(SKY_SNAP[1], snapAmt);
    if (flashAmt > 0.002) _col.lerp(_white, clamp(flashAmt * 0.7, 0, 0.9));
    hemi.color.copy(_col);
    blend3(_col, HEMI_GND_DAY, HEMI_GND_TWI, HEMI_GND_NGT, dayF, twiF, nightF);
    if (wxAmt > 0.001) wxGrade(_col, lerp(1, wMul, 0.66), wDesat, wTr, wTg, wTb, wxAmt);
    if (snapAmt > 0) _col.lerp(SKY_SNAP[2], snapAmt);
    hemi.groundColor.copy(_col);
    hemi.intensity = (1.15 * dayF + 0.78 * twiF + 0.24 * nightF) * inv * wHemiL
      + snapAmt * 0.16 + flashAmt * 2.4;

    // ---- fog ----
    surfFog.copy(horizonCol);
    if (snapAmt > 0) surfFog.lerp(FOG_SNAP, snapAmt);
    let fNear = lerp(70, 165, dayF + twiF * 0.5);
    let fFar = lerp(620, 1320, dayF + twiF * 0.4);
    // weather pulls the fog in (dead fog pulls it WAY in)
    fNear *= lerp(1, wFogN, wxAmt);
    fFar *= lerp(1, wFogF, wxAmt);
    if (fFar < fNear + 6) fFar = fNear + 6;
    if (snapAmt > 0) {
      fNear = lerp(fNear, 8, snapAmt);
      fFar = lerp(fFar, 145, snapAmt);
    }
    if (underAmt > 0.001) {
      const dk = smoothstep(0, 34, depthBelow);
      _col.copy(FOG_UNDER).lerp(FOG_UNDER_DEEP, dk * 0.9);
      _col.multiplyScalar(0.22 + 0.78 * (dayF * 0.95 + twiF * 0.5 + nightF * 0.12));
      if (snapAmt > 0) _col.lerp(FOG_SNAP, snapAmt * 0.8);
      fog.color.copy(surfFog).lerp(_col, underAmt);
      fog.near = lerp(fNear, 0.5, underAmt);
      fog.far = lerp(fFar, lerp(52, 15, dk), underAmt);
    } else {
      fog.color.copy(surfFog);
      fog.near = fNear;
      fog.far = fFar;
    }
    if (flashAmt > 0.002) {
      fog.color.lerp(_white, clamp(flashAmt * 0.5, 0, 0.7) * (1 - underAmt));
    }

    // ---- god rays above water ----
    cam.getWorldDirection(camFwd);
    const align = clamp(camFwd.dot(sunDirV), 0, 1);
    const above = smoothstep(-0.03, 0.13, sunUp);
    const rayOp = (0.09 + 0.36 * twiF + 0.09 * dayF) * Math.pow(align, 2.2) * above
      * (1 - underAmt) * inv * (1 - deckAmt * 0.95);
    rayFan.visible = rayFan2.visible = rayOp > 0.004;
    if (rayFan.visible) {
      _v.copy(sunDirV).multiplyScalar(400).add(cam.position);
      rayFan.position.copy(_v);
      rayFan.lookAt(cam.position);
      rayFan.rotateZ(t * 0.017);
      rayFan2.position.copy(_v);
      rayFan2.lookAt(cam.position);
      rayFan2.rotateZ(-t * 0.011 + 1.1);
      rayMat.opacity = rayOp;
      rayMat.color.copy(sunTint);
      rayFan2.material.opacity = rayOp * 0.62;
      rayFan2.material.color.copy(sunTint);
    }

    // ---- god rays underwater ----
    const uVis = underAmt > 0.01;
    underShafts.visible = underShafts2.visible = uVis;
    if (uVis) {
      const fade = (1 - smoothstep(26, 95, depthBelow)) * (0.1 + 0.34 * dayF + 0.12 * twiF) * inv;
      underShafts.position.set(cam.position.x, wh, cam.position.z);
      underShafts.rotation.set(sunDirV.z * 0.16, t * 0.035, -sunDirV.x * 0.16);
      underShafts2.position.set(cam.position.x, wh, cam.position.z);
      underShafts2.rotation.set(sunDirV.z * 0.1, -t * 0.022, -sunDirV.x * 0.1);
      underMat.opacity = underAmt * fade;
      underShafts2.material.opacity = underAmt * fade * 0.7;
    }

    // ---- wind / foliage ----
    // phase is accumulated (not derived from t) so changing the wind speed
    // between weathers never snaps the palms to a new pose.
    const windAng = 0.55 + Math.sin(t * 0.037) * 0.6;
    const windDX = Math.cos(windAng), windDZ = Math.sin(windAng);
    const gust = 1 + Math.sin(t * 0.71) * 0.16 + Math.sin(t * 0.23 + 1.7) * 0.11;
    windPhase += step * (1.15 * (0.45 + 0.55 * wWind) + Math.cos(t * 0.21) * 0.231);
    windU.value = windPhase;
    windAmpU.value = 0.55 + 0.45 * wWind;
    windLeanU.value.set(windDX * wLean * 2.2 * gust, windDZ * wLean * 2.2 * gust);

    // ---- rain ----
    const rainAmt = clamp(wRain, 0, 1.45);
    const rainOn = rainAmt > 0.02 && underAmt < 0.94;
    rainMesh.visible = rainOn;
    const canvasEl = (ctx.renderer && ctx.renderer.domElement) ? ctx.renderer.domElement : null;
    const bufH = (canvasEl && canvasEl.height) ? canvasEl.height : 800;
    const projY = (cam.projectionMatrix && cam.projectionMatrix.elements)
      ? cam.projectionMatrix.elements[5] : 1.7;
    splMat.uniforms.uScale.value = bufH * projY * 0.5;
    if (rainOn) {
      const live = Math.min(RAIN_N, Math.max(1, Math.round(RAIN_N * (rainAmt / 1.45))));
      const hs = wWind * 2.4 * gust;
      const vx = windDX * hs, vz = windDZ * hs;
      const streak = 0.038 + rainAmt * 0.012;
      const cx = cam.position.x, cy = cam.position.y, cz = cam.position.z;
      const killR = (RAIN_R + 8) * (RAIN_R + 8);
      const seaKill = wh - 0.05;   // local swell height, so rain lands on waves
      for (let i = 0; i < live; i++) {
        rainY[i] -= rainV[i] * step;
        rainX[i] += vx * step;
        rainZ[i] += vz * step;
        let x = rainX[i], y = rainY[i], z = rainZ[i];
        const ddx = x - cx, ddz = z - cz;
        const kill = rainSea[i] ? seaKill : rainKill[i];
        if (y < kill || y > cy + 74 || (ddx * ddx + ddz * ddz) > killR) {
          if (y < kill && (i & 3) === 0) spawnSplash(x, kill, z);
          seedRain(i, cx, cy, cz, false);
          x = rainX[i]; y = rainY[i]; z = rainZ[i];
        }
        const o = i * 6;
        const sl = rainV[i] * streak;
        rainPos[o] = x; rainPos[o + 1] = y; rainPos[o + 2] = z;
        rainPos[o + 3] = x - vx * streak;
        rainPos[o + 4] = y + sl;
        rainPos[o + 5] = z - vz * streak;
      }
      for (let i = live; i < RAIN_N; i++) {
        const o = i * 6;
        rainPos[o + 1] = -9999;
        rainPos[o + 4] = -9999;
      }
      rainGeo.attributes.position.needsUpdate = true;
      rainMat.opacity = clamp(0.22 + rainAmt * 0.30, 0, 0.6) * (1 - underAmt);
      rainMat.color.copy(horizonCol).lerp(_white, 0.55);
    }

    // ---- rain splash flecks ----
    let splAny = false;
    for (let i = 0; i < SPL_N; i++) {
      if (splLife[i] <= 0) continue;
      splAny = true;
      splLife[i] -= step;
      if (splLife[i] <= 0) {
        splLife[i] = 0;
        splAlpha[i] = 0;
        splSize[i] = 0;
        splPos[i * 3 + 1] = -9999;
        continue;
      }
      const k = splLife[i] / splMax[i];
      splAlpha[i] = k * 0.55 * (1 - underAmt);
      splSize[i] = splBase[i] * (1.7 - k * 0.7);
    }
    splPts.visible = splAny;
    if (splAny) {
      splGeo.attributes.position.needsUpdate = true;
      splGeo.attributes.aSize.needsUpdate = true;
      splGeo.attributes.aAlpha.needsUpdate = true;
    }

    // ---- lightning: bolts, flashes, thunder ----
    if (flashAmt > 0) flashAmt = Math.max(0, flashAmt - step * 5.2);
    if (flashFS > 0) flashFS = Math.max(0, flashFS - step * 6.4);
    strikeLight.intensity = flashFS * 320;
    flashPlane.visible = flashFS > 0.01;
    if (flashPlane.visible) {
      const d = Math.max(0.24, (cam.near || 0.1) * 2.6);
      _v.set(0, 0, -1).applyQuaternion(cam.quaternion);
      flashPlane.position.copy(cam.position).addScaledVector(_v, d);
      flashPlane.quaternion.copy(cam.quaternion);
      const fh = 2 * Math.tan(((cam.fov || 60) * Math.PI / 180) * 0.5) * d * 1.35;
      flashPlane.scale.set(fh * (cam.aspect || 1.6), fh, 1);
      flashMat.opacity = clamp(flashFS * 0.34, 0, 0.34);
    }
    for (let i = 0; i < BOLT_POOL; i++) {
      const B = bolts[i];
      if (B.life <= 0) continue;
      B.life -= step;
      if (B.life <= 0) {
        B.life = 0;
        B.group.visible = false;
        B.mat.opacity = 0;
        B.haloMat.opacity = 0;
        for (let s = 0; s < B.segs.length; s++) B.segs[s].visible = false;
        continue;
      }
      const k = B.life / B.max;
      const flick = (k > 0.62 || (k > 0.26 && k < 0.44)) ? 1 : 0.32;
      B.mat.opacity = clamp(k * 1.5, 0, 1) * flick;
      B.haloMat.opacity = k * k * 0.95 * flick;
      B.halo.quaternion.copy(cam.quaternion);
    }
    // rare sheet lightning on the horizon while the storm holds
    if (wStorm > 0.5 && inv > 0.4) {
      sheetT -= step;
      if (sheetT <= 0) {
        sheetT = 7 + Math.random() * 13;
        flashAmt = Math.max(flashAmt, 0.20 + Math.random() * 0.26);
        if (Math.random() < 0.6) queueThunder(420 + Math.random() * 280, 0.4);
      }
    } else if (sheetT < 4) {
      sheetT = 5 + Math.random() * 9;
    }
    for (let i = thunderQ.length - 1; i >= 0; i--) {
      const q = thunderQ[i];
      q.t -= step;
      if (q.t > 0) continue;
      thunderQ.splice(i, 1);
      // late:true - we already waited out the travel time above
      if (ctx.audio && typeof ctx.audio.sfx === 'function') {
        if (q.vol === undefined) ctx.audio.sfx('thunder', { dist: q.dist, late: true });
        else ctx.audio.sfx('thunder', { dist: q.dist, late: true, vol: q.vol });
      }
    }

    // ---- buoys ----
    const gw = ctx.getWaterHeight;
    const haloOp = (0.28 + 0.55 * nightF + 0.2 * twiF) * inv + snapAmt * 0.5;
    haloMat.opacity = haloOp;
    for (let i = 0; i < buoyCount; i++) {
      const b = buoys[i];
      const wy = gw ? gw(b.x, b.z, t) : 0;
      _v.set(b.x, wy - 0.28 + Math.sin(t * 1.7 + b.phase) * 0.05, b.z);
      _e.set(Math.sin(t * 0.9 + b.phase) * 0.11, b.phase, Math.cos(t * 1.13 + b.phase * 0.7) * 0.11);
      _q.setFromEuler(_e);
      _s.set(1, 1, 1);
      _m4.compose(_v, _q, _s);
      buoyBody.setMatrixAt(i, _m4);
      _v.y += 1.95;
      _m4.compose(_v, _q, _s);
      buoyOrb.setMatrixAt(i, _m4);
      _s.setScalar(2.6 + Math.sin(t * 2.3 + b.phase) * 0.28);
      _m4.compose(_v, cam.quaternion, _s);
      buoyHalo.setMatrixAt(i, _m4);
    }
    buoyBody.instanceMatrix.needsUpdate = true;
    buoyOrb.instanceMatrix.needsUpdate = true;
    buoyHalo.instanceMatrix.needsUpdate = true;

    // ---- area labels ----
    for (let i = 0; i < labels.length; i++) {
      const L = labels[i];
      const dx = cam.position.x - L.x, dz = cam.position.z - L.z;
      const op = smoothstep(275, 175, Math.sqrt(dx * dx + dz * dz)) * (1 - underAmt * 0.75);
      L.mat.opacity = op * 0.95;
      L.spr.visible = op > 0.02;
    }

    // ---- campfire ----
    const flick = 0.86 + Math.sin(t * 13.7) * 0.09 + Math.sin(t * 7.1 + 1.3) * 0.06;
    for (let i = 0; i < flames.length; i++) {
      const f = flames[i];
      const k = flick + Math.sin(t * (9 + i * 3.3) + i) * 0.07;
      f.scale.set((1.35 - i * 0.3) * k, (1.7 - i * 0.35) * (0.85 + k * 0.3), (1.35 - i * 0.3) * k);
      f.rotation.y = t * (0.9 + i * 0.5);
      f.position.x = Math.sin(t * (2.1 + i)) * 0.05;
      f.position.z = Math.cos(t * (1.7 + i)) * 0.05;
    }
    campLight.intensity = (9 + flick * 7) * (0.55 + 0.45 * (1 - dayF));
    for (let i = 0; i < emberCount; i++) {
      const o = i * 3;
      const sp = emberSeed[o + 1];
      const life = (t * sp * 0.32 + emberSeed[o]) % 1;
      const a = emberSeed[o + 2] + life * 2.4;
      const rad = 0.3 + emberSeed[o] * 0.35 + life * 1.15;
      emberPos[o] = Math.cos(a) * rad;
      emberPos[o + 1] = 0.55 + life * 3.6;
      emberPos[o + 2] = Math.sin(a) * rad;
    }
    emberGeo.attributes.position.needsUpdate = true;
    emberMat.opacity = 0.55 + 0.45 * (1 - dayF);

    // ---- lantern ----
    const nightAmt = clamp(1 - dayF * 0.92, 0, 1);
    const lanFlick = 0.9 + Math.sin(t * 6.3) * 0.06 + Math.sin(t * 11.7) * 0.04;
    lanternLight.intensity = 8.5 * nightAmt * lanFlick;
    lanternMat.opacity = 0.35 + 0.65 * nightAmt;
    lanternGlow.material.opacity = 0.8 * nightAmt * lanFlick;
    lanternGlow.quaternion.copy(cam.quaternion);
    lanternGlow.scale.setScalar(3.6 + nightAmt * 1.6);

    // ---- stone ring / portal ----
    portalPower += ((portalOn ? 1 : 0) - portalPower) * (1 - Math.exp(-step * 2.2));
    if (portalPower < 0.004 && !portalOn) portalGroup.visible = false;
    ringGlowMat.opacity = (0.10 + 0.06 * Math.sin(t * 0.9)) * (0.35 + 0.65 * nightAmt) + portalPower * 0.8;
    ringGlowMat.color.setRGB(0.55 + portalPower * 0.1, 0.35 + portalPower * 0.5, 1.0);
    for (let i = 0; i < ringGlows.length; i++) {
      ringGlows[i].quaternion.copy(cam.quaternion);
      ringGlows[i].scale.setScalar(2.6 + portalPower * 1.6 + Math.sin(t * 1.4 + i) * 0.2);
    }
    if (portalGroup.visible) {
      portalU.uTime.value = t;
      portalU.uPower.value = portalPower;
      beam.material.opacity = 0.26 * portalPower * (0.82 + 0.18 * Math.sin(t * 1.9));
      beam.rotation.y = t * 0.28;
      portalLight.intensity = 14 * portalPower;
      for (let i = 0; i < ppCount; i++) {
        const o = i * 3;
        const life = (t * ppSeed[o + 1] * 0.22 + ppSeed[o] * 0.16) % 1;
        const a = ppSeed[o] + life * 6.5 + t * 0.5;
        const rad = ppSeed[o + 2] * (1 - life * 0.72) + 0.4;
        ppPos[o] = Math.cos(a) * rad;
        ppPos[o + 1] = 0.6 + life * 15.5;
        ppPos[o + 2] = Math.sin(a) * rad;
      }
      ppGeo.attributes.position.needsUpdate = true;
      portalParticles.material.opacity = 0.9 * portalPower;
    }

    // ---- broadcast sun direction (water.js consumes this) ----
    if (ctx.bus && ctx.bus.emit) ctx.bus.emit('sunDir', sunDirV);
  }

  // prime everything so frame zero already looks right
  update(0, 0);

  return {
    update,
    getTerrainHeight: terrainHeight,
    setNightSnap,
    setPortalBuilt,
    portalPos: new THREE.Vector3(RINGSITE.x, RING_Y + 1.2, RINGSITE.z),
    shopPos: new THREE.Vector3(SHOP_X, SHOP_Y, SHOP_Z),
    ringPos: new THREE.Vector3(RINGSITE.x, RING_Y, RINGSITE.z),
    dockPos: new THREE.Vector3(0, DECK_Y, DOCK_CZ),
    campfirePos: new THREE.Vector3(CAMP_X, CAMP_Y, CAMP_Z),
    islandRadius: ISLAND_R,
    sunDir: sunDirV,
  };
}
