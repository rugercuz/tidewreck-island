// =============================================================
// TIDEWRECK ISLAND - shared game data & network protocol
// Imported by BOTH the Node server (../shared/constants.js)
// and the browser client (/shared/constants.js). ES module, no deps.
// =============================================================

// ---------------- Network protocol ----------------
export const MSG = {
  // client -> server (lobby)
  CREATE_ROOM: 'createRoom',      // {playerName, color, roomName, maxPlayers, difficulty}
  JOIN_ROOM: 'joinRoom',          // {playerName, color, code}
  LEAVE_ROOM: 'leaveRoom',        // {}
  SET_READY: 'setReady',          // {ready}
  START_GAME: 'startGame',        // {} (host only)
  // client -> server (in game)
  MOVE: 'move',                   // {p:[x,y,z], r:yaw, anim, swimming, onBoat}  ~12Hz
  BOARD_BOAT: 'boardBoat',        // {seat} seat 0 = driver
  LEAVE_BOAT: 'leaveBoat',        // {}
  DRIVE_BOAT: 'driveBoat',        // {p:[x,y,z], r:yaw, vel:[x,y,z]} driver only, ~12Hz
  CAST_START: 'castStart',        // {areaId, baitId}
  REEL_DONE: 'reelDone',          // {success:boolean}
  CANCEL_CAST: 'cancelCast',      // {}
  SELL_FISH: 'sellFish',          // {invIds:[...]} sell from personal inventory -> team wallet + quota
  BUY_ITEM: 'buyItem',            // {itemId}
  DAMAGE_ENEMY: 'damageEnemy',    // {enemyId, dmg, weaponId}
  PLAYER_HIT: 'playerHit',        // {dmg, cause} client reports taking damage
  BUILD_PORTAL: 'buildPortal',    // {}
  ENTER_PORTAL: 'enterPortal',    // {}
  CHAT: 'chat',                   // {text}
  BONK_FISH: 'bonkFish',          // {flopperId, dmg} whack your landed catch to finish it
  PICKUP_FLOPPER: 'pickupFlopper',// {flopperId} grab your killed catch off the deck
  PICKUP_LOOT: 'pickupLoot',      // {lootId} grab an underwater treasure you are next to
  REVIVE_TEAMMATE: 'reviveTeammate', // {targetId} finish a hold-E revive on a downed teammate (consumes Sea Salts)
  USE_REVIVAL_KIT: 'useRevivalKit',  // {} self-revive while downed (consumes your Revival Kit)
  TOW_BODY: 'towBody',            // {targetId|null} Rescue Claw: start/stop towing a downed teammate's body

  // server -> client
  ROOM_STATE: 'roomState',        // full lobby state {code, name, players:[], hostId, settings, started}
  ERROR_MSG: 'errorMsg',          // {message}
  GAME_START: 'gameStart',        // {world:{seed}, you:{id}, state:<WORLD_STATE payload>}
  WORLD_STATE: 'worldState',      // 1Hz {day, timeOfDay, wallet, quota:{n, target, progress, deadlineDay}, wards, artifacts:[], eventsSurvived:[], portalBuilt, players:[{id,name,color,gear}], enemiesEnabled}
  PLAYERS_MOVE: 'playersMove',    // ~12Hz {list:[{id,p,r,anim,swimming,onBoat}]}
  BOAT_STATE: 'boatState',        // relay of DRIVE_BOAT + {driverId, seats:[playerId|null]}
  BITE: 'bite',                   // {strength} a fish bit your line -> start reel minigame
  CAST_RESULT: 'castResult',      // {caught, fish:{invId, fishId, name, tier, mutation, weightKg, value}, newRecord}
  INVENTORY: 'inventory',        // {items:[{invId, fishId, mutation, weightKg, value}], baits:{baitId:count}}
  WALLET: 'wallet',               // {wallet, quotaProgress}
  SHOP_RESULT: 'shopResult',      // {ok, itemId, message, gear} gear = your updated gear
  ENEMY_STATE: 'enemyState',      // ~8Hz {list:[{id, type, p:[x,y,z], r, hp, state}]}
  ENEMY_HIT: 'enemyHit',          // {enemyId, hp, byId}
  PLAYER_DAMAGED: 'playerDamaged',// {id, hp, cause}
  EVENT_START: 'eventStart',      // {type:'serpent'|'kraken'|'bloop'}  MUSIC CUTS. day->night.
  EVENT_PHASE: 'eventPhase',      // {type, phase, data} coarse scripting from server
  EVENT_END: 'eventEnd',          // {type, survived, unlocked} unlocked = tierX fishId now catchable
  QUOTA_DONE: 'quotaDone',        // {n, nextTarget, deadlineDay, bonus}
  TSUNAMI_WARNING: 'tsunamiWarning', // {daysLeft} sent daily when <= 2 days
  TSUNAMI: 'tsunami',             // {} wave cinematic -> game over follows
  GAME_OVER: 'gameOver',          // {reason:'tsunami'|'wipe', stats}
  GAME_WON: 'gameWon',            // {stats} portal escape!
  PORTAL_STATE: 'portalState',    // {built, canBuild, missing:[artifactIds]}
  CHAT_MSG: 'chatMsg',            // {fromName, text}
  WEATHER: 'weather',             // {type, until} weather changed (also included in WORLD_STATE)
  FLOPPER: 'flopper',             // {state:'spawn'|'hit'|'dead'|'stowed'|'escaped', flopperId, fish?, hp?, maxHp?}
                                  // 'dead' = killed, now a glowing pickup; 'stowed' = banked to inventory
  LIGHTNING: 'lightning',         // {p:[x,y,z], targetId|null} a strike lands (storm hazard)
  LOOT_STATE: 'lootState',        // {areaId, list:[{id, type, p:[x,z]}]} live treasure nodes for your area
  LOOT_RESULT: 'lootResult',      // {ok, lootId, name, kind, value?, itemId?, uniqueId?, message}
  REVIVED: 'revived',             // {id, by|null, hp} a downed player is back up ('by' null = self/sunrise)
  BODY_TOWED: 'bodyTowed',        // {id, by|null} a downed body is being towed by the Rescue Claw (null = released)
};

