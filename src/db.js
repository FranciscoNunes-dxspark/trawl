// The only place queries reach a database. A session is one connection, like an editor tab in
// SSMS: SET options, temp tables and open transactions carry over from one run to the next.
// SQL Server goes through tedious here; Postgres and MySQL through the adapters in db-postgres.js and
// db-mysql.js, and the demo driver (demo.js), all with the same session interface.
import { Connection, Request } from 'tedious';
import { azureSqlToken } from './azure.js';
import { tediousConfig } from './connections.js';
import { STORE_NAME, osCredentials } from './credentials.js';
import { demoSession } from './demo.js';
import { dialectOf } from './dialects.js';
import { splitBatches } from './sql.js';

export class DbError extends Error {
  constructor(message, { number = null, line = null, cancelled = false, partial = null, needsPassword = false, untrustedCert = false } = {}) {
    super(message);
    this.number = number;
    this.line = line;
    this.cancelled = cancelled;
    // No password to sign in with, or the saved one was turned down: the app asks for one.
    this.needsPassword = needsPassword;
    // The server's certificate couldn't be verified (self-signed, as a local SQL Server's is): the app
    // offers to trust it, as SSMS's "Trust server certificate" does.
    this.untrustedCert = untrustedCert;
    // What had already come back when it failed: { sets, messages }.
    this.partial = partial;
  }
}

// Node's TLS errors for a certificate no authority vouches for; Bun words the message without the hyphen.
const CERT_CODES = new Set(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY']);
const CERT_MESSAGE = /self[- ]signed certificate|unable to verify the first certificate|unable to get local issuer certificate/i;

/** Whether a failed connect was the server's certificate not being trusted. */
export function untrustedCert(err) {
  for (let e = err, n = 0; e && n < 5; e = e.cause, n++) if (CERT_CODES.has(e.code) || CERT_MESSAGE.test(e.message ?? '')) return true;
  return false;
}

function toDbError(err, lineOffset = 0) {
  const inner = err.errors?.length ? err.errors : [err];
  const message = inner.map((e) => e.message).filter(Boolean).join('\n') || String(err);
  const line = err.lineNumber ? err.lineNumber + lineOffset : null;
  return new DbError(message, { number: err.number ?? null, line });
}

/**
 * Opens a session on `conn` (in `database`, when given). Resolves with
 * { conn, database, run(text, { signal, limit }), tranCount(), close(), onEnd }.
 * A login's password is `password` when given, else its environment variable, else the one
 * saved in the OS credential store (`credentials`).
 */
export async function connect(conn, { database = conn.database, signal, password, credentials = osCredentials } = {}) {
  if (conn.demo) return demoSession(conn, { database });
  const dialect = dialectOf(conn);
  // Postgres and MySQL go through their own adapters (db-postgres.js, db-mysql.js), loaded when first used.
  if (dialect.kind !== 'sqlserver') {
    const found = await findPassword(conn, { password, credentials, signal });
    const adapter = dialect.kind === 'postgres' ? await import('./db-postgres.js') : await import('./db-mysql.js');
    try {
      return await adapter.open(conn, { database, password: found.password, signal });
    } catch (e) {
      // A wrong password from the environment is yours to fix there; a saved or typed one is asked again.
      if (e.badLogin && found.from !== 'env') e.needsPassword = true;
      throw e;
    }
  }
  const secrets = {};
  let from = 'given';
  if (conn.auth === 'azure-cli') secrets.token = await azureSqlToken({ signal });
  else {
    const found = await findPassword(conn, { password, credentials, signal });
    from = found.from;
    secrets.password = found.password;
  }
  const connection = new Connection(tediousConfig(conn, { ...secrets, database }));
  await new Promise((resolve, reject) => {
    const onAbort = () => connection.close();
    signal?.addEventListener('abort', onAbort, { once: true });
    connection.connect((err) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new DbError('Cancelled', { cancelled: true }));
      if (!err) return resolve();
      const e = toDbError(err);
      // A wrong password from the environment is yours to fix there; a saved or typed one is asked again.
      if (secrets.password != null && from !== 'env' && /login failed/i.test(e.message)) e.needsPassword = true;
      if (!conn.trustCert && untrustedCert(err)) e.untrustedCert = true;
      reject(e);
    });
  });
  return tediousSession(conn, connection, database);
}

