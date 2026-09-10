// Postgres implementation of the same store interface as db.js / store-d1.js.
// Drop-in replacement surface — see supabase-v1.sql for the schema.
//
// Differences vs D1 (encapsulated here, invisible to callers):
//   * BaaS collections collapse into a single a1_baas JSONB table (Postgres
//     cannot runtime-DDL through PostgREST).
//   * usage/earnings counters go through SQL functions (a1_incr_rate,
//     a1_earn, a1_spend) so increments are atomic under concurrency.
//   * events.seq is a Postgres identity column (same global-seq semantics
//     as D1 AUTOINCREMENT).
//
// Server-side only: uses the service_role key, which bypasses RLS. Every table
// is RLS-enabled with no policies, so nothing leaks to anon/authenticated.

import { creditsToUnits } from './models.js';
import { hashEmail } from './hash-email.js';
import { encryptText, decryptText } from './encrypt.js';
import { createClient } from '@supabase/supabase-js';
import { getVar } from './env.js';

const SUPABASE_URL = getVar('SUPABASE_URL') || 'https://trwxpgmkpaddnyktbleg.supabase.co';

let _client = null;
function client() {
  if (!_client) {
    _client = createClient(SUPABASE_URL, getVar('SUPABASE_SERVICE_KEY') || '', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { 'apikey': getVar('SUPABASE_SERVICE_KEY') || '' } },
    });
  }
  return _client;
}

// Anti-abuse: allow a small number of signups per network before locking.
const MAX_ACCOUNTS_PER_IP = 3;

function slugify(name) {
  const s = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (s || 'app').slice(0, 40);
}

