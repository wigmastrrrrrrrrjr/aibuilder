// Local development backend: node:sqlite (D1 is SQLite too — same schema,
// see ../../schema.sql). Activated automatically when this module is imported;
// the Worker entry instead plugs createD1Store(env.DB) via useStore().

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { useStore } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.resolve(here, '../../data');
fs.mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, 'aibuilder.db'));
db.exec('PRAGMA journal_mode = WAL;');

// Mirrored in ../../schema.sql for Cloudflare D1.
db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  project_id TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL,
  updated_at INTEGER NOT NULL, PRIMARY KEY (project_id, path)
);
CREATE TABLE IF NOT EXISTS messages (
  project_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_project ON messages (project_id, created_at);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  pid TEXT NOT NULL, room TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_room ON events (pid, room, seq);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  phash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  exp INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
  name TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (name, day)
);
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`);

function ensureColumn(table, colDef) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef}`); } catch { /* exists */ }
}
ensureColumn('projects', 'published INTEGER NOT NULL DEFAULT 0');
ensureColumn('projects', 'slug TEXT');
ensureColumn('projects', "description TEXT NOT NULL DEFAULT ''");
ensureColumn('projects', 'model TEXT');
ensureColumn('projects', 'plan TEXT');
ensureColumn('projects', "owner TEXT NOT NULL DEFAULT ''");
ensureColumn('files', "encoding TEXT NOT NULL DEFAULT 'utf8'");
ensureColumn('users', "ip TEXT NOT NULL DEFAULT ''");

function slugify(name) {
  const s = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (s || 'app').slice(0, 40);
}

