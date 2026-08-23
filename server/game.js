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
const DEPARTED_TTL_S = 15 * 60;   // rejoin within 15 min keeps your gear

const ARTIFACT_IDS = Object.keys(ARTIFACTS);
const AREA_BY_ID = new Map(AREAS.map(a => [a.id, a]));
const MAX_ENEMY_DMG = Object.keys(ENEMIES)
  .reduce((m, k) => Math.max(m, ENEMIES[k].dmg), 0);
const EVENT_HIT_MAX_DMG = 15;
/** Horror events ordered by the day they first become possible. */
const EVENT_ORDER = Object.keys(EVENTS).sort((a, b) => EVENTS[a].firstDay - EVENTS[b].firstDay);

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

function r2(v) { return Math.round(v * 100) / 100; }
function r3(v) { return Math.round(v * 1000) / 1000; }

function nowSeconds() { return Date.now() / 1000; }

function cleanAnim(v) {
  return typeof v === 'string' && v.length && v.length <= 16 ? v : 'idle';
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

    // --- players ------------------------------------------------------
    this.players = new Map();
    // name -> {gear, baits, inventory, stats, at} for players who dropped mid-run
    this.departed = new Map();
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
  }

  stop(reason) {
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    if (this.moveTimer) { clearInterval(this.moveTimer); this.moveTimer = null; }
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
      gear: { rod: 1, weapons: [], charms: [], diving: 1 },
      baits: { worms: 5 },
      inventory: [],
      hp: PLAYER_MAX_HP,
      alive: true,
      pos: [DOCK_SPAWN[0] + Math.cos(angle) * 3, DOCK_SPAWN[1], DOCK_SPAWN[2] + Math.sin(angle) * 3],
      rot: 0,
      anim: 'idle',
      swimming: false,
      onBoat: false,
      seat: -1,
      casting: null,
      entered: false,
      lastSelfHit: 0,
      stats: { fish: 0, earned: 0 },
    };
    this.players.set(player.id, player);
    return player;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.moveDirty.delete(id);
    this.departed.set(p.name, {
      gear: p.gear, baits: p.baits, inventory: p.inventory, stats: p.stats, at: nowSeconds(),
    });

    let seatChanged = false;
    for (let i = 0; i < BOAT_SEATS; i++) {
      if (this.boat.seats[i] === id) { this.boat.seats[i] = null; seatChanged = true; }
    }
    if (seatChanged) this.broadcastBoatState();

    this.chat('ISLAND', `${p.name} left the island.`);
    this.broadcastWorldState();

    if (this.players.size === 0) this.stop('empty');
  }

  /** Give a rejoining player (matched by name, within DEPARTED_TTL_S) their stuff back. */
  restoreDeparted(p) {
    const d = this.departed.get(p.name);
    if (!d) return false;
    this.departed.delete(p.name);
    if (nowSeconds() - d.at > DEPARTED_TTL_S) return false;
    p.gear = d.gear;
    p.baits = d.baits;
    p.inventory = d.inventory;
    p.stats = d.stats;
    return true;
  }

  /** Everything a late joiner needs beyond GAME_START: bag, baits, gear, boat seats. */
  syncNewcomer(p) {
    this.sendInventory(p);
    this.send(p.id, MSG.BOAT_STATE, this.boatStatePayload());
    this.broadcastWorldState();   // carries everyone's gear, incl. the newcomer's restored kit
  }

  gearPayload(p) {
    return {
      rod: p.gear.rod,
      boat: this.boatLevel,
      weapons: p.gear.weapons.slice(),
      charms: p.gear.charms.slice(),
      diving: p.gear.diving,
      air: this.airSecondsFor(p),
    };
  }

  airSecondsFor(p) {
    let air = BASE_AIR_SECONDS;
    for (const item of SHOP) {
      if (item.kind === 'diving' && item.level <= p.gear.diving && num(item.air, 0) > air) {
        air = item.air;
      }
    }
    return air;
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
        gear: this.gearPayload(p),
        hp: p.hp,
        alive: p.alive,
        seat: p.seat,
        entered: p.entered,
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
      // additive extras (safe for clients that ignore them)
      boatLevel: this.boatLevel,
      difficulty: this.difficulty,
      eventActive: this.eventActive ? this.eventActive.type : null,
      quotasToWin: ECON.QUOTAS_TO_WIN,
      seed: this.seed,
    };
  }

  broadcastWorldState() { this.broadcast(MSG.WORLD_STATE, this.worldStatePayload()); }

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
    this.updateCasts(now);
    this.updateEvent(now);
    this.updateEnemies(dt, now);
    this.updateTsunami(now);

    if (this.over) return;

    // exactly 1 Hz
    if (this.tickCount % TICKS_PER_WORLD_STATE === 0) this.broadcastWorldState();
    // 8 Hz: send on 4 out of every 5 ticks
    if (this.tickCount % 5 !== 0) this.broadcastEnemyState();
  }

  updateClock(dt) {
    const prev = this.timeOfDay;
    this.timeOfDay += dt / ECON.DAY_SECONDS;

    let wrapped = false;
    while (this.timeOfDay >= 1) { this.timeOfDay -= 1; this.dayNumber++; wrapped = true; }

    if (wrapped) {
      this.onSunrise();
    } else if (prev < ECON.NIGHT_START && this.timeOfDay >= ECON.NIGHT_START) {
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
        this.broadcast(MSG.GAME_OVER, { reason: 'tsunami', stats: this.buildStats() });
        this.stop('gameover');
      }
      return;
    }
    if (this.dayNumber > this.quota.deadlineDay && this.quota.progress < this.quota.target) {
      this.tsunamiAt = now;
      this.eventActive = null;
      this.chat('ISLAND', 'The water pulls away from the beach. All of it.');
      this.broadcast(MSG.TSUNAMI, {});
    }
  }

  // =========================================================
  // Movement relay
  // =========================================================

  onMove(id, d) {
    const p = this.players.get(id);
    if (!p) return;
    if (Array.isArray(d.p) && d.p.length >= 3) {
      p.pos[0] = coord(d.p[0], p.pos[0]);
      p.pos[1] = coord(d.p[1], p.pos[1]);
      p.pos[2] = coord(d.p[2], p.pos[2]);
    }
    p.rot = coord(d.r, p.rot);
    p.anim = cleanAnim(d.anim);
    p.swimming = !!d.swimming;
    p.onBoat = !!d.onBoat;
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

    // Consume one bait if the player actually owns some.
    let baitId = null;
    const wanted = typeof d.baitId === 'string' ? d.baitId : null;
    if (wanted && num(p.baits[wanted], 0) > 0) {
      const def = shopById(wanted);
      if (def && def.kind === 'bait') {
        p.baits[wanted] = p.baits[wanted] - 1;
        if (p.baits[wanted] <= 0) delete p.baits[wanted];
        baitId = wanted;
        this.sendInventory(p);
      }
    }

    p.casting = {
      areaId: area.id,
      baitId,
      state: 'waiting',
      biteAt: nowSeconds() + rollBiteDelay(p.gear, baitId),
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
          luck: computeLuck(p.gear, c.baitId),
          eventsSurvived: this.eventsSurvived,
          difficulty: this.difficulty,
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
    p.inventory.push(item);
    p.stats.fish++;
    this.stats.fishCaught++;

    const prevBest = this.stats.biggestCatch;
    const newRecord = !prevBest || roll.value > prevBest.value;
    if (newRecord) {
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

    this.send(id, MSG.CAST_RESULT, { caught: true, fish: item, newRecord });
    this.sendInventory(p);

    if (roll.mutation) {
      this.chat('ISLAND', `${p.name} pulled up a ${roll.mutation.toUpperCase()} ${item.name}!`);
    } else if (roll.tier >= 9) {
      this.chat('ISLAND', `${p.name} landed a ${item.name} (${item.weightKg} kg).`);
    }

    this.awardArtifact(p, roll.fish);
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

    this.wallet += total;
    this.quota.progress += total;
    this.stats.moneyEarned += total;
    this.stats.fishSold += count;
    p.stats.earned += total;

    this.sendInventory(p);
    this.broadcastWallet();
    this.chat('ISLAND', `${p.name} sold ${count} fish for $${total}.`);

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
      case 'weapon':
        p.gear.weapons.push(item.id);
        message = `${item.name} in hand. ${item.dmg} damage.`;
        break;
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
    const amount = Math.max(0, Math.round(dmg));
    if (amount <= 0) return;
    p.hp = clamp(p.hp - amount, 0, PLAYER_MAX_HP);

    if (p.hp <= 0) {
      p.alive = false;
      p.hp = 0;
      p.casting = null;
      for (let i = 0; i < BOAT_SEATS; i++) if (this.boat.seats[i] === p.id) this.boat.seats[i] = null;
      p.seat = -1;
      p.onBoat = false;
      this.broadcastBoatState();
      this.chat('ISLAND', `${p.name} went under. They will wake at the campfire.`);
    }

    this.broadcast(MSG.PLAYER_DAMAGED, { id: p.id, hp: p.hp, cause: cause || 'unknown', dmg: amount });
  }

  onPlayerHit(id, d) {
    const p = this.players.get(id);
    if (!p || !p.alive) return;

    const now = nowSeconds();
    if (now - p.lastSelfHit < PLAYER_HIT_COOLDOWN_S) return;

    const cause = typeof d.cause === 'string' ? d.cause.slice(0, 24) : 'unknown';
    let max = MAX_ENEMY_DMG;
    if (ENEMIES[cause]) max = ENEMIES[cause].dmg;
    else if (EVENTS[cause]) max = EVENT_HIT_MAX_DMG;
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

  reviveAll(cause) {
    let count = 0;
    for (const p of this.players.values()) {
      if (p.alive && p.hp >= PLAYER_MAX_HP) continue;
      const wasDown = !p.alive;
      p.alive = true;
      p.hp = PLAYER_MAX_HP;
      if (wasDown) count++;
      this.broadcast(MSG.PLAYER_DAMAGED, { id: p.id, hp: p.hp, cause: cause || 'revive', dmg: 0, revived: wasDown });
    }
    return count;
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
    const e = {
      id: `e${++this.enemyCounter}`,
      type,
      def,
      area,
      p: [0, -5, 0],
      wander: [0, -5, 0],
      r: Math.random() * Math.PI * 2,
      hp: def.hp,
      maxHp: def.hp,
      state: 'idle',
      alive: true,
      respawnAt: 0,
      lastHitAt: 0,
      repathAt: 0,
    };
    this.randomPointInArea(area, e.p);
    this.randomPointInArea(area, e.wander);
    return e;
  }

  randomPointInArea(area, out) {
    const ang = Math.random() * Math.PI * 2;
    const rad = Math.sqrt(Math.random()) * area.radius * 0.85;
    const maxDepth = Math.max(6, Math.min(num(area.depth, 20), ENEMY_MAX_DEPTH));
    out[0] = area.center[0] + Math.cos(ang) * rad;
    out[1] = -3 - Math.random() * (maxDepth - 3);
    out[2] = area.center[1] + Math.sin(ang) * rad;
    return out;
  }

  respawnEnemy(e) {
    this.randomPointInArea(e.area, e.p);
    this.randomPointInArea(e.area, e.wander);
    e.hp = e.maxHp;
    e.alive = true;
    e.state = 'idle';
    e.lastHitAt = 0;
    e.respawnAt = 0;
  }

  updateEnemies(dt, now) {
    if (!this.enemies.length) return;
    const seaFloorPad = 4;

    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (!e.alive) {
        if (now >= e.respawnAt) this.respawnEnemy(e);
        continue;
      }

      const def = e.def;
      // --- pick a target -------------------------------------------
      let target = null;
      let bestD2 = def.aggroRange * def.aggroRange;
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        const dx = p.pos[0] - e.p[0];
        const dy = p.pos[1] - e.p[1];
        const dz = p.pos[2] - e.p[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; target = p; }
      }

      if (target) {
        e.state = 'chase';
        this.moveEnemyToward(e, target.pos[0], target.pos[1], target.pos[2], def.speed, dt);
        if (bestD2 <= ENEMY_CONTACT_RANGE_SQ && now - e.lastHitAt >= ENEMY_HIT_COOLDOWN_S) {
          e.lastHitAt = now;
          e.state = 'attack';
          this.damagePlayer(target, def.dmg, def.name);
        }
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

      // --- keep them in their water --------------------------------
      const maxDepth = Math.max(6, Math.min(num(e.area.depth, 20), ENEMY_MAX_DEPTH));
      if (e.p[1] > -0.4) e.p[1] = -0.4;
      if (e.p[1] < -maxDepth - seaFloorPad) e.p[1] = -maxDepth - seaFloorPad;

      const cx = e.p[0] - e.area.center[0];
      const cz = e.p[2] - e.area.center[1];
      const distSq = cx * cx + cz * cz;
      const limit = e.area.radius * 1.15;
      if (distSq > limit * limit) {
        const dist = Math.sqrt(distSq) || 1;
        e.p[0] = e.area.center[0] + (cx / dist) * limit;
        e.p[2] = e.area.center[1] + (cz / dist) * limit;
      }
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

    // Out-of-range shots are ignored (generous margin for latency).
    const dx = p.pos[0] - e.p[0];
    const dy = p.pos[1] - e.p[1];
    const dz = p.pos[2] - e.p[2];
    const maxRange = num(weapon.range, 25) + 12;
    if (dx * dx + dy * dy + dz * dz > maxRange * maxRange) return;

    const dmg = clamp(Math.round(num(d.dmg, weapon.dmg)), 1, weapon.dmg);
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
    for (const type of EVENT_ORDER) {
      if (this.eventsSurvived.indexOf(type) !== -1) continue;
      const def = EVENTS[type];
      if (this.dayNumber < def.firstDay) continue;
      const chance = this.dayNumber >= def.pityDay ? 1 : EVENT_NIGHT_CHANCE;
      if (Math.random() < chance) { this.startEvent(type); return; }
    }
  }

  startEvent(type) {
    const def = EVENTS[type];
    if (!def) return;
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
      unlocked = ev.def.unlocksFish;
    }

    this.broadcast(MSG.EVENT_END, { type: ev.type, survived, unlocked });
    this.chat('ISLAND', survived
      ? `${ev.def.name} sank back into the dark. Its young can be hooked in The Abyss now.`
      : `${ev.def.name} took the whole crew. It will come back.`);

    // Everyone comes back either way — the island is not done with you.
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