// ---------------- Perfect cast ----------------
// The cast power meter gets a marked sweet band near the top. Release inside
// it = PERFECT THROW: bonus luck + faster bite for that one cast. The client
// detects the timing (it owns the meter) and sends perfect:true in CAST_START;
// the server caps the benefit to exactly these numbers.
export const CAST_PERFECT = {
  BAND: [0.78, 0.92],   // power fraction window (the two lines on the meter)
  LUCK_BONUS: 0.45,     // added to total luck for that cast
  BITE_SPEED_MULT: 1.35 // bite delay divided by this
};

// ---------------- Reviving ----------------
// A downed player stays down where they fell (bodies sink underwater).
// Sea Salts: hold E next to a downed teammate (not underwater) to revive them.
// Revival Kit: expensive self-revive, press when downed. Rescue Claw: E on an
// underwater body grabs it; it follows you until you surface/release.
// Sunrise still revives everyone as the mercy backstop — but if the WHOLE crew
// is down at once, the island gives up on you: instant doomsday tsunami.
export const REVIVE = {
  SALTS_HOLD_SECONDS: 3,   // hold-E channel time
  SALTS_RANGE: 3,          // metres from the body
  SALTS_HP: 0.5,           // revived at 50% hp
  KIT_HP: 0.4,             // self-revive at 40% hp
  CLAW_RANGE: 3.5,         // grab range for the Rescue Claw
  NO_SALTS_UNDERWATER: true // bodies must be brought to air first (that's the claw's job)
};

// ---------------- Underwater loot (dive to find it) ----------------
// Nodes spawn on the seabed inside fishing areas. Swim down, get close, press E.
// The client snaps node meshes to its seabed; the server tracks XZ + ownership.
export const LOOT_TYPES = {
  clam:    { name: 'Pearl Clam',          model: 'clam',   desc: 'Pry it open for the pearl.' },
  coins:   { name: 'Coin Stash',          model: 'coins',  desc: 'Someone else\'s bad day.' },
  bottle:  { name: 'Message in a Bottle', model: 'bottle', desc: 'Soggy treasure map? Cash it in.' },
  chest:   { name: 'Sunken Chest',        model: 'chest',  desc: 'Latched but not locked. Could hold anything.' },
  relic:   { name: 'Ancient Relic',       model: 'relic',  desc: 'Older than the island. Collectors pay well.' },
  geode:   { name: 'Abyssal Geode',       model: 'geode',  desc: 'It glows from the inside.' },
};
// Per-area spawn tables: weight = relative spawn odds, value = [min,max] money.
// Chests roll money AND can contain a found-only bait stack or a unique charm.
export const LOOT_TABLES = {
  shallows:  [ { id: 'clam', weight: 60, value: [40, 90] },    { id: 'bottle', weight: 30, value: [30, 80] },   { id: 'coins', weight: 10, value: [60, 120] } ],
  reef:      [ { id: 'clam', weight: 45, value: [60, 140] },   { id: 'coins', weight: 30, value: [90, 180] },   { id: 'chest', weight: 15, value: [150, 300] }, { id: 'bottle', weight: 10, value: [50, 110] } ],
  kelp:      [ { id: 'coins', weight: 40, value: [140, 260] }, { id: 'clam', weight: 25, value: [90, 190] },    { id: 'chest', weight: 20, value: [250, 450] }, { id: 'relic', weight: 15, value: [400, 700] } ],
  openocean: [ { id: 'coins', weight: 35, value: [220, 420] }, { id: 'chest', weight: 30, value: [400, 750] },  { id: 'relic', weight: 25, value: [600, 1100] }, { id: 'clam', weight: 10, value: [150, 300] } ],
  trench:    [ { id: 'chest', weight: 35, value: [800, 1500] },{ id: 'relic', weight: 30, value: [1100, 2000] },{ id: 'geode', weight: 20, value: [1600, 2800] }, { id: 'coins', weight: 15, value: [450, 800] } ],
  abyss:     [ { id: 'geode', weight: 35, value: [3000, 5500] },{ id: 'chest', weight: 30, value: [1800, 3200] },{ id: 'relic', weight: 25, value: [2200, 4000] }, { id: 'coins', weight: 10, value: [900, 1500] } ],
};
export const LOOT_RULES = {
  NODES_PER_AREA: 5,           // live nodes maintained per area
  RESPAWN_SECONDS: 150,        // a taken node regrows elsewhere in the area after this
  PICKUP_RANGE: 4,             // horizontal metres; must also be near the seabed
  CHEST_BAIT_CHANCE: 0.35,     // chest bonus roll: found-only bait stack
  CHEST_UNIQUE_CHANCE: 0.15,   // chest bonus roll: an unclaimed unique charm (deep areas only)
};
// Found-only baits (never sold in the shop) - come from chests.
export const FOUND_BAITS = [
  { id: 'glowgrub',   name: 'Glow Grub',   pack: 6, tierBias: 1.2, luck: 0.25, desc: 'Wriggles with its own light. Fish stare.' },
  { id: 'abyssleech', name: 'Abyss Leech', pack: 4, tierBias: 2.5, luck: 0.4,  desc: 'It found YOU. Monsters cannot resist it.' },
];
// Unique charms: ONE of each exists per run - first crew member to open the
// right chest claims it. Server applies the effect for that player.
export const UNIQUE_CHARMS = {
  pearlheart:   { name: 'Pearl of the Deep', effect: 'airMult',    mult: 1.6,  areas: ['openocean', 'trench', 'abyss'], desc: 'Your lungs forget to burn. +60% air.' },
  sirenlocket:  { name: "Siren's Locket",    effect: 'biteSpeed',  mult: 1.35, areas: ['kelp', 'openocean', 'trench', 'abyss'], desc: 'Fish come when it hums. Bites 35% faster.' },
  barnacleidol: { name: 'Barnacle Idol',     effect: 'meleeMult',  mult: 1.5,  areas: ['reef', 'kelp', 'openocean', 'trench'], desc: 'Your arms remember older tides. +50% melee damage.' },
  drownedcrown: { name: 'Drowned Crown',     effect: 'luckAdd',    add: 0.75,  areas: ['trench', 'abyss'], desc: 'Royalty of the deep. +75% luck.' },
  tidalbell:    { name: 'Tidal Bell',        effect: 'sellMult',   mult: 1.15, areas: ['openocean', 'trench', 'abyss'], desc: 'Merchants hear it and pay 15% more.' },
};

