// =============================================================
// TIDEWRECK ISLAND - audio.js
// Everything you hear is synthesized at runtime with WebAudio.
// No audio files, no samples, no external anything.
//
//   masterIn -> uwFilter (underwater lowpass) -> limiter -> destination
//     musicBus  (pad, plucks, marimba, bass, shaker)   <- cut by cutMusic()
//     sfxBus    (all one-shots)
//     ambBus    (ocean, gulls, crickets, sub drone)    <- never cut
//     horrorBus (drone, heartbeat, scrapes)
//     revOut    (feedback-delay "reverb" send)
//
// export: initAudio(ctx) -> { update, cutMusic, sfx, setUnderwater, startMusic, setVolume }
// =============================================================

import { ECON, MSG } from '/shared/constants.js';

// ---------------- musical constants ----------------
const TEMPO = 90;
const SPB = 60 / TEMPO;            // seconds per beat
const STEP = SPB / 4;              // one 16th note
const BAR_STEPS = 16;
const PHRASE_STEPS = 128;          // 8 bars
const LOOKAHEAD = 0.16;            // scheduler horizon in seconds
const MAX_VOICES = 64;             // hard polyphony cap

const MUSIC_LEVEL = 0.62;
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

const DAY_PLUCK_STEPS = [0, 3, 6, 8, 11, 14];
const NIGHT_PLUCK_STEPS = [0, 6, 12];
const MELODY_SLOTS = [0, 4, 8, 12, 2, 6, 10, 14, 3, 7, 11];

const EMPTY = Object.freeze({});

