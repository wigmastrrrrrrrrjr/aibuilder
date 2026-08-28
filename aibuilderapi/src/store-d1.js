// Cloudflare D1 implementation of the same store interface as db.js.
// Same SQL, same lazy BaaS tables — see ../../schema.sql for the base schema.

import { creditsToUnits } from './models.js';

function slugify(name) {
  const s = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (s || 'app').slice(0, 40);
}

export function createD1Store(d1) {
  return {
    async createProject(name, owner) {
      const p = { id: crypto.randomUUID().replace(/-/g, '').slice(0, 20), name: name || 'Untitled app', created_at: Date.now() };
      await d1.prepare('INSERT INTO projects (id, name, created_at, owner) VALUES (?, ?, ?, ?)')
        .bind(p.id, p.name, p.created_at, owner || '').run();
      return { ...p, owner: owner || '', published: 0, slug: null, description: '', model: '', plan: null };
    },
    async listProjects() {
      const { results } = await d1.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
      return results;
    },
    async getProject(pid) {
      return await d1.prepare('SELECT * FROM projects WHERE id = ?').bind(pid).first();
    },
    async deleteProject(pid) {
      await d1.prepare('DELETE FROM files WHERE project_id = ?').bind(pid).run();
      await d1.prepare('DELETE FROM file_versions WHERE project_id = ?').bind(pid).run();
      await d1.prepare('DELETE FROM messages WHERE project_id = ?').bind(pid).run();
      await d1.prepare('DELETE FROM events WHERE pid = ?').bind(pid).run();
      await d1.prepare('DELETE FROM snapshot_files WHERE snapshot_id IN (SELECT id FROM snapshots WHERE project_id = ?)').bind(pid).run();
      await d1.prepare('DELETE FROM snapshots WHERE project_id = ?').bind(pid).run();
      await d1.prepare('DELETE FROM projects WHERE id = ?').bind(pid).run();
      return { ok: true };
    },
    async setModel(pid, model) {
      if (!/^[A-Za-z0-9._:+%-]{1,64}$/.test(model || '')) return;
      await d1.prepare('UPDATE projects SET model = ? WHERE id = ?').bind(model, pid).run();
    },
    async setPublished(pid, publish, description) {
      const p = await this.getProject(pid);
      if (!p) throw new Error('not found');
      let slug = p.slug;
      if (publish && !slug) {
        slug = slugify(p.name);
        for (let i = 2; ; i++) {
          const hit = await d1.prepare('SELECT 1 AS x FROM projects WHERE slug = ?').bind(slug).first();
          if (!hit) break;
          slug = `${slugify(p.name)}-${i}`;
        }
      }
      const desc = description !== undefined && description !== null
        ? String(description) : (p.description ?? '');
      await d1.prepare('UPDATE projects SET published = ?, slug = ?, description = ? WHERE id = ?')
        .bind(publish ? 1 : 0, publish ? slug : slug, desc, pid).run();
      return this.getProject(pid);
    },
    async discover() {
      const { results } = await d1.prepare(
        `SELECT id, slug, name, description, created_at FROM projects
         WHERE published = 1 ORDER BY created_at DESC`
      ).all();
      return results;
    },
    async remix(srcPid) {
      const src = await this.getProject(srcPid);
      if (!src) return null;
      const copy = await this.createProject(`${src.name} (remix)`);
      await d1.prepare(`INSERT INTO files (project_id, path, content, encoding, updated_at)
                        SELECT ?, path, content, encoding, ? FROM files WHERE project_id = ?`)
        .bind(copy.id, Date.now(), srcPid).run();
      if (src.description) {
        await d1.prepare('UPDATE projects SET description = ? WHERE id = ?')
          .bind(src.description, copy.id).run();
      }
      return copy;
    },

    async saveFile(pid, fpath, content, encoding = 'utf8') {
      await d1.prepare(`INSERT INTO files (project_id, path, content, encoding, updated_at)
                        VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT (project_id, path) DO UPDATE SET content = excluded.content,
                          encoding = excluded.encoding, updated_at = excluded.updated_at`)
        .bind(pid, fpath, content, encoding, Date.now()).run();
      await this.recordVersion(pid, fpath, content, encoding);
    },
    async recordVersion(pid, fpath, content, encoding) {
      const cur = await d1.prepare(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM file_versions WHERE project_id = ? AND path = ?'
      ).bind(pid, fpath).first();
      const s = cur?.s || 1;
      await d1.prepare('INSERT INTO file_versions (project_id, path, seq, content, encoding, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(pid, fpath, s, content, encoding || 'utf8', Date.now()).run();
      const min = await d1.prepare(
        `SELECT COALESCE(MIN(seq), 0) AS m FROM (
           SELECT seq FROM file_versions WHERE project_id = ? AND path = ?
           ORDER BY seq DESC LIMIT 60)`
      ).bind(pid, fpath).first();
      await d1.prepare('DELETE FROM file_versions WHERE project_id = ? AND path = ? AND seq < ?')
        .bind(pid, fpath, min?.m || 0).run();
    },
    async getFile(pid, fpath) {
      return await d1.prepare('SELECT * FROM files WHERE project_id = ? AND path = ?')
        .bind(pid, fpath).first();
    },
    async listFiles(pid) {
      const { results } = await d1.prepare(
        'SELECT path, updated_at FROM files WHERE project_id = ? ORDER BY path'
      ).bind(pid).all();
      return results;
    },
    async deleteFile(pid, fpath) {
      await d1.prepare('DELETE FROM files WHERE project_id = ? AND path = ?').bind(pid, fpath).run();
      const cur = await d1.prepare(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM file_versions WHERE project_id = ? AND path = ?'
      ).bind(pid, fpath).first();
      await d1.prepare('INSERT INTO file_versions (project_id, path, seq, content, updated_at) VALUES (?, ?, ?, NULL, ?)')
        .bind(pid, fpath, cur?.s || 1, Date.now()).run();
      return { ok: true };
    },
    async fileVersions(pid, fpath) {
      const { results } = await d1.prepare(
        'SELECT seq, updated_at, content IS NULL AS deleted, length(content) AS bytes FROM file_versions WHERE project_id = ? AND path = ? ORDER BY seq DESC'
      ).bind(pid, fpath).all();
      return results;
    },
    async getFileVersion(pid, fpath, seq) {
      return await d1.prepare(
        'SELECT seq, content, encoding, updated_at FROM file_versions WHERE project_id = ? AND path = ? AND seq = ?'
      ).bind(pid, fpath, seq).first();
    },
    async restoreFileVersion(pid, fpath, seq) {
      const v = await d1.prepare(
        'SELECT content, encoding FROM file_versions WHERE project_id = ? AND path = ? AND seq = ?'
      ).bind(pid, fpath, seq).first();
      if (!v) throw new Error('version not found');
      if (v.content == null) {
        await this.deleteFile(pid, fpath);
        return { ok: true, deleted: true, seq };
      }
      await this.saveFile(pid, fpath, v.content, v.encoding || 'utf8');
      return { ok: true, deleted: false, seq };
    },
    async listSnapshots(pid) {
      const { results } = await d1.prepare(
        `SELECT s.id, s.created_at, s.label,
          (SELECT count(*) FROM snapshot_files f WHERE f.snapshot_id = s.id) AS files
          FROM snapshots s WHERE s.project_id = ? ORDER BY s.created_at DESC`
      ).bind(pid).all();
      return results;
    },
    async takeSnapshot(pid, label) {
      const id = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
      await d1.prepare('INSERT INTO snapshots (id, project_id, created_at, label) VALUES (?, ?, ?, ?)')
        .bind(id, pid, Date.now(), String(label || '').slice(0, 80)).run();
      await d1.prepare('INSERT INTO snapshot_files (snapshot_id, path, content, encoding) SELECT ?, path, content, COALESCE(encoding, \'utf8\') FROM files WHERE project_id = ?')
        .bind(id, pid).run();
      await d1.prepare(`DELETE FROM snapshots WHERE project_id = ? AND id NOT IN
        (SELECT id FROM snapshots WHERE project_id = ? ORDER BY created_at DESC LIMIT 20)`)
        .bind(pid, pid).run();
      await d1.prepare('DELETE FROM snapshot_files WHERE snapshot_id NOT IN (SELECT id FROM snapshots)').run();
      return { id, pid, created_at: Date.now(), label: String(label || '').slice(0, 80) };
    },
    async getSnapshot(pid, sid) {
      const s = await d1.prepare('SELECT * FROM snapshots WHERE id = ? AND project_id = ?')
        .bind(sid, pid).first();
      if (!s) return null;
      const { results } = await d1.prepare(
        'SELECT path, content, encoding FROM snapshot_files WHERE snapshot_id = ? ORDER BY path'
      ).bind(sid).all();
      s.files = results;
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
    async addMessage(pid, role, content) {
      await d1.prepare(
        'INSERT INTO messages (project_id, role, content, created_at) VALUES (?, ?, ?, ?)'
      ).bind(pid, role, content, Date.now()).run();
    },
    async history(pid, limit = 12) {
      const { results } = await d1.prepare(
        `SELECT role, content FROM (SELECT role, content, created_at FROM messages
         WHERE project_id = ? ORDER BY created_at DESC LIMIT ?)
         ORDER BY created_at ASC`
      ).bind(pid, limit).all();
      return results;
    },

    // ---- plan & rename --------------------------------------------------------
    async setPlan(pid, plan) {
      await d1.prepare('UPDATE projects SET plan = ? WHERE id = ?')
        .bind(plan == null ? null : JSON.stringify(plan), pid).run();
    },
    async rename(pid, name) {
      const p = await this.getProject(pid);
      if (!p) throw new Error('not found');
      await d1.prepare('UPDATE projects SET name = ? WHERE id = ?').bind(name, pid).run();
      return { ...p, name };
    },

    // ---- usage ---------------------------------------------------------------
    async incrUsage(name, day) {
      await d1.prepare(`INSERT INTO usage (name, day, count) VALUES (?, ?, 1)
                        ON CONFLICT (name, day) DO UPDATE SET count = count + 1`)
        .bind(name, day).run();
      const r = await d1.prepare('SELECT count FROM usage WHERE name = ? AND day = ?').bind(name, day).first();
      return r ? r.count : 0;
    },
    // ---- daily credits --------------------------------------------------------
    creditsKey(userId) {
      return `credit:${userId}`;
    },
    async getCredits(userId, day) {
      const r = await d1.prepare('SELECT count FROM usage WHERE name = ? AND day = ?')
        .bind(this.creditsKey(userId), day).first();
      return r ? r.count : 0;
    },
    async spendCredits(userId, day, amount) {
      const key = this.creditsKey(userId);
      await d1.prepare(`INSERT INTO usage (name, day, count) VALUES (?, ?, ?)
                        ON CONFLICT (name, day) DO UPDATE SET count = count + ?`)
        .bind(key, day, amount, amount).run();
      const r = await d1.prepare('SELECT count FROM usage WHERE name = ? AND day = ?').bind(key, day).first();
      return r ? r.count : 0;
    },
    // Generic name-keyed credit ledger (used for team pools + interactions),
    // plus lifetime interaction-credit earnings.
    async creditGet(key, day) {
      const r = await d1.prepare('SELECT count FROM usage WHERE name = ? AND day = ?').bind(key, day).first();
      return r ? r.count : 0;
    },
    async creditSpend(key, day, amount) {
      await d1.prepare(`INSERT INTO usage (name, day, count) VALUES (?, ?, ?)
                        ON CONFLICT (name, day) DO UPDATE SET count = count + ?`)
        .bind(key, day, amount, amount).run();
      const r = await d1.prepare('SELECT count FROM usage WHERE name = ? AND day = ?').bind(key, day).first();
      return r ? r.count : 0;
    },
    teamCreditKey(teamId) {
      return `credit:team:${teamId}`;
    },
    async earningsUnits(name) {
      const r = await d1.prepare('SELECT units FROM earnings WHERE name = ?').bind(name).first();
      return r ? r.units : 0;
    },
    async earningsUnitsForNames(names) {
      if (!names || !names.length) return 0;
      const ph = names.map(() => '?').join(', ');
      const r = await d1.prepare(`SELECT COALESCE(SUM(units), 0) AS u FROM earnings WHERE name IN (${ph})`)
        .bind(...names).first();
      return r ? r.u : 0;
    },
    async earnCredits(name, units) {
      await d1.prepare(`INSERT INTO earnings (name, units) VALUES (?, ?)
                        ON CONFLICT (name) DO UPDATE SET units = units + excluded.units`)
        .bind(name, units).run();
    },
    async spendEarnings(name, units) {
      await d1.prepare('UPDATE earnings SET units = MAX(0, units - ?) WHERE name = ?').bind(units, name).run();
      return this.earningsUnits(name);
    },

    // ---- teambuild: teams ---------------------------------------------------
    async createTeam(name, owner) {
      const id = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
      const CHS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let code = '';
      for (let tries = 0; tries < 5; tries++) {
        code = Array.from(crypto.getRandomValues(new Uint8Array(8)))
          .map(b => CHS[b % CHS.length]).join('');
        const clash = await d1.prepare('SELECT 1 AS x FROM teams WHERE invite_code = ?').bind(code).first();
        if (!clash) break;
      }
      await d1.prepare('INSERT INTO teams (id, name, owner, invite_code, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(id, name, owner, code, Date.now()).run();
      await d1.prepare('INSERT INTO team_members (team_id, name, joined_at) VALUES (?, ?, ?)')
        .bind(id, owner, Date.now()).run();
      return this.teamInfo(id);
    },
    async teamInfo(tid) {
      const t = await d1.prepare('SELECT * FROM teams WHERE id = ?').bind(tid).first();
      if (!t) return null;
      const { results } = await d1.prepare('SELECT name FROM team_members WHERE team_id = ? ORDER BY joined_at').bind(tid).all();
      t.members = results.map(r => r.name);
      return t;
    },
    async teamMembers(tid) {
      const { results } = await d1.prepare('SELECT name FROM team_members WHERE team_id = ? ORDER BY joined_at').bind(tid).all();
      return results.map(r => r.name);
    },
    async addTeamMember(tid, name, joinedAt = Date.now()) {
      try {
        await d1.prepare('INSERT INTO team_members (team_id, name, joined_at) VALUES (?, ?, ?)')
          .bind(tid, name, joinedAt).run();
        return true;
      } catch { return false; }
    },
    async removeTeamMember(tid, name) {
      await d1.prepare('DELETE FROM team_members WHERE team_id = ? AND name = ?').bind(tid, name).run();
      const r = await d1.prepare('SELECT COUNT(*) AS c FROM team_members WHERE team_id = ?').bind(tid).first();
      if ((r?.c || 0) === 0) await d1.prepare('DELETE FROM teams WHERE id = ?').bind(tid).run();
    },
    async myTeams(name) {
      const { results } = await d1.prepare(
        `SELECT DISTINCT t.*,
          (SELECT COUNT(*) FROM team_members m WHERE m.team_id = t.id) AS members
         FROM teams t
         LEFT JOIN team_members m ON m.team_id = t.id
         WHERE t.owner = ? OR m.name = ?
         ORDER BY t.created_at DESC`
      ).bind(name, name).all();
      return results;
    },
    async myTeamIds(name) {
      const { results } = await d1.prepare(
        'SELECT DISTINCT team_id FROM team_members WHERE name = ?'
      ).bind(name).all();
      return results.map(r => r.team_id);
    },
    async isTeamMember(tid, name) {
      const r = await d1.prepare('SELECT 1 AS x FROM team_members WHERE team_id = ? AND name = ?')
        .bind(tid, name).first();
      return Boolean(r);
    },
    async setProjectTeam(pid, tid) {
      await d1.prepare('UPDATE projects SET team_id = ? WHERE id = ?').bind(tid || '', pid).run();
      return this.getProject(pid);
    },
    async deleteTeam(tid) {
      await d1.prepare('DELETE FROM team_members WHERE team_id = ?').bind(tid).run();
      await d1.prepare("UPDATE projects SET team_id = '' WHERE team_id = ?").bind(tid).run();
      await d1.prepare('DELETE FROM teams WHERE id = ?').bind(tid).run();
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
      let meta = null;
      try {
        const r = await d1.prepare('INSERT INTO interactions (project_id, day, key, created_at) VALUES (?, ?, ?, ?)')
          .bind(p.id, day || new Date().toISOString().slice(0, 10), vid, Date.now()).run();
        meta = r.meta;
      } catch { /* duplicate visitor */ }
      if (meta && meta.changes > 0) {
        await this.earnCredits(p.owner, creditsToUnits(1));
        return { ok: true, created: true, project_id: p.id };
      }
      return { ok: true, created: false };
    },
    async interactionsToday(pid, day) {
      const r = await d1.prepare('SELECT COUNT(*) AS c FROM interactions WHERE project_id = ? AND day = ?')
        .bind(pid, day || new Date().toISOString().slice(0, 10)).first();
      return r ? r.c : 0;
    },

    // ---- live presence (10-person concurrency cap) --------------------------
    PRESENCE_WINDOW_MS: 30000,
    async touchPresence(pid, sid, userName, now = Date.now()) {
      const key = this.PRESENCE_WINDOW_MS;
      await d1.prepare('DELETE FROM presence WHERE seen_at < ?').bind(now - key).run();
      const had = await d1.prepare('SELECT 1 AS x FROM presence WHERE pid = ? AND sid = ?').bind(pid, sid).first();
      if (!had) {
        const cnt = await d1.prepare('SELECT COUNT(*) AS c FROM presence WHERE pid = ?').bind(pid).first();
        if ((cnt?.c || 0) >= 10) return { active: cnt.c, accepted: false, present: false };
        await d1.prepare('INSERT INTO presence (pid, sid, user, seen_at) VALUES (?, ?, ?, ?)')
          .bind(pid, sid, userName || '', now).run();
      } else {
        await d1.prepare('UPDATE presence SET user = ?, seen_at = ? WHERE pid = ? AND sid = ?')
          .bind(userName || '', now, pid, sid).run();
      }
      const cnt = await d1.prepare('SELECT COUNT(*) AS c FROM presence WHERE pid = ?').bind(pid).first();
      return { active: cnt.c, accepted: true, present: Boolean(had) };
    },
    async leavePresence(pid, sid) {
      await d1.prepare('DELETE FROM presence WHERE pid = ? AND sid = ?').bind(pid, sid).run();
    },
    async presenceUsers(pid) {
      const now = Date.now();
      await d1.prepare('DELETE FROM presence WHERE seen_at < ?').bind(now - this.PRESENCE_WINDOW_MS).run();
      const { results } = await d1.prepare(
        "SELECT DISTINCT user FROM presence WHERE pid = ? AND user != '' ORDER BY seen_at DESC LIMIT 20"
      ).bind(pid).all();
      return results.map(r => r.user);
    },

    // ---- accounts & sessions -------------------------------------------------
    async createUser({ name, phash, ip, email }) {
      const id = crypto.randomUUID();
      try {
        await d1.prepare('INSERT INTO users (id, name, phash, email, created_at, ip) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(id, name, phash, email || '', Date.now(), ip || '').run();
        return { id, name, email: email || '' };
      } catch {
        throw new Error('username already taken');
      }
    },
    async ipUsed(ip) {
      if (!ip) return null;
      const r = await d1.prepare('SELECT name FROM users WHERE ip = ?').bind(ip).first();
      return r ? r.name : null;
    },
    async resetPassword(name, phash) {
      const u = await d1.prepare('SELECT * FROM users WHERE name = ?').bind(name).first();
      if (!u) return null;
      await d1.prepare('UPDATE users SET phash = ? WHERE id = ?').bind(phash, u.id).run();
      return { ...u, phash };
    },
    async updateUserIp(name, ipTag) {
      const u = await d1.prepare('SELECT * FROM users WHERE name = ?').bind(name).first();
      if (u && !u.ip) await d1.prepare('UPDATE users SET ip = ? WHERE id = ?').bind(ipTag, u.id).run();
    },
    async findUserByName(name) {
      return await d1.prepare('SELECT * FROM users WHERE name = ?').bind(name).first() || null;
    },
    async findUserById(id) {
      return await d1.prepare('SELECT * FROM users WHERE id = ?').bind(id).first() || null;
    },
    async verifyUser(name) {
      await d1.prepare('UPDATE users SET verified = 1 WHERE name = ?').bind(name).run();
    },
    async createSession(userId, days = 30) {
      const token = [...crypto.getRandomValues(new Uint8Array(24))]
        .map((b) => b.toString(16).padStart(2, '0')).join('');
      await d1.prepare('INSERT INTO sessions (token, user_id, exp) VALUES (?, ?, ?)')
        .bind(token, userId, Date.now() + days * 86400000).run();
      return token;
    },
    async getSession(token) {
      const s = await d1.prepare('SELECT * FROM sessions WHERE token = ?').bind(token).first();
      if (!s || s.exp < Date.now()) return null;
      const u = await d1.prepare('SELECT * FROM users WHERE id = ?').bind(s.user_id).first();
      return u ? { id: u.id, userId: u.id, name: u.name } : null;
    },
    async deleteSession(token) {
      await d1.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    },

    // ---- meta ----------------------------------------------------------------
    async metaGet(key) {
      const r = await d1.prepare('SELECT v FROM meta WHERE k = ?').bind(key).first();
      return r ? r.v : null;
    },
    async metaSet(key, val) {
      await d1.prepare(`INSERT INTO meta (k, v) VALUES (?, ?)
                        ON CONFLICT (k) DO UPDATE SET v = excluded.v`)
        .bind(key, String(val)).run();
    },

    // ---- live event log (multiplayer) ----------------------------------------
    async appendEvent(pid, room, data) {
      const cur = await d1.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE pid = ? AND room = ?')
        .bind(pid, room).first();
      const seq = (cur?.s || 0) + 1;
      await d1.prepare('INSERT INTO events (pid, room, data, seq) VALUES (?, ?, ?, ?)')
        .bind(pid, room, JSON.stringify({ ...(data || {}), seq }), seq).run();
      return seq;
    },
    async currentSeq(pid, room) {
      const r = await d1.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE pid = ? AND room = ?')
        .bind(pid, room).first();
      return r?.s || 0;
    },
    async eventsSince(pid, room, since, limit = 60) {
      const { results } = await d1.prepare(
        'SELECT data, seq FROM events WHERE pid = ? AND room = ? AND seq > ? ORDER BY seq LIMIT ?'
      ).bind(pid, room, since, Math.min(200, Math.max(1, Number(limit) || 60))).all();
      return results.map(r => ({ ...JSON.parse(r.data), seq: r.seq }));
    },

    // ---- BaaS ----------------------------------------------------------------
    baasTable(pid, coll) {
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(coll)) return null;
      return `baas_${pid.replace(/[^a-zA-Z0-9]/g, '')}_${coll}`;
    },
    async _ensure(t) {
      await d1.prepare(`CREATE TABLE IF NOT EXISTS ${t} (
        id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL)`).run();
    },
    async baasList(pid, coll) {
      const t = this.baasTable(pid, coll);
      await this._ensure(t);
      const { results } = await d1.prepare(`SELECT id, data FROM ${t} ORDER BY created_at`).all();
      return results.map(r => ({ id: r.id, ...JSON.parse(r.data) }));
    },
    async baasInsert(pid, coll, obj) {
      const t = this.baasTable(pid, coll);
      await this._ensure(t);
      const rowId = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
      const { id: _ignored, ...data } = obj || {};
      await d1.prepare(`INSERT INTO ${t} (id, data, created_at) VALUES (?, ?, ?)`)
        .bind(rowId, JSON.stringify(data), Date.now()).run();
      return { id: rowId, ...data };
    },
    async baasGet(pid, coll, rowId) {
      const t = this.baasTable(pid, coll);
      const r = await d1.prepare(`SELECT id, data FROM ${t} WHERE id = ?`).bind(rowId).first();
      return r ? { id: r.id, ...JSON.parse(r.data) } : null;
    },
    async baasUpdate(pid, coll, rowId, patch) {
      const cur = await this.baasGet(pid, coll, rowId);
      if (!cur) return null;
      const t = this.baasTable(pid, coll);
      const { id: _ignored, ...data } = patch || {};
      const next = { ...cur, ...data };
      delete next.id;
      await d1.prepare(`UPDATE ${t} SET data = ? WHERE id = ?`).bind(JSON.stringify(next), rowId).run();
      return { id: rowId, ...next };
    },
    async baasRemove(pid, coll, rowId) {
      const t = this.baasTable(pid, coll);
      const r = await d1.prepare(`DELETE FROM ${t} WHERE id = ?`).bind(rowId).run();
      return r.meta.changes > 0;
    },
  };
}
