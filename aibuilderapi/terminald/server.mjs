// terminald — tiny daemon that hosts the AI's dedicated cloud terminal on an
// always-free VM (GCP e2-micro / Oracle Always Free). The Cloudflare Worker
// proxies every <<<CMD>>> block here; each project gets its own sandbox folder.
//
// Deploy (on your VM):
//   node server.mjs 3000 /var/term sandbox "SOME_LONG_SHARED_TOKEN"
//   # or env: PORT, SANDBOX, TERMINAL_TOKEN
//
// Put it behind HTTPS (Caddy/nginx + Public IP, or Cloudflare Tunnel) and set
// TERMINAL_URL / TERMINAL_TOKEN in the worker's wrangler.toml.

import http, { request as httpRequest } from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdirSync, statSync, readdirSync, readFileSync, unlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configure as configureAgent, agentRoute } from './agent.mjs';

const PORT = Number(process.env.PORT || process.argv[2] || 3000);
const SANDBOX = resolve(process.env.SANDBOX || process.argv[3] || '/var/term/sandbox');
const TOKEN = process.env.TERMINAL_TOKEN || process.argv[4] || 'change-me';
const MAX_OUT = 20000;   // caps a single command's captured output (bytes)
const MAX_CMD = 2000;
const MAX_FILES = 300;   // caps mirrored files per project
const MAX_SIZE = 2 * 1024 * 1024;

// Every project lives under <SANDBOX>/projects/<pid>/ so the AI's shell cwd is
// the project folder and `ls -la` only shows that project's files.
const PROJECTS = join(SANDBOX, 'projects');

function workspace(pid) {
  const dir = resolve(join(PROJECTS, String(pid || 'default').replace(/[^a-zA-Z0-9._-]/g, '')));
  if (dir !== PROJECTS && !dir.startsWith(PROJECTS + '/')) throw new Error('bad pid');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function safeSubPath(dir, rel) {
  if (typeof rel !== 'string' || rel.startsWith('/') || rel.includes('..') || /[\0]/.test(rel)) throw new Error('bad path');
  const abs = resolve(join(dir, rel));
  if (abs !== dir && !abs.startsWith(dir + '/')) throw new Error('bad path');
  return abs;
}

// Same containment policy as the worker (src/terminal.js:jailError). Every path
// a command mentions must resolve inside the project folder — deletes, writes
// and reads alike. Constructs that cannot be statically verified are blocked.
// Best-effort (POSIX shells are not fully analyzable), so it fails closed.
const JAIL_DEV = new Set([
  '/dev/null', '/dev/stdout', '/dev/stderr', '/dev/zero',
  '/dev/urandom', '/dev/random', '/dev/full', '/dev/tty',
]);

function resolveJailPath(raw, base) {
  let p;
  if (raw === '~' || raw.startsWith('~/')) p = base + raw.slice(1);
  else if (raw.startsWith('/')) p = raw;
  else p = base + '/' + raw;
  const stack = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (stack.length) stack.pop(); else return null; }
    else stack.push(seg);
  }
  return '/' + stack.join('/');
}

