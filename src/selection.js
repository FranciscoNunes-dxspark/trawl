// Selecting text with the mouse. While Trawl asks for the mouse the terminal can't select by itself,
// so Trawl does it: it keeps the last frame Ink drew, works out which cells a drag covers, paints them
// in reverse video and copies their text. Pure, so it's tested without a terminal; mouse.js uses it.
import { oneByOne, stringWidth } from './text.js';

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
export const stripAnsi = (s) => s.replace(ANSI, '');

/**
 * The lines of a frame Ink wrote (styled, from the top of the screen), or null when `data` isn't one.
 * Ink moves up over the last frame and erases it first; those moves go, styles (…m) stay.
 */
export function frameLines(data) {
  if (typeof data !== 'string' || !data.includes('\n')) return null;
  return data.replace(/^(?:\x1b\[[0-9;?]*[A-LN-Za-ln-z])+/, '').replace(/\n$/, '').split('\n');
}

const graphemes = new Intl.Segmenter();

/** A plain line as cells: each character with the column it starts at and how many it covers. */
function cells(plain) {
  const out = [];
  let col = 0;
  // Where no character joins the next, each is a cell, without the cost of segmenting.
  for (const segment of oneByOne(plain) ? plain : Array.from(graphemes.segment(plain), (g) => g.segment)) {
    const w = stringWidth(segment);
    out.push({ text: segment, col, w });
    col += w;
  }
  return out;
}

/**
 * What a drag from `a` to `b` (screen cells, { x, y }) selects in `lines`, as a terminal does it: from
 * the start to the end of the first row, every row between, and the last row up to the end. Each row is
 * { y, col, text }, `col` being where `text` starts; a wide character is taken whole.
 */
export function selectionRows(lines, a, b) {
  const [s, e] = a.y < b.y || (a.y === b.y && a.x <= b.x) ? [a, b] : [b, a];
  const rows = [];
  for (let y = Math.max(0, s.y); y <= e.y && y < lines.length; y++) {
    const from = y === s.y ? s.x : 0;
    const to = y === e.y ? e.x : Infinity;
    const picked = cells(stripAnsi(lines[y])).filter((c) => c.col + Math.max(1, c.w) > from && c.col <= to);
    rows.push({ y, col: picked[0]?.col ?? from, text: picked.map((c) => c.text).join('') });
  }
  return rows;
}

/** The text to copy: the rows' text, trailing spaces trimmed, one line each. */
export const selectedText = (rows) => rows.map((r) => r.text.trimEnd()).join('\n');

/** Asks the terminal to put `text` on the clipboard (OSC 52). Windows Terminal, iTerm2, kitty, WezTerm and VS Code do. */
export const osc52 = (text) => `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`;