useStore({
  async createProject(name, owner) {
    const p = { id: crypto.randomUUID().replace(/-/g, '').slice(0, 20), name: name || 'Untitled app', created_at: Date.now() };
    db.prepare('INSERT INTO projects (id, name, created_at, owner) VALUES (?, ?, ?, ?)')
      .run(p.id, p.name, p.created_at, owner || '');
    return p;
  },
  async listProjects() {
    return db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
  },
  async getProject(pid) {
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(pid) ?? null;
  },
  async deleteProject(pid) {
    db.prepare('DELETE FROM files WHERE project_id = ?').run(pid);
    db.prepare('DELETE FROM messages WHERE project_id = ?').run(pid);
    db.prepare('DELETE FROM projects WHERE id = ?').run(pid);
    return { ok: true };
  },
  async setModel(pid, model) {
    if (!/^[A-Za-z0-9._:+%-]{1,64}$/.test(model || '')) return;
    db.prepare('UPDATE projects SET model = ? WHERE id = ?').run(model, pid);
  },
  async setPublished(pid, publish, description) {
    const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(pid);
    if (!p) throw new Error('not found');
    let slug = p.slug;
    if (!slug) slug = slugify(p.name);
    if (publish) {
      for (let i = 2; ; i++) {
        const taken = db.prepare('SELECT 1 FROM projects WHERE slug = ? AND id != ?').get(slug, pid);
        if (!taken) break;
        slug = `${slugify(p.name)}-${i}`;
      }
    }
    const desc = description !== undefined && description !== null
      ? String(description) : (p.description ?? '');
    db.prepare('UPDATE projects SET published = ?, slug = ?, description = ? WHERE id = ?')
      .run(publish ? 1 : 0, slug, desc, pid);
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(pid);
  },
  async discover() {
    return db.prepare(
      `SELECT id, slug, name, description, created_at FROM projects
       WHERE published = 1 ORDER BY created_at DESC`
    ).all();
  },
  async remix(srcPid, owner) {
    const src = db.prepare('SELECT * FROM projects WHERE id = ?').get(srcPid);
    if (!src) return null;
    const copy = { id: crypto.randomUUID().replace(/-/g, '').slice(0, 20), name: `${src.name} (remix)`, created_at: Date.now() };
    db.prepare('INSERT INTO projects (id, name, created_at, owner) VALUES (?, ?, ?, ?)')
      .run(copy.id, copy.name, copy.created_at, owner || '');
    db.prepare(`INSERT INTO files (project_id, path, content, encoding, updated_at)
                SELECT ?, path, content, encoding, ? FROM files WHERE project_id = ?`)
      .run(copy.id, Date.now(), srcPid);
    if (src.description) {
      db.prepare('UPDATE projects SET description = ? WHERE id = ?').run(src.description, copy.id);
    }
    return copy;
  },

  async saveFile(pid, fpath, content, encoding = 'utf8') {
    db.prepare(`INSERT INTO files (project_id, path, content, encoding, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (project_id, path) DO UPDATE SET content = excluded.content,
                  encoding = excluded.encoding, updated_at = excluded.updated_at`)
      .run(pid, fpath, content, encoding, Date.now());
  },
  async getFile(pid, fpath) {
    return db.prepare('SELECT * FROM files WHERE project_id = ? AND path = ?').get(pid, fpath) ?? null;
  },
  async listFiles(pid) {
    return db.prepare(
      'SELECT path, updated_at FROM files WHERE project_id = ? ORDER BY path'
    ).all(pid);
  },
  async deleteFile(pid, fpath) {
    db.prepare('DELETE FROM files WHERE project_id = ? AND path = ?').run(pid, fpath);
    return { ok: true };
  },
  async setPlan(pid, plan) {
    // plan: array of {text, done} — stored as JSON on the project row
    db.prepare('UPDATE projects SET plan = ? WHERE id = ?')
      .run(plan == null ? null : JSON.stringify(plan), pid);
  },
  async rename(pid, name) {
    const r = db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, pid);
    if (!r.changes) throw new Error('not found');
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(pid);
  },
  async incrUsage(name, day) {
    db.prepare(`INSERT INTO usage (name, day, count) VALUES (?, ?, 1)
                ON CONFLICT (name, day) DO UPDATE SET count = count + 1`).run(name, day);
    return db.prepare('SELECT count FROM usage WHERE name = ? AND day = ?').get(name, day).count;
  },
  async addMessage(pid, role, content) {
    db.prepare(
      'INSERT INTO messages (project_id, role, content, created_at) VALUES (?, ?, ?, ?)'
    ).run(pid, role, content, Date.now());
  },
  async history(pid, limit = 12) {
    return db.prepare(
      `SELECT role, content FROM messages WHERE project_id = ?
       ORDER BY created_at DESC LIMIT ?`
    ).all(pid, limit).reverse();
  },

  // ---- live event log (multiplayer) ---------------------------------------
  async appendEvent(pid, room, data) {
    const r = db.prepare('INSERT INTO events (pid, room, data) VALUES (?, ?, ?)')
      .run(pid, room, JSON.stringify(data ?? {}));
    return Number(r.lastInsertRowid);
  },
  async currentSeq(pid, room) {
    const r = db.prepare(
      'SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE pid = ? AND room = ?'
    ).get(pid, room);
    return r.s;
  },
    async eventsSince(pid, room, since) {
      return db.prepare(
        'SELECT seq, data FROM events WHERE pid = ? AND room = ? AND seq > ? ORDER BY seq LIMIT 60'
      ).all(pid, room, since).map((r) => ({ ...JSON.parse(r.data), seq: r.seq }));
    },

    // ---- accounts & sessions -----------------------------------------------
    async createUser({ name, phash, ip }) {
      const id = crypto.randomUUID();
      try {
        db.prepare('INSERT INTO users (id, name, phash, created_at, ip) VALUES (?, ?, ?, ?, ?)')
          .run(id, name, phash, Date.now(), ip || '');
      } catch {
        throw new Error('username already taken');
      }
      return { id, name };
    },
    async ipUsed(ip) {
      if (!ip) return null;
      const r = db.prepare("SELECT name FROM users WHERE ip = ? LIMIT 1").get(ip);
      return r ? r.name : null;
    },
    async resetPassword(name, phash) {
      const r = db.prepare('UPDATE users SET phash = ? WHERE name = ?').run(phash, name);
      if (!r.changes) return null;
      return db.prepare('SELECT * FROM users WHERE name = ?').get(name);
    },
    async updateUserIp(name, ipHash) {
      // backfill on login so pre-existing accounts become resettable
      db.prepare("UPDATE users SET ip = ? WHERE name = ? AND ip = ''").run(ipHash, name);
    },
    async metaGet(key) {
      const r = db.prepare('SELECT v FROM meta WHERE k = ?').get(key);
      return r ? r.v : null;
    },
    async metaSet(key, val) {
      db.prepare(`INSERT INTO meta (k, v) VALUES (?, ?)
                  ON CONFLICT (k) DO UPDATE SET v = excluded.v`).run(key, String(val));
    },
    async findUserByName(name) {
      const r = db.prepare('SELECT * FROM users WHERE name = ?').get(name);
      return r ? { id: r.id, name: r.name, phash: r.phash } : null;
    },
    async createSession(userId, days = 30) {
      const token = [...crypto.getRandomValues(new Uint8Array(24))]
        .map((b) => b.toString(16).padStart(2, '0')).join('');
      db.prepare('INSERT INTO sessions (token, user_id, exp) VALUES (?, ?, ?)')
        .run(token, userId, Date.now() + days * 86400000);
      return token;
    },
    async getSession(token) {
      const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
      if (!s || s.exp < Date.now()) return null;
      const u = db.prepare('SELECT id, name FROM users WHERE id = ?').get(s.user_id);
      return u ? { userId: u.id, name: u.name } : null;
    },
    async deleteSession(token) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    },

  // ---- BaaS (lazy per-collection tables; JSON rows) ----------------------
  baasTable(pid, coll) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(coll)) return null;
    return `baas_${pid.replace(/[^a-zA-Z0-9]/g, '')}_${coll}`;
  },
  _ensure(t) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${t} (
      id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  },
  async baasList(pid, coll) {
    const t = this.baasTable(pid, coll);
    this._ensure(t);
    return db.prepare(`SELECT id, data FROM ${t} ORDER BY created_at`).all()
      .map(r => ({ id: r.id, ...JSON.parse(r.data) }));
  },
  async baasInsert(pid, coll, obj) {
    const t = this.baasTable(pid, coll);
    this._ensure(t);
    const rowId = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    const { id: _ignored, ...data } = obj || {};
    db.prepare(`INSERT INTO ${t} (id, data, created_at) VALUES (?, ?, ?)`)
      .run(rowId, JSON.stringify(data), Date.now());
    return { id: rowId, ...data };
  },
  async baasGet(pid, coll, rowId) {
    const t = this.baasTable(pid, coll);
    const r = db.prepare(`SELECT id, data FROM ${t} WHERE id = ?`).get(rowId);
    return r ? { id: r.id, ...JSON.parse(r.data) } : null;
  },
  async baasUpdate(pid, coll, rowId, patch) {
    const cur = await this.baasGet(pid, coll, rowId);
    if (!cur) return null;
    const t = this.baasTable(pid, coll);
    const { id: _ignored, ...data } = patch || {};
    const next = { ...cur, ...data };
    delete next.id;
    db.prepare(`UPDATE ${t} SET data = ? WHERE id = ?`).run(JSON.stringify(next), rowId);
    return { id: rowId, ...next };
  },
  async baasRemove(pid, coll, rowId) {
    const t = this.baasTable(pid, coll);
    const r = db.prepare(`DELETE FROM ${t} WHERE id = ?`).run(rowId);
    return r.changes > 0;
  },
});
