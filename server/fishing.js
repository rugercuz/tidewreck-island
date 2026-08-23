// =============================================================
// TIDEWRECK ISLAND - server/fishing.js
// Pure fishing logic. NO socket code, NO state: every function is
// deterministic given its arguments (plus Math.random). Used by
// server/game.js to resolve casts.
// =============================================================

import {
  FISH,
  MUTATIONS,
  ECON,
  WEATHER,
  CAST_PERFECT,
  LOOT_TYPES,
  LOOT_TABLES,
  FOUND_BAITS,
  UNIQUE_CHARMS,
  shopById,
  fishValue,
} from '../shared/constants.js';

// ---------------- Precomputed lookups ----------------

/** tier -> array of fish defs (built once at module load). */
const FISH_BY_TIER = new Map();
for (const f of FISH) {
  let list = FISH_BY_TIER.get(f.tier);
  if (!list) { list = []; FISH_BY_TIER.set(f.tier, list); }
  list.push(f);
}

/** Mutation ids ordered rarest-first so the rarest ones get first pick of the roll. */
const MUTATION_KEYS = Object.keys(MUTATIONS)
  .sort((a, b) => MUTATIONS[a].chance - MUTATIONS[b].chance);

/** Tier at which fish become event-locked "Tier X" creatures. */
export const TIER_X = 11;

/** Tiers that hold at least one weather-exclusive species (cheap fast path). */
const WEATHER_LOCKED_TIERS = new Set(FISH.filter(f => f.weather).map(f => f.tier));

/** Small difficulty nudge applied to the tier-weighting curve. */
const DIFFICULTY_TIER_BONUS = { chill: 0.05, normal: 0, hard: -0.03 };

/**
 * Extra rarity damper on Tier X creatures. They sit one step above the Abyss's
 * top tier on the curve, but they are the run's trophies (each yields a
 * permanent artifact) so they get an additional weight multiplier on top.
 */
const TIER_X_RARITY = 0.35;

// ---------------- Tiny helpers ----------------

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function roundTo(v, places) {
  const m = Math.pow(10, places);
  return Math.round(v * m) / m;
}

// ---------------- Perfect cast ----------------

/**
 * The client owns the power meter, so it reports whether the release landed in
 * CAST_PERFECT.BAND. The reward is fixed here: exactly LUCK_BONUS extra luck
 * and exactly a BITE_SPEED_MULT-times shorter wait, no matter what the wire
 * claims. Anything that is not a literal `true` is an ordinary cast.
 */
const PERFECT_LUCK_BONUS = Math.max(0, num(CAST_PERFECT && CAST_PERFECT.LUCK_BONUS, 0.45));
const PERFECT_BITE_MULT = Math.max(1, num(CAST_PERFECT && CAST_PERFECT.BITE_SPEED_MULT, 1.35));
const PERFECT_MIN_DELAY = 0.3;

/** Sanitize a wire `perfect` flag: only a real boolean true counts. */
export function isPerfectCast(v) { return v === true; }

/** The exact, capped perfect-cast reward — exported for tuning/tests. */
export function perfectCastBonus() {
  return { luck: PERFECT_LUCK_BONUS, biteMult: PERFECT_BITE_MULT };
}

// ---------------- Weather ----------------

/**
 * Normalize a weather argument (type string, WEATHER def, or a
 * `{type}` payload) into a WEATHER key, or null when unknown.
 */
export function weatherKey(weather) {
  if (!weather) return null;
  if (typeof weather === 'string') return WEATHER[weather] ? weather : null;
  if (typeof weather === 'object' && typeof weather.type === 'string') {
    return WEATHER[weather.type] ? weather.type : null;
  }
  return null;
}

/** WEATHER definition for whatever the caller passed, or null. */
export function weatherDef(weather) {
  const key = weatherKey(weather);
  return key ? WEATHER[key] : null;
}

// ---------------- Bait / luck ----------------

/** Found-only baits (chest loot) keyed by id — they are NOT in SHOP. */
const FOUND_BAIT_BY_ID = new Map(
  (Array.isArray(FOUND_BAITS) ? FOUND_BAITS : [])
    .filter(b => b && typeof b.id === 'string')
    .map(b => [b.id, b]),
);

