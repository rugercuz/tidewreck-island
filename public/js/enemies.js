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
const MAX_POOLED_SWARM = 14;  // ...but a razorfin pack arrives all at once

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

// Wave 4 behaviours ('drift' jellies, 'ambush' morays/depthmaws)
const AMBUSH_TELEGRAPH = 0.3;  // seconds of uncoil wind-up before the lunge
const AMBUSH_LURK_DIM = 0.25;  // material brightness multiplier while lurking
const AMBUSH_SURGE = [1.4, 1.2];  // [min, random extra] seconds between re-lunges
const STING_RANGE_PAD = 1.25;  // metres past the jelly radius that counts as contact
const STING_SFX_GAP = 0.4;     // seconds before a sting may make noise again

// Wave 7 — head zones, stuns and the razorfin frenzy.
// Every enemy carries a head sphere derived from its interpolated facing; melee
// arcs and projectiles test it BEFORE the body, and a connection is reported to
// the server as DAMAGE_ENEMY {... headshot:true} (bonus damage + a real stun).
const HEAD_FWD = 0.45;         // * def.size, forward of the enemy origin
const HEAD_RAD = 0.35;         // * def.size
const HEAD_MIN_RAD = 0.30;     // ...but never so small a razorfin is unhittable
const STUN_LIST = 0.38;        // radians of woozy roll while stunned
const STUN_STAR_COUNT = 4;
const RECOIL_TIME = 0.22;      // seconds of flinch recoil after a landed hit
const EVENT_HEAD_GAP = 0.3;    // seconds between head hits on an event creature
const EVENT_BODY_GAP = 1.0;    // "at most once per second" for body thuds
const EVENT_BODY_STEPS = 12;   // samples along an attack segment vs the giant
const SWARM_LUNGE_SPEED = 0.5; // fraction of def.speed that reads as a dart-in

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
// wave 7 scratch — head/event queries run inside hit tests that are already
// holding _v1.._v5, so they get vectors nobody else writes.
const _hv = new THREE.Vector3();
const _ehead = new THREE.Vector3();
const _epick = new THREE.Vector3();
const _ehit = new THREE.Vector3();

