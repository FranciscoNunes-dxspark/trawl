// The family: /take and /share. The pure
// parts (siblings.js), then the real UI against the demo, in app.test.js's style.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { DEMO_CONNECTIONS } from '../src/connections.js';
import { contextIn, takeLine } from '../src/family.js';
import { connectionForQuery, handOverText, rowsContext, rowsScript } from '../src/siblings.js';
import { App } from '../src/ui/App.jsx';

const KEYS = { enter: '\r', esc: '\x1b', down: '\x1b[B' };

let base;
before(() => {
  base = mkdtempSync(join(tmpdir(), 'trawl-family-'));
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
function start(connection = 'demo', props = {}, extra = {}) {
  const config = { connections: [...DEMO_CONNECTIONS], history: [], ran: [], limit: 500, last: null, ...extra };
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

test('handing over: what the log says', () => {
  assert.equal(handOverText('Splice', '/open C:\\repo'), "Copied for Splice: paste it into Splice's prompt\n/open C:\\repo");
  assert.equal(handOverText('Hail', 'x', { kind: 'request', data: { method: 'GET', url: '{{host}}/a' } }), "Copied for Hail: paste it into Hail's prompt\nrequest GET {{host}}/a");
});

test('rows: from a set, without secrets, and back as an INSERT; the connection a query was for', () => {
  const set = { columns: [{ name: 'Id' }, { name: 'Name' }, { name: 'PasswordHash' }, { name: 'Born' }], rows: [[1, "O'Neil", 'abc', new Date('1990-01-02T00:00:00Z')], [2, 'B', 'def', null]] };
  const r = rowsContext(set, [0], { table: 'dbo.People', server: 'srv', database: 'Db' });
  assert.deepEqual(r.hidden, ['PasswordHash']);
  assert.deepEqual(contextIn(r.line).data, { server: 'srv', database: 'Db', table: 'dbo.People', columns: ['Id', 'Name', 'PasswordHash', 'Born'], rows: [[1, "O'Neil", null, '1990-01-02 00:00:00']] });
  assert.equal(rowsScript(contextIn(r.line).data), "-- 1 row of dbo.People from srv/Db, handed over. Nothing has run: read it, then R runs it.\nINSERT INTO [dbo].[People] ([Id], [Name], [PasswordHash], [Born]) VALUES\n  (1, N'O''Neil', NULL, N'1990-01-02 00:00:00');\n");
  assert.match(rowsScript({ columns: ['a'], rows: [[true]] }, { quote: (n) => `"${n}"`, kind: 'postgres' }), /put its name in place of <table>\.\nINSERT INTO <table> \("a"\) VALUES\n {2}\(TRUE\);/);
  const conns = [...DEMO_CONNECTIONS, { name: 'shop', server: 'tcp:Shop.database.windows.net,1433', database: 'Shop' }];
  assert.equal(connectionForQuery(conns, { server: 'shop.database.windows.net', database: 'shop' }).name, 'shop');
  assert.equal(connectionForQuery(conns, { server: 'shop.database.windows.net', database: 'Other' }).name, 'shop');
  assert.equal(connectionForQuery(conns, { server: 'elsewhere.example.com', database: 'Shop' }), null);
  assert.equal(connectionForQuery(conns, { server: 'demo', database: 'ClubA' }).name, 'demo');
});

test('/take query puts the SQL in a console tab on its connection; /take rows an INSERT', async () => {
  const app = start('demo');
  await until(() => frame().includes('Clubs'), 'the explorer');
  await command(app, `take ${takeLine('query', { sql: 'SELECT * FROM dbo.Matches', server: 'demo', database: 'ClubB' })}`);
  await until(() => frame().includes('demo/ClubB') && frame().includes('SELECT * FROM dbo.Matches'), 'the query, on ClubB');
  assert.match(frame(), /\[2 take\]/);
  await command(app, `take ${takeLine('rows', { table: 'dbo.Clubs', columns: ['Id', 'Name'], rows: [[9, 'New FC']] })}`);
  await until(() => frame().includes("(9, N'New FC')"), 'the rows as an INSERT');
  assert.match(frame(), /\[3 rows\]/);
  app.unmount();
});

test('t in Results copies the row as /take rows for Hail; t in the console the statement as /take query', async () => {
  const copied = [];
  const app = start('demo', { clipboard: async (text) => (copied.push(text), 'system') });
  await until(() => frame().includes('Clubs'), 'the explorer');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('Club A FC'), 'the clubs');
  app.stdin.write('j');
  await until(() => /❯ +2 /.test(frame()), 'the cursor on the second club');
  app.stdin.write('t');
  await until(() => frame().includes("Copied for Hail: paste it into Hail's prompt"), 'the row copied');
  assert.match(frame(), /1 row of dbo\.Clubs/);
  assert.deepEqual(contextIn(copied.at(-1)).data, { server: 'demo', database: 'ClubA', table: 'dbo.Clubs', columns: ['Id', 'Name', 'Country', 'Founded', 'Active'], rows: [[2, 'Atlético Norte', 'ES', '1921-09-01', true]] });
  await command(app, 'share all');
  await until(() => frame().includes('3 rows of dbo.Clubs'), 'all the rows copied');
  app.stdin.write('2');
  await until(() => frame().includes('Query'), 'the console');
  app.stdin.write('i');
  await until(() => frame().includes('typing SQL'), 'typing');
  await type(app.stdin, 'SELECT 1 AS one');
  app.stdin.write(KEYS.esc);
  await new Promise((r) => setTimeout(r, 100));
  app.stdin.write('t');
  await until(() => frame().includes("Copied for Trawl: paste it into Trawl's prompt"), 'the query copied');
  assert.deepEqual(contextIn(copied.at(-1)), { kind: 'query', data: { sql: 'SELECT 1 AS one', server: 'demo', database: 'ClubA' } });
  app.unmount();
});

