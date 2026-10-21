import fullWidth from 'string-width';
import cliTruncate from 'cli-truncate';

// Nearly everything drawn is printable ASCII, where a column is a character. string-width and
// cli-truncate handle the rest (wide CJK, emoji), but cost far more on every row of every render.
const ASCII = /^[\x20-\x7e]*$/;

/** Columns `s` takes up in the terminal. */
export function stringWidth(s) {
  return ASCII.test(s) ? s.length : fullWidth(s);
}

/** Cuts `s` to `width` columns, ending in "…". */
function truncate(s, width) {
  if (!ASCII.test(s)) return cliTruncate(s, width);
  return width <= 1 ? '…'.slice(0, width) : `${s.slice(0, width - 1)}…`;
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
    let line = '';
    for (const word of para.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (stringWidth(next) <= width || !line) line = next;
      else {
        lines.push(line);
        line = word;
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
