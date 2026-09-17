// Headless page test: mirrors what the browser would hit when the user opens
// the built app. It resolves every resource a page references using the SAME
// lookup rules as the preview server (exact path, then path/index.html) and
// gives every script the same syntax check the console would flash.
//
// The engineer (AI) receives the report as an SSE `test` event and a copy is
// appended to its history so the next turn is told exactly what to fix.

const HTTP_RE = /^(https?:)?\/\//i;
const DIRECT_RE = /^(data:|blob:|mailto:|tel:|about:|javascript:|#)/i;

// ---- reference resolution (matches preview.js serveFile) --------------------
// ref is what appears in href/src/url(); basePath is the referring page.
function resolveRef(ref, basePath, files) {
  let r = String(ref || '').trim();
  if (!r || HTTP_RE.test(r) || DIRECT_RE.test(r)) return null; // external / ignored
  r = r.split('#')[0].split('?')[0];
  if (!r) return null;
  if (r.startsWith('//')) return null; // protocol-relative — external
  r = r.replace(/^\/+/, '');           // preview URLs are root-relative
  if (r.startsWith('./')) r = r.slice(2);

  const base = (basePath.split('/').filter(Boolean));
  base.pop(); // drop the referring file name itself
  for (const seg of r.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { base.pop(); continue; }
    base.push(seg);
  }
  const resolved = base.join('/');
  if (!resolved) return null; // resolved back to the root = the entry page; treat as ok
  if (files.has(resolved)) return resolved;
  if (!resolved.endsWith('/index.html')) {
    const asFolder = resolved + '/index.html';
    if (files.has(asFolder)) return asFolder;
  }
  return null; // the preview server would 404 this
}

// ---- JS syntax check --------------------------------------------------------
// new Function compiles but never executes (safe in a worker). Module ES
// (import/export) can't go through new Function, so those get a brace/paren
// balance scan instead. Returns null when the script looks compile-clean.
function lexStats(src) {
  let i = 0, n = src.length;
  const depth = { '(': 0, '[': 0, '{': 0 };
  const pair = { ')': '(', ']': '[', '}': '{' };
  let inStr = null, esc = false, lineC = false, blockC = false, tpl = false;
  let moduleish = false;
  while (i < n) {
    const ch = src[i];
    const nx = src[i + 1];
    if (lineC) { if (ch === '\n') lineC = false; i++; continue; }
    if (blockC) { if (ch === '*' && nx === '/') { blockC = false; i += 2; } else i++; continue; }
    if (inStr) {
      if (esc) { esc = false; i++; continue; }
      if (ch === '\\') { esc = true; i++; continue; }
      if (ch === inStr) inStr = null;
      i++; continue;
    }
    if (ch === '/' && nx === '/') { lineC = true; i += 2; continue; }
    if (ch === '/' && nx === '*') { blockC = true; i += 2; continue; }
    if (ch === '"' || ch === "'") { inStr = ch; i++; continue; }
    if (ch === '`') { tpl = !tpl; i++; continue; }
    if (tpl) { i++; continue; }
    const code = ch.charCodeAt(0);
    const word = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || ch === '_' || ch === '$';
    const digit = code >= 48 && code <= 57;
    if (word || digit) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
      const tok = src.slice(i, j);
      if (tok === 'import' || tok === 'export') {
        // adjacent char is whitespace / ( / ; — i.e. a real declaration,
        // not an identifier that merely contains "import".
        const after = j === n ? '\n' : src[j];
        if (!after || after === ' ' || after === '\n' || after === '\t' || after === '\r' || after === '(' || after === ';') moduleish = true;
      }
      i = j;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth[ch]++;
    else if (ch === ')' || ch === ']' || ch === '}') { depth[pair[ch]] = Math.max(0, depth[pair[ch]] - 1); }
    i++;
  }
  const balanced = depth['('] === 0 && depth['['] === 0 && depth['{'] === 0;
  return { balanced, moduleish };
}

function jsError(src) {
  const stats = lexStats(src);
  if (stats.moduleish) {
    // ES module syntax (import/export) can't go through new Function, so fall
    // back to the brace/paren balance scan. The scan is naive about regex
    // literals, so use it ONLY here — never for classic scripts, where the real
    // parser below is authoritative and regex-aware.
    return stats.balanced ? null : new Error('unbalanced braces/parens/brackets');
  }
  try { new Function(src); return null; } catch (e) { return e; }
}

// ---- freeze-risk detector ----------------------------------------------------
// A loop that provably never exits (always-true condition AND no break/return/
// throw anywhere in its body) locks the browser tab — nothing can paint or
// respond, which is exactly the "page is about to freeze" failure built pages
// hit after a careless edit. Detection is deliberately conservative so real
// loops with counters or exit keywords are never flagged.

const LOOP_ESCAPE_RE = /\b(?:break|return|throw)\b/;

// Runs a bare expression to see if it's deterministically TRUE. Pure
// expressions like true, 1, !0, 1===1 evaluate fine; anything referencing
// globals or variables throws and is treated as "not provably always true".
function alwaysTrueCond(condSrc) {
  const c = String(condSrc || '').trim();
  if (!c) return true; // for(;;) — empty condition
  try { return Boolean(new Function('return (' + c + ')')()); } catch { return false; }
}

// for(;;) / for(;true;) style forever-loops: the always-true clause sits in the
// SECOND semicolon slot of the header.
function forCondAlwaysTrue(condSrc) {
  const t = String(condSrc || '').trim();
  if (!t) return true;
  const parts = t.split(';');
  if (parts.length >= 2) {
    const clause = (parts[1] || '').trim();
    return !clause || alwaysTrueCond(clause);
  }
  return alwaysTrueCond(t);
}

function scanLoops(src) {
  const loops = [];
  const n = src.length;
  const isId = (ch) => /[A-Za-z0-9_$]/.test(ch || '');
  const skipWs = (j) => { while (j < n && /\s/.test(src[j])) j++; return j; };
  // match a balanced open/close bracket starting at `j`, skipping strings,
  // comments and template literals. Returns the index of the closer (-1 fail).
  const matchBal = (j, open, close) => {
    if (src[j] !== open) return -1;
    let depth = 0, k = j, q = null, esc = false, lc = false, bc = false, tpl = false;
    for (; k < n; k++) {
      const ch = src[k], nx = src[k + 1];
      if (lc) { if (ch === '\n') lc = false; continue; }
      if (bc) { if (ch === '*' && nx === '/') { bc = false; k++; } continue; }
      if (q) {
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === q) q = null;
        continue;
      }
      if (ch === '/' && nx === '/') { lc = true; k++; continue; }
      if (ch === '/' && nx === '*') { bc = true; k++; continue; }
      if (ch === '"' || ch === "'") { q = ch; continue; }
      if (ch === '`') { tpl = !tpl; continue; }
      if (tpl) continue;
      if (ch === open) depth++;
      else if (ch === close) { depth--; if (depth === 0) return k; }
    }
    return -1;
  };
  const bodyOf = (b) => {
    // returns the loop body source for a block body or a single statement
    if (src[b] === '{') {
      const e = matchBal(b, '{', '}');
      if (e === -1) return '';
      return src.slice(b + 1, e);
    }
    let e = b;
    while (e < n && src[e] !== ';' && src[e] !== '{' && src[e] !== '}') e++;
    if (src[e] === '{') return src.slice(b, e + 1);
    return src.slice(b, Math.min(e + 1, n));
  };

  let i = 0;
  while (i < n) {
    const ch = src[i], nx = src[i + 1];
    if (ch === '/' && nx === '/') { let j = i + 2; while (j < n && src[j] !== '\n') j++; i = j + 1; continue; }
    if (ch === '/' && nx === '*') { let j = i + 2; while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++; i = j + 2; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { let q = ch, j = i + 1, esc = false; while (j < n) { if (esc) { esc = false; j++; continue; } if (src[j] === '\\') { esc = true; j++; continue; } if (src[j] === q) { j++; break; } j++; } i = j; continue; }
    if (!isId(ch)) { i++; continue; }
    let j = i;
    while (j < n && isId(src[j])) j++;
    const word = src.slice(i, j);
    const prev = i > 0 ? src[i - 1] : '';
    let lp = null;
    if (word === 'while' || word === 'for') {
      if (prev !== '.') { // obj.for(1) is invalid JS; never a loop statement
        const k = skipWs(j);
        if (src[k] === '(') {
          const close = matchBal(k, '(', ')');
          if (close !== -1) {
            lp = { kind: word, cond: src.slice(k + 1, close), body: bodyOf(skipWs(close + 1)), at: i };
          }
        }
      }
    } else if (word === 'do') {
      const k = skipWs(j);
      if (src[k] === '{') {
        const close = matchBal(k, '{', '}');
        if (close !== -1) {
          const body = src.slice(k + 1, close);
          let cond = 'true';
          let resume = close + 1;
          const w = skipWs(close + 1);
          if (src.slice(w, w + 5).toLowerCase() === 'while') {
            const p = skipWs(w + 5);
            if (src[p] === '(') {
              const c2 = matchBal(p, '(', ')');
              if (c2 !== -1) { cond = src.slice(p + 1, c2); resume = c2 + 1; }
            }
          }
          lp = { kind: 'do', cond, body, resume, at: i };
        }
      }
    }
    i = (lp && lp.resume != null) ? lp.resume : j;
    if (lp) loops.push(lp);
  }
  return loops;
}

export function scriptFreezeRisks(src) {
  const risks = [];
  for (const lp of scanLoops(src)) {
    const alwaysTrue = lp.kind === 'for'
      ? forCondAlwaysTrue(lp.cond)
      : alwaysTrueCond(lp.cond);
    if (!alwaysTrue) continue;
    if (LOOP_ESCAPE_RE.test(lp.body)) continue;
    risks.push(`non-terminating ${lp.kind} loop at offset ${lp.at} — it runs forever with no break/return/throw and would freeze the page`);
  }
  return risks;
}

function decodeFile(f) {
  if (f.encoding === 'base64' && typeof f.content === 'string') {
    try {
      const bytes = new Uint8Array([...atob(f.content)].map((c) => c.charCodeAt(0)));
      return new TextDecoder().decode(bytes);
    } catch { return ''; }
  }
  return String(f.content ?? '');
}

const CAP = 15;

// files: [{ path, content, encoding }] (listFilesWithContent shape)
export async function pageTest({ files }) {
  const map = new Map();
  for (const f of files || []) map.set(String(f.path || ''), f);

  const htmlPaths = [...map.keys()].filter((p) => /\.html?$/i.test(p));
  let errors = [];
  let pages = 0, scripts = 0, refs = 0;

  for (const hp of htmlPaths) {
    const html = decodeFile(map.get(hp));
    if (!html.trim()) continue;
    pages++;

    // 1. inline + referenced scripts
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const attrs = m[1] || '';
      const isModule = /\btype\s*=\s*["']?module/i.test(attrs);
      const srcAttr = attrs.match(/src\s*=\s*["']([^"']+)["']/i);
      const body = m[2];
      if (srcAttr) {
        const srcRef = srcAttr[1];
        if (HTTP_RE.test(srcRef) || DIRECT_RE.test(srcRef) || /^\/\//.test(srcRef)) continue; // CDN / data: / protocol-relative
        const hit = resolveRef(srcRef, hp, map);
        if (hit === null) {
          errors.push({ file: hp, type: 'missing script', ref: srcRef });
          continue;
        }
        scripts++;
        const e = jsError(decodeFile(map.get(hit)));
        if (e) errors.push({ file: hit, type: 'script syntax error', message: e.message });
        for (const fr of scriptFreezeRisks(decodeFile(map.get(hit))))
          errors.push({ file: hit, type: 'freeze risk', message: fr });
      } else if (body && body.trim()) {
        scripts++;
        const e = jsError(body);
        if (e) errors.push({ file: hp, type: 'inline script syntax error', message: e.message });
        for (const fr of scriptFreezeRisks(body))
          errors.push({ file: hp, type: 'freeze risk (inline)', message: fr });
      }
    }

    // 2. resources referenced by the page (css, images, links, fonts, fetch)
    const refRe = /(?:src|href)\s*=\s*["']([^"']+)["']|url\(\s*["']?([^"')]+)\s*["']?\)/gi;
    for (const m of html.matchAll(refRe)) {
      const ref = (m[1] || m[2] || '').trim();
      if (!ref) continue;
      if (ref === '/' || ref === '.' || ref === './') continue; // site root = index.html, always served
      if (m[1] !== undefined && /^#/.test(ref)) continue;      // #hash handlers / ids
      if (HTTP_RE.test(ref) || DIRECT_RE.test(ref)) continue;
      if (/\.css$/i.test(ref)) {
        const hit = resolveRef(ref, hp, map);
        if (hit === null) errors.push({ file: hp, type: 'missing stylesheet', ref });
        continue;
      }
      const hit = resolveRef(ref, hp, map);
      if (hit === null) {
        const isJs = /\.js(\?|$)/i.test(ref);
        errors.push({ file: hp, type: isJs ? 'missing script' : 'missing resource', ref });
      } else {
        refs++;
      }
    }
  }

  // dedupe (a `<script src>` and the generic ref scan may both list the same missing file)
  const seen = new Set();
  let unique = [];
  for (const e of errors) {
    const k = [e.file, e.type, e.ref || '', e.message || ''].join('\u0000');
    if (!seen.has(k)) { seen.add(k); unique.push(e); }
  }
  errors = unique;

  const more = errors.length > CAP;
  if (more) errors.length = CAP;
  return {
    ok: errors.length === 0 && pages > 0,
    pages,
    scripts,
    refs,
    errors,
    more,
    freezeRisk: errors.some((e) => e.type === 'freeze risk' || e.type === 'freeze risk (inline)'),
  };
}

// Compact block appended to the model's history so the next turn can fix bugs.
export function reportToText(r, label) {
  const head = r.ok
    ? `${label}: PASS — ${r.pages} page${r.pages === 1 ? '' : 's'}, ${r.scripts} script${r.scripts === 1 ? '' : 's'} checked, no broken references.`
    : `${label}: FAIL — ${r.pages} page${r.pages === 1 ? '' : 's'}, ${r.scripts} script${r.scripts === 1 ? '' : 's'}, ${r.errors.length} issue${r.errors.length === 1 ? '' : 's'} found:`;
  const lines = r.errors.map((e) =>
    ` - [${e.type}] ${e.file}${e.ref ? ' → "' + e.ref + '"' : ''}${e.message ? ': ' + e.message : ''}`
  );
  return lines.length ? head + '\n' + lines.join('\n') + (r.more ? `\n - … +${r.more} more` : '') : head;
}