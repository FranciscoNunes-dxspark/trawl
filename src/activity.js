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

/** The same in a narrow column: "850ms", "12.4s", "3m05s", "2h10m". */
export function shortDuration(ms) {
  if (ms == null) return '';
  if (ms < 10) return `${Number(ms.toFixed(1))}ms`;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(Math.floor(s % 60)).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
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

// SQL Agent jobs, from msdb: what each is, whether it runs now (sysjobactivity, in the Agent's
// latest session), how its last run ended (sysjobhistory's step 0, the job's own outcome) and when
// it runs next (sysjobschedules). The Agent keeps dates and times as yyyymmdd and hhmmss numbers, in
// the server's local time, which agentTime() turns into dates, as tedious reads a datetime.

// First, which kind of SQL Server this is: Azure SQL Database (5) and a few others have no Agent.
export const AGENT_PROBE_SQL = `-- trawl:jobs-probe
SELECT CONVERT(int, SERVERPROPERTY('EngineEdition')) AS engine_edition, GETDATE() AS server_now;`;

export const JOBS_SQL = `-- trawl:jobs
SELECT CONVERT(varchar(36), j.job_id) AS job_id, j.name, j.enabled, c.name AS category, j.description,
  a.start_execution_date AS running_since, a.last_executed_step_id AS current_step, GETDATE() AS server_now,
  h.run_status AS last_status, h.run_date AS last_run_date, h.run_time AS last_run_time,
  h.run_duration AS last_duration, h.message AS last_message, n.next_run_date, n.next_run_time
FROM msdb.dbo.sysjobs j
LEFT JOIN msdb.dbo.syscategories c ON c.category_id = j.category_id
OUTER APPLY (
  SELECT TOP (1) ja.start_execution_date, ja.last_executed_step_id
  FROM msdb.dbo.sysjobactivity ja
  WHERE ja.job_id = j.job_id AND ja.session_id = (SELECT MAX(s.session_id) FROM msdb.dbo.syssessions s)
    AND ja.start_execution_date IS NOT NULL AND ja.stop_execution_date IS NULL
  ORDER BY ja.start_execution_date DESC
) a
OUTER APPLY (
  SELECT TOP (1) jh.run_status, jh.run_date, jh.run_time, jh.run_duration, jh.message
  FROM msdb.dbo.sysjobhistory jh
  WHERE jh.job_id = j.job_id AND jh.step_id = 0
  ORDER BY jh.instance_id DESC
) h
OUTER APPLY (
  SELECT TOP (1) js.next_run_date, js.next_run_time
  FROM msdb.dbo.sysjobschedules js
  JOIN msdb.dbo.sysschedules sc ON sc.schedule_id = js.schedule_id
  WHERE js.job_id = j.job_id AND sc.enabled = 1 AND js.next_run_date > 0
  ORDER BY js.next_run_date, js.next_run_time
) n
ORDER BY j.name;`;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A job's runs, newest first, each step's row and the job's own (step 0). Only a GUID gets into it. */
export function jobHistorySql(id) {
  if (!GUID.test(String(id))) throw new Error(`${id} isn't a job id.`);
  return `-- trawl:job-history
SELECT TOP (300) h.instance_id, h.step_id, h.step_name, h.run_status, h.run_date, h.run_time, h.run_duration, h.message
FROM msdb.dbo.sysjobhistory h
WHERE h.job_id = '${id}'
ORDER BY h.instance_id DESC;`;
}

/** The statement that starts a job, by its name (quoted). EXEC makes it a write, as classify() says. */
export const startJobSql = (name) => `EXEC msdb.dbo.sp_start_job @job_name = N'${String(name).replace(/'/g, "''")}';`;

// SERVERPROPERTY('EngineEdition') of the kinds with no SQL Agent.
const NO_AGENT = { 4: 'SQL Server Express', 5: 'Azure SQL Database', 6: 'Azure Synapse Analytics', 9: 'Azure SQL Edge', 11: 'Azure Synapse serverless SQL' };

/** AGENT_PROBE_SQL's row as { edition, unavailable }: why there are no jobs to read, or null. */
export function agentProbe(sets) {
  const edition = num(rowsOf(sets[0])[0]?.engine_edition);
  const what = NO_AGENT[edition];
  const unavailable = what ? `${what} has no SQL Agent, so there are no jobs to list.${edition === 5 ? ' Elastic jobs or Azure Automation do that work there.' : ''}` : null;
  return { edition, unavailable };
}

/** yyyymmdd and hhmmss as the Agent keeps them, as a Date whose UTC fields are the server's clock. */
export function agentTime(date, time = 0) {
  const d = num(date);
  if (!d) return null;
  const t = num(time) ?? 0;
  return new Date(Date.UTC(Math.floor(d / 10000), (Math.floor(d / 100) % 100) - 1, d % 100, Math.floor(t / 10000), Math.floor(t / 100) % 100, t % 100));
}

/** run_duration's hhmmss (hours can go past 99) in milliseconds. */
export function agentDuration(hhmmss) {
  const d = num(hhmmss);
  if (d == null) return null;
  return ((Math.floor(d / 10000) * 60 + (Math.floor(d / 100) % 100)) * 60 + (d % 100)) * 1000;
}

const RUN_STATUS = { 0: 'failed', 1: 'succeeded', 2: 'retry', 3: 'cancelled', 4: 'running' };
const clean = (s) => (s == null ? '' : String(s).replace(/\r\n?/g, '\n').trim());

/**
 * JOBS_SQL's rows as jobs: { id, name, enabled, category, description, running, runningSince,
 * runningMs, step, last: { status, at, durationMs, message } or null, nextRun }. Dates are the
 * server's clock (see agentTime).
 */
export function buildJobs(sets) {
  return rowsOf(sets[0]).map((r) => {
    const now = r.server_now instanceof Date ? r.server_now : null;
    const since = r.running_since instanceof Date ? r.running_since : null;
    return {
      id: String(r.job_id ?? '').toLowerCase(),
      name: r.name ?? '',
      enabled: Boolean(num(r.enabled)),
      category: r.category ?? '',
      description: clean(r.description),
      running: Boolean(since),
      runningSince: since,
      runningMs: since && now ? Math.max(0, now - since) : null,
      step: num(r.current_step) || null,
      last: r.last_status == null ? null : { status: RUN_STATUS[num(r.last_status)] ?? 'unknown', at: agentTime(r.last_run_date, r.last_run_time), durationMs: agentDuration(r.last_duration), message: clean(r.last_message) },
      nextRun: agentTime(r.next_run_date, r.next_run_time),
    };
  });
}

/** A server-clock date as "2026-10-21 02:00". */
export const serverTime = (d) => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 16).replace('T', ' ') : '');

