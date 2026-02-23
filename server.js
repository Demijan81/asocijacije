const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Game state
let game = createFreshGame();

function createFreshGame() {
  return {
    players: {}, // socketId -> { slot: 1-4, name: string }
    slots: [null, null, null, null], // slot index 0-3 -> socketId
    phase: 'waiting', // waiting | secret | clue | guess | roundOver | gameOver
    scores: { team1: 0, team2: 0 }, // team1 = P1+P4, team2 = P2+P3
    secretWord: null,
    clues: [],
    currentRound: null, // { secretHolder, clueGiver, guesser, otherGuesser }
    roundStarter: 0, // which slot starts the round (0 or 1), alternates
    turnWithinRound: 0, // 0-based turn count within a round
    timer: null,
    timeLeft: 0,
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
  return `Player ${slot + 1}`;
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
  const config = game.phase !== 'waiting' && game.phase !== 'gameOver'
    ? getRoundConfig(game.roundStarter, game.turnWithinRound)
    : null;

  for (let i = 0; i < 4; i++) {
    const sid = game.slots[i];
    if (!sid) continue;

    const state = {
      phase: game.phase,
      scores: game.scores,
      slots: game.slots.map((s, idx) => s ? { slot: idx, name: getSlotName(idx), connected: true } : null),
      mySlot: i,
      clues: game.clues,
      timeLeft: game.timeLeft,
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
        slots: game.slots.map((s, idx) => s ? { slot: idx, name: getSlotName(idx), connected: true } : null),
        mySlot: -1,
        clues: game.clues,
        timeLeft: game.timeLeft,
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
}

function startNewRound() {
  game.secretWord = null;
  game.clues = [];
  game.turnWithinRound = 0;
  game.phase = 'secret';
  broadcastState();
}

function checkWin() {
  const { team1, team2 } = game.scores;
  const maxScore = Math.max(team1, team2);
  const diff = Math.abs(team1 - team2);
  if (maxScore >= 10 && diff >= 2) {
    game.phase = 'gameOver';
    clearTimer();
    broadcastState();
    return true;
  }
  return false;
}

io.on('connection', (socket) => {
  console.log(`Connected: ${socket.id}`);

  // Find first available slot
  let assignedSlot = -1;
  for (let i = 0; i < 4; i++) {
    if (!game.slots[i]) {
      assignedSlot = i;
      game.slots[i] = socket.id;
      break;
    }
  }

  game.players[socket.id] = { slot: assignedSlot };

  if (assignedSlot >= 0) {
    socket.emit('assigned', { slot: assignedSlot, name: getSlotName(assignedSlot) });
  } else {
    socket.emit('assigned', { slot: -1, name: 'Spectator' });
  }

  // Check if all 4 slots filled -> start game
  if (game.slots.every(s => s !== null) && game.phase === 'waiting') {
    game.roundStarter = 0;
    startNewRound();
  } else {
    broadcastState();
  }

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
    const oldSlots = [...game.slots];
    game = createFreshGame();
    // Re-assign connected players
    for (let i = 0; i < 4; i++) {
      if (oldSlots[i] && io.sockets.sockets.get(oldSlots[i])) {
        game.slots[i] = oldSlots[i];
        game.players[oldSlots[i]] = { slot: i };
      }
    }
    if (game.slots.every(s => s !== null)) {
      game.roundStarter = 0;
      startNewRound();
    } else {
      broadcastState();
    }
    io.emit('gameReset');
  });

  socket.on('disconnect', () => {
    console.log(`Disconnected: ${socket.id}`);
    const player = game.players[socket.id];
    if (player && player.slot >= 0) {
      game.slots[player.slot] = null;
      clearTimer();
      if (game.phase !== 'waiting' && game.phase !== 'gameOver') {
        game.phase = 'waiting';
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
