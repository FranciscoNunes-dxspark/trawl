// Reading a CSV file into a table: parsing it (quotes, quotes doubled inside them, line breaks
// inside quotes, CRLF, a byte-order mark, comma, semicolon or tab between values) and turning its
// rows into INSERT statements for the table's columns, matched by the header. Pure.
import { canEdit, insertScript, toLiteral } from './edit.js';
import { qualified } from './sql.js';

/** The delimiter of the first line: the one of , ; and tab that appears most outside quotes. */
export function detectDelimiter(text) {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && ch in counts) counts[ch]++;
  }
  const [best, n] = Object.entries(counts).sort((x, y) => y[1] - x[1])[0];
  return n ? best : ',';
}

/** The rows of a CSV text, each an array of strings. A blank line at the end isn't a row. */
export function parseCsv(input, { delimiter } = {}) {
  const text = String(input ?? '').replace(/^﻿/, '');
  const sep = delimiter ?? detectDelimiter(text);
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
      continue;
    }
    if (ch === '"' && !cell) (quoted = true), (started = true);
    else if (ch === sep) (row.push(cell), (cell = ''), (started = true));
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      [row, cell, started] = [[], '', false];
    } else (cell += ch), (started = true);
  }
  if (started || cell || row.length) (row.push(cell), rows.push(row));
  // Blank lines (one empty cell) say nothing.
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

const norm = (s) => String(s).toLowerCase().replace(/[\s_-]+/g, '');

/**
 * INSERT statements putting CSV `rows` (header first) into `table` (a schema object), its columns
 * matched to the header by name (ignoring case, spaces and underscores). Identity and computed-looking
 * columns the server fills are left out, and so are headers the table hasn't. An empty value is NULL
 * where the column allows it. Throws, saying the row and column, on a value that doesn't fit its type.
 * Returns { script, rows, columns, skipped, missing }.
 */
export function csvInsertScript(rows, table, { quote, kind = 'sqlserver' } = {}) {
  if (!rows.length) throw new Error('The file is empty.');
  const [header, ...data] = rows;
  if (!data.length) throw new Error('The file has a header and no rows.');
  const used = [];
  const skipped = [];
  header.forEach((h, i) => {
    const col = table.columns.find((c) => norm(c.name) === norm(h));
    if (!col) skipped.push(`${h || `(column ${i + 1})`}: no such column`);
    else if (col.identity) skipped.push(`${h}: an identity column, which the server fills`);
    else if (col.computed) skipped.push(`${h}: ${kind === 'sqlserver' ? 'a computed' : 'a generated'} column, which the server fills`);
    else if (used.some((u) => u.col === col)) skipped.push(`${h}: ${col.name} is in the file twice`);
    else used.push({ i, col });
  });
  if (!used.length) throw new Error(`None of the file's columns (${header.join(', ')}) is a column of ${table.schema}.${table.name}.`);
  const missing = table.columns.filter((c) => !c.identity && !c.computed && !c.nullable && !used.some((u) => u.col === c)).map((c) => c.name);
  const values = data.map((r, n) => {
    if (r.length !== header.length) throw new Error(`Row ${n + 2} has ${r.length} value${r.length === 1 ? '' : 's'}; the header has ${header.length}.`);
    return used.map(({ i, col }) => {
      const v = r[i] === '' && (col.nullable || !/char|text/i.test(col.type)) ? null : r[i];
      try {
        // Postgres reads its arrays, intervals and geometric values from text, though Trawl doesn't edit them.
        if (v !== null && !(kind === 'postgres' && !canEdit({ type: col.type }, kind))) toLiteral(v, col.type, kind);
      } catch (e) {
        throw new Error(`Row ${n + 2}, ${col.name}: ${e.message} ("${v}")`);
      }
      return v;
    });
  });
  const set = { columns: used.map(({ col }) => ({ name: col.name, type: col.type })), rows: values };
  return { script: insertScript(set, quote ? `${quote(table.schema)}.${quote(table.name)}` : qualified(table.schema, table.name), quote ? { quote, kind } : { kind }), rows: values.length, columns: used.map(({ col }) => col.name), skipped, missing };
}