/**
 * Definition for any bait id the player can actually own: the shop stock
 * first, then the found-only baits that only ever drop out of chests.
 * Returns null for anything else (including prototype keys off the wire).
 */
export function baitDef(id) {
  if (typeof id !== 'string') return null;
  const shop = shopById(id);
  if (shop && shop.kind === 'bait') return shop;
  return FOUND_BAIT_BY_ID.get(id) || null;
}

/**
 * Normalize whatever the caller passes (bait id string, SHOP/FOUND_BAITS def,
 * or null) into a bait definition, or null when there is no bait on the hook.
 */
export function resolveBait(bait) {
  if (!bait) return null;
  if (typeof bait === 'string') return baitDef(bait);
  if (typeof bait === 'object') {
    if (bait.kind === 'bait') return bait;
    if (typeof bait.id === 'string' && FOUND_BAIT_BY_ID.has(bait.id)) return bait;
  }
  return null;
}

/**
 * Total luck for a cast. Charms and the active bait stack MULTIPLICATIVELY
 * (per the SHOP comment in shared/constants.js): total = PROD(1 + luck_i) - 1.
 * A unique charm's `luckAdd` is added flat on top of that.
 * Returns 0 when the player owns nothing lucky.
 */
export function computeLuck(gear, bait, uniques) {
  let mult = 1;
  const charms = gear && Array.isArray(gear.charms) ? gear.charms : [];
  for (const id of charms) {
    const def = shopById(id);
    if (def && def.kind === 'charm' && Number.isFinite(def.luck)) mult *= (1 + def.luck);
  }
  const b = resolveBait(bait);
  if (b && Number.isFinite(b.luck)) mult *= (1 + b.luck);
  return Math.max(0, mult - 1 + uniqueEffects(uniques).luckAdd);
}

/** True when this bait is the mutation-doubling Voidbait. */
export function isVoidbait(bait) {
  const b = resolveBait(bait);
  return !!b && b.id === 'voidbait';
}

// ---------------- Unique charms (one of each per run) ----------------

/** Every unique-charm effect at its no-op value. */
function neutralEffects() {
  return { airMult: 1, biteSpeed: 1, meleeMult: 1, luckAdd: 0, sellMult: 1 };
}

