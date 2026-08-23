// =============================================================
// TIDEWRECK ISLAND — enemies.js
// Hostile sea creatures + the weapons the players fight back with.
//
// Owns:
//   * Rendering / interpolation / animation of server-driven enemies
//     (bus 'enemyState', bus 'enemyHit', MSG.ENEMY_STATE, MSG.ENEMY_HIT)
//   * Every weapon (Fish Bonker, Harpoon, Rusty Cutlass, Speargun, Storm
//     Trident): hand models, firing, projectiles, the trident's lightning
//     lance, melee swings, hit detection and MSG.DAMAGE_ENEMY reporting.
//   * Melee swings also bonk the local player's landed catch through
//     fishing.js (ctx.fishing.tryBonk -> MSG.BONK_FISH).
//
// Damage to the LOCAL player from enemies is entirely server-authoritative —
// this module never sends MSG.PLAYER_HIT. It only plays the bite feedback
// (lunge visuals, sfx, camera shake, bus 'localDamaged' feedback event).
//
// Everything is procedural: code-built geometry, canvas textures, no assets.
// =============================================================

import * as THREE from 'three';
import { MSG, ENEMIES, shopById } from '/shared/constants.js';
// Namespace import on purpose: a *named* import of a symbol fish.js does not
// export is a link-time error that would take this whole module down with it.
// Read through the namespace so a missing factory degrades to our fallback
// mesh instead of breaking the page.
import * as fishFactory from './fish.js';

// ------------------------------------------------------------------
// Tunables
// ------------------------------------------------------------------
const INTERP_TIME = 0.15;     // seconds of network smoothing (~8 Hz ENEMY_STATE)
const DEATH_TIME = 3.0;       // seconds from hp<=0 to removal
const DESPAWN_FADE = 0.45;    // fade for enemies that vanish from the server list
const BITE_RANGE = 3.0;       // metres — aggro enemy this close bites the local player
const BITE_COOLDOWN = 1.15;   // seconds between bite feedback pulses
const MAX_POOLED = 3;         // cached meshes kept per enemy type

const HARPOON_SPEED = 30;
const HARPOON_GRAVITY = 4.0;
const HARPOON_RETURN = 0.8;   // seconds until the harpoon is back in hand
const BOLT_SPEED = 58;
const BEAM_TIME = 0.17;

// Melee: a short wind-up followed by a ~120 degree arc.
const MELEE_SWING = 0.26;      // seconds, whole swing
const MELEE_WINDUP = 0.09;     // seconds spent cocking the arm back
const MELEE_CONTACT = 0.145;   // seconds until the blow lands
const MELEE_ARC_DOT = 0.42;    // cos(half-arc) -> ~130 deg of frontal cone
const MELEE_JAB_RANGE = 4.0;   // 'both' weapons jab instead of firing inside this
const MELEE_NEAR = 1.3;        // closer than this the arc test is skipped
const MELEE_MAX_TARGETS = 3;   // a wide swing may catch a small shoal

// ------------------------------------------------------------------
// Scratch objects — module level so per-frame allocation stays at zero
// ------------------------------------------------------------------
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _localPos = new THREE.Vector3();
const _impactP = new THREE.Vector3();
const _box = new THREE.Box3();
const _boxSize = new THREE.Vector3();
const _boxCtr = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _qHand = new THREE.Quaternion();
const _qChar = new THREE.Quaternion();
const _qOff = new THREE.Quaternion();
const _axisZ = new THREE.Vector3(0, 0, 1);
const _axisX = new THREE.Vector3(1, 0, 0);
const _colTmp = new THREE.Color();

const C_WHITE = new THREE.Color(0xffffff);
const C_RIM = new THREE.Color(0xff2a1c);

const HEAD_HINT = /(tooth|teeth|jaw|maw|lure|snout|head|bill|eye|whisker)/i;

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function damp(cur, target, rate, dt) { return cur + (target - cur) * (1 - Math.exp(-rate * dt)); }
function shortAngle(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// ------------------------------------------------------------------
// Shared canvas textures
// ------------------------------------------------------------------
let _glowTex = null;
function glowTexture() {
  if (_glowTex) return _glowTex;
  const s = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0.00, 'rgba(255,255,255,1)');
  grd.addColorStop(0.22, 'rgba(255,255,255,0.85)');
  grd.addColorStop(0.55, 'rgba(255,255,255,0.22)');
  grd.addColorStop(1.00, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  _glowTex = new THREE.CanvasTexture(cv);
  _glowTex.colorSpace = THREE.SRGBColorSpace;
  return _glowTex;
}

let _woodTex = null;
function woodTexture() {
  if (_woodTex) return _woodTex;
  const w = 32, h = 256;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  g.fillStyle = '#b08a55';
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 46; i++) {
    const y = Math.random() * h;
    const a = 0.05 + Math.random() * 0.16;
    g.strokeStyle = Math.random() < 0.4 ? `rgba(255,225,180,${a})` : `rgba(74,48,24,${a})`;
    g.lineWidth = 0.6 + Math.random() * 2.2;
    g.beginPath();
    g.moveTo(-2, y);
    g.bezierCurveTo(w * 0.3, y + (Math.random() - 0.5) * 9, w * 0.7, y + (Math.random() - 0.5) * 9, w + 2, y + (Math.random() - 0.5) * 6);
    g.stroke();
  }
  for (let i = 0; i < 5; i++) {
    const y = Math.random() * h;
    g.strokeStyle = 'rgba(70,44,20,0.30)';
    g.lineWidth = 1.4;
    g.beginPath();
    g.ellipse(w * 0.5, y, 3 + Math.random() * 3, 7 + Math.random() * 6, 0, 0, Math.PI * 2);
    g.stroke();
  }
  _woodTex = new THREE.CanvasTexture(cv);
  _woodTex.colorSpace = THREE.SRGBColorSpace;
  _woodTex.wrapS = _woodTex.wrapT = THREE.RepeatWrapping;
  _woodTex.repeat.set(1, 2);
  return _woodTex;
}

// ------------------------------------------------------------------
// GPU particle field — one draw call, fixed pool, zero per-frame allocation
// ------------------------------------------------------------------
const PARTICLE_VERT = `
uniform float uScale;
attribute vec3 aColor;
attribute float aSize;
attribute float aAlpha;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  gl_PointSize = aSize * uScale / max( 0.25, -mv.z );
  gl_Position = projectionMatrix * mv;
}
`;

const SPARK_FRAG = `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 d = gl_PointCoord - vec2( 0.5 );
  float r2 = dot( d, d );
  if ( r2 > 0.25 ) discard;
  float a = 1.0 - smoothstep( 0.0, 0.25, r2 );
  gl_FragColor = vec4( vColor, a * a * vAlpha );
}
`;

const BUBBLE_FRAG = `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 d = gl_PointCoord - vec2( 0.5 );
  float r = length( d );
  if ( r > 0.5 ) discard;
  float edge = smoothstep( 0.5, 0.40, r ) * smoothstep( 0.16, 0.40, r );
  float hi = smoothstep( 0.16, 0.02, length( d - vec2( -0.14, -0.14 ) ) );
  float a = ( edge * 0.8 + hi * 0.85 ) * vAlpha;
  if ( a < 0.008 ) discard;
  gl_FragColor = vec4( vColor + vec3( hi * 0.55 ), a );
}
`;

class ParticleField {
  constructor(count, kind) {
    this.count = count;
    this.kind = kind;
    this.cursor = 0;
    this.dirty = false;
    this.live = 0;

    this.pos = new Float32Array(count * 3);
    this.col = new Float32Array(count * 3);
    this.siz = new Float32Array(count);
    this.alp = new Float32Array(count);
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.maxLife = new Float32Array(count);
    this.size0 = new Float32Array(count);
    this.grav = new Float32Array(count);
    this.drag = new Float32Array(count);

    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3);
    this.aCol = new THREE.BufferAttribute(this.col, 3);
    this.aSiz = new THREE.BufferAttribute(this.siz, 1);
    this.aAlp = new THREE.BufferAttribute(this.alp, 1);
    this.aPos.setUsage(THREE.DynamicDrawUsage);
    this.aCol.setUsage(THREE.DynamicDrawUsage);
    this.aSiz.setUsage(THREE.DynamicDrawUsage);
    this.aAlp.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('aColor', this.aCol);
    geo.setAttribute('aSize', this.aSiz);
    geo.setAttribute('aAlpha', this.aAlp);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);

    this.material = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 380 } },
      vertexShader: PARTICLE_VERT,
      fragmentShader: kind === 'bubble' ? BUBBLE_FRAG : SPARK_FRAG,
      transparent: true,
      depthWrite: false,
      blending: kind === 'bubble' ? THREE.NormalBlending : THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = kind === 'bubble' ? 3 : 4;
    this.points.matrixAutoUpdate = false;
  }

  spawn(x, y, z, vx, vy, vz, size, life, color, grav, drag) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.count;
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    _colTmp.set(color);
    this.col[i3] = _colTmp.r; this.col[i3 + 1] = _colTmp.g; this.col[i3 + 2] = _colTmp.b;
    this.siz[i] = size;
    this.size0[i] = size;
    this.alp[i] = 1;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.grav[i] = grav || 0;
    this.drag[i] = drag || 0;
    this.dirty = true;
  }

  burst(x, y, z, n, spread, size, life, color, grav, drag, dirX, dirY, dirZ, bias) {
    for (let k = 0; k < n; k++) {
      let vx = (Math.random() - 0.5) * 2 * spread;
      let vy = (Math.random() - 0.5) * 2 * spread;
      let vz = (Math.random() - 0.5) * 2 * spread;
      if (bias) { vx += dirX * bias; vy += dirY * bias; vz += dirZ * bias; }
      this.spawn(
        x + vx * 0.02, y + vy * 0.02, z + vz * 0.02,
        vx, vy, vz,
        size * (0.6 + Math.random() * 0.8),
        life * (0.65 + Math.random() * 0.7),
        color, grav, drag
      );
    }
  }

  update(dt) {
    let live = 0;
    const { pos, vel, life, maxLife, siz, alp, size0, grav, drag } = this;
    const wob = this.kind === 'bubble';
    for (let i = 0; i < this.count; i++) {
      const l = life[i];
      if (l <= 0) continue;
      const nl = l - dt;
      const i3 = i * 3;
      if (nl <= 0) {
        life[i] = 0; siz[i] = 0; alp[i] = 0;
        this.dirty = true;
        continue;
      }
      life[i] = nl;
      live++;
      const d = drag[i] > 0 ? Math.exp(-drag[i] * dt) : 1;
      vel[i3] *= d;
      vel[i3 + 1] = vel[i3 + 1] * d + grav[i] * dt;
      vel[i3 + 2] *= d;
      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;
      if (wob) {
        pos[i3] += Math.sin((nl + i) * 9.0) * dt * 0.28;
        pos[i3 + 2] += Math.cos((nl + i * 0.7) * 7.5) * dt * 0.28;
      }
      const f = nl / maxLife[i];
      alp[i] = wob ? clamp(f * 1.6, 0, 0.85) : f * f;
      siz[i] = wob ? size0[i] * (1.25 - f * 0.35) : size0[i] * (0.35 + f * 0.75);
      this.dirty = true;
    }
    this.live = live;
    if (this.dirty) {
      this.aPos.needsUpdate = true;
      this.aCol.needsUpdate = true;
      this.aSiz.needsUpdate = true;
      this.aAlp.needsUpdate = true;
      this.dirty = live > 0;
    }
  }

  clear() {
    this.life.fill(0);
    this.siz.fill(0);
    this.alp.fill(0);
    this.live = 0;
    this.dirty = true;
  }
}

