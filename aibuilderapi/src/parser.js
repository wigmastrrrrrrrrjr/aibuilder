// Streaming parser for the generator protocol:
//   <<<FILE:index.html>>>
//   <full file content>
//   <<<END>>>
// Feed chunks via feed(); yields {type:'text'|'file', ...} events as they complete.

const START = '<<<FILE:';
const START_END = '>>>';
const END = '<<<END>>>';

export class FileStreamer {
  constructor() {
    this.buf = '';
    this.path = null;   // non-null while inside a file block ('' = header not closed yet)
    this.body = '';
  }

  feed(chunk) {
    const events = [];
    this.buf += chunk;
    for (;;) {
      if (this.path === null) {
        const i = this.buf.indexOf(START);
        if (i === -1) {
          // emit everything except a possible partial marker at the tail
          const keep = Math.max(0, this.buf.length - (START.length - 1));
          if (keep > 0) {
            events.push({ type: 'text', v: this.buf.slice(0, keep) });
            this.buf = this.buf.slice(keep);
          }
          break;
        }
        if (i > 0) events.push({ type: 'text', v: this.buf.slice(0, i) });
        this.buf = this.buf.slice(i + START.length);
        const j = this.buf.indexOf(START_END);
        if (j === -1) { this.path = ''; break; } // header not complete yet
        this.path = this.buf.slice(0, j).trim();
        this.buf = this.buf.slice(j + START_END.length);
        this.body = '';
      } else if (this.path === '') {
        const j = this.buf.indexOf(START_END);
        if (j === -1) break;
        this.path = this.buf.slice(0, j).trim();
        this.buf = this.buf.slice(j + START_END.length);
      } else {
        const k = this.buf.indexOf(END);
        if (k === -1) {
          const keep = Math.max(0, this.buf.length - (END.length - 1));
          if (keep > 0) {
            this.body += this.buf.slice(0, keep);
            this.buf = this.buf.slice(keep);
          }
          break;
        }
        const fpath = this.path;
        const content = stripFences((this.body + this.buf.slice(0, k)).trim());
        this.buf = this.buf.slice(k + END.length);
        this.path = null;
        this.body = '';
        events.push({ type: 'file', path: fpath, content });
      }
    }
    return events;
  }

  flush() {
    const out = [];
    if (this.path !== null && this.path !== '') {
      out.push({
        type: 'file', path: this.path,
        content: stripFences((this.body + this.buf).trim()), truncated: true,
      });
    } else if (this.buf && this.path === null) {
      out.push({ type: 'text', v: this.buf });
    }
    this.buf = ''; this.body = ''; this.path = null;
    return out;
  }
}

function stripFences(s) {
  s = s.replace(/^```[a-zA-Z0-9]*\s*\n/, '');
  s = s.replace(/\n```\s*$/, '');
  return s;
}
