import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutOff, moreQuery, raiseTop } from '../src/more.js';

const set = (n, truncated = false) => ({ columns: [{ name: 'Id', type: 'Int' }], rows: Array.from({ length: n }, (_, i) => [i]), truncated });

test('a set is cut off when the limit stopped it, or when Trawl’s own TOP at the limit came back full', () => {
  assert.equal(cutOff({ sets: [set(500, true)] }), true);
  assert.equal(cutOff({ sets: [set(12)] }), false);
  assert.equal(cutOff({ sets: [set(500)], top: 500 }), true);
  assert.equal(cutOff({ sets: [set(499)], top: 500 }), false);
  assert.equal(cutOff({ sets: [set(3), set(5, true)] }, 1), true);
  assert.equal(cutOff({ sets: [set(3), set(5, true)] }, 0), false);
  assert.equal(cutOff(null), false);
});

test('raiseTop raises the TOP or LIMIT Trawl wrote, and nothing else', () => {
  assert.equal(raiseTop('SELECT TOP (500) * FROM [dbo].[Players];', 500, 1000), 'SELECT TOP (1000) * FROM [dbo].[Players];');
  assert.equal(raiseTop('SELECT TOP (500) * FROM [dbo].[Clubs] WHERE [Id] = 2;', 500, 1000), 'SELECT TOP (1000) * FROM [dbo].[Clubs] WHERE [Id] = 2;');
  assert.equal(raiseTop('SELECT * FROM "public"."t" LIMIT 500;', 500, 1500), 'SELECT * FROM "public"."t" LIMIT 1500;');
  assert.equal(raiseTop('SELECT * FROM t LIMIT 5000;', 500, 1000), null);
  assert.equal(raiseTop('SELECT * FROM t', 500, 1000), null);
});

test('moreQuery raises the limit by a limit’s worth each time, and runs only reads again', () => {
  const read = { sql: 'SELECT * FROM dbo.Players', sets: [set(500, true)], limit: 500 };
  assert.deepEqual(moreQuery(read, 0, { step: 500 }), { sql: 'SELECT * FROM dbo.Players', limit: 1000 });
  assert.deepEqual(moreQuery({ ...read, limit: 1000 }, 0, { step: 500 }), { sql: 'SELECT * FROM dbo.Players', limit: 1500 });
  // Trawl's own TOP goes up with it.
  const browse = { sql: 'SELECT TOP (500) * FROM [dbo].[Players];', sets: [set(500)], limit: 500, top: 500 };
  assert.deepEqual(moreQuery(browse, 0, { step: 500 }), { sql: 'SELECT TOP (1000) * FROM [dbo].[Players];', limit: 1000, top: 1000 });
  // A script of reads runs again whole; one that writes doesn't.
  const script = { sql: 'SELECT 1 AS one;\nSELECT * FROM dbo.Players;', sets: [set(1), set(500, true)], limit: 500 };
  assert.equal(moreQuery(script, 1, { step: 500 }).sql, script.sql);
  assert.match(moreQuery({ ...script, sql: 'UPDATE dbo.Players SET Goals = 0 WHERE Id = 1;\nSELECT * FROM dbo.Players;' }, 1, { step: 500 }).reason, /changes data/);
  assert.match(moreQuery({ ...read, sets: [set(12)] }, 0, { step: 500 }).reason, /All the rows are here/);
  assert.match(moreQuery({ sets: [set(500, true)] }, 0, { step: 500 }).reason, /nothing to run again/);
  assert.match(moreQuery(null, 0, { step: 500 }).reason, /Run a query first/);
  assert.match(moreQuery({ ...browse, sql: 'SELECT * FROM t' }, 0, { step: 500 }).reason, /can't be raised/);
});
