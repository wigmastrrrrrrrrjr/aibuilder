// Local-first drafting regression suite.
//
// The promise of this feature is narrow and testable: while you are working the
// browser owns the project. Nothing the AI writes may reach the store until an
// explicit Save, and that Save must land the *whole* file list — renames and
// deletions included — plus a snapshot to roll back to.
//
// Two seams are covered here:
//   createDraftStore  — the in-memory file surface a turn writes through
//   POST save-draft   — the one route that copies that surface back
//
// Run:  node --test aibuilderapi/test/draft.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftStore } from '../src/draft-store.js';
import { useStore } from '../src/store.js';
import { setVars } from '../src/env.js';
import { readFileSync } from 'node:fs';

const ENTRY = '<!doctype html><h1>hello</h1>';
const CSS = 'body { margin: 0 }';

// ---------------------------------------------------------------- draft store

test('a draft starts from the files the browser sent', async () => {
  const real = { marker: 'real' };
  const draft = createDraftStore(real, [
    { path: 'index.html', content: ENTRY, encoding: 'utf8' },
    { path: 'styles.css', content: CSS },
  ]);
  assert.equal((await draft.getFile('p', 'index.html')).content, ENTRY);
  assert.equal((await draft.getFile('p', 'styles.css')).content, CSS);
  assert.equal((await draft.listFiles('p')).length, 2);
});

test('writes land in memory only — the real store is never touched', async () => {
  const calls = [];
  const real = {
    saveFile: async (...a) => { calls.push(['saveFile', ...a]); },
    deleteFile: async (...a) => { calls.push(['deleteFile', ...a]); },
    takeSnapshot: async (...a) => { calls.push(['takeSnapshot', ...a]); },
  };
  const draft = createDraftStore(real, []);
  await draft.saveFile('p', 'index.html', ENTRY);
  await draft.saveFile('p', 'app.js', 'console.log(1)');
  await draft.deleteFile('p', 'app.js');
  assert.equal(calls.length, 0, 'a draft must not write through to the store');
  assert.equal(await draft.getFile('p', 'app.js'), null);
  assert.deepEqual((await draft.listFiles('p')).map((f) => f.path), ['index.html']);
});

test('non-file calls delegate to the real store', async () => {
  const seen = [];
  const real = {
    addMessage: async (pid, role, text) => { seen.push([pid, role, text]); return { ok: true }; },
    history: async () => [{ role: 'user', content: 'hi' }],
  };
  const draft = createDraftStore(real, []);
  await draft.addMessage('p', 'user', 'hi');
  assert.deepEqual(seen, [['p', 'user', 'hi']]);
  assert.deepEqual(await draft.history('p'), [{ role: 'user', content: 'hi' }]);
  // …and the seam never shadows them with a memory copy
  assert.equal('history' in draft, true);
});

test('binary assets keep their encoding', async () => {
  const draft = createDraftStore({}, []);
  await draft.saveFile('p', 'logo.png', 'iVBORw0KGgo=', 'base64');
  const f = await draft.getFile('p', 'logo.png');
  assert.equal(f.encoding, 'base64');
  assert.equal(draft.draftFiles()[0].encoding, 'base64');
  // rewriting it as text clears the encoding rather than leaving a stale flag
  await draft.saveFile('p', 'logo.png', 'not binary after all');
  assert.equal((await draft.getFile('p', 'logo.png')).encoding, 'utf8');
});

test('paths are normalised, so the same file cannot be stored twice', async () => {
  const draft = createDraftStore({}, [{ path: './index.html', content: ENTRY }]);
  await draft.saveFile('p', 'index.html', ENTRY + ' ');
  await draft.saveFile('p', '/index.html', ENTRY + '  ');
  const files = await draft.listFiles('p');
  assert.deepEqual(files.map((f) => f.path), ['index.html']);
  assert.equal((await draft.getFile('p', 'index.html')).content, ENTRY + '  ');
  // a traversal attempt is rejected outright
  assert.equal(await draft.getFile('p', '../escape.js'), null);
});

test('delta reports what a round changed, added and removed', async () => {
  const draft = createDraftStore({}, [
    { path: 'index.html', content: ENTRY },
    { path: 'old.css', content: CSS },
    { path: 'styles.css', content: CSS },
  ]);
  const before = draft.snapshot();

  await draft.saveFile('p', 'index.html', ENTRY + '<!-- edit -->');
  await draft.saveFile('p', 'app.js', 'console.log(1)');
  await draft.deleteFile('p', 'old.css');
  await draft.saveFile('p', 'styles.css', CSS);   // rewrite with identical bytes

  const { files, removed } = draft.delta(before);
  assert.deepEqual(files.map((f) => f.path).sort(), ['app.js', 'index.html'],
    'only real changes are sent, so the client does not re-render identical files');
  assert.deepEqual(removed, ['old.css']);
  const html = files.find((f) => f.path === 'index.html');
  assert.equal(html.content, ENTRY + '<!-- edit -->', 'the client needs the content, not just a path');
});

