import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { store } from './store.js';
import { chat } from './chat.js';
import { baas } from './baas.js';
import { appLimitCheck, projectIdOfPath } from './app-limit.js';
import { preview, BAAS_SDK_JS } from './preview.js';
import { models, FREE_DAILY_CREDITS, creditsToUnits, unitsToCredits } from './models.js';
import { getVar } from './env.js';
import { builtinKey } from './keys.js';
import { toBase64 } from './base64.js';
import { live } from './live.js';
import { terminal, serverApi } from './terminal.js';
import { kterm } from './kterm.js';
import { agentBridge } from './agent-bridge.js';
import { auth, requireUser, canWrite } from './auth.js';
import {
  requireVisible, requireRead, requireWrite, requirePublished,
  mintPreviewToken, publicProjectView, canRead, actorOf,
} from './authz.js';
import { teams } from './teams.js';
import { features } from './features.js';
import { forum } from './forum.js';
import { teamPool, personalBalance } from './credits.js';
import { v2 } from './v2.js';
import { rateLimit } from './rate-limit.js';
import {
  CORS_OPTIONS, DEFAULT_ALLOWED_ORIGINS, GITHUB_URL, originAllowed,
} from './web-origin.js';

export { DEFAULT_ALLOWED_ORIGINS };

const V1_DISABLED = (getVar('V1_DISABLED') || '1') === '1';

export const app = new Hono();


// CORS: only approved origins may call this API from a browser — the GitHub
// Pages site and the worker's own origin by default; loopback origins are kept
// for local `npm start` development. Requests with no Origin (same-origin,
// curl, non-browser tooling) pass through. Add more with the ALLOWED_ORIGINS
// env var (comma-separated). Any OTHER Origin stays public but gets a very
// strict rate limit below (10 requests/day) instead of a hard block.
// (Policy lives in web-origin.js so the chat/preview workers share it.)

app.use('*', async (c, next) => {
  if (V1_DISABLED && !c.req.path.startsWith('/api/v2') && !c.req.path.startsWith('/preview') && !c.req.path.startsWith('/__baas.js') && !c.req.path.startsWith('/api/kterm') && !c.req.path.startsWith('/api/health')) {
    // Only allow v2 + preview + infra paths. Legacy v1 API is retired.
    return c.json({ error: 'v1 API retired; use /api/v2' }, 410);
  }
  return next();
});

app.use('*', cors(CORS_OPTIONS));

// Foreign origins (anything not on the allowlist) may use the public API, but
// under a very strict cap. Preflights are free (cheap, hit no route state).
app.use('*', async (c, next) => {
  if (c.req.method === 'OPTIONS') return next();
  const o = c.req.header('origin');
  if (o && !originAllowed(o)) return foreignLimit(c, next);
  return next();
});

// NO compression, NO caching. The client that consumes this API cannot decode
// gzip, and Cloudflare's edge re-encodes responses (even identity/q=0 requests
// got a gzip BODY with no content-encoding header — undecodable garbage).
// Every response is plain identity; declaring `content-encoding: identity`
// stops the edge from re-encoding it. /api/chat SSE is left untouched.
app.use('*', async (c, next) => {
  await next();
  if (!c.res || c.res.headers.has('content-encoding')) return;
  c.res.headers.set('content-encoding', 'identity');
  c.res.headers.set('cache-control', 'no-store');
});

// ---- rate limits ------------------------------------------------------------
const DAY = 86400000;
const MIN = 60000;
const globalLimit = rateLimit({ windowMs: DAY, max: 200 });   // 200 API calls/day per IP
const chatLimit   = rateLimit({ windowMs: MIN, max: 3000 });  // 3000 chats/min per IP
const projectsLimit = rateLimit({ windowMs: MIN, max: 2000 }); // per-IP on /api/projects* (live polling auto-excluded)
const baasLimit     = rateLimit({ windowMs: MIN, max: 4000 }); // per-IP on /api/baas
const authLimit   = rateLimit({ windowMs: MIN, max: 3 });     // 3 auth attempts/min per IP
const uploadLimit = rateLimit({ windowMs: MIN, max: 3 });     // 3 uploads/min per IP
const giftLimit   = rateLimit({ windowMs: MIN, max: 3 });     // 3 gifts/min per IP
const termLimit   = rateLimit({ windowMs: MIN, max: 30 });    // 30 terminal cmds/min per IP
// Requests from an Origin outside the allowlist: very strict — 10/day per origin.
const foreignLimit = rateLimit({ windowMs: DAY, max: 10, keyFn: (c) => 'foreign:' + (c.req.header('origin') || '') });

