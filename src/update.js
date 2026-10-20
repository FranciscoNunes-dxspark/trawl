// Checks GitHub Releases for a newer Trawl and, in the downloaded executable, installs it, as Tiller
// does. It asks the GitHub API with "trawl/<version>" as the user agent and, because the repository
// is private, again through the gh CLI when that finds nothing; downloads go the same way. No
// connection, query or machine details are sent.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdtemp, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { VERSION } from './version.js';

export const REPO = 'FranciscoNunes-dxspark/trawl';
export const RELEASES_URL = `https://github.com/${REPO}/releases`;
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const DAY = 24 * 60 * 60 * 1000;

/** "v1.2.3" or "1.2.3" → [1, 2, 3]; anything else → null. Pre-release suffixes are ignored. */
export function parseVersion(s) {
  const m = String(s ?? '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return m ? m.slice(1).map(Number) : null;
}

/** Whether `latest` is a higher version than `current`. */
export function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** Off when the config says so or TRAWL_NO_UPDATE_CHECK is set (to anything but 0). */
export function checksDisabled(config, env = process.env) {
  const flag = env.TRAWL_NO_UPDATE_CHECK;
  return config.checkUpdates === false || (flag != null && flag !== '' && flag !== '0');
}

/** A check is due when there has been none, or the last one was a day ago or more. */
export function isDue(check, now = Date.now()) {
  return !check?.at || now - check.at >= DAY;
}

// The release file for each platform; these names come from TARGETS in scripts/build.js.
const ASSETS = {
  'win32-x64': 'trawl-windows-x64.exe',
  'linux-x64': 'trawl-linux-x64',
  'linux-arm64': 'trawl-linux-arm64',
  'darwin-x64': 'trawl-macos-x64',
  'darwin-arm64': 'trawl-macos-arm64',
};

/** The release file that runs on `platform` and `arch`, or null if there's none. */
export function assetName(platform = process.platform, arch = process.arch) {
  return ASSETS[`${platform}-${arch}`] ?? null;
}

/**
 * The same request through the GitHub CLI, signed in as you: how a private repository's releases
 * are seen. Resolves with the release JSON, or null when gh is missing, signed out, or finds none.
 */
export function ghLatest({ signal } = {}) {
  return new Promise((resolve) => {
    execFile('gh', ['api', `repos/${REPO}/releases/latest`], { signal, windowsHide: true, encoding: 'utf8', timeout: 10000 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(null);
      }
    });
  });
}

function shape(body, { signedIn }) {
  const version = String(body?.tag_name ?? '').replace(/^v/, '');
  if (!parseVersion(version)) return null;
  const file = (body.assets ?? []).find((a) => a.name === assetName());
  return { version, url: body.html_url ?? `${RELEASES_URL}/tag/v${version}`, download: file?.browser_download_url ?? null, signedIn };
}

/**
 * The latest published release: { version, url, download, signedIn }, `download` being this
 * machine's file when the release has one. The repository is private, which GitHub answers with
 * a 404 to anyone not signed in, so a 404 asks again through gh (`signedIn` then). Null when
 * neither finds a release.
 */
export async function fetchLatest({ current, signal, fetchImpl = fetch, ghImpl = ghLatest } = {}) {
  const res = await fetchImpl(LATEST_API, {
    signal,
    headers: { accept: 'application/vnd.github+json', 'user-agent': `trawl/${current ?? 'unknown'}` },
  });
  if (res.status === 404) return shape(await ghImpl({ signal }), { signedIn: true });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} ${res.statusText ?? ''}`.trim());
  return shape(await res.json(), { signedIn: false });
}

/** The folder of the checkout this copy runs from. */
export const checkoutRoot = () => fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');

/** What to do to get `latest`, for the way this copy was installed. */
export function updateAdvice({ latest, current, compiled, root = checkoutRoot() }) {
  if (!latest) return [`No release found at ${RELEASES_URL}. It's private, so the check needs gh signed in with access (gh auth login). You have ${current}.`];
  if (!isNewer(latest.version, current)) return [`Trawl ${current} is the latest version.`];
  const lines = [`Trawl ${latest.version} is out (you have ${current}).`];
  if (compiled && latest.signedIn) {
    // A private release's files need a signed-in download, which gh does.
    lines.push(`Download it: gh release download v${latest.version} --repo ${REPO} --pattern ${assetName()}`);
  } else if (compiled) {
    lines.push(latest.download ? `Download ${assetName()}: ${latest.download}` : `Download it from ${latest.url}`);
    lines.push('Then replace this executable with it (quit Trawl first).');
  } else {
    lines.push(`From the checkout: cd "${root}" && git pull && npm install`);
    lines.push(`What's new: ${latest.url}`);
  }
  return lines;
}

