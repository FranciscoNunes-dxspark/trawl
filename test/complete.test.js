import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { accept, completeAt, ident, signatureAt, tablesIn } from '../src/complete.js';
import { demoSession } from '../src/demo.js';
import { SCHEMA_SQL, buildSchema } from '../src/schema.js';

let schema;
before(async () => {
  schema = buildSchema((await demoSession({ demo: true, name: 'demo' }).run(SCHEMA_SQL)).sets);
});

// The editor for `text` with the cursor where the | is.
const at = (text) => {
  const lines = text.split('\n');
  const row = lines.findIndex((l) => l.includes('|'));
  const col = lines[row].indexOf('|');
  lines[row] = lines[row].replace('|', '');
  return { lines, row, col };
};
const offered = (text, opts) => completeAt(at(text), schema, opts)?.items.map((i) => i.insert) ?? null;

test('after FROM and JOIN: tables and views, schema-qualified', () => {
  assert.deepEqual(offered('SELECT * FROM Cl|'), ['dbo.Clubs']);
  assert.deepEqual(offered('SELECT * FROM dbo.Clubs c JOIN pl|'), ['dbo.Players']);
  assert.deepEqual(offered('SELECT * FROM dbo.Clubs, Ma|'), ['dbo.Matches']);
  assert.deepEqual(offered('SELECT * FROM i18n.|'), ['Translations']);
  // A name that only contains the text comes after those that start with it.
  assert.deepEqual(offered('SELECT * FROM lat|'), ['i18n.Translations']);
});

test('after an alias or table and a dot: its columns', () => {
  assert.deepEqual(offered('SELECT p.| FROM dbo.Players p'), ['Id', 'ClubId', 'Name', 'Position', 'Shirt', 'Goals']);
  assert.deepEqual(offered('SELECT * FROM dbo.Players AS p WHERE p.Go|'), ['Goals']);
  assert.deepEqual(offered('SELECT Clubs.Fo| FROM dbo.Clubs'), ['Founded']);
  assert.deepEqual(offered('SELECT dbo.Clubs.Co| FROM dbo.Clubs'), ['Country']);
});

test('elsewhere: columns in scope first, with the alias when two tables share one', () => {
  const items = offered('SELECT Na| FROM dbo.Players p JOIN dbo.Clubs c ON c.Id = p.ClubId');
  assert.deepEqual(items.slice(0, 2), ['p.Name', 'c.Name']);
  assert.deepEqual(offered('SELECT Sh| FROM dbo.Players p JOIN dbo.Clubs c ON 1 = 1'), ['Shirt']);
  assert.ok(offered('SELECT * FROM dbo.Players WHERE Goals > 0 OR|').includes('ORDER'));
});

test('keywords follow the case being typed; functions come with their parenthesis', () => {
  assert.deepEqual(offered('sel|'), ['select']);
  assert.deepEqual(offered('SEL|'), ['SELECT']);
  assert.ok(offered('SELECT COU|').includes('COUNT('));
});

test('EXEC offers procedures, USE databases', () => {
  assert.deepEqual(offered('EXEC usp|'), ['dbo.usp_RecalculateTable']);
  assert.deepEqual(offered('USE Club|'), ['ClubA', 'ClubB']);
});

test('nothing in comments, strings or variables, or before anything is typed where it isn\'t clear', () => {
  assert.equal(offered("SELECT 'Cl|'"), null);
  assert.equal(offered('-- FROM Cl|'), null);
  assert.equal(offered('/* FROM Cl| */'), null);
  assert.equal(offered('SELECT @Cl|'), null);
  assert.deepEqual(offered('SELECT * FROM dbo.Clubs WHERE |'), []);
  // ctrl+n asks anyway.
  assert.ok(offered('SELECT * FROM dbo.Clubs WHERE |', { force: true }).includes('Name'));
  // After FROM, JOIN, EXEC or USE it's clear what comes next, so the list opens at once.
  assert.ok(offered('SELECT * FROM |').includes('dbo.Players'));
  assert.deepEqual(offered('EXEC |'), ['dbo.usp_RecalculateTable', 'dbo.', 'i18n.']);
  assert.deepEqual(offered('USE |'), ['master', 'ClubA', 'ClubB']);
  // Nothing to add when the only match is already there.
  assert.deepEqual(offered('SELECT * FROM dbo.Clubs|'), []);
});

test('a [name] being typed completes in brackets, and reads the scope past it', () => {
  assert.deepEqual(offered('SELECT [Na| FROM dbo.Clubs'), ['[Name]']);
  const e = at('SELECT [Na|] FROM dbo.Clubs');
  const c = completeAt(e, schema);
  assert.deepEqual(accept(e, c, c.items[0]), { lines: ['SELECT [Name] FROM dbo.Clubs'], row: 0, col: 13 });
});

test('accept replaces the word and leaves the cursor after it', () => {
  const e = at('SELECT *\nFROM Pl| p');
  const c = completeAt(e, schema);
  assert.deepEqual(accept(e, c, c.items[0]), { lines: ['SELECT *', 'FROM dbo.Players p'], row: 1, col: 16 });
});

