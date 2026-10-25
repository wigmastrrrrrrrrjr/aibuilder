// Post-build verification.
//
// A build round ends with code that nobody has executed. The page test in
// `smoketest.js` walks the project the way the preview server would — every
// `href`/`src`/`url()` resolved with the same lookup rules, every script
// syntax-checked — so a missing `styles.css` or a truncated `app.js` is caught
// and repaired inside the SAME request instead of surfacing to the user in the
// preview.
//
// This module is the thin layer between the store and that test: it decides
// whether verification is on, loads the files, and turns a failing report into
// one diagnostics entry the repair round understands. Both the Worker route and
// the terminal daemon come through `runChat`, so both get it.

import { getVar } from './env.js';
import { pageTest, reportToText } from './smoketest.js';

/** Most page tests a single request may run (env-tunable, 0 disables). */
export function maxPageTests() {
  const n = Number(getVar('MAX_PAGE_TESTS'));
  if (Number.isFinite(n)) return Math.max(0, Math.floor(n));
  return 2;
}

/** Is verification enabled at all? PAGE_TEST=off kills it without a deploy. */
export function pageTestEnabled() {
  const v = String(getVar('PAGE_TEST') ?? '').trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false' || v === 'no');
}

/** Run the page test for one project. Returns a report, or null when skipped. */
export async function verifyProject(store, pid) {
  if (!pageTestEnabled()) return null;
  let files = [];
  try {
    files = await store.listFilesWithContent(pid);
  } catch {
    return null; // verification is best-effort — never fail a build over it
  }
  if (!files || !files.length) return null;
  try {
    return await pageTest({ files });
  } catch {
    // A runtime without dynamic codegen, an unexpected file shape, a huge
    // project — none of these should surface as a build error.
    return null;
  }
}

/**
 * The diagnostics entry for a failing report ('' when it passed).
 * Written for the model: what is broken, in which file, and that it must fix
 * every item before finishing.
 */
export function verifyDiag(report) {
  if (!report || report.ok) return '';
  const text = reportToText(report, 'PAGE TEST').trim();
  if (!text) return '';
  return `${text}\nThe preview loads these files exactly as listed — fix every item above in your next step (write the missing file, or correct the reference/script).`;
}

/** A stable signature for a report, so an identical failure is not re-fed. */
export function verifySignature(report) {
  if (!report) return '';
  return JSON.stringify((report.errors || []).map((e) => [e.file, e.type, e.ref || '', e.message || '']));
}

/** The SSE event the SPA already knows how to render as a card. */
export function verifyEvent(report) {
  return {
    type: 'test',
    auto: true,
    ok: Boolean(report.ok),
    pages: report.pages || 0,
    scripts: report.scripts || 0,
    refs: report.refs || 0,
    errors: report.errors || [],
    more: Boolean(report.more),
  };
}
