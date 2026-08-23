// =============================================================
// TIDEWRECK ISLAND - server/rooms.js
// Lobby / room manager. Owns room codes, membership, host migration,
// chat relay, and the handoff into an authoritative Game (game.js).
// All socket wiring for a connection lives in handleConnection().
// =============================================================

import { MSG, PLAYER_COLORS, ECON } from '../shared/constants.js';
import { Game } from './game.js';

// Unambiguous alphabet: no I, no O (they read as 1 and 0 over voice chat).
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 4;
const MAX_NAME_LEN = 16;
const MAX_ROOM_NAME_LEN = 24;
const MAX_CHAT_LEN = 200;
const CHAT_COOLDOWN_MS = 400;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 8;
const DIFFICULTIES = ['chill', 'normal', 'hard'];
const RELOBBY_DELAY_MS = 2500;

// ---------------- Sanitizers ----------------

/** Strip control chars, collapse whitespace, hard-cap length. */
function sanitizeText(value, maxLen, fallback) {
  if (typeof value !== 'string') return fallback;
  let out = '';
  for (let i = 0; i < value.length && out.length < maxLen; i++) {
    const c = value.charCodeAt(i);
    if (c < 32 || c === 127) continue;
    out += value[i];
  }
  out = out.replace(/\s+/g, ' ').trim();
  return out.length ? out : fallback;
}

function sanitizeName(value) { return sanitizeText(value, MAX_NAME_LEN, 'Angler'); }

function sanitizeColor(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return 0;
  return ((n % PLAYER_COLORS.length) + PLAYER_COLORS.length) % PLAYER_COLORS.length;
}

function sanitizeMaxPlayers(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return MAX_PLAYERS;
  return Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, n));
}

function sanitizeDifficulty(value) {
  return DIFFICULTIES.indexOf(value) !== -1 ? value : 'normal';
}

function sanitizeCode(value) {
  if (typeof value !== 'string') return '';
  const up = value.toUpperCase().replace(/[^A-Z]/g, '');
  return up.slice(0, CODE_LENGTH);
}

/** FNV-1a over the room code — every client builds the same island. */
function seedFromCode(code) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// ---------------- Manager ----------------

export class RoomManager {
  constructor(io) {
    this.io = io;
    /** @type {Map<string, object>} code -> room */
    this.rooms = new Map();
    /** @type {Map<string, string>} socketId -> code */
    this.socketRoom = new Map();
  }

  // --------- code allocation ---------

