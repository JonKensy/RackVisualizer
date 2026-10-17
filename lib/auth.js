import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Client, InvalidCredentialsError, escapeFilter } from 'ldapts';

// Authentication core. Mirrors the auth model of our companion
// ram-inventory app: signed session cookie, PBKDF2 local users, optional
// Active Directory bind with an optional security-group restriction, local
// fallback on AD failure.
//
// Security notes:
// - Local passwords are stored as pbkdf2_sha256$iterations$salt$digest with
//   600,000 iterations (OWASP guidance) and a fresh 16-byte random salt per
//   user. Verification uses timingSafeEqual to avoid timing side channels.
//   Plaintext passwords are never written to disk.
// - The session-signing secret is 32 random bytes, created on first start
//   with 0600 permissions and persisted so sessions survive restarts.
// - AD bind happens over LDAPS (ldaps://, port 636). The domain controller
//   uses a self-signed certificate, so certificate validation is
//   intentionally disabled for this connection (trusted-LAN tradeoff). The
//   bind password is used transiently and never stored.
// - LDAP search filters escape the configured group name and the username
//   (ldapts escapeFilter) to prevent LDAP injection.
// - Group enforcement fails closed: if the group or the user cannot be
//   found, the login is denied.
// - If the DC is unreachable, ldapVerify returns false and authentication
//   falls back to local users. Availability tradeoff: an attacker who can
//   block DC traffic can force local-only auth, but still needs a valid
//   local password.

export const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24-hour sessions
const PBKDF2_ITERATIONS = 600_000;

// LDAP settings come from the environment (docker-compose.yml). An empty
// LDAP_SERVER disables AD auth entirely and uses local users only.
export const ldapConfig = {
  serverUrl: (process.env.LDAP_SERVER || '').trim(),
  userDnTemplate: process.env.LDAP_USER_DN_TEMPLATE || '{username}@example.com',
  groupName: (process.env.LDAP_GROUP_NAME || '').trim(),
};

// Reuse the persisted session-signing key, or generate a 32-byte random one
// on first start. Written with 0600 so only the app user can read it.
export function loadOrCreateSecret(secretFile) {
  try {
    return fs.readFileSync(secretFile, 'utf8').trim();
  } catch {
    fs.mkdirSync(path.dirname(secretFile), { recursive: true });
    const secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(secretFile, secret + '\n', { mode: 0o600 });
    return secret;
  }
}

