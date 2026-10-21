// End-to-end tests of /script-all, /migrations, /generate and /scaffold, in app.test.js's style: the
// real UI against the demo connections, keys in, frames (and files) out. The helpers are copied.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { DEMO_CONNECTIONS } from '../src/connections.js';
import { DEMO_MIGRATIONS } from '../src/demo.js';
import { App } from '../src/ui/App.jsx';

const KEYS = { enter: '\r', esc: '\x1b' };

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

test('/script-all writes a file per object, only what changed the next time, and removes stale files after asking', async () => {
  const dir = join(base, 'schema');
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  await command(app, `/script-all ${dir}`);
  await until(() => frame().includes('7 written (7 new) · 0 unchanged'), 'the summary');
  assert.match(frame(), /\+ dbo\/Tables\/Players\.sql/);
  const players = readFileSync(join(dir, 'dbo', 'Tables', 'Players.sql'), 'utf8');
  assert.match(players, /^CREATE TABLE \[dbo\]\.\[Players\] \(\n/);
  assert.match(players, /CONSTRAINT \[DF_Players_Goals\] DEFAULT \(\(0\)\)/);
  assert.match(players, /CREATE NONCLUSTERED INDEX \[IX_Players_ClubId\]/);
  assert.match(readFileSync(join(dir, 'dbo', 'Triggers', 'trg_Players_Goals.sql'), 'utf8'), /^CREATE TRIGGER dbo\.trg_Players_Goals/);
  assert.ok(existsSync(join(dir, 'i18n', 'Tables', 'Translations.sql')));
  app.stdin.write(KEYS.esc);
  await until(() => !frame().includes('+ dbo/Tables/Players.sql'), 'the viewer closed');

  // A file whose object is gone, one changed by hand, and files outside the layout.
  writeFileSync(join(dir, 'dbo', 'Views', 'vOld.sql'), 'CREATE VIEW dbo.vOld AS SELECT 1;\n');
  writeFileSync(join(dir, 'dbo', 'Views', 'vTopScorers.sql'), '-- edited\n');
  writeFileSync(join(dir, 'README.sql'), '-- mine\n');
  mkdirSync(join(dir, 'dbo', 'Tables', 'old'), { recursive: true });
  writeFileSync(join(dir, 'dbo', 'Tables', 'old', 'Keep.sql'), '-- mine too\n');
  await command(app, `/script-all ${dir}`);
  await until(() => frame().includes('Remove 1 file whose object is gone from ClubA?'), 'the question');
  assert.match(frame(), /- dbo\/Views\/vOld\.sql/);
  app.stdin.write('1');
  await until(() => frame().includes('1 written · 6 unchanged · 1 removed'), 'the second summary');
  assert.match(frame(), /~ dbo\/Views\/vTopScorers\.sql/);
  assert.ok(!existsSync(join(dir, 'dbo', 'Views', 'vOld.sql')));
  assert.match(readFileSync(join(dir, 'dbo', 'Views', 'vTopScorers.sql'), 'utf8'), /^CREATE VIEW dbo\.vTopScorers AS\n/);
  assert.ok(existsSync(join(dir, 'README.sql')) && existsSync(join(dir, 'dbo', 'Tables', 'old', 'Keep.sql')), 'files outside the layout stay');
  app.unmount();
});

test("/migrations compares a folder with Flyway's history, and R runs the pending one and records it", async () => {
  const dir = join(base, 'flyway');
  mkdirSync(join(dir, 'sql'), { recursive: true });
  writeFileSync(join(dir, DEMO_MIGRATIONS[0].script), DEMO_MIGRATIONS[0].text.replace(/\n/g, '\r\n'));
  writeFileSync(join(dir, DEMO_MIGRATIONS[1].script), DEMO_MIGRATIONS[1].text.replace('NOT NULL', 'NULL'));
  writeFileSync(join(dir, 'sql', 'V3__Add_stadiums.sql'), 'CREATE TABLE dbo.Stadiums (\n  Id int NOT NULL PRIMARY KEY,\n  Name nvarchar(100) NOT NULL\n);\n');
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  await command(app, `/migrations ${dir}`);
  await until(() => frame().includes('Flyway · dbo.flyway_schema_history in ClubA · 3 files'), 'the status');
  // CRLF line ends don't change Flyway's checksum; an edit does.
  assert.match(frame(), /✓ applied {2}V1 {2}V1__Create_clubs\.sql /);
  assert.match(frame(), /~ changed {2}V2 {2}V2__Add_players\.sql +checksum -?\d+ now, -?\d+ when applied/);
  assert.match(frame(), /• pending {2}V3 {2}sql\/V3__Add_stadiums\.sql /);
  assert.match(frame(), /1 applied · 1 pending · 1 changed/);
  assert.match(frame(), /R runs the 1 pending/);
  app.stdin.write('R');
  await until(() => frame().includes('Run 1 pending migration on demo?'), 'the question');
  assert.match(frame(), /1 applied one is changed, missing or failed, which Flyway would stop at/);
  app.stdin.write('1');
  await until(() => /✓ applied {2}V3 {2}sql\/V3__Add_stadiums\.sql/.test(frame()), 'V3 applied and recorded');
  assert.match(frame(), /2 applied · 0 pending · 1 changed/);
  app.stdin.write(KEYS.esc);
  await until(() => frame().includes('Ran 1 migration, each recorded in flyway_schema_history'), 'the note');
  // Both ran in History: the migration, then its record.
  app.stdin.write('4');
  await until(() => frame().includes('CREATE TABLE dbo.Stadiums') && frame().includes('INSERT INTO [dbo].[flyway_schema_hist') && frame().includes("VALUES (3, N'3', N'Add stadiums'"), 'History');
  app.unmount();
});

test("/migrations run with Trawl's own history: it asks to make trawl_migrations, then runs the files in name order", async () => {
  const dir = join(base, 'plain');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '002_players.sql'), 'ALTER TABLE dbo.Players ADD Nickname nvarchar(40) NULL;\n');
  writeFileSync(join(dir, '001_clubs.sql'), 'ALTER TABLE dbo.Clubs ADD Website nvarchar(200) NULL;\n');
  const app = start('demo', {}, { connections: [...DEMO_CONNECTIONS, { name: 'club-b', demo: true, server: 'demo', database: 'ClubB' }] });
  await until(() => frame().includes('Clubs'), 'the explorer');
  await command(app, '/connect club-b');
  await until(() => frame().includes('club-b') && frame().includes('Stadiums'), 'ClubB');
  await command(app, `/migrations ${dir}`);
  await until(() => frame().includes("Trawl · trawl_migrations isn't in ClubB yet · 2 files"), 'the status');
  assert.match(frame(), /• pending {2}001_clubs\.sql[\s\S]*• pending {2}002_players\.sql/);
  app.stdin.write(KEYS.esc);
  await until(() => !frame().includes('• pending'), 'the viewer closed');
  await command(app, '/migrations run');
  await until(() => frame().includes('Run 2 pending migrations on club-b?'), 'the question');
  app.stdin.write('1');
  await until(() => frame().includes('Make trawl_migrations in ClubB to record them?'), 'asked to make the table');
  app.stdin.write('1');
  await until(() => frame().includes('2 applied · 0 pending'), 'both run and recorded');
  assert.match(frame(), /Trawl · dbo\.trawl_migrations in ClubB/);
  app.unmount();
});

