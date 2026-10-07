// Authorization regression suite.
//
// Every project-sensitive endpoint is exercised as three identities:
//
//   Alice  owner of AlicePrivate and AlicePublished
//   Bob    authenticated, owns nothing of Alice's
//   Anon   no session
//
// The invariant under test is the one the Terms imply: an unpublished project
// grants nothing to someone who merely knows its id. Run:  node test/authz.test.mjs

import { useStore } from '../src/store.js';
import { setVars } from '../src/env.js';

let failures = 0, passes = 0;
const results = [];
function check(name, actual, expected) {
  const ok = actual === expected;
  if (ok) passes++; else failures++;
  results.push({ ok, name, actual, expected });
}
function section(t) { results.push({ section: t }); }

// ---- fixtures -------------------------------------------------------------
const ALICE = { id: 'u-alice', userId: 'u-alice', name: 'alice' };
const BOB = { id: 'u-bob', userId: 'u-bob', name: 'bob' };
const TOKENS = { alice: 'tok-alice', bob: 'tok-bob' };

const SECRET_FILE = 'index.html';
const SECRET_BODY = '<html>PRIVATE SOURCE — api_key=sk-live-SECRET</html>';

function project(id, owner, published) {
  return { id, name: `app-${id}`, owner, published: published ? 1 : 0,
           created_at: 1, updated_at: 2, description: '', slug: null,
           model: '', plan: null, team_id: '' };
}
const ALICE_PRIVATE = project('priv1', 'alice', false);
const ALICE_PUB = project('pub1', 'alice', true);
const OWNERLESS = project('orphan', '', false);      // the canWrite fail-open case

function makeStore() {
  const projects = new Map([[ALICE_PRIVATE.id, ALICE_PRIVATE], [ALICE_PUB.id, ALICE_PUB], [OWNERLESS.id, OWNERLESS]]);
  const files = new Map([[`${ALICE_PRIVATE.id}:${SECRET_FILE}`, { path: SECRET_FILE, content: SECRET_BODY, encoding: 'utf8' }]]);
  const rows = new Map();      // BaaS rows, keyed `${pid}:${coll}:${id}`
  const events = new Map();   // `${pid}:${room}` -> array
  const meta = new Map();
  let rowSeq = 0;

  const s = {
    // --- projects
    getProject: async (pid) => projects.get(pid) || null,
    listProjects: async () => [...projects.values()],
    listProjectsByOwner: async (owner) => [...projects.values()].filter((p) => p.owner === owner),
    createProject: async (name, owner) => project('new-' + (projects.size + 1), owner, false),
    deleteProject: async (pid) => { projects.delete(pid); return { ok: true }; },
    setPublished: async (pid, pub) => { const p = projects.get(pid); if (p) p.published = pub ? 1 : 0; return p; },
    rename: async (pid, name) => { const p = projects.get(pid); if (p) p.name = name; return p; },
    isTeamMember: async (tid, name) => tid === 'team-bob' && name === 'bob',
    setProjectTeam: async (pid, tid) => { const p = projects.get(pid); if (p) p.team_id = tid; return p; },
    teamInfo: async (tid) => (tid === 'team-bob' ? { id: tid, name: 'Bob', owner: 'bob' } : null),
    // --- files / history / snapshots
    listFiles: async (pid) => [...files.values()].filter((f) => files.has(`${pid}:${f.path}`)).map(({ path }) => ({ path })),
    listFilesWithContent: async (pid) => [...files.entries()].filter(([k]) => k.startsWith(`${pid}:`)).map(([, f]) => ({ ...f })),
    getFile: async (pid, path) => files.get(`${pid}:${path}`) || null,
    history: async () => [{ role: 'user', content: 'my private prompt' }],
    fileVersions: async () => [{ seq: 1, path: SECRET_FILE }],
    getFileVersion: async (pid, path, seq) => ({ seq, path, content: SECRET_BODY }),
    listSnapshots: async () => [{ id: 's1', label: 'v1' }],
    getSnapshot: async (pid, sid) => (sid === 's1' ? { id: sid, files: [{ path: SECRET_FILE, content: SECRET_BODY }] } : null),
    takeSnapshot: async () => ({ id: 's2' }),
    // --- remix
    remix: async (srcPid, owner) => {
      const copy = project(`remix-${srcPid}`, owner, false);
      projects.set(copy.id, copy);
      for (const [k, f] of files) if (k.startsWith(`${srcPid}:`)) files.set(`${copy.id}:${f.path}`, { ...f });
      return copy;
    },
    // --- BaaS
    baasTable: (pid, coll) => (/^[a-z][a-z0-9_]{0,39}$/.test(coll) ? `baas_${pid}_${coll}` : null),
    baasList: async (pid, coll) => [...rows.entries()].filter(([k]) => k.startsWith(`${pid}:${coll}:`)).map(([, v]) => v),
    baasInsert: async (pid, coll, body) => { const id = String(++rowSeq); const r = { id, ...body }; rows.set(`${pid}:${coll}:${id}`, r); return r; },
    baasGet: async (pid, coll, id) => rows.get(`${pid}:${coll}:${id}`) || null,
    baasUpdate: async (pid, coll, id, patch) => { const r = rows.get(`${pid}:${coll}:${id}`); if (!r) return null; Object.assign(r, patch); return r; },
    baasRemove: async (pid, coll, id) => { rows.delete(`${pid}:${coll}:${id}`); return { ok: true }; },
    // --- live / chat
    appendEvent: async (pid, room, data) => { const k = `${pid}:${room}`; events.set(k, [...(events.get(k) || []), data]); return (events.get(k) || []).length; },
    eventsSince: async (pid, room, since) => (events.get(`${pid}:${room}`) || []).slice(since),
    currentSeq: async (pid, room) => (events.get(`${pid}:${room}`) || []).length,
    // --- preview
    recordInteraction: async () => ({ ok: true }),
    interactionsToday: async () => 0,
    touchPresence: async () => ({ active: 1, accepted: true, present: true }),
    presenceUsers: async () => [{ name: 'alice' }],
    // --- meta / sessions
    metaGet: async (k) => (meta.has(k) ? meta.get(k) : null),
    metaSet: async (k, v) => { meta.set(k, v); },
    getSession: async (tok) => (tok === TOKENS.alice ? ALICE : tok === TOKENS.bob ? BOB : null),
  };
  // Publish the app's own publish state back through getProject by reference.
  s.__projects = projects; s.__files = files; s.__rows = rows;
  return s;
}

