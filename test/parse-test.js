import { test } from 'node:test';
import assert from 'node:assert/strict';
import { macMatchKey } from '../lib/parse.js';

test('macMatchKey drops the port octet so base and interface MACs match', () => {
  assert.equal(macMatchKey('14:bc:68:58:9f:00'), '14:bc:68:58:9f');
  assert.equal(macMatchKey('14:bc:68:58:9f:b0'), '14:bc:68:58:9f');
  assert.equal(macMatchKey('14:bc:68:58:9f:00'), macMatchKey('14:bc:68:58:9f:b0'));
});

test('macMatchKey returns empty string for non-normalized input', () => {
  assert.equal(macMatchKey(''), '');
  assert.equal(macMatchKey('14:bc:68:58:9f'), '');
  assert.equal(macMatchKey(null), '');
  assert.equal(macMatchKey(undefined), '');
});