/** The details pane's text for one job. */
export function jobDetails(job) {
  const lines = [];
  const add = (label, value) => value !== '' && value != null && lines.push(`${label.padEnd(10)}${value}`);
  add('Job', job.name);
  add('Category', job.category);
  add('Enabled', job.enabled ? 'yes' : 'no: only starts by hand');
  if (job.running) add('Running', `since ${serverTime(job.runningSince)}${job.runningMs != null ? ` (${duration(job.runningMs)})` : ''}${job.step ? `, after step ${job.step}` : ''}`);
  if (job.last) add('Last run', `${job.last.status} · ${serverTime(job.last.at)} · ${duration(job.last.durationMs)}`);
  else add('Last run', 'never (or its history was trimmed)');
  add('Next run', job.nextRun ? serverTime(job.nextRun) : 'not scheduled');
  const out = [...lines];
  if (job.description && job.description !== 'No description available.') out.push('', ...job.description.split('\n'));
  if (job.last?.status === 'failed' && job.last.message) out.push('', ...job.last.message.split('\n'));
  return out;
}

/**
 * jobHistorySql's rows (newest first) as runs, newest first: { status, at, durationMs, message, steps }.
 * A run's steps come before its step-0 row; steps after the last one are a run still going.
 */
export function buildJobHistory(sets) {
  const rows = rowsOf(sets[0]).sort((x, y) => num(x.instance_id) - num(y.instance_id));
  const runs = [];
  let steps = [];
  for (const r of rows) {
    const entry = { id: num(r.step_id), name: r.step_name ?? '', status: RUN_STATUS[num(r.run_status)] ?? 'unknown', at: agentTime(r.run_date, r.run_time), durationMs: agentDuration(r.run_duration), message: clean(r.message) };
    if (entry.id === 0) {
      runs.push({ ...entry, steps });
      steps = [];
    } else steps.push(entry);
  }
  if (steps.length) runs.push({ status: 'running', at: steps[0].at, durationMs: null, message: '', steps });
  return runs.reverse();
}

const MARK = { failed: '✗', succeeded: '✓', retry: '↻', cancelled: '–', running: '…', unknown: '?' };

/** The viewer's text for a job's recent runs: one line each, and what the failed steps said. */
export function jobHistoryText(job, runs) {
  const out = [];
  // The Agent writes a step's row when the step ends, so a run going now may have none yet.
  if (job.running && runs[0]?.status !== 'running') out.push(`… running    since ${serverTime(job.runningSince)}${job.runningMs != null ? `, for ${duration(job.runningMs)}` : ''}`);
  if (!runs.length && !out.length) return `${job.name} has no history: it hasn't run, or the Agent's history was trimmed.`;
  for (const run of runs) {
    out.push(`${MARK[run.status] ?? '?'} ${run.status.padEnd(10)} ${serverTime(run.at).padEnd(17)} ${duration(run.durationMs)}`.trimEnd());
    const failed = run.steps.filter((s) => s.status === 'failed');
    for (const s of failed) out.push(`    step ${s.id}${s.name ? ` (${s.name})` : ''}: ${s.message.replace(/\n+/g, ' ')}`);
    if (run.status === 'failed' && !failed.length && run.message) out.push(`    ${run.message.replace(/\n+/g, ' ')}`);
  }
  return out.join('\n');
}

