const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cookieParser = require('cookie-parser');
const { router: authRouter, verifyToken } = require('./auth');
const { stmts } = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cookieParser());
app.use('/api/auth', authRouter);
app.use(express.static(path.join(__dirname, 'public')));

// Game state
let game = createFreshGame();

function createFreshGame() {
  return {
    players: {}, // socketId -> { slot: 0-3 or -1, name: string, userId: number|null, avatar: string, stats: {} }
    slots: [null, null, null, null], // slot index 0-3 -> socketId (null = empty, socketId = connected)
    slotNames: ['', '', '', ''], // custom names per slot
    slotProfiles: [null, null, null, null], // { userId, avatar, games_played, games_won } per slot
    slotDisconnected: [false, false, false, false], // true if player disconnected but slot reserved
    slotReserved: [null, null, null, null], // { userId, reconnectToken, name, avatar, stats, profile } for reconnect
    adminSlot: -1, // slot of the admin player (first to join)
    phase: 'waiting', // waiting | countdown | secret | clue | guess | roundOver | gameOver
    scores: { team1: 0, team2: 0 }, // team1 = P1+P4, team2 = P2+P3
    secretWord: null,
    clues: [],
    currentRound: null, // { secretHolder, clueGiver, guesser, otherGuesser }
    roundStarter: 0, // which slot starts the round (0 or 1), alternates
    turnWithinRound: 0, // 0-based turn count within a round
    timer: null,
    timeLeft: 0,
    countdownLeft: 0, // seconds remaining in pre-game countdown
    disconnectTimer: null, // timer for auto-skipping disconnected player's turn
  };
}

// Teams: P1(slot0) + P4(slot3) = team1, P2(slot1) + P3(slot2) = team2
// Round flow:
//   roundStarter=0 (P1 starts): P1 whispers to P2, P2 gives clue, P3 guesses, then P1 clue, P4 guesses, ...
//   roundStarter=1 (P2 starts): P2 whispers to P4 (wait, let me re-read)
//
// Actually re-reading the rules:
//   Round A: P1 says secret word to P2 (only P2 sees). P2 types clue (all see). P3 guesses (30s).
//            If miss: P1 types clue, P4 guesses (30s). Then P2 clue, P3 guess. Rotate clue-giver.
//   Round B: P2 types secret word visible only to P4. P4 types clue for all. P1 guesses (30s).
//            If miss: P2 clue, P3 guesses... wait, let me re-read again.
//
// "then when word is guessed that team gets a point and it rotates, now player 2 is typing a word 
//  for guessing that is only visible to player 4 and he types one word for all to see and first 
//  guess is for player 1"
//
// So Round B: P2 gives secret to P4. P4 gives clue. P1 guesses. If miss: P2 clue, P3 guesses. etc.
//
// Pattern:
//   Round A: secretHolder=P1, receiver=P2. Clue givers alternate: P2, P1, P2, P1...
//            Guessers alternate: P3, P4, P3, P4...
//   Round B: secretHolder=P2, receiver=P4. Clue givers alternate: P4, P2, P4, P2...
//            Guessers alternate: P1, P3, P1, P3...
//
// Scoring: The guesser's team gets the point.
//   Round A: P3 (team2) or P4 (team1) guesses correctly -> their team scores.
//   Round B: P1 (team1) or P3 (team2) guesses correctly -> their team scores.

function getSlotName(slot) {
  return game.slotNames[slot] || `Player ${slot + 1}`;
}

function getTeam(slot) {
  // slot 0 (P1) and slot 3 (P4) = team1
  // slot 1 (P2) and slot 2 (P3) = team2
  return (slot === 0 || slot === 3) ? 'team1' : 'team2';
}

function getRoundConfig(roundStarter, turnWithinRound) {
  // roundStarter: 0 = P1 starts, 1 = P2 starts
  if (roundStarter === 0) {
    // P1 is secret holder, P2 is receiver
    const clueGiver = (turnWithinRound % 2 === 0) ? 1 : 0; // P2 first, then P1
    const guesser = (turnWithinRound % 2 === 0) ? 2 : 3;   // P3 first, then P4
    return { secretHolder: 0, clueGiver, guesser };
  } else {
    // P2 is secret holder, P4 is receiver
    const clueGiver = (turnWithinRound % 2 === 0) ? 3 : 1; // P4 first, then P2
    const guesser = (turnWithinRound % 2 === 0) ? 0 : 2;   // P1 first, then P3
    return { secretHolder: 1, clueGiver, guesser };
  }
}

