// Regression tests for the Redfish client's stale-keep-alive retry: iDRACs
// close idle pooled connections, which surfaces as "socket hang up" when the
// socket dies between checkout and response.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyHost } from '../lib/redfish.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TLS = {
  key: fs.readFileSync(path.join(__dirname, 'certs/key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'certs/cert.pem')),
};

function startServer(handler) {
  return new Promise((resolve) => {
    const server = https.createServer(TLS, handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('verifyHost retries once when the iDRAC drops the connection', async () => {
  let hits = 0;
  const server = await startServer((req, res) => {
    hits++;
    if (hits === 1) {
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ Oem: { Dell: { ServiceTag: 'RETRYTAG' } } }));
  });
  try {
    assert.equal(await verifyHost(`127.0.0.1:${server.address().port}`), 'RETRYTAG');
    assert.equal(hits, 2);
  } finally {
    server.close();
  }
});

test('HTTP errors are not retried', async () => {
  let hits = 0;
  const server = await startServer((req, res) => {
    hits++;
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  try {
    await assert.rejects(() => verifyHost(`127.0.0.1:${server.address().port}`), /HTTP 500/);
    assert.equal(hits, 1);
  } finally {
    server.close();
  }
});
