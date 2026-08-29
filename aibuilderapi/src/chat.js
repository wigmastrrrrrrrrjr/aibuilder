import { Hono } from 'hono';
import { store } from './store.js';
import { FileStreamer } from './parser.js';
import { systemPrompt } from './prompt.js';
import { extractKey, builtinKey, localOllamaUrl, openrouterKey } from './keys.js';
import { getVar } from './env.js';
import { getUser, canWrite } from './auth.js';
import { createClient } from '@supabase/supabase-js';

const OLLAMA_URL = 'https://ollama.com/api/chat';
const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MISTRAL_MODEL = 'mistral-small-latest';
const MODEL_RE = /^[A-Za-z0-9._:/+%-]{1,64}$/;
const SUB_AGENT_PROMPT = `You are a sub-agent of AIBuilder, an expert engineer, working on ONE file as part of a larger web app that another engineer is building.
Respond with a single generator block that writes your assigned file:
<<<FILE:path>>>
complete, polished file content
<<<END>>>
Rules:
- Write EXACTLY the assigned file. Do not invent other files, do not edit or delete anything.
- Do not use EDIT, DELETE, PLAN, NAME or DELEGATE blocks. Only one FILE block.
- Do not explain or narrate. Match the app's existing style and conventions.
- The file must be complete and self-contained so it works on its own.`;

const SUB_LOCAL_MODEL = 'tinyllama:1.1b';
const OR_SUB_MODEL = 'z-ai/glm-5.2:free';
const PROVIDER_CAPS = { mistral: 4, ollama: 4, local: 4, openrouter: 4 };
const active = { mistral: 0, ollama: 0, local: 0, openrouter: 0 };
let subRound = 0;

export const chat = new Hono();

