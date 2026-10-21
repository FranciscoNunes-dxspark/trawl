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

test('delete takes the character after the cursor, joins the next line at the end, and takes a selection', () => {
  assert.deepEqual(ed.deleteForward({ lines: ['abc'], row: 0, col: 1 }), { lines: ['ac'], row: 0, col: 1 });
  assert.deepEqual(ed.deleteForward({ lines: ['ab', 'cd'], row: 0, col: 2 }), { lines: ['abcd'], row: 0, col: 2 });
  assert.deepEqual(ed.deleteForward({ lines: ['ab'], row: 0, col: 2 }), { lines: ['ab'], row: 0, col: 2 });
  assert.deepEqual(ed.deleteForward({ lines: ['abcd'], row: 0, col: 3, anchor: { row: 0, col: 1 } }), { lines: ['ad'], row: 0, col: 1 });
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

test('a click puts the cursor on the character drawn under it', () => {
  const e = { lines: ['SELECT 1', '日本 x', 'abcdefgh'], row: 0, col: 0, anchor: { row: 0, col: 3 } };
  const at = (row, x, opts) => {
    const r = ed.clickAt(e, row, x, opts);
    return [r.row, r.col, r.anchor];
  };
  assert.deepEqual(at(0, 7), [0, 7, undefined], 'the selection goes');
  assert.deepEqual(at(0, 30), [0, 8, undefined], 'past the end: the end');
  // Wide characters take two cells: either half lands on the character.
  assert.deepEqual(at(1, 1), [1, 0, undefined]);
  assert.deepEqual(at(1, 2), [1, 1, undefined]);
  assert.deepEqual(at(1, 5), [1, 3, undefined]);
  // Scrolled sideways, the line is drawn from `left`; the gutter (x below 0) is the first one shown.
  assert.deepEqual(at(2, 1, { left: 4 }), [2, 5, undefined]);
  assert.deepEqual(at(2, -2, { left: 4 }), [2, 4, undefined]);
  assert.deepEqual(at(9, 0), [2, 8, undefined], 'below the text: its end');
});

test('a double-click selects the word, the spaces or the one character under it; a triple-click the line', () => {
  const e = { lines: ['SELECT p.Name,  @Season FROM t', ''], row: 0, col: 0 };
  const word = (col) => ed.selectedText(ed.selectWord({ ...e, col }))?.text;
  assert.equal(word(2), 'SELECT');
  assert.equal(word(9), 'Name');
  assert.equal(word(8), '.');
  assert.equal(word(14), '  ');
  assert.equal(word(18), '@Season');
  assert.equal(word(99), 't', 'past the end: the last word');
  assert.equal(ed.selection(ed.selectWord({ ...e, row: 1 })), null, 'nothing on an empty line');
  assert.equal(ed.selectedText(ed.selectLine({ ...e, col: 5 })).text, 'SELECT p.Name,  @Season FROM t');
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

test('undo steps back a word at a time, and redo forward again', () => {
  let h = ed.newHistory();
  let e = ed.fromText('');
  // Each keystroke records the state before it, as App's setConsole does.
  const key = (ch, at) => {
    const next = ch === '\n' ? ed.newline(e) : ed.insert(e, ch);
    h = ed.record(h, e, { merge: ch !== ' ' && ch !== '\n', at });
    e = next;
  };
  [...'SELECT 1'].forEach((ch, i) => key(ch, i * 10));
  assert.equal(ed.toText(e), 'SELECT 1');
  let r = ed.undo(h, e);
  assert.equal(ed.toText(r.editor), 'SELECT ');
  r = ed.undo(r.history, r.editor);
  assert.equal(ed.toText(r.editor), 'SELECT');
  r = ed.undo(r.history, r.editor);
  assert.deepEqual(r.editor, { lines: [''], row: 0, col: 0 });
  assert.equal(ed.undo(r.history, r.editor), null);
  r = ed.redo(r.history, r.editor);
  assert.equal(ed.toText(r.editor), 'SELECT');
  r = ed.redo(r.history, r.editor);
  r = ed.redo(r.history, r.editor);
  assert.deepEqual([ed.toText(r.editor), r.editor.col], ['SELECT 1', 8]);
  assert.equal(ed.redo(r.history, r.editor), null);
});

test('a pause or another line starts a new undo step, and an edit drops what was undone', () => {
  let h = ed.record(ed.newHistory(), { lines: [''], row: 0, col: 0 }, { merge: true, at: 0 });
  h = ed.record(h, { lines: ['a'], row: 0, col: 1 }, { merge: true, at: 2000 });
  assert.equal(h.past.length, 2);
  h = ed.record(h, { lines: ['ab', ''], row: 1, col: 0 }, { merge: true, at: 2010 });
  assert.equal(h.past.length, 3);
  const r = ed.undo(h, { lines: ['ab', 'c'], row: 1, col: 1 });
  assert.equal(r.history.future.length, 1);
  assert.equal(ed.record(r.history, r.editor).future.length, 0);
});

test('ctrl+arrows move a word at a time, and ctrl+w deletes one', () => {
  const e = { lines: ['SELECT p.Name, x', 'FROM t'], row: 0, col: 16 };
  assert.equal(ed.wordMove(e, -1).col, 15);
  assert.equal(ed.wordMove({ ...e, col: 13 }, -1).col, 9);
  assert.equal(ed.wordMove({ ...e, col: 0 }, 1).col, 6);
  assert.deepEqual([ed.wordMove(e, 1).row, ed.wordMove(e, 1).col], [1, 0]);
  assert.deepEqual([ed.wordMove({ ...e, row: 1, col: 0 }, -1).row, ed.wordMove({ ...e, row: 1, col: 0 }, -1).col], [0, 16]);
  assert.deepEqual(ed.deleteWordBack({ lines: ['SELECT Name  '], row: 0, col: 13 }), { lines: ['SELECT '], row: 0, col: 7 });
});

test('shift selects; typing or backspace replaces the selection, and moving lets it go', () => {
  let e = { lines: ['SELECT 1', 'SELECT 2'], row: 0, col: 7 };
  e = ed.extend(e, (x) => ed.move(x, { rows: 1 }));
  assert.deepEqual(ed.selection(e), { start: { row: 0, col: 7 }, end: { row: 1, col: 7 } });
  assert.deepEqual(ed.selectedText(e), { text: '1\nSELECT ', row: 0 });
  assert.ok(ed.isSelected(ed.selection(e), 1, 0) && !ed.isSelected(ed.selection(e), 1, 7));
  assert.deepEqual(ed.insert(e, 'x'), { lines: ['SELECT x2'], row: 0, col: 8 });
  assert.deepEqual(ed.backspace(e), { lines: ['SELECT 2'], row: 0, col: 7 });
  assert.equal(ed.move(e, { cols: 1 }).anchor, undefined);
  // Selecting backwards works the same.
  const back = ed.extend({ lines: ['abcdef'], row: 0, col: 4 }, (x) => ed.wordMove(x, -1));
  assert.deepEqual(ed.selectedText(back), { text: 'abcd', row: 0 });
});

test('find selects the next match, wraps round, and goes back', () => {
  const e = { lines: ['SELECT Name', 'FROM t WHERE name = 1'], row: 0, col: 0 };
  let f = ed.find(e, 'NAME');
  assert.deepEqual(ed.selectedText(f), { text: 'Name', row: 0 });
  f = ed.find(f, 'name');
  assert.deepEqual([f.anchor, f.row, f.col], [{ row: 1, col: 13 }, 1, 17]);
  assert.deepEqual(ed.find(f, 'name').anchor, { row: 0, col: 7 });
  assert.deepEqual(ed.find(e, 'name', { back: true }).anchor, { row: 1, col: 13 });
  assert.equal(ed.find(e, 'nope'), null);
});
