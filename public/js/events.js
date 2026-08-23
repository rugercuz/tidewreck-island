// =============================================================
// TIDEWRECK ISLAND - public/js/events.js
// The three horror events (serpent / kraken / bloop) + the tsunami cinematic.
//
// Owns: creature staging & theatre, camera shake, water vibration rings,
//       spray particles, the full-screen white-out overlay, the wall of water.
//
// Everything here is client-side theatre. The server only decides survival;
// we react to bus 'eventStart' / 'eventEnd' / 'tsunami' and to MSG.EVENT_PHASE
// for coarse sync, and drive all animation locally so it never stutters.
//
// Scale reference: the creatures are to the boat what the Titanic is to a dinghy.
// =============================================================

import * as THREE from 'three';
import { createFishMesh } from './fish.js';
import { MSG, EVENTS, ECON, fishById } from '/shared/constants.js';

// ---------------- tunables ----------------
// COLOSSAL SCALE: every creature is sized from EVENTS[type].bodyLength so the
// constants file stays the single source of truth for "how absurdly big is it".
// Reference marks: island hills top out ~21 m; the biggest boat is 14 m long.
const SERPENT_LENGTH   = (EVENTS.serpent && EVENTS.serpent.bodyLength) || 110;
const SERPENT_SEGMENTS = 38;
const SERPENT_R_START  = 140;                    // circling radius at event start
const SERPENT_R_END    = 68;                     // circling radius at the very end
const SERPENT_HEAD_LEN = SERPENT_LENGTH * 0.22;  // ~24 m of skull
const SERPENT_GIRTH    = SERPENT_LENGTH * 0.065; // ~7 m body radius
const SERPENT_BREACH   = SERPENT_LENGTH * 0.44;  // ~48 m of air under a breaching head

const KRAKEN_REACH     = (EVENTS.kraken && EVENTS.kraken.bodyLength) || 95;
const KRAKEN_ARMS      = 7;
const ARM_SEGMENTS     = 18;
const ARM_LENGTH       = KRAKEN_REACH;           // max arm reach, metres
const KRAKEN_MANTLE    = KRAKEN_REACH * 0.65;
const KRAKEN_DOME_R    = KRAKEN_REACH * 0.48;    // a surfacing island, ~92 m across
const ARM_BASE_R       = KRAKEN_REACH * 0.36;    // where the arms leave the mantle
const ARM_GIRTH        = KRAKEN_REACH * 0.09;    // ~8.5 m thick at the shoulder

const BLOOP_LENGTH     = (EVENTS.bloop && EVENTS.bloop.bodyLength) || 260;
const BLOOP_SEGS       = 24;
const BLOOP_HEAD       = BLOOP_LENGTH * 0.20;    // ~52 m of head, half of it maw
const BLOOP_GIRTH      = BLOOP_LENGTH * 0.115;   // ~30 m half-width of wrong whale
const BLOOP_FAR        = 1250;                   // horizon distance it comes from

const SHAKE_MAX_OFFSET = 0.62;  // metres at trauma 1
const SHAKE_MAX_ROLL   = 0.055; // radians at trauma 1
const SWELL_MAX_RISE   = 1.35;  // metres of slow deck heave at swell 1
const SWELL_MAX_ROLL   = 0.10;  // radians of slow deck roll at swell 1

const WALL_H           = 340;   // tsunami wall height, metres ("up to the sky")
const WALL_W           = 3600;  // tsunami wall width, metres

const RING_POOL        = 24;

// ---------------- scratch (module-level, never reallocated) ----------------
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _vs = new THREE.Vector3();   // shakeAt only — never nested inside _v1.._v5 use
const _fw = new THREE.Vector3();
const _rt = new THREE.Vector3();
const _up = new THREE.Vector3();
// orientMatrix() clobbers _fw/_rt/_up/_sc, so anything that has to HOLD a local
// frame across several orientMatrix calls uses these instead.
const _fr = new THREE.Vector3();
const _fu = new THREE.Vector3();
const _sc = new THREE.Vector3();
const _m1 = new THREE.Matrix4();
const UP  = new THREE.Vector3(0, 1, 0);

// ---------------- small math helpers ----------------
function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
function lerp(a, b, t) { return a + (b - a) * t; }
function smooth01(x) { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); }
function smoothstep(e0, e1, x) { return smooth01((x - e0) / (e1 - e0 || 1e-6)); }
function bump(x) { return x <= 0 || x >= 1 ? 0 : Math.sin(Math.PI * x); }
function expApproach(dt, per) { return 1 - Math.pow(per, dt); }

// Orient+scale an instance matrix so its local +Z runs along `dir`, keeping "up" upright.
function orientMatrix(out, pos, dir, sx, sy, sz) {
  _fw.copy(dir);
  if (_fw.lengthSq() < 1e-10) _fw.set(0, 0, 1); else _fw.normalize();
  _rt.crossVectors(UP, _fw);
  if (_rt.lengthSq() < 1e-8) _rt.set(1, 0, 0); else _rt.normalize();
  _up.crossVectors(_fw, _rt).normalize();
  out.makeBasis(_rt, _up, _fw);
  out.scale(_sc.set(sx, sy, sz));
  out.setPosition(pos);
}

// cubic bezier, component-wise, zero allocation
function bez3(p0, p1, p2, p3, u, out) {
  const iu = 1 - u;
  const a = iu * iu * iu, b = 3 * iu * iu * u, c = 3 * iu * u * u, d = u * u * u;
  out.set(
    a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    a * p0.y + b * p1.y + c * p2.y + d * p3.y,
    a * p0.z + b * p1.z + c * p2.z + d * p3.z
  );
  return out;
}

// ---------------- procedural canvas textures ----------------
function radialTexture(stops, size) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const s of stops) grad.addColorStop(s[0], s[1]);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function sandTexture() {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  g.fillStyle = '#5c4f3c';
  g.fillRect(0, 0, S, S);
  // damp ripples
  for (let i = 0; i < 90; i++) {
    const y = Math.random() * S;
    g.strokeStyle = `rgba(${120 + Math.random() * 50 | 0},${104 + Math.random() * 40 | 0},80,0.28)`;
    g.lineWidth = 1 + Math.random() * 3;
    g.beginPath();
    for (let x = 0; x <= S; x += 16) {
      const yy = y + Math.sin((x / S) * Math.PI * (2 + Math.random())) * 5;
      if (x === 0) g.moveTo(x, yy); else g.lineTo(x, yy);
    }
    g.stroke();
  }
  // wet dark blotches + pebbles
  for (let i = 0; i < 180; i++) {
    const x = Math.random() * S, y = Math.random() * S, r = 1 + Math.random() * 5;
    g.fillStyle = Math.random() < 0.5 ? 'rgba(40,34,26,0.35)' : 'rgba(146,132,104,0.30)';
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(10, 10);
  return tex;
}

// A torn, strand-y fin: root edge runs along Z (-0.5..0.5), strands reach out
// along +X and droop in -Y. Ragged by construction, so the Bloop's fins read as
// something that has been dragged through a few centuries of ocean.
function tatterGeometry(n) {
  const v = [];
  const push = (x, y, z) => { v.push(x, y, z); };
  // solid inner web so it does not read as a comb
  push(0, 0, -0.5); push(0, 0, 0.5); push(0.34, -0.03, 0.46);
  push(0, 0, -0.5); push(0.34, -0.03, 0.46); push(0.34, -0.03, -0.46);
  for (let i = 0; i < n; i++) {
    const z0 = -0.5 + i / n, z1 = -0.5 + (i + 1) / n, zm = (z0 + z1) * 0.5;
    const len = 0.42 + Math.abs(Math.sin(i * 2.37 + 0.6)) * 0.58;
    const drop = 0.18 + (i % 3) * 0.09;
    push(0.2, -0.02, z0);
    push(0.2, -0.02, z1);
    push(len, -drop * len, zm);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v), 3));
  geo.computeVertexNormals();
  return geo;
}

function foamTexture() {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, S, S);
  for (let i = 0; i < 260; i++) {
    const x = Math.random() * S, y = Math.random() * S;
    const r = 3 + Math.random() * 22;
    const a = 0.05 + Math.random() * 0.35;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(255,255,255,${a})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 4);
  return tex;
}

