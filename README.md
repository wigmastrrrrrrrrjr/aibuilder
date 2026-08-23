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

## Deploy to Cloudflare (Workers + static assets)

The API deploys as a single Worker with D1; `web/` is served by the same
Worker via the assets binding (Pages-style, one origin, no CORS issues).

```sh
# one-time setup
npx wrangler login                       # or set CLOUDFLARE_API_TOKEN
npm run deploy                           # schema → secret → deploy

# afterwards, code-only deploys are instant:
npm run deploy:code                      # = wrangler deploy
npm run logs                             # tail production logs
```

`npm run deploy` runs three steps (see `aibuilderapi/package.json`):
1. `db:init` — applies `schema.sql` to your D1 database (`aibuilder`)
2. `secret:key` — prompts for `OLLAMA_API_KEY`
3. `deploy` — uploads the Worker + `web/` assets using `wrangler.toml`

Local development stays plain Node: `npm start` (no wrangler needed).

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

`.env` (root, gitignored): `OLLAMA_API_KEY`, `OLLAMA_MODEL`, `PORT`,
`ALLOW_ALL_MODELS`.

- The built-in key powers everyone by default; `/api/models` then shows only
  free-plan models with `gemma4:31b` auto-recommended for coding.
- Users can click **🔑 Own API key** to bring their own Ollama Cloud key. It is
  sent per-request (`x-api-key` header / `apiKey` chat field), kept in browser
  localStorage, never stored server-side — and unlocks that plan's full model
  catalogue.
- After upgrading your Ollama plan, set `ALLOW_ALL_MODELS=1` in `.env` to show
  every cloud model for the built-in key too.

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
