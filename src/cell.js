// One value of a result set in full, for the viewer `v` opens in Results: JSON pretty-printed, XML
// indented, binary as a hex dump, anything else as it is, every line folded to the viewer's width.
// Pure: the grid cuts long values short, and this is where they can be read.
import { formatValue } from './sql.js';
import { clean, stringWidth } from './text.js';

/**
 * Re-indents JSON text that parses, two spaces a level, without parsing its values: numbers too
 * big for a double and the order of keys stay exactly as the server sent them. Null when it isn't
 * a JSON object or array.
 */
export function prettyJson(text) {
  const s = String(text).trim();
  if (!/^[[{]/.test(s)) return null;
  try {
    JSON.parse(s);
  } catch {
    return null;
  }
  let out = '';
  let depth = 0;
  const newline = () => `\n${'  '.repeat(depth)}`;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      let j = i + 1;
      while (s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      out += s.slice(i, j + 1);
      i = j;
    } else if (ch === '{' || ch === '[') {
      // An empty object or array stays on its line.
      const close = s.slice(i + 1).match(/^\s*([}\]])/);
      if (close) {
        out += ch + close[1];
        i += close[0].length;
      } else {
        depth++;
        out += ch + newline();
      }
    } else if (ch === '}' || ch === ']') {
      depth--;
      out += newline() + ch;
    } else if (ch === ',') out += `,${newline()}`;
    else if (ch === ':') out += ': ';
    else if (!/\s/.test(ch)) out += ch;
  }
  return out;
}

const XML_TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<[^>]*>|[^<]+/g;

/**
 * XML a tag a line, two spaces a level; an element holding only text stays on one line. Null when
 * it doesn't look like XML (starts with < and ends with >, its tags opening and closing in turn).
 */
export function indentXml(text) {
  const s = String(text).trim();
  if (!/^<[\s\S]*>$/.test(s) || !/^<[!?A-Za-z_]/.test(s)) return null;
  const tokens = (s.match(XML_TOKEN) ?? []).map((t) => (t.startsWith('<') ? t : t.trim())).filter(Boolean);
  const lines = [];
  const open = [];
  const pad = () => '  '.repeat(open.length);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const name = t.match(/^<\/?([^\s/>!?]+)/)?.[1];
    if (t.startsWith('</')) {
      if (open.pop() !== name) return null;
      lines.push(pad() + t);
    } else if (/^<[!?]/.test(t) || t.endsWith('/>') || !t.startsWith('<')) lines.push(pad() + t);
    else if (tokens[i + 1] && !tokens[i + 1].startsWith('<') && tokens[i + 2] === `</${name}>`) {
      lines.push(pad() + t + tokens[i + 1] + tokens[i + 2]);
      i += 2;
    } else {
      lines.push(pad() + t);
      open.push(name);
    }
  }
  return open.length ? null : lines.join('\n');
}

/** Binary as a hex dump: the offset, the bytes, and those that are printable ASCII. */
export function hexDump(buf, width = 80) {
  const per = width >= 78 ? 16 : 8;
  const lines = [];
  for (let at = 0; at < buf.length; at += per) {
    const bytes = [...buf.subarray(at, at + per)];
    const hex = bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ').padEnd(per * 3 - 1);
    const text = bytes.map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${at.toString(16).toUpperCase().padStart(8, '0')}  ${hex}  ${text}`);
  }
  return lines.join('\n');
}

/**
 * Breaks a line longer than `width` columns: at a space where there is one, else anywhere, the
 * lines after it indented as it is (so nested JSON stays readable).
 */
export function fold(line, width) {
  const l = clean(line);
  if (width < 8 || stringWidth(l) <= width) return [l];
  const indent = l.match(/^ */)[0];
  const lead = indent.length < width / 2 ? indent : '';
  const out = [];
  let rest = l;
  let first = true;
  while (stringWidth(rest) > width) {
    const chars = [...rest];
    let w = 0;
    let cut = 0;
    while (cut < chars.length && w + stringWidth(chars[cut]) <= width) w += stringWidth(chars[cut++]);
    const head = chars.slice(0, cut).join('');
    // The last space past the indent, if it isn't too far back.
    const space = head.lastIndexOf(' ');
    const at = space > (first ? indent.length : lead.length) && space > cut / 2 ? space : head.length;
    out.push(head.slice(0, at).trimEnd());
    rest = lead + rest.slice(at).replace(/^ +/, '');
    first = false;
  }
  out.push(rest);
  return out;
}

const folded = (text, width) => text.replace(/\r\n?/g, '\n').split('\n').flatMap((l) => fold(l, width)).join('\n');

/**
 * The whole of a value, as the viewer shows it, `width` columns wide: { text, kind }, `kind` being
 * json, xml, binary, text or null (what's said in the title).
 */
export function cellText(v, width = 80) {
  if (v == null) return { text: 'NULL', kind: 'null' };
  if (Buffer.isBuffer(v)) return { text: v.length ? hexDump(v, width) : '(no bytes)', kind: 'binary' };
  // Postgres hands json columns over parsed.
  if (typeof v === 'object' && !(v instanceof Date)) return { text: folded(JSON.stringify(v, null, 2), width), kind: 'json' };
  const s = formatValue(v);
  const json = typeof v === 'string' ? prettyJson(s) : null;
  if (json) return { text: folded(json, width), kind: 'json' };
  const xml = typeof v === 'string' ? indentXml(s) : null;
  if (xml) return { text: folded(xml, width), kind: 'xml' };
  return { text: folded(s, width), kind: 'text' };
}
