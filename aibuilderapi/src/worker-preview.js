// Dedicated Cloudflare Worker for generated-app previews — /preview/... (the
// deployed site body + assets) and /__baas.js (the BaaS runtime SDK), keeping
// the public router worker light.
//
// Deployment:  npm run deploy:preview   (see aibuilderapi/wrangler.preview.toml)

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { preview, BAAS_SDK_JS } from './preview.js';
import { bootWorker, workerSafeFetch } from './cf-boot.js';
import { CORS_OPTIONS, blockForeignOrigins } from './web-origin.js';
import { appLimitCheck, projectIdOfPath } from './app-limit.js';

const wPrev = new Hono();
wPrev.use('*', blockForeignOrigins);
wPrev.use('*', cors(CORS_OPTIONS));
wPrev.use('*', async (c, next) => {
  await next();
  if (!c.res || c.res.headers.has('content-encoding')) return;
  c.res.headers.set('content-encoding', 'identity');
  c.res.headers.set('cache-control', 'no-store');
});
// Same per-app resource budget the preview path got inside the monolith.
wPrev.use('*', async (c, next) => {
  const pid = projectIdOfPath(c.req.path);
  if (pid) {
    const r = appLimitCheck(pid);
    c.header('X-App-Limit', String(r.limit));
    c.header('X-App-Limit-Remaining', String(r.remaining));
    if (r.over) {
      c.header('Retry-After', '60');
      return c.json({ error: 'app resource limit exceeded — too many requests (200k/min). Slow down and retry.', limit: r.limit, window: '60s' }, 429);
    }
  }
  return next();
});
wPrev.route('/preview', preview);
wPrev.get('/__baas.js', (c) =>
  c.text(BAAS_SDK_JS, 200, { 'content-type': 'application/javascript; charset=utf-8' })
);

export default {
  async fetch(req, env, ctx) {
    const fatal = await bootWorker(env);
    if (fatal) return fatal;
    return workerSafeFetch(wPrev.fetch, req, env, ctx);
  },
};