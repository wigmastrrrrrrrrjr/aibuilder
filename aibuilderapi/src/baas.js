import { Hono } from 'hono';
import { store } from './store.js';

// Generic CRUD backend used by generated apps through the injected creat.db SDK.
// Routes: /api/baas/:projectId/:collection[/:rowId]

export const baas = new Hono();

async function guard(c) {
  const { pid, coll } = c.req.param();
  if (!(await store.getProject(pid))) return c.json({ error: 'unknown project' }, 404);
  if (!store.baasTable(pid, coll)) return c.json({ error: 'invalid collection name' }, 400);
  return null;
}

baas.get('/:pid/:coll', async (c) => {
  const bad = await guard(c); if (bad) return bad;
  return c.json(await store.baasList(c.req.param('pid'), c.req.param('coll')));
});

baas.post('/:pid/:coll', async (c) => {
  const bad = await guard(c); if (bad) return bad;
  const body = await c.req.json().catch(() => ({}));
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return c.json({ error: 'JSON object required' }, 400);
  }
  return c.json(await store.baasInsert(c.req.param('pid'), c.req.param('coll'), body), 201);
});

baas.get('/:pid/:coll/:id', async (c) => {
  const bad = await guard(c); if (bad) return bad;
  const row = await store.baasGet(c.req.param('pid'), c.req.param('coll'), c.req.param('id'));
  return row ? c.json(row) : c.json({ error: 'not found' }, 404);
});

baas.put('/:pid/:coll/:id', async (c) => {
  const bad = await guard(c); if (bad) return bad;
  const patch = await c.req.json().catch(() => ({}));
  const row = await store.baasUpdate(c.req.param('pid'), c.req.param('coll'), c.req.param('id'), patch);
  return row ? c.json(row) : c.json({ error: 'not found' }, 404);
});

baas.delete('/:pid/:coll/:id', async (c) => {
  const bad = await guard(c); if (bad) return bad;
  const ok = await store.baasRemove(c.req.param('pid'), c.req.param('coll'), c.req.param('id'));
  return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
});