// ---------------- Weather ----------------
// Server rerolls weather at dawn and dusk (weighted random). Pity system:
// PITY_CLEAR_DAYS without rain/storm forces one (60% storm / 40% rain).
// Effects: waveScale multiplies ocean wave amplitude (client shader + CPU fn must
// use it), luck/tierBias add to fishing rolls, biteSpeed divides bite delay,
// eventChanceMult multiplies nightly horror-event odds. weight = random pick weight.
export const WEATHER = {
  clear:    { name: 'Clear Skies',  waveScale: 1.0, luck: 0,    tierBias: 0,   biteSpeed: 1.0, eventChanceMult: 1.0, weight: 34 },
  overcast: { name: 'Overcast',     waveScale: 1.4, luck: 0.05, tierBias: 0.3, biteSpeed: 1.1, eventChanceMult: 1.2, weight: 22 },
  fog:      { name: 'Dead Fog',     waveScale: 0.8, luck: 0.10, tierBias: 0.5, biteSpeed: 0.9, eventChanceMult: 1.5, weight: 14,
              hazard: 'Visibility collapses. Predators hunt bolder (+50% aggro range).' },
  rain:     { name: 'Rain Squall',  waveScale: 1.9, luck: 0.15, tierBias: 0.8, biteSpeed: 1.3, eventChanceMult: 1.6, weight: 18,
              hazard: 'Heavy chop. The boat wallows and drifts.' },
  storm:    { name: 'Thunderstorm', waveScale: 2.8, luck: 0.30, tierBias: 1.5, biteSpeed: 1.5, eventChanceMult: 2.5, weight: 12,
              hazard: 'Lightning strikes open water. Monstrous waves.' },
};
export const WEATHER_RULES = {
  CHANGES_PER_DAY: 2,             // reroll at dawn (timeOfDay ~0.06) and dusk (NIGHT_START)
  PITY_CLEAR_DAYS: 2,             // days without rain/storm before pity forces one
  PITY_STORM_CHANCE: 0.6,         // pity picks storm 60% / rain 40%
  LIGHTNING_PERIOD: [6, 14],      // seconds between strikes during a storm
  LIGHTNING_DMG: 20,              // players on open water (not on island, above surface) can be hit
  FOG_AGGRO_MULT: 1.5,
};

// ---------------- Landed-catch bonking ----------------
// A caught fish lands on deck ALIVE and flopping. Whack it (bare hands or any
// melee weapon) until its flopper HP hits 0 to stow it in your inventory.
// Ignore it too long and it flops back into the sea.
export const FLOPPER = {
  BASE_HP: 10,
  HP_PER_TIER: 5,      // flopperHp = BASE_HP + tier * HP_PER_TIER
  HAND_DMG: 10,        // barehand whack (no weapon needed, slower swing)
  ESCAPE_SECONDS: 25,
};

// ---------------- Mutations (special fish effects) ----------------
// chance = base chance per catch, scaled by player luck. Exactly one may roll.
export const MUTATIONS = {
  golden:   { name: 'Golden',   valueMult: 5,  chance: 1 / 80,  desc: 'Gleams like treasure',            tint: 0xffc832, emissive: 0xaa7700, fx: 'sparkle' },
  rainbow:  { name: 'Rainbow',  valueMult: 8,  chance: 1 / 200, desc: 'Cycles through every color',      tint: 0xffffff, emissive: 0x000000, fx: 'hueShift' },
  void:     { name: 'Void',     valueMult: 12, chance: 1 / 400, desc: 'Light does not escape it',        tint: 0x0a0014, emissive: 0x4400aa, fx: 'voidParticles' },
  spectral: { name: 'Spectral', valueMult: 6,  chance: 1 / 150, desc: 'Half here, half elsewhere',       tint: 0xaaddff, emissive: 0x3388cc, fx: 'ghost' },
  molten:   { name: 'Molten',   valueMult: 7,  chance: 1 / 250, desc: 'Veins of live magma',             tint: 0x331100, emissive: 0xff4400, fx: 'embers' },
  crystal:  { name: 'Crystal',  valueMult: 6,  chance: 1 / 150, desc: 'Frozen mid-shimmer',              tint: 0xbbeeff, emissive: 0x66aacc, fx: 'facets' },
};

