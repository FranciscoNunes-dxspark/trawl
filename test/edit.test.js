import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { canEdit, editTarget, editText, insertScript, saveScript, savedValue, toLiteral, tsvText } from '../src/edit.js';
import { demoSession } from '../src/demo.js';
import { SCHEMA_SQL, buildSchema } from '../src/schema.js';
import { classifyScript } from '../src/sql.js';

let schema;
before(async () => {
  schema = buildSchema((await demoSession({ demo: true, name: 'demo' }).run(SCHEMA_SQL)).sets);
});

const cols = (...names) => [{ columns: names.map((name) => ({ name, type: '' })), rows: [] }];
const PLAYERS = cols('Id', 'ClubId', 'Name', 'Position', 'Shirt', 'Goals');
const target = (sql, sets = PLAYERS) => editTarget(sql, sets, schema);

test('rows of one table with its key can be edited, column by column', () => {
  const t = target('SELECT TOP (500) * FROM [dbo].[Players];');
  assert.equal(t.table.name, 'Players');
  assert.deepEqual(t.keys, [0]);
  assert.deepEqual([...t.columns.keys()], [0, 1, 2, 3, 4, 5]);
  assert.ok(target('select p.* from dbo.Players p with (nolock) where p.Goals > 2 order by Name').table);
  assert.ok(target('SELECT * FROM Players AS p WHERE Name = N\'a, b FROM c\'').table, 'commas and FROM inside strings don’t count');
  // An expression, or a column under another name, is shown but not editable.
  const some = target('SELECT Id, Name, Goals + 1 AS Goals, Shirt AS Number, (SELECT COUNT(*) FROM dbo.Clubs) AS Clubs FROM dbo.Players', cols('Id', 'Name', 'Goals', 'Number', 'Clubs'));
  assert.deepEqual([...some.columns.keys()], [0, 1]);
  // Two keys, both needed.
  assert.deepEqual(target('SELECT * FROM i18n.Translations', cols('ResourceKey', 'Value', 'Culture', 'ResourceSet')).keys, [0, 2]);
});

test('and anything else says why not', () => {
  const why = (sql, sets) => target(sql, sets).reason;
  assert.match(why('SELECT * FROM dbo.Players p JOIN dbo.Clubs c ON c.Id = p.ClubId'), /one table/);
  assert.match(why('SELECT ClubId, COUNT(*) AS n FROM dbo.Players GROUP BY ClubId', cols('ClubId', 'n')), /one table/);
  assert.match(why('SELECT * FROM dbo.vTopScorers', cols('Name', 'Goals')), /isn’t a table/);
  assert.match(why('SELECT Name, Goals FROM dbo.Players', cols('Name', 'Goals')), /primary key \(Id\)/);
  assert.match(why('SELECT 1; SELECT * FROM dbo.Players'), /single SELECT/);
  assert.match(why('SELECT * FROM ClubB.dbo.Players'), /database/);
  assert.match(why('UPDATE dbo.Players SET Goals = 1 WHERE Id = 1'), /only a SELECT/);
  assert.match(editTarget('SELECT * FROM dbo.Players', PLAYERS, null).reason, /schema/);
});

test('typed text becomes a literal of the column’s type, or says what it takes', () => {
  assert.equal(toLiteral('42', 'int'), '42');
  assert.equal(toLiteral("O'Neil", 'nvarchar(100)'), "N'O''Neil'");
  assert.equal(toLiteral('PT', 'char(2)'), "'PT'");
  assert.equal(toLiteral('12.50', 'decimal(10,2)'), '12.50');
  assert.equal(toLiteral('true', 'bit'), '1');
  assert.equal(toLiteral('0x0a1B', 'varbinary(max)'), '0x0a1B');
  assert.equal(toLiteral('2026-10-20', 'date'), "'2026-10-20'");
  assert.equal(toLiteral(null, 'int'), 'NULL');
  assert.throws(() => toLiteral('4.5', 'int'), /whole number/);
  assert.throws(() => toLiteral('yes', 'bit'), /1 or 0/);
  assert.throws(() => toLiteral('', 'date'), /date or time/);
  assert.equal(canEdit({ type: 'int', identity: true }), false);
  assert.equal(canEdit({ type: 'rowversion' }), false);
  assert.equal(editText(null), '');
  assert.equal(editText(Buffer.from([1, 255])), '0x01FF');
  assert.equal(savedValue('7', 'tinyint'), 7);
  assert.equal(savedValue('1', 'bit'), true);
});

test('the save script: each change finds exactly its row, or nothing is saved', () => {
  const set = { columns: PLAYERS[0].columns, rows: [[1, 1, 'Rui Costa', 'GK', null, 0], [2, 2, "Ana O'Silva", 'DF', 8, 0]] };
  const t = editTarget('SELECT * FROM dbo.Players', [set], schema);
  const script = saveScript(t, set, { cells: new Map([['0:2', 'Rui'], ['0:4', '9'], ['1:5', null]]), deletes: new Set([1]) });
  assert.match(script, /^-- trawl:edit 2 changes to dbo\.Players\nBEGIN TRANSACTION;\nSAVE TRANSACTION trawl_edit;\nBEGIN TRY\n/);
  // The changed columns must still hold what was read (NULL included); a deleted row's edits are dropped.
  assert.match(script, /UPDATE \[dbo\]\.\[Players\] SET \[Name\] = N'Rui', \[Shirt\] = 9 WHERE \[Id\] = 1 AND \[Name\] = N'Rui Costa' AND \[Shirt\] IS NULL;/);
  assert.match(script, /DELETE FROM \[dbo\]\.\[Players\] WHERE \[Id\] = 2;/);
  assert.doesNotMatch(script, /\[Goals\] = NULL/);
  assert.match(script, /IF @@ROWCOUNT <> 1 THROW 50000, N'The row Id = 1 changed or is gone since it was read\. Nothing was saved\.', 1;/);
  assert.match(script, /ROLLBACK TRANSACTION trawl_edit; COMMIT TRANSACTION;/);
  const { write, danger } = classifyScript(script);
  assert.equal(write, true);
  assert.deepEqual(danger, [], 'every statement has its WHERE');
  assert.throws(() => saveScript(t, set, { cells: new Map([['0:5', 'many']]), deletes: new Set() }), /Goals \(Id = 1\): int takes a whole number/);
  assert.equal(saveScript(t, set, { cells: new Map(), deletes: new Set() }), '');
});

test('a result set copies as tab-separated text or as INSERT statements', () => {
  const set = {
    columns: [{ name: 'Id', type: 'int' }, { name: 'Name', type: 'nvarchar' }, { name: 'Born', type: 'date' }, { name: 'Note', type: 'varchar' }],
    rows: [
      [1, "O'Neil", new Date('1990-05-01T00:00:00Z'), null],
      [2, 'tab\there', null, 'x'],
    ],
  };
  assert.equal(tsvText(set), "Id\tName\tBorn\tNote\n1\tO'Neil\t1990-05-01\t\n2\ttab here\t\tx");
  assert.equal(tsvText(set, { header: false, rows: [set.rows[0]] }), "1\tO'Neil\t1990-05-01\t");
  assert.equal(
    insertScript(set, '[dbo].[People]'),
    "INSERT INTO [dbo].[People] ([Id], [Name], [Born], [Note]) VALUES\n  (1, N'O''Neil', '1990-05-01', NULL),\n  (2, N'tab\there', NULL, 'x');",
  );
});
