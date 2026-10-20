import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetName, checksDisabled, fetchLatest, installUpdate, isDue, isNewer, parseChecksums, parseVersion, removeOldExecutables, updateAdvice } from '../src/update.js';

// Windows can hold a just-renamed file for a moment.
const removeTemp = (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

test('versions compare as numbers, not text', () => {
  assert.deepEqual(parseVersion('v1.10.0'), [1, 10, 0]);
  assert.equal(parseVersion('latest'), null);
  assert.equal(isNewer('0.10.0', '0.9.9'), true);
  assert.equal(isNewer('v0.2.0', '0.2.0'), false);
  assert.equal(isNewer('0.1.9', '0.2.0'), false);
  assert.equal(isNewer('garbage', '0.1.0'), false);
});

test('a check is due once a day, and can be turned off', () => {
  const now = 10 * 86_400_000;
  assert.equal(isDue(null, now), true);
  assert.equal(isDue({ at: now - 3_600_000 }, now), false);
  assert.equal(isDue({ at: now - 86_400_000 }, now), true);
  assert.equal(checksDisabled({ checkUpdates: false }, {}), true);
  assert.equal(checksDisabled({}, { TRAWL_NO_UPDATE_CHECK: '1' }), true);
  assert.equal(checksDisabled({}, { TRAWL_NO_UPDATE_CHECK: '0' }), false);
  assert.equal(checksDisabled({ checkUpdates: true }, {}), false);
});

test('release files are named as the build names them', () => {
  assert.equal(assetName('win32', 'x64'), 'trawl-windows-x64.exe');
  assert.equal(assetName('darwin', 'arm64'), 'trawl-macos-arm64');
  assert.equal(assetName('linux', 'arm64'), 'trawl-linux-arm64');
  assert.equal(assetName('win32', 'arm64'), null);
});

test('SHA256SUMS.txt is read as sha256sum writes it', () => {
  const a = 'a'.repeat(64);
  const b = 'B'.repeat(64);
  const sums = parseChecksums(`${a}  trawl-linux-x64
${b} *trawl-windows-x64.exe
not a line
`);
  assert.deepEqual([...sums], [
    ['trawl-linux-x64', a],
    ['trawl-windows-x64.exe', 'b'.repeat(64)],
  ]);
});

test('installing an update swaps the executable, only with a matching checksum, and tidies up after', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trawl-install-'));
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  // Stands in for GitHub: the release's files, written where installUpdate asks.
  const release = (content, sum = sha(content)) => async (version, names, into) => {
    assert.equal(version, '0.3.0');
    writeFileSync(join(into, names[0]), content);
    writeFileSync(join(into, names[1]), `${sum}  ${names[0]}
`);
  };
  const leftovers = () => readdirSync(dir).filter((f) => f.startsWith('.trawl-update-'));
  try {
    // Windows: the running one is renamed aside, and the new one takes its name.
    const exe = join(dir, 'trawl.exe');
    writeFileSync(exe, 'old build');
    const win = { exe, platform: 'win32', arch: 'x64', installed: async () => '0.2.0' };
    assert.equal(await installUpdate('0.3.0', { ...win, download: release('new build') }), 'installed');
    assert.equal(readFileSync(exe, 'utf8'), 'new build');
    const aside = readdirSync(dir).filter((f) => f.startsWith('trawl.exe.old.'));
    assert.equal(aside.length, 1);
    assert.equal(readFileSync(join(dir, aside[0]), 'utf8'), 'old build');
    assert.deepEqual(leftovers(), []);

    // A download that doesn't match its checksum leaves everything as it was.
    writeFileSync(exe, 'current');
    await assert.rejects(installUpdate('0.3.0', { ...win, download: release('tampered', sha('something else')) }), /doesn't match its checksum/);
    assert.equal(readFileSync(exe, 'utf8'), 'current');
    assert.deepEqual(leftovers(), []);

    // Already that version (another window installed it): nothing is downloaded.
    let downloads = 0;
    const counted = async (...args) => {
      downloads++;
      return release('x')(...args);
    };
    assert.equal(await installUpdate('0.3.0', { ...win, installed: async () => '0.3.0', download: counted }), 'already');
    assert.equal(downloads, 0);

    // macOS and Linux: a rename replaces it in one step, with nothing set aside.
    const unixExe = join(dir, 'trawl');
    writeFileSync(unixExe, 'old build');
    await installUpdate('0.3.0', { exe: unixExe, platform: 'linux', arch: 'x64', installed: async () => '0.2.0', download: release('new build') });
    assert.equal(readFileSync(unixExe, 'utf8'), 'new build');
    assert.ok(!readdirSync(dir).some((f) => f.startsWith('trawl.old.')));

    await assert.rejects(installUpdate('0.3.0', { ...win, arch: 'arm64', download: release('x') }), /no release build/);
  } finally {
    removeTemp(dir);
  }
});

test('old executables and abandoned downloads are removed, but not a download still going', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trawl-old-'));
  try {
    const exe = join(dir, 'trawl.exe');
    writeFileSync(exe, 'current');
    writeFileSync(join(dir, 'trawl.exe.old.1700000000000'), 'old');
    writeFileSync(join(dir, 'notes.txt'), 'mine');
    mkdirSync(join(dir, '.trawl-update-stale'));
    mkdirSync(join(dir, '.trawl-update-busy'));
    const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(join(dir, '.trawl-update-stale'), twoHoursAgo, twoHoursAgo);
    await removeOldExecutables(exe);
    assert.deepEqual(readdirSync(dir).sort(), ['.trawl-update-busy', 'notes.txt', 'trawl.exe']);
  } finally {
    removeTemp(dir);
  }
});

