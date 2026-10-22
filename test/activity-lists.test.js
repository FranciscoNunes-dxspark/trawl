// End-to-end tests of the Activity tab's other lists, SQL Agent jobs (J) and top queries (Q), in
// app.test.js's style: the real UI against the demo connections, keys in, frames out. The helpers
// are copied from app.test.js.
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

function start(connection = 'demo', { connections = [...DEMO_CONNECTIONS], ...config } = {}) {
  const full = { connections, history: [], ran: [], limit: 500, last: null, ...config };
  lastApp = render(React.createElement(App, { config: full, initialConnection: connection }));
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

test('J lists the SQL Agent jobs, ↵ shows a failed run’s step, s starts a job after asking, J goes back', async () => {
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  app.stdin.write('6');
  await until(() => frame().includes('Activity · sessions') && frame().includes('blocked by 53'), 'the sessions');
  app.stdin.write('J');
  await until(() => frame().includes('Activity · SQL Agent jobs') && frame().includes('Stats refresh'), 'the jobs');
  assert.match(frame(), /❯ ✗ Backup ClubA\s+failed\s+2 min 05 s\s+next/);
  assert.match(frame(), /Nightly load\s+succeeded\s+12 min 31 s/);
  assert.match(frame(), /▶ Stats refresh\s+running/);
  assert.match(frame(), /Old archive\s+never run\s+disabled/);
  assert.match(frame(), /4 · 1 failed · 1 running/);
  assert.match(frame(), /─ Job Backup ClubA ─/);
  assert.match(frame(), /Last run\s+failed · /);
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('recent runs'), 'the job history');
  assert.match(frame(), /✗ failed/);
  assert.match(frame(), /step 2 \(Copy to share\): Cannot open backup device/);
  assert.match(frame(), /✓ succeeded/);
  app.stdin.write(KEYS.esc);
  await until(() => frame().includes('Activity · SQL Agent jobs'), 'the jobs again');
  app.stdin.write('j');
  app.stdin.write('j');
  await until(() => /❯\s+Old archive/.test(frame()), 'the disabled job');
  app.stdin.write('s');
  await until(() => frame().includes('Start job Old archive?'), 'the question');
  app.stdin.write('1');
  await until(() => /Old archive\s+running/.test(frame()), 'the job running');
  assert.match(frame(), /start job Old archive/);
  app.stdin.write('J');
  await until(() => frame().includes('Activity · sessions'), 'back to the sessions');
  await command(app, '/jobs');
  await until(() => frame().includes('Activity · SQL Agent jobs'), '/jobs');
  app.stdin.write(KEYS.esc);
  await until(() => frame().includes('Activity · sessions'), 'esc back to the sessions');
  app.unmount();
});

test('starting a job is refused on a read-only connection', async () => {
  const app = start('demo-prod');
  await until(() => frame().includes('PROD') && frame().includes('Clubs'), 'the production connection');
  await command(app, '/jobs');
  await until(() => frame().includes('Backup ClubA'), 'the jobs');
  app.stdin.write('s');
  await until(() => frame().includes('demo-prod is read-only (production), and starting a job changes things'), 'the refusal');
  assert.doesNotMatch(frame(), /Start job/);
  app.unmount();
});

