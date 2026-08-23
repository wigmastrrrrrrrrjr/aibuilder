import { Hono } from 'hono';
import { store } from './db.js';
import { FileStreamer } from './parser.js';
import { systemPrompt } from './prompt.js';

const OLLAMA_URL = 'https://ollama.com/api/chat';

export const chat = new Hono();

chat.post('/', async (c) => {
  const key = process.env.OLLAMA_API_KEY;
  if (!key || key.startsWith('your_')) {
    return c.json({ error: 'OLLAMA_API_KEY missing — copy .env.example to .env and fill it in' }, 500);
  }
  const { projectId: pidIn, message } = await c.req.json();
  if (!message || typeof message !== 'string') {
    return c.json({ error: 'message required' }, 400);
  }

  let pid = pidIn;
  if (!pid || !store.getProject(pid)) {
    pid = store.createProject(message.slice(0, 60)).id;
  }
  const model = process.env.OLLAMA_MODEL || 'gpt-oss:120b';
  const messages = [
    { role: 'system', content: systemPrompt() },
    ...store.history(pid).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: message },
  ];
  store.addMessage(pid, 'user', message);

  // Client-cancel propagates to the upstream request.
  const ac = new AbortController();
  c.req.raw.signal.addEventListener('abort', () => ac.abort());

  const enc = new TextEncoder();
  const body = new ReadableStream({
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
      controller.close(); closed = true;
      return;
    }
    if (!upstream.ok || !upstream.body) {
      const t = await upstream.text().catch(() => '');
      send({ type: 'error', message: `ollama ${upstream.status}: ${t.slice(0, 300)}` });
      controller.close(); closed = true;
      return;
    }

    const parser = new FileStreamer();
    const written = [];
    let raw = '';
    let lineBuf = '';

    try {
      const reader = upstream.body.getReader();
      const dec = new TextDecoder();
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
          const think = msg.thinking ?? '';
          if (think) await send({ type: 'think', v: think });
          if (!tok) continue;
          raw += tok;
          await send({ type: 'token', v: tok });
          for (const ev of parser.feed(tok)) {
            if (ev.type === 'file' && ev.path) {
              store.saveFile(pid, ev.path, ev.content);
              written.push(ev.path);
              await send({ type: 'file', path: ev.path });
            }
          }
        }
      }
      for (const ev of parser.flush()) {
        if (ev.type === 'file' && ev.path) {
          store.saveFile(pid, ev.path, ev.content);
          written.push(ev.path);
          await send({ type: 'file', path: ev.path });
        }
      }
      if (raw.trim()) store.addMessage(pid, 'assistant', raw);
      await send({ type: 'done', projectId: pid, files: written });
    } catch (e) {
      if (!ac.signal.aborted) {
        send({ type: 'error', message: String(e.message || e) });
      }
    }
    try { controller.close(); } catch { /* already closed */ }
    },
    cancel() { ac.abort(); },
  });

  return c.newResponse(body, 200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
  });
});
