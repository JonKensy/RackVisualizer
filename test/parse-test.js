import { test } from 'node:test';
import assert from 'node:assert/strict';
import { macMatchKey } from '../lib/parse.js';

test('macMatchKey drops the last two octets so base and interface MACs match', () => {
  assert.equal(macMatchKey('e4:89:ca:49:2e:27'), 'e4:89:ca:49');
  assert.equal(macMatchKey('e4:89:ca:49:00:00'), 'e4:89:ca:49');
  assert.equal(macMatchKey('e4:89:ca:49:2e:27'), macMatchKey('e4:89:ca:49:00:00'));
  assert.equal(macMatchKey('14:bc:68:58:9f:00'), macMatchKey('14:bc:68:58:9f:b0'));
});

test('macMatchKey returns empty string for non-normalized input', () => {
  assert.equal(macMatchKey(''), '');
  assert.equal(macMatchKey('e4:89:ca:49'), '');
  assert.equal(macMatchKey(null), '');
  assert.equal(macMatchKey(undefined), '');
});
