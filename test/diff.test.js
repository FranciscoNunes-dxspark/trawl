import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIFF_SQL, buildExtras, diffText, lineDiff, schemaDiff, syncScript } from '../src/diff.js';
import { demoSession } from '../src/demo.js';
import { SCHEMA_SQL, buildSchema } from '../src/schema.js';

async function read(database) {
  const s = demoSession({ name: 'demo', demo: true }, { database });
  return { schema: buildSchema((await s.run(SCHEMA_SQL)).sets), ...buildExtras((await s.run(DIFF_SQL)).sets) };
}

test('the demo databases differ by a table (with its foreign key), a column type, an index and a view', async () => {
  const [a, b] = [await read('ClubA'), await read('ClubB')];
  const changes = schemaDiff(a, b);
  const brief = changes.map((c) => `${c.change} ${c.kind} ${c.table ? `${c.table}.` : ''}${c.name}`);
  assert.deepEqual(brief, ['changed column dbo.Players.Shirt', 'right table dbo.Stadiums', 'changed view dbo.vTopScorers', 'right index dbo.Matches.IX_Matches_PlayedOn']);
  assert.deepEqual(schemaDiff(a, await read('ClubA')), []);
  const text = diffText(changes, { left: 'demo/ClubA', right: 'demo/ClubB' });
  assert.match(text, /Tables\n  ~ dbo\.Matches\n      > index IX_Matches_PlayedOn nonclustered \(\[PlayedOn\] DESC\)\n  ~ dbo\.Players\n      ~ Shirt: tinyint null → smallint null\n  > dbo\.Stadiums/);
  assert.match(text, /Views\n  ~ dbo\.vTopScorers: the definitions differ\n[\s\S]*- WHERE Goals > 0;\n\s*\+ WHERE Goals > 1;/);
  assert.match(text, /0 only in demo\/ClubA · 2 only in demo\/ClubB · 2 different/);
});

test('the sync script makes the left match the right, leaving what loses data commented out', async () => {
  const [a, b] = [await read('ClubA'), await read('ClubB')];
  const script = syncScript(schemaDiff(a, b), { left: 'A', right: 'B', rightSchema: b.schema, rightDefinitions: b.definitions });
  assert.match(script, /CREATE TABLE \[dbo\]\.\[Stadiums\][\s\S]*FOREIGN KEY \(\[ClubId\]\) REFERENCES \[dbo\]\.\[Clubs\] \(\[Id\]\);/);
  assert.match(script, /ALTER TABLE \[dbo\]\.\[Players\] ALTER COLUMN \[Shirt\] smallint NULL;/);
  assert.match(script, /CREATE NONCLUSTERED INDEX \[IX_Matches_PlayedOn\] ON \[dbo\]\.\[Matches\] \(\[PlayedOn\] DESC\);/);
  assert.match(script, /GO\n\n-- Views, procedures and functions\nCREATE OR ALTER VIEW dbo\.vTopScorers AS[\s\S]*WHERE Goals > 1;\nGO/);
  // The other way round, the table and the index go: the table only as a comment.
  const back = syncScript(schemaDiff(b, a), { left: 'B', right: 'A', rightSchema: a.schema, rightDefinitions: a.definitions });
  assert.match(back, /^-- DROP TABLE \[dbo\]\.\[Stadiums\];$/m);
  assert.match(back, /^DROP INDEX \[IX_Matches_PlayedOn\] ON \[dbo\]\.\[Matches\];$/m);
});

test('columns only one side has, and a changed foreign key, become ALTER statements', () => {
  const t = (cols) => ({ schema: 'dbo', name: 'T', kind: 'table', rows: 0, columns: cols });
  const c = (name, type, extra = {}) => ({ name, type, nullable: false, identity: false, pk: false, ...extra });
  const fk = (to) => ({ name: 'FK_T_U', from: 'dbo.T', to, columns: [['UId', 'Id']] });
  const left = { schema: { objects: [t([c('Id', 'int', { pk: true }), c('Old', 'int'), c('UId', 'int')])], foreignKeys: [fk('dbo.U')] }, definitions: new Map(), indexes: [] };
  const right = { schema: { objects: [t([c('Id', 'int', { pk: true }), c('New', 'nvarchar(10)'), c('UId', 'int')])], foreignKeys: [fk('dbo.V')] }, definitions: new Map(), indexes: [] };
  const changes = schemaDiff(left, right);
  const script = syncScript(changes, { left: 'L', right: 'R', rightSchema: right.schema });
  assert.match(script, /^-- ALTER TABLE \[dbo\]\.\[T\] DROP COLUMN \[Old\];$/m);
  assert.match(script, /^ALTER TABLE \[dbo\]\.\[T\] ADD \[New\] nvarchar\(10\) NOT NULL; -- NOT NULL: a table with rows needs a DEFAULT too$/m);
  assert.match(script, /^ALTER TABLE \[dbo\]\.\[T\] DROP CONSTRAINT \[FK_T_U\];[\s\S]*REFERENCES \[dbo\]\.\[V\]/m);
});

test('lineDiff keeps the common lines and marks the rest', () => {
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nx\nc'), [[' ', 'a'], ['-', 'b'], ['+', 'x'], [' ', 'c']]);
});
