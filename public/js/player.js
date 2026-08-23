// =============================================================
// TIDEWRECK ISLAND - public/js/player.js
// Characters (procedural low-poly fisherfolk), local controller
// (walk / swim / dive / boat riding), third-person camera and
// multiplayer character sync.
//
// Exports: initPlayer(ctx) -> { update, createCharacter, local, remotes }
// =============================================================

import * as THREE from 'three';
import {
  MSG,
  PLAYER_COLORS,
  SHOP,
  AREAS,
  BASE_AIR_SECONDS,
} from '/shared/constants.js';

// ------------------------------------------------------------
// Tunables
// ------------------------------------------------------------
const WALK_SPEED = 4.8;
const RUN_SPEED = 8.4;
const SWIM_SPEED = 3.4;
const SWIM_SPRINT = 4.7;
const DIVE_SPEED = 3.2;
const GRAVITY = -22;
const JUMP_VEL = 8.6;
const GROUND_ACCEL = 34;
const AIR_ACCEL = 8;
const SWIM_ACCEL = 9;

const SWIM_DEPTH_ENTER = 1.30;   // water depth needed to start swimming
const SWIM_DEPTH_EXIT = 1.10;    // below this we stand up again
const SURFACE_OFFSET = -1.15;    // feet offset from wave surface while floating

// Water-exit vault: Space at the surface next to a climbable edge mantles you
// out of the sea onto shore, dock decking or a boat hull.
const VAULT_REACH = 0.9;         // how far ahead we probe for a ledge
const VAULT_MIN_RISE = 0.2;      // ledge must stand at least this far out
const VAULT_MAX_RISE = 1.6;      // ...and no higher than this to be grabbable
const VAULT_UP = 6.5;
const VAULT_FWD = 2.2;
const VAULT_CD = 0.6;            // cooldown between vaults
const VAULT_HOLD = 0.55;         // swimming stays suppressed this long after one
const HEAD_STAND = 1.52;         // head height above feet, standing
const HEAD_SWIM = 1.30;          // head height above "feet" anchor, swimming

const MOVE_HZ = 12;
const REMOTE_LERP = 0.12;        // seconds of interpolation buffer
const MOUSE_SENS = 0.0022;

// Skeleton metrics (metres, feet at y = 0, ~1.72 m tall with hat)
const HIP_Y = 0.76;
const SHOULDER_Y = 0.48;         // relative to hips
const SHOULDER_X = 0.235;
const HEAD_PIVOT_Y = 0.62;       // relative to hips
const LEG_X = 0.115;
const UPPER_ARM = 0.276;
const FORE_ARM = 0.26;
const THIGH_LEN = 0.33;
const SHIN_LEN = 0.30;

const ACTIONS = { cast: 1, reel: 1, cheer: 1 };

// ------------------------------------------------------------
// Small math helpers
// ------------------------------------------------------------
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};
const damp = (cur, target, lambda, dt) => cur + (target - cur) * (1 - Math.exp(-lambda * dt));
function angDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
const angDamp = (cur, target, lambda, dt) => cur + angDelta(cur, target) * (1 - Math.exp(-lambda * dt));

// Reused temporaries â€” keep per-frame allocation at zero.
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _eul = new THREE.Euler(0, 0, 0, 'YXZ');
const _col = new THREE.Color();
const _hsl = { h: 0, s: 0, l: 0 };

// ------------------------------------------------------------
// Procedural geometry helpers
// ------------------------------------------------------------
function roundedBoxGeometry(w, h, d, r, seg = 2) {
  r = Math.min(r, Math.min(w, Math.min(h, d)) * 0.5 - 1e-4);
  const g = new THREE.BoxGeometry(w, h, d, seg, seg, seg);
  const pos = g.attributes.position;
  const hw = w * 0.5 - r, hh = h * 0.5 - r, hd = d * 0.5 - r;
  for (let i = 0; i < pos.count; i++) {
    _v1.fromBufferAttribute(pos, i);
    _v2.set(clamp(_v1.x, -hw, hw), clamp(_v1.y, -hh, hh), clamp(_v1.z, -hd, hd));
    _v1.sub(_v2);
    const len = _v1.length();
    if (len > 1e-6) _v1.multiplyScalar(r / len);
    _v1.add(_v2);
    pos.setXYZ(i, _v1.x, _v1.y, _v1.z);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

let SG = null;
function sharedGeo() {
  if (SG) return SG;
  SG = {
    torso: roundedBoxGeometry(0.46, 0.46, 0.30, 0.10, 2),
    shirt: roundedBoxGeometry(0.44, 0.28, 0.29, 0.09, 2),
    collar: new THREE.CylinderGeometry(0.105, 0.115, 0.05, 10, 1),
    neck: new THREE.CylinderGeometry(0.072, 0.082, 0.10, 8, 1),
    belt: roundedBoxGeometry(0.48, 0.07, 0.33, 0.03, 1),
    bib: roundedBoxGeometry(0.24, 0.17, 0.035, 0.02, 1),
    strap: roundedBoxGeometry(0.065, 0.30, 0.04, 0.02, 1),
    creel: roundedBoxGeometry(0.26, 0.21, 0.13, 0.045, 2),
    creelLid: roundedBoxGeometry(0.27, 0.05, 0.14, 0.02, 1),
    head: roundedBoxGeometry(0.36, 0.34, 0.33, 0.095, 2),
    ear: new THREE.SphereGeometry(0.048, 7, 5),
    nose: new THREE.ConeGeometry(0.032, 0.065, 6, 1),
    face: new THREE.PlaneGeometry(0.30, 0.30),
    hairBack: roundedBoxGeometry(0.345, 0.24, 0.11, 0.045, 2),
    fringe: roundedBoxGeometry(0.33, 0.07, 0.075, 0.03, 1),
    ponytail: new THREE.CapsuleGeometry(0.055, 0.18, 2, 7),
    sleeve: new THREE.CylinderGeometry(0.082, 0.072, 0.14, 8, 1),
    upperArm: new THREE.CapsuleGeometry(0.058, 0.16, 2, 8),
    foreArm: new THREE.CapsuleGeometry(0.050, 0.16, 2, 8),
    hand: roundedBoxGeometry(0.092, 0.10, 0.082, 0.032, 2),
    thigh: new THREE.CapsuleGeometry(0.086, 0.16, 2, 8),
    shin: new THREE.CapsuleGeometry(0.068, 0.164, 2, 8),
    boot: roundedBoxGeometry(0.135, 0.10, 0.25, 0.035, 2),
    // hats
    bucketCrown: new THREE.CylinderGeometry(0.175, 0.195, 0.15, 12, 1),
    bucketBrim: new THREE.CylinderGeometry(0.30, 0.335, 0.028, 14, 1),
    beanieDome: new THREE.SphereGeometry(0.205, 12, 7, 0, Math.PI * 2, 0, Math.PI * 0.56),
    beanieCuff: new THREE.CylinderGeometry(0.212, 0.212, 0.07, 14, 1),
    pom: new THREE.SphereGeometry(0.058, 8, 6),
    strawBand: new THREE.CylinderGeometry(0.195, 0.195, 0.038, 12, 1),
    capCrown: new THREE.CylinderGeometry(0.205, 0.185, 0.10, 14, 1),
    capTop: new THREE.CylinderGeometry(0.218, 0.218, 0.022, 14, 1),
    capVisor: roundedBoxGeometry(0.27, 0.024, 0.15, 0.012, 1),
    capBadge: roundedBoxGeometry(0.065, 0.055, 0.022, 0.012, 1),
    // bandana
    bandanaCap: new THREE.SphereGeometry(0.206, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.48),
    bandanaBand: new THREE.CylinderGeometry(0.209, 0.209, 0.055, 14, 1),
    bandanaKnot: new THREE.SphereGeometry(0.062, 8, 6),
    bandanaTail: roundedBoxGeometry(0.075, 0.21, 0.032, 0.02, 1),
  };
  return SG;
}

// ------------------------------------------------------------
// Canvas textures: faces & name tags
// ------------------------------------------------------------
// Wave 3 customisation: four selectable skin tones (0 light tan .. 3 deep).
const SKIN_SET = [0xf3caa2, 0xdca777, 0xa9714b, 0x6f4630];
const SKIN_MATS = [];
function skinMaterial(idx) {
  const k = clamp(Math.round(Number(idx)) || 0, 0, SKIN_SET.length - 1);
  let m = SKIN_MATS[k];
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: SKIN_SET[k], roughness: 0.78, metalness: 0.0, flatShading: true,
    });
    SKIN_MATS[k] = m;
  }
  return m;
}
const HAIR_COLORS = [0x3a2a1e, 0x140f0c, 0x8a5a2a, 0xd8b45a, 0x6a3a24, 0x2b2b33, 0xb06a3a, 0x4a3020];
const BOOT_COLORS = [0x54402e, 0x3a2f26, 0x6a4a2e, 0x2e3a44];
const HAT_COLORS = [0x3d5468, 0xd9c9a2, 0x6d5a38, 0x2f4f48, 0x8c4a38, 0x4a4a5e, 0xc2a35e, 0x5c3a4a];
const ACCENT_COLORS = [0xf0e0c0, 0x8a5a3a, 0xe0d0a0, 0xd8b45a, 0x2f3540, 0xd0c0a0, 0x5a4030, 0xe8d8b8];

function roundRectPath(g, x, y, w, h, r) {
  const rr = Math.min(r, w * 0.5, h * 0.5);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.lineTo(x + w - rr, y);
  g.quadraticCurveTo(x + w, y, x + w, y + rr);
  g.lineTo(x + w, y + h - rr);
  g.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  g.lineTo(x + rr, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - rr);
  g.lineTo(x, y + rr);
  g.quadraticCurveTo(x, y, x + rr, y);
  g.closePath();
}

