// Streaming parser for the generator protocol. Feed chunks via feed(); each
// call yields an array of events:
//   text                               plain prose outside any block
//   file/asset   -> wrote a full file (utf8 or base64/data-URI content)
//   edit         -> SEARCH/REPLACE hunks for an existing file
//   delete       -> remove a file
//   rename       -> move a file and refactor references elsewhere
//   plan/name    -> plan checklist / project title
//   delegate     -> hand a file to a parallel sub-agent
//   cmd          -> a shell command the client should run on the device
//   run          -> execute functions/<name>.js with JSON input
//   seed         -> insert demo rows into a creat.db collection
//   batch/endbatch -> group of ops applied atomically (BATCH ... BATCHEND)
//
// Block syntax:
//   <<<FILE:index.html>>>   content              <<<END>>>
//   <<<EDIT:js/app.js>>>    SEARCH/REPLACE hunks <<<END>>>
//   <<<DELETE:old.js>>>                            (no body needed)
//   <<<RENAME:old.js -> js/app.js>>>              (no body needed)
//   <<<ASSET:img/logo.png>>> data URI or base64   <<<END>>>
//   <<<RUN:score.js>>>       JSON input            <<<END>>>
//   <<<SEED:products>>>      JSON rows             <<<END>>>
//   <<<PLAN>>>              checklist lines        <<<END>>>
//   <<<NAME:App title>>>                           (no body needed)
//   <<<DELEGATE:css/t.min.css>>> task description  <<<END>>>
//   <<<CMD>>>              shell command           <<<END>>>  (or <<<CMD:ls -la>>> one-liner)
//   <<<BATCH>>> ... any blocks above ... <<<BATCHEND>>>
//
// EDIT bodies use:
//   <<<<<<< SEARCH
//   old text
//   =======
//   new text
//   >>>>>>> REPLACE

const TAG_OPEN = '<<<';
const TAG_CLOSE = '>>>';
const END_TAG = '<<<END>>>';
const BATCH_END = '<<<BATCHEND>>>';
const S_MARK = '<<<<<<< SEARCH';
const R_MARK = '>>>>>>> REPLACE';
const M_MARK = '=======';

const KINDS = ['FILE', 'EDIT', 'DELETE', 'PLAN', 'NAME', 'DELEGATE', 'RENAME', 'RUN', 'ASSET', 'SEED', 'BATCH', 'CMD'];
const BODY_KINDS = ['FILE', 'EDIT', 'PLAN', 'DELEGATE', 'RUN', 'ASSET', 'SEED', 'CMD'];
const PASS_THROUGH_KINDS = ['DELETE', 'NAME', 'RENAME'];

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

