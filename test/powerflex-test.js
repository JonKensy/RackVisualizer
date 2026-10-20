// Unit + mock-server e2e tests for lib/powerflex.js. The mock serves the
// 4.x-style login and resources endpoints over self-signed TLS, mirroring
// the mock-idrac.js pattern.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchIdracHosts, mapResourceHost } from '../lib/powerflex.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
const validHost = (h) => typeof h === 'string' && HOST_RE.test(h.trim());

test('mapResourceHost prefers managementIP and validates the address', () => {
  assert.deepEqual(mapResourceHost({ managementIP: '10.0.0.5', serviceTag: 'ABC', hostname: 'fx-1' }, validHost), {
    host: '10.0.0.5', serviceTag: 'ABC', name: 'fx-1',
  });
  assert.equal(mapResourceHost({ ipAddress: '10.0.0.6' }, validHost).host, '10.0.0.6');
  assert.equal(mapResourceHost({ managementIP: 'evil.com/path' }, validHost), null);
  assert.equal(mapResourceHost({ managementIP: 'user@host' }, validHost), null);
  assert.equal(mapResourceHost({ serial: 'x' }, validHost), null);
});

function startMockPowerFlex() {
  const resources = {
    items: [
      { managementIP: '10.0.0.5', serviceTag: 'AAA111', hostname: 'fx-srv-01' },
      { ipAddress: '10.0.0.6', serviceTag: 'BBB222' },
      { managementIP: '10.0.0.5', serviceTag: 'AAA111-dup' }, // duplicate host
      { managementIP: 'bad host/name', serviceTag: 'CCC333' }, // fails validHost
      { serialNumber: 'no-address' }, // unmappable
    ],
  };
  const server = https.createServer(
    { key: fs.readFileSync(path.join(__dirname, 'certs/key.pem')), cert: fs.readFileSync(path.join(__dirname, 'certs/cert.pem')) },
    (req, res) => {
      if (req.method === 'POST' && req.url === '/rest/login') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const { username, password } = JSON.parse(body);
          if (username === 'pfxuser' && password === 'pfxpass') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ access_token: 'mock-token' }));
          } else {
            res.writeHead(401).end('{}');
          }
        });
        return;
      }
      if (req.method === 'GET' && req.url === '/rest/api/v1/resources') {
        if (req.headers.authorization !== 'Bearer mock-token') {
          res.writeHead(401).end('{}');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resources));
        return;
      }
      res.writeHead(404).end('{}');
    },
  );
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `https://127.0.0.1:${server.address().port}` }));
  });
}

test('fetchIdracHosts logs in, maps, dedupes, and rejects invalid hosts', async () => {
  const { server, url } = await startMockPowerFlex();
  try {
    const { hosts, rejected, total } = await fetchIdracHosts({
      url, user: 'pfxuser', password: 'pfxpass', validHost,
    });
    assert.equal(total, 5);
    assert.deepEqual(hosts.map((h) => h.host), ['10.0.0.5', '10.0.0.6']);
    assert.equal(hosts[0].serviceTag, 'AAA111');
    assert.equal(rejected.length, 2);
    assert.ok(hosts.every((h) => h.discoveredAt));
  } finally {
    server.close();
  }
});

test('bad credentials surface a login error', async () => {
  const { server, url } = await startMockPowerFlex();
  try {
    await assert.rejects(
      fetchIdracHosts({ url, user: 'pfxuser', password: 'wrong', validHost }),
      /HTTP 401/,
    );
  } finally {
    server.close();
  }
});
