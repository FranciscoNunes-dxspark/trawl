// /backup and /restore, pure: what's refused, the SQL Server statements (the backup is a file on the
// server, in its default backup folder unless a path says otherwise) and the pg_dump / pg_restore
// and mysqldump / mysql command lines, whose password goes in the child's environment only
// (PGPASSWORD, MYSQL_PWD), never on the command line.
import { serverHost } from './azure.js';
import { hostPort, isReadOnly } from './connections.js';

export const AZURE_SQL_NOTE =
  "Azure SQL Database has no BACKUP to a file: it keeps backups of its own (restore to a point in time from the portal). For a copy to take elsewhere, export a .bacpac: the database's Export in the Azure portal, or SqlPackage /Action:Export.";

/** Whether a server is Azure SQL Database's (myserver.database.windows.net and the other clouds'). */
export const isAzureSqlDatabase = (conn) => /\.database\.(windows\.net|azure\.com|chinacloudapi\.cn|usgovcloudapi\.net|cloudapi\.de)$/i.test(serverHost(conn?.server ?? ''));

/** Why /backup or /restore won't run on `conn` (production, read-only, Azure SQL, a tunnel the tools can't use), or null. */
export function backupRefusal(conn, kind = 'sqlserver') {
  if (conn.prod) return `${conn.name} is production: /backup and /restore only work on a connection that is neither production nor read-only, such as a dev database.`;
  if (isReadOnly(conn)) return `${conn.name} is read-only: /backup and /restore only work on a connection that is neither production nor read-only, such as a dev database.`;
  if (kind === 'sqlserver' && isAzureSqlDatabase(conn)) return AZURE_SQL_NOTE;
  if (kind !== 'sqlserver' && conn.ssh) return `${conn.name} goes through an SSH tunnel, which ${kind === 'postgres' ? 'pg_dump' : 'mysqldump'} can't use: run it on ${conn.ssh} instead.`;
  return null;
}

/** "20261024-153012", for file names (UTC). */
export const stamp = (now = new Date()) => now.toISOString().slice(0, 19).replace(/-|:/g, '').replace('T', '-');

/** A name safe in a file name on any system. */
export const fileSafe = (s) => String(s).replace(/[^\w.-]+/g, '_');

// ---------------------------------------------------------------------------------------------------
// SQL Server: the file is on the server, so its paths are the server's (Windows or Linux).

export const BACKUP_INFO_SQL = `-- trawl:backup-info
SELECT CAST(SERVERPROPERTY('InstanceDefaultBackupPath') AS nvarchar(4000)) AS backup_path,
  CAST(SERVERPROPERTY('InstanceDefaultDataPath') AS nvarchar(4000)) AS data_path,
  CAST(SERVERPROPERTY('InstanceDefaultLogPath') AS nvarchar(4000)) AS log_path,
  CAST(SERVERPROPERTY('EngineEdition') AS int) AS engine_edition,
  CAST(SERVERPROPERTY('MachineName') AS nvarchar(256)) AS machine;`;

const windowsPath = (p) => /^[A-Za-z]:|\\/.test(p);
/** Whether a path on the server is a whole one (C:\…, \\share\…, /var/…). */
export const absoluteOnServer = (p) => /^([A-Za-z]:[\\/]|\\\\|\/)/.test(p);
/** A folder and a name joined the server's way. */
export function serverJoin(dir, name) {
  const sep = windowsPath(dir) ? '\\' : '/';
  return `${String(dir).replace(/[\\/]+$/, '')}${sep}${name}`;
}
const folderOf = (p) => String(p).replace(/[\\/][^\\/]*$/, '');

/** Where a backup goes on the server: the path given when it's a whole one, else in the default backup folder. */
export function backupPath(info, database, file, now = new Date()) {
  if (file && absoluteOnServer(file)) return file;
  if (!info.backup_path) return null;
  return serverJoin(info.backup_path, file || `${fileSafe(database)}-${stamp(now)}.bak`);
}

const nstring = (s) => `N'${String(s).replace(/'/g, "''")}'`;
const bracket = (s) => `[${String(s).replace(/]/g, ']]')}]`;

export const backupSql = (database, path) => `BACKUP DATABASE ${bracket(database)} TO DISK = ${nstring(path)} WITH COPY_ONLY, INIT, STATS = 10;`;
export const restoreHeaderSql = (path) => `-- trawl:restore-header\nRESTORE HEADERONLY FROM DISK = ${nstring(path)};`;
export const restoreFilesSql = (path) => `-- trawl:restore-files\nRESTORE FILELISTONLY FROM DISK = ${nstring(path)};`;

/**
 * The backup's files moved to the target's own names in the server's default data and log folders
 * (or beside where they were): [{ logical, to }]. Restoring under another name would otherwise
 * collide with the original's files.
 */
export function restoreMoves(files, target, info) {
  const counts = { D: 0, L: 0, F: 0 };
  return files.map((f) => {
    const type = String(f.Type ?? 'D').toUpperCase();
    const n = counts[type] = (counts[type] ?? 0) + 1;
    const dir = (type === 'L' ? info.log_path : info.data_path) || folderOf(f.PhysicalName);
    const name = type === 'L' ? `${fileSafe(target)}_log${n > 1 ? n : ''}.ldf` : type === 'F' ? `${fileSafe(target)}_fs${n}` : n === 1 ? `${fileSafe(target)}.mdf` : `${fileSafe(target)}_${n}.ndf`;
    return { logical: f.LogicalName, to: serverJoin(dir, name) };
  });
}