function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function smoothstep(a, b, x) { const t = clamp((x - a) / (b - a || 1e-6), 0, 1); return t * t * (3 - 2 * t); }
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

  let masterIn = null, uwFilter = null, limiter = null;
  let musicBus = null, sfxBus = null, ambBus = null, horrorBus = null;
  let revS = null, revM = null, revL = null, revOut = null, revIn = null;
  let whiteBuf = null, brownBuf = null, distCurve = null, softCurve = null;

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

  // horror
  let horrorNodes = null;
  let cutAt = 0, horrorAt = 0, resumeAt = 0, eventEndAt = -99;
  let eventActive = false, evStateSeen = false;

  // misc runtime
  let userVol = 0.8;
  let underwater = false;
  let reelOn = false, nextReelTick = 0, reelHold = 0, reelTension = 0.4, reelVol = 0.6, nextCreak = 0;
  let motor = null, motorDirty = false, motorTimer = 0, motorAuto = true;
  // per-call sfx modifiers, set by sfx() from opts (volume/vol/gain and pos)
  let curScale = 1, curPan = 0;
  let started = false;
  let lastPhase = '';
  const lastFired = Object.create(null);

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

  function gainNode(v) { const g = ac.createGain(); g.gain.value = v; return g; }

  function buildGraph() {
    if (built) return;
    built = true;

    whiteBuf = makeNoise(2, false);
    brownBuf = makeNoise(5, true);
    distCurve = makeCurve(14);
    softCurve = makeCurve(2.2);

    limiter = ac.createDynamicsCompressor();
    limiter.threshold.value = -9;
    limiter.knee.value = 8;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.004;
    limiter.release.value = 0.22;
    limiter.connect(ac.destination);

    uwFilter = ac.createBiquadFilter();
    uwFilter.type = 'lowpass';
    uwFilter.frequency.value = 20000;
    uwFilter.Q.value = 0.7;
    uwFilter.connect(limiter);

    masterIn = gainNode(Math.pow(userVol, 1.35));
    masterIn.connect(uwFilter);

    musicBus = gainNode(0.0001);
    sfxBus = gainNode(SFX_LEVEL);
    ambBus = gainNode(0.0001);
    horrorBus = gainNode(0.0001);
    musicBus.connect(masterIn);
    sfxBus.connect(masterIn);
    ambBus.connect(masterIn);
    horrorBus.connect(masterIn);

    // ---- feedback-delay "reverb" ----
    revOut = gainNode(0.55);
    revOut.connect(masterIn);
    revIn = gainNode(1);
    buildRevTap(0.113, 0.52, 2600, -0.4);
    buildRevTap(0.179, 0.47, 2000, 0.4);
    revS = gainNode(0.10); revS.connect(revIn);
    revM = gainNode(0.28); revM.connect(revIn);
    revL = gainNode(0.62); revL.connect(revIn);

    buildPad();
    buildAmbience();
  }

  function buildRevTap(time, fb, lp, pan) {
    const d = ac.createDelay(0.5);
    d.delayTime.value = time;
    const f = ac.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = lp;
    const g = gainNode(fb);
    const p = ac.createStereoPanner ? ac.createStereoPanner() : null;
    revIn.connect(d);
    d.connect(f); f.connect(g); g.connect(d);
    if (p) { p.pan.value = pan; d.connect(p); p.connect(revOut); }
    else d.connect(revOut);
  }

  // ---- soft pad: three detuned saw pairs through a breathing lowpass ----
  function buildPad() {
    padOut = gainNode(0.0001);
    padOut.connect(musicBus);
    padOut.connect(revM);

    padFilter = ac.createBiquadFilter();
    padFilter.type = 'lowpass';
    padFilter.frequency.value = 900;
    padFilter.Q.value = 0.9;
    padFilter.connect(padOut);

    padVoices = [];
    padDetunes = [];
    const base = [currentChord.r, currentChord.r + 7, currentChord.r + 16];
    for (let i = 0; i < 3; i++) {
      const vg = gainNode(i === 0 ? 0.10 : 0.075);
      vg.connect(padFilter);
      const pair = [];
      for (let k = 0; k < 2; k++) {
        const o = ac.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = mtof(base[i]);
        o.detune.value = (k === 0 ? -1 : 1) * (5 + i * 3);
        o.connect(vg);
        o.start();
        pair.push(o);
        padDetunes.push({ p: o.detune, base: o.detune.value });
      }
      padVoices.push(pair);
    }

    // slow filter sweep + gentle tremolo so the pad never sits still
    const lfoF = ac.createOscillator(); lfoF.type = 'sine'; lfoF.frequency.value = 0.055;
    const lfoFg = gainNode(300); lfoF.connect(lfoFg); lfoFg.connect(padFilter.frequency); lfoF.start();
    const lfoA = ac.createOscillator(); lfoA.type = 'sine'; lfoA.frequency.value = 0.083;
    const lfoAg = gainNode(0.05); lfoA.connect(lfoAg); lfoAg.connect(padOut.gain); lfoA.start();
  }

  // ---- ocean ambience: brown-noise swells + surf hiss + underwater sub ----
  function buildAmbience() {
    const src = ac.createBufferSource();
    src.buffer = brownBuf; src.loop = true; src.playbackRate.value = 0.85;
    waveFilter = ac.createBiquadFilter();
    waveFilter.type = 'lowpass'; waveFilter.frequency.value = 420; waveFilter.Q.value = 0.8;
    waveGain = gainNode(0.32);
    src.connect(waveFilter); waveFilter.connect(waveGain); waveGain.connect(ambBus);
    waveGain.connect(revS);
    src.start(0);

    const l1 = ac.createOscillator(); l1.type = 'sine'; l1.frequency.value = 0.061;
    const l1g = gainNode(0.2); l1.connect(l1g); l1g.connect(waveGain.gain); l1.start();
    const l2 = ac.createOscillator(); l2.type = 'sine'; l2.frequency.value = 0.037;
    const l2g = gainNode(240); l2.connect(l2g); l2g.connect(waveFilter.frequency); l2.start();

    const s2 = ac.createBufferSource();
    s2.buffer = whiteBuf; s2.loop = true;
    const sf = ac.createBiquadFilter();
    sf.type = 'bandpass'; sf.frequency.value = 2400; sf.Q.value = 0.6;
    surfGain = gainNode(0.035);
    s2.connect(sf); sf.connect(surfGain); surfGain.connect(ambBus);
    s2.start(0);
    const l3 = ac.createOscillator(); l3.type = 'sine'; l3.frequency.value = 0.089;
    const l3g = gainNode(0.022); l3.connect(l3g); l3g.connect(surfGain.gain); l3.start();

    // underwater sub drone (silent until submerged)
    subGain = gainNode(0.0001);
    subGain.connect(ambBus);
    const sub1 = ac.createOscillator(); sub1.type = 'sine'; sub1.frequency.value = 42;
    const sub2 = ac.createOscillator(); sub2.type = 'sine'; sub2.frequency.value = 44.7;
    const sg = gainNode(0.5);
    sub1.connect(sg); sub2.connect(sg); sg.connect(subGain);
    sub1.start(); sub2.start();
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
    if (!ac || full(o && o.prio)) return null;
    o = o || EMPTY;
    const osc = ac.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(0.01, f0), t);
    if (o.f1 !== undefined) {
      const gt = t + (o.glide !== undefined ? o.glide : dur);
      if (o.lin) osc.frequency.linearRampToValueAtTime(Math.max(0.01, o.f1), gt);
      else osc.frequency.exponentialRampToValueAtTime(Math.max(0.01, o.f1), gt);
    }
    if (o.detune) osc.detune.value = o.detune;
    const g = ac.createGain();
    const atk = o.atk !== undefined ? o.atk : 0.006;
    const peak = Math.max(0.0004, g0 * curScale);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + atk);
    if (o.hold) {
      g.gain.setValueAtTime(peak, t + Math.max(atk, o.hold));
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    } else {
      g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(atk + 0.02, dur));
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
      f.frequency.setValueAtTime(Math.max(20, o.ff0 || 1200), t);
      if (o.ff1) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.ff1), t + (o.fsweep || dur));
      f.Q.value = o.fq || 1;
      out.connect(f); out = f; chain.push(f);
    }
    const pv = (o.pan !== undefined ? o.pan : 0) + curPan;
    if (pv !== 0 && ac.createStereoPanner) {
      const p = ac.createStereoPanner();
      p.pan.value = clamp(pv, -1, 1);
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
    if (!ac || full(o && o.prio)) return null;
    o = o || EMPTY;
    const src = ac.createBufferSource();
    src.buffer = o.brown ? brownBuf : whiteBuf;
    src.loop = true;
    src.playbackRate.value = o.rate || 1;
    const chain = [src];
    let out = src;
    if (o.type) {
      const f = ac.createBiquadFilter();
      f.type = o.type;
      f.frequency.setValueAtTime(Math.max(20, o.f0 || 1000), t);
      if (o.f1) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t + (o.sweep || dur));
      f.Q.value = o.Q || 1;
      src.connect(f); out = f; chain.push(f);
    }
    const g = ac.createGain();
    const atk = o.atk !== undefined ? o.atk : 0.004;
    const peak = Math.max(0.0004, g0 * curScale);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + atk);
    if (o.hold) {
      g.gain.setValueAtTime(peak, t + Math.max(atk, o.hold));
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    } else {
      g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(atk + 0.02, dur));
    }
    out.connect(g);
    chain.push(g);
    let tail = g;
    const pv = (o.pan !== undefined ? o.pan : 0) + curPan;
    if (pv !== 0 && ac.createStereoPanner) {
      const p = ac.createStereoPanner();
      p.pan.value = clamp(pv, -1, 1);
      g.connect(p); tail = p; chain.push(p);
    }
    tail.connect(dest || sfxBus);
    if (o.rev) tail.connect(o.rev);
    src.start(t, Math.random() * 1.2);
    src.stop(t + dur + 0.06);
    reg(t + dur + 0.12, chain);
    return g;
  }

  // Karplus-Strong pluck: noise burst into a damped feedback delay
  function pluck(t, freq, g0, dest, panv) {
    if (!ac || full()) return;
    const dt = 1 / freq;
    const decay = 1.1 + Math.min(0.9, 220 / freq);
    const fb = clamp(Math.exp(-dt / decay), 0.5, 0.999);

    const src = ac.createBufferSource();
    src.buffer = whiteBuf; src.loop = true;
    const burst = ac.createGain();
    burst.gain.setValueAtTime(0.9, t);
    burst.gain.setValueAtTime(0.0001, t + Math.max(0.003, dt * 2.5));

    const d = ac.createDelay(0.06);
    d.delayTime.value = Math.min(0.059, dt);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = clamp(freq * 7, 1400, 5200); lp.Q.value = 0.4;
    const fbg = gainNode(fb);
    const out = ac.createGain();
    out.gain.setValueAtTime(Math.max(0.0005, g0), t);
    out.gain.exponentialRampToValueAtTime(0.0001, t + decay * 1.8);

    src.connect(burst); burst.connect(d);
    d.connect(lp); lp.connect(fbg); fbg.connect(d);
    d.connect(out);
    let tail = out;
    if (panv !== undefined && ac.createStereoPanner) {
      const p = ac.createStereoPanner(); p.pan.value = clamp(panv, -1, 1);
      out.connect(p); tail = p;
    }
    tail.connect(dest || musicBus);
    tail.connect(revS);
    src.start(t, Math.random());
    src.stop(t + 0.05);
    reg(t + decay * 1.9, [src, burst, d, lp, fbg, out, tail]);
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
    if (!ac || full()) return;
    const src = ac.createBufferSource();
    src.buffer = brownBuf; src.loop = true; src.playbackRate.value = 0.7;
    const f = ac.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(280, t);
    f.frequency.linearRampToValueAtTime(900, t + dur * 0.45);
    f.frequency.linearRampToValueAtTime(240, t + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(g0, t + dur * 0.45);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g);
    let tail = g;
    if (panv !== undefined && ac.createStereoPanner) {
      const p = ac.createStereoPanner(); p.pan.value = clamp(panv, -1, 1);
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
    const density = night ? 6 : 12;
    for (let i = 0; i < density; i++) {
      const bar = Math.floor(rng() * 8);
      const slot = MELODY_SLOTS[Math.floor(rng() * (night ? 4 : MELODY_SLOTS.length))];
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
      const f = mtof(targets[i]);
      padVoices[i][0].frequency.setTargetAtTime(f, t, 0.1);
      padVoices[i][1].frequency.setTargetAtTime(f, t, 0.1);
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

    if (gs % PHRASE_STEPS === 0) regenMelody();

    if (s === 0) {
      setChord((night ? NIGHT_PROG : DAY_PROG)[chordIdx], t);
      // soft sub bass on the downbeat
      tone('sine', mtof(currentChord.r - 12), t, night ? 2.2 : 1.5, night ? 0.16 : 0.2, musicBus, { atk: 0.03 });
      if (!night && bar % 2 === 1) {
        tone('sine', mtof(currentChord.r - 12), t + SPB * 2, 1.1, 0.13, musicBus, { atk: 0.03 });
      }
      if (nAmt > 0.35 && bar % 4 === 0) swell(t, 5.2, 0.14 * nAmt, (Math.random() - 0.5) * 1.2);
    }

    // ---- plucks (the island theme's heartbeat) ----
    const pSteps = night ? NIGHT_PLUCK_STEPS : DAY_PLUCK_STEPS;
    for (let i = 0; i < pSteps.length; i++) {
      if (pSteps[i] !== s) continue;
      const layer = night ? nAmt : dAmt;
      if (layer < 0.08) break;
      const idx = tones[arpCursor % tones.length] + (arpCursor % 7 === 6 ? 5 : 0);
      arpCursor++;
      const f = mtof(scaleMidi(scale, idx));
      const accent = (s === 0 || s === 8) ? 1.0 : 0.72;
      pluck(t, f, 0.19 * accent * layer * (0.85 + Math.random() * 0.3), musicBus, (Math.random() - 0.5) * 0.7);
      // a soft octave shadow on the downbeat keeps it lush
      if (s === 0 && !night) pluck(t + 0.012, f * 2, 0.06 * layer, musicBus, 0.3);
      break;
    }

    // ---- marimba melody ----
    const mv = melody[gs % PHRASE_STEPS];
    if (mv > 0) {
      const layer = night ? nAmt : dAmt;
      if (layer > 0.1) {
        const idx = tones[(mv - 1) % tones.length] + 5;
        marimba(t, mtof(scaleMidi(scale, idx)), 0.16 * layer * (night ? 0.8 : 1), musicBus);
      }
    }

    // ---- shaker ----
    if (!night && dAmt > 0.15) {
      if (s % 2 === 1) shaker(t, (s % 4 === 3 ? 0.075 : 0.042) * dAmt);
    } else if (nAmt > 0.15 && (s === 4 || s === 12)) {
      shaker(t, 0.03 * nAmt);
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
    if (!padOut) return;
    const nA = nightAmt;
    padOut.gain.setTargetAtTime(0.30 + nA * 0.16, t, 0.6);
    padFilter.frequency.setTargetAtTime(1150 - nA * 460, t, 0.8);
    padFilter.Q.setTargetAtTime(0.9 + nA * 0.8, t, 0.8);
    if (waveGain) waveGain.gain.setTargetAtTime(0.30 + nA * 0.06 + (underwater ? 0.08 : 0), t, 1.2);
    if (surfGain) surfGain.gain.setTargetAtTime(underwater ? 0.008 : 0.033 - nA * 0.01, t, 1.2);
  }

  // ------------------------------------------------------------------
  // music transport
  // ------------------------------------------------------------------
  function fadeBus(bus, to, dur) {
    if (!bus || !ac) return;
    const t = ac.currentTime;
    const cur = Math.max(0.0001, bus.gain.value);
    bus.gain.cancelScheduledValues(t);
    bus.gain.setValueAtTime(cur, t);
    bus.gain.exponentialRampToValueAtTime(Math.max(0.0001, to), t + Math.max(0.01, dur));
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
    if (!ac) { musicState = 'silence'; cutAt = 0; return; }
    const t = ac.currentTime;
    musicBus.gain.cancelScheduledValues(t);
    musicBus.gain.setValueAtTime(Math.max(0.0001, musicBus.gain.value), t);
    musicBus.gain.linearRampToValueAtTime(0.0001, t + 0.022);   // the silence IS the scare
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
    if (!ac || horrorNodes) return;
    const t = ac.currentTime;
    const nodes = {};
    const mix = gainNode(1);
    mix.connect(horrorBus);

    // two detuned sub sines with a slow amplitude LFO
    const dGain = gainNode(0.34);
    dGain.connect(mix);
    const o1 = ac.createOscillator(); o1.type = 'sine'; o1.frequency.value = 34.6;
    const o2 = ac.createOscillator(); o2.type = 'sine'; o2.frequency.value = 36.3;
    const o3 = ac.createOscillator(); o3.type = 'triangle'; o3.frequency.value = 69.4;
    const o3g = gainNode(0.14); o3.connect(o3g); o3g.connect(dGain);
    o1.connect(dGain); o2.connect(dGain);
    const lfo = ac.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.11;
    const lfog = gainNode(0.16); lfo.connect(lfog); lfog.connect(dGain.gain);
    o1.start(); o2.start(); o3.start(); lfo.start();

    // a breath of pressure under everything
    const bs = ac.createBufferSource();
    bs.buffer = brownBuf; bs.loop = true; bs.playbackRate.value = 0.6;
    const bf = ac.createBiquadFilter(); bf.type = 'bandpass'; bf.frequency.value = 190; bf.Q.value = 1.4;
    const bg = gainNode(0.16);
    bs.connect(bf); bf.connect(bg); bg.connect(mix);
    const blfo = ac.createOscillator(); blfo.type = 'sine'; blfo.frequency.value = 0.073;
    const blfog = gainNode(0.1); blfo.connect(blfog); blfog.connect(bg.gain);
    bs.start(0); blfo.start();

    nodes.list = [mix, dGain, o1, o2, o3, o3g, lfo, lfog, bs, bf, bg, blfo, blfog];
    nodes.osc = [o1, o2, o3, lfo, blfo];
    nodes.src = [bs];
    horrorNodes = nodes;

    horrorBus.gain.cancelScheduledValues(t);
    horrorBus.gain.setValueAtTime(0.0001, t);
    horrorBus.gain.exponentialRampToValueAtTime(HORROR_LEVEL, t + 3.5);
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
    if (!ac || full()) return;
    const car = ac.createOscillator();
    car.type = 'sine';
    car.frequency.setValueAtTime(760, t);
    car.frequency.exponentialRampToValueAtTime(1520, t + 0.07);
    car.frequency.exponentialRampToValueAtTime(640, t + 0.3);
    const mod = ac.createOscillator();
    mod.type = 'sine';
    mod.frequency.value = 140 + Math.random() * 60;
    const modG = ac.createGain();
    modG.gain.setValueAtTime(460, t);
    modG.gain.exponentialRampToValueAtTime(50, t + 0.3);
    mod.connect(modG);
    modG.connect(car.frequency);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0005, g0), t + 0.025);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    car.connect(g);
    let tail = g;
    if (ac.createStereoPanner) {
      const p = ac.createStereoPanner();
      p.pan.value = clamp(panv, -1, 1);
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
      const th = clamp(o.throttle !== undefined ? o.throttle : 0.5, 0, 1);
      if (Math.abs(th - motor.throttle) > 0.01) motorDirty = true;
      motor.throttle = th;
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
        const lfo = ac.createOscillator(); lfo.type = 'sine'; lfo.frequency.setValueAtTime(26, t);
        lfo.frequency.exponentialRampToValueAtTime(14, t + 2.2);
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
      const dur = o.duration || 9;
      if (!ac) return;
      const src = ac.createBufferSource();
      src.buffer = brownBuf; src.loop = true; src.playbackRate.value = 0.9;
      const f = ac.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(140, t);
      f.frequency.exponentialRampToValueAtTime(3200, t + dur * 0.7);
      f.Q.value = 1.1;
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.75, t + dur * 0.62);
      g.gain.setValueAtTime(0.75, t + dur * 0.85);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 2.5);
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
          const lfo = ac.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.7 + i * 0.31;
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
  };
  // alias used by shops / wallets
  SFX.sellFish = SFX.sell;
  SFX.buyItem = SFX.buy;
  SFX.tsunami = SFX.tsunamiRoar;

  let tickCount = 0;
  function reelTick(t, vel) {
    noise(t, 0.02, 0.09 * vel, sfxBus, { type: 'bandpass', f0: 2600 + Math.random() * 900, Q: 12, atk: 0.001 });
    // accent every third tick instead of doubling every tick - same ratchet, half the nodes
    if ((tickCount++ % 3) === 0) {
      tone('square', 1800 + Math.random() * 500, t, 0.012, 0.05 * vel, sfxBus, { atk: 0.001, filter: 'highpass', ff0: 900 });
    }
  }

  function duckAmbience(level, dur) {
    if (!ac || !ambBus || ambBus.gain.value < 0.02) return;
    const t = ac.currentTime;
    ambBus.gain.cancelScheduledValues(t);
    ambBus.gain.setValueAtTime(Math.max(0.0001, ambBus.gain.value), t);
    ambBus.gain.exponentialRampToValueAtTime(Math.max(0.0001, AMB_LEVEL * level), t + 0.3);
    ambBus.gain.setValueAtTime(Math.max(0.0001, AMB_LEVEL * level), t + dur);
    ambBus.gain.exponentialRampToValueAtTime(AMB_LEVEL * (musicState === 'silence' || musicState === 'horror' ? 0.55 : 1), t + dur + 2.5);
  }

  // ---- motor ----
  function motorStart() {
    if (!ac || motor) return;
    const t = ac.currentTime;
    const out = gainNode(0.0001);
    out.connect(sfxBus);
    const amp = gainNode(0.2);
    amp.connect(out);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = 3.5;
    lp.connect(amp);
    const saw = ac.createOscillator(); saw.type = 'sawtooth'; saw.frequency.value = 62;
    const sawG = gainNode(0.5); saw.connect(sawG); sawG.connect(lp);
    const sq = ac.createOscillator(); sq.type = 'square'; sq.frequency.value = 31;
    const sqG = gainNode(0.24); sq.connect(sqG); sqG.connect(lp);
    const ns = ac.createBufferSource(); ns.buffer = brownBuf; ns.loop = true;
    const nf = ac.createBiquadFilter(); nf.type = 'lowpass'; nf.frequency.value = 500;
    const nG = gainNode(0.16); ns.connect(nf); nf.connect(nG); nG.connect(amp);
    // putt-putt gate
    const putt = ac.createOscillator(); putt.type = 'sawtooth'; putt.frequency.value = 7;
    const puttG = gainNode(0.16); putt.connect(puttG); puttG.connect(amp.gain);
    saw.start(t); sq.start(t); ns.start(0); putt.start(t);
    out.gain.exponentialRampToValueAtTime(0.22, t + 0.25);
    motor = { out, amp, lp, saw, sq, ns, nf, nG, putt, puttG, sawG, sqG, throttle: 0.4 };
    motorDirty = true;
    motorTimer = 0;
  }
  function motorApply(smooth) {
    if (!motor || !ac) return;
    const t = ac.currentTime;
    const th = motor.throttle;
    motor.saw.frequency.setTargetAtTime(52 + th * 78, t, smooth);
    motor.sq.frequency.setTargetAtTime(26 + th * 39, t, smooth);
    motor.lp.frequency.setTargetAtTime(300 + th * 1100, t, smooth);
    motor.putt.frequency.setTargetAtTime(6 + th * 13, t, smooth);
    motor.nG.gain.setTargetAtTime(0.1 + th * 0.16, t, smooth);
    motor.out.gain.setTargetAtTime(0.15 + th * 0.16, t, smooth);
  }
  function motorStop() {
    if (!motor || !ac) return;
    const t = ac.currentTime;
    const m = motor;
    motor = null;
    m.out.gain.cancelScheduledValues(t);
    m.out.gain.setValueAtTime(Math.max(0.0001, m.out.gain.value), t);
    m.out.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    const stopAt = t + 0.55;
    try { m.saw.stop(stopAt); m.sq.stop(stopAt); m.ns.stop(stopAt); m.putt.stop(stopAt); } catch (e) { /* noop */ }
    reg(stopAt + 0.1, [m.out, m.amp, m.lp, m.saw, m.sq, m.ns, m.nf, m.nG, m.putt, m.puttG, m.sawG, m.sqG]);
  }

  // ------------------------------------------------------------------
  // public sfx entry
  // ------------------------------------------------------------------
  // callers across the codebase pass loudness as {volume}, {vol} or {gain}, and
  // some pass a world {pos:[x,y,z]} - honour all of them for every sound
  function applyOpts(o) {
    curScale = 1;
    curPan = 0;
    let v = o.volume;
    if (typeof v !== 'number') v = o.vol;
    if (typeof v !== 'number') v = o.gain;
    if (typeof v === 'number' && isFinite(v)) curScale = clamp(v, 0, 4);
    const pos = o.pos;
    if (!pos || pos.length < 3) return;
    const cam = ctx && ctx.camera;
    const e = cam && cam.matrixWorld ? cam.matrixWorld.elements : null;
    if (!e) return;
    const dx = pos[0] - e[12], dy = pos[1] - e[13], dz = pos[2] - e[14];
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > 260) { curScale = 0; return; }
    curScale *= 14 / (14 + dist);                       // gentle distance rolloff
    if (dist < 0.5) return;
    const inv = 1 / dist;
    curPan = clamp((dx * e[0] + dy * e[1] + dz * e[2]) * inv, -1, 1) * 0.8;
  }

  function sfx(name, opts) {
    if (!name) return;
    if (!ensureContext(gestureSeen || started)) return;
    const fn = SFX[name];
    if (!fn) return;
    if (ac.state === 'suspended') ac.resume().catch(() => { });
    const o = opts || EMPTY;
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
    const last = lastFired[name];
    if (last !== undefined && ac.currentTime - last < (gap || 0.3)) return;
    sfx(name, opts);
  }

  // ------------------------------------------------------------------
  // underwater
  // ------------------------------------------------------------------
  function setUnderwater(on) {
    on = !!on;
    const changed = on !== underwater;
    underwater = on;
    if (!ac) return;
    const t = ac.currentTime;
    uwFilter.frequency.cancelScheduledValues(t);
    uwFilter.frequency.setValueAtTime(Math.max(20, uwFilter.frequency.value), t);
    uwFilter.frequency.exponentialRampToValueAtTime(on ? 700 : 20000, t + (on ? 0.35 : 0.7));
    uwFilter.Q.setTargetAtTime(on ? 1.5 : 0.7, t, 0.15);
    if (subGain) subGain.gain.setTargetAtTime(on ? 0.34 : 0.0001, t, on ? 0.6 : 0.9);
    if (padDetunes) {
      for (let i = 0; i < padDetunes.length; i++) {
        const d = padDetunes[i];
        d.p.setTargetAtTime(d.base + (on ? -16 : 0), t, 0.5);
      }
    }
    if (changed) {
      noise(t, on ? 0.5 : 0.35, 0.18, sfxBus, {
        type: 'lowpass', f0: on ? 1800 : 500, f1: on ? 380 : 2400, sweep: 0.3, Q: 1.2, atk: 0.006,
      });
      const n = on ? 6 : 3;
      for (let i = 0; i < n; i++) SFX.bubble(t + 0.04 + i * 0.06, EMPTY);
    }
  }

  function setVolume(v01) {
    userVol = clamp(typeof v01 === 'number' ? v01 : 0.8, 0, 1);
    if (masterIn && ac) masterIn.gain.setTargetAtTime(Math.pow(userVol, 1.35), ac.currentTime, 0.04);
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
    bus.on('boardBoat', () => sfx('footstep', { surface: 'wood' }));
    bus.on('leaveBoat', () => sfx('footstep', { surface: 'sand' }));
    bus.on('phase', (p) => onPhase(p));
    bus.on('quotaDone', () => sfxDedup('quotaDone', EMPTY, 1.0));
    bus.on('tsunami', () => { cutMusic(); sfxDedup('tsunamiRoar', EMPTY, 3); });
    bus.on('gameOver', () => { stopMusic(1.2); sfxDedup('gameOver', EMPTY, 3); });
    bus.on('gameWon', () => { stopMusic(1.0); sfxDedup('gameWon', EMPTY, 3); });
  }

  function onCatch(d) {
    if (!d) { sfxDedup('catchFanfare', { tier: 1 }, 0.5); return; }
    if (d.caught === false) return;
    const fish = d.fish || d;
    const tier = fish && fish.tier ? fish.tier : 1;
    sfxDedup('catchFanfare', { tier }, 0.5);
    if (fish && fish.mutation) sfxDedup('catchMutation', EMPTY, 0.5);
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
        if (horrorNodes) stopHorror(0.6);
      }
    } else if (p === 'over') {
      motorStop();
      reelOn = false;
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
      net.on(MSG.TSUNAMI, () => { cutMusic(); sfxDedup('tsunamiRoar', EMPTY, 3); });
      net.on(MSG.GAME_OVER, () => { stopMusic(1.2); sfxDedup('gameOver', EMPTY, 3); });
      net.on(MSG.GAME_WON, () => { stopMusic(1.0); sfxDedup('gameWon', EMPTY, 3); });
      net.on(MSG.EVENT_START, (d) => onEventStart(d && d.type));
      net.on(MSG.EVENT_END, () => onEventEnd());
      net.on(MSG.ENEMY_HIT, () => sfxDedup('enemyHurt', EMPTY, 0.08));
      net.on(MSG.SHOP_RESULT, (d) => { if (d && d.ok) sfxDedup('buy', EMPTY, 0.2); else sfxDedup('error', EMPTY, 0.2); });
    } catch (e) { warn(e); }
  }

  // ------------------------------------------------------------------
  // frame update
  // ------------------------------------------------------------------
  function update(dt, t) {
    if (!netBound) bindNet();
    if (!ac || !built) return;
    if (ac.state === 'closed') return;
    const now = ac.currentTime;

    reapVoices(now);

    // --- day/night blend ---
    const st = ctx && ctx.state ? ctx.state : null;
    const tod = st && typeof st.timeOfDay === 'number' ? st.timeOfDay : 0.35;
    const target = nightnessOf(tod);
    nightAmt += (target - nightAmt) * Math.min(1, (dt || 0.016) * 0.6);

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
      if (nightAmt < 0.4 && musicState !== 'horror' && musicState !== 'silence' && !underwater) {
        gullCall(now + 0.05, (Math.random() - 0.5) * 1.7);
      }
    }
    nextCricket -= step;
    if (nextCricket <= 0) {
      nextCricket = 3 + Math.random() * 6;
      if (nightAmt > 0.55 && musicState !== 'horror' && musicState !== 'silence' && !underwater) {
        cricketCall(now + 0.05, (Math.random() - 0.5) * 1.6);
      }
    }
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
