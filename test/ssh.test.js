// SSH tunnel connections: /add --ssh, ssh's arguments, and starting and waiting for the tunnel.
// No real ssh server is reached: the spawn and wait logic runs against stand-in commands (node).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { ADD_USAGE, describeConn, parseAddArgs, parseSsh, sshText, tediousConfig } from '../src/connections.js';
import { pgConfig } from '../src/db-postgres.js';
import { mysqlConfig } from '../src/db-mysql.js';
import { connect } from '../src/db.js';
import { freePort, sshArgs, startTunnel, tunnelTarget } from '../src/ssh.js';

test('--ssh takes [user@]host[:port], and --ssh-key a key file; nothing secret is kept', () => {
  assert.deepEqual(parseSsh('me@bastion.example.com:2222'), { user: 'me', host: 'bastion.example.com', port: 2222 });
  assert.deepEqual(parseSsh('jump'), { host: 'jump' });
  assert.deepEqual(parseSsh('ops@[2001:db8::1]'), { user: 'ops', host: '2001:db8::1' });
  assert.throws(() => parseSsh('-oProxyCommand=evil'), /\[user@\]host\[:port\]/);
  assert.throws(() => parseSsh('me@host:99999'), /1 to 65535/);
  assert.throws(() => parseSsh('me@host extra'), /isn't one/);
  assert.equal(sshText({ user: 'ops', host: '2001:db8::1', port: 22 }), 'ops@[2001:db8::1]:22');

  const c = parseAddArgs('vault 10.0.4.12,1433 Ops --user ops --ssh me@bastion:2222 --ssh-key ~/.ssh/id_ed25519');
  assert.deepEqual(c.ssh, { user: 'me', host: 'bastion', port: 2222, key: '~/.ssh/id_ed25519' });
  assert.equal(describeConn(c), '10.0.4.12,1433/Ops via ssh me@bastion:2222');
  assert.equal(parseAddArgs('pg db.internal shop --kind postgres --user app --ssh jump').ssh.host, 'jump');
  assert.throws(() => parseAddArgs('x srv --ssh-key k'), /--ssh-key goes with --ssh/);
  assert.throws(() => parseAddArgs('x srv --ssh'), /--ssh needs a value/);
  assert.throws(() => parseAddArgs('x srv --ssh "a b"'), new RegExp(ADD_USAGE.replace(/[[\]().*+?|^$\\{}]/g, '\\$&')));
  // A named instance is found over UDP, which a tunnel doesn't carry.
  assert.throws(() => parseAddArgs('x sqlhost\\SQLEXPRESS --ssh jump'), /sqlhost,1433/);
  assert.equal('password' in c || JSON.stringify(c).includes('secret'), false);
});

test('ssh forwards a local port to the server as the SSH host sees it, never asking anything', () => {
  assert.deepEqual(tunnelTarget({ server: 'db.internal,1444' }), { host: 'db.internal', port: 1444 });
  assert.deepEqual(tunnelTarget({ server: 'db.internal' }), { host: 'db.internal', port: 1433 });
  assert.deepEqual(tunnelTarget({ server: 'pg.internal', kind: 'postgres' }), { host: 'pg.internal', port: 5432 });
  assert.deepEqual(tunnelTarget({ server: 'my.internal:3307', kind: 'mysql' }), { host: 'my.internal', port: 3307 });
  assert.throws(() => tunnelTarget({ name: 'x', server: 'h\\INST' }), /SQL Browser/);
  const args = sshArgs({ user: 'me', host: 'bastion', port: 2222, key: 'C:\\keys\\id' }, { localPort: 50123, target: { host: 'db.internal', port: 1433 } });
  assert.deepEqual(args, ['-N', '-L', '127.0.0.1:50123:db.internal:1433', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ConnectTimeout=15', '-p', '2222', '-i', 'C:\\keys\\id', 'me@bastion']);
  assert.deepEqual(sshArgs({ host: 'jump' }, { localPort: 1, target: { host: '::1', port: 5432 } }).slice(1, 3), ['-L', '127.0.0.1:1:[::1]:5432']);
  assert.equal(sshArgs({ host: 'jump' }, { localPort: 1, target: { host: 'h', port: 1 } }).at(-1), 'jump');
  assert.doesNotMatch(sshArgs({ host: 'h', key: '~/.ssh/k' }, { localPort: 1, target: { host: 'h', port: 1 } }).join(' '), /~/);
});

test('through a tunnel each driver connects on this machine and still checks the certificate against the server’s name', () => {
  const tunnel = { port: 50123, host: 'pg.internal', targetPort: 5432 };
  const pg = pgConfig({ server: 'pg.internal', user: 'u', ssl: true }, { tunnel });
  assert.deepEqual([pg.host, pg.port, pg.ssl], ['127.0.0.1', 50123, { servername: 'pg.internal' }]);
  assert.equal(pgConfig({ server: 'pg.internal', user: 'u' }, { tunnel }).ssl, false);
  // mysql2 is handed the socket, so its host stays the server's own, which TLS goes by.
  assert.equal(mysqlConfig({ server: 'my.internal', user: 'u', ssl: true }).host, 'my.internal');
  const connector = async () => {};
  const t = tediousConfig({ server: 'db.internal', auth: 'sql', user: 'sa' }, { password: 'pw', connector });
  assert.equal(t.server, 'db.internal', 'the login and TLS go by the server’s own name');
  assert.equal(t.options.connector, connector);
  assert.equal(t.options.port, 1433);
  assert.equal(t.options.trustServerCertificate, false);
});

const node = (script) => ({ command: process.execPath, args: ['-e', script] });

test('the tunnel is up once its port accepts, and closing it stops the command', async () => {
  const port = await freePort();
  const { command, args } = node(`require('net').createServer((s) => s.end()).listen(${port}, '127.0.0.1')`);
  const tunnel = await startTunnel({ command, args, port, timeout: 10000 });
  assert.equal(tunnel.port, port);
  tunnel.close();
  const exit = await tunnel.exited;
  assert.ok(exit.signal || exit.code != null);
});

test('ssh exiting first is an error with what it said; a missing ssh, a timeout and esc too', async () => {
  const port = await freePort();
  const dies = node("console.error('me@bastion: Permission denied (publickey).'); process.exit(255)");
  await assert.rejects(startTunnel({ ...dies, port, name: 'ssh me@bastion' }), (e) => /ssh me@bastion closed \(exit code 255\): me@bastion: Permission denied \(publickey\)\./.test(e.message));
  await assert.rejects(startTunnel({ command: 'trawl-no-such-ssh', args: [], port, name: 'ssh x' }), /trawl-no-such-ssh isn't installed, or isn't on the PATH/);
  const hangs = node('setInterval(() => {}, 1000)');
  await assert.rejects(startTunnel({ ...hangs, port, timeout: 300 }), /didn't open the tunnel within 0 seconds/);
  const controller = new AbortController();
  const waiting = startTunnel({ ...hangs, port, signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting, (e) => e.cancelled);
});

test('connect starts ssh with the forward, and stops it when the server can’t be reached through it', async () => {
  // A stand-in for ssh: listens where -L says, and drops every connection as a refused forward would.
  const fake = `
    const [, local] = process.argv.slice(1)[process.argv.slice(1).indexOf('-L') + 1].split(':');
    require('net').createServer((s) => { console.error('channel 2: open failed: connect failed: Connection refused'); s.destroy(); }).listen(Number(local), '127.0.0.1');`;
  for (const [kind, port] of [['postgres', 5432], ['mysql', 3306], [undefined, 1433]]) {
    const started = [];
    const fakeSpawn = (cmd, args, opts) => {
      const child = spawn(process.execPath, ['-e', fake, '--', ...args], opts);
      started.push({ cmd, args, exited: new Promise((r) => child.once('exit', r)) });
      return child;
    };
    const conn = { name: 'x', ...(kind ? { kind } : {}), server: 'db.internal', user: 'app', auth: 'sql', ssh: { user: 'me', host: 'bastion' } };
    await assert.rejects(connect(conn, { password: 'x', ssh: { spawn: fakeSpawn } }), (e) => /ssh: channel 2: open failed/.test(e.message), kind ?? 'sqlserver');
    assert.equal(started[0].cmd, 'ssh');
    assert.match(started[0].args.join(' '), new RegExp(`^-N -L 127\\.0\\.0\\.1:\\d+:db\\.internal:${port} .*BatchMode=yes.* me@bastion$`));
    await started[0].exited;
  }
});

test('the Connections tab shows the SSH host a connection goes through', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const React = (await import('react')).default;
  const { render } = await import('ink-testing-library');
  const { App } = await import('../src/ui/App.jsx');
  const home = mkdtempSync(join(tmpdir(), 'trawl-ssh-'));
  process.env.TRAWL_HOME = home;
  const vault = { name: 'vault', server: 'db.internal,1433', database: 'Ops', auth: 'sql', user: 'ops', ssh: { user: 'me', host: 'bastion', key: '~/.ssh/ops' } };
  const app = render(React.createElement(App, { config: { connections: [vault], history: [], ran: [], limit: 500, last: null } }));
  try {
    const end = Date.now() + 8000;
    app.stdin.write('5');
    while (!/SSH key/.test(app.lastFrame()) && Date.now() < end) await new Promise((r) => setTimeout(r, 40));
    assert.match(app.lastFrame(), /db\.internal,1433\/Ops via ssh me@bastion/);
    assert.match(app.lastFrame(), /SSH\s+me@bastion\s+\(a tunnel\)/);
    assert.match(app.lastFrame(), /SSH key\s+~\/\.ssh\/ops/);
  } finally {
    app.unmount();
    rmSync(home, { recursive: true, force: true });
  }
});
