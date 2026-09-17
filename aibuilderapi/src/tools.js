// Centralized tool registry for the unified generator protocol.
//
// The model drives every build through one syntax:
//
//   >>>tool
//   { "name": "write_file", "arguments": { "path": "index.html", "content": "..." } }
//   <<<
//
// Each tool declares its name, argument spec, an execution function and a
// structured result. The result tells the model (and the caller) exactly what
// happened: { tool, ok, error?, event?, stat?, op? }. `event` is the SSE event
// the client already understands, `stat` records the change for the done
// summary, and `op` marks work that counts toward refactor detection.
//
// Batching is an execution mechanism, not a syntax: emit several tool calls in
// order, or wrap a group in the `batch` tool to run them as one unit.

import { store as defaultStore } from './store.js';
import { scriptFreezeRisks } from './smoketest.js';
import { execCommand, terminalEnabled } from './terminal.js';

/* ---- path & payload helpers ------------------------------------------------ */

export function cleanPath(p) {
  const s = String(p == null ? '' : p).replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '').trim();
  if (!s || s === '.' || s.split('/').includes('..')) return '';
  return s;
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Accept either `edits: [{search, replace}]` or a single `search`/`replace`.
function normalizeEdits(a) {
  if (Array.isArray(a.edits)) {
    return a.edits.map((e) => ({
      search: String(e && e.search != null ? e.search : ''),
      replace: String(e && e.replace != null ? e.replace : ''),
    }));
  }
  if (typeof a.search === 'string') {
    return [{ search: a.search, replace: String(a.replace != null ? a.replace : '') }];
  }
  return [];
}

// Accept an array of strings or {text, done} objects, or a checklist string.
function normalizePlan(items) {
  const out = [];
  const push = (text, done) => {
    const t = String(text == null ? '' : text).trim();
    if (t) out.push({ text: t, done: Boolean(done) });
  };
  if (typeof items === 'string') {
    for (let line of items.split('\n')) {
      line = line.trim();
      const m = line.match(/^[-*]\s*\[( |x|X)\]\s*(.+)$/);
      if (m) push(m[2], m[1].toLowerCase() === 'x');
    }
    return out;
  }
  if (Array.isArray(items)) {
    for (const it of items) {
      if (typeof it === 'string') push(it, false);
      else if (it && typeof it === 'object') push(it.text ?? it.step ?? it.label, it.done);
    }
  }
  return out;
}

// Accept `items`/`rows` arrays, or an object {clear, items|rows}.
function normalizeSeed(a) {
  const src = a.items !== undefined ? a.items : a.rows;
  if (Array.isArray(src)) return { clear: Boolean(a.clear), items: src };
  if (src && typeof src === 'object') {
    const items = Array.isArray(src.items) ? src.items : Array.isArray(src.rows) ? src.rows : [];
    return { clear: Boolean(a.clear || src.clear), items };
  }
  return { clear: Boolean(a.clear), items: [] };
}

// Normalize encode_payload: data URI -> base64, "base64:" prefix -> base64.
function assetPayload(data, encoding) {
  let d = String(data == null ? '' : data);
  let enc = encoding === 'base64' ? 'base64' : 'utf8';
  if (/^data:/i.test(d)) enc = 'base64';
  else if (/^base64:/i.test(d)) { d = d.slice(7); enc = 'base64'; }
  return { data: d, encoding: enc };
}

/* ---- server-backed helpers (shared by the registry) ------------------------ */

export async function applyEdit(st, pid, fpath, hunks) {
  if (!hunks.length) return { error: 'no edits provided' };
  const row = await st.getFile(pid, fpath);
  if (!row) return { error: 'file not found' };
  if (row.encoding && row.encoding !== 'utf8') return { error: 'binary file — rewrite with write_file instead' };
  let text = String(row.content ?? '');
  for (const h of hunks) {
    if (!h.search) return { error: 'edit is missing "search" text' };
    const i = text.indexOf(h.search);
    if (i === -1) return { error: `search text not found: ${JSON.stringify(String(h.search).slice(0, 60))}` };
    text = text.slice(0, i) + h.replace + text.slice(i + h.search.length);
  }
  await st.saveFile(pid, fpath, text);
  return { ok: true, content: text };
}

