const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cookieParser = require('cookie-parser');
const { router: authRouter, verifyToken } = require('./auth');
const { stmts } = require('./db');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cookieParser());
app.use('/api/auth', authRouter);
app.use(express.static(path.join(__dirname, 'public')));

// ─── Room Management ──────────────────────────────────
const rooms = new Map(); // code -> Room instance

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

// Teams: P1(slot0) + P4(slot3) = team1, P2(slot1) + P3(slot2) = team2
// Round rotation (circular): P1→P2→P3→P4→P1→...
// Pattern: secretHolder=S, receiver=R=(S+1)%4
//   Clue givers alternate: R, S, R, S...
//   Guessers alternate: (R+1)%4, (R+2)%4, (R+1)%4, (R+2)%4...

function getTeam(slot) {
  return (slot === 0 || slot === 3) ? 'team1' : 'team2';
}

function getRoundConfig(roundStarter, turnWithinRound) {
  const S = roundStarter;
  const R = (S + 1) % 4;
  const clueGiver = (turnWithinRound % 2 === 0) ? R : S;
  const guesser = (turnWithinRound % 2 === 0) ? (R + 1) % 4 : (R + 2) % 4;
  return { secretHolder: S, receiver: R, clueGiver, guesser };
}

class Room {
  constructor(code, name, createdBy) {
    this.code = code;
    this.name = name || 'Game Room';
    this.createdBy = createdBy; // userId
    this.scheduledStart = null; // ISO string
    this.scheduleTimer = null;
    this.winScore = 10; // points needed to win
    this.guessTime = 30; // seconds per guess (0 = unlimited)

    // Game state
    this.players = {}; // socketId -> { slot, name, userId, avatar, stats }
    this.slots = [null, null, null, null];
    this.slotNames = ['', '', '', ''];
    this.slotProfiles = [null, null, null, null];
    this.slotDisconnected = [false, false, false, false];
    this.slotReserved = [null, null, null, null];
    this.adminSlot = -1;
    this.phase = 'lobby'; // lobby | waiting | countdown | secret | clue | guess | roundOver | gameOver
    this.scores = { team1: 0, team2: 0 };
    this.secretWord = null;
    this.clues = [];
    this.roundStarter = 0;
    this.turnWithinRound = 0;
    this.timer = null;
    this.timeLeft = 0;
    this.countdownLeft = 0;
    this.disconnectTimer = null;
  }

  getSlotName(slot) {
    return this.slotNames[slot] || `Player ${slot + 1}`;
  }

  // Emit to all sockets in this room
  emitToRoom(event, data) {
    for (const sid of Object.keys(this.players)) {
      io.to(sid).emit(event, data);
    }
  }

  broadcastLobby() {
    const lobbyState = {
      code: this.code,
      name: this.name,
      createdBy: this.createdBy,
      scheduledStart: this.scheduledStart,
      phase: this.phase,
      countdownLeft: this.countdownLeft,
      winScore: this.winScore,
      guessTime: this.guessTime,
      slots: this.slots.map((s, idx) => {
        if (!s && !this.slotDisconnected[idx] && !this.slotReserved[idx]) return null;
        return { slot: idx, name: this.getSlotName(idx), connected: !!s && !this.slotDisconnected[idx], disconnected: this.slotDisconnected[idx] };
      }),
      slotNames: this.slotNames,
      slotProfiles: this.slotProfiles,
      adminSlot: this.adminSlot,
    };
    for (const [sid, player] of Object.entries(this.players)) {
      io.to(sid).emit('roomState', { ...lobbyState, mySlot: player.slot });
    }
  }

  broadcastGameState() {
    const config = this.phase !== 'waiting' && this.phase !== 'lobby' && this.phase !== 'gameOver' && this.phase !== 'countdown'
      ? getRoundConfig(this.roundStarter, this.turnWithinRound)
      : null;

    for (let i = 0; i < 4; i++) {
      const sid = this.slots[i];
      if (!sid) continue;

      const state = {
        roomCode: this.code,
        roomName: this.name,
        phase: this.phase,
        scores: this.scores,
        winScore: this.winScore,
        guessTime: this.guessTime,
        slots: this.slots.map((s, idx) => (s || this.slotDisconnected[idx]) ? { slot: idx, name: this.getSlotName(idx), connected: !!s && !this.slotDisconnected[idx], disconnected: this.slotDisconnected[idx] } : null),
        slotNames: this.slotNames,
        slotProfiles: this.slotProfiles,
        adminSlot: this.adminSlot,
        mySlot: i,
        clues: this.clues,
        timeLeft: this.timeLeft,
        countdownLeft: this.countdownLeft,
        secretWord: null,
        currentTurn: config ? { secretHolder: config.secretHolder, clueGiver: config.clueGiver, guesser: config.guesser } : null,
        roundStarter: this.roundStarter,
      };

      if (this.secretWord && config) {
        if (i === config.secretHolder || i === config.receiver) {
          state.secretWord = this.secretWord;
        }
      }

      io.to(sid).emit('state', state);
    }

    // Spectators in this room
    for (const [sid, player] of Object.entries(this.players)) {
      if (player.slot === -1) {
        io.to(sid).emit('state', {
          roomCode: this.code,
          roomName: this.name,
          phase: this.phase,
          scores: this.scores,
          slots: this.slots.map((s, idx) => (s || this.slotDisconnected[idx]) ? { slot: idx, name: this.getSlotName(idx), connected: !!s && !this.slotDisconnected[idx], disconnected: this.slotDisconnected[idx] } : null),
          slotNames: this.slotNames,
          slotProfiles: this.slotProfiles,
          adminSlot: this.adminSlot,
          mySlot: -1,
          clues: this.clues,
          timeLeft: this.timeLeft,
          countdownLeft: this.countdownLeft,
          secretWord: null,
          currentTurn: config ? { secretHolder: config.secretHolder, clueGiver: config.clueGiver, guesser: config.guesser } : null,
          roundStarter: this.roundStarter,
        });
      }
    }
  }

