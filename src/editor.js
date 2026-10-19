// The console's text editing, as pure functions over { lines, row, col }. The UI only maps keys
// to these, so every edit can be tested without a terminal.

export const fromText = (text) => {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  return { lines, row: 0, col: 0 };
};

export const toText = (ed) => ed.lines.join('\n');

const clampCol = (ed, row, col) => Math.max(0, Math.min(col, ed.lines[row].length));

/** Inserts text at the cursor. A pasted newline splits the line; a typed one keeps the indent. */
export function insert(ed, text, { indent = false } = {}) {
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

/** Deletes the character before the cursor, joining lines at the start of one. */
export function backspace(ed) {
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
    return { ...ed, row, col: clampCol(ed, row, col), goal: undefined };
  }
  const row = Math.max(0, Math.min(ed.lines.length - 1, ed.row + rows));
  const goal = ed.goal ?? ed.col;
  return { ...ed, row, col: clampCol(ed, row, goal), goal };
}

/** Home: to the first non-space character, or to column 0 when already there. */
export function lineStart(ed) {
  const indent = ed.lines[ed.row].match(/^\s*/)[0].length;
  return { ...ed, col: ed.col === indent ? 0 : indent, goal: undefined };
}

export const lineEnd = (ed) => ({ ...ed, col: ed.lines[ed.row].length, goal: undefined });

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
