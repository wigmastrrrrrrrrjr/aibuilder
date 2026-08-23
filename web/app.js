/* aibuilder SPA — no build step, vanilla JS */
'use strict';

const $ = (id) => document.getElementById(id);
const messagesEl = $('messages'), promptBox = $('promptBox'), sendBtn = $('sendBtn');
const activityEl = $('activity'), activityText = $('activityText'), rawStream = $('rawStream');
const fileChips = $('fileChips'), frame = $('previewFrame'), projName = $('projName');

let projectId = null;
let busy = false;
let displayText = '';
let dots = 0;

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
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

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
  frame.src = `/preview/${projectId}/` + (bust ? `?t=${Date.now()}` : '');
}

/* ---------- data loading ---------- */
async function loadMeta() {
  try {
    const m = await (await fetch('/api/meta')).json();
    $('metaBar').textContent =
      `${m.model}${m.hasKey ? '' : '  ·  NO API KEY (.env)'}`;
  } catch { /* ignore */ }
}

async function loadProjects(selectPid) {
  const list = await (await fetch('/api/projects')).json();
  const el = $('projectList'); el.innerHTML = '';
  for (const p of list) {
    const d = document.createElement('div');
    d.className = 'proj' + (p.id === projectId ? ' active' : '');
    d.textContent = p.name;
    d.onclick = () => selectProject(p.id);
    el.appendChild(d);
  }
  if (selectPid && list.some(p => p.id === selectPid)) selectProject(selectPid);
}

async function selectProject(pid) {
  projectId = pid;
  const data = await (await fetch(`/api/projects/${pid}`)).json();
  projName.textContent = data.project.name;
  $('delBtn').hidden = false;
  messagesEl.innerHTML = '';
  for (const m of data.messages) {
    if (m.role === 'user') addUserBubble(m.content);
    else addAiBubble(stripBlocks(m.content));
  }
  setChips(data.files);
  refreshPreview(false);
  loadProjects();
}

function resetToNew() {
  projectId = null;
  projName.textContent = 'New app';
  $('delBtn').hidden = true;
  messagesEl.innerHTML = `
    <div class="empty"><h1>Build an app by describing it</h1>
    <p>Try: “a todo app with priorities and due dates”,<br>
       “landing page for my bakery with an order form”,<br>
       “kanban board with drag and drop”.</p></div>`;
  setChips([]);
  frame.src = 'about:blank';
  promptBox.focus();
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

  let chipFiles = [];
  let previewTimer = null;
  const schedulePreview = () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => refreshPreview(true), 500);
  };

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, message }),
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
          if (!projectId) { projectId = ev.projectId; }
          projName.textContent = message.slice(0, 60);
          activityText.textContent = `${ev.model} is building…`;
        } else if (ev.type === 'think') {
          rawStream.textContent = (rawStream.textContent + ev.v).slice(-9000);
          rawStream.scrollTop = rawStream.scrollHeight;
          if (activityText.textContent.startsWith('thinking')) {
            activityText.textContent = 'thinking' + '.'.repeat(1 + (dots = (dots + 1) % 4));
          }
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

/* ---------- wire up ---------- */
sendBtn.onclick = send;
$('newBtn').onclick = () => { if (!busy) resetToNew(); };
$('refreshBtn').onclick = () => refreshPreview(true);
$('openBtn').onclick = () => projectId && window.open(`/preview/${projectId}/`, '_blank');
$('delBtn').onclick = async () => {
  if (!projectId || !confirm('Delete this project?')) return;
  await fetch(`/api/projects/${projectId}`, { method: 'DELETE' });
  await loadProjects(); resetToNew();
};
promptBox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});

loadMeta();
loadProjects(true);
resetToNew();
