# aibuilder

Base44-style AI app builder: describe an app in chat, an LLM generates a complete
HTML/CSS/JS app with a built-in backend (`creat.db`), live-previewed instantly.

```
┌─────────────┐     ┌────────────────────────────────────────┐
│  Chat UI    │────▶│ POST /api/chat (SSE)                   │
│  (web/)     │     │   ├─ streams from Ollama Cloud         │
│             │◀────│   ├─ parses <<<FILE>>> blocks          │
│ [preview]───┼─ifr─│   └─ persists files (SQLite)           │
└─────────────┘     │ GET /preview/:project/*  generated app │
                    │ /api/baas/:proj/:coll    CRUD backend  │
                    │ GET /__baas.js           injected SDK  │
                    └────────────────────────────────────────┘
```

## Quickstart

```sh
cd aibuilder/server
cp ../.env.example ../.env        # then edit: add your Ollama Cloud key
npm install
npm start                         # http://localhost:8787
```

## How generated apps store data

Every generated app gets `window.creat.db` (auto-injected, backed by the
platform's database):

| call | description |
|---|---|
| `await creat.db.list('todos')` | all rows as `{id, ...fields}` |
| `await creat.db.insert('todos', {title:'x'})` | create, returns row with `id` |
| `await creat.db.get('todos', id)` | fetch one |
| `await creat.db.update('todos', id, patch)` | merge-patch |
| `await creat.db.remove('todos', id)` | delete |

Collections are created lazily — no migrations needed.

## Layout

```
server/   Hono API (node @hono/node-server locally, Workers-compatible core)
  src/index.js     entry: routes + static serving of web/
  src/chat.js      SSE chat proxy to Ollama Cloud
  src/parser.js    streaming <<<FILE:path>>> block parser
  src/prompt.js    system prompt for the generator model
  src/preview.js   serves generated apps + injects BaaS SDK
  src/baas.js      generic CRUD backend for generated apps
  src/db.js        SQLite storage (node:sqlite; D1 adapter drop-in later)
web/      no-build vanilla JS SPA (chat, file tree, live iframe preview)
schema.sql  shared local/D1 schema
wrangler.toml  dormant Cloudflare config (see comments for go-live steps)
```

## Config

`.env` (root, gitignored): `OLLAMA_API_KEY`, `OLLAMA_MODEL` (default
`gpt-oss:120b` — swap to `kimi-k2.7-code` / `qwen3.5:397b` after upgrading your
Ollama plan), `PORT` (default 8787).

## Roadmap

- [x] Streaming generation loop + file persistence + live preview
- [x] Built-in BaaS (lazy collections, JSON rows)
- [ ] Iterative edit UX (diff view, selective reverts)
- [ ] Auth for generated apps (`creat.auth`)
- [ ] Cloudflare Pages + Workers + D1 deployment
- [ ] Publish apps to `*.example.com` subdomains

## Security notes

- Never commit `.env`; rotate `OLLAMA_API_KEY` if it was ever shared in chat.
- Preview iframes are sandboxed (`allow-scripts allow-same-origin`) and only
  reach their own project's data through `/api/baas`.
