import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { store } from './db.js';
import { chat } from './chat.js';
import { baas } from './baas.js';
import { preview, BAAS_SDK_JS } from './preview.js';

// ---- tiny .env loader (no dependency) --------------------------------------
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

app.get('/api/meta', (c) =>
  c.json({
    model: process.env.OLLAMA_MODEL || 'gpt-oss:120b',
    hasKey: Boolean(process.env.OLLAMA_API_KEY && !process.env.OLLAMA_API_KEY.startsWith('your_')),
  })
);

app.get('/api/projects', (c) => c.json(store.listProjects()));
app.post('/api/projects', async (c) => {
  const { name } = await c.req.json().catch(() => ({}));
  return c.json(store.createProject(name), 201);
});
app.get('/api/projects/:pid', (c) => {
  const project = store.getProject(c.req.param('pid'));
  if (!project) return c.json({ error: 'not found' }, 404);
  return c.json({
    project,
    files: store.listFiles(project.id),
    messages: store.history(project.id, 100),
  });
});
app.delete('/api/projects/:pid', (c) => {
  if (!store.getProject(c.req.param('pid'))) return c.json({ error: 'not found' }, 404);
  store.deleteProject(c.req.param('pid'));
  return c.json({ ok: true });
});

app.route('/api/chat', chat);
app.route('/api/baas', baas);
app.route('/preview', preview);

// BaaS SDK for generated apps (absolute path so any page depth can load it)
app.get('/__baas.js', (c) =>
  c.text(BAAS_SDK_JS, 200, { 'content-type': 'application/javascript; charset=utf-8' })
);

// static SPA (no build step)
app.use('*', serveStatic({ root: '../web' }));
app.get('/', (c) => c.redirect('/index.html'));

const port = Number(process.env.PORT) || 8787;
serve({ fetch: app.fetch, port }, () => {
  console.log(`aibuilder running  ->  http://localhost:${port}`);
  console.log(`model: ${process.env.OLLAMA_MODEL || 'gpt-oss:120b'}  key: ${process.env.OLLAMA_API_KEY ? 'loaded' : 'MISSING'}`);
});
