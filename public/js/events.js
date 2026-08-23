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
const SERPENT_SEGMENTS = 30;
const SERPENT_LENGTH   = 60;   // metres, nose to tail
const SERPENT_R_START  = 42;   // circling radius at event start
const SERPENT_R_END    = 20;   // circling radius at the very end
const SERPENT_HEAD_LEN = 13;

const KRAKEN_ARMS      = 7;
const ARM_SEGMENTS     = 15;
const ARM_LENGTH       = 46;
const KRAKEN_MANTLE    = 30;

const BLOOP_LENGTH     = 150;
const BLOOP_FAR        = 600;
const BLOOP_NEAR       = 80;

const SHAKE_MAX_OFFSET = 0.62;  // metres at trauma 1
const SHAKE_MAX_ROLL   = 0.055; // radians at trauma 1

const RING_POOL        = 16;

// ---------------- scratch (module-level, never reallocated) ----------------
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _fw = new THREE.Vector3();
const _rt = new THREE.Vector3();
const _up = new THREE.Vector3();
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
  };
  // orient the tube-ish geometries so their long axis is +Z (matches orientMatrix)
  GEO.arm.rotateX(Math.PI / 2);
  GEO.tooth.rotateX(Math.PI / 2);
  GEO.frill.rotateX(Math.PI / 2);
  GEO.sucker.rotateX(Math.PI / 2);

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

  const spray = makeParticles(520, 1.9, TEX.soft);
  const mist  = makeParticles(300, 26, TEX.soft);

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
    const level = trauma > rumble ? trauma : rumble;
    const amp = level * level;
    if (amp < 0.0002) return;
    const nx = Math.sin(t * 37.1 + shakeSeed[0]) * 0.62 + Math.sin(t * 17.3 + shakeSeed[1]) * 0.38;
    const ny = Math.sin(t * 31.7 + shakeSeed[2]) * 0.62 + Math.sin(t * 23.9 + shakeSeed[3]) * 0.38;
    const nr = Math.sin(t * 21.3 + shakeSeed[4]);
    lastOffset.set(nx * amp * SHAKE_MAX_OFFSET, ny * amp * SHAKE_MAX_OFFSET * 0.8, 0)
      .applyQuaternion(cam.quaternion);
    cam.position.add(lastOffset);
    lastRoll = nr * amp * SHAKE_MAX_ROLL;
    cam.rotation.z += lastRoll;
    lastCamPos.copy(cam.position);
    lastRotZ = cam.rotation.z;
    shakeApplied = true;
  }

  function clearShake() {
    trauma = 0;
    rumble = 0;
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

  // Local-space bounds of a finished wrapper, used to hang eyes/maws on the
  // outside of a mesh whose exact silhouette we do not control.
  function measure(obj, out) {
    try {
      obj.updateMatrixWorld(true);
      out.setFromObject(obj);
      if (!out.isEmpty() && Number.isFinite(out.max.x) && Number.isFinite(out.max.z)) return true;
    } catch (e) { /* fall through */ }
    return false;
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

    // head assembly
    const head = new THREE.Group();
    const neck = spawnFish('seaserpent', SERPENT_HEAD_LEN, false);
    neck.position.z = -SERPENT_HEAD_LEN * 0.28;
    head.add(neck);

    const skull = new THREE.Mesh(GEO.blob, MAT.hide);
    skull.scale.set(2.7, 2.4, 4.6);
    skull.position.z = 2.2;
    head.add(skull);

    const brow = new THREE.Mesh(GEO.frill, MAT.serpentFrill);
    brow.scale.set(3.4, 3.4, 4.2);
    brow.position.set(0, 1.5, -1.2);
    brow.rotation.z = Math.PI;
    head.add(brow);

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
    head.add(jawTop, jawBot);

    // eyes ride just proud of the skull ellipsoid so they never sink into it
    const eyeL = glowSprite(0xbdff5a, 2.8); eyeL.position.set(2.5, 1.7, 3.4);
    const eyeR = glowSprite(0xbdff5a, 2.8); eyeR.position.set(-2.5, 1.7, 3.4);
    const maw = glowSprite(0x66ffaa, 5.0, 0.0); maw.position.set(0, 0.05, 9.0);
    head.add(eyeL, eyeR, maw);
    root.add(head);

    const light = new THREE.PointLight(0x66ffbb, 40, 320, 1.0);
    root.add(light);

    const pts = [];
    for (let i = 0; i < SERPENT_SEGMENTS; i++) pts.push(new THREE.Vector3());
    const radii = new Float32Array(SERPENT_SEGMENTS);
    for (let i = 0; i < SERPENT_SEGMENTS; i++) {
      const u = i / (SERPENT_SEGMENTS - 1);
      radii[i] = 3.8 * (0.72 + 0.5 * Math.sin(Math.pow(u, 0.6) * Math.PI)) * (1 - 0.78 * Math.pow(u, 2.1));
    }

    return {
      root, body, frill, glow, head, neck, jawTop, jawBot, maw, eyeL, eyeR, light,
      pts, radii, prevY: new Float32Array(SERPENT_SEGMENTS),
      spacing: SERPENT_LENGTH / (SERPENT_SEGMENTS - 1),
      theta0: 0, omega: 0.2, dir: 1, undPhase: 0,
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
    const amp = 8.5 + 3 * prog;
    let y = waterY(cx, cz, t) + Math.sin(tt * 1.45 + rig.undPhase) * amp - 2.5;
    out.set(cx, y, cz);

    const L = rig.lunge;
    if (L) {
      const u = clamp((tt - L.start) / L.dur, 0, 1);
      const w = bump(clamp((tt - L.start) / L.dur, 0, 1));
      if (w > 0.001) {
        _v3.copy(L.from).lerp(L.to, u);
        const arc = Math.pow(bump(u), 1.25);
        _v3.y = waterY(_v3.x, _v3.z, t) + arc * 17 - (1 - arc) * 11;
        out.lerp(_v3, w);
      }
    }
    return out;
  }

  function startLunge(rig) {
    const L = rig.lunge = { start: EV.elapsed, dur: 2.6, hit: false, breach: false, dive: false };
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
    _v4.copy(_v1).addScaledVector(_v2, 11);
    L.from = _v4.clone().addScaledVector(_v3, -52);
    L.to = _v4.clone().addScaledVector(_v3, 52);
    L.bow = _v4.clone();
    sfx('serpentRoar', { type: 'serpent', index: rig.lungeIdx++ });
    shake(0.35, 1.2);
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
      head.y -= Math.pow(k, 1.6) * 70;
    }
    for (let i = 1; i < SERPENT_SEGMENTS; i++) {
      const p = rig.pts[i];
      serpentPath(rig, EV.elapsed - i * lag, p, t);
      if (EV.ending) p.y -= Math.pow(clamp((EV.endT - i * 0.06) / 3.2, 0, 1), 1.6) * 70;
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
        waterSplash(p.x, wy, p.z, 3.2 + r * 0.5);
        emit(spray, p.x, wy, p.z, 14, 9, r * 1.4, 1.1, 0.62, 0.78, 0.86, 1.1);
        shockRing(p.x, wy, p.z, r * 0.8, r * 4.2, 1.5, 0x9fd8ff, 0.35);
        rig.splashCd = 0.22;
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
    rig.head.position.copy(rig.pts[0]).addScaledVector(_v2.normalize(), 3.0);
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
        waterSplash(rig.head.position.x, waterY(rig.head.position.x, rig.head.position.z, t), rig.head.position.z, 14);
        emit(spray, rig.head.position.x, 0, rig.head.position.z, 70, 20, 7, 1.4, 0.72, 0.86, 0.95, 1.7);
        shockRing(rig.head.position.x, 0, rig.head.position.z, 3, 44, 2.0, 0xbfe6ff, 0.7);
        shake(0.75, 1.6);
      }
      if (!L.dive && u > 0.9) {
        L.dive = true;
        waterSplash(rig.head.position.x, waterY(rig.head.position.x, rig.head.position.z, t), rig.head.position.z, 16);
        emit(spray, rig.head.position.x, 0, rig.head.position.z, 80, 22, 8, 1.5, 0.78, 0.9, 1.0, 1.9);
        shake(0.55, 1.4);
      }
      // one damage window per lunge, within 8 m of the local player
      if (!L.hit && u > 0.25 && u < 0.85 && getLocalPos(_v4)) {
        if (_v4.distanceTo(rig.head.position) < 8) {
          L.hit = true;
          damageLocal(15, 'serpent');
          shake(0.95, 1.1);
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

    const dome = new THREE.Mesh(GEO.blob, MAT.krakenDome);
    dome.scale.set(15, 10.5, 17);
    dome.position.y = 2.0;
    body.add(dome);

    // outside the dome ellipsoid, at the waterline once the mantle is staged
    const eyeL = glowSprite(0xd08cff, 7.5); eyeL.position.set(10.6, 8.6, 13.5);
    const eyeR = glowSprite(0xd08cff, 7.5); eyeR.position.set(-10.6, 8.6, 13.5);
    body.add(eyeL, eyeR);

    const arms = new THREE.InstancedMesh(GEO.arm, MAT.krakenFlesh, KRAKEN_ARMS * ARM_SEGMENTS);
    arms.frustumCulled = false;
    const suckers = new THREE.InstancedMesh(GEO.sucker, MAT.krakenSucker, KRAKEN_ARMS * (ARM_SEGMENTS - 1));
    suckers.frustumCulled = false;
    root.add(arms, suckers);

    const light = new THREE.PointLight(0xb066ff, 45, 340, 1.0);
    light.position.y = 6;
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

  function armCurve(rig, arm, t) {
    const baseR = 12.5;
    arm.p0.set(
      rig.body.position.x + Math.cos(arm.baseAng) * baseR,
      rig.body.position.y + 1.5,
      rig.body.position.z + Math.sin(arm.baseAng) * baseR
    );
    _v1.subVectors(arm.target, arm.p0); _v1.y = 0;
    const flat = Math.max(1, _v1.length());
    _v1.multiplyScalar(1 / flat);
    const h = arm.h;
    arm.p1.copy(arm.p0).addScaledVector(_v1, flat * 0.25).setY(arm.p0.y + h * 0.75 + 4);
    arm.p2.copy(arm.target).addScaledVector(_v1, -flat * 0.12).setY(arm.p0.y + h * 1.05 + 6);
    arm.p3.copy(arm.target).setY(arm.target.y + h * 0.72);

    const sway = 1 + arm.flinch * 2.5;
    for (let i = 0; i < ARM_SEGMENTS; i++) {
      const u = i / (ARM_SEGMENTS - 1);
      const p = arm.pts[i];
      bez3(arm.p0, arm.p1, arm.p2, arm.p3, u, p);
      const s = Math.sin(t * 1.7 + arm.phase + u * 4.2) * u * 1.9 * sway;
      const s2 = Math.cos(t * 2.3 + arm.phase * 1.7 + u * 5.1) * u * 1.5 * sway;
      p.x += s; p.z += s2;
      p.y += Math.sin(t * 2.1 + arm.phase + u * 3.3) * u * 1.1 * sway;
    }
    if (rig.gripArm >= 0 && rig.armData[rig.gripArm] === arm) {
      // wrap the last third of the arm around the boat in a slow helix
      if (getBoatPos(_v2)) {
        for (let i = 9; i < ARM_SEGMENTS; i++) {
          const k = (i - 9) / (ARM_SEGMENTS - 1 - 9);
          const ang = arm.baseAng + k * 4.4 + t * 0.55;
          const rr = lerp(6.5, 3.4, k);
          _v3.set(_v2.x + Math.cos(ang) * rr, _v2.y + 0.4 + k * 2.6 + Math.sin(t * 6 + k * 3) * 0.25,
                  _v2.z + Math.sin(ang) * rr);
          arm.pts[i].lerp(_v3, smooth01(k * 1.15));
        }
      }
    }
  }

  function updateKraken(rig, dt, t) {
    const dur = EV.duration || 100;
    const wy = waterY(EV.center.x, EV.center.z, t);
    rig.body.position.set(EV.center.x, wy - 8.5 + Math.sin(t * 0.5 + rig.bobPhase) * 0.9, EV.center.z);
    _v1.copy(EV.focus).sub(rig.body.position); _v1.y = 0;
    if (_v1.lengthSq() > 1e-4) rig.body.rotation.y = Math.atan2(_v1.x, _v1.z);
    if (EV.ending) rig.body.position.y -= Math.pow(clamp(EV.endT / 4.5, 0, 1), 1.7) * 46;
    animateFish(rig.mantle, t);
    const eyeP = 0.6 + 0.4 * Math.abs(Math.sin(t * 1.15));
    rig.eyeL.material.opacity = rig.eyeR.material.opacity = eyeP * (EV.ending ? clamp(1 - EV.endT / 3, 0, 1) : 1);

    // grip timer
    if (rig.gripArm >= 0) {
      rig.gripT -= dt;
      shake(0.16 + 0.05 * Math.sin(t * 9), 0.5);
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
        arm.hTarget = 26;
        if (getBoatPos(_v2)) arm.target.copy(_v2);
      } else {
        switch (arm.state) {
          case 'idle':
            arm.hTarget = -6 + Math.sin(t * 0.8 + arm.phase) * 2.5;
            if (!arm.targetSet) { pickIdleTarget(arm, t); }
            break;
          case 'telegraph':
            arm.hTarget = 34;
            if (arm.st > 1.9) { arm.state = 'slam'; arm.st = 0; }
            break;
          case 'slam':
            arm.hTarget = -14;
            if (!arm.slammed && arm.st > 0.16) {
              arm.slammed = true;
              const tip = arm.pts[ARM_SEGMENTS - 1];
              const ty = waterY(tip.x, tip.z, t);
              waterSplash(tip.x, ty, tip.z, 12);
              emit(spray, tip.x, ty, tip.z, 60, 19, 6, 1.35, 0.7, 0.82, 0.92, 1.6);
              shockRing(tip.x, ty, tip.z, 4, 52, 2.1, 0xc8b0ff, 0.7);
              sfx('krakenSlam', { type: 'kraken' });
              if (getLocalPos(_v4)) {
                _v4.y = ty;
                _v3.set(tip.x, ty, tip.z);
                const d = _v4.distanceTo(_v3);
                if (d < 10) { damageLocal(22, 'kraken'); shake(1.1, 1.2); }
                else shake(0.25 + 0.6 * clamp(1 - d / 90, 0, 1), 1.0);
              } else shake(0.5, 1.0);
            }
            if (arm.st > 1.1) { arm.state = 'recover'; arm.st = 0; }
            break;
          default: // recover
            arm.hTarget = -7;
            if (arm.st > 2.2) { arm.state = 'idle'; arm.st = 0; arm.targetSet = false; }
            break;
        }
      }
      if (EV.ending) arm.hTarget = -30 - a * 5;
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
        const s = lerp(6, 15, f);
        arm.shadow.scale.set(s, s, 1);
        arm.shadow.material.opacity = 0.55 * f;
      }

      // write instance matrices
      const baseR = 2.9, tipR = 0.35;
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
    rig.light.position.set(0, 6 + Math.sin(t) * 2, 0);

    // "FIGHT IT OFF": swinging a weapon near a raised arm makes it recoil (pure flavour)
    rig.attackCd -= dt;
    const st = ctx.state;
    if (!EV.ending && rig.attackCd <= 0 && ctx.input && ctx.input.mouseDown &&
        st && st.activeTool === 'weapon' && getLocalPos(_v4)) {
      let best = -1, bestD = 15;
      for (let a = 0; a < rig.armData.length; a++) {
        const arm = rig.armData[a];
        if (arm.h < 2 && rig.gripArm !== a) continue;
        for (let i = 6; i < ARM_SEGMENTS; i += 2) {
          const d = _v4.distanceTo(arm.pts[i]);
          if (d < bestD) { bestD = d; best = a; }
        }
      }
      if (best >= 0) {
        const arm = rig.armData[best];
        arm.flinch = 1;
        arm.h -= 4.5;
        rig.attackCd = 0.32;
        const p = arm.pts[ARM_SEGMENTS - 3];
        emit(spray, p.x, p.y, p.z, 16, 8, 1.6, 0.7, 0.85, 0.35, 0.75, 0.8, 9);
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
    const r = 18 + Math.random() * 14;
    arm.target.set(EV.center.x + Math.cos(ang) * r, waterY(0, 0, t) - 4, EV.center.z + Math.sin(ang) * r);
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
    out.x += (Math.random() - 0.5) * 14;
    out.z += (Math.random() - 0.5) * 14;
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
    shake(0.9, 1.4);
    if (getBoatPos(_v1)) {
      waterSplash(_v1.x, waterY(_v1.x, _v1.z, 0), _v1.z, 10);
      shockRing(_v1.x, waterY(_v1.x, _v1.z, 0), _v1.z, 4, 40, 2.0, 0xc8a0ff, 0.75);
    }
  }

  // =========================================================
  // THE BLOOP
  // =========================================================
  function buildBloop() {
    const root = new THREE.Group();
    root.visible = false;

    const body = spawnFish('bloopcalf', BLOOP_LENGTH, true);
    root.add(body);

    // hang the face off the measured hull so nothing ends up buried inside it
    const bb = new THREE.Box3();
    const half = BLOOP_LENGTH * 0.5;
    let fx = half * 0.3, fy = half * 0.42, fz = half * 0.86;
    if (measure(body, bb)) {
      fx = Math.max(6, bb.max.x * 0.55);
      fy = Math.max(8, bb.max.y * 0.8);   // high on the brow: the eyes clear the water first
      fz = bb.max.z * 0.9;
    }

    const eyeL = glowSprite(0xff2418, 26, 0.9); eyeL.position.set(fx, fy, fz);
    const eyeR = glowSprite(0xff2418, 26, 0.9); eyeR.position.set(-fx, fy, fz);
    root.add(eyeL, eyeR);

    // maw: a ring of teeth around a hot throat
    const maw = new THREE.Group();
    maw.position.set(0, fy * 0.1, fz + 8);
    const throat = glowSprite(0xff1408, 46, 0.0);
    maw.add(throat);
    const teeth = new THREE.InstancedMesh(GEO.tooth, MAT.silhouette, 26);
    teeth.frustumCulled = false;
    maw.add(teeth);
    maw.scale.setScalar(0.001);
    root.add(maw);

    // rim halo so the silhouette never disappears completely against a black sky
    const halo = glowSprite(0x2a0a12, 210, 0.35);
    halo.position.set(0, fy * 0.4, -half * 0.25);
    halo.renderOrder = -1;
    root.add(halo);

    return { root, body, eyeL, eyeR, maw, throat, teeth, halo, dist: BLOOP_FAR, callIdx: 0, nextCall: 6, mawOpen: 0, dmgCd: 0 };
  }

  function layoutMawTeeth(rig, open) {
    const n = 26;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = 20 + open * 4;
      const tilt = lerp(0.85, 0.25, open);
      _v1.set(Math.cos(a) * r, Math.sin(a) * r, -4);
      _v2.set(-Math.cos(a) * tilt, -Math.sin(a) * tilt, 1).normalize();
      orientMatrix(_m1, _v1, _v2, 2.4, 2.4, 11);
      rig.teeth.setMatrixAt(i, _m1);
    }
    rig.teeth.instanceMatrix.needsUpdate = true;
  }

  function updateBloop(rig, dt, t) {
    const dur = EV.duration || 110;
    const p = clamp(EV.elapsed / dur, 0, 1);
    const targetDist = EV.ending
      ? lerp(BLOOP_NEAR, 1100, smooth01(EV.endT / 5.0))
      : lerp(BLOOP_FAR, BLOOP_NEAR, smooth01(p) * 0.55 + p * 0.45);
    rig.dist += (targetDist - rig.dist) * expApproach(dt, 0.35);

    _v1.copy(EV.approachDir).multiplyScalar(rig.dist);
    const px = EV.center.x + _v1.x, pz = EV.center.z + _v1.z;
    const rise = EV.ending ? lerp(-6, -150, smooth01(EV.endT / 5.0)) : lerp(-34, -3, Math.pow(p, 0.8));
    rig.root.position.set(px, rise + Math.sin(t * 0.23) * 2.2, pz);
    _v2.set(EV.center.x - px, 0, EV.center.z - pz);
    rig.root.rotation.y = Math.atan2(_v2.x, _v2.z);
    rig.root.rotation.z = Math.sin(t * 0.17) * 0.035;
    animateFish(rig.body, t);

    const near = 1 - clamp((rig.dist - BLOOP_NEAR) / (BLOOP_FAR - BLOOP_NEAR), 0, 1);
    const eyeA = (0.55 + 0.45 * Math.abs(Math.sin(t * 0.55))) * (EV.ending ? clamp(1 - EV.endT / 4, 0, 1) : 1);
    rig.eyeL.material.opacity = rig.eyeR.material.opacity = eyeA;
    rig.eyeL.scale.setScalar(20 + near * 14 + Math.sin(t * 1.9) * 1.5);
    rig.eyeR.scale.copy(rig.eyeL.scale);
    rig.halo.material.opacity = 0.18 + near * 0.3;

    // the maw opens at the closest approach
    const wantOpen = (!EV.ending && p > 0.8) ? clamp((p - 0.8) / 0.16, 0, 1) : 0;
    rig.mawOpen += (wantOpen - rig.mawOpen) * expApproach(dt, 0.25);
    if (rig.mawOpen > 0.01) {
      rig.maw.visible = true;
      rig.maw.scale.setScalar(0.35 + rig.mawOpen * 0.9);
      rig.throat.material.opacity = rig.mawOpen * (0.5 + 0.5 * Math.abs(Math.sin(t * 2.4)));
      rig.throat.scale.setScalar(30 + rig.mawOpen * 30);
      layoutMawTeeth(rig, rig.mawOpen);
    } else rig.maw.visible = false;

    // the call — approaches announce themselves
    if (!EV.ending) {
      rig.nextCall -= dt;
      if (rig.nextCall <= 0) { bloopCall(rig, t); rig.nextCall = lerp(15, 7, p); }
    }

    // constant low water vibration, stronger as it closes
    if (Math.random() < dt * (0.7 + near * 2.6)) {
      const a = Math.random() * Math.PI * 2, r = 20 + Math.random() * 70;
      const x = EV.focus.x + Math.cos(a) * r, z = EV.focus.z + Math.sin(a) * r;
      shockRing(x, waterY(x, z, t), z, 0.6, 6 + near * 12, 1.8, 0x8fb8d8, 0.16 + near * 0.2);
    }
    shake(0.045 + near * 0.1, 0.4);

    // it only hurts you if you swim to it
    rig.dmgCd -= dt;
    if (!EV.ending && rig.dmgCd <= 0 && localIsSwimming() && getLocalPos(_v3)) {
      const d = _v3.distanceTo(rig.root.position);
      if (d < BLOOP_LENGTH * 0.55) {
        rig.dmgCd = 2.0;
        damageLocal(d < BLOOP_LENGTH * 0.3 ? 45 : 25, 'bloop');
        shake(1.0, 1.0);
        sfx('bloopMaw', { type: 'bloop' });
      }
    }
  }

  function bloopCall(rig, t) {
    const p = clamp(EV.elapsed / (EV.duration || 110), 0, 1);
    sfx('bloopCall', { type: 'bloop', index: rig.callIdx++, volume: 0.35 + p * 0.65, distance: rig.dist });
    shake(0.2 + p * 0.45, 2.2);
    for (let i = 0; i < 4; i++) {
      const rr = 30 + i * 45;
      shockRing(EV.focus.x, waterY(EV.focus.x, EV.focus.z, t), EV.focus.z, rr * 0.25, rr, 2.6 + i * 0.4, 0x9fd0ff, 0.28);
    }
    if (getLocalPos(_v1)) {
      emit(spray, _v1.x, waterY(_v1.x, _v1.z, t), _v1.z, 26, 5, 12, 1.0, 0.55, 0.7, 0.85, 1.4);
    }
  }

  // =========================================================
  // THE TSUNAMI
  // =========================================================
  const WALL_H = 80;   // metres at full height; the shader scales from this
  const wallUniforms = { uTime: { value: 0 }, uHScale: { value: 0.2 } };
  const sandUniforms = { uEdge: { value: 0.36 }, uFade: { value: 0 } };

  // Built at full height so computeVertexNormals gives the real, near-vertical
  // face normals; uHScale only squashes it while the wave is still rising.
  function buildWallGeometry() {
    const NX = 76, NY = 15;
    const count = NX * NY;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const av = new Float32Array(count);
    const idx = new Uint16Array((NX - 1) * (NY - 1) * 6);
    const deep = new THREE.Color(0x061c28), mid = new THREE.Color(0x0d4a63), foam = new THREE.Color(0xd8f0fa);
    const c = new THREE.Color();
    let k = 0;
    for (let j = 0; j < NY; j++) {
      const v = j / (NY - 1);
      for (let i = 0; i < NX; i++, k++) {
        const u = i / (NX - 1);
        const x = (u - 0.5) * 1560;
        const edge = Math.abs(u - 0.5) * 2;
        const bow = 1 - 0.32 * Math.pow(edge, 2.3);
        const y = (-0.12 + Math.pow(v, 0.92) * 1.12) * bow * (1 + 0.06 * Math.sin(x * 0.011)) * WALL_H;
        const curl = smoothstep(0.55, 1.0, v);
        let z = (-0.2 * v * v + curl * curl * 0.44) * 58;
        z -= Math.pow(edge, 2) * 250;
        z += Math.sin(x * 0.0075) * 26;
        pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
        av[k] = v;
        if (v < 0.72) c.copy(deep).lerp(mid, Math.pow(v / 0.72, 0.8));
        else c.copy(mid).lerp(foam, smoothstep(0.72, 1.0, v));
        const n = 0.92 + 0.16 * Math.sin(x * 0.05 + v * 9.0);
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
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, WALL_H * 0.5, 0), 1500);
    return geo;
  }

  function buildTsunami() {
    const root = new THREE.Group();
    root.visible = false;

    // --- the wall ---
    const wallMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.38, metalness: 0.0, side: THREE.DoubleSide,
      fog: false, emissive: 0x0a2c3c, emissiveIntensity: 0.75,
    });
    wallMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = wallUniforms.uTime;
      shader.uniforms.uHScale = wallUniforms.uHScale;
      shader.vertexShader = 'uniform float uTime;\nuniform float uHScale;\nattribute float aV;\nvarying float vWv;\nvarying float vWx;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', [
        '#include <begin_vertex>',
        'float wv = aV;',
        'transformed.y = position.y * uHScale;',
        'float rip = sin(position.x * 0.011 + uTime * 1.7) * 1.0 + sin(position.x * 0.031 - uTime * 2.6) * 0.55;',
        'transformed.y += rip * wv * wv * 5.0;',
        'transformed.z += sin(position.x * 0.008 + uTime * 1.15) * wv * 11.0;',
        'transformed.x += sin(aV * 3.0 + uTime * 0.9) * wv * 3.5;',
        'vWv = wv; vWx = position.x;',
      ].join('\n'));
      shader.fragmentShader = 'uniform float uTime;\nvarying float vWv;\nvarying float vWx;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('vec4 diffuseColor = vec4( diffuse, opacity );', [
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        'float fo = smoothstep(0.66, 1.0, vWv);',
        'float streak = pow(sin(vWx * 0.085 + uTime * 3.0) * 0.5 + 0.5, 2.0);',
        'fo = clamp(fo + streak * smoothstep(0.34, 0.92, vWv) * 0.38, 0.0, 1.0);',
        'diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.90, 0.97, 1.0), fo * 0.92);',
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
    const sand = new THREE.Mesh(new THREE.RingGeometry(0.32, 1, 96, 8), sandMat);
    sand.rotation.x = -Math.PI / 2;
    sand.position.y = 0.45;
    sand.scale.setScalar(300);
    sand.renderOrder = 1;
    root.add(sand);

    const rocks = new THREE.InstancedMesh(GEO.rock, new THREE.MeshStandardMaterial({
      color: 0x4a4438, roughness: 1, flatShading: true, transparent: true, opacity: 1,
    }), 34);
    rocks.frustumCulled = false;
    const rockData = [];
    for (let i = 0; i < 34; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 105 + Math.random() * 150;
      rockData.push({ a, r, s: 1.2 + Math.random() * 3.4, ry: Math.random() * 6 });
    }
    root.add(rocks);

    // --- flood dome that swallows the island ---
    const floodGeo = new THREE.CircleGeometry(280, 72);
    (function domeIt() {
      const p = floodGeo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i);
        const r = Math.sqrt(x * x + y * y) / 280;
        p.setZ(i, (1 - r * r) * 9);
      }
      p.needsUpdate = true;
      floodGeo.computeVertexNormals();
    })();
    const flood = new THREE.Mesh(floodGeo, new THREE.MeshStandardMaterial({
      color: 0x0e3a4c, transparent: true, opacity: 0, roughness: 0.35,
      emissive: 0x0a2c3c, emissiveIntensity: 0.8, depthWrite: false, side: THREE.DoubleSide, fog: false,
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

    return { root, wall, sand, sandMat, rocks, rockData, flood, floodFoam, roarIdx: 0, impacted: false };
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
        rig.dist = BLOOP_FAR + 60;
        rig.callIdx = 0; rig.nextCall = 5; rig.mawOpen = 0; rig.dmgCd = 0;
        rig.maw.visible = false;
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
    shake(0.5, 1.6);
    // one last enormous displacement as it goes
    if (EV.rig) {
      const p = EV.type === 'bloop' ? EV.rig.root.position : EV.center;
      waterSplash(p.x, waterY(p.x, p.z, 0), p.z, 18);
      shockRing(p.x, waterY(p.x, p.z, 0), p.z, 6, 90, 3.0, 0xa8d8ff, 0.6);
      emit(spray, p.x, 0, p.z, 90, 18, 12, 1.3, 0.7, 0.84, 0.94, 2.1);
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
    const rig = TS.rig;
    rig.root.visible = true;
    if (!rig.root.parent) scene.add(rig.root);
    rig.impacted = false;
    rig.roarIdx = 0;
    sandUniforms.uEdge.value = 0.34;
    sandUniforms.uFade.value = 0;
    wallUniforms.uHScale.value = 0.2;
    rig.wall.position.set(0, 0, -900);
    rig.wall.visible = true;
    rig.flood.position.y = -8;
    rig.flood.material.opacity = 0;
    rig.floodFoam.material.opacity = 0;
    rig.rocks.material.opacity = 0;
    cutMusic();
    sfx('tsunamiRoar', { stage: 0 });
    shake(0.2, 2.5);
  }

  function updateTsunami(dt, t) {
    const rig = TS.rig;
    if (!rig) { TS.active = false; return; }
    TS.elapsed += dt;
    const p = TS.elapsed / TS.dur;
    wallUniforms.uTime.value = t;

    // --- the sea pulls back ---
    const draw = smoothstep(0.0, 0.34, p);
    sandUniforms.uEdge.value = lerp(0.34, 1.0, draw);
    sandUniforms.uFade.value = p < 0.62 ? smoothstep(0.0, 0.1, p) : Math.max(0, 1 - smoothstep(0.62, 0.72, p));
    rig.rocks.material.opacity = sandUniforms.uFade.value;
    if (rig.rocks.material.opacity > 0.01) {
      rig.rocks.visible = true;
      for (let i = 0; i < rig.rockData.length; i++) {
        const rd = rig.rockData[i];
        const revealed = rd.r / 300 < sandUniforms.uEdge.value ? 1 : 0;
        const s = rd.s * revealed;
        _v1.set(Math.cos(rd.a) * rd.r, 0.25 + s * 0.3, Math.sin(rd.a) * rd.r);
        _v2.set(Math.cos(rd.ry), 0.2, Math.sin(rd.ry));
        orientMatrix(_m1, _v1, _v2, s, s * 0.7, s * 1.2);
        rig.rocks.setMatrixAt(i, _m1);
      }
      rig.rocks.instanceMatrix.needsUpdate = true;
    } else rig.rocks.visible = false;

    // receding foam line
    if (p < 0.4 && Math.random() < dt * 6) {
      const a = Math.random() * Math.PI * 2;
      const r = lerp(110, 290, draw);
      shockRing(Math.cos(a) * r, 0.3, Math.sin(a) * r, 8, 30, 1.6, 0xdff2ff, 0.4);
    }

    // --- the wall ---
    const wp = clamp((p - 0.05) / 0.9, 0, 1);
    const z = lerp(-900, 420, Math.pow(wp, 1.35));
    rig.wall.position.z = z;
    wallUniforms.uHScale.value = lerp(0.2, 1.05, smoothstep(0.05, 0.62, p));
    rig.wall.visible = p < 0.95;

    // crest spray + rising roar
    if (p > 0.12 && p < 0.9 && Math.random() < dt * 24) {
      const x = (Math.random() - 0.5) * 900;
      emit(mist, x, WALL_H * wallUniforms.uHScale.value * 0.92, z + 24, 3, 16, 40, 0.9, 0.85, 0.93, 1.0, 2.6, 6);
    }
    if (rig.roarIdx === 0 && p > 0.3) { rig.roarIdx = 1; sfx('tsunamiRoar', { stage: 1 }); }
    if (rig.roarIdx === 1 && p > 0.55) { rig.roarIdx = 2; sfx('tsunamiRoar', { stage: 2 }); }
    shake(0.12 + smoothstep(0.15, 0.66, p) * 0.85, 0.7);

    // --- impact ---
    if (!rig.impacted && z > -165) {
      rig.impacted = true;
      sfx('tsunamiImpact', {});
      shake(1.2, 3.4);
      setOverlay(0xf2fbff, 1.0, 1.9);
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI * 0.5 + (i / 9 - 0.5) * Math.PI * 1.4;
        const x = Math.cos(a) * 135, zz = Math.sin(a) * 135;
        waterSplash(x, 0, zz, 20);
        emit(mist, x, 12, zz, 8, 26, 30, 1.3, 0.9, 0.96, 1.0, 3.0, 7);
        shockRing(x, 0.4, zz, 6, 120, 2.6, 0xffffff, 0.55);
      }
    }

    // --- the island goes under ---
    if (rig.impacted) {
      const q = clamp((p - 0.62) / 0.26, 0, 1);
      const fa = smoothstep(0, 0.25, q) * (1 - smoothstep(0.85, 1.0, q) * 0.35);
      rig.flood.material.opacity = 0.9 * fa;
      rig.floodFoam.material.opacity = 0.75 * fa;
      rig.flood.position.y = lerp(-8, 34, Math.pow(q, 0.7));
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
    killRings();
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
      if (ph === 'playing') return;
      if (EV.type) hardCleanupEvent();
      if (TS.active && ph !== 'over') { endTsunami(); setOverlay(0x000000, 0, 3); }
      if (ph === 'menu' || ph === 'lobby') { killParticles(spray); killParticles(mist); setOverlay(0x000000, 0, 4); }
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
            ? 1 - clamp((EV.rig.dist - BLOOP_NEAR) / (BLOOP_FAR - BLOOP_NEAR), 0, 1)
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
    updateParticles(mist, dt);

    applyShake(dt, t);   // camera offset, last of all
    updateOverlay(dt);   // glued to the (already shaken) camera
  }

  return {
    update,
    shake,
    isEventActive() { return !!EV.type; },
    isTsunamiActive() { return TS.active; },
  };
}
