// Imports DataGrip's data sources as Trawl connections, in DataGrip's folders. Only the
// connection details come across: DataGrip keeps passwords encrypted in its own store, which
// Trawl never opens, so a SQL login's password is asked for the first time it connects.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEMO_CONNECTIONS, cleanFolder, connectionRows } from './connections.js';
import { STORE_NAME } from './credentials.js';

const decode = (s) =>
  String(s ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

const attr = (attrs, name) => {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? decode(m[1]) : null;
};
const child = (body, name) => {
  const m = body.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]).trim() : null;
};

/**
 * The <data-source> entries of a DataGrip XML file: { uuid, name, group, driver, url, user,
 * readOnly, removed }. History files wrap each in <DataSourceFromHistory isRemovedFromProject>.
 */
export function parseDataSources(xml) {
  const out = [];
  const text = String(xml ?? '');
  const re = /(<DataSourceFromHistory\b([^>]*)>\s*)?<data-source\b([^>]*)>([\s\S]*?)<\/data-source>/g;
  for (const m of text.matchAll(re)) {
    const [, , wrapper = '', attrs, body] = m;
    out.push({
      uuid: attr(attrs, 'uuid'),
      name: attr(attrs, 'name') ?? '',
      group: attr(attrs, 'group'),
      driver: child(body, 'driver-ref'),
      url: child(body, 'jdbc-url'),
      user: child(body, 'user-name'),
      readOnly: child(body, 'read-only') === 'true' || attr(attrs, 'read-only') === 'true',
      // DataGrip writes this only for "Tx: Manual" (auto-commit is its default).
      manualCommit: child(body, 'auto-commit') === 'false' || attr(attrs, 'auto-commit') === 'false',
      removed: attr(wrapper, 'isRemovedFromProject') === 'true',
    });
  }
  return out;
}

/** Folds dataSources.local.xml (login names) into the entries of dataSources.xml, by uuid. */
export function mergeLocal(sources, local) {
  const byUuid = new Map(local.map((l) => [l.uuid, l]));
  return sources.map((s) => {
    const l = byUuid.get(s.uuid);
    return l ? { ...s, user: s.user ?? l.user, readOnly: s.readOnly || l.readOnly, manualCommit: s.manualCommit || l.manualCommit } : s;
  });
}

/**
 * Reads a SQL Server JDBC URL: jdbc:sqlserver://host[\instance][:port][;key=value…] or
 * jdbc:jtds:sqlserver://host[:port][/database][;key=value…]. Null for anything else.
 */
export function parseJdbcUrl(url) {
  const ms = String(url ?? '').match(/^jdbc:sqlserver:\/\/([^;:\\/]*)(?:\\([^;:]+))?(?::(\d+))?\/?(?:;(.*))?$/i);
  const jtds = !ms && String(url ?? '').match(/^jdbc:jtds:sqlserver:\/\/([^;:/]*)(?::(\d+))?(?:\/([^;]*))?(?:;(.*))?$/i);
  if (!ms && !jtds) return null;
  const props = {};
  for (const pair of String((ms ? ms[4] : jtds[4]) ?? '').split(';')) {
    const at = pair.indexOf('=');
    if (at > 0) props[pair.slice(0, at).trim().toLowerCase()] = pair.slice(at + 1).trim();
  }
  if (ms) return { host: ms[1], instance: ms[2] ?? props.instancename ?? null, port: ms[3] ? Number(ms[3]) : null, database: props.database ?? props.databasename ?? null, props };
  return { host: jtds[1], instance: props.instance ?? null, port: jtds[2] ? Number(jtds[2]) : null, database: jtds[3] || props.databasename || null, props };
}

/**
 * A Trawl-style name: "defaultdb@host" → "defaultdb", "@localhost" → "localhost",
 * "myserver.database.windows.net" → "myserver", "FUNDS" → "funds".
 */
export function connectionName(ds, host) {
  let base = ds.name.includes('@') ? ds.name.split('@')[0] || ds.name.split('@')[1] : ds.name;
  if (!base) base = host ?? 'datagrip';
  // A host name stands for its first label.
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(base)) base = base.split('.')[0];
  return base.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'datagrip';
}

