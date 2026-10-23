// Azure SQL: the firewall through a stand-in az, and the --azure-sql and store-password hand-over
// Sonar uses. Nothing here starts the real az or reaches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { addFirewallRule, firewallBlock, publicIp, ruleName, serverHost } from '../src/azure.js';
import { azureSqlAddArgs, findAzureSql, parseAddArgs } from '../src/connections.js';
import { parseArgs, readAll, storePassword } from '../src/launch.js';
import { memoryCredentials } from '../src/credentials.js';

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

test('--azure-sql finds the saved connection by server, database and login, or says what /add would save', () => {
  const saved = [
    { name: 'clubs', server: 'tcp:CLUBS.database.windows.net,1433', database: 'ClubA', auth: 'azure-cli' },
    { name: 'clubs-sa', server: 'clubs.database.windows.net', database: 'ClubA', auth: 'sql', user: 'sa' },
    { name: 'pg', kind: 'postgres', server: 'clubs.database.windows.net', database: 'ClubA', auth: 'sql', user: 'sa' },
  ];
  assert.equal(findAzureSql(saved, { server: 'clubs.database.windows.net', database: 'cluba' })?.name, 'clubs');
  assert.equal(findAzureSql(saved, { server: 'clubs.database.windows.net', database: 'ClubA', user: 'SA' })?.name, 'clubs-sa');
  assert.equal(findAzureSql(saved, { server: 'clubs.database.windows.net', database: 'ClubB' }), null);
  assert.equal(findAzureSql(saved, { server: 'clubs.database.windows.net' }), null, 'no database is not any database');

  const add = azureSqlAddArgs(saved, { server: 'clubs.database.windows.net', database: 'ClubB', prod: true, folder: 'Azure / PROD' });
  assert.equal(add.name, 'clubs-ClubB');
  assert.deepEqual(parseAddArgs(add.args), { name: 'clubs-ClubB', server: 'clubs.database.windows.net', database: 'ClubB', auth: 'azure-cli', prod: true, folder: 'Azure/PROD' });
  // A name that's taken gets a number; the demo's names count as taken too.
  assert.equal(azureSqlAddArgs(saved, { server: 'clubs.database.windows.net' }).name, 'clubs-2');
  assert.equal(azureSqlAddArgs(saved, { server: 'demo.database.windows.net' }).name, 'demo-2');
  const login = azureSqlAddArgs(saved, { server: 'clubs.database.windows.net', database: 'ClubA', user: 'app "x"', name: 'Clubs app' });
  assert.deepEqual(parseAddArgs(login.args), { name: 'Clubs app', server: 'clubs.database.windows.net', database: 'ClubA', auth: 'sql', user: 'app "x"' });
});

test('the command line: --azure-sql and its options, which only go with it', () => {
  assert.deepEqual(parseArgs(['q.sql', '--connect', 'club-a']), { file: 'q.sql', connect: 'club-a', demo: false, azureSql: null });
  assert.deepEqual(parseArgs(['--azure-sql', 'clubs.database.windows.net', '--database', 'ClubA', '--user', 'sa', '--name', 'clubs-sa', '--prod', '--folder', 'Azure']).azureSql, {
    server: 'clubs.database.windows.net',
    database: 'ClubA',
    name: 'clubs-sa',
    user: 'sa',
    prod: true,
    folder: 'Azure',
  });
  assert.deepEqual(parseArgs(['--azure-sql', 'clubs.database.windows.net']).azureSql, { server: 'clubs.database.windows.net', prod: false });
  assert.equal(parseArgs(['--demo']).connect, 'demo');
  assert.throws(() => parseArgs(['--database', 'ClubA']), /--database goes with --azure-sql/);
  assert.throws(() => parseArgs(['--azure-sql']), /--azure-sql needs a value/);
  assert.throws(() => parseArgs(['--azure-sql', 'x', '--user', '--prod']), /--user needs a value/);
});

test('store-password saves what comes on stdin under the connection name, one line ending dropped', async () => {
  const credentials = memoryCredentials();
  assert.match(await storePassword('clubs-sa', await readAll(Readable.from(['s3cret pass', '\r\n'])), credentials), /Saved the password for clubs-sa in memory/);
  assert.equal(credentials.saved.get('clubs-sa'), 's3cret pass');
  await storePassword('two', 'line\n\n', credentials);
  assert.equal(credentials.saved.get('two'), 'line\n', 'only one line ending goes');
  await assert.rejects(storePassword('x', '\n', credentials), /No password on stdin/);
  await assert.rejects(storePassword(undefined, 'pw', credentials), /Usage: trawl store-password <connection>/);
});
