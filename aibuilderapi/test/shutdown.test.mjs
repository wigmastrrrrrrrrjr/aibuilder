// Shutdown regression suite.
//
// The site is off, and "off" has to mean off on every surface it was live on:
//
//   • the public Workers router (which also fronts the static assets)
//   • the dedicated chat and preview workers, which answer on their own
//     hostnames and are reachable directly
//   • the local dev server
//   • the GitHub Pages mirror, which has no server and can only be taken down
//     by publishing something else
//
// Each of those is checked here, because the failure mode of a half-shutdown is
// silent: one forgotten entrypoint keeps serving the whole app.
//
// Run:  node --test aibuilderapi/test/shutdown.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { SHUTDOWN, SHUTDOWN_MESSAGE, SHUTDOWN_HTML, shutdownResponse } from '../src/shutdown.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const SCRIPT = path.resolve(SRC, '../scripts/shutdown-site.mjs');
const WEB = path.resolve(SRC, '../../web');

const MSG = 'sorry this website is unavailable. Shut down.';

// ---------------------------------------------------------------- the switch

test('the shutdown is on, with the exact message', () => {
  assert.equal(SHUTDOWN, true, 'the platform must be off');
  assert.equal(SHUTDOWN_MESSAGE, MSG);
  // Spelled out once, in one place: the page, the JSON and every test read it.
  assert.ok(SHUTDOWN_HTML.includes(`<p>${MSG}</p>`), 'the page shows the message verbatim');
  assert.match(SHUTDOWN_HTML, /<meta name="robots" content="noindex, nofollow">/);
});

test('a page request gets the page, a 410, and no cacheability', async () => {
  const res = shutdownResponse('/index.html', 'text/html,application/xhtml+xml');
  assert.equal(res.status, 410, 'gone, not temporarily unavailable');
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('x-robots-tag') || '', /noindex/);
  const body = await res.text();
  assert.ok(body.includes(MSG));
  assert.ok(!/href=|<script/i.test(body), 'no links, no scripts — nothing to click through');
});

test('an API request gets JSON with the same message', async () => {
  for (const [p, accept] of [['/api/chat', 'text/event-stream'], ['/api/projects', 'application/json'], ['/__baas.js', '*/*']]) {
    const res = shutdownResponse(p, accept);
    assert.equal(res.status, 410, p);
    assert.match(res.headers.get('content-type') || '', /application\/json/, p);
    assert.equal(res.headers.get('access-control-allow-origin'), '*', 'a browser client can read the error');
    const body = await res.json();
    assert.equal(body.error, 'shutdown', p);
    assert.equal(body.message, MSG, p);
  }
});

// -------------------------------------------------------------- entrypoints
//
// Reached through each worker's real `fetch` handler, with an empty env: if the
// gate is not the very first thing they do, bootWorker() would fail first and
// these would not return 410.

const call = (worker, url, headers = {}) => worker.fetch(
  new Request(url, { headers }),
  {},
  { waitUntil() {}, passThroughOnException() {} },
);

test('the public router is closed — pages, API and previews alike', async () => {
  const { default: worker } = await import('../src/worker.js');
  for (const u of ['https://aibuilder.test/', 'https://aibuilder.test/index.html',
    'https://aibuilder.test/discover.html', 'https://aibuilder.test/preview/abc/',
    'https://aibuilder.test/__baas.js', 'https://aibuilder.test/style.css']) {
    const res = await call(worker, u, { accept: 'text/html' });
    assert.equal(res.status, 410, u);
    assert.ok((await res.text()).includes(MSG), u);
  }
  const api = await call(worker, 'https://aibuilder.test/api/projects', { accept: 'application/json' });
  assert.equal(api.status, 410);
  assert.equal((await api.json()).message, MSG);
});

