// Outbound Redfish client for iDRAC hosts.
//
// Security notes:
// - TLS certificate verification is disabled ONLY for this agent, and the
//   agent is used only for https://<host>/redfish/... URLs where <host> has
//   already passed the server.js hostname allowlist (no scheme/port/path
//   characters). iDRACs ship self-signed certs, so this is a deliberate
//   trusted-LAN tradeoff; it does not affect inbound traffic to the web app.
// - verifyHost() is credential-free: adding a host only proves it is
//   reachable and speaks Redfish, so iDRAC credentials are never sent to an
//   address that has not already been vetted.
// - Credentials come from env and are attached as a Basic auth header per
//   request; they are never logged or persisted.
// - Every request has a hard timeout so a hung iDRAC cannot pin a socket.

import https from 'node:https';

const tlsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

// GET a Redfish resource, optionally with Basic auth. Non-2xx and non-JSON
// responses are rejected as errors.
function httpsGetJson(url, auth, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const headers = { Accept: 'application/json' };
    if (auth?.user) {
      headers.Authorization = 'Basic ' + Buffer.from(`${auth.user}:${auth.pass ?? ''}`).toString('base64');
    }
    const req = https.get(url, { agent: tlsAgent, headers, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(`Invalid JSON response from ${url}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Request timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
  });
}

// Anonymous service-root check used before adding a discovered host: confirms
// the address is reachable and speaks Redfish without sending credentials.
export async function verifyHost(host) {
  const root = await httpsGetJson(`https://${host}/redfish/v1`, null, 8000);
  return root.Oem?.Dell?.ServiceTag ?? null;
}

// 60-second in-memory cache limits how often credentialed requests hit each
// iDRAC (reduces exposure of the Basic auth header and load on the hosts).
const cache = new Map();
const CACHE_TTL_MS = 60_000;

export async function fetchHostSystem(host, auth) {
  const cached = cache.get(host);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

  const root = await httpsGetJson(`https://${host}/redfish/v1`);
  const serviceTag = root.Oem?.Dell?.ServiceTag ?? null;

  let page = await httpsGetJson(`https://${host}/redfish/v1/Systems`, auth);
  const members = [...(page.Members ?? [])];
  while (page['@odata.nextLink']) {
    page = await httpsGetJson(`https://${host}${page['@odata.nextLink']}`, auth);
    members.push(...(page.Members ?? []));
  }
  if (members.length === 0) throw new Error('No Systems members found');

  // Collection members may expose only @odata.id, so derive the id from the URI.
  const idOf = (m) => m.Id ?? m['@odata.id'].split('/').pop();
  const member =
    members.find((m) => idOf(m) === serviceTag) ??
    members.find((m) => idOf(m) !== 'System.Embedded.1') ??
    members[0];
  const systemId = idOf(member);

  const system = await httpsGetJson(`https://${host}${member['@odata.id']}`, auth);

  let chassis = null;
  const chassisLink = system.Links?.Chassis?.[0];
  if (chassisLink) {
    try {
      chassis = await httpsGetJson(`https://${host}${chassisLink['@odata.id']}`, auth);
    } catch {
      // Chassis is optional; location may still come from the System resource.
    }
  }

  // The iDRAC GUI "System Location" field is stored in the Dell OEM attributes
  // as SystemInfo.1.SysLocation; the manager resource does not link to it, so
  // the path is constructed from the System member Id.
  let dellAttributes = null;
  try {
    const res = await httpsGetJson(
      `https://${host}/redfish/v1/Managers/iDRAC.Embedded.1/Oem/Dell/DellAttributes/${systemId}`,
      auth,
    );
    dellAttributes = res.Attributes ?? null;
  } catch {
    // Not available on all firmware; location may still come from Chassis or System.
  }

  const data = { serviceTag: serviceTag ?? systemId, system, chassis, dellAttributes };
  cache.set(host, { data, ts: Date.now() });
  return data;
}