/** RESTORE DATABASE from `path` as `target`, from master; over one that's there, its other sessions are put out first. */
export function restoreSql({ target, path, moves, replace }) {
  const lines = ['USE master;'];
  if (replace) lines.push(`ALTER DATABASE ${bracket(target)} SET SINGLE_USER WITH ROLLBACK IMMEDIATE;`);
  const withs = [...moves.map((m) => `MOVE ${nstring(m.logical)} TO ${nstring(m.to)}`), ...(replace ? ['REPLACE'] : []), 'RECOVERY', 'STATS = 10'];
  lines.push(`RESTORE DATABASE ${bracket(target)} FROM DISK = ${nstring(path)}\n  WITH ${withs.join(',\n    ')};`);
  return lines.join('\n');
}

export const multiUserSql = (target) => `ALTER DATABASE ${bracket(target)} SET MULTI_USER;`;

// ---------------------------------------------------------------------------------------------------
// PostgreSQL and MySQL, through their own tools on this machine.

/** An argument quoted for the shell run.js starts (cmd.exe on Windows, sh elsewhere). */
export function shellArg(s, platform = process.platform) {
  const v = String(s);
  if (platform === 'win32') return /^[\w.:\\/@=-]+$/.test(v) ? v : `"${v.replace(/"/g, '""')}"`;
  return /^[\w.:/@=-]+$/.test(v) ? v : `'${v.replace(/'/g, "'\\''")}'`;
}

const TOOLS = { postgres: { dump: 'pg_dump', load: 'pg_restore', ext: 'dump', from: "PostgreSQL's client tools" }, mysql: { dump: 'mysqldump', load: 'mysql', ext: 'sql', from: "MySQL's (or MariaDB's) client" } };
export const toolsFor = (kind) => TOOLS[kind];

function where(conn, kind) {
  const { host, port } = hostPort(conn.server, kind === 'postgres' ? 5432 : 3306);
  return { host, port };
}

/** The environment the tool gets the password (and TLS) from; nothing of it is on the command line. */
export function toolEnv(conn, kind, password) {
  if (kind === 'postgres') return { ...(password != null ? { PGPASSWORD: password } : {}), ...(conn.ssl || conn.trustCert ? { PGSSLMODE: 'require' } : {}) };
  return password != null ? { MYSQL_PWD: password } : {};
}

/** The dump: { command, env }. Postgres's custom format (-Fc), which pg_restore reads; MySQL's SQL, routines and triggers too. */
export function dumpCommand(conn, kind, { database, file, password }, platform = process.platform) {
  const q = (s) => shellArg(s, platform);
  const { host, port } = where(conn, kind);
  const user = conn.user ? [kind === 'postgres' ? '-U' : '--user', q(conn.user)] : [];
  const parts =
    kind === 'postgres'
      ? ['pg_dump', '-h', q(host), '-p', port, ...user, '-Fc', '--no-password', '-f', q(file), q(database)]
      : ['mysqldump', '--host', q(host), '--port', port, ...user, '--single-transaction', '--routines', '--triggers', '--events', `--result-file=${q(file)}`, q(database)];
  return { command: parts.join(' '), env: toolEnv(conn, kind, password) };
}

/** The restore into `database` (made first when it isn't there): { command, env }. Over one that's there, Postgres drops what the dump has first. */
export function loadCommand(conn, kind, { database, file, password, replace }, platform = process.platform) {
  const q = (s) => shellArg(s, platform);
  const { host, port } = where(conn, kind);
  const user = conn.user ? [kind === 'postgres' ? '-U' : '--user', q(conn.user)] : [];
  const parts =
    kind === 'postgres'
      ? ['pg_restore', '-h', q(host), '-p', port, ...user, '--no-password', '--no-owner', '--no-privileges', ...(replace ? ['--clean', '--if-exists'] : []), '-d', q(database), q(file)]
      : ['mysql', '--host', q(host), '--port', port, ...user, q(database), '<', q(file)];
  return { command: parts.join(' '), env: toolEnv(conn, kind, password) };
}

/** Whether a tool's failure says it isn't installed (the shell couldn't find it). */
export const notInstalled = (e) => e?.code === 127 || e?.code === 9009 || /command not found|: not found|is not recognized as an internal or external command/i.test(`${e?.stderr ?? ''} ${e?.message ?? ''}`);

/** Whether the server is this machine, so a path on it is a path here too. */
export function onThisMachine(conn, machine, hostname) {
  const host = serverHost(conn.server ?? '').replace(/\\.*$/, '').toLowerCase();
  if (['localhost', '127.0.0.1', '::1', '.', '(local)'].includes(host) || host.startsWith('(localdb)')) return true;
  const me = String(hostname ?? '').toLowerCase();
  return Boolean(me) && (host === me || host.split('.')[0] === me || String(machine ?? '').toLowerCase() === me);
}

/** /backup's and /restore's arguments: { file, as } or { reason }. */
export function parseBackupArgs(words, { restore = false } = {}) {
  const out = { file: null, as: null };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (restore && w === '--as') {
      out.as = words[++i] ?? null;
      if (!out.as) return { reason: '--as names the database to restore into.' };
    } else if (w.startsWith('--')) return { reason: `${restore ? '/restore <file> [--as <database>]' : '/backup [file]'} doesn't take ${w}.` };
    else if (out.file) return { reason: `One file: ${out.file}, then ${w}? Put a path with spaces in quotes.` };
    else out.file = w;
  }
  if (restore && !out.file) return { reason: 'Which backup? /restore <file> [--as <database>]' };
  return out;
}
