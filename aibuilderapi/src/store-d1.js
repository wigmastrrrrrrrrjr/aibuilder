// Cloudflare D1 implementation of the same store interface as db.js.
// Same SQL, same lazy BaaS tables — see ../../schema.sql for the base schema.

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
      await d1.prepare('DELETE FROM messages WHERE project_id = ?').bind(pid).run();
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
      return { ok: true };
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
      return u ? { userId: u.id, name: u.name } : null;
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
    async eventsSince(pid, room, since) {
      const { results } = await d1.prepare(
        'SELECT data, seq FROM events WHERE pid = ? AND room = ? AND seq > ? ORDER BY seq LIMIT 60'
      ).bind(pid, room, since).all();
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
