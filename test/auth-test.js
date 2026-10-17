// Auth unit tests. Two modes:
//   default (LDAP_SERVER unset)  — hash/verify, username normalization,
//                                  seeding, and authenticate() behavior.
//   AUTH_TEST_MODE=ldap-unreachable (LDAP_SERVER set to an unreachable DC)
//                                  — proves AD failure falls back to local
//                                  auth instead of erroring or granting access.
// Tests use a temp users.json so they never touch the live data directory.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert';
import {
  hashPassword, verifyPassword, ensureDefaultUsers, normalizeUsername, authenticate, ldapConfig,
} from '../lib/auth.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-test-'));
const usersFile = path.join(tmp, 'users.json');

if (process.env.AUTH_TEST_MODE === 'ldap-unreachable') {
  assert.ok(ldapConfig.serverUrl, 'expected LDAP_SERVER to be set');
  // DC unreachable -> must fall back to the local admin account.
  const users = ensureDefaultUsers(usersFile);
  const r = await authenticate(users, 'admin', 'admin');
  assert.deepEqual(r, { user: 'admin', via: 'local' });
  // An AD-style name with no local account must be rejected, not error.
  assert.equal(await authenticate(users, 'someone@example.com', 'whatever'), null);
  console.log('ldap-fallback checks passed');
} else {
  assert.equal(ldapConfig.serverUrl, '', 'expected no LDAP_SERVER');

  const stored = hashPassword('s3cret');
  assert.match(stored, /^pbkdf2_sha256\$600000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.ok(verifyPassword('s3cret', stored));
  assert.ok(!verifyPassword('wrong', stored));
  assert.ok(!verifyPassword('s3cret', 'bcrypt$1$x$y'));

  assert.equal(normalizeUsername('someone@example.com'), 'someone');
  assert.equal(normalizeUsername('someone'), 'someone');
  assert.equal(normalizeUsername('someone@other.example'), 'someone@other.example');

  let users = ensureDefaultUsers(usersFile);
  assert.equal(users.length, 1);
  assert.equal(users[0].username, 'admin');
  assert.ok(verifyPassword('admin', users[0].passwordHash));
  users = ensureDefaultUsers(usersFile); // idempotent
  assert.equal(users.length, 1);

  let r = await authenticate(users, 'admin', 'admin');
  assert.deepEqual(r, { user: 'admin', via: 'local' });
  r = await authenticate(users, 'admin@example.com', 'admin');
  assert.deepEqual(r, { user: 'admin', via: 'local' });
  assert.equal(await authenticate(users, 'admin', 'nope'), null);
  assert.equal(await authenticate(users, 'ghost', 'admin'), null);
  assert.equal(await authenticate(users, '', ''), null);

  console.log('unit checks passed');
}
