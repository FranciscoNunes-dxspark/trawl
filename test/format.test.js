import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSql } from '../src/format.js';

test('each clause on its own line, the columns one a line, joins under FROM with ON under them, AND and OR indented', () => {
  const sql = 'select p.Name, c.Name from dbo.Players p left outer join dbo.Clubs c on c.Id = p.ClubId and c.Active = 1 where p.Goals > 0 or p.Shirt is null order by p.Goals desc;';
  assert.equal(
    formatSql(sql),
    [
      'SELECT',
      '  p.Name,',
      '  c.Name',
      'FROM dbo.Players p',
      '  LEFT OUTER JOIN dbo.Clubs c',
      '    ON c.Id = p.ClubId',
      '    AND c.Active = 1',
      'WHERE p.Goals > 0',
      '  OR p.Shirt IS NULL',
      'ORDER BY p.Goals DESC;',
    ].join('\n'),
  );
  // One column stays on the SELECT line.
  assert.equal(formatSql('select * from t cross apply f(t.x) y'), 'SELECT *\nFROM t\n  CROSS APPLY f(t.x) y');
});

test('subqueries are indented; commas in calls, OVER and CASE, and BETWEEN … AND, stay on the line', () => {
  const sql = `SELECT Name, CASE WHEN Goals > 5 THEN 'top' ELSE 'rest' END AS band, COUNT(*) OVER (PARTITION BY ClubId ORDER BY Goals) AS n
FROM dbo.Players WHERE Goals BETWEEN 1 AND 10 AND ClubId IN (select Id from dbo.Clubs c join dbo.Leagues l on l.Id = c.LeagueId where Active = 1)`;
  assert.equal(
    formatSql(sql),
    [
      'SELECT',
      '  Name,',
      "  CASE WHEN Goals > 5 THEN 'top' ELSE 'rest' END AS band,",
      '  COUNT(*) OVER (PARTITION BY ClubId ORDER BY Goals) AS n',
      'FROM dbo.Players',
      'WHERE Goals BETWEEN 1 AND 10',
      '  AND ClubId IN (',
      '  SELECT Id',
      '  FROM dbo.Clubs c',
      '    JOIN dbo.Leagues l',
      '      ON l.Id = c.LeagueId',
      '  WHERE Active = 1)',
    ].join('\n'),
  );
  assert.equal(formatSql('with x as (select a, b from t) select x.a from x'), ['WITH x AS (', '  SELECT', '    a,', '    b', '  FROM t)', 'SELECT x.a', 'FROM x'].join('\n'));
});

test('DISTINCT and TOP stay with SELECT, INTO gets a line, and a comment after a column stays with it', () => {
  assert.equal(formatSql('select distinct top (10) a, b, -- the second\n c into #t from t'), ['SELECT DISTINCT TOP (10)', '  a,', '  b, -- the second', '  c', 'INTO #t', 'FROM t'].join('\n'));
  assert.equal(formatSql('insert into dbo.T (a, b) select a, b from s'), ['INSERT INTO dbo.T (a, b)', 'SELECT', '  a,', '  b', 'FROM s'].join('\n'));
});

test('strings, comments, quoted names and the spacing inside expressions stay as they are', () => {
  const sql = "select [from], N'select x from y' as s, a=b -- where, not a clause\nfrom t /* join */ where x<>1";
  assert.equal(formatSql(sql), ['SELECT', '  [from],', "  N'select x from y' AS s,", '  a=b -- where, not a clause', 'FROM t /* join */', 'WHERE x<>1'].join('\n'));
  // A column named like a word SQL Server doesn't reserve keeps its case; dotted names too.
  assert.equal(formatSql('select rows, t.key from t'), 'SELECT\n  rows,\n  t.key\nFROM t');
});

test('UNION gets lines of its own; UPDATE puts its assignments under SET; non-queries are left alone', () => {
  assert.equal(formatSql('select 1 union all select 2'), 'SELECT 1\nUNION ALL\nSELECT 2');
  assert.equal(formatSql("update dbo.Clubs set Name = 'x' where Id = 1"), "UPDATE dbo.Clubs\nSET Name = 'x'\nWHERE Id = 1");
  assert.equal(formatSql("update dbo.Clubs set Name = 'x', Active = 0 where Id = 1"), "UPDATE dbo.Clubs\nSET\n  Name = 'x',\n  Active = 0\nWHERE Id = 1");
  assert.equal(formatSql('CREATE PROCEDURE p AS SELECT 1'), null);
  assert.equal(formatSql('IF 1 = 1 SELECT 1'), null);
  assert.equal(formatSql('SET NOCOUNT ON'), null);
});
