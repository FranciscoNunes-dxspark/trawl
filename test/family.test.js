import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeContext, decodeContext, describeContext, stackFrames, matchFrameFile, databaseOf, quoteArg, splitArgs, shareLine, takeLine, contextIn, copiedNote, notMine, pastedLine, pathArg, trawlLine, TAKEN_BY, APP_NAMES, projectAt, writeMood, readMoods } from '../src/family.js';

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
  assert.deepEqual(databaseOf('Server=tcp:shop.database.windows.net,1433;Initial Catalog=Shop;User ID=app;Password=p;a=ss;Encrypt=True'), { kind: 'sqlserver', server: 'shop.database.windows.net', port: 1433, database: 'Shop', user: 'app', password: 'p;a=ss'.split(';')[0], entra: false, trustCert: false });
  assert.equal(databaseOf('Server=x.database.windows.net;Database=D;Authentication=Active Directory Default').entra, true);
  assert.deepEqual(databaseOf('postgres://me:s%40cret@db.local:5432/shop'), { kind: 'postgres', server: 'db.local', port: 5432, database: 'shop', user: 'me', password: 's@cret', entra: false, trustCert: false });
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

test('who takes what, and what each says', () => {
  for (const apps of Object.values(TAKEN_BY)) for (const a of apps) assert.ok(APP_NAMES[a]);
  const take = takeLine('request', { method: 'GET', url: 'http://x/a' });
  assert.equal(copiedNote('hail', take), "Copied for Hail: paste it into Hail's prompt. request GET http://x/a");
  assert.equal(copiedNote(['sonar', 'hail'], '/x'), "Copied for Sonar or Hail: paste it into one's prompt. /x");
  assert.equal(notMine('splice', contextIn(take)), "That's request GET http://x/a, for Hail: paste it into its prompt instead.");
  assert.equal(notMine('trawl', { kind: 'logline', data: { process: 'api', text: 'x' } }), "That's api: x, for Sonar or Hail or Bosun: paste it into one's prompt instead.");
});

test('the paste rule', () => {
  assert.equal(pastedLine('\x1b[200~/move ../shop\n\x1b[201~'), '/move ../shop');
  assert.equal(pastedLine(takeLine('commit', { hash: 'a' }).slice('/take '.length)), takeLine('commit', { hash: 'a' }).slice('/take '.length));
  assert.equal(pastedLine('/'), null);
  assert.equal(pastedLine('hello'), null);
  assert.equal(pastedLine('/a\n/b\n'), null);
});

test('Trawl lines from connection strings', () => {
  assert.equal(trawlLine(databaseOf('Server=tcp:s.database.windows.net,1433;Database=Shop;Authentication=Active Directory Default'), 'shop'), '/azure-sql s.database.windows.net Shop');
  assert.equal(trawlLine(databaseOf('Server=localhost,1433;Database=Shop;User ID=sa;Password=x;TrustServerCertificate=True'), 'shop'), '/add shop localhost,1433 Shop --user sa --trust-cert');
  assert.equal(trawlLine(databaseOf('postgres://me:pw@db.local:5432/shop'), 'DATABASE_URL'), '/add DATABASE_URL db.local:5432 shop --kind postgres --user me');
  assert.doesNotMatch(trawlLine(databaseOf('mysql://u:secret@h/d'), 'x'), /secret/);
});

test('a pasted line ending in a carriage return, and quoted paths', () => {
  assert.equal(pastedLine('/take x\r'), '/take x');
  assert.equal(pastedLine('/move a\r\n'), '/move a');
  assert.equal(pathArg(quoteArg('C:\\Team\\my shop')), 'C:\\Team\\my shop');
  assert.equal(pathArg(quoteArg('/home/me/my shop')), '/home/me/my shop');
  assert.equal(pathArg('"C:\\Team\\shop"'), 'C:\\Team\\shop');
  assert.equal(pathArg('  plain  '), 'plain');
});