/** Opens a URL in the default browser. */
export function openUrl(url) {
  const [cmd, args] =
    process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  execFile(cmd, args, { windowsHide: true }, () => {});
}

const CHECKSUMS = 'SHA256SUMS.txt';
const DOWNLOAD_MS = 10 * 60 * 1000;
const WORK_PREFIX = '.trawl-update-';

/** sha256sum's output ("<hash>  <name>", or "<hash> *<name>" for binary mode) as a Map from name to hash. */
export function parseChecksums(text) {
  const out = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/i.exec(line.trim());
    if (m) out.set(m[2], m[1].toLowerCase());
  }
  return out;
}

/** Downloads release `version`'s files `names` into `dir`: straight from GitHub, or through gh while the repository is private. */
async function downloadAssets(version, names, dir, { signal } = {}) {
  const limit = signal ? AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_MS)]) : AbortSignal.timeout(DOWNLOAD_MS);
  try {
    for (const name of names) {
      const res = await fetch(`https://github.com/${REPO}/releases/download/v${version}/${name}`, {
        headers: { 'user-agent': `trawl/${VERSION}` },
        signal: limit,
      });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(join(dir, name)));
    }
    return;
  } catch (e) {
    if (signal?.aborted) throw e;
    // A private repository answers 404; gh has a sign-in that can read it.
  }
  await new Promise((resolve, reject) => {
    const args = ['release', 'download', `v${version}`, '--repo', REPO, '--dir', dir, '--clobber', ...names.flatMap((n) => ['--pattern', n])];
    execFile('gh', args, { signal: limit, windowsHide: true, encoding: 'utf8' }, (err, _, stderr) => {
      if (!err) return resolve();
      reject(new Error(err.code === 'ENOENT' ? "the download needs gh, which isn't installed" : (stderr || err.message).trim().split('\n')[0]));
    });
  });
}

/** The version an executable says it is (`trawl --version`), or null if it doesn't answer. */
function versionOf(exe) {
  return new Promise((resolve) => {
    execFile(exe, ['--version'], { timeout: 10000, windowsHide: true, encoding: 'utf8' }, (err, stdout) => resolve(err ? null : (/trawl (\S+)/.exec(stdout)?.[1] ?? null)));
  });
}

/**
 * Replaces the executable `exe` with release `version`, which then runs from the next start. The
 * download goes into a folder next to `exe` (the same disk, so the swap is a rename) and must match the
 * release's SHA256SUMS.txt. Windows won't overwrite a running program but will rename it, so there the
 * old one moves aside to `<exe>.old.<time>`, for removeOldExecutables to delete on a later start.
 * Resolves with "installed", or "already" if `exe` is that version already (another Trawl window got
 * there first). Throws, with `exe` as it was, if anything goes wrong: a folder Trawl can't write to,
 * no download, a checksum that doesn't match.
 */
export async function installUpdate(
  version,
  { exe = process.execPath, platform = process.platform, arch = process.arch, signal, download = downloadAssets, installed = versionOf } = {},
) {
  const name = assetName(platform, arch);
  if (!name) throw new Error(`there's no release build for ${platform} ${arch}`);
  if ((await installed(exe)) === version) return 'already';
  const work = await mkdtemp(join(dirname(exe), WORK_PREFIX));
  try {
    await download(version, [name, CHECKSUMS], work, { signal });
    const want = parseChecksums(await readFile(join(work, CHECKSUMS), 'utf8')).get(name);
    if (!want) throw new Error(`the release has no checksum for ${name}`);
    const file = join(work, name);
    const got = createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
    if (got !== want) throw new Error(`the download of ${name} doesn't match its checksum`);
    if (platform !== 'win32') {
      await chmod(file, 0o755);
      // Replaces it in one step; a Trawl still running keeps the copy it started from.
      await rename(file, exe);
    } else {
      const aside = `${exe}.old.${Date.now()}`;
      await rename(exe, aside);
      try {
        await rename(file, exe);
      } catch (e) {
        await rename(aside, exe);
        throw e;
      }
    }
    return 'installed';
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Deletes what earlier updates left next to `exe`: old executables moved aside (one still running stays
 * until a later start) and download folders of updates that were interrupted (an hour old, so a
 * download in another Trawl window right now isn't touched).
 */
export async function removeOldExecutables(exe = process.execPath, { now = Date.now() } = {}) {
  const dir = dirname(exe);
  const old = `${basename(exe)}.old.`;
  for (const f of await readdir(dir).catch(() => [])) {
    const path = join(dir, f);
    if (f.startsWith(old)) await rm(path, { force: true }).catch(() => {});
    else if (f.startsWith(WORK_PREFIX)) {
      const s = await stat(path).catch(() => null);
      if (s && now - s.mtimeMs > 60 * 60 * 1000) await rm(path, { recursive: true, force: true }).catch(() => {});
    }
  }
}