// Limiters MUST be registered before any matching route: Hono skips app.use()
// middleware for a path once a route for that exact path already exists.
// Brute-force protection applies ONLY to credential-verifying POST endpoints.
// Identity reads (GET /api/auth/me — the creat.me() call every generated app
// makes on page load, plus creat.push/creat.live identity lookups) must NOT
// count against the 3-attempt budget: they'd 429 within seconds and make
// creat.me() resolve to null for signed-in users.
app.use('/api/auth/*', async (c, next) => {
  const ATTEMPT = new Set(['/api/auth/login', '/api/auth/signup', '/api/auth/verify-email',
    '/api/auth/verify-tfa', '/api/auth/reset', '/api/auth/resend-code']);
  if (!ATTEMPT.has(c.req.path)) return next();
  return authLimit(c, next);
});
app.use('/api/chat', chatLimit);
app.use('/api/projects/*/upload', uploadLimit);
app.use('/api/credits/gift', giftLimit);
app.use('/api/credits/grant', giftLimit);
app.use('/api/terminal/exec', termLimit);
// Projects + BaaS: one dispatcher so the bare path and every subpath count a
// single hit (registering both '/p' and '/p/*' double-counts the bare path).
app.use('*', async (c, next) => {
  const p = c.req.path;
  if (p === '/api/projects' || p.startsWith('/api/projects/')) return projectsLimit(c, next);
  if (p === '/api/baas' || p.startsWith('/api/baas/')) return baasLimit(c, next);
  return next();
});

// per-app resource budget (preview / BaaS / live) — 200k req/min default
app.use('*', async (c, next) => {
  const pid = projectIdOfPath(c.req.path);
  if (pid) {
    const r = appLimitCheck(pid);
    c.header('X-App-Limit', String(r.limit));
    c.header('X-App-Limit-Remaining', String(r.remaining));
    if (r.over) {
      c.header('Retry-After', '60');
      return c.json({ error: 'app resource limit exceeded — too many requests (200k/min). Slow down and retry.', limit: r.limit, window: '60s' }, 429);
    }
  }
  return next();
});

// ---- meta & models ----------------------------------------------------------
app.get('/api/meta', (c) =>
  c.json({
    model: getVar('OLLAMA_MODEL') || 'gemma4:31b',
    hasKey: Boolean(builtinKey()),
    github: GITHUB_URL,
  })
);

