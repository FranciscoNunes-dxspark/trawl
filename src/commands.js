import * as a from './actions.js';
import { folderNames } from './fanout.js';
import { SNIPPET_WORDS, snippetsFor } from './snippets.js';
import { objectName } from './schema.js';

// Slash commands. `args` in square brackets are optional, so picking the command runs it straight away.
// `complete` names the list offered while typing the first argument.
export const COMMANDS = [
  { name: 'connect', args: '<name>', desc: 'Connect to a saved connection', complete: 'connections', run: (ctx, s) => a.connect(ctx, s) },
  { name: 'add', args: '<name> <server> [database] [--kind postgres|mysql] [--user u] [--folder f] [--prod]', desc: 'Save a connection (SQL Server, az login unless --user)', run: (ctx, s) => a.addConnection(ctx, s) },
  { name: 'import', args: 'datagrip [folder]', desc: 'Add your DataGrip data sources as connections, in their folders', run: (ctx, s) => a.importConnections(ctx, s) },
  { name: 'import-csv', args: '<file.csv> <table> [--run]', desc: 'A CSV file as INSERTs into a table, by its header: into a console tab to read (--run runs it)', run: (ctx, s) => a.importCsv(ctx, s) },
  { name: 'forget', args: '<name>', desc: 'Remove a saved connection (and its saved password)', complete: 'connections', run: (ctx, s) => (s ? a.forgetConnection(ctx, s) : ctx.prefill('/forget ')) },
  { name: 'folder', args: '<connection> [folder]', desc: 'Put a connection in a folder (no folder takes it out)', complete: 'connections', run: (ctx, s) => a.moveToFolder(ctx, s) },
  { name: 'password', args: '[connection]', desc: "Save a login's password in the OS credential store", complete: 'connections', run: (ctx, s) => a.setPassword(ctx, s) },
  { name: 'disconnect', desc: 'Close the connection', run: (ctx) => a.disconnect(ctx) },
  { name: 'use', args: '<database>', desc: 'Switch to another database on the same server', complete: 'databases', run: (ctx, s) => a.use(ctx, s) },
  { name: 'open', args: '<file.sql>', desc: 'Open a script in Query (reloads when you save it)', run: (ctx, s) => (s ? ctx.openFile(s) : ctx.prefill('/open ')) },
  { name: 'console', desc: 'Back to the console in Query (after /open)', run: (ctx) => ctx.showConsole() },
  { name: 'tab', args: '[new [name] | close | rename <name> | <name>]', desc: "The console's tabs: open, switch, rename, close ([ and ] switch, + opens)", complete: 'tabs', run: (ctx, s) => a.consoleTab(ctx, s) },
  { name: 'new', desc: 'Clear the console and start typing', run: (ctx) => a.newConsole(ctx) },
  { name: 'format', desc: 'Lay out the statement under the cursor in the console (or the selection)', run: (ctx) => a.formatConsole(ctx) },
  { name: 'search', args: '<text>', desc: 'Find text in the console (then n and N: next, previous)', run: (ctx, s) => a.searchConsole(ctx, s) },
  { name: 'save', args: '<file.sql>', desc: 'Write the console to a file', run: (ctx, s) => a.saveConsoleAs(ctx, s) },
  { name: 'snippet', args: '[name | save <name> | delete <name>]', desc: "Run a saved query; save the console's statement as one; forget one", complete: 'snippets', run: (ctx, s) => a.snippet(ctx, s) },
  { name: 'snippets', desc: 'The saved queries for this connection: ↵ run, e edit, x forget', run: (ctx) => a.showSnippets(ctx) },
  { name: 'describe', args: '<table>', desc: 'Columns, types and keys of a table or view', complete: 'objects', run: (ctx, s) => a.describe(ctx, s) },
  { name: 'script', args: '<name>', desc: 'CREATE script of a table, view, procedure or function, into the console', complete: 'everything', run: (ctx, s) => a.scriptObject(ctx, s) },
  { name: 'script-all', args: '<folder>', desc: 'Every table, view, routine and trigger in a file of its own (<schema>/Tables/<name>.sql…), for git: only changed files are written', run: (ctx, s) => a.scriptAll(ctx, s) },
  { name: 'migrations', args: '[run] <folder>', desc: 'Migration scripts against the history table (Flyway, EF Core, DbUp, or Trawl\'s own): applied, pending, changed; run runs the pending (R)', run: (ctx, s) => a.migrations(ctx, s) },
  { name: 'generate', args: '<table> [rows] [--seed n]', desc: 'Rows of made-up test data as INSERTs, in a console tab of their own (nothing runs)', complete: 'objects', run: (ctx, s) => a.generateData(ctx, s) },
  { name: 'scaffold', args: '<table> [csharp|ef|ts|python]', desc: 'A C# class, EF Core entity, TypeScript interface or Python dataclass for a table or view, copied', complete: 'objects', run: (ctx, s) => a.scaffoldObject(ctx, s) },
  { name: 'grep', args: '<text>', desc: 'Every view, procedure, function and trigger whose definition has the text in it: ↵ its CREATE script, at the match', run: (ctx, s) => a.grepDefinitions(ctx, s) },
  { name: 'uses', args: '<object>', desc: 'What refers to a table, view or routine, and what it refers to (u in the Explorer)', complete: 'everything', run: (ctx, s) => a.showUses(ctx, s) },
  { name: 'find', args: '[text]', desc: 'Filter the Explorer by name (empty clears it)', run: (ctx, s) => ctx.find(s) },
  { name: 'filter', args: '[text]', desc: 'Show only the result rows with a value containing the text (empty shows all)', run: (ctx, s) => ctx.filterResults(s) },
  { name: 'cell', desc: 'The whole value of the cell under the cursor in Results: JSON and XML laid out, binary as hex (v)', run: (ctx) => a.showCell(ctx) },
  { name: 'follow', desc: 'From the cell under the cursor in Results along its foreign key (F)', run: (ctx) => a.followKey(ctx) },
  { name: 'pin', desc: 'Keep the result set on screen to compare a later run with (p in Results)', run: (ctx) => a.pinResult(ctx) },
  { name: 'compare', desc: 'What changed between the pinned result and the one on screen (c in Results)', run: (ctx) => a.compareResults(ctx) },
  { name: 'copy', args: '[tsv|csv|json|md|insert]', desc: 'Copy the result set on screen (tab-separated pastes into a spreadsheet)', run: (ctx, s) => a.copyResults(ctx, s.trim()) },
  { name: 'export', args: '<file.csv|file.json|file.md>', desc: 'Save the result set on screen', run: (ctx, s) => a.exportResults(ctx, s) },
  { name: 'more', desc: 'Fetch another row limit\'s worth of the result set the limit cut off (m in Results)', run: (ctx) => a.moreRows(ctx) },
  { name: 'limit', args: '[rows]', desc: 'Rows kept per result set (the query stops there)', run: (ctx, s) => a.setLimit(ctx, s) },
  { name: 'writes', desc: 'Allow writes on a read-only connection until you disconnect', run: (ctx) => a.allowWrites(ctx) },
  { name: 'tx', args: '[auto|manual]', desc: 'Commit each statement as it runs, or only on /commit', run: (ctx, s) => a.setCommitMode(ctx, s.trim().toLowerCase()) },
  { name: 'commit', desc: 'Commit the open transaction', run: (ctx) => a.commit(ctx) },
  { name: 'rollback', desc: 'Roll back the open transaction', run: (ctx) => a.rollback(ctx) },
  { name: 'settings', desc: "Trawl's settings: row limit, accent colour, updates (,)", run: (ctx) => ctx.showSettings() },
  { name: 'update', desc: 'Check for a newer Trawl and install it (or say how to get it)', run: (ctx) => ctx.checkUpdates() },
  { name: 'ask', args: '<question>', desc: 'Claude writes a query for it, into the console (nothing runs)', run: (ctx, s) => a.ask(ctx, s) },
  { name: 'ai', args: '[connection] [off|schema|results]', desc: 'What Claude may see of a connection (schema only by default)', complete: 'connections', run: (ctx, s) => a.setAi(ctx, s) },
  { name: 'stats', args: '[on|off]', desc: 'Pages read per table and server time after each run (STATISTICS IO, TIME)', run: (ctx, s) => a.setStats(ctx, s.trim().toLowerCase()) },
  { name: 'plan', args: '[actual] [sql]', desc: 'The estimated plan of the console\'s statement (nothing runs); actual runs it, for the rows each step really gave (P)', run: (ctx, s) => (/^actual\b/i.test(s) ? a.showActualPlan(ctx, s.replace(/^actual\b\s*/i, '')) : a.showPlan(ctx, s)) },
  { name: 'diff', args: '<connection|database> [database]', desc: "Compare this database's schema with another's, and offer the script that makes this one match", complete: 'diff', run: (ctx, s) => a.diffSchema(ctx, s) },
  { name: 'fanout', args: '<folder> [sql]', desc: "One read-only query on every connection in a folder, the rows merged (the console's statement without sql)", complete: 'folders', run: (ctx, s) => a.fanOut(ctx, s) },
  { name: 'activity', desc: "The server's sessions: what runs, what waits, who blocks whom (6)", run: (ctx) => a.showActivityList(ctx, 'sessions') },
  { name: 'jobs', desc: "SQL Agent's jobs: running now, last outcome, next run; ↵ their runs, s starts one (J in Activity)", run: (ctx) => a.showActivityList(ctx, 'jobs') },
  { name: 'top-queries', desc: 'The queries that cost the most: Query Store, else the plan cache; o sorts (Q in Activity)', run: (ctx) => a.showActivityList(ctx, 'queries') },
  { name: 'kill', args: '<session>', desc: 'End another session (KILL), after asking; read-only connections refuse it', run: (ctx, s) => a.killSession(ctx, s) },
  { name: 'explain', desc: 'Claude explains the last plan (p): what it does, what costs most, what might help', run: (ctx) => a.explainPlan(ctx) },
  { name: 'last', desc: 'Show the full output of the last run', run: (ctx) => ctx.showLast() },
  { name: 'refresh', desc: 'Reload the schema', run: (ctx) => ctx.refresh() },
  { name: 'help', desc: 'Keyboard shortcuts', run: (ctx) => ctx.showHelp() },
  { name: 'quit', desc: 'Exit Trawl', run: (ctx) => ctx.quit() },
];

