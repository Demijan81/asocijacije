require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cookieParser = require('cookie-parser');
const { router: authRouter, verifyToken } = require('./auth');
const { stmts } = require('./db');
const crypto = require('crypto');
const quizQuestions = require('./quiz-questions');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cookieParser());
app.use('/api/auth', authRouter);

// Email verification link handler
app.get('/verify-email', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send(verifyPage('Invalid verification link.', false));
  const user = stmts.findByEmailToken.get(token);
  if (!user) return res.status(400).send(verifyPage('Invalid or already used verification link.', false));
  stmts.verifyEmail.run(token);
  res.send(verifyPage(`Email verified! Welcome <b>${user.username}</b>. You can now log in and play.`, true));
});

// Reset password page handler
app.get('/reset-password', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send(resetPage('Invalid reset link.', null));
  const user = stmts.findByResetToken.get(token);
  if (!user) return res.status(400).send(resetPage('Invalid or expired reset link.', null));
  if (new Date(user.reset_expires) < new Date()) return res.status(400).send(resetPage('Reset link has expired. Please request a new one.', null));
  res.send(resetPage(null, token));
});

function verifyPage(message, success) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email Verification - Asocijacije</title>
  <style>body{background:#0f172a;color:#e2e8f0;font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
  .box{background:#1e293b;border-radius:16px;padding:40px;text-align:center;max-width:400px;width:90%}
  h1{color:${success?'#34d399':'#f87171'};margin-bottom:16px;font-size:1.5rem}
  p{color:#94a3b8;line-height:1.6}
  a{display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;margin-top:20px}
  a:hover{background:#2563eb}</style></head>
  <body><div class="box"><h1>${success?'✓ Verified':'✗ Error'}</h1><p>${message}</p><a href="/">Go to Asocijacije</a></div></body></html>`;
}

function resetPage(error, token) {
  if (error) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reset Password - Asocijacije</title>
    <style>body{background:#0f172a;color:#e2e8f0;font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
    .box{background:#1e293b;border-radius:16px;padding:40px;text-align:center;max-width:400px;width:90%}
    h1{color:#f87171;font-size:1.5rem}p{color:#94a3b8}
    a{display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;margin-top:20px}
    a:hover{background:#2563eb}</style></head>
    <body><div class="box"><h1>✗ Error</h1><p>${error}</p><a href="/">Go to Asocijacije</a></div></body></html>`;
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reset Password - Asocijacije</title>
  <style>body{background:#0f172a;color:#e2e8f0;font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
  .box{background:#1e293b;border-radius:16px;padding:40px;text-align:center;max-width:400px;width:90%}
  h1{color:#60a5fa;font-size:1.5rem;margin-bottom:16px}
  label{display:block;color:#94a3b8;font-size:0.85rem;margin-bottom:6px;text-align:left}
  input{width:100%;padding:10px 14px;background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:8px;font-size:1rem;margin-bottom:16px;box-sizing:border-box}
  input:focus{outline:none;border-color:#3b82f6}
  button{width:100%;background:#3b82f6;color:#fff;border:none;padding:12px;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer}
  button:hover{background:#2563eb}
  .msg{margin-top:12px;font-size:0.9rem}
  .msg.ok{color:#34d399}.msg.err{color:#f87171}
  a{color:#60a5fa;text-decoration:none;display:inline-block;margin-top:16px}
  </style></head>
  <body><div class="box"><h1>Reset Password</h1>
  <form onsubmit="doReset(event)">
    <label>New Password (min 6 characters)</label>
    <input type="password" id="pw1" placeholder="New password" minlength="6" required>
    <label>Confirm Password</label>
    <input type="password" id="pw2" placeholder="Confirm password" minlength="6" required>
    <button type="submit">Reset Password</button>
  </form>
  <div class="msg" id="msg"></div>
  <a href="/">Back to Asocijacije</a>
  </div>
  <script>
  async function doReset(e){
    e.preventDefault();
    const pw1=document.getElementById('pw1').value;
    const pw2=document.getElementById('pw2').value;
    const msg=document.getElementById('msg');
    if(pw1.length<6){msg.className='msg err';msg.textContent='Password must be at least 6 characters';return;}
    if(pw1!==pw2){msg.className='msg err';msg.textContent='Passwords do not match';return;}
    try{
      const r=await fetch('/api/auth/reset-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'${token}',password:pw1})});
      const d=await r.json();
      if(d.ok){msg.className='msg ok';msg.textContent='Password reset! You can now log in.';document.querySelector('form').style.display='none';}
      else{msg.className='msg err';msg.textContent=d.error||'Reset failed';}
    }catch(err){msg.className='msg err';msg.textContent='Network error';}
  }
  </script></body></html>`;
}

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
// 4 rounds rotate the secret holder through all players.
// Each round: receiver = next player clockwise. Clue/guess alternates between two pairs.
//   Round A (0): P1 secret → P2 sees → (P2 clue, P3 guess) → (P1 clue, P4 guess) → repeat
//   Round B (1): P2 secret → P3 sees → (P3 clue, P1 guess) → (P2 clue, P4 guess) → repeat
//   Round C (2): P3 secret → P4 sees → (P4 clue, P2 guess) → (P3 clue, P1 guess) → repeat
//   Round D (3): P4 secret → P1 sees → (P1 clue, P3 guess) → (P4 clue, P2 guess) → repeat

function getTeam(slot) {
  return (slot === 0 || slot === 3) ? 'team1' : 'team2';
}

// Pre-computed turn tables per round starter [clueGiver, guesser] for even/odd turns
const ROUND_TURNS = {
  0: [[1, 2], [0, 3]], // Round A
  1: [[2, 0], [1, 3]], // Round B
  2: [[3, 1], [2, 0]], // Round C
  3: [[0, 2], [3, 1]], // Round D
};

function getRoundConfig(roundStarter, turnWithinRound) {
  const S = roundStarter % 4;
  const secretHolder = S;
  const receiver = (S + 1) % 4;
  const parity = turnWithinRound % 2; // 0 = even, 1 = odd
  const [clueGiver, guesser] = ROUND_TURNS[S][parity];
  return { secretHolder, receiver, clueGiver, guesser };
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
    this.chatHistory = []; // persistent chat messages
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

    // Quiz mini-game state
    this.quiz = null; // { active, scores: {name: pts}, currentQ, usedIndices, timer, timeLeft, questionNum, answeredBy }
  }

  getSlotName(slot) {
    return this.slotNames[slot] || `Player ${slot + 1}`;
  }

  // ─── Quiz mini-game ───────────────────────────
  startQuiz(adminSocketId) {
    const admin = this.players[adminSocketId];
    if (!admin || admin.slot !== this.adminSlot) return false;
    if (this.phase !== 'lobby' && this.phase !== 'waiting' && this.phase !== 'countdown') return false;

    this.quiz = {
      active: true,
      scores: {},       // playerName -> points
      currentQ: null,    // { q, a, alt, cat }
      usedIndices: new Set(),
      timer: null,
      timeLeft: 0,
      questionNum: 0,
      answeredBy: null,  // name of player who answered current question
    };
    this.nextQuizQuestion();
    return true;
  }

  stopQuiz() {
    if (!this.quiz) return;
    if (this.quiz.timer) clearInterval(this.quiz.timer);
    this.quiz.active = false;
    this.emitToRoom('quizStopped', { scores: this.quiz.scores });
    this.quiz = null;
  }

  nextQuizQuestion() {
    if (!this.quiz || !this.quiz.active) return;
    if (this.quiz.timer) clearInterval(this.quiz.timer);

    // Pick a random unused question
    const available = [];
    for (let i = 0; i < quizQuestions.length; i++) {
      if (!this.quiz.usedIndices.has(i)) available.push(i);
    }
    if (available.length === 0) {
      // All questions used, reset pool
      this.quiz.usedIndices.clear();
      for (let i = 0; i < quizQuestions.length; i++) available.push(i);
    }
    const idx = available[Math.floor(Math.random() * available.length)];
    this.quiz.usedIndices.add(idx);
    this.quiz.currentQ = quizQuestions[idx];
    this.quiz.questionNum++;
    this.quiz.answeredBy = null;
    this.quiz.timeLeft = 20; // 20 seconds per question

    this.emitToRoom('quizQuestion', {
      num: this.quiz.questionNum,
      question: this.quiz.currentQ.q,
      category: this.quiz.currentQ.cat,
      timeLeft: this.quiz.timeLeft,
      scores: this.quiz.scores,
    });

    // Start countdown
    this.quiz.timer = setInterval(() => {
      if (!this.quiz || !this.quiz.active) return;
      this.quiz.timeLeft--;
      if (this.quiz.timeLeft <= 0) {
        // Time's up — reveal answer and move on
        if (this.quiz.timer) clearInterval(this.quiz.timer);
        const ans = this.quiz.currentQ.a;
        this.emitToRoom('quizTimeUp', { answer: ans, scores: this.quiz.scores });
        // Next question after 3 seconds
        setTimeout(() => {
          if (this.quiz && this.quiz.active) this.nextQuizQuestion();
        }, 3000);
      } else {
        this.emitToRoom('quizTick', this.quiz.timeLeft);
      }
    }, 1000);
  }

  checkQuizAnswer(playerName, text) {
    if (!this.quiz || !this.quiz.active || !this.quiz.currentQ || this.quiz.answeredBy) return false;

    const answer = text.toLowerCase().trim();
    const correct = this.quiz.currentQ.a;
    const alts = this.quiz.currentQ.alt || [];

    const isCorrect = answer === correct || alts.some(a => answer === a) ||
      // Fuzzy: check if answer contains the correct answer or vice versa (for short answers)
      (correct.length >= 3 && answer.includes(correct)) ||
      (answer.length >= 3 && correct.includes(answer)) ||
      alts.some(a => (a.length >= 3 && answer.includes(a)) || (answer.length >= 3 && a.includes(answer)));

    if (isCorrect) {
      this.quiz.answeredBy = playerName;
      this.quiz.scores[playerName] = (this.quiz.scores[playerName] || 0) + 1;
      if (this.quiz.timer) clearInterval(this.quiz.timer);

      this.emitToRoom('quizCorrect', {
        player: playerName,
        answer: this.quiz.currentQ.a,
        scores: this.quiz.scores,
      });

      // Next question after 3 seconds
      setTimeout(() => {
        if (this.quiz && this.quiz.active) this.nextQuizQuestion();
      }, 3000);
      return true;
    }
    return false;
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
      chatHistory: this.chatHistory,
      quizActive: !!(this.quiz && this.quiz.active),
      quizScores: this.quiz ? this.quiz.scores : null,
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
        createdBy: this.createdBy,
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
        currentTurn: config ? { secretHolder: config.secretHolder, receiver: config.receiver, clueGiver: config.clueGiver, guesser: config.guesser } : null,
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
          createdBy: this.createdBy,
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
          currentTurn: config ? { secretHolder: config.secretHolder, receiver: config.receiver, clueGiver: config.clueGiver, guesser: config.guesser } : null,
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
    if (this.slots[slot] !== null || this.slotDisconnected[slot]) return null;
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

  // Admin can randomize player slot assignments (shuffle teams)
  randomizeTeams(adminSocketId) {
    const admin = this.players[adminSocketId];
    if (!admin || admin.slot !== this.adminSlot) return false;
    if (this.phase !== 'lobby' && this.phase !== 'waiting') return false;

    // Collect occupied slot indices
    const occupied = [];
    for (let i = 0; i < 4; i++) {
      if (this.slots[i] !== null || this.slotDisconnected[i]) occupied.push(i);
    }
    if (occupied.length < 2) return false; // need at least 2 players to shuffle

    // Fisher-Yates shuffle of occupied indices to get new positions
    const shuffled = [...occupied];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    // Save current data for occupied slots
    const saved = occupied.map(i => ({
      slot: i,
      sid: this.slots[i],
      name: this.slotNames[i],
      profile: this.slotProfiles[i],
      disconnected: this.slotDisconnected[i],
      reserved: this.slotReserved[i],
    }));

    // Place each saved entry into its new slot position
    for (let k = 0; k < occupied.length; k++) {
      const newSlot = shuffled[k];
      const data = saved[k];
      this.slots[newSlot] = data.sid;
      this.slotNames[newSlot] = data.name;
      this.slotProfiles[newSlot] = data.profile;
      this.slotDisconnected[newSlot] = data.disconnected;
      this.slotReserved[newSlot] = data.reserved;
      if (data.sid && this.players[data.sid]) {
        this.players[data.sid].slot = newSlot;
      }
      if (data.slot === this.adminSlot) this.adminSlot = newSlot;
    }

    return true;
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
    if (this.quiz) this.stopQuiz(); // stop quiz when game starts
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

  // Room owner kicks a player from their slot — fully removes them
  kickPlayer(adminSocketId, targetSlot) {
    const admin = this.players[adminSocketId];
    if (!admin || admin.userId !== this.createdBy) return false;
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
  const reconnectToken = socket.handshake.auth?.reconnectToken || null;
  const savedRoom = socket.handshake.auth?.savedRoom || null;
  let didAutoReconnect = false;

  if (authUser) {
    const myGames = stmts.getMyGames.all(authUser.id);
    for (const g of myGames) {
      const room = rooms.get(g.code);
      if (!room) continue;
      for (let i = 0; i < 4; i++) {
        if (!room.slotDisconnected[i]) continue;
        const res = room.slotReserved[i];
        if (res && res.userId === authUser.id) {
          socketRooms.set(socket.id, room.code);
          const result = room.tryReconnect(socket.id, authUser, null);
          if (result) {
            socket.emit('joinedRoom', { code: room.code, roomName: room.name, autoReconnect: true, ...result });
            if (room.phase === 'lobby' || room.phase === 'waiting') {
              room.broadcastLobby();
            } else {
              room.broadcastGameState();
            }
            didAutoReconnect = true;
          }
          break;
        }
      }
      if (didAutoReconnect) break;
    }
  }

  // Guest auto-reconnect: use reconnectToken + savedRoom from sessionStorage
  if (!didAutoReconnect && !authUser && reconnectToken && savedRoom) {
    const room = rooms.get(savedRoom);
    if (room) {
      const result = room.tryReconnect(socket.id, null, reconnectToken);
      if (result) {
        socketRooms.set(socket.id, room.code);
        socket.emit('joinedRoom', { code: room.code, roomName: room.name, autoReconnect: true, ...result });
        if (room.phase === 'lobby' || room.phase === 'waiting') {
          room.broadcastLobby();
        } else {
          room.broadcastGameState();
        }
        didAutoReconnect = true;
      }
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

    // Already in this room with a slot? Just re-emit state
    const existing = room.players[sock.id];
    if (existing && existing.slot >= 0) {
      sock.emit('joinedRoom', { code: room.code, roomName: room.name, slot: existing.slot, name: existing.name });
      if (room.phase === 'lobby' || room.phase === 'waiting') {
        room.broadcastLobby();
      } else {
        room.broadcastGameState();
      }
      return;
    }

    // Try reconnect (disconnected slot)
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

    // Check if user has a reserved slot (connected via different socket, e.g. another tab)
    if (user) {
      for (let i = 0; i < 4; i++) {
        const res = room.slotReserved[i];
        if (res && res.userId === user.id && !room.slotDisconnected[i] && room.slots[i]) {
          // User has a connected slot on another socket — take it over
          const oldSid = room.slots[i];
          if (oldSid && room.players[oldSid]) delete room.players[oldSid];
          room.slots[i] = sock.id;
          room.players[sock.id] = { slot: i, name: res.name, userId: user.id, avatar: user.avatar, stats: { games_played: user.games_played, games_won: user.games_won } };
          if (user) room.slotProfiles[i] = { userId: user.id, avatar: user.avatar, stats: { games_played: user.games_played, games_won: user.games_won } };
          sock.emit('joinedRoom', { code: room.code, roomName: room.name, slot: i, name: res.name });
          if (room.phase === 'lobby' || room.phase === 'waiting') {
            room.broadcastLobby();
          } else {
            room.broadcastGameState();
          }
          return;
        }
      }
    }

    // Normal join as spectator
    room.addPlayer(sock.id, user);
    sock.emit('joinedRoom', { code: room.code, roomName: room.name, slot: -1, name: 'Spectator' });
    room.broadcastLobby();
  }

  // Delete/cancel a room (creator only, any phase)
  socket.on('deleteRoom', ({ code } = {}) => {
    if (!code || !authUser) return;

    const room = rooms.get(code);
    if (room) {
      // Room is live in memory
      if (room.createdBy !== authUser.id) {
        socket.emit('error', { message: 'Only the room creator can delete this room' });
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
        // Player has a slot — they cannot leave. Ignore the request.
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

  // Lobby chat (persisted on room) — also checks quiz answers
  socket.on('sendChat', ({ message } = {}) => {
    const code = socketRooms.get(socket.id);
    if (!code || !message) return;
    const room = rooms.get(code);
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    if (room.phase !== 'lobby' && room.phase !== 'waiting' && room.phase !== 'countdown') return;
    const text = String(message).trim().substring(0, 200);
    if (!text) return;
    const msg = { name: player.name, text, timestamp: Date.now() };
    room.chatHistory.push(msg);
    if (room.chatHistory.length > 100) room.chatHistory.shift();
    room.emitToRoom('chatMessage', msg);

    // Check if this chat message is a correct quiz answer
    if (room.quiz && room.quiz.active) {
      room.checkQuizAnswer(player.name, text);
    }
  });

  // Quiz mini-game controls
  socket.on('startQuiz', () => {
    const room = rooms.get(socketRooms.get(socket.id));
    if (!room) return;
    room.startQuiz(socket.id);
  });

  socket.on('stopQuiz', () => {
    const room = rooms.get(socketRooms.get(socket.id));
    if (!room) return;
    const player = room.players[socket.id];
    if (!player || player.slot !== room.adminSlot) return;
    room.stopQuiz();
  });

  // Admin test mode: fill empty slots with bots
  socket.on('testFillSlots', () => {
    if (!authUser) return;
    const user = stmts.getProfile.get(authUser.id);
    if (!user || user.email !== 'demijan81@gmail.com') return;
    const code = socketRooms.get(socket.id);
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    if (room.phase !== 'lobby' && room.phase !== 'waiting') return;
    const botNames = ['Bot-Alpha', 'Bot-Beta', 'Bot-Gamma', 'Bot-Delta'];
    for (let i = 0; i < 4; i++) {
      if (room.slots[i] !== null || room.slotDisconnected[i]) continue;
      // Create a virtual bot in this slot
      room.slots[i] = `bot_${i}`;
      room.slotNames[i] = botNames[i];
      room.slotDisconnected[i] = false;
      room.slotProfiles[i] = null;
      room.slotReserved[i] = { userId: null, reconnectToken: null, name: botNames[i], avatar: '🤖', stats: null, profile: null };
      room.players[`bot_${i}`] = { slot: i, name: botNames[i], userId: null, avatar: '🤖', stats: null };
      if (room.adminSlot === -1) room.adminSlot = i;
    }
    room.broadcastLobby();
  });

  // Admin test mode: act as any slot
  socket.on('testActAs', ({ slot, action, value } = {}) => {
    if (!authUser) return;
    const user = stmts.getProfile.get(authUser.id);
    if (!user || user.email !== 'demijan81@gmail.com') return;
    const code = socketRooms.get(socket.id);
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    if (slot < 0 || slot > 3) return;
    const botSid = room.slots[slot];
    if (!botSid) return;
    if (action === 'submitSecret') room.submitSecret(botSid, value);
    else if (action === 'submitClue') room.submitClue(botSid, value);
    else if (action === 'submitGuess') room.submitGuess(botSid, value);
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

  socket.on('randomizeTeams', () => {
    const room = rooms.get(socketRooms.get(socket.id));
    if (!room) return;
    if (room.randomizeTeams(socket.id)) {
      // Notify all players of their new slots
      for (let i = 0; i < 4; i++) {
        const sid = room.slots[i];
        if (sid) io.to(sid).emit('assigned', { slot: i, name: room.slotNames[i], roomCode: room.code });
      }
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