// ---- API documentation ----------------------------------------------------
app.get('/api/docs', (c) => {
  const base = new URL(c.req.url).origin;
  const auth = { header: 'x-ab-sess: <token>', sources: ['POST /api/auth/signup', 'POST /api/auth/login'] };
  return c.json({
    name: 'aibuilder API',
    version: '0.2.0',
    description: 'AI app builder backend. Allowed browser origins use the full API; any other Origin is public but strictly rate-limited (10 requests/day).',
    baseUrl: base,
    allowedOrigins: DEFAULT_ALLOWED_ORIGINS,
    auth,
    v2: {
      base: '/api/v2',
      version: 2,
      docs: '/api/v2/docs',
      storage: 'Supabase (schema: supabase-v2.sql) — the v1 API persists in Cloudflare D1; v2 lives in Postgres with Realtime.',
    },
    streams: [
      { method: 'POST', path: '/api/chat', auth: 'user', format: 'text/event-stream (SSE)', body: { message: 'string (required)', projectId: 'string', model: 'string', apiKey: 'string', mode: "'workspace'", temperature: 'number (1 to what the model supports)' }, events: ['meta', 'token', 'think', 'file', 'edit', 'delete', 'rename', 'asset', 'plan', 'name', 'delegate', 'subagent', 'refactor', 'seed', 'cmd', 'warn', 'error', 'done'] },
    ],
    endpoints: [
      { method: 'GET', path: '/api/docs', auth: 'none', description: 'This documentation' },
      { method: 'GET', path: '/api/meta', auth: 'none', description: 'Model + key status' },
      { method: 'GET', path: '/api/models', auth: 'none', description: 'Model catalogue' },

      { method: 'GET', path: '/api/projects', auth: 'user', description: 'List projects' },
      { method: 'POST', path: '/api/projects', auth: 'user', body: { name: 'string' }, description: 'Create a project' },
      { method: 'GET', path: '/api/projects/:pid', auth: 'owner', description: 'Project + files + recent messages' },
      { method: 'GET', path: '/api/projects/:pid/export', auth: 'owner', description: 'Raw files (for terminal client / tooling)' },
      { method: 'DELETE', path: '/api/projects/:pid', auth: 'owner', description: 'Delete a project' },
      { method: 'POST', path: '/api/projects/:pid/rename', auth: 'owner', body: { name: 'string' }, description: 'Rename' },
      { method: 'POST', path: '/api/projects/:pid/publish', auth: 'owner', body: { publish: 'boolean', description: 'string' }, description: 'Publish / unpublish to discovery feed' },
      { method: 'POST', path: '/api/projects/:pid/remix', auth: 'user', description: 'Copy a PUBLISHED app into your own project (403 for private projects)' },
      { method: 'GET', path: '/api/projects/:pid/versions?path=<file>&seq=<n>', auth: 'owner', description: 'File revision list, or one revision with seq' },
      { method: 'POST', path: '/api/projects/:pid/restore-version', auth: 'owner', body: { path: 'string', seq: 'number' }, description: 'Undo/redo a single file' },
      { method: 'GET', path: '/api/projects/:pid/snapshots', auth: 'owner', description: 'List project snapshots' },
      { method: 'POST', path: '/api/projects/:pid/snapshots', auth: 'owner', body: { label: 'string' }, description: 'Take a snapshot' },
      { method: 'GET', path: '/api/projects/:pid/snapshots/:sid', auth: 'owner', description: 'Snapshot + its files' },
      { method: 'POST', path: '/api/projects/:pid/snapshots/:sid/restore', auth: 'owner', description: 'Roll the whole project back' },
      { method: 'POST', path: '/api/projects/:pid/upload', auth: 'owner', body: 'multipart "files" (repeatable)', description: 'Upload existing files (max 300, 2MB each)' },
      { method: 'POST', path: '/api/projects/:pid/presence', auth: 'user', body: { sid: 'string' }, description: 'Join presence (10-person cap)' },
      { method: 'POST', path: '/api/projects/:pid/preview-token', auth: 'owner', description: 'Mint a ~15min read-only token so a PRIVATE project can be previewed in an iframe/new tab, which cannot send the session header' },
      { method: 'POST', path: '/api/projects/:pid/presence/leave', auth: 'user', body: { sid: 'string' }, description: 'Leave presence' },
      { method: 'GET', path: '/api/projects/:pid/presence', auth: 'owner', description: 'Who is currently building' },

      { method: 'GET', path: '/api/discover', auth: 'none', description: 'Published-app discovery feed' },

      { method: 'GET', path: '/api/credits', auth: 'user', description: 'Daily credit balance + teams' },
      { method: 'POST', path: '/api/credits/gift', auth: 'user', body: { to: 'string', amount: 'number' }, description: 'Gift credits (max 10000)' },
      { method: 'POST', path: '/api/credits/grant', auth: 'user', body: { credits: 'number' }, description: 'Top up the signed-in user\'s balance (WebSim port grant; max 10000)' },

      { method: 'POST', path: '/api/auth/signup', auth: 'none', body: { username: 'string', password: 'string', email: 'string', dob: 'string' }, description: 'Sign up (email verification may follow)' },
      { method: 'POST', path: '/api/auth/verify-email', auth: 'none', body: { username: 'string', code: 'string' }, description: 'Confirm signup code' },
      { method: 'POST', path: '/api/auth/login', auth: 'none', body: { username: 'string', password: 'string' }, description: 'Login → { token, username }' },
      { method: 'POST', path: '/api/auth/verify-tfa', auth: 'none', body: { username: 'string', code: 'string' }, description: '2FA code' },
      { method: 'POST', path: '/api/auth/resend-code', auth: 'none', body: { username: 'string', type: 'signup|login' }, description: 'Resend verification code' },
      { method: 'POST', path: '/api/auth/reset', auth: 'none', body: { username: 'string', password: 'string' }, description: 'Reset password' },
      { method: 'GET', path: '/api/auth/me', auth: 'user', description: 'Current user' },
      { method: 'POST', path: '/api/auth/logout', auth: 'user', description: 'End session' },

      { method: 'POST', path: '/api/teams', auth: 'user', body: { name: 'string' }, description: 'Create team' },
      { method: 'GET', path: '/api/teams', auth: 'user', description: 'My teams' },
      { method: 'GET', path: '/api/teams/by-invite/:code', auth: 'user', description: 'Resolve invite code' },
      { method: 'GET', path: '/api/teams/:tid', auth: 'user', description: 'Team info + members' },
      { method: 'POST', path: '/api/teams/:tid/join', auth: 'user', body: { code: 'string' }, description: 'Join via invite code' },
      { method: 'POST', path: '/api/teams/:tid/leave', auth: 'user', description: 'Leave team' },
      { method: 'DELETE', path: '/api/teams/:tid', auth: 'owner', description: 'Delete team' },
      { method: 'POST', path: '/api/projects/:pid/team', auth: 'owner', body: { teamId: 'string' }, description: 'Assign project to a team' },

      { method: 'GET', path: '/api/features', auth: 'none', description: 'Feature list + votes' },
      { method: 'POST', path: '/api/features', auth: 'user', body: { title: 'string', description: 'string' }, description: 'Propose a feature' },
      { method: 'POST', path: '/api/features/:id/vote', auth: 'user', body: { vote: 'number' }, description: 'Up/down vote' },
      { method: 'POST', path: '/api/features/:id/status', auth: 'owner', body: { status: 'string' }, description: 'Update feature status' },

      { method: 'POST', path: '/api/projects/:pid/live/:room/push', auth: 'owner | published', body: { data: 'any' }, description: 'Append realtime event' },
      { method: 'GET', path: '/api/projects/:pid/live/:room?since=<seq>&limit=<n>', auth: 'owner | published', description: 'Poll realtime events (browsers normally use SSE — see live.js)' },
      { method: 'POST', path: '/api/projects/:pid/chat/send', auth: 'owner | published', body: { room: 'string', text: 'string' }, description: 'Room chat message' },
      { method: 'GET', path: '/api/projects/:pid/chat/list?room=<r>&since=<seq>&limit=<n>', auth: 'owner | published', description: 'Room chat history' },

      { method: 'GET', path: '/api/baas/:pid/:coll', auth: 'owner | published', description: 'BaaS list rows' },
      { method: 'POST', path: '/api/baas/:pid/:coll', auth: 'owner | published', body: 'row fields', description: 'BaaS insert' },
      { method: 'GET', path: '/api/baas/:pid/:coll/:id', auth: 'owner | published', description: 'BaaS get row' },
      { method: 'PUT', path: '/api/baas/:pid/:coll/:id', auth: 'owner | published', body: 'patch fields', description: 'BaaS merge-patch row' },
      { method: 'DELETE', path: '/api/baas/:pid/:coll/:id', auth: 'owner | published', description: 'BaaS delete row' },

      { method: 'GET', path: '/preview/:projectId/*', auth: 'owner | published | preview-token', description: 'Serve a generated app with the BaaS SDK injected' },
      { method: 'GET', path: '/__baas.js', auth: 'none', description: 'Client SDK for generated apps (window.creat.db)' },

      { method: 'GET', path: '/api/terminal/status', auth: 'none', description: 'Is the cloud terminal configured?' },
      { method: 'POST', path: '/api/terminal/exec', auth: 'owner', body: { pid: 'string', cmd: 'string', cwd: 'string', timeoutMs: 'number' }, description: 'Run a shell command on the project\'s cloud terminal' },
    ],
  });
});

