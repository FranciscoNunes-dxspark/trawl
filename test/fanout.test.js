import { test } from 'node:test';
import assert from 'node:assert/strict';
import { folderNames, inFolder, inParallel, mergeResults } from '../src/fanout.js';

const conns = [
  { name: 'a', folder: 'Clubs' },
  { name: 'b', folder: 'Clubs/PROD' },
  { name: 'c', folder: 'Clubsville' },
  { name: 'd' },
];

test('a folder takes in the folders under it, ignoring case, and lists its parents', () => {
  assert.deepEqual(inFolder(conns, 'clubs').map((c) => c.name), ['a', 'b']);
  assert.deepEqual(inFolder(conns, 'Clubs/PROD/').map((c) => c.name), ['b']);
  assert.deepEqual(inFolder(conns, ''), []);
  assert.deepEqual(folderNames(conns), ['Clubs', 'Clubs/PROD', 'Clubsville']);
});

test('result sets merge by column name, led by the connection and database, with failures said', () => {
  const set = (names, rows, truncated = false) => ({ columns: names.map((name) => ({ name, type: 'Int' })), rows, truncated });
  const { sets, messages } = mergeResults([
    { conn: 'a', database: 'A', sets: [set(['Id', 'Name'], [[1, 'x']])] },
    { conn: 'b', database: 'B', error: "Invalid object name 'dbo.T'.\nmore" },
    { conn: 'c', database: 'C', sets: [set(['name', 'Extra', 'id'], [['y', 9, 2]], true)] },
  ]);
  assert.deepEqual(sets[0].columns.map((c) => c.name), ['connection', 'database', 'Id', 'Name', 'Extra']);
  assert.deepEqual(sets[0].rows, [['a', 'A', 1, 'x', null], ['c', 'C', 2, 'y', 9]]);
  assert.equal(sets[0].truncated, true);
  assert.deepEqual(messages, ['2 of 3 connections answered', "b (B): Invalid object name 'dbo.T'."]);
  // A query with a "database" column of its own keeps it; Trawl's is bracketed.
  const own = mergeResults([{ conn: 'a', database: 'A', sets: [set(['database'], [['x']])] }]);
  assert.deepEqual(own.sets[0].columns.map((c) => c.name), ['connection', '[database]', 'database']);
});

test('inParallel keeps the order and never runs more than n at once', async () => {
  let running = 0;
  let most = 0;
  const out = await inParallel([5, 1, 4, 2, 3], 2, async (x) => {
    most = Math.max(most, ++running);
    await new Promise((r) => setTimeout(r, x * 3));
    running--;
    return x * 10;
  });
  assert.deepEqual(out, [50, 10, 40, 20, 30]);
  assert.equal(most, 2);
});
