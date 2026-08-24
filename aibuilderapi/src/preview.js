import { Hono } from 'hono';
import { store } from './store.js';
import { fromBase64 } from './base64.js';

export const preview = new Hono();

export const BAAS_SDK_JS = `(function () {
  var base = '/api/baas/' + window.__CREAT_PROJECT__;
  var pid = window.__CREAT_PROJECT__;
  function req(method, parts, body) {
    return fetch([base].concat(parts.filter(Boolean)).join('/'), {
      method: method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
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
      var es = new EventSource('/api/projects/' + pid + '/live/baas-' + coll + '/stream');
      es.onmessage = function (ev) {
        try { cb(JSON.parse(ev.data)); } catch (e) {}
      };
      return { close: function () { es.close(); } };
    },
    push: function (coll, evt) {
      fetch('/api/projects/' + pid + '/live/baas-' + coll + '/push', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(evt || {})
      });
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
