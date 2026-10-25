# Bug report — aibuilder

Every item below was reproduced against the running app (Node/Hono API in
`aibuilderapi/`, vanilla-JS SPA in `web/`), fixed, and re-verified. Line numbers
refer to the fixed files.

Run the regression suites with:

```bash
npm test        # auth + authorization + SPA static checks
```

---

## 1. The API could not boot at all

**Where** `aibuilderapi/src/app.js:159-161`
**Symptom** `node src/index.js` died with `SyntaxError: Unexpected token` — the
server never listened.
**Cause** The `/api/docs` handler's `streams` array held a truncated string
literal (`mode: "'w` … with no closing quote), so the module failed to parse.
**Fix** Completed the literal and documented the real chat body
(`mode`, `sid`, `effort`, `temperature`, `runId`).
**Verify** `node --check` clean; `GET /api/docs` → 200.

## 2. The whole SPA crashed on load (blank page)

**Where** `web/app.js:119` (was declared at line ~152)
**Symptom** Nothing in the builder worked; console showed
`ReferenceError: Cannot access 'defaultModel' before initialization`.
**Cause** Top-level code calls `applyTempMax()` → `currentModel()`, which reads
`let defaultModel`, but that `let` was declared ~30 lines *later*. Accessing a
`let` in its temporal dead zone throws, and because it is top-level the rest of
`app.js` never executed — auth gate, project list, chat, preview all dead.
**Fix** Hoisted the declaration above the temperature block.
**Verify** `test/web.test.mjs` runs `app.js` in a stub DOM and fails with the
original message if the ordering regresses; jsdom boot now renders 0 errors.

## 3. Sign-up created no account and "signed in" with the string `undefined`

**Where** `aibuilderapi/src/auth.js:215-259`, `web/app.js:337,355,397`
**Symptom** After `POST /api/auth/signup` the UI reloaded into the builder but
every request 401'd; `localStorage['ab.tok']` was the literal `"undefined"`.
**Cause** The endpoint started an email-verification flow that never created the
user and returned `201 {verifyRequired:true}` with no token. The web form does
not even collect an email address, so no code could ever be sent. Both clients
(the SPA and the in-preview SDK) store `d.token` unconditionally.
**Fix** Signup now creates the account (`createUser` → `verifyUser` →
`createSession`) and returns `201 {token, username}`. The SPA still supports a
backend that does gate on verification, and `finishAndEnter()` refuses to store
a missing token; `sessTok()` treats legacy `"undefined"`/`"null"` values as
signed out so those browsers can recover.
**Verify** `test/auth.test.mjs` (signup → token → `me` → create project).

## 4. Private previews stopped loading after ~15 minutes

**Where** `web/app.js:284-305`
**Symptom** A private project's preview (and "Open in new tab") turned into the
404 placeholder after a while, until the page was reloaded.
**Cause** `getPreviewToken()` cached the minted token forever, but preview
tokens expire after 900 s; the cache never looked at `expiresIn`.
**Fix** Store the expiry and re-mint a minute early.
**Verify** minted token works; expired-token requests now re-mint (server
correctly rejects the stale one).

## 5. File viewer/diff showed raw base64 instead of the file

**Where** `web/app.js:2102-2122`
**Symptom** Opening a version of an uploaded file displayed a base64 blob, and
the diff compared base64 strings.
**Cause** `/api/projects/:pid/versions` returns the *stored* form plus
`encoding:'base64'`; the pane rendered `content` verbatim.
**Fix** `versionText()` decodes base64 (UTF-8), `versionIsBinary()` shows
"Binary file" for real binaries, `renderRaw`/`renderDiff` use both.
**Verify** uploaded `index.html` renders as HTML; `logo.png` shows the binary
notice.

## 6. Upload "saved" chips never flashed

