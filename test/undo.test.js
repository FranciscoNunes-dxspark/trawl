import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { demoSession } from '../src/demo.js';
import { SCHEMA_SQL, buildSchema } from '../src/schema.js';
import { UNDO_KEEP, UNDO_ROWS, reverseScript, snapshotOf, snapshotSummary, undoPlan, withSnapshot } from '../src/undo.js';

let schema;
let session;
before(async () => {
  session = demoSession({ demo: true, name: 'demo' });
  schema = buildSchema((await session.run(SCHEMA_SQL)).sets);
});

const plan = (sql, kind) => undoPlan(sql, schema, { kind });
const reason = (sql, kind) => plan(sql, kind)?.reason;

test('an UPDATE or DELETE of one table with a primary key is read first, by a capped SELECT', () => {
  const u = plan("UPDATE dbo.Players SET Goals = Goals + 1, [Name] = N'x, y' WHERE ClubId = 2;");
  assert.equal(u.op, 'update');
  assert.equal(u.table.name, 'Players');
  assert.deepEqual(u.keys, ['Id']);
  assert.deepEqual(u.setColumns, ['Goals', 'Name']);
  assert.equal(u.select, `-- trawl:snapshot\nSELECT TOP (${UNDO_ROWS + 1}) * FROM dbo.Players WHERE ClubId = 2;`);
  const d = plan('delete from Players p where p.Id in (select Id from dbo.Players where Goals > 2)');
  assert.equal(d.op, 'delete');
  assert.match(d.select, /SELECT TOP \(10001\) \* FROM Players p where p\.Id in \(select Id from dbo\.Players where Goals > 2\);$/);
  // No WHERE: the whole table (the danger question asks first anyway).
  assert.match(plan('DELETE dbo.Matches').select, /FROM dbo\.Matches;$/);
  // Postgres and MySQL say LIMIT; Postgres reads each column as text (but bytea), as the server writes it.
  assert.match(plan('DELETE FROM dbo.Clubs WHERE Id = 3', 'mysql').select, /SELECT \* FROM dbo\.Clubs WHERE Id = 3 LIMIT 10001;$/);
  assert.match(plan('DELETE FROM dbo.Clubs WHERE Id = 3', 'postgres').select, /SELECT "Id"::text AS "Id", "Name"::text AS "Name", .* FROM dbo\.Clubs WHERE Id = 3 LIMIT 10001;$/);
  assert.equal(plan("UPDATE i18n.Translations SET Value = 'x' WHERE Culture = 'en'").keys.join(), 'ResourceKey,Culture');
});

