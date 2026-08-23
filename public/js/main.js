// =============================================================
// TIDEWRECK ISLAND - public/js/main.js
//
// The hub. Builds the renderer / scene / camera, the shared `ctx` every
// module reads, the tiny event bus, input tracking, the network wiring
// (server message -> ctx.state -> bus event), and the render loop.
//
// Module init order (contract): audio, world, water, player, boat,
// fishing, enemies, events, ui. Each module's update(dt, t) is called in
// that same order every frame, then the scene is rendered.
// =============================================================

import * as THREE from 'three';
import { MSG, ECON, PLAYER_MAX_HP } from '/shared/constants.js';

import { createNet } from './net.js';
import { initAudio } from './audio.js';
import { initWorld } from './world.js';
import { initWater } from './water.js';
import { initPlayer } from './player.js';
import { initBoat } from './boat.js';
import { initFishing } from './fishing.js';
import { initEnemies } from './enemies.js';
import { initEvents } from './events.js';
import { initUI } from './ui.js';

// -------------------------------------------------------------
// Tiny event bus. Listener arrays are copy-on-write, so emitting
// allocates nothing (some events, e.g. 'sunDir', fire every frame)
// and adding/removing listeners mid-dispatch is safe.
// -------------------------------------------------------------
function createBus() {
  const map = new Map();
  return {
    on(evt, cb) {
      if (!evt || typeof cb !== 'function') return cb;
      const arr = map.get(evt);
      map.set(evt, arr ? arr.concat(cb) : [cb]);
      return cb;
    },
    off(evt, cb) {
      const arr = map.get(evt);
      if (!arr) return;
      const next = arr.filter((fn) => fn !== cb);
      if (next.length) map.set(evt, next);
      else map.delete(evt);
    },
    emit(evt, data) {
      const arr = map.get(evt);
      if (!arr) return;
      for (let i = 0; i < arr.length; i++) {
        try {
          arr[i](data);
        } catch (err) {
          console.error('[bus] "' + evt + '" listener failed:', err);
        }
      }
    },
  };
}

// -------------------------------------------------------------
// Renderer / scene / camera
// -------------------------------------------------------------
const canvas = document.getElementById('game');
if (!canvas) throw new Error('[main] <canvas id="game"> is missing from index.html');

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  stencil: false,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setClearColor(0x08202e, 1);

const scene = new THREE.Scene();
// Placeholder look until world.js installs the real sky / fog.
scene.background = new THREE.Color(0x08202e);

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / Math.max(1, window.innerHeight),
  0.1,
  3000,
);
camera.position.set(0, 60, 180);
camera.lookAt(0, 0, 0);
scene.add(camera);

const clock = new THREE.Clock();

// -------------------------------------------------------------
// Shared context (see DESIGN.md "Client architecture")
// -------------------------------------------------------------
const net = createNet();
const bus = createBus();

const ctx = {
  THREE, scene, camera, renderer, clock,
  net,
  bus,
  state: {
    phase: 'menu',                    // 'menu' | 'lobby' | 'playing' | 'over'
    myId: null, myName: '', myColor: 0,
    world: null,                      // latest WORLD_STATE payload
    room: null,                       // latest ROOM_STATE payload
    gear: { rod: 1, boat: 1, weapons: [], charms: [], diving: 1, activeBait: null, activeWeapon: null },
    baits: {},                        // baitId -> count
    inventory: [],                    // [{invId, fishId, mutation, weightKg, value}]
    hp: PLAYER_MAX_HP, air: 1,
    underwater: false, onBoat: false, seat: -1,
    currentArea: null,
    eventActive: null,                // 'serpent' | 'kraken' | 'bloop' | null
    activeTool: 'rod',                // 'rod' | 'weapon'
    timeOfDay: 0.3,                   // 0..1, interpolated between WORLD_STATE ticks
  },
  input: { keys: new Set(), mouseDown: false, pointerLocked: false },
  getWaterHeight: (x, z, t) => 0,     // overwritten by water.js
  world: null, water: null, playerMod: null, boat: null, fishing: null,
  enemies: null, events: null, audio: null, ui: null,
};

