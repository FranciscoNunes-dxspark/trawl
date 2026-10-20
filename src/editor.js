// The console's text editing, as pure functions over { lines, row, col }. The UI only maps keys
// to these, so every edit can be tested without a terminal.

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
