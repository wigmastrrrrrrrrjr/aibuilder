// Live multiplayer backbone: per-(project,room) event log + SSE streams.
// Rooms: 'build' (co-building sessions) and 'baas-<collection>' (generated apps).

import { Hono } from 'hono';
import { store } from './store.js';

export const live = new Hono();

live.post('/api/projects/:pid/live/:room/push', async (c) => {
  const { pid, room } = c.req.param();
  if (!/^[A-Za-z0-9:_-]{1,64}$/.test(room)) return c.json({ error: 'bad room' }, 400);
  const evt = await c.req.json().catch(() => ({}));
  const seq = await store.appendEvent(pid, room, { ...(evt || {}), ts: Date.now() });
  return c.json({ ok: true, seq });
});

live.get('/api/projects/:pid/live/:room/stream', (c) => {
  const { pid, room } = c.req.param();
  if (!/^[A-Za-z0-9:_-]{1,64}$/.test(room)) return c.json({ error: 'bad room' }, 400);

  let cursor = Number(c.req.query('since') || 0) || 0;
  const enc = new TextEncoder();
  const signal = c.req.raw.signal;

  const stream = new ReadableStream({
    async start(controller) {
      let open = true;
      signal.addEventListener('abort', () => {
        open = false;
        try { controller.close(); } catch { /* already */ }
      }, { once: true });

      controller.enqueue(enc.encode('retry: 3000\n\n'));

      // Poll the event log every ~1.2s. Cheap, robust across isolates,
      // and survives proxy buffering better than a pure push design.
      while (open) {
        try {
          const cur = await store.currentSeq(pid, room);
          if (cur > cursor) {
            const evts = await store.eventsSince(pid, room, cursor);
            for (const e of evts) {
              cursor = e.seq;
              if (!open) break;
              controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
            }
          } else {
            controller.enqueue(enc.encode(': ping\n\n'));
          }
        } catch { /* transient storage hiccup — keep the stream alive */ }
        await new Promise((r) => setTimeout(r, 1200));
      }
    },
  });

  return c.newResponse(stream, 200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
  });
});
