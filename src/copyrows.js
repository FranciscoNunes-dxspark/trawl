// /copy-rows: rows of one table, and the rows they refer to through foreign keys, from the database
// you're on to another connection (production to dev, say), with personal data swapped for made-up
// values that stay the same for the same input (so joins still meet). actions.js reads the rows;
// everything here is pure: which columns are personal, the reads, the order, and the script, which
// skips rows the target already has.
import { fakeValue, guessFor } from './generate.js';
import { valueLiteral } from './edit.js';
import { objectName } from './schema.js';

/** `/copy-rows <target> [table] [--where <condition>] [--no-mask]` as { target, table, where, mask }. */
export function parseCopyRowsArgs(rest) {
  let s = String(rest ?? '').trim();
  let mask = true;
  s = s.replace(/(^|\s)--no-mask(?=\s|$)/i, () => ((mask = false), ' ')).trim();
  let where = null;
  const at = s.search(/(^|\s)--where(\s|$)/i);
  if (at >= 0) {
    where = s.slice(at).replace(/^\s*--where\s*/i, '').trim().replace(/^"(.*)"$/s, '$1').trim();
    s = s.slice(0, at).trim();
    if (!where) throw new Error('--where takes a condition: /copy-rows <target> [table] --where "Id < 100"');
  }
  const words = s.match(/"[^"]*"|\S+/g)?.map((w) => w.replace(/^"(.*)"$/, '$1')) ?? [];
  if (words.length > 2) throw new Error(`Too many words before --where: /copy-rows <target> [table] [--where <condition>] [--no-mask]`);
  const [target = null, table = null] = words;
  return { target, table, where, mask };
}

// Column names (lower case, without spaces, _ and -) that hold personal data, and the fake each gets.
const PERSONAL = [
  [/e?mail/, 'email'],
  [/(^|address|client|remote|source|user|last|login)ip$|^ip(address|addr|v4|v6)?$/, 'ip'],
  [/phone|mobile|^tel$|telephone|^fax$|faxnumber|cellular/, 'phone'],
  [/firstname|givenname|forename/, 'first'],
  [/lastname|surname|familyname/, 'last'],
  [/fullname|displayname|contactname|personname|customername|employeename/, 'person'],
  [/zip|postal|postcode/, 'zip'],
  [/address|street|addr\d*$|addressline/, 'street'],
  [/city|town/, 'city'],
  [/birth|^dob$|dateofbirth/, 'birth'],
  [/(^|social)ssn$|^ssn|socialsecurity|^nif$|nif$|^nin$|^nino$|nationalinsurance|taxid|taxnumber|iban|(^|credit|debit)card(number|no|num)?$|cardnumber|passport|nationalid|idcard/, 'scramble'],
];

/**
 * The fake a column of `table` gets (fakeValue's kinds), or null when it isn't personal data. A plain
 * Name column counts when the table holds people (/generate's guess), not clubs or products.
 */
export function personalKind(column, table = '') {
  const n = String(column).toLowerCase().replace(/[\s_-]+/g, '');
  for (const [re, kind] of PERSONAL) if (re.test(n)) return kind;
  return guessFor(column, table) === 'person' ? 'person' : null;
}

/**
 * The rows of `set` (from `obj`, a schema table) with each personal column's values faked:
 * { rows, masked: [column names] }. Keys are faked too when they're personal, the same way everywhere.
 */
export function maskRows(obj, set, { kind = 'sqlserver' } = {}) {
  const fakes = set.columns.map((c) => personalKind(c.name, obj.name));
  const masked = set.columns.filter((_, i) => fakes[i]).map((c) => c.name);
  const cols = set.columns.map((c) => obj.columns.find((x) => x.name.toLowerCase() === c.name.toLowerCase()) ?? c);
  const rows = set.rows.map((row) => row.map((v, i) => (fakes[i] ? fakeValue(fakes[i], v, cols[i], kind) : v)));
  return { rows, masked };
}

/** The foreign keys from `obj` (schema.foreignKeys entries whose `from` is it). */
export const foreignKeysFrom = (schema, obj) => (schema?.foreignKeys ?? []).filter((f) => f.from.toLowerCase() === objectName(obj).toLowerCase());