// Move a file and refresh every other text file that references it
// (src="...", href="...", url(...), fetch('...'), import "...", scripts).
export async function applyRename(st, pid, from, to) {
  const row = await st.getFile(pid, from);
  if (!row) throw new Error(`file not found: ${from}`);
  const oldBase = from.split('/').pop();
  const newBase = to.split('/').pop();
  let refs = 0;
  let files = [];
  try { files = await st.listFiles(pid); } catch { files = []; }
  const nameRe = new RegExp(`(?<=[\\s"'()=/]|^)${escRe(oldBase)}(?=[\\s"'()\\.\\?#/&]|$)`, 'g');
  for (const f of files) {
    if (f.path === from || f.path === to) continue;
    let r;
    try { r = await st.getFile(pid, f.path); } catch { continue; }
    if (!r || (r.encoding && r.encoding !== 'utf8')) continue;
    let text = String(r.content ?? '');
    const before = text;
    text = text
      .replace(new RegExp(`['"]${escRe(from)}['"]`, 'g'), (m) => m.replace(from, to))
      .replace(new RegExp(escRe(from), 'g'), to);
    text = text.replace(nameRe, newBase);
    if (text !== before) {
      await st.saveFile(pid, f.path, text);
      refs++;
    }
  }
  await st.saveFile(pid, to, row.content, row.encoding || 'utf8');
  try { await st.deleteFile(pid, from); } catch { /* already gone */ }
  return refs;
}

// Insert rows (optionally clearing first) into a creat.db-style collection.
export async function seedCollection(st, pid, coll, items, clear) {
  const tname = st.baasTable(pid, coll);
  if (!tname) throw new Error('unsupported collection name');
  let n = 0;
  if (clear) {
    const existing = await st.baasList(pid, coll);
    for (const row of existing) {
      try { await st.baasRemove(pid, coll, row.id); } catch { /* skip */ }
    }
  }
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    try { await st.baasInsert(pid, coll, it); n++; } catch { /* skip bad row */ }
  }
  return n;
}

/* ---- argument validation --------------------------------------------------- */

function typeOk(type, v) {
  switch (type) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'boolean': return typeof v === 'boolean';
    case 'array': return Array.isArray(v);
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    default: return true;
  }
}

export function validateArgs(spec, raw) {
  const args = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [key, def] of Object.entries(spec || {})) {
    let v = args[key];
    if (v === undefined || v === null) {
      if (def.default !== undefined) { out[key] = def.default; continue; }
      if (def.required) return { error: `missing required argument "${key}"` };
      continue;
    }
    if (def.type && !typeOk(def.type, v)) return { error: `argument "${key}" must be a ${def.type}` };
    out[key] = v;
  }
  return { value: out };
}

/* ---- registry -------------------------------------------------------------- */

const tools = new Map();
const define = (def) => { tools.set(def.name, def); };

define({
  name: 'write_file',
  description: 'Create a file or fully rewrite it with complete content.',
  arguments: {
    path: { type: 'string', required: true, desc: 'project-relative path' },
    content: { type: 'string', required: true, desc: 'complete file content' },
  },
  async run(ctx, a) {
    const st = ctx.store;
    const path = cleanPath(a.path);
    if (!path) return { ok: false, error: 'invalid path' };
    await st.saveFile(ctx.pid, path, a.content);
    const freezeFiles = [];
    if (ctx.checkFreeze !== false && scriptFreezeRisks(a.content).length) {
      freezeFiles.push(path);
      if (ctx.diag) ctx.diag.push(`freeze risk detected in ${path} (non-terminating loop) — the page is disabled until this is fixed.`);
      if (ctx.quarantine) await ctx.quarantine(freezeFiles);
    }
    const event = { type: 'file', path };
    if (ctx.emitContent) event.content = a.content;
    return { ok: true, path, content: a.content, bytes: a.content.length, freezeFiles, event, stat: { list: 'written', value: path }, op: true };
  },
});

define({
  name: 'edit_file',
  description: 'Surgically replace exact text in an existing file (preferred over rewriting).',
  arguments: {
    path: { type: 'string', required: true, desc: 'project-relative path' },
    edits: { type: 'array', required: true, desc: 'array of {search, replace} hunks' },
  },
  async run(ctx, a) {
    const st = ctx.store;
    const path = cleanPath(a.path);
    if (!path) return { ok: false, error: 'invalid path' };
    const res = await applyEdit(st, ctx.pid, path, normalizeEdits(a));
    if (!res.ok) return { ok: false, error: res.error === 'file not found' ? `file not found: ${path}` : res.error };
    const freezeFiles = [];
    if (ctx.checkFreeze !== false && res.content && scriptFreezeRisks(res.content).length) {
      freezeFiles.push(path);
      if (ctx.diag) ctx.diag.push(`freeze risk detected in ${path} (non-terminating loop) — the page is disabled until this is fixed.`);
      if (ctx.quarantine) await ctx.quarantine(freezeFiles);
    }
    const event = { type: 'edit', path };
    if (ctx.emitContent) event.content = res.content;
    return { ok: true, path, content: res.content, freezeFiles, event, stat: { list: 'edited', value: path }, op: true };
  },
});

