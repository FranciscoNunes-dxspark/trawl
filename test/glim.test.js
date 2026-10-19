import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FACES, PALETTE, glimPixels, glimRows, moodFor, moodLine } from '../src/glim.js';

test('every mood is a full 16 × 10 drawing in palette colours', () => {
  for (const mood of Object.keys(FACES)) {
    const px = glimPixels(mood);
    assert.equal(px.length, 10, mood);
    for (const row of px) {
      assert.equal(row.length, 16, `${mood}: ${row}`);
      assert.match(row, new RegExp(`^[.${Object.keys(PALETTE).join('')}]+$`));
    }
  }
});

test('the lure dims asleep and turns red while a transaction is open', () => {
  assert.ok(glimPixels('idle').join('').includes('L'));
  assert.ok(!glimPixels('sleep').join('').match(/[YL]/));
  assert.ok(glimPixels('alert').join('').includes('R'));
});

test('the terminal version is 5 rows of 16 half-block cells', () => {
  const rows = glimRows('idle');
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => r.length === 16 && r.every((s) => [' ', '▀', '▄'].includes(s.text))));
  assert.ok(rows.flat().some((s) => s.text === '▀' && s.bg));
});

test('moods follow the session', () => {
  const session = { conn: { name: 'demo' }, database: 'ClubA' };
  const now = 1_000_000;
  assert.equal(moodFor({ now }), 'sleep');
  assert.equal(moodFor({ session, now }), 'idle');
  assert.equal(moodFor({ session, busy: {}, now }), 'look');
  assert.equal(moodFor({ session, tranCount: 1, now }), 'alert');
  assert.equal(moodFor({ session, lastEntry: { status: 'ok', at: now - 1000 }, now }), 'happy');
  assert.equal(moodFor({ session, lastEntry: { status: 'ok', at: now - 9000 }, now }), 'idle');
  assert.equal(moodFor({ session, tranCount: 1, lastEntry: { status: 'error', at: now - 1000 }, now }), 'worried');
  assert.match(moodLine('idle', session), /ClubA on demo/);
});
