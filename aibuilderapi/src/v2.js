import { Hono } from 'hono';
import { getVar } from './env.js';
import { hashPassword, verifyPassword, clientIp, ipTag } from './auth.js';
import { hashEmail } from './hash-email.js';
import { systemPrompt } from './prompt.js';
import { localOllamaUrl, builtinKey, mistralKey, openrouterKey } from './keys.js';
import { FREE_DAILY_CREDITS, CREDIT_PRECISION, creditsToUnits, unitsToCredits, modelCost } from './models.js';
import {
  v2Projects, v2Users, v2Sessions, v2Files, v2Messages, v2Events, v2Credits,
  v2ReadyOrThrow, DAY, now,
} from './store-supabase.js';

export const v2 = new Hono();

const ok = (c, data, status = 200) => c.json({ ok: true, data }, status);
const fail = (c, status, error) => c.json({ ok: false, error }, status);

function sanitizeUser(u) {
  if (!u) return null;
  return { name: u.name, verified: Boolean(u.verified), created_at: u.created_at };
}

function sanitizeProject(p) {
  if (!p) return null;
  return {
    id: p.id, owner: p.owner, name: p.name, description: p.description,
    model: p.model, plan: p.plan, published: Boolean(p.published),
    created_at: p.created_at, updated_at: p.updated_at,
  };
}

// ---- rate limiting (per IP + endpoint, in-memory window) -------------------
const RL_WINDOW = 60_000;
const rl = new Map();
function rate(c, key, max) {
  const nowMs = now();
  const ip = clientIp(c) || '0';
  const k = `${ip}:${key}`;
  const cur = rl.get(k);
  if (!cur || cur[0] < nowMs - RL_WINDOW) {
    rl.set(k, [nowMs, 1]);
    if (rl.size > 5000) for (const [kk, vv] of rl) if (vv[0] < nowMs - RL_WINDOW) rl.delete(kk);
    return 0;
  }
  cur[1]++;
  rl.set(k, cur);
  return cur[1] > max ? 429 : 0;
}

async function readBody(c) {
  try { return await c.req.json(); } catch { return {}; }
}

// ---- session middleware ----------------------------------------------------
const sesCache = new Map();
async function resolveUser(c) {
  const tok = c.req.header('x-ab-sess')
    || (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '')
    || c.req.query('tok') || '';
  if (!tok) return null;
  if (sesCache.has(tok)) {
    const hit = sesCache.get(tok);
    if (hit === 'gone') return null;
    return hit;
  }
  const u = await v2Sessions.userByToken(tok);
  sesCache.set(tok, u ? u : 'gone');
  if (sesCache.size > 5000) sesCache.clear();
  return u;
}

async function requireUser(c, next) {
  const g = await v2ReadyOrThrow(c);
  if (g) return g;
  const u = await resolveUser(c);
  if (!u) return fail(c, 401, 'sign in required');
  c.set('v2user', u);
  return next();
}

async function ownerOf(c, next) {
  const u = c.get('v2user');
  const p = await v2Projects.byId(c.req.param('id') || '');
  if (!p) return fail(c, 404, 'project not found');
  if (p.owner !== u.name) return fail(c, 403, 'not your project');
  c.set('v2project', p);
  return next();
}

const OK_NAME = /^[a-zA-Z0-9_]{2,32}$/;
const ROUTES = [
  'POST /api/v2/auth/signup', 'POST /api/v2/auth/login', 'POST /api/v2/auth/logout',
  'GET /api/v2/auth/me', 'POST /api/v2/auth/reset',
  'GET /api/v2/projects', 'POST /api/v2/projects', 'GET /api/v2/projects/:id',
  'PATCH /api/v2/projects/:id', 'DELETE /api/v2/projects/:id',
  'GET /api/v2/projects/:id/files', 'PUT /api/v2/projects/:id/files/*',
  'GET /api/v2/projects/:id/files/*', 'DELETE /api/v2/projects/:id/files/*',
  'GET /api/v2/projects/:id/messages', 'POST /api/v2/projects/:id/chat',
  'GET /api/v2/live/:room/events', 'POST /api/v2/live/:room/events',
  'GET /api/v2/credits', 'POST /api/v2/credits/grant', 'POST /api/v2/credits/gift',
];

v2.get('/docs', (c) => ok(c, { version: 2, routes: ROUTES }));

