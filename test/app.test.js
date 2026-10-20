// Drives the real UI against the demo connections: keys in, frames out.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { DEMO_CONNECTIONS } from '../src/connections.js';
import { memoryCredentials } from '../src/credentials.js';
import { DbError, untrustedCert } from '../src/db.js';
import { demoSession } from '../src/demo.js';
import { setAccent } from '../src/theme.js';
import { App } from '../src/ui/App.jsx';

const KEYS = { down: '\x1b[B', enter: '\r', esc: '\x1b' };

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
    // Once it shows, give the new view's key handlers a moment to subscribe, as a person would.
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

test('connects to the demo and lists its tables', async () => {
  const app = start();
  await until(() => frame().includes('Translations'), 'the explorer');
  assert.match(frame(), /demo\/ClubA/);
  assert.match(frame(), /i18n/);
  app.unmount();
});

test('↵ on a table shows its first rows', async () => {
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('Club A FC'), 'the rows of Clubs');
  assert.match(frame(), /SELECT TOP \(500\) \* FROM \[dbo\]\.\[Clubs\]/);
  assert.match(frame(), /3 rows/);
  app.unmount();
});

test('SQL at the prompt runs, and an error says where', async () => {
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  await type(app.stdin, '!SELECT * FROM dbo.Nope');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes("Invalid object name 'dbo.Nope'"), 'the error');
  assert.match(frame(), /Line 1/);
  app.unmount();
});

test('DELETE with no WHERE asks first, and No leaves it', async () => {
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  await type(app.stdin, '!DELETE FROM dbo.Players');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('changes every row of dbo.Players'), 'the confirmation');
  app.stdin.write('2');
  await new Promise((r) => setTimeout(r, 200));
  assert.doesNotMatch(frame(), /rows affected/);
  app.unmount();
});

test('production refuses writes until /writes, then opens a transaction', async () => {
  const app = start('demo-prod');
  await until(() => frame().includes('PROD') && frame().includes('Clubs'), 'the production connection');
  await type(app.stdin, '!UPDATE dbo.Players SET Goals = 0 WHERE Id = 1');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('is read-only (production)'), 'the refusal');
  await type(app.stdin, '/writes');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('Allow writes on demo-prod'), 'the writes confirmation');
  app.stdin.write('1');
  await until(() => frame().includes('writes allowed'), 'writes allowed');
  await type(app.stdin, '!UPDATE dbo.Players SET Goals = 0 WHERE Id = 1');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('TRANSACTION OPEN'), 'the open transaction');
  await type(app.stdin, '/rollback');
  app.stdin.write(KEYS.enter);
  await until(() => !frame().includes('TRANSACTION OPEN'), 'the rollback');
  app.unmount();
});

test('/tx manual: a write opens a transaction to /commit or /rollback, as DataGrip’s Tx: Manual', async () => {
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  await type(app.stdin, '/tx manual');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('demo now commits manually') && frame().includes('manual commit'), 'manual mode in the header');
  await type(app.stdin, '!UPDATE dbo.Players SET Goals = 0 WHERE Id = 1');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('TRANSACTION OPEN') && frame().includes('demo commits manually'), 'the open transaction');
  await type(app.stdin, '/tx auto');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('A transaction is open: /commit or /rollback it first.'), 'the refusal');
  await type(app.stdin, '/rollback');
  app.stdin.write(KEYS.enter);
  await until(() => !frame().includes('TRANSACTION OPEN'), 'the rollback');
  // Back to auto (the demo's connections are shared by every test in this file).
  await type(app.stdin, '/tx auto');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('demo now commits each statement as it runs') && !frame().includes('manual commit'), 'auto again');
  app.unmount();
});

test('esc cancels a running query', async () => {
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  await type(app.stdin, "!WAITFOR DELAY '00:00:30'");
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('esc to cancel'), 'the spinner');
  app.stdin.write(KEYS.esc);
  await until(() => frame().includes('Cancelled'), 'the cancellation');
  app.unmount();
});