// ------------------------------------------------------------------
// Enemy visual definitions — fishDef-like objects fed to createFishMesh
// ------------------------------------------------------------------
const ENEMY_VISUALS = {
  barracudaPack: {
    fishDef: {
      id: 'enemy_barracuda', name: 'Barracuda', tier: 5, value: 0, kg: [8, 25],
      model: { shape: 'eel', size: 1.3, colors: [0xc6d2dc, 0x78868f], belly: 0xf0f6fa, teeth: true },
    },
    eyeColor: 0xffe6bc, eyeIdle: 0.10, eyeSize: 0.085,
    lure: null, bob: 0.9, animBase: 1.35, wake: 0x9fd8ee,
  },
  reefshark: {
    fishDef: {
      id: 'enemy_reefshark', name: 'Reef Shark', tier: 8, value: 0, kg: [40, 140],
      model: { shape: 'shark', size: 2.2, colors: [0x7e8b95, 0x49545d], belly: 0xdfe7ec, teeth: true },
    },
    eyeColor: 0xfff0d2, eyeIdle: 0.08, eyeSize: 0.055,
    lure: null, bob: 0.55, animBase: 1.0, wake: 0x9fd8ee,
  },
  abyssstalker: {
    fishDef: {
      id: 'enemy_abyssstalker', name: 'Abyss Stalker', tier: 9, value: 0, kg: [300, 800],
      model: { shape: 'angler', size: 3.0, colors: [0x121219, 0x06060b], belly: 0x1e1e29, emissive: 0x76ff96, teeth: true },
    },
    eyeColor: 0xc4ffd4, eyeIdle: 0.24, eyeSize: 0.07,
    lure: 0x86ff9c, bob: 0.35, animBase: 0.8, wake: 0x6fffa0,
  },
};

function visualsFor(type) {
  return ENEMY_VISUALS[type] || ENEMY_VISUALS.reefshark;
}

// A defensive stand-in used only if fish.js cannot produce a mesh for us
// (it is written in parallel). Built head-first along +Z so orientation
// detection is a no-op.
function fallbackFishMesh(def) {
  const m = def.model;
  const len = m.size || 1.5;
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({
    color: m.colors ? m.colors[0] : 0x8899a4, roughness: 0.62, metalness: 0.08, flatShading: true,
    emissive: m.emissive || 0x000000, emissiveIntensity: m.emissive ? 0.8 : 0,
  });
  const finMat = new THREE.MeshStandardMaterial({
    color: m.colors ? m.colors[1] : 0x53606a, roughness: 0.7, flatShading: true, side: THREE.DoubleSide,
  });
  const body = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 1), bodyMat);
  body.name = 'body';
  body.scale.set(0.34 * len, 0.4 * len, len);
  g.add(body);
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.19 * len, 0.34 * len, 7), bodyMat);
  head.name = 'head';
  head.rotation.x = Math.PI / 2;
  head.position.z = 0.55 * len;
  g.add(head);
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.24 * len, 0.42 * len, 4), finMat);
  tail.rotation.x = -Math.PI / 2;
  tail.position.z = -0.62 * len;
  g.add(tail);
  const dorsal = new THREE.Mesh(new THREE.ConeGeometry(0.15 * len, 0.3 * len, 3), finMat);
  dorsal.position.set(0, 0.2 * len, -0.02 * len);
  g.add(dorsal);
  g.userData.update = (t) => {
    const w = Math.sin(t * 5.0);
    body.rotation.y = w * 0.10;
    tail.rotation.y = Math.sin(t * 5.0 - 0.8) * 0.5;
    head.rotation.z = w * 0.06;
  };
  return g;
}

// ------------------------------------------------------------------
// Weapon model construction (shared geometry/material caches)
// ------------------------------------------------------------------
let WG = null;
function weaponAssets() {
  if (WG) return WG;
  WG = {
    geo: {
      shaftZ: (() => { const g = new THREE.CylinderGeometry(0.032, 0.028, 1, 8, 1); g.rotateX(Math.PI / 2); return g; })(),
      thinZ: (() => { const g = new THREE.CylinderGeometry(0.016, 0.016, 1, 6, 1); g.rotateX(Math.PI / 2); return g; })(),
      cordZ: (() => { const g = new THREE.CylinderGeometry(0.008, 0.008, 1, 5, 1); g.rotateX(Math.PI / 2); return g; })(),
      spikeZ: (() => { const g = new THREE.ConeGeometry(0.075, 0.3, 6); g.rotateX(Math.PI / 2); return g; })(),
      barbZ: (() => { const g = new THREE.ConeGeometry(0.05, 0.16, 4); g.rotateX(-Math.PI / 2); return g; })(),
      prongZ: (() => { const g = new THREE.ConeGeometry(0.036, 0.5, 6); g.rotateX(Math.PI / 2); return g; })(),
      box: new THREE.BoxGeometry(1, 1, 1),
      ring: new THREE.TorusGeometry(0.05, 0.014, 5, 10),
      beadZ: new THREE.OctahedronGeometry(0.05, 0),
      ball: new THREE.SphereGeometry(0.5, 12, 9),
      rock: new THREE.IcosahedronGeometry(0.5, 1),
      discZ: (() => { const g = new THREE.CylinderGeometry(0.5, 0.5, 1, 14, 1); g.rotateX(Math.PI / 2); return g; })(),
    },
    mat: {
      wood: new THREE.MeshStandardMaterial({ map: woodTexture(), color: 0xc7a071, roughness: 0.88, metalness: 0.02, flatShading: true }),
      clubWood: new THREE.MeshStandardMaterial({ map: woodTexture(), color: 0x9d7042, roughness: 0.93, metalness: 0.02, flatShading: true }),
      rust: new THREE.MeshStandardMaterial({ color: 0x9d8878, roughness: 0.68, metalness: 0.55, flatShading: true }),
      edge: new THREE.MeshStandardMaterial({ color: 0xe7edf1, roughness: 0.26, metalness: 0.92, flatShading: true }),
      steel: new THREE.MeshStandardMaterial({ color: 0xcdd7de, roughness: 0.28, metalness: 0.82, flatShading: true }),
      darkSteel: new THREE.MeshStandardMaterial({ color: 0x2b313a, roughness: 0.42, metalness: 0.88, flatShading: true }),
      leather: new THREE.MeshStandardMaterial({ color: 0x5b3a23, roughness: 0.95, metalness: 0.0, flatShading: true }),
      rubber: new THREE.MeshStandardMaterial({ color: 0x231f24, roughness: 0.96, metalness: 0.0 }),
      brass: new THREE.MeshStandardMaterial({ color: 0xc9a04a, roughness: 0.35, metalness: 0.9, flatShading: true }),
      electric: new THREE.MeshStandardMaterial({
        color: 0x1d4c7a, emissive: 0x74d8ff, emissiveIntensity: 2.2, roughness: 0.24, metalness: 0.6, flatShading: true,
      }),
    },
  };
  return WG;
}

function boxMesh(mat, sx, sy, sz, px, py, pz) {
  const m = new THREE.Mesh(weaponAssets().geo.box, mat);
  m.scale.set(sx, sy, sz);
  m.position.set(px, py, pz);
  return m;
}

function segMesh(geo, mat, ax, ay, az, bx, by, bz, thick) {
  const m = new THREE.Mesh(geo, mat);
  _v1.set(bx - ax, by - ay, bz - az);
  const len = _v1.length() || 0.001;
  _v1.multiplyScalar(1 / len);
  m.quaternion.setFromUnitVectors(_axisZ, _v1);
  m.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  m.scale.set(thick, thick, len);
  return m;
}

function makeGlowSprite(color, size, opacity) {
  const mat = new THREE.SpriteMaterial({
    map: glowTexture(), color, transparent: true, opacity,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, fog: false,
  });
  const s = new THREE.Sprite(mat);
  s.scale.set(size, size, 1);
  return s;
}

// Fish Bonker — a stubby, cartoonishly top-heavy wooden club. Tiny grip,
// enormous rounded head, brass bands, a couple of dents from past business.
function buildBonker() {
  const A = weaponAssets();
  const g = new THREE.Group();

  const grip = new THREE.Mesh(A.geo.shaftZ, A.mat.leather);
  grip.scale.set(1.2, 1.2, 0.36);
  grip.position.z = 0;
  g.add(grip);
  for (let i = 0; i < 3; i++) {
    const wrap = new THREE.Mesh(A.geo.shaftZ, A.mat.clubWood);
    wrap.scale.set(1.3, 1.3, 0.03);
    wrap.position.z = -0.12 + i * 0.11;
    g.add(wrap);
  }
  const pommel = new THREE.Mesh(A.geo.ball, A.mat.clubWood);
  pommel.scale.set(0.078, 0.078, 0.06);
  pommel.position.z = -0.2;
  g.add(pommel);
  const collar = new THREE.Mesh(A.geo.shaftZ, A.mat.brass);
  collar.scale.set(1.65, 1.65, 0.04);
  collar.position.z = 0.19;
  g.add(collar);

  // head: fat barrel, slightly squashed on the slapping face
  const neck = new THREE.Mesh(A.geo.shaftZ, A.mat.clubWood);
  neck.scale.set(2.1, 2.1, 0.13);
  neck.position.z = 0.27;
  g.add(neck);
  const head = new THREE.Mesh(A.geo.ball, A.mat.clubWood);
  head.scale.set(0.23, 0.19, 0.31);
  head.position.z = 0.48;
  g.add(head);
  const cap = new THREE.Mesh(A.geo.ball, A.mat.clubWood);
  cap.scale.set(0.175, 0.15, 0.11);
  cap.position.z = 0.63;
  g.add(cap);
  for (let i = 0; i < 2; i++) {
    const band = new THREE.Mesh(A.geo.shaftZ, A.mat.brass);
    band.scale.set(3.4 - i * 0.45, 2.9 - i * 0.4, 0.03);
    band.position.z = 0.37 + i * 0.2;
    g.add(band);
  }
  const dent = new THREE.Mesh(A.geo.rock, A.mat.clubWood);
  dent.scale.set(0.1, 0.085, 0.1);
  dent.position.set(0.1, 0.045, 0.52);
  g.add(dent);
  const dent2 = new THREE.Mesh(A.geo.rock, A.mat.clubWood);
  dent2.scale.set(0.08, 0.07, 0.08);
  dent2.position.set(-0.09, -0.04, 0.42);
  g.add(dent2);

  const tip = new THREE.Object3D();
  tip.position.z = 0.72;
  g.add(tip);
  g.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = false; } });
  return { group: g, tip, glow: null };
}

