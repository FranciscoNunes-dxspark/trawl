// End-to-end tests of the features added after the first app.test.js ones, in its style: the real
// UI against the demo connections, keys in, frames out. The helpers are copied from app.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { EventEmitter } from 'node:events';
import { DEMO_CONNECTIONS } from '../src/connections.js';
import { postgresSession } from '../src/db-postgres.js';
import { DIALECTS, splitScript } from '../src/dialects.js';
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

test('Activity lists the blocking chain as a tree, and x kills the session at its head after asking', async () => {
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  app.stdin.write('6');
  await until(() => frame().includes('blocked by 53') && frame().includes('blocked by 61'), 'the blocking chain');
  assert.match(frame(), /❯\s+53 sleeping\s+▲2/);
  assert.match(frame(), /└\s+61 blocked by 53/);
  assert.match(frame(), /─ Session 53 ─/);
  assert.doesNotMatch(frame(), /\b72 sleeping/, 'idle sessions only with a');
  app.stdin.write('a');
  await until(() => /\b72 sleeping/.test(frame()), 'the idle sessions too');
  app.stdin.write('a');
  await until(() => !/\b72 sleeping/.test(frame()), 'only the busy ones again');
  app.stdin.write('x');
  await until(() => frame().includes('Kill session 53 (app_user · WEB01 · Club website)?'), 'the question');
  app.stdin.write('1');
  await until(() => frame().includes('KILL 53') && !frame().includes('blocked by 53'), 'the session gone');
  assert.match(frame(), /61 running/);
  app.unmount();
});

test('/kill is refused on a read-only connection', async () => {
  const app = start('demo-prod');
  await until(() => frame().includes('PROD') && frame().includes('Clubs'), 'the production connection');
  await command(app, '/activity');
  await until(() => frame().includes('blocked by 53'), 'the activity');
  app.stdin.write('x');
  await until(() => frame().includes("demo-prod is read-only (production), and KILL ends someone's session"), 'the refusal');
  assert.match(frame(), /blocked by 53/);
  app.unmount();
});

test('/fanout runs one query on every connection in a folder, rows tagged by connection, failures said', async () => {
  const connections = [
    ...DEMO_CONNECTIONS,
    { name: 'club-a', demo: true, server: 'demo', database: 'ClubA', folder: 'Clubs' },
    { name: 'club-b', demo: true, server: 'demo', database: 'ClubB', folder: 'Clubs/North' },
    { name: 'club-gone', demo: true, server: 'demo', database: 'ClubZ', folder: 'Clubs' },
  ];
  const app = start('demo', {}, { connections });
  await until(() => frame().includes('Clubs'), 'the explorer');
  await command(app, '/fanout Clubs DELETE FROM dbo.Clubs WHERE Id = 1');
  await until(() => frame().includes('/fanout only reads'), 'the write refused');
  await command(app, '/fanout clubs SELECT TOP (3) * FROM dbo.Clubs');
  await until(() => frame().includes('Club B FC') && frame().includes('Club A FC'), 'the merged rows');
  assert.match(frame(), /connection │ database │\s+Id/);
  assert.match(frame(), /club-a\s+│ ClubA\s+│\s+1 │ Club A FC/);
  assert.match(frame(), /club-b\s+│ ClubB\s+│\s+1 │ Club B FC/);
  assert.match(frame(), /2 of 3 connections answered/);
  assert.match(frame(), /club-gone \(ClubZ\): Cannot open database "ClubZ"/);
  // Each connection's run is in History.
  app.stdin.write('4');
  await until(() => frame().includes('club-b/ClubB'), 'History');
  app.unmount();
});

test('/diff compares this database with another, and puts the sync script in the console when asked', async () => {
  mkdirSync(process.env.TRAWL_HOME, { recursive: true });
  writeFileSync(join(process.env.TRAWL_HOME, 'console.sql'), '');
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  await command(app, '/diff ClubB');
  await until(() => frame().includes('Schema diff: demo/ClubA ←→ demo/ClubB') && frame().includes('Put the script'), 'the differences and the question');
  assert.match(frame(), /~ Shirt: tinyint null → smallint null/);
  assert.match(frame(), /> dbo\.Stadiums/);
  app.stdin.write('1');
  await until(() => frame().includes('-- Makes demo/ClubA match demo/ClubB') && frame().includes('typing SQL'), 'the script in the console');
  assert.doesNotMatch(frame(), /ALTER COLUMN.*rows affected/);
  app.unmount();
});

