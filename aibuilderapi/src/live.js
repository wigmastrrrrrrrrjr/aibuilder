// Live multiplayer backbone — Supabase Realtime broadcast channels + a durable
// per-project event log (store.appendEvent/eventsSince/currentSeq).
//
// Two engines are exposed through the injected SDK:
//   1. Multiplayer rooms:  POST /api/projects/:pid/live/:room/push  (persist + broadcast)
//                          GET  /api/projects/:pid/live/:room       (replay since a seq)
//   2. Chat engine:        POST /api/projects/:pid/chat/send        (persist + broadcast)
//                          GET  /api/projects/:pid/chat/list        (incremental, since an id)

import { Hono } from 'hono';
import { store } from './store.js';
import { getUser } from './auth.js';
import { getVar } from './env.js';
import { createClient } from '@supabase/supabase-js';

export const live = new Hono();

const ROOM_RE = /^[A-Za-z0-9:_-]{1,64}$/;
const CHAT_ROOM_RE = /^[a-z0-9_-]{1,32}$/;

// ---- Supabase Realtime helper (server-side broadcast via service key) ----
let _sb = null;
function sb() {
  if (_sb) return _sb;
  const url = getVar('SUPABASE_URL') || 'https://trwxpgmkpaddnyktbleg.supabase.co';
  const key = getVar('SUPABASE_SERVICE_KEY') || '';
  if (!url || !key) return null;
  _sb = createClient(url, key);
  return _sb;
}

async function broadcast(roomKey, payload) {
  const client = sb();
  if (!client) return;
  try {
    const ch = client.channel(roomKey);
    await ch.send({ type: 'broadcast', event: 'evt', payload });
    setTimeout(() => { try { client.removeChannel(ch); } catch {} }, 100);
  } catch { /* best effort */ }
}

async function identity(c, evt) {
  const u = await getUser(c);
  if (u) return u.name;
  const who = (evt && (evt._user || evt.user)) || '';
  if (typeof who === 'string' && who) return who.slice(0, 64);
  return `anon #${crypto.randomUUID().slice(0, 8)}`;
}

// ---- Multiplayer rooms ------------------------------------------------------
// POST push: persist to the room's event log AND broadcast to live listeners.
live.post('/api/projects/:pid/live/:room/push', async (c) => {
  const { pid, room } = c.req.param();
  if (!ROOM_RE.test(room)) return c.json({ error: 'bad room' }, 400);
  const evt = await c.req.json().catch(() => ({}));
  const who = await identity(c, evt);
  const data = {
    type: 'message',
    user: evt._user || evt.user || who,
    data: evt.data !== undefined ? evt.data : evt,
    ts: Date.now(),
  };
  const seq = await store.appendEvent(pid, room, data);
  data.seq = seq;
  await broadcast(`live:${pid}:${room}`, data);
  return c.json({ ok: true, seq });
});

// GET replay: durable catch-up for listeners that joined late or missed events.
// ?since=SEQ&limit=N returns events strictly after SEQ (missing-seqn safe: caller
// can detect gaps on [0..currentSeq] and reset state from a snapshot if needed).
live.get('/api/projects/:pid/live/:room', async (c) => {
  const { pid, room } = c.req.param();
  if (!ROOM_RE.test(room)) return c.json({ error: 'bad room' }, 400);
  const since = Math.max(0, Number(c.req.query('since')) || 0);
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit')) || 60));
  const cur = await store.currentSeq(pid, room);
  const events = await store.eventsSince(pid, room, since, limit);
  return c.json({ ok: true, since, seq: cur, messages: events });
});

// ---- Chat engine (durable, incremental — same engine the OS chat used) ------
// Room validation lives on the project; default room is the project lobby.
live.post('/api/projects/:pid/chat/send', async (c) => {
  const { pid } = c.req.param();
  if (!(await store.getProject(pid))) return c.json({ error: 'unknown project' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const text = String(body.text || '').trim().slice(0, 500);
  if (!text) return c.json({ error: 'empty message' }, 400);
  const room = CHAT_ROOM_RE.test(body.room || '') ? String(body.room) : 'main';
  const who = await identity(c, body);
  const data = { type: 'chat', user: who, text, ts: Date.now() };
  const seq = await store.appendEvent(pid, `chat:${room}`, data);
  data.id = seq;
  await broadcast(`live:${pid}:chat:${room}`, data);
  return c.json({ ok: true, message: data }, 201);
});

// GET list: fetch chat history. ?since=ID returns only newer messages (monotonic id).
live.get('/api/projects/:pid/chat/list', async (c) => {
  const { pid } = c.req.param();
  if (!(await store.getProject(pid))) return c.json({ error: 'unknown project' }, 404);
  const room = CHAT_ROOM_RE.test(c.req.query('room') || '') ? String(c.req.query('room')) : 'main';
  const since = Math.max(0, Number(c.req.query('since')) || 0);
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit')) || 50));
  const key = `chat:${room}`;
  const cur = await store.currentSeq(pid, key);
  const events = await store.eventsSince(pid, key, since, limit);
  return c.json({
    ok: true,
    room,
    since,
    seq: cur,
    messages: events.map((e) => ({ id: e.seq, user: e.user, text: e.text, ts: e.ts })),
  });
});