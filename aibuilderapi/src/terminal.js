import { Hono } from 'hono';
import { getVar } from './env.js';
import { requireUser } from './auth.js';

// Dedicated cloud terminal for the AI. The worker proxies shell commands to a
// small daemon running on an always-free VM (GCP e2-micro / Oracle Always Free).
// Wire it up in wrangler.toml: TERMINAL_URL (e.g. https://term.example.com) +
// TERMINAL_TOKEN. Until configured, /api/terminal reports enabled:false and
// chat CMD blocks degrade gracefully.

const URL = () => String(getVar('TERMINAL_URL') || '').replace(/\/+$/, '');
const TOKEN = () => String(getVar('TERMINAL_TOKEN') || '');
const MAX_CMD = 2000;
const MAX_OUT = 20000;

export function terminalEnabled() {
  return Boolean(URL() && TOKEN());
}

export async function execCommand(pid, cmd, opts = {}) {
  if (!terminalEnabled()) return { enabled: false };
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
  const res = await execCommand(pid, cmd, { cwd, timeoutMs });
  if (!res.ok) return c.json(res, 502);
  return c.json(res);
});