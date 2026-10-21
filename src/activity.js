// The server's sessions and what they're running, as SSMS's Activity Monitor shows them: read from
// sys.dm_exec_sessions and sys.dm_exec_requests in one batch, shaped into rows with the blocking
// chains drawn as a tree. Pure, apart from the SQL it hands the session to run.

// The marker comment lets the demo driver recognise this batch.
export const ACTIVITY_SQL = `-- trawl:activity
SELECT @@SPID AS me;
SELECT s.session_id, s.login_name, s.host_name, s.program_name,
  DB_NAME(COALESCE(r.database_id, s.database_id)) AS database_name,
  COALESCE(r.status, s.status) AS status, r.command, r.wait_type, r.wait_time,
  r.total_elapsed_time AS elapsed_ms, r.blocking_session_id, s.open_transaction_count,
  COALESCE(r.cpu_time, s.cpu_time) AS cpu_ms, COALESCE(r.logical_reads, s.logical_reads) AS logical_reads,
  s.last_request_start_time, t.text AS sql_text
FROM sys.dm_exec_sessions s
LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id
OUTER APPLY (SELECT TOP (1) c.most_recent_sql_handle FROM sys.dm_exec_connections c WHERE c.session_id = s.session_id) c
OUTER APPLY sys.dm_exec_sql_text(COALESCE(r.sql_handle, c.most_recent_sql_handle)) t
WHERE s.is_user_process = 1
ORDER BY s.session_id;`;

const rowsOf = (set) => (set ? set.rows.map((row) => Object.fromEntries(set.columns.map((c, i) => [c.name, row[i]]))) : []);
const num = (v) => (v == null ? null : Number(v));

/**
 * ACTIVITY_SQL's two result sets as { me, sessions }. Each session is { id, login, host, program,
 * database, status, command, wait, waitMs, elapsedMs, blockedBy, openTran, cpuMs, reads, started, sql }.
 */
export function buildActivity(sets) {
  const me = num(rowsOf(sets[0])[0]?.me);
  const sessions = rowsOf(sets[1]).map((r) => ({
    id: num(r.session_id),
    login: r.login_name ?? '',
    host: r.host_name ?? '',
    program: r.program_name ?? '',
    database: r.database_name ?? '',
    status: String(r.status ?? '').trim().toLowerCase(),
    command: r.command ? String(r.command).trim() : '',
    wait: r.wait_type ?? '',
    waitMs: num(r.wait_time),
    elapsedMs: num(r.elapsed_ms),
    // 0 means not blocked, as the server reports it.
    blockedBy: num(r.blocking_session_id) || null,
    openTran: num(r.open_transaction_count) ?? 0,
    cpuMs: num(r.cpu_ms),
    reads: num(r.logical_reads),
    started: r.last_request_start_time ?? null,
    sql: r.sql_text == null ? '' : String(r.sql_text).replace(/\r\n?/g, '\n').trim(),
  }));
  return { me, sessions };
}

/**
 * The rows the Activity view lists: the blocking chains first, each head followed by the sessions
 * it blocks (depth 1, 2, …), then the other sessions. Without `all`, sessions that are only sleeping
 * (no request, no open transaction, blocking no one) are left out, except your own. Each row is
 * { session, depth, blocks } where `blocks` counts the sessions waiting on it, directly or not.
 */
export function activityRows({ me, sessions }, { all = false } = {}) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const children = new Map();
  for (const s of sessions) {
    if (s.blockedBy == null || s.blockedBy === s.id) continue;
    if (!children.has(s.blockedBy)) children.set(s.blockedBy, []);
    children.get(s.blockedBy).push(s);
  }
  const under = (id, seen = new Set()) => {
    let n = 0;
    for (const c of children.get(id) ?? []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      n += 1 + under(c.id, seen);
    }
    return n;
  };
  const out = [];
  const placed = new Set();
  const walk = (s, depth) => {
    if (placed.has(s.id)) return;
    placed.add(s.id);
    out.push({ session: s, depth, blocks: under(s.id) });
    for (const c of children.get(s.id) ?? []) walk(c, depth + 1);
  };
  // Heads: sessions blocking others while not blocked themselves (or blocked by one that isn't listed).
  const heads = sessions.filter((s) => children.has(s.id) && (s.blockedBy == null || !byId.has(s.blockedBy)));
  heads.sort((x, y) => under(y.id) - under(x.id) || x.id - y.id);
  for (const h of heads) walk(h, 0);
  // A deadlock-like cycle has no head: start it anywhere.
  for (const s of sessions) if (children.has(s.id) && !placed.has(s.id) && s.blockedBy != null) walk(s, 0);
  const busy = (s) => all || s.id === me || (s.status && s.status !== 'sleeping') || s.openTran > 0;
  for (const s of sessions) if (!placed.has(s.id) && s.blockedBy == null && busy(s)) walk(s, 0);
  // Blocked by a session we can't see (another database's, say): still worth listing.
  for (const s of sessions) if (!placed.has(s.id) && (busy(s) || s.blockedBy != null)) walk(s, 0);
  return out;
}

/** "850 ms", "12.4 s", "3 min 05 s", "2 h 10 min", for elapsed and wait times. */
export function duration(ms) {
  if (ms == null) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(Math.floor(s % 60)).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** The statement that ends a session; only a number can get into it. */
export function killSql(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${id} isn't a session id.`);
  return `KILL ${n};`;
}

/** The details pane's text for one session. */
export function sessionDetails(s, { me } = {}) {
  const lines = [];
  const add = (label, value) => value !== '' && value != null && lines.push(`${label.padEnd(10)}${value}`);
  add('Session', `${s.id}${s.id === me ? ' (this one: Trawl)' : ''}`);
  add('Login', s.login);
  add('Host', s.host);
  add('Program', s.program);
  add('Database', s.database);
  add('Status', [s.status, s.command].filter(Boolean).join(' · '));
  if (s.blockedBy != null) add('Blocked', `by session ${s.blockedBy}`);
  if (s.wait) add('Waiting', `${s.wait}${s.waitMs != null ? ` for ${duration(s.waitMs)}` : ''}`);
  if (s.elapsedMs != null) add('Elapsed', duration(s.elapsedMs));
  if (s.openTran) add('Open tran', String(s.openTran));
  if (s.cpuMs != null) add('CPU', duration(s.cpuMs));
  if (s.reads != null) add('Reads', `${s.reads.toLocaleString('en')} pages`);
  return [...lines, '', ...(s.sql ? s.sql.split('\n') : ['(no SQL text)'])];
}
