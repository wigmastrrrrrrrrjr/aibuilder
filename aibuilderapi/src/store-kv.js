// Deno Deploy implementation of the store interface over the built-in Deno.KV.
// Same contract as db.js / store-d1.js — see ../../schema.sql for semantics.

function slugify(name) {
  const s = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (s || 'app').slice(0, 40);
}

const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 20);

export function createKvStore(kv) {
  return {
    async createProject(name) {
      const p = {
        id: newId(),
        name: name || 'Untitled app',
        created_at: Date.now(),
        model: '',
        published: 0,
        slug: null,
        description: '',
      };
      await kv.atomic()
        .check({ key: ['project', p.id], versionstamp: null })
        .set(['project', p.id], p)
        .set(['projects_by_time', p.created_at, p.id], p.id)
        .commit();
      return p;
    },

    async listProjects() {
      const out = [];
      const entries = kv.list({ prefix: ['projects_by_time'] }, { reverse: true });
      for await (const e of entries) {
        const p = await kv.get(['project', e.value]);
        if (p.value) out.push(p.value);
      }
      return out;
    },

    async getProject(pid) {
      const r = await kv.get(['project', pid]);
      return r.value ?? null;
    },

    async deleteProject(pid) {
      const p = await this.getProject(pid);
      if (!p) return { ok: true };
      const del = kv.atomic().delete(['project', pid]).delete(['projects_by_time', p.created_at, pid]);
      if (p.published && p.slug) del.delete(['slug', p.slug]).delete(['published', p.created_at, pid]);
      for await (const e of kv.list({ prefix: ['file', pid] })) del.delete(e.key);
      for await (const e of kv.list({ prefix: ['msg', pid] })) del.delete(e.key);
      await del.commit();
      return { ok: true };
    },

    async setModel(pid, model) {
      if (!/^[A-Za-z0-9._:+%-]{1,64}$/.test(model || '')) return;
      const p = await this.getProject(pid);
      if (!p) return;
      p.model = model;
      await kv.set(['project', pid], p);
    },

    async _putProject(p) {
      await kv.atomic()
        .set(['project', p.id], p)
        .set(['projects_by_time', p.created_at, p.id], p.id)
        .commit();
    },

    async setPublished(pid, publish, description) {
      const p = await this.getProject(pid);
      if (!p) throw new Error('not found');
      let slug = p.slug;
      if (publish && !slug) {
        slug = slugify(p.name);
        for (let i = 2; ; i++) {
          const taken = await kv.get(['slug', slug]);
          if (!taken.value) break;
          slug = `${slugify(p.name)}-${i}`;
        }
        await kv.set(['slug', slug], pid);
      }
      if (p.slug && p.slug !== slug) await kv.delete(['slug', p.slug]);
      const wasPub = Number(p.published) === 1;
      p.slug = slug;
      p.published = publish ? 1 : 0;
      if (description !== undefined && description !== null) p.description = String(description);
      await this._putProject(p);

      const idxKey = ['published', p.created_at, p.id];
      if (publish && !wasPub) {
        await kv.set(idxKey, this._pubView(p));
      } else if (!publish && wasPub) {
        await kv.delete(idxKey);
      } else if (publish) {
        await kv.set(idxKey, this._pubView(p));
      }
      return p;
    },

    _pubView(p) {
      return { id: p.id, slug: p.slug, name: p.name, description: p.description, created_at: p.created_at };
    },

    async discover() {
      const out = [];
      const entries = kv.list({ prefix: ['published'] }, { reverse: true });
      for await (const e of entries) out.push(e.value);
      return out;
    },

    async remix(srcPid) {
      const src = await this.getProject(srcPid);
      if (!src) return null;
      const copy = await this.createProject(`${src.name} (remix)`);
      const entries = kv.list({ prefix: ['file', srcPid] });
      for await (const e of entries) {
        const f = e.value;
        await kv.set(['file', copy.id, f.path], { ...f });
      }
      if (src.description) {
        copy.description = src.description;
        await this._putProject(copy);
      }
      return copy;
    },

    async saveFile(pid, fpath, content, encoding = 'utf8') {
      const prev = await kv.get(['file', pid, fpath]);
      const updated_at = Date.now();
      // keep original created ordering stable; nothing depends on it today
      void prev;
      await kv.set(['file', pid, fpath], { path: fpath, content, encoding, updated_at });
    },

    async getFile(pid, fpath) {
      const r = await kv.get(['file', pid, fpath]);
      return r.value ?? null;
    },

    async listFiles(pid) {
      const out = [];
      for await (const e of kv.list({ prefix: ['file', pid] })) {
        out.push({ path: e.value.path, updated_at: e.value.updated_at });
      }
      out.sort((a, b) => (a.path < b.path ? -1 : 1));
      return out;
    },

    async addMessage(pid, role, content) {
      const ts = Date.now();
      await kv.set(['msg', pid, ts], { role, content });
    },

    async history(pid, limit = 12) {
      const all = [];
      for await (const e of kv.list({ prefix: ['msg', pid] })) all.push(e.value);
      const tail = all.slice(-limit);
      return tail.map((m) => ({ role: m.role, content: m.content }));
    },

    // ---- live event log (multiplayer) --------------------------------------
    async appendEvent(pid, room, data) {
      const seq = ((await kv.get(['seq', pid, room])).value ?? 0) + 1;
      await kv.atomic()
        .set(['seq', pid, room], seq)
        .set(['evt', pid, room, seq], { ...(data || {}), seq })
        .commit();
      return seq;
    },
    async currentSeq(pid, room) {
      return (await kv.get(['seq', pid, room])).value ?? 0;
    },
    async eventsSince(pid, room, since) {
      const out = [];
      for await (const e of kv.list({ prefix: ['evt', pid, room] })) {
        if (e.value.seq > since) out.push(e.value);
      }
      out.sort((a, b) => a.seq - b.seq);
      return out.slice(0, 60);
    },

    baasTable(pid, coll) {
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(coll)) return null;
      return `${String(pid).replace(/[^a-zA-Z0-9]/g, '')}_${coll}`;
    },

    async baasList(pid, coll) {
      const t = this.baasTable(pid, coll);
      const out = [];
      for await (const e of kv.list({ prefix: ['baas', t] })) {
        out.push({ id: e.key[2], ...e.value.data });
      }
      return out;
    },

    async baasInsert(pid, coll, obj) {
      const t = this.baasTable(pid, coll);
      const rowId = newId();
      const data = JSON.parse(JSON.stringify(obj || {}));
      delete data.id;
      await kv.set(['baas', t, rowId], { data, created_at: Date.now() });
      return { id: rowId, ...data };
    },

    async baasGet(pid, coll, rowId) {
      const r = await kv.get(['baas', this.baasTable(pid, coll), rowId]);
      return r.value ? { id: rowId, ...r.value.data } : null;
    },

    async baasUpdate(pid, coll, rowId, patch) {
      const key = ['baas', this.baasTable(pid, coll), rowId];
      const r = await kv.get(key);
      if (!r.value) return null;
      const next = { ...r.value.data, ...(patch || {}) };
      delete next.id;
      await kv.set(key, { data: next, created_at: r.value.created_at });
      return { id: rowId, ...next };
    },

    async baasRemove(pid, coll, rowId) {
      const key = ['baas', this.baasTable(pid, coll), rowId];
      const r = await kv.get(key);
      await kv.delete(key);
      return Boolean(r.value);
    },
  };
}