test('a script lists its statements, runs one, and reloads when saved', async () => {
  const path = join(base, 'q.sql');
  writeFileSync(path, '-- players\nSELECT * FROM dbo.Players;\n\nSELECT 42 AS answer\n');
  const app = start('demo', { initialFile: path });
  await until(() => frame().includes('2 statements') && frame().includes('Clubs') === false, 'the query view');
  app.stdin.write(KEYS.down);
  await new Promise((r) => setTimeout(r, 100));
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('answer') && frame().includes('42'), 'the result');
  writeFileSync(path, readFileSync(path, 'utf8') + '\nSELECT 1 AS one\n');
  app.stdin.write('2');
  await until(() => frame().includes('3 statements'), 'the reload', 5000);
  app.unmount();
});

test('/export writes the result set as CSV', async () => {
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('Club A FC'), 'the rows');
  const out = join(base, 'clubs.csv');
  await type(app.stdin, `/export ${out}`);
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('Wrote 3 rows'), 'the export');
  assert.match(readFileSync(out, 'utf8'), /^Id,Name,Country,Founded,Active\r\n1,Club A FC,PT,1904-03-14,1\r\n/);
  app.unmount();
});

test('a newer release shows in the header and the activity log, once a day', async () => {
  let calls = 0;
  const checkLatest = async () => (calls++, { version: '9.0.0', url: 'https://example.test/r', download: null });
  const app = start('demo', { checkLatest });
  await until(() => frame().includes('Trawl 9.0.0 is out') && frame().includes('↑ 9.0.0'), 'the update notice');
  app.unmount();
  // The answer was remembered: the next start shows it again without asking GitHub.
  const config = JSON.parse(readFileSync(join(process.env.TRAWL_HOME, 'config.json'), 'utf8'));
  assert.equal(config.updateCheck.latest.version, '9.0.0');
  lastApp = render(React.createElement(App, { config: { ...config, connections: [...DEMO_CONNECTIONS] }, initialConnection: 'demo', checkLatest }));
  await until(() => frame().includes('↑ 9.0.0'), 'the remembered notice');
  assert.equal(calls, 1);
  lastApp.unmount();
});

test('the downloaded Trawl installs a newer release in the background, says when it can’t, and can be told only to tell', async () => {
  const checkLatest = async () => ({ version: '9.0.0', url: 'https://example.test/r', download: null, signedIn: true });
  const fresh = { updateCheck: null };
  const asked = [];
  let app = start('demo', { checkLatest, installUpdate: async (v) => void asked.push(v) });
  await until(() => frame().includes('Trawl 9.0.0 is installed') && frame().includes('↑ 9.0.0 at next start'), 'the installed note');
  assert.deepEqual(asked, ['9.0.0']);
  app.unmount();

  const config = (extra) => ({ connections: [...DEMO_CONNECTIONS], history: [], ran: [], limit: 500, last: null, ...fresh, ...extra });
  lastApp = render(React.createElement(App, { config: config(), initialConnection: 'demo', checkLatest, installUpdate: async () => {
    throw new Error("EACCES: can't write to C:\\Program Files\\Trawl\nmore detail");
  } }));
  await until(() => frame().includes("couldn't be installed: EACCES") && frame().includes('↑ 9.0.0'), 'the failure');
  assert.doesNotMatch(frame(), /more detail/);
  lastApp.unmount();

  // Only told; /update still installs, since you asked.
  const told = [];
  lastApp = render(React.createElement(App, { config: config({ autoUpdate: false }), initialConnection: 'demo', checkLatest, installUpdate: async (v) => void told.push(v) }));
  await until(() => frame().includes('Trawl 9.0.0 is out') && frame().includes('Clubs'), 'the notice');
  assert.deepEqual(told, []);
  await type(lastApp.stdin, '/update');
  lastApp.stdin.write(KEYS.enter);
  await until(() => frame().includes('install Trawl 9.0.0') && frame().includes('It starts the next time you open Trawl'), 'the install');
  assert.deepEqual(told, ['9.0.0']);
  lastApp.unmount();
});

