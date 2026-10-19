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
  base = mkdtempSync(join(tmpdir(), 'fathom-'));
  process.env.FATHOM_HOME = join(base, 'home');
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