  clearTimer() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  startGuessTimer() {
    if (this.guessTime === 0) {
      // Unlimited mode — no timer
      this.timeLeft = 0;
      this.clearTimer();
      return;
    }
    this.timeLeft = this.guessTime;
    this.clearTimer();
    this.timer = setInterval(() => {
      this.timeLeft--;
      if (this.timeLeft <= 0) {
        this.clearTimer();
        this.turnWithinRound++;
        this.startClueTurn();
      } else {
        this.emitToRoom('tick', this.timeLeft);
      }
    }, 1000);
  }

  startClueTurn() {
    this.clearTimer();
    this.phase = 'clue';
    this.broadcastGameState();
    this.checkDisconnectedTurn();
  }

  startNewRound() {
    this.secretWord = null;
    this.clues = [];
    this.turnWithinRound = 0;
    this.phase = 'secret';
    this.broadcastGameState();
    this.checkDisconnectedTurn();
  }

  checkWin() {
    const { team1, team2 } = this.scores;
    const maxScore = Math.max(team1, team2);
    const diff = Math.abs(team1 - team2);
    if (maxScore >= this.winScore && diff >= 2) {
      this.phase = 'gameOver';
      this.clearTimer();

      const winningTeam = team1 > team2 ? 'team1' : 'team2';
      for (let i = 0; i < 4; i++) {
        const sid = this.slots[i];
        if (!sid) continue;
        const p = this.players[sid];
        if (!p || !p.userId) continue;
        if (getTeam(i) === winningTeam) {
          stmts.addGameWon.run(p.userId);
        } else {
          stmts.addGamePlayed.run(p.userId);
        }
        const fresh = stmts.getProfile.get(p.userId);
        if (fresh) {
          p.stats = { games_played: fresh.games_played, games_won: fresh.games_won };
          if (this.slotProfiles[i]) this.slotProfiles[i].stats = p.stats;
        }
      }

      stmts.updateRoomStatus.run('finished', this.code);
      this.broadcastGameState();
      return true;
    }
    return false;
  }

  checkDisconnectedTurn() {
    if (this.disconnectTimer) { clearTimeout(this.disconnectTimer); this.disconnectTimer = null; }
    if (this.phase !== 'secret' && this.phase !== 'clue' && this.phase !== 'guess') return;

    const config = getRoundConfig(this.roundStarter, this.turnWithinRound);
    let activeSlot = -1;
    if (this.phase === 'secret') activeSlot = config.secretHolder;
    else if (this.phase === 'clue') activeSlot = config.clueGiver;
    else if (this.phase === 'guess') activeSlot = config.guesser;

    if (activeSlot >= 0 && this.slotDisconnected[activeSlot]) {
      this.disconnectTimer = setTimeout(() => {
        this.disconnectTimer = null;
        if (!this.slotDisconnected[activeSlot]) return;
        console.log(`[${this.code}] Auto-skipping turn for disconnected slot ${activeSlot}`);
        if (this.phase === 'secret') {
          this.secretWord = '???';
          this.phase = 'clue';
          this.broadcastGameState();
        } else if (this.phase === 'clue') {
          this.turnWithinRound++;
          this.startClueTurn();
        } else if (this.phase === 'guess') {
          this.clearTimer();
          this.turnWithinRound++;
          this.startClueTurn();
        }
      }, 15000);
    }
  }

  addPlayer(socketId, authUser) {
    this.players[socketId] = {
      slot: -1, name: '',
      userId: authUser?.id || null,
      avatar: authUser?.avatar || null,
      stats: authUser ? { games_played: authUser.games_played, games_won: authUser.games_won } : null
    };
  }