// ---------------- Fish catalog ----------------
// model: hints for the procedural fish factory in public/js/fish.js
//   shape: 'slim' | 'round' | 'flat' | 'eel' | 'shark' | 'squid' | 'octopus' | 'ray' | 'angler' | 'serpent' | 'blob'
//   size: rough body length in meters for the CAUGHT version shown to players
// value: base sale price (before weight/mutation multipliers)
export const FISH = [
  // --- Tier 1 - Shallows nibblers ---
  { id: 'sardine',    name: 'Sardine',            tier: 1,  value: 6,    kg: [0.05, 0.2],  model: { shape: 'slim',  size: 0.18, colors: [0xb8c6d0, 0x7d8f9b], belly: 0xe8eef2 } },
  { id: 'anchovy',    name: 'Anchovy',            tier: 1,  value: 5,    kg: [0.03, 0.15], model: { shape: 'slim',  size: 0.14, colors: [0x9fb2bf, 0x5f7280], belly: 0xdfe8ee } },
  { id: 'minnow',     name: 'Glass Minnow',       tier: 1,  value: 4,    kg: [0.02, 0.08], model: { shape: 'slim',  size: 0.09, colors: [0xcfe4ea, 0xa5c8d2], belly: 0xf2fbff } },
  { id: 'tidenibbler',name: 'Tide Nibbler',       tier: 1,  value: 9,    kg: [0.1, 0.3],   model: { shape: 'round', size: 0.16, colors: [0xf2a65a, 0xc97b2d], belly: 0xffe0b8 } },
  // --- Tier 2 ---
  { id: 'herring',    name: 'Herring',            tier: 2,  value: 16,   kg: [0.2, 0.7],   model: { shape: 'slim',  size: 0.3,  colors: [0x8fb4c9, 0x4f7489], belly: 0xe6f2f8 } },
  { id: 'mackerel',   name: 'Striped Mackerel',   tier: 2,  value: 22,   kg: [0.4, 1.2],   model: { shape: 'slim',  size: 0.38, colors: [0x3f6f8f, 0x2a4a60], belly: 0xd8e8f0, stripes: 0x1a2e3c } },
  { id: 'perch',      name: 'Sunny Perch',        tier: 2,  value: 19,   kg: [0.3, 1.0],   model: { shape: 'round', size: 0.28, colors: [0xd9a441, 0xa5741f], belly: 0xf5dfa8, stripes: 0x7a5312 } },
  { id: 'mudwhisker', name: 'Mudwhisker',         tier: 2,  value: 25,   kg: [0.5, 2.0],   model: { shape: 'round', size: 0.42, colors: [0x6f5b43, 0x4a3b28], belly: 0xb5a488, whiskers: true } },
  // --- Tier 3 ---
  { id: 'cod',        name: 'Cod',                tier: 3,  value: 40,   kg: [1.0, 4.0],   model: { shape: 'round', size: 0.6,  colors: [0x8a7f5f, 0x5d5540], belly: 0xd8d0b8 } },
  { id: 'snapper',    name: 'Coral Snapper',      tier: 3,  value: 48,   kg: [1.0, 3.5],   model: { shape: 'round', size: 0.5,  colors: [0xe0554a, 0xa53328], belly: 0xffcfc0 } },
  { id: 'seabass',    name: 'Sea Bass',           tier: 3,  value: 55,   kg: [1.5, 5.0],   model: { shape: 'round', size: 0.62, colors: [0x748696, 0x46545f], belly: 0xd5dee5 } },
  { id: 'flounder',   name: 'Flounder',           tier: 3,  value: 44,   kg: [0.8, 3.0],   model: { shape: 'flat',  size: 0.5,  colors: [0x9c8a62, 0x6e5f40], belly: 0xe8ddc0 } },
  // --- Tier 4 ---
  { id: 'salmon',     name: 'King Salmon',        tier: 4,  value: 85,   kg: [3.0, 12.0],  model: { shape: 'slim',  size: 0.8,  colors: [0xc0687a, 0x8296a5], belly: 0xf0d8dd } },
  { id: 'puffer',     name: 'Pufferfish',         tier: 4,  value: 95,   kg: [1.0, 4.0],   model: { shape: 'blob',  size: 0.4,  colors: [0xd8c268, 0x9a8a3d], belly: 0xf5ecc5, spikes: true } },
  { id: 'lionfish',   name: 'Lionfish',           tier: 4,  value: 110,  kg: [0.8, 2.0],   model: { shape: 'round', size: 0.38, colors: [0xc25a3a, 0x8a3520], belly: 0xf0d5c5, stripes: 0xf5e8d8, spikes: true } },
  // --- Tier 5 ---
  { id: 'tuna',       name: 'Yellowfin Tuna',     tier: 5,  value: 180,  kg: [15, 80],     model: { shape: 'slim',  size: 1.4,  colors: [0x2f4858, 0x1a2c38], belly: 0xc8d8e0, finTint: 0xf2d038 } },
  { id: 'barracuda',  name: 'Barracuda',          tier: 5,  value: 165,  kg: [8, 25],      model: { shape: 'eel',   size: 1.3,  colors: [0x9aa8b2, 0x5c6a74], belly: 0xe0e8ee, teeth: true } },
  { id: 'mahimahi',   name: 'Mahi-Mahi',          tier: 5,  value: 210,  kg: [10, 30],     model: { shape: 'round', size: 1.1,  colors: [0x35b06a, 0xf2c838], belly: 0xd5f0a8 } },
  { id: 'stingray',   name: 'Stingray',           tier: 5,  value: 195,  kg: [12, 50],     model: { shape: 'ray',   size: 1.2,  colors: [0x5f6a72, 0x3a4248], belly: 0xdde4e8 } },
  // --- Tier 6 ---
  { id: 'swordfish',  name: 'Swordfish',          tier: 6,  value: 380,  kg: [50, 200],    model: { shape: 'slim',  size: 2.2,  colors: [0x4a6a8a, 0x2a3e52], belly: 0xcfdce8, bill: true } },
  { id: 'eleel',      name: 'Electric Eel',       tier: 6,  value: 340,  kg: [10, 25],     model: { shape: 'eel',   size: 1.8,  colors: [0x3a4a3a, 0x222c22], belly: 0xb8c8a0, emissive: 0x66ffaa } },
  { id: 'grouper',    name: 'Giant Grouper',      tier: 6,  value: 420,  kg: [80, 300],    model: { shape: 'round', size: 2.0,  colors: [0x6a5f4a, 0x453d2e], belly: 0xc8bfa5, spots: 0x2e2820 } },
  { id: 'opah',       name: 'Opah',               tier: 6,  value: 460,  kg: [40, 120],    model: { shape: 'round', size: 1.5,  colors: [0xd86a4a, 0x9a3d28], belly: 0xf5c0a8, spots: 0xf0e8e0 } },
  // --- Tier 7 - deep dwellers ---
  { id: 'angler',     name: 'Anglerfish',         tier: 7,  value: 680,  kg: [5, 20],      model: { shape: 'angler',size: 0.9,  colors: [0x2e2233, 0x1a1220], belly: 0x4a3a52, emissive: 0x88ddff, teeth: true } },
  { id: 'fangtooth',  name: 'Fangtooth',          tier: 7,  value: 620,  kg: [2, 8],       model: { shape: 'round', size: 0.5,  colors: [0x3a2828, 0x201414], belly: 0x5c4444, teeth: true } },
  { id: 'viperfish',  name: 'Viperfish',          tier: 7,  value: 740,  kg: [3, 10],      model: { shape: 'eel',   size: 0.8,  colors: [0x1e2e3e, 0x101a24], belly: 0x35485c, emissive: 0x4488cc, teeth: true } },
  { id: 'gulper',     name: 'Gulper Eel',         tier: 7,  value: 820,  kg: [8, 20],      model: { shape: 'eel',   size: 1.6,  colors: [0x14141e, 0x0a0a12], belly: 0x28283c, emissive: 0xff6688 } },
  // --- Tier 8 ---
  { id: 'giantsquid', name: 'Giant Squid',        tier: 8,  value: 1400, kg: [150, 400],   model: { shape: 'squid', size: 3.5,  colors: [0xa5453a, 0x6e2a22], belly: 0xd8a598 } },
  { id: 'goblinshark',name: 'Goblin Shark',       tier: 8,  value: 1250, kg: [100, 250],   model: { shape: 'shark', size: 2.8,  colors: [0xb08a8a, 0x7a5a5a], belly: 0xe0cccc, teeth: true } },
  { id: 'oarfish',    name: 'Oarfish',            tier: 8,  value: 1600, kg: [80, 200],    model: { shape: 'eel',   size: 4.5,  colors: [0xb8c4d0, 0x8492a0], belly: 0xe8eef4, finTint: 0xe05a4a } },
  // --- Tier 9 ---
  { id: 'coloctopus', name: 'Colossal Octopus',   tier: 9,  value: 2800, kg: [300, 700],   model: { shape: 'octopus', size: 4.0, colors: [0x8a3a5a, 0x5c2038], belly: 0xc08aa0 } },
  { id: 'frilledshark',name:'Frilled Shark',      tier: 9,  value: 2500, kg: [150, 400],   model: { shape: 'eel',   size: 3.2,  colors: [0x5c4a42, 0x382c26], belly: 0x9a857a, teeth: true } },
  { id: 'dunkle',     name: 'Dunkleosteus',       tier: 9,  value: 3600, kg: [500, 1200],  model: { shape: 'shark', size: 4.5,  colors: [0x4a5a5c, 0x2c383a], belly: 0x8fa0a2, armored: true, teeth: true } },
  // --- Tier 10 - apex ---
  { id: 'greatwhite', name: 'Great White Shark',  tier: 10, value: 5200, kg: [800, 2000],  model: { shape: 'shark', size: 5.5,  colors: [0x6e7e8a, 0x46525c], belly: 0xe8eef2, teeth: true } },
  { id: 'megalodon',  name: 'Megalodon',          tier: 10, value: 8200, kg: [8000, 20000],model: { shape: 'shark', size: 9.0,  colors: [0x3e4e5a, 0x26323c], belly: 0xb8c4cc, teeth: true } },
  { id: 'seaserpent', name: 'Sea Serpent',        tier: 10, value: 8800, kg: [3000, 9000], model: { shape: 'serpent', size: 10.0, colors: [0x2a6a4a, 0x14402a], belly: 0x8ac8a0, emissive: 0x2aff88, frills: true } },
  { id: 'leviathan',  name: 'Abyssal Leviathan',  tier: 10, value: 9500, kg: [10000, 30000], model: { shape: 'blob', size: 8.0, colors: [0x1a1428, 0x0c0a16], belly: 0x3a3052, emissive: 0x6644ff, teeth: true } },
  // --- Weather-exclusive fish - only join their tier's pool while their
  //     weather type is active (in areas whose tier range includes them).
  { id: 'raindancer', name: 'Rain Dancer',    tier: 3, value: 70,   kg: [0.8, 2.5],  weather: 'rain',
    model: { shape: 'slim',  size: 0.45, colors: [0x4a90b8, 0x2e5f7d], belly: 0xd0e8f5, finTint: 0x88ccee } },
  { id: 'stormrider', name: 'Stormrider Eel', tier: 6, value: 560,  kg: [15, 40],    weather: 'storm',
    model: { shape: 'eel',   size: 2.0,  colors: [0x2a2a3e, 0x16162a], belly: 0x8888b0, emissive: 0xffee44 } },
  { id: 'mistwraith', name: 'Mist Wraith',    tier: 7, value: 900,  kg: [4, 12],     weather: 'fog',
    model: { shape: 'angler', size: 0.8, colors: [0x9aa8b0, 0x6a7880], belly: 0xdde8ec, emissive: 0xbbddee } },
  { id: 'thunderfin', name: 'Thunderfin',     tier: 8, value: 1900, kg: [120, 300],  weather: 'storm',
    model: { shape: 'shark', size: 3.0,  colors: [0x1e2a4a, 0x101830], belly: 0xaabbdd, emissive: 0x66aaff, finTint: 0xffee44 } },
  // --- Tier X ("tier +10") - juvenile event creatures. Catchable ONLY after
  //     surviving the matching horror event. Each yields a permanent artifact.
  { id: 'serpenthatchling', name: 'Serpent Hatchling', tier: 11, value: 16000, kg: [200, 500], requiresEvent: 'serpent',
    artifact: 'serpentscale', model: { shape: 'serpent', size: 3.0, colors: [0x2a6a4a, 0x14402a], belly: 0x8ac8a0, emissive: 0x2aff88, frills: true } },
  { id: 'krakenspawnling',  name: 'Kraken Spawnling',  tier: 11, value: 16000, kg: [300, 600], requiresEvent: 'kraken',
    artifact: 'krakenbeak',  model: { shape: 'octopus', size: 3.2, colors: [0x3a1a4a, 0x220e2e], belly: 0x7a5090, emissive: 0xaa44ff } },
  { id: 'bloopcalf',        name: 'Bloop Calf',        tier: 11, value: 20000, kg: [1000, 3000], requiresEvent: 'bloop',
    artifact: 'bloopheart',  model: { shape: 'blob', size: 4.0, colors: [0x24303e, 0x141c26], belly: 0x4a5c70, emissive: 0xff3344 } },
];

