// Per-request API key resolution: user-supplied key (BYOK) wins, otherwise the
// built-in key from .env/env vars is used. User keys are never persisted server-side.

import { getVar } from './env.js';

export function extractKey(...candidates) {
  for (const k of candidates) {
    if (typeof k !== 'string') continue;
    const t = k.trim();
    if (t.length >= 10 && t.length <= 200 && !/\s/.test(t)) return t;
  }
  return '';
}

export function builtinKey() {
  const k = getVar('OLLAMA_API_KEY');
  return k && !k.startsWith('your_') ? k : '';
}

export function mistralKey() {
  const k = getVar('MISTRAL_API_KEY');
  return k && !k.startsWith('your_') ? k : '';
}

export function openrouterKey() {
  const k = getVar('OPENROUTER_API_KEY');
  return k && !k.startsWith('your_') ? k : '';
}

// LOCAL_OLLAMA_URL (static) wins; otherwise fall back to a runtime beacon —
// a raw gist (or any URL returning a plain https URL) that a Kaggle session
// keeps refreshing with its current cloudflared tunnel URL. Cached ~3 min.
let _beaconCache = { url: '', at: 0 };
const BEACON_TTL = 180_000;

function validBase(u) {
  if (typeof u !== 'string') return '';
  u = u.trim().replace(/\/+$/, '');
  if (!u.startsWith('https://') || u.length > 200) return '';
  if (!/^[A-Za-z0-9._:-]+(?::[0-9]{1,5})?$/.test(u.replace(/^https:\/\//, '').split('/')[0])) return '';
  return u;
}

async function beaconUrl() {
  const beacon = getVar('LOCAL_OLLAMA_BEACON');
  if (!beacon || !beacon.startsWith('https://')) return '';
  if (_beaconCache.url && Date.now() - _beaconCache.at < BEACON_TTL) return _beaconCache.url;
  try {
    const r = await fetch(beacon, { headers: { 'User-Agent': 'aib-terminal/0.1' } });
    if (!r.ok) return _beaconCache.url;
    const url = validBase(await r.text());
    if (url) {
      _beaconCache = { url, at: Date.now() };
      return url;
    }
  } catch { /* keep last known */ }
  return _beaconCache.url;
}

export async function localOllamaUrl() {
  const u = getVar('LOCAL_OLLAMA_URL');
  if (u && u.startsWith('http')) return u.replace(/\/+$/, '');
  return beaconUrl();
}
