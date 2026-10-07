import { Hono } from 'hono';
import { store } from './store.js';
import { canWriteProjectData, actorOf } from './authz.js';

// Generic CRUD backend used by generated apps through the injected creat.db SDK.
// Routes: /api/baas/:projectId/:collection[/:rowId]
//
// Authorization: a project's BaaS holds real application data (end-user rows,
// not just build artifacts), so knowing the project id must not be enough to
// read or rewrite it. Private projects are owner/team-only. Published projects
// stay open because a deployed generated app has no end-user auth yet
// (creat.auth is unimplemented) and its own browser clients call these routes
// with no session -- see the residual-risk note below.
//
// RESIDUAL RISK (needs a product decision, not a code fix): while a project is
// published, ANY internet caller can insert/update/delete its rows. That is the
// cost of shipping apps before application-level auth exists. Options, in
// order of preference:
//   1. implement creat.auth and give generated apps real end-user identities;
//   2. issue a per-app write capability at publish time instead of open access;
//   3. make the BaaS read-only for non-owners on published projects.
// Until one of those lands, publishing a project should be understood as
// publishing its database too.

export const baas = new Hono();

async function guard(c) {
  const { pid, coll } = c.req.param();
  if (!(await store.getProject(pid))) return c.json({ error: 'unknown project' }, 404);
  // Must run before the collection-name check so an unauthorized caller can't
  // use error responses to probe which projects and collections exist.
  if (!(await canWriteProjectData(c, pid))) {
    const u = await actorOf(c);
    return u ? c.json({ error: "you don't own this project" }, 403)
      : c.json({ error: 'unknown project' }, 404);
  }
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
  return row ? c.json(row) : c.json({ error: 'row not found' }, 404);
});

baas.put('/:pid/:coll/:id', async (c) => {
  const bad = await guard(c); if (bad) return bad;
  const patch = await c.req.json().catch(() => ({}));
  const row = await store.baasUpdate(c.req.param('pid'), c.req.param('coll'), c.req.param('id'), patch);
  return row ? c.json(row) : c.json({ error: 'row not found' }, 404);
});

baas.delete('/:pid/:coll/:id', async (c) => {
  const bad = await guard(c); if (bad) return bad;
  await store.baasRemove(c.req.param('pid'), c.req.param('coll'), c.req.param('id'));
  return c.json({ ok: true });
});
