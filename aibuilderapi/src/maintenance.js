// Maintenance lock for the whole platform. Flip MAINTENANCE_MODE to true to
// temporarily take down every API and page; flip back to false to restore.

export const MAINTENANCE_MODE = false;

export const MAINTENANCE_MESSAGE =
  'whoops looks like we are doing a maintenance - revamping basically the entire AI and fixing a couple of vulnerabilities, emails are now stored as hashes not plain text';

const MAINTENANCE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>aibuilder — maintenance</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root{--bg:#f3f5f9;--surface:#fff;--border:#e4e8f1;--text:#0f172a;--muted:#64748b;--primary:#4f46e5;--primary-soft:#eef2ff}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
  .topbar{display:flex;align-items:center;gap:10px;padding:16px 28px;background:var(--surface);border-bottom:1px solid var(--border)}
  .brand{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--text)}
  .brandMark{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;background:linear-gradient(135deg,#6366f1,#4f46e5 55%,#4338ca);color:#fff;font-size:16px;font-weight:800}
  .brandName{font-size:16px;font-weight:700;letter-spacing:-.01em}
  .brandName b{color:var(--primary);font-weight:800}
  main{display:grid;place-items:center;min-height:calc(100vh - 63px);padding:40px 20px}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:48px 40px;max-width:520px;text-align:center;box-shadow:0 12px 32px rgba(15,23,42,.06)}
  .icon{width:56px;height:56px;margin:0 auto 20px;border-radius:16px;display:grid;place-items:center;background:var(--primary-soft);color:var(--primary)}
  h1{font-size:20px;font-weight:800;margin-bottom:10px}
  p{color:var(--muted);font-size:15px;line-height:1.6}
  .lead{color:var(--text);font-weight:600;font-size:16px}
  .eta{display:block;margin-top:8px;font-size:13px;font-weight:600;color:var(--primary);font-variant-numeric:tabular-nums}
  .pill{display:inline-block;margin-top:22px;font-size:11px;font-weight:600;color:var(--primary);background:var(--primary-soft);border:1px solid #e3e2fb;padding:4px 12px;border-radius:999px;letter-spacing:.02em}
</style>
</head>
<body>
<header class="topbar">
  <a class="brand" href="/">
    <span class="brandMark">a</span>
    <span class="brandName">a<b>ibuilder</b></span>
  </a>
</header>
<main>
  <div class="card">
    <div class="icon">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
    </div>
    <h1>whoops looks like we are doing a maintenance</h1>
    <p class="lead">we are revamping basically the entire AI and fixing a couple of vulnerabilities</p>
    <p>emails are now stored as hashes, not plain text - your data is protected</p>
    <span class="eta" id="eta"></span>
    <span class="pill">Scheduled maintenance</span>
  </div>
</main>
<script>
(function () {
  var back = new Date('2026-08-28T18:30:00Z').getTime();
  function pad(n) { return String(n).padStart(2, '0'); }
  function tick() {
    var el = document.getElementById('eta');
    if (!el) return;
    var d = back - Date.now();
    if (d <= 0) { el.textContent = 'Back very shortly \u2014 flipping the switch.'; return; }
    var s = Math.floor(d / 1000);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    el.textContent = 'Back in ' + h + 'h ' + pad(m) + 'm ' + pad(sec) + 's' +
      ' \u00b7 around ' + new Date(back).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  tick(); setInterval(tick, 1000);
})();
</script>
</body>
</html>`;

export function maintenanceResponse(pathname) {
  if (pathname.startsWith('/api/') || pathname === '/__baas.js') {
    return new Response(
      JSON.stringify({ error: 'maintenance', message: MAINTENANCE_MESSAGE }),
      {
        status: 503,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'cache-control': 'no-store',
        },
      },
    );
  }
  return new Response(MAINTENANCE_HTML, {
    status: 503,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });
}

export const maintenancePage = MAINTENANCE_HTML;