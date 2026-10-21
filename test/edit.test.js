import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { canEdit, changesText, editRefusal, editTarget, editText, emptyIsDefault, hasChanges, insertScript, nextNewRow, noChanges, saveRecovery, saveScript, savedValue, toLiteral, tsvText, valueLiteral, withSaved } from '../src/edit.js';
import { demoSession } from '../src/demo.js';
import { SCHEMA_SQL, buildSchema } from '../src/schema.js';
import { classifyScript } from '../src/sql.js';
import { DIALECTS, splitScript } from '../src/dialects.js';
import { oneRowCheck } from '../src/db-mysql.js';

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
  assert.equal(canEdit({ type: 'int', computed: true }), false);
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

test('new rows: INSERTs of the columns given, each adding one row, in the same batch', () => {
  const set = { columns: PLAYERS[0].columns, rows: [[1, 1, 'Rui Costa', 'GK', null, 0]] };
  const t = editTarget('SELECT * FROM dbo.Players', [set], schema);
  assert.equal(nextNewRow(set, noChanges()), 1);
  assert.equal(nextNewRow(set, { ...noChanges(), inserts: [1, 3] }), 4, 'after the last, gaps and all');
  // Rows 1 and 3 are new (2 was added and removed again); 3 gives no values at all.
  const changes = { cells: new Map([['0:5', '2'], ['1:2', "Zé O'Neil"], ['1:1', '2'], ['1:4', null], ['2:2', 'gone']]), deletes: new Set(), inserts: [1, 3] };
  assert.equal(hasChanges(changes), true);
  assert.equal(hasChanges(noChanges()), false);
  const kept = { ...changes, cells: new Map([...changes.cells].filter(([at]) => at !== '2:2')) };
  assert.equal(changesText(kept), '1 edited row and 2 new rows');
  assert.equal(changesText({ ...kept, deletes: new Set([0]) }), '1 deletion and 2 new rows');
  assert.equal(changesText({ cells: new Map([['0:2', 'x']]), deletes: new Set([1]), inserts: [5] }), '1 edited row, 1 deletion and 1 new row');
  const script = saveScript(t, set, changes);
  assert.match(script, /^-- trawl:edit 3 changes to dbo\.Players\n/);
  assert.match(script, /UPDATE \[dbo\]\.\[Players\] SET \[Goals\] = 2 WHERE \[Id\] = 1 AND \[Goals\] = 0;/);
  assert.match(script, /INSERT INTO \[dbo\]\.\[Players\] \(\[ClubId\], \[Name\], \[Shirt\]\) VALUES \(2, N'Zé O''Neil', NULL\);\n  IF @@ROWCOUNT <> 1 THROW 50000, N'The new row 1 wasn''t added as one row\. Nothing was saved\.', 1;/);
  assert.match(script, /INSERT INTO \[dbo\]\.\[Players\] DEFAULT VALUES;\n  IF @@ROWCOUNT <> 1 THROW 50000, N'The new row 2 /);
  assert.doesNotMatch(script, /N'gone'/, 'a removed new row leaves nothing behind');
  assert.ok(script.indexOf('UPDATE') < script.indexOf('INSERT'));
  assert.match(script, /COMMIT TRANSACTION;\nEND TRY/);
  assert.deepEqual(classifyScript(script).danger, []);
  // A bad value says which new row it's in.
  assert.throws(() => saveScript(t, set, { cells: new Map([['1:5', 'lots']]), deletes: new Set(), inserts: [1] }), /Goals \(new row 1\): int takes a whole number/);
  // Nothing typed is the default, except where it is empty text.
  assert.equal(emptyIsDefault('int'), true);
  assert.equal(emptyIsDefault('date'), true);
  assert.equal(emptyIsDefault('nvarchar(100)'), false);
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

// A Postgres or MySQL catalog as dialects.js's schema queries return it, shaped by buildSchema.
const sets = (...list) => list.map(([names, rows]) => ({ columns: names.map((name) => ({ name, type: '' })), rows }));
function catalog(db, objects, columns) {
  return buildSchema(
    sets(
      [['db'], [[db]]],
      [['name'], [[db]]],
      [['schema', 'name', 'type', 'rows'], objects.map(([schema, name]) => [schema, name, 'U', 3])],
      [['schema', 'object', 'name', 'type', 'max_length', 'precision', 'scale', 'is_nullable', 'is_identity', 'is_computed', 'pk'], columns],
      [['name', 'schema', 'object', 'column', 'ref_schema', 'ref_object', 'ref_column'], []],
      [['schema', 'object', 'name', 'type', 'max_length', 'precision', 'scale', 'is_output'], []],
    ),
  );
}
const col = (schema, object, name, type, { pk = 0, identity = false, computed = false } = {}) => [schema, object, name, type, null, null, null, !pk, identity, computed, pk];
const pg = catalog(
  'shop',
  [['public', 'players'], ['other', 'players'], ['public', 'events']],
  [
    col('public', 'players', 'id', 'integer', { pk: 1, identity: true }),
    col('public', 'players', 'name', 'text'),
    col('public', 'players', 'active', 'boolean'),
    col('public', 'players', 'photo', 'bytea'),
    col('public', 'players', 'tags', 'text[]'),
    col('public', 'players', 'score', 'integer', { computed: true }),
    col('public', 'players', 'at', 'timestamp(3) with time zone'),
    col('other', 'players', 'id', 'integer', { pk: 1 }),
    col('public', 'events', 'at', 'timestamp without time zone', { pk: 1 }),
  ],
);
const my = catalog(
  'shop',
  [['shop', 'players']],
  [
    col('shop', 'players', 'id', 'int(10) unsigned', { pk: 1, identity: 1 }),
    col('shop', 'players', 'name', 'varchar(100)'),
    col('shop', 'players', 'flags', 'bit(3)'),
    col('shop', 'players', 'seen', 'timestamp'),
    col('shop', 'players', 'spot', 'point'),
    col('shop', 'players', 'total', 'int', { computed: 1 }),
  ],
);
const PG_PLAYERS = cols('id', 'name', 'active', 'photo', 'tags', 'score', 'at');
const MY_PLAYERS = cols('id', 'name', 'flags', 'seen', 'spot', 'total');

test('Postgres and MySQL rows are edited too: their quoted names, LIMIT, and the usual schema for a bare name', () => {
  const t = editTarget('SELECT * FROM "public"."players" LIMIT 500;', PG_PLAYERS, pg, { kind: 'postgres' });
  assert.equal(`${t.table.schema}.${t.table.name}`, 'public.players');
  assert.equal(t.kind, 'postgres');
  assert.deepEqual(t.keys, [0]);
  assert.equal(editTarget('select p.* from players p where p.active order by p.name limit 10 offset 5', PG_PLAYERS, pg, { kind: 'postgres' }).table.schema, 'public');
  assert.equal(editTarget('SELECT * FROM other.players', cols('id'), pg, { kind: 'postgres' }).table.schema, 'other');
  assert.match(editTarget('SELECT * FROM events', cols('at'), pg, { kind: 'postgres' }).reason, /its key at is timestamp without time zone, which can't be matched exactly/);
  const m = editTarget('SELECT * FROM `shop`.`players` LIMIT 500', MY_PLAYERS, my, { kind: 'mysql' });
  assert.equal(m.table.name, 'players');
  assert.equal(m.kind, 'mysql');
  // Without a kind it's SQL Server, as before.
  assert.equal(target('SELECT TOP (500) * FROM [dbo].[Players];').kind, 'sqlserver');
  // What can't be typed into: identity and generated columns, Postgres arrays, MySQL geometry.
  const players = pg.objects.find((o) => o.name === 'players' && o.schema === 'public');
  const c = (o, name) => o.columns.find((x) => x.name === name);
  assert.equal(c(players, 'id').identity, true);
  assert.match(editRefusal(c(players, 'score'), 'postgres'), /score is a generated column; the server sets it/);
  assert.match(editRefusal(c(players, 'tags'), 'postgres'), /tags is text\[\], which Trawl can't edit/);
  assert.equal(editRefusal(c(players, 'at'), 'postgres'), null);
  const mp = my.objects[0];
  assert.match(editRefusal(c(mp, 'total'), 'mysql'), /generated column/);
  assert.match(editRefusal(c(mp, 'spot'), 'mysql'), /can't edit/);
  assert.equal(canEdit(c(mp, 'seen'), 'mysql'), true, "MySQL's timestamp is a date and time, not SQL Server's rowversion");
  assert.equal(canEdit({ name: 'v', type: 'timestamp' }), false);
});

test('Postgres and MySQL literals: their own booleans, binary and escapes', () => {
  assert.equal(toLiteral('t', 'boolean', 'postgres'), 'TRUE');
  assert.equal(toLiteral('0', 'boolean', 'postgres'), 'FALSE');
  assert.throws(() => toLiteral('yes', 'boolean', 'postgres'), /true or false/);
  assert.equal(toLiteral('0x0a1', 'bytea', 'postgres'), "decode('00a1', 'hex')");
  assert.equal(toLiteral("O'Neil", 'character varying(50)', 'postgres'), "'O''Neil'");
  assert.equal(toLiteral(String.raw`C:\temp's`, 'text', 'postgres'), String.raw`E'C:\\temp''s'`);
  assert.equal(toLiteral('{B0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11}', 'uuid', 'postgres'), "'B0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11'");
  assert.equal(toLiteral('2026-10-20 15:30', 'timestamp(3) with time zone', 'postgres'), "'2026-10-20 15:30'");
  assert.equal(toLiteral('12', 'integer', 'postgres'), '12');
  assert.equal(toLiteral('{"a": 1}', 'jsonb', 'postgres'), `'{"a": 1}'`, 'other types go as text for the server to read');
  assert.throws(() => toLiteral('', 'jsonb', 'postgres'), /jsonb takes a value/);
  assert.equal(toLiteral('', 'text', 'postgres'), "''");
  assert.equal(emptyIsDefault('jsonb', 'postgres'), true);
  assert.equal(emptyIsDefault('character varying(20)', 'postgres'), false);
  assert.throws(() => toLiteral('{1,2}', 'integer[]', 'postgres'), /can't be edited/);
  assert.equal(toLiteral('7', 'int(10) unsigned', 'mysql'), '7');
  assert.throws(() => toLiteral('-', 'bigint unsigned', 'mysql'), /whole number/);
  assert.equal(toLiteral('101', 'bit(3)', 'mysql'), "b'101'");
  assert.equal(toLiteral('0x05', 'bit(3)', 'mysql'), "X'05'");
  assert.equal(toLiteral('0xABC', 'blob', 'mysql'), "X'0ABC'");
  assert.equal(toLiteral("it's", 'varchar(100)', 'mysql'), "'it''s'");
  assert.equal(toLiteral('a\\b', 'text', 'mysql'), "CONVERT(X'615c62' USING utf8mb4)", 'a backslash means the same whatever sql_mode says');
  assert.equal(toLiteral('2026-10-20 15:30:00', 'timestamp', 'mysql'), "'2026-10-20 15:30:00'");
  assert.equal(toLiteral('', 'enum(\'a\',\'b\')', 'mysql'), "''");
  // Values read back go into WHERE (and INSERT copies) the same way.
  assert.equal(valueLiteral(true, 'boolean', 'postgres'), 'TRUE');
  assert.equal(valueLiteral(Buffer.from([10, 27]), 'bytea', 'postgres'), "decode('0a1b', 'hex')");
  assert.equal(valueLiteral(new Date('2026-10-20T15:30:00Z'), 'timestamp with time zone', 'postgres'), "'2026-10-20T15:30:00.000Z'");
  assert.equal(valueLiteral(new Date('2026-10-20T15:30:00Z'), 'datetime', 'mysql'), "'2026-10-20T15:30:00.000'");
  assert.equal(valueLiteral(['a b', null, 'q"\\'], '', 'postgres'), String.raw`E'{"a b",NULL,"q\\"\\\\"}'`);
  assert.equal(valueLiteral([1, 2], 'jsonb', 'postgres'), "'[1,2]'", 'JSON arrays stay JSON');
  assert.equal(valueLiteral('NaN', 'numeric', 'postgres'), "'NaN'");
  assert.equal(valueLiteral(Buffer.from([5]), 'bit', 'mysql'), "X'05'");
  assert.equal(insertScript({ columns: [{ name: 'n', type: 'Int' }, { name: 's', type: 'text' }], rows: [[1, 'x']] }, '"t"', { quote: DIALECTS.postgres.quote, kind: 'postgres' }), `INSERT INTO "t" ("n", "s") VALUES\n  (1, 'x');`);
  assert.equal(savedValue('t', 'boolean', 'postgres'), true);
  assert.deepEqual(savedValue('101', 'bit(3)', 'mysql'), Buffer.from([5]));
});

test('the Postgres save script: one DO block checking each ROW_COUNT, in a savepoint when a transaction is open', () => {
  const set = { columns: PG_PLAYERS[0].columns, rows: [[1, 'Rui $trawl$', true, null, null, 2, null], [2, 'Ana', false, null, ['x'], 0, null]] };
  const t = editTarget('SELECT * FROM players', [set], pg, { kind: 'postgres' });
  const changes = { cells: new Map([['0:1', 'Rui'], ['0:2', 'false'], ['2:1', 'Zé']]), deletes: new Set([1]), inserts: [2] };
  const script = saveScript(t, set, changes);
  const lines = script.split('\n');
  assert.equal(lines[0], '-- trawl:edit 3 changes to public.players');
  // The block's quotes are kept off what it holds.
  assert.equal(lines[1], 'DO $trawl1$');
  assert.equal(lines.at(-1), 'END $trawl1$;');
  assert.match(script, /^#variable_conflict use_column\nDECLARE trawl_rows bigint;\nBEGIN$/m);
  assert.match(script, /^ {2}UPDATE "public"\."players" SET "name" = 'Rui', "active" = FALSE WHERE "id" = 1 AND "name" = 'Rui \$trawl\$' AND "active" = TRUE;\n {2}GET DIAGNOSTICS trawl_rows = ROW_COUNT;\n {2}IF trawl_rows <> 1 THEN RAISE EXCEPTION USING MESSAGE = 'The row id = 1 changed or is gone since it was read\. Nothing was saved\.'; END IF;$/m);
  assert.match(script, /DELETE FROM "public"\."players" WHERE "id" = 2;/);
  assert.match(script, /INSERT INTO "public"\."players" \("name"\) VALUES \('Zé'\);\n.*\n.*'The new row 1 wasn''t added as one row\. Nothing was saved\.'/);
  assert.equal(splitScript(script, DIALECTS.postgres).length, 1, 'one statement');
  assert.deepEqual(classifyScript(script, { dialect: 'postgres' }), { write: true, danger: [] });
  assert.doesNotMatch(script, /SAVEPOINT/, 'on its own the block undoes itself when it fails');
  assert.equal(saveRecovery(t), '');
  const inTx = saveScript(t, set, changes, { transaction: true }).split('\n');
  assert.deepEqual([inTx[1], inTx.at(-1)], ['SAVEPOINT trawl_edit;', 'RELEASE SAVEPOINT trawl_edit;']);
  assert.equal(saveRecovery(t, { transaction: true }), 'ROLLBACK TO SAVEPOINT trawl_edit;\nRELEASE SAVEPOINT trawl_edit;');
  assert.equal(saveScript(t, set, { ...noChanges(), inserts: [2] }).split('\n')[5], '  INSERT INTO "public"."players" DEFAULT VALUES;');
  assert.deepEqual(withSaved(set, { ...noChanges(), cells: new Map([['0:2', 'f']]) }, t).rows[0][2], false);
});

test('the MySQL save script: statements a one-row check each, in a transaction of its own or a savepoint', () => {
  const set = { columns: MY_PLAYERS[0].columns, rows: [[1, 'line\nbreak', Buffer.from([1]), null, null, 3]] };
  const t = editTarget('SELECT * FROM players', [set], my, { kind: 'mysql' });
  const script = saveScript(t, set, { cells: new Map([['0:1', 'Rui'], ['0:2', '0x02']]), deletes: new Set(), inserts: [1] });
  assert.equal(
    script,
    [
      '-- trawl:edit 2 changes to shop.players',
      'START TRANSACTION;',
      '-- trawl:one row: The row id = 1 changed or is gone since it was read. Nothing was saved.',
      "UPDATE `shop`.`players` SET `name` = 'Rui', `flags` = X'02' WHERE `id` = 1 AND `name` = 'line\nbreak';",
      "-- trawl:one row: The new row 1 wasn't added as one row. Nothing was saved.",
      'INSERT INTO `shop`.`players` () VALUES ();',
      'COMMIT;',
    ].join('\n'),
  );
  const statements = splitScript(script, DIALECTS.mysql).map((s) => s.text);
  assert.equal(statements.length, 4);
  assert.deepEqual(statements.map(oneRowCheck), [null, 'The row id = 1 changed or is gone since it was read. Nothing was saved.', "The new row 1 wasn't added as one row. Nothing was saved.", null]);
  assert.deepEqual(classifyScript(script, { dialect: 'mysql' }).danger, []);
  assert.equal(saveRecovery(t), 'ROLLBACK;');
  // A key whose text has a line break can't end the check's comment early.
  const keyed = { columns: cols('name', 'id')[0].columns, rows: [['x', 1]] };
  const k = { ...t, keys: [0], columns: new Map([[0, { name: 'name', type: 'varchar(9)' }], [1, { name: 'id', type: 'int' }]]) };
  const odd = saveScript(k, { ...keyed, rows: [['a\nUPDATE x SET y = 1;', 1]] }, { ...noChanges(), deletes: new Set([0]) });
  assert.match(odd, /^-- trawl:one row: The row name = a UPDATE x SET y = 1; changed/m);
  assert.equal(splitScript(odd, DIALECTS.mysql).length, 3);
  const inTx = saveScript(t, set, { ...noChanges(), deletes: new Set([0]) }, { transaction: true }).split('\n');
  assert.deepEqual([inTx[1], inTx.at(-1)], ['SAVEPOINT trawl_edit;', 'RELEASE SAVEPOINT trawl_edit;']);
  assert.equal(saveRecovery(t, { transaction: true }), 'ROLLBACK TO SAVEPOINT trawl_edit;\nRELEASE SAVEPOINT trawl_edit;');
});
