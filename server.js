// Rack Visualizer — Express server.
//
// SECURITY MODEL (overview for review):
// - Deny-by-default: every route and static asset requires an authenticated
//   session except /login, /logout, and /styles.css (see PUBLIC_PATHS).
// - Sessions are stateless signed cookies (cookie-session): the cookie value
//   is an HMAC-signed, base64-encoded JSON blob containing only the username
//   and the auth method — no secrets. It is httpOnly (scripts cannot read
//   it), SameSite=Lax (cross-site POSTs cannot ride the session, which
//   mitigates CSRF), and Secure whenever TLS is enabled. 24-hour expiry; the
//   signing key is 32 random bytes persisted with 0600 perms in
//   data/.session_secret.
// - Authentication is Active Directory (LDAPS) first with a local PBKDF2
//   fallback — see lib/auth.js for the details.
// - All untrusted input (hostnames, switch fields, CSV rows) is validated
//   with allowlists/regexes and length caps before use. Hostnames are
//   interpolated into outbound https:// URLs, so they are restricted to a
//   strict hostname charset (no scheme/port/path characters) to prevent
//   SSRF-style URL manipulation.
// - The frontend renders all API data with textContent/createElement only
//   (no innerHTML), so stored values cannot inject HTML or scripts.
// - servers.json and certs are mounted read-only; the app can only write
//   under data/. The container runs as the non-root `node` user.
//
// ACCEPTED RESIDUAL RISKS (trusted-LAN deployment):
// - TLS certificate verification is disabled for OUTBOUND calls only (iDRAC
//   Redfish and the AD domain controller use self-signed certs). Inbound
//   traffic is served over HTTPS with a self-signed cert.
// - No login rate limiting. Repeated failed AD binds may trigger AD lockout
//   policy; repeated failed iDRAC logins may lock the IDRAC_USER account.

import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieSession from 'cookie-session';
import { fetchHostSystem, fetchHostLldp, verifyHost } from './lib/redfish.js';
import { buildServer, buildRacks, parseLocation, decodeLldpId } from './lib/parse.js';
import { loadOrCreateSecret, ensureDefaultUsers, authenticate, hashPassword, verifyPassword, SESSION_MAX_AGE_MS } from './lib/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;

// data/ is the only writable state directory (discovered hosts, switches,
// model autocomplete list, local users, session secret).
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/app/data') ? '/app/data' : path.join(__dirname, 'data'));
const DISCOVERED_PATH = path.join(DATA_DIR, 'discovered.json');
const SWITCHES_PATH = path.join(DATA_DIR, 'switches.json');
const MODELS_PATH = path.join(DATA_DIR, 'switch-models.json');
const SWITCH_MACS_PATH = path.join(DATA_DIR, 'switch-macs.json');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const USERS_PATH = path.join(DATA_DIR, 'users.json');

// TLS cert/key are mounted read-only from ./certs; their presence decides
// whether the app serves HTTPS (and whether the session cookie is Secure).
const CERT_DIR = process.env.CERT_DIR || path.join(__dirname, 'certs');
const KEY_FILE = path.join(CERT_DIR, 'server.key');
const CRT_FILE = path.join(CERT_DIR, 'server.crt');
const TLS_ENABLED = fs.existsSync(KEY_FILE) && fs.existsSync(CRT_FILE);
// HMAC key for signing session cookies; generated once with 0600 perms.
const SESSION_SECRET = loadOrCreateSecret(path.join(DATA_DIR, '.session_secret'));
// Seeds a default admin/admin account only when users.json is empty (first
// run). It must be changed immediately via Account -> Change password.
ensureDefaultUsers(USERS_PATH);

