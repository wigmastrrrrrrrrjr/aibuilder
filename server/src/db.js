import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.resolve(here, '../../data');
fs.mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, 'aibuilder.db'));
db.exec('PRAGMA journal_mode = WAL;');

// Same schema lives in ../../schema.sql for Cloudflare D1.
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
`);

export const id = () => crypto.randomUUID().replace(/-/g, '').slice(0, 20);

export const store = {
  createProject(name) {
    const p = { id: id(), name: name || 'Untitled app', created_at: Date.now() };
    db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)')
      .run(p.id, p.name, p.created_at);
    return p;
  },
  listProjects() {
    return db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
  },
  getProject(pid) {
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(pid);
  },
  deleteProject(pid) {
    db.prepare('DELETE FROM files WHERE project_id = ?').run(pid);
    db.prepare('DELETE FROM messages WHERE project_id = ?').run(pid);
    db.prepare('DELETE FROM projects WHERE id = ?').run(pid);
  },
  saveFile(pid, fpath, content) {
    db.prepare(`INSERT INTO files (project_id, path, content, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT (project_id, path) DO UPDATE SET content = excluded.content,
                  updated_at = excluded.updated_at`)
      .run(pid, fpath, content, Date.now());
  },
  getFile(pid, fpath) {
    return db.prepare('SELECT * FROM files WHERE project_id = ? AND path = ?').get(pid, fpath);
  },
  listFiles(pid) {
    return db.prepare(
      'SELECT path, updated_at FROM files WHERE project_id = ? ORDER BY path'
    ).all(pid);
  },
  addMessage(pid, role, content) {
    db.prepare(
      'INSERT INTO messages (project_id, role, content, created_at) VALUES (?, ?, ?, ?)'
    ).run(pid, role, content, Date.now());
  },
  history(pid, limit = 12) {
    return db.prepare(
      `SELECT role, content FROM messages WHERE project_id = ?
       ORDER BY created_at DESC LIMIT ?`
    ).all(pid, limit).reverse();
  },

  // ---- BaaS (lazy per-collection tables; JSON rows) ----------------------
  baasTable(pid, coll) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(coll)) return null;
    return `baas_${pid.replace(/[^a-zA-Z0-9]/g, '')}_${coll}`;
  },
  baasList(pid, coll) {
    const t = this.baasTable(pid, coll);
    db.exec(`CREATE TABLE IF NOT EXISTS ${t} (
      id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    return db.prepare(`SELECT id, data FROM ${t} ORDER BY created_at`).all()
      .map(r => ({ id: r.id, ...JSON.parse(r.data) }));
  },
  baasInsert(pid, coll, obj) {
    const t = this.baasTable(pid, coll);
    db.exec(`CREATE TABLE IF NOT EXISTS ${t} (
      id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    const rowId = id();
    const { id: _ignored, ...data } = obj || {};
    db.prepare(`INSERT INTO ${t} (id, data, created_at) VALUES (?, ?, ?)`)
      .run(rowId, JSON.stringify(data), Date.now());
    return { id: rowId, ...data };
  },
  baasGet(pid, coll, rowId) {
    const t = this.baasTable(pid, coll);
    const r = db.prepare(`SELECT id, data FROM ${t} WHERE id = ?`).get(rowId);
    return r ? { id: r.id, ...JSON.parse(r.data) } : null;
  },
  baasUpdate(pid, coll, rowId, patch) {
    const cur = this.baasGet(pid, coll, rowId);
    if (!cur) return null;
    const t = this.baasTable(pid, coll);
    const { id: _ignored, ...data } = patch || {};
    const next = { ...cur, ...data };
    delete next.id;
    db.prepare(`UPDATE ${t} SET data = ? WHERE id = ?`).run(JSON.stringify(next), rowId);
    return { id: rowId, ...next };
  },
  baasRemove(pid, coll, rowId) {
    const t = this.baasTable(pid, coll);
    const r = db.prepare(`DELETE FROM ${t} WHERE id = ?`).run(rowId);
    return r.changes > 0;
  },
};
