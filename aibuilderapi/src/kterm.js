import { Hono } from 'hono';
import { getVar } from './env.js';
import { store } from './store.js';

// Kaggle-backed remote terminal relay.
//
// The AI's run_command normally proxies to a cloud terminal daemon (terminal.js
// / TERMINAL_URL). This relay instead routes commands to a Python agent that the
// user runs inside a Kaggle Notebook (see terminald/kaggeld/agent.py + setup.sh),
// so shell commands execute on Kaggle's free CPU with the local terminal daemon
// as the automatic fallback.
//
// Transport is plain HTTP polling over D1 — no public IP needed on either side:
//   execCommand (worker)  -> POST /api/kterm/exec  ... creates a job in D1 and
//                            polls it until the agent finishes (request stays open)
//   agent (Kaggle)        -> GET  /api/kterm/next ... claims the oldest pending job
//   agent (Kaggle)        -> POST /api/kterm/done ... posts stdout/code/files back
//
// Auth is the same shared TERMINAL_TOKEN used by the terminal daemon, so no new
// secrets are needed. The relay is only enabled when KAGGLE_RELAY_URL is set and
// points at the public worker origin that hosts these routes.

const URL = () => String(getVar('KAGGLE_RELAY_URL') || '').replace(/\/+$/, '');
const TOKEN = () => String(getVar('TERMINAL_TOKEN') || '');

export function kaggleRelayEnabled() {
  return Boolean(URL() && TOKEN());
}

// D1 comes from the request env in Workers. Local/tests can inject a mock via
// setKtermDb (accepts the D1-style prepare()/run() API or a tiny shim).
let injectedDb = null;
export function setKtermDb(db) {
  injectedDb = db;
}
function ktermDb(c) {
  if (injectedDb) return injectedDb;
  if (c && c.env && c.env.DB) return c.env.DB;
  return null;
}