const reply = (status, body) => async (url, opts) => {
  assert.match(url, /api\.github\.com\/repos\/FranciscoNunes-dxspark\/trawl\/releases\/latest$/);
  assert.equal(opts.headers['user-agent'], 'trawl/0.1.0');
  return { status, ok: status < 300, statusText: 'x', json: async () => body };
};

test('fetchLatest reads the release and picks this machine’s file', async () => {
  const latest = await fetchLatest({
    current: '0.1.0',
    fetchImpl: reply(200, {
      tag_name: 'v0.2.0',
      html_url: 'https://github.com/FranciscoNunes-dxspark/trawl/releases/tag/v0.2.0',
      assets: [{ name: assetName(), browser_download_url: 'https://example.test/trawl' }],
    }),
  });
  assert.deepEqual(latest, { version: '0.2.0', url: 'https://github.com/FranciscoNunes-dxspark/trawl/releases/tag/v0.2.0', download: 'https://example.test/trawl', signedIn: false });
});

test('a 404 (private, or no releases) asks again through gh', async () => {
  const viaGh = await fetchLatest({ current: '0.1.0', fetchImpl: reply(404, {}), ghImpl: async () => ({ tag_name: 'v0.3.0', html_url: 'https://r', assets: [] }) });
  assert.deepEqual(viaGh, { version: '0.3.0', url: 'https://r', download: null, signedIn: true });
  assert.equal(await fetchLatest({ current: '0.1.0', fetchImpl: reply(404, {}), ghImpl: async () => null }), null);
  await assert.rejects(fetchLatest({ current: '0.1.0', fetchImpl: reply(403, {}) }), /GitHub answered 403/);
});

test('the advice depends on how Trawl was installed', () => {
  const latest = { version: '0.2.0', url: 'https://r', download: 'https://d' };
  assert.match(updateAdvice({ latest: null, current: '0.1.0' })[0], /gh auth login/);
  const signedIn = updateAdvice({ latest: { ...latest, signedIn: true }, current: '0.1.0', compiled: true });
  assert.equal(signedIn[1], `Download it: gh release download v0.2.0 --repo FranciscoNunes-dxspark/trawl --pattern ${assetName()}`);
  assert.deepEqual(updateAdvice({ latest, current: '0.2.0' }), ['Trawl 0.2.0 is the latest version.']);
  const exe = updateAdvice({ latest, current: '0.1.0', compiled: true });
  assert.equal(exe[0], 'Trawl 0.2.0 is out (you have 0.1.0).');
  assert.match(exe[1], /https:\/\/d/);
  const src = updateAdvice({ latest, current: '0.1.0', compiled: false, root: 'C:\\Team\\Trawl' });
  assert.equal(src[1], 'From the checkout: cd "C:\\Team\\Trawl" && git pull && npm install');
});
