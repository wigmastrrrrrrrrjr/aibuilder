// Streaming parser for the unified generator protocol.
//
// The model drives every build through ONE syntax:
//
//   >>>tool
//   { "name": "write_file", "arguments": { "path": "index.html", "content": "…" } }
//   <<<
//
// Feed chunks via feed(); each call yields an array of events:
//   text -> plain prose outside any tool call
//   tool -> { type:'tool', name, arguments } — a validated-shaped tool call
//
// The registry in tools.js declares the valid names and arguments; the parser
// only extracts the call. As a compatibility layer it also still understands
// the legacy `<<<FILE:…>>>` blocks (old history lives in every project) and
// normalizes them into the same `tool` events, so callers have a single shape.

const TOOL_OPEN = '>>>tool';
const TAG_OPEN = '<<<';
const TAG_CLOSE = '>>>';
const END_TAG = '<<<END>>>';
const BATCH_END = '<<<BATCHEND>>>';
const S_MARK = '<<<<<<< SEARCH';
const R_MARK = '>>>>>>> REPLACE';
const M_MARK = '=======';

const KINDS = ['FILE', 'EDIT', 'DELETE', 'PLAN', 'NAME', 'DELEGATE', 'RENAME', 'ASSET', 'SEED', 'BATCH', 'CMD', 'TEST'];
const BODY_KINDS = ['FILE', 'EDIT', 'PLAN', 'DELEGATE', 'ASSET', 'SEED', 'CMD', 'TEST'];

/* ---- legacy body helpers (kept so old blocks still parse) ------------------ */

function parsePlan(body) {
  const items = [];
  for (let line of String(body || '').split('\n')) {
    line = line.trim();
    const m = line.match(/^[-*]\s*\[( |x|X)\]\s*(.+)$/);
    if (m) items.push({ text: m[2].trim(), done: m[1].toLowerCase() === 'x' });
  }
  return items;
}

function parseEditHunks(body) {
  const hunks = [];
  let idx = 0;
  while ((idx = body.indexOf(S_MARK, idx)) !== -1) {
    idx += S_MARK.length;
    const mid = body.indexOf(M_MARK, idx);
    const end = body.indexOf(R_MARK, mid === -1 ? idx : mid);
    if (mid === -1 || end === -1) break;
    const search = stripFences(body.slice(idx, mid)).replace(/^\n+/, '').replace(/\n$/, '');
    const replace = stripFences(body.slice(mid + M_MARK.length, end)).replace(/^\n+/, '').replace(/\n$/, '');
    hunks.push({ search, replace });
    idx = end + R_MARK.length;
  }
  return hunks;
}

// JSON.parse that also accepts the very common malformed shape models emit:
// raw newlines/tabs/control characters inside string values. That is invalid
// JSON (multi-line file contents almost always contain it), so we repair the
// string literals before parsing. Returns `fallback` when it still won't parse.
export function parseLooseJson(text, fallback = undefined) {
  const s = String(text == null ? '' : text);
  try { return JSON.parse(s); } catch { /* repair below */ }
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === '\\') { out += ch; esc = true; continue; }
      if (ch === '"') { out += ch; inStr = false; continue; }
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        if (ch === '\n') out += '\\n';
        else if (ch === '\r') out += '\\r';
        else if (ch === '\t') out += '\\t';
        else out += '\\u' + code.toString(16).padStart(4, '0');
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') inStr = true;
    out += ch;
  }
  try { return JSON.parse(out); } catch { /* trailing commas */ }
  try { return JSON.parse(out.replace(/,\s*([}\]])/g, '$1')); } catch { /* give up */ }
  return fallback;
}

function parseJsonOr(body, fallback) {
  return parseLooseJson(String(body == null ? '' : body).trim(), fallback);
}

function assetPayload(body) {
  const b = stripFences(String(body || '')).trim();
  if (!b) return { encoding: 'utf8', data: '' };
  if (/^data:/i.test(b)) return { encoding: 'base64', data: b };
  if (/^base64:/i.test(b)) return { encoding: 'base64', data: b.slice(7) };
  return { encoding: 'utf8', data: b };
}

function seedPayload(body) {
  const raw = parseJsonOr(body, null);
  if (Array.isArray(raw)) return { clear: false, items: raw };
  if (raw && typeof raw === 'object') {
    const items = Array.isArray(raw.items) ? raw.items
      : raw.rows ? raw.rows
        : [Object.fromEntries(Object.entries(raw).filter(([k]) => k !== 'clear'))];
    return { clear: Boolean(raw.clear), items };
  }
  return { clear: false, items: [] };
}