test('an empty draft is valid — a fresh project has no files yet', async () => {
  const draft = createDraftStore({}, []);
  assert.deepEqual(await draft.listFiles('p'), []);
  assert.deepEqual(await draft.listFilesWithContent('p'), []);
  assert.equal(draft.draftFiles().length, 0);
});

// ----------------------------------------------------------------- the route

const ALICE = { id: 'u-alice', userId: 'u-alice', name: 'alice' };
const TOK = 'tok-alice';
const PROJECT = { id: 'p1', name: 'app', owner: 'alice', published: 0, created_at: 1, updated_at: 2, description: '', slug: null, model: '', plan: null, team_id: '' };

function makeStore() {
  const files = new Map([['index.html', { path: 'index.html', content: ENTRY, encoding: 'utf8' }]]);
  const snapshots = [];
  return {
    getProject: async (pid) => (pid === PROJECT.id ? PROJECT : null),
    getSession: async (t) => (t === TOK ? ALICE : null),
    listFiles: async () => [...files.values()].map((f) => ({ path: f.path })),
    listFilesWithContent: async () => [...files.values()].map((f) => ({ ...f })),
    getFile: async (_pid, path) => files.get(path) || null,
    saveFile: async (_pid, path, content, encoding) => {
      files.set(path, { path, content, encoding: encoding === 'base64' ? 'base64' : 'utf8' });
      return { ok: true, path };
    },
    deleteFile: async (_pid, path) => ({ ok: true, deleted: files.delete(path) }),
    takeSnapshot: async (_pid, label) => { const s = { id: `s${snapshots.length + 1}`, label }; snapshots.push(s); return s; },
    __files: files,
    __snapshots: snapshots,
  };
}

const store = makeStore();
useStore(store);
setVars({ TERMINAL_URL: 'https://terminal.invalid', TERMINAL_TOKEN: 't', LOCAL_TERMINAL: '', LOCAL_SANDBOX: '', KAGGLE_RELAY_URL: '' });
const { app } = await import('../src/app.js');

