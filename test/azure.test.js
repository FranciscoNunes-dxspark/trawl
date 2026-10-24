// Azure SQL: the firewall through a stand-in az, /azure-sql (which Sonar copies for you to paste) and
// passwords read from an App Service. Nothing here starts the real az or reaches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addFirewallRule, firewallBlock, parseConnectionString, passwordFromApp, publicIp, ruleName, serverHost } from '../src/azure.js';
import { azureSqlConnection, findAzureSql, parseAzureSqlArgs } from '../src/connections.js';
import { parseArgs } from '../src/launch.js';
import { memoryCredentials } from '../src/credentials.js';
import { DbError, findPassword, signIn } from '../src/db.js';

const BLOCKED = "Cannot open server 'clubs' requested by the login. Client with IP address '203.0.113.7' is not allowed to access the server.  To enable access, use the Azure Management Portal or run sp_set_firewall_rule on the master database to create a firewall rule for this IP address or address range.  It may take up to five minutes for this change to take effect.";

test("error 40615 gives the address the firewall turned away; other errors don't", () => {
  assert.equal(firewallBlock(new Error(BLOCKED)), '203.0.113.7');
  assert.equal(firewallBlock(new Error("Login failed for user 'sa'.")), null);
  assert.equal(firewallBlock(null), null);
  assert.equal(serverHost('tcp:Clubs.database.windows.net,1433'), 'clubs.database.windows.net');
  assert.equal(ruleName('203.0.113.7'), 'trawl-203-0-113-7');
});

test('a firewall rule: the server found by its name through az, then the rule made for the address', async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    return args[2] === 'list' ? '[{"g": "rg-clubs", "n": "clubs"}]' : '';
  };
  const added = await addFirewallRule('tcp:clubs.database.windows.net,1433', '203.0.113.7', { run });
  assert.deepEqual(added, { group: 'rg-clubs', server: 'clubs', rule: 'trawl-203-0-113-7' });
  assert.deepEqual(calls, [
    ['sql', 'server', 'list', '--query', "[?fullyQualifiedDomainName=='clubs.database.windows.net'].{g:resourceGroup,n:name}", '-o', 'json'],
    ['sql', 'server', 'firewall-rule', 'create', '-g', 'rg-clubs', '-s', 'clubs', '-n', 'trawl-203-0-113-7', '--start-ip-address', '203.0.113.7', '--end-ip-address', '203.0.113.7', '-o', 'none'],
  ]);
  await assert.rejects(addFirewallRule('other.database.windows.net', '203.0.113.7', { run: async () => '[]' }), /No Azure SQL server other\.database\.windows\.net in the subscription/);
  await assert.rejects(addFirewallRule("x'] || true", '1.2.3.4', { run }), /isn't an Azure SQL server's name/);
  await assert.rejects(addFirewallRule('clubs.database.windows.net', 'nope; rm', { run }), /isn't an IP address/);
});