const store = makeStore();
useStore(store);
// LOCAL_TERMINAL='' forces the remote-daemon transport so the fetch stub below
// intercepts every exec. Left unset, a developer machine (or this sandbox)
// spawns a REAL shell and the suite stops being a pure authorization test.
setVars({
  TERMINAL_URL: 'https://terminal.invalid',
  TERMINAL_TOKEN: 'daemon-token',
  LOCAL_TERMINAL: '',
  LOCAL_SANDBOX: '',
  KAGGLE_RELAY_URL: '',
});

const { app } = await import('../src/app.js');

// Record every outbound daemon call so we can prove authorization happens
// BEFORE any side effect (no mirroring, no exec, no file sync).
const daemonCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  daemonCalls.push(String(typeof input === 'string' ? input : input?.url || ''));
  return new Response(JSON.stringify({ ok: true, output: '', code: 0, sync: null }),
    { status: 200, headers: { 'content-type': 'application/json' } });
};

const BASE = 'http://api.test';
async function call(method, path, who, payload) {
  const headers = {};
  if (who === 'alice') headers['x-ab-sess'] = TOKENS.alice;
  if (who === 'bob') headers['x-ab-sess'] = TOKENS.bob;
  if (path.startsWith('/preview')) headers['origin'] = BASE;
  const init = { method, headers };
  if (payload !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(payload);
  }
  const res = await app.fetch(new Request(BASE + path, init));
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, text, headers: res.headers };
}

// P = AlicePrivate, U = AlicePublished
const P = ALICE_PRIVATE.id, U = ALICE_PUB.id;

// ---------------------------------------------------------------- enumeration
section('Project enumeration (was: GET /api/projects returned every row, no auth)');
check('Anon  GET /api/projects -> 401', (await call('GET', '/api/projects', 'anon')).status, 401);
{
  const r = await call('GET', '/api/projects', 'alice');
  check('Alice GET /api/projects -> 200', r.status, 200);
  const ids = (r.body || []).map((p) => p.id).sort();
  check('Alice sees ONLY her own projects', JSON.stringify(ids), JSON.stringify([P, U].sort()));
  check('Alice cannot see the ownerless project', ids.includes(OWNERLESS.id), false);
}
{
  const r = await call('GET', '/api/projects', 'bob');
  check('Bob   GET /api/projects -> 200 empty', JSON.stringify((r.body || []).map((p) => p.id)), '[]');
}

