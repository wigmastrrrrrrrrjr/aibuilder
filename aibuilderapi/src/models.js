// Proxy for Ollama Cloud's model catalogue.
// - With the built-in key: filtered to the free plan, ranked for coding,
//   and a "recommended" pick is returned as the UI default.
// - With a user-supplied key (x-api-key header): the full catalogue for
//   whatever plan that key entitles, unfiltered.

import { Hono } from 'hono';
import { extractKey, builtinKey, mistralKey, localOllamaUrl, openrouterKey } from './keys.js';
import { getVar } from './env.js';

const BASE = 'https://ollama.com/api/tags';
const OR_BASE = 'https://openrouter.ai/api/v1/models';
const cache = { t: 0, names: [] };
const orCache = { t: 0, names: [] };

// Models the free plan can actually run (verified via /api/chat probes;
// see test/probe-models.sh to re-check after Ollama changes entitlements).
const FREE_MODELS = new Set([
  'gemma4:31b',
  'gpt-oss:120b',
  'gpt-oss:20b',
  'minimax-m3',
  'nemotron-3-nano:30b',
  'nemotron-3-super',
  'nemotron-3-ultra',
]);

// OpenRouter's :free endpoints (no credit card, rate-limited per key).
// Live catalogue is fetched when OPENROUTER_API_KEY is configured; this is
// the offline/fallback snapshot (synced with the live list Aug 2026).
const OR_FREE_MODELS = new Set([
  'z-ai/glm-5.2:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'nvidia/nemotron-3.5-lightning:free',
  'nvidia/nemotron-3.5-content-safety:free',
  'minimax/minimax-m3:free',
  'minimax/minimax-m2.7:free',
  'poolside/laguna-s-2.1:free',
  'poolside/laguna-xs-2.1:free',
  'cohere/north-mini-code:free',
  'inclusionai/ling-3.0-flash-fin:free',
  'liquid/lfm-2.5-2.6b:free',
  'dots-studio/dots-3-note-preview:free',
  'thinkingmachines/inkling:free',
  'thinkingmachines/inkling-small:free',
  'openrouter/free', // auto-router: picks the best free model per request
]);

// Best-for-coding preference order within the free tier.
const CODING_RANK = [
  'gpt-oss:120b',
  'gemma4:31b',
  'nemotron-3-ultra',
  'nemotron-3-super',
  'gpt-oss:20b',
  'minimax-m3',
  'nemotron-3-nano:30b',
];

// Free daily credit grant, reset at midnight UTC.
export const FREE_DAILY_CREDITS = 30;

// Credits are stored as integer units of 1/10 credit so fractional costs
// (local models = 0.4) fit the integer usage table.
export const CREDIT_PRECISION = 10;
export const creditsToUnits = (c) => Math.round(c * CREDIT_PRECISION);
export const unitsToCredits = (u) => u / CREDIT_PRECISION;

// Cost in credits for one chat request, keyed by model.
// - top-tier coding models: 9
// - everything else on the shared free tier: 4
// - mistral fallback: 10
// - local (own tunnel) models: 0.4  → ~75 messages/day on the free grant
const CREDIT_COST = {
  'gpt-oss:120b': 9,
  'gemma4:31b': 9,
  'nemotron-3-ultra': 9,
  'mistral-small-latest': 10,
};
const FREE_TIER_COST = 4;
const LOCAL_COST = 0.4;

export function modelCost(model) {
  if (typeof model === 'string' && model.startsWith('local:')) return LOCAL_COST;
  if (typeof model === 'string' && (model.endsWith(':free') || model === 'openrouter/free')) return FREE_TIER_COST;
  return CREDIT_COST[model] || FREE_TIER_COST;
}

export const models = new Hono();

function sortForCoding(names) {
  return [...names].sort((a, b) => {
    const ra = rankOf(a); const rb = rankOf(b);
    return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
  });
}

// OpenRouter free coding picks rank just below Ollama's top tier.
const OR_RANK = ['z-ai/glm-5.2:free', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'cohere/north-mini-code:free'];
function rankOf(m) {
  const i = CODING_RANK.indexOf(m);
  if (i !== -1) return i;
  const j = OR_RANK.indexOf(m);
  if (j !== -1) return CODING_RANK.length + 1 + j;
  return -1;
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

  // Fetch OpenRouter's :free catalogue (only if a key is configured) and add
  // those model names to the dropdown, sorted for coding after the Ollama set.
  const orKey = openrouterKey();
  const orNames = [];
  if (orKey) {
    if (orCache.names.length === 0 || Date.now() - orCache.t > 3600_000) {
      try {
        const or = await fetch(OR_BASE, { headers: { Authorization: `Bearer ${orKey}` } });
        if (or.ok) {
          const oj = await or.json();
          orCache.names = (oj.data || [])
            .map(m => m.id)
            .filter(id => id === 'openrouter/free' || id.endsWith(':free'));
        }
        orCache.t = Date.now();
      } catch { /* serve fallback */ }
    }
    orNames.push(...(orCache.names.length ? orCache.names : [...OR_FREE_MODELS]));
  }

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
  // Append Mistral fallback model if key is configured and not already in list
  if (mistralKey() && !names.includes('mistral-small-latest')) {
    names.push('mistral-small-latest');
  }
  // Append local Ollama models if tunnel is configured
  const localUrl = localOllamaUrl();
  if (localUrl) {
    const LOCAL_MODELS = ['local:qwen2.5:0.5b-instruct', 'local:qwen2.5:1.5b', 'local:tinyllama:1.1b'];
    for (const m of LOCAL_MODELS) {
      if (!names.includes(m)) names.push(m);
    }
  }
  // Append OpenRouter free models (only when a key is configured)
  if (orKey) {
    for (const m of orNames) {
      if (!names.includes(m)) names.push(m);
    }
  }
  return c.json({
    models: sortForCoding(names),
    recommended: recommendedPick(names.length ? names : [...FREE_MODELS]),
    freePlanOnly: !bypassFreeFilter,
    openrouter: Boolean(orKey),
  });
});

function recommendedPick(avail) {
  return CODING_RANK.find(m => avail.includes(m)) || OR_RANK.find(m => avail.includes(m)) || avail[0] || 'gemma4:31b';
}