test('F on a foreign key cell opens the row it refers to, and on a key others refer to asks which way', async () => {
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  app.stdin.write('j');
  await until(() => /❯ T Players/.test(frame()), 'the cursor on Players');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('Rui Costa'), 'the players');
  app.stdin.write('l');
  await new Promise((r) => setTimeout(r, 100));
  app.stdin.write('F');
  await until(() => frame().includes('SELECT TOP (500) * FROM [dbo].[Clubs] WHERE [Id] = 1;'), 'the club row');
  // On Clubs.Id, three foreign keys point back: it asks.
  app.stdin.write('h');
  await new Promise((r) => setTimeout(r, 100));
  app.stdin.write('F');
  await until(() => frame().includes('Follow which foreign key?'), 'the question');
  assert.match(frame(), /dbo\.Players where ClubId = 1 \(rows referring to this one\) \(FK_Players_Clubs\)/);
  app.stdin.write(KEYS.down);
  await until(() => /❯ 2\. dbo\.Matches where HomeId/.test(frame()), 'the second way picked');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('SELECT TOP (500) * FROM [dbo].[Matches] WHERE [HomeId] = 1;'), 'the matches');
  app.unmount();
});

test('S saves the console statement as a snippet; running it asks for its @parameters first', async () => {
  mkdirSync(process.env.TRAWL_HOME, { recursive: true });
  writeFileSync(join(process.env.TRAWL_HOME, 'console.sql'), 'DECLARE @n int = 1\nSELECT * FROM dbo.Players WHERE Id = @id AND @n = 1');
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  app.stdin.write('2');
  await until(() => frame().includes('WHERE Id = @id'), 'the console');
  app.stdin.write('S');
  await until(() => frame().includes('/snippet save'), 'the prompt');
  await command(app, 'player by id');
  await until(() => frame().includes('Saved the snippet player by id for demo'), 'saved');
  await command(app, '/snippets');
  await until(() => frame().includes('Snippets: demo') && frame().includes('player by id'), 'the list');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('Value for @id') && frame().includes('type the value'), 'the question for @id, and only @id');
  assert.doesNotMatch(frame(), /Value for @n/);
  app.stdin.write(KEYS.esc);
  await until(() => !frame().includes('Value for @id'), 'cancelled');
  await command(app, '/snippet player by id');
  await until(() => frame().includes('Value for @id'), 'asked again');
  await type(app.stdin, '3');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('player by id: DECLARE @n int = 1 SELECT * FROM dbo.Players WHERE Id = 3 AND @n = 1'), 'the run, with the value in place');
  const config = JSON.parse(readFileSync(join(process.env.TRAWL_HOME, 'config.json'), 'utf8'));
  assert.equal(config.snippets[0].conn, 'demo');
  app.unmount();
});

test('console tabs: + opens one, [ and ] switch, each keeps its own text and file, /tab renames and closes', async () => {
  mkdirSync(process.env.TRAWL_HOME, { recursive: true });
  writeFileSync(join(process.env.TRAWL_HOME, 'console.sql'), 'SELECT 1 AS first');
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  app.stdin.write('2');
  await until(() => frame().includes('SELECT 1 AS first'), 'the console');
  app.stdin.write('+');
  await until(() => frame().includes('Console 1 console [2 query]') && frame().includes('typing SQL'), 'a new tab, typing');
  await type(app.stdin, 'SELECT 2 AS second');
  app.stdin.write(KEYS.esc);
  await until(() => frame().includes('↵/i type'), 'out of typing');
  app.stdin.write('[');
  await until(() => frame().includes('Console [1 console] 2 query') && frame().includes('SELECT 1 AS first'), 'the first tab');
  assert.doesNotMatch(frame(), /SELECT 2 AS second/);
  app.stdin.write(']');
  await until(() => frame().includes('SELECT 2 AS second'), 'the second tab again');
  // Undo is per tab: here it takes back the typing, not the first tab's text.
  app.stdin.write('\x1a');
  await until(() => !frame().includes('SELECT 2 AS second'), 'undone');
  app.stdin.write('\x19');
  await until(() => frame().includes('SELECT 2 AS second'), 'redone');
  await command(app, '/tab rename scratch');
  await until(() => frame().includes('[2 scratch]'), 'renamed');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(readFileSync(join(process.env.TRAWL_HOME, 'consoles', 'query.sql'), 'utf8'), 'SELECT 2 AS second');
  const config = JSON.parse(readFileSync(join(process.env.TRAWL_HOME, 'config.json'), 'utf8'));
  assert.deepEqual(config.consoleTabs, [{ name: 'console', file: 'console.sql' }, { name: 'scratch', file: 'consoles/query.sql' }]);
  await command(app, '/tab close');
  await until(() => frame().includes('Close the console tab scratch?'), 'the question');
  app.stdin.write('1');
  await until(() => frame().includes('SELECT 1 AS first') && /╭─ Console ─/.test(frame()), 'back to one tab');
  app.unmount();
});

