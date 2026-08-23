// =============================================================
// TIDEWRECK ISLAND — loot.js
// Sunken treasure: the whole reason to hold your breath and go down.
//
// Owns:
//   * The live loot nodes the server broadcasts (MSG.LOOT_STATE) — one
//     procedural silhouette per LOOT_TYPES.model (clam, coin stash, bottle,
//     chest, relic, geode), snapped to THIS client's seabed with a natural
//     resting tilt and a soft glow + rising motes so a diver can pick them
//     out of dark water from ~20 m without them reading as a beacon.
//   * The proximity flow: bus 'lootNear' {lootId, name} / null for ui.js's
//     "E — <name>" prompt, MSG.PICKUP_LOOT on E, the open/collect FX on
//     MSG.LOOT_RESULT, and a verbatim bus 'lootResult' re-emit for ui.
//
// Everything is procedural (code-built geometry, one canvas gradient) and
// budgeted: meshes exist only for nodes near the local player, every mote
// lives in one fixed additive Points field, and update() allocates nothing.
// =============================================================

import * as THREE from 'three';
import { MSG, LOOT_TYPES, LOOT_RULES } from '/shared/constants.js';

// ------------------------------------------------------------------
// Tunables
// ------------------------------------------------------------------
const PICKUP_RANGE = (LOOT_RULES && typeof LOOT_RULES.PICKUP_RANGE === 'number') ? LOOT_RULES.PICKUP_RANGE : 4;
const BUILD_DIST = 74;        // metres (XZ): build a mesh inside this
const DROP_DIST = 98;         // ...and throw it away outside this (hysteresis)
const NEAR_BOTTOM = 5.0;      // vertical slack that still counts as "at the seabed"
const SEND_COOLDOWN = 0.55;   // seconds between PICKUP_LOOT attempts
const OPEN_TIME = 1.15;       // seconds of open/collect FX before the mesh goes
const MOTE_PERIOD = 0.44;     // seconds between a node's ambient motes
const MOTE_DIST2 = 46 * 46;   // only bother spawning motes this close

const TAU = Math.PI * 2;

// ------------------------------------------------------------------
// Scratch — module level so the frame loop allocates nothing
// ------------------------------------------------------------------
const _local = new THREE.Vector3();

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

