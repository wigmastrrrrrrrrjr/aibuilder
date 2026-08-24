/* aibuilder SPA — no build step, vanilla JS */
'use strict';

const $ = (id) => document.getElementById(id);
// When hosted on GitHub Pages the backend lives on Cloudflare Workers;
// same-origin (local Node or Workers assets hosting) needs no prefix.
const WORKER_ORIGIN = 'https://aibuilder.wigmastrrrrrrrrjr.deno.net';
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

/* ---------- strip <<<FILE:...>>> blocks from streamed output ---------- */
function BlockFilter() {
  let buf = '', state = 0; // 0=out 1=header 2=in-file
  this.push = function (chunk) {
    buf += chunk;
    let out = '';
    for (;;) {
      if (state === 0) {
        const i = buf.indexOf('<<<FILE:');
        if (i === -1) {
          const keep = Math.max(0, buf.length - 8);
          out += buf.slice(0, keep); buf = buf.slice(keep);
          break;
        }
        out += buf.slice(0, i);
        buf = buf.slice(i + 8); state = 1;
      } else if (state === 1) {
        const j = buf.indexOf('>>>');
        if (j === -1) { buf = ''; break; }
        buf = buf.slice(j + 3); state = 2;
      } else {
        const k = buf.indexOf('<<<END>>>');
        if (k === -1) {
          const keep = Math.max(0, buf.length - 8);
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
  return text.replace(/<<<FILE:[^>]*>>>[\s\S]*?(<<<END>>>|$)/g, '').trim();
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
  return h;
}

function refreshKeyBtn() {
  $('keyBtn').classList.toggle('active', Boolean(ownKey()));
  $('keyBtn').textContent = ownKey() ? '🔑 Own key active' : '🔑 Own API key';
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
  const list = await (await fetch(`${API}/api/projects`)).json();
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
  publishBtn.textContent = data.project.published ? 'Unpublish' : 'Publish';
  $('delBtn').hidden = false;
  if (data.project.model && [...modelSel.options].some(o => o.value === data.project.model)) {
    modelSel.value = data.project.model;
  }
  messagesEl.innerHTML = '';
  for (const m of data.messages) {
    if (m.role === 'user') addUserBubble(m.content);
    else addAiBubble(stripBlocks(m.content));
  }
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
  publishBtn.textContent = 'Publish';
  $('delBtn').hidden = true;
  messagesEl.innerHTML = `
    <div class="empty"><h1>Build an app by describing it</h1>
    <p>Try: “a todo app with priorities and due dates”,<br>
       “landing page for my bakery with an order form”,<br>
       “kanban board with drag and drop”.</p></div>`;
  setChips([]);
  frame.src = 'about:blank';
  watchProject(null);
  promptBox.focus();
}

/* ---------- co-build: live sync when others change this project ---------- */
let liveSrc = null;
function watchProject(pid) {
  if (liveSrc) { liveSrc.close(); liveSrc = null; }
  if (!pid || typeof EventSource === 'undefined') return;
  liveSrc = new EventSource(`${API}/api/projects/${pid}/live/build/stream`);
  liveSrc.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type !== 'refresh' || m.sid === SID) return;
    if (!busy) selectProject(pid);
  };
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
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);

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
        } else if (ev.type === 'error') {
          throw new Error(ev.message);
        } else if (ev.type === 'done') {
          addAiBubble((displayText + filter.drain()).trim());
        }
      }
    }
  } catch (e) {
    addAiBubble(`⚠ ${e.message}`);
  } finally {
    activityEl.hidden = true;
    busy = false; sendBtn.disabled = false;
    promptBox.focus();
    loadProjects();
  }
}

/* ---------- publish / upload / delete ---------- */
publishBtn.addEventListener('click', async () => {
  if (!projectId || busy) return;
  const isPub = publishBtn.textContent === 'Unpublish';
  let description;
  if (!isPub) description = prompt('Short description shown on the Discover page:') || '';
  try {
    const r = await fetch(`${API}/api/projects/${projectId}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publish: !isPub, description }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const updated = await r.json();
    publishBtn.textContent = updated.published ? 'Unpublish' : 'Publish';
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
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: guessName }),
    })).json();

    const fd = new FormData();
    for (const f of picked.slice(0, 300)) {
      fd.append('files', f, f.webkitRelativePath || f.name);
    }
    const res = await fetch(`${API}/api/projects/${p.id}/upload`, { method: 'POST', body: fd });
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
  await fetch(`${API}/api/projects/${projectId}`, { method: 'DELETE' });
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
