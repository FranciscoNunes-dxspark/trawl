// The family: /take, /share, /family, pasting a command over a view, and the mascots' moods. The pure
// parts (siblings.js), then the real UI against the demo, in app.test.js's style.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { DEMO_CONNECTIONS } from '../src/connections.js';
import { contextIn, projectAt, readMoods, shareLine, takeLine, writeMood } from '../src/family.js';
import { connectionForQuery, familyMood, familyOffers, moodsToShow, reactionText, rowsContext, rowsScript } from '../src/siblings.js';
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

test('what a project offers the others', () => {
  const dir = mkdtempSync(join(base, 'proj-'));
  mkdirSync(join(dir, '.git'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'node a.js' } }));
  mkdirSync(join(dir, 'http'));
  writeFileSync(join(dir, 'http', 'api.http'), 'GET https://x\n');
  const offers = familyOffers(projectAt(dir));
  assert.deepEqual(offers.map((o) => o.app), ['splice', 'bosun', 'hail']);
  // Quoted when it has to be: a space, or Windows' backslashes.
  assert.equal(offers[0].line, shareLine('open', [dir]));
  assert.equal(offers[1].line, shareLine('move', [dir]));
  assert.equal(offers[2].line, shareLine('open', [join(dir, 'http', 'api.http')]));
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

test('moods: Glim\'s in the family\'s words, which of the others it reacts to, and how it says so', () => {
  const session = { conn: { name: 'dev' }, database: 'Shop' };
  assert.deepEqual(familyMood('alert', { session, tranMinutes: 20.4 }), { mood: 'worried', reason: 'transaction open 20 min on dev/Shop' });
  assert.deepEqual(familyMood('worried', { session, lastEntry: { lines: ["Invalid object name 'x'."] } }), { mood: 'sad', reason: "query failed on dev/Shop: Invalid object name 'x'." });
  assert.equal(familyMood('look', { busy: { label: 'Running' } }).mood, 'busy');
  assert.equal(familyMood('happy', { session }).mood, 'happy');
  assert.deepEqual(familyMood('sleep'), { mood: 'neutral', reason: 'not connected' });
  const moods = [{ app: 'sonar', mood: 'worried', reason: 'production has 12 new exceptions', at: 2 }, { app: 'bosun', mood: 'busy', reason: 'x', at: 1 }, { app: 'hail', mood: 'happy', reason: '', at: 3 }];
  assert.deepEqual(moodsToShow(moods, new Set(['hail:3'])).map((m) => m.app), ['sonar']);
  assert.equal(reactionText(moods[0]), 'Ping says: production has 12 new exceptions');
  assert.equal(reactionText(moods[2]), 'Hoot is happy');
});

test('/take query puts the SQL in a console tab on its connection; /take rows an INSERT; others say whose they are', async () => {
  const app = start('demo');
  await until(() => frame().includes('Clubs'), 'the explorer');
  await command(app, `take ${takeLine('query', { sql: 'SELECT * FROM dbo.Matches', server: 'demo', database: 'ClubB' })}`);
  await until(() => frame().includes('demo/ClubB') && frame().includes('SELECT * FROM dbo.Matches'), 'the query, on ClubB');
  assert.match(frame(), /\[2 take\]/);
  await command(app, `take ${takeLine('rows', { table: 'dbo.Clubs', columns: ['Id', 'Name'], rows: [[9, 'New FC']] })}`);
  await until(() => frame().includes("(9, N'New FC')"), 'the rows as an INSERT');
  assert.match(frame(), /\[3 rows\]/);
  await command(app, `take ${takeLine('commit', { hash: 'abc1234def', subject: 'Fix it' })}`);
  await until(() => frame().includes("That's commit abc1234def Fix it, for Splice or Sonar"), 'whose it is');
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
  await until(() => frame().includes("Copied for Trawl or Hail: paste it into one's prompt"), 'the row copied');
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

test('a command or a context pasted over a view goes into the prompt, and ↵ runs it', async () => {
  const app = start('demo');
  await until(() => frame().includes('Clubs'), 'the explorer');
  const line = takeLine('query', { sql: 'SELECT 2 AS two' });
  app.stdin.write(`${line.replace(/^\/take /, '')}\r`);
  await until(() => frame().includes('> family:v1:query:'), 'the context in the prompt');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('SELECT 2 AS two'), 'taken');
  assert.match(frame(), /didn't say which database it was for/);
  app.stdin.write('1');
  await until(() => frame().includes('Explorer') && !frame().includes('typing SQL'), 'the explorer');
  app.stdin.write('/limit 77\n');
  await until(() => frame().includes('> /limit 77'), 'the command in the prompt, not run');
  app.stdin.write(KEYS.enter);
  await until(() => /77/.test(frame()) && !frame().includes('> /limit 77'), 'the command run');
  app.unmount();
});

test('/family lists what the project offers the others, and ↵ copies the line', async () => {
  const dir = mkdtempSync(join(base, 'repo-'));
  mkdirSync(join(dir, '.git'));
  writeFileSync(join(dir, 'api.http'), 'GET https://x\n');
  const copied = [];
  const app = start('demo', { projectDir: dir, clipboard: async (text) => (copied.push(text), 'system') });
  await until(() => frame().includes('Clubs'), 'the explorer');
  await command(app, 'family');
  await until(() => frame().includes('offers the family'), 'the list');
  assert.match(frame(), /❯ Splice +\/open/);
  assert.match(frame(), /Hail +\/open /);
  assert.doesNotMatch(frame(), /Bosun/);
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes("Copied for Splice: paste it into Splice's prompt"), 'copied for Splice');
  assert.equal(copied.at(-1), shareLine('open', [dir]));
  app.unmount();
});

test('Glim writes its mood for the family, and says once what a sibling is worried about', async () => {
  const home = mkdtempSync(join(base, 'family-'));
  writeMood('sonar', { mood: 'worried', reason: 'production has 12 new exceptions' }, { dir: home });
  const app = start('demo', { familyHome: home, moodEvery: 200 });
  await until(() => frame().includes('Ping says: production has 12 new exceptions'), 'the reaction');
  await until(() => readMoods('sonar', { dir: home }).some((m) => m.app === 'trawl'), 'Glim\'s mood written');
  app.stdin.write(KEYS.esc);
  await until(() => !frame().includes('Ping says'), 'dismissed');
  // Shown once: reading again doesn't bring it back, but a new one comes.
  await new Promise((r) => setTimeout(r, 500));
  assert.doesNotMatch(frame(), /Ping says/);
  writeMood('hail', { mood: 'sad', reason: 'POST /orders failed: 500' }, { dir: home });
  await until(() => frame().includes('Hoot says: POST /orders failed: 500'), 'the next reaction');
  app.unmount();
  // Turned off in Settings, nothing is read or written.
  const quiet = mkdtempSync(join(base, 'quiet-'));
  writeMood('sonar', { mood: 'sad', reason: 'down' }, { dir: quiet });
  const off = start('demo', { familyHome: quiet, moodEvery: 100 }, { familyMoods: false });
  await until(() => frame().includes('Clubs'), 'the explorer');
  await new Promise((r) => setTimeout(r, 400));
  assert.doesNotMatch(frame(), /Ping says/);
  assert.ok(!readMoods('sonar', { dir: quiet }).some((m) => m.app === 'trawl'));
  off.unmount();
});
