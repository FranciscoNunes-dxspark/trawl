// Every operation the UI offers, written once. Keys and slash commands both call these.
// `ctx` is the app's handle: session, schema, query, confirm, note, prefill, and so on (see App.jsx).
import { writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { ADD_USAGE, isReadOnly, parseAddArgs } from './connections.js';
import { describeObject, findObject, objectName } from './schema.js';
import { classifyScript, oneLine, selectTop, toCsv, toJson } from './sql.js';

const YES_NO = (yes) => [
  { label: yes, value: true },
  { label: 'No', value: false },
];

function needSession(ctx) {
  if (ctx.session) return true;
  ctx.note('Connect first: press 5 for Connections, or /connect <name>.', 'error');
  return false;
}

/** Runs SQL on the current connection, after the read-only and danger checks. */
export async function runSql(ctx, sql, { title, lineBase } = {}) {
  if (!needSession(ctx)) return;
  const text = sql.trim();
  if (!text) return;
  const { write, danger } = classifyScript(text);
  const { conn } = ctx.session;
  if (write && isReadOnly(conn) && !ctx.writesAllowed) {
    return ctx.note(`${conn.name} is read-only${conn.prod ? ' (production)' : ''}, and this changes data. /writes allows writes until you disconnect.`, 'error');
  }
  if (danger.length) {
    const ok = await ctx.confirm({
      title: danger.length === 1 ? `${danger[0]}. Run it?` : `This script has ${danger.length} risky statements. Run it?`,
      detail: danger.length > 1 ? danger.join(' · ') : `On ${conn.name}${conn.prod ? ' (production)' : ''}.`,
      options: YES_NO('Yes, run it'),
      danger: true,
    });
    if (!ok) return;
  }
  // Writes on production start a transaction, so nothing sticks until /commit.
  const wrap = write && conn.prod && !ctx.tranCount;
  return ctx.query(wrap ? `BEGIN TRANSACTION;\n${text}` : text, { title: title ?? oneLine(text), wrapped: wrap, lineBase });
}

export async function connect(ctx, name, { database } = {}) {
  if (!name) return ctx.prefill('/connect ');
  const conn = ctx.config.connections.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (!conn) return ctx.note(`No connection called ${name}. /add creates one: ${ADD_USAGE}`, 'error');
  if (!(await leaveSession(ctx))) return;
  return ctx.connect(conn, { database });
}

/** Asks before leaving a session with an open transaction, which would roll it back. */
export async function leaveSession(ctx) {
  if (!ctx.session || !ctx.tranCount) return true;
  return ctx.confirm({
    title: `${ctx.session.conn.name} has an open transaction. Leave and roll it back?`,
    detail: 'Closing the connection rolls back everything not committed. /commit first to keep it.',
    options: YES_NO('Yes, roll it back'),
    danger: true,
  });
}

export async function disconnect(ctx) {
  if (!ctx.session) return ctx.note('Not connected.');
  if (!(await leaveSession(ctx))) return;
  ctx.disconnect();
}

export function addConnection(ctx, rest) {
  if (!rest) return ctx.prefill('/add ');
  let conn;
  try {
    conn = parseAddArgs(rest);
  } catch (e) {
    return ctx.note(e.message, 'error');
  }
  const replaced = ctx.config.connections.some((c) => c.name.toLowerCase() === conn.name.toLowerCase());
  ctx.setConfig((c) => ({ ...c, connections: [...c.connections.filter((x) => x.name.toLowerCase() !== conn.name.toLowerCase()), conn] }));
  ctx.note(`${replaced ? 'Updated' : 'Added'} ${conn.name}${conn.prod ? ' (production, read-only)' : ''}. ${conn.auth === 'azure-cli' ? 'Signs in with your az login.' : `Password from $${conn.passwordEnv}.`} /connect ${conn.name}`, 'ok');
}

export async function forgetConnection(ctx, name) {
  const conn = ctx.config.connections.find((c) => c.name.toLowerCase() === String(name).toLowerCase());
  if (!conn) return ctx.note(`No connection called ${name}.`, 'error');
  if (conn.demo) return ctx.note('The demo connections only last for this session.', 'error');
  const ok = await ctx.confirm({ title: `Forget the connection ${conn.name}?`, options: YES_NO('Yes, forget it') });
  if (!ok) return;
  ctx.setConfig((c) => ({ ...c, connections: c.connections.filter((x) => x !== conn) }));
  ctx.note(`Forgot ${conn.name}.`);
}

/** Switches database by reconnecting, which works on Azure SQL Database too (USE doesn't there). */
export async function use(ctx, database) {
  if (!needSession(ctx)) return;
  if (!database) return ctx.prefill('/use ');
  if (!(await leaveSession(ctx))) return;
  return ctx.connect(ctx.session.conn, { database });
}

export async function allowWrites(ctx) {
  if (!needSession(ctx)) return;
  const { conn } = ctx.session;
  if (!isReadOnly(conn)) return ctx.note(`${conn.name} already allows writes.`);
  if (ctx.writesAllowed) return ctx.note(`Writes are already allowed on ${conn.name} until you disconnect.`);
  const ok = await ctx.confirm({
    title: `Allow writes on ${conn.name}${conn.prod ? ' (production)' : ''}?`,
    detail: conn.prod ? 'Each write starts a transaction; /commit keeps it, /rollback undoes it. Lasts until you disconnect.' : 'Lasts until you disconnect.',
    options: YES_NO('Yes, allow writes'),
    danger: true,
  });
  if (ok) ctx.setWritesAllowed(true);
}

export async function commit(ctx) {
  if (!needSession(ctx)) return;
  if (!ctx.tranCount) return ctx.note('No transaction is open.', 'error');
  return ctx.query('COMMIT TRANSACTION;', { title: 'COMMIT TRANSACTION' });
}

export async function rollback(ctx) {
  if (!needSession(ctx)) return;
  if (!ctx.tranCount) return ctx.note('No transaction is open.', 'error');
  return ctx.query('ROLLBACK TRANSACTION;', { title: 'ROLLBACK TRANSACTION' });
}

/** The first rows of a table or view. */
export function browse(ctx, obj) {
  if (!needSession(ctx) || !obj) return;
  if (obj.kind !== 'table' && obj.kind !== 'view') return ctx.note(`${objectName(obj)} is a ${obj.kind}; only tables and views have rows to show.`, 'error');
  return runSql(ctx, selectTop(obj.schema, obj.name, ctx.config.limit));
}

export function describe(ctx, text) {
  if (!needSession(ctx)) return;
  if (!text) return ctx.prefill('/describe ');
  const obj = typeof text === 'string' ? findObject(ctx.schema, text) : text;
  if (!obj) return ctx.note(`No table or view called ${text} in ${ctx.session.database}.`, 'error');
  ctx.showText(objectName(obj), describeObject(obj));
}

export function setLimit(ctx, value) {
  if (!value) return ctx.note(`Result sets stop at ${ctx.config.limit} rows. /limit <n> changes it.`);
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 1_000_000) return ctx.note('The limit is a whole number from 1 to 1000000.', 'error');
  ctx.setConfig((c) => ({ ...c, limit: n }));
  ctx.note(`Result sets now stop at ${n} rows.`, 'ok');
}

/** Writes the result set on screen to a .csv or .json file. */
export async function exportResults(ctx, path) {
  const set = ctx.currentSet();
  if (!set) return ctx.note('Run a query first: there is nothing to export.', 'error');
  if (!path) return ctx.prefill('/export ');
  const full = resolve(path);
  const ext = extname(full).toLowerCase();
  if (ext !== '.csv' && ext !== '.json') return ctx.note('Export to a .csv or .json file.', 'error');
  try {
    await writeFile(full, ext === '.csv' ? toCsv(set) : toJson(set), 'utf8');
    ctx.note(`Wrote ${set.rows.length} row${set.rows.length === 1 ? '' : 's'} to ${full}${set.truncated ? ` (only the first ${set.rows.length}: raise /limit for more)` : ''}`, 'ok');
  } catch (e) {
    ctx.note(`Couldn't write ${full}: ${e.message}`, 'error');
  }
}
