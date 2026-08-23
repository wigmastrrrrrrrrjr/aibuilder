import { Hono } from 'hono';
import { store } from './store.js';
import { FileStreamer } from './parser.js';
import { systemPrompt } from './prompt.js';
import { extractKey, builtinKey } from './keys.js';
import { getVar } from './env.js';

const OLLAMA_URL = 'https://ollama.com/api/chat';
const MODEL_RE = /^[A-Za-z0-9._:+%-]{1,64}$/;

export const chat = new Hono();

chat.post('/', async (c) => {
  const body = await c.req.json();
  const message = body?.message;
  if (!message || typeof message !== 'string') {
    return c.json({ error: 'message required' }, 400);
  }

  // BYOK: a user-supplied key (x-api-key header or body.apiKey) takes priority
  // over the built-in platform key. It is used for this request only.
  const key = extractKey(
    c.req.header('x-api-key'),
    typeof body.apiKey === 'string' ? body.apiKey : '',
  ) || builtinKey();
  if (!key) {
    return c.json({ error: 'no API key — add one in the UI (🔑) or set OLLAMA_API_KEY in .env' }, 500);
  }

  let pid = body.projectId;
  let project = null;
  if (pid) project = await store.getProject(pid);
  if (!project) {
    pid = (await store.createProject(String(message).slice(0, 60))).id;
  }

  // model precedence: request > stored on project > env default
  const requested = typeof body.model === 'string' && MODEL_RE.test(body.model) ? body.model : '';
  const model = requested || (project && MODEL_RE.test(project.model || '') ? project.model : '')
    || getVar('OLLAMA_MODEL') || 'gemma4:31b';
  await store.setModel(pid, model);

  const history = (await store.history(pid)).map(m => ({ role: m.role, content: m.content }));
  const messages = [
    { role: 'system', content: systemPrompt() },
    ...history,
    { role: 'user', content: message },
  ];
  await store.addMessage(pid, 'user', message);

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

      let upstream;
      try {
        upstream = await fetch(OLLAMA_URL, {
          method: 'POST',
          // hard ceiling so a queued/stalled upstream can't hang forever
          signal: AbortSignal.any([ac.signal, AbortSignal.timeout(300000)]),
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages, stream: true }),
        });
      } catch (e) {
        send({ type: 'error', message: `ollama unreachable: ${e.message}` });
        try { controller.close(); } catch {}
        return;
      }
      if (!upstream.ok || !upstream.body) {
        const t = await upstream.text().catch(() => '');
        send({ type: 'error', message: `ollama ${upstream.status}: ${t.slice(0, 300)}` });
        try { controller.close(); } catch {}
        return;
      }

      const parser = new FileStreamer();
      const written = [];
      let raw = '';

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
            if (!line) continue;
            let j;
            try { j = JSON.parse(line); } catch { continue; }
            const msg = j?.message ?? {};
            const tok = msg.content ?? '';
            if (msg.thinking) send({ type: 'think', v: msg.thinking });
            if (!tok) continue;
            raw += tok;
            send({ type: 'token', v: tok });
            for (const ev of parser.feed(tok)) {
              if (ev.type === 'file' && ev.path) {
                await store.saveFile(pid, ev.path, ev.content);
                written.push(ev.path);
                send({ type: 'file', path: ev.path });
              }
            }
          }
        }
        for (const ev of parser.flush()) {
          if (ev.type === 'file' && ev.path) {
            await store.saveFile(pid, ev.path, ev.content);
            written.push(ev.path);
            send({ type: 'file', path: ev.path });
          }
        }
        if (raw.trim()) await store.addMessage(pid, 'assistant', raw);
        send({ type: 'done', projectId: pid, files: written, model });
      } catch (e) {
        if (!ac.signal.aborted) {
          send({ type: 'error', message: String(e.message || e) });
        }
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
