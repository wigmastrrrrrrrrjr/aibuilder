// aibuilder Puter Serverless Worker — full API port.
// Single-file deployment to *.puter.work.
// Store: Supabase REST (PostgREST) via fetch().
// No npm deps — all runtime APIs are Web Standard.

// =========================================================================
// Config — secrets are injected at build time from .env (gitignored).
// To deploy: sh build.sh
// =========================================================================
const SB_URL  = 'INJECT_SB_URL';
const SB_KEY  = 'INJECT_SB_KEY';
const OLLAMA_URL  = 'INJECT_OLLAMA_URL';
const OLLAMA_KEY  = 'INJECT_OLLAMA_KEY';
const OLLAMA_MODEL = 'INJECT_OLLAMA_MODEL';
const OPENROUTER_KEY = 'INJECT_OPENROUTER_KEY';
const FRONTEND_URL = 'https://wigmastrrrrrrrrjr.github.io/aibuilder/';
const FREE_DAILY_CREDITS = 40;
const UNITS_PER_CREDIT = 10;
const MAX_ACCOUNTS_PER_IP = 3;
const PRESENCE_WINDOW_MS = 30000;
const MODEL_LIST = [
  { id: 'gemma4:31b', name: 'Gemma 4 31B (free, local)', provider: 'ollama' },
  { id: 'mistral-small-3.1-24b', name: 'Mistral Small 3.1 24B (free)', provider: 'ollama' },
  { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'openrouter' },
  { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', provider: 'openrouter' },
  { id: 'openai/gpt-4o', name: 'GPT-4o', provider: 'openrouter' },
];

function creditsToUnits(c) { return Math.round((Number(c) || 0) * UNITS_PER_CREDIT); }
function unitsToCredits(u) { return Math.round((Number(u) || 0) / UNITS_PER_CREDIT); }
function slugify(name) {
  const s = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (s || 'app').slice(0, 40);
}
function id20() { return crypto.randomUUID().replace(/-/g, '').slice(0, 20); }
function now() { return Date.now(); }
function dayStr() { return new Date().toISOString().slice(0, 10); }

// =========================================================================
// Supabase REST helpers
// =========================================================================
const sbHeaders = () => ({ apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' });

async function sbGet(table, query = '') {
  const r = await fetch(`${SB_URL}/rest/v1/${table}${query}`, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`SB GET ${table}: ${r.status} ${await r.text()}`);
  return r.json();
}
async function sbGetOne(table, query = '') {
  const rows = await sbGet(table, query);
  return rows[0] || null;
}
async function sbInsert(table, body, returnRep = false) {
  const h = { ...sbHeaders(), Prefer: returnRep ? 'return=representation' : 'return=minimal' };
  const r = await fetch(`${SB_URL}/rest/v1/${table}`, { method: 'POST', headers: h, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`SB INSERT ${table}: ${r.status} ${await r.text()}`);
  return returnRep ? r.json() : null;
}
async function sbUpsert(table, body, returnRep = false) {
  const h = { ...sbHeaders(), Prefer: `resolution=merge-duplicates${returnRep ? ',return=representation' : ''}` };
  const r = await fetch(`${SB_URL}/rest/v1/${table}`, { method: 'POST', headers: h, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`SB UPSERT ${table}: ${r.status} ${await r.text()}`);
  return returnRep ? r.json() : null;
}
async function sbUpdate(table, filter, body, returnRep = false) {
  const h = { ...sbHeaders(), Prefer: returnRep ? 'return=representation' : 'return=minimal' };
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${filter}`, { method: 'PATCH', headers: h, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`SB UPDATE ${table}: ${r.status} ${await r.text()}`);
  return returnRep ? r.json() : null;
}
async function sbDelete(table, filter) {
  const h = { ...sbHeaders(), Prefer: 'return=minimal' };
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${filter}`, { method: 'DELETE', headers: h });
  if (!r.ok) throw new Error(`SB DELETE ${table}: ${r.status} ${await r.text()}`);
  return { ok: true };
}
async function sbRpc(fn, args) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: sbHeaders(), body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`SB RPC ${fn}: ${r.status} ${await r.text()}`);
  const ct = r.headers.get('content-type') || '';
  return ct.includes('application/json') ? r.json() : r.text();
}

// =========================================================================
// Store (mirrors store-d1.js interface)
// =========================================================================
const store = {
  // ---- projects ----
  async createProject(name, owner) {
    const p = { id: id20(), name: name || 'Untitled app', created_at: now(), owner: owner || '' };
    await sbInsert('projects', p);
    return { ...p, published: 0, slug: null, description: '', model: '', plan: null, team_id: '' };
  },
  async listProjects() {
    return sbGet('projects', '?select=*&order=created_at.desc');
  },
  async getProject(pid) {
    return sbGetOne('projects', `?select=*&id=eq.${pid}`);
  },
  async deleteProject(pid) {
    await sbDelete('files', `project_id=eq.${pid}`);
    await sbDelete('file_versions', `project_id=eq.${pid}`);
    await sbDelete('messages', `project_id=eq.${pid}`);
    await sbDelete('events', `pid=eq.${pid}`);
    // snapshot_files via subquery
    const snaps = await sbGet('snapshots', `?select=id&project_id=eq.${pid}`);
    for (const s of snaps) await sbDelete('snapshot_files', `snapshot_id=eq.${s.id}`);
    await sbDelete('snapshots', `project_id=eq.${pid}`);
    await sbDelete('projects', `id=eq.${pid}`);
    return { ok: true };
  },
  async setModel(pid, model) {
    if (!/^[A-Za-z0-9._:+%-]{1,64}$/.test(model || '')) return;
    await sbUpdate('projects', `id=eq.${pid}`, { model });
  },
  async setPublished(pid, publish, description) {
    const p = await this.getProject(pid);
    if (!p) throw new Error('not found');
    let slug = p.slug;
    if (publish && !slug) {
      slug = slugify(p.name);
      for (let i = 2; ; i++) {
        const hit = await sbGetOne('projects', `?select=id&slug=eq.${slug}`);
        if (!hit) break;
        slug = `${slugify(p.name)}-${i}`;
      }
    }
    const desc = description !== undefined && description !== null
      ? String(description) : (p.description ?? '');
    await sbUpdate('projects', `id=eq.${pid}`, { published: publish ? 1 : 0, slug: publish ? slug : slug, description: desc });
    return this.getProject(pid);
  },
  async discover() {
    return sbGet('projects', '?select=id,slug,name,description,created_at&published=eq.1&order=created_at.desc');
  },
  async remix(srcPid) {
    const src = await this.getProject(srcPid);
    if (!src) return null;
    const copy = await this.createProject(`${src.name} (remix)`);
    const srcFiles = await sbGet('files', `?select=path,content,encoding&project_id=eq.${srcPid}`);
    if (srcFiles.length) {
      const rows = srcFiles.map(f => ({ project_id: copy.id, path: f.path, content: f.content, encoding: f.encoding || 'utf8', updated_at: now() }));
      await sbInsert('files', rows);
    }
    if (src.description) await sbUpdate('projects', `id=eq.${copy.id}`, { description: src.description });
    return copy;
  },

  // ---- files ----
  async saveFile(pid, fpath, content, encoding = 'utf8') {
    await sbUpsert('files', { project_id: pid, path: fpath, content, encoding, updated_at: now() });
    await this.recordVersion(pid, fpath, content, encoding);
  },
  async recordVersion(pid, fpath, content, encoding) {
    const cur = await sbGetOne('file_versions',
      `?select=seq&project_id=eq.${pid}&path=eq.${encodeURIComponent(fpath)}&order=seq.desc&limit=1`);
    const s = (cur?.seq || 0) + 1;
    await sbInsert('file_versions', { project_id: pid, path: fpath, seq: s, content, encoding: encoding || 'utf8', updated_at: now() });
    // Prune to latest 60
    const oldest = await sbGetOne('file_versions',
      `?select=seq&project_id=eq.${pid}&path=eq.${encodeURIComponent(fpath)}&order=seq.desc&limit=1&offset=59`);
    if (oldest) await sbDelete('file_versions', `project_id=eq.${pid}&path=eq.${encodeURIComponent(fpath)}&seq=lt.${oldest.seq}`);
  },
  async getFile(pid, fpath) {
    return sbGetOne('files', `?select=*&project_id=eq.${pid}&path=eq.${encodeURIComponent(fpath)}`);
  },
  async listFiles(pid) {
    return sbGet('files', `?select=path,updated_at&project_id=eq.${pid}&order=path`);
  },
  async listFilesWithContent(pid) {
    return sbGet('files', `?select=path,content,encoding,updated_at&project_id=eq.${pid}&order=path`);
  },
  async deleteFile(pid, fpath) {
    await sbDelete('files', `project_id=eq.${pid}&path=eq.${encodeURIComponent(fpath)}`);
    const cur = await sbGetOne('file_versions',
      `?select=seq&project_id=eq.${pid}&path=eq.${encodeURIComponent(fpath)}&order=seq.desc&limit=1`);
    await sbInsert('file_versions', { project_id: pid, path: fpath, seq: (cur?.seq || 0) + 1, content: null, encoding: 'utf8', updated_at: now() });
    return { ok: true };
  },
  async fileVersions(pid, fpath) {
    const rows = await sbGet('file_versions',
      `?select=seq,updated_at,content&project_id=eq.${pid}&path=eq.${encodeURIComponent(fpath)}&order=seq.desc`);
    return rows.map(r => ({ seq: r.seq, updated_at: r.updated_at, deleted: r.content == null, bytes: r.content ? r.content.length : 0 }));
  },
  async getFileVersion(pid, fpath, seq) {
    return sbGetOne('file_versions',
      `?select=seq,content,encoding,updated_at&project_id=eq.${pid}&path=eq.${encodeURIComponent(fpath)}&seq=eq.${seq}`);
  },
  async restoreFileVersion(pid, fpath, seq) {
    const v = await this.getFileVersion(pid, fpath, seq);
    if (!v) throw new Error('version not found');
    if (v.content == null) {
      await this.deleteFile(pid, fpath);
      return { ok: true, deleted: true, seq };
    }
    await this.saveFile(pid, fpath, v.content, v.encoding || 'utf8');
    return { ok: true, deleted: false, seq };
  },

  // ---- snapshots ----
  async listSnapshots(pid) {
    const snaps = await sbGet('snapshots',
      `?select=id,created_at,label&project_id=eq.${pid}&order=created_at.desc`);
    // Attach file counts
    for (const s of snaps) {
      const cnt = await sbGetOne('snapshot_files', `?select=snapshot_id&snapshot_id=eq.${s.id}&limit=0`);
      // PostgREST doesn't do COUNT easily; use head request for total count
      const r = await fetch(`${SB_URL}/rest/v1/snapshot_files?snapshot_id=eq.${s.id}&select=snapshot_id`, {
        method: 'HEAD', headers: { ...sbHeaders(), Range: '0-0', Prefer: 'count=exact' },
      });
      s.files = parseInt(r.headers.get('content-range')?.split('/')[1] || '0', 10);
    }
    return snaps;
  },
  async takeSnapshot(pid, label) {
    const id = id20();
    await sbInsert('snapshots', { id, project_id: pid, created_at: now(), label: String(label || '').slice(0, 80) });
    // Copy current files
    const files = await sbGet('files', `?select=path,content,encoding&project_id=eq.${pid}`);
    if (files.length) {
      const rows = files.map(f => ({ snapshot_id: id, path: f.path, content: f.content, encoding: f.encoding || 'utf8' }));
      await sbInsert('snapshot_files', rows);
    }
    // Prune to latest 20 snapshots
    const oldSnaps = await sbGet('snapshots',
      `?select=id&project_id=eq.${pid}&order=created_at.desc&offset=20`);
    for (const s of oldSnaps) {
      await sbDelete('snapshot_files', `snapshot_id=eq.${s.id}`);
      await sbDelete('snapshots', `id=eq.${s.id}`);
    }
    return { id, pid, created_at: now(), label: String(label || '').slice(0, 80) };
  },
  async getSnapshot(pid, sid) {
    const s = await sbGetOne('snapshots', `?select=*&id=eq.${sid}&project_id=eq.${pid}`);
    if (!s) return null;
    s.files = await sbGet('snapshot_files', `?select=path,content,encoding&snapshot_id=eq.${sid}&order=path`);
    return s;
  },
  async restoreSnapshot(pid, sid) {
    const s = await this.getSnapshot(pid, sid);
    if (!s) throw new Error('snapshot not found');
    const have = await this.listFiles(pid);
    const keep = new Set(s.files.map(f => f.path));
    for (const f of s.files) await this.saveFile(pid, f.path, f.content, f.encoding || 'utf8');
    for (const f of have) if (!keep.has(f.path)) await this.deleteFile(pid, f.path);
    return { ok: true, files: s.files.length };
  },

  // ---- messages ----
  async addMessage(pid, role, content, user = '') {
    await sbInsert('messages', { project_id: pid, role, content, user, created_at: now() });
  },
  async history(pid, limit = 12) {
    const rows = await sbGet('messages',
      `?select=role,content,user&project_id=eq.${pid}&order=created_at.desc&limit=${limit}`);
    return rows.reverse();
  },

  // ---- plan & rename ----
  async setPlan(pid, plan) {
    await sbUpdate('projects', `id=eq.${pid}`, { plan: plan == null ? null : JSON.stringify(plan) });
  },
  async rename(pid, name) {
    const p = await this.getProject(pid);
    if (!p) throw new Error('not found');
    await sbUpdate('projects', `id=eq.${pid}`, { name });
    return { ...p, name };
  },

  // ---- usage & credits ----
  async incrUsage(name, day) {
    return sbRpc('increment_usage', { p_name: name, p_day: day, p_amount: 1 });
  },
  creditsKey(userId) { return `credit:${userId}`; },
  async getCredits(userId, day) {
    const r = await sbGetOne('usage', `?select=count&name=eq.${encodeURIComponent(this.creditsKey(userId))}&day=eq.${day}`);
    return r?.count || 0;
  },
  async spendCredits(userId, day, amount) {
    return sbRpc('increment_usage', { p_name: this.creditsKey(userId), p_day: day, p_amount: amount });
  },
  async creditGet(key, day) {
    const r = await sbGetOne('usage', `?select=count&name=eq.${encodeURIComponent(key)}&day=eq.${day}`);
    return r?.count || 0;
  },
  async creditSpend(key, day, amount) {
    return sbRpc('increment_usage', { p_name: key, p_day: day, p_amount: amount });
  },
  teamCreditKey(teamId) { return `credit:team:${teamId}`; },
  async earningsUnits(name) {
    const r = await sbGetOne('earnings', `?select=units&name=eq.${encodeURIComponent(name)}`);
    return r?.units || 0;
  },
  async earningsUnitsForNames(names) {
    if (!names?.length) return 0;
    const filter = names.map(n => `name.eq.${encodeURIComponent(n)}`).join(',');
    const r = await sbGet('earnings', `?select=units&or=(${filter})`);
    return r.reduce((sum, row) => sum + (row.units || 0), 0);
  },
  async earnCredits(name, units) {
    await sbRpc('increment_earnings', { p_name: name, p_units: units });
  },
  async spendEarnings(name, units) {
    return sbRpc('spend_earnings', { p_name: name, p_units: units });
  },

  // ---- teams ----
  async createTeam(name, owner) {
    const id = id20();
    const CHS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let tries = 0; tries < 5; tries++) {
      code = Array.from(crypto.getRandomValues(new Uint8Array(8)))
        .map(b => CHS[b % CHS.length]).join('');
      const clash = await sbGetOne('teams', `?select=id&invite_code=eq.${code}`);
      if (!clash) break;
    }
    await sbInsert('teams', { id, name, owner, invite_code: code, created_at: now() });
    await sbInsert('team_members', { team_id: id, name: owner, joined_at: now() });
    return this.teamInfo(id);
  },
  async teamInfo(tid) {
    const t = await sbGetOne('teams', `?select=*&id=eq.${tid}`);
    if (!t) return null;
    const m = await sbGet('team_members', `?select=name&team_id=eq.${tid}&order=joined_at`);
    t.members = m.map(r => r.name);
    return t;
  },
  async teamByInviteCode(code) {
    const t = await sbGetOne('teams', `?select=*&invite_code=eq.${code}`);
    if (!t) return null;
    const r = await fetch(`${SB_URL}/rest/v1/team_members?team_id=eq.${t.id}&select=team_id`, {
      method: 'HEAD', headers: { ...sbHeaders(), Range: '0-0', Prefer: 'count=exact' },
    });
    const cnt = parseInt(r.headers.get('content-range')?.split('/')[1] || '0', 10);
    return { id: t.id, name: t.name, owner: t.owner, members: cnt };
  },
  async teamMembers(tid) {
    const m = await sbGet('team_members', `?select=name&team_id=eq.${tid}&order=joined_at`);
    return m.map(r => r.name);
  },
  async addTeamMember(tid, name, joinedAt) {
    try {
      await sbInsert('team_members', { team_id: tid, name, joined_at: joinedAt || now() });
      return true;
    } catch { return false; }
  },
  async removeTeamMember(tid, name) {
    await sbDelete('team_members', `team_id=eq.${tid}&name=eq.${encodeURIComponent(name)}`);
    const r = await fetch(`${SB_URL}/rest/v1/team_members?team_id=eq.${tid}&select=team_id`, {
      method: 'HEAD', headers: { ...sbHeaders(), Range: '0-0', Prefer: 'count=exact' },
    });
    const cnt = parseInt(r.headers.get('content-range')?.split('/')[1] || '0', 10);
    if (cnt === 0) await sbDelete('teams', `id=eq.${tid}`);
  },
  async myTeams(name) {
    // PostgREST doesn't support complex JOINs in query params; use RPC or two queries
    const memberOf = await sbGet('team_members', `?select=team_id&name=eq.${encodeURIComponent(name)}`);
    const teamIds = [...new Set([
      ...memberOf.map(m => m.team_id),
    ])];
    // Also get teams where user is owner
    const owned = await sbGet('teams', `?select=id&owner=eq.${encodeURIComponent(name)}`);
    for (const o of owned) if (!teamIds.includes(o.id)) teamIds.push(o.id);

    const results = [];
    for (const tid of teamIds) {
      const t = await sbGetOne('teams', `?select=*&id=eq.${tid}`);
      if (!t) continue;
      const r = await fetch(`${SB_URL}/rest/v1/team_members?team_id=eq.${tid}&select=team_id`, {
        method: 'HEAD', headers: { ...sbHeaders(), Range: '0-0', Prefer: 'count=exact' },
      });
      t.members = parseInt(r.headers.get('content-range')?.split('/')[1] || '0', 10);
      results.push(t);
    }
    return results.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  },
  async myTeamIds(name) {
    const m = await sbGet('team_members', `?select=team_id&name=eq.${encodeURIComponent(name)}`);
    return [...new Set(m.map(r => r.team_id))];
  },
  async isTeamMember(tid, name) {
    const r = await sbGetOne('team_members', `?select=team_id&team_id=eq.${tid}&name=eq.${encodeURIComponent(name)}`);
    return Boolean(r);
  },
  async setProjectTeam(pid, tid) {
    await sbUpdate('projects', `id=eq.${pid}`, { team_id: tid || '' });
    return this.getProject(pid);
  },
  async deleteTeam(tid) {
    await sbDelete('team_members', `team_id=eq.${tid}`);
    await sbUpdate('projects', `team_id=eq.${tid}`, { team_id: '' });
    await sbDelete('teams', `id=eq.${tid}`);
    return { ok: true };
  },

  // ---- interactions ----
  async recordInteraction(pid, visitorKey, day) {
    const p = await this.getProject(pid);
    if (!p || !p.published || !p.owner) return { ok: false, created: false };
    const vid = String(visitorKey || '');
    if (!vid) return { ok: false, created: false };
    if (vid === `user:${p.owner}`) return { ok: false, created: false };
    if (p.team_id && vid.startsWith('user:')) {
      if (await this.isTeamMember(p.team_id, vid.slice(5))) return { ok: false, created: false };
    }
    try {
      await sbInsert('interactions', {
        project_id: p.id, day: day || dayStr(), key: vid, created_at: now(),
      });
      await this.earnCredits(p.owner, creditsToUnits(1));
      return { ok: true, created: true, project_id: p.id };
    } catch { return { ok: true, created: false }; }
  },
  async interactionsToday(pid, day) {
    const r = await fetch(`${SB_URL}/rest/v1/interactions?project_id=eq.${pid}&day=eq.${day || dayStr()}&select=project_id`, {
      method: 'HEAD', headers: { ...sbHeaders(), Range: '0-0', Prefer: 'count=exact' },
    });
    return parseInt(r.headers.get('content-range')?.split('/')[1] || '0', 10);
  },

  // ---- presence ----
  async touchPresence(pid, sid, userName, ts) {
    const t = ts || now();
    await sbDelete('presence', `seen_at=lt.${t - PRESENCE_WINDOW_MS}`);
    const had = await sbGetOne('presence', `?select=sid&pid=eq.${pid}&sid=eq.${sid}`);
    if (!had) {
      const cnt = await this._presenceCount(pid);
      if (cnt >= 10) return { active: cnt, accepted: false, present: false };
      await sbInsert('presence', { pid, sid, user: userName || '', seen_at: t });
    } else {
      await sbUpdate('presence', `pid=eq.${pid}&sid=eq.${sid}`, { user: userName || '', seen_at: t });
    }
    const cnt = await this._presenceCount(pid);
    return { active: cnt, accepted: true, present: Boolean(had) };
  },
  async _presenceCount(pid) {
    const r = await fetch(`${SB_URL}/rest/v1/presence?pid=eq.${pid}&select=sid`, {
      method: 'HEAD', headers: { ...sbHeaders(), Range: '0-0', Prefer: 'count=exact' },
    });
    return parseInt(r.headers.get('content-range')?.split('/')[1] || '0', 10);
  },
  async leavePresence(pid, sid) {
    await sbDelete('presence', `pid=eq.${pid}&sid=eq.${sid}`);
  },
  async presenceUsers(pid) {
    await sbDelete('presence', `seen_at=lt.${now() - PRESENCE_WINDOW_MS}`);
    const rows = await sbGet('presence',
      `?select=user&pid=eq.${pid}&user=not.eq.&order=seen_at.desc&limit=20`);
    return [...new Set(rows.map(r => r.user))];
  },

  // ---- auth ----
  async createUser({ name, phash, ip, email }) {
    const id = crypto.randomUUID();
    try {
      await sbInsert('users', {
        id, name, phash, email: email || '', verified: 0, created_at: now(), ip: ip || '',
      });
      return { id, name, email: email || '' };
    } catch {
      throw new Error('username already taken');
    }
  },
  async ipUsed(ip) {
    if (!ip) return null;
    const rows = await sbGet('users', `?select=name&ip=eq.${encodeURIComponent(ip)}`);
    if (rows.length < MAX_ACCOUNTS_PER_IP) return null;
    return rows[0]?.name || null;
  },
  async resetPassword(name, phash) {
    const u = await sbGetOne('users', `?select=*&name=eq.${encodeURIComponent(name)}`);
    if (!u) return null;
    await sbUpdate('users', `id=eq.${u.id}`, { phash });
    return { ...u, phash };
  },
  async updateUserIp(name, ipTag) {
    const u = await sbGetOne('users', `?select=*&name=eq.${encodeURIComponent(name)}`);
    if (u && !u.ip) await sbUpdate('users', `id=eq.${u.id}`, { ip: ipTag });
  },
  async findUserByName(name) {
    return sbGetOne('users', `?select=*&name=eq.${encodeURIComponent(name)}`);
  },
  async findUserById(id) {
    return sbGetOne('users', `?select=*&id=eq.${id}`);
  },
  async verifyUser(name) {
    await sbUpdate('users', `name=eq.${encodeURIComponent(name)}`, { verified: 1 });
  },
  async createSession(userId, days = 30) {
    const token = [...crypto.getRandomValues(new Uint8Array(24))]
      .map(b => b.toString(16).padStart(2, '0')).join('');
    await sbInsert('sessions', { token, user_id: userId, exp: now() + days * 86400000 });
    return token;
  },
  async getSession(token) {
    const s = await sbGetOne('sessions', `?select=*&token=eq.${token}`);
    if (!s || s.exp < now()) return null;
    const u = await sbGetOne('users', `?select=*&id=eq.${s.user_id}`);
    return u ? { id: u.id, userId: u.id, name: u.name } : null;
  },
  async deleteSession(token) {
    await sbDelete('sessions', `token=eq.${token}`);
  },

  // ---- meta ----
  async metaGet(key) {
    const r = await sbGetOne('meta', `?select=v&k=eq.${encodeURIComponent(key)}`);
    return r?.v ?? null;
  },
  async metaSet(key, val) {
    await sbUpsert('meta', { k: key, v: String(val) });
  },

  // ---- events (multiplayer) ----
  async appendEvent(pid, room, data) {
    const rows = await sbInsert('events', { pid, room, data: JSON.stringify(data ?? {}) }, true);
    return rows?.[0]?.seq || 0;
  },
  async currentSeq(pid, room) {
    const r = await sbGetOne('events', `?select=seq&pid=eq.${pid}&room=eq.${encodeURIComponent(room)}&order=seq.desc&limit=1`);
    return r?.seq || 0;
  },
  async eventsSince(pid, room, since, limit = 60) {
    const rows = await sbGet('events',
      `?select=data,seq&pid=eq.${pid}&room=eq.${encodeURIComponent(room)}&seq=gt.${since}&order=seq&limit=${Math.min(200, Math.max(1, Number(limit) || 60))}`);
    return rows.map(r => ({ ...JSON.parse(r.data), seq: r.seq }));
  },

  // ---- BaaS (generic document store) ----
  async baasList(pid, coll) {
    const rows = await sbGet('baas_data',
      `?select=row_id,data,created_at&project_id=eq.${pid}&collection=eq.${coll}&order=created_at`);
    return rows.map(r => ({ id: r.row_id, ...r.data }));
  },
  async baasInsert(pid, coll, obj) {
    const rowId = id20();
    const { id: _ignored, ...data } = obj || {};
    await sbInsert('baas_data', { project_id: pid, collection: coll, row_id: rowId, data, created_at: now() });
    return { id: rowId, ...data };
  },
  async baasGet(pid, coll, rowId) {
    const r = await sbGetOne('baas_data',
      `?select=row_id,data&project_id=eq.${pid}&collection=eq.${coll}&row_id=eq.${rowId}`);
    return r ? { id: r.row_id, ...r.data } : null;
  },
  async baasUpdate(pid, coll, rowId, patch) {
    const cur = await this.baasGet(pid, coll, rowId);
    if (!cur) return null;
    const { id: _ignored, ...data } = patch || {};
    const next = { ...cur, ...data };
    delete next.id;
    await sbUpdate('baas_data',
      `project_id=eq.${pid}&collection=eq.${coll}&row_id=eq.${rowId}`, { data: next });
    return { id: rowId, ...next };
  },
  async baasRemove(pid, coll, rowId) {
    const had = await this.baasGet(pid, coll, rowId);
    await sbDelete('baas_data',
      `project_id=eq.${pid}&collection=eq.${coll}&row_id=eq.${rowId}`);
    return Boolean(had);
  },
};

// =========================================================================
// Auth helpers
// =========================================================================
const PBKDF2_ITERATIONS = 100_000;

async function hashPw(pw) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt }, key, 256);
  const hash = [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${salt.reduce((s, b) => s + b.toString(16).padStart(2, '0'), '')}:${hash}`;
}

async function verifyPw(pw, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const salt = Uint8Array.from(saltHex.match(/.{2}/g).map(h => parseInt(h, 16)));
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt }, key, 256);
  const hash = [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
  return hash === hashHex;
}

async function getUser(request) {
  const token = request.headers.get('x-ab-sess') || '';
  if (!token) return null;
  return store.getSession(token);
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json', ...headers },
  });
}

// =========================================================================
// Routes
// =========================================================================

// Health / meta
router.get('/api/meta', () => json({
  model: OLLAMA_MODEL, hasKey: true,
}));

// Debug
router.get('/api/debug-test', () => json({ ok: true }));

// ---- Credits ----
router.get('/api/credits', async ({ request }) => {
  const user = await getUser(request);
  if (!user) return json({ error: 'not signed in' }, 401);
  const day = dayStr();
  const bal = await personalBalance(user, day);
  const myTeams = await store.myTeams(user.name);
  const first = myTeams[0] || null;
  let team = null;
  if (first) {
    const pool = await teamPool(first.id, day);
    team = { id: first.id, name: first.name, owner: first.owner, members: pool.memberCount,
      totalCredits: unitsToCredits(pool.totalUnits), usedCredits: unitsToCredits(pool.usedUnits), leftCredits: unitsToCredits(pool.leftUnits) };
  }
  return json({
    credits: { total: bal.totalCredits, used: unitsToCredits(bal.spent) + unitsToCredits(bal.earned), left: bal.leftCredits, day },
    earned: unitsToCredits(bal.earned), team,
    teams: myTeams.map(t => ({ id: t.id, name: t.name, owner: t.owner, members: Number(t.members || 0) })),
  });
});

router.post('/api/credits/gift', async ({ request }) => {
  const user = await getUser(request);
  if (!user) return json({ error: 'not signed in' }, 401);
  const body = await request.json().catch(() => ({}));
  const targetName = String(body.to || '').trim();
  const amountCredits = Number(body.amount);
  const day = dayStr();
  if (!targetName) return json({ error: 'recipient username required' }, 400);
  if (!Number.isFinite(amountCredits) || amountCredits <= 0) return json({ error: 'amount must be positive' }, 400);
  if (amountCredits > 10000) return json({ error: 'max gift is 10000 credits' }, 400);
  if (targetName.toLowerCase() === user.name.toLowerCase()) return json({ error: 'gift to another user' }, 400);
  const recipient = await store.findUserByName(targetName);
  if (!recipient) return json({ error: `no user named "${targetName}"` }, 404);
  const units = creditsToUnits(amountCredits);
  const bal = await personalBalance(user, day);
  if (bal.leftUnits < units) return json({ error: `Only ${bal.leftCredits} credits available` }, 400);
  const dailyLeft = bal.totalUnits - bal.spent;
  if (dailyLeft >= units) {
    await store.spendCredits(user.id, day, units);
  } else {
    if (dailyLeft > 0) await store.spendCredits(user.id, day, dailyLeft);
    await store.spendEarnings(user.name, units - dailyLeft);
  }
  await store.earnCredits(recipient.name, units);
  const after = await personalBalance(user, day);
  return json({
    ok: true, gift: { to: recipient.name, amount: unitsToCredits(units), day },
    credits: { total: after.totalCredits, used: unitsToCredits(after.spent) + unitsToCredits(after.earned), left: after.leftCredits, day },
    earned: unitsToCredits(after.earned),
  });
});

// ---- Models ----
router.get('/api/models', () => json(MODEL_LIST));

// ---- Projects ----
router.get('/api/projects', async () => json(await store.listProjects()));

router.post('/api/projects', async ({ request }) => {
  const user = await getUser(request);
  if (!user) return json({ error: 'not signed in' }, 401);
  const { name } = await request.json().catch(() => ({}));
  return json(await store.createProject(name, user.name), 201);
});

router.get('/api/projects/:pid', async ({ params }) => {
  const project = await store.getProject(params.pid);
  if (!project) return json({ error: 'not found' }, 404);
  return json({ project, files: await store.listFiles(project.id), messages: await store.history(project.id, 100) });
});

router.get('/api/projects/:pid/export', async ({ params }) => {
  const project = await store.getProject(params.pid);
  if (!project) return json({ error: 'not found' }, 404);
  return json({ name: project.name, updated_at: project.updated_at || 0, files: await store.listFilesWithContent(project.id) });
});

router.delete('/api/projects/:pid', async ({ request, params }) => {
  const user = await getUser(request);
  if (!user) return json({ error: 'not signed in' }, 401);
  const project = await store.getProject(params.pid);
  if (!project) return json({ error: 'not found' }, 404);
  if (!(await canWrite(project, user))) return json({ error: "you don't own this project" }, 403);
  await store.deleteProject(params.pid);
  return json({ ok: true });
});

router.post('/api/projects/:pid/rename', async ({ request, params }) => {
  const user = await getUser(request);
  if (!user) return json({ error: 'not signed in' }, 401);
  const project = await store.getProject(params.pid);
  if (!project) return json({ error: 'not found' }, 404);
  if (!(await canWrite(project, user))) return json({ error: "you don't own this project" }, 403);
  const body = await request.json().catch(() => ({}));
  const name = String(body.name || '').trim().slice(0, 60);
  if (!name) return json({ error: 'name required' }, 400);
  try { return json(await store.rename(params.pid, name)); }
  catch (e) { return json({ error: String(e.message || e) }, 404); }
});

router.post('/api/projects/:pid/publish', async ({ request, params }) => {
  const user = await getUser(request);
  if (!user) return json({ error: 'not signed in' }, 401);
  const project = await store.getProject(params.pid);
  if (!project) return json({ error: 'not found' }, 404);
  if (!(await canWrite(project, user))) return json({ error: "you don't own this project" }, 403);
  const body = await request.json().catch(() => ({}));
  const publish = body.publish !== false;
  const description = typeof body.description === 'string' ? body.description.slice(0, 300) : undefined;
  try { return json(await store.setPublished(params.pid, publish, description)); }
  catch (e) { return json({ error: String(e.message || e) }, 400); }
});

router.post('/api/projects/:pid/remix', async ({ request, params }) => {
  const user = await getUser(request);
  if (!user) return json({ error: 'not signed in' }, 401);
  const src = await store.getProject(params.pid);
  if (!src) return json({ error: 'not found' }, 404);
  return json(await store.remix(src.id, user.name), 201);
});

// ---- Versions ----
router.get('/api/projects/:pid/versions', async ({ request, params }) => {
  const url = new URL(request.url);
  const fpath = String(url.searchParams.get('path') || '').trim();
  if (!fpath) return json({ error: 'path query required' }, 400);
  if (!(await store.getProject(params.pid))) return json({ error: 'not found' }, 404);
  const seq = Number(url.searchParams.get('seq')) || 0;
  if (seq) {
    const v = await store.getFileVersion(params.pid, fpath, seq);
    if (!v) return json({ error: 'version not found' }, 404);
    return json(v);
  }
  return json(await store.fileVersions(params.pid, fpath));
});

router.post('/api/projects/:pid/restore-version', async ({ request, params }) => {
  const user = await getUser(request);
  if (!user) return json({ error: 'not signed in' }, 401);
  const project = await store.getProject(params.pid);
  if (!project) return json({ error: 'not found' }, 404);
  if (!(await canWrite(project, user))) return json({ error: "you don't own this project" }, 403);
  const body = await request.json().catch(() => ({}));
  const fpath = String(body.path || '').trim();
  const seq = Number(body.seq) || 0;
  if (!fpath || !seq) return json({ error: 'path and seq required' }, 400);
  try { return json(await store.restoreFileVersion(params.pid, fpath, seq)); }
  catch (e) { return json({ error: String(e.message || e) }, 400); }
});

// ---- Snapshots ----
router.get('/api/projects/:pid/snapshots', async ({ params }) => {
  if (!(await store.getProject(params.pid))) return json({ error: 'not found' }, 404);
  return json(await store.listSnapshots(params.pid));
});

router.post('/api/projects/:pid/snapshots', async ({ request, params }) => {
  const user = await getUser(request);
  if (!user) return json({ error: 'not signed in' }, 401);
  const project = await store.getProject(params.pid);
  if (!project) return json({ error: 'not found' }, 404);
  if (!(await canWrite(project, user))) return json({ error: "you don't own this project" }, 403);
  const body = await request.json().catch(() => ({}));
  return json(await store.takeSnapshot(params.pid, String(body.label || '').trim()), 201);
});

router.get('/api/projects/:pid/snapshots/:sid', async ({ params }) => {
  const s = await store.getSnapshot(params.pid, params.sid);
  if (!s) return json({ error: 'not found' }, 404);
  return json(s);
});

router.post('/api/projects/:pid/snapshots/:sid/restore', async ({ request, params }) => {
  const user = await getUser(request);
  if (!user) return json({ error: 'not signed in' }, 401);
  const project = await store.getProject(params.pid);
  if (!project) return json({ error: 'not found' }, 404);
  if (!(await canWrite(project, user))) return json({ error: "you don't own this project" }, 403);
  try { return json(await store.restoreSnapshot(params.pid, params.sid)); }
  catch (e) { return json({ error: String(e.message || e) }, 400); }
});

// ---- Discover ----
router.get('/api/discover', async () => json(await store.discover()));

// ---- Upload ----
router.post('/api/projects/:pid/upload', async ({ request, params }) => {
  const user = await getUser(request);
  if (!user) return json({ error: 'not signed in' }, 401);
  const project = await store.getProject(params.pid);
  if (!project) return json({ error: 'not found' }, 404);
  if (!(await canWrite(project, user))) return json({ error: "you don't own this project" }, 403);
  let form;
  try { form = await request.formData(); } catch { return json({ error: 'expected multipart/form-data' }, 400); }
  const incoming = [];
  for (const [key, val] of form.entries()) {
    if (val && typeof val === 'object' && typeof val.arrayBuffer === 'function') incoming.push(val);
  }
  if (!incoming.length) return json({ error: 'no files received' }, 400);
  const saved = [];
  for (const f of incoming.slice(0, 300)) {
    const buf = new Uint8Array(await f.arrayBuffer());
    const rel = (f.name || '').replace(/\\/g, '/').split('/').filter(s => s && s !== '.' && s !== '..').slice(0, 8).join('/').slice(0, 200);
    if (!rel || (f.size || 0) > 2 * 1024 * 1024) continue;
    const b64 = btoa(String.fromCharCode(...buf));
    await store.saveFile(project.id, rel, b64, 'base64');
    saved.push(rel);
  }
  return json({ ok: true, saved, skipped: [] });
});

// ---- Presence ----
router.post('/api/projects/:pid/presence', async ({ request, params }) => {
  const user = await getUser(request);
  if (!user) return json({ error: 'not signed in' }, 401);
  const project = await store.getProject(params.pid);
  if (!project) return json({ error: 'not found' }, 404);
  const body = await request.json().catch(() => ({}));
  const sid = String(body.sid || '').trim().slice(0, 64) || `cli:${crypto.randomUUID().slice(0, 12)}`;
  const res = await store.touchPresence(params.pid, sid, user.name, now());
  return json({ active: res.active, accepted: res.accepted, present: res.present, limit: 10, sid });
});

router.post('/api/projects/:pid/presence/leave', async ({ request, params }) => {
  const body = await request.json().catch(() => ({}));
  const sid = String(body.sid || '').slice(0, 64);
  if (sid) await store.leavePresence(params.pid, sid);
  return json({ ok: true });
});

router.get('/api/projects/:pid/presence', async ({ params }) => {
  if (!(await store.getProject(params.pid))) return json({ error: 'not found' }, 404);
  const users = await store.presenceUsers(params.pid);
  return json({ active: users.length, limit: 10, users });
});

// ---- Auth ----
router.post('/api/auth/signup', async ({ request }) => {
  const body = await request.json().catch(() => ({}));
  const name = String(body.username || body.name || '').trim();
  const pw = String(body.password || '');
  const email = String(body.email || '').trim();
  if (!name || name.length < 2 || name.length > 20) return json({ error: 'username 2-20 chars' }, 400);
  if (!pw || pw.length < 4) return json({ error: 'password 4+ chars' }, 400);
  if (await store.findUserByName(name)) return json({ error: 'username taken' }, 409);
  const ip = request.headers.get('x-forwarded-for') || request.headers.get('cf-connecting-ip') || '';
  if (await store.ipUsed(ip)) return json({ error: 'too many accounts from this network' }, 429);
  const phash = await hashPw(pw);
  const u = await store.createUser({ name, phash, ip, email });
  const token = await store.createSession(u.id);
  return json({ ok: true, token, user: { id: u.id, name: u.name } }, 201);
});

router.post('/api/auth/login', async ({ request }) => {
  const body = await request.json().catch(() => ({}));
  const name = String(body.username || body.name || '').trim();
  const pw = String(body.password || '');
  if (!name || !pw) return json({ error: 'name and password required' }, 400);
  const u = await store.findUserByName(name);
  if (!u) return json({ error: 'invalid credentials' }, 401);
  if (!(await verifyPw(pw, u.phash))) return json({ error: 'invalid credentials' }, 401);
  const token = await store.createSession(u.id);
  return json({ ok: true, token, user: { id: u.id, name: u.name } });
});

router.post('/api/auth/logout', async ({ request }) => {
  const token = request.headers.get('x-ab-sess') || '';
  if (token) await store.deleteSession(token);
  return json({ ok: true });
});

router.get('/api/auth/me', async ({ request }) => {
  const user = await getUser(request);
  if (!user) return json({ error: 'not signed in' }, 401);
  return json({ id: user.id, name: user.name });
});

router.post('/api/auth/forgot', async ({ request }) => {
  const body = await request.json().catch(() => ({}));
  const name = String(body.username || body.name || '').trim();
  if (!name) return json({ error: 'name required' }, 400);
  const u = await store.findUserByName(name);
  if (!u) return json({ error: 'user not found' }, 404);
  // For Puter port, generate a temporary password and return it directly
  // (email not configured yet)
  const tempPw = crypto.randomUUID().slice(0, 12);
  const phash = await hashPw(tempPw);
  await store.resetPassword(name, phash);
  return json({ ok: true, tempPassword: tempPw, message: 'Use this temporary password to log in, then change it.' });
});

// ---- Teams ----
router.get('/api/teams', async ({ request }) => {
  const user = await getUser(request);
  if (!user) return json({ error: 'not signed in' }, 401);
  return json(await store.myTeams(user.name));
});

router.post('/api/teams', async ({ request }) => {
  const user = await getUser(request);
  if (!user) return json({ error: 'not signed in' }, 401);
  const body = await request.json().catch(() => ({}));
  const name = String(body.name || '').trim().slice(0, 40);
  if (!name) return json({ error: 'team name required' }, 400);
  return json(await store.createTeam(name, user.name), 201);
});

router.get('/api/teams/:tid', async ({ params }) => {
  const t = await store.teamInfo(params.tid);
  if (!t) return json({ error: 'not found' }, 404);
  return json(t);
});

router.get('/api/teams/join/:code', async ({ params }) => {
  const t = await store.teamByInviteCode(params.code);
  if (!t) return json({ error: 'invalid invite code' }, 404);
  return json(t);
});

router.post('/api/teams/:tid/join', async ({ request, params }) => {
  const user = await getUser(request);
  if (!user) return json({ error: 'not signed in' }, 401);
  const ok = await store.addTeamMember(params.tid, user.name);
  if (!ok) return json({ error: 'already a member or team not found' }, 400);
  return json({ ok: true });
});

router.post('/api/teams/:tid/leave', async ({ request, params }) => {
  const user = await getUser(request);
  if (!user) return json({ error: 'not signed in' }, 401);
  await store.removeTeamMember(params.tid, user.name);
  return json({ ok: true });
});

router.delete('/api/teams/:tid', async ({ request, params }) => {
  const user = await getUser(request);
  if (!user) return json({ error: 'not signed in' }, 401);
  const t = await store.teamInfo(params.tid);
  if (!t) return json({ error: 'not found' }, 404);
  if (t.owner !== user.name) return json({ error: 'only owner can delete' }, 403);
  await store.deleteTeam(params.tid);
  return json({ ok: true });
});

router.post('/api/projects/:pid/team', async ({ request, params }) => {
  const user = await getUser(request);
  if (!user) return json({ error: 'not signed in' }, 401);
  const project = await store.getProject(params.pid);
  if (!project) return json({ error: 'not found' }, 404);
  if (!(await canWrite(project, user))) return json({ error: "you don't own this project" }, 403);
  const body = await request.json().catch(() => ({}));
  const tid = String(body.team_id || '').trim();
  if (tid && !(await store.teamInfo(tid))) return json({ error: 'team not found' }, 404);
  return json(await store.setProjectTeam(params.pid, tid));
});

// ---- Features ----
router.get('/api/features', async () => {
  const rows = await sbGet('features', '?select=*&order=created_at.desc');
  // Attach vote tallies
  for (const f of rows) {
    const votes = await sbGet('feature_votes', `?select=vote&feature_id=eq.${f.id}`);
    f.votes = votes.reduce((s, v) => s + (v.vote || 0), 0);
  }
  return json(rows);
});

router.post('/api/features', async ({ request }) => {
  const user = await getUser(request);
  if (!user) return json({ error: 'not signed in' }, 401);
  const body = await request.json().catch(() => ({}));
  const title = String(body.title || '').trim().slice(0, 100);
  const description = String(body.description || '').trim().slice(0, 500);
  if (!title) return json({ error: 'title required' }, 400);
  const id = id20();
  await sbInsert('features', { id, title, description, status: 'proposed', created_by: user.name, created_at: now() });
  return json({ id, title, description, status: 'proposed', votes: 0 }, 201);
});

router.post('/api/features/:fid/vote', async ({ request, params }) => {
  const user = await getUser(request);
  if (!user) return json({ error: 'not signed in' }, 401);
  const body = await request.json().catch(() => ({}));
  const vote = Number(body.vote) || 0;
  if (vote !== 1 && vote !== -1 && vote !== 0) return json({ error: 'vote must be -1, 0, or 1' }, 400);
  await sbUpsert('feature_votes', { feature_id: params.fid, user: user.name, vote, updated_at: now() });
  const votes = await sbGet('feature_votes', `?select=vote&feature_id=eq.${params.fid}`);
  return json({ ok: true, votes: votes.reduce((s, v) => s + (v.vote || 0), 0) });
});

// ---- Chat (SSE streaming) ----
router.post('/api/chat', async ({ request }) => {
  const user = await getUser(request);
  if (!user) return json({ error: 'not signed in' }, 401);
  const body = await request.json().catch(() => ({}));
  const pid = String(body.project_id || '').trim();
  const prompt = String(body.prompt || '').trim();
  if (!pid || !prompt) return json({ error: 'project_id and prompt required' }, 400);
  const project = await store.getProject(pid);
  if (!project) return json({ error: 'project not found' }, 404);

  // Build context from file list + history
  const files = await store.listFiles(pid);
  const hist = await store.history(pid, 12);
  const fileList = files.map(f => f.path).join(', ');
  const sysParts = [
    'You are an AI code generator. Output ONLY valid code files.',
    `Project files: ${fileList || '(empty)'}`,
    'Use ===FILE: path=== headers to separate files. Use ===END=== to close a file.',
    'Output HTML, CSS, JS, or other web files.',
  ];
  const messages = [{ role: 'system', content: sysParts.join('\n') }];
  for (const h of hist) messages.push({ role: h.role, content: h.content });
  messages.push({ role: 'user', content: prompt });

  await store.addMessage(pid, 'user', prompt, user.name);

  // Try Ollama first, then OpenRouter fallback
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (evt, data) => {
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ event: evt, ...data })}\n\n`));
      };
      let fullText = '';
      try {
        // Try Ollama
        const ollamaHeaders = OLLAMA_KEY ? { Authorization: `Bearer ${OLLAMA_KEY}` } : {};
        const ollamaRes = await fetch(`${OLLAMA_URL}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...ollamaHeaders },
          body: JSON.stringify({ model: OLLAMA_MODEL, messages, stream: true }),
          signal: AbortSignal.timeout(120000),
        });
        if (!ollamaRes.ok) throw new Error(`ollama ${ollamaRes.status}`);
        const reader = ollamaRes.body.getReader();
        const dec = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = dec.decode(value);
          for (const line of chunk.split('\n')) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line);
              const token = obj.message?.content;
              if (token) { fullText += token; send('token', { token }); }
            } catch {}
          }
        }
      } catch (e1) {
        // Fallback to OpenRouter
        fullText = '';
        try {
          const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${OPENROUTER_KEY}`,
            },
            body: JSON.stringify({ model: 'google/gemini-2.5-flash', messages, stream: true }),
            signal: AbortSignal.timeout(120000),
          });
          if (!orRes.ok) throw new Error(`openrouter ${orRes.status}`);
          const reader = orRes.body.getReader();
          const dec = new TextDecoder();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = dec.decode(value);
            for (const line of chunk.split('\n')) {
              if (!line.startsWith('data: ')) continue;
              const data = line.slice(6).trim();
              if (data === '[DONE]') break;
              try {
                const obj = JSON.parse(data);
                const token = obj.choices?.[0]?.delta?.content;
                if (token) { fullText += token; send('token', { token }); }
              } catch {}
            }
          }
        } catch (e2) {
          send('error', { message: `All providers failed: ${e1.message}; ${e2.message}` });
        }
      }
      // Parse file output from AI
      if (fullText) {
        await store.addMessage(pid, 'assistant', fullText, 'ai');
        const files = parseFiles(fullText);
        for (const [path, content] of Object.entries(files)) {
          await store.saveFile(pid, path, content);
        }
        send('done', { files: Object.keys(files) });
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
  });
});