// deterministic per-node randomness (tilt, coin scatter, crystal spread)
function hash32(s) {
  let h = 2166136261;
  const str = String(s);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rngFrom(seedStr) {
  let s = hash32(seedStr) || 1;
  return function () {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// ------------------------------------------------------------------
// Per-model presentation: halo tint/size, mote colour, the cue audio.js plays
// ------------------------------------------------------------------
const LOOT_STYLE = {
  clam: { glow: 0xbfe9ff, mote: 0xdff4ff, haloSize: 1.05, haloOp: 0.30, haloY: 0.24, sfx: 'pearlPop', sink: 0.05 },
  coins: { glow: 0xffcf66, mote: 0xffe6a0, haloSize: 1.00, haloOp: 0.26, haloY: 0.20, sfx: 'coinScoop', sink: 0.02 },
  bottle: { glow: 0x8effc0, mote: 0xcfffe0, haloSize: 0.85, haloOp: 0.24, haloY: 0.16, sfx: 'pickupPop', sink: 0.02 },
  chest: { glow: 0xffc46a, mote: 0xffdf9c, haloSize: 1.35, haloOp: 0.32, haloY: 0.34, sfx: 'chestOpen', sink: 0.07 },
  relic: { glow: 0x5ff0d8, mote: 0xa8fff0, haloSize: 1.25, haloOp: 0.30, haloY: 0.46, sfx: 'relicHum', sink: 0.10 },
  geode: { glow: 0xbb7cff, mote: 0xdcb8ff, haloSize: 1.30, haloOp: 0.34, haloY: 0.28, sfx: 'geodeChime', sink: 0.08 },
};
function styleFor(model) { return LOOT_STYLE[model] || LOOT_STYLE.coins; }

function modelFor(type) {
  const def = LOOT_TYPES && LOOT_TYPES[type];
  const m = def && def.model;
  if (m && LOOT_STYLE[m]) return m;
  return LOOT_STYLE[type] ? type : 'coins';
}
function nameFor(type) {
  const def = LOOT_TYPES && LOOT_TYPES[type];
  return (def && def.name) ? def.name : 'Sunken Treasure';
}

// ------------------------------------------------------------------
// Shared canvas glow + shared primitive geometry (module lifetime, never
// disposed — a handful of tiny buffers reused by every node ever built)
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
  grd.addColorStop(0.25, 'rgba(255,255,255,0.70)');
  grd.addColorStop(0.60, 'rgba(255,255,255,0.16)');
  grd.addColorStop(1.00, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  _glowTex = new THREE.CanvasTexture(cv);
  _glowTex.colorSpace = THREE.SRGBColorSpace;
  return _glowTex;
}

let G = null;
function geos() {
  if (G) return G;
  G = {
    box: new THREE.BoxGeometry(1, 1, 1),
    ball: new THREE.SphereGeometry(0.5, 12, 8),
    dome: new THREE.SphereGeometry(0.5, 11, 5, 0, TAU, 0, Math.PI * 0.5),
    cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 12, 1),
    cyl6: new THREE.CylinderGeometry(0.5, 0.5, 1, 6, 1),
    cone: new THREE.ConeGeometry(0.5, 1, 8),
    rock: new THREE.IcosahedronGeometry(0.5, 0),
    rock1: new THREE.IcosahedronGeometry(0.5, 1),
    shard: new THREE.OctahedronGeometry(0.5, 0),
    // half tube: axis along X, dome up, flat face at y = 0 (chest lid)
    lid: (() => {
      const g = new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 1, false, 0, Math.PI);
      g.rotateZ(Math.PI / 2);
      return g;
    })(),
    plane: new THREE.PlaneGeometry(1, 1),
  };
  return G;
}

// ------------------------------------------------------------------
// Motes — one additive Points field for every node's ambient sparkle and
// every collect burst. Fixed pool, ring-buffer cursor, zero allocation.
// ------------------------------------------------------------------
const MOTE_VERT = `
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

const MOTE_FRAG = `
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

class MoteField {
  constructor(count) {
    this.count = count;
    this.cursor = 0;
    this.dirty = false;

    this.pos = new Float32Array(count * 3);
    this.col = new Float32Array(count * 3);
    this.siz = new Float32Array(count);
    this.alp = new Float32Array(count);
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.maxLife = new Float32Array(count);
    this.size0 = new Float32Array(count);
    this.drag = new Float32Array(count);
    this._c = new THREE.Color();

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
      vertexShader: MOTE_VERT,
      fragmentShader: MOTE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    this.points.matrixAutoUpdate = false;
  }

  spawn(x, y, z, vx, vy, vz, size, life, color, drag) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.count;
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this._c.set(color);
    this.col[i3] = this._c.r; this.col[i3 + 1] = this._c.g; this.col[i3 + 2] = this._c.b;
    this.siz[i] = size;
    this.size0[i] = size;
    this.alp[i] = 1;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.drag[i] = drag || 0;
    this.dirty = true;
  }

  burst(x, y, z, n, spread, rise, size, life, color) {
    for (let k = 0; k < n; k++) {
      const vx = (Math.random() - 0.5) * 2 * spread;
      const vy = (Math.random() - 0.5) * spread + rise;
      const vz = (Math.random() - 0.5) * 2 * spread;
      this.spawn(
        x + vx * 0.05, y + Math.abs(vy) * 0.03, z + vz * 0.05,
        vx, vy, vz,
        size * (0.6 + Math.random() * 0.8),
        life * (0.65 + Math.random() * 0.7),
        color, 1.4
      );
    }
  }

  update(dt) {
    const pos = this.pos, vel = this.vel, life = this.life, maxLife = this.maxLife;
    const siz = this.siz, alp = this.alp, size0 = this.size0, drag = this.drag;
    let live = 0;
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
      vel[i3 + 1] *= d;
      vel[i3 + 2] *= d;
      pos[i3] += vel[i3] * dt + Math.sin((nl + i) * 2.6) * dt * 0.06;
      pos[i3 + 1] += (vel[i3 + 1] + 0.16) * dt;      // treasure light always drifts up
      pos[i3 + 2] += vel[i3 + 2] * dt + Math.cos((nl + i * 0.6) * 2.2) * dt * 0.06;
      const f = nl / maxLife[i];
      alp[i] = f * f;
      siz[i] = size0[i] * (0.35 + f * 0.75);
      this.dirty = true;
    }
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
    this.dirty = true;
  }
}

// ------------------------------------------------------------------
// Material / mesh helpers. Every material is per-node (they pulse and flash
// independently) and tracked in `mats` so removal disposes exactly ours.
// ------------------------------------------------------------------
function solidMat(mats, color, rough, metal, emissive, ei) {
  const m = new THREE.MeshStandardMaterial({
    color,
    roughness: rough === undefined ? 0.8 : rough,
    metalness: metal === undefined ? 0.05 : metal,
    flatShading: true,
    emissive: emissive === undefined ? 0x000000 : emissive,
    emissiveIntensity: ei === undefined ? 0 : ei,
  });
  mats.push(m);
  return m;
}
function glassMat(mats, color, opacity, emissive) {
  const m = new THREE.MeshStandardMaterial({
    color, roughness: 0.16, metalness: 0.1, flatShading: true,
    transparent: true, opacity, depthWrite: false,
    emissive: emissive === undefined ? 0x000000 : emissive, emissiveIntensity: 0.6,
  });
  mats.push(m);
  return m;
}
function addMat(mats, color, opacity) {
  const m = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
  });
  mats.push(m);
  return m;
}
function haloSprite(mats, color, size, opacity) {
  const m = new THREE.SpriteMaterial({
    map: glowTexture(), color, transparent: true, opacity,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, fog: false,
  });
  mats.push(m);
  const s = new THREE.Sprite(m);
  s.scale.set(size, size, 1);
  return s;
}
function put(parent, geo, mat, sx, sy, sz, px, py, pz) {
  const m = new THREE.Mesh(geo, mat);
  m.scale.set(sx, sy, sz);
  m.position.set(px, py, pz);
  parent.add(m);
  return m;
}

// ==================================================================
// Procedural loot models. Each builder returns { anim(t, near, phase),
// open(k) }; everything it creates hangs off `g`, materials go in `mats`.
// ==================================================================

