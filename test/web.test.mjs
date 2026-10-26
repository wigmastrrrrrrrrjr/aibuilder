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

test('the composer shows only what a turn needs; the rest folds away', () => {
  const top = INDEX_HTML.match(/id="composerTop"[\s\S]*?<div id="composerMain">/);
  assert.ok(top, 'index.html must render #composerTop');
  const block = top[0];

  // Mode stays visible: it changes what the turn actually does.
  assert.ok(/id="modeSel"/.test(block), 'the mode switch stays in the composer');

  // Model / Effort / Temp live inside one collapsed panel behind a summary
  // chip. (They used to be three permanent controls in a crowded row.)
  const panel = block.match(/id="runCfg"[^>]*/);
  assert.ok(panel, 'the run-settings panel must exist');
  assert.ok(/\bhidden\b/.test(panel[0]), 'the panel must start collapsed');
  const chip = block.match(/<button[^>]*id="runCfgBtn"[^>]*>/);
  assert.ok(chip, 'a summary chip must open the panel');
  assert.ok(/aria-expanded="false"/.test(chip[0]), 'the chip must advertise the collapsed state');
  assert.ok(/aria-controls="runCfg"/.test(chip[0]), 'the chip must point at the panel');
  assert.ok(/id="runCfgModel"/.test(block) && /id="runCfgEffort"/.test(block),
    'the chip must summarise model and effort');
  for (const id of ['modelSel', 'effortSel', 'tempSel']) {
    const at = block.indexOf(`id="${id}"`);
    assert.ok(at > block.indexOf('id="runCfg"'), `${id} must live inside the panel`);
  }

  // The duplicated "Start with…" row is gone: the same prompts already exist
  // in the empty-state quick starts and the ⌘K palette.
  assert.ok(!/id="templates"/.test(INDEX_HTML), 'the duplicate template row must be removed');
  assert.ok(!/renderTemplates\(/.test(APP_JS), 'the template renderer must be gone');
});

test('the app and the open project share one top bar', () => {
  // #chatHeader repeated the project name and its actions under .topbar and
  // cost 50px of chrome on every screen.
  assert.ok(!/id="chatHeader"/.test(INDEX_HTML), 'the second bar must be gone');
  const bar = INDEX_HTML.match(/<header class="topbar">[\s\S]*?<\/header>/);
  assert.ok(bar, 'the top bar must exist');
  for (const id of ['menuBtn', 'projName', 'statusTxt', 'saveBtn', 'publishBtn', 'cmdkBtn', 'themeBtn']) {
    assert.ok(new RegExp(`id="${id}"`).test(bar[0]), `${id} must live in the single top bar`);
  }
  // Project actions sit before the global ones so the right edge stays stable.
  assert.ok(bar[0].indexOf('id="publishBtn"') < bar[0].indexOf('id="cmdkBtn"'),
    'project actions come before global actions');
});

test('the sidebar can be collapsed on desktop, not just on phones', () => {
  const CSS = fs.readFileSync(path.join(WEB, 'style.css'), 'utf8');
  // It used to be display:none above the mobile breakpoint, so the 236px rail
  // was permanent on a desktop.
  assert.ok(!/#menuBtn\s*\{\s*display:\s*none/.test(CSS), '#menuBtn must not be hidden on desktop');
  assert.ok(/body\.rail\s*\{[^}]*--sidebar:/.test(CSS), 'a collapsed rail must exist');
  assert.ok(/body\.rail \.navItem/.test(CSS), 'rail mode must shrink the nav items');
  assert.ok(/@media \(min-width: 761px\)/.test(CSS), 'the rail is desktop-only (phones use the drawer)');
  assert.ok(/applyRail\(/.test(APP_JS), 'app.js must own the rail state');
  assert.ok(/RAIL_KEY/.test(APP_JS) && /localStorage\.setItem\(RAIL_KEY/.test(APP_JS), 'the rail must persist');
  assert.ok(/matchMedia\('\(max-width: 760px\)'\)/.test(APP_JS), '☰ must fall back to the drawer on phones');
});

test('the chat pane can be resized and the preview taken full width', () => {
  const CSS = fs.readFileSync(path.join(WEB, 'style.css'), 'utf8');
  assert.ok(/id="splitter"/.test(INDEX_HTML), 'a drag handle must sit between the panes');
  assert.ok(INDEX_HTML.indexOf('id="splitter"') > INDEX_HTML.indexOf('id="chatPane"'), 'splitter follows the chat pane');
  assert.ok(INDEX_HTML.indexOf('id="splitter"') < INDEX_HTML.indexOf('id="previewPane"'), 'splitter precedes the preview pane');
  assert.ok(/cursor:\s*col-resize/.test(CSS), 'the handle must look draggable');
  assert.ok(/body\.focusPreview #chatPane/.test(CSS), 'full-width preview must hide the chat');
  assert.ok(/id="focusBtn"/.test(INDEX_HTML), 'a full-width preview toggle must exist');
  assert.ok(/setSplit\(/.test(APP_JS) && /SPLIT_KEY/.test(APP_JS), 'the split must be tracked and persisted');
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
  // The hero must not promise autosave: edits stay in the tab until Save.
  assert.ok(!/saved as you go/.test(INDEX_HTML), 'the hero must not claim autosave any more');
});

test('index.html loads the current app.js build', () => {
  const asset = (html, re) => (html.match(re) || [])[1];
  const appV = Number(asset(INDEX_HTML, /app\.js\?v=(\d+)/));
  const cssV = Number(asset(INDEX_HTML, /style\.css\?v=(\d+)/));
  assert.ok(Number.isFinite(appV) && appV > 0, 'index.html must cache-bust app.js');
  assert.ok(Number.isFinite(cssV) && cssV > 0, 'index.html must cache-bust style.css');
  // A stale ?v= serves the previous bundle from the CDN cache after a deploy.
  assert.ok(appV >= 60, `app.js?v= must be bumped after changing the SPA (saw v=${appV})`);
});

test('edits stay in the browser until Save', () => {
  // The old Save button only refreshed the preview and flashed "Saved" — every
  // tool call had already written to the server. The browser now owns the
  // project, the turn works on a draft, and Save is the only write path.
  assert.ok(/let draft = new Map\(\)/.test(APP_JS), 'app.js must own a local draft');
  assert.ok(/function applyDraftEvent\(/.test(APP_JS), 'stream events must land in the draft');
  assert.ok(/applyDraftEvent\(ev\)/.test(APP_JS), 'the stream handler must apply every event');
  assert.ok(/draft: true,\s*\n\s*files: draftPayload\(\)/.test(APP_JS),
    'the turn must send the draft up so the AI sees what the user sees');
  assert.ok(/\/save-draft`/.test(APP_JS), 'Save must call the save-draft route');
  assert.ok(/saveDraft\(\)/.test(APP_JS), 'the Save button must trigger the upload');
  assert.ok(!/autosaved server-side; this resyncs/.test(APP_JS), 'the placebo save comment must be gone');
  assert.ok(/beforeunload/.test(APP_JS) && /draftDirty/.test(APP_JS),
    'closing the tab must warn about unsaved work');
  assert.ok(/classList\.toggle\('dirty', draftDirty\)/.test(APP_JS), 'the Save button must show a dirty state');
});

test('the preview renders unsaved work, not the last saved state', () => {
  assert.ok(/function renderDraftPreview\(/.test(APP_JS), 'a draft preview renderer must exist');
  assert.ok(/if \(draftDirty\) \{ renderDraftPreview\(\); return; \}/.test(APP_JS),
    'refreshPreview must prefer the draft while it is dirty');
  assert.ok(/frame\.srcdoc = out/.test(APP_JS), 'the draft must be rendered in the frame');
  assert.ok(/frame\.removeAttribute\('srcdoc'\)/.test(APP_JS),
    'the server preview must take over again once saved');
  // The generated page must keep its own API base, or every fetch 404s against
  // the builder's origin.
  assert.ok(/__baas\.js/.test(APP_JS) && /__CREAT_PROJECT__/.test(APP_JS),
    'the draft preview must inject the same SDK the server does');
  assert.ok(/#saveBtn\.dirty/.test(fs.readFileSync(path.join(WEB, 'style.css'), 'utf8')),
    'the dirty state needs a visible style');
});
