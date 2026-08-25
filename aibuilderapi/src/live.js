// Live multiplayer backbone: per-(project,room) WebSocket rooms.
// Rooms: 'build' (co-building sessions) and 'baas-<collection>' (generated apps).
// Falls back to SSE for EventSource clients (GET stream).

import { Hono } from 'hono';
import { store } from './store.js';
import { getUser } from './auth.js';

export const live = new Hono();

// ---- In-memory room manager (per-isolate, instant broadcast) ----------------
// Key: "pid:room", Value: Set<{ ws, identity }>
const rooms = new Map();

function roomKey(pid, room) { return pid + ':' + room; }
function getRoom(k) {
  let s = rooms.get(k);
  if (!s) { s = new Set(); rooms.set(k, s); }
  return s;
}

function broadcast(k, data) {
  const conns = rooms.get(k);
  if (!conns) return;
  const msg = typeof data === 'string' ? data : JSON.stringify(data);
  for (const c of conns) {
    try { c.ws.send(msg); } catch { /* dead conn, cleaned up on close */ }
  }
}

// ---- WebSocket upgrade endpoint ---------------------------------------------
live.get('/api/projects/:pid/live/:room/ws', async (c) => {
  const { pid, room } = c.req.param();
  if (!/^[A-Za-z0-9:_-]{1,64}$/.test(room)) return c.json({ error: 'bad room' }, 400);

  // Determine identity from session token (query param or header)
  const tok = c.req.query('tok') || c.req.header('x-ab-sess') || '';
  let identity = 'anon #' + crypto.randomUUID().slice(0, 8);
  if (tok) {
    const sess = await store.getSession(tok);
    if (sess) identity = sess.name;
  }

  const k = roomKey(pid, room);
  const pair = Deno.upgradeWebSocket(c.req.raw);
  const ws = pair.socket;

  ws.onopen = () => {
    const conn = { ws, identity };
    getRoom(k).add(conn);

    // tell the new connection who they are
    ws.send(JSON.stringify({ type: 'identity', name: identity }));

    // broadcast join
    broadcast(k, {
      type: 'join',
      user: identity,
      count: rooms.get(k).size,
      ts: Date.now()
    });
  };

  ws.onmessage = (evt) => {
    // stamp with server-verified identity and broadcast to everyone in room
    broadcast(k, {
      type: 'message',
      user: identity,
      data: tryParse(evt.data),
      ts: Date.now()
    });
  };

  ws.onclose = () => {
    const conns = rooms.get(k);
    if (conns) {
      for (const c of conns) {
        if (c.ws === ws) { conns.delete(c); break; }
      }
      if (conns.size === 0) rooms.delete(k);
    }
    broadcast(k, {
      type: 'leave',
      user: identity,
      count: rooms.get(k)?.size || 0,
      ts: Date.now()
    });
  };

  ws.onerror = () => { ws.close(); };

  return pair.response;
});

// ---- POST push (backward compat for server-side / fetch-based pushes) -------
live.post('/api/projects/:pid/live/:room/push', async (c) => {
  const { pid, room } = c.req.param();
  if (!/^[A-Za-z0-9:_-]{1,64}$/.test(room)) return c.json({ error: 'bad room' }, 400);
  const evt = await c.req.json().catch(() => ({}));
  const u = await getUser(c);
  const identity = u ? u.name : (evt.anonId ? `anon #${evt.anonId}` : `anon #${crypto.randomUUID().slice(0, 8)}`);
  const k = roomKey(pid, room);

  // broadcast to WebSocket connections
  broadcast(k, {
    type: 'message',
    user: identity,
    data: evt,
    ts: Date.now()
  });

  // also persist to event log for SSE fallback and history
  const seq = await store.appendEvent(pid, room, {
    ...(evt || {}), user: identity, ts: Date.now(),
  });
  return c.json({ ok: true, seq });
});

// ---- GET stream (SSE fallback for EventSource clients) ----------------------
live.get('/api/projects/:pid/live/:room/stream', async (c) => {
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

      controller.enqueue(enc.encode('retry: 1000\n\n'));

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
        } catch { /* transient storage hiccup */ }
        await new Promise((r) => setTimeout(r, 500)); // faster polling for SSE fallback
      }
    },
  });

  return c.newResponse(stream, 200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
  });
});

function tryParse(s) {
  try { return JSON.parse(s); } catch { return s; }
}
