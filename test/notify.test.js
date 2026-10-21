import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notification, worthNotifying } from '../src/notify.js';

test('a bell, then OSC 9, or OSC 777 in VTE terminals, with nothing that could end it early', () => {
  assert.equal(notification('Trawl: SELECT 1', '1 row · 12 s', {}), '\x07\x1b]9;Trawl: SELECT 1: 1 row · 12 s\x07');
  assert.equal(notification('a;b', 'c\x07d', { VTE_VERSION: '7600' }), '\x07\x1b]777;notify;a,b;c d\x1b\\');
});

test('only runs past the threshold, and not when turned off', () => {
  assert.equal(worthNotifying(9_000, {}), false);
  assert.equal(worthNotifying(10_000, {}), true);
  assert.equal(worthNotifying(600, { notifyAfter: 0.5 }), true);
  assert.equal(worthNotifying(60_000, { notify: false }), false);
});
