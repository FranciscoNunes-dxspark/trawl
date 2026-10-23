// What cli.jsx reads from its command line, and `trawl store-password`, kept here so the tests can
// reach them: cli.jsx itself starts the app.

const VALUED = ['--connect', '--azure-sql', '--database', '--name', '--user', '--folder'];

/**
 * The command line: { file, connect, demo, azureSql } where `azureSql` is `--azure-sql <server>`
 * with its --database, --name, --user, --prod and --folder ({ server, database, name, user, prod,
 * folder }), or null. Throws, saying what's wrong, on an option missing its value or one that only
 * goes with --azure-sql.
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
  const only = ['--database', '--name', '--user', '--folder'].filter((o) => values[o] !== undefined);
  if (!server && (only.length || prod)) throw new Error(`${only[0] ?? '--prod'} goes with --azure-sql <server>.`);
  const azureSql = server ? { server, database: values['--database'], name: values['--name'], user: values['--user'], prod, folder: values['--folder'] } : null;
  if (azureSql) for (const k of Object.keys(azureSql)) if (azureSql[k] === undefined) delete azureSql[k];
  return { file, connect: values['--connect'] ?? (demo ? 'demo' : undefined), demo, azureSql };
}

/** All of a stream (stdin) as text. */
export async function readAll(stream) {
  let text = '';
  stream.setEncoding?.('utf8');
  for await (const chunk of stream) text += chunk;
  return text;
}

/**
 * `trawl store-password <connection>`: the password on `input` (one line ending dropped) saved in
 * `credentials` (the OS store) under the connection's name, as Trawl looks for it when connecting.
 * Throws, saying why, when there's no name or no password; the password never goes on the command line.
 */
export async function storePassword(name, input, credentials) {
  if (!name || name.startsWith('-')) throw new Error('Usage: trawl store-password <connection>, with the password on stdin.');
  const password = String(input ?? '').replace(/\r?\n$/, '');
  if (!password) throw new Error('No password on stdin.');
  await credentials.set(name, { password });
  return `Saved the password for ${name} in ${credentials.name}.`;
}
