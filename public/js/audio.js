// =============================================================
// TIDEWRECK ISLAND - audio.js
// Everything you hear is synthesized at runtime with WebAudio.
// No audio files, no samples, no external anything.
//
//   masterIn -> uwFilter (underwater lowpass) -> comp (DynamicsCompressor)
//            -> hardLimit (WaveShaper, |y| <= 1) -> outGain -> destination
//     musicBus  (pad, plucks, marimba, bass, shaker)   <- cut by cutMusic()
//     sfxBus    (all one-shots)
//     ambBus    (ocean, gulls, crickets, sub drone)    <- never cut
//     horrorBus (drone, heartbeat, scrapes)
//     revOut    (feedback-delay "reverb" send)
//     watchdog  (AnalyserNode off comp, sampled ~1 Hz)
//
// SAFETY (wave 3). A single non-finite sample poisons a WebAudio graph for
// good: it lands in the reverb's feedback delays and circulates forever, so
// the whole mix reads NaN and the game goes permanently silent. Three layers
// stop that now:
//   1. every AudioParam write is range-clamped by kind (pAt/pExp/pTgt + fHz,
//      qVal, gVal, oHz below) - no non-finite value can be written at all;
//   2. every feedback path (reverb taps) is bounded BY CONSTRUCTION - the
//      loop gain is < 0.5 and a bounded WaveShaper sits inside the loop, so
//      the circulating signal cannot exceed +/-1 even if a coefficient
//      glitches. Biquads inside loops are pinned to Q <= 0.707 (no resonant
//      peak) and no LFO can drag a cutoff below ~40 Hz (modDepth);
//   3. a watchdog analyser samples the master ~1/s and, on NaN or a sustained
//      peak > 4, silently tears the whole graph down and rebuilds it,
//      re-honouring underwater / event silence / weather / music phase.
//
// export: initAudio(ctx) -> { update, cutMusic, sfx, setUnderwater, startMusic, setVolume }
// =============================================================

import { AMBUSH, ECON, MSG } from '/shared/constants.js';

// ---------------- musical constants ----------------
const TEMPO = 76;                  // unhurried: this is a hammock, not a chase
const SPB = 60 / TEMPO;            // seconds per beat
const STEP = SPB / 4;              // one 16th note
const BAR_STEPS = 16;
const PHRASE_STEPS = 128;          // 8 bars
const LOOKAHEAD = 0.16;            // scheduler horizon in seconds
const MAX_VOICES = 64;             // hard polyphony cap

const MUSIC_LEVEL = 0.5;
const SFX_LEVEL = 0.95;
const AMB_LEVEL = 0.75;
const HORROR_LEVEL = 0.95;

// C major pentatonic (day) and A minor pentatonic (night) - relative, so a
// crossfade between the two layers can never clash.
const DAY_SCALE = [60, 62, 64, 67, 69, 72, 74, 76, 79, 81, 84, 86];
const NIGHT_SCALE = [57, 60, 62, 64, 67, 69, 72, 74, 76, 79, 81, 84];

// chord progressions, one chord per bar, 4-bar loop
const DAY_PROG = [{ r: 48, min: false }, { r: 43, min: false }, { r: 45, min: true }, { r: 41, min: false }]; // C  G  Am F
const NIGHT_PROG = [{ r: 45, min: true }, { r: 41, min: false }, { r: 43, min: false }, { r: 40, min: true }]; // Am F  G  Em

// scale indices that sit sweetly on each chord of the progression
const DAY_TONES = [[0, 2, 3, 5, 7], [3, 6, 8, 1, 4], [4, 5, 7, 9, 2], [4, 5, 6, 9, 7]];
const NIGHT_TONES = [[0, 1, 3, 5, 6], [1, 5, 0, 6, 8], [4, 2, 7, 9, 5], [3, 4, 8, 6, 2]];

// Day used to fire six plucks and eight shaker hits a bar - busy, and it never
// let the sea through. Three plucks, a shaker only on the backbeat.
const DAY_PLUCK_STEPS = [0, 6, 10];
const NIGHT_PLUCK_STEPS = [0, 10];
const DAY_SHAKER_STEPS = [4, 12];
const NIGHT_SHAKER_STEPS = [8];
const MELODY_SLOTS = [0, 8, 4, 12, 6, 10, 2, 14];   // strong beats first

const EMPTY = Object.freeze({});

function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function smoothstep(a, b, x) { const t = clamp((x - a) / (b - a || 1e-6), 0, 1); return t * t * (3 - 2 * t); }

// wave 7: hard ceiling on the razorfin swarm bed — the server's frenzy window
// plus slack, so a lost 'end' beat can never leave the loop running forever.
const FRENZY_MAX = clamp(Number(AMBUSH && AMBUSH.DURATION) || 22, 4, 120) + 14;

// ------------------------------------------------------------------
// AudioParam safety layer - EVERY param write in this file goes through it
// ------------------------------------------------------------------
const F_MIN = 10, F_MAX = 18000;   // biquad cutoff bounds (a biquad driven
                                   // toward 0 Hz self-oscillates and explodes)
const G_MAX = 2;                   // any output gain
// finite-or-default. NaN/Infinity never leave this function.
function num(v, d) {
  return (typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity) ? v : d;
}
function cl(v, lo, hi, d) { const n = num(v, d); return n < lo ? lo : (n > hi ? hi : n); }
function fHz(v, d) { return cl(v, F_MIN, F_MAX, d === undefined ? 1000 : d); }        // filter cutoff
function oHz(v, d) { return cl(v, 0.001, 20000, d === undefined ? 440 : d); }         // oscillator pitch (LFOs live here too)
function qVal(v, d) { return cl(v, 0.0001, 20, d === undefined ? 0.7 : d); }
function gVal(v, d) { return cl(v, 0, G_MAX, d === undefined ? 0.0001 : d); }
function mVal(v, lim) { const L = lim === undefined ? F_MAX : lim; return cl(v, -L, L, 0); } // LFO depth (may be negative)
function dSec(v, d) { return cl(v, 0.001, 0.5, d === undefined ? 0.05 : d); }         // DelayNode time
function pVal(v) { return cl(v, -1, 1, 0); }                                          // stereo pan
function rVal(v, d) { return cl(v, 0.02, 8, d === undefined ? 1 : d); }               // playbackRate
function tSec(v) { return cl(v, 0, 1e7, 0); }                                         // schedule time
function kSec(v) { return cl(v, 0.004, 60, 0.2); }                                    // setTargetAtTime constant
// An LFO on a cutoff must never be able to drag it under floorHz.
function modDepth(base, want, floorHz) {
  const f = num(floorHz, 40);
  return cl(Math.min(Math.abs(num(want, 0)), Math.max(0, num(base, 1000) - f)), 0, F_MAX, 0);
}
function pSet(p, v) { if (p) { try { p.value = v; } catch (e) { /* param vanished */ } } }
function pAt(p, v, t) { if (p) { try { p.setValueAtTime(v, tSec(t)); } catch (e) { /* out of order */ } } }
function pLin(p, v, t) { if (p) { try { p.linearRampToValueAtTime(v, tSec(t)); } catch (e) { /* noop */ } } }
function pExp(p, v, t) { if (p) { try { p.exponentialRampToValueAtTime(v > 1e-5 ? v : 1e-5, tSec(t)); } catch (e) { /* noop */ } } }
function pTgt(p, v, t, k) { if (p) { try { p.setTargetAtTime(v, tSec(t), kSec(k)); } catch (e) { /* noop */ } } }
function pCancel(p, t) { if (p) { try { p.cancelScheduledValues(tSec(t)); } catch (e) { /* noop */ } } }
function pNow(p, d) { return p ? num(p.value, num(d, 0)) : num(d, 0); }
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// pentatonic scale lookup that keeps going in octaves past the array ends
function scaleMidi(scale, idx) {
  const n = scale.length;
  let oct = 0;
  while (idx >= n) { idx -= 5; oct += 12; }
  while (idx < 0) { idx += 5; oct -= 12; }
  return scale[idx] + oct;
}