const S = ctx.state;

// Handy for debugging from the console; nothing in the game reads it.
window.TIDEWRECK = ctx;

// -------------------------------------------------------------
// Phase
// -------------------------------------------------------------
function setPhase(next) {
  if (typeof next !== 'string' || S.phase === next) return;
  S.phase = next;
  if (next !== 'playing') releasePointerLock();
  bus.emit('phase', next);
}

// ui.js may drive the phase itself (menu <-> lobby); keep ctx.state in step
// whichever side emitted the event.
bus.on('phase', (p) => {
  if (typeof p !== 'string' || S.phase === p) return;
  S.phase = p;
  if (p !== 'playing') releasePointerLock();
});

// -------------------------------------------------------------
// Time of day: run forward locally, ease toward the server clock.
// -------------------------------------------------------------
const timeSync = { target: S.timeOfDay, active: false };

function wrap01(v) {
  return v - Math.floor(v);
}

/** Shortest signed distance from a to b on the 0..1 ring. */
function ringDelta(a, b) {
  const d = b - a;
  return d - Math.round(d);
}

function syncTimeOfDay(v) {
  if (typeof v !== 'number' || !isFinite(v)) return;
  const target = wrap01(v);
  timeSync.target = target;
  // First sync, or a genuine jump (new day, horror-event night snap): hard set.
  if (!timeSync.active || Math.abs(ringDelta(S.timeOfDay, target)) > 0.05) {
    S.timeOfDay = target;
  }
  timeSync.active = true;
}

function advanceTimeOfDay(dt) {
  const step = dt / ECON.DAY_SECONDS;
  S.timeOfDay = wrap01(S.timeOfDay + step);
  if (!timeSync.active) return;
  timeSync.target = wrap01(timeSync.target + step);
  const d = ringDelta(S.timeOfDay, timeSync.target);
  S.timeOfDay = wrap01(S.timeOfDay + d * Math.min(1, dt * 2));
}

// -------------------------------------------------------------
// Input
// -------------------------------------------------------------
const uiRoot = document.getElementById('ui');
const SCROLL_KEYS = new Set(['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

function isTypingTarget(el) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

/** True for clicks that landed on an actual UI control rather than the world. */
function isUIChrome(el) {
  if (!uiRoot || !el || el === uiRoot) return false;
  return uiRoot.contains(el);
}

function clearInput() {
  ctx.input.keys.clear();
  ctx.input.mouseDown = false;
}

function requestPointerLock() {
  if (!canvas.requestPointerLock) return;
  try {
    const p = canvas.requestPointerLock();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (err) {
    /* browsers throw if called too soon after an unlock - harmless */
  }
}

function releasePointerLock() {
  if (document.pointerLockElement && document.exitPointerLock) {
    try { document.exitPointerLock(); } catch (err) { /* ignore */ }
  }
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape') releasePointerLock();
  if (isTypingTarget(e.target)) return;
  ctx.input.keys.add(e.code);
  if (S.phase === 'playing' && SCROLL_KEYS.has(e.code)) e.preventDefault();
  firstGesture();
});

window.addEventListener('keyup', (e) => {
  ctx.input.keys.delete(e.code);
});

window.addEventListener('mousedown', (e) => {
  if (isTypingTarget(e.target)) return;
  const overUI = !ctx.input.pointerLocked && isUIChrome(e.target);
  if (e.button === 0 && !overUI) ctx.input.mouseDown = true;
  if (!overUI && S.phase === 'playing' && !ctx.input.pointerLocked && e.button === 0) requestPointerLock();
});

window.addEventListener('mouseup', (e) => {
  if (e.button === 0) ctx.input.mouseDown = false;
});

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  ctx.input.pointerLocked = locked;
  if (!locked) ctx.input.mouseDown = false;
  bus.emit('pointerLock', locked);
});

