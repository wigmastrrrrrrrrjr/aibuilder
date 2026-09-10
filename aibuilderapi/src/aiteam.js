import { Hono } from 'hono';
import { rateLimit } from './rate-limit.js';
import { getVar } from './env.js';
import { builtinKey } from './keys.js';
import { openrouterKey, mistralKey, localOllamaUrl } from './keys.js';

const OLLAMA_URL = 'https://ollama.com/api/chat';
const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

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
const SIGNAL_MS = 180_000;

export const aiteam = new Hono();

aiteam.use('/turn', rateLimit({ windowMs: 60_000, max: 15 }));

function personaPublic(p) {
  return { id: p.id, name: p.name, role: p.role, emoji: p.emoji, color: p.color };
}

async function openStream(model, messages, signal) {
  const orKey = openrouterKey();
  const mk = mistralKey();
  const key = builtinKey();
  const base = await localOllamaUrl();
  const wantOR = typeof model === 'string' && (model.includes('/') || model === 'openrouter/free');
  const wantLocal = typeof model === 'string' && model.startsWith('local:');
  const orModel = wantOR ? model : 'openrouter/free';
  const localModel = wantLocal ? model.slice(6) : 'gemma3:4b';

  if (wantLocal && base) {
    const r = await fetch(`${base}/api/chat`, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: localModel, messages, stream: true }),
    });
    return { res: r, shape: 'ollama' };
  }
  if (orKey) {
    const r = await fetch(OPENROUTER_URL, {
      method: 'POST', signal,
      headers: { authorization: `Bearer ${orKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: orModel, messages, stream: true }),
    });
    return { res: r, shape: 'chat' };
  }
  if (mk) {
    const r = await fetch(MISTRAL_URL, {
      method: 'POST', signal,
      headers: { authorization: `Bearer ${mk}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mistral-small-latest', messages, stream: true }),
    });
    return { res: r, shape: 'chat' };
  }
  if (key) {
    const r = await fetch(OLLAMA_URL, {
      method: 'POST', signal,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: getVar('OLLAMA_MODEL') || 'gpt-oss:120b', messages, stream: true }),
    });
    return { res: r, shape: 'ollama' };
  }
  return null;
}

// Stream only the answer content — reasoning/thinking is never forwarded.
// Returns the full text; `send` receives purposeful token fragments.
async function streamText(model, messages, send) {
  const ac = new AbortController();
  const sig = AbortSignal.any([ac.signal, AbortSignal.timeout(SIGNAL_MS)]);
  const opened = await openStream(model, messages, sig);
  if (!opened) throw new Error('no provider key configured for the AI team yet');
  const r = opened.res;
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`provider ${r.status}: ${t.slice(0, 160)}`);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let lineBuf = '';
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    lineBuf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = lineBuf.indexOf('\n')) !== -1) {
      const line = lineBuf.slice(0, nl).trim();
      lineBuf = lineBuf.slice(nl + 1);
      if (!line || line === 'data: [DONE]') continue;
      let j;
      try {
        const payload = line.startsWith('data: ') ? line.slice(6) : line;
        j = JSON.parse(payload);
      } catch { continue; }
      let tok = '';
      if (opened.shape === 'chat') {
        tok = j?.choices?.[0]?.delta?.content ?? '';
      } else {
        const msg = j?.message ?? {};
        tok = msg.content ?? '';
      }
      if (!tok) continue;
      full += tok;
      send(tok);
    }
  }
  if (!full.trim()) throw new Error('model returned no message');
  return full;
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

  let controller;
  const ac = new AbortController();
  const stream = new ReadableStream({
    async start(ctl) {
      controller = ctl;
      const send = (ev) => {
        try { controller.enqueue(`data: ${JSON.stringify(ev)}\n\n`); } catch { ac.abort(); }
      };
      try {
        send({ type: 'meta', idea, members: picked.map(personaPublic) });
        let roundPrior = '';
        for (const p of picked) {
          const priorParts = [];
          if (transcript) priorParts.push(transcript);
          if (roundPrior) priorParts.push(roundPrior);
          const messages = [
            { role: 'system', content: SPEAK_PROMPT },
            {
              role: 'user',
              content: `PROJECT IDEA: ${idea}\n\nWHAT THE TEAM HAS SAID SO FAR:\n${priorParts.join('\n\n') || '(You are opening the brainstorm — first take on it.)'}\n\nNow it is your turn, ${p.name} — ${p.role}. Cover: ${p.discipline}.`,
            },
          ];
          send({ type: 'turn', member: personaPublic(p) });
          const full = await streamText(model, messages, (tok) => send({ type: 'token', v: tok }));
          roundPrior += (roundPrior ? '\n\n' : '') + `${p.name} (${p.role}): ${full}`;
          send({ type: 'done', member: personaPublic(p) });
        }
      } catch (e) {
        send({ type: 'error', message: `AI team failed: ${String(e.message || e).slice(0, 160)}` });
      } finally {
        controller.close();
      }
    },
    cancel() { ac.abort(); },
  });

  return c.newResponse(stream, 200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
  });
});