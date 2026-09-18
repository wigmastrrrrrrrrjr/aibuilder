/* aibuilder SPA — no build step, vanilla JS */
'use strict';

const $ = (id) => document.getElementById(id);
// When hosted on GitHub Pages the backend lives on Cloudflare Workers;
// same-origin (local Node or Workers assets hosting) needs no prefix.
const WORKER_ORIGIN = 'https://aibuilderapi.csomeone301.workers.dev';
const API = location.hostname.endsWith('github.io') ? WORKER_ORIGIN : '';

/* ---- icons: a hand-built inline SVG sprite (see index.html <symbol id="i-*">) ---- */
const SVG_NS = 'http://www.w3.org/2000/svg';
function mountIcon(el) {
  const name = el && el.dataset && el.dataset.ic;
  if (!name || el._icName === name) return el;
  el._icName = name;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.appendChild(use);
  el.textContent = '';
  el.appendChild(svg);
  return el;
}
function mountIcons(root) {
  const scope = root && root.querySelectorAll ? root : document;
  scope.querySelectorAll('.ms[data-ic]').forEach(mountIcon);
  if (scope.classList && scope.classList.contains('ms')) mountIcon(scope);
}
function ic(name, cls) {
  const el = document.createElement('span');
  el.className = 'ms' + (cls ? ' ' + cls : '');
  el.dataset.ic = name;
  return mountIcon(el);
}
const icSvg = (name) =>
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
function setIcon(el, name) { if (el) { el.dataset.ic = name; mountIcon(el); } }

/* ---- theme (dark / light) ---- */
const THEME_KEY = 'ab.theme';
function applyTheme(theme) {
  if (!theme) theme = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* ignore */ }
  const tic = $('themeBtn') && $('themeBtn').querySelector('.ms');
  if (tic) setIcon(tic, theme === 'dark' ? 'sun' : 'moon');
  const ts = $('themeState');
  if (ts) ts.textContent = theme === 'dark' ? 'Dark' : 'Light';
}
applyTheme(localStorage.getItem(THEME_KEY) || '');
const messagesEl = $('messages'), promptBox = $('promptBox'), sendBtn = $('sendBtn');
const activityEl = $('activity'), activityText = $('activityText'), rawStream = $('rawStream');
const fileChips = $('fileChips'), frame = $('previewFrame'), projName = $('projName');
const modelSel = $('modelSel'), publishBtn = $('publishBtn');
const effortSel = $('effortSel');

/* freeze quarantine: when a build has a non-terminating loop we hide the
   preview, stop it from loading, and keep it disabled until a clean build. */
const previewStage = $('previewStage'), freezeOverlay = $('freezeOverlay'), freezeFilesEl = $('freezeFiles');
let previewQuarantined = false;
function setPreviewQuarantine(files) {
  previewQuarantined = true;
  frame.src = 'about:blank'; // kill whatever was loading before it can peg the tab
  previewStage.classList.add('quarantined');
  freezeFilesEl.textContent = '';
  for (const f of files || []) {
    const c = document.createElement('code');
    c.textContent = f;
    freezeFilesEl.appendChild(c);
  }
  freezeOverlay.hidden = false;
}
function clearPreviewQuarantine() {
  previewQuarantined = false;
  previewStage.classList.remove('quarantined');
  freezeOverlay.hidden = true;
}

/* chat header status dot (mockup: ● Ready / Building / Saved) */
function setStatus(text) {
  const em = $('statusTxt');
  if (!em) return;
  em.textContent = text;
  const dot = $('statusDot');
  if (dot) dot.dataset.state = text;
}
const saveBtn = $('saveBtn'), saveLbl = $('saveLbl');
let effort = Math.min(4, Math.max(1, Number(localStorage.getItem('ab.effort')) || 2));
const EFFORT_HINT = {
  1: 'Fast — free',
  2: 'Standard — free',
  3: 'Deep — 2× credits, works longer',
  4: 'Deepest — 4× credits, works hardest',
};
effortSel.querySelectorAll('button[data-effort]').forEach((b) => b.classList.toggle('on', Number(b.dataset.effort) === effort));
effortSel.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-effort]');
  if (!b) return;
  effort = Number(b.dataset.effort);
  try { localStorage.setItem('ab.effort', String(effort)); } catch { /* ignore */ }
  effortSel.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  const cur = currentModel();
  const label = EFFORT_HINT[effort] || '';
  if (label) notify('Effort', label + (effort >= 3 ? ` · model "${cur}"` : ''));
});

let projectId = null;
let busy = false;
let dots = 0;
const SID = (() => {
  let s = localStorage.getItem('ab.sid');
  if (!s) { s = Math.random().toString(36).slice(2, 10); localStorage.setItem('ab.sid', s); }
  return s;
})();
let displayText = '';
let canEdit = false; // may the signed-in user modify the open project?
let defaultModel = 'gpt-oss:120b';

/* ---------- strip generator blocks (FILE/EDIT/DELETE/PLAN) from output ---------- */
function BlockFilter() {
  let buf = '';
  let depth = 0;      // nesting of legacy <<<…>>> blocks
  let tool = null;    // {started, depth, inStr, esc, jsonDone} inside a >>>tool call
  this.push = function (chunk) {
    buf += chunk;
    let out = '';
    for (;;) {
      if (tool) {
        // Skip the JSON value with brace/string tracking, then its `<<<`.
        let i = 0;
        for (; i < buf.length && !tool.jsonDone; i++) {
          const ch = buf[i];
          if (tool.inStr) {
            if (tool.esc) tool.esc = false;
            else if (ch === '\\') tool.esc = true;
            else if (ch === '"') tool.inStr = false;
            continue;
          }
          if (ch === '"') { tool.inStr = true; tool.started = true; continue; }
          if (ch === '{' || ch === '[') { tool.depth++; tool.started = true; continue; }
          if (ch === '}' || ch === ']') {
            tool.depth--;
            if (tool.depth <= 0 && tool.started) { tool.jsonDone = true; i++; break; }
          }
        }
        buf = buf.slice(i);
        if (!tool.jsonDone) { buf = buf.slice(Math.max(0, buf.length - 2)); break; }
        const c = buf.indexOf('<<<');
        if (c === -1) { buf = buf.slice(Math.max(0, buf.length - 2)); break; }
        buf = buf.slice(c + 3);
        tool = null;
        continue;
      }
      const ti = buf.indexOf('>>>tool');
      const li = buf.indexOf('<<<');
      if (ti !== -1 && (li === -1 || ti < li)) {
        if (ti > 0) out += buf.slice(0, ti);
        buf = buf.slice(ti + 7);
        tool = { started: false, depth: 0, inStr: false, esc: false, jsonDone: false };
        continue;
      }
      if (li === -1) {
        const keep = Math.min(6, buf.length);
        if (buf.length > keep) { out += buf.slice(0, buf.length - keep); buf = buf.slice(buf.length - keep); }
        break;
      }
      if (li > 0) {
        if (depth === 0) out += buf.slice(0, li); // inside a legacy block: discard payload
        buf = buf.slice(li);
      }
      const e = buf.indexOf('>>>', 3);
      if (e === -1) break; // header not complete yet — keep from `<<<`
      const hdr = buf.slice(3, e).trim().toUpperCase();
      const kind = hdr.split(':')[0];
      buf = buf.slice(e + 3);
      if (kind === 'END' || kind === 'BATCHEND') {
        depth = Math.max(0, depth - 1);
      } else if (['FILE', 'EDIT', 'PLAN', 'DELEGATE', 'ASSET', 'SEED', 'BATCH'].includes(kind)) {
        depth++;
      }
    }
    return out;
  };
  this.drain = function () {
    if (depth > 0 || tool) { buf = ''; return ''; }
    const rest = buf; buf = ''; return rest;
  };
}

function stripBlocks(text) {
  const f = new BlockFilter();
  return (f.push(String(text || '')) + f.drain()).trim();
}

/* ---------- bubbles & UI helpers ---------- */
function addUserBubble(text, who) {
  const d = document.createElement('div');
  d.className = 'msg user';
  if (who) {
    const w = document.createElement('span');
    w.className = 'who';
    w.textContent = who;
    d.appendChild(w);
  }
  d.appendChild(document.createTextNode(text));
  messagesEl.appendChild(d); scrollBottom();
}
function addAiBubble(text) {
  const d = document.createElement('div');
  d.className = 'msg ai'; d.textContent = text || '(no commentary)';
  messagesEl.appendChild(d); scrollBottom();
}
function scrollBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }

function setChips(files, markNew) {
  const fresh = new Set(markNew || []);
  fileChips.innerHTML = '';
  for (const f of files) {
    const s = document.createElement('span');
    const path = typeof f === 'string' ? f : f.path;
    s.className = 'chip' + (fresh.has(path) ? ' new' : '');
    s.textContent = path;
    s.title = `${path} — click to view version history`;
    s.onclick = () => openFilePane(path);
    fileChips.appendChild(s);
  }
}

function flashChip(path) {
  for (const chip of fileChips.querySelectorAll('.chip')) {
    if (chip.textContent === path) {
      chip.classList.remove('flash');
      void chip.offsetWidth;
      chip.classList.add('flash');
    }
  }
}

function refreshPreview(bust) {
  if (!projectId) return;
  if (previewQuarantined) return; // disabled until the freeze is fixed
  frame.src = `${API}/preview/${projectId}/` + (bust ? `?t=${Date.now()}` : '');
}

function currentModel() {
  return modelSel.value || localStorage.getItem('ab.model') || defaultModel;
}

/* ---------- BYOK (bring your own Ollama API key) ---------- */
const ownKey = () => localStorage.getItem('ab.key') || '';

function authHeaders(extra) {
  const h = { ...(extra || {}) };
  if (ownKey()) h['x-api-key'] = ownKey();
  if (sessTok()) h['x-ab-sess'] = sessTok();
  return h;
}

/* ---------- account / sign-up gate ---------- */
const sessTok = () => localStorage.getItem('ab.tok') || '';
const sessName = () => localStorage.getItem('ab.user') || '';

let authMode = 'signup';
let pendingVerifyUser = null;   // username awaiting email verification
let pendingTfaSession = null;   // sessionId awaiting 2FA

// Returns true if dob (YYYY-MM-DD) indicates age >= 13.
function okToSignUp(dob) {
  const birth = new Date(dob);
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age >= 13;
}

function finishAndEnter(d, after) {
  try {
    localStorage.setItem('ab.tok', d.token);
    localStorage.setItem('ab.user', d.username);
  } catch { throw new Error('browser storage is blocked'); }
  $('authErr').textContent = '';
  after();
}

async function doAuth(e) {
  e.preventDefault();
  const username = $('authUser').value.trim();
  const password = $('authPass').value;
  $('authErr').textContent = '';
  $('authGo').disabled = true;
  const finish = () => { $('authGo').disabled = false; };

  try {
    if (!username || !password) throw new Error('enter a username and password');

    if (authMode === 'signup') {
      const agree = $('agreeCheck')?.checked;
      if (!agree) throw new Error('you must accept the Terms of Service and Terms of Use to sign up');
      const dob = $('authDob')?.value || '';
      if (!dob) throw new Error('date of birth required (you must be 13 or older)');
      if (!okToSignUp(dob)) throw new Error('you must be 13 or older to use aibuilder (COPPA)');
      const r = await fetch(`${API}/api/auth/signup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password, dob }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `server error ${r.status}`);
      finishAndEnter(d, () => location.reload());
      return;
    }

    if (authMode === 'reset') {
      if (password.length < 6) throw new Error('password must be at least 6 characters');
      const r = await fetch(`${API}/api/auth/reset`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `server error ${r.status}`);
      finishAndEnter(d, () => location.reload());
      return;
    }

    if (authMode === 'login') {
      const r = await fetch(`${API}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `server error ${r.status}`);

      // 2FA required (ai_dev)
      if (d.tfaRequired) {
        pendingTfaSession = d.sessionId;
        $('authForm').hidden = true;
        $('tfaForm').hidden = false;
        $('tfaSub').textContent = d.message || 'A 6-digit code was sent to your email.';
        $('tfaCode').value = '';
        $('tfaCode').focus();
        finish();
        return;
      }

      finishAndEnter(d, () => location.reload());
    }
  } catch (err) {
    $('authErr').textContent = err.message || String(err);
    console.error('[aibuilder auth]', err);
    finish();
  }
}
$('authForm').addEventListener('submit', doAuth);

