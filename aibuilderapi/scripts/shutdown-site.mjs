// Turns a built copy of web/ into the shutdown site.
//
// GitHub Pages has no server to run, so the only way to take the mirror down is
// to stop publishing the app. This script rewrites every page in the artifact
// with the shutdown page (deep links and 404 included) and drops the SPA
// bundles, leaving nothing to load but the message. The sources under web/ are
// untouched — the artifact is a throwaway directory that only CI builds.
//
//   node aibuilderapi/scripts/shutdown-site.mjs .pages-site
//
// Run: node --test aibuilderapi/test/shutdown.test.mjs also exercises it.

import fs from 'node:fs';
import path from 'node:path';
import { SHUTDOWN_HTML } from '../src/shutdown.js';

const dir = path.resolve(process.argv[2] || '.pages-site');
if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
  console.error(`shutdown-site: no such directory: ${dir}`);
  process.exit(1);
}

function walk(d) {
  const out = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const files = walk(dir);
let pages = 0, dropped = 0;

for (const f of files) {
  const ext = path.extname(f).toLowerCase();
  if (ext === '.html' || ext === '.htm') {
    fs.writeFileSync(f, SHUTDOWN_HTML);
    pages++;
  } else if (ext === '.js' || ext === '.css' || ext === '.map') {
    // No script ships. The install helpers (.sh/.ps1) stay: they fetch release
    // binaries from GitHub and never served the site itself.
    fs.unlinkSync(f);
    dropped++;
  }
}

// A site with no entry point would 404 — which Pages answers with whatever
// 404.html says, if one exists. Make both, so every route ends on the message.
for (const name of ['index.html', '404.html']) {
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) { fs.writeFileSync(p, SHUTDOWN_HTML); pages++; }
}

console.log(`shutdown-site: ${pages} page(s) replaced, ${dropped} bundle(s) removed in ${dir}`);
