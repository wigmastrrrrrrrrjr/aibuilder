// Shared browser-origin policy for every worker (main API, chat, preview).
// Refactored out of app.js so the dedicated workers enforce the same CORS
// rules the monolith did.

import { getVar } from './env.js';

export const GITHUB_URL = 'https://github.com/wigmastrrrrrrrrjr/aibuilder';

export const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost',
  'http://127.0.0.1',
  'https://aibuilderapi.csomeone301.workers.dev',
  'https://wigmastrrrrrrrrjr.github.io',
];

export const BLOCK_MSG = 'nice try script kiddy this won\'t work!';

// The origin set only changes when the env value changes — build it once and
// reuse across requests instead of allocating a Set + splitting env every time.
let _originKey = null;
let _origins = null;
export function allowedOrigins() {
  const extra = getVar('ALLOWED_ORIGINS') || '';
  if (_originKey === extra) return _origins;
  const set = new Set(DEFAULT_ALLOWED_ORIGINS);
  for (const o of extra.split(',')) {
    const t = o.trim();
    if (t) set.add(t);
  }
  _origins = set;
  _originKey = extra;
  return set;
}

export function originAllowed(origin) {
  if (!origin) return true;
  const set = allowedOrigins();
  if (set.has(origin)) return true;
  let host = origin;
  try {
    const u = new URL(origin);
    host = `${u.protocol}//${u.hostname}`;
  } catch { /* keep raw value */ }
  return set.has(host);
}

export const CORS_OPTIONS = {
  origin: (origin) => (originAllowed(origin) ? origin || '*' : null),
  allowMethods: ['GET', 'HEAD', 'PUT', 'POST', 'DELETE', 'PATCH', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'x-ab-sess', 'x-recaptcha-token', 'x-api-key'],
  exposeHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'Retry-After'],
};

// Middleware: reject requests from unapproved origins outright.
export async function blockForeignOrigins(c, next) {
  const origin = c.req.header('origin');
  if (origin && !originAllowed(origin)) {
    return c.text(BLOCK_MSG, 403, {
      'content-type': 'text/plain; charset=utf-8',
      'access-control-allow-origin': origin,
      'cache-control': 'no-store',
    });
  }
  return next();
}