/* ---------- 2FA verification (ai_dev) ---------- */
$('tfaForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('tfaCode').value.trim();
  $('tfaErr').textContent = '';
  $('tfaGo').disabled = true;
  try {
    if (!code || code.length !== 6) throw new Error('enter the 6-digit code');
    const r = await fetch(`${API}/api/auth/verify-tfa`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: pendingTfaSession, code }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `server error ${r.status}`);
    try {
      localStorage.setItem('ab.tok', d.token);
      localStorage.setItem('ab.user', d.username);
    } catch {
      throw new Error('browser storage is blocked');
    }
    location.reload();
  } catch (err) {
    $('tfaErr').textContent = err.message || String(err);
  } finally {
    $('tfaGo').disabled = false;
  }
});
$('tfaBack').addEventListener('click', () => {
  $('tfaForm').hidden = true;
  $('authForm').hidden = false;
  pendingTfaSession = null;
});

/* ---------- email verification (signup step 2) ---------- */
$('verifyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('verifyCode').value.trim();
  $('verifyErr').textContent = '';
  $('verifyGo').disabled = true;
  try {
    if (!code || code.length !== 6) throw new Error('enter the 6-digit code');
    const r = await fetch(`${API}/api/auth/verify-email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: pendingVerifyUser, code }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `server error ${r.status}`);
    try {
      localStorage.setItem('ab.tok', d.token);
      localStorage.setItem('ab.user', d.username);
    } catch { throw new Error('browser storage is blocked'); }
    location.reload();
  } catch (err) {
    $('verifyErr').textContent = err.message || String(err);
  } finally {
    $('verifyGo').disabled = false;
  }
});
$('verifyResend').addEventListener('click', async () => {
  $('verifyErr').textContent = '';
  try {
    const r = await fetch(`${API}/api/auth/resend-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: pendingVerifyUser, type: 'signup' }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'failed');
    $('verifyErr').textContent = d.message || 'Code resent!';
    $('verifyErr').style.color = '#3fb950';
    setTimeout(() => { $('verifyErr').style.color = ''; }, 3000);
  } catch (err) {
    $('verifyErr').textContent = err.message;
  }
});
$('verifyBack').addEventListener('click', () => {
  $('verifyForm').hidden = true;
  $('authForm').hidden = false;
  pendingVerifyUser = null;
});

function paintAuth() {
  const t = {
    signup: ['Create your account', 'Sign up free to build apps with AI — it takes 10 seconds.', 'Sign up', 'Already have an account? Log in'],
    login: ['Welcome back', 'Log in to keep building.', 'Log in', 'Forgot password?'],
    reset: ['Reset password', 'Works only from the same network that created the account.', 'Reset & sign in', 'New here? Create an account'],
  }[authMode];
  $('authTitle').textContent = t[0];
  $('authSub').textContent = t[1];
  $('authGo').textContent = t[2];
  $('authSwitch').textContent = t[3];
  $('authPass').placeholder = authMode === 'reset' ? 'new password (min 6 chars)' : 'password (min 6 chars)';
  $('dobRow').hidden = authMode !== 'signup';
  $('agreeRow').hidden = authMode !== 'signup';
  $('agreeCheck').required = authMode === 'signup';
}
$('authSwitch').addEventListener('click', () => {
  authMode = authMode === 'signup' ? 'login' : authMode === 'login' ? 'reset' : 'signup';
  paintAuth();
  $('authErr').textContent = '';
  $('authForm').hidden = false;
  $('verifyForm').hidden = true;
  $('tfaForm').hidden = true;
  pendingVerifyUser = null;
  pendingTfaSession = null;
});
paintAuth();

const whoBtn = $('whoBtn');
function setPub(published) {
  const lbl = $('pubLbl');
  if (lbl) lbl.textContent = published ? 'Unpublish' : 'Publish';
}
if (!sessTok()) {
   // Not signed in – require an account (no guest mode)
   $('authGate').hidden = false;
} else {
    whoBtn.hidden = false;
    whoBtn.append(ic('person'), document.createTextNode(sessName()));
    const af = $('accountFoot');
    if (af) {
      const fn = $('footName');
      if (fn) fn.textContent = sessName();
      af.hidden = false;
    }
    loadCredits();
  }
  // deep-link into a team invite (?join=<tid>&code=<CODE>)
  (() => {
    const q = new URLSearchParams(location.search);
    if (!q.get('join') || !q.get('code') || !sessTok()) return;
    const qs = new URLSearchParams();
    for (const [k, v] of q) { if (k !== 'join' && k !== 'code') qs.set(k, v); }
    const clean = 'index.html' + (qs.toString() ? '?' + qs : '');
    history.replaceState(null, '', clean);
    (async () => {
      try {
        const r = await fetch(`${API}/api/teams/${encodeURIComponent(q.get('join'))}/join`, {
          method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }),
          body: JSON.stringify({ invite_code: q.get('code') }),
        });
        if (r.ok) notify('Teams', 'You joined the team. Shared projects, credits and live presence are now active.');
        else notify('Team invite', (await r.json().catch(() => ({}))).error || 'That invite link is invalid or expired.');
        loadCredits(); loadProjects();
      } catch (e) { notify('Team invite', e.message); }
    })();
  })();
const acctMenu = $('acctMenu');
function toggleAcctMenu(force) {
  if (!acctMenu) return;
  const open = typeof force === 'boolean' ? force : acctMenu.hidden;
  if (open) {
    const nameEl = $('acctName');
    if (nameEl) nameEl.textContent = sessName() || 'Account';
    acctMenu.hidden = false;
  } else {
    acctMenu.hidden = true;
  }
}
whoBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleAcctMenu();
});
document.addEventListener('click', (e) => {
  if (acctMenu && !acctMenu.hidden && !(e.target.closest && e.target.closest('#topbarRightWrap'))) toggleAcctMenu(false);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleAcctMenu(false); });
const themeBtn = $('themeBtn');
if (themeBtn) themeBtn.addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
const menuTheme = $('menuTheme');
if (menuTheme) menuTheme.addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
const footWho = $('footWho');
if (footWho) footWho.addEventListener('click', () => { const sm = $('settingsModal'); if (sm) sm.hidden = false; });

/* ---------- settings modal (mockup "⚙ Settings") ---------- */
const settingsModal = $('settingsModal');
if (settingsModal) {
  const settingsBtn = $('settingsBtn');
  if (settingsBtn) settingsBtn.addEventListener('click', () => {
    const st = $('settingsThemeState');
    if (st) st.textContent = document.documentElement.dataset.theme === 'dark' ? 'Dark' : 'Light';
    const sn = $('settingsSignoutName');
    if (sn) sn.textContent = sessName() || 'Account';
    settingsModal.hidden = false;
  });
  const closeSettings = (e) => {
    if (!e || e.target === settingsModal || (e.target.closest && e.target.closest('#settingsClose'))) settingsModal.hidden = true;
  };
  $('settingsClose').addEventListener('click', closeSettings);
  settingsModal.addEventListener('click', closeSettings);
  $('settingsTheme').addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    const st = $('settingsThemeState');
    if (st) st.textContent = document.documentElement.dataset.theme === 'dark' ? 'Dark' : 'Light';
  });
  $('settingsCli').addEventListener('click', () => {
    const im = $('installModal');
    if (im) im.hidden = false;
  });
  $('settingsSignout').addEventListener('click', () => {
    settingsModal.hidden = true;
    const so = $('menuSignout');
    if (so) so.click();
    else {
      try { fetch(`${API}/api/auth/logout`, { method: 'POST', headers: authHeaders() }); } catch { /* ignore */ }
      try { localStorage.removeItem('ab.tok'); localStorage.removeItem('ab.user'); } catch { /* ignore */ }
      location.href = 'index.html';
    }
  });
}
const menuSignout = $('menuSignout');
if (menuSignout) menuSignout.addEventListener('click', async () => {
  toggleAcctMenu(false);
  try {
    await fetch(`${API}/api/auth/logout`, { method: 'POST', headers: authHeaders() });
  } catch { /* ignore */ }
  try {
    localStorage.removeItem('ab.tok');
    localStorage.removeItem('ab.user');
  } catch { /* ignore */ }
  location.href = 'index.html';
});
const menuDelete = $('menuDelete');
if (menuDelete) menuDelete.addEventListener('click', async () => {
  const name = sessName();
  if (!confirm(`Delete your account "${name}" permanently?\n\nThis removes your account, projects, files, and all data. This cannot be undone.`)) return;
  try {
    const r = await fetch(`${API}/api/auth/delete`, { method: 'POST', headers: authHeaders() });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'delete failed');
    notify('Account', `Account "${name}" deleted.`);
  } catch (e) {
    notify('Account', `Delete failed: ${e.message}`);
    return;
  }
  try {
    localStorage.removeItem('ab.tok');
    localStorage.removeItem('ab.user');
  } catch { /* ignore */ }
  setTimeout(() => { location.href = 'index.html'; }, 600);
});

function refreshKeyBtn() {
  $('keyBtn').classList.toggle('active', Boolean(ownKey()));
  const lbl = $('keyLbl');
  if (lbl) lbl.textContent = ownKey() ? 'Own key active' : 'Own API key';
}

$('keyBtn').addEventListener('click', () => {
  const cur = ownKey();
  const input = prompt(
    'Your personal Ollama Cloud API key.\n' +
    'Used per-request only, stored in this browser (localStorage), never on the server.\n\n' +
    'Leave empty to go back to the built-in shared key:',
    cur,
  );
  if (input === null) return; // cancelled
  if (!input.trim()) localStorage.removeItem('ab.key');
  else localStorage.setItem('ab.key', input.trim());
  refreshKeyBtn();
  loadModels();
});

/* ---------- gift credits ---------- */
function topConfirm(message, okLabel) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.id = 'giftConfirm';
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(8,10,18,.72);' +
      'backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;' +
      'font-family:system-ui,-apple-system,sans-serif';
    ov.innerHTML =
      '<div style="width:min(92vw,380px);background:#12141f;color:#e8eaf6;border:1px solid #2a2d44;' +
      'border-radius:16px;padding:26px;box-shadow:0 24px 80px rgba(0,0,0,.55);box-sizing:border-box">' +
      `<p style="margin:0 0 20px;font-size:14px;color:#e8eaf6;line-height:1.5">${String(message)}</p>` +
      '<div style="display:flex;gap:10px">' +
      '<button id="giftConfirmNo" style="flex:1;padding:12px;border:1px solid #2a2d44;border-radius:10px;' +
      'background:#0c0e18;color:#9aa0c3;font-size:14px;cursor:pointer">No</button>' +
      `<button id="giftConfirmOk" style="flex:1;padding:12px;border:0;border-radius:10px;` +
      `background:linear-gradient(135deg,#7c5cff,#5ca9ff);color:#fff;font-weight:600;font-size:14px;cursor:pointer">` +
      `${String(okLabel || 'Yes')}</button></div></div>`;
    document.body.appendChild(ov);
    const done = (v) => { ov.remove(); resolve(v); };
    ov.addEventListener('click', (e) => { if (e.target === ov) done(false); });
    $('giftConfirmNo').onclick = () => done(false);
    $('giftConfirmOk').onclick = () => done(true);
  });
}