test('tablesIn reads aliases, brackets, lists and hints', () => {
  const refs = tablesIn('SELECT * FROM dbo.Players AS p WITH (NOLOCK) JOIN [dbo].[Clubs] c ON 1 = 1 WHERE x = 1', schema);
  assert.deepEqual(refs.map((t) => [t.name, t.alias, t.object?.name]), [['dbo.Players', 'p', 'Players'], ['[dbo].[Clubs]', 'c', 'Clubs']]);
  const list = tablesIn('SELECT * FROM Clubs, #tmp t WHERE 1 = 1', schema);
  assert.deepEqual(list.map((t) => [t.name, t.alias, t.object?.name ?? null]), [['Clubs', null, 'Clubs'], ['#tmp', 't', null]]);
  assert.deepEqual(tablesIn('UPDATE dbo.Clubs SET Name = 1', schema).map((t) => t.alias), [null]);
});

test('ident brackets names that need it', () => {
  assert.equal(ident('Clubs'), 'Clubs');
  assert.equal(ident('Order'), '[Order]');
  assert.equal(ident('Line Items'), '[Line Items]');
});

test('after ON: the join condition, from the foreign keys to the tables before it', () => {
  assert.deepEqual(offered('SELECT * FROM dbo.Players p JOIN dbo.Clubs c ON |'), ['c.Id = p.ClubId']);
  assert.deepEqual(offered('SELECT * FROM dbo.Clubs c JOIN dbo.Players p ON |'), ['p.ClubId = c.Id']);
  // Typing the other alias first finds it as well, and the usual suggestions follow.
  assert.equal(offered('SELECT * FROM dbo.Players p JOIN dbo.Clubs c ON p|')[0], 'c.Id = p.ClubId');
  // Two keys to the same table: both, and only the table joined last counts.
  const sql = 'SELECT * FROM dbo.Clubs c\nJOIN dbo.Players p ON p.ClubId = c.Id\nJOIN dbo.Matches m ON |';
  assert.deepEqual(offered(sql), ['m.HomeId = c.Id', 'm.AwayId = c.Id']);
  // No key between them: nothing until a word is typed.
  assert.deepEqual(offered('SELECT * FROM i18n.Translations t JOIN dbo.Clubs c ON |'), []);
});

test('after SELECT *: the columns written out, qualified when there are several tables', () => {
  assert.deepEqual(offered('SELECT *| FROM dbo.Clubs'), ['Id, Name, Country, Founded, Active']);
  assert.deepEqual(offered('SELECT TOP (5) *| FROM dbo.Clubs c'), ['Id, Name, Country, Founded, Active']);
  assert.deepEqual(offered('SELECT c.*| FROM dbo.Clubs c JOIN dbo.Players p ON p.ClubId = c.Id'), ['c.Id, c.Name, c.Country, c.Founded, c.Active']);
  const both = offered('SELECT *| FROM dbo.Clubs c JOIN dbo.vTopScorers t ON 1 = 1')[0];
  assert.equal(both, 'c.Id, c.Name, c.Country, c.Founded, c.Active, t.Name, t.Goals');
  const e = at('SELECT p.*| FROM dbo.Players p');
  const c = completeAt(e, schema);
  assert.equal(accept(e, c, c.items[0]).lines[0], 'SELECT p.Id, p.ClubId, p.Name, p.Position, p.Shirt, p.Goals FROM dbo.Players p');
  // Not a multiplication, COUNT(*), a table Trawl doesn't know, or before there's a FROM.
  assert.deepEqual(offered('SELECT Goals *| 2 FROM dbo.Players'), []);
  assert.deepEqual(offered('SELECT COUNT(*| FROM dbo.Players'), []);
  assert.deepEqual(offered('SELECT *| FROM #tmp'), []);
  assert.deepEqual(offered('SELECT *|'), []);
});

test('after EXEC proc: the parameters not given yet, where the next argument starts', () => {
  assert.deepEqual(offered('EXEC dbo.usp_RecalculateTable |'), ['@Season = ', '@DryRun = ']);
  assert.deepEqual(offered('EXEC usp_RecalculateTable @Season = 2026, |'), ['@DryRun = ']);
  assert.deepEqual(offered('EXEC usp_RecalculateTable @Season = 2026, @D|'), ['@DryRun = ']);
  // Typing a value isn't the place for them.
  assert.deepEqual(offered('EXEC usp_RecalculateTable @Season = 20|'), []);
});

test('signatureAt: the syntax of the call the cursor is in, and which argument it is on', () => {
  const sig = (text) => {
    const s = signatureAt(at(text), schema);
    return s && `${s.name}(${s.params.map((p) => p.text).join(', ')}) @${s.index}`;
  };
  assert.equal(sig('SELECT DATEADD(|'), 'DATEADD(datepart, number, date) @0');
  assert.equal(sig("SELECT dateadd(day, 3, |"), 'DATEADD(datepart, number, date) @2');
  // Commas inside an inner call or a string don't count; the inner call wins while inside it.
  assert.equal(sig("SELECT ISNULL(LEFT(Name, 3), 'a,b|"), 'ISNULL(check_expression, replacement_value) @1');
  assert.equal(sig('SELECT ISNULL(LEFT(Name, |'), 'LEFT(character_expression, integer_expression) @1');
  assert.equal(sig('SELECT ISNULL((Goals + 1), |'), 'ISNULL(check_expression, replacement_value) @1');
  assert.equal(sig('SELECT ISNULL(Goals, 0)|'), null);
  assert.equal(sig('SELECT Name FROM t WHERE Id IN (|'), null);
  // A procedure's parameters come from the schema.
  assert.equal(sig('EXEC dbo.usp_RecalculateTable @Season = 1, |'), 'dbo.usp_RecalculateTable(@Season int, @DryRun bit) @1');
  const opt = signatureAt(at('SELECT CONVERT(|'), schema).params;
  assert.deepEqual(opt.map((p) => p.optional), [false, false, true]);
});
