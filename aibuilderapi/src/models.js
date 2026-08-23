// Proxy for Ollama Cloud's model catalogue, with a small TTL cache.

const BASE = 'https://ollama.com/api/tags';
const cache = { t: 0, names: [] };

export const models = {
  async list(c) {
    const key = process.env.OLLAMA_API_KEY;
    if (!key || key.startsWith('your_')) {
      return c.json({ error: 'OLLAMA_API_KEY missing' }, 500);
    }
    if (Date.now() - cache.t > 60_000 && cache.names.length === 0 || Date.now() - cache.t > 120_000) {
      try {
        const r = await fetch(BASE, { headers: { Authorization: `Bearer ${key}` } });
        if (r.ok) {
          const j = await r.json();
          cache.names = (j.models || []).map(m => m.name).filter(Boolean);
          cache.t = Date.now();
        }
      } catch { /* serve stale/empty */ }
    }
    return c.json({ models: cache.names, cachedFor: Math.max(0, 120_000 - (Date.now() - cache.t)) });
  },
};
