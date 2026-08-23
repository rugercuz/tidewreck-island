# TIDEWRECK ISLAND — Architecture Contract

Co-op 3D multiplayer fishing party game. A team of 2–8 friends lives on an island.
Sell fish to meet an ever-growing quota — miss it and a tsunami ends the run.
Survive horror events, catch all three Tier-X creatures, build the portal, escape. That's the win.

**This file is the contract.** Every module is written by a different author in parallel.
If you deviate from an interface here, the game breaks. Read `shared/constants.js` too — it is
the single source of truth for all game data (fish, shop, areas, events, protocol names).

## Stack & hard rules

- Node >= 18, ES modules everywhere (`"type": "module"`).
- Server: Express (static) + Socket.io. Client: Three.js r185 via importmap name `three`
  (served from `/lib/three.module.js`). Socket.io client from `/socket.io/socket.io.js` (global `io`).
- **NO `three/addons` imports. NO external assets, URLs, CDNs, textures, models, or audio files.**
  Everything is procedural: geometry built in code, textures via canvas, audio via WebAudio synthesis.
- Vanilla DOM for UI. No frameworks, no build step. The game must run with `npm install && npm start`.
- Every file must be complete and syntactically valid — no TODOs, stubs, or placeholder functions.
- Only write the files you own. Import freely from `shared/constants.js` and other modules per this contract.
- Guard against momentarily-null refs (`if (!ctx.state.world) return;`) — modules init before the game starts.
- Target 60 fps on a mid laptop: merge geometry where easy, reuse materials, keep particle counts sane.

## File ownership

| Owner | Files |
|---|---|
| server | `server/index.js`, `server/rooms.js`, `server/game.js`, `server/fishing.js` |
| client-core | `public/index.html`, `public/js/main.js`, `public/js/net.js` |
| world | `public/js/world.js` |
| water | `public/js/water.js` |
| player | `public/js/player.js` |
| boat | `public/js/boat.js` |
| fish-models | `public/js/fish.js` |
| fishing | `public/js/fishing.js` |
| enemies | `public/js/enemies.js` |
| events | `public/js/events.js` |
| audio | `public/js/audio.js` |
| ui | `public/js/ui.js`, `public/style.css` |

## Client architecture

`main.js` builds a shared context `ctx`, initializes every module, runs the render loop.

```js
ctx = {
  THREE, scene, camera, renderer, clock,
  net,   // from net.js: { send(type, data), on(type, cb), id() }
  bus,   // tiny emitter: { on(evt, cb), off(evt, cb), emit(evt, data) }
  state: {
    phase: 'menu' | 'lobby' | 'playing' | 'over',
    myId: null, myName: '', myColor: 0,       // color = index into PLAYER_COLORS
    world: null,          // latest WORLD_STATE payload from server (see constants MSG.WORLD_STATE)
    room: null,           // latest ROOM_STATE payload
    gear: { rod: 1, boat: 1, weapons: [], charms: [], diving: 1, activeBait: null, activeWeapon: null },
    baits: {},            // baitId -> count
    inventory: [],        // [{invId, fishId, mutation, weightKg, value}]
    hp: 100, air: 1,      // air = 0..1 fraction remaining
    underwater: false, onBoat: false, seat: -1,
    currentArea: null,    // areaId the local player/boat is inside, else null
    eventActive: null,    // 'serpent' | 'kraken' | 'bloop' | null
    activeTool: 'rod',    // 'rod' | 'weapon' — ui/hotkeys 1 & 2 switch; fishing acts only on 'rod', weapons only on 'weapon'
    timeOfDay: 0.3,       // 0..1, client-interpolated between WORLD_STATE ticks
  },
  input: { keys: new Set(), mouseDown: false, pointerLocked: false },  // keys hold e.code values
  getWaterHeight: (x, z, t) => 0,   // OVERWRITTEN by water.js. Everyone samples waves through this.
  world: null, water: null, playerMod: null, boat: null, fishing: null,
  enemies: null, events: null, audio: null, ui: null,   // module handles, set by main.js after each init
}
```

**Init order** (main.js, at page load — the island renders behind the menu as a slow orbiting shot):
`audio, world, water, player, boat, fishing, enemies, events, ui`. Each module exports
`init<Name>(ctx)` returning a handle object stored on ctx, and main calls `ctx.<handle>.update(dt, t)`
every frame in the same order. `t` is seconds since page load (`clock.getElapsedTime()`), `dt` capped at 0.05.

