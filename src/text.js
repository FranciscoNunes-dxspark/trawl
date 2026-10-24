import fullWidth from 'string-width';
import cliTruncate from 'cli-truncate';

// Nearly everything drawn is printable ASCII, where a column is a character. string-width and
// cli-truncate handle the rest (wide CJK, emoji), but cost far more on every row of every render.
const ASCII = /^[\x20-\x7e]*$/;

// Characters that are always a cell of their own, never joined to the next (no combining marks, zero
// width joiners, variation selectors, skin tones, flags or Hangul jamo): Latin, Greek, Cyrillic,
// punctuation, arrows, box drawing, shapes (❯ ●), dingbats, CJK, kana, full-width forms and single
// emoji. A string of only these is as wide as its characters added up, each measured once; anything
// else (and ANSI codes) goes to string-width whole. test/text.test.js checks these ranges.
const SIMPLE =
  /^[\x20-\x7e\xa0-\u02ff\u0370-\u0482\u2010-\u2027\u2030-\u205e\u2070-\u20cf\u2100-\u27bf\u2800-\u2bff\u3000-\u3029\u3030-\u303f\u3041-\u3098\u309b-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff01-\uff9d\u{1f300}-\u{1f3fa}\u{1f400}-\u{1faff}]*$/u;

/** Whether every character of `s` is a grapheme of its own (none joins the next), as most text is. */
export const oneByOne = (s) => SIMPLE.test(s);

// Per character of SIMPLE: [its width as string-width counts it, its width as cli-truncate cuts it].
// cli-truncate's slice-ansi counts differently (an emoji outside the BMP as one column), and the
// probe asks it, so a cut lands where cli-truncate's would.
const chars = new Map();
function charWidths(ch) {
  let w = chars.get(ch);
  if (!w) chars.set(ch, (w = [fullWidth(ch), cliTruncate(`${ch}   `, 2) === '…' ? 2 : 1]));
  return w;
}

// string-width's answers for the rest (❤️, 👍🏽, Hangul, accents typed as combining marks), which are
// mostly the same rows drawn again on the next frame.
const others = new Map();
function otherWidth(s) {
  let w = others.get(s);
  if (w === undefined) {
    if (others.size >= 2000) others.clear();
    others.set(s, (w = fullWidth(s)));
  }
  return w;
}

/** Columns `s` takes up in the terminal. */
export function stringWidth(s) {
  if (ASCII.test(s)) return s.length;
  if (!SIMPLE.test(s)) return otherWidth(s);
  let w = 0;
  for (const ch of s) w += charWidths(ch)[0];
  return w;
}

/** Cuts `s` to `width` columns, ending in "…" (only called when it's wider). */
function truncate(s, width) {
  if (ASCII.test(s)) return width <= 1 ? '…'.slice(0, width) : `${s.slice(0, width - 1)}…`;
  if (!SIMPLE.test(s)) return cliTruncate(s, width);
  if (width < 1) return '';
  let out = '';
  let used = 0;
  for (const ch of s) {
    used += charWidths(ch)[1];
    if (used > width - 1) break;
    out += ch;
  }
  return `${out}…`;
}

/** Makes a line safe to draw: tabs become spaces, control characters (and \r from CRLF files) go. */
export function clean(s) {
  if (!s) return '';
  if (!/[\x00-\x1f\x7f]/.test(s)) return s;
  let out = '';
  for (const ch of s) {
    if (ch === '\t') out += ' '.repeat(4 - (out.length % 4));
    else if (ch >= ' ' && ch !== '\x7f') out += ch;
  }
  return out;
}

/** Truncates or pads `text` to exactly `width` columns. */
export function fit(text, width, align = 'left') {
  if (width <= 0) return '';
  const t = clean(String(text ?? ''));
  const w = stringWidth(t);
  if (w > width) return truncate(t, width);
  const pad = ' '.repeat(width - w);
  return align === 'right' ? pad + t : t + pad;
}

/**
 * Cuts a row of styled segments ({ text, color, ... }) down to `width` columns,
 * truncating the segment that crosses the edge, and pads the rest with spaces.
 */
export function fitSegments(segments, width, pad = true) {
  const out = [];
  let left = Math.max(0, width);
  for (const seg of segments) {
    if (!seg || !seg.text || left <= 0) continue;
    const text = clean(seg.text);
    const w = stringWidth(text);
    if (w <= left) {
      out.push(text === seg.text ? seg : { ...seg, text });
      left -= w;
    } else {
      out.push({ ...seg, text: truncate(text, left) });
      left = 0;
    }
  }
  if (pad && left > 0) out.push({ text: ' '.repeat(left) });
  return out;
}

/** Word-wraps plain text to `width` columns. */
export function wrap(text, width) {
  const lines = [];
  // Split before cleaning: clean() drops control characters, newlines included.
  for (const para of text.replace(/\r/g, '').split('\n').map(clean)) {
    // Most lines are printable ASCII that fits as it is, less its leading spaces (the words below
    // drop them too).
    const fits = para[0] === ' ' ? para.trimStart() : para;
    if (fits.length <= width && ASCII.test(fits)) {
      lines.push(fits);
      continue;
    }
    let line = '';
    // While no character joins another, words joined by a space are as wide as their widths added
    // up, so the line's width is kept as it grows rather than measured again for every word.
    let lineW = 0;
    let simple = true;
    for (const word of para.split(' ')) {
      const one = oneByOne(word);
      const nextW = !line ? stringWidth(word) : simple && one ? lineW + 1 + stringWidth(word) : stringWidth(`${line} ${word}`);
      if (nextW <= width || !line) {
        simple = line ? simple && one : one;
        line = line ? `${line} ${word}` : word;
        lineW = nextW;
      } else {
        lines.push(line);
        line = word;
        lineW = stringWidth(word);
        simple = one;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** How long ago `ms` (a timestamp) was, in a few characters: now, 5m, 3h, 2d, 4mo, 1y. */
export function relTime(ms, now = Date.now()) {
  const d = Math.max(0, (now - ms) / 1000);
  if (d < 60) return 'now';
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}d`;
  if (d < 86400 * 365) return `${Math.floor(d / (86400 * 30))}mo`;
  return `${Math.floor(d / (86400 * 365))}y`;
}
