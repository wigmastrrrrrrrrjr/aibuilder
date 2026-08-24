// Accounts: PBKDF2-hashed passwords + opaque bearer sessions.
// Session travels in the 'x-ab-sess' header (builder) or ?tok= query
// param (EventSource can't send headers).

import { Hono } from 'hono';
import { store } from './store.js';

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

const NAME_RE = /^[a-zA-Z0-9_-]{3,24}$/;

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
  const phash = await hashPassword(password);
  let user;
  try {
    user = await store.createUser({ name, phash });
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
