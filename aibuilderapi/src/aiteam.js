import { Hono } from 'hono';
import { rateLimit } from './rate-limit.js';
import { getVar } from './env.js';
import { builtinKey } from './keys.js';
import { openrouterKey, mistralKey, localOllamaUrl } from './keys.js';

const OLLAMA_URL = 'https://ollama.com/api/chat';
const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL_RE = /^[A-Za-z0-9._:/+%-]{1,64}$/;

export const PERSONAS = [
  { id: 'pm',     name: 'Mira',  role: 'Product Lead',        discipline: 'scope, MVP, user flows and success metrics',           emoji: '🌱', color: '#818cf8' },
  { id: 'design', name: 'Kazu',  role: 'Experience Designer', discipline: 'visual direction, layout, tone and accessibility',       emoji: '🎨', color: '#f472b6' },
  { id: 'arch',   name: 'Odin',  role: 'Backend Architect',   discipline: 'data model, API surface, auth and storage',              emoji: '🗂️', color: '#2dd4bf' },
  { id: 'sec',    name: 'Rae',   role: 'Security Reviewer',   discipline: 'threats, input validation, authz and data safety',       emoji: '🛡️', color: '#f87171' },
  { id: 'perf',   name: 'Piko',  role: 'Performance Engineer',discipline: 'fast loads, small footprint, caching and edge cases',     emoji: '⚡', color: '#fbbf24' },
  { id: 'growth', name: 'Sage',  role: 'Growth Strategist',   discipline: 'audience, positioning, naming and launch',               emoji: '🚀', color: '#4ade80' },
];

const SPEAK_PROMPT = `You are one member of a small AI product team cooperating on a single web app.
Stay squarely in YOUR discipline. What you say is seen by your teammates next, so:
- Build on what earlier speakers said when it helps, but never repeat their points.
- Be specific and concrete — give actual structure, fields, flows, risks, or names, not fluff.
- Short lines or bullets, under 180 words, no section headings, no greetings, no sign-off.
- If another teammate proposed something wrong in your discipline, call it out in one terset line, then move on.`;

const MAX_TURNS = 3;

export const aiteam = new Hono();

aiteam.use('/turn', rateLimit({ windowMs: 60_000, max: 15 }));

async function upstream(model, messages, key) {
  const orKey = openrouterKey();
  const mk = mistralKey();
  const base = await localOllamaUrl();
  const wantOR = typeof model === 'string' && (model.includes('/') || model === 'openrouter/free');
  const wantLocal = typeof model === 'string' && model.startsWith('local:');
  const orModel = wantOR ? model : 'openrouter/free';
  const localModel = wantLocal ? model.slice(6) : 'gemma3:4b';
  const signal = AbortSignal.timeout(90_000);

  if (wantLocal && base) {
    const r = await fetch(`${base}/api/chat`, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: localModel, messages, stream: false }),
    });
    const j = await r.json().catch(() => ({}));
    return String(j.message?.content || '');
  }
  if (orKey) {
    const r = await fetch(OPENROUTER_URL, {
      method: 'POST', signal,
      headers: { authorization: `Bearer ${orKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: orModel, messages, stream: false }),
    });
    const j = await r.json().catch(() => ({}));
    return String(j.choices?.[0]?.message?.content || '');
  }
  if (mk) {
    const r = await fetch(MISTRAL_URL, {
      method: 'POST', signal,
      headers: { authorization: `Bearer ${mk}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mistral-small-latest', messages, stream: false }),
    });
    const j = await r.json().catch(() => ({}));
    return String(j.choices?.[0]?.message?.content || '');
  }
  if (key) {
    const r = await fetch(OLLAMA_URL, {
      method: 'POST', signal,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: getVar('OLLAMA_MODEL') || 'gpt-oss:120b', messages, stream: false }),
    });
    const j = await r.json().catch(() => ({}));
    return String(j.message?.content || '');
  }
  return '';
}

function clean(text) {
  return String(text || '').replace(/```[a-z]*/gi, '').replace(/`/g, '').trim();
}

aiteam.post('/turn', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const idea = String(body.idea || '').trim();
  const members = Array.isArray(body.members) ? body.members.slice(0, MAX_TURNS) : [];
  const transcript = String(body.transcript || '').slice(0, 6000);
  const model = String(body.model || '').trim();

  if (!idea || idea.length > 400) return c.json({ error: 'idea: 1-400 chars' }, 400);
  const picked = [];
  for (const id of members) {
    const p = PERSONAS.find((x) => x.id === id);
    if (!p || picked.includes(p)) return c.json({ error: 'unknown or duplicate member' }, 400);
    picked.push(p);
  }
  if (!picked.length) return c.json({ error: 'pick at least one member' }, 400);

  const persona = picked;
  const key = builtinKey();
  let haveProvider = Boolean(openrouterKey() || mistralKey() || key);
  if (!haveProvider) {
    const lok = await localOllamaUrl();
    haveProvider = Boolean(lok);
  }
  if (!haveProvider && !model) {
    return c.json({ error: 'no provider key configured for the AI team yet' }, 500);
  }

  const texts = [];
  for (let i = 0; i < picked.length; i++) {
    const p = picked[i];
    const prior = transcript
      ? transcript
      : (texts.length ? texts.map((t) => t.text).join('\n\n') : '');
    const messages = [
      { role: 'system', content: SPEAK_PROMPT },
      {
        role: 'user',
        content: `PROJECT IDEA: ${idea}\n\nWHAT THE TEAM HAS SAID SO FAR:\n${prior || '(You are opening the brainstorm — first take on it.)'}\n\nNow it is your turn, ${p.name} — ${p.role}. Cover: ${p.discipline}.`,
      },
    ];
    const text = clean(await upstream(model, messages, key));
    if (!text) throw new Error(`${p.name} returned nothing — model unavailable?`);
    texts.push({ member: p, text });
  }

  return c.json({ ok: true, team: texts });
});