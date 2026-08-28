// Emails are never stored in plain text. Signups store a one-way SHA-256
// digest (prefixed with "sha256:") instead, so a DB leak can't expose them.
// Emails are never looked up by value, so hashing does not break any flow.

export async function hashEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return '';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(e));
  return 'sha256:' + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const EMAIL_HASH_PREFIX = 'sha256:';