export function initAudio(ctx) {
  // ------------------------------------------------------------------
  // state
  // ------------------------------------------------------------------
  let ac = null;
  let built = false;
  let failed = false;
  let gestureSeen = false;
  let warned = 0;

  let masterIn = null, uwFilter = null, limiter = null, hardLimit = null, outGain = null;
  let musicBus = null, sfxBus = null, ambBus = null, horrorBus = null;
  let revS = null, revM = null, revL = null, revOut = null, revIn = null;
  let whiteBuf = null, brownBuf = null, distCurve = null, softCurve = null;
  let limitCurve = null, masterCurve = null;

  // every always-on node lives in these two lists so a rebuild can rip the
  // whole graph out in one pass (persistRun also gets .stop()'d)
  const persist = [];
  const persistRun = [];
  // watchdog
  let analyser = null, wdBuf = null;
  let wdTimer = 1.5, wdHot = 0, rebuilds = 0, lastRebuildAt = -99, rebuilding = false;

  // music
  let musicState = 'stopped';   // stopped | playing | silence | horror | quiet
  let schedulerOn = false;
  let nextNoteTime = 0;
  let stepIdx = 0;
  let arpCursor = 0;
  let nightAmt = 0;
  let padVoices = null, padFilter = null, padOut = null, padDetunes = null;
  let currentChord = DAY_PROG[0];
  const melody = new Int8Array(PHRASE_STEPS);
  let paramTimer = 0;

  // ambience
  let waveGain = null, waveFilter = null, surfGain = null;
  let subGain = null;
  let nextGull = 6, nextCricket = 9;

  // weather bed — rain patter / wind howl / distant rumble, built the first
  // time the sky actually turns. Rides on ambBus so it survives cutMusic().
  let wxBuilt = false, wxOut = null, wxRainGain = null, wxRainHP = null, wxRainLP = null;
  let wxWindGain = null, wxWindFilt = null, wxRumbleGain = null;
  let wxType = 'clear', wxApplied = '', nextFogTone = 12;

  // horror
  let horrorNodes = null;
  let cutAt = 0, horrorAt = 0, resumeAt = 0, eventEndAt = -99;
  let eventActive = false, evStateSeen = false;

  // misc runtime
  let userVol = 0.8;
  let underwater = false;
  let reelOn = false, nextReelTick = 0, reelHold = 0, reelTension = 0.4, reelVol = 0.6, nextCreak = 0;
  let motor = null, motorDirty = false, motorTimer = 0, motorAuto = true;
  // wave 5 loops: the revive channel shimmer and the doomsday rumble bed
  let chanNodes = null, chanAt = 0, chanSeen = 0;
  let quakeNodes = null, quakeAt = 0, doomAt = -99;
  // wave 6/7 loop: the razorfin swarm bed (frenzyWant survives a rebuild)
  let frenzyNodes = null, frenzyAt = 0, frenzyWant = false, nextChomp = 0;
  // per-call sfx modifiers, set by sfx() from opts (volume/vol/gain and pos)
  let curScale = 1, curPan = 0;
  let started = false;
  let lastPhase = '';
  const lastFired = Object.create(null);

  // self-driven player foley (player.js does not voice its own steps)
  const foley = {
    stepTimer: 0, grounded: true, swimming: false, wasUnder: false,
    strokeTimer: 0, bubbleTimer: 0, seen: false, airborne: 0, clock: 0,
  };
  let lastWallet = null;
  const lastGear = { rod: 0, boat: 0, diving: 0, weapons: 0, charms: 0, seen: false };
  let portalWasBuilt = false;

  // voice bookkeeping (no timers - cleaned in update)
  const voices = [];
  const voicePool = [];

  // ------------------------------------------------------------------
  // graph construction
  // ------------------------------------------------------------------
  function warn(e) {
    if (warned > 4) return;
    warned++;
    console.warn('[audio]', e && e.message ? e.message : e);
  }

  function ensureContext(allowCreate) {
    if (ac) return built;
    if (!allowCreate || failed) return false;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { failed = true; return false; }
    try {
      ac = new AC({ latencyHint: 'interactive' });
      buildGraph();
    } catch (e) {
      // a browser without some node type should cost the game silence, not a crash
      warn(e);
      ac = null; built = false; failed = true;
      return false;
    }
    return true;
  }

  function makeNoise(seconds, brown) {
    const len = Math.floor(ac.sampleRate * seconds);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    if (brown) {
      let last = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.2;
      }
    } else {
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    return buf;
  }

  function makeCurve(amount) {
    const n = 1024;
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = ((1 + amount) * x) / (1 + amount * Math.abs(x));
    }
    return c;
  }

  // Unity slope at zero, bounded to +/-tanh(k)/k, monotonic, |dy/dx| <= 1
  // everywhere: safe to place INSIDE a feedback loop, because it can only ever
  // shrink what circulates. A WaveShaper also clamps inputs beyond +/-1 to the
  // end of its curve, so the bound holds no matter what arrives.
  function makeLimitCurve(k) {
    const n = 2048;
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(x * k) / k;
    }
    return c;
  }

  // master brick wall: dead transparent under 0.7, then a soft knee that can
  // never output past ~0.93 however loud the mix gets
  function makeMasterCurve() {
    const n = 2048;
    const c = new Float32Array(n);
    const th = 0.7, span = 1 - th;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      const a = x < 0 ? -x : x;
      const y = a <= th ? a : th + span * Math.tanh((a - th) / span);
      c[i] = x < 0 ? -y : y;
    }
    return c;
  }

  function gainNode(v, lo, hi) {
    const g = ac.createGain();
    g.gain.value = cl(v, lo === undefined ? 0 : lo, hi === undefined ? G_MAX : hi, 0.0001);
    return g;
  }

  // ---- persistent-node factories (registered for teardown/rebuild) ----
  function pKeep(n) { persist.push(n); return n; }
  function pGain(v, lo, hi) { return pKeep(gainNode(v, lo, hi)); }
  function pMod(v, lim) { const g = ac.createGain(); g.gain.value = mVal(v, lim); return pKeep(g); }
  function pFilt(type, hz, q) {
    const f = ac.createBiquadFilter();
    f.type = type;
    pSet(f.frequency, fHz(hz, 1000));
    pSet(f.Q, qVal(q, 0.7));
    return pKeep(f);
  }
  function pOsc(type, hz) {
    const o = ac.createOscillator();
    o.type = type;
    pSet(o.frequency, oHz(hz, 1));
    persistRun.push(o);
    return pKeep(o);
  }
  function pNoiseSrc(buf, rate) {
    const s = ac.createBufferSource();
    s.buffer = buf; s.loop = true;
    pSet(s.playbackRate, rVal(rate, 1));
    persistRun.push(s);
    return pKeep(s);
  }
  // wire a slow LFO onto a filter cutoff with a depth that can never reach 0 Hz
  function pSweep(param, base, depth, rateHz, floorHz) {
    const d = modDepth(base, depth, floorHz);
    if (d <= 0) return null;
    const l = pOsc('sine', oHz(rateHz, 0.05));
    const g = pMod(d, F_MAX);
    l.connect(g); g.connect(param); l.start();
    return l;
  }

  function buildGraph() {
    if (built) return;
    built = true;

    if (!whiteBuf) whiteBuf = makeNoise(2, false);
    if (!brownBuf) brownBuf = makeNoise(5, true);
    if (!distCurve) distCurve = makeCurve(14);
    if (!softCurve) softCurve = makeCurve(2.2);
    if (!limitCurve) limitCurve = makeLimitCurve(1.6);
    if (!masterCurve) masterCurve = makeMasterCurve();

    // ---- master chain: compressor, then a hard (bounded) wave-shaper ----
    outGain = pGain(0.92);
    outGain.connect(ac.destination);

    hardLimit = pKeep(ac.createWaveShaper());
    hardLimit.curve = masterCurve;
    try { hardLimit.oversample = '2x'; } catch (e) { /* older engines */ }
    hardLimit.connect(outGain);

    limiter = pKeep(ac.createDynamicsCompressor());
    pSet(limiter.threshold, -10);
    pSet(limiter.knee, 10);
    pSet(limiter.ratio, 14);
    pSet(limiter.attack, 0.003);
    pSet(limiter.release, 0.25);
    limiter.connect(hardLimit);

    uwFilter = pFilt('lowpass', 18000, 0.7);
    uwFilter.connect(limiter);

    // The watchdog taps BEFORE the compressor, on purpose: downstream of it
    // everything is squashed to about 0.4 and a genuine runaway would read as
    // perfectly normal. Here it sees the raw sum of every bus plus the reverb
    // return, so a peak of 4 really is a peak of 4. Its output is left
    // dangling, also on purpose — an AnalyserNode with no connected output is
    // pulled automatically, and wiring it onward would put a poisoned branch
    // straight back into the speakers (NaN * 0 is still NaN).
    try {
      const an = ac.createAnalyser();
      if (typeof an.getFloatTimeDomainData === 'function') {
        an.fftSize = 1024;
        an.smoothingTimeConstant = 0;
        if (!wdBuf || wdBuf.length !== an.fftSize) wdBuf = new Float32Array(an.fftSize);
        uwFilter.connect(an);
        analyser = pKeep(an);
      } else {
        analyser = null;
      }
    } catch (e) { analyser = null; }

    masterIn = pGain(Math.min(1, Math.pow(cl(userVol, 0, 1, 0.8), 1.35)));
    masterIn.connect(uwFilter);

    musicBus = pGain(0.0001);
    sfxBus = pGain(SFX_LEVEL);
    ambBus = pGain(0.0001);
    horrorBus = pGain(0.0001);
    musicBus.connect(masterIn);
    sfxBus.connect(masterIn);
    ambBus.connect(masterIn);
    horrorBus.connect(masterIn);

    // ---- feedback-delay "reverb" ----
    // Loop budget, measured not guessed: tap gain 0.42 x lowpass(Q 0.5, peak
    // 1.0) x highpass(Q 0.5, peak 1.0) x shaper(slope <= 1) = 0.42 < 1, and
    // the shaper bounds whatever circulates to |1|. revS/M/L sum into revIn
    // (unity) and revOut feeds masterIn at 0.5, so the send path has headroom
    // even with all three sends wide open.
    revOut = pGain(0.5);
    revOut.connect(masterIn);
    revIn = pGain(1);
    buildRevTap(0.101, 0.42, 2600, -0.45);
    buildRevTap(0.157, 0.38, 1900, 0.45);
    revS = pGain(0.09); revS.connect(revIn);
    revM = pGain(0.24); revM.connect(revIn);
    revL = pGain(0.5); revL.connect(revIn);

    buildPad();
    buildAmbience();
  }

  // One reverb tap. Everything in the loop is provably non-expanding:
  //   delay -> highpass(90 Hz, Q .5) -> lowpass(lp, Q .5) -> shaper -> gain(fb)
  // Q is pinned below 0.708 so neither biquad has a resonant peak (the old taps
  // left Q at its default 1, a +1.25 dB bump sitting inside the loop), the
  // highpass stops DC from stacking up delay-round after delay-round, and the
  // shaper can only ever shrink. Worst-case loop gain: 0.42.
  function buildRevTap(time, fb, lp, pan) {
    const d = pKeep(ac.createDelay(0.5));
    pSet(d.delayTime, dSec(time, 0.1));
    const hp = pFilt('highpass', 90, 0.5);
    const f = pFilt('lowpass', lp, 0.5);
    const ws = pKeep(ac.createWaveShaper());
    ws.curve = limitCurve;
    const g = pGain(cl(fb, 0, 0.6, 0.3));
    const p = ac.createStereoPanner ? pKeep(ac.createStereoPanner()) : null;
    revIn.connect(d);
    d.connect(hp); hp.connect(f); f.connect(ws); ws.connect(g); g.connect(d);
    if (p) { pSet(p.pan, pVal(pan)); d.connect(p); p.connect(revOut); }
    else d.connect(revOut);
  }

  // ---- soft pad: three detuned pairs through a slow, gentle lowpass ----
  // The tremolo now rides its OWN gain node. It used to sum straight into
  // padOut.gain, which musicParams also writes - two writers on one param is
  // exactly how a gain ends up somewhere nobody intended.
  function buildPad() {
    padOut = pGain(0.0001);
    padOut.connect(musicBus);
    padOut.connect(revM);

    const trem = pGain(1);
    trem.connect(padOut);

    padFilter = pFilt('lowpass', 820, 0.7);
    padFilter.connect(trem);

    padVoices = [];
    padDetunes = [];
    const base = [currentChord.r, currentChord.r + 7, currentChord.r + 16];
    for (let i = 0; i < 3; i++) {
      const vg = pGain(i === 0 ? 0.095 : 0.06);
      vg.connect(padFilter);
      const pair = [];
      for (let k = 0; k < 2; k++) {
        // top voice is a triangle: keeps the chord warm instead of reedy
        const o = pOsc(i === 2 ? 'triangle' : 'sawtooth', mtof(base[i]));
        pSet(o.detune, mVal((k === 0 ? -1 : 1) * (4 + i * 3), 2400));
        o.connect(vg);
        o.start();
        pair.push(o);
        padDetunes.push({ p: o.detune, base: pNow(o.detune, 0) });
      }
      padVoices.push(pair);
    }

    // slow filter sweep + gentle tremolo so the pad never sits still.
    // depth is clamped so the cutoff can never fall under 300 Hz.
    pSweep(padFilter.frequency, 820, 240, 0.048, 300);
    const lfoA = pOsc('sine', 0.077);
    const lfoAg = pMod(0.05, 1);
    lfoA.connect(lfoAg); lfoAg.connect(trem.gain); lfoA.start();
  }

  // ---- ocean ambience: brown-noise swells + surf hiss + underwater sub ----
  function buildAmbience() {
    const src = pNoiseSrc(brownBuf, 0.85);
    waveFilter = pFilt('lowpass', 420, 0.7);
    waveGain = pGain(0.30);
    src.connect(waveFilter); waveFilter.connect(waveGain); waveGain.connect(ambBus);
    waveGain.connect(revS);
    src.start(0);

    // swell depth 0.14 against a 0.30 bed: the sea breathes, it never inverts
    const l1 = pOsc('sine', 0.061);
    const l1g = pMod(0.14, 1);
    l1.connect(l1g); l1g.connect(waveGain.gain); l1.start();
    pSweep(waveFilter.frequency, 420, 200, 0.037, 140);

    const s2 = pNoiseSrc(whiteBuf, 1);
    const sf = pFilt('bandpass', 2400, 0.6);
    surfGain = pGain(0.033);
    s2.connect(sf); sf.connect(surfGain); surfGain.connect(ambBus);
    s2.start(0);
    const l3 = pOsc('sine', 0.089);
    const l3g = pMod(0.018, 1);
    l3.connect(l3g); l3g.connect(surfGain.gain); l3.start();

    // underwater sub drone (silent until submerged)
    subGain = pGain(0.0001);
    subGain.connect(ambBus);
    const sub1 = pOsc('sine', 42);
    const sub2 = pOsc('sine', 44.7);
    const sg = pGain(0.5);
    sub1.connect(sg); sub2.connect(sg); sg.connect(subGain);
    sub1.start(); sub2.start();
  }

  // ---- weather bed: rain, wind, rumble (lazily built, then permanent) ----
  // rain/wind/rumble are steady-state gains; the slow gust LFOs modulate a
  // node *before* the level gain, so a target of 0 is true silence.
  const WX_BED = {
    clear:    { rain: 0,    wind: 0,    rumble: 0,    hp: 850, lp: 5200 },
    overcast: { rain: 0,    wind: 0,    rumble: 0,    hp: 850, lp: 5200 },
    fog:      { rain: 0,    wind: 0.03, rumble: 0,    hp: 520, lp: 2400 },
    rain:     { rain: 0.30, wind: 0.05, rumble: 0,    hp: 780, lp: 5400 },
    storm:    { rain: 0.46, wind: 0.30, rumble: 0.26, hp: 560, lp: 7200 },
  };

  function buildWeatherBed() {
    if (wxBuilt || !ac || !built) return;
    wxBuilt = true;
    wxOut = pGain(1);
    wxOut.connect(ambBus);   // ambBus is ducked (not cut) by cutMusic — rain is diegetic

    // rain: white noise squeezed into a band, with a breathing lowpass
    const rs = pNoiseSrc(whiteBuf, 0.92);
    wxRainHP = pFilt('highpass', 850, 0.6);
    wxRainLP = pFilt('lowpass', 5200, 0.7);
    wxRainGain = pGain(0.0001);
    rs.connect(wxRainHP); wxRainHP.connect(wxRainLP); wxRainLP.connect(wxRainGain);
    wxRainGain.connect(wxOut); wxRainGain.connect(revS);
    rs.start(0);
    // fog pulls the rain lowpass down to 2400, so the sweep floor is measured
    // from THERE, not from the 5200 it happens to sit at right now
    pSweep(wxRainLP.frequency, 2400, 1200, 0.127, 700);

    // wind: brown noise through a slow sweep + gust LFO. Q is well under the
    // old 3.4 and the sweep floor is 150 Hz — a bandpass squeezed toward DC
    // with resonance is the classic self-oscillating blow-up.
    const ws = pNoiseSrc(brownBuf, 0.55);
    wxWindFilt = pFilt('bandpass', 380, 2.4);
    const wMod = pGain(1);
    wxWindGain = pGain(0.0001);
    ws.connect(wxWindFilt); wxWindFilt.connect(wMod); wMod.connect(wxWindGain);
    wxWindGain.connect(wxOut); wxWindGain.connect(revM);
    ws.start(0);
    pSweep(wxWindFilt.frequency, 380, 220, 0.041, 150);
    const wl2 = pOsc('sine', 0.077);
    const wl2g = pMod(0.42, 1);
    wl2.connect(wl2g); wl2g.connect(wMod.gain); wl2.start();

    // distant rumble under a storm
    const bs = pNoiseSrc(brownBuf, 0.32);
    const bf = pFilt('lowpass', 120, 0.7);
    const bMod = pGain(1);
    wxRumbleGain = pGain(0.0001);
    bs.connect(bf); bf.connect(bMod); bMod.connect(wxRumbleGain); wxRumbleGain.connect(wxOut);
    bs.start(0);
    const bl = pOsc('sine', 0.029);
    const blg = pMod(0.5, 1);
    bl.connect(blg); blg.connect(bMod.gain); bl.start();

    wxApplied = '';
  }

  // ~3 s crossfade (setTargetAtTime settles in roughly 3 time constants).
  // During horror silence the wind and rumble duck away entirely; the rain
  // stays, quietly, because it is a thing happening in the world.
  function applyWeatherBed(force) {
    if (!ac) return;
    const bed = WX_BED[wxType] || WX_BED.clear;
    const hushed = (musicState === 'silence' || musicState === 'horror');
    const key = wxType + (hushed ? '|h' : '|n') + (underwater ? '|u' : '|a');
    if (!force && key === wxApplied) return;
    if (!wxBuilt && bed.rain <= 0 && bed.wind <= 0 && bed.rumble <= 0) { wxApplied = key; return; }
    buildWeatherBed();
    if (!wxRainGain) return;
    wxApplied = key;
    const t = ac.currentTime;
    const uw = underwater ? 0.4 : 1;    // heard from below, the surface is a rumour
    pTgt(wxRainGain.gain, gVal(Math.max(0.0001, bed.rain * uw)), t, 1.0);
    pTgt(wxWindGain.gain, gVal(Math.max(0.0001, hushed ? 0 : bed.wind * uw)), t, 1.0);
    pTgt(wxRumbleGain.gain, gVal(Math.max(0.0001, hushed ? 0 : bed.rumble)), t, 1.0);
    pTgt(wxRainHP.frequency, fHz(bed.hp, 850), t, 1.2);
    pTgt(wxRainLP.frequency, fHz(bed.lp, 5200), t, 1.2);
  }

  function setWeatherType(type) {
    const t = (typeof type === 'string' && WX_BED[type]) ? type : 'clear';
    if (t === wxType) return;
    wxType = t;
    applyWeatherBed(true);
  }

  // fog: near-silence, and every so often something tones at you out of it
  function fogTone(t) {
    if (!ac || full()) return;
    const f = mtof(55 + Math.floor(Math.random() * 5) * 2 + (Math.random() < 0.35 ? 12 : 0));
    const pan = (Math.random() - 0.5) * 1.6;
    tone('sine', f, t, 4.4, 0.05, ambBus, { atk: 1.5, hold: 1.6, rev: revL, pan });
    tone('sine', f * 1.006, t + 0.35, 3.6, 0.032, ambBus, { atk: 1.7, hold: 1.1, rev: revL, pan: -pan });
    noise(t + 0.2, 3.0, 0.018, ambBus, { type: 'bandpass', f0: f * 6, Q: 9, atk: 1.3, rev: revL, pan });
  }

  // ------------------------------------------------------------------
  // voice bookkeeping
  // ------------------------------------------------------------------
  function reg(end, nodes) {
    let v = voicePool.pop();
    if (!v) v = { nodes: [], end: 0 };
    v.nodes.length = 0;
    for (let i = 0; i < nodes.length; i++) v.nodes.push(nodes[i]);
    v.end = end;
    voices.push(v);
  }
  function reapVoices(tNow) {
    for (let i = voices.length - 1; i >= 0; i--) {
      const v = voices[i];
      if (tNow < v.end) continue;
      for (let k = 0; k < v.nodes.length; k++) {
        try { v.nodes[k].disconnect(); } catch (e) { /* already gone */ }
      }
      v.nodes.length = 0;
      voices[i] = voices[voices.length - 1];
      voices.pop();
      if (voicePool.length < 64) voicePool.push(v);
    }
  }
  function full(priority) { return voices.length >= (priority ? MAX_VOICES + 12 : MAX_VOICES); }

  // ------------------------------------------------------------------
  // primitive synth voices
  // ------------------------------------------------------------------
  // pitched tone with percussive or shaped envelope
  function tone(type, f0, t, dur, g0, dest, o) {
    if (!ac || !built || full(o && o.prio)) return null;
    o = o || EMPTY;
    t = tSec(t);
    dur = cl(dur, 0.02, 30, 0.3);
    const osc = ac.createOscillator();
    osc.type = type;
    pAt(osc.frequency, oHz(f0, 440), t);
    if (o.f1 !== undefined) {
      const gt = t + cl(o.glide !== undefined ? o.glide : dur, 0.005, 30, dur);
      if (o.lin) pLin(osc.frequency, oHz(o.f1, 440), gt);
      else pExp(osc.frequency, oHz(o.f1, 440), gt);
    }
    if (o.detune) pSet(osc.detune, mVal(o.detune, 2400));
    const g = ac.createGain();
    const atk = cl(o.atk, 0.0005, 20, 0.006);
    const peak = gVal(Math.max(0.0004, num(g0, 0.1) * num(curScale, 1)), 0.0004);
    pAt(g.gain, 0.0001, t);
    pExp(g.gain, peak, t + atk);
    if (o.hold) {
      const hold = cl(o.hold, 0, 30, 0.1);
      const holdAt = t + Math.max(atk, hold);
      const endAt = Math.max(holdAt + 0.02, t + dur);
      pAt(g.gain, peak, holdAt);
      pExp(g.gain, 0.0001, endAt);
    } else {
      pExp(g.gain, 0.0001, t + Math.max(atk + 0.02, dur));
    }
    const chain = [osc, g];
    let out = g;
    if (o.shape) {
      const ws = ac.createWaveShaper();
      ws.curve = o.shape === 'hard' ? distCurve : softCurve;
      g.connect(ws); out = ws; chain.push(ws);
    }
    if (o.filter) {
      const f = ac.createBiquadFilter();
      f.type = o.filter;
      pAt(f.frequency, fHz(o.ff0 || 1200, 1200), t);
      if (o.ff1) pExp(f.frequency, fHz(o.ff1, 1200), t + cl(o.fsweep, 0.01, 30, dur));
      pSet(f.Q, qVal(o.fq || 1, 1));
      out.connect(f); out = f; chain.push(f);
    }
    const pv = pVal(num(o.pan, 0) + num(curPan, 0));
    if (pv !== 0 && ac.createStereoPanner) {
      const p = ac.createStereoPanner();
      pSet(p.pan, pv);
      out.connect(p); out = p; chain.push(p);
    }
    osc.connect(g);
    out.connect(dest || sfxBus);
    if (o.rev) out.connect(o.rev);
    osc.start(t);
    osc.stop(t + dur + 0.06);
    reg(t + dur + 0.12, chain);
    return g;
  }

  // filtered noise burst
  function noise(t, dur, g0, dest, o) {
    if (!ac || !built || full(o && o.prio)) return null;
    o = o || EMPTY;
    t = tSec(t);
    dur = cl(dur, 0.01, 30, 0.2);
    const src = ac.createBufferSource();
    src.buffer = o.brown ? brownBuf : whiteBuf;
    src.loop = true;
    pSet(src.playbackRate, rVal(o.rate || 1, 1));
    const chain = [src];
    let out = src;
    if (o.type) {
      const f = ac.createBiquadFilter();
      f.type = o.type;
      pAt(f.frequency, fHz(o.f0 || 1000, 1000), t);
      if (o.f1) pExp(f.frequency, fHz(o.f1, 1000), t + cl(o.sweep, 0.01, 30, dur));
      pSet(f.Q, qVal(o.Q || 1, 1));
      src.connect(f); out = f; chain.push(f);
    }
    const g = ac.createGain();
    const atk = cl(o.atk, 0.0005, 20, 0.004);
    const peak = gVal(Math.max(0.0004, num(g0, 0.1) * num(curScale, 1)), 0.0004);
    pAt(g.gain, 0.0001, t);
    pExp(g.gain, peak, t + atk);
    if (o.hold) {
      const hold = cl(o.hold, 0, 30, 0.1);
      const holdAt = t + Math.max(atk, hold);
      pAt(g.gain, peak, holdAt);
      pExp(g.gain, 0.0001, Math.max(holdAt + 0.02, t + dur));
    } else {
      pExp(g.gain, 0.0001, t + Math.max(atk + 0.02, dur));
    }
    out.connect(g);
    chain.push(g);
    let tail = g;
    const pv = pVal(num(o.pan, 0) + num(curPan, 0));
    if (pv !== 0 && ac.createStereoPanner) {
      const p = ac.createStereoPanner();
      pSet(p.pan, pv);
      g.connect(p); tail = p; chain.push(p);
    }
    tail.connect(dest || sfxBus);
    if (o.rev) tail.connect(o.rev);
    src.start(t, Math.random() * 1.2);
    src.stop(t + dur + 0.06);
    reg(t + dur + 0.12, chain);
    return g;
  }

  // Soft nylon-string pluck: decaying partials + a tiny noise transient.
  //
  // This used to be Karplus-Strong — a delay in a feedback loop whose gain ran
  // up to 0.999, sitting in the ALWAYS-ON music path and sending into the
  // reverb. Two problems: (a) a delay inside a cycle is forced up to a whole
  // render quantum (~2.9 ms), so every note above ~340 Hz played at the wrong
  // pitch and rang for seconds, and (b) a near-unity loop gain has no headroom
  // at all — any drift, any DC, and it grows instead of decaying. Additive
  // partials cannot feed back, cost about the same, and are actually in tune.
  function pluck(t, freq, g0, dest, panv) {
    if (!ac || !built || full()) return;
    const f = oHz(freq, 440);
    const g = gVal(num(g0, 0.15), 0.15);
    const decay = cl(0.95 + 260 / f, 0.45, 2.4, 1.2);
    const d2 = dest || musicBus;
    const pn = panv === undefined ? 0 : pVal(panv);
    tone('triangle', f, t, decay, g * 0.95, d2, { atk: 0.005, rev: revS, pan: pn });
    tone('sine', f * 2.002, t, decay * 0.42, g * 0.3, d2, { atk: 0.004, pan: pn });
    tone('sine', f * 3.01, t, decay * 0.16, g * 0.1, d2, { atk: 0.003, pan: pn });
    noise(t, 0.03, g * 0.22, d2, { type: 'bandpass', f0: cl(f * 3, 200, 7000, 900), Q: 1.1, atk: 0.001, pan: pn });
  }

  // marimba-ish: sine fundamental + 4th partial, fast decay
  function marimba(t, freq, g0, dest) {
    if (!ac || full()) return;
    tone('sine', freq, t, 1.0, g0, dest, { atk: 0.004, rev: revM });
    tone('sine', freq * 4.02, t, 0.28, g0 * 0.22, dest, { atk: 0.002 });
  }

  function bell(t, freq, g0, dur, dest, rev) {
    tone('sine', freq, t, dur, g0, dest, { atk: 0.004, rev: rev || revM });
    tone('triangle', freq * 2.01, t, dur * 0.5, g0 * 0.35, dest, { atk: 0.003 });
    tone('sine', freq * 3.02, t, dur * 0.3, g0 * 0.16, dest, { atk: 0.002 });
  }

  function shaker(t, g0) {
    noise(t, 0.055, g0, musicBus, { type: 'highpass', f0: 7000, Q: 0.7, atk: 0.002, pan: (Math.random() - 0.5) * 0.5 });
  }

  function swell(t, dur, g0, panv) {
    if (!ac || !built || full()) return;
    t = tSec(t);
    dur = cl(dur, 0.2, 20, 4);
    const src = ac.createBufferSource();
    src.buffer = brownBuf; src.loop = true;
    pSet(src.playbackRate, rVal(0.7, 1));
    const f = ac.createBiquadFilter();
    f.type = 'lowpass';
    pSet(f.Q, qVal(0.6, 0.6));
    pAt(f.frequency, fHz(280, 280), t);
    pLin(f.frequency, fHz(900, 900), t + dur * 0.45);
    pLin(f.frequency, fHz(240, 240), t + dur);
    const g = ac.createGain();
    pAt(g.gain, 0.0001, t);
    pLin(g.gain, gVal(num(g0, 0.1) * num(curScale, 1), 0.1), t + dur * 0.45);
    pLin(g.gain, 0.0001, t + dur);
    src.connect(f); f.connect(g);
    let tail = g;
    if (panv !== undefined && ac.createStereoPanner) {
      const p = ac.createStereoPanner(); pSet(p.pan, pVal(panv));
      g.connect(p); tail = p;
    }
    tail.connect(musicBus);
    tail.connect(revM);
    src.start(t, Math.random() * 2);
    src.stop(t + dur + 0.05);
    reg(t + dur + 0.1, [src, f, g, tail]);
  }

  // ------------------------------------------------------------------
  // music scheduler
  // ------------------------------------------------------------------
  function regenMelody() {
    const rng = mulberry32(((Math.random() * 0xffffffff) | 0) >>> 0);
    melody.fill(-1);
    const night = nightAmt > 0.5;
    // 12 notes per 8 bars was a tune fighting for attention. This is a tune
    // you could fall asleep to, which is the point.
    const density = night ? 4 : 7;
    for (let i = 0; i < density; i++) {
      const bar = Math.floor(rng() * 8);
      const slot = MELODY_SLOTS[Math.floor(rng() * (night ? 2 : 5))];
      melody[(bar * BAR_STEPS + slot) % PHRASE_STEPS] = 1 + Math.floor(rng() * 5);
    }
    // never start a phrase on a rest - gives the ear an anchor
    melody[0] = 1 + Math.floor(rng() * 3);
  }

  function setChord(ch, t) {
    if (!padVoices) return;
    currentChord = ch;
    const third = ch.min ? 3 : 4;
    const targets = [ch.r, ch.r + 7, ch.r + 12 + third];
    for (let i = 0; i < 3; i++) {
      const f = oHz(mtof(targets[i]), 220);
      // 0.18 s glide: chords lean into each other instead of stepping
      pTgt(padVoices[i][0].frequency, f, t, 0.18);
      pTgt(padVoices[i][1].frequency, f, t, 0.18);
    }
  }

  function scheduleStep(gs, t) {
    const s = gs % BAR_STEPS;
    const bar = Math.floor(gs / BAR_STEPS) % 8;
    const chordIdx = bar % 4;
    const night = nightAmt > 0.5;
    const nAmt = nightAmt;
    const dAmt = 1 - nightAmt;
    const scale = night ? NIGHT_SCALE : DAY_SCALE;
    const tones = (night ? NIGHT_TONES : DAY_TONES)[chordIdx];
    // Day and night are one boolean switch on top of two crossfading gains, so
    // the raw layer amount dips to 0.5 exactly at the changeover and the tune
    // ducks for a moment. Scaling it back up keeps the handover inaudible.
    const layer = clamp((night ? nAmt : dAmt) * 1.75, 0, 1);

    if (gs % PHRASE_STEPS === 0) regenMelody();

    if (s === 0) {
      setChord((night ? NIGHT_PROG : DAY_PROG)[chordIdx], t);
      // soft sub bass on the downbeat — long attack, no thump
      tone('sine', mtof(currentChord.r - 12), t, night ? 2.4 : 1.8, night ? 0.13 : 0.15, musicBus, { atk: 0.06 });
      if (!night && bar % 2 === 1) {
        tone('sine', mtof(currentChord.r - 12), t + SPB * 2, 1.2, 0.09, musicBus, { atk: 0.06 });
      }
      if (nAmt > 0.35 && bar % 4 === 0) swell(t, 5.6, 0.12 * nAmt, (Math.random() - 0.5) * 1.2);
    }

    // ---- plucks (the island theme's heartbeat) ----
    const pSteps = night ? NIGHT_PLUCK_STEPS : DAY_PLUCK_STEPS;
    for (let i = 0; i < pSteps.length; i++) {
      if (pSteps[i] !== s) continue;
      if (layer < 0.08) break;
      const idx = tones[arpCursor % tones.length] + (arpCursor % 7 === 6 ? 5 : 0);
      arpCursor++;
      const f = mtof(scaleMidi(scale, idx));
      const accent = (s === 0) ? 1.0 : 0.68;
      pluck(t, f, 0.15 * accent * layer * (0.88 + Math.random() * 0.24), musicBus, (Math.random() - 0.5) * 0.6);
      // a soft octave shadow on the downbeat keeps it lush
      if (s === 0 && !night) pluck(t + 0.014, f * 2, 0.04 * layer, musicBus, 0.28);
      break;
    }

    // ---- marimba melody ----
    const mv = melody[gs % PHRASE_STEPS];
    if (mv > 0 && layer > 0.1) {
      const idx = tones[(mv - 1) % tones.length] + 5;
      marimba(t, mtof(scaleMidi(scale, idx)), 0.13 * layer * (night ? 0.75 : 1), musicBus);
    }

    // ---- a single sunlit chime, twice a phrase, day only ----
    if (!night && layer > 0.3 && s === 8 && bar % 4 === 2) {
      bell(t, mtof(scaleMidi(scale, tones[0] + 7)), 0.045 * layer, 2.2, musicBus, revL);
    }

    // ---- shaker: backbeat only, brushed, never a hi-hat pattern ----
    const shSteps = night ? NIGHT_SHAKER_STEPS : DAY_SHAKER_STEPS;
    if (layer > 0.15) {
      for (let i = 0; i < shSteps.length; i++) {
        if (shSteps[i] !== s) continue;
        shaker(t, (night ? 0.024 : 0.038) * layer);
        break;
      }
    }
  }

  function scheduleAhead() {
    if (!schedulerOn || !ac) return;
    const horizon = ac.currentTime + LOOKAHEAD;
    if (nextNoteTime < ac.currentTime - 0.5) nextNoteTime = ac.currentTime + 0.05; // tab was backgrounded
    let guard = 0;
    while (nextNoteTime < horizon && guard++ < 48) {
      try { scheduleStep(stepIdx, nextNoteTime); } catch (e) { warn(e); }
      nextNoteTime += STEP;
      stepIdx++;
    }
  }

  function nightnessOf(tod) {
    const dusk = smoothstep(ECON.NIGHT_START - 0.04, ECON.NIGHT_START + 0.06, tod);
    const predawn = 1 - smoothstep(0.02, 0.10, tod);
    return clamp(Math.max(dusk, predawn), 0, 1);
  }

  function musicParams(t) {
    if (!padOut || !padFilter) return;
    const nA = cl(nightAmt, 0, 1, 0);
    // pad sits lower and darker than it used to — it is a bed, not a lead
    pTgt(padOut.gain, gVal(0.26 + nA * 0.12), t, 0.6);
    // base 980 with a clamped +/-240 sweep never reaches the 300 Hz floor
    pTgt(padFilter.frequency, fHz(980 - nA * 380, 900), t, 0.9);
    pTgt(padFilter.Q, qVal(0.7 + nA * 0.35), t, 0.9);
    if (waveGain) pTgt(waveGain.gain, gVal(0.30 + nA * 0.06 + (underwater ? 0.08 : 0)), t, 1.2);
    if (surfGain) pTgt(surfGain.gain, gVal(underwater ? 0.008 : 0.033 - nA * 0.01), t, 1.2);
  }

  // ------------------------------------------------------------------
  // music transport
  // ------------------------------------------------------------------
  // An exponential ramp from the 0.0001 "off" floor up to 0.75 spans nearly 80
  // dB: the first two seconds are inaudible and then it blooms all at once —
  // and on a meter it reads as a textbook runaway (e^3.6/s). Fading up from
  // -34 dB instead is both a smoother fade and an honest-looking envelope.
  function fadeBus(bus, to, dur) {
    if (!bus || !ac) return;
    const t = ac.currentTime;
    const dst = gVal(Math.max(0.0001, num(to, 0.0001)), 0.0001);
    let cur = gVal(Math.max(0.0001, pNow(bus.gain, 0.0001)), 0.0001);
    const floor = dst * 0.02;
    if (dst > cur && cur < floor) cur = gVal(floor, 0.0001);
    pCancel(bus.gain, t);
    pAt(bus.gain, cur, t);
    pExp(bus.gain, dst, t + cl(dur, 0.01, 30, 1));
  }

  function resumeMusic(fade) {
    if (!ac) return;
    schedulerOn = true;
    musicState = 'playing';
    stepIdx = 0;
    arpCursor = 0;
    regenMelody();
    nextNoteTime = ac.currentTime + 0.14;
    fadeBus(musicBus, MUSIC_LEVEL, fade);
    if (started) fadeBus(ambBus, AMB_LEVEL, Math.max(1.5, fade));
    // gentle re-entry: a single warm bell so the return is felt, not just heard
    if (fade > 2) bell(ac.currentTime + 0.15, mtof(nightAmt > 0.5 ? 69 : 72), 0.1, 2.4, musicBus, revL);
  }

  function cutMusic() {
    if (!ac || !musicBus) { musicState = 'silence'; cutAt = ac ? ac.currentTime : 0; return; }
    const t = ac.currentTime;
    pCancel(musicBus.gain, t);
    pAt(musicBus.gain, gVal(Math.max(0.0001, pNow(musicBus.gain, 0.0001)), 0.0001), t);
    pLin(musicBus.gain, 0.0001, t + 0.022);   // the silence IS the scare
    schedulerOn = false;
    if (musicState !== 'horror') {   // a second cut mid-event must not restart the dread timer
      musicState = 'silence';
      cutAt = t;
    }
    // duck the sea a touch so the hole in the mix is unmistakable
    if (ambBus) fadeBus(ambBus, AMB_LEVEL * 0.55, 0.5);
  }

  function stopMusic(fade) {
    schedulerOn = false;
    musicState = 'stopped';
    fadeBus(musicBus, 0.0001, fade || 1.5);
  }

  function startMusic() {
    if (!ensureContext(true)) return;
    started = true;
    if (ac.state === 'suspended') ac.resume().catch(() => { });
    const dread = (musicState === 'silence' || musicState === 'horror') && eventActive;
    fadeBus(ambBus, dread ? AMB_LEVEL * 0.55 : AMB_LEVEL, 2.5);
    // never override a live horror cut or the post-event quiet; otherwise (re)start the theme
    if (!dread && musicState !== 'playing' && musicState !== 'quiet') resumeMusic(4.0);
  }

  // ------------------------------------------------------------------
  // horror layer
  // ------------------------------------------------------------------
  function startHorror() {
    if (!ac || !built || horrorNodes) return;
    const t = ac.currentTime;
    const nodes = {};
    const mix = gainNode(1);
    mix.connect(horrorBus);

    // two detuned sub sines with a slow amplitude LFO
    const dGain = gainNode(0.34);
    dGain.connect(mix);
    const o1 = ac.createOscillator(); o1.type = 'sine'; pSet(o1.frequency, oHz(34.6));
    const o2 = ac.createOscillator(); o2.type = 'sine'; pSet(o2.frequency, oHz(36.3));
    const o3 = ac.createOscillator(); o3.type = 'triangle'; pSet(o3.frequency, oHz(69.4));
    const o3g = gainNode(0.14); o3.connect(o3g); o3g.connect(dGain);
    o1.connect(dGain); o2.connect(dGain);
    const lfo = ac.createOscillator(); lfo.type = 'sine'; pSet(lfo.frequency, oHz(0.11));
    const lfog = ac.createGain(); pSet(lfog.gain, mVal(0.16, 1)); lfo.connect(lfog); lfog.connect(dGain.gain);
    o1.start(); o2.start(); o3.start(); lfo.start();

    // a breath of pressure under everything
    const bs = ac.createBufferSource();
    bs.buffer = brownBuf; bs.loop = true; pSet(bs.playbackRate, rVal(0.6));
    const bf = ac.createBiquadFilter(); bf.type = 'bandpass';
    pSet(bf.frequency, fHz(190)); pSet(bf.Q, qVal(1.4));
    const bg = gainNode(0.16);
    bs.connect(bf); bf.connect(bg); bg.connect(mix);
    const blfo = ac.createOscillator(); blfo.type = 'sine'; pSet(blfo.frequency, oHz(0.073));
    const blfog = ac.createGain(); pSet(blfog.gain, mVal(0.1, 1)); blfo.connect(blfog); blfog.connect(bg.gain);
    bs.start(0); blfo.start();

    nodes.list = [mix, dGain, o1, o2, o3, o3g, lfo, lfog, bs, bf, bg, blfo, blfog];
    nodes.osc = [o1, o2, o3, lfo, blfo];
    nodes.src = [bs];
    horrorNodes = nodes;

    pCancel(horrorBus.gain, t);
    pAt(horrorBus.gain, 0.0001, t);
    pExp(horrorBus.gain, gVal(HORROR_LEVEL), t + 3.5);
    horrorAt = t;
    nextHeart = t + 2.2;
    nextScrape = t + 9 + Math.random() * 10;
  }

  function stopHorror(fade) {
    if (!ac || !horrorNodes) return;
    const t = ac.currentTime;
    fadeBus(horrorBus, 0.0001, fade);
    const n = horrorNodes;
    horrorNodes = null;
    const stopAt = t + fade + 0.2;
    for (let i = 0; i < n.osc.length; i++) { try { n.osc[i].stop(stopAt); } catch (e) { /* noop */ } }
    for (let i = 0; i < n.src.length; i++) { try { n.src[i].stop(stopAt); } catch (e) { /* noop */ } }
    reg(stopAt + 0.1, n.list);
  }

  let nextHeart = 0, nextScrape = 0;

  function heartThump(t, g0, dest) {
    tone('sine', 74, t, 0.34, g0, dest, { f1: 34, glide: 0.22, atk: 0.008 });
    noise(t, 0.09, g0 * 0.5, dest, { type: 'lowpass', f0: 200, Q: 1.2, atk: 0.003 });
  }

  function scrapeStinger(t) {
    const dest = horrorBus || sfxBus;
    noise(t, 1.1, 0.16, dest, { type: 'bandpass', f0: 2600, f1: 700, sweep: 1.0, Q: 11, atk: 0.05, rev: revL, pan: (Math.random() - 0.5) * 1.4 });
    tone('sawtooth', 3120, t + 0.05, 1.4, 0.03, dest, { f1: 1180, glide: 1.2, filter: 'bandpass', ff0: 3000, fq: 8, rev: revL });
    tone('sine', 58, t, 1.6, 0.14, dest, { f1: 41, glide: 1.4, atk: 0.1 });
  }

  // ------------------------------------------------------------------
  // event flow
  // ------------------------------------------------------------------
  function onEventStart(type) {
    eventActive = true;
    ensureContext(gestureSeen || started);
    cutMusic();
    if (type) sfxDedup('eventDrone', { type }, 1.0);
  }

  function onEventEnd() {
    if (!eventActive && musicState === 'playing') return;
    eventActive = false;
    evStateSeen = false;
    if (!ac) { musicState = 'stopped'; return; }
    eventEndAt = ac.currentTime;
    fadeBus(ambBus, AMB_LEVEL, 3.0);
    if (horrorNodes) {
      stopHorror(2.0);
      resumeAt = ac.currentTime + 6.0;   // 2s fade + 4s of held breath
    } else {
      resumeAt = ac.currentTime + 4.0;
    }
    musicState = 'quiet';
    schedulerOn = false;
  }

  // ------------------------------------------------------------------
  // ambience creatures
  // ------------------------------------------------------------------
  // a true FM chirp: sine carrier swept up then down, sine modulator on its
  // frequency with a falling index - reads as a gull, costs 5 nodes
  function gullChirp(t, g0, panv) {
    if (!ac || !built || full()) return;
    t = tSec(t);
    const car = ac.createOscillator();
    car.type = 'sine';
    pAt(car.frequency, oHz(760), t);
    pExp(car.frequency, oHz(1520), t + 0.07);
    pExp(car.frequency, oHz(640), t + 0.3);
    const mod = ac.createOscillator();
    mod.type = 'sine';
    pSet(mod.frequency, oHz(140 + Math.random() * 60));
    const modG = ac.createGain();
    // depth stays under the 760 Hz carrier floor: the FM index can never
    // swing the carrier through zero
    pAt(modG.gain, mVal(420, 20000), t);
    pExp(modG.gain, mVal(50, 20000), t + 0.3);
    mod.connect(modG);
    modG.connect(car.frequency);
    const g = ac.createGain();
    pAt(g.gain, 0.0001, t);
    pExp(g.gain, gVal(Math.max(0.0005, num(g0, 0.08) * num(curScale, 1))), t + 0.025);
    pExp(g.gain, 0.0001, t + 0.3);
    car.connect(g);
    let tail = g;
    if (ac.createStereoPanner) {
      const p = ac.createStereoPanner();
      pSet(p.pan, pVal(panv));
      g.connect(p); tail = p;
    }
    tail.connect(ambBus);
    tail.connect(revM);
    car.start(t); car.stop(t + 0.36);
    mod.start(t); mod.stop(t + 0.36);
    reg(t + 0.42, [car, mod, modG, g, tail]);
  }

  function gullCall(t, panv) {
    const n = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      gullChirp(t + i * (0.26 + Math.random() * 0.08), 0.085 * Math.pow(0.78, i), panv);
    }
  }

  function cricketCall(t, panv) {
    for (let i = 0; i < 4; i++) {
      noise(t + i * 0.035, 0.02, 0.03, ambBus, { type: 'bandpass', f0: 4500 + Math.random() * 500, Q: 22, atk: 0.003, pan: panv });
    }
  }

  // ------------------------------------------------------------------
  // SFX bank
  // ------------------------------------------------------------------
  const SFX = {
    castWhoosh(t, o) {
      noise(t, 0.34, 0.22, sfxBus, { type: 'bandpass', f0: 380, f1: 2100, sweep: 0.18, Q: 1.1, atk: 0.03, pan: -0.15 });
      noise(t + 0.16, 0.24, 0.13, sfxBus, { type: 'bandpass', f0: 1900, f1: 520, sweep: 0.22, Q: 1.4, atk: 0.02, pan: 0.2 });
      tone('sine', 520, t + 0.02, 0.16, 0.03, sfxBus, { f1: 210, atk: 0.01 });
    },
    plop(t, o) {
      tone('sine', 1250, t, 0.13, 0.34, sfxBus, { f1: 260, glide: 0.075, atk: 0.002, rev: revS });
      noise(t, 0.06, 0.11, sfxBus, { type: 'bandpass', f0: 1600, Q: 1.6, atk: 0.002 });
      tone('sine', 340, t + 0.04, 0.2, 0.06, sfxBus, { f1: 170, atk: 0.01 });
    },
    splash(t, o) {
      const s = clamp(o.size !== undefined ? o.size : 1, 0.25, 3);
      const g = 0.26 * Math.min(1.6, s);
      noise(t, 0.42 * s, g, sfxBus, { type: 'bandpass', f0: 1100 / s, f1: 420 / s, sweep: 0.3, Q: 0.9, atk: 0.004, rev: revS });
      noise(t + 0.02, 0.3, g * 0.5, sfxBus, { type: 'highpass', f0: 2600, Q: 0.7, atk: 0.004 });
      tone('sine', 380 / s, t, 0.22, 0.08 * s, sfxBus, { f1: 130 / s, atk: 0.005 });
      for (let i = 0; i < 3; i++) SFX.bubble(t + 0.12 + i * 0.07, EMPTY);
    },
    bite(t, o) {
      tone('square', 980, t, 0.06, 0.16, sfxBus, { f1: 760, atk: 0.002, filter: 'lowpass', ff0: 3000 });
      tone('square', 1320, t + 0.075, 0.07, 0.17, sfxBus, { f1: 980, atk: 0.002, filter: 'lowpass', ff0: 3400, rev: revS });
      // line tension creak
      tone('sawtooth', 118, t + 0.06, 0.5, 0.07, sfxBus, { f1: 178, glide: 0.42, filter: 'bandpass', ff0: 620, fq: 7, atk: 0.05 });
      noise(t + 0.05, 0.3, 0.06, sfxBus, { type: 'bandpass', f0: 900, f1: 1500, Q: 8, atk: 0.06 });
    },
    reelClick(t, o) {
      if (o && o.on !== undefined) {
        reelOn = !!o.on;
        reelHold = 0;                       // explicit on/off, no keep-alive
        if (reelOn && ac) nextReelTick = ac.currentTime + 0.01;
        return;
      }
      reelTick(t, 1);
    },
    lineSnap(t, o) {
      noise(t, 0.09, 0.3, sfxBus, { type: 'highpass', f0: 3200, Q: 0.8, atk: 0.001 });
      tone('sawtooth', 880, t, 0.28, 0.16, sfxBus, { f1: 190, glide: 0.16, filter: 'bandpass', ff0: 1400, fq: 4, atk: 0.002, rev: revM });
      tone('triangle', 1760, t, 0.12, 0.07, sfxBus, { f1: 420, atk: 0.001 });
    },
    catchFanfare(t, o) {
      const tier = clamp(Math.round(o.tier || 1), 1, 11);
      const n = clamp(3 + Math.floor(tier / 2), 3, 8);
      const rich = tier >= 6;
      const grand = tier >= 9;
      const root = 60;
      const steps = [0, 4, 7, 12, 16, 19, 24, 28];
      const dt = grand ? 0.13 : 0.105;
      for (let i = 0; i < n; i++) {
        const tt = t + i * dt;
        const f = mtof(root + steps[i]);
        bell(tt, f, 0.16 + tier * 0.006, grand ? 1.4 : 0.9, sfxBus, rich ? revL : revM);
        if (rich) tone('triangle', f * 1.5, tt, 0.5, 0.045, sfxBus, { atk: 0.005 });
      }
      const endT = t + n * dt;
      if (grand) {
        bell(endT + 0.06, mtof(root + 31), 0.24, 2.4, sfxBus, revL);
        tone('sine', mtof(root - 24), endT, 1.6, 0.2, sfxBus, { atk: 0.02 });
        noise(endT, 0.6, 0.05, sfxBus, { type: 'highpass', f0: 6000, atk: 0.02, rev: revL });
      } else if (rich) {
        tone('sine', mtof(root - 12), endT, 1.0, 0.14, sfxBus, { atk: 0.02 });
      }
    },
    catchMutation(t, o) {
      for (let i = 0; i < 12; i++) {
        const tt = t + i * 0.045;
        const f = mtof(72 + i * 2 + Math.floor(Math.random() * 3));
        tone('sine', f, tt, 0.55, 0.075, sfxBus, { atk: 0.003, rev: revL, pan: Math.sin(i * 1.7) * 0.6 });
        if (i % 3 === 0) tone('triangle', f * 2, tt, 0.3, 0.03, sfxBus, { atk: 0.002 });
      }
      tone('sine', mtof(84), t + 0.55, 1.8, 0.11, sfxBus, { f1: mtof(96), glide: 1.4, atk: 0.05, rev: revL });
      noise(t + 0.1, 0.9, 0.05, sfxBus, { type: 'highpass', f0: 7000, atk: 0.1, rev: revL });
    },
    coin(t, o) { SFX.sell(t, o); },
    sell(t, o) {
      const notes = [88, 92, 95, 100];
      for (let i = 0; i < notes.length; i++) {
        bell(t + i * 0.055, mtof(notes[i]), 0.13 - i * 0.012, 0.5, sfxBus, revM);
      }
      noise(t, 0.12, 0.05, sfxBus, { type: 'highpass', f0: 5200, atk: 0.002 });
    },
    buy(t, o) {
      noise(t, 0.08, 0.22, sfxBus, { type: 'lowpass', f0: 900, Q: 2.2, atk: 0.002 });
      tone('sine', 180, t, 0.1, 0.16, sfxBus, { f1: 90, atk: 0.002 });
      bell(t + 0.06, mtof(79), 0.11, 0.5, sfxBus, revM);
      bell(t + 0.14, mtof(86), 0.1, 0.6, sfxBus, revM);
    },
    error(t, o) {
      tone('square', 92, t, 0.26, 0.16, sfxBus, { atk: 0.006, filter: 'lowpass', ff0: 420, fq: 2, hold: 0.16 });
      tone('square', 61, t, 0.3, 0.12, sfxBus, { atk: 0.006, filter: 'lowpass', ff0: 300, hold: 0.18 });
      noise(t, 0.1, 0.04, sfxBus, { type: 'lowpass', f0: 700, atk: 0.005 });
    },
    footstep(t, o) {
      const s = o.surface || 'sand';
      if (s === 'wood' || s === 'dock') {
        noise(t, 0.11, 0.14, sfxBus, { type: 'bandpass', f0: 420, Q: 3.5, atk: 0.002 });
        tone('sine', 168, t, 0.1, 0.09, sfxBus, { f1: 96, atk: 0.002 });
      } else if (s === 'stone' || s === 'rock') {
        noise(t, 0.09, 0.13, sfxBus, { type: 'bandpass', f0: 1500, Q: 2, atk: 0.002 });
        tone('sine', 210, t, 0.07, 0.05, sfxBus, { f1: 120, atk: 0.002 });
      } else if (s === 'water' || s === 'shallow') {
        noise(t, 0.2, 0.13, sfxBus, { type: 'bandpass', f0: 1300, f1: 600, Q: 0.9, atk: 0.004 });
        SFX.bubble(t + 0.06, EMPTY);
      } else if (s === 'grass') {
        noise(t, 0.13, 0.1, sfxBus, { type: 'bandpass', f0: 1900, Q: 1.1, atk: 0.004 });
      } else { // sand
        noise(t, 0.14, 0.11, sfxBus, { type: 'lowpass', f0: 1100, Q: 0.8, atk: 0.005 });
        tone('sine', 120, t, 0.09, 0.05, sfxBus, { f1: 70, atk: 0.004 });
      }
    },
    jumpThud(t, o) {
      noise(t, 0.16, 0.17, sfxBus, { type: 'lowpass', f0: 800, Q: 1.1, atk: 0.003 });
      tone('sine', 150, t, 0.2, 0.16, sfxBus, { f1: 62, glide: 0.14, atk: 0.003 });
    },
    motorLoop(t, o) {
      motorAuto = false;   // a module is driving the engine explicitly now
      if (o.on === false) { motorStop(); return; }
      motorStart();
      if (!motor) return;
      const th = cl(o.throttle !== undefined ? o.throttle : 0.5, 0, 1, 0.5);
      const lv = cl(o.level, 1, 4, motor.level || 1);
      if (Math.abs(th - motor.throttle) > 0.01 || lv !== motor.level) motorDirty = true;
      motor.throttle = th;
      motor.level = lv;
      // params are applied from update() at ~12 Hz - boat.js may call this every frame
    },
    enemyHurt(t, o) {
      noise(t, 0.18, 0.2, sfxBus, { type: 'bandpass', f0: 700, f1: 320, sweep: 0.15, Q: 2.2, atk: 0.002 });
      tone('sawtooth', 260, t, 0.22, 0.13, sfxBus, { f1: 110, glide: 0.18, filter: 'lowpass', ff0: 1200, atk: 0.003, shape: 'soft' });
      SFX.bubble(t + 0.05, EMPTY);
    },
    enemyDie(t, o) {
      tone('sawtooth', 240, t, 0.9, 0.18, sfxBus, { f1: 48, glide: 0.8, filter: 'lowpass', ff0: 1400, ff1: 300, atk: 0.004, shape: 'soft', rev: revM });
      noise(t + 0.1, 0.7, 0.16, sfxBus, { type: 'bandpass', f0: 900, f1: 260, sweep: 0.6, Q: 1.2, atk: 0.02, rev: revM });
      for (let i = 0; i < 5; i++) SFX.bubble(t + 0.2 + i * 0.09, EMPTY);
    },
    harpoonThrow(t, o) {
      noise(t, 0.26, 0.18, sfxBus, { type: 'bandpass', f0: 500, f1: 1800, sweep: 0.16, Q: 1.3, atk: 0.02 });
      tone('triangle', 1500, t + 0.04, 0.3, 0.07, sfxBus, { f1: 420, glide: 0.26, atk: 0.003, rev: revS });
      noise(t, 0.05, 0.1, sfxBus, { type: 'highpass', f0: 3000, atk: 0.001 });
    },
    spearShot(t, o) {
      noise(t, 0.07, 0.26, sfxBus, { type: 'lowpass', f0: 1500, Q: 3, atk: 0.001 });
      tone('square', 340, t, 0.1, 0.14, sfxBus, { f1: 120, atk: 0.001, filter: 'lowpass', ff0: 1800 });
      tone('sine', 2400, t + 0.02, 0.22, 0.06, sfxBus, { f1: 700, glide: 0.2, atk: 0.002, rev: revS });
    },
    tridentZap(t, o) {
      for (let i = 0; i < 9; i++) {
        const tt = t + i * 0.018 + Math.random() * 0.012;
        noise(tt, 0.05, 0.13, sfxBus, { type: 'bandpass', f0: 1400 + Math.random() * 3200, Q: 16, atk: 0.001, pan: (Math.random() - 0.5) * 1.2 });
      }
      tone('sawtooth', 2600, t, 0.35, 0.14, sfxBus, { f1: 320, glide: 0.3, filter: 'bandpass', ff0: 2600, ff1: 700, fq: 9, atk: 0.001, shape: 'hard', rev: revM });
      tone('square', 88, t, 0.4, 0.13, sfxBus, { f1: 44, glide: 0.35, filter: 'lowpass', ff0: 500, atk: 0.004 });
      noise(t + 0.05, 0.5, 0.07, sfxBus, { type: 'highpass', f0: 5000, atk: 0.01, rev: revM });
    },
    impact(t, o) {
      tone('sine', 190, t, 0.26, 0.24, sfxBus, { f1: 58, glide: 0.16, atk: 0.002 });
      noise(t, 0.11, 0.2, sfxBus, { type: 'lowpass', f0: 1600, Q: 1.4, atk: 0.001 });
      noise(t, 0.05, 0.12, sfxBus, { type: 'highpass', f0: 3500, atk: 0.001 });
    },
    playerHurt(t, o) {
      noise(t, 0.22, 0.2, sfxBus, { type: 'lowpass', f0: 520, Q: 1.6, atk: 0.002 });
      tone('sine', 130, t, 0.3, 0.2, sfxBus, { f1: 62, glide: 0.2, atk: 0.003 });
      // grunt: a saw through two formant bandpasses
      tone('sawtooth', 152, t + 0.01, 0.26, 0.1, sfxBus, { f1: 108, glide: 0.24, filter: 'bandpass', ff0: 640, fq: 6, atk: 0.01, shape: 'soft' });
      tone('sawtooth', 152, t + 0.01, 0.22, 0.05, sfxBus, { f1: 108, glide: 0.2, filter: 'bandpass', ff0: 1180, fq: 9, atk: 0.01 });
    },
    drown(t, o) {
      for (let i = 0; i < 14; i++) {
        SFX.bubble(t + i * (0.07 + Math.random() * 0.06), EMPTY);
      }
      noise(t, 1.4, 0.14, sfxBus, { type: 'lowpass', f0: 600, f1: 180, sweep: 1.2, Q: 1.2, atk: 0.1 });
      tone('sine', 96, t + 0.2, 1.2, 0.12, sfxBus, { f1: 40, glide: 1.0, atk: 0.15 });
    },
    heartbeat(t, o) {
      const g = o.gain !== undefined ? o.gain : 0.32;
      heartThump(t, g, sfxBus);
      heartThump(t + 0.21, g * 0.72, sfxBus);
    },
    eventDrone(t, o) {
      const type = o.type || 'serpent';
      const dest = sfxBus;
      if (type === 'kraken') {
        tone('sine', 33, t, 5.5, 0.34, dest, { atk: 0.6, hold: 3.0 });
        tone('sine', 41.4, t, 5.5, 0.2, dest, { atk: 0.8, hold: 3.0 });
        tone('sawtooth', 220, t, 4.5, 0.05, dest, { f1: 150, glide: 4, filter: 'bandpass', ff0: 500, fq: 9, atk: 1.2, rev: revL });
      } else if (type === 'bloop') {
        tone('sine', 78, t, 6.0, 0.34, dest, { f1: 30, glide: 5.4, atk: 0.5, rev: revL });
        tone('square', 39, t, 6.0, 0.1, dest, { f1: 15, glide: 5.4, filter: 'lowpass', ff0: 260, atk: 0.9 });
        noise(t, 6, 0.07, dest, { type: 'lowpass', f0: 240, f1: 90, sweep: 5, Q: 1.4, atk: 1.5, rev: revL });
      } else {
        tone('sawtooth', 55, t, 5.5, 0.16, dest, { atk: 0.7, hold: 2.6, filter: 'lowpass', ff0: 420, fq: 3, shape: 'soft' });
        tone('sawtooth', 55.6, t, 5.5, 0.14, dest, { atk: 0.9, hold: 2.6, filter: 'lowpass', ff0: 380, fq: 3 });
        tone('sine', 27.5, t, 5.5, 0.28, dest, { atk: 0.5, hold: 3 });
        noise(t + 0.5, 4.5, 0.06, dest, { type: 'bandpass', f0: 700, f1: 300, sweep: 4, Q: 4, atk: 1.4, rev: revL });
      }
    },
    serpentRoar(t, o) {
      const base = 96;
      for (let i = 0; i < 3; i++) {
        tone('sawtooth', base * (1 + i * 0.012) * (i === 2 ? 1.5 : 1), t, 2.2, 0.14, sfxBus, {
          f1: base * 0.55 * (i === 2 ? 1.5 : 1), glide: 1.9, atk: 0.08,
          filter: 'bandpass', ff0: i === 0 ? 420 : (i === 1 ? 900 : 1900), fq: 5, shape: 'hard', rev: revL,
        });
      }
      // growl: fast amplitude LFO carved into a lowpassed saw
      const g = tone('sawtooth', base * 0.5, t, 2.4, 0.16, sfxBus, { f1: base * 0.3, glide: 2.0, filter: 'lowpass', ff0: 900, ff1: 300, fq: 2, atk: 0.06, shape: 'soft' });
      if (g && ac) {
        const lfo = ac.createOscillator(); lfo.type = 'sine';
        pAt(lfo.frequency, oHz(26), t);
        pExp(lfo.frequency, oHz(14), t + 2.2);
        const lg = gainNode(0.09);
        lfo.connect(lg); lg.connect(g.gain);
        lfo.start(t); lfo.stop(t + 2.5);
        reg(t + 2.6, [lfo, lg]);
      }
      noise(t + 0.05, 2.0, 0.1, sfxBus, { type: 'bandpass', f0: 1600, f1: 500, sweep: 1.8, Q: 2, atk: 0.12, rev: revL });
      tone('sine', 44, t, 2.6, 0.26, sfxBus, { f1: 30, glide: 2.2, atk: 0.05 });
    },
    krakenRumble(t, o) {
      tone('sine', 29, t, 3.4, 0.4, sfxBus, { atk: 0.4, hold: 1.6, rev: revL });
      tone('sine', 41, t, 3.2, 0.22, sfxBus, { f1: 33, glide: 2.8, atk: 0.5, hold: 1.4 });
      noise(t, 3.2, 0.12, sfxBus, { type: 'lowpass', f0: 260, f1: 110, sweep: 3, Q: 2, atk: 0.5, rev: revM });
      for (let i = 0; i < 5; i++) {
        const tt = t + 0.5 + Math.random() * 2.4;
        noise(tt, 0.3, 0.17, sfxBus, { type: 'lowpass', f0: 800, f1: 260, sweep: 0.25, Q: 1.6, atk: 0.004, pan: (Math.random() - 0.5) * 1.5, rev: revM });
        tone('sine', 190, tt, 0.22, 0.09, sfxBus, { f1: 70, glide: 0.18, atk: 0.003 });
      }
    },
    bloopCall(t, o) {
      // THE bloop. Huge falling pitch, drenched in the long delay send.
      tone('sine', 186, t, 3.8, 0.5, sfxBus, { f1: 23, glide: 3.4, atk: 0.06, rev: revL, prio: true });
      tone('square', 93, t, 3.8, 0.16, sfxBus, { f1: 12, glide: 3.4, filter: 'lowpass', ff0: 900, ff1: 120, fsweep: 3.4, fq: 3, atk: 0.08, rev: revL, prio: true });
      tone('sine', 372, t, 1.6, 0.1, sfxBus, { f1: 60, glide: 1.5, atk: 0.04, rev: revL, prio: true });
      tone('sine', 31, t + 0.2, 4.4, 0.42, sfxBus, { atk: 0.5, hold: 2.4, prio: true });
      noise(t + 0.1, 3.6, 0.09, sfxBus, { type: 'lowpass', f0: 420, f1: 90, sweep: 3.2, Q: 1.6, atk: 0.5, rev: revL, prio: true });
      duckAmbience(0.25, 5.0);
    },
    tsunamiRoar(t, o) {
      const dur = cl(o.duration, 1, 20, 9);
      if (!ac || !built) return;
      const src = ac.createBufferSource();
      src.buffer = brownBuf; src.loop = true; pSet(src.playbackRate, rVal(0.9));
      const f = ac.createBiquadFilter();
      f.type = 'lowpass';
      pAt(f.frequency, fHz(140), t);
      pExp(f.frequency, fHz(3200), t + dur * 0.7);
      pSet(f.Q, qVal(1.1));
      const g = ac.createGain();
      const peak = gVal(0.75 * num(curScale, 1), 0.75);
      pAt(g.gain, 0.0001, t);
      pExp(g.gain, peak, t + dur * 0.62);
      pAt(g.gain, peak, t + dur * 0.85);
      pExp(g.gain, 0.0001, t + dur + 2.5);
      src.connect(f); f.connect(g); g.connect(sfxBus); g.connect(revL);
      src.start(t, 0.3);
      src.stop(t + dur + 2.6);
      reg(t + dur + 2.7, [src, f, g]);
      tone('sine', 40, t, dur + 1.5, 0.34, sfxBus, { f1: 26, glide: dur, atk: 1.5, hold: dur * 0.7, prio: true });
      tone('sawtooth', 62, t + dur * 0.4, dur * 0.7, 0.1, sfxBus, { f1: 38, glide: dur * 0.6, filter: 'lowpass', ff0: 500, atk: 1.2, shape: 'soft' });
      duckAmbience(0.2, dur);
    },
    portalHum(t, o) {
      const dur = o.duration || 4;
      const roots = [110, 164.8, 220, 329.6];
      for (let i = 0; i < roots.length; i++) {
        const g = tone('sine', roots[i], t, dur, 0.1 - i * 0.015, sfxBus, { atk: 0.5, hold: dur * 0.5, rev: revL });
        if (g && ac) {
          const lfo = ac.createOscillator(); lfo.type = 'sine'; pSet(lfo.frequency, oHz(0.7 + i * 0.31));
          const lg = gainNode(0.03);
          lfo.connect(lg); lg.connect(g.gain);
          lfo.start(t); lfo.stop(t + dur);
          reg(t + dur + 0.1, [lfo, lg]);
        }
      }
      noise(t, dur, 0.045, sfxBus, { type: 'bandpass', f0: 4200, Q: 3, atk: 0.6, rev: revL });
      tone('sine', 55, t, dur, 0.16, sfxBus, { atk: 0.8, hold: dur * 0.5 });
    },
    quotaDone(t, o) {
      const run = [72, 76, 79, 84, 88, 91];
      for (let i = 0; i < run.length; i++) {
        bell(t + i * 0.09, mtof(run[i]), 0.2 - i * 0.012, 1.2, sfxBus, revL);
      }
      bell(t + run.length * 0.09 + 0.05, mtof(96), 0.22, 2.6, sfxBus, revL);
      tone('sine', mtof(48), t, 2.2, 0.22, sfxBus, { atk: 0.03 });
      tone('sine', mtof(55), t + 0.1, 2.0, 0.14, sfxBus, { atk: 0.05 });
      noise(t + 0.1, 1.0, 0.05, sfxBus, { type: 'highpass', f0: 6500, atk: 0.05, rev: revL });
    },
    gameOver(t, o) {
      const fall = [55, 51, 48, 43, 36];
      for (let i = 0; i < fall.length; i++) {
        const tt = t + i * 0.55;
        tone('sawtooth', mtof(fall[i]), tt, 2.4, 0.14, sfxBus, { atk: 0.1, hold: 0.7, filter: 'lowpass', ff0: 900, ff1: 260, fsweep: 2, fq: 2, shape: 'soft', rev: revL });
        tone('sine', mtof(fall[i] - 12), tt, 2.6, 0.2, sfxBus, { atk: 0.15, hold: 0.9 });
      }
      tone('sine', 44, t, 7, 0.26, sfxBus, { f1: 24, glide: 6.4, atk: 1.2, hold: 3.5, prio: true });
      noise(t + 1.5, 4, 0.08, sfxBus, { type: 'lowpass', f0: 500, f1: 120, sweep: 3.6, Q: 1.4, atk: 1.2, rev: revL });
    },
    gameWon(t, o) {
      // little victory melody in C, with harmony and a shaker tail
      const mel = [
        [0, 72, 0.22], [0.22, 76, 0.22], [0.44, 79, 0.22], [0.66, 84, 0.42],
        [1.1, 81, 0.2], [1.3, 84, 0.2], [1.5, 88, 0.55],
        [2.1, 86, 0.2], [2.3, 84, 0.2], [2.5, 88, 0.25], [2.75, 91, 0.9],
        [3.7, 96, 1.6],
      ];
      for (let i = 0; i < mel.length; i++) {
        const tt = t + mel[i][0];
        bell(tt, mtof(mel[i][1]), 0.19, mel[i][2] + 0.5, sfxBus, revL);
        tone('triangle', mtof(mel[i][1] - 5), tt, mel[i][2] + 0.2, 0.05, sfxBus, { atk: 0.006 });
      }
      const chords = [[48, 55, 64], [45, 52, 60], [41, 48, 57], [43, 50, 59], [48, 55, 64]];
      for (let c = 0; c < chords.length; c++) {
        const tt = t + c * 0.9;
        for (let k = 0; k < 3; k++) {
          tone('sine', mtof(chords[c][k] - 12), tt, 1.3, 0.11, sfxBus, { atk: 0.04 });
        }
      }
      for (let i = 0; i < 26; i++) {
        noise(t + i * 0.11, 0.06, i % 4 === 3 ? 0.07 : 0.035, sfxBus, { type: 'highpass', f0: 7000, atk: 0.002, pan: (Math.random() - 0.5) * 0.8 });
      }
    },
    toast(t, o) {
      tone('sine', 1046, t, 0.1, 0.1, sfxBus, { atk: 0.003, rev: revS });
      tone('sine', 1568, t + 0.055, 0.14, 0.08, sfxBus, { atk: 0.003, rev: revS });
    },
    bubble(t, o) {
      const f0 = 340 + Math.random() * 420;
      tone('sine', f0, t, 0.1 + Math.random() * 0.06, 0.055, sfxBus, {
        f1: f0 * (2.1 + Math.random()), glide: 0.06, atk: 0.004, pan: (Math.random() - 0.5) * 1.2,
      });
    },

    // ---------- fishing cues (fishing.js) ----------
    catchSmall(t, o) { SFX.catchFanfare(t, { tier: o.tier || 2 }); },
    catchMed(t, o) { SFX.catchFanfare(t, { tier: o.tier || 5 }); },
    catchBig(t, o) { SFX.catchFanfare(t, { tier: o.tier || 8 }); },
    catchLegendary(t, o) {
      SFX.catchFanfare(t, { tier: o.tier || 10 });
      tone('sine', mtof(36), t, 3.0, 0.24, sfxBus, { atk: 0.02, hold: 1.2, prio: true });
      noise(t + 0.05, 1.6, 0.055, sfxBus, { type: 'highpass', f0: 5000, atk: 0.12, rev: revL });
    },
    bobberSet(t, o) {
      tone('sine', 880, t, 0.11, 0.17, sfxBus, { f1: 300, glide: 0.06, atk: 0.002, rev: revS });
      noise(t + 0.01, 0.09, 0.06, sfxBus, { type: 'bandpass', f0: 1400, Q: 1.5, atk: 0.003 });
      tone('sine', 300, t + 0.05, 0.16, 0.04, sfxBus, { f1: 160, atk: 0.008 });
    },
    hookSet(t, o) {
      const s = clamp(o.strength !== undefined ? o.strength : 1, 0.2, 2);
      noise(t, 0.07, 0.26, sfxBus, { type: 'highpass', f0: 2200, Q: 0.9, atk: 0.001 });
      tone('square', 620 * (0.8 + s * 0.25), t, 0.1, 0.14, sfxBus, { f1: 240, atk: 0.001, filter: 'lowpass', ff0: 2600 });
      tone('sawtooth', 140 * s, t + 0.02, 0.45, 0.09 * s, sfxBus, { f1: 220 * s, glide: 0.4, filter: 'bandpass', ff0: 700, fq: 6, atk: 0.02 });
      tone('sine', 112, t, 0.3, 0.18, sfxBus, { f1: 55, glide: 0.22, atk: 0.003 });
    },
    reelIn(t, o) {
      for (let i = 0; i < 6; i++) reelTick(t + i * 0.035, 0.85 - i * 0.07);
      noise(t, 0.24, 0.05, sfxBus, { type: 'bandpass', f0: 1500, f1: 900, sweep: 0.2, Q: 3, atk: 0.02 });
    },
    // called every frame while the player holds reel - just re-arms the ticker
    reelLoop(t, o) {
      reelOn = true;
      reelHold = t + 0.25;
      reelTension = clamp(o.tension !== undefined ? o.tension : 0.4, 0, 1);
      reelVol = clamp(curScale, 0.1, 1.5);
    },
    lineMiss(t, o) {
      noise(t, 0.3, 0.13, sfxBus, { type: 'bandpass', f0: 1500, f1: 420, sweep: 0.25, Q: 1.1, atk: 0.012 });
      tone('triangle', 420, t + 0.03, 0.32, 0.1, sfxBus, { f1: 190, glide: 0.28, atk: 0.005, filter: 'lowpass', ff0: 1400 });
      tone('sine', 208, t + 0.05, 0.3, 0.055, sfxBus, { f1: 104, glide: 0.26, atk: 0.01 });
    },

    // ---------- horror event beats (events.js) ----------
    serpentBite(t, o) {
      noise(t, 0.14, 0.3, sfxBus, { type: 'lowpass', f0: 2200, f1: 700, sweep: 0.1, Q: 1.4, atk: 0.001 });
      noise(t + 0.06, 0.2, 0.2, sfxBus, { type: 'bandpass', f0: 900, f1: 320, sweep: 0.16, Q: 1.8, atk: 0.002 });
      tone('sawtooth', 160, t, 0.5, 0.15, sfxBus, { f1: 60, glide: 0.4, filter: 'lowpass', ff0: 1100, ff1: 300, fsweep: 0.4, atk: 0.002, shape: 'hard' });
      tone('sine', 70, t, 0.6, 0.26, sfxBus, { f1: 34, glide: 0.5, atk: 0.004, rev: revM });
      for (let i = 0; i < 4; i++) SFX.bubble(t + 0.12 + i * 0.06, EMPTY);
    },
    krakenRise(t, o) {
      // the whole sea lifting: brown-noise swell, sub sweeping upward, hull creak
      noise(t, 2.6, 0.32, sfxBus, { type: 'lowpass', f0: 200, f1: 2600, sweep: 2.2, Q: 1.2, atk: 1.6, brown: true, rev: revL, prio: true });
      tone('sine', 26, t, 2.8, 0.34, sfxBus, { f1: 70, glide: 2.4, atk: 1.2, prio: true });
      tone('sawtooth', 92, t + 0.4, 2.2, 0.07, sfxBus, { f1: 190, glide: 2.0, filter: 'bandpass', ff0: 600, fq: 7, atk: 1.0, rev: revL });
      for (let i = 0; i < 8; i++) SFX.bubble(t + 0.6 + i * 0.16, EMPTY);
      duckAmbience(0.45, 2.4);
    },
    krakenSlam(t, o) {
      tone('sine', 150, t, 0.9, 0.4, sfxBus, { f1: 34, glide: 0.5, atk: 0.002, prio: true });
      noise(t, 0.6, 0.32, sfxBus, { type: 'lowpass', f0: 2600, f1: 500, sweep: 0.5, Q: 1.1, atk: 0.002, rev: revM, prio: true });
      noise(t + 0.04, 1.1, 0.15, sfxBus, { type: 'highpass', f0: 2400, atk: 0.01, rev: revL });
      tone('sawtooth', 70, t, 0.7, 0.13, sfxBus, { f1: 30, glide: 0.6, filter: 'lowpass', ff0: 500, atk: 0.003, shape: 'hard' });
    },
    krakenHurt(t, o) {
      tone('sawtooth', 120, t, 1.1, 0.19, sfxBus, { f1: 54, glide: 0.95, filter: 'lowpass', ff0: 900, ff1: 260, fsweep: 1.0, fq: 3, atk: 0.03, shape: 'soft', rev: revM });
      tone('sine', 55, t, 1.3, 0.28, sfxBus, { f1: 30, glide: 1.1, atk: 0.02 });
      noise(t + 0.05, 0.7, 0.15, sfxBus, { type: 'bandpass', f0: 700, f1: 260, sweep: 0.6, Q: 2, atk: 0.02 });
      for (let i = 0; i < 5; i++) SFX.bubble(t + 0.1 + i * 0.08, EMPTY);
    },
    krakenGrab(t, o) {
      noise(t, 0.35, 0.26, sfxBus, { type: 'lowpass', f0: 1400, f1: 420, sweep: 0.3, Q: 1.6, atk: 0.004 });
      tone('sine', 120, t, 0.5, 0.24, sfxBus, { f1: 44, glide: 0.4, atk: 0.003 });
      tone('sawtooth', 180, t + 0.05, 0.9, 0.085, sfxBus, { f1: 300, glide: 0.8, filter: 'bandpass', ff0: 800, fq: 8, atk: 0.05 });
      SFX.playerHurt(t + 0.03, EMPTY);
    },
    krakenRelease(t, o) {
      noise(t, 0.5, 0.22, sfxBus, { type: 'bandpass', f0: 500, f1: 1800, sweep: 0.4, Q: 1.3, atk: 0.02 });
      tone('sine', 60, t, 0.8, 0.19, sfxBus, { f1: 150, glide: 0.7, atk: 0.02 });
      for (let i = 0; i < 7; i++) SFX.bubble(t + 0.05 + i * 0.07, EMPTY);
      bell(t + 0.3, mtof(76), 0.09, 1.4, sfxBus, revL);
    },
    bloopMaw(t, o) {
      tone('sine', 120, t, 2.6, 0.42, sfxBus, { f1: 26, glide: 2.2, atk: 0.05, rev: revL, prio: true });
      tone('square', 60, t, 2.6, 0.11, sfxBus, { f1: 13, glide: 2.2, filter: 'lowpass', ff0: 500, atk: 0.1, prio: true });
      noise(t, 2.2, 0.19, sfxBus, { type: 'lowpass', f0: 900, f1: 180, sweep: 1.9, Q: 1.6, atk: 0.3, brown: true, rev: revL, prio: true });
      duckAmbience(0.35, 2.4);
    },
    eventDepart(t, o) {
      const survived = o.survived !== false;
      tone('sine', 62, t, 5.0, 0.28, sfxBus, { f1: 24, glide: 4.4, atk: 0.6, rev: revL });
      tone('sawtooth', 88, t, 4.6, 0.085, sfxBus, { f1: 33, glide: 4.2, filter: 'lowpass', ff0: 600, ff1: 160, fsweep: 4, fq: 3, atk: 0.8, shape: 'soft', rev: revL });
      noise(t + 0.3, 4.2, 0.095, sfxBus, { type: 'lowpass', f0: 700, f1: 150, sweep: 3.8, Q: 1.4, atk: 1.2, brown: true, rev: revL });
      if (survived) {
        const relief = [72, 76, 79, 84];
        for (let i = 0; i < relief.length; i++) bell(t + 1.6 + i * 0.28, mtof(relief[i]), 0.12, 2.2, sfxBus, revL);
      } else {
        bell(t + 1.4, mtof(56), 0.13, 3.0, sfxBus, revL);
        bell(t + 2.1, mtof(53), 0.11, 3.4, sfxBus, revL);
      }
    },
    tsunamiImpact(t, o) {
      tone('sine', 90, t, 2.4, 0.48, sfxBus, { f1: 24, glide: 1.4, atk: 0.004, prio: true });
      noise(t, 3.4, 0.48, sfxBus, { type: 'lowpass', f0: 4000, f1: 300, sweep: 3.0, Q: 1.0, atk: 0.01, brown: true, rev: revL, prio: true });
      noise(t + 0.02, 2.0, 0.2, sfxBus, { type: 'highpass', f0: 2400, atk: 0.02, rev: revL, prio: true });
      tone('sawtooth', 60, t, 2.0, 0.15, sfxBus, { f1: 26, glide: 1.8, filter: 'lowpass', ff0: 400, atk: 0.01, shape: 'hard', prio: true });
      duckAmbience(0.2, 3.5);
    },

    // ---------- weather + landed catch (world.js, fishing.js, ui.js) ----------
    // dist in metres: far strikes arrive late, dull, and all roll, no crack
    thunder(t, o) {
      const dist = clamp(o && o.dist !== undefined ? o.dist : 90, 0, 1200);
      const near = 1 - clamp(dist / 400, 0, 1);           // 1 = right on top of you
      // o.late = the caller already waited out the travel time (world.js does)
      const tt = t + ((o && o.late) ? 0 : clamp(dist / 340, 0, 2.8));
      const lp = 300 + near * near * 7400;
      const g = 0.3 + near * 0.55;
      // the crack — only close strikes keep any bite
      noise(tt, 0.08 + near * 0.12, g * (0.3 + near * 0.8), sfxBus, {
        type: 'lowpass', f0: lp, f1: Math.max(110, lp * 0.22), sweep: 0.12, Q: 0.9, atk: 0.001, prio: true,
      });
      if (near > 0.3) {
        noise(tt, 0.05, g * near * 0.55, sfxBus, { type: 'highpass', f0: 2200 + near * 3400, atk: 0.001 });
      }
      // the roll — longer and softer the further away it was
      const roll = 2.0 + (1 - near) * 3.6;
      noise(tt + 0.05, roll, g * 0.5, sfxBus, {
        type: 'lowpass', f0: Math.min(1500, lp), f1: 85, sweep: roll * 0.85, Q: 1.2,
        atk: 0.04 + (1 - near) * 0.7, brown: true, rev: revL, prio: true,
      });
      tone('sine', 52 + near * 26, tt, roll * 0.7, 0.16 + near * 0.16, sfxBus, {
        f1: 26, glide: roll * 0.6, atk: 0.02 + (1 - near) * 0.4,
      });
      if (near > 0.55) duckAmbience(0.55, 1.4);
    },
    // being struck: a bright, personal crack
    lightningZap(t, o) {
      for (let i = 0; i < 8; i++) {
        noise(t + i * 0.008, 0.045, 0.2, sfxBus, {
          type: 'bandpass', f0: 1800 + Math.random() * 5200, Q: 15, atk: 0.0008, pan: (Math.random() - 0.5) * 1.4,
        });
      }
      noise(t, 0.13, 0.34, sfxBus, { type: 'highpass', f0: 2800, atk: 0.0008, prio: true });
      tone('sawtooth', 3400, t, 0.5, 0.15, sfxBus, {
        f1: 210, glide: 0.42, filter: 'bandpass', ff0: 3200, ff1: 620, fsweep: 0.42, fq: 7,
        atk: 0.001, shape: 'hard', rev: revM, prio: true,
      });
      tone('sine', 112, t, 0.8, 0.3, sfxBus, { f1: 38, glide: 0.6, atk: 0.002, prio: true });
      // the body of it stays in your chest — the roll itself is 'thunder'
      noise(t + 0.03, 1.3, 0.14, sfxBus, { type: 'lowpass', f0: 900, f1: 110, sweep: 1.1, Q: 1.2, atk: 0.02, brown: true, rev: revL });
    },
    // whacking your landed catch — comedic, wooden, never the same twice
    bonk(t, o) {
      const p = 0.82 + Math.random() * 0.44;
      noise(t, 0.05, 0.24, sfxBus, { type: 'bandpass', f0: 1500 * p, Q: 1.5, atk: 0.001 });
      tone('triangle', 430 * p, t, 0.15, 0.3, sfxBus, { f1: 98 * p, glide: 0.085, atk: 0.001, shape: 'soft' });
      tone('sine', 152 * p, t, 0.24, 0.24, sfxBus, { f1: 56, glide: 0.17, atk: 0.002 });
      // the daft little boing on the way out
      tone('square', 250 * p, t + 0.035, 0.17, 0.045, sfxBus, {
        f1: 640 * p, glide: 0.14, filter: 'lowpass', ff0: 1700, atk: 0.004,
      });
    },
    // it's yours: zip it into the bag
    stow(t, o) {
      noise(t, 0.17, 0.13, sfxBus, { type: 'bandpass', f0: 680, f1: 3800, sweep: 0.15, Q: 4.5, atk: 0.004 });
      tone('sine', 540, t + 0.1, 0.11, 0.22, sfxBus, { f1: 1220, glide: 0.055, atk: 0.002, rev: revS });
      noise(t + 0.13, 0.05, 0.1, sfxBus, { type: 'highpass', f0: 4400, atk: 0.001 });
      bell(t + 0.14, mtof(88), 0.09, 0.6, sfxBus, revM);
    },
    // it made the rail: two notes, both bad
    flopperEscape(t, o) {
      SFX.plop(t, EMPTY);
      bell(t + 0.06, mtof(69), 0.15, 0.9, sfxBus, revM);
      bell(t + 0.32, mtof(64), 0.15, 1.7, sfxBus, revL);
      tone('triangle', mtof(57), t + 0.32, 1.3, 0.07, sfxBus, { f1: mtof(52), glide: 1.1, atk: 0.02, rev: revL });
      noise(t + 0.1, 0.4, 0.1, sfxBus, { type: 'bandpass', f0: 1200, f1: 460, sweep: 0.35, Q: 1.1, atk: 0.01 });
    },

    // ---------- wave 4: diving loot, ambushers, water exit ----------
    // Everything down here is heard through water most of the time (uwFilter
    // is already lowpassing the master), so the cues lean on low bodies and
    // let the sparkle sit high enough to survive the muffling.
    //
    // a clam: wet suck, shell knock, then the pearl's tiny halo
    pearlPop(t, o) {
      noise(t, 0.18, 0.14, sfxBus, { type: 'bandpass', f0: 620, f1: 1500, sweep: 0.14, Q: 2.4, atk: 0.02 });
      tone('sine', 320, t + 0.1, 0.09, 0.2, sfxBus, { f1: 1150, glide: 0.045, atk: 0.001, rev: revS });
      noise(t + 0.1, 0.05, 0.12, sfxBus, { type: 'highpass', f0: 3800, atk: 0.001 });
      bell(t + 0.14, mtof(93), 0.1, 1.1, sfxBus, revL);
      bell(t + 0.27, mtof(100), 0.06, 1.5, sfxBus, revL);
      SFX.bubble(t + 0.05, EMPTY);
      SFX.bubble(t + 0.14, EMPTY);
    },
    // a strapped chest: latch, long hinge creak, lid thump, then gold
    chestOpen(t, o) {
      noise(t, 0.05, 0.22, sfxBus, { type: 'bandpass', f0: 2200, Q: 4, atk: 0.001 });
      tone('square', 380, t, 0.06, 0.1, sfxBus, { f1: 190, atk: 0.001, filter: 'lowpass', ff0: 2200 });
      tone('sawtooth', 88, t + 0.08, 0.95, 0.06, sfxBus, {
        f1: 168, glide: 0.85, filter: 'bandpass', ff0: 620, fq: 9, atk: 0.12, rev: revM,
      });
      noise(t + 0.1, 0.8, 0.05, sfxBus, { type: 'bandpass', f0: 900, f1: 1500, sweep: 0.7, Q: 7, atk: 0.15 });
      tone('sine', 120, t + 0.92, 0.26, 0.16, sfxBus, { f1: 54, glide: 0.18, atk: 0.003 });
      noise(t + 0.92, 0.12, 0.12, sfxBus, { type: 'lowpass', f0: 900, Q: 1.2, atk: 0.002 });
      // soft gold shimmer off the hoard inside
      for (let i = 0; i < 5; i++) {
        bell(t + 1.0 + i * 0.07, mtof(84 + (i % 3) * 4 + (i > 2 ? 12 : 0)), 0.055, 1.4, sfxBus, revL);
      }
      noise(t + 1.02, 0.9, 0.035, sfxBus, { type: 'highpass', f0: 7000, atk: 0.08, rev: revL });
      for (let i = 0; i < 3; i++) SFX.bubble(t + 0.12 + i * 0.09, EMPTY);
    },
    // a coin stash: a cascade, not a jingle
    coinScoop(t, o) {
      for (let i = 0; i < 13; i++) {
        const tt = t + i * 0.026 + Math.random() * 0.02;
        const f = mtof(88 + Math.floor(Math.random() * 12));
        tone('triangle', f, tt, 0.14, 0.07, sfxBus, { atk: 0.001, pan: (Math.random() - 0.5) * 1.1, rev: revS });
        if (i % 3 === 0) noise(tt, 0.03, 0.05, sfxBus, { type: 'highpass', f0: 5200, atk: 0.001 });
      }
      noise(t, 0.5, 0.06, sfxBus, { type: 'bandpass', f0: 2600, Q: 1.4, atk: 0.02, rev: revM });
      tone('sine', 150, t, 0.3, 0.08, sfxBus, { f1: 80, atk: 0.006 });
    },
    // a bottle: twist, hollow pop, air into the neck
    bottleUncork(t, o) {
      noise(t, 0.22, 0.09, sfxBus, { type: 'bandpass', f0: 700, f1: 1800, sweep: 0.2, Q: 3, atk: 0.03 });
      tone('sine', 900, t + 0.22, 0.09, 0.3, sfxBus, { f1: 180, glide: 0.05, atk: 0.001, rev: revS });
      noise(t + 0.22, 0.04, 0.14, sfxBus, { type: 'bandpass', f0: 1800, Q: 6, atk: 0.001 });
      noise(t + 0.26, 0.5, 0.06, sfxBus, { type: 'bandpass', f0: 1400, f1: 3200, sweep: 0.4, Q: 2.2, atk: 0.04, rev: revS });
      for (let i = 0; i < 3; i++) SFX.bubble(t + 0.3 + i * 0.08, EMPTY);
    },
    // a relic: stone grinding free, then something older humming
    relicHum(t, o) {
      const root = 41;
      tone('sine', mtof(root), t, 3.0, 0.22, sfxBus, { atk: 0.35, hold: 1.4, rev: revL });
      tone('sine', mtof(root + 12), t + 0.1, 2.6, 0.1, sfxBus, { atk: 0.5, hold: 1.1, rev: revL });
      tone('triangle', mtof(root + 19), t + 0.2, 2.2, 0.05, sfxBus, { atk: 0.6, hold: 0.9, rev: revL });
      noise(t, 0.7, 0.1, sfxBus, { type: 'bandpass', f0: 420, f1: 190, sweep: 0.6, Q: 2.6, atk: 0.02 });
      tone('sawtooth', 62, t, 2.4, 0.05, sfxBus, {
        f1: 47, glide: 2.0, filter: 'lowpass', ff0: 380, fq: 3, atk: 0.4, shape: 'soft',
      });
    },
    // a geode: the shell cracks, the inside rings
    geodeChime(t, o) {
      noise(t, 0.09, 0.2, sfxBus, { type: 'bandpass', f0: 2000, Q: 3, atk: 0.001 });
      tone('sine', 210, t, 0.18, 0.12, sfxBus, { f1: 90, glide: 0.12, atk: 0.002 });
      const notes = [79, 84, 88, 91, 96];
      for (let i = 0; i < notes.length; i++) {
        bell(t + 0.06 + i * 0.075, mtof(notes[i]), 0.12 - i * 0.008, 2.2 - i * 0.14, sfxBus, revL);
        tone('sine', mtof(notes[i] + 12), t + 0.06 + i * 0.075, 0.5, 0.03, sfxBus, {
          atk: 0.002, pan: Math.sin(i * 1.9) * 0.7,
        });
      }
      noise(t + 0.1, 1.4, 0.04, sfxBus, { type: 'highpass', f0: 8000, atk: 0.1, rev: revL });
    },
    // ONE OF A KIND. Deliberately not the catch fanfare: no rising arpeggio,
    // just an indrawn breath, a held chord and the moment it opens.
    // o.delay lets a caller slide it past a chest lid that is still creaking.
    uniqueFanfare(t, o) {
      const t0 = t + cl(o && o.delay, 0, 3, 0);
      noise(t0, 0.9, 0.06, sfxBus, {
        type: 'bandpass', f0: 900, f1: 4200, sweep: 0.8, Q: 1.6, atk: 0.25, rev: revL, prio: true,
      });
      const sus = [57, 64, 69, 76];          // held, unresolved
      for (let i = 0; i < sus.length; i++) {
        tone('triangle', mtof(sus[i]), t0 + 0.25, 1.5, 0.085, sfxBus, {
          atk: 0.25, hold: 0.7, rev: revL, prio: true,
        });
      }
      const open = [60, 67, 72, 79, 84];     // and it lands
      for (let i = 0; i < open.length; i++) {
        bell(t0 + 1.15 + i * 0.05, mtof(open[i]), 0.15, 3.2, sfxBus, revL);
      }
      tone('sine', mtof(36), t0 + 1.1, 3.4, 0.24, sfxBus, { atk: 0.06, hold: 1.6, prio: true });
      for (let i = 0; i < 8; i++) {
        tone('sine', mtof(96 + Math.floor(Math.random() * 12)), t0 + 1.2 + i * 0.09, 0.7, 0.035, sfxBus, {
          atk: 0.004, pan: (Math.random() - 0.5) * 1.4, rev: revL,
        });
      }
      duckAmbience(0.35, 2.4);
    },
    // dagger jelly: a wet slap of the bell, then the venom goes in
    jellySting(t, o) {
      noise(t, 0.12, 0.18, sfxBus, { type: 'bandpass', f0: 900, f1: 380, sweep: 0.1, Q: 1.6, atk: 0.002 });
      for (let i = 0; i < 6; i++) {
        noise(t + 0.02 + i * 0.014, 0.05, 0.1, sfxBus, {
          type: 'bandpass', f0: 2400 + Math.random() * 3000, Q: 18, atk: 0.001, pan: (Math.random() - 0.5) * 1.1,
        });
      }
      tone('sawtooth', 1400, t + 0.02, 0.4, 0.09, sfxBus, {
        f1: 260, glide: 0.34, filter: 'bandpass', ff0: 1800, ff1: 500, fsweep: 0.34, fq: 8,
        atk: 0.002, shape: 'hard', rev: revS,
      });
      tone('sine', 190, t, 0.45, 0.16, sfxBus, { f1: 70, glide: 0.35, atk: 0.003 });
      for (let i = 0; i < 3; i++) SFX.bubble(t + 0.06 + i * 0.06, EMPTY);
    },
    // an ambusher uncoiling out of the seabed: shoved water, hiss, bubble cloud
    morayLunge(t, o) {
      noise(t, 0.5, 0.26, sfxBus, {
        type: 'lowpass', f0: 500, f1: 2400, sweep: 0.22, Q: 1.1, atk: 0.006, brown: true, rev: revM, prio: true,
      });
      noise(t + 0.04, 0.6, 0.14, sfxBus, { type: 'highpass', f0: 3400, atk: 0.02 });
      tone('sine', 60, t, 0.7, 0.24, sfxBus, { f1: 140, glide: 0.5, atk: 0.004 });
      tone('sawtooth', 240, t + 0.05, 0.5, 0.08, sfxBus, {
        f1: 90, glide: 0.42, filter: 'bandpass', ff0: 700, fq: 6, atk: 0.01, shape: 'soft',
      });
      for (let i = 0; i < 9; i++) SFX.bubble(t + 0.02 + i * 0.045, EMPTY);
    },
    // hauling yourself out of the water: effort, water letting go, a knee landing
    vault(t, o) {
      tone('sawtooth', 168, t, 0.3, 0.09, sfxBus, {
        f1: 116, glide: 0.26, filter: 'bandpass', ff0: 700, fq: 6, atk: 0.012, shape: 'soft',
      });
      tone('sawtooth', 168, t, 0.24, 0.045, sfxBus, {
        f1: 116, glide: 0.22, filter: 'bandpass', ff0: 1240, fq: 9, atk: 0.012,
      });
      SFX.splash(t, { size: 1.1 });
      noise(t + 0.04, 0.45, 0.12, sfxBus, { type: 'bandpass', f0: 1600, f1: 520, sweep: 0.36, Q: 1.1, atk: 0.01, rev: revS });
      tone('sine', 140, t + 0.3, 0.22, 0.14, sfxBus, { f1: 62, glide: 0.16, atk: 0.003 });
      noise(t + 0.3, 0.13, 0.12, sfxBus, { type: 'lowpass', f0: 950, Q: 1.3, atk: 0.002 });
    },
    // scooping up a glowing pickup — bright, short, immediately over
    pickupPop(t, o) {
      tone('sine', 520, t, 0.1, 0.2, sfxBus, { f1: 1180, glide: 0.06, atk: 0.002, rev: revS });
      tone('triangle', 780, t + 0.04, 0.13, 0.09, sfxBus, { f1: 1560, glide: 0.08, atk: 0.002 });
      noise(t, 0.09, 0.07, sfxBus, { type: 'bandpass', f0: 3200, f1: 6000, sweep: 0.07, Q: 2, atk: 0.002 });
      bell(t + 0.07, mtof(93), 0.08, 0.7, sfxBus, revS);
    },

    // ---------- wave 5: perfect cast, reviving, doomsday ----------
    // PERFECT. Two bright notes and a sparkle tail — you will learn this one
    // in a single session and start chasing it.
    perfectCast(t, o) {
      noise(t, 0.05, 0.1, sfxBus, { type: 'highpass', f0: 6200, atk: 0.001 });
      bell(t, mtof(88), 0.2, 0.85, sfxBus, revM);            // ching...
      bell(t + 0.085, mtof(95), 0.19, 1.7, sfxBus, revL);    // ...ching!
      tone('triangle', mtof(100), t + 0.085, 0.55, 0.055, sfxBus, { atk: 0.002, rev: revL });
      tone('sine', mtof(52), t, 0.7, 0.09, sfxBus, { atk: 0.006 });
      // the sparkle tail
      for (let i = 0; i < 7; i++) {
        tone('sine', mtof(98 + Math.floor(Math.random() * 12)), t + 0.16 + i * 0.052, 0.42, 0.032, sfxBus, {
          atk: 0.003, pan: (Math.random() - 0.5) * 1.35, rev: revL,
        });
      }
      noise(t + 0.14, 0.5, 0.03, sfxBus, { type: 'highpass', f0: 8000, atk: 0.04, rev: revL });
    },
    // held while a revive channels; {on:false} ends it
    reviveChannel(t, o) {
      if (o && o.on === false) { channelStop(0.24); return; }
      channelStart();
    },
    // they are back: a warm swell and the breath they take
    revive(t, o) {
      channelStop(0.1);
      const chord = [60, 64, 67, 72];
      for (let i = 0; i < chord.length; i++) {
        tone('triangle', mtof(chord[i]), t + i * 0.045, 1.9, 0.085, sfxBus, {
          atk: 0.22, hold: 0.75, rev: revL,
        });
      }
      tone('sine', mtof(36), t, 2.4, 0.19, sfxBus, { atk: 0.12, hold: 1.0 });
      bell(t + 0.42, mtof(79), 0.15, 2.2, sfxBus, revL);
      bell(t + 0.58, mtof(84), 0.13, 2.8, sfxBus, revL);
      // the gasp — an inhale, then a voiced breath through two formants
      noise(t, 0.42, 0.13, sfxBus, { type: 'bandpass', f0: 600, f1: 2300, sweep: 0.36, Q: 1.6, atk: 0.12 });
      tone('sawtooth', 148, t + 0.06, 0.34, 0.075, sfxBus, {
        f1: 208, glide: 0.3, filter: 'bandpass', ff0: 720, fq: 6, atk: 0.04, shape: 'soft',
      });
      tone('sawtooth', 148, t + 0.06, 0.28, 0.04, sfxBus, {
        f1: 208, glide: 0.24, filter: 'bandpass', ff0: 1320, fq: 9, atk: 0.04,
      });
      noise(t + 0.3, 0.6, 0.045, sfxBus, { type: 'highpass', f0: 6500, atk: 0.06, rev: revL });
    },
    // the Rescue Claw closing on a sunken crewmate
    clawGrab(t, o) {
      noise(t, 0.05, 0.24, sfxBus, { type: 'bandpass', f0: 1800, Q: 5, atk: 0.001 });
      tone('square', 220, t, 0.09, 0.13, sfxBus, { f1: 96, atk: 0.001, filter: 'lowpass', ff0: 1800 });
      tone('sine', 140, t, 0.32, 0.2, sfxBus, { f1: 56, glide: 0.22, atk: 0.002 });
      // the metal ring under the clunk
      tone('triangle', 1240, t + 0.008, 0.5, 0.05, sfxBus, { atk: 0.001, rev: revM });
      tone('triangle', 1867, t + 0.012, 0.34, 0.028, sfxBus, { atk: 0.001, rev: revM });
      // chain paying out
      for (let i = 0; i < 7; i++) {
        noise(t + 0.06 + i * 0.043 + Math.random() * 0.018, 0.03, 0.07, sfxBus, {
          type: 'bandpass', f0: 2600 + Math.random() * 2600, Q: 14, atk: 0.001, pan: (Math.random() - 0.5) * 1.1,
        });
      }
      for (let i = 0; i < 3; i++) SFX.bubble(t + 0.05 + i * 0.07, EMPTY);
    },
    // the ground going out from under the island; {on:false} ends it
    doomQuake(t, o) {
      if (o && o.on === false) { quakeStop(1.4); return; }
      quakeStart();
    },
    // slow dread tolls over the doomsday wall
    doomBell(t, o) {
      const n = Math.round(cl(o && o.count, 1, 6, 3));
      const f0 = 58;
      for (let i = 0; i < n; i++) {
        const tt = t + i * 2.3;
        const g = Math.max(0.08, 0.26 - i * 0.02);
        noise(tt, 0.07, 0.11, sfxBus, { type: 'bandpass', f0: 1400, Q: 3, atk: 0.001 });      // the clapper
        tone('sine', f0 * 0.5, tt, 6.0, g * 0.9, sfxBus, { atk: 0.02, hold: 2.2, rev: revL, prio: true });
        tone('sine', f0, tt, 5.2, g, sfxBus, { atk: 0.008, hold: 1.6, rev: revL, prio: true });
        tone('triangle', f0 * 1.19, tt, 4.0, g * 0.5, sfxBus, { atk: 0.006, hold: 1.2, rev: revL });  // the minor third does the dread
        tone('triangle', f0 * 2.0, tt, 3.0, g * 0.28, sfxBus, { atk: 0.004, hold: 0.8, rev: revL });
        tone('sine', f0 * 2.98, tt, 1.6, g * 0.13, sfxBus, { atk: 0.003, rev: revL });
      }
      duckAmbience(0.35, 3.0);
    },

    // ---------- wave 7: headshots, stuns, deep-water ambushes ----------
    // A CRIT, not a hit: a metallic tick and two bright partials a fifth
    // apart, pitch-jittered so a run of head hits never machine-guns the
    // same ding. Deliberately short — enemies.js may fire it every swing.
    headshot(t, o) {
      const p = 0.94 + Math.random() * 0.17;
      noise(t, 0.03, 0.2, sfxBus, { type: 'bandpass', f0: fHz(5200 * p, 5200), Q: 9, atk: 0.0008 });
      tone('square', 1980 * p, t, 0.05, 0.1, sfxBus, { f1: 1320 * p, atk: 0.0008, filter: 'lowpass', ff0: 6000 });
      bell(t + 0.008, mtof(96) * p, 0.17, 0.5, sfxBus, revS);
      bell(t + 0.052, mtof(103) * p, 0.11, 0.8, sfxBus, revM);
      tone('sine', 150, t, 0.16, 0.12, sfxBus, { f1: 68, glide: 0.11, atk: 0.001 });
      noise(t + 0.02, 0.2, 0.04, sfxBus, { type: 'highpass', f0: 8000, atk: 0.006, rev: revS });
    },
    // the water goes wrong under you: a low hit, a falling smear, bubbles
    ambushSting(t, o) {
      tone('sine', 96, t, 2.2, 0.42, sfxBus, { f1: 27, glide: 1.7, atk: 0.004, rev: revL, prio: true });
      tone('square', 48, t, 2.0, 0.12, sfxBus, { f1: 15, glide: 1.6, filter: 'lowpass', ff0: 340, atk: 0.02, prio: true });
      noise(t, 1.5, 0.2, sfxBus, {
        type: 'lowpass', f0: 1600, f1: 190, sweep: 1.2, Q: 1.3, atk: 0.006, brown: true, rev: revL, prio: true,
      });
      tone('sawtooth', 1500, t + 0.02, 1.1, 0.06, sfxBus, {
        f1: 220, glide: 1.0, filter: 'bandpass', ff0: 1800, ff1: 420, fsweep: 1.0, fq: 8,
        atk: 0.02, shape: 'soft', rev: revM,
      });
      for (let i = 0; i < 6; i++) SFX.bubble(t + 0.08 + i * 0.07, EMPTY);
      duckAmbience(0.4, 1.8);
    },
    // the swarm bed. {on:true} starts it, {on:false} sends them away.
    razorFrenzy(t, o) {
      if (o && o.on === false) { frenzyStop(0.7); return; }
      frenzyStart();
    },
    // a hit the size of a building: a gong, then the world wobbling off-key
    eventStunned(t, o) {
      const f0 = 52;
      noise(t, 0.09, 0.26, sfxBus, { type: 'bandpass', f0: 1700, Q: 3, atk: 0.001, prio: true });
      tone('sine', f0 * 0.5, t, 5.4, 0.3, sfxBus, { atk: 0.012, hold: 2.0, rev: revL, prio: true });
      tone('sine', f0, t, 4.6, 0.3, sfxBus, { atk: 0.006, hold: 1.6, rev: revL, prio: true });
      tone('triangle', f0 * 1.5, t, 3.4, 0.16, sfxBus, { atk: 0.005, hold: 1.1, rev: revL });
      tone('triangle', f0 * 2.41, t, 2.6, 0.1, sfxBus, { atk: 0.004, hold: 0.8, rev: revL });
      // the detuned warble — three voices sliding past each other, off-centre
      const g = tone('sine', 320, t + 0.1, 3.0, 0.1, sfxBus, { f1: 232, glide: 2.6, atk: 0.06, rev: revL });
      tone('sine', 316, t + 0.1, 3.0, 0.085, sfxBus, { f1: 244, glide: 2.6, atk: 0.06, pan: 0.5 });
      tone('triangle', 158, t + 0.12, 2.8, 0.07, sfxBus, { f1: 122, glide: 2.4, atk: 0.08, pan: -0.5 });
      if (g && ac) {
        const lfo = ac.createOscillator(); lfo.type = 'sine';
        pAt(lfo.frequency, oHz(7.4), t);
        pExp(lfo.frequency, oHz(2.6), t + 3.0);
        const lg = gainNode(0.06);
        lfo.connect(lg); lg.connect(g.gain);
        lfo.start(t); lfo.stop(t + 3.2);
        reg(t + 3.3, [lfo, lg]);
      }
      duckAmbience(0.3, 3.0);
    },

    // ---------- shop / progression (boat.js, ui.js) ----------
    upgrade(t, o) {
      const lv = clamp(Math.round(o.level || 2), 1, 6);
      noise(t, 0.12, 0.2, sfxBus, { type: 'lowpass', f0: 800, Q: 2.4, atk: 0.002 });
      tone('sine', 140, t, 0.16, 0.15, sfxBus, { f1: 70, atk: 0.002 });
      const run = [67, 72, 76, 79, 84, 88];
      const n = Math.min(run.length, 2 + lv);
      for (let i = 0; i < n; i++) bell(t + 0.1 + i * 0.075, mtof(run[i]), 0.14, 0.9, sfxBus, revM);
      noise(t + 0.1, 0.5, 0.04, sfxBus, { type: 'highpass', f0: 6000, atk: 0.05, rev: revL });
    },

    // ---------- wave 3: movement, boats, UI ----------
    // boat.js calls sfx('board', {seat}) — there was nothing here to answer it
    board(t, o) {
      noise(t, 0.13, 0.2, sfxBus, { type: 'bandpass', f0: 400, Q: 3.2, atk: 0.002 });
      tone('sine', 172, t, 0.16, 0.14, sfxBus, { f1: 84, glide: 0.1, atk: 0.002 });
      // a rope taking the weight
      tone('sawtooth', 96, t + 0.05, 0.4, 0.05, sfxBus, { f1: 132, glide: 0.34, filter: 'bandpass', ff0: 560, fq: 7, atk: 0.04 });
      noise(t + 0.09, 0.26, 0.09, sfxBus, { type: 'lowpass', f0: 900, f1: 320, sweep: 0.22, Q: 1.1, atk: 0.006, rev: revS });
      SFX.bubble(t + 0.16, EMPTY);
    },
    deckStep(t, o) { SFX.footstep(t, { surface: 'wood' }); },
    creak(t, o) {
      tone('sawtooth', 104 + Math.random() * 44, t, 0.7, 0.05, sfxBus, {
        f1: 152, glide: 0.6, filter: 'bandpass', ff0: 640, fq: 8, atk: 0.08,
      });
      noise(t + 0.05, 0.4, 0.03, sfxBus, { type: 'bandpass', f0: 900, Q: 6, atk: 0.06 });
    },
    // launch (jumpThud is the landing)
    jump(t, o) {
      noise(t, 0.16, 0.1, sfxBus, { type: 'bandpass', f0: 700, f1: 1900, sweep: 0.14, Q: 1.0, atk: 0.006 });
      tone('sine', 190, t, 0.18, 0.1, sfxBus, { f1: 340, glide: 0.15, atk: 0.004 });
      tone('triangle', 300, t + 0.01, 0.12, 0.045, sfxBus, { f1: 520, glide: 0.1, atk: 0.003 });
    },
    swimStroke(t, o) {
      const s = cl(o && o.size, 0.4, 2, 1);
      noise(t, 0.34 * s, 0.12, sfxBus, { type: 'bandpass', f0: 720, f1: 300, sweep: 0.28, Q: 0.9, atk: 0.03, rev: revS });
      noise(t + 0.05, 0.2, 0.05, sfxBus, { type: 'highpass', f0: 2200, atk: 0.02 });
      tone('sine', 220, t, 0.18, 0.04, sfxBus, { f1: 110, atk: 0.01 });
      if (Math.random() < 0.5) SFX.bubble(t + 0.1, EMPTY);
    },
    dive(t, o) {
      SFX.splash(t, { size: 1.2 });
      noise(t + 0.05, 0.7, 0.12, sfxBus, { type: 'lowpass', f0: 1800, f1: 300, sweep: 0.6, Q: 1.2, atk: 0.01 });
      for (let i = 0; i < 8; i++) SFX.bubble(t + 0.12 + i * 0.07, EMPTY);
    },
    surface(t, o) {
      noise(t, 0.4, 0.16, sfxBus, { type: 'highpass', f0: 900, atk: 0.004, rev: revS });
      tone('sine', 150, t, 0.22, 0.07, sfxBus, { f1: 320, glide: 0.18, atk: 0.01 });
      // the gasp
      tone('sawtooth', 210, t + 0.04, 0.34, 0.07, sfxBus, {
        f1: 160, glide: 0.3, filter: 'bandpass', ff0: 900, fq: 5, atk: 0.05, shape: 'soft',
      });
      for (let i = 0; i < 3; i++) SFX.bubble(t + 0.02 + i * 0.05, EMPTY);
    },
    // melee weapon arc (enemies.js swings and bonks landed fish with these)
    swing(t, o) {
      const s = cl(o && o.speed, 0.6, 1.6, 1);
      noise(t, 0.22 / s, 0.16, sfxBus, { type: 'bandpass', f0: 340 * s, f1: 1500 * s, sweep: 0.11, Q: 1.6, atk: 0.012, pan: -0.12 });
      noise(t + 0.09, 0.16, 0.09, sfxBus, { type: 'bandpass', f0: 1400 * s, f1: 420, sweep: 0.13, Q: 1.8, atk: 0.008, pan: 0.16 });
      tone('sine', 300, t + 0.02, 0.12, 0.025, sfxBus, { f1: 130, atk: 0.006 });
    },
    uiBlip(t, o) {
      tone('sine', 1320, t, 0.07, 0.075, sfxBus, { atk: 0.002, rev: revS });
      tone('sine', 1980, t + 0.03, 0.06, 0.03, sfxBus, { atk: 0.002 });
    },
    uiOpen(t, o) {
      tone('sine', 740, t, 0.1, 0.08, sfxBus, { f1: 1240, glide: 0.07, atk: 0.003, rev: revS });
      noise(t, 0.07, 0.035, sfxBus, { type: 'highpass', f0: 4200, atk: 0.002 });
    },
    uiClose(t, o) {
      tone('sine', 1180, t, 0.1, 0.07, sfxBus, { f1: 660, glide: 0.07, atk: 0.003, rev: revS });
      noise(t, 0.06, 0.03, sfxBus, { type: 'lowpass', f0: 1800, atk: 0.002 });
    },
    // the deadline is closing in
    warning(t, o) {
      const days = cl(o && o.daysLeft, 0, 3, 2);
      const urg = 1 - days / 3;
      bell(t, mtof(50), 0.16 + urg * 0.1, 3.2, sfxBus, revL);
      bell(t + 0.55, mtof(50), 0.12 + urg * 0.08, 3.4, sfxBus, revL);
      tone('sine', mtof(26), t, 3.4, 0.18, sfxBus, { atk: 0.4, hold: 1.4 });
      noise(t + 0.2, 2.2, 0.05, sfxBus, { type: 'lowpass', f0: 500, f1: 140, sweep: 2.0, Q: 1.2, atk: 0.6, brown: true, rev: revL });
    },
    portalEnter(t, o) {
      noise(t, 1.2, 0.16, sfxBus, { type: 'bandpass', f0: 500, f1: 6000, sweep: 1.0, Q: 1.2, atk: 0.05, rev: revL, prio: true });
      tone('sine', 220, t, 1.4, 0.2, sfxBus, { f1: 1760, glide: 1.2, atk: 0.02, rev: revL, prio: true });
      tone('triangle', 110, t, 1.5, 0.12, sfxBus, { f1: 880, glide: 1.3, atk: 0.05, rev: revL });
      for (let i = 0; i < 6; i++) bell(t + 0.1 + i * 0.1, mtof(72 + i * 4), 0.09, 1.4, sfxBus, revL);
      duckAmbience(0.3, 1.6);
    },
    // cues any module can fire at the transport / engine
    musicCut() { cutMusic(); },
    musicStop(t, o) { stopMusic(cl(o && o.fade, 0.1, 10, 1.5)); },
    motorOff() { motorAuto = false; motorStop(); },
  };
  // alias used by shops / wallets
  SFX.sellFish = SFX.sell;
  SFX.buyItem = SFX.buy;
  SFX.tsunami = SFX.tsunamiRoar;

  // Friendlier names other modules may reach for. These resolve to the
  // canonical cue BEFORE dedup bookkeeping, so an alias and its target can
  // never double-fire the same sound.
  const SFX_ALIAS = {
    thunderClap: 'thunder', thunderCrack: 'thunder', thunderRoll: 'thunder',
    lightning: 'lightningZap', lightningStrike: 'lightningZap', zap: 'lightningZap',
    bonkFish: 'bonk', whack: 'bonk', thwack: 'bonk',
    stowFish: 'stow', fishStow: 'stow',
    fishEscape: 'flopperEscape', flopperGone: 'flopperEscape', escapeSting: 'flopperEscape',
    // movement
    step: 'footstep', walk: 'footstep', footsteps: 'footstep', stepWood: 'deckStep',
    land: 'jumpThud', jumpLand: 'jumpThud', landThud: 'jumpThud',
    jumpStart: 'jump', hop: 'jump',
    swim: 'swimStroke', stroke: 'swimStroke', swimming: 'swimStroke',
    submerge: 'dive', diveIn: 'dive', emerge: 'surface', surfaceUp: 'surface',
    // boats
    boardBoat: 'board', boatBoard: 'board', embark: 'board', disembark: 'footstep',
    motor: 'motorLoop', engine: 'motorLoop', boatMotor: 'motorLoop',
    motorStop: 'motorOff', engineOff: 'motorOff',
    hullCreak: 'creak', boatCreak: 'creak',
    // combat
    meleeSwing: 'swing', weaponSwing: 'swing', attack: 'swing', slash: 'swing',
    harpoon: 'harpoonThrow', spear: 'spearShot', speargun: 'spearShot', trident: 'tridentZap',
    enemyHit: 'enemyHurt', enemyKill: 'enemyDie', enemyDeath: 'enemyDie',
    hit: 'impact', damage: 'playerHurt', hurt: 'playerHurt', playerDamaged: 'playerHurt',
    drowning: 'drown', drowned: 'drown',
    // fishing
    cast: 'castWhoosh', castStart: 'castWhoosh', whoosh: 'castWhoosh',
    reel: 'reelIn', reelStart: 'reelIn', snap: 'lineSnap', lineBreak: 'lineSnap',
    fanfare: 'catchFanfare', caught: 'catchFanfare', mutation: 'catchMutation',
    bobber: 'bobberSet', hook: 'hookSet', miss: 'lineMiss',
    // shop / progression
    sold: 'sell', purchase: 'buy', fail: 'error', denied: 'error', shopError: 'error',
    quota: 'quotaDone', quotaComplete: 'quotaDone',
    upgraded: 'upgrade', boatUpgrade: 'upgrade', rodUpgrade: 'upgrade',
    // world / endgame
    portal: 'portalHum', portalOpen: 'portalHum', enterPortal: 'portalEnter',
    win: 'gameWon', victory: 'gameWon', lose: 'gameOver', defeat: 'gameOver', gameLost: 'gameOver',
    tsunamiWarning: 'warning', deadline: 'warning',
    cutMusic: 'musicCut', stopMusic: 'musicStop', musicFade: 'musicStop',
    // wave 4: diving loot, ambushers, water exit
    lootChest: 'chestOpen', chest: 'chestOpen', openChest: 'chestOpen',
    clam: 'pearlPop', pearl: 'pearlPop', lootClam: 'pearlPop',
    coins: 'coinScoop', coinPile: 'coinScoop', lootCoins: 'coinScoop', goldScoop: 'coinScoop',
    bottle: 'bottleUncork', uncork: 'bottleUncork', lootBottle: 'bottleUncork',
    relic: 'relicHum', lootRelic: 'relicHum', artifactHum: 'relicHum',
    geode: 'geodeChime', lootGeode: 'geodeChime', crystal: 'geodeChime',
    unique: 'uniqueFanfare', uniqueCharm: 'uniqueFanfare', charmFound: 'uniqueFanfare',
    jelly: 'jellySting', sting: 'jellySting', daggerjelly: 'jellySting', venom: 'jellySting',
    moray: 'morayLunge', ambush: 'morayLunge', lunge: 'morayLunge', depthmaw: 'morayLunge',
    climbOut: 'vault', vaultOut: 'vault', waterExit: 'vault', haulOut: 'vault',
    pickup: 'pickupPop', grab: 'pickupPop', pickupFlopper: 'pickupPop',
    collect: 'pickupPop', lootPickup: 'pickupPop',
    // wave 5: perfect cast, reviving, doomsday
    perfect: 'perfectCast', perfectThrow: 'perfectCast', castPerfect: 'perfectCast',
    reviveHold: 'reviveChannel', reviveLoop: 'reviveChannel', reviving: 'reviveChannel',
    revived: 'revive', reviveDone: 'revive', wakeUp: 'revive',
    claw: 'clawGrab', rescueClaw: 'clawGrab', towBody: 'clawGrab', grabBody: 'clawGrab',
    quake: 'doomQuake', doomRumble: 'doomQuake', groundShake: 'doomQuake',
    bell: 'doomBell', dreadBell: 'doomBell', toll: 'doomBell',
    // wave 7: headshots, stuns, deep-water ambushes. ('ambush' already means
    // the moray's lunge — the swimmer's telegraph is 'ambushSting'.)
    crit: 'headshot', critHit: 'headshot', headHit: 'headshot', headShot: 'headshot',
    stun: 'headshot', enemyStun: 'headshot',
    frenzy: 'razorFrenzy', razorfin: 'razorFrenzy', razorfins: 'razorFrenzy', swarm: 'razorFrenzy',
    ambushWarn: 'ambushSting', dread: 'ambushSting', circling: 'ambushSting',
    eventStun: 'eventStunned', daze: 'eventStunned', dazed: 'eventStunned', giantStun: 'eventStunned',
    // ui
    blip: 'uiBlip', click: 'uiBlip', uiClick: 'uiBlip', select: 'uiBlip', tick: 'uiBlip',
    open: 'uiOpen', menuOpen: 'uiOpen', shopOpen: 'uiOpen',
    close: 'uiClose', menuClose: 'uiClose', shopClose: 'uiClose',
    notify: 'toast', message: 'toast',
  };
  function resolveSfx(name) { return SFX_ALIAS[name] || name; }

  // Some cues reach us twice: a module fires one directly AND the bus/net
  // relay of the same server message fires it again a frame later. These are
  // all one-per-moment events, so a floor on how often each may sound removes
  // the flams without touching cues that legitimately machine-gun (bubbles,
  // reel ticks, footsteps, zaps).
  const HARD_DEDUP = {
    board: 0.35, stow: 0.25, flopperEscape: 0.4, bonk: 0.06,
    catchFanfare: 0.4, catchMutation: 0.4, bite: 0.3, lineSnap: 0.2,
    sell: 0.2, buy: 0.2, error: 0.15, upgrade: 0.4,
    quotaDone: 1.0, warning: 3, drown: 1.2,
    portalHum: 1.0, portalEnter: 1.0,
    tsunamiRoar: 2.0, tsunamiImpact: 0.5,
    gameWon: 2.0, gameOver: 2.0,
    eventDrone: 1.0, eventDepart: 1.5,
    jump: 0.12, jumpThud: 0.1,
    // wave 4 — LOOT_RESULT arrives over net AND (usually) over the bus
    chestOpen: 0.6, pearlPop: 0.25, coinScoop: 0.45, bottleUncork: 0.4,
    relicHum: 0.7, geodeChime: 0.5, uniqueFanfare: 2.5,
    jellySting: 0.12, morayLunge: 0.3, vault: 0.25, pickupPop: 0.12,
    // wave 5 — REVIVED/BODY_TOWED arrive over net AND (usually) over the bus.
    // The two loop toggles are deliberately absent: an on/off pair must never
    // be swallowed by a dedup floor.
    perfectCast: 0.25, revive: 0.4, clawGrab: 0.2, doomBell: 4.0,
    // wave 7 — AMBUSH and EVENT_PHASE both arrive over net AND the bus relay.
    // 'razorFrenzy' is deliberately absent: it is an on/off pair.
    headshot: 0.06, ambushSting: 0.8, eventStunned: 1.2,
  };

  let tickCount = 0;
  function reelTick(t, vel) {
    noise(t, 0.02, 0.09 * vel, sfxBus, { type: 'bandpass', f0: 2600 + Math.random() * 900, Q: 12, atk: 0.001 });
    // accent every third tick instead of doubling every tick - same ratchet, half the nodes
    if ((tickCount++ % 3) === 0) {
      tone('square', 1800 + Math.random() * 500, t, 0.012, 0.05 * vel, sfxBus, { atk: 0.001, filter: 'highpass', ff0: 900 });
    }
  }

  function duckAmbience(level, dur) {
    if (!ac || !ambBus || pNow(ambBus.gain, 0) < 0.02) return;
    const t = ac.currentTime;
    const d = cl(dur, 0.05, 20, 1);
    const to = gVal(Math.max(0.0001, AMB_LEVEL * cl(level, 0, 1, 0.5)), 0.0001);
    pCancel(ambBus.gain, t);
    pAt(ambBus.gain, gVal(Math.max(0.0001, pNow(ambBus.gain, 0.0001)), 0.0001), t);
    pExp(ambBus.gain, to, t + 0.3);
    pAt(ambBus.gain, to, t + Math.max(0.35, d));
    pExp(ambBus.gain, gVal(AMB_LEVEL * (musicState === 'silence' || musicState === 'horror' ? 0.55 : 1)), t + Math.max(0.35, d) + 2.5);
  }

  // ---- motor ----
  function motorStart() {
    if (!ac || !built || motor) return;
    const t = ac.currentTime;
    const out = gainNode(0.0001);
    out.connect(sfxBus);
    const amp = gainNode(0.2);
    amp.connect(out);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    // Q 3.5 on a cutoff that gets swept every frame is asking for a resonant
    // spike; 1.6 still reads as an engine and cannot ring.
    pSet(lp.frequency, fHz(420)); pSet(lp.Q, qVal(1.6));
    lp.connect(amp);
    const saw = ac.createOscillator(); saw.type = 'sawtooth'; pSet(saw.frequency, oHz(62));
    const sawG = gainNode(0.5); saw.connect(sawG); sawG.connect(lp);
    const sq = ac.createOscillator(); sq.type = 'square'; pSet(sq.frequency, oHz(31));
    const sqG = gainNode(0.24); sq.connect(sqG); sqG.connect(lp);
    const ns = ac.createBufferSource(); ns.buffer = brownBuf; ns.loop = true;
    const nf = ac.createBiquadFilter(); nf.type = 'lowpass';
    pSet(nf.frequency, fHz(500)); pSet(nf.Q, qVal(0.7));
    const nG = gainNode(0.16); ns.connect(nf); nf.connect(nG); nG.connect(amp);
    // putt-putt gate — depth stays under the 0.2 amp so it never inverts
    const putt = ac.createOscillator(); putt.type = 'sawtooth'; pSet(putt.frequency, oHz(7));
    const puttG = ac.createGain(); pSet(puttG.gain, mVal(0.14, 1));
    putt.connect(puttG); puttG.connect(amp.gain);
    saw.start(t); sq.start(t); ns.start(0); putt.start(t);
    pExp(out.gain, gVal(0.22), t + 0.25);
    motor = { out, amp, lp, saw, sq, ns, nf, nG, putt, puttG, sawG, sqG, throttle: 0.4, level: 1 };
    motorDirty = true;
    motorTimer = 0;
  }
  function motorApply(smooth) {
    if (!motor || !ac) return;
    const t = ac.currentTime;
    const th = cl(motor.throttle, 0, 1, 0.4);
    // bigger boats run deeper and louder
    const lv = cl(motor.level, 1, 4, 1);
    const deep = 1 - (lv - 1) * 0.08;
    const k = cl(smooth, 0.01, 2, 0.12);
    pTgt(motor.saw.frequency, oHz((52 + th * 78) * deep), t, k);
    pTgt(motor.sq.frequency, oHz((26 + th * 39) * deep), t, k);
    pTgt(motor.lp.frequency, fHz(300 + th * 1100), t, k);
    pTgt(motor.putt.frequency, oHz(6 + th * 13), t, k);
    pTgt(motor.nG.gain, gVal(0.1 + th * 0.16), t, k);
    pTgt(motor.out.gain, gVal((0.14 + th * 0.16) * (1 + (lv - 1) * 0.07)), t, k);
  }
  function motorStop() {
    if (!motor || !ac) return;
    const t = ac.currentTime;
    const m = motor;
    motor = null;
    pCancel(m.out.gain, t);
    pAt(m.out.gain, gVal(Math.max(0.0001, pNow(m.out.gain, 0.0001)), 0.0001), t);
    pExp(m.out.gain, 0.0001, t + 0.45);
    const stopAt = t + 0.55;
    try { m.saw.stop(stopAt); m.sq.stop(stopAt); m.ns.stop(stopAt); m.putt.stop(stopAt); } catch (e) { /* noop */ }
    reg(stopAt + 0.1, [m.out, m.amp, m.lp, m.saw, m.sq, m.ns, m.nf, m.nG, m.putt, m.puttG, m.sawG, m.sqG]);
  }

  // ------------------------------------------------------------------
  // wave 5 loops — revive channel + doomsday quake
  // ------------------------------------------------------------------
  // Both follow the motor's shape: a small always-bounded sub-graph with one
  // envelope gain, torn down on stop, on a rebuild, and on any phase change.
  // Every source runs through a level gain that is modulated on a SEPARATE
  // node, so the envelope has exactly one writer (see the pad's tremolo).
  function stopLoop(n, fade) {
    if (!ac || !n) return;
    const t = ac.currentTime;
    const f = cl(fade, 0.05, 6, 0.3);
    pCancel(n.out.gain, t);
    pAt(n.out.gain, gVal(Math.max(0.0001, pNow(n.out.gain, 0.0001)), 0.0001), t);
    pExp(n.out.gain, 0.0001, t + f);
    const stopAt = t + f + 0.1;
    for (let i = 0; i < n.osc.length; i++) { try { n.osc[i].stop(stopAt); } catch (e) { /* noop */ } }
    for (let i = 0; i < n.src.length; i++) { try { n.src[i].stop(stopAt); } catch (e) { /* noop */ } }
    reg(stopAt + 0.12, n.list);
  }

  // a soft rising shimmer while you hold E over a downed crewmate
  function channelStart() {
    if (!ac || !built || chanNodes) return;
    const t = ac.currentTime;
    const out = gainNode(0.0001);
    out.connect(sfxBus);
    out.connect(revM);
    const sh = gainNode(1);         // shimmer LFO lives here, not on the envelope
    sh.connect(out);

    // two voices climbing a fifth apart — hope, arriving
    const a = ac.createOscillator(); a.type = 'sine';
    pAt(a.frequency, oHz(392), t); pTgt(a.frequency, oHz(784), t, 1.5);
    const ag = gainNode(0.13); a.connect(ag); ag.connect(sh);
    const b = ac.createOscillator(); b.type = 'triangle';
    pAt(b.frequency, oHz(587), t); pTgt(b.frequency, oHz(1175), t, 1.8);
    const bg = gainNode(0.05); b.connect(bg); bg.connect(sh);

    // air opening up over the top
    const ns = ac.createBufferSource(); ns.buffer = whiteBuf; ns.loop = true;
    pSet(ns.playbackRate, rVal(0.9));
    const nf = ac.createBiquadFilter(); nf.type = 'bandpass';
    pAt(nf.frequency, fHz(1100), t); pTgt(nf.frequency, fHz(4200), t, 1.6);
    pSet(nf.Q, qVal(1.6));
    const ng = gainNode(0.05);
    ns.connect(nf); nf.connect(ng); ng.connect(sh);

    const lfo = ac.createOscillator(); lfo.type = 'sine'; pSet(lfo.frequency, oHz(5.2));
    const lg = ac.createGain(); pSet(lg.gain, mVal(0.16, 1));
    lfo.connect(lg); lg.connect(sh.gain);

    a.start(t); b.start(t); ns.start(0); lfo.start(t);
    pExp(out.gain, gVal(0.55), t + 0.25);
    chanNodes = { out, list: [out, sh, a, ag, b, bg, ns, nf, ng, lfo, lg], osc: [a, b, lfo], src: [ns] };
    chanAt = t;
  }
  function channelStop(fade) {
    if (!chanNodes) return;
    const n = chanNodes;
    chanNodes = null;
    stopLoop(n, fade === undefined ? 0.28 : fade);
  }

  // the doomsday bed: a sub rumble you feel in the floor
  function quakeStart() {
    if (!ac || !built || quakeNodes) return;
    const t = ac.currentTime;
    const out = gainNode(0.0001);
    out.connect(sfxBus);
    const bed = gainNode(1);        // the heave rides here; out.gain is the envelope
    bed.connect(out);

    const ns = ac.createBufferSource(); ns.buffer = brownBuf; ns.loop = true;
    pSet(ns.playbackRate, rVal(0.26));
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass';
    pSet(lp.frequency, fHz(72)); pSet(lp.Q, qVal(0.7));
    const ng = gainNode(0.5);
    ns.connect(lp); lp.connect(ng); ng.connect(bed);

    // two subs beating slowly against each other
    const s1 = ac.createOscillator(); s1.type = 'sine'; pSet(s1.frequency, oHz(23.5));
    const s2 = ac.createOscillator(); s2.type = 'sine'; pSet(s2.frequency, oHz(27.2));
    const sg = gainNode(0.3);
    s1.connect(sg); s2.connect(sg); sg.connect(bed);

    const lfo = ac.createOscillator(); lfo.type = 'sine'; pSet(lfo.frequency, oHz(0.21));
    const lg = ac.createGain(); pSet(lg.gain, mVal(0.32, 1));
    lfo.connect(lg); lg.connect(bed.gain);

    ns.start(0); s1.start(t); s2.start(t); lfo.start(t);
    pAt(out.gain, 0.0001, t);
    pExp(out.gain, gVal(0.18), t + 0.8);
    pExp(out.gain, gVal(0.5), t + 6.0);   // it keeps building until the water lands
    quakeNodes = { out, list: [out, bed, ns, lp, ng, s1, s2, sg, lfo, lg], osc: [s1, s2, lfo], src: [ns] };
    quakeAt = t;
  }
  function quakeStop(fade) {
    if (!quakeNodes) return;
    const n = quakeNodes;
    quakeNodes = null;
    stopLoop(n, fade === undefined ? 1.4 : fade);
  }

  // ------------------------------------------------------------------
  // wave 7 — the razorfin swarm bed
  // ------------------------------------------------------------------
  // Same shape as the other loops: one envelope gain (out.gain, single
  // writer), every modulator on its own node, everything torn down on stop /
  // rebuild / phase change. It sits UNDER the music on purpose — the swarm is
  // a texture you feel, and the individual bites (chomp, scheduled from
  // update) are what actually make you flinch.
  function frenzyStart() {
    frenzyWant = true;
    if (!ac || !built || frenzyNodes) return;
    const t = ac.currentTime;
    const out = gainNode(0.0001);
    out.connect(sfxBus);
    out.connect(revS);
    const bed = gainNode(1);        // the chitter gate rides here, never on out.gain
    bed.connect(out);

    // churned water underneath
    const ws = pNoiseLocal(brownBuf, 0.8);
    const wf = ac.createBiquadFilter(); wf.type = 'lowpass';
    pSet(wf.frequency, fHz(520)); pSet(wf.Q, qVal(0.7));
    const wg = gainNode(0.34);
    ws.connect(wf); wf.connect(wg); wg.connect(bed);

    // the chittering: a narrow band of hiss, gated fast
    const cs = pNoiseLocal(whiteBuf, 1.35);
    const cf = ac.createBiquadFilter(); cf.type = 'bandpass';
    pSet(cf.frequency, fHz(2600)); pSet(cf.Q, qVal(4.5));
    const cgate = gainNode(0.5);
    const cg = gainNode(0.3);
    cs.connect(cf); cf.connect(cgate); cgate.connect(cg); cg.connect(bed);
    // depth 0.45 against a 0.5 gate: it flutters, it never inverts
    const chit = ac.createOscillator(); chit.type = 'square'; pSet(chit.frequency, oHz(17));
    const chitG = ac.createGain(); pSet(chitG.gain, mVal(0.45, 1));
    chit.connect(chitG); chitG.connect(cgate.gain);
    // and a slow sweep so the pack circles instead of sitting still
    // (2600 +/- 900 Hz — nowhere near the cutoff floor)
    const sw = ac.createOscillator(); sw.type = 'sine'; pSet(sw.frequency, oHz(0.37));
    const swG = ac.createGain(); pSet(swG.gain, mVal(modDepth(2600, 900, 400), F_MAX));
    sw.connect(swG); swG.connect(cf.frequency);

    ws.start(0); cs.start(0); chit.start(t); sw.start(t);
    pAt(out.gain, 0.0001, t);
    pExp(out.gain, gVal(0.32), t + 0.35);
    frenzyNodes = {
      out,
      list: [out, bed, ws, wf, wg, cs, cf, cgate, cg, chit, chitG, sw, swG],
      osc: [chit, sw], src: [ws, cs],
    };
    frenzyAt = t;
    nextChomp = t + 0.1;
    duckAmbience(0.55, 3.0);
  }
  function frenzyStop(fade) {
    frenzyWant = false;
    nextChomp = 0;
    if (!frenzyNodes) return;
    const n = frenzyNodes;
    frenzyNodes = null;
    stopLoop(n, fade === undefined ? 0.7 : fade);
  }
  // a looping noise source that is NOT registered as a persistent node —
  // the loop owns it, stopLoop() reaps it (pNoiseSrc is for the always-on bed)
  function pNoiseLocal(buf, rate) {
    const s = ac.createBufferSource();
    s.buffer = buf; s.loop = true;
    pSet(s.playbackRate, rVal(rate, 1));
    return s;
  }
  // one razorfin taking a pass at you
  function chomp(t) {
    if (!ac || !built || full()) return;
    const p = 0.82 + Math.random() * 0.5;
    const pan = (Math.random() - 0.5) * 1.5;
    noise(t, 0.045, 0.13, sfxBus, { type: 'bandpass', f0: fHz(2200 * p, 2200), Q: 7, atk: 0.001, pan });
    noise(t + 0.02, 0.09, 0.07, sfxBus, {
      type: 'bandpass', f0: fHz(800 * p, 800), f1: 380, sweep: 0.07, Q: 2, atk: 0.002, pan,
    });
    if (Math.random() < 0.45) {
      tone('square', 900 * p, t, 0.035, 0.05, sfxBus, {
        f1: 520 * p, atk: 0.001, filter: 'lowpass', ff0: 3400, pan,
      });
    }
  }

  // ------------------------------------------------------------------
  // public sfx entry
  // ------------------------------------------------------------------
  // callers across the codebase pass loudness as {volume}, {vol} or {gain}, and
  // some pass a world {pos:[x,y,z]} - honour all of them for every sound
  // accepts [x,y,z], {x,y,z} (a THREE.Vector3 walks in here regularly) or null
  function readPos(p, out) {
    if (!p) return false;
    if (typeof p.x === 'number' && typeof p.y === 'number' && typeof p.z === 'number') {
      out[0] = num(p.x, 0); out[1] = num(p.y, 0); out[2] = num(p.z, 0);
      return true;
    }
    if (typeof p.length === 'number' && p.length >= 3) {
      out[0] = num(p[0], 0); out[1] = num(p[1], 0); out[2] = num(p[2], 0);
      return true;
    }
    return false;
  }
  const _posBuf = [0, 0, 0];

  function applyOpts(o) {
    curScale = 1;
    curPan = 0;
    let v = o.volume;
    if (typeof v !== 'number') v = o.vol;
    if (typeof v !== 'number') v = o.gain;
    // cl() folds NaN/Infinity to the default — Math.max(0.0004, NaN) used to
    // survive all the way to an AudioParam and poison the voice
    if (typeof v === 'number') curScale = cl(v, 0, 4, 1);
    if (!readPos(o.pos, _posBuf)) return;
    const cam = ctx && ctx.camera;
    const e = cam && cam.matrixWorld ? cam.matrixWorld.elements : null;
    if (!e || e.length < 15) return;
    const dx = _posBuf[0] - num(e[12], 0), dy = _posBuf[1] - num(e[13], 0), dz = _posBuf[2] - num(e[14], 0);
    const dist = cl(Math.sqrt(dx * dx + dy * dy + dz * dz), 0, 1e6, 0);
    if (dist > 260) { curScale = 0; return; }
    curScale = cl(curScale * (14 / (14 + dist)), 0, 4, 1);   // gentle distance rolloff
    if (dist < 0.5) return;
    const inv = 1 / dist;
    curPan = pVal(cl((dx * num(e[0], 0) + dy * num(e[1], 0) + dz * num(e[2], 0)) * inv, -1, 1, 0) * 0.8);
  }

  // opts may be an options object, a bare volume number, or (name, volume, pos)
  function sfx(name, opts, posArg) {
    if (!name) return;
    if (!ensureContext(gestureSeen || started)) return;
    if (!built) return;
    name = resolveSfx(name);
    const fn = SFX[name];
    if (!fn) return;
    const floor = HARD_DEDUP[name];
    if (floor !== undefined) {
      const last = lastFired[name];
      if (last !== undefined && ac.currentTime - last < floor) return;
    }
    if (ac.state === 'suspended') ac.resume().catch(() => { });
    let o = (opts && typeof opts === 'object') ? opts : EMPTY;
    if (typeof opts === 'number' || posArg) {
      o = { volume: typeof opts === 'number' ? opts : 1, pos: posArg || null };
    }
    try {
      applyOpts(o);
      if (curScale > 0.001) fn(ac.currentTime + 0.005, o);
      lastFired[name] = ac.currentTime;
    } catch (e) { warn(e); } finally { curScale = 1; curPan = 0; }
  }

  // fire only if this sound has not played very recently (protects against
  // both a module and the bus wiring triggering the same cue)
  function sfxDedup(name, opts, gap) {
    if (!ensureContext(gestureSeen || started)) return;
    name = resolveSfx(name);
    const last = lastFired[name];
    if (last !== undefined && ac.currentTime - last < (gap || 0.3)) return;
    sfx(name, opts);
  }

  // ------------------------------------------------------------------
  // underwater
  // ------------------------------------------------------------------
  // push the current underwater state onto the graph (also used after a rebuild)
  function applyUnderwater(instant) {
    if (!ac || !built || !uwFilter) return;
    const t = ac.currentTime;
    const on = underwater;
    pCancel(uwFilter.frequency, t);
    pAt(uwFilter.frequency, fHz(Math.max(20, pNow(uwFilter.frequency, 18000)), 18000), t);
    if (instant) pAt(uwFilter.frequency, fHz(on ? 700 : 18000), t);
    else pExp(uwFilter.frequency, fHz(on ? 700 : 18000), t + (on ? 0.35 : 0.7));
    pTgt(uwFilter.Q, qVal(on ? 1.5 : 0.7), t, instant ? 0.01 : 0.15);
    if (subGain) pTgt(subGain.gain, gVal(on ? 0.34 : 0.0001), t, instant ? 0.01 : (on ? 0.6 : 0.9));
    if (padDetunes) {
      for (let i = 0; i < padDetunes.length; i++) {
        const d = padDetunes[i];
        pTgt(d.p, mVal(num(d.base, 0) + (on ? -16 : 0), 2400), t, instant ? 0.01 : 0.5);
      }
    }
  }

  function setUnderwater(on) {
    on = !!on;
    const changed = on !== underwater;
    underwater = on;
    if (!ac || !built) return;
    const t = ac.currentTime;
    applyUnderwater(false);
    if (changed) {
      applyWeatherBed(false);   // the surface bed is muffled from below
      noise(t, on ? 0.5 : 0.35, 0.18, sfxBus, {
        type: 'lowpass', f0: on ? 1800 : 500, f1: on ? 380 : 2400, sweep: 0.3, Q: 1.2, atk: 0.006,
      });
      const n = on ? 6 : 3;
      for (let i = 0; i < n; i++) SFX.bubble(t + 0.04 + i * 0.06, EMPTY);
    }
  }

  function setVolume(v01) {
    userVol = cl(v01, 0, 1, 0.8);
    if (masterIn && ac) pTgt(masterIn.gain, gVal(Math.min(1, Math.pow(userVol, 1.35))), ac.currentTime, 0.04);
  }

  // ------------------------------------------------------------------
  // watchdog — sound must never be able to die permanently
  // ------------------------------------------------------------------
  // Once a DelayNode inside a feedback loop has swallowed a NaN it hands that
  // NaN back on every block forever, so nothing downstream can revive the mix.
  // The only real cure is a fresh graph. This tears the whole thing out and
  // rebuilds it (~60 nodes, a few ms), then puts the state back exactly as it
  // was: volume, underwater filter, event silence/horror, weather bed, music
  // phase. Safe to call at any time; a no-op if it just ran.
  function killNode(n) {
    if (!n) return;
    try { if (typeof n.stop === 'function') n.stop(0); } catch (e) { /* not started / already stopped */ }
    try { n.disconnect(); } catch (e) { /* already detached */ }
  }

  function teardownGraph() {
    for (let i = 0; i < voices.length; i++) {
      const v = voices[i];
      for (let k = 0; k < v.nodes.length; k++) killNode(v.nodes[k]);
      v.nodes.length = 0;
    }
    voices.length = 0;
    voicePool.length = 0;

    if (horrorNodes) {
      const n = horrorNodes;
      horrorNodes = null;
      const list = n.list || [];
      for (let i = 0; i < list.length; i++) killNode(list[i]);
    }
    if (motor) {
      const m = motor;
      motor = null;
      const list = [m.out, m.amp, m.lp, m.saw, m.sq, m.ns, m.nf, m.nG, m.putt, m.puttG, m.sawG, m.sqG];
      for (let i = 0; i < list.length; i++) killNode(list[i]);
    }
    if (chanNodes) {
      const n = chanNodes;
      chanNodes = null;
      for (let i = 0; i < n.list.length; i++) killNode(n.list[i]);
    }
    if (quakeNodes) {
      const n = quakeNodes;
      quakeNodes = null;
      for (let i = 0; i < n.list.length; i++) killNode(n.list[i]);
    }
    if (frenzyNodes) {
      // frenzyWant is left alone on purpose — restoreState re-arms the swarm
      const n = frenzyNodes;
      frenzyNodes = null;
      for (let i = 0; i < n.list.length; i++) killNode(n.list[i]);
    }

    for (let i = 0; i < persistRun.length; i++) { try { persistRun[i].stop(0); } catch (e) { /* noop */ } }
    for (let i = 0; i < persist.length; i++) { try { persist[i].disconnect(); } catch (e) { /* noop */ } }
    persistRun.length = 0;
    persist.length = 0;

    masterIn = uwFilter = limiter = hardLimit = outGain = null;
    analyser = null;
    musicBus = sfxBus = ambBus = horrorBus = null;
    revS = revM = revL = revIn = revOut = null;
    padVoices = null; padFilter = null; padOut = null; padDetunes = null;
    waveGain = null; waveFilter = null; surfGain = null; subGain = null;
    wxOut = null; wxRainGain = null; wxRainHP = null; wxRainLP = null;
    wxWindGain = null; wxWindFilt = null; wxRumbleGain = null;
    wxBuilt = false; wxApplied = '';
    motorDirty = true;
    built = false;
  }

  function restoreState() {
    if (!ac || !built) return;
    const t = ac.currentTime;
    setVolume(userVol);
    applyUnderwater(true);

    const hushed = (musicState === 'silence' || musicState === 'horror');
    const ambTo = started ? AMB_LEVEL * (hushed ? 0.55 : 1) : 0.0001;
    pAt(ambBus.gain, gVal(Math.max(0.0001, ambTo)), t);
    pAt(sfxBus.gain, gVal(SFX_LEVEL), t);

    if (musicState === 'playing') {
      schedulerOn = true;
      stepIdx = 0;
      arpCursor = 0;
      regenMelody();
      nextNoteTime = t + 0.12;
      pAt(musicBus.gain, 0.0001, t);
      pExp(musicBus.gain, gVal(MUSIC_LEVEL), t + 0.6);
    } else {
      schedulerOn = false;
      pAt(musicBus.gain, 0.0001, t);
    }

    if (musicState === 'horror') {
      startHorror();                       // horrorNodes was cleared by teardown
      nextHeart = t + 1.2;
      nextScrape = t + 8 + Math.random() * 8;
    } else {
      pAt(horrorBus.gain, 0.0001, t);
    }

    musicParams(t);
    applyWeatherBed(true);
    reelOn = false; reelHold = 0;
    chanSeen = 0;
    // a rebuild in the middle of the doomsday must not silence the ground
    if (t - doomAt < 40) quakeStart();
    // ...and a rebuild mid-frenzy must not silence the pack chewing on you
    nextChomp = 0;
    if (frenzyWant) frenzyStart();
    pendingThunder.length = 0;
  }

  function rebuildGraph(reason) {
    if (!ac || rebuilding || failed) return;
    if (ac.state === 'closed') return;
    const now = ac.currentTime;
    if (now - lastRebuildAt < 3) return;   // never thrash
    rebuilding = true;
    lastRebuildAt = now;
    rebuilds++;
    if (rebuilds <= 3) console.warn('[audio] graph poisoned (' + reason + ') — rebuilding');
    try {
      teardownGraph();
      buildGraph();
      restoreState();
    } catch (e) {
      warn(e);
      built = false;
      // a graph we cannot even construct is not worth retrying forever
      if (rebuilds > 8) failed = true;
    }
    wdHot = 0;
    wdTimer = 2.0;
    rebuilding = false;
  }

  // sampled ~1/s off the compressor, before the shaper, so the reading is the
  // real peak and a NaN is still a NaN
  function watchdogTick(dt) {
    wdTimer -= dt;
    if (wdTimer > 0) return;
    wdTimer = 1.0;
    if (!analyser || !wdBuf || !built) return;
    try { analyser.getFloatTimeDomainData(wdBuf); } catch (e) { return; }
    let peak = 0;
    for (let i = 0; i < wdBuf.length; i++) {
      const v = wdBuf[i];
      if (!(v > -1e30 && v < 1e30)) { rebuildGraph('nan'); return; }   // NaN/Inf both fail this
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
    if (peak > 4) {
      if (++wdHot >= 3) rebuildGraph('overload');   // 3 s of genuine runaway
    } else {
      wdHot = 0;
    }
  }

  // ------------------------------------------------------------------
  // wiring: bus + net
  // ------------------------------------------------------------------
  function onGesture() {
    gestureSeen = true;
    if (ac && ac.state === 'suspended') ac.resume().catch(() => { });
  }
  window.addEventListener('pointerdown', onGesture, { passive: true });
  window.addEventListener('keydown', onGesture, { passive: true });
  window.addEventListener('touchstart', onGesture, { passive: true });

  const bus = ctx && ctx.bus;
  if (bus && typeof bus.on === 'function') {
    bus.on('underwater', (on) => setUnderwater(!!on));
    bus.on('castStart', () => sfxDedup('castWhoosh', EMPTY, 0.25));
    bus.on('bite', () => sfxDedup('bite', EMPTY, 0.4));
    bus.on('catch', (d) => onCatch(d));
    bus.on('eventStart', (d) => onEventStart(d && d.type));
    bus.on('eventEnd', () => onEventEnd());
    bus.on('localDamaged', (d) => {
      const cause = d && d.cause ? String(d.cause) : '';
      if (cause === 'drown' || cause === 'air' || cause === 'water') sfxDedup('drown', EMPTY, 1.5);
      else sfxDedup('playerHurt', EMPTY, 0.25);
    });
    bus.on('boardBoat', () => sfxDedup('board', EMPTY, 0.3));
    bus.on('leaveBoat', () => sfxDedup('footstep', { surface: 'sand' }, 0.2));
    bus.on('phase', (p) => onPhase(p));
    bus.on('quotaDone', () => sfxDedup('quotaDone', EMPTY, 1.0));
    bus.on('flopper', (d) => onFlopper(d));
    bus.on('lootResult', (d) => onLootResult(d));
    bus.on('weather', (d) => setWeatherType(d && d.type ? d.type : d));
    bus.on('lightning', (d) => onLightning(d));
    bus.on('tsunami', () => onDoomsday());
    bus.on('gameOver', () => { frenzyStop(0.6); quakeStop(2.5); stopMusic(1.2); sfxDedup('gameOver', EMPTY, 3); });
    bus.on('gameWon', () => { frenzyStop(0.6); quakeStop(1.0); stopMusic(1.0); sfxDedup('gameWon', EMPTY, 3); });
    // wave 5
    bus.on('perfectCast', () => sfxDedup('perfectCast', EMPTY, 0.25));
    bus.on('reviveChannel', (d) => onReviveChannel(d));
    bus.on('revived', (d) => onRevived(d));
    bus.on('bodyTowed', (d) => onBodyTowed(d));
    // wave 7 — enemies.js fires 'headshot' itself, but the crit ding must
    // land even if it forgets; the dedup floor stops the two doubling up
    bus.on('headshot', () => sfxDedup('headshot', EMPTY, 0.06));
    bus.on('ambush', (d) => onAmbushMsg(d));
    bus.on('eventPhase', (d) => onEventPhaseMsg(d));
    // shop, wallet, portal and the UI had no voice at all before wave 3
    bus.on('shopResult', (d) => onShop(d));
    bus.on('wallet', (d) => onWallet(d));
    bus.on('portalState', (d) => onPortal(d));
    bus.on('tsunamiWarning', (d) => sfxDedup('warning', d || EMPTY, 5));
    bus.on('enemyHit', () => sfxDedup('enemyHurt', EMPTY, 0.08));
    bus.on('error', () => sfxDedup('error', EMPTY, 0.3));
    bus.on('toast', () => sfxDedup('toast', EMPTY, 0.25));
    bus.on('uiModal', (d) => sfxDedup(d && d.open ? 'uiOpen' : 'uiClose', EMPTY, 0.12));
    bus.on('chat', () => sfxDedup('uiBlip', EMPTY, 0.15));
  }

  function onShop(d) {
    if (!d) return;
    if (d.ok) { sfxDedup('buy', EMPTY, 0.2); onGear(d.gear); }
    else sfxDedup('error', EMPTY, 0.2);
  }

  // a level or a new item = the bigger upgrade flourish on top of the till
  function onGear(g) {
    if (!g) return;
    const rod = cl(g.rod, 0, 9, 0), boat = cl(g.boat, 0, 9, 0), div = cl(g.diving, 0, 9, 0);
    const wp = Array.isArray(g.weapons) ? g.weapons.length : 0;
    const ch = Array.isArray(g.charms) ? g.charms.length : 0;
    const grew = rod > lastGear.rod || boat > lastGear.boat || div > lastGear.diving
      || wp > lastGear.weapons || ch > lastGear.charms;
    lastGear.rod = rod; lastGear.boat = boat; lastGear.diving = div;
    lastGear.weapons = wp; lastGear.charms = ch;
    if (grew && lastGear.seen) sfxDedup('upgrade', { level: Math.max(rod, boat, div) }, 0.6);
    lastGear.seen = true;
  }

  function onWallet(d) {
    if (!d || typeof d.wallet !== 'number') return;
    const w = num(d.wallet, 0);
    if (lastWallet !== null && w > lastWallet + 0.5) sfxDedup('sell', EMPTY, 0.4);
    lastWallet = w;
  }

  function onPortal(d) {
    if (!d) return;
    const b = !!d.built;
    if (b && !portalWasBuilt) sfxDedup('portalHum', { duration: 5 }, 2);
    portalWasBuilt = b;
  }

  function onCatch(d) {
    if (!d) { sfxDedup('catchFanfare', { tier: 1 }, 0.5); return; }
    if (d.caught === false) return;
    const fish = d.fish || d;
    const tier = fish && fish.tier ? fish.tier : 1;
    sfxDedup('catchFanfare', { tier }, 0.5);
    if (fish && fish.mutation) sfxDedup('catchMutation', EMPTY, 0.5);
  }

  // --- wave 2: lightning + landed catches -------------------------------
  function myNetId() {
    const st = ctx && ctx.state;
    if (st && st.myId) return st.myId;
    try {
      const net = ctx && ctx.net;
      if (net && typeof net.id === 'function') return net.id();
    } catch (e) { /* offline */ }
    return null;
  }

  // world.js voices its own bolts, but only after the sound has flown to the
  // listener (up to ~2.2 s). So a plain debounce cannot tell "already played"
  // from "about to play": instead we queue our safety fire for the moment the
  // roll is due and drop it if anything actually made the sound by then.
  const pendingThunder = [];
  let lastStrikeAt = -99;

  function onLightning(d) {
    if (!d) return;
    if (!ensureContext(gestureSeen || started)) return;
    // net + a possible bus relay deliver the same strike; they are seconds apart
    if (ac.currentTime - lastStrikeAt < 0.5) return;
    lastStrikeAt = ac.currentTime;
    let dist = 140;
    const p = d.p;
    const cam = ctx && ctx.camera;
    const e = cam && cam.matrixWorld ? cam.matrixWorld.elements : null;
    if (p && p.length >= 3 && e) {
      const dx = p[0] - e[12], dy = p[1] - e[13], dz = p[2] - e[14];
      const dd = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (isFinite(dd)) dist = dd;
    }
    const me = myNetId();
    if (d.targetId && me && d.targetId === me) {
      dist = Math.min(dist, 5);
      sfxDedup('lightningZap', EMPTY, 0.25);
    }
    const mark = ac.currentTime;
    if (pendingThunder.length > 6) pendingThunder.shift();
    pendingThunder.push({ mark, at: mark + Math.min(2.4, dist / 340) + 0.12, dist });
  }

  function drainThunder(now) {
    for (let i = pendingThunder.length - 1; i >= 0; i--) {
      const q = pendingThunder[i];
      if (now < q.at) continue;
      pendingThunder.splice(i, 1);
      const last = lastFired.thunder;
      if (last === undefined || last < q.mark) sfx('thunder', { dist: q.dist, late: true });
    }
  }

  // wave 4: 'dead' no longer means banked — the fish stops flopping and turns
  // into a pickup, and 'stowed' is the moment it actually reaches the bag.
  function onFlopper(d) {
    if (!d) return;
    const st = d.state;
    if (st === 'hit') sfxDedup('bonk', EMPTY, 0.2);
    else if (st === 'dead') sfxDedup('stow', EMPTY, 0.35);        // the finishing whack
    else if (st === 'stowed') sfxDedup('pickupPop', EMPTY, 0.25); // scooped off the deck
    else if (st === 'escaped') sfxDedup('flopperEscape', EMPTY, 0.5);
  }

  // --- wave 4: underwater loot ------------------------------------------
  // LOOT_RESULT.kind is the LOOT_TYPES id the node was rolled from.
  const LOOT_CUE = {
    clam: 'pearlPop', coins: 'coinScoop', bottle: 'bottleUncork',
    chest: 'chestOpen', relic: 'relicHum', geode: 'geodeChime',
  };
  function onLootResult(d) {
    if (!d) return;
    if (d.ok === false) { sfxDedup('error', EMPTY, 0.3); return; }
    const kind = typeof d.kind === 'string' ? d.kind : (typeof d.type === 'string' ? d.type : '');
    const cue = LOOT_CUE[kind] || 'pickupPop';
    sfxDedup(cue, EMPTY, 0.3);
    // a found bait stack gets its own little scoop; a unique charm outranks it
    if (d.itemId && !d.uniqueId) sfxDedup('pickupPop', EMPTY, 0.25);
    if (d.uniqueId) {
      // hold the motif until the chest lid has finished creaking open
      sfxDedup('uniqueFanfare', { delay: cue === 'chestOpen' ? 0.95 : 0.2 }, 2.5);
    }
  }

  // --- wave 5: reviving -------------------------------------------------
  // The channel loop is driven by a stream of progress payloads; it stops on
  // an explicit end, on a revive landing, and on its own if the stream dries
  // up (see update) — a held note must never be able to get stuck on.
  function onReviveChannel(d) {
    if (!ensureContext(gestureSeen || started)) return;
    let on = !!d && d !== false && d.active !== false && d.cancel !== true;
    if (on && typeof d === 'object') {
      const t01 = num(d.t01, num(d.t, num(d.progress, num(d.p, 0))));
      on = t01 > 0.0001;
    }
    if (!on) { channelStop(0.22); chanSeen = 0; return; }
    chanSeen = ac.currentTime;
    sfx('reviveChannel', { on: true });
  }

  function onRevived(d) {
    if (!ensureContext(gestureSeen || started)) return;
    channelStop(0.1);
    chanSeen = 0;
    const me = myNetId();
    const mine = !d || d.id == null || (me && String(d.id) === String(me));
    sfxDedup('revive', mine ? EMPTY : { volume: 0.55 }, 0.35);
  }

  function onBodyTowed(d) {
    if (!d || d.by == null || d.by === false) return;   // a release makes no noise
    sfxDedup('clawGrab', EMPTY, 0.25);
  }

  // --- wave 7: deep-water ambushes + the giants' daze -------------------
  // These fire straight off the protocol so the cues work even if no other
  // module remembers to call sfx() — ui.js only paints. Everything is gated
  // on the ambush being OURS: a crewmate's frenzy is happening somewhere
  // else in the ocean and has no business in your ears.
  function onAmbushMsg(d) {
    if (!d || typeof d !== 'object') return;
    if (!ensureContext(gestureSeen || started)) return;
    const phase = String(d.phase || '');
    if (phase !== 'warn' && phase !== 'start' && phase !== 'end') return;
    const target = (d.targetId != null) ? String(d.targetId) : '';
    const me = myNetId();
    const mine = target ? (!!me && target === String(me)) : true;
    if (!mine) return;
    if (phase === 'warn') sfxDedup('ambushSting', EMPTY, 0.8);
    else if (phase === 'start') sfx('razorFrenzy', { on: true });
    else sfx('razorFrenzy', { on: false });
  }

  // EVENT_PHASE 'stunned' = a head hit landed on one of the giants
  function onEventPhaseMsg(d) {
    if (!d || typeof d !== 'object') return;
    if (String(d.phase || '') !== 'stunned') return;
    if (!ensureContext(gestureSeen || started)) return;
    sfxDedup('eventStunned', EMPTY, 1.2);
  }

  // --- wave 5: doomsday -------------------------------------------------
  // TSUNAMI now means the run is ending one way or another. Music cuts through
  // the existing path, the horror layer hands the low end over to the quake
  // bed, and the bells toll. Everything lands on the same master compressor +
  // hard limiter as the rest of the mix, and the watchdog still owns the graph.
  function onDoomsday() {
    if (!ensureContext(gestureSeen || started)) return;
    const now = ac.currentTime;
    if (now - doomAt < 5) return;
    doomAt = now;
    cutMusic();
    channelStop(0.15);
    frenzyStop(0.5);          // nothing is nibbling now; the sea is arriving
    if (horrorNodes) stopHorror(1.2);
    quakeStart();
    sfxDedup('tsunamiRoar', EMPTY, 3);
    sfx('doomBell', { count: 3 });
  }

  function onPhase(p) {
    if (p === lastPhase) return;
    lastPhase = p;
    if (p === 'playing' || p === 'lobby' || p === 'menu') {
      if (!started && gestureSeen) startMusic();
      else if (started && musicState === 'stopped') resumeMusic(3.5);
      if (p !== 'playing') {
        eventActive = false;
        evStateSeen = false;
        motorStop();
        reelOn = false;
        channelStop(0.2);
        frenzyStop(0.4);
        quakeStop(0.8);
        doomAt = -99;
        if (horrorNodes) stopHorror(0.6);
      }
    } else if (p === 'over') {
      motorStop();
      reelOn = false;
      channelStop(0.2);
      frenzyStop(0.5);
      quakeStop(2.5);        // the ground settles as the end screen comes up
      if (horrorNodes) stopHorror(1.2);
      stopMusic(1.6);
    }
  }

  let netBound = false;
  function bindNet() {
    const net = ctx && ctx.net;
    if (netBound || !net || typeof net.on !== 'function') return;
    netBound = true;
    try {
      net.on(MSG.BITE, () => sfxDedup('bite', EMPTY, 0.4));
      net.on(MSG.CAST_RESULT, (d) => onCatch(d));
      net.on(MSG.QUOTA_DONE, () => sfxDedup('quotaDone', EMPTY, 1.0));
      net.on(MSG.TSUNAMI, () => onDoomsday());
      net.on(MSG.GAME_OVER, () => { frenzyStop(0.6); quakeStop(2.5); stopMusic(1.2); sfxDedup('gameOver', EMPTY, 3); });
      net.on(MSG.GAME_WON, () => { frenzyStop(0.6); quakeStop(1.0); stopMusic(1.0); sfxDedup('gameWon', EMPTY, 3); });
      net.on(MSG.REVIVED, (d) => onRevived(d));
      net.on(MSG.BODY_TOWED, (d) => onBodyTowed(d));
      net.on(MSG.EVENT_START, (d) => onEventStart(d && d.type));
      net.on(MSG.EVENT_END, () => onEventEnd());
      // wave 7: the ambush beats and the giants' daze
      net.on(MSG.AMBUSH, (d) => onAmbushMsg(d));
      net.on(MSG.EVENT_PHASE, (d) => onEventPhaseMsg(d));
      net.on(MSG.ENEMY_HIT, () => sfxDedup('enemyHurt', EMPTY, 0.08));
      net.on(MSG.SHOP_RESULT, (d) => onShop(d));
      net.on(MSG.WEATHER, (d) => { if (d && typeof d.type === 'string') setWeatherType(d.type); });
      net.on(MSG.LIGHTNING, (d) => onLightning(d));
      net.on(MSG.FLOPPER, (d) => onFlopper(d));
      net.on(MSG.LOOT_RESULT, (d) => onLootResult(d));
      net.on(MSG.WALLET, (d) => onWallet(d));
      net.on(MSG.PORTAL_STATE, (d) => onPortal(d));
      net.on(MSG.TSUNAMI_WARNING, (d) => sfxDedup('warning', d || EMPTY, 5));
      net.on(MSG.CHAT_MSG, () => sfxDedup('uiBlip', EMPTY, 0.15));
      net.on(MSG.PLAYER_DAMAGED, (d) => {
        // someone else took a hit — a quieter, further-off version
        const me = myNetId();
        if (!d || !d.id || (me && d.id === me)) return;
        sfxDedup('playerHurt', { volume: 0.4 }, 0.2);
      });
    } catch (e) { warn(e); }
  }

  // ------------------------------------------------------------------
  // player foley
  // ------------------------------------------------------------------
  // player.js animates the character but voices nothing except the odd splash,
  // so walking, jumping and swimming were silent. We watch its published local
  // state instead of asking it to change. Everything goes through sfxDedup, so
  // if player.js ever does start firing its own cues the two cannot double up.
  function surfaceUnder(loc) {
    if (loc.onDeck || loc.onBoat) return 'wood';
    const p = loc.pos;
    if (!p) return 'sand';
    const px = num(p.x, 0), pz = num(p.z, 0), py = num(p.y, 0);
    const w = ctx && ctx.world;
    let ground = 0;
    if (w && typeof w.getTerrainHeight === 'function') {
      try { ground = num(w.getTerrainHeight(px, pz), 0); } catch (e) { ground = 0; }
    }
    // wave 3: surfaceHeight includes dock decking and steps — standing on
    // planking above the sand should sound like planking
    if (w && typeof w.surfaceHeight === 'function') {
      let deck = ground;
      try { deck = num(w.surfaceHeight(px, pz), ground); } catch (e) { deck = ground; }
      if (deck - ground > 0.3) return 'wood';
    }
    let sea = 0;
    if (typeof ctx.getWaterHeight === 'function') {
      try { sea = num(ctx.getWaterHeight(px, pz, foley.clock), 0); } catch (e) { sea = 0; }
    }
    if (py < sea + 0.45) return 'water';
    return ground > 3.2 ? 'grass' : 'sand';
  }

  function playerFoley(dt) {
    const st = ctx && ctx.state;
    if (!st || st.phase !== 'playing') { foley.seen = false; return; }
    const pm = ctx.playerMod;
    const loc = pm && pm.local;
    if (!loc || !loc.pos) return;
    if (loc.ko) { foley.stepTimer = 0.2; return; }

    const under = !!loc.underwater;
    const swimming = !!loc.swimming;
    // wave 3: standing on a boat deck is standing on something, even if
    // player.js models it as boat-local anchoring rather than "grounded"
    const onDeck = !!loc.onDeck;
    const grounded = !!loc.grounded || onDeck;
    const speed = cl(loc.speed, 0, 40, 0);

    if (!foley.seen) {                 // first frame in a run: adopt, do not announce
      foley.seen = true;
      foley.grounded = grounded;
      foley.swimming = swimming;
      foley.wasUnder = under;
      foley.airborne = 0;
      return;
    }

    if (under !== foley.wasUnder) {
      foley.wasUnder = under;          // setUnderwater() voices the transition itself
      foley.bubbleTimer = under ? 1.0 : 0;
    }

    if (grounded !== foley.grounded) {
      if (!grounded) {
        const vy = loc.vel ? num(loc.vel.y, 0) : 0;
        if (vy > 1.2 && !swimming) sfxDedup('jump', { volume: 0.7 }, 0.2);
        foley.airborne = 0;
      } else if (foley.airborne > 0.18 && !swimming) {
        sfxDedup('jumpThud', { volume: clamp(0.45 + foley.airborne * 0.45, 0.45, 1) }, 0.15);
        foley.stepTimer = 0.25;
      }
      foley.grounded = grounded;
    }
    if (!grounded) foley.airborne += dt;

    if (swimming !== foley.swimming) {
      foley.swimming = swimming;
      sfxDedup('splash', { volume: swimming ? 0.6 : 0.4 }, 0.25);
      foley.strokeTimer = swimming ? 0.55 : 0;
    }

    if (swimming) {
      foley.stepTimer = 0;
      foley.strokeTimer -= dt;
      if (under) {
        foley.bubbleTimer -= dt;
        if (foley.bubbleTimer <= 0) {
          foley.bubbleTimer = 1.1 + Math.random() * 1.7;
          sfx('bubble', { volume: 0.7 });
        }
        if (speed > 0.6 && foley.strokeTimer <= 0) {
          foley.strokeTimer = 1.15;
          sfxDedup('swimStroke', { volume: 0.32, size: 1.4 }, 0.4);
        }
      } else if (foley.strokeTimer <= 0) {
        foley.strokeTimer = speed > 0.6 ? clamp(0.74 - speed * 0.03, 0.5, 0.74) : 1.9;
        sfxDedup('swimStroke', { volume: speed > 0.6 ? 0.6 : 0.24 }, 0.25);
      }
      return;
    }

    // ---- footsteps ----
    // Driven off the animation, not raw speed: standing on a moving deck
    // reports plenty of speed and must not produce a walk cycle.
    const anim = typeof loc.anim === 'string' ? loc.anim : '';
    const seated = anim === 'sit' || anim === 'drive' || cl(loc.seat, -1, 8, -1) >= 0;
    const running = anim === 'run';
    const moving = !seated && grounded && (running || anim === 'walk' || (anim === '' && speed > 1.4));
    if (!moving) { if (foley.stepTimer > 0.12) foley.stepTimer = 0.12; return; }
    foley.stepTimer -= dt;
    if (foley.stepTimer > 0) return;
    foley.stepTimer = running
      ? clamp(0.44 - speed * 0.02, 0.26, 0.44)
      : clamp(0.64 - speed * 0.03, 0.38, 0.64);
    sfxDedup('footstep', {
      surface: surfaceUnder(loc),
      volume: clamp(0.38 + speed * 0.05, 0.38, 0.9),
    }, 0.1);
  }

  // ------------------------------------------------------------------
  // frame update
  // ------------------------------------------------------------------
  function update(dt, t) {
    if (!netBound) bindNet();
    dt = cl(dt, 0, 0.25, 0.016);
    foley.clock = num(t, foley.clock || 0);
    if (!ac) return;
    if (ac.state === 'closed') return;
    if (!built) {
      // a rebuild failed mid-flight; try again once the cooldown is up
      if (started && !rebuilding && !failed) rebuildGraph('unbuilt');
      return;
    }
    const now = ac.currentTime;

    // --- poison check: sound must never be able to stay dead ---
    watchdogTick(dt);
    if (!built) return;

    reapVoices(now);

    // --- day/night blend ---
    const st = ctx && ctx.state ? ctx.state : null;
    const tod = cl(st && st.timeOfDay, 0, 1, 0.35);
    const target = cl(nightnessOf(tod), 0, 1, 0);
    nightAmt = cl(nightAmt + (target - nightAmt) * Math.min(1, dt * 0.6), 0, 1, 0);
    if (st && st.gear && !lastGear.seen) onGear(st.gear);   // adopt, do not announce

    // --- state polling safety nets ---
    if (st) {
      if (typeof st.underwater === 'boolean' && st.underwater !== underwater) setUnderwater(st.underwater);
      const evNow = !!st.eventActive;
      // the 3 s gate keeps a stale state flag from re-cutting the music right
      // after an eventEnd we already handled through the bus
      if (evNow && !eventActive && now - eventEndAt > 3) { evStateSeen = true; onEventStart(st.eventActive); }
      else if (evNow && eventActive) evStateSeen = true;
      else if (!evNow && eventActive && evStateSeen) onEventEnd();
    }

    // --- music transport state machine ---
    if (musicState === 'silence') {
      if (eventActive && now - cutAt > 2.5) { startHorror(); musicState = 'horror'; }
      else if (!eventActive && now - cutAt > 12) resumeMusic(3.5);
    } else if (musicState === 'horror') {
      if (now >= nextHeart) {
        const ht = Math.max(now + 0.01, nextHeart);
        heartThump(ht, 0.3, horrorBus);
        heartThump(ht + 0.22, 0.21, horrorBus);
        nextHeart = now + 1.32 + Math.random() * 0.22;
      }
      if (now >= nextScrape) {
        scrapeStinger(now + 0.02);
        nextScrape = now + 13 + Math.random() * 13;
      }
      if (now - horrorAt > 260) onEventEnd();     // safety: never haunt forever
    } else if (musicState === 'quiet') {
      if (now >= resumeAt) resumeMusic(4.5);
    }

    // --- music scheduling ---
    if (schedulerOn) scheduleAhead();

    // --- slow parameter automation (not every frame) ---
    paramTimer -= dt || 0.016;
    if (paramTimer <= 0) {
      paramTimer = 0.35;
      musicParams(now);
    }

    // --- boat motor: driven from state unless a module calls motorLoop itself ---
    if (motorAuto) {
      if (st && st.onBoat && st.phase !== 'over') {
        let th = 0.28;
        const b = ctx.boat;
        if (b && b.velocity && typeof b.velocity.length === 'function') {
          const sp = b.velocity.length();
          if (isFinite(sp)) th = clamp(sp / 14, 0.12, 1);
        }
        motorStart();
        if (motor) {
          const nt = motor.throttle + (th - motor.throttle) * 0.12;
          if (Math.abs(nt - motor.throttle) > 0.004) motorDirty = true;
          motor.throttle = nt;
        }
      } else if (motor) {
        motorStop();
      }
    }

    // --- boat motor params (rate limited) ---
    if (motor) {
      motorTimer -= dt || 0.016;
      if (motorDirty && motorTimer <= 0) {
        motorTimer = 0.08;
        motorDirty = false;
        motorApply(0.12);
      }
    }

    // --- wave 5 loops: neither may ever get stuck on ---
    if (chanNodes) {
      // the emitter re-sends progress continuously; silence means it ended
      if (chanSeen && now - chanSeen > 0.45) { channelStop(0.3); chanSeen = 0; }
      else if (now - chanAt > 12) channelStop(0.3);     // absolute backstop
    }
    if (quakeNodes && now - quakeAt > 90) quakeStop(2.5);

    // --- wave 7: the swarm keeps taking passes at you while it lasts ---
    if (frenzyNodes) {
      if (now >= nextChomp) {
        chomp(now + 0.02);
        nextChomp = now + 0.16 + Math.random() * 0.3;
      }
      // the server owns the window; this is only the "we lost the end" net
      if (now - frenzyAt > FRENZY_MAX) frenzyStop(1.2);
    }

    // --- reel ticks (reelHold > 0 means the caller re-arms it every frame) ---
    if (reelOn && reelHold > 0 && now > reelHold) { reelOn = false; reelHold = 0; }
    if (reelOn) {
      if (nextReelTick < now) nextReelTick = now + 0.01;
      const rate = 0.052 - reelTension * 0.024;
      const vel = (0.6 + reelTension * 0.5) * (reelHold > 0 ? reelVol : 1);
      let guard = 0;
      while (nextReelTick < now + LOOKAHEAD && guard++ < 12) {
        reelTick(nextReelTick, vel);
        nextReelTick += rate + Math.random() * 0.014;
      }
      // the line complains when it is close to snapping
      if (reelTension > 0.55 && now >= nextCreak) {
        nextCreak = now + 0.4 + Math.random() * 0.35;
        tone('sawtooth', 130 + reelTension * 90, now + 0.02, 0.45, 0.05 * reelTension,
          sfxBus, { f1: 190 + reelTension * 130, glide: 0.4, filter: 'bandpass', ff0: 780, fq: 8, atk: 0.06 });
      }
    }

    // --- ambient wildlife ---
    const step = dt || 0.016;
    nextGull -= step;
    if (nextGull <= 0) {
      nextGull = 7 + Math.random() * 13;
      if (nightAmt < 0.4 && musicState !== 'horror' && musicState !== 'silence' && !underwater && wxType !== 'storm') {
        gullCall(now + 0.05, (Math.random() - 0.5) * 1.7);   // nothing is flying in a storm
      }
    }
    nextCricket -= step;
    if (nextCricket <= 0) {
      nextCricket = 3 + Math.random() * 6;
      if (nightAmt > 0.55 && musicState !== 'horror' && musicState !== 'silence' && !underwater) {
        cricketCall(now + 0.05, (Math.random() - 0.5) * 1.6);
      }
    }

    if (pendingThunder.length) drainThunder(now);

    // --- weather bed (crossfades itself; only touches params when it must) ---
    const wNow = (st && st.world && st.world.weather && typeof st.world.weather.type === 'string')
      ? st.world.weather.type : null;
    if (wNow && wNow !== wxType) setWeatherType(wNow);
    else applyWeatherBed(false);
    if (wxType === 'fog') {
      nextFogTone -= step;
      if (nextFogTone <= 0) {
        nextFogTone = 11 + Math.random() * 14;
        if (musicState !== 'horror' && !underwater) fogTone(now + 0.05);
      }
    } else if (nextFogTone < 6) {
      nextFogTone = 6 + Math.random() * 6;
    }

    // --- footsteps, jumps, strokes, bubbles ---
    playerFoley(dt);
  }

  return {
    update,
    cutMusic,
    sfx,
    setUnderwater,
    startMusic,
    setVolume,
    getVolume() { return userVol; },
  };
}
