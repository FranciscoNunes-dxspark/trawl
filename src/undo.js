// Undo for data changes (/undo-write): before an UPDATE or DELETE runs, Trawl reads the rows it is
// about to change (a capped SELECT * over the same FROM and WHERE) and keeps them, so the script that
// puts them back can be written later: an UPDATE back to the old values by primary key, or an INSERT
// of the deleted rows. An INSERT whose keys are in its VALUES is undone by deleting those keys.
// Pure: actions.js runs the SELECT and config.js keeps the copies in ~/.trawl/undo/, never config.json.
import { mask, oneLine, splitStatements, withoutLeadingComments } from './sql.js';
import { DIALECTS } from './dialects.js';
import { NAME, canEdit, exactType, findTable, unquote, valueLiteral } from './edit.js';

// More rows than this and no copy is kept: the statement runs as before.
export const UNDO_ROWS = 10_000;
// Copies kept per connection, newest first.
export const UNDO_KEEP = 10;

/** Words outside parentheses, each with where it starts in the mask. */
function topWords(masked) {
  const out = [];
  let depth = 0;
  for (const t of masked.matchAll(/[\w@#$]+|[()]/g)) {
    if (t[0] === '(') depth++;
    else if (t[0] === ')') depth = Math.max(0, depth - 1);
    else if (!depth) out.push({ w: t[0].toUpperCase(), at: t.index, end: t.index + t[0].length });
  }
  return out;
}

/** Splits src[from, to) on commas outside parentheses (and strings, through the mask). */
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

/** Where the parenthesis opening at `open` closes, or -1. */
function closing(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '(') depth++;
    else if (masked[i] === ')' && !--depth) return i;
  }
  return -1;
}

// What can't be copied safely, when it stands outside parentheses: the rows read would not be the
// rows changed (TOP, LIMIT, a join), or the statement does more than change rows of its table.
const REFUSED = {
  OUTPUT: 'it has OUTPUT',
  TOP: 'it has TOP, so which rows it changes is up to the server',
  LIMIT: 'it has LIMIT, so which rows it changes is up to the server',
  ORDER: 'it has ORDER BY',
  JOIN: 'it reads other tables too (a join)',
  APPLY: 'it reads other tables too (APPLY)',
  USING: 'it reads other tables too (USING)',
  CURRENT: 'it works on a cursor (WHERE CURRENT OF)',
  OPENQUERY: 'it changes rows on another server',
  OPENROWSET: 'it changes rows on another server',
  WITH: 'it has table hints or a CTE',
};
const TARGET = new RegExp(String.raw`^\s*(${NAME}(?:\s*\.\s*${NAME}){0,2})(?:\s+(?:AS\s+)?(${NAME}))?\s*$`, 'is');
const LITERAL = /^(?:-?\d+(?:\.\d+)?|N?'(?:[^']|'')*')$/is;

/**
 * What Trawl can keep to undo `sql`, a script about to run: null when it isn't an INSERT, UPDATE or
 * DELETE at all; { reason } when it is but can't be copied safely (several statements, no primary
 * key, a join, OUTPUT, TOP…); otherwise { op, table, keys, select, setColumns } for an UPDATE or
 * DELETE (`select` reads the rows it would change, at most UNDO_ROWS + 1 of them; `setColumns` the
 * columns an UPDATE sets) or { op: 'insert', table, keys, inserted } for an INSERT whose keys are
 * plain values in it (`inserted`: each row's key literals, as written).
 */
