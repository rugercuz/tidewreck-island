// =============================================================
// TIDEWRECK ISLAND - fishing.js
// Rods (5 tiers), casting, bobber, the reel minigame and the
// catch celebration. This is the core loop; it must FEEL good.
//
// Owns:   public/js/fishing.js
// Export: initFishing(ctx) -> { update(dt, t), isCasting() }
//
// Bus emits:  'castPower' {p}          while charging a cast
//             'castStart' {areaId, baitId}
//             'reelState' {tension, sweet:[a,b], progress}
//             'bite'      BITE payload
//             'catch'     CAST_RESULT payload
// Net sends:  MSG.CAST_START, MSG.REEL_DONE, MSG.CANCEL_CAST
// SFX names used (audio.js may synthesize what it knows):
//   'castWhoosh' 'plop' 'bobberSet' 'bite' 'hookSet' 'reelLoop'
//   'lineSnap' 'splash' 'catchSmall' 'catchMed' 'catchBig'
//   'catchLegendary' 'catchMutation' 'lineMiss' 'reelIn'
// =============================================================

import * as THREE from 'three';
import { MSG, AREAS, MUTATIONS, fishById } from '/shared/constants.js';
import { createFishMesh } from './fish.js';

// ---------------------------------------------------------------- temps
const UP = new THREE.Vector3(0, 1, 0);
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _v6 = new THREE.Vector3();
const _v7 = new THREE.Vector3();
const _v8 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();
const _col = new THREE.Color();

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, k) => a + (b - a) * k;
const rand = (a, b) => a + Math.random() * (b - a);

// ---------------------------------------------------------------- geometry cache
const _geo = new Map();
function G(key, make) {
  let g = _geo.get(key);
  if (!g) { g = make(); _geo.set(key, g); }
  return g;
}
const cyl = (rt, rb, h, rs = 10) => G(`c${rt}|${rb}|${h}|${rs}`, () => new THREE.CylinderGeometry(rt, rb, h, rs, 1));
const sph = (r, w = 10, h = 8) => G(`s${r}|${w}|${h}`, () => new THREE.SphereGeometry(r, w, h));
const hemi = (r, up) => G(`h${r}|${up}`, () => new THREE.SphereGeometry(r, 14, 8, 0, Math.PI * 2, up ? 0 : Math.PI / 2, Math.PI / 2));
const tor = (r, tu, rs = 6, ts = 12) => G(`t${r}|${tu}|${rs}|${ts}`, () => new THREE.TorusGeometry(r, tu, rs, ts));
const bx = (x, y, z) => G(`b${x}|${y}|${z}`, () => new THREE.BoxGeometry(x, y, z));

// ---------------------------------------------------------------- canvas textures
let _woodTex = null, _corkTex = null, _weaveTex = null;
function canvasTex(w, h, draw, repX = 1, repY = 1) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repX, repY);
  t.anisotropy = 4;
  return t;
}
function woodTex() {
  if (_woodTex) return _woodTex;
  _woodTex = canvasTex(64, 128, (g, w, h) => {
    g.fillStyle = '#8a6a44'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 60; i++) {
      const x = Math.random() * w;
      g.strokeStyle = `rgba(${60 + Math.random() * 40 | 0},${40 + Math.random() * 30 | 0},20,${0.10 + Math.random() * 0.25})`;
      g.lineWidth = 0.6 + Math.random() * 2.2;
      g.beginPath();
      g.moveTo(x, 0);
      g.bezierCurveTo(x + rand(-6, 6), h * 0.33, x + rand(-6, 6), h * 0.66, x + rand(-5, 5), h);
      g.stroke();
    }
    for (let i = 0; i < 14; i++) {
      g.fillStyle = `rgba(200,175,130,${0.05 + Math.random() * 0.12})`;
      g.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 2, 6 + Math.random() * 20);
    }
  }, 1, 2);
  return _woodTex;
}
function corkTex() {
  if (_corkTex) return _corkTex;
  _corkTex = canvasTex(64, 64, (g, w, h) => {
    g.fillStyle = '#d8b47a'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 220; i++) {
      const r = 0.7 + Math.random() * 2.6;
      g.fillStyle = `rgba(${110 + Math.random() * 50 | 0},${80 + Math.random() * 40 | 0},40,${0.12 + Math.random() * 0.4})`;
      g.beginPath(); g.arc(Math.random() * w, Math.random() * h, r, 0, 6.283); g.fill();
    }
  }, 1, 2);
  return _corkTex;
}
function weaveTex() {
  if (_weaveTex) return _weaveTex;
  _weaveTex = canvasTex(64, 64, (g, w, h) => {
    g.fillStyle = '#14101f'; g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(150,170,255,0.16)'; g.lineWidth = 1;
    for (let i = -h; i < w; i += 6) {
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i + h, h); g.stroke();
      g.beginPath(); g.moveTo(i + h, 0); g.lineTo(i, h); g.stroke();
    }
    g.strokeStyle = 'rgba(120,240,255,0.10)';
    for (let i = 0; i < w; i += 16) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, h); g.stroke(); }
  }, 1, 3);
  return _weaveTex;
}

// ---------------------------------------------------------------- particles
const P_VERT = `
attribute vec3 aColor;
attribute float aSize;
attribute float aAlpha;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (330.0 / max(0.05, -mv.z));
  gl_Position = projectionMatrix * mv;
}`;
const P_FRAG = `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float a = smoothstep(0.25, 0.0, r2);
  gl_FragColor = vec4(vColor, vAlpha * a);
}`;