test('Settings, an overlay, changes the row limit, the accent and updates, and keeps them in the config', async () => {
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  app.stdin.write(',');
  await until(() => frame().includes('Row limit') && frame().includes('500 rows'), 'Settings');
  assert.match(frame(), /1 Explorer .* 5 Connections\s*$/m, 'no tab of its own');
  assert.match(frame(), /Check for updates\s+on\s+\(not in a checkout\)/);
  // ↵ on the row limit hands it to /limit, and Settings is still open after.
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('/limit '), 'the /limit prompt');
  await type(app.stdin, '200');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('200 rows') && frame().includes('Row limit'), 'the new limit');
  // The accent goes to the next colour at once.
  app.stdin.write('j');
  await until(() => frame().includes('Accent colour') && frame().includes('↵ next colour'), 'the accent row');
  app.stdin.write(' ');
  await until(() => /Accent colour\s+██ teal/.test(frame()), 'teal');
  // Updates: installing off first, then checking.
  app.stdin.write('j');
  app.stdin.write('j');
  await until(() => frame().includes('Off, Trawl only says one is out'), 'the install row');
  app.stdin.write(KEYS.enter);
  await until(() => /Install updates\s+off/.test(frame()), 'installing off');
  app.stdin.write('k');
  await until(() => frame().includes('Once a day, Trawl asks GitHub'), 'the check row');
  app.stdin.write(KEYS.enter);
  await until(() => /Check for updates\s+off/.test(frame()) && frame().includes('(checks are off)'), 'checks off');
  const config = JSON.parse(readFileSync(join(process.env.TRAWL_HOME, 'config.json'), 'utf8'));
  assert.equal(config.limit, 200);
  assert.equal(config.accent, '#5fd7d7');
  assert.equal(config.autoUpdate, false);
  assert.equal(config.checkUpdates, false);
  // q closes it, and only it: Trawl keeps running.
  app.stdin.write('q');
  await until(() => frame().includes('Clubs') && !frame().includes('Row limit'), 'the explorer again');
  app.stdin.write(KEYS.down);
  await until(() => frame().includes('Clubs'), 'still running');
  app.stdin.write('/');
  await type(app.stdin, 'settings');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('Row limit'), 'Settings from /settings');
  app.stdin.write(KEYS.esc);
  await until(() => !frame().includes('Row limit'), 'closed with esc');
  app.unmount();
  setAccent('#5fafff');
});

test('the console: type SQL, ctrl+r runs it with the results underneath, and it is kept', async () => {
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  app.stdin.write('2');
  await until(() => frame().includes('An empty console'), 'the empty console');
  app.stdin.write('i');
  await until(() => frame().includes('typing SQL'), 'typing mode');
  // Digits and q are text while typing, not views or quit.
  await type(app.stdin, 'SELECT 1 AS q2');
  app.stdin.write(KEYS.enter);
  app.stdin.write(KEYS.enter);
  await type(app.stdin, 'SELECT TOP (2) * FROM dbo.Clubs');
  app.stdin.write('\x12'); // ctrl+r: only the statement under the cursor runs
  await until(() => frame().includes('Club A FC') && frame().includes('Console') && frame().includes('─ SELECT TOP (2) * FROM dbo.Clubs ─'), 'the results under the console');
  app.stdin.write(KEYS.esc);
  await until(() => frame().includes('↵/i type'), 'out of typing mode');
  app.stdin.write('k');
  app.stdin.write('k');
  await new Promise((r) => setTimeout(r, 100));
  app.stdin.write('\x12');
  await until(() => frame().includes('SELECT 1 AS q2') && frame().includes('1 row'), 'the first statement run');
  app.unmount();
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(readFileSync(join(process.env.TRAWL_HOME, 'console.sql'), 'utf8'), 'SELECT 1 AS q2\n\nSELECT TOP (2) * FROM dbo.Clubs');
  // A new start finds it again.
  const again = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  again.stdin.write('2');
  await until(() => frame().includes('SELECT TOP (2) * FROM dbo.Clubs'), 'the kept console');
  again.unmount();
});

test('the console suggests tables and columns as you type; tab takes one, esc only closes the list', async () => {
  mkdirSync(process.env.TRAWL_HOME, { recursive: true });
  writeFileSync(join(process.env.TRAWL_HOME, 'console.sql'), '');
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  app.stdin.write('2');
  await until(() => frame().includes('An empty console'), 'the empty console');
  app.stdin.write('i');
  await until(() => frame().includes('typing SQL'), 'typing mode');
  await type(app.stdin, 'SELECT * FROM Pl');
  await until(() => frame().includes('dbo · table') && frame().includes('tab take it'), 'the suggestion');
  app.stdin.write('\t');
  await until(() => frame().includes('FROM dbo.Players') && !frame().includes('dbo · table'), 'the table taken');
  await type(app.stdin, ' p WHERE p.Go');
  await until(() => frame().includes('int · Players'), 'the column suggested');
  app.stdin.write(KEYS.esc);
  await until(() => !frame().includes('int · Players'), 'the list closed');
  assert.match(frame(), /typing SQL/);
  app.stdin.write('\x00'); // ctrl+space brings it back
  await until(() => frame().includes('int · Players'), 'the list again');
  app.stdin.write('\t');
  await until(() => frame().includes('WHERE p.Goals'), 'the column taken');
  app.unmount();
});