  tryReconnect(socketId, authUser, reconnectToken) {
    for (let i = 0; i < 4; i++) {
      if (!this.slotDisconnected[i]) continue;
      const res = this.slotReserved[i];
      if (!res) continue;
      if ((authUser && res.userId && authUser.id === res.userId) ||
          (reconnectToken && res.reconnectToken && reconnectToken === res.reconnectToken)) {
        this.slots[i] = socketId;
        this.slotDisconnected[i] = false;
        this.players[socketId] = {
          slot: i, name: res.name,
          userId: authUser?.id || res.userId || null,
          avatar: authUser?.avatar || res.avatar || null,
          stats: authUser ? { games_played: authUser.games_played, games_won: authUser.games_won } : res.stats || null
        };
        if (authUser) {
          this.slotProfiles[i] = { userId: authUser.id, avatar: authUser.avatar, stats: { games_played: authUser.games_played, games_won: authUser.games_won } };
        }
        console.log(`[${this.code}] Player reconnected to slot ${i}: ${res.name}`);
        if (this.disconnectTimer) { clearTimeout(this.disconnectTimer); this.disconnectTimer = null; }
        this.checkDisconnectedTurn();
        return { slot: i, name: res.name, reconnectToken: res.reconnectToken };
      }
    }
    return null;
  }

  joinSlot(socketId, slot, name) {
    if (slot < 0 || slot > 3) return null;
    if (this.slots[slot] !== null) return null;
    if (this.phase !== 'lobby' && this.phase !== 'waiting' && this.phase !== 'countdown') return null;

    const player = this.players[socketId];
    if (!player) return null;

    // Remove from previous slot
    if (player.slot >= 0) {
      this.slots[player.slot] = null;
      this.slotNames[player.slot] = '';
      this.slotProfiles[player.slot] = null;
      this.slotReserved[player.slot] = null;
    }

    const trimmedName = (name || '').trim().substring(0, 20) || `Player ${slot + 1}`;
    this.slots[slot] = socketId;
    this.slotNames[slot] = trimmedName;
    this.slotDisconnected[slot] = false;
    this.players[socketId] = { slot, name: trimmedName, userId: player.userId, avatar: player.avatar, stats: player.stats };
    this.slotProfiles[slot] = player.userId ? { userId: player.userId, avatar: player.avatar, stats: player.stats } : null;

    const rToken = player.userId ? null : Math.random().toString(36).substring(2) + Date.now().toString(36);
    this.slotReserved[slot] = {
      userId: player.userId, reconnectToken: rToken, name: trimmedName,
      avatar: player.avatar, stats: player.stats, profile: this.slotProfiles[slot]
    };

    if (this.adminSlot === -1) this.adminSlot = slot;

    // Persist participant
    if (player.userId) {
      try { stmts.addParticipant.run(this.code, player.userId, slot); } catch(e) {}
    }

    return { slot, name: trimmedName, reconnectToken: rToken };
  }

  // Admin can move a player to a different slot (team arrangement)
  movePlayer(adminSocketId, fromSlot, toSlot) {
    const admin = this.players[adminSocketId];
    if (!admin || admin.slot !== this.adminSlot) return false;
    if (this.phase !== 'lobby' && this.phase !== 'waiting') return false;
    if (fromSlot < 0 || fromSlot > 3 || toSlot < 0 || toSlot > 3) return false;
    if (this.slots[fromSlot] === null && !this.slotReserved[fromSlot]) return false;
    if (this.slots[toSlot] !== null) return false; // target must be empty

    // Swap all data
    const sid = this.slots[fromSlot];
    this.slots[toSlot] = sid;
    this.slots[fromSlot] = null;
    this.slotNames[toSlot] = this.slotNames[fromSlot];
    this.slotNames[fromSlot] = '';
    this.slotProfiles[toSlot] = this.slotProfiles[fromSlot];
    this.slotProfiles[fromSlot] = null;
    this.slotDisconnected[toSlot] = this.slotDisconnected[fromSlot];
    this.slotDisconnected[fromSlot] = false;
    this.slotReserved[toSlot] = this.slotReserved[fromSlot];
    this.slotReserved[fromSlot] = null;

    if (sid && this.players[sid]) {
      this.players[sid].slot = toSlot;
    }
    if (fromSlot === this.adminSlot) this.adminSlot = toSlot;

    return true;
  }

  startGame(socketId) {
    const player = this.players[socketId];
    if (!player || player.slot !== this.adminSlot) return false;
    if (this.phase !== 'lobby' && this.phase !== 'waiting') return false;
    if (!this.slots.every(s => s !== null)) return false;

    this.clearTimer();
    this.countdownLeft = 0;
    this.roundStarter = 0;
    this.scores = { team1: 0, team2: 0 };
    stmts.updateRoomStatus.run('playing', this.code);
    this.startNewRound();
    return true;
  }

  startCountdown(socketId, seconds) {
    const player = this.players[socketId];
    if (!player || player.slot !== this.adminSlot) return false;
    if (this.phase !== 'lobby' && this.phase !== 'waiting') return false;

    const secs = Math.max(5, Math.min(300, parseInt(seconds) || 30));
    this.phase = 'countdown';
    this.countdownLeft = secs;
    this.clearTimer();
    this.broadcastLobby();

    this.timer = setInterval(() => {
      this.countdownLeft--;
      if (this.countdownLeft <= 0) {
        this.clearTimer();
        if (this.slots.every(s => s !== null)) {
          this.countdownLeft = 0;
          this.roundStarter = 0;
          this.scores = { team1: 0, team2: 0 };
          stmts.updateRoomStatus.run('playing', this.code);
          this.startNewRound();
        } else {
          this.phase = 'lobby';
          this.countdownLeft = 0;
          this.broadcastLobby();
        }
      } else {
        this.emitToRoom('countdownTick', this.countdownLeft);
      }
    }, 1000);
    return true;
  }

