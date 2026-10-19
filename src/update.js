// Checks GitHub Releases for a newer Trawl. It only tells you: nothing is downloaded or replaced.
// It asks the GitHub API with "trawl/<version>" as the user agent and, because the repository is
// private, again through the gh CLI when that finds nothing. No connection, query or machine
// details are sent.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

/** The release file for this machine, as scripts/build.js names them. */
export function assetName(platform = process.platform, arch = process.arch) {
  const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : platform;
  return `trawl-${os}-${arch}${platform === 'win32' ? '.exe' : ''}`;
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