// ---- auth ------------------------------------------------------------------
v2.post('/auth/signup', async (c) => {
  const g = await v2ReadyOrThrow(c);
  if (g) return g;
  { const r429 = rate(c, 'auth', 20); if (r429) return fail(c, 429, 'slow down'); }
  const b = await readBody(c);
  const name = String(b.name || '').trim();
  const pw = String(b.password || '');
  if (!OK_NAME.test(name)) return fail(c, 400, 'name: 2-32 chars, a-z A-Z 0-9 _');
  if (pw.length < 6) return fail(c, 400, 'password must be at least 6 chars');
  const phash = await hashPassword(pw);
  const email = String(b.email || '').trim().toLowerCase();
  const emailSha = email && email.includes('@') ? await hashEmail(email) : '';
  const tag = await ipTag(c);
  const row = await v2Users.create(name, phash, emailSha, tag);
  if (!row) return fail(c, 409, 'name taken');
  const token = await v2Sessions.create(row.id);
  return ok(c, { user: sanitizeUser(row), token });
});

v2.post('/auth/login', async (c) => {
  const g = await v2ReadyOrThrow(c);
  if (g) return g;
  { const r429 = rate(c, 'auth', 20); if (r429) return fail(c, 429, 'slow down'); }
  const b = await readBody(c);
  const name = String(b.name || '').trim();
  const u = await v2Users.byName(name);
  if (!u) return fail(c, 401, 'bad name or password');
  const pwb = await verifyPassword(String(b.password || ''), u.phash);
  if (!pwb) return fail(c, 401, 'bad name or password');
  if (!u.ip_tag) {
    const tag = await ipTag(c);
    if (tag) { await v2Users.setIpTag(u.name, tag); }
  }
  const token = await v2Sessions.create(u.id);
  return ok(c, { user: sanitizeUser(u), token });
});

v2.post('/auth/logout', requireUser, async (c) => {
  const u = c.get('v2user');
  const sits = await v2Sessions.forUser(u.id);
  for (const s of sits) await v2Sessions.remove(s.token);
  sesCache.clear();
  return ok(c, { logged_out: u.name });
});

v2.get('/auth/me', requireUser, (c) => ok(c, { user: sanitizeUser(c.get('v2user')) }));

v2.post('/auth/reset', requireUser, async (c) => {
  const u = c.get('v2user');
  const b = await readBody(c);
  const pw = String(b.password || '');
  if (pw.length < 6) return fail(c, 400, 'password must be at least 6 chars');
  await v2Users.setPassword(u.name, await hashPassword(pw));
  return ok(c, { password_reset: true });
});

// ---- projects --------------------------------------------------------------
v2.get('/projects', async (c) => {
  const g = await v2ReadyOrThrow(c);
  if (g) return g;
  const feed = c.req.query('feed');
  if (feed === 'published') {
    return ok(c, { projects: (await v2Projects.published(Number(c.req.query('limit')) || 100)).map(sanitizeProject) });
  }
  const u = await resolveUser(c);
  if (!u) return fail(c, 401, 'sign in required');
  return ok(c, { projects: (await v2Projects.byOwner(u.name)).map(sanitizeProject) });
});

v2.post('/projects', requireUser, async (c) => {
  const u = c.get('v2user');
  const b = await readBody(c);
  const name = String(b.name || '').trim().slice(0, 60);
  if (!name) return fail(c, 400, 'name required');
  const p = await v2Projects.create(u.name, {
    name, description: String(b.description || '').slice(0, 500), model: String(b.model || ''),
  });
  return ok(c, { project: sanitizeProject(p) }, 201);
});

async function visibleProject(c) {
  const p = await v2Projects.byId(c.req.param('id') || '');
  if (!p) return fail(c, 404, 'project not found');
  if (!p.published) {
    const u = await resolveUser(c);
    if (!u || u.name !== p.owner) return fail(c, 403, 'not your project');
  }
  return p;
}

v2.get('/projects/:id', async (c) => {
  const g = await v2ReadyOrThrow(c);
  if (g) return g;
  const p = await visibleProject(c);
  if (!p || !p.id) return p;
  return ok(c, { project: sanitizeProject(p) });
});

v2.patch('/projects/:id', requireUser, ownerOf, async (c) => {
  const b = await readBody(c);
  const patch = {};
  if ('name' in b) patch.name = String(b.name).slice(0, 60);
  if ('description' in b) patch.description = String(b.description).slice(0, 500);
  if ('model' in b) patch.model = String(b.model).slice(0, 64);
  if ('published' in b) patch.published = Boolean(b.published);
  patch.updated_at = new Date().toISOString();
  const p = await v2Projects.update(c.get('v2project').id, patch);
  return ok(c, { project: sanitizeProject(p) });
});