function jailError(cmd, cwd) {
  const base = String(cwd || '/').replace(/\/+$/, '') || '/';
  const src = String(cmd || '');
  const deny = (why) =>
    `blocked: ${why}. Nothing was executed. Every command must stay inside the project folder (your current directory) — use relative paths.`;

  if (/\$\(|`|<\(|>\(/.test(src)) return deny('command/process substitution is not allowed');
  if (/(^|[;&|({]|\b(?:then|do|else)\b)\s*(eval|exec|source)\b/.test(src)) return deny('eval/exec/source is not allowed');
  if (/(^|[;&|({]|\b(?:then|do|else)\b)\s*\.\s+\S/.test(src)) return deny('sourcing a script is not allowed');
  if (/(^|[^\w.])(system|popen|child_process|subprocess|os\.system)\s*\(/.test(src)) return deny('spawning a subprocess from inline code is not allowed');
  if (/(^|[;&|({]|\b(?:then|do|else)\b)\s*(sudo|doas|su|chroot|unshare|nsenter|mount|umount|pivot_root|setpriv)\b/.test(src)) return deny('privilege/escalation commands are not allowed');
  if (/\b(mkfs|mke2fs|fdisk|parted|wipefs|shred)\b/i.test(src)) return deny('disk-level commands are not allowed');
  if (/\bdd\b[^\n]*\bof=/.test(src)) return deny('dd writes are not allowed');
  const inlineEval = [
    /\b(node|bun|deno)\b[^\n]*\s(?:-e|--eval|-p|--print)(?:\s|=)/,
    /\bpython[0-9.]*\b[^\n]*\s-c(?:\s|$)/,
    /\b(perl|ruby)\b[^\n]*\s-[eE](?:\s|$)/,
    /\bphp\b[^\n]*\s-r(?:\s|$)/,
    /\b(sh|bash|zsh|dash|ksh)\b[^\n]*\s-c(?:\s|$)/,
  ];
  if (inlineEval.some((re) => re.test(src))) return deny('inline interpreter code cannot be verified (write a file and run it instead)');

  const tokens = src.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+/g) || [];
  for (let tok of tokens) {
    let quoted = false;
    if ((tok.startsWith('"') && tok.endsWith('"')) || (tok.startsWith("'") && tok.endsWith("'"))) {
      quoted = true; tok = tok.slice(1, -1);
    }
    if (!tok) continue;
    const asg = tok.match(/^[A-Za-z_][A-Za-z0-9_]*=(.*)$/);
    if (asg) tok = asg[1];
    if (!tok) continue;
    if (tok.startsWith('-') && tok !== '-') {
      const eq = tok.indexOf('=');
      if (eq === -1) continue;
      tok = tok.slice(eq + 1);
      if (!tok) continue;
    }
    if (tok === '-' || tok === '.') continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(tok)) continue;
    if (JAIL_DEV.has(tok)) continue;
    if (tok.startsWith('~') && tok !== '~' && !tok.startsWith('~/')) {
      return deny(`"${tok}" points outside the project folder`);
    }
    const pathish = tok.startsWith('/') || tok.startsWith('~') || tok === '..' || tok.startsWith('../') ||
                    (!quoted && tok.includes('/'));
    if (!pathish) continue;
    const resolved = tok.replace(/\$\{?HOME\}?/g, base).replace(/\$\{?PWD\}?/g, base);
    if (/[$`\\]/.test(resolved)) return deny(`cannot verify that "${tok}" stays inside the project`);
    const norm = resolveJailPath(resolved, base);
    if (!norm || (norm !== base && !norm.startsWith(base + '/'))) {
      return deny(`"${tok}" is outside the project folder`);
    }
  }
  return null;
}

// Drop symlinks inside the project whose targets escape it, so `rm -rf link/`
// or a write through a link can't reach outside via an in-project name.
function stripEscapingLinks(dir, base) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    const abs = join(dir, ent.name);
    if (ent.isSymbolicLink()) {
      let real = null;
      try { real = realpathSync(abs); } catch { /* dangling */ }
      if (!real || (real !== base && !real.startsWith(base + '/'))) {
        try { unlinkSync(abs); } catch { /* ignore */ }
      }
    } else if (ent.isDirectory()) {
      stripEscapingLinks(abs, base);
    }
  }
}

function run(cwd, cmd, timeoutMs) {
  return new Promise((resolvePromise) => {
    const jail = jailError(cmd, cwd);
    if (jail) return resolvePromise({ code: 1, output: jail, error: jail, blocked: true, ms: 0 });
    stripEscapingLinks(cwd, cwd);
    let out = '';
    const started = Date.now();
    const child = spawn('/bin/sh', ['-c', cmd], { cwd, env: { ...process.env, HOME: cwd } });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d) => { if (out.length < MAX_OUT) out += d.toString().slice(0, MAX_OUT - out.length); });
    child.stderr.on('data', (d) => { if (out.length < MAX_OUT) out += d.toString().slice(0, MAX_OUT - out.length); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, output: out, ms: Date.now() - started });
    });
    child.on('error', (e) => { clearTimeout(timer); resolvePromise({ code: 1, output: String(e.message), ms: Date.now() - started }); });
  });
}

// ---- dedicated servers: per-project long-running processes -----------------
// Generated apps can start their own HTTP server here (Node/Express/Python/…).
// Each gets a private loopback port; the worker proxies HTTP + WebSocket
// requests to it via /srv/<pid>/<name>/... .
//
// A server is never a direct child of the daemon: it runs under its own
// detached *supervisor* (supervisor.mjs — a second, auto-created terminal).
// The supervisor owns the process and restarts it with backoff when it crashes,
// so a bad server can't take down the terminal. Supervisors survive daemon
// restarts and are re-adopted from an on-disk manifest, so builds keep running.
// The daemon persists SERVER state itself; apps must still save durable data
// with the database/multiplayer SDKs.

