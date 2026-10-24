// /rehearse: a migration run inside a transaction that is always rolled back. The pure parts, then the
// real UI against the demo, in app.test.js's style.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { DEMO_CONNECTIONS } from '../src/connections.js';
import { DIALECTS } from '../src/dialects.js';
import { demoSession } from '../src/demo.js';
import { rehearsalRefusal, rehearsalSteps, rehearsalText, rowsAffected } from '../src/rehearse.js';
import { App } from '../src/ui/App.jsx';

const KEYS = { enter: '\r', esc: '\x1b' };

let base;
before(() => {
  base = mkdtempSync(join(tmpdir(), 'trawl-rehearse-'));
  process.env.TRAWL_HOME = join(base, 'home');
});
after(() => rmSync(base, { recursive: true, force: true }));

let lastApp = null;
async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${lastApp?.lastFrame()}`);
}
function start(connection = 'demo', props = {}) {
  const config = { connections: [...DEMO_CONNECTIONS], history: [], ran: [], limit: 500, last: null };
  lastApp = render(React.createElement(App, { config, initialConnection: connection, ...props }));
  return lastApp;
}
const type = async (stdin, text) => {
  for (const ch of text) {
    stdin.write(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
};
const frame = () => lastApp.lastFrame();
const command = async (app, text) => {
  app.stdin.write('/');
  await type(app.stdin, text);
  app.stdin.write(KEYS.enter);
};
// Every script a session runs, to see the rollback at the end.
function recording() {
  const ran = [];
  const sessions = [];
  const open = (conn, opts) => {
    const s = demoSession(conn, opts);
    const run = s.run;
    s.run = (script, o) => (ran.push(script), run(script, o));
    sessions.push(s);
    return s;
  };
  return { ran, sessions, open };
}

test('the steps: statements, GO batches when variables are declared, and the drivers\' statements', () => {
  const ss = DIALECTS.sqlserver;
  assert.deepEqual(rehearsalSteps('ALTER TABLE dbo.Players ADD Age int;\nUPDATE dbo.Players SET Age = 1 WHERE Id = 1;', ss).map((s) => s.line), [1, 2]);
  assert.deepEqual(rehearsalSteps('DECLARE @n int = 1;\nUPDATE dbo.Players SET Goals = @n;\nGO\nSELECT 1;', ss).map((s) => s.line), [1, 4]);
  assert.deepEqual(rehearsalSteps('ALTER TABLE t ADD c int;\nUPDATE t SET c = 1;', DIALECTS.postgres).map((s) => s.text), ['ALTER TABLE t ADD c int', 'UPDATE t SET c = 1']);
});

test('what can\'t be rehearsed: its own transactions, MySQL\'s DDL, what never runs inside a transaction', () => {
  const steps = (text, d) => rehearsalSteps(text, DIALECTS[d]);
  assert.equal(rehearsalRefusal(steps('ALTER TABLE t ADD c int;\nUPDATE t SET c = 1;', 'sqlserver'), DIALECTS.sqlserver), null);
  assert.match(rehearsalRefusal(steps('BEGIN TRAN;\nUPDATE t SET c = 1;\nCOMMIT;', 'sqlserver'), DIALECTS.sqlserver), /^Line 1 begins or ends a transaction itself \(BEGIN TRAN\)/);
  // A procedure's own transaction runs when it's called, not now; IF … BEGIN … END is a block.
  assert.equal(rehearsalRefusal(steps('CREATE PROCEDURE p AS\nBEGIN\n  BEGIN TRAN;\n  COMMIT;\nEND\nGO\nIF 1 = 1\nBEGIN\n  UPDATE t SET c = 1;\nEND', 'sqlserver'), DIALECTS.sqlserver), null);
  assert.match(rehearsalRefusal(steps('UPDATE t SET c = 1;\nCOMMIT;', 'postgres'), DIALECTS.postgres), /^Line 2 begins or ends/);
  assert.match(rehearsalRefusal(steps('UPDATE t SET c = 1;\nALTER TABLE t ADD d int;', 'mysql'), DIALECTS.mysql), /^Line 2 \(ALTER TABLE t\) can't be rehearsed on MySQL: MySQL commits a statement like it straight away/);
  assert.equal(rehearsalRefusal(steps('UPDATE t SET c = 1;\nINSERT INTO t VALUES (1);', 'mysql'), DIALECTS.mysql), null);
  assert.match(rehearsalRefusal(steps('CREATE INDEX CONCURRENTLY i ON t (c);', 'postgres'), DIALECTS.postgres), /can't run inside a transaction on PostgreSQL/);
  assert.match(rehearsalRefusal(steps('ALTER DATABASE x SET RECOVERY SIMPLE;', 'sqlserver'), DIALECTS.sqlserver), /can't run inside a transaction/);
  assert.equal(rowsAffected(['3 rows affected', 'Changed database context', '1 row affected']), 4);
  assert.equal(rowsAffected(['Commands completed successfully.']), null);
});

test('the report: each statement, the one that failed and those after it, and the locks', () => {
  const steps = [{ text: 'ALTER TABLE t ADD c int', line: 1 }, { text: '-- fill it\nUPDATE t SET c = 1', line: 2 }, { text: 'UPDATE nope SET c = 1', line: 4 }, { text: 'SELECT 1', line: 5 }];
  const text = rehearsalText({ steps, results: [{ step: steps[0], ms: 3 }, { step: steps[1], ms: 1500, rows: 12 }, { step: steps[2], ms: 1, error: "Invalid object name 'nope'." }], locks: ['dbo.t: X on 12 keys'], conn: 'dev', database: 'Shop', label: 'SQL Server', totalMs: 1504 });
  assert.match(text, /^Rehearsed on dev\/Shop \(SQL Server\), inside a transaction that was rolled back: nothing was kept\./);
  assert.match(text, /✓ line 1     3 ms  ALTER TABLE t ADD c int/);
  assert.match(text, /✓ line 2 +1\.5 s · 12 rows  UPDATE t SET c = 1/);
  assert.match(text, /✗ line 4  failed  UPDATE nope SET c = 1\n {6}Invalid object name 'nope'\./);
  assert.match(text, /1 more statement after it didn't run\./);
  assert.match(text, /2 of 4 statements ran in 1\.5 s, then one failed\./);
  assert.match(text, /Locks held at the end .*\n  dbo\.t: X on 12 keys/);
});

test('/rehearse runs the console in a transaction, reports each statement and the locks, and rolls back', async () => {
  const rec = recording();
  const app = start('demo', { open: rec.open });
  await until(() => frame().includes('Clubs'), 'the explorer');
  app.stdin.write('2');
  await until(() => frame().includes('Query'), 'the console');
  app.stdin.write('i');
  await until(() => frame().includes('typing SQL'), 'typing');
  await type(app.stdin, 'ALTER TABLE dbo.Players ADD Age int;\nUPDATE dbo.Players SET Goals = 0 WHERE Id = 1;');
  app.stdin.write(KEYS.esc);
  await new Promise((r) => setTimeout(r, 100));
  await command(app, 'rehearse');
  await until(() => frame().includes('Rehearsal: the console on demo'), 'the report');
  assert.match(frame(), /✓ line 1 .* ALTER TABLE dbo\.Players ADD Age int/);
  assert.match(frame(), /✓ line 2 .* · 1 row  UPDATE dbo\.Players SET Goals = 0 WHERE Id = 1/);
  assert.match(frame(), /dbo\.Players: X on 3 keys/);
  assert.equal(rec.ran.filter((x) => /^BEGIN TRANSACTION;$/.test(x)).length, 1);
  assert.equal(rec.ran.at(-1), 'ROLLBACK TRANSACTION;');
  assert.equal(rec.sessions.at(-1).tran, 0);
  assert.doesNotMatch(frame(), /TRANSACTION OPEN/);
  app.unmount();
});

test('/rehearse stops at the first error, and on production asks first, saying the locks are real', async () => {
  const dir = mkdtempSync(join(base, 'm-'));
  writeFileSync(join(dir, 'V3__fix.sql'), "UPDATE dbo.Players SET Goals = 1 WHERE Id = 2;\nRAISERROR('no such column', 16, 1);\nUPDATE dbo.Clubs SET Active = 1 WHERE Id = 1;\n");
  const rec = recording();
  const app = start('demo-prod', { open: rec.open });
  await until(() => frame().includes('Clubs'), 'the explorer');
  await command(app, `rehearse ${join(dir, 'V3__fix.sql')}`);
  await until(() => frame().includes('Rehearse V3__fix.sql on demo-prod (production)?'), 'the question');
  app.stdin.write('1');
  await until(() => frame().includes('Rehearsal: V3__fix.sql on demo-prod'), 'the report');
  assert.match(frame(), /✗ line 2 +failed/);
  assert.match(frame(), /no such column/);
  assert.match(frame(), /1 more statement after it didn't run\./);
  assert.equal(rec.ran.at(-1), 'ROLLBACK TRANSACTION;');
  assert.ok(!rec.ran.some((x) => x.includes('dbo.Clubs')), 'the statement after the error never ran');
  app.unmount();
});