export function createPgStore() {
  return {
    // ---- projects -----------------------------------------------------------
    async createProject(name, owner) {
      const p = { id: crypto.randomUUID().replace(/-/g, '').slice(0, 20), name: name || 'Untitled app', created_at: Date.now() };
      const { error } = await client().from('projects').insert({ ...p, owner: owner || '' });
      if (error) throw new Error(`db create project: ${error.message}`);
      return { ...p, owner: owner || '', published: 0, slug: null, description: '', model: '', plan: null };
    },
    async listProjects() {
      const { data, error } = await client().from('projects').select('*').order('created_at', { ascending: false });
      if (error) throw new Error(`db list projects: ${error.message}`);
      return data || [];
    },
    async getProject(pid) {
      const { data, error } = await client().from('projects').select('*').eq('id', pid).maybeSingle();
      if (error) throw new Error(`db get project: ${error.message}`);
      return data || null;
    },
    async deleteProject(pid) {
      const { error } = await client().from('projects').delete().eq('id', pid);
      if (error) throw new Error(`db delete project: ${error.message}`);
      return { ok: true };
    },
    async setModel(pid, model) {
      if (!/^[A-Za-z0-9._:+%-]{1,64}$/.test(model || '')) return;
      await client().from('projects').update({ model }).eq('id', pid);
    },
    async setPublished(pid, publish, description) {
      const p = await this.getProject(pid);
      if (!p) throw new Error('not found');
      let slug = p.slug;
      if (publish && !slug) {
        slug = slugify(p.name);
        for (let i = 2; ; i++) {
          const { data: hit } = await client().from('projects').select('id').eq('slug', slug).maybeSingle();
          if (!hit) break;
          slug = `${slugify(p.name)}-${i}`;
        }
      }
      const desc = description !== undefined && description !== null
        ? String(description) : (p.description ?? '');
      const { error } = await client().from('projects')
        .update({ published: publish ? 1 : 0, slug: publish ? slug : slug, description: desc })
        .eq('id', pid);
      if (error) throw new Error(`db set published: ${error.message}`);
      return this.getProject(pid);
    },
    async discover() {
      const { data, error } = await client().from('projects')
        .select('id, slug, name, description, created_at')
        .eq('published', 1).order('created_at', { ascending: false });
      if (error) throw new Error(`db discover: ${error.message}`);
      return data || [];
    },
    async remix(srcPid) {
      const src = await this.getProject(srcPid);
      if (!src) return null;
      const copy = await this.createProject(`${src.name} (remix)`);
      const { data: files } = await client().from('files')
        .select('path, content, encoding').eq('project_id', srcPid);
      for (const f of files || []) {
        if (f.content == null) continue;
        await this.saveFile(copy.id, f.path, await decryptText(f.content), f.encoding || 'utf8');
      }
      if (src.description) {
        const { error } = await client().from('projects').update({ description: src.description }).eq('id', copy.id);
        if (error) throw new Error(`db remix: ${error.message}`);
      }
      return copy;
    },

    // ---- files --------------------------------------------------------------
    async saveFile(pid, fpath, content, encoding = 'utf8') {
      const stored = await encryptText(content);
      const { error } = await client().from('files').upsert(
        { project_id: pid, path: fpath, content: stored, encoding, updated_at: Date.now() },
        { onConflict: 'project_id,path' });
      if (error) throw new Error(`db save file: ${error.message}`);
      await this.recordVersion(pid, fpath, content, encoding);
    },
    async recordVersion(pid, fpath, content, encoding) {
      const { data: max } = await client().from('file_versions')
        .select('seq').eq('project_id', pid).eq('path', fpath).order('seq', { ascending: false }).limit(1).maybeSingle();
      const s = (max?.seq || 0) + 1;
      const { error } = await client().from('file_versions').insert({
        project_id: pid, path: fpath, seq: s, content: await encryptText(content), encoding: encoding || 'utf8', updated_at: Date.now(),
      });
      if (error) throw new Error(`db record version: ${error.message}`);
      const { error: dErr } = await client().from('file_versions')
        .delete().eq('project_id', pid).eq('path', fpath).lt('seq', s - 59);
      if (dErr) throw new Error(`db prune versions: ${dErr.message}`);
    },
    async getFile(pid, fpath) {
      const { data: row, error } = await client().from('files')
        .select('*').eq('project_id', pid).eq('path', fpath).maybeSingle();
      if (error) throw new Error(`db get file: ${error.message}`);
      if (row) row.content = await decryptText(row.content);
      return row || null;
    },
    async listFiles(pid) {
      const { data, error } = await client().from('files')
        .select('path, updated_at').eq('project_id', pid).order('path', { ascending: true });
      if (error) throw new Error(`db list files: ${error.message}`);
      return data || [];
    },
    async listFilesWithContent(pid) {
      const { data, error } = await client().from('files')
        .select('path, content, encoding, updated_at').eq('project_id', pid).order('path', { ascending: true });
      if (error) throw new Error(`db list files w/ content: ${error.message}`);
      for (const r of data || []) r.content = await decryptText(r.content);
      return data || [];
    },
    async deleteFile(pid, fpath) {
      await client().from('files').delete().eq('project_id', pid).eq('path', fpath);
      const { data: max } = await client().from('file_versions')
        .select('seq').eq('project_id', pid).eq('path', fpath).order('seq', { ascending: false }).limit(1).maybeSingle();
      await client().from('file_versions').insert({
        project_id: pid, path: fpath, seq: (max?.seq || 0) + 1, content: null, updated_at: Date.now(),
      });
      return { ok: true };
    },
    async fileVersions(pid, fpath) {
      const { data, error } = await client().from('file_versions')
        .select('seq, updated_at, content, encoding').eq('project_id', pid).eq('path', fpath)
        .order('seq', { ascending: false });
      if (error) throw new Error(`db file versions: ${error.message}`);
      return (data || []).map((v) => ({
        seq: v.seq, updated_at: v.updated_at,
        deleted: v.content == null, bytes: v.content == null ? null : v.content.length,
      }));
    },
    async getFileVersion(pid, fpath, seq) {
      const { data: v, error } = await client().from('file_versions')
        .select('seq, content, encoding, updated_at').eq('project_id', pid).eq('path', fpath).eq('seq', seq).maybeSingle();
      if (error) throw new Error(`db get file version: ${error.message}`);
      if (v && v.content != null) v.content = await decryptText(v.content);
      return v || null;
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

    // ---- snapshots ----------------------------------------------------------
    async listSnapshots(pid) {
      const { data, error } = await client().from('snapshots')
        .select('id, created_at, label, files:snapshot_files(count)')
        .eq('project_id', pid).order('created_at', { ascending: false });
      if (error) throw new Error(`db list snapshots: ${error.message}`);
      return (data || []).map((s) => ({
        id: s.id, created_at: s.created_at, label: s.label,
        files: Array.isArray(s.files) ? s.files[0]?.count ?? 0 : 0,
      }));
    },
    async takeSnapshot(pid, label) {
      const id = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
      const { error: sErr } = await client().from('snapshots').insert({
        id, project_id: pid, created_at: Date.now(), label: String(label || '').slice(0, 80),
      });
      if (sErr) throw new Error(`db take snapshot: ${sErr.message}`);
      const { data: files } = await client().from('files')
        .select('path, content, encoding').eq('project_id', pid);
      if (files?.length) {
        await client().from('snapshot_files').insert(
          (files || []).map((f) => ({
            snapshot_id: id, path: f.path, content: f.content, encoding: f.encoding || 'utf8',
          })));
      }
      const { data: keep } = await client().from('snapshots')
        .select('id').eq('project_id', pid).order('created_at', { ascending: false }).limit(20);
      const keepIds = (keep || []).map((s) => s.id);
      await client().from('snapshots').delete().eq('project_id', pid).not('id', 'in', `(${keepIds.join(',')})`);
      return { id, pid, created_at: Date.now(), label: String(label || '').slice(0, 80) };
    },
    async getSnapshot(pid, sid) {
      const { data: s, error } = await client().from('snapshots')
        .select('*').eq('id', sid).eq('project_id', pid).maybeSingle();
      if (error) throw new Error(`db get snapshot: ${error.message}`);
      if (!s) return null;
      const { data: fs, error: fErr } = await client().from('snapshot_files')
        .select('path, content, encoding').eq('snapshot_id', sid).order('path', { ascending: true });
      if (fErr) throw new Error(`db get snapshot files: ${fErr.message}`);
      s.files = (fs || []).map((f) => ({ ...f, content: undefined })); // fill below
      for (let i = 0; i < (fs || []).length; i++) s.files[i].content = await decryptText(fs[i].content);
      return s;
    },
    async restoreSnapshot(pid, sid) {
      const s = await this.getSnapshot(pid, sid);
      if (!s) throw new Error('snapshot not found');
      const have = await this.listFiles(pid);
      const keep = new Set(s.files.map((f) => f.path));
      for (const f of s.files) await this.saveFile(pid, f.path, f.content, f.encoding || 'utf8');
      for (const f of have) if (!keep.has(f.path)) await this.deleteFile(pid, f.path);
      return { ok: true, files: s.files.length };
    },

    // ---- chat history -------------------------------------------------------
    async addMessage(pid, role, content, user = '') {
      const { error } = await client().from('messages').insert({
        project_id: pid, role, content: await encryptText(content), user, created_at: Date.now(),
      });
      if (error) throw new Error(`db add message: ${error.message}`);
    },
    async history(pid, limit = 12) {
      const { data, error } = await client().from('messages')
        .select('role, content, user').eq('project_id', pid)
        .order('created_at', { ascending: false }).limit(Math.max(1, Number(limit) || 12));
      if (error) throw new Error(`db history: ${error.message}`);
      const rows = (data || []).slice().reverse();
      for (const r of rows) r.content = await decryptText(r.content);
      return rows;
    },

    // ---- plan & rename ------------------------------------------------------
    async setPlan(pid, plan) {
      const { error } = await client().from('projects')
        .update({ plan: plan == null ? null : JSON.stringify(plan) }).eq('id', pid);
      if (error) throw new Error(`db set plan: ${error.message}`);
    },
    async rename(pid, name) {
      const p = await this.getProject(pid);
      if (!p) throw new Error('not found');
      const { error } = await client().from('projects').update({ name }).eq('id', pid);
      if (error) throw new Error(`db rename: ${error.message}`);
      return { ...p, name };
    },

    // ---- usage & credits ----------------------------------------------------
    async incrUsage(name, day) {
      const { data, error } = await client().rpc('a1_incr_rate', { _name: name, _day: day, _amount: 1 });
      if (error) throw new Error(`db incr usage: ${error.message}`);
      return data || 0;
    },
    creditsKey(userId) {
      return `credit:${userId}`;
    },
    async getCredits(userId, day) {
      const { data, error } = await client().from('a1_usage').select('count')
        .eq('name', this.creditsKey(userId)).eq('day', day).maybeSingle();
      if (error) throw new Error(`db get credits: ${error.message}`);
      return data?.count ?? 0;
    },
    async spendCredits(userId, day, amount) {
      const { data, error } = await client().rpc('a1_incr_rate', {
        _name: this.creditsKey(userId), _day: day, _amount: amount,
      });
      if (error) throw new Error(`db spend credits: ${error.message}`);
      return data || 0;
    },
    async creditGet(key, day) {
      const { data, error } = await client().from('a1_usage').select('count')
        .eq('name', key).eq('day', day).maybeSingle();
      if (error) throw new Error(`db credit get: ${error.message}`);
      return data?.count ?? 0;
    },
    async creditSpend(key, day, amount) {
      const { data, error } = await client().rpc('a1_incr_rate', { _name: key, _day: day, _amount: amount });
      if (error) throw new Error(`db credit spend: ${error.message}`);
      return data || 0;
    },
    teamCreditKey(teamId) {
      return `credit:team:${teamId}`;
    },
    async earningsUnits(name) {
      const { data, error } = await client().from('earnings').select('units')
        .eq('name', name).maybeSingle();
      if (error) throw new Error(`db earnings: ${error.message}`);
      return data?.units ?? 0;
    },
    async earningsUnitsForNames(names) {
      if (!names || !names.length) return 0;
      const { data, error } = await client().from('earnings')
        .select('units').in('name', names);
      if (error) throw new Error(`db earnings names: ${error.message}`);
      return (data || []).reduce((s, r) => s + (r.units || 0), 0);
    },
    async earnCredits(name, units) {
      const { error } = await client().rpc('a1_earn', { _name: name, _units: units });
      if (error) throw new Error(`db earn: ${error.message}`);
    },
    async spendEarnings(name, units) {
      const { data, error } = await client().rpc('a1_spend', { _name: name, _units: units });
      if (error) throw new Error(`db spend earnings: ${error.message}`);
      return data ?? 0;
    },

    // ---- teams --------------------------------------------------------------
    async createTeam(name, owner) {
      const id = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
      const CHS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let code = '';
      for (let tries = 0; tries < 5; tries++) {
        code = Array.from(crypto.getRandomValues(new Uint8Array(8)))
          .map((b) => CHS[b % CHS.length]).join('');
        const { data: clash } = await client().from('teams').select('id').eq('invite_code', code).maybeSingle();
        if (!clash) break;
      }
      const { error } = await client().from('teams').insert({ id, name, owner, invite_code: code, created_at: Date.now() });
      if (error) throw new Error(`db create team: ${error.message}`);
      await client().from('team_members').insert({ team_id: id, name: owner, joined_at: Date.now() });
      return this.teamInfo(id);
    },
    async teamInfo(tid) {
      const { data: t, error } = await client().from('teams').select('*').eq('id', tid).maybeSingle();
      if (error) throw new Error(`db team info: ${error.message}`);
      if (!t) return null;
      const { data: members } = await client().from('team_members')
        .select('name').eq('team_id', tid).order('joined_at', { ascending: true });
      t.members = (members || []).map((r) => r.name);
      return t;
    },
    async teamByInviteCode(code) {
      const { data: t, error } = await client().from('teams').select('*').eq('invite_code', code).maybeSingle();
      if (error) throw new Error(`db team by invite: ${error.message}`);
      if (!t) return null;
      const { data: m } = await client().from('team_members').select('name').eq('team_id', t.id);
      return { id: t.id, name: t.name, owner: t.owner, members: (m || []).length };
    },
    async teamMembers(tid) {
      const { data, error } = await client().from('team_members')
        .select('name').eq('team_id', tid).order('joined_at', { ascending: true });
      if (error) throw new Error(`db team members: ${error.message}`);
      return (data || []).map((r) => r.name);
    },
    async addTeamMember(tid, name, joinedAt = Date.now()) {
      try {
        const { error } = await client().from('team_members').insert({ team_id: tid, name, joined_at: joinedAt });
        if (error) return false;
        return true;
      } catch { return false; }
    },
    async removeTeamMember(tid, name) {
      await client().from('team_members').delete().eq('team_id', tid).eq('name', name);
      const { data: r } = await client().from('team_members').select('name').eq('team_id', tid);
      if (!(r || []).length) await client().from('teams').delete().eq('id', tid);
    },
    async myTeams(name) {
      const { data: owned } = await client().from('teams').select('*').eq('owner', name).order('created_at', { ascending: false });
      const { data: memberRows } = await client().from('team_members').select('team_id, teams(*)').eq('name', name);
      const seen = new Map();
      for (const t of owned || []) seen.set(t.id, t);
      for (const mr of memberRows || []) if (mr.teams && !seen.has(mr.teams.id)) seen.set(mr.teams.id, mr.teams);
      const ids = [...seen.keys()];
      let counts = {};
      if (ids.length) {
        const { data } = await client().from('team_members').select('team_id, name').in('team_id', ids);
        for (const r of data || []) counts[r.team_id] = (counts[r.team_id] || 0) + 1;
      }
      return [...seen.values()].map((t) => ({ ...t, members: counts[t.id] || 0 }))
        .sort((a, b) => b.created_at - a.created_at);
    },
    async myTeamIds(name) {
      const { data, error } = await client().from('team_members').select('team_id').eq('name', name);
      if (error) throw new Error(`db my team ids: ${error.message}`);
      return (data || []).map((r) => r.team_id);
    },
    async isTeamMember(tid, name) {
      const { data, error } = await client().from('team_members')
        .select('team_id').eq('team_id', tid).eq('name', name).maybeSingle();
      if (error) throw new Error(`db is team member: ${error.message}`);
      return Boolean(data);
    },
    async setProjectTeam(pid, tid) {
      const { error } = await client().from('projects').update({ team_id: tid || '' }).eq('id', pid);
      if (error) throw new Error(`db set project team: ${error.message}`);
      return this.getProject(pid);
    },
    async deleteTeam(tid) {
      await client().from('team_members').delete().eq('team_id', tid);
      await client().from('projects').update({ team_id: '' }).eq('team_id', tid);
      await client().from('teams').delete().eq('id', tid);
      return { ok: true };
    },

    // ---- credit exchange: interactions --------------------------------------
    async recordInteraction(pid, visitorKey, day) {
      const p = await this.getProject(pid);
      if (!p || !p.published || !p.owner) return { ok: false, created: false };
      const vid = String(visitorKey || '');
      if (!vid) return { ok: false, created: false };
      if (vid === `user:${p.owner}`) return { ok: false, created: false };
      if (p.team_id && vid.startsWith('user:')) {
        if (await this.isTeamMember(p.team_id, vid.slice(5))) return { ok: false, created: false };
      }
      const { error } = await client().from('interactions').insert({
        project_id: p.id, day: day || new Date().toISOString().slice(0, 10), key: vid, created_at: Date.now(),
      });
      if (error) return { ok: true, created: false };
      await this.earnCredits(p.owner, creditsToUnits(1));
      return { ok: true, created: true, project_id: p.id };
    },
    async interactionsToday(pid, day) {
      const { data, error } = await client().from('interactions')
        .select('key').eq('project_id', pid).eq('day', day || new Date().toISOString().slice(0, 10));
      if (error) throw new Error(`db interactions today: ${error.message}`);
      return (data || []).length;
    },

    // ---- live presence ------------------------------------------------------
    PRESENCE_WINDOW_MS: 30000,
    async touchPresence(pid, sid, userName, now = Date.now()) {
      await client().from('presence').delete().lt('seen_at', now - this.PRESENCE_WINDOW_MS);
      const { data: had } = await client().from('presence')
        .select('pid').eq('pid', pid).eq('sid', sid).maybeSingle();
      if (!had) {
        const { data: all } = await client().from('presence').select('sid').eq('pid', pid);
        const cnt = (all || []).length;
        if (cnt >= 10) {
          const activeRows = await client().from('presence').select('sid').eq('pid', pid).gt('seen_at', now - this.PRESENCE_WINDOW_MS);
          return { active: (activeRows.data || []).length, accepted: false, present: false };
        }
        const { error } = await client().from('presence').insert({ pid, sid, user: userName || '', seen_at: now });
        if (error) throw new Error(`db touch presence: ${error.message}`);
      } else {
        const { error } = await client().from('presence')
          .update({ user: userName || '', seen_at: now }).eq('pid', pid).eq('sid', sid);
        if (error) throw new Error(`db touch presence: ${error.message}`);
      }
      const activeRows = await client().from('presence').select('sid').eq('pid', pid).gt('seen_at', now - this.PRESENCE_WINDOW_MS);
      return { active: (activeRows.data || []).length, accepted: true, present: Boolean(had) };
    },
    async leavePresence(pid, sid) {
      await client().from('presence').delete().eq('pid', pid).eq('sid', sid);
    },
    async presenceUsers(pid) {
      const now = Date.now();
      await client().from('presence').delete().lt('seen_at', now - this.PRESENCE_WINDOW_MS);
      const { data } = await client().from('presence')
        .select('user').eq('pid', pid).neq('user', '').order('seen_at', { ascending: false }).limit(20);
      const seen = new Set();
      const out = [];
      for (const r of data || []) { if (!seen.has(r.user)) { seen.add(r.user); out.push(r.user); } }
      return out;
    },

    // ---- accounts & sessions ------------------------------------------------
    async createUser({ name, phash, ip, email }) {
      const id = crypto.randomUUID();
      try {
        const { error } = await client().from('users').insert({
          id, name, phash, email: await hashEmail(email), created_at: Date.now(), ip: ip || '',
        });
        if (error) throw error;
        return { id, name, email: email || '' };
      } catch {
        throw new Error('username already taken');
      }
    },
    async deleteUser(user) {
      const id = user.id, name = user.name;
      const { data: owned } = await client().from('projects').select('id').eq('owner', name);
      for (const p of owned || []) {
        await this.deleteProject(p.id);
      }
      if ((owned || []).length) {
        const ids = owned.map((p) => p.id).join(',');
        await client().from('a1_baas').delete().in('pid', owned.map((p) => p.id));
        await client().from('presence').delete().in('pid', owned.map((p) => p.id));
      }
      await client().from('sessions').delete().eq('user_id', id);
      await client().from('team_members').delete().eq('name', name);
      await client().from('teams').delete().eq('owner', name);
      await client().from('a1_usage').delete().like('name', `credit:${id}%`);
      await client().from('earnings').delete().eq('name', name);
      await client().from('users').delete().eq('id', id);
    },
    async ipUsed(ip) {
      if (!ip) return null;
      const { data } = await client().from('users').select('name').eq('ip', ip);
      if (!data || data.length < MAX_ACCOUNTS_PER_IP) return null;
      return data[0].name;
    },
    async resetPassword(name, phash) {
      const { data: u } = await client().from('users').select('*').eq('name', name).maybeSingle();
      if (!u) return null;
      await client().from('users').update({ phash }).eq('id', u.id);
      return { ...u, phash };
    },
    async updateUserIp(name, ipTag) {
      const { data: u } = await client().from('users').select('*').eq('name', name).maybeSingle();
      if (u && !u.ip) await client().from('users').update({ ip: ipTag }).eq('id', u.id);
    },
    async findUserByName(name) {
      const { data, error } = await client().from('users').select('*').eq('name', name).maybeSingle();
      if (error) throw new Error(`db find user: ${error.message}`);
      return data || null;
    },
    async findUserById(id) {
      const { data, error } = await client().from('users').select('*').eq('id', id).maybeSingle();
      if (error) throw new Error(`db find user by id: ${error.message}`);
      return data || null;
    },
    async verifyUser(name) {
      await client().from('users').update({ verified: 1 }).eq('name', name);
    },
    async createSession(userId, days = 30) {
      const token = [...crypto.getRandomValues(new Uint8Array(24))]
        .map((b) => b.toString(16).padStart(2, '0')).join('');
      const { error } = await client().from('sessions').insert({ token, user_id: userId, exp: Date.now() + days * 86400000 });
      if (error) throw new Error(`db create session: ${error.message}`);
      return token;
    },
    async getSession(token) {
      const { data: s } = await client().from('sessions').select('*').eq('token', token).maybeSingle();
      if (!s || s.exp < Date.now()) return null;
      const { data: u } = await client().from('users').select('*').eq('id', s.user_id).maybeSingle();
      return u ? { id: u.id, userId: u.id, name: u.name } : null;
    },
    async deleteSession(token) {
      await client().from('sessions').delete().eq('token', token);
    },

    // ---- meta ---------------------------------------------------------------
    async metaGet(key) {
      const { data, error } = await client().from('meta').select('v').eq('k', key).maybeSingle();
      if (error) throw new Error(`db meta get: ${error.message}`);
      return data ? data.v : null;
    },
    async metaSet(key, val) {
      const { error } = await client().from('meta').upsert({ k: key, v: String(val) }, { onConflict: 'k' });
      if (error) throw new Error(`db meta set: ${error.message}`);
    },

    // ---- bulk seed (D1 → PG migration: verbatim encrypted rows) -------------
    async seedUpsert(table, rows, onConflict) {
      if (!rows || !rows.length) return;
      const opts = onConflict ? { onConflict } : undefined;
      const { error } = await client().from(table).upsert(rows, opts);
      if (error) throw new Error(`seed ${table}: ${error.message}`);
    },

    // ---- live event log -----------------------------------------------------
    async appendEvent(pid, room, data) {
      const { data: row, error } = await client().from('events')
        .insert({ pid, room, data: JSON.stringify(data ?? {}) }).select('seq').single();
      if (error) throw new Error(`db append event: ${error.message}`);
      return Number(row.seq);
    },
    async currentSeq(pid, room) {
      const { data, error } = await client().from('events')
        .select('seq').eq('pid', pid).eq('room', room).order('seq', { ascending: false }).limit(1).maybeSingle();
      if (error) throw new Error(`db current seq: ${error.message}`);
      return data?.seq ?? 0;
    },
    async eventsSince(pid, room, since, limit = 60) {
      const lim = Math.min(200, Math.max(1, Number(limit) || 60));
      const { data, error } = await client().from('events')
        .select('data, seq').eq('pid', pid).eq('room', room).gt('seq', since)
        .order('seq', { ascending: true }).limit(lim);
      if (error) throw new Error(`db events since: ${error.message}`);
      return (data || []).map((r) => ({ ...JSON.parse(r.data), seq: Number(r.seq) }));
    },

    // ---- BaaS ---------------------------------------------------------------
    baasTable(pid, coll) {
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(coll)) return null;
      return `${pid}_${coll}`; // logical name only; physical table is a1_baas
    },
    async baasList(pid, coll) {
      const { data, error } = await client().from('a1_baas')
        .select('row_id, data').eq('pid', pid).eq('coll', coll).order('created_at', { ascending: true });
      if (error) throw new Error(`db baas list: ${error.message}`);
      return (data || []).map((r) => ({ id: r.row_id, ...r.data }));
    },
    async baasInsert(pid, coll, obj) {
      const rowId = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
      const { id: _ignored, ...rest } = obj || {};
      const { error } = await client().from('a1_baas').insert({
        pid, coll, row_id: rowId, data: rest, created_at: Date.now(),
      });
      if (error) throw new Error(`db baas insert: ${error.message}`);
      return { id: rowId, ...rest };
    },
    async baasGet(pid, coll, rowId) {
      const { data, error } = await client().from('a1_baas')
        .select('row_id, data').eq('pid', pid).eq('coll', coll).eq('row_id', rowId).maybeSingle();
      if (error) throw new Error(`db baas get: ${error.message}`);
      return data ? { id: data.row_id, ...data.data } : null;
    },
    async baasUpdate(pid, coll, rowId, patch) {
      const cur = await this.baasGet(pid, coll, rowId);
      if (!cur) return null;
      const { id: _ignored, ...rest } = patch || {};
      const next = { ...cur, ...rest };
      delete next.id;
      const { error } = await client().from('a1_baas')
        .update({ data: next }).eq('pid', pid).eq('coll', coll).eq('row_id', rowId);
      if (error) throw new Error(`db baas update: ${error.message}`);
      return { id: rowId, ...next };
    },
    async baasRemove(pid, coll, rowId) {
      const { error } = await client().from('a1_baas')
        .delete().eq('pid', pid).eq('coll', coll).eq('row_id', rowId);
      if (error) throw new Error(`db baas remove: ${error.message}`);
      return true;
    },

    // ---- community features -------------------------------------------------
    async featureGet(id) {
      const { data, error } = await client().from('features').select('id').eq('id', id).maybeSingle();
      if (error) throw new Error(`db feature get: ${error.message}`);
      return data || null;
    },
    async featuresList(me) {
      const { data, error } = await client().from('features')
        .select('id, title, description, status, created_by, created_at')
        .order('created_at', { ascending: false });
      if (error) throw new Error(`db features list: ${error.message}`);
      const ids = (data || []).map((f) => f.id);
      const tally = {};
      const byUser = {};
      if (ids.length) {
        const { data: v } = await client().from('feature_votes').select('feature_id, "user", vote').in('feature_id', ids);
        for (const r of v || []) {
          const t = tally[r.feature_id] || { up: 0, down: 0, score: 0 };
          t.up += r.vote === 1 ? 1 : 0;
          t.down += r.vote === -1 ? 1 : 0;
          t.score += r.vote;
          tally[r.feature_id] = t;
          if (r.user) byUser[`${r.feature_id}\u0000${r.user}`] = r.vote;
        }
      }
      return (data || []).map((f) => {
        const t = tally[f.id] || { up: 0, down: 0, score: 0 };
        return {
          id: f.id, title: f.title, description: f.description, status: f.status,
          created_by: f.created_by, created_at: f.created_at,
          up: t.up, down: t.down, score: t.score,
          my_vote: me ? (byUser[`${f.id}\u0000${me}`] ?? 0) : undefined,
        };
      }).sort((a, b) => b.score - a.score || b.created_at - a.created_at);
    },
    async featureAdd(f) {
      const { error } = await client().from('features').insert({
        id: crypto.randomUUID().replace(/-/g, '').slice(0, 16),
        title: f.title, description: f.description || '', status: f.status || 'proposed',
        created_by: f.created_by || '', created_at: Date.now(),
      });
      if (error) throw new Error(`db feature add: ${error.message}`);
    },
    async featureVote(featureId, user, vote, updatedAt) {
      const { error } = await client().from('feature_votes').upsert(
        { feature_id: featureId, user, vote, updated_at: updatedAt }, { onConflict: 'feature_id,user' });
      if (error) throw new Error(`db feature vote: ${error.message}`);
    },
    async featureStatus(id, status) {
      const { error } = await client().from('features').update({ status }).eq('id', id);
      if (error) throw new Error(`db feature status: ${error.message}`);
    },
  };
}