  cancelCountdown(socketId) {
    const player = this.players[socketId];
    if (!player || player.slot !== this.adminSlot) return false;
    if (this.phase !== 'countdown') return false;
    this.clearTimer();
    this.phase = 'lobby';
    this.countdownLeft = 0;
    this.broadcastLobby();
    return true;
  }

  submitSecret(socketId, word) {
    if (this.phase !== 'secret') return;
    const player = this.players[socketId];
    if (!player || player.slot === -1) return;
    const config = getRoundConfig(this.roundStarter, this.turnWithinRound);
    if (player.slot !== config.secretHolder) return;
    const trimmed = (word || '').trim();
    if (!trimmed) return;
    this.secretWord = trimmed;
    this.phase = 'clue';
    this.broadcastGameState();
  }

  submitClue(socketId, word) {
    if (this.phase !== 'clue') return;
    const player = this.players[socketId];
    if (!player || player.slot === -1) return;
    const config = getRoundConfig(this.roundStarter, this.turnWithinRound);
    if (player.slot !== config.clueGiver) return;
    const trimmed = (word || '').trim();
    if (!trimmed) return;
    const oneWord = trimmed.split(/\s+/)[0];
    this.clues.push({ from: player.slot, word: oneWord });
    this.phase = 'guess';
    this.startGuessTimer();
    this.broadcastGameState();
    this.checkDisconnectedTurn();
  }

  submitGuess(socketId, word) {
    if (this.phase !== 'guess') return;
    const player = this.players[socketId];
    if (!player || player.slot === -1) return;
    const config = getRoundConfig(this.roundStarter, this.turnWithinRound);
    if (player.slot !== config.guesser) return;
    const trimmed = (word || '').trim();
    if (!trimmed) return;
    const oneWord = trimmed.split(/\s+/)[0];

    if (oneWord.toLowerCase() === this.secretWord.toLowerCase()) {
      this.clearTimer();
      const team = getTeam(player.slot);
      this.scores[team]++;
      if (this.checkWin()) return;
      this.roundStarter = (this.roundStarter + 1) % 4;
      this.phase = 'roundOver';
      this.broadcastGameState();
      setTimeout(() => {
        if (this.phase === 'roundOver') this.startNewRound();
      }, 3000);
    } else {
      this.clearTimer();
      this.clues.push({ from: player.slot, word: oneWord, isGuess: true, wrong: true });
      this.turnWithinRound++;
      this.startClueTurn();
    }
  }

  resetGame(socketId) {
    this.clearTimer();
    if (this.disconnectTimer) { clearTimeout(this.disconnectTimer); this.disconnectTimer = null; }
    const oldSlots = [...this.slots];
    const oldNames = [...this.slotNames];
    const oldProfiles = [...this.slotProfiles];
    const oldReserved = [...this.slotReserved];
    const oldPlayers = { ...this.players };
    const oldAdmin = this.adminSlot;

    // Reset game fields
    this.scores = { team1: 0, team2: 0 };
    this.secretWord = null;
    this.clues = [];
    this.roundStarter = 0;
    this.turnWithinRound = 0;
    this.timeLeft = 0;
    this.countdownLeft = 0;
    this.phase = 'lobby';
    this.slotDisconnected = [false, false, false, false];

    // Re-assign connected players
    this.slots = [null, null, null, null];
    this.slotNames = ['', '', '', ''];
    this.slotProfiles = [null, null, null, null];
    this.slotReserved = [null, null, null, null];

    for (let i = 0; i < 4; i++) {
      if (oldSlots[i] && io.sockets.sockets.get(oldSlots[i])) {
        this.slots[i] = oldSlots[i];
        this.slotNames[i] = oldNames[i];
        this.slotProfiles[i] = oldProfiles[i];
        this.slotReserved[i] = oldReserved[i];
        const op = oldPlayers[oldSlots[i]];
        this.players[oldSlots[i]] = { slot: i, name: oldNames[i], userId: op?.userId || null, avatar: op?.avatar || null, stats: op?.stats || null };
      }
    }

    this.adminSlot = (oldAdmin >= 0 && this.slots[oldAdmin]) ? oldAdmin : -1;
    if (this.adminSlot === -1) {
      for (let i = 0; i < 4; i++) {
        if (this.slots[i] !== null) { this.adminSlot = i; break; }
      }
    }
    stmts.updateRoomStatus.run('lobby', this.code);
    this.broadcastLobby();
    this.emitToRoom('gameReset');
  }