class Sparks {
  constructor(scene, count = 340) {
    this.n = count;
    this.pos = new Float32Array(count * 3);
    this.col = new Float32Array(count * 3);
    this.siz = new Float32Array(count);
    this.alp = new Float32Array(count);
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.max = new Float32Array(count);
    this.grav = new Float32Array(count);
    this.drag = new Float32Array(count);
    this.base = new Float32Array(count);
    this.head = 0;
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    this.aSiz = new THREE.BufferAttribute(this.siz, 1).setUsage(THREE.DynamicDrawUsage);
    this.aAlp = new THREE.BufferAttribute(this.alp, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('aColor', this.aCol);
    g.setAttribute('aSize', this.aSiz);
    g.setAttribute('aAlpha', this.aAlp);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const m = new THREE.ShaderMaterial({
      vertexShader: P_VERT, fragmentShader: P_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    scene.add(this.points);
    this.alive = 0;
  }
  spawn(x, y, z, vx, vy, vz, color, size, life, gravity, drag) {
    const i = this.head;
    this.head = (this.head + 1) % this.n;
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    _col.set(color);
    this.col[i3] = _col.r; this.col[i3 + 1] = _col.g; this.col[i3 + 2] = _col.b;
    this.base[i] = size;
    this.siz[i] = size;
    this.alp[i] = 1;
    this.life[i] = life;
    this.max[i] = life;
    this.grav[i] = gravity === undefined ? 9 : gravity;
    this.drag[i] = drag === undefined ? 1.6 : drag;
    this.alive++;
  }
  burst(p, count, opts) {
    const o = opts || {};
    const speed = o.speed || 2.4;
    const up = o.up === undefined ? 0.6 : o.up;
    const spread = o.spread === undefined ? 1 : o.spread;
    for (let i = 0; i < count; i++) {
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(clamp(1 - Math.random() * (1 + spread), -1, 1));
      const s = speed * (0.35 + Math.random() * 0.9);
      const vx = Math.sin(ph) * Math.cos(th) * s;
      const vz = Math.sin(ph) * Math.sin(th) * s;
      const vy = Math.cos(ph) * s + up * speed * Math.random();
      const c = typeof o.color === 'function' ? o.color(i) : (o.color === undefined ? 0xffffff : o.color);
      this.spawn(
        p.x + rand(-0.05, 0.05) * spread, p.y + rand(-0.05, 0.05), p.z + rand(-0.05, 0.05) * spread,
        vx, vy, vz, c,
        (o.size || 0.12) * rand(0.6, 1.5),
        (o.life || 0.8) * rand(0.7, 1.35),
        o.gravity === undefined ? 8 : o.gravity,
        o.drag === undefined ? 1.5 : o.drag);
    }
  }
  update(dt) {
    if (this.alive <= 0) return;
    const n = this.n;
    let any = 0;
    for (let i = 0; i < n; i++) {
      const l = this.life[i];
      if (l <= 0) continue;
      const nl = l - dt;
      const i3 = i * 3;
      if (nl <= 0) {
        this.life[i] = 0; this.alp[i] = 0; this.siz[i] = 0;
        continue;
      }
      any++;
      this.life[i] = nl;
      const d = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i3] *= d;
      this.vel[i3 + 1] = this.vel[i3 + 1] * d - this.grav[i] * dt;
      this.vel[i3 + 2] *= d;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      const k = nl / this.max[i];
      this.alp[i] = k * k * (3 - 2 * k);
      this.siz[i] = this.base[i] * (0.35 + 0.65 * k);
    }
    this.alive = any;
    this.aPos.needsUpdate = true;
    this.aCol.needsUpdate = true;
    this.aSiz.needsUpdate = true;
    this.aAlp.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- ripple rings
class Ripples {
  constructor(scene, count = 7) {
    this.items = [];
    const g = G('ripple', () => {
      const r = new THREE.RingGeometry(0.78, 1.0, 28, 1);
      r.rotateX(-Math.PI / 2);
      return r;
    });
    for (let i = 0; i < count; i++) {
      const m = new THREE.MeshBasicMaterial({
        color: 0xcfeaff, transparent: true, opacity: 0, depthWrite: false,
        side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(g, m);
      mesh.visible = false;
      mesh.renderOrder = 4;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.items.push({ mesh, mat: m, t: 0, dur: 1, r0: 0.2, r1: 2, op: 0.6 });
    }
    this.next = 0;
  }
  spawn(x, y, z, r0, r1, dur, color, op) {
    const it = this.items[this.next];
    this.next = (this.next + 1) % this.items.length;
    it.mesh.position.set(x, y + 0.02, z);
    it.mesh.scale.setScalar(r0);
    it.mesh.visible = true;
    it.mat.color.set(color === undefined ? 0xcfeaff : color);
    it.mat.opacity = op === undefined ? 0.55 : op;
    it.t = 0; it.dur = dur; it.r0 = r0; it.r1 = r1; it.op = op === undefined ? 0.55 : op;
  }
  update(dt) {
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (!it.mesh.visible) continue;
      it.t += dt;
      const k = it.t / it.dur;
      if (k >= 1) { it.mesh.visible = false; it.mat.opacity = 0; continue; }
      const e = 1 - Math.pow(1 - k, 2.2);
      it.mesh.scale.setScalar(lerp(it.r0, it.r1, e));
      it.mat.opacity = it.op * (1 - k) * (1 - k);
    }
  }
  hide() { for (const it of this.items) { it.mesh.visible = false; it.mat.opacity = 0; } }
}

// ---------------------------------------------------------------- bobber
const BAIT_LOOK = {
  worms: { c: 0xd97a3a, glow: 0 },
  shrimp: { c: 0xff9a7a, glow: 0 },
  squidbait: { c: 0xb887e0, glow: 0x30104a },
  glowbait: { c: 0x66ffcc, glow: 0x22aa88 },
  voidbait: { c: 0x9a4aff, glow: 0x5511bb },
};
const BAIT_DEFAULT = { c: 0xf0f0e8, glow: 0 };

function buildBobber() {
  const g = new THREE.Group();
  const R = 0.105;
  const topMat = new THREE.MeshStandardMaterial({ color: 0xf4f2ec, roughness: 0.55, metalness: 0.0, flatShading: false });
  const botMat = new THREE.MeshStandardMaterial({ color: 0xe0402a, roughness: 0.5, metalness: 0.0 });
  const stripeMat = new THREE.MeshStandardMaterial({ color: 0xd97a3a, roughness: 0.4, emissive: 0x000000, emissiveIntensity: 1.2 });

  const top = new THREE.Mesh(hemi(R, true), topMat);
  const bot = new THREE.Mesh(hemi(R, false), botMat);
  g.add(top, bot);

  const ring = new THREE.Mesh(tor(R * 0.99, 0.016, 6, 16), stripeMat);
  ring.rotation.x = Math.PI / 2;
  g.add(ring);

  const collar = new THREE.Mesh(cyl(R * 0.42, R * 0.5, 0.05, 10), botMat);
  collar.position.y = R * 0.86;
  g.add(collar);

  const antMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2e, roughness: 0.6 });
  const ant = new THREE.Mesh(cyl(0.008, 0.012, 0.16, 6), antMat);
  ant.position.y = R * 0.86 + 0.08;
  g.add(ant);

  const tipMat = new THREE.MeshStandardMaterial({ color: 0xd97a3a, roughness: 0.3, emissive: 0x000000, emissiveIntensity: 1.6 });
  const tip = new THREE.Mesh(sph(0.026, 8, 6), tipMat);
  tip.position.y = R * 0.86 + 0.17;
  g.add(tip);

  const eye = new THREE.Mesh(tor(0.026, 0.007, 5, 10), antMat);
  eye.position.y = -R * 0.95;
  eye.rotation.x = Math.PI / 2;
  g.add(eye);

  g.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  g.userData.stripeMat = stripeMat;
  g.userData.tipMat = tipMat;
  g.userData.radius = R;
  return g;
}

// ---------------------------------------------------------------- rods
const ROD_CONF = {
  1: {
    label: 'Driftwood Rod',
    grip: 0.26, segs: [0.56, 0.46, 0.34], r0: 0.028, r1: 0.0065, crooked: 0.11,
    body: { color: 0x8f7048, roughness: 0.95, metalness: 0.0, flatShading: true, map: 'wood' },
    gripKind: 'twine', gripColor: 0xd9c396,
    reel: 'none', guides: 3, guideColor: 0x6a563a, guideGlow: 0,
    accent: 0x6b4f30, lineColor: 0xeadfc4, lineOpacity: 0.72, stiffness: 0.75,
  },
  2: {
    label: 'Fiberglass Rod',
    grip: 0.30, segs: [0.62, 0.52, 0.40], r0: 0.024, r1: 0.005, crooked: 0,
    body: { color: 0xf3f1ea, roughness: 0.32, metalness: 0.05, flatShading: false },
    gripKind: 'cork', gripColor: 0xd8b47a,
    reel: 'spin', reelBody: 0x24262b, reelMetal: 0xcfd4da,
    guides: 4, guideColor: 0x1c1e22, guideGlow: 0,
    accent: 0xd8382c, lineColor: 0xeef4f8, lineOpacity: 0.8, stiffness: 0.95,
  },
  3: {
    label: 'Carbon Rod',
    grip: 0.30, segs: [0.70, 0.58, 0.44], r0: 0.023, r1: 0.0045, crooked: 0,
    body: { color: 0x15181d, roughness: 0.24, metalness: 0.45, flatShading: false },
    gripKind: 'foam', gripColor: 0x22262c,
    reel: 'spin', reelBody: 0x101318, reelMetal: 0x9fb6c8,
    guides: 5, guideColor: 0x0e1013, guideGlow: 0,
    accent: 0x2f9fe8, lineColor: 0xbfe6ff, lineOpacity: 0.85, stiffness: 1.15,
  },
  4: {
    label: 'Deepline Rod',
    grip: 0.34, segs: [0.74, 0.62, 0.48], r0: 0.030, r1: 0.0065, crooked: 0,
    body: { color: 0x3b4148, roughness: 0.42, metalness: 0.85, flatShading: true },
    gripKind: 'wrap', gripColor: 0x1b1d20,
    reel: 'drum', reelBody: 0x2b2f34, reelMetal: 0xc9a227,
    guides: 5, guideColor: 0xc9a227, guideGlow: 0,
    accent: 0xc9a227, lineColor: 0xd8e2c8, lineOpacity: 0.9, stiffness: 1.4,
  },
  5: {
    label: 'Mythline Rod',
    grip: 0.32, segs: [0.80, 0.68, 0.54], r0: 0.026, r1: 0.005, crooked: 0,
    body: { color: 0x120e1c, roughness: 0.18, metalness: 0.7, flatShading: false, map: 'weave' },
    gripKind: 'wrap', gripColor: 0x0d0a14,
    reel: 'myth', reelBody: 0x14101e, reelMetal: 0xcfe6f2,
    guides: 6, guideColor: 0x66f6ff, guideGlow: 0x2ad8ff,
    accent: 0x66f6ff, lineColor: 0x9ff6ff, lineOpacity: 1.0, stiffness: 1.7, trail: true,
  },
};

function mkMat(o) {
  const m = new THREE.MeshStandardMaterial({
    color: o.color,
    roughness: o.roughness === undefined ? 0.7 : o.roughness,
    metalness: o.metalness === undefined ? 0 : o.metalness,
    flatShading: !!o.flatShading,
    emissive: o.emissive === undefined ? 0x000000 : o.emissive,
  });
  if (o.emissiveIntensity !== undefined) m.emissiveIntensity = o.emissiveIntensity;
  if (o.map === 'wood') m.map = woodTex();
  if (o.map === 'cork') m.map = corkTex();
  if (o.map === 'weave') m.map = weaveTex();
  return m;
}

// Builds one rod. Rod axis is local +Y (butt at origin), the reel hangs on
// local -Z. Returns refs the runtime animates.
function buildRod(level) {
  const cf = ROD_CONF[level] || ROD_CONF[1];
  const root = new THREE.Group();
  root.name = 'rod' + level;

  const bodyMat = mkMat(cf.body);
  const accentMat = mkMat({ color: cf.accent, roughness: 0.3, metalness: 0.4, emissive: cf.guideGlow ? cf.accent : 0x000000, emissiveIntensity: cf.guideGlow ? 0.9 : 0 });
  const darkMat = mkMat({ color: 0x1a1c20, roughness: 0.6, metalness: 0.2 });
  const metalMat = mkMat({ color: cf.reelMetal || 0xb8c2cc, roughness: 0.3, metalness: 0.9 });
  const guideMat = cf.guideGlow
    ? new THREE.MeshBasicMaterial({ color: cf.guideColor })
    : mkMat({ color: cf.guideColor, roughness: 0.35, metalness: 0.6 });

  // ---- grip
  const gripLen = cf.grip;
  const gripGroup = new THREE.Group();
  root.add(gripGroup);
  if (cf.gripKind === 'twine') {
    const core = new THREE.Mesh(cyl(cf.r0 * 0.95, cf.r0 * 1.08, gripLen, 8), bodyMat);
    core.position.y = gripLen * 0.5;
    gripGroup.add(core);
    const twineMat = mkMat({ color: cf.gripColor, roughness: 0.95, flatShading: true });
    for (let i = 0; i < 7; i++) {
      const r = new THREE.Mesh(tor(cf.r0 * 1.05, 0.011, 5, 10), twineMat);
      r.position.y = gripLen * 0.16 + i * (gripLen * 0.1);
      r.rotation.x = Math.PI / 2;
      r.rotation.z = i * 0.4;
      gripGroup.add(r);
    }
  } else if (cf.gripKind === 'cork') {
    const core = new THREE.Mesh(cyl(cf.r0 * 1.25, cf.r0 * 1.5, gripLen, 12), mkMat({ color: cf.gripColor, roughness: 0.9, map: 'cork' }));
    core.position.y = gripLen * 0.5;
    gripGroup.add(core);
    const butt = new THREE.Mesh(sph(cf.r0 * 1.5, 10, 6), darkMat);
    butt.scale.y = 0.55;
    gripGroup.add(butt);
    const band = new THREE.Mesh(cyl(cf.r0 * 1.35, cf.r0 * 1.35, 0.035, 12), accentMat);
    band.position.y = gripLen * 0.92;
    gripGroup.add(band);
  } else if (cf.gripKind === 'foam') {
    const a = new THREE.Mesh(cyl(cf.r0 * 1.3, cf.r0 * 1.5, gripLen * 0.45, 12), mkMat({ color: cf.gripColor, roughness: 0.95 }));
    a.position.y = gripLen * 0.22;
    const b = new THREE.Mesh(cyl(cf.r0 * 1.15, cf.r0 * 1.3, gripLen * 0.4, 12), mkMat({ color: cf.gripColor, roughness: 0.95 }));
    b.position.y = gripLen * 0.82;
    gripGroup.add(a, b);
    for (let i = 0; i < 3; i++) {
      const th = new THREE.Mesh(tor(cf.r0 * 1.32, 0.006, 5, 12), accentMat);
      th.position.y = gripLen * (0.5 + i * 0.055);
      th.rotation.x = Math.PI / 2;
      gripGroup.add(th);
    }
  } else { // wrap
    const core = new THREE.Mesh(cyl(cf.r0 * 1.2, cf.r0 * 1.42, gripLen, 12), mkMat({ color: cf.gripColor, roughness: 0.85, metalness: 0.15 }));
    core.position.y = gripLen * 0.5;
    gripGroup.add(core);
    const butt = new THREE.Mesh(cyl(cf.r0 * 1.55, cf.r0 * 1.55, 0.04, 12), metalMat);
    gripGroup.add(butt);
    for (let i = 0; i < 5; i++) {
      const w = new THREE.Mesh(tor(cf.r0 * 1.3, 0.008, 5, 12), i % 2 ? metalMat : accentMat);
      w.position.y = gripLen * (0.2 + i * 0.15);
      w.rotation.x = Math.PI / 2;
      gripGroup.add(w);
    }
  }

  // ---- blank (3 bendable segments)
  const segs = cf.segs;
  const blank = segs[0] + segs[1] + segs[2];
  const radAt = s => lerp(cf.r0 * 0.92, cf.r1, clamp(s / blank, 0, 1));
  const pivots = [];
  let parent = root;
  let acc = 0;
  const seed = level * 7.31;
  for (let i = 0; i < 3; i++) {
    const p = new THREE.Group();
    p.position.y = i === 0 ? gripLen : segs[i - 1];
    if (cf.crooked && i > 0) {
      p.rotation.z = Math.sin(seed + i * 2.1) * cf.crooked;
      p.rotation.x = Math.cos(seed + i * 1.4) * cf.crooked * 0.7;
    }
    p.userData.rest = p.quaternion.clone();
    parent.add(p);
    const L = segs[i];
    const mesh = new THREE.Mesh(cyl(radAt(acc + L), radAt(acc), L, cf.crooked ? 7 : 10), bodyMat);
    mesh.position.y = L * 0.5;
    mesh.castShadow = true;
    p.add(mesh);
    if (cf.crooked) {
      for (let k = 0; k < 2; k++) {
        const knot = new THREE.Mesh(sph(radAt(acc) * (0.9 + Math.random() * 0.5), 6, 5), bodyMat);
        knot.position.set(radAt(acc) * 0.5, L * (0.25 + k * 0.45), 0);
        knot.scale.set(1, 0.6, 0.8);
        knot.rotation.z = rand(-1, 1);
        p.add(knot);
      }
    }
    if (!cf.crooked && level >= 2) {
      const band = new THREE.Mesh(cyl(radAt(acc) * 1.14, radAt(acc) * 1.18, 0.026, 10), accentMat);
      band.position.y = 0.012;
      p.add(band);
    }
    pivots.push(p);
    parent = p;
    acc += L;
  }
  const tip = new THREE.Object3D();
  tip.position.y = segs[2];
  pivots[2].add(tip);
  const tipCap = new THREE.Mesh(sph(cf.r1 * 1.6, 6, 5), cf.guideGlow ? guideMat : metalMat);
  tip.add(tipCap);

  // ---- guides (line rings on the -Z face)
  const guides = [];
  const nG = cf.guides;
  for (let i = 0; i < nG; i++) {
    const f = (i + 1) / (nG + 0.35);
    const s = blank * f;
    let segIdx = 0, local = s;
    if (local > segs[0]) { local -= segs[0]; segIdx = 1; }
    if (segIdx === 1 && local > segs[1]) { local -= segs[1]; segIdx = 2; }
    const r = radAt(s);
    const gr = lerp(0.036, 0.014, f);
    const holder = new THREE.Group();
    holder.position.set(0, local, -(r + gr * 0.65));
    const ring = new THREE.Mesh(tor(gr, gr * 0.19, 5, 12), guideMat);
    ring.rotation.x = Math.PI / 2;
    holder.add(ring);
    const strut = new THREE.Mesh(bx(gr * 0.22, gr * 0.5, r + gr * 0.7), cf.guideGlow ? guideMat : darkMat);
    strut.position.z = (r + gr * 0.7) * 0.5;
    holder.add(strut);
    if (cf.guideGlow) {
      const halo = new THREE.Mesh(tor(gr * 1.5, gr * 0.42, 4, 12), new THREE.MeshBasicMaterial({
        color: cf.guideGlow, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      halo.rotation.x = Math.PI / 2;
      holder.add(halo);
      guides.push(halo);
    }
    pivots[segIdx].add(holder);
  }

  // ---- reel
  let rotor = null, crank = null, lamp = null, lampHalo = null;
  if (cf.reel !== 'none') {
    const reel = new THREE.Group();
    const gy = gripLen * 0.62;
    reel.position.set(0, gy, -0.05);
    root.add(reel);
    const bodyM = mkMat({ color: cf.reelBody, roughness: 0.35, metalness: 0.6 });

    const foot = new THREE.Mesh(bx(0.022, 0.07, 0.05), bodyM);
    foot.position.set(0, 0.012, 0.018);
    reel.add(foot);

    if (cf.reel === 'spin') {
      const stem = new THREE.Mesh(cyl(0.016, 0.02, 0.06, 8), bodyM);
      stem.position.y = -0.03;
      reel.add(stem);
      const body = new THREE.Mesh(cyl(0.03, 0.034, 0.052, 12), bodyM);
      body.rotation.z = Math.PI / 2;
      body.position.y = -0.062;
      reel.add(body);
      rotor = new THREE.Group();
      rotor.position.set(0, -0.062, -0.035);
      reel.add(rotor);
      const cup = new THREE.Mesh(cyl(0.046, 0.04, 0.028, 14), mkMat({ color: cf.reelMetal, roughness: 0.28, metalness: 0.95 }));
      cup.rotation.z = Math.PI / 2;
      rotor.add(cup);
      const arm = new THREE.Mesh(tor(0.048, 0.005, 4, 14), metalMat);
      arm.rotation.y = Math.PI / 2;
      rotor.add(arm);
      const spool = new THREE.Mesh(cyl(0.033, 0.033, 0.03, 14), mkMat({ color: 0xdfe6ec, roughness: 0.5, metalness: 0.2 }));
      spool.rotation.z = Math.PI / 2;
      spool.position.x = -0.008;
      rotor.add(spool);
      crank = new THREE.Group();
      crank.position.set(0.05, -0.062, -0.02);
      reel.add(crank);
      const cArm = new THREE.Mesh(bx(0.008, 0.05, 0.008), metalMat);
      cArm.position.y = 0.025;
      crank.add(cArm);
      const knob = new THREE.Mesh(sph(0.014, 8, 6), mkMat({ color: cf.accent, roughness: 0.4, metalness: 0.3 }));
      knob.position.y = 0.052;
      crank.add(knob);
    } else if (cf.reel === 'drum') {
      const brass = mkMat({ color: cf.reelMetal, roughness: 0.28, metalness: 1.0 });
      const drum = new THREE.Mesh(cyl(0.05, 0.05, 0.088, 16), brass);
      drum.rotation.z = Math.PI / 2;
      drum.position.y = -0.045;
      reel.add(drum);
      rotor = new THREE.Group();
      rotor.position.y = -0.045;
      reel.add(rotor);
      for (let i = 0; i < 5; i++) {
        const rib = new THREE.Mesh(tor(0.052, 0.005, 4, 14), bodyM);
        rib.rotation.y = Math.PI / 2;
        rib.position.x = -0.035 + i * 0.0175;
        rotor.add(rib);
      }
      const lineDrum = new THREE.Mesh(cyl(0.042, 0.042, 0.06, 14), mkMat({ color: 0x9aa27a, roughness: 0.8 }));
      lineDrum.rotation.z = Math.PI / 2;
      rotor.add(lineDrum);
      for (const sx of [-0.048, 0.048]) {
        const plate = new THREE.Mesh(cyl(0.056, 0.056, 0.006, 16), brass);
        plate.rotation.z = Math.PI / 2;
        plate.position.set(sx, -0.045, 0);
        reel.add(plate);
      }
      crank = new THREE.Group();
      crank.position.set(0.058, -0.045, 0);
      reel.add(crank);
      const cArm = new THREE.Mesh(bx(0.01, 0.062, 0.012), brass);
      cArm.position.y = 0.031;
      crank.add(cArm);
      const knob = new THREE.Mesh(cyl(0.014, 0.014, 0.03, 8), mkMat({ color: 0x2a2018, roughness: 0.85 }));
      knob.position.y = 0.062;
      knob.rotation.z = Math.PI / 2;
      crank.add(knob);
      // little green status lamp
      lamp = new THREE.Mesh(sph(0.014, 8, 6), new THREE.MeshBasicMaterial({ color: 0x4dffa0 }));
      lamp.position.set(-0.03, 0.028, -0.03);
      reel.add(lamp);
      lampHalo = new THREE.Mesh(sph(0.036, 8, 6), new THREE.MeshBasicMaterial({
        color: 0x33ff88, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      lampHalo.position.copy(lamp.position);
      reel.add(lampHalo);
      const cage = new THREE.Mesh(tor(0.02, 0.004, 4, 10), brass);
      cage.position.copy(lamp.position);
      cage.rotation.x = Math.PI / 2;
      reel.add(cage);
    } else { // myth
      const shell = new THREE.Mesh(cyl(0.042, 0.046, 0.05, 16), mkMat({ color: cf.reelBody, roughness: 0.18, metalness: 0.85 }));
      shell.rotation.z = Math.PI / 2;
      shell.position.y = -0.052;
      reel.add(shell);
      rotor = new THREE.Group();
      rotor.position.y = -0.052;
      reel.add(rotor);
      const core = new THREE.Mesh(cyl(0.03, 0.03, 0.056, 14), new THREE.MeshBasicMaterial({ color: 0x66f6ff }));
      core.rotation.z = Math.PI / 2;
      rotor.add(core);
      const halo = new THREE.Mesh(cyl(0.042, 0.042, 0.05, 14), new THREE.MeshBasicMaterial({
        color: 0x2ad8ff, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      halo.rotation.z = Math.PI / 2;
      rotor.add(halo);
      for (let i = 0; i < 4; i++) {
        const fin = new THREE.Mesh(bx(0.052, 0.012, 0.03), mkMat({ color: cf.reelMetal, roughness: 0.2, metalness: 0.95 }));
        fin.rotation.x = i * Math.PI / 4;
        rotor.add(fin);
      }
      crank = new THREE.Group();
      crank.position.set(0.05, -0.052, 0);
      reel.add(crank);
      const cArm = new THREE.Mesh(bx(0.007, 0.052, 0.009), mkMat({ color: cf.reelMetal, roughness: 0.2, metalness: 0.95 }));
      cArm.position.y = 0.026;
      crank.add(cArm);
      const knob = new THREE.Mesh(sph(0.013, 8, 6), new THREE.MeshBasicMaterial({ color: 0x66f6ff }));
      knob.position.y = 0.052;
      crank.add(knob);
      lampHalo = new THREE.Mesh(sph(0.05, 8, 6), new THREE.MeshBasicMaterial({
        color: 0x2ad8ff, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      lampHalo.position.y = -0.052;
      reel.add(lampHalo);
    }
  }

  root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; o.frustumCulled = false; } });

  return {
    group: root, pivots, tip, guides, rotor, crank, lamp, lampHalo,
    conf: cf, length: gripLen + blank,
  };
}

// ---------------------------------------------------------------- main module
export function initFishing(ctx) {
  const scene = ctx.scene;
  const bus = ctx.bus;
  const state = ctx.state;

  const sparks = new Sparks(scene, 340);
  const ripples = new Ripples(scene, 8);

  // ---- bobber -------------------------------------------------
  const bobber = buildBobber();
  bobber.visible = false;
  scene.add(bobber);

  // ---- line ---------------------------------------------------
  const LINE_PTS = 14;
  const linePos = new Float32Array(LINE_PTS * 3);
  const lineGeo = new THREE.BufferGeometry();
  const lineAttr = new THREE.BufferAttribute(linePos, 3).setUsage(THREE.DynamicDrawUsage);
  lineGeo.setAttribute('position', lineAttr);
  lineGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  const lineMat = new THREE.LineBasicMaterial({ color: 0xeadfc4, transparent: true, opacity: 0.75, depthWrite: false });
  const lineObj = new THREE.Line(lineGeo, lineMat);
  lineObj.frustumCulled = false;
  lineObj.renderOrder = 5;
  lineObj.visible = false;
  scene.add(lineObj);

  // ---- fullscreen flash (billboard pinned in front of the camera) ----
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xffd77a, transparent: true, opacity: 0, depthTest: false, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const flash = new THREE.Mesh(G('flashPlane', () => new THREE.PlaneGeometry(1, 1)), flashMat);
  flash.renderOrder = 999;
  flash.frustumCulled = false;
  flash.visible = false;
  scene.add(flash);

  // ---- runtime state ------------------------------------------
  const F = {
    phase: 'idle', // idle|charging|flying|waiting|hooking|reeling|resolving|celebrating|retracting
    time: 0,
    clockT: 0,     // ctx.clock elapsed time, shared with water.js
    animTime: 0,
    bobRetracting: false,
    timeScale: 1,
    timeScaleTarget: 1,

    rods: {},          // level -> built rod
    rod: null,         // active rod refs
    rodLevel: 0,
    attachedTo: null,  // handR object we parented to
    attachedChar: null,
    rodQuat: new THREE.Quaternion(),
    rodQuatInit: false,
    bendAmount: 0,
    reelSpin: 0,

    power: 0,
    castDist: 0,
    aim: new THREE.Vector3(0, 0, 1),

    bobPos: new THREE.Vector3(),
    bobVel: new THREE.Vector3(),
    bobYank: 0,
    bobSpin: 0,
    flightT: 0,
    rippleTimer: 0,
    splashTimer: 0,

    areaId: null,
    serverCast: false,
    noAreaTimer: 0,
    hookTimer: 0,
    resolveTimer: 0,

    // reel minigame
    tension: 0,
    sweetA: 0.35,
    sweetB: 0.65,
    progress: 0,
    pegged: 0,
    strength: 0.4,
    jerk: 0,
    jerkTarget: 0,
    jerkTimer: 0,
    reelClock: 0,
    reelSfxTimer: 0,
    reelAnchor: new THREE.Vector3(),
    trailT: 0,
    celSpark: 0,
    slowTimer: 0,
    retractDur: 0.3,

    // celebration
    celT: 0,
    celDur: 2.5,
    celFish: null,
    celData: null,
    celFrom: new THREE.Vector3(),
    celScale: 1,
    baseFov: 0,
    fovActive: false,

    retractT: 0,
    retractFrom: new THREE.Vector3(),

    shake: 0,
    shakeSeed: 0,
    camOffset: new THREE.Vector3(),
    camLeft: new THREE.Vector3(),
    camTracked: false,

    // input edges
    lmbPrev: false,
    lmbLocal: false,
    rmbQueued: false,
    keyRPrev: false,

    powerMsg: { p: 0 },
    reelMsg: { tension: 0, sweet: [0.35, 0.65], progress: 0 },
    lastBaitLook: null,
  };

  // ---------------------------------------------------------- helpers
  function sfx(name, opts) {
    const a = ctx.audio;
    if (a && typeof a.sfx === 'function') { try { a.sfx(name, opts); } catch (e) { /* audio not ready */ } }
  }
  // audio.js pans/attenuates by {pos}; give the water cues a place in the world
  const _sfxPos = [0, 0, 0];
  const _sfxOpt = { vol: 1, pos: _sfxPos };
  function atBobber(vol) {
    _sfxPos[0] = F.bobPos.x; _sfxPos[1] = F.bobPos.y; _sfxPos[2] = F.bobPos.z;
    _sfxOpt.vol = vol === undefined ? 1 : vol;
    return _sfxOpt;
  }
  function toast(text, kind) {
    const ui = ctx.ui;
    if (ui && typeof ui.toast === 'function') { try { ui.toast(text, kind); return; } catch (e) { /* fallthrough */ } }
    if (bus) bus.emit('toast', { text, kind: kind || 'info' });
  }
  function waterY(x, z) {
    const f = ctx.getWaterHeight;
    if (typeof f !== 'function') return 0;
    // sample with the SAME clock water.js animates on (seconds since page load)
    const y = f(x, z, F.clockT);
    return (typeof y === 'number' && isFinite(y)) ? y : 0;
  }
  function terrainY(x, z) {
    const w = ctx.world;
    if (w && typeof w.getTerrainHeight === 'function') {
      const y = w.getTerrainHeight(x, z);
      if (typeof y === 'number' && isFinite(y)) return y;
    }
    return -99;
  }
  function doSplash(pos, size) {
    const w = ctx.water;
    if (w && typeof w.splash === 'function') { try { w.splash(pos, size); } catch (e) { /* water not ready */ } }
  }
  function isDriver() {
    if (state.onBoat && state.seat === 0) return true;
    const b = ctx.boat;
    if (b && typeof b.isDriver === 'function') { try { return !!b.isDriver(); } catch (e) { return false; } }
    return false;
  }
  function localChar() {
    const pm = ctx.playerMod;
    if (!pm || !pm.local) return null;
    return pm.local.char || null;
  }
  function setAnim(name) {
    const c = localChar();
    if (c && typeof c.setAnim === 'function') { try { c.setAnim(name); } catch (e) { /* ignore */ } }
  }
  function nearestArea(x, z) {
    let best = null, bd = Infinity;
    for (let i = 0; i < AREAS.length; i++) {
      const a = AREAS[i];
      const dx = x - a.center[0], dz = z - a.center[1];
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < a.radius && d < bd) { bd = d; best = a; }
    }
    return best;
  }
  function normStrength(raw) {
    let s = typeof raw === 'number' && isFinite(raw) ? raw : 0.5;
    if (s > 1.0001) s = (s - 1) / 9;      // servers sending 1..10
    return clamp(s, 0, 1);
  }
  function baitLook() {
    const id = state.gear && state.gear.activeBait;
    return (id && BAIT_LOOK[id]) || BAIT_DEFAULT;
  }
  function tipWorld(out) {
    if (F.rod && F.rod.group.parent) {
      F.rod.tip.getWorldPosition(out);
      return true;
    }
    const c = localChar();
    if (c && c.group) {
      out.copy(c.group.position); out.y += 1.55;
      return true;
    }
    if (ctx.camera) { ctx.camera.getWorldPosition(out); out.y -= 0.35; return true; }
    out.set(0, 1.5, 0);
    return false;
  }

  // ---------------------------------------------------------- rod handling
  function ensureRod() {
    const c = localChar();
    const hand = c && c.bones ? c.bones.handR : null;
    const want = clamp(Math.round((state.gear && state.gear.rod) || 1), 1, 5);

    if (!hand) {
      if (F.rod) F.rod.group.visible = false;
      return;
    }
    if (F.rodLevel !== want || !F.rod) {
      if (F.rod && F.rod.group.parent) F.rod.group.parent.remove(F.rod.group);
      let r = F.rods[want];
      if (!r) { r = buildRod(want); F.rods[want] = r; }
      F.rod = r;
      F.rodLevel = want;
      F.attachedTo = null;
      F.rodQuatInit = false;
      lineMat.color.set(r.conf.lineColor);
      lineMat.opacity = r.conf.lineOpacity;
    }
    if (F.attachedTo !== hand || F.attachedChar !== c) {
      hand.add(F.rod.group);
      F.attachedTo = hand;
      F.attachedChar = c;
      F.rodQuatInit = false;
    }
  }

  // Orient the rod in the hand so it always points along the aim, no matter
  // what local axis convention the character rig uses.
  function orientRod(dt) {
    const rod = F.rod;
    if (!rod || !F.attachedTo) return;
    const cam = ctx.camera;
    if (!cam) return;

    cam.getWorldDirection(_v1);
    _v1.y = 0;
    if (_v1.lengthSq() < 1e-6) _v1.set(0, 0, 1);
    _v1.normalize();

    // desired world direction of the rod's +Y axis, per phase
    let fwd = 0.62, up = 0.79;
    if (F.phase === 'charging') { fwd = -0.30 - F.power * 0.22; up = 0.95; }
    else if (F.phase === 'flying') { fwd = 0.92; up = 0.36; }
    else if (F.phase === 'waiting' || F.phase === 'hooking') { fwd = 0.72; up = 0.70; }
    else if (F.phase === 'reeling') { fwd = 0.44; up = 0.90; }
    else if (F.phase === 'celebrating') { fwd = 0.20; up = 0.98; }
    const wob = Math.sin(F.animTime * 1.7) * 0.02 + Math.sin(F.animTime * 0.9 + 1.1) * 0.015;
    _v2.set(_v1.x * fwd, up + wob, _v1.z * fwd).normalize();

    // to hand-local space, then build a right-handed basis whose +Y is the rod
    // axis and whose -Z faces the ground (that is where the reel + guides sit).
    F.attachedTo.getWorldQuaternion(_q1);
    _q2.copy(_q1).invert();
    _v3.copy(_v2).applyQuaternion(_q2).normalize();     // rod axis (hand-local)
    _v4.set(0, 1, 0).applyQuaternion(_q2).normalize();  // world-up (hand-local)
    _v5.crossVectors(_v3, _v4);                          // x = axis X up
    if (_v5.lengthSq() < 1e-6) {
      _v5.set(1, 0, 0).cross(_v3);
      if (_v5.lengthSq() < 1e-6) _v5.set(0, 0, 1).cross(_v3);
    }
    _v5.normalize();
    _v6.crossVectors(_v5, _v3).normalize();              // z = x X axis (right-handed)
    _m1.makeBasis(_v5, _v3, _v6);
    _q1.setFromRotationMatrix(_m1);

    if (!F.rodQuatInit) { F.rodQuat.copy(_q1); F.rodQuatInit = true; }
    else F.rodQuat.slerp(_q1, clamp(dt * (F.phase === 'flying' ? 22 : 11), 0, 1));
    rod.group.quaternion.copy(F.rodQuat);
  }

  function bendRod(dt) {
    const rod = F.rod;
    if (!rod) return;
    let target = 0;
    if (F.phase === 'charging') target = -0.22 * F.power;
    else if (F.phase === 'flying') target = 0.30;
    else if (F.phase === 'waiting') target = 0.06;
    else if (F.phase === 'hooking') target = 0.34;
    else if (F.phase === 'reeling') target = 0.30 + F.tension * 0.75 + F.jerk * 0.3;
    else if (F.phase === 'retracting') target = 0.16;
    target /= (rod.conf.stiffness || 1);
    F.bendAmount += (target - F.bendAmount) * clamp(dt * 9, 0, 1);

    const amt = F.bendAmount;
    if (Math.abs(amt) < 0.001) {
      for (let i = 1; i < 3; i++) rod.pivots[i].quaternion.copy(rod.pivots[i].userData.rest);
      return;
    }
    // bend toward the bobber (or forward-down when there is none)
    if (bobber.visible) {
      _v7.copy(F.bobPos);
    } else {
      tipWorld(_v7);
      if (ctx.camera) ctx.camera.getWorldDirection(_v8); else _v8.set(0, 0, 1);
      _v7.addScaledVector(_v8, 3);
      _v7.y -= 1.5;
    }
    for (let i = 1; i < 3; i++) {
      const p = rod.pivots[i];
      p.getWorldPosition(_v1);
      p.getWorldQuaternion(_q1);
      _q1.invert();
      _v2.copy(_v7).sub(_v1);
      if (_v2.lengthSq() < 1e-6) _v2.set(0, -1, 0);
      _v2.normalize().applyQuaternion(_q1).normalize();
      const k = clamp(amt * (i === 1 ? 0.42 : 0.72), -0.95, 0.95);
      _v3.set(0, 1, 0).lerp(_v2, Math.abs(k) * (k < 0 ? -0.55 : 1)).normalize();
      _q2.setFromUnitVectors(UP, _v3);
      p.quaternion.copy(_q2).multiply(p.userData.rest);
    }
  }

  function updateRodFx(dt) {
    const rod = F.rod;
    if (!rod) return;
    // reel crank / rotor spin
    let spin = 0;
    if (F.phase === 'reeling') spin = 5 + F.progress * 6 + F.tension * 5;
    else if (F.phase === 'retracting') spin = 16;
    else if (F.phase === 'flying') spin = -9;
    F.reelSpin += spin * dt;
    if (rod.rotor) rod.rotor.rotation.x = F.reelSpin;
    if (rod.crank) rod.crank.rotation.x = F.reelSpin * 0.85;
    if (rod.lampHalo) {
      const puls = 0.5 + 0.5 * Math.sin(F.animTime * (F.phase === 'reeling' ? 9 : 2.2));
      rod.lampHalo.material.opacity = (F.rodLevel === 5 ? 0.10 : 0.16) + puls * 0.22;
      rod.lampHalo.scale.setScalar(1 + puls * 0.18);
    }
    if (rod.guides && rod.guides.length) {
      const g = 0.22 + 0.16 * (0.5 + 0.5 * Math.sin(F.animTime * 3.1));
      for (let i = 0; i < rod.guides.length; i++) rod.guides[i].material.opacity = g;
    }
    // mythline trail
    if (rod.conf.trail && rod.group.visible) {
      F.trailT = (F.trailT || 0) + dt;
      if (F.trailT > 0.045) {
        F.trailT = 0;
        rod.tip.getWorldPosition(_v1);
        sparks.spawn(
          _v1.x + rand(-0.02, 0.02), _v1.y + rand(-0.02, 0.02), _v1.z + rand(-0.02, 0.02),
          rand(-0.15, 0.15), rand(0.05, 0.4), rand(-0.15, 0.15),
          Math.random() < 0.3 ? 0xffffff : 0x66f6ff, 0.055, 0.55, -0.8, 2.2);
      }
    }
  }

  // ---------------------------------------------------------- line drawing
  function updateLine(dt) {
    const rod = F.rod;
    const show = !!rod && rod.group.visible && bobber.visible;
    lineObj.visible = show;
    if (!show) return;
    rod.tip.getWorldPosition(_v1);
    _v2.copy(F.bobPos);
    _v2.y += bobber.userData.radius * 0.6;
    const dist = _v1.distanceTo(_v2);
    let sag = 0.06 * dist;
    if (F.phase === 'reeling') sag *= lerp(0.55, 0.04, F.tension);
    else if (F.phase === 'hooking') sag *= 0.35;
    else if (F.phase === 'flying') sag *= 0.35;
    else if (F.phase === 'retracting') sag *= 0.25;
    sag = clamp(sag, 0.02, 1.6);
    _v3.copy(_v1).add(_v2).multiplyScalar(0.5);
    _v3.y -= sag;
    // side sway for life
    const sway = Math.sin(F.animTime * 2.3) * sag * 0.16;
    _v3.x += sway * 0.4; _v3.z += sway * 0.4;
    for (let i = 0; i < LINE_PTS; i++) {
      const u = i / (LINE_PTS - 1);
      const iu = 1 - u;
      const a = iu * iu, b = 2 * iu * u, c = u * u;
      linePos[i * 3] = a * _v1.x + b * _v3.x + c * _v2.x;
      linePos[i * 3 + 1] = a * _v1.y + b * _v3.y + c * _v2.y;
      linePos[i * 3 + 2] = a * _v1.z + b * _v3.z + c * _v2.z;
    }
    lineAttr.needsUpdate = true;
    lineMat.opacity = rod.conf.lineOpacity * (F.phase === 'reeling' ? 1 : 0.85);
  }

  // ---------------------------------------------------------- bobber visuals
  function refreshBaitLook() {
    const bl = baitLook();
    if (F.lastBaitLook === bl) return;
    F.lastBaitLook = bl;
    bobber.userData.stripeMat.color.set(bl.c);
    bobber.userData.stripeMat.emissive.set(bl.glow);
    bobber.userData.tipMat.color.set(bl.c);
    bobber.userData.tipMat.emissive.set(bl.glow);
  }

  // ---------------------------------------------------------- cast eligibility
  function canStartCast() {
    if (state.phase !== 'playing') return false;
    if (state.activeTool !== 'rod') return false;
    if (!(state.hp > 0)) return false;
    if (state.underwater) return false;
    if (isDriver()) return false;
    return true;
  }

  function aimPoint(out) {
    const cam = ctx.camera;
    if (!cam) { out.set(0, 0, 0); return false; }
    cam.getWorldDirection(_v1);
    cam.getWorldPosition(_v2);
    if (_v1.y < -0.015) {
      const t = -_v2.y / _v1.y;
      if (t > 0.5 && t < 1200) {
        out.copy(_v1).multiplyScalar(t).add(_v2);
        out.y = 0;
        return true;
      }
    }
    _v3.set(_v1.x, 0, _v1.z);
    if (_v3.lengthSq() < 1e-6) _v3.set(0, 0, 1);
    _v3.normalize().multiplyScalar(120);
    out.copy(_v2).add(_v3);
    out.y = 0;
    return false;
  }

  // ---------------------------------------------------------- state changes
  function beginCharge() {
    F.phase = 'charging';
    F.power = 0;
    setAnim('cast');
    sfx('reelIn', { vol: 0.25 });
  }

  function releaseCast() {
    const p = F.power;
    F.powerMsg.p = 0;
    bus.emit('castPower', F.powerMsg);

    if (!canStartCast()) { F.phase = 'idle'; setAnim('idle'); return; }

    tipWorld(_v4);
    aimPoint(_v5);
    _v6.set(_v5.x - _v4.x, 0, _v5.z - _v4.z);
    if (_v6.lengthSq() < 0.25) {
      if (ctx.camera) { ctx.camera.getWorldDirection(_v6); _v6.y = 0; }
      if (_v6.lengthSq() < 1e-6) _v6.set(0, 0, 1);
    }
    _v6.normalize();
    F.aim.copy(_v6);
    const dist = lerp(8, 30, clamp(p, 0, 1));
    F.castDist = dist;

    const lx = _v4.x + _v6.x * dist;
    const lz = _v4.z + _v6.z * dist;

    // dry land = ground standing proud of the local water surface
    if (terrainY(lx, lz) > waterY(lx, lz) + 0.25) {
      toast('That is dry land — aim at the water.', 'warn');
      F.phase = 'idle';
      setAnim('idle');
      sfx('error', { vol: 0.5 });
      return;
    }

    // launch
    const ty = waterY(lx, lz);
    const T = 0.42 + dist * 0.034;
    const Gv = 24;
    F.bobPos.copy(_v4);
    F.bobVel.set((lx - _v4.x) / T, (ty - _v4.y) / T + 0.5 * Gv * T, (lz - _v4.z) / T);
    F.flightT = 0;
    F.phase = 'flying';
    bobber.visible = true;
    bobber.scale.setScalar(1);
    F.bobSpin = 0;
    refreshBaitLook();
    setAnim('cast');
    F.shake = Math.max(F.shake, 0.18 * p);
    F.shakeSeed = Math.random() * 100;
    // 'castStart' fires on RELEASE: that is when the whoosh belongs, when the
    // power meter should vanish and when the cast animation should play.
    // The authoritative MSG.CAST_START goes out when the bobber actually lands.
    const pre = nearestArea(lx, lz);
    bus.emit('castStart', { areaId: pre ? pre.id : null, baitId: (state.gear && state.gear.activeBait) || null });
  }

  function landBobber() {
    F.phase = 'waiting';
    F.bobRetracting = false;
    const wy = waterY(F.bobPos.x, F.bobPos.z);
    F.bobPos.y = wy;
    F.bobVel.set(0, 0, 0);
    F.bobYank = 0.55;
    F.rippleTimer = 0.15;
    doSplash(F.bobPos, 0.7);
    ripples.spawn(F.bobPos.x, wy, F.bobPos.z, 0.15, 1.6, 1.1, 0xdff2ff, 0.6);
    sparks.burst(F.bobPos, 12, { color: 0xcfeaff, speed: 1.7, up: 0.9, size: 0.09, life: 0.5, gravity: 11, spread: 0.4 });
    sfx('plop', atBobber(0.9));
    sfx('bobberSet', atBobber(0.7));
    setAnim('idle');

    const area = nearestArea(F.bobPos.x, F.bobPos.z);
    if (!area) {
      F.areaId = null;
      F.serverCast = false;
      F.noAreaTimer = 3;
      toast('Too quiet here — find a marked fishing area', 'warn');
      return;
    }
    F.areaId = area.id;
    F.noAreaTimer = 0;
    const baitId = (state.gear && state.gear.activeBait) || null;
    if (ctx.net && typeof ctx.net.send === 'function') ctx.net.send(MSG.CAST_START, { areaId: area.id, baitId });
    F.serverCast = true;
  }

  function startRetract(fast) {
    F.phase = 'retracting';
    F.retractT = 0;
    F.retractFrom.copy(F.bobPos);
    F.retractDur = fast ? 0.22 : 0.38;
    F.bobRetracting = bobber.visible;
    F.serverCast = false;
    F.areaId = null;
    F.noAreaTimer = 0;
    F.powerMsg.p = 0;
    bus.emit('castPower', F.powerMsg);
    if (bobber.visible) sfx('reelIn', { vol: 0.45 });
  }

  function cancelCast(reason, silent) {
    if (F.phase === 'idle') return;
    if (F.serverCast && ctx.net && typeof ctx.net.send === 'function') ctx.net.send(MSG.CANCEL_CAST, {});
    F.serverCast = false;
    if (reason && !silent) toast(reason, 'warn');
    endReelHud();
    if (bobber.visible) startRetract(true);
    else { F.phase = 'idle'; setAnim('idle'); }
  }

  function hardReset() {
    F.phase = 'idle';
    F.serverCast = false;
    F.areaId = null;
    bobber.visible = false;
    lineObj.visible = false;
    F.power = 0;
    F.bendAmount = 0;
    F.timeScaleTarget = 1;
    endReelHud();
    F.powerMsg.p = 0;
    bus.emit('castPower', F.powerMsg);
    stowCelebrationFish(true);
    restoreFov();
    ripples.hide();
  }

  function endReelHud() {
    F.reelMsg.tension = 0;
    F.reelMsg.progress = 0;
    F.reelMsg.sweet[0] = 0;
    F.reelMsg.sweet[1] = 0;
    F.reelMsg.active = false;
    bus.emit('reelState', F.reelMsg);
  }

  // ---------------------------------------------------------- bite / hook
  function onBite(payload) {
    if (F.phase !== 'waiting') return;      // also de-dupes double bus emits
    F.strength = normStrength(payload && payload.strength);
    F.phase = 'hooking';
    F.hookTimer = 1.5;
    F.bobYank = 1.4;
    const wy = waterY(F.bobPos.x, F.bobPos.z);
    ripples.spawn(F.bobPos.x, wy, F.bobPos.z, 0.2, 2.6 + F.strength * 2, 0.9, 0xbfe6ff, 0.75);
    ripples.spawn(F.bobPos.x, wy, F.bobPos.z, 0.1, 1.4, 0.55, 0xffffff, 0.5);
    doSplash(F.bobPos, 0.9 + F.strength);
    sparks.burst(F.bobPos, 18, { color: 0xdff4ff, speed: 2.4 + F.strength * 2, up: 1.1, size: 0.1, life: 0.55, gravity: 12, spread: 0.5 });
    // the 'bite' cue itself is audio.js's, fired from the shared bus event
    F.shake = 0.75 + F.strength * 0.45;
    F.shakeSeed = Math.random() * 100;
    setAnim('cast');
  }

  function hookSet() {
    F.phase = 'reeling';
    F.tension = 0.34;
    F.progress = 0;
    F.pegged = 0;
    F.jerk = 0;
    F.jerkTarget = 0;
    F.jerkTimer = 0.4;
    F.reelClock = 0;
    F.reelSfxTimer = 0;
    F.reelAnchor.copy(F.bobPos);
    F.reelMsg.active = true;
    setAnim('reel');
    sfx('hookSet', { strength: F.strength });
    sfx('splash', atBobber(0.8));
    F.shake = 0.45;
    doSplash(F.bobPos, 1.0);
  }

  function missBite() {
    sfx('lineMiss', { vol: 0.9 });
    toast('It got away...', 'warn');
    if (F.serverCast && ctx.net && typeof ctx.net.send === 'function') ctx.net.send(MSG.CANCEL_CAST, {});
    F.serverCast = false;
    startRetract(false);
  }

  function finishReel(success) {
    if (ctx.net && typeof ctx.net.send === 'function') ctx.net.send(MSG.REEL_DONE, { success: !!success });
    F.serverCast = false;         // server closes the cast either way
    F.phase = 'resolving';
    F.resolveTimer = 8;
    endReelHud();
    if (!success) {
      sfx('lineSnap', { vol: 1 });
      toast('The line snapped!', 'bad');
      F.shake = 0.9;
      sparks.burst(F.bobPos, 16, { color: 0xffffff, speed: 3.4, up: 0.8, size: 0.09, life: 0.45, gravity: 10, spread: 0.8 });
      const wy0 = waterY(F.bobPos.x, F.bobPos.z);
      ripples.spawn(F.bobPos.x, wy0, F.bobPos.z, 0.2, 2.6, 0.8, 0xffffff, 0.5);
    } else {
      sfx('reelIn', { vol: 0.8 });
      sfx('splash', atBobber(1));
      doSplash(F.bobPos, 1.6);
      const wy = waterY(F.bobPos.x, F.bobPos.z);
      ripples.spawn(F.bobPos.x, wy, F.bobPos.z, 0.2, 3.4, 1.0, 0xdff4ff, 0.7);
    }
  }

  // ---------------------------------------------------------- catch
  function onCatch(payload) {
    // 'waiting' is accepted too: the server may close a cast it refused.
    if (F.phase !== 'resolving' && F.phase !== 'reeling' && F.phase !== 'hooking' && F.phase !== 'waiting') return;
    F.serverCast = false;
    endReelHud();
    const caught = payload && payload.caught;
    const fish = payload && payload.fish;
    if (!caught || !fish) {
      toast('It slipped the hook...', 'warn');
      sfx('lineMiss', { vol: 0.8 });
      startRetract(false);
      return;
    }
    const def = fishById(fish.fishId);
    const tier = fish.tier || (def && def.tier) || 1;
    const mut = fish.mutation || null;
    const isArtifact = !!(def && def.artifact);
    const legendary = tier >= 10 || isArtifact;

    F.phase = 'celebrating';
    F.celT = 0;
    F.celDur = 2.5;
    F.celData = { fish, def, tier, mut, legendary, isArtifact };
    F.celFrom.copy(bobber.visible ? F.bobPos : (tipWorld(_v1), _v1));
    startRetract(true);
    F.phase = 'celebrating';   // retract handles the bobber; keep the celebration phase

    // build (or reuse) the trophy fish - display length clamped to 0.3 - 1.2 m
    stowCelebrationFish(false);
    if (def) {
      const key = fish.fishId + '|' + (mut || '');
      let entry = trophyCache.get(key);
      if (!entry) {
        const size = (def.model && def.model.size) || 0.5;
        const target = clamp(size, 0.3, 1.2);
        let mesh = null;
        try { mesh = createFishMesh(def, mut, target / size); } catch (e) { mesh = null; }
        if (mesh) {
          mesh.traverse(o => { o.frustumCulled = false; if (o.isMesh) o.castShadow = true; });
          // respect whatever scale convention the factory used
          entry = { mesh, scale: (mesh.scale && mesh.scale.x) || 1 };
          trophyCache.set(key, entry);
          scene.add(mesh);
        }
      }
      if (entry) {
        entry.mesh.visible = true;
        entry.mesh.position.copy(F.celFrom);
        entry.mesh.rotation.set(0, 0, 0);
        entry.mesh.scale.setScalar(entry.scale);
        F.celFish = entry.mesh;
        F.celScale = entry.scale;
      }
    }

    // Fanfare: audio.js already grades it by tier and adds the mutation sting
    // off the shared 'catch' bus event, so firing it here too would double it.
    // What we add is the water noise of the fish breaking the surface.
    sfx('splash', atBobber(clamp(0.7 + tier * 0.06, 0.7, 1.4)));

    const burst = clamp(24 + tier * 11, 24, 150);
    const mCol = mut && MUTATIONS[mut] ? MUTATIONS[mut].tint : null;
    sparks.burst(F.celFrom, burst, {
      color: () => {
        if (mCol && Math.random() < 0.55) return mCol;
        return legendary ? (Math.random() < 0.5 ? 0xffd77a : 0xfff2c0)
          : (Math.random() < 0.5 ? 0xcfeaff : 0xffffff);
      },
      speed: 2.6 + tier * 0.28, up: 1.2, size: 0.1 + tier * 0.008, life: 1.0 + tier * 0.03,
      gravity: 7, spread: 1.0,
    });
    const wy = waterY(F.celFrom.x, F.celFrom.z);
    ripples.spawn(F.celFrom.x, wy, F.celFrom.z, 0.25, 3 + tier * 0.5, 1.2, legendary ? 0xffe4a8 : 0xdff4ff, 0.7);

    if (legendary) {
      flashMat.color.set(isArtifact ? 0xffe0b0 : 0xffd77a);
      flashMat.opacity = 0.85;
      flash.visible = true;
      F.timeScaleTarget = 0.38;
      F.slowTimer = 0.85;
      F.shake = 1.0;
      F.celDur = 3.1;
    } else if (mut) {
      flashMat.color.set(mCol || 0xffffff);
      flashMat.opacity = 0.5;
      flash.visible = true;
      F.shake = 0.55;
    } else {
      F.shake = 0.28;
    }

    // camera framing
    if (ctx.camera && !F.fovActive) {
      F.baseFov = ctx.camera.fov;
      F.fovActive = true;
    }
    // no setAnim here: player.js plays its 'cheer' action off the same event.
  }

  // Trophy meshes are cached per species+mutation and hidden between catches,
  // so we never dispose geometry another module might share.
  const trophyCache = new Map();
  function stowCelebrationFish(clearData) {
    if (F.celFish) {
      F.celFish.visible = false;
      F.celFish = null;
    }
    if (clearData) F.celData = null;
  }

  function restoreFov() {
    if (F.fovActive && ctx.camera) {
      ctx.camera.fov = F.baseFov;
      ctx.camera.updateProjectionMatrix();
    }
    F.fovActive = false;
  }

  // ---------------------------------------------------------- listeners
  // BITE / CAST_RESULT are taken from BOTH the socket and the bus (main.js
  // mirrors them onto the bus). onBite/onCatch are idempotent - they only act
  // from the matching phase - so whichever arrives first wins and the twin is
  // a no-op. We never re-emit them ourselves: that would double every cue.
  if (ctx.net && typeof ctx.net.on === 'function') {
    ctx.net.on(MSG.BITE, onBite);
    ctx.net.on(MSG.CAST_RESULT, onCatch);
  }
  bus.on('bite', onBite);
  bus.on('catch', onCatch);
  bus.on('phase', () => { hardReset(); });
  bus.on('boardBoat', () => { if (F.phase !== 'idle') cancelCast(null, true); });
  bus.on('leaveBoat', () => { if (F.phase !== 'idle') cancelCast(null, true); });
  bus.on('underwater', on => { if (on && F.phase !== 'idle' && F.phase !== 'celebrating') cancelCast(null, true); });
  bus.on('eventStart', () => { if (F.phase !== 'idle' && F.phase !== 'celebrating') cancelCast(null, true); });

  // local mouse tracking (left button + right-click cancel)
  function fromUi(e) {
    const t = e.target;
    return !!(t && t.closest && t.closest('#ui'));
  }
  const onMouseDown = e => {
    if (fromUi(e)) return;
    if (e.button === 0) F.lmbLocal = true;
    else if (e.button === 2) F.rmbQueued = true;
  };
  const onMouseUp = e => {
    if (e.button === 0) F.lmbLocal = false;
  };
  const onBlur = () => { F.lmbLocal = false; };
  const onContext = e => {
    if (state.phase === 'playing') e.preventDefault();
  };
  window.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('blur', onBlur);
  window.addEventListener('contextmenu', onContext);

  // ---------------------------------------------------------- camera shake / fov
  function applyCameraFx(dt) {
    const cam = ctx.camera;
    if (!cam) return;
    if (F.camTracked && cam.position.distanceToSquared(F.camLeft) < 1e-9) {
      cam.position.sub(F.camOffset);
    }
    F.camOffset.set(0, 0, 0);
    F.camTracked = false;
    if (F.shake > 0.002) {
      F.shake = Math.max(0, F.shake - dt * 2.3);
      const s = F.shake * F.shake;
      const t = F.time * 46 + F.shakeSeed;
      F.camOffset.set(
        Math.sin(t) * 0.055 + Math.sin(t * 2.7) * 0.02,
        Math.cos(t * 1.31) * 0.05,
        Math.sin(t * 0.77 + 1.3) * 0.03).multiplyScalar(s);
      cam.position.add(F.camOffset);
      F.camLeft.copy(cam.position);
      F.camTracked = true;
    }
    // celebration framing
    if (F.fovActive) {
      let k = 0;
      if (F.phase === 'celebrating') {
        const a = clamp(F.celT / 0.45, 0, 1);
        const b = clamp((F.celDur - F.celT) / 0.5, 0, 1);
        k = Math.min(a, b);
      }
      const want = F.baseFov - 8 * k;
      if (Math.abs(cam.fov - want) > 0.02) {
        cam.fov = want;
        cam.updateProjectionMatrix();
      }
      if (F.phase !== 'celebrating' && k <= 0.001) restoreFov();
    }
    // flash billboard, pinned just in front of the camera
    if (flash.visible) {
      const d = 0.55;
      cam.getWorldPosition(_v1);
      cam.getWorldDirection(_v2);
      flash.position.copy(_v1).addScaledVector(_v2, d);
      cam.getWorldQuaternion(_q1);
      flash.quaternion.copy(_q1);
      const h = 2 * d * Math.tan((cam.fov || 60) * Math.PI / 360);
      flash.scale.set(h * (cam.aspect || 1.7) * 1.5, h * 1.5, 1);
      flashMat.opacity = Math.max(0, flashMat.opacity - dt * 1.15);
      if (flashMat.opacity <= 0.002) { flashMat.opacity = 0; flash.visible = false; }
    }
  }

  // ---------------------------------------------------------- reel minigame
  function updateReel(dt, held) {
    const s = F.strength;
    F.reelClock += dt;

    // fish jerks
    F.jerkTimer -= dt;
    if (F.jerkTimer <= 0) {
      F.jerkTimer = rand(0.22, 0.75) * (1.25 - s * 0.55);
      const dir = Math.random() < 0.62 ? 1 : -1;
      F.jerkTarget = dir * rand(0.15, 0.75) * (0.35 + s * 1.05);
    }
    F.jerk += (F.jerkTarget - F.jerk) * clamp(dt * 7, 0, 1);

    const rise = 0.80 + s * 0.55;
    const fall = 0.60 + s * 0.22;
    F.tension += (held ? rise : -fall) * dt;
    F.tension += F.jerk * dt * 0.85;
    F.tension = clamp(F.tension, 0, 1);

    // sweet zone drifts
    const w = clamp(0.30 - s * 0.13, 0.14, 0.32);
    const c = 0.5 + Math.sin(F.reelClock * (0.55 + s * 0.9)) * 0.2 + Math.sin(F.reelClock * 1.73 + 1.2) * (0.06 + s * 0.05);
    let a = clamp(c - w * 0.5, 0.03, 0.97 - w);
    let b = a + w;
    F.sweetA = a; F.sweetB = b;

    const inZone = F.tension >= a && F.tension <= b;
    if (inZone) F.progress += dt / (3.6 + s * 3.2);
    else F.progress -= dt * 0.11;
    F.progress = clamp(F.progress, 0, 1);

    if (F.tension > 0.975) F.pegged += dt;
    else F.pegged = Math.max(0, F.pegged - dt * 1.6);

    F.reelMsg.tension = F.tension;
    F.reelMsg.sweet[0] = a;
    F.reelMsg.sweet[1] = b;
    F.reelMsg.progress = F.progress;
    F.reelMsg.active = true;
    // aliases so the HUD can read the bar without knowing our field names
    F.reelMsg.pos = F.tension;
    F.reelMsg.zoneStart = a;
    F.reelMsg.zoneEnd = b;
    F.reelMsg.inZone = inZone;
    bus.emit('reelState', F.reelMsg);

    // bobber fight
    const wy = waterY(F.bobPos.x, F.bobPos.z);
    tipWorld(_v1);
    const pull = F.progress * 0.5;
    _v2.copy(F.reelAnchor).lerp(_v1, pull);
    _v2.y = wy;
    const wig = (0.25 + s * 0.5) * (0.4 + F.jerk);
    _v2.x += Math.sin(F.reelClock * 6.1) * wig;
    _v2.z += Math.cos(F.reelClock * 5.3 + 1.1) * wig;
    F.bobPos.lerp(_v2, clamp(dt * 6, 0, 1));
    F.bobPos.y = wy - 0.05 - F.tension * 0.16 + Math.sin(F.reelClock * 9) * 0.03;

    F.splashTimer -= dt;
    if (F.splashTimer <= 0) {
      F.splashTimer = lerp(0.55, 0.18, F.tension);
      doSplash(F.bobPos, 0.5 + F.tension * 1.1);
      ripples.spawn(F.bobPos.x, wy, F.bobPos.z, 0.12, 1.1 + F.tension * 1.5, 0.7, 0xdff4ff, 0.35 + F.tension * 0.3);
      sparks.burst(F.bobPos, 5 + Math.floor(F.tension * 8), {
        color: 0xdff4ff, speed: 1.6 + F.tension * 2.2, up: 1.2, size: 0.075, life: 0.4, gravity: 13, spread: 0.4,
      });
    }
    // audio.js's reelLoop re-arms its own ticker; feed it every frame we hold
    if (held) sfx('reelLoop', { tension: F.tension, vol: 0.55 + F.tension * 0.45 });
    F.shake = Math.max(F.shake, F.tension * 0.22 + Math.abs(F.jerk) * 0.16);

    if (F.pegged > 0.8) { finishReel(false); return; }
    if (F.progress >= 1) { finishReel(true); return; }
  }

  // ---------------------------------------------------------- celebration
  function updateCelebration(dt, sdt) {
    F.celT += dt;
    const d = F.celData;
    const c = localChar();
    // raise arms over the player's own animation (we run after player.js)
    if (c && c.bones) {
      const k = clamp((F.celT - 0.15) / 0.35, 0, 1) * clamp((F.celDur - F.celT) / 0.35, 0, 1);
      const wob = Math.sin(F.animTime * 5) * 0.08 * k;
      if (c.bones.armR) { c.bones.armR.rotation.x = lerp(c.bones.armR.rotation.x, -2.5 + wob, k); c.bones.armR.rotation.z = lerp(c.bones.armR.rotation.z, -0.35, k); }
      if (c.bones.armL) { c.bones.armL.rotation.x = lerp(c.bones.armL.rotation.x, -2.4 - wob, k); c.bones.armL.rotation.z = lerp(c.bones.armL.rotation.z, 0.35, k); }
      if (c.bones.head) c.bones.head.rotation.x = lerp(c.bones.head.rotation.x, -0.35 * k, 0.5);
    }
    if (F.celFish && d) {
      // hold point: above the head, facing the camera
      if (c && c.bones && c.bones.head) c.bones.head.getWorldPosition(_v1);
      else if (c && c.group) { _v1.copy(c.group.position); _v1.y += 1.6; }
      else tipWorld(_v1);
      _v1.y += 0.72;
      if (ctx.camera) {
        ctx.camera.getWorldDirection(_v2); _v2.y = 0;
        if (_v2.lengthSq() > 1e-6) { _v2.normalize(); _v1.addScaledVector(_v2, 0.25); }
      }
      const rise = clamp(F.celT / 0.6, 0, 1);
      const e = 1 - Math.pow(1 - rise, 3);
      _v3.copy(F.celFrom).lerp(_v1, e);
      _v3.y += Math.sin(rise * Math.PI) * 0.55;                 // arc
      _v3.y += Math.sin(F.animTime * 2.2) * 0.04 * e;           // idle bob
      F.celFish.position.copy(_v3);
      F.celFish.rotation.y += sdt * 0.9;
      F.celFish.rotation.z = Math.sin(F.animTime * 3.4) * 0.16 * (1 - e * 0.6);
      const out = clamp((F.celDur - F.celT) / 0.35, 0, 1);
      const pop = 1 + Math.sin(clamp(F.celT / 0.25, 0, 1) * Math.PI) * 0.22;
      F.celFish.scale.setScalar(F.celScale * pop * out);
      if (F.celFish.userData && typeof F.celFish.userData.update === 'function') {
        try { F.celFish.userData.update(F.animTime); } catch (e2) { /* fish anim optional */ }
      }
      // trailing sparkle for shiny catches
      if (d.mut || d.legendary) {
        F.celSpark = (F.celSpark || 0) + sdt;
        if (F.celSpark > 0.05) {
          F.celSpark = 0;
          const col = d.mut && MUTATIONS[d.mut] ? MUTATIONS[d.mut].tint : 0xffd77a;
          sparks.spawn(
            _v3.x + rand(-0.3, 0.3), _v3.y + rand(-0.2, 0.3), _v3.z + rand(-0.3, 0.3),
            rand(-0.2, 0.2), rand(0.1, 0.5), rand(-0.2, 0.2),
            col, 0.075, 0.7, -1.2, 1.8);
        }
      }
    }
    // slow-motion release
    if (F.slowTimer > 0) {
      F.slowTimer -= dt;
      if (F.slowTimer <= 0) F.timeScaleTarget = 1;
    }
    if (F.celT >= F.celDur) {
      if (F.celFish) {
        sparks.burst(F.celFish.position, 22, {
          color: d && d.legendary ? 0xffd77a : 0xcfeaff, speed: 2.2, up: 0.8, size: 0.09, life: 0.5, gravity: 6, spread: 1,
        });
      }
      stowCelebrationFish(true);
      F.timeScaleTarget = 1;
      F.phase = bobber.visible ? 'retracting' : 'idle';
      if (F.phase === 'retracting' && F.retractT >= (F.retractDur || 0.3)) { bobber.visible = false; F.phase = 'idle'; }
      setAnim('idle');
      restoreFov();
    }
  }

  // ---------------------------------------------------------- main update
  function update(dt, t) {
    if (!dt || dt < 0) dt = 0;
    F.time += dt;
    F.clockT = (typeof t === 'number' && isFinite(t)) ? t : F.time;
    F.timeScale += (F.timeScaleTarget - F.timeScale) * clamp(dt * 5, 0, 1);
    const sdt = dt * F.timeScale;
    F.animTime += sdt;

    sparks.update(sdt);
    ripples.update(sdt);

    if (state.phase !== 'playing') {
      if (F.phase !== 'idle') hardReset();
      if (F.rod) F.rod.group.visible = false;
      lineObj.visible = false;
      bobber.visible = false;
      applyCameraFx(dt);
      return;
    }

    ensureRod();
    refreshBaitLook();

    // ---- input edges
    const lmb = !!(ctx.input && ctx.input.mouseDown) || F.lmbLocal;
    const lmbPressed = lmb && !F.lmbPrev;
    F.lmbPrev = lmb;
    const keys = (ctx.input && ctx.input.keys) || null;
    const keyR = !!(keys && keys.has && keys.has('KeyR'));
    const keyRPressed = keyR && !F.keyRPrev;
    F.keyRPrev = keyR;
    const rmb = F.rmbQueued;
    F.rmbQueued = false;

    const showRod = state.activeTool === 'rod' && !isDriver() && state.hp > 0;
    if (F.rod) F.rod.group.visible = showRod;

    // ---- cancel
    if ((keyRPressed || rmb) && F.phase !== 'idle' && F.phase !== 'celebrating') {
      if (F.phase === 'charging') {
        F.phase = 'idle';
        F.power = 0;
        F.powerMsg.p = 0;
        bus.emit('castPower', F.powerMsg);
        setAnim('idle');
      } else {
        cancelCast('Line reeled in.', false);
      }
    }

    // ---- state machine
    switch (F.phase) {
      case 'idle': {
        if (lmbPressed && !rmb && canStartCast()) beginCharge();
        break;
      }
      case 'charging': {
        if (!canStartCast()) {
          F.phase = 'idle'; F.power = 0;
          F.powerMsg.p = 0; bus.emit('castPower', F.powerMsg);
          setAnim('idle');
          break;
        }
        F.power = clamp(F.power + dt / 1.15, 0, 1);
        F.powerMsg.p = F.power;
        bus.emit('castPower', F.powerMsg);
        if (!lmb) releaseCast();
        break;
      }
      case 'flying': {
        F.flightT += dt;
        F.bobVel.y -= 24 * dt;
        F.bobPos.addScaledVector(F.bobVel, dt);
        F.bobSpin += dt * 9;
        const wy = waterY(F.bobPos.x, F.bobPos.z);
        if (F.bobPos.y <= wy || F.flightT > 4) {
          F.bobPos.y = wy;
          landBobber();
        } else if (F.flightT > 0.12) {
          const th = terrainY(F.bobPos.x, F.bobPos.z);
          if (th > F.bobPos.y && th > wy + 0.25) {
            // clipped the shoreline / a rock on the way out
            toast('That is dry land — aim at the water.', 'warn');
            sfx('error', { vol: 0.45 });
            startRetract(true);
          }
        }
        break;
      }
      case 'waiting': {
        if (F.noAreaTimer > 0) {
          F.noAreaTimer -= dt;
          if (F.noAreaTimer <= 0) { startRetract(false); break; }
        }
        idleBobber(dt);
        if (!canStartCast()) cancelCast(null, true);
        break;
      }
      case 'hooking': {
        idleBobber(dt);
        F.hookTimer -= dt;
        if (lmb) { hookSet(); break; }
        if (F.hookTimer <= 0) missBite();
        break;
      }
      case 'reeling': {
        updateReel(dt, lmb);
        break;
      }
      case 'resolving': {
        idleBobber(dt);
        F.resolveTimer -= dt;
        if (F.resolveTimer <= 0) { toast('The line went slack...', 'warn'); startRetract(false); }
        break;
      }
      case 'celebrating': {
        if (bobber.visible) updateRetract(dt);
        updateCelebration(dt, sdt);
        break;
      }
      case 'retracting': {
        updateRetract(dt);
        break;
      }
      default: break;
    }

    // safety: wandered too far from the bobber
    if (F.phase === 'waiting' || F.phase === 'hooking' || F.phase === 'reeling') {
      tipWorld(_v1);
      if (_v1.distanceToSquared(F.bobPos) > 65 * 65) cancelCast('The line went slack...', false);
    }

    orientRod(dt);
    bendRod(dt);
    updateRodFx(sdt);
    updateIdleBobberPose(dt);
    updateLine(dt);
    applyCameraFx(dt);
  }

  function idleBobber(dt) {
    const wy = waterY(F.bobPos.x, F.bobPos.z);
    F.bobYank = Math.max(0, F.bobYank - dt * 2.2);
    const yank = F.bobYank * F.bobYank;
    F.bobPos.y = wy - yank * 0.42 + Math.sin(F.animTime * 1.9) * 0.02;
    F.rippleTimer -= dt;
    if (F.rippleTimer <= 0) {
      F.rippleTimer = rand(2.2, 3.8);
      ripples.spawn(F.bobPos.x, wy, F.bobPos.z, 0.12, 1.15, 1.5, 0xcfeaff, 0.3);
    }
    if (yank > 0.25 && Math.random() < dt * 22) {
      sparks.burst(F.bobPos, 2, { color: 0xdff4ff, speed: 1.4, up: 1.2, size: 0.06, life: 0.35, gravity: 13, spread: 0.3 });
    }
  }

  function updateRetract(dt) {
    F.retractT += dt;
    const k = clamp(F.retractT / (F.retractDur || 0.3), 0, 1);
    tipWorld(_v1);
    _v2.copy(F.retractFrom).lerp(_v1, k * k);
    F.bobPos.copy(_v2);
    bobber.scale.setScalar(1 - k * 0.35);
    if (k >= 1) {
      bobber.visible = false;
      bobber.scale.setScalar(1);
      F.bobRetracting = false;
      if (F.phase === 'retracting') { F.phase = 'idle'; setAnim('idle'); }
    }
  }

  function updateIdleBobberPose(dt) {
    const hanging = F.phase === 'idle' || F.phase === 'charging';
    if (!bobber.visible) {
      // hang the bobber just under the rod tip while idle so the rig reads right
      if (F.rod && F.rod.group.visible && hanging) {
        F.rod.tip.getWorldPosition(_v1);
        _v1.y -= 0.28;
        F.bobPos.copy(_v1);
        bobber.visible = true;
        bobber.scale.setScalar(0.72);
      } else return;
    } else if (hanging) {
      if (!F.rod || !F.rod.group.visible) { bobber.visible = false; return; }
      F.rod.tip.getWorldPosition(_v1);
      _v1.y -= 0.28 - F.power * 0.06;
      F.bobPos.lerp(_v1, clamp(dt * (F.phase === 'charging' ? 9 : 14), 0, 1));
      bobber.scale.setScalar(0.72);
    } else if (!F.bobRetracting) {
      bobber.scale.setScalar(1);
    }
    bobber.position.copy(F.bobPos);
    // tilt: upright in water, tumbling in flight
    if (F.phase === 'flying') {
      F.bobSpin += dt * 6;
      bobber.rotation.set(Math.sin(F.bobSpin) * 0.9, F.bobSpin * 0.4, Math.cos(F.bobSpin * 0.8) * 0.7);
    } else {
      const lean = (F.phase === 'reeling') ? 0.35 + F.tension * 0.5 : 0.06;
      bobber.rotation.set(
        lerp(bobber.rotation.x, Math.sin(F.animTime * 1.6) * 0.09 - lean * 0.6, clamp(dt * 6, 0, 1)),
        bobber.rotation.y,
        lerp(bobber.rotation.z, Math.cos(F.animTime * 1.3) * 0.09, clamp(dt * 6, 0, 1)));
    }
  }

  // ---------------------------------------------------------- handle
  const handle = {
    update,
    isCasting() {
      return F.phase === 'flying' || F.phase === 'waiting' || F.phase === 'hooking'
        || F.phase === 'reeling' || F.phase === 'resolving' || F.phase === 'celebrating';
    },
  };
  return handle;
}
