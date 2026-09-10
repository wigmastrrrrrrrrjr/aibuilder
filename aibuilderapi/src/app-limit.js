import { getVar } from './env.js';

// Per-app request budget. Every generated app (project) is capped at
// APP_REQ_PER_MIN requests per minute across its whole public surface:
// preview serving, BaaS storage, live events and function calls.
// 200_000/min by default = a generous ceiling that still stops one runaway
// app from drowning the platform.

const WINDOW_MS = 60_000;
const hits = new Map();
let lastCleanup = 0;

export function appLimitMax() {
  const v = Number(getVar('APP_REQ_PER_MIN'));
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 200_000;
}

function cleanup(now) {
  if (now - lastCleanup < WINDOW_MS) return;
  lastCleanup = now;
  for (const [k, rec] of hits) {
    if (now - rec.t0 > WINDOW_MS) hits.delete(k);
  }
}

export function appLimitCheck(pid) {
  if (!pid) return { over: false, remaining: 0, limit: appLimitMax() };
  const now = Date.now();
  cleanup(now);
  const limit = appLimitMax();
  const rec = hits.get(pid);
  if (!rec || now - rec.t0 > WINDOW_MS) {
    hits.set(pid, { t0: now, n: 1 });
    return { over: false, remaining: limit - 1, limit };
  }
  rec.n++;
  return { over: rec.n > limit, remaining: Math.max(0, limit - rec.n), limit };
}

export function projectIdOfPath(path) {
  const p = path || '';
  const perm = /^\/api\/(baas|projects)\/([^/]+)/.exec(p);
  if (perm && perm[2]) return perm[2];
  const prev = /^\/preview\/([^/]+)/.exec(p);
  if (prev && prev[1]) return prev[1];
  return '';
}