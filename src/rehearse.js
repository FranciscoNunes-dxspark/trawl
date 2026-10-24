// /rehearse: a migration run inside a transaction that is always rolled back, to see what it would do
// (each statement's time, rows and errors, and the locks it holds by the end) without keeping any of
// it. SQL Server and PostgreSQL can roll DDL back; MySQL commits it implicitly, so a script with DDL
// is refused there. Pure: actions.js runs the statements.
import { mask, splitBatches, splitStatements } from './sql.js';
import { splitScript } from './dialects.js';

/**
 * The script in the pieces it runs as: [{ text, line }]. SQL Server: its statements (the Query view's
 * units), or its GO batches when it declares variables, which live only as long as their batch;
 * Postgres and MySQL: the statements their drivers send one at a time.
 */
export function rehearsalSteps(text, dialect) {
  if (dialect.kind !== 'sqlserver') return splitScript(text, dialect).map(({ text, line }) => ({ text, line }));
  if (/\bDECLARE\s+@/i.test(mask(text))) return splitBatches(text).flatMap((b) => Array.from({ length: b.repeat }, () => ({ text: b.text, line: b.line })));
  return splitStatements(text).map(({ text, line }) => ({ text, line }));
}

// Statements that begin or end a transaction themselves: the rehearsal's own would go with them.
const TRANSACTION_CONTROL = /\b(BEGIN\s+(TRAN|TRANSACTION|DISTRIBUTED|WORK)|START\s+TRANSACTION|COMMIT|ROLLBACK|SAVE\s+TRAN(SACTION)?|IMPLICIT_TRANSACTIONS|AUTOCOMMIT)\b/i;
// A routine or trigger being made: what its body does runs later, not now.
const MODULE = /^(CREATE|ALTER)\s+(OR\s+(ALTER|REPLACE)\s+)?(DEFINER\s*=\s*\S+\s+)?(PROC|PROCEDURE|FUNCTION|TRIGGER|EVENT)\b/i;

// What MySQL commits by itself, ending any transaction (its "statements that cause an implicit commit").
const MYSQL_IMPLICIT = /^(CREATE|ALTER|DROP|RENAME|TRUNCATE|GRANT|REVOKE|LOCK\s+TABLES|UNLOCK\s+TABLES|ANALYZE\s+TABLE|OPTIMIZE\s+TABLE|REPAIR\s+TABLE|CHECK\s+TABLE|FLUSH|INSTALL|UNINSTALL|LOAD\s+DATA|CACHE\s+INDEX|LOAD\s+INDEX|SET\s+PASSWORD|RESET|CHANGE\s+(MASTER|REPLICATION))\b/i;

// SQL Server's that can't run inside a transaction at all.
const SQLSERVER_NO_TRAN = /^(CREATE|ALTER|DROP)\s+DATABASE\b|^(BACKUP|RESTORE|RECONFIGURE)\b|^ALTER\s+FULLTEXT\s+(CATALOG|INDEX)\b|^CREATE\s+FULLTEXT\s+(CATALOG|INDEX)\b/i;
// Postgres's.
const POSTGRES_NO_TRAN = /^(CREATE|DROP)\s+DATABASE\b|^(CREATE|DROP)\s+TABLESPACE\b|^VACUUM\b|^(CREATE|DROP)\s+INDEX\s+CONCURRENTLY\b|^REINDEX\b.*\bCONCURRENTLY\b|^ALTER\s+SYSTEM\b|^ALTER\s+TYPE\b.*\bADD\s+VALUE\b/is;

const firstCode = (text) => mask(text).replace(/\u0001/g, ' ').trim();

/**
 * Why the script can't be rehearsed on `dialect`, or null: a statement that begins or ends a
 * transaction itself, one the server won't run inside one, or on MySQL one it commits implicitly.
 * `steps` are rehearsalSteps.
 */
