import { Hono } from 'hono';
import { getVar } from './env.js';
import { requireUser } from './auth.js';
import { store } from './store.js';

// Dedicated cloud terminal for the AI. The worker proxies shell commands to a
// small daemon running on an always-free VM (GCP e2-micro / Oracle Always Free),
// exposed through a Cloudflare Tunnel (see terminald/server.mjs header).
// Wire it up in wrangler.toml: TERMINAL_URL (e.g. https://term.example.com) +
// TERMINAL_TOKEN. Until configured, /api/terminal reports enabled:false and
// chat CMD blocks degrade gracefully.
// Set LOCAL_TERMINAL=1 in .env (local dev) to run commands on the host machine
// instead of the cloud daemon — useful for local development and testing.
//
// Every project is sandboxed to its own dedicated folder on the terminal:
//   sandbox root/projects/<pid>/  — commands run here, writes are jailed here.
// Keeping them under a shared `projects/` root means the AI's shell cwd is the
// project folder itself, so `ls -la` only ever shows the current project.
// Files are mirrored DB -> terminal before a build and synchronized back
// terminal -> DB after it (see mirrorToTerminal / syncTerminal).

const URL = () => String(getVar('TERMINAL_URL') || '').replace(/\/+$/, '');
const TOKEN = () => String(getVar('TERMINAL_TOKEN') || '');
// Lazy getter — must not be evaluated at import time because the .env loader
// in index.js runs after all imports (ESM import order).
const localTerminal = () => String(getVar('LOCAL_TERMINAL') || '');

export function terminalEnabled() {
  return Boolean(localTerminal() || (URL() && TOKEN()));
}
const LOCAL_SANDBOX = () => String(getVar('LOCAL_SANDBOX') || '/data/data/com.termux/files/usr/tmp/aibuilder-sandbox');
const MAX_CMD = 2000;
const MAX_OUT = 20000;
const MAX_FILES = 300;            // max mirrored files per project
const MAX_SIZE = 2 * 1024 * 1024; // max mirrored file size (bytes)

// node:fs / node:path / node:child_process are NOT available in the Workers
// runtime, so they are imported lazily and only reached in the local branch.
let _fs = null, _path = null, _cp = null;
async function nodeTools() {
  if (!_fs) {
    _fs = await import('node:fs');
    _path = await import('node:path');
    _cp = await import('node:child_process');
  }
  return { fs: _fs, path: _path, cp: _cp };
}

// Resolve a project's dedicated sandbox folder. Returns null for hostile pids.
async function sandboxDir(pid) {
  const { path } = await nodeTools();
  const SANDBOX = path.resolve(LOCAL_SANDBOX());
  const PROJECTS = path.join(SANDBOX, 'projects');
  const safePid = String(pid || 'default').replace(/[^a-zA-Z0-9._-]/g, '');
  const dir = path.resolve(path.join(PROJECTS, safePid));
  if (dir !== PROJECTS && !dir.startsWith(PROJECTS + '/')) return null;
  return dir;
}