// PBKDF2-SHA256, 600k iterations, 16-byte random salt per password.
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = crypto.pbkdf2Sync(password, Buffer.from(salt, 'hex'), PBKDF2_ITERATIONS, 32, 'sha256').toString('hex');
  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${salt}$${digest}`;
}

// Constant-time comparison of the derived key against the stored digest.
// Malformed or foreign-format hashes are rejected outright.
export function verifyPassword(password, stored) {
  const [algo, iterations, salt, digest] = String(stored ?? '').split('$');
  if (algo !== 'pbkdf2_sha256' || !/^[0-9a-f]+$/i.test(salt ?? '') || !/^[0-9a-f]+$/i.test(digest ?? '')) return false;
  const candidate = crypto.pbkdf2Sync(password, Buffer.from(salt, 'hex'), Number(iterations), digest.length / 2, 'sha256').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(digest, 'hex'));
}

// Seeds a default admin/admin account ONLY when no users exist yet (first
// run). It is meant to be changed immediately (Account -> Change password,
// or set-password.js from the host); once any user exists this is a no-op.
export function ensureDefaultUsers(usersFile) {
  let users = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
    if (Array.isArray(parsed)) users = parsed;
  } catch { /* first run */ }
  if (users.length === 0) {
    users = [{ username: 'admin', passwordHash: hashPassword('admin'), createdAt: new Date().toISOString() }];
    fs.mkdirSync(path.dirname(usersFile), { recursive: true });
    fs.writeFileSync(usersFile, JSON.stringify(users, null, 2) + '\n');
  }
  return users;
}

// Extracts the AD domain from the UPN template (e.g. "example.com")
// and derives the LDAP search base from it.
function templateDomain() {
  const m = ldapConfig.userDnTemplate.match(/@([A-Za-z0-9.-]+)$/);
  return m ? m[1] : '';
}

function searchBaseDn() {
  const domain = templateDomain();
  return domain ? domain.split('.').map((part) => `DC=${part}`).join(',') : '';
}

// Maps "alice@example.com" and "alice" to the same account name so users
// can log in with or without the UPN suffix.
export function normalizeUsername(name) {
  const domain = templateDomain().toLowerCase();
  const idx = name.lastIndexOf('@');
  if (domain && idx !== -1 && name.slice(idx + 1).toLowerCase() === domain) return name.slice(0, idx);
  return name;
}

// Optional group restriction: looks up the configured security group and the
// user, then checks membership. Fails CLOSED — any lookup problem or missing
// entry denies the login. Usernames and the group name are passed through
// escapeFilter() so they cannot break out of the LDAP filter syntax.
async function inRequiredGroup(client, username, upn) {
  const baseDn = searchBaseDn();
  if (!baseDn) {
    console.warn(`Group check failed for ${username}: cannot derive search base from LDAP_USER_DN_TEMPLATE`);
    return false;
  }
  const groupFilter = `(&(objectClass=group)(samAccountName=${escapeFilter(ldapConfig.groupName)}))`;
  const groups = await client.search(baseDn, groupFilter, { scope: 'sub', sizeLimit: 1, attributes: ['distinguishedName'] });
  if (groups.searchEntries.length === 0) {
    console.warn(`AD group ${JSON.stringify(ldapConfig.groupName)} not found — denying AD login for ${username}`);
    return false;
  }
  const groupDn = String(groups.searchEntries[0].distinguishedName);

  const userFilter =
    `(&(objectClass=user)(|(sAMAccountName=${escapeFilter(username)})(userPrincipalName=${escapeFilter(upn)})))`;
  const users = await client.search(baseDn, userFilter, { scope: 'sub', sizeLimit: 1, attributes: ['memberOf'] });
  if (users.searchEntries.length === 0) {
    console.warn(`AD login denied for ${username}: no AD account found`);
    return false;
  }
  const mo = users.searchEntries[0].memberOf;
  const memberships = (Array.isArray(mo) ? mo : mo ? [mo] : []).map(String);
  if (!memberships.some((dn) => dn.toLowerCase() === groupDn.toLowerCase())) {
    console.warn(`AD login denied for ${username}: not a member of group ${JSON.stringify(ldapConfig.groupName)}`);
    return false;
  }
  return true;
}

// Binds to AD as {username}@domain with the supplied password. The password
// is used transiently for the bind only — never logged or stored.
// rejectUnauthorized:false is intentional: the DC presents a self-signed
// certificate (trusted-LAN tradeoff). A wrong password returns false; a
// transport/server error also returns false but logs a warning so operators
// can tell "bad credentials" from "DC unreachable" (local fallback).
export async function ldapVerify(username, password) {
  const { serverUrl, userDnTemplate, groupName } = ldapConfig;
  if (!serverUrl || !username || !password) return false;
  const userDn = userDnTemplate.replace('{username}', username);
  const client = new Client({
    url: serverUrl,
    timeout: 5000,
    connectTimeout: 3000,
    tlsOptions: serverUrl.toLowerCase().startsWith('ldaps') ? { rejectUnauthorized: false } : undefined,
  });
  try {
    await client.bind(userDn, password);
    try {
      const ok = groupName ? await inRequiredGroup(client, username, userDn) : true;
      if (ok) console.log(`AD login OK for ${username}`);
      return ok;
    } finally {
      await client.unbind().catch(() => {});
    }
  } catch (err) {
    if (err instanceof InvalidCredentialsError) return false;
    console.warn(`LDAP unavailable, falling back to local auth (${username}): ${String(err.message).slice(0, 200)}`);
    return false;
  }
}

// Order of resolution: AD first (when configured), then local users. A
// failure in either path returns null — the caller shows one generic error
// so attackers cannot enumerate which mechanism rejected them.
export async function authenticate(users, rawUsername, password) {
  const name = normalizeUsername(String(rawUsername ?? '').trim());
  if (!name || !password) return null;
  if (ldapConfig.serverUrl && (await ldapVerify(name, password))) {
    return { user: name, via: 'ad' };
  }
  const row = users.find((u) => u.username === name);
  if (row && verifyPassword(password, row.passwordHash)) {
    return { user: row.username, via: 'local' };
  }
  return null;
}