  handleDisconnect(socketId) {
    const player = this.players[socketId];
    if (!player) return;

    if (player.slot >= 0) {
      const slot = player.slot;
      const wasAdmin = slot === this.adminSlot;

      // Always keep slotted players reserved — they can reconnect
      this.slots[slot] = null;
      this.slotDisconnected[slot] = true;
      console.log(`[${this.code}] Slot ${slot} (${player.name}) disconnected - reserved`);

      if (wasAdmin) {
        this.adminSlot = -1;
        for (let i = 0; i < 4; i++) {
          if (this.slots[i] !== null && !this.slotDisconnected[i]) { this.adminSlot = i; break; }
        }
      }

      if (this.phase === 'countdown') {
        this.clearTimer();
        this.phase = 'lobby';
        this.countdownLeft = 0;
      }

      const anyConnected = Object.keys(this.players).filter(s => s !== socketId).length > 0;
      if (!anyConnected) {
        this.clearTimer();
        if (this.disconnectTimer) { clearTimeout(this.disconnectTimer); this.disconnectTimer = null; }
      } else {
        this.checkDisconnectedTurn();
      }
    }

    delete this.players[socketId];

    // Broadcast appropriate state
    if (this.phase === 'lobby' || this.phase === 'waiting') {
      this.broadcastLobby();
    } else {
      this.broadcastGameState();
    }

    // Clean up empty rooms after a delay
    if (Object.keys(this.players).length === 0) {
      setTimeout(() => {
        if (Object.keys(this.players).length === 0) {
          console.log(`[${this.code}] Room empty, cleaning up`);
          this.clearTimer();
          if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
          if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
          rooms.delete(this.code);
        }
      }, 300000); // 5 minutes
    }
  }

  // Admin kicks a player from their slot — fully removes them
  kickPlayer(adminSocketId, targetSlot) {
    const admin = this.players[adminSocketId];
    if (!admin || admin.slot !== this.adminSlot) return false;
    if (targetSlot < 0 || targetSlot > 3 || targetSlot === this.adminSlot) return false;
    if (this.phase !== 'lobby' && this.phase !== 'waiting') return false;

    // Get info before clearing
    const targetSid = this.slots[targetSlot];
    const reserved = this.slotReserved[targetSlot];
    const targetUserId = reserved?.userId || (targetSid && this.players[targetSid]?.userId);

    // Clear the slot completely
    this.slots[targetSlot] = null;
    this.slotNames[targetSlot] = '';
    this.slotProfiles[targetSlot] = null;
    this.slotDisconnected[targetSlot] = false;
    this.slotReserved[targetSlot] = null;

    // Remove from DB participants
    if (targetUserId) {
      try { stmts.removeParticipant.run(this.code, targetUserId); } catch(e) {}
    }

    // If the kicked player is currently connected, remove them from the room
    if (targetSid && this.players[targetSid]) {
      delete this.players[targetSid];
      io.to(targetSid).emit('kicked', { message: 'You were removed from the room by the admin' });
      io.to(targetSid).emit('leftRoom');
      socketRooms.delete(targetSid);
    }

    console.log(`[${this.code}] Admin kicked slot ${targetSlot}`);
    return true;
  }
}

// ─── Resolve user from socket ──────────────────────────
function resolveUser(socket) {
  const token = socket.handshake.auth?.token;
  if (!token) return null;
  const decoded = verifyToken(token);
  if (!decoded) return null;
  return stmts.getProfile.get(decoded.userId) || null;
}

// Track which room each socket is in
const socketRooms = new Map(); // socketId -> roomCode
// Track which socket(s) belong to each userId (for real-time notifications)
const userSockets = new Map(); // userId -> Set<socketId>

