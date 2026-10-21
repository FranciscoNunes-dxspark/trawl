// Every operation the UI offers, written once. Keys and slash commands both call these.
// `ctx` is the app's handle: session, schema, query, confirm, note, prefill, and so on (see App.jsx).
import { readFileSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { ADD_USAGE, cleanFolder, commitMode, describeConn, isReadOnly, parseAddArgs, splitArgs } from './connections.js';
import { csvInsertScript, parseCsv } from './csv.js';
import * as ed from './editor.js';
import { findDataSources, importPlan, planText } from './datagrip.js';
import { formatSql } from './format.js';
import { changesText, insertScript, saveScript, tsvText, withSaved } from './edit.js';
import { AI_LABELS, AI_LEVELS, EXPLAIN_SYSTEM, aiLevel, askPrompt, canSeeSchema, consoleText, explainPrompt, parseAnswer } from './ai.js';
import { followTargets } from './follow.js';
import { compareSets, comparisonSet, comparisonSummary } from './compare.js';
import { droppedPaths, findTab, freeName, tabNameFor, tabNameProblem } from './consoles.js';
import { findSnippet, snippetNameProblem, snippetsFor, withSnippet, withoutSnippet } from './snippets.js';
import { folderNames, inFolder, inParallel, mergeResults, readOnlyScript } from './fanout.js';
import { DIFF_SQL, buildExtras, diffText, schemaDiff, syncScript } from './diff.js';
import { agentProbe, buildActivity, buildJobHistory, buildJobs, buildTopQueries, jobHistorySql, jobHistoryText, killSql, sortColumn, sortQueries, startJobSql, topProbe } from './activity.js';
import { dialectOf, definitionSqlFor, qualifiedFor, selectTopFor } from './dialects.js';
import { buildSchema, createTableScript, definitionSql, describeObject, findObject, objectName } from './schema.js';
import { applySqlcmd, bindVariables, classifyScript, countQuery, oneLine, scriptVariables, splitStatements, sqlcmdVariables, statementAt, toCsv, toJson, withoutLeadingComments } from './sql.js';

// A WHERE that still changes more rows than this is asked about too.
const MANY_ROWS = 1000;

const YES_NO = (yes) => [
  { label: yes, value: true },
  { label: 'No', value: false },
];

function needSession(ctx) {
  if (ctx.session) return true;
  ctx.note('Connect first: press 5 for Connections, or /connect <name>.', 'error');
  return false;
}

/**
 * How many rows an UPDATE or DELETE would change, counted first with a SELECT built from it (so
 * nothing is written to find out). Null when it can't be counted; 'cancelled' after esc.
 */
async function countChanges(ctx, text) {
  const d = dialectOf(ctx.session);
  const q = countQuery(text)?.replace(/^SELECT COUNT_BIG\(\*\)/, `SELECT ${d.count}`);
  if (!q || classifyScript(q, { dialect: d.kind }).write) return null;
  let n = null;
  const r = await ctx.task(
    'count the rows it would change',
    async (signal) => {
      try {
        const res = await ctx.session.run(q, { signal, limit: 1 });
        n = Number(res.sets.at(-1)?.rows[0]?.[0]);
      } catch (e) {
        // A count that fails says nothing about the write; the write's own error will.
        if (e.cancelled) throw e;
      }
      return [];
    },
    { label: 'Counting the rows it would change', quiet: true },
  );
  if (!r.ok) return r.error?.cancelled ? 'cancelled' : null;
  return Number.isFinite(n) ? n : null;
}

const rowsText = (n) => `${n.toLocaleString('en')} row${n === 1 ? '' : 's'}`;

/**
 * The script with its parameters filled in, asking for each: sqlcmd's $(name) without a :setvar, then
 * @variables used without being declared (sql.js scriptVariables). Null when one is cancelled with esc.
 * The values typed are offered again next time, for this session.
 */
async function withParameters(ctx, sql) {
  ctx.parameterValues ??= new Map();
  const remembered = ctx.parameterValues;
  const ask = async (name, i, n) => {
    const r = await ctx.askText({
      title: `Value for ${name}${n > 1 ? ` (${i + 1} of ${n})` : ''}`,
      detail: name.startsWith('$') ? 'Put into the script as it is, as sqlcmd does. esc cancels the run.' : 'A number, NULL, or text (quoted for you; type the quotes to give a literal yourself). esc cancels the run.',
      value: remembered.get(name.toLowerCase()) ?? '',
    });
    if (r == null) return null;
    remembered.set(name.toLowerCase(), r);
    return r;
  };
  let text = sql;
  const { defined, needed } = sqlcmdVariables(text);
  if (defined.size || needed.length) {
    const values = new Map();
    for (const [i, name] of needed.entries()) {
      const v = await ask(`$(${name})`, i, needed.length);
      if (v == null) return null;
      values.set(name, v);
    }
    text = applySqlcmd(text, values);
  }
  const vars = scriptVariables(text);
  if (!vars.length) return text;
  const values = new Map();
  for (const [i, { name }] of vars.entries()) {
    const v = await ask(name, i, vars.length);
    if (v == null) return null;
    values.set(name, v);
  }
  return bindVariables(text, values);
}

/** Runs SQL on the current connection, after the read-only and danger checks. */
export async function runSql(ctx, sql, { title, prefix = '', lineBase, stay, keep } = {}) {
  if (!needSession(ctx)) return;
  if (!sql.trim()) return;
  const text = await withParameters(ctx, sql.trim());
  if (text == null) return;
  const dialect = dialectOf(ctx.session);
  const { write, danger } = classifyScript(text, { dialect: dialect.kind });
  const { conn } = ctx.session;
  if (write && isReadOnly(conn) && !ctx.writesAllowed) {
    return ctx.note(`${conn.name} is read-only${conn.prod ? ' (production)' : ''}, and this changes data. /writes allows writes until you disconnect.`, 'error');
  }
  const changes = write ? await countChanges(ctx, text) : null;
  if (changes === 'cancelled') return;
  const on = `On ${conn.name}${conn.prod ? ' (production)' : ''}`;
  if (danger.length) {
    const ok = await ctx.confirm({
      title: danger.length === 1 ? `${danger[0]}. Run it?` : `This script has ${danger.length} risky statements. Run it?`,
      detail: danger.length > 1 ? danger.join(' · ') : `${on}${changes != null ? `: that's ${rowsText(changes)}` : ''}.`,
      options: YES_NO('Yes, run it'),
      danger: true,
    });
    if (!ok) return;
  } else if (changes != null && changes > MANY_ROWS) {
    const ok = await ctx.confirm({
      title: `This changes ${rowsText(changes)}. Run it?`,
      detail: `${on}. Counted with a SELECT over the same FROM and WHERE.`,
      options: YES_NO('Yes, run it'),
      danger: true,
    });
    if (!ok) return;
  }
  // With manual commit (production's default), a write starts a transaction, so nothing sticks until /commit.
  const wrap = write && commitMode(conn) === 'manual' && !ctx.tranCount;
  return ctx.query(wrap ? `${dialect.begin}\n${text}` : text, { title: title ?? `${prefix}${oneLine(withoutLeadingComments(text))}`, wrapped: wrap, lineBase, stay, keep });
}

/**
 * Saves the edits staged in Results: shows the script, asks, then runs it through runSql (so a
 * read-only connection refuses it and production keeps it in a transaction until /commit).
 */
export async function saveEdits(ctx) {
  const res = ctx.results;
  const { changes } = ctx;
  if (!changes.cells.size && !changes.deletes.size) return ctx.note('Nothing to save: e edits a cell, n makes it NULL, d marks a row to delete.');
  const { session } = ctx;
  if (!session || session.conn.name !== res.conn || session.database !== res.database) return ctx.note(`These rows came from ${res.conn} (${res.database}); connect there again to save them.`, 'error');
  const { table } = res.edit;
  let script;
  try {
    script = saveScript(res.edit, res.sets[0], changes);
  } catch (e) {
    return ctx.note(e.message, 'error');
  }
  const what = changesText(changes);
  ctx.showText(`Save to ${objectName(table)}`, script);
  const ok = await ctx.confirm({
    title: `Save ${what} to ${objectName(table)} on ${session.conn.name}${session.conn.prod ? ' (production)' : ''}?`,
    detail: 'The script is above (pgup/pgdn scroll it). Each change must find exactly its row, unchanged since it was read, or nothing is saved.',
    scrollsOverlay: true,
    options: YES_NO('Yes, save'),
    danger: changes.deletes.size > 0 || Boolean(session.conn.prod),
  });
  ctx.closeOverlay();
  if (!ok) return;
  const r = await runSql(ctx, script, { title: `save ${what} to ${objectName(table)}`, keep: true });
  // On a failure, nothing was saved: the changes stay staged to fix or undo.
  if (r?.ok && ctx.results === res) ctx.replaceResults({ ...res, sets: [withSaved(res.sets[0], changes, res.edit)] });
}

/**
 * F in Results and /follow: from the cell under the cursor along a foreign key, to the row its value
 * refers to, or to the rows of other tables that refer to it. With several ways to go, it asks which.
 */
export async function followKey(ctx, cell = ctx.resultCell) {
  const res = ctx.results;
  if (!res || !cell) return ctx.note('Run a query first, and put the cursor on a cell in Results.', 'error');
  if (!needSession(ctx)) return;
  if (res.conn !== ctx.session.conn.name || res.database !== ctx.session.database) return ctx.note(`These rows came from ${res.conn} (${res.database}); connect there again to follow their keys.`, 'error');
  const d = dialectOf(ctx.session);
  const r = followTargets(res.source, res.sets[0], cell.row, cell.col, ctx.schema, { limit: ctx.config.limit, quote: d.quote, selectTop: d.selectTop });
  if (r.reason) return ctx.note(r.reason, 'error');
  let pick = r.targets[0];
  if (r.targets.length > 1) {
    pick = await ctx.confirm({ title: 'Follow which foreign key?', options: [...r.targets.map((t) => ({ label: `${t.label} (${t.fk})`, value: t })), { label: 'Neither', value: null }] });
    if (!pick) return;
  }
  return runSql(ctx, pick.sql);
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
  const signIn = conn.auth === 'azure-cli' ? 'Signs in with your az login.' : conn.passwordEnv ? `Password from $${conn.passwordEnv}.` : `Asks for the password when you connect, and keeps it in ${ctx.credentials.name}.`;
  ctx.note(`${replaced ? 'Updated' : 'Added'} ${conn.name}${conn.folder ? ` in ${conn.folder}/` : ''}${conn.prod ? ' (production, read-only)' : ''}. ${signIn} /connect ${conn.name}`, 'ok');
}

export async function forgetConnection(ctx, name) {
  const conn = ctx.config.connections.find((c) => c.name.toLowerCase() === String(name).toLowerCase());
  if (!conn) return ctx.note(`No connection called ${name}.`, 'error');
  if (conn.demo) return ctx.note('The demo connections only last for this session.', 'error');
  const ok = await ctx.confirm({ title: `Forget the connection ${conn.name}?`, options: YES_NO('Yes, forget it') });
  if (!ok) return;
  ctx.setConfig((c) => ({ ...c, connections: c.connections.filter((x) => x !== conn) }));
  if (conn.auth !== 'azure-cli') await ctx.credentials.remove(conn.name);
  ctx.note(`Forgot ${conn.name}${conn.auth !== 'azure-cli' ? ', and any password Trawl saved for it' : ''}.`);
}

/** /folder <connection> [folder]: files a connection in a folder; with no folder, takes it out. */
export function moveToFolder(ctx, rest) {
  const [, name, to] = String(rest ?? '').trim().match(/^(\S*)\s*([\s\S]*)$/);
  if (!name) return ctx.prefill('/folder ');
  const conn = ctx.config.connections.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (!conn) return ctx.note(`No connection called ${name}.`, 'error');
  if (conn.demo) return ctx.note('The demo connections only last for this session.', 'error');
  const folder = cleanFolder(to);
  ctx.setConfig((c) => ({ ...c, connections: c.connections.map((x) => (x === conn ? withFolder(x, folder) : x)) }));
  ctx.note(folder ? `Moved ${conn.name} into ${folder}/.` : `Took ${conn.name} out of ${conn.folder ? `${conn.folder}/` : 'its folder'}.`, 'ok');
}

const withFolder = (conn, folder) => {
  const { folder: _, ...rest } = conn;
  return folder ? { ...rest, folder } : rest;
};

/**
 * Asks for a login's password: { password, remember } or null on esc. `failed` says the last
 * one was turned down; `saving` is /password, which only stores it.
 */
export async function askPassword(ctx, conn, { failed = false, saving = false } = {}) {
  const r = await ctx.askSecret({
    title: `${failed ? 'Login failed. ' : ''}Password for ${conn.domain ? `${conn.domain}\\` : ''}${conn.user} on ${conn.name}`,
    detail: saving ? `Kept in ${ctx.credentials.name}, never in Trawl's config. Empty removes the saved one.` : describeConn(conn),
    remember: saving ? undefined : true,
    rememberLabel: `Keep it in ${ctx.credentials.name}`,
    danger: failed,
  });
  return r ? { password: r.value, remember: r.remember } : null;
}

/** /password [connection]: saves (or with nothing typed, removes) a login's password in the OS store. */
export async function setPassword(ctx, name) {
  const conn = name ? ctx.config.connections.find((c) => c.name.toLowerCase() === name.toLowerCase()) : ctx.session?.conn;
  if (!conn) return ctx.note(name ? `No connection called ${name}.` : 'Name the connection: /password <connection>', 'error');
  if (conn.demo || conn.auth === 'azure-cli') return ctx.note(`${conn.name} signs in with ${conn.demo ? 'nothing (it is the demo)' : 'your az login'}, so it has no password.`, 'error');
  const answer = await askPassword(ctx, conn, { saving: true });
  if (!answer) return;
  const { credentials } = ctx;
  if (!answer.password) {
    return ctx.task(`forget the password for ${conn.name}`, async () => (await credentials.remove(conn.name), [`Removed from ${credentials.name}.`]), { label: 'Removing the password' });
  }
  const env = conn.passwordEnv && process.env[conn.passwordEnv] != null ? [`$${conn.passwordEnv} is set, and it comes first: clear it for this one to count.`] : [];
  return ctx.task(
    `save the password for ${conn.name}`,
    async () => {
      await credentials.set(conn.name, { user: conn.user, password: answer.password });
      return [`In ${credentials.name}; Trawl and trawl mcp use it from the next connect.`, ...env];
    },
    { label: 'Saving the password' },
  );
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

/**
 * /tx [auto|manual]: DataGrip's transaction modes, for the connection you're on (and kept for it).
 * With no mode, says which it is.
 */
export async function setCommitMode(ctx, mode) {
  if (!needSession(ctx)) return;
  const { conn } = ctx.session;
  const now = commitMode(conn);
  if (!mode) return ctx.note(`${conn.name} commits ${now === 'auto' ? 'each statement as it runs (auto)' : 'only on /commit (manual): a write opens a transaction'}. /tx ${now === 'auto' ? 'manual' : 'auto'} changes it.`);
  if (!['auto', 'manual'].includes(mode)) return ctx.note('/tx auto commits each statement as it runs; /tx manual waits for /commit.', 'error');
  if (mode === now) return ctx.note(`${conn.name} already commits ${mode === 'auto' ? 'automatically' : 'manually'}.`);
  if (mode === 'auto' && ctx.tranCount) return ctx.note('A transaction is open: /commit or /rollback it first.', 'error');
  if (mode === 'auto' && conn.prod) {
    const ok = await ctx.confirm({
      title: `Commit each write on ${conn.name} (production) as it runs?`,
      detail: 'Writes then take effect at once, with no /rollback.',
      options: YES_NO('Yes, auto-commit'),
      danger: true,
    });
    if (!ok) return;
  }
  // The session holds the connection it opened with, so that changes too (the demo's only lives there).
  conn.commit = mode;
  ctx.setConfig((c) => ({ ...c, connections: c.connections.map((x) => (x.name === conn.name && !x.demo ? { ...x, commit: mode } : x)) }));
  ctx.note(mode === 'auto' ? `${conn.name} now commits each statement as it runs.` : `${conn.name} now commits manually: a write opens a transaction, and /commit keeps it or /rollback undoes it.`, 'ok');
}

export async function commit(ctx) {
  if (!needSession(ctx)) return;
  if (!ctx.tranCount) return ctx.note('No transaction is open.', 'error');
  const { commit: sql } = dialectOf(ctx.session);
  return ctx.query(sql, { title: sql.replace(/;$/, '') });
}

export async function rollback(ctx) {
  if (!needSession(ctx)) return;
  if (!ctx.tranCount) return ctx.note('No transaction is open.', 'error');
  const { rollback: sql } = dialectOf(ctx.session);
  return ctx.query(sql, { title: sql.replace(/;$/, '') });
}

/** The first rows of a table or view. */
export function browse(ctx, obj) {
  if (!needSession(ctx) || !obj) return;
  if (obj.kind !== 'table' && obj.kind !== 'view') return ctx.note(`${objectName(obj)} is a ${obj.kind}; only tables and views have rows to show.`, 'error');
  return runSql(ctx, selectTopFor(dialectOf(ctx.session), obj.schema, obj.name, ctx.config.limit));
}

export function describe(ctx, text) {
  if (!needSession(ctx)) return;
  if (!text) return ctx.prefill('/describe ');
  const obj = typeof text === 'string' ? findObject(ctx.schema, text) : text;
  if (!obj) return ctx.note(`No table or view called ${text} in ${ctx.session.database}.`, 'error');
  ctx.showText(objectName(obj), describeObject(obj, ctx.schema));
}

/**
 * /script <name> and c in the Explorer: the object's CREATE script, into the console to edit. A table's
 * is written from the catalog; a view's, procedure's or function's is the server's own text.
 */
export async function scriptObject(ctx, text) {
  if (!needSession(ctx)) return;
  if (!text) return ctx.prefill('/script ');
  const obj = typeof text === 'string' ? findObject(ctx.schema, text) : text;
  if (!obj) return ctx.note(`Nothing called ${text} in ${ctx.session.database}.`, 'error');
  const dialect = dialectOf(ctx.session);
  if (obj.kind === 'table') return ctx.editInConsole(createTableScript(obj, ctx.schema, { quote: dialect.quote, identity: dialect.identity }));
  let definition = null;
  const r = await ctx.task(
    `script ${objectName(obj)}`,
    async (signal) => {
      const set = (await ctx.session.run(dialect.kind === 'sqlserver' ? definitionSql(obj) : definitionSqlFor(dialect, obj), { signal, limit: 1 })).sets[0];
      // MySQL's SHOW CREATE answers with the name first and the text in a "Create …" column.
      const at = Math.max(0, set?.columns.findIndex((c) => /^create /i.test(c.name)) ?? 0);
      definition = set?.rows[0]?.[at] ?? null;
      return [definition ? 'In the console.' : "The server gave no definition: it may be encrypted, or the login can't VIEW DEFINITION."];
    },
    { label: 'Reading the definition' },
  );
  if (r.ok && definition) ctx.editInConsole(String(definition).replace(/\r\n?/g, '\n').trim());
}

/**
 * /stats [on|off]: SET STATISTICS IO and TIME for the session, so each run says how many pages it
 * read from which table and how long the server spent (as one line). With nothing, it toggles.
 */
export async function setStats(ctx, mode) {
  if (!needSession(ctx)) return;
  if (mode && mode !== 'on' && mode !== 'off') return ctx.note('/stats on shows the pages read and the server time after each run; /stats off stops it.', 'error');
  if (dialectOf(ctx.session).kind !== 'sqlserver') return ctx.note('/stats is SQL Server’s STATISTICS IO and TIME; there’s no such thing here.', 'error');
  const session = ctx.session;
  const on = mode ? mode === 'on' : !session.stats;
  const r = await ctx.task(
    `statistics ${on ? 'on' : 'off'}`,
    async (signal) => {
      const v = on ? 'ON' : 'OFF';
      await session.run(`SET STATISTICS IO ${v};\nSET STATISTICS TIME ${v};`, { signal });
      return [on ? 'Each run now ends with the logical reads per table and the CPU and elapsed time.' : 'Runs no longer report reads and times.'];
    },
    { label: on ? 'Turning statistics on' : 'Turning statistics off' },
  );
  if (r.ok) session.stats = on;
}

/**
 * /plan [sql] and p in the console: the estimated plan, as text (SHOWPLAN_TEXT), of the SQL given,
 * the selection, or the statement under the cursor. Nothing runs. SHOWPLAN goes off again whatever
 * happens, or the session would answer every query with a plan.
 */
export async function showPlan(ctx, sql) {
  if (!needSession(ctx)) return;
  const e = ctx.console;
  const text = sql?.trim() || ed.selectedText(e)?.text.trim() || statementAt(splitStatements(ed.toText(e)), e.row + 1)?.text;
  if (!text) return ctx.note('Nothing to plan: give the SQL (/plan SELECT …) or put the cursor on a statement in the console.', 'error');
  const session = ctx.session;
  let plan = null;
  const title = `Plan: ${oneLine(withoutLeadingComments(text))}`;
  const dialect = dialectOf(session);
  await ctx.task(
    title,
    async (signal) => {
      if (dialect.explain) {
        // EXPLAIN only plans (not EXPLAIN ANALYZE), so nothing runs here either.
        const res = await session.run(dialect.explain(text), { signal, limit: 10_000 });
        plan = res.sets.map((s) => [s.columns.map((c) => c.name).join(' | '), ...s.rows.map((r) => r.map((v) => String(v ?? '')).join(' | '))].join('\n')).join('\n\n');
        return ['The plan is on screen (esc closes it). Nothing ran.'];
      }
      await session.run('SET SHOWPLAN_TEXT ON;', { signal });
      try {
        const res = await session.run(text, { limit: 10_000 });
        // Each statement gives two sets: its text, then its plan's rows.
        plan = res.sets.map((s) => s.rows.map((r) => String(r[0] ?? '').replace(/\s+$/, '')).join('\n')).join('\n\n');
      } finally {
        await session.run('SET SHOWPLAN_TEXT OFF;');
      }
      return ['The plan is on screen (esc closes it). Nothing ran.'];
    },
    { label: 'Asking for the plan' },
  );
  if (plan) {
    ctx.lastPlan = { sql: text, plan, conn: session.conn.name, database: session.database, label: dialect.label, how: dialect.explain ? 'EXPLAIN' : 'SHOWPLAN_TEXT' };
    ctx.showText(title, plan, { keys: { a: () => explainPlan(ctx) }, hint: 'a Claude explains it' });
    ctx.rememberOutput(title, plan);
  }
}

/**
 * a on a plan, and /explain: Claude reads the last plan with its query (never rows) and says what it
 * does, what costs the most and what might help. Refused on a connection closed to Claude.
 */
export async function explainPlan(ctx) {
  const p = ctx.lastPlan;
  if (!p) return ctx.note('Show a plan first: p in the console, or /plan <sql>.', 'error');
  const conn = ctx.config.connections.find((c) => c.name === p.conn) ?? ctx.session?.conn;
  if (!canSeeSchema(conn)) return ctx.note(`${p.conn} is closed to Claude. /ai schema lets Claude see its queries and plans (never rows).`, 'error');
  let answer = null;
  const title = `Claude on the plan: ${oneLine(withoutLeadingComments(p.sql))}`;
  const r = await ctx.task(
    `ask Claude about the plan of ${oneLine(withoutLeadingComments(p.sql))}`,
    async (signal) => {
      answer = String(await ctx.askClaude({ prompt: explainPrompt(p), system: EXPLAIN_SYSTEM, signal })).trim();
      return [answer ? 'The explanation is on screen (esc closes it; /last shows it again).' : 'Claude gave no answer.'];
    },
    { label: 'Asking Claude about the plan' },
  );
  if (r.ok && answer) {
    ctx.showText(title, answer);
    ctx.rememberOutput(title, answer);
  }
}

/**
 * The Activity view's list: the server's sessions and requests, read again. `quiet` keeps it out of
 * the activity log (opening the tab, R); errors (no VIEW SERVER STATE, say) still show.
 */
export async function loadActivity(ctx, { quiet = true } = {}) {
  if (!needSession(ctx)) return;
  const session = ctx.session;
  let act = null;
  const r = await ctx.task(
    "read the server's sessions",
    async (signal) => {
      act = buildActivity((await session.run(dialectOf(session).activitySql, { signal, limit: 10_000 })).sets);
      return [`${act.sessions.length} session${act.sessions.length === 1 ? '' : 's'}`];
    },
    { label: "Reading the server's sessions", quiet },
  );
  if (act) return ctx.setActivity({ ...act, at: Date.now(), conn: session.conn.name, error: null });
  if (!r.ok && r.error?.message !== 'busy' && !r.error?.cancelled) ctx.setActivity({ me: null, sessions: [], at: Date.now(), conn: session.conn.name, error: r.error.message });
}

/**
 * x in Activity and /kill <session>: ends another session with KILL, after asking. A read-only
 * connection refuses it (until /writes), and so does an open transaction, inside which KILL can't run.
 */
export async function killSession(ctx, id) {
  if (!needSession(ctx)) return;
  if (!String(id ?? '').trim()) return ctx.prefill('/kill ');
  let sql;
  try {
    sql = killSql(String(id).trim());
  } catch (e) {
    return ctx.note(e.message, 'error');
  }
  const n = Number(String(id).trim());
  const { conn } = ctx.session;
  if (isReadOnly(conn) && !ctx.writesAllowed) return ctx.note(`${conn.name} is read-only${conn.prod ? ' (production)' : ''}, and KILL ends someone's session. /writes allows it until you disconnect.`, 'error');
  const dialect = dialectOf(ctx.session);
  if (ctx.tranCount && dialect.kind === 'sqlserver') return ctx.note('A transaction is open, and KILL can’t run inside one: /commit or /rollback first.', 'error');
  const act = ctx.activity;
  if (act?.me === n) return ctx.note(`Session ${n} is Trawl's own; /disconnect ends it.`, 'error');
  const s = act?.sessions.find((x) => x.id === n);
  const who = s ? ` (${[s.login, s.host, s.program].filter(Boolean).join(' · ')})` : '';
  const ok = await ctx.confirm({
    title: `Kill session ${n}${who}?`,
    detail: `On ${conn.name}${conn.prod ? ' (production)' : ''}. What it hasn't committed is rolled back, which can take as long as it ran.`,
    options: YES_NO('Yes, kill it'),
    danger: true,
  });
  if (!ok) return;
  const r = await ctx.query(dialect.kind === 'sqlserver' ? sql : dialect.kill(n), { title: `KILL ${n}`, keep: true });
  if (r?.ok) await loadActivity(ctx);
}

/**
 * J, Q (and the same key or esc back) in Activity, /jobs, /top-queries and /activity: which list the
 * tab shows. A list already read for this connection is read again; one that isn't, the view reads.
 */
export function showActivityList(ctx, which) {
  ctx.setView('activity');
  ctx.setActivityLists({ show: which });
  const { session } = ctx;
  if (!session) return;
  const read = which === 'jobs' ? ctx.activityLists.jobs : which === 'queries' ? ctx.activityLists.queries : ctx.activity;
  if (read?.conn !== session.conn.name) return;
  if (which === 'jobs') return loadJobs(ctx);
  if (which === 'queries') return loadTopQueries(ctx);
  return loadActivity(ctx);
}

/**
 * The SQL Agent jobs, for Activity's jobs list: first whether the server has the Agent (Azure SQL
 * Database, Express and Postgres or MySQL don't), then msdb's jobs. Errors (msdb's roles) still show.
 */
export async function loadJobs(ctx, { quiet = true } = {}) {
  if (!needSession(ctx)) return;
  const session = ctx.session;
  const d = dialectOf(session);
  const base = { jobs: [], at: Date.now(), conn: session.conn.name, error: null, unavailable: null };
  if (!d.jobs.sql) return ctx.setActivityLists({ jobs: { ...base, unavailable: d.jobs.unavailable } });
  let read = null;
  const r = await ctx.task(
    'read the SQL Agent jobs',
    async (signal) => {
      const { unavailable } = agentProbe((await session.run(d.jobs.probe, { signal, limit: 10 })).sets);
      if (unavailable) return (read = { unavailable }), [unavailable];
      read = { jobs: buildJobs((await session.run(d.jobs.sql, { signal, limit: 10_000 })).sets) };
      return [`${read.jobs.length} job${read.jobs.length === 1 ? '' : 's'}`];
    },
    { label: 'Reading the SQL Agent jobs', quiet },
  );
  if (read) return ctx.setActivityLists({ jobs: { ...base, ...read, at: Date.now() } });
  if (!r.ok && r.error?.message !== 'busy' && !r.error?.cancelled) ctx.setActivityLists({ jobs: { ...base, error: r.error.message } });
}

/** ↵ on a job: its recent runs in the viewer, with what its failed steps said. */
export async function showJobHistory(ctx, job) {
  if (!needSession(ctx) || !job) return;
  const session = ctx.session;
  let text = null;
  await ctx.task(
    `read the history of job ${job.name}`,
    async (signal) => {
      const runs = buildJobHistory((await session.run(jobHistorySql(job.id), { signal, limit: 1000 })).sets);
      text = jobHistoryText(job, runs);
      return [`${runs.length} run${runs.length === 1 ? '' : 's'}`];
    },
    { label: `Reading the history of ${job.name}`, quiet: true },
  );
  if (text != null) ctx.showText(`Job ${job.name}: recent runs`, text);
}

/**
 * s on a job: starts it with msdb's sp_start_job, after asking. It's an EXEC, so a write as classify()
 * has it: a read-only connection refuses it until /writes. Not inside an open transaction, which
 * couldn't take it back.
 */
export async function startJob(ctx, job) {
  if (!needSession(ctx) || !job) return;
  const { conn } = ctx.session;
  const dialect = dialectOf(ctx.session);
  if (!dialect.jobs.sql) return ctx.note(dialect.jobs.unavailable, 'error');
  const sql = startJobSql(job.name);
  if (classifyScript(sql, { dialect: dialect.kind }).write && isReadOnly(conn) && !ctx.writesAllowed) {
    return ctx.note(`${conn.name} is read-only${conn.prod ? ' (production)' : ''}, and starting a job changes things. /writes allows it until you disconnect.`, 'error');
  }
  if (ctx.tranCount) return ctx.note('A transaction is open, and a job started now runs outside it: /commit or /rollback first.', 'error');
  if (job.running) return ctx.note(`${job.name} is running already.`, 'error');
  const ok = await ctx.confirm({
    title: `Start job ${job.name}?`,
    detail: `On ${conn.name}${conn.prod ? ' (production)' : ''}. SQL Agent runs it from its first step, now${job.enabled ? '' : ' (it is disabled, which only stops its schedules)'}.`,
    options: YES_NO('Yes, start it'),
    danger: Boolean(conn.prod),
  });
  if (!ok) return;
  const r = await ctx.query(sql, { title: `start job ${job.name}`, keep: true });
  if (r?.ok) await loadJobs(ctx);
}

/**
 * The costliest queries, for Activity's top-queries list, by `sort` (duration, cpu, reads,
 * executions): first where to read them (Query Store, the plan cache, pg_stat_statements…), then them.
 */
export async function loadTopQueries(ctx, { sort, quiet = true } = {}) {
  if (!needSession(ctx)) return;
  const session = ctx.session;
  const d = dialectOf(session);
  const by = sort ?? ctx.activityLists.queries?.sort ?? 'duration';
  const base = { queries: [], sort: by, at: Date.now(), conn: session.conn.name, database: session.database, source: null, note: null, error: null, unavailable: null };
  let read = null;
  const r = await ctx.task(
    'read the top queries',
    async (signal) => {
      let probe;
      try {
        probe = topProbe((await session.run(d.topQueries.probe, { signal, limit: 10 })).sets);
      } catch (e) {
        // SQL Server before 2016 has no sys.database_query_store_options: the plan cache it is.
        if (d.kind !== 'sqlserver' || e.number !== 208) throw e;
        probe = { database: session.database, store: null };
      }
      const plan = d.topQueries.plan(probe, sortColumn(by));
      if (plan.unavailable) return (read = { unavailable: plan.unavailable }), [plan.unavailable];
      const queries = sortQueries(buildTopQueries((await session.run(plan.sql, { signal, limit: 1000 })).sets), by);
      read = { queries, source: plan.source, note: plan.note ?? null };
      return [`${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}`];
    },
    { label: 'Reading the top queries', quiet },
  );
  if (read) return ctx.setActivityLists({ queries: { ...base, ...read, at: Date.now() } });
  if (!r.ok && r.error?.message !== 'busy' && !r.error?.cancelled) ctx.setActivityLists({ queries: { ...base, error: r.error.message } });
}

/** The console's selection, or the statement under its cursor: what ctrl+r would run. */
function consoleStatement(ctx) {
  const e = ctx.console;
  return ed.selectedText(e)?.text.trim() || statementAt(splitStatements(ed.toText(e)), e.row + 1)?.text || '';
}

/**
 * /snippet <name> runs a saved query; /snippet save <name> keeps the console's selection (or its
 * statement under the cursor) under that name for the connection you're on; /snippet delete <name>
 * forgets one; /snippet alone lists them (/snippets).
 */
export async function snippet(ctx, rest) {
  const m = String(rest ?? '').trim().match(/^(\S+)?\s*([\s\S]*)$/);
  const [word, name] = [m[1] ?? '', m[2].trim()];
  const conn = ctx.session?.conn.name ?? null;
  if (!word) return showSnippets(ctx);
  if (word.toLowerCase() === 'save') {
    const problem = snippetNameProblem(name);
    if (problem) return name ? ctx.note(problem, 'error') : ctx.prefill('/snippet save ');
    const sql = consoleStatement(ctx);
    if (!sql) return ctx.note('Nothing to save: select some SQL in the console, or put the cursor on a statement.', 'error');
    const there = (ctx.config.snippets ?? []).find((x) => x.name.toLowerCase() === name.toLowerCase() && String(x.conn ?? '').toLowerCase() === String(conn ?? '').toLowerCase());
    if (there && there.sql !== sql) {
      const ok = await ctx.confirm({ title: `Replace the snippet ${there.name}?`, detail: oneLine(there.sql), options: YES_NO('Yes, replace it') });
      if (!ok) return;
    }
    ctx.setConfig((c) => ({ ...c, snippets: withSnippet(c.snippets, { name, conn, sql, at: Date.now() }) }));
    return ctx.note(`Saved the snippet ${name}${conn ? ` for ${conn}` : ' for every connection'}. /snippet ${name} runs it.`, 'ok');
  }
  if (word.toLowerCase() === 'delete') {
    if (!name) return ctx.prefill('/snippet delete ');
    const found = findSnippet(ctx.config.snippets, conn, name);
    if (!found) return ctx.note(`No snippet called ${name}${conn ? ` for ${conn}` : ''}.`, 'error');
    return forgetSnippet(ctx, found);
  }
  const found = findSnippet(ctx.config.snippets, conn, `${word}${name ? ` ${name}` : ''}`);
  if (!found) return ctx.note(`No snippet called ${word}${name ? ` ${name}` : ''}${conn ? ` for ${conn}` : ''}. /snippets lists them.`, 'error');
  return runSql(ctx, found.sql, { prefix: `${found.name}: ` });
}

async function forgetSnippet(ctx, found) {
  const ok = await ctx.confirm({ title: `Forget the snippet ${found.name}?`, detail: oneLine(found.sql), options: YES_NO('Yes, forget it') });
  if (!ok) return false;
  ctx.setConfig((c) => ({ ...c, snippets: withoutSnippet(c.snippets, found) }));
  ctx.note(`Forgot the snippet ${found.name}.`, 'ok');
  return true;
}

/** /snippets: the saved queries for this connection (and every connection), to run, edit or forget. */
export function showSnippets(ctx) {
  const conn = ctx.session?.conn.name ?? null;
  const items = snippetsFor(ctx.config.snippets, conn).map((x) => ({ label: x.name, detail: `${x.conn ? '' : 'every connection · '}${oneLine(x.sql)}`, text: x.sql, snippet: x }));
  ctx.showPicker({
    title: `Snippets${conn ? `: ${conn}` : ''}`,
    hint: '↵ run · e edit in the console · x forget',
    items,
    empty: 'No snippets yet. In the console, S (or /snippet save <name>) keeps the statement under the cursor.',
    keys: {
      return: (it) => runSql(ctx, it.snippet.sql, { prefix: `${it.snippet.name}: ` }),
      e: (it) => ctx.editInConsole(it.snippet.sql),
      x: async (it) => (await forgetSnippet(ctx, it.snippet)) && showSnippets(ctx),
    },
  });
}

// Connections a fan-out works on at once.
const FAN_OUT = 4;

/**
 * /fanout <folder> [sql]: one read-only query on every connection in a folder (and the folders under
 * it), each on a connection of its own, at most four at a time. The rows come back as one result set
 * led by the connection and database; a connection that fails says why under it, and the rest go on.
 * Without SQL, it's the console's selection or the statement under its cursor. Writes are refused, and
 * what runs is rolled back, as trawl mcp does.
 */
export async function fanOut(ctx, rest) {
  const m = String(rest ?? '').trim().match(/^(?:"([^"]+)"|(\S+))\s*([\s\S]*)$/);
  if (!m) return ctx.prefill('/fanout ');
  const folder = m[1] ?? m[2];
  const conns = inFolder(ctx.config.connections, folder);
  if (!conns.length) {
    const known = folderNames(ctx.config.connections);
    return ctx.note(`No connections in a folder called ${folder}.${known.length ? ` Folders: ${known.join(', ')}.` : ' /folder <connection> <folder> files one.'}`, 'error');
  }
  const text = m[3].trim() || consoleStatement(ctx);
  if (!text) return ctx.note('Nothing to run: /fanout <folder> <sql>, or put the cursor on a statement in the console.', 'error');
  // Postgres's and MySQL's own writes count too when the folder has any.
  const other = conns.map((c) => dialectOf(c).kind).find((k) => k !== 'sqlserver');
  const { write, danger } = classifyScript(text, { dialect: other });
  if (write) return ctx.note(`/fanout only reads, and this changes data or schema${danger.length ? ` (${danger.join('; ')})` : ''}. Run writes on one connection at a time.`, 'error');
  const limit = ctx.config.limit;
  let parts = null;
  const started = Date.now();
  const title = `${folder}/ (${conns.length}): ${oneLine(withoutLeadingComments(text))}`;
  await ctx.task(
    title,
    async (signal) => {
      parts = await inParallel(conns, FAN_OUT, async (conn) => {
        let s = null;
        const dialect = dialectOf(conn);
        const { sql, offset } = readOnlyScript(text, dialect.readOnlyPrefix);
        try {
          s = await ctx.openSession(conn, { signal });
          const res = await s.run(sql, { signal, limit });
          return { conn: conn.name, database: s.database, sets: res.sets };
        } catch (e) {
          if (signal.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
          const why = e.needsPassword ? `needs its password: connect to it once in Trawl to save it` : `${e.line ? `Line ${Math.max(1, e.line - offset)}: ` : ''}${e.message}`;
          return { conn: conn.name, database: s?.database ?? conn.database ?? null, error: why };
        } finally {
          if (s && !s.closed) {
            if (await s.tranCount().catch(() => 0)) await s.run(dialect.rollback).catch(() => {});
            s.close();
          }
        }
      });
      const merged = mergeResults(parts);
      return [`${merged.sets.map((x) => `${x.rows.length} rows`).join(' · ') || 'no rows'} · ${merged.messages[0]}`, ...merged.messages.slice(1)];
    },
    { label: `Running on ${conns.length} connection${conns.length === 1 ? '' : 's'}` },
  );
  if (!parts) return;
  const merged = mergeResults(parts);
  const at = Date.now();
  for (const p of parts) ctx.recordRun({ sql: text, conn: p.conn, database: p.database, at, ok: !p.error, summary: p.error ?? `${p.sets.map((x) => `${x.rows.length} rows`).join(' · ') || 'no rows'} (/fanout ${folder})` });
  ctx.present({ title, sql: text, sets: merged.sets, messages: merged.messages, ms: Date.now() - started, edit: { reason: 'these rows come from several databases' }, conn: `${folder}/`, database: null });
}

/**
 * /diff <connection> [database], or /diff <database> for another one on this server: compares the
 * schema here with that one (tables, columns, keys, indexes, and the definitions of views, procedures
 * and functions), shows the differences, and offers the script that would make this database match,
 * in the console to read through. Nothing runs by itself.
 */
export async function diffSchema(ctx, rest) {
  if (!needSession(ctx)) return;
  const args = splitArgsLoose(rest);
  if (!args.length) return ctx.prefill('/diff ');
  const session = ctx.session;
  let conn = ctx.config.connections.find((c) => c.name.toLowerCase() === args[0].toLowerCase());
  let database = args[1];
  if (!conn) {
    database = args.length === 1 ? ctx.schema?.databases.find((d) => d.toLowerCase() === args[0].toLowerCase()) : null;
    if (!database) return ctx.note(`No connection or database called ${args[0]}. /diff <connection> [database], or /diff <database> on this server.`, 'error');
    conn = session.conn;
  }
  const left = `${session.conn.name}/${session.database}`;
  let right = `${conn.name}/${database ?? conn.database ?? ''}`;
  let found = null;
  const r = await ctx.task(
    `diff ${left} with ${right}`,
    async (signal) => {
      // Definitions and indexes are read from SQL Server's catalog; elsewhere, tables, columns and keys.
      const read = async (s) => ({
        schema: buildSchema((await s.run(dialectOf(s).schemaSql, { signal, limit: 1_000_000 })).sets),
        ...(dialectOf(s).kind === 'sqlserver' ? buildExtras((await s.run(DIFF_SQL, { signal, limit: 1_000_000 })).sets) : { definitions: new Map(), indexes: [] }),
      });
      const mine = await read(session);
      let other = null;
      let theirs;
      try {
        other = await ctx.openSession(conn, { database, signal });
        right = `${conn.name}/${other.database}`;
        theirs = await read(other);
      } catch (e) {
        if (e.needsPassword) e.message = `${conn.name} needs its password: connect to it once in Trawl to save it.`;
        throw e;
      } finally {
        other?.close();
      }
      const changes = schemaDiff(mine, theirs);
      found = { changes, mine, theirs };
      return [changes.length ? `${changes.length} difference${changes.length === 1 ? '' : 's'}: the list is on screen.` : 'The schemas are the same.'];
    },
    { label: `Comparing with ${right}` },
  );
  if (!r.ok || !found) return;
  const { changes, theirs } = found;
  const title = `Schema diff: ${left} ←→ ${right}`;
  const text = diffText(changes, { left, right });
  ctx.rememberOutput(title, text);
  ctx.showText(title, text);
  if (!changes.length) return;
  if (dialectOf(session).kind !== 'sqlserver' || dialectOf(conn).kind !== 'sqlserver') return ctx.note('The script that makes one match the other is T-SQL, so only between SQL Server databases.');
  const open = await ctx.confirm({
    title: `Put the script that makes ${left} match ${right} in the console?`,
    detail: 'The differences are above (pgup/pgdn scroll them). It goes into the console to read through; nothing runs.',
    scrollsOverlay: true,
    options: YES_NO('Yes, into the console'),
  });
  ctx.closeOverlay();
  if (open) ctx.editInConsole(syncScript(changes, { left, right, rightSchema: theirs.schema, rightDefinitions: theirs.definitions }));
}

export function setLimit(ctx, value) {
  if (!value) return ctx.note(`Result sets stop at ${ctx.config.limit} rows. /limit <n> changes it.`);
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 1_000_000) return ctx.note('The limit is a whole number from 1 to 1000000.', 'error');
  ctx.setConfig((c) => ({ ...c, limit: n }));
  ctx.note(`Result sets now stop at ${n} rows.`, 'ok');
}

/**
 * /ask: Claude writes a query from the schema (names only, never rows) and it goes into the
 * console under the question. Nothing runs until you press ctrl+r there.
 */
export async function ask(ctx, question) {
  if (!needSession(ctx)) return;
  if (!question) return ctx.prefill('/ask ');
  const { conn } = ctx.session;
  if (!canSeeSchema(conn)) return ctx.note(`${conn.name} is closed to Claude. /ai schema lets Claude see its table and column names.`, 'error');
  if (!ctx.schema) return ctx.note('The schema is still loading; try again in a moment.', 'error');
  const prompt = askPrompt({ question, schema: ctx.schema, database: ctx.session.database });
  let answer = null;
  const r = await ctx.task(
    `ask Claude: ${question}`,
    async (signal) => {
      answer = parseAnswer(await ctx.askClaude({ prompt, signal }));
      return answer.sql ? ['The query is in the console: read it, then ctrl+r runs it.', ...(answer.note ? [answer.note] : [])] : [answer.note || 'Claude gave no query.'];
    },
    { label: 'Asking Claude' },
  );
  if (r.ok && answer?.sql) ctx.editInConsole(consoleText({ question, ...answer }));
}

/**
 * Sets what Claude may see of a connection: /ai <level> for the one you're on, or
 * /ai <connection> <level>. With no level, says what it is now.
 */
export async function setAi(ctx, rest) {
  const parts = rest.split(/\s+/).filter(Boolean);
  const level = AI_LEVELS.includes(parts.at(-1)) ? parts.pop() : null;
  const name = parts[0] ?? ctx.session?.conn.name;
  if (!name) return ctx.note('Connect first, or name the connection: /ai <connection> off|schema|results', 'error');
  const conn = ctx.config.connections.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (!conn) return ctx.note(`No connection called ${name}.`, 'error');
  if (!level) return ctx.note(`Claude may see ${AI_LABELS[aiLevel(conn)]} of ${conn.name}. /ai ${conn.name} off|schema|results changes it.`);
  if (level === 'results' && !conn.demo) {
    const ok = await ctx.confirm({
      title: `Let Claude see rows from ${conn.name}${conn.prod ? ' (production)' : ''}?`,
      detail: 'Query results then go to Claude when it asks (through trawl mcp) or when you ask it about them. They leave this machine.',
      options: YES_NO('Yes, rows too'),
      danger: Boolean(conn.prod),
    });
    if (!ok) return;
  }
  if (conn.demo) conn.ai = level;
  else ctx.setConfig((c) => ({ ...c, connections: c.connections.map((x) => (x.name === conn.name ? { ...x, ai: level } : x)) }));
  ctx.note(`Claude may now see ${AI_LABELS[level]} of ${conn.name}.`, 'ok');
}

/**
 * /import datagrip [folder]: DataGrip's data sources as connections, after a preview. Without a
 * folder it looks where DataGrip keeps them; with one, it reads that project's .idea.
 */
export async function importConnections(ctx, rest) {
  const [source, ...folder] = splitArgsLoose(rest);
  if (!source || source.toLowerCase() !== 'datagrip') return ctx.note('Import from DataGrip: /import datagrip [project folder]', source ? 'error' : 'info');
  const dir = folder.length ? resolve(folder.join(' ')) : undefined;
  const sources = (ctx.findDataSources ?? findDataSources)({ folder: dir });
  if (!sources.length) return ctx.note(dir ? `No DataGrip data sources in ${dir} (looked for .idea/dataSources.xml).` : 'No DataGrip data sources found. Point at a project: /import datagrip <folder>', 'error');
  const plan = importPlan(sources, ctx.config.connections);
  ctx.showText(`Import from DataGrip${dir ? `: ${dir}` : ''}`, planText(plan));
  if (!plan.add.length && !plan.file.length) return;
  const n = (k) => `${k} connection${k === 1 ? '' : 's'}`;
  const [adds, files] = [plan.add.length, plan.file.length];
  const ok = await ctx.confirm({
    title: [adds ? `Add ${n(adds)} from DataGrip` : '', files ? `${adds ? 'put' : 'Put'} ${n(files)} into DataGrip's folders` : ''].filter(Boolean).join(', and ') + '?',
    detail: 'The list is above (pgup/pgdn scroll it). Nothing is sent anywhere; passwords stay in DataGrip.',
    scrollsOverlay: true,
    options: YES_NO(adds ? `Yes, add ${adds}` : `Yes, file ${files}`),
  });
  ctx.closeOverlay();
  if (!ok) return;
  const folders = new Map(plan.file.map((f) => [f.name, f.folder]));
  // Earlier imports named a TRAWL_PW_… variable for each login; unset, it gives way to the credential store.
  const refile = (x) => {
    const { passwordEnv, ...rest } = withFolder(x, folders.get(x.name));
    return passwordEnv && (process.env[passwordEnv] != null || !passwordEnv.startsWith('TRAWL_PW_')) ? { ...rest, passwordEnv } : rest;
  };
  ctx.setConfig((c) => ({ ...c, connections: [...c.connections.map((x) => (folders.has(x.name) ? refile(x) : x)), ...plan.add] }));
  ctx.setView('connections');
  const logins = plan.add.some((c) => c.auth === 'sql');
  const done = [adds ? `Added ${n(adds)} from DataGrip` : '', files ? `${adds ? 'filed' : 'Filed'} ${n(files)} in DataGrip's folders` : ''].filter(Boolean).join(', and ');
  ctx.note(`${done}.${logins ? ' Trawl asks for each login’s password when you first connect.' : ''}`, 'ok');
  ctx.rememberOutput(`Import from DataGrip`, planText(plan));
}

const splitArgsLoose = (s) => String(s ?? '').trim().split(/\s+/).filter(Boolean);

/**
 * /tab: the console's tabs. /tab new [name] opens one, /tab <name or number> switches, /tab rename
 * <name> renames the one on screen, /tab close closes it (asking when it has text). /tab alone lists them.
 */
export async function consoleTab(ctx, rest) {
  const [word = '', ...more] = splitArgsLoose(rest);
  const arg = more.join(' ');
  const { names, index } = ctx.consoleTabs;
  const tabs = names.map((name) => ({ name }));
  const w = word.toLowerCase();
  if (!w) return ctx.note(`Console tabs: ${names.map((n, i) => (i === index ? `[${i + 1} ${n}]` : `${i + 1} ${n}`)).join('  ')}. [ and ] switch, + opens one; /tab new|close|rename|<name>.`);
  if (w === 'new') {
    const name = arg || freeName(tabs);
    const problem = tabNameProblem(name, tabs);
    if (problem) return ctx.note(problem, 'error');
    ctx.addConsoleTab(name);
    return ctx.setEditing(true);
  }
  if (w === 'close') {
    if (names.length === 1) return ctx.note('This is the only console tab; /new clears it.', 'error');
    if (ed.toText(ctx.console).trim()) {
      const ok = await ctx.confirm({ title: `Close the console tab ${names[index]}?`, detail: 'Its text goes with it; /save <file.sql> first keeps a copy.', options: YES_NO('Yes, close it') });
      if (!ok) return;
    }
    return ctx.closeConsoleTab();
  }
  if (w === 'rename') {
    if (!arg) return ctx.prefill(`/tab rename `);
    const problem = tabNameProblem(arg, tabs, { except: index });
    if (problem) return ctx.note(problem, 'error');
    ctx.renameConsoleTab(arg);
    return ctx.note(`The console tab is ${arg} now.`, 'ok');
  }
  const i = findTab(tabs, rest.trim());
  if (i < 0) return ctx.note(`No console tab called ${rest.trim()}. /tab lists them; /tab new <name> opens one.`, 'error');
  ctx.showConsoleTab(i);
}

/**
 * /import-csv <file.csv> <table> [--run]: the file's rows as INSERT statements into the table, its
 * columns matched to the header by name. They open in a console tab of their own to read through, or
 * with --run go straight through the usual checks (read-only, manual commit) as any SQL does.
 */
export async function importCsv(ctx, rest) {
  if (!needSession(ctx)) return;
  const args = splitArgs(rest);
  const run = args.includes('--run');
  const [path, name] = args.filter((x) => x !== '--run');
  if (!path || !name) return ctx.prefill('/import-csv ');
  const table = findObject({ objects: (ctx.schema?.objects ?? []).filter((o) => o.kind === 'table') }, name);
  if (!table) return ctx.note(`No table called ${name} in ${ctx.session.database}.`, 'error');
  const full = resolve(path);
  let built;
  try {
    const d = dialectOf(ctx.session);
    built = csvInsertScript(parseCsv(await readFile(full, 'utf8')), table, d.kind === 'sqlserver' ? {} : { quote: d.quote });
  } catch (e) {
    return ctx.note(`${full}: ${e.code === 'ENOENT' ? 'no such file' : e.message.split('\n')[0]}`, 'error');
  }
  const what = `${built.rows} row${built.rows === 1 ? '' : 's'} from ${full.split(/[\\/]/).pop()} into ${objectName(table)}`;
  const notes = [
    `-- ${what}: ${built.columns.join(', ')}`,
    ...built.skipped.map((s) => `-- Left out ${s}.`),
    ...(built.missing.length ? [`-- Not in the file, and NOT NULL: ${built.missing.join(', ')} (the insert fails unless they have defaults).`] : []),
  ];
  const script = `${notes.join('\n')}\n${built.script}\n`;
  if (run) return runSql(ctx, script, { title: `import ${what}` });
  const tabs = ctx.consoleTabs.names.map((n) => ({ name: n }));
  ctx.addConsoleTab(freeName(tabs, 'import'));
  ctx.setConsole(ed.fromText(script));
  ctx.note(`The INSERT script for ${what} is in a console tab of its own: R runs it.`, 'ok');
}

// Bigger than this, a dropped file is better read through /open, which doesn't load it into the editor.
const DROP_LIMIT = 1024 * 1024;

/**
 * Files dropped on the terminal, which types their paths: each .sql or .txt opens in a console tab
 * of its own, named after it. False when `text` isn't the paths of such files, so it's taken as typing.
 */
export function openDropped(ctx, text) {
  const paths = droppedPaths(text);
  const sizes = paths?.map((p) => {
    try {
      const st = statSync(p);
      return st.isFile() ? st.size : -1;
    } catch {
      return -1;
    }
  });
  if (!sizes || sizes.some((n) => n < 0)) return false;
  const opened = [];
  paths.forEach((path, i) => {
    const name = basename(path);
    if (sizes[i] > DROP_LIMIT) return ctx.note(`${name} is over 1 MB: /open ${path} works through it a statement at a time.`, 'error');
    let text;
    try {
      const buf = readFileSync(path);
      // SSMS can save as UTF-16; either way a byte order mark isn't SQL.
      text = (buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8')).replace(/^\uFEFF/, '');
    } catch (e) {
      return ctx.note(`${path}: ${e.message.split('\n')[0]}`, 'error');
    }
    ctx.addConsoleTab(freeName(ctx.consoleTabs.names.map((n) => ({ name: n })), tabNameFor(path)));
    ctx.setConsole(ed.fromText(text), { record: false });
    opened.push(name);
  });
  if (opened.length) ctx.note(`${opened.join(', ')} ${opened.length === 1 ? 'is' : 'are'} in a console tab of ${opened.length === 1 ? 'its' : 'their'} own: R runs it all.`, 'ok');
  return true;
}

/** Empties the console, asking first when there's something in it. */
export async function newConsole(ctx) {
  if (ed.toText(ctx.console).trim()) {
    const ok = await ctx.confirm({ title: 'Clear the console?', detail: 'ctrl+z in the console brings it back until you quit; /save <file.sql> keeps a copy for good.', options: YES_NO('Yes, clear it') });
    if (!ok) return;
  }
  ctx.setConsole(ed.fromText(''));
  ctx.showConsole();
  ctx.setEditing(true);
}

/**
 * /search <text>, and n / N in the console: selects the next (or previous) place it appears.
 * With no text, the last search again.
 */
export function searchConsole(ctx, text, { back = false } = {}) {
  const query = text || ctx.lastSearch;
  if (!query) return ctx.prefill('/search ');
  ctx.lastSearch = query;
  ctx.showConsole();
  const next = ed.find(ctx.console, query, { back });
  if (!next) return ctx.note(`"${query}" isn't in the console.`, 'error');
  ctx.setConsole(next);
}

/** /format and f in the console: lays out the selection, or the statement under the cursor (ctrl+z undoes it). */
export function formatConsole(ctx) {
  const e = ctx.console;
  ctx.showConsole();
  const sel = ed.selectedText(e);
  const st = sel ? null : statementAt(splitStatements(ed.toText(e)), e.row + 1);
  const source = sel?.text ?? st?.text;
  if (!source?.trim()) return ctx.note('Nothing to format: the console is empty.', 'error');
  const out = formatSql(source);
  if (out == null) return ctx.note('Trawl formats queries (SELECT, INSERT, UPDATE, DELETE, MERGE), not procedures, blocks or SET options.', 'error');
  let next;
  if (sel) next = ed.insert(e, out);
  else {
    const [first, last] = [st.line - 1, st.endLine - 1];
    if (e.lines.slice(first, last + 1).join('\n').trim() !== st.text) return ctx.note('That statement shares a line with another: select it (shift+arrows) to format it.', 'error');
    const lead = e.lines[first].match(/^\s*/)[0];
    next = { lines: [...e.lines.slice(0, first), ...out.split('\n').map((l) => lead + l), ...e.lines.slice(last + 1)], row: first, col: lead.length };
  }
  if (ed.toText(next) === ed.toText(e)) return ctx.note('It is formatted already.');
  ctx.setConsole(next);
}

/** Writes the console to a .sql file. */
export async function saveConsoleAs(ctx, path) {
  if (!path) return ctx.prefill('/save ');
  const full = resolve(path);
  try {
    await writeFile(full, ed.toText(ctx.console).replace(/\n*$/, '\n'), 'utf8');
    ctx.note(`Saved the console to ${full}. /open it to work on the file instead.`, 'ok');
  } catch (e) {
    ctx.note(`Couldn't write ${full}: ${e.message}`, 'error');
  }
}

/** p in Results and /pin: keeps the result set on screen to compare a later run with (c, /compare). */
export function pinResult(ctx) {
  const res = ctx.results;
  const set = ctx.currentSet();
  if (!set) return ctx.note('Run a query first: there is nothing to pin.', 'error');
  if (res.compared) return ctx.note('This is a comparison; pin a result of a query.', 'error');
  // The primary key's columns, when the rows are one table's, match rows up by key.
  const keys = res.edit?.keys && set === res.sets[0] ? res.edit.keys.map((i) => set.columns[i].name) : [];
  ctx.pinned = { set, title: res.title, keys, id: res.id };
  ctx.note(`Pinned ${set.rows.length} row${set.rows.length === 1 ? '' : 's'} of ${res.title}. Run it again, then c in Results (/compare) shows what changed${keys.length ? `, rows matched by ${keys.join(', ')}` : ''}.`, 'ok');
}

/** c in Results and /compare: the result set on screen against the pinned one, as a result set of its own. */
export function compareResults(ctx) {
  const pin = ctx.pinned;
  if (!pin) return ctx.note('Pin a result first: p in Results (or /pin), then run again and compare.', 'error');
  const res = ctx.results;
  const set = ctx.currentSet();
  if (!set || res.compared) return ctx.note('Run the query again first: the result on screen is what gets compared with the pinned one.', 'error');
  if (res.id === pin.id && set === pin.set) return ctx.note('This is the pinned result itself: run the query again, then compare.', 'error');
  let diff;
  try {
    diff = compareSets(pin.set, set, { keys: pin.keys });
  } catch (e) {
    return ctx.note(e.message, 'error');
  }
  const summary = comparisonSummary(diff, pin.keys);
  ctx.present({ title: `Compared: ${pin.title} → now`, sql: res.sql, sets: [comparisonSet(diff)], messages: [summary], ms: null, edit: { reason: 'it is a comparison' }, compared: true, conn: res.conn, database: res.database });
  ctx.note(summary, 'ok');
}

const COPY_FORMATS = ['tsv', 'csv', 'json', 'insert'];

/**
 * /copy [tsv|csv|json|insert]: the result set on screen, on the clipboard. Tab-separated (the
 * default) pastes into a spreadsheet as cells; insert gives INSERT statements for the table.
 */
export function copyResults(ctx, format) {
  const set = ctx.currentSet();
  if (!set) return ctx.note('Run a query first: there is nothing to copy.', 'error');
  const f = (format || 'tsv').toLowerCase();
  if (!COPY_FORMATS.includes(f)) return ctx.note(`/copy takes ${COPY_FORMATS.join(', ')} (tab-separated is the default).`, 'error');
  const res = ctx.results;
  const d = dialectOf(ctx.session);
  const source = res?.edit?.table ?? res?.source?.table;
  const table = source ? qualifiedFor(d, source.schema, source.name) : d.quote('TableName');
  const text = f === 'csv' ? toCsv(set) : f === 'json' ? toJson(set) : f === 'insert' ? insertScript(set, table, { quote: d.quote }) : tsvText(set);
  const n = `${set.rows.length} row${set.rows.length === 1 ? '' : 's'}`;
  return ctx.copy(text, f === 'tsv' ? `${n}, tab-separated` : f === 'insert' ? `${n} as INSERT statements${source ? '' : ` (into ${table}: rename it)`}` : `${n} as ${f.toUpperCase()}`);
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
