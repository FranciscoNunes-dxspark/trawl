// Trawl's side of the family (family.js is the part every sibling shares): what it hands the others,
// what it does with what they hand it, the databases a project's files name, and Glim's mood in the
// family's words. Pure.
import { databaseOf, describeContext, quoteArg, shareLine, takeLine } from './family.js';
import { serverHost } from './azure.js';
import { DEMO_CONNECTIONS } from './connections.js';
import { valueLiteral } from './edit.js';

/** The siblings' names as people say them, and their mascots'. */
export const APPS = { splice: 'Splice', trawl: 'Trawl', sonar: 'Sonar', bosun: 'Bosun', hail: 'Hail' };
export const PETS = { splice: 'Twig', trawl: 'Glim', sonar: 'Ping', bosun: 'Squawk', hail: 'Hoot' };

/** What the log says once a line is copied for `app` ('Hail'): the line, or for a /take what it holds. */
export function handOverText(app, line, context = null) {
  return `Copied for ${app}: paste it into ${app}'s prompt\n${context ? describeContext(context) : line}`;
}

// Who takes the contexts Trawl doesn't.
const TAKERS = { request: ['Hail'], commit: ['Splice'], file: ['Splice'], exception: ['Splice', 'Sonar'], logline: ['Splice', 'Hail'] };

/** What Trawl says about a context of a kind it doesn't take: whose it is. */
export function notForTrawl({ kind, data }) {
  const who = TAKERS[kind] ?? [];
  const what = describeContext({ kind, data });
  return who.length ? `That's ${/^[aeiou]/i.test(what) ? 'an' : 'a'} ${what}, for ${who.join(' or ')}: paste it into ${who.join("'s or ")}'s prompt instead.` : `Trawl doesn't take a ${kind}.`;
}

/**
 * What this project offers the siblings (family.js projectAt's answer): [{ app, line, detail }],
 * Splice `/open <repo>`, Bosun `/move <dir>` when it has something to run, Hail `/open <file>` per .http file.
 */
export function familyOffers(project) {
  const out = [];
  if (project.repo) out.push({ app: 'Splice', line: shareLine('open', [project.repo]), detail: `the repository ${project.repo}` });
  if (project.crew) out.push({ app: 'Bosun', line: shareLine('move', [project.dir]), detail: `run the project's processes in ${project.dir}` });
  for (const f of project.httpFiles ?? []) out.push({ app: 'Hail', line: shareLine('open', [f]), detail: `the requests in ${f}` });
  return out;
}

const same = (x, y) => String(x ?? '').toLowerCase() === String(y ?? '').toLowerCase();

/** The saved connection to the database a project file names (server, database and login alike), or null. */
export function savedFor(connections, db) {
  return connections.find((c) => !c.demo && (c.kind ?? 'sqlserver') === db.kind && serverHost(c.server) === serverHost(db.server) && same(c.database, db.database) && (db.user && !db.entra ? same(c.user, db.user) : !c.user)) ?? null;
}

/** The databases of a project (projectAt's `databases`) that no saved connection is to yet. */
export const newDatabases = (project, connections) => (project?.databases ?? []).filter((db) => !savedFor(connections, db));

/** "Found 2 databases in appsettings.Development.json and .env: /project to add them", or null. */
export function projectNote(found) {
  if (!found.length) return null;
  const files = [...new Set(found.map((d) => d.source))];
  const list = files.length > 2 ? `${files.slice(0, -1).join(', ')} and ${files.at(-1)}` : files.join(' and ');
  return `Found ${found.length === 1 ? 'a database' : `${found.length} databases`} in ${list}: /project to add ${found.length === 1 ? 'it' : 'them'}.`;
}

/**
 * The /add arguments for a project's database (a projectAt entry): named after its key (made unique
 * among `connections` and the demo's), the server as /add takes it (host,port for SQL Server,
 * host:port for the others), its database and login. No --user signs in with az login.
 */
