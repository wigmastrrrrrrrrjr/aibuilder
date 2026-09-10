// Community feature voting — lets users propose experimental aib features and
// vote on them, so the maintainer can see every day what people actually want.
//
//   GET    /api/features                 list features, sorted by net score
//   POST   /api/features                 propose a new experimental feature  (signed-in)
//   POST   /api/features/:id/vote        { vote: 1 | 0 | -1 }  (signed-in, upsert)
//   POST   /api/features/:id/status      { status }  (maintainer, x-admin-key)
//
// Storage lives in Postgres through the split store (see store-split.js).

import { Hono } from 'hono';
import { requireUser } from './auth.js';
import { getVar } from './env.js';
import { store } from './store.js';

export const features = new Hono();

const TITLE_RE = /^[A-Za-z0-9 _\-!.?'"\/+()]{3,80}$/;

async function listFeatures(me) {
  return store.featuresList(me || null);
}

features.get('/api/features', async (c) => {
  let me = null;
  try { me = c.get('user')?.name; } catch { /* anonymous */ }
  try {
    return c.json(await listFeatures(me));
  } catch (e) {
    return c.json({ error: `features unavailable: ${e.message}` }, 500);
  }
});

// Propose an experimental feature.
features.post('/api/features', requireUser, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const title = String(body.title || '').trim().slice(0, 80);
  const description = String(body.description || '').trim().slice(0, 500);
  if (!TITLE_RE.test(title)) return c.json({ error: 'title: 3-80 letters, digits, spaces, - _ ! . / + ( )' }, 400);

  try {
    await store.featureAdd({ title, description, status: 'proposed', created_by: c.get('user').name, created_at: Date.now() });
    return c.json(await listFeatures(c.get('user').name), 201);
  } catch (e) {
    return c.json({ error: `features unavailable: ${e.message}` }, 500);
  }
});

// Cast (or change / remove) a vote: vote = 1 up, -1 down, 0 clear.
features.post('/api/features/:id/vote', requireUser, async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const vote = Number(body.vote);
  if (![-1, 0, 1].includes(vote)) return c.json({ error: 'vote must be 1, 0 or -1' }, 400);

  try {
    const exists = await store.featureGet(id);
    if (!exists) return c.json({ error: 'feature not found' }, 404);
    const me = c.get('user').name;
    await store.featureVote(id, me, vote, Date.now());
    return c.json({
      ok: true,
      feature: (await listFeatures(me)).find((f) => f.id === id),
    });
  } catch (e) {
    return c.json({ error: `features unavailable: ${e.message}` }, 500);
  }
});

// Maintainer: flip a feature's status (proposed → planned → accepted → shipped → rejected).
features.post('/api/features/:id/status', async (c) => {
  const adminKey = getVar('FEATURES_ADMIN_KEY');
  const key = String(c.req.header('x-admin-key') || '');
  if (!adminKey || key !== adminKey) return c.json({ error: 'unauthorized' }, 401);

  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const status = String(body.status || '').trim().slice(0, 20);
  const VALID = ['proposed', 'planned', 'accepted', 'shipped', 'rejected'];
  if (!VALID.includes(status)) return c.json({ error: `status must be one of: ${VALID.join(', ')}` }, 400);

  try {
    const exists = await store.featureGet(id);
    if (!exists) return c.json({ error: 'feature not found' }, 404);
    await store.featureStatus(id, status);
    return c.json({ ok: true, id, status });
  } catch (e) {
    return c.json({ error: `features unavailable: ${e.message}` }, 500);
  }
});