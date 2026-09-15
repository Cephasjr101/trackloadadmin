'use strict';

const crypto = require('crypto');
const db = require('./db');

const SESSION_TTL_MS = (Number(process.env.SESSION_TTL_HOURS) || 168) * 3600 * 1000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare(
    'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(token, userId, now, now + SESSION_TTL_MS);
  return token;
}

function getUserFromToken(token) {
  if (!token) return null;
  const row = db
    .prepare('SELECT * FROM sessions WHERE token = ?')
    .get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return db.prepare('SELECT id, role, owner_name, company, email, phone, created_at FROM users WHERE id = ?').get(row.user_id);
}

function generateOtp() {
  // 6-digit numeric OTP, zero-padded
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function hashOtp(otp) {
  const salt = crypto.randomBytes(8).toString('hex');
  const hash = crypto.scryptSync(otp, salt, 32).toString('hex');
  return { salt, hash };
}

function verifyOtp(otp, salt, expectedHash) {
  const hash = crypto.scryptSync(otp, salt, 32).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  getUserFromToken,
  generateOtp,
  hashOtp,
  verifyOtp,
};
