// End-to-end tests of /health, /sizes and /deadlocks, in app.test.js's style: the real UI against the
// demo connections, keys in, frames out. The helpers are copied from features.test.js.
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

test('/health reports what it found and why, then puts all the fixes in a console tab of their own', async () => {
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  await command(app, '/health');
  await until(() => frame().includes('Health: demo/ClubA') && frame().includes('Put the fixes in a console tab of their own?'), 'the report and the question');
  assert.match(frame(), /ClubA on demo \(SQL Server\): 11 findings, from 8 checks\./);
  assert.match(frame(), /Missing indexes the server suggests \(2\)/);
  assert.match(frame(), /1\. Yes, all of them \(11\)/);
  assert.match(frame(), /5\. Only foreign keys without an index \(2\)/);
  assert.match(frame(), /health check of ClubA/);
  app.stdin.write('1');
  await until(() => frame().includes('[2 health]') && frame().includes("-- Fixes from Trawl's health check of ClubA on demo."), 'the script in its own tab');
  assert.match(frame(), /CREATE NONCLUSTERED INDEX \[IX_Matches_PlayedOn\] ON \[dbo\]\.\[Matches\] \(\[PlayedOn\]\) INCLUDE/);
  assert.match(frame(), /The fixes are in the console tab health/);
  app.unmount();
});

test('/health can offer one group of fixes, and the drops come commented out', async () => {
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  await command(app, '/health');
  await until(() => frame().includes('Put the fixes in a console tab of their own?'), 'the question');
  app.stdin.write('4');
  await until(() => frame().includes('[2 health]') && frame().includes('-- Duplicate and overlapping indexes'), 'the duplicates only');
  assert.match(frame(), /-- DROP INDEX \[IX_Players_ClubId\] ON \[dbo\]\.\[Players\];/);
  assert.doesNotMatch(frame(), /CREATE NONCLUSTERED INDEX/);
  app.unmount();
});

test('/health on Postgres says which checks it has no equivalent for', async () => {
  const connections = [...DEMO_CONNECTIONS, { name: 'pg', demo: true, kind: 'postgres', server: 'demo', database: 'ClubA' }];
  const app = start('pg', {}, { connections });
  await until(() => frame().includes('Clubs'), 'the explorer');
  await command(app, '/health');
  await until(() => frame().includes('Health: pg/ClubA') && frame().includes('Put the fixes'), 'the report');
  assert.match(frame(), /ClubA on pg \(PostgreSQL\): 7 findings, from 7 checks\./);
  app.stdin.write('\x1b');
  await until(() => !frame().includes('Put the fixes'), 'no fixes');
  // The end of the report lists what isn't checked here.
  await command(app, '/last');
  await until(() => frame().includes('Health: pg/ClubA'), 'the report again');
  app.stdin.write('G');
  await until(() => frame().includes('Not checked on PostgreSQL:'), 'the checks it has not');
  assert.match(frame(), /Missing indexes the server suggests: PostgreSQL doesn't suggest/);
  app.unmount();
});

test('/sizes lists the tables biggest first in Results, where o sorts them', async () => {
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  await command(app, '/sizes');
  await until(() => frame().includes('Table sizes: ClubA') && frame().includes('reserved_mb'), 'the sizes');
  assert.match(frame(), /❯ i18n\s+│ Translations\s+│\s+15 │\s+0\.99 │/);
  assert.match(frame(), /as sp_spaceused counts them/);
  app.unmount();
});

test('/deadlocks lists them newest first, and ↵ draws one as a tree from the victim', async () => {
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  await command(app, '/deadlocks');
  await until(() => frame().includes('Deadlocks, newest first') && /❯ \d{4}-\d\d-\d\d \d\d:\d\d UTC\s+victim session 61/.test(frame()), 'the list');
  assert.match(frame(), /\d\d:\d\d UTC\s+victim session 64/);
  assert.match(frame(), /2 deadlocks from system_health's event files\./);
  app.stdin.write('\r');
  await until(() => frame().includes('✗ session 61 · etl on BATCH02'), 'the deadlock');
  assert.match(frame(), /wants U on KEY ClubA\.dbo\.Clubs \(PK_Clubs\), which session 53 holds \(X\)/);
  assert.match(frame(), /└ session 53 · app_user on WEB01 · Club website/);
  assert.match(frame(), /└ session 61: back to the start/);
  app.unmount();
});

test('/deadlocks elsewhere: Azure SQL Database in master, MySQL’s latest, Postgres only counts them, a login without the permission', async () => {
  const connections = [
    ...DEMO_CONNECTIONS,
    { name: 'azure-db', demo: true, server: 'demo', database: 'ClubA', engineEdition: 5 },
    { name: 'azure-master', demo: true, server: 'demo', database: 'master', engineEdition: 5 },
    { name: 'pg', demo: true, kind: 'postgres', server: 'demo', database: 'ClubA' },
    { name: 'my', demo: true, kind: 'mysql', server: 'demo', database: 'ClubA' },
    { name: 'plain', demo: true, server: 'demo', database: 'ClubA', noServerState: true },
  ];
  let app = start('azure-db', {}, { connections });
  await until(() => frame().includes('Clubs'), 'the explorer');
  await command(app, '/deadlocks');
  await until(() => frame().includes('/use master, then /deadlocks again'), 'where Azure keeps them');
  app.unmount();
  app = start('azure-master', {}, { connections });
  await until(() => frame().includes('azure-master'), 'connected to master');
  await command(app, '/deadlocks');
  await until(() => frame().includes("Azure SQL Database's deadlock") && frame().includes('UTC in ClubA: 2 sess'), 'every database’s');
  app.unmount();
  app = start('pg', {}, { connections });
  await until(() => frame().includes('Clubs'), 'the explorer');
  await command(app, '/deadlocks');
  await until(() => frame().includes('only to its server log') && frame().includes('pg_stat_database counts 3'), 'only counted');
  app.unmount();
  app = start('my', {}, { connections });
  await until(() => frame().includes('Clubs'), 'the explorer');
  await command(app, '/deadlocks');
  await until(() => frame().includes('Deadlock 2026-10-21 08:57:13') && frame().includes('✗ session 21 · etl on 10.0.0.31'), 'the latest one, in the viewer');
  app.unmount();
  app = start('plain', {}, { connections });
  await until(() => frame().includes('Clubs'), 'the explorer');
  await command(app, '/deadlocks');
  await until(() => frame().includes('VIEW SERVER STATE permission was denied'), 'the error');
  app.unmount();
});
