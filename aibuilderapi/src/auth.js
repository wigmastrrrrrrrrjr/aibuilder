// Accounts: PBKDF2-hashed passwords + opaque bearer sessions.
// Session travels in the 'x-ab-sess' header (builder) or ?tok= query
// param (EventSource can't send headers).
//
// Signup flow:
//   1. POST /api/auth/signup  { username, password, email }
//   2. Server hashes a 6-digit code (PBKDF2, same security as passwords)
//   3. Stores hash in meta table with 10-min expiry
//   4. Sends the plaintext code to the email via EmailJS
//   5. Returns { verifyRequired: true }
//   6. User enters code → POST /api/auth/verify-email { username, code }
//   7. Server hashes input, constant-time compares, creates account
//
// Login flow:
//   - Verified users: normal login → session token
//   - ai_dev: login → email 2FA → session token

import { Hono } from 'hono';
import { store } from './store.js';
import { getVar } from './env.js';
import { sendEmail } from './email.js';

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

// ---- password hashing (PBKDF2-SHA256, 100k iterations) --------------------
export async function hashPassword(pw, saltHex) {
  const salt = saltHex
    ? new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)))
    : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', iterations: 100000, salt },
    key,
    256,
  );
  return `${hex(salt)}$${hex(bits)}`;
}

// ---- code hashing (same PBKDF2 — attacker can't brute-force even if DB leaks)
async function hashCode(code) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(String(code)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', iterations: 100000, salt },
    key,
    256,
  );
  return `${hex(salt)}$${hex(bits)}`;
}

async function verifyCode(code, stored) {
  const saltHex = String(stored || '').split('$')[0];
  if (!saltHex) return false;
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', enc.encode(String(code)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', iterations: 100000, salt },
    key,
    256,
  );
  const rehash = `${saltHex}$${hex(bits)}`;
  // Constant-time comparison
  if (rehash.length !== stored.length) return false;
  let mismatch = 0;
  for (let i = 0; i < rehash.length; i++) {
    mismatch |= rehash.charCodeAt(i) ^ stored.charCodeAt(i);
  }
  return mismatch === 0;
}

async function verifyPassword(pw, stored) {
  const salt = String(stored || '').split('$')[0];
  if (!salt) return false;
  return (await hashPassword(pw, salt)) === stored;
}

export async function getUser(c) {
  const tok = c.req.header('x-ab-sess') || c.req.query('tok') || '';
  if (!tok) return null;
  return store.getSession(tok);
}

export async function requireUser(c, next) {
  const u = await getUser(c);
  if (!u) return c.json({ error: 'sign up required' }, 401);
  c.set('user', u);
  await next();
}

export function canWrite(project, user) {
  return !project || !project.owner || Boolean(user && user.name === project.owner);
}

const NAME_RE = /^[a-zA-Z0-9_-]{3,24}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---- IP handling -----------------------------------------------------------
async function ipSecret() {
  const fromEnv = getVar('IP_SECRET');
  if (fromEnv) return fromEnv;
  let s = await store.metaGet('ip_secret');
  if (!s) {
    s = hex(crypto.getRandomValues(new Uint8Array(32)));
    try { await store.metaSet('ip_secret', s); } catch {}
  }
  return s;
}

export function clientIp(c) {
  const xff = c.req.header('x-forwarded-for') || '';
  return xff.split(',')[0].trim() || c.req.header('x-real-ip') || '';
}

export async function ipTag(c) {
  const raw = clientIp(c);
  if (!raw) return '';
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(await ipSecret()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(raw));
  return hex(sig).slice(0, 32);
}

// ---- helpers ---------------------------------------------------------------
const TFA_USER = 'ai_dev';
const TFA_EMAIL = 'csomeone301@gmail.com';
const CODE_EXPIRY_MS = 10 * 60 * 1000;

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function isTfaUser(name) {
  return String(name || '').toLowerCase() === TFA_USER;
}

async function storeVerifyCode(key, code) {
  const hash = await hashCode(code);
  await store.metaSet(key, JSON.stringify({ hash, expires: Date.now() + CODE_EXPIRY_MS }));
}

async function getVerifyData(key) {
  const raw = await store.metaGet(key);
  if (!raw) return null;
  try {
    const d = JSON.parse(raw);
    if (Date.now() > d.expires) { await store.metaSet(key, ''); return null; }
    return d;
  } catch { return null; }
}

