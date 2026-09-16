// Cloudflare Workers entrypoint — the public router worker: static assets +
// auth/billing/community API plus offloading of the builder-heavy routes.
//
//   /api/chat /api/baas /api/terminal /api/v2        -> aibuilderapi-chat
//   /api/projects (incl live/presence/snapshot/upload)
//   /api/models
//   /preview /__baas.js                              -> aibuilderapi-preview
//
// If the service bindings (or backend URLs) aren't wired, everything falls
// back to running right here exactly like the original single worker.

import { app } from './app.js';
import { bootWorker, workerSafeFetch } from './cf-boot.js';
import { MAINTENANCE_MODE, maintenanceResponse } from './maintenance.js';

// Builder-heavy subtrees offloaded to the chat worker — enough coverage that a
// generation burst (chat streaming, BaaS auto-save, AI terminal exec, project
// CRUD + presence/snapshots, live rooms) lands on two workers ~50/50.
const CHAT_OFFLOAD_PREFIXES = [
  '/api/chat',
  '/api/baas',
  '/api/terminal',
  '/api/v2',
  '/api/projects',
  '/api/models',
];
const CHAT_PATHS = (p) => CHAT_OFFLOAD_PREFIXES.some((pre) => p === pre || p.startsWith(pre + '/'));
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