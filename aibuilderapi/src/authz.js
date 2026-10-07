// Central project authorization policy.
//
// One definition of "who may see / read / write this project", shared by the
// v1 API, the preview server, the BaaS and the terminal. Before this module
// each route decided for itself — and several decided "anyone", because the
// only thing they had was a project id. A project id is an identifier, never
// an authorization credential: ids leak through URLs, referrers, browser
// history, screenshots and logs, so every request re-derives permission from
// the caller's session and the project's owner/team/published state.
//
// The concepts, in one place:
//
//   public read  — published === true only. Never "no flag set".
//   owner read   — canWrite(): owner or team member. Private source, chat,
//                  version history, snapshots, export, terminal state.
//   owner write  — canWrite() in auth.js: owner or team member. Also fails
//                  closed on an ownerless row.
//   app access   — generated apps are not the platform owner. They present a
//                  short-lived signed preview token (mintPreviewToken), never
//                  a session, and only ever for their own project.
//
// Routes use the function forms so the check is impossible to skip:
//
//   const p = await requireWrite(c, pid);
//   if (p instanceof Response) return p;   // before ANY side effect
//
// or the middleware form where Hono guarantees ordering:
//
//   app.get('/api/projects/:pid', requireUser, requireOwnedMw(), handler)
//
// 404 vs 403: an unreadable project reports 404 to anonymous callers so ids
// can't be probed for existence; a signed-in user with no claim gets 403.

import { store } from './store.js';
import { getUser, canWrite } from './auth.js';
import { getVar } from './env.js';

// Context key the middleware stores the resolved project on.
export const PROJECT = 'authzProject';

/** A project is public only when explicitly published. `published` is truthy
 *  across all three storage shapes (d1/sqlite integer, supabase boolean, and
 *  the synthesised JS objects), so a plain truth test is correct and an absent
 *  flag is never mistaken for public. */
export const isPublished = (project) => Boolean(project && project.published);

/** Read permission == write permission: owner or team member. Deliberately NOT
 *  "published implies readable" — publishing exposes a project through the
 *  discovery feed and its public preview, not its chat log, export bundle,
 *  revision history or snapshots. */
export const canRead = canWrite;

/** Load a project, treating a throwing backend as "not found". */
export async function loadProject(pid) {
  if (!pid || typeof pid !== 'string') return null;
  try {
    return (await store.getProject(pid)) || null;
  } catch {
    return null;
  }
}

/** Project fields safe to hand to a non-owner (drops identity columns). */
export function publicProjectView(project) {
  if (!project) return null;
  const { owner, team_id, ...rest } = project;
  void owner; void team_id;
  return rest;
}

/** The caller's session, preferring one requireUser already resolved. */
export async function actorOf(c) {
  return c.get('user') || (await getUser(c));
}

const forbidden = (c) => c.json({ error: "you don't own this project" }, 403);
const hidden = (c) => c.json({ error: 'not found' }, 404);
const unauth = (c) => c.json({ error: 'sign in required' }, 401);

/** Owner/team read: private metadata, files, chat, history, export, snapshots. */
export async function requireRead(c, pid) {
  const project = await loadProject(pid);
  if (!project) return hidden(c);
  const user = await actorOf(c);
  if (!(await canRead(project, user))) return user ? forbidden(c) : hidden(c);
  c.set(PROJECT, project);
  return project;
}

/**
 * Owner/team write. MUST run before any side effect — in particular before
 * mirrorToTerminal()/execCommand(), so a rejected request can never read or
 * rewrite the victim's files.
 */
export async function requireWrite(c, pid) {
  const project = await loadProject(pid);
  if (!project) return hidden(c);
  const user = await actorOf(c);
  if (!user) return unauth(c);
  if (!(await canWrite(project, user))) return forbidden(c);
  c.set(PROJECT, project);
  return project;
}

/** Published-only. remix copies a project's full source into a new editable
 *  project, so it must be unreachable for a private project — otherwise any
 *  signed-in user exfiltrates it just by remixing. */
export async function requirePublished(c, pid) {
  const project = await loadProject(pid);
  if (!project) return hidden(c);
  if (!isPublished(project)) return forbidden(c);
  return project;
}

/**
 * Published OR owner — the visibility model the Terms describe. Unpublished
 * content stays private, published content is world-readable. Also accepts a
 * signed app token so a generated app keeps reading its own project while the
 * owner is signed out or the preview is embedded in an iframe.
 */
export async function requireVisible(c, pid) {
  const project = await loadProject(pid);
  if (!project) return hidden(c);
  if (isPublished(project)) {
    c.set(PROJECT, project);
    return project;
  }
  const user = await actorOf(c);
  if (user && (await canRead(project, user))) {
    c.set(PROJECT, project);
    return project;
  }
  if (await verifyPreviewToken(c, pid)) {
    c.set(PROJECT, project);
    return project;
  }
  return user ? forbidden(c) : hidden(c);
}

/** Can `c` write to `pid`'s BaaS / live rooms? published apps stay open so
 *  generated apps keep working; private ones are owner/token only. */
