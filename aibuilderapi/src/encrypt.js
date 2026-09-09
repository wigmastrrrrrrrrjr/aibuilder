// Application-level encryption at rest.
//
// Project file contents and chat messages are encrypted (AES-256-GCM, with a
// fresh random IV per write) before they touch D1 or Supabase, and decrypted
// on read — so content is only ever decoded on the way to a viewer/preview.
//
// The key is CONTENT_ENC_KEY (a [vars] or secret binding). Without a key the
// helpers pass plaintext through unchanged, which keeps local dev working and
// lets pre-encryption rows (no "enc0:" marker) still be read.
//
// Rows written by this module always carry the "enc0:" prefix; anything else
// is treated as legacy plaintext and returned as-is.

import { getVar } from './env.js';

const PREFIX = 'enc0:';

let _key = null;
async function keyBuf() {
  if (_key) return _key;
  const secret = getVar('CONTENT_ENC_KEY');
  if (!secret) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(secret)));
  _key = await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return _key;
}

export async function encryptText(plain) {
  const key = await keyBuf();
  if (!key) return plain;
  const text = String(plain ?? '');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
  const packed = new Uint8Array(iv.length + ct.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(ct), iv.length);
  return PREFIX + Array.from(packed, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function decryptText(value) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return value;
  const key = await keyBuf();
  if (!key) return value;
  const packed = value.slice(PREFIX.length);
  const iv = new Uint8Array(12);
  const ct = new Uint8Array((packed.length / 2) - 12);
  for (let i = 0; i < packed.length; i += 2) {
    const b = parseInt(packed.slice(i, i + 2), 16);
    if (i < 24) iv[i / 2] = b; else ct[(i - 24) / 2] = b;
  }
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(pt);
}