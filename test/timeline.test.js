// timeline.js and the family's activity log: what Trawl says of its writes (never their values),
// transactions ending, /timeline and /wiring; the end-to-end part uses a temporary FAMILY_HOME
// (helpers copied from app.test.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { DEMO_CONNECTIONS } from '../src/connections.js';
import { logActivity, readActivity } from '../src/family.js';
import { addPending, endText, endsTransaction, rowsChanged, statementKind, timelineItems, wiringText, writeKinds, writeText } from '../src/timeline.js';
import { App } from '../src/ui/App.jsx';

test("a write is its kind of statement and its table, never a value from the SQL", () => {
  assert.equal(statementKind("UPDATE dbo.Players SET Name = N'Rui Costa' WHERE Id = 1"), 'UPDATE dbo.Players');
  assert.equal(statementKind("INSERT INTO [dbo].[Clubs] (Name) VALUES ('Secret FC')"), 'INSERT INTO [dbo].[Clubs]');
  assert.equal(statementKind('insert ignore into shop.orders values (1)'), 'INSERT IGNORE INTO shop.orders');
  assert.equal(statementKind('DELETE FROM "public"."Log" WHERE at < now()'), 'DELETE FROM "public"."Log"');
  assert.equal(statementKind('DELETE Log WHERE 1 = 1'), 'DELETE Log');
  assert.equal(statementKind('-- tidy\nTRUNCATE TABLE dbo.Log'), 'TRUNCATE TABLE dbo.Log');
  assert.equal(statementKind('CREATE OR ALTER PROCEDURE dbo.p AS SELECT 1'), 'CREATE OR ALTER PROCEDURE dbo.p');
  assert.equal(statementKind('CREATE UNIQUE NONCLUSTERED INDEX IX_a ON dbo.T (a)'), 'CREATE UNIQUE NONCLUSTERED INDEX IX_a');
  assert.equal(statementKind('DROP TABLE IF EXISTS dbo.Old'), 'DROP TABLE dbo.Old');
  assert.equal(statementKind("EXEC dbo.usp_Reset @Password = 'hunter2'"), 'EXEC');
  assert.equal(statementKind("MERGE INTO dbo.T AS t USING (VALUES ('x')) s(a) ON 1 = 0 WHEN NOT MATCHED THEN INSERT VALUES (s.a);"), 'MERGE INTO dbo.T');
  const kinds = writeKinds("BEGIN TRAN;\nUPDATE dbo.Players SET Goals = 1 WHERE Id = 1;\nUPDATE dbo.Players SET Goals = 2 WHERE Id = 2;\nSELECT 'x';\nINSERT INTO dbo.Log VALUES ('secret');");
  assert.deepEqual(kinds, ['UPDATE dbo.Players ×2', 'INSERT INTO dbo.Log']);
  assert.doesNotMatch(kinds.join(' '), /secret/);
  assert.deepEqual(writeKinds('SELECT * FROM dbo.Players'), []);
  // Saved edits: one TRY/CATCH block, its statements found inside it.
  const edits = "BEGIN TRANSACTION;\nBEGIN TRY\n  UPDATE [dbo].[Players] SET [Name] = N'Rui' WHERE [Id] = 1;\n  IF @@ROWCOUNT <> 1 THROW 50000, N'Gone.', 1;\n  DELETE FROM [dbo].[Players] WHERE [Id] = 2;\n  COMMIT TRANSACTION;\nEND TRY\nBEGIN CATCH\n  THROW;\nEND CATCH;";
  assert.deepEqual(writeKinds(edits), ['UPDATE [dbo].[Players]', 'DELETE FROM [dbo].[Players]']);
});