function parseJsonOr(body, fallback) {
  try {
    return JSON.parse(body.trim());
  } catch {
    return fallback;
  }
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

export class FileStreamer {
  constructor() {
    this.buf = '';
    this.frames = []; // stack of {kind, path, body}; stack top is the open block
  }

  feed(chunk) {
    const events = [];
    this.buf += chunk;
    for (;;) {
      const top = this.frames[this.frames.length - 1];

      if (top && top.kind === 'BATCH') {
        // Inside a batch: wait for a nested block to open or BATCHEND.
        const be = this.buf.indexOf(BATCH_END);
        const to = this.buf.indexOf(TAG_OPEN);
        if (be !== -1 && (to === -1 || be <= to)) {
          this.buf = this.buf.slice(be + BATCH_END.length);
          this.frames.pop();
          events.push(this.stamp({ type: 'endbatch' }));
          continue;
        }
        if (to === -1) {
          const keep = Math.max(0, this.buf.length - Math.max(BATCH_END.length - 1, TAG_OPEN.length - 1));
          if (keep > 0) this.buf = this.buf.slice(keep);
          break;
        }
        const j = this.buf.indexOf(TAG_CLOSE, to);
        if (j === -1) break; // header not complete yet
        const raw = this.buf.slice(to + TAG_OPEN.length, j).trim();
        this.buf = this.buf.slice(j + TAG_CLOSE.length);
        this._openHeader(raw, events);
        continue;
      }

      if (top) {
        // Inside a real block: accumulate until END_TAG.
        const k = this.buf.indexOf(END_TAG);
        if (k === -1) {
          const keep = Math.max(0, this.buf.length - (END_TAG.length - 1));
          if (keep > 0) { top.body += this.buf.slice(0, keep); this.buf = this.buf.slice(keep); }
          break;
        }
        top.body += this.buf.slice(0, k);
        this.buf = this.buf.slice(k + END_TAG.length);
        this.frames.pop();
        const ev = this._closeFrame(top, false);
        if (ev) events.push(this.stamp(ev));
        continue;
      }

      // Top level: outside any block.
      const i = this.buf.indexOf(TAG_OPEN);
      if (i === -1) {
        const keep = Math.max(0, this.buf.length - (TAG_OPEN.length - 1));
        if (keep > 0) {
          events.push({ type: 'text', v: this.buf.slice(0, keep) });
          this.buf = this.buf.slice(keep);
        }
        break;
      }
      if (i > 0) events.push({ type: 'text', v: this.buf.slice(0, i) });
      const j = this.buf.indexOf(TAG_CLOSE, i);
      if (j === -1) {
        this.buf = this.buf.slice(i);
        break; // tag header incomplete — wait for more input
      }
      const raw = this.buf.slice(i + TAG_OPEN.length, j).trim();
      this.buf = this.buf.slice(j + TAG_CLOSE.length);
      this._openHeader(raw, events);
    }
    const merged = [];
    for (const ev of events) {
      const last = merged[merged.length - 1];
      if (ev.type === 'text' && last && last.type === 'text') last.v += ev.v;
      else merged.push(ev);
    }
    return merged;
  }

  stamp(ev) {
    if (this.frames.some((f) => f.kind === 'BATCH')) ev.batch = true;
    return ev;
  }

  _openHeader(raw, events) {
    raw = raw.replace(/^<+/, ''); // tolerate a stray '<' that clung to the tag
    const up = raw.toUpperCase();
    if (up === 'END') return;
    const c = raw.indexOf(':');
    const kind = (c === -1 ? raw : raw.slice(0, c)).trim().toUpperCase();
    const arg = (c === -1 ? '' : raw.slice(c + 1)).trim();
    if (!KINDS.includes(kind)) {
      events.push({ type: 'text', v: TAG_OPEN + raw + TAG_CLOSE }); // unknown block — show as prose
      return;
    }
    if (kind === 'BATCH') {
      this.frames.push({ kind: 'BATCH', path: '', body: '' });
      events.push(this.stamp({ type: 'batch' }));
      return;
    }
    if (kind === 'DELETE') {
      events.push(this.stamp({ type: 'delete', path: arg }));
      return;
    }
    if (kind === 'NAME') {
      events.push(this.stamp({ type: 'name', name: arg }));
      return;
    }
    if (kind === 'CMD') {
      // One-liner form: <<<CMD:ls -la>>>  (takes priority over the body form)
      if (arg) {
        events.push(this.stamp({ type: 'cmd', command: arg }));
        return;
      }
      this.frames.push({ kind, path: '', body: '' }); // body form
      return;
    }
    if (kind === 'RENAME') {
      const m = arg.match(/^(.*?)\s*(?:->|→)\s*(.*)$/);
      if (m) events.push(this.stamp({ type: 'rename', from: m[1].trim(), to: m[2].trim() }));
      else events.push({ type: 'text', v: TAG_OPEN + raw + TAG_CLOSE });
      return;
    }
    if (BODY_KINDS.includes(kind)) {
      this.frames.push({ kind, path: arg, body: '' });
      return;
    }
    events.push({ type: 'text', v: TAG_OPEN + raw + TAG_CLOSE });
  }

  _closeFrame(frame, truncated) {
    const { kind, path } = frame;
    switch (kind) {
      case 'FILE':
        return { type: 'file', path, content: stripFences(frame.body.trim()), truncated };
      case 'EDIT':
        return { type: 'edit', path, hunks: parseEditHunks(frame.body), truncated };
      case 'PLAN':
        return { type: 'plan', items: parsePlan(frame.body) };
      case 'DELEGATE':
        return { type: 'delegate', path, task: stripFences(frame.body.trim()), truncated };
      case 'RUN':
        return { type: 'run', name: path, input: parseJsonOr(frame.body, frame.body.trim() || null), truncated };
      case 'ASSET': {
        const p = assetPayload(frame.body);
        return { type: 'asset', path, data: p.data, encoding: p.encoding, truncated };
      }
      case 'SEED': {
        const s = seedPayload(frame.body);
        return { type: 'seed', collection: path, items: s.items, clear: s.clear, truncated };
      }
      case 'CMD':
        return { type: 'cmd', command: stripFences(frame.body.trim()), truncated };
      default:
        return null;
    }
  }

  flush() {
    const out = [];
    while (this.frames.length) {
      const frame = this.frames.pop();
      if (frame.kind === 'BATCH') {
        out.push(this.stamp({ type: 'endbatch' }));
        continue;
      }
      const ev = this._closeFrame(frame, true);
      if (ev) out.push(this.stamp(ev));
    }
    if (this.buf) {
      out.push({ type: 'text', v: this.buf });
      this.buf = '';
    }
    return out;
  }
}

function stripFences(s) {
  s = s.replace(/^```[a-zA-Z0-9]*\s*\n/, '');
  s = s.replace(/\n```\s*$/, '');
  return s;
}