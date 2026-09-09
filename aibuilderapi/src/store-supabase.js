import { createClient } from '@supabase/supabase-js';
import { getVar } from './env.js';

export const V2_SUPABASE_URL = getVar('SUPABASE_URL') || 'https://trwxpgmkpaddnyktbleg.supabase.co';

let _sb = null;

export function supabaseReady() {
  const k = getVar('SUPABASE_SERVICE_KEY');
  return Boolean(k && !k.startsWith('your_') && k.length > 20);
}

function client() {
  if (!_sb) {
    _sb = createClient(V2_SUPABASE_URL, getVar('SUPABASE_SERVICE_KEY') || '', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { 'apikey': getVar('SUPABASE_SERVICE_KEY') || '' } },
    });
  }
  return _sb;
}

export const now = () => Date.now();
export const DAY = () => new Date().toISOString().slice(0, 10);

export const v2Users = {
  async create(name, phash, emailSha, ipTag) {
    const { data, error } = await client()
      .from('v2_users')
      .insert({ name, phash, email_sha: emailSha || '', ip_tag: ipTag || '' })
      .select('id,name,email_sha,ip_tag,verified,created_at')
      .single();
    if (error) {
      if (error.code === '23505') return null;
      if (error.message && error.message.includes('duplicate')) return null;
      throw error;
    }
    return data;
  },
  async byName(name) {
    const { data, error } = await client().from('v2_users').select('*').eq('name', name).maybeSingle();
    if (error) throw error;
    return data;
  },
  async setIpTag(name, tag) {
    const { error } = await client().from('v2_users').update({ ip_tag: tag }).eq('name', name);
    if (error) throw error;
  },
  async setPassword(name, phash) {
    const { error } = await client().from('v2_users').update({ phash }).eq('name', name);
    if (error) throw error;
  },
};

export const v2Sessions = {
  SESSION_TTL: 30 * 24 * 60 * 60 * 1000,
  async create(userId) {
    const token = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const exp = now() + v2Sessions.SESSION_TTL;
    const { error } = await client().from('v2_sessions').insert({ token, user_id: userId, exp });
    if (error) throw error;
    return token;
  },
  async userByToken(token) {
    const { data, error } = await client()
      .from('v2_sessions').select('token,exp,user_id,v2_users(id,name,verified,created_at)')
      .eq('token', token).maybeSingle();
    if (error) throw error;
    if (!data || data.exp < now() || !data.v2_users) return null;
    return data.v2_users;
  },
  async remove(token) {
    const { error } = await client().from('v2_sessions').delete().eq('token', token);
    if (error) throw error;
  },
  async forUser(userId) {
    const { data, error } = await client().from('v2_sessions').select('token').eq('user_id', userId);
    if (error) throw error;
    return data || [];
  },
};

export const v2Projects = {
  async create(owner, fields) {
    const { data, error } = await client()
      .from('v2_projects')
      .insert({
        owner,
        name: fields.name,
        description: fields.description || '',
        model: fields.model || '',
        plan: fields.plan || 'free',
        published: Boolean(fields.published),
      })
      .select('*')
      .single();
    if (error) throw error;
    return data;
  },
  async byId(id) {
    const { data, error } = await client().from('v2_projects').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data;
  },
  async byOwner(owner) {
    const { data, error } = await client()
      .from('v2_projects').select('*').eq('owner', owner).order('updated_at', { ascending: false });
    if (error) throw error;
    return data || [];
  },
  async published(limit) {
    const { data, error } = await client()
      .from('v2_projects').select('*').eq('published', true)
      .order('updated_at', { ascending: false }).limit(limit || 100);
    if (error) throw error;
    return data || [];
  },
  async update(id, patch) {
    const { data, error } = await client().from('v2_projects').update(patch).eq('id', id).select('*').single();
    if (error) throw error;
    return data;
  },
  async remove(id) {
    const { error } = await client().from('v2_projects').delete().eq('id', id);
    if (error) throw error;
  },
};

export const v2Files = {
  async list(projectId) {
    const { data, error } = await client().from('v2_files').select('path,encoding,updated_at').eq('project_id', projectId);
    if (error) throw error;
    return data || [];
  },
  async get(projectId, path) {
    const { data, error } = await client()
      .from('v2_files').select('*').eq('project_id', projectId).eq('path', path).maybeSingle();
    if (error) throw error;
    return data;
  },
  async put(projectId, path, fields) {
    const row = {
      project_id: projectId,
      path,
      content: fields.content != null ? fields.content : '',
      encoding: fields.encoding || 'utf-8',
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await client()
      .from('v2_files').upsert(row, { onConflict: 'project_id,path' }).select('*').single();
    if (error) throw error;
    return data;
  },
  async remove(projectId, path) {
    const { error } = await client().from('v2_files').delete().eq('project_id', projectId).eq('path', path);
    if (error) throw error;
  },
};

export const v2Messages = {
  async nextSeq(projectId) {
    const { data } = await client()
      .from('v2_messages').select('seq').eq('project_id', projectId)
      .order('seq', { ascending: false }).limit(1);
    return ((data && data[0] && data[0].seq) || 0) + 1;
  },
  async add(projectId, seq, role, content) {
    const row = { project_id: projectId, seq, role, content: String(content || ''), t: now() };
    const { data, error } = await client().from('v2_messages').insert(row).select('*').single();
    if (error) throw error;
    return data;
  },
  async list(projectId, limit, since) {
    let q = client().from('v2_messages').select('*').eq('project_id', projectId);
    if (since) q = q.gt('seq', since);
    q = q.order('seq', { ascending: true }).limit(Number(limit) || 200);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  },
};

export const v2Events = {
  async add(room, type, user, payload) {
    const row = { room, type: type || 'message', user: user || 'anon', data: payload || {}, ts: now() };
    const { data, error } = await client().from('v2_events').insert(row).select('*').single();
    if (error) throw error;
    return data;
  },
  async list(room, limit, since) {
    let q = client().from('v2_events').select('*').eq('room', room);
    if (since) q = q.gt('id', since);
    q = q.order('id', { ascending: true }).limit(Number(limit) || 100);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  },
  async lastSeq(room) {
    const { data } = await client().from('v2_events').select('id').eq('room', room)
      .order('id', { ascending: false }).limit(1);
    return ((data && data[0] && data[0].id) || 0);
  },
};

export const v2Credits = {
  async add(userName, day, kind, units) {
    const { error } = await client()
      .from('v2_credit_ledger').insert({ name: userName, day, kind, units });
    if (error) throw error;
  },
  async sum(userName, day, kind) {
    let q = client().from('v2_credit_ledger').select('units').eq('name', userName).eq('day', day);
    if (kind) q = q.eq('kind', kind);
    const { data, error } = await q;
    if (error) throw error;
    return (data || []).reduce((a, r) => a + Number(r.units), 0);
  },
};

export async function v2ReadyOrThrow(c) {
  if (!supabaseReady()) {
    return c.json({ ok: false, error: 'v2 storage is not configured (SUPABASE_SERVICE_KEY missing)' }, 501);
  }
  return null;
}