chat.post('/', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'sign in required' }, 401);

  const body = await c.req.json();
  const message = body?.message;
  if (!message || typeof message !== 'string') {
    return c.json({ error: 'message required' }, 400);
  }

  // BYOK: a user-supplied key (x-api-key header or body.apiKey) takes priority
  // over the built-in platform key. It is used for this request only.
  const isLocalModel = typeof body.model === 'string' && body.model.startsWith('local:');
  const key = extractKey(
    c.req.header('x-api-key'),
    typeof body.apiKey === 'string' ? body.apiKey : '',
  ) || builtinKey();
  if (!key && !isLocalModel) {
    return c.json({ error: 'no API key — add one in the UI (🔑) or set OLLAMA_API_KEY/MISTRAL_API_KEY in .env' }, 500);
  }
  {
    const reqOR = typeof body.model === 'string'
      && (body.model.includes('/') || body.model === 'openrouter/free');
    if (reqOR && !openrouterKey()) {
      return c.json({ error: 'no OPENROUTER_API_KEY configured — set it to use OpenRouter free models' }, 500);
    }
  }

  let pid = body.projectId;
  let project = null;
  if (pid) {
    project = await store.getProject(pid);
    if (!project) pid = null;
    else if (!(await canWrite(project, user))) return c.json({ error: "you don't own this project" }, 403);
  }
  if (!project) {
    // the owner names the project themselves — never name it after the prompt
    pid = (await store.createProject(undefined, user.name)).id;
  }

  // Concurrency cap: at most 10 people live on one project at once. Presence is
  // keyed per client (sid = browser tab), so 10 tabs/people = the working set.
  {
    const sid = String(body.sid || '').trim().slice(0, 64) || `cli:${crypto.randomUUID().slice(0, 12)}`;
    try {
      const pr = await store.touchPresence(project.id, sid, user.name, Date.now());
      if (!pr.accepted) {
        return c.json({
          error: 'This project is at its 10-people live limit right now. Wait a moment for a spot, or open it read-only.',
          presence: { active: pr.active, limit: 10 },
        }, 429);
      }
    } catch { /* presence is best-effort */ }
  }

  // model precedence: request > stored on project > env default
  const requested = typeof body.model === 'string' && MODEL_RE.test(body.model) ? body.model : '';
  const model = requested || (project && MODEL_RE.test(project.model || '') ? project.model : '')
    || getVar('OLLAMA_MODEL') || 'gemma4:31b';
  const isORModel = typeof model === 'string' && (model.includes('/') || model === 'openrouter/free');
  const orKey = openrouterKey();

  // Chat is rate-limited only (3000 req/min per IP in app.js) — no per-request
  // credit cost. Credit balances are still tracked for the gift feature.
  await store.setModel(pid, model);

  const history = (await store.history(pid)).map(m => ({ role: m.role, content: m.content }));
  const fileCtx = await buildFileContext(pid);
  const messages = [
    { role: 'system', content: systemPrompt() + fileCtx },
    ...history,
    { role: 'user', content: message },
  ];
  await store.addMessage(pid, 'user', message, user.name);

  // Client-cancel propagates to the upstream request.
  const ac = new AbortController();
  c.req.raw.signal.addEventListener('abort', () => ac.abort());

  const enc = new TextEncoder();
  const streamBody = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (ev) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
        } catch { closed = true; }
      };
      send({ type: 'meta', projectId: pid, model });

      const mistralKey = getVar('MISTRAL_API_KEY') || '';

      const tryOllama = async () => {
        const r = await fetch(OLLAMA_URL, {
          method: 'POST',
          signal: AbortSignal.any([ac.signal, AbortSignal.timeout(300000)]),
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages, stream: true }),
        });
        if (!r.ok) throw new Error(`ollama ${r.status}`);
        return { response: r, provider: 'ollama' };
      };

      const tryMistral = async () => {
        if (!mistralKey) throw new Error('no MISTRAL_API_KEY configured');
        const r = await fetch(MISTRAL_URL, {
          method: 'POST',
          signal: AbortSignal.any([ac.signal, AbortSignal.timeout(300000)]),
          headers: { Authorization: `Bearer ${mistralKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: MISTRAL_MODEL, messages, stream: true }),
        });
        if (!r.ok) {
          const t = await r.text().catch(() => '');
          throw new Error(`mistral ${r.status}: ${t.slice(0, 200)}`);
        }
        return { response: r, provider: 'mistral' };
      };

      const localUrl = localOllamaUrl();
      const isLocalModel = typeof model === 'string' && model.startsWith('local:');
      const localModel = isLocalModel ? model.slice(6) : model;

      const tryLocal = async () => {
        if (!localUrl) throw new Error('no LOCAL_OLLAMA_URL configured');
        const r = await fetch(`${localUrl}/api/chat`, {
          method: 'POST',
          signal: AbortSignal.any([ac.signal, AbortSignal.timeout(300000)]),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: localModel, messages, stream: true }),
        });
        if (!r.ok) throw new Error(`local ollama ${r.status}`);
        return { response: r, provider: 'local' };
      };

      const tryOpenRouter = async () => {
        if (!orKey) throw new Error('no OPENROUTER_API_KEY configured');
        const r = await fetch(OPENROUTER_URL, {
          method: 'POST',
          signal: AbortSignal.any([ac.signal, AbortSignal.timeout(300000)]),
          headers: {
            Authorization: `Bearer ${orKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/wigmastrrrrrrrrjr/aibuilder',
            'X-Title': 'aibuilder',
          },
          body: JSON.stringify({ model, messages, stream: true }),
        });
        if (!r.ok) {
          const t = await r.text().catch(() => '');
          throw new Error(`openrouter ${r.status}: ${t.slice(0, 200)}`);
        }
        return { response: r, provider: 'openrouter' };
      };

      let upstream;
      let provider = 'ollama';

      if (isORModel) {
        try {
          ({ response: upstream, provider } = await tryOpenRouter());
        } catch (e) {
          send({ type: 'error', message: `openrouter failed: ${e.message}` });
          try { controller.close(); } catch {}
          return;
        }
      } else if (isLocalModel && localUrl) {
        try {
          ({ response: upstream, provider } = await tryLocal());
        } catch (e) {
          send({ type: 'error', message: `local ollama failed: ${e.message}` });
          try { controller.close(); } catch {}
          return;
        }
      } else {
        try {
          ({ response: upstream, provider } = await tryOllama());
        } catch (e1) {
          send({ type: 'warn', message: `ollama failed (${e1.message}), trying mistral...` });
          try {
            ({ response: upstream, provider } = await tryMistral());
          } catch (e2) {
            send({ type: 'warn', message: `mistral failed (${e2.message}), trying local...` });
            try {
              ({ response: upstream, provider } = await tryLocal());
            } catch (e3) {
              send({ type: 'error', message: `all providers down: ollama: ${e1.message}; mistral: ${e2.message}; local: ${e3.message}` });
              try { controller.close(); } catch {}
              return;
            }
          }
        }
      }
      active[provider]++;

      const parser = new FileStreamer();
      const written = [];
      const edited = [];
      const deleted = [];
      const renamed = [];
      const assets = [];
      const runs = [];
      const seeds = [];
      const subAgentTasks = [];
      let ops = 0;
      let refactorSent = false;
      let inBatch = false;
      const batchOps = [];
      const maybeRefactor = () => {
        if (!refactorSent && (deleted.length >= 2 || edited.length >= 3 || ops >= 6)) {
          refactorSent = true;
          send({ type: 'refactor' });
        }
      };

      // apply one generator op; returns an SSE event for the client
      const handleGen = async (ev) => {
        if (ev.type === 'batch') { inBatch = true; return; }
        if (ev.type === 'endbatch') { inBatch = false; await flushBatch(); return; }
        if (ev.batch && inBatch) { batchOps.push(ev); return; }
        if (ev.type === 'file' && ev.path) {
          await store.saveFile(pid, ev.path, ev.content);
          written.push(ev.path);
          ops++;
          maybeRefactor();
          send({ type: 'file', path: ev.path });
        } else if (ev.type === 'edit' && ev.path) {
          const res = await applyEdit(pid, ev.path, ev.hunks || []);
          if (res.ok) {
            edited.push(ev.path);
            ops++;
            maybeRefactor();
            send({ type: 'edit', path: ev.path });
          } else {
            send({ type: 'warn', message: `edit failed on ${ev.path}: ${res.error}` });
          }
        } else if (ev.type === 'delete' && ev.path) {
          try {
            await store.deleteFile(pid, ev.path);
            deleted.push(ev.path);
            ops++;
            maybeRefactor();
            send({ type: 'delete', path: ev.path });
          } catch (e) {
            send({ type: 'warn', message: `delete failed on ${ev.path}: ${e.message}` });
          }
        } else if (ev.type === 'rename' && ev.from && ev.to) {
          try {
            const refs = await applyRename(pid, ev.from, ev.to);
            renamed.push({ from: ev.from, to: ev.to });
            ops += 1 + refs;
            maybeRefactor();
            send({ type: 'rename', from: ev.from, to: ev.to, refs });
          } catch (e) {
            send({ type: 'warn', message: `rename failed: ${String(e.message || e)}` });
          }
        } else if (ev.type === 'asset' && ev.path) {
          try {
            await store.saveFile(pid, ev.path, ev.data, ev.encoding);
            assets.push(ev.path);
            ops++;
            maybeRefactor();
            send({ type: 'asset', path: ev.path, encoding: ev.encoding });
          } catch (e) {
            send({ type: 'warn', message: `asset failed on ${ev.path}: ${String(e.message || e)}` });
          }
        } else if (ev.type === 'run' && ev.name) {
          const res = await runFunction(pid, ev.name, ev.input);
          runs.push({ name: ev.name, ok: res.ok });
          send({ type: 'run', name: ev.name, ok: res.ok, error: res.error || null, result: res.result });
        } else if (ev.type === 'seed' && ev.collection) {
          try {
            const n = await seedCollection(pid, ev.collection, ev.items || [], ev.clear);
            seeds.push({ collection: ev.collection, n });
            ops++;
            maybeRefactor();
            send({ type: 'seed', collection: ev.collection, count: n });
          } catch (e) {
            send({ type: 'warn', message: `seed failed on ${ev.collection}: ${String(e.message || e)}` });
          }
        } else if (ev.type === 'plan') {
          try {
            await store.setPlan(pid, ev.items || []);
            send({ type: 'plan', items: ev.items || [] });
          } catch { /* plan is cosmetic */ }
        } else if (ev.type === 'name' && ev.name) {
          const nm = String(ev.name).trim().slice(0, 60);
          if (!nm) return;
          try {
            await store.rename(pid, nm);
            send({ type: 'name', name: nm, projectId: pid });
          } catch { /* cosmetic */ }
        } else if (ev.type === 'delegate' && ev.path) {
          const task = String(ev.task || '').trim();
          if (!task) return;
          if (subAgentTasks.length >= 4) {
            send({ type: 'warn', message: `sub-agent queue full — skipping delegate for ${ev.path}` });
            return;
          }
          send({ type: 'delegate', path: ev.path });
          subAgentTasks.push(spawnSubAgent(ev.path, task));
        }
      };
      // apply a queued BATCH group atomically-ish (sequentially, abort on first failure)
      const flushBatch = async () => {
        if (!batchOps.length) return;
        const opsToApply = batchOps.slice();
        batchOps.length = 0;
        for (const ev of opsToApply) {
          try {
            await handleGen({ ...ev, batch: false });
          } catch (e) {
            send({ type: 'warn', message: `batch op failed: ${String(e.message || e)}` });
            break;
          }
        }
      };
      let raw = '';

      // Spin off a parallel sub-agent: a focused single-file generator that
      // runs concurrently with the main response and merges its FILE output in.
      const providerNames = ['mistral', 'ollama', 'local', 'openrouter'];
      const providerAvailable = (id) =>
        id === 'mistral' ? Boolean(mistralKey)
          : id === 'local' ? Boolean(localUrl)
            : id === 'openrouter' ? Boolean(orKey)
              : Boolean(key);
      const cloudModel = model.startsWith('local:') ? (getVar('OLLAMA_MODEL') || 'gemma4:31b') : model;

      // Route each sub-agent to a different provider than the main request
      // when slots are free, round-robin across providers that have capacity,
      // so Mistral never exceeds its 4-concurrent-model limit.
      const pickSubProvider = () => {
        const candidates = [];
        for (const id of providerNames) {
          if (id === provider || !providerAvailable(id)) continue;
          if (active[id] < PROVIDER_CAPS[id]) candidates.push(id);
        }
        if (!candidates.length && providerAvailable(provider) && active[provider] < PROVIDER_CAPS[provider]) candidates.push(provider);
        if (!candidates.length) return null;
        const p = candidates[subRound++ % candidates.length];
        active[p]++;
        return p;
      };

      const spawnSubAgent = async (subPath, task) => {
        const pid = pickSubProvider();
        if (!pid) throw new Error('all providers are at capacity — retry in a moment');
        const msg = [
          { role: 'system', content: SUB_AGENT_PROMPT },
          { role: 'user', content: `Your one assigned file: ${subPath}\n\n` +
            `Task from the main engineer:\n${task}\n\n` +
            `Return ONLY a single <<<FILE:${subPath}>>> ... <<<END>>> block.` },
        ];
        try {
          let r;
          if (pid === 'mistral') {
            r = await fetch(MISTRAL_URL, {
              method: 'POST',
              signal: AbortSignal.any([ac.signal, AbortSignal.timeout(300000)]),
              headers: { Authorization: `Bearer ${mistralKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: MISTRAL_MODEL, messages: msg, stream: true }),
            });
            if (!r.ok) throw new Error(`mistral ${r.status}`);
          } else if (pid === 'openrouter') {
            r = await fetch(OPENROUTER_URL, {
              method: 'POST',
              signal: AbortSignal.any([ac.signal, AbortSignal.timeout(300000)]),
              headers: {
                Authorization: `Bearer ${orKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://github.com/wigmastrrrrrrrrjr/aibuilder',
                'X-Title': 'aibuilder',
              },
              body: JSON.stringify({ model: OR_SUB_MODEL, messages: msg, stream: true }),
            });
            if (!r.ok) throw new Error(`openrouter ${r.status}`);
          } else if (pid === 'local') {
            r = await fetch(`${localUrl}/api/chat`, {
              method: 'POST',
              signal: AbortSignal.any([ac.signal, AbortSignal.timeout(300000)]),
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: SUB_LOCAL_MODEL, messages: msg, stream: true }),
            });
            if (!r.ok) throw new Error(`local ollama ${r.status}`);
          } else {
            r = await fetch(OLLAMA_URL, {
              method: 'POST',
              signal: AbortSignal.any([ac.signal, AbortSignal.timeout(300000)]),
              headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: cloudModel, messages: msg, stream: true }),
            });
            if (!r.ok) throw new Error(`ollama ${r.status}`);
          }
          const sp = new FileStreamer();
          const evs = [];
          const reader = r.body.getReader();
          const d = new TextDecoder();
          let lb = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            lb += d.decode(value, { stream: true });
            let nl;
            while ((nl = lb.indexOf('\n')) !== -1) {
              const line = lb.slice(0, nl).trim();
              lb = lb.slice(nl + 1);
              if (!line || line === 'data: [DONE]') continue;
              let j;
              try {
                const payload = line.startsWith('data: ') ? line.slice(6) : line;
                j = JSON.parse(payload);
              } catch { continue; }
              let tok = '';
              if (pid === 'mistral' || pid === 'openrouter') tok = j?.choices?.[0]?.delta?.content ?? '';
              else tok = j?.message?.content ?? '';
              if (!tok) continue;
              for (const ev of sp.feed(tok)) {
                if (ev.type === 'file' && ev.path) {
                  ev.path = subPath;
                  evs.push(ev);
                } else if (ev.type === 'file') {
                  evs.push(ev);
                }
              }
            }
          }
          for (const ev of sp.flush()) {
            if (ev.type === 'file' && ev.path) {
              ev.path = subPath;
              evs.push(ev);
            } else if (ev.type === 'file') {
              evs.push(ev);
            }
          }
          return { evs, provider: pid };
        } finally {
          active[pid]--;
        }
      };

      try {
      const reader = upstream.body.getReader();
      const dec = new TextDecoder();
      let lineBuf = '';
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
          if (provider === 'mistral' || provider === 'openrouter') {
            tok = j?.choices?.[0]?.delta?.content ?? '';
          } else {
            // ollama cloud + local ollama both use message.content
            const msg = j?.message ?? {};
            if (msg.thinking) send({ type: 'think', v: msg.thinking });
            tok = msg.content ?? '';
          }
          if (!tok) continue;
          raw += tok;
          send({ type: 'token', v: tok });
          for (const ev of parser.feed(tok)) {
            await handleGen(ev);
          }
        }
      }
        for (const ev of parser.flush()) {
          await handleGen(ev);
        }
        if (subAgentTasks.length) {
          const results = await Promise.allSettled(subAgentTasks);
          for (const res of results) {
            if (res.status === 'rejected') {
              send({ type: 'warn', message: `sub-agent failed: ${String(res.reason?.message || res.reason).slice(0, 200)}` });
              continue;
            }
            for (const ev of res.value.evs) {
              await handleGen(ev);
              send({ type: 'subagent', path: ev.path, model, provider: res.value.provider });
            }
          }
        }
        if (raw.trim()) await store.addMessage(pid, 'assistant', raw);
        // Phase 2: capture a point-in-time snapshot after each generation so
        // the project can be rolled back to any prior state (best-effort).
        try { await store.takeSnapshot(pid, message.slice(0, 60)); } catch { /* snapshots are best-effort */ }
        send({ type: 'done', projectId: pid, files: written, edited, deleted, renamed, assets, runs, seeds, model });
        // co-build: tell everyone else watching this project that it changed
        try {
          const sbUrl = getVar('SUPABASE_URL') || 'https://trwxpgmkpaddnyktbleg.supabase.co';
          const sbKey = getVar('SUPABASE_SERVICE_KEY') || '';
          if (sbUrl && sbKey) {
            const sb = createClient(sbUrl, sbKey);
            const ch = sb.channel('build:' + pid);
            await ch.send({ type: 'broadcast', event: 'evt', payload: { type: 'refresh', sid: body.sid || '', files: written } });
            setTimeout(() => { try { sb.removeChannel(ch); } catch {} }, 100);
          }
        } catch { /* live layer is best-effort */ }
      } catch (e) {
        if (!ac.signal.aborted) {
          send({ type: 'error', message: String(e.message || e) });
        }
      } finally {
        active[provider]--;
      }
      try { controller.close(); } catch { /* already closed */ }
    },
    cancel() { ac.abort(); },
  });

  return c.newResponse(streamBody, 200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
  });
});