export async function canWriteProjectData(c, pid) {
  const project = await loadProject(pid);
  if (!project) return false;
  if (isPublished(project)) return true;
  const user = await actorOf(c);
  if (user && (await canRead(project, user))) return true;
  return verifyPreviewToken(c, pid);
}

// ---- Hono middleware forms -------------------------------------------------
// requireUser must be listed first: these read c.get('user') when present.

const pidOf = (c) => c.req.param('pid') || c.req.param('id') || '';

export const requireVisibleMw = () => async (c, next) => {
  const r = await requireVisible(c, pidOf(c));
  return r instanceof Response ? r : next();
};

export const requireOwnedMw = () => async (c, next) => {
  const r = await requireWrite(c, pidOf(c));
  return r instanceof Response ? r : next();
};

export const requirePublishedMw = () => async (c, next) => {
  const r = await requirePublished(c, pidOf(c));
  return r instanceof Response ? r : next();
};

// ---- short-lived signed app tokens ----------------------------------------
// Private previews load in an <iframe> and via window.open(), neither of which
// can carry the x-ab-sess header. Rather than publish the project, or paste a
// 30-day session token into a URL where it lands in history and referrers, the
// owner mints a token scoped to one project with a minutes-long lifetime. It
// grants read access to that project only: not a session, not refreshable, and
// it expires on its own.

const TOKEN_TTL_MS = 15 * 60 * 1000;
const enc = new TextEncoder();

// base64url without Buffer — Buffer does not exist in Workers.
function b64urlEncode(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const pad = str.length % 4 ? '='.repeat(4 - (str.length % 4)) : '';
  const bin = atob(String(str).replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const _hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

let _secret = null;
async function tokenSecret() {
  if (_secret !== null) return _secret;
  const fromEnv = getVar('PREVIEW_TOKEN_SECRET');
  if (fromEnv) { _secret = String(fromEnv); return _secret; }
  // Same meta-table fallback auth.js uses for IP hashing, so local/dev
  // installs keep working with no extra configuration.
  try {
    let s = await store.metaGet('preview_token_secret');
    if (!s) {
      s = _hex(crypto.getRandomValues(new Uint8Array(32)));
      await store.metaSet('preview_token_secret', s);
    }
    _secret = String(s);
  } catch {
    _secret = '';
  }
  return _secret;
}

let _key = null;
async function tokenKey() {
  if (_key) return _key;
  const s = await tokenSecret();
  if (!s) return null;
  _key = await crypto.subtle.importKey(
    'raw', enc.encode(s), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return _key;
}

function timingSafeEqual(a, b) {
  const x = String(a); const y = String(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/** Mint a preview token for `pid`. Empty string if no secret is available. */
export async function mintPreviewToken(pid, userName) {
  if (!pid) return '';
  const key = await tokenKey();
  if (!key) return '';
  const payload = `${pid}.${Date.now() + TOKEN_TTL_MS}.${userName || ''}`;
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return `${b64urlEncode(enc.encode(payload))}.${b64urlEncode(new Uint8Array(sig))}`;
}

/** Verify `token` was minted for exactly `pid` and hasn't expired. */
export async function verifyPreviewTokenFor(pid, token) {
  if (!token || !pid) return false;
  const key = await tokenKey();
  if (!key) return false;
  const parts = String(token).split('.');
  if (parts.length !== 2) return false;
  let payload;
  try {
    payload = new TextDecoder().decode(b64urlDecode(parts[0]));
  } catch { return false; }
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  if (!timingSafeEqual(b64urlEncode(new Uint8Array(sig)), parts[1])) return false;
  const [tpid, exp] = payload.split('.');
  if (tpid !== pid) return false;
  const e = Number(exp);
  return Number.isFinite(e) && e >= Date.now();
}

export const PREVIEW_COOKIE = 'ab_prev';

/** Read the preview token for `pid` from the header, query string or cookie.
 *  The cookie matters for preview sub-resources: an <iframe> entry request can
 *  carry `?pt=`, but the page's CSS/JS/image requests do not repeat it. */
export function previewTokenFrom(c) {
  return c.req.header('x-ab-preview')
    || c.req.query('pt')
    || readCookie(c, PREVIEW_COOKIE)
    || '';
}

/** Verify the preview token presented for `pid`, if any. */
export async function verifyPreviewToken(c, pid) {
  return verifyPreviewTokenFor(pid, previewTokenFrom(c));
}

/** Path-scoped, short-lived cookie so a private preview's sub-resources
 *  authorize too. HttpOnly: page JS in the preview can neither read nor forge
 *  it. SameSite=None so it survives the cross-origin Pages -> Worker embed the
 *  default deployment uses; Secure is required for that. */
export function previewCookieHeader(pid, token) {
  return [
    `${PREVIEW_COOKIE}=${token}`,
    `Path=/preview/${pid}`,
    'Max-Age=900',
    'HttpOnly',
    'Secure',
    'SameSite=None',
  ].join('; ');
}

function readCookie(c, name) {
  const raw = c.req.header('cookie') || '';
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return '';
}