// daily credit balance for the signed-in user
app.get('/api/credits', requireUser, async (c) => {
  const user = c.get('user');
  const day = new Date().toISOString().slice(0, 10);
  const bal = await personalBalance(user, day);
  const myTeams = await store.myTeams(user.name);
  const first = myTeams[0] || null;
  let team = null;
  if (first) {
    const pool = await teamPool(first.id, day);
    team = {
      id: first.id,
      name: first.name,
      owner: first.owner,
      members: pool.memberCount,
      totalCredits: unitsToCredits(pool.totalUnits),
      usedCredits: unitsToCredits(pool.usedUnits),
      leftCredits: unitsToCredits(pool.leftUnits),
    };
  }
  return c.json({
    credits: {
      total: bal.totalCredits,
      used: unitsToCredits(bal.spent) + unitsToCredits(bal.earned),
      left: bal.leftCredits,
      day,
    },
    earned: unitsToCredits(bal.earned),
    team,
    teams: myTeams.map((t) => ({ id: t.id, name: t.name, owner: t.owner, members: Number(t.members || t.member_count || 0) })),
  });
});

// gift credits to another user (deducts daily grant first, then earnings;
// credits the recipient's lifetime earnings ledger so they can spend anytime)
app.post('/api/credits/gift', requireUser, async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const targetName = String(body.to || '').trim();
  const amountCredits = Number(body.amount);
  const day = new Date().toISOString().slice(0, 10);

  if (!targetName) return c.json({ error: 'recipient username required' }, 400);
  if (!Number.isFinite(amountCredits) || amountCredits <= 0) return c.json({ error: 'amount must be a positive number of credits' }, 400);
  const MAX = 10000;
  if (amountCredits > MAX) return c.json({ error: `max gift is ${MAX} credits` }, 400);
  if (targetName.toLowerCase() === user.name.toLowerCase()) return c.json({ error: 'gift to another user' }, 400);

  const recipient = await store.findUserByName(targetName);
  if (!recipient) return c.json({ error: `no user named "${targetName}"` }, 404);

  const units = creditsToUnits(amountCredits);
  const bal = await personalBalance(user, day);
  if (bal.leftUnits < units) {
    return c.json({
      error: `You only have ${bal.leftCredits} credits available right now. Earn more by getting visits to published apps, or bring your own Ollama API key (🔑) for unlimited use.`,
      credits: {
        total: bal.totalCredits,
        used: unitsToCredits(bal.spent) + unitsToCredits(bal.earned),
        left: bal.leftCredits,
        day,
      },
    }, 400);
  }

  // deduct daily grant first, then top up from earnings (same order as chat spend)
  const dailyLeft = bal.totalUnits - bal.spent;
  if (dailyLeft >= units) {
    await store.spendCredits(user.id, day, units);
  } else {
    if (dailyLeft > 0) await store.spendCredits(user.id, day, dailyLeft);
    await store.spendEarnings(user.name, units - dailyLeft);
  }
  await store.earnCredits(recipient.name, units);

  const after = await personalBalance(user, day);
  return c.json({
    ok: true,
    gift: { to: recipient.name, amount: unitsToCredits(units), day },
    credits: {
      total: after.totalCredits,
      used: unitsToCredits(after.spent) + unitsToCredits(after.earned),
      left: after.leftCredits,
      day,
    },
    earned: unitsToCredits(after.earned),
  });
});