// ---- generator op helpers ---------------------------------------------------

async function applyEdit(pid, fpath, hunks) {
  if (!hunks.length) return { error: 'no SEARCH/REPLACE hunks found' };
  const row = await store.getFile(pid, fpath);
  if (!row) return { error: 'file not found' };
  if (row.encoding && row.encoding !== 'utf8') return { error: 'binary file — rewrite with FILE instead' };
  let text = String(row.content ?? '');
  for (const h of hunks) {
    const i = text.indexOf(h.search);
    if (i === -1) {
      return { error: `search text not found: ${JSON.stringify(String(h.search).slice(0, 60))}` };
    }
    text = text.slice(0, i) + h.replace + text.slice(i + h.search.length);
  }
  await store.saveFile(pid, fpath, text);
  return { ok: true };
}

// Move a file and refresh every other text file that references it
// (src="...", href="...", url(...), fetch('...'), import "...", scripts).
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BANNED = /\b(import|require|fetch|XMLHttpRequest|WebSocket|EventSource|eval|Function|globalThis|localStorage|sessionStorage|indexedDB|setTimeout|setInterval|setImmediate|queueMicrotask|constructor|process|Deno|document|window)\b/;
const LOOPS = /while\s*\(\s*(true|1)\s*\)|for\s*\(\s*;\s*;\s*\)/;

