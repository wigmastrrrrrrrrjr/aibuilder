/* aibuilder SPA — no build step, vanilla JS */
'use strict';

const $ = (id) => document.getElementById(id);
// When hosted on GitHub Pages the backend lives on Cloudflare Workers;
// same-origin (local Node or Workers assets hosting) needs no prefix.
const WORKER_ORIGIN = 'https://aibuilderapi.csomeone301.workers.dev';
const API = location.hostname.endsWith('github.io') ? WORKER_ORIGIN : '';
const messagesEl = $('messages'), promptBox = $('promptBox'), sendBtn = $('sendBtn');
const activityEl = $('activity'), activityText = $('activityText'), rawStream = $('rawStream');
const fileChips = $('fileChips'), frame = $('previewFrame'), projName = $('projName');
const modelSel = $('modelSel'), publishBtn = $('publishBtn');

let projectId = null;
let busy = false;
let dots = 0;
const SID = (() => {
  let s = localStorage.getItem('ab.sid');
  if (!s) { s = Math.random().toString(36).slice(2, 10); localStorage.setItem('ab.sid', s); }
  return s;
})();
let displayText = '';
let defaultModel = 'gpt-oss:120b';

/* ---------- strip generator blocks (FILE/EDIT/DELETE/PLAN) from output ---------- */
function BlockFilter() {
  let buf = '', state = 0; // 0=out 1=header 2=in-block
  this.push = function (chunk) {
    buf += chunk;
    let out = '';
    for (;;) {
      if (state === 0) {
        const i = buf.search(/<<<(FILE|EDIT|DELETE|PLAN):?/);
        if (i === -1) {
          const keep = Math.max(0, buf.length - 12);
          out += buf.slice(0, keep); buf = buf.slice(keep);
          break;
        }
        out += buf.slice(0, i);
        buf = buf.slice(i);
        const j = buf.indexOf('>>>');
        if (j === -1) { buf = ''; break; }
        buf = buf.slice(j + 3); state = 1;
      } else if (state === 1) state = 2;
      else {
        const k = buf.indexOf('<<<END>>>');
        if (k === -1) {
          const keep = Math.max(0, buf.length - 9);
          buf = buf.slice(keep); break;
        }
        buf = buf.slice(k + 9); state = 0;
      }
    }
    return out;
  };
  this.drain = function () {
    const rest = state === 0 ? buf : '';
    buf = ''; return rest;
  };
}

function stripBlocks(text) {
  return String(text || '')
    .replace(/<<<(FILE|EDIT|DELETE|PLAN)[^>]*>>>[\s\S]*?(<<<END>>>|$)/g, '')
    .trim();
}

/* ---------- bubbles & UI helpers ---------- */
function addUserBubble(text) {
  const d = document.createElement('div');
  d.className = 'msg user'; d.textContent = text;
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
    s.className = 'chip' + (fresh.has(f.path || f) ? ' new' : '');
    s.textContent = typeof f === 'string' ? f : f.path;
    fileChips.appendChild(s);
  }
}