test('Q lists the top queries from Query Store, o sorts by CPU, ↵ shows one, e edits it in the console', async () => {
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  app.stdin.write('6');
  await until(() => frame().includes('Activity · sessions'), 'the sessions');
  app.stdin.write('Q');
  await until(() => frame().includes('Activity · top queries') && frame().includes('SELECT * FROM dbo.M'), 'the top queries');
  assert.match(frame(), /Query Store, last 24 h · by total duration/);
  assert.match(frame(), /total\s+avg\s+cpu\s+reads\s+runs\s+query/);
  assert.match(frame(), /❯\s+2m31s\s+12\.6s\s+2m20s\s+12\.4M\s+12\s+SELECT \* FROM/);
  const order = () => ['SELECT * FROM dbo.M', 'SELECT c.Name', '(@p0 int)UPDATE', 'SELECT TOP (10)'].map((t) => frame().indexOf(t));
  assert.deepEqual([...order()].sort((x, y) => x - y), order(), 'by total duration');
  app.stdin.write('o');
  await until(() => frame().includes('by CPU'), 'sorted by CPU');
  const cpu = ['SELECT * FROM dbo.M', 'SELECT c.Name', 'SELECT TOP (10)', '(@p0 int)UPDATE'].map((t) => frame().indexOf(t));
  assert.deepEqual([...cpu].sort((x, y) => x - y), cpu, 'by CPU');
  app.stdin.write('o');
  await until(() => frame().includes('by reads'), 'sorted by reads');
  app.stdin.write('o');
  await until(() => frame().includes('by executions'), 'sorted by executions');
  assert.match(frame(), /❯\s+23\.1s\s+0\.1ms\s+20\.1s.*SELECT TOP \(10\)/);
  assert.match(frame(), /Average\s+0\.1 ms/);
  app.stdin.write('j');
  app.stdin.write('j');
  await until(() => /❯.*SELECT c\.Name/.test(frame()), 'the query with two plans');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('Query 4'), 'the query in full');
  assert.match(frame(), /Plans\s+2 in Query Store \(it has run with different plans\)/);
  assert.match(frame(), /GROUP BY c\.Name/);
  app.stdin.write(KEYS.esc);
  await until(() => frame().includes('Activity · top queries'), 'the list again');
  app.stdin.write('e');
  await until(() => !frame().includes('Activity · top queries') && frame().includes('FROM dbo.Clubs c JOIN dbo.Players p'), 'the query in the console');
  // It's there to type into; esc stops typing.
  app.stdin.write(KEYS.esc);
  await until(() => !frame().includes('typing SQL'), 'typing stopped');
  app.stdin.write('6');
  await until(() => frame().includes('Activity · top queries') && /❯.*SELECT c\.Name/.test(frame()), 'the list kept, on the same query');
  app.stdin.write('Q');
  await until(() => frame().includes('Activity · sessions'), 'Q back to the sessions');
  app.unmount();
});

test('with Query Store off, the top queries come from the plan cache, and the list says so', async () => {
  const connections = [...DEMO_CONNECTIONS, { name: 'club-b', demo: true, server: 'demo', database: 'ClubB' }];
  const app = start('club-b', { connections });
  await until(() => frame().includes('Clubs'), 'the explorer');
  await command(app, '/top-queries');
  await until(() => frame().includes('Activity · top queries') && frame().includes('SELECT * FROM dbo.M'), 'the top queries');
  assert.match(frame(), /Query Store is off for ClubB/);
  assert.match(frame(), /plan cache, since the restart · by total duration/);
  app.unmount();
});

test('where there is no SQL Agent or no pg_stat_statements, the lists say so', async () => {
  const connections = [...DEMO_CONNECTIONS, { name: 'azure-db', demo: true, server: 'demo', database: 'ClubA', engineEdition: 5 }, { name: 'pg', demo: true, kind: 'postgres', server: 'demo', database: 'ClubA' }];
  let app = start('azure-db', { connections });
  await until(() => frame().includes('Clubs'), 'the explorer');
  await command(app, '/jobs');
  await until(() => frame().includes('Azure SQL Database has no SQL Agent'), 'no Agent on Azure SQL Database');
  app.unmount();
  app = start('pg', { connections });
  await until(() => frame().includes('Clubs'), 'the explorer');
  await command(app, '/jobs');
  await until(() => frame().includes('PostgreSQL has no SQL Agent'), 'no Agent on Postgres');
  app.stdin.write('Q');
  await until(() => frame().includes("pg_stat_statements isn't installed in ClubA") && frame().includes('shared_preload_libraries'), 'how to have pg_stat_statements');
  app.unmount();
});