// Admin-controlled baseline host list, mounted read-only at
// /app/config/servers.json. The app never writes to it.
function loadServers() {
  const candidates = [
    process.env.SERVERS_CONFIG,
    path.join(__dirname, 'config', 'servers.json'),
    path.join(__dirname, 'servers.json'),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  throw new Error('servers.json not found (expected /app/config/servers.json or ./servers.json)');
}

function loadList(file) {
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// Persist a JSON array under DATA_DIR. Callers validate entries before
// storing them, so these files only ever contain vetted values.
function saveList(file, list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(list, null, 2) + '\n');
}

const loadDiscovered = () => loadList(DISCOVERED_PATH);
const saveDiscovered = (list) => saveList(DISCOVERED_PATH, list);
const loadSwitches = () => loadList(SWITCHES_PATH);
const saveSwitches = (list) => saveList(SWITCHES_PATH, list);
const loadModels = () => loadList(MODELS_PATH);
const saveModels = (list) => saveList(MODELS_PATH, list);
const loadSwitchMacs = () => loadList(SWITCH_MACS_PATH);
const saveSwitchMacs = (list) => saveList(SWITCH_MACS_PATH, list);

// App-level toggles. LLDP collection is on by default; disabling it stops the
// app from querying iDRACs for NIC-to-switch connectivity on hover.
function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    return { lldpEnabled: s.lldpEnabled !== false };
  } catch {
    return { lldpEnabled: true };
  }
}
function saveSettings(settings) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
}

// Accepts any common MAC notation (colon, dash, dot, or bare hex) and
// normalizes to lowercase colon-separated pairs; null when not 12 hex digits.
function normalizeMac(raw) {
  const hex = String(raw ?? '').replace(/[^0-9A-Fa-f]/g, '');
  if (hex.length !== 12) return null;
  return (hex.match(/.{2}/g) ?? []).join(':').toLowerCase();
}

// Merges the admin file with user-added hosts, deduped case-insensitively.
// Only hosts that passed validHost() (or came from the admin file) reach the
// Redfish client, so credentials are only ever sent to vetted addresses.
function allHosts() {
  const seen = new Set();
  const hosts = [];
  for (const h of [...loadServers().map((s) => s.host), ...loadDiscovered().map((d) => d.host)]) {
    const key = String(h).toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      hosts.push(h);
    }
  }
  return hosts;
}

// Hostname/IP allowlist. These values are interpolated into outbound
// https:// URLs, so the charset deliberately excludes ":", "/", "@", "#",
// "?" and whitespace: a stored value can never change the scheme, port, or
// path of the request (SSRF guard). Max 253 chars (DNS name limit).
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
const validHost = (h) => typeof h === 'string' && HOST_RE.test(h.trim());

// Node-import CSV: first column of each line is the host; optional header
// and # comment lines are skipped. Extracted hosts are still checked with
// validHost() before any request is made to them.
function parseCsvHosts(text) {
  const hosts = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const first = line.split(',')[0].replace(/^"(.*)"$/, '$1').trim();
    if (!first) continue;
    if (/^(host|hostname|ip|dns|idrac)\b/i.test(first)) continue;
    hosts.push(first);
  }
  return hosts;
}

// Minimal RFC4180-style CSV line parser: handles quoted fields and ""
// escapes so values like "Cisco, 93180YC-FX3" survive intact.
function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { fields.push(cur); cur = ''; }
    else cur += ch;
  }
  fields.push(cur);
  return fields.map((f) => f.trim());
}

const SWITCH_CSV_COLUMNS = {
  makeModel: { display: 'Make/Model', aliases: ['makemodel', 'make', 'model'] },
  name: { display: 'Switch name', aliases: ['name', 'switchname', 'switch'] },
  ip: { display: 'IP address', aliases: ['ip', 'ipaddress', 'ipaddr', 'address'] },
  serial: { display: 'Serial number', aliases: ['serial', 'serialnumber', 'sn'] },
  locationRaw: { display: 'Location', aliases: ['location', 'locationraw', 'racklocation'] },
  role: { display: 'Role', aliases: ['role'] },
  heightU: { display: 'Height', aliases: ['height', 'heightu', 'u'] },
};