export function rehearsalRefusal(steps, dialect) {
  for (const s of steps) {
    const code = firstCode(s.text);
    const head = code.split('\n')[0].trim();
    const words = head.split(/\s+/).slice(0, 3).join(' ');
    if (!MODULE.test(code)) {
      const control = TRANSACTION_CONTROL.exec(code) ?? (dialect.kind !== 'sqlserver' && /^(BEGIN|END)\s*$/i.test(code) ? [code] : null);
      if (control) return `Line ${s.line} begins or ends a transaction itself (${control[0].toUpperCase()}), and the rehearsal runs everything inside one of its own that it rolls back. Take it out to rehearse the rest.`;
    }
    if (dialect.kind === 'mysql' && MYSQL_IMPLICIT.test(code)) {
      return `Line ${s.line} (${words}) can't be rehearsed on MySQL: MySQL commits a statement like it straight away (an implicit commit), which ends the transaction, so it couldn't be rolled back. Only a MySQL script's data changes (INSERT, UPDATE, DELETE) can be rehearsed; SQL Server and PostgreSQL roll DDL back too.`;
    }
    if (dialect.kind === 'sqlserver' && SQLSERVER_NO_TRAN.test(code)) return `Line ${s.line} (${words}) can't run inside a transaction, so it can't be rehearsed.`;
    if (dialect.kind === 'postgres' && POSTGRES_NO_TRAN.test(code)) return `Line ${s.line} (${words}) can't run inside a transaction on PostgreSQL, so it can't be rehearsed.`;
  }
  return null;
}

/** The rows a step changed, from its "n rows affected" messages, or null when it said none. */
export function rowsAffected(messages) {
  let n = null;
  for (const m of messages ?? []) {
    const x = /^(\d+) rows? affected/.exec(m);
    if (x) n = (n ?? 0) + Number(x[1]);
  }
  return n;
}

const ms = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`);
const label = (text) => {
  const line = text.split('\n').find((l) => l.trim() && !/^\s*--/.test(l)) ?? text.split('\n')[0];
  return line.trim().replace(/\s+/g, ' ');
};

/**
 * The report: a line per step (its line in the script, time, rows, and what it began with), the
 * error that stopped it and the steps after it that didn't run, the locks held at the end, and that
 * it was all rolled back. `results`: [{ step, ms, rows, sets, error }]; `locks`: transactions.js locksText lines.
 */
export function rehearsalText({ steps, results, locks = [], conn, database, label: kindLabel, totalMs }) {
  const out = [`Rehearsed on ${conn}${database ? `/${database}` : ''} (${kindLabel}), inside a transaction that was rolled back: nothing was kept.`, ''];
  const w = String(Math.max(...steps.map((s) => s.line), 1)).length;
  for (const r of results) {
    const what = r.error ? 'failed' : `${ms(r.ms).padStart(7)}${r.rows != null ? ` · ${r.rows} row${r.rows === 1 ? '' : 's'}` : ''}${r.sets ? ` · ${r.sets} result set${r.sets === 1 ? '' : 's'}` : ''}`;
    out.push(`${r.error ? '✗' : '✓'} line ${String(r.step.line).padStart(w)}  ${what}  ${label(r.step.text).slice(0, 80)}`);
    if (r.error) out.push(...r.error.split('\n').map((l) => `      ${l}`));
  }
  const notRun = steps.length - results.length;
  if (notRun > 0) out.push(`  ${notRun} more statement${notRun === 1 ? '' : 's'} after it didn't run.`);
  const ok = results.filter((r) => !r.error).length;
  out.push('', `${ok} of ${steps.length} statement${steps.length === 1 ? '' : 's'} ran in ${ms(totalMs)}${results.some((r) => r.error) ? ', then one failed' : ''}.`);
  out.push('', 'Locks held at the end (what a real run would keep until it commits):', ...locks.map((l) => `  ${l}`));
  return out.join('\n');
}
