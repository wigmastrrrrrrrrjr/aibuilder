// Internal bridge between the Cloudflare Worker and the local terminal daemon.
//
// The daemon owns the AI generation loop (Workers can't hold a long stream), so
// it needs the real storage backend for every read/write a turn performs. Rather
// than replicate D1 on the device, the daemon calls back here with a plain
// { op, args } envelope and this route applies it to the same `store` the Worker
// uses. Guarded by the shared TERMINAL_TOKEN — the daemon already holds it, and
// it grants shell access anyway — so only the daemon can reach it; the public
// cannot (a missing/wrong token is a 401, and the ops are a fixed whitelist).

import { Hono } from 'hono';
import { store } from './store.js';
import { getVar } from './env.js';

export const agentBridge = new Hono();

// The exact store surface a generation turn touches (see chat.js / tools.js /
// credits.js). Anything not listed is refused, so a leaked token still cannot
// reach unrelated tables.
const ALLOWED = new Set([
  'getProject', 'createProject', 'listProjects', 'setModel', 'addMessage', 'history',
  'metaGet', 'metaSet', 'listFiles', 'listFilesWithContent', 'getFile', 'saveFile',
  'deleteFile', 'rename', 'setPlan', 'setBrief', 'recordVersion',
  'getCredits', 'spendCredits', 'earnCredits', 'spendEarnings',
  'earningsUnits', 'earningsUnitsForNames', 'creditGet', 'creditSpend', 'teamCreditKey',
  'teamMembers', 'isTeamMember', 'fileVersions', 'getFileVersion', 'restoreFileVersion',
  'touchPresence', 'appendEvent', 'currentSeq', 'takeSnapshot',
]);

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function authorized(c) {
  const want = String(getVar('TERMINAL_TOKEN') || '');
  if (want.length < 16) return false;
  return safeEqual(String(c.req.header('x-terminal-token') || ''), want);
}

// Platform keys/config the daemon needs to reach the model providers. Sent once
// at daemon start; the daemon holds them only in memory.
agentBridge.get('/config', (c) => {
  if (!authorized(c)) return c.json({ error: 'unauthorized' }, 401);
  const names = [
    'OLLAMA_MODEL', 'OLLAMA_API_KEY', 'MISTRAL_API_KEY', 'OPENROUTER_API_KEY',
    'LOCAL_OLLAMA_URL', 'LOCAL_OLLAMA_BEACON', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY',
    'DAILY_CREDITS',
  ];
  const out = {};
  for (const n of names) {
    const v = getVar(n);
    if (v !== undefined) out[n] = v;
  }
  return c.json(out);
});

agentBridge.post('/', async (c) => {
  if (!authorized(c)) return c.json({ error: 'unauthorized' }, 401);
  const { op, args } = await c.req.json().catch(() => ({}));
  if (typeof op !== 'string' || !ALLOWED.has(op)) {
    return c.json({ error: `op not allowed: ${String(op)}` }, 400);
  }
  try {
    const result = await store[op](...(Array.isArray(args) ? args : []));
    return c.json({ result: result === undefined ? null : result });
  } catch (e) {
    return c.json({ error: String(e?.message || e) }, 400);
  }
});