// Parse ===FILE: path=== ... ===END=== format
function parseFiles(text) {
  const files = {};
  const re = /===FILE:\s*(.+?)===([\s\S]*?)===END===/g;
  let m;
  while ((m = re.exec(text))) {
    const path = m[1].trim();
    const content = m[2].trim();
    if (path && content) files[path] = content;
  }
  return files;
}

// ---- BaaS ----
router.get('/api/baas/:pid/:coll', async ({ params }) => {
  return json(await store.baasList(params.pid, params.coll));
});

router.post('/api/baas/:pid/:coll', async ({ request, params }) => {
  const body = await request.json().catch(() => ({}));
  return json(await store.baasInsert(params.pid, params.coll, body), 201);
});

router.get('/api/baas/:pid/:coll/:rid', async ({ params }) => {
  const row = await store.baasGet(params.pid, params.coll, params.rid);
  if (!row) return json({ error: 'not found' }, 404);
  return json(row);
});

router.put('/api/baas/:pid/:coll/:rid', async ({ request, params }) => {
  const body = await request.json().catch(() => ({}));
  const result = await store.baasUpdate(params.pid, params.coll, params.rid, body);
  if (!result) return json({ error: 'not found' }, 404);
  return json(result);
});

router.delete('/api/baas/:pid/:coll/:rid', async ({ params }) => {
  const ok = await store.baasRemove(params.pid, params.coll, params.rid);
  return json({ ok });
});

