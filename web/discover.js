'use strict';

const grid = document.getElementById('discoverGrid');
const searchEl = document.getElementById('discSearch');
const sortEl = document.getElementById('discSort');
const countEl = document.getElementById('discCount');
// Backend lives on Cloudflare Workers when this page is served from GitHub Pages.
const WORKER_ORIGIN = 'https://aibuilderapi.csomeone301.workers.dev';
const API = location.hostname.endsWith('github.io') ? WORKER_ORIGIN : '';

let APPS = [];

function skel() {
  grid.innerHTML = '';
  for (let i = 0; i < 6; i++) {
    const a = document.createElement('article');
    a.className = 'card skel';
    const shot = document.createElement('div');
    shot.className = 'cardShot';
    const body = document.createElement('div');
    body.className = 'cardBody';
    for (let j = 0; j < 3; j++) {
      const l = document.createElement('div');
      l.className = 'skelLine';
      body.appendChild(l);
    }
    a.append(shot, body);
    grid.appendChild(a);
  }
}

function fmtDate(ts) {
  try { return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch { return ''; }
}

function card(app, featured) {
  const d = document.createElement('article');
  d.className = 'card' + (featured ? ' large' : '');

  const href = `${API}/preview/${app.id}/`;

  const shot = document.createElement('a');
  shot.className = 'cardShot';
  shot.href = href;
  shot.target = '_blank';
  shot.rel = 'noopener';
  const fr = document.createElement('iframe');
  fr.src = href;
  fr.loading = 'lazy';
  fr.referrerPolicy = 'no-referrer';
  fr.title = `${app.name} preview`;
  fr.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals');
  fr.addEventListener('load', () => shot.classList.add('loaded'));
  const title = document.createElement('h3');
  title.className = 'shotTitle';
  title.textContent = app.name;
  const pill = document.createElement('span');
  pill.className = 'shotPill';
  pill.textContent = 'Live';
  shot.append(fr, title, pill);

  const body = document.createElement('div');
  body.className = 'cardBody';
  const desc = document.createElement('p');
  desc.className = 'cardDesc';
  desc.textContent = app.description || 'No description yet — open it to see what they built.';
  const row = document.createElement('div');
  row.className = 'cardRow';

  const open = document.createElement('a');
  open.className = 'cardBtn primary';
  open.href = href;
  open.target = '_blank';
  open.rel = 'noopener';
  open.textContent = 'Open';

  const remix = document.createElement('button');
  remix.className = 'cardBtn';
  remix.textContent = 'Remix';
  remix.onclick = async () => {
    remix.disabled = true; remix.textContent = 'Remixing…';
    try {
      const r = await fetch(`${API}/api/projects/${app.id}/remix`, { method: 'POST' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const copy = await r.json();
      location.href = `index.html?project=${copy.id}`;
    } catch (e) {
      alert(`⚠ ${e.message}`);
      remix.disabled = false; remix.textContent = 'Remix';
    }
  };

  row.append(open, remix);
  body.append(desc, row);

  const foot = document.createElement('div');
  foot.className = 'cardFoot';
  const kind = document.createElement('span');
  kind.className = 'cardView';
  kind.textContent = 'Community';
  const date = document.createElement('span');
  date.className = 'cardDate';
  date.textContent = fmtDate(app.created_at);
  foot.append(kind, date);

  d.append(shot, body, foot);
  return d;
}

function render() {
  const q = (searchEl.value || '').trim().toLowerCase();
  const mode = sortEl.value;
  let list = APPS.filter(a => (a.name + ' ' + (a.description || '')).toLowerCase().includes(q));
  list = [...list].sort((a, b) => mode === 'az'
    ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    : new Date(b.created_at || 0) - new Date(a.created_at || 0));
  grid.innerHTML = '';
  countEl.textContent = list.length
    ? `${list.length} app${list.length === 1 ? '' : 's'}`
    : (APPS.length ? '' : 'No apps yet');
  if (!APPS.length) {
    grid.innerHTML = `<div class="empty"><h1>No published apps yet</h1>
      <p>Build something in the <a href="index.html" style="color:var(--accent)">builder</a> and publish it to appear here.</p></div>`;
    return;
  }
  if (!list.length) {
    grid.innerHTML = `<div class="empty"><h1>Nothing matches “${searchEl.value}”</h1>
      <p>Try a different search, or <a href="index.html" style="color:var(--accent)">publish your own</a>.</p></div>`;
    return;
  }
  list.forEach((a, i) => grid.appendChild(card(a, i === 0)));
}

searchEl.addEventListener('input', render);
sortEl.addEventListener('change', render);

async function load() {
  skel();
  try {
    const apps = await (await fetch(`${API}/api/discover`)).json();
    APPS = apps;
    render();
  } catch (e) {
    grid.innerHTML = `<div class="empty"><h1>Couldn’t load the feed</h1><p>${e.message}</p></div>`;
  }
}

load();