export const ARTIFACTS = {
  serpentscale: { name: 'Serpent Scale',     desc: 'Warm to the touch. Hums near the stone ring.' },
  krakenbeak:   { name: 'Kraken Beak Shard', desc: 'Obsidian-black. It remembers the grip.' },
  bloopheart:   { name: 'Heart of the Bloop',desc: 'It still beats. Once a minute. You count.' },
};

// ---------------- Fishing areas ----------------
// unlock: gear requirements. tiers: [min,max] catchable there. depth: seabed depth (m).
export const AREAS = [
  { id: 'shallows', name: 'Home Shallows',  center: [0, -140],    radius: 90,  tiers: [1, 2],  depth: 8,   unlock: {},                              enemies: [] },
  { id: 'reef',     name: 'Coral Reef',     center: [220, -80],   radius: 80,  tiers: [2, 4],  depth: 14,  unlock: { rod: 2 },                      enemies: ['daggerjelly'] },
  { id: 'kelp',     name: 'Kelp Forest',    center: [-240, -160], radius: 90,  tiers: [3, 5],  depth: 22,  unlock: { rod: 2, boat: 2 },             enemies: ['barracudaPack', 'daggerjelly'] },
  { id: 'openocean',name: 'Open Ocean',     center: [80, -420],   radius: 130, tiers: [4, 6],  depth: 45,  unlock: { rod: 3, boat: 2 },             enemies: ['reefshark', 'moray'] },
  { id: 'trench',   name: 'Midnight Trench',center: [-320, -480], radius: 110, tiers: [6, 8],  depth: 120, unlock: { rod: 4, boat: 3 },             enemies: ['reefshark', 'abyssstalker', 'moray'] },
  { id: 'abyss',    name: 'The Abyss',      center: [120, -780],  radius: 150, tiers: [8, 11], depth: 400, unlock: { rod: 5, boat: 4 },             enemies: ['abyssstalker', 'depthmaw'] },
];

