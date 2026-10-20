// Following a foreign key from a cell in Results: the row the value refers to (the cell's column is
// part of a foreign key), or the rows that refer to it (other tables' foreign keys point at it). Pure:
// the schema's foreign keys and the result's source table (edit.js readTarget) say where to go.
import { valueLiteral } from './edit.js';
import { objectName } from './schema.js';
import { qualified, quoteIdent } from './sql.js';

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const parts = (dotted) => {
  const [schema, ...rest] = String(dotted).split('.');
  return [schema, rest.join('.')];
};

/**
 * Where the cell at `row`, `col` of `set` leads, given `source` ({ table, columns } from readTarget):
 * { targets } with one { label, sql } per foreign key, those the value refers to first, then the
 * tables that refer to it; or { reason } when there's nowhere to go. `limit` caps the rows read back.
 */
export function followTargets(source, set, row, col, schema, { limit = 500 } = {}) {
  if (!source?.table) return { reason: `Trawl can't tell which table these rows are: ${source?.reason ?? 'no result'}` };
  const tc = source.columns.get(col);
  const { table } = source;
  const name = objectName(table);
  if (!tc) return { reason: `${set.columns[col]?.name ?? 'This column'} isn't a column of ${name} as it is (an expression, or renamed).` };
  // The result column showing a column of the table, by the table column's name.
  const resultCol = (column) => [...source.columns].find(([, c]) => same(c.name, column))?.[0];
  const values = set.rows[row];
  const targets = [];
  let reason = null;
  const where = (pairs) => pairs.map(([column, v, type]) => (v == null ? `${quoteIdent(column)} IS NULL` : `${quoteIdent(column)} = ${valueLiteral(v, type)}`)).join(' AND ');
  const said = (pairs) => pairs.map(([column, v]) => `${column} = ${v == null ? 'NULL' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v)}`).join(', ');
  for (const f of schema?.foreignKeys ?? []) {
    if (same(f.from, name) && f.columns.some(([c]) => same(c, tc.name))) {
      const at = f.columns.map(([c]) => resultCol(c));
      if (at.some((i) => i === undefined)) {
        reason = `${f.name} needs ${f.columns.map(([c]) => c).join(', ')} in the result.`;
        continue;
      }
      if (at.every((i) => values[i] == null)) {
        reason = `${tc.name} is NULL here, so it refers to no row.`;
        continue;
      }
      const pairs = f.columns.map(([, to], k) => [to, values[at[k]], source.columns.get(at[k]).type]);
      const [s, t] = parts(f.to);
      targets.push({ label: `${f.to} where ${said(pairs)}`, sql: `SELECT TOP (${limit}) * FROM ${qualified(s, t)} WHERE ${where(pairs)};`, fk: f.name, refers: true });
    }
  }
  for (const f of schema?.foreignKeys ?? []) {
    if (same(f.to, name) && f.columns.some(([, c]) => same(c, tc.name))) {
      const at = f.columns.map(([, c]) => resultCol(c));
      if (at.some((i) => i === undefined) || at.every((i) => values[i] == null)) continue;
      const pairs = f.columns.map(([from], k) => [from, values[at[k]], source.columns.get(at[k]).type]);
      const [s, t] = parts(f.from);
      targets.push({ label: `${f.from} where ${said(pairs)} (rows referring to this one)`, sql: `SELECT TOP (${limit}) * FROM ${qualified(s, t)} WHERE ${where(pairs)};`, fk: f.name, refers: false });
    }
  }
  if (targets.length) return { targets };
  return { reason: reason ?? `${tc.name} isn't part of a foreign key, and nothing refers to it.` };
}