**Where** `web/app.js:2008-2015`
**Symptom** Uploading files worked but no per-file feedback appeared.
**Cause** The handler read `out.uploaded`; the API only ever returns
`{ok, saved, skipped}`.
**Fix** Read `saved` (and guard `skipped` with `Array.isArray`).
**Verify** `POST …/upload` → `{ok:true, saved:["index.html","style.css"]}` and
both chips flash.

## 7. Credits reported impossible numbers after earning

**Where** `aibuilderapi/src/app.js:259,294,362`, `src/chat.js:104`
**Symptom** `/api/credits` could return `total:35, used:5, left:35` — used did
not equal `total - left` — and inflated further with every interaction.
**Cause** `used = unitsToCredits(bal.spent) + unitsToCredits(bal.earned)`, but
earnings are already added to *both* `total` and `left`.
**Fix** `used = unitsToCredits(bal.spent)`; invariant `used == total - left`
holds.
**Verify** gift/earn flows return consistent `{total, used, left}`.

## 8. Sharing a project with a team silently detached it

**Where** `aibuilderapi/src/teams.js:100-119`, docs in `app.js`
**Symptom** `POST /api/projects/:pid/team {"teamId":"…"}` returned 200 but the
project was not shared.
**Cause** The handler only read `team_id`; the documented/`teamId` spelling
produced `tid=''`, which is the "detach" path.
**Fix** Accept both spellings, and return `400` when neither key is present so
a typo can no longer silently unshare a project.
**Verify** both keys 200 + persisted; `{}` 400; `{team_id:""}` detaches.

## 9. Joining a team with the documented body failed

**Where** `aibuilderapi/src/teams.js:63`
**Symptom** `POST /api/teams/:tid/join {"code":"ABC123"}` → `403 invalid invite
code` even though the code was right.
**Cause** Only `invite_code` was read, while `/api/docs` and the CLI advertise
`{ code }`.
**Fix** Accept `invite_code` or `code`.
**Verify** join by `code` → 201 and the team is listed for the second user.

## 10. Team-shared projects never appeared in the project list

**Where** `aibuilderapi/src/app.js:424-441`, `db.js`, `store-d1.js`,
`store-pg.js`, `store-split.js` (`listProjectsByTeams`)
**Symptom** A teammate could open a shared project by id (and the sidebar
filter already expected `team_id`) but the app was missing from the sidebar.
**Cause** `GET /api/projects` returned owner rows only.
**Fix** New `listProjectsByTeams()` in every store + merge into the response.
**Verify** user B sees "Shared App" (owner A, `team_id` set) after joining.

## 11. Password reset always failed on the local backend

**Where** `aibuilderapi/src/db.js:658-671`
**Symptom** `POST /api/auth/reset` → `400 cannot verify this account for reset`
even from the exact network that signed up; only the old password worked.
**Cause** The reset route compares `user.ip` (hashed signup network) with the
caller's tag, but the local store's `findUserByName()` returned only
`{id, name, phash}` and dropped `ip`. D1/Postgres return the full row, so the
bug was local-only.
**Fix** Return `ip` (and `verified`) from `findUserByName`/`findUserById`.
**Verify** reset from the signup network → 200 + token + new password works;
another network → 403.

## 12. Deleted accounts kept working for up to 30 seconds

**Where** `aibuilderapi/src/session-cache.js:40`, `src/auth.js:265-273`
**Symptom** After `POST /api/auth/delete`, the deleted user's other tabs and
devices still authenticated for a while.
**Cause** The 30 s in-memory session cache only evicted the one token used for
the delete call, so every other cached session stayed valid.
**Fix** `clearUser(userId)` purges all tokens of that user; the delete route
calls it (and `clearSession`) after deleting.
**Verify** delete → immediate 401 on the same and a second device's token, and
login with the old password 401s.

## 13. `GET /api/features` and the forum returned 500 on the local backend

