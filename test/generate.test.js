import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIALECTS } from '../src/dialects.js';
import { typeInfo } from '../src/coltypes.js';
import { generateRows, generateScript, literalFor, random, refValuesSql } from '../src/generate.js';

const col = (name, type, extra = {}) => ({ name, type, nullable: false, identity: false, pk: false, ...extra });
const PEOPLE = {
  schema: 'dbo',
  name: 'Customers',
  kind: 'table',
  columns: [
    col('Id', 'int', { pk: true, identity: true }),
    col('FirstName', 'nvarchar(40)'),
    col('LastName', 'nvarchar(40)'),
    col('Email', 'varchar(60)'),
    col('Country', 'char(2)'),
    col('BirthDate', 'date', { nullable: true }),
    col('Balance', 'decimal(8,2)'),
    col('Code', 'char(3)'),
    col('Active', 'bit'),
    col('CreatedAt', 'datetime2'),
    col('ClubId', 'int'),
    col('Notes', 'nvarchar(max)', { nullable: true }),
    col('RowVer', 'timestamp'),
    col('Shape', 'geography', { nullable: true }),
  ],
};
const REFS = [{ name: 'FK_Customers_Clubs', from: 'dbo.Customers', to: 'dbo.Clubs', columns: [['ClubId', 'Id']], rows: [[4], [9]] }];

test('the same seed gives the same rows, another seed others', () => {
  const a = generateScript(PEOPLE, 20, { seed: 7, refs: REFS }).script;
  assert.equal(generateScript(PEOPLE, 20, { seed: 7, refs: REFS }).script, a);
  assert.notEqual(generateScript(PEOPLE, 20, { seed: 8, refs: REFS }).script, a);
  assert.equal(generateScript(PEOPLE, 3, { seed: 'abc' }).script, generateScript(PEOPLE, 3, { seed: 'abc' }).script);
  const r = random(1);
  const xs = Array.from({ length: 1000 }, r);
  assert.ok(xs.every((x) => x >= 0 && x < 1));
});

