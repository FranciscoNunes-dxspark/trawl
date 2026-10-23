// /copy-rows: rows to another connection with the rows they refer to, personal data made up. The pure
// builder, then the real UI against the demo, in app.test.js's style.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { DEMO_CONNECTIONS } from '../src/connections.js';
import { DIALECTS } from '../src/dialects.js';
import { copyRefusal, copyScript, insertOrder, insertedRows, keyTuples, maskRows, parentSql, parseCopyRowsArgs, personalKind, rowsSql, selfOrder } from '../src/copyrows.js';
import { fakeValue } from '../src/generate.js';
import { demoSession } from '../src/demo.js';
import { App } from '../src/ui/App.jsx';

const KEYS = { enter: '\r', esc: '\x1b', down: '\x1b[B' };

let base;
before(() => {
  base = mkdtempSync(join(tmpdir(), 'trawl-copy-'));
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
// A dev database besides the demo's two, to copy into.
const DEV = { name: 'dev', demo: true, server: 'demo', database: 'ClubB' };
function start(connection = 'demo', props = {}) {
  const config = { connections: [...DEMO_CONNECTIONS, DEV], history: [], ran: [], limit: 500, last: null };
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

const col = (name, type, extra = {}) => ({ name, type, nullable: false, identity: false, pk: false, ...extra });
const clubs = { schema: 'dbo', name: 'Clubs', kind: 'table', columns: [col('Id', 'int', { pk: true, identity: true }), col('Name', 'nvarchar(100)')] };
const people = {
  schema: 'dbo',
  name: 'People',
  kind: 'table',
  columns: [col('Id', 'int', { pk: true, identity: true }), col('ClubId', 'int'), col('ManagerId', 'int', { nullable: true }), col('Name', 'nvarchar(100)'), col('Email', 'varchar(200)'), col('IBAN', 'varchar(34)'), col('Joined', 'date'), col('Total', 'int', { computed: true })],
};
const fks = [
  { name: 'FK_People_Clubs', from: 'dbo.People', to: 'dbo.Clubs', columns: [['ClubId', 'Id']] },
  { name: 'FK_People_Manager', from: 'dbo.People', to: 'dbo.People', columns: [['ManagerId', 'Id']] },
];
const set = (obj, rows) => ({ columns: obj.columns.map((c) => ({ name: c.name, type: c.type })), rows });

test('the arguments: a target, a table, a condition to the end, and --no-mask anywhere', () => {
  assert.deepEqual(parseCopyRowsArgs('dev dbo.Players --where Id < 5 AND ClubId = 1'), { target: 'dev', table: 'dbo.Players', where: 'Id < 5 AND ClubId = 1', mask: true });
  assert.deepEqual(parseCopyRowsArgs('--no-mask dev --where "Name = \'x\'"'), { target: 'dev', table: null, where: "Name = 'x'", mask: false });
  assert.throws(() => parseCopyRowsArgs('dev t --where'), /takes a condition/);
  assert.throws(() => parseCopyRowsArgs('a b c'), /Too many/);
});

test('personal columns by name, and fakes that are the same for the same value and keep their shape', () => {
  for (const [c, k] of [['Email', 'email'], ['mobile_phone', 'phone'], ['FirstName', 'first'], ['last_name', 'last'], ['AddressLine1', 'street'], ['City', 'city'], ['PostalCode', 'zip'], ['DateOfBirth', 'birth'], ['SSN', 'scramble'], ['NIF', 'scramble'], ['IBAN', 'scramble'], ['CardNumber', 'scramble'], ['PassportNo', 'scramble'], ['IpAddress', 'ip'], ['LastLoginIp', 'ip']]) assert.equal(personalKind(c, 'Customers'), k, c);
  assert.equal(personalKind('Name', 'Players'), 'person');
  assert.equal(personalKind('Name', 'Clubs'), null);
  assert.equal(personalKind('Membership', 'Clubs'), null);
  assert.equal(personalKind('Goals', 'Players'), null);
  const a = fakeValue('email', 'ana@club.pt', col('Email', 'varchar(200)'));
  assert.equal(fakeValue('email', 'ana@club.pt', col('Email', 'varchar(200)')), a);
  assert.notEqual(fakeValue('email', 'rui@club.pt', col('Email', 'varchar(200)')), a);
  assert.match(a, /@example\.com$/);
  const iban = fakeValue('scramble', 'PT50000201231234567890154', col('IBAN', 'varchar(34)'));
  assert.match(iban, /^[A-Z]{2}\d{23}$/);
  assert.notEqual(iban, 'PT50000201231234567890154');
  assert.ok(fakeValue('birth', new Date('1990-05-03'), col('Born', 'date')) instanceof Date);
  assert.equal(fakeValue('first', null, col('FirstName', 'nvarchar(50)')), null);
  const rows = [[1, 1, null, 'Ana Silva', 'ana@club.pt', 'PT50000201231234567890154', new Date('2020-01-01'), 0], [2, 1, 1, 'Ana Silva', 'ana@club.pt', 'PT50000201231234567890154', new Date('2020-01-01'), 0]];
  const m = maskRows(people, set(people, rows));
  assert.deepEqual(m.masked, ['Name', 'Email', 'IBAN']);
  assert.notEqual(m.rows[0][3], 'Ana Silva');
  assert.deepEqual(m.rows[0].slice(3, 6), m.rows[1].slice(3, 6));
  assert.deepEqual(m.rows[0].slice(0, 3), [1, 1, null]);
});

test('the reads, the order parents first, and a table referring to itself', () => {
  const d = DIALECTS.sqlserver;
  assert.equal(rowsSql(d, people, { where: 'Id < 3', limit: 500 }), '-- trawl:copy-rows read\nSELECT TOP (500) * FROM [dbo].[People] WHERE Id < 3;');
  const s = set(people, [[3, 2, 1, 'C', 'c@x', 'X', null, 0], [1, 1, null, 'A', 'a@x', 'X', null, 0], [2, 1, 1, 'B', 'b@x', 'X', null, 0]]);
  assert.deepEqual(keyTuples(s, ['ClubId']), [[2], [1]]);
  assert.deepEqual(parentSql(d, clubs, ['Id'], [[2], [1]]), ['-- trawl:copy-rows read\nSELECT * FROM [dbo].[Clubs] WHERE [Id] IN (2, 1);']);
  assert.deepEqual(parentSql(DIALECTS.postgres, clubs, ['Id', 'Name'], [[1, "O'Neil"]]), [`-- trawl:copy-rows read\nSELECT * FROM "dbo"."Clubs" WHERE ("Id" = 1 AND "Name" = 'O''Neil');`]);
  const groups = new Map([['dbo.People', { obj: people, set: s }], ['dbo.Clubs', { obj: clubs, set: set(clubs, [[1, 'A'], [2, 'B']]) }]]);
  assert.deepEqual(insertOrder(groups, fks), { order: ['dbo.Clubs', 'dbo.People'], cycle: false });
  const ordered = selfOrder(people, s, fks).map((r) => r[0]);
  assert.ok(ordered.indexOf(1) < ordered.indexOf(3) && ordered.indexOf(1) < ordered.indexOf(2), `the manager first: ${ordered}`);
  assert.equal(copyRefusal({ ...clubs, columns: [col('Name', 'nvarchar(10)')] }), 'dbo.Clubs has no primary key, so a row already in the target can\'t be told from a new one');
  assert.equal(copyRefusal(clubs), null);
});

test('the script skips rows already there, each kind its own way', () => {
  const tables = [{ obj: clubs, set: set(clubs, []), rows: [[1, 'Club A']] }, { obj: people, set: set(people, []), rows: [[1, 1, null, 'A', 'a@x', 'X', new Date('2020-01-02T00:00:00Z'), 5]] }];
  const ss = copyScript(tables, DIALECTS.sqlserver, { head: ['from prod'] });
  assert.equal(ss.rows, 2);
  assert.match(ss.script, /^-- trawl:copy-rows insert\n-- from prod\nSET XACT_ABORT ON;\nBEGIN TRANSACTION;/);
  assert.match(ss.script, /SET IDENTITY_INSERT \[dbo\]\.\[Clubs\] ON;\nIF NOT EXISTS \(SELECT 1 FROM \[dbo\]\.\[Clubs\] WHERE \[Id\] = 1\) INSERT INTO \[dbo\]\.\[Clubs\] \(\[Id\], \[Name\]\) VALUES \(1, N'Club A'\);\nSET IDENTITY_INSERT \[dbo\]\.\[Clubs\] OFF;/);
  // The computed column is left out.
  assert.match(ss.script, /INSERT INTO \[dbo\]\.\[People\] \(\[Id\], \[ClubId\], \[ManagerId\], \[Name\], \[Email\], \[IBAN\], \[Joined\]\) VALUES \(1, 1, NULL, N'A', 'a@x', 'X', '2020-01-02'\);/);
  assert.match(ss.script, /COMMIT TRANSACTION;\n$/);
  const pg = copyScript(tables, DIALECTS.postgres).script;
  assert.match(pg, /^-- trawl:copy-rows insert\nBEGIN;/);
  assert.match(pg, /INSERT INTO "dbo"."Clubs" \("Id", "Name"\) OVERRIDING SYSTEM VALUE VALUES \(1, 'Club A'\) ON CONFLICT DO NOTHING;/);
  const my = copyScript(tables, DIALECTS.mysql).script;
  assert.match(my, /START TRANSACTION;/);
  assert.match(my, /INSERT IGNORE INTO `dbo`.`Clubs` \(`Id`, `Name`\) VALUES \(1, 'Club A'\);/);
  assert.equal(insertedRows(['1 row affected', '2 rows affected', 'other']), 3);
});

test('/copy-rows copies the rows on screen and the clubs they refer to, masked, after showing the script', async () => {
  // What runs on dev, as it gets there.
  const ran = [];
  const open = (conn, opts) => {
    const s = demoSession(conn, opts);
    if (conn.name !== 'dev') return s;
    const run = s.run;
    s.run = (script, o) => (ran.push(script), run(script, o));
    return s;
  };
  const app = start('demo', { open });
  await until(() => frame().includes('Clubs'), 'the explorer');
  app.stdin.write(KEYS.down);
  await until(() => /❯ T Players/.test(frame()), 'the cursor on Players');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('Rui Costa'), 'the players');
  await command(app, 'copy-rows dev');
  await until(() => frame().includes('Insert up to 15 rows into dev (ClubB)?'), 'the question under the script');
  assert.match(frame(), /12 rows of dbo\.Players, and the rows they refer to in dbo\.Clubs: from demo\/ClubA to dev\/ClubB\./);
  assert.match(frame(), /Personal data made up/);
  assert.match(frame(), /SET IDENTITY_INSERT \[dbo\]\.\[Clubs\] ON;/);
  app.stdin.write('1');
  await until(() => frame().includes('15 rows went in'), 'the rows copied');
  const script = ran.find((x) => x.startsWith('-- trawl:copy-rows insert'));
  // Parents first, and the players' names made up (the clubs' aren't people's).
  assert.ok(script.indexOf('[dbo].[Clubs]') < script.indexOf('[dbo].[Players]'));
  assert.match(script, /Personal data made up \(the same value always gets the same fake, so joins still meet\): Players\.Name\./);
  assert.match(script, /N'Club A FC'/);
  assert.doesNotMatch(script, /Rui Costa|Ana Silva/);
  assert.equal((script.match(/IF NOT EXISTS/g) ?? []).length, 15);
  app.unmount();
});

test('C in the Explorer picks the target, and a production target is refused', async () => {
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  await command(app, 'copy-rows demo-prod dbo.Clubs');
  await until(() => frame().includes('demo-prod is production: /copy-rows only writes to a connection that is neither'), 'production refused');
  app.stdin.write('C');
  await until(() => frame().includes("Copy dbo.Clubs's rows to"), 'the targets');
  assert.match(frame(), /❯ dev/);
  assert.doesNotMatch(frame(), /❯ demo-prod|^│ +demo-prod/m);
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('Insert up to 3 rows into dev (ClubB)?'), 'the question');
  app.stdin.write('2');
  await until(() => !frame().includes('Insert up to 3 rows'), 'the question answered no');
  assert.doesNotMatch(frame(), /went in/);
  app.unmount();
});
