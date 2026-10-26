// A store that behaves exactly like the real one for everything EXCEPT files.
//
// Draft mode makes the browser the owner of the project: the client sends its
// current files with each turn, the AI works on that copy, and nothing is
// persisted until the user presses Save. Tools are unchanged — they still call
// saveFile / getFile / listFiles / deleteFile — so this proxy is the seam: it
// keeps files in memory and delegates every other call (messages, snapshots,
// plans, baas tables, project metadata) to the real store.
//
// Keeping the delegation blanket-shaped matters: a tool that suddenly hit a
// missing method would look like a failed operation, and the repair loop would
// chase a phantom.

import { cleanPath } from './tools.js';

export function createDraftStore(real, initial = []) {
  const files = new Map();      // path -> content
  const encodings = new Map();  // path -> 'utf8' | 'base64'

  const put = (path, content, encoding) => {
    files.set(path, String(content ?? ''));
    if (encoding && encoding !== 'utf8') encodings.set(path, encoding);
    else encodings.delete(path);
  };

  for (const f of Array.isArray(initial) ? initial : []) {
    const p = cleanPath(f && f.path);
    if (!p) continue;
    put(p, f.content, f.encoding);
  }

  const encOf = (p) => encodings.get(p) || 'utf8';
  const rows = () => [...files.keys()].sort().map((path) => ({ path, content: files.get(path), encoding: encOf(path) }));

  const api = {
    // ---- file surface: memory only -------------------------------------
    async saveFile(_pid, path, content, encoding) {
      const p = cleanPath(path);
      if (!p) throw new Error('invalid path');
      put(p, content, encoding);
      return { ok: true, path: p };
    },
    async getFile(_pid, path) {
      const p = cleanPath(path);
      if (!p || !files.has(p)) return null;
      return { path: p, content: files.get(p), encoding: encOf(p) };
    },
    async deleteFile(_pid, path) {
      const p = cleanPath(path);
      const had = p ? files.delete(p) : false;
      if (p) encodings.delete(p);
      return { ok: true, deleted: had };
    },
    async listFiles() {
      return [...files.keys()].sort().map((path) => ({ path, updated_at: 0 }));
    },
    async listFilesWithContent() {
      return rows();
    },

    // ---- helpers the draft turn itself uses ----------------------------
    /** Every file in the draft (what the client should mirror). */
    draftFiles() {
      return rows();
    },
    /** Snapshot for change detection across a round. */
    snapshot() {
      return new Map(files);
    },
    /** Files added/changed/removed since `before`. */
    delta(before) {
      const changed = [];
      for (const [path, content] of files) {
        if (!before || before.get(path) !== content) {
          changed.push({ path, content, encoding: encOf(path) });
        }
      }
      const removed = [];
      if (before) for (const path of before.keys()) if (!files.has(path)) removed.push(path);
      return { files: changed, removed };
    },
  };

  // Everything not implemented above is the real store's.
  return new Proxy(api, {
    get(target, prop) {
      if (prop in target) return target[prop];
      const v = real[prop];
      return typeof v === 'function' ? v.bind(real) : v;
    },
    has(target, prop) {
      return prop in target || prop in real;
    },
  });
}
