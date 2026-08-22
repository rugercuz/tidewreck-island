// =============================================================
// TIDEWRECK ISLAND — water.js
// The ocean: Gerstner-displaced shader surface, matching CPU wave
// sampler (ctx.getWaterHeight), underwater treatment, splashes and
// drifting foam. Owns nothing else. Everything procedural.
// =============================================================

import * as THREE from 'three';
import { AREAS } from '/shared/constants.js';

// -------------------------------------------------------------
// Wave definitions — SINGLE source of truth. These exact numbers
// are uploaded to the shader AND used by the CPU sampler, so the
// boat / buoys / bobber ride precisely the surface you can see.
// dir is normalized below; amp in metres; wl = wavelength in metres.
// -------------------------------------------------------------
const WAVE_DEFS = [
  { dir: [ 1.00,  0.26 ], amp: 0.420, wl: 78.0, phase: 0.000, speed: 1.00 },
  { dir: [ 0.72, -0.69 ], amp: 0.260, wl: 46.0, phase: 1.731, speed: 1.06 },
  { dir: [ -0.38,  0.93 ], amp: 0.130, wl: 27.0, phase: 3.412, speed: 0.94 },
  { dir: [ 0.90,  0.44 ], amp: 0.062, wl: 15.5, phase: 5.021, speed: 1.12 },
];

// Distance fade for each wave, expressed in multiples of its own
// wavelength. Keeps short waves from aliasing on the coarse far grid.
// Applied identically on CPU and GPU so sampling never drifts.
const DAMP_NEAR = 3.0;
const DAMP_FAR = 12.0;

// Analytic seabed-depth proxy (metres below sea level). Drives the
// deep→shallow colour gradient, near-shore transparency and wave
// shoaling. Mirrored exactly in GLSL via the constants below.
const DEPTH = {
  shelfR: 108.0,      // island shore radius
  shelfSlope: 0.34,   // how fast the shelf falls away
  oceanMax: 30.0,     // generic ocean floor for colouring purposes
  landMin: -6.0,      // "negative depth" over the island
  offshore0: 104.0,   // area wells only start mattering past the beach
  offshore1: 168.0,
  areaIn: 0.30,       // area well core (fraction of area radius)
  areaOut: 1.18,      // area well feather
  colorMax: 26.0,     // depth at which the deep colour saturates
  shoal0: -1.0,       // wave amplitude ramps in across this depth range
  shoal1: 7.0,
  shoalMin: 0.16,
};

const PLANE_SIZE = 2000;   // full extent, metres
const PLANE_SEGS = 192;    // segments per axis (non-uniform radial spacing)
const PLANE_STEP0 = 0.9;   // grid spacing at the camera, metres

const DROPLET_POOL = 448;
const RING_POOL = 12;
const FLECK_COUNT = 130;
const BUBBLE_POOL = 160;

const TAU = Math.PI * 2;

// -------------------------------------------------------------
// Day/night palette. Interpolated on ctx.state.timeOfDay (0..1).
// -------------------------------------------------------------
const PALETTE = [
  { t: 0.00, deep: 0x030b18, shal: 0x0a2436, sky: 0x101c34, hor: 0x1b2946, sun: 0x9fc0ff, foam: 0xbcd0e8, sss: 0x14324a, str: 0.30 },
  { t: 0.17, deep: 0x040e1c, shal: 0x0d2a3e, sky: 0x14243f, hor: 0x2a3556, sun: 0xa8c6ff, foam: 0xc2d6ec, sss: 0x18384f, str: 0.33 },
  { t: 0.23, deep: 0x0a1a2e, shal: 0x1c4457, sky: 0x40456e, hor: 0x8a6a86, sun: 0xffb9a0, foam: 0xdcd0d8, sss: 0x2a4a5e, str: 0.46 },
  { t: 0.28, deep: 0x102838, shal: 0x36808c, sky: 0xf0a172, hor: 0xffd3a0, sun: 0xffb066, foam: 0xffe6d0, sss: 0x8a5a3a, str: 0.86 },
  { t: 0.36, deep: 0x0a3a58, shal: 0x36b0b4, sky: 0xa8cfee, hor: 0xe4eef8, sun: 0xfff0d4, foam: 0xffffff, sss: 0x2fa08c, str: 1.00 },
  { t: 0.50, deep: 0x073a5c, shal: 0x3ec8bd, sky: 0x86c4ee, hor: 0xd6ecfa, sun: 0xfff6e2, foam: 0xffffff, sss: 0x35b49a, str: 1.10 },
  { t: 0.62, deep: 0x0a3a58, shal: 0x3cbdb6, sky: 0x9ac8ea, hor: 0xe8eaf0, sun: 0xfff0d0, foam: 0xfffdf6, sss: 0x33a892, str: 1.00 },
  { t: 0.70, deep: 0x14283e, shal: 0x4f93a0, sky: 0xff9a5c, hor: 0xffc884, sun: 0xff8a44, foam: 0xffe0c0, sss: 0x9a5a34, str: 0.92 },
  { t: 0.76, deep: 0x0c1a2e, shal: 0x2a5a72, sky: 0x9a5a7a, hor: 0xd4787a, sun: 0xff7a52, foam: 0xe8c8c8, sss: 0x5a3a52, str: 0.56 },
  { t: 0.84, deep: 0x050f1e, shal: 0x102c40, sky: 0x1c2542, hor: 0x33395c, sun: 0xa8c0ff, foam: 0xc0d2e8, sss: 0x1a3a50, str: 0.35 },
  { t: 1.00, deep: 0x030b18, shal: 0x0a2436, sky: 0x101c34, hor: 0x1b2946, sun: 0x9fc0ff, foam: 0xbcd0e8, sss: 0x14324a, str: 0.30 },
];

// Horror-event water tints (multiplied into the body colours).
const EVENT_TINT = {
  serpent: [0.62, 1.06, 0.80],
  kraken: [0.92, 0.60, 1.22],
  bloop: [1.30, 0.48, 0.46],
};

// -------------------------------------------------------------
// small math helpers (JS mirrors of the GLSL builtins used)
// -------------------------------------------------------------
function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
function lerp(a, b, t) { return a + (b - a) * t; }
function f(n) { return Number(n).toFixed(5); }

// -------------------------------------------------------------
// Procedural canvas textures
// -------------------------------------------------------------
function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  return c;
}
function finishTex(canvas) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 1;
  tex.needsUpdate = true;
  return tex;
}

function makeDropletTexture() {
  const S = 64, c = makeCanvas(S), g = c.getContext('2d');
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0.00, 'rgba(255,255,255,1)');
  grd.addColorStop(0.22, 'rgba(238,250,255,0.92)');
  grd.addColorStop(0.50, 'rgba(190,228,248,0.42)');
  grd.addColorStop(0.78, 'rgba(150,205,235,0.12)');
  grd.addColorStop(1.00, 'rgba(120,180,220,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  return finishTex(c);
}

