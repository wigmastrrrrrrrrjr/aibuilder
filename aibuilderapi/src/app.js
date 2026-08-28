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
import { teamPool, personalBalance } from './credits.js';
import { fn } from './fn.js';
import { rateLimit } from './rate-limit.js';
import { blockDatacenterIps } from './vpn-block.js';

const FRONTEND_URL = 'https://wigmastrrrrrrrrjr.github.io/aibuilder/';

export const app = new Hono();

// CORS so web/ can be hosted separately (Pages) from this API (Worker)
  app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'HEAD', 'PUT', 'POST', 'DELETE', 'PATCH', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'x-ab-sess', 'x-recaptcha-token', 'x-api-key'],
    exposeHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'Retry-After'],
  }));

// ---- VPN / datacenter IP block -----------------------------------------------
// Auth endpoints stay reachable from VPN/mobile/datacenter IPs so users can
// always log in / sign up; the block protects the remaining API surface.
app.use('/api/*', async (c, next) => {
  if (c.req.path.startsWith('/api/auth') || c.req.path === '/api/credits') return next();
  return blockDatacenterIps()(c, next);
});

// ---- rate limits ------------------------------------------------------------
const DAY = 86400000;
const MIN = 60000;
const globalLimit = rateLimit({ windowMs: DAY, max: 200 });   // 200 API calls/day per IP
const chatLimit   = rateLimit({ windowMs: DAY, max: 30 });    // 30 chats/day per IP
const authLimit   = rateLimit({ windowMs: MIN, max: 3 });     // 3 auth attempts/min per IP
const fnLimit     = rateLimit({ windowMs: DAY, max: 50 });    // 50 function calls/day per IP
const uploadLimit = rateLimit({ windowMs: MIN, max: 3 });     // 3 uploads/min per IP

// ---- meta & models ----------------------------------------------------------
app.get('/api/meta', (c) =>
  c.json({
    model: getVar('OLLAMA_MODEL') || 'gemma4:31b',
    hasKey: Boolean(builtinKey()),
  })
);

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

// ---- global rate limit -------------------------------------------------------
// TEMP: test new endpoint
app.get('/api/debug-test', (c) => c.json({ ok: true }));;

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
app.route('/', auth);
app.route('/api/chat', chat);
app.route('/', live);
app.route('/', fn);
app.route('/api/baas', baas);
app.route('/', teams);
app.route('/preview', preview);

// 404s: API callers get JSON, browsers get bounced to the site with a notice
app.notFound((c) => {
  const accept = c.req.header('accept') || '';
  if (accept.includes('text/html')) {
    const to = `${FRONTEND_URL}?nf=${encodeURIComponent(c.req.path)}`;
    return c.html(
      `<!doctype html><meta charset="utf-8"><title>404 not found</title>` +
      `<meta http-equiv="refresh" content="0;url=${to}">` +
      `<body style="font-family:system-ui;background:#0d1117;color:#e6edf3;display:grid;place-items:center;height:100vh;margin:0">` +
      `<p>404 not found — taking you home…</p><script>location.replace(${JSON.stringify(to)})</script>`,
    );
  }
  return c.json({ error: '404 not found' }, 404);
});

// BaaS SDK for generated apps (absolute path so any page depth can load it)
app.get('/__baas.js', (c) =>
  c.text(BAAS_SDK_JS, 200, { 'content-type': 'application/javascript; charset=utf-8' })
);
