// Post-build verification: the page test that runs INSIDE a build.
//
// The invariant: a build must not end with a page that references files it
// never wrote (or with a script that does not parse) and still report success.
// These tests cover the wrapper in src/verify.js — the plumbing between the
// store, the page test and the repair round — plus the effort ladder, because
// the top tier and the verifier are the two things a long build leans on.
//
// Run:  node --test aibuilderapi/test/verify.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { pageTest } from '../src/smoketest.js';
import { verifyProject, verifyDiag, verifySignature, verifyEvent, maxPageTests, pageTestEnabled } from '../src/verify.js';
import { EFFORT, effortLevel, DEFAULT_EFFORT } from '../src/models.js';

const OK_FILES = [
  { path: 'index.html', content: '<link rel="stylesheet" href="styles.css"><script src="app.js"></script><h1>hi</h1>' },
  { path: 'styles.css', content: 'body { margin: 0; }' },
  { path: 'app.js', content: 'document.querySelector("h1").textContent = "ok";' },
];
const BROKEN_FILES = [
  { path: 'index.html', content: '<link rel="stylesheet" href="styles.css"><script src="app.js"></script>' },
  { path: 'app.js', content: 'function broken( {' },
];

/** Minimal store stub: only listFilesWithContent is used by verifyProject. */
const storeWith = (files, opts = {}) => ({
  async listFilesWithContent() {
    if (opts.throwOnList) throw new Error('db down');
    return files;
  },
});

test('a clean project passes the page test', async () => {
  const r = await pageTest({ files: OK_FILES });
  assert.equal(r.ok, true);
  assert.equal(r.pages, 1);
  assert.ok(r.scripts >= 1);
  assert.deepEqual(r.errors, []);
});

test('a missing stylesheet and a broken script are both reported', async () => {
  const r = await pageTest({ files: BROKEN_FILES });
  assert.equal(r.ok, false);
  const types = r.errors.map((e) => e.type).sort();
  assert.ok(types.includes('missing stylesheet'), JSON.stringify(r.errors));
  assert.ok(types.includes('script syntax error'), JSON.stringify(r.errors));
});

test('verifyProject turns a store failure into "skipped", never a build error', async () => {
  assert.equal(await verifyProject(storeWith([], { throwOnList: true }), 'p1'), null);
  assert.equal(await verifyProject(storeWith([]), 'p1'), null, 'an empty project has nothing to test');
});

test('verifyProject reports on a real project', async () => {
  const r = await verifyProject(storeWith(BROKEN_FILES), 'p1');
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 1);
});

test('verifyDiag is empty on success and actionable on failure', () => {
  assert.equal(verifyDiag({ ok: true, errors: [] }), '');
  assert.equal(verifyDiag(null), '');
  const text = verifyDiag({ ok: false, pages: 1, scripts: 1, errors: [{ file: 'index.html', type: 'missing stylesheet', ref: 'styles.css' }] });
  assert.match(text, /PAGE TEST/);
  assert.match(text, /missing stylesheet/);
  assert.match(text, /fix every item/i);
});

test('verifySignature is stable for the same failure and different for a new one', () => {
  const a = { ok: false, errors: [{ file: 'a.js', type: 'missing script', ref: 'x.js' }] };
  const b = { ok: false, errors: [{ file: 'a.js', type: 'missing script', ref: 'x.js' }] };
  const c = { ok: false, errors: [{ file: 'b.js', type: 'missing script', ref: 'x.js' }] };
  assert.equal(verifySignature(a), verifySignature(b));
  assert.notEqual(verifySignature(a), verifySignature(c));
});

test('verifyEvent is the shape the SPA renders as a test card', () => {
  const ev = verifyEvent({ ok: false, pages: 2, scripts: 3, refs: 4, errors: [{ file: 'a.js', type: 'missing script', ref: 'x.js' }], more: true });
  assert.equal(ev.type, 'test');
  assert.equal(ev.auto, true, 'automatic tests render quietly in the activity log');
  assert.equal(ev.ok, false);
  assert.equal(ev.pages, 2);
  assert.equal(ev.errors.length, 1);
  assert.equal(ev.more, true);
});

test('verification is on by default and can be turned off', () => {
  const saved = { ...process.env };
  try {
    delete process.env.PAGE_TEST;
    delete process.env.MAX_PAGE_TESTS;
    assert.equal(pageTestEnabled(), true);
    assert.equal(maxPageTests(), 2, 'two tests per request by default');

    process.env.PAGE_TEST = 'off';
    assert.equal(pageTestEnabled(), false);
    delete process.env.PAGE_TEST;

    process.env.MAX_PAGE_TESTS = '0';
    assert.equal(maxPageTests(), 0);
    process.env.MAX_PAGE_TESTS = '5';
    assert.equal(maxPageTests(), 5);
    process.env.MAX_PAGE_TESTS = 'nonsense';
    assert.equal(maxPageTests(), 2, 'garbage falls back to the default');
  } finally {
    for (const k of ['PAGE_TEST', 'MAX_PAGE_TESTS']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
});

test('the effort ladder is five steps with a top tier that buys a longer run', () => {
  assert.deepEqual(Object.keys(EFFORT).map(Number).sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  assert.equal(EFFORT[5].label, 'Max');
  assert.equal(EFFORT[5].creditMult, 8);
  assert.equal(EFFORT[5].think, true);
  // Each step must actually buy something: more output and more context.
  for (let i = 2; i <= 5; i++) {
    assert.ok(EFFORT[i].tokens > EFFORT[i - 1].tokens, `tokens must increase at level ${i}`);
    assert.ok(EFFORT[i].ctx > EFFORT[i - 1].ctx, `context must increase at level ${i}`);
  }
  // Fast and Standard are both free; every paid tier above Standard costs more
  // than the one below it.
  assert.equal(EFFORT[1].creditMult, 0);
  assert.equal(EFFORT[2].creditMult, 0);
  for (let i = 3; i <= 5; i++) {
    assert.ok(EFFORT[i].creditMult > EFFORT[i - 1].creditMult, `cost must increase at level ${i}`);
  }
  assert.equal(effortLevel(5), 5);
  assert.equal(effortLevel(6), DEFAULT_EFFORT, 'an unknown level falls back to standard');
  assert.equal(effortLevel('5'), 5);
});
