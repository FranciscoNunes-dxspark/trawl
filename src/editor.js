// The console's text editing, as pure functions over { lines, row, col }. The UI only maps keys
// to these, so every edit can be tested without a terminal.
import { stringWidth } from './text.js';

export const fromText = (text) => {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  return { lines, row: 0, col: 0 };
};

export const toText = (ed) => ed.lines.join('\n');

const clampCol = (ed, row, col) => Math.max(0, Math.min(col, ed.lines[row].length));
// Moving without shift drops the selection.
const plain = ({ anchor, ...ed }) => ed;

/** Inserts text at the cursor. A pasted newline splits the line; a typed one keeps the indent. */
export function insert(ed, text, { indent = false } = {}) {
  if (selection(ed)) ed = deleteSelection(ed);
  const parts = String(text).replace(/\r\n?/g, '\n').replace(/\t/g, '  ').split('\n');
  const line = ed.lines[ed.row];
  const before = line.slice(0, ed.col);
  const after = line.slice(ed.col);
  if (parts.length === 1) {
    const lines = [...ed.lines];
    lines[ed.row] = before + parts[0] + after;
    return { lines, row: ed.row, col: ed.col + parts[0].length };
  }
  const lead = indent ? before.match(/^\s*/)[0] : '';
  const middle = parts.slice(1, -1);
  const last = lead + parts.at(-1);
  const lines = [...ed.lines.slice(0, ed.row), before + parts[0], ...middle, last + after, ...ed.lines.slice(ed.row + 1)];
  return { lines, row: ed.row + parts.length - 1, col: last.length };
}

/** Enter: a new line under the cursor, indented like the one it came from. */
export const newline = (ed) => insert(ed, '\n', { indent: true });

/** Deletes the character before the cursor, joining lines at the start of one, or the selection. */
export function backspace(ed) {
  if (selection(ed)) return deleteSelection(ed);
  if (ed.col > 0) {
    const lines = [...ed.lines];
    const line = lines[ed.row];
    // Inside leading spaces, go back to the previous two-space stop, as editors do.
    const n = /^\s+$/.test(line.slice(0, ed.col)) && ed.col % 2 === 0 && line[ed.col - 2] === ' ' ? 2 : 1;
    lines[ed.row] = line.slice(0, ed.col - n) + line.slice(ed.col);
    return { lines, row: ed.row, col: ed.col - n };
  }
  if (ed.row === 0) return ed;
  const lines = [...ed.lines];
  const prev = lines[ed.row - 1];
  lines.splice(ed.row - 1, 2, prev + lines[ed.row]);
  return { lines, row: ed.row - 1, col: prev.length };
}

/** The delete key: the character after the cursor goes, or at a line's end the next line joins it. */
export function deleteForward(ed) {
  if (selection(ed)) return deleteSelection(ed);
  const line = ed.lines[ed.row];
  if (ed.col < line.length) {
    const lines = [...ed.lines];
    lines[ed.row] = line.slice(0, ed.col) + line.slice(ed.col + 1);
    return { lines, row: ed.row, col: ed.col };
  }
  if (ed.row === ed.lines.length - 1) return ed;
  const lines = [...ed.lines];
  lines.splice(ed.row, 2, line + lines[ed.row + 1]);
  return { lines, row: ed.row, col: ed.col };
}

/** Moves the cursor by rows or columns; up/down keep the column where they can. */
export function move(ed, { rows = 0, cols = 0 }) {
  if (cols) {
    let { row, col } = ed;
    col += cols;
    if (col < 0 && row > 0) (row--, (col = ed.lines[row].length));
    else if (col > ed.lines[row].length && row < ed.lines.length - 1) (row++, (col = 0));
    return { ...plain(ed), row, col: clampCol(ed, row, col), goal: undefined };
  }
  const row = Math.max(0, Math.min(ed.lines.length - 1, ed.row + rows));
  const goal = ed.goal ?? ed.col;
  return { ...plain(ed), row, col: clampCol(ed, row, goal), goal };
}

/** Home: to the first non-space character, or to column 0 when already there. */
export function lineStart(ed) {
  const indent = ed.lines[ed.row].match(/^\s*/)[0].length;
  return { ...plain(ed), col: ed.col === indent ? 0 : indent, goal: undefined };
}

export const lineEnd = (ed) => ({ ...plain(ed), col: ed.lines[ed.row].length, goal: undefined });

/**
 * A click on the text: the cursor goes to line `row`, on the character drawn `x` cells into it when
 * the line is drawn from column `left` (wide characters take two cells). Past the end of a line is
 * its end; below the last line, the end of the text.
 */