  makeCode() {
    for (let attempt = 0; attempt < 500; attempt++) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) {
        code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    // Astronomically unlikely fallback.
    let n = this.rooms.size;
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) { code += CODE_ALPHABET[n % CODE_ALPHABET.length]; n = Math.floor(n / CODE_ALPHABET.length); }
    return code;
  }

  // --------- lookups ---------

  roomOf(socket) {
    const code = this.socketRoom.get(socket.id);
    return code ? this.rooms.get(code) || null : null;
  }

  roomStatePayload(room) {
    const players = [];
    for (const m of room.members.values()) {
      players.push({
        id: m.id,
        name: m.name,
        color: m.color,
        ready: m.ready,
        isHost: m.id === room.hostId,
      });
    }
    return {
      code: room.code,
      name: room.name,
      players,
      hostId: room.hostId,
      settings: {
        maxPlayers: room.settings.maxPlayers,
        difficulty: room.settings.difficulty,
        quotaBase: Math.round(ECON.QUOTA_BASE * (room.settings.difficulty === 'chill' ? 0.7 : room.settings.difficulty === 'hard' ? 1.4 : 1)),
      },
      started: room.started,
    };
  }

  broadcastRoomState(room) {
    if (!room) return;
    this.io.to(room.code).emit(MSG.ROOM_STATE, this.roomStatePayload(room));
  }

  // --------- room lifecycle ---------

  createRoom(socket, data) {
    if (this.socketRoom.has(socket.id)) this.leaveRoom(socket, true);

    const name = sanitizeName(data.playerName);
    const code = this.makeCode();
    const room = {
      code,
      name: sanitizeText(data.roomName, MAX_ROOM_NAME_LEN, `${name}'s Island`),
      hostId: socket.id,
      settings: {
        maxPlayers: sanitizeMaxPlayers(data.maxPlayers),
        difficulty: sanitizeDifficulty(data.difficulty),
      },
      started: false,
      members: new Map(),
      game: null,
      seed: seedFromCode(code),
    };
    this.rooms.set(code, room);
    this.addMember(room, socket, name, sanitizeColor(data.color));
    console.log(`[room] ${code} created by ${name} (${room.settings.difficulty}, max ${room.settings.maxPlayers})`);
    this.broadcastRoomState(room);
  }

  joinRoom(socket, data) {
    const code = sanitizeCode(data.code);
    if (code.length !== CODE_LENGTH) {
      socket.emit(MSG.ERROR_MSG, { message: 'Room codes are 4 letters.' });
      return;
    }
    const room = this.rooms.get(code);
    if (!room) {
      socket.emit(MSG.ERROR_MSG, { message: `No island found with code ${code}.` });
      return;
    }
    if (room.members.size >= room.settings.maxPlayers) {
      socket.emit(MSG.ERROR_MSG, { message: 'That island is full.' });
      return;
    }
    if (this.socketRoom.has(socket.id)) this.leaveRoom(socket, true);

    const name = sanitizeName(data.playerName);
    const member = this.addMember(room, socket, name, sanitizeColor(data.color));

    // Late join / rejoin: drop straight into the run that is already underway.
    // A player who refreshed or lost connection gets their gear back (matched by name).
    if (room.started && room.game) {
      const game = room.game;
      const player = game.addPlayer({ id: member.id, name: member.name, color: member.color });
      const restored = game.restoreDeparted(player);
      const state = game.worldStatePayload();
      socket.emit(MSG.GAME_START, {
        world: { seed: room.seed, code: room.code, difficulty: room.settings.difficulty },
        you: { id: member.id, name: member.name, color: member.color },
        state,
      });
      game.syncNewcomer(player);
      this.io.to(room.code).emit(MSG.CHAT_MSG, {
        fromName: 'ISLAND',
        text: restored ? `${name} is back on the island.` : `${name} washed ashore and joined the crew.`,
      });
      this.broadcastRoomState(room);
      console.log(`[room] ${room.code} late join: ${name}${restored ? ' (restored)' : ''}`);
      return;
    }

    this.io.to(room.code).emit(MSG.CHAT_MSG, { fromName: 'ISLAND', text: `${name} joined.` });
    this.broadcastRoomState(room);
  }

  addMember(room, socket, name, color) {
    // Give everyone a distinct colour when the requested one is taken.
    const taken = new Set();
    for (const m of room.members.values()) taken.add(m.color);
    let c = color;
    if (taken.has(c)) {
      for (let i = 0; i < PLAYER_COLORS.length; i++) {
        const cand = (color + i) % PLAYER_COLORS.length;
        if (!taken.has(cand)) { c = cand; break; }
      }
    }
    const member = { id: socket.id, name, color: c, ready: false, lastChat: 0 };
    room.members.set(socket.id, member);
    this.socketRoom.set(socket.id, room.code);
    socket.join(room.code);
    return member;
  }

  setReady(socket, data) {
    const room = this.roomOf(socket);
    if (!room || room.started) return;
    const member = room.members.get(socket.id);
    if (!member) return;
    member.ready = !!data.ready;
    this.broadcastRoomState(room);
  }

  /**
   * @param {boolean} silent - true when the socket is immediately re-joining
   *                           somewhere else (no chat spam).
   */
  leaveRoom(socket, silent) {
    const code = this.socketRoom.get(socket.id);
    if (!code) return;
    const room = this.rooms.get(code);
    this.socketRoom.delete(socket.id);
    try { socket.leave(code); } catch { /* socket already gone */ }
    if (!room) return;

    const member = room.members.get(socket.id);
    room.members.delete(socket.id);

    if (room.game) room.game.removePlayer(socket.id);
    if (room.destroying || this.rooms.get(code) !== room) return;

    if (room.members.size === 0) {
      this.destroyRoom(room, 'empty');
      return;
    }

    // Host migration: oldest remaining member takes the wheel.
    if (room.hostId === socket.id) {
      room.hostId = room.members.keys().next().value;
      const newHost = room.members.get(room.hostId);
      if (newHost) {
        this.io.to(room.code).emit(MSG.CHAT_MSG, { fromName: 'ISLAND', text: `${newHost.name} is now the host.` });
      }
    }

    if (!silent && member) {
      this.io.to(room.code).emit(MSG.CHAT_MSG, { fromName: 'ISLAND', text: `${member.name} left.` });
    }
    this.broadcastRoomState(room);
  }

  destroyRoom(room, reason) {
    if (!room || room.destroying) return;
    room.destroying = true;
    if (room.game) { const g = room.game; room.game = null; g.stop(reason || 'destroyed'); }
    if (room.relobbyTimer) { clearTimeout(room.relobbyTimer); room.relobbyTimer = null; }
    for (const id of room.members.keys()) this.socketRoom.delete(id);
    room.members.clear();
    this.rooms.delete(room.code);
    console.log(`[room] ${room.code} closed (${reason || 'empty'})`);
  }

  // --------- starting the run ---------

  startGame(socket) {
    const room = this.roomOf(socket);
    if (!room) return;
    if (socket.id !== room.hostId) {
      socket.emit(MSG.ERROR_MSG, { message: 'Only the host can start the run.' });
      return;
    }
    if (room.started) {
      socket.emit(MSG.ERROR_MSG, { message: 'The run already started.' });
      return;
    }
    if (room.members.size === 0) return;

    if (room.members.size > 1) {
      for (const m of room.members.values()) {
        if (m.id === room.hostId) continue;
        if (!m.ready) {
          socket.emit(MSG.ERROR_MSG, { message: 'Everyone has to ready up first.' });
          return;
        }
      }
    }

    const members = [];
    for (const m of room.members.values()) members.push({ id: m.id, name: m.name, color: m.color });

    const game = new Game({
      io: this.io,
      code: room.code,
      members,
      settings: room.settings,
      seed: room.seed,
      onEnd: (reason) => this.onGameEnd(room.code, reason),
    });
    room.game = game;
    room.started = true;

    const state = game.worldStatePayload();
    for (const m of room.members.values()) {
      this.io.to(m.id).emit(MSG.GAME_START, {
        world: { seed: room.seed, code: room.code, difficulty: room.settings.difficulty },
        you: { id: m.id, name: m.name, color: m.color },
        state,
      });
    }

    this.broadcastRoomState(room);
    game.start();
    this.io.to(room.code).emit(MSG.CHAT_MSG, {
      fromName: 'ISLAND',
      text: `Day 1. Quota $${state.quota.target} by day ${state.quota.deadlineDay}. Good luck out there.`,
    });
    console.log(`[room] ${room.code} started with ${members.length} player(s)`);
  }

  /** Called by Game when it stops for any reason. Returns the room to the lobby. */
  onGameEnd(code, reason) {
    const room = this.rooms.get(code);
    if (!room || room.destroying) return;
    room.game = null;
    console.log(`[room] ${code} game ended (${reason})`);

    if (room.members.size === 0) { this.destroyRoom(room, 'empty'); return; }

    // Let the win/lose screen breathe, then re-open the lobby so the crew
    // can immediately run it back.
    if (room.relobbyTimer) clearTimeout(room.relobbyTimer);
    room.relobbyTimer = setTimeout(() => {
      room.relobbyTimer = null;
      const live = this.rooms.get(code);
      if (!live || live.game) return;
      live.started = false;
      for (const m of live.members.values()) m.ready = false;
      this.broadcastRoomState(live);
    }, RELOBBY_DELAY_MS);
    if (room.relobbyTimer.unref) room.relobbyTimer.unref();
  }

  // --------- chat ---------

  chat(socket, data) {
    const room = this.roomOf(socket);
    if (!room) return;
    const member = room.members.get(socket.id);
    if (!member) return;

    const now = Date.now();
    if (now - member.lastChat < CHAT_COOLDOWN_MS) return;
    member.lastChat = now;

    const text = sanitizeText(data.text, MAX_CHAT_LEN, '');
    if (!text) return;
    this.io.to(room.code).emit(MSG.CHAT_MSG, { fromName: member.name, text });
  }

  // =========================================================
  // Socket wiring
  // =========================================================

  handleConnection(socket) {
    const data = (d) => (d && typeof d === 'object' ? d : {});

    // ---- lobby ----
    socket.on(MSG.CREATE_ROOM, (d) => this.guard(socket, () => this.createRoom(socket, data(d))));
    socket.on(MSG.JOIN_ROOM, (d) => this.guard(socket, () => this.joinRoom(socket, data(d))));
    socket.on(MSG.SET_READY, (d) => this.guard(socket, () => this.setReady(socket, data(d))));
    socket.on(MSG.LEAVE_ROOM, () => this.guard(socket, () => this.leaveRoom(socket, false)));
    socket.on(MSG.START_GAME, () => this.guard(socket, () => this.startGame(socket)));
    socket.on(MSG.CHAT, (d) => this.guard(socket, () => this.chat(socket, data(d))));

    // ---- in game (delegated to the room's Game, if any) ----
    const toGame = (msg, method) => {
      socket.on(msg, (d) => this.guard(socket, () => {
        const room = this.roomOf(socket);
        if (!room || !room.game) return;
        room.game[method](socket.id, data(d));
      }));
    };

    toGame(MSG.MOVE, 'onMove');
    toGame(MSG.BOARD_BOAT, 'onBoardBoat');
    toGame(MSG.LEAVE_BOAT, 'onLeaveBoat');
    toGame(MSG.DRIVE_BOAT, 'onDriveBoat');
    toGame(MSG.CAST_START, 'onCastStart');
    toGame(MSG.REEL_DONE, 'onReelDone');
    toGame(MSG.CANCEL_CAST, 'onCancelCast');
    toGame(MSG.SELL_FISH, 'onSellFish');
    toGame(MSG.BUY_ITEM, 'onBuyItem');
    toGame(MSG.DAMAGE_ENEMY, 'onDamageEnemy');
    toGame(MSG.PLAYER_HIT, 'onPlayerHit');
    toGame(MSG.BUILD_PORTAL, 'onBuildPortal');
    toGame(MSG.ENTER_PORTAL, 'onEnterPortal');

    socket.on('disconnect', () => this.guard(socket, () => this.leaveRoom(socket, false)));
  }

  /** One bad payload must never take the server down. */
  guard(socket, fn) {
    try {
      fn();
    } catch (err) {
      console.error('[socket]', socket.id, err);
      try { socket.emit(MSG.ERROR_MSG, { message: 'Something went wrong on the island.' }); } catch { /* ignore */ }
    }
  }

  // --------- introspection (used by /health) ---------

  stats() {
    let players = 0;
    let inGame = 0;
    for (const room of this.rooms.values()) {
      players += room.members.size;
      if (room.started) inGame++;
    }
    return { rooms: this.rooms.size, players, inGame };
  }
}

export default RoomManager;
