import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchMacName } from '../lib/parse.js';

test('exact entries match only the exact MAC', () => {
  const entries = [{ mac: '14:bc:68:4a:dc:37', name: 'leaf-a' }];
  assert.equal(matchMacName('14:bc:68:4a:dc:37', entries), 'leaf-a');
  assert.equal(matchMacName('14:bc:68:4a:dc:38', entries), null);
});

test('trailing wildcard covers the switch port range', () => {
  const entries = [{ mac: '14:bc:68:4a:dc:*', name: 'leaf-a' }];
  assert.equal(matchMacName('14:bc:68:4a:dc:37', entries), 'leaf-a');
  assert.equal(matchMacName('14:bc:68:4a:dd:37', entries), null);
});

test('adjacent switches with per-port wildcards stay distinct', () => {
  const entries = [
    { mac: '4c:25:51:5c:04:*', name: 'leaf-a' },
    { mac: '4c:25:51:5c:05:*', name: 'leaf-b' },
  ];
  assert.equal(matchMacName('4c:25:51:5c:04:84', entries), 'leaf-a');
  assert.equal(matchMacName('4c:25:51:5c:05:12', entries), 'leaf-b');
});

test('longest prefix wins', () => {
  const entries = [
    { mac: '4c:25:51:*', name: 'pair' },
    { mac: '4c:25:51:5c:04:*', name: 'leaf-a' },
  ];
  assert.equal(matchMacName('4c:25:51:5c:04:84', entries), 'leaf-a');
});

test('empty or malformed inputs never match', () => {
  assert.equal(matchMacName('', [{ mac: '4c:25:51:5c:04:*', name: 'leaf-a' }]), null);
  assert.equal(matchMacName('4c:25:51:5c:04:84', [{ mac: '', name: 'bad' }]), null);
});