// ---------------- Shop ----------------
// kind: 'rod'|'boat'|'bait'|'weapon'|'charm'|'diving'|'ward'
// Gear levels are per-player. Wallet is SHARED by the whole team (it's a co-op game).
export const SHOP = [
  // rods (level 1 = starting Driftwood Rod, free)
  { id: 'rod2', kind: 'rod', level: 2, name: 'Fiberglass Rod',  price: 300,   desc: '+1 tier reach, faster bites. Unlocks Coral Reef & Kelp Forest.' },
  { id: 'rod3', kind: 'rod', level: 3, name: 'Carbon Rod',      price: 1200,  desc: 'Strong line for heavy fish. Unlocks Open Ocean.' },
  { id: 'rod4', kind: 'rod', level: 4, name: 'Deepline Rod',    price: 4000,  desc: 'Pressure-rated reel. Unlocks Midnight Trench.' },
  { id: 'rod5', kind: 'rod', level: 5, name: 'Mythline Rod',    price: 12000, desc: 'Woven from oarfish silver. Unlocks The Abyss.' },
  // boats (level 1 = starting Dinghy). Whole team shares ONE boat; upgrades apply to it.
  { id: 'boat2', kind: 'boat', level: 2, name: 'Skiff',        price: 800,   desc: 'Faster, tougher, seats everyone comfortably.' },
  { id: 'boat3', kind: 'boat', level: 3, name: 'Cutter',       price: 3000,  desc: 'Handles far water. Required for the Trench.' },
  { id: 'boat4', kind: 'boat', level: 4, name: 'Abyss-Runner', price: 9000,  desc: 'Reinforced hull with deep-water lamps. Required for The Abyss.' },
  // baits (consumable, +luck and tier bias while equipped)
  { id: 'worms',    kind: 'bait', name: 'Worms',        price: 10,   pack: 10, tierBias: 0,   luck: 0,    desc: 'Classic. Fish pity you.' },
  { id: 'shrimp',   kind: 'bait', name: 'Shrimp',       price: 40,   pack: 10, tierBias: 0.5, luck: 0.05, desc: 'Everything eats shrimp.' },
  { id: 'squidbait',kind: 'bait', name: 'Squid Chunk',  price: 120,  pack: 10, tierBias: 1,   luck: 0.1,  desc: 'Big fish bait.' },
  { id: 'glowbait', kind: 'bait', name: 'Glowbait',     price: 400,  pack: 10, tierBias: 1.5, luck: 0.2,  desc: 'Deep dwellers cannot resist light.' },
  { id: 'voidbait', kind: 'bait', name: 'Voidbait',     price: 1500, pack: 10, tierBias: 2,   luck: 0.35, desc: 'Do not look at it too long. Doubles mutation odds.' },
  // weapons — attack: 'melee' | 'ranged' | 'both'. Melee weapons also bonk
  // landed catches (see FLOPPER); ranged-only ones cannot.
  { id: 'bonker',   kind: 'weapon', attack: 'melee',  name: 'Fish Bonker',   price: 150,   dmg: 25, rate: 1.2, range: 3,   desc: 'A club for finishing the catch. Also fine for rude fish.' },
  { id: 'harpoon',  kind: 'weapon', attack: 'ranged', name: 'Harpoon',       price: 500,   dmg: 25, rate: 0.8, range: 25,  desc: 'Throw, retrieve, repeat.' },
  { id: 'cutlass',  kind: 'weapon', attack: 'melee',  name: 'Rusty Cutlass', price: 1200,  dmg: 50, rate: 1.6, range: 3.5, desc: 'Swish. Slash. Sashimi.' },
  { id: 'speargun', kind: 'weapon', attack: 'ranged', name: 'Speargun',      price: 2500,  dmg: 45, rate: 1.4, range: 35,  desc: 'Works underwater. Very persuasive.' },
  { id: 'trident',  kind: 'weapon', attack: 'both',   name: 'Storm Trident', price: 10000, dmg: 90, meleeDmg: 65, rate: 1.0, range: 45, desc: 'Crackles with charge. Jab it or unleash it.' },
  // luck charms (stack multiplicatively with bait luck)
  { id: 'charm1', kind: 'charm', name: 'Bronze Talisman', price: 600,   luck: 0.10, desc: '+10% luck. A warm feeling.' },
  { id: 'charm2', kind: 'charm', name: 'Silver Talisman', price: 2500,  luck: 0.25, desc: '+25% luck. The sea winks at you.' },
  { id: 'charm3', kind: 'charm', name: 'Golden Talisman', price: 8000,  luck: 0.50, desc: '+50% luck. Mutations seek you out.' },
  // revival gear (see REVIVE) - salts/kit are consumable, the claw is permanent
  { id: 'salts',      kind: 'revive', name: 'Sea Salts',        price: 450,  pack: 1, desc: 'Hold E over a downed crewmate. Smells like regret; works like magic.' },
  { id: 'rescueclaw', kind: 'revive', name: 'Rescue Claw',      price: 2500,          desc: 'Grab a sunken crewmate and tow them up. The sea does not keep what you can reach.' },
  { id: 'revivalkit', kind: 'revive', name: 'Revival Kit',      price: 7500, pack: 1, desc: 'Adrenaline, bandages, and sheer spite. Gets YOU back up. Once.' },
  // diving gear (underwater time in seconds)
  { id: 'snorkel',  kind: 'diving', level: 2, name: 'Snorkel',    price: 200,  air: 40,  desc: 'Stay under 40s.' },
  { id: 'scuba',    kind: 'diving', level: 3, name: 'Scuba Tank', price: 1500, air: 120, desc: 'Stay under 2 minutes.' },
  { id: 'deepsuit', kind: 'diving', level: 4, name: 'Deepsuit',   price: 6000, air: 300, desc: '5 minutes, pressure-proof.' },
  // team consumables - bought from the shared wallet, owned by the whole crew
  { id: 'revivetoken', kind: 'token', name: 'Revival Token', price: 5000, desc: 'If the WHOLE crew goes down, one token burns instead - everyone gets back up. Stacks.' },
  // the big one - team purchase, consumable, price rises 50% each time
  { id: 'ward', kind: 'ward', name: 'Tsunami Ward', price: 15000, desc: 'Ancient charm. Pushes the tsunami back 3 days. Price rises each purchase.' },
];

