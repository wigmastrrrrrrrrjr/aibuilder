// Project-private "serverless" functions: apps ship files under functions/,
// call them via creat.call(name, input). Pure synchronous compute only —
// no network, storage, timers or globals; JSON in, JSON out.

import { Hono } from 'hono';
import { store } from './store.js';

export const fn = new Hono();

const NAME_RE = /^[a-zA-Z0-9_$]{1,40}$/;
const BANNED = /\b(import|require|fetch|XMLHttpRequest|WebSocket|EventSource|eval|Function|globalThis|localStorage|sessionStorage|indexedDB|setTimeout|setInterval|setImmediate|queueMicrotask|constructor|process|Deno|document|window)\b/;
const LOOPS = /while\s*\(\s*(true|1)\s*\)|for\s*\(\s*;\s*;\s*\)/;

fn.post('/api/projects/:pid/fn/:name', async (c) => {
  const { pid, name } = c.req.param();
  if (!NAME_RE.test(name)) return c.json({ error: 'bad function name' }, 400);

  const row = await store.getFile(pid, `functions/${name}.js`).catch(() => null);
  if (!row) return c.json({ error: `no such function: ${name}` }, 404);

  const code = String(row.content ?? '');
  if (BANNED.test(code) || LOOPS.test(code)) {
    return c.json({ error: 'functions must be pure computation (no network/storage/timers/infinite loops)' }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  try {
    const factory = new Function(
      'input',
      `"use strict";\n${code}\n;if (typeof main === 'function') return main(input); if (typeof handler === 'function') return handler(input); return null;`,
    );
    const result = await Promise.race([
      Promise.resolve(factory(body.input ?? null)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout (max 1.5s)')), 1500)),
    ]);
    return c.json({ ok: true, result: result ?? null });
  } catch (e) {
    return c.json({ error: String(e.message || e) }, 500);
  }
});