// `trawl --demo` puts its own connections under these names, so imports keep off them.
export const RESERVED_NAMES = DEMO_CONNECTIONS.map((c) => c.name);

/** `name`, or name-2, name-3 … when that's taken. */
function freeName(name, taken) {
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) if (!taken.has(`${name}-${n}`)) return `${name}-${n}`;
}

const sameTarget = (a, b) =>
  a.server.toLowerCase() === b.server.toLowerCase() && (a.database ?? '').toLowerCase() === (b.database ?? '').toLowerCase() && (a.user ?? '') === (b.user ?? '');

// Production as Keel and Trawl name it: a PROD folder in DataGrip, or prod in the name.
const PROD = /(^|[^a-z])(prod|production|prd|live)([^a-z]|$)/i;

/**
 * One DataGrip data source as a Trawl connection: { conn } to add, or { skip } saying why not
 * (with `same`, the connection Trawl already has for it, when that's why). `taken` holds the
 * names in use (lower case); `existing` the connections Trawl already has, so importing twice
 * doesn't add anything twice.
 */
export function toConnection(ds, taken = new Set(), existing = []) {
  const jdbc = parseJdbcUrl(ds.url);
  const label = ds.name || ds.url;
  if (!jdbc) {
    const kind = (ds.driver ?? String(ds.url ?? '').split(':')[1] ?? 'this database').replace(/\..*/, '');
    return { skip: `${label}: ${kind} isn't supported yet (Trawl speaks SQL Server and Azure SQL)` };
  }
  const name = freeName(connectionName(ds, jdbc.host), taken);
  // MSSQLSERVER is the default instance's own name, which a named-instance lookup can't find.
  const instance = jdbc.instance && jdbc.instance.toUpperCase() !== 'MSSQLSERVER' ? jdbc.instance : null;
  const server = `${jdbc.host}${instance ? `\\${instance}` : jdbc.port && jdbc.port !== 1433 ? `,${jdbc.port}` : ''}`;
  const authProp = String(jdbc.props.authentication ?? '').toLowerCase();
  const azure = /\.database\.(windows\.net|azure\.com|usgovcloudapi\.net|chinacloudapi\.cn)$/i.test(jdbc.host) || ds.driver === 'azure.ms';
  const conn = { name, server, ...(jdbc.database ? { database: jdbc.database } : {}) };
  if (authProp.startsWith('activedirectory')) conn.auth = 'azure-cli';
  else if (jdbc.props.integratedsecurity === 'true') return { skip: `${label}: Windows integrated sign-in isn't supported; add it with /add … --user <login> --domain <domain> --password-env <VAR>` };
  else if (ds.user) Object.assign(conn, { auth: 'sql', user: ds.user });
  else if (azure) conn.auth = 'azure-cli';
  else return { skip: `${label}: no login is saved for it in DataGrip` };
  if (jdbc.props.trustservercertificate === 'true') conn.trustCert = true;
  if (jdbc.props.encrypt === 'false') conn.encrypt = false;
  if (PROD.test(ds.group ?? '') || PROD.test(ds.name)) conn.prod = true;
  if (ds.readOnly) conn.readOnly = true;
  if (ds.manualCommit) conn.commit = 'manual';
  const same = existing.find((c) => !c.demo && c.server && sameTarget(c, conn));
  if (same) return { skip: `${label}: already in Trawl as ${same.name}`, same };
  const folder = cleanFolder(ds.group);
  if (folder) conn.folder = folder;
  conn.from = 'DataGrip';
  return { conn };
}

const versionOf = (dir) => (dir.match(/(\d{4})\.(\d+)/) ?? []).slice(1).map(Number);
const newestFirst = (a, b) => {
  const [x, y] = [versionOf(a), versionOf(b)];
  return (y[0] ?? 0) - (x[0] ?? 0) || (y[1] ?? 0) - (x[1] ?? 0);
};

const read = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};
const dirs = (path) => {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
};

