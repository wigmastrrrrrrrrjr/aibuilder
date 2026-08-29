/* aibuilder developer tools
   Double-tap (or double-click) the screen to open.
   Captures every console message, browser error, rejection and fetch request,
   so anyone can see exactly what the app is doing — including on the login screen. */
(() => {
  'use strict';
  if (window.__aibDev) return;
  window.__aibDev = true;

  const MAX = 500;
  const rows = [];
  let errorCount = 0;
  let mode = 'all';
  let isOpen = false;

  const time = () => new Date().toLocaleTimeString('en-GB');

  function fmt(v) {
    if (typeof v === 'string') return v;
    if (v instanceof Error) return v.stack || v.message || String(v);
    try { return JSON.stringify(v); } catch { return String(v); }
  }

  function push(sev, text) {
    rows.push({ sev, text: String(text), at: time() });
    if (rows.length > MAX) rows.shift();
    if (sev === 'error' || sev === 'netfail') { errorCount++; refreshBadge(); }
    if (isOpen) render();
  }

  /* ---- capture console ---- */
  const C = {};
  ['log', 'info', 'debug', 'warn', 'error'].forEach((m) => {
    C[m] = console[m].bind(console);
    console[m] = (...a) => { C[m](...a); push(m === 'error' ? 'error' : m === 'warn' ? 'warn' : 'info', a.map(fmt).join(' ')); };
  });

  window.addEventListener('error', (e) => {
    push('error', `${e.message} at ${e.filename || ''}:${e.lineno || '?'}:${e.colno || '?'}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    push('error', `unhandled rejection: ${fmt(r && (r.message || r.stack) ? (r.message || r.stack) : r)}`);
  });

  /* ---- capture fetch ---- */
  const ofetch = window.fetch;
  window.fetch = function (input, init) {
    const req = {};
    if (typeof input === 'string') req.url = input;
    else if (input && typeof input === 'object') { req.url = input.url; req.method = input.method; }
    const method = (init && init.method) || req.method || 'GET';
    const url = req.url || String(input);
    const start = performance.now();
    const done = (r) => {
      const ms = Math.round(performance.now() - start);
      if (r && typeof r.status === 'number') {
        push('net', `${method} ${url} -> ${r.status} ${r.statusText || ''} (${ms}ms)`);
        if (r.status >= 400) {
          try {
            r.clone().text().then((t) => { if (t) push('netfail', `${method} ${url} body: ${t.slice(0, 300)}`); }).catch(() => {});
          } catch {}
        }
      } else {
        push('net', `${method} ${url} (${ms}ms)`);
      }
      return r;
    };
    return ofetch.apply(this, arguments).then(done, (err) => {
      push('error', `${method} ${url} FAILED: ${err && err.message}`);
      throw err;
    });
  };

  /* ---- build the overlay ---- */
  const ov = document.createElement('div');
  ov.id = 'devToolsOv';
  ov.setAttribute('role', 'dialog');
  ov.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:2147483000', 'display:none',
    'flex-direction:column', 'background:rgba(7,11,17,.97)', 'color:#d7e2ee',
    'font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,Menlo,monospace',
  ].join(';');

  const hdr = document.createElement('div');
  hdr.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #223040;flex-wrap:wrap;flex:none;';
  const title = document.createElement('strong');
  title.textContent = 'aibuilder · developer tools';
  title.style.fontSize = '13px';
  title.style.marginRight = 'auto';
  hdr.append(title);

  function btn(label, active) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText = [
      'background:' + (active ? '#2b6cb0' : '#16202c'), 'color:' + (active ? '#fff' : '#9fb3c8'),
      'border:1px solid #2c3e52', 'border-radius:4px', 'padding:3px 10px',
      'font:11px/1.4 ui-monospace,Consolas,monospace', 'cursor:pointer',
    ].join(';');
    return b;
  }

  function paintBtns() {
    btnAll.style.background = mode === 'all' ? '#2b6cb0' : '#16202c';
    btnAll.style.color = mode === 'all' ? '#fff' : '#9fb3c8';
    btnErr.style.background = mode === 'error' ? '#2b6cb0' : '#16202c';
    btnErr.style.color = mode === 'error' ? '#fff' : '#9fb3c8';
    btnNet.style.background = mode === 'net' ? '#2b6cb0' : '#16202c';
    btnNet.style.color = mode === 'net' ? '#fff' : '#9fb3c8';
  }
  function setMode(m) { mode = m; paintBtns(); render(); }

  const btnAll = btn('All', true);
  const btnErr = btn('Errors', false);
  const btnNet = btn('Network', false);
  btnAll.onclick = () => setMode('all');
  btnErr.onclick = () => setMode('error');
  btnNet.onclick = () => setMode('net');

  const btnClear = btn('Clear', false);
  btnClear.onclick = () => { rows.length = 0; errorCount = 0; refreshBadge(); render(); };

  const btnCopy = btn('Copy', false);
  btnCopy.onclick = async () => {
    const text = rows.map((r) => `${r.at}  ${r.sev.toUpperCase().padEnd(7)} ${r.text}`).join('\n');
    try { await navigator.clipboard.writeText(text); btnCopy.textContent = 'Copied'; }
    catch { prompt('Copy the log:', text); }
    setTimeout(() => { btnCopy.textContent = 'Copy'; }, 1500);
  };

  const btnClose = btn('Close', false);
  btnClose.style.fontWeight = '700';
  btnClose.onclick = close;

  hdr.append(btnAll, btnErr, btnNet, btnClear, btnCopy, btnClose);

  const list = document.createElement('div');
  list.style.cssText = 'flex:1;overflow:auto;padding:8px 12px;';
  list.setAttribute('aria-live', 'polite');

  ov.append(hdr, list);
  document.documentElement.append(ov);

  function render() {
    list.innerHTML = '';
    const frag = document.createDocumentFragment();
    let shown = 0;
    for (const r of rows) {
      const ok = mode === 'all' ? true : mode === 'error' ? (r.sev === 'error' || r.sev === 'netfail') : (r.sev === 'net' || r.sev === 'netfail');
      if (!ok) continue;
      const row = document.createElement('div');
      row.style.cssText = 'white-space:pre-wrap;word-break:break-word;padding:2px 0;';
      row.style.color = (r.sev === 'error' || r.sev === 'netfail') ? '#ff6b6b' : r.sev === 'warn' ? '#ffd166' : r.sev === 'net' ? '#5aa7ff' : '#9fb3c8';
      const t = document.createElement('span');
      t.textContent = r.text;
      row.append(`${r.at}  `, t);
      frag.append(row);
      shown++;
    }
    if (!shown) {
      const e = document.createElement('div');
      e.style.cssText = 'color:#5b6b7c;padding:6px;';
      e.textContent = 'No matching entries yet — logs appear as the app runs.';
      frag.append(e);
    }
    list.append(frag);
    list.scrollTop = list.scrollHeight;
  }

  /* ---- error badge ---- */
  const badge = document.createElement('div');
  badge.id = 'devBadge';
  badge.hidden = true;
  Object.assign(badge.style, {
    position: 'fixed', right: '10px', bottom: '10px', zIndex: '2147482999',
    background: '#e5484d', color: '#fff', borderRadius: '999px', minWidth: '22px',
    height: '22px', font: 'bold 12px/22px ui-monospace,Consolas,monospace',
    textAlign: 'center', padding: '0 6px', boxShadow: '0 2px 8px rgba(0,0,0,.4)', cursor: 'pointer',
  });
  badge.title = 'aibuilder reports errors — tap to open developer tools';
  badge.onclick = (e) => { e.stopPropagation(); open(); };
  document.documentElement.append(badge);

  function refreshBadge() {
    badge.hidden = !(errorCount > 0);
    badge.textContent = errorCount > 99 ? '99+' : String(errorCount);
  }

  function open() {
    isOpen = true;
    ov.style.display = 'flex';
    badge.hidden = true;
    C.info('[devtools] panel opened');
    render();
  }
  function close() {
    isOpen = false;
    ov.style.display = 'none';
    refreshBadge();
  }
  function toggle() { isOpen ? close() : open(); }

  /* ---- double-tap / double-click triggers ---- */
  const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  if (coarse) {
    let lastTap = 0, lastX = 0, lastY = 0;
    document.addEventListener('touchend', (e) => {
      const t = e.changedTouches && e.changedTouches[0];
      if (!t) return;
      const inside = e.target && e.target.closest && e.target.closest('#devToolsOv, #devBadge');
      if (inside) { lastTap = 0; return; }
      const nowT = performance.now();
      const dx = t.clientX - lastX, dy = t.clientY - lastY;
      if (nowT - lastTap < 280 && dx * dx + dy * dy < 900) toggle();
      lastTap = nowT; lastX = t.clientX; lastY = t.clientY;
    }, { passive: true });
  } else {
    document.addEventListener('dblclick', (e) => {
      if (e.target && e.target.closest && e.target.closest('#devToolsOv, #devBadge, button, a, input, select, textarea')) return;
      toggle();
    });
  }

  push('info', 'developer tools loaded — double-tap the screen to open');
})();