// grant credits to the currently signed-in user (top-up for the WebSim port:
// the WebSim side collects payment / issues the grant, then calls this with
// the user's own aibuilder session token so only a valid session gets them).
app.post('/api/credits/grant', requireUser, async (c) => {
  // Operator-only top-up. Only callers holding the shared grant secret may
  // mint credits; without it the endpoint refuses (fail closed) so a signed-in
  // user cannot self-mint unlimited credits.
  const secret = getVar('CREDITS_GRANT_SECRET');
  const presented = String(
    c.req.header('x-credits-secret') || c.req.query('secret') || ''
  );
  if (!secret || presented !== secret || presented.length < 8) {
    return c.json({ error: 'grant requires the operator credit secret' }, 403);
  }
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  let units;
  if (body.units !== undefined && body.units !== null) {
    units = Math.floor(Number(body.units));
  } else {
    units = creditsToUnits(Math.floor(Number(body.credits ?? body.amount)));
  }
  const MAX_GRANT = 10000;
  if (!Number.isFinite(units) || units <= 0)
    return c.json({ error: 'grant a positive number of credits' }, 400);
  if (units > creditsToUnits(MAX_GRANT))
    return c.json({ error: `max grant is ${MAX_GRANT} credits per request` }, 400);

  await store.earnCredits(user.name, units);

  const day = new Date().toISOString().slice(0, 10);
  const bal = await personalBalance(user, day);
  return c.json({
    ok: true,
    granted: unitsToCredits(units),
    credits: {
      total: bal.totalCredits,
      used: unitsToCredits(bal.spent) + unitsToCredits(bal.earned),
      left: bal.leftCredits,
      day,
    },
    earned: unitsToCredits(bal.earned),
  });
});

