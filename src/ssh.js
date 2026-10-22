// SSH tunnels: a connection with `ssh` ({ user, host, port, key }, from /add --ssh) reaches its
// server through that host, by the system's own ssh client (no native module, and nothing secret
// in the config):
//   ssh -N -L 127.0.0.1:<free port>:<server>:<port> -o BatchMode=yes … user@bastion
// The driver then connects to the free port on this machine. BatchMode means a key or an agent
// only: ssh runs with no terminal, so it can never ask for a password, a passphrase or whether to
// trust a new host key; it fails instead, and its own words become the error.
import { spawn as spawnProcess } from 'node:child_process';
import { homedir } from 'node:os';
import net from 'node:net';
import { hostPort, sshText } from './connections.js';
import { DbError } from './db.js';
import { dialectOf } from './dialects.js';

/**
 * Where the tunnel goes from the SSH host: the connection's server and port, as the SSH host sees
 * them (a name only it can resolve works). { host, port }.
 */
export function tunnelTarget(conn) {
  const dialect = dialectOf(conn);
  const server = String(conn.server);
  if (dialect.kind !== 'sqlserver') return hostPort(server, dialect.defaultPort);
  const comma = server.match(/^(.*),(\d+)$/);
  if (comma) return { host: comma[1], port: Number(comma[2]) };
  if (/\\/.test(server)) throw new DbError(`${conn.name} names an instance (${server}), which needs SQL Browser on UDP; an SSH tunnel only carries TCP. Give its port instead: ${server.replace(/\\.*$/, '')},1433`);
  return { host: server, port: dialect.defaultPort };
}

const bracket = (host) => (host.includes(':') ? `[${host}]` : host);

/** ~/ at the start of a key file is the home folder, as a shell would have it. */
const expandHome = (path) => (/^~[/\\]/.test(path) ? `${homedir()}${path.slice(1)}` : path);

/** ssh's arguments for a tunnel from 127.0.0.1:`localPort` to `target` through `ssh`. */
export function sshArgs(ssh, { localPort, target }) {
  return [
    '-N',
    '-L',
    `127.0.0.1:${localPort}:${bracket(target.host)}:${target.port}`,
    '-o',
    'BatchMode=yes',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ConnectTimeout=15',
    ...(ssh.port ? ['-p', String(ssh.port)] : []),
    ...(ssh.key ? ['-i', expandHome(ssh.key)] : []),
    `${ssh.user ? `${ssh.user}@` : ''}${ssh.host}`,
  ];
}

/** A TCP port on 127.0.0.1 nothing listens on just now. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const accepts = (port) =>
  new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
  });

// The tunnels open in this process, stopped when it exits however it exits.
const live = new Set();
let exitHook = false;

/**
 * Starts `command` with `args` (ssh's, or a stand-in in the tests) and waits until something
 * accepts connections on 127.0.0.1:`port`: { port, close(), stderr(), exited }. Rejects with a
 * DbError carrying the command's last words when it exits first, or after `timeout` ms.
 */
export function startTunnel({ command = 'ssh', args, port, name = command, signal, timeout = 20000, spawn = spawnProcess, poll = 100 }) {
  return new Promise((resolve, reject) => {
    let said = '';
    let exit = null;
    let done = false;
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on('data', (d) => (said = (said + d).slice(-4000)));
    const lastWords = () =>
      said
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l, i, all) => l && all.indexOf(l) === i)
        .slice(-3)
        .join(' ');
    const close = () => {
      live.delete(tunnel);
      if (exit == null) child.kill();
    };
    const tunnel = { port, close, stderr: lastWords, pid: child.pid };
    tunnel.exited = new Promise((r) => child.once('exit', (code, sig) => ((exit = { code, signal: sig }), live.delete(tunnel), r(exit))));
    const fail = (message, extra = {}) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      close();
      reject(new DbError(message, extra));
    };
    child.once('error', (e) => {
      exit = { error: e };
      fail(e.code === 'ENOENT' ? `${command} isn't installed, or isn't on the PATH: Trawl starts the system's ssh for a tunnel.` : `Couldn't start ${name}: ${e.message}`);
    });
    const onAbort = () => fail('Cancelled', { cancelled: true });
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => fail(`${name} didn't open the tunnel within ${Math.round(timeout / 1000)} seconds${lastWords() ? `: ${lastWords()}` : '.'}`), timeout);
    if (!exitHook) {
      exitHook = true;
      process.once('exit', () => {
        for (const t of live) t.close();
      });
    }
    live.add(tunnel);
    const check = async () => {
      if (done) return;
      if (exit) {
        // Let the last of stderr arrive.
        await new Promise((r) => setTimeout(r, 50));
        return fail(`${name} closed (exit code ${exit.code ?? exit.signal}): ${lastWords() || 'it said nothing.'}`);
      }
      if (await accepts(port)) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        return resolve(tunnel);
      }
      setTimeout(check, poll);
    };
    check();
  });
}

/**
 * Opens the tunnel for `conn` (whose `ssh` says through where): { port, host, targetPort, close(),
 * stderr() }. `command` and `spawn` are for the tests.
 */
export async function openTunnel(conn, { signal, command = 'ssh', spawn, timeout } = {}) {
  const target = tunnelTarget(conn);
  const localPort = await freePort();
  const args = sshArgs(conn.ssh, { localPort, target });
  let tunnel;
  try {
    tunnel = await startTunnel({ command, args, port: localPort, name: `ssh ${sshText(conn.ssh)}`, signal, spawn, timeout });
  } catch (e) {
    if (!e.cancelled && /Permission denied|Host key verification failed|passphrase/i.test(e.message)) {
      e.message += '\nTrawl runs ssh without a terminal (BatchMode): it signs in with a key or your ssh agent only, and the host must already be in known_hosts (ssh to it once yourself).';
    }
    throw e;
  }
  return Object.assign(tunnel, { host: target.host, targetPort: target.port });
}
