# aibuilder

Base44-style AI app builder: describe an app in chat, an LLM generates a complete
HTML/CSS/JS app with a built-in backend (`creat.db`), live-previewed instantly.

```
┌──────────────┐     ┌──────────────────────────────────────┐
│  Chat UI     │────▶│ POST /api/chat (SSE)                  │
│  (web/)      │     │   ├─ streams from Ollama Cloud        │
│              │◀────│   │  └─ fallback to Mistral            │
│ [preview]────┤─ifr─│   ├─ parses >>>tool calls             │
└──────────────┘     │   └─ persists files (SQLite/D1)       │
                     │ GET /preview/:project/*  generated app │
                     │ /api/baas/:proj/:coll    CRUD backend  │
                     │ GET /__baas.js           injected SDK  │
                     └──────────────────────────────────────┘
```

## Quickstart

```sh
cd aibuilder
cp .env.example .env               # then edit: add your keys
npm start                          # http://localhost:8787  (runs aibuilderapi/)
```

## Chat modes

The composer has three modes. A mode decides what a turn is allowed to **do** —
the model and effort knobs still control how it thinks.

| mode | what it does | streams |
|---|---|---|
| **Build** | the full agent: writes files, edits, runs commands | only its commentary — tool calls and file payloads never leave the server |
| **Chat** | answers a question, plans, brainstorms, writes copy | the reply and nothing else: no tools, no file writes |
| **Explain** | reads and searches the project, then explains it | prose plus read-only activity; every write tool is refused server-side |

Build mode's `>>>tool` calls carry whole files. Those payloads are parsed and
executed inside the API (`src/stream-filter.js`) and dropped before the SSE
stream, so the transcript only ever receives the words meant for the person —
the browser no longer has to hide a file's contents as it scrolls past.

The mode travels in the `POST /api/chat` body as `mode: "build" | "ask" | "explain"`
and is persisted in `localStorage` under `ab.mode`.

## Shell

The workspace is one 56px bar plus two panes:

| control | does |
|---|---|
| ☰ / `⌘B` | collapses the sidebar to an icon rail (a drawer on phones); remembered |
| drag the gap between panes | resizes chat vs preview; double-click resets |
| `⌘J` / the expand button | full-width preview, chat hidden |
| the `model · effort` chip | opens Model / Effort / Temp; hidden when you don't need them |

## Effort

Effort is how hard (and how long) the model works on one turn. Every step buys
more output and a bigger context window, so it can finish more of the app before
it has to stop.

| level | label | cost | output | context |
|---|---|---|---|---|
| 1 | Fast | free | 4k | 12k |
| 2 | Standard (default) | free | 16k | 32k |
| 3 | Deep | 2× base | 49k | 96k |
| 4 | Deepest | 4× base | 98k | 128k |
| 5 | Max | 8× base | 131k | 160k |

Deep and above also turn on the model's thinking traces, and they are billed
from the daily credit grant (BYOK and local models are free either way).

## Builds verify themselves

The last thing a build round does is test what it just wrote. `src/smoketest.js`
resolves every `href`/`src`/`url()` the way the preview server does, syntax
checks every referenced script, and flags loops that would freeze the page.
`src/verify.js` runs it after each round that changed files and feeds anything
broken back into the repair loop, so a missing `styles.css` is written before
the turn ends instead of showing up as a broken preview.

The result is streamed as a `test` event (`auto: true`) and summarised on
`done`. `PAGE_TEST=off` disables it; `MAX_PAGE_TESTS` (default 2) caps how many
tests one request may run.

## How generated apps store data

Every generated app gets `window.creat.db` (auto-injected, backed by the
platform database):

| call | description |
|---|---|
| `await creat.db.list("todos")` | all rows as `{id, ...fields}` |
| `await creat.db.insert("todos", {title:"x"})` | create, returns row with `id` |
| `await creat.db.get("todos", id)` | fetch one |
| `await creat.db.update("todos", id, patch)` | merge-patch |
| `await creat.db.remove("todos", id)` | delete |

Collections are created lazily — no migrations needed.

## Deploy to Cloudflare (Workers + static assets)

The API deploys as a single Worker with D1; `web/` is served by the same
Worker via the assets binding (Pages-style, one origin, no CORS issues).

```sh
# one-time setup
npx wrangler login                       # or set CLOUDFLARE_API_TOKEN
npm run deploy                           # schema -> secret -> deploy

# afterwards, code-only deploys are instant:
npm run deploy:code                      # = wrangler deploy
npm run logs                             # tail production logs
```

`npm run deploy` runs three steps (see `aibuilderapi/package.json`):
1. `db:init` — applies `schema.sql` to your D1 database (`aibuilder`)
2. `secret:key` — prompts for `OLLAMA_API_KEY`
3. `deploy` — uploads the Worker + `web/` assets using `wrangler.toml`

Local development stays plain Node: `npm start` (no wrangler needed).

## Terminal client (`tui/`)

Build full projects from the terminal — a Rust REPL that talks to the same API as
the web builder. Chat with the generator, then it materializes every generated
file into your working directory as real files you can polish in your editor.

```sh
# install (macOS · Linux · Windows · Android/Termux) — no Rust required
curl -fsSL https://wigmastrrrrrrrrjr.github.io/aibuilder/install.sh | sh
# Windows (PowerShell):
#   irm https://wigmastrrrrrrrrjr.github.io/aibuilder/install.ps1 | iex

aib login                    # sign in with your account
aib                          # start the REPL
aib projects                 # list projects
aib export <project-id>      # write all files to ./<name>/
```