// ---- teambuild: presence (who is building now + 10-person cap) -----------
app.post('/api/projects/:pid/presence', requireUser, async (c) => {
  const pid = c.req.param('pid');
  const project = await requireWrite(c, pid);
  if (project instanceof Response) return project;
  const body = await c.req.json().catch(() => ({}));
  const sid = String(body.sid || '').trim().slice(0, 64) || `cli:${crypto.randomUUID().slice(0, 12)}`;
  const res = await store.touchPresence(pid, sid, c.get('user').name, Date.now());
  return c.json({ active: res.active, accepted: res.accepted, present: res.present, limit: 10, sid });
});

app.post('/api/projects/:pid/presence/leave', requireUser, async (c) => {
  const pid = c.req.param('pid');
  const project = await requireWrite(c, pid);
  if (project instanceof Response) return project;
  const body = await c.req.json().catch(() => ({}));
  const sid = String(body.sid || '').slice(0, 64);
  if (sid) await store.leavePresence(pid, sid);
  return c.json({ ok: true });
});

// Owner/team only. This was auth:none, so anyone could poll it to learn who is
// actively editing a private project and when.
app.get('/api/projects/:pid/presence', async (c) => {
  const project = await requireRead(c, c.req.param('pid'));
  if (project instanceof Response) return project;
  const users = await store.presenceUsers(project.id);
  return c.json({ active: users.length, limit: 10, users });
});

// Mint a short-lived, project-scoped token so the owner can load a PRIVATE
// preview in an <iframe> / new tab, which cannot send the x-ab-sess header.
// Scoped to one project, ~15 min, and not a session: it grants read access to
// that project only and cannot be refreshed or reused elsewhere.
app.post('/api/projects/:pid/preview-token', requireUser, async (c) => {
  const project = await requireWrite(c, c.req.param('pid'));
  if (project instanceof Response) return project;
  const token = await mintPreviewToken(project.id, c.get('user').name);
  if (!token) return c.json({ error: 'preview tokens unavailable (no signing secret)' }, 503);
  return c.json({ token, expiresIn: 900 });
});



app.route('/api/models', models);

// ---- projects ----------------------------------------------------------------
// Owner-scoped. This used to be `store.listProjects()` with no auth at all,
// which returned every project in the database (SELECT *) -- any anonymous
// caller could enumerate ids and then read each one. Public discovery lives at
// /api/discover and is filtered to published projects server-side.
app.get('/api/projects', requireUser, async (c) =>
  c.json(await store.listProjectsByOwner(c.get('user').name)));

app.post('/api/projects', requireUser, async (c) => {
  const { name } = await c.req.json().catch(() => ({}));
  return c.json(await store.createProject(name, c.get('user').name), 201);
});

// Published projects are publicly readable (that's the point of the discovery
// feed); unpublished ones are owner/team only. This returned the file listing
// AND the last 100 chat messages for ANY project id to anyone, which is how a
// private app's source and its build conversation both leaked.
//
// The split matters: the chat log and the owner/team id columns stay behind the
// owner check even for a published project, so publishing shares the app, not
// the builder's conversation about it.
app.get('/api/projects/:pid', async (c) => {
  const project = await requireVisible(c, c.req.param('pid'));
  if (project instanceof Response) return project;
  const isOwner = await canRead(project, await actorOf(c));
  return c.json({
    project: isOwner ? project : publicProjectView(project),
    files: await store.listFiles(project.id),
    messages: isOwner ? await store.history(project.id, 100) : [],
  });
});

// raw file export for the terminal client (and external tooling) — full contents
// Owner-only: this is the full decrypted source of the project. It was the
// single most sensitive read in the API and required no credential at all.
app.get('/api/projects/:pid/export', async (c) => {
  const project = await requireRead(c, c.req.param('pid'));
  if (project instanceof Response) return project;
  const payload = {
    name: project.name,
    updated_at: project.updated_at || 0,
    files: await store.listFilesWithContent(project.id),
  };
  if (c.req.query('download') === '1') {
    const filename = `${project.name.replace(/[^a-z0-9_\-]+/gi, '_') || 'project'}.json`;
    c.header('Content-Disposition', `attachment; filename="${filename}"`);
    c.header('Content-Type', 'application/octet-stream');
  }
  return c.json(payload);
});

app.delete('/api/projects/:pid', requireUser, async (c) => {
  const pid = c.req.param('pid');
  const project = await requireWrite(c, pid);
  if (project instanceof Response) return project;
  await store.deleteProject(pid);
  return c.json({ ok: true });
});

