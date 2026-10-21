// Comparing two result sets: the rows one has that the other hasn't, and, when rows can be told
// apart by a key, the ones whose values changed. Pure: App pins a result, and the comparison is
// shown as a result set of its own.
import { formatValue } from './sql.js';

const lower = (s) => String(s).toLowerCase();
const cell = (v) => (v == null ? '\u0000NULL' : formatValue(v));

/**
 * What changed from `before` to `after` (result sets with the same column names, in any order).
 * `keys` names the columns that tell rows apart (a table's primary key); without them, or when they
 * don't single rows out, whole rows are compared, so a changed row shows as removed and added.
 * Returns { columns, added, removed, changed: [{ before, after, cols, index }], same, keyed, addedAt },
 * rows in `before`'s column order; `index` and `addedAt` are the rows' indexes in `after`. Throws when
 * the columns differ.
 */
export function compareSets(before, after, { keys = [] } = {}) {
  const names = before.columns.map((c) => lower(c.name));
  const other = after.columns.map((c) => lower(c.name));
  if (names.length !== other.length || names.some((n) => !other.includes(n)) || new Set(names).size !== names.length) {
    throw new Error(`The columns differ (${before.columns.map((c) => c.name).join(', ')} then ${after.columns.map((c) => c.name).join(', ')}), so the rows can't be compared.`);
  }
  const order = names.map((n) => other.indexOf(n));
  const afterRows = after.rows.map((r) => order.map((i) => r[i]));
  const keyAt = keys.map((k) => names.indexOf(lower(k)));
  const keyOf = (row) => keyAt.map((i) => cell(row[i])).join('\u0001');
  const unique = (rows) => new Set(rows.map(keyOf)).size === rows.length;
  const keyed = keyAt.length > 0 && !keyAt.includes(-1) && unique(before.rows) && unique(afterRows);
  const out = { columns: before.columns, added: [], removed: [], changed: [], same: 0, keyed, addedAt: [] };
  if (keyed) {
    const was = new Map(before.rows.map((r) => [keyOf(r), r]));
    const seen = new Set();
    for (const [index, row] of afterRows.entries()) {
      const k = keyOf(row);
      const old = was.get(k);
      if (!old) {
        out.added.push(row);
        out.addedAt.push(index);
        continue;
      }
      seen.add(k);
      const cols = row.map((v, i) => i).filter((i) => cell(row[i]) !== cell(old[i]));
      if (cols.length) out.changed.push({ before: old, after: row, cols, index });
      else out.same++;
    }
    out.removed = before.rows.filter((r) => !seen.has(keyOf(r)));
    return out;
  }
  // Whole rows, counted: two identical rows before and one after is one removed.
  const whole = (row) => row.map(cell).join('\u0001');
  const left = new Map();
  for (const r of before.rows) left.set(whole(r), [...(left.get(whole(r)) ?? []), r]);
  for (const [index, row] of afterRows.entries()) {
    const list = left.get(whole(row));
    if (list?.length) {
      list.pop();
      out.same++;
    } else {
      out.added.push(row);
      out.addedAt.push(index);
    }
  }
  out.removed = [...left.values()].flat();
  return out;
}

/**
 * The comparison as a result set: a `change` column (~ changed, + added, − removed) before the
 * columns, the new values for a changed row, and `was` after them, saying what changed from what.
 */
export function comparisonSet(diff) {
  const was = (d) => d.cols.map((i) => `${diff.columns[i].name}: ${formatValue(d.before[i])} → ${formatValue(d.after[i])}`).join('; ');
  const rows = [
    ...diff.changed.map((d) => ['~', ...d.after, was(d)]),
    ...diff.added.map((r) => ['+', ...r, null]),
    ...diff.removed.map((r) => ['−', ...r, null]),
  ];
  return { columns: [{ name: 'change', type: 'NVarChar' }, ...diff.columns, { name: 'was', type: 'NVarChar' }], rows, truncated: false };
}

/** "1 changed · 2 added · 0 removed · 40 the same (rows matched by Id)". */
export function comparisonSummary(diff, keys = []) {
  return `${diff.changed.length} changed · ${diff.added.length} added · ${diff.removed.length} removed · ${diff.same} the same (${diff.keyed ? `rows matched by ${keys.join(', ')}` : 'whole rows compared'})`;
}