// =============================================================
export function initEvents(ctx) {
  const scene = ctx.scene;

  // ---------------------------------------------------------
  // Shared, built-once assets
  // ---------------------------------------------------------
  const TEX = {
    glow: radialTexture([[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,0.72)'],
                         [0.55, 'rgba(255,255,255,0.20)'], [1, 'rgba(255,255,255,0)']], 128),
    soft: radialTexture([[0, 'rgba(255,255,255,0.95)'], [0.45, 'rgba(255,255,255,0.35)'],
                         [1, 'rgba(255,255,255,0)']], 64),
    sand: sandTexture(),
    foam: foamTexture(),
  };

  const GEO = {
    seg:    new THREE.SphereGeometry(1, 14, 10),
    blob:   new THREE.IcosahedronGeometry(1, 2),
    rock:   new THREE.IcosahedronGeometry(1, 0),
    ring:   new THREE.RingGeometry(0.9, 1.0, 72),
    disc:   new THREE.CircleGeometry(1, 40),
    tooth:  new THREE.ConeGeometry(1, 1, 5),
    arm:    new THREE.CylinderGeometry(0.84, 1, 1, 10, 1),
    sucker: new THREE.CylinderGeometry(1, 0.75, 1, 8),
    frill:  new THREE.ConeGeometry(1, 1, 3),
    eyeball: new THREE.SphereGeometry(1, 8, 6),
    barnacle: new THREE.CylinderGeometry(0.5, 1, 1, 7),
  };
  // orient the tube-ish geometries so their long axis is +Z (matches orientMatrix)
  GEO.arm.rotateX(Math.PI / 2);
  GEO.tooth.rotateX(Math.PI / 2);
  GEO.frill.rotateX(Math.PI / 2);
  GEO.sucker.rotateX(Math.PI / 2);
  GEO.barnacle.rotateX(Math.PI / 2);

  // belly shading baked into the segment sphere as vertex colours
  (function paintSegment() {
    const p = GEO.seg.attributes.position;
    const col = new Float32Array(p.count * 3);
    const top = new THREE.Color(0x24603f), bot = new THREE.Color(0x8ac8a0);
    const c = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      const t = clamp(p.getY(i) * 0.5 + 0.5, 0, 1);
      c.copy(bot).lerp(top, Math.pow(t, 0.7));
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    GEO.seg.setAttribute('color', new THREE.BufferAttribute(col, 3));
  })();

  // The Bloop's hide: drowned-slate back, bloated pale belly, sick green mottling.
  // Painted into the vertex colours so the whole 260 m body is one draw call.
  GEO.bloopSeg = new THREE.IcosahedronGeometry(1, 2);
  (function paintHide() {
    const p = GEO.bloopSeg.attributes.position;
    const col = new Float32Array(p.count * 3);
    const back = new THREE.Color(0x161b21), belly = new THREE.Color(0x5d6672), sick = new THREE.Color(0x27362c);
    const c = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      const y = clamp(p.getY(i) * 0.5 + 0.5, 0, 1);
      c.copy(belly).lerp(back, Math.pow(y, 0.5));
      const m = 0.5 + 0.5 * Math.sin(p.getX(i) * 9.1 + p.getZ(i) * 7.3);
      c.lerp(sick, m * 0.24);
      const n = 0.84 + 0.3 * Math.sin(p.getZ(i) * 13.7 + p.getY(i) * 5.1);
      col[i * 3] = c.r * n; col[i * 3 + 1] = c.g * n; col[i * 3 + 2] = c.b * n;
    }
    GEO.bloopSeg.setAttribute('color', new THREE.BufferAttribute(col, 3));
  })();
  GEO.tatter = tatterGeometry(9);

  const MAT = {
    serpentBody: new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.55, metalness: 0.12, flatShading: true,
      emissive: 0x06301c, emissiveIntensity: 0.7,
    }),
    serpentFrill: new THREE.MeshStandardMaterial({
      color: 0x1d5a3c, emissive: 0x2aff88, emissiveIntensity: 0.9,
      roughness: 0.6, flatShading: true, side: THREE.DoubleSide, transparent: true, opacity: 0.92,
    }),
    serpentGlow: new THREE.MeshBasicMaterial({ color: 0x3affa0, toneMapped: false, fog: false }),
    hide: new THREE.MeshStandardMaterial({
      color: 0x1a4230, roughness: 0.6, metalness: 0.1, flatShading: true,
      emissive: 0x04180f, emissiveIntensity: 1.0,
    }),
    bone: new THREE.MeshStandardMaterial({
      color: 0xefe6cf, roughness: 0.45, flatShading: true, emissive: 0x2a2418, emissiveIntensity: 0.5,
    }),
    krakenFlesh: new THREE.MeshStandardMaterial({
      color: 0x4a2050, roughness: 0.72, metalness: 0.05, flatShading: true,
      emissive: 0x2a0c3a, emissiveIntensity: 0.85,
    }),
    krakenSucker: new THREE.MeshStandardMaterial({
      color: 0xd0a2bc, roughness: 0.5, flatShading: true, emissive: 0x3a1830, emissiveIntensity: 0.6,
    }),
    krakenDome: new THREE.MeshStandardMaterial({
      color: 0x33153f, roughness: 0.8, flatShading: true, emissive: 0x1c0630, emissiveIntensity: 0.9,
    }),
    silhouette: new THREE.MeshBasicMaterial({ color: 0x03040a, fog: false, toneMapped: false }),
    shadowDisc: new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, opacity: 0.0, depthWrite: false, fog: false, toneMapped: false,
    }),
    // ---- the Bloop: bespoke wrong-whale horror, nothing shared with the fish factory ----
    bloopHide: new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.95, metalness: 0.04, flatShading: true,
      emissive: 0x1a0206, emissiveIntensity: 0.55,
    }),
    bloopPlate: new THREE.MeshStandardMaterial({
      color: 0x22282c, roughness: 1.0, metalness: 0.05, flatShading: true,
      emissive: 0x0a0204, emissiveIntensity: 0.8,
    }),
    bloopBarnacle: new THREE.MeshStandardMaterial({
      color: 0x8f8674, roughness: 1.0, flatShading: true, emissive: 0x1a160f, emissiveIntensity: 0.6,
    }),
    bloopJaw: new THREE.MeshStandardMaterial({
      color: 0x14181d, roughness: 0.92, metalness: 0.06, flatShading: true,
      emissive: 0x160104, emissiveIntensity: 0.7,
    }),
    bloopTooth: new THREE.MeshStandardMaterial({
      color: 0xcfc4a8, roughness: 0.5, flatShading: true, emissive: 0x2a1810, emissiveIntensity: 0.7,
    }),
    bloopEye: new THREE.MeshBasicMaterial({
      color: 0xd41408, transparent: true, opacity: 0.85, fog: false, toneMapped: false,
    }),
    bloopVein: new THREE.MeshBasicMaterial({
      color: 0xff1c22, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending,
      depthWrite: false, fog: false, toneMapped: false,
    }),
    bloopThroat: new THREE.MeshBasicMaterial({
      color: 0xff2a08, side: THREE.DoubleSide, fog: false, toneMapped: false,
    }),
    bloopFin: new THREE.MeshStandardMaterial({
      color: 0x161a20, roughness: 0.95, flatShading: true, side: THREE.DoubleSide,
      transparent: true, opacity: 0.94, emissive: 0x120104, emissiveIntensity: 0.6,
    }),
  };

  function glowSprite(color, size, opacity) {
    const m = new THREE.SpriteMaterial({
      map: TEX.glow, color, transparent: true, opacity: opacity === undefined ? 1 : opacity,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, fog: false, toneMapped: false,
    });
    const s = new THREE.Sprite(m);
    s.scale.setScalar(size);
    return s;
  }

  // ---------------------------------------------------------
  // Particle systems (spray + mist), fully pooled
  // ---------------------------------------------------------
  function makeParticles(count, size, tex) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) pos[i * 3 + 1] = -99999;
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mat = new THREE.PointsMaterial({
      size, map: tex, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, sizeAttenuation: true, fog: false, toneMapped: false,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = 6;
    scene.add(points);
    return {
      points, geo, pos, col, count, head: 0, live: 0,
      vel: new Float32Array(count * 3),
      base: new Float32Array(count * 3),
      life: new Float32Array(count),
      maxLife: new Float32Array(count),
      grav: new Float32Array(count),
    };
  }

  // Three scales, because one sprite size cannot serve a 2 m splash and a 340 m
  // wave crest: droplets, creature-scale foam puffs, and tsunami mist.
  const spray = makeParticles(560, 2.6, TEX.soft);
  const foam  = makeParticles(260, 9, TEX.soft);
  const mist  = makeParticles(360, 58, TEX.soft);

  function emit(ps, x, y, z, n, speed, spread, upBias, r, g, b, life, grav) {
    for (let k = 0; k < n; k++) {
      const i = ps.head; ps.head = (ps.head + 1) % ps.count;
      const i3 = i * 3;
      ps.pos[i3] = x + (Math.random() - 0.5) * spread;
      ps.pos[i3 + 1] = y + Math.random() * spread * 0.35;
      ps.pos[i3 + 2] = z + (Math.random() - 0.5) * spread;
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.35 + Math.random() * 0.65);
      ps.vel[i3] = Math.cos(a) * s * 0.7;
      ps.vel[i3 + 1] = s * upBias * (0.6 + Math.random() * 0.8);
      ps.vel[i3 + 2] = Math.sin(a) * s * 0.7;
      const v = 0.75 + Math.random() * 0.5;
      ps.base[i3] = r * v; ps.base[i3 + 1] = g * v; ps.base[i3 + 2] = b * v;
      ps.col[i3] = ps.base[i3]; ps.col[i3 + 1] = ps.base[i3 + 1]; ps.col[i3 + 2] = ps.base[i3 + 2];
      ps.maxLife[i] = life * (0.6 + Math.random() * 0.7);
      ps.life[i] = ps.maxLife[i];
      ps.grav[i] = grav === undefined ? 17 : grav;
    }
    ps.live = 1;
  }

  function updateParticles(ps, dt) {
    if (!ps.live) return;
    let any = false;
    for (let i = 0; i < ps.count; i++) {
      const l = ps.life[i];
      if (l <= 0) continue;
      any = true;
      const nl = l - dt;
      const i3 = i * 3;
      if (nl <= 0) {
        ps.life[i] = 0;
        ps.pos[i3 + 1] = -99999;
        ps.col[i3] = ps.col[i3 + 1] = ps.col[i3 + 2] = 0;
        continue;
      }
      ps.life[i] = nl;
      ps.vel[i3 + 1] -= ps.grav[i] * dt;
      ps.pos[i3] += ps.vel[i3] * dt;
      ps.pos[i3 + 1] += ps.vel[i3 + 1] * dt;
      ps.pos[i3 + 2] += ps.vel[i3 + 2] * dt;
      const f = nl / ps.maxLife[i];
      const ff = f * f * (3 - 2 * f);
      ps.col[i3] = ps.base[i3] * ff;
      ps.col[i3 + 1] = ps.base[i3 + 1] * ff;
      ps.col[i3 + 2] = ps.base[i3 + 2] * ff;
    }
    ps.geo.attributes.position.needsUpdate = true;
    ps.geo.attributes.color.needsUpdate = true;
    ps.live = any ? 1 : 0;
  }

  function killParticles(ps) {
    for (let i = 0; i < ps.count; i++) {
      ps.life[i] = 0;
      ps.pos[i * 3 + 1] = -99999;
      ps.col[i * 3] = ps.col[i * 3 + 1] = ps.col[i * 3 + 2] = 0;
    }
    ps.geo.attributes.position.needsUpdate = true;
    ps.geo.attributes.color.needsUpdate = true;
    ps.live = 0;
  }

  // ---------------------------------------------------------
  // Water shock rings (pooled)
  // ---------------------------------------------------------
  const rings = [];
  for (let i = 0; i < RING_POOL; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xbfe6ff, transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false, toneMapped: false,
    });
    const m = new THREE.Mesh(GEO.ring, mat);
    m.rotation.x = -Math.PI / 2;
    m.visible = false;
    m.renderOrder = 5;
    scene.add(m);
    rings.push({ mesh: m, mat, life: 0, maxLife: 1, r0: 1, r1: 10, alpha: 0.8 });
  }
  let ringHead = 0;

  function shockRing(x, y, z, r0, r1, life, color, alpha) {
    const r = rings[ringHead]; ringHead = (ringHead + 1) % rings.length;
    r.mesh.position.set(x, y + 0.35, z);
    r.mesh.visible = true;
    r.mat.color.setHex(color);
    r.r0 = r0; r.r1 = r1; r.maxLife = life; r.life = life; r.alpha = alpha === undefined ? 0.85 : alpha;
    r.mesh.scale.setScalar(r0);
    r.mat.opacity = r.alpha;
  }

  function updateRings(dt) {
    for (let i = 0; i < rings.length; i++) {
      const r = rings[i];
      if (r.life <= 0) continue;
      r.life -= dt;
      if (r.life <= 0) { r.mesh.visible = false; r.mat.opacity = 0; continue; }
      const f = 1 - r.life / r.maxLife;
      const s = lerp(r.r0, r.r1, f * (2 - f));
      r.mesh.scale.set(s, s, 1);
      r.mat.opacity = r.alpha * (1 - f) * (1 - f);
    }
  }

  function killRings() {
    for (let i = 0; i < rings.length; i++) { rings[i].life = 0; rings[i].mesh.visible = false; rings[i].mat.opacity = 0; }
  }

  // ---------------------------------------------------------
  // Full-screen overlay (night blink, white-out)
  // ---------------------------------------------------------
  const overlayMat = new THREE.MeshBasicMaterial({
    color: 0x000000, transparent: true, opacity: 0, depthTest: false, depthWrite: false,
    fog: false, toneMapped: false, side: THREE.DoubleSide,
  });
  const overlay = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), overlayMat);
  overlay.frustumCulled = false;
  overlay.renderOrder = 10000;
  overlay.visible = false;
  scene.add(overlay);

  const OV = { target: 0, value: 0, rate: 4, hold: 0 };
  function setOverlay(colorHex, target, rate, hold) {
    overlayMat.color.setHex(colorHex);
    OV.target = target; OV.rate = rate || 4; OV.hold = hold || 0;
  }
  function updateOverlay(dt) {
    if (OV.hold > 0) OV.hold -= dt;
    else if (OV.value !== OV.target) {
      const d = OV.target - OV.value;
      const step = OV.rate * dt;
      OV.value = Math.abs(d) <= step ? OV.target : OV.value + Math.sign(d) * step;
    }
    overlayMat.opacity = OV.value;
    overlay.visible = OV.value > 0.002;
    if (!overlay.visible) return;
    const cam = ctx.camera;
    if (!cam) return;
    const d = Math.max(0.25, (cam.near || 0.1) * 3.5);
    overlay.position.copy(cam.position);
    _v1.set(0, 0, -1).applyQuaternion(cam.quaternion).multiplyScalar(d);
    overlay.position.add(_v1);
    overlay.quaternion.copy(cam.quaternion);
    const s = d * 9;
    overlay.scale.set(s, s, 1);
  }

  // ---------------------------------------------------------
  // Camera shake — applied AFTER player.js has placed the camera
  // ---------------------------------------------------------
  let trauma = 0, traumaDecay = 1, rumble = 0;
  let swellAmp = 0, swellFreq = 0.85, swellPhase = Math.random() * 6.28;
  let shakeApplied = false, lastRoll = 0, lastRotZ = 0;
  const lastOffset = new THREE.Vector3();
  const lastCamPos = new THREE.Vector3();
  const shakeSeed = [Math.random() * 100, Math.random() * 100, Math.random() * 100,
                     Math.random() * 100, Math.random() * 100];

  // Two channels: `trauma` is an impulse with its own decay envelope, `rumble`
  // is a fast-decaying floor that per-frame callers keep topping up. We take the
  // max, so a continuous ambient rumble can never cut an impact short.
  function shake(intensity, seconds) {
    if (!(intensity > 0)) return;
    intensity = Math.min(1.2, intensity);
    if (intensity > trauma) { trauma = intensity; traumaDecay = intensity / Math.max(0.08, seconds || 0.5); }
    if (intensity > rumble) rumble = intensity;
  }

  // A third, SLOW channel: displacement swell. Something enormous shouldering the
  // water past you heaves the whole deck rather than rattling the lens. Callers top
  // it up per frame; it decays on its own.
  function swell(amount, freq) {
    if (!(amount > 0)) return;
    amount = Math.min(1.4, amount);
    if (amount > swellAmp) swellAmp = amount;
    if (freq > 0) swellFreq += (freq - swellFreq) * 0.25;
  }

  // Shake scaled by how far the event actually is from you — a breach 300 m out
  // must not hit as hard as one over the bow.
  function shakeAt(x, z, base, seconds, range) {
    if (!getLocalPos(_vs)) { shake(base * 0.55, seconds); return; }
    const d = Math.hypot(_vs.x - x, _vs.z - z);
    shake(base * clamp(1 - d / (range || 260), 0.07, 1), seconds);
  }

  function applyShake(dt, t) {
    const cam = ctx.camera;
    if (!cam) return;
    if (shakeApplied) {
      // Only undo if nobody else re-placed the camera this frame.
      if (cam.position.distanceToSquared(lastCamPos) < 1e-6) cam.position.sub(lastOffset);
      if (Math.abs(cam.rotation.z - lastRotZ) < 1e-7) cam.rotation.z -= lastRoll;
      shakeApplied = false;
      lastOffset.set(0, 0, 0);
      lastRoll = 0;
    }
    if (trauma > 0) trauma = Math.max(0, trauma - traumaDecay * dt);
    if (rumble > 0) rumble = Math.max(0, rumble - 3.2 * dt);
    if (swellAmp > 0) swellAmp = Math.max(0, swellAmp - 0.55 * dt);
    const level = trauma > rumble ? trauma : rumble;
    const amp = level * level;
    const sw = swellAmp * swellAmp;
    if (amp < 0.0002 && sw < 0.0004) return;
    let ox = 0, oy = 0, roll = 0;
    if (amp >= 0.0002) {
      const nx = Math.sin(t * 37.1 + shakeSeed[0]) * 0.62 + Math.sin(t * 17.3 + shakeSeed[1]) * 0.38;
      const ny = Math.sin(t * 31.7 + shakeSeed[2]) * 0.62 + Math.sin(t * 23.9 + shakeSeed[3]) * 0.38;
      ox = nx * amp * SHAKE_MAX_OFFSET;
      oy = ny * amp * SHAKE_MAX_OFFSET * 0.8;
      roll = Math.sin(t * 21.3 + shakeSeed[4]) * amp * SHAKE_MAX_ROLL;
    }
    lastOffset.set(ox, oy, 0).applyQuaternion(cam.quaternion);
    if (sw >= 0.0004) {
      swellPhase += dt * swellFreq * Math.PI * 2;
      lastOffset.y += Math.sin(swellPhase) * sw * SWELL_MAX_RISE;
      lastOffset.x += Math.sin(swellPhase * 0.63 + 1.1) * sw * SWELL_MAX_RISE * 0.35;
      roll += Math.cos(swellPhase * 0.71) * sw * SWELL_MAX_ROLL;
    }
    cam.position.add(lastOffset);
    lastRoll = roll;
    cam.rotation.z += lastRoll;
    lastCamPos.copy(cam.position);
    lastRotZ = cam.rotation.z;
    shakeApplied = true;
  }

  function clearShake() {
    trauma = 0;
    rumble = 0;
    swellAmp = 0;
    if (shakeApplied && ctx.camera) {
      if (ctx.camera.position.distanceToSquared(lastCamPos) < 1e-6) ctx.camera.position.sub(lastOffset);
      if (Math.abs(ctx.camera.rotation.z - lastRotZ) < 1e-7) ctx.camera.rotation.z -= lastRoll;
    }
    shakeApplied = false;
    lastOffset.set(0, 0, 0);
    lastRoll = 0;
  }

  // ---------------------------------------------------------
  // Safe bridges to the other modules (read lazily, never captured)
  // ---------------------------------------------------------
  let audioFails = 0;
  function sfx(name, opts) {
    if (audioFails > 8) return;   // audio module is unwell; stop bothering it
    const a = ctx.audio;
    if (!a || typeof a.sfx !== 'function') return;
    try { a.sfx(name, opts); } catch (e) { audioFails++; }
  }
  function cutMusic() {
    const a = ctx.audio;
    if (!a || typeof a.cutMusic !== 'function') return;
    try { a.cutMusic(); } catch (e) { /* audio not ready */ }
  }
  let waterFails = 0;
  function waterSplash(x, y, z, size) {
    if (waterFails > 8) return;
    const w = ctx.water;
    if (!w || typeof w.splash !== 'function') return;
    // fresh vector: water.js is free to keep the reference we hand it
    try { w.splash(new THREE.Vector3(x, y, z), size); } catch (e) { waterFails++; }
  }
  function setNight(on) {
    const w = ctx.world;
    if (!w || typeof w.setNightSnap !== 'function') return;
    try { w.setNightSnap(on); } catch (e) { /* world not ready */ }
  }
  function waterY(x, z, t) {
    try {
      const h = ctx.getWaterHeight ? ctx.getWaterHeight(x, z, t) : 0;
      return Number.isFinite(h) ? h : 0;
    } catch (e) { return 0; }
  }
  function getBoatPos(out) {
    const b = ctx.boat, g = b && b.group;
    if (g && g.isObject3D) { g.getWorldPosition(out); return true; }
    return false;
  }
  function getLocalPos(out) {
    const pm = ctx.playerMod, l = pm && pm.local;
    if (l) {
      const g = (l.char && l.char.group) || l.group || (l.isObject3D ? l : null);
      if (g && g.isObject3D) { g.getWorldPosition(out); return true; }
      if (l.position && l.position.isVector3) { out.copy(l.position); return true; }
    }
    if (ctx.camera) { out.copy(ctx.camera.position); return true; }
    return false;
  }
  function eachRemote(cb) {
    const pm = ctx.playerMod;
    const rem = pm && pm.remotes;
    if (!rem) return;
    try {
      if (typeof rem.forEach === 'function') { rem.forEach(cb); return; }
      if (Array.isArray(rem)) { for (let i = 0; i < rem.length; i++) cb(rem[i]); return; }
      for (const k in rem) cb(rem[k]);
    } catch (e) { /* shape mismatch, ignore */ }
  }
  function remotePos(r, out) {
    if (!r) return false;
    const g = (r.char && r.char.group) || r.group || (r.isObject3D ? r : null);
    if (g && g.isObject3D) { g.getWorldPosition(out); return true; }
    if (r.position && r.position.isVector3) { out.copy(r.position); return true; }
    return false;
  }
  function damageLocal(dmg, cause) {
    if (ctx.state && ctx.state.phase !== 'playing') return;
    if (ctx.state && ctx.state.hp <= 0) return;
    try { if (ctx.net && ctx.net.send) ctx.net.send(MSG.PLAYER_HIT, { dmg, cause }); } catch (e) { /* offline */ }
    try { if (ctx.bus && ctx.bus.emit) ctx.bus.emit('localDamaged', { dmg, cause }); } catch (e) { /* no listener */ }
  }
  function localIsSwimming() {
    const s = ctx.state;
    if (!s) return false;
    if (s.underwater) return true;
    if (s.onBoat) return false;
    if (!getLocalPos(_v5)) return false;
    return _v5.y < waterY(_v5.x, _v5.z, 0) + 1.4;
  }

  // ---------------------------------------------------------
  // Fish-factory helpers
  // ---------------------------------------------------------
  // Normalizes whatever fish.js hands back into a wrapper whose long axis is +Z,
  // centred on the origin, exactly `targetLen` metres long.
  // The recentring lives on its own node so fish.js's own userData.update(t)
  // animation is free to touch the mesh's transform without undoing us.
  function normalizeCreature(obj, targetLen) {
    const wrap = new THREE.Group();
    try {
      obj.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(obj);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      if (!box.isEmpty() && Number.isFinite(size.x) && Number.isFinite(size.y) && Number.isFinite(size.z)) {
        const shift = new THREE.Group();
        shift.position.copy(center).multiplyScalar(-1);
        shift.add(obj);
        const inner = new THREE.Group();
        inner.add(shift);
        let axis = 0, len = size.x;
        if (size.y > len) { axis = 1; len = size.y; }
        if (size.z > len) { axis = 2; len = size.z; }
        if (axis === 0) inner.rotation.y = Math.PI / 2;
        else if (axis === 1) inner.rotation.x = -Math.PI / 2;
        inner.scale.setScalar(len > 1e-4 ? targetLen / len : 1);
        wrap.add(inner);
        return wrap;
      }
    } catch (e) { /* fall through to raw attach */ }
    wrap.add(obj);
    return wrap;
  }

  function fallbackCreature(fishDef, targetLen) {
    // Used only if fish.js throws — the show must go on.
    const g = new THREE.Group();
    const cols = (fishDef && fishDef.model && fishDef.model.colors) || [0x223344, 0x111a22];
    const mat = new THREE.MeshStandardMaterial({
      color: cols[0], roughness: 0.7, flatShading: true,
      emissive: (fishDef && fishDef.model && fishDef.model.emissive) || 0x000000, emissiveIntensity: 0.6,
    });
    const n = 7;
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      const m = new THREE.Mesh(GEO.blob, mat);
      const r = targetLen * 0.09 * (0.5 + Math.sin(u * Math.PI) * 0.85);
      m.scale.set(r, r * 0.85, r * 1.25);
      m.position.z = (u - 0.5) * targetLen * 0.85;
      g.add(m);
    }
    return g;
  }

  function spawnFish(fishId, targetLen, silhouette) {
    const def = fishById(fishId);
    let raw = null;
    const mult = def && def.model && def.model.size ? targetLen / def.model.size : 1;
    try {
      raw = createFishMesh(def, null, mult);
    } catch (e) { raw = null; }
    if (!raw || !raw.isObject3D) raw = fallbackCreature(def, targetLen);
    if (silhouette) {
      raw.traverse((o) => {
        if (o.isSprite || o.isPoints) o.visible = false;
        else if (o.isMesh) { o.material = MAT.silhouette; o.castShadow = false; o.receiveShadow = false; }
      });
    }
    const wrap = normalizeCreature(raw, targetLen);
    wrap.userData.fishObj = raw;
    wrap.userData.animBroken = false;
    return wrap;
  }

  function animateFish(wrap, t) {
    if (!wrap || wrap.userData.animBroken) return;
    const o = wrap.userData.fishObj;
    if (!o || !o.userData || typeof o.userData.update !== 'function') { wrap.userData.animBroken = true; return; }
    try { o.userData.update(t); } catch (e) { wrap.userData.animBroken = true; }
  }

  // =========================================================
  // THE SERPENT
  // =========================================================
  function buildSerpent() {
    const root = new THREE.Group();
    root.visible = false;

    const body = new THREE.InstancedMesh(GEO.seg, MAT.serpentBody, SERPENT_SEGMENTS);
    const frill = new THREE.InstancedMesh(GEO.frill, MAT.serpentFrill, SERPENT_SEGMENTS);
    const glow = new THREE.InstancedMesh(GEO.blob, MAT.serpentGlow, SERPENT_SEGMENTS);
    body.frustumCulled = frill.frustumCulled = glow.frustumCulled = false;
    // no shadow casting: these stage far out at sea, outside the island shadow camera
    root.add(body, frill, glow);

    // head assembly. The hand-built skull is authored at a 13 m reference size and
    // scaled bodily to SERPENT_HEAD_LEN, so one constant re-sizes the whole face.
    const head = new THREE.Group();
    const neck = spawnFish('seaserpent', SERPENT_HEAD_LEN, false);
    neck.position.z = -SERPENT_HEAD_LEN * 0.28;
    head.add(neck);

    const HEAD_S = SERPENT_HEAD_LEN / 13;
    const skullG = new THREE.Group();
    skullG.scale.setScalar(HEAD_S);
    head.add(skullG);

    const skull = new THREE.Mesh(GEO.blob, MAT.hide);
    skull.scale.set(2.7, 2.4, 4.6);
    skull.position.z = 2.2;
    skullG.add(skull);

    const brow = new THREE.Mesh(GEO.frill, MAT.serpentFrill);
    brow.scale.set(3.4, 3.4, 4.2);
    brow.position.set(0, 1.5, -1.2);
    brow.rotation.z = Math.PI;
    skullG.add(brow);

    const jawTop = new THREE.Group(); jawTop.position.set(0, 0.5, 5.2);
    const jawBot = new THREE.Group(); jawBot.position.set(0, -0.4, 5.2);
    for (const [jaw, sign] of [[jawTop, 1], [jawBot, -1]]) {
      const j = new THREE.Mesh(GEO.blob, MAT.hide);
      j.scale.set(1.9, 0.85, 4.0);
      j.position.z = 3.2;
      jaw.add(j);
      const teeth = new THREE.InstancedMesh(GEO.tooth, MAT.bone, 12);
      teeth.frustumCulled = false;
      for (let i = 0; i < 12; i++) {
        const side = i % 2 === 0 ? 1 : -1;
        const u = Math.floor(i / 2) / 5;
        _v1.set(side * (1.5 - u * 0.75), -sign * 0.5, 1.4 + u * 5.0);
        _v2.set(0, -sign, 0.18);
        orientMatrix(_m1, _v1, _v2, 0.34, 0.34, 1.15 - u * 0.4);
        teeth.setMatrixAt(i, _m1);
      }
      teeth.instanceMatrix.needsUpdate = true;
      jaw.add(teeth);
    }
    skullG.add(jawTop, jawBot);

    // eyes ride just proud of the skull ellipsoid so they never sink into it
    const eyeL = glowSprite(0xbdff5a, 2.8); eyeL.position.set(2.5, 1.7, 3.4);
    const eyeR = glowSprite(0xbdff5a, 2.8); eyeR.position.set(-2.5, 1.7, 3.4);
    const maw = glowSprite(0x66ffaa, 5.0, 0.0); maw.position.set(0, 0.05, 9.0);
    skullG.add(eyeL, eyeR, maw);
    root.add(head);

    const light = new THREE.PointLight(0x66ffbb, 160, 700, 1.0);
    root.add(light);

    const pts = [];
    for (let i = 0; i < SERPENT_SEGMENTS; i++) pts.push(new THREE.Vector3());
    const radii = new Float32Array(SERPENT_SEGMENTS);
    for (let i = 0; i < SERPENT_SEGMENTS; i++) {
      const u = i / (SERPENT_SEGMENTS - 1);
      radii[i] = SERPENT_GIRTH * (0.72 + 0.5 * Math.sin(Math.pow(u, 0.6) * Math.PI)) * (1 - 0.78 * Math.pow(u, 2.1));
    }

    return {
      root, body, frill, glow, head, neck, jawTop, jawBot, maw, eyeL, eyeR, light,
      pts, radii, prevY: new Float32Array(SERPENT_SEGMENTS),
      spacing: SERPENT_LENGTH / (SERPENT_SEGMENTS - 1),
      theta0: 0, omega: 0.1, dir: 1, undPhase: 0,
      lunge: null, nextLunge: 8, lungeIdx: 0, splashCd: 0, jaw: 0,
    };
  }

  function serpentPath(rig, tt, out, t) {
    const dur = EV.duration || 90;
    const prog = clamp(tt / dur, 0, 1);
    const R = lerp(SERPENT_R_START, SERPENT_R_END, prog * prog);
    // the ring tightens but the linear speed stays put, so the body always wraps
    // the same arc length instead of knotting up as the radius falls
    const k = SERPENT_R_START / SERPENT_R_END - 1;
    const ang = rig.theta0 + rig.dir * rig.omega * (tt + k * tt * Math.abs(tt) / (2 * dur));
    const cx = EV.center.x + Math.cos(ang) * R;
    const cz = EV.center.z + Math.sin(ang) * R;
    // undulation big enough that the dorsal arcs clear the water by ~18 m
    const amp = SERPENT_GIRTH * 2.5 + 7 * prog;
    let y = waterY(cx, cz, t) + Math.sin(tt * 1.05 + rig.undPhase) * amp - SERPENT_GIRTH * 0.85;
    out.set(cx, y, cz);

    const L = rig.lunge;
    if (L) {
      const u = clamp((tt - L.start) / L.dur, 0, 1);
      const w = bump(clamp((tt - L.start) / L.dur, 0, 1));
      if (w > 0.001) {
        _v3.copy(L.from).lerp(L.to, u);
        const arc = Math.pow(bump(u), 1.25);
        // High breaches top out ABOVE the island's hills (~21 m) and arc clean
        // over the boat; low charges shave the rail at head height so the jaws
        // can actually reach somebody.
        _v3.y = waterY(_v3.x, _v3.z, t) + arc * (L.peak || SERPENT_BREACH)
              - (1 - arc) * SERPENT_LENGTH * 0.27;
        out.lerp(_v3, w);
      }
    }
    return out;
  }

  function startLunge(rig) {
    // 110 m of serpent needs a longer arc to clear the water and come back down.
    // Alternating, not random: the first one has to be the towering breach, and
    // a crew that only ever got low charges would never see the good shot.
    const high = (rig.lungeIdx % 2) === 0;
    const L = rig.lunge = {
      start: EV.elapsed, dur: high ? 3.6 : 2.9, hit: false, breach: false, dive: false,
      high, peak: high ? SERPENT_BREACH : SERPENT_LENGTH * 0.085,
    };
    // aim across the bow of the boat (or across the local player if there is no boat)
    if (!getBoatPos(_v1)) getLocalPos(_v1);
    _v1.y = 0;
    // forward: prefer live boat velocity, else yaw from the boat quaternion, else outward from island
    _v2.set(0, 0, 1);
    const b = ctx.boat;
    if (b && b.velocity && b.velocity.isVector3 && b.velocity.lengthSq() > 0.4) {
      _v2.copy(b.velocity); _v2.y = 0; _v2.normalize();
    } else if (b && b.group && b.group.isObject3D) {
      _v2.set(0, 0, 1).applyQuaternion(b.group.quaternion); _v2.y = 0;
      if (_v2.lengthSq() < 1e-4) _v2.set(0, 0, 1); else _v2.normalize();
    }
    _v3.set(-_v2.z, 0, _v2.x); // horizontal perpendicular = "across the bow"
    _v4.copy(_v1).addScaledVector(_v2, high ? SERPENT_HEAD_LEN * 1.3 : SERPENT_HEAD_LEN * 0.6);
    L.from = _v4.clone().addScaledVector(_v3, -SERPENT_LENGTH);
    L.to = _v4.clone().addScaledVector(_v3, SERPENT_LENGTH);
    L.bow = _v4.clone();
    sfx('serpentRoar', { type: 'serpent', index: rig.lungeIdx++ });
    shake(0.5, 1.4);
  }

  function updateSerpent(rig, dt, t) {
    const dur = EV.duration || 90;
    const head = rig.pts[0];

    // lunge scheduling
    if (!EV.ending) {
      if (rig.lunge && EV.elapsed > rig.lunge.start + rig.lunge.dur + 0.5) rig.lunge = null;
      if (!rig.lunge && EV.elapsed > rig.nextLunge) {
        startLunge(rig);
        rig.nextLunge = EV.elapsed + Math.max(9, dur / 6);
      }
    } else if (rig.lunge && EV.elapsed > rig.lunge.start + rig.lunge.dur + 0.5) {
      rig.lunge = null;
    }

    // path -> raw positions, then a length constraint pass so the body never stretches
    const speedRef = Math.max(3.5, rig.omega * SERPENT_R_START);
    const lag = rig.spacing / speedRef;
    serpentPath(rig, EV.elapsed, head, t);
    if (EV.ending) {
      // dive: drag the head down and away, fast
      const k = clamp(EV.endT / 3.2, 0, 1);
      head.y -= Math.pow(k, 1.6) * 170;
    }
    for (let i = 1; i < SERPENT_SEGMENTS; i++) {
      const p = rig.pts[i];
      serpentPath(rig, EV.elapsed - i * lag, p, t);
      if (EV.ending) p.y -= Math.pow(clamp((EV.endT - i * 0.06) / 3.2, 0, 1), 1.6) * 170;
      // constrain to exact spacing behind the previous segment
      const prev = rig.pts[i - 1];
      _v1.subVectors(p, prev);
      const d = _v1.length();
      if (d < 1e-4) _v1.set(0, 0, 1); else _v1.multiplyScalar(1 / d);
      p.copy(prev).addScaledVector(_v1, rig.spacing);
    }

    // write instances
    for (let i = 0; i < SERPENT_SEGMENTS; i++) {
      const p = rig.pts[i];
      if (i < SERPENT_SEGMENTS - 1) _v2.subVectors(p, rig.pts[i + 1]);
      else _v2.subVectors(rig.pts[i - 1], p).multiplyScalar(-1);
      const r = rig.radii[i];
      orientMatrix(_m1, p, _v2, r, r * 0.9, rig.spacing * 1.15);
      rig.body.setMatrixAt(i, _m1);
      // dorsal frill sail
      _v3.copy(p); _v3.y += r * 0.72;
      orientMatrix(_m1, _v3, _v2, 0.22, r * 1.15, rig.spacing * 1.5);
      rig.frill.setMatrixAt(i, _m1);
      // bioluminescent nodes along the flank
      const pulse = 0.55 + 0.45 * Math.sin(t * 3.1 - i * 0.55);
      _v3.copy(p); _v3.y += r * 0.35;
      orientMatrix(_m1, _v3, _v2, r * 0.16 * pulse, r * 0.16 * pulse, r * 0.3 * pulse);
      rig.glow.setMatrixAt(i, _m1);

      // breach splashes
      const wy = waterY(p.x, p.z, t);
      const above = p.y + r * 0.5 > wy;
      const wasAbove = rig.prevY[i] > 0.5;
      if (above !== wasAbove && rig.splashCd <= 0 && i % 3 === 0) {
        waterSplash(p.x, wy, p.z, 6);
        emit(spray, p.x, wy, p.z, 20, 15, r * 1.6, 1.15, 0.62, 0.78, 0.86, 1.5);
        shockRing(p.x, wy, p.z, r * 0.8, r * 5.0, 1.8, 0x9fd8ff, 0.38);
        shakeAt(p.x, p.z, 0.2, 0.5, 300);
        rig.splashCd = 0.24;
      }
      rig.prevY[i] = above ? 1 : 0;
    }
    rig.splashCd -= dt;
    rig.body.instanceMatrix.needsUpdate = true;
    rig.frill.instanceMatrix.needsUpdate = true;
    rig.glow.instanceMatrix.needsUpdate = true;

    // head transform
    _v2.subVectors(rig.pts[0], rig.pts[1]);
    if (_v2.lengthSq() < 1e-8) _v2.set(0, 0, 1);
    orientMatrix(_m1, rig.pts[0], _v2, 1, 1, 1);
    rig.head.position.copy(rig.pts[0]).addScaledVector(_v2.normalize(), SERPENT_HEAD_LEN * 0.24);
    rig.head.quaternion.setFromRotationMatrix(_m1);
    rig.light.position.copy(rig.head.position);
    animateFish(rig.neck, t);

    // jaw + roar beats
    let jawTarget = 0.05 + 0.05 * Math.sin(t * 1.7);
    const L = rig.lunge;
    if (L) {
      const u = clamp((EV.elapsed - L.start) / L.dur, 0, 1);
      jawTarget = 0.25 + 0.75 * bump(clamp((u - 0.12) / 0.76, 0, 1));
      if (!L.breach && u > 0.1) {
        L.breach = true;
        const hp = rig.head.position;
        waterSplash(hp.x, waterY(hp.x, hp.z, t), hp.z, 6);
        emit(spray, hp.x, 0, hp.z, 95, 34, 20, 1.5, 0.72, 0.86, 0.95, 2.3);
        emit(foam, hp.x, SERPENT_GIRTH, hp.z, 22, 13, 22, 0.95, 0.6, 0.78, 0.86, 2.2, 5);
        shockRing(hp.x, 0, hp.z, 8, 120, 2.6, 0xbfe6ff, 0.72);
        shakeAt(hp.x, hp.z, 0.9, 1.8, 320);
        swell(0.5, 0.5);
      }
      if (!L.dive && u > 0.9) {
        L.dive = true;
        const hp = rig.head.position;
        waterSplash(hp.x, waterY(hp.x, hp.z, t), hp.z, 6);
        emit(spray, hp.x, 0, hp.z, 110, 38, 24, 1.6, 0.78, 0.9, 1.0, 2.5);
        shockRing(hp.x, 0, hp.z, 10, 150, 3.0, 0xa8dcff, 0.6);
        shakeAt(hp.x, hp.z, 0.7, 1.6, 320);
        swell(0.7, 0.42);
      }
      // one damage window per lunge — the head alone is 24 m of jaws
      if (!L.hit && u > 0.25 && u < 0.85 && getLocalPos(_v4)) {
        if (_v4.distanceTo(rig.head.position) < SERPENT_HEAD_LEN * 0.8) {
          L.hit = true;
          damageLocal(15, 'serpent');
          shake(1.05, 1.2);
          sfx('serpentBite', { type: 'serpent' });
        }
      }
    } else if (EV.ending) {
      jawTarget = 0.15;
    }
    rig.jaw += (jawTarget - rig.jaw) * expApproach(dt, 0.0008);
    rig.jawTop.rotation.x = -0.12 - rig.jaw * 0.62;
    rig.jawBot.rotation.x = 0.12 + rig.jaw * 0.70;
    rig.maw.material.opacity = rig.jaw * 0.85;
    rig.maw.scale.setScalar(3.5 + rig.jaw * 5.0);
    const eyeP = 0.75 + 0.25 * Math.sin(t * 4.3);
    rig.eyeL.material.opacity = rig.eyeR.material.opacity = eyeP;
  }

  // =========================================================
  // THE KRAKEN
  // =========================================================
  function buildKraken() {
    // root stays at identity: the arm instance matrices are computed in world
    // space, so only the mantle sub-group is allowed to carry a transform.
    const root = new THREE.Group();
    root.visible = false;
    const body = new THREE.Group();
    root.add(body);

    const mantle = spawnFish('krakenspawnling', KRAKEN_MANTLE, false);
    body.add(mantle);

    // the mantle breaks the surface like an island shouldering out of the sea
    const dome = new THREE.Mesh(GEO.blob, MAT.krakenDome);
    dome.scale.set(KRAKEN_DOME_R, KRAKEN_DOME_R * 0.62, KRAKEN_DOME_R * 1.12);
    dome.position.y = KRAKEN_DOME_R * 0.14;
    body.add(dome);

    // outside the dome ellipsoid, at the waterline once the mantle is staged
    const eyeSz = KRAKEN_DOME_R * 0.5;
    const eyeL = glowSprite(0xd08cff, eyeSz);
    eyeL.position.set(KRAKEN_DOME_R * 0.72, KRAKEN_DOME_R * 0.58, KRAKEN_DOME_R * 0.92);
    const eyeR = glowSprite(0xd08cff, eyeSz);
    eyeR.position.set(-KRAKEN_DOME_R * 0.72, KRAKEN_DOME_R * 0.58, KRAKEN_DOME_R * 0.92);
    body.add(eyeL, eyeR);

    const arms = new THREE.InstancedMesh(GEO.arm, MAT.krakenFlesh, KRAKEN_ARMS * ARM_SEGMENTS);
    arms.frustumCulled = false;
    const suckers = new THREE.InstancedMesh(GEO.sucker, MAT.krakenSucker, KRAKEN_ARMS * (ARM_SEGMENTS - 1));
    suckers.frustumCulled = false;
    root.add(arms, suckers);

    const light = new THREE.PointLight(0xb066ff, 170, 760, 1.0);
    light.position.y = KRAKEN_DOME_R * 0.35;
    body.add(light);

    const armData = [];
    for (let a = 0; a < KRAKEN_ARMS; a++) {
      const pts = [];
      for (let i = 0; i < ARM_SEGMENTS; i++) pts.push(new THREE.Vector3());
      const shadow = new THREE.Mesh(GEO.disc, MAT.shadowDisc.clone());
      shadow.rotation.x = -Math.PI / 2;
      shadow.visible = false;
      shadow.renderOrder = 4;
      scene.add(shadow);
      armData.push({
        pts, shadow,
        baseAng: (a / KRAKEN_ARMS) * Math.PI * 2 + Math.random() * 0.35,
        phase: Math.random() * 10,
        state: 'idle', st: Math.random() * 3, h: 0, hTarget: 0,
        target: new THREE.Vector3(), p0: new THREE.Vector3(), p1: new THREE.Vector3(),
        p2: new THREE.Vector3(), p3: new THREE.Vector3(),
        flinch: 0, slammed: false,
      });
    }

    return {
      root, body, mantle, dome, eyeL, eyeR, arms, suckers, light, armData,
      nextArm: 2.5, gripArm: -1, gripT: 0, gripHits: 0, attackCd: 0,
      bobPhase: Math.random() * 9, gripDone: false,
    };
  }

  const GRIP_FROM = Math.max(2, ARM_SEGMENTS - 8);   // where the wrap-around helix starts

  function armCurve(rig, arm, t) {
    arm.p0.set(
      rig.body.position.x + Math.cos(arm.baseAng) * ARM_BASE_R,
      rig.body.position.y + KRAKEN_DOME_R * 0.12,
      rig.body.position.z + Math.sin(arm.baseAng) * ARM_BASE_R
    );
    _v1.subVectors(arm.target, arm.p0); _v1.y = 0;
    let flat = Math.max(1, _v1.length());
    _v1.multiplyScalar(1 / flat);
    // never let an arm out-reach itself: clamp the tip to ARM_LENGTH from the base
    if (flat > ARM_LENGTH) {
      arm.target.copy(arm.p0).addScaledVector(_v1, ARM_LENGTH).setY(arm.target.y);
      flat = ARM_LENGTH;
    }
    const h = arm.h;
    arm.p1.copy(arm.p0).addScaledVector(_v1, flat * 0.25).setY(arm.p0.y + h * 0.75 + KRAKEN_REACH * 0.1);
    arm.p2.copy(arm.target).addScaledVector(_v1, -flat * 0.12).setY(arm.p0.y + h * 1.05 + KRAKEN_REACH * 0.14);
    arm.p3.copy(arm.target).setY(arm.target.y + h * 0.72);

    const sway = (1 + arm.flinch * 2.5) * (KRAKEN_REACH / 46);
    for (let i = 0; i < ARM_SEGMENTS; i++) {
      const u = i / (ARM_SEGMENTS - 1);
      const p = arm.pts[i];
      bez3(arm.p0, arm.p1, arm.p2, arm.p3, u, p);
      const s = Math.sin(t * 1.2 + arm.phase + u * 4.2) * u * 3.4 * sway;
      const s2 = Math.cos(t * 1.6 + arm.phase * 1.7 + u * 5.1) * u * 2.7 * sway;
      p.x += s; p.z += s2;
      p.y += Math.sin(t * 1.5 + arm.phase + u * 3.3) * u * 2.0 * sway;
    }
    if (rig.gripArm >= 0 && rig.armData[rig.gripArm] === arm) {
      // wrap the last third of the arm around the boat in a slow helix
      if (getBoatPos(_v2)) {
        const span = Math.max(1, ARM_SEGMENTS - 1 - GRIP_FROM);
        for (let i = GRIP_FROM; i < ARM_SEGMENTS; i++) {
          const k = (i - GRIP_FROM) / span;
          const ang = arm.baseAng + k * 4.4 + t * 0.55;
          const rr = lerp(ARM_GIRTH * 2.4, ARM_GIRTH * 1.25, k);
          _v3.set(_v2.x + Math.cos(ang) * rr, _v2.y + 0.4 + k * 9 + Math.sin(t * 6 + k * 3) * 0.8,
                  _v2.z + Math.sin(ang) * rr);
          arm.pts[i].lerp(_v3, smooth01(k * 1.15));
        }
      }
    }
  }

  function updateKraken(rig, dt, t) {
    const dur = EV.duration || 100;
    const wy = waterY(EV.center.x, EV.center.z, t);
    rig.body.position.set(EV.center.x,
      wy - KRAKEN_DOME_R * 0.5 + Math.sin(t * 0.4 + rig.bobPhase) * 2.4, EV.center.z);
    _v1.copy(EV.focus).sub(rig.body.position); _v1.y = 0;
    if (_v1.lengthSq() > 1e-4) rig.body.rotation.y = Math.atan2(_v1.x, _v1.z);
    if (EV.ending) rig.body.position.y -= Math.pow(clamp(EV.endT / 4.5, 0, 1), 1.7) * KRAKEN_REACH * 1.6;
    animateFish(rig.mantle, t);
    const eyeP = 0.6 + 0.4 * Math.abs(Math.sin(t * 1.15));
    rig.eyeL.material.opacity = rig.eyeR.material.opacity = eyeP * (EV.ending ? clamp(1 - EV.endT / 3, 0, 1) : 1);

    // grip timer
    if (rig.gripArm >= 0) {
      rig.gripT -= dt;
      shake(0.2 + 0.06 * Math.sin(t * 9), 0.5);
      swell(0.35, 0.7);
      if (rig.gripT <= 0 || rig.gripHits >= 6) releaseGrip(rig);
    }

    // arm director
    if (!EV.ending) {
      rig.nextArm -= dt;
      if (rig.nextArm <= 0) {
        const prog = clamp(EV.elapsed / dur, 0, 1);
        const slots = prog > 0.5 ? 2 : 1;
        for (let k = 0; k < slots; k++) {
          const idx = pickIdleArm(rig);
          if (idx >= 0) {
            const arm = rig.armData[idx];
            arm.state = 'telegraph'; arm.st = 0; arm.slammed = false;
            pickSlamTarget(arm.target);
            sfx('krakenRise', { type: 'kraken' });
          }
        }
        rig.nextArm = lerp(3.4, 1.5, clamp(EV.elapsed / dur, 0, 1));
      }
    }

    // per-arm state machines
    for (let a = 0; a < rig.armData.length; a++) {
      const arm = rig.armData[a];
      arm.st += dt;
      arm.flinch = Math.max(0, arm.flinch - dt * 2.2);
      if (rig.gripArm === a) {
        arm.hTarget = KRAKEN_REACH * 0.6;
        if (getBoatPos(_v2)) arm.target.copy(_v2);
      } else {
        switch (arm.state) {
          case 'idle':
            arm.hTarget = -KRAKEN_REACH * 0.19 + Math.sin(t * 0.8 + arm.phase) * KRAKEN_REACH * 0.075;
            if (!arm.targetSet) { pickIdleTarget(arm, t); }
            break;
          case 'telegraph':
            // straight up: a column of meat taller than any hill on the island
            arm.hTarget = KRAKEN_REACH * 0.95;
            if (arm.st > 1.9) { arm.state = 'slam'; arm.st = 0; }
            break;
          case 'slam':
            arm.hTarget = -KRAKEN_REACH * 0.42;
            if (!arm.slammed && arm.st > 0.16) {
              arm.slammed = true;
              const tip = arm.pts[ARM_SEGMENTS - 1];
              const ty = waterY(tip.x, tip.z, t);
              waterSplash(tip.x, ty, tip.z, 6);
              emit(spray, tip.x, ty, tip.z, 90, 30, 16, 1.4, 0.7, 0.82, 0.92, 2.1);
              emit(foam, tip.x, ty + 8, tip.z, 20, 12, 20, 0.95, 0.62, 0.6, 0.78, 2.0, 5);
              shockRing(tip.x, ty, tip.z, 10, 130, 2.6, 0xc8b0ff, 0.7);
              sfx('krakenSlam', { type: 'kraken' });
              swell(0.75, 0.5);
              if (getLocalPos(_v4)) {
                _v4.y = ty;
                _v3.set(tip.x, ty, tip.z);
                const d = _v4.distanceTo(_v3);
                if (d < ARM_GIRTH * 2.4) { damageLocal(22, 'kraken'); shake(1.15, 1.3); }
                else shake(0.25 + 0.75 * clamp(1 - d / 300, 0, 1), 1.1);
              } else shake(0.5, 1.0);
            }
            if (arm.st > 1.1) { arm.state = 'recover'; arm.st = 0; }
            break;
          default: // recover
            arm.hTarget = -KRAKEN_REACH * 0.23;
            if (arm.st > 2.2) { arm.state = 'idle'; arm.st = 0; arm.targetSet = false; }
            break;
        }
      }
      if (EV.ending) arm.hTarget = -KRAKEN_REACH * 0.85 - a * 12;
      const k = arm.state === 'slam' ? expApproach(dt, 1e-8) : expApproach(dt, 0.06);
      arm.h += (arm.hTarget - arm.h) * k;

      armCurve(rig, arm, t);

      // shadow telegraph on the water
      const tip = arm.pts[ARM_SEGMENTS - 1];
      const sVis = arm.state === 'telegraph' || (rig.gripArm === a);
      arm.shadow.visible = sVis && !EV.ending;
      if (arm.shadow.visible) {
        const f = arm.state === 'telegraph' ? smooth01(arm.st / 1.9) : 1;
        arm.shadow.position.set(tip.x, waterY(tip.x, tip.z, t) + 0.28, tip.z);
        const s = lerp(ARM_GIRTH * 2, ARM_GIRTH * 5, f);
        arm.shadow.scale.set(s, s, 1);
        arm.shadow.material.opacity = 0.6 * f;
      }

      // write instance matrices
      const baseR = ARM_GIRTH, tipR = ARM_GIRTH * 0.22;
      for (let i = 0; i < ARM_SEGMENTS; i++) {
        const u = i / (ARM_SEGMENTS - 1);
        const p = arm.pts[i];
        if (i < ARM_SEGMENTS - 1) _v2.subVectors(arm.pts[i + 1], p);
        else _v2.subVectors(p, arm.pts[i - 1]);
        const len = Math.max(0.4, _v2.length());
        const r = lerp(baseR, tipR, Math.pow(u, 0.85)) * (1 + arm.flinch * 0.25);
        _v3.copy(p).addScaledVector(_v2, 0.5);
        orientMatrix(_m1, _v3, _v2, r, r, len * 1.06);
        rig.arms.setMatrixAt(a * ARM_SEGMENTS + i, _m1);
        if (i < ARM_SEGMENTS - 1) {
          _v5.copy(_v2).multiplyScalar(1 / len);
          _rt.crossVectors(UP, _v5);
          if (_rt.lengthSq() < 1e-8) _rt.set(1, 0, 0); else _rt.normalize();
          _up.crossVectors(_v5, _rt).normalize();
          _v4.copy(p).addScaledVector(_up, -r * 0.82);
          orientMatrix(_m1, _v4, _up, r * 0.42, r * 0.42, r * 0.5);
          rig.suckers.setMatrixAt(a * (ARM_SEGMENTS - 1) + i, _m1);
        }
      }
    }
    rig.arms.instanceMatrix.needsUpdate = true;
    rig.suckers.instanceMatrix.needsUpdate = true;
    rig.light.position.set(0, KRAKEN_DOME_R * 0.35 + Math.sin(t) * 4, 0);

    // "FIGHT IT OFF": swinging a weapon near a raised arm makes it recoil (pure flavour)
    rig.attackCd -= dt;
    const st = ctx.state;
    if (!EV.ending && rig.attackCd <= 0 && ctx.input && ctx.input.mouseDown &&
        st && st.activeTool === 'weapon' && getLocalPos(_v4)) {
      let best = -1, bestD = ARM_GIRTH * 3.2;
      for (let a = 0; a < rig.armData.length; a++) {
        const arm = rig.armData[a];
        if (arm.h < KRAKEN_REACH * 0.06 && rig.gripArm !== a) continue;
        for (let i = Math.max(2, ARM_SEGMENTS - 12); i < ARM_SEGMENTS; i += 2) {
          const d = _v4.distanceTo(arm.pts[i]);
          if (d < bestD) { bestD = d; best = a; }
        }
      }
      if (best >= 0) {
        const arm = rig.armData[best];
        arm.flinch = 1;
        arm.h -= KRAKEN_REACH * 0.13;
        rig.attackCd = 0.32;
        const p = arm.pts[ARM_SEGMENTS - 3];
        emit(spray, p.x, p.y, p.z, 22, 12, 3.5, 0.7, 0.85, 0.35, 0.75, 0.9, 9);
        sfx('krakenHurt', { type: 'kraken' });
        if (rig.gripArm === best) {
          rig.gripHits++;
          shake(0.28, 0.35);
        }
      }
    }
  }

  function pickIdleArm(rig) {
    const order = [];
    for (let i = 0; i < rig.armData.length; i++) if (rig.armData[i].state === 'idle' && rig.gripArm !== i) order.push(i);
    if (!order.length) return -1;
    return order[(Math.random() * order.length) | 0];
  }
  function pickIdleTarget(arm, t) {
    const ang = arm.baseAng + (Math.random() - 0.5) * 1.2;
    const r = KRAKEN_REACH * 0.45 + Math.random() * KRAKEN_REACH * 0.35;
    arm.target.set(EV.center.x + Math.cos(ang) * r,
      waterY(0, 0, t) - KRAKEN_REACH * 0.12, EV.center.z + Math.sin(ang) * r);
    arm.targetSet = true;
  }
  function pickSlamTarget(out) {
    // usually the boat, sometimes a swimmer (reservoir-sampled, no allocation)
    let ok = false;
    if (Math.random() < 0.72) ok = getBoatPos(out);
    if (!ok) {
      let seen = 0;
      if (getLocalPos(_v1)) { seen = 1; out.copy(_v1); ok = true; }
      eachRemote((r) => {
        if (seen >= 8 || !remotePos(r, _v2)) return;
        seen++;
        if (Math.random() < 1 / seen) { out.copy(_v2); ok = true; }
      });
    }
    if (!ok) out.copy(EV.focus);
    out.y = 0;
    out.x += (Math.random() - 0.5) * 22;
    out.z += (Math.random() - 0.5) * 22;
  }
  function releaseGrip(rig) {
    if (rig.gripArm < 0) return;
    const arm = rig.armData[rig.gripArm];
    arm.state = 'recover'; arm.st = 0; arm.targetSet = false; arm.flinch = 1;
    rig.gripArm = -1; rig.gripHits = 0;
    sfx('krakenRelease', { type: 'kraken' });
    shake(0.5, 0.9);
  }
  function beginGrip(rig) {
    if (rig.gripArm >= 0 || EV.ending) return;
    let idx = pickIdleArm(rig);
    if (idx < 0) idx = 0;
    const arm = rig.armData[idx];
    arm.state = 'grab'; arm.st = 0; arm.slammed = true;
    rig.gripArm = idx; rig.gripT = 13; rig.gripHits = 0;
    if (!getBoatPos(arm.target)) arm.target.copy(EV.focus);
    sfx('krakenGrab', { type: 'kraken' });
    shake(1.0, 1.6);
    swell(0.85, 0.55);
    if (getBoatPos(_v1)) {
      waterSplash(_v1.x, waterY(_v1.x, _v1.z, 0), _v1.z, 6);
      emit(spray, _v1.x, waterY(_v1.x, _v1.z, 0), _v1.z, 70, 22, 12, 1.3, 0.72, 0.6, 0.9, 1.9);
      shockRing(_v1.x, waterY(_v1.x, _v1.z, 0), _v1.z, 10, 110, 2.4, 0xc8a0ff, 0.75);
    }
  }

  // =========================================================
  // THE BLOOP — 260 m of bespoke wrong whale.
  //
  // Nothing here comes from the fish factory: a chain of hide segments that
  // follows its own head, a maw that splits half the skull open onto a lit
  // throat, rows of dim red eyes down both flanks, barnacle-crusted ridge
  // plates, tattered fins, bio-glow veins under the skin and mist that clings
  // to the whole mass. And it is FAST — it closes from the horizon inside the
  // first third of the event, then carves passes around and UNDER the boat.
  // =========================================================
  const BLOOP_SPACING = (BLOOP_LENGTH - BLOOP_HEAD) / (BLOOP_SEGS - 1);
  const BLOOP_EYE_FROM = 1, BLOOP_EYE_TO = Math.min(BLOOP_SEGS - 5, 16);

  function buildBloopHead() {
    const H = BLOOP_HEAD, HW = H * 0.50, HH = H * 0.42;
    const g = new THREE.Group();

    // the fixed half of the skull
    const cranium = new THREE.Mesh(GEO.bloopSeg, MAT.bloopHide);
    cranium.scale.set(HW, HH, H * 0.36);
    cranium.position.z = -H * 0.13;
    g.add(cranium);

    const brow = new THREE.Mesh(GEO.frill, MAT.bloopPlate);
    brow.scale.set(HW * 0.86, HH * 0.36, H * 0.52);
    brow.position.set(0, HH * 0.66, -H * 0.12);
    g.add(brow);

    // barnacle crown
    const crown = new THREE.InstancedMesh(GEO.barnacle, MAT.bloopBarnacle, 14);
    crown.frustumCulled = false;
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      _v1.set(Math.cos(a) * HW * 0.62, HH * 0.44 + Math.sin(a) * HH * 0.3, -H * 0.24 + (i % 4) * H * 0.05);
      _v2.set(Math.cos(a) * 0.75, 0.85, 0.12);
      orientMatrix(_m1, _v1, _v2, H * 0.032, H * 0.032, H * 0.05);
      crown.setMatrixAt(i, _m1);
    }
    crown.instanceMatrix.needsUpdate = true;
    g.add(crown);

    // the throat — hidden inside the jaws until they hinge open
    const throat = new THREE.Mesh(GEO.blob, MAT.bloopThroat);
    throat.scale.set(HW * 0.58, HH * 0.44, H * 0.30);
    throat.position.z = H * 0.20;
    g.add(throat);
    const throatGlow = glowSprite(0xff2c0a, H * 0.55, 0);
    throatGlow.position.z = H * 0.28;
    g.add(throatGlow);

    // the maw: splits half the head
    const jawTop = new THREE.Group(); jawTop.position.set(0, HH * 0.10, 0);
    const jawBot = new THREE.Group(); jawBot.position.set(0, -HH * 0.16, 0);
    for (const [jaw, sign, hy, hz] of [[jawTop, 1, HH * 0.44, H * 0.32], [jawBot, -1, HH * 0.34, H * 0.30]]) {
      const lump = new THREE.Mesh(GEO.bloopSeg, MAT.bloopHide);
      lump.scale.set(HW * (sign > 0 ? 0.95 : 0.86), hy, hz);
      lump.position.z = H * 0.28;
      jaw.add(lump);
      const n = 16;
      const teeth = new THREE.InstancedMesh(GEO.tooth, MAT.bloopTooth, n);
      teeth.frustumCulled = false;
      for (let i = 0; i < n; i++) {
        const side = i % 2 === 0 ? 1 : -1;
        const u = Math.floor(i / 2) / (n / 2 - 1);
        _v1.set(side * HW * 0.74 * (1 - 0.5 * u), -sign * hy * 0.55, H * 0.06 + u * H * 0.44);
        _v2.set(side * 0.2, -sign, 0.22);
        orientMatrix(_m1, _v1, _v2, H * 0.032, H * 0.032, H * 0.11 - u * H * 0.045);
        teeth.setMatrixAt(i, _m1);
      }
      teeth.instanceMatrix.needsUpdate = true;
      jaw.add(teeth);
      // torn lip webbing
      const web = new THREE.Mesh(GEO.tatter, MAT.bloopFin);
      web.scale.set(H * 0.1, H * 0.1, HW * 1.5);
      web.position.set(0, -sign * hy * 0.8, H * 0.36);
      web.rotation.z = sign > 0 ? -0.5 : 0.5;
      jaw.add(web);
    }
    g.add(jawTop, jawBot);

    // the two head eyes are the big ones; the flanks carry the rows
    const eyeL = glowSprite(0xff2418, H * 0.2, 0.9);
    eyeL.position.set(HW * 0.86, HH * 0.5, -H * 0.06);
    const eyeR = glowSprite(0xff2418, H * 0.2, 0.9);
    eyeR.position.set(-HW * 0.86, HH * 0.5, -H * 0.06);
    g.add(eyeL, eyeR);

    return { g, jawTop, jawBot, throat, throatGlow, eyeL, eyeR };
  }

  function buildBloop() {
    const root = new THREE.Group();
    root.visible = false;

    // --- body chain: world-space instances, so root stays at identity ---
    const hide = new THREE.InstancedMesh(GEO.bloopSeg, MAT.bloopHide, BLOOP_SEGS);
    const plates = new THREE.InstancedMesh(GEO.frill, MAT.bloopPlate, BLOOP_SEGS);
    const barn = new THREE.InstancedMesh(GEO.barnacle, MAT.bloopBarnacle, BLOOP_SEGS * 3);
    const eyes = new THREE.InstancedMesh(GEO.eyeball, MAT.bloopEye, BLOOP_SEGS * 4);
    const veins = new THREE.InstancedMesh(GEO.blob, MAT.bloopVein, BLOOP_SEGS * 2);
    hide.frustumCulled = plates.frustumCulled = barn.frustumCulled = false;
    eyes.frustumCulled = veins.frustumCulled = false;
    veins.renderOrder = 5;
    root.add(hide, plates, barn, veins, eyes);

    const head = buildBloopHead();
    root.add(head.g);

    // --- tattered fins: two pectorals and a shredded fluke ---
    const fins = [];
    for (const f of [{ seg: 3, side: 1, len: 0.9 }, { seg: 3, side: -1, len: 0.9 },
                     { seg: BLOOP_SEGS - 3, side: 1, len: 1.35 }, { seg: BLOOP_SEGS - 3, side: -1, len: 1.35 }]) {
      const m = new THREE.Mesh(GEO.tatter, MAT.bloopFin);
      m.matrixAutoUpdate = false;
      m.frustumCulled = false;
      root.add(m);
      fins.push({ m, seg: f.seg, side: f.side, len: f.len, phase: Math.random() * 8 });
    }

    // --- mist that clings to it ---
    const mists = [];
    for (let i = 0; i < 12; i++) {
      const s = glowSprite(0xa8bcc4, BLOOP_GIRTH * 1.4, 0);
      s.renderOrder = 7;
      root.add(s);
      mists.push({ s, seg: 1 + ((i * 2) % (BLOOP_SEGS - 4)), ang: Math.random() * 6.28, phase: Math.random() * 9 });
    }

    const light = new THREE.PointLight(0xff2a20, 240, 900, 1.2);
    root.add(light);

    const pts = [], rpts = [], dirs = [];
    for (let i = 0; i < BLOOP_SEGS; i++) {
      pts.push(new THREE.Vector3()); rpts.push(new THREE.Vector3());
      dirs.push(new THREE.Vector3(0, 0, 1));
    }
    const rad = new Float32Array(BLOOP_SEGS);
    for (let i = 0; i < BLOOP_SEGS; i++) {
      const u = i / (BLOOP_SEGS - 1);
      rad[i] = BLOOP_GIRTH * (0.86 + 0.40 * Math.sin(Math.pow(u, 0.5) * Math.PI)) * (1 - 0.84 * Math.pow(u, 1.6));
    }

    return {
      root, hide, plates, barn, eyes, veins, light,
      headG: head.g, jawTop: head.jawTop, jawBot: head.jawBot,
      throat: head.throat, throatGlow: head.throatGlow, eyeL: head.eyeL, eyeR: head.eyeR,
      fins, mists, pts, rpts, dirs, rad, spacing: BLOOP_SPACING,
      pos: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, 1), target: new THREE.Vector3(),
      nose: new THREE.Vector3(), headPos: new THREE.Vector3(),
      passSide: new THREE.Vector3(0, 0, 1),
      stage: 'approach', stageT: 0, passOff: 0, passY: -40, passUnder: false,
      speed: 30, bank: 0, prevD: 1e9, dist: BLOOP_FAR, prox: 0, near: 1e9,
      mawOpen: 0, mawWant: 0, wakeCd: 0, dmgCd: 0, callIdx: 0, nextCall: 5, cpaDone: false,
    };
  }

  function resetBloop(rig) {
    rig.stage = 'approach'; rig.stageT = 0;
    rig.speed = 30; rig.bank = 0; rig.prevD = 1e9;
    rig.mawOpen = 0; rig.mawWant = 0; rig.wakeCd = 0; rig.dmgCd = 0;
    rig.callIdx = 0; rig.nextCall = 5; rig.cpaDone = false;
    rig.passOff = 0; rig.passY = -BLOOP_GIRTH * 1.5; rig.passUnder = false;
    // stage it out on the horizon, nose pointed at the crew
    rig.dir.copy(EV.approachDir).multiplyScalar(-1).setY(0);
    if (rig.dir.lengthSq() < 1e-6) rig.dir.set(0, 0, 1);
    rig.dir.normalize();
    rig.pos.set(EV.center.x - rig.dir.x * BLOOP_FAR, -BLOOP_GIRTH * 2.2, EV.center.z - rig.dir.z * BLOOP_FAR);
    for (let i = 0; i < BLOOP_SEGS; i++) {
      rig.pts[i].copy(rig.pos).addScaledVector(rig.dir, -i * rig.spacing);
      rig.rpts[i].copy(rig.pts[i]);
      rig.dirs[i].copy(rig.dir);
    }
    rig.dist = BLOOP_FAR; rig.prox = 0; rig.near = 1e9;
    rig.target.copy(EV.focus).setY(-BLOOP_GIRTH * 1.6);
  }

  // Choose how the NEXT pass shaves the hull: to one side with its back rolling
  // out of the sea, or straight underneath the keel. Then dive at the crew.
  function bloopPickPass(rig) {
    const under = Math.random() < 0.55;
    rig.passUnder = under;
    rig.passOff = under
      ? (Math.random() - 0.5) * 26
      : (Math.random() < 0.5 ? -1 : 1) * (BLOOP_GIRTH * 1.7 + Math.random() * BLOOP_GIRTH * 1.6);
    // under = keel-shaving deep (the head still has to clear the hull while it
    // climbs out of the sweep); beside = the dorsal ridge rolls clear of the water
    rig.passY = under
      ? -(BLOOP_GIRTH * 1.35 + Math.random() * BLOOP_GIRTH * 0.7)
      : -(BLOOP_GIRTH * 0.42);
    // offset sideways from its own line of attack
    rig.passSide.set(-rig.dir.z, 0, rig.dir.x);
    if (rig.passSide.lengthSq() < 1e-8) rig.passSide.set(1, 0, 0); else rig.passSide.normalize();
    rig.stage = 'dive'; rig.stageT = 0; rig.cpaDone = false; rig.prevD = 1e9;
    sfx('bloopPass', { type: 'bloop', under, index: rig.callIdx });
  }

  // After a pass it carries on out along its own line, dropping deep, then
  // wheels round for the next run. Turn-rate limited the whole way.
  function bloopSweep(rig) {
    rig.stage = 'sweep'; rig.stageT = 0; rig.mawWant = 0;
  }

  function bloopSteer(rig, dt, t, p) {
    rig.stageT += dt;
    const f = EV.focus;
    let turnRate = 0.42;

    if (EV.ending) {
      if (rig.stage !== 'flee') { rig.stage = 'flee'; rig.stageT = 0; rig.mawWant = 0; }
      rig.target.set(f.x + EV.approachDir.x * 2600, -520, f.z + EV.approachDir.z * 2600);
      rig.speed += (150 - rig.speed) * expApproach(dt, 0.35);
      turnRate = 0.3;
    } else if (rig.stage === 'approach') {
      // closes from the horizon FAST — inside the first third of the event
      rig.target.set(f.x - EV.approachDir.x * 200, -BLOOP_GIRTH * 1.5, f.z - EV.approachDir.z * 200);
      rig.speed += (lerp(34, 82, smooth01(rig.stageT / 12)) - rig.speed) * expApproach(dt, 0.3);
      turnRate = 0.16;
      if (rig.dist < 380 || rig.stageT > 34) bloopPickPass(rig);
    } else if (rig.stage === 'sweep') {
      rig.target.copy(rig.pos).addScaledVector(rig.dir, 320);
      rig.target.y = rig.passY - 95;
      rig.speed += (lerp(62, 80, p) - rig.speed) * expApproach(dt, 0.4);
      turnRate = 0.34;
      if (rig.stageT > 3.0 || rig.dist > 430) bloopPickPass(rig);
    } else { // 'dive' — straight at the crew, offset by however close this pass is
      rig.target.set(f.x + rig.passSide.x * rig.passOff, rig.passY, f.z + rig.passSide.z * rig.passOff);
      rig.speed += (lerp(80, 102, p) - rig.speed) * expApproach(dt, 0.5);
      turnRate = 0.80;
      if (rig.stageT > 11) bloopSweep(rig);
    }

    // hard leash: it must never become a distant speck for long
    if (!EV.ending && rig.dist > 780 && rig.stage !== 'approach') bloopPickPass(rig);

    // Limited-rate steering: a 260 m animal carves, it does not pivot.
    // A real axis-angle rotation, NOT a lerp — lerping toward a heading that is
    // nearly 180 degrees away turns you by almost nothing, and the thing sails
    // off over the horizon instead of coming back around.
    _v2.subVectors(rig.target, rig.pos);
    const d = _v2.length();
    let bankTarget = 0;
    if (d > 1e-3) {
      _v2.multiplyScalar(1 / d);
      const ang = Math.acos(clamp(rig.dir.dot(_v2), -1, 1));
      if (ang > 1e-4) {
        _v3.crossVectors(rig.dir, _v2);
        if (_v3.lengthSq() < 1e-10) {
          _v3.set(-rig.dir.z, 0, rig.dir.x);
          if (_v3.lengthSq() < 1e-10) _v3.set(1, 0, 0);
        }
        _v3.normalize();
        rig.dir.applyAxisAngle(_v3, Math.min(turnRate * dt, ang)).normalize();
        bankTarget = clamp(-_v3.y * Math.min(ang, 1.2) * 1.4, -0.55, 0.55);
      }
    }
    rig.bank += (bankTarget - rig.bank) * expApproach(dt, 0.1);
    rig.pos.addScaledVector(rig.dir, rig.speed * dt);
    // it lives in the water column: never fully airborne, never through the floor
    if (!EV.ending) rig.pos.y = clamp(rig.pos.y, -380, -BLOOP_GIRTH * 0.3);
    rig.dist = rig.pos.distanceTo(f);
    rig.prox = clamp(1 - rig.dist / BLOOP_FAR, 0, 1);
  }

  function bloopPassBy(rig, t) {
    // the moment it is beside/under you: displacement swell, wake, deck lurch
    rig.cpaDone = true;
    const f = EV.focus;
    const wy = waterY(f.x, f.z, t);
    sfx('bloopMaw', { type: 'bloop', under: rig.passUnder });
    shake(rig.passUnder ? 1.0 : 0.85, 1.8);
    swell(1.3, 0.34);
    waterSplash(f.x, wy, f.z, 6);
    for (let i = 0; i < 5; i++) {
      shockRing(f.x + rig.passSide.x * rig.passOff, wy, f.z + rig.passSide.z * rig.passOff,
        BLOOP_GIRTH * (0.6 + i * 0.4), BLOOP_GIRTH * (3.5 + i * 2.6), 2.6 + i * 0.3, 0xa8d4e8, 0.42 - i * 0.05);
    }
    emit(spray, f.x, wy, f.z, 70, 16, BLOOP_GIRTH * 1.2, 1.1, 0.62, 0.74, 0.84, 2.0);
    emit(foam, f.x, wy + 4, f.z, 30, 11, BLOOP_GIRTH * 1.6, 0.8, 0.52, 0.6, 0.66, 2.6, 4);
  }

  function updateBloop(rig, dt, t) {
    const dur = EV.duration || 110;
    const p = clamp(EV.elapsed / dur, 0, 1);
    const pts = rig.pts, rpts = rig.rpts, dirs = rig.dirs, rad = rig.rad, sp = rig.spacing;

    bloopSteer(rig, dt, t, p);

    // ---- chain: every segment follows the one ahead of it ----
    // pts is the pure constraint solve. The swim cycle is layered on top into
    // rpts and NEVER fed back in, or the tail would integrate itself into orbit.
    pts[0].copy(rig.pos);
    for (let i = 1; i < BLOOP_SEGS; i++) {
      const prev = pts[i - 1], q = pts[i];
      _v1.subVectors(q, prev);
      const d = _v1.length();
      if (d < 1e-4) _v1.copy(rig.dir).multiplyScalar(-1); else _v1.multiplyScalar(1 / d);
      q.copy(prev).addScaledVector(_v1, sp);
    }
    rpts[0].copy(pts[0]);
    for (let i = 1; i < BLOOP_SEGS; i++) {
      const k = i / (BLOOP_SEGS - 1);
      rpts[i].copy(pts[i]);
      rpts[i].y += Math.sin(t * 0.95 - i * 0.42) * sp * 0.5 * k;   // slow, wrong swim cycle
    }

    // ---- per-segment frames + instances ----
    let dorsalOut = -1e9, dorsalIdx = 0;
    const veinPulseBase = t * 2.0;
    for (let i = 0; i < BLOOP_SEGS; i++) {
      const q = rpts[i], r = rad[i];
      if (i < BLOOP_SEGS - 1) _v2.subVectors(q, rpts[i + 1]);
      else _v2.subVectors(rpts[i - 1], q);
      if (_v2.lengthSq() < 1e-8) _v2.copy(rig.dir);
      _v2.normalize();
      dirs[i].copy(_v2);
      // local frame — held in _fr/_fu because orientMatrix eats _rt/_up
      _fr.crossVectors(UP, _v2);
      if (_fr.lengthSq() < 1e-8) _fr.set(1, 0, 0); else _fr.normalize();
      _fu.crossVectors(_v2, _fr).normalize();

      orientMatrix(_m1, q, _v2, r, r * 0.78, sp * 0.74);
      rig.hide.setMatrixAt(i, _m1);

      // barnacle-crusted ridge plates down the spine
      _v3.copy(q).addScaledVector(_fu, r * 0.62);
      orientMatrix(_m1, _v3, _v2, r * 0.09, r * 0.52, sp * 0.95);
      rig.plates.setMatrixAt(i, _m1);

      // barnacle clusters, three per segment, crusted onto the shoulders
      for (let k = 0; k < 3; k++) {
        const a = (i * 1.7 + k * 2.1);
        const ca = Math.cos(a), sa = Math.sin(a);
        _v4.copy(q).addScaledVector(_fr, ca * r).addScaledVector(_fu, sa * r * 0.78 + r * 0.06);
        _v5.copy(_fr).multiplyScalar(ca).addScaledVector(_fu, sa * 0.8 + 0.3);
        if (_v5.lengthSq() < 1e-8) _v5.copy(_fu);
        const bs = r * (0.075 + 0.035 * ((i + k) % 3));
        orientMatrix(_m1, _v4, _v5, bs, bs, bs * 1.5);
        rig.barn.setMatrixAt(i * 3 + k, _m1);
      }

      // bio-glow veins: a red pulse travelling nose-to-tail under the skin
      const vp = 0.3 + 0.7 * Math.pow(0.5 + 0.5 * Math.sin(veinPulseBase - i * 0.55), 3);
      for (let s = 0; s < 2; s++) {
        const side = s === 0 ? 1 : -1;
        _v4.copy(q).addScaledVector(_fr, side * r).addScaledVector(_fu, -r * 0.18);
        orientMatrix(_m1, _v4, _v2, r * 0.055 * vp, r * 0.055 * vp, sp * 0.82);
        rig.veins.setMatrixAt(i * 2 + s, _m1);
      }

      // rows of dim red eyes down both flanks, blinking in a slow wave
      for (let k = 0; k < 4; k++) {
        const side = (k & 1) ? -1 : 1;
        const row = (k >> 1) ? -0.30 : 0.16;
        let es = 0;
        if (i >= BLOOP_EYE_FROM && i <= BLOOP_EYE_TO) {
          es = r * 0.075 * (0.55 + 0.45 * Math.sin(t * 1.6 - i * 0.5 + (k >> 1) * 1.7));
        }
        _v4.copy(q).addScaledVector(_fr, side * r * 1.02).addScaledVector(_fu, row * r);
        _v5.copy(_fr).multiplyScalar(side);
        orientMatrix(_m1, _v4, _v5, es, es, es);
        rig.eyes.setMatrixAt(i * 4 + k, _m1);
      }

      const top = q.y + r * 0.78;
      if (top > dorsalOut) { dorsalOut = top; dorsalIdx = i; }
    }
    rig.hide.instanceMatrix.needsUpdate = true;
    rig.plates.instanceMatrix.needsUpdate = true;
    rig.barn.instanceMatrix.needsUpdate = true;
    rig.veins.instanceMatrix.needsUpdate = true;
    rig.eyes.instanceMatrix.needsUpdate = true;
    MAT.bloopVein.opacity = 0.26 + 0.16 * Math.sin(t * 1.3);

    // ---- head ----
    rig.nose.copy(pts[0]).addScaledVector(rig.dir, BLOOP_HEAD);
    rig.headPos.copy(pts[0]).addScaledVector(rig.dir, BLOOP_HEAD * 0.34);
    rig.headG.position.copy(rig.headPos);
    orientMatrix(_m1, rig.headPos, rig.dir, 1, 1, 1);
    rig.headG.quaternion.setFromRotationMatrix(_m1);
    rig.headG.rotateZ(rig.bank);
    rig.light.position.copy(rig.headPos);
    rig.light.intensity = 160 + 120 * rig.mawOpen;

    // maw: hinges open on the run-in, snaps open as it goes past the hull
    if (!EV.ending && rig.stage === 'dive') {
      _v1.subVectors(EV.focus, rig.pos);
      const ahead = _v1.dot(rig.dir);
      rig.mawWant = (ahead > -60) ? smoothstep(300, 90, rig.dist) : 0;
    } else rig.mawWant -= rig.mawWant * expApproach(dt, 0.02);
    rig.mawOpen += (clamp(rig.mawWant, 0, 1) - rig.mawOpen) * expApproach(dt, 0.02);
    rig.jawTop.rotation.x = -rig.mawOpen * 0.62;
    rig.jawBot.rotation.x = rig.mawOpen * 0.78;
    const glow = rig.mawOpen * (0.55 + 0.45 * Math.abs(Math.sin(t * 2.6)));
    rig.throatGlow.material.opacity = glow;
    rig.throatGlow.scale.setScalar(BLOOP_HEAD * (0.35 + rig.mawOpen * 0.5));
    MAT.bloopThroat.color.setRGB(0.75 + glow * 0.9, 0.09 + glow * 0.16, 0.03);
    const eyeA = (0.6 + 0.4 * Math.abs(Math.sin(t * 0.7))) * (EV.ending ? clamp(1 - EV.endT / 4, 0, 1) : 1);
    rig.eyeL.material.opacity = rig.eyeR.material.opacity = eyeA;
    MAT.bloopEye.opacity = 0.55 + 0.35 * eyeA;

    // ---- tattered fins ----
    for (let i = 0; i < rig.fins.length; i++) {
      const f = rig.fins[i];
      const q = rpts[f.seg], d = dirs[f.seg], r = rad[f.seg];
      _fr.crossVectors(UP, d);
      if (_fr.lengthSq() < 1e-8) _fr.set(1, 0, 0); else _fr.normalize();
      _fu.crossVectors(d, _fr).normalize();
      const flap = Math.sin(t * 1.15 + f.phase) * 0.22;
      _v4.copy(q).addScaledVector(_fr, f.side * r * 0.86).addScaledVector(_fu, -r * 0.22);
      _v5.copy(d).addScaledVector(_fu, flap).normalize();
      orientMatrix(_m1, _v4, _v5, f.side * r * f.len * 1.5, r * 0.5, r * 1.25);
      f.m.matrix.copy(_m1);
      f.m.matrixWorldNeedsUpdate = true;
    }

    // ---- mist clinging to the mass ----
    for (let i = 0; i < rig.mists.length; i++) {
      const m = rig.mists[i];
      const q = rpts[m.seg], d = dirs[m.seg], r = rad[m.seg];
      _fr.crossVectors(UP, d);
      if (_fr.lengthSq() < 1e-8) _fr.set(1, 0, 0); else _fr.normalize();
      _fu.crossVectors(d, _fr).normalize();
      const a = m.ang + t * 0.24;
      m.s.position.copy(q)
        .addScaledVector(_fr, Math.cos(a) * r * 1.05)
        .addScaledVector(_fu, Math.sin(a) * r * 0.55 + r * 0.55);
      const wy = waterY(m.s.position.x, m.s.position.z, t);
      const above = clamp((m.s.position.y - wy + 14) / 26, 0, 1);
      m.s.material.opacity = above * (0.14 + 0.12 * Math.sin(t * 0.8 + m.phase)) * (EV.ending ? clamp(1 - EV.endT / 4, 0, 1) : 1);
      m.s.scale.setScalar(r * (1.2 + 0.25 * Math.sin(t * 0.5 + m.phase)));
    }

    // ---- surface interaction: wake, breach foam, displacement ----
    rig.wakeCd -= dt;
    if (!EV.ending && rig.wakeCd <= 0) {
      const q = rpts[dorsalIdx], r = rad[dorsalIdx];
      const wy = waterY(q.x, q.z, t);
      const clearance = q.y + r * 0.78 - wy;
      if (clearance > -BLOOP_GIRTH * 1.4) {
        rig.wakeCd = 0.1;
        const heavy = clearance > 0;
        shockRing(q.x, wy, q.z, r * 0.5, r * (heavy ? 4.6 : 2.6), heavy ? 2.4 : 1.7,
          0xbfe0f0, heavy ? 0.5 : 0.22);
        if (heavy) {
          emit(spray, q.x, wy, q.z, 16, 14, r * 0.9, 1.2, 0.66, 0.78, 0.86, 1.5);
          if (Math.random() < 0.3) {
            waterSplash(q.x, wy, q.z, 6);
            emit(foam, q.x, wy + r * 0.2, q.z, 8, 9, r * 0.8, 0.8, 0.55, 0.62, 0.68, 2.4, 4);
          }
          shakeAt(q.x, q.z, 0.32, 0.5, 340);
        }
      }
    }

    // ---- how close is that thing to YOU ----
    rig.near = 1e9;
    let nearI = 0;
    if (getLocalPos(_v4)) {
      for (let i = 0; i < BLOOP_SEGS; i++) {
        const q = rpts[i];
        const dd = Math.hypot(_v4.x - q.x, _v4.z - q.z) - rad[i];
        if (dd < rig.near) { rig.near = dd; nearI = i; }
      }
      const dh = _v4.distanceTo(rig.headPos) - BLOOP_HEAD * 0.45;
      if (dh < rig.near) rig.near = dh;
      // displacement swell: the deck heaves when a building slides under it
      const depth = Math.max(0, -(rpts[nearI].y + rad[nearI] * 0.78 - waterY(_v4.x, _v4.z, t)));
      const near01 = clamp(1 - Math.max(0, rig.near) / 240, 0, 1);
      const shallow = clamp(1 - depth / 110, 0, 1);
      const amp = near01 * near01 * shallow;
      if (amp > 0.02) {
        swell(0.2 + amp * 1.15, 0.34 + amp * 0.5);
        shake(0.04 + amp * 0.4, 0.5);
      }
      // the pass itself
      if (!EV.ending && rig.stage === 'dive' && !rig.cpaDone) {
        if (rig.dist > rig.prevD && rig.dist < 340) { bloopPassBy(rig, t); bloopSweep(rig); }
        rig.prevD = rig.dist;
      }
    }

    // the call — it announces itself, and the sound arrives before it does
    if (!EV.ending) {
      rig.nextCall -= dt;
      if (rig.nextCall <= 0) { bloopCall(rig, t); rig.nextCall = lerp(13, 5.5, p); }
    }

    // constant low water vibration, stronger the closer it gets
    if (Math.random() < dt * (0.7 + rig.prox * 3.2)) {
      const a = Math.random() * Math.PI * 2, r = 20 + Math.random() * 90;
      const x = EV.focus.x + Math.cos(a) * r, z = EV.focus.z + Math.sin(a) * r;
      shockRing(x, waterY(x, z, t), z, 0.8, 8 + rig.prox * 18, 1.9, 0x8fb8d8, 0.14 + rig.prox * 0.2);
    }
    shake(0.05 + rig.prox * 0.12, 0.4);

    // It only truly hurts you if you are in the water with it — the crew on deck
    // just get the lurch. Swimming into an open maw is its own kind of mistake.
    rig.dmgCd -= dt;
    if (!EV.ending && rig.dmgCd <= 0 && rig.near < BLOOP_GIRTH * 1.1 && localIsSwimming()) {
      rig.dmgCd = 2.4;
      const inMaw = rig.mawOpen > 0.5 && getLocalPos(_v3) &&
        _v3.distanceTo(rig.nose) < BLOOP_HEAD * 0.6;
      damageLocal(inMaw ? 60 : (rig.near < BLOOP_GIRTH * 0.4 ? 45 : 25), 'bloop');
      shake(inMaw ? 1.2 : 1.05, 1.0);
      sfx('bloopMaw', { type: 'bloop', inMaw });
    }
  }

  function bloopCall(rig, t) {
    const p = clamp(EV.elapsed / (EV.duration || 110), 0, 1);
    sfx('bloopCall', { type: 'bloop', index: rig.callIdx++, volume: 0.35 + p * 0.65, distance: rig.dist });
    shake(0.2 + p * 0.45, 2.2);
    swell(0.3 + p * 0.4, 0.3);
    for (let i = 0; i < 4; i++) {
      const rr = 40 + i * 60;
      shockRing(EV.focus.x, waterY(EV.focus.x, EV.focus.z, t), EV.focus.z, rr * 0.25, rr, 2.6 + i * 0.4, 0x9fd0ff, 0.28);
    }
    if (getLocalPos(_v1)) {
      emit(spray, _v1.x, waterY(_v1.x, _v1.z, t), _v1.z, 26, 5, 12, 1.0, 0.55, 0.7, 0.85, 1.4);
    }
  }

  // =========================================================
  // THE TSUNAMI — doomsday, not a big wave.
  // The sea is dragged off the shore, the sky goes black-green, then a curling
  // wall WALL_H metres tall walks in with lightning flickering inside its face.
  // =========================================================
  const SAND_R = 460;   // radius of the exposed seabed once the sea is fully drawn back
  const wallUniforms = {
    uTime: { value: 0 }, uHScale: { value: 0.2 },
    uFlash: { value: 0 }, uFlashX: { value: 0 }, uSheet: { value: 0 },
  };
  const sandUniforms = { uEdge: { value: 0.36 }, uFade: { value: 0 } };

  // Built at full height so computeVertexNormals gives the real, near-vertical
  // face normals; uHScale only squashes it while the wave is still rising.
  function buildWallGeometry() {
    const NX = 96, NY = 22;
    const count = NX * NY;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const av = new Float32Array(count);
    const idx = new Uint16Array((NX - 1) * (NY - 1) * 6);
    // black-green doom water: almost no blue in it until the crest
    const deep = new THREE.Color(0x030f12), mid = new THREE.Color(0x0a3a38), foam = new THREE.Color(0xd6f4ea);
    const c = new THREE.Color();
    let k = 0;
    for (let j = 0; j < NY; j++) {
      const v = j / (NY - 1);
      for (let i = 0; i < NX; i++, k++) {
        const u = i / (NX - 1);
        const x = (u - 0.5) * WALL_W;
        const edge = Math.abs(u - 0.5) * 2;
        const bow = 1 - 0.30 * Math.pow(edge, 2.4);
        const y = (-0.10 + Math.pow(v, 0.90) * 1.10) * bow * (1 + 0.05 * Math.sin(x * 0.0048)) * WALL_H;
        // the curl: the top third throws itself forward and over
        const curl = smoothstep(0.52, 1.0, v);
        let z = (-0.18 * v * v + curl * curl * 0.52) * WALL_H * 0.62;
        z -= Math.pow(edge, 2) * 700;
        z += Math.sin(x * 0.0032) * 90;
        pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
        av[k] = v;
        if (v < 0.70) c.copy(deep).lerp(mid, Math.pow(v / 0.70, 0.8));
        else c.copy(mid).lerp(foam, smoothstep(0.70, 1.0, v));
        const n = 0.90 + 0.18 * Math.sin(x * 0.022 + v * 9.0);
        col[k * 3] = c.r * n; col[k * 3 + 1] = c.g * n; col[k * 3 + 2] = c.b * n;
      }
    }
    let o = 0;
    for (let j = 0; j < NY - 1; j++) {
      for (let i = 0; i < NX - 1; i++) {
        const a = j * NX + i, b = a + 1, cc = a + NX, d = cc + 1;
        idx[o++] = a; idx[o++] = cc; idx[o++] = b;
        idx[o++] = b; idx[o++] = cc; idx[o++] = d;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aV', new THREE.BufferAttribute(av, 1));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, WALL_H * 0.5, 0), WALL_W);
    return geo;
  }

  // The sky the island dies under: black overhead, sick green at the horizon.
  // depthTest/depthWrite off + a very low renderOrder puts it in the opaque queue
  // right behind world.js's sky, so terrain and ocean still paint over it.
  function buildDoomSky() {
    const geo = new THREE.SphereGeometry(460, 28, 18);
    const p = geo.attributes.position;
    const col = new Float32Array(p.count * 3);
    const zen = new THREE.Color(0x01050a), hor = new THREE.Color(0x123326), low = new THREE.Color(0x03100c);
    const c = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i) / 460;
      if (y >= 0) c.copy(hor).lerp(zen, Math.pow(clamp(y, 0, 1), 0.55));
      else c.copy(hor).lerp(low, Math.pow(clamp(-y, 0, 1), 0.5));
      const band = 0.85 + 0.35 * Math.exp(-Math.abs(y) * 14);   // sick glow on the horizon line
      col[i * 3] = c.r * band; col[i * 3 + 1] = c.g * band * 1.12; col[i * 3 + 2] = c.b * band;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.BackSide, depthTest: false, depthWrite: false,
      fog: false, toneMapped: false,
    });
    const m = new THREE.Mesh(geo, mat);
    m.renderOrder = -999;
    m.frustumCulled = false;
    m.visible = false;
    scene.add(m);
    return m;
  }
  let doomSky = null;

  function buildTsunami() {
    const root = new THREE.Group();
    root.visible = false;

    // --- the wall ---
    const wallMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.34, metalness: 0.0, side: THREE.DoubleSide,
      fog: false, emissive: 0x061c1a, emissiveIntensity: 0.8,
    });
    wallMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = wallUniforms.uTime;
      shader.uniforms.uHScale = wallUniforms.uHScale;
      shader.uniforms.uFlash = wallUniforms.uFlash;
      shader.uniforms.uFlashX = wallUniforms.uFlashX;
      shader.uniforms.uSheet = wallUniforms.uSheet;
      shader.vertexShader = 'uniform float uTime;\nuniform float uHScale;\nattribute float aV;\nvarying float vWv;\nvarying float vWx;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', [
        '#include <begin_vertex>',
        'float wv = aV;',
        'transformed.y = position.y * uHScale;',
        'float rip = sin(position.x * 0.0046 + uTime * 1.7) * 1.0 + sin(position.x * 0.013 - uTime * 2.6) * 0.55;',
        'transformed.y += rip * wv * wv * 20.0;',
        'transformed.z += sin(position.x * 0.0034 + uTime * 1.15) * wv * 34.0;',
        'transformed.x += sin(aV * 3.0 + uTime * 0.9) * wv * 11.0;',
        'vWv = wv; vWx = position.x;',
      ].join('\n'));
      shader.fragmentShader = 'uniform float uTime;\nuniform float uFlash;\nuniform float uFlashX;\nuniform float uSheet;\nvarying float vWv;\nvarying float vWx;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('vec4 diffuseColor = vec4( diffuse, opacity );', [
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        'float fo = smoothstep(0.62, 1.0, vWv);',
        'float streak = pow(sin(vWx * 0.034 + uTime * 3.0) * 0.5 + 0.5, 2.0);',
        'fo = clamp(fo + streak * smoothstep(0.30, 0.92, vWv) * 0.40, 0.0, 1.0);',
        'diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 1.0, 0.95), fo * 0.92);',
        // lightning INSIDE the face: a jagged column lit from within the water
        'float bx = vWx - uFlashX + sin(vWv * 11.0) * 55.0;',
        'float bolt = exp(-bx * bx / 26000.0) * uFlash;',
        'bolt *= 0.45 + 0.55 * abs(sin(vWv * 21.0 + uTime * 7.0));',
        'diffuseColor.rgb += vec3(0.42, 0.95, 1.0) * bolt * (0.30 + vWv * 1.35);',
        'diffuseColor.rgb += vec3(0.24, 0.60, 0.55) * uSheet * (0.20 + vWv * 0.75);',
      ].join('\n'));
      shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', [
        '#include <emissivemap_fragment>',
        // the crest glows on its own so it reads against a black-green sky
        'totalEmissiveRadiance += vec3(0.34, 0.78, 0.68) * smoothstep(0.70, 1.0, vWv) * 1.6;',
        'totalEmissiveRadiance += vec3(0.40, 0.85, 1.0) * (uSheet * 0.45 + uFlash * 0.35);',
      ].join('\n'));
    };
    const wall = new THREE.Mesh(buildWallGeometry(), wallMat);
    wall.frustumCulled = false;
    wall.renderOrder = 2;
    root.add(wall);

    // --- exposed seabed (the sea pulls back) ---
    const sandMat = new THREE.MeshStandardMaterial({
      map: TEX.sand, color: 0x8f8064, roughness: 0.98, metalness: 0,
      transparent: true, opacity: 1, depthWrite: true, side: THREE.DoubleSide,
    });
    sandMat.onBeforeCompile = (shader) => {
      shader.uniforms.uEdge = sandUniforms.uEdge;
      shader.uniforms.uFade = sandUniforms.uFade;
      shader.vertexShader = 'varying float vRad;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>',
        '#include <begin_vertex>\nvRad = length(position.xy);');
      shader.fragmentShader = 'uniform float uEdge;\nuniform float uFade;\nvarying float vRad;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('vec4 diffuseColor = vec4( diffuse, opacity );', [
        'if (vRad > uEdge || uFade < 0.02) discard;',
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        'float fw = smoothstep(uEdge - 0.05, uEdge - 0.004, vRad);',
        'diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.88, 0.94, 0.97), fw * 0.85);',
        'diffuseColor.rgb *= mix(0.55, 1.0, smoothstep(0.32, 0.55, vRad));',
        'diffuseColor.a *= uFade;',
      ].join('\n'));
    };
    const sand = new THREE.Mesh(new THREE.RingGeometry(0.30, 1, 110, 10), sandMat);
    sand.rotation.x = -Math.PI / 2;
    sand.position.y = 0.45;
    sand.scale.setScalar(SAND_R);
    sand.renderOrder = 1;
    root.add(sand);

    const rocks = new THREE.InstancedMesh(GEO.rock, new THREE.MeshStandardMaterial({
      color: 0x4a4438, roughness: 1, flatShading: true, transparent: true, opacity: 1,
    }), 44);
    rocks.frustumCulled = false;
    const rockData = [];
    for (let i = 0; i < 44; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 135 + Math.random() * (SAND_R - 160);
      rockData.push({ a, r, s: 1.4 + Math.random() * 4.6, ry: Math.random() * 6 });
    }
    root.add(rocks);

    // --- flood dome that swallows the island ---
    const floodGeo = new THREE.CircleGeometry(340, 80);
    (function domeIt() {
      const p = floodGeo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i);
        const r = Math.sqrt(x * x + y * y) / 340;
        p.setZ(i, (1 - r * r) * 11);
      }
      p.needsUpdate = true;
      floodGeo.computeVertexNormals();
    })();
    const flood = new THREE.Mesh(floodGeo, new THREE.MeshStandardMaterial({
      color: 0x0a2a2c, transparent: true, opacity: 0, roughness: 0.35,
      emissive: 0x08201e, emissiveIntensity: 0.8, depthWrite: false, side: THREE.DoubleSide, fog: false,
    }));
    flood.rotation.x = -Math.PI / 2;
    flood.position.y = -6;
    flood.renderOrder = 3;
    root.add(flood);

    const floodFoam = new THREE.Mesh(floodGeo, new THREE.MeshBasicMaterial({
      map: TEX.foam, color: 0xffffff, transparent: true, opacity: 0,
      depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false,
    }));
    floodFoam.rotation.x = -Math.PI / 2;
    floodFoam.position.y = -5.4;
    floodFoam.renderOrder = 4;
    root.add(floodFoam);

    return {
      root, wall, sand, sandMat, rocks, rockData, flood, floodFoam,
      roarIdx: 0, impacted: false, impactP: 0.7, boltT: 1.2, flash: 0, sheet: 0,
      quakeT: 2.0, bellIdx: 0, nightOn: false,
    };
  }

  // =========================================================
  // Event state machine
  // =========================================================
  const EV = {
    type: null, duration: 0, elapsed: 0, phase: 'none',
    rig: null, ending: false, endT: 0, endDur: 5.0,
    droneT: 0, dronePlayed: false, heartT: 0, nightOn: false,
    center: new THREE.Vector3(0, 0, -160),
    focus: new THREE.Vector3(0, 0, -160),
    approachDir: new THREE.Vector3(0, 0, -1),
    anchored: false, survived: true, day: 1,
  };

  const TS = { active: false, elapsed: 0, dur: ECON.QUOTA_FAIL_GRACE_SECONDS || 20, rig: null };

  const rigs = { serpent: null, kraken: null, bloop: null };

  function ensureRig(type) {
    if (rigs[type]) return rigs[type];
    if (type === 'serpent') rigs.serpent = buildSerpent();
    else if (type === 'kraken') rigs.kraken = buildKraken();
    else if (type === 'bloop') rigs.bloop = buildBloop();
    return rigs[type] || null;
  }

  function updateAnchor(dt, first) {
    const hasBoat = getBoatPos(_v1);
    const hasLocal = getLocalPos(_v2);
    let tx, tz;
    if (hasBoat && hasLocal && _v1.distanceTo(_v2) < 150) { tx = _v1.x; tz = _v1.z; }
    else if (hasLocal) { tx = _v2.x; tz = _v2.z; }
    else if (hasBoat) { tx = _v1.x; tz = _v1.z; }
    else { tx = 0; tz = -180; }
    // whatever the creature is staged around is also what it aims at
    EV.focus.set(tx, 0, tz);

    // stage the creature out at sea so it never grinds through the island
    let sx = tx, sz = tz;
    const d = Math.hypot(sx, sz);
    if (d < 170) {
      if (d < 1) { sx = 0; sz = -170; }
      else { const k = 170 / d; sx *= k; sz *= k; }
    }
    if (first || !EV.anchored) { EV.center.set(sx, 0, sz); EV.anchored = true; }
    else {
      const k = expApproach(dt, 0.12);
      EV.center.x += (sx - EV.center.x) * k;
      EV.center.z += (sz - EV.center.z) * k;
      EV.center.y = 0;
    }
  }

  function startEvent(type) {
    if (!type || !EVENTS[type]) return;
    if (TS.active) return;                        // the tsunami outranks everything
    if (EV.type === type && !EV.ending) return;   // guard double-start
    if (EV.type) hardCleanupEvent();

    EV.type = type;
    EV.duration = EVENTS[type].duration || 90;
    EV.elapsed = 0;
    EV.phase = 'start';
    EV.ending = false;
    EV.endT = 0;
    EV.droneT = 0;
    EV.dronePlayed = false;
    EV.heartT = 0;
    EV.anchored = false;
    EV.survived = true;

    // 1) the music stops dead
    cutMusic();
    // 2) instant darkness
    setNight(true);
    EV.nightOn = true;
    // a hard blink so the night-snap lands like a cut
    OV.value = 1; setOverlay(0x000000, 0, 2.6, 0.12);

    if (ctx.state) {
      if (!ctx.state.eventActive) ctx.state.eventActive = type;
      ctx.state.eventPhase = 'start';
    }

    updateAnchor(0, true);
    // the bloop comes out of the deep, away from the island
    EV.approachDir.set(EV.center.x, 0, EV.center.z);
    if (EV.approachDir.lengthSq() < 1) EV.approachDir.set(0, 0, -1);
    EV.approachDir.normalize();

    // 3) the thing arrives
    const rig = ensureRig(type);
    EV.rig = rig;
    if (rig) {
      rig.root.visible = true;
      if (!rig.root.parent) scene.add(rig.root);
      if (type === 'serpent') {
        rig.theta0 = Math.random() * Math.PI * 2;
        rig.dir = Math.random() < 0.5 ? 1 : -1;
        rig.omega = 0.17 + Math.random() * 0.06;
        rig.undPhase = Math.random() * 9;
        rig.lunge = null;
        rig.nextLunge = 9;
        rig.lungeIdx = 0;
        rig.jaw = 0;
        rig.prevY.fill(0);
        for (let i = 0; i < SERPENT_SEGMENTS; i++) serpentPath(rig, -i * 0.3, rig.pts[i], 0);
      } else if (type === 'kraken') {
        rig.gripArm = -1; rig.gripHits = 0; rig.gripT = 0; rig.nextArm = 3.0; rig.gripDone = false;
        for (const arm of rig.armData) {
          arm.state = 'idle'; arm.st = Math.random() * 2; arm.h = -8; arm.hTarget = -8;
          arm.flinch = 0; arm.targetSet = false; arm.shadow.visible = false;
        }
      } else if (type === 'bloop') {
        resetBloop(rig);
      }
    }
  }

  function endEvent(data) {
    if (!EV.type || EV.ending) return;   // bus + net can both deliver this
    EV.ending = true;
    EV.endT = 0;
    EV.phase = 'depart';
    EV.survived = !data || data.survived !== false;
    if (ctx.state) ctx.state.eventPhase = 'depart';
    if (EV.type === 'kraken' && EV.rig) releaseGrip(EV.rig);
    sfx('eventDepart', { type: EV.type, survived: EV.survived });
    shake(0.6, 1.8);
    swell(0.8, 0.4);
    // one last enormous displacement as it goes
    if (EV.rig) {
      const p = (EV.rig.headPos && EV.rig.headPos.isVector3) ? EV.rig.headPos : EV.center;
      waterSplash(p.x, waterY(p.x, p.z, 0), p.z, 6);
      shockRing(p.x, waterY(p.x, p.z, 0), p.z, 12, 220, 3.4, 0xa8d8ff, 0.6);
      emit(spray, p.x, 0, p.z, 110, 26, 24, 1.3, 0.7, 0.84, 0.94, 2.4);
    }
  }

  function hardCleanupEvent() {
    const rig = EV.rig;
    if (rig) {
      rig.root.visible = false;
      if (rig.root.parent) rig.root.parent.remove(rig.root);
      if (rig.armData) for (const arm of rig.armData) { arm.shadow.visible = false; arm.shadow.material.opacity = 0; }
      if (rig.maw) rig.maw.visible = false;
    }
    if (EV.nightOn) { setNight(false); EV.nightOn = false; }
    if (ctx.state) {
      if (ctx.state.eventActive === EV.type) ctx.state.eventActive = null;
      ctx.state.eventPhase = null;
    }
    EV.type = null; EV.rig = null; EV.ending = false; EV.elapsed = 0;
    EV.endT = 0; EV.phase = 'none'; EV.anchored = false;
    killRings();
    if (OV.value > 0 || OV.target > 0) setOverlay(0x000000, 0, 3);
    clearShake();
  }

  function onEventPhase(msg) {
    if (!msg || !msg.type) return;
    if (msg.type !== EV.type) return;
    EV.phase = msg.phase || EV.phase;
    if (ctx.state) ctx.state.eventPhase = EV.phase;
    const rig = EV.rig;
    if (!rig) return;
    if (EV.type === 'serpent') {
      if (EV.phase === 'lunge' && !rig.lunge && !EV.ending) { startLunge(rig); rig.nextLunge = EV.elapsed + 9; }
      else if (EV.phase === 'dive') { rig.nextLunge = EV.elapsed + 12; }
    } else if (EV.type === 'kraken') {
      if (EV.phase === 'grab') beginGrip(rig);
      else if (EV.phase === 'release') releaseGrip(rig);
      else if (EV.phase === 'slam' && !EV.ending) {
        const idx = pickIdleArm(rig);
        if (idx >= 0) {
          const arm = rig.armData[idx];
          arm.state = 'telegraph'; arm.st = 0; arm.slammed = false;
          pickSlamTarget(arm.target);
          sfx('krakenRise', { type: 'kraken' });
        }
      }
    } else if (EV.type === 'bloop') {
      if (EV.phase === 'approach' || EV.phase === 'close') { bloopCall(rig, EV.elapsed); rig.nextCall = 9; }
    }
  }

  // ---- local phase scripting when the server stays quiet ----
  function autoPhase() {
    const p = clamp(EV.elapsed / (EV.duration || 90), 0, 1);
    if (EV.type === 'kraken' && EV.rig && p > 0.5 && p < 0.9 && EV.rig.gripArm < 0 && !EV.rig.gripDone) {
      EV.rig.gripDone = true;
      beginGrip(EV.rig);
      EV.phase = 'grab';
      if (ctx.state) ctx.state.eventPhase = 'grab';
    }
  }

  // =========================================================
  // Tsunami
  // =========================================================
  function startTsunami() {
    if (TS.active) return;
    if (EV.type) hardCleanupEvent();
    TS.active = true;
    TS.elapsed = 0;
    TS.dur = Math.max(8, ECON.QUOTA_FAIL_GRACE_SECONDS || 20);
    if (!TS.rig) TS.rig = buildTsunami();
    if (!doomSky) doomSky = buildDoomSky();
    const rig = TS.rig;
    rig.root.visible = true;
    if (!rig.root.parent) scene.add(rig.root);
    rig.impacted = false; rig.impactP = 0.7;
    rig.roarIdx = 0;
    rig.boltT = 1.4; rig.flash = 0; rig.sheet = 0;
    rig.quakeT = 1.6; rig.bellIdx = 0;
    sandUniforms.uEdge.value = 0.30;
    sandUniforms.uFade.value = 0;
    wallUniforms.uHScale.value = 0.2;
    wallUniforms.uFlash.value = 0;
    wallUniforms.uSheet.value = 0;
    rig.wall.position.set(0, 0, -1500);
    rig.wall.visible = true;
    rig.flood.position.y = -10;
    rig.flood.material.opacity = 0;
    rig.floodFoam.material.opacity = 0;
    rig.rocks.material.opacity = 0;

    // hard cut to black, then open onto a dead sky. The music does not come back.
    cutMusic();
    OV.value = 1; setOverlay(0x000000, 0, 1.5, 0.35);
    doomSky.visible = true;
    doomSky.material.color.setRGB(1, 1, 1);
    setNight(true);
    rig.nightOn = true;

    sfx('tsunamiRoar', { stage: 0 });
    sfx('doomBell', { index: 0 });
    sfx('doomQuake', { stage: 0, intensity: 0.4 });
    shake(0.55, 2.5);
    swell(0.5, 0.3);
  }

  function restoreSky() {
    if (doomSky) doomSky.visible = false;
    const rig = TS.rig;
    if (rig && rig.nightOn) { setNight(false); rig.nightOn = false; }
  }

  function updateTsunami(dt, t) {
    const rig = TS.rig;
    if (!rig) { TS.active = false; return; }
    TS.elapsed += dt;
    const p = TS.elapsed / TS.dur;
    wallUniforms.uTime.value = t;
    if (doomSky && ctx.camera) doomSky.position.copy(ctx.camera.position);

    // --- the sea pulls back off the shore, first and worst ---
    const draw = smoothstep(0.0, 0.36, p);
    sandUniforms.uEdge.value = lerp(0.30, 1.0, draw);
    sandUniforms.uFade.value = p < 0.62 ? smoothstep(0.0, 0.1, p) : Math.max(0, 1 - smoothstep(0.62, 0.72, p));
    rig.rocks.material.opacity = sandUniforms.uFade.value;
    if (rig.rocks.material.opacity > 0.01) {
      rig.rocks.visible = true;
      for (let i = 0; i < rig.rockData.length; i++) {
        const rd = rig.rockData[i];
        const revealed = rd.r / SAND_R < sandUniforms.uEdge.value ? 1 : 0;
        const s = rd.s * revealed;
        _v1.set(Math.cos(rd.a) * rd.r, 0.25 + s * 0.3, Math.sin(rd.a) * rd.r);
        _v2.set(Math.cos(rd.ry), 0.2, Math.sin(rd.ry));
        orientMatrix(_m1, _v1, _v2, s, s * 0.7, s * 1.2);
        rig.rocks.setMatrixAt(i, _m1);
      }
      rig.rocks.instanceMatrix.needsUpdate = true;
    } else rig.rocks.visible = false;

    // receding foam line, chasing the water out to sea
    if (p < 0.45 && Math.random() < dt * 8) {
      const a = Math.random() * Math.PI * 2;
      const r = lerp(125, SAND_R * 0.96, draw);
      shockRing(Math.cos(a) * r, 0.3, Math.sin(a) * r, 10, 44, 1.7, 0xcfeee2, 0.4);
    }

    // --- the wall ---
    const wp = clamp((p - 0.05) / 0.9, 0, 1);
    const z = lerp(-1500, 460, Math.pow(wp, 1.35));
    rig.wall.position.z = z;
    wallUniforms.uHScale.value = lerp(0.18, 1.05, smoothstep(0.05, 0.62, p));
    rig.wall.visible = p < 0.95;
    const crestY = WALL_H * wallUniforms.uHScale.value;

    // --- lightning flickering INSIDE the wave face ---
    rig.boltT -= dt;
    if (rig.boltT <= 0 && p < 0.94) {
      rig.boltT = lerp(1.5, 0.32, p) * (0.45 + Math.random());
      wallUniforms.uFlashX.value = (Math.random() - 0.5) * WALL_W * 0.7;
      rig.flash = 1;
      rig.sheet = 0.55 + Math.random() * 0.45;
      sfx('thunder', { volume: 0.55 + p * 0.45 });
      shake(0.14 + p * 0.2, 0.35);
    }
    rig.flash = Math.max(0, rig.flash - dt * 5.0);
    rig.sheet = Math.max(0, rig.sheet - dt * 6.0);
    // strobe, not a fade: it forks and dies inside the water
    wallUniforms.uFlash.value = rig.flash * (0.25 + 0.75 * Math.random());
    wallUniforms.uSheet.value = rig.sheet * (0.4 + 0.6 * Math.random());
    if (doomSky) {
      const f = rig.sheet * 0.8;
      doomSky.material.color.setRGB(1 + f * 1.9, 1 + f * 2.4, 1 + f * 2.1);
    }

    // crest spray + rising roar
    if (p > 0.1 && p < 0.9 && Math.random() < dt * 30) {
      const x = (Math.random() - 0.5) * WALL_W * 0.6;
      emit(mist, x, crestY * 0.94, z + 60, 3, 34, 130, 0.9, 0.82, 0.95, 0.92, 3.0, 5);
    }
    if (rig.roarIdx === 0 && p > 0.3) { rig.roarIdx = 1; sfx('tsunamiRoar', { stage: 1 }); }
    if (rig.roarIdx === 1 && p > 0.55) { rig.roarIdx = 2; sfx('tsunamiRoar', { stage: 2 }); }

    // --- ground shake builds the whole way in, plus the quake bed underneath ---
    const build = smoothstep(0.1, 0.72, p);
    shake(0.16 + build * 0.95, 0.7);
    swell(0.25 + build * 0.85, 0.28 + build * 0.3);
    rig.quakeT -= dt;
    if (rig.quakeT <= 0) {
      rig.quakeT = lerp(3.4, 1.1, p);
      sfx('doomQuake', { stage: rig.roarIdx, intensity: 0.35 + build * 0.65 });
    }
    if (rig.bellIdx === 0 && p > 0.26) { rig.bellIdx = 1; sfx('doomBell', { index: 1 }); }
    if (rig.bellIdx === 1 && p > 0.5) { rig.bellIdx = 2; sfx('doomBell', { index: 2 }); }

    // --- impact ---
    if (!rig.impacted && z > -165) {
      rig.impacted = true;
      rig.impactP = p;
      sfx('tsunamiImpact', {});
      sfx('doomQuake', { stage: 9, intensity: 1 });
      shake(1.2, 3.4);
      swell(1.4, 0.5);
      // a bright wash you can still see the island drown through — the full
      // white-out is held back for the last beat
      setOverlay(0xf2fbff, 0.62, 2.4);
      for (let i = 0; i < 12; i++) {
        const a = -Math.PI * 0.5 + (i / 11 - 0.5) * Math.PI * 1.5;
        const x = Math.cos(a) * 145, zz = Math.sin(a) * 145;
        waterSplash(x, 0, zz, 6);
        emit(mist, x, 24, zz, 8, 46, 90, 1.3, 0.88, 0.98, 0.95, 3.4, 7);
        shockRing(x, 0.4, zz, 8, 220, 2.8, 0xe8fff6, 0.55);
      }
    }

    // --- the island goes under ---
    if (rig.impacted) {
      if (p > 0.88 && OV.target < 1) setOverlay(0xf2fbff, 1.0, 2.2);
      const q = clamp((p - rig.impactP) / Math.max(0.08, 0.96 - rig.impactP), 0, 1);
      const fa = smoothstep(0, 0.25, q) * (1 - smoothstep(0.85, 1.0, q) * 0.35);
      rig.flood.material.opacity = 0.9 * fa;
      rig.floodFoam.material.opacity = 0.75 * fa;
      rig.flood.position.y = lerp(-10, 46, Math.pow(q, 0.7));
      rig.floodFoam.position.y = rig.flood.position.y + 0.6;
      rig.flood.rotation.z = Math.sin(t * 0.6) * 0.03;
      rig.floodFoam.rotation.z = -Math.sin(t * 0.45) * 0.04;
      TEX.foam.offset.x = t * 0.06;
      TEX.foam.offset.y = -t * 0.09;
    }

    if (p >= 1) {
      // hold the white a beat, then hand the screen to the UI
      setOverlay(0xf2fbff, 0, 0.7, 0.5);
      endTsunami();
    }
  }

  function endTsunami() {
    TS.active = false;
    const rig = TS.rig;
    if (rig) {
      rig.root.visible = false;
      if (rig.root.parent) rig.root.parent.remove(rig.root);
      rig.flood.material.opacity = 0;
      rig.floodFoam.material.opacity = 0;
      rig.rocks.visible = false;
    }
    sandUniforms.uFade.value = 0;
    wallUniforms.uFlash.value = 0;
    wallUniforms.uSheet.value = 0;
    if (doomSky) doomSky.material.color.setRGB(1, 1, 1);
    killRings();
    killParticles(foam);
    killParticles(mist);
  }

  // =========================================================
  // Wiring
  // =========================================================
  const bus = ctx.bus;
  if (bus && bus.on) {
    bus.on('eventStart', (d) => { if (d && d.type) startEvent(d.type); });
    bus.on('eventEnd', (d) => { if (!EV.type) return; if (d && d.type && d.type !== EV.type) return; endEvent(d); });
    bus.on('tsunami', () => startTsunami());
    bus.on('phase', (ph) => {
      if (ph === 'playing') { restoreSky(); return; }
      if (EV.type) hardCleanupEvent();
      if (TS.active && ph !== 'over') { endTsunami(); setOverlay(0x000000, 0, 3); }
      if (ph === 'menu' || ph === 'lobby') {
        killParticles(spray); killParticles(foam); killParticles(mist);
        setOverlay(0x000000, 0, 4);
        restoreSky();
        clearShake();
      }
    });
    bus.on('worldState', (w) => { if (w && typeof w.day === 'number') EV.day = w.day; });
  }
  if (ctx.net && ctx.net.on) {
    // belt and braces: the state machine guards against double starts
    ctx.net.on(MSG.EVENT_START, (d) => { if (d && d.type) startEvent(d.type); });
    ctx.net.on(MSG.EVENT_PHASE, (d) => onEventPhase(d));
    ctx.net.on(MSG.EVENT_END, (d) => { if (EV.type) endEvent(d); });
    ctx.net.on(MSG.TSUNAMI, () => startTsunami());
  }

  // =========================================================
  // Frame update — runs AFTER player.js, so the shake sticks
  // =========================================================
  function update(dt, t) {
    if (!(dt > 0)) dt = 0.0001;

    if (EV.type) {
      updateAnchor(dt, false);
      EV.elapsed += dt;   // keeps running through the departure so it swims away
      if (!EV.ending) {
        // 2.5 s of pure silence, then the dread starts
        EV.droneT += dt;
        if (!EV.dronePlayed && EV.droneT > 2.5) {
          EV.dronePlayed = true;
          // deeper the further into the run you are
          sfx('eventDrone', { type: EV.type, day: EV.day, depth: clamp(EV.day / 14, 0, 1) });
        }
        if (EV.dronePlayed) {
          const prox = EV.type === 'bloop' && EV.rig
            ? clamp(EV.rig.prox, 0, 1)
            : clamp(EV.elapsed / (EV.duration || 90), 0, 1);
          EV.heartT -= dt;
          if (EV.heartT <= 0) {
            sfx('heartbeat', { type: EV.type, intensity: prox });
            EV.heartT = lerp(1.35, 0.62, prox);
          }
        }
        autoPhase();
      } else {
        EV.endT += dt;
        if (EV.endT > 1.4 && EV.nightOn) { setNight(false); EV.nightOn = false; }
        if (EV.endT > EV.endDur) { hardCleanupEvent(); }
      }

      const rig = EV.rig;
      if (rig && EV.type) {
        if (EV.type === 'serpent') updateSerpent(rig, dt, t);
        else if (EV.type === 'kraken') updateKraken(rig, dt, t);
        else if (EV.type === 'bloop') updateBloop(rig, dt, t);
      }
    }

    if (TS.active) updateTsunami(dt, t);

    updateRings(dt);
    updateParticles(spray, dt);
    updateParticles(foam, dt);
    updateParticles(mist, dt);

    applyShake(dt, t);   // camera offset, last of all
    updateOverlay(dt);   // glued to the (already shaken) camera
  }

  return {
    update,
    shake,
    swell,
    isEventActive() { return !!EV.type; },
    isTsunamiActive() { return TS.active; },
  };
}