$('giftBtn').addEventListener('click', async () => {
  if (!sessTok()) { $('authGate').hidden = false; paintAuth(); return; }
  const to = (prompt('Enter the username to gift credits to:' ) || '').trim();
  if (!to) return;
  const amtRaw = prompt('How many credits to gift?');
  if (amtRaw === null || amtRaw === '') return;
  const amount = Number(amtRaw);
  if (!Number.isFinite(amount) || amount <= 0) { notify('Gift credits', 'Enter a positive number of credits.'); return; }
  const qty = amount === 1 ? '1 credit' : `${amount} credits`;
  const ok = await topConfirm(`Are you sure you want to gift ${to} ${qty}?`, 'Yes, gift');
  if (!ok) return;
  try {
    const r = await fetch(`${API}/api/credits/gift`, {
      method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ to, amount }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    notify('Gift credits', `Gifted ${qty} to ${to}.`);
    await loadCredits();
  } catch (e) { notify('Gift credits', e.message); }
});

/* ---------- data loading ---------- */
async function loadMeta() {
  try {
    const m = await (await fetch(`${API}/api/meta`)).json();
    if (m.model) defaultModel = m.model;
    loadModels();
  } catch { /* ignore */ }
  refreshKeyBtn();
}

// Daily free credits, lifetime earned and the team shared pool (sidebar footer).
const fmtCredits = (v) => (Number.isFinite(v) ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : '0');
let userTeams = [];
let teamNameOf = new Map();
const myTeamIds = new Set();
async function loadCredits() {
  const mb = $('metaBar');
  if (!mb || !sessTok()) return;
  try {
    const r = await fetch(`${API}/api/credits`, { headers: authHeaders() });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    userTeams = (j.teams || []).slice();
    myTeamIds.clear(); teamNameOf.clear();
    for (const t of userTeams) {
      myTeamIds.add(t.id); teamNameOf.set(t.id, t.name);
    }
    const parts = [];
    if (j.credits) {
      parts.push(`Today: ${fmtCredits(j.credits.left)} / ${fmtCredits(j.credits.total)} credits`);
      if (Number.isFinite(j.earned) && j.earned > 0) parts.push(`Earned: ${fmtCredits(j.earned)}`);
    }
    if (j.team) {
      parts.push(`Team ${j.team.name}: pool ${fmtCredits(j.team.leftCredits)} / ${fmtCredits(j.team.totalCredits)}`);
    }
    mb.textContent = parts.join(' · ');
    mb.title = parts.join('\n');
  } catch { mb.textContent = ''; }
}

/* ---------- teambuild: teams ---------- */
const whoLabel = (u) => (u && u !== sessName() ? u : '');
const teamModal = $('teamModal');
async function openTeams() {
  teamModal.hidden = false;
  await refreshTeamList();
}
async function refreshTeamList() {
  if (!sessTok()) return;
  const list = $('teamList');
  try {
    const r = await fetch(`${API}/api/teams`, { headers: authHeaders() });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    const teams = await r.json();
    list.innerHTML = '';
    if (!Array.isArray(teams) || !teams.length) {
      list.innerHTML = '<div class="fpEmpty">No teams yet — create one above, or paste an invite code from a teammate.</div>';
      return;
    }
    const me = sessName();
    for (const t of teams) {
      const row = document.createElement('div');
      row.className = 'teamRow';
      const title = document.createElement('div');
      title.className = 'teamTitle';
      const name = document.createElement('span');
      name.className = 'teamName';
      name.textContent = t.name + (t.owner === me ? ' (you)' : '');
      const meta = document.createElement('span');
      meta.className = 'teamMeta';
      meta.textContent = `${t.members || 0} member${(t.members || 0) === 1 ? '' : 's'}`;
      title.append(name, meta);
      const code = document.createElement('code');
      code.className = 'teamCode';
      code.title = 'Invite code';
      code.textContent = t.invite_code || '';
      const copy = document.createElement('button');
      copy.className = 'chipBtn';
      copy.textContent = 'Invite';
      copy.onclick = async () => {
        const link = `${location.origin}${location.pathname.replace(/index\.html$/, '')}?join=${t.id}&code=${t.invite_code}`;
        try {
          await navigator.clipboard.writeText(link);
          notify('Team invite', 'Link copied — a teammate can open it to join.');
        } catch {
          prompt('Copy this invite link:', link);
        }
      };
      const act = document.createElement('button');
      act.className = 'chipBtn' + (t.owner === me ? ' danger' : '');
      act.textContent = t.owner === me ? 'Delete' : 'Leave';
      act.onclick = async () => {
        const url = `${API}/api/teams/${t.id}`;
        if (t.owner === me) {
          if (!confirm(`Delete team "${t.name}"? All members lose access.`)) return;
          const dr = await fetch(url, { method: 'DELETE', headers: authHeaders() });
          if (!dr.ok) { notify('Teams', (await dr.json().catch(() => ({}))).error || 'failed'); return; }
        } else {
          const lr = await fetch(url + '/leave', { method: 'POST', headers: authHeaders() });
          if (!lr.ok) { notify('Teams', (await lr.json().catch(() => ({}))).error || 'failed'); return; }
        }
        loadCredits(); loadProjects(); refreshTeamList();
      };
      row.append(title, code, copy, act);
      list.appendChild(row);
    }
  } catch (e) {
    list.innerHTML = `<div class="fpEmpty">⚠ ${e.message}</div>`;
  }
}
$('teamCreate').addEventListener('click', async () => {
  const name = $('teamName').value.trim().slice(0, 40);
  if (!name) { notify('Teams', 'Enter a team name first.'); return; }
  try {
    const r = await fetch(`${API}/api/teams`, {
      method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    $('teamName').value = '';
    loadCredits(); loadProjects(); await refreshTeamList();
  } catch (e) { notify('Create team failed', e.message); }
});
$('teamJoin').addEventListener('click', async () => {
  const raw = $('joinCode').value.trim();
  if (!raw) { notify('Teams', 'Paste the invite code or link first.'); return; }
  const m = raw.match(/[?&]code=([A-Za-z0-9]{4,12})/i);
  const tid = raw.match(/[?&]join=([A-Za-z0-9]+)/i);
  const code = (m ? m[1] : raw.replace(/[^A-Za-z0-9]/g, '')).toUpperCase();
  if (code.length < 4) { notify('Teams', 'That invite code looks wrong.'); return; }
  try {
    if (tid) {
      const jr = await fetch(`${API}/api/teams/${tid[1]}/join`, {
        method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ invite_code: code }),
      });
      if (!jr.ok) throw new Error((await jr.json().catch(() => ({}))).error || `HTTP ${jr.status}`);
    } else {
      const fr = await fetch(`${API}/api/teams/by-invite/${encodeURIComponent(code)}`, { headers: authHeaders() });
      if (!fr.ok) throw new Error((await fr.json().catch(() => ({}))).error || `HTTP ${fr.status}`);
      const t = await fr.json();
      const jr = await fetch(`${API}/api/teams/${t.id}/join`, {
        method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ invite_code: code }),
      });
      if (!jr.ok) throw new Error((await jr.json().catch(() => ({}))).error || `HTTP ${jr.status}`);
    }
    $('joinCode').value = '';
    notify('Teams', 'You joined the team.');
    loadCredits(); loadProjects(); await refreshTeamList();
  } catch (e) { notify('Join team failed', e.message); }
});
$('joinCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('teamJoin').click(); });
$('teamName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('teamCreate').click(); });
$('teamClose').addEventListener('click', () => { teamModal.hidden = true; });
teamModal.addEventListener('click', (e) => { if (e.target === teamModal) teamModal.hidden = true; });
$('teamsBtn').addEventListener('click', () => {
  if (!sessTok()) { alert('Sign in to use teams.'); return; }
  $('teamsBtn').classList.add('active');
  openTeams();
});

/* ---------- install CLI ---------- */
const installModal = $('installModal');
const copyTip = (btn) => {
  const t = btn.textContent;
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = t; }, 1400);
};
$('installBtn').addEventListener('click', () => { installModal.hidden = false; });
$('authInstallLink').addEventListener('click', (e) => { e.preventDefault(); installModal.hidden = false; });
$('installClose').addEventListener('click', () => { installModal.hidden = true; });
installModal.addEventListener('click', (e) => { if (e.target === installModal) installModal.hidden = true; });

document.querySelectorAll('.copyBtn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const code = $(btn.dataset.copy);
    if (!code) return;
    const text = code.textContent.trim();
    try {
      await navigator.clipboard.writeText(text);
      copyTip(btn);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta);
      ta.select(); document.execCommand('copy'); ta.remove();
      copyTip(btn);
    }
  });
});

async function loadModels() {
  try {
    const r = await fetch(`${API}/api/models`, { headers: authHeaders() });
    const j = await r.json();
    const names = Array.isArray(j.models) && j.models.length
      ? j.models
      : ['gemma4:31b', 'gpt-oss:120b', 'gpt-oss:20b'];
    const recommended = typeof j.recommended === 'string' && names.includes(j.recommended)
      ? j.recommended
      : names[0];
    modelSel.innerHTML = '';
    for (const n of names) {
      const o = document.createElement('option');
      o.value = n; o.textContent = n;
      modelSel.appendChild(o);
    }
    const saved = localStorage.getItem('ab.model');
    if (saved && names.includes(saved)) modelSel.value = saved;
    else modelSel.value = recommended;
  } catch {
    modelSel.innerHTML = `<option>gpt-oss:120b</option>`;
  }
}

async function loadProjects(selectPid) {
  const all = await (await fetch(`${API}/api/projects`)).json();
  // sidebar = my projects + every team project I'm a member of
  const me = sessName();
  const list = all.filter((p) => !p.owner || p.owner === me || (p.team_id && myTeamIds.has(p.team_id)));
  const el = $('projectList'); el.innerHTML = '';
  for (const p of list) {
    const d = document.createElement('div');
    d.className = 'proj' + (p.id === projectId ? ' active' : '');
    const shared = Boolean(p.team_id) && p.owner !== me;
    if (shared) {
      const tag = document.createElement('span');
      tag.className = 'tag shared';
      tag.textContent = (teamNameOf.get(p.team_id) || 'team').slice(0, 14);
      tag.title = 'Shared with your team';
      d.appendChild(tag);
    }
    const label = document.createElement('span');
    label.textContent = p.name + (p.published ? ' ·' : '');
    d.appendChild(label);
    d.title = (shared ? `${teamNameOf.get(p.team_id) || 'Team'} project — ` : '') + p.name + (p.published ? ' (published)' : '');
    d.onclick = () => { selectProject(p.id); setDrawer(false); };
    el.appendChild(d);
  }
  if (selectPid && list.some(p => p.id === selectPid)) selectProject(selectPid);
}

async function selectProject(pid) {
  projectId = pid;
  const data = await (await fetch(`${API}/api/projects/${pid}`)).json();
  projName.textContent = data.project.name;
  document.title = `${data.project.name} — aibuilder`;
  publishBtn.disabled = false;
  setPub(data.project.published);
  const mine = !data.project.owner || data.project.owner === sessName();
  canEdit = mine;
  snapModal.hidden = true;
  $('delBtn').hidden = !mine;
  $('renameBtn').hidden = !mine;
  if (saveBtn) saveBtn.disabled = false;
  setStatus('Ready');
  if (data.project.model && [...modelSel.options].some(o => o.value === data.project.model)) {
    modelSel.value = data.project.model;
  }
  messagesEl.innerHTML = '';
  for (const m of data.messages) {
    if (m.role === 'user') addUserBubble(m.content, whoLabel(m.user));
    else addAiBubble(stripBlocks(m.content));
  }
  let plan = [];
  try { plan = typeof data.project.plan === 'string' ? JSON.parse(data.project.plan) : (data.project.plan || []); } catch { plan = []; }
  renderPlan(plan);
  setChips(data.files);
  clearPreviewQuarantine();
  refreshPreview(false);
  loadProjects();
  watchProject(pid);
  startCursors(pid);
  refreshLive(pid);
}