/** A project's .idea (or the folder itself): dataSources.xml with its .local.xml folded in. */
function readProject(dir, where) {
  const idea = existsSync(join(dir, '.idea', 'dataSources.xml')) ? join(dir, '.idea') : dir;
  const main = read(join(idea, 'dataSources.xml'));
  if (!main) return [];
  const local = parseDataSources(read(join(idea, 'dataSources.local.xml')) ?? '');
  return mergeLocal(parseDataSources(main), local).map((s) => ({ ...s, where }));
}

/**
 * Every data source DataGrip knows about: its projects, its global data sources, and the
 * history it keeps per project (where newer versions hold them), newest DataGrip version first,
 * each uuid once. `folder` reads just that project instead.
 */
export function findDataSources({ folder, home = homedir(), appData = process.env.APPDATA ?? join(home, '.config') } = {}) {
  if (folder) return readProject(folder, folder);
  const found = [];
  const projects = join(home, 'DataGripProjects');
  for (const p of dirs(projects)) found.push(...readProject(join(projects, p), `project ${p}`));
  const jb = join(appData, 'JetBrains');
  for (const v of dirs(jb).filter((d) => /^datagrip/i.test(d)).sort(newestFirst)) {
    found.push(...readProject(join(jb, v, 'options'), `${v} global`));
    const history = join(jb, v, 'dataSourcesHistory');
    for (const h of dirs(history)) {
      const xml = read(join(history, h, 'data_sources_history.xml'));
      if (xml) found.push(...parseDataSources(xml).filter((s) => !s.removed).map((s) => ({ ...s, where: `${v} history` })));
    }
  }
  const seen = new Set();
  return found.filter((s) => {
    const key = s.uuid ?? `${s.name}|${s.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * What an import would do against the connections Trawl has: { add: [conn], skip: [reason],
 * file: [{ name, folder }] }. `file` puts connections Trawl already has, and that are in no
 * folder, into their DataGrip folder.
 */
export function importPlan(sources, existing) {
  const taken = new Set([...RESERVED_NAMES, ...existing.map((c) => c.name.toLowerCase())]);
  const add = [];
  const skip = [];
  const file = [];
  for (const ds of sources) {
    const r = toConnection(ds, taken, [...existing, ...add]);
    if (r.conn) {
      add.push(r.conn);
      taken.add(r.conn.name.toLowerCase());
      continue;
    }
    skip.push(r.skip);
    const folder = cleanFolder(ds.group);
    if (folder && r.same && !r.same.folder && existing.includes(r.same) && !file.some((f) => f.name === r.same.name)) file.push({ name: r.same.name, folder });
  }
  return { add, skip, file };
}

/** The preview shown before importing. */
export function planText({ add, skip, file = [] }) {
  const lines = [];
  if (add.length) {
    lines.push(`Will add ${add.length} connection${add.length === 1 ? '' : 's'}:`, '');
    const w = Math.max(...add.map((c) => c.name.length)) + 2;
    for (const row of connectionRows(add)) {
      if (row.folder) {
        lines.push(`  ${row.folder}/`);
        continue;
      }
      const c = row.conn;
      const how = c.auth === 'sql' ? `login ${c.user}` : 'az login';
      lines.push(`  ${row.inFolder ? '  ' : ''}${c.name.padEnd(w)}${c.server}${c.database ? `/${c.database}` : ''}${c.prod ? '  PROD (read-only)' : ''}  · ${how}`);
    }
  } else lines.push(file.length ? 'No new connections.' : 'Nothing to add.');
  if (file.length) {
    lines.push('', `Will put ${file.length} connection${file.length === 1 ? '' : 's'} Trawl already has into their DataGrip folder:`);
    for (const f of file) lines.push(`  ${f.name} → ${f.folder}/`);
  }
  if (skip.length) lines.push('', `Skipped ${skip.length}:`, ...skip.map((s) => `  ${s}`));
  if (add.some((c) => c.auth === 'sql')) {
    lines.push(
      '',
      'Passwords stay in DataGrip (encrypted); Trawl never reads them. Trawl asks for each login’s',
      `password the first time you connect to it, and keeps it in ${STORE_NAME}.`,
    );
  }
  if (add.some((c) => c.prod)) lines.push('', 'Connections in a PROD folder (or named prod) become production: read-only until /writes.');
  return lines.join('\n');
}