define({
  name: 'delete_file',
  description: 'Delete a file that is no longer needed.',
  arguments: { path: { type: 'string', required: true, desc: 'project-relative path' } },
  async run(ctx, a) {
    const path = cleanPath(a.path);
    if (!path) return { ok: false, error: 'invalid path' };
    await ctx.store.deleteFile(ctx.pid, path);
    return { ok: true, path, event: { type: 'delete', path }, stat: { list: 'deleted', value: path }, op: true };
  },
});

define({
  name: 'rename_file',
  description: 'Move/rename a file; references in other files are updated automatically.',
  arguments: {
    from: { type: 'string', required: true },
    to: { type: 'string', required: true },
  },
  async run(ctx, a) {
    const from = cleanPath(a.from);
    const to = cleanPath(a.to);
    if (!from || !to) return { ok: false, error: 'invalid path' };
    const refs = await applyRename(ctx.store, ctx.pid, from, to);
    return { ok: true, from, to, refs, event: { type: 'rename', from, to, refs }, stat: { list: 'renamed', value: { from, to } }, op: true, ops: 1 + refs };
  },
});

define({
  name: 'run_command',
  description: 'Run a shell command in your dedicated project terminal and get its output back (files you touch are synced back to the app).',
  arguments: { command: { type: 'string', required: true, desc: 'shell command' } },
  async run(ctx, a) {
    const command = String(a.command).slice(0, 2000);
    if (!terminalEnabled()) {
      return {
        ok: false, skipped: true, command,
        error: `command "${command.slice(0, 60)}" skipped — cloud terminal not configured yet`,
        event: { type: 'cmd', command, enabled: false },
      };
    }
    const res = await execCommand(ctx.pid, command);
    const error = res.ok ? undefined : (res.error || (res.code != null ? `exit ${res.code}` : 'command failed'));
    return {
      ok: Boolean(res.ok), command, code: res.code, output: res.output, error,
      noWarn: true, noDiag: ctx.cmdDiag === false,
      event: { type: 'cmd', command, enabled: true, ok: res.ok, code: res.code, output: res.output, error: res.error },
      op: true,
    };
  },
});

define({
  name: 'create_asset',
  description: 'Add an image or binary asset (data URI, base64:, or plain text).',
  arguments: {
    path: { type: 'string', required: true },
    data: { type: 'string', required: true, desc: 'data URI, base64 payload, or text' },
    encoding: { type: 'string', desc: '"utf8" (default) or "base64"' },
  },
  async run(ctx, a) {
    const path = cleanPath(a.path);
    if (!path) return { ok: false, error: 'invalid path' };
    const { data, encoding } = assetPayload(a.data, a.encoding);
    await ctx.store.saveFile(ctx.pid, path, data, encoding);
    const freezeFiles = [];
    if (ctx.checkFreeze !== false && encoding === 'utf8' && scriptFreezeRisks(data).length) {
      freezeFiles.push(path);
      if (ctx.diag) ctx.diag.push(`freeze risk detected in asset ${path} (non-terminating loop) — the page is disabled until this is fixed.`);
      if (ctx.quarantine) await ctx.quarantine(freezeFiles);
    }
    const event = { type: 'asset', path, encoding };
    if (ctx.emitContent) event.data = data;
    return { ok: true, path, data, encoding, freezeFiles, event, stat: { list: 'assets', value: path }, op: true };
  },
});

define({
  name: 'seed_database',
  description: 'Pre-fill a creat.db collection with demo rows (optional clear:true to replace).',
  arguments: {
    collection: { type: 'string', required: true },
    items: { type: 'array', required: true, desc: 'array of row objects' },
    clear: { type: 'boolean', desc: 'delete existing rows first' },
  },
  async run(ctx, a) {
    const { items, clear } = normalizeSeed(a);
    const n = await seedCollection(ctx.store, ctx.pid, a.collection, items, clear);
    return { ok: true, collection: a.collection, count: n, event: { type: 'seed', collection: a.collection, count: n }, stat: { list: 'seeds', value: { collection: a.collection, n } }, op: true };
  },
});

define({
  name: 'update_plan',
  description: 'Show/update the build plan checklist.',
  arguments: {
    items: { type: 'array', required: true, desc: 'array of strings or {text, done} steps' },
  },
  async run(ctx, a) {
    const items = normalizePlan(a.items);
    if (ctx.store.setPlan) { try { await ctx.store.setPlan(ctx.pid, items); } catch { /* plan is cosmetic */ } }
    return { ok: true, items, event: { type: 'plan', items } };
  },
});