document.addEventListener('pointerlockerror', () => {
  ctx.input.pointerLocked = document.pointerLockElement === canvas;
});

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// Never leave keys stuck down when focus leaves the page.
window.addEventListener('blur', clearInput);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearInput();
});

// WebAudio needs a user gesture; start the score on the first one.
let gestureDone = false;
function firstGesture() {
  if (gestureDone) return;
  gestureDone = true;
  window.removeEventListener('pointerdown', firstGesture);
  try {
    if (ctx.audio && typeof ctx.audio.startMusic === 'function') ctx.audio.startMusic();
  } catch (err) {
    console.error('[main] startMusic failed:', err);
  }
}
window.addEventListener('pointerdown', firstGesture);

// -------------------------------------------------------------
// Resize / context loss
// -------------------------------------------------------------
let resizeQueued = false;
function applyResize() {
  resizeQueued = false;
  const w = Math.max(1, window.innerWidth);
  const h = Math.max(1, window.innerHeight);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h);
}
function onResize() {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(applyResize);
}
window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', onResize);

canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  console.warn('[main] WebGL context lost - waiting for restore');
});
canvas.addEventListener('webglcontextrestored', () => {
  console.info('[main] WebGL context restored');
  applyResize();
});

// -------------------------------------------------------------
// Network wiring: server message -> ctx.state -> bus event
// -------------------------------------------------------------
function applyGear(g) {
  if (!g || typeof g !== 'object') return;
  const gear = S.gear;
  const hadWeapons = gear.weapons.length;
  if (typeof g.rod === 'number') gear.rod = g.rod;
  if (typeof g.boat === 'number') gear.boat = g.boat;
  if (typeof g.diving === 'number') gear.diving = g.diving;
  if (Array.isArray(g.weapons)) gear.weapons = g.weapons.slice();
  if (Array.isArray(g.charms)) gear.charms = g.charms.slice();
  if ('activeBait' in g) gear.activeBait = g.activeBait || null;
  if ('activeWeapon' in g) gear.activeWeapon = g.activeWeapon || null;
  // Auto-equip the very first weapon so it is usable the moment it is bought.
  if (!gear.activeWeapon && hadWeapons === 0 && gear.weapons.length > 0) {
    gear.activeWeapon = gear.weapons[0];
  }
  // An active weapon we no longer own would break weapon code downstream.
  if (gear.activeWeapon && gear.weapons.indexOf(gear.activeWeapon) === -1) {
    gear.activeWeapon = gear.weapons.length ? gear.weapons[gear.weapons.length - 1] : null;
  }
}

/** Store a WORLD_STATE payload on ctx.state (no bus emit - callers do that). */
function applyWorldState(ws) {
  if (!ws || typeof ws !== 'object') return;
  S.world = ws;
  syncTimeOfDay(ws.timeOfDay);
  const players = Array.isArray(ws.players) ? ws.players : null;
  if (!players) return;
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (!p || p.id !== S.myId) continue;
    if (p.name) S.myName = p.name;
    if (typeof p.color === 'number') S.myColor = p.color;
    if (typeof p.hp === 'number') S.hp = p.hp;   // server-authoritative when sent
    applyGear(p.gear);
    break;
  }
}