test('the dedicated chat and preview workers are closed too', async () => {
  const chat = (await import('../src/worker-chat.js')).default;
  const prev = (await import('../src/worker-preview.js')).default;
  assert.equal((await call(chat, 'https://chat.test/api/chat')).status, 410);
  const page = await call(prev, 'https://preview.test/preview/abc/index.html', { accept: 'text/html' });
  assert.equal(page.status, 410);
  assert.ok((await page.text()).includes(MSG));
});

test('the local dev server is closed before it serves anything', () => {
  // index.js starts an HTTP server on import, so it cannot be driven from a
  // test; the invariant is that the gate is registered before the API mount
  // and before the static handler.
  const src = fs.readFileSync(path.join(SRC, 'index.js'), 'utf8');
  const gate = src.indexOf("app.use('*', (c, next) => (");
  const api = src.indexOf("app.route('/', apiApp)");
  const statics = src.indexOf("app.use('*', serveStatic(");
  assert.ok(gate > -1, 'index.js must install the shutdown middleware');
  assert.ok(gate < api, 'the gate must be registered before the API');
  assert.ok(gate < statics, 'the gate must be registered before the static files');
  assert.ok(/SHUTDOWN/.test(src.slice(gate, api)), 'the middleware must consult the flag');
});

// ------------------------------------------------------------- pages artifact

test('the Pages artifact is the shutdown page and nothing else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shutdown-site-'));
  try {
    // A stand-in for what CI stages: the real pages plus the SPA bundles.
    for (const f of fs.readdirSync(WEB)) fs.copyFileSync(path.join(WEB, f), path.join(dir, f));
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'page.html'), 'REAL CONTENT');

    execFileSync(process.execPath, [SCRIPT, dir], { stdio: 'pipe' });

    const left = fs.readdirSync(dir).sort();
    assert.ok(fs.readdirSync(path.join(dir, 'sub')).includes('page.html'), 'nested pages are rewritten too');
    assert.equal(fs.readFileSync(path.join(dir, 'sub', 'page.html'), 'utf8'), SHUTDOWN_HTML);
    for (const f of left) {
      const full = path.join(dir, f);
      if (!fs.statSync(full).isFile()) continue;
      const ext = path.extname(f).toLowerCase();
      if (ext === '.html') {
        assert.equal(fs.readFileSync(full, 'utf8'), SHUTDOWN_HTML, `${f} must be the shutdown page`);
      } else {
        assert.ok(!['.js', '.css', '.map'].includes(ext), `${f} must not ship — no app to load`);
      }
    }
    // Every page the site ever linked to still resolves to the message.
    for (const p of ['index.html', 'discover.html', 'forum.html', 'game.html', '404.html',
      'privacy.html', 'tos.html', 'tou.html']) {
      assert.ok(left.includes(p), `${p} must exist so old links land on the message`);
    }
    // The CLI install helpers are distribution, not the website.
    assert.ok(left.includes('install.sh') && left.includes('install.ps1'), 'installers stay');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every entrypoint imports the lock (a new one must not forget it)', () => {
  for (const f of ['worker.js', 'worker-chat.js', 'worker-preview.js', 'index.js']) {
    const src = fs.readFileSync(path.join(SRC, f), 'utf8');
    assert.match(src, /from '\.\/shutdown\.js'/, `${f} must import the shutdown module`);
    assert.match(src, /SHUTDOWN/, `${f} must consult the flag`);
  }
  // The deploy config has to route every request through the worker; otherwise
  // Cloudflare serves the static files before the shutdown check ever runs.
  const toml = fs.readFileSync(path.resolve(SRC, '../wrangler.toml'), 'utf8');
  assert.match(toml, /\[assets\][\s\S]*?run_worker_first = true/,
    'workers must be run first so assets cannot bypass the gate');
  // Pages has no server: CI must publish the shutdown page instead of the app.
  const pages = fs.readFileSync(path.resolve(SRC, '../../.github/workflows/pages.yml'), 'utf8');
  assert.match(pages, /shutdown-site\.mjs/, 'the Pages workflow must stage the shutdown page');
});
