import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ed from '../src/editor.js';
import { highlight } from '../src/sql.js';

const typed = (text) => {
  let e = ed.fromText('');
  for (const ch of text) e = ch === '\n' ? ed.newline(e) : ed.insert(e, ch);
  return e;
};

test('typing, newlines and auto-indent', () => {
  const e = typed('SELECT *\n  FROM t\nWHERE 1 = 1');
  assert.deepEqual(e.lines, ['SELECT *', '  FROM t', '  WHERE 1 = 1']);
  assert.deepEqual([e.row, e.col], [2, 13]);
});

test('a paste splits into lines without adding indent', () => {
  let e = ed.insert({ ...ed.fromText('  x'), col: 3 }, 'a\r\nb\nc');
  assert.deepEqual(e.lines, ['  xa', 'b', 'c']);
  assert.deepEqual([e.row, e.col], [2, 1]);
  e = ed.insert({ ...ed.fromText('ab'), col: 2 }, '\t');
  assert.deepEqual(e.lines, ['ab  ']);
});

test('backspace deletes, joins lines, and steps back over indent in twos', () => {
  let e = { lines: ['ab', 'cd'], row: 1, col: 0 };
  e = ed.backspace(e);
  assert.deepEqual(e, { lines: ['abcd'], row: 0, col: 2 });
  e = ed.backspace({ lines: ['    x'], row: 0, col: 4 });
  assert.deepEqual(e, { lines: ['  x'], row: 0, col: 2 });
  assert.deepEqual(ed.backspace({ lines: ['x'], row: 0, col: 0 }), { lines: ['x'], row: 0, col: 0 });
});

test('moving keeps the column across short lines', () => {
  let e = { lines: ['long line', 'ab', 'another long'], row: 0, col: 8 };
  e = ed.move(e, { rows: 1 });
  assert.deepEqual([e.row, e.col], [1, 2]);
  e = ed.move(e, { rows: 1 });
  assert.deepEqual([e.row, e.col], [2, 8]);
  e = ed.move({ lines: ['ab', 'cd'], row: 0, col: 2 }, { cols: 1 });
  assert.deepEqual([e.row, e.col], [1, 0]);
});

test('home goes to the indent, then to column 0; ctrl+u and ctrl+k cut', () => {
  let e = { lines: ['  SELECT'], row: 0, col: 6 };
  e = ed.lineStart(e);
  assert.equal(e.col, 2);
  assert.equal(ed.lineStart(e).col, 0);
  assert.deepEqual(ed.killLine({ lines: ['abcd'], row: 0, col: 2 }).lines, ['cd']);
  assert.deepEqual(ed.killLine({ lines: ['abcd'], row: 0, col: 2 }, { toEnd: true }).lines, ['ab']);
});

test('append adds after a blank line, or replaces an empty console', () => {
  assert.deepEqual(ed.append(ed.fromText(''), 'SELECT 1'), { lines: ['SELECT 1'], row: 0, col: 0 });
  assert.deepEqual(ed.append(ed.fromText('SELECT 1\n\n'), 'SELECT 2\nFROM t'), { lines: ['SELECT 1', '', 'SELECT 2', 'FROM t'], row: 2, col: 0 });
});

test('highlighting colours keywords, strings, comments, numbers and variables', () => {
  const [line] = highlight("SELECT N'x' AS [From], 42, @id -- done");
  const kinds = Object.fromEntries(line.filter((r) => r.kind).map((r) => [r.text, r.kind]));
  assert.deepEqual(kinds, { SELECT: 'keyword', "N'x'": 'string', AS: 'keyword', 42: 'number', '@id': 'variable', '-- done': 'comment' });
  // [From] is a name, not the keyword.
  assert.ok(line.some((r) => r.text.includes('[From]') && !r.kind));
  const lines = highlight('/* one\ntwo */ SELECT');
  assert.equal(lines[1][0].kind, 'comment');
  assert.equal(lines[1].at(-1).kind, 'keyword');
});