// ---- 404 catch-all ----
router.get('/*path', async ({ params }) => {
  return json({ error: 'not found', path: params.path }, 404);
});

router.post('/*path', async ({ params }) => {
  return json({ error: 'not found', path: params.path }, 404);
});

// =========================================================================
// Auth + credit helpers (inlined from auth.js, credits.js)
// =========================================================================
async function canWrite(project, user) {
  if (!user) return false;
  if (project.owner === user.name) return true;
  if (project.team_id) return store.isTeamMember(project.team_id, user.name);
  return false;
}

async function personalBalance(user, day) {
  const dayCreds = FREE_DAILY_CREDITS * UNITS_PER_CREDIT;
  const spent = await store.getCredits(user.id, day);
  const earned = await store.earningsUnits(user.name);
  const leftUnits = Math.max(0, dayCreds - spent) + earned;
  return {
    totalUnits: dayCreds, totalCredits: FREE_DAILY_CREDITS,
    spent, earned, leftUnits,
    leftCredits: unitsToCredits(leftUnits),
  };
}

async function teamPool(teamId, day) {
  const members = await store.teamMembers(teamId);
  const memberCount = members.length;
  const totalUnits = memberCount * FREE_DAILY_CREDITS * UNITS_PER_CREDIT;
  const poolKey = store.teamCreditKey(teamId);
  const usedUnits = await store.creditGet(poolKey, day);
  const teamNames = members.map(m => `user:${m}`);
  const earnedUnits = await store.earningsUnitsForNames(teamNames);
  return { memberCount, totalUnits, usedUnits, leftUnits: Math.max(0, totalUnits - usedUnits) + earnedUnits };
}

