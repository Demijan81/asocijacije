const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const { stmts } = require('./db');

const router = express.Router();
router.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'asocijacije-secret-change-in-prod-' + Date.now();
const JWT_EXPIRES = '30d';
const MAX_TRUSTED_IPS = 10;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// Email transporter (configure via env vars)
let transporter = null;
if (process.env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  console.log('[Email] SMTP configured:', process.env.SMTP_HOST);
} else {
  console.log('[Email] No SMTP configured — verification emails will be logged to console');
}

const SMTP_FROM = process.env.SMTP_FROM || 'Asocijacije <noreply@asocijacije.ourlittlekingdom.net>';

async function sendEmail(to, subject, html) {
  if (transporter) {
    try {
      await transporter.sendMail({ from: SMTP_FROM, to, subject, html });
      console.log(`[Email] Sent to ${to}: ${subject}`);
    } catch (err) {
      console.error(`[Email] Failed to send to ${to}:`, err.message);
    }
  } else {
    console.log(`[Email] (no SMTP) To: ${to} | Subject: ${subject}`);
    console.log(`[Email] Body: ${html}`);
  }
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

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
router.post('/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email and password required' });
  }
  if (username.length < 2 || username.length > 20) {
    return res.status(400).json({ error: 'Username must be 2-20 characters' });
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return res.status(400).json({ error: 'Username can only contain letters, numbers and underscores' });
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
  const emailToken = generateToken();
  try {
    const result = stmts.createUser.run(username, email.toLowerCase(), hash, emailToken);
    const token = signToken(result.lastInsertRowid);
    const profile = stmts.getProfile.get(result.lastInsertRowid);

    // Send verification email
    const verifyUrl = `${BASE_URL}/verify-email?token=${emailToken}`;
    await sendEmail(email.toLowerCase(), 'Verify your Asocijacije account', `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px">
        <h2 style="color:#60a5fa">Welcome to Asocijacije!</h2>
        <p>Hi <b>${username}</b>, thanks for signing up. Please verify your email:</p>
        <a href="${verifyUrl}" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:bold;margin:16px 0">Verify Email</a>
        <p style="color:#94a3b8;font-size:0.85rem">Or copy this link: ${verifyUrl}</p>
      </div>
    `);

    res.cookie('token', token, { httpOnly: true, sameSite: 'strict', maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.json({ ok: true, profile, token, needsVerification: true });
  } catch (err) {
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Resend verification email
router.post('/resend-verification', authMiddleware, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  const user = stmts.findById.get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.email_verified) return res.json({ ok: true, message: 'Already verified' });

  const emailToken = generateToken();
  stmts.resendEmailToken.run(emailToken, user.id);

  const verifyUrl = `${BASE_URL}/verify-email?token=${emailToken}`;
  await sendEmail(user.email, 'Verify your Asocijacije account', `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px">
      <h2 style="color:#60a5fa">Email Verification</h2>
      <p>Hi <b>${user.username}</b>, please verify your email:</p>
      <a href="${verifyUrl}" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:bold;margin:16px 0">Verify Email</a>
      <p style="color:#94a3b8;font-size:0.85rem">Or copy this link: ${verifyUrl}</p>
    </div>
  `);

  res.json({ ok: true, message: 'Verification email sent' });
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

  // Check email verification
  if (!user.email_verified) {
    // Issue a token so they can resend verification, but flag it
    const token = signToken(user.id);
    const profile = stmts.getProfile.get(user.id);
    res.cookie('token', token, { httpOnly: true, sameSite: 'strict', maxAge: 30 * 24 * 60 * 60 * 1000 });
    return res.json({ ok: true, profile, token, needsVerification: true });
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

// Forgot password - request reset
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  const user = stmts.findByEmail.get(email.toLowerCase());
  if (!user) {
    // Don't reveal whether email exists
    return res.json({ ok: true, message: 'If that email is registered, a reset link has been sent.' });
  }

  const resetToken = generateToken();
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
  stmts.setResetToken.run(resetToken, expires, user.id);

  const resetUrl = `${BASE_URL}/reset-password?token=${resetToken}`;
  await sendEmail(user.email, 'Reset your Asocijacije password', `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px">
      <h2 style="color:#60a5fa">Password Reset</h2>
      <p>Hi <b>${user.username}</b>, you requested a password reset.</p>
      <a href="${resetUrl}" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:bold;margin:16px 0">Reset Password</a>
      <p style="color:#94a3b8;font-size:0.85rem">This link expires in 1 hour.</p>
      <p style="color:#94a3b8;font-size:0.85rem">Or copy this link: ${resetUrl}</p>
      <p style="color:#64748b;font-size:0.8rem">If you didn't request this, ignore this email.</p>
    </div>
  `);

  res.json({ ok: true, message: 'If that email is registered, a reset link has been sent.' });
});

// Reset password - with token
router.post('/reset-password', (req, res) => {
  const { token: resetToken, password } = req.body;
  if (!resetToken || !password) return res.status(400).json({ error: 'Token and new password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const user = stmts.findByResetToken.get(resetToken);
  if (!user) return res.status(400).json({ error: 'Invalid or expired reset link' });
  if (new Date(user.reset_expires) < new Date()) {
    return res.status(400).json({ error: 'Reset link has expired. Please request a new one.' });
  }

  const hash = bcrypt.hashSync(password, 10);
  stmts.updatePassword.run(hash, user.id);

  res.json({ ok: true, message: 'Password reset successfully. You can now log in.' });
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
