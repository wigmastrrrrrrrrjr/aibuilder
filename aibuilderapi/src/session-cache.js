// In-memory session->user cache. getSession hits the DB twice per call
// (session row + user row); rate-limit, vpn-block, and auth all resolve the
// same token on every request, so cache the resolved user briefly.
// Only non-null users are cached so a brand-new session works immediately.

import { store } from './store.js';

const TTL = 30000;           // 30s cache — logout propagates in under a minute
const MAX_TOKENS = 8192;
const cache = new Map();

export async function resolveSession(token) {
  if (!token) return null;
  if (typeof token === 'string' && token.length > 200) return store.getSession(token);

  const now = Date.now();
  const hit = cache.get(token);
  if (hit) {
    if (now - hit.t < TTL) return hit.u;
    cache.delete(token);
  }

  const u = await store.getSession(token);
  if (u) cache.set(token, { u, t: now });

  if (cache.size > MAX_TOKENS) {
    const cutoff = now - TTL;
    for (const [k, v] of cache) if (v.t < cutoff) cache.delete(k);
  }
  return u;
}

export function clearSession(token) {
  if (token) cache.delete(token);
}