// Map a legacy parser event to the unified tool-call shape.
function toTool(ev) {
  switch (ev.type) {
    case 'file': return { type: 'tool', name: 'write_file', arguments: { path: ev.path, content: ev.content } };
    case 'edit': return { type: 'tool', name: 'edit_file', arguments: { path: ev.path, edits: ev.hunks || [] } };
    case 'delete': return { type: 'tool', name: 'delete_file', arguments: { path: ev.path } };
    case 'rename': return { type: 'tool', name: 'rename_file', arguments: { from: ev.from, to: ev.to } };
    case 'asset': return { type: 'tool', name: 'create_asset', arguments: { path: ev.path, data: ev.data, encoding: ev.encoding } };
    case 'seed': return { type: 'tool', name: 'seed_database', arguments: { collection: ev.collection, items: ev.items || [], clear: ev.clear } };
    case 'plan': return { type: 'tool', name: 'update_plan', arguments: { items: ev.items || [] } };
    case 'name': return { type: 'tool', name: 'set_name', arguments: { name: ev.name } };
    case 'delegate': return { type: 'tool', name: 'delegate', arguments: { path: ev.path, task: ev.task } };
    case 'cmd': return { type: 'tool', name: 'run_command', arguments: { command: ev.command } };
    case 'test': return { type: 'tool', name: 'test', arguments: { note: ev.note } };
    default: return null;
  }
}

// Normalize a parsed JSON object into a tool-call event. Tolerates a few common
// shapes (name/arguments, tool/args, or inline arguments).
function normalizeTool(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  let name = obj.name ?? obj.tool ?? obj.tool_name ?? obj.function;
  let args = obj.arguments ?? obj.args ?? obj.parameters ?? obj.input;
  if (name && typeof name === 'object') {
    args = args ?? name.arguments ?? name.parameters;
    name = name.name;
  }
  if (typeof args === 'string') {
    args = parseLooseJson(args, {});
  }
  if (!name || typeof name !== 'string') return null;
  if (args === undefined || args === null) {
    const rest = { ...obj };
    delete rest.name; delete rest.tool; delete rest.tool_name; delete rest.function;
    delete rest.arguments; delete rest.args; delete rest.parameters; delete rest.input;
    args = rest;
  }
  return { type: 'tool', name, arguments: args && typeof args === 'object' ? args : {} };
}

function mergeText(events) {
  const merged = [];
  for (const ev of events) {
    const last = merged[merged.length - 1];
    if (ev.type === 'text' && last && last.type === 'text') last.v += ev.v;
    else merged.push(ev);
  }
  return merged;
}

export class FileStreamer {
  constructor() {
    this.buf = '';
    this.frames = []; // legacy body/batch frame stack
    this.tool = null; // in-progress >>>tool call
  }

  feed(chunk) {
    const events = [];
    this.buf += chunk;
    for (;;) {
      if (this.tool) {
        if (!this._drainTool(events)) break;
        continue;
      }
      const top = this.frames[this.frames.length - 1];
      if (top && top.kind === 'BATCH') {
        if (!this._drainBatch(events)) break;
        continue;
      }
      if (top) {
        if (!this._drainBody(events)) break;
        continue;
      }
      if (!this._drainText(events)) break;
    }
    return mergeText(events);
  }

  /* ---- unified >>>tool protocol -------------------------------------------- */

  _drainText(events) {
    const ti = this.buf.indexOf(TOOL_OPEN);
    const li = this.buf.indexOf(TAG_OPEN);
    let idx = -1;
    let kind = '';
    if (ti !== -1 && (li === -1 || ti < li)) { idx = ti; kind = 'tool'; }
    else if (li !== -1) { idx = li; kind = 'legacy'; }

    if (idx === -1) {
      // Hold back a possible split of the open marker; flush everything else.
      const keep = Math.min(TOOL_OPEN.length - 1, this.buf.length);
      if (this.buf.length > keep) {
        events.push({ type: 'text', v: this.buf.slice(0, this.buf.length - keep) });
        this.buf = this.buf.slice(this.buf.length - keep);
      }
      return false;
    }

    if (idx > 0) {
      events.push({ type: 'text', v: this.buf.slice(0, idx) });
      this.buf = this.buf.slice(idx);
    }
    if (kind === 'tool') {
      this.buf = this.buf.slice(TOOL_OPEN.length);
      const name = this._readToolName();
      this.tool = { json: '', started: false, depth: 0, inStr: false, esc: false, name, awaitingClose: false };
      return true;
    }

    // Legacy header — wait until the closing >>> has arrived.
    const j = this.buf.indexOf(TAG_CLOSE);
    if (j === -1) return false;
    const raw = this.buf.slice(TAG_OPEN.length, j).trim();
    this.buf = this.buf.slice(j + TAG_CLOSE.length);
    this._openHeader(raw, events);
    return true;
  }

