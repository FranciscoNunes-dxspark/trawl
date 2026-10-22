import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKeymap } from '../src/keymap.js';
import { filterItems, fuzzyScore, keyItems, paletteItems, rowKeys } from '../src/palette.js';

test('the fuzzy score: in order, ignoring case; whole words, word starts and the start count for more', () => {
  assert.equal(fuzzyScore('xyz', 'commit'), null);
  assert.equal(fuzzyScore('tmc', 'commit'), null, 'in order only');
  assert.ok(fuzzyScore('cmt', 'commit') > 0);
  assert.ok(fuzzyScore('COMMIT', 'commit') > 0);
  assert.ok(fuzzyScore('commit', '/commit') > fuzzyScore('commit', '/fixup a commit'), 'nearer the start');
  assert.ok(fuzzyScore('sta', 'stash') > fuzzyScore('sta', 'unstage all'), 'at the start of a word');
  assert.ok(fuzzyScore('ch', 'checkout') > fuzzyScore('ch', 'cherry'.replace('h', 'x') + 'h'), 'side by side');
  assert.ok(fuzzyScore('stash file', 'Stash just this file') > 0, 'each word on its own');
  assert.equal(fuzzyScore('file stash', 'Stash just this file') > 0, true, 'in any order');
  assert.equal(fuzzyScore('', 'anything'), 0);
  assert.equal(fuzzyScore('cmt', 'commit', { loose: false }), null, 'whole words only');
});

test('filtering: best first, ties in the order they came, everything without a query', () => {
  const items = [{ label: '/fetch', desc: 'Fetch all remotes' }, { label: 'f', desc: 'Fetch all' }, { label: '/fixup', desc: 'Make the staged changes a fix' }, { label: '/push', desc: 'Push the branch' }];
  assert.deepEqual(filterItems(items, ''), items);
  assert.deepEqual(filterItems(items, 'fetch').map((i) => i.label), ['/fetch', 'f']);
  assert.deepEqual(filterItems(items, 'fx').map((i) => i.label), ['/fixup']);
  assert.deepEqual(filterItems(items, 'nothing like it'), []);
});

test("a help row's keys: several keys, ↵, ctrl+x, x/Y; words that aren't keys left out", () => {
  assert.deepEqual(rowKeys('c  A').map((k) => k.name), ['c', 'A']);
  assert.deepEqual(rowKeys('↵ or i').map((k) => k.name), ['enter', 'i']);
  assert.deepEqual(rowKeys('j k / ↑ ↓').map((k) => k.name), ['j', 'k', 'up', 'down']);
  assert.deepEqual(rowKeys('1-6 / tab').map((k) => k.name), ['tab']);
  assert.deepEqual(rowKeys('ctrl+z  ctrl+y').map((k) => k.name), ['ctrl+z', 'ctrl+y']);
  assert.deepEqual(rowKeys('/find <text>'), []);
  assert.deepEqual(rowKeys('Typing'), []);
  assert.deepEqual(rowKeys('mouse'), []);
});

test("a view's keys as palette items: a key each where the row says one thing per key", () => {
  const sections = [{ title: 'Changes', rows: [['c  A', 'Commit · Amend the last commit\nmore'], ['space', 'Stage it'], ['j k  g G', 'Move'], 'a note', { heading: 'Sub' }, ['Typing', 'text'], ['ctrl+p', 'the palette']] }];
  assert.deepEqual(
    keyItems(sections, { skip: ['ctrl+p'] }).map((i) => [i.label, i.desc, i.group, i.key.seq]),
    [
      ['c', 'Commit', 'Changes', 'c'],
      ['A', 'Amend the last commit', 'Changes', 'A'],
      ['space', 'Stage it', 'Changes', ' '],
      ['j k  g G', 'Move', 'Changes', 'j'],
    ],
  );
});

test('the palette: the view’s keys, your keys there and anywhere, your commands, then the built-in ones', () => {
  const keymap = parseKeymap({ global: { F5: '/fetch' }, graph: { x: 'X' }, changes: { y: 'a' } }, ['graph', 'changes']);
  const items = paletteItems({
    commands: [{ name: 'fetch', desc: 'Fetch' }, { name: 'commit', args: '<message>', desc: 'Commit' }],
    user: [{ name: 'nuke', args: null, desc: '!clean -fdx' }],
    sections: [{ title: 'Graph', rows: [['↵', 'Full diff']] }],
    keymap,
    view: 'graph',
  });
  assert.deepEqual(
    items.map((i) => [i.label, i.group, i.command ?? i.key.seq, Boolean(i.ask)]),
    [
      ['↵', 'Graph', '\r', false],
      ['f5', 'Your keys', '/fetch', false],
      ['x', 'Your keys', 'X', false],
      ['/nuke', 'Your commands', '/nuke', false],
      ['/fetch', 'Slash commands', '/fetch', false],
      ['/commit', 'Slash commands', '/commit', true],
    ],
  );
});
