// What cli.jsx reads from its command line, kept here so the tests can reach it: cli.jsx itself
// starts the app.
import { azureSqlSpec } from './connections.js';

const VALUED = ['--connect', '--azure-sql', '--database', '--name', '--user', '--folder', '--password-from', '--subscription'];
const AZURE_ONLY = ['--database', '--name', '--user', '--folder', '--password-from', '--subscription'];

/**
 * The command line: { file, connect, demo, azureSql } where `azureSql` is `--azure-sql <server>` with
 * the options /azure-sql takes (--database for its database), as connections.js azureSqlSpec gives
 * them, or null. Throws, saying what's wrong, on an option missing its value or one that only goes
 * with --azure-sql.
 */
export function parseArgs(args) {
  const values = {};
  let file;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUED.includes(a)) {
      const v = args[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value.`);
      values[a] = v;
    } else if (!a.startsWith('-') && file === undefined) file = a;
  }
  const demo = args.includes('--demo');
  const prod = args.includes('--prod');
  const server = values['--azure-sql'];
  const only = AZURE_ONLY.filter((o) => values[o] !== undefined);
  if (!server && (only.length || prod)) throw new Error(`${only[0] ?? '--prod'} goes with --azure-sql <server>.`);
  const azureSql = server
    ? azureSqlSpec({ server, database: values['--database'], name: values['--name'], user: values['--user'], prod, folder: values['--folder'], passwordFrom: values['--password-from'], subscription: values['--subscription'] })
    : null;
  return { file, connect: values['--connect'] ?? (demo ? 'demo' : undefined), demo, azureSql };
}