function broadcastState() {
  const config = game.phase !== 'waiting' && game.phase !== 'gameOver' && game.phase !== 'countdown'
    ? getRoundConfig(game.roundStarter, game.turnWithinRound)
    : null;

  for (let i = 0; i < 4; i++) {
    const sid = game.slots[i];
    if (!sid) continue;

    const state = {
      phase: game.phase,
      scores: game.scores,
      slots: game.slots.map((s, idx) => (s || game.slotDisconnected[idx]) ? { slot: idx, name: getSlotName(idx), connected: !!s && !game.slotDisconnected[idx], disconnected: game.slotDisconnected[idx] } : null),
      slotNames: game.slotNames,
      slotProfiles: game.slotProfiles,
      adminSlot: game.adminSlot,
      mySlot: i,
      clues: game.clues,
      timeLeft: game.timeLeft,
      countdownLeft: game.countdownLeft,
      secretWord: null,
      currentTurn: config ? {
        secretHolder: config.secretHolder,
        clueGiver: config.clueGiver,
        guesser: config.guesser,
      } : null,
      roundStarter: game.roundStarter,
    };

    // Only show secret word to secret holder and the receiver
    if (game.secretWord && config) {
      if (config.secretHolder === 0) {
        // P1 secret holder, P2 receiver
        if (i === 0 || i === 1) state.secretWord = game.secretWord;
      } else {
        // P2 secret holder, P4 receiver
        if (i === 1 || i === 3) state.secretWord = game.secretWord;
      }
    }

    io.to(sid).emit('state', state);
  }

  // Also send to spectators (anyone not in a slot)
  for (const [sid, player] of Object.entries(game.players)) {
    if (player.slot === -1) {
      io.to(sid).emit('state', {
        phase: game.phase,
        scores: game.scores,
        slots: game.slots.map((s, idx) => (s || game.slotDisconnected[idx]) ? { slot: idx, name: getSlotName(idx), connected: !!s && !game.slotDisconnected[idx], disconnected: game.slotDisconnected[idx] } : null),
        slotNames: game.slotNames,
        slotProfiles: game.slotProfiles,
        adminSlot: game.adminSlot,
        mySlot: -1,
        clues: game.clues,
        timeLeft: game.timeLeft,
        countdownLeft: game.countdownLeft,
        secretWord: null,
        currentTurn: config ? {
          secretHolder: config.secretHolder,
          clueGiver: config.clueGiver,
          guesser: config.guesser,
        } : null,
        roundStarter: game.roundStarter,
      });
    }
  }
}

function clearTimer() {
  if (game.timer) {
    clearInterval(game.timer);
    game.timer = null;
  }
}

function startGuessTimer() {
  game.timeLeft = 30;
  clearTimer();
  game.timer = setInterval(() => {
    game.timeLeft--;
    if (game.timeLeft <= 0) {
      clearTimer();
      // Time's up, move to next turn
      game.turnWithinRound++;
      startClueTurn();
    } else {
      // Lightweight tick - don't re-render entire UI
      io.emit('tick', game.timeLeft);
    }
  }, 1000);
}

function startClueTurn() {
  clearTimer();
  const config = getRoundConfig(game.roundStarter, game.turnWithinRound);
  game.phase = 'clue';
  broadcastState();
  checkDisconnectedTurn();
}

function startNewRound() {
  game.secretWord = null;
  game.clues = [];
  game.turnWithinRound = 0;
  game.phase = 'secret';
  broadcastState();
  checkDisconnectedTurn();
}

function checkWin() {
  const { team1, team2 } = game.scores;
  const maxScore = Math.max(team1, team2);
  const diff = Math.abs(team1 - team2);
  if (maxScore >= 10 && diff >= 2) {
    game.phase = 'gameOver';
    clearTimer();

    // Track stats for logged-in players
    const winningTeam = team1 > team2 ? 'team1' : 'team2';
    for (let i = 0; i < 4; i++) {
      const sid = game.slots[i];
      if (!sid) continue;
      const p = game.players[sid];
      if (!p || !p.userId) continue;
      const playerTeam = getTeam(i);
      if (playerTeam === winningTeam) {
        stmts.addGameWon.run(p.userId);
      } else {
        stmts.addGamePlayed.run(p.userId);
      }
      // Refresh profile in slot
      const fresh = stmts.getProfile.get(p.userId);
      if (fresh) {
        p.stats = { games_played: fresh.games_played, games_won: fresh.games_won };
        if (game.slotProfiles[i]) {
          game.slotProfiles[i].stats = p.stats;
        }
      }
    }

    broadcastState();
    return true;
  }
  return false;
}

