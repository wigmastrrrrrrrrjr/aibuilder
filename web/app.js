/* aibuilder SPA — no build step, vanilla JS */
'use strict';

const $ = (id) => document.getElementById(id);
// When hosted on GitHub Pages the backend lives on Cloudflare Workers;
// same-origin (local Node or Workers assets hosting) needs no prefix.
const WORKER_ORIGIN = 'https://aibuilderapi.csomeone301.workers.dev';
const API = location.hostname === 'localhost' || location.hostname === '127.0.0.1' ? '' : WORKER_ORIGIN;
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
  let buf = '';
  let depth = 0;
  this.push = function (chunk) {
    buf += chunk;
    let out = '';
    for (;;) {
      const i = buf.indexOf('<<<');
      if (i === -1) {
        const keep = Math.max(0, buf.length - (depth > 0 ? 9 : 2));
        if (keep > 0) {
          if (depth === 0) out += buf.slice(0, keep);
          buf = buf.slice(keep);
        }
        break;
      }
      let start = i;
      if (i > 0 && depth === 0) out += buf.slice(0, i);
      else if (i > 0) { buf = buf.slice(i); start = 0; }
      const e = buf.indexOf('>>>', start);
      if (e === -1) { buf = buf.slice(start); break; }
      const hdr = buf.slice(start + 3, e).trim().toUpperCase();
      const kind = hdr.split(':')[0];
      buf = buf.slice(e + 3);
      if (kind === 'END' || kind === 'BATCHEND') {
        depth = Math.max(0, depth - 1);
      } else if (['FILE', 'EDIT', 'PLAN', 'DELEGATE', 'RUN', 'ASSET', 'SEED', 'BATCH'].includes(kind)) {
        depth++;
      }
    }
    return out;
  };
  this.drain = function () {
    if (depth > 0) { buf = ''; return ''; }
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
  openTeams();
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
  refreshPreview(false);
  loadProjects();
  watchProject(pid);
  startCursors(pid);
  refreshLive(pid);
}

function resetToNew() {
  projectId = null;
  canEdit = false;
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
  }).on('broadcast', { event: 'msg' }, (payload) => {
    const m = payload.payload || {};
    if (m.sid === SID) return;
    refreshLive(pid);
    addUserBubble(String(m.message || ''), whoLabel(m.user));
  }).subscribe();
}

