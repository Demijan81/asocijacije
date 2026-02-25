const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'asocijacije.db');

// Ensure data directory exists
const fs = require('fs');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent access
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    avatar TEXT DEFAULT '😀',
    totp_secret TEXT DEFAULT NULL,
    totp_enabled INTEGER DEFAULT 0,
    trusted_ips TEXT DEFAULT '[]',
    games_played INTEGER DEFAULT 0,
    games_won INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS friendships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    friend_id INTEGER NOT NULL REFERENCES users(id),
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, friend_id)
  );

  CREATE TABLE IF NOT EXISTS room_participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_code TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id),
    slot INTEGER NOT NULL,
    UNIQUE(room_code, user_id)
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL DEFAULT 'Game Room',
    created_by INTEGER NOT NULL REFERENCES users(id),
    scheduled_start TEXT DEFAULT NULL,
    status TEXT DEFAULT 'lobby',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// Prepared statements
const stmts = {
  // Rooms
  createRoom: db.prepare(`
    INSERT INTO rooms (code, name, created_by, scheduled_start) VALUES (?, ?, ?, ?)
  `),
  findRoomByCode: db.prepare(`
    SELECT * FROM rooms WHERE code = ?
  `),
  updateRoomStatus: db.prepare(`
    UPDATE rooms SET status = ?, updated_at = datetime('now') WHERE code = ?
  `),
  updateRoomSchedule: db.prepare(`
    UPDATE rooms SET scheduled_start = ?, updated_at = datetime('now') WHERE code = ?
  `),
  getRoomsByUser: db.prepare(`
    SELECT * FROM rooms WHERE created_by = ? ORDER BY created_at DESC LIMIT 20
  `),
  deleteRoom: db.prepare(`
    DELETE FROM rooms WHERE code = ? AND created_by = ?
  `),

  createUser: db.prepare(`
    INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)
  `),
  findByEmail: db.prepare(`
    SELECT * FROM users WHERE email = ?
  `),
  findByUsername: db.prepare(`
    SELECT * FROM users WHERE username = ?
  `),
  findById: db.prepare(`
    SELECT * FROM users WHERE id = ?
  `),
  setTotpSecret: db.prepare(`
    UPDATE users SET totp_secret = ?, totp_enabled = 1, updated_at = datetime('now') WHERE id = ?
  `),
  disableTotp: db.prepare(`
    UPDATE users SET totp_secret = NULL, totp_enabled = 0, updated_at = datetime('now') WHERE id = ?
  `),
  updateAvatar: db.prepare(`
    UPDATE users SET avatar = ?, updated_at = datetime('now') WHERE id = ?
  `),
  updateTrustedIps: db.prepare(`
    UPDATE users SET trusted_ips = ?, updated_at = datetime('now') WHERE id = ?
  `),
  addGamePlayed: db.prepare(`
    UPDATE users SET games_played = games_played + 1, updated_at = datetime('now') WHERE id = ?
  `),
  addGameWon: db.prepare(`
    UPDATE users SET games_won = games_won + 1, games_played = games_played + 1, updated_at = datetime('now') WHERE id = ?
  `),
  getProfile: db.prepare(`
    SELECT id, username, email, avatar, totp_enabled, games_played, games_won FROM users WHERE id = ?
  `),

  // Friendships
  sendFriendRequest: db.prepare(`
    INSERT OR IGNORE INTO friendships (user_id, friend_id, status) VALUES (?, ?, 'pending')
  `),
  acceptFriendRequest: db.prepare(`
    UPDATE friendships SET status = 'accepted' WHERE user_id = ? AND friend_id = ? AND status = 'pending'
  `),
  removeFriendship: db.prepare(`
    DELETE FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)
  `),
  getFriends: db.prepare(`
    SELECT u.id, u.username, u.avatar, u.games_played, u.games_won, f.status,
      CASE WHEN f.user_id = ? THEN 'sent' ELSE 'received' END as direction
    FROM friendships f
    JOIN users u ON u.id = CASE WHEN f.user_id = ? THEN f.friend_id ELSE f.user_id END
    WHERE (f.user_id = ? OR f.friend_id = ?) AND f.status = 'accepted'
  `),
  getPendingRequests: db.prepare(`
    SELECT u.id, u.username, u.avatar, u.games_played, u.games_won
    FROM friendships f
    JOIN users u ON u.id = f.user_id
    WHERE f.friend_id = ? AND f.status = 'pending'
  `),
  checkFriendship: db.prepare(`
    SELECT * FROM friendships WHERE
      ((user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?))
  `),

  // Room participants
  addParticipant: db.prepare(`
    INSERT OR REPLACE INTO room_participants (room_code, user_id, slot) VALUES (?, ?, ?)
  `),
  removeParticipant: db.prepare(`
    DELETE FROM room_participants WHERE room_code = ? AND user_id = ?
  `),
  removeAllParticipants: db.prepare(`
    DELETE FROM room_participants WHERE room_code = ?
  `),
  getMyGames: db.prepare(`
    SELECT r.code, r.name, r.status, r.created_by, rp.slot
    FROM room_participants rp
    JOIN rooms r ON r.code = rp.room_code
    WHERE rp.user_id = ? AND r.status != 'finished'
    ORDER BY r.updated_at DESC LIMIT 20
  `),
};

module.exports = { db, stmts };