export function undoPlan(sql, schema, { kind = 'sqlserver' } = {}) {
  const statements = splitStatements(String(sql ?? ''));
  const dml = (text) => /^(INSERT|UPDATE|DELETE|MERGE)\b/i.test(withoutLeadingComments(text));
  if (!statements.some((s) => dml(s.text))) return null;
  if (statements.length !== 1) return { reason: 'it is several statements' };
  const src = withoutLeadingComments(statements[0].text).replace(/;\s*$/, '');
  const masked = mask(src);
  const words = topWords(masked);
  const op = words[0]?.w;
  if (op === 'MERGE') return { reason: 'it is a MERGE' };
  for (const { w } of words) if (REFUSED[w] && !(op === 'INSERT' && w === 'WITH')) return { reason: REFUSED[w] };
  if (op === 'INSERT') return insertPlan(src, masked, words, schema, kind);
  const at = (word, after = 0) => words.find((t) => t.w === word && t.at >= after);
  const where = at('WHERE');
  const returning = at('RETURNING');
  const end = returning?.at ?? src.length;
  let targetText;
  let setColumns = null;
  if (op === 'UPDATE') {
    const set = at('SET');
    if (!set) return { reason: "it isn't an UPDATE … SET" };
    if (at('FROM', set.end)) return { reason: 'it reads other tables too (FROM)' };
    targetText = src.slice(words[0].end, set.at);
    setColumns = [];
    for (const item of splitTop(src, masked, set.end, where?.at ?? end)) {
      const m = item.match(new RegExp(String.raw`^(?:${NAME}\s*\.\s*)?(${NAME})\s*[-+*/%&|^]?=`, 's'));
      if (!m || /^@/.test(m[1])) return { reason: "Trawl can't tell which columns it sets" };
      setColumns.push(unquote(m[1]));
    }
  } else {
    const froms = words.filter((t) => t.w === 'FROM');
    if (froms.length > 1 || (froms.length === 1 && froms[0] !== words[1])) return { reason: 'it deletes through DELETE … FROM, which can join other tables' };
    targetText = src.slice((froms[0] ?? words[0]).end, where?.at ?? end);
  }
  if (targetText.includes(',')) return { reason: 'it changes several tables' };
  const target = targetText.match(TARGET);
  if (!target) return { reason: "Trawl can't tell which table it changes" };
  const found = tableWithKey(target[1], schema, kind);
  if (found.reason) return found;
  const { table, keys } = found;
  if (setColumns) {
    const unknown = setColumns.find((c) => !table.columns.some((tc) => tc.name.toLowerCase() === c.toLowerCase()));
    if (unknown) return { reason: `${unknown} isn't a column of ${table.schema}.${table.name} that Trawl knows` };
    const key = setColumns.find((c) => keys.some((k) => k.toLowerCase() === c.toLowerCase()));
    if (key) return { reason: `it changes the primary key (${key}), which the undo would find the rows by` };
  }
  const from = `${target[1].trim()}${target[2] ? ` ${target[2]}` : ''}`;
  const filter = where ? ` ${src.slice(where.at, end).trim()}` : '';
  const select =
    kind === 'sqlserver'
      ? `-- trawl:snapshot\nSELECT TOP (${UNDO_ROWS + 1}) * FROM ${from}${filter};`
      : `-- trawl:snapshot\nSELECT ${kind === 'postgres' ? pgColumns(table) : '*'} FROM ${from}${filter} LIMIT ${UNDO_ROWS + 1};`;
  return { op: op.toLowerCase(), table, keys, select, setColumns };
}

/**
 * Postgres's columns for the copy, each as the server writes it (::text) but bytea: the text goes back
 * into its type exactly, where pg's JavaScript values wouldn't (a timestamp's microseconds, an
 * interval, json's own spacing, an array of anything).
 */
function pgColumns(table) {
  const q = DIALECTS.postgres.quote;
  return table.columns.map((c) => (/^bytea$/i.test(c.type) ? q(c.name) : `${q(c.name)}::text AS ${q(c.name)}`)).join(', ');
}

/**
 * Whether a column of the copy can be given its value back. On Postgres every one but a generated
 * column can (and an identity, for an UPDATE): the copy holds each value as the server wrote it.
 */
const restorable = (c, kind, { update = false } = {}) => !c.unknown && !c.computed && !(update && c.identity) && (kind === 'postgres' || canEdit({ ...c, identity: false }, kind));

/** The table, when Trawl knows it and it has a primary key whose values match exactly. */
function tableWithKey(text, schema, kind) {
  const found = findTable(text, schema, { kind });
  if (found.reason) return { reason: found.reason.replace('; edit it from a connection to that database', '') };
  const { table } = found;
  const pk = table.columns.filter((c) => c.pk);
  if (!pk.length) return { reason: `${table.schema}.${table.name} has no primary key to find the rows by` };
  const odd = pk.find((k) => !exactType(k.type, kind));
  if (odd) return { reason: `its key ${odd.name} is ${odd.type}, which can't be matched exactly` };
  return { table, keys: pk.map((k) => k.name) };
}