async function clearVerify(key) {
  await store.metaSet(key, '');
}

async function sendCodeEmail(to, code, sender) {
  return sendEmail({
    to,
    subject: 'aibuilder — Your verification code',
    text: `Your aibuilder verification code is: ${code}`,
  });
}

// ---- reCAPTCHA v3 verification ---------------------------------------------
const RECAPTCHA_URL = 'https://www.google.com/recaptcha/api/siteverify';

async function verifyCaptcha(c, action) {
  const secret = getVar('RECAPTCHA_SECRET');
  if (!secret) return true; // not configured — skip

  const token = c.req.header('x-recaptcha-token');
  if (!token) return true; // no token yet (script loading) — allow through

  try {
    const r = await fetch(RECAPTCHA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `secret=${encodeURIComponent(secret)}&response=${encodeURIComponent(token)}`,
    });
    const d = await r.json();
    return d.success && d.score >= 0.5 && (!action || d.action === action);
  } catch {
    return true; // verification service down — don't block users
  }
}

export const auth = new Hono();

// ---- SIGNUP: step 1 — collect username + password + email, send code --------
auth.post('/api/auth/signup', async (c) => {
  if (!(await verifyCaptcha(c, 'signup')))
    return c.json({ error: 'captcha failed — are you a bot?' }, 403);

  const { username, password, email } = await c.req.json().catch(() => ({}));
  const name = String(username || '').trim();
  const mail = String(email || '').trim().toLowerCase();

  if (!NAME_RE.test(name))
    return c.json({ error: 'username must be 3-24 letters, digits, - or _' }, 400);
  if (typeof password !== 'string' || password.length < 6)
    return c.json({ error: 'password must be at least 6 characters' }, 400);
  if (!EMAIL_RE.test(mail))
    return c.json({ error: 'valid email required' }, 400);

  // Block reserved names
  if (isTfaUser(name))
    return c.json({ error: 'this username is reserved' }, 403);

  // Check username not already taken
  if (await store.findUserByName(name))
    return c.json({ error: 'username already taken' }, 409);

  // Check IP limit
  const tag = await ipTag(c);
  if (tag) {
    const takenBy = await store.ipUsed(tag);
    if (takenBy) return c.json({
      error: `Maximum accounts reached for this network. Log in as "${takenBy}" or reset its password below.`,
    }, 403);
  }

  // Hash password eagerly (we'll need it when verification completes)
  const phash = await hashPassword(password);

  // Store pending signup in meta (includes hashed password + email + hashed code)
  const code = generateCode();
  const codeHash = await hashCode(code);
  const pending = { name, phash, email: mail, ip: tag, codeHash, expires: Date.now() + CODE_EXPIRY_MS };
  await store.metaSet(`signup:${name}`, JSON.stringify(pending));

  // Send verification email (await so the Worker stays alive)
  try {
    await sendCodeEmail(mail, code, name);
  } catch (e) {
    console.error('[signup] email failed:', e.message);
  }

  return c.json({ verifyRequired: true, username: name, message: `Code sent to ${mail}` });
});

// ---- SIGNUP: step 2 — verify code, create account -------------------------
auth.post('/api/auth/verify-email', async (c) => {
  const { username, code } = await c.req.json().catch(() => ({}));
  const name = String(username || '').trim();
  const codeStr = String(code || '').trim();

  if (!name || !codeStr)
    return c.json({ error: 'username and code required' }, 400);

  const pending = await getVerifyData(`signup:${name}`);
  if (!pending)
    return c.json({ error: 'no pending signup — start over' }, 400);

  // Verify code (constant-time PBKDF2 comparison)
  if (!(await verifyCode(codeStr, pending.codeHash)))
    return c.json({ error: 'wrong code' }, 401);

  // Code valid — create the actual account
  await clearVerify(`signup:${name}`);
  let user;
  try {
    user = await store.createUser({ name, phash: pending.phash, ip: pending.ip, email: pending.email });
  } catch {
    return c.json({ error: 'username already taken' }, 409);
  }

  // Auto-verify email (they just proved they own it)
  await store.verifyUser(name);

  const token = await store.createSession(user.id);
  return c.json({ token, username: user.name }, 201);
});