// Reject attempts to WRITE anywhere outside the project sandbox. Reads (cat,
// curl, git) are allowed — the jail is about "putting files in their own
// dedicated location", not about hiding the system. Returns a denial reason
// or null. The cloud daemon re-checks the same policy server-side.
export function jailError(cmd, cwd) {
  const tokens = cmd.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[12]>>?|>>?|[&|;()<>]|[^\s;"'|&()<>]+/g) || [];
  const ALLOW = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/zero', '/dev/urandom', '/dev/full']);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!/^[12]?>>?$/.test(tok)) continue;
    let j = i + 1;
    while (j < tokens.length && (tokens[j] === '&' || /^&\d+$/.test(tokens[j]))) j++;
    if (j >= tokens.length) continue;
    const dest = tokens[j].replace(/^["']|["']$/g, '');
    i = j;
    if (!dest || dest.startsWith('&')) continue;
    if (ALLOW.has(dest)) continue;
    const base = cwd.endsWith('/') ? cwd.slice(0, -1) : cwd;
    const raw = dest.startsWith('/')
      ? dest
      : dest.startsWith('~/')
        ? base + '/' + dest.slice(2)
        : base + '/' + dest;
    const stack = [];
    for (const s of raw.split('/')) {
      if (!s || s === '.') continue;
      if (s === '..') { if (stack.length) stack.pop(); else stack.push('..'); }
      else stack.push(s);
    }
    const norm = '/' + stack.join('/');
    if (norm !== base && !norm.startsWith(base + '/')) {
      return `write outside the project sandbox blocked: > ${dest}`;
    }
  }
  if (/\brm\s+(-[A-Za-z0-9]+[ ]+)*\/([^ ]|$)/.test(cmd)) return 'destructive rm on an absolute path blocked';
  if (/^chmod\s+[0-7]+\s*\/[^ ]/.test(cmd)) return 'chmod on an absolute path blocked';
  if (/\b(mkfs|fdisk|dd\s+if=[^ ]+of=[^ ]+)\b/i.test(cmd)) return 'destructive disk-level command blocked';
  return null;
}

// ---- local sandbox filesystem ops (LOCAL_TERMINAL branch) ---------------

async function lsSandbox(dir, base = '') {
  const { fs, path } = await nodeTools();
  let ents;
  try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const ent of ents) {
    const rel = base ? `${base}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...(await lsSandbox(path.join(dir, ent.name), rel)));
    else if (ent.isFile()) {
      try {
        const st = await fs.stat(path.join(dir, ent.name));
        if (st.size > MAX_SIZE) continue;
        const content = await fs.readFile(path.join(dir, ent.name), 'utf8');
        if (/[\0]/.test(content)) continue;
        out.push({ path: rel, content });
      } catch { /* unreadable — skip */ }
    }
  }
  return out;
}

// ---- public API ----------------------------------------------------------

// Mirror the given DB files (path -> content) into the project's sandbox,
// then return a snapshot Map used by syncTerminal(). Only utf8 text is
// mirrored (binary assets stay DB-side; the AI manages those with
// create_asset). Returns null when the terminal is disabled.
export async function mirrorToTerminal(pid, files) {
  if (!terminalEnabled() || !Array.isArray(files) || !files.length) return null;
  const snapshot = new Map();
  const clean = [];
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || f.path.startsWith('/') || f.path.includes('..')) continue;
    if (f.encoding && f.encoding !== 'utf8') continue;
    if (typeof f.content !== 'string' || f.content.length > MAX_SIZE || /[\0]/.test(f.content)) continue;
    clean.push({ path: f.path, content: f.content });
    snapshot.set(f.path, f.content);
    if (clean.length >= MAX_FILES) break;
  }
  if (!clean.length) return snapshot;
  if (localTerminal()) {
    const { fs, path } = await nodeTools();
    const dir = await sandboxDir(pid);
    if (!dir) return null;
    for (const { path: rel, content } of clean) {
      const abs = path.resolve(dir, rel);
      if (abs !== dir && !abs.startsWith(dir + '/')) continue;
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
  } else {
    if (await daemonWrite('/mirror', { pid, files: clean }, 'mirror') === null) return null;
  }
  return snapshot;
}

// Read the terminal's sandbox and reconcile against `snapshot` (mirror-time
// DB state). Returns { created, updated, deleted, files } where files is the
// current sandbox listing. Returns null when disabled or on daemon failure.
export async function readTerminalFiles(pid, snapshot) {
  if (!terminalEnabled() || !snapshot) return null;
  let entries = null;
  if (localTerminal()) {
    const dir = await sandboxDir(pid);
    if (!dir) return null;
    entries = await lsSandbox(dir);
  } else {
    entries = await daemonRead('/files', { pid });
  }
  return entries || [];
}

// Push created/updated files and deletions back to the DB. `blobs` is what
// readTerminalFiles returned, `snapshot` is the mirror-time state. Returns
// { created, updated, deleted } lists for the caller to surface as events.
export function diffTerminal(blobs, snapshot) {
  const seen = new Set();
  const updated = [];
  const created = [];
  for (const e of blobs || []) {
    seen.add(e.path);
    const before = snapshot.get(e.path);
    if (before !== undefined) {
      if (before !== e.content) updated.push(e);
    } else {
      created.push(e);
    }
  }
  const deleted = [];
  for (const p of snapshot.keys()) {
    if (!seen.has(p)) deleted.push(p);
  }
  return { created, updated, deleted, changed: created.length + updated.length + deleted.length };
}

async function applyTerminalDeletes(pid, deleted) {
  if (!deleted || !deleted.length) return;
  if (localTerminal()) {
    const { fs, path } = await nodeTools();
    const dir = await sandboxDir(pid);
    if (!dir) return;
    for (const rel of deleted) {
      if (rel.startsWith('/') || rel.includes('..')) continue;
      try { fs.rmSync(path.resolve(dir, rel), { force: true }); } catch { /* already gone */ }
    }
  } else {
    await daemonWrite('/unlink', { pid, paths: deleted }, 'unlink');
  }
}

async function daemonWrite(urlPath, body, what) {
  try {
    const r = await fetch(`${URL()}${urlPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TOKEN(), ...body }),
    });
    const txt = (await r.text()) || '';
    let j = null;
    try { j = JSON.parse(txt); } catch { /* not json */ }
    return j && j.ok !== false ? true : null;
  } catch {
    return null;
  }
}

