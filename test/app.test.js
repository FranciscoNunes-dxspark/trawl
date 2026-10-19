// Drives the real UI against the demo connections: keys in, frames out.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { DEMO_CONNECTIONS } from '../src/connections.js';
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

test('e in History puts the statement in the console to edit', async () => {
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  await type(app.stdin, '!SELECT 7 AS seven');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('seven'), 'the result');
  app.stdin.write('4');
  await until(() => frame().includes('History'), 'history');
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
  assert.doesNotMatch(frame(), /● SELECT TOP \(3\) Name/, 'nothing ran');
  app.stdin.write('\x12');
  await until(() => frame().includes('● SELECT TOP (3) Name, Goals FROM dbo.Players ORDER BY Goals DESC;') && frame().includes('3 rows'), 'the run after ctrl+r');
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
