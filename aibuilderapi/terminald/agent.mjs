// Agent runs hosted by the local daemon.
//
// Cloudflare Workers cap how long a request (and thus an SSE stream) can live,
// so a long build gets cut off mid-response and the work is lost. This module
// moves the generation loop onto the always-on machine: the Worker forwards the
// turn here, the daemon runs it as a *detached background run* and keeps every
// event in a ring buffer. A dropped Worker/client connection no longer ends the
// build — the browser re-attaches by runId and replays from where it stopped.
//
// Storage stays authoritative in D1: the daemon's `store` is a thin RPC proxy
// back to the Worker (see src/agent-bridge.js), so files/messages/credits are
// written through the real backend.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { useStore } from '../src/store.js';
import { setVars } from '../src/env.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Repo-root .env carries the provider keys the daemon generates with. The
// Worker's authoritative config is fetched over the bridge at startup and
// overrides these via setVars().
const envPath = path.resolve(here, '../../.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || m[1].startsWith('#')) continue;
    const val = m[2].replace(/^["']|["']$/g, '');
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  }
}

const DEFAULT_API = 'https://aibuilderapi.csomeone301.workers.dev';
const MAX_EVENTS = 40000;              // per-run replay buffer (oldest dropped first)
const RUN_TTL = 30 * 60 * 1000;        // keep a finished run around for re-attach

let API = DEFAULT_API;
let TOKEN = '';
let configured = false;
let _chat = null;

// The generation loop lives in the Worker's chat.js; load it lazily so the .env
// loader above runs first (ESM evaluates static imports before module body).
async function loadChat() {
  if (!_chat) _chat = await import('../src/chat.js');
  return _chat;
}

async function rpc(op, args) {
  const r = await fetch(`${API}/api/internal/agent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-terminal-token': TOKEN },
    body: JSON.stringify({ op, args }),
  });
  const j = await r.json().catch(() => null);
  if (!j || j.error) throw new Error(j?.error || `agent bridge ${r.status}`);
  return j.result;
}

export function configure({ port, token, sandbox, apiBase }) {
  if (configured) return;
  configured = true;
  TOKEN = token;
  API = String(apiBase || process.env.AGENT_API_URL || DEFAULT_API).replace(/\/+$/, '');
  process.env.AGENT_API_URL = API;
  // Point the shared terminal helpers at this daemon; force the HTTP branch so
  // there is one execution path (the same /exec, /mirror, /files endpoints).
  process.env.TERMINAL_URL = `http://127.0.0.1:${port}`;
  process.env.TERMINAL_TOKEN = token;
  delete process.env.LOCAL_TERMINAL;
  if (sandbox) process.env.LOCAL_SANDBOX = sandbox;
  // Every store call the turn makes is applied to D1 through the bridge.
  useStore(new Proxy({}, {
    get(_, prop) {
      if (typeof prop !== 'string') return undefined;
      return (...args) => rpc(prop, args);
    },
  }));
  console.log(`agent: runs enabled, bridge=${API}`);
}

let cfgAt = 0;
async function ensureConfig(force) {
  if (!force && cfgAt && Date.now() - cfgAt < 600000) return;
  try {
    const r = await fetch(`${API}/api/internal/agent/config`, { headers: { 'x-terminal-token': TOKEN } });
    if (!r.ok) return;
    const cfg = await r.json();
    if (cfg && typeof cfg === 'object') { setVars(cfg); cfgAt = Date.now(); }
  } catch { /* fall back to .env values */ }
}

// ---- run registry ----------------------------------------------------------

const RUNS = new Map();

function newRunId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 24);
}

