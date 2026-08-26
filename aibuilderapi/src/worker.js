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
