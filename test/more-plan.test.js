// End-to-end tests of fetching more rows past the row limit (m, /more) and the actual plan (P,
// /plan actual), in app.test.js's style: the real UI against the demo connections. The helpers are
// copied from features.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { DEMO_CONNECTIONS } from '../src/connections.js';
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

function start(connection = 'demo', props = {}, { connections = [...DEMO_CONNECTIONS], ...config } = {}) {
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
const consoleWith = (text) => {
  mkdirSync(process.env.TRAWL_HOME, { recursive: true });
  writeFileSync(join(process.env.TRAWL_HOME, 'console.sql'), text);
};

test('m fetches another row limit’s worth of a result the limit cut off, keeping the cursor and the filter', async () => {
  const app = start('demo', {}, { limit: 5 });
  await until(() => frame().includes('Clubs'), 'the explorer');
  await command(app, '!SELECT * FROM dbo.Players');
  await until(() => frame().includes('The row limit stopped it at 5 rows · m fetches 5 more'), 'the line under the grid');
  assert.match(frame(), /5\+ rows/);
  app.stdin.write('j');
  app.stdin.write('j');
  await until(() => /❯\s+3 │/.test(frame()), 'the cursor on the third row');
  app.stdin.write('m');
  await until(() => frame().includes('10+ rows') && frame().includes('The row limit stopped it at 10 rows'), 'ten rows');
  assert.match(frame(), /❯\s+3 │/, 'the cursor stays');
  assert.match(frame(), /first 10 rows \(the limit is 10\)/);
  await command(app, '/filter a');
  await until(() => /"a": \d+ of 10\+ rows/.test(frame()), 'the filter');
  await command(app, '/more');
  await until(() => /"a": \d+ of 12 rows/.test(frame()), 'all twelve, still filtered');
  assert.doesNotMatch(frame(), /The row limit stopped it/);
  app.stdin.write('m');
  await until(() => frame().includes('All the rows are here'), 'nothing more to fetch');
  app.unmount();
});

test('m raises the TOP of a table’s first rows, and never runs a write again', async () => {
  const app = start('demo', {}, { limit: 2 });
  await until(() => frame().includes('Clubs'), 'the explorer');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('SELECT TOP (2) * FROM [dbo].[Clubs]') && frame().includes('m fetches 2 more'), 'the first two clubs');
  app.stdin.write('m');
  await until(() => frame().includes('SELECT TOP (4) * FROM [dbo].[Clubs]') && frame().includes('Union Sud'), 'all three');
  assert.match(frame(), /3 rows/);
  assert.doesNotMatch(frame(), /m fetches/);
  await command(app, '!UPDATE dbo.Players SET Goals = 0 WHERE Id = 1; SELECT * FROM dbo.Players');
  await until(() => frame().includes('The row limit stopped it at 2 rows') && frame().includes('2+ rows'), 'the cut-off script');
  assert.doesNotMatch(frame(), /m fetches/);
  app.stdin.write('m');
  await until(() => frame().includes("This changes data, so it isn't run again"), 'the refusal');
  app.unmount();
});

test('P runs the statement with its actual plan: the rows in Results, the plan with actual and estimated rows, and a asks Claude', async () => {
  consoleWith('SELECT * FROM dbo.Players WHERE Goals > 3');
  const asked = [];
  const askClaude = async ({ prompt }) => (asked.push(prompt), 'The estimate is far off: update the statistics.');
  const app = start('demo', { askClaude });
  await until(() => frame().includes('Clubs'), 'the explorer');
  app.stdin.write('2');
  await until(() => frame().includes('WHERE Goals > 3'), 'the console');
  app.stdin.write('P');
  await until(() => frame().includes('Actual plan: SELECT * FROM dbo.Players WHERE Goals > 3') && frame().includes('a Claude explains it'), 'the plan');
  assert.match(frame(), /actual 12 \/ est 1\s+▲ 12×\s+\|--Clustered Index Scan\(OBJECT:\(\[ClubA\]\.\[dbo\]\.\[Players\]/);
  assert.match(frame(), /▲ more rows than estimated/);
  app.stdin.write('a');
  await until(() => frame().includes('update the statistics'), 'the explanation');
  assert.match(asked[0], /Actual plan \(STATISTICS PROFILE\):\nactual 12 \/ est 1/);
  assert.doesNotMatch(asked[0], /Rui Costa/, 'no rows');
  app.stdin.write(KEYS.esc);
  await until(() => !frame().includes('update the statistics'), 'closed');
  // The rows went to Results as any run's, without the plan's set.
  app.stdin.write('3');
  await until(() => frame().includes('Rui Costa') && frame().includes('12 rows'), 'the rows in Results');
  assert.doesNotMatch(frame(), /set 1\/2|EstimateRows/);
  // STATISTICS PROFILE is off again: a query gives its rows alone.
  await command(app, '!SELECT * FROM dbo.Clubs');
  await until(() => frame().includes('Club A FC') && frame().includes('3 rows'), 'rows again');
  assert.doesNotMatch(frame(), /set 1\/2/);
  app.stdin.write('4');
  await until(() => frame().includes('SELECT * FROM dbo.Players WHERE Goals > 3'), 'the run in History');
  app.unmount();
});

test('the actual plan of a write goes through the usual checks: refused on production, then in a transaction', async () => {
  const app = start('demo-prod', { askClaude: async () => 'unused' });
  await until(() => frame().includes('PROD') && frame().includes('Clubs'), 'the production connection');
  await command(app, '/plan actual UPDATE dbo.Players SET Goals = 1 WHERE Id = 2');
  await until(() => frame().includes('is read-only (production)'), 'the refusal');
  await command(app, '/writes');
  await until(() => frame().includes('Allow writes on demo-prod'), 'the writes confirmation');
  app.stdin.write('1');
  await until(() => frame().includes('writes allowed'), 'writes allowed');
  await command(app, '/plan actual UPDATE dbo.Players SET Goals = 1 WHERE Id = 2');
  await until(() => frame().includes('|--Clustered Index Update(OBJECT:([ClubA].[dbo].[Players]') && frame().includes('TRANSACTION OPEN'), 'the plan, in a transaction');
  app.stdin.write(KEYS.esc);
  await until(() => !frame().includes('╭─ Actual plan:'), 'the plan closed');
  await command(app, '/rollback');
  await until(() => !frame().includes('TRANSACTION OPEN'), 'rolled back');
  app.unmount();
});
