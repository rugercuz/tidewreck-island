# 🎣 Tidewreck Island

A co-op 3D multiplayer fishing party game for 2–8 friends. Built with Three.js and Socket.io — no build step, no external assets, everything procedural.

**The pitch:** your crew is stranded on an island. Sell fish to meet an ever-growing quota, or a tsunami wipes you out. Upgrade rods, boats, baits, and weapons; sail out to deeper, scarier waters; survive three horror events (the music cutting out is your only warning); catch the three Tier-X creatures for their artifacts; build the portal at the stone ring and escape together.

## Features

- 🌊 **3D island + open ocean** with day/night cycle, god rays, and a wavy shader ocean you can dive under
- 🚤 **Walkable boats** with buoyancy physics — four hull classes (5.5 m dinghy to 14 m Abyss-Runner); the whole crew stands, walks, and fishes on deck while one drives at the helm
- 🤿 **Diving is worth it (and dangerous)**: seabed treasure that scales with depth — pearl clams, coin stashes, sunken chests, relics, abyssal geodes. Chests can hold found-only baits and five **one-of-a-kind charms** (Pearl of the Deep, Siren's Locket, Barnacle Idol, Drowned Crown, Tidal Bell) — one each per run, first finder keeps it. Watch your air, and watch the shadows: drifting Dagger Jellies sting, and Moray Ambushers lurk nearly invisible beside the treasure
- 🐟 **44 fish across 11 tiers** — from the humble Sardine to the Megalodon, Sea Serpent, and Abyssal Leviathan
- ✨ **6 mutations**: Golden, Rainbow, Void, Spectral, Molten, Crystal — rare, gorgeous, and worth a fortune
- ⛈️ **Weather with a pity system**: Clear, Overcast, Dead Fog, Rain Squall, Thunderstorm — real wave-height changes, fishing luck boosts, lightning hazards, weather-exclusive fish, and storms that make horror events 2.5× more likely. Stay dry too long and the pity system sends the storm to find you
- 🔨 **Kill your catch**: fish land at your feet *alive and flopping* — bonk them before they escape, then scoop up the glowing prize. Space vaults you out of the water onto shore, dock, or boat
- 🏪 **Shop & progression**: 5 rods, 4 boats, 5 baits, 5 weapons (melee + ranged), luck charms, diving gear, and the Tsunami Ward
- 💀 **Down but not out**: revive teammates with Sea Salts, tow drowned bodies up with the Rescue Claw, or self-revive with the pricey Revival Kit — but if the *whole* crew goes down at once, the sea sends a 300-meter doomsday wave to collect you (unless a team **Revival Token** burns in your place)
- 🏝️ **The island is sacred ground**: event monsters can't hurt you in the spawn zone — hide the whole crew there and the creature circles offshore, gives up after a 20-second standoff, and leaves. No event hit can one-shot you, and the Bloop grants an adrenaline rush so you can actually outrun it
- 🎯 **Perfect throws**: release your cast between the marked lines for bonus luck and faster bites
- 📈 **Quota pressure**: the target grows ×1.55 every cycle; miss the deadline and the wave comes
- 👹 **Horror events**: The Serpent, The Kraken, The Bloop. The soundtrack cuts to silence, day snaps to night, and something the size of a building surfaces. Survive to unlock their catchable offspring
- ⚔️ **Enemies & weapons**: barracuda packs, reef sharks, abyss stalkers, jellies, morays, and the Depthmaw — fight back with club, cutlass, harpoon, speargun, or Storm Trident
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

## How to win

Complete the quota **10 times**, survive all **3 horror events**, catch each **Tier-X** creature for its artifact (Serpent Scale, Kraken Beak Shard, Heart of the Bloop), then build the portal at the stone ring and step through — together.

---

Made with Claude Code. 🌊