function refreshPreview(bust) {
  if (!projectId) return;
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

/* ---------- reCAPTCHA v3 ---------- */
async function recaptchaToken(action) {
  try {
    if (!window.grecaptcha || !window.grecaptcha.execute) return '';
    return await window.grecaptcha.execute('6LddVZotAAAAAKhQLajTiyD6frXUZeWG5nBRUCbw', { action });
  } catch { return ''; }
}
let authMode = 'signup';
let pendingVerifyUser = null;   // username awaiting email verification
let pendingTfaSession = null;   // sessionId awaiting 2FA

async function doAuth(e) {
  e.preventDefault();
  const username = $('authUser').value.trim();
  const password = $('authPass').value;
  const email = $('authEmail').value.trim();
  $('authErr').textContent = '';
  $('authGo').disabled = true;
  const finish = () => { $('authGo').disabled = false; };

  try {
    if (!username || !password) throw new Error('enter a username and password');

    if (authMode === 'signup') {
      if (!email) throw new Error('email required');
      const captcha = await recaptchaToken('signup');
      const r = await fetch(`${API}/api/auth/signup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(captcha ? { 'x-recaptcha-token': captcha } : {}) },
        body: JSON.stringify({ username, password, email }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `server error ${r.status}`);

      // Email verification required
      if (d.verifyRequired) {
        pendingVerifyUser = d.username;
        $('authForm').hidden = true;
        $('verifyForm').hidden = false;
        $('verifySub').textContent = d.message || 'We sent a 6-digit code to verify your email.';
        $('verifyCode').value = '';
        $('verifyCode').focus();
        finish();
        return;
      }
    }

    if (authMode === 'login') {
      const captcha = await recaptchaToken('login');
      const r = await fetch(`${API}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(captcha ? { 'x-recaptcha-token': captcha } : {}) },
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

      try {
        localStorage.setItem('ab.tok', d.token);
        localStorage.setItem('ab.user', d.username);
      } catch { throw new Error('browser storage is blocked'); }
      $('authErr').textContent = '';
      location.reload();
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
  $('authEmail').hidden = authMode !== 'signup';
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
   // No session token – continue as guest (auth UI disabled)
   $('authGate').hidden = true;
 } else {
   whoBtn.hidden = false;
   const ic = document.createElement('span'); ic.className = 'ms'; ic.textContent = 'person';
   whoBtn.append(ic, document.createTextNode(sessName()));
 }
whoBtn.addEventListener('click', async () => {
  if (!confirm(`Log out of ${sessName()}?`)) return;
  try {
    await fetch(`${API}/api/auth/logout`, { method: 'POST', headers: authHeaders() });
  } catch { /* ignore */ }
  try {
    localStorage.removeItem('ab.tok');
    localStorage.removeItem('ab.user');
  } catch { /* ignore */ }
  location.href = 'index.html';
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

/* ---------- data loading ---------- */
async function loadMeta() {
  try {
    const m = await (await fetch(`${API}/api/meta`)).json();
    if (m.model) defaultModel = m.model;
    loadModels();
  } catch { /* ignore */ }
  refreshKeyBtn();
}

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
  // sidebar = my projects (legacy owner-less ones stay visible for compat)
  const me = sessName();
  const list = all.filter((p) => !p.owner || p.owner === me);
  const el = $('projectList'); el.innerHTML = '';
  for (const p of list) {
    const d = document.createElement('div');
    d.className = 'proj' + (p.id === projectId ? ' active' : '');
    d.textContent = p.name + (p.published ? ' ·' : '');
    d.title = p.name + (p.published ? ' (published)' : '');
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
  $('delBtn').hidden = !mine;
  $('renameBtn').hidden = !mine;
  if (data.project.model && [...modelSel.options].some(o => o.value === data.project.model)) {
    modelSel.value = data.project.model;
  }
  messagesEl.innerHTML = '';
  for (const m of data.messages) {
    if (m.role === 'user') addUserBubble(m.content);
    else addAiBubble(stripBlocks(m.content));
  }
  let plan = [];
  try { plan = typeof data.project.plan === 'string' ? JSON.parse(data.project.plan) : (data.project.plan || []); } catch { plan = []; }
  renderPlan(plan);
  setChips(data.files);
  refreshPreview(false);
  loadProjects();
  watchProject(pid);
}

function resetToNew() {
  projectId = null;
  projName.textContent = 'New app';
  document.title = 'aibuilder';
  publishBtn.disabled = true;
  setPub(false);
  $('delBtn').hidden = true;
  $('renameBtn').hidden = true;
  messagesEl.innerHTML = `
    <div class="empty"><h1>Build an app by describing it</h1>
    <p>Try: “a todo app with priorities and due dates”,<br>
       “landing page for my bakery with an order form”,<br>
       “kanban board with drag and drop”.</p></div>`;
  setChips([]);
  frame.src = 'about:blank';
  renderPlan([]);
  watchProject(null);
  promptBox.focus();
}

/* ---------- plan sidebar ---------- */
function renderPlan(items) {
  const list = $('planList'), pane = $('planPane'), btn = $('planBtn');
  list.innerHTML = '';
  for (const it of items || []) {
    const li = document.createElement('li');
    const mark = document.createElement('span');
    mark.className = 'ms mark' + (it.done ? ' done' : '');
    mark.textContent = it.done ? 'check_circle' : 'radio_button_unchecked';
    li.appendChild(mark);
    li.appendChild(document.createTextNode(it.text));
    list.appendChild(li);
  }
  btn.hidden = !(items && items.length);
  $('planCount').textContent = items && items.length
    ? `${items.filter(i => i.done).length}/${items.length}` : '';
  if (!items || !items.length) { pane.hidden = true; return; }
  // auto-open on desktop once a plan exists
  if (window.innerWidth > 1100) pane.hidden = false;
}
$('planBtn').addEventListener('click', () => {
  const pane = $('planPane');
  pane.hidden = !pane.hidden;
});
$('planClose').addEventListener('click', () => { $('planPane').hidden = true; });

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
    send.innerHTML = '<span class="ms">smart_toy</span> Send to AI';
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
  }).subscribe();
}

/* ---------- chat streaming ---------- */
async function send() {
  const message = promptBox.value.trim();
  if (!message || busy) return;
  busy = true; sendBtn.disabled = true;
  promptBox.value = '';

  const emptyHero = messagesEl.querySelector('.empty');
  if (emptyHero) emptyHero.remove();
  addUserBubble(message);

  displayText = ''; rawStream.textContent = '';
  const filter = new BlockFilter();
  dots = 0;
  activityText.textContent = 'thinking…';
  activityEl.hidden = false;

  const chosen = currentModel();
  localStorage.setItem('ab.model', chosen);

  let chipFiles = [];
  let doneReceived = false;
  let previewTimer = null;
  const schedulePreview = () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => refreshPreview(true), 500);
  };

  try {
    const res = await fetch(`${API}/api/chat`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        projectId, message, model: chosen,
        apiKey: ownKey() || undefined,
        sid: SID,
      }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      const msg = d.error || `HTTP ${res.status}`;
      if (res.status === 429) throw new Error('Whoopsie! The server hit its head — you were using a little too much. Come back later!');
      if (res.status === 401) throw new Error('Whoopsie! Sign up required — create an account to keep building.');
      if (res.status === 403) throw new Error('Whoopsie! Access denied — you don\'t have permission for this.');
      if (res.status === 500) throw new Error('Whoopsie! The server hit its head — something went wrong. Try again!');
      throw new Error(msg);
    }

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

        if (ev.type === 'meta') {
          if (!projectId) projectId = ev.projectId;
          projName.textContent = message.slice(0, 60);
          activityText.textContent = `${ev.model} is building…`;
        } else if (ev.type === 'think') {
          rawStream.textContent = (rawStream.textContent + ev.v).slice(-9000);
          rawStream.scrollTop = rawStream.scrollHeight;
          activityText.textContent = 'thinking' + '.'.repeat(1 + (dots = (dots + 1) % 4));
        } else if (ev.type === 'token') {
          rawStream.textContent = (rawStream.textContent + ev.v).slice(-9000);
          rawStream.scrollTop = rawStream.scrollHeight;
          displayText += ev.v;
        } else if (ev.type === 'file') {
          chipFiles.push(ev.path);
          setChips(chipFiles, chipFiles);
          activityText.textContent = `wrote ${ev.path}`;
          schedulePreview();
        } else if (ev.type === 'edit') {
          chipFiles.push(ev.path);
          setChips(chipFiles, chipFiles);
          activityText.textContent = `edited ${ev.path}`;
          schedulePreview();
        } else if (ev.type === 'delete') {
          chipFiles = chipFiles.filter((p) => p !== ev.path);
          setChips(chipFiles);
          activityText.textContent = `deleted ${ev.path}`;
          schedulePreview();
        } else if (ev.type === 'plan') {
          renderPlan(ev.items || []);
        } else if (ev.type === 'name') {
          projName.textContent = ev.name;
          document.title = `${ev.name} — aibuilder`;
          loadProjects();
        } else if (ev.type === 'delegate') {
          activityText.textContent = `sub-agent on ${ev.path}…`;
        } else if (ev.type === 'subagent') {
          chipFiles.push(ev.path);
          setChips(chipFiles, chipFiles);
          activityText.textContent = `sub-agent wrote ${ev.path}`;
          schedulePreview();
        } else if (ev.type === 'refactor') {
          $('refactorBar').hidden = false;
          activityText.textContent = 'refactoring code structure…';
        } else if (ev.type === 'warn') {
          notify('Generator warning', ev.message);
        } else if (ev.type === 'error') {
          addAiBubble(`⚠ ${ev.message}`);
          notify('Generation error', ev.message);
        } else if (ev.type === 'done') {
          doneReceived = true;
          $('refactorBar').hidden = true;
          addAiBubble((displayText + filter.drain()).trim());
          if ((ev.edited || []).length || (ev.deleted || []).length) {
            const bits = [];
            if (ev.files?.length) bits.push(`${ev.files.length} written`);
            if (ev.edited.length) bits.push(`${ev.edited.length} edited`);
            if (ev.deleted.length) bits.push(`${ev.deleted.length} deleted`);
            addAiBubble(`✓ ${bits.join(', ')}`);
          }
        }
      }
    }
    // Stream ended without a done event (server crashed / connection dropped)
    if (!doneReceived && displayText.trim()) {
      addAiBubble((displayText + filter.drain()).trim());
      notify('Stream interrupted', 'Connection ended before the model finished responding.');
    }
  } catch (e) {
    addAiBubble(`⚠ ${e.message}`);
    notify('Generation failed', e.message);
  } finally {
    activityEl.hidden = true;
    $('refactorBar').hidden = true;
    busy = false; sendBtn.disabled = false;
    promptBox.focus();
    loadProjects();
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

  const firstRel = picked[0].webkitRelativePath || picked[0].name;
  const guessName = firstRel.includes('/') ? firstRel.split('/')[0] : firstRel.replace(/\.[^.]+$/, '');

  busy = true;
  try {
    const p = await (await fetch(`${API}/api/projects`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name: guessName }),
    })).json();

    const fd = new FormData();
    for (const f of picked.slice(0, 300)) {
      fd.append('files', f, f.webkitRelativePath || f.name);
    }
    const res = await fetch(`${API}/api/projects/${p.id}/upload`, {
      method: 'POST',
      headers: authHeaders(),
      body: fd,
    });
    if (!res.ok) throw new Error(`upload failed: HTTP ${res.status}`);
    const out = await res.json();
    if (out.skipped.length) console.warn('skipped:', out.skipped);
    resetToNew();
    await selectProject(p.id);
  } catch (err) {
    alert(`⚠ ${err.message}`);
  } finally {
    busy = false;
  }
});

$('delBtn').addEventListener('click', async () => {
  if (!projectId || !confirm('Delete this project?')) return;
  await fetch(`${API}/api/projects/${projectId}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  await loadProjects(); resetToNew();
});

/* ---------- wire up ---------- */
sendBtn.onclick = send;
modelSel.addEventListener('change', () => localStorage.setItem('ab.model', modelSel.value));
$('newBtn').onclick = () => { if (!busy) resetToNew(); };
$('refreshBtn').onclick = () => refreshPreview(true);
$('openBtn').onclick = () => projectId && window.open(`${API}/preview/${projectId}/`, '_blank');
promptBox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});

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
