// Saved passwords, kept in the operating system's credential store and never in config.json:
// Windows Credential Manager, the macOS Keychain, or the Secret Service keyring on Linux
// (secret-tool). Each is reached through a tool the system already has, no native module, so
// the compiled build works too. A password only ever travels on stdin or stdout, never argv,
// except on macOS, whose `security` tool takes it as an argument.
import { execFile } from 'node:child_process';

const SERVICE = 'Trawl';
const target = (name) => `${SERVICE}:${name}`;

/** Where passwords go on this platform, for messages: "Windows Credential Manager". */
export const STORE_NAME = { win32: 'Windows Credential Manager', darwin: 'the macOS Keychain' }[process.platform] ?? 'the system keyring';

function run(file, args, { input, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { signal, windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if (err.code === 'ENOENT') return reject(new Error(`${file} isn't installed, so Trawl can't reach ${STORE_NAME}.`));
      err.stderr = stderr;
      err.stdout = stdout;
      reject(err);
    });
    // A tool that exits without reading its input (a keyring that refuses at once) closes the pipe first.
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

// Credential Manager through its Win32 API (CredRead/CredWrite/CredDelete), from PowerShell.
// Text crosses as base64 so no console code page can mangle it.
const WIN_API = `
Add-Type -Namespace Trawl -Name Cred -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment;
  public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
  public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool CredReadW(string target, int type, int flags, out IntPtr cred);
[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool CredWriteW(ref CREDENTIAL cred, int flags);
[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool CredDeleteW(string target, int type, int flags);
[DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);
'@
$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:TRAWL_CRED_TARGET))
`;

const WIN_SCRIPTS = {
  get: `${WIN_API}
$p = [IntPtr]::Zero
if (-not [Trawl.Cred]::CredReadW($t, 1, 0, [ref]$p)) { exit 3 }
$c = [Runtime.InteropServices.Marshal]::PtrToStructure($p, [type][Trawl.Cred+CREDENTIAL])
$bytes = New-Object byte[] $c.CredentialBlobSize
[Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob, $bytes, 0, $c.CredentialBlobSize)
[Trawl.Cred]::CredFree($p)
[Console]::Out.Write([Convert]::ToBase64String($bytes))`,
  set: `${WIN_API}
$u = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:TRAWL_CRED_USER))
$bytes = [Text.Encoding]::Unicode.GetBytes([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())))
$c = New-Object Trawl.Cred+CREDENTIAL
$c.Type = 1; $c.Persist = 2; $c.TargetName = $t; $c.UserName = $u; $c.CredentialBlobSize = $bytes.Length
$c.CredentialBlob = [Runtime.InteropServices.Marshal]::AllocHGlobal([Math]::Max(1, $bytes.Length))
[Runtime.InteropServices.Marshal]::Copy($bytes, 0, $c.CredentialBlob, $bytes.Length)
$ok = [Trawl.Cred]::CredWriteW([ref]$c, 0)
[Runtime.InteropServices.Marshal]::FreeHGlobal($c.CredentialBlob)
if (-not $ok) { exit 4 }`,
  remove: `${WIN_API}
[void][Trawl.Cred]::CredDeleteW($t, 1, 0)`,
};

const b64 = (s) => Buffer.from(String(s ?? ''), 'utf8').toString('base64');

function windows(op, name, { user, password, signal } = {}) {
  const env = { ...process.env, TRAWL_CRED_TARGET: b64(target(name)), TRAWL_CRED_USER: b64(user) };
  const encoded = Buffer.from(WIN_SCRIPTS[op], 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { env, signal, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if (op === 'get' && err.code === 3) return resolve(null);
      reject(new Error(`${STORE_NAME} refused it: ${(stderr || err.message).trim().split('\n')[0]}`));
    });
    // A tool that exits without reading its input (a keyring that refuses at once) closes the pipe first.
    child.stdin.on('error', () => {});
    child.stdin.end(op === 'set' ? b64(password) : '');
  });
}

// Each call starts a helper (over a second for PowerShell), so what was read is kept for the process.
const cache = new Map();

/** The real store for this platform: { name, get(name), set(name, { user, password }), remove(name) }. */
export const osCredentials = {
  name: STORE_NAME,
  async get(name, opts) {
    if (!cache.has(name)) cache.set(name, await lookup(name, opts));
    return cache.get(name);
  },
  async set(name, { user, password }) {
    if (process.platform === 'win32') await windows('set', name, { user, password });
    else if (process.platform === 'darwin') await run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', name, '-l', `${SERVICE} ${name}`, '-w', password]);
    else await run('secret-tool', ['store', `--label=${SERVICE} ${name}`, 'service', SERVICE, 'connection', name], { input: password });
    cache.set(name, password);
  },
  async remove(name) {
    cache.delete(name);
    try {
      if (process.platform === 'win32') await windows('remove', name);
      else if (process.platform === 'darwin') await run('security', ['delete-generic-password', '-s', SERVICE, '-a', name]);
      else await run('secret-tool', ['clear', 'service', SERVICE, 'connection', name]);
    } catch {
      // Nothing saved is fine: forgetting is the point.
    }
  },
};

async function lookup(name, { signal } = {}) {
  if (process.platform === 'win32') {
    const out = await windows('get', name, { signal });
    return out == null ? null : Buffer.from(out.trim(), 'base64').toString('utf16le');
  }
  try {
    const out =
      process.platform === 'darwin'
        ? await run('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w'], { signal })
        : await run('secret-tool', ['lookup', 'service', SERVICE, 'connection', name], { signal });
    return out.replace(/\r?\n$/, '') || null;
  } catch (e) {
    // Not found is exit 44 for security and 1 for secret-tool; a missing tool still says so.
    if (e.code === 44 || e.code === 1) return null;
    throw e;
  }
}

/** A store in memory, for the tests. */
export function memoryCredentials(initial = {}) {
  const saved = new Map(Object.entries(initial));
  return {
    name: 'memory',
    saved,
    get: async (name) => saved.get(name) ?? null,
    set: async (name, { password }) => void saved.set(name, password),
    remove: async (name) => void saved.delete(name),
  };
}
