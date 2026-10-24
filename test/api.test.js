// /api: a statement as an HTTP endpoint, written by Claude (stubbed here), shown, saved, and a Hail
// request for it copied. The pure parts, then the real UI against the demo, in app.test.js's style.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { DEMO_CONNECTIONS } from '../src/connections.js';
import { contextIn } from '../src/family.js';
import { API_SYSTEM, apiFileName, apiLanguage, apiPrompt, apiRequest, parseApi, projectLanguage } from '../src/api.js';
import { App } from '../src/ui/App.jsx';

const KEYS = { enter: '\r', esc: '\x1b' };

let base;
before(() => {
  base = mkdtempSync(join(tmpdir(), 'trawl-api-'));
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
function start(connection = 'demo', props = {}) {
  const config = { connections: [...DEMO_CONNECTIONS], history: [], ran: [], limit: 500, last: null };
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
  await type(app.stdin, text);
  app.stdin.write(KEYS.enter);
};

test('the language: the word typed, else the project: C# for a .csproj, Node for a package.json', () => {
  assert.equal(apiLanguage('C#'), 'csharp');
  assert.equal(apiLanguage('express'), 'node');
  assert.equal(apiLanguage('cobol'), null);
  const dir = mkdtempSync(join(tmpdir(), 'trawl-lang-'));
  try {
    assert.equal(projectLanguage(dir), null);
    writeFileSync(join(dir, 'package.json'), '{}');
    assert.equal(projectLanguage(dir), 'node');
    mkdirSync(join(dir, 'src', 'Api'), { recursive: true });
    writeFileSync(join(dir, 'src', 'Api', 'Api.csproj'), '<Project/>');
    assert.equal(projectLanguage(dir), 'csharp');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the prompt names the kind, language and parameters, and the answer is read from JSON, fenced or not', () => {
  const p = apiPrompt({ sql: 'SELECT * FROM dbo.Players WHERE ClubId = @clubId', language: 'csharp', label: 'SQL Server', database: 'ClubA' });
  assert.match(p, /Database kind: SQL Server \(database ClubA\)/);
  assert.match(p, /Language: C# \(ASP\.NET Core minimal API\)/);
  assert.match(p, /Parameters in the SQL: @clubId/);
  assert.match(API_SYSTEM, /"code"/);
  const answer = { code: 'app.MapGet("/clubs/{clubId}/players", ...);', language: 'C#', method: 'get', path: 'clubs/{clubId}/players', body: null };
  const parsed = parseApi(`Here it is:\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``);
  assert.equal(parsed.method, 'GET');
  assert.equal(parsed.path, '/clubs/{clubId}/players');
  assert.equal(parsed.code, 'app.MapGet("/clubs/{clubId}/players", ...);\n');
  assert.deepEqual(parseApi(`Sure. ${JSON.stringify({ ...answer, method: 'POST', body: { name: 'x' } })} Done.`).body, { name: 'x' });
  assert.throws(() => parseApi('I would rather not.'), /no endpoint/);
  assert.deepEqual(apiRequest({ method: 'POST', path: '/players', body: { name: 'x' } }), { method: 'POST', url: '{{host}}/players', headers: { 'Content-Type': 'application/json' }, body: '{\n  "name": "x"\n}' });
  assert.equal(apiFileName({ path: '/clubs/{clubId}/players' }, 'csharp'), 'ClubsPlayersEndpoint.cs');
  assert.equal(apiFileName({ path: '/top-scorers' }, 'node'), 'top-scorers.js');
});

test('/api asks Claude for the endpoint, shows it, copies a Hail request, and s saves it in the project', async () => {
  const dir = mkdtempSync(join(base, 'project-'));
  writeFileSync(join(dir, 'Clubs.csproj'), '<Project/>');
  const asked = [];
  const askClaude = async ({ prompt, system }) => {
    asked.push({ prompt, system });
    return JSON.stringify({ code: 'app.MapGet("/players/{id}", (int id) => db.Query(id));', language: 'C#', method: 'GET', path: '/players/{id}', body: null });
  };
  const copied = [];
  const app = start('demo', { askClaude, projectDir: dir, clipboard: async (text) => (copied.push(text), 'system') });
  await until(() => frame().includes('Clubs'), 'the explorer');
  app.stdin.write('2');
  await until(() => frame().includes('Query'), 'the console');
  app.stdin.write('i');
  await until(() => frame().includes('typing SQL'), 'typing');
  await type(app.stdin, 'SELECT * FROM dbo.Players WHERE Id = @id');
  app.stdin.write(KEYS.esc);
  await new Promise((r) => setTimeout(r, 100));
  app.stdin.write('/');
  await command(app, 'api');
  await until(() => frame().includes('GET /players/{id}') && frame().includes('app.MapGet'), 'the endpoint in the viewer');
  assert.match(asked[0].prompt, /Language: C#/);
  assert.match(asked[0].prompt, /@id/);
  await until(() => frame().includes('Copied for Hail'), 'the request copied for Hail');
  assert.match(frame(), /request GET \{\{host\}\}\/players\/\{id\}/);
  assert.deepEqual(contextIn(copied.at(-1)), { kind: 'request', data: { method: 'GET', url: '{{host}}/players/{id}', headers: {}, body: '', name: 'GET /players/{id}' } });
  app.stdin.write('s');
  await until(() => frame().includes('Save the endpoint as'), 'the file name asked for');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('Saved the endpoint'), 'the endpoint saved');
  assert.match(readFileSync(join(dir, 'PlayersEndpoint.cs'), 'utf8'), /MapGet/);
  app.unmount();
});

test('/api asks which language when the project says nothing, and a language it can\'t write is said', async () => {
  const dir = mkdtempSync(join(base, 'bare-'));
  const asked = [];
  const askClaude = async ({ prompt }) => (asked.push(prompt), JSON.stringify({ code: 'def players(): ...', method: 'GET', path: '/players' }));
  const app = start('demo', { askClaude, projectDir: dir, clipboard: async () => 'system' });
  await until(() => frame().includes('Clubs'), 'the explorer');
  app.stdin.write('2');
  await until(() => frame().includes('Query'), 'the console');
  app.stdin.write('i');
  await until(() => frame().includes('typing SQL'), 'typing');
  await type(app.stdin, 'SELECT * FROM dbo.Players');
  app.stdin.write(KEYS.esc);
  await new Promise((r) => setTimeout(r, 100));
  app.stdin.write('/');
  await command(app, 'api cobol');
  await until(() => frame().includes('not cobol'), 'the language refused');
  app.stdin.write('/');
  await command(app, 'api');
  await until(() => frame().includes('Which language should the endpoint be in?'), 'the question');
  app.stdin.write('3');
  await until(() => frame().includes('GET /players · Python (FastAPI)'), 'the Python endpoint');
  assert.match(asked[0], /Language: Python/);
  app.unmount();
});