test('ctrl+z undoes in the console a word at a time, ctrl+y redoes, and /new can be undone', async () => {
  mkdirSync(process.env.TRAWL_HOME, { recursive: true });
  writeFileSync(join(process.env.TRAWL_HOME, 'console.sql'), '');
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  app.stdin.write('2');
  await until(() => frame().includes('An empty console'), 'the empty console');
  app.stdin.write('i');
  await until(() => frame().includes('typing SQL'), 'typing mode');
  await type(app.stdin, 'SELECT 42');
  await until(() => frame().includes('1 SELECT 42'), 'the text');
  app.stdin.write('\x1a'); // ctrl+z
  await until(() => frame().includes('1 SELECT ') && !frame().includes('SELECT 42'), 'the last word undone');
  app.stdin.write('\x19'); // ctrl+y
  await until(() => frame().includes('1 SELECT 42'), 'redone');
  app.stdin.write(KEYS.esc);
  await until(() => frame().includes('↵/i type'), 'out of typing mode');
  await type(app.stdin, '/new');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('Clear the console?'), 'the question');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('typing SQL') && !frame().includes('SELECT 42'), 'a clear console');
  app.stdin.write('\x1a');
  await until(() => frame().includes('1 SELECT 42'), '/new undone');
  app.unmount();
});

test('shift+arrows select in the console, and ctrl+r runs just the selection', async () => {
  mkdirSync(process.env.TRAWL_HOME, { recursive: true });
  writeFileSync(join(process.env.TRAWL_HOME, 'console.sql'), 'SELECT 1 AS one, 2 AS two');
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  app.stdin.write('2');
  await until(() => frame().includes('SELECT 1 AS one'), 'the console');
  app.stdin.write('i');
  await until(() => frame().includes('typing SQL'), 'typing mode');
  // To the end of "one", then select back to the start of the line.
  for (let k = 0; k < 4; k++) app.stdin.write('\x1b[1;5C'); // ctrl+→
  await new Promise((r) => setTimeout(r, 50));
  app.stdin.write('\x1b[1;2H'); // shift+home
  await until(() => frame().includes('ctrl+r runs just this'), 'the selection');
  app.stdin.write('\x12');
  await until(() => frame().includes('─ SELECT 1 AS one ─'), 'only the selection run');
  assert.doesNotMatch(frame(), /one\s+│ two/);
  app.stdin.write(KEYS.esc);
  await until(() => frame().includes('typing · ctrl+space'), 'the selection let go');
  app.unmount();
});

test('e in History puts the statement in the console to edit', async () => {
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  await type(app.stdin, '!SELECT 7 AS seven');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('seven'), 'the result');
  app.stdin.write('4');
  await until(() => frame().includes('╭─ History'), 'history');
  app.stdin.write('e');
  await until(() => frame().includes('typing SQL') && /│\s*▌?\s*\d+ SELECT 7 AS seven/.test(frame()), 'the statement in the console');
  app.unmount();
});

test('/ask puts Claude’s query in the console and runs nothing', async () => {
  const prompts = [];
  const askClaude = async ({ prompt }) => {
    prompts.push(prompt);
    return 'Top three by goals:\n```sql\nSELECT TOP (3) Name, Goals\nFROM dbo.Players\nORDER BY Goals DESC;\n```';
  };
  const app = start('demo', { askClaude });
  await until(() => frame().includes('Clubs'), 'the explorer');
  await type(app.stdin, '/ask who scores the most');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('-- Asked Claude: who scores the most') && frame().includes('ORDER BY Goals DESC;'), 'the query in the console');
  assert.match(frame(), /The query is in the console/);
  assert.match(prompts[0], /dbo\.Players\(Id int PK/);
  assert.match(prompts[0], /Question: who scores the most/);
  // The activity bullet is ● on Windows and ⏺ elsewhere (theme.js BULLET).
  assert.doesNotMatch(frame(), /[●⏺] SELECT TOP \(3\) Name/, 'nothing ran');
  app.stdin.write('\x12');
  await until(() => /[●⏺] SELECT TOP \(3\) Name, Goals FROM dbo\.Players ORDER BY Goals DESC;/.test(frame()) && frame().includes('3 rows'), 'the run after ctrl+r');
  app.unmount();
});

