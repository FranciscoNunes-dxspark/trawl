import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSql } from '../src/actions.js';

// Just enough ctx for runSql: a session whose count query answers `count`, and records of what
// was asked and run.
function fakeCtx({ count, answer = true }) {
  const asked = [];
  const ran = [];
  const ctx = {
    session: { conn: { name: 'club', commit: 'auto' }, run: async (sql) => ({ sets: [{ columns: [{ name: '' }], rows: [[count]] }], messages: [], sql }) },
    tranCount: 0,
    writesAllowed: false,
    note: () => {},
    task: async (title, start) => (await start(new AbortController().signal), { ok: true }),
    confirm: async (req) => (asked.push(req), answer),
    query: async (sql) => (ran.push(sql), { ok: true }),
  };
  return { ctx, asked, ran };
}

test('an UPDATE with a WHERE runs straight away when it changes few rows', async () => {
  const { ctx, asked, ran } = fakeCtx({ count: 3 });
  await runSql(ctx, 'UPDATE dbo.Players SET Goals = 0 WHERE ClubId = 1');
  assert.equal(asked.length, 0);
  assert.equal(ran.length, 1);
});

test('one that would change more than 1,000 rows asks first, saying how many', async () => {
  const { ctx, asked, ran } = fakeCtx({ count: 52310, answer: false });
  await runSql(ctx, 'DELETE FROM dbo.Players WHERE Goals = 0');
  assert.equal(asked[0].title, 'This changes 52,310 rows. Run it?');
  assert.equal(ran.length, 0);
});

test('a write the count can\'t be worked out for runs as before', async () => {
  const { ctx, asked, ran } = fakeCtx({ count: 99999 });
  await runSql(ctx, 'DELETE TOP (10) FROM dbo.Players WHERE Goals = 0');
  assert.equal(asked.length, 0);
  assert.equal(ran.length, 1);
});