test("what can't be copied safely says why, and anything else isn't asked about", () => {
  assert.equal(plan('SELECT * FROM dbo.Players'), null);
  assert.equal(plan('CREATE TABLE dbo.T (Id int)'), null);
  assert.match(reason('UPDATE dbo.Players SET Goals = 0 WHERE Id = 1; DELETE FROM dbo.Clubs WHERE Id = 2'), /several statements/);
  assert.match(reason('UPDATE TOP (5) dbo.Players SET Goals = 0'), /TOP/);
  assert.match(reason('DELETE FROM dbo.Players OUTPUT deleted.* WHERE Id = 1'), /OUTPUT/);
  assert.match(reason('UPDATE p SET Goals = 0 FROM dbo.Players p JOIN dbo.Clubs c ON c.Id = p.ClubId'), /other tables/);
  assert.match(reason('DELETE p FROM dbo.Players p WHERE p.Id = 1'), /DELETE … FROM/);
  assert.match(reason('UPDATE dbo.Players SET Id = 99 WHERE Id = 1'), /primary key \(Id\)/);
  assert.match(reason('UPDATE dbo.vTopScorers SET Goals = 1'), /isn’t a table/);
  assert.match(reason('UPDATE dbo.Players SET Nope = 1 WHERE Id = 1'), /Nope isn't a column/);
  assert.match(reason('DELETE FROM dbo.Players WHERE CURRENT OF c'), /cursor/);
  assert.match(reason('DELETE FROM dbo.Players ORDER BY Id LIMIT 3', 'mysql'), /LIMIT|ORDER/);
  assert.match(reason('MERGE dbo.Players AS t USING dbo.Clubs AS s ON 1 = 0 WHEN MATCHED THEN DELETE;'), /MERGE/);
  // A keyword in a string or a subquery isn't the statement's.
  assert.equal(plan("UPDATE dbo.Players SET Name = 'TOP JOIN' WHERE Id IN (SELECT TOP 1 Id FROM dbo.Players p JOIN dbo.Clubs c ON c.Id = p.ClubId)").op, 'update');
});

test('an INSERT is undone by its keys, only when they are written in it', () => {
  const i = plan("INSERT INTO i18n.Translations (ResourceKey, Value, Culture, ResourceSet) VALUES (N'A', N'a, b', N'en', N'X'), ('B', 'b', 'fr', 'X')");
  assert.equal(i.op, 'insert');
  assert.deepEqual(i.inserted, [["N'A'", "N'en'"], ["'B'", "'fr'"]]);
  assert.match(reason("INSERT INTO dbo.Players (ClubId, Name, Position, Goals) VALUES (1, N'New', 'FW', 0)"), /key \(Id\) is the server's/);
  assert.match(reason('INSERT INTO dbo.Players SELECT * FROM dbo.Players'), /aren't written/);
  assert.match(reason("INSERT INTO dbo.Players (Id, Name) VALUES (NEXT VALUE FOR s, 'x')"), /plain values/);
  assert.match(reason("INSERT INTO dbo.Players (Id, Name) VALUES (1, 'x') ON CONFLICT DO NOTHING", 'postgres'), /ON CONFLICT/);
  assert.equal(plan("INSERT INTO dbo.Players (Id, Name) VALUES (40, 'x') RETURNING Id", 'postgres').inserted[0][0], '40');
});

test('the copy keeps the rows as JSON can, and the script puts them back', async () => {
  const p = plan("UPDATE dbo.Players SET Goals = 9, Shirt = NULL WHERE Id IN (1, 2)");
  const read = (await session.run(p.select)).sets[0];
  assert.equal(read.rows.length, 2);
  const s = snapshotOf(p, read, { sql: p.select, conn: 'demo', database: 'ClubA', kind: 'sqlserver', at: Date.UTC(2026, 9, 21, 9, 30) });
  const back = JSON.parse(JSON.stringify(s));
  assert.equal(snapshotSummary(back), 'UPDATE · 2 rows');
  const script = reverseScript(back);
  assert.match(script, /^-- Undoes: /);
  assert.match(script, /demo\/ClubA at 2026-10-21 09:30:00 UTC/);
  // Only the columns it set, back to what they were (Rui Costa's shirt was NULL), by the key.
  assert.match(script, /^UPDATE \[dbo\]\.\[Players\] SET \[Goals\] = 0, \[Shirt\] = NULL WHERE \[Id\] = 1;$/m);
  assert.match(script, /^UPDATE \[dbo\]\.\[Players\] SET \[Goals\] = 0, \[Shirt\] = 8 WHERE \[Id\] = 2;$/m);
});

test('deleted rows go back with their identity, each kind its way', async () => {
  const p = plan('DELETE FROM dbo.Clubs WHERE Id = 3');
  const read = (await session.run(p.select)).sets[0];
  const s = JSON.parse(JSON.stringify(snapshotOf(p, read, { sql: 'DELETE FROM dbo.Clubs WHERE Id = 3', conn: 'demo', database: 'ClubA' })));
  const script = reverseScript(s);
  assert.match(script, /SET IDENTITY_INSERT \[dbo\]\.\[Clubs\] ON;\nINSERT INTO \[dbo\]\.\[Clubs\] \(\[Id\], \[Name\], \[Country\], \[Founded\], \[Active\]\) VALUES\n {2}\(3, N'Union Sud', 'FR', '1899-05-20', 0\);\nSET IDENTITY_INSERT \[dbo\]\.\[Clubs\] OFF;/);
  const pg = reverseScript({ ...s, kind: 'postgres' });
  assert.match(pg, /INSERT INTO "dbo"\."Clubs" \("Id", "Name", "Country", "Founded", "Active"\) OVERRIDING SYSTEM VALUE VALUES\n {2}\(3, 'Union Sud', 'FR', '1899-05-20', FALSE\);/);
  assert.doesNotMatch(pg, /IDENTITY_INSERT/);
  assert.match(reverseScript({ ...s, kind: 'mysql' }), /INSERT INTO `dbo`\.`Clubs` \(`Id`, .*\) VALUES\n {2}\(3, 'Union Sud', 'FR', '1899-05-20', 0\);/);
});

test('an INSERT copy deletes its keys; too many rows or a missing key keep nothing', () => {
  const p = plan("INSERT INTO i18n.Translations (ResourceKey, Value, Culture, ResourceSet) VALUES (N'A', N'a', N'en', N'X')");
  const s = snapshotOf(p, null, { sql: 'INSERT …', conn: 'demo', database: 'ClubA' });
  assert.match(reverseScript(s), /^DELETE FROM \[i18n\]\.\[Translations\] WHERE \[ResourceKey\] = N'A' AND \[Culture\] = N'en';$/m);
  assert.equal(snapshotSummary(s), 'INSERT · 1 row added');
  const u = plan('UPDATE dbo.Players SET Goals = 0');
  const big = { columns: [{ name: 'Id' }], rows: Array.from({ length: UNDO_ROWS + 1 }, (_, i) => [i]) };
  assert.match(snapshotOf(u, big, { sql: '', conn: 'c', database: 'd' }).reason, /more than 10,000 rows/);
  assert.match(snapshotOf(u, { columns: [{ name: 'Goals' }], rows: [[1]] }, { sql: '', conn: 'c', database: 'd' }).reason, /no Id/);
});

test('values that JSON has no type for come back as they were', () => {
  const t = { schema: 'dbo', name: 'T', columns: [{ name: 'Id', type: 'int', pk: true }, { name: 'At', type: 'datetime2' }, { name: 'Bin', type: 'varbinary(10)' }, { name: 'Big', type: 'bigint' }] };
  const p = { op: 'update', table: t, keys: ['Id'], setColumns: ['At', 'Bin', 'Big'] };
  const set = { columns: t.columns.map((c) => ({ name: c.name })), rows: [[1, new Date(Date.UTC(2026, 0, 2, 3, 4, 5)), Buffer.from([10, 27]), 9007199254740993n]] };
  const s = JSON.parse(JSON.stringify(snapshotOf(p, set, { sql: '', conn: 'c', database: 'd' }, null), (k, v) => (typeof v === 'bigint' ? String(v) : v)));
  assert.match(reverseScript(s), /SET \[At\] = '2026-01-02T03:04:05.000', \[Bin\] = 0x0a1b, \[Big\] = 9007199254740993 WHERE \[Id\] = 1;/);
});

test('ten copies are kept per connection, newest first', () => {
  let list = [];
  for (let i = 0; i < UNDO_KEEP + 3; i++) list = withSnapshot(list, { at: i });
  assert.equal(list.length, UNDO_KEEP);
  assert.equal(list[0].at, UNDO_KEEP + 2);
  assert.deepEqual(withSnapshot(null, { at: 1 }), [{ at: 1 }]);
});

test("Postgres: every column but a generated one goes back, as the server wrote it (microseconds, intervals, arrays, json's spacing)", () => {
  const t = {
    schema: 'public',
    name: 'g',
    columns: [
      { name: 'id', type: 'integer', pk: true, identity: true },
      { name: 'at', type: 'timestamp without time zone' },
      { name: 'dur', type: 'interval' },
      { name: 'tags', type: 'text[]' },
      { name: 'js', type: 'json' },
      { name: 'raw', type: 'bytea' },
      { name: 'twice', type: 'numeric', computed: true },
    ],
  };
  const schema = { objects: [{ ...t, kind: 'table' }], foreignKeys: [] };
  const d = undoPlan('DELETE FROM public.g WHERE id > 1', schema, { kind: 'postgres' });
  assert.equal(d.select, '-- trawl:snapshot\nSELECT "id"::text AS "id", "at"::text AS "at", "dur"::text AS "dur", "tags"::text AS "tags", "js"::text AS "js", "raw", "twice"::text AS "twice" FROM public.g WHERE id > 1 LIMIT 10001;');
  const set = { columns: t.columns.map((c) => ({ name: c.name })), rows: [['2', '2024-04-01 01:30:00.123456', '1 day 02:00:00', '{a,"b,c"}', '{"a": 1}', Buffer.from([0, 255]), '4']] };
  const s = JSON.parse(JSON.stringify(snapshotOf(d, set, { sql: 'DELETE FROM public.g WHERE id > 1', conn: 'c', database: 'd', kind: 'postgres' })));
  assert.match(reverseScript(s), /INSERT INTO "public"\."g" \("id", "at", "dur", "tags", "js", "raw"\) OVERRIDING SYSTEM VALUE VALUES\n {2}\(2, '2024-04-01 01:30:00\.123456', '1 day 02:00:00', '\{a,"b,c"\}', '\{"a": 1\}', decode\('00ff', 'hex'\)\);/);
  const u = undoPlan("UPDATE public.g SET dur = '1s', tags = '{}' WHERE id = 2", schema, { kind: 'postgres' });
  const us = JSON.parse(JSON.stringify(snapshotOf(u, set, { sql: '', conn: 'c', database: 'd', kind: 'postgres' })));
  assert.match(reverseScript(us), /UPDATE "public"\."g" SET "dur" = '1 day 02:00:00', "tags" = '\{a,"b,c"\}' WHERE "id" = 2;/);
});