export function addArgsFor(db, connections) {
  const wanted = String(db.name).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  const taken = new Set([...connections, ...DEMO_CONNECTIONS].map((c) => c.name.toLowerCase()));
  let name = wanted;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${wanted}-${n}`;
  const server = db.port ? (db.kind === 'sqlserver' ? `${db.server},${db.port}` : `${db.server}:${db.port}`) : db.server;
  const args = [name, server, ...(db.database ? [db.database] : []), ...(db.kind !== 'sqlserver' ? ['--kind', db.kind] : []), ...(db.user && !db.entra ? ['--user', db.user] : [])];
  return args.map(quoteArg).join(' ');
}

/** The saved connection a /take query was for: to its server and database, else to its server; or null. */
export function connectionForQuery(connections, { server, database }) {
  if (!server) return null;
  const host = serverHost(server);
  const on = connections.filter((c) => serverHost(c.server) === host || (c.demo && host === 'demo'));
  // The one to that database, else one to the same server (connected to that database instead), not production when there's a choice.
  return on.find((c) => same(c.database, database)) ?? on.find((c) => !c.prod) ?? on[0] ?? null;
}

/** /take rows: the rows as an INSERT … VALUES script into their table (`<table>` when it came without one). */
export function rowsScript({ table, columns = [], rows = [], server, database }, { quote = (n) => `[${String(n).replace(/]/g, ']]')}]`, kind = 'sqlserver' } = {}) {
  const name = table ? String(table).split('.').map(quote).join('.') : '<table>';
  const literal = (v) => (v == null ? 'NULL' : valueLiteral(typeof v === 'object' ? JSON.stringify(v) : v, 'nvarchar', kind));
  const head = [`-- ${rows.length} row${rows.length === 1 ? '' : 's'}${table ? ` of ${table}` : ''}${server || database ? ` from ${[server, database].filter(Boolean).join('/')}` : ''}, handed over. Nothing has run: read it, then R runs it.`];
  if (!table) head.push('-- They came without a table: put its name in place of <table>.');
  if (!rows.length) return `${head.join('\n')}\n`;
  const values = rows.map((r) => `(${columns.map((_, i) => literal(r[i])).join(', ')})`);
  return `${head.join('\n')}\nINSERT INTO ${name} (${columns.map(quote).join(', ')}) VALUES\n  ${values.join(',\n  ')};\n`;
}

// Columns whose values never go into a line for another app.
const SECRET_COLUMN = /pass(word|wd)?$|pwd$|secret|token|api_?key|salt|hash$/i;

/**
 * The rows `set` holds at `indexes`, as a `rows` context: plain JSON values (dates as text, binary as
 * hex), and nothing from a column that looks like it holds a secret (those are null, and `hidden`
 * names them).
 */
export function rowsContext(set, indexes, { table = null, server = null, database = null } = {}) {
  const hidden = set.columns.filter((c) => SECRET_COLUMN.test(c.name)).map((c) => c.name);
  const plain = (v, c) => {
    if (v == null || hidden.includes(c.name)) return null;
    if (v instanceof Date) return /^date$/i.test(String(c.type ?? '').trim()) ? v.toISOString().slice(0, 10) : v.toISOString().replace('T', ' ').replace(/\.000Z$|Z$/, '');
    if (Buffer.isBuffer(v)) return `0x${v.toString('hex').toUpperCase()}`;
    if (typeof v === 'bigint') return String(v);
    return v;
  };
  const data = {
    ...(server ? { server } : {}),
    ...(database ? { database } : {}),
    ...(table ? { table } : {}),
    columns: set.columns.map((c) => c.name),
    rows: indexes.map((i) => set.rows[i].map((v, k) => plain(v, set.columns[k]))),
  };
  return { line: takeLine('rows', data), context: { kind: 'rows', data }, hidden };
}

/** A `query` context's line for SQL on a connection. */
export function queryContext(sql, { server = null, database = null } = {}) {
  const data = { sql: String(sql).trim(), ...(server ? { server } : {}), ...(database ? { database } : {}) };
  return { line: takeLine('query', data), context: { kind: 'query', data } };
}

/**
 * Glim's mood in the family's words ({ mood, reason }): a failed run is sad, an open transaction
 * worried, a run busy, a good one happy, otherwise neutral.
 */
export function familyMood(glim, { session = null, lastEntry = null, tranMinutes = 0, busy = null } = {}) {
  const where = session ? `${session.conn.name}/${session.database ?? ''}`.replace(/\/$/, '') : null;
  switch (glim) {
    case 'worried':
      return { mood: 'sad', reason: `query failed${where ? ` on ${where}` : ''}${lastEntry?.lines?.[0] ? `: ${String(lastEntry.lines[0]).slice(0, 100)}` : ''}` };
    case 'alert':
      return { mood: 'worried', reason: `transaction open${tranMinutes >= 1 ? ` ${Math.floor(tranMinutes)} min` : ''}${where ? ` on ${where}` : ''}` };
    case 'look':
      return { mood: 'busy', reason: busy?.label ? String(busy.label) : 'running a query' };
    case 'happy':
      return { mood: 'happy', reason: `query worked${where ? ` on ${where}` : ''}` };
    default:
      return { mood: 'neutral', reason: where ? `connected to ${where}` : 'not connected' };
  }
}

const REACTS = new Set(['worried', 'sad', 'happy']);

/** The siblings' moods (family.js readMoods) Glim reacts to, newest first, leaving out those in `seen` (app:at keys). */
export function moodsToShow(moods, seen = new Set()) {
  return moods.filter((m) => REACTS.has(m.mood) && !seen.has(`${m.app}:${m.at}`));
}

/** Glim's one line about a sibling's mood: "Ping says: production has 12 new exceptions". */
export function reactionText({ app, mood, reason }) {
  const who = PETS[app] ?? APPS[app] ?? app;
  return reason ? `${who} says: ${reason}` : `${who} is ${mood}`;
}

/** What /take says about a database a query or rows were for: "server/database". */
export const placeText = ({ server, database }) => [server, database].filter(Boolean).join('/') || 'no database said';

export { databaseOf };
