// PostgreSQL behind the same session interface as db.js's SQL Server one, through pg (plain
// JavaScript, so the Bun build carries it). A script runs a statement at a time (dialects.js
// splitScript). A statement that reads rows goes through a portal that hands over the row limit and
// one more, then is closed (LimitedQuery), so the server stops there, as SQL Server's does, and an open
// transaction carries on. esc cancels with pg_cancel_backend.
import pg from 'pg';
import { DbError, connectionLost, ended, runScript } from './db.js';
import { DIALECTS, splitScript } from './dialects.js';
import { hostPort } from './connections.js';

const dialect = DIALECTS.postgres;

// The type names the grid goes by (numbers right-aligned): pg's type ids for the common ones.
const TYPES = { 16: 'bit', 17: 'bytea', 20: 'BigInt', 21: 'SmallInt', 23: 'Int', 25: 'text', 114: 'json', 700: 'Real', 701: 'Float', 790: 'Money', 1042: 'char', 1043: 'varchar', 1082: 'date', 1083: 'time', 1114: 'timestamp', 1184: 'timestamptz', 1700: 'Numeric', 2950: 'uuid', 3802: 'jsonb' };

// Timestamps without a zone are read as UTC (as tedious's useUTC does), and dates kept as written.
// A timestamp a JavaScript date can't hold (infinity, BC) stays as the server wrote it, as do
// intervals, points and circles, which pg would make into objects that print as JSON.
const asText = (s) => s;
const textArray = pg.types.getTypeParser(1009);
const stamp = (parse) => (s) => {
  const d = parse(s);
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d : s;
};
const PARSERS = {
  1082: asText,
  1114: stamp((s) => new Date(`${s.replace(' ', 'T')}Z`)),
  1184: stamp(pg.types.getTypeParser(1184)),
  1186: asText,
  1187: textArray,
  600: asText,
  1017: textArray,
  718: asText,
  719: textArray,
};
export const types = {
  getTypeParser(oid, format) {
    return (format ?? 'text') === 'text' && PARSERS[oid] ? PARSERS[oid] : pg.types.getTypeParser(oid, format);
  },
};

/**
 * The pg options for a connection: host:port from `server`, TLS when asked for (--ssl, or
 * --trust-cert without checking it). Through an SSH `tunnel` it connects to the tunnel's end on
 * this machine, and the certificate is still checked against the server's own name.
 */
export function pgConfig(conn, { database = conn.database, password, tunnel } = {}) {
  const { host, port } = hostPort(conn.server, dialect.defaultPort);
  let ssl = conn.trustCert ? { rejectUnauthorized: false } : conn.ssl || conn.encrypt ? true : false;
  if (tunnel && ssl) ssl = { ...(ssl === true ? {} : ssl), servername: host };
  const at = tunnel ? { host: '127.0.0.1', port: tunnel.port } : { host, port };
  return { ...at, user: conn.user, password, database: database ?? 'postgres', ssl, application_name: 'Trawl', connectionTimeoutMillis: 20000, types };
}

/** Opens a session (see db.js connect). Throws a DbError; `badLogin` when the password was turned down. */
export async function open(conn, { database, password, signal, tunnel } = {}) {
  const config = pgConfig(conn, { database, password, tunnel });
  const client = new pg.Client(config);
  const onAbort = () => client.end().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await client.connect();
  } catch (e) {
    if (signal?.aborted) throw new DbError('Cancelled', { cancelled: true });
    const err = new DbError(e.message, { number: e.code ?? null });
    // 28P01: wrong password; 28000: no such login (or pg_hba refuses it).
    err.badLogin = e.code === '28P01';
    if (/self[- ]signed|unable to verify|certificate/i.test(e.message) && !conn.trustCert) err.untrustedCert = true;
    throw err;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  return postgresSession(conn, client, { database: config.database, cancel: () => cancelBackend(config, client.processID) });
}

// esc: a second connection asks the server to cancel what this one runs.
async function cancelBackend(config, pid) {
  const other = new pg.Client({ ...config, connectionTimeoutMillis: 5000 });
  try {
    await other.connect();
    await other.query('SELECT pg_cancel_backend($1)', [pid]);
  } finally {
    other.end().catch(() => {});
  }
}

/**
 * A query through the extended protocol's portal, which hands over at most `limit + 1` rows: when the
 * server suspends it there (there are more), the portal is closed and the exchange ended with Sync,
 * so the rest are never read, the server stops, and a transaction stays usable (a cancel would fail
 * it). Its rows come back as pg's usual result, the one extra row saying there were more.
 */
