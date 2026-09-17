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
import { mkdirSync, statSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

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

// Same write-jail policy as the worker (src/terminal.js:jailError).
function jailError(cmd, cwd) {
  const tokens = cmd.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[12]>>?|>>?|[&|;()<>]|[^\s;"'|&()<>]+/g) || [];
  const ALLOW = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/zero', '/dev/urandom', '/dev/full']);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!/^[12]?>>?$/.test(tok)) continue;
    let j = i + 1;
    while (j < tokens.length && (tokens[j] === '&' || /^&\d+$/.test(tokens[j]))) j++;
    if (j >= tokens.length) continue;
    const dest = tokens[j].replace(/^["']|["']$/g, '');
    if (!dest || dest.startsWith('&')) continue;
    if (ALLOW.has(dest)) continue;
    const base = cwd.endsWith('/') ? cwd.slice(0, -1) : cwd;
    const raw = dest.startsWith('/') ? dest : dest.startsWith('~/') ? base + '/' + dest.slice(2) : base + '/' + dest;
    const stack = [];
    for (const s2 of raw.split('/')) {
      if (!s2 || s2 === '.') continue;
      if (s2 === '..') { if (stack.length) stack.pop(); else stack.push('..'); }
      else stack.push(s2);
    }
    const norm = '/' + stack.join('/');
    if (norm !== base && !norm.startsWith(base + '/')) return `write outside the project sandbox blocked: > ${dest}`;
  }
  if (/\brm\s+(-[A-Za-z0-9]+[ ]+)*\/([^ ]|$)/.test(cmd)) return 'destructive rm on an absolute path blocked';
  if (/^chmod\s+[0-7]+\s*\/[^ ]/.test(cmd)) return 'chmod on an absolute path blocked';
  if (/\b(mkfs|fdisk|dd\s+if=[^ ]+of=[^ ]+)\b/i.test(cmd)) return 'destructive disk-level command blocked';
  return null;
}

function run(cwd, cmd, timeoutMs) {
  return new Promise((resolvePromise) => {
    const jail = jailError(cmd, cwd);
    if (jail) return resolvePromise({ code: 1, output: jail, ms: 0 });
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
// requests to it via /srv/<pid>/<name>/... . The daemon persists NO server
// state — apps must save anything durable with the database/multiplayer SDKs.

const SERVERS = new Map();                 // `${pid}\0${name}` -> record
const USED_PORTS = new Set();
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SERVE_MIN = 41000, SERVE_MAX = 41999;
const LOG_RING = 20000;                    // chars of stdout/stderr kept per server

function pickPort() {
  for (let i = 0; i < 500; i++) {
    const p = SERVE_MIN + Math.floor(Math.random() * (SERVE_MAX - SERVE_MIN));
    if (p === PORT || USED_PORTS.has(p)) continue;
    USED_PORTS.add(p);
    return p;
  }
  throw new Error('no free port');
}

function serverKey(pid, name) { return `${String(pid)}\0${String(name)}`; }

function startServer(pid, name, cmd) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return { ok: false, error: 'bad server name (use a-z0-9_-)' };
  if (typeof cmd !== 'string' || !cmd.trim()) return { ok: false, error: 'cmd required' };
  const key = serverKey(pid, name);
  const prev = SERVERS.get(key);
  if (prev && prev.child && prev.exit === null) return { ok: false, error: 'server already running', port: prev.port };
  const cwd = workspace(pid);
  const port = pickPort();
  const rec = { pid: String(pid), name, port, child: null, startedAt: Date.now(), log: '', exit: null };
  SERVERS.set(key, rec);
  const append = (d) => { rec.log = (rec.log + d.toString()).slice(-LOG_RING); };
  try {
    rec.child = spawn('/bin/sh', ['-c', cmd], {
      cwd,
      detached: true,                      // own process group → kill the whole tree
      env: { ...process.env, HOME: cwd, PORT: String(port), PROJECT_ID: String(pid), SERVER_NAME: name },
    });
  } catch (e) {
    rec.exit = -1; rec.log += `\n[spawn error] ${e.message}`;
    return { ok: false, error: String(e.message) };
  }
  rec.child.stdout.on('data', append);
  rec.child.stderr.on('data', append);
  rec.child.on('close', (code) => { rec.exit = code; rec.child = null; });
  rec.child.on('error', (e) => { rec.exit = -1; rec.log += `\n[spawn error] ${e.message}`; rec.child = null; });
  return { ok: true, name, port };
}

function stopServer(pid, name) {
  const rec = SERVERS.get(serverKey(pid, name));
  if (!rec) return { ok: false, error: 'server not found' };
  const kill = (sig) => { try { if (rec.child) process.kill(-rec.child.pid, sig); } catch { /* gone */ } };
  kill('SIGTERM');
  setTimeout(() => kill('SIGKILL'), 3000);
  return { ok: true, name };
}

function serverInfo(rec) {
  return { name: rec.name, port: rec.port, running: !!rec.child && rec.exit === null, startedAt: rec.startedAt, exit: rec.exit };
}

function listServers(pid) {
  const out = [];
  for (const rec of SERVERS.values()) if (rec.pid === String(pid)) out.push(serverInfo(rec));
  return out;
}

// Resolve `/srv/<pid>/<name>/<rest>` to a running server record.
function matchServer(pathname) {
  const m = pathname.match(/^\/srv\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (!m) return null;
  const rec = SERVERS.get(serverKey(m[1], m[2]));
  if (!rec || !rec.child || rec.exit !== null) return null;
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === 'GET' && url.pathname === '/status') return json(res, 200, { ok: true, pid: process.pid });

  if (req.method === 'POST' && url.pathname === '/exec') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    if (body.token !== TOKEN) return json(res, 401, { error: 'bad token' });
    const cmd = String(body.cmd || '').slice(0, MAX_CMD);
    if (!cmd) return json(res, 400, { error: 'cmd required' });
    let cwd;
    try { cwd = workspace(body.pid); } catch { return json(res, 400, { error: 'bad pid' }); }
    const r = await run(cwd, cmd, Math.min(120000, Number(body.timeoutMs) || 30000));
    return json(res, 200, { ok: r.code === 0, code: r.code, output: r.output, ms: r.ms });
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
    return json(res, 200, { ok: true, servers: listServers(url.searchParams.get('pid') || 'default') });
  }

  if (req.method === 'POST' && url.pathname === '/serve/stop') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    if (body.token !== TOKEN) return json(res, 401, { error: 'bad token' });
    const r = stopServer(body.pid, String(body.name || '').toLowerCase());
    return json(res, r.ok ? 200 : 404, r);
  }

  if (req.method === 'GET' && url.pathname === '/serve/logs') {
    if ((url.searchParams.get('token') || '') !== TOKEN) return json(res, 401, { error: 'bad token' });
    const rec = SERVERS.get(serverKey(url.searchParams.get('pid') || 'default', url.searchParams.get('name') || ''));
    if (!rec) return json(res, 404, { error: 'server not found' });
    return json(res, 200, { ok: true, name: rec.name, running: !!rec.child && rec.exit === null, exit: rec.exit, log: rec.log });
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

server.listen(PORT, () => {
  console.log(`terminald on :${PORT}, sandbox=${SANDBOX}`);
  if (TOKEN === 'change-me') console.warn('⚠ change TERMINAL_TOKEN before exposing this publicly!');
});