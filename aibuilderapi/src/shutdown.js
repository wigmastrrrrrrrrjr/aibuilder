// Permanent shutdown lock.
//
// This is not maintenance. The site is off: every public entrypoint — the
// Workers router, the dedicated chat and preview workers, the local dev server,
// and the GitHub Pages artifact — answers with the same page and 410 Gone, so
// nothing that used to be reachable is reachable any more.
//
// The source stays in git. To bring the site back:
//   • set SHUTDOWN to false here,
//   • remove `run_worker_first` from [assets] in wrangler.toml (only needed
//     while the worker is answering for HTML too),
//   • drop the "Stage the shutdown page" step from .github/workflows/pages.yml.
// Then push to main; both deploy targets rebuild from the untouched sources.
//
// HTTP 410 rather than 503 on purpose: 503 means "temporarily unavailable, come
// back later", and this is not that.

export const SHUTDOWN = true;

export const SHUTDOWN_MESSAGE = 'sorry this website is unavailable. Shut down.';

// One card, one sentence, no links. Anything else would be an invitation.
export const SHUTDOWN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>sorry this website is unavailable</title>
<style>
  :root{color-scheme:light dark;--bg:#f3f5f9;--surface:#fff;--line:#e4e8f1;--text:#0f172a;--muted:#64748b}
  @media (prefers-color-scheme:dark){:root{--bg:#0b1020;--surface:#121a2e;--line:#25314e;--text:#e8edf7;--muted:#8f9bb3}}
  *{box-sizing:border-box;margin:0;padding:0}
  body{min-height:100vh;display:grid;place-items:center;padding:32px;background:var(--bg);color:var(--text);
    font:400 16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Inter,system-ui,sans-serif}
  .card{width:100%;max-width:460px;background:var(--surface);border:1px solid var(--line);border-radius:18px;
    padding:40px 32px;text-align:center;box-shadow:0 12px 32px rgba(15,23,42,.06)}
  .mark{width:34px;height:34px;margin:0 auto 22px;border-radius:10px;display:grid;place-items:center;
    background:var(--text);color:var(--surface);font-size:17px;font-weight:800}
  p{font-size:17px;font-weight:600;letter-spacing:-.01em}
  small{display:block;margin-top:16px;font-size:12px;font-weight:500;color:var(--muted);
    letter-spacing:.04em;text-transform:uppercase}
</style>
</head>
<body>
  <main class="card">
    <div class="mark" aria-hidden="true">a</div>
    <p>${SHUTDOWN_MESSAGE}</p>
    <small>410 · gone</small>
  </main>
</body>
</html>`;

const JSON_PATHS = (pathname) => pathname.startsWith('/api/') || pathname === '/__baas.js';

/**
 * The only response the platform produces while SHUTDOWN is on.
 * API callers and anything asking for JSON get a JSON error; people get the page.
 */
export function shutdownResponse(pathname, accept = '') {
  const wantsJson = JSON_PATHS(pathname)
    || String(accept || '').includes('application/json')
    || String(accept || '').includes('text/event-stream');
  const headers = {
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, x-ab-sess, x-api-key, authorization',
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'x-robots-tag': 'noindex, nofollow',
  };
  if (wantsJson) {
    return new Response(JSON.stringify({ error: 'shutdown', message: SHUTDOWN_MESSAGE }), {
      status: 410,
      headers: { ...headers, 'content-type': 'application/json; charset=utf-8' },
    });
  }
  return new Response(SHUTDOWN_HTML, {
    status: 410,
    headers: { ...headers, 'content-type': 'text/html; charset=utf-8' },
  });
}