export function clickAt(ed, row, x, { left = 0 } = {}) {
  if (row >= ed.lines.length) return lineEnd({ ...ed, row: ed.lines.length - 1 });
  const r = Math.max(0, row);
  const line = ed.lines[r];
  let col = Math.min(left, line.length);
  for (let cells = 0; col < line.length; ) {
    const ch = String.fromCodePoint(line.codePointAt(col));
    const w = stringWidth(ch);
    if (cells + w > x) break;
    cells += w;
    col += ch.length;
  }
  return { ...plain(ed), row: r, col, goal: undefined };
}

const WORD = /[\w@#$]/;

/** ctrl+← and ctrl+→: to the start of this word or the one before, or past the end of the next. */
export function wordMove(ed, dir) {
  let { row, col } = ed;
  const line = () => ed.lines[row];
  if (dir < 0) {
    if (col === 0 && row > 0) return { ...plain(ed), row: row - 1, col: ed.lines[row - 1].length, goal: undefined };
    while (col > 0 && !WORD.test(line()[col - 1])) col--;
    while (col > 0 && WORD.test(line()[col - 1])) col--;
  } else {
    if (col === line().length && row < ed.lines.length - 1) return { ...plain(ed), row: row + 1, col: 0, goal: undefined };
    while (col < line().length && !WORD.test(line()[col])) col++;
    while (col < line().length && WORD.test(line()[col])) col++;
  }
  return { ...plain(ed), row, col, goal: undefined };
}

/** ctrl+home and ctrl+end: the start of the text, and its end. */
export const textStart = (ed) => ({ ...plain(ed), row: 0, col: 0, goal: undefined });
export const textEnd = (ed) => ({ ...plain(ed), row: ed.lines.length - 1, col: ed.lines.at(-1).length, goal: undefined });

/** ctrl+delete: deletes forward to the end of the word (and the spaces before it). */
export function deleteWordForward(ed) {
  if (selection(ed)) return deleteSelection(ed);
  if (ed.col === ed.lines[ed.row].length) return deleteForward(ed);
  const to = wordMove(ed, 1).col;
  const lines = [...ed.lines];
  lines[ed.row] = lines[ed.row].slice(0, ed.col) + lines[ed.row].slice(to);
  return { lines, row: ed.row, col: ed.col };
}

/** ctrl+w: deletes back to the start of the word (and the spaces after it), as in a shell. */
export function deleteWordBack(ed) {
  if (selection(ed)) return deleteSelection(ed);
  if (ed.col === 0) return backspace(ed);
  const to = wordMove(ed, -1).col;
  const lines = [...ed.lines];
  lines[ed.row] = lines[ed.row].slice(0, to) + lines[ed.row].slice(ed.col);
  return { lines, row: ed.row, col: to };
}

// Selection: `anchor` is where it started ({ row, col }) and the cursor is the other end.

/** A double-click: the word under the cursor selected, or the run of spaces, or the one character. */
export function selectWord(ed) {
  const line = ed.lines[ed.row];
  if (!line) return plain(ed);
  const kind = (ch) => (WORD.test(ch) ? 'word' : /\s/.test(ch) ? 'space' : 'other');
  const at = Math.min(ed.col, line.length - 1);
  const k = kind(line[at]);
  let from = at;
  let to = at + 1;
  if (k !== 'other') {
    while (from > 0 && kind(line[from - 1]) === k) from--;
    while (to < line.length && kind(line[to]) === k) to++;
  }
  return { lines: ed.lines, row: ed.row, col: to, anchor: { row: ed.row, col: from } };
}

/** A triple-click: the cursor's line selected, end to end. */
export const selectLine = (ed) => ({ lines: ed.lines, row: ed.row, col: ed.lines[ed.row].length, anchor: { row: ed.row, col: 0 } });

/** ctrl+a: all the text selected, the cursor at its end. */
export const selectAll = (ed) => ({ lines: ed.lines, row: ed.lines.length - 1, col: ed.lines.at(-1).length, anchor: { row: 0, col: 0 } });

/** Applies a movement with shift held: the selection grows from where it started. */
export function extend(ed, moveFn) {
  const anchor = ed.anchor ?? { row: ed.row, col: ed.col };
  return { ...moveFn(plain(ed)), anchor };
}

/** The selection in order, { start, end }, or null when nothing is selected. */
export function selection(ed) {
  const a = ed.anchor;
  if (!a || (a.row === ed.row && a.col === ed.col)) return null;
  const cur = { row: ed.row, col: ed.col };
  const first = a.row < cur.row || (a.row === cur.row && a.col < cur.col);
  return first ? { start: a, end: cur } : { start: cur, end: a };
}

/** The selected text, with the line it starts on: { text, row }, or null. */
export function selectedText(ed) {
  const sel = selection(ed);
  if (!sel) return null;
  const { start, end } = sel;
  if (start.row === end.row) return { text: ed.lines[start.row].slice(start.col, end.col), row: start.row };
  const lines = ed.lines.slice(start.row, end.row + 1);
  lines[0] = lines[0].slice(start.col);
  lines[lines.length - 1] = lines.at(-1).slice(0, end.col);
  return { text: lines.join('\n'), row: start.row };
}

/** Removes the selected text, leaving the cursor where it began. */
export function deleteSelection(ed) {
  const sel = selection(ed);
  if (!sel) return plain(ed);
  const { start, end } = sel;
  const lines = [...ed.lines.slice(0, start.row), ed.lines[start.row].slice(0, start.col) + ed.lines[end.row].slice(end.col), ...ed.lines.slice(end.row + 1)];
  return { lines, row: start.row, col: start.col };
}

/**
 * ctrl+x: the selection taken out, or with nothing selected the cursor's whole line, as VS Code
 * does. { editor, text } with the text for the clipboard, or null when there's nothing to cut.
 */
export function cut(ed) {
  const sel = selectedText(ed);
  if (sel) return { editor: deleteSelection(ed), text: sel.text };
  if (ed.lines.length === 1 && !ed.lines[0]) return null;
  const lines = ed.lines.filter((_, i) => i !== ed.row);
  if (!lines.length) lines.push('');
  return { editor: { lines, row: Math.min(ed.row, lines.length - 1), col: 0 }, text: `${ed.lines[ed.row]}\n` };
}

// The first and last row a command on "the line" works on: the cursor's, or every line the selection
// touches. A selection ending at the start of a line doesn't take that line, as editors do.
function touchedRows(ed) {
  const sel = selection(ed);
  if (!sel) return [ed.row, ed.row];
  return [sel.start.row, sel.end.col === 0 && sel.end.row > sel.start.row ? sel.end.row - 1 : sel.end.row];
}

// Applies `edits` (row → { line, at, by }: the new text, which gained `by` characters at column `at`,
// or lost them when `by` is negative), carrying the cursor and the selection's anchor along. A point
// at column 0 stays there, so a selection of whole lines still is one.
function relined(ed, edits) {
  const lines = [...ed.lines];
  for (const [row, e] of edits) lines[row] = e.line;
  const col = (p) => {
    const e = edits.get(p.row);
    return !e || p.col === 0 || p.col < e.at ? p.col : Math.max(e.at, p.col + e.by);
  };
  const next = { lines, row: ed.row, col: col(ed) };
  return ed.anchor ? { ...next, anchor: { row: ed.anchor.row, col: col(ed.anchor) } } : next;
}

/**
 * ctrl+/: the cursor's line, or the selected lines, commented out with "-- " at the least indent
 * among them, or back in when every one that isn't blank already is.
 */
export function toggleComment(ed) {
  const [from, to] = touchedRows(ed);
  const rows = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const filled = rows.filter((r) => ed.lines[r].trim());
  const indent = (r) => ed.lines[r].match(/^\s*/)[0].length;
  const edits = new Map();
  if (filled.length && filled.every((r) => /^\s*--/.test(ed.lines[r]))) {
    for (const r of filled) {
      const [line, at] = [ed.lines[r], indent(r)];
      const n = line.startsWith('-- ', at) ? 3 : 2;
      edits.set(r, { line: line.slice(0, at) + line.slice(at + n), at, by: -n });
    }
  } else {
    const targets = filled.length ? filled : rows;
    const at = Math.min(...targets.map(indent));
    for (const r of targets) edits.set(r, { line: `${ed.lines[r].slice(0, at)}-- ${ed.lines[r].slice(at)}`, at, by: 3 });
  }
  return relined(ed, edits);
}

/** tab (`dir` 1) and shift+tab (-1) over lines: two spaces more on each that isn't blank, or up to two fewer. */
export function indentLines(ed, dir) {
  const [from, to] = touchedRows(ed);
  const edits = new Map();
  for (let r = from; r <= to; r++) {
    const line = ed.lines[r];
    const n = dir > 0 ? (line.trim() ? 2 : 0) : Math.min(2, line.match(/^ */)[0].length);
    if (n) edits.set(r, { line: dir > 0 ? `  ${line}` : line.slice(n), at: 0, by: dir * n });
  }
  return relined(ed, edits);
}

/** ctrl+d: the selection written again after itself (and the copy selected), or with none the cursor's line again under it. */
export function duplicate(ed) {
  const sel = selection(ed);
  if (sel) return { ...insert({ lines: ed.lines, row: sel.end.row, col: sel.end.col }, selectedText(ed).text), anchor: sel.end };
  const lines = [...ed.lines];
  lines.splice(ed.row + 1, 0, ed.lines[ed.row]);
  return { lines, row: ed.row + 1, col: ed.col };
}

/**
 * alt+↑/↓: the cursor's line, or every line the selection touches, moved one up (`by` -1) or down,
 * the cursor and selection going with them. Null at the top or bottom.
 */
export function moveLines(ed, by) {
  const [from, to] = touchedRows(ed);
  if (from + by < 0 || to + by >= ed.lines.length) return null;
  const lines = [...ed.lines];
  lines.splice(from + by, 0, ...lines.splice(from, to - from + 1));
  const next = { lines, row: ed.row + by, col: ed.col };
  return ed.anchor ? { ...next, anchor: { row: ed.anchor.row + by, col: ed.anchor.col } } : next;
}

/** Whether column `col` of line `row` is inside the selection. */
export function isSelected(sel, row, col) {
  if (!sel || row < sel.start.row || row > sel.end.row) return false;
  if (row === sel.start.row && col < sel.start.col) return false;
  if (row === sel.end.row && col >= sel.end.col) return false;
  return true;
}

/** Deletes from the cursor to the start of the line (ctrl+u) or to its end (ctrl+k). */
export function killLine(ed, { toEnd = false } = {}) {
  const lines = [...ed.lines];
  const line = lines[ed.row];
  lines[ed.row] = toEnd ? line.slice(0, ed.col) : line.slice(ed.col);
  return { lines, row: ed.row, col: toEnd ? ed.col : 0 };
}

/** Adds `text` at the end, after a blank line, with the cursor on its first line. */
export function append(ed, text) {
  const body = String(text).replace(/\r\n?/g, '\n').split('\n');
  const empty = ed.lines.every((l) => !l.trim());
  if (empty) return { lines: body, row: 0, col: 0 };
  const lines = [...ed.lines];
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  return { lines: [...lines, '', ...body], row: lines.length + 1, col: 0 };
}

// Undo history: { past, future } of earlier and undone states. Typing a word is one step, as in
// editors: keystrokes marked `merge` on the same line within a second join the step before them.
const HISTORY_LIMIT = 500;
const MERGE_MS = 1000;

export const newHistory = () => ({ past: [], future: [] });

/** Records `prev`, the state an edit is about to replace. A new edit drops what was undone. */
export function record(history, prev, { merge = false, at = Date.now() } = {}) {
  const last = history.past.at(-1);
  if (merge && last?.merge && at - last.at < MERGE_MS && last.row === prev.row) {
    return { past: [...history.past.slice(0, -1), { ...last, at }], future: [] };
  }
  const entry = { lines: prev.lines, row: prev.row, col: prev.col, merge, at };
  return { past: [...history.past, entry].slice(-HISTORY_LIMIT), future: [] };
}

const stateOf = (e) => ({ lines: e.lines, row: e.row, col: e.col });

/** Steps back: { editor, history }, or null when there's nothing to undo. */
export function undo(history, current) {
  const last = history.past.at(-1);
  if (!last) return null;
  return { editor: stateOf(last), history: { past: history.past.slice(0, -1), future: [...history.future, stateOf(current)] } };
}

/** Steps forward again after an undo: { editor, history }, or null. */
export function redo(history, current) {
  const next = history.future.at(-1);
  if (!next) return null;
  return { editor: next, history: { past: [...history.past, { ...stateOf(current), merge: false, at: 0 }], future: history.future.slice(0, -1) } };
}

/**
 * The next place `query` appears (ignoring case) after the cursor, or before it with `back`,
 * wrapping round the end: the editor with the match selected, or null when it's nowhere.
 */
export function find(ed, query, { back = false } = {}) {
  const q = String(query ?? '').toLowerCase();
  if (!q) return null;
  const text = toText(ed).toLowerCase();
  const starts = [0];
  for (const l of ed.lines) starts.push(starts.at(-1) + l.length + 1);
  const offsetOf = (p) => starts[p.row] + p.col;
  const posOf = (off) => {
    let row = 0;
    while (row < ed.lines.length - 1 && starts[row + 1] <= off) row++;
    return { row, col: off - starts[row] };
  };
  const sel = selection(ed);
  const here = offsetOf(sel ? sel.start : ed);
  let at;
  if (back) {
    at = here > 0 ? text.lastIndexOf(q, here - 1) : -1;
    if (at < 0) at = text.lastIndexOf(q);
  } else {
    at = text.indexOf(q, sel ? here + 1 : here);
    if (at < 0) at = text.indexOf(q);
  }
  if (at < 0) return null;
  const end = posOf(at + q.length);
  return { lines: ed.lines, row: end.row, col: end.col, anchor: posOf(at) };
}