/**
 * A login's password: the one given, else its environment variable, else the one saved in the OS
 * credential store. { password, from } with `from` 'given', 'env' or 'store'; a DbError with
 * needsPassword when there's none.
 */
async function findPassword(conn, { password, credentials, signal }) {
  if (password != null) return { password, from: 'given' };
  if (conn.passwordEnv && process.env[conn.passwordEnv] != null) return { password: process.env[conn.passwordEnv], from: 'env' };
  let storeError = '';
  const pw = await credentials.get(conn.name, { signal }).catch((e) => ((storeError = ` (${e.message})`), null));
  if (pw != null) return { password: pw, from: 'store' };
  const env = conn.passwordEnv ? `, or set $${conn.passwordEnv}` : '';
  throw new DbError(`No password saved for ${conn.user} on ${conn.name}${storeError}. Connect in Trawl once to enter it (it keeps it in ${STORE_NAME})${env}.`, { needsPassword: true });
}

function tediousSession(conn, connection, database) {
  let messages = null;
  const session = {
    conn,
    database: database ?? null,
    closed: false,
    onEnd: null,
    run: (script, opts) => runScript(session, script, (sql, line, state) => runBatch(connection, sql, line, state, opts), opts),
    async tranCount() {
      const state = { sets: [], messages: [] };
      await runBatch(connection, 'SELECT @@TRANCOUNT', 1, state, { limit: 1 });
      return Number(state.sets[0]?.rows[0]?.[0] ?? 0);
    },
    close() {
      if (!session.closed) connection.close();
    },
    // Info messages (PRINT, warnings) go to whichever run is collecting them.
    collect(list) {
      messages = list;
    },
  };
  connection.on('infoMessage', (info) => messages?.push(info.message));
  connection.on('databaseChange', (name) => (session.database = name));
  connection.on('end', () => {
    session.closed = true;
    session.onEnd?.();
  });
  // Socket errors also end the connection; 'end' reports it. Without a listener Node would throw.
  connection.on('error', () => {});
  return session;
}

/**
 * Runs a script batch by batch (split on GO, or by `split`: the other dialects' statements) through `runOne`, collecting result sets and
 * messages. Errors carry what had already arrived. Shared with the demo driver.
 */
export async function runScript(session, script, runOne, { signal, split = splitBatches } = {}) {
  const started = Date.now();
  const state = { sets: [], messages: [], stopped: false };
  session.collect?.(state.messages);
  try {
    for (const batch of split(script)) {
      for (let r = 0; r < batch.repeat; r++) {
        if (signal?.aborted) throw new DbError('Cancelled', { cancelled: true });
        await runOne(batch.text, batch.line, state);
        if (state.stopped) break;
      }
      if (state.stopped) break;
    }
  } catch (e) {
    const err = e instanceof DbError ? e : toDbError(e);
    err.partial = { sets: state.sets, messages: state.messages };
    throw err;
  } finally {
    session.collect?.(null);
  }
  return { sets: state.sets, messages: state.messages, stopped: state.stopped, ms: Date.now() - started };
}

function runBatch(connection, sql, line, state, { signal, limit = 500 } = {}) {
  return new Promise((resolve, reject) => {
    let current = null;
    const onAbort = () => connection.cancel();
    signal?.addEventListener('abort', onAbort, { once: true });
    const request = new Request(sql, (err) => {
      signal?.removeEventListener('abort', onAbort);
      if (!err) return resolve();
      // Trawl cancels on purpose once a result set reaches the row limit.
      if (err.code === 'ECANCEL' && state.stopped) return resolve();
      if (err.code === 'ECANCEL') return reject(new DbError('Cancelled', { cancelled: true }));
      reject(toDbError(err, line - 1));
    });
    request.on('columnMetadata', (cols) => {
      current = { columns: cols.map((c) => ({ name: c.colName, type: c.type?.name ?? '' })), rows: [], truncated: false };
      state.sets.push(current);
    });
    request.on('row', (cols) => {
      if (!current) return;
      if (current.rows.length < limit) current.rows.push(cols.map((c) => c.value));
      else if (!state.stopped) {
        state.stopped = true;
        current.truncated = true;
        connection.cancel();
      }
    });
    const done = (rowCount) => {
      if (current) current = null;
      else if (rowCount !== undefined) state.messages.push(`${rowCount} row${rowCount === 1 ? '' : 's'} affected`);
    };
    request.on('done', done);
    request.on('doneInProc', done);
    connection.execSqlBatch(request);
  });
}
