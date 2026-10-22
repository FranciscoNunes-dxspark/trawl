import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WARN_AFTER, dueWarning, locksText, minutesText, nextWarnMinutes, openFor, warnMinutes, warningTitle } from '../src/transactions.js';
import { whyConsoleText, whyPrompt } from '../src/ai.js';

test('the warning waits five minutes unless the config says otherwise, and 0 turns it off', () => {
  assert.equal(warnMinutes({}), WARN_AFTER);
  assert.equal(warnMinutes({ openTransactionWarning: 0 }), 0);
  assert.equal(warnMinutes({ openTransactionWarning: 0.5 }), 0.5);
  assert.equal(warnMinutes({ openTransactionWarning: -1 }), WARN_AFTER);
  assert.equal(warnMinutes({ openTransactionWarning: 'soon' }), WARN_AFTER);
  assert.deepEqual([5, 10, 15, 30, 60, 0, 1, 2].map(nextWarnMinutes), [10, 15, 30, 60, 0, 1, 2, 5]);
  assert.equal(nextWarnMinutes(7), 10);
  assert.equal(nextWarnMinutes(90), 0);
  assert.equal(minutesText(5), '5 min');
  assert.equal(minutesText(0.5), '30 s');
});

test('it is due once a transaction has sat idle that long, and only once', () => {
  assert.equal(dueWarning({ open: true, warned: false, idleMs: 300_000, minutes: 5 }), true);
  assert.equal(dueWarning({ open: true, warned: false, idleMs: 299_000, minutes: 5 }), false);
  assert.equal(dueWarning({ open: true, warned: true, idleMs: 900_000, minutes: 5 }), false);
  assert.equal(dueWarning({ open: false, warned: false, idleMs: 900_000, minutes: 5 }), false);
  assert.equal(dueWarning({ open: true, warned: false, idleMs: 900_000, minutes: 0 }), false);
});

test('how long it has been open, and what it holds', () => {
  assert.equal(openFor(59_000), '');
  assert.equal(openFor(7 * 60_000 + 5_000), '7m');
  assert.equal(openFor(65 * 60_000), '1h 5m');
  assert.equal(openFor(120 * 60_000), '2h');
  assert.equal(warningTitle({ conn: 'demo', openMs: 7 * 60_000, idleMs: 30_000 }), 'Transaction open on demo for 7m, idle under 1m: /commit or /rollback ends it.');
  const set = { columns: [], rows: [['dbo.Players', 'KEY', 'X', 3], ['dbo.Players', 'OBJECT', 'IX', 1], ['public.t', 'relation', 'RowExclusiveLock', 1], ['shop.orders', 'RECORD', 'X,REC_NOT_GAP', 2]] };
  assert.deepEqual(locksText([set]), ['dbo.Players: X on 3 keys, IX on the table', 'public.t: RowExclusiveLock on the table', 'shop.orders: X,REC_NOT_GAP on 2 records']);
  assert.match(locksText([{ columns: [], rows: [] }])[0], /no locks/);
});

test('/why tells Claude the error, the SQL with its lines numbered and the schema, never rows', () => {
  const schema = { objects: [{ schema: 'dbo', name: 'Players', kind: 'table', columns: [{ name: 'Id', type: 'int', pk: true }, { name: 'Goals', type: 'int' }] }] };
  const p = whyPrompt({ message: "Invalid column name 'Goalz'.", number: 207, line: 2, sql: 'SELECT Id,\n  Goalz\nFROM dbo.Players', database: 'ClubA', label: 'SQL Server', schema });
  assert.equal(p, "Database: ClubA (SQL Server)\n\nError 207, on line 2: Invalid column name 'Goalz'.\n\nSQL:\n  1 | SELECT Id,\n> 2 |   Goalz\n  3 | FROM dbo.Players\n\nSchema (schema.table(column type ...)):\ndbo.Players(Id int PK, Goals int)");
  // A long script: only the lines around the error.
  const long = Array.from({ length: 300 }, (_, i) => `SELECT ${i + 1};`).join('\n');
  const q = whyPrompt({ message: 'x', number: 1, line: 200, sql: long, database: 'D', schema: null });
  assert.match(q, /> 200 \| SELECT 200;/);
  assert.match(q, /\(lines 180 to 220 of 300\)/);
  assert.doesNotMatch(q, /SELECT 1;/);
  assert.match(q, /\(not loaded\)/);
  assert.match(whyPrompt({ message: 'm', number: null, line: null, sql: 'X', database: 'D', label: 'PostgreSQL' }), /^Database: D \(PostgreSQL\)\n\nError, with no line given: m/);
  assert.equal(whyConsoleText({ message: "Line 2: Invalid column name 'Goalz'.\nmore", sql: 'SELECT Goals FROM dbo.Players;', note: 'Goalz is a typo for Goals.' }), "-- Claude on the error: Line 2: Invalid column name 'Goalz'.\n-- Goalz is a typo for Goals.\nSELECT Goals FROM dbo.Players;");
});