test('/migrations run is refused on a read-only connection', async () => {
  const dir = join(base, 'flyway-prod');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'V3__x.sql'), 'CREATE TABLE dbo.X (Id int);\n');
  const app = start('demo-prod');
  await until(() => frame().includes('PROD') && frame().includes('Clubs'), 'the production connection');
  await command(app, `/migrations run ${dir}`);
  await until(() => frame().includes('demo-prod is read-only (production), and migrations change it'), 'the refusal');
  app.unmount();
});

test('/generate puts made-up rows in a console tab of their own, the same for the same seed; nothing runs', async () => {
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  await command(app, '/generate vTopScorers');
  await until(() => frame().includes('dbo.vTopScorers is a view; /generate writes INSERTs into a table'), 'a view refused');
  await command(app, '/generate Players 3 --seed 5');
  await until(() => frame().includes('[2 generate]') && frame().includes('INSERT INTO [dbo].[Players] ([ClubId], [Name], [Position], [Shirt], [Goals]) VALUES'), 'the script in its tab');
  assert.match(frame(), /-- 3 rows of made-up data for dbo\.Players \(seed 5\)/);
  assert.match(frame(), /-- ClubId: a value from dbo\.Clubs \(3 rows\)\./);
  assert.match(frame(), /\([123], N'[^']+', '[A-Z]{2}', (\d+|NULL), \d+\)/);
  // The foreign key's values were read, and nothing was written.
  app.stdin.write('4');
  await until(() => frame().includes('SELECT TOP (1000) [Id] FROM [dbo].[Clubs]') || frame().includes('History'), 'History');
  assert.doesNotMatch(frame(), /INSERT INTO/);
  app.unmount();
});

test('/scaffold shows the class for a table, copies it, and completes the table name', async () => {
  const copied = [];
  const app = start('demo', { clipboard: async (text) => (copied.push(text), 'system') });
  await until(() => frame().includes('Clubs'), 'the explorer');
  await type(app.stdin, '/scaffold Pla');
  await until(() => frame().includes('dbo.Players'), 'the table offered');
  app.stdin.write('\x15');
  await command(app, '/scaffold Players ts');
  await until(() => frame().includes('TypeScript interface: dbo.Players') && frame().includes('export interface Player {'), 'the interface');
  assert.match(frame(), /Shirt: number \| null;/);
  await until(() => copied.length === 1, 'copied');
  assert.match(copied[0], /^\/\/ table dbo\.Players, as the tedious \(mssql\) driver returns its rows\nexport interface Player \{\n {2}Id: number;/);
  assert.match(frame(), /Copied the TypeScript interface for dbo\.Players/);
  app.stdin.write(KEYS.esc);
  await until(() => !frame().includes('export interface'), 'the viewer closed');
  await command(app, '/scaffold Translations ef');
  await until(() => frame().includes('[PrimaryKey(nameof(ResourceKey), nameof(Culture))]'), 'the entity');
  app.stdin.write(KEYS.esc);
  await until(() => !frame().includes('[PrimaryKey('), 'the viewer closed');
  await command(app, '/scaffold Players cobol');
  await until(() => frame().includes('/scaffold makes csharp, ef, ts, python (C# by default), not cobol.'), 'an unknown language');
  app.unmount();
});
