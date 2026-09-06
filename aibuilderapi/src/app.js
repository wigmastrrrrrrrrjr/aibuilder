import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { store } from './store.js';
import { chat } from './chat.js';
import { baas } from './baas.js';
import { preview, BAAS_SDK_JS } from './preview.js';
import { models, FREE_DAILY_CREDITS, creditsToUnits, unitsToCredits } from './models.js';
import { getVar } from './env.js';
import { builtinKey } from './keys.js';
import { toBase64 } from './base64.js';
import { live } from './live.js';
import { auth, requireUser, canWrite } from './auth.js';
import { teams } from './teams.js';
import { features } from './features.js';
import { teamPool, personalBalance } from './credits.js';
import { fn } from './fn.js';
import { rateLimit } from './rate-limit.js';
import { blockDatacenterIps } from './vpn-block.js';

const GITHUB_URL = 'https://github.com/wigmastrrrrrrrrjr/aibuilder';

export const app = new Hono();

// CORS so web/ can be hosted separately (Pages) from this API (Worker)
const allowedOrigins = [
  'https://websim.com',
  'https://websim.com/@Somonedcoopee/freechat',
  'http://localhost',
  'http://127.0.0.1',
  'https://aibuilderapi.csomeone301.workers.dev'
];
const BLOCK_MSG = 'nice try script kiddy this won\'t work!';

// Only the allowed page origins may call this API from a browser. Requests
// with a disallowed Origin get the block message; requests with no Origin
// (same-origin, non-browser tooling) pass through. Add more with the
// ALLOWED_ORIGINS env var (comma-separated).
function originAllowed(origin) {
  if (!origin) return true;
  const set = new Set(DEFAULT_ALLOWED_ORIGINS);
  for (const o of (getVar('ALLOWED_ORIGINS') || '').split(',').map((s) => s.trim()).filter(Boolean)) set.add(o);
  let host = origin;
  try {
    const u = new URL(origin);
    host = `${u.protocol}//${u.hostname}`;
  } catch { /* keep raw value */ }
  return set.has(origin) || set.has(host);
}

app.use('*', async (c, next) => {
  const origin = c.req.header('origin');
  if (origin && !originAllowed(origin)) {
    return c.text(BLOCK_MSG, 403, {
      'content-type': 'text/plain; charset=utf-8',
      'access-control-allow-origin': origin,
      'cache-control': 'no-store',
    });
  }
  return next();
});

  app.use('*', cors({
    origin: (origin) => (originAllowed(origin) ? origin || '*' : null),
    allowMethods: ['GET', 'HEAD', 'PUT', 'POST', 'DELETE', 'PATCH', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'x-ab-sess', 'x-recaptcha-token', 'x-api-key'],
    exposeHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'Retry-After'],
  }));

// ---- VPN / datacenter IP block -----------------------------------------------
// Auth endpoints stay reachable from VPN/mobile/datacenter IPs so users can
// always log in / sign up; the block protects the remaining API surface.
app.use('/api/*', async (c, next) => {
  if (c.req.path.startsWith('/api/auth') || c.req.path.startsWith('/api/credits')) return next();
  return blockDatacenterIps()(c, next);
});