// Pearl Clam — two ridged shell halves on a hinge, a pearlescent seam, and a
// pearl that only shows itself once the shell is pried open.
function buildClam(g, mats, rng) {
  const A = geos();
  const shellMat = solidMat(mats, 0xd9cbb6, 0.72, 0.06, 0x33414d, 0.3);
  const innerMat = solidMat(mats, 0xf3e6ef, 0.34, 0.14, 0x6f8ea8, 0.55);
  const pearlMat = solidMat(mats, 0xfff6fb, 0.2, 0.25, 0xbfe9ff, 1.4);
  const seamMat = addMat(mats, 0xbfe9ff, 0.32);

  const lower = put(g, A.dome, shellMat, 0.62, 0.30, 0.50, 0, 0.115, 0);
  lower.rotation.x = Math.PI;                        // dome facing down
  put(g, A.dome, innerMat, 0.55, 0.10, 0.44, 0, 0.12, 0);

  // hinge at the back so the top shell yawns open toward the diver
  const hinge = new THREE.Group();
  hinge.position.set(0, 0.12, -0.2);
  g.add(hinge);
  put(hinge, A.dome, shellMat, 0.62, 0.32, 0.50, 0, 0, 0.2);
  for (let i = 0; i < 3; i++) {          // growth ridges
    const r = 0.5 - i * 0.12;
    put(hinge, A.dome, shellMat, r * 1.2, 0.34 + i * 0.03, r * 0.98, 0, 0.005, 0.2);
  }
  const upperIn = put(hinge, A.dome, innerMat, 0.54, 0.11, 0.43, 0, -0.008, 0.2);
  upperIn.rotation.x = Math.PI;

  const seam = put(g, A.plane, seamMat, 0.72, 0.13, 1, 0, 0.135, 0.08);
  seam.rotation.x = -1.15;
  const pearl = put(g, A.ball, pearlMat, 0.14, 0.14, 0.14, 0, 0.13, 0.02);
  pearl.visible = false;

  return {
    anim(t, near, phase) {
      seamMat.opacity = clamp(0.30 + Math.sin(t * 1.7 + phase) * 0.13 + near * 0.3, 0, 1);
      hinge.rotation.x = -0.05 - Math.sin(t * 0.9 + phase) * 0.03 - near * 0.07;
    },
    open(k) {
      hinge.rotation.x = -0.05 - k * 1.05;
      pearl.visible = true;
      pearl.position.y = 0.13 + k * 0.55;
      const s = 0.14 * (0.4 + k * 0.9);
      pearl.scale.set(s, s, s);
      pearlMat.emissiveIntensity = 1.4 + k * 3.6;
      seamMat.opacity = clamp(0.7 - k * 0.7, 0, 1);
    },
  };
}

// Coin Stash — a low mound of struck discs half-sunk in the sand, with one
// slow glint sweeping across the pile.
function buildCoins(g, mats, rng) {
  const A = geos();
  const goldMat = solidMat(mats, 0xd9a83c, 0.32, 0.9, 0x6a4a08, 0.35);
  const darkMat = solidMat(mats, 0x9c7a2a, 0.46, 0.85, 0x3a2a06, 0.25);
  const glintMat = new THREE.SpriteMaterial({
    map: glowTexture(), color: 0xfff2c0, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  });
  mats.push(glintMat);

  const pile = new THREE.Group();
  g.add(pile);
  const COINS = 17;
  for (let i = 0; i < COINS; i++) {
    const a = rng() * TAU;
    const r = Math.pow(rng(), 0.7) * 0.32;
    const y = 0.018 + (1 - r / 0.34) * rng() * 0.12;
    const c = put(pile, A.cyl6, i % 3 === 0 ? darkMat : goldMat,
      0.15 + rng() * 0.05, 0.022, 0.15 + rng() * 0.05,
      Math.cos(a) * r, y, Math.sin(a) * r);
    c.rotation.set((rng() - 0.5) * 1.1, rng() * TAU, (rng() - 0.5) * 1.1);
  }
  // a couple of stacked columns so the pile has silhouette
  for (let s = 0; s < 2; s++) {
    const a = rng() * TAU;
    const r = 0.1 + rng() * 0.12;
    for (let i = 0; i < 4; i++) {
      put(pile, A.cyl6, goldMat, 0.16, 0.022, 0.16,
        Math.cos(a) * r, 0.03 + i * 0.026, Math.sin(a) * r);
    }
  }
  const glint = new THREE.Sprite(glintMat);
  glint.scale.set(0.42, 0.42, 1);
  glint.position.set(0, 0.14, 0);
  g.add(glint);

  return {
    anim(t, near, phase) {
      const s = Math.sin(t * 1.35 + phase);
      glintMat.opacity = clamp(Math.pow(Math.max(0, s), 9) * (0.75 + near * 0.5), 0, 1);
      glint.position.x = Math.cos(t * 0.7 + phase) * 0.16;
      glint.position.z = Math.sin(t * 0.55 + phase * 1.7) * 0.16;
      goldMat.emissiveIntensity = 0.35 + near * 0.45;
    },
    open(k) {
      pile.position.y = k * 0.34;
      const s = clamp(1 - k * 0.85, 0.05, 1);
      pile.scale.set(s, s, s);
      pile.rotation.y = k * 2.2;
      glintMat.opacity = clamp(1 - k, 0, 1);
    },
  };
}