// ------------------------------------------------------------ private reads
section('Private project reads (metadata / files / chat)');
check('Anon  GET /api/projects/:pid -> 404', (await call('GET', `/api/projects/${P}`, 'anon')).status, 404);
check('Bob   GET /api/projects/:pid -> 403', (await call('GET', `/api/projects/${P}`, 'bob')).status, 403);
check('Alice GET /api/projects/:pid -> 200', (await call('GET', `/api/projects/${P}`, 'alice')).status, 200);

section('Export (full decrypted source)');
check('Anon  GET export -> 404', (await call('GET', `/api/projects/${P}/export`, 'anon')).status, 404);
check('Bob   GET export -> 403', (await call('GET', `/api/projects/${P}/export`, 'bob')).status, 403);
{
  const r = await call('GET', `/api/projects/${P}/export`, 'alice');
  check('Alice GET export -> 200', r.status, 200);
  check('Alice export really contains the source', r.text.includes('sk-live-SECRET'), true);
}

section('Version history');
check('Anon  GET versions -> 404', (await call('GET', `/api/projects/${P}/versions?path=${SECRET_FILE}`, 'anon')).status, 404);
check('Bob   GET versions -> 403', (await call('GET', `/api/projects/${P}/versions?path=${SECRET_FILE}`, 'bob')).status, 403);
check('Alice GET versions -> 200', (await call('GET', `/api/projects/${P}/versions?path=${SECRET_FILE}`, 'alice')).status, 200);
check('Bob   GET one revision -> 403', (await call('GET', `/api/projects/${P}/versions?path=${SECRET_FILE}&seq=1`, 'bob')).status, 403);

section('Snapshots');
check('Anon  GET snapshots -> 404', (await call('GET', `/api/projects/${P}/snapshots`, 'anon')).status, 404);
check('Bob   GET snapshots -> 403', (await call('GET', `/api/projects/${P}/snapshots`, 'bob')).status, 403);
check('Alice GET snapshots -> 200', (await call('GET', `/api/projects/${P}/snapshots`, 'alice')).status, 200);
check('Anon  GET snapshot by id -> 404', (await call('GET', `/api/projects/${P}/snapshots/s1`, 'anon')).status, 404);
check('Bob   GET snapshot by id -> 403', (await call('GET', `/api/projects/${P}/snapshots/s1`, 'bob')).status, 403);
check('Alice GET snapshot by id -> 200', (await call('GET', `/api/projects/${P}/snapshots/s1`, 'alice')).status, 200);

// ------------------------------------------------------------------- remix
section('Remix (was: any signed-in user could copy ANY project, published or not)');
check('Anon  POST remix -> 401', (await call('POST', `/api/projects/${P}/remix`, 'anon')).status, 401);
check('Bob   POST remix private -> 403', (await call('POST', `/api/projects/${P}/remix`, 'bob')).status, 403);
check('Bob   POST remix published -> 201', (await call('POST', `/api/projects/${U}/remix`, 'bob')).status, 201);

// --------------------------------------------------------------- published
section('Published projects stay public (discover previews must keep working)');
check('Anon  GET published metadata -> 200', (await call('GET', `/api/projects/${U}`, 'anon')).status, 200);
check('Anon  GET published preview -> 200', (await call('GET', `/preview/${U}/`, 'anon')).status, 200);