/** Why `obj` can't be copied, or null: it must be a table with a primary key, to know a row that's already there. */
export function copyRefusal(obj) {
  if (!obj) return 'there is no such table';
  if (obj.kind !== 'table') return `${objectName(obj)} is a ${obj.kind}, not a table`;
  if (!obj.columns.some((c) => c.pk)) return `${objectName(obj)} has no primary key, so a row already in the target can't be told from a new one`;
  return null;
}

const cell = (set, row, name) => row[set.columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase())];

const plainKey = (v) => (v instanceof Date ? v.toISOString() : Buffer.isBuffer(v) ? v.toString('hex') : typeof v === 'bigint' || typeof v === 'number' ? String(v) : typeof v === 'string' ? v.toLowerCase() : v);

/** A key's values as one string, to tell keys apart (text ignoring case, as SQL Server compares it). */
export const tupleKey = (t) => JSON.stringify(t.map(plainKey));

/** The values (each an array, in `cols`' order) `set`'s rows hold in those columns, without repeats or NULLs. */
export function keyTuples(set, cols) {
  const seen = new Map();
  for (const row of set.rows) {
    const t = cols.map((c) => cell(set, row, c));
    if (t.some((v) => v == null)) continue;
    const k = tupleKey(t);
    if (!seen.has(k)) seen.set(k, t);
  }
  return [...seen.values()];
}

const quoted = (dialect, obj) => `${dialect.quote(obj.schema)}.${dialect.quote(obj.name)}`;
const typeOf = (obj, name) => obj.columns.find((c) => c.name.toLowerCase() === name.toLowerCase())?.type ?? '';

/** The read of the rows to copy: the first `limit` of `obj`, those `where` picks when it's given. */
export const rowsSql = (dialect, obj, { where = null, limit }) => `-- trawl:copy-rows read\n${dialect.selectTop(quoted(dialect, obj), limit, where)};`;

/**
 * The reads of `obj`'s rows whose `cols` hold one of `tuples` (the rows a foreign key refers to), a
 * few hundred values a query.
 */
export function parentSql(dialect, obj, cols, tuples, { chunk = 300 } = {}) {
  const out = [];
  const lit = (v, c) => valueLiteral(v, typeOf(obj, c), dialect.kind);
  for (let i = 0; i < tuples.length; i += chunk) {
    const part = tuples.slice(i, i + chunk);
    const where =
      cols.length === 1
        ? `${dialect.quote(cols[0])} IN (${part.map((t) => lit(t[0], cols[0])).join(', ')})`
        : part.map((t) => `(${cols.map((c, k) => `${dialect.quote(c)} = ${lit(t[k], c)}`).join(' AND ')})`).join(' OR ');
    out.push(`-- trawl:copy-rows read\nSELECT * FROM ${quoted(dialect, obj)} WHERE ${where};`);
  }
  return out;
}

/** A row's primary key, as a string to tell rows apart. */
export const rowKey = (obj, set, row) => tupleKey(obj.columns.filter((c) => c.pk).map((c) => cell(set, row, c.name)));

/**
 * The tables in the order their rows go in: those referred to before those referring to them (a
 * table referring to itself orders its own rows). `groups` are { obj, set } by objectName; `fks` the
 * schema's foreign keys. Returns { order: [names], cycle: bool }.
 */
export function insertOrder(groups, fks) {
  const names = [...groups.keys()];
  const deps = new Map(names.map((n) => [n, new Set()]));
  for (const f of fks) {
    const from = names.find((n) => n.toLowerCase() === f.from.toLowerCase());
    const to = names.find((n) => n.toLowerCase() === f.to.toLowerCase());
    if (from && to && from !== to) deps.get(from).add(to);
  }
  const order = [];
  const left = new Set(names);
  let cycle = false;
  while (left.size) {
    const ready = [...left].filter((n) => [...deps.get(n)].every((d) => !left.has(d)));
    const next = ready.length ? ready : [[...left][0]];
    if (!ready.length) cycle = true;
    for (const n of next) (order.push(n), left.delete(n));
  }
  return { order, cycle };
}