// Message in a Bottle — green glass on its side, a rolled note inside, wax
// cork, rocking gently as if it never quite gave up on floating.
function buildBottle(g, mats, rng) {
  const A = geos();
  const glass = glassMat(mats, 0x2f7f4a, 0.62, 0x0f3a20);
  const corkMat = solidMat(mats, 0xb08a52, 0.92, 0.02);
  const noteMat = solidMat(mats, 0xe8dcb0, 0.85, 0.0, 0x6a6040, 0.35);
  const shineMat = addMat(mats, 0x9fffc8, 0.2);

  // lying on its side: the whole bottle is built along +Y then tipped over
  const body = new THREE.Group();
  body.rotation.z = Math.PI / 2;
  body.position.y = 0.1;
  g.add(body);
  put(body, A.cyl, glass, 0.19, 0.34, 0.19, 0, 0, 0);
  const shoulder = put(body, A.cone, glass, 0.19, 0.12, 0.19, 0, 0.23, 0);
  shoulder.scale.y = 0.12;
  put(body, A.cyl, glass, 0.085, 0.14, 0.085, 0, 0.27, 0);
  put(body, A.cyl, glass, 0.105, 0.03, 0.105, 0, 0.34, 0);
  put(body, A.cyl, corkMat, 0.075, 0.05, 0.075, 0, 0.36, 0);
  // the note: a tight roll wedged in the belly
  const note = put(body, A.cyl6, noteMat, 0.105, 0.24, 0.105, 0.015, -0.02, 0);
  note.rotation.z = 0.12;
  put(body, A.plane, shineMat, 0.06, 0.4, 1, 0.1, 0.02, 0.16);

  return {
    anim(t, near, phase) {
      // never quite gave up on floating
      body.rotation.z = Math.PI / 2 + Math.sin(t * 0.9 + phase) * 0.05;
      body.position.y = 0.1 + Math.sin(t * 1.25 + phase) * 0.012;
      shineMat.opacity = clamp(0.16 + Math.sin(t * 2.1 + phase) * 0.08 + near * 0.25, 0, 1);
      noteMat.emissiveIntensity = 0.35 + near * 0.5;
    },
    open(k) {
      body.position.y = 0.1 + k * 0.5;
      body.rotation.y = k * 4.2;
      body.rotation.z = Math.PI / 2 - k * 0.9;
      const s = clamp(1 - k * 0.6, 0.1, 1);
      body.scale.set(s, s, s);
      shineMat.opacity = clamp(0.6 * (1 - k), 0, 1);
    },
  };
}

// Sunken Chest — strapped oak, brass latch, a hairline of gold light leaking
// out of the lid seam. The lid is hinged at the back and really swings.
function buildChest(g, mats, rng) {
  const A = geos();
  const wood = solidMat(mats, 0x6d4a2a, 0.9, 0.02, 0x1a0e06, 0.2);
  const darkWood = solidMat(mats, 0x4e3320, 0.92, 0.02);
  const iron = solidMat(mats, 0x3a3238, 0.5, 0.75);
  const brass = solidMat(mats, 0xc9a04a, 0.34, 0.9, 0x4a3406, 0.3);
  const seamMat = addMat(mats, 0xffc46a, 0.3);
  const innerMat = addMat(mats, 0xffd98a, 0.0);

  put(g, A.box, wood, 0.88, 0.42, 0.60, 0, 0.21, 0);
  // plank grooves
  for (let i = 0; i < 3; i++) {
    put(g, A.box, darkWood, 0.9, 0.02, 0.615, 0, 0.1 + i * 0.11, 0);
  }
  // iron straps around the body
  for (let i = 0; i < 2; i++) {
    put(g, A.box, iron, 0.055, 0.44, 0.625, (i ? 1 : -1) * 0.3, 0.21, 0);
  }
  put(g, A.box, iron, 0.9, 0.05, 0.05, 0, 0.02, 0.3);

  const lidPivot = new THREE.Group();
  lidPivot.position.set(0, 0.42, -0.28);
  g.add(lidPivot);
  const lid = new THREE.Group();
  lid.position.set(0, 0, 0.28);
  lidPivot.add(lid);
  put(lid, A.lid, wood, 0.88, 0.34, 0.60, 0, 0, 0);
  for (let i = 0; i < 2; i++) {
    put(lid, A.lid, iron, 0.055, 0.355, 0.615, (i ? 1 : -1) * 0.3, 0.002, 0);
  }
  put(lid, A.box, innerMat, 0.8, 0.02, 0.5, 0, -0.005, 0);
  // latch
  put(g, A.box, brass, 0.13, 0.11, 0.05, 0, 0.4, 0.305);
  put(lid, A.box, brass, 0.1, 0.08, 0.05, 0, 0.03, 0.3);

  const seam = put(g, A.box, seamMat, 0.9, 0.018, 0.62, 0, 0.425, 0);

  return {
    anim(t, near, phase) {
      const p = 0.22 + Math.sin(t * 1.5 + phase) * 0.1 + near * 0.35;
      seamMat.opacity = clamp(p, 0, 1);
      seam.scale.y = 0.018 + Math.sin(t * 1.5 + phase) * 0.004;
      lidPivot.rotation.x = -Math.sin(t * 0.8 + phase) * 0.012 - near * 0.05;
    },
    open(k) {
      const e = 1 - Math.pow(1 - k, 2.4);
      lidPivot.rotation.x = -e * 1.32;
      innerMat.opacity = clamp(e * 0.85, 0, 1);
      seamMat.opacity = clamp(0.6 + e * 0.4, 0, 1);
      seam.scale.y = 0.018 + e * 0.02;
    },
  };
}