async function applyRename(pid, from, to) {
  const row = await store.getFile(pid, from);
  if (!row) throw new Error(`file not found: ${from}`);
  const oldBase = from.split('/').pop();
  const newBase = to.split('/').pop();
  let refs = 0;
  let files = [];
  try { files = await store.listFiles(pid); } catch { files = []; }
  const nameRe = new RegExp(`(?<=[\\s"'()=/]|^)${escRe(oldBase)}(?=[\\s"'()\\.\\?#/&]|$)`, 'g');
  for (const f of files) {
    if (f.path === from || f.path === to) continue;
    let r;
    try { r = await store.getFile(pid, f.path); } catch { continue; }
    if (!r || (r.encoding && r.encoding !== 'utf8')) continue;
    let text = String(r.content ?? '');
    const before = text;
    // exact path references (plain, ./ , / and quoted)
    text = text
      .replace(new RegExp(`['"]${escRe(from)}['"]`, 'g'), (m) => m.replace(from, to))
      .replace(new RegExp(escRe(from), 'g'), to);
    // bare basename references bound by delimiters
    text = text.replace(nameRe, newBase);
    if (text !== before) {
      await store.saveFile(pid, f.path, text);
      refs++;
    }
  }
  await store.saveFile(pid, to, row.content, row.encoding || 'utf8');
  try { await store.deleteFile(pid, from); } catch { /* already gone */ }
  return refs;
}

