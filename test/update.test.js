import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetName, checksDisabled, fetchLatest, isDue, isNewer, parseVersion, updateAdvice } from '../src/update.js';

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
  assert.deepEqual(latest, { version: '0.2.0', url: 'https://github.com/FranciscoNunes-dxspark/trawl/releases/tag/v0.2.0', download: 'https://example.test/trawl' });
});

test('no releases yet is not an error; a server error is', async () => {
  assert.equal(await fetchLatest({ current: '0.1.0', fetchImpl: reply(404, {}) }), null);
  await assert.rejects(fetchLatest({ current: '0.1.0', fetchImpl: reply(403, {}) }), /GitHub answered 403/);
});

test('the advice depends on how Trawl was installed', () => {
  const latest = { version: '0.2.0', url: 'https://r', download: 'https://d' };
  assert.match(updateAdvice({ latest: null, current: '0.1.0' })[0], /No releases are published/);
  assert.deepEqual(updateAdvice({ latest, current: '0.2.0' }), ['Trawl 0.2.0 is the latest version.']);
  const exe = updateAdvice({ latest, current: '0.1.0', compiled: true });
  assert.equal(exe[0], 'Trawl 0.2.0 is out (you have 0.1.0).');
  assert.match(exe[1], /https:\/\/d/);
  const src = updateAdvice({ latest, current: '0.1.0', compiled: false, root: 'C:\\Team\\Trawl' });
  assert.equal(src[1], 'From the checkout: cd "C:\\Team\\Trawl" && git pull && npm install');
});
