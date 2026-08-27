# `creat` SDK & API reference

Every generated app gets a `window.creat` object injected automatically by the
platform (served as `GET /__baas.js`, only after `window.supabase` loads). It
gives the app four superpowers:

- **`creat.db`** — a database (JSON rows, per-project collections)
- **`creat.live` / `creat.push` / `creat.server`** — realtime multiplayer rooms
- **`creat.chat`** — persistent per-room chat with history
- **`creat.call` / `creat.lib` / `creat.me`** — serverless functions, CDN libs, identity

None of this is magic — it is a thin client over two backend engines:

| Engine | Backend |
|---|---|
| Database | REST CRUD (`/api/baas/...`) persisted in D1/SQLite |
| Multiplayer + chat | **Supabase Realtime broadcast channels** for instant delivery **+ a durable per-room event log** for catch-up |

---

## 1. Identity & auth

```js
const me = await creat.me();      // { username } or null if not logged in
```

- Every request adds `x-ab-sess: <token>` when the app has a token in
  `localStorage['ab_app_tok']`.
- In a room/chat, users without an account appear as `anon #xxxxxx`.
- `send()`/`push()` stamp messages with the identity server-side
  (`/api/auth/me` first, else `_user` in the POST body, else a fresh anon id).

**Auth endpoints** (`POST /api/auth/*`):

| Endpoint | Purpose |
|---|---|
| `POST /api/auth/signup` | create account (username + password) |
| `POST /api/auth/login` | log in, returns `token` |
| `POST /api/auth/verify-email` | verify signup email code |
| `POST /api/auth/verify-tfa` | 2FA code check |
| `POST /api/auth/resend-code` | resend verification email |
| `POST /api/auth/reset` | password reset / set new password |
| `GET /api/auth/me` | current user (401 if anonymous) |
| `POST /api/auth/logout` | invalidate session |

---

## 2. Database — `creat.db`

CRUD against the project's collections. Collections are created lazily — no
migrations. All calls return Promises.

| SDK call | Endpoint | Returns |
|---|---|---|
| `await creat.db.list("todos")` | `GET /api/baas/:pid/todos` | all rows `{id, ...fields}` |
| `await creat.db.get("todos", id)` | `GET /api/baas/:pid/todos/:id` | one row or 404 |
| `await creat.db.insert("todos", obj)` | `POST /api/baas/:pid/todos` | created row with `id` |
| `await creat.db.update("todos", id, patch)` | `PUT /api/baas/:pid/todos/:id` | merged row |
| `await creat.db.remove("todos", id)` | `DELETE /api/baas/:pid/todos/:id` | `{ok:true}` |

Collection names must match `[a-z][a-z0-9_]*` (validated server-side). Insert
body must be a JSON object.

---

## 3. Realtime multiplayer — `creat.live` / `creat.push` / `creat.server`

Two-sided: **instant** via Supabase Realtime broadcast **and durable** via the
event-log API (so late joiners and refresh lose nothing).

### Subscribe to a room

```js
// creat.live(coll, cb) — subscribe to a 'live' room
const room = creat.live('cursor', (evt) => {
  console.log(evt.user, evt.data, evt.ts);   // {type, user, data, ts}
});
room.myName();                    // your identity once subscribed
room.subscribe(fn);               // add another listener (returns unsubscribe fn)
await room.history({limit: 50});  // last N events (newest first)
await room.since(seq);            // events strictly after seq (durable catch-up)
await room.seq();                 // current event seq
room.close();                     // leave the channel
```

Channel: `live:<pid>:<coll>` — any participant broadcasting on the same
collection sees every event instantly.

### Broadcast into a room

```js
const seq = await creat.push('cursor', { x: 5, y: 10 }); // resolves to durable seq
```

`push` writes to the live channel **and** POSTs
`/api/projects/:pid/live/baas-<coll>/push` so the event is persisted.

### Server-side rooms (game master)

