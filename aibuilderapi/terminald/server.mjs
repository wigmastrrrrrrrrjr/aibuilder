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
import { mkdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

const PORT = Number(process.env.PORT || process.argv[2] || 3000);
const SANDBOX = resolve(process.env.SANDBOX || process.argv[3] || '/var/term/sandbox');
const TOKEN = process.env.TERMINAL_TOKEN || process.argv[4] || 'change-me';
const MAX_OUT = 20000;   // caps a single command's captured output (bytes)
const MAX_CMD = 2000;

function workspace(pid) {
  const dir = resolve(join(SANDBOX, String(pid || 'default')));
  if (dir !== SANDBOX && !dir.startsWith(SANDBOX + '/')) throw new Error('bad pid');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function run(cwd, cmd, timeoutMs) {
  return new Promise((resolvePromise) => {
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

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`terminald on :${PORT}, sandbox=${SANDBOX}`);
  if (TOKEN === 'change-me') console.warn('⚠ change TERMINAL_TOKEN before exposing this publicly!');
});