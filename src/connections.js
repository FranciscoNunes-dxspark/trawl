import { kindOf } from './dialects.js';
import { parsePasswordFrom, serverHost } from './azure.js';

// Saved connections: parsing /add, and turning one into tedious's connection options.
// config.json holds nothing secret. Azure SQL signs in with your Azure CLI login; a SQL login's
// password is asked for when connecting and kept in the OS credential store (credentials.js),
// unless the connection names an environment variable that holds it.

/** Splits command arguments on spaces, keeping "quoted parts" together. */
export function splitArgs(s) {
  const out = [];
  for (const m of String(s ?? '').matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]);
  return out;
}

export const ADD_USAGE = '/add <name> <server> [database] [--kind sqlserver|postgres|mysql] [--user <login> [--password-env <VAR>]] [--domain <domain>] [--folder <folder>] [--prod] [--commit auto|manual] [--trust-cert] [--ssl] [--ssh [user@]host[:port] [--ssh-key <file>]] [--ai off|schema|results]';

/**
 * Reads `/add` arguments into a connection. Without --user it signs in through the Azure CLI.
 * Throws with the usage when something is missing.
 */
export function parseAddArgs(rest) {
  const args = splitArgs(rest);
  const conn = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const value = () => {
      const v = args[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value. ${ADD_USAGE}`);
      return v;
    };
    if (a === '--user') conn.user = value();
    else if (a === '--password-env') conn.passwordEnv = value();
    else if (a === '--ssh') {
      try {
        conn.ssh = { ...conn.ssh, ...parseSsh(value()) };
      } catch (e) {
        throw new Error(`${e.message} ${ADD_USAGE}`);
      }
    } else if (a === '--ssh-key') conn.ssh = { ...conn.ssh, key: value() };
    else if (a === '--domain') conn.domain = value();
    else if (a === '--folder') {
      const folder = cleanFolder(value());
      if (folder) conn.folder = folder;
    }
    else if (a === '--kind') {
      const kind = kindOf(value());
      if (!kind) throw new Error(`--kind is sqlserver, postgres or mysql. ${ADD_USAGE}`);
      if (kind !== 'sqlserver') conn.kind = kind;
    } else if (a === '--ssl') conn.ssl = true;
    else if (a === '--prod') conn.prod = true;
    else if (a === '--trust-cert') conn.trustCert = true;
    else if (a === '--commit') {
      conn.commit = value();
      if (!['auto', 'manual'].includes(conn.commit)) throw new Error(`--commit is auto or manual. ${ADD_USAGE}`);
    } else if (a === '--ai') {
      conn.ai = value();
      if (!['off', 'schema', 'results'].includes(conn.ai)) throw new Error(`--ai is off, schema or results. ${ADD_USAGE}`);
    }
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}. ${ADD_USAGE}`);
    else positional.push(a);
  }
  const [name, server, database] = positional;
  if (!name || !server) throw new Error(ADD_USAGE);
  // `trawl --demo` would hide a saved connection with one of its names, and the next save drop it.
  if (DEMO_CONNECTIONS.some((d) => d.name === name.toLowerCase())) throw new Error(`${name} is the demo's name; pick another.`);
  if (positional.length > 3) throw new Error(`Too many arguments. ${ADD_USAGE}`);
  if (conn.passwordEnv && !conn.user) throw new Error('--password-env goes with --user.');
  if (conn.kind && !conn.user) throw new Error(`A ${conn.kind === 'postgres' ? 'Postgres' : 'MySQL'} connection signs in with a login: add --user <login>.`);
  if (conn.kind && conn.domain) throw new Error('--domain (Windows sign-in) is for SQL Server only.');
  if (conn.ssh && !conn.ssh.host) throw new Error('--ssh-key goes with --ssh user@host.');
  // A named instance is found through SQL Browser on UDP, which an SSH tunnel doesn't carry.
  if (conn.ssh && !conn.kind && parseServer(server).instanceName) throw new Error(`Through --ssh, give SQL Server's port rather than an instance name: ${server.replace(/\\.*$/, '')},1433`);
  return { name, server, ...(database ? { database } : {}), auth: conn.user ? (conn.domain ? 'ntlm' : 'sql') : 'azure-cli', ...conn };
}