test('/ask is refused on a connection closed to Claude', async () => {
  const app = start('demo');
  await until(() => frame().includes('Clubs'), 'the explorer');
  await type(app.stdin, '/ai off');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('Claude may now see nothing of demo'), 'the level change');
  await type(app.stdin, '/ask anything');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('demo is closed to Claude'), 'the refusal');
  app.unmount();
});

test('/import datagrip previews, asks, then adds the connections', async () => {
  const findDataSources = () => [
    { uuid: '1', name: 'FUNDS', group: 'PROD', url: 'jdbc:sqlserver://funds.database.windows.net;database=fundsdb', user: 'fundsapp' },
    { uuid: '2', name: 'pg', driver: 'postgresql', url: 'jdbc:postgresql://x/db' },
  ];
  const app = start('demo', { findDataSources });
  await until(() => frame().includes('Clubs'), 'the explorer');
  await type(app.stdin, '/import datagrip');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('Will add 1 connection') && frame().includes('Add 1 connection from DataGrip?'), 'the preview and question');
  assert.match(frame(), /funds +funds\.database\.windows\.net\/fundsdb {2}PROD/);
  assert.match(frame(), /postgresql isn't supported yet/);
  app.stdin.write('1');
  await until(() => frame().includes('Added 1 connection from DataGrip') && frame().includes('▾ PROD/'), 'the added connection, in its folder');
  const saved = JSON.parse(readFileSync(join(process.env.TRAWL_HOME, 'config.json'), 'utf8'));
  const funds = saved.connections.find((c) => c.name === 'funds');
  assert.equal(funds.folder, 'PROD');
  assert.equal(funds.passwordEnv, undefined, 'the password is asked for, not read from a variable');
  app.unmount();
});

test('Results: edit a cell, delete a row, see the script, save', async () => {
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('Club A FC'), 'the rows of Clubs');
  app.stdin.write('e');
  await until(() => frame().includes('Id is an identity column'), 'the refusal on the identity key');
  app.stdin.write('l');
  await new Promise((r) => setTimeout(r, 50));
  app.stdin.write('e');
  await until(() => frame().includes('editing the cell'), 'typing in the cell');
  app.stdin.write('\x15'); // ctrl+u clears it; digits and q are text here
  await type(app.stdin, 'Club Q1');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('1 edited row not saved'), 'the staged change');
  assert.match(frame(), /Club Q1/);
  app.stdin.write(KEYS.down);
  await new Promise((r) => setTimeout(r, 50));
  app.stdin.write('d');
  await until(() => frame().includes('1 edited row and 1 deletion not saved'), 'the staged deletion');
  app.stdin.write('s');
  await until(() => frame().includes('Save 1 edited row and 1 deletion to dbo.Clubs on demo?'), 'the question');
  assert.match(frame(), /UPDATE \[dbo\]\.\[Clubs\] SET \[Name\] = N'Club Q1' WHERE \[Id\] = 1 AND \[Name\] = N'Club A FC';/);
  assert.match(frame(), /DELETE FROM \[dbo\]\.\[Clubs\] WHERE \[Id\] = 2;/);
  app.stdin.write('1');
  await until(() => frame().includes('save 1 edited row and 1 deletion to dbo.Clubs') && frame().includes('2 rows'), 'saved, with the grid updated');
  assert.match(frame(), /Club Q1/);
  assert.doesNotMatch(frame(), /Atlético Norte/);
  assert.doesNotMatch(frame(), /not saved/);
  app.unmount();
});

test('Results: rows that aren’t one table’s say why they can’t be edited', async () => {
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  await type(app.stdin, '!SELECT ClubId, COUNT(*) AS n FROM dbo.Players GROUP BY ClubId');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('12 rows ·'), 'the results');
  app.stdin.write('e');
  await until(() => frame().includes("These rows can't be edited: it isn’t the rows of one table"), 'the reason');
  app.unmount();
});