export class LimitedQuery extends pg.Query {
  constructor(text, limit) {
    super({ text, rowMode: 'array', rows: limit + 1 });
    this.synced = false;
    this.submitted = false;
  }
  submit(connection) {
    this.submitted = true;
    return super.submit(connection);
  }
  handlePortalSuspended(connection) {
    this.synced = true;
    connection.close({ type: 'P', name: this.portal });
    connection.sync();
  }
  handleCommandComplete(msg, connection) {
    this.synced = true;
    super.handleCommandComplete(msg, connection);
  }
  handleEmptyQuery(connection) {
    this.synced = true;
    super.handleEmptyQuery(connection);
  }
  // The server skips everything after an error until Sync, which pg leaves to the query when it pages.
  handleError(err, connection) {
    if (this.submitted && !this.synced) {
      this.synced = true;
      connection.sync();
    }
    super.handleError(err, connection);
  }
}

// Statements that read rows, which go through LimitedQuery; the rest go as a simple query.
const READS = /^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/|\()*(SELECT|WITH|TABLE|VALUES|SHOW|FETCH)\b/i;
export const readsRows = (text) => READS.test(text);

/**
 * Sends one statement: a read through LimitedQuery, anything else as it is. A stand-in client (the
 * tests') that answers a query with a promise is taken at its word.
 */
export function send(client, text, limit) {
  if (!readsRows(text) || !Number.isSafeInteger(limit)) return client.query({ text, rowMode: 'array' });
  return new Promise((resolve, reject) => {
    const q = new LimitedQuery(text, limit);
    q.callback = (err, res) => (err ? reject(err) : resolve(res));
    const answer = client.query(q);
    if (typeof answer?.then === 'function') answer.then(resolve, reject);
  });
}

/** One statement's results into the shared state: result sets cut at `limit`, and rows affected. */
export function collectResult(result, state, limit) {
  for (const r of Array.isArray(result) ? result : [result]) {
    if (r.fields?.length) {
      const rows = r.rows ?? [];
      const set = { columns: r.fields.map((f) => ({ name: f.name, type: TYPES[f.dataTypeID] ?? '' })), rows: rows.slice(0, limit), truncated: rows.length > limit };
      state.sets.push(set);
      if (set.truncated) state.stopped = true;
    } else if (/^(INSERT|UPDATE|DELETE|MERGE|COPY)$/.test(r.command ?? '') && r.rowCount != null) {
      state.messages.push(`${r.rowCount} row${r.rowCount === 1 ? '' : 's'} affected`);
    }
  }
}

/**
 * A Postgres error's message as psql shows it: with the server's DETAIL (which key was a duplicate),
 * HINT and CONTEXT (the line of the function it failed in), each on a line of its own. A DO block's
 * own RAISE (saving edits raises one) says all it means in its message.
 */
export function errorText(e) {
  const where = /^PL\/pgSQL function inline_code_block line \d+ at RAISE$/.test(e.where ?? '') ? null : e.where;
  return [e.message, ...[['DETAIL', e.detail], ['HINT', e.hint], ['CONTEXT', where]].filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`)].join('\n');
}

/** The line a Postgres error points at (its character `position`), counted in the whole script. */
const errorLine = (e, text, line) => (e.position ? line + text.slice(0, Number(e.position) - 1).split('\n').length - 1 : line);

/**
 * A session over a connected client ({ query(config), on, end, getTransactionStatus }), with the same
 * interface as db.js's. `cancel()` stops the running query. The tests pass a stand-in client.
 */
export function postgresSession(conn, client, { database = null, cancel = async () => {} } = {}) {
  let messages = null;
  const session = {
    conn,
    database,
    dialect: dialect.kind,
    closed: false,
    onEnd: null,
    run: (script, opts = {}) =>
      runScript(
        session,
        script,
        async (text, line, state) => {
          const { signal, limit = 500 } = opts;
          const onAbort = () => cancel().catch(() => {});
          signal?.addEventListener('abort', onAbort, { once: true });
          try {
            collectResult(await send(client, text, limit), state, limit);
          } catch (e) {
            if (e.code === '57014' || signal?.aborted) throw new DbError('Cancelled', { cancelled: true });
            throw new DbError(errorText(e), { number: e.code ?? null, line: errorLine(e, text, line), lost: connectionLost(e) });
          } finally {
            signal?.removeEventListener('abort', onAbort);
          }
        },
        { ...opts, split: (s) => splitScript(s, dialect) },
      ),
    // The protocol says whether a transaction is open ('T') or failed and waiting for ROLLBACK ('E').
    async tranCount() {
      const status = client.getTransactionStatus?.();
      return status === 'T' || status === 'E' ? 1 : 0;
    },
    close() {
      if (!session.closed) client.end().catch(() => {});
    },
    collect(list) {
      messages = list;
    },
  };
  client.on('notice', (n) => messages?.push(n.message));
  client.on('end', () => ended(session));
  // An idle client whose connection drops says so here (and then ends).
  client.on('error', (e) => connectionLost(e) && ended(session));
  return session;
}
