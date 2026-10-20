// Unit tests for lib/crypto.js (AES-256-GCM secret storage).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadOrCreateKey, encryptSecret, decryptSecret } from '../lib/crypto.js';

test('key is generated once with 0600 perms and reused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfx-key-'));
  const file = path.join(dir, '.enc_key');
  const k1 = loadOrCreateKey(file);
  const k2 = loadOrCreateKey(file);
  assert.equal(k1.length, 32);
  assert.deepEqual(k1, k2);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('round trip preserves the plaintext', () => {
  const key = Buffer.alloc(32, 7);
  const blob = encryptSecret(key, 'S3cret p@ss$word!');
  assert.match(blob, /^enc\$v1\$/);
  assert.equal(decryptSecret(key, blob), 'S3cret p@ss$word!');
});

test('wrong key, tampering, and malformed blobs decrypt to null', () => {
  const key = Buffer.alloc(32, 7);
  const blob = encryptSecret(key, 'hello');
  assert.equal(decryptSecret(Buffer.alloc(32, 8), blob), null);
  const parts = blob.split('$');
  parts[4] = Buffer.from('tampered').toString('base64');
  assert.equal(decryptSecret(key, parts.join('$')), null);
  assert.equal(decryptSecret(key, 'not-a-blob'), null);
  assert.equal(decryptSecret(key, ''), null);
  assert.equal(decryptSecret(key, null), null);
});