const C_WHITE = new THREE.Color(0xffffff);
const C_RIM = new THREE.Color(0xff2a1c);
const C_CRIT = new THREE.Color(0xffe9a0);

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
// Dagger Jelly — built here, not by createFishMesh. A lathed bell with an
// additive over-shell, a stinging rim, a few glowing organs and a skirt of
// trailing stingers. Geometry and base materials are shared across every
// jelly in the world; buildVisual() clones the materials per instance so the
// hit-flash pipeline can tint them independently.
// ------------------------------------------------------------------
let _JELLY = null;
function jellyAssets() {
  if (_JELLY) return _JELLY;
  // bell profile, apex (0,1) down to the rim (r,0)
  const prof = [
    [0.000, 1.000], [0.130, 0.985], [0.250, 0.930], [0.345, 0.830],
    [0.415, 0.690], [0.452, 0.530], [0.468, 0.360], [0.462, 0.200],
    [0.440, 0.075], [0.400, 0.000], [0.330, 0.020],
  ];
  const S = 0.9;   // ENEMIES.daggerjelly.size
  const pts = [];
  for (let i = 0; i < prof.length; i++) {
    pts.push(new THREE.Vector2(Math.max(0.0006, prof[i][0] * S), prof[i][1] * S * 0.66));
  }
  const bell = new THREE.LatheGeometry(pts, 18);
  bell.translate(0, -0.27, 0);
  bell.computeVertexNormals();

  const strand = new THREE.CylinderGeometry(0.017, 0.004, 1, 4, 1);
  strand.translate(0, -0.5, 0);
  const arm = new THREE.BoxGeometry(0.055, 1, 0.014);
  arm.translate(0, -0.5, 0);
  const rim = new THREE.TorusGeometry(0.4 * S, 0.026, 5, 20);
  rim.rotateX(Math.PI / 2);
  rim.translate(0, -0.262, 0);
  const organ = new THREE.SphereGeometry(0.052, 7, 5);

  _JELLY = {
    geo: { bell, strand, arm, rim, organ },
    mat: {
      bell: new THREE.MeshStandardMaterial({
        color: 0x63e89b, emissive: 0x2ad478, emissiveIntensity: 0.8,
        roughness: 0.34, metalness: 0.0, transparent: true, opacity: 0.4,
        depthWrite: false, side: THREE.DoubleSide,
      }),
      shell: new THREE.MeshBasicMaterial({
        color: 0x8dffbe, transparent: true, opacity: 0.24,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
      rim: new THREE.MeshBasicMaterial({
        color: 0xd2ffe0, transparent: true, opacity: 0.7,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
      organ: new THREE.MeshBasicMaterial({
        color: 0xa6ffcf, transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
      sting: new THREE.MeshBasicMaterial({
        color: 0xbdff8a, transparent: true, opacity: 0.55,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    },
  };
  return _JELLY;
}

function buildJellyMesh() {
  const A = jellyAssets();
  const g = new THREE.Group();

  // everything that squeezes when the bell pulses lives under this pivot
  const pivot = new THREE.Group();
  g.add(pivot);
  const bell = new THREE.Mesh(A.geo.bell, A.mat.bell);
  bell.renderOrder = 2;
  pivot.add(bell);
  const shell = new THREE.Mesh(A.geo.bell, A.mat.shell);
  shell.scale.setScalar(1.1);
  shell.renderOrder = 3;
  pivot.add(shell);
  const rim = new THREE.Mesh(A.geo.rim, A.mat.rim);
  rim.renderOrder = 4;
  pivot.add(rim);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.6;
    const o = new THREE.Mesh(A.geo.organ, A.mat.organ);
    o.position.set(Math.cos(a) * 0.15, -0.06, Math.sin(a) * 0.15);
    o.scale.set(0.85, 1.5, 0.85);
    o.renderOrder = 3;
    pivot.add(o);
  }

  // trailing stingers hung off the rim, each on its own swaying pivot
  const strands = [];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const p = new THREE.Group();
    p.position.set(Math.cos(a) * 0.345, -0.255, Math.sin(a) * 0.345);
    const m = new THREE.Mesh(A.geo.strand, A.mat.sting);
    const len = 0.95 + (i % 3) * 0.3;
    m.scale.set(1, len, 1);
    m.renderOrder = 2;
    p.add(m);
    p.userData.ph = a + i * 0.71;
    p.userData.len = len;
    g.add(p);
    strands.push(p);
  }
  // four short oral arms under the bell
  const arms = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    const p = new THREE.Group();
    p.position.set(Math.cos(a) * 0.11, -0.24, Math.sin(a) * 0.11);
    p.rotation.y = -a;
    const m = new THREE.Mesh(A.geo.arm, A.mat.rim);
    m.scale.set(1, 0.46, 1);
    m.renderOrder = 3;
    p.add(m);
    p.userData.ph = a * 1.7 + 0.9;
    g.add(p);
    arms.push(p);
  }

  g.userData.update = function (t) {
    if (typeof t !== 'number' || !isFinite(t)) t = 0;
    const s = Math.sin(t * 1.55);
    const c = s > 0 ? s : s * 0.4;         // snap shut, drift back open
    pivot.scale.set(1 + c * 0.13, 1 - c * 0.2, 1 + c * 0.13);
    for (let i = 0; i < strands.length; i++) {
      const p = strands[i];
      const ph = p.userData.ph;
      p.rotation.x = Math.sin(t * 0.92 + ph) * 0.3 - c * 0.15;
      p.rotation.z = Math.cos(t * 0.79 + ph * 1.3) * 0.3;
      p.children[0].scale.y = p.userData.len * (1 + c * 0.14);
    }
    for (let i = 0; i < arms.length; i++) {
      const p = arms[i];
      p.rotation.x = Math.sin(t * 1.35 + p.userData.ph) * 0.34 - c * 0.22;
      p.rotation.z = Math.cos(t * 1.12 + p.userData.ph) * 0.2;
    }
  };
  g.userData.update(0);
  return g;
}

// ------------------------------------------------------------------
// Ambusher coil — stacked rings the serpent body rests in while it lurks.
// One geometry per enemy type; the material is per-instance so its opacity
// can fade as the creature uncoils.
// ------------------------------------------------------------------
const _coilGeos = new Map();
function coilGeometry(type, radius, tube) {
  let g = _coilGeos.get(type);
  if (!g) {
    g = new THREE.TorusGeometry(radius, tube, 6, 16);
    g.rotateX(Math.PI / 2);
    _coilGeos.set(type, g);
  }
  return g;
}

function buildCoil(type, cfg) {
  const geo = coilGeometry(type, cfg.radius, cfg.tube);
  const mat = new THREE.MeshStandardMaterial({
    color: cfg.color, roughness: 0.74, metalness: 0.05, flatShading: true,
    emissive: cfg.emissive || 0x000000, emissiveIntensity: cfg.emissive ? 0.55 : 0,
    transparent: true, opacity: 1,
  });
  const group = new THREE.Group();
  const rings = cfg.rings || 3;
  for (let i = 0; i < rings; i++) {
    const m = new THREE.Mesh(geo, mat);
    const k = 1 - i * 0.19;
    m.scale.set(k, 0.85 + i * 0.1, k);
    m.position.y = i * cfg.tube * 1.25;
    m.rotation.y = i * 0.7;
    m.castShadow = true;
    m.receiveShadow = false;
    group.add(m);
  }
  return { group, mat };
}

// ------------------------------------------------------------------
// Enemy visual definitions — fishDef-like objects fed to createFishMesh
// (or, where `build` is set, to a procedural builder in this file)
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
  // --- Wave 4: drifting stinger. No fishDef at all — see buildJellyMesh. ---
  daggerjelly: {
    build: buildJellyMesh, noOrient: true, noShadow: true, eyeCount: 0,
    eyeColor: 0xbdff8a, eyeIdle: 0, eyeSize: 0.05,
    lure: null, bob: 1.0, animBase: 0.75, wake: 0x9dff8a,
    sting: { color: 0x9dff6a, size: 1.4 },
    mote: 0xa8ff9a,
  },
  // --- Wave 4: seabed ambushers. Serpentine bodies coiled over the loot. ---
  moray: {
    fishDef: {
      id: 'enemy_moray', name: 'Moray Ambusher', tier: 6, value: 0, kg: [20, 60],
      model: { shape: 'eel', size: 2.4, colors: [0x5f6d42, 0x333f20], belly: 0xb6c088, teeth: true },
    },
    eyeColor: 0xffc24a, eyeIdle: 0.04, eyeSize: 0.06,
    lure: null, bob: 0.25, animBase: 1.15, wake: 0xbfe6c8,
    coil: { color: 0x46512e, rings: 3, radius: 0.62, tube: 0.17 },
  },
  depthmaw: {
    fishDef: {
      id: 'enemy_depthmaw', name: 'Depthmaw', tier: 10, value: 0, kg: [900, 2400],
      model: { shape: 'eel', size: 3.6, colors: [0x0b0b11, 0x050508], belly: 0x1c1016, emissive: 0xcc1a1e, teeth: true },
    },
    eyeColor: 0xff5a3a, eyeIdle: 0.06, eyeSize: 0.075,
    lure: null, bob: 0.2, animBase: 0.95, wake: 0xff7a5a,
    coil: { color: 0x0a0a10, emissive: 0x6b0d10, rings: 3, radius: 0.95, tube: 0.26 },
    aura: { color: 0xff2a18, size: 1.5, idle: 0.1, hot: 0.85 },
  },
  // --- Wave 7: the deep-water ambush pack. Never area-spawned (count 0) — the
  //     server erupts a ring of these around a lone swimmer. Slim silver eel of
  //     a thing, red-barred flanks, all teeth, and eyes that are already lit.
  razorfin: {
    fishDef: {
      id: 'enemy_razorfin', name: 'Razorfin', tier: 5, value: 0, kg: [1, 4],
      model: {
        shape: 'eel', size: 0.7,
        colors: [0xd6dde6, 0x8e2630], belly: 0xf4f8fb,
        stripes: 0xb01c26, finTint: 0xd83a34, teeth: true,
      },
    },
    eyeColor: 0xff3018, eyeIdle: 0.55, eyeSize: 0.17,
    lure: null, bob: 1.5, animBase: 3.6, wake: 0xffc0b0,
    frenzy: true,
  },
};

function visualsFor(type) {
  return ENEMY_VISUALS[type] || ENEMY_VISUALS.reefshark;
}

// The server tags every ENEMY_STATE entry with its behaviour, but older
// payloads (and the pre-wave-4 protocol) don't — fall back to the catalog,
// then to the historical 'patrol'.
function behaviorOf(e, def) {
  const b = (e && e.behavior) || (def && def.behavior);
  return (b === 'drift' || b === 'ambush' || b === 'swarm' || b === 'patrol') ? b : 'patrol';
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

  // Wave 7 — dazed-star sprite groups, pooled (a stunned enemy borrows one)
  const starPool = [];
  // Wave 7 — throttles for reporting hits on the colossal event creature
  let lastEventHead = -10;
  let lastEventBody = -10;
  let lastHitWasHead = false;   // set by hitScan(), read immediately after
  let lastAmbushRef = null;

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

  // Any player by id — the local one or a remote. player.js is written in
  // parallel, so every plausible container shape is probed and none is required.
  function playerPos(id, out) {
    if (id === undefined || id === null) return false;
    const st = ctx.state;
    if (st && st.myId === id) return getLocalPos(out);
    const pm = ctx.playerMod;
    const rem = pm && pm.remotes;
    if (!rem) return false;
    let r = null;
    try {
      if (typeof rem.get === 'function') r = rem.get(id);
      else if (Array.isArray(rem)) {
        for (let i = 0; i < rem.length; i++) { if (rem[i] && rem[i].id === id) { r = rem[i]; break; } }
      } else r = rem[id];
    } catch (e) { r = null; }
    if (!r) return false;
    const g = (r.char && r.char.group) || r.group || (r.isObject3D ? r : null);
    if (g && g.isObject3D) { g.getWorldPosition(out); return true; }
    if (r.position && r.position.isVector3) { out.copy(r.position); return true; }
    return false;
  }

  // ---------------- wave 7: head zones ----------------
  // A sphere ~0.35 * size across, sitting ~0.45 * size forward of the enemy
  // origin along its INTERPOLATED facing (yaw + pitch), at body height.
  function headRadiusOf(rec) {
    return Math.max(HEAD_MIN_RAD, rec.def.size * HEAD_RAD);
  }

  function headCenter(rec, out) {
    const cp = Math.cos(rec.pitch), sp = Math.sin(rec.pitch);
    const fwd = rec.def.size * HEAD_FWD;
    out.set(
      rec.renderPos.x + Math.sin(rec.yaw) * cp * fwd,
      rec.renderPos.y + rec.visual.center.y * 0.4 - sp * fwd,
      rec.renderPos.z + Math.cos(rec.yaw) * cp * fwd
    );
    return out;
  }

  function bodyCenterY(rec) {
    return rec.renderPos.y + rec.visual.center.y * 0.4;
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

  // fish.js (and our own builders) share one material across many meshes, so
  // clone each distinct source material exactly once per enemy: the tint/flash
  // pipeline writes identical values to every mesh anyway, and one clone per
  // type instead of one per mesh keeps the material count tiny.
  const _matClones = new Map();
  function cloneOnce(src, out) {
    let m = _matClones.get(src);
    if (m) return m;
    m = src.clone();
    _matClones.set(src, m);
    out.push(snapshotMaterial(m));
    return m;
  }

  function harvestMaterials(obj, out) {
    _matClones.clear();
    obj.traverse((c) => {
      if (!c.material) return;
      if (Array.isArray(c.material)) {
        const arr = [];
        for (let i = 0; i < c.material.length; i++) arr.push(cloneOnce(c.material[i], out));
        c.material = arr;
      } else {
        c.material = cloneOnce(c.material, out);
      }
    });
    _matClones.clear();
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
    if (typeof vis.build === 'function') {
      // procedural body owned by this module (the jelly bell) — no fish factory
      try { fishGroup = vis.build(); } catch (e) {
        console.warn('[enemies] custom body build failed for ' + type + ':', e);
        fishGroup = null;
      }
    } else {
      try {
        const make = fishFactory && fishFactory.createFishMesh;
        if (typeof make === 'function') fishGroup = make(vis.fishDef, null, 1);
      } catch (e) {
        console.warn('[enemies] createFishMesh failed for ' + type + ', using fallback mesh:', e);
        fishGroup = null;
      }
    }
    if (!fishGroup || !fishGroup.isObject3D) fishGroup = fallbackFishMesh(vis.fishDef || visualsFor('reefshark').fishDef);

    // fixGroup carries the orientation correction; measurements below are
    // therefore already in "body faces +Z" space.
    const fixGroup = new THREE.Group();
    fixGroup.add(fishGroup);
    if (!vis.noOrient) orientFish(fishGroup, fixGroup);

    _box.setFromObject(fixGroup);
    if (_box.isEmpty()) {
      _box.min.set(-0.4, -0.3, -0.8);
      _box.max.set(0.4, 0.3, 0.8);
    }
    _box.getSize(_boxSize);
    _box.getCenter(_boxCtr);

    const mats = [];
    harvestMaterials(fishGroup, mats);
    const shad = !vis.noShadow;
    fishGroup.traverse((c) => {
      if (c.isMesh) { c.castShadow = shad; c.receiveShadow = false; }
    });

    // holder = lunge offset; attach = un-rotated space matching the measured box
    const holder = new THREE.Group();
    holder.add(fixGroup);
    const attach = new THREE.Group();
    holder.add(attach);

    // eyes: additive glow sprites parked at the head, dim until aggro
    // (eyeCount 0 for bodies that have no head to speak of — the jelly)
    const eyeSize = Math.max(0.06, _boxSize.z * vis.eyeSize);
    const eyeCount = vis.eyeCount === undefined ? 2 : vis.eyeCount;
    const eyes = [];
    for (let i = 0; i < eyeCount; i++) {
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

    // menace aura: a soft additive bloom at the head, barely there while the
    // creature lurks and hot once it commits (depthmaw's deep red glow)
    let aura = null;
    if (vis.aura) {
      aura = makeGlowSprite(vis.aura.color, Math.max(0.5, _boxSize.z * vis.aura.size * 0.25), vis.aura.idle);
      aura.position.set(0, _boxCtr.y + _boxSize.y * 0.06, _box.max.z - _boxSize.z * 0.14);
      attach.add(aura);
    }

    // venom sting flash: expanding green pop when the drifter touches someone
    let sting = null;
    if (vis.sting) {
      sting = makeGlowSprite(vis.sting.color, Math.max(0.4, _boxSize.x * vis.sting.size), 0);
      sting.position.set(0, _boxCtr.y - _boxSize.y * 0.12, 0);
      sting.visible = false;
      attach.add(sting);
    }

    // the coil is NOT parented here: it must stay planted on the seabed while
    // the body sinks into it, so createEnemy hangs it off the wrapper instead
    const coil = vis.coil ? buildCoil(type, vis.coil) : null;
    if (coil) coil.group.position.y = _boxCtr.y - _boxSize.y * 0.3;

    return {
      holder, fixGroup, attach, fishGroup, mats, eyes, lure, aura, sting, coil,
      size: _boxSize.clone(), center: _boxCtr.clone(),
      hasAnim: !!(fishGroup.userData && typeof fishGroup.userData.update === 'function'),
    };
  }

  function releaseVisual(type, visual) {
    if (visual.holder.parent) visual.holder.parent.remove(visual.holder);
    visual.holder.position.set(0, 0, 0);
    // orientFish owns fixGroup.rotation.y — only the pose axes reset here
    visual.fixGroup.rotation.x = 0;
    visual.fixGroup.rotation.z = 0;
    visual.attach.rotation.set(0, 0, 0);
    if (visual.coil) {
      if (visual.coil.group.parent) visual.coil.group.parent.remove(visual.coil.group);
      visual.coil.group.scale.set(1, 1, 1);
      visual.coil.mat.opacity = 1;
    }
    if (visual.aura) visual.aura.material.opacity = 0;
    if (visual.sting) { visual.sting.material.opacity = 0; visual.sting.visible = false; }
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
    // a whole ambush pack despawns at once and the next one wants them straight
    // back, so swarm bodies get a much deeper cache than the area regulars
    const cap = (ENEMIES[type] && ENEMIES[type].behavior === 'swarm') ? MAX_POOLED_SWARM : MAX_POOLED;
    if (pool.length < cap) { pool.push(visual); return; }
    // over capacity — drop it, disposing only the materials WE cloned
    for (let i = 0; i < visual.mats.length; i++) visual.mats[i].mat.dispose();
    for (let i = 0; i < visual.eyes.length; i++) visual.eyes[i].material.dispose();
    if (visual.lure) {
      visual.lure.userData.bulb.material.dispose();
      visual.lure.userData.halo.material.dispose();
    }
    if (visual.aura) visual.aura.material.dispose();
    if (visual.sting) visual.sting.material.dispose();
    if (visual.coil) visual.coil.mat.dispose();   // geometry stays in the type cache
  }

  function createEnemy(e) {
    const type = ENEMIES[e.type] ? e.type : 'reefshark';
    const def = ENEMIES[type];
    const vis = visualsFor(type);
    const visual = buildVisual(type);

    const wrapper = new THREE.Group();
    wrapper.rotation.order = 'YXZ';
    wrapper.add(visual.holder);
    // the coil rides the wrapper, not the holder, so the body can sink into it
    if (visual.coil) wrapper.add(visual.coil.group);
    root.add(wrapper);

    const behavior = behaviorOf(e, def);
    const p = Array.isArray(e.p) ? e.p : [0, -2, 0];
    const rec = {
      id: e.id, type, def, vis, visual, wrapper, behavior,
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
      // behaviour state: ambushers start coiled, drifters loll on their own axis
      coil: behavior === 'ambush' ? 1 : 0,
      uncoil: 0, nextSurge: 0, wakeT: 0, dim: 1,
      sting: 0, lastSting: -10,
      driftSpin: (Math.random() - 0.5) * 0.5,
      // wave 7: stun / flinch / frenzy state
      stunned: false, stars: null, recoil: 0, crit: 0, lungeCd: 0, swarmSeed: Math.random() * 30,
      _lf: -1, _lr: -1, _ld: -1, _ldim: -1, _lc: -1,
    };
    enemies.set(e.id, rec);
    // the pack does not swim in — it ERUPTS, in a boil of bubbles
    if (behavior === 'swarm') arriveFX(rec);
    return rec;
  }

  // Razorfins boil up out of the dark... (a whole pack arrives at once, so the
  // per-fish burst stays small — the ring-wide eruption is in onAmbush)
  function arriveFX(rec) {
    const p = rec.renderPos;
    bubbles.burst(p.x, p.y, p.z, 6, 1.5, 0.1, 1.4, 0xdff2ff, 1.0, 1.0, 0, 0, 0, 0);
  }

  // ...and dive away just as hard when the frenzy breaks.
  function diveAwayFX(rec) {
    const p = rec.renderPos;
    bubbles.burst(p.x, p.y, p.z, 8, 1.8, 0.1, 1.6, 0xdff2ff, 1.1, 0.9, 0, -1, 0, 1.1);
  }

  function destroyEnemy(rec) {
    releaseStars(rec);
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
    rec.uncoil = 0;
    rec.stunned = false;
    releaseStars(rec);
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
      if (typeof e.behavior === 'string') rec.behavior = behaviorOf(e, rec.def);
      if (e.state) {
        rec.state = e.state;
        // wave 7: a stunned enemy is frozen solid — not hostile, not moving
        const stunned = e.state === 'stunned';
        if (stunned && !rec.stunned && !rec.dead) {
          rec.recoil = Math.max(rec.recoil, 1);
          headCenter(rec, _hv);
          sparks.burst(_hv.x, _hv.y + rec.def.size * 0.3, _hv.z, 10, 2.6, 0.11, 0.4,
            0xffd85a, -0.5, 3.0, 0, 0, 0, 0);
        }
        rec.stunned = stunned;
        // 'lurk' is explicitly NOT hostile — that is the whole point of it
        const hostile = e.state === 'aggro' || e.state === 'attack' || e.state === 'lunge' || e.state === 'chase';
        if (hostile && !rec.aggro) {
          rec.telegraph = 1;
          if (rec.behavior === 'ambush' && !rec.dead) {
            // eyes flare, then a short uncoil wind-up before it commits
            rec.uncoil = AMBUSH_TELEGRAPH;
            rec.eyeLit = Math.max(rec.eyeLit, 0.65);
            rec.nextSurge = AMBUSH_SURGE[0] + Math.random() * AMBUSH_SURGE[1];
          }
        }
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
      if (rec.seen !== snapshotTick && !rec.dead && rec.despawn === 0) {
        rec.despawn = 0.0001;
        if (rec.behavior === 'swarm') diveAwayFX(rec);   // the pack scatters into the dark
      }
    }
  }

  function onEnemyHit(payload) {
    if (!payload || payload === lastHitRef) return;
    lastHitRef = payload;
    const rec = enemies.get(payload.enemyId);
    if (!rec) return;
    rec.flash = 1;
    rec.telegraph = Math.max(rec.telegraph, 0.35);
    // wave 7: every landed hit flinches — a short recoil kick away from the shooter
    rec.recoil = Math.max(rec.recoil, 1);
    _v2.subVectors(rec.renderPos, _camPos);
    if (_v2.lengthSq() > 1e-6) {
      _v2.normalize();
      const push = 0.34 / Math.max(0.6, rec.def.size * 0.5);
      rec.nudge.addScaledVector(_v2, push);
    }
    if (typeof payload.hp === 'number') rec.hp = payload.hp;
    sfx('enemyHurt', 0.85, rec.renderPos);
    bubbles.burst(rec.renderPos.x, rec.renderPos.y, rec.renderPos.z, 5, 0.7,
      0.11 * rec.def.size, 1.3, 0xe6f6ff, 1.0, 1.0, 0, 0, 0, 0);
    if (rec.hp <= 0) startDeath(rec);
  }

  // Venom pop: a green flash on the bell, a spit of stinging motes and (at
  // most a few times a second) the sting sound.
  function triggerSting(rec) {
    rec.sting = 1;
    rec.telegraph = Math.max(rec.telegraph, 0.5);
    if (now - rec.lastSting < STING_SFX_GAP) return;
    rec.lastSting = now;
    sfx('jellySting', 0.85, rec.renderPos);
    sparks.burst(rec.renderPos.x, rec.renderPos.y, rec.renderPos.z, 9, 2.0,
      0.11, 0.32, 0x9dff6a, -0.6, 3.0, 0, 0, 0, 0);
    camShake = Math.min(1.2, camShake + 0.34);
  }

  // The server is the authority on jelly damage, so also flash whichever
  // drifter is closest when something stings the local player. Guarded so our
  // own contact-range emit below doesn't come straight back in here.
  let stingEmitting = false;
  function onLocalDamaged(payload) {
    if (stingEmitting || !payload || typeof payload.cause !== 'string') return;
    let best = null, bestD = 49;   // 7 m — anything further isn't the culprit
    for (const rec of enemies.values()) {
      if (rec.dead || rec.behavior !== 'drift' || !rec.visual.sting) continue;
      if (rec.def.name !== payload.cause) continue;
      const d2 = rec.renderPos.distanceToSquared(_localPos);
      if (d2 < bestD) { bestD = d2; best = rec; }
    }
    if (best) triggerSting(best);
  }

  // ==================================================================
  // Wave 7 — deep-water ambushes (MSG.AMBUSH)
  //
  // The pack itself arrives through ENEMY_STATE like any other enemy, so packs
  // hunting OTHER players render normally with no help from here. These phases
  // add the theatre: the boil of water under the warned swimmer, the eruption
  // when the ring spawns, and the scatter when the frenzy breaks.
  // ==================================================================
  const frenzy = { active: false, targetId: null, mine: false, startedAt: 0 };

  function frenzyLoop(on) {
    const a = ctx.audio;
    if (!a || typeof a.sfx !== 'function') return;
    try { a.sfx('razorFrenzy', { on: !!on }); } catch (e) { /* audio must never break the frame */ }
  }

  function onAmbush(payload) {
    if (!payload || payload === lastAmbushRef) return;
    lastAmbushRef = payload;
    const phase = payload.phase;
    if (phase !== 'warn' && phase !== 'start' && phase !== 'end') return;
    const st = ctx.state;
    const mine = !!(st && payload.targetId !== undefined && payload.targetId === st.myId);
    // No position for the target (a remote we cannot see) = no theatre needed;
    // their razorfins still render from ENEMY_STATE all the same.
    if (!playerPos(payload.targetId, _v3)) {
      if (phase === 'end' && frenzy.targetId === payload.targetId) {
        frenzy.active = false; frenzy.targetId = null;
        if (frenzy.mine) { frenzy.mine = false; frenzyLoop(false); }
      }
      return;
    }
    const t = ctx.clock ? ctx.clock.getElapsedTime() : 0;
    const wy = waterHeight(_v3.x, _v3.z, t);
    const y = Math.min(_v3.y, wy - 0.2);

    if (phase === 'warn') {
      // something is circling BENEATH you: a slow boil rising out of the dark
      for (let i = 0; i < 22; i++) {
        const a = (i / 22) * Math.PI * 2 + Math.random() * 0.3;
        const r = 3.5 + Math.random() * 5.5;
        bubbles.spawn(
          _v3.x + Math.cos(a) * r, y - 4 - Math.random() * 5, _v3.z + Math.sin(a) * r,
          (Math.random() - 0.5) * 0.3, 0.9 + Math.random() * 0.7, (Math.random() - 0.5) * 0.3,
          0.08 + Math.random() * 0.07, 2.4 + Math.random() * 1.2, 0xcfe8ff, 0.5, 0.7
        );
      }
      if (mine) camShake = Math.min(1.0, camShake + 0.28);
      return;
    }

    if (phase === 'start') {
      frenzy.active = true;
      frenzy.targetId = payload.targetId;
      frenzy.startedAt = now;   // ENEMY_STATE lags this by a tick — give it a beat
      const n = Math.max(4, Math.min(16, Number(payload.count) || 8));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const r = 10 + Math.random() * 6;
        const px = _v3.x + Math.cos(a) * r, pz = _v3.z + Math.sin(a) * r;
        bubbles.burst(px, y, pz, 5, 1.5, 0.11, 1.6, 0xdff2ff, 1.0, 1.0, 0, 0, 0, 0);
        sparks.burst(px, y, pz, 3, 2.2, 0.09, 0.3, 0xff5a3a, -0.4, 3.0, 0, 0, 0, 0);
      }
      bubbles.burst(_v3.x, y, _v3.z, 14, 2.2, 0.12, 1.4, 0xe6f6ff, 1.1, 1.0, 0, 0, 0, 0);
      if (mine) {
        frenzy.mine = true;
        frenzyLoop(true);
        camShake = Math.min(1.4, camShake + 0.7);
      }
      return;
    }

    // 'end' — they break off and dive
    if (frenzy.targetId === payload.targetId || !frenzy.targetId) {
      frenzy.active = false;
      frenzy.targetId = null;
      if (frenzy.mine) { frenzy.mine = false; frenzyLoop(false); }
    }
    // the per-fish dive puff is fired from the despawn path in onEnemyState, so
    // this is just the hole in the water where the pack used to be
    bubbles.burst(_v3.x, y, _v3.z, 14, 2.6, 0.1, 1.8, 0xdff2ff, 0.9, 0.8, 0, -1, 0, 0.9);
  }

  function clearAll() {
    if (frenzy.mine) frenzyLoop(false);
    frenzy.active = false; frenzy.targetId = null; frenzy.mine = false;
    lastAmbushRef = null;
    lastEventHead = -10;
    lastEventBody = -10;
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
    bus.on('localDamaged', onLocalDamaged);
    bus.on('eventStart', () => { dreadMode = true; });
    bus.on('eventEnd', () => { dreadMode = false; });
    bus.on('phase', (p) => { if (p !== 'playing') clearAll(); });
  }
  if (ctx.net && typeof ctx.net.on === 'function') {
    // Belt and braces: work whether main relays these over the bus or not.
    // Duplicate deliveries of the same payload object are filtered above.
    ctx.net.on(MSG.ENEMY_STATE, onEnemyState);
    ctx.net.on(MSG.ENEMY_HIT, onEnemyHit);
    ctx.net.on(MSG.AMBUSH, onAmbush);
  }
  if (bus && typeof bus.on === 'function') bus.on('ambush', onAmbush);

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

  // Best enemy hit along a segment; returns the record or null. The HEAD sphere
  // is tested first for every candidate, so a shot that grazes both the skull
  // and the flank is always scored as the headshot. `lastHitWasHead` carries
  // that verdict back to the caller (read it immediately).
  function hitScan(ax, ay, az, bx, by, bz, extra, outPoint) {
    let best = null, bestT = 2, bestHead = false;
    for (const rec of enemies.values()) {
      if (rec.dead || rec.despawn > 0) continue;
      headCenter(rec, _hv);
      // the head gets only HALF the aim assist — a crit should cost you an aim
      let t = segmentSphere(ax, ay, az, bx, by, bz, _hv.x, _hv.y, _hv.z, headRadiusOf(rec) + extra * 0.5);
      const head = t >= 0;
      if (!head) {
        t = segmentSphere(ax, ay, az, bx, by, bz,
          rec.renderPos.x, bodyCenterY(rec), rec.renderPos.z, rec.radius + extra);
      }
      if (t >= 0 && t < bestT) { bestT = t; best = rec; bestHead = head; }
    }
    lastHitWasHead = bestHead;
    if (best && outPoint) {
      outPoint.set(ax + (bx - ax) * bestT, ay + (by - ay) * bestT, az + (bz - az) * bestT);
    }
    return best;
  }

  // ------------------------------------------------------------------
  // Wave 7 — striking the colossal event creature.
  // events.js owns the giant; all it exposes is where the head is, how big the
  // head sphere is, and how far a point is from the hide. Everything here is
  // optional-chained so an events.js that has not caught up still cannot
  // break a swing.
  // ------------------------------------------------------------------
  function eventHandle() {
    const e = ctx.events;
    if (!e || typeof e.headWorld !== 'function' || typeof e.headRadius !== 'function') return null;
    const st = ctx.state;
    if (!st || !st.eventActive) return null;   // "only when an event is active"
    return e;
  }

  function eventHeadR(e) {
    let r = 0;
    try { r = e.headRadius(); } catch (err) { r = 0; }
    return (typeof r === 'number' && isFinite(r) && r > 0) ? r : 0;
  }

  function eventBodyDist(e, p) {
    if (typeof e.bodyDist !== 'function') return Infinity;
    let d = Infinity;
    try { d = e.bodyDist(p); } catch (err) { d = Infinity; }
    return typeof d === 'number' ? d : Infinity;
  }

  // 0 = missed it entirely, 1 = body connection, 2 = head connection.
  // outPoint gets the contact point on a hit.
  function eventHitScan(ax, ay, az, bx, by, bz, outPoint) {
    const e = eventHandle();
    if (!e) return 0;
    let ok = false;
    try { ok = e.headWorld(_ehead) === true; } catch (err) { ok = false; }
    if (!ok) return 0;
    const r = eventHeadR(e);
    if (r > 0) {
      const t = segmentSphere(ax, ay, az, bx, by, bz, _ehead.x, _ehead.y, _ehead.z, r);
      if (t >= 0) {
        outPoint.set(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t);
        return 2;
      }
    }
    let pad = 0.75;
    if (typeof e.bodyHitPad === 'function') {
      try { const v = e.bodyHitPad(); if (typeof v === 'number' && isFinite(v)) pad = v; } catch (err) { /* default */ }
    }
    for (let i = 0; i <= EVENT_BODY_STEPS; i++) {
      const f = i / EVENT_BODY_STEPS;
      _epick.set(ax + (bx - ax) * f, ay + (by - ay) * f, az + (bz - az) * f);
      if (eventBodyDist(e, _epick) <= pad) { outPoint.copy(_epick); return 1; }
    }
    return 0;
  }

  // Report a connection to the server and play the local feedback.
  // Returns true when the giant swallowed the attack (so callers can stop).
  function tryEventHit(ax, ay, az, bx, by, bz, weaponId, dirX, dirY, dirZ, outPoint) {
    const kind = eventHitScan(ax, ay, az, bx, by, bz, _ehit);
    if (kind === 0) return false;
    if (outPoint) outPoint.copy(_ehit);
    if (kind === 2) {
      if (now - lastEventHead < EVENT_HEAD_GAP) return true;
      lastEventHead = now;
      if (ctx.net && typeof ctx.net.send === 'function') {
        ctx.net.send(MSG.EVENT_HIT, { headshot: true, weaponId: weaponId || null });
      }
      eventCritFX(_ehit, dirX, dirY, dirZ);
      return true;
    }
    // body: cosmetic only, and it does not get to spam the wire
    if (now - lastEventBody < EVENT_BODY_GAP) return true;
    lastEventBody = now;
    if (ctx.net && typeof ctx.net.send === 'function') {
      ctx.net.send(MSG.EVENT_HIT, { headshot: false, weaponId: weaponId || null });
    }
    thudFX(_ehit);
    return true;
  }

  // Is the giant close enough to jab rather than shoot? (Storm Trident choice.)
  function eventInMeleeRange(origin, dir, range) {
    const e = eventHandle();
    if (!e) return false;
    _epick.copy(origin).addScaledVector(dir, range * 0.85);
    let ok = false;
    try { ok = e.headWorld(_ehead) === true; } catch (err) { ok = false; }
    if (ok) {
      const r = eventHeadR(e);
      if (r > 0 && _epick.distanceTo(_ehead) <= r) return true;
    }
    return eventBodyDist(e, _epick) <= 1.2;
  }

  // dmgOverride / kind are optional: ranged callers pass neither and keep the
  // original behaviour, melee callers pass the weapon's melee damage + 'melee'.
  // headshot is wave 7: the server applies the bonus damage and the stun, we
  // only report the connection and play the crit read.
  function dealDamage(rec, def, weaponId, point, dirX, dirY, dirZ, dmgOverride, kind, headshot) {
    if (!rec || rec.dead) return;
    const dmg = typeof dmgOverride === 'number' ? dmgOverride : def.dmg;
    const head = headshot === true;
    if (ctx.net && typeof ctx.net.send === 'function') {
      // body hits keep the pre-wave-7 payload exactly as it was
      if (head) ctx.net.send(MSG.DAMAGE_ENEMY, { enemyId: rec.id, dmg, weaponId, headshot: true });
      else ctx.net.send(MSG.DAMAGE_ENEMY, { enemyId: rec.id, dmg, weaponId });
    }
    // local feedback (server confirms with ENEMY_HIT)
    const isMelee = kind === 'melee';
    rec.flash = Math.max(rec.flash, head ? 1.35 : (isMelee ? 1 : 0.85));
    if (head) rec.crit = 1;
    rec.telegraph = Math.max(rec.telegraph, isMelee ? 0.6 : 0);
    rec.recoil = Math.max(rec.recoil, head ? 1 : 0.7);
    const push = (isMelee ? 0.62 : 0.42) * (head ? 1.45 : 1);
    rec.nudge.x += dirX * push;
    rec.nudge.y += dirY * (isMelee ? 0.3 : 0.22);
    rec.nudge.z += dirZ * push;
    if (head) critFX(point, dirX, dirY, dirZ, isMelee);
    else if (isMelee) meleeImpactFX(point, dirX, dirY, dirZ, false);
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

  // ------------------------------------------------------------------
  // Wave 7 FX — crit hitmarker, dull thud, dazed stars
  // ------------------------------------------------------------------

  // The headshot read: a hard white pop, a tight gold starburst and the crisp
  // crit ding. Deliberately different in colour AND shape from a body hit.
  function critFX(p, dx, dy, dz, isMelee) {
    sfx('headshot', 1.0, p);
    sparks.burst(p.x, p.y, p.z, 10, 0.5, 0.26, 0.13, 0xffffff, 0, 7.5, 0, 0, 0, 0);
    sparks.burst(p.x, p.y, p.z, 16, 3.6, 0.13, 0.34, 0xffe27a, -1.6, 3.6, -dx, -dy, -dz, 1.3);
    sparks.burst(p.x, p.y, p.z, 8, 5.2, 0.09, 0.22, 0xfff8d8, 0, 2.2, 0, 0, 0, 0);
    const t = ctx.clock ? ctx.clock.getElapsedTime() : 0;
    if (p.y < waterHeight(p.x, p.z, t)) {
      bubbles.burst(p.x, p.y, p.z, 9, 1.3, 0.1, 1.1, 0xeaf8ff, 1.2, 1.2, 0, 0, 0, 0);
    }
    camShake = Math.min(1.4, camShake + (isMelee ? 0.3 : 0.22));
  }

  // The giants do not care. A flat, dull thud and a puff of nothing.
  function thudFX(p) {
    sfx('impact', 0.45, p);
    sparks.burst(p.x, p.y, p.z, 7, 1.7, 0.1, 0.2, 0x9aa6b0, -1.2, 4.5, 0, 0, 0, 0);
    const t = ctx.clock ? ctx.clock.getElapsedTime() : 0;
    if (p.y < waterHeight(p.x, p.z, t)) {
      bubbles.burst(p.x, p.y, p.z, 5, 0.9, 0.09, 0.9, 0xdff0ff, 1.0, 1.2, 0, 0, 0, 0);
    }
  }

  // A head hit on something 100 m long deserves rather more.
  function eventCritFX(p, dx, dy, dz) {
    sfx('headshot', 1.0, p);
    sparks.burst(p.x, p.y, p.z, 22, 1.2, 0.34, 0.2, 0xffffff, 0, 6.0, 0, 0, 0, 0);
    sparks.burst(p.x, p.y, p.z, 30, 6.5, 0.2, 0.55, 0xffd85a, -1.2, 2.6, -dx, -dy, -dz, 1.6);
    bubbles.burst(p.x, p.y, p.z, 12, 2.0, 0.16, 1.5, 0xeaf8ff, 1.1, 1.0, 0, 0, 0, 0);
    camShake = Math.min(1.5, camShake + 0.5);
  }

  function acquireStars() {
    const g = starPool.pop();
    if (g) { g.visible = true; return g; }
    const grp = new THREE.Group();
    const list = [];
    for (let i = 0; i < STUN_STAR_COUNT; i++) {
      const s = makeGlowSprite(i % 2 ? 0xfff2b8 : 0xffcf4a, 0.2, 0.9);
      grp.add(s);
      list.push(s);
    }
    grp.userData.stars = list;
    fx.add(grp);
    return grp;
  }

  function releaseStars(rec) {
    const g = rec.stars;
    if (!g) return;
    rec.stars = null;
    g.visible = false;
    if (starPool.length < 6) { starPool.push(g); return; }
    if (g.parent) g.parent.remove(g);
    const list = g.userData.stars || [];
    for (let i = 0; i < list.length; i++) list[i].material.dispose();
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
      const beamHead = lastHitWasHead;
      // the lance stops on the first thing it finds: an enemy, or the giant
      let evHit = false;
      if (!hit) {
        evHit = tryEventHit(_v1.x, _v1.y, _v1.z, _v4.x, _v4.y, _v4.z,
          'trident', _v2.x, _v2.y, _v2.z, _v5);
      }
      const stopped = hit || evHit;
      const endX = stopped ? _v5.x : _v4.x, endY = stopped ? _v5.y : _v4.y, endZ = stopped ? _v5.z : _v4.z;
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
      if (hit) dealDamage(hit, def, 'trident', _v5, _v2.x, _v2.y, _v2.z, undefined, undefined, beamHead);
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
      if (inMeleeArc(rec.renderPos.x, bodyCenterY(rec), rec.renderPos.z,
        rec.radius, range, melee.origin, melee.dir) >= 0) return true;
    }
    // wave 7: a wall of kraken arm right on top of you is worth jabbing too
    if (eventInMeleeRange(melee.origin, melee.dir, range)) return true;
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
      // wave 7: swing at the HEAD first — a connection there beats the flank
      headCenter(rec, _hv);
      const hr = headRadiusOf(rec);
      let head = true;
      let cx = _hv.x, cy = _hv.y, cz = _hv.z, cr = hr;
      let d = inMeleeArc(cx, cy, cz, cr, range, melee.origin, melee.dir);
      if (d < 0) {
        head = false;
        cx = rec.renderPos.x; cy = bodyCenterY(rec); cz = rec.renderPos.z; cr = rec.radius;
        d = inMeleeArc(cx, cy, cz, cr, range, melee.origin, melee.dir);
      }
      if (d < 0) continue;
      _v4.set(cx - melee.origin.x, cy - melee.origin.y, cz - melee.origin.z);
      if (_v4.lengthSq() > 1e-6) _v4.normalize(); else _v4.copy(melee.dir);
      _v5.copy(melee.origin).addScaledVector(_v4, Math.max(0.25, d - cr * 0.55));
      dealDamage(rec, def, melee.weaponId, _v5, _v4.x, _v4.y, _v4.z, dmg, 'melee', head);
      hits++;
    }
    // wave 7: and the thing the size of a cathedral, if it happens to be here
    if (tryEventHit(
      melee.origin.x, melee.origin.y, melee.origin.z,
      melee.origin.x + melee.dir.x * range,
      melee.origin.y + melee.dir.y * range,
      melee.origin.z + melee.dir.z * range,
      melee.weaponId, melee.dir.x, melee.dir.y, melee.dir.z, null)) hits++;
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
      const projHead = lastHitWasHead;
      if (rec && def) {
        _v1.copy(pr.vel).normalize();
        dealDamage(rec, def, pr.weaponId, _v5, _v1.x, _v1.y, _v1.z, undefined, undefined, projHead);
        pr.dead = true;
        continue;
      }
      // nothing small in the way — did it bury itself in the giant?
      if (!rec) {
        _v1.copy(pr.vel);
        if (_v1.lengthSq() > 1e-8) _v1.normalize(); else _v1.set(0, 0, 1);
        if (tryEventHit(pr.prev.x, pr.prev.y, pr.prev.z, pr.pos.x, pr.pos.y, pr.pos.z,
          pr.weaponId, _v1.x, _v1.y, _v1.z, null)) {
          pr.dead = true;
          continue;
        }
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
  // `dim` (< 1 only for lurking ambushers) drains both the albedo and the
  // emissive so a coiled moray reads as a lump of seabed until it strikes.
  function applyMaterialState(rec) {
    const flash = rec.flash, rim = rec.rim, fade = rec.fade, dim = rec.dim, crit = rec.crit;
    if (Math.abs(flash - rec._lf) < 0.004 && Math.abs(rim - rec._lr) < 0.004 &&
        Math.abs(fade - rec._ld) < 0.004 && Math.abs(dim - rec._ldim) < 0.004 &&
        Math.abs(crit - rec._lc) < 0.004) return;
    rec._lf = flash; rec._lr = rim; rec._ld = fade; rec._ldim = dim; rec._lc = crit;
    const mats = rec.visual.mats;
    const hasDim = dim < 0.999;
    // wave 7: a headshot flashes GOLD, a body hit flashes white
    const hot = crit > 0.02 ? C_CRIT : C_WHITE;
    for (let i = 0; i < mats.length; i++) {
      const s = mats[i];
      const m = s.mat;
      const lit = !!(s.emissive && m.emissive);
      if (s.color && m.color) {
        m.color.copy(s.color);
        if (hasDim) m.color.multiplyScalar(0.4 + dim * 0.6);
        if (!lit) {
          if (rim > 0.002) m.color.lerp(C_RIM, rim * 0.28);
          if (flash > 0.002) m.color.lerp(hot, clamp(flash, 0, 1) * 0.8);
        }
      }
      if (lit) {
        m.emissive.copy(s.emissive);
        if (hasDim) m.emissive.multiplyScalar(dim);
        if (rim > 0.002) m.emissive.lerp(C_RIM, clamp(rim * 0.55, 0, 0.8));
        if (flash > 0.002) m.emissive.lerp(hot, clamp(flash, 0, 1));
        m.emissiveIntensity = s.ei * (hasDim ? dim : 1) + rim * 0.85 + flash * 2.6;
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

  // A short spray of bubbles thrown off the tail as an ambusher drives forward.
  function ambushWake(rec, n) {
    const sy = Math.sin(rec.yaw), cy = Math.cos(rec.yaw);
    const back = rec.visual.size.z * 0.3;
    bubbles.burst(
      rec.renderPos.x - sy * back, rec.renderPos.y + rec.visual.center.y * 0.4, rec.renderPos.z - cy * back,
      n, 0.8, 0.1 * rec.def.size, 1.5, 0xdff2ff, 0.85, 1.1, -sy, 0.2, -cy, 0.9
    );
  }

  // Ambush pose. Coiled and dim while it lurks; on aggro it rears back for
  // AMBUSH_TELEGRAPH seconds, then drives forward along its travel direction
  // and keeps surging while it hunts. Returns the rear-back amount so the
  // caller can stretch the body with it.
  function updateAmbush(rec, dt, t, aggro) {
    const V = rec.visual;

    // uncoil wind-up -> the strike
    let rear = 0;
    if (rec.uncoil > 0) {
      rec.uncoil = Math.max(0, rec.uncoil - dt);
      rear = Math.sin((1 - rec.uncoil / AMBUSH_TELEGRAPH) * Math.PI * 0.85);
      if (rec.uncoil === 0) {
        rec.lunge = 1;
        sfx('morayLunge', 0.95, rec.renderPos);
        ambushWake(rec, 9);
        camShake = Math.min(1.3, camShake + 0.22);
      }
    } else if (aggro && rec.coil < 0.35) {
      rec.nextSurge -= dt;
      if (rec.nextSurge <= 0) {
        rec.nextSurge = AMBUSH_SURGE[0] + Math.random() * AMBUSH_SURGE[1];
        rec.lunge = Math.max(rec.lunge, 0.85);
        ambushWake(rec, 5);
      }
    }

    // coil 1 = fully wound on the seabed, 0 = extended and hunting
    rec.coil = damp(rec.coil, aggro ? 0 : 1, aggro ? 9 : 1.8, dt);
    rec.dim = AMBUSH_LURK_DIM + (1 - AMBUSH_LURK_DIM) * (1 - rec.coil);

    // half-buried pose: sunk into the coil, nose lifted, tail tucked back
    const coil = rec.coil;
    V.holder.position.set(
      0,
      -V.size.y * 0.55 * coil,
      -V.size.z * 0.3 * coil - V.size.z * 0.2 * rear + rec.lunge * V.size.z * 0.42
    );
    // the head sprites live in holder space, so they rear with the same angles
    const rx = -0.45 * coil - 0.18 * rear;
    const rz = 0.26 * coil;
    V.fixGroup.rotation.x = rx;
    V.fixGroup.rotation.z = rz;
    V.attach.rotation.x = rx;
    V.attach.rotation.z = rz;

    if (V.coil) {
      const o = clamp(coil * rec.fade, 0, 1);
      V.coil.group.visible = o > 0.02;
      V.coil.mat.opacity = o;
      const b = 1 + Math.sin(t * 0.9 + rec.phase) * 0.03;
      V.coil.group.scale.set(b, 2 - b, b);
    }

    // wake while the body is still driving forward
    if (rec.lunge > 0.15) {
      rec.wakeT -= dt;
      if (rec.wakeT <= 0) { rec.wakeT = 0.06; ambushWake(rec, 2); }
    }
    return rear;
  }

  // Drift pose: the venom flash left behind when a jelly brushes someone,
  // plus the occasional bioluminescent mote sloughing off the bell.
  function updateDrift(rec, dt) {
    const V = rec.visual;
    rec.sting = Math.max(0, rec.sting - dt * 2.2);
    if (V.sting) {
      const o = rec.sting * rec.sting;
      const on = o > 0.02;
      if (V.sting.visible !== on) V.sting.visible = on;
      if (on) {
        V.sting.material.opacity = clamp(o * 0.95 * rec.fade, 0, 1);
        const sz = Math.max(0.4, V.size.x * rec.vis.sting.size) * (0.75 + (1 - rec.sting) * 1.3);
        V.sting.scale.set(sz, sz, 1);
      }
    }
    if (rec.vis.mote && Math.random() < dt * 1.2) {
      sparks.spawn(
        rec.renderPos.x + (Math.random() - 0.5) * V.size.x,
        rec.renderPos.y + 0.1,
        rec.renderPos.z + (Math.random() - 0.5) * V.size.x,
        (Math.random() - 0.5) * 0.12, 0.1 + Math.random() * 0.14, (Math.random() - 0.5) * 0.12,
        0.07, 1.1, rec.vis.mote, 0, 0.8
      );
    }
  }

  function updateEnemy(rec, dt, t, weaponActive, weaponRange, hasLocal) {
    const vis = rec.vis;
    const swarm = rec.behavior === 'swarm';
    const stunned = rec.stunned && !rec.dead && rec.despawn === 0;
    // wave 7: the flinch recoil from the last landed hit
    if (rec.recoil > 0) rec.recoil = Math.max(0, rec.recoil - dt / RECOIL_TIME);

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
    const drift = rec.behavior === 'drift';
    if (drift && !rec.dead) {
      // a jelly has no front — it turns on its own axis and lolls with the swell
      rec.yaw += rec.driftSpin * dt;
      rec.pitch = damp(rec.pitch, Math.sin(t * 0.53 + rec.phase) * 0.22, 2.0, dt);
      rec.roll = damp(rec.roll, Math.cos(t * 0.41 + rec.phase * 1.7) * 0.22, 2.0, dt);
      rec.toYaw = rec.yaw;
      rec.fromYaw = rec.yaw;
    } else {
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
      // razorfins bank HARD — they change direction like a thrown knife
      const turnRate = rec.dead ? 1.2 : (swarm ? 13 : 6.5);
      const turn = yawErr * (1 - Math.exp(-turnRate * dt));
      rec.yaw += turn;
      rec.pitch = damp(rec.pitch, desiredPitch, rec.dead ? 2 : (swarm ? 8 : 5), dt);
      if (!rec.dead) {
        const bankK = swarm ? 0.26 : 0.12, bankMax = swarm ? 1.25 : 0.6;
        rec.roll = damp(rec.roll, clamp(-turn / Math.max(dt, 0.001) * bankK, -bankMax, bankMax), swarm ? 8 : 5, dt);
      }
    }

    // ---- wave 7: a stunned enemy hangs there, listing, pointing nowhere ----
    if (stunned) {
      rec.roll = damp(rec.roll, STUN_LIST, 3.0, dt);
      rec.pitch = damp(rec.pitch, 0.15, 2.2, dt);
    }

    // ---- wave 7: the razorfin dart-in. Fast enough to be a lunge = a bite. ----
    if (swarm && !rec.dead && !stunned) {
      rec.lungeCd -= dt;
      if (rec.lungeCd <= 0 && speed > rec.def.speed * SWARM_LUNGE_SPEED) {
        rec.lungeCd = 0.42 + Math.random() * 0.34;
        rec.lunge = Math.max(rec.lunge, 0.92);
        rec.telegraph = Math.max(rec.telegraph, 0.7);
        if (Math.random() < 0.4) {
          bubbles.burst(rec.renderPos.x, rec.renderPos.y, rec.renderPos.z, 3, 0.7,
            0.07, 0.8, 0xdff2ff, 0.9, 1.4, 0, 0, 0, 0);
        }
      }
    }

    // ---- transform ----
    let bob = rec.dead ? 0 : Math.sin(t * 1.15 + rec.phase) * 0.05 * vis.bob;
    let swayX = 0, swayZ = 0;
    if (drift && !rec.dead) {
      // slow bobbing drift — the server only moves it a little, the float is ours
      bob = Math.sin(t * 0.55 + rec.phase) * 0.26 + Math.sin(t * 1.31 + rec.phase * 2.1) * 0.06;
      swayX = Math.sin(t * 0.37 + rec.phase) * 0.13;
      swayZ = Math.cos(t * 0.41 + rec.phase * 1.7) * 0.13;
    }
    // ---- wave 7: frenzied schooling jitter (razorfins never hold a line) ----
    let jitYaw = 0, jitRoll = 0;
    if (swarm && !rec.dead) {
      const ph = rec.swarmSeed;
      const hot = rec.aggro ? 1.7 : 1;
      if (stunned) {
        // dazed: a slow woozy wallow instead of the frenzy
        bob += Math.sin(t * 1.1 + ph) * 0.09;
        jitRoll = Math.sin(t * 0.9 + ph) * 0.12;
      } else {
        swayX += Math.sin(t * 9.3 * hot + ph) * 0.15 + Math.sin(t * 23.1 + ph * 2.3) * 0.05;
        bob += Math.sin(t * 7.9 * hot + ph * 1.7) * 0.12;
        swayZ += Math.cos(t * 8.7 * hot + ph * 0.7) * 0.15 + Math.cos(t * 19.7 + ph * 1.3) * 0.05;
        jitYaw = Math.sin(t * 6.3 * hot + ph) * 0.30 + Math.sin(t * 18.1 + ph * 3.1) * 0.10;
        jitRoll = Math.sin(t * 5.1 * hot + ph * 2.3) * 0.5;
      }
    } else if (stunned) {
      bob += Math.sin(t * 0.9 + rec.phase) * 0.06 * vis.bob;
    }

    rec.wrapper.position.set(
      rec.renderPos.x + rec.nudge.x + swayX,
      rec.renderPos.y + rec.nudge.y + rec.sinkY + bob,
      rec.renderPos.z + rec.nudge.z + swayZ
    );
    rec.wrapper.rotation.set(rec.pitch, rec.yaw + jitYaw, rec.roll + jitRoll);

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

    // ---- behaviour pose ----
    let rear = 0;
    if (rec.behavior === 'ambush' && !rec.dead) {
      rear = updateAmbush(rec, dt, t, aggro);
    } else {
      if (rec.dim !== 1 || rec.coil > 0.0005) {
        // a killed ambusher unwinds and brightens so the death read is clear
        rec.dim = damp(rec.dim, 1, 4, dt);
        rec.coil = damp(rec.coil, 0, 4, dt);
        const rx = -0.45 * rec.coil, rz = 0.26 * rec.coil;
        rec.visual.fixGroup.rotation.x = rx;
        rec.visual.fixGroup.rotation.z = rz;
        rec.visual.attach.rotation.x = rx;
        rec.visual.attach.rotation.z = rz;
        if (rec.visual.coil) {
          rec.visual.coil.mat.opacity = clamp(rec.coil * rec.fade, 0, 1);
          rec.visual.coil.group.visible = rec.coil > 0.02;
        }
      }
      if (drift && !rec.dead) updateDrift(rec, dt);
      // dart forward while lunging
      rec.visual.holder.position.set(
        0,
        -rec.visual.size.y * 0.55 * rec.coil,
        rec.lunge > 0.01 ? rec.lunge * rec.visual.size.z * 0.22 : 0
      );
    }

    // ---- wave 7: recoil kick — a short backwards yank on any landed hit ----
    if (rec.recoil > 0.001 && !rec.dead) {
      const rk = rec.recoil * rec.recoil;
      rec.visual.holder.position.z -= rk * rec.visual.size.z * 0.16;
      rec.visual.holder.position.y += rk * rec.visual.size.y * 0.06;
    }

    const s = 1 + pulse * 0.14 + rec.lunge * 0.22;
    rec.wrapper.scale.set(s, s, s + rec.lunge * 0.18 + rear * 0.16);

    // ---- menace aura ----
    if (rec.visual.aura) {
      const au = vis.aura;
      const hot = rec.behavior === 'ambush' ? clamp(1 - rec.coil, 0, 1) : (aggro ? 1 : 0);
      const beat = 0.72 + Math.sin(t * 1.35 + rec.phase) * 0.28;
      const sp = rec.visual.aura;
      sp.material.opacity = clamp((au.idle + (au.hot - au.idle) * hot) * beat * rec.fade, 0, 1);
      const asz = Math.max(0.5, rec.visual.size.z * au.size * 0.25) * (0.9 + hot * 0.4 + pulse * 0.3);
      sp.scale.set(asz, asz, 1);
    }

    // ---- swim animation (a stunned enemy is frozen mid-stroke) ----
    const speedFactor = clamp(speed / Math.max(1, rec.def.speed), 0, 1.6);
    const rate = stunned ? 0
      : vis.animBase * (aggro ? 2.1 : 1.0) * (0.75 + speedFactor * 0.9) * (rec.dead ? 0.25 : 1) * (dreadMode ? 1.15 : 1);
    rec.animClock += dt * rate;
    if (rec.visual.hasAnim) {
      try { rec.visual.fishGroup.userData.update(rec.animClock); } catch (e) { rec.visual.hasAnim = false; }
    }

    // ---- wave 7: dazed stars orbiting the head ----
    if (stunned) {
      if (!rec.stars) rec.stars = acquireStars();
      const g = rec.stars;
      headCenter(rec, _hv);
      const rr = Math.max(0.32, rec.def.size * 0.52);
      g.position.set(_hv.x, _hv.y + rr * 1.15, _hv.z);
      const list = g.userData.stars;
      for (let i = 0; i < list.length; i++) {
        const a = t * 3.1 + (i / list.length) * Math.PI * 2;
        list[i].position.set(Math.cos(a) * rr, Math.sin(a * 2 + i) * rr * 0.22, Math.sin(a) * rr);
        const sz = rr * 0.5 * (0.75 + 0.25 * Math.sin(t * 8.5 + i * 1.9));
        list[i].scale.set(sz, sz, 1);
        list[i].material.opacity = clamp(rec.fade * (0.5 + 0.5 * Math.sin(t * 6.2 + i * 1.7)), 0, 1);
      }
    } else if (rec.stars) {
      releaseStars(rec);
    }

    // ---- eyes ----
    const eyeTarget = rec.dead ? 0
      : (stunned ? vis.eyeIdle * 0.55 : (aggro ? 1 : (dreadMode ? vis.eyeIdle * 2.2 : vis.eyeIdle)));
    // ambushers snap their eyes open on the telegraph and cool off slowly
    const eyeRate = aggro ? (rec.uncoil > 0 ? 26 : 12) : (rec.behavior === 'ambush' ? 1.6 : 4);
    rec.eyeLit = damp(rec.eyeLit, eyeTarget, eyeRate, dt);
    const flicker = stunned ? (0.3 + 0.7 * Math.abs(Math.sin(t * 8.7 + rec.phase)))
      : (aggro ? (0.82 + Math.sin(t * 17 + rec.phase) * 0.18) : 1);
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

    // ---- drifting sting: contact, not aggro, is what hurts ----
    if (drift && hasLocal && !rec.dead && rec.despawn === 0) {
      const reach = rec.radius + STING_RANGE_PAD;
      if (rec.renderPos.distanceToSquared(_localPos) < reach * reach && now - rec.lastBite > BITE_COOLDOWN) {
        rec.lastBite = now;
        triggerSting(rec);
        bubbles.burst(_localPos.x, _localPos.y, _localPos.z, 5, 1.0,
          0.08, 0.9, 0xdaffd0, 0.9, 1.4, 0, 0, 0, 0);
        if (ctx.bus && typeof ctx.bus.emit === 'function') {
          stingEmitting = true;
          try { ctx.bus.emit('localDamaged', { dmg: rec.def.dmg, cause: rec.def.name }); }
          finally { stingEmitting = false; }
        }
      }
    }

    // ---- bite feedback on the local player (visuals only, damage is server-side) ----
    if (aggro && hasLocal && !drift) {
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
    rec.crit = Math.max(0, rec.crit - dt * 4.2);
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
    let swarmLive = 0;
    for (const rec of enemies.values()) {
      if (rec.behavior === 'swarm' && !rec.dead && rec.despawn === 0) swarmLive++;
      updateEnemy(rec, dt, t, weaponActive, weaponRange, hasLocal);
    }

    // ---- wave 7: your own frenzy keeps the lens rattling while it lasts ----
    if (frenzy.mine && frenzy.active) {
      if (swarmLive > 0) camShake = Math.max(camShake, 0.14 + Math.min(0.16, swarmLive * 0.02));
      else if (now - frenzy.startedAt > 3) {
        // the pack is gone and no 'end' ever arrived — do not rattle forever
        frenzy.active = false; frenzy.mine = false; frenzy.targetId = null;
        frenzyLoop(false);
      }
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