test('importing again files the connections Trawl already has into their DataGrip folders', async () => {
  const findDataSources = () => [{ uuid: '1', name: 'FUNDS', group: 'PROD', url: 'jdbc:sqlserver://funds.database.windows.net;database=fundsdb', user: 'fundsapp' }];
  const old = { name: 'funds', server: 'funds.database.windows.net', database: 'fundsdb', auth: 'sql', user: 'fundsapp', passwordEnv: 'TRAWL_PW_FUNDS', prod: true };
  const config = { connections: [old, ...DEMO_CONNECTIONS], history: [], ran: [], limit: 500, last: null };
  const app = (lastApp = render(React.createElement(App, { config, findDataSources })));
  await until(() => frame().includes('Connections'), 'the connections');
  await type(app.stdin, '/import datagrip');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes("Put 1 connection into DataGrip's folders?"), 'the question');
  app.stdin.write('1');
  await until(() => frame().includes("Filed 1 connection in DataGrip's folders") && frame().includes('▾ PROD/'), 'the folder');
  const saved = JSON.parse(readFileSync(join(process.env.TRAWL_HOME, 'config.json'), 'utf8')).connections.find((c) => c.name === 'funds');
  assert.equal(saved.folder, 'PROD');
  assert.equal(saved.passwordEnv, undefined, 'the unset variable an earlier import named gives way to the credential store');
  app.unmount();
});

// A SQL login on a pretend server: the password "right" signs in, to the demo's data.
const LOGIN = { name: 'club-sql', server: 'srv', database: 'ClubA', auth: 'sql', user: 'sa' };
const fakeOpen = async (conn, { database, password, credentials }) => {
  if (conn.demo) return demoSession(conn, { database });
  const pw = password ?? (await credentials.get(conn.name));
  if (pw == null) throw new DbError('No password saved.', { needsPassword: true });
  if (pw !== 'right') throw new DbError("Login failed for user 'sa'.", { needsPassword: true });
  return demoSession({ ...conn, demo: true }, { database });
};
const startWith = (connections, props) => {
  const config = { connections, history: [], ran: [], limit: 500, last: null };
  lastApp = render(React.createElement(App, { config, ...props }));
  return lastApp;
};

test('a login asks for its password, again when it is wrong, and keeps the one that works', async () => {
  const credentials = memoryCredentials();
  const app = startWith([LOGIN], { initialConnection: 'club-sql', open: fakeOpen, credentials });
  await until(() => frame().includes('Password for sa on club-sql'), 'the password prompt');
  assert.match(frame(), /\[x\] Keep it in memory/);
  await type(app.stdin, 'nope42');
  assert.match(frame(), /> \*{6} /);
  assert.doesNotMatch(frame(), /nope42/, 'what is typed never shows');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('Login failed. Password for sa on club-sql'), 'the second try');
  assert.equal(credentials.saved.size, 0, 'a turned-down password is not kept');
  await type(app.stdin, 'right');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('Clubs') && frame().includes('Saved the password for club-sql in memory'), 'connected, and the password kept');
  assert.equal(credentials.saved.get('club-sql'), 'right');
  app.unmount();
  // Next time the saved one is used without asking.
  startWith([LOGIN], { initialConnection: 'club-sql', open: fakeOpen, credentials });
  await until(() => frame().includes('Clubs'), 'the explorer, with no prompt');
  assert.doesNotMatch(frame(), /Password for/);
  lastApp.unmount();
});