/** UNIQUE_CHARMS entry for an id, own-property only (never a prototype key). */
export function uniqueCharmDef(id) {
  if (typeof id !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(UNIQUE_CHARMS, id) ? UNIQUE_CHARMS[id] : null;
}

/**
 * Compose everything a player's claimed unique charms do into one bundle:
 * { airMult, biteSpeed, meleeMult, luckAdd, sellMult }. Multipliers multiply,
 * addends add. Accepts an id array, a single id, or an already-composed
 * bundle (so callers can pass whichever they have to hand). Unknown ids and
 * malformed values are ignored — the result is always finite and sane.
 */
export function uniqueEffects(uniques) {
  const out = neutralEffects();
  if (!uniques) return out;

  if (typeof uniques === 'object' && !Array.isArray(uniques)) {
    for (const key of Object.keys(out)) {
      const v = uniques[key];
      if (Number.isFinite(v)) out[key] = v;
    }
    return out;
  }

  const list = typeof uniques === 'string' ? [uniques] : uniques;
  if (!Array.isArray(list)) return out;
  for (const id of list) {
    const def = uniqueCharmDef(id);
    if (!def) continue;
    const effect = typeof def.effect === 'string' ? def.effect : '';
    if (effect === 'luckAdd') {
      out.luckAdd += Math.max(0, num(def.add, 0));
    } else if (Object.prototype.hasOwnProperty.call(out, effect)) {
      out[effect] *= clamp(num(def.mult, 1), 0.1, 10);
    }
  }
  return out;
}

// ---------------- Underwater loot ----------------

/** The LOOT_TABLES spawn table for an area id, or null when it has none. */
export function lootTableFor(areaId) {
  if (typeof areaId !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(LOOT_TABLES, areaId)) return null;
  const table = LOOT_TABLES[areaId];
  return Array.isArray(table) && table.length ? table : null;
}

/** LOOT_TYPES entry for a node type id, own-property only. */
export function lootTypeDef(id) {
  if (typeof id !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(LOOT_TYPES, id) ? LOOT_TYPES[id] : null;
}

/**
 * Roll one treasure node for an area: weighted pick over its LOOT_TABLES rows
 * plus the money it is worth. Returns null for an area with no table.
 */
export function rollLootDrop(areaId) {
  const table = lootTableFor(areaId);
  if (!table) return null;

  let total = 0;
  for (const row of table) total += Math.max(0, num(row && row.weight, 0));

  let entry = table[table.length - 1];
  if (total > 0) {
    let r = Math.random() * total;
    for (const row of table) {
      r -= Math.max(0, num(row && row.weight, 0));
      if (r <= 0) { entry = row; break; }
    }
  }
  if (!entry || typeof entry.id !== 'string') return null;

  const def = lootTypeDef(entry.id);
  const lo = num(entry.value && entry.value[0], 10);
  const hi = Math.max(lo, num(entry.value && entry.value[1], lo));
  return {
    type: entry.id,
    name: def ? def.name : entry.id,
    model: def ? def.model : entry.id,
    desc: def ? def.desc : '',
    value: Math.max(1, Math.round(lo + Math.random() * (hi - lo))),
  };
}

/** A found-only bait stack out of a chest: { id, name, pack, def }. */
export function rollFoundBait() {
  const list = Array.isArray(FOUND_BAITS)
    ? FOUND_BAITS.filter(b => b && typeof b.id === 'string')
    : [];
  if (!list.length) return null;
  const b = list[Math.floor(Math.random() * list.length) % list.length];
  return {
    id: b.id,
    name: typeof b.name === 'string' ? b.name : b.id,
    pack: Math.max(1, Math.floor(num(b.pack, 4))),
    def: b,
  };
}

/** Membership test that works for a Set, Map, array or plain object. */
function isClaimed(claimed, id) {
  if (!claimed) return false;
  if (typeof claimed.has === 'function') return !!claimed.has(id);
  if (Array.isArray(claimed)) return claimed.indexOf(id) !== -1;
  if (typeof claimed === 'object') return !!Object.prototype.hasOwnProperty.call(claimed, id);
  return false;
}

/** Unique charms this area can still hand out, given what is already claimed. */
export function unclaimedUniquesFor(areaId, claimed) {
  if (typeof areaId !== 'string') return [];
  return Object.keys(UNIQUE_CHARMS).filter((id) => {
    if (isClaimed(claimed, id)) return false;
    const areas = UNIQUE_CHARMS[id].areas;
    return Array.isArray(areas) && areas.indexOf(areaId) !== -1;
  });
}

/** Pick one unclaimed unique charm for this area, or null when none is left. */
export function rollUniqueCharm(areaId, claimed) {
  const pool = unclaimedUniquesFor(areaId, claimed);
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length) % pool.length];
}

// ---------------- Bite timing ----------------

/**
 * Seconds to wait between CAST_START and BITE. Baseline is the 2-6 s band
 * from the design doc; better rods and greedier baits pull it tighter, and
 * the weather's biteSpeed divides the whole window (storms bite fast).
 * A unique charm's biteSpeed multiplies the weather's on top of that.
 * A PERFECT throw divides the finished delay by exactly
 * CAST_PERFECT.BITE_SPEED_MULT — outside the weather/charm clamp so the
 * bonus is always the advertised one, never more.
 */