function resetToNew() {
  projectId = null;
  canEdit = false;
  hideBuildSplash(true);
  snapModal.hidden = true;
  fpPane.hidden = true;
  stopCursors();
  $('liveBadge').hidden = true;
  projName.textContent = 'New app';
  document.title = 'aibuilder';
  publishBtn.disabled = true;
  setPub(false);
  $('delBtn').hidden = true;
  $('renameBtn').hidden = true;
  if (saveBtn) saveBtn.disabled = true;
  setStatus('Ready');
  messagesEl.innerHTML = `
    <div class="empty">
      <div class="emptyMark"><span class="ms" data-ic="spark"></span></div>
      <h1>Describe it.<br>Watch it <em>become real.</em></h1>
      <p>Tell aibuilder what you want to build. It drafts a blueprint, writes the code, and keeps a live, editable preview open the whole way through.</p>
      <div class="emptySteps">
        <div class="step"><div class="n">01</div><div class="t">Describe</div><div class="s">“A billing dashboard with charts and CSV export.”</div></div>
        <div class="step"><div class="n">02</div><div class="t">Iterate</div><div class="s">Refine with follow-up prompts in the same thread.</div></div>
        <div class="step"><div class="n">03</div><div class="t">Publish</div><div class="s">Ship it to the discovery feed in one click.</div></div>
      </div>
      <div class="emptyQuick">
        <span class="eqLabel">Quick starts</span>
        <button class="qt" data-prompt="Build a to-do list app. Users can add, edit, check off and delete tasks, and it saves everything to the built-in database so it survives refresh. Make it look polished with a nice card layout, dark-mode friendly and fully responsive.">✓ To-do list</button>
        <button class="qt" data-prompt="Build a modern one-page landing page for a fictional startup. Include a hero with a headline and call-to-action, a features grid, a pricing section with three tiers, a testimonials row and a footer. Use clean gradients and make it fully responsive.">🚀 Landing page</button>
        <button class="qt" data-prompt="Build a billing dashboard. Show a KPI header (revenue, MRR, churn, active customers), a line chart of revenue over the last 12 months, a recent transactions table, and export the visible table to CSV. Style it like a professional SaaS admin.">📊 Billing dashboard</button>
        <button class="qt" data-prompt="Build a small quiz game. Show one question at a time with four options, highlight correct/wrong answers, track a score, and show a results screen at the end with a play-again button. Add a clean modern theme.">🧠 Quiz game</button>
      </div>
    </div>`;
  mountIcons(messagesEl);
  setChips([]);
  frame.src = 'about:blank';
  clearPreviewQuarantine();
  renderPlan([]);
  watchProject(null);
  promptBox.focus();
  const quickStart = () => {
    messagesEl.querySelectorAll('.emptyQuick .qt').forEach((b) => b.addEventListener('click', () => {
      promptBox.value = b.dataset.prompt || '';
      promptBox.focus();
      send();
    }));
  };
  quickStart();
}

/* ---------- plan sidebar ---------- */
function renderPlan(items) {
  const list = $('planList'), pane = $('planPane'), btn = $('planBtn');
  list.innerHTML = '';
  for (const it of items || []) {
    const li = document.createElement('li');
    const mark = ic(it.done ? 'check-circle' : 'circle', 'mark' + (it.done ? ' done' : ''));
    li.appendChild(mark);
    li.appendChild(document.createTextNode(it.text));
    list.appendChild(li);
  }
  btn.hidden = !(items && items.length);
  $('planCount').textContent = items && items.length
    ? `${items.filter(i => i.done).length}/${items.length}` : '';
  if (!items || !items.length) { pane.hidden = true; return; }
  // auto-open on desktop once a plan exists (respect manual close during streaming)
  if (window.innerWidth > 1100 && !planDismissedByUser) pane.hidden = false;
}
let planDismissedByUser = false;
$('planBtn').addEventListener('click', () => {
  const pane = $('planPane');
  planDismissedByUser = !pane.hidden;
  pane.hidden = !pane.hidden;
});
$('planClose').addEventListener('click', () => { planDismissedByUser = true; $('planPane').hidden = true; });

/* ---------- error notifications tray ---------- */
const notifs = [];
function notify(title, message) {
  notifs.push({ title, message: String(message || ''), ts: Date.now() });
  if (notifs.length > 30) notifs.shift();
  renderNotifs();
}
function renderNotifs() {
  const badge = $('notifBadge'), panel = $('notifPanel'), list = $('notifList');
  badge.hidden = !notifs.length;
  $('notifCount').textContent = String(notifs.length);
  list.innerHTML = '';
  for (let i = notifs.length - 1; i >= 0; i--) {
    const n = notifs[i];
    const row = document.createElement('div');
    row.className = 'notif';
    const head = document.createElement('div');
    head.className = 'nTitle';
    head.textContent = n.title;
    const body = document.createElement('div');
    body.className = 'nMsg';
    body.textContent = n.message;
    const send = document.createElement('button');
    send.className = 'nSend';
    send.append(ic('wand'), document.createTextNode(' Send to AI'));
    send.onclick = () => {
      panel.hidden = true;
      promptBox.value = `Something broke in my app — please fix it.\n\nError (${n.title}): ${n.message}`;
      promptBox.focus();
      if (!busy) sendBtn.click();
    };
    row.append(head, body, send);
    list.appendChild(row);
  }
}
$('notifBadge').addEventListener('click', () => {
  $('notifPanel').hidden = !$('notifPanel').hidden;
});
window.addEventListener('error', (e) => notify('Page error', e.message));
window.addEventListener('unhandledrejection', (e) =>
  notify('Promise rejection', e.reason?.message || String(e.reason)));
// runtime errors inside the generated app (injected hook posts these over)
window.addEventListener('message', (e) => {
  const d = e.data;
  if (d && d.__ab === 'error' && d.message) notify('App error', d.message);
});

/* ---------- 404 bounce notice (?nf=<path>) ---------- */
{
  const nf = new URLSearchParams(location.search).get('nf');
  if (nf) {
    history.replaceState(null, '', location.pathname.replace(/index\.html$/, '') || '/');
    notify('404 Not Found', `"${nf}" does not exist — you were redirected to the homepage.`);
  }
}

/* ---------- co-build: live sync when others change this project ---------- */
let liveChannel = null;
function watchProject(pid) {
  if (liveChannel) { liveChannel.unsubscribe(); liveChannel = null; }
  if (!pid || !window.supabase) return;
  const sb = window.supabase.createClient(window.__SB_URL, window.__SB_KEY);
  liveChannel = sb.channel('build:' + pid);
  liveChannel.on('broadcast', { event: 'evt' }, (payload) => {
    const m = payload.payload;
    if (m.type !== 'refresh' || m.sid === SID) return;
    if (!busy) selectProject(pid);
  }).on('broadcast', { event: 'msg' }, (payload) => {
    const m = payload.payload || {};
    if (m.sid === SID) return;
    refreshLive(pid);
    addUserBubble(String(m.message || ''), whoLabel(m.user));
  }).subscribe();
}

/* ---------- teambuild: live presence (who is building now) ---------- */
let liveTimer = null;
let liveInterval = null;
async function refreshLive(pid) {
  const badge = $('liveBadge');
  if (!pid || !sessTok()) { badge.hidden = true; return; }
  try {
    const r = await fetch(`${API}/api/projects/${pid}/presence`, { headers: authHeaders() });
    if (!r.ok) throw new Error('http ' + r.status);
    const j = await r.json();
    if (j && typeof j.active === 'number') {
      badge.hidden = false;
      badge.textContent = `${j.active}/${j.limit} live`;
      badge.classList.toggle('full', j.active >= j.limit);
      badge.title = (j.users && j.users.length ? `Live now: ${j.users.join(', ')}` : '') +
        (j.active >= j.limit ? ' — at the 10-person cap, a teammate must leave before you can build.' : '');
    }
  } catch { badge.hidden = true; }
}

/* ---------- teambuild: remote cursors over the chat pane ---------- */
const CURSOR_COLORS = ['#e05252', '#3da9fc', '#2fcb6a', '#f59e0b', '#a78bfa', '#ec4899', '#14b8a6', '#f43f5e', '#84cc16', '#0ea5e9'];
const hashStr = (s) => { let h = 0; for (const ch of String(s)) { h = (h * 31 + ch.charCodeAt(0)) | 0; } return Math.abs(h); };
let cursorState = null;
function stopCursors() {
  if (cursorState) {
    try { cursorState.ch.unsubscribe(); } catch {}
    try { clearInterval(cursorState.timer); } catch {}
    cursorState = null;
    const l = $('cursorLayer'); if (l) l.innerHTML = '';
  }
  clearInterval(liveInterval);
  clearInterval(liveTimer);
}
function startCursors(pid) {
  stopCursors();
  if (!pid || !window.supabase || !sessTok()) return;
  const sb = window.supabase.createClient(window.__SB_URL, window.__SB_KEY);
  const ch = sb.channel('cursors:' + pid, { config: { presence: { key: SID } } });
  const layer = $('cursorLayer');
  ch.on('presence', { event: 'sync' }, () => {
    const state = ch.presenceState();
    layer.innerHTML = '';
    const names = [];
    for (const sid in state) {
      if (sid === SID) continue;
      for (const p of state[sid] || []) {
        if (!p || typeof p.x !== 'number') continue;
        names.push(p.name);
        const color = CURSOR_COLORS[hashStr(sid) % CURSOR_COLORS.length];
        const el = document.createElement('div');
        el.className = 'cursor';
        el.style.left = p.x + 'px';
        el.style.top = p.y + 'px';
        el.style.setProperty('--c', color);
        const nm = document.createElement('span');
        nm.className = 'nm';
        nm.textContent = p.name;
        el.appendChild(nm);
        layer.appendChild(el);
      }
    }
    if (names.length) layer.dataset.names = names.join(', ');
    else delete layer.dataset.names;
  }).subscribe((status) => {
    if (status === 'SUBSCRIBED') ch.track({ name: sessName() });
  });
  cursorState = { ch, layer };
  liveInterval = setInterval(() => refreshLive(pid), 20000);
  refreshLive(pid);
}
document.addEventListener('mousemove', (() => {
  let last = 0;
  return (e) => {
    if (!cursorState || !cursorState.ch) return;
    const now = Date.now();
    if (now - last < 40) return;
    last = now;
    const pane = $('chatPane');
    const r = pane.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
    cursorState.ch.track({ x: Math.round(e.clientX - r.left), y: Math.round(e.clientY - r.top), name: sessName() });
  };
})(), { passive: true });

/* ---------- structured AI messages ---------- */
function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function makeAiMsg(model) {
  const el = document.createElement('div');
  el.className = 'msg ai wrap';
  const head = document.createElement('div');
  head.className = 'aiHead';
  const m = document.createElement('span');
  m.className = 'aiModel';
  m.textContent = model || '';
  const st = document.createElement('span');
  st.className = 'aiStatus';
  st.textContent = 'thinking…';
  head.append(m, st);
  const prose = document.createElement('div');
  prose.className = 'aiProse';
  const acts = document.createElement('div');
  acts.className = 'aiActs';
  el.append(head, prose, acts);
  messagesEl.appendChild(el);
  scrollBottom();
  return {
    el, prose, acts, status: st, full: '',
    setStatus(txt) {
      st.textContent = txt;
      if (txt === 'done') st.dataset.done = '1';
      else if (txt === 'interrupted' || txt === 'error') delete st.dataset.done;
      else delete st.dataset.done;
    },
    append(txt) {
      this.full += txt;
      prose.textContent = this.full; // plain-text output — no markdown re-render
      scrollBottom();
    },
    card(kind, html) {
      if (html === undefined) { html = kind; kind = ''; }
      const c = document.createElement('div');
      c.className = 'actCard' + (kind ? ' ' + kind : '');
      c.innerHTML = html;
      acts.appendChild(c);
      scrollBottom();
    },
  };
}
// live action-card builders (monogram chips; paths are escaped)
const actCards = {
  w: (p) => '<span class="acIco">W</span><span class="acBody"><b>wrote</b> ' + escHtml(p) + '</span>',
  e: (p) => '<span class="acIco">E</span><span class="acBody"><b>edited</b> ' + escHtml(p) + '</span>',
  d: (p) => '<span class="acIco">D</span><span class="acBody"><b>removed</b> ' + escHtml(p) + '</span>',
  r: (f, t, n) => '<span class="acIco">R</span><span class="acBody"><b>renamed</b> ' + escHtml(f) + ' → ' + escHtml(t) + (n ? ' <em>+' + n + ' ref' + (n === 1 ? '' : 's') + '</em>' : '') + '</span>',
  a: (p) => '<span class="acIco">A</span><span class="acBody"><b>asset</b> ' + escHtml(p) + '</span>',
  seed: (c, n) => '<span class="acIco">DB</span><span class="acBody"><b>seeded</b> “' + escHtml(c) + '” with ' + n + ' row' + (n === 1 ? '' : 's') + '</span>',
  sub: (p) => '<span class="acIco">S</span><span class="acBody"><b>sub-agent</b> finished ' + escHtml(p) + '</span>',
  term: (cmd) => '<span class="acIco">›</span><span class="acBody"><b>command</b> ' + escHtml(cmd).slice(0, 120) + '</span>',
  plan: () => '<span class="acIco">P</span><span class="acBody"><b>plan</b> updated</span>',
  warn: (m) => '<span class="acIco warn">!</span><span class="acBody">' + escHtml(m) + '</span>',
  summary: (bits) => '<span class="acIco">OK</span><span class="acBody">' + bits + '</span>',
  test: (r) => {
    const n = (r.errors || []).length;
    if (r.ok) return '<span class="acIco">✓</span><span class="acBody"><b>page test passed</b> — ' + r.pages + ' page' + (r.pages === 1 ? '' : 's') + ', ' + r.scripts + ' script' + (r.scripts === 1 ? '' : 's') + ' checked</span>';
    const rows = (r.errors || []).slice(0, 4).map((e) =>
      escHtml(e.file) + (e.ref ? ' → ' + escHtml(e.ref) : '') + (e.message ? ' · <em>' + escHtml(e.message) + '</em>' : '')).join('<br>');
    return '<span class="acIco">✗</span><span class="acBody"><b>page test failed</b> — ' + n + ' issue' + (n === 1 ? '' : 's') + (r.more ? '+' : '') + '<br>' + rows + '</span>';
  },
};

