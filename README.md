# 🎣 Tidewreck Island

A co-op 3D multiplayer fishing party game for 2–8 friends. Built with Three.js and Socket.io — no build step, no external assets, everything procedural.

**The pitch:** your crew is stranded on an island. Sell fish to meet an ever-growing quota, or a tsunami wipes you out. Upgrade rods, boats, baits, and weapons; sail out to deeper, scarier waters; survive three horror events (the music cutting out is your only warning); catch the three Tier-X creatures for their artifacts; build the portal at the stone ring and escape together.

## Features

- 🌊 **3D island + open ocean** with day/night cycle, god rays, and a wavy shader ocean you can dive under
- 🚤 **Shared boat** with buoyancy physics — your whole crew rides together, one drives
- 🐟 **44 fish across 11 tiers** — from the humble Sardine to the Megalodon, Sea Serpent, and Abyssal Leviathan
- ✨ **6 mutations**: Golden, Rainbow, Void, Spectral, Molten, Crystal — rare, gorgeous, and worth a fortune
- ⛈️ **Weather with a pity system**: Clear, Overcast, Dead Fog, Rain Squall, Thunderstorm — real wave-height changes, fishing luck boosts, lightning hazards, weather-exclusive fish, and storms that make horror events 2.5× more likely. Stay dry too long and the pity system sends the storm to find you
- 🔨 **Kill your catch**: fish land on deck *alive and flopping* — bonk them (bare hands or melee) before they flop back into the sea
- 🏪 **Shop & progression**: 5 rods, 4 boats, 5 baits, 5 weapons (melee + ranged), luck charms, diving gear, and the Tsunami Ward
- 📈 **Quota pressure**: the target grows ×1.55 every cycle; miss the deadline and the wave comes
- 👹 **Horror events**: The Serpent, The Kraken, The Bloop. The soundtrack cuts to silence, day snaps to night, and something the size of a building surfaces. Survive to unlock their catchable offspring
- ⚔️ **Enemies & weapons**: barracuda packs, reef sharks, abyss stalkers — fight back with harpoon, speargun, or Storm Trident
- 🎵 **Fully synthesized soundtrack & SFX** via WebAudio — zero audio files
- 🏠 **Rooms**: create an island with a 4-letter code, set max players and difficulty, and share it with friends

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000 — open a second tab to test multiplayer solo.

## Controls

| Key | Action |
|---|---|
| WASD / Shift | Move / run |
| Mouse | Look (click canvas to lock) |
| LMB (hold) | Charge cast · hook · reel · attack |
| E | Interact (boat / shop / portal) |
| Space / C | Jump · swim up / dive |
| 1 / 2 | Rod / weapon |
| B | Cycle bait |
| I | Inventory |
| Enter | Chat |

## Deploy free (so friends can join online)

The server is a single Node process serving both the game and the WebSocket — ideal for free hosts.

### Render (recommended, easiest)

1. Push this repo to GitHub.
2. Go to [render.com](https://render.com) → **New → Web Service** → connect the repo.
3. It reads `render.yaml` automatically (or set: build `npm install`, start `npm start`, free instance type).
4. Share the `https://your-app.onrender.com` URL with friends.

Note: free Render instances sleep after 15 min idle — the first visit takes ~30s to wake.

### Railway / Fly.io / Glitch

All work the same way: import the GitHub repo, it detects Node, runs `npm start`, done. The server binds `process.env.PORT` automatically.

## Roadmap — what's left to finish

Development was paused mid-wave-4. `main` is the last **fully verified, playable build**
(movement, fishing + bonking, walkable boats, weather, all three horror events, collision,
audio, customization all tested live). The unfinished wave-4 work lives on the
[`wave4-wip`](https://github.com/rugercuz/tidewreck-island/tree/wave4-wip) branch —
**written but interrupted before integration testing. Do not merge it blindly**; test each
piece against the "Wave 4 addendum" contract at the end of `DESIGN.md` (on that branch),
which is the full spec. Remaining work:

1. **Diving loot** (mostly written on the branch): seabed treasure per area (pearl clams →
   abyssal geodes), sunken chests containing found-only baits (Glow Grub, Abyss Leech) and
   five one-of-a-kind charms (Pearl of the Deep, Siren's Locket, Barnacle Idol, Drowned
   Crown, Tidal Bell). Data is complete in `shared/constants.js` on the branch; server spawning
   + pickup and the new `public/js/loot.js` exist but are untested.
2. **Wire `loot.js` into the game loop** — it was never added to `public/js/main.js`:
   import `initLoot`, call it after `initEnemies`, store as `ctx.loot`, add its
   `update(dt, t)` to the frame loop in the same order.
3. **Flopper fixes** (written, untested): caught fish must land at the catcher's feet — on
   the boat deck (riding it), on the dock planks (currently it can fall in the water under
   the dock), never floating mid-air; killed fish become glowing walk-over pickups.
4. **Water-exit vault** (written, untested): Space while swimming near a low edge vaults you
   onto shore/dock/boat.
5. **New dive predators**: drifting Dagger Jellies + loot-guarding Moray/Depthmaw ambushers.
   Server AI is written; the **enemy visuals in `public/js/enemies.js` were NOT done** —
   the jelly bell and coiled-ambusher models/animations still need building (spec in the
   addendum).
6. **Re-verify after integrating**: boot the game, then check — camera-relative WASD +
   jump (see `DESIGN.md`; this has regressed before), the full catch → bonk → pickup →
   inventory loop from dock/deck/beach, loot pickup underwater, and no console errors.
   Tip: as host, type `/event serpent|kraken|bloop` in chat to force a horror event for
   testing.

## How to win

Complete the quota **10 times**, survive all **3 horror events**, catch each **Tier-X** creature for its artifact (Serpent Scale, Kraken Beak Shard, Heart of the Bloop), then build the portal at the stone ring and step through — together.

---

Made with Claude Code. 🌊
