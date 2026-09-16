// Dedicated Cloudflare Worker for the heavy builder/API surface — the monolith
// app mirror. The public router (worker.js) offloads /api/chat, /api/baas,
// /api/terminal, /api/v2, /api/projects (incl. live/presence/snapshot/upload)
// and /api/models here, splitting invocation load across the account and
// keeping the router worker light.
//
// Deployment:  npm run deploy:chat   (see aibuilderapi/wrangler.chat.toml)

import { app } from './app.js';
import { bootWorker, workerSafeFetch } from './cf-boot.js';

export default {
  async fetch(req, env, ctx) {
    const fatal = await bootWorker(env);
    if (fatal) return fatal;
    return workerSafeFetch(app.fetch, req, env, ctx);
  },
};