const SERVERS = new Map();                 // `${pid}\0${name}` -> record
const USED_PORTS = new Set();
const USED_CTRL = new Set();
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SERVE_MIN = 41000, SERVE_MAX = 41999;
const CTRL_MIN = 42000, CTRL_MAX = 42999;
const SERVE_DIR = join(SANDBOX, '.servers');
const SUP_PATH = join(dirname(fileURLToPath(import.meta.url)), 'supervisor.mjs');

try { mkdirSync(SERVE_DIR, { recursive: true }); } catch { /* best effort */ }

function pickPort(set, min, max) {
  for (let i = 0; i < 500; i++) {
    const p = min + Math.floor(Math.random() * (max - min));
    if (p === PORT || set.has(p)) continue;
    set.add(p);
    return p;
  }
  throw new Error('no free port');
}

function serverKey(pid, name) { return `${String(pid)}\0${String(name)}`; }
function safeName(s) { return String(s || '').replace(/[^a-zA-Z0-9._-]/g, ''); }
function manifestPath(pid, name) { return join(SERVE_DIR, `${safeName(pid)}__${safeName(name)}.json`); }

function writeManifest(rec) {
  try { writeFileSync(manifestPath(rec.pid, rec.name), JSON.stringify(rec)); } catch { /* best effort */ }
}
function removeManifest(pid, name) { try { unlinkSync(manifestPath(pid, name)); } catch { /* gone */ } }
function readManifests() {
  const out = [];
  let names = [];
  try { names = readdirSync(SERVE_DIR); } catch { return out; }
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    try { out.push(JSON.parse(readFileSync(join(SERVE_DIR, f), 'utf8'))); } catch { /* skip bad file */ }
  }
  return out;
}

// Ask a supervisor's control socket. Rejects if it is unreachable/dead.
function supCall(rec, path, method = 'GET', timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    fetch(`http://127.0.0.1:${rec.ctrl}${path}?token=${encodeURIComponent(TOKEN)}`, { method, signal: ac.signal })
      .then(async (r) => { clearTimeout(t); resolve(await r.json().catch(() => ({}))); },
            (e) => { clearTimeout(t); reject(e); });
  });
}

function spawnSupervisor(rec) {
  try {
    const child = spawn(process.execPath, [SUP_PATH], {
      detached: true, stdio: 'ignore',
      env: {
        ...process.env,
        SUP_CMD: rec.cmd, SUP_CWD: rec.cwd, SUP_PORT: String(rec.port), SUP_CTRL: String(rec.ctrl),
        SUP_TOKEN: TOKEN, SUP_PID: rec.pid, SUP_NAME: rec.name,
        SUP_KEY: `${safeName(rec.pid)}__${safeName(rec.name)}`, // env values can't hold NUL
        SUP_MANIFEST: manifestPath(rec.pid, rec.name),
      },
    });
    child.on('error', (e) => console.error(`terminald: supervisor spawn failed (${rec.name}): ${e.message}`));
    child.unref();
    rec.supervisorPid = child.pid;
    writeManifest(rec);
    return true;
  } catch (e) {
    console.error(`terminald: supervisor spawn failed (${rec.name}): ${e.message}`);
    return false;
  }
}

function startServer(pid, name, cmd) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return { ok: false, error: 'bad server name (use a-z0-9_-)' };
  if (typeof cmd !== 'string' || !cmd.trim()) return { ok: false, error: 'cmd required' };
  const key = serverKey(pid, name);
  if (SERVERS.has(key)) return { ok: false, error: 'server already running', port: SERVERS.get(key).port };
  const cwd = workspace(pid);
  const port = pickPort(USED_PORTS, SERVE_MIN, SERVE_MAX);
  const ctrl = pickPort(USED_CTRL, CTRL_MIN, CTRL_MAX);
  const rec = { pid: String(pid), name, port, ctrl, cmd, cwd, startedAt: Date.now() };
  SERVERS.set(key, rec);
  if (!spawnSupervisor(rec)) { SERVERS.delete(key); return { ok: false, error: 'could not start supervisor' }; }
  return { ok: true, name, port };
}

async function stopServer(pid, name) {
  const key = serverKey(pid, name);
  const rec = SERVERS.get(key);
  if (!rec) return { ok: false, error: 'server not found' };
  try { await supCall(rec, '/stop', 'POST'); } catch { /* already gone */ }
  // Belt-and-braces: reap anything the manifest remembers.
  try { if (rec.childPid) process.kill(-rec.childPid, 'SIGKILL'); } catch { /* gone */ }
  try { if (rec.supervisorPid) process.kill(rec.supervisorPid, 'SIGKILL'); } catch { /* gone */ }
  SERVERS.delete(key);
  removeManifest(pid, name);
  return { ok: true, name };
}