// Ancient Relic — a carved tablet-idol standing half-buried in the silt, its
// grooves still holding a slow teal charge.
function buildRelic(g, mats, rng) {
  const A = geos();
  const stone = solidMat(mats, 0x6f7a72, 0.95, 0.03, 0x0e1a16, 0.25);
  const darkStone = solidMat(mats, 0x4b544e, 0.96, 0.03);
  const runeMat = addMat(mats, 0x5ff0d8, 0.45);
  const eyeMat = addMat(mats, 0x9dfff0, 0.6);

  const idol = new THREE.Group();
  idol.rotation.x = -0.14;
  g.add(idol);
  // base slab
  put(idol, A.box, darkStone, 0.62, 0.12, 0.34, 0, 0.06, 0);
  // tablet body, slightly tapered by stacking two boxes
  put(idol, A.box, stone, 0.5, 0.5, 0.16, 0, 0.36, 0);
  put(idol, A.box, stone, 0.42, 0.26, 0.15, 0, 0.72, 0);
  // carved head with a heavy brow
  put(idol, A.box, stone, 0.3, 0.2, 0.17, 0, 0.93, 0);
  put(idol, A.box, darkStone, 0.32, 0.05, 0.19, 0, 1.0, 0);
  // shoulders
  for (let i = 0; i < 2; i++) {
    put(idol, A.box, darkStone, 0.1, 0.3, 0.13, (i ? 1 : -1) * 0.29, 0.44, 0);
  }
  // eyes
  const eyes = [];
  for (let i = 0; i < 2; i++) {
    eyes.push(put(idol, A.box, eyeMat, 0.06, 0.035, 0.02, (i ? 1 : -1) * 0.075, 0.935, 0.088));
  }
  // rune grooves down the face
  const runes = [];
  for (let i = 0; i < 4; i++) {
    const w = 0.1 + rng() * 0.22;
    runes.push(put(idol, A.box, runeMat, w, 0.028, 0.02,
      (rng() - 0.5) * 0.16, 0.2 + i * 0.13, 0.085));
  }
  put(idol, A.box, runeMat, 0.028, 0.34, 0.02, 0, 0.36, 0.085);

  return {
    anim(t, near, phase) {
      const p = 0.32 + Math.sin(t * 1.05 + phase) * 0.16 + near * 0.35;
      runeMat.opacity = clamp(p, 0, 1);
      eyeMat.opacity = clamp(0.4 + Math.sin(t * 0.7 + phase * 1.4) * 0.2 + near * 0.4, 0, 1);
      for (let i = 0; i < runes.length; i++) {
        const s = 1 + Math.sin(t * 2.2 + i * 1.3 + phase) * 0.12;
        runes[i].scale.y = 0.028 * s;
      }
      idol.rotation.z = Math.sin(t * 0.5 + phase) * 0.01;
    },
    open(k) {
      idol.position.y = k * 0.55;
      idol.rotation.y = k * 3.4;
      idol.rotation.x = -0.14 + k * 0.14;
      runeMat.opacity = clamp(0.5 + k * 0.5, 0, 1);
      eyeMat.opacity = clamp(0.5 + k * 0.5, 0, 1);
      const s = clamp(1 - k * 0.5, 0.2, 1);
      idol.scale.set(s, s, s);
    },
  };
}

// Abyssal Geode — a dull boulder split open, violet crystal light bleeding
// out of the crack.
function buildGeode(g, mats, rng) {
  const A = geos();
  const rock = solidMat(mats, 0x3b3742, 0.95, 0.05, 0x120f18, 0.2);
  const rind = solidMat(mats, 0x2a2632, 0.96, 0.05);
  const crystal = solidMat(mats, 0x8b5cff, 0.22, 0.15, 0xbb7cff, 1.6);
  const crackMat = addMat(mats, 0xc79bff, 0.35);

  const left = new THREE.Group();
  const right = new THREE.Group();
  g.add(left);
  g.add(right);
  put(left, A.rock1, rock, 0.62, 0.5, 0.56, -0.12, 0.26, 0);
  put(left, A.rock, rind, 0.5, 0.4, 0.46, -0.2, 0.24, 0.04);
  put(right, A.rock1, rock, 0.58, 0.46, 0.54, 0.14, 0.24, 0);
  put(right, A.rock, rind, 0.46, 0.36, 0.42, 0.22, 0.22, -0.04);
  left.rotation.z = 0.16;
  right.rotation.z = -0.12;

  // crystals sitting in the split
  const shards = [];
  for (let i = 0; i < 8; i++) {
    const a = rng() * TAU;
    const r = rng() * 0.11;
    const s = 0.05 + rng() * 0.08;
    const c = put(g, A.shard, crystal, s, s * (1.4 + rng()), s,
      Math.cos(a) * r * 0.4, 0.2 + rng() * 0.18, Math.sin(a) * r);
    c.rotation.set((rng() - 0.5) * 1.0, rng() * TAU, (rng() - 0.5) * 1.0);
    shards.push(c);
  }
  const crack = put(g, A.plane, crackMat, 0.1, 0.46, 1, 0, 0.26, 0);
  crack.rotation.y = Math.PI / 2;

  return {
    anim(t, near, phase) {
      const p = 0.3 + Math.sin(t * 1.9 + phase) * 0.14 + near * 0.35;
      crackMat.opacity = clamp(p, 0, 1);
      crystal.emissiveIntensity = 1.4 + Math.sin(t * 2.4 + phase) * 0.4 + near * 1.2;
      left.rotation.z = 0.16 + Math.sin(t * 0.6 + phase) * 0.008;
    },
    open(k) {
      left.position.x = -k * 0.42;
      right.position.x = k * 0.42;
      left.rotation.z = 0.16 + k * 0.5;
      right.rotation.z = -0.12 - k * 0.5;
      crystal.emissiveIntensity = 1.4 + k * 5.5;
      crackMat.opacity = clamp(0.5 + k * 0.5, 0, 1);
      for (let i = 0; i < shards.length; i++) {
        shards[i].position.y += k * 0.004;
        shards[i].rotation.y += k * 0.02;
      }
    },
  };
}

