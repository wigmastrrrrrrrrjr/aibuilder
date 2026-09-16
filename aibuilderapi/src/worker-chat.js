// Dedicated Cloudflare Worker for the AI generation endpoints (/api/chat).
// Serves the main+workspace chat flows with its own rate limits and origin
// policy, offloading the heavy streaming load off the public router worker.
//
// Deployment:  npm run deploy:chat   (see aibuilderapi/wrangler.chat.toml)

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { chat } from './chat.js';
import { bootWorker, workerSafeFetch } from './cf-boot.js';
import { CORS_OPTIONS, blockForeignOrigins } from './web-origin.js';
import { rateLimit } from './rate-limit.js';
import { blockDatacenterIps } from './vpn-block.js';

// Match the monolith's chat middleware stack so behaviour is identical whether
// the router offloads here or falls back to the single worker.
const chatLimit = rateLimit({ windowMs: 60000, max: 3000 }); // 3000 chats/min per IP

const wChat = new Hono();
wChat.use('*', blockForeignOrigins);
wChat.use('*', cors(CORS_OPTIONS));
// Same no-compression / no-cache posture as the main app (see app.js notes).
wChat.use('*', async (c, next) => {
  await next();
  if (!c.res || c.res.headers.has('content-encoding')) return;
  c.res.headers.set('content-encoding', 'identity');
  c.res.headers.set('cache-control', 'no-store');
});
wChat.use('/api/chat', chatLimit);
wChat.use('/api/chat', blockDatacenterIps());
wChat.route('/api/chat', chat);

export default {
  async fetch(req, env, ctx) {
    const fatal = await bootWorker(env);
    if (fatal) return fatal;
    return workerSafeFetch(wChat.fetch, req, env, ctx);
  },
};