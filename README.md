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
cd aibuilder
cp .env.example .env               # then edit: add your Ollama Cloud key
npm start                          # http://localhost:8787  (runs aibuilderapi/)
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
aibuilderapi/  the API — deployable standalone to Cloudflare Workers (wrangler.toml inside)
  src/app.js       all routes: chat, projects, models, publish, discover, remix, upload
  src/chat.js      SSE chat proxy to Ollama Cloud (per-project model selection)
  src/parser.js    streaming <<<FILE:path>>> block parser
  src/prompt.js    system prompt for the generator model
  src/models.js    model catalogue proxy (/api/models)
  src/preview.js   serves published/generated apps + injects BaaS SDK
  src/baas.js      generic CRUD backend for generated apps
  src/store.js     storage interface (async)
  src/db.js        local backend: node:sqlite
  src/store-d1.js  Cloudflare D1 backend (same interface)
  src/index.js     local runner (`npm start`)
  src/worker.js    Workers entrypoint (D1 + static assets)
web/      no-build vanilla JS SPA: builder (index.html) + discovery feed (discover.html)
schema.sql  shared local/D1 schema
```

The API is fully self-contained in `aibuilderapi/` so it can be split into its
own repo or deployed straight to Workers; `web/` deploys to Pages as-is.

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