const BUILDERS = {
  clam: buildClam,
  coins: buildCoins,
  bottle: buildBottle,
  chest: buildChest,
  relic: buildRelic,
  geode: buildGeode,
};

// ==================================================================
// MODULE
// ==================================================================
export function initLoot(ctx) {
  const scene = ctx.scene;
  const bus = ctx.bus;

  const root = new THREE.Group();
  root.name = 'loot';
  scene.add(root);

  const motes = new MoteField(240);
  root.add(motes.points);

  // ---- state -----------------------------------------------------
  const byId = new Map();      // lootId -> record
  const list = [];             // same records, index-iterable (no iterator alloc)
  const areaSeen = new Map();  // areaId -> snapshot counter, for removal diffing
  let stateStamp = 0;
  let lastStateRef = null;
  let lastResultRef = null;
  let nearId = null;
  let sendCd = 0;
  let ePrev = false;

  // ---------------- small helpers ----------------
  function send(type, data) {
    if (ctx.net && typeof ctx.net.send === 'function') {
      try { ctx.net.send(type, data); } catch (e) { /* transport not ready */ }
    }
  }
  function sfx(name, volume, x, y, z) {
    const a = ctx.audio;
    if (!a || typeof a.sfx !== 'function') return;
    try {
      if (x === undefined) a.sfx(name, { volume: volume === undefined ? 1 : volume });
      else a.sfx(name, { volume: volume === undefined ? 1 : volume, pos: [x, y, z] });
    } catch (e) { /* audio must never break the frame */ }
  }
  function emit(evt, payload) {
    if (bus && typeof bus.emit === 'function') {
      try { bus.emit(evt, payload); } catch (e) { /* listener problems are not ours */ }
    }
  }
  function terrainY(x, z) {
    const w = ctx.world;
    if (w && typeof w.getTerrainHeight === 'function') {
      const h = w.getTerrainHeight(x, z);
      if (typeof h === 'number' && isFinite(h)) return h;
    }
    return null;
  }
  function waterY(x, z, t) {
    const f = ctx.getWaterHeight;
    if (typeof f !== 'function') return 0;
    const h = f(x, z, t);
    return (typeof h === 'number' && isFinite(h)) ? h : 0;
  }
  function getLocalPos(out) {
    const pm = ctx.playerMod;
    const loc = pm && pm.local;
    if (loc) {
      if (loc.char && loc.char.group) { loc.char.group.getWorldPosition(out); return true; }
      const p = loc.pos || loc.position;
      if (p && p.isVector3) { out.copy(p); return true; }
    }
    if (ctx.camera) { ctx.camera.getWorldPosition(out); return true; }
    return false;
  }

  // ---------------- node lifecycle ----------------
  function makeRecord(id, type, x, z, areaId) {
    const model = modelFor(type);
    const rng = rngFrom(id);
    const rec = {
      id, type, model, areaId,
      style: styleFor(model),
      x, z,
      y: 0,
      grounded: false,
      group: null,
      mats: null,
      parts: null,
      halo: null,
      tiltX: (rng() - 0.5) * 0.30,
      tiltZ: (rng() - 0.5) * 0.30,
      spin: rng() * TAU,
      phase: rng() * TAU,
      moteT: rng() * MOTE_PERIOD,
      near: 0,
      opening: 0,
      dead: false,
      stamp: 0,
    };
    byId.set(id, rec);
    list.push(rec);
    return rec;
  }

  function ground(rec) {
    const h = terrainY(rec.x, rec.z);
    if (h === null) return false;
    rec.y = h - rec.style.sink;
    rec.grounded = true;
    return true;
  }

  function buildMesh(rec) {
    if (rec.group || rec.dead) return;
    if (!rec.grounded && !ground(rec)) return;

    const g = new THREE.Group();
    const mats = [];
    const build = BUILDERS[rec.model] || BUILDERS.coins;
    let parts = null;
    try {
      parts = build(g, mats, rngFrom(rec.id + '|m'));
    } catch (e) {
      console.warn('[loot] could not build "' + rec.model + '":', e);
      parts = null;
    }

    const st = rec.style;
    const halo = haloSprite(mats, st.glow, st.haloSize, st.haloOp);
    halo.position.y = st.haloY;
    g.add(halo);

    g.traverse((c) => {
      if (c.isMesh) { c.castShadow = false; c.receiveShadow = false; }
    });
    g.position.set(rec.x, rec.y, rec.z);
    g.rotation.set(rec.tiltX, rec.spin, rec.tiltZ);   // resting naturally in the silt
    root.add(g);

    rec.group = g;
    rec.mats = mats;
    rec.parts = parts;
    rec.halo = halo;
  }

  function disposeMesh(rec) {
    const g = rec.group;
    if (!g) return;
    if (g.parent) g.parent.remove(g);
    const mats = rec.mats;
    if (mats) {
      for (let i = 0; i < mats.length; i++) {
        const m = mats[i];
        if (m && typeof m.dispose === 'function') m.dispose();
      }
    }
    rec.group = null;
    rec.mats = null;
    rec.parts = null;
    rec.halo = null;
  }

  function removeRecord(rec) {
    disposeMesh(rec);
    rec.dead = true;
    byId.delete(rec.id);
    const i = list.indexOf(rec);
    if (i >= 0) {
      list[i] = list[list.length - 1];
      list.pop();
    }
    if (nearId === rec.id) setNear(null);
  }

  function clearAll() {
    for (let i = list.length - 1; i >= 0; i--) {
      disposeMesh(list[i]);
      list[i].dead = true;
    }
    list.length = 0;
    byId.clear();
    areaSeen.clear();
    motes.clear();
    if (nearId !== null) setNear(null);
  }

  function setNear(rec) {
    const id = rec ? rec.id : null;
    if (id === nearId) return;
    nearId = id;
    if (rec) emit('lootNear', { lootId: rec.id, name: nameFor(rec.type) });
    else emit('lootNear', null);
  }

  // Open / collect FX. `mine` = we are the one who grabbed it.
  function beginCollect(rec, mine) {
    if (rec.dead || rec.opening > 0) return;
    if (!rec.group) { removeRecord(rec); return; }
    rec.opening = 0.0001;
    if (nearId === rec.id) setNear(null);

    const st = rec.style;
    const x = rec.x, y = rec.y + st.haloY, z = rec.z;
    motes.burst(x, y, z, mine ? 22 : 12, 1.1, 0.85, 0.13, 1.0, st.mote);
    motes.burst(x, y, z, mine ? 10 : 5, 0.4, 0.25, 0.22, 0.55, 0xffffff);
    sfx(st.sfx, mine ? 1 : 0.5, x, y, z);
  }

  // ---------------- network ----------------
  function onLootState(payload) {
    if (!payload || payload === lastStateRef) return;
    lastStateRef = payload;
    const arr = Array.isArray(payload) ? payload : payload.list;
    if (!Array.isArray(arr)) return;
    const areaId = (payload && payload.areaId !== undefined && payload.areaId !== null)
      ? payload.areaId : '_';

    stateStamp++;
    for (let i = 0; i < arr.length; i++) {
      const n = arr[i];
      if (!n || n.id === undefined || n.id === null) continue;
      const p = n.p;
      let x = 0, z = 0;
      if (Array.isArray(p)) {
        x = +p[0] || 0;
        z = p.length >= 3 ? (+p[2] || 0) : (+p[1] || 0);
      } else if (p && typeof p === 'object') {
        x = +p.x || 0;
        z = +p.z || 0;
      } else continue;

      let rec = byId.get(n.id);
      if (!rec) {
        rec = makeRecord(n.id, n.type, x, z, areaId);
      } else if (Math.abs(rec.x - x) > 0.01 || Math.abs(rec.z - z) > 0.01) {
        // the server moved/reused this id — reseat it on the seabed
        rec.x = x; rec.z = z;
        rec.grounded = false;
        if (rec.group) {
          if (ground(rec)) rec.group.position.set(rec.x, rec.y, rec.z);
          else disposeMesh(rec);
        }
      }
      rec.areaId = areaId;
      rec.stamp = stateStamp;
    }

    // anything this area reported before and no longer lists has been taken
    const prev = areaSeen.get(areaId);
    if (prev !== undefined) {
      for (let i = list.length - 1; i >= 0; i--) {
        const rec = list[i];
        if (rec.areaId !== areaId || rec.stamp === stateStamp || rec.opening > 0) continue;
        beginCollect(rec, false);   // someone else got there first (or it respawned)
      }
    }
    areaSeen.set(areaId, stateStamp);
  }

  function onLootResult(payload) {
    if (!payload || payload === lastResultRef) return;
    lastResultRef = payload;
    if (payload.ok) {
      const rec = (payload.lootId !== undefined && payload.lootId !== null)
        ? byId.get(payload.lootId) : null;
      if (rec) beginCollect(rec, true);
      if (payload.uniqueId) {
        sfx('uniqueFanfare', 1);
        if (rec) motes.burst(rec.x, rec.y + 0.5, rec.z, 26, 1.4, 1.2, 0.16, 1.5, 0xfff0c0);
      }
    }
    emit('lootResult', payload);   // verbatim, for ui toasts / charm cards
  }

  if (ctx.net && typeof ctx.net.on === 'function') {
    try {
      ctx.net.on(MSG.LOOT_STATE, onLootState);
      ctx.net.on(MSG.LOOT_RESULT, onLootResult);
    } catch (e) { console.warn('[loot] could not subscribe to loot messages:', e); }
  }
  if (bus && typeof bus.on === 'function') {
    // belt and braces: work whether main relays these over the bus or not
    bus.on('lootState', onLootState);
    bus.on('phase', (p) => { if (p !== 'playing') clearAll(); });
  }

  // ---------------- pickup input ----------------
  function tryPickup(rec) {
    if (!rec || sendCd > 0) return;
    sendCd = SEND_COOLDOWN;
    send(MSG.PICKUP_LOOT, { lootId: rec.id });
  }

  // ==================================================================
  // Frame
  // ==================================================================
  function update(dt, t) {
    const st = ctx.state;
    const playing = !!st && st.phase === 'playing';

    if (sendCd > 0) sendCd = Math.max(0, sendCd - dt);

    if (!playing) {
      if (list.length) clearAll();
      motes.update(dt);
      return;
    }

    // particle point size follows the live viewport / fov
    const cam = ctx.camera;
    if (cam) {
      const el = ctx.renderer && ctx.renderer.domElement;
      const h = (el && (el.clientHeight || el.height)) || 800;
      const fov = cam.isPerspectiveCamera ? cam.fov : 60;
      motes.material.uniforms.uScale.value = h / (2 * Math.tan(THREE.MathUtils.degToRad(fov) * 0.5));
    }

    const hasLocal = getLocalPos(_local);
    const alive = !st || typeof st.hp !== 'number' || st.hp > 0;
    const underwater = hasLocal && (st.underwater === true || _local.y < waterY(_local.x, _local.z, t) - 0.4);

    let best = null;
    let bestD2 = PICKUP_RANGE * PICKUP_RANGE;

    for (let i = list.length - 1; i >= 0; i--) {
      const rec = list[i];

      // ---- open / collect FX runs to completion, then the node goes ----
      if (rec.opening > 0) {
        rec.opening += dt;
        const k = clamp(rec.opening / OPEN_TIME, 0, 1);
        if (rec.parts && rec.parts.open) {
          try { rec.parts.open(k); } catch (e) { rec.parts = null; }
        }
        if (rec.halo) {
          // a bright pop as it opens, then the light bleeds away with the mesh
          const fl = k < 0.25 ? k / 0.25 : Math.max(0, 1 - (k - 0.25) / 0.75);
          rec.halo.material.opacity = clamp((rec.style.haloOp + fl * 0.75) * (1 - k * 0.7), 0, 1);
          const hs = rec.style.haloSize * (1 + k * 1.4);
          rec.halo.scale.set(hs, hs, 1);
        }
        if (k < 0.75 && Math.random() < dt * 18) {
          motes.spawn(
            rec.x + (Math.random() - 0.5) * 0.5, rec.y + 0.2 + Math.random() * 0.4, rec.z + (Math.random() - 0.5) * 0.5,
            (Math.random() - 0.5) * 0.3, 0.4 + Math.random() * 0.5, (Math.random() - 0.5) * 0.3,
            0.1, 0.8, rec.style.mote, 1.2
          );
        }
        if (rec.opening >= OPEN_TIME) removeRecord(rec);
        continue;
      }

      if (!hasLocal) continue;

      const dx = rec.x - _local.x;
      const dz = rec.z - _local.z;
      const d2 = dx * dx + dz * dz;

      // ---- culling: meshes only exist near the player ----
      if (d2 > DROP_DIST * DROP_DIST) {
        if (rec.group) disposeMesh(rec);
        continue;
      }
      if (!rec.group) {
        if (d2 > BUILD_DIST * BUILD_DIST) continue;
        buildMesh(rec);
        if (!rec.group) continue;
      }

      // ---- proximity / prompt eligibility ----
      const dy = rec.y - _local.y;
      const eligible = underwater && alive && d2 <= PICKUP_RANGE * PICKUP_RANGE && Math.abs(dy) <= NEAR_BOTTOM;
      if (eligible && d2 < bestD2) { bestD2 = d2; best = rec; }

      const nearTarget = eligible ? 1 : (d2 < 100 ? 0.25 : 0);
      rec.near += (nearTarget - rec.near) * (1 - Math.exp(-6 * dt));

      // ---- idle animation + ambient glow ----
      if (rec.parts && rec.parts.anim) {
        try { rec.parts.anim(t, rec.near, rec.phase); } catch (e) { rec.parts = null; }
      }
      if (rec.halo) {
        const s = rec.style;
        const pulse = 0.82 + Math.sin(t * 1.3 + rec.phase) * 0.18;
        rec.halo.material.opacity = clamp(s.haloOp * pulse * (1 + rec.near * 0.9), 0, 1);
        const hs = s.haloSize * (1 + rec.near * 0.18 + (pulse - 0.82) * 0.35);
        rec.halo.scale.set(hs, hs, 1);
      }

      // ---- rising motes so it reads from a distance in dark water ----
      if (d2 < MOTE_DIST2) {
        rec.moteT -= dt;
        if (rec.moteT <= 0) {
          rec.moteT = MOTE_PERIOD * (0.7 + Math.random() * 0.7) / (1 + rec.near);
          motes.spawn(
            rec.x + (Math.random() - 0.5) * 0.42,
            rec.y + 0.1 + Math.random() * 0.22,
            rec.z + (Math.random() - 0.5) * 0.42,
            (Math.random() - 0.5) * 0.06, 0.12 + Math.random() * 0.16, (Math.random() - 0.5) * 0.06,
            0.075 + Math.random() * 0.05, 1.6 + Math.random() * 1.2,
            rec.style.mote, 0.35
          );
        }
      }
    }

    setNear(best);

    // ---- E to take it (edge-detected, same convention as player.js) ----
    const keys = ctx.input && ctx.input.keys;
    const eDown = !!(keys && typeof keys.has === 'function' && keys.has('KeyE'));
    if (eDown && !ePrev && best) tryPickup(best);
    ePrev = eDown;

    motes.update(dt);
  }

  return { update };
}