async function serverInfo(rec) {
  const out = { name: rec.name, port: rec.port, startedAt: rec.startedAt, running: false };
  try {
    const s = await supCall(rec, '/status');
    Object.assign(out, {
      running: !!s.running, exits: s.exits || 0, restarts: s.restarts || 0,
      lastExit: s.lastExit ?? null, backoffMs: s.backoffMs || 0, childPid: s.childPid || null,
    });
  } catch { /* supervisor unreachable → reported as not running */ }
  return out;
}

async function listServers(pid) {
  const out = [];
  for (const rec of SERVERS.values()) if (rec.pid === String(pid)) out.push(await serverInfo(rec));
  return out;
}

// On startup, re-attach to supervisors that outlived us (detached), and revive
// any whose supervisor died while the daemon was down.
async function adoptServers() {
  for (const m of readManifests()) {
    if (!m || typeof m.cmd !== 'string' || !m.pid || !m.name) continue;
    const key = serverKey(m.pid, m.name);
    if (SERVERS.has(key)) continue;
    if (Number.isInteger(m.port)) USED_PORTS.add(m.port);
    if (Number.isInteger(m.ctrl)) USED_CTRL.add(m.ctrl);
    const rec = {
      pid: String(m.pid), name: String(m.name), port: m.port, ctrl: m.ctrl, cmd: m.cmd,
      cwd: m.cwd || workspace(m.pid), startedAt: m.startedAt || Date.now(),
      childPid: m.childPid, supervisorPid: m.supervisorPid,
    };
    let alive = false;
    try { const s = await supCall(rec, '/status'); alive = !!s.ok; } catch { alive = false; }
    SERVERS.set(key, rec);
    if (alive) {
      console.log(`terminald: adopted server ${rec.name} (${rec.pid}) on :${rec.port}`);
    } else {
      try { if (rec.childPid) process.kill(-rec.childPid, 'SIGKILL'); } catch { /* gone */ }
      spawnSupervisor(rec);
      console.log(`terminald: revived server ${rec.name} (${rec.pid}) on :${rec.port}`);
    }
  }
}

// Resolve `/srv/<pid>/<name>/<rest>` to a running server record.
function matchServer(pathname) {
  const m = pathname.match(/^\/srv\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (!m) return null;
  const rec = SERVERS.get(serverKey(m[1], m[2]));
  if (!rec) return null;
  return { rec, rest: (m[3] || '/') };
}

function ls(dir, base = '') {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...ls(join(dir, ent.name), rel));
    else if (ent.isFile()) {
      const abs = join(dir, ent.name);
      try {
        const st = statSync(abs);
        if (st.size > MAX_SIZE) continue;
        const content = readFileSync(abs, 'utf8');
        if (/[\0]/.test(content)) continue;
        out.push({ path: rel, content });
      } catch { /* skip */ }
    }
  }
  return out;
}

function readBody(req) {
  return new Promise((resolvePromise) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolvePromise(data));
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body);
}

