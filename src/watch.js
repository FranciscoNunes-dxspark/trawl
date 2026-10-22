// /watch <seconds> [sql] [--until <condition>]: a read run again every few seconds, the cells that
// changed since the run before picked out (compare.js), until esc, another run, or a row matching the
// condition. Pure: App keeps the timer and runs the query; this parses and compares.
import { compareSets } from './compare.js';
import { compareValues, formatValue } from './sql.js';

// Seconds between runs, at least.
export const WATCH_MIN = 2;

const OPS = '(==|=|!=|<>|>=|<=|>|<)';
const NAME = String.raw`(\[(?:[^\]]|\]\])+\]|"(?:[^"]|"")+"|\`(?:[^\`]|\`\`)+\`|[A-Za-z_@#$][\w@#$.]*)`;
const unquote = (s) => {
  const q = s.match(/^([[`"])(.*)[\]`"]$/s);
  return q ? q[2].split((q[1] === '[' ? ']' : q[1]).repeat(2)).join(q[1] === '[' ? ']' : q[1]) : s;
};
const normalOp = (op) => (op === '==' ? '=' : op === '!=' ? '<>' : op);

/**
 * What --until says: { rows: true, op, value } ("rows > 0", "rows = 0"), { column, op, value } ("Status
 * = 'Done'", "Goals >= 10", "FinishedAt IS NOT NULL"), or { error }. A value is a number, 'text' (''
 * inside), NULL, or a bare word taken as text.
 */
export function parseUntil(text) {
  const t = String(text ?? '').trim().replace(/^"([\s\S]*)"$/, '$1').trim();
  const usage = `--until takes "Column = value" (or <>, >, <, >=, <=, IS NULL, IS NOT NULL), "rows > 0" or "rows = 0"`;
  if (!t) return { error: usage };
  let m = t.match(new RegExp(`^rows\\s*${OPS}\\s*(\\d+)$`, 'i'));
  if (m) return { rows: true, op: normalOp(m[1]), value: Number(m[2]) };
  m = t.match(new RegExp(`^${NAME}\\s+IS\\s+(NOT\\s+)?NULL$`, 'is'));
  if (m) return { column: unquote(m[1]), op: m[2] ? '<>' : '=', value: null };
  m = t.match(new RegExp(`^${NAME}\\s*${OPS}\\s*([\\s\\S]+)$`, 's'));
  if (!m) return { error: usage };
  const raw = m[3].trim();
  let value;
  if (/^N?'([\s\S]*)'$/i.test(raw)) value = raw.replace(/^N?'([\s\S]*)'$/i, '$1').replace(/''/g, "'");
  else if (/^-?(\d+\.?\d*|\.\d+)$/.test(raw)) value = Number(raw);
  else if (/^NULL$/i.test(raw)) value = null;
  else if (/^[\w.:-]+$/.test(raw)) value = raw;
  else return { error: usage };
  const op = normalOp(m[2]);
  if (value === null && op !== '=' && op !== '<>') return { error: 'NULL only takes = or <> (IS NULL, IS NOT NULL)' };
  return { column: unquote(m[1]), op, value };
}

/** The condition as it reads back: rows > 0, Status = 'Done', Shirt IS NULL. */
export function untilText(c) {
  if (c.rows) return `rows ${c.op} ${c.value}`;
  if (c.value === null) return `${c.column} IS ${c.op === '<>' ? 'NOT ' : ''}NULL`;
  return `${c.column} ${c.op} ${typeof c.value === 'number' ? c.value : `'${String(c.value).replace(/'/g, "''")}'`}`;
}

/**
 * /watch's arguments: { seconds, sql, until } (`sql` empty for the console's statement), { stop } for
 * /watch stop or off, or { error } (with `empty` when there were none at all).
 */
export function parseWatch(rest) {
  const s = String(rest ?? '').trim();
  if (!s) return { empty: true, error: `/watch <seconds> [sql] [--until <condition>]: at least every ${WATCH_MIN} seconds.` };
  if (/^(stop|off)$/i.test(s)) return { stop: true };
  const m = s.match(/^(\d+(?:\.\d+)?)s?(?:\s+([\s\S]*))?$/i);
  if (!m) return { error: `/watch starts with the seconds between runs: /watch 5 SELECT … (${WATCH_MIN} at least).` };
  const seconds = Number(m[1]);
  if (seconds < WATCH_MIN) return { error: `/watch runs it every ${WATCH_MIN} seconds at most often: /watch ${WATCH_MIN} …` };
  let sql = (m[2] ?? '').trim();
  let until = null;
  const at = sql.search(/(^|\s)--until(\s|$)/i);
  if (at >= 0) {
    until = parseUntil(sql.slice(at).replace(/^\s*--until/i, ''));
    if (until.error) return { error: until.error };
    sql = sql.slice(0, at).trim();
  }
  return { seconds, sql, until };
}

const asNumber = (v) => (typeof v === 'number' || typeof v === 'bigint' ? Number(v) : typeof v === 'string' && /^\s*-?(\d+\.?\d*|\.\d+)\s*$/.test(v) ? Number(v) : null);

function holds(v, op, want) {
  if (want === null) return op === '=' ? v == null : v != null;
  if (v == null) return false;
  let c;
  const n = asNumber(v);
  if (typeof want === 'number' && n != null) c = n - want;
  else if (typeof want === 'number') return false;
  else if (v instanceof Date || typeof v !== 'string') c = op === '=' || op === '<>' ? (formatValue(v).toLowerCase() === want.toLowerCase() ? 0 : 1) : formatValue(v).localeCompare(want, undefined, { numeric: true, sensitivity: 'base' });
  else c = compareValues(v, want);
  return { '=': c === 0, '<>': c !== 0, '>': c > 0, '<': c < 0, '>=': c >= 0, '<=': c <= 0 }[op];
}

/**
 * Whether the result set meets the condition: { matched, row } (`row`, the first that does, for a
 * condition on a column), or { error } when the column isn't in it.
 */
export function untilMatch(c, set) {
  const rows = set?.rows ?? [];
  if (c.rows) return { matched: holds(rows.length, c.op, c.value), row: null };
  const at = (set?.columns ?? []).findIndex((col) => col.name.toLowerCase() === c.column.toLowerCase());
  if (at < 0) return { error: `the result has no column ${c.column}${set?.columns.length ? ` (it has ${set.columns.map((x) => x.name).join(', ')})` : ''}` };
  const row = rows.findIndex((r) => holds(r[at], c.op, c.value));
  return { matched: row >= 0, row: row >= 0 ? row : null };
}

/**
 * The cells of `next` that differ from `prev`, as "row:col" (next's own indexes): the values that
 * changed in a row found again by `keys` (its primary key's column names), and every cell of a row
 * that's new. Without keys a changed row is a new one. Empty when the columns differ.
 */
export function changedCells(prev, next, keys = []) {
  const out = new Set();
  if (!prev || !next) return out;
  let diff;
  try {
    diff = compareSets(prev, next, { keys });
  } catch {
    return out;
  }
  const lower = next.columns.map((c) => c.name.toLowerCase());
  const at = diff.columns.map((c) => lower.indexOf(c.name.toLowerCase()));
  for (const d of diff.changed) for (const i of d.cols) out.add(`${d.index}:${at[i]}`);
  for (const r of diff.addedAt) for (let i = 0; i < next.columns.length; i++) out.add(`${r}:${i}`);
  return out;
}
