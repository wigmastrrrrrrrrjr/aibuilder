// Per-server "second terminal".
//
// terminald spawns one of these detached, once per dedicated server. It owns the
// server process and keeps it alive: if the server exits (crash, OOM, unhandled
// error) it is relaunched with exponential backoff instead of vanishing. Because
// the supervisor is detached from the daemon, a crashing server can't take the
// terminal down, and the daemon can restart without every server dying with it.
//
// It exposes a tiny token-guarded control API on loopback (status/logs/stop/
// start) that terminald proxies lifecycle calls to, and mirrors its state into
// the on-disk manifest so a restarted daemon can re-adopt it.
//
// Config is passed through the environment by terminald:
//   SUP_CMD, SUP_CWD, SUP_PORT, SUP_CTRL, SUP_TOKEN, SUP_PID, SUP_NAME,
//   SUP_KEY, SUP_MANIFEST

import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const { SUP_CMD, SUP_CWD, SUP_PORT, SUP_CTRL, SUP_TOKEN, SUP_PID, SUP_NAME, SUP_KEY, SUP_MANIFEST } = process.env;

const LOG_RING = 20000;
const BACKOFF_MIN = 500;
const BACKOFF_MAX = 30000;
const STABLE_MS = 10000;   // ran this long → treat the next crash as fresh

const state = {
  running: false, child: null, pid: null, startedAt: 0,
  exits: 0, restarts: 0, lastExit: null, backoffMs: 0, stopping: false, log: '',
};

const append = (d) => { state.log = (state.log + d.toString()).slice(-LOG_RING); };

function saveManifest(extra) {
  if (!SUP_MANIFEST) return;
  try {
    const cur = JSON.parse(fs.readFileSync(SUP_MANIFEST, 'utf8'));
    fs.writeFileSync(SUP_MANIFEST, JSON.stringify({ ...cur, ...extra, updatedAt: Date.now() }));
  } catch { /* best effort */ }
}

function launch() {
  if (state.stopping) return;
  try {
    const child = spawn('/bin/sh', ['-c', SUP_CMD], {
      cwd: SUP_CWD,
      detached: true, // own process group, so we can kill the whole tree
      env: { ...process.env, HOME: SUP_CWD, PORT: String(SUP_PORT), PROJECT_ID: String(SUP_PID), SERVER_NAME: String(SUP_NAME) },
    });
    state.child = child;
    state.pid = child.pid;
    state.running = true;
    state.startedAt = Date.now();
    append(`\n[supervisor] started pid ${child.pid} on :${SUP_PORT}\n`);
    saveManifest({ childPid: child.pid, supervisorPid: process.pid, startedAt: state.startedAt, exits: state.exits, restarts: state.restarts });
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (e) => { append(`\n[spawn error] ${e.message}`); onExit(-1, null); });
    child.on('close', (code, signal) => onExit(code, signal));
  } catch (e) {
    append(`\n[spawn error] ${e.message}`);
    scheduleRestart();
  }
}

function onExit(code, signal) {
  if (!state.running) return;
  const uptime = Date.now() - state.startedAt;
  state.running = false;
  state.child = null;
  state.exits++;
  state.lastExit = signal ? `signal:${signal}` : code;
  append(`\n[supervisor] server exited (${state.lastExit}) after ${Math.round(uptime / 1000)}s\n`);
  saveManifest({ childPid: null, exits: state.exits });
  if (uptime > STABLE_MS) state.backoffMs = 0; // it was healthy → restart fast
  scheduleRestart();
}

function scheduleRestart() {
  if (state.stopping) return;
  state.backoffMs = state.backoffMs ? Math.min(state.backoffMs * 2, BACKOFF_MAX) : BACKOFF_MIN;
  state.restarts++;
  append(`[supervisor] restart #${state.restarts} in ${state.backoffMs}ms\n`);
  saveManifest({ restarts: state.restarts });
  const t = setTimeout(launch, state.backoffMs);
  if (t.unref) t.unref();
}

function stop() {
  if (state.stopping) return;
  state.stopping = true;
  const pid = state.pid;
  const kill = (sig) => { try { if (pid) process.kill(-pid, sig); } catch { /* gone */ } };
  kill('SIGTERM');
  setTimeout(() => kill('SIGKILL'), 3000);
}

const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

const ctrl = http.createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${SUP_CTRL}`);
  const tok = u.searchParams.get('token') || req.headers['x-sup-token'] || '';
  if (tok !== SUP_TOKEN) return json(res, 401, { error: 'bad token' });
  if (u.pathname === '/status') {
    return json(res, 200, {
      ok: true, key: SUP_KEY, pid: SUP_PID, name: SUP_NAME, port: Number(SUP_PORT),
      running: state.running, childPid: state.pid, startedAt: state.startedAt,
      exits: state.exits, restarts: state.restarts, lastExit: state.lastExit, backoffMs: state.backoffMs,
    });
  }
  if (u.pathname === '/logs') return json(res, 200, { ok: true, log: state.log });
  if (u.pathname === '/start') { if (!state.running) { state.stopping = false; launch(); } return json(res, 200, { ok: true, running: state.running }); }
  if (u.pathname === '/stop') { json(res, 200, { ok: true }); setTimeout(() => { stop(); setTimeout(() => process.exit(0), 300); }, 10); return; }
  return json(res, 404, { error: 'not found' });
});

ctrl.on('error', (e) => { append(`[supervisor] control error: ${e.message}\n`); process.exit(1); });

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stop(); setTimeout(() => process.exit(0), 300); });

ctrl.listen(Number(SUP_CTRL), '127.0.0.1', () => {
  append(`[supervisor] control on :${SUP_CTRL} for ${SUP_NAME} (${SUP_PID})\n`);
  launch();
});
