import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, classifyScript, countQuery, viewOrder, formatValue, mask, oneLine, quoteIdent, splitBatches, splitStatements, statementAt, toCsv, toJson, withoutLeadingComments } from '../src/sql.js';

const texts = (list) => list.map((s) => s.text);

test('mask hides comments, strings and quoted names but keeps offsets', () => {
  const src = "SELECT 'a;b', [x;y], \"q\" /* ; /* nested */ ; */ -- ;\nFROM t";
  const m = mask(src);
  assert.equal(m.length, src.length);
  assert.ok(!m.includes(';'));
  assert.ok(m.endsWith('\nFROM t'));
  assert.equal(mask("'it''s'").replace(/\u0001/g, ''), '');
});

test('GO splits batches, with repeat counts, and not inside comments', () => {
  const b = splitBatches('SELECT 1\nGO\n/*\nGO\n*/\nSELECT 2\ngo 3\n\nGO\n');
  assert.deepEqual(b.map((x) => [x.text, x.line, x.repeat]), [
    ['SELECT 1', 1, 1],
    ['/*\nGO\n*/\nSELECT 2', 3, 3],
  ]);
});

test('statements end at ;, blank lines and GO', () => {
  const s = splitStatements('SELECT 1; SELECT 2\nSELECT 3\n\nSELECT 4\nGO\nSELECT 5');
  assert.deepEqual(texts(s), ['SELECT 1;', 'SELECT 2\nSELECT 3', 'SELECT 4', 'SELECT 5']);
  assert.deepEqual(s.map((x) => x.line), [1, 1, 4, 6]);
});

test('BEGIN … END and CASE … END keep a statement together; BEGIN TRAN does not', () => {
  const s = splitStatements('IF 1 = 1\nBEGIN\n  SELECT 1;\n\n  SELECT CASE WHEN 1 = 1 THEN 2 END;\nEND\nBEGIN TRAN;\nSELECT 9;');
  assert.deepEqual(texts(s), ['IF 1 = 1\nBEGIN\n  SELECT 1;\n\n  SELECT CASE WHEN 1 = 1 THEN 2 END;\nEND', 'BEGIN TRAN;', 'SELECT 9;']);
});

test('a procedure runs on to the next GO', () => {
  const s = splitStatements('CREATE OR ALTER PROCEDURE dbo.p AS\nSELECT 1;\n\nSELECT 2;\nGO\nEXEC dbo.p;');
  assert.deepEqual(texts(s), ['CREATE OR ALTER PROCEDURE dbo.p AS\nSELECT 1;\n\nSELECT 2;', 'EXEC dbo.p;']);
});

test('comment-only pieces are dropped and labels skip leading comments', () => {
  const s = splitStatements('-- header\n\n-- what this does\nSELECT *\nFROM t;\n/* trailing */');
  assert.equal(s.length, 1);
  assert.equal(s[0].label, 'SELECT *');
  assert.equal(s[0].line, 3);
  assert.equal(s[0].endLine, 5);
});

test('CRLF files split the same way', () => {
  assert.deepEqual(texts(splitStatements('SELECT 1\r\n\r\nSELECT 2\r\n')), ['SELECT 1', 'SELECT 2']);
});

test('statementAt finds the statement covering a line', () => {
  const s = splitStatements('SELECT 1\n\nSELECT\n2');
  assert.equal(statementAt(s, 4).text, 'SELECT\n2');
  assert.equal(statementAt(s, 2).text, 'SELECT 1');
});

test('reads are not writes', () => {
  for (const q of ['SELECT * FROM t', 'WITH x AS (SELECT 1 AS a) SELECT * FROM x', "SELECT 'DELETE FROM t'", 'SELECT [Update] FROM t', 'EXEC sp_who2', 'EXEC sys.sp_help', 'DECLARE @a int = 1; SELECT @a', 'SET NOCOUNT ON']) {
    assert.equal(classify(q).write, false, q);
  }
});

test('writes are writes', () => {
  for (const q of ['INSERT INTO t VALUES (1)', 'SELECT * INTO #x FROM t', 'EXEC dbo.usp_Recalculate', 'CREATE TABLE x (a int)', 'MERGE t USING s ON 1=1 WHEN MATCHED THEN DELETE;']) {
    assert.equal(classify(q).write, true, q);
  }
});

test('UPDATE and DELETE without WHERE are dangerous; with one they are not', () => {
  assert.deepEqual(classify('DELETE FROM dbo.Players').danger, ['DELETE with no WHERE changes every row of dbo.Players']);
  assert.deepEqual(classify('DELETE TOP (10) FROM [dbo].[Players]').danger, ['DELETE with no WHERE changes every row of [dbo].[Players]']);
  assert.deepEqual(classify('UPDATE p SET a = 1 FROM dbo.P p JOIN q ON q.id = p.id WHERE q.x = 1').danger, []);
  assert.deepEqual(classify('DELETE FROM t WHERE id = 1').danger, []);
  // A WHERE inside a subquery doesn't limit the UPDATE itself.
  assert.equal(classify('UPDATE t SET a = (SELECT MAX(b) FROM u WHERE u.id = 1)').danger.length, 1);
  assert.deepEqual(classify('UPDATE STATISTICS dbo.t').danger, []);
});

test('DROP and TRUNCATE are dangerous; module bodies are not checked', () => {
  assert.deepEqual(classify('DROP TABLE dbo.Old').danger, ['DROP TABLE dbo.Old']);
  assert.deepEqual(classify('TRUNCATE TABLE dbo.Log').danger, ['TRUNCATE removes every row of dbo.Log']);
  assert.deepEqual(classify('CREATE PROC p AS DELETE FROM t').danger, []);
  assert.equal(classify('CREATE PROC p AS DELETE FROM t').write, true);
  assert.deepEqual(classify('CREATE TABLE c (id int REFERENCES p(id) ON DELETE CASCADE)').danger, []);
});

