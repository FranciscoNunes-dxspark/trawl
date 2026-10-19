import * as a from './actions.js';
import { objectName } from './schema.js';

// Slash commands. `args` in square brackets are optional, so picking the command runs it straight away.
// `complete` names the list offered while typing the first argument.
export const COMMANDS = [
  { name: 'connect', args: '<name>', desc: 'Connect to a saved connection', complete: 'connections', run: (ctx, s) => a.connect(ctx, s) },
  { name: 'add', args: '<name> <server> [database] [--user u --password-env VAR] [--prod]', desc: 'Save a connection (az login unless --user)', run: (ctx, s) => a.addConnection(ctx, s) },
  { name: 'forget', args: '<name>', desc: 'Remove a saved connection', complete: 'connections', run: (ctx, s) => (s ? a.forgetConnection(ctx, s) : ctx.prefill('/forget ')) },
  { name: 'disconnect', desc: 'Close the connection', run: (ctx) => a.disconnect(ctx) },
  { name: 'use', args: '<database>', desc: 'Switch to another database on the same server', complete: 'databases', run: (ctx, s) => a.use(ctx, s) },
  { name: 'open', args: '<file.sql>', desc: 'Open a script in Query (reloads when you save it)', run: (ctx, s) => (s ? ctx.openFile(s) : ctx.prefill('/open ')) },
  { name: 'describe', args: '<table>', desc: 'Columns, types and keys of a table or view', complete: 'objects', run: (ctx, s) => a.describe(ctx, s) },
  { name: 'find', args: '[text]', desc: 'Filter the Explorer by name (empty clears it)', run: (ctx, s) => ctx.find(s) },
  { name: 'export', args: '<file.csv|file.json>', desc: 'Save the result set on screen', run: (ctx, s) => a.exportResults(ctx, s) },
  { name: 'limit', args: '[rows]', desc: 'Rows kept per result set (the query stops there)', run: (ctx, s) => a.setLimit(ctx, s) },
  { name: 'writes', desc: 'Allow writes on a read-only connection until you disconnect', run: (ctx) => a.allowWrites(ctx) },
  { name: 'commit', desc: 'Commit the open transaction', run: (ctx) => a.commit(ctx) },
  { name: 'rollback', desc: 'Roll back the open transaction', run: (ctx) => a.rollback(ctx) },
  { name: 'last', desc: 'Show the full output of the last run', run: (ctx) => ctx.showLast() },
  { name: 'refresh', desc: 'Reload the schema', run: (ctx) => ctx.refresh() },
  { name: 'help', desc: 'Keyboard shortcuts', run: (ctx) => ctx.showHelp() },
  { name: 'quit', desc: 'Exit Fathom', run: (ctx) => ctx.quit() },
];

/** Exact name, or an unambiguous prefix of one. */
export function findCommand(name) {
  const n = name.toLowerCase();
  const exact = COMMANDS.find((c) => c.name === n);
  if (exact) return exact;
  const matches = COMMANDS.filter((c) => c.name.startsWith(n));
  return matches.length === 1 ? matches[0] : null;
}

function completions(kind, { config, schema }) {
  if (kind === 'connections') return config.connections.map((c) => c.name);
  if (!schema) return [];
  if (kind === 'databases') return schema.databases;
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