/* ---------- teambuild: live presence (who is building now) ---------- */
let liveTimer = null;
async function refreshLive(pid) {
  const badge = $('liveBadge');
  clearTimeout(liveTimer);
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
  liveTimer = setInterval(() => refreshLive(pid), 20000);
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
function mdHtml(src) {
  let s = escHtml(src);
  s = s.replace(/```[a-zA-Z0-9]*\n?([\s\S]+?)\n?```/g, '<pre class="fence"><code>$1</code></pre>');
  s = s.replace(/(^|[^\w`])`([^`\n]{1,160})`/g, '$1<code>$2</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  s = s.replace(/^#{1,3}\s*(.*)$/gm, '<h4>$1</h4>');
  const lines = s.split('\n');
  let html = '', inUl = false;
  for (const ln of lines) {
    const l = ln.trim();
    if (/^[-*]\s+/.test(l)) {
      if (!inUl) { html += '<ul>'; inUl = true; }
      html += '<li>' + l.replace(/^[-*]\s+/, '') + '</li>';
    } else {
      if (inUl) { html += '</ul>'; inUl = false; }
      html += (l ? l : '<br>');
    }
  }
  if (inUl) html += '</ul>';
  return html;
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
      prose.innerHTML = mdHtml(this.full);
      scrollBottom();
    },
    card(html) {
      const c = document.createElement('div');
      c.className = 'actCard';
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
  runok: (n) => '<span class="acIco">R</span><span class="acBody"><b>ran</b> ' + escHtml(n) + '</span>',
  runbad: (n, err) => '<span class="acIco">R</span><span class="acBody"><b>ran</b> ' + escHtml(n) + '<em> — ' + escHtml(err) + '</em></span>',
  seed: (c, n) => '<span class="acIco">DB</span><span class="acBody"><b>seeded</b> “' + escHtml(c) + '” with ' + n + ' row' + (n === 1 ? '' : 's') + '</span>',
  sub: (p) => '<span class="acIco">S</span><span class="acBody"><b>sub-agent</b> finished ' + escHtml(p) + '</span>',
  plan: () => '<span class="acIco">P</span><span class="acBody"><b>plan</b> updated</span>',
  warn: (m) => '<span class="acIco warn">!</span><span class="acBody">' + escHtml(m) + '</span>',
  summary: (bits) => '<span class="acIco">OK</span><span class="acBody">' + bits + '</span>',
};

/* ---------- chat streaming ---------- */
async function send() {
  const message = promptBox.value.trim();
  if (!message || busy) return;
  busy = true; sendBtn.disabled = true;
  promptBox.value = '';

  const emptyHero = messagesEl.querySelector('.empty');
  if (emptyHero) emptyHero.remove();
  addUserBubble(message, whoLabel(sessName()));
  if (liveChannel) {
    liveChannel.send({ type: 'broadcast', event: 'msg', payload: { user: sessName(), message, sid: SID } }).then(() => {}).catch(() => {});
  }

  displayText = ''; rawStream.textContent = ''; rawStream.hidden = true;
  const filter = new BlockFilter();
  let aiMsg = null;
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
          aiMsg = makeAiMsg(ev.model);
          activityText.textContent = `${ev.model} is working…`;
        } else if (ev.type === 'think') {
          dots = (dots + 1) % 4;
          if (aiMsg) aiMsg.setStatus('analyzing' + '.'.repeat(1 + dots));
          activityText.textContent = 'Analyzing' + '.'.repeat(1 + dots);
        } else if (ev.type === 'token') {
          displayText += ev.v;
          if (aiMsg) {
            const clean = filter.push(ev.v);
            if (clean) aiMsg.append(clean);
          }
        } else if (ev.type === 'file') {
          chipFiles.push(ev.path);
          setChips(chipFiles, chipFiles);
          flashChip(ev.path);
          if (aiMsg) aiMsg.card(actCards.w(ev.path));
          activityText.textContent = `Generated ${ev.path}`;
          schedulePreview();
        } else if (ev.type === 'edit') {
          chipFiles.push(ev.path);
          setChips(chipFiles, chipFiles);
          flashChip(ev.path);
          if (aiMsg) aiMsg.card(actCards.e(ev.path));
          activityText.textContent = `Updated ${ev.path}`;
          schedulePreview();
        } else if (ev.type === 'delete') {
          chipFiles = chipFiles.filter((p) => p !== ev.path);
          setChips(chipFiles);
          if (aiMsg) aiMsg.card(actCards.d(ev.path));
          activityText.textContent = `Removed ${ev.path}`;
          schedulePreview();
        } else if (ev.type === 'rename') {
          if (aiMsg) aiMsg.card(actCards.r(ev.from, ev.to, ev.refs || 0));
          chipFiles = chipFiles.map((p) => (p === ev.from ? ev.to : p));
          if (!chipFiles.includes(ev.to)) chipFiles.push(ev.to);
          setChips(chipFiles, chipFiles);
          activityText.textContent = `Renamed ${ev.from} → ${ev.to}`;
          schedulePreview();
        } else if (ev.type === 'asset') {
          if (aiMsg) aiMsg.card(actCards.a(ev.path));
          activityText.textContent = `Saved asset ${ev.path}`;
          schedulePreview();
        } else if (ev.type === 'run') {
          if (aiMsg) aiMsg.card(ev.ok ? actCards.runok(ev.name) : actCards.runbad(ev.name, ev.error || ''));
          activityText.textContent = ev.ok ? `Ran ${ev.name}` : `Run failed: ${ev.name}`;
        } else if (ev.type === 'seed') {
          if (aiMsg) aiMsg.card(actCards.seed(ev.collection, ev.count || 0));
          activityText.textContent = `Seeded ${ev.collection} (${ev.count || 0} rows)`;
          schedulePreview();
        } else if (ev.type === 'plan') {
          renderPlan(ev.items || []);
          if (aiMsg) aiMsg.card(actCards.plan());
        } else if (ev.type === 'name') {
          projName.textContent = ev.name;
          document.title = `${ev.name} — aibuilder`;
          loadProjects();
        } else if (ev.type === 'delegate') {
          if (aiMsg) aiMsg.setStatus(`delegating ${ev.path}…`);
          activityText.textContent = `Delegating ${ev.path} to a sub-agent…`;
        } else if (ev.type === 'subagent') {
          chipFiles.push(ev.path);
          setChips(chipFiles, chipFiles);
          flashChip(ev.path);
          if (aiMsg) aiMsg.card(actCards.sub(ev.path));
          activityText.textContent = `Sub-agent completed ${ev.path}`;
          schedulePreview();
        } else if (ev.type === 'refactor') {
          $('refactorBar').hidden = false;
          activityText.textContent = 'Restructuring code…';
          if (aiMsg) aiMsg.setStatus('restructuring…');
        } else if (ev.type === 'warn') {
          notify('Generator warning', ev.message);
          if (aiMsg) aiMsg.card(actCards.warn(ev.message || ''));
        } else if (ev.type === 'error') {
          if (aiMsg) aiMsg.setStatus('error');
          addAiBubble(`⚠ ${ev.message}`);
          notify('Generation error', ev.message);
        } else if (ev.type === 'done') {
          doneReceived = true;
          $('refactorBar').hidden = true;
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
            if (bits.length) aiMsg.card(actCards.summary(bits.join(' · ')));
          } else {
            addAiBubble((displayText + filter.drain()).trim());
          }
          loadCredits();
        }
      }
    }
    // Stream ended without a done event (server crashed / connection dropped)
    if (!doneReceived) {
      if (displayText.trim() && !aiMsg) addAiBubble((displayText + filter.drain()).trim());
      if (aiMsg) {
        aiMsg.setStatus('interrupted');
        const rest = filter.drain();
        if (rest.trim()) aiMsg.append(rest);
      }
      if (displayText.trim()) notify('Stream interrupted', 'Connection ended before the model finished responding.');
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