test('secrets are masked wherever a value or a line could carry one', async () => {
  const { maskValue, redactSecrets, MASK } = await import('../src/family.js');
  assert.equal(maskValue('DATABASE_URL', 'postgres://app:s3cret@db:5432/shop'), `postgres://app:${MASK}@db:5432/shop`);
  assert.equal(maskValue('Shop', 'Server=tcp:x.database.windows.net,1433;Database=Shop;User ID=app;Password=p@ss;Encrypt=True'), `Server=tcp:x.database.windows.net,1433;Database=Shop;User ID=app;Password=${MASK};Encrypt=True`);
  assert.equal(maskValue('Storage', 'DefaultEndpointsProtocol=https;AccountName=acc;AccountKey=abc==;EndpointSuffix=core.windows.net'), `DefaultEndpointsProtocol=https;AccountName=acc;AccountKey=${MASK};EndpointSuffix=core.windows.net`);
  assert.equal(maskValue('API_KEY', 'xyz'), MASK);
  assert.equal(maskValue('API_URL', 'https://api.example.com'), 'https://api.example.com');
  assert.equal(redactSecrets('curl -H "Authorization: Bearer abc.def" https://u:pw@h/ password=hunter2 token: t0k'), `curl -H "Authorization: Bearer ${MASK}" https://u:${MASK}@h/ password=${MASK} token: ${MASK}`);
});

test('what a project points at, masked', async () => {
  const { projectWiring, MASK } = await import('../src/family.js');
  const dir = mkdtempSync(join(tmpdir(), 'family-'));
  try {
    writeFileSync(join(dir, 'appsettings.json'), JSON.stringify({ ConnectionStrings: { Shop: 'Server=localhost;Database=Shop;User ID=sa;Password=x' }, Api: { BaseUrl: 'https://api.local', Retries: 3, ClientSecret: 'zzz' } }));
    writeFileSync(join(dir, '.env'), 'REDIS_URL=redis://:pw@cache:6379\nDEBUG=1\nPORT=4280\n');
    writeFileSync(join(dir, '.env.example'), 'REDIS_URL=\n');
    writeFileSync(join(dir, 'http-client.env.json'), JSON.stringify({ dev: { host: 'http://localhost:4280', token: 't' } }));
    const w = projectWiring(dir);
    const by = Object.fromEntries(w.map((e) => [e.key, e]));
    assert.equal(by['ConnectionStrings:Shop'].value, `Server=localhost;Database=Shop;User ID=sa;Password=${MASK}`);
    assert.equal(by['Api:BaseUrl'].value, 'https://api.local');
    assert.equal(by['REDIS_URL'].value, `redis://:${MASK}@cache:6379`);
    assert.equal(by['PORT'].source, '.env');
    assert.equal(by['env:dev.host'].value, 'http://localhost:4280');
    assert.ok(!('DEBUG' in by) && !('Api:Retries' in by) && !('Api:ClientSecret' in by) && !('env:dev.token' in by));
    assert.doesNotMatch(JSON.stringify(w), /hunter|zzz|:pw@|Password=x/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the activity log: appended, redacted, newest first, by project, and kept small', async () => {
  const { logActivity, readActivity, MASK } = await import('../src/family.js');
  const dir = mkdtempSync(join(tmpdir(), 'family-'));
  try {
    logActivity('splice', { text: 'pushed main', kind: 'push', project: '/p/shop' }, { dir, now: 1000 });
    logActivity('trawl', { text: 'ran UPDATE on dev with password=abc', kind: 'write' }, { dir, now: 2000 });
    logActivity('bosun', { text: 'api crashed', kind: 'crash', project: '/p/other' }, { dir, now: 3000 });
    assert.deepEqual(readActivity({ dir }).map((e) => e.app), ['bosun', 'trawl', 'splice']);
    assert.equal(readActivity({ dir })[1].text, `ran UPDATE on dev with password=${MASK}`);
    assert.deepEqual(readActivity({ dir, project: '/p/shop' }).map((e) => e.app), ['trawl', 'splice']);
    assert.deepEqual(readActivity({ dir, since: 1500 }).map((e) => e.app), ['bosun', 'trawl']);
    for (let i = 0; i < 400; i++) logActivity('hail', { text: 'x'.repeat(100) }, { dir, now: 4000 + i, max: 20_000 });
    const all = readActivity({ dir, limit: 10_000 });
    assert.ok(all.length < 400 && all.length > 50, `kept ${all.length}`);
    assert.equal(all[0].at, 4399);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