/* ---------- the blueprint card: the AI's design intent, shown up front ---------- */
function briefCardHtml(b) {
  b = b || {};
  const pal = (b.palette || []).filter(Boolean).map((c) =>
    '<span class="swatch" style="--c:' + escHtml(c) + '" title="' + escHtml(c) + '"></span>').join('');
  const chips = (b.components || []).filter(Boolean).map((c) =>
    '<span class="briefChip">' + escHtml(c) + '</span>').join('');
  const data = (b.data || []).map((d) => {
    const col = typeof d === 'string' ? d : (d.collection || d.name || '');
    const rows = typeof d === 'string' ? '' : (d.rows != null ? ' · ' + escHtml(String(d.rows)) + ' rows' : '');
    return '<div class="briefDataRow"><code>' + escHtml(col) + '</code>' + rows + '</div>';
  }).join('');
  const fields =
    (pal ? '<div class="briefField"><h5>Palette</h5><div class="swatches">' + pal + '</div></div>' : '') +
    (chips ? '<div class="briefField"><h5>Key pieces</h5><div class="briefChips">' + chips + '</div></div>' : '') +
    (data ? '<div class="briefField"><h5>Data</h5><div class="briefData">' + data + '</div></div>' : '');
  return '<div class="brief">' +
    '<div class="briefHead">' + icSvg('spark') +
      '<span class="briefKicker">Blueprint</span>' +
      '<span class="briefName">' + escHtml(b.name || 'Untitled build') + '</span></div>' +
    '<div class="briefBody">' +
      (b.vibe ? '<div class="briefVibe">' + escHtml(b.vibe) + '</div>' : '') +
      (fields ? '<div class="briefGrid">' + fields + '</div>' : '') +
    '</div>' +
  '</div>';
}

/* ---------- small celebration when a build lands ---------- */
function celebrate() {
  try {
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const colors = ['#e8501a', '#f5a623', '#3da9fc', '#2fcb6a', '#a78bfa', '#ec4899'];
    const layer = document.createElement('div');
    layer.className = 'confetti';
    for (let i = 0; i < 28; i++) {
      const bit = document.createElement('i');
      bit.style.left = (Math.random() * 100).toFixed(1) + '%';
      bit.style.background = colors[i % colors.length];
      bit.style.animationDelay = (Math.random() * 0.25).toFixed(2) + 's';
      bit.style.animationDuration = (1.05 + Math.random() * 0.7).toFixed(2) + 's';
      bit.style.setProperty('--x', (Math.random() * 80 - 40).toFixed(0) + 'px');
      layer.appendChild(bit);
    }
    document.body.appendChild(layer);
    setTimeout(() => layer.remove(), 2200);
  } catch { /* cosmetic only */ }
}

/* ---------- witty progress phases while the model works ---------- */
const ACT_PHASES = [
  'reading the brief…', 'sketching the layout…', 'choosing a palette…',
  'writing the markup…', 'styling the details…', 'wiring up state…',
  'connecting the data…', 'checking the edges…', 'running a quick test…',
  'sweeping up the loose ends…',
];


/* ---------- new-project creation splash ---------- */
const BUILD_STEPS = [
  'Creating your project',
  'Creating dedicated folder',
  'Starting dedicated terminal',
  'Assembling the preview',
];
let splashStep = 0, splashTimer = null, splashActive = false;
function renderBuildSplash() {
  const list = $('bsSteps'); if (!list) return;
  list.innerHTML = '';
  BUILD_STEPS.forEach((label, i) => {
    const li = document.createElement('li');
    if (i < splashStep) li.className = 'done'; else if (i === splashStep) li.className = 'active';
    const dot = document.createElement('span'); dot.className = 'bsDot';
    if (i < splashStep) dot.innerHTML = ic('check');
    const tx = document.createElement('span'); tx.textContent = label;
    li.appendChild(dot); li.appendChild(tx);
    list.appendChild(li);
  });
  mountIcons(list);
  const bar = $('bsBar');
  if (bar) bar.style.width = Math.round(((splashStep + 0.5) / BUILD_STEPS.length) * 100) + '%';
}
function showBuildSplash() {
  const el = $('buildSplash'); if (!el) return;
  splashActive = true; splashStep = 0;
  el.hidden = false; el.classList.remove('leaving');
  renderBuildSplash();
  clearInterval(splashTimer);
  splashTimer = setInterval(() => {
    if (splashStep < BUILD_STEPS.length - 1) { splashStep++; renderBuildSplash(); }
  }, 1500);
}
function advanceBuildSplash() {
  if (!splashActive || splashStep >= BUILD_STEPS.length - 1) return;
  splashStep++; renderBuildSplash();
}
function hideBuildSplash(instant) {
  if (!splashActive) return;
  splashActive = false;
  clearInterval(splashTimer); splashTimer = null;
  splashStep = BUILD_STEPS.length; renderBuildSplash();
  const bar = $('bsBar'); if (bar) bar.style.width = '100%';
  const el = $('buildSplash'); if (!el) return;
  if (instant) { el.hidden = true; return; }
  el.classList.add('leaving');
  setTimeout(() => { el.hidden = true; el.classList.remove('leaving'); }, 420);
}

/* ---------- chat streaming ---------- */
// A stable id for one generation turn. Sent up-front so the client can re-attach
// to the background run even if the very first response never arrives.
function newRunId() {
  try { return crypto.randomUUID().replace(/-/g, '').slice(0, 24); }
  catch { return 'r' + Math.random().toString(36).slice(2) + Date.now().toString(36); }
}

