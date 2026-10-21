import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keymapSection, parseKey, parseKeymap, translateKey } from '../src/keymap.js';

test('key names: letters, ctrl, alt, shift+tab, function keys and named keys, written any way', () => {
  assert.deepEqual(parseKey('x'), { name: 'x', seq: 'x', seqs: ['x'] });
  assert.equal(parseKey('X').seq, 'X');
  assert.equal(parseKey('shift+x').name, 'X');
  assert.equal(parseKey('+').seq, '+');
  assert.deepEqual(parseKey('ctrl+s'), { name: 'ctrl+s', seq: '\x13', seqs: ['\x13'] });
  assert.equal(parseKey('Ctrl+S').name, 'ctrl+s');
  assert.equal(parseKey('alt+x').seq, '\x1bx');
  assert.equal(parseKey('meta+x').name, 'alt+x');
  assert.equal(parseKey('shift+tab').seq, '\x1b[Z');
  assert.equal(parseKey('F5').seq, '\x1b[15~');
  assert.equal(parseKey('f1').name, 'f1');
  assert.deepEqual(parseKey('F1').seqs, ['\x1bOP', '\x1b[11~']);
  assert.equal(parseKey('enter').seq, '\r');
  assert.equal(parseKey('↵').name, 'enter');
  assert.equal(parseKey('Return').name, 'enter');
  assert.equal(parseKey('escape').name, 'esc');
  assert.equal(parseKey('space').seq, ' ');
  assert.equal(parseKey(' ').name, 'space');
  assert.equal(parseKey('↑').seq, '\x1b[A');
  assert.equal(parseKey('pgdn').name, 'pagedown');
});

test("key names terminals can't send, or that mean another key, are refused with why", () => {
  assert.match(parseKey('ctrl+shift+x').error, /ctrl with shift/);
  assert.match(parseKey('ctrl+i').error, /same as tab/);
  assert.match(parseKey('ctrl+m').error, /same as enter/);
  assert.match(parseKey('ctrl+c').error, /always quits/);
  assert.match(parseKey('ctrl+1').error, /ctrl goes with a letter/);
  assert.match(parseKey('hyper+x').error, /isn't ctrl, alt or shift/);
  assert.match(parseKey('shift+1').error, /shift goes with a letter/);
  assert.match(parseKey('shift+enter').error, /shift\+tab is/);
  assert.match(parseKey('ctrl+up').error, /use a letter/);
  assert.match(parseKey('banana').error, /isn't a key name/);
  assert.match(parseKey('').error, /empty/);
});

test('a keymap: keys to keys or command lines, per view and anywhere, and what was wrong with it', () => {
  const km = parseKeymap({ global: { 'ctrl+s': '/commit', F5: '!status' }, graph: { x: 'X', F1: 'shift+tab' }, grpah: { a: 'b' }, changes: { 'ctrl+i': 'a', q: 'nonsense key' }, stash: 'x' }, ['graph', 'changes', 'stash']);
  assert.deepEqual(translateKey(km, 'graph', 'x'), { name: 'x', to: 'X', key: parseKey('X') });
  assert.equal(translateKey(km, 'changes', 'x'), null, 'only in the graph');
  assert.equal(translateKey(km, 'changes', '\x13').command, '/commit');
  assert.equal(translateKey(km, 'graph', '\x1b[15~').command, '!status');
  // Every form a key comes in.
  assert.equal(translateKey(km, 'graph', '\x1b[11~').key.seq, '\x1b[Z');
  assert.deepEqual(km.rows.map((r) => `${r.view} ${r.name} ${r.to}`), ['global ctrl+s /commit', 'global f5 !status', 'graph x X', 'graph f1 shift+tab']);
  assert.equal(km.problems.length, 4);
  assert.match(km.problems[0], /"grpah" isn't a view: use global, graph, changes, stash/);
  assert.match(km.problems[1], /changes: "ctrl\+i" is the same as tab/);
  assert.match(km.problems[2], /changes: q → "nonsense key" isn't a key name/);
  assert.match(km.problems[3], /stash: should be an object/);
  assert.deepEqual(parseKeymap(undefined, []).problems, []);
  assert.match(parseKeymap([], []).problems[0], /should be an object/);
});

test("the keymap as a section of the ? window, anywhere first, then each view's", () => {
  const km = parseKeymap({ graph: { x: 'X' }, global: { 'ctrl+s': '/commit' } }, ['graph']);
  const s = keymapSection(km, { graph: 'Graph' });
  assert.equal(s.title, 'Your keys');
  assert.deepEqual(s.rows, [{ heading: 'Anywhere' }, ['ctrl+s', 'runs /commit'], { heading: 'Graph' }, ['x', 'does what X does']]);
  assert.equal(keymapSection(parseKeymap({}, []), {}), null);
});