// ---- rate limits ------------------------------------------------------------
const DAY = 86400000;
const MIN = 60000;
const globalLimit = rateLimit({ windowMs: DAY, max: 200 });   // 200 API calls/day per IP
const chatLimit   = rateLimit({ windowMs: MIN, max: 3000 });  // 3000 chats/min per IP
const authLimit   = rateLimit({ windowMs: MIN, max: 3 });     // 3 auth attempts/min per IP
const fnLimit     = rateLimit({ windowMs: DAY, max: 50 });    // 50 function calls/day per IP
const uploadLimit = rateLimit({ windowMs: MIN, max: 3 });     // 3 uploads/min per IP
const giftLimit   = rateLimit({ windowMs: MIN, max: 3 });     // 3 gifts/min per IP

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
    description: 'AI app builder backend. Only the WebSim page origin may call this API from a browser; any other Origin receives the block message.',
    baseUrl: base,
    allowedOrigins: DEFAULT_ALLOWED_ORIGINS,
    auth,
    streams: [
      { method: 'POST', path: '/api/chat', auth: 'user', format: 'text/event-stream (SSE)', body: { message: 'string (required)', projectId: 'string', model: 'string', apiKey: 'string', mode: "'workspace'" }, events: ['meta', 'token', 'think', 'file', 'edit', 'delete', 'rename', 'asset', 'plan', 'name', 'delegate', 'subagent', 'refactor', 'seed', 'run', 'warn', 'error', 'done'] },
    ],
    endpoints: [
      { method: 'GET', path: '/api/docs', auth: 'none', description: 'This documentation' },
      { method: 'GET', path: '/api/meta', auth: 'none', description: 'Model + key status' },
      { method: 'GET', path: '/api/models', auth: 'none', description: 'Model catalogue' },

      { method: 'GET', path: '/api/projects', auth: 'none', description: 'List projects' },
      { method: 'POST', path: '/api/projects', auth: 'user', body: { name: 'string' }, description: 'Create a project' },
      { method: 'GET', path: '/api/projects/:pid', auth: 'none', description: 'Project + files + recent messages' },
      { method: 'GET', path: '/api/projects/:pid/export', auth: 'none', description: 'Raw files (for terminal client / tooling)' },
      { method: 'DELETE', path: '/api/projects/:pid', auth: 'owner', description: 'Delete a project' },
      { method: 'POST', path: '/api/projects/:pid/rename', auth: 'owner', body: { name: 'string' }, description: 'Rename' },
      { method: 'POST', path: '/api/projects/:pid/publish', auth: 'owner', body: { publish: 'boolean', description: 'string' }, description: 'Publish / unpublish to discovery feed' },
      { method: 'POST', path: '/api/projects/:pid/remix', auth: 'user', description: 'Copy a published app into your own project' },
      { method: 'GET', path: '/api/projects/:pid/versions?path=<file>&seq=<n>', auth: 'none', description: 'File revision list, or one revision with seq' },
      { method: 'POST', path: '/api/projects/:pid/restore-version', auth: 'owner', body: { path: 'string', seq: 'number' }, description: 'Undo/redo a single file' },
      { method: 'GET', path: '/api/projects/:pid/snapshots', auth: 'none', description: 'List project snapshots' },
      { method: 'POST', path: '/api/projects/:pid/snapshots', auth: 'owner', body: { label: 'string' }, description: 'Take a snapshot' },
      { method: 'GET', path: '/api/projects/:pid/snapshots/:sid', auth: 'none', description: 'Snapshot + its files' },
      { method: 'POST', path: '/api/projects/:pid/snapshots/:sid/restore', auth: 'owner', description: 'Roll the whole project back' },
      { method: 'POST', path: '/api/projects/:pid/upload', auth: 'owner', body: 'multipart "files" (repeatable)', description: 'Upload existing files (max 300, 2MB each)' },
      { method: 'POST', path: '/api/projects/:pid/presence', auth: 'user', body: { sid: 'string' }, description: 'Join presence (10-person cap)' },
      { method: 'POST', path: '/api/projects/:pid/presence/leave', auth: 'user', body: { sid: 'string' }, description: 'Leave presence' },
      { method: 'GET', path: '/api/projects/:pid/presence', auth: 'none', description: 'Who is currently building' },

      { method: 'GET', path: '/api/discover', auth: 'none', description: 'Published-app discovery feed' },

      { method: 'GET', path: '/api/credits', auth: 'user', description: 'Daily credit balance + teams' },
      { method: 'POST', path: '/api/credits/gift', auth: 'user', body: { to: 'string', amount: 'number' }, description: 'Gift credits (max 10000)' },

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

      { method: 'POST', path: '/api/projects/:pid/live/:room/push', auth: 'none', body: { data: 'any' }, description: 'Append realtime event' },
      { method: 'GET', path: '/api/projects/:pid/live/:room?since=<seq>&limit=<n>', auth: 'none', description: 'Poll realtime events (browsers normally use SSE — see live.js)' },
      { method: 'POST', path: '/api/projects/:pid/chat/send', auth: 'none', body: { room: 'string', text: 'string' }, description: 'Room chat message' },
      { method: 'GET', path: '/api/projects/:pid/chat/list?room=<r>&since=<seq>&limit=<n>', auth: 'none', description: 'Room chat history' },

      { method: 'POST', path: '/api/projects/:pid/fn/:name', auth: 'none', body: { input: 'any' }, description: 'Run functions/<name>.js (pure computation, 1.5s cap)' },

      { method: 'GET', path: '/api/baas/:pid/:coll', auth: 'none', description: 'BaaS list rows' },
      { method: 'POST', path: '/api/baas/:pid/:coll', auth: 'none', body: 'row fields', description: 'BaaS insert' },
      { method: 'GET', path: '/api/baas/:pid/:coll/:id', auth: 'none', description: 'BaaS get row' },
      { method: 'PUT', path: '/api/baas/:pid/:coll/:id', auth: 'none', body: 'patch fields', description: 'BaaS merge-patch row' },
      { method: 'DELETE', path: '/api/baas/:pid/:coll/:id', auth: 'none', description: 'BaaS delete row' },

      { method: 'GET', path: '/preview/:projectId/*', auth: 'none', description: 'Serve a generated app with the BaaS SDK injected' },
      { method: 'GET', path: '/__baas.js', auth: 'none', description: 'Client SDK for generated apps (window.creat.db)' },
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

// ---- teambuild: presence (who is building now + 10-person cap) -----------
app.post('/api/projects/:pid/presence', requireUser, async (c) => {
  const pid = c.req.param('pid');
  const project = await store.getProject(pid);
  if (!project) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const sid = String(body.sid || '').trim().slice(0, 64) || `cli:${crypto.randomUUID().slice(0, 12)}`;
  const res = await store.touchPresence(pid, sid, c.get('user').name, Date.now());
  return c.json({ active: res.active, accepted: res.accepted, present: res.present, limit: 10, sid });
});

app.post('/api/projects/:pid/presence/leave', requireUser, async (c) => {
  const pid = c.req.param('pid');
  const body = await c.req.json().catch(() => ({}));
  const sid = String(body.sid || '').slice(0, 64);
  if (sid) await store.leavePresence(pid, sid);
  return c.json({ ok: true });
});

app.get('/api/projects/:pid/presence', async (c) => {
  const pid = c.req.param('pid');
  if (!(await store.getProject(pid))) return c.json({ error: 'not found' }, 404);
  const users = await store.presenceUsers(pid);
  return c.json({ active: users.length, limit: 10, users });
});



app.route('/api/models', models);

// ---- projects ----------------------------------------------------------------
app.get('/api/projects', async (c) => c.json(await store.listProjects()));

app.post('/api/projects', requireUser, async (c) => {
  const { name } = await c.req.json().catch(() => ({}));
  return c.json(await store.createProject(name, c.get('user').name), 201);
});

app.get('/api/projects/:pid', async (c) => {
  const project = await store.getProject(c.req.param('pid'));
  if (!project) return c.json({ error: 'not found' }, 404);
  return c.json({
    project,
    files: await store.listFiles(project.id),
    messages: await store.history(project.id, 100),
  });
});

// raw file export for the terminal client (and external tooling) — full contents
app.get('/api/projects/:pid/export', async (c) => {
  const project = await store.getProject(c.req.param('pid'));
  if (!project) return c.json({ error: 'not found' }, 404);
  return c.json({
    name: project.name,
    updated_at: project.updated_at || 0,
    files: await store.listFilesWithContent(project.id),
  });
});

app.delete('/api/projects/:pid', requireUser, async (c) => {
  const pid = c.req.param('pid');
  const project = await store.getProject(pid);
  if (!project) return c.json({ error: 'not found' }, 404);
  if (!(await canWrite(project, c.get('user')))) return c.json({ error: "you don't own this project" }, 403);
  await store.deleteProject(pid);
  return c.json({ ok: true });
});

app.post('/api/projects/:pid/rename', requireUser, async (c) => {
  const pid = c.req.param('pid');
  const project = await store.getProject(pid);
  if (!project) return c.json({ error: 'not found' }, 404);
  if (!(await canWrite(project, c.get('user')))) return c.json({ error: "you don't own this project" }, 403);
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
  const project = await store.getProject(pid);
  if (!project) return c.json({ error: 'not found' }, 404);
  if (!(await canWrite(project, c.get('user')))) return c.json({ error: "you don't own this project" }, 403);
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
app.post('/api/projects/:pid/remix', requireUser, async (c) => {
  const src = await store.getProject(c.req.param('pid'));
  if (!src) return c.json({ error: 'not found' }, 404);
  return c.json(await store.remix(src.id, c.get('user').name), 201);
});

// ---- Phase 2: file version history & undo/redo -----------------------------
// list revisions of one file                 GET  /api/projects/:pid/versions?path=index.html
// fetch a specific revision's raw content    GET  /api/projects/:pid/versions?path=…&seq=N
const versionPath = (c) => String(c.req.query('path') || '').trim();
app.get('/api/projects/:pid/versions', async (c) => {
  const pid = c.req.param('pid');
  const fpath = versionPath(c);
  if (!fpath) return c.json({ error: 'path query required' }, 400);
  if (!(await store.getProject(pid))) return c.json({ error: 'not found' }, 404);
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
  const project = await store.getProject(pid);
  if (!project) return c.json({ error: 'not found' }, 404);
  if (!(await canWrite(project, c.get('user')))) return c.json({ error: "you don't own this project" }, 403);
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
  const pid = c.req.param('pid');
  if (!(await store.getProject(pid))) return c.json({ error: 'not found' }, 404);
  return c.json(await store.listSnapshots(pid));
});

app.post('/api/projects/:pid/snapshots', requireUser, async (c) => {
  const pid = c.req.param('pid');
  const project = await store.getProject(pid);
  if (!project) return c.json({ error: 'not found' }, 404);
  if (!(await canWrite(project, c.get('user')))) return c.json({ error: "you don't own this project" }, 403);
  const body = await c.req.json().catch(() => ({}));
  return c.json(await store.takeSnapshot(pid, String(body.label || '').trim()), 201);
});

app.get('/api/projects/:pid/snapshots/:sid', async (c) => {
  const pid = c.req.param('pid');
  const s = await store.getSnapshot(pid, c.req.param('sid'));
  if (!s) return c.json({ error: 'not found' }, 404);
  return c.json(s);
});

// restore a whole project to a prior snapshot (roll back a bad generation)
app.post('/api/projects/:pid/snapshots/:sid/restore', requireUser, async (c) => {
  const pid = c.req.param('pid');
  const project = await store.getProject(pid);
  if (!project) return c.json({ error: 'not found' }, 404);
  if (!(await canWrite(project, c.get('user')))) return c.json({ error: "you don't own this project" }, 403);
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
  const project = await store.getProject(c.req.param('pid'));
  if (!project) return c.json({ error: 'not found' }, 404);
  if (!(await canWrite(project, c.get('user')))) return c.json({ error: "you don't own this project" }, 403);

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

app.use('/api/auth/*', authLimit);
app.use('/api/chat', chatLimit);
app.use('/api/projects/*/fn/*', fnLimit);
app.use('/api/projects/*/upload', uploadLimit);
app.use('/api/credits/gift', giftLimit);
app.route('/', auth);
app.route('/api/chat', chat);
app.route('/', live);
app.route('/', fn);
app.route('/api/baas', baas);
app.route('/', teams);
app.route('/', features);
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
