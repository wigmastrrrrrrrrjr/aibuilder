// Live multiplayer backbone — Supabase Realtime broadcast channels.
// POST push remains for server-side broadcasts (e.g. builder co-build sessions).
// Clients connect directly to Supabase Realtime for instant delivery.

import { Hono } from 'hono';
import { store } from './store.js';
import { getUser } from './auth.js';
import { getVar } from './env.js';
import { createClient } from '@supabase/supabase-js';

export const live = new Hono();

// ---- Supabase Realtime helper (server-side broadcast via service key) ----
let _sb = null;
function sb() {
  if (_sb) return _sb;
  const url = getVar('SUPABASE_URL') || '';
  const key = getVar('SUPABASE_SERVICE_KEY') || '';
  if (!url || !key) return null;
  _sb = createClient(url, key);
  return _sb;
}

// ---- POST push (server-side broadcast to Supabase channel) ------------------
live.post('/api/projects/:pid/live/:room/push', async (c) => {
  const { pid, room } = c.req.param();
  if (!/^[A-Za-z0-9:_-]{1,64}$/.test(room)) return c.json({ error: 'bad room' }, 400);
  const evt = await c.req.json().catch(() => ({}));
  const u = await getUser(c);
  const identity = u ? u.name : (evt._user || evt.user) || (`anon #${crypto.randomUUID().slice(0, 8)}`);

  const payload = {
    type: 'message',
    user: identity,
    data: evt,
    ts: Date.now()
  };

  // Broadcast via Supabase Realtime
  const client = sb();
  if (client) {
    const ch = client.channel(`live:${pid}:${room}`);
    await ch.send({ type: 'broadcast', event: 'evt', payload });
    // Unsubscribe after sending (fire-and-forget broadcast)
    setTimeout(() => { try { client.removeChannel(ch); } catch {} }, 100);
  }

  return c.json({ ok: true });
});
