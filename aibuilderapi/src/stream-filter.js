// Server-side split between "prose the user should read" and "payload the
// model emits to do work".
//
// A build turn streams two very different things through the same token pipe:
//
//   1. comments meant for the person watching ("Adding the invoices table…"),
//   2. machine payloads — a `>>>tool {…} <<<` call, or a legacy
//      `<<<FILE:path>>>…<<<` block — that carry entire files.
//
// Only (1) belongs in the chat transcript. (2) used to be streamed to the
// browser verbatim and stripped there by web/app.js BlockFilter: every
// generated file crossed the wire twice, the transcript briefly showed raw
// JSON, and a slow link could lag badly during a big write. This module is the
// same state machine the SPA uses, moved to the server so payloads never leave
// the worker at all. The SPA keeps its filter as a defence for older servers.
//
// The parser is deliberately tolerant: it runs on arbitrary chunk boundaries,
// so a marker or JSON value can be split across pushes.

const TOOL_OPEN = '>>>tool';
const LEGACY_OPEN = '<<<';
const LEGACY_CLOSE = '>>>';

// Legacy `<<<KIND …>>>` blocks that carry payloads (files, edits, plans…).
const PAYLOAD_KINDS = new Set(['FILE', 'EDIT', 'PLAN', 'DELEGATE', 'ASSET', 'SEED', 'BATCH']);
const CLOSE_KINDS = new Set(['END', 'BATCHEND']);

export class VisibleStream {
  constructor() {
    this.buf = '';
    this.depth = 0;   // open legacy <<<…>>> blocks
    this.tool = null; // state while inside a >>>tool … <<< call
  }

  /** Feed a chunk; returns the prose that is safe to show right now. */
  push(chunk) {
    this.buf += String(chunk ?? '');
    let out = '';
    for (;;) {
      if (this.tool) {
        if (!this.#skipToolPayload()) break;
        continue;
      }
      const ti = this.buf.indexOf(TOOL_OPEN);
      const li = this.buf.indexOf(LEGACY_OPEN);
      if (ti !== -1 && (li === -1 || ti < li)) {
        if (ti > 0) out += this.buf.slice(0, ti);
        this.buf = this.buf.slice(ti + TOOL_OPEN.length);
        this.tool = { started: false, depth: 0, inStr: false, esc: false, jsonDone: false };
        continue;
      }
      if (li === -1) {
        if (this.depth > 0) {
          // Inside a legacy payload block: everything here is a file body, not
          // prose. Drop it, keeping only a possible partial close marker.
          const keep = this.#partialMarkerTail();
          this.buf = keep ? this.buf.slice(this.buf.length - keep) : '';
          break;
        }
        // No marker in the buffer. Emit everything except a tail that could
        // still grow into one ("<<<", ">>>to", …) — the next push may complete
        // it, and streaming half a marker would leak payload text.
        const cut = this.buf.length - this.#partialMarkerTail();
        if (cut > 0) { out += this.buf.slice(0, cut); this.buf = this.buf.slice(cut); }
        break;
      }
      if (li > 0) {
        if (this.depth === 0) out += this.buf.slice(0, li);
        this.buf = this.buf.slice(li);
      }
      const end = this.buf.indexOf(LEGACY_CLOSE, LEGACY_OPEN.length);
      if (end === -1) break; // header not complete yet
      const header = this.buf.slice(LEGACY_OPEN.length, end).trim().toUpperCase();
      const kind = header.split(':')[0];
      this.buf = this.buf.slice(end + LEGACY_CLOSE.length);
      if (CLOSE_KINDS.has(kind)) this.depth = Math.max(0, this.depth - 1);
      else if (PAYLOAD_KINDS.has(kind)) this.depth += 1;
    }
    return out;
  }

  /** Whatever is still buffered when the model stops. */
  flush() {
    if (this.depth > 0 || this.tool) { this.buf = ''; return ''; }
    const rest = this.buf;
    this.buf = '';
    return rest;
  }

  // Length of the longest tail that is a prefix of an opening marker.
  #partialMarkerTail() {
    const max = Math.min(Math.max(TOOL_OPEN.length, LEGACY_OPEN.length) - 1, this.buf.length);
    for (let keep = max; keep > 0; keep--) {
      const tail = this.buf.slice(this.buf.length - keep);
      if (TOOL_OPEN.startsWith(tail) || LEGACY_OPEN.startsWith(tail)) return keep;
    }
    return 0;
  }

  // Consume the JSON value of a tool call and its closing `<<<`.
  // Returns false when more text is needed (the caller stops and waits).
  #skipToolPayload() {
    const tool = this.tool;
    // Nothing has opened a JSON value yet. A close marker here means the call
    // was malformed (`>>>tool\nnot json\n<<<`): end the call at the marker so
    // the prose after it survives instead of being swallowed to the end of the
    // round — the tool parser still reports the malformed call.
    if (!tool.started) {
      const ci = this.buf.indexOf(LEGACY_OPEN);
      if (ci !== -1) {
        this.buf = this.buf.slice(ci + LEGACY_OPEN.length);
        this.tool = null;
        return true;
      }
      // Hold a partial marker for the next chunk; drop the rest (it is payload).
      const keep = this.buf.endsWith('<<') ? 2 : this.buf.endsWith('<') ? 1 : 0;
      this.buf = keep ? this.buf.slice(this.buf.length - keep) : '';
      return false;
    }
    let i = 0;
    for (; i < this.buf.length && !tool.jsonDone; i++) {
      const ch = this.buf[i];
      if (tool.inStr) {
        if (tool.esc) tool.esc = false;
        else if (ch === '\\') tool.esc = true;
        else if (ch === '"') tool.inStr = false;
        continue;
      }
      if (ch === '"') { tool.inStr = true; tool.started = true; continue; }
      if (ch === '{' || ch === '[') { tool.depth += 1; tool.started = true; continue; }
      if (ch === '}' || ch === ']') {
        tool.depth -= 1;
        if (tool.depth <= 0 && tool.started) { tool.jsonDone = true; i += 1; break; }
      }
    }
    this.buf = this.buf.slice(i);
    if (!tool.jsonDone) {
      this.buf = this.buf.slice(Math.max(0, this.buf.length - 2));
      return false;
    }
    const close = this.buf.indexOf(LEGACY_OPEN);
    if (close === -1) {
      this.buf = this.buf.slice(Math.max(0, this.buf.length - 2));
      return false;
    }
    this.buf = this.buf.slice(close + LEGACY_OPEN.length);
    this.tool = null;
    return true;
  }
}

/** Strip every payload block from a complete string (history, logs, UI). */
export function stripBlocks(text) {
  const f = new VisibleStream();
  return (f.push(String(text ?? '')) + f.flush()).trim();
}
