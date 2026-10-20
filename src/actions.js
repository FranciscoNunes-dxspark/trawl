// Every operation the UI offers, written once. Keys and slash commands both call these.
// `ctx` is the app's handle: session, schema, query, confirm, note, prefill, and so on (see App.jsx).
import { writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { ADD_USAGE, cleanFolder, commitMode, describeConn, isReadOnly, parseAddArgs } from './connections.js';
import * as ed from './editor.js';
import { findDataSources, importPlan, planText } from './datagrip.js';
import { formatSql } from './format.js';
import { changesText, saveScript, withSaved } from './edit.js';
import { AI_LABELS, AI_LEVELS, aiLevel, askPrompt, canSeeSchema, consoleText, parseAnswer } from './ai.js';
import { describeObject, findObject, objectName } from './schema.js';
import { classifyScript, oneLine, selectTop, splitStatements, statementAt, toCsv, toJson } from './sql.js';

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
export async function runSql(ctx, sql, { title, lineBase, stay, keep } = {}) {
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
  // With manual commit (production's default), a write starts a transaction, so nothing sticks until /commit.
  const wrap = write && commitMode(conn) === 'manual' && !ctx.tranCount;
  return ctx.query(wrap ? `BEGIN TRANSACTION;\n${text}` : text, { title: title ?? oneLine(text), wrapped: wrap, lineBase, stay, keep });
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
  ctx.showText(objectName(obj), describeObject(obj, ctx.schema));
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