// Rusty Cutlass — leather grip, brass knuckle bow, a worn curved blade
// swept out of short segments so the curve reads from any angle.
function buildCutlass() {
  const A = weaponAssets();
  const g = new THREE.Group();

  const grip = new THREE.Mesh(A.geo.shaftZ, A.mat.leather);
  grip.scale.set(0.95, 0.95, 0.28);
  grip.position.z = -0.07;
  g.add(grip);
  for (let i = 0; i < 4; i++) {
    const wrap = new THREE.Mesh(A.geo.shaftZ, A.mat.darkSteel);
    wrap.scale.set(1.02, 1.02, 0.014);
    wrap.position.z = -0.17 + i * 0.06;
    g.add(wrap);
  }
  const pommel = new THREE.Mesh(A.geo.ball, A.mat.brass);
  pommel.scale.set(0.07, 0.07, 0.055);
  pommel.position.z = -0.225;
  g.add(pommel);

  // guard: oval brass plate plus a knuckle bow looping back to the pommel
  const guard = new THREE.Mesh(A.geo.discZ, A.mat.brass);
  guard.scale.set(0.13, 0.085, 0.026);
  guard.position.z = 0.09;
  g.add(guard);
  const bow = [
    [0, -0.035, 0.10], [0, -0.135, 0.045], [0, -0.155, -0.075], [0, -0.09, -0.195],
  ];
  for (let i = 0; i < bow.length - 1; i++) {
    const a = bow[i], b = bow[i + 1];
    g.add(segMesh(A.geo.cordZ, A.mat.brass, a[0], a[1], a[2], b[0], b[1], b[2], 1.7));
  }

  // blade: seven segments, each tilted a little further, sweeping upward
  const SEG = 7;
  const L = 0.115;
  let py = 0, pz = 0.13, ang = 0.04;
  for (let i = 0; i < SEG; i++) {
    const s = new THREE.Group();
    s.position.set(0, py, pz);
    s.rotation.x = -ang;
    g.add(s);
    const w = 0.056 - i * 0.0048;
    const th = 0.019 - i * 0.0013;
    const body = new THREE.Mesh(A.geo.box, A.mat.rust);
    body.scale.set(th, w, L * 1.04);
    body.position.set(0, 0, L * 0.5);
    s.add(body);
    const ed = new THREE.Mesh(A.geo.box, A.mat.edge);
    ed.scale.set(th * 0.55, w * 0.22, L * 1.02);
    ed.position.set(0, w * 0.4, L * 0.5);
    s.add(ed);
    if (i === 0) {
      const ricasso = new THREE.Mesh(A.geo.box, A.mat.brass);
      ricasso.scale.set(th * 1.5, w * 1.15, 0.022);
      s.add(ricasso);
    }
    if (i === SEG - 1) {
      const point = new THREE.Mesh(A.geo.spikeZ, A.mat.edge);
      point.scale.set(0.36, 0.62, 0.34);
      point.position.set(0, w * 0.16, L * 1.06);
      s.add(point);
    }
    py += Math.sin(ang) * L;
    pz += Math.cos(ang) * L;
    ang += 0.077;
  }

  const tip = new THREE.Object3D();
  tip.position.set(0, py, pz);
  g.add(tip);
  g.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = false; } });
  return { group: g, tip, glow: null };
}

function buildHarpoon() {
  const A = weaponAssets();
  const g = new THREE.Group();
  const shaft = new THREE.Mesh(A.geo.shaftZ, A.mat.wood);
  shaft.scale.set(1, 1, 1.75);
  shaft.position.z = 0.42;
  g.add(shaft);
  const grip = new THREE.Mesh(A.geo.shaftZ, A.mat.leather);
  grip.scale.set(1.35, 1.35, 0.26);
  grip.position.z = -0.16;
  g.add(grip);
  const collar = new THREE.Mesh(A.geo.shaftZ, A.mat.brass);
  collar.scale.set(1.5, 1.5, 0.05);
  collar.position.z = 1.2;
  g.add(collar);
  const head = new THREE.Mesh(A.geo.spikeZ, A.mat.steel);
  head.position.z = 1.42;
  g.add(head);
  for (let i = 0; i < 2; i++) {
    const barb = new THREE.Mesh(A.geo.barbZ, A.mat.steel);
    barb.position.set(i ? 0.055 : -0.055, 0, 1.28);
    barb.rotation.z = i ? -0.45 : 0.45;
    g.add(barb);
  }
  const butt = new THREE.Mesh(A.geo.ring, A.mat.brass);
  butt.position.z = -0.33;
  g.add(butt);
  const cord = segMesh(A.geo.cordZ, A.mat.rubber, -0.03, 0.045, -0.3, -0.03, 0.05, 0.35, 0.9);
  g.add(cord);
  const tip = new THREE.Object3D();
  tip.position.z = 1.6;
  g.add(tip);
  g.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = false; } });
  return { group: g, tip, glow: null };
}

function buildSpeargun() {
  const A = weaponAssets();
  const g = new THREE.Group();
  g.add(boxMesh(A.mat.darkSteel, 0.085, 0.1, 0.66, 0, 0, 0.16));
  g.add(boxMesh(A.mat.wood, 0.07, 0.09, 0.3, 0, 0.005, -0.06));
  const grip = boxMesh(A.mat.leather, 0.075, 0.24, 0.1, 0, -0.17, -0.14);
  grip.rotation.x = 0.28;
  g.add(grip);
  const guard = new THREE.Mesh(A.geo.ring, A.mat.darkSteel);
  guard.position.set(0, -0.07, -0.03);
  guard.rotation.y = Math.PI / 2;
  guard.scale.set(1.1, 0.85, 1);
  g.add(guard);
  g.add(boxMesh(A.mat.brass, 0.02, 0.045, 0.03, 0, -0.055, -0.05));
  g.add(boxMesh(A.mat.darkSteel, 0.012, 0.03, 0.62, -0.045, 0.06, 0.2));
  g.add(boxMesh(A.mat.darkSteel, 0.012, 0.03, 0.62, 0.045, 0.06, 0.2));

  const spear = new THREE.Mesh(A.geo.thinZ, A.mat.steel);
  spear.scale.set(1, 1, 1.2);
  spear.position.set(0, 0.062, 0.42);
  g.add(spear);
  const spearTip = new THREE.Mesh(A.geo.spikeZ, A.mat.steel);
  spearTip.scale.set(0.62, 0.62, 0.62);
  spearTip.position.set(0, 0.062, 1.1);
  g.add(spearTip);
  for (let i = 0; i < 2; i++) {
    const x = i ? 0.055 : -0.055;
    g.add(segMesh(A.geo.cordZ, A.mat.rubber, x, 0.075, 0.5, 0.012 * (i ? 1 : -1), 0.062, 0.05, 1.5));
  }
  const muzzle = new THREE.Mesh(A.geo.ring, A.mat.brass);
  muzzle.position.set(0, 0.045, 0.5);
  muzzle.rotation.y = 0;
  muzzle.scale.set(0.8, 0.8, 0.8);
  g.add(muzzle);

  const tip = new THREE.Object3D();
  tip.position.set(0, 0.062, 1.2);
  g.add(tip);
  g.traverse((c) => { if (c.isMesh) c.castShadow = true; });
  return { group: g, tip, glow: null };
}

function buildTrident() {
  const A = weaponAssets();
  const g = new THREE.Group();
  const shaft = new THREE.Mesh(A.geo.shaftZ, A.mat.darkSteel);
  shaft.scale.set(1.05, 1.05, 1.65);
  shaft.position.z = 0.35;
  g.add(shaft);
  const grip = new THREE.Mesh(A.geo.shaftZ, A.mat.leather);
  grip.scale.set(1.35, 1.35, 0.3);
  grip.position.z = -0.2;
  g.add(grip);
  for (let i = 0; i < 3; i++) {
    const r = new THREE.Mesh(A.geo.shaftZ, A.mat.brass);
    r.scale.set(1.45, 1.45, 0.045);
    r.position.z = 0.2 + i * 0.35;
    g.add(r);
  }
  const crown = boxMesh(A.mat.darkSteel, 0.3, 0.06, 0.1, 0, 0, 1.2);
  g.add(crown);
  const glowMats = [];
  const tips = [];
  for (let i = 0; i < 3; i++) {
    const x = (i - 1) * 0.13;
    const long = i === 1 ? 1.22 : 1.0;
    const stem = new THREE.Mesh(A.geo.thinZ, A.mat.darkSteel);
    stem.scale.set(0.85, 0.85, 0.34 * long);
    stem.position.set(x, 0, 1.34);
    g.add(stem);
    const prongMat = A.mat.electric.clone();
    glowMats.push(prongMat);
    const prong = new THREE.Mesh(A.geo.prongZ, prongMat);
    prong.scale.set(1, 1, long);
    prong.position.set(x, 0, 1.72);
    g.add(prong);
    const bead = new THREE.Mesh(A.geo.beadZ, prongMat);
    bead.position.set(x, 0, 1.28);
    bead.scale.setScalar(0.55);
    g.add(bead);
    const spark = makeGlowSprite(0x9fe4ff, 0.3, 0.85);
    spark.position.set(x, 0, 1.72 + 0.26 * long);
    g.add(spark);
    tips.push(spark);
  }
  const halo = makeGlowSprite(0x66c8ff, 0.85, 0.32);
  halo.position.set(0, 0, 1.62);
  g.add(halo);

  const tip = new THREE.Object3D();
  tip.position.set(0, 0, 2.05);
  g.add(tip);
  g.traverse((c) => { if (c.isMesh) c.castShadow = true; });
  return { group: g, tip, glow: { mats: glowMats, tips, halo } };
}

const WEAPON_BUILDERS = {
  bonker: buildBonker,
  harpoon: buildHarpoon,
  cutlass: buildCutlass,
  speargun: buildSpeargun,
  trident: buildTrident,
};

// attack type for a shop weapon def, defaulting to the pre-wave-2 behaviour
function attackKind(def) {
  const a = def && def.attack;
  return (a === 'melee' || a === 'both') ? a : 'ranged';
}
function meleeRange(def) {
  if (!def) return 3.2;
  if (attackKind(def) === 'both') return MELEE_JAB_RANGE;
  return clamp(typeof def.range === 'number' ? def.range : 3.2, 2.5, 4);
}
function meleeDamage(def) {
  if (!def) return 0;
  if (attackKind(def) === 'both' && typeof def.meleeDmg === 'number') return def.meleeDmg;
  return def.dmg;
}

// ------------------------------------------------------------------
// Segment / sphere intersection (returns closest-approach t in [0,1] or -1)
// ------------------------------------------------------------------
function segmentSphere(ax, ay, az, bx, by, bz, cx, cy, cz, r) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len2 = dx * dx + dy * dy + dz * dz;
  const fx = cx - ax, fy = cy - ay, fz = cz - az;
  let t = len2 > 1e-8 ? (fx * dx + fy * dy + fz * dz) / len2 : 0;
  t = clamp(t, 0, 1);
  const px = ax + dx * t - cx, py = ay + dy * t - cy, pz = az + dz * t - cz;
  return (px * px + py * py + pz * pz) <= r * r ? t : -1;
}

