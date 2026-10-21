import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoSession } from '../src/demo.js';
import { dialectOf } from '../src/dialects.js';
import { readTarget } from '../src/edit.js';
import { followTargets } from '../src/follow.js';
import { SCHEMA_SQL, buildSchema } from '../src/schema.js';

const schema = buildSchema((await demoSession({ name: 'demo', demo: true }).run(SCHEMA_SQL)).sets);
const set = (names, rows) => ({ columns: names.map((name) => ({ name, type: 'IntN' })), rows });

test('a foreign key column leads to the row it refers to', () => {
  const players = set(['Id', 'ClubId', 'Name'], [[1, 2, 'Rui'], [2, null, 'Ana']]);
  const source = readTarget('SELECT Id, ClubId, Name FROM dbo.Players', [players], schema);
  const r = followTargets(source, players, 0, 1, schema, { limit: 50 });
  assert.deepEqual(r.targets.map((t) => [t.label, t.sql]), [['dbo.Clubs where Id = 2', 'SELECT TOP (50) * FROM [dbo].[Clubs] WHERE [Id] = 2;']]);
  assert.match(followTargets(source, players, 1, 1, schema).reason, /NULL here/);
  assert.match(followTargets(source, players, 0, 2, schema).reason, /Name isn't part of a foreign key/);
});

test('on Postgres and MySQL the WHERE comes before the LIMIT', () => {
  const players = set(['Id', 'ClubId', 'Name'], [[1, 2, 'Rui']]);
  const source = readTarget('SELECT Id, ClubId, Name FROM dbo.Players', [players], schema);
  const pg = dialectOf({ kind: 'postgres' });
  const r = followTargets(source, players, 0, 1, schema, { limit: 50, quote: pg.quote, selectTop: pg.selectTop });
  assert.deepEqual(r.targets.map((t) => t.sql), ['SELECT * FROM "dbo"."Clubs" WHERE "Id" = 2 LIMIT 50;']);
});

test('a key other tables refer to leads to their rows, one way each', () => {
  const clubs = set(['Id', 'Name'], [[3, 'Union Sud']]);
  const source = readTarget('SELECT * FROM dbo.Clubs', [clubs], schema);
  const r = followTargets(source, clubs, 0, 0, schema);
  assert.deepEqual(r.targets.map((t) => t.sql), [
    'SELECT TOP (500) * FROM [dbo].[Players] WHERE [ClubId] = 3;',
    'SELECT TOP (500) * FROM [dbo].[Matches] WHERE [HomeId] = 3;',
    'SELECT TOP (500) * FROM [dbo].[Matches] WHERE [AwayId] = 3;',
  ]);
});

test('without a table to go by, it says why', () => {
  const rows = set(['n'], [[1]]);
  assert.match(followTargets(readTarget('SELECT 1 AS n', [rows], schema), rows, 0, 0, schema).reason, /can't tell which table/);
  const renamed = set(['Club'], [[1]]);
  assert.match(followTargets(readTarget('SELECT ClubId AS Club FROM dbo.Players', [renamed], schema), renamed, 0, 0, schema).reason, /isn't a column of dbo\.Players as it is/);
});
