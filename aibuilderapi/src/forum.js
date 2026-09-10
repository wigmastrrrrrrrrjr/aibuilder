// Community forum — categories, threads, replies, votes, moderation.
//
//   GET    /api/forum/categories                              list categories
//   GET    /api/forum/categories/:cat/threads                 list threads (?before=<last_at>&limit=)
//   POST   /api/forum/categories/:cat/threads                 new thread          (signed-in)
//   GET    /api/forum/threads/:tid                            thread + posts
//   POST   /api/forum/threads/:tid/reply                      reply               (signed-in)
//   POST   /api/forum/threads/:tid/vote                       { vote: 1 | 0 | -1 } (signed-in)
//   POST   /api/forum/threads/:tid/mod                        admin (x-admin-key): { pinned?, closed?, delete? }
//
// Reading is public (works over the anonymous /api). Posting needs a session.
// Storage is Postgres (supabase-v1.sql → store-pg.js).

import { Hono } from 'hono';
import { requireUser, getUser } from './auth.js';
import { store } from './store.js';
import { getVar } from './env.js';

export const forum = new Hono();

const TITLE_RE = /^[\s\S]{3,160}$/;
const BODY_MAX = 20000;

async function me(c) {
  try { const u = await getUser(c); return u ? u.name : null; } catch { return null; }
}

function isAdmin(c) {
  const adminKey = getVar('FORUM_ADMIN_KEY') || getVar('FEATURES_ADMIN_KEY');
  const key = String(c.req.header('x-admin-key') || '');
  return Boolean(adminKey && key && key === adminKey);
}

forum.get('/categories', async (c) => {
  try {
    const cats = await store.forumCategories();
    const out = [];
    for (const cat of cats) {
      const threads = await store.forumThreads(cat.id, null, null, 9999);
      out.push({ ...cat, threads: threads.length, last: threads[0] || null });
    }
    return c.json(out);
  } catch (e) {
    return c.json({ error: `forum unavailable: ${e.message}` }, 500);
  }
});

forum.get('/categories/:cat/threads', async (c) => {
  const cat = c.req.param('cat');
  const before = Number(c.req.query('before')) || null;
  const limit = Number(c.req.query('limit')) || 20;
  try {
    if (!(await store.forumCategory(cat))) return c.json({ error: 'unknown category' }, 404);
    const threads = await store.forumThreads(cat, await me(c), before, limit);
    return c.json({ category: cat, before, threads });
  } catch (e) {
    return c.json({ error: `forum unavailable: ${e.message}` }, 500);
  }
});

forum.post('/categories/:cat/threads', requireUser, async (c) => {
  const cat = c.req.param('cat');
  const body = await c.req.json().catch(() => ({}));
  const title = String(body.title || '').trim();
  const content = String(body.content || '').trim();
  if (!title || title.length > 160) return c.json({ error: 'title: 3-160 characters' }, 400);
  if (!content || content.length > BODY_MAX) return c.json({ error: `content: 1-${BODY_MAX} characters` }, 400);
  try {
    if (!(await store.forumCategory(cat))) return c.json({ error: 'unknown category' }, 404);
    const id = await store.forumCreateThread({ category: cat, title, author: c.get('user').name, content });
    const thread = await store.forumThread(id, c.get('user').name);
    return c.json({ thread }, 201);
  } catch (e) {
    return c.json({ error: `forum unavailable: ${e.message}` }, 500);
  }
});

forum.get('/threads/:tid', async (c) => {
  try {
    const t = await store.forumThread(c.req.param('tid'), await me(c));
    if (!t) return c.json({ error: 'thread not found' }, 404);
    return c.json({ thread: t });
  } catch (e) {
    return c.json({ error: `forum unavailable: ${e.message}` }, 500);
  }
});

forum.post('/threads/:tid/reply', requireUser, async (c) => {
  const tid = c.req.param('tid');
  const body = await c.req.json().catch(() => ({}));
  const content = String(body.content || '').trim();
  if (!content || content.length > BODY_MAX) return c.json({ error: `content: 1-${BODY_MAX} characters` }, 400);
  try {
    const r = await store.forumReply(tid, c.get('user').name, content);
    if (r && r.error) return c.json({ error: r.error }, r.error === 'thread not found' ? 404 : 409);
    const thread = await store.forumThread(tid, c.get('user').name);
    return c.json({ thread }, 201);
  } catch (e) {
    return c.json({ error: `forum unavailable: ${e.message}` }, 500);
  }
});

forum.post('/threads/:tid/vote', requireUser, async (c) => {
  const tid = c.req.param('tid');
  const body = await c.req.json().catch(() => ({}));
  const vote = Number(body.vote);
  if (![-1, 0, 1].includes(vote)) return c.json({ error: 'vote must be 1, 0 or -1' }, 400);
  try {
    const t = await store.forumThread(tid, null);
    if (!t) return c.json({ error: 'thread not found' }, 404);
    await store.forumVote(tid, c.get('user').name, vote, Date.now());
    const after = await store.forumThread(tid, c.get('user').name);
    return c.json({ thread: after });
  } catch (e) {
    return c.json({ error: `forum unavailable: ${e.message}` }, 500);
  }
});

forum.post('/threads/:tid/mod', async (c) => {
  if (!isAdmin(c)) return c.json({ error: 'unauthorized' }, 401);
  const tid = c.req.param('tid');
  const body = await c.req.json().catch(() => ({}));
  const patch = {};
  if (body.pinned !== undefined) patch.pinned = Boolean(body.pinned);
  if (body.closed !== undefined) patch.closed = Boolean(body.closed);
  if (body.delete === true) patch.delete = true;
  if (!Object.keys(patch).length) return c.json({ error: 'nothing to do' }, 400);
  try {
    if (!patch.delete && !(await store.forumThread(tid, null))) return c.json({ error: 'thread not found' }, 404);
    return c.json(await store.forumMod(tid, patch));
  } catch (e) {
    return c.json({ error: `forum unavailable: ${e.message}` }, 500);
  }
});