**Where** `aibuilderapi/src/db.js:768-880`, `schema.sql:174-218`
**Symptom** `GET /api/features` → `500 no such store method: featuresList`;
`POST /api/features` → `500 … featureAdd`; `GET /api/forum/categories` → `500 …
forumCategories`. The D1 deployment had no forum tables at all.
**Cause** The routes (and the Postgres store) implemented features + forum, but
the SQLite and D1 stores never did, and `schema.sql` had no `forum_*` tables.
**Fix** Implemented `featureGet/featuresList/featureAdd/featureVote/
featureStatus` and `forumCategory/forumCategories/forumThreads/
forumCreateThread/forumThread/forumReply/forumVote/forumMod` in `db.js`, added
the forum tables + seeded categories to `schema.sql`, and aligned the local
category ids with the ones `supabase-v1.sql` seeds (`general`, `show`, `ideas`,
`help`).
**Verify** full forum flow (categories → thread → reply → vote → list) and
features (list → propose → vote → status) over HTTP; no 5xx anywhere in the
regression run.

## 14. BaaS read/delete on a brand-new collection threw a 500

**Where** `aibuilderapi/src/db.js` (`baasGet`, `baasRemove`)
**Symptom** `GET /api/baas/:pid/:coll/:id` and `DELETE …/:id` for a collection
the app had never written returned `500 Internal Server Error`.
**Cause** Collections are lazy tables created on first insert; `baasGet` /
`baasRemove` prepared a statement against a table that might not exist yet →
`no such table: baas_<pid>_<coll>`.
**Fix** Ensure the table first (a no-op lookup then yields the intended 404).
**Verify** fresh collection now returns `404 {"error":"row not found"}` (proved
the pre-fix throw with an isolated copy of the store).

## 15. `/api/projects/:pid/export` returned base64 instead of source

**Where** `aibuilderapi/src/app.js:466-486`
**Symptom** Exporting an uploaded project wrote base64 gibberish into every
file (README promises "raw file contents, decoded from base64 when stored that
way").
**Cause** Uploaded files are stored as `{content: base64, encoding: 'base64'}`
and the export route passed them through untouched.
**Fix** Decode to UTF-8 when the bytes are valid UTF-8 (binary assets keep
`encoding:'base64'`).
**Verify** export → `index.html` `utf8` with real HTML; `logo.png` stays base64.

## 16. `v2` file reads returned 500 when Supabase was not configured

**Where** `aibuilderapi/src/v2.js:234-241` (`withProject`)
**Symptom** `GET /api/v2/projects/:id/files/*` → `500 supabaseKey is required.`
while every other v2 route answered the documented
`501 v2 storage is not configured`.
**Cause** One middleware touched the storage client before the readiness check.
**Fix** Run `v2ReadyOrThrow(c)` first in `withProject` too.
**Verify** unconfigured instance now answers 501 for both list and file reads.

## 17. `npm test` at the repo root was broken

**Where** `package.json`
**Symptom** `npm test` → `Could not find …/parser.test.sh`.
**Cause** The script pointed at a file that does not exist.
**Fix** `node --test aibuilderapi/test/*.test.mjs test/*.test.mjs` and two new
suites (`auth.test.mjs`, `web.test.mjs`).
**Verify** `npm test` → 10/10 pass.

## 18. A 401 from a stale session crashed the whole page

**Where** `web/app.js:998-1052,1865`
**Symptom** `TypeError: all.filter is not a function` on every load after a
session expired, and a deleted project rendered an error body as if it were a
project.
**Cause** `loadProjects()` assumed the response was an array (401 returns
`{error}`); `selectProject()` never checked `r.ok`.
**Fix** Guard both, and add `showSignedOut()` which clears the dead token and
re-opens the auth gate.
**Verify** jsdom boot with a stale token shows the gate instead of throwing.

---

### Checked and deliberately left alone

* `/preview/:pid/` for a private project with no token → 404 (by design).
* BaaS write access on **published** projects is open by design; the residual
  risk is documented in `aibuilderapi/src/baas.js` (needs `creat.auth`, a
  product decision).
* The `>>>tool` parser protocol, presence 10-session cap, credits gift limits,
  CORS/origin policy and the `authz.test.mjs` invariants all behave as
  intended.
