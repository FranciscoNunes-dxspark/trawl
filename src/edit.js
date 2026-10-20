// Editing a result set in place: which results can be edited, what you type becomes as a T-SQL
// literal, and the script that saves the changes. Pure: the UI stages changes and runs the script
// through runSql, so the read-only and production rules apply as to anything else.
import { formatValue, mask, qualified, quoteIdent, splitStatements } from './sql.js';

const base = (type) => String(type ?? '').toLowerCase().replace(/\(.*$/, '').trim();

const INTS = new Set(['int', 'bigint', 'smallint', 'tinyint']);
const DECIMALS = new Set(['decimal', 'numeric', 'money', 'smallmoney']);
const FLOATS = new Set(['float', 'real']);
const ANSI = new Set(['char', 'varchar', 'text']);
const DATES = new Set(['date', 'datetime', 'datetime2', 'smalldatetime', 'datetimeoffset', 'time']);
const BINARY = new Set(['binary', 'varbinary', 'image']);
// Nothing a person types can go into these.
const READ_ONLY = new Set(['timestamp', 'rowversion', 'geography', 'geometry', 'hierarchyid', 'sql_variant']);
// Types whose values come back exactly, so `=` finds the row (and checks it is unchanged):
// not float, not datetime (rounded to 1/300 s), not text, ntext, image or xml (no `=` at all).
const EXACT = new Set([...INTS, 'bit', 'uniqueidentifier', 'date', 'char', 'varchar', 'nchar', 'nvarchar']);

const fail = (message) => {
  throw new Error(message);
};

// Keywords that make a SELECT more than "rows of one table".
const NOT_ONE_TABLE = /\b(JOIN|APPLY|UNION|INTERSECT|EXCEPT|GROUP\s+BY|HAVING|DISTINCT|INTO|PIVOT|UNPIVOT|FOR\s+(XML|JSON))\b/i;

/** Splits on commas outside parentheses, using the mask so commas in strings don't count. */
function splitTop(src, masked, from, to) {
  const out = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i++) {
    if (masked[i] === '(') depth++;
    else if (masked[i] === ')') depth--;
    else if (masked[i] === ',' && !depth) {
      out.push(src.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(src.slice(start, to).trim());
  return out;
}

/** Where `re` (global) first matches outside parentheses in the mask, or -1. */
function topLevel(masked, re) {
  for (const m of masked.matchAll(re)) {
    let depth = 0;
    for (let i = 0; i < m.index; i++) depth += masked[i] === '(' ? 1 : masked[i] === ')' ? -1 : 0;
    if (!depth) return m.index;
  }
  return -1;
}

const NAME = String.raw`(?:\[(?:[^\]]|\]\])+\]|"[^"]+"|[A-Za-z_@#][\w@#$]*)`;
const unquote = (s) => s.replace(/^\[(.*)\]$/s, '$1').replace(/]]/g, ']').replace(/^"(.*)"$/s, '$1');

/**
 * Which table a result's rows are, and which of its columns are that table's as they are:
 * { table, columns } or { reason } saying why it can't tell. `table` is the schema object, and
 * `columns` maps each result column index to its table column. Following a foreign key from a cell
 * needs this much; editing needs the primary key too (editTarget).
 */
export function readTarget(sql, sets, schema) {
  if (!schema) return { reason: 'the schema is still loading' };
  if (sets.length !== 1) return { reason: 'only a statement with one result set can be edited' };
  const statements = splitStatements(sql);
  if (statements.length !== 1) return { reason: 'only the result of a single SELECT can be edited' };
  const src = statements[0].text.replace(/;\s*$/, '');
  const masked = mask(src);
  const select = masked.match(/^\s*SELECT\b/i);
  if (!select) return { reason: 'only a SELECT can be edited' };
  if (NOT_ONE_TABLE.test(masked)) return { reason: 'it isn’t the rows of one table (a join, union, grouping or the like)' };
  const from = topLevel(masked, /\bFROM\b/gi);
  if (from < 0) return { reason: 'it doesn’t come from a table' };
  // FROM <name>[.<name>] [[AS] alias], then WHERE / ORDER BY / OPTION or the end.
  const after = src.slice(from + 4);
  // Table hints, WITH (NOLOCK) and the like, don't change which rows these are.
  const m = after.match(new RegExp(String.raw`^\s*(${NAME}(?:\s*\.\s*${NAME}){0,3})(?:\s+(?!WITH\b)(?:AS\s+)?(${NAME}))?(?:\s+WITH\s*\([^)]*\))?\s*(?:$|(?=WHERE\b|ORDER\b|OPTION\b|OFFSET\b))`, 'is'));
  if (!m) return { reason: 'it doesn’t read from a single table' };
  const alias = m[2] && !/^(WHERE|ORDER|OPTION|OFFSET)$/i.test(m[2]) ? unquote(m[2]).toLowerCase() : null;
  const parts = m[1].split(/\s*\.\s*(?=[[\w"@#])/).map(unquote);
  if (parts.length > 2) return { reason: 'it names the table with its database; edit it from a connection to that database' };
  const [name, owner] = [parts.at(-1), parts.at(-2)];
  const hits = schema.objects.filter((o) => o.kind === 'table' && o.name.toLowerCase() === name.toLowerCase() && (!owner || o.schema.toLowerCase() === owner.toLowerCase()));
  const table = hits.find((o) => o.schema === 'dbo') ?? (hits.length === 1 ? hits[0] : null);
  if (!table) return { reason: `${m[1].trim()} isn’t a table Trawl knows (a view, or another database)` };

  // The select list: which result columns are a table column as it is, not an expression.
  let listStart = select[0].length;
  const top = masked.slice(listStart).match(/^\s*TOP\s*(\(\s*[^)]*\)|\d+)(\s+PERCENT)?(\s+WITH\s+TIES)?/i);
  if (top) listStart += top[0].length;
  const plain = new Set();
  const named = new Map();
  for (const item of splitTop(src, masked, listStart, from)) {
    const star = item.match(new RegExp(String.raw`^(?:(${NAME})\s*\.\s*)?\*$`, 's'));
    if (star) {
      if (star[1] && ![alias, name.toLowerCase()].includes(unquote(star[1]).toLowerCase())) return { reason: 'its columns come from more than one place' };
      for (const c of table.columns) plain.add(c.name.toLowerCase());
      continue;
    }
    const col = item.match(new RegExp(String.raw`^(?:(${NAME})\s*\.\s*)?(${NAME})(?:\s+(?:AS\s+)?(${NAME}))?$`, 's'));
    if (col && !(col[1] && ![alias, name.toLowerCase()].includes(unquote(col[1]).toLowerCase())) && !/^@/.test(col[2])) {
      const source = unquote(col[2]).toLowerCase();
      const shown = (col[3] ? unquote(col[3]) : unquote(col[2])).toLowerCase();
      named.set(shown, (named.get(shown) ?? 0) + 1);
      if (shown === source) plain.add(source);
      continue;
    }
    // An expression: its name (if it has one) must not pass for the column of the same name.
    const as = item.match(new RegExp(String.raw`\s(?:AS\s+)?(${NAME})$`, 'is')) ?? item.match(new RegExp(String.raw`^(${NAME})\s*=`, 's'));
    if (as) named.set(unquote(as[1]).toLowerCase(), 2);
  }
  const columns = new Map();
  const seen = new Map();
  for (const c of sets[0].columns) seen.set(c.name.toLowerCase(), (seen.get(c.name.toLowerCase()) ?? 0) + 1);
  sets[0].columns.forEach((c, i) => {
    const key = c.name.toLowerCase();
    const tc = table.columns.find((t) => t.name.toLowerCase() === key);
    if (tc && plain.has(key) && seen.get(key) === 1 && (named.get(key) ?? 1) === 1) columns.set(i, tc);
  });
  return { table, columns };
}

/**
 * Where a result can be saved back to: { table, keys, columns } or { reason } saying why not.
 * `table` is the schema object; `keys` the result column indexes of its primary key; `columns`
 * maps each result column index to its table column, for the ones that can be edited.
 */
export function editTarget(sql, sets, schema) {
  const target = readTarget(sql, sets, schema);
  if (!target.table) return target;
  const { table, columns } = target;

  const pk = table.columns.filter((c) => c.pk);
  if (!pk.length) return { reason: `${table.schema}.${table.name} has no primary key to find each row by` };
  const keys = pk.map((k) => [...columns].find(([, tc]) => tc === k)?.[0]);
  if (keys.some((k) => k === undefined)) return { reason: `the result needs ${table.schema}.${table.name}'s primary key (${pk.map((k) => k.name).join(', ')}) as plain columns` };
  const odd = pk.find((k) => !EXACT.has(base(k.type)));
  if (odd) return { reason: `its key ${odd.name} is ${odd.type}, which can't be matched exactly` };
  return { table, keys, columns };
}

/** Whether a column can take a typed value at all (identity and rowversion can't). */
export const canEdit = (tc) => !tc.identity && !READ_ONLY.has(base(tc.type));

/** A value as text to edit: like the grid, but binary in full and NULL as nothing. */
export function editText(v) {
  if (v == null) return '';
  if (Buffer.isBuffer(v)) return `0x${v.toString('hex').toUpperCase()}`;
  return formatValue(v);
}

const quote = (s, unicode) => `${unicode ? 'N' : ''}'${String(s).replace(/'/g, "''")}'`;

/**
 * What `text` typed into a column of `type` is in T-SQL, checked first: 42, N'text', 0x0A1B…
 * `null` stands for NULL. Throws, saying what's expected, when it doesn't fit the type.
 */
export function toLiteral(text, type) {
  if (text === null) return 'NULL';
  const t = base(type);
  const s = String(text);
  if (INTS.has(t)) return /^\s*-?\d+\s*$/.test(s) ? s.trim() : fail(`${type} takes a whole number`);
  if (DECIMALS.has(t)) return /^\s*-?(\d+\.?\d*|\.\d+)\s*$/.test(s) ? s.trim() : fail(`${type} takes a number like 12.50`);
  if (FLOATS.has(t)) return /^\s*-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i.test(s) ? s.trim() : fail(`${type} takes a number`);
  if (t === 'bit') {
    const v = s.trim().toLowerCase();
    if (['1', 'true'].includes(v)) return '1';
    if (['0', 'false'].includes(v)) return '0';
    return fail('bit takes 1 or 0');
  }
  if (t === 'uniqueidentifier') return /^\s*\{?[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}\}?\s*$/i.test(s) ? quote(s.trim().replace(/^\{|\}$/g, '')) : fail('uniqueidentifier takes a GUID');
  if (BINARY.has(t)) return /^\s*0x[0-9a-f]*\s*$/i.test(s) ? s.trim() : fail(`${type} takes hex, like 0x0A1B`);
  if (DATES.has(t)) return s.trim() ? quote(s.trim()) : fail(`${type} takes a date or time, like 2026-10-20 15:30`);
  if (READ_ONLY.has(t)) return fail(`${type} can't be edited`);
  return quote(s, !ANSI.has(t));
}

/** A value the grid already holds, as a literal for WHERE: from the server, so it fits its type. */
export function valueLiteral(v, type) {
  if (v == null) return 'NULL';
  if (v instanceof Date) return quote(base(type) === 'date' ? v.toISOString().slice(0, 10) : v.toISOString().replace('Z', ''));
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (Buffer.isBuffer(v)) return `0x${v.toString('hex')}`;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  return toLiteral(String(v), type);
}

/**
 * The script that saves `changes` ({ cells: Map "row:col" → text or null, deletes: Set of rows })
 * made to `set` (as `target` from editTarget). Each statement must touch exactly one row, found by
 * its key and, for the columns it changes, the values it had when read; otherwise nothing is saved.
 * It keeps to its own transaction (a savepoint), so one already open isn't rolled back with it.
 */
export function saveScript(target, set, changes) {
  const { table, keys, columns } = target;
  const name = qualified(table.schema, table.name);
  const where = (row, also = []) =>
    [...keys, ...also]
      .map((i) => {
        const tc = columns.get(i);
        const v = set.rows[row][i];
        return v == null ? `${quoteIdent(tc.name)} IS NULL` : `${quoteIdent(tc.name)} = ${valueLiteral(v, tc.type)}`;
      })
      .join(' AND ');
  const keyText = (row) => keys.map((i) => `${columns.get(i).name} = ${editText(set.rows[row][i])}`).join(', ');
  const byRow = new Map();
  for (const [at, text] of changes.cells) {
    const [row, col] = at.split(':').map(Number);
    if (changes.deletes.has(row)) continue;
    if (!byRow.has(row)) byRow.set(row, []);
    byRow.get(row).push([col, text]);
  }
  const statements = [];
  for (const [row, cells] of [...byRow].sort((x, y) => x[0] - y[0])) {
    const sets = cells.sort((x, y) => x[0] - y[0]).map(([col, text]) => {
      const tc = columns.get(col);
      try {
        return `${quoteIdent(tc.name)} = ${toLiteral(text, tc.type)}`;
      } catch (e) {
        throw new Error(`${tc.name} (${keyText(row)}): ${e.message}`);
      }
    });
    const check = cells.map(([col]) => col).filter((col) => !keys.includes(col) && EXACT.has(base(columns.get(col).type)));
    statements.push({ sql: `UPDATE ${name} SET ${sets.join(', ')} WHERE ${where(row, check)};`, row: keyText(row) });
  }
  for (const row of [...changes.deletes].sort((x, y) => x - y)) statements.push({ sql: `DELETE FROM ${name} WHERE ${where(row)};`, row: keyText(row) });
  if (!statements.length) return '';
  const lines = [
    `-- trawl:edit ${statements.length} change${statements.length === 1 ? '' : 's'} to ${table.schema}.${table.name}`,
    'BEGIN TRANSACTION;',
    'SAVE TRANSACTION trawl_edit;',
    'BEGIN TRY',
  ];
  for (const st of statements) {
    lines.push(`  ${st.sql}`);
    lines.push(`  IF @@ROWCOUNT <> 1 THROW 50000, ${quote(`The row ${st.row} changed or is gone since it was read. Nothing was saved.`, true)}, 1;`);
  }
  lines.push(
    '  COMMIT TRANSACTION;',
    'END TRY',
    'BEGIN CATCH',
    '  IF XACT_STATE() = 1 BEGIN ROLLBACK TRANSACTION trawl_edit; COMMIT TRANSACTION; END',
    '  ELSE IF XACT_STATE() = -1 ROLLBACK TRANSACTION;',
    '  THROW;',
    'END CATCH;',
  );
  return lines.join('\n');
}

/** `set` once `changes` are saved: edited cells hold their new values and deleted rows are gone. */
export function withSaved(set, changes, target) {
  const rows = set.rows
    .map((row, r) => row.map((v, c) => (changes.cells.has(`${r}:${c}`) ? savedValue(changes.cells.get(`${r}:${c}`), target.columns.get(c).type) : v)))
    .filter((_, r) => !changes.deletes.has(r));
  return { ...set, rows };
}

/** "2 edited rows and 1 deletion", for titles. */
export function changesText(changes) {
  const edited = new Set([...changes.cells.keys()].map((k) => Number(k.split(':')[0])).filter((r) => !changes.deletes.has(r))).size;
  const n = changes.deletes.size;
  return [edited ? `${edited} edited row${edited === 1 ? '' : 's'}` : '', n ? `${n} deletion${n === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
}

/** The value a saved change leaves in the grid, as the server would hand it back. */
export function savedValue(text, type) {
  if (text === null) return null;
  const t = base(type);
  if (INTS.has(t) || DECIMALS.has(t) || FLOATS.has(t)) return Number(text);
  if (t === 'bit') return ['1', 'true'].includes(String(text).trim().toLowerCase());
  if (BINARY.has(t)) return Buffer.from(String(text).trim().slice(2), 'hex');
  return String(text);
}

/** A result set as INSERT statements into `table` (a name as it's typed), a thousand rows a statement. */
export function insertScript(set, table) {
  const cols = set.columns.map((c) => `[${c.name.replace(/]/g, ']]')}]`).join(', ');
  const rows = set.rows.map((row) => `(${row.map((v, i) => valueLiteral(v, set.columns[i].type)).join(', ')})`);
  const out = [];
  for (let i = 0; i < rows.length; i += 1000) out.push(`INSERT INTO ${table} (${cols}) VALUES\n  ${rows.slice(i, i + 1000).join(',\n  ')};`);
  return out.join('\n');
}

/** A result set as tab-separated text, header first: what pastes into a spreadsheet as cells. */
export function tsvText(set, { header = true, rows = set.rows } = {}) {
  const cell = (v) => editText(v).replace(/[\t\r\n]+/g, ' ');
  return [...(header ? [set.columns.map((c) => c.name).join('\t')] : []), ...rows.map((r) => r.map(cell).join('\t'))].join('\n');
}
