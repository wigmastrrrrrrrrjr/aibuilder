// Proxy for Ollama Cloud's model catalogue.
// - With the built-in key: filtered to the free plan, ranked for coding,
//   and a "recommended" pick is returned as the UI default.
// - With a user-supplied key (x-api-key header): the full catalogue for
//   whatever plan that key entitles, unfiltered.

import { extractKey, builtinKey } from './keys.js';

const BASE = 'https://ollama.com/api/tags';
const cache = { t: 0, names: [] };

// Models included in Ollama Cloud's free tier (rate-limited).
const FREE_MODELS = new Set([
  'gemma4:31b',
  'gpt-oss:20b',
  'gpt-oss:120b',
  'deepseek-v4-flash:0731',
  'deepseek-v4-flash:preview',
  'nemotron-3-nano:30b',
  'nemotron-3-super',
  'glm-5.1',
  'minimax-m2.7',
]);

// Best-for-coding preference order within the free tier.
const CODING_RANK = [
  'gemma4:31b',
  'gpt-oss:120b',
  'deepseek-v4-flash:0731',
  'glm-5.1',
  'nemotron-3-super',
  'minimax-m2.7',
  'gpt-oss:20b',
  'nemotron-3-nano:30b',
  'deepseek-v4-flash:preview',
];

export const models = {
  recommended() {
    const avail = cache.names.length ? cache.names : [...FREE_MODELS];
    return CODING_RANK.find(m => avail.includes(m)) || avail[0] || 'gpt-oss:120b';
  },

  async list(c) {
    const userKey = extractKey(c.req.header('x-api-key'));
    const key = userKey || builtinKey();
    if (!key) return c.json({ error: 'OLLAMA_API_KEY missing' }, 500);

    const bypassFreeFilter = Boolean(userKey) ||
      String(process.env.ALLOW_ALL_MODELS || '') === '1';

    // Per-key catalogue cache (built-in key cached; user keys fetched fresh).
    if (!userKey && (cache.names.length === 0 || Date.now() - cache.t > 120_000) ||
        userKey) {
      try {
        const r = await fetch(BASE, { headers: { Authorization: `Bearer ${key}` } });
        if (r.ok) {
          const j = await r.json();
          const names = (j.models || []).map(m => m.name).filter(Boolean);
          if (userKey) {
            return c.json({
              models: sortForCoding(names),
              recommended: this.recommended(),
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
      recommended: this.recommended(),
      freePlanOnly: !bypassFreeFilter,
    });
  },
};

function sortForCoding(names) {
  return [...names].sort((a, b) => {
    const ra = CODING_RANK.indexOf(a); const rb = CODING_RANK.indexOf(b);
    return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
  });
}