  // Lenient form: `>>>tool write_file` (name before the JSON). Returns '' when
  // the call uses the canonical `>>>tool\n{json}` shape.
  _readToolName() {
    let i = 0;
    while (i < this.buf.length && /\s/.test(this.buf[i])) i++;
    const c = this.buf[i];
    if (!c || !/[A-Za-z_]/.test(c)) return '';
    let j = i;
    while (j < this.buf.length && /[A-Za-z0-9_]/.test(this.buf[j])) j++;
    if (j >= this.buf.length) return ''; // name may still be streaming in
    const name = this.buf.slice(i, j);
    const after = this.buf[j];
    if (after && !/\s|\{|\[/.test(after)) return '';
    this.buf = this.buf.slice(j);
    return name;
  }

  _drainTool(events) {
    const t = this.tool;
    if (t.awaitingClose) {
      const ci = this.buf.indexOf(TAG_OPEN);
      if (ci === -1) return false;
      this.buf = this.buf.slice(ci + TAG_OPEN.length);
      this.tool = null;
      this._pushTool(t.json, t.name, events);
      return true;
    }

    // Skip leading whitespace before the JSON value.
    if (!t.started) {
      let i = 0;
      while (i < this.buf.length && /\s/.test(this.buf[i])) i++;
      if (i >= this.buf.length) { this.buf = ''; return false; }
      if (i > 0) this.buf = this.buf.slice(i);
    }

    let end = -1;
    for (let j = 0; j < this.buf.length; j++) {
      const ch = this.buf[j];
      if (t.inStr) {
        if (t.esc) t.esc = false;
        else if (ch === '\\') t.esc = true;
        else if (ch === '"') t.inStr = false;
        continue;
      }
      if (ch === '"') { t.inStr = true; t.started = true; continue; }
      if (ch === '{' || ch === '[') { t.depth++; t.started = true; continue; }
      if (ch === '}' || ch === ']') {
        t.depth--;
        if (t.depth <= 0 && t.started) { end = j; break; }
      }
    }

    if (end === -1) { t.json += this.buf; this.buf = ''; return false; } // every char consumed into state
    t.json += this.buf.slice(0, end + 1);
    this.buf = this.buf.slice(end + 1);
    this.tool = { json: t.json, name: t.name, awaitingClose: true };
    return true;
  }

  _pushTool(json, hintName, events) {
    const obj = parseLooseJson(json, null);
    let ev = obj ? normalizeTool(obj) : null;
    // `>>>tool name {…}` form: the JSON value IS the arguments object.
    if (!ev && hintName && obj && typeof obj === 'object' && !Array.isArray(obj)) {
      ev = { type: 'tool', name: hintName, arguments: obj };
    }
    if (ev && !ev.name && hintName) ev.name = hintName;
    // A block that can't be decoded into a named tool call used to be silently
    // demoted to prose: the round then "succeeded" but the requested file never
    // got created and the model never noticed. Fail LOUDLY with a sentinel tool
    // instead, so the caller records a diagnostic and forces a retry.
    if (!ev || !ev.name) {
      events.push({ type: 'tool', name: '_parse_error', arguments: { raw: String(json).slice(0, 2000) } });
      return;
    }
    this._emit(ev, events);
  }

  /* ---- legacy block protocol (normalized into tool events) ------------------ */

  _drainBatch(events) {
    const be = this.buf.indexOf(BATCH_END);
    const to = this.buf.indexOf(TAG_OPEN);
    if (be !== -1 && (to === -1 || be <= to)) {
      this.buf = this.buf.slice(be + BATCH_END.length);
      const frame = this.frames.pop();
      this._emit({ type: 'tool', name: 'batch', arguments: { tools: frame.calls } }, events);
      return true;
    }
    if (to === -1) {
      const keep = Math.max(0, this.buf.length - Math.max(BATCH_END.length - 1, TAG_OPEN.length - 1));
      this.buf = this.buf.slice(keep);
      return false;
    }
    const j = this.buf.indexOf(TAG_CLOSE, to);
    if (j === -1) return false; // header not complete yet
    const raw = this.buf.slice(to + TAG_OPEN.length, j).trim();
    this.buf = this.buf.slice(j + TAG_CLOSE.length);
    this._openHeader(raw, events);
    return true;
  }

  _drainBody(events) {
    const top = this.frames[this.frames.length - 1];
    const k = this.buf.indexOf(END_TAG);
    if (k === -1) {
      const keep = Math.max(0, this.buf.length - (END_TAG.length - 1));
      if (keep > 0) { top.body += this.buf.slice(0, keep); this.buf = this.buf.slice(keep); }
      return false;
    }
    top.body += this.buf.slice(0, k);
    this.buf = this.buf.slice(k + END_TAG.length);
    this.frames.pop();
    const ev = this._closeFrame(top);
    const tool = ev && toTool(ev);
    if (tool) this._emit(tool, events);
    return true;
  }

  _emit(ev, events) {
    const top = this.frames[this.frames.length - 1];
    if (top && top.kind === 'BATCH') { top.calls.push(ev); return; }
    events.push(ev);
  }

  _openHeader(raw, events) {
    raw = raw.replace(/^<+/, ''); // tolerate a stray '<' that clung to the tag
    const c = raw.indexOf(':');
    const kind = (c === -1 ? raw : raw.slice(0, c)).trim().toUpperCase();
    const arg = (c === -1 ? '' : raw.slice(c + 1)).trim();
    if (!KINDS.includes(kind)) {
      events.push({ type: 'text', v: TAG_OPEN + raw + TAG_CLOSE }); // unknown block — show as prose
      return;
    }
    if (kind === 'BATCH') {
      this.frames.push({ kind: 'BATCH', calls: [] });
      return;
    }
    if (kind === 'DELETE') { this._emit(toTool({ type: 'delete', path: arg }), events); return; }
    if (kind === 'NAME') { this._emit(toTool({ type: 'name', name: arg }), events); return; }
    if (kind === 'CMD') {
      if (arg) { this._emit(toTool({ type: 'cmd', command: arg }), events); return; }
      this.frames.push({ kind, path: '', body: '' });
      return;
    }
    if (kind === 'RENAME') {
      const m = arg.match(/^(.*?)\s*(?:->|→)\s*(.*)$/);
      if (m) this._emit(toTool({ type: 'rename', from: m[1].trim(), to: m[2].trim() }), events);
      else events.push({ type: 'text', v: TAG_OPEN + raw + TAG_CLOSE });
      return;
    }
    if (BODY_KINDS.includes(kind)) {
      this.frames.push({ kind, path: arg, body: '' });
      return;
    }
    events.push({ type: 'text', v: TAG_OPEN + raw + TAG_CLOSE });
  }

  _closeFrame(frame) {
    const { kind, path } = frame;
    switch (kind) {
      case 'FILE':
        return { type: 'file', path, content: stripFences(frame.body.trim()) };
      case 'EDIT':
        return { type: 'edit', path, hunks: parseEditHunks(frame.body) };
      case 'PLAN':
        return { type: 'plan', items: parsePlan(frame.body) };
      case 'DELEGATE':
        return { type: 'delegate', path, task: stripFences(frame.body.trim()) };
      case 'ASSET': {
        const p = assetPayload(frame.body);
        return { type: 'asset', path, data: p.data, encoding: p.encoding };
      }
      case 'SEED': {
        const s = seedPayload(frame.body);
        return { type: 'seed', collection: path, items: s.items, clear: s.clear };
      }
      case 'CMD':
        return { type: 'cmd', command: stripFences(frame.body.trim()) };
      case 'TEST':
        return { type: 'test', note: stripFences(frame.body.trim()).slice(0, 400) };
      default:
        return null;
    }
  }

  flush() {
    const events = [];
    // A complete tool call missing only its closing <<< is still useful.
    if (this.tool && this.tool.awaitingClose) this._pushTool(this.tool.json, this.tool.name, events);
    this.tool = null;
    while (this.frames.length) {
      const frame = this.frames.pop();
      if (frame.kind === 'BATCH') {
        this._emit({ type: 'tool', name: 'batch', arguments: { tools: frame.calls } }, events);
        continue;
      }
      const ev = this._closeFrame(frame);
      const tool = ev && toTool(ev);
      if (tool) this._emit(tool, events);
    }
    if (this.buf) {
      events.push({ type: 'text', v: this.buf });
      this.buf = '';
    }
    return mergeText(events);
  }
}

function stripFences(s) {
  s = s.replace(/^```[a-zA-Z0-9]*\s*\n/, '');
  s = s.replace(/\n```\s*$/, '');
  return s;
}
