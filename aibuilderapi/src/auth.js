// Accounts: PBKDF2-hashed passwords + opaque bearer sessions.
// Session travels in the 'x-ab-sess' header (builder) or ?tok= query
// param (EventSource can't send headers).

import { Hono } from 'hono';
import { store } from './store.js';
import { getVar } from './env.js';

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

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

// legacy projects have no owner and stay writable for compat;
// owned projects may only be modified by their owner
export function canWrite(project, user) {
  return !project || !project.owner || Boolean(user && user.name === project.owner);
}

const NAME_RE = /^[a-zA-Z0-9_-]{3,24}$/;

// ---- IP handling: never stored raw. We keep only an HMAC-SHA256 tag so the
// DB can answer "has this network signed up?" / "is this request from the
// same network?" without ever persisting a readable address.
async function ipSecret() {
  const fromEnv = getVar('IP_SECRET');
  if (fromEnv) return fromEnv;
  let s = await store.metaGet('ip_secret');
  if (!s) {
    s = hex(crypto.getRandomValues(new Uint8Array(32)));
    try { await store.metaSet('ip_secret', s); } catch { /* concurrent set is fine */ }
  }
  return s;
}

export function clientIp(c) {
  const xff = c.req.header('x-forwarded-for') || '';
  return xff.split(',')[0].trim() || c.req.header('x-real-ip') || '';
}

export async function ipTag(c) {
  const raw = clientIp(c);
  if (!raw) return ''; // no header -> skip binding entirely
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(await ipSecret()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(raw));
  return hex(sig).slice(0, 32);
}

export const auth = new Hono();

auth.post('/api/auth/signup', async (c) => {
  const { username, password } = await c.req.json().catch(() => ({}));
  const name = String(username || '').trim();
  if (!NAME_RE.test(name))
    return c.json({ error: 'username must be 3-24 letters, digits, - or _' }, 400);
  if (typeof password !== 'string' || password.length < 6)
    return c.json({ error: 'password must be at least 6 characters' }, 400);
  if (await store.findUserByName(name))
    return c.json({ error: 'username already taken' }, 409);
  const tag = await ipTag(c);
  if (tag) {
    const takenBy = await store.ipUsed(tag);
    if (takenBy) return c.json({
      error: `Maximum accounts reached for this network. Log in as "${takenBy}" or reset its password below.`,
    }, 403);
  }
  const phash = await hashPassword(password);
  let user;
  try {
    user = await store.createUser({ name, phash, ip: tag });
  } catch {
    return c.json({ error: 'username already taken' }, 409);
  }
  const token = await store.createSession(user.id);
  return c.json({ token, username: user.name }, 201);
});

auth.post('/api/auth/login', async (c) => {
  const { username, password } = await c.req.json().catch(() => ({}));
  const user = await store.findUserByName(String(username || '').trim());
  if (!user || !(await verifyPassword(String(password || ''), user.phash)))
    return c.json({ error: 'wrong username or password' }, 401);
  // backfill network tag on first login so pre-existing accounts become resettable
  try {
    const tag = await ipTag(c);
    if (tag && !user.ip) await store.updateUserIp(user.name, tag);
  } catch { /* non-fatal */ }
  const token = await store.createSession(user.id);
  return c.json({ token, username: user.name });
});

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