const BASE = 'http://api.test';
async function saveDraft(who, payload) {
  const headers = { 'content-type': 'application/json' };
  if (who) headers['x-ab-sess'] = TOK;
  const res = await app.fetch(new Request(`${BASE}/api/projects/${PROJECT.id}/save-draft`, {
    method: 'POST', headers, body: JSON.stringify(payload),
  }));
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

test('Save writes every draft file and snapshots first', async () => {
  const r = await saveDraft('alice', {
    files: [
      { path: 'index.html', content: ENTRY + '<!-- saved -->', encoding: 'utf8' },
      { path: 'app.js', content: 'console.log(1)', encoding: 'utf8' },
    ],
    label: 'Saved from the browser',
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.files.sort(), ['app.js', 'index.html']);
  assert.equal(store.__files.get('index.html').content, ENTRY + '<!-- saved -->');
  assert.equal(store.__files.get('app.js').content, 'console.log(1)');
  assert.equal(store.__snapshots.length, 1, 'a Save is a rollback point');
  assert.equal(store.__snapshots[0].label, 'Saved from the browser');
});

test('the file list is authoritative: a rename deletes the old path', async () => {
  const r = await saveDraft('alice', {
    files: [{ path: 'main.js', content: 'console.log(1)', encoding: 'utf8' }],
    snapshot: false,
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.removed.sort(), ['app.js', 'index.html']);
  assert.deepEqual([...store.__files.keys()], ['main.js']);
  assert.equal(store.__snapshots.length, 1, 'snapshot:false must not create one');
});

test('a binary file survives the round trip as base64', async () => {
  const r = await saveDraft('alice', {
    files: [
      { path: 'index.html', content: ENTRY, encoding: 'utf8' },
      { path: 'logo.png', content: 'iVBORw0KGgo=', encoding: 'base64' },
    ],
    snapshot: false,
  });
  assert.equal(r.status, 200);
  assert.equal(store.__files.get('logo.png').encoding, 'base64');
});

test('bad input is refused without touching the project', async () => {
  const before = [...store.__files.keys()].sort();
  assert.equal((await saveDraft(null, { files: [] })).status, 401, 'anon cannot save');
  assert.equal((await saveDraft('alice', {})).status, 400, 'files array required');
  assert.equal((await saveDraft('alice', { files: [] })).status, 400, 'a project cannot be emptied');
  assert.equal((await saveDraft('alice', { files: [{ path: '../escape.js', content: 'x' }] })).status, 400,
    'traversal paths are not files');
  assert.deepEqual([...store.__files.keys()].sort(), before, 'nothing was written');
});

test('duplicate paths collapse to one write', async () => {
  const r = await saveDraft('alice', {
    files: [
      { path: 'index.html', content: 'first', encoding: 'utf8' },
      { path: './index.html', content: 'second', encoding: 'utf8' },
    ],
    snapshot: false,
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.files, ['index.html']);
  assert.equal(store.__files.get('index.html').content, 'first');
});

// ------------------------------------------------------------ a whole turn
//
// The unit tests above cover the seams. This one runs the real generation loop
// against a stubbed model and asserts the promise end to end: a turn that
// writes a file must leave the environment untouched and hand the new content
// to the browser instead.

const ENV = {
  getProject: async () => null,
  metaGet: async () => null,
  metaSet: async () => {},
  history: async () => [],
  addMessage: async () => ({ ok: true }),
  clearMessages: async () => ({ ok: true }),
  listFiles: async () => [],
  listFilesWithContent: async () => [],
  getFile: async () => null,
  saveFile: async () => { throw new Error('a draft turn must never write files'); },
  deleteFile: async () => { throw new Error('a draft turn must never delete files'); },
  takeSnapshot: async () => ({ id: 's1' }),
};

test('a draft turn never writes: the new file goes out over the wire instead', async () => {
  useStore(ENV);
  setVars({ MISTRAL_API_KEY: '', LOCAL_OLLAMA_URL: '', OPENROUTER_API_KEY: '' });
  const { runChat } = await import('../src/chat.js');

  const ndjson = (objs) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n';
  const rounds = [
    ndjson([
      { message: { content: 'Writing the page.' } },
      { message: { content: '\n\n>>>tool\n{"name":"write_file","arguments":{"path":"index.html","content":"<h1>made</h1>"}}\n<<<\n' } },
      { done: true, done_reason: 'stop' },
    ]),
    ndjson([{ message: { content: 'Done.' } }, { done: true, done_reason: 'stop' }]),
    ndjson([{ message: { content: 'Done.' } }, { done: true, done_reason: 'stop' }]),
  ];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(rounds.shift() || rounds.at(-1) || '', {
    status: 200, headers: { 'content-type': 'application/x-ndjson' },
  });
  const events = [];
  try {
    await runChat({
      body: {}, message: 'make a page', pid: 'p1', model: 'llama3', effort: 2,
      fileCtx: '', key: 'test-key', signal: new AbortController().signal,
      temperature: 0, emit: (ev) => events.push(ev), mode: 'build', draft: true,
      draftFiles: [],
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  const fileEv = events.find((e) => e.type === 'file' && e.path === 'index.html');
  assert.ok(fileEv, 'the turn must stream the written file to the client');
  assert.equal(fileEv.content, '<h1>made</h1>', 'the client cannot render a path alone');

  const draftEv = events.find((e) => e.type === 'draft');
  assert.ok(draftEv, 'the round must send an authoritative diff');
  assert.deepEqual(draftEv.files.map((f) => f.path), ['index.html']);
  assert.equal(draftEv.files[0].content, '<h1>made</h1>');

  const meta = events.find((e) => e.type === 'meta');
  assert.equal(meta.draft, true);
  const done = events.find((e) => e.type === 'done');
  assert.equal(done.draft, true);
});

test('the same turn without draft:true does write — the seam is real', async () => {
  const writes = [];
  useStore({
    ...ENV,
    saveFile: async (_pid, path, content) => { writes.push([path, content]); return { ok: true, path }; },
    deleteFile: async () => ({ ok: true }),
  });
  const { runChat } = await import('../src/chat.js');

  const ndjson = (objs) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n';
  const rounds = [
    ndjson([
      { message: { content: '\n\n>>>tool\n{"name":"write_file","arguments":{"path":"index.html","content":"<h1>saved</h1>"}}\n<<<\n' } },
      { done: true, done_reason: 'stop' },
    ]),
    ndjson([{ message: { content: 'Done.' } }, { done: true, done_reason: 'stop' }]),
    ndjson([{ message: { content: 'Done.' } }, { done: true, done_reason: 'stop' }]),
  ];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(rounds.shift() || '', {
    status: 200, headers: { 'content-type': 'application/x-ndjson' },
  });
  const events = [];
  try {
    await runChat({
      body: {}, message: 'make a page', pid: 'p1', model: 'llama3', effort: 2,
      fileCtx: '', key: 'test-key', signal: new AbortController().signal,
      temperature: 0, emit: (ev) => events.push(ev), mode: 'build',
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(writes, [['index.html', '<h1>saved</h1>']],
    'without the draft flag the write reaches the store immediately (the old behaviour)');
  assert.equal(events.some((e) => e.type === 'draft'), false, 'and no draft diff is sent');
});


test('a draft turn is never handed to the terminal daemon', () => {
  // The daemon runs the agent against its own sandbox and syncs the result
  // back. Offloading a draft turn there would write files the browser is
  // supposed to own, so the route must answer locally whenever draft:true.
  const src = readFileSync(new URL('../src/chat.js', import.meta.url), 'utf8');
  assert.ok(/const off = body\?\.draft === true \? null : await offloadChat/.test(src),
    'offloadChat must be skipped for draft turns');
});