// =========================================================================
// Preview (live HTML preview of projects)
// =========================================================================
const MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  woff: 'font/woff', woff2: 'font/woff2',
};

function safePath(raw) {
  let p;
  try { p = decodeURIComponent(raw); } catch { return null; }
  if (p.includes('\0')) return null;
  const segs = p.split('/').filter(s => s !== '');
  if (segs.some(seg => seg === '..')) return null;
  return segs.join('/');
}

function fromBase64(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

// BaaS SDK — injected into previewed HTML pages
const BAAS_SDK = `(function () {
  var base = '/api/baas/' + window.__CREAT_PROJECT__;
  var pid = window.__CREAT_PROJECT__;
  var TOK_KEY = 'ab_app_tok';
  function tok() { try { return localStorage.getItem(TOK_KEY) || ''; } catch (e) { return ''; } }
  function authHeaders(extra) { var h = extra || {}; if (tok()) h['x-ab-sess'] = tok(); return h; }
  function friendlyError(s) {
    if (s===429)return'Whoopsie! The server hit its head — too much traffic. Come back later!';
    if (s===404)return"Whoopsie! The server hit its head — project might not exist or has been deleted!";
    if(s===403)return"You don't have permission for this.";
    if(s===500)return'Whoopsie! The server hit its head — something went wrong.';
    return'Whoopsie! Something went wrong.';
  }
  function req(method,parts,body){
    return fetch([base].concat(parts.filter(Boolean)).join('/'),{
      method:method,headers:body?authHeaders({'content-type':'application/json'}):undefined,
      body:body?JSON.stringify(body):undefined
    }).then(function(r){return r.text().then(function(t){
      var d=t?JSON.parse(t):null;
      if(!r.ok){var m=friendlyError(r.status);if(r.status===404)m+=' <a href="/" style="color:#7c5cff;text-decoration:underline">Create one here</a>';throw new Error(m);}return d;});});
  }
  var SB_URL='https://trwxpgmkpaddnyktbleg.supabase.co';
  var SB_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRyd3hwZ21rcGFkZG55a3RibGVnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc2MzE3NjIsImV4cCI6MjEwMzIwNzc2Mn0.nJJUwuhMNq_8-3ShvpEUhkVz_DLPVklIid5BVSO8GDE';
  var _sb=null;function getSB(){if(_sb)return _sb;if(typeof window.supabase==='undefined')throw new Error('Supabase client not loaded');_sb=window.supabase.createClient(SB_URL,SB_KEY);return _sb;}
  var _mc=null;function getIdentity(){return new Promise(function(r){if(_mc)return r(_mc);fetch('/api/auth/me',authHeaders()).then(function(res){if(res.status===401)return r('anon #'+Math.random().toString(36).slice(2,8));return res.json().then(function(j){_mc=j.name||('anon #'+Math.random().toString(36).slice(2,8));r(_mc);});}).catch(function(){r('anon #'+Math.random().toString(36).slice(2,8));});});}
  window.creat={
    db:{list:function(c){return req('GET',[c]);},insert:function(c,o){return req('POST',[c],o);},get:function(c,id){return req('GET',[c,id]);},update:function(c,id,p){return req('PUT',[c,id],p);},remove:function(c,id){return req('DELETE',[c,id]);}},
    live:function(coll,cb){var ch='live:'+pid+':'+coll;var sb=getSB();var subs=[cb];var my=null;var channel=sb.channel(ch);channel.on('broadcast',{event:'evt'},function(p){for(var i=0;i<subs.length;i++)try{subs[i](p.payload);}catch{}}).subscribe(function(s){if(s==='SUBSCRIBED')getIdentity().then(function(n){my=n;});});return{myName:function(){return my;},subscribe:function(fn){subs.push(fn);return function(){subs=subs.filter(function(f){return f!==fn;});};},close:function(){sb.removeChannel(channel);subs=[];},history:function(o){o=o||{};return fetch('/api/projects/'+pid+'/live/baas-'+coll+'?limit='+(Number(o.limit)||50),authHeaders()).then(function(r){return r.json().then(function(j){return j.messages||[];});});},since:function(s){return fetch('/api/projects/'+pid+'/live/baas-'+coll+'?since='+(Number(s)||0),authHeaders()).then(function(r){return r.json().then(function(j){return j.messages||[];});});},seq:function(){return fetch('/api/projects/'+pid+'/live/baas-'+coll+'?since=0&limit=1',authHeaders()).then(function(r){return r.json().then(function(j){return j.seq||0;});});}};},
    push:function(coll,evt){var ch='live:'+pid+':'+coll;var sb=getSB();return getIdentity().then(function(name){var c=sb.channel(ch);var p={type:'message',user:name,data:evt||{},ts:Date.now()};c.send({type:'broadcast',event:'evt',payload:p});return fetch('/api/projects/'+pid+'/live/baas-'+coll+'/push',{method:'POST',headers:authHeaders({'content-type':'application/json'}),body:JSON.stringify({data:evt||{},_user:name})}).then(function(r){return r.ok?r.json().then(function(j){return j.seq||0;}):0;}).catch(function(){return 0;});});},
    server:function(name){if(!/^[a-z0-9_-]{1,32}$/.test(name))throw new Error('server name: a-z0-9-_ max 32');var ch='srv:'+pid+':'+name;var sb=getSB();var subs=[];var my=null;var c=sb.channel(ch);c.on('broadcast',{event:'evt'},function(p){for(var i=0;i<subs.length;i++)try{subs[i](p.payload);}catch{}}).subscribe(function(s){if(s==='SUBSCRIBED')getIdentity().then(function(n){my=n;});});return{myName:function(){return my;},push:function(evt){return getIdentity().then(function(name){c.send({type:'broadcast',event:'evt',payload:{type:'message',user:name,data:evt||{},ts:Date.now()}});});},subscribe:function(cb){subs.push(cb);return function(){subs=subs.filter(function(f){return f!==cb;});};},close:function(){try{sb.removeChannel(c);}catch{}subs=[];},history:function(o){o=o||{};return fetch('/api/projects/'+pid+'/live/srv:'+name+'?limit='+(Number(o.limit)||50),authHeaders()).then(function(r){return r.json().then(function(j){return j.messages||[];});});},since:function(s){return fetch('/api/projects/'+pid+'/live/srv:'+name+'?since='+(Number(s)||0),authHeaders()).then(function(r){return r.json().then(function(j){return j.messages||[];});});},seq:function(){return fetch('/api/projects/'+pid+'/live/srv:'+name+'?since=0&limit=1',authHeaders()).then(function(r){return r.json().then(function(j){return j.seq||0;});});}};},
    chat:{room:function(rn){rn=/^[a-z0-9_-]{1,32}$/.test(rn||'')?rn:'main';var ch='live:'+pid+':chat:'+rn;var subs=[];var channel=null;function connect(){if(channel)return channel;var sb=getSB();channel=sb.channel(ch);channel.on('broadcast',{event:'evt'},function(p){for(var i=0;i<subs.length;i++)try{subs[i](p.payload);}catch{}}).subscribe();return channel;}return{name:rn,send:function(t){return fetch('/api/projects/'+pid+'/chat/send',{method:'POST',headers:authHeaders({'content-type':'application/json'}),body:JSON.stringify({room:rn,text:String(t==null?'':t)})}).then(function(r){return r.text().then(function(t){var j=t?JSON.parse(t):{};if(!r.ok)throw new Error(j.error||friendlyError(r.status));return j.message;});});},list:function(o){o=o||{};var q='room='+encodeURIComponent(rn)+'&since='+(Number(o.since)||0)+'&limit='+Math.max(1,Math.min(200,Number(o.limit)||50));return fetch('/api/projects/'+pid+'/chat/list?'+q,authHeaders()).then(function(r){return r.text().then(function(t){var j=t?JSON.parse(t):{};if(!r.ok)throw new Error(j.error||friendlyError(r.status));return j.messages||[];});});},history:function(o){return this.list(o);},latest:function(){return fetch('/api/projects/'+pid+'/chat/list?room='+encodeURIComponent(rn)+'&since=0&limit=1',authHeaders()).then(function(r){return r.json().then(function(j){return j.seq||0;});});},on:function(cb){subs.push(cb);connect();return function(){subs=subs.filter(function(f){return f!==cb;});};},close:function(){if(channel){try{getSB().removeChannel(channel);}catch{}channel=null;}subs=[];}};}},
    call:function(n,input){return fetch('/api/projects/'+pid+'/fn/'+n,{method:'POST',headers:authHeaders({'content-type':'application/json'}),body:JSON.stringify({input:input===undefined?null:input})}).then(function(r){return r.text().then(function(t){var j=t?JSON.parse(t):{};if(!r.ok){var m=friendlyError(r.status);if(r.status===404)m+=' <a href="/" style="color:#7c5cff;text-decoration:underline">Create one here</a>';throw new Error(m);}return j.result;});});},
    credits:{balance:function(){return fetch('/api/credits',authHeaders()).then(function(r){return r.text().then(function(t){var j=t?JSON.parse(t):{};if(!r.ok)throw new Error(j.error||friendlyError(r.status));return j.credits||j;});});},gift:function(to,a){a=Number(a);if(!/^[a-zA-Z0-9_-]{3,24}$/.test(String(to||'').trim()))return Promise.reject(new Error('gift: username 3-24 chars'));if(!Number.isFinite(a)||a<=0)return Promise.reject(new Error('gift: positive amount'));var tgt=String(to).trim();return fetch('/api/credits/gift',{method:'POST',headers:authHeaders({'content-type':'application/json'}),body:JSON.stringify({to:tgt,amount:a})}).then(function(r){return r.text().then(function(t){var j=t?JSON.parse(t):{};if(!r.ok)throw new Error(j.error||friendlyError(r.status));return j;});});}},
    me:function(){return fetch('/api/auth/me',authHeaders()).then(function(r){if(r.status===401)return null;return r.json().then(function(j){return{name:j.name};});}).catch(function(){return null;});}
  };
})();`;

function injectPreview(html, pid) {
  const errHook = `<script>(function(){function r(m){try{parent.postMessage({__ab:'error',message:String(m).slice(0,300)},'*')}catch(e){}}` +
    `window.addEventListener('error',function(e){r(e.message||'script error')});` +
    `window.addEventListener('unhandledrejection',function(e){var x=e.reason;r('Unhandled promise rejection: '+(x&&x.message||x))});})();</script>`;
  const sdk = `<script>window.__CREAT_PROJECT__='${pid}';</script>` +
    `<script type="text/javascript">${BAAS_SDK}</script>` +
    `<script src='https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js'></script>` +
    errHook;
  const headMatch = html.match(/<head([^>]*)>/i);
  if (headMatch) return html.replace(/<head([^>]*)>/i, (m, attrs) => `<head${attrs}>${sdk}`);
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${sdk}</head>`);
  return sdk + html;
}

async function visitorKeyPreview(request) {
  const user = await getUser(request);
  if (user && user.name) return `user:${user.name}`;
  const ip = request.headers.get('x-forwarded-for') || request.headers.get('cf-connecting-ip') || '';
  return ip ? `ip:${ip}` : '';
}

async function servePreviewFile(request, pid, rawPath) {
  const p = safePath(rawPath);
  if (p === null) return new Response('bad path', { status: 400 });
  let target = p === '' ? 'index.html' : p;
  if (target === 'functions' || target.startsWith('functions/'))
    return new Response('not found', { status: 404 });

  let row = await store.getFile(pid, target);
  if (!row && target !== 'index.html') row = await store.getFile(pid, target + '/index.html');
  if (!row) {
    if (!(await store.getProject(pid))) return new Response('unknown project', { status: 404 });
    if (target === 'index.html') {
      try { await store.recordInteraction(pid, await visitorKeyPreview(request)); } catch {}
      return new Response(
        `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#0f1115;color:#9aa4b2;display:grid;place-items:center;height:100vh;margin:0">` +
        `<div style="text-align:center"><h2 style="color:#e6edf3">Whoopsie! The server hit its head</h2>` +
        `<p>Project <code>${pid}</code> might not exist or has been deleted!</p>` +
        `<a href="/" style="display:inline-block;margin-top:16px;padding:10px 20px;background:#7c5cff;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Create one here</a></div>`,
        { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
      );
    }
    return new Response('not found', { status: 404 });
  }

  const ext = (target.split('.').pop() || '').toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const content = row.encoding === 'base64' ? new TextDecoder().decode(fromBase64(row.content)) : row.content;
  const body = type.startsWith('text/html') && row.encoding !== 'base64'
    ? injectPreview(row.content, pid) : content;
  if (type.startsWith('text/html')) {
    try { await store.recordInteraction(pid, await visitorKeyPreview(request)); } catch {}
  }
  return new Response(body, {
    status: 200,
    headers: { 'content-type': type, 'cache-control': 'no-store' },
  });
}

// Preview routes
router.get('/preview/:pid', async ({ request, params }) => {
  return servePreviewFile(request, params.pid, '');
});

router.get('/preview/:pid/*path', async ({ request, params }) => {
  const subpath = params.path || '';
  return servePreviewFile(request, params.pid, subpath);
});