// The queries that cost the most, read the same shape from each source: source, query_id, sql_text,
// plans, executions, total_ms, cpu_ms, logical_reads, last_run. Postgres and MySQL have theirs in
// dialects.js; SQL Server reads Query Store when the database has it on, else the plan cache.

// The database, and its Query Store's state (OFF, READ_ONLY, READ_WRITE, ERROR).
export const TOP_PROBE_SQL = `-- trawl:top-probe
SELECT DB_NAME() AS database_name, (SELECT TOP (1) actual_state_desc FROM sys.database_query_store_options) AS query_store;`;

// What the list can be sorted by, the columns they are, and the order o goes through them.
export const TOP_SORTS = [
  { id: 'duration', column: 'total_ms', label: 'total duration' },
  { id: 'cpu', column: 'cpu_ms', label: 'CPU' },
  { id: 'reads', column: 'logical_reads', label: 'reads' },
  { id: 'executions', column: 'executions', label: 'executions' },
];
export const sortColumn = (sort) => (TOP_SORTS.find((s) => s.id === sort) ?? TOP_SORTS[0]).column;

// Query Store over the last 24 hours: its runtime stats are averages per interval and plan, so the
// totals are the averages times the executions, summed per query. Durations are microseconds.
export const queryStoreSql = (order = 'total_ms') => `-- trawl:top-queries
SELECT TOP (100) * FROM (
  SELECT 'query_store' AS source, CONVERT(varchar(20), a.query_id) AS query_id, qt.query_sql_text AS sql_text,
    (SELECT COUNT(*) FROM sys.query_store_plan p2 WHERE p2.query_id = a.query_id) AS plans,
    a.executions, a.total_ms, a.cpu_ms, a.logical_reads, a.last_run
  FROM (
    SELECT p.query_id, SUM(rs.count_executions) AS executions,
      SUM(rs.avg_duration * rs.count_executions) / 1000.0 AS total_ms,
      SUM(rs.avg_cpu_time * rs.count_executions) / 1000.0 AS cpu_ms,
      SUM(rs.avg_logical_io_reads * rs.count_executions) AS logical_reads,
      MAX(rs.last_execution_time) AS last_run
    FROM sys.query_store_runtime_stats rs
    JOIN sys.query_store_runtime_stats_interval i ON i.runtime_stats_interval_id = rs.runtime_stats_interval_id
    JOIN sys.query_store_plan p ON p.plan_id = rs.plan_id
    WHERE i.end_time > DATEADD(HOUR, -24, SYSDATETIMEOFFSET())
    GROUP BY p.query_id
  ) a
  JOIN sys.query_store_query q ON q.query_id = a.query_id
  JOIN sys.query_store_query_text qt ON qt.query_text_id = q.query_text_id
) t
ORDER BY COALESCE(t.${order}, 0) DESC;`;

// The plan cache since the last restart (or since plans were evicted), this database's plans only,
// per query_hash; the text is the statement of its costliest cached plan. Times are microseconds.
export const queryStatsSql = (order = 'total_ms') => `-- trawl:top-queries
SELECT TOP (100) * FROM (
  SELECT 'dm_exec_query_stats' AS source, CONVERT(varchar(20), s.query_hash, 1) AS query_id,
    SUBSTRING(t.text, s.statement_start_offset / 2 + 1,
      ((CASE s.statement_end_offset WHEN -1 THEN DATALENGTH(t.text) ELSE s.statement_end_offset END) - s.statement_start_offset) / 2 + 1) AS sql_text,
    s.plans, s.executions, s.total_ms, s.cpu_ms, s.logical_reads, s.last_run
  FROM (
    SELECT qs.query_hash, qs.sql_handle, qs.statement_start_offset, qs.statement_end_offset,
      ROW_NUMBER() OVER (PARTITION BY qs.query_hash ORDER BY qs.total_elapsed_time DESC) AS pick,
      COUNT(*) OVER (PARTITION BY qs.query_hash) AS plans,
      SUM(qs.execution_count) OVER (PARTITION BY qs.query_hash) AS executions,
      SUM(qs.total_elapsed_time) OVER (PARTITION BY qs.query_hash) / 1000.0 AS total_ms,
      SUM(qs.total_worker_time) OVER (PARTITION BY qs.query_hash) / 1000.0 AS cpu_ms,
      SUM(qs.total_logical_reads) OVER (PARTITION BY qs.query_hash) AS logical_reads,
      MAX(qs.last_execution_time) OVER (PARTITION BY qs.query_hash) AS last_run
    FROM sys.dm_exec_query_stats qs
    CROSS APPLY (SELECT CONVERT(int, pa.value) AS dbid FROM sys.dm_exec_plan_attributes(qs.plan_handle) pa WHERE pa.attribute = N'dbid') pa
    WHERE pa.dbid = DB_ID()
  ) s
  CROSS APPLY sys.dm_exec_sql_text(s.sql_handle) t
  WHERE s.pick = 1
) x
ORDER BY COALESCE(x.${order}, 0) DESC;`;