export const BASE_AIR_SECONDS = 15; // no diving gear

// ---------------- Economy / quota / days ----------------
export const ECON = {
  DAY_SECONDS: 300,          // one full in-game day
  NIGHT_START: 0.72,         // timeOfDay fraction where night begins
  QUOTA_CYCLE_DAYS: 3,       // days per quota
  QUOTA_BASE: 400,           // first quota target (money value of sold fish)
  QUOTA_GROWTH: 1.55,        // target multiplier per completed quota
  QUOTAS_TO_WIN: 10,         // complete this many + all 3 artifacts -> portal
  START_WALLET: 50,
  WARD_PRICE_GROWTH: 1.5,
  WEIGHT_VALUE_EXP: 0.35,    // value *= (kg / kgMin)^exp — heavier fish worth more
  QUOTA_FAIL_GRACE_SECONDS: 20, // tsunami cinematic length before game over
};

// ---------------- Safe zone & event mercy rules ----------------
// The spawn island (and its beach shallows) is a SAFE ZONE:
// - Event creatures cannot hurt players inside it, and no single event hit
//   can ever deal more than EVENT_MAX_HIT (no one-shots, anywhere).
// - A horror event can only START if at least one alive player is OUTSIDE
//   the zone at the nightly roll.
// - During an event, if EVERY alive player is inside the zone, the creature
//   just circles offshore and a retreat countdown starts; when it hits zero
//   the creature gives up and leaves (event ends, survived). Stepping back
//   outside cancels the countdown.
// - While the Bloop hunts, everyone gets an adrenaline surge so it can
//   actually be outrun.
export const SAFE_ZONE = {
  RADIUS: 140,            // metres from island centre
  RETREAT_SECONDS: 20,    // all-inside countdown before the creature leaves
  EVENT_MAX_HIT: 45,      // hard cap on any single event-creature hit
  BLOOP_ADRENALINE: 1.3,  // move + boat speed multiplier during the Bloop
};

