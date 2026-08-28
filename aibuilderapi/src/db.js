// Local development backend: node:sqlite (D1 is SQLite too — same schema,
// see ../../schema.sql). Activated automatically when this module is imported;
// the Worker entry instead plugs createD1Store(env.DB) via useStore().

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { useStore } from './store.js';
import { creditsToUnits } from './models.js';

// Anti-abuse: allow a small number of signups per network before locking.
const MAX_ACCOUNTS_PER_IP = 3;

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
CREATE TABLE IF NOT EXISTS file_versions (
  project_id TEXT NOT NULL, path TEXT NOT NULL, seq INTEGER NOT NULL,
  content TEXT, encoding TEXT NOT NULL DEFAULT 'utf8', updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, path, seq)
);
CREATE INDEX IF NOT EXISTS idx_file_versions ON file_versions (project_id, path, seq);
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  label TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_snapshots_project ON snapshots (project_id, created_at);
CREATE TABLE IF NOT EXISTS snapshot_files (
  snapshot_id TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL,
  encoding TEXT NOT NULL DEFAULT 'utf8', PRIMARY KEY (snapshot_id, path)
);
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
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner TEXT NOT NULL,
  invite_code TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL,
  name TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, name)
);
CREATE INDEX IF NOT EXISTS idx_team_members ON team_members (team_id);
CREATE TABLE IF NOT EXISTS interactions (
  project_id TEXT NOT NULL,
  day TEXT NOT NULL,
  key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, day, key)
);
CREATE TABLE IF NOT EXISTS earnings (
  name TEXT PRIMARY KEY,
  units INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS presence (
  pid TEXT NOT NULL,
  sid TEXT NOT NULL,
  user TEXT NOT NULL DEFAULT '',
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (pid, sid)
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
ensureColumn('projects', "team_id TEXT NOT NULL DEFAULT ''");
ensureColumn('files', "encoding TEXT NOT NULL DEFAULT 'utf8'");
ensureColumn('users', "ip TEXT NOT NULL DEFAULT ''");
ensureColumn('users', "email TEXT NOT NULL DEFAULT ''");
ensureColumn('users', "verified INTEGER NOT NULL DEFAULT 0");

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
    db.prepare('DELETE FROM file_versions WHERE project_id = ?').run(pid);
    db.prepare('DELETE FROM messages WHERE project_id = ?').run(pid);
    db.prepare('DELETE FROM events WHERE pid = ?').run(pid);
    db.prepare('DELETE FROM snapshot_files WHERE snapshot_id IN (SELECT id FROM snapshots WHERE project_id = ?)').run(pid);
    db.prepare('DELETE FROM snapshots WHERE project_id = ?').run(pid);
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
    this.recordVersion(pid, fpath, content, encoding);
  },
  recordVersion(pid, fpath, content, encoding) {
    const { s } = db.prepare(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM file_versions WHERE project_id = ? AND path = ?'
    ).get(pid, fpath);
    db.prepare('INSERT INTO file_versions (project_id, path, seq, content, encoding, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(pid, fpath, s, content, encoding || 'utf8', Date.now());
    // prune to the latest 60 revisions per file
    db.prepare(`DELETE FROM file_versions WHERE project_id = ? AND path = ? AND seq <
      (SELECT COALESCE(MIN(seq), 0) FROM (
         SELECT seq FROM file_versions WHERE project_id = ? AND path = ?
         ORDER BY seq DESC LIMIT 60))`)
      .run(pid, fpath, pid, fpath);
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
    // record a deletion tombstone so the file can be restored
    const { s } = db.prepare(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM file_versions WHERE project_id = ? AND path = ?'
    ).get(pid, fpath);
    db.prepare('INSERT INTO file_versions (project_id, path, seq, content, updated_at) VALUES (?, ?, ?, NULL, ?)')
      .run(pid, fpath, s, Date.now());
    return { ok: true };
  },
  async fileVersions(pid, fpath) {
    return db.prepare(
      'SELECT seq, updated_at, content IS NULL AS deleted, length(content) AS bytes FROM file_versions WHERE project_id = ? AND path = ? ORDER BY seq DESC'
    ).all(pid, fpath);
  },
  async getFileVersion(pid, fpath, seq) {
    return db.prepare(
      'SELECT seq, content, encoding, updated_at FROM file_versions WHERE project_id = ? AND path = ? AND seq = ?'
    ).get(pid, fpath, seq) ?? null;
  },
  async restoreFileVersion(pid, fpath, seq) {
    const v = db.prepare(
      'SELECT content, encoding FROM file_versions WHERE project_id = ? AND path = ? AND seq = ?'
    ).get(pid, fpath, seq);
    if (!v) throw new Error('version not found');
    if (v.content == null) {
      await this.deleteFile(pid, fpath);
      return { ok: true, deleted: true, seq };
    }
    await this.saveFile(pid, fpath, v.content, v.encoding || 'utf8');
    return { ok: true, deleted: false, seq };
  },
  async listSnapshots(pid) {
    return db.prepare(
      `SELECT s.id, s.created_at, s.label,
        (SELECT count(*) FROM snapshot_files f WHERE f.snapshot_id = s.id) AS files
        FROM snapshots s WHERE s.project_id = ? ORDER BY s.created_at DESC`
    ).all(pid);
  },
  async takeSnapshot(pid, label) {
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    db.prepare('INSERT INTO snapshots (id, project_id, created_at, label) VALUES (?, ?, ?, ?)')
      .run(id, pid, Date.now(), String(label || '').slice(0, 80));
    db.prepare('INSERT INTO snapshot_files (snapshot_id, path, content, encoding) SELECT ?, path, content, COALESCE(encoding, \'utf8\') FROM files WHERE project_id = ?')
      .run(id, pid);
    // keep only the 20 most recent snapshots per project
    db.prepare(`DELETE FROM snapshots WHERE project_id = ? AND id NOT IN
      (SELECT id FROM snapshots WHERE project_id = ? ORDER BY created_at DESC LIMIT 20)`)
      .run(pid, pid);
    db.prepare('DELETE FROM snapshot_files WHERE snapshot_id NOT IN (SELECT id FROM snapshots)').run();
    return { id, pid, created_at: Date.now(), label: String(label || '').slice(0, 80) };
  },
  async getSnapshot(pid, sid) {
    const s = db.prepare('SELECT * FROM snapshots WHERE id = ? AND project_id = ?').get(sid, pid);
    if (!s) return null;
    s.files = db.prepare('SELECT path, content, encoding FROM snapshot_files WHERE snapshot_id = ? ORDER BY path').all(sid);
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
  // ---- daily credits --------------------------------------------------------
  creditsKey(userId) {
    return `credit:${userId}`;
  },
  getCredits(userId, day) {
    const r = db.prepare('SELECT count FROM usage WHERE name = ? AND day = ?')
      .get(this.creditsKey(userId), day);
    return r ? r.count : 0;
  },
  spendCredits(userId, day, amount) {
    const key = this.creditsKey(userId);
    db.prepare(`INSERT INTO usage (name, day, count) VALUES (?, ?, ?)
                ON CONFLICT (name, day) DO UPDATE SET count = count + ?`)
      .run(key, day, amount, amount);
    return db.prepare('SELECT count FROM usage WHERE name = ? AND day = ?').get(key, day).count;
  },
  // Generic name-keyed credit ledger (used for team pools + interactions),
  // plus lifetime interaction-credit earnings.
  creditGet(key, day) {
    const r = db.prepare('SELECT count FROM usage WHERE name = ? AND day = ?')
      .get(key, day);
    return r ? r.count : 0;
  },
  creditSpend(key, day, amount) {
    db.prepare(`INSERT INTO usage (name, day, count) VALUES (?, ?, ?)
                ON CONFLICT (name, day) DO UPDATE SET count = count + ?`)
      .run(key, day, amount, amount);
    return db.prepare('SELECT count FROM usage WHERE name = ? AND day = ?').get(key, day).count;
  },
  teamCreditKey(teamId) {
    return `credit:team:${teamId}`;
  },
  earningsUnits(name) {
    const r = db.prepare('SELECT units FROM earnings WHERE name = ?').get(name);
    return r ? r.units : 0;
  },
  earningsUnitsForNames(names) {
    if (!names || !names.length) return 0;
    const ph = names.map(() => '?').join(', ');
    const r = db.prepare(`SELECT COALESCE(SUM(units), 0) AS u FROM earnings WHERE name IN (${ph})`)
      .get(...names);
    return r ? r.u : 0;
  },
  earnCredits(name, units) {
    db.prepare(`INSERT INTO earnings (name, units) VALUES (?, ?)
                ON CONFLICT (name) DO UPDATE SET units = units + excluded.units`)
      .run(name, units);
  },
  spendEarnings(name, units) {
    db.prepare('UPDATE earnings SET units = MAX(0, units - ?) WHERE name = ?')
      .run(units, name);
    return this.earningsUnits(name);
  },

  // ---- teambuild: teams ---------------------------------------------------
  createTeam(name, owner) {
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    const CHS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    for (let tries = 0; tries < 5; tries++) {
      code = Array.from(crypto.getRandomValues(new Uint8Array(8)))
        .map(b => CHS[b % CHS.length]).join('');
      const clash = db.prepare('SELECT 1 FROM teams WHERE invite_code = ?').get(code);
      if (!clash) break;
    }
    db.prepare('INSERT INTO teams (id, name, owner, invite_code, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, name, owner, code, Date.now());
    db.prepare('INSERT INTO team_members (team_id, name, joined_at) VALUES (?, ?, ?)')
      .run(id, owner, Date.now());
    return this.teamInfo(id);
  },
  teamInfo(tid) {
    const t = db.prepare('SELECT * FROM teams WHERE id = ?').get(tid);
    if (!t) return null;
    t.members = db.prepare('SELECT name FROM team_members WHERE team_id = ? ORDER BY joined_at').all(tid)
      .map(r => r.name);
    return t;
  },
  teamMembers(tid) {
    return db.prepare('SELECT name FROM team_members WHERE team_id = ? ORDER BY joined_at').all(tid)
      .map(r => r.name);
  },
  addTeamMember(tid, name, joinedAt = Date.now()) {
    try {
      db.prepare('INSERT INTO team_members (team_id, name, joined_at) VALUES (?, ?, ?)')
        .run(tid, name, joinedAt);
      return true;
    } catch { return false; }
  },
  removeTeamMember(tid, name) {
    db.prepare('DELETE FROM team_members WHERE team_id = ? AND name = ?').run(tid, name);
    const r = db.prepare('SELECT COUNT(*) AS c FROM team_members WHERE team_id = ?').get(tid);
    if (r.c === 0) db.prepare('DELETE FROM teams WHERE id = ?').run(tid);
  },
  myTeams(name) {
    return db.prepare(
      `SELECT DISTINCT t.*,
        (SELECT COUNT(*) FROM team_members m WHERE m.team_id = t.id) AS members
       FROM teams t
       LEFT JOIN team_members m ON m.team_id = t.id
       WHERE t.owner = ? OR m.name = ?
       ORDER BY t.created_at DESC`
    ).all(name, name);
  },
  myTeamIds(name) {
    return db.prepare(
      'SELECT DISTINCT team_id FROM team_members WHERE name = ?'
    ).all(name).map(r => r.team_id);
  },
  isTeamMember(tid, name) {
    const r = db.prepare('SELECT 1 AS x FROM team_members WHERE team_id = ? AND name = ?')
      .get(tid, name);
    return Boolean(r);
  },
  setProjectTeam(pid, tid) {
    db.prepare('UPDATE projects SET team_id = ? WHERE id = ?').run(tid || '', pid);
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(pid);
  },
  deleteTeam(tid) {
    db.prepare('DELETE FROM team_members WHERE team_id = ?').run(tid);
    db.prepare("UPDATE projects SET team_id = '' WHERE team_id = ?").run(tid);
    db.prepare('DELETE FROM teams WHERE id = ?').run(tid);
    return { ok: true };
  },

  // ---- credit exchange: interactions --------------------------------------
  recordInteraction(pid, visitorKey, day) {
    const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(pid);
    if (!p || !p.published || !p.owner) return { ok: false, created: false };
    const vid = String(visitorKey || '');
    if (!vid) return { ok: false, created: false };
    if (vid === `user:${p.owner}`) return { ok: false, created: false };
    if (p.team_id && vid.startsWith('user:')) {
      if (this.isTeamMember(p.team_id, vid.slice(5))) return { ok: false, created: false };
    }
    let changes = 0;
    try {
      const r = db.prepare('INSERT INTO interactions (project_id, day, key, created_at) VALUES (?, ?, ?, ?)')
        .run(p.id, day || new Date().toISOString().slice(0, 10), vid, Date.now());
      changes = Number(r.changes);
    } catch { /* duplicate visitor */ }
    if (changes > 0) {
      this.earnCredits(p.owner, creditsToUnits(1));
      return { ok: true, created: true, project_id: p.id };
    }
    return { ok: true, created: false };
  },
  interactionsToday(pid, day) {
    const r = db.prepare('SELECT COUNT(*) AS c FROM interactions WHERE project_id = ? AND day = ?')
      .get(pid, day || new Date().toISOString().slice(0, 10));
    return r ? r.c : 0;
  },

  // ---- live presence (10-person concurrency cap) --------------------------
  PRESENCE_WINDOW_MS: 30000,
  async touchPresence(pid, sid, userName, now = Date.now()) {
    const key = this.PRESENCE_WINDOW_MS;
    db.prepare('DELETE FROM presence WHERE seen_at < ?').run(now - key);
    const had = db.prepare('SELECT 1 AS x FROM presence WHERE pid = ? AND sid = ?')
      .get(pid, sid);
    if (!had) {
      const cnt = db.prepare('SELECT COUNT(*) AS c FROM presence WHERE pid = ?').get(pid);
      if (cnt.c >= 10) return { active: cnt.c, accepted: false, present: false };
      db.prepare('INSERT INTO presence (pid, sid, user, seen_at) VALUES (?, ?, ?, ?)')
        .run(pid, sid, userName || '', now);
    } else {
      db.prepare('UPDATE presence SET user = ?, seen_at = ? WHERE pid = ? AND sid = ?')
        .run(userName || '', now, pid, sid);
    }
    const cnt = db.prepare('SELECT COUNT(*) AS c FROM presence WHERE pid = ?').get(pid);
    return { active: cnt.c, accepted: true, present: Boolean(had) };
  },
  async leavePresence(pid, sid) {
    db.prepare('DELETE FROM presence WHERE pid = ? AND sid = ?').run(pid, sid);
  },
  async presenceUsers(pid) {
    const now = Date.now();
    db.prepare('DELETE FROM presence WHERE seen_at < ?').run(now - this.PRESENCE_WINDOW_MS);
    return db.prepare(
      'SELECT DISTINCT user FROM presence WHERE pid = ? AND user != \'\' ORDER BY seen_at DESC LIMIT 20'
    ).all(pid).map(r => r.user);
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
    async eventsSince(pid, room, since, limit = 60) {
      return db.prepare(
        'SELECT seq, data FROM events WHERE pid = ? AND room = ? AND seq > ? ORDER BY seq LIMIT ?'
      ).all(pid, room, since, Math.min(200, Math.max(1, Number(limit) || 60))).map((r) => ({ ...JSON.parse(r.data), seq: r.seq }));
    },

    // ---- accounts & sessions -----------------------------------------------
    async createUser({ name, phash, ip, email }) {
      const id = crypto.randomUUID();
      try {
        db.prepare('INSERT INTO users (id, name, phash, created_at, ip, email) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, name, phash, Date.now(), ip || '', email || '');
      } catch {
        throw new Error('username already taken');
      }
      return { id, name };
    },
    async verifyUser(name) {
      db.prepare('UPDATE users SET verified = 1 WHERE name = ?').run(name);
    },
    async ipUsed(ip) {
      if (!ip) return null;
      const r = db.prepare("SELECT name FROM users WHERE ip = ?").all(ip);
      if (r.length < MAX_ACCOUNTS_PER_IP) return null;
      return r[0].name;
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
      return u ? { id: u.id, userId: u.id, name: u.name } : null;
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