app.post('/api/projects/:pid/rename', requireUser, async (c) => {
  const pid = c.req.param('pid');
  const project = await requireWrite(c, pid);
  if (project instanceof Response) return project;
  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name || '').trim().slice(0, 60);
  if (!name) return c.json({ error: 'name required' }, 400);
  try {
    return c.json(await store.rename(pid, name));
  } catch (e) {
    return c.json({ error: String(e.message || e) }, 404);
  }
});

// publish / unpublish to the discovery feed
app.post('/api/projects/:pid/publish', requireUser, async (c) => {
  const pid = c.req.param('pid');
  const project = await requireWrite(c, pid);
  if (project instanceof Response) return project;
  const body = await c.req.json().catch(() => ({}));
  const publish = body.publish !== false;
  const description = typeof body.description === 'string' ? body.description.slice(0, 300) : undefined;
  try {
    return c.json(await store.setPublished(pid, publish, description));
  } catch (e) {
    return c.json({ error: String(e.message || e) }, 400);
  }
});

// remix = copy a published app into a new editable project owned by the remixer
// Published-only. remix copies every source file into a new project the
// caller owns, so requiring only a session (as this did) meant ANY signed-in
// user could exfiltrate ANY private project by remixing it -- a one-request
// source-code leak that needed no enumeration first.
app.post('/api/projects/:pid/remix', requireUser, async (c) => {
  const src = await requirePublished(c, c.req.param('pid'));
  if (src instanceof Response) return src;
  return c.json(await store.remix(src.id, c.get('user').name), 201);
});

// ---- Phase 2: file version history & undo/redo -----------------------------
// list revisions of one file                 GET  /api/projects/:pid/versions?path=index.html
// fetch a specific revision's raw content    GET  /api/projects/:pid/versions?path=…&seq=N
const versionPath = (c) => String(c.req.query('path') || '').trim();
// Owner-only. Revision history is where rotated-away API keys and deleted
// secrets survive, so it inherits full project privacy -- publishing does not
// expose it.
app.get('/api/projects/:pid/versions', async (c) => {
  const pid = c.req.param('pid');
  const fpath = versionPath(c);
  if (!fpath) return c.json({ error: 'path query required' }, 400);
  const project = await requireRead(c, pid);
  if (project instanceof Response) return project;
  const seq = Number(c.req.query('seq')) || 0;
  if (seq) {
    const v = await store.getFileVersion(pid, fpath, seq);
    if (!v) return c.json({ error: 'version not found' }, 404);
    return c.json(v);
  }
  return c.json(await store.fileVersions(pid, fpath));
});

// restore a specific revision of one file (undo/redo per file)
app.post('/api/projects/:pid/restore-version', requireUser, async (c) => {
  const pid = c.req.param('pid');
  const project = await requireWrite(c, pid);
  if (project instanceof Response) return project;
  const body = await c.req.json().catch(() => ({}));
  const fpath = String(body.path || '').trim();
  const seq = Number(body.seq) || 0;
  if (!fpath || !seq) return c.json({ error: 'path and seq required' }, 400);
  try {
    return c.json(await store.restoreFileVersion(pid, fpath, seq));
  } catch (e) {
    return c.json({ error: String(e.message || e) }, 400);
  }
});

// ---- Phase 2: project snapshots --------------------------------------------
app.get('/api/projects/:pid/snapshots', async (c) => {
  const project = await requireRead(c, c.req.param('pid'));
  if (project instanceof Response) return project;
  return c.json(await store.listSnapshots(project.id));
});

app.post('/api/projects/:pid/snapshots', requireUser, async (c) => {
  const pid = c.req.param('pid');
  const project = await requireWrite(c, pid);
  if (project instanceof Response) return project;
  const body = await c.req.json().catch(() => ({}));
  return c.json(await store.takeSnapshot(pid, String(body.label || '').trim()), 201);
});

// Owner-only, and note the original bug: it looked the snapshot up by
// (pid, sid) with no project check at all, so it did not even verify the
// snapshot belonged to a real project.
app.get('/api/projects/:pid/snapshots/:sid', async (c) => {
  const project = await requireRead(c, c.req.param('pid'));
  if (project instanceof Response) return project;
  const s = await store.getSnapshot(project.id, c.req.param('sid'));
  if (!s) return c.json({ error: 'not found' }, 404);
  return c.json(s);
});