/** Exact name, or an unambiguous prefix of one. */
export function findCommand(name) {
  const n = name.toLowerCase();
  const exact = COMMANDS.find((c) => c.name === n);
  if (exact) return exact;
  const matches = COMMANDS.filter((c) => c.name.startsWith(n));
  return matches.length === 1 ? matches[0] : null;
}

function completions(kind, { config, schema, conn, tabs }) {
  if (kind === 'snippets') return [...snippetsFor(config.snippets, conn).map((s) => s.name), ...SNIPPET_WORDS];
  if (kind === 'connections') return config.connections.map((c) => c.name);
  if (kind === 'tabs') return [...(tabs ?? []), 'new', 'close', 'rename'];
  if (kind === 'folders') return folderNames(config.connections);
  if (kind === 'diff') return [...config.connections.map((c) => c.name), ...(schema?.databases.filter((d) => d !== schema.database) ?? [])];
  if (!schema) return [];
  if (kind === 'databases') return schema.databases;
  if (kind === 'everything') return schema.objects.map(objectName);
  return schema.objects.filter((o) => o.kind === 'table' || o.kind === 'view').map(objectName);
}

function ranked(names, query) {
  const q = query.toLowerCase();
  const starts = names.filter((n) => n.toLowerCase().startsWith(q)).sort((x, y) => (x.toLowerCase() === q ? -1 : y.toLowerCase() === q ? 1 : 0));
  const contains = names.filter((n) => !n.toLowerCase().startsWith(q) && n.toLowerCase().includes(q));
  return [...starts, ...contains];
}

/**
 * What to offer under the prompt for `value`: commands while the name is being typed,
 * then connections, databases or tables for commands that complete their argument.
 * `insert` replaces the prompt text; `run` means picking it can run straight away.
 */
export function suggestionsFor(value, lists) {
  if (!value.startsWith('/')) return [];
  const space = value.indexOf(' ');
  if (space < 0) {
    const names = ranked(COMMANDS.map((c) => c.name), value.slice(1));
    return names.slice(0, 7).map((name) => {
      const c = COMMANDS.find((x) => x.name === name);
      const optional = !c.args || c.args.startsWith('[');
      return { label: `/${c.name}`, hint: c.args ?? '', desc: c.desc, insert: `/${c.name}${optional ? '' : ' '}`, run: optional };
    });
  }
  const cmd = findCommand(value.slice(1, space));
  const rest = value.slice(space + 1);
  if (!cmd?.complete || rest.includes(' ')) return [];
  const names = ranked(completions(cmd.complete, lists), rest);
  if (names.length === 1 && names[0] === rest) return [];
  return names.slice(0, 7).map((n) => ({ label: n, insert: `/${cmd.name} ${n}`, run: true }));
}