// Each source as the list names it, what its reads count, and which sorts it can do.
export const TOP_SOURCES = {
  query_store: { label: 'Query Store, last 24 h', reads: 'pages', sorts: ['duration', 'cpu', 'reads', 'executions'] },
  dm_exec_query_stats: { label: 'plan cache, since the restart', reads: 'pages', sorts: ['duration', 'cpu', 'reads', 'executions'] },
  pg_stat_statements: { label: 'pg_stat_statements, since its reset', reads: 'blocks', sorts: ['duration', 'reads', 'executions'] },
  performance_schema: { label: 'performance_schema, since the restart', reads: 'rows examined', sorts: ['duration', 'reads', 'executions'] },
};

/** The top-probe's row: { database, store } (Query Store's state, the extension's version…). */
export function topProbe(sets) {
  const r = rowsOf(sets[0])[0] ?? {};
  return { database: r.database_name ?? '', store: r.query_store == null ? null : String(r.query_store).trim() };
}

/** The top-queries rows as { id, sql, plans, executions, totalMs, avgMs, cpuMs, reads, lastRun }. */
export function buildTopQueries(sets) {
  return rowsOf(sets[0]).map((r) => {
    const executions = num(r.executions) ?? 0;
    const totalMs = num(r.total_ms);
    return {
      id: String(r.query_id ?? ''),
      sql: clean(r.sql_text),
      plans: num(r.plans),
      executions,
      totalMs,
      avgMs: totalMs != null && executions ? totalMs / executions : null,
      cpuMs: num(r.cpu_ms),
      reads: num(r.logical_reads),
      lastRun: r.last_run ?? null,
    };
  });
}

const SORT_KEY = { duration: 'totalMs', cpu: 'cpuMs', reads: 'reads', executions: 'executions' };

/** The queries, costliest first by `sort` (the server sorts them too; this keeps the demo honest). */
export const sortQueries = (queries, sort) => [...queries].sort((x, y) => (y[SORT_KEY[sort] ?? 'totalMs'] ?? 0) - (x[SORT_KEY[sort] ?? 'totalMs'] ?? 0));

/** The sort after `sort` that `source` can do, for o. */
export function nextSort(sort, source) {
  const sorts = TOP_SOURCES[source]?.sorts ?? TOP_SORTS.map((s) => s.id);
  return sorts[(sorts.indexOf(sort) + 1) % sorts.length];
}

/** 1234567 as "1.2M", 48210 as "48.2k": counts in a narrow column. */
export function count(n) {
  if (n == null) return '';
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}G`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

/** The details pane's (and ↵'s) text for one query: its numbers, then its text in full. */
export function queryDetails(q, { source } = {}) {
  const src = TOP_SOURCES[source];
  const lines = [];
  const add = (label, value) => value !== '' && value != null && lines.push(`${label.padEnd(10)}${value}`);
  add('Query', q.id);
  add('Runs', q.executions.toLocaleString('en'));
  add('Total', duration(q.totalMs));
  // A query that runs often can take well under a millisecond.
  add('Average', q.avgMs != null && q.avgMs < 10 ? `${Number(q.avgMs.toFixed(2))} ms` : duration(q.avgMs));
  if (q.cpuMs != null) add('CPU', duration(q.cpuMs));
  if (q.reads != null) add('Reads', `${Math.round(q.reads).toLocaleString('en')} ${src?.reads ?? 'pages'}`);
  if (q.plans != null) add('Plans', `${q.plans}${source === 'query_store' ? ' in Query Store' : ' cached'}${q.plans > 1 ? ' (it has run with different plans)' : ''}`);
  // Query Store keeps a datetimeoffset, read as UTC; the others keep the server's clock.
  if (q.lastRun) add('Last run', q.lastRun instanceof Date ? `${serverTime(q.lastRun)}${source === 'query_store' ? ' UTC' : ''}` : String(q.lastRun));
  return [...lines, '', ...(q.sql ? q.sql.split('\n') : ['(no SQL text)'])];
}