v2.delete('/projects/:id', requireUser, ownerOf, async (c) => {
  await v2Projects.remove(c.get('v2project').id);
  return ok(c, { deleted: true });
});

// ---- files -----------------------------------------------------------------
v2.get('/projects/:id/files', async (c) => {
  const g = await v2ReadyOrThrow(c);
  if (g) return g;
  const p = await visibleProject(c);
  if (!p || !p.id) return p;
  return ok(c, { files: await v2Files.list(p.id) });
});

async function withProjectOwner(c, next) {
  const u = c.get('v2user');
  const p = await v2Projects.byId(c.req.param('id') || '');
  if (!p) return fail(c, 404, 'project not found');
  if (p.owner !== u.name) return fail(c, 403, 'not your project');
  c.set('v2project', p);
  return next();
}

async function withProject(c, next) {
  const p = await visibleProject(c);
  if (!p || !p.id) return p;
  c.set('v2project', p);
  return next();
}

v2.put('/projects/:id/files/*', requireUser, withProjectOwner, async (c) => {
  const path = c.req.param('*') || '';
  if (!path || path.includes('..')) return fail(c, 400, 'bad path');
  const b = await readBody(c);
  const f = await v2Files.put(c.get('v2project').id, path, {
    content: b.content, encoding: b.encoding,
  });
  return ok(c, { path: f.path, encoding: f.encoding, updated_at: f.updated_at });
});

v2.get('/projects/:id/files/*', withProject, async (c) => {
  const path = c.req.param('*') || '';
  const f = await v2Files.get(c.get('v2project').id, path);
  if (!f) return fail(c, 404, 'file not found');
  return ok(c, { path: f.path, encoding: f.encoding, content: f.content, updated_at: f.updated_at });
});

v2.delete('/projects/:id/files/*', requireUser, withProjectOwner, async (c) => {
  const path = c.req.param('*') || '';
  await v2Files.remove(c.get('v2project').id, path);
  return ok(c, { deleted: true });
});

