// Cloudflare Workers entrypoint — same app, D1 storage via env.DB.
// Static assets under ../web are served by the [assets] binding (see wrangler.toml),
// and non-asset requests (/api/*, /preview/*, /__baas.js) fall through to this worker.

import { app } from './app.js';
import { useStore } from './store.js';
import { createD1Store } from './store-d1.js';
import { setVars } from './env.js';

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