// Switch-import CSV: maps the header row (case-insensitive aliases) to the
// expected fields. Parsing only extracts raw strings — every row is still
// run through validateSwitch() before it is stored.
function parseSwitchCsv(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (lines.length === 0) return { entries: [], error: 'CSV is empty' };
  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const index = {};
  for (const [field, { display, aliases }] of Object.entries(SWITCH_CSV_COLUMNS)) {
    const pos = header.findIndex((h) => aliases.includes(h));
    if (pos === -1) return { entries: [], error: `CSV header must include a "${display}" column` };
    index[field] = pos;
  }
  const entries = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    if (fields.every((f) => f === '')) continue;
    const entry = {};
    for (const [field, pos] of Object.entries(index)) entry[field] = fields[pos] ?? '';
    entries.push({ line: i + 1, entry });
  }
  return { entries, error: null };
}

const app = express();

// Session cookie: signed (HMAC) so it can be read but not forged; carries
// only { user, authVia }. httpOnly blocks script access (mitigates theft via
// XSS), SameSite=Lax stops cross-site requests from carrying it (mitigates
// CSRF on the POST endpoints), and Secure is tied to TLS so the cookie is
// never transmitted in cleartext.
app.use(cookieSession({
  name: 'rackviz_session',
  keys: [SESSION_SECRET],
  maxAge: SESSION_MAX_AGE_MS,
  httpOnly: true,
  sameSite: 'lax',
  secure: TLS_ENABLED,
}));

// Deny-by-default auth gate. Everything not listed here requires a session:
// API paths get 401 JSON (so fetch() callers can detect it) while pages get
// a 303 redirect to the login screen.
const PUBLIC_PATHS = new Set(['/login', '/logout', '/styles.css']);
// Open-redirect guard for the ?next= parameter: only same-origin absolute
// paths are accepted — protocol-relative values like "//evil.com" and
// anything else fall back to "/".
const safeNext = (v) => {
  const s = String(v ?? '').trim();
  return s.startsWith('/') && !s.startsWith('//') ? s : '/';
};

app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path) || req.session?.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  res.redirect(303, `/login?next=${encodeURIComponent(safeNext(req.originalUrl))}`);
});

// The example CSV is fetched via a <download> link. express.static would
// answer Chrome's revalidation with a bodiless 304, which Chrome's download
// pipeline treats as a failed transfer — so serve it fresh every time.
app.get('/switches-example.csv', (req, res) => {
  res.set('Content-Disposition', 'attachment; filename="switches-example.csv"');
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'switches-example.csv'), { etag: false, lastModified: false });
});

// Static assets are served AFTER the auth gate, so pages and JS are not
// reachable anonymously (only /styles.css is public, for the login page).
app.use(express.static(path.join(__dirname, 'public')));

app.get('/login', (req, res) => {
  if (req.session?.user) return res.redirect(303, '/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Login. A failed attempt always redirects to the same ?error=1 page — no
// distinction between unknown user and wrong password (no user enumeration).
// On success the session object is REPLACED with a fresh one, not mutated,
// which prevents session-fixation attacks.
app.post('/login', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const result = await authenticate(ensureDefaultUsers(USERS_PATH), req.body?.username, req.body?.password);
    if (!result) {
      return res.redirect(303, `/login?error=1&next=${encodeURIComponent(safeNext(req.body?.next))}`);
    }
    req.session = { user: result.user, authVia: result.via };
    res.redirect(303, safeNext(req.body?.next));
  } catch (err) {
    console.error(`Login error: ${err.message}`);
    res.redirect(303, `/login?error=1&next=${encodeURIComponent(safeNext(req.body?.next))}`);
  }
});

// Logout: setting the session to null makes cookie-session expire the cookie.
app.get('/logout', (req, res) => {
  req.session = null;
  res.redirect(303, '/login');
});

// Returns only the caller's own identity (username, auth method, whether a
// local account exists). No other users' data is exposed.
app.get('/api/account', (req, res) => {
  const user = req.session?.user ?? null;
  const row = ensureDefaultUsers(USERS_PATH).find((u) => u.username === user);
  res.json({ user, authVia: req.session?.authVia ?? null, local: !!row });
});

app.get('/change-password', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'change-password.html'));
});

