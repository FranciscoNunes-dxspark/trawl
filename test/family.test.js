import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeContext, decodeContext, describeContext, stackFrames, matchFrameFile, databaseOf, quoteArg, splitArgs, shareLine, takeLine, contextIn, projectAt, writeMood, readMoods } from '../src/family.js';

test('a context survives the round trip, and other text is not one', () => {
  const data = { method: 'POST', url: 'https://x/y?a=1', headers: { 'Content-Type': 'application/json' }, body: '{"é":1}' };
  const line = encodeContext('request', data);
  assert.match(line, /^family:v1:request:[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeContext(`\x1b[200~${line}\n\x1b[201~`), { kind: 'request', data });
  assert.equal(decodeContext('hello'), null);
  assert.equal(decodeContext('family:v1:nope:e30'), null);
  assert.equal(decodeContext('family:v1:query:!!!'), null);
  assert.throws(() => encodeContext('nope', {}));
  assert.equal(describeContext({ kind: 'request', data }), 'request POST https://x/y?a=1');
});

test('stack frames from .NET, Node and Python, and the checkout file they are', () => {
  const frames = stackFrames([
    '   at Shop.Api.Orders.Place(Order o) in D:\\a\\1\\s\\src\\Shop.Api\\Orders.cs:line 42',
    '    at placeOrder (/app/src/orders.js:17:9)',
    '    at /app/node_modules/express/lib/router.js:1:1',
    '  File "/srv/app/views.py", line 8, in get',
  ].join('\n'));
  assert.deepEqual(frames.map((f) => [f.file, f.line]), [['D:\\a\\1\\s\\src\\Shop.Api\\Orders.cs', 42], ['/app/src/orders.js', 17], ['/srv/app/views.py', 8]]);
  assert.equal(matchFrameFile(frames[0].file, ['README.md', 'src/Shop.Api/Orders.cs', 'test/Orders.cs']), 'src/Shop.Api/Orders.cs');
  assert.equal(matchFrameFile('/x/nothing.go', ['a.js']), null);
});

test('databases from connection strings and URLs', () => {
  assert.deepEqual(databaseOf('Server=tcp:shop.database.windows.net,1433;Initial Catalog=Shop;User ID=app;Password=p;a=ss;Encrypt=True'), { kind: 'sqlserver', server: 'shop.database.windows.net', port: 1433, database: 'Shop', user: 'app', password: 'p;a=ss'.split(';')[0], entra: false });
  assert.equal(databaseOf('Server=x.database.windows.net;Database=D;Authentication=Active Directory Default').entra, true);
  assert.deepEqual(databaseOf('postgres://me:s%40cret@db.local:5432/shop'), { kind: 'postgres', server: 'db.local', port: 5432, database: 'shop', user: 'me', password: 's@cret', entra: false });
  assert.equal(databaseOf('nothing here'), null);
});

test('shares are command lines the prompts read back', () => {
  const args = ['shop.database.windows.net', 'My Db', 'a"b\\c', '--prod'];
  const line = shareLine('azure-sql', args);
  assert.equal(line, '/azure-sql shop.database.windows.net "My Db" "a\\"b\\\\c" --prod');
  assert.deepEqual(splitArgs(line.slice('/azure-sql '.length)), args);
  assert.equal(quoteArg(''), '""');
  const take = takeLine('commit', { hash: 'abc' });
  assert.match(take, /^\/take family:v1:commit:/);
  assert.deepEqual(contextIn(take), { kind: 'commit', data: { hash: 'abc' } });
  assert.deepEqual(contextIn(take.slice('/take '.length)), { kind: 'commit', data: { hash: 'abc' } });
  assert.equal(contextIn('/take nonsense'), null);
});

test('a project: crew, .http files and databases', () => {
  const dir = mkdtempSync(join(tmpdir(), 'family-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    writeFileSync(join(dir, 'appsettings.Development.json'), '\uFEFF' + JSON.stringify({ ConnectionStrings: { Shop: 'Server=localhost,1433;Database=Shop;User ID=sa;Password=x' } }));
    writeFileSync(join(dir, '.env'), 'DATABASE_URL="postgres://a@h/db"\nOTHER=1\n');
    mkdirSync(join(dir, 'api'));
    writeFileSync(join(dir, 'api', 'orders.http'), 'GET http://x');
    const p = projectAt(dir);
    assert.equal(p.crew, true);
    assert.deepEqual(p.httpFiles, [join(dir, 'api', 'orders.http')]);
    assert.deepEqual(p.databases.map((d) => [d.name, d.source, d.kind, d.server, d.database]), [['Shop', 'appsettings.Development.json', 'sqlserver', 'localhost', 'Shop'], ['DATABASE_URL', '.env', 'postgres', 'h', 'db']]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('moods: each app reads the others, recent ones only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'family-'));
  try {
    writeMood('sonar', { mood: 'worried', reason: 'production has 12 new exceptions' }, { dir, now: 1000 });
    writeMood('splice', { mood: 'happy', reason: 'PR merged' }, { dir, now: 2000 });
    assert.deepEqual(readMoods('splice', { dir, now: 3000, maxAge: 1e15 }).map((m) => m.app), ['sonar']);
    assert.deepEqual(readMoods('bosun', { dir, now: 3000, maxAge: 1e15 }).map((m) => m.app), ['splice', 'sonar']);
    assert.deepEqual(readMoods('bosun', { dir, now: 1e9, maxAge: 1000 }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