function makeFleckTexture() {
  const S = 64, c = makeCanvas(S), g = c.getContext('2d');
  g.clearRect(0, 0, S, S);
  // a few overlapping soft blobs => organic foam speck
  const blobs = [[0.50, 0.50, 0.30], [0.38, 0.44, 0.20], [0.62, 0.56, 0.19], [0.46, 0.62, 0.15]];
  for (let i = 0; i < blobs.length; i++) {
    const b = blobs[i];
    const grd = g.createRadialGradient(b[0] * S, b[1] * S, 0, b[0] * S, b[1] * S, b[2] * S);
    grd.addColorStop(0.0, 'rgba(255,255,255,0.85)');
    grd.addColorStop(0.55, 'rgba(240,250,255,0.35)');
    grd.addColorStop(1.0, 'rgba(220,240,250,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.arc(b[0] * S, b[1] * S, b[2] * S, 0, TAU);
    g.fill();
  }
  return finishTex(c);
}

function makeBubbleTexture() {
  const S = 64, c = makeCanvas(S), g = c.getContext('2d');
  g.clearRect(0, 0, S, S);
  const grd = g.createRadialGradient(S / 2, S / 2, S * 0.16, S / 2, S / 2, S * 0.5);
  grd.addColorStop(0.00, 'rgba(190,240,255,0.10)');
  grd.addColorStop(0.62, 'rgba(210,245,255,0.18)');
  grd.addColorStop(0.82, 'rgba(255,255,255,0.85)');
  grd.addColorStop(0.94, 'rgba(200,238,255,0.35)');
  grd.addColorStop(1.00, 'rgba(180,225,250,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  // specular highlight
  const hg = g.createRadialGradient(S * 0.36, S * 0.34, 0, S * 0.36, S * 0.34, S * 0.14);
  hg.addColorStop(0, 'rgba(255,255,255,0.9)');
  hg.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = hg;
  g.beginPath();
  g.arc(S * 0.36, S * 0.34, S * 0.14, 0, TAU);
  g.fill();
  return finishTex(c);
}

function makeRingTexture() {
  const S = 160, c = makeCanvas(S), g = c.getContext('2d');
  g.clearRect(0, 0, S, S);
  const cx = S / 2, cy = S / 2;
  const grd = g.createRadialGradient(cx, cy, 0, cx, cy, S / 2);
  grd.addColorStop(0.00, 'rgba(255,255,255,0)');
  grd.addColorStop(0.46, 'rgba(255,255,255,0)');
  grd.addColorStop(0.62, 'rgba(240,252,255,0.30)');
  grd.addColorStop(0.76, 'rgba(255,255,255,0.95)');
  grd.addColorStop(0.87, 'rgba(228,246,255,0.42)');
  grd.addColorStop(1.00, 'rgba(210,238,252,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  // foamy irregular edge: scatter soft dots around the annulus
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 90; i++) {
    const a = (i / 90) * TAU + Math.sin(i * 2.7) * 0.05;
    const r = (0.70 + Math.abs(Math.sin(i * 5.13)) * 0.13) * (S / 2);
    const rad = (1.6 + Math.abs(Math.sin(i * 3.7)) * 4.4);
    const dg = g.createRadialGradient(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 0,
      cx + Math.cos(a) * r, cy + Math.sin(a) * r, rad);
    dg.addColorStop(0, 'rgba(255,255,255,0.55)');
    dg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = dg;
    g.beginPath();
    g.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, rad, 0, TAU);
    g.fill();
  }
  g.globalCompositeOperation = 'source-over';
  return finishTex(c);
}

function makeVignetteTexture() {
  const S = 256, c = makeCanvas(S), g = c.getContext('2d');
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S * 0.72);
  grd.addColorStop(0.00, 'rgba(255,255,255,0.34)');
  grd.addColorStop(0.42, 'rgba(255,255,255,0.46)');
  grd.addColorStop(0.74, 'rgba(255,255,255,0.78)');
  grd.addColorStop(1.00, 'rgba(255,255,255,1.0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  return finishTex(c);
}

// -------------------------------------------------------------
// GLSL shared between vertex and fragment stages
// -------------------------------------------------------------
const AREA_COUNT = Math.max(1, AREAS.length);

const GLSL_COMMON = `
uniform float uTime;
uniform float uWaveScale;
uniform vec4  uWaveA[4];   // dirX, dirZ, amplitude, wavelength
uniform vec2  uWaveB[4];   // phase, speedMult
uniform vec4  uAreas[${AREA_COUNT}]; // cx, cz, radius, depth

float seaDepth(vec2 p) {
  float r = length(p);
  float d = (r - ${f(DEPTH.shelfR)}) * ${f(DEPTH.shelfSlope)};
  d = min(d, ${f(DEPTH.oceanMax)});
  d = max(d, ${f(DEPTH.landMin)});
  float offshore = smoothstep(${f(DEPTH.offshore0)}, ${f(DEPTH.offshore1)}, r);
  for (int i = 0; i < ${AREA_COUNT}; i++) {
    vec4 A = uAreas[i];
    float w = (1.0 - smoothstep(A.z * ${f(DEPTH.areaIn)}, A.z * ${f(DEPTH.areaOut)}, distance(p, A.xy))) * offshore;
    d = max(d, mix(d, A.w, w));
  }
  return d;
}

float shoalFrom(float d) {
  return clamp(smoothstep(${f(DEPTH.shoal0)}, ${f(DEPTH.shoal1)}, d), ${f(DEPTH.shoalMin)}, 1.0);
}

float waveDamp(vec2 g, float wl) {
  float dc = distance(g, cameraPosition.xz);
  return 1.0 - smoothstep(wl * ${f(DAMP_NEAR)}, wl * ${f(DAMP_FAR)}, dc);
}

// Gerstner sum. sc = shoal * global scale.
// disp  = surface displacement (xz lateral, y vertical)
// bAcc  = (dPy/dPx, dPy/dPz, 0)
// sAcc  = (Sxx, Szz, Sxz) lateral derivative accumulators
void gerstnerSum(vec2 g, float sc, out vec3 disp, out vec3 bAcc, out vec3 sAcc) {
  disp = vec3(0.0);
  bAcc = vec3(0.0);
  sAcc = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    vec2 dir = normalize(uWaveA[i].xy);
    float wl = uWaveA[i].w;
    float k = 6.28318530718 / wl;
    float amp = uWaveA[i].z * sc * waveDamp(g, wl);
    float c = sqrt(9.81 / k) * uWaveB[i].y;
    float ph = k * dot(dir, g) - k * c * uTime + uWaveB[i].x;
    float sf = sin(ph);
    float cf = cos(ph);
    float ak = amp * k;
    disp.x += dir.x * amp * cf;
    disp.y += amp * sf;
    disp.z += dir.y * amp * cf;
    bAcc.x += dir.x * ak * cf;
    bAcc.y += dir.y * ak * cf;
    sAcc.x += dir.x * dir.x * ak * sf;
    sAcc.y += dir.y * dir.y * ak * sf;
    sAcc.z += dir.x * dir.y * ak * sf;
  }
}
`;

const WATER_VERT = `
${GLSL_COMMON}

varying vec3 vWorldPos;
varying vec2 vGrid;
varying float vHeight;
varying float vDepth;
varying float vShoal;

#include <fog_pars_vertex>

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec2 g = wp.xz;
  vGrid = g;

  float d = seaDepth(g);
  vDepth = d;
  float sc = shoalFrom(d) * uWaveScale;
  vShoal = sc;

  vec3 disp, bAcc, sAcc;
  gerstnerSum(g, sc, disp, bAcc, sAcc);

  vec3 world = vec3(g.x + disp.x, disp.y, g.y + disp.z);
  vHeight = disp.y;
  vWorldPos = world;

  vec4 mvPosition = viewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  #ifdef USE_FOG
    vFogDepth = -mvPosition.z;
  #endif
}
`;

const WATER_FRAG = `
${GLSL_COMMON}

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uHorizonColor;
uniform vec3 uDeepColor;
uniform vec3 uShallowColor;
uniform vec3 uFoamColor;
uniform vec3 uSssColor;
uniform float uSunStrength;
uniform float uMaxAmp;
uniform float uUnderwater;
uniform float uNight;

varying vec3 vWorldPos;
varying vec2 vGrid;
varying float vHeight;
varying float vDepth;
varying float vShoal;

#include <fog_pars_fragment>

// hash over integer cells; wrapped so far-out world coords keep
// enough float precision to stay noisy instead of banding
float hash21(vec2 p) {
  p = mod(p, 289.0);
  vec3 p3 = fract(vec3(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, vec3(p3.y, p3.z, p3.x) + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 fr = fract(p);
  fr = fr * fr * (3.0 - 2.0 * fr);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, fr.x), mix(c, d, fr.x), fr.y);
}

// high frequency chop, normals only (never displaced => never aliases geometry)
void ripples(vec2 g, float sc, float distCam, inout vec3 bAcc) {
  float fade = 1.0 - smoothstep(14.0, 130.0, distCam);
  if (fade <= 0.001) return;
  float base = 0.030 * sc * fade;

  vec2 d1 = vec2(0.8321, 0.5546); float k1 = 1.05; float a1 = base;
  vec2 d2 = vec2(-0.5145, 0.8575); float k2 = 2.13; float a2 = base * 0.44;
  vec2 d3 = vec2(0.3162, -0.9487); float k3 = 4.37; float a3 = base * 0.18;

  float p1 = k1 * dot(d1, g) - uTime * 2.10;
  float p2 = k2 * dot(d2, g) - uTime * 3.05;
  float p3 = k3 * dot(d3, g) - uTime * 4.40;

  bAcc.x += d1.x * a1 * k1 * cos(p1) + d2.x * a2 * k2 * cos(p2) + d3.x * a3 * k3 * cos(p3);
  bAcc.y += d1.y * a1 * k1 * cos(p1) + d2.y * a2 * k2 * cos(p2) + d3.y * a3 * k3 * cos(p3);
}

void main() {
  vec3 disp, bAcc, sAcc;
  gerstnerSum(vGrid, vShoal, disp, bAcc, sAcc);

  vec3 V = cameraPosition - vWorldPos;
  float distCam = length(V.xz);
  V = normalize(V);

  ripples(vGrid, vShoal, distCam, bAcc);

  vec3 Tx = vec3(1.0 - sAcc.x, bAcc.x, -sAcc.z);
  vec3 Tz = vec3(-sAcc.z, bAcc.y, 1.0 - sAcc.y);
  vec3 N = normalize(cross(Tz, Tx));

  bool front = gl_FrontFacing;
  if (!front) N = -N;

  vec3 L = uSunDir;
  float sunUp = clamp(L.y * 3.0 + 0.06, 0.0, 1.0);
  float depth = vDepth;
  float dc = clamp(depth / ${f(DEPTH.colorMax)}, 0.0, 1.0);
  float hn = clamp(vHeight / max(0.05, uMaxAmp), -1.0, 1.0);

  // --- body colour: shallow turquoise -> deep indigo -------------
  vec3 body = mix(uShallowColor, uDeepColor, smoothstep(0.02, 0.72, dc));
  body *= 1.0 + hn * 0.12;

  float dif = clamp(dot(N, L) * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = body * (0.70 + 0.42 * dif * uSunStrength);

  // --- subsurface glow through the back of a wave ---------------
  vec3 Lh = normalize(vec3(-L.x, 0.32, -L.z));
  float sss = pow(clamp(dot(V, Lh), 0.0, 1.0), 3.0) * clamp(hn * 0.6 + 0.45, 0.0, 1.0);
  col += uSssColor * sss * (0.55 * uSunStrength) * (1.0 - dc * 0.45);

  // --- sky reflection with schlick fresnel ----------------------
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float fres = 0.022 + 0.978 * pow(1.0 - ndv, 5.0);
  vec3 R = reflect(-V, N);
  vec3 skyCol = mix(uHorizonColor, uSkyColor, smoothstep(0.0, 0.52, R.y));

  // --- sun / moon specular glints -------------------------------
  vec3 H = normalize(V + L);
  float ndh = clamp(dot(N, H), 0.0, 1.0);
  float glintNoise = 0.55 + 0.45 * vnoise(vGrid * 0.9 + vec2(uTime * 0.35, -uTime * 0.27));
  float spec = pow(ndh, 480.0) * 3.4 * glintNoise + pow(ndh, 44.0) * 0.20;
  spec *= sunUp;

  // --- foam: crests + shoreline band + sparkle ------------------
  float slope = length(bAcc.xy);
  float crest = smoothstep(0.44, 0.96, hn) * smoothstep(0.045, 0.30, slope);
  float fmask = 0.30 + 0.70 * vnoise(vGrid * 0.42 + vec2(uTime * 0.11, uTime * 0.07));
  crest *= fmask;

  float shoreT = 1.0 - smoothstep(0.0, 2.6, depth);
  float band = 0.5 + 0.5 * sin(depth * 4.6 - uTime * 1.55 + vnoise(vGrid * 0.55) * 5.0);
  float shoreFoam = shoreT * shoreT * (0.28 + 0.72 * band);

  float foam = clamp(crest * 0.85 + shoreFoam * 0.9, 0.0, 1.0);

  float sparkFade = 1.0 - smoothstep(24.0, 200.0, distCam);
  float sw = sin(vGrid.x * 2.71 + uTime * 1.7) * sin(vGrid.y * 3.13 - uTime * 1.31)
           * sin((vGrid.x + vGrid.y) * 1.91 + uTime * 2.27);
  float sparkle = pow(max(sw, 0.0), 9.0) * sparkFade * (0.35 + 0.65 * sunUp);

  col = mix(col, skyCol, fres * 0.94);
  col += uSunColor * spec * uSunStrength;
  col = mix(col, uFoamColor, foam * 0.92);
  col += uFoamColor * sparkle * (0.45 + 0.55 * uSunStrength);
  col += uFoamColor * uNight * 0.012 * sparkle;

  float alpha = mix(0.38, 0.965, smoothstep(-0.6, 5.5, depth));
  alpha = clamp(alpha + fres * 0.42 + foam * 0.6, 0.0, 1.0);

  // --- seen from below: snell's window + total internal reflection
  if (!front) {
    float f2 = clamp(dot(N, V), 0.0, 1.0);
    float windowT = smoothstep(0.50, 0.80, f2);
    vec3 through = mix(uHorizonColor, uSkyColor, 0.55);
    vec3 under = mix(uDeepColor * 0.62 + uShallowColor * 0.16, through * 1.08, windowT);
    // sunbeam refracted through the window
    under += uSunColor * uSunStrength * 0.75 * pow(windowT, 3.0) * pow(clamp(dot(V, L), 0.0, 1.0), 10.0);
    // rippled caustic shimmer clinging to the underside
    float caustic = pow(clamp(1.0 - f2, 0.0, 1.0), 2.0) * (0.4 + 0.6 * vnoise(vGrid * 1.6 + vec2(uTime * 0.5, uTime * 0.31)));
    under += uFoamColor * caustic * 0.10 * uSunStrength;
    under += uFoamColor * spec * 0.35 * windowT;
    col = under;
    alpha = mix(0.94, 0.52, windowT);
  }

  // slightly clear the surface while the camera is submerged so the
  // player can read the world above them
  alpha *= mix(1.0, 0.86, uUnderwater);

  gl_FragColor = vec4(col, alpha);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

// -------------------------------------------------------------
// Sprite-points shader (droplets / flecks / bubbles)
// -------------------------------------------------------------
const POINT_VERT = `
uniform float uPixelScale;
attribute float aSize;
attribute float aAlpha;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aSize * uPixelScale / max(0.12, -mv.z), 1.0, 190.0);
  vAlpha = aAlpha;
}
`;

const POINT_FRAG = `
uniform sampler2D uTex;
uniform vec3 uColor;
varying float vAlpha;
void main() {
  if (vAlpha <= 0.002) discard;
  vec4 t = texture2D(uTex, gl_PointCoord);
  if (t.a <= 0.003) discard;
  gl_FragColor = vec4(uColor * t.rgb, t.a * vAlpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// =============================================================
export function initWater(ctx) {
  const scene = ctx.scene;

  // ---------------------------------------------------------
  // Precompute wave constants shared by CPU and GPU
  // ---------------------------------------------------------
  const waves = WAVE_DEFS.map((d) => {
    const len = Math.hypot(d.dir[0], d.dir[1]) || 1;
    const dx = d.dir[0] / len;
    const dz = d.dir[1] / len;
    const k = TAU / d.wl;
    const c = Math.sqrt(9.81 / k) * d.speed;
    return { dx, dz, k, c, omega: k * c, amp: d.amp, wl: d.wl, phase: d.phase, speed: d.speed };
  });
  const maxAmp = waves.reduce((s, w) => s + w.amp, 0);

  // ---------------------------------------------------------
  // CPU wave field (must mirror GLSL exactly)
  // ---------------------------------------------------------
  let camX = 0, camZ = 0;
  let waveScale = 1.0;      // live, smoothed
  let waveScaleBase = 1.0;  // authored multiplier (setWaveScale)
  let simTime = 0;

  const areaData = AREAS.map((a) => ({
    x: a.center[0], z: a.center[1], r: Math.max(1, a.radius), d: a.depth,
  }));

  function seaDepthAt(x, z) {
    const r = Math.sqrt(x * x + z * z);
    let d = (r - DEPTH.shelfR) * DEPTH.shelfSlope;
    if (d > DEPTH.oceanMax) d = DEPTH.oceanMax;
    if (d < DEPTH.landMin) d = DEPTH.landMin;
    const offshore = smoothstep(DEPTH.offshore0, DEPTH.offshore1, r);
    for (let i = 0; i < areaData.length; i++) {
      const A = areaData[i];
      const dx = x - A.x, dz = z - A.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const w = (1 - smoothstep(A.r * DEPTH.areaIn, A.r * DEPTH.areaOut, dist)) * offshore;
      const blended = d + (A.d - d) * w;
      if (blended > d) d = blended;
    }
    return d;
  }

  function shoalAt(x, z) {
    const s = smoothstep(DEPTH.shoal0, DEPTH.shoal1, seaDepthAt(x, z));
    return s < DEPTH.shoalMin ? DEPTH.shoalMin : s;
  }

  // scratch for the gerstner evaluation (no per-frame allocation)
  const _g = { x: 0, y: 0, z: 0, bx: 0, bz: 0, sxx: 0, szz: 0, sxz: 0 };

  function gerstnerAt(px, pz, t, wantDeriv) {
    const sc = shoalAt(px, pz) * waveScale;
    const ddx = px - camX, ddz = pz - camZ;
    const dcam = Math.sqrt(ddx * ddx + ddz * ddz);
    let dx = 0, dy = 0, dz = 0, bx = 0, bz = 0, sxx = 0, szz = 0, sxz = 0;
    for (let i = 0; i < waves.length; i++) {
      const w = waves[i];
      const damp = 1 - smoothstep(w.wl * DAMP_NEAR, w.wl * DAMP_FAR, dcam);
      if (damp <= 0) continue;
      const amp = w.amp * sc * damp;
      const ph = w.k * (w.dx * px + w.dz * pz) - w.omega * t + w.phase;
      const sf = Math.sin(ph), cf = Math.cos(ph);
      dx += w.dx * amp * cf;
      dy += amp * sf;
      dz += w.dz * amp * cf;
      if (wantDeriv) {
        const ak = amp * w.k;
        bx += w.dx * ak * cf;
        bz += w.dz * ak * cf;
        sxx += w.dx * w.dx * ak * sf;
        szz += w.dz * w.dz * ak * sf;
        sxz += w.dx * w.dz * ak * sf;
      }
    }
    _g.x = dx; _g.y = dy; _g.z = dz;
    _g.bx = bx; _g.bz = bz; _g.sxx = sxx; _g.szz = szz; _g.sxz = sxz;
    return _g;
  }

  // Gerstner waves displace laterally, so recover the grid parameter
  // that lands on (x, z) before reading the height. Three fixed-point
  // steps are plenty at our steepness and keep floaters glued on.
  function getWaterHeight(x, z, t) {
    const tt = (typeof t === 'number' && isFinite(t)) ? t : simTime;
    let gx = x, gz = z;
    for (let i = 0; i < 3; i++) {
      gerstnerAt(gx, gz, tt, false);
      gx = x - _g.x;
      gz = z - _g.z;
    }
    gerstnerAt(gx, gz, tt, false);
    return _g.y;
  }

  // Cheap single-evaluation height for decorative particles.
  function heightFast(x, z, t) {
    gerstnerAt(x, z, (typeof t === 'number' && isFinite(t)) ? t : simTime, false);
    return _g.y;
  }

  const _n1 = new THREE.Vector3();
  const _n2 = new THREE.Vector3();
  function getWaterNormal(x, z, t, out) {
    const target = out || new THREE.Vector3();
    const tt = (typeof t === 'number' && isFinite(t)) ? t : simTime;
    let gx = x, gz = z;
    for (let i = 0; i < 3; i++) {
      gerstnerAt(gx, gz, tt, false);
      gx = x - _g.x;
      gz = z - _g.z;
    }
    gerstnerAt(gx, gz, tt, true);
    _n1.set(1 - _g.sxx, _g.bx, -_g.sxz);   // dP/dx
    _n2.set(-_g.sxz, _g.bz, 1 - _g.szz);   // dP/dz
    target.crossVectors(_n2, _n1).normalize();
    if (target.y < 0) target.negate();
    return target;
  }

  ctx.getWaterHeight = getWaterHeight;
  ctx.getWaterNormal = getWaterNormal;

  // ---------------------------------------------------------
  // Ocean geometry: camera-centred grid, radially graded so the
  // detail sits where the player is and the horizon stays cheap.
  // ---------------------------------------------------------
  function buildAxis(half, segs, step0) {
    const n = segs / 2;
    const sum = (g) => (Math.abs(g - 1) < 1e-9 ? step0 * n : step0 * (Math.pow(g, n) - 1) / (g - 1));
    let lo = 1.0000001, hi = 1.25;
    for (let it = 0; it < 90; it++) {
      const mid = (lo + hi) * 0.5;
      if (sum(mid) < half) lo = mid; else hi = mid;
    }
    const g = (lo + hi) * 0.5;
    const arr = new Float64Array(segs + 1);
    let acc = 0, s = step0;
    arr[n] = 0;
    for (let i = 1; i <= n; i++) {
      acc += s;
      s *= g;
      arr[n + i] = acc;
      arr[n - i] = -acc;
    }
    const scl = half / (acc || 1);
    for (let i = 0; i <= segs; i++) arr[i] *= scl;
    return arr;
  }

  const axis = buildAxis(PLANE_SIZE * 0.5, PLANE_SEGS, PLANE_STEP0);
  const side = PLANE_SEGS + 1;
  const vertCount = side * side;
  const positions = new Float32Array(vertCount * 3);
  for (let iz = 0; iz < side; iz++) {
    const z = axis[iz];
    for (let ix = 0; ix < side; ix++) {
      const o = (ix + side * iz) * 3;
      positions[o] = axis[ix];
      positions[o + 1] = 0;
      positions[o + 2] = z;
    }
  }
  const indices = new Uint32Array(PLANE_SEGS * PLANE_SEGS * 6);
  let ii = 0;
  for (let iz = 0; iz < PLANE_SEGS; iz++) {
    for (let ix = 0; ix < PLANE_SEGS; ix++) {
      const a = ix + side * iz;
      const b = ix + side * (iz + 1);
      const c = (ix + 1) + side * (iz + 1);
      const d = (ix + 1) + side * iz;
      indices[ii++] = a; indices[ii++] = b; indices[ii++] = d;
      indices[ii++] = b; indices[ii++] = c; indices[ii++] = d;
    }
  }
  const waterGeo = new THREE.BufferGeometry();
  waterGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  waterGeo.setIndex(new THREE.BufferAttribute(indices, 1));
  waterGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), PLANE_SIZE);

  // ---------------------------------------------------------
  // Uniforms + material (one material for the whole ocean)
  // ---------------------------------------------------------
  const waveAUniform = waves.map((w) => new THREE.Vector4(w.dx, w.dz, w.amp, w.wl));
  const waveBUniform = waves.map((w) => new THREE.Vector2(w.phase, w.speed));
  const areaUniform = areaData.map((a) => new THREE.Vector4(a.x, a.z, a.r, a.d));

  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uTime: { value: 0 },
      uWaveScale: { value: 1 },
      uMaxAmp: { value: maxAmp },
      uSunDir: { value: new THREE.Vector3(0.35, 0.72, -0.6).normalize() },
      uSunColor: { value: new THREE.Color(0xfff6e2) },
      uSkyColor: { value: new THREE.Color(0x86c4ee) },
      uHorizonColor: { value: new THREE.Color(0xd6ecfa) },
      uDeepColor: { value: new THREE.Color(0x073a5c) },
      uShallowColor: { value: new THREE.Color(0x3ec8bd) },
      uFoamColor: { value: new THREE.Color(0xffffff) },
      uSssColor: { value: new THREE.Color(0x35b49a) },
      uSunStrength: { value: 1 },
      uUnderwater: { value: 0 },
      uNight: { value: 0 },
    },
  ]);
  // uniform arrays are attached after the merge so we keep live references
  uniforms.uWaveA = { value: waveAUniform };
  uniforms.uWaveB = { value: waveBUniform };
  uniforms.uAreas = { value: areaUniform };

  const waterMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
  });

  const waterMesh = new THREE.Mesh(waterGeo, waterMat);
  waterMesh.name = 'ocean';
  waterMesh.frustumCulled = false;
  waterMesh.renderOrder = -1;
  waterMesh.matrixAutoUpdate = true;
  waterMesh.receiveShadow = false;
  waterMesh.castShadow = false;
  scene.add(waterMesh);

  // Analytic raycast against the wave surface — far cheaper (and more
  // correct) than testing 73k triangles that live flat in the buffer.
  const _rcPoint = new THREE.Vector3();
  waterMesh.raycast = function raycastWater(raycaster, intersects) {
    const ray = raycaster.ray;
    const dy = ray.direction.y;
    if (Math.abs(dy) < 1e-6) return;
    let tHit = -ray.origin.y / dy;
    if (!isFinite(tHit) || tHit < 0) return;
    for (let i = 0; i < 4; i++) {
      _rcPoint.copy(ray.direction).multiplyScalar(tHit).add(ray.origin);
      const h = getWaterHeight(_rcPoint.x, _rcPoint.z, simTime);
      tHit += (h - _rcPoint.y) / dy;
      if (!isFinite(tHit) || tHit < 0) return;
    }
    if (tHit < raycaster.near || tHit > raycaster.far) return;
    _rcPoint.copy(ray.direction).multiplyScalar(tHit).add(ray.origin);
    intersects.push({
      distance: tHit,
      point: _rcPoint.clone(),
      object: waterMesh,
      face: null,
      faceIndex: -1,
      uv: null,
    });
  };

  // ---------------------------------------------------------
  // Shared sprite textures
  // ---------------------------------------------------------
  const texDrop = makeDropletTexture();
  const texFleck = makeFleckTexture();
  const texBubble = makeBubbleTexture();
  const texRing = makeRingTexture();
  const texVignette = makeVignetteTexture();

  function makePointsMaterial(tex, blending, colorHex) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTex: { value: tex },
        uColor: { value: new THREE.Color(colorHex) },
        uPixelScale: { value: 600 },
      },
      vertexShader: POINT_VERT,
      fragmentShader: POINT_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending,
    });
  }

  function makePointsCloud(count, material, renderOrder) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const alpha = new Float32Array(count);
    for (let i = 0; i < count; i++) pos[i * 3 + 1] = -9999;
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e6);
    const pts = new THREE.Points(geo, material);
    pts.frustumCulled = false;
    pts.renderOrder = renderOrder;
    scene.add(pts);
    return { pts, geo, pos, size, alpha };
  }

  // ---------------------------------------------------------
  // Splash droplets
  // ---------------------------------------------------------
  const dropMat = makePointsMaterial(texDrop, THREE.AdditiveBlending, 0xffffff);
  const drops = makePointsCloud(DROPLET_POOL, dropMat, 4);
  const dropVel = new Float32Array(DROPLET_POOL * 3);
  const dropLife = new Float32Array(DROPLET_POOL);
  const dropMax = new Float32Array(DROPLET_POOL);
  const dropBase = new Float32Array(DROPLET_POOL);
  let dropCursor = 0;
  let dropsDirty = false;

  function nextDrop() {
    for (let i = 0; i < DROPLET_POOL; i++) {
      const idx = (dropCursor + i) % DROPLET_POOL;
      if (dropLife[idx] <= 0) {
        dropCursor = (idx + 1) % DROPLET_POOL;
        return idx;
      }
    }
    const idx = dropCursor;
    dropCursor = (dropCursor + 1) % DROPLET_POOL;
    return idx;
  }

  // ---------------------------------------------------------
  // Foam rings
  // ---------------------------------------------------------
  const ringGeo = new THREE.PlaneGeometry(1, 1);
  ringGeo.rotateX(-Math.PI / 2);
  const ringMatBase = new THREE.MeshBasicMaterial({
    map: texRing,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    color: 0xffffff,
    fog: true,
    toneMapped: true,
  });
  const rings = [];
  for (let i = 0; i < RING_POOL; i++) {
    const mat = ringMatBase.clone();
    mat.opacity = 0;
    const m = new THREE.Mesh(ringGeo, mat);
    m.visible = false;
    m.renderOrder = 3;
    m.frustumCulled = false;
    scene.add(m);
    rings.push({ mesh: m, mat, age: 0, life: 0, r0: 1, r1: 3, peak: 0.8, x: 0, z: 0 });
  }
  let ringCursor = 0;

  // ---------------------------------------------------------
  // Ambient foam flecks
  // ---------------------------------------------------------
  const fleckMat = makePointsMaterial(texFleck, THREE.NormalBlending, 0xf2fbff);
  const flecks = makePointsCloud(FLECK_COUNT, fleckMat, 2);
  const fleckX = new Float32Array(FLECK_COUNT);
  const fleckZ = new Float32Array(FLECK_COUNT);
  const fleckPhase = new Float32Array(FLECK_COUNT);
  const fleckDrift = new Float32Array(FLECK_COUNT * 2);
  const fleckBaseA = new Float32Array(FLECK_COUNT);

  let flecksSizeDirty = true;

  // scatter = sprinkle anywhere in range; otherwise drop it upwind so
  // the current carries it back across the player's view.
  function seedFleck(i, cx, cz, scatter) {
    fleckPhase[i] = Math.random() * TAU;
    const vx = 0.30 + (Math.random() - 0.5) * 0.26;
    const vz = 0.19 + (Math.random() - 0.5) * 0.26;
    fleckDrift[i * 2] = vx;
    fleckDrift[i * 2 + 1] = vz;
    if (scatter) {
      const a = Math.random() * TAU;
      const r = 20 + Math.sqrt(Math.random()) * 135;
      fleckX[i] = cx + Math.cos(a) * r;
      fleckZ[i] = cz + Math.sin(a) * r;
    } else {
      const inv = 150 / Math.max(0.08, Math.hypot(vx, vz));
      fleckX[i] = cx - vx * inv + (Math.random() - 0.5) * 130;
      fleckZ[i] = cz - vz * inv + (Math.random() - 0.5) * 130;
    }
    flecks.size[i] = 0.16 + Math.random() * 0.42;
    fleckBaseA[i] = 0.22 + Math.random() * 0.40;
    flecksSizeDirty = true;
  }
  for (let i = 0; i < FLECK_COUNT; i++) seedFleck(i, 0, -160, true);

  // ---------------------------------------------------------
  // Underwater: tint overlay + rising bubbles
  // ---------------------------------------------------------
  const overlayMat = new THREE.MeshBasicMaterial({
    map: texVignette,
    color: new THREE.Color(0x1d7280),
    transparent: true,
    opacity: 0,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: false,
  });
  const overlay = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), overlayMat);
  overlay.frustumCulled = false;
  overlay.renderOrder = 9998;
  overlay.visible = false;
  scene.add(overlay);

  const bubbleMat = makePointsMaterial(texBubble, THREE.NormalBlending, 0xdff6ff);
  const bubbles = makePointsCloud(BUBBLE_POOL, bubbleMat, 5);
  const bubbleVel = new Float32Array(BUBBLE_POOL);
  const bubbleSway = new Float32Array(BUBBLE_POOL * 2);
  const bubbleLife = new Float32Array(BUBBLE_POOL);
  let bubbleCursor = 0;
  let bubbleSpawnAcc = 0;
  bubbles.pts.visible = false;

  function spawnBubble(cx, cy, cz) {
    const i = bubbleCursor;
    bubbleCursor = (bubbleCursor + 1) % BUBBLE_POOL;
    const a = Math.random() * TAU;
    const r = 0.6 + Math.random() * 6.0;
    bubbles.pos[i * 3] = cx + Math.cos(a) * r;
    bubbles.pos[i * 3 + 1] = cy - 1.2 - Math.random() * 3.4;
    bubbles.pos[i * 3 + 2] = cz + Math.sin(a) * r;
    bubbles.size[i] = 0.035 + Math.random() * 0.10;
    bubbles.alpha[i] = 0.35 + Math.random() * 0.5;
    bubbleVel[i] = 0.55 + Math.random() * 1.05;
    bubbleSway[i * 2] = Math.random() * TAU;
    bubbleSway[i * 2 + 1] = 0.5 + Math.random() * 1.4;
    bubbleLife[i] = 3.0 + Math.random() * 4.0;
  }

  // ---------------------------------------------------------
  // Bus wiring — read handles lazily, never capture at init
  // ---------------------------------------------------------
  const sunDir = new THREE.Vector3(0.35, 0.72, -0.6).normalize();
  let sunDirReceived = false;
  let busUnderwater = false;

  function onSunDir(v) {
    if (!v) return;
    if (typeof v.x === 'number' && typeof v.y === 'number' && typeof v.z === 'number') {
      sunDir.set(v.x, v.y, v.z);
      if (sunDir.lengthSq() > 1e-8) {
        sunDir.normalize();
        sunDirReceived = true;
      }
    }
  }
  function onUnderwater(v) { busUnderwater = !!v; }

  if (ctx.bus && typeof ctx.bus.on === 'function') {
    ctx.bus.on('sunDir', onSunDir);
    ctx.bus.on('underwater', onUnderwater);
  }

  // ---------------------------------------------------------
  // Palette evaluation
  // ---------------------------------------------------------
  const palColors = PALETTE.map((p) => ({
    t: p.t,
    deep: new THREE.Color(p.deep),
    shal: new THREE.Color(p.shal),
    sky: new THREE.Color(p.sky),
    hor: new THREE.Color(p.hor),
    sun: new THREE.Color(p.sun),
    foam: new THREE.Color(p.foam),
    sss: new THREE.Color(p.sss),
    str: p.str,
  }));

  const _cDeep = new THREE.Color();
  const _cShal = new THREE.Color();
  const _cSky = new THREE.Color();
  const _cHor = new THREE.Color();
  const _cSun = new THREE.Color();
  const _cFoam = new THREE.Color();
  const _cSss = new THREE.Color();
  let sunStrength = 1;

  function evalPalette(tod) {
    let t = tod;
    if (!isFinite(t)) t = 0.35;
    t = t - Math.floor(t);
    let i = 0;
    while (i < palColors.length - 2 && palColors[i + 1].t < t) i++;
    const a = palColors[i];
    const b = palColors[i + 1] || palColors[i];
    const span = Math.max(1e-5, b.t - a.t);
    const k = clamp01((t - a.t) / span);
    _cDeep.copy(a.deep).lerp(b.deep, k);
    _cShal.copy(a.shal).lerp(b.shal, k);
    _cSky.copy(a.sky).lerp(b.sky, k);
    _cHor.copy(a.hor).lerp(b.hor, k);
    _cSun.copy(a.sun).lerp(b.sun, k);
    _cFoam.copy(a.foam).lerp(b.foam, k);
    _cSss.copy(a.sss).lerp(b.sss, k);
    sunStrength = lerp(a.str, b.str, k);
  }

  // event tint, smoothed
  const evtMul = [1, 1, 1];
  const evtTarget = [1, 1, 1];

  // ---------------------------------------------------------
  // splash(pos, size)
  // ---------------------------------------------------------
  function spawnRing(x, z, r0, r1, life, peak, tint) {
    const R = rings[ringCursor];
    ringCursor = (ringCursor + 1) % RING_POOL;
    R.age = 0;
    R.life = life;
    R.r0 = r0;
    R.r1 = r1;
    R.peak = peak;
    R.x = x;
    R.z = z;
    R.mesh.visible = true;
    R.mesh.rotation.y = Math.random() * TAU;
    R.mat.opacity = peak;
    R.mat.color.setHex(tint);
    R.mesh.position.set(x, heightFast(x, z, simTime) + 0.035, z);
    R.mesh.scale.set(r0 * 2, 1, r0 * 2);
  }

  function splash(pos, size) {
    if (!pos) return;
    const px = (typeof pos.x === 'number') ? pos.x : 0;
    const pz = (typeof pos.z === 'number') ? pos.z : 0;
    let s = (typeof size === 'number' && isFinite(size)) ? size : 1;
    s = Math.max(0.18, Math.min(6, s));
    const surfaceY = getWaterHeight(px, pz, simTime);
    const py = (typeof pos.y === 'number' && isFinite(pos.y))
      ? Math.max(pos.y, surfaceY - 0.35)
      : surfaceY;

    const count = Math.round(Math.min(DROPLET_POOL * 0.55, 9 + 24 * s));
    const speed = 1.7 + 2.3 * Math.sqrt(s);
    for (let n = 0; n < count; n++) {
      const i = nextDrop();
      const a = Math.random() * TAU;
      const up = 0.42 + Math.random() * 0.85;
      const rad = (0.25 + Math.random() * 1.0) * s;
      const sp = speed * (0.45 + Math.random() * 0.85);
      drops.pos[i * 3] = px + Math.cos(a) * rad * 0.32;
      drops.pos[i * 3 + 1] = py + 0.05 + Math.random() * 0.16 * s;
      drops.pos[i * 3 + 2] = pz + Math.sin(a) * rad * 0.32;
      dropVel[i * 3] = Math.cos(a) * sp * 0.55;
      dropVel[i * 3 + 1] = sp * up;
      dropVel[i * 3 + 2] = Math.sin(a) * sp * 0.55;
      const life = 0.45 + Math.random() * 0.75 + s * 0.12;
      dropLife[i] = life;
      dropMax[i] = life;
      const sz = (0.055 + Math.random() * 0.135) * (0.65 + s * 0.42);
      drops.size[i] = sz;
      dropBase[i] = sz;
      drops.alpha[i] = 0.55 + Math.random() * 0.45;
    }
    // a couple of fat, slow gobs of white water for weight
    const gobs = Math.max(1, Math.round(2 + s));
    for (let n = 0; n < gobs; n++) {
      const i = nextDrop();
      const a = Math.random() * TAU;
      const sp = speed * (0.25 + Math.random() * 0.3);
      drops.pos[i * 3] = px + Math.cos(a) * 0.12 * s;
      drops.pos[i * 3 + 1] = py + 0.08;
      drops.pos[i * 3 + 2] = pz + Math.sin(a) * 0.12 * s;
      dropVel[i * 3] = Math.cos(a) * sp * 0.3;
      dropVel[i * 3 + 1] = sp * 1.15;
      dropVel[i * 3 + 2] = Math.sin(a) * sp * 0.3;
      const life = 0.7 + Math.random() * 0.5;
      dropLife[i] = life;
      dropMax[i] = life;
      const sz = (0.20 + Math.random() * 0.22) * (0.7 + s * 0.5);
      drops.size[i] = sz;
      dropBase[i] = sz;
      drops.alpha[i] = 0.45 + Math.random() * 0.3;
    }
    dropsDirty = true;
    drops.geo.attributes.position.needsUpdate = true;
    drops.geo.attributes.aSize.needsUpdate = true;
    drops.geo.attributes.aAlpha.needsUpdate = true;

    spawnRing(px, pz, 0.35 * s, 2.6 * s + 0.7, 0.85 + 0.22 * s, 0.85, 0xffffff);
    spawnRing(px, pz, 0.18 * s, 4.6 * s + 1.2, 1.55 + 0.3 * s, 0.34, 0xe6f7ff);
  }

  // ---------------------------------------------------------
  // per-frame scratch
  // ---------------------------------------------------------
  const _fwd = new THREE.Vector3();
  let uwFade = 0;
  let camSubmerged = false;
  let overlayPulse = 0;

  // ---------------------------------------------------------
  // update
  // ---------------------------------------------------------
  function update(dt, t) {
    const camera = ctx.camera;
    if (!camera) return;
    const step = (typeof dt === 'number' && isFinite(dt)) ? Math.min(0.05, Math.max(0, dt)) : 0.016;
    simTime = (typeof t === 'number' && isFinite(t)) ? t : simTime + step;

    camX = camera.position.x;
    camZ = camera.position.z;

    // --- state-driven tuning -----------------------------------
    const st = ctx.state || {};
    const evt = st.eventActive || null;
    const tint = evt && EVENT_TINT[evt] ? EVENT_TINT[evt] : null;
    evtTarget[0] = tint ? tint[0] : 1;
    evtTarget[1] = tint ? tint[1] : 1;
    evtTarget[2] = tint ? tint[2] : 1;
    const blend = 1 - Math.pow(0.08, step);
    evtMul[0] += (evtTarget[0] - evtMul[0]) * blend;
    evtMul[1] += (evtTarget[1] - evtMul[1]) * blend;
    evtMul[2] += (evtTarget[2] - evtMul[2]) * blend;

    const targetScale = (evt ? 1.45 : 1.0) * waveScaleBase;
    waveScale += (targetScale - waveScale) * (1 - Math.pow(0.25, step));
    uniforms.uWaveScale.value = waveScale;
    uniforms.uMaxAmp.value = maxAmp * waveScale;

    // --- sun / palette ------------------------------------------
    const tod = (typeof st.timeOfDay === 'number') ? st.timeOfDay : 0.35;
    if (!sunDirReceived) {
      const ang = (tod - 0.25) * TAU;
      sunDir.set(Math.cos(ang) * 0.62, Math.sin(ang), -0.46).normalize();
    }
    // at night light the sea by the moon, opposite the sunken sun
    const lit = uniforms.uSunDir.value;
    if (sunDir.y < -0.03) lit.set(-sunDir.x, -sunDir.y, -sunDir.z);
    else lit.copy(sunDir);
    if (lit.lengthSq() > 1e-8) lit.normalize();

    evalPalette(tod);
    const nightF = clamp01(1 - smoothstep(-0.08, 0.16, sunDir.y));
    uniforms.uNight.value = nightF;
    uniforms.uSunStrength.value = sunStrength;

    uniforms.uDeepColor.value.setRGB(
      _cDeep.r * evtMul[0], _cDeep.g * evtMul[1], _cDeep.b * evtMul[2]);
    uniforms.uShallowColor.value.setRGB(
      _cShal.r * evtMul[0], _cShal.g * evtMul[1], _cShal.b * evtMul[2]);
    uniforms.uSssColor.value.setRGB(
      _cSss.r * evtMul[0], _cSss.g * evtMul[1], _cSss.b * evtMul[2]);
    uniforms.uSkyColor.value.copy(_cSky);
    uniforms.uHorizonColor.value.copy(_cHor);
    uniforms.uSunColor.value.copy(_cSun);
    uniforms.uFoamColor.value.copy(_cFoam);

    uniforms.uTime.value = simTime;

    // --- ocean follows the camera in xz -------------------------
    waterMesh.position.x = camX;
    waterMesh.position.z = camZ;

    // --- underwater detection ------------------------------------
    const surfaceAtCam = getWaterHeight(camX, camZ, simTime);
    camSubmerged = camera.position.y < surfaceAtCam - 0.02;
    const wantUW = (busUnderwater || camSubmerged) ? 1 : 0;
    uwFade += (wantUW - uwFade) * (1 - Math.pow(0.005, step));
    if (uwFade < 0.002) uwFade = 0;
    if (uwFade > 0.998) uwFade = 1;
    uniforms.uUnderwater.value = uwFade;

    // --- point sprite scale --------------------------------------
    const canvas = ctx.renderer && ctx.renderer.domElement ? ctx.renderer.domElement : null;
    const bufH = canvas && canvas.height ? canvas.height : 800;
    const projY = camera.projectionMatrix && camera.projectionMatrix.elements
      ? camera.projectionMatrix.elements[5] : 1.7;
    const pixelScale = bufH * projY * 0.5;
    dropMat.uniforms.uPixelScale.value = pixelScale;
    fleckMat.uniforms.uPixelScale.value = pixelScale;
    bubbleMat.uniforms.uPixelScale.value = pixelScale;

    updateDroplets(step);
    updateRings(step);
    updateFlecks(step, nightF);
    updateUnderwater(step, camera);
  }

  // ---------------------------------------------------------
  function updateDroplets(step) {
    let any = false;
    for (let i = 0; i < DROPLET_POOL; i++) {
      if (dropLife[i] <= 0) continue;
      any = true;
      dropLife[i] -= step;
      const o = i * 3;
      dropVel[o + 1] -= 13.5 * step;
      // light air drag so spray decelerates and hangs
      const drag = 1 - 1.35 * step;
      dropVel[o] *= drag;
      dropVel[o + 2] *= drag;
      drops.pos[o] += dropVel[o] * step;
      drops.pos[o + 1] += dropVel[o + 1] * step;
      drops.pos[o + 2] += dropVel[o + 2] * step;

      if (dropLife[i] <= 0) {
        drops.alpha[i] = 0;
        drops.size[i] = 0;
        drops.pos[o + 1] = -9999;
        continue;
      }
      if (dropVel[o + 1] < 0) {
        const surf = heightFast(drops.pos[o], drops.pos[o + 2], simTime);
        if (drops.pos[o + 1] <= surf) {
          dropLife[i] = 0;
          drops.alpha[i] = 0;
          drops.size[i] = 0;
          drops.pos[o + 1] = -9999;
          continue;
        }
      }
      const k = dropLife[i] / Math.max(0.001, dropMax[i]);
      drops.alpha[i] = k * k * (0.35 + 0.65 * k);
      drops.size[i] = dropBase[i] * (0.55 + 0.45 * k);
    }
    if (any || dropsDirty) {
      drops.geo.attributes.position.needsUpdate = true;
      drops.geo.attributes.aSize.needsUpdate = true;
      drops.geo.attributes.aAlpha.needsUpdate = true;
      dropsDirty = any;
    }
  }

  // ---------------------------------------------------------
  function updateRings(step) {
    for (let i = 0; i < RING_POOL; i++) {
      const R = rings[i];
      if (!R.mesh.visible) continue;
      R.age += step;
      const k = R.age / R.life;
      if (k >= 1) {
        R.mesh.visible = false;
        R.mat.opacity = 0;
        continue;
      }
      const ease = 1 - Math.pow(1 - k, 2.4);
      const r = R.r0 + (R.r1 - R.r0) * ease;
      R.mesh.scale.set(r * 2, 1, r * 2);
      R.mat.opacity = R.peak * Math.pow(1 - k, 1.6);
      R.mesh.position.y = heightFast(R.x, R.z, simTime) + 0.035;
    }
  }

  // ---------------------------------------------------------
  function updateFlecks(step, nightF) {
    for (let i = 0; i < FLECK_COUNT; i++) {
      fleckX[i] += fleckDrift[i * 2] * step;
      fleckZ[i] += fleckDrift[i * 2 + 1] * step;
      const dx = fleckX[i] - camX;
      const dz = fleckZ[i] - camZ;
      if (dx * dx + dz * dz > 165 * 165) seedFleck(i, camX, camZ, false);
      const x = fleckX[i];
      const z = fleckZ[i];
      const o = i * 3;
      flecks.pos[o] = x;
      flecks.pos[o + 1] = heightFast(x, z, simTime) + 0.045;
      flecks.pos[o + 2] = z;
      const tw = 0.72 + 0.28 * Math.sin(simTime * 1.6 + fleckPhase[i]);
      // hide flecks that drift over the island
      const r = Math.sqrt(x * x + z * z);
      const onWater = smoothstep(102, 124, r);
      flecks.alpha[i] = fleckBaseA[i] * tw * onWater * (1 - nightF * 0.55) * (1 - uwFade * 0.85);
    }
    flecks.geo.attributes.position.needsUpdate = true;
    flecks.geo.attributes.aAlpha.needsUpdate = true;
    if (flecksSizeDirty) {
      flecks.geo.attributes.aSize.needsUpdate = true;
      flecksSizeDirty = false;
    }
  }

  // ---------------------------------------------------------
  function updateUnderwater(step, camera) {
    const active = uwFade > 0.002;
    overlay.visible = active;
    bubbles.pts.visible = active;
    if (!active) {
      if (bubbleSpawnAcc !== 0) bubbleSpawnAcc = 0;
      return;
    }

    // tint plane pinned in front of the camera
    overlayPulse += step;
    const dist = Math.max(0.22, (camera.near || 0.1) * 2.4);
    _fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    overlay.position.copy(camera.position).addScaledVector(_fwd, dist);
    overlay.quaternion.copy(camera.quaternion);
    const fov = (camera.fov || 60) * Math.PI / 180;
    const h = 2 * Math.tan(fov * 0.5) * dist * 1.3;
    overlay.scale.set(h * (camera.aspect || 1.6), h, 1);
    const breathe = 0.94 + 0.06 * Math.sin(overlayPulse * 0.9);
    overlayMat.opacity = uwFade * 0.52 * breathe;
    // deeper = darker, colder
    const depthBelow = Math.max(0, getWaterHeight(camX, camZ, simTime) - camera.position.y);
    const deepK = clamp01(depthBelow / 26);
    overlayMat.color.setRGB(
      lerp(0.115, 0.020, deepK),
      lerp(0.450, 0.130, deepK),
      lerp(0.505, 0.235, deepK)
    );

    // rising bubbles around the camera
    bubbleSpawnAcc += step * (18 + 14 * uwFade);
    while (bubbleSpawnAcc >= 1) {
      bubbleSpawnAcc -= 1;
      spawnBubble(camera.position.x, camera.position.y, camera.position.z);
    }
    for (let i = 0; i < BUBBLE_POOL; i++) {
      if (bubbleLife[i] <= 0) continue;
      bubbleLife[i] -= step;
      const o = i * 3;
      bubbles.pos[o + 1] += bubbleVel[i] * step;
      const sw = bubbleSway[i * 2] + simTime * bubbleSway[i * 2 + 1];
      bubbles.pos[o] += Math.cos(sw) * 0.32 * step;
      bubbles.pos[o + 2] += Math.sin(sw * 0.87) * 0.32 * step;
      const surf = heightFast(bubbles.pos[o], bubbles.pos[o + 2], simTime);
      const dxc = bubbles.pos[o] - camera.position.x;
      const dzc = bubbles.pos[o + 2] - camera.position.z;
      if (bubbleLife[i] <= 0 || bubbles.pos[o + 1] > surf - 0.06 || dxc * dxc + dzc * dzc > 900) {
        bubbleLife[i] = 0;
        bubbles.alpha[i] = 0;
        bubbles.size[i] = 0;
        bubbles.pos[o + 1] = -9999;
        continue;
      }
      const fade = Math.min(1, bubbleLife[i] * 1.6);
      bubbles.alpha[i] = fade * uwFade * 0.85;
    }
    bubbles.geo.attributes.position.needsUpdate = true;
    bubbles.geo.attributes.aSize.needsUpdate = true;
    bubbles.geo.attributes.aAlpha.needsUpdate = true;
  }

  // ---------------------------------------------------------
  // handle
  // ---------------------------------------------------------
  const handle = {
    update,
    splash,
    mesh: waterMesh,
    material: waterMat,
    getHeight: getWaterHeight,
    waveNormal: getWaterNormal,
    isCameraSubmerged() { return camSubmerged; },
    setWaveScale(v) {
      const n = Number(v);
      if (isFinite(n)) waveScaleBase = Math.max(0.05, Math.min(3, n));
    },
    dispose() {
      if (ctx.bus && typeof ctx.bus.off === 'function') {
        ctx.bus.off('sunDir', onSunDir);
        ctx.bus.off('underwater', onUnderwater);
      }
      scene.remove(waterMesh);
      scene.remove(overlay);
      scene.remove(drops.pts);
      scene.remove(flecks.pts);
      scene.remove(bubbles.pts);
      for (let i = 0; i < rings.length; i++) {
        scene.remove(rings[i].mesh);
        rings[i].mat.dispose();
      }
      waterGeo.dispose();
      waterMat.dispose();
      ringGeo.dispose();
      ringMatBase.dispose();
      overlay.geometry.dispose();
      overlayMat.dispose();
      drops.geo.dispose(); dropMat.dispose();
      flecks.geo.dispose(); fleckMat.dispose();
      bubbles.geo.dispose(); bubbleMat.dispose();
      texDrop.dispose(); texFleck.dispose(); texBubble.dispose();
      texRing.dispose(); texVignette.dispose();
    },
  };

  return handle;
}

export default initWater;