Inside the REPL: just type a message to build. `/model <id>` sets the model,
`/out <dir>` changes where files land, `/ls` lists current files, `/quit` exits.
Session (token, project) is stored in `~/.config/aib/config.json`.

Backend support: `GET /api/projects/:pid/export` returns raw file contents
(decoded from `base64` when stored that way) so a project can be materialized
locally. Files are written with path-traversal protection.

## Layout

```
aibuilderapi/  the API — deployable standalone to Cloudflare Workers (wrangler.toml inside)
  src/app.js       all routes: chat, projects, models, publish, discover, remix, upload
  src/chat.js      SSE chat proxy with Ollama/Mistral failover (per-project model selection)
  src/parser.js    streaming >>>tool call parser (legacy blocks normalized)
  src/tools.js     tool registry: names, argument validation, execution, results
  src/prompt.js    system prompts: build, chat (ask) and explain modes
  src/modes.js     the mode vocabulary + which tools each mode may run
  src/stream-filter.js  drops tool/file payloads before they reach the SSE wire
  src/models.js    model catalogue proxy (/api/models) + the effort ladder
  src/verify.js    post-build page test: what the preview would load, checked
  src/preview.js   serves published/generated apps + injects BaaS SDK
  src/baas.js      generic CRUD backend for generated apps
  src/store.js     storage interface (async)
  src/db.js        local backend: node:sqlite
  src/store-d1.js  Cloudflare D1 backend (same interface)
  src/index.js     local runner (`npm start`)
  src/worker.js    Workers entrypoint (D1 + static assets)
web/      no-build vanilla JS SPA: builder (index.html) + discovery feed (discover.html)
tui/      Rust terminal client — `aib` REPL, chat + materialize to disk (ratatui)
schema.sql  shared local/D1 schema
```

The API is fully self-contained in `aibuilderapi/` so it can be split into its
own repo or deployed straight to Workers; `web/` deploys to Pages as-is.

## Config

`.env` (root, gitignored): `OLLAMA_API_KEY`, `OLLAMA_MODEL`, `MISTRAL_API_KEY`,
`PORT`, `ALLOW_ALL_MODELS`.

- The built-in Ollama key powers everyone by default; `/api/models` shows only
  free-plan models with `gemma4:31b` auto-recommended for coding.
- `MISTRAL_API_KEY` enables automatic failover — when Ollama is unreachable or
  returns an error, chat transparently falls back to `mistral-small-latest`.
- Users can click **🔑 Own API key** to bring their own Ollama Cloud key. It is
  sent per-request (`x-api-key` header / `apiKey` chat field), kept in browser
  localStorage, never stored server-side — and unlocks that plan's full model
  catalogue.
- After upgrading your Ollama plan, set `ALLOW_ALL_MODELS=1` in `.env` to show
  every cloud model for the built-in key too.

## Roadmap

### Phase 1 — Core (done)
- [x] Streaming generation loop + file persistence + live preview
- [x] Built-in BaaS (lazy collections, JSON rows)
- [x] Multi-provider failover (Ollama primary, Mistral fallback)
- [x] Per-project model selection
- [x] Discovery feed (`discover.html`)
- [x] Cloudflare Workers + D1 + Assets deployment
- [x] Email-based auth (signup/login)
- [x] Guest mode (limited daily prompts) — removed; accounts required
- [x] BYOK support (user-supplied Ollama keys)

### Phase 2 — Iteration & Polish
- [x] Iterative edit UX (diff view, selective reverts)
- [x] File-level undo/redo in the builder
- [x] Streaming block highlighting in chat (visual parse feedback)
- [x] Drag-and-drop file upload into projects
- [x] Project versioning / snapshots (restore any prior state)
- [x] Prompt templates (pre-filled prompts for common app types)

### Phase 3 — Generated App Backend
- [ ] Auth for generated apps (`creat.auth` — signup/login/roles)
- [ ] File/image uploads in generated apps (`creat.storage`)
- [ ] Realtime subscriptions (`creat.realtime` — live updates via Supabase)
- [ ] Serverless functions for generated apps (`creat.fn` — custom endpoints)
- [ ] Rate limiting and abuse protection per generated app

### Phase 4 — Publishing & Hosting
- [ ] Publish apps to `*.aibuilder.app` subdomains
- [ ] Custom domain support for published apps
- [ ] Automatic SSL via Cloudflare
- [ ] Social preview / OG image generation for published apps
- [ ] Discovery gallery with categories, likes, and remix counts

### Phase 5 — Collaboration & Social
- [ ] Real-time co-building (multiple users editing the same project)
- [ ] Commenting on generated code (inline review)
- [ ] Fork / remix chains (see lineage of remixed projects)
- [ ] Public profiles with project portfolios
- [ ] Leaderboard (most remixed, most liked)

### Phase 6 — Advanced Generation
- [ ] Multi-file awareness (model sees full project context, not just current file)
- [ ] Test generation (auto-generate tests for generated apps)
- [ ] Accessibility audit (auto-check and fix a11y issues)
- [ ] Performance budget (warn if generated code exceeds size thresholds)
- [ ] LLM-powered code review pass (post-generation quality check)

## Security notes

- Never commit `.env`; rotate `OLLAMA_API_KEY` / `MISTRAL_API_KEY` if shared.
- Preview iframes are sandboxed (`allow-scripts allow-same-origin`) and only
  reach their own project data through `/api/baas`.
