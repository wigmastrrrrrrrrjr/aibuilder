// Cloudflare Workers entrypoint — same app, D1 storage via env.DB.
// Static assets under ../web are served by the [assets] binding (see wrangler.toml).

import { app } from './app.js';
import { useStore } from './store.js';
import { createD1Store } from './store-d1.js';
import { setVars } from './env.js';

export default {
  async fetch(req, env, ctx) {
    setVars(env);
    useStore(createD1Store(env.DB));
    return app.fetch(req, env, ctx);
  },
};