test('a .sql or .txt file dropped on the terminal opens in a console tab named after it, but not into a string', async () => {
  const dir = join(base, 'dropped folder');
  mkdirSync(dir, { recursive: true });
  const report = join(dir, 'top scorers.sql');
  writeFileSync(report, '﻿SELECT TOP 3 Name\r\nFROM dbo.Players;\r\n');
  const notes = join(dir, 'notes.txt');
  writeFileSync(notes, Buffer.from('﻿SELECT 42 AS answer', 'utf16le'));
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  // Dropped anywhere outside a text field, as the terminal types it: quoted, for the space.
  app.stdin.write(`"${report}"`);
  await until(() => frame().includes('[2 top-scorers]') && frame().includes('FROM dbo.Players;'), 'the file in a tab of its own');
  assert.match(frame(), /SELECT TOP 3 Name/);
  app.stdin.write('i');
  await until(() => frame().includes('typing SQL'), 'typing');
  // While typing too; SSMS's UTF-16 files read as text.
  app.stdin.write(`"${notes}"`);
  await until(() => frame().includes('[3 notes]') && frame().includes('SELECT 42 AS answer'), 'the second file');
  // Into a string, a path is text.
  await type(app.stdin, "'");
  app.stdin.write(`"${notes}"`);
  await until(() => frame().includes('notes.txt'), 'the path typed into the string');
  assert.doesNotMatch(frame(), /notes-2|\[4 /);
  app.unmount();
});

test('/import-csv opens the INSERTs in a console tab of their own, and --run goes through the usual checks', async () => {
  const csv = join(base, 'players.csv');
  writeFileSync(csv, 'ClubId;Name;Goals\r\n1;"Nova, Ana";3\r\n2;Rui;0\r\n');
  const app = start('demo-prod');
  await until(() => frame().includes('PROD') && frame().includes('Clubs'), 'the explorer');
  await command(app, `/import-csv ${csv} Players`);
  await until(() => frame().includes('[2 import]') && frame().includes("(1, N'Nova, Ana', 3),"), 'the script in its own tab');
  assert.match(frame(), /INSERT INTO \[dbo\]\.\[Players\] \(\[ClubId\], \[Name\], \[Goals\]\) VALUES/);
  assert.match(frame(), /-- Not in the file, and NOT NULL: Position/);
  await command(app, `/import-csv ${csv} dbo.Players --run`);
  await until(() => frame().includes('demo-prod is read-only (production)'), 'refused on a read-only connection');
  app.unmount();
});

test('p pins a result, and c after another run shows the rows added, removed and the same', async () => {
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  await command(app, '!SELECT 1 AS a');
  await until(() => frame().includes('─ SELECT 1 AS a ─'), 'the first result');
  app.stdin.write('c');
  await until(() => frame().includes('Pin a result first'), 'nothing pinned yet');
  app.stdin.write('p');
  await until(() => frame().includes('Pinned 1 row of SELECT 1 AS a'), 'pinned');
  await command(app, '!SELECT 2 AS a');
  await until(() => frame().includes('─ SELECT 2 AS a ─'), 'the second result');
  app.stdin.write('c');
  await until(() => frame().includes('Compared: SELECT 1 AS a → now'), 'the comparison');
  assert.match(frame(), /change │ a\s+│ was/);
  assert.match(frame(), /\+\s+│ 2\s+│ NULL/);
  assert.match(frame(), /−\s+│ 1\s+│ NULL/);
  assert.match(frame(), /0 changed · 1 added · 1 removed · 0 the same \(whole rows compared\)/);
  app.unmount();
});

test('a long run ends with a notification, unless Settings turns it off', async () => {
  const told = [];
  const app = start('demo', { notify: (title, body) => told.push([title, body]) }, { notifyAfter: 0.5 });
  await until(() => frame().includes('Clubs'), 'the explorer');
  await command(app, '!SELECT 1 AS quick');
  await until(() => frame().includes('quick'), 'a quick run');
  await command(app, "!WAITFOR DELAY '00:00:01'");
  await until(() => told.length === 1, 'the notification');
  assert.equal(told[0][0], "Trawl: WAITFOR DELAY '00:00:01'");
  assert.match(told[0][1], /\d+ ms/);
  app.stdin.write(',');
  await until(() => frame().includes('Row limit'), 'Settings');
  app.stdin.write('G');
  await until(() => /❯ Notify when done\s+on\s+after 0\.5 s/.test(frame()), 'the notify row');
  app.stdin.write(KEYS.enter);
  await until(() => /Notify when done\s+off/.test(frame()), 'turned off');
  app.stdin.write(KEYS.esc);
  await until(() => !frame().includes('Row limit'), 'Settings closed');
  await command(app, "!WAITFOR DELAY '00:00:01'");
  await until(() => frame().includes('esc to cancel'), 'the second run');
  await until(() => !frame().includes('esc to cancel'), 'its end');
  assert.equal(told.length, 1);
  app.unmount();
});

test('a on a plan asks Claude to explain it (the query and plan, no rows), and not when the connection is closed to Claude', async () => {
  mkdirSync(process.env.TRAWL_HOME, { recursive: true });
  writeFileSync(join(process.env.TRAWL_HOME, 'console.sql'), 'SELECT * FROM dbo.Players WHERE Goals > 3');
  const asked = [];
  const askClaude = async ({ prompt, system }) => (asked.push({ prompt, system }), 'It scans the whole of Players.\nAn index on Goals would help.');
  const app = start('demo', { askClaude });
  await until(() => frame().includes('Clubs'), 'the explorer');
  app.stdin.write('2');
  await until(() => frame().includes('WHERE Goals > 3'), 'the console');
  app.stdin.write('p');
  await until(() => frame().includes('Clustered Index Scan') && frame().includes('a Claude explains it'), 'the plan');
  app.stdin.write('a');
  await until(() => frame().includes('Claude on the plan: SELECT * FROM dbo.Players WHERE Goals > 3') && frame().includes('An index on Goals would help.'), 'the explanation');
  assert.equal(asked.length, 1);
  assert.match(asked[0].prompt, /Query:\nSELECT \* FROM dbo\.Players WHERE Goals > 3\n\nEstimated plan \(SHOWPLAN_TEXT\):\n.*Clustered Index Scan/s);
  assert.match(asked[0].system, /execution plans/);
  assert.doesNotMatch(asked[0].prompt, /Rui Costa/, 'no rows');
  app.stdin.write(KEYS.esc);
  await until(() => !frame().includes('Claude on the plan'), 'closed');
  await command(app, '/ai off');
  await until(() => frame().includes('Claude may now see nothing of demo'), 'closed to Claude');
  await command(app, '/explain');
  await until(() => frame().includes('demo is closed to Claude'), 'the refusal');
  assert.equal(asked.length, 1);
  await command(app, '/ai results');
  await until(() => frame().includes('Claude may now see schema and results of demo'), 'open again');
  app.unmount();
});

test('? opens on the section for the view on screen; j k pick another, / searches them all, esc clears and then closes', async () => {
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  app.stdin.write('3');
  await until(() => frame().includes('╭─ Results'), 'Results');
  app.stdin.write('?');
  await until(() => frame().includes('❯ Results') && frame().includes('The row as a record'), 'the Results section');
  app.stdin.write('j');
  await until(() => frame().includes('❯ History') && frame().includes('Run it again'), 'History');
  app.stdin.write('/');
  await type(app.stdin, 'kill');
  await until(() => frame().includes('Matches for “kill”') && frame().includes('Kill the session'), 'the matches');
  assert.doesNotMatch(frame(), /Run it again/);
  app.stdin.write(KEYS.esc);
  await until(() => frame().includes('❯ Activity') && !frame().includes('Matches for'), 'the search cleared, on the section it found');
  app.stdin.write(KEYS.esc);
  await until(() => !frame().includes('Keyboard shortcuts'), 'closed');
  app.unmount();
});

test('/grep lists the definitions with the text in them; ↵ puts one in the console with the match selected', async () => {
  mkdirSync(process.env.TRAWL_HOME, { recursive: true });
  writeFileSync(join(process.env.TRAWL_HOME, 'console.sql'), '');
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  await command(app, '/grep dbo.players');
  await until(() => frame().includes('"dbo.players" in ClubA\'s definitions') && frame().includes('dbo.trg_Players_Goals'), 'the list');
  assert.match(frame(), /❯ dbo\.vTopScorers\s+1 match · 3: FROM/);
  assert.match(frame(), /A view: 1 match on this line\.[\s\S]*3  FROM dbo\.Players/);
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('CREATE VIEW dbo.vTopScorers AS') && frame().includes('↵/i type'), 'the view in the console, not typing');
  assert.match(frame(), /─ Console ─+ selected ·/);
  assert.match(frame(), /▌3 FROM dbo\.Players/, 'the cursor on the line with the match');
  await command(app, '/grep nothing like this');
  await until(() => frame().includes('No view, procedure, function or trigger has "nothing like this" in it.'), 'nothing found');
  app.unmount();
});

