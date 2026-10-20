// MySQL (and MariaDB) behind the same session interface as db.js's SQL Server one, through mysql2
// (plain JavaScript). A script runs a statement at a time (dialects.js splitScript; DELIMITER isn't
// understood), each result set cut at the row limit after it has arrived. esc cancels with KILL QUERY
// from a second connection.
import mysql from 'mysql2/promise';
import { DbError, runScript } from './db.js';
import { DIALECTS, splitScript } from './dialects.js';
import { hostPort } from './connections.js';

const dialect = DIALECTS.mysql;

// mysql2's column type codes for the numbers (right-aligned in the grid) and a few others.
const TYPES = { 0: 'Decimal', 1: 'TinyInt', 2: 'SmallInt', 3: 'Int', 4: 'Real', 5: 'Float', 8: 'BigInt', 9: 'Int', 10: 'date', 12: 'datetime', 13: 'Int', 246: 'Decimal', 252: 'text', 253: 'varchar', 254: 'char', 245: 'json' };

/** The mysql2 options for a connection: host:port from `server`, TLS when asked for. */
export function mysqlConfig(conn, { database = conn.database, password } = {}) {
  const { host, port } = hostPort(conn.server, dialect.defaultPort);
  const ssl = conn.trustCert ? { rejectUnauthorized: false } : conn.ssl || conn.encrypt ? {} : undefined;
  return { host, port, user: conn.user, password, database, ssl, timezone: 'Z', dateStrings: ['DATE'], supportBigNumbers: true, bigNumberStrings: true, connectTimeout: 20000, multipleStatements: false };
}

export async function open(conn, { database, password, signal } = {}) {
  const config = mysqlConfig(conn, { database, password });
  let c;
  try {
    c = await mysql.createConnection(config);
  } catch (e) {
    if (signal?.aborted) throw new DbError('Cancelled', { cancelled: true });
    const err = new DbError(e.message, { number: e.errno ?? null });
    err.badLogin = e.errno === 1045;
    if (/self[- ]signed|unable to verify|certificate/i.test(e.message) && !conn.trustCert) err.untrustedCert = true;
    throw err;
  }
  if (signal?.aborted) {
    c.destroy();
    throw new DbError('Cancelled', { cancelled: true });
  }
  return mysqlSession(conn, c, { database: database ?? null, cancel: () => killQuery(config, c.threadId) });
}

async function killQuery(config, id) {
  const other = await mysql.createConnection({ ...config, connectTimeout: 5000 });
  try {
    await other.query(`KILL QUERY ${Number(id)}`);
  } finally {
    other.destroy();
  }
}

/** One statement's answer ([rows, fields] from mysql2, a CALL's several) into the shared state. */
export function collectResult([rows, fields], state, limit) {
  const pairs = Array.isArray(fields) && Array.isArray(fields[0]) ? rows.map((r, i) => [r, fields[i]]) : [[rows, fields]];
  for (const [r, f] of pairs) {
    if (Array.isArray(r) && Array.isArray(f)) {
      const set = { columns: f.map((x) => ({ name: x.name, type: TYPES[x.columnType ?? x.type] ?? '' })), rows: r.slice(0, limit), truncated: r.length > limit };
      state.sets.push(set);
      if (set.truncated) state.stopped = true;
    } else if (r && typeof r.affectedRows === 'number' && f === undefined) {
      state.messages.push(`${r.affectedRows} row${r.affectedRows === 1 ? '' : 's'} affected`);
      if (r.warningStatus) state.messages.push(`${r.warningStatus} warning${r.warningStatus === 1 ? '' : 's'} (SHOW WARNINGS lists them)`);
    }
  }
}

// MySQL says nothing about open transactions without a query of its own, so the session follows the
// statements: BEGIN or START TRANSACTION opens one; COMMIT, ROLLBACK and DDL (which commits) end it.
export function transactionAfter(open, text) {
  const s = text.replace(/^(\s|--[^\n]*\n|#[^\n]*\n|\/\*[\s\S]*?\*\/)*/, '').toUpperCase();
  if (/^(BEGIN|START\s+TRANSACTION)\b/.test(s)) return 1;
  if (/^(COMMIT|ROLLBACK)\b(?!\s+TO\b)/.test(s) || /^(CREATE|ALTER|DROP|TRUNCATE|RENAME)\b/.test(s)) return 0;
  return open;
}

/** A session over a mysql2 connection ({ query, on, end, destroy }); the tests pass a stand-in. */
export function mysqlSession(conn, c, { database = null, cancel = async () => {} } = {}) {
  let open = 0;
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
            collectResult(await c.query({ sql: text, rowsAsArray: true }), state, limit);
            open = transactionAfter(open, text);
            const use = text.match(/^\s*USE\s+`?([^`\s;]+)`?/i);
            if (use) session.database = use[1];
          } catch (e) {
            if (e.errno === 1317 || signal?.aborted) throw new DbError('Cancelled', { cancelled: true });
            const at = String(e.message).match(/at line (\d+)/);
            throw new DbError(e.sqlMessage ?? e.message, { number: e.errno ?? null, line: at ? line + Number(at[1]) - 1 : line });
          } finally {
            signal?.removeEventListener('abort', onAbort);
          }
        },
        { ...opts, split: (s) => splitScript(s, dialect) },
      ),
    tranCount: async () => open,
    close() {
      if (!session.closed) c.end().catch(() => c.destroy());
    },
  };
  c.on?.('end', () => {
    session.closed = true;
    session.onEnd?.();
  });
  c.on?.('error', () => {});
  return session;
}