function wireNetwork() {
  // ---- connection lifecycle ----
  net.on('connect', (info) => {
    if (!S.myId && info && info.id) S.myId = info.id;
    bus.emit('netConnect', info || {});
  });
  net.on('disconnect', (info) => {
    bus.emit('netDisconnect', info || {});
  });

  // ---- lobby ----
  net.on(MSG.ROOM_STATE, (p) => {
    if (!p) {
      S.room = null;
      setPhase('menu');
      bus.emit('roomState', null);
      return;
    }
    S.room = p;
    if (!S.myId) S.myId = net.id();
    const players = Array.isArray(p.players) ? p.players : [];
    for (let i = 0; i < players.length; i++) {
      const pl = players[i];
      if (!pl || pl.id !== S.myId) continue;
      if (pl.name) S.myName = pl.name;
      if (typeof pl.color === 'number') S.myColor = pl.color;
      break;
    }
    if (!p.started && S.phase !== 'playing' && S.phase !== 'over') setPhase('lobby');
    bus.emit('roomState', p);
  });

  net.on(MSG.ERROR_MSG, (p) => {
    bus.emit('error', p || { message: 'Something went wrong.' });
  });

  // ---- run start / world sync ----
  net.on(MSG.GAME_START, (p) => {
    if (!p) return;
    const rerun = S.world !== null;   // second run in the same page session
    S.myId = (p.you && p.you.id) || net.id();
    // Fresh run: reset the per-life bits, keep gear (the world state fills it).
    S.hp = PLAYER_MAX_HP;
    S.air = 1;
    S.underwater = false;
    S.onBoat = false;
    S.seat = -1;
    S.currentArea = null;
    S.eventActive = null;
    S.activeTool = 'rod';
    // Only clear carried loot from a previous run - never a fresh INVENTORY
    // that raced ahead of GAME_START.
    if (rerun) { S.inventory = []; S.baits = {}; }
    applyWorldState(p.state);
    // world.js generates terrain from the seed - keep it reachable on the payload.
    if (S.world && p.world && S.world.seed === undefined) S.world.seed = p.world.seed;
    setPhase('playing');
    bus.emit('gameStart', p);
    if (S.world) bus.emit('worldState', S.world);
  });

  net.on(MSG.WORLD_STATE, (p) => {
    if (!p) return;
    applyWorldState(p);
    bus.emit('worldState', p);
  });

  // ---- movement / entity relays (pure passthrough) ----
  net.on(MSG.PLAYERS_MOVE, (p) => bus.emit('playersMove', p));
  net.on(MSG.BOAT_STATE, (p) => bus.emit('boatState', p));
  net.on(MSG.ENEMY_STATE, (p) => bus.emit('enemyState', p));
  net.on(MSG.ENEMY_HIT, (p) => bus.emit('enemyHit', p));

  // ---- fishing ----
  net.on(MSG.BITE, (p) => bus.emit('bite', p || {}));
  net.on(MSG.CAST_RESULT, (p) => bus.emit('catch', p || {}));

  // ---- inventory / economy ----
  net.on(MSG.INVENTORY, (p) => {
    if (!p) return;
    S.inventory = Array.isArray(p.items) ? p.items : [];
    S.baits = (p.baits && typeof p.baits === 'object') ? p.baits : {};
    bus.emit('inventory', p);
  });

  net.on(MSG.WALLET, (p) => {
    if (!p) return;
    if (S.world) {
      if (typeof p.wallet === 'number') S.world.wallet = p.wallet;
      if (typeof p.quotaProgress === 'number') {
        if (!S.world.quota) S.world.quota = { n: 0, target: 0, progress: 0, deadlineDay: 0 };
        S.world.quota.progress = p.quotaProgress;
      }
    }
    bus.emit('wallet', p);
  });

  net.on(MSG.SHOP_RESULT, (p) => {
    if (!p) return;
    if (p.ok) applyGear(p.gear);
    bus.emit('shopResult', p);
  });

  net.on(MSG.QUOTA_DONE, (p) => bus.emit('quotaDone', p || {}));

  // ---- horror events ----
  net.on(MSG.EVENT_START, (p) => {
    S.eventActive = (p && p.type) ? p.type : null;
    bus.emit('eventStart', p || {});
  });
  net.on(MSG.EVENT_PHASE, (p) => bus.emit('eventPhase', p || {}));
  net.on(MSG.EVENT_END, (p) => {
    S.eventActive = null;
    bus.emit('eventEnd', p || {});
  });

  // ---- damage ----
  net.on(MSG.PLAYER_DAMAGED, (p) => {
    if (!p) return;
    if (p.id === S.myId) {
      const before = S.hp;
      if (typeof p.hp === 'number') S.hp = p.hp;
      const dmg = Math.max(0, before - S.hp);
      bus.emit('localDamaged', { dmg, cause: p.cause, hp: S.hp });
    }
    bus.emit('playerDamaged', p);
  });

  // ---- endgame ----
  net.on(MSG.TSUNAMI_WARNING, (p) => bus.emit('tsunamiWarning', p || {}));
  net.on(MSG.TSUNAMI, (p) => bus.emit('tsunami', p || {}));
  net.on(MSG.GAME_OVER, (p) => {
    setPhase('over');
    bus.emit('gameOver', p || {});
  });
  net.on(MSG.GAME_WON, (p) => {
    setPhase('over');
    bus.emit('gameWon', p || {});
  });

  // ---- portal / chat ----
  net.on(MSG.PORTAL_STATE, (p) => bus.emit('portalState', p || {}));
  net.on(MSG.CHAT_MSG, (p) => bus.emit('chat', p || {}));
}