function startRun(spec) {
  const id = String(spec.runId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || newRunId();
  const existing = RUNS.get(id);
  if (existing && existing.user?.id && existing.user.id === spec.user?.id) return existing;

  const run = {
    id, user: spec.user || null, pid: null, seq: 0, events: [],
    waiters: new Set(), done: false, controller: new AbortController(),
    startedAt: Date.now(), endedAt: 0,
  };
  RUNS.set(id, run);

  run.emit = (ev) => {
    const e = { ...(ev || {}), seq: run.seq++ };
    run.events.push(e);
    if (run.events.length > MAX_EVENTS) run.events.shift();
    for (const w of run.waiters) { try { w.send(e); } catch { /* closed */ } }
  };

  const finish = () => {
    run.done = true; run.endedAt = Date.now();
    for (const w of run.waiters) { try { w.end(); } catch { /* closed */ } }
    const t = setTimeout(() => RUNS.delete(id), RUN_TTL);
    if (t.unref) t.unref();
  };

  run.promise = (async () => {
    run.emit({ type: 'run', runId: id, resumable: true });
    try {
      await ensureConfig();
      const { prepareChat, runChat } = await loadChat();
      const prep = await prepareChat({
        user: spec.user, body: spec.body, message: spec.message,
        apiKey: spec.apiKey, sid: spec.body?.sid, key: spec.key, ownKey: spec.ownKey,
      });
      if (prep.error) {
        run.emit({ type: 'error', message: prep.error.error || 'could not start the build' });
        run.emit({ type: 'done', projectId: null, files: [], edited: [], deleted: [], renamed: [], assets: [], seeds: [] });
      } else {
        run.pid = prep.pid;
        await runChat({ ...prep, body: spec.body, message: spec.message, signal: run.controller.signal, emit: run.emit });
      }
    } catch (e) {
      run.emit({ type: 'error', message: String(e?.message || e) });
      run.emit({ type: 'done', projectId: run.pid, files: [], edited: [], deleted: [], renamed: [], assets: [], seeds: [] });
    } finally {
      finish();
    }
  })();

  return run;
}

function attach(res, run, since) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const write = (ev) => { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* closed */ } };

  if (since > 0 && run.events.length && since < (run.events[0].seq || 0)) {
    write({ type: 'gap', message: 'some earlier events are no longer buffered — reloading state' });
  }
  for (const ev of run.events) if ((ev.seq || 0) >= since) write(ev);

  if (run.done) { try { res.end(); } catch { /* closed */ } return; }

  const waiter = { send: write, end: () => { try { res.end(); } catch { /* closed */ } } };
  run.waiters.add(waiter);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 15000);
  const cleanup = () => { clearInterval(ping); run.waiters.delete(waiter); };
  res.on('close', cleanup);
  res.on('error', cleanup);
}

// ---- HTTP routing ----------------------------------------------------------

function readJson(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 4e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve(null); } });
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// Returns true when the request belonged to /agent/*.
export async function agentRoute(req, res, url, token) {
  const p = url.pathname;
  if (!p.startsWith('/agent/')) return false;

  if (req.method === 'POST' && p === '/agent/chat') {
    const b = await readJson(req);
    if (!b || b.token !== token) { json(res, 401, { error: 'bad token' }); return true; }
    attach(res, startRun(b), 0);
    return true;
  }

  const tok = url.searchParams.get('token') || req.headers['x-terminal-token'] || '';
  if (tok !== token) { json(res, 401, { error: 'bad token' }); return true; }

  const mStream = p.match(/^\/agent\/stream\/([^/]+)$/);
  if (req.method === 'GET' && mStream) {
    const run = RUNS.get(decodeURIComponent(mStream[1]));
    if (!run) { json(res, 404, { error: 'run not found' }); return true; }
    const uid = url.searchParams.get('uid') || '';
    if (uid && run.user?.id && uid !== run.user.id) { json(res, 403, { error: 'forbidden' }); return true; }
    attach(res, run, Math.max(0, Number(url.searchParams.get('since') || 0) || 0));
    return true;
  }

  const mRun = p.match(/^\/agent\/run\/([^/]+)$/);
  if (req.method === 'GET' && mRun) {
    const run = RUNS.get(decodeURIComponent(mRun[1]));
    if (!run) { json(res, 404, { error: 'run not found' }); return true; }
    json(res, 200, {
      ok: true, runId: run.id, running: !run.done, pid: run.pid,
      events: run.events.length, startedAt: run.startedAt, endedAt: run.endedAt,
    });
    return true;
  }

  const mCancel = p.match(/^\/agent\/cancel\/([^/]+)$/);
  if (req.method === 'POST' && mCancel) {
    const run = RUNS.get(decodeURIComponent(mCancel[1]));
    if (!run) { json(res, 404, { error: 'run not found' }); return true; }
    try { run.controller.abort(); } catch { /* already gone */ }
    json(res, 200, { ok: true });
    return true;
  }

  json(res, 404, { error: 'not found' });
  return true;
}
