// Azure SQL through the Azure CLI: the token comes from `az login`, so Trawl never sees or stores a
// password (tokens last about an hour; each new connection asks for a fresh one), and a server's
// firewall gets a rule for this machine's address the same way. `az` is the runner; App takes it as
// a prop so the tests never start the real one.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const RESOURCE = 'https://database.windows.net/';

// On Windows az is a .cmd wrapper that Node won't start without a shell, so call the Python
// it wraps directly: no shell, so no quoting surprises. (The same approach as Tiller's.)
export function az(args, { signal } = {}) {
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

/**
 * The address a server's firewall turned away, from Azure SQL's error 40615 ("Client with IP
 * address 'a.b.c.d' is not allowed to access the server"), or null for any other error.
 */
export function firewallBlock(error) {
  const m = String(error?.message ?? error ?? '').match(/Client with IP address '([0-9a-fA-F.:]+)' is not allowed to access the server/i);
  return m ? m[1] : null;
}

/** An Azure SQL server's name as Azure knows it: tcp: and the port dropped, lower case. */
export const serverHost = (server) =>
  String(server ?? '')
    .trim()
    .replace(/^tcp:/i, '')
    .replace(/[,:]\d+$/, '')
    .toLowerCase();

/** The firewall rule Trawl adds for an address: trawl-203-0-113-7. */
export const ruleName = (ip) => `trawl-${String(ip).replace(/[.:]/g, '-')}`;

const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/;
const isIp = (s) => IPV4.test(s) || /^[0-9a-fA-F:]+:[0-9a-fA-F:]*$/.test(s);

/**
 * Lets `ip` through the firewall of the Azure SQL server `server` (its full name): finds the
 * server's resource group in the az login's subscription, then creates (or updates) the rule
 * trawl-<ip>. Resolves { group, server, rule }; throws with az's own words when it can't.
 */
export async function addFirewallRule(server, ip, { run = az, signal } = {}) {
  const fqdn = serverHost(server);
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(fqdn)) throw new Error(`${server} isn't an Azure SQL server's name.`);
  if (!isIp(ip)) throw new Error(`${ip} isn't an IP address.`);
  const out = await run(['sql', 'server', 'list', '--query', `[?fullyQualifiedDomainName=='${fqdn}'].{g:resourceGroup,n:name}`, '-o', 'json'], { signal });
  let found;
  try {
    found = JSON.parse(out || '[]')[0];
  } catch {
    throw new Error(`az sql server list said something Trawl can't read: ${String(out).slice(0, 200)}`);
  }
  if (!found?.g || !found?.n) throw new Error(`No Azure SQL server ${fqdn} in the subscription az is signed in to (az account set --subscription <id> changes it).`);
  const rule = ruleName(ip);
  await run(['sql', 'server', 'firewall-rule', 'create', '-g', found.g, '-s', found.n, '-n', rule, '--start-ip-address', ip, '--end-ip-address', ip, '-o', 'none'], { signal });
  return { group: found.g, server: found.n, rule };
}

/** This machine's address as the internet sees it (what a server's firewall goes by). */
export async function publicIp({ signal, fetch = globalThis.fetch } = {}) {
  const res = await fetch('https://api.ipify.org', { signal });
  if (!res.ok) throw new Error(`api.ipify.org answered ${res.status}.`);
  const ip = (await res.text()).trim();
  if (!isIp(ip)) throw new Error(`api.ipify.org answered something that isn't an address: ${ip.slice(0, 60)}`);
  return ip;
}