test('each value fits its column: identity, rowversion and unknown types left out, lengths, ranges, foreign keys', () => {
  const { columns, rows, notes } = generateRows(PEOPLE, 200, { seed: 3, refs: REFS });
  assert.deepEqual(columns.map((c) => c.name), ['FirstName', 'LastName', 'Email', 'Country', 'BirthDate', 'Balance', 'Code', 'Active', 'CreatedAt', 'ClubId', 'Notes']);
  assert.match(notes[0], /^Left out: Id \(identity\), RowVer \(timestamp, the server's\), Shape \(geography: Trawl makes no values for it\)\.$/);
  assert.ok(notes.some((n) => n === 'ClubId: a value from dbo.Clubs (2 rows).'));
  const at = (name) => columns.findIndex((c) => c.name === name);
  for (const row of rows) {
    assert.ok(row[at('FirstName')].length <= 40 && /^[\p{L}' ]+$/u.test(row[at('FirstName')]));
    assert.match(row[at('Email')], /^[a-z]+\.[a-z]+\d+@example\.com$/);
    assert.ok(row[at('Email')].length <= 60);
    assert.match(row[at('Country')], /^[A-Z]{2}$/);
    assert.ok(row[at('BirthDate')] === null || (row[at('BirthDate')] instanceof Date && row[at('BirthDate')].getUTCFullYear() < 2006));
    assert.ok(Math.abs(row[at('Balance')]) < 1e6 && Number.isInteger(Math.round(row[at('Balance')] * 100)));
    assert.equal(row[at('Code')].length <= 3, true);
    assert.equal(typeof row[at('Active')], 'boolean');
    assert.ok(row[at('CreatedAt')] instanceof Date);
    assert.ok([4, 9].includes(row[at('ClubId')]));
  }
  // Nullable columns are sometimes NULL; NOT NULL ones never are.
  assert.ok(rows.some((r) => r[at('Notes')] === null) && rows.some((r) => r[at('Notes')] !== null));
  assert.ok(rows.every((r) => r[at('FirstName')] !== null));
});

test('primary-key and unique columns stay unique; a foreign key with nothing to refer to says so', () => {
  const t = { schema: 'dbo', name: 'Codes', kind: 'table', columns: [col('Id', 'int', { pk: true }), col('Code', 'varchar(5)'), col('Tag', 'tinyint'), col('ParentId', 'int', { nullable: true }), col('OwnerId', 'int')] };
  const refs = [
    { name: 'FK_p', from: 'dbo.Codes', to: 'dbo.Codes', columns: [['ParentId', 'Id']], rows: [] },
    { name: 'FK_o', from: 'dbo.Codes', to: 'dbo.Owners', columns: [['OwnerId', 'Id']], rows: [] },
  ];
  const { rows, notes } = generateRows(t, 300, { seed: 1, unique: ['Code', 'Tag'], refs });
  for (const i of [0, 1]) assert.equal(new Set(rows.map((r) => r[i])).size, 300, `column ${i}`);
  assert.ok(rows.every((r) => r[1].length <= 5));
  assert.ok(rows.every((r) => r[3] === null));
  assert.ok(notes.includes('Id, Code, Tag: unique within these rows, but not checked against the rows the table has.'));
  assert.ok(notes.includes('dbo.Codes has no rows, so ParentId is NULL.'));
  assert.ok(notes.some((n) => /dbo\.Owners has no rows to refer to: OwnerId get made-up values/.test(n)));
  assert.ok(notes.some((n) => /Tag must be unique, and a tinyint has room for only 255 different values/.test(n)));
});

test('a foreign key of two columns takes both from one referenced row', () => {
  const t = { schema: 'dbo', name: 'Lines', kind: 'table', columns: [col('OrderId', 'int'), col('Region', 'char(2)'), col('Qty', 'int')] };
  const refs = [{ name: 'FK', from: 'dbo.Lines', to: 'dbo.Orders', columns: [['OrderId', 'Id'], ['Region', 'Region']], rows: [[1, 'EU'], [2, 'US']] }];
  const { rows } = generateRows(t, 50, { refs });
  assert.ok(rows.every((r) => (r[0] === 1 && r[1] === 'EU') || (r[0] === 2 && r[1] === 'US')));
  assert.ok(rows.every((r) => r[2] >= 1 && r[2] <= 100), 'a quantity');
});

test('the script: INSERTs of a thousand rows at most, literals each server’s way', () => {
  const { script } = generateScript(PEOPLE, 1001, { refs: REFS });
  assert.match(script, /^-- 1001 rows of made-up data for dbo\.Customers \(seed 1\)\. Nothing has run: read it, then R runs it\.\n-- Left out:/);
  assert.equal(script.match(/^INSERT INTO \[dbo\]\.\[Customers\] \(\[FirstName\], \[LastName\], \[Email\]/gm).length, 2);
  assert.match(script, /\(N'[^']*(?:''[^']*)*', N'/, 'nvarchar as N\'…\'');
  const pg = generateScript({ ...PEOPLE, schema: 'public', columns: [col('id', 'integer', { pk: true, identity: true }), col('name', 'text'), col('active', 'boolean'), col('born', 'timestamp without time zone'), col('blob', 'bytea')] }, 2, { kind: 'postgres', quote: DIALECTS.postgres.quote }).script;
  assert.match(pg, /^INSERT INTO "public"\."Customers" \("name", "active", "born", "blob"\) VALUES\n {2}\('[^N]/m);
  assert.match(pg, /(TRUE|FALSE), '\d{4}-\d\d-\d\d \d\d:\d\d:\d\d', '\\x[0-9a-f]+'::bytea\)/);
  assert.equal(literalFor("O'Brien \\ x", typeInfo('varchar(20)', 'mysql'), 'mysql'), "'O''Brien \\\\ x'");
  assert.equal(literalFor('Zoë', typeInfo('nvarchar(10)'), 'sqlserver'), "N'Zoë'");
  assert.equal(literalFor('x', typeInfo('varchar(10)'), 'sqlserver'), "'x'");
  assert.equal(literalFor(true, typeInfo('bit'), 'sqlserver'), '1');
  assert.equal(literalFor(new Date('2026-03-04T05:06:07Z'), typeInfo('date'), 'sqlserver'), "'2026-03-04'");
  assert.equal(literalFor(Buffer.from([1, 255]), typeInfo('varbinary(2)'), 'sqlserver'), '0x01FF');
  assert.equal(literalFor(null, typeInfo('int'), 'postgres'), 'NULL');
  const empty = generateScript({ schema: 'dbo', name: 'Ids', kind: 'table', columns: [col('Id', 'int', { identity: true, pk: true })] }, 2).script;
  assert.match(empty, /INSERT INTO \[dbo\]\.\[Ids\] DEFAULT VALUES;\nINSERT INTO \[dbo\]\.\[Ids\] DEFAULT VALUES;\n$/);
});

test('the values a foreign key can take are read capped, in key order', () => {
  const fk = { to: 'dbo.Clubs', columns: [['ClubId', 'Id']] };
  assert.equal(refValuesSql(DIALECTS.sqlserver, fk), 'SELECT TOP (1000) [Id] FROM [dbo].[Clubs] ORDER BY [Id];');
  assert.equal(refValuesSql(DIALECTS.postgres, { to: 'public.orders', columns: [['a', 'id'], ['b', 'region']] }, 50), 'SELECT "id", "region" FROM "public"."orders" ORDER BY "id", "region" LIMIT 50;');
});

test('column types from each kind of server', () => {
  assert.deepEqual(['family', 'length', 'unicode'].map((k) => typeInfo('nvarchar(100)')[k]), ['text', 100, true]);
  assert.equal(typeInfo('nvarchar(max)').length, null);
  assert.deepEqual([typeInfo('decimal(10,2)').precision, typeInfo('decimal(10,2)').scale], [10, 2]);
  assert.equal(typeInfo('timestamp').family, 'rowversion');
  assert.equal(typeInfo('timestamp', 'mysql').family, 'datetime');
  assert.equal(typeInfo('timestamp(3) with time zone', 'postgres').tz, true);
  assert.equal(typeInfo('character varying(20)', 'postgres').length, 20);
  assert.equal(typeInfo('tinyint(1)', 'mysql').family, 'bool');
  assert.deepEqual([typeInfo('int unsigned', 'mysql').unsigned, typeInfo('int unsigned', 'mysql').max], [true, 4294967295]);
  assert.deepEqual(typeInfo("enum('a','b''c')", 'mysql').values, ['a', "b'c"]);
  assert.equal(typeInfo('integer[]', 'postgres').family, 'other');
  assert.deepEqual([typeInfo('tinyint').min, typeInfo('tinyint').max], [0, 255]);
});