export function rollBiteDelay(gear, bait, weather, uniques, perfect) {
  const rod = clamp(Math.floor(num(gear && gear.rod, 1)), 1, 5);
  const b = resolveBait(bait);
  const bias = b ? num(b.tierBias, 0) : 0;

  let lo = 2.0 - (rod - 1) * 0.18 - bias * 0.12;
  let hi = 6.0 - (rod - 1) * 0.55 - bias * 0.35;
  lo = Math.max(1.0, lo);
  hi = Math.max(lo + 0.9, hi);

  const wdef = weatherDef(weather);
  const weatherSpeed = wdef ? num(wdef.biteSpeed, 1) : 1;
  const speed = clamp(weatherSpeed * uniqueEffects(uniques).biteSpeed, 0.25, 6);

  let delay = Math.max(0.5, (lo + Math.random() * (hi - lo)) / speed);
  if (isPerfectCast(perfect)) delay = Math.max(PERFECT_MIN_DELAY, delay / PERFECT_BITE_MULT);
  return roundTo(delay, 2);
}

/**
 * Reel-minigame difficulty for a hooked fish, 0..1, scaled by tier.
 * Tier 1 nibblers barely tug; Tier X creatures nearly rip the rod away.
 */
export function biteStrength(tier) {
  const t = clamp(num(tier, 1), 1, TIER_X);
  return roundTo(clamp(0.12 + 0.88 * ((t - 1) / 10), 0.1, 1), 3);
}

// ---------------- Species availability ----------------

/**
 * Which species can actually be pulled out of `area` at `tier` right now.
 * Tier X fish are Abyss-only and stay locked until the team has survived
 * the matching horror event. Weather-exclusive species (FISH[].weather)
 * only join their tier's pool while that weather is actually running.
 */
export function speciesForTier(tier, area, eventsSurvived, weather) {
  const list = FISH_BY_TIER.get(tier);
  if (!list || !list.length) return [];
  if (tier < TIER_X) {
    if (!WEATHER_LOCKED_TIERS.has(tier)) return list;
    const w = weatherKey(weather);
    return list.filter(f => !f.weather || f.weather === w);
  }
  if (!area || area.id !== 'abyss') return [];
  const survived = Array.isArray(eventsSurvived) ? eventsSurvived : [];
  return list.filter(f => f.requiresEvent && survived.indexOf(f.requiresEvent) !== -1);
}

/**
 * Ordered list of { tier, species[] } currently catchable in `area`.
 * Index 0 is the area's floor tier — the exponential rarity curve is
 * applied against that index.
 */
export function candidateTiers(area, eventsSurvived, weather) {
  const out = [];
  if (!area || !Array.isArray(area.tiers)) return out;
  const minT = Math.floor(num(area.tiers[0], 1));
  const maxT = Math.floor(num(area.tiers[1], minT));
  for (let t = minT; t <= maxT; t++) {
    const species = speciesForTier(t, area, eventsSurvived, weather);
    if (species.length) out.push({ tier: t, species });
  }
  return out;
}

// ---------------- Mutations ----------------

/**
 * Roll AT MOST ONE mutation. Base chances come from MUTATIONS and are scaled
 * by (1 + totalLuck), doubled again when fishing with Voidbait.
 * Returns a mutation id string, or null.
 */
export function rollMutation(luck, bait) {
  const mult = (1 + Math.max(0, num(luck, 0))) * (isVoidbait(bait) ? 2 : 1);
  let r = Math.random();
  for (const key of MUTATION_KEYS) {
    const chance = Math.min(0.9, MUTATIONS[key].chance * mult);
    if (r < chance) return key;
    r -= chance;
  }
  return null;
}

// ---------------- The main roll ----------------

/**
 * Resolve a successful reel into a concrete catch.
 *
 * @param {object} opts
 * @param {object} opts.area            AREAS entry the line is in
 * @param {object} opts.gear            { rod, charms:[], ... }
 * @param {string|object} [opts.baits]  active bait id / def (alias: opts.bait)
 * @param {number} [opts.luck]          precomputed total luck (else derived)
 * @param {string[]} [opts.eventsSurvived]
 * @param {string} [opts.difficulty]    'chill' | 'normal' | 'hard'
 * @param {string} [opts.weather]       active WEATHER key ('clear' when absent)
 * @param {boolean} [opts.perfect]      the throw landed in CAST_PERFECT.BAND
 * @returns {{fish:object, tier:number, mutation:string|null, weightKg:number, value:number}|null}
 */