// ---- chat ------------------------------------------------------------------
async function llmReply(reqModel, message) {
  const model = String(reqModel || '').trim() || getVar('OLLAMA_MODEL') || 'gemma4:31b';
  const msgs = [{ role: 'system', content: systemPrompt() }, { role: 'user', content: message }];
  const or = openrouterKey();
  if (or) {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${or}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: msgs, stream: false }),
    });
    const j = await r.json().catch(() => ({}));
    return String(j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '');
  }
  const mk = mistralKey();
  if (mk) {
    const r = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${mk}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: model.includes('/') ? 'mistral-small-latest' : model, messages: msgs, stream: false }),
    });
    const j = await r.json().catch(() => ({}));
    return String(j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '');
  }
  const col = builtinKey();
  if (col) {
    const base = await localOllamaUrl();
    if (base) {
      const r = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${col}` },
        body: JSON.stringify({ model: model.includes('/') ? 'mistral-small' : model, messages: msgs, stream: false }),
      });
      const j = await r.json().catch(() => ({}));
      return String(j.message && j.message.content || '');
    }
  }
  throw Object.assign(new Error('no AI provider configured'), { code: 'NO_PROVIDER' });
}

v2.post('/projects/:id/chat', requireUser, ownerOf, async (c) => {
  { const r429 = rate(c, 'chat', 10); if (r429) return fail(c, 429, 'slow down'); }
  const p = c.get('v2project');
  const b = await readBody(c);
  const content = String(b.message || '').trim();
  if (!content) return fail(c, 400, 'message required');
  const cost = creditsToUnits(modelCost(b.model || p.model || ''));
  const day = DAY();
  const free = creditsToUnits(FREE_DAILY_CREDITS);
  const spend = await v2Credits.sum(p.owner, day, 'spend');
  const earn = await v2Credits.sum(p.owner, day, 'earn');
  const avail = unitsToCredits(free - spend + earn);
  if (avail <= 0) return fail(c, 402, 'no credits left today');
  const seq = await v2Messages.nextSeq(p.id);
  const userMsg = await v2Messages.add(p.id, seq, 'user', content);
  await v2Credits.add(p.owner, day, 'spend', cost);
  let reply = '';
  let err = null;
  try {
    reply = await llmReply(b.model || p.model, content);
  } catch (e) {
    err = e.code === 'NO_PROVIDER' ? 'no AI provider configured' : 'model call failed';
  }
  const asst = await v2Messages.add(p.id, seq + 1, 'assistant', reply || (err || ''));
  return ok(c, { user: userMsg, assistant: asst, error: err });
});

v2.get('/projects/:id/messages', async (c) => {
  const g = await v2ReadyOrThrow(c);
  if (g) return g;
  const p = await visibleProject(c);
  if (!p || !p.id) return p;
  const msgs = await v2Messages.list(p.id, Number(c.req.query('limit')) || 200, Number(c.req.query('since')) || 0);
  return ok(c, { messages: msgs, next: msgs.length ? msgs[msgs.length - 1].seq : 0 });
});

// ---- live rooms (durable + realtime) ---------------------------------------
v2.get('/live/:room/events', async (c) => {
  const g = await v2ReadyOrThrow(c);
  if (g) return g;
  const room = String(c.req.param('room') || '').slice(0, 64);
  if (!room) return fail(c, 400, 'room required');
  const limit = Number(c.req.query('limit')) || 100;
  const since = Number(c.req.query('since')) || 0;
  return ok(c, { room, events: await v2Events.list(room, limit, since), seq: await v2Events.lastSeq(room) });
});

v2.post('/live/:room/events', async (c) => {
  const g = await v2ReadyOrThrow(c);
  if (g) return g;
  { const r429 = rate(c, 'events', 15); if (r429) return fail(c, 429, 'slow down'); }
  const room = String(c.req.param('room') || '').slice(0, 64);
  if (!room) return fail(c, 400, 'room required');
  const b = await readBody(c);
  const u = await resolveUser(c);
  const sender = String(b.user || (u && u.name) || '').slice(0, 32) || 'anon';
  const evt = await v2Events.add(room, String(b.type || 'message').slice(0, 24), sender, b.data || {});
  return ok(c, evt, 201);
});

// ---- credits ---------------------------------------------------------------
v2.get('/credits', requireUser, async (c) => {
  const u = c.get('v2user');
  const day = DAY();
  const free = creditsToUnits(FREE_DAILY_CREDITS);
  const spend = await v2Credits.sum(u.name, day, 'spend');
  const earn = await v2Credits.sum(u.name, day, 'earn');
  return ok(c, {
    credits: unitsToCredits(free - spend + earn),
    credits_used: unitsToCredits(spend),
    credits_granted: unitsToCredits(earn),
    free_daily: FREE_DAILY_CREDITS,
    precision: CREDIT_PRECISION,
  });
});

v2.post('/credits/grant', requireUser, async (c) => {
  const u = c.get('v2user');
  const OWNER = 'csomeone301';
  if (u.name !== OWNER) return fail(c, 403, 'owner only');
  const b = await readBody(c);
  const target = String(b.name || '').trim();
  const amount = Number(b.credits);
  if (!target || !Number.isFinite(amount) || amount <= 0) return fail(c, 400, 'name and positive credits required');
  await v2Credits.add(target, DAY(), 'earn', creditsToUnits(amount));
  return ok(c, { granted: { name: target, credits: amount } });
});

v2.post('/credits/gift', requireUser, async (c) => {
  const u = c.get('v2user');
  { const r429 = rate(c, 'gift', 10); if (r429) return fail(c, 429, 'slow down'); }
  const b = await readBody(c);
  const target = String(b.name || '').trim();
  const amount = Number(b.credits);
  if (!target || !Number.isFinite(amount) || amount <= 0) return fail(c, 400, 'name and positive credits required');
  if (!OK_NAME.test(target)) return fail(c, 400, 'bad target name');
  if (amount > 10) return fail(c, 400, 'max 10 credits per gift');
  const day = DAY();
  const free = creditsToUnits(FREE_DAILY_CREDITS);
  const spend = await v2Credits.sum(u.name, day, 'spend');
  const earn = await v2Credits.sum(u.name, day, 'earn');
  const balance = free - spend + earn;
  const units = creditsToUnits(amount);
  if (units > balance) return fail(c, 402, 'not enough credits');
  await v2Credits.add(u.name, day, 'spend', units);
  await v2Credits.add(target, day, 'earn', units);
  return ok(c, { gifted: { to: target, credits: amount } });
});