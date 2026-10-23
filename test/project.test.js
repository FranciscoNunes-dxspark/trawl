// Connections from the project's own files (appsettings*.json, .env): said at start, added with
// /project. The pure parts, then the real UI against the demo, in app.test.js's style.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { DEMO_CONNECTIONS, parseAddArgs } from '../src/connections.js';
import { memoryCredentials } from '../src/credentials.js';
import { projectAt } from '../src/family.js';
import { addArgsFor, newDatabases, projectNote, savedFor } from '../src/siblings.js';
import { App } from '../src/ui/App.jsx';

const KEYS = { enter: '\r', esc: '\x1b' };

let base;
before(() => {
  base = mkdtempSync(join(tmpdir(), 'trawl-project-'));
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
function start(connection = 'demo', props = {}, connections = [...DEMO_CONNECTIONS]) {
  const config = { connections, history: [], ran: [], limit: 500, last: null };
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

function project() {
  const dir = mkdtempSync(join(base, 'shop-'));
  writeFileSync(
    join(dir, 'appsettings.Development.json'),
    JSON.stringify({ ConnectionStrings: { Default: 'Server=tcp:db.example.com,1433;Database=Shop;User Id=app;Password=s3cret;', Reports: 'Server=reports.example.com;Database=Reports;Authentication=Active Directory Default' } }),
  );
  writeFileSync(join(dir, '.env'), 'DATABASE_URL=postgres://web:pw@pg.local:5433/web\n');
  return dir;
}

test('the databases not saved yet, the note about them, and the /add each becomes', () => {
  const dir = project();
  const p = projectAt(dir);
  assert.equal(p.databases.length, 3);
  const saved = [parseAddArgs('reports reports.example.com Reports')];
  const found = newDatabases(p, saved);
  assert.deepEqual(found.map((d) => d.name), ['Default', 'DATABASE_URL']);
  assert.equal(savedFor(saved, p.databases.find((d) => d.name === 'Reports')).name, 'reports');
  assert.equal(projectNote(found), 'Found 2 databases in appsettings.Development.json and .env: /project to add them.');
  assert.equal(projectNote(found.slice(0, 1)), 'Found a database in appsettings.Development.json: /project to add it.');
  assert.equal(projectNote([]), null);
  assert.equal(addArgsFor(found[0], saved), 'Default db.example.com,1433 Shop --user app');
  assert.equal(addArgsFor(found[1], saved), 'DATABASE_URL pg.local:5433 web --kind postgres --user web');
  assert.equal(addArgsFor(p.databases.find((d) => d.name === 'Reports'), [...saved, { name: 'Reports' }]), 'Reports-2 reports.example.com Reports');
  const conn = parseAddArgs(addArgsFor(found[0], saved));
  assert.deepEqual([conn.server, conn.database, conn.user, conn.auth], ['db.example.com,1433', 'Shop', 'app', 'sql']);
});

test('Trawl says at start what the project has, and /project adds one, keeping its password only in the store', async () => {
  const dir = project();
  const credentials = memoryCredentials();
  const app = start('demo', { projectDir: dir, credentials });
  await until(() => frame().includes('Found 3 databases in appsettings.Development.json and .env: /project to add them.'), 'the note');
  await command(app, 'project');
  await until(() => frame().includes('Databases in shop-'), 'the list');
  assert.match(frame(), /❯ Default/);
  assert.match(frame(), /Reports/);
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('Keep the password appsettings.Development.json has for app in memory?'), 'the question about the password');
  app.stdin.write('1');
  await until(() => frame().includes('Saved the password for Default in memory.'), 'the password saved');
  assert.equal(credentials.saved.get('Default'), 's3cret');
  const config = readFileSync(join(process.env.TRAWL_HOME, 'config.json'), 'utf8');
  assert.match(config, /"name": "Default"/);
  assert.doesNotMatch(config, /s3cret/);
  await command(app, 'project');
  await until(() => frame().includes('Databases in shop-') && !/❯ Default/.test(frame()), 'the list without it');
  app.unmount();
});