// Tests inject a Store-backed implementation for the diff-sync step.
let injectedStore = null;
export function setKtermStore(st) {
  injectedStore = st;
}
function ktermStore() {
  return injectedStore || store;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_FILES = 300;
const MAX_SIZE = 2 * 1024 * 1024;
const MAX_OUT = 30000;
const jobId = () => 'kt_' + (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : String(Date.now()) + Math.random().toString(16).slice(2)).slice(0, 24);

// ---- client side: called by execCommand in terminal.js ---------------------
// Returns { kind:'result', result } when the relay produced an answer, or
// { kind:'unavailable', error } when the relay/agent could not service it.

export async function execViaKaggle(pid, cmd, opts = {}) {
  if (!kaggleRelayEnabled()) return { kind: 'unavailable', error: 'kaggle relay not configured' };
  const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || 30000);
  const body = {
    token: TOKEN(),
    pid: String(pid || '').slice(0, 40),
    cmd: String(cmd || '').slice(0, 2000),
    cwd: String(opts.cwd || ''),
    timeoutMs,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs + 30000);
  try {
    const r = await fetch(`${URL()}/api/kterm/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = (await r.text()) || '';
    let j = null;
    try { j = JSON.parse(text); } catch { /* not json */ }
    if (!r.ok || !j || typeof j !== 'object') {
      return { kind: 'unavailable', error: `kaggle relay error (${r.status})`, raw: text.slice(0, 500) };
    }
    if (j.kind === 'unavailable') return { kind: 'unavailable', error: j.error || 'kaggle agents unavailable' };
    return {
      kind: 'result',
      result: {
        ok: j.ok !== false,
        blocked: !!j.blocked,
        code: Number.isInteger(j.code) ? j.code : null,
        output: String(j.output || '').slice(0, 20000),
        error: j.error || null,
        agent: j.agent || null,
      },
    };
  } catch (e) {
    return { kind: 'unavailable', error: `kaggle relay unreachable: ${String(e?.message || e)}` };
  } finally {
    clearTimeout(timer);
  }
}

// ---- relay routes -----------------------------------------------------------

export const kterm = new Hono();

kterm.get('/status', (c) => c.json({ enabled: kaggleRelayEnabled() }));

// Create a job and wait for the agent to finish it. Bound by timeoutMs + 15s.
// Token-gated like the terminal daemon's own HTTP surface (no user session).
kterm.post('/exec', async (c) => {
  const { token, pid, cmd, cwd, timeoutMs } = await c.req.json().catch(() => ({}));
  const db = ktermDb(c);
  if (!db) return c.json({ kind: 'unavailable', error: 'relay db not configured' }, 503);
  if (token !== TOKEN()) return c.json({ error: 'bad token' }, 401);
  const safeCmd = String(cmd || '');
  if (!safeCmd) return c.json({ error: 'cmd (string) is required' }, 400);
  if (!pid || typeof pid !== 'string') return c.json({ error: 'pid (string) is required' }, 400);
  const safePid = pid.slice(0, 40);
  const timeout = Math.max(1000, Number(timeoutMs) || 30000);

  // Snapshot the current project so the agent can materialize it exactly like
  // the terminal daemon's /mirror does. This is the baseline for diff-sync.
  const files = {};
  try {
    const fw = await ktermStore().listFilesWithContent(safePid);
    for (const f of Array.isArray(fw) ? fw : []) {
      if (!f || typeof f.path !== 'string' || f.path.startsWith('/') || f.path.includes('..')) continue;
      if (f.encoding && f.encoding !== 'utf8') continue;
      if (typeof f.content !== 'string' || f.content.length > MAX_SIZE || /\0/.test(f.content)) continue;
      files[f.path] = f.content;
      if (Object.keys(files).length >= MAX_FILES) break;
    }
  } catch { /* best effort */ }

  const id = jobId();
  const now = Date.now();
  await db.prepare(
    `INSERT INTO kterm_jobs (id, pid, cmd, cwd, timeout_ms, status, files, created_at, updated_at) VALUES (?,?,?,?,?, 'pending', ?, ?, ?)`
  ).bind(id, safePid, safeCmd, String(cwd || ''), timeout, JSON.stringify(files), now, now).run();

  return await waitForJob(c, db, id, timeout);
});

// Wait on an existing job id (used by /exec after creating it).
kterm.get('/wait', async (c) => {
  const token = c.req.query('token');
  if (token !== TOKEN()) return c.json({ error: 'bad token' }, 401);
  const db = ktermDb(c);
  if (!db) return c.json({ kind: 'unavailable', error: 'relay db not configured' }, 503);
  const id = String(c.req.query('id') || '');
  if (!id) return c.json({ error: 'id required' }, 400);
  return await waitForJob(c, db, id, Number(c.req.query('timeoutMs')) || 30000);
});

async function waitForJob(c, db, id, timeout) {
  const deadline = Date.now() + timeout + 15000;
  const pick = () => db.prepare(
    `SELECT pid, status, output, code, blocked, error, agent, result_files FROM kterm_jobs WHERE id=?`
  ).bind(id).first();
  while (Date.now() < deadline) {
    let row = null;
    try { row = await pick(); } catch { /* db hiccup — retry */ }
    if (row && row.status === 'done') return finishJob(c, db, id, row.pid, row);
    await sleep(1200);
  }
  try {
    await db.prepare(`UPDATE kterm_jobs SET status='abandoned', updated_at=? WHERE id=? AND status <> 'done'`)
      .bind(Date.now(), id).run();
  } catch { /* ignore */ }
  let row = null;
  try { row = await pick(); } catch { /* ignore */ }
  if (row && row.status === 'done') return finishJob(c, db, id, row.pid, row);
  return c.json({ kind: 'unavailable', error: 'no agent claimed the job in time (Kaggle agent offline?)' }, 504);
}

async function finishJob(c, db, id, pid, row) {
  // Diff-sync the agent's resulting files back into app storage, exactly like
  // the terminal daemon's reconcile step.
  const synced = [];
  let blobs = null;
  try { blobs = JSON.parse(row.result_files || 'null'); } catch { blobs = null; }
  if (blobs && typeof blobs === 'object') {
    let baseline = {};
    try {
      const job = await db.prepare(`SELECT files FROM kterm_jobs WHERE id=?`).bind(id).first();
      if (job && job.files) baseline = JSON.parse(job.files);
    } catch { /* ignore */ }
    const seen = new Set();
    for (const [p, content] of Object.entries(blobs)) {
      if (!p || p.startsWith('/') || p.includes('..')) continue;
      if (typeof content !== 'string' || content.length > MAX_SIZE) continue;
      seen.add(p);
      if (baseline[p] === content) continue;
      try {
        await ktermStore().saveFile(pid, p, content);
        synced.push(p);
      } catch { /* ignore */ }
    }
    for (const p of Object.keys(baseline)) {
      if (seen.has(p)) continue;
      try {
        await ktermStore().deleteFile(pid, p).catch(() => {});
        synced.push(`${p} (deleted)`);
      } catch { /* ignore */ }
    }
  }
  return c.json({
    kind: 'result',
    ok: row.blocked ? false : (row.code === 0),
    blocked: !!row.blocked,
    code: Number.isInteger(row.code) ? row.code : null,
    output: String(row.output || ''),
    error: row.error || null,
    agent: row.agent || null,
    sync: synced,
  });
}

// Agent-side: claim (and run) the oldest pending job for this account.
kterm.get('/next', async (c) => {
  const token = c.req.query('token');
  if (token !== TOKEN()) return c.json({ error: 'bad token' }, 401);
  const db = ktermDb(c);
  if (!db) return c.json({ error: 'relay db not configured' }, 503);
  const now = Date.now();
  // Atomic claim: flip pending -> running; only the winner gets the row.
  const candidate = await db.prepare(
    `SELECT id FROM kterm_jobs WHERE status='pending' ORDER BY created_at ASC LIMIT 1`
  ).first();
  if (!candidate) return c.json({ none: true });
  const claimed = await db.prepare(
    `UPDATE kterm_jobs SET status='running', updated_at=? WHERE id=? AND status='pending'`
  ).bind(now, candidate.id).run();
  if (!claimed || Number(claimed.meta?.changes ?? claimed.changes ?? 0) <= 0) return c.json({ none: true });
  const row = await db.prepare(
    `SELECT id, pid, cmd, cwd, timeout_ms, files FROM kterm_jobs WHERE id=?`
  ).bind(candidate.id).first();
  if (!row) return c.json({ none: true });
  let files = {};
  try { files = JSON.parse(row.files || '{}'); } catch { files = {}; }
  return c.json({
    job: {
      id: row.id, pid: row.pid, cmd: row.cmd, cwd: row.cwd || '',
      timeout_ms: row.timeout_ms, files,
    },
  });
});

// Agent-side: report results for a job.
kterm.post('/done', async (c) => {
  const { token, id, output, code, blocked, error, agent, result_files } = await c.req.json().catch(() => ({}));
  if (token !== TOKEN()) return c.json({ error: 'bad token' }, 401);
  const db = ktermDb(c);
  if (!db) return c.json({ error: 'relay db not configured' }, 503);
  if (!id || typeof id !== 'string') return c.json({ error: 'id required' }, 400);
  await db.prepare(
    `UPDATE kterm_jobs SET status='done', output=?, code=?, blocked=?, error=?, agent=?, result_files=?, updated_at=? WHERE id=?`
  ).bind(
    String(output || '').slice(0, MAX_OUT),
    Number.isInteger(code) ? code : null,
    blocked ? 1 : 0,
    String(error || '').slice(0, 500) || null,
    String(agent || '').slice(0, 80) || null,
    JSON.stringify(result_files || {}),
    Date.now(),
    id,
  ).run();
  return c.json({ ok: true });
});