// Actual execution plans, pure: SQL Server's SET STATISTICS PROFILE result sets turned into an
// indented tree with each operator's actual and estimated rows, and the same flags laid over
// Postgres's EXPLAIN ANALYZE and MySQL's EXPLAIN ANALYZE text. Operators whose actual rows are 10
// times the estimate or more (either way) are marked, since that is where a plan usually goes wrong.

// How far apart the actual rows and the estimate must be to be marked.
export const OFF_BY = 10;

const PROFILE_COLUMNS = ['Rows', 'Executes', 'StmtText', 'NodeId', 'Parent', 'EstimateRows'];

/** Whether a result set is a STATISTICS PROFILE one (the plan of the statement before it). */
export function isProfileSet(set) {
  const names = new Set((set?.columns ?? []).map((c) => c.name));
  return PROFILE_COLUMNS.every((n) => names.has(n));
}

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/** A row count as the plan shows it: whole numbers with separators, small estimates to one decimal. */
export function rowCount(n) {
  if (n == null) return '?';
  if (!Number.isInteger(n) && n < 10) return String(Math.round(n * 10) / 10);
  return Math.round(n).toLocaleString('en');
}

/**
 * The mark for an operator whose actual rows are OFF_BY times its estimate or more: "▲ 12×" (more
 * than estimated) or "▼ 40×" (fewer), else ''. Counts under 1 count as 1, so 0 against 0.3 is no news.
 */
export function estimateFlag(actual, estimate) {
  if (actual == null || estimate == null) return '';
  const a = Math.max(1, actual);
  const e = Math.max(1, estimate);
  const ratio = a / e;
  if (ratio >= OFF_BY) return `▲ ${Math.round(ratio)}×`;
  if (1 / ratio >= OFF_BY) return `▼ ${Math.round(1 / ratio)}×`;
  return '';
}

/**
 * One STATISTICS PROFILE set as lines of { counts, flag, tree }: the statement first, then its
 * operators indented under their parents. Rows is what an operator produced over all its executions,
 * and EstimateRows is per execution, so the estimate compared is EstimateRows × EstimateExecutions.
 */
export function profileLines(set) {
  const at = Object.fromEntries(set.columns.map((c, i) => [c.name, i]));
  const get = (row, name) => (at[name] == null ? null : row[at[name]]);
  const depth = new Map();
  return set.rows.map((row) => {
    const id = num(get(row, 'NodeId'));
    const parent = num(get(row, 'Parent'));
    const d = parent && depth.has(parent) ? depth.get(parent) + 1 : 0;
    depth.set(id, d);
    const actual = num(get(row, 'Rows'));
    const executes = num(get(row, 'Executes'));
    const perRun = num(get(row, 'EstimateRows'));
    const runs = num(get(row, 'EstimateExecutions'));
    const estimate = perRun == null ? null : perRun * (runs ?? 1);
    const text = String(get(row, 'StmtText') ?? '').replace(/\s+$/, '');
    // The statement's own text can run over several lines: one line here, as the tree's root.
    const op = text.replace(/^\s*\|--/, '').replace(/\s+/g, ' ').trim();
    const tree = d ? `${'   '.repeat(d - 1)}  |--${op}` : op;
    const counts = `actual ${rowCount(actual)} / est ${rowCount(estimate)}${executes > 1 ? ` · ${rowCount(executes)} runs` : ''}`;
    return { counts, flag: estimateFlag(actual, estimate), tree };
  });
}

const LEGEND = `▲ more rows than estimated, ▼ fewer, by ${OFF_BY}× or more: often stale statistics, a parameter sniffed for other values, or a predicate the optimizer can't estimate.`;

/**
 * The plan text of STATISTICS PROFILE sets (a statement each): the counts and the marks in columns
 * on the left, where a long operator line cut off at the edge can't hide them, then the tree.
 */
export function profileText(sets) {
  const blocks = sets.map(profileLines);
  const all = blocks.flat();
  if (!all.length) return '';
  const cw = Math.max(...all.map((l) => l.counts.length));
  const fw = Math.max(0, ...all.map((l) => l.flag.length));
  const line = (l) => `${l.counts.padEnd(cw)}  ${fw ? `${l.flag.padEnd(fw)}  ` : ''}${l.tree}`;
  const text = blocks.map((b) => b.map(line).join('\n')).join('\n\n');
  return fw ? `${text}\n\n${LEGEND}` : text;
}

/**
 * Takes the STATISTICS PROFILE sets out of a run's results: { res (the rows the statements gave,
 * for Results), plan (their text, or '' when none came back) }.
 */
export function splitProfile(res) {
  const plans = res.sets.filter(isProfileSet);
  return { res: { ...res, sets: res.sets.filter((s) => !isProfileSet(s)) }, plan: profileText(plans) };
}

// Postgres: "(cost=0.00..1.15 rows=4 width=40) (actual time=0.010..0.012 rows=3 loops=1)".
// MySQL: "(cost=1.45 rows=4) (actual time=0.03..0.04 rows=3 loops=1)". Both per loop.
const ANALYZED = /\brows=(\d+(?:\.\d+)?)[^()]*\)\s*\(actual[^()]*?\brows=(\d+(?:\.\d+)?)/;

/**
 * EXPLAIN ANALYZE's text (Postgres's, or MySQL's tree) with the mark at the end of each line whose
 * actual rows are OFF_BY times its estimate or more, and the legend under it when any is.
 */
export function flagAnalyzed(text) {
  let any = false;
  const lines = String(text ?? '')
    .split('\n')
    .map((l) => {
      const m = l.match(ANALYZED);
      const flag = m ? estimateFlag(Number(m[2]), Number(m[1])) : '';
      if (!flag) return l;
      any = true;
      return `${l}   ${flag}`;
    });
  return any ? `${lines.join('\n')}\n\n${LEGEND}` : lines.join('\n');
}

/** The plan text of EXPLAIN ANALYZE's result sets: one line per row (MySQL's one row holds them all). */
export function analyzedText(sets) {
  const text = sets.map((s) => s.rows.map((r) => String(r[0] ?? '').replace(/\s+$/, '')).join('\n')).join('\n\n');
  return flagAnalyzed(text);
}
