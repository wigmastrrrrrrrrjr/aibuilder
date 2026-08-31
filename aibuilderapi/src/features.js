// Community feature voting — lets users propose experimental aib features and
// vote on them, so the maintainer can see every day what people actually want.
//
//   GET    /api/features                 list features, sorted by net score
//   POST   /api/features                 propose a new experimental feature  (signed-in)
//   POST   /api/features/:id/vote        { vote: 1 | 0 | -1 }  (signed-in, upsert)
//   POST   /api/features/:id/status      { status }  (maintainer, x-admin-key)
//
// Works on Cloudflare D1 via the `DB` binding (getVar('DB')). On backends with
// no D1 binding it responds gracefully so local dev doesn't crash the app.

import { Hono } from 'hono';
import { requireUser } from './auth.js';
import { getVar } from './env.js';

export const features = new Hono();

const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);
const TITLE_RE = /^[A-Za-z0-9 _\-!.?'"\/+()]{3,80}$/;

function db() {
  return getVar('DB') || null;
}

async function ensureTables(d) {
  await d.prepare(`CREATE TABLE IF NOT EXISTS features (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'proposed',
    created_by TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`).run();
  await d.prepare(`CREATE TABLE IF NOT EXISTS feature_votes (
    feature_id TEXT NOT NULL,
    user TEXT NOT NULL,
    vote INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (feature_id, user)
  )`).run();
}

// List features with live vote tallies and (optionally) the caller's own vote.
async function listFeatures(d, me) {
  await ensureTables(d);
  const { results: rows } = await d.prepare(
    'SELECT id, title, description, status, created_by, created_at FROM features'
  ).all();
  const { results: tallies } = await d.prepare(
    'SELECT feature_id, SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END) AS up, ' +
    'SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END) AS down, ' +
    'SUM(vote) AS score FROM feature_votes GROUP BY feature_id'
  ).all();
  const tmap = {};
  for (const t of tallies) tmap[t.feature_id] = { up: Number(t.up || 0), down: Number(t.down || 0), score: Number(t.score || 0) };

  const mine = {};
  if (me) {
    const { results: mv } = await d.prepare(
      'SELECT feature_id, vote FROM feature_votes WHERE user = ?'
    ).bind(me).all();
    for (const v of mv) mine[v.feature_id] = v.vote;
  }

  return rows.map((r) => {
    const tally = tmap[r.id] || { up: 0, down: 0, score: 0 };
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      status: r.status,
      created_by: r.created_by,
      created_at: r.created_at,
      up: tally.up,
      down: tally.down,
      score: tally.score,
      my_vote: me ? (mine[r.id] ?? 0) : undefined,
    };
  }).sort((a, b) => b.score - a.score || b.created_at - a.created_at);
}

features.get('/api/features', async (c) => {
  const d = db();
  if (!d) return c.json({ error: 'database not available' }, 500);
  let me = null;
  try { me = c.get('user')?.name; } catch { /* anonymous */ }
  return c.json(await listFeatures(d, me));
});

// Propose an experimental feature.
features.post('/api/features', requireUser, async (c) => {
  const d = db();
  if (!d) return c.json({ error: 'database not available' }, 500);
  const body = await c.req.json().catch(() => ({}));
  const title = String(body.title || '').trim().slice(0, 80);
  const description = String(body.description || '').trim().slice(0, 500);
  if (!TITLE_RE.test(title)) return c.json({ error: 'title: 3-80 letters, digits, spaces, - _ ! . / + ( )' }, 400);

  const id = uid();
  await ensureTables(d);
  await d.prepare(
    'INSERT INTO features (id, title, description, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, title, description, 'proposed', c.get('user').name, Date.now()).run();
  return c.json(await listFeatures(d, c.get('user').name), 201);
});

// Cast (or change / remove) a vote: vote = 1 up, -1 down, 0 clear.
features.post('/api/features/:id/vote', requireUser, async (c) => {
  const d = db();
  if (!d) return c.json({ error: 'database not available' }, 500);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const vote = Number(body.vote);
  if (![-1, 0, 1].includes(vote)) return c.json({ error: 'vote must be 1, 0 or -1' }, 400);

  await ensureTables(d);
  const exists = await d.prepare('SELECT 1 AS x FROM features WHERE id = ?').bind(id).first();
  if (!exists) return c.json({ error: 'feature not found' }, 404);

  const me = c.get('user').name;
  await d.prepare(
    'INSERT INTO feature_votes (feature_id, user, vote, updated_at) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(feature_id, user) DO UPDATE SET vote = excluded.vote, updated_at = excluded.updated_at'
  ).bind(id, me, vote, Date.now()).run();

  return c.json({
    ok: true,
    feature: (await listFeatures(d, me)).find((f) => f.id === id),
  });
});

// Maintainer: flip a feature's status (proposed → planned → accepted → shipped → rejected).
features.post('/api/features/:id/status', async (c) => {
  const d = db();
  if (!d) return c.json({ error: 'database not available' }, 500);
  const adminKey = getVar('FEATURES_ADMIN_KEY');
  const key = String(c.req.header('x-admin-key') || '');
  if (!adminKey || key !== adminKey) return c.json({ error: 'unauthorized' }, 401);

  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const status = String(body.status || '').trim().slice(0, 20);
  const VALID = ['proposed', 'planned', 'accepted', 'shipped', 'rejected'];
  if (!VALID.includes(status)) return c.json({ error: `status must be one of: ${VALID.join(', ')}` }, 400);

  await ensureTables(d);
  const exists = await d.prepare('SELECT 1 AS x FROM features WHERE id = ?').bind(id).first();
  if (!exists) return c.json({ error: 'feature not found' }, 404);
  await d.prepare('UPDATE features SET status = ? WHERE id = ?').bind(status, id).run();
  return c.json({ ok: true, id, status });
});
