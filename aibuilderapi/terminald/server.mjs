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

import http from 'node:http';
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

function workspace(pid) {
  const dir = resolve(join(SANDBOX, String(pid || 'default').replace(/[^a-zA-Z0-9._-]/g, '')));
  if (dir !== SANDBOX && !dir.startsWith(SANDBOX + '/')) throw new Error('bad pid');
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

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`terminald on :${PORT}, sandbox=${SANDBOX}`);
  if (TOKEN === 'change-me') console.warn('⚠ change TERMINAL_TOKEN before exposing this publicly!');
});