// INSERT [INTO] t (columns) VALUES (…), (…): the keys of the rows it adds, when they're written in it.
function insertPlan(src, masked, words, schema, kind) {
  for (const w of ['SELECT', 'EXEC', 'EXECUTE', 'ON', 'IGNORE', 'DEFAULT']) {
    if (words.some((t) => t.w === w)) return { reason: w === 'ON' ? 'it may update rows that are there already (ON CONFLICT, ON DUPLICATE KEY)' : w === 'IGNORE' ? 'INSERT IGNORE may skip rows that are there already' : "the rows it adds aren't written in it" };
  }
  const head = src.match(new RegExp(String.raw`^\s*INSERT\s+(?:INTO\s+)?(${NAME}(?:\s*\.\s*${NAME}){0,2})\s*\(`, 'is'));
  if (!head) return { reason: "the rows it adds can't be told apart (no column list)" };
  const found = tableWithKey(head[1], schema, kind);
  if (found.reason) return found;
  const { table, keys } = found;
  const open = head[0].length - 1;
  const close = closing(masked, open);
  if (close < 0) return { reason: "Trawl can't read its column list" };
  const columns = splitTop(src, masked, open + 1, close).map((c) => unquote(c).toLowerCase());
  const keyAt = keys.map((k) => columns.indexOf(k.toLowerCase()));
  const values = masked.slice(close + 1).match(/^\s*VALUES\s*/i);
  if (!values) return { reason: "the rows it adds aren't written in it" };
  const missing = keys.filter((_, i) => keyAt[i] < 0);
  if (missing.length) return { reason: `its key (${missing.join(', ')}) is the server's to give, so which rows it adds isn't known` };
  const inserted = [];
  let i = close + 1 + values[0].length;
  for (;;) {
    if (masked[i] !== '(') return { reason: "Trawl can't read its VALUES" };
    const end = closing(masked, i);
    if (end < 0) return { reason: "Trawl can't read its VALUES" };
    const row = splitTop(src, masked, i + 1, end);
    if (row.length !== columns.length) return { reason: "its VALUES don't match its columns" };
    const key = keyAt.map((k) => row[k]);
    if (key.some((v) => !LITERAL.test(v))) return { reason: "its key values aren't plain values, so which rows it adds isn't known" };
    inserted.push(key);
    if (inserted.length > UNDO_ROWS) return { reason: `it adds more than ${UNDO_ROWS.toLocaleString('en')} rows` };
    const next = masked.slice(end + 1).match(/^\s*(,)?\s*/);
    i = end + 1 + next[0].length;
    if (!next[1]) break;
  }
  if (!/^\s*(RETURNING\b[\s\S]*)?$/i.test(masked.slice(i))) return { reason: "Trawl can't read its VALUES" };
  return { op: 'insert', table, keys, inserted };
}