app.get('/settings', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

// Password change: requires knowledge of the current password, enforces a
// minimum length, and rejects AD-only accounts (their password lives in AD).
// Only the PBKDF2 hash is rewritten; plaintext never touches disk.
app.post('/change-password', express.json({ limit: '16kb' }), (req, res) => {
  const user = req.session?.user;
  const users = ensureDefaultUsers(USERS_PATH);
  const row = users.find((u) => u.username === user);
  if (!row) {
    return res.status(400).json({ error: 'Active Directory accounts are managed in Active Directory.' });
  }
  const { currentPassword, newPassword, confirmPassword } = req.body ?? {};
  if (!verifyPassword(String(currentPassword ?? ''), row.passwordHash)) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }
  if (String(newPassword ?? '').length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ error: 'Passwords do not match.' });
  }
  row.passwordHash = hashPassword(newPassword);
  fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2) + '\n');
  res.json({ ok: true });
});

app.get('/api/racks', async (req, res) => {
  let hosts;
  try {
    hosts = allHosts();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // iDRAC credentials come from env (.env) and are only sent to hosts from
  // the admin file or the validated discovered list. allSettled keeps one
  // unreachable host from failing the whole page.
  const creds = { user: process.env.IDRAC_USER, pass: process.env.IDRAC_PASSWORD };
  const results = await Promise.allSettled(hosts.map((host) => fetchHostSystem(host, creds)));

  const records = [];
  const errors = [];
  results.forEach((result, i) => {
    const host = hosts[i];
    if (result.status === 'fulfilled') {
      const record = buildServer(host, result.value.serviceTag, result.value.system, result.value.chassis, result.value.dellAttributes);
      records.push({ ...record, hostIp: result.value.hostIp ?? null, hostDns: result.value.hostDns ?? null });
    } else {
      errors.push({ host, reason: result.reason.message });
    }
  });

  for (const sw of loadSwitches()) {
    const parsed = parseLocation(sw.locationRaw) ?? {};
    const warnings = [];
    if (parsed.rackNumber == null || parsed.ru == null) warnings.push('unparseable location');
    records.push({
      kind: 'switch',
      name: sw.name,
      model: sw.makeModel,
      role: sw.role,
      ip: sw.ip,
      serial: sw.serial,
      serviceTag: null,
      heightU: sw.heightU,
      locationRaw: sw.locationRaw,
      datacenter: parsed.datacenter ?? null,
      env: parsed.env ?? null,
      rackNumber: parsed.rackNumber ?? null,
      ru: parsed.ru ?? null,
      warnings,
    });
  }

  res.json(buildRacks(records, errors));
});

// Add one iDRAC host. The hostname is validated against the allowlist
// first; verifyHost() then probes it anonymously (no credentials sent) to
// confirm it is reachable and speaks Redfish before it is persisted.
app.post('/api/nodes', express.json({ limit: '16kb' }), async (req, res) => {
  const host = String(req.body?.host ?? '').trim();
  if (!validHost(host)) {
    return res.status(400).json({ error: 'Invalid hostname or IP address' });
  }
  if (allHosts().some((h) => h.toLowerCase() === host.toLowerCase())) {
    return res.status(409).json({ error: `${host} is already configured` });
  }
  try {
    const serviceTag = await verifyHost(host);
    const discovered = loadDiscovered();
    discovered.push({ host, serviceTag, addedAt: new Date().toISOString() });
    saveDiscovered(discovered);
    res.json({ added: { host, serviceTag } });
  } catch (err) {
    res.status(422).json({ error: `Could not reach ${host}: ${err.message}` });
  }
});

// Bulk node import. Upload size is capped (256kb) and every extracted host
// goes through validHost() + anonymous verifyHost() before being stored.
app.post(
  '/api/nodes/import',
  express.text({ type: ['text/csv', 'text/plain'], limit: '256kb' }),
  async (req, res) => {
    const candidates = parseCsvHosts(typeof req.body === 'string' ? req.body : '');
    if (candidates.length === 0) {
      return res.status(400).json({ error: 'No host entries found in CSV' });
    }

    const existing = new Set(allHosts().map((h) => h.toLowerCase()));
    const results = { added: [], skipped: [], errors: [] };
    const pending = [];
    const seen = new Set();
    for (const host of candidates) {
      if (!validHost(host)) {
        results.errors.push({ host, reason: 'invalid hostname or IP' });
        continue;
      }
      const key = host.toLowerCase();
      if (existing.has(key) || seen.has(key)) {
        results.skipped.push(host);
        continue;
      }
      seen.add(key);
      pending.push(host);
    }

    const verified = await Promise.allSettled(pending.map((h) => verifyHost(h)));
    verified.forEach((r, i) => {
      const host = pending[i];
      if (r.status === 'fulfilled') results.added.push({ host, serviceTag: r.value });
      else results.errors.push({ host, reason: r.reason.message });
    });

    if (results.added.length > 0) {
      const discovered = loadDiscovered();
      for (const a of results.added) discovered.push({ host: a.host, serviceTag: a.serviceTag, addedAt: new Date().toISOString() });
      saveDiscovered(discovered);
    }
    res.json(results);
  },
);

// App-level toggles shown on the Settings page.
app.get('/api/settings', (req, res) => {
  res.json(loadSettings());
});

app.post('/api/settings', express.json({ limit: '16kb' }), (req, res) => {
  if (typeof req.body?.lldpEnabled !== 'boolean') {
    return res.status(400).json({ error: 'lldpEnabled must be a boolean' });
  }
  const settings = { ...loadSettings(), lldpEnabled: req.body.lldpEnabled };
  saveSettings(settings);
  res.json(settings);
});

// Static switch MAC → friendly-name map. MACs are normalized on store so
// lookups match any notation the iDRAC reports.
app.get('/api/switch-macs', (req, res) => {
  res.json({ switchMacs: loadSwitchMacs() });
});

app.post('/api/switch-macs', express.json({ limit: '16kb' }), (req, res) => {
  const mac = normalizeMac(req.body?.mac);
  const name = String(req.body?.name ?? '').trim();
  if (!mac) return res.status(400).json({ error: 'Invalid MAC address (expected 12 hex digits)' });
  if (!name || name.length > 100) return res.status(400).json({ error: 'Switch name is required (max 100 chars)' });
  const list = loadSwitchMacs();
  if (list.some((m) => String(m.mac).toLowerCase() === mac)) {
    return res.status(409).json({ error: `${mac} is already mapped` });
  }
  list.push({ mac, name });
  saveSwitchMacs(list);
  res.json({ added: { mac, name } });
});

app.delete('/api/switch-macs/:index', (req, res) => {
  const i = Number(req.params.index);
  const list = loadSwitchMacs();
  if (!Number.isInteger(i) || i < 0 || i >= list.length) {
    return res.status(404).json({ error: 'Mapping not found' });
  }
  const [removed] = list.splice(i, 1);
  saveSwitchMacs(list);
  res.json({ removed: `${removed.mac} → ${removed.name}` });
});

// LLDP neighbor info for one iDRAC host, fetched lazily on hover and cached
// (60s TTL) in the Redfish client. The host must already be configured —
// this endpoint never contacts an arbitrary address.
app.get('/api/nodes/:host/lldp', async (req, res) => {
  if (!loadSettings().lldpEnabled) {
    return res.status(409).json({ error: 'LLDP collection is disabled (enable it in Settings)' });
  }
  const host = decodeURIComponent(req.params.host);
  if (!validHost(host) || !allHosts().some((h) => h.toLowerCase() === host.toLowerCase())) {
    return res.status(404).json({ error: 'Unknown host' });
  }
  const creds = { user: process.env.IDRAC_USER, pass: process.env.IDRAC_PASSWORD };
  try {
    const systemData = await fetchHostSystem(host, creds);
    const systemOdataId = systemData.system['@odata.id'] ?? `/redfish/v1/Systems/${systemData.serviceTag}`;
    const ports = await fetchHostLldp(host, creds, systemOdataId);
    const macNames = new Map(loadSwitchMacs().map((m) => [String(m.mac).toLowerCase(), m.name]));
    res.json({
      host,
      ports: ports.map((p) => ({
        ...p,
        lldp: p.lldp
          ? {
              chassisId: decodeLldpId(p.lldp.ChassisId),
              chassisIdSubtype: p.lldp.ChassisIdSubtype ?? null,
              chassisName: macNames.get(normalizeMac(p.lldp.ChassisId) ?? '') ?? null,
              portId: decodeLldpId(p.lldp.PortId),
              portIdSubtype: p.lldp.PortIdSubtype ?? null,
            }
          : null,
      })),
    });
  } catch (err) {
    res.status(502).json({ error: `Could not reach ${host}: ${err.message}` });
  }
});

const SWITCH_ROLES = ['Leaf A', 'Leaf B', 'Border Leaf A', 'Border Leaf B', 'Management', 'Management Agg A', 'Management Agg B', 'Spine A', 'Spine B', 'Spine C'];

app.get('/api/managed', (req, res) => {
  try {
    res.json({
      static: loadServers().map((s) => s.host),
      discovered: loadDiscovered(),
      switches: loadSwitches(),
      models: loadModels(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Central validation for switch input (used by both the form and CSV
// import): required fields capped at 100 chars, IP checked against the
// hostname allowlist, role checked against a fixed allowlist, height
// restricted to 1U or 2U, and location must parse to a rack + RU. Values
// that fail here are never persisted.
function validateSwitch(b) {
  const makeModel = String(b.makeModel ?? '').trim();
  const name = String(b.name ?? '').trim();
  const ip = String(b.ip ?? '').trim();
  const serial = String(b.serial ?? '').trim();
  const locationRaw = String(b.locationRaw ?? '').trim();
  const role = String(b.role ?? '').trim();
  const heightU = Number(String(b.heightU ?? '').trim().replace(/u$/i, ''));

  const problems = [];
  if (!makeModel || makeModel.length > 100) problems.push('Make/Model is required');
  if (!name || name.length > 100) problems.push('Switch name is required');
  if (!validHost(ip)) problems.push('IP address is invalid');
  if (!serial || serial.length > 100) problems.push('Serial number is required');
  if (!SWITCH_ROLES.includes(role)) problems.push(`Role must be one of: ${SWITCH_ROLES.join(', ')}`);
  if (heightU !== 1 && heightU !== 2) problems.push('Height must be 1U or 2U');
  const parsed = parseLocation(locationRaw);
  if (!parsed || parsed.rackNumber == null || parsed.ru == null) {
    problems.push('Location must include Rack<N> and RU<N>, e.g. "DC1 Prod_Rack1 RU18"');
  }
  return { problems, value: { name, makeModel, ip, serial, locationRaw, role, heightU } };
}

app.post('/api/switches', express.json({ limit: '16kb' }), (req, res) => {
  const { problems, value } = validateSwitch(req.body ?? {});
  if (problems.length > 0) return res.status(400).json({ error: problems.join('; ') });

  const switches = loadSwitches();
  switches.push(value);
  saveSwitches(switches);

  const models = loadModels();
  if (!models.some((m) => String(m).toLowerCase() === value.makeModel.toLowerCase())) {
    models.push(value.makeModel);
    models.sort((a, b) => a.localeCompare(b));
    saveModels(models);
  }
  res.json({ added: { name: value.name, makeModel: value.makeModel, role: value.role } });
});

// Bulk switch import. Upload size is capped (256kb); each row is normalized
// (case-insensitive role) and fully validated via validateSwitch() before
// being stored. Duplicate names are skipped rather than overwritten.
app.post(
  '/api/switches/import',
  express.text({ type: ['text/csv', 'text/plain'], limit: '256kb' }),
  (req, res) => {
    const { entries, error } = parseSwitchCsv(typeof req.body === 'string' ? req.body : '');
    if (error) return res.status(400).json({ error });
    if (entries.length === 0) return res.status(400).json({ error: 'No device rows found in CSV' });

    const switches = loadSwitches();
    const existingNames = new Set(switches.map((s) => String(s.name).toLowerCase()));
    const models = loadModels();
    const results = { added: [], skipped: [], errors: [] };
    for (const { line, entry } of entries) {
      const role = SWITCH_ROLES.find((r) => r.toLowerCase() === String(entry.role).trim().toLowerCase()) ?? entry.role;
      const { problems, value } = validateSwitch({ ...entry, role });
      if (problems.length > 0) {
        results.errors.push({ line, name: value.name || '(blank name)', reason: problems.join('; ') });
        continue;
      }
      const key = value.name.toLowerCase();
      if (existingNames.has(key)) {
        results.skipped.push(value.name);
        continue;
      }
      existingNames.add(key);
      switches.push(value);
      results.added.push({ name: value.name, makeModel: value.makeModel, role: value.role });
      if (!models.some((m) => String(m).toLowerCase() === value.makeModel.toLowerCase())) models.push(value.makeModel);
    }
    if (results.added.length > 0) {
      saveSwitches(switches);
      models.sort((a, b) => a.localeCompare(b));
      saveModels(models);
    }
    res.json(results);
  },
);

// Edit a switch in place by array index. Same validation as add; a renamed
// switch must not collide with another entry's name.
app.put('/api/switches/:index', express.json({ limit: '16kb' }), (req, res) => {
  const i = Number(req.params.index);
  const switches = loadSwitches();
  if (!Number.isInteger(i) || i < 0 || i >= switches.length) {
    return res.status(404).json({ error: 'Switch not found' });
  }
  const { problems, value } = validateSwitch(req.body ?? {});
  if (problems.length > 0) return res.status(400).json({ error: problems.join('; ') });
  if (switches.some((s, j) => j !== i && String(s.name).toLowerCase() === value.name.toLowerCase())) {
    return res.status(409).json({ error: `A switch named "${value.name}" already exists` });
  }
  switches[i] = value;
  saveSwitches(switches);

  const models = loadModels();
  if (!models.some((m) => String(m).toLowerCase() === value.makeModel.toLowerCase())) {
    models.push(value.makeModel);
    models.sort((a, b) => a.localeCompare(b));
    saveModels(models);
  }
  res.json({ updated: { name: value.name, makeModel: value.makeModel, role: value.role } });
});

// Remove a switch by array index; the index is bounds-checked so it can
// only address an existing entry.
app.delete('/api/switches/:index', (req, res) => {
  const i = Number(req.params.index);
  const switches = loadSwitches();
  if (!Number.isInteger(i) || i < 0 || i >= switches.length) {
    return res.status(404).json({ error: 'Switch not found' });
  }
  const [removed] = switches.splice(i, 1);
  saveSwitches(switches);
  res.json({ removed: removed.name });
});

// Remove a discovered host. servers.json entries are deliberately NOT
// removable through the API — the admin file is read-only by design.
app.delete('/api/nodes/:host', (req, res) => {
  const host = decodeURIComponent(req.params.host);
  const discovered = loadDiscovered();
  const idx = discovered.findIndex((d) => String(d.host).toLowerCase() === host.toLowerCase());
  if (idx === -1) {
    return res.status(404).json({ error: `${host} is not a discovered host; servers.json entries must be edited in the file` });
  }
  discovered.splice(idx, 1);
  saveDiscovered(discovered);
  res.json({ removed: host });
});

// Inbound TLS: cert/key are read from the read-only certs mount at startup.
// If absent the app falls back to plain HTTP (dev only) and the session
// cookie correspondingly drops its Secure flag.
if (TLS_ENABLED) {
  https.createServer({ key: fs.readFileSync(KEY_FILE), cert: fs.readFileSync(CRT_FILE) }, app)
    .listen(PORT, () => {
      console.log(`Rack visualizer listening on https://0.0.0.0:${PORT}`);
    });
} else {
  app.listen(PORT, () => {
    console.log(`Rack visualizer listening on http://0.0.0.0:${PORT} (no TLS cert found in ${CERT_DIR})`);
  });
}
