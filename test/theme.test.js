import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DARK, LIGHT, applyTheme, backgroundFrom, theme, themeMode } from '../src/theme.js';

test('the background from COLORFGBG: white and bright white are light, other colours dark, nothing says nothing', () => {
  assert.equal(backgroundFrom('15;0'), 'dark');
  assert.equal(backgroundFrom('0;15'), 'light');
  assert.equal(backgroundFrom('0;default;7'), 'light');
  assert.equal(backgroundFrom('15;default;0'), 'dark');
  assert.equal(backgroundFrom('0;default'), null);
  assert.equal(backgroundFrom(undefined), null);
});

test('the Theme setting: dark and light as they say, auto (or none) from the terminal, else dark', () => {
  assert.equal(themeMode('light', {}), 'light');
  assert.equal(themeMode('dark', { COLORFGBG: '0;15' }), 'dark');
  assert.equal(themeMode('auto', { COLORFGBG: '0;15' }), 'light');
  assert.equal(themeMode(undefined, { COLORFGBG: '0;15' }), 'light');
  assert.equal(themeMode('auto', {}), 'dark');
});

test('applying a theme: its palette, the default accent for it, a preset accent in its shade, any other as given', () => {
  try {
    assert.equal(applyTheme({ theme: 'light' }, {}), 'light');
    assert.equal(theme.dim, LIGHT.dim);
    assert.equal(theme.accent, LIGHT.accent);
    applyTheme({ theme: 'light', accent: '#5fd7d7' }, {});
    assert.equal(theme.accent, '#008787', 'teal, as it reads on white');
    applyTheme({ theme: 'light', accent: '#123456' }, {});
    assert.equal(theme.accent, '#123456');
    applyTheme({ theme: 'dark', accent: '#5fd7d7' }, {});
    assert.equal(theme.accent, '#5fd7d7');
    assert.equal(theme.ink, DARK.ink);
    // Every colour the dark palette has, the light one has too.
    assert.deepEqual(Object.keys(LIGHT).sort(), Object.keys(DARK).sort());
  } finally {
    applyTheme({}, {});
  }
});
