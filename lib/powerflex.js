// PowerFlex Manager (4.x / pfmp) client for iDRAC discovery.
//
// Security notes:
// - The appliance URL is validated in server.js before use (https: only, no
//   userinfo, hostname allowlist), so credentials only ever go to the
//   configured host.
// - TLS verification is disabled for the appliance (self-signed cert) — the
//   same trusted-LAN tradeoff as the Redfish client.
// - The password is sent only in the login body; subsequent calls use the
//   Bearer token. No token caching: 4.x access tokens expire in ~5 minutes
//   and refreshes are manual and infrequent.
//
// Dell gates the 4.x API docs behind OAuth, so exact paths and response
// shapes are not publicly verifiable. Both paths are per-instance Settings
// overrides, parsing accepts the common envelope shapes, and the management
// address is read from several candidate fields. probe-powerflex.sh helps
// discover the real values against a live appliance.

import https from 'node:https';

const tlsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

export const DEFAULT_LOGIN_PATH = '/rest/login';
export const DEFAULT_RESOURCES_PATH = '/rest/api/v1/resources';

function requestJson(method, urlStr, { headers = {}, body, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = https.request(urlStr, {
      method,
      agent: tlsAgent,
      headers: {
        Accept: 'application/json',
        ...headers,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode} from ${urlStr}`));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new Error(`Invalid JSON response from ${urlStr}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Request timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Preserve any base-path prefix the appliance lives under (e.g. /pfmp).
function joinUrl(baseUrl, apiPath) {
  const u = new URL(baseUrl);
  u.pathname = u.pathname.replace(/\/+$/, '') + apiPath;
  return u.toString();
}

// 4.x pfmp login: {username,password} → access token. Field name varies by
// version, so check the common variants.
async function login(cfg) {
  const json = await requestJson('POST', joinUrl(cfg.url, cfg.loginPath), {
    body: { username: cfg.user, password: cfg.password },
  });
  const token = json.access_token ?? json.accessToken ?? json.token;
  if (!token) throw new Error('PowerFlex login response contained no access token');
  return token;
}

// Accept a bare array or the common list envelopes.
function resourceEntries(json) {
  if (Array.isArray(json)) return json;
  for (const key of ['items', 'resources', 'value', 'data', 'entries']) {
    if (Array.isArray(json?.[key])) return json[key];
  }
  if (Array.isArray(json?._embedded?.resources)) return json._embedded.resources;
  throw new Error('PowerFlex resources response was not a recognizable list');
}

// Map one resource entry to an iDRAC host record. Field names vary across
// versions; management-address fields come first. Returns null when no
// usable (and validHost-approved) address is present.
export function mapResourceHost(entry, validHost) {
  if (!entry || typeof entry !== 'object') return null;
  const host = entry.managementIP ?? entry.ipAddress ?? entry.ip ?? entry.bmcIP ?? entry.idracIP;
  if (typeof host !== 'string' || !validHost(host)) return null;
  return {
    host: host.trim(),
    serviceTag: typeof entry.serviceTag === 'string' ? entry.serviceTag : null,
    name: typeof entry.hostname === 'string' ? entry.hostname : typeof entry.name === 'string' ? entry.name : null,
  };
}

export async function fetchIdracHosts({ url, user, password, loginPath, resourcesPath, validHost }) {
  const cfg = {
    url,
    user,
    password,
    loginPath: loginPath || DEFAULT_LOGIN_PATH,
    resourcesPath: resourcesPath || DEFAULT_RESOURCES_PATH,
  };
  const token = await login(cfg);
  const json = await requestJson('GET', joinUrl(cfg.url, cfg.resourcesPath), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const entries = resourceEntries(json);
  const hosts = [];
  const rejected = [];
  const seen = new Set();
  const discoveredAt = new Date().toISOString();
  for (const entry of entries) {
    const mapped = mapResourceHost(entry, validHost);
    if (!mapped) {
      rejected.push(String(entry?.serviceTag ?? entry?.managementIP ?? entry?.ipAddress ?? '(unmappable)'));
      continue;
    }
    const key = mapped.host.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    hosts.push({ ...mapped, discoveredAt });
  }
  return { hosts, rejected, total: entries.length };
}