// Resolve user profile from socket auth token
function resolveUser(socket) {
  const token = socket.handshake.auth?.token;
  if (!token) return null;
  const decoded = verifyToken(token);
  if (!decoded) return null;
  return stmts.getProfile.get(decoded.userId) || null;
}

// Auto-skip turn if active player is disconnected
function checkDisconnectedTurn() {
  if (game.disconnectTimer) { clearTimeout(game.disconnectTimer); game.disconnectTimer = null; }
  if (game.phase !== 'secret' && game.phase !== 'clue' && game.phase !== 'guess') return;

  const config = getRoundConfig(game.roundStarter, game.turnWithinRound);
  let activeSlot = -1;
  if (game.phase === 'secret') activeSlot = config.secretHolder;
  else if (game.phase === 'clue') activeSlot = config.clueGiver;
  else if (game.phase === 'guess') activeSlot = config.guesser;

  if (activeSlot >= 0 && game.slotDisconnected[activeSlot]) {
    // Give them 15 seconds to reconnect, then auto-skip
    game.disconnectTimer = setTimeout(() => {
      game.disconnectTimer = null;
      if (!game.slotDisconnected[activeSlot]) return; // they reconnected
      console.log(`Auto-skipping turn for disconnected slot ${activeSlot}`);
      if (game.phase === 'secret') {
        // Can't skip secret - set a placeholder and move on
        game.secretWord = '???';
        game.phase = 'clue';
        broadcastState();
      } else if (game.phase === 'clue') {
        // Skip to next turn
        game.turnWithinRound++;
        startClueTurn();
      } else if (game.phase === 'guess') {
        clearTimer();
        game.turnWithinRound++;
        startClueTurn();
      }
    }, 15000);
  }
}

