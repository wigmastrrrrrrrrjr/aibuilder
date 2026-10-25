// Authentication regression suite.
//
// Covers the single-step signup contract the web app and the in-preview SDK
// depend on: POST /api/auth/signup must create the account AND return a usable
// session token. (It used to return { verifyRequired: true } without creating
// anything or issuing a token, which left every new user signed out holding
// the literal string "undefined".)
//
// Run:  node --test test/auth.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { useStore } from '../src/store.js';
import { setVars } from '../src/env.js';

// ---- minimal in-memory account store --------------------------------------
function makeStore() {
  const users = new Map();       // name -> user row
  const sessions = new Map();    // token -> user id
  const meta = new Map();
  let seq = 0;

  return {
    async findUserByName(name) {
      const u = users.get(String(name));
      return u ? { id: u.id, name: u.name, phash: u.phash } : null;
    },
    async findUserById(id) {
      for (const u of users.values()) if (u.id === id) return { id: u.id, name: u.name, phash: u.phash };
      return null;
    },
    async createUser({ name, phash }) {
      if (users.has(name)) throw new Error('username already taken');
      const u = { id: `u-${++seq}`, name, phash };
      users.set(name, u);
      return { id: u.id, name: u.name };
    },
    async verifyUser() {},
    async deleteUser(user) {
      users.delete(user.name);
      for (const [tok, id] of sessions) if (id === user.id) sessions.delete(tok);
    },
    async ipUsed() { return null; },
    async createSession(userId) {
      const tok = `tok-${++seq}`;
      sessions.set(tok, userId);
      return tok;
    },
    async getSession(tok) {
      const id = sessions.get(tok);
      if (!id) return null;
      for (const u of users.values()) if (u.id === id) return { id: u.id, userId: u.id, name: u.name };
      return null;
    },
    async deleteSession(tok) { sessions.delete(tok); },
    async createProject(name, owner) { return { id: 'p-' + (++seq), name: name || 'Untitled app', owner }; },
    async metaGet(k) { return meta.has(k) ? meta.get(k) : null; },
    async metaSet(k, v) { meta.set(k, v); },
  };
}

useStore(makeStore());
setVars({ TERMINAL_URL: '', TERMINAL_TOKEN: '', LOCAL_TERMINAL: '', IP_SECRET: 'test-ip-secret' });

const { app } = await import('../src/app.js');

const BASE = 'http://api.test';
let ipSeq = 0;
// The auth limiter allows 3 attempts/minute per IP; give every request its own
// IP so these assertions test auth, not the rate limiter.
async function call(method, path, { body, token } = {}) {
  const headers = { 'x-real-ip': `203.0.113.${++ipSeq}` };
  if (token) headers['x-ab-sess'] = token;
  const init = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await app.fetch(new Request(BASE + path, init));
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* text body */ }
  return { status: res.status, json, text, headers: res.headers };
}

test('signup creates the account and returns a working session', async () => {
  const r = await call('POST', '/api/auth/signup', {
    body: { username: 'signup_user', password: 'secret123', dob: '2000-01-01' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.username, 'signup_user');
  assert.equal(typeof r.json.token, 'string');
  assert.ok(r.json.token.length > 0, 'signup must issue a session token');
  assert.equal(r.json.verifyRequired, undefined);

  // The returned token must actually authenticate.
  const me = await call('GET', '/api/auth/me', { token: r.json.token });
  assert.equal(me.status, 200);
  assert.equal(me.json.username, 'signup_user');

  // ...and it works for real work, not just identity.
  const proj = await call('POST', '/api/projects', { token: r.json.token, body: { name: 'First app' } });
  assert.equal(proj.status, 201);
});

test('signup rejects duplicates, short passwords and under-13 signups', async () => {
  const first = await call('POST', '/api/auth/signup', { body: { username: 'dupe_user', password: 'secret123' } });
  assert.equal(first.status, 201);

  const dupe = await call('POST', '/api/auth/signup', { body: { username: 'dupe_user', password: 'secret123' } });
  assert.equal(dupe.status, 409);
  assert.match(dupe.json.error, /taken/);

  const short = await call('POST', '/api/auth/signup', { body: { username: 'shortpw', password: 'x' } });
  assert.equal(short.status, 400);

  const young = await call('POST', '/api/auth/signup', {
    body: { username: 'kiddo', password: 'secret123', dob: new Date(Date.now() - 5 * 365 * 864e5).toISOString().slice(0, 10) },
  });
  assert.equal(young.status, 403);
});

test('login works after signup and a wrong password is rejected', async () => {
  await call('POST', '/api/auth/signup', { body: { username: 'login_user', password: 'secret123' } });

  const ok = await call('POST', '/api/auth/login', { body: { username: 'login_user', password: 'secret123' } });
  assert.equal(ok.status, 200);
  assert.equal(typeof ok.json.token, 'string');

  const bad = await call('POST', '/api/auth/login', { body: { username: 'login_user', password: 'nope' } });
  assert.equal(bad.status, 401);
});

test('deleting the account invalidates every session immediately', async () => {
  const created = await call('POST', '/api/auth/signup', { body: { username: 'gone_user', password: 'secret123' } });
  const token = created.json.token;
  assert.equal((await call('GET', '/api/auth/me', { token })).status, 200);

  const del = await call('POST', '/api/auth/delete', { token });
  assert.equal(del.status, 200);

  // The 30s session cache must not keep authenticating a deleted account.
  assert.equal((await call('GET', '/api/auth/me', { token })).status, 401);
  const login = await call('POST', '/api/auth/login', { body: { username: 'gone_user', password: 'secret123' } });
  assert.equal(login.status, 401);
});
