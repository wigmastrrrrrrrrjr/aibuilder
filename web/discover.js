'use strict';

const grid = document.getElementById('discoverGrid');
// Backend lives on Cloudflare Workers when this page is served from GitHub Pages.
const WORKER_ORIGIN = 'https://aibuilderapi.csomeone301.workers.dev';
const API = location.hostname.endsWith('github.io') ? WORKER_ORIGIN : '';

function card(app) {
  const d = document.createElement('article');
  d.className = 'card';
  const title = document.createElement('h3');
  title.textContent = app.name;
  title.className = 'cardTitle';
  const desc = document.createElement('p');
  desc.textContent = app.description || 'No description.';
  desc.className = 'cardDesc';
  const row = document.createElement('div');
  row.className = 'cardRow';

  const open = document.createElement('a');
  open.className = 'cardBtn primary';
  open.href = `${API}/preview/${app.id}/`;
  open.target = '_blank';
  open.rel = 'noopener';
  open.textContent = 'Open ↗';

  const remix = document.createElement('button');
  remix.className = 'cardBtn';
  remix.textContent = 'Remix ✎';
  remix.onclick = async () => {
    remix.disabled = true; remix.textContent = 'Remixing…';
    try {
      const r = await fetch(`${API}/api/projects/${app.id}/remix`, { method: 'POST' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const copy = await r.json();
      location.href = `index.html?project=${copy.id}`;
    } catch (e) {
      alert(`⚠ ${e.message}`);
      remix.disabled = false; remix.textContent = 'Remix ✎';
    }
  };

  row.append(open, remix);
  const date = document.createElement('span');
  date.className = 'cardDate';
  try { date.textContent = new Date(app.created_at).toLocaleDateString(); } catch {}
  d.append(title, desc, row, date);
  return d;
}

async function load() {
  grid.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const apps = await (await fetch(`${API}/api/discover`)).json();
    grid.innerHTML = '';
    if (!apps.length) {
      grid.innerHTML = `<div class="empty"><h1>No published apps yet</h1>
        <p>Build something in the <a href="index.html">builder</a> and hit Publish.</p></div>`;
      return;
    }
    for (const a of apps) grid.appendChild(card(a));
  } catch (e) {
    grid.innerHTML = `<div class="empty">⚠ ${e.message}</div>`;
  }
}

load();
