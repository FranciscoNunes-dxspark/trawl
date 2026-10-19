import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aiLevel, askPrompt, consoleText, parseAnswer, schemaText } from '../src/ai.js';
import { demoSession } from '../src/demo.js';
import { createServer } from '../src/mcp.js';

let base;
before(() => {
  base = mkdtempSync(join(tmpdir(), 'trawl-mcp-'));
  process.env.TRAWL_HOME = base;
  mkdirSync(base, { recursive: true });
  // Demo-backed connections at each Claude access level.
  writeFileSync(
    join(base, 'config.json'),
    JSON.stringify({
      connections: [
        { name: 'closed', demo: true, server: 'demo', database: 'ClubA', ai: 'off' },
        { name: 'names', demo: true, server: 'demo', database: 'ClubA', ai: 'schema' },
        { name: 'rows', demo: true, server: 'demo', database: 'ClubA', ai: 'results' },
      ],
    }),
  );
});
after(() => rmSync(base, { recursive: true, force: true }));

const call = async (server, name, args = {}) => {
  const res = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return { text: res.result.content[0].text, error: Boolean(res.result.isError) };
};

test('initialize, tools/list, ping and unknown methods', async () => {
  const server = createServer({ log: () => {} });
  const init = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'trawl');
  const odd = await server.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.match(odd.result.protocolVersion, /^20\d\d-/);
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const list = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), ['list_connections', 'list_tables', 'describe_table', 'run_query']);
  assert.ok(list.result.tools.every((t) => t.annotations.readOnlyHint));
  assert.deepEqual((await server.handle({ jsonrpc: '2.0', id: 4, method: 'ping' })).result, {});
  assert.equal((await server.handle({ jsonrpc: '2.0', id: 5, method: 'resources/list' })).error.code, -32601);
});

test('each Claude access level is respected', async () => {
  const server = createServer({ log: () => {} });
  assert.match((await call(server, 'list_connections')).text, /names: demo\/ClubA; Claude may see schema only/);
  const closed = await call(server, 'list_tables', { connection: 'closed' });
  assert.ok(closed.error);
  assert.match(closed.text, /closed to Claude/);
  assert.match((await call(server, 'list_tables', { connection: 'names' })).text, /dbo\.Players \(table, ~12 rows\)/);
  const rowsRefused = await call(server, 'run_query', { connection: 'names', sql: 'SELECT * FROM dbo.Clubs' });
  assert.ok(rowsRefused.error);
  assert.match(rowsRefused.text, /only shares its schema/);
  const rows = await call(server, 'run_query', { connection: 'rows', sql: 'SELECT TOP (2) * FROM dbo.Clubs' });
  assert.ok(!rows.error);
  assert.match(rows.text, /Club A FC/);
  server.close();
});

test('writes are refused, and reads run inside a rolled-back transaction', async () => {
  let opened;
  const logged = [];
  const server = createServer({
    log: (e) => logged.push(e),
    open: async (conn, opts) => (opened = demoSession(conn, opts)),
  });
  for (const sql of ['DELETE FROM dbo.Players', 'UPDATE dbo.Players SET Goals = 0 WHERE Id = 1', 'DROP TABLE dbo.Clubs', 'EXEC dbo.usp_RecalculateTable', 'SELECT * INTO #x FROM dbo.Clubs']) {
    const r = await call(server, 'run_query', { connection: 'rows', sql });
    assert.ok(r.error, sql);
    assert.match(r.text, /^Refused/, sql);
  }
  assert.equal(opened, undefined, 'refused writes never open a connection');
  const r = await call(server, 'run_query', { connection: 'rows', sql: 'SELECT * FROM dbo.Players', max_rows: 3 });
  assert.match(r.text, /first 3 rows; there are more/);
  assert.equal(await opened.tranCount(), 0, 'the transaction was rolled back');
  assert.equal(logged.length, 1);
  assert.equal(logged[0].via, 'claude');
  const bad = await call(server, 'run_query', { connection: 'rows', sql: 'SELECT * FROM nope' });
  assert.equal(bad.text, "Line 1: Invalid object name 'nope'.");
  assert.equal(logged.at(-1).ok, false);
  server.close();
});

test('parallel calls on one connection take turns', async () => {
  const server = createServer({ log: () => {} });
  const results = await Promise.all([
    call(server, 'run_query', { connection: 'rows', sql: "WAITFOR DELAY '00:00:00'" }),
    call(server, 'describe_table', { connection: 'rows', table: 'Players' }),
    call(server, 'run_query', { connection: 'rows', sql: 'SELECT TOP (1) * FROM dbo.Matches' }),
    call(server, 'list_tables', { connection: 'rows', filter: 'club' }),
  ]);
  assert.ok(results.every((r) => !r.error), JSON.stringify(results));
  assert.match(results[3].text, /dbo\.Clubs/);
  server.close();
});

test('the access level defaults to schema only, except for the demo', () => {
  assert.equal(aiLevel({ name: 'x' }), 'schema');
  assert.equal(aiLevel({ name: 'x', ai: 'results' }), 'results');
  assert.equal(aiLevel({ name: 'demo', demo: true }), 'results');
  assert.equal(aiLevel({ name: 'x', ai: 'bogus' }), 'schema');
});

test('ask: the prompt carries the schema, and the answer splits into SQL and a note', () => {
  const schema = {
    objects: [
      { schema: 'dbo', name: 'Players', kind: 'table', columns: [{ name: 'Id', type: 'int', pk: true, nullable: false }, { name: 'Goals', type: 'int', nullable: true }] },
      { schema: 'dbo', name: 'usp_X', kind: 'procedure', columns: [] },
    ],
  };
  const prompt = askPrompt({ question: 'top scorers', schema, database: 'ClubA' });
  assert.match(prompt, /Database: ClubA/);
  assert.match(prompt, /dbo\.Players\(Id int PK, Goals int null\)/);
  assert.doesNotMatch(prompt, /usp_X/);
  const answer = parseAnswer('Here you go:\n```sql\nSELECT TOP (10) Name, Goals\nFROM dbo.Players\nORDER BY Goals DESC;\n```\nTies are broken arbitrarily.');
  assert.equal(answer.sql, 'SELECT TOP (10) Name, Goals\nFROM dbo.Players\nORDER BY Goals DESC;');
  assert.equal(answer.note, 'Here you go: Ties are broken arbitrarily.');
  assert.deepEqual(parseAnswer('There is no table for that.'), { sql: null, note: 'There is no table for that.' });
  assert.equal(consoleText({ question: 'q?', sql: 'SELECT 1', note: 'n' }), '-- Asked Claude: q?\n-- n\nSELECT 1');
});

test('a big schema keeps the tables the question names', () => {
  const objects = Array.from({ length: 400 }, (_, i) => ({ schema: 'dbo', name: `T${i}`, kind: 'table', columns: Array.from({ length: 30 }, (_, k) => ({ name: `c${k}`, type: 'nvarchar(100)' })) }));
  objects.push({ schema: 'dbo', name: 'Translations', kind: 'table', columns: [{ name: 'ResourceKey', type: 'nvarchar(200)' }] });
  const text = schemaText({ objects }, 'missing translations per culture', { maxChars: 20_000 });
  assert.ok(text.length < 25_000);
  assert.match(text.split('\n')[0], /^dbo\.Translations\(ResourceKey/);
  assert.match(text, /More tables, columns not shown: .*T399/);
});