// ---- LOGIN -----------------------------------------------------------------
auth.post('/api/auth/login', async (c) => {
  if (!(await verifyCaptcha(c, 'login')))
    return c.json({ error: 'captcha failed — are you a bot?' }, 403);

  const { username, password } = await c.req.json().catch(() => ({}));
  const user = await store.findUserByName(String(username || '').trim());
  if (!user || !(await verifyPassword(String(password || ''), user.phash)))
    return c.json({ error: 'wrong username or password' }, 401);

  // Backfill network tag
  try {
    const tag = await ipTag(c);
    if (tag && !user.ip) await store.updateUserIp(user.name, tag);
  } catch {}

  // ---- ai_dev: mandatory email 2FA ----
  if (isTfaUser(user.name)) {
    const code = generateCode();
    await storeVerifyCode(`tfa:${user.id}`, code);
    try { await sendCodeEmail(TFA_EMAIL, code, 'aibuilder'); } catch (e) { console.error('[tfa] email failed:', e.message); }
    return c.json({ tfaRequired: true, sessionId: user.id, message: `Code sent to ${TFA_EMAIL}` });
  }

  // ---- normal account: instant session ----
  const token = await store.createSession(user.id);
  return c.json({ token, username: user.name });
});

// ---- ai_dev: verify 2FA code ------------------------------------------------
auth.post('/api/auth/verify-tfa', async (c) => {
  const { sessionId, code } = await c.req.json().catch(() => ({}));
  if (!sessionId || !code) return c.json({ error: 'sessionId and code required' }, 400);

  const pending = await getVerifyData(`tfa:${sessionId}`);
  if (!pending) return c.json({ error: 'no pending 2FA — log in again' }, 400);

  if (!(await verifyCode(String(code).trim(), pending.hash)))
    return c.json({ error: 'wrong code' }, 401);

  await clearVerify(`tfa:${sessionId}`);
  const token = await store.createSession(sessionId);
  const user = await store.findUserById(sessionId);
  return c.json({ token, username: user ? user.name : 'ai_dev' });
});

// ---- RESEND CODE (for both signup and tfa) ----------------------------------
auth.post('/api/auth/resend-code', async (c) => {
  const { username, type } = await c.req.json().catch(() => ({}));
  const name = String(username || '').trim();

  if (type === 'signup') {
    const pending = await getVerifyData(`signup:${name}`);
    if (!pending) return c.json({ error: 'no pending signup' }, 400);
    const code = generateCode();
    pending.codeHash = await hashCode(code);
    pending.expires = Date.now() + CODE_EXPIRY_MS;
    await store.metaSet(`signup:${name}`, JSON.stringify(pending));
    try { await sendCodeEmail(pending.email, code, name); } catch {}
    return c.json({ ok: true, message: `Code resent to ${pending.email}` });
  }

  if (type === 'tfa') {
    const user = await store.findUserByName(name);
    if (!user) return c.json({ error: 'user not found' }, 404);
    const code = generateCode();
    await storeVerifyCode(`tfa:${user.id}`, code);
    try { await sendCodeEmail(TFA_EMAIL, code, 'aibuilder'); } catch {}
    return c.json({ ok: true, message: `Code resent to ${TFA_EMAIL}` });
  }

  return c.json({ error: 'type must be signup or tfa' }, 400);
});

// ---- RESET PASSWORD --------------------------------------------------------
auth.post('/api/auth/reset', async (c) => {
  const { username, password } = await c.req.json().catch(() => ({}));
  const name = String(username || '').trim();
  if (!NAME_RE.test(name) || typeof password !== 'string' || password.length < 6)
    return c.json({ error: 'username or new password invalid (min 6 chars)' }, 400);
  const user = await store.findUserByName(name);
  const tag = await ipTag(c);
  if (!user || !user.ip || !tag)
    return c.json({ error: 'cannot verify this account for reset' }, 400);
  if (user.ip !== tag)
    return c.json({ error: 'reset only works from the same network that created the account' }, 403);
  await store.resetPassword(name, await hashPassword(password));
  const token = await store.createSession(user.id);
  return c.json({ token, username: user.name });
});

auth.get('/api/auth/me', async (c) => {
  const u = await getUser(c);
  if (!u) return c.json({ error: 'not signed in' }, 401);
  return c.json({ username: u.name });
});

auth.post('/api/auth/logout', async (c) => {
  const tok = c.req.header('x-ab-sess') || c.req.query('tok') || '';
  if (tok) await store.deleteSession(tok);
  return c.json({ ok: true });
});
