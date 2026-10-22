// Editing a result set in place: which results can be edited, what you type becomes as a literal of
// the connection's kind (SQL Server, PostgreSQL or MySQL), and the script that saves the changes.
// Pure: the UI stages changes and runs the script through runSql, so the read-only and production
// rules apply as to anything else.
import { formatValue, mask, quoteIdent, splitStatements } from './sql.js';
import { DIALECTS } from './dialects.js';

/**
 * A column's type without its length or precision, lower case: nvarchar(50) → nvarchar,
 * timestamp(3) with time zone → timestamp with time zone, int(10) unsigned → int.
 */
const base = (type, kind = 'sqlserver') => {
  const t = String(type ?? '').toLowerCase();
  if (kind === 'sqlserver') return t.replace(/\(.*$/, '').trim();
  const bare = t.replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  return kind === 'mysql' ? bare.replace(/\s+(unsigned|signed|zerofill)\b.*$/, '') : bare;
};

const names = (...list) => new Set(list);

// What each kind's types take, by their names in the catalog Trawl reads (dialects.js): numbers,
// true/false, GUIDs, binary (typed as hex, 0x0A1B), dates and times (quoted, for the server to read),
// text (which may be empty), and the types nothing typed can go into. `exact` are those whose values
// come back exactly, so `=` finds the row (and checks it is unchanged): not floats, not times rounded
// or carrying more than a JavaScript date holds, not text without `=` at all.
const TYPES = {
  sqlserver: {
    ints: names('int', 'bigint', 'smallint', 'tinyint'),
    decimals: names('decimal', 'numeric', 'money', 'smallmoney'),
    floats: names('float', 'real'),
    bools: names('bit'),
    guids: names('uniqueidentifier'),
    binary: names('binary', 'varbinary', 'image'),
    dates: names('date', 'datetime', 'datetime2', 'smalldatetime', 'datetimeoffset', 'time'),
    readOnly: names('timestamp', 'rowversion', 'geography', 'geometry', 'hierarchyid', 'sql_variant'),
    exact: names('int', 'bigint', 'smallint', 'tinyint', 'bit', 'uniqueidentifier', 'date', 'char', 'varchar', 'nchar', 'nvarchar'),
  },
  postgres: {
    ints: names('smallint', 'integer', 'bigint', 'int', 'int2', 'int4', 'int8'),
    // pg hands numeric back as text, so it's exact too; money comes as text with its currency sign.
    decimals: names('numeric', 'decimal'),
    floats: names('real', 'double precision', 'float4', 'float8'),
    bools: names('boolean', 'bool'),
    guids: names('uuid'),
    binary: names('bytea'),
    dates: names('date', 'time', 'timetz', 'timestamp', 'timestamptz', 'time without time zone', 'time with time zone', 'timestamp without time zone', 'timestamp with time zone'),
    texts: names('text', 'character varying', 'varchar', 'character', 'char', 'bpchar', 'name', 'citext'),
    // pg reads these into objects that don't type back as they are (and arrays, below).
    readOnly: names('interval', 'point', 'line', 'lseg', 'box', 'path', 'polygon', 'circle'),
    exact: names('smallint', 'integer', 'bigint', 'int', 'int2', 'int4', 'int8', 'numeric', 'decimal', 'boolean', 'bool', 'uuid', 'date', 'text', 'character varying', 'varchar', 'character', 'char', 'bpchar', 'name', 'citext'),
  },
  mysql: {
    ints: names('tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint'),
    // mysql2 hands DECIMAL back as text, so it's exact too.
    decimals: names('decimal', 'numeric', 'dec', 'fixed'),
    floats: names('float', 'double', 'real', 'double precision'),
    bools: names(),
    guids: names(),
    binary: names('binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'bit'),
    dates: names('date', 'datetime', 'timestamp', 'time', 'year'),
    texts: names('char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'enum', 'set'),
    readOnly: names('geometry', 'point', 'linestring', 'polygon', 'multipoint', 'multilinestring', 'multipolygon', 'geometrycollection', 'geomcollection'),
    exact: names('tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'decimal', 'numeric', 'dec', 'fixed', 'date', 'char', 'varchar', 'enum'),
  },
};
const typesOf = (kind) => TYPES[kind] ?? TYPES.sqlserver;
const readOnlyType = (type, kind) => typesOf(kind).readOnly.has(base(type, kind)) || (kind === 'postgres' && /\[\]$/.test(base(type, kind)));
export const exactType = (type, kind) => typesOf(kind).exact.has(base(type, kind));

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

// A name as SQL Server ([x]), Postgres ("x") or MySQL (`x`) quotes it, or bare.
export const NAME = String.raw`(?:\[(?:[^\]]|\]\])+\]|"(?:[^"]|"")+"|\`(?:[^\`]|\`\`)+\`|[A-Za-z_@#][\w@#$]*)`;
export const unquote = (s) => {
  const q = s.match(/^([[`"])(.*)[\]`"]$/s);
  if (!q) return s;
  const close = q[1] === '[' ? ']' : q[1];
  return q[2].split(close + close).join(close);
};
// The schema a bare table name means, where there's a usual one.
const DEFAULT_SCHEMA = { sqlserver: 'dbo', postgres: 'public' };

/**
 * The table a name in the SQL means ([dbo].[Players], public.t, Players): { table, name } (`name` the
 * table's name as written, unquoted) or { reason }. A name with its database in it doesn't count.
 */
export function findTable(text, schema, { kind = 'sqlserver' } = {}) {
  const parts = text.split(/\s*\.\s*(?=[[\w"`@#])/).map(unquote);
  if (parts.length > 2) return { reason: 'it names the table with its database; edit it from a connection to that database' };
  const [name, owner] = [parts.at(-1), parts.at(-2)];
  const hits = (schema?.objects ?? []).filter((o) => o.kind === 'table' && o.name.toLowerCase() === name.toLowerCase() && (!owner || o.schema.toLowerCase() === owner.toLowerCase()));
  const table = hits.find((o) => o.schema === DEFAULT_SCHEMA[kind]) ?? (hits.length === 1 ? hits[0] : null);
  if (!table) return { reason: `${text.trim()} isn’t a table Trawl knows (a view, or another database)` };
  return { table, name };
}

/**
 * Which table a result's rows are, and which of its columns are that table's as they are:
 * { table, columns } or { reason } saying why it can't tell. `table` is the schema object, and
 * `columns` maps each result column index to its table column. Following a foreign key from a cell
 * needs this much; editing needs the primary key too (editTarget). `kind` is the connection's
 * (dialects.js), for which schema a bare name is in.
 */
export function readTarget(sql, sets, schema, { kind = 'sqlserver' } = {}) {
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
  // FROM <name>[.<name>] [[AS] alias], then WHERE / ORDER BY / OPTION / LIMIT or the end.
  const after = src.slice(from + 4);
  // Table hints, WITH (NOLOCK) and the like, don't change which rows these are.
  const m = after.match(new RegExp(String.raw`^\s*(${NAME}(?:\s*\.\s*${NAME}){0,3})(?:\s+(?!WITH\b)(?:AS\s+)?(${NAME}))?(?:\s+WITH\s*\([^)]*\))?\s*(?:$|(?=WHERE\b|ORDER\b|OPTION\b|OFFSET\b|LIMIT\b|FETCH\b))`, 'is'));
  if (!m) return { reason: 'it doesn’t read from a single table' };
  const alias = m[2] && !/^(WHERE|ORDER|OPTION|OFFSET|LIMIT|FETCH)$/i.test(m[2]) ? unquote(m[2]).toLowerCase() : null;
  const found = findTable(m[1], schema, { kind });
  if (found.reason) return found;
  const { table, name } = found;

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
 * Where a result can be saved back to: { table, keys, columns, kind } or { reason } saying why not.
 * `table` is the schema object; `keys` the result column indexes of its primary key; `columns`
 * maps each result column index to its table column, for the ones that can be edited; `kind` the
 * connection's (sqlserver, postgres or mysql), which the literals and the save script are written for.
 */
export function editTarget(sql, sets, schema, { kind = 'sqlserver' } = {}) {
  const target = readTarget(sql, sets, schema, { kind });
  if (!target.table) return target;
  const { table, columns } = target;

  const pk = table.columns.filter((c) => c.pk);
  if (!pk.length) return { reason: `${table.schema}.${table.name} has no primary key to find each row by` };
  const keys = pk.map((k) => [...columns].find(([, tc]) => tc === k)?.[0]);
  if (keys.some((k) => k === undefined)) return { reason: `the result needs ${table.schema}.${table.name}'s primary key (${pk.map((k) => k.name).join(', ')}) as plain columns` };
  const odd = pk.find((k) => !exactType(k.type, kind));
  if (odd) return { reason: `its key ${odd.name} is ${odd.type}, which can't be matched exactly` };
  return { table, keys, columns, kind };
}

/** Whether a column can take a typed value at all (identity, computed and rowversion can't). */
export const canEdit = (tc, kind = 'sqlserver') => !tc.identity && !tc.computed && !readOnlyType(tc.type, kind);

/** Why a column can't take a typed value, or null when it can. */
export function editRefusal(tc, kind = 'sqlserver') {
  if (tc.identity) return `${tc.name} is an identity column; the server sets it.`;
  if (tc.computed) return `${tc.name} is ${kind === 'sqlserver' ? 'a computed' : 'a generated'} column; the server sets it.`;
  if (!readOnlyType(tc.type, kind)) return null;
  return kind === 'sqlserver' && ['timestamp', 'rowversion'].includes(base(tc.type)) ? `${tc.name} is ${tc.type}; the server sets it.` : `${tc.name} is ${tc.type}, which Trawl can't edit.`;
}

/** Nothing staged: `cells` "row:col" → text or null, `deletes` rows, `inserts` the new rows' numbers. */
export const noChanges = () => ({ cells: new Map(), deletes: new Set(), inserts: [] });

/** Whether anything is staged. */
export const hasChanges = (changes) => Boolean(changes.cells.size || changes.deletes.size || changes.inserts?.length);

/**
 * The number a new row added to `set` goes by: after the rows read and the new rows staged, so its
 * cells are "row:col" keys like any other row's. Removing one leaves the others' numbers as they are.
 */
export const nextNewRow = (set, changes) => Math.max(set.rows.length, ...(changes.inserts ?? []).map((r) => r + 1));

/** Whether an empty value means "leave it to the default" in a new row: everything but text takes nothing typed as no value. */
export function emptyIsDefault(type, kind = 'sqlserver') {
  try {
    toLiteral('', type, kind);
    return false;
  } catch {
    return true;
  }
}

/** A value as text to edit: like the grid, but binary in full and NULL as nothing. */
export function editText(v) {
  if (v == null) return '';
  if (Buffer.isBuffer(v)) return `0x${v.toString('hex').toUpperCase()}`;
  return formatValue(v);
}

// SQL Server's text types that take '…' rather than N'…'.
const ANSI = new Set(['char', 'varchar', 'text']);
const quote = (s, unicode) => `${unicode ? 'N' : ''}'${String(s).replace(/'/g, "''")}'`;

/**
 * Text as a literal, each kind's way: SQL Server's N'…' ('…' when `ansi`), and on Postgres and
 * MySQL '…', unless the text has a backslash: Postgres then takes E'…' with it doubled, and MySQL
 * hex, which no sql_mode (NO_BACKSLASH_ESCAPES) reads differently.
 */
function textLiteral(text, kind, ansi = false) {
  const s = String(text);
  if (kind === 'postgres' && s.includes('\\')) return `E'${s.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
  if (kind === 'mysql' && s.includes('\\')) return `CONVERT(X'${Buffer.from(s, 'utf8').toString('hex')}' USING utf8mb4)`;
  return quote(s, kind === 'sqlserver' && !ansi);
}

/** Hex digits as each kind writes binary: 0x0A1B, decode('0a1b', 'hex'), X'0a1b'. */
function binaryLiteral(hex, kind) {
  const even = hex.length % 2 ? `0${hex}` : hex;
  if (kind === 'postgres') return `decode('${even}', 'hex')`;
  if (kind === 'mysql') return `X'${even}'`;
  return `0x${hex}`;
}

/**
 * What `text` typed into a column of `type` is as a literal for `kind`, checked first: 42, N'text',
 * 0x0A1B… on SQL Server, 'text', TRUE, decode(…) on Postgres. `null` stands for NULL. Throws, saying
 * what's expected, when it doesn't fit the type.
 */
export function toLiteral(text, type, kind = 'sqlserver') {
  if (text === null) return 'NULL';
  const T = typesOf(kind);
  const t = base(type, kind);
  const s = String(text);
  if (T.ints.has(t)) return /^\s*-?\d+\s*$/.test(s) ? s.trim() : fail(`${type} takes a whole number`);
  if (T.decimals.has(t)) return /^\s*-?(\d+\.?\d*|\.\d+)\s*$/.test(s) ? s.trim() : fail(`${type} takes a number like 12.50`);
  if (T.floats.has(t)) return /^\s*-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i.test(s) ? s.trim() : fail(`${type} takes a number`);
  if (T.bools.has(t)) {
    const v = s.trim().toLowerCase();
    const pg = kind === 'postgres';
    if (['1', 'true', ...(pg ? ['t'] : [])].includes(v)) return pg ? 'TRUE' : '1';
    if (['0', 'false', ...(pg ? ['f'] : [])].includes(v)) return pg ? 'FALSE' : '0';
    return fail(pg ? `${type} takes true or false (or 1 or 0)` : `${type} takes 1 or 0`);
  }
  if (T.guids.has(t)) {
    const guid = s.match(/^\s*\{?([0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12})\}?\s*$/i);
    return guid ? textLiteral(guid[1], kind, true) : fail(`${type} takes a GUID`);
  }
  if (T.binary.has(t)) {
    // MySQL's BIT comes back as bytes (0x05), and takes bits as well (101).
    if (kind === 'mysql' && t === 'bit' && /^\s*[01]+\s*$/.test(s)) return `b'${s.trim()}'`;
    const hex = s.match(/^\s*0x([0-9a-f]*)\s*$/i);
    return hex ? binaryLiteral(hex[1], kind) : fail(kind === 'mysql' && t === 'bit' ? `${type} takes bits, like 101, or hex, like 0x05` : `${type} takes hex, like 0x0A1B`);
  }
  if (T.dates.has(t)) return s.trim() ? textLiteral(s.trim(), kind, true) : fail(`${type} takes a date or time, like 2026-10-20 15:30`);
  if (readOnlyType(type, kind)) return fail(`${type} can't be edited`);
  if (kind === 'sqlserver') return quote(s, !ANSI.has(t));
  if (T.texts.has(t)) return textLiteral(s, kind);
  // Anything else (JSON, an enum, inet…) goes as text for the server to read, but not as nothing.
  return s.trim() ? textLiteral(s, kind) : fail(`${type} takes a value (n makes it NULL)`);
}

/** A value the grid already holds, as a literal of `kind` for WHERE: from the server, so it fits its type. */
export function valueLiteral(v, type, kind = 'sqlserver') {
  if (v == null) return 'NULL';
  const t = base(type, kind);
  if (v instanceof Date) {
    // A Postgres time with its zone is an instant, so it keeps the Z; the others are read as UTC.
    const iso = v.toISOString();
    return textLiteral(t === 'date' ? iso.slice(0, 10) : kind === 'postgres' && /time zone|tz$/.test(t) ? iso : iso.replace('Z', ''), kind, true);
  }
  if (typeof v === 'boolean') return kind === 'postgres' ? (v ? 'TRUE' : 'FALSE') : v ? '1' : '0';
  if (Buffer.isBuffer(v)) return binaryLiteral(v.toString('hex'), kind);
  if (typeof v === 'bigint' || (typeof v === 'number' && Number.isFinite(v))) return String(v);
  // pg reads a Postgres array into a JavaScript one, and JSON into objects (arrays too).
  if (Array.isArray(v) && kind === 'postgres' && !/^json/.test(t)) return textLiteral(pgArray(v), kind);
  if (typeof v === 'object') return textLiteral(editText(v), kind);
  try {
    return toLiteral(String(v), type, kind);
  } catch {
    return textLiteral(String(v), kind);
  }
}

/** A JavaScript array as Postgres writes an array value: {1,2}, {"a b",NULL}, {{1,2},{3,4}}. */
function pgArray(list) {
  const item = (v) => {
    if (v == null) return 'NULL';
    if (Array.isArray(v)) return pgArray(v);
    const s = v instanceof Date ? v.toISOString() : Buffer.isBuffer(v) ? `\\x${v.toString('hex')}` : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return `"${s.replace(/["\\]/g, '\\$&')}"`;
  };
  return `{${list.map(item).join(',')}}`;
}

// What a save keeps to: SQL Server's own transaction and savepoint; on Postgres and MySQL a savepoint
// in the transaction that is open, or a transaction of its own when none is.
const SAVEPOINT = 'trawl_edit';

/**
 * The script that saves `changes` ({ cells: Map "row:col" → text or null, deletes: Set of rows,
 * inserts: the new rows' numbers }) made to `set` (as `target` from editTarget). Each UPDATE and
 * DELETE must touch exactly one row, found by its key and, for the columns it changes, the values
 * it had when read; each INSERT must add one, with only the columns given (the rest take their
 * defaults); otherwise nothing is saved. It keeps to its own transaction (a savepoint), so one
 * already open isn't rolled back with it.
 *
 * Per kind: SQL Server's is one TRY/CATCH batch checking @@ROWCOUNT. Postgres's is a DO block
 * checking ROW_COUNT, which undoes itself when it fails; `transaction` (one is open when it runs)
 * puts it inside a savepoint, which saveRecovery rolls back to. MySQL has no such block: each
 * statement carries a `-- trawl:one row:` line, and db-mysql.js fails the script when it doesn't
 * affect exactly one row (mysql2 counts the rows an UPDATE finds, not only those it changes); the
 * script is START TRANSACTION … COMMIT, or a savepoint when `transaction`, and saveRecovery undoes it.
 */
export function saveScript(target, set, changes, { transaction = false } = {}) {
  const { table, keys, columns } = target;
  const kind = target.kind ?? 'sqlserver';
  const q = DIALECTS[kind].quote;
  const name = `${q(table.schema)}.${q(table.name)}`;
  const where = (row, also = []) =>
    [...keys, ...also]
      .map((i) => {
        const tc = columns.get(i);
        const v = set.rows[row][i];
        return v == null ? `${q(tc.name)} IS NULL` : `${q(tc.name)} = ${valueLiteral(v, tc.type, kind)}`;
      })
      .join(' AND ');
  const keyText = (row) => keys.map((i) => `${columns.get(i).name} = ${editText(set.rows[row][i])}`).join(', ');
  const inserts = changes.inserts ?? [];
  const byRow = new Map();
  for (const [at, text] of changes.cells) {
    const [row, col] = at.split(':').map(Number);
    if (changes.deletes.has(row) || (row >= set.rows.length && !inserts.includes(row))) continue;
    if (!byRow.has(row)) byRow.set(row, []);
    byRow.get(row).push([col, text]);
  }
  const literal = (col, text, where) => {
    const tc = columns.get(col);
    try {
      return toLiteral(text, tc.type, kind);
    } catch (e) {
      throw new Error(`${tc.name} (${where}): ${e.message}`);
    }
  };
  const gone = (row) => `The row ${keyText(row)} changed or is gone since it was read. Nothing was saved.`;
  const statements = [];
  for (const [row, cells] of [...byRow].filter(([row]) => row < set.rows.length).sort((x, y) => x[0] - y[0])) {
    const sets = cells.sort((x, y) => x[0] - y[0]).map(([col, text]) => `${q(columns.get(col).name)} = ${literal(col, text, keyText(row))}`);
    const check = cells.map(([col]) => col).filter((col) => !keys.includes(col) && exactType(columns.get(col).type, kind));
    statements.push({ sql: `UPDATE ${name} SET ${sets.join(', ')} WHERE ${where(row, check)};`, message: gone(row) });
  }
  for (const row of [...changes.deletes].sort((x, y) => x - y)) statements.push({ sql: `DELETE FROM ${name} WHERE ${where(row)};`, message: gone(row) });
  inserts.forEach((row, k) => {
    const cells = (byRow.get(row) ?? []).sort((x, y) => x[0] - y[0]);
    const sql = cells.length
      ? `INSERT INTO ${name} (${cells.map(([col]) => q(columns.get(col).name)).join(', ')}) VALUES (${cells.map(([col, text]) => literal(col, text, `new row ${k + 1}`)).join(', ')});`
      : kind === 'mysql'
        ? `INSERT INTO ${name} () VALUES ();`
        : `INSERT INTO ${name} DEFAULT VALUES;`;
    statements.push({ sql, message: `The new row ${k + 1} wasn't added as one row. Nothing was saved.` });
  });
  if (!statements.length) return '';
  const head = `-- trawl:edit ${statements.length} change${statements.length === 1 ? '' : 's'} to ${table.schema}.${table.name}`;
  const inSavepoint = (lines) => (transaction ? [`SAVEPOINT ${SAVEPOINT};`, ...lines, `RELEASE SAVEPOINT ${SAVEPOINT};`] : lines);
  if (kind === 'postgres') {
    const body = statements.flatMap((st) => [
      `  ${st.sql}`,
      '  GET DIAGNOSTICS trawl_rows = ROW_COUNT;',
      `  IF trawl_rows <> 1 THEN RAISE EXCEPTION USING MESSAGE = ${textLiteral(st.message, kind)}; END IF;`,
    ]);
    // The block's quotes must not be in what it holds.
    let tag = '$trawl$';
    for (let n = 1; body.some((line) => line.includes(tag)); n++) tag = `$trawl${n}$`;
    // use_column: a column called trawl_rows is the column in the statements, not the count.
    return [head, ...inSavepoint([`DO ${tag}`, '#variable_conflict use_column', 'DECLARE trawl_rows bigint;', 'BEGIN', ...body, `END ${tag};`])].join('\n');
  }
  if (kind === 'mysql') {
    // The check line is a comment to the server: one line, whatever the key's text holds.
    const body = statements.flatMap((st) => [`-- trawl:one row: ${st.message.replace(/[\r\n\u2028\u2029]+/g, ' ')}`, st.sql]);
    return [head, ...(transaction ? inSavepoint(body) : ['START TRANSACTION;', ...body, 'COMMIT;'])].join('\n');
  }
  const lines = [head, 'BEGIN TRANSACTION;', `SAVE TRANSACTION ${SAVEPOINT};`, 'BEGIN TRY'];
  for (const st of statements) {
    lines.push(`  ${st.sql}`);
    lines.push(`  IF @@ROWCOUNT <> 1 THROW 50000, ${quote(st.message, true)}, 1;`);
  }
  lines.push(
    '  COMMIT TRANSACTION;',
    'END TRY',
    'BEGIN CATCH',
    `  IF XACT_STATE() = 1 BEGIN ROLLBACK TRANSACTION ${SAVEPOINT}; COMMIT TRANSACTION; END`,
    '  ELSE IF XACT_STATE() = -1 ROLLBACK TRANSACTION;',
    '  THROW;',
    'END CATCH;',
  );
  return lines.join('\n');
}

/**
 * What undoes a save that failed part-way, run on the same session straight after the failure (db.js
 * runScript's `recover`): back to the savepoint when a transaction was open (`transaction`, as for
 * saveScript), else, on MySQL, the save's own transaction rolled back. '' where the script undoes
 * itself (SQL Server's CATCH, and a Postgres DO block on its own).
 */
export function saveRecovery(target, { transaction = false } = {}) {
  const kind = target.kind ?? 'sqlserver';
  if (kind === 'sqlserver') return '';
  if (transaction) return `ROLLBACK TO SAVEPOINT ${SAVEPOINT};\nRELEASE SAVEPOINT ${SAVEPOINT};`;
  return kind === 'mysql' ? 'ROLLBACK;' : '';
}

/** `set` once `changes` are saved: edited cells hold their new values and deleted rows are gone. */
export function withSaved(set, changes, target) {
  const rows = set.rows
    .map((row, r) => row.map((v, c) => (changes.cells.has(`${r}:${c}`) ? savedValue(changes.cells.get(`${r}:${c}`), target.columns.get(c).type, target.kind) : v)))
    .filter((_, r) => !changes.deletes.has(r));
  return { ...set, rows };
}

/** "2 edited rows, 1 deletion and 1 new row", for titles. */
export function changesText(changes) {
  const inserts = changes.inserts ?? [];
  const edited = new Set([...changes.cells.keys()].map((k) => Number(k.split(':')[0])).filter((r) => !changes.deletes.has(r) && !inserts.includes(r))).size;
  const n = changes.deletes.size;
  const parts = [
    edited ? `${edited} edited row${edited === 1 ? '' : 's'}` : '',
    n ? `${n} deletion${n === 1 ? '' : 's'}` : '',
    inserts.length ? `${inserts.length} new row${inserts.length === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts.join('');
}

/** The value a saved change leaves in the grid, as the server would hand it back. */
export function savedValue(text, type, kind = 'sqlserver') {
  if (text === null) return null;
  const T = typesOf(kind);
  const t = base(type, kind);
  const s = String(text).trim();
  if (T.ints.has(t) || T.decimals.has(t) || T.floats.has(t)) return Number(text);
  if (T.bools.has(t)) return ['1', 'true', 't'].includes(s.toLowerCase());
  if (T.binary.has(t)) {
    if (/^[01]+$/.test(s)) return Buffer.from(BigInt(`0b${s}`).toString(16).padStart(2 * Math.ceil(s.length / 8), '0'), 'hex');
    const hex = s.slice(2);
    return Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
  }
  return String(text);
}

/**
 * A result set as INSERT statements into `table` (a name as it's typed), a thousand rows a
 * statement, with `kind`'s literals.
 */
export function insertScript(set, table, { quote = quoteIdent, kind = 'sqlserver' } = {}) {
  const cols = set.columns.map((c) => quote(c.name)).join(', ');
  const rows = set.rows.map((row) => `(${row.map((v, i) => valueLiteral(v, set.columns[i].type, kind)).join(', ')})`);
  const out = [];
  for (let i = 0; i < rows.length; i += 1000) out.push(`INSERT INTO ${table} (${cols}) VALUES\n  ${rows.slice(i, i + 1000).join(',\n  ')};`);
  return out.join('\n');
}

/** A result set as tab-separated text, header first: what pastes into a spreadsheet as cells. */
export function tsvText(set, { header = true, rows = set.rows } = {}) {
  const cell = (v) => editText(v).replace(/[\t\r\n]+/g, ' ');
  return [...(header ? [set.columns.map((c) => c.name).join('\t')] : []), ...rows.map((r) => r.map(cell).join('\t'))].join('\n');
}
