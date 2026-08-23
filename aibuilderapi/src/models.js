// Proxy for Ollama Cloud's model catalogue.
// - With the built-in key: filtered to the free plan, ranked for coding,
//   and a "recommended" pick is returned as the UI default.
// - With a user-supplied key (x-api-key header): the full catalogue for
//   whatever plan that key entitles, unfiltered.

import { Hono } from 'hono';
import { extractKey, builtinKey } from './keys.js';
import { getVar } from './env.js';

const BASE = 'https://ollama.com/api/tags';
const cache = { t: 0, names: [] };

// Models the free plan can actually run (verified via /api/chat probes;
// see test/probe-models.sh to re-check after Ollama changes entitlements).
const FREE_MODELS = new Set([
  'gemma4:31b',
  'gpt-oss:120b',
  'gpt-oss:20b',
  'nemotron-3-super',
  'nemotron-3-nano:30b',
]);

// Best-for-coding preference order within the free tier.
const CODING_RANK = [
  'gemma4:31b',
  'gpt-oss:120b',
  'gpt-oss:20b',
  'nemotron-3-super',
  'nemotron-3-nano:30b',
];

export const models = new Hono();

function sortForCoding(names) {
  return [...names].sort((a, b) => {
    const ra = CODING_RANK.indexOf(a); const rb = CODING_RANK.indexOf(b);
    return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
  });
}

models.get('/', async (c) => {
  const userKey = extractKey(c.req.header('x-api-key'));
  const key = userKey || builtinKey();

  // No key configured at all? Still populate the dropdown with the known
  // free-tier models so the UI works; chat will surface a clear error.
  if (!key) {
    return c.json({
      models: sortForCoding([...FREE_MODELS]),
      recommended: recommendedPick([...FREE_MODELS]),
      freePlanOnly: true,
      warning: 'server has no OLLAMA_API_KEY secret — set it via: npm --prefix aibuilderapi run secret:key',
    });
  }

  const bypassFreeFilter = Boolean(userKey) || String(getVar('ALLOW_ALL_MODELS') || '') === '1';

  // Per-key catalogue cache (built-in key cached; user keys fetched fresh).
  if (!userKey && (cache.names.length === 0 || Date.now() - cache.t > 120_000) || userKey) {
    try {
      const r = await fetch(BASE, { headers: { Authorization: `Bearer ${key}` } });
      if (r.ok) {
        const j = await r.json();
        const names = (j.models || []).map(m => m.name).filter(Boolean);
        if (userKey) {
          return c.json({
            models: sortForCoding(names),
            recommended: recommendedPick(names.length ? names : [...FREE_MODELS]),
            freePlanOnly: false,
            usingOwnKey: true,
          });
        }
        cache.names = names;
        cache.t = Date.now();
      } else if (userKey) {
        return c.json({ error: `Your API key was rejected by ollama.com (HTTP ${r.status})` }, 401);
      }
    } catch { /* serve stale/empty */ }
  }

  let names = cache.names;
  if (!bypassFreeFilter) {
    names = names.filter(n => FREE_MODELS.has(n));
    if (!names.length) names = [...FREE_MODELS]; // offline fallback
  }
  return c.json({
    models: sortForCoding(names),
    recommended: recommendedPick(names.length ? names : [...FREE_MODELS]),
    freePlanOnly: !bypassFreeFilter,
  });
});

function recommendedPick(avail) {
  return CODING_RANK.find(m => avail.includes(m)) || avail[0] || 'gemma4:31b';
}