// restore a whole project to a prior snapshot (roll back a bad generation)
app.post('/api/projects/:pid/snapshots/:sid/restore', requireUser, async (c) => {
  const pid = c.req.param('pid');
  const project = await requireWrite(c, pid);
  if (project instanceof Response) return project;
  try {
    return c.json(await store.restoreSnapshot(pid, c.req.param('sid')));
  } catch (e) {
    return c.json({ error: String(e.message || e) }, 400);
  }
});

// discovery feed
app.get('/api/discover', async (c) => c.json(await store.discover()));

// upload an existing app (multipart: repeatable field "files")
app.post('/api/projects/:pid/upload', requireUser, async (c) => {
  const project = await requireWrite(c, c.req.param('pid'));
  if (project instanceof Response) return project;

  let form;
  try {
    form = await c.req.parseBody({ all: true });
  } catch {
    return c.json({ error: 'expected multipart/form-data' }, 400);
  }

  let incoming = [];
  for (const v of Object.values(form)) {
    for (const item of Array.isArray(v) ? v : [v]) {
      if (item && typeof item === 'object' && typeof item.arrayBuffer === 'function') {
        incoming.push(item);
      }
    }
  }
  incoming = incoming.slice(0, 300);
  if (!incoming.length) return c.json({ error: 'no files received' }, 400);

  // If every file shares one first segment ("myapp/index.html", …), strip it so
  // the app root maps directly onto the project root.
  const cleaned = incoming.map(f => cleanUploadPath(f.name || ''));
  const firstSegs = new Set(cleaned.filter(Boolean).map(n => n.split('/')[0]));
  const stripRoot = cleaned.every(n => n.includes('/')) && firstSegs.size === 1;

  const saved = [];
  const skipped = [];
  for (let i = 0; i < incoming.length; i++) {
    let rel = cleaned[i];
    if (!rel) { skipped.push('(invalid name)'); continue; }
    if (stripRoot) rel = rel.split('/').slice(1).join('/') || `file-${i + 1}.txt`;
    if ((incoming[i].size || 0) > 2 * 1024 * 1024) { skipped.push(rel); continue; }
    const buf = new Uint8Array(await incoming[i].arrayBuffer());
    await store.saveFile(project.id, rel, toBase64(buf), 'base64');
    saved.push(rel);
  }
  return c.json({ ok: true, saved, skipped });
});

function cleanUploadPath(name) {
  const segs = String(name).replace(/\\/g, '/').split('/')
    .filter(s => s && s !== '.' && s !== '..');
  return segs.slice(0, 8).join('/').slice(0, 200);
}

app.route('/', auth);
app.route('/api/chat', chat);
app.route('/', live);
app.route('/api/baas', baas);
app.route('/api/v2', v2);
app.route('/', teams);
app.route('/', features);
app.route('/api/forum', forum);
app.route('/api/terminal', terminal);
app.route('/api/server', serverApi);
app.route('/api/kterm', kterm);
app.route('/api/internal/agent', agentBridge);
app.route('/preview', preview);

// 404s: API callers get a JSON error, browsers get a simple page
app.notFound((c) => {
  const accept = c.req.header('accept') || '';
  if (accept.includes('text/html')) {
    return c.html(
      `<!doctype html><meta charset="utf-8"><title>aibuilder — not found</title>` +
      `<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui;background:#0d1117;color:#e6edf3;display:grid;place-items:center;min-height:100vh;padding:2rem}div{text-align:center}h1{font-size:1.6rem;margin-bottom:.6rem}p{color:#8b949e}a{color:#58a6ff;text-decoration:none}</style>` +
      `<div><h1>404 — not found</h1><p>Nothing lives at this path.</p><a href="${GITHUB_URL}">GitHub</a></div>`,
      404,
    );
  }
  return c.json({ error: '404 not found', github: GITHUB_URL }, 404);
});

app.onError((err, c) => {
  console.error('route error:', (err && err.stack) || err);
  return c.json({ error: 'Internal Server Error', detail: String((err && err.message) || err).slice(0, 300) }, 500);
});

// BaaS SDK for generated apps (absolute path so any page depth can load it)
app.get('/__baas.js', (c) =>
  c.text(BAAS_SDK_JS, 200, { 'content-type': 'application/javascript; charset=utf-8' })
);
