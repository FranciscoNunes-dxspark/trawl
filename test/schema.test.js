import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADD_USAGE, commitMode, connectionRows, isReadOnly, parseAddArgs, parseServer, splitArgs, tediousConfig } from '../src/connections.js';
import { buildSchema, describeObject, findObject, typeLabel } from '../src/schema.js';
import { demoSession } from '../src/demo.js';
import { SCHEMA_SQL } from '../src/schema.js';

const set = (names, rows) => ({ columns: names.map((name) => ({ name })), rows });

test('types read the way they are declared', () => {
  assert.equal(typeLabel('nvarchar', 100, 0, 0), 'nvarchar(50)');
  assert.equal(typeLabel('nvarchar', -1, 0, 0), 'nvarchar(max)');
  assert.equal(typeLabel('varbinary', -1, 0, 0), 'varbinary(max)');
  assert.equal(typeLabel('decimal', 9, 10, 2), 'decimal(10,2)');
  assert.equal(typeLabel('datetime2', 8, 27, 7), 'datetime2');
  assert.equal(typeLabel('datetime2', 6, 19, 0), 'datetime2(0)');
  assert.equal(typeLabel('int', 4, 10, 0), 'int');
});

test('the catalog result sets become one schema', () => {
  const schema = buildSchema([
    set(['db'], [['ClubA']]),
    set(['name'], [['master'], ['ClubA']]),
    set(['schema', 'name', 'type', 'rows'], [['dbo', 'Clubs', 'U', 3], ['dbo', 'vTop', 'V', null], ['dbo', 'usp_X', 'P', null]]),
    set(['schema', 'object', 'name', 'type', 'max_length', 'precision', 'scale', 'is_nullable', 'is_identity', 'pk'], [
      ['dbo', 'Clubs', 'Id', 'int', 4, 10, 0, false, true, 1],
      ['dbo', 'Clubs', 'Name', 'nvarchar', 200, 0, 0, true, false, 0],
    ]),
  ]);
  assert.equal(schema.database, 'ClubA');
  assert.deepEqual(schema.databases, ['master', 'ClubA']);
  assert.deepEqual(schema.objects.map((o) => o.kind), ['table', 'view', 'procedure']);
  assert.deepEqual(schema.objects[0].columns[1], { name: 'Name', type: 'nvarchar(100)', nullable: true, identity: false, pk: false });
  assert.equal(findObject(schema, '[dbo].[clubs]').name, 'Clubs');
  assert.equal(findObject(schema, 'Clubs').name, 'Clubs');
  assert.equal(findObject(schema, 'other.Clubs'), null);
  assert.match(describeObject(schema.objects[0]), /PK Id\s+int\s+primary key, identity, not null/);
});

test('the demo answers the catalog query like a server', async () => {
  const s = demoSession({ name: 'demo', demo: true, database: 'ClubA' });
  const schema = buildSchema((await s.run(SCHEMA_SQL)).sets);
  assert.equal(schema.database, 'ClubA');
  assert.ok(schema.objects.some((o) => o.schema === 'i18n' && o.name === 'Translations'));
  assert.equal(findObject(schema, 'dbo.Clubs').columns[1].type, 'nvarchar(100)');
});

test('demo errors carry the line in the whole script', async () => {
  const s = demoSession({ name: 'demo', demo: true, database: 'ClubA' });
  await assert.rejects(s.run('SELECT 1\nGO\n\nSELECT * FROM nope'), (e) => e.number === 208 && e.line === 4 && e.partial.sets.length === 1);
});

test('/add arguments', () => {
  assert.deepEqual(parseAddArgs('club-a srv.database.windows.net ClubA --prod'), {
    name: 'club-a',
    server: 'srv.database.windows.net',
    database: 'ClubA',
    auth: 'azure-cli',
    prod: true,
  });
  assert.deepEqual(parseAddArgs('local localhost,1433 --user sa --password-env SA_PW --trust-cert'), {
    name: 'local',
    server: 'localhost,1433',
    auth: 'sql',
    user: 'sa',
    passwordEnv: 'SA_PW',
    trustCert: true,
  });
  assert.equal(parseAddArgs('w srv --user me --password-env PW --domain CORP').auth, 'ntlm');
  assert.equal(parseAddArgs('x srv --ai results').ai, 'results');
  assert.throws(() => parseAddArgs('x srv --ai everything'), /--ai is off, schema or results/);
  assert.throws(() => parseAddArgs('only-a-name'), { message: ADD_USAGE });
  // No --password-env: Trawl asks for the password when connecting and keeps it in the OS store.
  assert.deepEqual(parseAddArgs('x srv --user sa'), { name: 'x', server: 'srv', auth: 'sql', user: 'sa' });
  assert.equal(parseAddArgs('x srv --folder " PROD / Clubs "').folder, 'PROD/Clubs');
  assert.equal('folder' in parseAddArgs('x srv --folder /'), false);
  assert.throws(() => parseAddArgs('x srv --bogus'), /Unknown option/);
  assert.deepEqual(splitArgs('a "b c" d'), ['a', 'b c', 'd']);
});

test('connections list by folder, folders first and by name, then the rest', () => {
  const rows = connectionRows([{ name: 'loose' }, { name: 'b1', folder: 'QA' }, { name: 'p1', folder: 'PROD' }, { name: 'b2', folder: 'QA' }]);
  assert.deepEqual(
    rows.map((r) => (r.folder ? `${r.folder}/ ${r.count}` : `${r.inFolder ? '  ' : ''}${r.conn.name}`)),
    ['PROD/ 1', '  p1', 'QA/ 2', '  b1', '  b2', 'loose'],
  );
  assert.deepEqual(connectionRows([]), []);
});

test('commit modes: production waits for /commit unless it says otherwise', () => {
  assert.equal(commitMode({}), 'auto');
  assert.equal(commitMode({ prod: true }), 'manual');
  assert.equal(commitMode({ prod: true, commit: 'auto' }), 'auto');
  assert.equal(parseAddArgs('x srv --commit manual').commit, 'manual');
  assert.throws(() => parseAddArgs('x srv --commit later'), /--commit is auto or manual/);
});

test('production is read-only unless it says otherwise', () => {
  assert.equal(isReadOnly({ prod: true }), true);
  assert.equal(isReadOnly({ prod: true, readOnly: false }), false);
  assert.equal(isReadOnly({}), false);
});

test('servers and tedious options', () => {
  assert.deepEqual(parseServer('host,1433'), { host: 'host', port: 1433 });
  assert.deepEqual(parseServer('host\\SQLEXPRESS'), { host: 'host', instanceName: 'SQLEXPRESS' });
  const az = tediousConfig({ server: 'srv.database.windows.net', database: 'ClubA', auth: 'azure-cli' }, { token: 't' });
  assert.deepEqual(az.authentication, { type: 'azure-active-directory-access-token', options: { token: 't' } });
  assert.equal(az.options.database, 'ClubA');
  assert.equal(az.options.encrypt, true);
  const sql = tediousConfig({ server: 'localhost,1433', auth: 'sql', user: 'sa', trustCert: true }, { password: 'p', database: 'Other' });
  assert.deepEqual(sql.authentication, { type: 'default', options: { userName: 'sa', password: 'p' } });
  assert.equal(sql.options.port, 1433);
  assert.equal(sql.options.database, 'Other');
  assert.equal(sql.options.trustServerCertificate, true);
});
