// Shared Cloudflare Worker bootstrapping for every worker isolate — the main
// API worker (worker.js), the dedicated chat worker (worker-chat.js) and the
// dedicated preview worker (worker-preview.js). All three use the same live
// D1 database + Supabase, so they run the same one-time migrations.

import { useStore, store } from './store.js';
import { createSplitStore } from './store-split.js';
import { setVars } from './env.js';
import { hashPassword } from './auth.js';
import { hashEmail } from './hash-email.js';

// Runtime vars (OLLAMA_MODEL, secrets like OLLAMA_API_KEY) are read through
// getVar() from src/env.js; setVars(env) makes Worker bindings visible there.
// D1 lacks db.js's ensureColumn; add missing columns to live tables so
// newer INSERTs (owner, encoding, ip, …) don't fail with "no such column".
let _columnsEnsured = false;
async function ensureColumns(d1) {
  if (_columnsEnsured) return;
  _columnsEnsured = true;
  const adds = [
    ['projects', 'published', 'INTEGER NOT NULL DEFAULT 0'],
    ['projects', 'slug', 'TEXT'],
    ['projects', 'description', "TEXT NOT NULL DEFAULT ''"],
    ['projects', 'model', 'TEXT'],
    ['projects', 'plan', 'TEXT'],
    ['projects', 'owner', "TEXT NOT NULL DEFAULT ''"],
    ['projects', 'team_id', "TEXT NOT NULL DEFAULT ''"],
    ['files', 'encoding', "TEXT NOT NULL DEFAULT 'utf8'"],
    ['users', 'email', "TEXT NOT NULL DEFAULT ''"],
    ['users', 'verified', 'INTEGER NOT NULL DEFAULT 0'],
    ['users', 'ip', "TEXT NOT NULL DEFAULT ''"],
    ['messages', 'user', "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [table, col, def] of adds) {
    try {
      await d1.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run();
    } catch { /* already present */ }
  }
  // Live DB may predate the multiplayer event log — create the tables.
  await d1.prepare(`CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    pid TEXT NOT NULL, room TEXT NOT NULL, data TEXT NOT NULL)`).run();
  await d1.prepare('CREATE INDEX IF NOT EXISTS idx_events_room ON events (pid, room, seq)').run();
  // teambuild tables (CREATE IF NOT EXISTS is safe to re-run every boot).
  await d1.prepare(`CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL,
    invite_code TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL)`).run();
  await d1.prepare(`CREATE TABLE IF NOT EXISTS team_members (
    team_id TEXT NOT NULL, name TEXT NOT NULL, joined_at INTEGER NOT NULL,
    PRIMARY KEY (team_id, name))`).run();
  await d1.prepare('CREATE INDEX IF NOT EXISTS idx_team_members ON team_members (team_id)').run();
  await d1.prepare(`CREATE TABLE IF NOT EXISTS interactions (
    project_id TEXT NOT NULL, day TEXT NOT NULL, key TEXT NOT NULL,
    created_at INTEGER NOT NULL, PRIMARY KEY (project_id, day, key))`).run();
  await d1.prepare(`CREATE TABLE IF NOT EXISTS earnings (
    name TEXT PRIMARY KEY, units INTEGER NOT NULL DEFAULT 0)`).run();
  await d1.prepare(`CREATE TABLE IF NOT EXISTS presence (
    pid TEXT NOT NULL, sid TEXT NOT NULL, user TEXT NOT NULL DEFAULT '',
    seen_at INTEGER NOT NULL, PRIMARY KEY (pid, sid))`).run();
  // Community feature voting tables.
  await d1.prepare(`CREATE TABLE IF NOT EXISTS features (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'proposed', created_by TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL)`).run();
  await d1.prepare(`CREATE TABLE IF NOT EXISTS feature_votes (
    feature_id TEXT NOT NULL, user TEXT NOT NULL, vote INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, PRIMARY KEY (feature_id, user))`).run();
  await d1.prepare('CREATE INDEX IF NOT EXISTS idx_feature_votes ON feature_votes (feature_id)').run();
}

// One-time boot migrations — gate with a per-isolate flag so they stop
// issuing D1 reads on every single request (cold-start only).
let _bootTasksDone = false;
async function runBootTasks(env) {
  if (_bootTasksDone) return;
  _bootTasksDone = true;

    // Auto-create ai_dev account on first boot (runs once per cold start)
    try {
      const bootDone = await store.metaGet('boot:ai_dev');
      if (!bootDone) {
        const existing = await store.findUserByName('ai_dev');
        if (!existing) {
          const pw = [...crypto.getRandomValues(new Uint8Array(12))]
            .map(b => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
          const phash = await hashPassword(pw);
          await store.createUser({ name: 'ai_dev', phash, ip: '' });
          console.log(`[boot] Created ai_dev — password: ${pw}`);
        }
        await store.metaSet('boot:ai_dev', '1');
      }
    } catch (e) {
      console.error('[boot] ai_dev setup:', e.message);
    }

    // One-time cleanup: drop live-probe chat + multiplayer rows that leaked
    // into the public "Realtime Chat UI" project during SDK worker testing.
    const probePid = '6d77bf09f6ee49349a96';
    try {
      const cleaned = await store.metaGet('clean:probe_events_v2');
      if (!cleaned) {
        await env.DB.prepare('DELETE FROM events WHERE pid = ?').bind(probePid).run();
        await store.metaSet('clean:probe_events_v2', '1');
      }
    } catch (e) { console.error('[boot] test-event cleanup:', e.message); }

    // Email hardening: one-way hash any legacy plaintext emails in the live DB
    // (new signups already hash via store.createUser).
    try {
      const emailDone = await store.metaGet('clean:email_hash_v1');
      if (!emailDone) {
        const rows = await env.DB.prepare(
          "SELECT name, email FROM users WHERE email != '' AND email NOT LIKE 'sha256:%'"
        ).all();
        for (const row of rows.results || []) {
          const h = await hashEmail(row.email);
          if (h) await env.DB.prepare('UPDATE users SET email = ? WHERE name = ?').bind(h, row.name).run();
        }
        await store.metaSet('clean:email_hash_v1', '1');
      }
    } catch (e) { console.error('[boot] email hash migration:', e.message); }
}

const NO_DB_MSG = 'D1 database not bound.\n' +
  'Fix: confirm aibuilderapi/wrangler.toml has\n\n' +
  '  [[d1_databases]]\n' +
  '  binding = "DB"\n' +
  '  database_name = "aibuilder"\n' +
  '  database_id = "<your-d1-id>"\n\n' +
  'then run:  npx wrangler d1 list   (verify id)\n' +
  '           npm run deploy';

// Boot a worker isolate. Returns a Response on fatal failure (no D1 binding)
// or null on success.
export async function bootWorker(env) {
  setVars(env);
  if (!env.DB) {
    return new Response(NO_DB_MSG, {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' },
    });
  }
  useStore(createSplitStore(env.DB));
  await ensureColumns(env.DB);
  await runBootTasks(env);
  return null;
}

export async function workerSafeFetch(fn, req, env, ctx) {
  try {
    return await fn(req, env, ctx);
  } catch (e) {
    console.error('worker error:', (e && e.stack) || e);
    return new Response(JSON.stringify({ error: 'Internal Server Error', detail: String((e && e.message) || e).slice(0, 300) }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
    });
  }
}