async function send() {
  const message = promptBox.value.trim();
  if (!message || busy) return;
  busy = true; sendBtn.disabled = true;
  promptBox.value = '';
  setStatus('Building');
  if (!projectId) showBuildSplash();

  const emptyHero = messagesEl.querySelector('.empty');
  if (emptyHero) emptyHero.remove();
  addUserBubble(message, whoLabel(sessName()));
  if (liveChannel) {
    liveChannel.send({ type: 'broadcast', event: 'msg', payload: { user: sessName(), message, sid: SID } }).then(() => {}).catch(() => {});
  }

  displayText = ''; rawStream.textContent = ''; rawStream.hidden = true;
  const log = $('activityLog'); if (log) log.innerHTML = '';
  const filter = new BlockFilter();
  let aiMsg = null;
  dots = 0;
  activityText.textContent = 'thinking…';
  activityEl.hidden = false;

  const chosen = currentModel();
  localStorage.setItem('ab.model', chosen);

  let chipFiles = [];
  let doneReceived = false;
  let lastSeq = -1;      // daemon replay cursor (events carry a monotonic seq)
  let activeRun = null;  // set by the `run` event when the build can be resumed
  let previewTimer = null;
  // Live preview: per-event, but rate-capped so bursts of file changes collapse
  // into one reload per interval (with a guaranteed trailing refresh). `done`
  // refreshes once more at the end so the preview always lands current.
  const PREVIEW_INTERVAL = 1200;
  let lastPreview = 0;
  const schedulePreview = () => {
    clearTimeout(previewTimer);
    const wait = Math.max(0, lastPreview + PREVIEW_INTERVAL - Date.now());
    previewTimer = setTimeout(() => { lastPreview = Date.now(); refreshPreview(true); }, wait);
  };
  // Terminal-style build log: one timestamped line per build event.
  const termLog = (text, cls) => {
    const log = $('activityLog'); if (!log) return;
    const d = document.createElement('div');
    d.className = 'tl ' + (cls || '');
    const t = new Date().toLocaleTimeString('en-GB', { hour12: false });
    d.textContent = '[' + t + '] ' + text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  };

  // Remember the turn id before sending: if the tab dies mid-build the next load
  // can re-attach. Cleared once the run reports done (or is not resumable).
  const runId = newRunId();
  try { localStorage.setItem('ab.run.last', runId); } catch {}

  try {
    const res = await fetch(`${API}/api/chat`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        projectId, message, model: chosen,
        apiKey: ownKey() || undefined,
        sid: SID,
        effort,
        runId,
      }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      const msg = d.error || `HTTP ${res.status}`;
      if (res.status === 429) {
        if (/10-people|live limit/i.test(msg)) {
          refreshLive(projectId);
          throw new Error(msg);
        }
        if (d.credits) {
          loadCredits();
          throw new Error(`Daily credit limit reached — ${fmtCredits(d.credits.left)} of ${fmtCredits(d.credits.total)} remaining today. Add your own API key (🔑) for unlimited use.`);
        }
        throw new Error('Request throttled — the service is temporarily rate-limited. Please try again shortly.');
      }
      if (res.status === 401) throw new Error('Authentication required — sign in to continue building.');
      if (res.status === 403) throw new Error('Access denied — you do not have permission to modify this project.');
      if (res.status === 500) throw new Error('Server error — something went wrong on our end. Please try again.');
      throw new Error(msg);
    }

    // Read one SSE response and apply every event. Kept as a function so the
    // reconnect path can feed later responses through the same handling.
    const readStream = async (res) => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let lineBuf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      lineBuf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = lineBuf.indexOf('\n\n')) !== -1) {
        const line = lineBuf.slice(0, nl).trim(); lineBuf = lineBuf.slice(nl + 2);
        if (!line.startsWith('data:')) continue;
        let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }

        if (typeof ev.seq === 'number' && ev.seq > lastSeq) lastSeq = ev.seq;
        if (ev.type === 'run') {
          if (ev.resumable && ev.runId) activeRun = ev.runId;
          else { try { localStorage.removeItem('ab.run.last'); } catch {} }
        } else if (ev.type === 'meta') {
          if (!projectId) {
            showBuildSplash();
            projectId = ev.projectId; canEdit = true;
            publishBtn.disabled = false;
            if (saveBtn) saveBtn.disabled = false;
          }
          projName.textContent = message.slice(0, 60);
          aiMsg = makeAiMsg(ev.model);
          activityText.textContent = `${ev.model} is working…`;
        } else if (ev.type === 'think') {
          dots = (dots + 1) % ACT_PHASES.length;
          const phrase = ev.text || ACT_PHASES[dots];
          if (aiMsg) aiMsg.setStatus(phrase);
          activityText.textContent = phrase.charAt(0).toUpperCase() + phrase.slice(1);
        } else if (ev.type === 'brief') {
          const html = briefCardHtml(ev.brief);
          if (aiMsg) aiMsg.card('brief', html);
          else addAiBubble('Here is the blueprint for this build.');
          activityText.textContent = 'Blueprint ready';
          termLog('blueprint — ' + ((ev.brief && ev.brief.name) || 'untitled'), 's');
        } else if (ev.type === 'token') {
          displayText += ev.v;
          if (aiMsg) {
            const clean = filter.push(ev.v);
            if (clean) aiMsg.append(clean);
          }
        } else if (ev.type === 'file') {
          chipFiles.push(ev.path);
          setChips(chipFiles, [ev.path]);
          flashChip(ev.path);
          if (aiMsg) aiMsg.card('', actCards.w(ev.path));
          activityText.textContent = `Generated ${ev.path}`;
          termLog('wrote ' + ev.path, 'w');
          advanceBuildSplash();
          schedulePreview();
        } else if (ev.type === 'edit') {
          chipFiles.push(ev.path);
          setChips(chipFiles, [ev.path]);
          flashChip(ev.path);
          if (aiMsg) aiMsg.card('', actCards.e(ev.path));
          activityText.textContent = `Updated ${ev.path}`;
          termLog('edited ' + ev.path, 'e');
          advanceBuildSplash();
          schedulePreview();
        } else if (ev.type === 'delete') {
          chipFiles = chipFiles.filter((p) => p !== ev.path);
          setChips(chipFiles);
          if (aiMsg) aiMsg.card('d', actCards.d(ev.path));
          activityText.textContent = `Removed ${ev.path}`;
          termLog('removed ' + ev.path, 'd');
          schedulePreview();
        } else if (ev.type === 'rename') {
          if (aiMsg) aiMsg.card('', actCards.r(ev.from, ev.to, ev.refs || 0));
          chipFiles = chipFiles.map((p) => (p === ev.from ? ev.to : p));
          if (!chipFiles.includes(ev.to)) chipFiles.push(ev.to);
          setChips(chipFiles, [ev.to]);
          activityText.textContent = `Renamed ${ev.from} → ${ev.to}`;
          termLog('renamed ' + ev.from + ' -> ' + ev.to, 'r');
          schedulePreview();
        } else if (ev.type === 'asset') {
          if (aiMsg) aiMsg.card('a', actCards.a(ev.path));
          activityText.textContent = `Saved asset ${ev.path}`;
          termLog('asset ' + ev.path, 'a');
          schedulePreview();
        } else if (ev.type === 'seed') {
          if (aiMsg) aiMsg.card('seed', actCards.seed(ev.collection, ev.count || 0));
          activityText.textContent = `Seeded ${ev.collection} (${ev.count || 0} rows)`;
          termLog('seeded ' + ev.collection + ' (' + (ev.count || 0) + ' rows)', 's');
          schedulePreview();
        } else if (ev.type === 'cmd') {
          if (window.__termLine) {
            window.__termLine('$ ' + (ev.command || ''), 'cmd');
            if (ev.blocked) {
              window.__termLine('[blocked] ' + (ev.error || ev.output || 'outside the project folder'), 'meta');
            } else {
              if (ev.output) window.__termLine(ev.output.replace(/\s+$/, ''), 'out');
              window.__termLine(`[exit ${ev.code == null ? '-' : ev.code}] ${ev.error ? ev.error : 'ok'}`, 'meta');
            }
          }
          if (aiMsg && ev.ok) aiMsg.card('run', actCards.term(ev.command));
        } else if (ev.type === 'server') {
          const srvCmd = ev.command || (ev.file ? ('python3 ' + ev.file) : '');
          if (window.__termLine) {
            if (ev.ok) {
              window.__termLine('$ ' + srvCmd, 'cmd');
              window.__termLine(`[dedicated] ${ev.name} listening on :${ev.port} — persistent, auto-restart`, 'meta');
            } else {
              window.__termLine('[dedicated] ' + (ev.error || 'failed to start'), 'meta');
            }
          }
          if (aiMsg) aiMsg.card(ev.ok ? 'server' : 'server fail', actCards.term(srvCmd + (ev.ok ? `  →  :${ev.port}` : '')));
          activityText.textContent = ev.ok ? `Dedicated server :${ev.port}` : 'Dedicated server failed';
          termLog(ev.ok ? `dedicated ${ev.name} on :${ev.port}` : `dedicated ${ev.name} failed: ${ev.error || ''}`, ev.ok ? 's' : 'e');
        } else if (ev.type === 'read') {
          const cnt = ev.lines != null ? ` (${ev.lines} line${ev.lines === 1 ? '' : 's'})` : '';
          activityText.textContent = `Read ${ev.path}`;
          termLog('read ' + ev.path + cnt, 's');
        } else if (ev.type === 'search') {
          const n = ev.count || 0;
          activityText.textContent = `Search: ${n} match${n === 1 ? '' : 'es'}`;
          const q = String(ev.query || '').slice(0, 60);
          termLog(`search "${q}" → ${n} match${n === 1 ? '' : 'es'}${ev.capped ? ' (capped)' : ''}`, 's');
        } else if (ev.type === 'listfiles') {
          const n = ev.count || 0;
          activityText.textContent = `Listed ${n} file${n === 1 ? '' : 's'}`;
          termLog(`listed ${n} file${n === 1 ? '' : 's'}`, 's');
        } else if (ev.type === 'plan') {
          renderPlan(ev.items || []);
          if (aiMsg) aiMsg.card('', actCards.plan());
        } else if (ev.type === 'name') {
          projName.textContent = ev.name;
          document.title = `${ev.name} — aibuilder`;
          loadProjects();
        } else if (ev.type === 'delegate') {
          if (aiMsg) aiMsg.setStatus(`delegating ${ev.path}…`);
          activityText.textContent = `Delegating ${ev.path} to a sub-agent…`;
        } else if (ev.type === 'subagent') {
          chipFiles.push(ev.path);
          setChips(chipFiles, [ev.path]);
          flashChip(ev.path);
          if (aiMsg) aiMsg.card('', actCards.sub(ev.path));
          activityText.textContent = `Sub-agent completed ${ev.path}`;
          termLog('sub-agent finished ' + ev.path, 's');
          schedulePreview();
        } else if (ev.type === 'refactor') {
          $('refactorBar').hidden = false;
          activityText.textContent = 'Restructuring code…';
          if (aiMsg) aiMsg.setStatus('restructuring…');
        } else if (ev.type === 'warn') {
          notify('Generator warning', ev.message);
          if (aiMsg) aiMsg.card('', actCards.warn(ev.message || ''));
        } else if (ev.type === 'test') {
          if (aiMsg) aiMsg.card('test' + (ev.ok ? '' : ' fail'), actCards.test(ev));
          if (!ev.auto) activityText.textContent = ev.ok ? 'Page test passed' : 'Page test failed — see card';
          if (!ev.ok) notify('Page test failed', (ev.errors || []).slice(0, 3).map((e) => `${e.file}${e.ref ? ' → ' + e.ref : ''}${e.message ? ' · ' + e.message : ''}`).join('\n'));
        } else if (ev.type === 'note') {
          notify('Heads up', ev.message);
        } else if (ev.type === 'freeze') {
          setPreviewQuarantine(ev.files || []);
          notify('Preview disabled', 'The page contains a loop that would freeze the browser. Ask the AI to fix it — it re-enables once the build passes again.');
        } else if (ev.type === 'unfreeze') {
          const wasQuarantined = previewQuarantined;
          clearPreviewQuarantine();
          if (wasQuarantined) {
            notify('Preview re-enabled', 'The build is safe again — the page reloads.');
            refreshPreview(true);
          }
        } else if (ev.type === 'error') {
          if (aiMsg) aiMsg.setStatus('error');
          addAiBubble(`⚠ ${ev.message}`);
          notify('Generation error', ev.message);
        } else if (ev.type === 'done') {
          doneReceived = true;
          activeRun = null;
          try { localStorage.removeItem('ab.run.last'); } catch {}
          hideBuildSplash();
          $('refactorBar').hidden = true;
          const bitsEnd = [];
          if (ev.files?.length) bitsEnd.push(`${ev.files.length} file${ev.files.length === 1 ? '' : 's'} written`);
          if (ev.edited?.length) bitsEnd.push(`${ev.edited.length} edited`);
          if (ev.deleted?.length) bitsEnd.push(`${ev.deleted.length} removed`);
          if (ev.renamed?.length) bitsEnd.push(`${ev.renamed.length} renamed`);
          if (ev.seeds?.length) bitsEnd.push(`${ev.seeds.length} seeded`);
          if (ev.assets?.length) bitsEnd.push(`${ev.assets.length} asset${ev.assets.length === 1 ? '' : 's'}`);
          termLog('build complete — ' + (bitsEnd.join(', ') || 'no changes'), 'done');
          if (bitsEnd.length) celebrate();
          schedulePreview(); // live preview refreshes once more now the build ended
          if (aiMsg) {
            aiMsg.setStatus('done');
            const rest = filter.drain();
            if (rest.trim()) aiMsg.append(rest);
            const bits = [];
            if (ev.files?.length) bits.push(`${ev.files.length} file${ev.files.length === 1 ? '' : 's'} written`);
            if (ev.edited?.length) bits.push(`${ev.edited.length} edited`);
            if (ev.deleted?.length) bits.push(`${ev.deleted.length} removed`);
            if (ev.renamed?.length) bits.push(`${ev.renamed.length} renamed`);
            if (ev.seeds?.length) bits.push(`${ev.seeds.length} seeded`);
            if (ev.assets?.length) bits.push(`${ev.assets.length} asset${ev.assets.length === 1 ? '' : 's'}`);
            if (bits.length) aiMsg.card('', actCards.summary(bits.join(' · ')));
          } else {
            addAiBubble((displayText + filter.drain()).trim());
          }
          loadCredits();
        }
      }
    }
    };

    // First read of the turn. When the daemon owns the build it buffers every
    // event, so a dropped connection can be resumed instead of losing the run.
    await readStream(res);

    if (!doneReceived && activeRun) {
      termLog('stream interrupted — the build is still running on the server; reconnecting…', 'meta');
      if (aiMsg) aiMsg.setStatus('still building in the background…');
      notify('Still building', "The connection dropped, but your build is still running in the background — your project won't be lost. Reconnecting…");
      let attempt = 0;
      while (!doneReceived && activeRun && attempt < 60) {
        attempt++;
        await new Promise((r) => setTimeout(r, Math.min(1000 + attempt * 750, 6000)));
        try {
          const rr = await fetch(`${API}/api/chat/stream/${encodeURIComponent(activeRun)}?since=${lastSeq + 1}`, { headers: authHeaders() });
          if (rr.status === 404) { termLog('the background run is no longer available to re-attach', 'meta'); break; }
          if (!rr.ok) continue;
          await readStream(rr);
        } catch { /* keep retrying until the run reports done */ }
      }
    }

    // Stream ended for good without a done event (server crashed / connection dropped)
    if (!doneReceived) {
      if (activeRun) {
        termLog('live re-attach paused — the build continues on the server; it will resume when this page reloads', 'meta');
        notify('Still building in the background', 'We could not re-establish the live stream here, but the build is still running on the server and your project is safe. Reload to reconnect.');
      } else {
        if (displayText.trim() && !aiMsg) addAiBubble((displayText + filter.drain()).trim());
        if (aiMsg) {
          aiMsg.setStatus('interrupted');
          const rest = filter.drain();
          if (rest.trim()) aiMsg.append(rest);
        }
        if (displayText.trim()) notify('Stream interrupted', 'Connection ended before the model finished responding.');
      }
    }
  } catch (e) {
    addAiBubble(`⚠ ${e.message}`);
    notify('Generation failed', e.message);
  } finally {
    if (splashActive) hideBuildSplash();
    activityEl.hidden = true;
    $('refactorBar').hidden = true;
    busy = false; sendBtn.disabled = false;
    promptBox.focus();
    loadProjects();
    setStatus('Ready');
    if (saveBtn && projectId) saveBtn.disabled = false;
  }
}

/* ---------- rename project (the owner names it — not the prompt) ---------- */
async function doRename() {
  if (!projectId || busy) return;
  const cur = projName.textContent;
  const name = prompt('Name this project:', cur === 'New app' ? '' : cur);
  if (name === null) return;
  const clean = name.trim().slice(0, 60);
  if (!clean || clean === cur) return;
  try {
    const r = await fetch(`${API}/api/projects/${projectId}/rename`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name: clean }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    const p = await r.json();
    projName.textContent = p.name;
    document.title = `${p.name} — aibuilder`;
    loadProjects();
  } catch (e) {
    notify('Rename failed', e.message);
    alert(`⚠ ${e.message}`);
  }
}
$('renameBtn').addEventListener('click', doRename);
projName.addEventListener('click', () => { if (!$('renameBtn').hidden) doRename(); });

/* ---------- save (everything is autosaved server-side; this resyncs & confirms) ---------- */
if (saveBtn) saveBtn.addEventListener('click', () => {
  if (busy) return;
  if (!projectId) {
    notify('Save', 'Nothing to save yet — describe an app to start building.');
    return;
  }
  refreshPreview(false);
  setStatus('Saved');
  if (saveLbl) saveLbl.textContent = 'Saved';
  saveBtn.disabled = true;
  setTimeout(() => {
    if (saveLbl) saveLbl.textContent = 'Save';
    saveBtn.disabled = false;
    setStatus('Ready');
  }, 1600);
});