test('u in the Explorer, or /uses, shows what refers to an object and what it refers to', async () => {
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  app.stdin.write('u');
  await until(() => frame().includes('Uses: dbo.Clubs') && frame().includes('dbo.usp_RecalculateTable'), 'the report on Clubs');
  assert.match(frame(), /Tables, through their foreign keys/);
  assert.match(frame(), /dbo\.Matches \(AwayId\) → Id  FK_Matches_Away/);
  app.stdin.write(KEYS.esc);
  await until(() => !frame().includes('Uses: dbo.Clubs'), 'closed');
  await type(app.stdin, '/uses vTop');
  await until(() => frame().includes('dbo.vTopScorers'), 'completion offers the object');
  app.stdin.write('\t');
  await until(() => frame().includes('/uses dbo.vTopScorers'), 'completed');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('Uses: dbo.vTopScorers') && /Uses\s+│\s*│\s+Tables\s+│\s*│\s+dbo\.Players/.test(frame()), 'the report on the view');
  app.unmount();
});

// A pretend Postgres server behind the real pg session (db-postgres.js): it answers Trawl's catalog
// queries and one table's rows, keeps the transaction status as the protocol would, records what
// it's sent, and turns a save's DO block down while `refuse` says so.
class FakePgServer extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.status = 'I';
    this.refuse = null;
    const field = (name, dataTypeID = 25) => ({ name, dataTypeID });
    const answer = (names, rows) => ({ command: 'SELECT', fields: names.map((n) => field(n)), rows });
    const catalog = [
      answer(['db'], [['shop']]),
      answer(['name'], [['shop']]),
      answer(['schema', 'name', 'type', 'rows'], [['public', 'clubs', 'U', 2]]),
      answer(['schema', 'object', 'name', 'type', 'max_length', 'precision', 'scale', 'is_nullable', 'is_identity', 'is_computed', 'pk'], [
        ['public', 'clubs', 'id', 'integer', null, null, null, false, true, false, 1],
        ['public', 'clubs', 'name', 'text', null, null, null, true, false, false, 0],
        ['public', 'clubs', 'name_len', 'integer', null, null, null, true, false, true, 0],
      ]),
      answer(['name', 'schema', 'object', 'column', 'ref_schema', 'ref_object', 'ref_column'], []),
      answer(['schema', 'object', 'name', 'type', 'max_length', 'precision', 'scale', 'is_output'], []),
    ];
    this.answers = new Map(splitScript(DIALECTS.postgres.schemaSql, DIALECTS.postgres).map((st, i) => [st.text, catalog[i]]));
    this.rows = { command: 'SELECT', fields: [field('id', 23), field('name'), field('name_len', 23)], rows: [[1, 'Club A', 6], [2, 'Club B', 6]] };
  }
  async query({ text }) {
    this.sent.push(text);
    if (this.answers.has(text)) return this.answers.get(text);
    if (/^SELECT \* FROM "public"\."clubs"/.test(text)) return this.rows;
    const done = (command) => ({ command, fields: [], rows: [] });
    if (/^BEGIN/.test(text)) return (this.status = 'T'), done('BEGIN');
    if (/^ROLLBACK TO/.test(text)) return (this.status = 'T'), done('ROLLBACK');
    if (/^(COMMIT|ROLLBACK)/.test(text)) return (this.status = 'I'), done('COMMIT');
    if (/^DO /.test(text) && this.refuse) {
      if (this.status === 'T') this.status = 'E';
      throw Object.assign(new Error(this.refuse), { code: 'P0001' });
    }
    return done('SELECT');
  }
  getTransactionStatus() {
    return this.status;
  }
  async end() {
    this.emit('end');
  }
}

