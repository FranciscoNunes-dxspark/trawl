// /export file.xlsx: result sets as an Excel workbook, with no dependency. The parts are the least
// OOXML that Excel, LibreOffice and Google Sheets open (a workbook, a sheet per result set, styles
// for the bold header and the dates), with the text inline in the cells; `zip` packs them, deflated
// with node:zlib and checked with CRC-32. Pure.
import { deflateRawSync } from 'node:zlib';
import { isNumericType } from './sql.js';

// ---------------------------------------------------------------------------------------------------
// ZIP: local headers, the data, then the central directory (no ZIP64: a workbook stays far under 4 GB).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 of the bytes, as ZIP and PNG use it. */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// DOS time and date of a moment (local fields, as ZIP tools read them).
function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return [time, day];
}

/** A ZIP archive of `files` ([{ name, data }], data a Buffer or text as UTF-8), each deflated. */
export function zip(files, { date = new Date(2026, 0, 1) } = {}) {
  const [time, day] = dosTime(date);
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const packed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // names in UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // made by
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(day, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    parts.push(local, name, packed);
    central.push(entry, name);
    offset += local.length + name.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

// ---------------------------------------------------------------------------------------------------
// The workbook.

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

// Characters XML 1.0 can't hold at all go; the others are escaped.
const xmlText = (s) =>
  String(s)
    .replace(/[^\x09\x0a\x0d\x20-퟿-�\u{10000}-\u{10ffff}]/gu, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** A column's letters: 0 → A, 25 → Z, 26 → AA. */
export function columnLetters(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** A sheet's name as Excel allows: 31 characters, none of []:*?/\, unique in the workbook. */
export function sheetNames(names) {
  const used = new Set();
  return names.map((n) => {
    const base = String(n).replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Sheet';
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 31 - String(i).length - 1)} ${i}`;
    used.add(name.toLowerCase());
    return name;
  });
}

// Excel counts days from 1899-12-30; Trawl shows dates in UTC, so the serial is the UTC date's.
const serial = (date) => date.getTime() / 86_400_000 + 25569;
const STYLE = { header: 1, date: 2, datetime: 3 };
const MAX_TEXT = 32767;

/**
 * What a value becomes in a cell: { t, v, s } (a number, a boolean, a date as a number with a date
 * style, or inline text), or null for NULL. `type` is the column's, as the driver named it: exact
 * decimals and Postgres's dates come as text, and become numbers and dates by it.
 */
export function cellOf(value, type = '') {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? { t: 'n', v: String(value) } : { t: 's', v: String(value) };
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? { t: 'n', v: String(value) } : { t: 's', v: String(value) };
  if (typeof value === 'boolean') return { t: 'b', v: value ? '1' : '0' };
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return { t: 's', v: String(value) };
    const whole = value.getTime() % 86_400_000 === 0;
    return { t: 'n', v: String(serial(value)), s: whole ? STYLE.date : STYLE.datetime };
  }
  if (Buffer.isBuffer(value)) return { t: 's', v: `0x${value.toString('hex').toUpperCase()}` };
  if (typeof value === 'object') return { t: 's', v: JSON.stringify(value) };
  const s = String(value);
  // Excel keeps 15 digits: a decimal with more stays text, every digit of it.
  if (isNumericType(type) && /^-?\d+(\.\d+)?$/.test(s) && s.replace(/^-/, '').replace('.', '').replace(/^0+(?=\d)/, '').length <= 15) return { t: 'n', v: String(Number(s)) };
  if (/^date$/i.test(type) && /^\d{4}-\d{2}-\d{2}$/.test(s)) return cellOf(new Date(`${s}T00:00:00Z`));
  return { t: 's', v: s };
}

function sheetXml(set) {
  const rows = [];
  const widths = set.columns.map((c) => Math.min(60, Math.max(8, String(c.name).length + 2)));
  const cell = (ref, c) => {
    if (c.t === 's') return `<c r="${ref}" t="inlineStr"${c.s ? ` s="${c.s}"` : ''}><is><t xml:space="preserve">${xmlText(c.v.slice(0, MAX_TEXT))}</t></is></c>`;
    return `<c r="${ref}"${c.t === 'b' ? ' t="b"' : ''}${c.s ? ` s="${c.s}"` : ''}><v>${c.v}</v></c>`;
  };
  rows.push(`<row r="1">${set.columns.map((c, i) => cell(`${columnLetters(i)}1`, { t: 's', v: String(c.name), s: STYLE.header })).join('')}</row>`);
  set.rows.forEach((row, r) => {
    const cells = [];
    row.forEach((v, i) => {
      const c = cellOf(v, set.columns[i]?.type);
      if (!c) return;
      if (c.s === STYLE.date) widths[i] = Math.max(widths[i], 12);
      else if (c.s === STYLE.datetime) widths[i] = Math.max(widths[i], 20);
      else widths[i] = Math.min(60, Math.max(widths[i], Math.min(String(c.v).length, 60) + 2));
      cells.push(cell(`${columnLetters(i)}${r + 2}`, c));
    });
    rows.push(`<row r="${r + 2}">${cells.join('')}</row>`);
  });
  const cols = set.columns.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
  // The header stays in view while scrolling.
  const view = '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>';
  return `${XML}<worksheet xmlns="${MAIN}" xmlns:r="${REL}">${view}<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${rows.join('')}</sheetData></worksheet>`;
}

const STYLES = `${XML}<styleSheet xmlns="${MAIN}"><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm:ss"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/** The workbook's files for `sheets` ([{ name, set }]), before zipping. */
export function workbookParts(sheets) {
  const names = sheetNames(sheets.map((s) => s.name));
  const n = sheets.length;
  const range = Array.from({ length: n }, (_, i) => i + 1);
  return [
    {
      name: '[Content_Types].xml',
      data: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${range.map((i) => `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
    },
    { name: '_rels/.rels', data: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `${XML}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets>${range.map((i) => `<sheet name="${xmlText(names[i - 1])}" sheetId="${i}" r:id="rId${i}"/>`).join('')}</sheets></workbook>` },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${range.map((i) => `<Relationship Id="rId${i}" Type="${REL}/worksheet" Target="worksheets/sheet${i}.xml"/>`).join('')}<Relationship Id="rId${n + 1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    },
    { name: 'xl/styles.xml', data: STYLES },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s.set) })),
  ];
}

/** An .xlsx file's bytes: a sheet per result set, `names` naming them (else Results, or Result 1, 2…). */
export function toXlsx(sets, { names } = {}) {
  const sheets = sets.map((set, i) => ({ name: names?.[i] ?? (sets.length === 1 ? 'Results' : `Result ${i + 1}`), set }));
  return zip(workbookParts(sheets));
}