// The daemon also hosts AI generation runs (see agent.mjs): the Worker forwards
// a chat turn, the daemon runs it in the background and buffers the events so a
// dropped connection never loses the build.
configureAgent({ port: PORT, token: TOKEN, sandbox: SANDBOX, apiBase: process.env.AGENT_API_URL });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === 'GET' && url.pathname === '/status') return json(res, 200, { ok: true, pid: process.pid });
  if (await agentRoute(req, res, url, TOKEN)) return;

  if (req.method === 'POST' && url.pathname === '/exec') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    if (body.token !== TOKEN) return json(res, 401, { error: 'bad token' });
    const cmd = String(body.cmd || '').slice(0, MAX_CMD);
    if (!cmd) return json(res, 400, { error: 'cmd required' });
    let cwd;
    try { cwd = workspace(body.pid); } catch { return json(res, 400, { error: 'bad pid' }); }
    const r = await run(cwd, cmd, Math.min(120000, Number(body.timeoutMs) || 30000));
    return json(res, 200, { ok: r.code === 0, code: r.code, output: r.output, error: r.error || null, blocked: !!r.blocked, ms: r.ms });
  }

  if (req.method === 'POST' && url.pathname === '/mirror') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    if (body.token !== TOKEN) return json(res, 401, { error: 'bad token' });
    let dir;
    try { dir = workspace(body.pid); } catch { return json(res, 400, { error: 'bad pid' }); }
    const files = Array.isArray(body.files) ? body.files.slice(0, MAX_FILES) : [];
    let n = 0;
    for (const f of files) {
      if (!f || typeof f.content !== 'string' || f.content.length > MAX_SIZE) continue;
      let abs;
      try { abs = safeSubPath(dir, f.path); } catch { continue; }
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.content);
      n++;
    }
    return json(res, 200, { ok: true, count: n });
  }

  if (req.method === 'POST' && url.pathname === '/unlink') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    if (body.token !== TOKEN) return json(res, 401, { error: 'bad token' });
    let dir;
    try { dir = workspace(body.pid); } catch { return json(res, 400, { error: 'bad pid' }); }
    for (const p of Array.isArray(body.paths) ? body.paths : []) {
      let abs;
      try { abs = safeSubPath(dir, p); } catch { continue; }
      try { unlinkSync(abs); } catch { /* already gone */ }
    }
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/files') {
    const token = url.searchParams.get('token') || '';
    if (token !== TOKEN) return json(res, 401, { error: 'bad token' });
    let dir;
    try { dir = workspace(url.searchParams.get('pid') || 'default'); } catch { return json(res, 400, { error: 'bad pid' }); }
    const files = ls(dir);
    return json(res, 200, { ok: true, count: files.length, files });
  }

  // ---- dedicated servers (start / list / stop / logs) --------------------
  if (req.method === 'POST' && url.pathname === '/serve') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    if (body.token !== TOKEN) return json(res, 401, { error: 'bad token' });
    try { workspace(body.pid); } catch { return json(res, 400, { error: 'bad pid' }); }
    const r = startServer(body.pid, String(body.name || '').toLowerCase(), String(body.cmd || ''));
    return json(res, r.ok ? 200 : 400, r);
  }

  if (req.method === 'GET' && url.pathname === '/serve') {
    if ((url.searchParams.get('token') || '') !== TOKEN) return json(res, 401, { error: 'bad token' });
    return json(res, 200, { ok: true, servers: await listServers(url.searchParams.get('pid') || 'default') });
  }

  if (req.method === 'POST' && url.pathname === '/serve/stop') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    if (body.token !== TOKEN) return json(res, 401, { error: 'bad token' });
    const r = await stopServer(body.pid, String(body.name || '').toLowerCase());
    return json(res, r.ok ? 200 : 404, r);
  }

  if (req.method === 'GET' && url.pathname === '/serve/logs') {
    if ((url.searchParams.get('token') || '') !== TOKEN) return json(res, 401, { error: 'bad token' });
    const rec = SERVERS.get(serverKey(url.searchParams.get('pid') || 'default', url.searchParams.get('name') || ''));
    if (!rec) return json(res, 404, { error: 'server not found' });
    try {
      const s = await supCall(rec, '/logs');
      const st = await supCall(rec, '/status').catch(() => ({}));
      return json(res, 200, { ok: true, name: rec.name, running: !!st.running, exit: st.lastExit ?? null, log: s.log || '' });
    } catch {
      return json(res, 200, { ok: true, name: rec.name, running: false, exit: null, log: '' });
    }
  }

  // ---- HTTP reverse proxy to a running dedicated server ------------------
  if (url.pathname.startsWith('/srv/')) {
    const hit = matchServer(url.pathname);
    if (!hit) return json(res, 502, { error: 'server not running' });
    const target = httpRequest({
      host: '127.0.0.1', port: hit.rec.port, method: req.method,
      path: hit.rest + url.search, headers: { ...req.headers },
    }, (up) => { res.writeHead(up.statusCode || 502, up.headers); up.pipe(res); });
    target.on('error', () => { if (!res.headersSent) json(res, 502, { error: 'server unreachable' }); else res.end(); });
    req.pipe(target);
    return;
  }

  json(res, 404, { error: 'not found' });
});

// WebSocket (and other upgrade) proxy to a running dedicated server.
server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const hit = matchServer(u.pathname);
  if (!hit) { socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); socket.destroy(); return; }
  const upstream = net.connect(hit.rec.port, '127.0.0.1', () => {
    const lines = [`${req.method} ${hit.rest + u.search} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on('error', () => { try { socket.destroy(); } catch { /* gone */ } });
  socket.on('error', () => { try { upstream.destroy(); } catch { /* gone */ } });
  socket.on('close', () => { try { upstream.destroy(); } catch { /* gone */ } });
});

// Re-adopt dedicated servers whose supervisors outlived this daemon before we
// start accepting traffic, so /srv/... works immediately after a restart.
await adoptServers();

server.listen(PORT, () => {
  console.log(`terminald on :${PORT}, sandbox=${SANDBOX}`);
  if (TOKEN === 'change-me') console.warn('⚠ change TERMINAL_TOKEN before exposing this publicly!');
});