**Module exports (exact names):**

- `world.js` → `export function initWorld(ctx)` → handle `{ update(dt,t), getTerrainHeight(x,z), setNightSnap(on), setPortalBuilt(on), portalPos, shopPos, ringPos, dockPos }`
- `water.js` → `initWater(ctx)` → `{ update(dt,t), splash(pos, size) }`; sets `ctx.getWaterHeight`
- `player.js` → `initPlayer(ctx)` → `{ update(dt,t), createCharacter(colorIndex, name), local, remotes }`.
  `createCharacter` returns `{ group, bones: { root, head, armL, armR, legL, legR, handR }, setAnim(name), update(dt,t) }`
  with anims `idle|walk|run|swim|cast|reel|sit|drive`; `handR` is the rod/weapon attach Object3D.
  `local.char` is the local player's character (fishing.js attaches rod models to `local.char.bones.handR`).
- `boat.js` → `initBoat(ctx)` → `{ update(dt,t), group, isDriver(), nearBoat(pos), velocity, seatWorld(seatIndex, outVec3), seatCount() }`
- `fish.js` → `export function createFishMesh(fishDef, mutation, scaleMult = 1)` → `THREE.Group` with `group.userData.update(t)` swim/wiggle animation. Pure factory, no init.
- `fishing.js` → `initFishing(ctx)` → `{ update(dt,t), isCasting() }`
- `enemies.js` → `initEnemies(ctx)` → `{ update(dt,t) }`
- `events.js` → `initEvents(ctx)` → `{ update(dt,t) }`
- `audio.js` → `initAudio(ctx)` → `{ update(dt,t), cutMusic(), sfx(name, opts), setUnderwater(on), startMusic(), setVolume(v01) }`
- `ui.js` → `initUI(ctx)` → `{ update(dt,t), toast(text, kind), openShop(), closeAll() }`

**Bus events** (names are load-bearing):

| event | payload | emitted by | consumed by |
|---|---|---|---|
| `phase` | newPhase string | main/ui | all |
| `worldState` | WORLD_STATE payload | main (on msg) | world, ui, events |
| `underwater` | bool | player | water, audio, ui |
| `boardBoat` / `leaveBoat` | {seat} / {} | player/boat | boat, fishing, ui |
| `castStart` / `bite` / `catch` | see MSG | fishing | audio, ui |
| `eventStart` / `eventEnd` | {type} / {type, survived, unlocked} | main (on msg) | events, audio, world, ui, enemies |
| `localDamaged` | {dmg, cause} | enemies/events | ui, audio, player |
| `sunDir` | THREE.Vector3 (normalized, updated each frame) | world | water |

**index.html** must contain exactly: `<canvas id="game"></canvas>`, `<div id="ui"></div>`,
`<link rel="stylesheet" href="style.css">`, importmap `{ "imports": { "three": "./lib/three.module.js" } }`,
`<script src="/socket.io/socket.io.js"></script>`, `<script type="module" src="js/main.js"></script>`.
ui.js builds ALL menu/HUD DOM inside `#ui` and owns `style.css` entirely.

## World layout

- Island: circular-ish, radius ~120 m centered at origin, procedural low-poly terrain
  (analytic height function — `getTerrainHeight` must match the visible mesh). Beach ring,
  grassy hills, palm trees. Sea level y = 0.
- Landmarks (world.js decides exact spots, exposes positions): wooden **dock** on the south
  shore (toward Home Shallows), **shop hut** near the dock, ancient **stone ring** on a hill
  (portal site), campfire spawn point.
- Fishing **areas** per `AREAS` in constants: mark each with a distinct glowing buoy ring;
  seabed at `depth`. Ocean floor elsewhere ~ -30 m, sloping down toward the abyss area.
- Day/night: sun + moon orbit driven by `ctx.state.timeOfDay` (main interpolates using
  ECON.DAY_SECONDS between server ticks). Warm sunrises/sunsets, star field at night,
  visible **god rays** (additive shafts, both above water looking toward sun and underwater).
  `setNightSnap(true)` = horror override: instant black-red night sky, heavy fog, red moon —
  restore on `setNightSnap(false)`.

## Gameplay flow (server-authoritative)

