import { Hono } from 'hono';
import { store } from './store.js';
import { fromBase64 } from './base64.js';

export const preview = new Hono();

export const BAAS_SDK_JS = `(function () {
  var base = '/api/baas/' + window.__CREAT_PROJECT__;
  var pid = window.__CREAT_PROJECT__;
  var TOK_KEY = 'ab_app_tok';
  function tok() {
    try { return localStorage.getItem(TOK_KEY) || ''; } catch (e) { return ''; }
  }
  function authHeaders(extra) {
    var h = extra || {};
    if (tok()) h['x-ab-sess'] = tok();
    return h;
  }

  /* ---- sign-up popup (shown when live features need an account) ---- */
  function showSignup(onDone) {
    if (document.getElementById('__ab_auth')) return;
    var d = document.createElement('div');
    d.id = '__ab_auth';
    d.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(8,10,18,.72);' +
      'backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;' +
      'font-family:system-ui,-apple-system,sans-serif';
    d.innerHTML =
      '<div style="width:min(92vw,360px);background:#12141f;color:#e8eaf6;border:1px solid #2a2d44;' +
      'border-radius:16px;padding:26px;box-shadow:0 24px 80px rgba(0,0,0,.55);box-sizing:border-box">' +
      '<h2 style="margin:0 0 6px;font-size:20px">Sign up to go live</h2>' +
      '<p style="margin:0 0 18px;font-size:13px;color:#9aa0c3;line-height:1.45">' +
      'This app uses realtime multiplayer. Create a free account to join in.</p>' +
      '<input id="__ab_u" placeholder="username" autocomplete="username" style="width:100%;box-sizing:border-box;' +
      'margin-bottom:10px;padding:11px 12px;border-radius:10px;border:1px solid #2a2d44;' +
      'background:#0c0e18;color:#fff;font-size:14px">' +
      '<input id="__ab_p" type="password" placeholder="password (min 6 chars)" autocomplete="current-password" ' +
      'style="width:100%;box-sizing:border-box;margin-bottom:12px;padding:11px 12px;border-radius:10px;' +
      'border:1px solid #2a2d44;background:#0c0e18;color:#fff;font-size:14px">' +
      '<div id="__ab_e" style="color:#ff7b9c;font-size:12px;margin:0 0 10px;min-height:15px"></div>' +
      '<button id="__ab_go" style="width:100%;padding:12px;border:0;border-radius:10px;' +
      'background:linear-gradient(135deg,#7c5cff,#5ca9ff);color:#fff;font-weight:600;font-size:14px;cursor:pointer">' +
      'Create account</button>' +
      '<button id="__ab_sw" style="width:100%;margin-top:8px;padding:8px;border:0;background:none;' +
      'color:#9aa0c3;font-size:12px;cursor:pointer">I already have an account — log in</button></div>';
    document.body.appendChild(d);
    var mode = 'signup';
    var u = document.getElementById('__ab_u'), p = document.getElementById('__ab_p');
    var e = document.getElementById('__ab_e'), go = document.getElementById('__ab_go');
    var sw = document.getElementById('__ab_sw');
    sw.onclick = function () {
      mode = mode === 'signup' ? 'login' : 'signup';
      go.textContent = mode === 'signup' ? 'Create account' : 'Log in';
      sw.textContent = mode === 'signup'
        ? 'I already have an account — log in'
        : 'New here? Create an account';
      e.textContent = '';
    };
    function submit() {
      go.disabled = true;
      fetch('/api/auth/' + mode, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: u.value.trim(), password: p.value })
      }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (!res.ok) throw new Error(res.j.error || ('HTTP error'));
          try { localStorage.setItem(TOK_KEY, res.j.token); } catch (err) {}
          d.remove();
          (onDone || function () { location.reload(); })();
        })
        .catch(function (err) { e.textContent = err.message; go.disabled = false; });
    }
    go.onclick = submit;
    p.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') submit(); });
    setTimeout(function () { u.focus(); }, 50);
  }

  function req(method, parts, body) {
    return fetch([base].concat(parts.filter(Boolean)).join('/'), {
      method: method,
      headers: body ? authHeaders({ 'content-type': 'application/json' }) : undefined,
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.text().then(function (t) {
        var data = t ? JSON.parse(t) : null;
        if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
        return data;
      });
    });
  }
  window.creat = {
    db: {
      list:    function (c)        { return req('GET', [c]); },
      insert:  function (c, o)     { return req('POST', [c], o); },
      get:     function (c, id)    { return req('GET', [c, id]); },
      update:  function (c, id, p) { return req('PUT', [c, id], p); },
      remove:  function (c, id)    { return req('DELETE', [c, id]); }
    },
    live: function (coll, cb) {
      var url = '/api/projects/' + pid + '/live/baas-' + coll + '/stream';
      if (tok()) url += '?tok=' + encodeURIComponent(tok());
      var es = new EventSource(url);
      es.onmessage = function (ev) {
        try { cb(JSON.parse(ev.data)); } catch (e) {}
      };
      es.onerror = function () {
        // 401 means "needs an account" — anything else is just a flaky connection
        fetch('/api/auth/me', authHeaders())
          .then(function (r) { if (r.status === 401) showSignup(); })
          .catch(function () {});
      };
      return { close: function () { es.close(); } };
    },
    push: function (coll, evt) {
      fetch('/api/projects/' + pid + '/live/baas-' + coll + '/push', {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(evt || {})
      }).then(function (r) {
        if (r.status === 401) showSignup();
      }).catch(function () {});
    }
  };
})();`;

const MIME = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

function safePath(raw) {
  let p;
  try { p = decodeURIComponent(raw); } catch { return null; }
  if (p.includes('\0')) return null;
  const segs = p.split('/').filter(s => s !== '');
  if (segs.some(seg => seg === '..')) return null;
  return segs.join('/');
}

function inject(html, pid) {
  const tag = `<script>window.__CREAT_PROJECT__='${pid}';</script><script src='/__baas.js'></script>`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${tag}</head>`);
  return tag + html;
}

function notYet(c, pid) {
  return c.html(
    `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#0f1115;color:#9aa4b2;display:grid;place-items:center;height:100vh;margin:0">
     <div style="text-align:center"><h2 style="color:#e6edf3">Nothing generated yet</h2>
     <p>Project <code>${pid}</code> has no <code>index.html</code>.<br>Send a prompt in the chat to build the app.</p></div>`
  );
}

async function serveFile(c, pid, rawPath) {
  const p = safePath(rawPath);
  if (p === null) return c.text('bad path', 400);
  const target = p === '' ? 'index.html' : p;

  let row = await store.getFile(pid, target);
  if (!row && target !== 'index.html') {
    row = await store.getFile(pid, target + '/index.html');
  }
  if (!row) {
    if (!(await store.getProject(pid))) return c.text('unknown project', 404);
    if (target === 'index.html') return notYet(c, pid);
    return c.text('not found', 404);
  }

  const ext = (target.split('.').pop() || '').toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const content = row.encoding === 'base64' ? fromBase64(row.content) : row.content;
  const body = type.startsWith('text/html') && row.encoding !== 'base64'
    ? inject(row.content, pid)
    : content;
  return c.body(body, 200, { 'content-type': type, 'cache-control': 'no-store' });
}

preview.get('/:pid', (c) => serveFile(c, c.req.param('pid'), ''));
preview.get('/:pid/*', (c) => serveFile(c, c.req.param('pid'), c.req.path.replace(/^\/preview\/[^/]+\/?/, '')));