test("this machine's address comes from api.ipify.org", async () => {
  const asked = [];
  const fetch = async (url) => (asked.push(url), { ok: true, text: async () => '198.51.100.4\n' });
  assert.equal(await publicIp({ fetch }), '198.51.100.4');
  assert.deepEqual(asked, ['https://api.ipify.org']);
  await assert.rejects(publicIp({ fetch: async () => ({ ok: true, text: async () => '<html>' }) }), /isn't an address/);
});

test('/azure-sql finds the saved connection by server, database and login, or makes the one /add would', () => {
  const saved = [
    { name: 'clubs', server: 'tcp:CLUBS.database.windows.net,1433', database: 'ClubA', auth: 'azure-cli' },
    { name: 'clubs-sa', server: 'clubs.database.windows.net', database: 'ClubA', auth: 'sql', user: 'sa' },
    { name: 'pg', kind: 'postgres', server: 'clubs.database.windows.net', database: 'ClubA', auth: 'sql', user: 'sa' },
  ];
  assert.equal(findAzureSql(saved, { server: 'clubs.database.windows.net', database: 'cluba' })?.name, 'clubs');
  assert.equal(findAzureSql(saved, { server: 'clubs.database.windows.net', database: 'ClubA', user: 'SA' })?.name, 'clubs-sa');
  assert.equal(findAzureSql(saved, { server: 'clubs.database.windows.net', database: 'ClubB' }), null);
  assert.equal(findAzureSql(saved, { server: 'clubs.database.windows.net' }), null, 'no database is not any database');

  const add = azureSqlConnection(saved, { server: 'clubs.database.windows.net', database: 'ClubB', prod: true, folder: 'Azure/PROD' });
  assert.deepEqual(add, { name: 'clubs-ClubB', server: 'clubs.database.windows.net', database: 'ClubB', auth: 'azure-cli', prod: true, folder: 'Azure/PROD' });
  // A name that's taken gets a number; the demo's names count as taken too.
  assert.equal(azureSqlConnection(saved, { server: 'clubs.database.windows.net' }).name, 'clubs-2');
  assert.equal(azureSqlConnection(saved, { server: 'demo.database.windows.net' }).name, 'demo-2');
  const passwordFrom = { resourceGroup: 'rg', app: 'api' };
  assert.deepEqual(azureSqlConnection(saved, { server: 'clubs.database.windows.net', database: 'ClubA', user: 'app "x"', name: 'Clubs app', passwordFrom }), { name: 'Clubs app', server: 'clubs.database.windows.net', database: 'ClubA', auth: 'sql', user: 'app "x"', passwordFrom });
});

test('/azure-sql and the command line take the same options', () => {
  assert.deepEqual(parseAzureSqlArgs('tcp:clubs.database.windows.net,1433 ClubA --user app --name "clubs app" --prod --password-from rg-clubs/clubs-api/staging --subscription 0000-11'), {
    server: 'tcp:clubs.database.windows.net,1433',
    database: 'ClubA',
    name: 'clubs app',
    user: 'app',
    prod: true,
    passwordFrom: { subscription: '0000-11', resourceGroup: 'rg-clubs', app: 'clubs-api', slot: 'staging' },
  });
  assert.deepEqual(parseAzureSqlArgs('clubs.database.windows.net'), { server: 'clubs.database.windows.net', prod: false });
  assert.throws(() => parseAzureSqlArgs('clubs.database.windows.net ClubA --password-from rg/app'), /add --user/);
  assert.throws(() => parseAzureSqlArgs('clubs.database.windows.net ClubA --user u --password-from rg'), /--password-from is <resource-group>\/<app>\[\/<slot>\]/);
  assert.throws(() => parseAzureSqlArgs('clubs.database.windows.net --subscription x'), /--subscription goes with --password-from/);
  assert.throws(() => parseAzureSqlArgs('a b c'), /Too many arguments/);
  assert.throws(() => parseAzureSqlArgs('--nope'), /Unknown option --nope/);

  assert.deepEqual(parseArgs(['q.sql', '--connect', 'club-a']), { file: 'q.sql', connect: 'club-a', demo: false, azureSql: null });
  assert.deepEqual(parseArgs(['--azure-sql', 'clubs.database.windows.net', '--database', 'ClubA', '--user', 'sa', '--name', 'clubs-sa', '--prod', '--folder', 'Azure', '--password-from', 'rg/api']).azureSql, {
    server: 'clubs.database.windows.net',
    database: 'ClubA',
    name: 'clubs-sa',
    user: 'sa',
    prod: true,
    folder: 'Azure',
    passwordFrom: { resourceGroup: 'rg', app: 'api' },
  });
  assert.equal(parseArgs(['--demo']).connect, 'demo');
  assert.throws(() => parseArgs(['--database', 'ClubA']), /--database goes with --azure-sql/);
  assert.throws(() => parseArgs(['--azure-sql']), /--azure-sql needs a value/);
  assert.throws(() => parseArgs(['--azure-sql', 'x', '--user', '--prod']), /--user needs a value/);
});

// An App Service's connection strings and app settings as az lists them.
const CONNECTION_STRINGS = JSON.stringify([
  { name: 'Other', type: 'SQLAzure', value: 'Server=tcp:other.database.windows.net,1433;Database=ClubA;User ID=app;Password=wrong;' },
  { name: 'Clubs', type: 'SQLAzure', value: 'Server=tcp:Clubs.database.windows.net,1433;Initial Catalog=cluba;User ID=APP@clubs;Password="p;w""d";Encrypt=True' },
]);
const SETTINGS = JSON.stringify([{ name: 'ConnectionStrings__Reports', value: 'Data Source=clubs.database.windows.net;Database=Reports;UID=app;PWD=reports-pw' }, { name: 'WEBSITE_RUN_FROM_PACKAGE', value: '1' }]);
function appAz() {
  const calls = [];
  const run = async (args) => (calls.push(args.join(' ')), args[2] === 'connection-string' ? CONNECTION_STRINGS : SETTINGS);
  return { calls, run };
}

test("a login's password from an App Service: the connection string with the same server, database and user", async () => {
  assert.deepEqual(parseConnectionString("Server=x; Password='a;b''c' ;User ID = u"), { server: 'x', password: "a;b'c", 'user id': 'u' });
  const conn = { name: 'clubs', server: 'clubs.database.windows.net', database: 'ClubA', auth: 'sql', user: 'app' };
  const { calls, run } = appAz();
  assert.equal(await passwordFromApp(conn, { subscription: 's1', resourceGroup: 'rg', app: 'api', slot: 'staging' }, { run }), 'p;w"d');
  assert.deepEqual(calls, ['webapp config connection-string list -g rg -n api --slot staging --subscription s1 -o json', 'webapp config appsettings list -g rg -n api --slot staging --subscription s1 -o json']);
  // App settings count too; a database or user no string has finds nothing.
  assert.equal(await passwordFromApp({ ...conn, database: 'Reports' }, { resourceGroup: 'rg', app: 'api' }, { run }), 'reports-pw');
  assert.equal(await passwordFromApp({ ...conn, user: 'someone' }, { resourceGroup: 'rg', app: 'api' }, { run }), null);
});

test('the password is the one given, the environment, the store, then the App Service; a stored one turned down is tried from there', async () => {
  const conn = { name: 'clubs', server: 'clubs.database.windows.net', database: 'ClubA', auth: 'sql', user: 'app', passwordFrom: { resourceGroup: 'rg', app: 'api' } };
  const { calls, run } = appAz();
  assert.deepEqual(await findPassword(conn, { credentials: memoryCredentials({ clubs: 'stored' }), az: run }), { password: 'stored', from: 'store' });
  assert.deepEqual(calls, [], 'az only when the store has none');
  assert.deepEqual(await findPassword(conn, { credentials: memoryCredentials(), az: run }), { password: 'p;w"d', from: 'azure' });
  const { passwordFrom, ...plain } = conn;
  await assert.rejects(findPassword(plain, { credentials: memoryCredentials(), az: run }), (e) => e.needsPassword);
  await assert.rejects(findPassword({ ...conn, passwordFrom: { resourceGroup: 'rg', app: 'none' } }, { credentials: memoryCredentials(), az: async () => '[]' }), (e) => e.needsPassword && /none in none's connection strings matches/.test(e.message));

  // A rotated password: the stored one is turned down, the App Service's signs in.
  const tried = [];
  const attempt = async (opts) => {
    const found = await findPassword(conn, opts);
    tried.push(found.from);
    if (found.password !== 'p;w"d') throw Object.assign(new DbError("Login failed for user 'app'.", { needsPassword: true }), { passwordSource: found.from });
    return { found };
  };
  const s = await signIn(conn, { credentials: memoryCredentials({ clubs: 'old' }), az: run }, attempt);
  assert.deepEqual(tried, ['store', 'azure']);
  assert.equal(s.found.from, 'azure');
  // Without passwordFrom, or with a typed one turned down, nothing more is tried.
  tried.length = 0;
  await assert.rejects(signIn(plain, { credentials: memoryCredentials({ clubs: 'old' }), az: run }, (o) => attempt({ ...o, password: 'typed' })), /Login failed/);
  assert.deepEqual(tried, ['given']);
});