/* ---------- publish / upload / delete ---------- */
publishBtn.addEventListener('click', async () => {
  if (!projectId || busy) return;
  const isPub = ($('pubLbl')?.textContent || 'Publish') === 'Unpublish';
  let description;
  if (!isPub) description = prompt('Short description shown on the Discover page:') || '';
  try {
    const r = await fetch(`${API}/api/projects/${projectId}/publish`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ publish: !isPub, description }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const updated = await r.json();
    setPub(updated.published);
    alert(updated.published
      ? `Published! Shareable link:\n${API || location.origin}/preview/${updated.id}/`
      : 'Unpublished.');
    loadProjects();
  } catch (e) {
    alert(`⚠ ${e.message}`);
  }
});

$('uploadInput').addEventListener('change', async (e) => {
  const picked = [...e.target.files];
  e.target.value = '';
  if (!picked.length || busy) return;
  await uploadFiles(picked);
});

$('delBtn').addEventListener('click', async () => {
  if (!projectId || !confirm('Delete this project?')) return;
  await fetch(`${API}/api/projects/${projectId}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  await loadProjects(); resetToNew();
});

/* ---------- Phase 2: drag-and-drop upload (adds into the open project) ---------- */
const dropOverlay = $('dropOverlay');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'))) return;
  e.preventDefault();
  dragDepth++;
  dropOverlay.hidden = false;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropOverlay.hidden = true;
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  const files = e.dataTransfer ? Array.from(e.dataTransfer.files || []) : [];
  if (!files.length || busy) return;
  await uploadFiles(files);
});

function guessProjectName(files) {
  const first = files[0] && (files[0].webkitRelativePath || files[0].name);
  if (!first) return 'app';
  return first.includes('/') ? first.split('/')[0] : first.replace(/\.[^.]+$/, '').slice(0, 40);
}

async function uploadFiles(files) {
  const intoExisting = projectId && canEdit;
  busy = true; sendBtn.disabled = true;
  try {
    const fd = new FormData();
    for (const f of files.slice(0, 300)) fd.append('files', f, f.webkitRelativePath || f.name);
    let pid = projectId;
    if (!intoExisting) {
      const p = await (await fetch(`${API}/api/projects`, {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ name: guessProjectName(files) }),
      })).json();
      pid = p.id;
    }
    const res = await fetch(`${API}/api/projects/${pid}/upload`, {
      method: 'POST',
      headers: authHeaders(),
      body: fd,
    });
    if (!res.ok) throw new Error(`upload failed: HTTP ${res.status}`);
    const out = await res.json();
    if (out.skipped.length) notify('Upload', `${out.skipped.length} files skipped (${out.skipped.slice(0, 3).join(', ')}…)`);
    if (intoExisting) await selectProject(projectId);
    else { resetToNew(); await selectProject(pid); }
    for (const n of (out.uploaded || [])) flashChip(n);
  } catch (err) {
    notify('Upload failed', err.message);
    alert(`⚠ ${err.message}`);
  } finally {
    busy = false; sendBtn.disabled = false;
  }
}

/* ---------- Phase 2: prompt templates ---------- */
const PROMPT_TEMPLATES = [
  { label: 'Landing page', prompt: 'Build a polished corporate landing page: sticky navbar with logo, hero with headline and CTA, trusted-by logos, features grid, pricing cards, FAQ accordion, and footer. Modern and clean.' },
  { label: 'Billing dashboard', prompt: 'Build a billing dashboard: KPI cards (MRR, churn, ARPU), a revenue line chart, an invoices table with status badges, and an export button.' },
  { label: 'Todo app', prompt: 'Build a todo app with three priority levels, due dates, inline editing, completion toggle, filtering, and a progress summary.' },
  { label: 'Chat app', prompt: 'Build a chat UI with a conversation list sidebar, message bubbles, read receipts, and a working composer that echoes messages locally.' },
  { label: 'Travel planner', prompt: 'Build a travel itinerary planner: day-by-day timeline, budget tracker with categories, and a packing checklist saved to localStorage.' },
];
function renderTemplates() {
  const row = $('templates');
  row.innerHTML = '<span class="tplLabel">Start with</span>';
  for (const t of PROMPT_TEMPLATES) {
    const b = document.createElement('button');
    b.className = 'tpl';
    b.textContent = t.label;
    b.title = t.prompt;
    b.onclick = () => {
      promptBox.value = t.prompt;
      promptBox.focus();
      promptBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    row.appendChild(b);
  }
}

/* ---------- Phase 2: file viewer (version history, diff, selective revert) ---------- */
const fpPane = $('filePane'), fpTitle = $('fpTitle'), fpCode = $('fpCode'),
  fpVersions = $('fpVersions'), fpRawBtn = $('fpRawBtn'), fpDiffBtn = $('fpDiffBtn'),
  fpRestore = $('fpRestore');

let fpPath = null;         // open file
let fpVersionsList = [];   // newest-first from GET versions
let fpSelected = null;     // version selected for raw/diff
let fpCurrentSeq = null;   // live content seq (highest)
let fpCurrent = '';        // live content buffer

function relTime(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60000) return 'just now';
  if (d < 3600000) return Math.round(d / 60000) + 'm ago';
  if (d < 86400000) return Math.round(d / 3600000) + 'h ago';
  const dt = new Date(ts);
  return `${dt.getMonth() + 1}/${dt.getDate()} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
}

function lineDiff(aText, bText) {
  const a = String(aText || '').split('\n');
  const b = String(bText || '').split('\n');
  const N = a.length, M = b.length;
  const dp = Array.from({ length: N + 1 }, () => new Array(M + 1).fill(0));
  for (let i = N - 1; i >= 0; i--)
    for (let j = M - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const rows = [];
  let i = 0, j = 0;
  while (i < N && j < M) {
    if (a[i] === b[j]) { rows.push({ t: '=', n: j + 1, x: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push({ t: '-', n: i + 1, x: a[i] }); i++; }
    else { rows.push({ t: '+', n: j + 1, x: b[j] }); j++; }
  }
  while (i < N) rows.push({ t: '-', n: ++i, x: a[i - 1] });
  while (j < M) rows.push({ t: '+', n: ++j, x: b[j - 1] });
  return rows;
}

function showFpEmpty(text) {
  fpCode.innerHTML = '';
  const d = document.createElement('div');
  d.className = 'fpEmpty';
  d.textContent = text;
  fpCode.appendChild(d);
}

async function openFilePane(path) {
  if (!projectId || !path) return;
  fpPath = path;
  fpTitle.textContent = path;
  fpSelected = null; fpCurrentSeq = null; fpCurrent = '';
  fpVersionsList = [];
  fpRawBtn.classList.add('on'); fpDiffBtn.classList.remove('on');
  fpRestore.disabled = true;
  fpPane.hidden = false;
  showFpEmpty('Loading…');
  try {
    const list = await (await fetch(`${API}/api/projects/${projectId}/versions?path=${encodeURIComponent(path)}`)).json();
    if (!Array.isArray(list) || !list.length) { showFpEmpty('No version history for this file yet.'); return; }
    fpVersionsList = list;
    fpCurrentSeq = list[0].seq;
    const cur = await (await fetch(`${API}/api/projects/${projectId}/versions?path=${encodeURIComponent(path)}&seq=${fpCurrentSeq}`)).json();
    fpCurrent = (cur && cur.content != null) ? cur.content : '';
    renderVersionList();
    renderRaw();
  } catch (e) {
    showFpEmpty(`⚠ ${e.message}`);
  }
}

function renderVersionList() {
  fpVersions.innerHTML = '';
  for (const v of fpVersionsList) {
    const b = document.createElement('button');
    b.className = 'fpv'
      + (v.deleted ? ' deleted' : '')
      + (v.seq === fpCurrentSeq ? ' current' : '')
      + (fpSelected && fpSelected.seq === v.seq ? ' on' : '');
    const tag = v.seq === fpCurrentSeq ? ' · current' : v.deleted ? ' · deleted' : '';
    b.innerHTML = `<b>v${v.seq}</b>${tag}<small>${relTime(v.updated_at)}${v.deleted ? '' : ' · ' + (v.bytes ?? 0) + ' B'}</small>`;
    b.onclick = () => selectVersion(v);
    fpVersions.appendChild(b);
  }
}

async function selectVersion(v) {
  fpSelected = v;
  fpRestore.disabled = (v.seq === fpCurrentSeq);
  renderVersionList();
  if (fpDiffBtn.classList.contains('on')) await renderDiff();
  else renderRaw();
}

async function versionContent(seq) {
  if (seq === fpCurrentSeq) return fpCurrent;
  try {
    const j = await (await fetch(`${API}/api/projects/${projectId}/versions?path=${encodeURIComponent(fpPath)}&seq=${seq}`)).json();
    return (j && j.content != null) ? j.content : '';
  } catch { return ''; }
}

function showFpRaw(text) {
  fpCode.innerHTML = '';
  const pre = document.createElement('pre');
  pre.className = 'fpCodeView';
  pre.textContent = text;
  fpCode.appendChild(pre);
}

async function renderRaw() {
  const v = fpSelected || fpVersionsList[0];
  if (!v) return;
  const text = await versionContent(v.seq);
  if (v.deleted && text === '') showFpEmpty('This version deleted the file.');
  else showFpRaw(text);
}

async function renderDiff() {
  if (!fpSelected) { showFpEmpty('Select a previous version to see the diff against the current file.'); return; }
  if (fpSelected.seq === fpCurrentSeq) { showFpEmpty('This is the current version — nothing has changed.'); return; }
  const before = await versionContent(fpSelected.seq);
  const after = await versionContent(fpCurrentSeq);
  fpCode.innerHTML = '';
  const pre = document.createElement('pre');
  pre.className = 'diffView';
  const rows = lineDiff(before, after);
  if (!rows.length) { pre.textContent = '(identical)'; }
  else for (const r of rows) {
    const d = document.createElement('div');
    d.className = r.t === '+' ? 'add' : r.t === '-' ? 'del' : '';
    d.textContent = (r.t === '-' ? '− ' : r.t === '+' ? '+ ' : '  ') + r.x;
    pre.appendChild(d);
  }
  fpCode.appendChild(pre);
}

async function restoreVersion() {
  if (!projectId || !fpSelected || fpSelected.seq === fpCurrentSeq) return;
  const which = fpSelected;
  if (!confirm(`Restore ${fpPath} to version v${which.seq}?${which.deleted ? ' (this will delete the file)' : ''}`)) return;
  try {
    const r = await fetch(`${API}/api/projects/${projectId}/restore-version`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ path: fpPath, seq: which.seq }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    fpPane.hidden = true;
    flashChip(fpPath);
    await selectProject(projectId);
  } catch (e) {
    notify('Restore failed', e.message);
    alert(`⚠ ${e.message}`);
  }
}

/* ---------- Phase 2: project snapshots ---------- */
const snapModal = $('snapModal'), snapList = $('snapList');
let snapBusy = false;

async function loadSnapshots() {
  if (!projectId) return;
  snapList.innerHTML = '<div class="fpEmpty">Loading…</div>';
  const takeBtn = $('snapTake');
  takeBtn.disabled = !canEdit || busy;
  try {
    const list = await (await fetch(`${API}/api/projects/${projectId}/snapshots`)).json();
    snapList.innerHTML = '';
    if (!Array.isArray(list) || !list.length) {
      snapList.innerHTML = '<div class="fpEmpty">No snapshots yet — one is captured automatically after every generation.</div>';
      return;
    }
    for (const s of list) {
      const row = document.createElement('div');
      row.className = 'snap';
      const when = document.createElement('span'); when.className = 'sWhen'; when.textContent = relTime(s.created_at);
      const label = document.createElement('span'); label.className = 'sLabel'; label.textContent = s.label || '(auto)';
      const files = document.createElement('span'); files.className = 'sFiles'; files.textContent = `${s.files} files`;
      const btn = document.createElement('button');
      btn.className = 'chipBtn danger';
      btn.textContent = 'Restore';
      btn.disabled = !canEdit;
      btn.onclick = () => restoreSnapshot(s);
      row.append(when, label, files, btn);
      snapList.appendChild(row);
    }
  } catch (e) {
    snapList.innerHTML = `<div class="fpEmpty">⚠ ${e.message}</div>`;
  }
}

async function takeSnapshot() {
  if (!projectId || snapBusy) return;
  snapBusy = true;
  const btn = $('snapTake');
  btn.disabled = true;
  btn.textContent = 'Capturing…';
  try {
    const r = await fetch(`${API}/api/projects/${projectId}/snapshots`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: '{}',
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    await loadSnapshots();
  } catch (e) {
    notify('Snapshot failed', e.message);
  } finally {
    snapBusy = false;
    btn.disabled = false;
    btn.textContent = 'Take snapshot';
  }
}

async function restoreSnapshot(s) {
  if (!projectId || !confirm(`Restore the project to the snapshot from ${relTime(s.created_at)}?\nAll current files will be reverted to that state.`)) return;
  try {
    snapModal.hidden = true;
    const r = await fetch(`${API}/api/projects/${projectId}/snapshots/${s.id}/restore`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: '{}',
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    await selectProject(projectId);
  } catch (e) {
    notify('Restore failed', e.message);
    alert(`⚠ ${e.message}`);
  }
}

/* ---------- wire up ---------- */
renderTemplates();
$('fpClose').onclick = () => { fpPane.hidden = true; };
fpRawBtn.onclick = async () => { fpRawBtn.classList.add('on'); fpDiffBtn.classList.remove('on'); await renderRaw(); };
fpDiffBtn.onclick = async () => { fpDiffBtn.classList.add('on'); fpRawBtn.classList.remove('on'); await renderDiff(); };
fpRestore.onclick = restoreVersion;
snapModal.addEventListener('click', (e) => { if (e.target === snapModal) snapModal.hidden = true; });
$('snapClose').onclick = () => { snapModal.hidden = true; };
$('snapTake').onclick = takeSnapshot;
$('snapBtn').onclick = () => {
  if (!projectId) { notify('No project open', 'Open or build a project before taking snapshots.'); return; }
  snapModal.hidden = false;
  loadSnapshots();
};
sendBtn.onclick = send;
modelSel.addEventListener('change', () => localStorage.setItem('ab.model', modelSel.value));
$('newBtn').onclick = () => { if (!busy) resetToNew(); };
$('refreshBtn').onclick = () => refreshPreview(true);
$('openBtn').onclick = () => {
  if (!projectId) return;
  if (previewQuarantined) {
    notify('Preview disabled', 'The page is quarantined (freeze risk) and can\'t be opened yet — ask the AI to fix it first.');
    return;
  }
  window.open(`${API}/preview/${projectId}/`, '_blank');
};

/* ---------- device preview switcher ---------- */
function setDevice(d) {
  const valid = ['desktop', 'tablet', 'mobile'];
  if (!valid.includes(d)) d = 'desktop';
  localStorage.setItem('ab.dev', d);
  const stage = $('previewStage');
  stage.classList.remove('dev-desktop', 'dev-tablet', 'dev-mobile');
  stage.classList.add('dev-' + d);
  document.querySelectorAll('#devSwitcher button').forEach((b) => b.classList.toggle('on', b.dataset.dev === d));
}
document.querySelectorAll('#devSwitcher button').forEach((b) => {
  b.onclick = () => setDevice(b.dataset.dev);
});
setDevice(localStorage.getItem('ab.dev') || 'desktop');

/* ---------- download project files ---------- */
$('dlBtn').onclick = async () => {
  if (!projectId) { notify('No project', 'Open or build a project first.'); return; }
  window.open(`${API}/api/projects/${projectId}/export?download=1`, '_blank');
};

promptBox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});

/* ---------- command palette (⌘K / Ctrl-K) ---------- */
const cmdk = $('cmdk'), cmdkInput = $('cmdkInput'), cmdkList = $('cmdkList');
let cmdkItems = [], cmdkActive = 0;
function cmdkCommands() {
  const cmds = [
    { label: 'New project', hint: 'Start fresh', icon: 'plus', run: () => resetToNew() },
    { label: 'Toggle dark / light mode', hint: 'Appearance', icon: 'sun', run: () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark') },
    { label: 'Refresh preview', hint: 'Reload the app on the right', icon: 'refresh', run: () => refreshPreview(true) },
    { label: 'Open preview in a new tab', hint: 'Full screen', icon: 'external', run: () => { if (projectId) window.open(`${API}/preview/${projectId}/`, '_blank'); } },
    { label: 'Download project files', hint: 'Export everything', icon: 'download', run: () => { if (projectId) window.open(`${API}/api/projects/${projectId}/export?download=1`, '_blank'); } },
    { label: 'Snapshots', hint: 'Roll back in time', icon: 'clock', run: () => $('snapBtn').click() },
    { label: 'Cloud terminal', hint: 'Run commands', icon: 'terminal', run: () => $('termBtn').click() },
    { label: 'Build plan', hint: 'Toggle the plan panel', icon: 'checklist', run: () => $('planBtn').click() },
    { label: 'Teams', hint: 'Share and build together', icon: 'users', run: () => $('teamsBtn').click() },
    { label: 'Install the CLI', hint: 'Build from your terminal', icon: 'terminal', run: () => { installModal.hidden = false; } },
    { label: 'Settings', hint: 'Appearance and account', icon: 'gear', run: () => { settingsModal.hidden = false; } },
    { label: 'Discover apps', hint: 'See what others built', icon: 'compass', run: () => { location.href = 'discover.html'; } },
    { label: 'Forum', hint: 'Discuss and share', icon: 'chat', run: () => { location.href = 'forum.html'; } },
    { label: 'Sign out', hint: sessName() || 'Account', icon: 'external', run: () => { const so = $('menuSignout'); if (so) so.click(); } },
  ];
  if (projectId) {
    cmds.push({ label: 'Rename this project', hint: projName.textContent, icon: 'code', run: doRename });
    cmds.push({ label: 'Delete this project', hint: 'Cannot be undone', icon: 'trash', run: () => $('delBtn').click() });
  }
  for (const t of PROMPT_TEMPLATES) {
    cmds.push({ label: 'Start: ' + t.label, hint: 'Prompt template', icon: 'wand', run: () => { cmdkClose(); promptBox.value = t.prompt; promptBox.focus(); } });
  }
  document.querySelectorAll('#projectList .proj').forEach((p) => {
    cmds.push({ label: p.textContent.trim().replace(/\s*·$/, ''), hint: 'Open project', icon: 'folder', run: () => p.click() });
  });
  return cmds;
}
function renderCmdk() {
  if (!cmdkItems.length) { cmdkList.innerHTML = '<div class="cmdkEmpty">No matches</div>'; return; }
  cmdkList.innerHTML = '';
  cmdkItems.forEach((c, i) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'cmdkItem' + (i === cmdkActive ? ' sel' : '');
    const label = document.createElement('span');
    label.textContent = c.label;
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = c.hint || '';
    row.append(ic(c.icon), label, hint);
    row.onmousedown = (e) => { e.preventDefault(); cmdkActive = i; runCmdk(); };
    row.onmousemove = () => { if (cmdkActive !== i) { cmdkActive = i; renderCmdk(); } };
    cmdkList.appendChild(row);
  });
}
function runCmdk() {
  const c = cmdkItems[cmdkActive];
  if (!c) return;
  cmdkClose();
  try { c.run(); } catch (e) { notify('Command failed', e.message); }
}
function cmdkOpen() {
  if (!cmdk) return;
  cmdk.hidden = false;
  cmdkInput.value = '';
  cmdkItems = cmdkCommands();
  cmdkActive = 0;
  renderCmdk();
  cmdkInput.focus();
}
function cmdkClose() { if (cmdk) cmdk.hidden = true; }
if (cmdk) {
  $('cmdkBtn').addEventListener('click', cmdkOpen);
  cmdk.addEventListener('click', (e) => { if (e.target === cmdk) cmdkClose(); });
  cmdkInput.addEventListener('input', () => {
    const q = cmdkInput.value.toLowerCase();
    cmdkItems = cmdkCommands().filter((c) =>
      !q || c.label.toLowerCase().includes(q) || (c.hint || '').toLowerCase().includes(q));
    cmdkActive = 0;
    renderCmdk();
  });
  cmdkInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); cmdkActive = Math.min(cmdkItems.length - 1, cmdkActive + 1); renderCmdk(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cmdkActive = Math.max(0, cmdkActive - 1); renderCmdk(); }
    else if (e.key === 'Enter') { e.preventDefault(); runCmdk(); }
    else if (e.key === 'Escape') { cmdkClose(); }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); cmdk.hidden ? cmdkOpen() : cmdkClose(); }
  });
}