function makeFaceTexture(variant) {
  const S = 160;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, S, S);

  const ink = '#2b2028';
  const cx = S * 0.5;
  const eyeY = S * 0.40;
  const eyeDX = S * 0.185;
  const v = variant % 8;

  // ---- blush / freckles (drawn under the features) ----
  if (v === 0 || v === 2 || v === 5 || v === 7) {
    g.fillStyle = 'rgba(232,110,110,0.30)';
    for (const s of [-1, 1]) {
      g.beginPath();
      g.ellipse(cx + s * eyeDX * 1.28, eyeY + S * 0.14, S * 0.075, S * 0.048, 0, 0, Math.PI * 2);
      g.fill();
    }
  }
  if (v === 2 || v === 4) {
    g.fillStyle = 'rgba(120,72,48,0.55)';
    for (const s of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        g.beginPath();
        g.arc(cx + s * (eyeDX * 0.95 + i * 9), eyeY + S * 0.115 + (i % 2) * 7, 2.6, 0, Math.PI * 2);
        g.fill();
      }
    }
  }

  // ---- eyes ----
  g.strokeStyle = ink;
  g.fillStyle = ink;
  g.lineCap = 'round';
  const drawEye = (sx) => {
    const ex = cx + sx * eyeDX;
    if (v === 1) {                 // happy closed arcs
      g.lineWidth = 7;
      g.beginPath();
      g.arc(ex, eyeY + 6, 12, Math.PI * 1.12, Math.PI * 1.88);
      g.stroke();
      return;
    }
    if (v === 6) {                 // sleepy half-lidded
      g.beginPath();
      g.ellipse(ex, eyeY + 2, 11, 8, 0, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = ink; g.lineWidth = 7;
      g.beginPath(); g.moveTo(ex - 14, eyeY - 3); g.lineTo(ex + 14, eyeY - 1); g.stroke();
      return;
    }
    if (v === 7 && sx > 0) {       // eyepatch on the right eye
      g.fillStyle = '#20181f';
      g.beginPath(); g.ellipse(ex, eyeY, 15, 13, 0, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#20181f'; g.lineWidth = 5;
      g.beginPath(); g.moveTo(ex + 14, eyeY - 8); g.lineTo(S, eyeY - 20); g.stroke();
      g.beginPath(); g.moveTo(ex - 15, eyeY - 9); g.lineTo(0, eyeY - 26); g.stroke();
      g.fillStyle = ink;
      return;
    }
    const rw = v === 4 ? 13 : v === 3 ? 9 : 11;
    const rh = v === 4 ? 15 : v === 3 ? 12 : 13;
    g.fillStyle = ink;
    g.beginPath(); g.ellipse(ex, eyeY, rw, rh, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.92)';
    g.beginPath(); g.arc(ex - rw * 0.32, eyeY - rh * 0.34, rw * 0.34, 0, Math.PI * 2); g.fill();
    g.fillStyle = ink;
  };
  drawEye(-1);
  drawEye(1);

  // ---- brows ----
  if (v !== 1) {
    g.lineWidth = 6;
    g.strokeStyle = ink;
    const tilt = v === 3 ? 8 : v === 6 ? -2 : 4;
    for (const s of [-1, 1]) {
      const ex = cx + s * eyeDX;
      g.beginPath();
      g.moveTo(ex - s * 14, eyeY - 24 + tilt * 0.5);
      g.lineTo(ex + s * 14, eyeY - 24 - tilt * 0.5);
      g.stroke();
    }
  }

  // ---- mouth ----
  g.strokeStyle = ink;
  g.lineWidth = 7;
  const my = S * 0.70;
  if (v === 4) {                    // open happy grin
    g.fillStyle = ink;
    g.beginPath();
    g.moveTo(cx - 24, my - 6);
    g.quadraticCurveTo(cx, my + 26, cx + 24, my - 6);
    g.closePath();
    g.fill();
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.moveTo(cx - 19, my - 4);
    g.lineTo(cx + 19, my - 4);
    g.lineTo(cx + 15, my + 3);
    g.lineTo(cx - 15, my + 3);
    g.closePath();
    g.fill();
  } else if (v === 3) {             // smirk
    g.beginPath();
    g.moveTo(cx - 20, my + 2);
    g.quadraticCurveTo(cx + 4, my + 14, cx + 22, my - 6);
    g.stroke();
  } else if (v === 5) {             // tiny cat mouth
    g.beginPath();
    g.moveTo(cx - 16, my - 2);
    g.quadraticCurveTo(cx - 8, my + 10, cx, my - 1);
    g.quadraticCurveTo(cx + 8, my + 10, cx + 16, my - 2);
    g.stroke();
  } else {                          // classic smile
    const wdt = v === 0 ? 26 : 21;
    g.beginPath();
    g.moveTo(cx - wdt, my - 5);
    g.quadraticCurveTo(cx, my + 18, cx + wdt, my - 5);
    g.stroke();
  }

  // ---- facial hair ----
  if (v === 3) {                    // moustache
    g.fillStyle = 'rgba(60,44,36,0.9)';
    g.beginPath();
    g.ellipse(cx - 13, my - 16, 15, 7, 0.25, 0, Math.PI * 2);
    g.ellipse(cx + 13, my - 16, 15, 7, -0.25, 0, Math.PI * 2);
    g.fill();
  }
  if (v === 6) {                    // short beard
    g.strokeStyle = 'rgba(70,58,50,0.75)';
    g.lineWidth = 12;
    g.beginPath();
    g.arc(cx, my - 12, 40, Math.PI * 0.15, Math.PI * 0.85);
    g.stroke();
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function makeNameTexture(name, colorHex) {
  const text = String(name == null || name === '' ? 'Angler' : name).slice(0, 18);
  const cv = document.createElement('canvas');
  const font = '700 48px system-ui, "Segoe UI", Roboto, Arial, sans-serif';
  let g = cv.getContext('2d');
  g.font = font;
  const w = Math.ceil(g.measureText(text).width);
  cv.width = Math.max(96, Math.min(720, w + 60));
  cv.height = 88;
  g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  roundRectPath(g, 4, 12, cv.width - 8, cv.height - 26, 18);
  g.fillStyle = 'rgba(10,14,20,0.66)';
  g.fill();
  g.lineWidth = 5;
  g.strokeStyle = '#' + _col.setHex(colorHex).getHexString();
  g.stroke();
  g.shadowColor = 'rgba(0,0,0,0.85)';
  g.shadowBlur = 8;
  g.fillStyle = '#ffffff';
  g.fillText(text, cv.width * 0.5, cv.height * 0.5 + 1);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return { texture: tex, aspect: cv.width / cv.height };
}

// ------------------------------------------------------------
// Per-color material palettes (shared between characters)
// ------------------------------------------------------------
const PAL = new Map();
function palette(idx) {
  const key = ((idx | 0) % PLAYER_COLORS.length + PLAYER_COLORS.length) % PLAYER_COLORS.length;
  const hit = PAL.get(key);
  if (hit) return hit;

  const base = new THREE.Color(PLAYER_COLORS[key]);
  base.getHSL(_hsl);
  const std = (color, rough, extra) => new THREE.MeshStandardMaterial(Object.assign({
    color, roughness: rough === undefined ? 0.86 : rough, metalness: 0.0, flatShading: true,
  }, extra || {}));

  const shirtCol = new THREE.Color().setHSL(_hsl.h, Math.min(0.42, _hsl.s * 0.5), 0.83);
  const trouserCol = new THREE.Color().setHSL(_hsl.h, _hsl.s * 0.92, Math.max(0.17, _hsl.l * 0.6));
  const faceTex = makeFaceTexture(key);

  const p = {
    overalls: std(base.getHex()),
    trouser: std(trouserCol.getHex()),
    shirt: std(shirtCol.getHex(), 0.92),
    skin: skinMaterial(0),
    hair: std(HAIR_COLORS[key % HAIR_COLORS.length], 0.95),
    boot: std(BOOT_COLORS[key % BOOT_COLORS.length], 0.7),
    leather: std(0x4a3626, 0.75),
    wicker: std(0xc9a765, 0.95),
    hat: std(HAT_COLORS[key % HAT_COLORS.length], 0.9),
    accent: std(ACCENT_COLORS[key % ACCENT_COLORS.length], 0.85),
    metal: new THREE.MeshStandardMaterial({ color: 0xe8c060, roughness: 0.35, metalness: 0.8, flatShading: true }),
    face: new THREE.MeshStandardMaterial({
      map: faceTex, transparent: true, alphaTest: 0.45, depthWrite: true,
      roughness: 1.0, metalness: 0.0, emissive: 0x2a2a2a, emissiveMap: faceTex,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }),
    faceTex,
  };
  PAL.set(key, p);
  return p;
}

// ------------------------------------------------------------
// Pose bookkeeping
// ------------------------------------------------------------
function newPose() {
  return {
    rootY: 0, rootZ: 0, rootRX: 0, rootRZ: 0,
    hipRX: 0, hipRY: 0, hipRZ: 0, breath: 1,
    headRX: 0, headRY: 0, headRZ: 0,
    aLX: 0, aLY: 0, aLZ: -0.09, aRX: 0, aRY: 0, aRZ: 0.09,
    eL: -0.12, eR: -0.12,
    lLX: 0, lLZ: 0, lRX: 0, lRZ: 0,
    kL: 0, kR: 0, fL: 0, fR: 0,
    rate: 13,
  };
}
function resetPose(p) {
  p.rootY = 0; p.rootZ = 0; p.rootRX = 0; p.rootRZ = 0;
  p.hipRX = 0; p.hipRY = 0; p.hipRZ = 0; p.breath = 1;
  p.headRX = 0; p.headRY = 0; p.headRZ = 0;
  p.aLX = 0; p.aLY = 0; p.aLZ = -0.09; p.aRX = 0; p.aRY = 0; p.aRZ = 0.09;
  p.eL = -0.12; p.eR = -0.12;
  p.lLX = 0; p.lLZ = 0; p.lRX = 0; p.lRZ = 0;
  p.kL = 0; p.kR = 0; p.fL = 0; p.fR = 0;
  p.rate = 13;
}

// =============================================================
// createCharacter â€” skeleton + procedural visuals + animation
// =============================================================
function buildVisual(char, colorIndex, name, opts) {
  const b = char.bones;
  const G = sharedGeo();
  const P = palette(colorIndex);
  const v = ((colorIndex | 0) % 8 + 8) % 8;
  const o = opts || char._opts || {};
  const hatKind = clamp(Math.round(Number(o.hat)) || 0, 0, 4);
  const skinIdx = clamp(Math.round(Number(o.skin)) || 0, 0, SKIN_SET.length - 1);
  const SK = skinMaterial(skinIdx);

  for (let i = 0; i < char._parts.length; i++) {
    const m = char._parts[i];
    if (m.parent) m.parent.remove(m);
  }
  char._parts.length = 0;

  const add = (parent, geo, mat, x, y, z) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = false;
    parent.add(m);
    char._parts.push(m);
    return m;
  };

  // ---------- torso ----------
  add(b.hips, G.torso, P.overalls, 0, 0.13, 0);
  add(b.hips, G.shirt, P.shirt, 0, 0.40, 0);
  add(b.hips, G.belt, P.leather, 0, 0.02, 0);
  add(b.hips, G.bib, P.overalls, 0, 0.30, 0.152);
  const collar = add(b.hips, G.collar, P.shirt, 0, 0.545, 0);
  collar.rotation.x = 0.06;
  for (const s of [-1, 1]) {
    const st = add(b.hips, G.strap, P.overalls, s * 0.135, 0.375, 0.132);
    st.rotation.x = -0.12;
    st.rotation.z = s * 0.09;
    const bk = add(b.hips, G.strap, P.overalls, s * 0.115, 0.375, -0.132);
    bk.rotation.x = 0.10;
    bk.rotation.z = s * 0.07;
    // brass buckle
    add(b.hips, G.capBadge, P.metal, s * 0.135, 0.245, 0.166).scale.set(0.55, 0.55, 0.6);
  }
  // creel basket on the back
  const creel = add(b.hips, G.creel, P.wicker, 0.0, 0.27, -0.215);
  creel.rotation.x = 0.10;
  add(b.hips, G.creelLid, P.leather, 0.0, 0.385, -0.222).rotation.x = 0.10;
  add(b.hips, G.neck, SK, 0, 0.575, 0);

  // ---------- head ----------
  add(b.head, G.head, SK, 0, 0.17, 0);
  const face = add(b.head, G.face, P.face, 0, 0.175, 0.1735);
  face.castShadow = false;
  for (const s of [-1, 1]) {
    add(b.head, G.ear, SK, s * 0.178, 0.16, -0.005).scale.set(0.55, 1.0, 0.85);
  }
  const nose = add(b.head, G.nose, SK, 0, 0.148, 0.176);
  nose.rotation.x = Math.PI * 0.5;
  add(b.head, G.hairBack, P.hair, 0, 0.20, -0.125);
  add(b.head, G.fringe, P.hair, 0, 0.305, 0.115);
  if (v % 2 === 0) {
    const tail = add(b.head, G.ponytail, P.hair, 0, 0.09, -0.20);
    tail.rotation.x = -0.55;
  }

  // ---------- hat ----------
  const hat = new THREE.Group();
  hat.rotation.set(-0.04, 0.12, 0.05);
  b.head.add(hat);
  char._parts.push(hat);
  const hadd = (geo, mat, x, y, z) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    hat.add(m);
    return m;
  };
  if (hatKind === 0) {          // 0 - bucket hat
    hadd(G.bucketCrown, P.hat, 0, 0.375, 0);
    const brim = hadd(G.bucketBrim, P.hat, 0, 0.305, 0.005);
    brim.rotation.x = -0.07;
    hadd(G.strawBand, P.accent, 0, 0.325, 0).scale.set(0.94, 0.8, 0.94);
  } else if (hatKind === 1) {   // 1 - beanie
    hadd(G.beanieDome, P.hat, 0, 0.245, 0);
    hadd(G.beanieCuff, P.accent, 0, 0.285, 0);
    hadd(G.pom, P.accent, 0, 0.455, 0);
  } else if (hatKind === 2) {   // 2 - captain's peaked cap, gold band
    hadd(G.capCrown, P.hat, 0, 0.375, 0);
    hadd(G.capTop, P.hat, 0, 0.432, 0);
    hadd(G.strawBand, P.metal, 0, 0.335, 0).scale.set(1.07, 0.52, 1.07);
    const visor = hadd(G.capVisor, P.leather, 0, 0.316, 0.190);
    visor.rotation.x = -0.16;
    hadd(G.capBadge, P.metal, 0, 0.392, 0.196);
  } else if (hatKind === 3) {   // 3 - bandana with a knot and two tails
    hadd(G.bandanaCap, P.hat, 0, 0.245, 0);
    hadd(G.bandanaBand, P.accent, 0, 0.268, 0);
    hadd(G.bandanaKnot, P.hat, 0, 0.258, -0.188);
    const t1 = hadd(G.bandanaTail, P.hat, -0.048, 0.150, -0.212);
    t1.rotation.set(0.34, 0, 0.24);
    const t2 = hadd(G.bandanaTail, P.hat, 0.048, 0.138, -0.212);
    t2.rotation.set(0.44, 0, -0.30);
  }                             // 4 - bareheaded

  // ---------- arms ----------
  for (const side of [-1, 1]) {
    const arm = side < 0 ? b.armL : b.armR;
    const fore = side < 0 ? b.foreL : b.foreR;
    const hand = side < 0 ? b.handL : b.handR;
    add(arm, G.sleeve, P.shirt, 0, -0.055, 0);
    add(arm, G.upperArm, SK, 0, -0.15, 0);
    add(fore, G.foreArm, SK, 0, -0.13, 0);
    add(hand, G.hand, SK, 0, -0.048, 0.008);
  }

  // ---------- legs ----------
  for (const side of [-1, 1]) {
    const leg = side < 0 ? b.legL : b.legR;
    const knee = side < 0 ? b.kneeL : b.kneeR;
    const foot = side < 0 ? b.footL : b.footR;
    add(leg, G.thigh, P.overalls, 0, -0.165, 0);
    add(knee, G.shin, P.trouser, 0, -0.15, 0);
    add(foot, G.boot, P.boot, 0, -0.08, 0.035);
  }

  // ---------- name tag ----------
  if (char.nameTag) {
    char.group.remove(char.nameTag);
    if (char.nameTag.material.map) char.nameTag.material.map.dispose();
    char.nameTag.material.dispose();
    char.nameTag = null;
  }
  const tag = makeNameTexture(name, PLAYER_COLORS[((colorIndex | 0) % PLAYER_COLORS.length + PLAYER_COLORS.length) % PLAYER_COLORS.length]);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tag.texture, transparent: true, depthTest: true, depthWrite: false, sizeAttenuation: true,
  }));
  const th = 0.30;
  sprite.scale.set(th * tag.aspect, th, 1);
  sprite.position.set(0, 2.05, 0);
  sprite.renderOrder = 6;
  sprite.visible = char._tagVisible;
  char.group.add(sprite);
  char.nameTag = sprite;

  char.colorIndex = colorIndex | 0;
  char.name = name;
  char.hat = hatKind;
  char.skin = skinIdx;
  char._opts = { hat: hatKind, skin: skinIdx };
}

