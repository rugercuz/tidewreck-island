// =============================================================
// TIDEWRECK ISLAND - server/game.js
// One authoritative Game per started room. Owns the day cycle, the
// shared wallet & quota, per-player gear/inventory, the shop, enemies,
// horror events, the portal and the win/lose conditions.
//
// Runs a 10 Hz simulation tick plus a 12 Hz movement-relay flush.
// Broadcasts WORLD_STATE at exactly 1 Hz and ENEMY_STATE at 8 Hz.
// =============================================================

import {
  MSG,
  AREAS,
  ENEMIES,
  EVENTS,
  ECON,
  SHOP,
  ARTIFACTS,
  WEATHER,
  WEATHER_RULES,
  FLOPPER,
  LOOT_RULES,
  UNIQUE_CHARMS,
  REVIVE,
  PLAYER_MAX_HP,
  BASE_AIR_SECONDS,
  shopById,
  quotaTarget,
  wardPrice,
} from '../shared/constants.js';

import {
  rollBiteDelay,
  rollFish,
  computeLuck,
  biteStrength,
  baitDef,
  uniqueEffects,
  isPerfectCast,
  lootTableFor,
  rollLootDrop,
  rollFoundBait,
  rollUniqueCharm,
} from './fishing.js';

// ---------------- Tuning ----------------

const TICK_MS = 100;              // 10 Hz simulation
const MOVE_FLUSH_MS = 83;         // ~12 Hz PLAYERS_MOVE relay
const TICKS_PER_WORLD_STATE = 10; // exactly 1 Hz
const REEL_TIMEOUT_S = 30;        // no REEL_DONE in this window => the fish wins
const ENEMY_RESPAWN_S = 60;
const ENEMY_CONTACT_RANGE = 2.5;
const ENEMY_CONTACT_RANGE_SQ = ENEMY_CONTACT_RANGE * ENEMY_CONTACT_RANGE;
const ENEMY_HIT_COOLDOWN_S = 1.5;
const ENEMY_AREA_ACTIVE_RANGE = 400;
const ENEMY_AREA_ACTIVE_RANGE_SQ = ENEMY_AREA_ACTIVE_RANGE * ENEMY_AREA_ACTIVE_RANGE;
const ENEMY_MAX_DEPTH = 60;       // stalkers stay in reachable water, not at -400
const EVENT_PHASE_INTERVAL_S = 8;
const EVENT_NIGHT_CHANCE = 0.35;
const EVENT_PHASES = ['approach', 'lunge', 'grab'];
const BOAT_SEATS = 8;
const PLAYER_HIT_COOLDOWN_S = 0.4; // anti-spam on client-reported damage
const WARD_DAYS = 3;
const QUOTA_BONUS_FRACTION = 0.1;
const DIFFICULTY_MULT = { chill: 0.7, normal: 1, hard: 1.4 };
const START_TIME_OF_DAY = 0.28;   // just after sunrise
const DOCK_SPAWN = [0, 1.2, -126];

// --- character customization (mirrors rooms.js sanitizers) -----------
const HAT_COUNT = 5;              // 0..4 = bucket, beanie, captain, bandana, none
const SKIN_COUNT = 4;             // 0..3 = light tan, tan, brown, deep
// --- walkable decks ---------------------------------------------------
const BOAT_LOCAL_LIMIT = 60;      // sane bound for a boat-local deck coordinate

// --- weather ---------------------------------------------------------
const WEATHER_DAWN = 0.06;        // timeOfDay of the dawn reroll (dusk = ECON.NIGHT_START)
const START_WEATHER = 'clear';
const MAX_EVENT_CHANCE = 0.9;     // eventChanceMult must never make a night certain
const ISLAND_SHELTER_RADIUS = 135;// inside this ring you are "on the island" — no bolts
const ISLAND_SHELTER_RADIUS_SQ = ISLAND_SHELTER_RADIUS * ISLAND_SHELTER_RADIUS;
const LIGHTNING_MIN_Y = -0.5;     // ducking under the surface keeps you safe
const LIGHTNING_MISS_MIN_R = 25;  // stray bolts land this far from the boat...
const LIGHTNING_MISS_MAX_R = 95;  // ...out to here

// --- landed catches (floppers) ---------------------------------------
const BONK_COOLDOWN_S = 0.28;     // ~3 whacks a second, whatever the client claims
const MELEE_HIT_RANGE = 6;        // melee/'both'-in-close reach check on DAMAGE_ENEMY
const FLOPPER_PICKUP_S = 20;      // a killed catch auto-banks after this — never lost

// --- underwater loot -------------------------------------------------
const TICKS_PER_LOOT_STATE = 10;  // ~1 Hz is plenty for treasure that never moves
const LOOT_STATE_TICK_PHASE = 5;  // ...offset half a second from WORLD_STATE
const LOOT_REFRESH_S = 6;         // resend an unchanged snapshot at least this often
const LOOT_PICKUP_SLACK = 1.5;    // latency margin on LOOT_RULES.PICKUP_RANGE
const LOOT_DIVE_Y = -3;           // server proxy for "you are down at the bottom"
const LOOT_SPREAD = 0.85;         // nodes sit inside this fraction of the area radius

// --- reviving / bodies ------------------------------------------------
const REVIVE_RANGE_SLACK = 1.2;   // latency margin on SALTS_RANGE / CLAW_RANGE
const BODY_UNDERWATER_Y = -1.2;   // at or below this a body counts as underwater
const BODY_AIR_Y = -0.8;          // above this it has reached air — the claw lets go
const TOW_DISTANCE = 1.5;         // metres the towed body trails behind the carrier
const TOW_BODY_DROP = 0.4;        // ...and how far under them it hangs

// --- ambush / drift predators ----------------------------------------
const AMBUSH_NODE_RADIUS = 8;     // ambushers coil this close to the node they guard
const AMBUSH_BURST_MULT = 1.6;    // lunge speed multiplier
const AMBUSH_BURST_S = 6;         // ...for at most this long
const AMBUSH_REST_S = 5;          // then back to the coil, no re-lunge until this passes
const DRIFT_SPEED_MULT = 0.5;
const DRIFT_MIN_Y = -2;           // jellies hang between here and half the area depth

const ARTIFACT_IDS = Object.keys(ARTIFACTS);
const AREA_BY_ID = new Map(AREAS.map(a => [a.id, a]));
const MAX_ENEMY_DMG = Object.keys(ENEMIES)
  .reduce((m, k) => Math.max(m, ENEMIES[k].dmg), 0);
const EVENT_HIT_MAX_DMG = 15;
/** Horror events ordered by the day they first become possible. */
const EVENT_ORDER = Object.keys(EVENTS).sort((a, b) => EVENTS[a].firstDay - EVENTS[b].firstDay);

/**
 * Client messages the room router may not forward. Each one is bound straight
 * onto the socket, but ONLY when nothing is listening for it already — see
 * bindPlayerSocket(). [message, Game method].
 */
const SOCKET_FALLBACKS = [
  [MSG.BONK_FISH, 'onBonkFish'],
  [MSG.PICKUP_FLOPPER, 'onPickupFlopper'],
  [MSG.PICKUP_LOOT, 'onPickupLoot'],
  [MSG.REVIVE_TEAMMATE, 'onReviveTeammate'],
  [MSG.USE_REVIVAL_KIT, 'onUseRevivalKit'],
  [MSG.TOW_BODY, 'onTowBody'],
];

// ---------------- Small helpers ----------------

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/** Strict: only a real finite number from the wire is accepted, never a coerced null/''/'3'. */
function coord(v, dflt) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return dflt;
  return clamp(v, -6000, 6000);
}

/** Clamped cosmetic index (never wraps) — hat 0..4, skin 0..3, default 0. */
function styleIndex(v, count) {
  return clamp(Math.floor(num(v, 0)), 0, count - 1);
}

/**
 * Boat-local deck position off the wire: exactly three real finite numbers or
 * null. Relayed to PLAYERS_MOVE as-is so remotes anchor to the boat frame.
 */
function boatLocal(v) {
  if (!Array.isArray(v) || v.length < 3) return null;
  for (let i = 0; i < 3; i++) {
    if (typeof v[i] !== 'number' || !Number.isFinite(v[i])) return null;
  }
  return [
    clamp(v[0], -BOAT_LOCAL_LIMIT, BOAT_LOCAL_LIMIT),
    clamp(v[1], -BOAT_LOCAL_LIMIT, BOAT_LOCAL_LIMIT),
    clamp(v[2], -BOAT_LOCAL_LIMIT, BOAT_LOCAL_LIMIT),
  ];
}

/**
 * A fresh revive inventory (SHOP kind 'revive'): consumables carry a count,
 * the Rescue Claw is a one-time permanent tool. Rides in the gear payload.
 */
function newRevives() {
  return { salts: 0, revivalkit: 0, rescueclaw: false };
}

/** True for a SHOP 'revive' item that stacks (salts / kit), false for the claw. */
function isReviveConsumable(item) {
  return !!item && num(item.pack, 0) > 0;
}