// ---------------- Horror events ----------------
// Server schedules one per night with rising odds; guaranteed by pityDay.
// On EVENT_START every client: hard-cut the music, snap day->night, fog in.
// Survive = keep the boat alive / reach the shallows before the timer ends.
// bodyLength: the creature's rough visual length/height in metres — these
// things are meant to dwarf the boat the way the Titanic dwarfs a dinghy.
export const EVENTS = {
  serpent: { name: 'The Serpent',  firstDay: 3, pityDay: 6,  duration: 90,  unlocksFish: 'serpenthatchling',
             bodyLength: 110, desc: 'Something long is circling the boat.' },
  kraken:  { name: 'The Kraken',   firstDay: 6, pityDay: 10, duration: 100, unlocksFish: 'krakenspawnling',
             bodyLength: 95,  desc: 'Arms. So many arms. Break its grip and run.' },
  bloop:   { name: 'The Bloop',    firstDay: 9, pityDay: 14, duration: 110, unlocksFish: 'bloopcalf',
             bodyLength: 260, desc: 'The sound arrives before it does. Nothing that big should exist.' },
};

// ---------------- Enemies ----------------
// behavior: 'patrol' (default - wander then chase), 'drift' (slow float,
// stings on contact, mid-water), 'ambush' (lurks motionless near seabed loot,
// explosive lunge when a diver comes close - guards treasure).
export const ENEMIES = {
  barracudaPack: { name: 'Barracuda',      hp: 40,  dmg: 6,  speed: 7,   aggroRange: 18, size: 1.3, count: 3, behavior: 'patrol' },
  reefshark:     { name: 'Reef Shark',     hp: 120, dmg: 14, speed: 9,   aggroRange: 25, size: 2.2, count: 1, behavior: 'patrol' },
  abyssstalker:  { name: 'Abyss Stalker',  hp: 260, dmg: 25, speed: 11,  aggroRange: 35, size: 3.0, count: 1, behavior: 'patrol' },
  daggerjelly:   { name: 'Dagger Jelly',   hp: 30,  dmg: 9,  speed: 2.2, aggroRange: 9,  size: 0.9, count: 4, behavior: 'drift' },
  moray:         { name: 'Moray Ambusher', hp: 180, dmg: 20, speed: 13,  aggroRange: 12, size: 2.4, count: 2, behavior: 'ambush' },
  depthmaw:      { name: 'Depthmaw',       hp: 420, dmg: 34, speed: 11,  aggroRange: 16, size: 3.6, count: 1, behavior: 'ambush' },
};

export const PLAYER_MAX_HP = 100;
export const PLAYER_COLORS = [0xe05a4a, 0x4a9ae0, 0x52c46a, 0xe0c04a, 0xb06ae0, 0xe08a3a, 0x4ac8c0, 0xe06aa8];

// ---------------- Helpers used by both sides ----------------
export function fishById(id) { return FISH.find(f => f.id === id); }
export function shopById(id) { return SHOP.find(s => s.id === id); }
export function quotaTarget(n) { // n = quotas already completed
  return Math.round(ECON.QUOTA_BASE * Math.pow(ECON.QUOTA_GROWTH, n));
}
export function wardPrice(purchases) {
  return Math.round(15000 * Math.pow(ECON.WARD_PRICE_GROWTH, purchases));
}
export function fishValue(fish, weightKg, mutation) {
  const w = Math.pow(Math.max(1, weightKg / fish.kg[0]), ECON.WEIGHT_VALUE_EXP);
  const m = mutation ? MUTATIONS[mutation].valueMult : 1;
  return Math.round(fish.value * w * m);
}