export function createCharacter(colorIndex, name, opts = { hat: 0, skin: 0 }) {
  const group = new THREE.Group();
  group.name = 'fisherfolk';

  const root = new THREE.Object3D();
  group.add(root);

  const hips = new THREE.Object3D();
  hips.position.y = HIP_Y;
  root.add(hips);

  const head = new THREE.Object3D();
  head.position.y = HEAD_PIVOT_Y;
  hips.add(head);

  const mkArm = (side) => {
    const arm = new THREE.Object3D();
    arm.position.set(side * SHOULDER_X, SHOULDER_Y, 0);
    hips.add(arm);
    const fore = new THREE.Object3D();
    fore.position.y = -UPPER_ARM;
    arm.add(fore);
    const hand = new THREE.Object3D();
    hand.position.y = -FORE_ARM;
    fore.add(hand);
    return { arm, fore, hand };
  };
  const mkLeg = (side) => {
    const leg = new THREE.Object3D();
    leg.position.set(side * LEG_X, HIP_Y, 0);
    root.add(leg);
    const knee = new THREE.Object3D();
    knee.position.y = -THIGH_LEN;
    leg.add(knee);
    const foot = new THREE.Object3D();
    foot.position.y = -SHIN_LEN;
    knee.add(foot);
    return { leg, knee, foot };
  };

  const L = mkArm(-1), R = mkArm(1);
  const LL = mkLeg(-1), RL = mkLeg(1);

  const bones = {
    root, hips, head,
    armL: L.arm, armR: R.arm,
    foreL: L.fore, foreR: R.fore,
    handL: L.hand, handR: R.hand,
    legL: LL.leg, legR: RL.leg,
    kneeL: LL.knee, kneeR: RL.knee,
    footL: LL.foot, footR: RL.foot,
  };

  const pose = newPose();
  const state = {
    base: 'idle',
    act: null,
    actT: 0,
    actHold: 0,
    walkPhase: Math.random() * Math.PI * 2,
    tOff: Math.random() * 10,
    animSpeed: 0,
    lean: 0,
    hit: 0,
    airborne: false,
  };

  const char = {
    group,
    bones,
    nameTag: null,
    colorIndex: colorIndex | 0,
    name,
    hat: 0,
    skin: 0,
    _opts: null,
    _parts: [],
    _tagVisible: true,
    _s: state,

    setAnim(anim) {
      if (!anim) return;
      if (ACTIONS[anim]) {
        if (state.act !== anim) { state.act = anim; state.actT = 0; }
        state.actHold = anim === 'cast' ? 0.30 : 0.45;
      } else if (state.base !== anim) {
        state.base = anim;
      }
    },
    clearAction() { state.act = null; state.actT = 0; state.actHold = 0; },
    getAction() { return state.act; },
    setSpeed(v) { state.animSpeed = v || 0; },
    setLean(v) { state.lean = v || 0; },
    setAirborne(on) { state.airborne = !!on; },
    punch(amount) { state.hit = Math.max(state.hit, amount || 0.3); },
    setNameVisible(on) {
      char._tagVisible = !!on;
      if (char.nameTag) char.nameTag.visible = !!on;
    },
    setLook(ci, nm, o) {
      buildVisual(char, ci, nm === undefined ? char.name : nm, o === undefined ? char._opts : o);
    },
    update(dt, t) { animate(char, pose, state, dt, t); },
    dispose() {
      if (char.nameTag) {
        if (char.nameTag.material.map) char.nameTag.material.map.dispose();
        char.nameTag.material.dispose();
        char.group.remove(char.nameTag);
        char.nameTag = null;
      }
      if (char.group.parent) char.group.parent.remove(char.group);
    },
  };

  buildVisual(char, colorIndex, name, opts);
  return char;
}