// ─── Socket connection ─────────────────────────────────
io.on('connection', (socket) => {
  console.log(`Connected: ${socket.id}`);
  const authUser = resolveUser(socket);

  // Track authenticated user's socket for friend notifications
  if (authUser) {
    if (!userSockets.has(authUser.id)) userSockets.set(authUser.id, new Set());
    userSockets.get(authUser.id).add(socket.id);
  }

  // Auto-reconnect: if user has a disconnected slot in any room, rejoin them
  if (authUser) {
    const myGames = stmts.getMyGames.all(authUser.id);
    for (const g of myGames) {
      const room = rooms.get(g.code);
      if (!room) continue;
      for (let i = 0; i < 4; i++) {
        if (!room.slotDisconnected[i]) continue;
        const res = room.slotReserved[i];
        if (res && res.userId === authUser.id) {
          // Found a disconnected slot — auto-reconnect
          socketRooms.set(socket.id, room.code);
          const result = room.tryReconnect(socket.id, authUser, null);
          if (result) {
            socket.emit('joinedRoom', { code: room.code, roomName: room.name, ...result });
            if (room.phase === 'lobby' || room.phase === 'waiting') {
              room.broadcastLobby();
            } else {
              room.broadcastGameState();
            }
          }
          break;
        }
      }
      if (socketRooms.has(socket.id)) break; // already reconnected
    }
  }

  // Create a new room
  socket.on('createRoom', ({ name, scheduledStart } = {}) => {
    if (!authUser) { socket.emit('error', { message: 'Login required to create a room' }); return; }

    const code = generateCode();
    const roomName = (name || '').trim().substring(0, 40) || 'Game Room';
    const room = new Room(code, roomName, authUser.id);

    if (scheduledStart) {
      room.scheduledStart = scheduledStart;
    }

    // Persist to DB
    try {
      stmts.createRoom.run(code, roomName, authUser.id, scheduledStart || null);
    } catch (e) {
      console.error('Failed to create room in DB:', e);
    }

    rooms.set(code, room);
    console.log(`[${code}] Room created by ${authUser.username}`);
    socket.emit('roomCreated', { code, name: roomName });
  });

  // List all active public rooms
  socket.on('listPublicRooms', () => {
    const result = [];
    for (const [code, room] of rooms) {
      const playerCount = Object.keys(room.players).length;
      const slotsTaken = room.slots.filter(s => s !== null).length;
      result.push({
        code,
        name: room.name,
        status: room.phase,
        playerCount,
        slotsTaken,
        slotsTotal: 4,
      });
    }
    socket.emit('publicRooms', result);
  });

  // List rooms created by the current user
  socket.on('listMyRooms', () => {
    if (!authUser) { socket.emit('myRooms', []); return; }
    const dbRooms = stmts.getRoomsByUser.all(authUser.id);
    const result = dbRooms.map(r => {
      const live = rooms.get(r.code);
      return {
        code: r.code,
        name: r.name,
        status: live ? live.phase : r.status,
        scheduledStart: r.scheduled_start,
        playerCount: live ? Object.keys(live.players).length : 0,
        createdAt: r.created_at,
      };
    });
    socket.emit('myRooms', result);
  });

  socket.on('listMyGames', () => {
    if (!authUser) { socket.emit('myGames', []); return; }
    const games = stmts.getMyGames.all(authUser.id).map(g => {
      const live = rooms.get(g.code);
      return {
        code: g.code,
        name: g.name,
        status: live ? live.phase : g.status,
        playerCount: live ? Object.keys(live.players).length : 0,
        mySlot: g.slot,
      };
    });
    socket.emit('myGames', games);
  });

  // Join a room
  socket.on('joinRoom', ({ code, reconnectToken: rToken } = {}) => {
    if (!code) return;
    const roomCode = code.toUpperCase().trim();
    const room = rooms.get(roomCode);

    if (!room) {
      // Check DB for persisted room
      const dbRoom = stmts.findRoomByCode.get(roomCode);
      if (!dbRoom || dbRoom.status === 'finished') {
        socket.emit('error', { message: 'Room not found' });
        return;
      }
      // Re-create room from DB
      const newRoom = new Room(roomCode, dbRoom.name, dbRoom.created_by);
      newRoom.scheduledStart = dbRoom.scheduled_start;
      rooms.set(roomCode, newRoom);
      joinExistingRoom(socket, newRoom, authUser, rToken);
      return;
    }

    joinExistingRoom(socket, room, authUser, rToken);
  });

  function joinExistingRoom(sock, room, user, rToken) {
    // Leave current room if any
    const prevCode = socketRooms.get(sock.id);
    if (prevCode && prevCode !== room.code) {
      const prevRoom = rooms.get(prevCode);
      if (prevRoom) prevRoom.handleDisconnect(sock.id);
    }

    socketRooms.set(sock.id, room.code);

    // Try reconnect
    const reconnectResult = room.tryReconnect(sock.id, user, rToken);
    if (reconnectResult) {
      sock.emit('joinedRoom', { code: room.code, roomName: room.name, ...reconnectResult });
      if (room.phase === 'lobby' || room.phase === 'waiting') {
        room.broadcastLobby();
      } else {
        room.broadcastGameState();
      }
      return;
    }

    // Normal join
    room.addPlayer(sock.id, user);
    sock.emit('joinedRoom', { code: room.code, roomName: room.name, slot: -1, name: 'Spectator' });
    room.broadcastLobby();
  }

  // Delete/cancel a room (creator only, lobby/countdown only)
  socket.on('deleteRoom', ({ code } = {}) => {
    if (!code || !authUser) return;

    const room = rooms.get(code);
    if (room) {
      // Room is live in memory
      if (room.createdBy !== authUser.id) {
        socket.emit('error', { message: 'Only the room creator can delete this room' });
        return;
      }
      if (room.phase !== 'lobby' && room.phase !== 'waiting' && room.phase !== 'countdown') {
        socket.emit('error', { message: 'Cannot delete a room while a game is in progress' });
        return;
      }

      // Notify all players and kick them out
      room.clearTimer();
      if (room.disconnectTimer) clearTimeout(room.disconnectTimer);
      if (room.scheduleTimer) clearTimeout(room.scheduleTimer);
      for (const sid of Object.keys(room.players)) {
        io.to(sid).emit('roomDeleted', { code, message: 'Room was deleted by the creator' });
        io.to(sid).emit('leftRoom');
        socketRooms.delete(sid);
      }
      rooms.delete(code);
    }

    // Also delete from DB (handles DB-only rooms from previous sessions)
    try { stmts.deleteRoom.run(code, authUser.id); } catch (e) {}
    try { stmts.removeAllParticipants.run(code); } catch (e) {}
    console.log(`[${code}] Room deleted by ${authUser.username}`);

    // Refresh the caller's room list
    socket.emit('myRooms', stmts.getRoomsByUser.all(authUser.id).map(r => {
      const live = rooms.get(r.code);
      return { code: r.code, name: r.name, status: live ? live.phase : r.status, playerCount: live ? Object.keys(live.players).length : 0, createdAt: r.created_at };
    }));
  });

  // Leave a room (back to home) — only spectators (no slot) can voluntarily leave
  socket.on('leaveRoom', () => {
    const code = socketRooms.get(socket.id);
    if (!code) return;
    const room = rooms.get(code);
    if (room) {
      const player = room.players[socket.id];
      if (player && player.slot >= 0) {
        // Player has a slot — they can't voluntarily leave, just disconnect view
        socket.emit('leftRoom');
        return;
      }
      room.handleDisconnect(socket.id);
    }
    socketRooms.delete(socket.id);
    socket.emit('leftRoom');
  });

  // Admin kicks a player from a slot
  socket.on('kickPlayer', ({ slot } = {}) => {
    const code = socketRooms.get(socket.id);
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    if (room.kickPlayer(socket.id, slot)) {
      room.broadcastLobby();
    }
  });

  // Lobby chat
  socket.on('sendChat', ({ message } = {}) => {
    const code = socketRooms.get(socket.id);
    if (!code || !message) return;
    const room = rooms.get(code);
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    // Only allow chat in lobby/countdown phases
    if (room.phase !== 'lobby' && room.phase !== 'waiting' && room.phase !== 'countdown') return;
    const text = String(message).trim().substring(0, 200);
    if (!text) return;
    room.emitToRoom('chatMessage', { name: player.name, text, timestamp: Date.now() });
  });

  // ─── Friend system ──────────────────────────────
  function emitToUser(userId, event, data) {
    const socks = userSockets.get(userId);
    if (socks) for (const sid of socks) io.to(sid).emit(event, data);
  }

  socket.on('sendFriendRequest', ({ targetUserId } = {}) => {
    if (!authUser || !targetUserId || targetUserId === authUser.id) return;
    const target = stmts.getProfile.get(targetUserId);
    if (!target) return;
    const existing = stmts.checkFriendship.get(authUser.id, targetUserId, targetUserId, authUser.id);
    if (existing) {
      if (existing.status === 'accepted') { socket.emit('error', { message: 'Already friends' }); return; }
      if (existing.user_id === authUser.id) { socket.emit('error', { message: 'Request already sent' }); return; }
      // They sent us a request — auto-accept
      stmts.acceptFriendRequest.run(targetUserId, authUser.id);
      socket.emit('friendRequestAccepted', { id: targetUserId, username: target.username, avatar: target.avatar, games_played: target.games_played, games_won: target.games_won });
      emitToUser(targetUserId, 'friendRequestAccepted', { id: authUser.id, username: authUser.username, avatar: authUser.avatar, games_played: authUser.games_played, games_won: authUser.games_won });
      return;
    }
    stmts.sendFriendRequest.run(authUser.id, targetUserId);
    socket.emit('friendRequestSent', { targetUserId });
    emitToUser(targetUserId, 'friendRequestReceived', { id: authUser.id, username: authUser.username, avatar: authUser.avatar, games_played: authUser.games_played, games_won: authUser.games_won });
  });

  socket.on('acceptFriendRequest', ({ fromUserId } = {}) => {
    if (!authUser || !fromUserId) return;
    const result = stmts.acceptFriendRequest.run(fromUserId, authUser.id);
    if (result.changes > 0) {
      const from = stmts.getProfile.get(fromUserId);
      socket.emit('friendRequestAccepted', { id: fromUserId, username: from?.username, avatar: from?.avatar, games_played: from?.games_played, games_won: from?.games_won });
      emitToUser(fromUserId, 'friendRequestAccepted', { id: authUser.id, username: authUser.username, avatar: authUser.avatar, games_played: authUser.games_played, games_won: authUser.games_won });
    }
  });

  socket.on('declineFriendRequest', ({ fromUserId } = {}) => {
    if (!authUser || !fromUserId) return;
    stmts.removeFriendship.run(fromUserId, authUser.id, authUser.id, fromUserId);
    socket.emit('friendRequestDeclined', { fromUserId });
  });

  socket.on('removeFriend', ({ friendId } = {}) => {
    if (!authUser || !friendId) return;
    stmts.removeFriendship.run(authUser.id, friendId, friendId, authUser.id);
    socket.emit('friendRemoved', { friendId });
    emitToUser(friendId, 'friendRemoved', { friendId: authUser.id });
  });

  socket.on('listFriends', () => {
    if (!authUser) { socket.emit('friendsList', { friends: [], pending: [] }); return; }
    const friends = stmts.getFriends.all(authUser.id, authUser.id, authUser.id, authUser.id);
    const pending = stmts.getPendingRequests.all(authUser.id);
    // Add online status
    friends.forEach(f => { f.online = userSockets.has(f.id); });
    pending.forEach(p => { p.online = userSockets.has(p.id); });
    socket.emit('friendsList', { friends, pending });
  });

  socket.on('inviteFriendToRoom', ({ friendId, roomCode } = {}) => {
    if (!authUser || !friendId || !roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    emitToUser(friendId, 'roomInvite', { code: roomCode, roomName: room.name, fromUser: authUser.username });
  });

  // Room-scoped events
  socket.on('joinSlot', ({ slot, name }) => {
    const room = rooms.get(socketRooms.get(socket.id));
    if (!room) return;
    const result = room.joinSlot(socket.id, slot, name);
    if (result) {
      socket.emit('assigned', { ...result, roomCode: room.code });
      room.broadcastLobby();
    }
  });

  socket.on('movePlayer', ({ fromSlot, toSlot }) => {
    const room = rooms.get(socketRooms.get(socket.id));
    if (!room) return;
    if (room.movePlayer(socket.id, fromSlot, toSlot)) {
      // Notify moved player of their new slot
      const movedSid = room.slots[toSlot];
      if (movedSid) {
        io.to(movedSid).emit('assigned', { slot: toSlot, name: room.slotNames[toSlot], roomCode: room.code });
      }
      room.broadcastLobby();
    }
  });

  socket.on('setWinScore', ({ winScore } = {}) => {
    const room = rooms.get(socketRooms.get(socket.id));
    if (!room || !authUser || room.createdBy !== authUser.id) return;
    if (room.phase !== 'lobby' && room.phase !== 'waiting' && room.phase !== 'countdown') return;
    const score = parseInt(winScore);
    if (!score || score < 1 || score > 50) return;
    room.winScore = score;
    room.broadcastLobby();
  });

  socket.on('setGuessTime', ({ guessTime } = {}) => {
    const room = rooms.get(socketRooms.get(socket.id));
    if (!room || !authUser || room.createdBy !== authUser.id) return;
    if (room.phase !== 'lobby' && room.phase !== 'waiting' && room.phase !== 'countdown') return;
    const t = parseInt(guessTime);
    if (isNaN(t) || ![0, 30, 60].includes(t)) return;
    room.guessTime = t;
    room.broadcastLobby();
  });

  socket.on('setSchedule', ({ scheduledStart }) => {
    const room = rooms.get(socketRooms.get(socket.id));
    if (!room || !authUser || room.createdBy !== authUser.id) return;
    room.scheduledStart = scheduledStart || null;
    try { stmts.updateRoomSchedule.run(scheduledStart || null, room.code); } catch (e) {}

    // Set up auto-start timer if scheduled in the future
    if (room.scheduleTimer) { clearTimeout(room.scheduleTimer); room.scheduleTimer = null; }
    if (scheduledStart) {
      const ms = new Date(scheduledStart).getTime() - Date.now();
      if (ms > 0 && ms < 86400000) { // max 24h ahead
        room.scheduleTimer = setTimeout(() => {
          room.scheduleTimer = null;
          if (room.phase === 'lobby' && room.slots.every(s => s !== null)) {
            room.startGame(room.slots[room.adminSlot]);
          }
        }, ms);
      }
    }
    room.broadcastLobby();
  });

  socket.on('startGame', () => {
    const room = rooms.get(socketRooms.get(socket.id));
    if (room) room.startGame(socket.id);
  });

  socket.on('startCountdown', (seconds) => {
    const room = rooms.get(socketRooms.get(socket.id));
    if (room) room.startCountdown(socket.id, seconds);
  });

  socket.on('cancelCountdown', () => {
    const room = rooms.get(socketRooms.get(socket.id));
    if (room) room.cancelCountdown(socket.id);
  });

  socket.on('submitSecret', (word) => {
    const room = rooms.get(socketRooms.get(socket.id));
    if (room) room.submitSecret(socket.id, word);
  });

  socket.on('submitClue', (word) => {
    const room = rooms.get(socketRooms.get(socket.id));
    if (room) room.submitClue(socket.id, word);
  });

  socket.on('submitGuess', (word) => {
    const room = rooms.get(socketRooms.get(socket.id));
    if (room) room.submitGuess(socket.id, word);
  });

  socket.on('resetGame', () => {
    const room = rooms.get(socketRooms.get(socket.id));
    if (room) room.resetGame(socket.id);
  });

  socket.on('disconnect', () => {
    console.log(`Disconnected: ${socket.id}`);
    const code = socketRooms.get(socket.id);
    if (code) {
      const room = rooms.get(code);
      if (room) room.handleDisconnect(socket.id);
    }
    socketRooms.delete(socket.id);
    // Clean up user socket tracking
    if (authUser) {
      const socks = userSockets.get(authUser.id);
      if (socks) { socks.delete(socket.id); if (socks.size === 0) userSockets.delete(authUser.id); }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Asocijacije running on http://localhost:${PORT}`);
});