// Values as JSON keeps them: dates, bytes and big numbers tagged so they come back as they were.
const encode = (v) => {
  if (v == null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? { $text: String(v) } : { $date: v.toISOString() };
  if (Buffer.isBuffer(v)) return { $hex: v.toString('hex') };
  if (typeof v === 'bigint') return { $big: String(v) };
  if (typeof v === 'number' && !Number.isFinite(v)) return { $text: String(v) };
  if (typeof v === 'object') return { $json: v };
  return v;
};
const decode = (v) => {
  if (v == null || typeof v !== 'object') return v;
  if ('$date' in v) return new Date(v.$date);
  if ('$hex' in v) return Buffer.from(v.$hex, 'hex');
  if ('$big' in v) return BigInt(v.$big);
  if ('$text' in v) return v.$text;
  if ('$json' in v) return v.$json;
  return v;
};

/**
 * The copy to keep, from the rows `select` read (`set`): { at, conn, database, kind, op, sql, table,
 * keys, columns, setColumns, rows } or { reason } (too many rows, or the key isn't among them).
 * An INSERT's copy is its keys, from the plan alone.
 */
export function snapshotOf(plan, set, { sql, conn, database, kind = 'sqlserver', at = Date.now() }) {
  const base = { at, conn, database, kind, op: plan.op, sql: oneLine(withoutLeadingComments(sql)), table: { schema: plan.table.schema, name: plan.table.name }, keys: plan.keys };
  if (plan.op === 'insert') return { ...base, columns: [], setColumns: null, rows: [], inserted: plan.inserted };
  if (!set) return { reason: 'the copy of the rows came back empty' };
  if (set.truncated || set.rows.length > UNDO_ROWS) return { reason: `it changes more than ${UNDO_ROWS.toLocaleString('en')} rows` };
  const columns = set.columns.map((c) => {
    const tc = plan.table.columns.find((t) => t.name.toLowerCase() === c.name.toLowerCase());
    return tc ? { name: tc.name, type: tc.type, identity: Boolean(tc.identity), computed: Boolean(tc.computed) } : { name: c.name, type: c.type, unknown: true };
  });
  const missing = plan.keys.filter((k) => !columns.some((c) => !c.unknown && c.name.toLowerCase() === k.toLowerCase()));
  if (missing.length) return { reason: `the copy has no ${missing.join(', ')}` };
  return { ...base, columns, setColumns: plan.setColumns ?? null, rows: set.rows.map((r) => r.map(encode)) };
}

/** How many rows a copy holds. */
export const snapshotRows = (s) => (s.op === 'insert' ? s.inserted.length : s.rows.length);

/** The list kept for a connection with `s` added at the front, UNDO_KEEP at most. */
export const withSnapshot = (list, s) => [s, ...(Array.isArray(list) ? list : [])].slice(0, UNDO_KEEP);

const plural = (n, word) => `${n.toLocaleString('en')} ${word}${n === 1 ? '' : 's'}`;

/**
 * The script that undoes what a copy was kept for, in its connection's kind: each row's UPDATE back to
 * its old values by its primary key, the deleted rows' INSERTs (with IDENTITY_INSERT on SQL Server and
 * OVERRIDING SYSTEM VALUE on Postgres when an identity column is among them), or for an INSERT the
 * DELETE of the keys it added. It only goes into the console; nothing runs it by itself.
 */
export function reverseScript(s) {
  const kind = DIALECTS[s.kind] ? s.kind : 'sqlserver';
  const q = DIALECTS[kind].quote;
  const name = `${q(s.table.schema)}.${q(s.table.name)}`;
  const n = snapshotRows(s);
  const when = new Date(s.at).toISOString().replace('T', ' ').slice(0, 19);
  const head = [
    `-- Undoes: ${s.sql}`,
    `-- Run on ${s.conn}/${s.database} at ${when} UTC${s.op === 'insert' ? `, adding ${plural(n, 'row')}` : `; the ${plural(n, 'row')} it changed, as they were before it ran`}.`,
    `-- Nothing has run: read it through, then R runs it (the usual checks apply). Rows changed since then get these values back.`,
  ];
  if (!n) return [...head, '-- It changed no rows, so there is nothing to undo.', ''].join('\n');
  const col = (c) => s.columns.findIndex((x) => !x.unknown && x.name.toLowerCase() === c.toLowerCase());
  const keyAt = s.keys.map(col);
  const lit = (row, i) => valueLiteral(decode(row[i]), s.columns[i].type, kind);
  const whereKey = (row) => s.keys.map((k, j) => `${q(s.columns[keyAt[j]].name)} = ${lit(row, keyAt[j])}`).join(' AND ');
  const body = [];
  if (s.op === 'insert') {
    for (const key of s.inserted) body.push(`DELETE FROM ${name} WHERE ${s.keys.map((k, j) => `${q(k)} = ${key[j]}`).join(' AND ')};`);
  } else if (s.op === 'update') {
    const named = s.setColumns?.length ? s.setColumns.map(col) : s.columns.map((_, i) => i).filter((i) => !keyAt.includes(i));
    const cols = [...new Set(named)].filter((i) => i >= 0 && !keyAt.includes(i) && restorable(s.columns[i], kind, { update: true }));
    if (!cols.length) return [...head, '-- None of the columns it set can be given a value back (identity or computed).', ''].join('\n');
    for (const row of s.rows) body.push(`UPDATE ${name} SET ${cols.map((i) => `${q(s.columns[i].name)} = ${lit(row, i)}`).join(', ')} WHERE ${whereKey(row)};`);
  } else {
    // Every column a value can go back into, the identity too; not computed ones or rowversion.
    const cols = s.columns.map((c, i) => i).filter((i) => restorable(s.columns[i], kind));
    const identity = cols.some((i) => s.columns[i].identity);
    const list = cols.map((i) => q(s.columns[i].name)).join(', ');
    const over = identity && kind === 'postgres' ? ' OVERRIDING SYSTEM VALUE' : '';
    if (identity && kind === 'sqlserver') body.push(`SET IDENTITY_INSERT ${name} ON;`);
    for (let i = 0; i < s.rows.length; i += 1000) {
      const rows = s.rows.slice(i, i + 1000).map((row) => `(${cols.map((c) => lit(row, c)).join(', ')})`);
      body.push(`INSERT INTO ${name} (${list})${over} VALUES\n  ${rows.join(',\n  ')};`);
    }
    if (identity && kind === 'sqlserver') body.push(`SET IDENTITY_INSERT ${name} OFF;`);
  }
  return [...head, ...body, ''].join('\n');
}

/** "UPDATE · 3 rows" and the like, for the list /undo-write shows. */
export function snapshotSummary(s) {
  const n = snapshotRows(s);
  return `${s.op.toUpperCase()} · ${plural(n, 'row')}${s.op === 'insert' ? ' added' : ''}`;
}