mountIcons(document);
loadMeta();
loadProjects(true);

// deep-link: /index.html?project=<id> (used after Remix)
const wanted = new URLSearchParams(location.search).get('project');
if (wanted) selectProject(wanted);
else resetToNew();

/* ---------- mobile drawer: swipe from left edge (or tap ☰) for history ---------- */
const sidebar = $('sidebar'), scrim = $('scrim'), menuBtn = $('menuBtn');
function setDrawer(open) {
  sidebar.classList.toggle('open', open);
  scrim.hidden = !open;
}
menuBtn.onclick = () => setDrawer(!sidebar.classList.contains('open'));
scrim.onclick = () => setDrawer(false);

let edgeX = null;
document.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  edgeX = t.clientX < 28 ? t.clientX : null;
}, { passive: true });
document.addEventListener('touchmove', (e) => {
  if (edgeX === null) return;
  const t = e.touches[0];
  if (t.clientX - edgeX > 56) { setDrawer(true); edgeX = null; }
}, { passive: true });
document.addEventListener('touchend', () => { edgeX = null; }, { passive: true });
document.addEventListener('touchcancel', () => { edgeX = null; }, { passive: true });

/* ---------- cloud terminal panel ---------- */
const termPane = $('termPane'), termBody = $('termBody'), termInput = $('termInput'),
  termStatus = $('termStatus');
let termEnabled = null;

function termLine(text, cls) {
  const pre = document.createElement('pre');
  pre.className = 'termLine ' + (cls || '');
  pre.textContent = text;
  termBody.appendChild(pre);
  termBody.scrollTop = termBody.scrollHeight;
  return pre;
}

async function refreshTermStatus() {
  try {
    const r = await fetch(API + '/api/terminal/status', { headers: authHeaders() });
    const j = await r.json();
    termEnabled = Boolean(j.enabled);
    termStatus.textContent = termEnabled ? 'online' : 'offline';
    termStatus.classList.toggle('on', !!termEnabled);
  } catch { termStatus.textContent = 'offline'; }
}

async function termRun() {
  const cmd = termInput.value.trim();
  if (!cmd || termEnabled === false) return;
  termInput.value = '';
  const p = projectId; // current project (may be empty pre-creation)
  termLine('$ ' + cmd, 'cmd');
  const t0 = performance.now();
  try {
    const r = await fetch(API + '/api/terminal/exec', {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ pid: p || 'root', cmd }),
    });
    const j = await r.json();
    if (j.output) termLine(j.output.replace(/\s+$/, ''), 'out');
    termLine(`[exit ${j.code == null ? '-' : j.code}] ${j.error ? j.error : Math.round(performance.now() - t0) + 'ms'}`, 'meta');
  } catch (e) {
    termLine('error: ' + String(e.message || e), 'meta');
  }
}

$('termBtn').onclick = () => { termPane.hidden = !termPane.hidden; if (!termPane.hidden) termBody.scrollTop = termBody.scrollHeight; };
$('termClose').onclick = () => { termPane.hidden = true; };
termInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') termRun(); });
$('termRun').onclick = termRun;

window.__termLine = termLine; // SSE handler pushes generator CMD runs here

// If the page was reloaded (or closed) while a background build was running,
// quietly re-attach once it finishes so the preview and project list catch up.
async function resumeStoredRun() {
  let runId = null;
  try { runId = localStorage.getItem('ab.run.last'); } catch {}
  if (!runId) return;
  try {
    const r = await fetch(`${API}/api/chat/stream/${encodeURIComponent(runId)}?since=0`, { headers: authHeaders() });
    if (!r.ok) { try { localStorage.removeItem('ab.run.last'); } catch {} return; }
    notify('Build still running', 'A previous build is still running in the background — reconnecting. Your project is safe.');
    const dec = new TextDecoder(); let buf = '';
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 2);
        if (!line.startsWith('data:')) continue;
        let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
        if (ev.type === 'done') {
          try { localStorage.removeItem('ab.run.last'); } catch {}
          notify('Build finished', 'The background build completed — the preview and project are up to date.');
          refreshPreview(true); loadProjects(); loadCredits();
        }
      }
    }
  } catch { /* leave the marker; a later load can try again */ }
}

refreshTermStatus();
resumeStoredRun();