// ==================================================================
// MODULE
// ==================================================================
export function initEnemies(ctx) {
  const scene = ctx.scene;

  const root = new THREE.Group();
  root.name = 'enemies';
  scene.add(root);

  const fx = new THREE.Group();
  fx.name = 'combatFX';
  fx.matrixAutoUpdate = false;
  scene.add(fx);

  const sparks = new ParticleField(320, 'spark');
  const bubbles = new ParticleField(260, 'bubble');
  fx.add(sparks.points);
  fx.add(bubbles.points);

  // ---- state -----------------------------------------------------
  const enemies = new Map();          // id -> record
  const pools = new Map();            // type -> [visual]
  const weapons = new Map();          // weaponId -> weapon record
  let snapshotTick = 0;
  let lastStateRef = null;
  let lastHitRef = null;
  let dreadMode = false;
  let camShake = 0;
  let shakeTime = 0;
  let now = 0;
  const shakeApplied = new THREE.Vector3();   // our own offset from last frame
  const lastCamPos = new THREE.Vector3();     // where we left the camera last frame

  // Projectiles (fixed pool, no runtime allocation)
  const projectiles = [];
  for (let i = 0; i < 8; i++) {
    projectiles.push({
      active: false, kind: 'bolt', mesh: null, weaponId: null,
      pos: new THREE.Vector3(), vel: new THREE.Vector3(), prev: new THREE.Vector3(),
      life: 0, travelled: 0, maxRange: 25, gravity: 0, fade: 1, dead: false, trailT: 0,
    });
  }
  let harpoonProjMesh = null;
  let boltProjMesh = null;

  // Trident beam
  let beam = null;
  let beamT = 0;

  // Weapon firing state
  let fireCooldown = 0;
  let harpoonHidden = 0;   // >0 while the thrown harpoon is away from the hand

  // Melee swing state (one at a time)
  const melee = {
    active: false, t: 0, dur: MELEE_SWING, weaponId: null, dealt: false,
    origin: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, 1),
  };

  // ---------------- audio helper ----------------
  function sfx(name, volume, pos) {
    const a = ctx.audio;
    if (!a || typeof a.sfx !== 'function') return;
    try {
      if (pos) a.sfx(name, { volume: volume === undefined ? 1 : volume, pos: [pos.x, pos.y, pos.z] });
      else a.sfx(name, { volume: volume === undefined ? 1 : volume });
    } catch (e) { /* audio must never break the frame */ }
  }

  // ---------------- local player helpers ----------------
  function localChar() {
    const pm = ctx.playerMod;
    const loc = pm && pm.local;
    return (loc && loc.char) || null;
  }

  function getLocalPos(out) {
    const ch = localChar();
    if (ch && ch.group) { ch.group.getWorldPosition(out); return true; }
    const loc = ctx.playerMod && ctx.playerMod.local;
    if (loc) {
      const p = loc.position || loc.pos || (loc.group && loc.group.position);
      if (p) {
        if (Array.isArray(p)) out.set(p[0], p[1], p[2]);
        else if (p.isVector3) out.copy(p);
        else return false;
        return true;
      }
    }
    if (ctx.camera) { ctx.camera.getWorldPosition(out); return true; }
    return false;
  }

  function waterHeight(x, z, t) {
    const f = ctx.getWaterHeight;
    if (typeof f !== 'function') return 0;
    const h = f(x, z, t);
    return typeof h === 'number' && isFinite(h) ? h : 0;
  }

  // ==================================================================
  // Enemy visuals
  // ==================================================================

  // Aligns the fish mesh so its body runs along +Z with the head at +Z.
  // fish.js is authored in parallel, so we detect the long axis from the
  // bounding box and the head end from head-ish child names.
  function orientFish(fishGroup, fixGroup) {
    fixGroup.rotation.set(0, 0, 0);
    fixGroup.updateMatrixWorld(true);
    _box.setFromObject(fixGroup);
    if (_box.isEmpty()) return;
    _box.getSize(_boxSize);
    const span = Math.max(_boxSize.x, _boxSize.z);
    // 1) longest horizontal axis must lie along Z
    if (_boxSize.x > _boxSize.z * 1.12) fixGroup.rotation.y = -Math.PI / 2;
    fixGroup.updateMatrixWorld(true);
    // 2) head features (teeth / jaw / lure / eyes) must sit at +Z
    let z = 0, n = 0;
    fishGroup.traverse((c) => {
      if (!c.name || !HEAD_HINT.test(c.name)) return;
      c.getWorldPosition(_v1);
      z += _v1.z; n++;
    });
    if (n > 0 && (z / n) < -span * 0.06) {
      fixGroup.rotation.y += Math.PI;
      fixGroup.updateMatrixWorld(true);
    }
  }

  function harvestMaterials(obj, out) {
    obj.traverse((c) => {
      if (!c.material) return;
      if (Array.isArray(c.material)) {
        const arr = [];
        for (let i = 0; i < c.material.length; i++) {
          const m = c.material[i].clone();
          arr.push(m);
          out.push(snapshotMaterial(m));
        }
        c.material = arr;
      } else {
        const m = c.material.clone();
        c.material = m;
        out.push(snapshotMaterial(m));
      }
    });
  }

  function snapshotMaterial(m) {
    return {
      mat: m,
      emissive: m.emissive ? m.emissive.clone() : null,
      ei: typeof m.emissiveIntensity === 'number' ? m.emissiveIntensity : 1,
      color: m.color ? m.color.clone() : null,
      opacity: typeof m.opacity === 'number' ? m.opacity : 1,
      transparent: !!m.transparent,
      depthWrite: m.depthWrite !== false,
    };
  }

  function buildVisual(type) {
    const pool = pools.get(type);
    if (pool && pool.length) return pool.pop();

    const vis = visualsFor(type);
    let fishGroup = null;
    try {
      const make = fishFactory && fishFactory.createFishMesh;
      if (typeof make === 'function') fishGroup = make(vis.fishDef, null, 1);
    } catch (e) {
      console.warn('[enemies] createFishMesh failed for ' + type + ', using fallback mesh:', e);
      fishGroup = null;
    }
    if (!fishGroup || !fishGroup.isObject3D) fishGroup = fallbackFishMesh(vis.fishDef);

    // fixGroup carries the orientation correction; measurements below are
    // therefore already in "body faces +Z" space.
    const fixGroup = new THREE.Group();
    fixGroup.add(fishGroup);
    orientFish(fishGroup, fixGroup);

    _box.setFromObject(fixGroup);
    if (_box.isEmpty()) {
      _box.min.set(-0.4, -0.3, -0.8);
      _box.max.set(0.4, 0.3, 0.8);
    }
    _box.getSize(_boxSize);
    _box.getCenter(_boxCtr);

    const mats = [];
    harvestMaterials(fishGroup, mats);
    fishGroup.traverse((c) => {
      if (c.isMesh) { c.castShadow = true; c.receiveShadow = false; }
    });

    // holder = lunge offset; attach = un-rotated space matching the measured box
    const holder = new THREE.Group();
    holder.add(fixGroup);
    const attach = new THREE.Group();
    holder.add(attach);

    // eyes: additive glow sprites parked at the head, dim until aggro
    const eyeSize = Math.max(0.06, _boxSize.z * vis.eyeSize);
    const eyes = [];
    for (let i = 0; i < 2; i++) {
      const s = makeGlowSprite(vis.eyeColor, eyeSize, vis.eyeIdle);
      s.position.set(
        (i ? 1 : -1) * Math.max(0.05, _boxSize.x * 0.3),
        _boxCtr.y + _boxSize.y * 0.16,
        _box.max.z - _boxSize.z * 0.13
      );
      eyes.push(s);
      attach.add(s);
    }

    let lure = null;
    if (vis.lure !== null && vis.lure !== undefined) {
      lure = new THREE.Group();
      const bulb = makeGlowSprite(vis.lure, Math.max(0.2, _boxSize.z * 0.16), 0.95);
      const halo = makeGlowSprite(vis.lure, Math.max(0.5, _boxSize.z * 0.4), 0.25);
      lure.add(bulb);
      lure.add(halo);
      lure.position.set(0, _boxCtr.y + _boxSize.y * 0.62, _box.max.z + _boxSize.z * 0.06);
      lure.userData.bulb = bulb;
      lure.userData.halo = halo;
      attach.add(lure);
    }

    return {
      holder, fixGroup, fishGroup, mats, eyes, lure,
      size: _boxSize.clone(), center: _boxCtr.clone(),
      hasAnim: !!(fishGroup.userData && typeof fishGroup.userData.update === 'function'),
    };
  }

  function releaseVisual(type, visual) {
    if (visual.holder.parent) visual.holder.parent.remove(visual.holder);
    visual.holder.position.set(0, 0, 0);
    // restore neutral material state so the next user starts clean
    for (let i = 0; i < visual.mats.length; i++) {
      const s = visual.mats[i];
      const m = s.mat;
      if (s.emissive && m.emissive) m.emissive.copy(s.emissive);
      if (s.color && m.color) m.color.copy(s.color);
      m.emissiveIntensity = s.ei;
      m.opacity = s.opacity;
      m.depthWrite = s.depthWrite;
      if (m.transparent !== s.transparent) { m.transparent = s.transparent; m.needsUpdate = true; }
    }
    for (let i = 0; i < visual.eyes.length; i++) visual.eyes[i].material.opacity = 0;
    let pool = pools.get(type);
    if (!pool) { pool = []; pools.set(type, pool); }
    if (pool.length < MAX_POOLED) { pool.push(visual); return; }
    // over capacity — drop it, disposing only the materials WE cloned
    for (let i = 0; i < visual.mats.length; i++) visual.mats[i].mat.dispose();
    for (let i = 0; i < visual.eyes.length; i++) visual.eyes[i].material.dispose();
    if (visual.lure) {
      visual.lure.userData.bulb.material.dispose();
      visual.lure.userData.halo.material.dispose();
    }
  }

  function createEnemy(e) {
    const type = ENEMIES[e.type] ? e.type : 'reefshark';
    const def = ENEMIES[type];
    const vis = visualsFor(type);
    const visual = buildVisual(type);

    const wrapper = new THREE.Group();
    wrapper.rotation.order = 'YXZ';
    wrapper.add(visual.holder);
    root.add(wrapper);

    const p = Array.isArray(e.p) ? e.p : [0, -2, 0];
    const rec = {
      id: e.id, type, def, vis, visual, wrapper,
      hp: typeof e.hp === 'number' ? e.hp : def.hp,
      maxHp: def.hp,
      state: e.state || 'idle',
      aggro: false,
      radius: def.size * 0.45 + 0.25,
      fromPos: new THREE.Vector3(p[0], p[1], p[2]),
      toPos: new THREE.Vector3(p[0], p[1], p[2]),
      renderPos: new THREE.Vector3(p[0], p[1], p[2]),
      prevRender: new THREE.Vector3(p[0], p[1], p[2]),
      nudge: new THREE.Vector3(),
      lerp: 1,
      fromYaw: e.r || 0, toYaw: e.r || 0,
      yaw: e.r || 0, pitch: 0, roll: 0,
      animClock: Math.random() * 40,
      phase: Math.random() * Math.PI * 2,
      flash: 0, rim: 0, fade: 1,
      lunge: 0, telegraph: 0, nextTelegraph: 0, lastBite: -10,
      dead: false, deadT: 0, sinkY: 0, sinkVel: 0,
      despawn: 0, seen: snapshotTick,
      bubbleT: 0, eyeLit: vis.eyeIdle,
      _lf: -1, _lr: -1, _ld: -1,
    };
    enemies.set(e.id, rec);
    return rec;
  }

  function destroyEnemy(rec) {
    if (rec.wrapper.parent) rec.wrapper.parent.remove(rec.wrapper);
    releaseVisual(rec.type, rec.visual);
    enemies.delete(rec.id);
  }

  function startDeath(rec) {
    if (rec.dead) return;
    rec.dead = true;
    rec.deadT = 0;
    rec.rim = 0;
    rec.lunge = 0;
    rec.despawn = 0;   // the death animation owns the removal from here on
    sfx('enemyDie', 0.9, rec.renderPos);
    bubbles.burst(rec.renderPos.x, rec.renderPos.y, rec.renderPos.z, 14, 0.9,
      0.16 * rec.def.size, 2.2, 0xdff2ff, 1.1, 0.9, 0, 0, 0, 0);
    sparks.burst(rec.renderPos.x, rec.renderPos.y, rec.renderPos.z, 10, 1.6,
      0.16, 0.5, 0xfff0c8, -1.0, 2.2, 0, 0, 0, 0);
  }

  // ==================================================================
  // Network / bus handlers
  // ==================================================================
  function onEnemyState(payload) {
    if (!payload || payload === lastStateRef) return;
    lastStateRef = payload;
    const list = Array.isArray(payload) ? payload : payload.list;
    if (!Array.isArray(list)) return;

    snapshotTick++;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e || e.id === undefined || e.id === null) continue;
      let rec = enemies.get(e.id);
      if (!rec) rec = createEnemy(e);
      rec.seen = snapshotTick;
      rec.despawn = 0;
      if (e.state) {
        rec.state = e.state;
        const hostile = e.state === 'aggro' || e.state === 'attack' || e.state === 'lunge' || e.state === 'chase';
        if (hostile && !rec.aggro) rec.telegraph = 1;
        rec.aggro = hostile;
      }
      if (typeof e.hp === 'number') {
        if (!rec.dead && e.hp <= 0) startDeath(rec);
        rec.hp = e.hp;
      }
      if (rec.dead) continue;
      if (Array.isArray(e.p)) {
        rec.fromPos.copy(rec.renderPos);
        rec.toPos.set(e.p[0], e.p[1], e.p[2]);
        rec.lerp = 0;
      }
      if (typeof e.r === 'number') {
        rec.fromYaw = rec.yaw;
        rec.toYaw = rec.yaw + shortAngle(rec.yaw, e.r);
      }
    }

    // anything the server stopped reporting fades out
    for (const rec of enemies.values()) {
      if (rec.seen !== snapshotTick && !rec.dead && rec.despawn === 0) rec.despawn = 0.0001;
    }
  }

  function onEnemyHit(payload) {
    if (!payload || payload === lastHitRef) return;
    lastHitRef = payload;
    const rec = enemies.get(payload.enemyId);
    if (!rec) return;
    rec.flash = 1;
    rec.telegraph = Math.max(rec.telegraph, 0.35);
    if (typeof payload.hp === 'number') rec.hp = payload.hp;
    sfx('enemyHurt', 0.85, rec.renderPos);
    bubbles.burst(rec.renderPos.x, rec.renderPos.y, rec.renderPos.z, 5, 0.7,
      0.11 * rec.def.size, 1.3, 0xe6f6ff, 1.0, 1.0, 0, 0, 0, 0);
    if (rec.hp <= 0) startDeath(rec);
  }

  function clearAll() {
    for (const rec of enemies.values()) destroyEnemy(rec);
    enemies.clear();
    for (let i = 0; i < projectiles.length; i++) {
      const pr = projectiles[i];
      pr.active = false;
      if (pr.mesh) pr.mesh.visible = false;
    }
    if (beam) beam.visible = false;
    beamT = 0;
    harpoonHidden = 0;
    melee.active = false;
    melee.t = 0;
    melee.dealt = false;
    fireCooldown = 0;
    camShake = 0;
    sparks.clear();
    bubbles.clear();
  }

  const bus = ctx.bus;
  if (bus && typeof bus.on === 'function') {
    bus.on('enemyState', onEnemyState);
    bus.on('enemyHit', onEnemyHit);
    bus.on('eventStart', () => { dreadMode = true; });
    bus.on('eventEnd', () => { dreadMode = false; });
    bus.on('phase', (p) => { if (p !== 'playing') clearAll(); });
  }
  if (ctx.net && typeof ctx.net.on === 'function') {
    // Belt and braces: work whether main relays these over the bus or not.
    // Duplicate deliveries of the same payload object are filtered above.
    ctx.net.on(MSG.ENEMY_STATE, onEnemyState);
    ctx.net.on(MSG.ENEMY_HIT, onEnemyHit);
  }

  // ==================================================================
  // Weapons
  // ==================================================================
  function weaponDef(id) {
    const d = shopById(id);
    return d && d.kind === 'weapon' ? d : null;
  }

  function ownedWeapons() {
    const gear = ctx.state && ctx.state.gear;
    const list = gear && gear.weapons;
    return Array.isArray(list) ? list : null;
  }

  function currentWeaponId() {
    const st = ctx.state;
    if (!st || st.activeTool !== 'weapon') return null;
    const owned = ownedWeapons();
    if (!owned || owned.length === 0) return null;
    const active = st.gear && st.gear.activeWeapon;
    if (active && owned.indexOf(active) !== -1 && weaponDef(active)) return active;
    // fall back to the best weapon actually owned
    let best = null, bestPrice = -1;
    for (let i = 0; i < owned.length; i++) {
      const d = weaponDef(owned[i]);
      if (d && d.price > bestPrice) { best = owned[i]; bestPrice = d.price; }
    }
    return best;
  }

  function getWeapon(id) {
    let w = weapons.get(id);
    if (w) return w;
    const build = WEAPON_BUILDERS[id];
    if (!build) return null;
    const built = build();
    w = {
      id, group: built.group, tip: built.tip, glow: built.glow || null,
      def: weaponDef(id), attached: false, ready: false, sway: 0, kick: 0,
    };
    w.group.visible = false;
    weapons.set(id, w);
    return w;
  }

  function syncWeapons(dt, t) {
    const activeId = currentWeaponId();
    const st = ctx.state;
    const alive = !st || typeof st.hp !== 'number' || st.hp > 0;
    const playing = !st || st.phase === 'playing';
    const ch = localChar();
    const hand = (ch && ch.bones && ch.bones.handR) || null;

    // build the active weapon lazily so it can be attached on the same frame
    if (activeId) getWeapon(activeId);

    for (const w of weapons.values()) {
      const shouldShow = playing && alive && w.id === activeId && !!hand;
      w.ready = shouldShow;
      if (shouldShow) {
        if (w.group.parent !== hand) {
          hand.add(w.group);
          w.group.rotation.set(-0.12, 0, 0);
          w.group.position.set(0, 0, 0);
        }
        w.attached = true;
      } else if (w.group.parent && w.id !== activeId) {
        w.group.parent.remove(w.group);
        w.attached = false;
      }
      const vis = shouldShow && !(w.id === 'harpoon' && harpoonHidden > 0);
      if (w.group.visible !== vis) w.group.visible = vis;
    }

    if (!activeId) return null;
    const w = weapons.get(activeId);
    if (!w) return null;
    if (!w.def) w.def = weaponDef(activeId);

    // recoil / idle sway
    w.kick = damp(w.kick, 0, 9, dt);
    w.sway = Math.sin(t * 1.6) * 0.012 + Math.sin(t * 2.7) * 0.006;
    if (w.attached && w.group.visible) {
      w.group.position.set(0, w.sway, -w.kick * 0.32);
      aimWeaponForward(w, hand, ch && ch.group, -0.12 + w.kick * 0.5 + w.sway * 0.6);
    }

    // trident idle crackle
    if (w.glow && w.group.visible) {
      const pulse = 1.6 + Math.sin(t * 7.3) * 0.5 + Math.sin(t * 19.1) * 0.28;
      for (let i = 0; i < w.glow.mats.length; i++) w.glow.mats[i].emissiveIntensity = pulse + w.kick * 5;
      for (let i = 0; i < w.glow.tips.length; i++) {
        w.glow.tips[i].material.opacity = 0.55 + Math.sin(t * 11 + i * 2.1) * 0.3 + w.kick * 0.6;
      }
      w.glow.halo.material.opacity = 0.22 + Math.sin(t * 5.5) * 0.09 + w.kick * 0.5;
      // subtle arc particles around the prongs
      if (Math.random() < dt * 22) {
        w.tip.getWorldPosition(_v1);
        sparks.spawn(
          _v1.x + (Math.random() - 0.5) * 0.34,
          _v1.y + (Math.random() - 0.5) * 0.34,
          _v1.z + (Math.random() - 0.5) * 0.2,
          (Math.random() - 0.5) * 0.7, (Math.random() - 0.5) * 0.7 + 0.3, (Math.random() - 0.5) * 0.7,
          0.075, 0.22, 0x9fe4ff, 0, 3.0
        );
      }
    }
    return w;
  }

  // The weapon models are built pointing down +Z, but we don't know how
  // player.js orients the handR bone (it may be rolled with the arm swing).
  // Cancel the hand's world rotation and re-apply the character's, so the
  // weapon always presents forward from the body no matter the rig or anim.
  function aimWeaponForward(w, hand, charGroup, pitch) {
    _qOff.setFromAxisAngle(_axisX, pitch);
    if (!charGroup || charGroup === hand) {
      w.group.quaternion.copy(_qOff);
      return;
    }
    hand.updateWorldMatrix(true, false);
    charGroup.updateWorldMatrix(true, false);
    hand.matrixWorld.decompose(_v1, _qHand, _v2);
    charGroup.matrixWorld.decompose(_v1, _qChar, _v2);
    w.group.quaternion.copy(_qHand).invert().multiply(_qChar).multiply(_qOff);
  }

  function aimFrom(w, range, outOrigin, outDir) {
    const cam = ctx.camera;
    cam.getWorldPosition(_camPos);
    cam.getWorldDirection(_camDir);
    _v4.copy(_camPos).addScaledVector(_camDir, range + 8);
    if (w && w.group.parent && w.group.visible) w.tip.getWorldPosition(outOrigin);
    else outOrigin.copy(_camPos).addScaledVector(_camDir, 0.7);
    outDir.copy(_v4).sub(outOrigin);
    if (outDir.lengthSq() < 1e-6) outDir.copy(_camDir);
    outDir.normalize();
  }

  function projectileMesh(kind) {
    const A = weaponAssets();
    if (kind === 'harpoon') {
      if (!harpoonProjMesh) {
        const b = buildHarpoon();
        harpoonProjMesh = b.group;
        harpoonProjMesh.visible = false;
        harpoonProjMesh.traverse((c) => { if (c.isMesh) c.castShadow = false; });
        fx.add(harpoonProjMesh);
      }
      return harpoonProjMesh;
    }
    if (!boltProjMesh) {
      const g = new THREE.Group();
      const shaft = new THREE.Mesh(A.geo.thinZ, A.mat.steel);
      shaft.scale.set(0.85, 0.85, 0.9);
      g.add(shaft);
      const head = new THREE.Mesh(A.geo.spikeZ, A.mat.steel);
      head.scale.set(0.55, 0.55, 0.55);
      head.position.z = 0.53;
      g.add(head);
      const fin = boxMesh(A.mat.darkSteel, 0.008, 0.05, 0.14, 0, 0, -0.42);
      g.add(fin);
      const fin2 = boxMesh(A.mat.darkSteel, 0.05, 0.008, 0.14, 0, 0, -0.42);
      g.add(fin2);
      g.visible = false;
      boltProjMesh = g;
      fx.add(boltProjMesh);
    }
    return boltProjMesh;
  }

  function spawnProjectile(kind, weaponId, origin, dir, speed, range, gravity) {
    let pr = null;
    for (let i = 0; i < projectiles.length; i++) {
      if (!projectiles[i].active) { pr = projectiles[i]; break; }
    }
    if (!pr) pr = projectiles[0];
    pr.active = true;
    pr.kind = kind;
    pr.weaponId = weaponId;
    pr.pos.copy(origin);
    pr.prev.copy(origin);
    pr.vel.copy(dir).multiplyScalar(speed);
    pr.life = 0;
    pr.travelled = 0;
    pr.maxRange = range;
    pr.gravity = gravity;
    pr.fade = 1;
    pr.dead = false;
    pr.trailT = 0;
    pr.mesh = projectileMesh(kind === 'harpoon' ? 'harpoon' : 'bolt');
    pr.mesh.scale.setScalar(1);
    pr.mesh.visible = true;
    return pr;
  }

  // best enemy hit along a segment; returns the record or null
  function hitScan(ax, ay, az, bx, by, bz, extra, outPoint) {
    let best = null, bestT = 2;
    for (const rec of enemies.values()) {
      if (rec.dead || rec.despawn > 0) continue;
      const t = segmentSphere(ax, ay, az, bx, by, bz,
        rec.renderPos.x, rec.renderPos.y + rec.visual.center.y * 0.4, rec.renderPos.z,
        rec.radius + extra);
      if (t >= 0 && t < bestT) { bestT = t; best = rec; }
    }
    if (best && outPoint) {
      outPoint.set(ax + (bx - ax) * bestT, ay + (by - ay) * bestT, az + (bz - az) * bestT);
    }
    return best;
  }

  // dmgOverride / kind are optional: ranged callers pass neither and keep the
  // original behaviour, melee callers pass the weapon's melee damage + 'melee'.
  function dealDamage(rec, def, weaponId, point, dirX, dirY, dirZ, dmgOverride, kind) {
    if (!rec || rec.dead) return;
    const dmg = typeof dmgOverride === 'number' ? dmgOverride : def.dmg;
    if (ctx.net && typeof ctx.net.send === 'function') {
      ctx.net.send(MSG.DAMAGE_ENEMY, { enemyId: rec.id, dmg, weaponId });
    }
    // local feedback (server confirms with ENEMY_HIT)
    const isMelee = kind === 'melee';
    rec.flash = Math.max(rec.flash, isMelee ? 1 : 0.85);
    rec.telegraph = Math.max(rec.telegraph, isMelee ? 0.6 : 0);
    const push = isMelee ? 0.62 : 0.42;
    rec.nudge.x += dirX * push;
    rec.nudge.y += dirY * (isMelee ? 0.3 : 0.22);
    rec.nudge.z += dirZ * push;
    if (isMelee) meleeImpactFX(point, dirX, dirY, dirZ, false);
    else impactFX(point, dirX, dirY, dirZ, weaponId);
  }

  // The thwack: a white pop on contact plus a small radial puff of grit,
  // kicked back along the swing so it reads as a solid connection.
  // `soft` = a landed catch rather than an enemy; the sound for those is
  // fishing.js's to play when the server confirms the hit, so we stay quiet.
  function meleeImpactFX(p, dx, dy, dz, soft) {
    if (!soft) sfx('bonk', 0.9, p);
    sparks.burst(p.x, p.y, p.z, soft ? 17 : 14, soft ? 2.5 : 3.1,
      soft ? 0.135 : 0.115, soft ? 0.34 : 0.28,
      soft ? 0xfff0b4 : 0xfff6e0, -3.2, 4.2, -dx, -dy, -dz, 1.1);
    sparks.burst(p.x, p.y, p.z, 6, 0.55, 0.2, 0.14, 0xffffff, 0, 6.5, 0, 0, 0, 0);
    const t = ctx.clock ? ctx.clock.getElapsedTime() : 0;
    if (p.y < waterHeight(p.x, p.z, t)) {
      bubbles.burst(p.x, p.y, p.z, 7, 1.1, 0.09, 1.0, 0xdff0ff, 1.2, 1.2, 0, 0, 0, 0);
    }
  }

  function impactFX(p, dx, dy, dz, weaponId) {
    const zap = weaponId === 'trident';
    sfx('impact', zap ? 0.95 : 0.8, p);
    sparks.burst(p.x, p.y, p.z, zap ? 22 : 14, zap ? 4.5 : 3.0,
      zap ? 0.15 : 0.11, zap ? 0.42 : 0.32,
      zap ? 0xa8e8ff : 0xfff0cc, -2.0, 3.4, -dx, -dy, -dz, zap ? 1.5 : 2.2);
    const t = ctx.clock ? ctx.clock.getElapsedTime() : 0;
    if (p.y < waterHeight(p.x, p.z, t)) {
      bubbles.burst(p.x, p.y, p.z, 8, 1.2, 0.1, 1.1, 0xdff0ff, 1.2, 1.2, 0, 0, 0, 0);
    }
  }

  function ensureBeam() {
    if (beam) return beam;
    const geo = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
    geo.rotateX(Math.PI / 2);
    beam = new THREE.Group();
    const core = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0xeafaff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, fog: false,
    }));
    const outer = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0x59b4ff, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, fog: false,
    }));
    beam.add(core);
    beam.add(outer);
    beam.userData.core = core;
    beam.userData.outer = outer;
    beam.visible = false;
    beam.renderOrder = 5;
    fx.add(beam);
    return beam;
  }

  function fireWeapon(w, t) {
    const def = w.def || weaponDef(w.id);
    if (!def) return;
    w.kick = 1;
    aimFrom(w, def.range, _v1, _v2);   // _v1 = origin, _v2 = dir

    if (w.id === 'harpoon') {
      const under = _v1.y < waterHeight(_v1.x, _v1.z, t);
      _v3.copy(_v2);
      if (!under) { _v3.y += 0.055; _v3.normalize(); }
      spawnProjectile('harpoon', 'harpoon', _v1, _v3,
        under ? HARPOON_SPEED * 0.62 : HARPOON_SPEED,
        def.range, under ? -1.4 : -HARPOON_GRAVITY);
      harpoonHidden = HARPOON_RETURN;
      sfx('harpoonThrow', 1.0, _v1);
      sparks.burst(_v1.x, _v1.y, _v1.z, 5, 1.2, 0.08, 0.2, 0xffe9c0, 0, 4, 0, 0, 0, 0);
    } else if (w.id === 'speargun') {
      spawnProjectile('bolt', 'speargun', _v1, _v2, BOLT_SPEED, def.range, -0.9);
      sfx('spearShot', 1.0, _v1);
      const under = _v1.y < waterHeight(_v1.x, _v1.z, t);
      if (under) bubbles.burst(_v1.x, _v1.y, _v1.z, 7, 0.9, 0.07, 0.8, 0xdff0ff, 1.1, 1.4, 0, 0, 0, 0);
      else sparks.burst(_v1.x, _v1.y, _v1.z, 4, 0.9, 0.07, 0.16, 0xffffff, 0, 5, 0, 0, 0, 0);
    } else if (w.id === 'trident') {
      const range = def.range;
      _v4.copy(_v1).addScaledVector(_v2, range);
      const hit = hitScan(_v1.x, _v1.y, _v1.z, _v4.x, _v4.y, _v4.z, 0.45, _v5);
      const endX = hit ? _v5.x : _v4.x, endY = hit ? _v5.y : _v4.y, endZ = hit ? _v5.z : _v4.z;
      const b = ensureBeam();
      _v3.set(endX - _v1.x, endY - _v1.y, endZ - _v1.z);
      const len = Math.max(0.2, _v3.length());
      _v3.multiplyScalar(1 / len);
      b.quaternion.setFromUnitVectors(_axisZ, _v3);
      b.position.set((_v1.x + endX) / 2, (_v1.y + endY) / 2, (_v1.z + endZ) / 2);
      b.userData.core.scale.set(0.05, 0.05, len);
      b.userData.outer.scale.set(0.2, 0.2, len);
      b.visible = true;
      beamT = BEAM_TIME;
      sfx('tridentZap', 1.0, _v1);
      // crackle along the lance
      const steps = Math.min(26, Math.max(6, Math.floor(len * 1.1)));
      for (let i = 0; i < steps; i++) {
        const f = i / steps;
        sparks.spawn(
          _v1.x + (endX - _v1.x) * f + (Math.random() - 0.5) * 0.3,
          _v1.y + (endY - _v1.y) * f + (Math.random() - 0.5) * 0.3,
          _v1.z + (endZ - _v1.z) * f + (Math.random() - 0.5) * 0.3,
          (Math.random() - 0.5) * 1.4, (Math.random() - 0.5) * 1.4, (Math.random() - 0.5) * 1.4,
          0.1, 0.18 + Math.random() * 0.2, i % 3 === 0 ? 0xffffff : 0x8fd8ff, 0, 2.4
        );
      }
      if (hit) dealDamage(hit, def, 'trident', _v5, _v2.x, _v2.y, _v2.z);
    }
  }

  // ==================================================================
  // Melee — swing arc, hit resolution, and bonking your own landed catch
  // ==================================================================

  // Swing from the chest, along the look direction (so a fish flopping at
  // your boots is still inside the arc).
  function meleeAim(outOrigin, outDir) {
    const cam = ctx.camera;
    if (cam) { cam.getWorldPosition(_camPos); cam.getWorldDirection(_camDir); }
    if (getLocalPos(_localPos)) { outOrigin.copy(_localPos); outOrigin.y += 1.05; }
    else outOrigin.copy(_camPos);
    outDir.copy(_camDir);
    if (outDir.lengthSq() < 1e-6) outDir.set(0, 0, 1);
    outDir.normalize();
  }

  function inMeleeArc(cx, cy, cz, radius, range, origin, dir) {
    _v3.set(cx - origin.x, cy - origin.y, cz - origin.z);
    const d = _v3.length();
    if (d - radius > range) return -1;
    if (d <= MELEE_NEAR) return d;
    _v3.multiplyScalar(1 / d);
    return _v3.dot(dir) >= MELEE_ARC_DOT ? d : -1;
  }

  // Is anything worth jabbing right now? Drives the trident's jab-or-fire choice.
  function meleeTargetInRange(range) {
    meleeAim(melee.origin, melee.dir);
    for (const rec of enemies.values()) {
      if (rec.dead || rec.despawn > 0) continue;
      if (inMeleeArc(rec.renderPos.x, rec.renderPos.y + rec.visual.center.y * 0.4, rec.renderPos.z,
        rec.radius, range, melee.origin, melee.dir) >= 0) return true;
    }
    return flopperInRange(melee.origin, melee.dir, range) !== null;
  }

  // fishing.js owns the floppers; we only ever ask it politely.
  function flopperInRange(origin, dir, range) {
    const f = ctx.fishing;
    if (!f || typeof f.tryBonk !== 'function') return null;
    let id = null;
    try { id = f.tryBonk(origin, dir, range); } catch (e) { id = null; }
    return (id === null || id === undefined) ? null : id;
  }

  function bonkFlopper(origin, dir, range, dmg) {
    const id = flopperInRange(origin, dir, range);
    if (id === null) return false;
    if (ctx.net && typeof ctx.net.send === 'function') {
      ctx.net.send(MSG.BONK_FISH, { flopperId: id, dmg });
    }
    // thwack where the fish actually is, if fishing.js will tell us
    _impactP.copy(origin).addScaledVector(dir, Math.min(range, 1.4));
    const f = ctx.fishing;
    const map = f && f.floppers;
    const rec = (map && typeof map.get === 'function') ? map.get(id) : null;
    if (rec && rec.pos && rec.pos.isVector3) _impactP.copy(rec.pos);
    meleeImpactFX(_impactP, dir.x, dir.y, dir.z, true);
    return true;
  }

  function startMelee(w, def) {
    melee.active = true;
    melee.t = 0;
    melee.dur = MELEE_SWING;
    melee.weaponId = w.id;
    melee.dealt = false;
    meleeAim(melee.origin, melee.dir);
    w.kick = 0.5;
    sfx('castWhoosh', 0.55);
    const ch = localChar();
    // remote players only see the networked action, so play one for them too
    if (ch && typeof ch.setAnim === 'function') { try { ch.setAnim('cast'); } catch (e) { /* rig optional */ } }
  }

  function resolveMelee() {
    const def = weaponDef(melee.weaponId);
    if (!def) return;
    const range = meleeRange(def);
    const dmg = meleeDamage(def);
    meleeAim(melee.origin, melee.dir);   // re-aim on contact: the swing tracks the look

    let hits = 0;
    for (const rec of enemies.values()) {
      if (hits >= MELEE_MAX_TARGETS) break;
      if (rec.dead || rec.despawn > 0) continue;
      const cy = rec.renderPos.y + rec.visual.center.y * 0.4;
      const d = inMeleeArc(rec.renderPos.x, cy, rec.renderPos.z, rec.radius, range, melee.origin, melee.dir);
      if (d < 0) continue;
      _v4.set(rec.renderPos.x - melee.origin.x, cy - melee.origin.y, rec.renderPos.z - melee.origin.z);
      if (_v4.lengthSq() > 1e-6) _v4.normalize(); else _v4.copy(melee.dir);
      _v5.copy(melee.origin).addScaledVector(_v4, Math.max(0.25, d - rec.radius * 0.55));
      dealDamage(rec, def, melee.weaponId, _v5, _v4.x, _v4.y, _v4.z, dmg, 'melee');
      hits++;
    }
    // your own landed catch is a perfectly valid thing to hit
    if (bonkFlopper(melee.origin, melee.dir, range, dmg)) hits++;

    if (hits > 0) camShake = Math.min(1.2, camShake + 0.16);
  }

  function updateMelee(dt, w) {
    if (!melee.active) return;
    const st = ctx.state;
    if (st && (st.phase !== 'playing' || (typeof st.hp === 'number' && st.hp <= 0))) {
      melee.active = false;
      return;
    }
    melee.t += dt;
    if (!melee.dealt && melee.t >= MELEE_CONTACT) {
      melee.dealt = true;
      resolveMelee();
    }
    const k = clamp(melee.t / melee.dur, 0, 1);
    const wk = MELEE_WINDUP / melee.dur;
    let arm, pitch, lean;
    if (k < wk) {
      const u = k / wk;
      const e = u * u;
      arm = -0.55 - 1.75 * e;        // cock the arm up and back
      pitch = -0.12 - 1.15 * e;
      lean = -0.09 * e;
    } else {
      const u = (k - wk) / (1 - wk);
      const e = 1 - Math.pow(1 - u, 2.6);   // snap down, then settle
      arm = -2.30 + 2.72 * e;
      pitch = -1.27 + 2.12 * e;             // ~120 degrees of arc
      lean = -0.09 + 0.34 * e * (1 - u * 0.45);
    }

    // We run after player.js has posed the rig, so writing bones here wins for
    // this frame and player.js damps back out of it on the next one.
    const ch = localChar();
    if (ch && ch.bones) {
      const b = ch.bones;
      if (b.armR) { b.armR.rotation.x = arm; b.armR.rotation.y = -0.12; b.armR.rotation.z = 0.26; }
      if (b.foreR) b.foreR.rotation.x = -0.62 + 0.42 * k;
      if (b.armL) b.armL.rotation.x += ((arm * 0.22) - b.armL.rotation.x) * 0.35;
      if (b.hips) b.hips.rotation.x += (lean - b.hips.rotation.x) * 0.55;
      if (b.head) b.head.rotation.x += ((lean * 0.55) - b.head.rotation.x) * 0.45;
    }

    if (w && w.id === melee.weaponId && w.attached && w.group.visible && w.group.parent) {
      aimWeaponForward(w, w.group.parent, ch && ch.group, pitch);
      w.group.position.set(0, w.sway, Math.max(0, lean) * 0.36);
    }

    if (melee.t >= melee.dur) melee.active = false;
  }

  function updateProjectiles(dt, t) {
    for (let i = 0; i < projectiles.length; i++) {
      const pr = projectiles[i];
      if (!pr.active) continue;
      pr.life += dt;

      if (pr.dead) {
        pr.fade -= dt * 4.5;
        const owns = pr.mesh && activeMeshOwner(pr) === pr.mesh;
        if (owns) {
          pr.mesh.scale.setScalar(Math.max(0.001, pr.fade));
          pr.mesh.visible = pr.fade > 0.02;
        }
        if (pr.fade <= 0) {
          pr.active = false;
          if (owns) { pr.mesh.visible = false; pr.mesh.scale.setScalar(1); }
        }
        continue;
      }

      pr.prev.copy(pr.pos);
      const under = pr.pos.y < waterHeight(pr.pos.x, pr.pos.z, t);
      if (under) {
        const drag = Math.exp(-(pr.kind === 'harpoon' ? 1.5 : 0.85) * dt);
        pr.vel.multiplyScalar(drag);
        pr.vel.y += (pr.gravity * 0.35) * dt;
      } else {
        pr.vel.y += pr.gravity * dt;
      }
      pr.pos.addScaledVector(pr.vel, dt);
      pr.travelled += pr.prev.distanceTo(pr.pos);

      // trail
      pr.trailT -= dt;
      if (pr.trailT <= 0) {
        pr.trailT = 0.018;
        if (under) {
          bubbles.spawn(
            pr.pos.x + (Math.random() - 0.5) * 0.06,
            pr.pos.y + (Math.random() - 0.5) * 0.06,
            pr.pos.z + (Math.random() - 0.5) * 0.06,
            (Math.random() - 0.5) * 0.3, 0.35 + Math.random() * 0.5, (Math.random() - 0.5) * 0.3,
            0.06 + Math.random() * 0.05, 0.7 + Math.random() * 0.5, 0xdff0ff, 0.5, 0.9
          );
        } else if (pr.kind === 'bolt') {
          sparks.spawn(pr.pos.x, pr.pos.y, pr.pos.z, 0, 0, 0, 0.05, 0.1, 0xdfefff, 0, 1);
        }
      }

      // orient + place
      if (pr.mesh && activeMeshOwner(pr) === pr.mesh) {
        _v1.copy(pr.vel);
        if (_v1.lengthSq() > 1e-6) {
          _v1.normalize();
          _quat.setFromUnitVectors(_axisZ, _v1);
          pr.mesh.quaternion.copy(_quat);
        }
        pr.mesh.position.copy(pr.pos);
        pr.mesh.visible = true;
      }

      // hit test along this step
      const def = weaponDef(pr.weaponId);
      const rec = hitScan(pr.prev.x, pr.prev.y, pr.prev.z, pr.pos.x, pr.pos.y, pr.pos.z, 0.1, _v5);
      if (rec && def) {
        _v1.copy(pr.vel).normalize();
        dealDamage(rec, def, pr.weaponId, _v5, _v1.x, _v1.y, _v1.z);
        pr.dead = true;
        continue;
      }

      // terrain / sea floor / range stop
      let stop = pr.travelled >= pr.maxRange || pr.life > 3.5;
      if (!stop) {
        const wmod = ctx.world;
        if (wmod && typeof wmod.getTerrainHeight === 'function') {
          const gh = wmod.getTerrainHeight(pr.pos.x, pr.pos.z);
          if (typeof gh === 'number' && isFinite(gh) && pr.pos.y <= gh + 0.05) {
            stop = true;
            _v5.copy(pr.pos);
            _v1.copy(pr.vel).normalize();
            impactFX(_v5, _v1.x, _v1.y, _v1.z, pr.weaponId);
          }
        }
      }
      if (stop) pr.dead = true;
    }

    // trident beam decay
    if (beamT > 0) {
      beamT -= dt;
      const f = clamp(beamT / BEAM_TIME, 0, 1);
      const flick = 0.65 + Math.random() * 0.35;
      beam.userData.core.material.opacity = f * flick;
      beam.userData.outer.material.opacity = f * 0.6 * flick;
      const s = 0.85 + Math.random() * 0.4;
      beam.userData.core.scale.x = beam.userData.core.scale.y = 0.05 * s * (0.4 + f * 0.8);
      beam.userData.outer.scale.x = beam.userData.outer.scale.y = 0.2 * s * (0.35 + f * 0.9);
      if (beamT <= 0) beam.visible = false;
    }
  }

  // Only one projectile may drive a shared mesh at a time; the newest wins.
  function activeMeshOwner(pr) {
    let owner = null;
    for (let i = 0; i < projectiles.length; i++) {
      const o = projectiles[i];
      if (!o.active || o.mesh !== pr.mesh) continue;
      if (!owner || o.life < owner.life) owner = o;
    }
    return owner === pr ? pr.mesh : null;
  }

  // Keeps the weapon models in sync, fires when asked, and hands the active
  // weapon record back so update() doesn't have to look it up a second time.
  function updateFiring(dt, t) {
    fireCooldown = Math.max(0, fireCooldown - dt);
    if (harpoonHidden > 0) harpoonHidden = Math.max(0, harpoonHidden - dt);

    const w = syncWeapons(dt, t);
    const st = ctx.state;
    let ok = !!(w && w.ready) && !!st && st.phase === 'playing';
    if (ok && typeof st.hp === 'number' && st.hp <= 0) ok = false;
    const input = ctx.input;
    if (ok && (!input || !input.mouseDown)) ok = false;
    // don't shoot through open menus — a locked pointer means we're really playing
    if (ok && !input.pointerLocked && !document.pointerLockElement) ok = false;
    if (ok && ctx.fishing && typeof ctx.fishing.isCasting === 'function' && ctx.fishing.isCasting()) ok = false;
    if (ok && (fireCooldown > 0 || melee.active)) ok = false;

    if (ok) {
      const def = w.def || weaponDef(w.id);
      if (def) {
        fireCooldown = 1 / Math.max(0.1, def.rate);
        const kind = attackKind(def);
        // 'both' (Storm Trident): jab what is already on top of you, otherwise unleash.
        if (kind === 'melee' || (kind === 'both' && meleeTargetInRange(MELEE_JAB_RANGE))) startMelee(w, def);
        else fireWeapon(w, t);
      }
    }
    // a swing already under way finishes even if the weapon is being stowed
    updateMelee(dt, w);
    return w;
  }

  // ==================================================================
  // Per-frame enemy update
  // ==================================================================
  function applyMaterialState(rec) {
    const flash = rec.flash, rim = rec.rim, fade = rec.fade;
    if (Math.abs(flash - rec._lf) < 0.004 && Math.abs(rim - rec._lr) < 0.004 && Math.abs(fade - rec._ld) < 0.004) return;
    rec._lf = flash; rec._lr = rim; rec._ld = fade;
    const mats = rec.visual.mats;
    for (let i = 0; i < mats.length; i++) {
      const s = mats[i];
      const m = s.mat;
      if (s.emissive && m.emissive) {
        m.emissive.copy(s.emissive);
        if (rim > 0.002) m.emissive.lerp(C_RIM, clamp(rim * 0.55, 0, 0.8));
        if (flash > 0.002) m.emissive.lerp(C_WHITE, clamp(flash, 0, 1));
        m.emissiveIntensity = s.ei + rim * 0.85 + flash * 2.6;
      } else if (s.color && m.color) {
        m.color.copy(s.color);
        if (rim > 0.002) m.color.lerp(C_RIM, rim * 0.28);
        if (flash > 0.002) m.color.lerp(C_WHITE, flash * 0.8);
      }
      if (fade < 0.999) {
        if (!m.transparent) { m.transparent = true; m.needsUpdate = true; }
        m.depthWrite = false;
        m.opacity = s.opacity * fade;
      } else {
        if (m.transparent !== s.transparent) { m.transparent = s.transparent; m.needsUpdate = true; }
        m.depthWrite = s.depthWrite;
        m.opacity = s.opacity;
      }
    }
  }

  function updateEnemy(rec, dt, t, weaponActive, weaponRange, hasLocal) {
    const vis = rec.vis;

    // ---- despawn (server dropped it) ----
    if (rec.despawn > 0) {
      rec.despawn += dt;
      rec.fade = clamp(1 - rec.despawn / DESPAWN_FADE, 0, 1);
      if (rec.despawn >= DESPAWN_FADE) { destroyEnemy(rec); return; }
    } else if (!rec.dead) {
      rec.fade = 1;   // it came back into the server's report — restore opacity
    }

    // ---- interpolate ----
    rec.prevRender.copy(rec.renderPos);
    if (!rec.dead) {
      rec.lerp = Math.min(1, rec.lerp + dt / INTERP_TIME);
      const e = rec.lerp * rec.lerp * (3 - 2 * rec.lerp);
      rec.renderPos.lerpVectors(rec.fromPos, rec.toPos, e);
    }

    // knockback nudge decays
    if (rec.nudge.lengthSq() > 1e-6) {
      rec.nudge.multiplyScalar(Math.exp(-7 * dt));
      if (rec.nudge.lengthSq() < 1e-6) rec.nudge.set(0, 0, 0);
    }

    // ---- death ----
    if (rec.dead) {
      rec.deadT += dt;
      rec.sinkVel = Math.min(1.15, 0.12 + rec.deadT * 0.6);
      rec.sinkY -= rec.sinkVel * dt;
      rec.roll = damp(rec.roll, Math.PI, 3.0, dt);
      rec.pitch = damp(rec.pitch, 0.12, 2.0, dt);
      rec.fade = Math.min(rec.fade, clamp((DEATH_TIME - rec.deadT) / 0.9, 0, 1));
      rec.bubbleT -= dt;
      if (rec.bubbleT <= 0) {
        rec.bubbleT = 0.085;
        const sx = (Math.random() - 0.5) * rec.visual.size.x * 1.2;
        const sz = (Math.random() - 0.5) * rec.visual.size.z * 0.9;
        bubbles.spawn(
          rec.renderPos.x + sx, rec.renderPos.y + rec.sinkY + 0.1, rec.renderPos.z + sz,
          (Math.random() - 0.5) * 0.2, 0.5 + Math.random() * 0.6, (Math.random() - 0.5) * 0.2,
          0.07 + Math.random() * 0.07, 1.4 + Math.random() * 1.0, 0xe4f4ff, 0.55, 0.8
        );
      }
      if (rec.deadT >= DEATH_TIME) { destroyEnemy(rec); return; }
    }

    // ---- facing ----
    _v1.subVectors(rec.renderPos, rec.prevRender);
    const speed = dt > 0 ? _v1.length() / dt : 0;
    let desiredYaw = rec.yaw, desiredPitch = rec.pitch;
    if (!rec.dead && speed > 0.35) {
      desiredYaw = Math.atan2(_v1.x, _v1.z);
      const hor = Math.sqrt(_v1.x * _v1.x + _v1.z * _v1.z);
      desiredPitch = -Math.atan2(_v1.y, Math.max(0.0001, hor));
      desiredPitch = clamp(desiredPitch, -0.85, 0.85);
    } else if (!rec.dead) {
      desiredYaw = rec.toYaw;
      desiredPitch = 0;
    }
    const yawErr = shortAngle(rec.yaw, desiredYaw);
    const turn = yawErr * (1 - Math.exp(-(rec.dead ? 1.2 : 6.5) * dt));
    rec.yaw += turn;
    rec.pitch = damp(rec.pitch, desiredPitch, rec.dead ? 2 : 5, dt);
    if (!rec.dead) rec.roll = damp(rec.roll, clamp(-turn / Math.max(dt, 0.001) * 0.12, -0.6, 0.6), 5, dt);

    // ---- transform ----
    const bob = rec.dead ? 0 : Math.sin(t * 1.15 + rec.phase) * 0.05 * vis.bob;
    rec.wrapper.position.set(
      rec.renderPos.x + rec.nudge.x,
      rec.renderPos.y + rec.nudge.y + rec.sinkY + bob,
      rec.renderPos.z + rec.nudge.z
    );
    rec.wrapper.rotation.set(rec.pitch, rec.yaw, rec.roll);

    // ---- aggro / telegraph / lunge ----
    const aggro = rec.aggro && !rec.dead;
    if (aggro) {
      rec.nextTelegraph -= dt;
      if (rec.nextTelegraph <= 0) {
        rec.nextTelegraph = 2.0 + Math.random() * 1.6;
        rec.telegraph = 1;
      }
    }
    rec.telegraph = Math.max(0, rec.telegraph - dt * 2.6);
    rec.lunge = Math.max(0, rec.lunge - dt * 3.4);
    const pulse = rec.telegraph * rec.telegraph;
    const s = 1 + pulse * 0.14 + rec.lunge * 0.22;
    rec.wrapper.scale.set(s, s, s + rec.lunge * 0.18);

    // dart forward while lunging
    if (rec.lunge > 0.01) {
      rec.visual.holder.position.z = rec.lunge * rec.visual.size.z * 0.22;
    } else if (rec.visual.holder.position.z !== 0) {
      rec.visual.holder.position.z = 0;
    }

    // ---- swim animation ----
    const speedFactor = clamp(speed / Math.max(1, rec.def.speed), 0, 1.6);
    const rate = vis.animBase * (aggro ? 2.1 : 1.0) * (0.75 + speedFactor * 0.9) * (rec.dead ? 0.25 : 1) * (dreadMode ? 1.15 : 1);
    rec.animClock += dt * rate;
    if (rec.visual.hasAnim) {
      try { rec.visual.fishGroup.userData.update(rec.animClock); } catch (e) { rec.visual.hasAnim = false; }
    }

    // ---- eyes ----
    const eyeTarget = rec.dead ? 0 : (aggro ? 1 : (dreadMode ? vis.eyeIdle * 2.2 : vis.eyeIdle));
    rec.eyeLit = damp(rec.eyeLit, eyeTarget, aggro ? 12 : 4, dt);
    const flicker = aggro ? (0.82 + Math.sin(t * 17 + rec.phase) * 0.18) : 1;
    const eyeBase = Math.max(0.06, rec.visual.size.z * vis.eyeSize);
    const eyeScale = eyeBase * (1 + pulse * 0.5 + (aggro ? 0.35 : 0));
    for (let i = 0; i < rec.visual.eyes.length; i++) {
      const sprite = rec.visual.eyes[i];
      const em = sprite.material;
      em.opacity = clamp(rec.eyeLit * flicker * rec.fade, 0, 1);
      em.color.setHex(aggro ? 0xff2a12 : vis.eyeColor);
      sprite.scale.set(eyeScale, eyeScale, 1);
    }

    // ---- angler lure ----
    if (rec.visual.lure) {
      const lp = 0.7 + Math.sin(t * 2.2 + rec.phase) * 0.3;
      const ud = rec.visual.lure.userData;
      ud.bulb.material.opacity = clamp((aggro ? 1 : 0.85) * lp * rec.fade, 0, 1);
      ud.halo.material.opacity = clamp(0.3 * lp * rec.fade, 0, 1);
      rec.visual.lure.position.y = rec.visual.center.y + rec.visual.size.y * 0.62 + Math.sin(t * 1.7 + rec.phase) * 0.08;
      rec.visual.lure.position.x = Math.sin(t * 1.1 + rec.phase) * 0.09;
      if (aggro && Math.random() < dt * 6) {
        rec.visual.lure.getWorldPosition(_v2);
        sparks.spawn(_v2.x, _v2.y, _v2.z,
          (Math.random() - 0.5) * 0.2, 0.1 + Math.random() * 0.2, (Math.random() - 0.5) * 0.2,
          0.09, 0.6, vis.lure, 0, 1.4);
      }
    }

    // ---- bite feedback on the local player (visuals only, damage is server-side) ----
    if (aggro && hasLocal) {
      const d2 = rec.renderPos.distanceToSquared(_localPos);
      if (d2 < BITE_RANGE * BITE_RANGE && now - rec.lastBite > BITE_COOLDOWN) {
        rec.lastBite = now;
        rec.lunge = 1;
        rec.telegraph = 1;
        camShake = Math.min(1.4, camShake + 0.85);
        sfx('impact', 0.75, rec.renderPos);
        _v2.subVectors(_localPos, rec.renderPos);
        if (_v2.lengthSq() > 1e-5) _v2.normalize(); else _v2.set(0, 1, 0);
        bubbles.burst(_localPos.x - _v2.x * 0.5, _localPos.y - _v2.y * 0.5, _localPos.z - _v2.z * 0.5,
          7, 1.3, 0.09, 0.9, 0xe8f6ff, 0.9, 1.4, 0, 0, 0, 0);
        sparks.burst(_localPos.x - _v2.x * 0.5, _localPos.y + 0.2, _localPos.z - _v2.z * 0.5,
          6, 2.2, 0.1, 0.28, 0xff6a4a, -1.5, 3.0, 0, 0, 0, 0);
        if (ctx.bus && typeof ctx.bus.emit === 'function') {
          ctx.bus.emit('localDamaged', { dmg: rec.def.dmg, cause: rec.def.name });
        }
      }
    }

    // ---- crosshair assist rim ----
    let rimTarget = 0;
    if (weaponActive && !rec.dead && rec.despawn === 0) {
      _v2.subVectors(rec.renderPos, _camPos);
      const dist = _v2.length();
      if (dist < weaponRange + 4 && dist > 0.001) {
        _v2.multiplyScalar(1 / dist);
        const dot = _v2.dot(_camDir);
        const cone = 0.90 - clamp(rec.radius / Math.max(4, dist), 0, 0.06);
        if (dot > cone) rimTarget = clamp((dot - cone) / 0.05, 0, 1) * 0.95;
      }
    }
    rec.rim = damp(rec.rim, rimTarget, 11, dt);
    rec.flash = Math.max(0, rec.flash - dt * 4.2);
    applyMaterialState(rec);
  }

  // ==================================================================
  // Frame
  // ==================================================================
  function update(dt, t) {
    now += dt;

    // particle point-size scaling follows the live viewport/fov
    const cam = ctx.camera;
    if (cam) {
      const el = ctx.renderer && ctx.renderer.domElement;
      const h = (el && (el.clientHeight || el.height)) || 800;
      const fov = cam.isPerspectiveCamera ? cam.fov : 60;
      const scale = h / (2 * Math.tan(THREE.MathUtils.degToRad(fov) * 0.5));
      sparks.material.uniforms.uScale.value = scale;
      bubbles.material.uniforms.uScale.value = scale;
      cam.getWorldPosition(_camPos);
      cam.getWorldDirection(_camDir);
    }

    const activeWeapon = updateFiring(dt, t);

    const st = ctx.state;
    const wdef = activeWeapon && activeWeapon.ready ? (activeWeapon.def || weaponDef(activeWeapon.id)) : null;
    const weaponActive = !!(wdef && st && st.phase === 'playing');
    const weaponRange = wdef ? wdef.range : 0;
    const hasLocal = getLocalPos(_localPos) && (!st || typeof st.hp !== 'number' || st.hp > 0);

    // Map iteration tolerates deletion of the visited entry, so enemies that
    // finish dying inside updateEnemy can remove themselves safely.
    for (const rec of enemies.values()) {
      updateEnemy(rec, dt, t, weaponActive, weaponRange, hasLocal);
    }

    updateProjectiles(dt, t);
    sparks.update(dt);
    bubbles.update(dt);

    // ---- camera shake ----
    // player.js owns the camera and re-places it every frame before we run, so
    // we simply add a tiny offset on top. If it ever *doesn't* move the camera
    // (paused, cinematic), we take our previous nudge back out first so the
    // offset can never accumulate into real drift.
    if (cam) {
      if (shakeApplied.lengthSq() > 0 && cam.position.distanceToSquared(lastCamPos) < 1e-12) {
        cam.position.sub(shakeApplied);
      }
      shakeApplied.set(0, 0, 0);
      if (camShake > 0.0005 && st && st.phase === 'playing') {
        shakeTime += dt;
        const a = camShake * camShake * 0.11;
        shakeApplied.set(
          Math.sin(shakeTime * 61.0) * a,
          Math.sin(shakeTime * 47.3 + 1.7) * a * 0.9,
          Math.sin(shakeTime * 53.7 + 3.1) * a * 0.7
        );
        cam.position.add(shakeApplied);
        camShake = Math.max(0, camShake - dt * 3.4);
      } else {
        camShake = 0;
      }
      lastCamPos.copy(cam.position);
    } else {
      camShake = 0;
    }
  }

  return { update };
}
