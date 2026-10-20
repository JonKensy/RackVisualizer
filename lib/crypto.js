// AES-256-GCM encryption for secrets persisted under data/ (the PowerFlex
// Manager and iDRAC passwords entered on the Settings page).
//
// Threat model: this protects stored passwords from casual file disclosure
// (backups, accidental reads, source-tree leaks). It does NOT protect against
// an attacker who can already read data/ — the key file sits beside the
// ciphertext. The key is generated once with 0600 perms, same pattern as the
// session secret in lib/auth.js. Losing data/.enc_key makes stored passwords
// unrecoverable (they must be re-entered).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // standard GCM nonce size

// Reuse the persisted 32-byte key, or generate one on first start.
export function loadOrCreateKey(keyFile) {
  try {
    const hex = fs.readFileSync(keyFile, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, 'hex');
  } catch {
    // fall through and create
  }
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, key.toString('hex') + '\n', { mode: 0o600 });
  return key;
}

// Versioned, self-describing blob: enc$v1$<iv>$<auth-tag>$<ciphertext>,
// base64 segments (the base64 alphabet never contains '$', so split is safe).
export function encryptSecret(key, plaintext) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return ['enc', 'v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join('$');
}

// Returns the plaintext, or null for malformed/tampered/foreign blobs —
// callers treat null as "no usable secret" and never receive an exception.
export function decryptSecret(key, blob) {
  if (typeof blob !== 'string' || !blob) return null;
  const parts = blob.split('$');
  if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1') return null;
  try {
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(parts[2], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[3], 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parts[4], 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