```js
const srv = creat.server('board');   // name: /^[a-z0-9_-]{1,32}$/
srv.push({ ... });                   // broadcast (srv channel)
srv.subscribe(fn); srv.myName(); srv.history(); srv.since(); srv.seq(); srv.close();
```

Channel: `srv:<pid>:<name>`; durable log room id is `srv:<name>`.

### Backend endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/projects/:pid/live/:room/push` | persist event + broadcast; returns `{ok, seq}` |
| `GET /api/projects/:pid/live/:room?since=SEQ&limit=N` | replay; `{seq: maxSeq, messages:[{seq, type, user, data, ts}]}` |

The server broadcasts to `live:<pid>:<room>` on the **same channel** the SDK
subscribes to (via the service key; the SDK uses the anon key — both point at
the same Supabase project). `ROOM_RE = /^[A-Za-z0-9:_-]{1,64}$/`.

---

## 4. Chat — `creat.chat`

The durable chat engine (restored from the original OS build).

```js
const chat = creat.chat.room('lobby');   // any /^[a-z0-9_-]{1,32}$/; default 'main'
await chat.send('hello');                // -> stored message {id, user, text, ts}
const msgs = await chat.list({since: 0, limit: 50});   // incremental since id
await chat.history({limit: 30});         // recent (newest last)
await chat.latest();                     // -> last msg id (cross-tab sync)
const off = chat.on((m) => render(m));   // realtime, includes your own sends
off();                                   // unsubscribe
chat.close();                            // leave channel
```

### Backend endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/projects/:pid/chat/send` `{room, text}` | persist + broadcast; 201 → `{message}` |
| `GET /api/projects/:pid/chat/list?room=&since=&limit=` | incremental history; `{messages:[{id,user,text,ts}], seq}` |

- Message ids are **monotonic per room** — `since=N` returns strictly-newer ones.
- Real-time delivery channel: `live:<pid>:chat:<room>`.
- The server broadcasts back to that same channel, so the sender's own `on()`
  callbacks also fire (matching the original OS behavior).
- `text` is trimmed + capped at 500 chars server-side.

---

## 5. Serverless functions — `creat.call`

```js
const result = await creat.call('weather', { city: 'Paris' });
// -> POST /api/projects/:pid/fn/weather  { input: {...} }  -> { result }
```

Handled by the `functions/` folder in generated projects.

---

## 6. Libraries — `creat.lib`

```js
const pl = await creat.lib.load('physics');  // planck CDN, exposes window.planck
```

External CDN loading with a small registry (uncached → cached).

---

## 7. Endpoint wiring summary

| `creat` API | HTTP |
|---|---|
| `db.*` | `/api/baas/:pid/:coll[/:id]` |
| `live().history/since/seq` | `GET /api/projects/:pid/live/baas-<coll>` |
| `push()` | Supabase channel + `POST /api/projects/:pid/live/baas-<coll>/push` |
| `server().*` | Supabase `srv:` channel + `/api/projects/:pid/live/srv:<name>` |
| `chat.*` | `/api/projects/:pid/chat/send` + `/chat/list` + Supabase `live:<pid>:chat:<room>` |
| `call()` | `POST /api/projects/:pid/fn/<name>` |
| `me()` | `GET /api/auth/me` |
| signup/login popup | `POST /api/auth/*` |

---

## 8. Durability model (why no message is ever lost)

Every multiplayer/chat event goes through `store.appendEvent(pid, room, data)`
which writes to a per-project `events` table and assigns a **monotonic seq**:

1. Sender broadcasts instantly over Supabase Realtime (looks live).
2. Sender's `push()`/`send()` also persists the event and resolves to its seq.
3. Each subscriber keeps its own `lastSeq` and periodically calls
   `since(lastSeq)` — any events missed while disconnected are replayed.
4. `currentSeq` (`GET ?since=0&limit=1` or `latest()`) tells a fresh tab where
   to start. Gaps on `[0..seq]` can be detected and state rebuilt from a
   snapshot.

This gives **at-least-once** delivery: Realtime when possible, D1 replay when
not.