test('rows, what an open transaction holds, and how its end is said', () => {
  assert.equal(rowsChanged(['3 rows affected', 'note', '1 row affected']), 4);
  assert.equal(rowsChanged(['Commands completed successfully.']), null);
  assert.equal(writeText(['UPDATE dbo.Players'], 'dev/ClubA', 3), 'UPDATE dbo.Players on dev/ClubA · 3 rows');
  assert.equal(writeText(['CREATE TABLE dbo.T'], 'dev/ClubA', null), 'CREATE TABLE dbo.T on dev/ClubA');
  const held = addPending(addPending(null, ['UPDATE dbo.Players'], 1), ['UPDATE dbo.Players', 'DELETE FROM dbo.Log ×2'], 4);
  assert.deepEqual(held, { kinds: ['UPDATE dbo.Players ×2', 'DELETE FROM dbo.Log ×2'], rows: 5 });
  assert.equal(endText('COMMIT', 'dev/ClubA', held), 'COMMIT on dev/ClubA: UPDATE dbo.Players ×2, DELETE FROM dbo.Log ×2 · 5 rows');
  assert.equal(endText('ROLLBACK', 'dev/ClubA', held), 'ROLLBACK on dev/ClubA: UPDATE dbo.Players ×2, DELETE FROM dbo.Log ×2 · 5 rows undone');
  assert.equal(endText('COMMIT', 'dev/ClubA', null), 'COMMIT on dev/ClubA');
  assert.equal(endsTransaction('-- done\ncommit transaction;'), 'COMMIT');
  assert.equal(endsTransaction('ROLLBACK'), 'ROLLBACK');
  assert.equal(endsTransaction('SELECT 1'), null);
});

test("/timeline's rows and /wiring's text", () => {
  const now = Date.UTC(2026, 9, 24, 12, 0);
  const items = timelineItems([{ at: now - 5 * 60_000, app: 'splice', kind: 'push', text: 'Pushed main', project: '/w/shop' }], { now });
  assert.equal(items[0].label, ' 5m  Splice');
  assert.equal(items[0].detail, 'Pushed main');
  assert.match(items[0].text, /^Splice · push · \d{4}-\d{2}-\d{2} \d{2}:\d{2}\n\/w\/shop\n\nPushed main$/);
  const text = wiringText('/w/shop', [
    { key: 'ConnectionStrings:Default', value: 'Server=db;Password=••••', source: 'appsettings.json' },
    { key: 'Api:BaseUrl', value: 'https://api.local', source: 'appsettings.json' },
    { key: 'DATABASE_URL', value: 'postgres://app:••••@db/shop', source: '.env' },
  ]);
  assert.equal(text, ['What /w/shop points at, by file (secrets masked as ••••):', '', 'appsettings.json', '  ConnectionStrings:Default  Server=db;Password=••••', '  Api:BaseUrl                https://api.local', '', '.env', '  DATABASE_URL  postgres://app:••••@db/shop'].join('\n'));
  assert.match(wiringText('/w/empty', []), /^Nothing in \/w\/empty points anywhere/);
});

// ---------------------------------------------------------------------------------------------------