wireNetwork();

// -------------------------------------------------------------
// Module init (contract order). One broken module must not blank
// the whole game, so init and update are both fenced.
// -------------------------------------------------------------
const MODULES = [
  { key: 'audio', init: initAudio },
  { key: 'world', init: initWorld },
  { key: 'water', init: initWater },
  { key: 'playerMod', init: initPlayer },
  { key: 'boat', init: initBoat },
  { key: 'fishing', init: initFishing },
  { key: 'enemies', init: initEnemies },
  { key: 'events', init: initEvents },
  { key: 'ui', init: initUI },
];

const MAX_MODULE_ERRORS = 120;
const updaters = [];

for (let i = 0; i < MODULES.length; i++) {
  const m = MODULES[i];
  let handle = null;
  try {
    handle = m.init(ctx) || null;
  } catch (err) {
    console.error('[main] ' + m.key + ' failed to initialize:', err);
  }
  ctx[m.key] = handle;
  if (handle && typeof handle.update === 'function') {
    updaters.push({ key: m.key, handle, errors: 0 });
  }
}

function updateModules(dt, t) {
  for (let i = 0; i < updaters.length; i++) {
    const u = updaters[i];
    if (u.errors > MAX_MODULE_ERRORS) continue;
    try {
      u.handle.update(dt, t);
    } catch (err) {
      u.errors++;
      if (u.errors === 1) console.error('[main] ' + u.key + '.update() threw:', err);
      if (u.errors > MAX_MODULE_ERRORS) console.error('[main] ' + u.key + ' disabled after repeated errors');
    }
  }
}

// -------------------------------------------------------------
// Menu camera: a slow orbit of the island so the world is a living
// backdrop behind the menu / lobby. player.js owns the camera while
// the phase is 'playing', so this runs after the module updates.
// -------------------------------------------------------------
const MENU_LOOK = new THREE.Vector3(0, 0, 0);
let menuAngle = Math.PI * 0.32;

function updateMenuCamera(dt, t) {
  menuAngle += dt * 0.055;
  const radius = 180 + Math.sin(t * 0.07) * 12;
  const height = 60 + Math.sin(t * 0.11) * 5;
  camera.position.set(Math.cos(menuAngle) * radius, height, Math.sin(menuAngle) * radius);
  camera.up.set(0, 1, 0);
  camera.lookAt(MENU_LOOK);
  if (camera.fov !== 60) {
    camera.fov = 60;
    camera.updateProjectionMatrix();
  }
}

// -------------------------------------------------------------
// Render loop
// -------------------------------------------------------------
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  advanceTimeOfDay(dt);
  updateModules(dt, t);

  const phase = S.phase;
  if (phase === 'menu' || phase === 'lobby') updateMenuCamera(dt, t);

  renderer.render(scene, camera);
}

applyResize();
renderer.setAnimationLoop(frame);

// -------------------------------------------------------------
// Boot splash hand-off
// -------------------------------------------------------------
const boot = document.getElementById('boot');
if (boot && !boot.classList.contains('boot-error')) {
  boot.style.opacity = '0';
  window.setTimeout(() => {
    if (boot.parentNode) boot.parentNode.removeChild(boot);
  }, 700);
}

console.info('[main] Tidewreck Island ready - modules:', updaters.map((u) => u.key).join(', '));
