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
    ['files', 'encoding', "TEXT NOT NULL DEFAULT 'utf8'"],
    ['users', 'email', "TEXT NOT NULL DEFAULT ''"],
    ['users', 'verified', 'INTEGER NOT NULL DEFAULT 0'],
    ['users', 'ip', "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [table, col, def] of adds) {
    try {
      await d1.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run();
    } catch { /* already present */ }
  }
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
        { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } },
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
      return new Response('Internal Server Error', {
        status: 500,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
  },
};