// ------------------------------------------------------------------ preview
section('Preview of a PRIVATE project');
check('Anon  GET private preview -> 404', (await call('GET', `/preview/${P}/`, 'anon')).status, 404);
check('Anon  GET private asset -> 404', (await call('GET', `/preview/${P}/${SECRET_FILE}`, 'anon')).status, 404);
{
  const r = await call('GET', `/preview/${P}/`, 'bob');
  check('Bob   GET private preview -> 404', r.status, 404);
  check('Bob   preview body leaks no source', r.text.includes('sk-live-SECRET'), false);
}
check('Alice GET private preview -> 200', (await call('GET', `/preview/${P}/`, 'alice')).status, 200);
{
  // The iframe/new-tab path: owner mints a scoped token, no session header.
  const mint = await call('POST', `/api/projects/${P}/preview-token`, 'alice');
  check('Alice POST preview-token -> 200', mint.status, 200);
  check('Anon  cannot mint a preview token', (await call('POST', `/api/projects/${P}/preview-token`, 'anon')).status, 401);
  check('Bob   cannot mint a token for Alice', (await call('POST', `/api/projects/${P}/preview-token`, 'bob')).status, 403);
  const tok = mint.body?.token || '';
  const okRes = await call('GET', `/preview/${P}/?pt=${encodeURIComponent(tok)}`, 'anon');
  check('Anon + valid token GET private preview -> 200', okRes.status, 200);
  const cookie = okRes.headers.get('set-cookie') || '';
  check('token response sets a path-scoped HttpOnly cookie', /ab_prev=/.test(cookie) && /HttpOnly/.test(cookie) && /Path=\/preview\//.test(cookie), true);
  const asset = await call('GET', `/preview/${P}/${SECRET_FILE}?pt=${encodeURIComponent(tok)}`, 'anon');
  check('Anon + token GET private asset -> 200', asset.status, 200);
  check('Anon + FORGED token -> 404', (await call('GET', `/preview/${P}/?pt=${tok.slice(0, -2)}xx`, 'anon')).status, 404);
  check("Alice's token does not open a DIFFERENT private project",
    (await call('GET', `/preview/${OWNERLESS.id}/?pt=${encodeURIComponent(tok)}`, 'anon')).status, 404);
}

// -------------------------------------------------------------------- BaaS
section('BaaS — private project data');
check('Anon  GET baas private -> 404', (await call('GET', `/api/baas/${P}/todos`, 'anon')).status, 404);
check('Bob   GET baas private -> 403', (await call('GET', `/api/baas/${P}/todos`, 'bob')).status, 403);
check('Alice GET baas private -> 200', (await call('GET', `/api/baas/${P}/todos`, 'alice')).status, 200);
check('Bob   POST baas private -> 403', (await call('POST', `/api/baas/${P}/todos`, 'bob')).status, 403);
check('Bob   PUT baas private -> 403', (await call('PUT', `/api/baas/${P}/todos/1`, 'bob')).status, 403);
check('Bob   DELETE baas private -> 403', (await call('DELETE', `/api/baas/${P}/todos/1`, 'bob')).status, 403);
check('Anon  GET baas published -> 200 (generated apps keep working)',
  (await call('GET', `/api/baas/${U}/todos`, 'anon')).status, 200);

// ---------------------------------------------------------------- live/chat
section('Live rooms + chat of a PRIVATE project');
check('Anon  POST live push -> 404', (await call('POST', `/api/projects/${P}/live/room1/push`, 'anon')).status, 404);
check('Bob   POST live push -> 403', (await call('POST', `/api/projects/${P}/live/room1/push`, 'bob')).status, 403);
check('Alice POST live push -> 200', (await call('POST', `/api/projects/${P}/live/room1/push`, 'alice')).status, 200);
check('Anon  GET live replay -> 404', (await call('GET', `/api/projects/${P}/live/room1`, 'anon')).status, 404);
check('Bob   GET live replay -> 403', (await call('GET', `/api/projects/${P}/live/room1`, 'bob')).status, 403);
check('Anon  GET chat list -> 404', (await call('GET', `/api/projects/${P}/chat/list`, 'anon')).status, 404);
check('Bob   GET chat list -> 403', (await call('GET', `/api/projects/${P}/chat/list`, 'bob')).status, 403);
check('Bob   POST chat send -> 403', (await call('POST', `/api/projects/${P}/chat/send`, 'bob')).status, 403);
check('Alice POST chat send -> 201', (await call('POST', `/api/projects/${P}/chat/send`, 'alice', { text: 'hi' })).status, 201);
check('Bob   POST chat send with text -> 403', (await call('POST', `/api/projects/${P}/chat/send`, 'bob', { text: 'hi' })).status, 403);
check('Anon  POST live push with data -> 404', (await call('POST', `/api/projects/${P}/live/room1/push`, 'anon', { data: 1 })).status, 404);
check('Anon  GET published chat list -> 200', (await call('GET', `/api/projects/${U}/chat/list`, 'anon')).status, 200);
check('push to a NONEXISTENT project -> 404 (was unchecked)',
  (await call('POST', '/api/projects/ghostproj/live/r/push', 'alice')).status, 404);

// ----------------------------------------------------------------- terminal
section('Terminal — the cross-project exec path');
{
  daemonCalls.length = 0;
  const bob = await call('POST', '/api/terminal/exec', 'bob', { pid: P, cmd: 'cat index.html' });
  check('Bob   POST terminal/exec (Alice pid) -> 403', bob.status, 403);
  check('Bob   exec reached the daemon ZERO times', daemonCalls.length, 0);

  daemonCalls.length = 0;
  check('Anon  POST terminal/exec -> 401', (await call('POST', '/api/terminal/exec', 'anon', { pid: P, cmd: 'id' })).status, 401);
  check('Anon  exec reached the daemon ZERO times', daemonCalls.length, 0);

  daemonCalls.length = 0;
  const alice = await call('POST', '/api/terminal/exec', 'alice', { pid: P, cmd: 'id' });
  check('Alice POST terminal/exec (own pid) -> 200', alice.status, 200);
  check('Alice exec reached the daemon (passed the authz gate)', daemonCalls.length > 0, true);
  check('exec targeted Alice\'s own project', daemonCalls.some((u) => u.includes('/exec')), true);
}

// -------------------------------------------------------- generated servers
section('Generated-app servers (/api/server)');
for (const [m, p] of [['GET', ''], ['POST', '/start'], ['POST', '/stop'], ['GET', '/web/logs']]) {
  const path = `/api/server/${P}${p}`;
  const anon = await call(m, path, 'anon');
  const bob = await call(m, path, 'bob');
  check(`Bob   ${m} /api/server${p || '/:pid'} -> 403`, bob.status, 403);
  check(`Anon  ${m} /api/server${p || '/:pid'} -> 401`, anon.status, 401);
}

// ---------------------------------------------------------- ownerless rows
section('Ownerless project rows (the canWrite fail-open)');
check('Bob   POST rename ownerless -> 403 (was allowed)',
  (await call('POST', `/api/projects/${OWNERLESS.id}/rename`, 'bob')).status, 403);
check('Bob   POST delete ownerless -> 403', (await call('DELETE', `/api/projects/${OWNERLESS.id}`, 'bob')).status, 403);
check('Bob   POST upload ownerless -> 403', (await call('POST', `/api/projects/${OWNERLESS.id}/upload`, 'bob')).status, 403);
// Escalation path: `if (project.owner && ...)` skipped the check on an
// ownerless row, letting anyone graft it into their own team -- and canWrite
// then honours team membership, handing the attacker write access.
check('Bob   POST /team on ownerless -> 403 (team-claim escalation)',
  (await call('POST', `/api/projects/${OWNERLESS.id}/team`, 'bob', { team_id: 'team-bob' })).status, 403);
check('Alice POST /team without membership -> 403',
  (await call('POST', `/api/projects/${P}/team`, 'alice', { team_id: 'team-bob' })).status, 403);
check('Anon  POST rename ownerless -> 401',
  (await call('POST', `/api/projects/${OWNERLESS.id}/rename`, 'anon')).status, 401);

// ---------------------------------------------------------------- presence
section('Presence (was world-readable: showed who is editing a private project)');
check('Anon  GET presence -> 404', (await call('GET', `/api/projects/${P}/presence`, 'anon')).status, 404);
check('Bob   GET presence -> 403', (await call('GET', `/api/projects/${P}/presence`, 'bob')).status, 403);
check('Alice GET presence -> 200', (await call('GET', `/api/projects/${P}/presence`, 'alice')).status, 200);

// ----------------------------------------------------------------- docs
section('/api/docs advertises the real policy');
{
  const d = (await call('GET', '/api/docs', 'anon')).body;
  const byKey = Object.fromEntries((d?.endpoints || []).map((e) => [`${e.method} ${e.path}`, e.auth]));
  check('docs: GET /api/projects is no longer auth:none', byKey['GET /api/projects'], 'user');
  check('docs: GET /api/projects/:pid is no longer auth:none', byKey['GET /api/projects/:pid'], 'owner');
  check('docs: export is no longer auth:none', byKey['GET /api/projects/:pid/export'], 'owner');
  check('docs: versions is no longer auth:none', byKey['GET /api/projects/:pid/versions?path=<file>&seq=<n>'], 'owner');
  check('docs: snapshots is no longer auth:none', byKey['GET /api/projects/:pid/snapshots'], 'owner');
  check('docs: snapshot by id is no longer auth:none', byKey['GET /api/projects/:pid/snapshots/:sid'], 'owner');
  check('docs: terminal exec is owner', byKey['POST /api/terminal/exec'], 'owner');
}

globalThis.fetch = realFetch;

// ------------------------------------------------------------------ report
for (const r of results) {
  if (r.section) { console.log(`\n── ${r.section}`); continue; }
  if (r.ok) { console.log(`  ✓ ${r.name}`); continue; }
  console.log(`  ✗ ${r.name}\n      expected ${r.expected}, got ${r.actual}`);
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