test('classifyScript merges every statement', () => {
  const r = classifyScript('SELECT 1;\nDELETE FROM a;\nGO\nDROP VIEW v');
  assert.equal(r.write, true);
  assert.equal(r.danger.length, 2);
});

test('values are shown the way SQL tools show them', () => {
  assert.equal(formatValue(null), 'NULL');
  assert.equal(formatValue(true), '1');
  assert.equal(formatValue(new Date('2026-10-19T00:00:00Z')), '2026-10-19');
  assert.equal(formatValue(new Date('2026-10-19T15:14:35.120Z')), '2026-10-19 15:14:35.120');
  assert.equal(formatValue(Buffer.from([0xde, 0xad])), '0xDEAD');
  assert.equal(formatValue(42), '42');
});

test('CSV quotes what needs quoting and leaves NULL empty', () => {
  const set = { columns: [{ name: 'a' }, { name: 'b,c' }], rows: [[1, 'x "y"'], [null, 'two\nlines']] };
  assert.equal(toCsv(set), 'a,"b,c"\r\n1,"x ""y"""\r\n,"two\nlines"\r\n');
  assert.deepEqual(JSON.parse(toJson(set)), [{ a: 1, 'b,c': 'x "y"' }, { a: null, 'b,c': 'two\nlines' }]);
});

test('names and titles', () => {
  assert.equal(quoteIdent('a]b'), '[a]]b]');
  assert.equal(oneLine('SELECT *\n  FROM t'), 'SELECT * FROM t');
});

test('IF … ELSE and TRY … CATCH stay one statement', () => {
  const s = splitStatements('IF 1 = 1\nBEGIN\n  SELECT 1;\nEND\nELSE\nBEGIN\n  SELECT 2;\nEND\nBEGIN TRY\n  SELECT 3;\nEND TRY\nBEGIN CATCH\n  SELECT 4;\nEND CATCH\nSELECT 5');
  assert.deepEqual(texts(s), [
    'IF 1 = 1\nBEGIN\n  SELECT 1;\nEND\nELSE\nBEGIN\n  SELECT 2;\nEND',
    'BEGIN TRY\n  SELECT 3;\nEND TRY\nBEGIN CATCH\n  SELECT 4;\nEND CATCH',
    'SELECT 5',
  ]);
});

test('withoutLeadingComments starts at the first line of code', () => {
  assert.equal(withoutLeadingComments('-- one\n/* two\n */  SELECT 1 -- three'), 'SELECT 1 -- three');
  assert.equal(withoutLeadingComments('-- only a comment'), '');
});

test('countQuery counts what an UPDATE or DELETE would change, reading only', () => {
  assert.equal(countQuery('DELETE FROM dbo.Players WHERE Goals = 0;'), 'SELECT COUNT_BIG(*) FROM dbo.Players WHERE Goals = 0;');
  assert.equal(countQuery('delete dbo.Players where Goals = 0'), 'SELECT COUNT_BIG(*) FROM dbo.Players where Goals = 0;');
  assert.equal(countQuery('DELETE p FROM dbo.Players p JOIN dbo.Clubs c ON c.Id = p.ClubId WHERE c.Active = 0'), 'SELECT COUNT_BIG(*) FROM dbo.Players p JOIN dbo.Clubs c ON c.Id = p.ClubId WHERE c.Active = 0;');
  assert.equal(countQuery("UPDATE dbo.Clubs SET Name = 'x' WHERE Id = 1"), 'SELECT COUNT_BIG(*) FROM dbo.Clubs WHERE Id = 1;');
  assert.equal(countQuery('UPDATE dbo.Clubs SET Active = 0'), 'SELECT COUNT_BIG(*) FROM dbo.Clubs;');
  // A subquery's FROM and WHERE are its own.
  assert.equal(countQuery('UPDATE p SET Goals = (SELECT MAX(Goals) FROM dbo.Players WHERE 1 = 1) FROM dbo.Players p WHERE p.Id = 3'), 'SELECT COUNT_BIG(*) FROM dbo.Players p WHERE p.Id = 3;');
  assert.equal(countQuery('DELETE TOP (5) FROM dbo.Players'), null);
  assert.equal(countQuery('DELETE FROM dbo.Players OUTPUT deleted.Id WHERE 1 = 1'), null);
  assert.equal(countQuery('UPDATE a SET x = 1; UPDATE b SET y = 2'), null);
  assert.equal(countQuery('INSERT INTO t VALUES (1)'), null);
});

test('viewOrder filters and sorts a result set without touching its rows', () => {
  const set = { columns: [{ name: 'Name' }, { name: 'Goals' }], rows: [['Rui', 10], ['ana', null], ['Marta', 2], ['Iker', 10]] };
  assert.deepEqual(viewOrder(set), [0, 1, 2, 3]);
  assert.deepEqual(viewOrder(set, { sort: { col: 1, dir: 1 } }), [1, 2, 0, 3]);
  assert.deepEqual(viewOrder(set, { sort: { col: 1, dir: -1 } }), [0, 3, 2, 1]);
  assert.deepEqual(viewOrder(set, { sort: { col: 0, dir: 1 } }), [1, 3, 2, 0]);
  assert.deepEqual(viewOrder(set, { filter: 'A' }), [1, 2]);
  assert.deepEqual(viewOrder(set, { filter: '10', sort: { col: 0, dir: -1 } }), [0, 3]);
});