// ------------------------------------------------------------
// Animation
// ------------------------------------------------------------
function animate(char, p, s, dt, t) {
  const b = char.bones;
  const tt = t + s.tOff;

  // action lifetime
  if (s.act) {
    s.actT += dt;
    s.actHold -= dt;
    const done = s.act === 'cast' ? (s.actT > 0.92 && s.actHold <= 0) || s.actT > 1.9
      : s.act === 'cheer' ? s.actT > 0.95
        : s.actHold <= 0;
    if (done) { s.act = null; s.actT = 0; }
  }
  if (s.hit > 0) s.hit = Math.max(0, s.hit - dt * 2.2);

  resetPose(p);
  const base = s.base;

  // ------- base locomotion -------
  if (base === 'walk' || base === 'run') {
    const running = base === 'run';
    const ref = running ? RUN_SPEED : WALK_SPEED;
    const sp = clamp(s.animSpeed <= 0 ? ref : s.animSpeed, 0.6, 12);
    s.walkPhase += dt * (running ? sp * 1.15 : sp * 1.45);
    const w = s.walkPhase;
    const amp = (running ? 0.92 : 0.55) * clamp(sp / ref, 0.45, 1.15);
    const sw = Math.sin(w), cw = Math.cos(w * 2);
    p.lLX = amp * sw;
    p.lRX = -amp * sw;
    p.kL = Math.max(0, -sw) * (running ? 1.25 : 0.75) + 0.06;
    p.kR = Math.max(0, sw) * (running ? 1.25 : 0.75) + 0.06;
    p.fL = clamp(-p.lLX * 0.35, -0.35, 0.35);
    p.fR = clamp(-p.lRX * 0.35, -0.35, 0.35);
    p.aLX = -amp * 0.78 * sw;
    p.aRX = amp * 0.78 * sw;
    p.eL = -0.25 - (running ? 0.85 : 0.30) - Math.max(0, p.aLX) * 0.3;
    p.eR = -0.25 - (running ? 0.85 : 0.30) - Math.max(0, p.aRX) * 0.3;
    p.aLZ = -0.10 - (running ? 0.10 : 0.02);
    p.aRZ = 0.10 + (running ? 0.10 : 0.02);
    p.rootY = (running ? 0.075 : 0.045) * Math.abs(sw) - (running ? 0.05 : 0.03);
    p.hipRX = running ? 0.28 : 0.10;
    p.hipRY = -sw * (running ? 0.20 : 0.11);
    p.hipRZ = cw * 0.03;
    p.headRX = running ? -0.16 : -0.05;
    p.headRY = sw * 0.05;
    p.breath = 1;
    p.rate = 17;
  } else if (base === 'swim') {
    s.walkPhase += dt * 5.4;
    const w = s.walkPhase;
    p.rootRX = 1.32 + clamp(s.lean, -0.85, 0.95);
    p.rootY = 1.00;
    p.rootZ = -0.60;
    p.rootRZ = Math.sin(w * 0.5) * 0.10;
    p.lLX = 0.34 * Math.sin(w * 1.6);
    p.lRX = -0.34 * Math.sin(w * 1.6);
    p.kL = 0.22 + 0.28 * Math.max(0, Math.sin(w * 1.6 + 1.2));
    p.kR = 0.22 + 0.28 * Math.max(0, -Math.sin(w * 1.6 + 1.2));
    p.aLX = -1.30 - 1.10 * Math.sin(w);
    p.aRX = -1.30 - 1.10 * Math.sin(w + Math.PI);
    p.aLZ = -0.30; p.aRZ = 0.30;
    p.eL = -0.55 - 0.35 * Math.max(0, Math.sin(w));
    p.eR = -0.55 - 0.35 * Math.max(0, Math.sin(w + Math.PI));
    p.headRX = -0.60 - clamp(s.lean, -0.5, 0.5) * 0.4;
    p.hipRY = Math.sin(w) * 0.14;
    p.rate = 11;
  } else if (base === 'sit') {
    p.rootY = -0.30;
    p.lLX = -1.48; p.lRX = -1.48;
    p.lLZ = -0.09; p.lRZ = 0.09;
    p.kL = 1.42; p.kR = 1.42;
    p.fL = 0.15; p.fR = 0.15;
    p.aLX = -0.42; p.aRX = -0.42;
    p.eL = -0.80; p.eR = -0.80;
    p.aLZ = -0.14; p.aRZ = 0.14;
    p.hipRX = -0.06 + Math.sin(tt * 1.4) * 0.015;
    p.headRY = Math.sin(tt * 0.42) * 0.22;
    p.breath = 1 + Math.sin(tt * 1.7) * 0.012;
    p.rate = 10;
  } else if (base === 'drive') {
    const sway = Math.sin(tt * 0.85);
    p.aLX = -1.36 + sway * 0.10;
    p.aRX = -1.36 - sway * 0.10;
    p.eL = -0.52; p.eR = -0.52;
    p.aLZ = 0.20; p.aRZ = -0.20;
    p.aLY = 0.10; p.aRY = -0.10;
    p.lLZ = -0.11; p.lRZ = 0.11;
    p.kL = 0.16; p.kR = 0.16;
    p.hipRZ = sway * 0.05;
    p.hipRX = 0.10;
    p.headRY = sway * 0.12;
    p.headRX = -0.08;
    p.rootY = -0.02;
    p.breath = 1 + Math.sin(tt * 1.8) * 0.012;
    p.rate = 9;
  } else if (base === 'ko') {
    p.rootRX = -1.42;
    p.rootY = 0.14;
    p.rootZ = 0.55;
    p.rootRZ = 0.12;
    p.aLZ = -1.05; p.aRZ = 1.05;
    p.aLX = 0.35; p.aRX = 0.20;
    p.eL = -0.35; p.eR = -0.25;
    p.lLX = 0.18; p.lRX = 0.05;
    p.lLZ = -0.16; p.lRZ = 0.20;
    p.kL = 0.30; p.kR = 0.16;
    p.headRX = 0.32; p.headRZ = 0.20;
    p.breath = 1 + Math.sin(tt * 2.1) * 0.02;
    p.rate = 7;
  } else { // idle
    const br = Math.sin(tt * 1.55);
    const sway = Math.sin(tt * 0.62);
    p.rootY = br * 0.014;
    p.breath = 1 + br * 0.020;
    p.aLX = 0.05 + br * 0.05;
    p.aRX = 0.05 + br * 0.05;
    p.aLZ = -0.11 - br * 0.015;
    p.aRZ = 0.11 + br * 0.015;
    p.eL = -0.20; p.eR = -0.20;
    p.hipRZ = sway * 0.026;
    p.hipRY = sway * 0.05;
    p.headRY = Math.sin(tt * 0.37) * 0.30 + sway * 0.06;
    p.headRZ = -sway * 0.03;
    p.headRX = Math.sin(tt * 0.29) * 0.06;
    p.kL = 0.05; p.kR = 0.05;
    p.rate = 8;
  }

  // ------- airborne tuck (jump / fall) -------
  if (s.airborne && (base === 'walk' || base === 'run' || base === 'idle')) {
    p.lLX = -0.50; p.lRX = 0.22;
    p.lLZ = -0.06; p.lRZ = 0.06;
    p.kL = 0.90; p.kR = 0.32;
    p.fL = -0.15; p.fR = 0.10;
    p.aLX = -0.62; p.aRX = -0.62;
    p.aLZ = -0.50; p.aRZ = 0.50;
    p.eL = -0.55; p.eR = -0.55;
    p.hipRX = 0.14;
    p.headRX = -0.10;
    p.rootY = 0;
    p.rate = 14;
  }

  // ------- action overlays -------
  if (s.act === 'cast') {
    const a = s.actT;
    p.rate = 26;
    // hold pose (rod out front) is the target the whip settles into
    const holdX = -1.12, holdE = -0.45;
    let ax, ae, twist, lean;
    if (a < 0.24) {
      const k = smoothstep(0, 0.24, a);
      ax = holdX + (1.05 - holdX) * k;
      ae = holdE + (-1.45 - holdE) * k;
      twist = 0.30 * k;
      lean = -0.14 * k;
    } else if (a < 0.40) {
      const k = smoothstep(0.24, 0.40, a);
      ax = 1.05 + (-2.05 - 1.05) * k;
      ae = -1.45 + (-0.12 + 1.45) * k;
      twist = 0.30 - 0.52 * k;
      lean = -0.14 + 0.36 * k;
    } else {
      const k = smoothstep(0.40, 0.95, a);
      ax = -2.05 + (holdX + 2.05) * k;
      ae = -0.12 + (holdE + 0.12) * k;
      twist = -0.22 + 0.22 * k;
      lean = 0.22 - 0.22 * k;
    }
    p.aRX = ax; p.eR = ae; p.aRZ = 0.16;
    p.aLX = -0.55 - 0.25 * Math.sin(a * 4);
    p.eL = -0.95;
    p.aLZ = -0.30;
    p.hipRY = twist;
    p.hipRX = lean + 0.06;
    p.headRX = -0.10 + lean * 0.4;
    p.headRY = twist * 0.5;
  } else if (s.act === 'reel') {
    const w = tt * 6.5;
    p.rate = 15;
    p.aRX = -1.12 + Math.sin(w) * 0.05;
    p.eR = -0.48;
    p.aRZ = 0.17;
    p.aRY = -0.10;
    p.aLX = -0.92 + Math.sin(w) * 0.26;
    p.aLZ = -0.34 + Math.cos(w) * 0.22;
    p.eL = -1.45;
    p.aLY = 0.22;
    p.hipRX = 0.09 + Math.sin(w) * 0.05;
    p.hipRY = -0.12;
    p.headRX = -0.14;
    p.headRY = -0.08;
  } else if (s.act === 'cheer') {
    const k = Math.sin(clamp(s.actT / 0.95, 0, 1) * Math.PI);
    p.rate = 20;
    p.aLX = -2.55 * k; p.aRX = -2.55 * k;
    p.aLZ = -0.35 - 0.25 * k; p.aRZ = 0.35 + 0.25 * k;
    p.eL = -0.25; p.eR = -0.25;
    p.rootY += 0.16 * Math.max(0, Math.sin(s.actT * 12));
    p.headRX = -0.30 * k;
    p.hipRX = -0.12 * k;
  }

  // ------- damage jolt -------
  if (s.hit > 0) {
    const j = s.hit;
    p.hipRX -= j * 0.5;
    p.headRX += j * 0.35;
    p.rootRZ += Math.sin(tt * 40) * j * 0.09;
    p.rate = Math.max(p.rate, 20);
  }

  // ------- apply with damping (gives free cross-fades) -------
  const k = 1 - Math.exp(-p.rate * dt);
  b.root.position.y += (p.rootY - b.root.position.y) * k;
  b.root.position.z += (p.rootZ - b.root.position.z) * k;
  b.root.rotation.x += (p.rootRX - b.root.rotation.x) * k;
  b.root.rotation.z += (p.rootRZ - b.root.rotation.z) * k;

  b.hips.rotation.x += (p.hipRX - b.hips.rotation.x) * k;
  b.hips.rotation.y += (p.hipRY - b.hips.rotation.y) * k;
  b.hips.rotation.z += (p.hipRZ - b.hips.rotation.z) * k;
  const sc = b.hips.scale.y + (p.breath - b.hips.scale.y) * k;
  b.hips.scale.set(1, sc, 1);

  b.head.rotation.x += (p.headRX - b.head.rotation.x) * k;
  b.head.rotation.y += (p.headRY - b.head.rotation.y) * k;
  b.head.rotation.z += (p.headRZ - b.head.rotation.z) * k;

  b.armL.rotation.x += (p.aLX - b.armL.rotation.x) * k;
  b.armL.rotation.y += (p.aLY - b.armL.rotation.y) * k;
  b.armL.rotation.z += (p.aLZ - b.armL.rotation.z) * k;
  b.armR.rotation.x += (p.aRX - b.armR.rotation.x) * k;
  b.armR.rotation.y += (p.aRY - b.armR.rotation.y) * k;
  b.armR.rotation.z += (p.aRZ - b.armR.rotation.z) * k;
  b.foreL.rotation.x += (p.eL - b.foreL.rotation.x) * k;
  b.foreR.rotation.x += (p.eR - b.foreR.rotation.x) * k;

  b.legL.rotation.x += (p.lLX - b.legL.rotation.x) * k;
  b.legL.rotation.z += (p.lLZ - b.legL.rotation.z) * k;
  b.legR.rotation.x += (p.lRX - b.legR.rotation.x) * k;
  b.legR.rotation.z += (p.lRZ - b.legR.rotation.z) * k;
  b.kneeL.rotation.x += (p.kL - b.kneeL.rotation.x) * k;
  b.kneeR.rotation.x += (p.kR - b.kneeR.rotation.x) * k;
  b.footL.rotation.x += (p.fL - b.footL.rotation.x) * k;
  b.footR.rotation.x += (p.fR - b.footR.rotation.x) * k;
}