define({
  name: 'delegate',
  description: 'Hand one self-contained file to a parallel sub-agent.',
  arguments: {
    path: { type: 'string', required: true },
    task: { type: 'string', required: true, desc: 'complete instructions for the sub-agent' },
  },
  async run(ctx, a) {
    const path = cleanPath(a.path);
    const task = String(a.task || '').trim();
    if (!path) return { ok: false, error: 'invalid path' };
    if (!task) return { ok: false, error: 'delegate requires a task' };
    if (ctx.spawnSubAgent) ctx.spawnSubAgent(path, task);
    return { ok: true, path, task, event: { type: 'delegate', path } };
  },
});

define({
  name: 'test',
  description: 'Ask for a page check (acknowledged; runs are automatic).',
  arguments: { note: { type: 'string', desc: 'what to verify' } },
  async run(_ctx, a) {
    const note = String(a.note || '').slice(0, 200);
    return { ok: true, note, event: { type: 'test', ok: true, pages: 0, scripts: 0, errors: [], note, auto: false } };
  },
});

define({
  name: 'set_name',
  description: 'Set the project title (once, near the start).',
  arguments: { name: { type: 'string', required: true } },
  async run(ctx, a) {
    const name = String(a.name || '').trim().slice(0, 60);
    if (!name) return { ok: false, error: 'empty name' };
    if (ctx.store.rename) { try { await ctx.store.rename(ctx.pid, name); } catch { /* cosmetic */ } }
    return { ok: true, name, event: { type: 'name', name, projectId: ctx.pid } };
  },
});

// Batching as an execution mechanism: run a list of tool calls in order and
// stop at the first real failure (mirrors the old BATCH group).
define({
  name: 'batch',
  description: 'Run several tool calls as one unit (sequential; stops on first failure).',
  arguments: { tools: { type: 'array', required: true, desc: 'array of {name, arguments} calls' } },
  async run(ctx, a) {
    const list = Array.isArray(a.tools) ? a.tools : [];
    const results = [];
    for (const call of list) {
      const r = await executeTool(call && call.name, (call && call.arguments) || {}, ctx);
      results.push(r);
      if (!r.ok && !r.skipped) {
        return { ok: false, tool: 'batch', error: `batch op failed: ${r.error}`, results };
      }
    }
    return { ok: true, tool: 'batch', results };
  },
});

export function getTool(name) { return tools.get(name) || null; }
export function toolNames() { return [...tools.keys()]; }
export function toolDocs() {
  return [...tools.values()].map((t) => {
    const args = Object.entries(t.arguments || {}).map(([k, d]) => `${k}:${d.type}${d.required ? '' : '?'}`).join(', ');
    return `- ${t.name}(${args}) — ${t.description}`;
  }).join('\n');
}

// Validate, execute and normalize a tool call into a structured result.
export async function executeTool(name, rawArgs, ctx = {}) {
  const tool = tools.get(name);
  if (!tool) return { tool: name || '(unnamed)', ok: false, error: `unknown tool "${name}" — valid tools: ${toolNames().join(', ')}` };
  const v = validateArgs(tool.arguments, rawArgs);
  if (v.error) return { tool: name, ok: false, error: `invalid arguments for ${name}: ${v.error}` };
  const c = { store: defaultStore, ...ctx };
  try {
    const res = await tool.run(c, v.value);
    return { tool: name, ...res };
  } catch (e) {
    return { tool: name, ok: false, error: String((e && e.message) || e) };
  }
}

/* ---- in-memory store for the stateless workspace mode ---------------------- */

export function createMemoryStore(files) {
  const m = new Map((files || []).map((f) => [f.path, f.content]));
  return {
    files: m,
    async saveFile(_pid, path, content) { m.set(path, content); return { ok: true }; },
    async getFile(_pid, path) { return m.has(path) ? { path, content: m.get(path), encoding: 'utf8' } : null; },
    async listFiles() { return [...m.keys()].map((path) => ({ path })); },
    async deleteFile(_pid, path) { m.delete(path); return { ok: true }; },
    async setPlan() {},
    async rename() {},
    baasTable(pid, coll) { return /^[a-z][a-z0-9_]{0,39}$/.test(coll) ? `${pid}_${coll}` : null; },
    async baasList() { return []; },
    async baasInsert() { return { ok: true }; },
    async baasRemove() { return { ok: true }; },
  };
}