async function daemonRead(urlPath, body) {
  try {
    const q = new URLSearchParams({ token: TOKEN(), ...Object.fromEntries(Object.entries(body || {}).map(([k, v]) => [k, String(v)])) });
    const r = await fetch(`${URL()}${urlPath}?${q}`);
    const txt = (await r.text()) || '';
    let j = null;
    try { j = JSON.parse(txt); } catch { /* not json */ }
    return j && j.ok !== false && Array.isArray(j.files) ? j.files : null;
  } catch {
    return null;
  }
}

export async function execCommand(pid, cmd, opts = {}) {
  if (!terminalEnabled()) return { enabled: false };

  // --- LOCAL_TERMINAL: spawn directly on the host (local dev / Termux only) ---
  // In production the Workers runtime has no node:child_process; LOCAL_TERMINAL
  // is never set there, so this branch is unreachable in Cloudflare.
  if (localTerminal()) {
    const { fs, cp } = await nodeTools();
    const dir = await sandboxDir(pid);
    if (!dir) return { ok: false, error: 'bad pid' };
    const cwd = dir;
    const safe = String(cmd || '').slice(0, MAX_CMD);
    const jail = jailError(safe, cwd);
    if (jail) return { ok: false, code: 1, output: '', error: jail };
    fs.mkdirSync(cwd, { recursive: true });
    const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || 30000);
    return new Promise((resolvePromise) => {
      let out = '';
      const started = Date.now();
      const child = cp.spawn('/bin/sh', ['-c', safe], {
        cwd,
        env: { ...process.env, HOME: cwd },
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.stdout.on('data', (d) => { if (out.length < MAX_OUT) out += d.toString().slice(0, MAX_OUT - out.length); });
      child.stderr.on('data', (d) => { if (out.length < MAX_OUT) out += d.toString().slice(0, MAX_OUT - out.length); });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolvePromise({ ok: code === 0, code, output: out, error: null });
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        resolvePromise({ ok: false, code: 1, output: '', error: String(e.message) });
      });
    });
  }

  // --- Cloud terminal daemon (production) ---
  const body = {
    token: TOKEN(),
    pid: String(pid || '').slice(0, 40),
    cmd: String(cmd || '').slice(0, MAX_CMD),
    cwd: String(opts.cwd || ''),
    timeoutMs: Math.max(1000, Number(opts.timeoutMs) || 30000),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), body.timeoutMs + 5000);
  try {
    const r = await fetch(`${URL()}/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = (await r.text()) || '';
    let j = null;
    try { j = JSON.parse(text); } catch { /* not json */ }
    if (!r.ok || !j || typeof j !== 'object') {
      return { ok: false, error: `terminal daemon error (${r.status})`, output: text.slice(0, MAX_OUT), code: null };
    }
    return {
      ok: j.ok !== false,
      code: Number.isInteger(j.code) ? j.code : null,
      output: String(j.output || '').slice(0, MAX_OUT),
      error: j.error || null,
    };
  } catch (e) {
    return { ok: false, error: `terminal unreachable: ${String(e?.message || e)}` };
  } finally {
    clearTimeout(timer);
  }
}

export const terminal = new Hono();

terminal.get('/status', (c) => c.json({ enabled: terminalEnabled() }));

terminal.post('/exec', requireUser, async (c) => {
  const { pid, cmd, cwd, timeoutMs } = await c.req.json().catch(() => ({}));
  if (!terminalEnabled()) return c.json({ error: 'terminal not configured', enabled: false }, 503);
  if (!cmd || typeof cmd !== 'string') return c.json({ error: 'cmd (string) is required' }, 400);
  if (!pid || typeof pid !== 'string') return c.json({ error: 'pid (string) is required' }, 400);
  // Mirror the project's stored files into its sandbox so the shell sees exactly
  // the current project, run the command, then reconcile the DB with anything it
  // created/changed/deleted (so in-app terminal edits persist like the AI's do).
  let snapshot = null;
  try { snapshot = await mirrorToTerminal(pid, await store.listFilesWithContent(pid)); } catch { snapshot = null; }
  const res = await execCommand(pid, cmd, { cwd, timeoutMs });
  let sync = null;
  if (snapshot) {
    try {
      const blobs = await readTerminalFiles(pid, snapshot);
      if (blobs) {
        const d = diffTerminal(blobs, snapshot);
        for (const f of d.created) await store.saveFile(pid, f.path, f.content).catch(() => {});
        for (const f of d.updated) await store.saveFile(pid, f.path, f.content).catch(() => {});
        for (const p of d.deleted) await store.deleteFile(pid, p).catch(() => {});
        sync = { created: d.created.map((f) => f.path), updated: d.updated.map((f) => f.path), deleted: d.deleted };
      }
    } catch { sync = null; }
  }
  const out = sync ? { ...res, sync } : res;
  return c.json(out, res.ok ? 200 : 502);
});

// ---- generated-app dedicated servers -------------------------------------
// Generated apps call creat.serve(...). Every request carries the signed-in
// user's session (requireUser), then proxies to the terminal daemon: /serve
// manages long-running processes and /srv reverse-proxies HTTP + WebSocket
// traffic to the chosen server's loopback port. Server processes are
// ephemeral — apps must persist state with the database/multiplayer SDKs.

async function daemonServe(method, path, { body, query } = {}) {
  if (!terminalEnabled()) return { status: 503, json: { error: 'terminal not configured', enabled: false } };
  let url = `${URL()}${path}`;
  let init;
  if (method === 'GET') {
    url += `?${new URLSearchParams({ token: TOKEN(), ...(query || {}) })}`;
    init = { method };
  } else {
    init = { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN(), ...(body || {}) }) };
  }
  try {
    const r = await fetch(url, init);
    const txt = (await r.text()) || '';
    let j = null;
    try { j = JSON.parse(txt); } catch { /* not json */ }
    return { status: r.status, json: j || { error: txt.slice(0, 300) } };
  } catch (e) {
    return { status: 502, json: { error: `terminal unreachable: ${String(e?.message || e)}` } };
  }
}

export const serverApi = new Hono();
serverApi.use('*', requireUser);

serverApi.get('/:pid', async (c) => {
  const r = await daemonServe('GET', '/serve', { query: { pid: c.req.param('pid') } });
  return c.json(r.json, r.status);
});

serverApi.post('/:pid/start', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const r = await daemonServe('POST', '/serve', {
    body: { pid: c.req.param('pid'), name: String(b.name || '').toLowerCase(), cmd: b.command || b.cmd || '' },
  });
  return c.json(r.json, r.status);
});

serverApi.post('/:pid/stop', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const r = await daemonServe('POST', '/serve/stop', { body: { pid: c.req.param('pid'), name: String(b.name || '').toLowerCase() } });
  return c.json(r.json, r.status);
});

serverApi.get('/:pid/:name/logs', async (c) => {
  const r = await daemonServe('GET', '/serve/logs', { query: { pid: c.req.param('pid'), name: c.req.param('name') } });
  return c.json(r.json, r.status);
});

// Catch-all HTTP + WebSocket reverse proxy. `new Request(target, c.req.raw)`
// forwards method, headers and body; for an Upgrade request Cloudflare passes
// the 101 handshake straight through to the daemon.
serverApi.all('/*', async (c) => {
  if (!terminalEnabled()) return c.json({ error: 'terminal not configured', enabled: false }, 503);
  const m = c.req.path.match(/^\/api\/server\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (!m) return c.json({ error: 'bad path' }, 400);
  const pid = m[1];
  const name = m[2].toLowerCase();
  const rest = m[3] || '/';
  const qs = new URL(c.req.url).search;
  const target = `${URL()}/srv/${encodeURIComponent(pid)}/${encodeURIComponent(name)}${rest}${qs}`;
  try {
    return await fetch(new Request(target, c.req.raw));
  } catch (e) {
    return c.json({ error: `server unreachable: ${String(e?.message || e)}` }, 502);
  }
});