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
let canEdit = false; // may the signed-in user modify the open project?
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
  const email = $('authEmail').value.trim();
  $('authErr').textContent = '';
  $('authGo').disabled = true;
  const finish = () => { $('authGo').disabled = false; };

  try {
    if (!username || !password) throw new Error('enter a username and password');

    if (authMode === 'signup') {
      if (!email) throw new Error('email required');
      const agree = $('agreeCheck')?.checked;
      if (!agree) throw new Error('you must accept the Terms of Service and Terms of Use to sign up');
      const dob = $('authDob')?.value || '';
      if (!dob) throw new Error('date of birth required (you must be 13 or older)');
      if (!okToSignUp(dob)) throw new Error('you must be 13 or older to use aibuilder (COPPA)');
      const r = await fetch(`${API}/api/auth/signup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password, email, dob }),
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
  $('authEmail').hidden = authMode !== 'signup';
  $('dobRow').hidden = authMode !== 'signup';
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
   const ic = document.createElement('span'); ic.className = 'ms'; ic.textContent = 'person';
   whoBtn.append(ic, document.createTextNode(sessName()));
   loadCredits();
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

// Daily free credits shown in the sidebar footer.
const fmtCredits = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
async function loadCredits() {
  const mb = $('metaBar');
  if (!mb || !sessTok()) return;
  try {
    const r = await fetch(`${API}/api/credits`, { headers: authHeaders() });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j && j.credits) {
      const { left, total } = j.credits;
      mb.textContent = `Credits left today: ${fmtCredits(left)} / ${fmtCredits(total)}`;
    }
  } catch { mb.textContent = ''; }
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
  canEdit = mine;
  snapModal.hidden = true;
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
  canEdit = false;
  snapModal.hidden = true;
  fpPane.hidden = true;
  projName.textContent = 'New app';
  document.title = 'aibuilder';
  publishBtn.disabled = true;
  setPub(false);
  $('delBtn').hidden = true;
  $('renameBtn').hidden = true;
  messagesEl.innerHTML = `
    <div class="empty">
      <div class="emptyMark"><span class="ms">auto_awesome</span></div>
      <h1>Describe it. aibuilder ships it.</h1>
      <p>Type what you want to build and the platform engineers the full app with you —<br>
         a live, editable preview on the right the whole way through.</p>
      <div class="emptySteps">
        <div class="step"><div class="n">01</div><div class="t">Describe</div><div class="s">“A billing dashboard with charts and CSV export.”</div></div>
        <div class="step"><div class="n">02</div><div class="t">Iterate</div><div class="s">Refine with follow-up prompts in the same thread.</div></div>
        <div class="step"><div class="n">03</div><div class="t">Publish</div><div class="s">Ship it to the discovery feed in one click.</div></div>
      </div>
    </div>`;
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
      if (res.status === 429) {
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
          if (!projectId) { projectId = ev.projectId; canEdit = true; }
          projName.textContent = message.slice(0, 60);
          activityText.textContent = `${ev.model} is working…`;
        } else if (ev.type === 'think') {
          rawStream.textContent = (rawStream.textContent + ev.v).slice(-9000);
          rawStream.scrollTop = rawStream.scrollHeight;
          activityText.textContent = 'Analyzing' + '.'.repeat(1 + (dots = (dots + 1) % 4));
        } else if (ev.type === 'token') {
          rawStream.textContent = (rawStream.textContent + ev.v).slice(-9000);
          rawStream.scrollTop = rawStream.scrollHeight;
          displayText += ev.v;
        } else if (ev.type === 'file') {
          chipFiles.push(ev.path);
          setChips(chipFiles, chipFiles);
          flashChip(ev.path);
          activityText.textContent = `Generated ${ev.path}`;
          schedulePreview();
        } else if (ev.type === 'edit') {
          chipFiles.push(ev.path);
          setChips(chipFiles, chipFiles);
          flashChip(ev.path);
          activityText.textContent = `Updated ${ev.path}`;
          schedulePreview();
        } else if (ev.type === 'delete') {
          chipFiles = chipFiles.filter((p) => p !== ev.path);
          setChips(chipFiles);
          activityText.textContent = `Removed ${ev.path}`;
          schedulePreview();
        } else if (ev.type === 'plan') {
          renderPlan(ev.items || []);
        } else if (ev.type === 'name') {
          projName.textContent = ev.name;
          document.title = `${ev.name} — aibuilder`;
          loadProjects();
        } else if (ev.type === 'delegate') {
          activityText.textContent = `Delegating ${ev.path} to a sub-agent…`;
        } else if (ev.type === 'subagent') {
          chipFiles.push(ev.path);
          setChips(chipFiles, chipFiles);
          flashChip(ev.path);
          activityText.textContent = `Sub-agent completed ${ev.path}`;
          schedulePreview();
        } else if (ev.type === 'refactor') {
          $('refactorBar').hidden = false;
          activityText.textContent = 'Restructuring code…';
        } else if (ev.type === 'warn') {
          notify('Generator warning', ev.message);
        } else if (ev.type === 'error') {
          addAiBubble(`⚠ ${ev.message}`);
          notify('Generation error', ev.message);
        } else if (ev.type === 'done') {
          doneReceived = true;
          $('refactorBar').hidden = true;
          addAiBubble((displayText + filter.drain()).trim());
          loadCredits();
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
  const before = await versionContent(fpCurrentSeq);
  const after = await versionContent(fpSelected.seq);
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
fpClose.onclick = () => { fpPane.hidden = true; };
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