export function rollFish(opts) {
  const o = opts || {};
  const area = o.area;
  if (!area) return null;

  const gear = o.gear || { rod: 1, charms: [] };
  const bait = resolveBait(o.baits !== undefined ? o.baits : o.bait);
  const eventsSurvived = Array.isArray(o.eventsSurvived) ? o.eventsSurvived : [];
  const weather = weatherKey(o.weather);
  const wdef = weather ? WEATHER[weather] : null;

  // Weather stacks ADDITIVELY on top of gear/bait luck and bait tier bias,
  // and a PERFECT throw adds exactly CAST_PERFECT.LUCK_BONUS for this cast.
  const perfect = isPerfectCast(o.perfect);
  const baseLuck = Number.isFinite(o.luck) ? o.luck : computeLuck(gear, bait);
  const luck = Math.max(0, baseLuck
    + (wdef ? num(wdef.luck, 0) : 0)
    + (perfect ? PERFECT_LUCK_BONUS : 0));

  const tiers = candidateTiers(area, eventsSurvived, weather);
  if (!tiers.length) return null;

  // --- tier selection -------------------------------------------------
  // Higher tiers are exponentially rarer: weight = base^tierIndex.
  // base 0.5 = each step up is half as likely; rod overshoot, bait + weather
  // tierBias, luck and difficulty all raise `base`, flattening the curve upward.
  const rod = clamp(Math.floor(num(gear.rod, 1)), 1, 5);
  const areaRodReq = Math.max(1, Math.floor(num(area.unlock && area.unlock.rod, 1)));
  const rodBonus = Math.max(0, rod - areaRodReq);
  const tierBias = (bait ? num(bait.tierBias, 0) : 0) + (wdef ? num(wdef.tierBias, 0) : 0);
  const diffBonus = DIFFICULTY_TIER_BONUS[o.difficulty] !== undefined
    ? DIFFICULTY_TIER_BONUS[o.difficulty] : 0;

  const luckFactor = clamp(
    rodBonus * 0.07 + tierBias * 0.06 + Math.max(0, luck) * 0.10 + diffBonus,
    -0.2, 0.36,
  );
  const base = clamp(0.5 + luckFactor, 0.2, 0.88);

  let total = 0;
  const weights = new Array(tiers.length);
  for (let i = 0; i < tiers.length; i++) {
    let w = Math.pow(base, i);
    if (tiers[i].tier >= TIER_X) w *= TIER_X_RARITY;
    weights[i] = w;
    total += w;
  }

  let r = Math.random() * total;
  let picked = tiers.length - 1;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) { picked = i; break; }
  }

  const entry = tiers[picked];
  const species = entry.species;
  const fish = species[Math.floor(Math.random() * species.length) % species.length];
  if (!fish) return null;

  // --- mutation, weight, value ---------------------------------------
  const mutation = rollMutation(luck, bait);

  const kgMin = num(fish.kg && fish.kg[0], 0.1);
  const kgMax = Math.max(kgMin, num(fish.kg && fish.kg[1], kgMin));
  const raw = kgMin + Math.random() * (kgMax - kgMin);
  const weightKg = roundTo(raw, raw < 1 ? 3 : 2);

  const value = Math.max(1, fishValue(fish, weightKg, mutation));

  return { fish, tier: fish.tier, mutation, weightKg, value };
}

/**
 * Convenience wrapper: everything game.js needs to build a CAST_RESULT
 * payload, including the pre-rolled bite strength for the minigame.
 */
export function rollCatch(opts) {
  const roll = rollFish(opts);
  if (!roll) return null;
  return {
    fish: roll.fish,
    fishId: roll.fish.id,
    name: roll.fish.name,
    tier: roll.tier,
    mutation: roll.mutation,
    weightKg: roll.weightKg,
    value: roll.value,
    strength: biteStrength(roll.tier),
  };
}

/** Exported for tuning/tests: the weight-to-value curve exponent in use. */
export const WEIGHT_VALUE_EXP = ECON.WEIGHT_VALUE_EXP;
