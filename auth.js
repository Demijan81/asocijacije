const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const { stmts } = require('./db');

const router = express.Router();
router.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'asocijacije-secret-change-in-prod-' + Date.now();
const JWT_EXPIRES = '30d';
const MAX_TRUSTED_IPS = 10;

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
         req.headers['x-real-ip'] ||
         req.connection?.remoteAddress ||
         req.ip;
}

function signToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// Middleware: attach user to req if valid token
function authMiddleware(req, res, next) {
  const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return next();
  const decoded = verifyToken(token);
  if (!decoded) return next();
  const user = stmts.getProfile.get(decoded.userId);
  if (user) req.user = user;
  next();
}

// Register
router.post('/register', (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email and password required' });
  }
  if (username.length < 2 || username.length > 20) {
    return res.status(400).json({ error: 'Username must be 2-20 characters' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  // Check existing
  if (stmts.findByEmail.get(email.toLowerCase())) {
    return res.status(409).json({ error: 'Email already registered' });
  }
  if (stmts.findByUsername.get(username)) {
    return res.status(409).json({ error: 'Username already taken' });
  }

  const hash = bcrypt.hashSync(password, 10);
  try {
    const result = stmts.createUser.run(username, email.toLowerCase(), hash);
    const token = signToken(result.lastInsertRowid);
    const profile = stmts.getProfile.get(result.lastInsertRowid);

    res.cookie('token', token, { httpOnly: true, sameSite: 'strict', maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.json({ ok: true, profile, token });
  } catch (err) {
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login - step 1
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  const user = stmts.findByEmail.get(email.toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // Check if 2FA is enabled
  if (user.totp_enabled) {
    const ip = getClientIp(req);
    const trustedIps = JSON.parse(user.trusted_ips || '[]');

    if (trustedIps.includes(ip)) {
      // Trusted location - skip 2FA
      const token = signToken(user.id);
      const profile = stmts.getProfile.get(user.id);
      res.cookie('token', token, { httpOnly: true, sameSite: 'strict', maxAge: 30 * 24 * 60 * 60 * 1000 });
      return res.json({ ok: true, profile, token });
    }

    // Need 2FA - return partial token
    const partialToken = jwt.sign({ userId: user.id, needs2fa: true }, JWT_SECRET, { expiresIn: '5m' });
    return res.json({ needs2fa: true, partialToken });
  }

  // No 2FA - login directly
  const token = signToken(user.id);
  const profile = stmts.getProfile.get(user.id);
  res.cookie('token', token, { httpOnly: true, sameSite: 'strict', maxAge: 30 * 24 * 60 * 60 * 1000 });
  res.json({ ok: true, profile, token });
});

// Login - step 2: verify 2FA code
router.post('/verify-2fa', (req, res) => {
  const { partialToken, code } = req.body;
  if (!partialToken || !code) {
    return res.status(400).json({ error: 'Token and code required' });
  }

  const decoded = verifyToken(partialToken);
  if (!decoded || !decoded.needs2fa) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const user = stmts.findById.get(decoded.userId);
  if (!user || !user.totp_secret) {
    return res.status(401).json({ error: 'User not found' });
  }

  const isValid = authenticator.verify({ token: code, secret: user.totp_secret });
  if (!isValid) {
    return res.status(401).json({ error: 'Invalid 2FA code' });
  }

  // Trust this IP
  const ip = getClientIp(req);
  let trustedIps = JSON.parse(user.trusted_ips || '[]');
  if (!trustedIps.includes(ip)) {
    trustedIps.push(ip);
    if (trustedIps.length > MAX_TRUSTED_IPS) trustedIps = trustedIps.slice(-MAX_TRUSTED_IPS);
    stmts.updateTrustedIps.run(JSON.stringify(trustedIps), user.id);
  }

  const token = signToken(user.id);
  const profile = stmts.getProfile.get(user.id);
  res.cookie('token', token, { httpOnly: true, sameSite: 'strict', maxAge: 30 * 24 * 60 * 60 * 1000 });
  res.json({ ok: true, profile, token });
});

// Setup 2FA - get QR code
router.post('/setup-2fa', authMiddleware, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });

  const user = stmts.findById.get(req.user.id);
  const secret = authenticator.generateSecret();
  const otpauth = authenticator.keyuri(user.email, 'Asocijacije', secret);

  QRCode.toDataURL(otpauth, (err, qrDataUrl) => {
    if (err) return res.status(500).json({ error: 'Failed to generate QR code' });
    // Store secret temporarily - will be confirmed in enable-2fa
    // For simplicity, store it now but mark as not yet verified
    res.json({ secret, qrDataUrl });
  });
});

// Enable 2FA - verify code and activate
router.post('/enable-2fa', authMiddleware, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });

  const { secret, code } = req.body;
  if (!secret || !code) {
    return res.status(400).json({ error: 'Secret and verification code required' });
  }

  const isValid = authenticator.verify({ token: code, secret });
  if (!isValid) {
    return res.status(400).json({ error: 'Invalid verification code. Try again.' });
  }

  stmts.setTotpSecret.run(secret, req.user.id);

  // Trust current IP
  const ip = getClientIp(req);
  const user = stmts.findById.get(req.user.id);
  let trustedIps = JSON.parse(user.trusted_ips || '[]');
  if (!trustedIps.includes(ip)) {
    trustedIps.push(ip);
    stmts.updateTrustedIps.run(JSON.stringify(trustedIps), req.user.id);
  }

  const profile = stmts.getProfile.get(req.user.id);
  res.json({ ok: true, profile });
});

// Disable 2FA
router.post('/disable-2fa', authMiddleware, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });

  const { code } = req.body;
  const user = stmts.findById.get(req.user.id);

  if (user.totp_enabled && user.totp_secret) {
    if (!code) return res.status(400).json({ error: '2FA code required to disable' });
    const isValid = authenticator.verify({ token: code, secret: user.totp_secret });
    if (!isValid) return res.status(400).json({ error: 'Invalid 2FA code' });
  }

  stmts.disableTotp.run(req.user.id);
  stmts.updateTrustedIps.run('[]', req.user.id);
  const profile = stmts.getProfile.get(req.user.id);
  res.json({ ok: true, profile });
});

// Update avatar
router.post('/avatar', authMiddleware, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });

  const { avatar } = req.body;
  if (!avatar || avatar.length > 10) {
    return res.status(400).json({ error: 'Invalid avatar' });
  }
  stmts.updateAvatar.run(avatar, req.user.id);
  const profile = stmts.getProfile.get(req.user.id);
  res.json({ ok: true, profile });
});

// Get current profile
router.get('/me', authMiddleware, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  res.json({ profile: req.user });
});

// Logout
router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

module.exports = { router, authMiddleware, verifyToken, JWT_SECRET };
