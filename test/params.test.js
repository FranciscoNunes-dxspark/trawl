import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySqlcmd, bindVariables, parameterLiteral, scriptVariables, sqlcmdVariables } from '../src/sql.js';

const names = (sql) => scriptVariables(sql).map((v) => v.name);

test('undeclared @variables are parameters, once each and ignoring case', () => {
  assert.deepEqual(names('SELECT * FROM dbo.Players WHERE Id = @id AND Name = @Name OR @ID IS NULL'), ['@id', '@Name']);
});

test('DECLAREd variables, @@functions, comments and strings are not', () => {
  assert.deepEqual(names('DECLARE @a int = @b, @c TABLE (x int); SELECT @a, @c, @d, @@ROWCOUNT'), ['@b', '@d']);
  assert.deepEqual(names("SELECT '@no', [@nor] -- @nope\n/* @never */"), []);
  assert.deepEqual(names('DECLARE @x int\nSET @x = 1\nSELECT @x'), []);
});

test('a declaration only counts in its own batch', () => {
  assert.deepEqual(names('DECLARE @x int = 1;\nGO\nSELECT @x'), ['@x']);
});

test("EXEC's argument names are the procedure's, but the values passed can be parameters", () => {
  assert.deepEqual(names('EXEC dbo.usp_RecalculateTable @Season = @year, @DryRun = 1'), ['@year']);
  assert.deepEqual(names('DECLARE @r int; EXEC @r = dbo.usp @Season = 2; SELECT @r'), []);
  assert.deepEqual(names("EXEC sp_executesql N'SELECT @p', N'@p int', @p = @value"), ['@value']);
});

test('a procedure, function, trigger or view keeps its parameters to itself', () => {
  assert.deepEqual(names('CREATE PROCEDURE dbo.p @x int AS SELECT @x'), []);
  assert.deepEqual(names('CREATE OR ALTER FUNCTION dbo.f (@x int) RETURNS int AS BEGIN RETURN @x END\nGO\nSELECT @y'), ['@y']);
});

test('values become literals: numbers and NULL as they are, text quoted', () => {
  assert.equal(parameterLiteral('42'), '42');
  assert.equal(parameterLiteral(' -1.5 '), '-1.5');
  assert.equal(parameterLiteral('null'), 'NULL');
  assert.equal(parameterLiteral("O'Neil"), "N'O''Neil'");
  assert.equal(parameterLiteral("'2026-01-01'"), "'2026-01-01'");
  assert.equal(parameterLiteral('0x0A'), '0x0A');
  assert.equal(bindVariables('SELECT * FROM t WHERE a = @a AND b = @B -- @a', new Map([['@A', '5'], ['@b', "O'Neil"]])), "SELECT * FROM t WHERE a = 5 AND b = N'O''Neil' -- @a");
});

test('sqlcmd: :setvar gives values, $(name) without one is asked for, and the lines become comments', () => {
  const script = ':setvar Env "prod"\nSELECT \'$(Env)\', $(Other), $(other)';
  const { defined, needed } = sqlcmdVariables(script);
  assert.equal(defined.get('env'), 'prod');
  assert.deepEqual(needed, ['Other']);
  assert.equal(applySqlcmd(script, new Map([['Other', '42']])), "-- :setvar Env \"prod\"\nSELECT 'prod', 42, 42");
});
