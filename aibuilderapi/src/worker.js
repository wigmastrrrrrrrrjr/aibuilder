// Cloudflare Workers entrypoint — same app, D1 storage via env.DB.
// Static assets under ../web are served by the [assets] binding (see wrangler.toml),
// and non-asset requests (/api/*, /preview/*, /__baas.js) fall through to this worker.

import { app } from './app.js';
import { useStore, store } from './store.js';
import { createD1Store } from './store-d1.js';
import { setVars, getVar } from './env.js';
import { hashPassword } from './auth.js';

// Runtime vars (OLLAMA_MODEL, secrets like OLLAMA_API_KEY) are read through
// getVar() from src/env.js; setVars(env) makes Worker bindings visible there.
// D1 lacks db.js's ensureColumn; add missing columns to live tables so
// newer INSERTs (owner, encoding, ip, …) don't fail with "no such column".
async function ensureColumns(d1) {
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
}

export default {
  async fetch(req, env, ctx) {
    setVars(env);

    const url = new URL(req.url);
    const needsApi =
      url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/preview') ||
      url.pathname === '/__baas.js';

    if (needsApi && !env.DB) {
      return new Response(
        'D1 database not bound.\n' +
        'Fix: confirm aibuilderapi/wrangler.toml has\n\n' +
        '  [[d1_databases]]\n' +
        '  binding = "DB"\n' +
        '  database_name = "aibuilder"\n' +
        '  database_id = "<your-d1-id>"\n\n' +
        'then run:  npx wrangler d1 list   (verify id)\n' +
        '           npm run deploy',
        { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' } },
      );
    }

    useStore(createD1Store(env.DB));

    // Backfill columns the live D1 tables may predate (CREATE TABLE IF NOT EXISTS
    // won't add columns to an existing table; mirrors db.js ensureColumn).
    await ensureColumns(env.DB);

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




    try {
      return await app.fetch(req, env, ctx);
    } catch (e) {
      console.error('worker error:', (e && e.stack) || e);
      return new Response(JSON.stringify({ error: 'Internal Server Error', detail: String((e && e.message) || e).slice(0, 300) }), {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
      });
    }
  },
};
