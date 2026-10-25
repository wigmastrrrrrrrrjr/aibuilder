// Static regression checks for the no-build-step SPA.
//
// There is no bundler or type checker in this project, so a mistake that a
// compiler would normally catch ships straight to the browser. Two such
// mistakes are guarded here:
//
//   1. app.js must PARSE (a truncated literal in the API once shipped and the
//      whole app died at load).
//   2. Every element id the script looks up with $('…') must exist in
//      index.html, and no identifier may be read before its `let`/`const`
//      declaration runs (a TDZ ReferenceError at the top level silently killed
//      the entire SPA — `defaultModel` was declared 30 lines too late).
//
// Run:  node --test test/web.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const APP_JS = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');

test('web/app.js parses as a script', () => {
  // Throws SyntaxError with the line number on failure.
  new vm.Script(APP_JS, { filename: 'web/app.js' });
});

test('every element id the SPA looks up exists in index.html', () => {
  // `$('x')?.something` and `if ($('x'))` are optional lookups, so only report
  // ids that are used unguarded, plus anything that appears more than once.
  const referenced = new Set([...APP_JS.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]));
  const present = new Set([...INDEX_HTML.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const missing = [...referenced].filter((id) => !present.has(id));

  // Ids created dynamically by the script itself (modals built at runtime) are
  // legitimately absent from the static HTML.
  const createdAtRuntime = new Set([
    ...[...APP_JS.matchAll(/\.id\s*=\s*'([A-Za-z0-9_-]+)'/g)].map((m) => m[1]),
    // Markup built as a string (modals) and injected with innerHTML.
    ...[...APP_JS.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]),
  ]);
  const reallyMissing = missing.filter((id) => !createdAtRuntime.has(id));
  assert.deepEqual(reallyMissing, [], `ids referenced by app.js but missing from index.html: ${reallyMissing.join(', ')}`);
});

test('no duplicate element ids in index.html', () => {
  const ids = [...INDEX_HTML.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual([...new Set(dupes)], []);
});

test('the SPA top-level code loads without a TDZ / ReferenceError', () => {
  // Parse + run the real app.js against a permissive stub of the DOM. Any
  // "Cannot access X before initialization" is a genuine load-time crash: the
  // whole script aborts and the page is dead (this happened when
  // `applyTempMax()` ran before `let defaultModel`). Other errors are ignored —
  // the stub is not a browser, and the point is only to exercise declaration
  // order.
  const magic = () =>
    new Proxy(function () {}, {
      get(t, prop) {
        if (prop === Symbol.toPrimitive) return () => '';
        if (prop === Symbol.iterator) return function* () {};
        if (prop === 'then') return undefined;
        if (prop === 'length') return 0;
        // Empty strings, not truthy stubs: real form fields start empty, and
        // short-circuiting on a fake value would hide the code path under test.
        if (['value', 'nodeValue', 'textContent', 'innerHTML', 'className', 'src', 'href', 'id', 'name'].includes(String(prop))) return '';
        return magic();
      },
      set() { return true; },
      has() { return true; },
      apply() { return magic(); },
      construct() { return magic(); },
    });
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    fetch: () => Promise.reject(new Error('offline')),
    localStorage: { getItem: () => '', setItem() {}, removeItem() {}, clear() {} },
    sessionStorage: { getItem: () => '', setItem() {}, removeItem() {}, clear() {} },
    document: magic(), window: magic(), navigator: magic(), location: magic(),
    requestAnimationFrame: () => 0, matchMedia: () => magic(),
    URLSearchParams, URL, TextDecoder, TextEncoder, Blob: magic(), FormData: magic(),
    Alert: magic(),
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  let failure = null;
  try {
    new vm.Script(APP_JS, { filename: 'web/app.js' }).runInContext(ctx, { timeout: 5000 });
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/before initialization|is not defined/.test(msg)) failure = msg;
  }
  assert.equal(failure, null, `app.js crashed while loading: ${failure}`);
});

test('the composer exposes the three chat modes and sends the chosen one', () => {
  // The mode is only real if the switch exists, is labelled, and is actually
  // put in the request body — a UI that forgets to send it silently builds.
  const group = INDEX_HTML.match(/id="modeSel"[\s\S]{0,600}?<\/div>/);
  assert.ok(group, 'index.html must render the #modeSel switch');
  for (const mode of ['build', 'ask', 'explain']) {
    assert.ok(group[0].includes(`data-mode="${mode}"`), `missing ${mode} button`);
  }
  assert.ok(/mode:\s*turnMode/.test(APP_JS), 'the send() body must carry the chosen mode');
  assert.ok(/localStorage\.setItem\('ab\.mode'/.test(APP_JS), 'the mode must persist across reloads');
  assert.ok(/MODES\s*=\s*\{/.test(APP_JS), 'the SPA must define the mode labels/hints');
});

test('index.html loads the current app.js build', () => {
  const asset = (html, re) => (html.match(re) || [])[1];
  const appV = Number(asset(INDEX_HTML, /app\.js\?v=(\d+)/));
  const cssV = Number(asset(INDEX_HTML, /style\.css\?v=(\d+)/));
  assert.ok(Number.isFinite(appV) && appV > 0, 'index.html must cache-bust app.js');
  assert.ok(Number.isFinite(cssV) && cssV > 0, 'index.html must cache-bust style.css');
  // A stale ?v= serves the previous bundle from the CDN cache after a deploy.
  assert.ok(appV >= 56, `app.js?v= must be bumped after changing the SPA (saw v=${appV})`);
});
