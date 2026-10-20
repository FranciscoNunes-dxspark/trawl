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

export const ADD_USAGE = '/add <name> <server> [database] [--user <login> [--password-env <VAR>]] [--domain <domain>] [--folder <folder>] [--prod] [--commit auto|manual] [--trust-cert] [--ai off|schema|results]';

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
    else if (a === '--domain') conn.domain = value();
    else if (a === '--folder') {
      const folder = cleanFolder(value());
      if (folder) conn.folder = folder;
    }
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
  return { name, server, ...(database ? { database } : {}), auth: conn.user ? (conn.domain ? 'ntlm' : 'sql') : 'azure-cli', ...conn };
}

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

/** "server/database", for the header and the Connections list. */
export const describeConn = (conn) => (conn.demo ? `demo/${conn.database}` : `${conn.server}/${conn.database ?? '(default)'}`);

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
 */
export function tediousConfig(conn, { token, password, database = conn.database } = {}) {
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