test('a certificate that can’t be verified asks to trust it, and the trust is kept on the connection', async () => {
  // Node's and Bun's wordings, and the TLS code under tedious's message; anything else isn't one.
  assert.equal(untrustedCert(new Error('Failed to connect to localhost:1433 - self signed certificate')), true);
  assert.equal(untrustedCert({ message: 'Failed to connect', cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT', message: 'x' } }), true);
  assert.equal(untrustedCert(new Error("Login failed for user 'sa'.")), false);

  const LOCAL = { name: 'local', server: 'localhost', database: 'ClubA', auth: 'sql', user: 'sa' };
  const credentials = memoryCredentials();
  const message = 'Failed to connect to localhost:1433 - self signed certificate';
  const open = async (conn, opts) => {
    // As db.connect: the password is found first, then the TLS handshake turns the certificate down.
    const pw = opts.password ?? (await opts.credentials.get(conn.name));
    if (pw != null && !conn.trustCert) throw new DbError(message, { untrustedCert: untrustedCert(new Error(message)) });
    return fakeOpen(conn, opts);
  };
  const app = startWith([LOCAL], { initialConnection: 'local', open, credentials });
  await until(() => frame().includes('Password for sa on local'), 'the password prompt');
  await type(app.stdin, 'right');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes("certificate can't be verified. Trust it?"), 'the trust question');
  app.stdin.write('1');
  // The typed password carries over: no second prompt, and it's kept once it signs in.
  await until(() => frame().includes('Clubs') && frame().includes('Saved the password for local'), 'connected');
  assert.equal(credentials.saved.get('local'), 'right');
  const saved = JSON.parse(readFileSync(join(process.env.TRAWL_HOME, 'config.json'), 'utf8'));
  assert.equal(saved.connections.find((c) => c.name === 'local').trustCert, true);
  app.unmount();

  // No leaves it as it was, and not connected.
  const again = startWith([LOCAL], { initialConnection: 'local', open, credentials: memoryCredentials({ local: 'right' }) });
  await until(() => frame().includes('Trust it?'), 'the trust question again');
  again.stdin.write('2');
  await until(() => !frame().includes('Trust it?') && frame().includes('self signed certificate'), 'declined');
  assert.match(frame(), /Trawl\s+not connected/);
  again.unmount();
});

test('tab leaves the password out of the store; esc cancels', async () => {
  const credentials = memoryCredentials();
  const app = startWith([LOGIN], { initialConnection: 'club-sql', open: fakeOpen, credentials });
  await until(() => frame().includes('Password for sa on club-sql'), 'the password prompt');
  app.stdin.write(KEYS.esc);
  await until(() => !frame().includes('Password for sa'), 'the prompt gone');
  await type(app.stdin, '/connect club-sql');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('Password for sa on club-sql'), 'the prompt again');
  app.stdin.write('\t');
  await until(() => frame().includes('[ ] Keep it in memory'), 'keep it unticked');
  await type(app.stdin, 'right');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('Clubs'), 'connected');
  assert.equal(credentials.saved.size, 0);
  app.unmount();
});

test('/password saves one, /folder files a connection, and the window title follows the session', async () => {
  const credentials = memoryCredentials();
  const titles = [];
  // Returns true as cli.jsx's process.stdout.write does, which an effect must not hand back to React.
  const setTitle = (t) => (titles.push(t), true);
  const app = startWith([LOGIN, { name: 'az', server: 'x.database.windows.net', auth: 'azure-cli' }, ...DEMO_CONNECTIONS], { open: fakeOpen, credentials, setTitle });
  await until(() => frame().includes('club-sql') && frame().includes('Connections'), 'the connections');
  await type(app.stdin, '/folder club-sql Clubs / Lisbon');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('▾ Clubs/Lisbon/'), 'the folder heading');
  await type(app.stdin, '/password club-sql');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('Kept in memory'), 'the password field');
  assert.doesNotMatch(frame(), /Keep it in/, 'saving has no keep-it choice');
  await type(app.stdin, 'right');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('save the password for club-sql'), 'saved');
  assert.equal(credentials.saved.get('club-sql'), 'right');
  assert.equal(titles.at(-1), 'Trawl');
  await type(app.stdin, '/connect demo-prod');
  app.stdin.write(KEYS.enter);
  await until(() => titles.at(-1) === 'Trawl · demo-prod/ClubA · PROD', 'the title');
  // A second change runs the first effect's clean-up, which crashed the app when it wasn't a function.
  await type(app.stdin, '/connect demo');
  app.stdin.write(KEYS.enter);
  await until(() => titles.at(-1) === 'Trawl · demo/ClubA', 'the title again');
  app.stdin.write('?');
  await until(() => frame().includes('Keyboard shortcuts'), 'the app still taking keys');
  // q closes the help, and doesn't also quit.
  app.stdin.write('q');
  await until(() => !frame().includes('Keyboard shortcuts'), 'the help closed');
  app.stdin.write('4');
  await until(() => frame().includes('Nothing has run yet') || frame().includes('╭─ History'), 'History, so still running');
  const saved = JSON.parse(readFileSync(join(process.env.TRAWL_HOME, 'config.json'), 'utf8'));
  assert.equal(saved.connections.find((c) => c.name === 'club-sql').folder, 'Clubs/Lisbon');
  app.unmount();
});
