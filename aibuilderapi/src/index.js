// Local development entrypoint. Run from aibuilderapi/: `npm start`
import './db.js'; // activates the SQLite backend
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { app as apiApp } from './app.js';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

// ---- tiny .env loader (no dependency) ---------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(here, '../../.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || m[1].startsWith('#')) continue;
    const val = m[2].replace(/^["']|["']$/g, '');
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  }
}

const app = new Hono();
app.route('/', apiApp);

// static SPA (no build step); resolved from this file so any cwd works
const WEB_ROOT = process.env.WEB_ROOT || 'auto';
const webDir = WEB_ROOT === 'auto' ? path.resolve(here, '../../web') : path.resolve(WEB_ROOT);
const relWeb = path.relative(process.cwd(), webDir) || '.';
app.use('*', serveStatic({ root: relWeb }));
app.get('/', (c) => c.redirect('/index.html'));

const port = Number(process.env.PORT) || 8787;
serve({ fetch: app.fetch, port }, () => {
  console.log(`aibuilder api running  ->  http://localhost:${port}`);
  console.log(`model: ${process.env.OLLAMA_MODEL || 'gpt-oss:120b'}  key: ${process.env.OLLAMA_API_KEY ? 'loaded' : 'MISSING'}`);
});
