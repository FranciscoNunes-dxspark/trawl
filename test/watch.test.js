import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedCells, parseUntil, parseWatch, untilMatch, untilText } from '../src/watch.js';

const set = (names, rows) => ({ columns: names.map((name) => ({ name, type: '' })), rows });

test('/watch takes the seconds, the SQL and --until', () => {
  assert.deepEqual(parseWatch('5 SELECT * FROM dbo.Jobs'), { seconds: 5, sql: 'SELECT * FROM dbo.Jobs', until: null });
  assert.deepEqual(parseWatch('10s'), { seconds: 10, sql: '', until: null });
  const w = parseWatch(`3 SELECT Id, Status FROM dbo.Jobs WHERE Id = 4 --until "Status = 'Done'"`);
  assert.equal(w.sql, 'SELECT Id, Status FROM dbo.Jobs WHERE Id = 4');
  assert.deepEqual(w.until, { column: 'Status', op: '=', value: 'Done' });
  assert.deepEqual(parseWatch('2 --until rows > 0').until, { rows: true, op: '>', value: 0 });
  assert.equal(parseWatch('2 --until rows > 0').sql, '');
  assert.equal(parseWatch('stop').stop, true);
  assert.ok(parseWatch('').empty);
  assert.match(parseWatch('1 SELECT 1').error, /every 2 seconds/);
  assert.match(parseWatch('SELECT 1').error, /starts with the seconds/);
  assert.match(parseWatch('5 SELECT 1 --until whatever it is').error, /--until takes/);
});

test('the condition language is tiny', () => {
  assert.deepEqual(parseUntil('rows = 0'), { rows: true, op: '=', value: 0 });
  assert.deepEqual(parseUntil('[Goals] >= 10'), { column: 'Goals', op: '>=', value: 10 });
  assert.deepEqual(parseUntil("Name != N'it''s'"), { column: 'Name', op: '<>', value: "it's" });
  assert.deepEqual(parseUntil('Status = Done'), { column: 'Status', op: '=', value: 'Done' });
  assert.deepEqual(parseUntil('FinishedAt IS NOT NULL'), { column: 'FinishedAt', op: '<>', value: null });
  assert.deepEqual(parseUntil('Shirt = NULL'), { column: 'Shirt', op: '=', value: null });
  assert.match(parseUntil('Shirt > NULL').error, /NULL only/);
  assert.match(parseUntil('').error, /--until takes/);
  assert.equal(untilText(parseUntil("Status = 'Done'")), "Status = 'Done'");
  assert.equal(untilText(parseUntil('rows > 0')), 'rows > 0');
  assert.equal(untilText(parseUntil('Shirt is null')), 'Shirt IS NULL');
});

test('a row matching the condition stops the watch', () => {
  const s = set(['Id', 'Status', 'Done'], [[1, 'Running', null], [2, 'done', new Date('2026-10-21T10:00:00Z')]]);
  assert.deepEqual(untilMatch(parseUntil("Status = 'Done'"), s), { matched: true, row: 1 });
  assert.deepEqual(untilMatch(parseUntil('Id > 5'), s), { matched: false, row: null });
  assert.deepEqual(untilMatch(parseUntil('Done IS NULL'), s), { matched: true, row: 0 });
  assert.deepEqual(untilMatch(parseUntil('Id >= 2'), s), { matched: true, row: 1 });
  assert.deepEqual(untilMatch(parseUntil('rows = 2'), s), { matched: true, row: null });
  assert.deepEqual(untilMatch(parseUntil('rows > 0'), set(['x'], [])), { matched: false, row: null });
  assert.match(untilMatch(parseUntil('Nope = 1'), s).error, /no column Nope \(it has Id, Status, Done\)/);
});

test('the cells that changed since the run before, by key or as new rows', () => {
  const before = set(['Id', 'Status', 'Goals'], [[1, 'a', 1], [2, 'b', 2]]);
  const after = set(['Id', 'Status', 'Goals'], [[2, 'b', 3], [1, 'a', 1], [3, 'c', 0]]);
  assert.deepEqual([...changedCells(before, after, ['Id'])].sort(), ['0:2', '2:0', '2:1', '2:2']);
  // Without a key, a changed row is a new one.
  assert.deepEqual([...changedCells(before, after)].sort(), ['0:0', '0:1', '0:2', '2:0', '2:1', '2:2']);
  // Columns in another order still match by name.
  const moved = set(['Goals', 'Id', 'Status'], [[5, 1, 'a'], [2, 2, 'b']]);
  assert.deepEqual([...changedCells(before, moved, ['Id'])], ['0:0']);
  assert.equal(changedCells(before, set(['Other'], [[1]])).size, 0);
  assert.equal(changedCells(null, after).size, 0);
});
