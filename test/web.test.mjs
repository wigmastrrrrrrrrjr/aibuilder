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

test('the composer offers the full five-step effort ladder', () => {
  const group = INDEX_HTML.match(/id="effortSel"[\s\S]{0,900}?<\/div>/);
  assert.ok(group, 'index.html must render #effortSel');
  const levels = [...group[0].matchAll(/data-effort="(\d)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(levels, [1, 2, 3, 4, 5], 'effort levels must be 1..5 in order');
  assert.ok(/data-effort="5"[^>]*>Max</.test(group[0]), 'the top level is labelled Max');
  // The SPA must accept the top level instead of clamping to 4.
  assert.ok(/Math\.min\(5,\s*Math\.max\(1,\s*Number\(localStorage\.getItem\('ab\.effort'\)\)/.test(APP_JS),
    'app.js must clamp effort to 1..5');
  assert.ok(/5:\s*'Max/.test(APP_JS), 'app.js must describe the Max level');
});

test('the composer is laid out in rows, not one crowded line', () => {
  const top = INDEX_HTML.match(/id="composerTop"[\s\S]*?<div id="composerMain">/);
  assert.ok(top, 'index.html must render #composerTop');
  const rows = (top[0].match(/class="composerRow"/g) || []).length;
  assert.equal(rows, 2, 'the composer controls must sit on two rows');
  // Mode + Effort govern the turn; Model + Temp tune the run.
  assert.ok(/data-mode="build"[\s\S]*?data-effort="5"/.test(top[0]), 'Mode and Effort share the first row');
  assert.ok(/id="modelSel"[\s\S]*?id="tempSel"/.test(top[0]), 'Model and Temp share the second row');
});

test('the design system stays flat: no grain, no serif display face', () => {
  const CSS = fs.readFileSync(path.join(WEB, 'style.css'), 'utf8');
  assert.ok(/--grain:\s*none/.test(CSS), 'paper grain must be disabled');
  assert.ok(!/'Fraunces'/.test(CSS), 'the serif display face must be gone');
  assert.ok(/--ease-spring:\s*cubic-bezier\(\.2,\s*\.7,\s*\.3,\s*1\)/.test(CSS), 'no overshoot easing');
  // Restrained geometry: nothing in the token block above 16px.
  const radii = [...CSS.matchAll(/--r-(?:xs|sm|md|lg|xl):\s*(\d+)px/g)].map((m) => Number(m[1]));
  assert.ok(radii.length >= 5, 'radii tokens must exist');
  assert.ok(Math.max(...radii) <= 16, `radii must stay restrained (saw ${Math.max(...radii)}px)`);
});

test('the empty state has exactly one home — index.html', () => {
  // resetToNew() used to carry its own copy of this markup, so an edit to the
  // hero in index.html was silently overwritten at runtime by the stale copy
  // in the script. The state now lives only in the HTML and is captured once.
  assert.ok(/EMPTY_STATE_HTML/.test(APP_JS), 'app.js must capture the delivered empty state');
  assert.ok(/messagesEl\.innerHTML = EMPTY_STATE_HTML;/.test(APP_JS), 'resetToNew() must restore it');
  assert.ok(!/become real|Describe it\./.test(APP_JS), 'app.js must not hold a second copy of the hero copy');
  assert.ok(/class="empty"/.test(INDEX_HTML), 'index.html must carry the empty state markup');
  const quickStarts = (INDEX_HTML.match(/class="qt" data-prompt=/g) || []).length;
  assert.equal(quickStarts, 4, 'the HTML empty state carries the quick starts');
  assert.ok(/messagesEl\.querySelectorAll\('\.emptyQuick \.qt'\)/.test(APP_JS),
    'quick-start clicks must still be bound after a reset');
});

test('index.html loads the current app.js build', () => {
  const asset = (html, re) => (html.match(re) || [])[1];
  const appV = Number(asset(INDEX_HTML, /app\.js\?v=(\d+)/));
  const cssV = Number(asset(INDEX_HTML, /style\.css\?v=(\d+)/));
  assert.ok(Number.isFinite(appV) && appV > 0, 'index.html must cache-bust app.js');
  assert.ok(Number.isFinite(cssV) && cssV > 0, 'index.html must cache-bust style.css');
  // A stale ?v= serves the previous bundle from the CDN cache after a deploy.
  assert.ok(appV >= 58, `app.js?v= must be bumped after changing the SPA (saw v=${appV})`);
});
