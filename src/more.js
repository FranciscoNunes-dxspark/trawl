// Fetching more rows than the row limit let through, pure: whether the result set on screen was cut
// off there, and the SQL that fetches another row limit's worth (500, then 1000, then 1500…).
import { classifyScript } from './sql.js';

/**
 * Whether set `i` of a run's results stopped at the row limit: the limit itself cut it off
 * (`truncated`), or it is the TOP or LIMIT Trawl wrote at the limit (`top`: ↵ in the Explorer, F),
 * which came back full.
 */
export function cutOff(results, i = 0) {
  const set = results?.sets?.[i];
  if (!set) return false;
  if (set.truncated) return true;
  return results.top != null && set.rows.length >= results.top;
}

/** The SQL Trawl wrote with TOP (n) or LIMIT n, asking for `to` rows instead; null when it has neither. */
export function raiseTop(sql, top, to) {
  const t = new RegExp(`\\bTOP \\(${top}\\)`, 'i');
  if (t.test(sql)) return sql.replace(t, `TOP (${to})`);
  const l = new RegExp(`\\bLIMIT ${top}\\b`, 'i');
  if (l.test(sql)) return sql.replace(l, `LIMIT ${to}`);
  return null;
}

/**
 * What runs to fetch more of set `i`: { sql, limit, top } (`top` when Trawl's own TOP or LIMIT was
 * raised with it), or { reason } when there's nothing to fetch or it mustn't run again. `step` is the
 * row limit now; the new limit is the one the results ran with plus that. Only reads run again: a
 * script of several statements runs whole, since which statement gave which set isn't known.
 */
export function moreQuery(results, i, { step, dialect = 'sqlserver' }) {
  if (!results) return { reason: 'Run a query first: there are no rows to fetch more of.' };
  if (!results.sql) return { reason: "These rows didn't come from one query on this connection (a comparison, a fan-out), so there's nothing to run again for more." };
  if (!cutOff(results, i)) return { reason: `All the rows are here: ${results.sets?.[i] ? 'the result set ended before the row limit' : 'there is no result set on screen'}.` };
  if (classifyScript(results.sql, { dialect }).write) return { reason: "This changes data, so it isn't run again to fetch more rows. Run the SELECT on its own, or raise /limit and run it yourself." };
  const limit = (results.limit ?? step) + step;
  if (results.top == null) return { sql: results.sql, limit };
  const sql = raiseTop(results.sql, results.top, limit);
  return sql ? { sql, limit, top: limit } : { reason: `The query's TOP (${results.top}) can't be raised here: edit it, or raise /limit and run it again.` };
}
