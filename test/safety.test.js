// End-to-end tests of undoing writes (/undo-write), /watch, the warning about a transaction left
// open, and /why, in app.test.js's style: the real UI against the demo connections, keys in, frames
// out. The helpers are copied from app.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { DEMO_CONNECTIONS } from '../src/connections.js';
import { demoSession } from '../src/demo.js';
import { App } from '../src/ui/App.jsx';

const KEYS = { down: '\x1b[B', up: '\x1b[A', enter: '\r', esc: '\x1b' };

let base;
before(() => {
  base = mkdtempSync(join(tmpdir(), 'trawl-'));
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

function start(connection = 'demo', props = {}, { connections = DEMO_CONNECTIONS.map((c) => ({ ...c })), ...config } = {}) {
  const full = { connections, history: [], ran: [], limit: 500, last: null, ...config };
  lastApp = render(React.createElement(App, { config: full, initialConnection: connection, ...props }));
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
  await type(app.stdin, text);
  app.stdin.write(KEYS.enter);
};

test('an UPDATE keeps a copy of its rows, and /undo-write puts the script that undoes it in the console tab undo', async () => {
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  await command(app, '!UPDATE dbo.Players SET Goals = 9, Shirt = 1 WHERE Id = 2');
  await until(() => frame().includes('Kept the row as it was: /undo-write puts it back.'), 'the copy kept');
  const dir = join(process.env.TRAWL_HOME, 'undo');
  assert.deepEqual(readdirSync(dir), ['conn-demo.json']);
  const kept = JSON.parse(readFileSync(join(dir, 'conn-demo.json'), 'utf8'));
  assert.equal(kept.length, 1);
  assert.deepEqual(kept[0].rows, [[2, 2, 'Ana Silva', 'DF', 8, 0]]);
  assert.ok(!readFileSync(join(process.env.TRAWL_HOME, 'config.json'), 'utf8').includes('Ana Silva'), 'never in config.json');
  await command(app, '/undo-write');
  await until(() => frame().includes('Undo a write on demo'), 'the list');
  assert.match(frame(), /❯ just now\s+UPDATE · 1 row · UPDATE dbo\.Pl/);
  assert.match(frame(), /│UPDATE dbo\.Players SET Goals = 9, Shirt = 1 WHERE Id/);
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('[2 undo]') && frame().includes('SET [Goals] = 0, [Shirt] = 8 WHERE [Id] = 2;'), 'the script in the undo tab');
  assert.match(frame(), /The script that undoes it is in the console tab undo/);
  // Nothing ran: the log's last run is still the UPDATE.
  assert.doesNotMatch(frame(), /UPDATE \[dbo\]\.\[Players\] SET \[Goals\] = 0, \[Shirt\] = 8 WHERE \[Id\] = 2;\s*\n\s*⎿/);
  app.unmount();
});

test('the question before a risky write says whether a copy is kept, and a DELETE goes back as INSERTs', async () => {
  rmSync(join(process.env.TRAWL_HOME, 'undo'), { recursive: true, force: true });
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  await command(app, '!DELETE p FROM dbo.Players p');
  await until(() => frame().includes('changes every row'), 'the question');
  assert.match(frame(), /No copy is kept for \/undo-write: it deletes through DELETE … FROM/);
  app.stdin.write('2');
  await until(() => !frame().includes('changes every row'), 'no');
  await command(app, '!DELETE FROM dbo.Clubs');
  await until(() => frame().includes('changes every row of dbo.Clubs'), 'the second question');
  assert.match(frame(), /that's 3 rows\. A copy of the rows is kept first: \/undo-write can put them back\./);
  app.stdin.write('1');
  await until(() => frame().includes('Kept the 3 rows as they were'), 'the copy');
  await command(app, '/undo-write');
  await until(() => frame().includes('DELETE · 3 rows'), 'the list');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('SET IDENTITY_INSERT [dbo].[Clubs] ON;'), 'the INSERT script');
  assert.match(frame(), /\(2, N'Atlético Norte', 'ES', '1921-09-01', 1\)/);
  app.unmount();
});

// A demo session whose Clubs change from one run to the next: the second club goes inactive on the
// second read, and the third is renamed Done on the third.
function changingClubs() {
  let reads = 0;
  return async (conn, opts) => {
    const s = demoSession(conn, opts);
    const run = s.run;
    s.run = async (sql, o) => {
      const res = await run(sql, o);
      if (!/^SELECT \* FROM dbo\.Clubs/.test(sql)) return res;
      reads++;
      const rows = res.sets[0].rows.map((r) => [...r]);
      if (reads >= 2) rows[1][4] = false;
      if (reads >= 3) rows[2][1] = 'Done';
      return { ...res, sets: [{ ...res.sets[0], rows }] };
    };
    return s;
  };
}

test('/watch runs a read again every few seconds, picks out what changed, and esc stops it', async () => {
  const app = start('demo', { open: changingClubs() });
  await until(() => frame().includes('Clubs'), 'the explorer');
  await command(app, '/watch 2 SELECT * FROM dbo.Clubs');
  await until(() => frame().includes('watching every 2s · run 1 · SELECT * FROM dbo.Clubs'), 'the first run');
  await until(() => frame().includes('watching every 2s · run 2'), 'the second run', 6000);
  // Clubs has a primary key, so the row is found again and only its Active cell changed.
  assert.match(frame(), /─ 3 rows · 1 changed ·/);
  assert.match(frame(), /watching every 2s · run 2 · esc stops/);
  app.stdin.write(KEYS.esc);
  await until(() => frame().includes('Stopped watching after 2 runs.'), 'stopped');
  assert.doesNotMatch(frame(), /watching every/);
  await new Promise((r) => setTimeout(r, 2300));
  assert.doesNotMatch(frame(), /run 3/);
  // Writes aren't watched.
  await command(app, '/watch 2 UPDATE dbo.Clubs SET Active = 1 WHERE Id = 1');
  await until(() => frame().includes('/watch only runs reads'), 'the refusal');
  app.unmount();
});

test('/watch --until stops and notifies when a row matches, and another run stops it too', async () => {
  const told = [];
  const app = start('demo', { open: changingClubs(), notify: (title, body) => told.push([title, body]) });
  await until(() => frame().includes('Clubs'), 'the explorer');
  await command(app, `/watch 2 SELECT * FROM dbo.Clubs --until "Name = 'Done'"`);
  await until(() => told.length === 1, 'the notification', 9000);
  assert.deepEqual(told[0], ["Trawl: Name = 'Done' on run 3, row 3", 'SELECT * FROM dbo.Clubs']);
  await until(() => frame().includes("Name = 'Done' on run 3, row 3: stopped watching."), 'the log line');
  assert.doesNotMatch(frame(), /watching every/);
  // Another run ends a watch.
  await command(app, '/watch 3 SELECT * FROM dbo.Matches');
  await until(() => frame().includes('watching every 3s · run 1'), 'the new watch');
  await command(app, '!SELECT 1 AS other');
  await until(() => frame().includes('Stopped watching after 1 run: another run.'), 'stopped by another run');
  await until(() => frame().includes('other'), 'the other run');
  app.unmount();
});

test('a transaction left open and idle is said once, with a notification and its locks, and the header shows it', async () => {
  const told = [];
  const app = start('demo', { notify: (title, body) => told.push([title, body]) }, { openTransactionWarning: 0.02 });
  await until(() => frame().includes('Clubs'), 'the explorer');
  await command(app, '!BEGIN TRANSACTION');
  await until(() => frame().includes('TRANSACTION OPEN'), 'the open transaction');
  await command(app, '!UPDATE dbo.Players SET Goals = 1 WHERE Id = 2');
  await until(() => told.length === 1, 'the notification', 6000);
  assert.equal(told[0][0], 'Trawl: a transaction is open on demo');
  await until(() => frame().includes('Transaction open on demo for under 1m, idle under 1m: /commit or /rollback ends it.'), 'the warning');
  assert.match(frame(), /dbo\.Players: X on 3 keys, IX on the table, IX on the page/);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(told.length, 1, 'once');
  await command(app, '/rollback');
  await until(() => !frame().includes('TRANSACTION OPEN'), 'the rollback');
  app.unmount();
});

test('/why asks Claude about the last error, with the SQL and the schema, and puts the fix in the console', async () => {
  const asked = [];
  const askClaude = async ({ prompt, system }) => (asked.push({ prompt, system }), 'There is no table Nope; the players are in dbo.Players.\n```sql\nSELECT * FROM dbo.Players;\n```');
  const app = start('demo', { askClaude });
  await until(() => frame().includes('Clubs'), 'the explorer');
  await command(app, '/why');
  await until(() => frame().includes('Nothing to explain'), 'nothing yet');
  await command(app, '!SELECT * FROM dbo.Nope');
  await until(() => frame().includes("Invalid object name 'dbo.Nope'"), 'the error');
  assert.match(frame(), /\/why asks Claude what went wrong, and for a fix\./);
  await command(app, '/why');
  await until(() => frame().includes('-- Claude on the error: Invalid object name'), 'the fix in the console');
  assert.match(frame(), /-- There is no table Nope; the players are in dbo\.Players\./);
  assert.match(frame(), /SELECT \* FROM dbo\.Players;/);
  assert.equal(asked.length, 1);
  assert.match(asked[0].prompt, /^Database: ClubA \(SQL Server\)\n\nError 208, on line 1: Invalid object name 'dbo\.Nope'\./);
  assert.match(asked[0].prompt, /> 1 \| SELECT \* FROM dbo\.Nope/);
  assert.match(asked[0].prompt, /dbo\.Players\(Id int PK/);
  assert.match(asked[0].system, /explain an error/);
  // Closed to Claude: refused, and the hint isn't offered.
  app.stdin.write(KEYS.esc);
  await until(() => !frame().includes('typing SQL'), 'typing stopped');
  await command(app, '/ai off');
  await until(() => frame().includes('Claude may now see nothing of demo'), 'off');
  await command(app, '!SELECT * FROM dbo.Nope');
  await until(() => frame().includes('Line 1') && !frame().includes('/why asks'), 'the error, without the hint');
  await command(app, '/why');
  await until(() => frame().includes('demo is closed to Claude'), 'the refusal');
  assert.equal(asked.length, 1);
  app.unmount();
});
