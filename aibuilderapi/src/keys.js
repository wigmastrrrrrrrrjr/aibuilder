// Per-request API key resolution: user-supplied key (BYOK) wins, otherwise the
// built-in key from .env/env vars is used. User keys are never persisted server-side.

export function extractKey(...candidates) {
  for (const k of candidates) {
    if (typeof k !== 'string') continue;
    const t = k.trim();
    if (t.length >= 10 && t.length <= 200 && !/\s/.test(t)) return t;
  }
  return '';
}

export function builtinKey() {
  const k = process.env.OLLAMA_API_KEY;
  return k && !k.startsWith('your_') ? k : '';
}
