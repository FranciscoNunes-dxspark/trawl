// Azure SQL sign-in through the Azure CLI: the token comes from `az login`, so Fathom never
// sees or stores a password. Tokens last about an hour; each new connection asks for a fresh one.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const RESOURCE = 'https://database.windows.net/';

// On Windows az is a .cmd wrapper that Node won't start without a shell, so call the Python
// it wraps directly: no shell, so no quoting surprises. (The same approach as Tiller's.)
function az(args, { signal } = {}) {
  let file = 'az';
  let argv = args;
  let env = process.env;
  if (process.platform === 'win32') {
    const dir = (process.env.PATH ?? '').split(delimiter).find((d) => d && existsSync(join(d, 'az.cmd')));
    const python = dir && join(dir, '..', 'python.exe');
    if (!python || !existsSync(python)) return Promise.reject(new Error('The Azure CLI (az) is not installed. Get it from https://aka.ms/installazurecliwindows'));
    file = python;
    argv = ['-X', 'utf8', '-IBm', 'azure.cli', ...args];
    env = { ...process.env, AZ_INSTALLER: 'MSI' };
  }
  return new Promise((resolve, reject) => {
    execFile(file, argv, { env, signal, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if (err.code === 'ENOENT') return reject(new Error('The Azure CLI (az) is not installed or not on the PATH.'));
      const lines = (stderr || err.message).trim().split('\n').filter((l) => !/^WARNING:/.test(l));
      const text = lines.slice(-3).join('\n');
      reject(new Error(/az login/.test(text) ? `Not signed in to Azure. Run: az login\n${text}` : text || 'az failed'));
    });
  });
}

/** An Entra access token for Azure SQL, from the Azure CLI's current sign-in. */
export async function azureSqlToken(opts) {
  const out = await az(['account', 'get-access-token', '--resource', RESOURCE, '--query', 'accessToken', '-o', 'tsv'], opts);
  const token = out.trim();
  if (!token) throw new Error('The Azure CLI returned no token. Run: az login');
  return token;
}