test('on Postgres, Results are edited and saved too: a DO block in a savepoint, which a refused save goes back to', async () => {
  const server = new FakePgServer();
  const shop = { name: 'shop', kind: 'postgres', server: 'db', database: 'shop', user: 'app', commit: 'manual' };
  const app = start('shop', { open: async (conn) => postgresSession(conn, server, { database: 'shop' }) }, { connections: [shop] });
  await until(() => /❯ T clubs/.test(frame()), 'the explorer');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('Club A'), 'the rows of clubs');
  assert.ok(server.sent.includes('SELECT * FROM "public"."clubs" LIMIT 500'));
  app.stdin.write('e');
  await until(() => frame().includes('id is an identity column'), 'the refusal on the identity key');
  app.stdin.write('l');
  await new Promise((r) => setTimeout(r, 50));
  app.stdin.write('l');
  await new Promise((r) => setTimeout(r, 50));
  app.stdin.write('e');
  await until(() => frame().includes('name_len is a generated column; the server sets it.'), 'the refusal on the generated column');
  app.stdin.write('h');
  await new Promise((r) => setTimeout(r, 50));
  app.stdin.write('e');
  await until(() => frame().includes('editing the cell'), 'typing in the cell');
  app.stdin.write('\x15');
  await type(app.stdin, "Club Q'");
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('1 edited row not saved'), 'the staged change');
  // The connection commits manually, so the save will run in a transaction: it keeps to a savepoint.
  app.stdin.write('s');
  await until(() => frame().includes('Save 1 edited row to public.clubs on shop?'), 'the question');
  assert.match(frame(), /SAVEPOINT trawl_edit;[\s│]*DO \$trawl\$/);
  assert.match(frame(), /UPDATE "public"\."clubs" SET "name" = 'Club Q''' WHERE "id" = 1 AND "name" = 'Club A';/);
  server.refuse = 'The row id = 1 changed or is gone since it was read. Nothing was saved.';
  app.stdin.write('1');
  await until(() => frame().includes('changed or is gone since it was read'), 'the refusal');
  assert.match(frame(), /1 edited row not saved/, 'the change stays staged');
  const sent = server.sent.slice(server.sent.findIndex((t) => /^BEGIN/.test(t)));
  assert.match(sent[0], /^BEGIN$/);
  assert.match(sent[1], /^-- trawl:edit 1 change to public\.clubs\nSAVEPOINT trawl_edit$/);
  assert.match(sent[2], /^DO \$trawl\$/);
  assert.deepEqual(sent.slice(3, 5), ['ROLLBACK TO SAVEPOINT trawl_edit', 'RELEASE SAVEPOINT trawl_edit']);
  assert.equal(server.status, 'T', 'the transaction is open and usable again');
  // Saved this time, and left for /commit.
  server.refuse = null;
  app.stdin.write('s');
  await until(() => frame().includes('Save 1 edited row to public.clubs on shop?'), 'the question again');
  app.stdin.write('1');
  await until(() => frame().includes('save 1 edited row to public.clubs') && !frame().includes('not saved'), 'saved');
  assert.match(frame(), /TRANSACTION OPEN/);
  assert.match(server.sent.at(-1), /^RELEASE SAVEPOINT trawl_edit$/);
  app.unmount();
});