Lobby: create room (name, max players 2–8, difficulty chill/normal/hard = quota ×0.7/1/1.4) →
4-letter room code → friends join → everyone readies → host starts.

In game: shared **team wallet** (constants ECON.START_WALLET), personal gear/inventory.
Cast in an area you've unlocked → server rolls bite delay (2–6 s) → BITE → client reel
minigame → REEL_DONE → server rolls fish (tier within area range biased by rod level +
bait tierBias + luck; mutation roll scaled by luck, voidbait doubles it) → CAST_RESULT.
Sell at the shop hut → wallet += value, quota progress += value. Quota completes →
next target ×1.55, deadline = +3 days. Deadline passes unmet → TSUNAMI → game over.
Tsunami Ward purchase pushes deadline +3 days, price ×1.5 each time.
Horror events fire at night per EVENTS schedule (server picks; guaranteed by pityDay).
Surviving one unlocks its Tier-X fish in the Abyss. First catch of each Tier-X fish awards
its permanent artifact. 10 quotas + 3 artifacts → build portal at the stone ring → everyone
steps in → GAME_WON.

Death: hp 0 → knocked out (screen dims, can't act); revived automatically at the campfire
at the next sunrise, or when an event ends. All players down during an event = event failed
(it will re-run another night). Server relays MOVE→PLAYERS_MOVE (~12 Hz) and DRIVE_BOAT→BOAT_STATE;
runs 10 Hz tick for day cycle, enemies, events; 1 Hz WORLD_STATE.

## Visual bar (all scene modules)

Renderer: `outputColorSpace = SRGBColorSpace`, `ACESFilmicToneMapping`, shadows PCFSoft
(sun light only, shadow camera covering the island). Stylized-vivid low-poly look:
saturated but cohesive palette, `flatShading` on terrain/props, fog matched to sky color.
Characters: charming low-poly fisherfolk (~1.7 m) — body, head with canvas-texture face,
hat, arms/legs animated procedurally (walk/run/swim/cast/sit/drive), player-color clothing,
floating name tag (canvas sprite). Rods get visibly cooler per level (driftwood → glowing
mythline). Fish read as their species at a glance; mutations are unmistakable (see
MUTATIONS.fx). Boat upgrades change the hull visibly (dinghy → lamp-rigged abyss-runner).

## Wave 2 addendum — weather, melee, catch-bonking (see constants: WEATHER, WEATHER_RULES, FLOPPER, weapon `attack` fields)

**Protocol additions:** WORLD_STATE gains `weather: {type}`. On change server broadcasts
MSG.WEATHER `{type}`. MSG.LIGHTNING `{p:[x,y,z], targetId|null}` per strike during storms.
MSG.FLOPPER `{state:'spawn'|'hit'|'dead'|'escaped', flopperId, fish?, hp?, maxHp?}` — a caught
fish no longer goes straight to inventory: the server creates a flopper (hp = FLOPPER.BASE_HP +
tier * HP_PER_TIER); the catcher sends MSG.BONK_FISH `{flopperId, dmg}` per whack (server clamps
dmg to the player's best owned melee option; bare hands = FLOPPER.HAND_DMG; weapons with
attack 'melee' use dmg, 'both' use meleeDmg); hp<=0 -> state 'dead' + INVENTORY (artifact award
happens HERE now, not at catch); no kill within FLOPPER.ESCAPE_SECONDS -> 'escaped', fish lost.

**Client wiring:** modules subscribe to new messages directly via `ctx.net.on(MSG.X, cb)`
(net.js fans out every server event; no main.js changes needed). fishing.js re-emits bus
'flopper' `{state, flopperId, fish, hp, maxHp}` for ui. Current weather readable at
`ctx.state.world.weather.type` (may be absent on old payloads — guard).

**Server effects:** weather rerolled at dawn + dusk (WEATHER weights; pity per WEATHER_RULES,
storm-biased). Fishing rolls add weather luck/tierBias, bite delay divided by biteSpeed,
weather-exclusive fish (FISH[].weather) join their tier pool only during that weather. Nightly
horror-event odds x eventChanceMult. Storms strike lightning every LIGHTNING_PERIOD seconds at
a random player on open water above the surface (LIGHTNING_DMG, or a random sea point if nobody
is exposed). Fog multiplies enemy aggroRange by FOG_AGGRO_MULT.

**Visuals/feel:** world.js renders weather (clouds, rain streaks, fog density, storm darkening,
lightning bolts + flash on MSG.LIGHTNING, palm wind-lean), transitions ~5s, never fighting
setNightSnap. water.js lerps a waveScale uniform toward WEATHER[type].waveScale (~8s) applied
identically in the shader AND ctx.getWaterHeight. enemies.js implements melee swings (arc hit,
range ~3.5m) for 'melee'/'both' weapons; trident jabs when a target is within 4m, else fires.
fishing.js spawns the comedic flopping catch on deck (hops toward the water!), bonk impacts,
stow-on-kill, sad escape. ui.js: weather chip + hazard toast, BONK prompt + hp pips + escape
timer, attack-type badges in the shop. audio.js: rain/thunder/wind, thwack bonks, escape sting.

## Wave 3 addendum — audio repair, walkable boats, collision, customization

**Cross-module contracts (exact names):**
- `world.js` handle gains `surfaceHeight(x, z)` -> ground y including dock decking/steps
  (max of terrain and any walkable structure), and `resolveCollide(pos, radius)` -> pushes a
  THREE.Vector3 out of solid props (palms, rocks, hut walls, standing stones, campfire ring,
  dock posts). player.js grounds on surfaceHeight (not raw getTerrainHeight) and calls
  resolveCollide after integrating movement each frame.
- `boat.js` handle gains `deckInfo(x, z)` -> `null | { y, localX, localZ }` (walkable deck top at
  that world XZ), `toWorld(localVec3, out)` / `toLocal(worldVec3, out)` (full boat frame incl.
  yaw/pitch/roll), and `helmPos(out)` (world position of the wheel). Boats are BIG walkable
  platforms per level: Dinghy ~5.5 m, Skiff ~8 m, Cutter ~11 m, Abyss-Runner ~14 m, visibly
  distinct hulls. Wake/foam is speed-scaled: invisible when idle, ramping in above ~1.5 m/s,
  bigger/brighter for higher boat levels and speeds.
- Standing on deck: player state gains `onDeck: bool`. Boarding = E near the hull -> hop onto
  nearest deck point; walking on deck uses boat-local anchoring (store local pos, boat motion
  carries you; WASD moves the local anchor; walking off the edge = fall in the water). Driving =
  E within 2 m of helmPos -> seat 0 snap (E again releases the wheel back to walking).
  Fishing while standing on deck must work (state.onBoat stays true while onDeck so existing
  fishing/ui checks hold; seat stays -1 unless driving).
- MOVE payload gains `bl: [x,y,z] | null` — boat-local position when on deck. Remote players
  with `bl` are rendered attached to the boat frame (toWorld), NOT at their last absolute pos.
  The server relays the field untouched.
- Character customization: `createCharacter(colorIndex, name, opts = { hat, skin })` — hat
  0..4 (bucket, beanie, captain, bandana, none), skin 0..3 (light tan, tan, brown, deep).
  CREATE_ROOM/JOIN_ROOM accept `{hat, skin}` (server sanitizes ints, defaults 0), and every
  players list (ROOM_STATE + WORLD_STATE) carries hat/skin so remotes render them.

**Audio repair (root cause measured live):** on startMusic the master output grows
exponentially (~e^3.6/s: peak 0.07 -> 372 in 2.4 s) and hits NaN at ~2.8 s; the NaN circulates
in the feedback-delay reverb forever = one ugly ring, then permanent total silence. The
runaway begins immediately (before the first melody bar), so it lives in the always-on layer
(pad / ocean-ambience / wind "breathing"/"sweep" filter LFOs — a biquad driven to <=0 Hz or an
effective feedback >=1). Required: (1) find and fix the actual runaway; (2) clamp EVERY
AudioParam write through safe helpers (frequency 10..18000, Q 0..20, gain 0..2, delay
0.001..0.5, pan -1..1, no non-finite values); (3) a DynamicsCompressor + hard WaveShaper
limiter on the master; (4) a NaN watchdog: analyser on master sampled ~1/s — if NaN or
sustained peak > 4 is seen, tear down and rebuild the entire graph silently so sound can NEVER
permanently die; (5) verify audible coverage of every game action.

**Also:** area-name floating signs must distance-fade (invisible inside ~25 m of the area
center's label and clamped in screen size) — they currently fill the screen when close.
