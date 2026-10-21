// End-to-end tests of fetching more rows past the row limit (m, /more) and the actual plan (P,
// /plan actual), in app.test.js's style: the real UI against the demo connections. The helpers are
// copied from features.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