io.on('connection', (socket) => {
  console.log(`Connected: ${socket.id}`);

  const authUser = resolveUser(socket);
  const reconnectToken = socket.handshake.auth?.reconnectToken || null;

  // Check if this player can reconnect to a reserved slot
  let reconnectedSlot = -1;
  for (let i = 0; i < 4; i++) {
    if (!game.slotDisconnected[i]) continue;
    const res = game.slotReserved[i];
    if (!res) continue;
    // Match by userId (logged in) or reconnectToken (guest)
    if ((authUser && res.userId && authUser.id === res.userId) ||
        (reconnectToken && res.reconnectToken && reconnectToken === res.reconnectToken)) {
      // Reconnect!
      reconnectedSlot = i;
      game.slots[i] = socket.id;
      game.slotDisconnected[i] = false;
      game.players[socket.id] = {
        slot: i, name: res.name,
        userId: authUser?.id || res.userId || null,
        avatar: authUser?.avatar || res.avatar || null,
        stats: authUser ? { games_played: authUser.games_played, games_won: authUser.games_won } : res.stats || null
      };
      if (authUser) {
        game.slotProfiles[i] = { userId: authUser.id, avatar: authUser.avatar, stats: { games_played: authUser.games_played, games_won: authUser.games_won } };
      }
      console.log(`Player reconnected to slot ${i}: ${res.name}`);
      socket.emit('assigned', { slot: i, name: res.name, reconnectToken: res.reconnectToken });
      // Cancel disconnect timer if it was for this slot
      if (game.disconnectTimer) { clearTimeout(game.disconnectTimer); game.disconnectTimer = null; }
      broadcastState();
      // Re-check if the active turn needs attention
      checkDisconnectedTurn();
      break;
    }
  }

  if (reconnectedSlot === -1) {
    game.players[socket.id] = { slot: -1, name: '', userId: authUser?.id || null, avatar: authUser?.avatar || null, stats: authUser ? { games_played: authUser.games_played, games_won: authUser.games_won } : null };
    socket.emit('assigned', { slot: -1, name: 'Spectator' });
    broadcastState();
  }

  // Player picks a slot and sets their name
  socket.on('joinSlot', ({ slot, name }) => {
    if (slot < 0 || slot > 3) return;
    if (game.slots[slot] !== null) return; // already taken
    if (game.phase !== 'waiting' && game.phase !== 'countdown') return;

    // Remove from previous slot if any
    const player = game.players[socket.id];
    if (player && player.slot >= 0) {
      game.slots[player.slot] = null;
      game.slotNames[player.slot] = '';
    }

    const trimmedName = (name || '').trim().substring(0, 20) || `Player ${slot + 1}`;
    game.slots[slot] = socket.id;
    game.slotNames[slot] = trimmedName;
    game.slotDisconnected[slot] = false;
    const playerData = game.players[socket.id];
    game.players[socket.id] = { slot, name: trimmedName, userId: playerData?.userId || null, avatar: playerData?.avatar || null, stats: playerData?.stats || null };
    game.slotProfiles[slot] = playerData?.userId ? { userId: playerData.userId, avatar: playerData.avatar, stats: playerData.stats } : null;

    // Generate reconnect token for guests
    const rToken = playerData?.userId ? null : Math.random().toString(36).substring(2) + Date.now().toString(36);
    game.slotReserved[slot] = {
      userId: playerData?.userId || null,
      reconnectToken: rToken,
      name: trimmedName,
      avatar: playerData?.avatar || null,
      stats: playerData?.stats || null,
      profile: game.slotProfiles[slot]
    };

    // First player to join becomes admin
    if (game.adminSlot === -1) {
      game.adminSlot = slot;
    }

    socket.emit('assigned', { slot, name: trimmedName, reconnectToken: rToken });
    broadcastState();
  });

  // Admin starts game immediately
  socket.on('startGame', () => {
    if (game.phase !== 'waiting') return;
    const player = game.players[socket.id];
    if (!player || player.slot !== game.adminSlot) return;
    // Need at least 4 players
    if (!game.slots.every(s => s !== null)) return;

    clearTimer();
    game.countdownLeft = 0;
    game.roundStarter = 0;
    startNewRound();
  });

  // Admin sets a countdown timer before game starts
  socket.on('startCountdown', (seconds) => {
    if (game.phase !== 'waiting') return;
    const player = game.players[socket.id];
    if (!player || player.slot !== game.adminSlot) return;

    const secs = Math.max(5, Math.min(300, parseInt(seconds) || 30));
    game.phase = 'countdown';
    game.countdownLeft = secs;
    clearTimer();
    broadcastState();

    game.timer = setInterval(() => {
      game.countdownLeft--;
      if (game.countdownLeft <= 0) {
        clearTimer();
        // Start game if 4 players, otherwise back to waiting
        if (game.slots.every(s => s !== null)) {
          game.countdownLeft = 0;
          game.roundStarter = 0;
          startNewRound();
        } else {
          game.phase = 'waiting';
          game.countdownLeft = 0;
          broadcastState();
        }
      } else {
        io.emit('countdownTick', game.countdownLeft);
      }
    }, 1000);
  });

  // Admin cancels countdown
  socket.on('cancelCountdown', () => {
    if (game.phase !== 'countdown') return;
    const player = game.players[socket.id];
    if (!player || player.slot !== game.adminSlot) return;

    clearTimer();
    game.phase = 'waiting';
    game.countdownLeft = 0;
    broadcastState();
  });

  // Secret word submission (from secret holder)
  socket.on('submitSecret', (word) => {
    if (game.phase !== 'secret') return;
    const player = game.players[socket.id];
    if (!player || player.slot === -1) return;

    const config = getRoundConfig(game.roundStarter, game.turnWithinRound);
    if (player.slot !== config.secretHolder) return;

    const trimmed = (word || '').trim();
    if (!trimmed) return;

    game.secretWord = trimmed;
    game.phase = 'clue';
    broadcastState();
  });

  // Clue submission (from clue giver)
  socket.on('submitClue', (word) => {
    if (game.phase !== 'clue') return;
    const player = game.players[socket.id];
    if (!player || player.slot === -1) return;

    const config = getRoundConfig(game.roundStarter, game.turnWithinRound);
    if (player.slot !== config.clueGiver) return;

    const trimmed = (word || '').trim();
    if (!trimmed) return;

    // Only one word allowed
    const oneWord = trimmed.split(/\s+/)[0];
    game.clues.push({ from: player.slot, word: oneWord });
    game.phase = 'guess';
    startGuessTimer();
    broadcastState();
    checkDisconnectedTurn();
  });

  // Guess submission (from guesser)
  socket.on('submitGuess', (word) => {
    if (game.phase !== 'guess') return;
    const player = game.players[socket.id];
    if (!player || player.slot === -1) return;

    const config = getRoundConfig(game.roundStarter, game.turnWithinRound);
    if (player.slot !== config.guesser) return;

    const trimmed = (word || '').trim();
    if (!trimmed) return;

    const oneWord = trimmed.split(/\s+/)[0];

    if (oneWord.toLowerCase() === game.secretWord.toLowerCase()) {
      // Correct guess!
      clearTimer();
      const team = getTeam(player.slot);
      game.scores[team]++;

      if (checkWin()) return;

      // Switch round starter
      game.roundStarter = game.roundStarter === 0 ? 1 : 0;

      // Brief pause then new round
      game.phase = 'roundOver';
      broadcastState();

      setTimeout(() => {
        if (game.phase === 'roundOver') {
          startNewRound();
        }
      }, 3000);
    } else {
      // Wrong guess - one guess only, move to next turn
      clearTimer();
      game.clues.push({ from: player.slot, word: oneWord, isGuess: true, wrong: true });
      game.turnWithinRound++;
      startClueTurn();
    }
  });

  // Reset game
  socket.on('resetGame', () => {
    clearTimer();
    if (game.disconnectTimer) { clearTimeout(game.disconnectTimer); game.disconnectTimer = null; }
    const oldSlots = [...game.slots];
    const oldNames = [...game.slotNames];
    const oldProfiles = [...game.slotProfiles];
    const oldReserved = [...game.slotReserved];
    const oldPlayers = { ...game.players };
    const oldAdmin = game.adminSlot;
    game = createFreshGame();
    // Re-assign connected players (drop disconnected slots on reset)
    for (let i = 0; i < 4; i++) {
      if (oldSlots[i] && io.sockets.sockets.get(oldSlots[i])) {
        game.slots[i] = oldSlots[i];
        game.slotNames[i] = oldNames[i];
        game.slotProfiles[i] = oldProfiles[i];
        game.slotReserved[i] = oldReserved[i];
        const op = oldPlayers[oldSlots[i]];
        game.players[oldSlots[i]] = { slot: i, name: oldNames[i], userId: op?.userId || null, avatar: op?.avatar || null, stats: op?.stats || null };
      }
    }
    // Preserve admin
    game.adminSlot = (oldAdmin >= 0 && game.slots[oldAdmin]) ? oldAdmin : -1;
    if (game.adminSlot === -1) {
      for (let i = 0; i < 4; i++) {
        if (game.slots[i] !== null) { game.adminSlot = i; break; }
      }
    }
    broadcastState();
    io.emit('gameReset');
  });

  socket.on('disconnect', () => {
    console.log(`Disconnected: ${socket.id}`);
    const player = game.players[socket.id];
    if (player && player.slot >= 0) {
      const slot = player.slot;
      const wasAdmin = slot === game.adminSlot;
      const isGameActive = game.phase !== 'waiting' && game.phase !== 'gameOver' && game.phase !== 'countdown';

      if (isGameActive) {
        // Keep slot reserved, mark as disconnected - game continues
        game.slots[slot] = null;
        game.slotDisconnected[slot] = true;
        // slotNames, slotProfiles, slotReserved stay intact
        console.log(`Slot ${slot} (${player.name}) disconnected - slot reserved for reconnect`);

        // Transfer admin to next connected player
        if (wasAdmin) {
          game.adminSlot = -1;
          for (let i = 0; i < 4; i++) {
            if (game.slots[i] !== null && !game.slotDisconnected[i]) {
              game.adminSlot = i;
              break;
            }
          }
        }

        // Check if ALL players are disconnected
        const anyConnected = game.slots.some(s => s !== null);
        if (!anyConnected) {
          // Everyone left - reset to waiting
          clearTimer();
          if (game.disconnectTimer) { clearTimeout(game.disconnectTimer); game.disconnectTimer = null; }
          game.phase = 'waiting';
          game.countdownLeft = 0;
          for (let i = 0; i < 4; i++) {
            game.slotDisconnected[i] = false;
            game.slotReserved[i] = null;
            game.slotNames[i] = '';
            game.slotProfiles[i] = null;
          }
        } else {
          // Check if we need to auto-skip the disconnected player's turn
          checkDisconnectedTurn();
        }
      } else {
        // In waiting/countdown/gameOver - fully release the slot
        game.slots[slot] = null;
        game.slotNames[slot] = '';
        game.slotProfiles[slot] = null;
        game.slotDisconnected[slot] = false;
        game.slotReserved[slot] = null;
        if (game.phase === 'countdown') {
          clearTimer();
          game.phase = 'waiting';
          game.countdownLeft = 0;
        }
        // Transfer admin
        if (wasAdmin) {
          game.adminSlot = -1;
          for (let i = 0; i < 4; i++) {
            if (game.slots[i] !== null) {
              game.adminSlot = i;
              break;
            }
          }
        }
      }
    }
    delete game.players[socket.id];
    broadcastState();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Asocijacije running on http://localhost:${PORT}`);
});