// RUN blocks execute functions/<name>.js in the same sandbox as the /fn
// endpoint: a scoped function of `input` with a hard 1.5s cap, no network,
// no timers, no DOM — pure computation (math, logic, ordering, transforms).
async function runFunction(pid, name, input) {
  const norm = name.startsWith('functions/') ? name : `functions/${name}`;
  let row;
  try { row = await store.getFile(pid, norm); } catch { row = null; }
  if (!row) return { ok: false, error: `functions/${name}.js not found — write it first with <<<FILE>>>` };
  if (row.encoding && row.encoding !== 'utf8') return { ok: false, error: 'not a text function file' };
  const code = String(row.content ?? '');
  if (BANNED.test(code) || LOOPS.test(code)) {
    return { ok: false, error: 'function must be pure computation (no network, timers, I/O, loops)' };
  }
  try {
    const factory = new Function('input', `"use strict";\n${code};\nif (typeof main === 'function') return main(input);\nif (typeof handler === 'function') return handler(input);\nreturn null;`);
    const result = await Promise.race([
      Promise.resolve(factory(input ?? null)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout (max 1.5s)')), 1500)),
    ]);
    return { ok: true, result: result ?? null };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// SEED blocks insert rows (optionally clearing first) into a creat.db-style
// collection using the same lazy-table BaaS storage the SDK exposes.
async function seedCollection(pid, coll, items, clear) {
  const tname = store.baasTable(pid, coll);
  if (!tname) throw new Error('unsupported collection name');
  let n = 0;
  if (clear) {
    const existing = await store.baasList(pid, coll);
    for (const row of existing) {
      try { await store.baasRemove(pid, coll, row.id); } catch { /* skip */ }
    }
  }
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    try { await store.baasInsert(pid, coll, it); n++; } catch { /* skip bad row */ }
  }
  return n;
}

// Give the model eyes on the current project: full file list plus contents
// of the most important files within a token budget.
const CTX_BUDGET = 20000;

async function buildFileContext(pid) {
  let files = [];
  try { files = await store.listFiles(pid); } catch { return ''; }
  if (!files || !files.length) return '';
  const names = files.map((f) => f.path).join(', ');
  const parts = [
    `\n\n## Current state of this project`,
    `Files present: ${names}`,
  ];
  const prio = (p) => (p === 'index.html' ? 0 : /\.js$/.test(p) ? 1 : /\.css$/.test(p) ? 2 : 3);
  let budget = CTX_BUDGET;
  for (const f of [...files].sort((a, b) => prio(a.path) - prio(b.path))) {
    if (budget <= 200) break;
    try {
      const row = await store.getFile(pid, f.path);
      if (!row || (row.encoding && row.encoding !== 'utf8')) continue;
      let c = String(row.content ?? '');
      if (c.length > budget) c = c.slice(0, budget) + '\n…(truncated)';
      budget -= c.length;
      parts.push(`--- ${f.path} ---\n${c}`);
    } catch { /* skip unreadable */ }
  }
  return '\n' + parts.join('\n');
}