/** /add --ssh: "user@bastion:2222" → { user, host, port }; the user and port are optional (ssh's own config can say them). Throws when it isn't one. */
export function parseSsh(spec) {
  const m = String(spec ?? '')
    .trim()
    .match(/^(?:([^@\s/\\-][^@\s/\\]*)@)?(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9_][A-Za-z0-9_.-]*)(?::(\d{1,5}))?$/);
  if (!m) throw new Error(`--ssh is [user@]host[:port], as ssh takes it: "${spec}" isn't one.`);
  const port = m[3] ? Number(m[3]) : null;
  if (port != null && (port < 1 || port > 65535)) throw new Error(`--ssh's port is 1 to 65535, not ${port}.`);
  return { ...(m[1] ? { user: m[1] } : {}), host: m[2].replace(/^\[|\]$/g, ''), ...(port ? { port } : {}) };
}

/** "user@bastion:2222", as it was typed. */
export const sshText = (ssh) => `${ssh.user ? `${ssh.user}@` : ''}${ssh.host.includes(':') ? `[${ssh.host}]` : ssh.host}${ssh.port ? `:${ssh.port}` : ''}`;

/** "PROD / Clubs " → "PROD/Clubs": a folder, with "/" between nested ones as DataGrip writes them. */
export const cleanFolder = (s) =>
  String(s ?? '')
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean)
    .join('/');

/**
 * The Connections list as rows: each folder's heading ({ folder }) then its connections
 * ({ conn }), folders by name, and last the connections in no folder, as DataGrip lists them.
 */
export function connectionRows(connections) {
  const byFolder = new Map();
  for (const c of connections) {
    const f = c.folder ?? '';
    if (!byFolder.has(f)) byFolder.set(f, []);
    byFolder.get(f).push(c);
  }
  const folders = [...byFolder.keys()].filter(Boolean).sort((x, y) => x.localeCompare(y, undefined, { sensitivity: 'base' }));
  const rows = [];
  for (const f of folders) rows.push({ folder: f, count: byFolder.get(f).length }, ...byFolder.get(f).map((conn) => ({ conn, inFolder: true })));
  for (const conn of byFolder.get('') ?? []) rows.push({ conn, inFolder: false });
  return rows;
}

/** Production connections are read-only unless the connection says otherwise. */
export const isReadOnly = (conn) => conn.readOnly ?? Boolean(conn.prod);

/**
 * 'auto' or 'manual', as DataGrip's transaction modes. Manual: a write opens a transaction that
 * waits for /commit or /rollback. Production is manual unless the connection says otherwise.
 */
export const commitMode = (conn) => conn.commit ?? (conn.prod ? 'manual' : 'auto');

/** "server/database" (and the SSH host it goes through), for the header and the Connections list. */
export const describeConn = (conn) =>
  conn.demo ? `demo/${conn.database}` : `${conn.kind ? `${conn.kind}://` : ''}${conn.server}/${conn.database ?? '(default)'}${conn.ssh?.host ? ` via ssh ${sshText(conn.ssh)}` : ''}`;

/** "host:5432" or "host,5432" (Postgres, MySQL): { host, port }, `port` the default when not given. */
export function hostPort(server, port) {
  const m = String(server).match(/^(.*)[:,](\d+)$/);
  return m && !m[1].includes(':') ? { host: m[1], port: Number(m[2]) } : { host: String(server), port };
}

/** "host,1433" and "host\INSTANCE" as SQL Server tools write them. */
export function parseServer(server) {
  const comma = server.match(/^(.*),(\d+)$/);
  if (comma) return { host: comma[1], port: Number(comma[2]) };
  const slash = server.match(/^(.*)\\(.+)$/);
  if (slash) return { host: slash[1], instanceName: slash[2] };
  return { host: server };
}

/**
 * tedious options for `conn`. `token` is an Entra access token (azure-cli auth), `password`
 * the SQL or Windows password (found by the caller: typed, environment or credential store).
 * `connector` opens the sockets instead of tedious (db.js's, for an SSH tunnel); the server keeps
 * its own name, which the login and the certificate check go by.
 */
export function tediousConfig(conn, { token, password, database = conn.database, connector } = {}) {
  const { host, port, instanceName } = parseServer(conn.server);
  const authentication =
    conn.auth === 'azure-cli'
      ? { type: 'azure-active-directory-access-token', options: { token } }
      : conn.auth === 'ntlm'
        ? { type: 'ntlm', options: { userName: conn.user, password, domain: conn.domain } }
        : { type: 'default', options: { userName: conn.user, password } };
  return {
    server: host,
    authentication,
    options: {
      ...(database ? { database } : {}),
      ...(port ? { port } : {}),
      ...(instanceName ? { instanceName } : {}),
      // Through a tunnel the port must be known: there's no SQL Browser to ask.
      ...(connector ? { connector, port: port ?? 1433 } : {}),
      encrypt: conn.encrypt ?? true,
      trustServerCertificate: Boolean(conn.trustCert),
      connectTimeout: 20000,
      // No timeout: a long query runs until it finishes or esc cancels it.
      requestTimeout: 0,
      appName: 'Trawl',
      useUTC: true,
    },
  };
}