/** A table's rows ordered so a row another row of it refers to (a manager, a parent category) comes first. */
export function selfOrder(obj, set, fks) {
  const self = fks.filter((f) => f.from.toLowerCase() === objectName(obj).toLowerCase() && f.to.toLowerCase() === objectName(obj).toLowerCase());
  if (!self.length) return set.rows;
  const keyOf = (row, cols) => tupleKey(cols.map((c) => cell(set, row, c)));
  const placed = new Set();
  const out = [];
  let left = [...set.rows];
  while (left.length) {
    const ready = left.filter((row) =>
      self.every((f) => {
        const refs = f.columns.map(([from]) => cell(set, row, from));
        if (refs.some((v) => v == null)) return true;
        const target = tupleKey(refs);
        const there = set.rows.find((r) => keyOf(r, f.columns.map(([, to]) => to)) === target);
        return !there || there === row || placed.has(there);
      }),
    );
    const next = ready.length ? ready : left;
    for (const r of next) (out.push(r), placed.add(r));
    left = left.filter((r) => !placed.has(r));
  }
  return out;
}

// Columns no INSERT can give a value: computed ones, and SQL Server's rowversion.
const insertable = (c) => !c.computed && !/^(rowversion|timestamp)$/i.test(String(c.type).trim());

/**
 * The script that puts the rows in on the target, in one transaction: each table's rows (`tables`:
 * [{ obj, set, rows }] in insertOrder), skipping any whose key is there already. SQL Server: IF NOT
 * EXISTS before each INSERT, with IDENTITY_INSERT on around a table that has an identity; Postgres:
 * ON CONFLICT DO NOTHING (OVERRIDING SYSTEM VALUE for identity columns); MySQL: INSERT IGNORE.
 * `head` lines go first as comments. Returns { script, rows }.
 */
export function copyScript(tables, dialect, { head = [] } = {}) {
  const kind = dialect.kind;
  const out = ['-- trawl:copy-rows insert', ...head.map((h) => `-- ${h}`)];
  let total = 0;
  out.push(kind === 'sqlserver' ? 'SET XACT_ABORT ON;\nBEGIN TRANSACTION;' : `${dialect.begin}`);
  for (const { obj, set, rows } of tables) {
    if (!rows.length) continue;
    const name = quoted(dialect, obj);
    const cols = set.columns.map((c, i) => ({ c: obj.columns.find((x) => x.name.toLowerCase() === c.name.toLowerCase()) ?? { ...c, pk: false }, i })).filter(({ c }) => insertable(c));
    const keys = obj.columns.filter((c) => c.pk);
    const identity = cols.some(({ c }) => c.identity);
    const list = cols.map(({ c }) => dialect.quote(c.name)).join(', ');
    const values = (row) => cols.map(({ c, i }) => valueLiteral(row[i], c.type, kind)).join(', ');
    out.push('', `-- ${objectName(obj)}: ${rows.length} row${rows.length === 1 ? '' : 's'}`);
    if (kind === 'sqlserver' && identity) out.push(`SET IDENTITY_INSERT ${name} ON;`);
    for (const row of rows) {
      total++;
      if (kind === 'sqlserver') {
        const where = keys.map((k) => `${dialect.quote(k.name)} = ${valueLiteral(cell(set, row, k.name), k.type, kind)}`).join(' AND ');
        out.push(`IF NOT EXISTS (SELECT 1 FROM ${name} WHERE ${where}) INSERT INTO ${name} (${list}) VALUES (${values(row)});`);
      } else if (kind === 'postgres') out.push(`INSERT INTO ${name} (${list})${identity ? ' OVERRIDING SYSTEM VALUE' : ''} VALUES (${values(row)}) ON CONFLICT DO NOTHING;`);
      else out.push(`INSERT IGNORE INTO ${name} (${list}) VALUES (${values(row)});`);
    }
    if (kind === 'sqlserver' && identity) out.push(`SET IDENTITY_INSERT ${name} OFF;`);
  }
  out.push('', kind === 'sqlserver' ? 'COMMIT TRANSACTION;' : dialect.commit);
  return { script: `${out.join('\n')}\n`, rows: total };
}

/** How many rows a run of the script added, from its "n rows affected" messages. */
export const insertedRows = (messages) => (messages ?? []).reduce((n, m) => n + Number(/^(\d+) rows? affected/.exec(m)?.[1] ?? 0), 0);