/** Own-property lookup so wire strings like 'constructor' can never match. */
function ownDef(table, key) {
  if (typeof key !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;
}

/** Horror-event definition for any EVENTS key (serpent / kraken / bloop). */
function eventDef(type) { return ownDef(EVENTS, type); }

function r2(v) { return Math.round(v * 100) / 100; }
function r3(v) { return Math.round(v * 1000) / 1000; }

function nowSeconds() { return Date.now() / 1000; }

function cleanAnim(v) {
  return typeof v === 'string' && v.length && v.length <= 16 ? v : 'idle';
}

/**
 * True when the day-clock stepped across `mark` (a 0..1 timeOfDay value)
 * between two absolute day positions (dayNumber + timeOfDay, monotonic).
 * Ticks are ~0.1 s against a 300 s day, so at most one crossing per call.
 */
function crossedMark(prevAbs, nowAbs, mark) {
  if (!(nowAbs > prevAbs)) return false;
  const a = Math.floor(prevAbs) + mark;
  if (a > prevAbs && a <= nowAbs) return true;
  const b = Math.floor(nowAbs) + mark;
  return b > prevAbs && b <= nowAbs;
}

export class Game {
  /**
   * @param {object} opts
   * @param {import('socket.io').Server} opts.io
   * @param {string} opts.code           room code (also the socket.io room name)
   * @param {Array}  opts.members        [{id, name, color}]
   * @param {object} opts.settings       {maxPlayers, difficulty}
   * @param {number} opts.seed           deterministic world seed
   * @param {(reason:string)=>void} [opts.onEnd]
   */
  constructor({ io, code, members, settings, seed, onEnd }) {
    this.io = io;
    this.code = code;
    this.seed = num(seed, 1337) >>> 0;
    this.onEnd = typeof onEnd === 'function' ? onEnd : () => {};

    this.difficulty = DIFFICULTY_MULT[settings && settings.difficulty] !== undefined
      ? settings.difficulty : 'normal';
    this.diffMult = DIFFICULTY_MULT[this.difficulty];

    // --- shared team state -------------------------------------------
    this.dayNumber = 1;
    this.timeOfDay = START_TIME_OF_DAY;
    this.wallet = ECON.START_WALLET;
    this.wards = 0;
    this.boatLevel = 1;
    this.artifacts = [];
    this.eventsSurvived = [];
    this.portalBuilt = false;
    this.quota = {
      n: 0,
      target: this.quotaTargetFor(0),
      progress: 0,
      deadlineDay: 1 + ECON.QUOTA_CYCLE_DAYS,
    };

    // --- weather ------------------------------------------------------
    this.weather = WEATHER[START_WEATHER] ? START_WEATHER : 'clear';
    this.daysSinceBadWeather = 0;   // consecutive days with no rain/storm
    this.badWeatherToday = false;
    this.nextLightningAt = 0;

    // --- underwater loot ----------------------------------------------
    this.loot = new Map();          // areaId -> {area, nodes[], respawns[], version, sentTo}
    this.lootCounter = 0;
    this.claimedUniques = new Set(); // one of each UNIQUE_CHARMS per run

    // --- players ------------------------------------------------------
    this.players = new Map();
    this.socketHooks = new Map();   // socket-level fallbacks, see bindPlayerSocket()
    this.flopperCounter = 0;
    for (const m of members || []) this.addPlayer(m);

    // --- team boat ----------------------------------------------------
    this.boat = {
      p: [DOCK_SPAWN[0], 0, DOCK_SPAWN[2] - 6],
      r: 0,
      vel: [0, 0, 0],
      seats: new Array(BOAT_SEATS).fill(null),
    };

    // --- runtime ------------------------------------------------------
    this.enemies = [];
    this.enemyCounter = 0;
    this.invCounter = 0;
    this.tickCount = 0;
    this.over = false;
    this.started = false;
    this.eventActive = null;
    this.tsunamiAt = 0;
    this.tsunamiReason = 'quota';   // 'quota' (missed deadline) | 'wipe' (whole crew down)
    this.wiped = false;             // the island took everyone — no revive ever again
    this.lastWarnDay = 0;
    this.lastEnemyListSize = -1;
    this.moveDirty = new Set();
    this.lastTickAt = nowSeconds();
    this.tickTimer = null;
    this.moveTimer = null;

    this.stats = {
      fishCaught: 0,
      moneyEarned: 0,
      fishSold: 0,
      biggestCatch: null,
    };

    // Treasure first: 'ambush' predators anchor themselves to a live node.
    this.spawnLoot();
    this.spawnEnemies();
  }

  // =========================================================
  // Lifecycle
  // =========================================================

  start() {
    if (this.started || this.over) return;
    this.started = true;
    this.lastTickAt = nowSeconds();
    this.tickTimer = setInterval(() => {
      try { this.tick(); } catch (err) { console.error('[game tick]', this.code, err); }
    }, TICK_MS);
    this.moveTimer = setInterval(() => {
      try { this.flushMoves(); } catch (err) { console.error('[game moves]', this.code, err); }
    }, MOVE_FLUSH_MS);
    if (this.tickTimer.unref) this.tickTimer.unref();
    if (this.moveTimer.unref) this.moveTimer.unref();
    // Opening sky, for clients that only listen on MSG.WEATHER.
    this.broadcast(MSG.WEATHER, this.weatherPayload());
  }

  stop(reason) {
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    if (this.moveTimer) { clearInterval(this.moveTimer); this.moveTimer = null; }
    for (const id of Array.from(this.socketHooks.keys())) this.unbindPlayerSocket(id);
    for (const p of this.players.values()) this.clearFloppers(p, false);
    if (this.over) return;
    this.over = true;
    this.onEnd(reason || 'stopped');
  }

  // =========================================================
  // Players
  // =========================================================

  addPlayer(member) {
    const idx = this.players.size;
    const angle = (idx / 8) * Math.PI * 2;
    const player = {
      id: member.id,
      name: member.name,
      color: num(member.color, 0),
      hat: styleIndex(member.hat, HAT_COUNT),
      skin: styleIndex(member.skin, SKIN_COUNT),
      gear: { rod: 1, weapons: [], charms: [], diving: 1 },
      baits: { worms: 5 },
      revives: newRevives(),  // {salts, revivalkit, rescueclaw} — see REVIVE
      uniques: [],           // claimed UNIQUE_CHARMS ids — server applies the effects
      inventory: [],
      hp: PLAYER_MAX_HP,
      alive: true,
      pos: [DOCK_SPAWN[0] + Math.cos(angle) * 3, DOCK_SPAWN[1], DOCK_SPAWN[2] + Math.sin(angle) * 3],
      rot: 0,
      anim: 'idle',
      swimming: false,
      onBoat: false,
      bl: null,              // boat-local position while standing on the deck
      seat: -1,
      casting: null,
      floppers: new Map(),   // flopperId -> live landed catch, see FLOPPER
      entered: false,
      lastSelfHit: 0,
      lastBonkAt: 0,
      // --- downed bodies (see REVIVE) ---
      downedAt: 0,
      bodySettled: true,     // false = still owe this body one settling MOVE
      towedBy: null,         // carrier id while the Rescue Claw has this body
      towing: null,          // the body id this player is dragging along
      stats: { fish: 0, earned: 0 },
    };
    this.players.set(player.id, player);
    this.bindPlayerSocket(player.id);
    return player;
  }

  /** The live socket for a player id, or null when the layer looks different. */
  socketOf(id) {
    const sockets = this.io && this.io.sockets ? this.io.sockets.sockets : null;
    return sockets && typeof sockets.get === 'function' ? sockets.get(id) : null;
  }

  /**
   * Messages that the room router does not forward (BONK_FISH is routed there,
   * PICKUP_FLOPPER / PICKUP_LOOT are not) are picked up straight off the
   * socket. Anything rooms.js already wired — its handlers are installed at
   * connect time, long before a Game exists — is skipped per message, so a
   * message can never be processed twice.
   */
  bindPlayerSocket(id) {
    try {
      const socket = this.socketOf(id);
      if (!socket || typeof socket.on !== 'function') return;
      if (this.socketHooks.has(id)) return;

      const hooks = [];
      for (const [msg, method] of SOCKET_FALLBACKS) {
        if (typeof this[method] !== 'function') continue;
        if (typeof socket.listeners === 'function' && socket.listeners(msg).length > 0) continue;
        const handler = (d) => {
          try { this[method](id, d && typeof d === 'object' ? d : {}); }
          catch (err) { console.error('[game socket]', this.code, msg, err); }
        };
        socket.on(msg, handler);
        hooks.push([msg, handler]);
      }
      if (hooks.length) this.socketHooks.set(id, hooks);
    } catch (err) { /* socket layer shape differs — the router handles it */ }
  }

  unbindPlayerSocket(id) {
    const hooks = this.socketHooks.get(id);
    if (!hooks) return;
    this.socketHooks.delete(id);
    try {
      const socket = this.socketOf(id);
      if (!socket || typeof socket.off !== 'function') return;
      for (const [msg, handler] of hooks) socket.off(msg, handler);
    } catch (err) { /* already gone */ }
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.clearFloppers(p, false);
    // Whatever they were dragging is dropped, and nobody keeps dragging them.
    this.releaseTowByCarrier(p, 'carrierLeft');
    this.releaseTow(p, 'bodyLeft');
    this.unbindPlayerSocket(id);
    this.players.delete(id);
    this.moveDirty.delete(id);
    for (const state of this.loot.values()) state.sentTo.delete(id);

    let seatChanged = false;
    for (let i = 0; i < BOAT_SEATS; i++) {
      if (this.boat.seats[i] === id) { this.boat.seats[i] = null; seatChanged = true; }
    }
    if (seatChanged) this.broadcastBoatState();

    this.chat('ISLAND', `${p.name} left the island.`);
    this.broadcastWorldState();

    if (this.players.size === 0) this.stop('empty');
  }

  gearPayload(p) {
    return {
      rod: p.gear.rod,
      boat: this.boatLevel,
      weapons: p.gear.weapons.slice(),
      charms: p.gear.charms.slice(),
      diving: p.gear.diving,
      air: this.airSecondsFor(p),
      uniques: Array.isArray(p.uniques) ? p.uniques.slice() : [],
      revives: this.revivesPayload(p),
    };
  }

  /** {salts, revivalkit, rescueclaw} — always whole, always finite. */
  revivesPayload(p) {
    const r = p && p.revives ? p.revives : null;
    return {
      salts: this.reviveCount(p, 'salts'),
      revivalkit: this.reviveCount(p, 'revivalkit'),
      rescueclaw: !!(r && r.rescueclaw),
    };
  }

  /** How many of a stacking revive consumable this player carries. */
  reviveCount(p, key) {
    const r = p && p.revives ? p.revives : null;
    if (!r || !Object.prototype.hasOwnProperty.call(r, key)) return 0;
    return Math.max(0, Math.floor(num(r[key], 0)));
  }

  hasRescueClaw(p) { return !!(p && p.revives && p.revives.rescueclaw); }

  /** Composed effects of every unique charm this player has claimed. */
  uniqueFx(p) {
    return uniqueEffects(p && Array.isArray(p.uniques) ? p.uniques : null);
  }

  airSecondsFor(p) {
    let air = BASE_AIR_SECONDS;
    for (const item of SHOP) {
      if (item.kind === 'diving' && item.level <= p.gear.diving && num(item.air, 0) > air) {
        air = item.air;
      }
    }
    // Pearl of the Deep and friends stretch the lungs.
    return Math.max(1, Math.round(air * this.uniqueFx(p).airMult));
  }

  // =========================================================
  // Emitters
  // =========================================================

  broadcast(type, data) { this.io.to(this.code).emit(type, data); }

  send(id, type, data) { this.io.to(id).emit(type, data); }

  sendExcept(id, type, data) { this.io.to(this.code).except(id).emit(type, data); }

  error(id, message) { this.send(id, MSG.ERROR_MSG, { message }); }

  chat(fromName, text) { this.broadcast(MSG.CHAT_MSG, { fromName, text }); }

  // =========================================================
  // World state
  // =========================================================

  quotaTargetFor(n) {
    return Math.max(1, Math.round(quotaTarget(n) * this.diffMult));
  }

  worldStatePayload() {
    const players = [];
    for (const p of this.players.values()) {
      players.push({
        id: p.id,
        name: p.name,
        color: p.color,
        hat: p.hat,
        skin: p.skin,
        gear: this.gearPayload(p),
        uniques: Array.isArray(p.uniques) ? p.uniques.slice() : [],
        hp: p.hp,
        alive: p.alive,
        seat: p.seat,
        entered: p.entered,
        // downed bodies: where they lie and who (if anyone) is dragging them
        towedBy: p.towedBy || null,
        body: p.alive ? null : [r2(p.pos[0]), r2(p.pos[1]), r2(p.pos[2])],
      });
    }
    return {
      day: this.dayNumber,
      timeOfDay: r3(this.timeOfDay),
      wallet: this.wallet,
      quota: {
        n: this.quota.n,
        target: this.quota.target,
        progress: Math.round(this.quota.progress),
        deadlineDay: this.quota.deadlineDay,
      },
      wards: this.wards,
      artifacts: this.artifacts.slice(),
      eventsSurvived: this.eventsSurvived.slice(),
      portalBuilt: this.portalBuilt,
      players,
      enemiesEnabled: !this.over,
      weather: this.weatherPayload(),
      // additive extras (safe for clients that ignore them)
      boatLevel: this.boatLevel,
      difficulty: this.difficulty,
      eventActive: this.eventActive ? this.eventActive.type : null,
      quotasToWin: ECON.QUOTAS_TO_WIN,
      seed: this.seed,
    };
  }

  broadcastWorldState() { this.broadcast(MSG.WORLD_STATE, this.worldStatePayload()); }

  // =========================================================
  // Weather
  // =========================================================

  weatherDef() { return WEATHER[this.weather] || WEATHER.clear; }

  /** Seconds until the next scheduled reroll (dawn or dusk, whichever is nearer). */
  secondsToNextWeather() {
    const t = this.timeOfDay;
    let best = 1;
    for (const mark of [WEATHER_DAWN, ECON.NIGHT_START]) {
      const d = mark > t ? mark - t : 1 - t + mark;
      if (d < best) best = d;
    }
    return Math.max(0, Math.round(best * ECON.DAY_SECONDS));
  }

  weatherPayload() {
    const def = this.weatherDef();
    return {
      type: this.weather,
      name: def.name,
      hazard: def.hazard || null,
      until: this.secondsToNextWeather(),
    };
  }

  /**
   * Apply a weather type. Broadcasts MSG.WEATHER on every actual change and
   * keeps the rain/storm pity counter honest either way.
   */
  setWeather(type) {
    const next = WEATHER[type] ? type : 'clear';
    const changed = next !== this.weather;
    const bad = next === 'rain' || next === 'storm';
    this.weather = next;

    if (bad) {
      this.badWeatherToday = true;
      this.daysSinceBadWeather = 0;
    }

    // Storms schedule bolts; anything else stands them down.
    this.nextLightningAt = next === 'storm'
      ? nowSeconds() + this.lightningInterval()
      : 0;

    if (!changed) return;

    const def = this.weatherDef();
    this.broadcast(MSG.WEATHER, this.weatherPayload());
    this.chat('ISLAND', def.hazard
      ? `The weather turns: ${def.name}. ${def.hazard}`
      : `The weather turns: ${def.name}.`);
  }

  lightningInterval() {
    const per = Array.isArray(WEATHER_RULES.LIGHTNING_PERIOD) ? WEATHER_RULES.LIGHTNING_PERIOD : [6, 14];
    const lo = Math.max(1, num(per[0], 6));
    const hi = Math.max(lo, num(per[1], 14));
    return lo + Math.random() * (hi - lo);
  }

  /** Weighted pick over WEATHER, with the no-rain pity override. */
  rerollWeather() {
    const pity = Math.max(1, Math.floor(num(WEATHER_RULES.PITY_CLEAR_DAYS, 2)));
    if (this.daysSinceBadWeather >= pity) {
      const stormy = Math.random() < clamp(num(WEATHER_RULES.PITY_STORM_CHANCE, 0.6), 0, 1);
      this.setWeather(stormy ? 'storm' : 'rain');
      return;
    }

    const keys = Object.keys(WEATHER);
    let total = 0;
    for (const k of keys) total += Math.max(0, num(WEATHER[k].weight, 0));
    if (total <= 0) { this.setWeather('clear'); return; }

    let r = Math.random() * total;
    let picked = keys[0];
    for (const k of keys) {
      r -= Math.max(0, num(WEATHER[k].weight, 0));
      if (r <= 0) { picked = k; break; }
    }
    this.setWeather(picked);
  }

  /** Dawn also closes the books on yesterday's pity counter. */
  onDawnWeather() {
    if (this.badWeatherToday) this.daysSinceBadWeather = 0;
    else this.daysSinceBadWeather++;
    this.badWeatherToday = false;
    this.rerollWeather();
  }

  updateWeather(now) {
    if (this.over || this.weather !== 'storm') return;
    if (!this.nextLightningAt) { this.nextLightningAt = now + this.lightningInterval(); return; }
    if (now < this.nextLightningAt) return;
    this.nextLightningAt = now + this.lightningInterval();
    this.strikeLightning();
  }

  /** Anyone above the waterline and off the island is fair game for a bolt. */
  lightningTargets() {
    const out = [];
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      if (p.pos[1] < LIGHTNING_MIN_Y) continue;
      const d2 = p.pos[0] * p.pos[0] + p.pos[2] * p.pos[2];
      if (d2 <= ISLAND_SHELTER_RADIUS_SQ) continue;
      out.push(p);
    }
    return out;
  }

  strikeLightning() {
    const exposed = this.lightningTargets();
    if (exposed.length) {
      const t = exposed[Math.floor(Math.random() * exposed.length) % exposed.length];
      this.broadcast(MSG.LIGHTNING, {
        p: [r2(t.pos[0]), r2(Math.max(0, t.pos[1])), r2(t.pos[2])],
        targetId: t.id,
        dmg: num(WEATHER_RULES.LIGHTNING_DMG, 20),
      });
      this.chat('ISLAND', `The sky picks ${t.name} out of the water.`);
      this.damagePlayer(t, num(WEATHER_RULES.LIGHTNING_DMG, 20), 'lightning');
      return;
    }

    // Nobody exposed: a wasted bolt somewhere out on the water near the boat.
    const ang = Math.random() * Math.PI * 2;
    const rad = LIGHTNING_MISS_MIN_R + Math.random() * (LIGHTNING_MISS_MAX_R - LIGHTNING_MISS_MIN_R);
    let x = this.boat.p[0] + Math.cos(ang) * rad;
    let z = this.boat.p[2] + Math.sin(ang) * rad;
    const d = Math.sqrt(x * x + z * z);
    if (d < ISLAND_SHELTER_RADIUS) {
      const s = (ISLAND_SHELTER_RADIUS + 25) / (d || 1);
      x *= s;
      z *= s;
    }
    this.broadcast(MSG.LIGHTNING, { p: [r2(x), 0, r2(z)], targetId: null, dmg: 0 });
  }

  sendInventory(p) {
    this.send(p.id, MSG.INVENTORY, {
      items: p.inventory.map(it => ({
        invId: it.invId,
        fishId: it.fishId,
        name: it.name,
        tier: it.tier,
        mutation: it.mutation,
        weightKg: it.weightKg,
        value: it.value,
      })),
      baits: Object.assign({}, p.baits),
    });
  }

  broadcastWallet() {
    this.broadcast(MSG.WALLET, {
      wallet: this.wallet,
      quotaProgress: Math.round(this.quota.progress),
      quotaTarget: this.quota.target,
    });
  }

  // =========================================================
  // Tick
  // =========================================================

  tick() {
    if (this.over) return;
    const now = nowSeconds();
    const dt = clamp(now - this.lastTickAt, 0, 0.5);
    this.lastTickAt = now;
    this.tickCount++;

    this.updateClock(dt);
    this.updateWeather(now);
    this.updateCasts(now);
    this.updateTows();
    this.updateFloppers(now);
    this.updateEvent(now);
    this.updateLoot(now);
    this.updateEnemies(dt, now);
    this.updateTsunami(now);

    if (this.over) return;

    // exactly 1 Hz
    if (this.tickCount % TICKS_PER_WORLD_STATE === 0) this.broadcastWorldState();
    // 8 Hz: send on 4 out of every 5 ticks
    if (this.tickCount % 5 !== 0) this.broadcastEnemyState();
    // ~1 Hz, half a second out of phase with WORLD_STATE
    if (this.tickCount % TICKS_PER_LOOT_STATE === LOOT_STATE_TICK_PHASE) this.broadcastLootState(now);
  }

  updateClock(dt) {
    const prevAbs = this.dayNumber + this.timeOfDay;
    this.timeOfDay += dt / ECON.DAY_SECONDS;

    let wrapped = false;
    while (this.timeOfDay >= 1) { this.timeOfDay -= 1; this.dayNumber++; wrapped = true; }

    const nowAbs = this.dayNumber + this.timeOfDay;
    const dawn = crossedMark(prevAbs, nowAbs, WEATHER_DAWN);
    const dusk = crossedMark(prevAbs, nowAbs, ECON.NIGHT_START);

    if (wrapped) this.onSunrise();
    // Weather rerolls twice a day; dusk resolves BEFORE the night's event roll
    // so the sky that just closed in is the one that decides the odds.
    if (dawn) this.onDawnWeather();
    if (dusk) {
      this.rerollWeather();
      this.onNightfall();
    }
  }

  onSunrise() {
    // Everyone knocked out overnight gets carried back to the campfire.
    const revived = this.reviveAll('sunrise');
    if (revived > 0) {
      this.chat('ISLAND', revived === 1
        ? 'Someone wakes at the campfire, salt-crusted but breathing.'
        : `${revived} of you wake at the campfire, salt-crusted but breathing.`);
    }
    this.chat('ISLAND', `Day ${this.dayNumber} breaks over Tidewreck Island.`);
    this.sendTsunamiWarning();
    this.broadcastWorldState();
  }

  sendTsunamiWarning() {
    if (this.over) return;
    if (this.quota.progress >= this.quota.target) return;
    const daysLeft = this.quota.deadlineDay - this.dayNumber;
    if (daysLeft > 1) return;
    if (this.lastWarnDay === this.dayNumber) return;
    this.lastWarnDay = this.dayNumber;
    this.broadcast(MSG.TSUNAMI_WARNING, {
      daysLeft: Math.max(0, daysLeft),
      needed: Math.max(0, Math.round(this.quota.target - this.quota.progress)),
      deadlineDay: this.quota.deadlineDay,
    });
  }

  updateTsunami(now) {
    if (this.over) return;
    if (this.tsunamiAt > 0) {
      if (now - this.tsunamiAt >= ECON.QUOTA_FAIL_GRACE_SECONDS) {
        this.broadcast(MSG.GAME_OVER, {
          reason: this.tsunamiReason === 'wipe' ? 'wipe' : 'tsunami',
          stats: this.buildStats(),
        });
        this.stop('gameover');
      }
      return;
    }
    if (this.dayNumber > this.quota.deadlineDay && this.quota.progress < this.quota.target) {
      this.chat('ISLAND', 'The water pulls away from the beach. All of it.');
      this.triggerTsunami('quota');
    }
  }

  // =========================================================
  // Movement relay
  // =========================================================

  onMove(id, d) {
    const p = this.players.get(id);
    if (!p) return;
    // Bodies do not crawl. A downed player gets exactly ONE more update — the
    // spot they settled at as they fell/sank — and is frozen there afterwards;
    // from then on the server owns the body position (see updateTows).
    if (!p.alive) {
      if (p.bodySettled) return;
      p.bodySettled = true;
    }
    if (Array.isArray(d.p) && d.p.length >= 3) {
      p.pos[0] = coord(d.p[0], p.pos[0]);
      p.pos[1] = coord(d.p[1], p.pos[1]);
      p.pos[2] = coord(d.p[2], p.pos[2]);
    }
    p.rot = coord(d.r, p.rot);
    p.anim = cleanAnim(d.anim);
    p.swimming = !!d.swimming;
    p.onBoat = !!d.onBoat;
    // Walking the deck: the client anchors itself in the boat's frame and the
    // server relays that anchor untouched. Absent/garbage => plain world pos.
    p.bl = boatLocal(d.bl);
    // A body is off the deck for good — it stays in the world where it fell.
    if (!p.alive) { p.onBoat = false; p.seat = -1; p.bl = null; }
    this.moveDirty.add(id);
  }

  flushMoves() {
    if (this.over || this.moveDirty.size === 0) return;
    const list = [];
    for (const id of this.moveDirty) {
      const p = this.players.get(id);
      if (!p) continue;
      list.push({
        id,
        p: [r2(p.pos[0]), r2(p.pos[1]), r2(p.pos[2])],
        r: r3(p.rot),
        anim: p.anim,
        swimming: p.swimming,
        onBoat: p.onBoat,
        bl: p.bl ? [r2(p.bl[0]), r2(p.bl[1]), r2(p.bl[2])] : null,
      });
    }
    this.moveDirty.clear();
    if (!list.length) return;

    if (list.length === 1) {
      this.sendExcept(list[0].id, MSG.PLAYERS_MOVE, { list });
      return;
    }
    // Everyone gets everyone else's transform, never their own.
    for (const id of this.players.keys()) {
      const others = list.filter(e => e.id !== id);
      if (others.length) this.send(id, MSG.PLAYERS_MOVE, { list: others });
    }
  }

  // =========================================================
  // Boat
  // =========================================================

  firstFreeSeat() {
    for (let i = 0; i < BOAT_SEATS; i++) if (!this.boat.seats[i]) return i;
    return -1;
  }

  boatStatePayload() {
    return {
      p: [r2(this.boat.p[0]), r2(this.boat.p[1]), r2(this.boat.p[2])],
      r: r3(this.boat.r),
      vel: [r2(this.boat.vel[0]), r2(this.boat.vel[1]), r2(this.boat.vel[2])],
      driverId: this.boat.seats[0] || null,
      seats: this.boat.seats.slice(),
      level: this.boatLevel,
    };
  }

  broadcastBoatState() { this.broadcast(MSG.BOAT_STATE, this.boatStatePayload()); }

  onBoardBoat(id, d) {
    const p = this.players.get(id);
    if (!p || !p.alive) return;

    let seat = Math.floor(num(d.seat, -1));
    if (!(seat >= 0 && seat < BOAT_SEATS) || (this.boat.seats[seat] && this.boat.seats[seat] !== id)) {
      seat = this.firstFreeSeat();
    }
    if (seat < 0) { this.error(id, 'The boat is full.'); return; }

    for (let i = 0; i < BOAT_SEATS; i++) if (this.boat.seats[i] === id) this.boat.seats[i] = null;
    this.boat.seats[seat] = id;
    p.seat = seat;
    p.onBoat = true;
    this.broadcastBoatState();
  }

  onLeaveBoat(id) {
    const p = this.players.get(id);
    let changed = false;
    for (let i = 0; i < BOAT_SEATS; i++) {
      if (this.boat.seats[i] === id) { this.boat.seats[i] = null; changed = true; }
    }
    if (p) { p.seat = -1; p.onBoat = false; }
    if (changed) this.broadcastBoatState();
  }

  onDriveBoat(id, d) {
    if (this.boat.seats[0] !== id) return; // only the helm moves the hull
    if (Array.isArray(d.p) && d.p.length >= 3) {
      this.boat.p[0] = coord(d.p[0], this.boat.p[0]);
      this.boat.p[1] = coord(d.p[1], this.boat.p[1]);
      this.boat.p[2] = coord(d.p[2], this.boat.p[2]);
    }
    this.boat.r = coord(d.r, this.boat.r);
    if (Array.isArray(d.vel) && d.vel.length >= 3) {
      this.boat.vel[0] = coord(d.vel[0], 0);
      this.boat.vel[1] = coord(d.vel[1], 0);
      this.boat.vel[2] = coord(d.vel[2], 0);
    }
    this.sendExcept(id, MSG.BOAT_STATE, this.boatStatePayload());
  }

  // =========================================================
  // Fishing
  // =========================================================

  areaUnlocked(p, area) {
    const u = area.unlock || {};
    if (num(u.rod, 1) > p.gear.rod) return `You need a stronger rod for ${area.name}.`;
    if (num(u.boat, 1) > this.boatLevel) return `The team boat cannot reach ${area.name} yet.`;
    return null;
  }

  onCastStart(id, d) {
    const p = this.players.get(id);
    if (!p) return;
    if (!p.alive) { this.error(id, 'You are down. Wait for sunrise.'); return; }
    if (p.casting) { this.error(id, 'Your line is already in the water.'); return; }

    const area = AREA_BY_ID.get(String(d.areaId || ''));
    if (!area) {
      this.error(id, 'Cast into one of the marked fishing rings.');
      this.send(id, MSG.CAST_RESULT, { caught: false, reason: 'noarea' });
      return;
    }
    const locked = this.areaUnlocked(p, area);
    if (locked) {
      this.error(id, locked);
      this.send(id, MSG.CAST_RESULT, { caught: false, reason: 'locked' });
      return;
    }

    // Consume one bait if the player actually owns some. Found-only baits
    // (chest loot) are never in SHOP, so resolve through baitDef().
    let baitId = null;
    const wanted = typeof d.baitId === 'string' ? d.baitId : null;
    if (wanted && Object.prototype.hasOwnProperty.call(p.baits, wanted) && num(p.baits[wanted], 0) > 0) {
      const def = baitDef(wanted);
      if (def) {
        p.baits[wanted] = p.baits[wanted] - 1;
        if (p.baits[wanted] <= 0) delete p.baits[wanted];
        baitId = wanted;
        this.sendInventory(p);
      }
    }

    // PERFECT THROW: the client owns the power meter and reports the release
    // landing inside CAST_PERFECT.BAND. The reward is fixed server-side — see
    // rollBiteDelay/rollFish — so a lying client gains exactly the same amount.
    const perfect = isPerfectCast(d.perfect);

    p.casting = {
      areaId: area.id,
      baitId,
      perfect,
      state: 'waiting',
      biteAt: nowSeconds() + rollBiteDelay(p.gear, baitId, this.weather, p.uniques, perfect),
      failAt: 0,
      roll: null,
    };
  }

  updateCasts(now) {
    for (const p of this.players.values()) {
      const c = p.casting;
      if (!c) continue;

      if (!p.alive) {
        p.casting = null;
        this.send(p.id, MSG.CAST_RESULT, { caught: false, reason: 'down' });
        continue;
      }

      if (c.state === 'waiting') {
        if (now < c.biteAt) continue;
        const area = AREA_BY_ID.get(c.areaId);
        const roll = area ? rollFish({
          area,
          gear: p.gear,
          baits: c.baitId,
          luck: computeLuck(p.gear, c.baitId, p.uniques),
          eventsSurvived: this.eventsSurvived,
          difficulty: this.difficulty,
          weather: this.weather,
          perfect: c.perfect === true,
        }) : null;

        if (!roll) {
          p.casting = null;
          this.send(p.id, MSG.CAST_RESULT, { caught: false, reason: 'nothing' });
          continue;
        }
        c.roll = roll;
        c.state = 'biting';
        c.failAt = now + REEL_TIMEOUT_S;
        this.send(p.id, MSG.BITE, { strength: biteStrength(roll.tier), tier: roll.tier });
      } else if (c.state === 'biting' && now >= c.failAt) {
        p.casting = null;
        this.send(p.id, MSG.CAST_RESULT, { caught: false, reason: 'timeout' });
      }
    }
  }

  onReelDone(id, d) {
    const p = this.players.get(id);
    if (!p || !p.casting) return;
    const c = p.casting;
    p.casting = null;

    if (c.state !== 'biting' || !c.roll || !d.success) {
      this.send(id, MSG.CAST_RESULT, { caught: false, reason: c.state !== 'biting' ? 'early' : 'lost' });
      return;
    }

    const roll = c.roll;
    const item = {
      invId: `f${this.code}${++this.invCounter}`,
      fishId: roll.fish.id,
      name: roll.fish.name,
      tier: roll.tier,
      mutation: roll.mutation,
      weightKg: roll.weightKg,
      value: roll.value,
    };

    // The fish is on the deck, not in the bag: it lands ALIVE and flopping, has
    // to be finished (MSG.BONK_FISH) and then picked up (MSG.PICKUP_FLOPPER).
    // Inventory, stats and the artifact award all wait for bankFlopper().
    const prevBest = this.stats.biggestCatch;
    const newRecord = !prevBest || roll.value > prevBest.value;
    const flopper = this.spawnFlopper(p, item, roll);

    this.send(id, MSG.CAST_RESULT, {
      caught: true,
      fish: item,
      newRecord,
      flopperId: flopper.flopperId,
    });

    if (roll.mutation) {
      this.chat('ISLAND', `${p.name} pulled up a ${roll.mutation.toUpperCase()} ${item.name}!`);
    } else if (roll.tier >= 9) {
      this.chat('ISLAND', `${p.name} landed a ${item.name} (${item.weightKg} kg).`);
    }
  }

  // =========================================================
  // Landed catches (floppers)
  // =========================================================

  /** Best whack this player can legally land: bare hands or an owned melee edge. */
  bestBonkDamage(p) {
    let best = num(FLOPPER.HAND_DMG, 10);
    const owned = p && p.gear && Array.isArray(p.gear.weapons) ? p.gear.weapons : [];
    for (const wid of owned) {
      const w = shopById(wid);
      if (!w || w.kind !== 'weapon') continue;
      let d = 0;
      if (w.attack === 'melee') d = num(w.dmg, 0);
      else if (w.attack === 'both') d = num(w.meleeDmg, num(w.dmg, 0));
      if (d > best) best = d;
    }
    // The Barnacle Idol swings for you.
    return Math.max(1, Math.round(best * this.uniqueFx(p).meleeMult));
  }

  spawnFlopper(p, item, roll) {
    const maxHp = Math.max(1, Math.round(
      num(FLOPPER.BASE_HP, 10) + num(roll.tier, 1) * num(FLOPPER.HP_PER_TIER, 5),
    ));
    const fl = {
      flopperId: `fl${this.code}${++this.flopperCounter}`,
      item,
      fishDef: roll.fish,
      hp: maxHp,
      maxHp,
      dead: false,   // killed catches stay put as a pickup until grabbed/auto-banked
      expiresAt: nowSeconds() + Math.max(1, num(FLOPPER.ESCAPE_SECONDS, 25)),
    };
    p.floppers.set(fl.flopperId, fl);

    this.send(p.id, MSG.FLOPPER, {
      state: 'spawn',
      flopperId: fl.flopperId,
      fish: item,
      hp: fl.hp,
      maxHp: fl.maxHp,
      escapeSeconds: Math.max(1, num(FLOPPER.ESCAPE_SECONDS, 25)),
    });
    return fl;
  }

  onBonkFish(id, d) {
    const p = this.players.get(id);
    if (!p || !p.alive || this.over) return;
    const flopperId = typeof d.flopperId === 'string' ? d.flopperId : '';
    const fl = p.floppers.get(flopperId);
    if (!fl || fl.dead) return;   // already finished — it is a pickup now

    const now = nowSeconds();
    if (now - p.lastBonkAt < BONK_COOLDOWN_S) return;   // ~3 whacks/second, no more
    p.lastBonkAt = now;

    // Never trust the reported number beyond "could they actually swing that".
    const max = this.bestBonkDamage(p);
    const asked = Math.round(num(d.dmg, max));
    const dmg = clamp(asked > 0 ? asked : max, 1, max);

    fl.hp = Math.max(0, fl.hp - dmg);

    if (fl.hp <= 0) { this.killFlopper(p, fl); return; }
    this.send(p.id, MSG.FLOPPER, {
      state: 'hit',
      flopperId: fl.flopperId,
      hp: fl.hp,
      maxHp: fl.maxHp,
      dmg,
    });
  }

  /**
   * The catch stops flopping. It does NOT go in the bag yet — it lies there as
   * a glowing pickup until MSG.PICKUP_FLOPPER (or the 20 s auto-bank).
   */
  killFlopper(p, fl) {
    fl.dead = true;
    fl.hp = 0;
    fl.expiresAt = nowSeconds() + FLOPPER_PICKUP_S;

    this.send(p.id, MSG.FLOPPER, {
      state: 'dead',
      flopperId: fl.flopperId,
      fish: fl.item,
      hp: 0,
      maxHp: fl.maxHp,
      pickupSeconds: FLOPPER_PICKUP_S,
      pickupRange: 1.6,
    });
  }

  /** Grab your killed catch off the deck. */
  onPickupFlopper(id, d) {
    const p = this.players.get(id);
    if (!p || this.over) return;
    const flopperId = typeof d.flopperId === 'string' ? d.flopperId : '';
    const fl = p.floppers.get(flopperId);
    if (!fl || !fl.dead) return;   // not yours, or still very much alive
    this.bankFlopper(p, fl, 'pickup');
  }

  /** NOW it is yours: inventory, stats, artifact. */
  bankFlopper(p, fl, reason) {
    if (!p.floppers.delete(fl.flopperId)) return;

    const item = fl.item;
    p.inventory.push(item);
    p.stats.fish++;
    this.stats.fishCaught++;

    const prevBest = this.stats.biggestCatch;
    if (!prevBest || item.value > prevBest.value) {
      this.stats.biggestCatch = {
        fishId: item.fishId,
        name: item.name,
        tier: item.tier,
        mutation: item.mutation,
        weightKg: item.weightKg,
        value: item.value,
        by: p.name,
      };
    }

    this.send(p.id, MSG.FLOPPER, {
      state: 'stowed',
      flopperId: fl.flopperId,
      fish: item,
      hp: 0,
      maxHp: fl.maxHp,
      reason: reason || 'pickup',
    });
    this.sendInventory(p);
    this.awardArtifact(p, fl.fishDef);
  }

  /** The catch wins: it flips over the gunwale and is gone for good. */
  escapeFlopper(p, fl, reason) {
    p.floppers.delete(fl.flopperId);
    this.send(p.id, MSG.FLOPPER, {
      state: 'escaped',
      flopperId: fl.flopperId,
      fish: fl.item,
      hp: 0,
      maxHp: fl.maxHp,
      reason: reason || 'timeout',
    });
    if (fl.item.mutation || num(fl.item.tier, 1) >= 8) {
      this.chat('ISLAND', `${p.name}'s ${fl.item.name} flopped back into the sea.`);
    }
  }

  clearFloppers(p, notify) {
    if (!p || !p.floppers || !p.floppers.size) return;
    for (const fl of Array.from(p.floppers.values())) {
      if (!notify) { p.floppers.delete(fl.flopperId); continue; }
      // A killed fish is never lost — it goes in the bag even if you go under.
      if (fl.dead) this.bankFlopper(p, fl, 'auto');
      else this.escapeFlopper(p, fl, 'lost');
    }
  }

  updateFloppers(now) {
    for (const p of this.players.values()) {
      if (!p.floppers.size) continue;
      for (const fl of Array.from(p.floppers.values())) {
        if (now < fl.expiresAt) continue;
        // Alive: it flips overboard. Dead: it was left lying there — bank it.
        if (fl.dead) this.bankFlopper(p, fl, 'auto');
        else this.escapeFlopper(p, fl, 'timeout');
      }
    }
  }

  onCancelCast(id) {
    const p = this.players.get(id);
    if (!p || !p.casting) return;
    p.casting = null;
    this.send(id, MSG.CAST_RESULT, { caught: false, reason: 'cancelled' });
  }

  awardArtifact(p, fish) {
    if (!fish.artifact) return;
    if (this.artifacts.indexOf(fish.artifact) !== -1) return;
    this.artifacts.push(fish.artifact);
    const def = ARTIFACTS[fish.artifact];
    const label = def ? def.name : fish.artifact;
    this.chat('ISLAND', `${p.name} recovered the ${label}. ${def ? def.desc : ''} (${this.artifacts.length}/${ARTIFACT_IDS.length} artifacts)`);
    this.broadcastWorldState();
    this.broadcastPortalState();
  }

  // =========================================================
  // Underwater loot
  // =========================================================

  lootNodesPerArea() {
    return Math.max(1, Math.floor(num(LOOT_RULES.NODES_PER_AREA, 5)));
  }

  /** One live node set per area that has a LOOT_TABLES entry. */
  spawnLoot() {
    this.loot = new Map();
    const per = this.lootNodesPerArea();
    for (const area of AREAS) {
      if (!lootTableFor(area.id)) continue;
      const state = {
        area,
        nodes: [],
        respawns: [],      // absolute times at which a taken node regrows
        version: 1,        // bumped on every change; drives the LOOT_STATE resend
        sentTo: new Map(), // playerId -> {version, at}
      };
      this.loot.set(area.id, state);
      for (let i = 0; i < per; i++) {
        const node = this.makeLootNode(area);
        if (node) state.nodes.push(node);
      }
    }
  }

  /** A fresh node at a random spot inside the area circle (server tracks XZ). */
  makeLootNode(area) {
    const drop = rollLootDrop(area.id);
    if (!drop) return null;
    const ang = Math.random() * Math.PI * 2;
    const rad = Math.sqrt(Math.random()) * Math.max(4, num(area.radius, 60)) * LOOT_SPREAD;
    return {
      id: `lt${this.code}${++this.lootCounter}`,
      areaId: area.id,
      type: drop.type,
      name: drop.name,
      model: drop.model,
      value: drop.value,
      x: area.center[0] + Math.cos(ang) * rad,
      z: area.center[1] + Math.sin(ang) * rad,
    };
  }

  lootNodeById(areaId, lootId) {
    const state = this.loot.get(areaId);
    if (!state) return null;
    for (const n of state.nodes) if (n.id === lootId) return n;
    return null;
  }

  findLootNode(lootId) {
    for (const state of this.loot.values()) {
      for (let i = 0; i < state.nodes.length; i++) {
        if (state.nodes[i].id === lootId) return { state, node: state.nodes[i], index: i };
      }
    }
    return null;
  }

  lootPayload(state) {
    return {
      areaId: state.area.id,
      list: state.nodes.map(n => ({
        id: n.id,
        type: n.type,
        name: n.name,
        p: [r2(n.x), r2(n.z)],
      })),
    };
  }

  /** Regrow taken nodes elsewhere in their area once RESPAWN_SECONDS is up. */
  updateLoot(now) {
    if (this.over || !this.loot.size) return;
    const per = this.lootNodesPerArea();
    for (const state of this.loot.values()) {
      if (!state.respawns.length) continue;
      let grew = false;
      for (let i = state.respawns.length - 1; i >= 0; i--) {
        if (now < state.respawns[i]) continue;
        state.respawns.splice(i, 1);
        if (state.nodes.length >= per) continue;
        const node = this.makeLootNode(state.area);
        if (node) { state.nodes.push(node); grew = true; }
      }
      if (grew) {
        state.version++;
        this.anchorAmbushers(state.area.id);
      }
    }
  }

  /**
   * LOOT_STATE goes to players in or near an area — the same 400 m proximity
   * gate ENEMY_STATE uses — on every change, and at least every few seconds so
   * a late joiner or a reconnect always converges.
   */
  broadcastLootState(now) {
    if (this.over || !this.loot.size || this.players.size === 0) return;
    const at = num(now, nowSeconds());

    for (const state of this.loot.values()) {
      const targets = [];
      for (const p of this.players.values()) {
        const dx = p.pos[0] - state.area.center[0];
        const dz = p.pos[2] - state.area.center[1];
        if (dx * dx + dz * dz <= ENEMY_AREA_ACTIVE_RANGE_SQ) targets.push(p.id);
      }

      // Forget anyone who swam off (or left) so re-entering resends the set.
      if (state.sentTo.size) {
        const near = new Set(targets);
        for (const id of Array.from(state.sentTo.keys())) {
          if (!near.has(id)) state.sentTo.delete(id);
        }
      }
      if (!targets.length) continue;

      let payload = null;
      for (const id of targets) {
        const rec = state.sentTo.get(id);
        if (rec && rec.version === state.version && at - rec.at < LOOT_REFRESH_S) continue;
        if (!payload) payload = this.lootPayload(state);
        this.send(id, MSG.LOOT_STATE, payload);
        state.sentTo.set(id, { version: state.version, at });
      }
    }
  }

  lootFail(id, lootId, message, reason) {
    this.send(id, MSG.LOOT_RESULT, {
      ok: false,
      lootId,
      reason: reason || 'no',
      message,
    });
  }

  /**
   * Grab a treasure node. Validated: the node is still live, the player is
   * actually down there (server proxy: y < -3) and within PICKUP_RANGE
   * horizontally. Always answers with LOOT_RESULT.
   */
  onPickupLoot(id, d) {
    const p = this.players.get(id);
    if (!p) return;
    const lootId = typeof d.lootId === 'string' ? d.lootId : '';

    if (this.over) { this.lootFail(id, lootId, 'Not now.', 'over'); return; }
    if (!p.alive) { this.lootFail(id, lootId, 'You are down. Wait for sunrise.', 'down'); return; }

    const found = lootId ? this.findLootNode(lootId) : null;
    if (!found) { this.lootFail(id, lootId, 'Someone beat you to it.', 'gone'); return; }

    if (p.pos[1] >= LOOT_DIVE_Y) {
      this.lootFail(id, lootId, 'Dive down to it first.', 'surface');
      return;
    }
    const node = found.node;
    const range = Math.max(1, num(LOOT_RULES.PICKUP_RANGE, 4)) + LOOT_PICKUP_SLACK;
    const dx = p.pos[0] - node.x;
    const dz = p.pos[2] - node.z;
    if (dx * dx + dz * dz > range * range) {
      this.lootFail(id, lootId, 'Too far — swim right up to it.', 'range');
      return;
    }

    // --- it is yours -------------------------------------------------
    const state = found.state;
    state.nodes.splice(found.index, 1);
    state.respawns.push(nowSeconds() + Math.max(5, num(LOOT_RULES.RESPAWN_SECONDS, 150)));
    state.version++;

    const value = Math.max(0, Math.round(num(node.value, 0)));
    if (value > 0) {
      this.wallet += value;
      this.stats.moneyEarned += value;
      p.stats.earned += value;
      this.broadcastWallet();
    }

    // --- chest bonus rolls -------------------------------------------
    let itemId = null;
    let uniqueId = null;
    const extras = [];
    if (node.type === 'chest') {
      if (Math.random() < clamp(num(LOOT_RULES.CHEST_BAIT_CHANCE, 0.35), 0, 1)) {
        const bait = rollFoundBait();
        if (bait) {
          p.baits[bait.id] = num(p.baits[bait.id], 0) + bait.pack;
          itemId = bait.id;
          extras.push(`${bait.pack}x ${bait.name}`);
          this.sendInventory(p);
        }
      }
      if (Math.random() < clamp(num(LOOT_RULES.CHEST_UNIQUE_CHANCE, 0.15), 0, 1)) {
        const uid = rollUniqueCharm(state.area.id, this.claimedUniques);
        const def = uid ? UNIQUE_CHARMS[uid] : null;
        if (uid && def) {
          this.claimedUniques.add(uid);
          p.uniques.push(uid);
          uniqueId = uid;
          extras.push(def.name);
          this.chat('ISLAND', `${p.name} found the ${def.name}!`);
          if (def.desc) this.chat('ISLAND', def.desc);
        }
      }
    }

    this.send(id, MSG.LOOT_RESULT, {
      ok: true,
      lootId,
      kind: node.type,
      type: node.type,
      name: node.name,
      value,
      itemId,
      uniqueId,
      areaId: state.area.id,
      message: extras.length
        ? `${node.name}: $${value} + ${extras.join(' + ')}`
        : `${node.name}: $${value}`,
    });

    // The hole where it was is news to everyone nearby, and to whatever was
    // coiled up guarding it.
    this.broadcastLootState(nowSeconds());
    this.anchorAmbushers(state.area.id);
    if (uniqueId) this.broadcastWorldState();
  }

  // =========================================================
  // Selling & quota
  // =========================================================

  onSellFish(id, d) {
    const p = this.players.get(id);
    if (!p) return;
    const ids = Array.isArray(d.invIds) ? d.invIds : [];
    if (!ids.length) { this.error(id, 'Nothing selected to sell.'); return; }

    const wanted = new Set(ids.map(String));
    let total = 0;
    let count = 0;
    const keep = [];
    for (const it of p.inventory) {
      if (wanted.has(it.invId)) { total += it.value; count++; } else { keep.push(it); }
    }
    if (!count) { this.error(id, 'Those fish are already gone.'); return; }
    p.inventory = keep;

    // The Tidal Bell talks the merchant up.
    const sellMult = this.uniqueFx(p).sellMult;
    const base = total;
    total = Math.max(0, Math.round(total * sellMult));
    const bonus = total - base;

    this.wallet += total;
    this.quota.progress += total;
    this.stats.moneyEarned += total;
    this.stats.fishSold += count;
    p.stats.earned += total;

    this.sendInventory(p);
    this.broadcastWallet();
    this.chat('ISLAND', bonus > 0
      ? `${p.name} sold ${count} fish for $${total} (+$${bonus} haggled).`
      : `${p.name} sold ${count} fish for $${total}.`);

    this.checkQuota();
    this.broadcastWorldState();
  }

  checkQuota() {
    let guard = 0;
    while (this.quota.progress >= this.quota.target && guard++ < 50) {
      const completed = this.quota.target;
      const overflow = this.quota.progress - completed;
      this.quota.n++;
      this.quota.target = this.quotaTargetFor(this.quota.n);
      this.quota.progress = overflow;
      this.quota.deadlineDay = this.dayNumber + ECON.QUOTA_CYCLE_DAYS;
      this.lastWarnDay = 0;

      const bonus = Math.max(1, Math.round(completed * QUOTA_BONUS_FRACTION));
      this.wallet += bonus;
      this.stats.moneyEarned += bonus;

      this.broadcast(MSG.QUOTA_DONE, {
        n: this.quota.n,
        nextTarget: this.quota.target,
        deadlineDay: this.quota.deadlineDay,
        bonus,
      });
      this.chat('ISLAND', `Quota ${this.quota.n}/${ECON.QUOTAS_TO_WIN} delivered. Team bonus $${bonus}. Next: $${this.quota.target} by day ${this.quota.deadlineDay}.`);
      this.broadcastWallet();

      if (this.quota.n >= ECON.QUOTAS_TO_WIN) this.broadcastPortalState();
    }
  }

  // =========================================================
  // Shop
  // =========================================================

  shopFail(id, itemId, message) {
    const p = this.players.get(id);
    this.send(id, MSG.SHOP_RESULT, {
      ok: false,
      itemId,
      message,
      gear: p ? this.gearPayload(p) : null,
    });
    this.error(id, message);
  }

  onBuyItem(id, d) {
    const p = this.players.get(id);
    if (!p) return;
    const itemId = typeof d.itemId === 'string' ? d.itemId : '';
    const item = shopById(itemId);
    if (!item) { this.shopFail(id, itemId, 'The shopkeeper has never heard of that.'); return; }

    const price = item.kind === 'ward' ? wardPrice(this.wards) : item.price;

    // --- prerequisites ------------------------------------------------
    if (item.kind === 'rod') {
      if (p.gear.rod >= item.level) { this.shopFail(id, itemId, 'You already own that rod.'); return; }
      if (item.level !== p.gear.rod + 1) { this.shopFail(id, itemId, 'Buy the previous rod first.'); return; }
    } else if (item.kind === 'boat') {
      if (this.boatLevel >= item.level) { this.shopFail(id, itemId, 'The team boat is already at least that good.'); return; }
      if (item.level !== this.boatLevel + 1) { this.shopFail(id, itemId, 'Upgrade the boat one step at a time.'); return; }
    } else if (item.kind === 'diving') {
      if (p.gear.diving >= item.level) { this.shopFail(id, itemId, 'You already own that diving gear.'); return; }
      if (item.level !== p.gear.diving + 1) { this.shopFail(id, itemId, 'Buy the previous diving gear first.'); return; }
    } else if (item.kind === 'weapon') {
      if (p.gear.weapons.indexOf(item.id) !== -1) { this.shopFail(id, itemId, 'You already carry one of those.'); return; }
    } else if (item.kind === 'charm') {
      if (p.gear.charms.indexOf(item.id) !== -1) { this.shopFail(id, itemId, 'That charm is already on your belt.'); return; }
    } else if (item.kind === 'revive') {
      if (!p.revives) p.revives = newRevives();
      // Consumables stack; the Rescue Claw is a permanent tool — no duplicates.
      if (!isReviveConsumable(item) && p.revives[item.id] === true) {
        this.shopFail(id, itemId, 'That is already clipped to your belt.');
        return;
      }
    }

    if (this.wallet < price) {
      this.shopFail(id, itemId, `Not enough in the team purse ($${price} needed).`);
      return;
    }

    // --- apply ---------------------------------------------------------
    this.wallet -= price;
    let message = `Bought ${item.name}.`;

    switch (item.kind) {
      case 'rod':
        p.gear.rod = item.level;
        message = `${item.name} equipped. Rod level ${item.level}.`;
        this.chat('ISLAND', `${p.name} upgraded to the ${item.name}.`);
        break;
      case 'boat':
        this.boatLevel = item.level;
        message = `The team boat is now a ${item.name}.`;
        this.chat('ISLAND', `${p.name} refitted the boat: ${item.name}.`);
        this.broadcastBoatState();
        break;
      case 'diving':
        p.gear.diving = item.level;
        message = `${item.name} strapped on. ${item.air}s of air.`;
        break;
      case 'weapon': {
        p.gear.weapons.push(item.id);
        const swing = item.attack === 'both' ? num(item.meleeDmg, item.dmg) : num(item.dmg, 0);
        message = (item.attack === 'melee' || item.attack === 'both')
          ? `${item.name} in hand. ${swing} damage a swing — and it finishes a flopping catch.`
          : `${item.name} in hand. ${item.dmg} damage.`;
        break;
      }
      case 'charm':
        p.gear.charms.push(item.id);
        message = `${item.name} on your belt. Luck rising.`;
        break;
      case 'bait': {
        const pack = Math.max(1, Math.floor(num(item.pack, 10)));
        p.baits[item.id] = num(p.baits[item.id], 0) + pack;
        message = `${pack}x ${item.name} (${p.baits[item.id]} total).`;
        this.sendInventory(p);
        break;
      }
      case 'revive': {
        if (!p.revives) p.revives = newRevives();
        if (isReviveConsumable(item)) {
          const pack = Math.max(1, Math.floor(num(item.pack, 1)));
          const held = Math.max(0, Math.floor(num(p.revives[item.id], 0))) + pack;
          p.revives[item.id] = held;
          message = `${item.name} packed away (${held} on you).`;
        } else {
          p.revives[item.id] = true;
          message = `${item.name} clipped to your belt.`;
          this.chat('ISLAND', `${p.name} bought the ${item.name}. Nobody stays sunk now.`);
        }
        break;
      }
      case 'ward': {
        this.wards++;
        this.quota.deadlineDay += WARD_DAYS;
        this.lastWarnDay = 0;
        message = `Tsunami Ward burned. Deadline pushed to day ${this.quota.deadlineDay}.`;
        this.chat('ISLAND', `${p.name} burned a Tsunami Ward. The sea holds back ${WARD_DAYS} more days. Next ward: $${wardPrice(this.wards)}.`);
        break;
      }
      default:
        message = `Bought ${item.name}.`;
        break;
    }

    this.send(id, MSG.SHOP_RESULT, { ok: true, itemId: item.id, message, gear: this.gearPayload(p), price });
    this.broadcastWallet();
    this.broadcastWorldState();
  }

  // =========================================================
  // Damage
  // =========================================================

  damagePlayer(p, dmg, cause) {
    if (!p || !p.alive || this.over) return;
    const amount = Math.max(0, Math.round(num(dmg, 0)));
    if (!(amount > 0)) return;
    p.hp = clamp(p.hp - amount, 0, PLAYER_MAX_HP);

    const wentDown = p.hp <= 0;
    if (wentDown) {
      p.alive = false;
      p.hp = 0;
      p.casting = null;
      this.clearFloppers(p, true);   // whatever was on the deck slides overboard
      for (let i = 0; i < BOAT_SEATS; i++) if (this.boat.seats[i] === p.id) this.boat.seats[i] = null;
      p.seat = -1;
      p.onBoat = false;
      p.bl = null;                   // no longer anchored to the deck
      // The body stays exactly where it fell (pos is NEVER cleared) and owes us
      // one last MOVE to settle; anything it was dragging slips out of its grip.
      p.downedAt = nowSeconds();
      p.bodySettled = false;
      this.releaseTowByCarrier(p, 'carrierDown');
      this.broadcastBoatState();
      this.chat('ISLAND', `${p.name} went under. Sea Salts, a Revival Kit, or sunrise will bring them back.`);
    }

    this.broadcast(MSG.PLAYER_DAMAGED, { id: p.id, hp: p.hp, cause: cause || 'unknown', dmg: amount });

    // ANY transition to not-alive routes through the one wipe check.
    if (wentDown) this.checkTeamWipe();
  }

  /**
   * TEAM WIPE = DOOMSDAY. The single place that asks "is anybody still up?".
   * Called after every transition to not-alive (damage, drowning, lightning,
   * horror events). Zero alive players = the island takes its due: instant
   * tsunami, GAME_OVER after the cinematic, and no revive ever again.
   */
  checkTeamWipe() {
    if (this.over || this.wiped || this.tsunamiAt > 0) return false;
    if (this.players.size === 0) return false;
    for (const p of this.players.values()) if (p.alive) return false;

    this.wiped = true;
    this.chat('ISLAND', 'The whole crew is down. The water pulls away from the beach. All of it.');
    this.triggerTsunami('wipe');
    return true;
  }

  /**
   * The one tsunami path, shared by the missed quota ('quota') and the team
   * wipe ('wipe'). TSUNAMI carries the reason; GAME_OVER follows after
   * ECON.QUOTA_FAIL_GRACE_SECONDS in updateTsunami().
   */
  triggerTsunami(reason) {
    if (this.over || this.tsunamiAt > 0) return;
    const why = reason === 'wipe' ? 'wipe' : 'quota';
    this.tsunamiReason = why;
    if (why === 'wipe') this.wiped = true;
    // Claim the slot BEFORE anything that can re-enter (endEvent -> wipe check).
    this.tsunamiAt = nowSeconds();

    // A tsunami trumps whatever is circling the boat, but the event still has
    // to close properly (EVENT_END) or clients keep the night snap and the
    // cut music forever.
    if (this.eventActive) this.endEvent();

    this.broadcast(MSG.TSUNAMI, { reason: why });
  }

  onPlayerHit(id, d) {
    const p = this.players.get(id);
    if (!p || !p.alive) return;

    const now = nowSeconds();
    if (now - p.lastSelfHit < PLAYER_HIT_COOLDOWN_S) return;

    const cause = typeof d.cause === 'string' ? d.cause.slice(0, 24) : 'unknown';
    let max = MAX_ENEMY_DMG;
    const enemyDef = ownDef(ENEMIES, cause);
    // Every horror event caps the same — serpent, kraken and bloop alike.
    if (enemyDef) max = num(enemyDef.dmg, MAX_ENEMY_DMG);
    else if (eventDef(cause)) max = EVENT_HIT_MAX_DMG;
    else {
      const byName = Object.keys(ENEMIES).find(k => ENEMIES[k].name === cause);
      if (byName) max = ENEMIES[byName].dmg;
    }

    let dmg = num(d.dmg, 0);
    if (dmg <= 0) return;
    dmg = Math.min(dmg, max);

    p.lastSelfHit = now;
    this.damagePlayer(p, dmg, cause);
  }

  /**
   * The mercy backstop (sunrise) and the event-end mass revive. Once the crew
   * has been wiped NOTHING resurrects anybody — the run is already over.
   */
  reviveAll(cause) {
    if (this.over || this.wiped) return 0;
    let count = 0;
    for (const p of this.players.values()) {
      if (p.alive && p.hp >= PLAYER_MAX_HP) continue;
      const wasDown = !p.alive;
      p.alive = true;
      p.hp = PLAYER_MAX_HP;
      if (wasDown) {
        count++;
        p.bodySettled = true;
        this.releaseTow(p, 'revived');
        this.broadcast(MSG.REVIVED, { id: p.id, by: null, hp: p.hp, cause: cause || 'revive' });
      }
      this.broadcast(MSG.PLAYER_DAMAGED, { id: p.id, hp: p.hp, cause: cause || 'revive', dmg: 0, revived: wasDown });
    }
    return count;
  }

  // =========================================================
  // Reviving (see REVIVE): salts, kit, rescue claw
  // =========================================================

  /** True when this body counts as underwater for the Sea Salts rule. */
  bodyUnderwater(p) { return !!p && p.pos[1] <= BODY_UNDERWATER_Y; }

  /** Straight-line distance between two players, metres. */
  distanceBetween(a, b) {
    const dx = a.pos[0] - b.pos[0];
    const dy = a.pos[1] - b.pos[1];
    const dz = a.pos[2] - b.pos[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Put a downed player back on their feet at `frac` of max hp. `by` is the
   * reviver (null = self / sunrise / event end). Broadcasts MSG.REVIVED plus
   * the usual PLAYER_DAMAGED so older HUD code keeps up.
   */
  revivePlayer(t, by, frac, cause) {
    if (!t || t.alive || this.over || this.wiped) return false;
    const hp = clamp(Math.round(PLAYER_MAX_HP * clamp(num(frac, 0.5), 0.05, 1)), 1, PLAYER_MAX_HP);
    t.alive = true;
    t.hp = hp;
    t.bodySettled = true;      // they move under their own power again
    t.downedAt = 0;
    this.releaseTow(t, 'revived');

    this.broadcast(MSG.REVIVED, { id: t.id, by: by ? by.id : null, hp, cause: cause || 'revive' });
    this.broadcast(MSG.PLAYER_DAMAGED, { id: t.id, hp, cause: cause || 'revive', dmg: 0, revived: true });
    this.moveDirty.add(t.id);
    this.broadcastWorldState();
    return true;
  }

  /** Gear changed off the shop counter (a consumable was spent) — resync it. */
  sendGear(p, itemId, message) {
    this.send(p.id, MSG.SHOP_RESULT, {
      ok: true,
      itemId: itemId || '',
      used: true,
      message: message || '',
      gear: this.gearPayload(p),
    });
  }

  /**
   * Sea Salts: the client channels REVIVE.SALTS_HOLD_SECONDS of hold-E and then
   * sends this. Validated here: reviver up, salts in the pack, target actually
   * down, in range of the BODY (not of wherever the client thinks it is) and —
   * per REVIVE.NO_SALTS_UNDERWATER — the body has to be out of the water.
   */
  onReviveTeammate(id, d) {
    const p = this.players.get(id);
    if (!p || this.over) return;
    if (this.wiped) { this.error(id, 'It is far too late for that.'); return; }
    if (!p.alive) { this.error(id, 'You are down yourself.'); return; }

    const targetId = d && typeof d.targetId === 'string' ? d.targetId : '';
    const t = targetId ? this.players.get(targetId) : null;
    if (!t || t === p) { this.error(id, 'Nobody there to bring back.'); return; }
    if (t.alive) { this.error(id, `${t.name} is already on their feet.`); return; }

    const salts = this.reviveCount(p, 'salts');
    if (salts <= 0) { this.error(id, 'You have no Sea Salts left.'); return; }

    if (REVIVE.NO_SALTS_UNDERWATER && this.bodyUnderwater(t)) {
      this.error(id, `${t.name} is under the water. Tow them up first.`);
      return;
    }

    const range = Math.max(0.5, num(REVIVE.SALTS_RANGE, 3)) + REVIVE_RANGE_SLACK;
    if (this.distanceBetween(p, t) > range) {
      this.error(id, 'Too far — get right over them.');
      return;
    }

    p.revives.salts = salts - 1;
    if (!this.revivePlayer(t, p, num(REVIVE.SALTS_HP, 0.5), 'salts')) {
      p.revives.salts = salts;   // nothing happened — keep the salts
      return;
    }
    this.sendGear(p, 'salts', `Sea Salts spent on ${t.name}. ${p.revives.salts} left.`);
    this.chat('ISLAND', `${p.name} dragged ${t.name} back from the dark.`);
  }

  /** Revival Kit: your own way back up, once. */
  onUseRevivalKit(id) {
    const p = this.players.get(id);
    if (!p || this.over) return;
    if (this.wiped) { this.error(id, 'It is far too late for that.'); return; }
    if (p.alive) { this.error(id, 'You are still on your feet.'); return; }

    const kits = this.reviveCount(p, 'revivalkit');
    if (kits <= 0) { this.error(id, 'No Revival Kit in your pack.'); return; }

    p.revives.revivalkit = kits - 1;
    if (!this.revivePlayer(p, null, num(REVIVE.KIT_HP, 0.4), 'revivalkit')) {
      p.revives.revivalkit = kits;
      return;
    }
    this.sendGear(p, 'revivalkit', 'Revival Kit burned. On your feet.');
    this.chat('ISLAND', `${p.name} clawed back up on their own.`);
  }

  /**
   * Rescue Claw: {targetId} grabs a downed body, {targetId:null} (or the same
   * id again) lets go. While held the server owns the body position — see
   * updateTows — and drags it TOW_DISTANCE behind the carrier.
   */
  onTowBody(id, d) {
    const p = this.players.get(id);
    if (!p || this.over) return;

    const raw = d ? d.targetId : null;
    const targetId = typeof raw === 'string' && raw ? raw : null;

    // Release: an explicit null, or the same body again (toggle).
    if (!targetId) { this.releaseTowByCarrier(p, 'released'); return; }
    const t = this.players.get(targetId);
    if (!t || t === p) return;
    if (t.towedBy === p.id) { this.releaseTow(t, 'released'); return; }

    if (!p.alive) { this.error(id, 'You are down yourself.'); return; }
    if (!this.hasRescueClaw(p)) { this.error(id, 'You need the Rescue Claw for that.'); return; }
    if (t.alive) { this.error(id, `${t.name} does not need carrying.`); return; }
    if (t.towedBy) { this.error(id, 'Someone else already has them.'); return; }

    const range = Math.max(0.5, num(REVIVE.CLAW_RANGE, 3.5)) + REVIVE_RANGE_SLACK;
    if (this.distanceBetween(p, t) > range) { this.error(id, 'Too far — swim closer.'); return; }

    this.releaseTowByCarrier(p, 'swapped');   // one body at a time
    t.towedBy = p.id;
    p.towing = t.id;
    this.broadcast(MSG.BODY_TOWED, { id: t.id, by: p.id });
    this.chat('ISLAND', `${p.name} hooked ${t.name} with the Rescue Claw.`);
  }

  /** Let go of a body, whoever was holding it. Broadcasts BODY_TOWED once. */
  releaseTow(body, reason) {
    if (!body) return false;
    const carrierId = body.towedBy;
    body.towedBy = null;
    for (const q of this.players.values()) if (q.towing === body.id) q.towing = null;
    if (!carrierId) return false;
    this.broadcast(MSG.BODY_TOWED, { id: body.id, by: null, reason: reason || 'released' });
    return true;
  }

  /** Let go of whatever this carrier is dragging. */
  releaseTowByCarrier(carrier, reason) {
    if (!carrier || !carrier.towing) return false;
    const body = this.players.get(carrier.towing);
    carrier.towing = null;
    if (!body) return false;
    return this.releaseTow(body, reason);
  }

  /**
   * Server-owned body movement: every tick a towed body is placed
   * TOW_DISTANCE behind (and a little under) its carrier. It lets go by
   * itself when the body reaches air, when the carrier goes down or
   * disconnects, or when the body is revived.
   */
  updateTows() {
    if (this.over) return;
    for (const carrier of this.players.values()) {
      if (!carrier.towing) continue;
      const body = this.players.get(carrier.towing);
      if (!body || body.towedBy !== carrier.id) { carrier.towing = null; continue; }
      if (!carrier.alive) { this.releaseTow(body, 'carrierDown'); continue; }
      if (body.alive) { this.releaseTow(body, 'revived'); continue; }

      const fx = Math.sin(carrier.rot);
      const fz = Math.cos(carrier.rot);
      body.pos[0] = coord(carrier.pos[0] - fx * TOW_DISTANCE, body.pos[0]);
      body.pos[1] = coord(carrier.pos[1] - TOW_BODY_DROP, body.pos[1]);
      body.pos[2] = coord(carrier.pos[2] - fz * TOW_DISTANCE, body.pos[2]);
      body.rot = carrier.rot;
      body.bl = null;
      body.bodySettled = true;   // the claw, not the client, moves it now
      this.moveDirty.add(body.id);

      // Broke the surface: the claw has done its job, salts can finish it.
      if (body.pos[1] > BODY_AIR_Y) this.releaseTow(body, 'surfaced');
    }
  }

  // =========================================================
  // Enemies
  // =========================================================

  spawnEnemies() {
    this.enemies = [];
    for (const area of AREAS) {
      const types = Array.isArray(area.enemies) ? area.enemies : [];
      for (const type of types) {
        const def = ENEMIES[type];
        if (!def) continue;
        const count = Math.max(1, Math.floor(num(def.count, 1)));
        for (let i = 0; i < count; i++) this.enemies.push(this.makeEnemy(type, def, area));
      }
    }
  }

  makeEnemy(type, def, area) {
    const behavior = typeof def.behavior === 'string' ? def.behavior : 'patrol';
    const e = {
      id: `e${++this.enemyCounter}`,
      type,
      def,
      area,
      behavior,
      p: [0, -5, 0],
      wander: [0, -5, 0],
      anchor: [0, -5, 0],   // 'ambush': the spot it coils on, beside a loot node
      anchorLootId: null,
      burstUntil: 0,        // 'ambush': lunging until this time
      burstReadyAt: 0,      // ...and no new lunge before this one
      r: Math.random() * Math.PI * 2,
      hp: def.hp,
      maxHp: def.hp,
      state: behavior === 'ambush' ? 'lurk' : (behavior === 'drift' ? 'drift' : 'idle'),
      alive: true,
      respawnAt: 0,
      lastHitAt: 0,
      repathAt: 0,
    };
    this.placeEnemy(e);
    return e;
  }

  /** Deepest y an enemy may sit at in this area (the abyss is not reachable). */
  areaFloorDepth(area) {
    return Math.max(6, Math.min(num(area.depth, 20), ENEMY_MAX_DEPTH));
  }

  randomPointInArea(area, out) {
    const ang = Math.random() * Math.PI * 2;
    const rad = Math.sqrt(Math.random()) * area.radius * 0.85;
    const maxDepth = this.areaFloorDepth(area);
    out[0] = area.center[0] + Math.cos(ang) * rad;
    out[1] = -3 - Math.random() * (maxDepth - 3);
    out[2] = area.center[1] + Math.sin(ang) * rad;
    return out;
  }

  /** Mid-water y for a drifter: between -2 and half the area depth. */
  driftDepth(area) {
    const half = this.areaFloorDepth(area) * 0.5;
    return DRIFT_MIN_Y - Math.random() * Math.max(0.5, half + DRIFT_MIN_Y);
  }

  clampToArea(area, out, mult) {
    const limit = Math.max(4, num(area.radius, 60) * (mult || 1));
    const cx = out[0] - area.center[0];
    const cz = out[2] - area.center[1];
    const d2 = cx * cx + cz * cz;
    if (d2 > limit * limit) {
      const dist = Math.sqrt(d2) || 1;
      out[0] = area.center[0] + (cx / dist) * limit;
      out[2] = area.center[1] + (cz / dist) * limit;
    }
    return out;
  }

  /** Initial (or post-respawn) placement, by behavior. */
  placeEnemy(e) {
    if (e.behavior === 'ambush') { this.anchorAmbusher(e, true); return; }
    this.randomPointInArea(e.area, e.p);
    this.randomPointInArea(e.area, e.wander);
    if (e.behavior === 'drift') {
      e.p[1] = this.driftDepth(e.area);
      e.wander[1] = this.driftDepth(e.area);
    }
  }

  /**
   * Seat an ambusher beside a live loot node in its area (within ~8 m) so the
   * treasure is guarded. Falls back to a random seabed spot when the area has
   * nothing left to guard. `snap` teleports it there (spawn/respawn); without
   * it the predator swims back to the new coil on its own.
   */
  anchorAmbusher(e, snap) {
    const state = this.loot ? this.loot.get(e.area.id) : null;
    const nodes = state && state.nodes.length ? state.nodes : null;
    const floor = -this.areaFloorDepth(e.area) + 1.5;

    if (nodes) {
      const node = nodes[Math.floor(Math.random() * nodes.length) % nodes.length];
      const ang = Math.random() * Math.PI * 2;
      const rad = Math.random() * AMBUSH_NODE_RADIUS;
      e.anchorLootId = node.id;
      e.anchor[0] = node.x + Math.cos(ang) * rad;
      e.anchor[1] = floor;
      e.anchor[2] = node.z + Math.sin(ang) * rad;
    } else {
      e.anchorLootId = null;
      this.randomPointInArea(e.area, e.anchor);
      e.anchor[1] = floor;
    }
    this.clampToArea(e.area, e.anchor, 1);

    if (snap) {
      e.p[0] = e.anchor[0];
      e.p[1] = e.anchor[1];
      e.p[2] = e.anchor[2];
      e.wander[0] = e.anchor[0];
      e.wander[1] = e.anchor[1];
      e.wander[2] = e.anchor[2];
      e.burstUntil = 0;
      e.burstReadyAt = 0;
    }
  }

  /** Every ambusher in an area whose guarded node is gone picks a new one. */
  anchorAmbushers(areaId) {
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (e.behavior !== 'ambush' || e.area.id !== areaId) continue;
      if (e.anchorLootId && this.lootNodeById(areaId, e.anchorLootId)) continue;
      this.anchorAmbusher(e, !e.alive);
    }
  }

  respawnEnemy(e) {
    this.placeEnemy(e);
    e.hp = e.maxHp;
    e.alive = true;
    e.state = e.behavior === 'ambush' ? 'lurk' : (e.behavior === 'drift' ? 'drift' : 'idle');
    e.lastHitAt = 0;
    e.respawnAt = 0;
    e.burstUntil = 0;
    e.burstReadyAt = 0;
  }

  updateEnemies(dt, now) {
    if (!this.enemies.length) return;
    const seaFloorPad = 4;
    // Dead fog: they cannot see you either, but they hunt on smell and bad intentions.
    const aggroMult = this.weather === 'fog'
      ? Math.max(1, num(WEATHER_RULES.FOG_AGGRO_MULT, 1.5))
      : 1;

    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (!e.alive) {
        if (now >= e.respawnAt) this.respawnEnemy(e);
        continue;
      }

      const def = e.def;
      // --- pick a target -------------------------------------------
      const near = this.nearestPlayer(e, def.aggroRange * aggroMult);
      const target = near ? near.player : null;
      const bestD2 = near ? near.d2 : Infinity;

      if (e.behavior === 'drift') {
        this.updateDrifter(e, def, dt, now);
      } else if (e.behavior === 'ambush') {
        this.updateAmbusher(e, def, target, dt, now);
      } else if (target) {
        e.state = 'chase';
        this.moveEnemyToward(e, target.pos[0], target.pos[1], target.pos[2], def.speed, dt);
      } else {
        e.state = 'idle';
        const dx = e.wander[0] - e.p[0];
        const dz = e.wander[2] - e.p[2];
        const dy = e.wander[1] - e.p[1];
        if (now >= e.repathAt || (dx * dx + dy * dy + dz * dz) < 4) {
          this.randomPointInArea(e.area, e.wander);
          e.repathAt = now + 6 + Math.random() * 8;
        }
        this.moveEnemyToward(e, e.wander[0], e.wander[1], e.wander[2], def.speed * 0.3, dt);
      }

      // --- contact damage: every behavior stings what it touches ----
      if (target && bestD2 <= ENEMY_CONTACT_RANGE_SQ && now - e.lastHitAt >= ENEMY_HIT_COOLDOWN_S) {
        e.lastHitAt = now;
        e.state = 'attack';
        this.damagePlayer(target, def.dmg, def.name);
      }

      // --- keep them in their water --------------------------------
      const maxDepth = this.areaFloorDepth(e.area);
      if (e.p[1] > -0.4) e.p[1] = -0.4;
      if (e.p[1] < -maxDepth - seaFloorPad) e.p[1] = -maxDepth - seaFloorPad;
      this.clampToArea(e.area, e.p, 1.15);
    }
  }

  /** Nearest living player within `range` metres, or null. */
  nearestPlayer(e, range) {
    let bestD2 = Math.max(0, num(range, 0));
    bestD2 *= bestD2;
    let found = null;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const dx = p.pos[0] - e.p[0];
      const dy = p.pos[1] - e.p[1];
      const dz = p.pos[2] - e.p[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; found = p; }
    }
    return found ? { player: found, d2: bestD2 } : null;
  }

  /**
   * 'drift': a jelly. Never chases — it wanders slowly around mid-water and
   * whatever swims into it gets stung (handled by the shared contact check).
   */
  updateDrifter(e, def, dt, now) {
    const dx = e.wander[0] - e.p[0];
    const dy = e.wander[1] - e.p[1];
    const dz = e.wander[2] - e.p[2];
    if (now >= e.repathAt || (dx * dx + dy * dy + dz * dz) < 1) {
      const ang = Math.random() * Math.PI * 2;
      const rad = 4 + Math.random() * 10;
      e.wander[0] = e.p[0] + Math.cos(ang) * rad;
      e.wander[1] = this.driftDepth(e.area);
      e.wander[2] = e.p[2] + Math.sin(ang) * rad;
      this.clampToArea(e.area, e.wander, 1);
      e.repathAt = now + 5 + Math.random() * 7;
    }
    e.state = 'drift';
    this.moveEnemyToward(e, e.wander[0], e.wander[1], e.wander[2],
      Math.max(0.4, num(def.speed, 2) * DRIFT_SPEED_MULT), dt);
  }

  /**
   * 'ambush': coiled motionless beside the treasure it guards ('lurk') until a
   * diver strays inside aggroRange — then a 1.6x burst for up to 6 s ('aggro')
   * before it slinks back to its anchor.
   */
  updateAmbusher(e, def, target, dt, now) {
    // The node it was guarding got looted? Coil up beside another one.
    if (e.anchorLootId && !this.lootNodeById(e.area.id, e.anchorLootId)) this.anchorAmbusher(e, false);

    if (now >= e.burstUntil && target && now >= e.burstReadyAt) {
      e.burstUntil = now + AMBUSH_BURST_S;
      e.burstReadyAt = e.burstUntil + AMBUSH_REST_S;
    }

    if (now < e.burstUntil) {
      if (target) {
        e.state = 'aggro';
        this.moveEnemyToward(e, target.pos[0], target.pos[1], target.pos[2],
          num(def.speed, 6) * AMBUSH_BURST_MULT, dt);
        return;
      }
      e.burstUntil = 0;   // lost them mid-lunge — break off
    }

    e.state = 'lurk';
    const dx = e.anchor[0] - e.p[0];
    const dy = e.anchor[1] - e.p[1];
    const dz = e.anchor[2] - e.p[2];
    if (dx * dx + dy * dy + dz * dz > 1) {
      this.moveEnemyToward(e, e.anchor[0], e.anchor[1], e.anchor[2],
        Math.max(0.5, num(def.speed, 6) * 0.45), dt);
    }
  }

  moveEnemyToward(e, tx, ty, tz, speed, dt) {
    const dx = tx - e.p[0];
    const dy = ty - e.p[1];
    const dz = tz - e.p[2];
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 0.0001) return;
    const step = Math.min(dist, speed * dt);
    e.p[0] += (dx / dist) * step;
    e.p[1] += (dy / dist) * step;
    e.p[2] += (dz / dist) * step;
    e.r = Math.atan2(dx, dz);
  }

  activeAreaIds() {
    const active = new Set();
    if (this.players.size === 0) return active;
    for (const area of AREAS) {
      if (!area.enemies || !area.enemies.length) continue;
      for (const p of this.players.values()) {
        const dx = p.pos[0] - area.center[0];
        const dz = p.pos[2] - area.center[1];
        if (dx * dx + dz * dz <= ENEMY_AREA_ACTIVE_RANGE_SQ) { active.add(area.id); break; }
      }
    }
    return active;
  }

  broadcastEnemyState() {
    const active = this.activeAreaIds();
    const list = [];
    if (active.size) {
      for (let i = 0; i < this.enemies.length; i++) {
        const e = this.enemies[i];
        if (!e.alive || !active.has(e.area.id)) continue;
        list.push({
          id: e.id,
          type: e.type,
          p: [r2(e.p[0]), r2(e.p[1]), r2(e.p[2])],
          r: r3(e.r),
          hp: e.hp,
          state: e.state,
          behavior: e.behavior,
        });
      }
    }
    // Don't spam empty lists — one is enough to make clients despawn.
    if (list.length === 0 && this.lastEnemyListSize === 0) return;
    this.lastEnemyListSize = list.length;
    this.broadcast(MSG.ENEMY_STATE, { list });
  }

  onDamageEnemy(id, d) {
    const p = this.players.get(id);
    if (!p || !p.alive) return;
    const enemyId = typeof d.enemyId === 'string' ? d.enemyId : '';
    const e = this.enemies.find(en => en.id === enemyId);
    if (!e || !e.alive) return;

    const weaponId = typeof d.weaponId === 'string' ? d.weaponId : '';
    const weapon = shopById(weaponId);
    if (!weapon || weapon.kind !== 'weapon') return;
    if (p.gear.weapons.indexOf(weapon.id) === -1) return;

    // Out-of-range hits are ignored (generous margin for latency). Melee has to
    // be in the enemy's face; 'both' weapons jab up close and fire past that.
    const dx = p.pos[0] - e.p[0];
    const dy = p.pos[1] - e.p[1];
    const dz = p.pos[2] - e.p[2];
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    const attack = typeof weapon.attack === 'string' ? weapon.attack : 'ranged';
    const meleeMult = this.uniqueFx(p).meleeMult;   // Barnacle Idol, swings only
    let maxDmg = num(weapon.dmg, 1);
    let maxRange;
    if (attack === 'melee') {
      // Swing reach only — a club cannot touch something 20 m away.
      maxRange = Math.max(MELEE_HIT_RANGE, num(weapon.range, 3) + 2.5);
      maxDmg *= meleeMult;
    } else {
      maxRange = num(weapon.range, 25) + 12;
      // 'both': a jab in close does meleeDmg, anything further is the ranged shot.
      if (attack === 'both' && dist <= MELEE_HIT_RANGE) maxDmg = num(weapon.meleeDmg, maxDmg) * meleeMult;
    }
    if (dist > maxRange) return;

    const dmg = clamp(Math.round(num(d.dmg, maxDmg)), 1, Math.max(1, Math.round(maxDmg)));
    e.hp = Math.max(0, e.hp - dmg);
    this.broadcast(MSG.ENEMY_HIT, { enemyId: e.id, hp: e.hp, byId: p.id, dmg });

    if (e.hp <= 0) {
      e.alive = false;
      e.state = 'dead';
      e.respawnAt = nowSeconds() + ENEMY_RESPAWN_S;
      this.chat('ISLAND', `${p.name} killed a ${e.def.name}.`);
      this.broadcastEnemyState();
    }
  }

  // =========================================================
  // Horror events
  // =========================================================

  onNightfall() {
    if (this.over || this.eventActive || this.tsunamiAt > 0) return;
    // Bad skies draw bad things out: eventChanceMult scales the nightly roll,
    // but a normal night is never a certainty (the pity day still is).
    const mult = Math.max(0, num(this.weatherDef().eventChanceMult, 1));
    const nightChance = clamp(EVENT_NIGHT_CHANCE * mult, 0, MAX_EVENT_CHANCE);
    for (const type of EVENT_ORDER) {
      if (this.eventsSurvived.indexOf(type) !== -1) continue;
      const def = EVENTS[type];
      if (this.dayNumber < def.firstDay) continue;
      const chance = this.dayNumber >= def.pityDay ? 1 : nightChance;
      if (Math.random() < chance) { this.startEvent(type); return; }
    }
  }

  /**
   * Start a horror event. Works for every EVENTS key (serpent, kraken, bloop) —
   * nothing here is creature-specific; the client picks its visuals off `type`.
   * Also reachable from the host's "/event <type>" debug chat command.
   */
  startEvent(type) {
    const def = eventDef(type);
    if (!def) return;
    if (this.over || this.eventActive || this.tsunamiAt > 0) return;
    const now = nowSeconds();
    this.eventActive = {
      type,
      def,
      startedAt: now,
      endsAt: now + def.duration,
      nextPhaseAt: now + 3,
      phaseIdx: 0,
    };
    this.broadcast(MSG.EVENT_START, {
      type,
      name: def.name,
      desc: def.desc,
      duration: def.duration,
    });
    this.chat('ISLAND', def.desc);
    this.broadcastWorldState();
  }

  eventTarget() {
    const alive = [];
    const onBoat = [];
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      alive.push(p);
      if (p.onBoat) onBoat.push(p);
    }
    const pool = onBoat.length ? onBoat : alive;
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length) % pool.length];
  }

  updateEvent(now) {
    const ev = this.eventActive;
    if (!ev) return;

    if (now >= ev.nextPhaseAt) {
      ev.nextPhaseAt = now + EVENT_PHASE_INTERVAL_S;
      const phase = EVENT_PHASES[ev.phaseIdx % EVENT_PHASES.length];
      ev.phaseIdx++;
      const target = this.eventTarget();
      const pos = target
        ? [r2(target.pos[0]), r2(target.pos[1]), r2(target.pos[2])]
        : [r2(this.boat.p[0]), r2(this.boat.p[1]), r2(this.boat.p[2])];
      this.broadcast(MSG.EVENT_PHASE, {
        type: ev.type,
        phase,
        data: {
          targetId: target ? target.id : null,
          pos,
          boat: [r2(this.boat.p[0]), r2(this.boat.p[1]), r2(this.boat.p[2])],
          timeLeft: Math.max(0, Math.round(ev.endsAt - now)),
          // additive extras (safe for clients that ignore them) — the same
          // three phases drive all three creatures, so hand the client enough
          // to ramp its own staging for kraken/bloop as well as the serpent.
          name: ev.def.name,
          phaseIdx: ev.phaseIdx - 1,
          duration: num(ev.def.duration, 90),
          progress: r3(clamp((now - ev.startedAt) / Math.max(1, num(ev.def.duration, 90)), 0, 1)),
        },
      });
    }

    if (now >= ev.endsAt) this.endEvent();
  }

  endEvent() {
    const ev = this.eventActive;
    if (!ev) return;
    this.eventActive = null;

    let survived = false;
    for (const p of this.players.values()) { if (p.alive) { survived = true; break; } }

    let unlocked = null;
    if (survived) {
      if (this.eventsSurvived.indexOf(ev.type) === -1) this.eventsSurvived.push(ev.type);
      // Each event names its own Tier-X juvenile (serpenthatchling /
      // krakenspawnling / bloopcalf) — never assume one of them.
      unlocked = typeof ev.def.unlocksFish === 'string' ? ev.def.unlocksFish : null;
    }

    this.broadcast(MSG.EVENT_END, { type: ev.type, survived, unlocked, name: ev.def.name });
    this.chat('ISLAND', survived
      ? `${ev.def.name} sank back into the dark. Its young can be hooked in The Abyss now.`
      : `${ev.def.name} took the whole crew.`);

    // An event that left NOBODY standing is not a retry — it is doomsday.
    // Check before the mass revive, or there would be nothing left to check.
    if (!survived) this.checkTeamWipe();

    // Everyone comes back either way — unless the island already took them all
    // (reviveAll is a no-op once the wipe has fired).
    this.reviveAll('eventEnd');
    this.broadcastWorldState();
  }

  // =========================================================
  // Portal & win
  // =========================================================

  missingArtifacts() {
    return ARTIFACT_IDS.filter(a => this.artifacts.indexOf(a) === -1);
  }

  canBuildPortal() {
    return this.quota.n >= ECON.QUOTAS_TO_WIN && this.missingArtifacts().length === 0;
  }

  portalStatePayload() {
    return {
      built: this.portalBuilt,
      canBuild: this.portalBuilt || this.canBuildPortal(),
      missing: this.missingArtifacts(),
      quotasDone: this.quota.n,
      quotasNeeded: ECON.QUOTAS_TO_WIN,
    };
  }

  broadcastPortalState() { this.broadcast(MSG.PORTAL_STATE, this.portalStatePayload()); }

  onBuildPortal(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (this.portalBuilt) { this.send(id, MSG.PORTAL_STATE, this.portalStatePayload()); return; }

    if (!this.canBuildPortal()) {
      const missing = this.missingArtifacts();
      const parts = [];
      if (this.quota.n < ECON.QUOTAS_TO_WIN) parts.push(`${ECON.QUOTAS_TO_WIN - this.quota.n} more quota(s)`);
      if (missing.length) parts.push(missing.map(a => ARTIFACTS[a] ? ARTIFACTS[a].name : a).join(', '));
      this.error(id, `The ring stays cold. Still needed: ${parts.join(' + ')}.`);
      this.send(id, MSG.PORTAL_STATE, this.portalStatePayload());
      return;
    }

    this.portalBuilt = true;
    this.chat('ISLAND', `${p.name} set the last artifact into the stone ring. The portal is open. Step through together.`);
    this.broadcastPortalState();
    this.broadcastWorldState();
  }

  onEnterPortal(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (!this.portalBuilt) {
      this.error(id, 'The stone ring is still dark.');
      this.send(id, MSG.PORTAL_STATE, this.portalStatePayload());
      return;
    }
    if (p.entered) return;
    p.entered = true;

    const alive = [];
    for (const q of this.players.values()) if (q.alive) alive.push(q);
    const waiting = alive.filter(q => !q.entered).length;

    this.chat('ISLAND', waiting > 0
      ? `${p.name} stepped through. Waiting on ${waiting} more.`
      : `${p.name} stepped through.`);
    this.broadcastWorldState();

    if (alive.length > 0 && waiting === 0) this.win();
  }

  win() {
    if (this.over) return;
    this.broadcast(MSG.GAME_WON, { stats: this.buildStats() });
    this.stop('won');
  }

  // =========================================================
  // Stats
  // =========================================================

  buildStats() {
    const players = [];
    for (const p of this.players.values()) {
      players.push({
        id: p.id,
        name: p.name,
        color: p.color,
        fish: p.stats.fish,
        earned: p.stats.earned,
        rod: p.gear.rod,
        alive: p.alive,
      });
    }
    const days = this.dayNumber;
    const totalFish = this.stats.fishCaught;
    const moneyEarned = this.stats.moneyEarned;
    return {
      // primary names
      days,
      totalFish,
      moneyEarned,
      biggestCatch: this.stats.biggestCatch,
      // friendly aliases so any HUD spelling finds them
      daysSurvived: days,
      fishCaught: totalFish,
      fishSold: this.stats.fishSold,
      money: moneyEarned,
      wallet: this.wallet,
      quotas: this.quota.n,
      quotasCompleted: this.quota.n,
      quotasToWin: ECON.QUOTAS_TO_WIN,
      wards: this.wards,
      artifacts: this.artifacts.slice(),
      eventsSurvived: this.eventsSurvived.slice(),
      boatLevel: this.boatLevel,
      difficulty: this.difficulty,
      players,
    };
  }
}

export default Game;