/** The connections `trawl --demo` adds for the session: an ordinary one and a production one. */
export const DEMO_CONNECTIONS = [
  { name: 'demo', demo: true, server: 'demo', database: 'ClubA' },
  { name: 'demo-prod', demo: true, prod: true, server: 'demo', database: 'ClubA' },
];

export const AZURE_SQL_USAGE = '/azure-sql <server> [database] [--name <name>] [--user <login>] [--prod] [--folder <folder>] [--password-from <resource-group>/<app>[/<slot>]] [--subscription <id>]';

/**
 * An Azure SQL hand-over (/azure-sql, or trawl --azure-sql) checked: { server, database, name, user,
 * prod, folder, passwordFrom }, the empty ones left out. `passwordFrom` is "rg/app[/slot]", which
 * goes with a --user, and `subscription` the one it's in. Throws, saying what's wrong.
 */
export function azureSqlSpec({ server, database, name, user, prod, folder, passwordFrom, subscription }) {
  if (!server || !serverHost(server)) throw new Error(AZURE_SQL_USAGE);
  if (passwordFrom && !user) throw new Error('--password-from reads a SQL login\'s password: add --user <login>.');
  if (subscription && !passwordFrom) throw new Error('--subscription goes with --password-from.');
  const spec = { server, database, name, user, prod: Boolean(prod), folder: cleanFolder(folder) || undefined, passwordFrom: passwordFrom ? parsePasswordFrom(passwordFrom, subscription) : undefined };
  for (const k of Object.keys(spec)) if (spec[k] === undefined) delete spec[k];
  return spec;
}

/** /azure-sql's arguments as azureSqlSpec's. */
export function parseAzureSqlArgs(rest) {
  const args = splitArgs(rest);
  const fields = {};
  const positional = [];
  const OPTIONS = { '--name': 'name', '--user': 'user', '--folder': 'folder', '--password-from': 'passwordFrom', '--subscription': 'subscription' };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--prod') fields.prod = true;
    else if (OPTIONS[a]) {
      const v = args[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value. ${AZURE_SQL_USAGE}`);
      fields[OPTIONS[a]] = v;
    } else if (a.startsWith('--')) throw new Error(`Unknown option ${a}. ${AZURE_SQL_USAGE}`);
    else positional.push(a);
  }
  if (positional.length > 2) throw new Error(`Too many arguments. ${AZURE_SQL_USAGE}`);
  [fields.server, fields.database] = positional;
  return azureSqlSpec(fields);
}

/**
 * /azure-sql (Sonar copies one for you to paste): the saved SQL Server connection to the same server
 * (tcp: and ,1433 aside, any case), database and login (none: az login), or null.
 */
export function findAzureSql(connections, { server, database, user }) {
  const same = (x, y) => String(x ?? '').toLowerCase() === String(y ?? '').toLowerCase();
  return connections.find((c) => !c.demo && !c.kind && serverHost(c.server) === serverHost(server) && same(c.database, database) && (user ? c.auth !== 'azure-cli' && same(c.user, user) : c.auth === 'azure-cli')) ?? null;
}

/**
 * The connection to save for an /azure-sql that isn't saved yet, as /add would make it. Its name is
 * `name`, else the server's own (its first label) and the database's, made unique among
 * `connections` (and the demo's) with -2, -3…; `passwordFrom` is kept on it.
 */
export function azureSqlConnection(connections, { server, database, user, name, prod, folder, passwordFrom }) {
  const host = serverHost(server);
  const wanted = name || `${host.split('.')[0]}${database ? `-${database}` : ''}`;
  const taken = new Set([...connections, ...DEMO_CONNECTIONS].map((c) => c.name.toLowerCase()));
  let chosen = wanted;
  for (let n = 2; taken.has(chosen.toLowerCase()); n++) chosen = `${wanted}-${n}`;
  const q = (v) => `"${String(v).replace(/["\\]/g, '\\$&')}"`;
  const args = [q(chosen), q(host), ...(database ? [q(database)] : []), ...(user ? ['--user', q(user)] : []), ...(prod ? ['--prod'] : []), ...(folder ? ['--folder', q(folder)] : [])];
  return { ...parseAddArgs(args.join(' ')), ...(passwordFrom ? { passwordFrom } : {}) };
}
