// Split persistence for the D1 → Supabase sunset:
//
//   * NEW data is written only to Postgres (store-pg.js).
//   * D1 stays as a read-only archive for legacy rows.
//   * Reads prefer Postgres and fall back to D1 when the row/project only
//     exists there, so nothing disappears mid-migration.
//   * The first write to a legacy project/user/team "mirrors" it into
//     Postgres first (migration-by-use); every later read/write is Postgres.
//
// The store-interface contract (store.js) is unchanged: this object is a
// drop-in replacement for createD1Store().

import { createD1Store } from './store-d1.js';
import { createPgStore } from './store-pg.js';

const safe = (s) => String(s).replace(/[^a-zA-Z0-9]/g, '');

async function q(d1, sql, ...bind) {
  const r = await d1.prepare(sql).bind(...bind).all();
  return r.results || [];
}

export function createSplitStore(d1) {
  const pg = createPgStore();
  const d1s = createD1Store(d1);

  async function _projSrc(pid) {
    const gp = await pg.getProject(pid);
    if (gp) return 'pg';
    const g1 = await d1s.getProject(pid);
    return g1 ? 'd1' : null;
  }
  async function _teamSrc(tid) {
    const t = await pg.teamInfo(tid);
    if (t) return 'pg';
    const t1 = await d1s.teamInfo(tid);
    return t1 ? 'd1' : null;
  }
  async function _userSrc(name) {
    const u = await pg.findUserByName(name);
    if (u) return 'pg';
    const u1 = await d1s.findUserByName(name);
    return u1 ? 'd1' : null;
  }

  // ---- legacy mirroring (D1 → Postgres, verbatim encrypted rows) ----------
  const baasCollOf = (table, pid) => table.slice(`baas_${safe(pid)}_`.length);
  async function _mirrorProject(pid) {
    if ((await _projSrc(pid)) !== 'd1') return;
    const p = await d1s.getProject(pid);
    if (!p) return;
    await pg.seedUpsert('projects', [p], 'id');
    await pg.seedUpsert('files', await q(d1, 'SELECT * FROM files WHERE project_id = ?', pid), 'project_id,path');
    await pg.seedUpsert('file_versions', await q(d1, 'SELECT * FROM file_versions WHERE project_id = ?', pid), 'project_id,path,seq');
    await pg.seedUpsert('messages', await q(d1, 'SELECT * FROM messages WHERE project_id = ?', pid), null);
    await pg.seedUpsert('snapshots', await q(d1, 'SELECT * FROM snapshots WHERE project_id = ?', pid), 'id');
    const allSnapshotFiles = await d1.prepare('SELECT * FROM snapshot_files').all();
    {
      const snaps = await q(d1, 'SELECT id FROM snapshots WHERE project_id = ?', pid);
      const ids = new Set(snaps.map((s) => s.id));
      await pg.seedUpsert('snapshot_files', allSnapshotFiles.results.filter((r) => ids.has(r.snapshot_id)), 'snapshot_id,path');
    }
    await pg.seedUpsert('events', await q(d1, 'SELECT * FROM events WHERE pid = ?', pid), 'seq');
    await pg.seedUpsert('presence', await q(d1, 'SELECT * FROM presence WHERE pid = ?', pid), 'pid,sid');
    await pg.seedUpsert('interactions', await q(d1, 'SELECT * FROM interactions WHERE project_id = ?', pid), 'project_id,day,key');
    // per-project BaaS collections → a1_baas JSONB rows
    const tables = await q(d1, "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ?", `baas_${safe(pid)}_%`);
    for (const t of tables) {
      const coll = baasCollOf(t.name, pid);
      const rows = await q(d1, `SELECT * FROM "${t.name}"`);
      await pg.seedUpsert('a1_baas', rows.map((r) => ({
        pid, coll, row_id: r.id, data: JSON.parse(r.data), created_at: r.created_at,
      })), 'pid,coll,row_id');
    }
  }

  async function _mirrorTeam(tid) {
    if ((await _teamSrc(tid)) !== 'd1') return;
    const t = await d1s.teamInfo(tid);
    if (!t) return;
    const { members, ...row } = t;
    await pg.seedUpsert('teams', [row], 'id');
    await pg.seedUpsert('team_members', await q(d1, 'SELECT * FROM team_members WHERE team_id = ?', tid), 'team_id,name');
  }

  async function _mirrorUser(name) {
    if ((await _userSrc(name)) !== 'd1') return;
    const u = await d1s.findUserByName(name);
    if (!u) return;
    await pg.seedUpsert('users', [u], 'id');
    await pg.seedUpsert('sessions', await q(d1, 'SELECT * FROM sessions WHERE user_id = ?', u.id), 'token');
    await pg.seedUpsert('a1_usage', await q(d1, 'SELECT * FROM usage WHERE name LIKE ?', `credit:${u.id}%`), 'name,day');
    await pg.seedUpsert('earnings', await q(d1, 'SELECT * FROM earnings WHERE name = ?', u.name), 'name');
    const teams = await q(d1, 'SELECT * FROM teams WHERE owner = ?', u.name);
    for (const t of teams) await _mirrorTeam(t.id);
    const owned = await q(d1, 'SELECT id FROM projects WHERE owner = ?', u.name);
    for (const p of owned) await _mirrorProject(p.id);
  }

  // ---- routing helpers ------------------------------------------------------
  const ensureProj = async (pid) => { if ((await _projSrc(pid)) === 'd1') await _mirrorProject(pid); };
  const readBySrc = async (pid, ifPg, ifD1) => {
    const src = await _projSrc(pid);
    if (src === 'd1') return ifD1();
    return ifPg();
  };
  const mergeById = (pgRows, d1Rows, key = 'id') => {
    const seen = new Map();
    for (const r of d1Rows || []) seen.set(r[key], r);
    for (const r of pgRows || []) seen.set(r[key], r); // pg wins
    return [...seen.values()];
  };

  const impl = {
    // ---- projects -----------------------------------------------------------
    async createProject(name, owner) { return pg.createProject(name, owner); },
    async listProjects() {
      const [a, b] = await Promise.all([pg.listProjects(), d1s.listProjects()]);
      return mergeById(a, b);
    },
    async getProject(pid) { return (await pg.getProject(pid)) || d1s.getProject(pid); },
    async deleteProject(pid) {
      if (await pg.getProject(pid)) await pg.deleteProject(pid).catch(() => {});
      if (await d1s.getProject(pid)) await d1s.deleteProject(pid).catch(() => {});
      return { ok: true };
    },
    async setModel(pid, model) { await ensureProj(pid); return pg.setModel(pid, model); },
    async setPublished(pid, publish, description) { await ensureProj(pid); return pg.setPublished(pid, publish, description); },
    async discover() {
      const a = await pg.discover();
      const b = await d1s.discover();
      return mergeById(a, b, 'slug').sort((x, y) => y.created_at - x.created_at);
    },
    async remix(srcPid) { await ensureProj(srcPid); return pg.remix(srcPid); },

    // ---- files --------------------------------------------------------------
    async saveFile(pid, fpath, content, encoding) { await ensureProj(pid); return pg.saveFile(pid, fpath, content, encoding); },
    async recordVersion(pid, fpath, content, encoding) { await ensureProj(pid); return pg.recordVersion(pid, fpath, content, encoding); },
    async getFile(pid, fpath) { return readBySrc(pid, () => pg.getFile(pid, fpath), () => d1s.getFile(pid, fpath)); },
    async listFiles(pid) { return readBySrc(pid, () => pg.listFiles(pid), () => d1s.listFiles(pid)); },
    async listFilesWithContent(pid) {
      return readBySrc(pid, () => pg.listFilesWithContent(pid), () => d1s.listFilesWithContent(pid));
    },
    async deleteFile(pid, fpath) { await ensureProj(pid); return pg.deleteFile(pid, fpath); },
    async fileVersions(pid, fpath) { return readBySrc(pid, () => pg.fileVersions(pid, fpath), () => d1s.fileVersions(pid, fpath)); },
    async getFileVersion(pid, fpath, seq) {
      return readBySrc(pid, () => pg.getFileVersion(pid, fpath, seq), () => d1s.getFileVersion(pid, fpath, seq));
    },
    async restoreFileVersion(pid, fpath, seq) { await ensureProj(pid); return pg.restoreFileVersion(pid, fpath, seq); },
    async listSnapshots(pid) { return readBySrc(pid, () => pg.listSnapshots(pid), () => d1s.listSnapshots(pid)); },
    async takeSnapshot(pid, label) { await ensureProj(pid); return pg.takeSnapshot(pid, label); },
    async getSnapshot(pid, sid) { return readBySrc(pid, () => pg.getSnapshot(pid, sid), () => d1s.getSnapshot(pid, sid)); },
    async restoreSnapshot(pid, sid) { await ensureProj(pid); return pg.restoreSnapshot(pid, sid); },

    // ---- chat ---------------------------------------------------------------
    async addMessage(pid, role, content, user) { await ensureProj(pid); return pg.addMessage(pid, role, content, user); },
    async history(pid, limit) { return readBySrc(pid, () => pg.history(pid, limit), () => d1s.history(pid, limit)); },

    // ---- plan & rename ------------------------------------------------------
    async setPlan(pid, plan) { await ensureProj(pid); return pg.setPlan(pid, plan); },
    async rename(pid, name) { await ensureProj(pid); return pg.rename(pid, name); },

    // ---- usage & credits (new balances land in PG) --------------------------
    async incrUsage(name, day) { return pg.incrUsage(name, day); },
    creditsKey(userId) { return pg.creditsKey(userId); },
    async getCredits(userId, day) {
      const v = await pg.getCredits(userId, day);
      if (v) return v;
      return d1s.getCredits(userId, day);
    },
    async spendCredits(userId, day, amount) { return pg.spendCredits(userId, day, amount); },
    async creditGet(key, day) {
      const v = await pg.creditGet(key, day);
      if (v) return v;
      return d1s.creditGet(key, day);
    },
    async creditSpend(key, day, amount) { return pg.creditSpend(key, day, amount); },
    teamCreditKey(teamId) { return pg.teamCreditKey(teamId); },
    async earningsUnits(name) {
      const v = await pg.earningsUnits(name);
      if (v) return v;
      return d1s.earningsUnits(name);
    },
    async earningsUnitsForNames(names) {
      const a = await pg.earningsUnitsForNames(names);
      const b = await d1s.earningsUnitsForNames(names);
      return (a || 0) + (b || 0);
    },
    async earnCredits(name, units) { return pg.earnCredits(name, units); },
    async spendEarnings(name, units) { return pg.spendEarnings(name, units); },

    // ---- teams --------------------------------------------------------------
    async createTeam(name, owner) { return pg.createTeam(name, owner); },
    async teamInfo(tid) { return (await pg.teamInfo(tid)) || d1s.teamInfo(tid); },
    async teamByInviteCode(code) { return (await pg.teamByInviteCode(code)) || d1s.teamByInviteCode(code); },
    async teamMembers(tid) {
      return (await _teamSrc(tid)) === 'd1' ? d1s.teamMembers(tid) : pg.teamMembers(tid);
    },
    async addTeamMember(tid, name, joinedAt) {
      const src = await _teamSrc(tid);
      if (src === 'd1') await _mirrorTeam(tid);
      if (src !== 'pg' && (await _teamSrc(tid)) !== 'pg') return false;
      return pg.addTeamMember(tid, name, joinedAt);
    },
    async removeTeamMember(tid, name) {
      if ((await _teamSrc(tid)) === 'd1') await _mirrorTeam(tid);
      return pg.removeTeamMember(tid, name);
    },
    async myTeams(name) {
      const [a, b] = await Promise.all([pg.myTeams(name), d1s.myTeams(name)]);
      return mergeById(a, b);
    },
    async myTeamIds(name) {
      const [a, b] = await Promise.all([pg.myTeamIds(name), d1s.myTeamIds(name)]);
      return [...new Set([...a, ...b])];
    },
    async isTeamMember(tid, name) {
      const src = await _teamSrc(tid);
      return src === 'd1' ? d1s.isTeamMember(tid, name) : pg.isTeamMember(tid, name);
    },
    async setProjectTeam(pid, tid) { await ensureProj(pid); return pg.setProjectTeam(pid, tid); },
    async deleteTeam(tid) {
      await pg.deleteTeam(tid).catch(() => {});
      await d1s.deleteTeam(tid).catch(() => {});
      return { ok: true };
    },

    // ---- credit exchange ----------------------------------------------------
    async recordInteraction(pid, visitorKey, day) { await ensureProj(pid); return pg.recordInteraction(pid, visitorKey, day); },
    async interactionsToday(pid, day) {
      return readBySrc(pid, () => pg.interactionsToday(pid, day), () => d1s.interactionsToday(pid, day));
    },

    // ---- presence (ephemeral — route by project source) ----------------------
    PRESENCE_WINDOW_MS: 30000,
    async touchPresence(pid, sid, userName, now) {
      return readBySrc(pid, () => pg.touchPresence(pid, sid, userName, now), () => d1s.touchPresence(pid, sid, userName, now));
    },
    async leavePresence(pid, sid) {
      return readBySrc(pid, () => pg.leavePresence(pid, sid), () => d1s.leavePresence(pid, sid));
    },
    async presenceUsers(pid) {
      return readBySrc(pid, () => pg.presenceUsers(pid), () => d1s.presenceUsers(pid));
    },

    // ---- accounts & sessions ------------------------------------------------
    async createUser(u) { return pg.createUser(u); },
    async deleteUser(user) {
      await pg.deleteUser(user).catch((e) => console.error('pg deleteUser:', e.message));
      await d1s.deleteUser(user).catch((e) => console.error('d1 deleteUser:', e.message));
    },
    async ipUsed(ip) { return (await pg.ipUsed(ip)) || (await d1s.ipUsed(ip)); },
    async resetPassword(name, phash) {
      const src = await _userSrc(name);
      if (src === 'd1') await _mirrorUser(name);
      return src ? pg.resetPassword(name, phash) : null;
    },
    async updateUserIp(name, ipTag) {
      const src = await _userSrc(name);
      if (src === 'd1') await _mirrorUser(name);
      if (src) await pg.updateUserIp(name, ipTag);
    },
    async findUserByName(name) { return (await pg.findUserByName(name)) || d1s.findUserByName(name); },
    async findUserById(id) { return (await pg.findUserById(id)) || d1s.findUserById(id); },
    async verifyUser(name) {
      const src = await _userSrc(name);
      if (src === 'd1') await _mirrorUser(name);
      if (src) await pg.verifyUser(name);
    },
    async createSession(userId, days) { return pg.createSession(userId, days); },
    async getSession(token) { return (await pg.getSession(token)) || d1s.getSession(token); },
    async deleteSession(token) {
      await pg.deleteSession(token).catch(() => {});
      await d1s.deleteSession(token).catch(() => {});
    },

    // ---- meta (written to both so boot flags stay consistent) --------------
    async metaGet(key) { return (await pg.metaGet(key)) || d1s.metaGet(key); },
    async metaSet(key, val) {
      await pg.metaSet(key, val);
      await d1s.metaSet(key, val).catch(() => {});
    },

    // ---- live events --------------------------------------------------------
    async appendEvent(pid, room, data) { await ensureProj(pid); return pg.appendEvent(pid, room, data); },
    async currentSeq(pid, room) {
      return readBySrc(pid, () => pg.currentSeq(pid, room), () => d1s.currentSeq(pid, room));
    },
    async eventsSince(pid, room, since, limit) {
      return readBySrc(pid, () => pg.eventsSince(pid, room, since, limit), () => d1s.eventsSince(pid, room, since, limit));
    },

    // ---- BaaS ---------------------------------------------------------------
    baasTable(pid, coll) {
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(coll)) return null;
      return `${pid}_${coll}`; // logical name only; physical storage is a1_baas
    },
    async baasList(pid, coll) { return readBySrc(pid, () => pg.baasList(pid, coll), () => d1s.baasList(pid, coll)); },
    async baasInsert(pid, coll, obj) { await ensureProj(pid); return pg.baasInsert(pid, coll, obj); },
    async baasGet(pid, coll, rowId) {
      return readBySrc(pid, () => pg.baasGet(pid, coll, rowId), () => d1s.baasGet(pid, coll, rowId));
    },
    async baasUpdate(pid, coll, rowId, patch) { await ensureProj(pid); return pg.baasUpdate(pid, coll, rowId, patch); },
    async baasRemove(pid, coll, rowId) { await ensureProj(pid); return pg.baasRemove(pid, coll, rowId); },

    // ---- community features (PG-only) --------------------------------------
    async featureGet(id) { return pg.featureGet(id); },
    async featuresList(me) { return pg.featuresList(me); },
    async featureAdd(f) { return pg.featureAdd(f); },
    async featureVote(id, user, vote, at) { return pg.featureVote(id, user, vote, at); },
    async featureStatus(id, status) { return pg.featureStatus(id, status); },

    // ---- forum (PG-only) ----------------------------------------------------
    async forumCategory(catId) { return pg.forumCategory(catId); },
    async forumCategories() { return pg.forumCategories(); },
    async forumThreads(category, me, before, limit) { return pg.forumThreads(category, me, before, limit); },
    async forumCreateThread(a) { return pg.forumCreateThread(a); },
    async forumThread(tid, me) { return pg.forumThread(tid, me); },
    async forumReply(tid, author, content) { return pg.forumReply(tid, author, content); },
    async forumVote(threadId, user, vote, at) { return pg.forumVote(threadId, user, vote, at); },
    async forumMod(tid, patch) { return pg.forumMod(tid, patch); },
  };

  return impl;
}