// Checks GitHub Releases for a newer Trawl. It only tells you: nothing is downloaded or replaced.
// The one request is a GET to the GitHub API with "trawl/<version>" as the user agent; no
// connection, query or machine details are sent.
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
 * The latest published release: { version, url, download }, `download` being this machine's
 * file when the release has one. Null when the repository has no releases yet (or isn't public).
 */
export async function fetchLatest({ current, signal, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(LATEST_API, {
    signal,
    headers: { accept: 'application/vnd.github+json', 'user-agent': `trawl/${current ?? 'unknown'}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub answered ${res.status} ${res.statusText ?? ''}`.trim());
  const body = await res.json();
  const version = String(body.tag_name ?? '').replace(/^v/, '');
  if (!parseVersion(version)) return null;
  const file = (body.assets ?? []).find((a) => a.name === assetName());
  return { version, url: body.html_url ?? `${RELEASES_URL}/tag/v${version}`, download: file?.browser_download_url ?? null };
}

/** The folder of the checkout this copy runs from. */
export const checkoutRoot = () => fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');

/** What to do to get `latest`, for the way this copy was installed. */
export function updateAdvice({ latest, current, compiled, root = checkoutRoot() }) {
  if (!latest) return [`No releases are published at ${RELEASES_URL} yet. You have ${current}.`];
  if (!isNewer(latest.version, current)) return [`Trawl ${current} is the latest version.`];
  const lines = [`Trawl ${latest.version} is out (you have ${current}).`];
  if (compiled) {
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