// =============================================================
// initPlayer
// =============================================================
export function initPlayer(ctx) {
  const scene = ctx.scene;
  const camera = ctx.camera;

  // ---------- module state ----------
  const local = {
    char: null,
    pos: new THREE.Vector3(0, 0, 0),
    vel: new THREE.Vector3(0, 0, 0),
    yaw: 0,            // camera / aim yaw
    pitch: -0.15,
    faceYaw: 0,        // body facing
    grounded: false,
    swimming: false,
    underwater: false,
    onBoat: false,
    onDeck: false,
    seat: -1,
    anchor: new THREE.Vector3(),   // boat-local anchor while standing on deck
    deckY: 0,
    ko: false,
    anim: 'idle',
    speed: 0,
    spawned: false,
  };
  const remotes = new Map();
  const _deckA = { y: 0, localX: 0, localZ: 0 };

  const cam = {
    dist: 5.5,
    distWant: 5.5,
    shoulder: 0,
    pos: new THREE.Vector3(),
    look: new THREE.Vector3(),
    shake: 0,
    baseFov: 0,
    inited: false,
  };

  let lastPhase = null;
  let moveAccum = 0;
  let drownAccum = 0;
  let castFlash = 0;
  let swimFxAccum = 0;
  let boatSeats = null;      // from BOAT_STATE
  let lastMoveMsg = null;    // dedupe bus vs net delivery
  let lastWorldMsg = null;
  let boardCooldown = 0;
  let vaultT = 0;            // swimming stays off while a vault is in the air
  let vaultCd = 0;
  let wasKo = false;
  let netTime = 0;           // frame-driven clock used for remote interpolation
  let deckPrevYaw = null;    // boat yaw last frame, so the hull turns you with it

  const keys = (ctx.input && ctx.input.keys) ? ctx.input.keys : new Set();
  if (ctx.input && !ctx.input.keys) ctx.input.keys = keys;
  const prevKeys = new Set();
  const WATCH = ['KeyE', 'Space', 'KeyC', 'ShiftLeft', 'ShiftRight'];

  const isDown = (c) => keys.has(c);
  const justDown = (c) => keys.has(c) && !prevKeys.has(c);

  // ---------- safe accessors ----------
  function terrainH(x, z) {
    const w = ctx.world;
    if (w && typeof w.getTerrainHeight === 'function') {
      const h = w.getTerrainHeight(x, z);
      return Number.isFinite(h) ? h : 0;
    }
    return 0;
  }
  // Ground height INCLUDING walkable structures (dock decking, steps).
  // world.js owns it; yRef is our own height so decking far ABOVE us stays
  // transparent (that is what lets you swim under the dock). Falls back to
  // raw terrain until world.js exposes it.
  function surfaceH(x, z, yRef) {
    const w = ctx.world;
    if (w && typeof w.surfaceHeight === 'function') {
      const h = w.surfaceHeight(x, z, yRef);
      if (Number.isFinite(h)) return h;
    }
    return terrainH(x, z);
  }
  // Push out of solid props (palms, rocks, hut walls, stones, dock posts).
  function resolveCollide(pos) {
    const w = ctx.world;
    if (!w || typeof w.resolveCollide !== 'function') return;
    try { w.resolveCollide(pos, 0.45); } catch (e) { /* world not ready */ }
  }
  // boat.js handle, only once it exposes the wave-3 deck API.
  function boatApi() {
    const b = ctx.boat;
    if (!b) return null;
    if (typeof b.deckInfo !== 'function' || typeof b.toWorld !== 'function' ||
        typeof b.toLocal !== 'function') return null;
    return b;
  }
  function waterH(x, z, t) {
    if (typeof ctx.getWaterHeight === 'function') {
      const h = ctx.getWaterHeight(x, z, t);
      return Number.isFinite(h) ? h : 0;
    }
    return 0;
  }
  function send(type, data) {
    if (ctx.net && typeof ctx.net.send === 'function') {
      try { ctx.net.send(type, data); } catch (e) { /* transport not ready */ }
    }
  }
  function sfxSafe(name, opts) {
    if (ctx.audio && typeof ctx.audio.sfx === 'function') {
      try { ctx.audio.sfx(name, opts); } catch (e) { /* audio not ready */ }
    }
  }
  function splash(x, y, z, size) {
    if (ctx.water && typeof ctx.water.splash === 'function') {
      _v5.set(x, y, z);
      try { ctx.water.splash(_v5, size); } catch (e) { /* ignore */ }
    }
    sfxSafe('splash', { volume: clamp(size * 0.5, 0.15, 1) });
  }
  function airCapacity() {
    const lvl = (ctx.state.gear && ctx.state.gear.diving) || 1;
    if (lvl <= 1) return BASE_AIR_SECONDS;
    for (let i = 0; i < SHOP.length; i++) {
      const it = SHOP[i];
      if (it.kind === 'diving' && it.level === lvl && it.air) return it.air;
    }
    return BASE_AIR_SECONDS;
  }
  function boatSeatOf(id) {
    if (!boatSeats) return -1;
    for (let i = 0; i < boatSeats.length; i++) if (boatSeats[i] === id) return i;
    return -1;
  }
  function boatSeatCount() {
    if (ctx.boat && typeof ctx.boat.seatCount === 'function') {
      const n = ctx.boat.seatCount();
      if (Number.isFinite(n) && n > 0) return n;
    }
    return boatSeats ? boatSeats.length : 4;
  }
  // Resolve a boat seat to a world position. Works whether boat.js returns
  // the vector or only writes into the out param. Adds one frame of boat
  // velocity because boat.update() runs after ours.
  function seatPos(seat, out, dt) {
    const b = ctx.boat;
    if (!b || seat < 0 || typeof b.seatWorld !== 'function') return null;
    out.set(NaN, NaN, NaN);
    const r = b.seatWorld(seat, out);
    const v = (r && Number.isFinite(r.x)) ? r : out;
    if (!Number.isFinite(v.x)) return null;
    if (v !== out) out.copy(v);
    if (b.velocity && Number.isFinite(b.velocity.x)) out.addScaledVector(b.velocity, dt);
    return out;
  }
  const _qtHelper = new THREE.Quaternion();
  function boatYaw() {
    if (ctx.boat && ctx.boat.group) {
      _eul.setFromQuaternion(ctx.boat.group.getWorldQuaternion(_qtHelper), 'YXZ');
      return _eul.y;
    }
    return 0;
  }

  // ---------- boat: boarding, the wheel, stepping off ----------
  const _helmW = new THREE.Vector3();

  function nearHelm() {
    const b = ctx.boat;
    if (!b || typeof b.helmPos !== 'function') return false;
    b.helmPos(_helmW);
    if (!Number.isFinite(_helmW.x)) return false;
    const dx = local.pos.x - _helmW.x, dz = local.pos.z - _helmW.z;
    const dy = local.pos.y - _helmW.y;
    return (dx * dx + dz * dz) <= 4 && dy > -3 && dy < 3;   // within 2 m
  }

  function setAboard(onDeck, seat) {
    local.onDeck = onDeck;
    local.onBoat = onDeck || seat >= 0;
    local.seat = seat;
    ctx.state.onDeck = local.onDeck;
    ctx.state.onBoat = local.onBoat;
    ctx.state.seat = seat;
  }

  // Snap to seat 0 and start driving.
  function takeWheel() {
    setAboard(false, 0);
    local.vel.set(0, 0, 0);
    local.swimming = false;
    local.grounded = true;
    setUnderwater(false);
    boardCooldown = 0.45;
    deckPrevYaw = boatYaw();
    send(MSG.BOARD_BOAT, { seat: 0 });
    if (ctx.bus) ctx.bus.emit('boardBoat', { seat: 0 });
  }

  // Let go of the wheel â€” you keep standing on the deck beside it.
  function releaseWheel() {
    const B = boatApi();
    send(MSG.LEAVE_BOAT, {});
    boardCooldown = 0.45;
    if (B && typeof B.helmPos === 'function') {
      B.helmPos(_v1);
      if (Number.isFinite(_v1.x)) local.pos.copy(_v1);
      const di = B.deckInfo(local.pos.x, local.pos.z, local.pos.y + 0.4, _deckA);
      if (di) local.pos.y = di.y;
      local.deckY = local.pos.y;
      B.toLocal(local.pos, local.anchor);
      setAboard(true, -1);
      local.grounded = true;
      local.vel.set(0, 0, 0);
    } else {
      setAboard(false, -1);
    }
    if (ctx.bus) ctx.bus.emit('leaveBoat', {});
  }

  // Hop onto the nearest deck point of the hull we are standing next to.
  function boardDeck() {
    const B = boatApi();
    if (!B) return false;
    const g = ctx.boat.group;
    const cx = (g && g.position && Number.isFinite(g.position.x)) ? g.position.x : local.pos.x;
    const cz = (g && g.position && Number.isFinite(g.position.z)) ? g.position.z : local.pos.z;
    let bx = local.pos.x, bz = local.pos.z;
    let di = B.deckInfo(bx, bz, local.pos.y, _deckA);
    if (!di) {
      // walk the sample inward toward the hull centre until the deck appears
      const dx = cx - bx, dz = cz - bz;
      const len = Math.hypot(dx, dz);
      if (len > 1e-3) {
        const ux = dx / len, uz = dz / len;
        for (let i = 1; i <= 14; i++) {
          const nx = bx + ux * (len * i / 14);
          const nz = bz + uz * (len * i / 14);
          const hit = B.deckInfo(nx, nz, local.pos.y, _deckA);
          if (hit) { bx = nx; bz = nz; di = hit; break; }
        }
      }
    }
    if (!di) return false;
    local.pos.set(bx, di.y, bz);
    local.deckY = di.y;
    B.toLocal(local.pos, local.anchor);
    setAboard(true, -1);
    local.vel.set(0, 0, 0);
    local.swimming = false;
    local.grounded = true;
    setUnderwater(false);
    boardCooldown = 0.45;
    deckPrevYaw = boatYaw();
    if (ctx.bus) ctx.bus.emit('boardBoat', { seat: -1 });
    return true;
  }

  // Deliberate dismount: shove clear of the hull and drop.
  function hopOff(t) {
    const by = boatYaw();
    let rx = -Math.cos(by), rz = Math.sin(by);
    const g = ctx.boat && ctx.boat.group;
    if (g && g.position && Number.isFinite(g.position.x)) {
      const dx = local.pos.x - g.position.x, dz = local.pos.z - g.position.z;
      if (dx * rx + dz * rz < 0) { rx = -rx; rz = -rz; }
    }
    const B = boatApi();
    for (let i = 0; i < 10; i++) {
      if (!B || !B.deckInfo(local.pos.x + rx, local.pos.z + rz, local.pos.y, _deckA)) break;
      local.pos.x += rx; local.pos.z += rz;
    }
    local.pos.x += rx * 1.8;
    local.pos.z += rz * 1.8;
    const gy = surfaceH(local.pos.x, local.pos.z, local.pos.y);
    const wy = waterH(local.pos.x, local.pos.z, t);
    local.pos.y = Math.max(gy, wy - 0.9);
    local.vel.set(rx * 2.0, 2.4, rz * 2.0);
    stepOffDeck();
  }

  // Leave the deck frame entirely (walked off the edge, or hopped off).
  function stepOffDeck() {
    setAboard(false, -1);
    const bv = ctx.boat && ctx.boat.velocity;
    if (bv && Number.isFinite(bv.x)) { local.vel.x += bv.x; local.vel.z += bv.z; }
    local.grounded = false;
    deckPrevYaw = null;
    if (boardCooldown < 0.35) boardCooldown = 0.35;
    send(MSG.LEAVE_BOAT, {});
    if (ctx.bus) ctx.bus.emit('leaveBoat', {});
  }

  // ---------- spawn ----------
  function findLand(x, z, out) {
    let bx = x, bz = z;
    if (terrainH(bx, bz) < 0.7) {
      const len = Math.hypot(bx, bz) || 1;
      const dx = -bx / len, dz = -bz / len;   // step toward island centre
      for (let i = 1; i <= 20; i++) {
        const nx = x + dx * i * 4, nz = z + dz * i * 4;
        if (terrainH(nx, nz) > 0.9) { bx = nx; bz = nz; break; }
      }
    }
    out.set(bx, terrainH(bx, bz) + 0.02, bz);
    return out;
  }
  function spawnPoint(out) {
    let x = 0, z = 0;
    const w = ctx.world;
    if (w) {
      const p = w.campfirePos || w.dockPos || w.shopPos;
      if (p && Number.isFinite(p.x)) { x = p.x; z = p.z; }
    }
    const a = Math.random() * Math.PI * 2;
    x += Math.cos(a) * 2.0;
    z += Math.sin(a) * 2.0;
    return findLand(x, z, out);
  }
  function respawn() {
    spawnPoint(local.pos);
    local.vel.set(0, 0, 0);
    local.swimming = false;
    local.grounded = true;
    local.onBoat = false;
    local.onDeck = false;
    local.seat = -1;
    ctx.state.onBoat = false;
    ctx.state.onDeck = false;
    ctx.state.seat = -1;
    deckPrevYaw = null;
    ctx.state.air = 1;
    drownAccum = 0;
    setUnderwater(false);
    if (local.char) {
      local.char.group.position.copy(local.pos);
      cam.inited = false;
    }
  }
  function setUnderwater(on) {
    if (local.underwater === on) return;
    local.underwater = on;
    ctx.state.underwater = on;
    if (ctx.bus) ctx.bus.emit('underwater', on);
  }

  // ---------- local character ----------
  function myColor() {
    let c = ctx.state.myColor;
    if (!Number.isFinite(c)) c = 0;
    const w = ctx.state.world;
    if (w && Array.isArray(w.players) && ctx.state.myId) {
      for (const pl of w.players) if (pl.id === ctx.state.myId && Number.isFinite(pl.color)) return pl.color;
    }
    return c;
  }
  function myName() {
    if (ctx.state.myName) return ctx.state.myName;
    const w = ctx.state.world;
    if (w && Array.isArray(w.players) && ctx.state.myId) {
      for (const pl of w.players) if (pl.id === ctx.state.myId && pl.name) return pl.name;
    }
    return 'You';
  }
  // ui.js writes ctx.state.myHat / myMySkin; the world player list is the
  // fallback so a rejoin still shows the right look. Default 0.
  function myLook() {
    const s = ctx.state;
    let hat = s && Number.isFinite(s.myHat) ? s.myHat : null;
    let skin = s && Number.isFinite(s.mySkin) ? s.mySkin : null;
    if (hat === null || skin === null) {
      const w = s && s.world;
      if (w && Array.isArray(w.players) && s.myId) {
        for (const pl of w.players) {
          if (pl.id !== s.myId) continue;
          if (hat === null && Number.isFinite(pl.hat)) hat = pl.hat;
          if (skin === null && Number.isFinite(pl.skin)) skin = pl.skin;
          break;
        }
      }
    }
    return {
      hat: clamp(Math.round(Number(hat)) || 0, 0, 4),
      skin: clamp(Math.round(Number(skin)) || 0, 0, 3),
    };
  }
  function ensureLocalChar() {
    const look = myLook();
    if (!local.char) {
      local.char = createCharacter(myColor(), myName(), look);
      local.char.setNameVisible(false);
      local.char.group.visible = false;
      scene.add(local.char.group);
    }
    const c = myColor(), n = myName();
    if (local.char.colorIndex !== (c | 0) || local.char.name !== n ||
        local.char.hat !== look.hat || local.char.skin !== look.skin) {
      // Rebuild only the meshes â€” bone objects (and any rod parented to
      // handR by fishing.js) survive untouched.
      local.char.setLook(c, n, look);
      local.char.setNameVisible(false);
    }
  }

  // ---------- remote characters ----------
  function playerInfo(id) {
    const w = ctx.state.world;
    if (w && Array.isArray(w.players)) {
      for (const pl of w.players) if (pl.id === id) return pl;
    }
    return null;
  }
  // Normalised the same way createCharacter does, so change detection never
  // ping-pongs on out-of-range values.
  function lookOf(info) {
    return {
      hat: clamp(Math.round(Number(info && info.hat)) || 0, 0, 4),
      skin: clamp(Math.round(Number(info && info.skin)) || 0, 0, 3),
    };
  }
  function ensureRemote(id) {
    let r = remotes.get(id);
    const info = playerInfo(id);
    const color = info && Number.isFinite(info.color) ? info.color : 0;
    const name = (info && info.name) ? info.name : 'Angler';
    const look = lookOf(info);
    if (!r) {
      const char = createCharacter(color, name, look);
      char.group.visible = ctx.state.phase === 'playing' || ctx.state.phase === 'over';
      scene.add(char.group);
      r = {
        id, char, group: char.group, colorIndex: color, name,
        hat: char.hat, skin: char.skin,
        pos: new THREE.Vector3(), from: new THREE.Vector3(), to: new THREE.Vector3(),
        blFrom: new THREE.Vector3(), blTo: new THREE.Vector3(), blPos: new THREE.Vector3(),
        hasBl: false,
        yaw: 0, yawFrom: 0, yawTo: 0,
        lerpStart: 0, lerpDur: REMOTE_LERP,
        anim: 'idle', swimming: false, onBoat: false, seat: -1, speed: 0,
      };
      remotes.set(id, r);
    } else if (r.colorIndex !== color || r.name !== name || r.hat !== look.hat || r.skin !== look.skin) {
      r.colorIndex = color;
      r.name = name;
      r.hat = look.hat;
      r.skin = look.skin;
      r.char.setLook(color, name, look);
    }
    return r;
  }
  function removeRemote(id) {
    const r = remotes.get(id);
    if (!r) return;
    r.char.dispose();
    remotes.delete(id);
  }

  // ---------- network / bus handlers ----------
  function onPlayersMove(msg) {
    if (!msg || msg === lastMoveMsg) return;
    lastMoveMsg = msg;
    const list = msg.list;
    if (!Array.isArray(list)) return;
    const now = netTime;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e || !e.id || e.id === ctx.state.myId) continue;
      const p = e.p;
      if (!p || p.length < 3) continue;
      const r = ensureRemote(e.id);
      r.from.copy(r.pos);
      r.to.set(p[0], p[1], p[2]);
      if (r.lerpDur <= 0 || r.from.lengthSq() === 0) r.from.copy(r.to);
      // boat-local anchor: they are standing on the deck, not at an
      // absolute world position (the server relays this field untouched)
      const bl = e.bl;
      if (Array.isArray(bl) && bl.length >= 3 && Number.isFinite(bl[0]) &&
          Number.isFinite(bl[1]) && Number.isFinite(bl[2])) {
        if (r.hasBl) r.blFrom.copy(r.blPos);
        else { r.blFrom.set(bl[0], bl[1], bl[2]); r.blPos.set(bl[0], bl[1], bl[2]); }
        r.blTo.set(bl[0], bl[1], bl[2]);
        r.hasBl = true;
      } else {
        r.hasBl = false;
      }
      r.lerpStart = now;
      r.lerpDur = REMOTE_LERP;
      r.yawFrom = r.yaw;
      r.yawTo = Number.isFinite(e.r) ? e.r : r.yaw;
      r.anim = e.anim || 'idle';
      r.swimming = !!e.swimming;
      r.onBoat = !!e.onBoat;
      if (Number.isFinite(e.seat)) r.seat = e.seat;
      r.char.setAnim(r.anim);
    }
  }
  function onWorldState(msg) {
    if (!msg || msg === lastWorldMsg) return;
    lastWorldMsg = msg;
    if (!Array.isArray(msg.players)) return;
    // refresh looks + prune players who left
    for (const r of remotes.values()) {
      let found = false;
      for (const pl of msg.players) {
        if (pl.id !== r.id) continue;
        found = true;
        const c = Number.isFinite(pl.color) ? pl.color : r.colorIndex;
        const n = pl.name || r.name;
        const lk = lookOf(pl);
        if (c !== r.colorIndex || n !== r.name || lk.hat !== r.hat || lk.skin !== r.skin) {
          r.colorIndex = c; r.name = n; r.hat = lk.hat; r.skin = lk.skin;
          r.char.setLook(c, n, lk);
        }
        break;
      }
      if (!found) removeRemote(r.id);
    }
    ensureLocalChar();
  }
  function onBoatState(msg) {
    if (!msg) return;
    if (Array.isArray(msg.seats)) {
      boatSeats = msg.seats;
      const mine = boatSeatOf(ctx.state.myId);
      if (mine >= 0) {
        if (!local.onBoat || local.seat !== mine) {
          const wasAboard = local.onBoat;
          local.onDeck = false;
          local.onBoat = true;
          local.seat = mine;
          ctx.state.onDeck = false;
          ctx.state.onBoat = true;
          ctx.state.seat = mine;
          if (!wasAboard && ctx.bus) ctx.bus.emit('boardBoat', { seat: mine });
        }
      } else if (local.onBoat && !local.onDeck && boardCooldown <= 0) {
        // server says we are not seated â€” step off. Deck-standers hold no
        // seat by design, so they are exempt.
        local.onBoat = false;
        local.seat = -1;
        ctx.state.onBoat = false;
        ctx.state.seat = -1;
        if (ctx.bus) ctx.bus.emit('leaveBoat', {});
      }
    }
  }

  if (ctx.bus) {
    ctx.bus.on('playersMove', onPlayersMove);
    ctx.bus.on('worldState', onWorldState);
    ctx.bus.on('castStart', () => { castFlash = 0.92; });
    ctx.bus.on('catch', (d) => {
      if (!d || d.caught !== false) {
        if (local.char && !local.ko) local.char.setAnim('cheer');
      }
    });
    ctx.bus.on('localDamaged', (d) => {
      const dmg = d && Number.isFinite(d.dmg) ? d.dmg : 8;
      if (local.char) local.char.punch(clamp(dmg / 40, 0.18, 0.6));
      cam.shake = Math.max(cam.shake, clamp(dmg / 45, 0.1, 0.55));
    });
  }
  if (ctx.net && typeof ctx.net.on === 'function') {
    ctx.net.on(MSG.PLAYERS_MOVE, onPlayersMove);
    ctx.net.on(MSG.WORLD_STATE, onWorldState);
    ctx.net.on(MSG.BOAT_STATE, onBoatState);
    ctx.net.on(MSG.PLAYER_DAMAGED, (m) => {
      if (m && m.id === ctx.state.myId && Number.isFinite(m.hp)) ctx.state.hp = m.hp;
    });
    ctx.net.on(MSG.GAME_START, () => { local.spawned = false; });
  }

  // ---------- DOM input (mouse look / zoom / keys) ----------
  function typing() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }
  function onKeyDown(e) {
    if (typing()) return;
    keys.add(e.code);
  }
  function onKeyUp(e) { keys.delete(e.code); }
  function onBlur() { keys.clear(); }
  function onMouseMove(e) {
    if (ctx.state.phase !== 'playing') return;
    if (!document.pointerLockElement) return;
    local.yaw -= (e.movementX || 0) * MOUSE_SENS;
    local.pitch -= (e.movementY || 0) * MOUSE_SENS;
    local.pitch = clamp(local.pitch, -1.15, 1.20);
    if (local.yaw > Math.PI) local.yaw -= Math.PI * 2;
    else if (local.yaw < -Math.PI) local.yaw += Math.PI * 2;
  }
  function onWheel(e) {
    if (ctx.state.phase !== 'playing') return;
    const canvas = ctx.renderer && ctx.renderer.domElement;
    if (!document.pointerLockElement && e.target !== canvas) return;
    cam.distWant = clamp(cam.distWant + Math.sign(e.deltaY) * 0.65, 2.5, 9);
  }
  function onPointerLockChange() {
    if (ctx.input) ctx.input.pointerLocked = !!document.pointerLockElement;
  }
  function onCanvasClick() {
    if (ctx.state.phase !== 'playing') return;
    if (document.pointerLockElement) return;
    const canvas = ctx.renderer && ctx.renderer.domElement;
    if (canvas && canvas.requestPointerLock) {
      try { canvas.requestPointerLock(); } catch (err) { /* ignore */ }
    }
  }
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  document.addEventListener('mousemove', onMouseMove);
  window.addEventListener('wheel', onWheel, { passive: true });
  document.addEventListener('pointerlockchange', onPointerLockChange);
  if (ctx.renderer && ctx.renderer.domElement) {
    ctx.renderer.domElement.addEventListener('click', onCanvasClick);
  }

  // ---------- area tracking ----------
  function updateArea(x, z) {
    let found = null;
    for (let i = 0; i < AREAS.length; i++) {
      const a = AREAS[i];
      const dx = x - a.center[0], dz = z - a.center[1];
      if (dx * dx + dz * dz <= a.radius * a.radius) { found = a.id; break; }
    }
    ctx.state.currentArea = found;
  }

  // ---------- movement ----------
  function wishDir(out, yaw, forward, strafe) {
    // forward vector for yaw: (sin, 0, cos); right: (-cos, 0, sin)
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    out.set(sy * forward - cy * strafe, 0, cy * forward + sy * strafe);
    if (out.lengthSq() > 1e-6) out.normalize();
    return out;
  }

  // ---------- walking a boat deck ----------
  // The boat frame carries us: every frame the boat-local anchor is converted
  // back to world (so the hull's travel, turn, pitch and roll move us with it),
  // then the NORMAL walk controller adds its world-space displacement on top and
  // the anchor is rewritten. Camera-relative WASD is untouched.
  function updateDeckWalk(dt, t, fwd, str, running, ko, hasInput) {
    const B = boatApi();
    const char = local.char;
    const st = ctx.state;

    // 1. ride the hull
    B.toWorld(local.anchor, _v3);
    if (Number.isFinite(_v3.x)) local.pos.copy(_v3);
    const by = boatYaw();
    if (deckPrevYaw !== null && !ko) local.faceYaw += angDelta(deckPrevYaw, by);
    deckPrevYaw = by;

    // 2. the ordinary walk controller
    const wantSpeed = ko ? 0 : (running ? RUN_SPEED : WALK_SPEED);
    wishDir(_v2, local.yaw, fwd, str);
    const accel = local.grounded ? GROUND_ACCEL : AIR_ACCEL;
    const ka = 1 - Math.exp(-accel * dt);
    local.vel.x += (_v2.x * wantSpeed - local.vel.x) * ka;
    local.vel.z += (_v2.z * wantSpeed - local.vel.z) * ka;

    if (!ko && local.grounded && justDown('Space')) {
      local.vel.y = JUMP_VEL;
      local.grounded = false;
    }
    local.vel.y += GRAVITY * dt;
    if (local.vel.y < -45) local.vel.y = -45;

    // 3. our own displacement, in world space
    local.pos.x += local.vel.x * dt;
    local.pos.z += local.vel.z * dt;
    local.pos.y += local.vel.y * dt;

    // 4. ground on the deck under us
    const di = B.deckInfo(local.pos.x, local.pos.z, local.pos.y, _deckA);
    if (di) {
      local.deckY = di.y;
      if (local.pos.y <= di.y + 0.02) {
        local.pos.y = di.y;
        if (local.vel.y < 0) local.vel.y = 0;
        local.grounded = true;
      } else {
        local.grounded = false;
      }
      B.toLocal(local.pos, local.anchor);
    } else if (!local.grounded && local.pos.y > local.deckY + 0.15 &&
               typeof B.nearBoat === 'function' && B.nearBoat(local.pos)) {
      // airborne across a gap (hopping up to the cabin roof) â€” stay attached
      B.toLocal(local.pos, local.anchor);
    } else {
      stepOffDeck();                          // walked off the edge: into the drink
      return;
    }

    // 5. everything else behaves exactly like walking on land
    local.swimming = false;
    setUnderwater(false);
    st.air = Math.min(1, (st.air === undefined ? 1 : st.air) + dt / 1.2);
    drownAccum = 0;
    local.speed = Math.hypot(local.vel.x, local.vel.z);
    if (ko) local.anim = 'ko';
    else if (local.speed > RUN_SPEED * 0.62) local.anim = 'run';
    else if (local.speed > 0.35) local.anim = 'walk';
    else local.anim = 'idle';
    if (char) {
      char.setLean(0);
      char.setAirborne(!ko && !local.grounded);
    }
    if (!ko) {
      let faceTarget = local.faceYaw;
      if (hasInput && local.speed > 0.3) faceTarget = Math.atan2(local.vel.x, local.vel.z);
      else if (castFlash > 0 || isCasting()) faceTarget = local.yaw;
      else if (Math.abs(angDelta(local.faceYaw, local.yaw)) > 1.9) faceTarget = local.yaw;
      local.faceYaw = angDamp(local.faceYaw, faceTarget, hasInput ? 13 : 6, dt);
    }
    updateArea(local.pos.x, local.pos.z);
  }

  function updateLocal(dt, t) {
    const st = ctx.state;
    ensureLocalChar();
    const char = local.char;
    if (!local.spawned) { respawn(); local.spawned = true; }
    if (boardCooldown > 0) boardCooldown -= dt;
    if (vaultCd > 0) vaultCd -= dt;
    if (vaultT > 0) vaultT -= dt;
    if (castFlash > 0) castFlash -= dt;

    const ko = st.hp <= 0;
    if (ko && !wasKo && local.onBoat) {
      local.onBoat = false; local.onDeck = false; local.seat = -1;
      st.onBoat = false; st.onDeck = false; st.seat = -1;
      deckPrevYaw = null;
      send(MSG.LEAVE_BOAT, {});
      if (ctx.bus) ctx.bus.emit('leaveBoat', {});
    }
    if (!ko && wasKo) respawn();      // revived by the server -> back at camp
    wasKo = ko;
    local.ko = ko;

    const fwd = (isDown('KeyW') || isDown('ArrowUp') ? 1 : 0) - (isDown('KeyS') || isDown('ArrowDown') ? 1 : 0);
    const str = (isDown('KeyD') || isDown('ArrowRight') ? 1 : 0) - (isDown('KeyA') || isDown('ArrowLeft') ? 1 : 0);
    const running = isDown('ShiftLeft') || isDown('ShiftRight');
    const hasInput = !ko && (fwd !== 0 || str !== 0);

    // ---------------- boarding / the wheel / dismount ----------------
    if (!ko && justDown('KeyE') && boardCooldown <= 0) {
      if (local.seat === 0) {
        releaseWheel();                       // E again lets go of the wheel
      } else if (local.onDeck) {
        if (nearHelm()) takeWheel();          // step up and take the helm
        else hopOff(t);                       // hop over the side
      } else if (local.onBoat) {
        hopOff(t);                            // legacy seated rider
      } else if (ctx.boat && typeof ctx.boat.nearBoat === 'function' && ctx.boat.nearBoat(local.pos)) {
        if (nearHelm()) {
          takeWheel();
        } else if (!boardDeck()) {
          // boat.js has no deck API yet â€” fall back to the old seat flow
          const n = boatSeatCount();
          let seat = -1;
          for (let i = 0; i < n; i++) {
            if (!boatSeats || boatSeats[i] == null || boatSeats[i] === st.myId) { seat = i; break; }
          }
          if (seat >= 0) {
            setAboard(false, seat);
            local.vel.set(0, 0, 0);
            local.swimming = false;
            setUnderwater(false);
            boardCooldown = 0.45;
            send(MSG.BOARD_BOAT, { seat });
            if (ctx.bus) ctx.bus.emit('boardBoat', { seat });
          }
        }
      }
    }

    // ---------------- seated / at the helm ----------------
    if (local.onBoat && local.seat >= 0) {
      if (seatPos(local.seat, _v1, dt)) local.pos.copy(_v1);
      local.vel.set(0, 0, 0);
      local.swimming = false;
      setUnderwater(false);
      local.grounded = true;
      st.air = Math.min(1, (st.air || 0) + dt / 1.2);
      drownAccum = 0;

      const by = boatYaw();
      deckPrevYaw = by;
      local.faceYaw = local.seat === 0 ? angDamp(local.faceYaw, by, 12, dt) : angDamp(local.faceYaw, local.yaw, 10, dt);
      char.setAirborne(false);
      char.setLean(0);
      local.speed = 0;
      local.anim = ko ? 'ko' : (local.seat === 0 ? 'drive' : 'sit');
      const Bh = boatApi();
      if (Bh) Bh.toLocal(local.pos, local.anchor); else local.anchor.set(0, 0, 0);
      updateArea(local.pos.x, local.pos.z);
      return;
    }

    // ---------------- standing on the deck ----------------
    if (local.onDeck) {
      if (boatApi()) {
        updateDeckWalk(dt, t, fwd, str, running, ko, hasInput);
        return;
      }
      setAboard(false, -1);        // boat module vanished; fall back to swimming
      deckPrevYaw = null;
    }

    // ---------------- water sampling ----------------
    const groundY = surfaceH(local.pos.x, local.pos.z, local.pos.y);
    const waterY = waterH(local.pos.x, local.pos.z, t);
    const depth = waterY - groundY;

    const feetUnder = local.pos.y < waterY - 0.28;
    if (!local.swimming) {
      if (!ko && vaultT <= 0 && depth > SWIM_DEPTH_ENTER && feetUnder) {
        local.swimming = true;
        splash(local.pos.x, waterY, local.pos.z, clamp(0.6 + Math.abs(local.vel.y) * 0.12, 0.6, 2.0));
        local.vel.y *= 0.15;
      }
    } else if (depth < SWIM_DEPTH_EXIT || ko) {
      local.swimming = false;
    }

    if (local.swimming) {
      // ---------------- swimming ----------------
      const headY = local.pos.y + HEAD_SWIM;
      const under = headY < waterY - 0.05;
      setUnderwater(under);

      const diveDown = isDown('KeyC');
      const goUp = isDown('Space');
      const spd = running ? SWIM_SPRINT : SWIM_SPEED;

      // Water-exit vault: Space at the surface next to a climbable edge
      // (shore, dock decking, a boat hull) mantles you out of the sea.
      if (!under && !ko && vaultCd <= 0 && justDown('Space')) {
        const px = local.pos.x + Math.sin(local.yaw) * VAULT_REACH;
        const pz = local.pos.z + Math.cos(local.yaw) * VAULT_REACH;
        let ledgeY = surfaceH(px, pz, local.pos.y + 2.2);
        const B = ctx.boat;
        if (B && typeof B.deckInfo === 'function') {
          const di = B.deckInfo(px, pz, local.pos.y + 2.2, _deckA);
          if (di && Number.isFinite(di.y) && di.y > ledgeY) ledgeY = di.y;
        }
        const rise = ledgeY - waterY;
        if (rise >= VAULT_MIN_RISE && rise <= VAULT_MAX_RISE) {
          local.swimming = false;
          local.grounded = false;
          vaultT = VAULT_HOLD;
          vaultCd = VAULT_CD;
          // Enough launch to clear the ledge from however deep our feet float.
          const needRise = Math.max(0.9, ledgeY - local.pos.y + 0.45);
          local.vel.y = Math.max(VAULT_UP, Math.sqrt(2 * Math.abs(GRAVITY) * needRise));
          // Air friction eats ~(v / AIR_ACCEL) metres of travel - push hard
          // enough that the mantle actually carries us over the lip.
          const fwdImp = Math.max(VAULT_FWD, AIR_ACCEL * (VAULT_REACH + 0.5));
          local.vel.x = Math.sin(local.yaw) * fwdImp;
          local.vel.z = Math.cos(local.yaw) * fwdImp;
          splash(local.pos.x, waterY, local.pos.z, 1.1);
          if (ctx.audio && ctx.audio.sfx) ctx.audio.sfx('vault');
          setUnderwater(false);
          updateArea(local.pos.x, local.pos.z);
          return;
        }
      }

      // horizontal (follows camera pitch while fully submerged)
      wishDir(_v2, local.yaw, fwd, str);
      let wishY = 0;
      if (under && fwd !== 0) {
        const cp = Math.cos(local.pitch);
        _v2.set(Math.sin(local.yaw) * cp * fwd - Math.cos(local.yaw) * str,
          Math.sin(local.pitch) * fwd,
          Math.cos(local.yaw) * cp * fwd + Math.sin(local.yaw) * str);
        if (_v2.lengthSq() > 1e-6) _v2.normalize();
        wishY = _v2.y * spd;
      }
      const kx = 1 - Math.exp(-SWIM_ACCEL * dt);
      local.vel.x += (_v2.x * spd - local.vel.x) * kx;
      local.vel.z += (_v2.z * spd - local.vel.z) * kx;

      if (under) {
        let ty = wishY;
        if (diveDown) ty = -DIVE_SPEED;
        else if (goUp) ty = DIVE_SPEED;
        else if (Math.abs(wishY) < 0.05) ty = 0.45;          // gentle buoyancy
        local.vel.y += (ty - local.vel.y) * (1 - Math.exp(-7 * dt));
      } else {
        // float on the wave surface
        const targetY = waterY + SURFACE_OFFSET;
        if (diveDown) {
          local.vel.y += (-2.6 - local.vel.y) * (1 - Math.exp(-9 * dt));
        } else {
          local.pos.y = damp(local.pos.y, targetY, 7, dt);
          local.vel.y *= Math.exp(-6 * dt);
        }
      }
      local.pos.addScaledVector(local.vel, dt);
      resolveCollide(local.pos);
      const gy2 = surfaceH(local.pos.x, local.pos.z, local.pos.y);
      if (local.pos.y < gy2 + 0.05) { local.pos.y = gy2 + 0.05; if (local.vel.y < 0) local.vel.y = 0; }
      if (local.pos.y > waterY + 0.2) local.pos.y = waterY + 0.2;

      local.grounded = false;
      local.speed = Math.hypot(local.vel.x, local.vel.z);
      local.anim = ko ? 'ko' : 'swim';
      char.setAirborne(false);
      char.setLean(under ? clamp(-local.vel.y * 0.28, -0.85, 0.95) : clamp(-local.vel.y * 0.10, -0.25, 0.35));

      // surface wake
      if (!under && local.speed > 1.2) {
        swimFxAccum += dt;
        if (swimFxAccum > 0.42) {
          swimFxAccum = 0;
          if (ctx.water && typeof ctx.water.splash === 'function') {
            _v5.set(local.pos.x, waterY, local.pos.z);
            try { ctx.water.splash(_v5, 0.35); } catch (e) { /* ignore */ }
          }
        }
      }
      if (hasInput) local.faceYaw = angDamp(local.faceYaw, local.yaw, 9, dt);
    } else {
      // ---------------- on foot ----------------
      setUnderwater(local.pos.y + HEAD_STAND < waterY - 0.05);

      const wantSpeed = ko ? 0 : (running ? RUN_SPEED : WALK_SPEED);
      wishDir(_v2, local.yaw, fwd, str);
      const accel = local.grounded ? GROUND_ACCEL : AIR_ACCEL;
      const ka = 1 - Math.exp(-accel * dt);
      const wade = depth > 0.45 ? 0.6 : 1;
      local.vel.x += (_v2.x * wantSpeed * wade - local.vel.x) * ka;
      local.vel.z += (_v2.z * wantSpeed * wade - local.vel.z) * ka;

      if (!ko && local.grounded && justDown('Space')) {
        local.vel.y = JUMP_VEL;
        local.grounded = false;
      }
      local.vel.y += GRAVITY * dt;
      if (local.vel.y < -45) local.vel.y = -45;

      local.pos.addScaledVector(local.vel, dt);
      // props (palms, rocks, hut, stones, dock posts) actually block you now
      resolveCollide(local.pos);

      const gy2 = surfaceH(local.pos.x, local.pos.z, local.pos.y);
      if (local.pos.y <= gy2 + 0.02) {
        if (!local.grounded && local.vel.y < -6) {
          const wy2 = waterH(local.pos.x, local.pos.z, t);
          if (gy2 < wy2) splash(local.pos.x, wy2, local.pos.z, 0.8);
        }
        local.pos.y = gy2;
        local.vel.y = 0;
        local.grounded = true;
      } else {
        local.grounded = false;
      }

      local.speed = Math.hypot(local.vel.x, local.vel.z);
      if (ko) local.anim = 'ko';
      else if (local.speed > RUN_SPEED * 0.62) local.anim = 'run';
      else if (local.speed > 0.35) local.anim = 'walk';
      else local.anim = 'idle';
      char.setLean(0);
      char.setAirborne(!ko && !local.grounded);

      // facing
      if (!ko) {
        let faceTarget = local.faceYaw;
        if (hasInput && local.speed > 0.3) faceTarget = Math.atan2(local.vel.x, local.vel.z);
        else if (castFlash > 0 || isCasting()) faceTarget = local.yaw;
        else if (Math.abs(angDelta(local.faceYaw, local.yaw)) > 1.9) faceTarget = local.yaw;
        local.faceYaw = angDamp(local.faceYaw, faceTarget, hasInput ? 13 : 6, dt);
      }
    }

    // ---------------- air / drowning ----------------
    const cap = airCapacity();
    if (local.underwater) {
      st.air = clamp((st.air === undefined ? 1 : st.air) - dt / cap, 0, 1);
      if (st.air <= 0 && st.hp > 0) {
        drownAccum += dt;
        while (drownAccum >= 1) {
          drownAccum -= 1;
          st.hp = Math.max(0, (st.hp || 0) - 5);
          send(MSG.PLAYER_HIT, { dmg: 5, cause: 'drown' });
          if (local.char) local.char.punch(0.25);
          cam.shake = Math.max(cam.shake, 0.22);
        }
      }
    } else {
      st.air = clamp((st.air === undefined ? 1 : st.air) + dt / 1.2, 0, 1);
      drownAccum = 0;
    }

    updateArea(local.pos.x, local.pos.z);
  }

  function isCasting() {
    return !!(ctx.fishing && typeof ctx.fishing.isCasting === 'function' && ctx.fishing.isCasting());
  }

  // ---------- camera ----------
  function updateCamera(dt, t) {
    if (!camera) return;
    if (!cam.baseFov && Number.isFinite(camera.fov)) cam.baseFov = camera.fov;

    const casting = isCasting() || castFlash > 0;
    cam.shoulder = damp(cam.shoulder, casting ? 0.72 : 0, 7, dt);
    const distTarget = cam.distWant * (casting ? 0.82 : 1) * (local.ko ? 1.25 : 1);
    cam.dist = damp(cam.dist, distTarget, 8, dt);

    const headH = local.ko ? 0.55 : (local.swimming ? HEAD_SWIM : HEAD_STAND);
    _v1.set(local.pos.x, local.pos.y + headH + 0.12, local.pos.z);
    // over-the-shoulder target nudge
    const ry = -Math.cos(local.yaw), rz = Math.sin(local.yaw);
    _v1.x += ry * cam.shoulder * 0.45;
    _v1.z += rz * cam.shoulder * 0.45;

    const cp = Math.cos(local.pitch), sp = Math.sin(local.pitch);
    _v2.set(Math.sin(local.yaw) * cp, sp, Math.cos(local.yaw) * cp).normalize();
    _v3.copy(_v2).negate();   // target -> camera direction

    // pull in when terrain is in the way
    let d = cam.dist;
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      const f = cam.dist * (i / steps);
      _v4.copy(_v1).addScaledVector(_v3, f);
      if (_v4.y < surfaceH(_v4.x, _v4.z, _v4.y) + 0.45) {
        d = Math.max(1.25, cam.dist * ((i - 1) / steps));
        break;
      }
    }

    _v4.copy(_v1).addScaledVector(_v3, d);
    _v4.y += 0.12;

    const gy = surfaceH(_v4.x, _v4.z, _v4.y) + 0.35;
    if (_v4.y < gy) _v4.y = gy;
    if (!local.underwater) {
      const wy = waterH(_v4.x, _v4.z, t) + 0.25;
      if (_v4.y < wy) _v4.y = wy;
    }

    if (!cam.inited) {
      cam.pos.copy(_v4);
      cam.look.copy(_v1);
      cam.inited = true;
    } else {
      const k = 1 - Math.exp(-16 * dt);
      cam.pos.lerp(_v4, k);
      cam.look.lerp(_v1, 1 - Math.exp(-20 * dt));
    }

    camera.position.copy(cam.pos);
    if (cam.shake > 0) {
      cam.shake = Math.max(0, cam.shake - dt * 1.8);
      const s = cam.shake * 0.16;
      camera.position.x += (Math.random() - 0.5) * s;
      camera.position.y += (Math.random() - 0.5) * s;
      camera.position.z += (Math.random() - 0.5) * s;
    }
    camera.lookAt(cam.look);

    if (cam.baseFov) {
      const boost = local.anim === 'run' ? 4.5 : local.swimming && local.speed > 3.6 ? 2.5 : 0;
      const want = cam.baseFov + boost;
      if (Math.abs(camera.fov - want) > 0.01) {
        camera.fov = damp(camera.fov, want, 5, dt);
        camera.updateProjectionMatrix();
      }
    }
  }

  // ---------- remotes ----------
  function updateRemotes(dt, t) {
    if (remotes.size === 0) return;
    const now = netTime;
    const camPos = camera ? camera.position : null;
    const B = boatApi();
    for (const r of remotes.values()) {
      _v1.copy(r.pos);
      const a = r.lerpDur > 0 ? clamp((now - r.lerpStart) / r.lerpDur, 0, 1) : 1;
      let seat = -1;
      if (r.onBoat) {
        seat = boatSeatOf(r.id);
        if (seat < 0) seat = r.seat;
      }
      let localMoved = -1;
      if (r.hasBl && B) {
        // Anchored to the hull: lerp the LOCAL position and re-project every
        // frame, so they ride the boat smoothly between 12 Hz updates.
        _v5.copy(r.blPos);
        r.blPos.lerpVectors(r.blFrom, r.blTo, a);
        localMoved = _v5.distanceTo(r.blPos);
        B.toWorld(r.blPos, _v2);
        if (Number.isFinite(_v2.x)) r.pos.copy(_v2);
      } else if (r.onBoat && seat >= 0 && seatPos(seat, _v2, dt)) {
        r.pos.copy(_v2);
      } else {
        r.pos.lerpVectors(r.from, r.to, a);
      }
      const moved = localMoved >= 0 ? localMoved : _v1.distanceTo(r.pos);
      r.speed = damp(r.speed, dt > 0 ? moved / dt : 0, 10, dt);

      const a2 = a;
      r.yaw = r.yawFrom + angDelta(r.yawFrom, r.yawTo) * a2;

      const g = r.char.group;
      g.position.copy(r.pos);
      g.rotation.y = r.yaw;
      r.char.setSpeed(r.speed);
      if (r.anim === 'swim') r.char.setLean(0);
      r.char.update(dt, t);

      if (camPos && r.char.nameTag) {
        const dist = camPos.distanceTo(r.pos);
        r.char.nameTag.visible = dist < 55;
      }
    }
  }

  // ---------- outgoing MOVE ----------
  function sendMove(anim) {
    if (!ctx.state.myId) return;
    // Anchored to the hull? Ship the boat-local position so remotes can ride
    // the deck between updates instead of lagging behind it.
    const anchored = local.onBoat && (local.onDeck || local.seat >= 0) && !!boatApi();
    send(MSG.MOVE, {
      p: [Math.round(local.pos.x * 100) / 100, Math.round(local.pos.y * 100) / 100, Math.round(local.pos.z * 100) / 100],
      r: Math.round(local.faceYaw * 1000) / 1000,
      anim,
      swimming: local.swimming,
      onBoat: local.onBoat,
      seat: local.seat,
      bl: anchored
        ? [Math.round(local.anchor.x * 100) / 100, Math.round(local.anchor.y * 100) / 100, Math.round(local.anchor.z * 100) / 100]
        : null,
    });
  }

  // ---------- phase transitions ----------
  function setPhase(phase) {
    const playing = phase === 'playing';
    const visible = playing || phase === 'over';   // stay on screen for the end cinematic
    ensureLocalChar();
    if (local.char) local.char.group.visible = visible;
    for (const r of remotes.values()) r.char.group.visible = visible;
    if (playing) {
      local.spawned = false;
      cam.inited = false;
      cam.distWant = 5.5;
      ctx.state.air = 1;
      ctx.state.onDeck = false;
      drownAccum = 0;
    } else {
      setUnderwater(false);
      ctx.state.currentArea = null;
      if (phase === 'menu' || phase === 'lobby') {
        for (const id of Array.from(remotes.keys())) removeRemote(id);
        boatSeats = null;
        local.onBoat = false;
        local.onDeck = false;
        local.seat = -1;
        ctx.state.onDeck = false;
        deckPrevYaw = null;
      }
    }
  }

  // =============================================================
  // per-frame update
  // =============================================================
  function update(dt, t) {
    if (dt <= 0) dt = 1 / 60;
    netTime += dt;
    if (ctx.state.phase !== lastPhase) {
      lastPhase = ctx.state.phase;
      setPhase(lastPhase);
    }

    if (lastPhase === 'playing') {
      updateLocal(dt, t);

      const char = local.char;
      if (char) {
        char.group.position.copy(local.pos);
        char.group.rotation.y = local.faceYaw;
        char.setSpeed(local.speed);
        char.setAnim(local.anim);
        let wireAnim = local.anim;
        if (!local.ko) {
          if (castFlash > 0) { char.setAnim('cast'); wireAnim = 'cast'; }
          else if (isCasting()) { char.setAnim('reel'); wireAnim = 'reel'; }
          else if (char.getAction() === 'reel') char.clearAction();
          else if (char.getAction() === 'cheer') wireAnim = 'cheer';
        } else if (char.getAction()) {
          char.clearAction();
        }
        char.update(dt, t);
        // aim the head where the camera looks (applied after the pose damping)
        if (!local.ko && !local.swimming) {
          char.bones.head.rotation.x = clamp(char.bones.head.rotation.x - local.pitch * 0.34, -0.7, 0.7);
        }
        moveAccum += dt;
        if (moveAccum >= 1 / MOVE_HZ) {
          moveAccum = 0;
          sendMove(wireAnim);
        }
      }

      updateCamera(dt, t);
    } else if (local.char) {
      local.char.update(dt, t);
    }

    updateRemotes(dt, t);

    // key edge bookkeeping
    for (let i = 0; i < WATCH.length; i++) {
      const c = WATCH[i];
      if (keys.has(c)) prevKeys.add(c); else prevKeys.delete(c);
    }
  }

  // Build the local character right away so modules that init after us
  // (fishing.js attaches rod models to local.char.bones.handR) always
  // find a valid handle. It stays hidden until the game starts.
  ensureLocalChar();

  const handle = {
    update,
    createCharacter,
    local,
    remotes,
  };
  ctx.playerMod = handle;
  return handle;
}

export default initPlayer;
