// Every operation the UI offers, written once. Keys and slash commands both call these.
// `ctx` is the app's handle: session, schema, query, confirm, note, prefill, and so on (see App.jsx).
import { mkdirSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { ADD_USAGE, cleanFolder, commitMode, describeConn, isReadOnly, parseAddArgs, splitArgs, sshText } from './connections.js';
import { csvInsertScript, parseCsv } from './csv.js';
import * as ed from './editor.js';
import { findDataSources, importPlan, planText } from './datagrip.js';
import { formatSql } from './format.js';
import { wrap } from './text.js';
import { cellText } from './cell.js';
import { changesText, hasChanges, insertScript, saveRecovery, saveScript, tsvText, withSaved } from './edit.js';
import { AI_LABELS, AI_LEVELS, EXPLAIN_SYSTEM, WHY_SYSTEM, aiLevel, askPrompt, canSeeSchema, consoleText, explainPrompt, parseAnswer, whyConsoleText, whyPrompt } from './ai.js';
import { parseWatch } from './watch.js';
import { followTargets } from './follow.js';
import { moreQuery, raiseTop } from './more.js';
import { analyzedText, splitProfile } from './plans.js';
import { compareSets, comparisonSet, comparisonSummary } from './compare.js';
import { droppedPaths, findTab, freeName, tabNameFor, tabNameProblem } from './consoles.js';
import { findSnippet, snippetNameProblem, snippetsFor, withSnippet, withoutSnippet } from './snippets.js';
import { folderNames, inFolder, inParallel, mergeResults, readOnlyScript } from './fanout.js';
import { DIFF_SQL, buildExtras, diffText, schemaDiff, syncScript } from './diff.js';
import { buildHealth, buildSizes, fixableGroups, healthScript, healthSummary, healthText } from './health.js';
import { SOURCES as DEADLOCK_SOURCES, buildDeadlocks, buildInnodbDeadlocks, deadlockSummary, deadlockText, deadlockTime } from './deadlocks.js';
import { agentProbe, buildActivity, buildJobHistory, buildJobs, buildTopQueries, jobHistorySql, jobHistoryText, killSql, sortColumn, sortQueries, startJobSql, topProbe } from './activity.js';
import { dialectOf, definitionSqlFor, qualifiedFor, selectTopFor } from './dialects.js';
import { buildSchema, createTableScript, definitionSql, describeObject, findObject, objectName, rowsOf } from './schema.js';
import { grepHits, usesReport, usesSummary, usesText } from './references.js';
import { EXTRAS_SQL, KIND_DIRS, buildTableExtras, createKey, planFiles, scriptFiles, scriptedObjects, summaryLine, summaryText, uniqueColumns, withoutAutoIncrement } from './scriptall.js';
import { TOOLS, createPlainSql, historySql, migrationStatus, nextRank, parseFlywayName, pickHistory, probeSql, recordSql, statusText } from './migrations.js';
import { generateScript, refValuesSql } from './generate.js';
import { LANGUAGE_NAMES, LANGUAGES, languageOf, scaffold } from './scaffold.js';
import { UNDO_ROWS, reverseScript, snapshotOf, snapshotRows, snapshotSummary, undoPlan, withSnapshot } from './undo.js';
import { loadUndo, saveUndo } from './config.js';
import { relTime } from './text.js';
import { applySqlcmd, bindVariables, classifyScript, countQuery, oneLine, scriptVariables, splitStatements, sqlcmdVariables, statementAt, toCsv, toJson, toMarkdown, withoutLeadingComments } from './sql.js';

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

/** needSession, and when the connection dropped since (an idle one Azure SQL closed), a new one first. */
async function liveSession(ctx) {
  if (!needSession(ctx)) return false;
  return ctx.session.closed ? ctx.reconnect() : true;
}

/**
 * What to do about SQL whose connection dropped while it ran: { rerun, message }. Only a read with
 * no transaction open runs again by itself; a write may or may not have happened, and an open
 * transaction went with the connection (the server rolls it back). `wrapped`: Trawl began a
 * transaction for it (manual commit), which went the same way.
 */
export function afterLostConnection(sql, { dialect = 'sqlserver', hadTran = false, wrapped = false } = {}) {
  if (hadTran && /^COMMIT\b/i.test(withoutLeadingComments(sql).trim())) return { rerun: false, message: 'It dropped during the COMMIT, which may or may not have gone through: look before running anything again.' };
  if (hadTran) return { rerun: false, message: 'The open transaction went with it: the server rolled it back, undoing everything since it began. Nothing ran again.' };
  if (wrapped) return { rerun: false, message: 'The transaction manual commit began for it went with it: the server rolled that back, so nothing of it was kept.' };
  if (classifyScript(sql, { dialect }).write) return { rerun: false, message: 'It dropped while this ran, so the change may or may not have been made: check before running it again.' };
  return { rerun: true, message: 'The connection had dropped: reconnected and ran it again.' };
}

/**
 * How many rows an UPDATE or DELETE would change, counted first with a SELECT built from it (so
 * nothing is written to find out). Null when it can't be counted; 'cancelled' after esc.
 */
async function countChanges(ctx, text) {
  const d = dialectOf(ctx.session);
  const q = countQuery(text, { dialect: d.kind })?.replace(/^SELECT COUNT_BIG\(\*\)/, `SELECT ${d.count}`);
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

/**
 * Runs SQL on the current connection, after the read-only and danger checks. `top`: the SQL is
 * Trawl's own TOP (n) at the row limit, so m in Results can raise it. `run` takes over once the
 * checks have passed ((text, { write, wrap, title }) => …), as the actual plan does; it gets the
 * SQL with its parameters filled in, and `wrap` says manual commit wants it in a transaction.
 * `recover` runs if it fails (see db.js runScript).
 */
export async function runSql(ctx, sql, { title, prefix = '', lineBase, stay, keep, top, run, recover } = {}) {
  if (!sql.trim()) return;
  // Any other run ends a /watch, which would otherwise be in its way.
  await ctx.stopWatch?.('another run');
  if (!(await liveSession(ctx))) return;
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
  // What /undo-write will have: a copy of the rows an UPDATE or DELETE changes, an INSERT's keys.
  // The actual plan (run) keeps none.
  const undo = write && !run ? undoPlan(text, ctx.schema, { kind: dialect.kind }) : null;
  const tooMany = undo?.op !== 'insert' && changes != null && changes > UNDO_ROWS;
  const undoNote = !undo
    ? ''
    : undo.reason || tooMany
      ? ` No copy is kept for /undo-write: ${undo.reason ?? `that's more than ${UNDO_ROWS.toLocaleString('en')} rows`}.`
      : undo.op === 'insert'
        ? ' Its keys are kept: /undo-write can take the rows out again.'
        : ' A copy of the rows is kept first: /undo-write can put them back.';
  const on = `On ${conn.name}${conn.prod ? ' (production)' : ''}`;
  if (danger.length) {
    const ok = await ctx.confirm({
      title: danger.length === 1 ? `${danger[0]}. Run it?` : `This script has ${danger.length} risky statements. Run it?`,
      detail: danger.length > 1 ? `${danger.join(' · ')}.${undoNote}` : `${on}${changes != null ? `: that's ${rowsText(changes)}` : ''}.${undoNote}`,
      options: YES_NO('Yes, run it'),
      danger: true,
    });
    if (!ok) return;
  } else if (changes != null && changes > MANY_ROWS) {
    const ok = await ctx.confirm({
      title: `This changes ${rowsText(changes)}. Run it?`,
      detail: `${on}. Counted with a SELECT over the same FROM and WHERE.${undoNote}`,
      options: YES_NO('Yes, run it'),
      danger: true,
    });
    if (!ok) return;
  }
  let kept = null;
  const notes = [];
  if (undo && !undo.reason && !tooMany) {
    const copy = await copyRows(ctx, undo, text);
    if (copy === 'cancelled') return;
    if (copy.reason) notes.push(`No copy kept for /undo-write: ${copy.reason}.`);
    else if (snapshotRows(copy.snapshot)) {
      kept = copy.snapshot;
      const n = snapshotRows(kept);
      notes.push(kept.op === 'insert' ? `Kept its keys: /undo-write takes the ${n === 1 ? 'row' : rowsText(n)} out again.` : n === 1 ? 'Kept the row as it was: /undo-write puts it back.' : `Kept the ${rowsText(n)} as they were: /undo-write puts them back.`);
    }
  }
  // With manual commit (production's default), a write starts a transaction, so nothing sticks until /commit.
  const wrap = write && commitMode(conn) === 'manual' && !ctx.tranCount;
  const heading = title ?? `${prefix}${oneLine(withoutLeadingComments(text))}`;
  if (run) return run(text, { write, wrap, title: heading });
  const r = await ctx.query(wrap ? `${dialect.begin}\n${text}` : text, { title: heading, wrapped: wrap, lineBase, stay, keep, top, recover, notes });
  if (r?.ok && kept) {
    try {
      saveUndo(conn.name, withSnapshot(loadUndo(conn.name), kept));
    } catch (e) {
      ctx.note(`Couldn't keep the copy for /undo-write: ${e.message.split('\n')[0]}`, 'error');
    }
  }
  return r;
}

/**
 * The copy /undo-write keeps of what a write is about to change (undo.js): the rows the plan's SELECT
 * reads (quietly; esc cancels the write), or an INSERT's keys. { snapshot } or { reason }, or
 * 'cancelled'.
 */
async function copyRows(ctx, plan, text) {
  const session = ctx.session;
  const d = dialectOf(session);
  const meta = { sql: text, conn: session.conn.name, database: session.database, kind: d.kind };
  if (plan.op === 'insert') return { snapshot: snapshotOf(plan, null, meta) };
  if (classifyScript(plan.select, { dialect: d.kind }).write) return { reason: 'its WHERE changes something too' };
  let out = null;
  const r = await ctx.task(
    'copy the rows it changes',
    async (signal) => {
      try {
        const res = await session.run(plan.select, { signal, limit: UNDO_ROWS + 1 });
        out = snapshotOf(plan, res.sets.at(-1), { ...meta, at: Date.now() });
      } catch (e) {
        if (e.cancelled) throw e;
        out = { reason: `reading them failed (${e.message.split('\n')[0]})` };
      }
      return [];
    },
    { label: 'Copying the rows it changes, for /undo-write', quiet: true },
  );
  if (!r.ok) return r.error?.cancelled ? 'cancelled' : { reason: r.error?.message ?? 'it failed' };
  return out.reason ? out : { snapshot: out };
}

/**
 * /undo-write: the copies kept of this connection's last writes (newest first: when, what, how many
 * rows). ↵ puts the script that undoes one in the console tab undo, to read and run; nothing runs.
 */
export function undoWrites(ctx) {
  if (!needSession(ctx)) return;
  const { conn } = ctx.session;
  const list = loadUndo(conn.name);
  const items = list.map((s) => ({
    label: `${relTime(s.at)} ago`.replace(/^now ago$/, 'just now'),
    detail: `${snapshotSummary(s)} · ${s.sql}`,
    text: [`${new Date(s.at).toLocaleString('en-GB')} on ${s.database}`, snapshotSummary(s), '', s.sql, '', ...reverseScript(s).split('\n').slice(3, 13)].join('\n'),
    snapshot: s,
  }));
  ctx.showPicker({
    title: `Undo a write on ${conn.name}`,
    hint: '↵ the script that undoes it, into the console tab undo',
    items,
    empty: `No writes kept for ${conn.name} yet. Each UPDATE or DELETE of a table with a primary key keeps a copy of its rows (up to ${UNDO_ROWS.toLocaleString('en')}), and an INSERT its keys.`,
    keys: { return: (it) => openUndo(ctx, it.snapshot) },
  });
}

/** The script that undoes a kept write, in the console tab undo (made when there's none); nothing runs. */
export function openUndo(ctx, snapshot) {
  const script = reverseScript(snapshot);
  const { names } = ctx.consoleTabs;
  const at = names.findIndex((n) => n.toLowerCase() === 'undo');
  if (at >= 0) ctx.showConsoleTab(at);
  else ctx.addConsoleTab('undo');
  ctx.setConsole(ed.fromText(script));
  const elsewhere = ctx.session && ctx.session.database !== snapshot.database ? ` It ran on ${snapshot.database}, and you're on ${ctx.session.database}: /use ${snapshot.database} first.` : '';
  ctx.note(`The script that undoes it is in the console tab undo: read it, then R runs it.${elsewhere}`, elsewhere ? 'error' : 'ok');
}

/**
 * m in Results and /more: the query behind the result set on screen again, when the row limit cut
 * it off, with the limit raised by another limit's worth (500, 1000, 1500…), in place of the rows on
 * screen so the cursor, the sort and the filter stay. Only reads run again (more.js moreQuery).
 */
export async function moreRows(ctx) {
  const res = ctx.results;
  if (!needSession(ctx)) return;
  const index = ctx.resultIndex ?? 0;
  const m = moreQuery(res, index, { step: ctx.config.limit, dialect: dialectOf(ctx.session).kind });
  if (m.reason) return ctx.note(m.reason, 'error');
  if (res.conn !== ctx.session.conn.name || res.database !== ctx.session.database) return ctx.note(`These rows came from ${res.conn} (${res.database}); connect there again to fetch more.`, 'error');
  const { changes } = ctx;
  if (hasChanges(changes)) return ctx.note(`Save (s) or undo (U) the ${changesText(changes)} first: the rows are read again.`, 'error');
  // A title with Trawl's TOP in it says the new one.
  const title = (m.top && raiseTop(res.title ?? '', res.top, m.top)) || res.title;
  return ctx.query(m.sql, { title, limit: m.limit, top: m.top ?? null, again: { id: res.id, index } });
}

/**
 * Saves the edits staged in Results: shows the script, asks, then runs it through runSql (so a
 * read-only connection refuses it and production keeps it in a transaction until /commit). On
 * Postgres and MySQL the script depends on whether a transaction will be open when it runs (one is,
 * or runSql starts one for manual commit): then it keeps to a savepoint, which a failure goes back to.
 */
export async function saveEdits(ctx) {
  const res = ctx.results;
  const { changes } = ctx;
  if (!hasChanges(changes)) return ctx.note('Nothing to save: e edits a cell, n makes it NULL, d marks a row to delete, a adds one.');
  const { session } = ctx;
  if (!session || session.conn.name !== res.conn || session.database !== res.database) return ctx.note(`These rows came from ${res.conn} (${res.database}); connect there again to save them.`, 'error');
  const { table } = res.edit;
  const transaction = Boolean(ctx.tranCount) || commitMode(session.conn) === 'manual';
  let script;
  try {
    script = saveScript(res.edit, res.sets[0], changes, { transaction });
  } catch (e) {
    return ctx.note(e.message, 'error');
  }
  const what = changesText(changes);
  ctx.showText(`Save to ${objectName(table)}`, script);
  const ok = await ctx.confirm({
    title: `Save ${what} to ${objectName(table)} on ${session.conn.name}${session.conn.prod ? ' (production)' : ''}?`,
    detail: `The script is above (pgup/pgdn scroll it). Each change must find exactly its row, unchanged since it was read${changes.inserts?.length ? ', and each new row go in as one' : ''}, or nothing is saved.`,
    scrollsOverlay: true,
    options: YES_NO('Yes, save'),
    danger: changes.deletes.size > 0 || Boolean(session.conn.prod),
  });
  ctx.closeOverlay();
  if (!ok) return;
  const r = await runSql(ctx, script, { title: `save ${what} to ${objectName(table)}`, keep: true, recover: saveRecovery(res.edit, { transaction }) });
  // On a failure, nothing was saved: the changes stay staged to fix or undo.
  if (!r?.ok || ctx.results !== res) return;
  ctx.replaceResults({ ...res, sets: [withSaved(res.sets[0], changes, res.edit)] });
  // New rows get their identity and default values from the server, so the query runs again to show them.
  if (changes.inserts?.length) await ctx.query(res.sql, { title: res.title, stay: true });
}

/**
 * v in Results and /cell: the whole value of the cell under the cursor in a viewer, JSON
 * pretty-printed, XML indented, binary as hex and long text folded to the width (cell.js).
 */
export function showCell(ctx) {
  const c = ctx.cellOnScreen;
  if (!c) return ctx.note('Put the cursor on a cell in Results first: v there shows its whole value.', 'error');
  const name = c.set.columns[c.col].name;
  if (c.isDefault) return ctx.note(`${name} has no value in this new row: it gets the column's default when saved.`);
  const { text, kind } = cellText(c.value, Math.max(20, c.width - 4));
  const v = c.value;
  const size = typeof v === 'string' ? `${v.length.toLocaleString('en-US')} character${v.length === 1 ? '' : 's'}` : Buffer.isBuffer(v) ? `${v.length.toLocaleString('en-US')} byte${v.length === 1 ? '' : 's'}` : '';
  const about = [kind === 'json' ? 'JSON' : kind === 'xml' ? 'XML' : '', size, c.edited ? 'not saved' : ''].filter(Boolean).join(', ');
  ctx.showText(`${name} · ${c.label}${about ? ` · ${about}` : ''}`, text);
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
  const r = followTargets(res.source, res.sets[0], cell.row, cell.col, ctx.schema, { limit: ctx.config.limit, quote: d.quote, selectTop: d.selectTop, kind: d.kind });
  if (r.reason) return ctx.note(r.reason, 'error');
  let pick = r.targets[0];
  if (r.targets.length > 1) {
    pick = await ctx.confirm({ title: 'Follow which foreign key?', options: [...r.targets.map((t) => ({ label: `${t.label} (${t.fk})`, value: t })), { label: 'Neither', value: null }] });
    if (!pick) return;
  }
  return runSql(ctx, pick.sql, { top: ctx.config.limit });
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
  const tunnel = conn.ssh ? ` Through ssh ${sshText(conn.ssh)}, which signs in with a key or your ssh agent (no password prompt).` : '';
  ctx.note(`${replaced ? 'Updated' : 'Added'} ${conn.name}${conn.folder ? ` in ${conn.folder}/` : ''}${conn.prod ? ' (production, read-only)' : ''}. ${signIn}${tunnel} /connect ${conn.name}`, 'ok');
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
  return runSql(ctx, selectTopFor(dialectOf(ctx.session), obj.schema, obj.name, ctx.config.limit), { top: ctx.config.limit });
}

export function describe(ctx, text) {
  if (!needSession(ctx)) return;
  if (!text) return ctx.prefill('/describe ');
  const obj = typeof text === 'string' ? findObject(ctx.schema, text) : text;
  if (!obj) return ctx.note(`No table or view called ${text} in ${ctx.session.database}.`, 'error');
  ctx.showText(objectName(obj), describeObject(obj, ctx.schema));
}

// A view's, procedure's, function's or trigger's own CREATE text, from the server, or null. `sql`
// asks another way (MySQL's SHOW CREATE TABLE).
async function readDefinition(session, obj, signal, sql) {
  const dialect = dialectOf(session);
  const set = (await session.run(sql ?? (dialect.kind === 'sqlserver' ? definitionSql(obj) : definitionSqlFor(dialect, obj)), { signal, limit: 1 })).sets[0];
  // MySQL's SHOW CREATE answers with the name first and the text in a "Create …" column (a
  // trigger's in "SQL Original Statement").
  const at = Math.max(0, set?.columns.findIndex((c) => /^(create |sql original statement)/i.test(c.name)) ?? 0);
  const definition = set?.rows[0]?.[at] ?? null;
  return definition == null ? null : String(definition).replace(/\r\n?/g, '\n').trim();
}

/**
 * /script <name> and c in the Explorer: the object's CREATE script, into the console to edit. A table's
 * is written from the catalog; a view's, procedure's, function's or trigger's is the server's own text.
 * `find` (from /grep) selects the first place it has that text, rather than starting to type.
 */
export async function scriptObject(ctx, text, { find } = {}) {
  if (!(await liveSession(ctx))) return;
  if (!text) return ctx.prefill('/script ');
  const obj = typeof text === 'string' ? findObject(ctx.schema, text) : text;
  if (!obj) return ctx.note(`Nothing called ${text} in ${ctx.session.database}.`, 'error');
  const dialect = dialectOf(ctx.session);
  if (obj.kind === 'table') return ctx.editInConsole(createTableScript(obj, ctx.schema, { quote: dialect.quote, identity: dialect.identity }));
  let definition = null;
  const r = await ctx.task(
    `script ${objectName(obj)}`,
    async (signal) => {
      definition = await readDefinition(ctx.session, obj, signal);
      return [definition ? 'In the console.' : "The server gave no definition: it may be encrypted, or the login can't VIEW DEFINITION."];
    },
    { label: 'Reading the definition' },
  );
  if (r.ok && definition) ctx.editInConsole(definition, { find });
}

/**
 * /grep <text>: every view, procedure, function and trigger in the database whose definition has the
 * text in it (ignoring case), as Redgate's SQL Search does, filtered on the server. A list to pick from:
 * ↵ puts the object's CREATE script in the console with the first match selected (n, N: the others).
 */
export async function grepDefinitions(ctx, text) {
  if (!needSession(ctx)) return;
  const query = String(text ?? '').trim();
  if (!query) return ctx.prefill('/grep ');
  const session = ctx.session;
  let hits = null;
  const r = await ctx.task(
    `grep ${query}`,
    async (signal) => {
      hits = grepHits((await session.run(dialectOf(session).grepSql(query), { signal, limit: 100_000 })).sets, query);
      return [hits.length ? `${hits.length} object${hits.length === 1 ? '' : 's'} with "${query}" in ${hits.length === 1 ? 'its definition' : 'their definitions'}.` : `No view, procedure, function or trigger has "${query}" in it.`];
    },
    { label: `Searching the definitions for "${query}"` },
  );
  if (!r.ok || !hits) return;
  showGrep(ctx, query, hits, session.database);
}

const matches = (n) => `${n} match${n === 1 ? '' : 'es'}`;

function showGrep(ctx, query, hits, database) {
  const items = hits.map((h) => {
    const first = h.lines[0];
    const w = String(h.lines.at(-1).line).length;
    return {
      label: `${h.schema}.${h.name}`,
      // The line first, as it's what a narrow list has room for; the kind is on the right.
      detail: `${matches(h.count)} · ${first.line}: ${first.text}`,
      text: [`A ${h.kind}${h.parent ? ` on ${h.parent}` : ''}: ${matches(h.count)} on ${h.lines.length === 1 ? 'this line' : `these ${h.lines.length} lines`}.`, '', ...h.lines.map((l) => `${String(l.line).padStart(w)}  ${l.text}`)].join('\n'),
      hit: h,
    };
  });
  ctx.showPicker({
    title: `"${query}" in ${database}'s definitions`,
    hint: '↵ its CREATE script, at the match',
    items,
    empty: `No view, procedure, function or trigger in ${database} has "${query}" in it.`,
    keys: {
      return: (it) => scriptObject(ctx, { schema: it.hit.schema, name: it.hit.name, kind: it.hit.kind }, { find: query }),
    },
  });
}

/**
 * /uses <object> and u in the Explorer: what refers to it (views, routines, triggers, and tables by
 * their foreign keys) and what it refers to, grouped by kind, in the viewer. SQL Server's come from
 * its dependency catalog; Postgres and MySQL record less, and the rest is found by name.
 */
export async function showUses(ctx, text) {
  if (!needSession(ctx)) return;
  if (!text) return ctx.prefill('/uses ');
  const obj = typeof text === 'string' ? findObject(ctx.schema, text) : text;
  if (!obj) return ctx.note(`Nothing called ${text} in ${ctx.session.database}.`, 'error');
  const session = ctx.session;
  const dialect = dialectOf(session);
  const byName = dialect.usesByName;
  let report = null;
  const r = await ctx.task(
    `what uses ${objectName(obj)}`,
    async (signal) => {
      const rows = (await session.run(dialect.usesSql(obj), { signal, limit: 100_000 })).sets.flatMap(rowsOf);
      let named = [];
      let own = null;
      if (byName) {
        named = (await session.run(dialect.grepSql(obj.name), { signal, limit: 100_000 })).sets.flatMap(rowsOf);
        if (byName.uses.includes(obj.kind)) own = await readDefinition(session, obj, signal).catch((e) => (e.cancelled ? Promise.reject(e) : null));
      }
      report = usesReport(obj, ctx.schema, { rows, named, own, byName });
      return [usesSummary(report)];
    },
    { label: `Finding what uses ${objectName(obj)}` },
  );
  if (!r.ok || !report) return;
  const title = `Uses: ${objectName(obj)}`;
  const body = usesText(obj, report, { database: session.database, label: dialect.label, byName });
  ctx.rememberOutput(title, body);
  ctx.showText(title, body);
}

/**
 * /stats [on|off]: SET STATISTICS IO and TIME for the session, so each run says how many pages it
 * read from which table and how long the server spent (as one line). With nothing, it toggles.
 */
export async function setStats(ctx, mode) {
  if (!(await liveSession(ctx))) return;
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
  if (!(await liveSession(ctx))) return;
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

// The savepoint a write's EXPLAIN ANALYZE is rolled back to inside a transaction already open.
const PLAN_SAVEPOINT = 'trawl_plan';

/**
 * P in the console and /plan actual [sql]: the actual plan, of the SQL given, the selection or the
 * statement under the cursor. The statement runs, so it goes through runSql's checks (read-only,
 * risky statements, manual commit) like any run, and lands in History.
 *
 * SQL Server: with SET STATISTICS PROFILE on (and off again whatever happens), each statement's rows
 * go to Results as usual, followed by a set of its operators with the rows each really produced,
 * which plans.js turns into the tree. The rows are read to the end (past the limit, dropped), so the
 * counts are whole. Postgres and MySQL: EXPLAIN ANALYZE, which runs the statement but sends no rows.
 * There it always runs in a transaction that is rolled back (back to a savepoint when one is open,
 * which then stays as it was), whatever the commit mode: EXPLAIN ANALYZE is for looking at the plan,
 * and nothing on screen would show what a write changed. Running the statement itself applies it.
 */
export async function showActualPlan(ctx, sql) {
  if (!needSession(ctx)) return;
  const pick = sql?.trim() ? { text: sql.trim() } : consolePick(ctx);
  if (!pick?.text) return ctx.note('Nothing to run: give the SQL (/plan actual SELECT …) or put the cursor on a statement in the console.', 'error');
  const session = ctx.session;
  const dialect = dialectOf(session);
  let plan = null;
  let ran = null;
  const run = async (text, { write, wrap, title }) => {
    ran = text;
    if (dialect.kind === 'sqlserver') {
      const runner = async (s, script, opts) => {
        await s.run('SET STATISTICS PROFILE ON;', { signal: opts.signal });
        try {
          const split = splitProfile(await s.run(script, { ...opts, drain: true }));
          plan = split.plan;
          return split.res;
        } catch (e) {
          if (e.partial) e.partial = splitProfile(e.partial).res;
          throw e;
        } finally {
          await s.run('SET STATISTICS PROFILE OFF;').catch(() => {});
        }
      };
      return ctx.query(wrap ? `${dialect.begin}\n${text}` : text, { title, wrapped: wrap, lineBase: pick.lineBase, stay: pick.lineBase != null, runner });
    }
    // Always rolled back (a read can call a function that writes, too); inside an open transaction,
    // only back to the savepoint, so the transaction stays as it was.
    const inTran = Boolean(ctx.tranCount);
    const runner = async (s, script, opts) => {
      await s.run(inTran ? `SAVEPOINT ${PLAN_SAVEPOINT};` : dialect.begin, { signal: opts.signal });
      try {
        const res = await s.run(script, { ...opts, limit: 100_000 });
        plan = analyzedText(res.sets);
        return { ...res, sets: [], messages: [...res.messages, ...(write ? ['Rolled back: EXPLAIN ANALYZE ran it to measure it, and nothing it changed was kept.'] : [])] };
      } catch (e) {
        if (dialect.kind === 'mysql' && /syntax|doesn't yet support|not supported/i.test(e.message)) e.message = `${e.message}\nEXPLAIN ANALYZE needs MySQL 8.0.18 or later, and takes SELECT, multi-table UPDATE and DELETE (MariaDB has ANALYZE instead); p shows the estimated plan.`;
        throw e;
      } finally {
        await s.run(inTran ? `ROLLBACK TO SAVEPOINT ${PLAN_SAVEPOINT};` : dialect.rollback).catch(() => {});
      }
    };
    return ctx.query(dialect.explainAnalyze(text), { title, lineBase: pick.lineBase, keep: true, runner });
  };
  const text = pick.text;
  const title = `Actual plan: ${oneLine(withoutLeadingComments(text))}`;
  const r = await runSql(ctx, text, { title, run });
  if (!r?.ok) return;
  if (!plan) return ctx.note(dialect.kind === 'sqlserver' ? 'The server sent no plan: nothing in it reads or writes a table (SET, DECLARE, PRINT), or it ran a procedure whose statements gave none.' : 'The server sent no plan.', 'error');
  const how = dialect.kind === 'sqlserver' ? 'STATISTICS PROFILE' : 'EXPLAIN ANALYZE';
  ctx.lastPlan = { sql: ran ?? text, plan, conn: session.conn.name, database: session.database, label: dialect.label, how, actual: true };
  ctx.showText(title, plan, { keys: { a: () => explainPlan(ctx) }, hint: 'a Claude explains it' });
  ctx.rememberOutput(title, plan);
}

/** The console's selection, or the statement under its cursor, with the line it starts on. */
function consolePick(ctx) {
  const e = ctx.console;
  const sel = ed.selectedText(e);
  if (sel?.text.trim()) return { text: sel.text, lineBase: sel.row + 1 };
  const st = statementAt(splitStatements(ed.toText(e)), e.row + 1);
  return st ? { text: st.text, lineBase: st.line } : null;
}

/**
 * a on a plan, and /explain: Claude reads the last plan with its query (never rows) and says what it
 * does, what costs the most and what might help. Refused on a connection closed to Claude.
 */
export async function explainPlan(ctx) {
  const p = ctx.lastPlan;
  if (!p) return ctx.note('Show a plan first: p (or P, the actual plan) in the console, or /plan <sql>.', 'error');
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
  if (!(await liveSession(ctx))) return;
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

// On Postgres a statement that fails spoils the transaction it's in, so with one open each of
// /health's reads goes inside a savepoint of its own.
const HEALTH_SAVEPOINT = 'trawl_health';

/**
 * /health: a check-up of the database you're in, as Splice's /cleanup is of a repository: what the
 * server suggests or shows (missing and unused indexes, duplicates, foreign keys without an index,
 * tables without a primary key, untrusted constraints, stale statistics, disabled triggers; the
 * kinds have some each, health.js CHECKS), each with why, in the viewer. Then it offers the fixes,
 * all of them or one group's, in a console tab of their own to read through; nothing runs by itself.
 * A read that fails (a permission it needs) only says so in its group.
 */
export async function healthCheck(ctx) {
  if (!needSession(ctx)) return;
  const session = ctx.session;
  const dialect = dialectOf(session);
  const guarded = dialect.kind === 'postgres' && Boolean(ctx.tranCount);
  let report = null;
  const r = await ctx.task(
    `health check of ${session.database}`,
    async (signal) => {
      const results = {};
      for (const [id, sql] of Object.entries(dialect.health)) {
        try {
          if (guarded) await session.run(`SAVEPOINT ${HEALTH_SAVEPOINT};`, { signal });
          results[id] = { sets: (await session.run(sql, { signal, limit: 100_000 })).sets };
          if (guarded) await session.run(`RELEASE SAVEPOINT ${HEALTH_SAVEPOINT};`, { signal });
        } catch (e) {
          if (e.cancelled || signal.aborted) throw e;
          if (guarded) await session.run(`ROLLBACK TO SAVEPOINT ${HEALTH_SAVEPOINT};`).catch(() => {});
          results[id] = { error: e.message.split('\n')[0] };
        }
      }
      report = buildHealth(results, { kind: dialect.kind, quote: dialect.quote });
      return [healthSummary(report)];
    },
    { label: `Checking ${session.database}` },
  );
  if (!r.ok || !report) return;
  const where = { database: session.database, conn: session.conn.name };
  const title = `Health: ${session.conn.name}/${session.database}`;
  const text = healthText(report, where);
  ctx.rememberOutput(title, text);
  ctx.showText(title, text);
  const groups = fixableGroups(report);
  if (!groups.length) return;
  const n = (g) => g.findings.length;
  const lower = (t) => t[0].toLowerCase() + t.slice(1);
  const pick = await ctx.confirm({
    title: 'Put the fixes in a console tab of their own?',
    detail: 'The report is above (pgup/pgdn scroll it). Nothing runs; dropping an index or turning a trigger on comes commented out.',
    scrollsOverlay: true,
    options: [
      { label: `Yes, all of them (${groups.reduce((s, g) => s + n(g), 0)})`, value: 'all' },
      ...(groups.length > 1 ? groups.map((g) => ({ label: `Only ${lower(g.title)} (${n(g)})`, value: g.id })) : []),
      { label: 'No', value: null },
    ],
  });
  ctx.closeOverlay();
  if (!pick) return;
  const script = healthScript(report, { ...where, groups: pick === 'all' ? null : [pick] });
  const name = freeName(ctx.consoleTabs.names.map((x) => ({ name: x })), 'health');
  ctx.addConsoleTab(name);
  ctx.setConsole(ed.fromText(script));
  ctx.note(`The fixes are in the console tab ${name}: read them through, then ctrl+r runs the statement under the cursor.`, 'ok');
}

/**
 * /sizes: every table in the database with its rows and the space it takes (reserved, data,
 * indexes, and what each kind has besides), biggest first, as a result set in Results, where o
 * sorts, f filters and x exports it. Postgres's row counts and all of MySQL's are estimates.
 */
export async function showSizes(ctx) {
  if (!needSession(ctx)) return;
  const session = ctx.session;
  const dialect = dialectOf(session);
  const title = `Table sizes: ${session.database}`;
  const started = Date.now();
  let set = null;
  const r = await ctx.task(
    title,
    async (signal) => {
      set = buildSizes((await session.run(dialect.sizesSql, { signal, limit: 1_000_000 })).sets);
      return [`${set.rows.length} table${set.rows.length === 1 ? '' : 's'}, biggest first`];
    },
    { label: 'Reading the table sizes' },
  );
  if (!r.ok || !set) return;
  ctx.present({ title, sql: dialect.sizesSql, sets: [set], messages: [dialect.sizesNote], ms: Date.now() - started, edit: { reason: 'the sizes come from the catalog' }, conn: session.conn.name, database: session.database });
}

// The most /deadlocks lists.
const DEADLOCKS_SHOWN = 50;

/**
 * /deadlocks: the server's recent deadlocks (deadlocks.js has where each kind keeps them), newest
 * first. One is shown in the viewer; several are a list, ↵ showing one. Each is drawn as a tree from
 * the victim, through whose lock each one wanted, with every session's SQL and the locks under it.
 */
export async function showDeadlocks(ctx) {
  if (!needSession(ctx)) return;
  const session = ctx.session;
  const d = dialectOf(session).deadlocks;
  let found = null;
  const r = await ctx.task(
    'read the recent deadlocks',
    async (signal) => {
      const probe = d.probe ? (rowsOf((await session.run(d.probe, { signal, limit: 10 })).sets[0])[0] ?? {}) : {};
      const plan = d.plan(probe);
      if (plan.unavailable) return (found = { unavailable: plan.unavailable }), [plan.unavailable];
      let error = null;
      // The first place that can be read is the answer, even with none in it.
      for (const src of plan.sources) {
        try {
          const sets = (await session.run(src.sql, { signal, limit: 10_000 })).sets;
          const list = (src.parse === 'innodb' ? buildInnodbDeadlocks(sets) : buildDeadlocks(sets)).slice(0, DEADLOCKS_SHOWN);
          found = { list, source: DEADLOCK_SOURCES[src.id] };
          return [list.length ? `${list.length} deadlock${list.length === 1 ? '' : 's'} from ${found.source}.` : `No deadlocks in ${found.source}.`];
        } catch (e) {
          if (e.cancelled || signal.aborted) throw e;
          error ??= e;
        }
      }
      throw error;
    },
    { label: 'Reading the recent deadlocks' },
  );
  if (!r.ok || !found) return;
  // Why there's nothing to read here is longer than the activity log's line.
  if (found.unavailable) return ctx.showText('Deadlocks', wrap(found.unavailable, 96).join('\n'));
  if (!found.list.length) return;
  // To the minute in the list; the viewer has the seconds.
  const items = found.list.map((x) => ({ label: deadlockTime(x).replace(/(\d\d:\d\d):\d\d/, '$1'), detail: deadlockSummary(x), text: deadlockText(x), title: `Deadlock ${deadlockTime(x)}` }));
  const show = (it) => {
    ctx.rememberOutput(it.title, it.text);
    ctx.showText(it.title, it.text);
  };
  if (items.length === 1) return show(items[0]);
  ctx.showPicker({ title: 'Deadlocks, newest first', hint: '↵ the deadlock in full', items, keys: { return: show } });
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
 * /why: Claude explains the last run's error from the server (its message, number and line, the SQL
 * around it) with the schema's names, never rows, and the corrected statement goes into the console
 * under the explanation as comments. Nothing runs. Refused on a connection closed to Claude.
 */
export async function why(ctx) {
  const err = ctx.lastError;
  if (!err) return ctx.note('Nothing to explain: /why is for the last run, when the server turned it down with an error.', 'error');
  const conn = ctx.config.connections.find((c) => c.name === err.conn) ?? ctx.session?.conn;
  if (!canSeeSchema(conn)) return ctx.note(`${err.conn} is closed to Claude. /ai schema lets Claude see its names, SQL and errors (never rows).`, 'error');
  const schema = ctx.schema && ctx.session?.conn.name === err.conn && ctx.schema.database === err.database ? ctx.schema : null;
  const prompt = whyPrompt({ ...err, schema });
  const first = err.message.split('\n')[0];
  let answer = null;
  const r = await ctx.task(
    `ask Claude why: ${first}`,
    async (signal) => {
      answer = parseAnswer(await ctx.askClaude({ prompt, system: WHY_SYSTEM, signal }));
      return answer.sql ? ['A corrected statement is in the console, with why as comments: read it, then ctrl+r runs it.', ...(answer.note ? [answer.note] : [])] : [answer.note || 'Claude gave no answer.'];
    },
    { label: 'Asking Claude what went wrong' },
  );
  if (!r.ok || !answer) return;
  if (answer.sql) return ctx.editInConsole(whyConsoleText({ message: err.message, ...answer }));
  if (answer.note) {
    ctx.showText(`Claude on: ${first}`, answer.note);
    ctx.rememberOutput(`Claude on: ${first}`, answer.note);
  }
}

/**
 * /watch <seconds> [sql] [--until <condition>]: runs a read again every few seconds (2 at least), in
 * Results with what changed since the run before picked out, until esc, another run or the condition
 * (watch.js) matching a row. Without SQL, the console's selection or the statement under its cursor.
 * /watch stop ends it.
 */
export async function watch(ctx, rest) {
  const w = parseWatch(rest);
  if (w.stop) return ctx.watching ? ctx.stopWatch('/watch stop') : ctx.note('Nothing is being watched.');
  if (w.empty) return ctx.prefill('/watch ');
  if (w.error) return ctx.note(w.error, 'error');
  await ctx.stopWatch(ctx.watching ? 'another watch' : null);
  if (!(await liveSession(ctx))) return;
  const sql = w.sql || consoleStatement(ctx);
  if (!sql) return ctx.note('Nothing to watch: /watch <seconds> <sql>, or put the cursor on a statement in the console.', 'error');
  const text = await withParameters(ctx, sql);
  if (text == null) return;
  const { write } = classifyScript(text, { dialect: dialectOf(ctx.session).kind });
  if (write) return ctx.note('/watch only runs reads, and this changes data or schema: run it once with ctrl+r instead.', 'error');
  return ctx.startWatch({ sql: text, every: w.seconds, until: w.until, title: oneLine(withoutLeadingComments(text)) });
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
    built = csvInsertScript(parseCsv(await readFile(full, 'utf8')), table, d.kind === 'sqlserver' ? {} : { quote: d.quote, kind: d.kind });
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

const COPY_FORMATS = ['tsv', 'csv', 'json', 'md', 'insert'];

/**
 * /copy [tsv|csv|json|md|insert]: the result set on screen, on the clipboard. Tab-separated (the
 * default) pastes into a spreadsheet as cells; md is a Markdown table; insert gives INSERT
 * statements for the table.
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
  const text = f === 'csv' ? toCsv(set) : f === 'json' ? toJson(set) : f === 'md' ? toMarkdown(set) : f === 'insert' ? insertScript(set, table, { quote: d.quote, kind: d.kind }) : tsvText(set);
  const n = `${set.rows.length} row${set.rows.length === 1 ? '' : 's'}`;
  return ctx.copy(text, f === 'tsv' ? `${n}, tab-separated` : f === 'insert' ? `${n} as INSERT statements${source ? '' : ` (into ${table}: rename it)`}` : f === 'md' ? `${n} as a Markdown table` : `${n} as ${f.toUpperCase()}`);
}

const EXPORTS = { '.csv': toCsv, '.json': toJson, '.md': toMarkdown, '.markdown': toMarkdown };

/** Writes the result set on screen to a .csv, .json or .md (a Markdown table) file. */
export async function exportResults(ctx, path) {
  const set = ctx.currentSet();
  if (!set) return ctx.note('Run a query first: there is nothing to export.', 'error');
  if (!path) return ctx.prefill('/export ');
  const full = resolve(path);
  const format = EXPORTS[extname(full).toLowerCase()];
  if (!format) return ctx.note('Export to a .csv, .json or .md file.', 'error');
  try {
    await writeFile(full, format(set), 'utf8');
    ctx.note(`Wrote ${set.rows.length} row${set.rows.length === 1 ? '' : 's'} to ${full}${set.truncated ? ` (only the first ${set.rows.length}: raise /limit for more)` : ''}`, 'ok');
  } catch (e) {
    ctx.note(`Couldn't write ${full}: ${e.message}`, 'error');
  }
}

const firstLine = (s) => String(s ?? '').split('\n')[0];
const plural = (n, what) => `${n.toLocaleString('en')} ${what}${n === 1 ? '' : 's'}`;
const pathArg = (s) => String(s ?? '').trim().replace(/^"(.*)"$/, '$1');

// Every file under `root` in /script-all's layout (<schema>/<Tables|Views|…>/<name>.sql), as a Map of
// its path (with /) to its text.
function readLayout(root) {
  const out = new Map();
  let schemas = [];
  try {
    schemas = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const s of schemas) {
    for (const dir of Object.values(KIND_DIRS)) {
      let files = [];
      try {
        files = readdirSync(join(root, s.name, dir), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const f of files) if (f.isFile() && /\.sql$/i.test(f.name)) out.set(`${s.name}/${dir}/${f.name}`, readFileSync(join(root, s.name, dir, f.name), 'utf8'));
    }
  }
  return out;
}

/**
 * /script-all <folder>: every table, view, procedure, function and trigger of the database in a file
 * of its own under the folder (<schema>/Tables/<name>.sql and so on), for keeping the schema in git.
 * Only files whose text changed are written. Files in that layout whose objects are gone are listed,
 * and removed only after asking.
 */
export async function scriptAll(ctx, rest) {
  if (!needSession(ctx)) return;
  const folder = pathArg(rest);
  if (!folder) return ctx.prefill('/script-all ');
  const root = resolve(folder);
  const session = ctx.session;
  const dialect = dialectOf(session);
  let done = null;
  const r = await ctx.task(
    `script ${session.database} into ${root}`,
    async (signal) => {
      const read = async (sql) => (await session.run(sql, { signal, limit: 1_000_000 })).sets;
      const schema = buildSchema(await read(dialect.schemaSql));
      const modules = rowsOf((await read(dialect.grepSql('')))[0]);
      let extras = null;
      let creates = null;
      let note = null;
      if (dialect.kind === 'mysql') {
        // MySQL writes its own CREATE for each object, tables included; the catalog only has bodies.
        creates = new Map();
        for (const o of scriptedObjects(schema, modules)) {
          const sql = o.kind === 'table' ? `SHOW CREATE TABLE ${qualifiedFor(dialect, o.schema, o.name)};` : undefined;
          const text = await readDefinition(session, o, signal, sql).catch((e) => (e.cancelled ? Promise.reject(e) : null));
          if (text) creates.set(createKey(o.kind, o.schema, o.name), o.kind === 'table' ? withoutAutoIncrement(text) : text);
        }
      } else {
        try {
          extras = buildTableExtras(await read(EXTRAS_SQL[dialect.kind]));
        } catch (e) {
          if (e.cancelled) throw e;
          note = `The defaults, checks and indexes couldn't be read (${firstLine(e.message)}), so the tables have their columns and keys only.`;
        }
      }
      const { files, skipped } = scriptFiles({ schema, extras, modules, dialect, creates });
      const plan = planFiles(files, readLayout(root), { keep: skipped.map((x) => x.path) });
      for (const f of plan.written) {
        const full = join(root, ...f.path.split('/'));
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, f.text, 'utf8');
      }
      done = { plan, skipped, note, database: session.database };
      return [summaryLine(plan), ...(plan.stale.length ? [`${plural(plan.stale.length, 'file')} of objects that are gone: asking before removing them.`] : [])];
    },
    { label: `Scripting ${session.database}` },
  );
  if (!r.ok || !done) return;
  const { plan } = done;
  const removed = [];
  let kept = [];
  if (plan.stale.length) {
    ctx.showText(`Files of objects no longer in ${done.database}`, plan.stale.map((p) => `  - ${p}`).join('\n'));
    const ok = await ctx.confirm({
      title: `Remove ${plural(plan.stale.length, 'file')} whose object${plan.stale.length === 1 ? ' is' : 's are'} gone from ${done.database}?`,
      detail: `The list is above (pgup/pgdn scroll it): files in Trawl's layout under ${root} that no table, view, routine or trigger has now.`,
      scrollsOverlay: true,
      options: YES_NO('Yes, remove them'),
    });
    ctx.closeOverlay();
    if (ok) {
      for (const p of plan.stale) {
        const full = join(root, ...p.split('/'));
        try {
          unlinkSync(full);
          removed.push(p);
        } catch (e) {
          ctx.note(`Couldn't remove ${full}: ${firstLine(e.message)}`, 'error');
          continue;
        }
        // A folder left empty goes too: the kind's, then the schema's.
        for (const dir of [dirname(full), dirname(dirname(full))]) {
          try {
            rmdirSync(dir);
          } catch {
            break;
          }
        }
      }
    } else kept = plan.stale;
  }
  const title = `Script all: ${done.database} → ${root}`;
  const text = summaryText(plan, { database: done.database, folder: root, removed, kept, skipped: done.skipped, note: done.note });
  ctx.rememberOutput(title, text);
  ctx.showText(title, text);
  if (removed.length) ctx.note(`${summaryLine(plan, removed.length)} in ${root}.`, 'ok');
}

// The migration scripts under a folder (and EF Core's .cs migrations), with paths relative to it.
function migrationFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!/^(\.git|node_modules|bin|obj)$/i.test(e.name)) walk(join(dir, e.name), path);
      } else if (/\.(sql|cs)$/i.test(e.name)) out.push({ path, text: readFileSync(join(dir, e.name), 'utf8').replace(/^﻿/, '') });
    }
  };
  walk(root, '');
  return out;
}

// The folder and the history it's compared with: { history, rows, columns, status, files, database }, or null.
async function readMigrations(ctx, root) {
  const session = ctx.session;
  const dialect = dialectOf(session);
  let files;
  try {
    if (!statSync(root).isDirectory()) throw Object.assign(new Error('not a folder'), { code: 'ENOTDIR' });
    files = migrationFiles(root);
  } catch (e) {
    ctx.note(`${root}: ${e.code === 'ENOENT' ? 'no such folder' : e.code === 'ENOTDIR' ? 'not a folder' : firstLine(e.message)}`, 'error');
    return null;
  }
  let out = null;
  const r = await ctx.task(
    `migrations in ${root}`,
    async (signal) => {
      const found = rowsOf((await session.run(probeSql(dialect.kind), { signal, limit: 100 })).sets[0]);
      const history = pickHistory(found, { sqlserver: 'dbo', postgres: 'public' }[dialect.kind] ?? session.database);
      let rows = [];
      let columns = [];
      if (!history.missing) {
        const set = (await session.run(historySql(dialect, history), { signal, limit: 1_000_000 })).sets[0];
        rows = rowsOf(set);
        columns = set?.columns.map((c) => c.name) ?? [];
      }
      const status = migrationStatus({ tool: history.tool, files, rows });
      if (history.missing && files.some((f) => parseFlywayName(f.path.split('/').at(-1))?.prefix === 'V')) {
        status.notes.unshift(`These look like Flyway's, but ${session.database} has no flyway_schema_history, so Trawl keeps its own ${TOOLS.plain.table} for them; flyway baseline (or migrate) once makes Flyway's.`);
      }
      out = { history, rows, columns, status, files, database: session.database };
      return [`${TOOLS[history.tool].label}: ${status.pending.length} pending of ${plural(files.length, 'file')}`];
    },
    { label: 'Reading the migrations', quiet: true },
  );
  return r.ok ? out : null;
}

function showMigrationStatus(ctx, root, m) {
  // The folder by name: its whole path is in the text below, and in the title it would crowd out R's hint.
  const title = `Migrations: ${basename(root)}`;
  const text = statusText(m.status, { database: m.database, folder: root, history: m.history, files: m.files.length });
  ctx.rememberOutput(title, text);
  const n = m.status.pending.length;
  ctx.showText(title, text, m.status.runnable && n ? { keys: { R: () => runMigrations(ctx, root) }, hint: `R runs the ${n} pending (/migrations run)` } : {});
}

/**
 * /migrations [run] <folder>: the folder's migration scripts against the database's history table
 * (Flyway, EF Core, DbUp, or Trawl's own): what's applied, pending, changed or missing. R there, or
 * /migrations run, runs the pending ones in order. With run and no folder, the last one shown.
 */
export async function migrations(ctx, rest) {
  if (!needSession(ctx)) return;
  const args = splitArgs(rest);
  const run = args[0]?.toLowerCase() === 'run';
  const folder = (run ? args.slice(1) : args).join(' ') || (run ? (ctx.migrationsFolder ?? '') : '');
  if (!folder) return run ? ctx.note('Which folder? /migrations run <folder>, or /migrations <folder> to see it first.', 'error') : ctx.prefill('/migrations ');
  const root = resolve(folder);
  ctx.migrationsFolder = root;
  if (run) return runMigrations(ctx, root);
  const m = await readMigrations(ctx, root);
  if (m) showMigrationStatus(ctx, root, m);
}

/**
 * Runs the pending migrations in order, each through runSql's checks (read-only, the questions before
 * risky statements, manual commit) and recorded in the history as its tool would, stopping at the
 * first that fails or is refused. Trawl's own history table is made first, after asking.
 */
export async function runMigrations(ctx, root) {
  if (!needSession(ctx)) return;
  const m = await readMigrations(ctx, root);
  if (!m) return;
  const { status, history } = m;
  if (!status.runnable) return ctx.note(status.notes.at(-1), 'error');
  if (!status.pending.length) return ctx.note(`Nothing pending in ${root}: ${m.database} has them all.`);
  const session = ctx.session;
  const { conn } = session;
  const dialect = dialectOf(session);
  if (isReadOnly(conn) && !ctx.writesAllowed) return ctx.note(`${conn.name} is read-only${conn.prod ? ' (production)' : ''}, and migrations change it. /writes allows writes until you disconnect.`, 'error');
  const n = status.pending.length;
  const odd = status.entries.filter((e) => ['changed', 'missing', 'failed'].includes(e.status)).length;
  const names = status.pending.map((e) => e.script);
  const ok = await ctx.confirm({
    title: `Run ${plural(n, 'pending migration')} on ${conn.name}${conn.prod ? ' (production)' : ''}?`,
    detail: `${odd ? `${odd} applied ${odd === 1 ? 'one is' : 'ones are'} changed, missing or failed, which ${TOOLS[status.tool].label} would stop at. ` : ''}${names.slice(0, 6).join(', ')}${n > 6 ? ` and ${n - 6} more` : ''}, in order, each recorded in ${history.table}; the first that fails stops the rest.`,
    options: YES_NO(`Yes, run ${n === 1 ? 'it' : 'them'}`),
    danger: Boolean(conn.prod) || odd > 0,
  });
  if (!ok) return;
  if (history.missing) {
    const make = await ctx.confirm({
      title: `Make ${TOOLS.plain.table} in ${m.database} to record them?`,
      detail: `Trawl's own history table, in ${history.schema}: each script's name, its checksum, who ran it, when, and how long it took.`,
      options: YES_NO('Yes, make it'),
    });
    if (!make) return;
    const c = await runSql(ctx, createPlainSql(dialect, history.schema), { title: `create ${TOOLS.plain.table}`, keep: true });
    if (!c?.ok) return;
  }
  let rank = nextRank(m.rows);
  let ran = 0;
  for (const [i, e] of status.pending.entries()) {
    const r = await runSql(ctx, e.file.text, {
      title: `migration ${e.script}`,
      keep: true,
      run: async (text, { wrap, title }) => {
        const started = Date.now();
        const q = await ctx.query(wrap ? `${dialect.begin}\n${text}` : text, { title, wrapped: wrap, keep: true });
        if (!q.ok) return q;
        return ctx.query(recordSql(dialect, history, e, { ms: Date.now() - started, rank, columns: m.columns }), { title: `record ${e.script} in ${history.table}`, keep: true });
      },
    });
    if (!r?.ok) {
      const left = n - i - 1;
      ctx.note(`Stopped at ${e.script}${r ? '' : ', which didn’t run'}${left ? `: the ${plural(left, 'migration')} after it didn’t run` : ''}.`, 'error');
      break;
    }
    rank++;
    ran++;
  }
  if (!ran) return;
  if (ctx.tranCount) ctx.note(`Ran ${plural(ran, 'migration')} in an open transaction (${conn.name} commits manually): /commit keeps them, /rollback undoes them.`);
  else ctx.note(`Ran ${plural(ran, 'migration')}, each recorded in ${history.table}.`, 'ok');
  const again = await readMigrations(ctx, root);
  if (again) showMigrationStatus(ctx, root, again);
}

/**
 * /generate <table> [rows] [--seed n]: rows of made-up test data for a table as INSERTs, in a console
 * tab of its own (generate) to read and run; nothing runs by itself. Foreign keys take values the
 * referenced tables have (the first thousand, read in key order), so the same seed gives the same rows.
 */
export async function generateData(ctx, rest) {
  if (!needSession(ctx)) return;
  const args = splitArgs(rest);
  let seed = 1;
  const at = args.findIndex((x) => x.toLowerCase() === '--seed');
  if (at >= 0) {
    const value = args[at + 1];
    if (value == null) return ctx.note('--seed takes a number (or any word): /generate <table> <rows> --seed 42', 'error');
    seed = /^\d+$/.test(value) ? Number(value) : value;
    args.splice(at, 2);
  }
  const [name, many] = args;
  if (!name) return ctx.prefill('/generate ');
  const obj = findObject(ctx.schema, name);
  if (!obj) return ctx.note(`No table called ${name} in ${ctx.session.database}.`, 'error');
  if (obj.kind !== 'table') return ctx.note(`${objectName(obj)} is a ${obj.kind}; /generate writes INSERTs into a table.`, 'error');
  const count = many == null ? 10 : Number(many);
  if (!Number.isInteger(count) || count < 1 || count > 100_000) return ctx.note('How many rows: a whole number from 1 to 100000 (/generate <table> <rows>).', 'error');
  const session = ctx.session;
  const dialect = dialectOf(session);
  const schema = ctx.schema;
  let built = null;
  const r = await ctx.task(
    `generate ${plural(count, 'row')} for ${objectName(obj)}`,
    async (signal) => {
      let unique = [];
      try {
        unique = uniqueColumns(buildTableExtras((await session.run(EXTRAS_SQL[dialect.kind], { signal, limit: 1_000_000 })).sets), obj);
      } catch (e) {
        // Without the indexes, only the primary key is kept unique.
        if (e.cancelled) throw e;
      }
      const refs = [];
      for (const fk of schema.foreignKeys.filter((f) => f.from.toLowerCase() === objectName(obj).toLowerCase())) {
        const set = (await session.run(refValuesSql(dialect, fk), { signal, limit: 1000 })).sets[0];
        const at = fk.columns.map(([, to]) => set?.columns.findIndex((c) => c.name.toLowerCase() === to.toLowerCase()) ?? -1);
        const rows = at.some((i) => i < 0) ? [] : set.rows.slice(0, 1000).map((row) => at.map((i) => row[i]));
        refs.push({ ...fk, rows, capped: rows.length >= 1000 });
      }
      built = generateScript(obj, count, { seed, kind: dialect.kind, quote: dialect.quote, refs, unique });
      return ['The INSERTs are in a console tab of their own (generate): read them, then R runs them.'];
    },
    { label: `Making ${plural(count, 'row')} for ${objectName(obj)}` },
  );
  if (!r.ok || !built) return;
  ctx.addConsoleTab(freeName(ctx.consoleTabs.names.map((n) => ({ name: n })), 'generate'));
  ctx.setConsole(ed.fromText(built.script));
}

/**
 * /scaffold <table> [csharp|ef|ts|python]: the table's or view's columns as a C# class (the default),
 * an EF Core entity, a TypeScript interface or a Python dataclass, shown and copied to the clipboard.
 */
export function scaffoldObject(ctx, rest) {
  if (!needSession(ctx)) return;
  const args = splitArgsLoose(rest);
  if (!args.length) return ctx.prefill('/scaffold ');
  let lang = 'csharp';
  if (args.length > 1) {
    lang = languageOf(args.at(-1));
    if (!lang) return ctx.note(`/scaffold makes ${LANGUAGES.join(', ')} (C# by default), not ${args.at(-1)}.`, 'error');
    args.pop();
  }
  const obj = findObject(ctx.schema, args.join(' '));
  if (!obj || (obj.kind !== 'table' && obj.kind !== 'view')) return ctx.note(`No table or view called ${args.join(' ')} in ${ctx.session.database}.`, 'error');
  const text = scaffold(obj, lang, { kind: dialectOf(ctx.session).kind });
  const title = `${LANGUAGE_NAMES[lang]}: ${objectName(obj)}`;
  ctx.rememberOutput(title, text);
  ctx.showText(title, text);
  return ctx.copy(text, `the ${LANGUAGE_NAMES[lang]} for ${objectName(obj)}`);
}
