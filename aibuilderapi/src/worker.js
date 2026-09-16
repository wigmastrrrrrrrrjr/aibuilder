// Cloudflare Workers entrypoint — the public worker: static assets + light API
// routes, with the heavy routes optionally offloaded to dedicated workers.
//
//   /api/chat*        -> aibuilderapi-chat    (AI generation, when configured)
//   /preview* __baas  -> aibuilderapi-preview (page + BaaS SDK, when configured)
//
// If the service bindings (or backend URLs) aren't wired, everything falls
// back to running right here exactly like the original single worker.

import { app } from './app.js';
import { bootWorker, workerSafeFetch } from './cf-boot.js';
import { MAINTENANCE_MODE, maintenanceResponse } from './maintenance.js';

const CHAT_PATHS = (p) => p === '/api/chat' || p.startsWith('/api/chat/');
const PREVIEW_PATHS = (p) => p === '/preview' || p.startsWith('/preview/') || p === '/__baas.js';

const backendUrl = (base, url) => (base.endsWith('/') ? base.slice(0, -1) : base) + url.pathname + url.search;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (MAINTENANCE_MODE) return maintenanceResponse(url.pathname);

    // Route heavy traffic to the dedicated workers when wired (service
    // binding preferred, public URL fallback, local handling otherwise).
    if (CHAT_PATHS(url.pathname)) {
      if (env.CHAT_WORKER) return env.CHAT_WORKER.fetch(req, env, ctx);
      if (env.CHAT_WORKER_URL) return fetch(backendUrl(env.CHAT_WORKER_URL, url), req);
    }
    if (PREVIEW_PATHS(url.pathname)) {
      if (env.PREVIEW_WORKER) return env.PREVIEW_WORKER.fetch(req, env, ctx);
      if (env.PREVIEW_WORKER_URL) return fetch(backendUrl(env.PREVIEW_WORKER_URL, url), req);
    }

    const needsApi =
      url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/preview') ||
      url.pathname === '/__baas.js';

    const fatal = await bootWorker(env);
    if (fatal && needsApi) return fatal;
    return workerSafeFetch(app.fetch, req, env, ctx);
  },
};