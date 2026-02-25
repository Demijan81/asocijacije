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
};

module.exports = { db, stmts };