const KEYS = { enter: '\r', esc: '\x1b' };
let base;
let home;
let project;
before(() => {
  base = mkdtempSync(join(tmpdir(), 'trawl-'));
  process.env.TRAWL_HOME = join(base, 'home');
  home = join(base, 'family');
  project = join(base, 'shop');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'appsettings.json'), JSON.stringify({ ConnectionStrings: { Default: 'Server=db.local;Database=Shop;User Id=app;Password=hunter2;' }, Api: { BaseUrl: 'https://api.shop.local' }, Logging: { Level: 'Debug' } }));
  writeFileSync(join(project, '.env'), 'REDIS_URL=redis://:topsecret@cache:6379\nDEBUG=1\n');
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
const frame = () => lastApp.lastFrame();
const type = async (stdin, s) => {
  for (const ch of s) {
    stdin.write(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
};
const command = async (app, text) => {
  await type(app.stdin, text);
  app.stdin.write(KEYS.enter);
};
const texts = () => readActivity({ dir: home }).map((e) => e.text);

test('writes that take effect, COMMIT and ROLLBACK go to the family log without their values; /timeline and /wiring show them', async () => {
  // Another app's line, from another project.
  logActivity('bosun', { text: 'Restarted api', kind: 'restart', project: join(base, 'elsewhere') }, { dir: home });
  const config = { connections: [...DEMO_CONNECTIONS, { name: 'dev', demo: true, server: 'demo', database: 'ClubB' }], history: [], ran: [], limit: 500, last: null };
  const app = (lastApp = render(React.createElement(App, { config, initialConnection: 'demo', familyHome: home, projectDir: project })));
  await until(() => frame().includes('Translations'), 'the explorer');
  await command(app, "!UPDATE dbo.Players SET Name = 'Secret Name' WHERE Id = 1");
  await until(() => texts().length === 2, 'the write in the log');
  assert.equal(texts()[0], 'UPDATE dbo.Players on demo/ClubA · 1 row');
  const mine = readActivity({ dir: home })[0];
  assert.equal(mine.app, 'trawl');
  assert.equal(mine.kind, 'write');
  assert.equal(mine.project, project);
  // A read says nothing.
  await command(app, '!SELECT * FROM dbo.Clubs');
  await until(() => frame().includes('3 rows'), 'the read');
  // With manual commit, a write waits for its transaction's end, and a rollback says what it undid.
  await command(app, '/tx manual');
  await until(() => frame().includes('manual commit'), 'manual commit');
  await command(app, "!DELETE FROM dbo.Players WHERE Name = 'Secret Name'");
  await until(() => frame().includes('TRANSACTION OPEN'), 'the open transaction');
  assert.equal(texts().length, 2);
  await command(app, '/rollback');
  await until(() => texts().length === 3, 'the rollback in the log');
  assert.equal(texts()[0], 'ROLLBACK on demo/ClubA: DELETE FROM dbo.Players · 1 row undone');
  await command(app, '!UPDATE dbo.Players SET Goals = 3 WHERE Id = 2');
  await until(() => frame().includes('TRANSACTION OPEN'), 'the open transaction');
  await command(app, '/commit');
  await until(() => texts().length === 4, 'the commit in the log');
  assert.equal(texts()[0], 'COMMIT on demo/ClubA: UPDATE dbo.Players · 1 row');
  for (const t of texts()) assert.doesNotMatch(t, /Secret/);
  // /copy-rows and /backup say what they did too.
  await command(app, '/copy-rows dev dbo.Clubs');
  await until(() => frame().includes('Insert up to 3 rows into dev (ClubB)?'), 'the copy question');
  app.stdin.write('1');
  await until(() => texts().length === 5, 'the copy in the log');
  assert.equal(texts()[0], '/copy-rows dbo.Clubs from demo/ClubA to dev/ClubB · 3 rows inserted, personal data made up');
  await command(app, '/backup t.bak');
  await until(() => texts().length === 6, 'the backup in the log');
  assert.equal(texts()[0], 'BACKUP DATABASE ClubA on demo');

  await command(app, '/timeline');
  await until(() => frame().includes("The family's timeline · shop"), 'the timeline');
  assert.match(frame(), /now +Trawl +BACKUP DATABASE ClubA on demo/);
  assert.match(frame(), /now +Trawl +COMMIT on demo\/ClubA/);
  assert.doesNotMatch(frame(), /Restarted api/);
  app.stdin.write('p');
  await until(() => frame().includes("The family's timeline · all projects") && frame().includes('Restarted api'), 'every project');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('Trawl · backup ·'), 'the entry whole');
  assert.ok(frame().includes(project));
  app.stdin.write(KEYS.esc);
  await until(() => !frame().includes('Trawl · backup ·'), 'closed');

  await command(app, '/wiring');
  await until(() => frame().includes('Wiring: shop'), 'the wiring');
  assert.match(frame(), /ConnectionStrings:Default +Server=db\.local;Database=Shop;User Id=app;Password=••••;/);
  assert.match(frame(), /Api:BaseUrl +https:\/\/api\.shop\.local/);
  assert.match(frame(), /REDIS_URL +redis:\/\/:••••@cache:6379/);
  assert.doesNotMatch(frame(), /hunter2|topsecret|Logging/);
  app.unmount();
});
