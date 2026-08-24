// Streaming parser for the generator protocol:
//   <<<FILE:index.html>>>   full file content            <<<END>>>
//   <<<EDIT:js/app.js>>>    search/replace hunks         <<<END>>>
//   <<<DELETE:old.js>>>     (no content needed)          <<<END>>>
//   <<<PLAN>>>              markdown checklist lines      <<<END>>>
// EDIT bodies use:
//   <<<<<<< SEARCH
//   old text
//   =======
//   new text
//   >>>>>>> REPLACE
// Feed chunks via feed(); yields {type:'text'|'file'|'edit'|'delete'|'plan'} events.

const TAG_OPEN = '<<<';
const TAG_CLOSE = '>>>';
const END_TAG = '<<<END>>>';
const S_MARK = '<<<<<<< SEARCH';
const R_MARK = '>>>>>>> REPLACE';
const M_MARK = '=======';

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

export class FileStreamer {
  constructor() {
    this.buf = '';
    this.tag = null;     // null = outside, '' = tag name incomplete, else {kind,path}
    this.body = '';
  }

  feed(chunk) {
    const events = [];
    this.buf += chunk;
    for (;;) {
      if (this.tag === null) {
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
        this.buf = this.buf.slice(i + TAG_OPEN.length);
        this.tag = '';
        this.body = '';
      } else if (this.tag === '') {
        const j = this.buf.indexOf(TAG_CLOSE);
        // '<<<END' could still be forming a close tag — wait for more input
        if (j === -1) {
          if (END_TAG.startsWith(TAG_OPEN + this.buf.slice(0, END_TAG.length - TAG_OPEN.length)) ||
              this.buf.length < END_TAG.length) break;
          // not an END tag forming and no '>' yet — keep waiting (harmless)
          break;
        }
        const raw = this.buf.slice(0, j).trim();
        this.buf = this.buf.slice(j + TAG_CLOSE.length);
        if (raw.toUpperCase() === 'END') { this.tag = null; continue; }
        const c = raw.indexOf(':');
        const kind = (c === -1 ? raw : raw.slice(0, c)).trim().toUpperCase();
        const path = c === -1 ? '' : raw.slice(c + 1).trim();
        if (!['FILE', 'EDIT', 'DELETE', 'PLAN'].includes(kind)) {
          this.tag = null; // unknown tag — treat as plain text next round
          events.push({ type: 'text', v: TAG_OPEN + raw + TAG_CLOSE });
          continue;
        }
        this.tag = { kind, path };
        this.body = '';
        if (kind === 'DELETE') {
          events.push({ type: 'delete', path });
          this.tag = null;
        }
      } else {
        const k = this.buf.indexOf(END_TAG);
        if (k === -1) {
          const keep = Math.max(0, this.buf.length - (END_TAG.length - 1));
          if (keep > 0) {
            this.body += this.buf.slice(0, keep);
            this.buf = this.buf.slice(keep);
          }
          break;
        }
        this.body += this.buf.slice(0, k);
        this.buf = this.buf.slice(k + END_TAG.length);
        const { kind, path } = this.tag;
        this.tag = null;
        if (kind === 'FILE') {
          events.push({ type: 'file', path, content: stripFences(this.body.trim()) });
        } else if (kind === 'EDIT') {
          events.push({ type: 'edit', path, hunks: parseEditHunks(this.body) });
        } else if (kind === 'PLAN') {
          events.push({ type: 'plan', items: parsePlan(this.body) });
        }
        this.body = '';
      }
    }
    return events;
  }

  flush() {
    const out = [];
    if (this.tag && typeof this.tag === 'object') {
      const { kind, path } = this.tag;
      if (kind === 'FILE') out.push({ type: 'file', path, content: stripFences(this.body.trim()), truncated: true });
      else if (kind === 'EDIT') out.push({ type: 'edit', path, hunks: parseEditHunks(this.body), truncated: true });
      else if (kind === 'PLAN') out.push({ type: 'plan', items: parsePlan(this.body) });
    } else if (this.buf && this.tag === null) {
      out.push({ type: 'text', v: this.buf });
    }
    this.buf = ''; this.body = ''; this.tag = null;
    return out;
  }
}

function stripFences(s) {
  s = s.replace(/^```[a-zA-Z0-9]*\s*\n/, '');
  s = s.replace(/\n```\s*$/, '');
  return s;
}
