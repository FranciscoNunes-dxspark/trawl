import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityRows, agentDuration, agentProbe, agentTime, buildActivity, buildJobHistory, buildJobs, buildTopQueries, count, duration, jobDetails, jobHistorySql, jobHistoryText, killSql, nextSort, queryDetails, serverTime, sessionDetails, shortDuration, sortColumn, sortQueries, startJobSql, topProbe } from '../src/activity.js';
import { demoSession } from '../src/demo.js';
import { ACTIVITY_SQL } from '../src/activity.js';
import { DIALECTS } from '../src/dialects.js';
import { classifyScript } from '../src/sql.js';

const S = (id, extra = {}) => ({ id, login: 'u', host: 'h', program: 'p', database: 'db', status: 'sleeping', command: '', wait: '', waitMs: null, elapsedMs: null, blockedBy: null, openTran: 0, cpuMs: 0, reads: 0, started: null, sql: '', ...extra });

test('blocking chains come first, as a tree under the session at their head', () => {
  const sessions = [S(10, { status: 'running' }), S(20, { openTran: 1 }), S(30, { status: 'suspended', blockedBy: 20 }), S(40, { status: 'suspended', blockedBy: 30 }), S(50), S(60, { status: 'suspended', blockedBy: 20 })];
  const rows = activityRows({ me: 10, sessions });
  assert.deepEqual(rows.map((r) => [r.session.id, r.depth, r.blocks]), [[20, 0, 3], [30, 1, 1], [40, 2, 0], [60, 1, 0], [10, 0, 0]]);
  // Idle sessions only with `all`.
  assert.ok(activityRows({ me: 10, sessions }, { all: true }).some((r) => r.session.id === 50));
});

test('a cycle of sessions blocking each other is still listed, once each', () => {
  const rows = activityRows({ me: 1, sessions: [S(5, { blockedBy: 6, status: 'suspended' }), S(6, { blockedBy: 5, status: 'suspended' })] });
  assert.deepEqual(rows.map((r) => r.session.id).sort(), [5, 6]);
});

test('the catalog rows are shaped into sessions, 0 meaning not blocked', () => {
  const sets = [
    { columns: [{ name: 'me' }], rows: [[52]] },
    { columns: ['session_id', 'login_name', 'status', 'blocking_session_id', 'wait_type', 'wait_time', 'elapsed_ms', 'sql_text'].map((name) => ({ name })), rows: [[53, 'etl', 'suspended ', 0, 'LCK_M_S', 1200, 1300, 'SELECT 1\r\nFROM t']] },
  ];
  const { me, sessions } = buildActivity(sets);
  assert.equal(me, 52);
  assert.equal(sessions[0].blockedBy, null);
  assert.equal(sessions[0].status, 'suspended');
  assert.equal(sessions[0].sql, 'SELECT 1\nFROM t');
  assert.match(sessionDetails(sessions[0], { me }).join('\n'), /Waiting   LCK_M_S for 1\.2 s/);
});

test('durations read as people say them, and KILL only takes a number', () => {
  assert.equal(duration(850), '850 ms');
  assert.equal(duration(12_400), '12.4 s');
  assert.equal(duration(185_000), '3 min 05 s');
  assert.equal(duration(7_800_000), '2 h 10 min');
  assert.equal(killSql('53'), 'KILL 53;');
  assert.throws(() => killSql('53; DROP TABLE x'), /isn't a session id/);
});

test('the demo answers the activity query with a blocking chain, and KILL frees what was waiting', async () => {
  const s = demoSession({ name: 'demo', demo: true, database: 'ClubA' });
  const read = async () => buildActivity((await s.run(ACTIVITY_SQL)).sets);
  const before = activityRows(await read());
  assert.deepEqual(before.slice(0, 3).map((r) => [r.session.id, r.depth]), [[53, 0], [61, 1], [64, 2]]);
  await s.run('KILL 53;');
  const after = await read();
  assert.ok(!after.sessions.some((x) => x.id === 53));
  assert.equal(after.sessions.find((x) => x.id === 61).blockedBy, null);
  await assert.rejects(s.run(`KILL ${after.me};`), /kill your own process/);
});

test('the Agent keeps dates as yyyymmdd and times as hhmmss numbers, durations as hhmmss too', () => {
  assert.equal(agentTime(20261021, 23015).toISOString(), '2026-10-21T02:30:15.000Z');
  assert.equal(agentTime(0, 0), null);
  assert.equal(serverTime(agentTime(20261021, 230000)), '2026-10-21 23:00');
  assert.equal(agentDuration(10203), (3600 + 120 + 3) * 1000);
  assert.equal(agentDuration(1000000), 100 * 3600 * 1000, 'hours past 99');
  assert.equal(agentDuration(null), null);
});

test('jobs: running now, the last outcome by its status number, the next run; no Agent on Azure SQL Database', () => {
  const now = new Date(Date.UTC(2026, 9, 21, 12, 0, 0));
  const cols = ['job_id', 'name', 'enabled', 'running_since', 'server_now', 'last_status', 'last_run_date', 'last_run_time', 'last_duration', 'next_run_date', 'next_run_time'];
  const sets = [{ columns: cols.map((name) => ({ name })), rows: [['ABC', 'Backup', 1, null, now, 0, 20261021, 20000, 205, 20261021, 230000], ['DEF', 'Load', 0, new Date(now - 90_000), now, null, null, null, null, 0, 0]] }];
  const [backup, load] = buildJobs(sets);
  assert.equal(backup.id, 'abc');
  assert.deepEqual([backup.running, backup.last.status, backup.last.durationMs, serverTime(backup.nextRun)], [false, 'failed', 125_000, '2026-10-21 23:00']);
  assert.deepEqual([load.enabled, load.running, load.runningMs, load.last, load.nextRun], [false, true, 90_000, null, null]);
  assert.match(jobDetails(load).join('\n'), /Running   since 2026-10-21 11:58 \(1 min 30 s\)/);
  assert.match(agentProbe([{ columns: [{ name: 'engine_edition' }], rows: [[5]] }]).unavailable, /Azure SQL Database has no SQL Agent/);
  assert.equal(agentProbe([{ columns: [{ name: 'engine_edition' }], rows: [[8]] }]).unavailable, null, 'Managed Instance has one');
});

test("a job's history groups each run's steps under its step-0 row, and says what failed steps said", () => {
  const row = (id, step, status, time, message = '') => [id, step, step ? `Step ${step}` : '(Job outcome)', status, 20261021, time, 5, message];
  const rows = [row(1, 1, 1, 10000), row(2, 0, 1, 10000), row(3, 1, 1, 20000), row(4, 2, 0, 20005, 'Cannot open backup device.'), row(5, 0, 0, 20000, 'The job failed.'), row(6, 1, 1, 30000)].reverse();
  const sets = [{ columns: ['instance_id', 'step_id', 'step_name', 'run_status', 'run_date', 'run_time', 'run_duration', 'message'].map((name) => ({ name })), rows }];
  const runs = buildJobHistory(sets);
  assert.deepEqual(runs.map((r) => [r.status, r.steps.length]), [['running', 1], ['failed', 2], ['succeeded', 1]]);
  const text = jobHistoryText({ name: 'Backup' }, runs);
  assert.match(text, /^… running\s+2026-10-21 03:00/);
  assert.match(text, /✗ failed\s+2026-10-21 02:00\s+5\.0 s\n    step 2 \(Step 2\): Cannot open backup device\./);
  assert.match(jobHistoryText({ name: 'Never' }, []), /Never has no history/);
});

test('starting a job is a write, and only a GUID gets into the history query', () => {
  assert.equal(startJobSql("Bob's job"), "EXEC msdb.dbo.sp_start_job @job_name = N'Bob''s job';");
  assert.equal(classifyScript(startJobSql('Backup')).write, true);
  assert.match(jobHistorySql('1f0c6a52-7d1e-4b8a-9c3e-2a5b7d9e0f11'), /job_id = '1f0c6a52-7d1e-4b8a-9c3e-2a5b7d9e0f11'/);
  assert.throws(() => jobHistorySql("x'; DROP TABLE t; --"), /isn't a job id/);
});

test('top queries: Query Store when it is on, the plan cache when not; pg_stat_statements and performance_schema elsewhere', () => {
  const ss = DIALECTS.sqlserver.topQueries;
  assert.equal(ss.plan({ database: 'A', store: 'READ_WRITE' }, 'cpu_ms').source, 'query_store');
  assert.match(ss.plan({ database: 'A', store: 'READ_WRITE' }, 'cpu_ms').sql, /ORDER BY COALESCE\(t\.cpu_ms, 0\) DESC/);
  const off = ss.plan({ database: 'A', store: 'OFF' }, 'total_ms');
  assert.equal(off.source, 'dm_exec_query_stats');
  assert.match(off.note, /Query Store is off for A, so this is the plan cache/);
  const pg = DIALECTS.postgres.topQueries;
  assert.match(pg.plan({ database: 'shop', store: null }).unavailable, /CREATE EXTENSION pg_stat_statements/);
  assert.match(pg.plan({ database: 'shop', store: '1.10' }, 'total_ms').sql, /SUM\(s\.total_exec_time\)/);
  assert.match(pg.plan({ database: 'shop', store: '1.6' }, 'total_ms').sql, /SUM\(s\.total_time\)/);
  assert.match(DIALECTS.mysql.topQueries.plan({ store: 0 }).unavailable, /performance_schema is off/);
  // Every source reads the same columns.
  const plans = [ss.plan({ store: 'READ_ONLY' }, 'total_ms'), off, pg.plan({ store: '1.10' }, 'total_ms'), DIALECTS.mysql.topQueries.plan({ store: 1 }, 'total_ms')];
  for (const p of plans) for (const c of ['source', 'query_id', 'sql_text', 'plans', 'executions', 'total_ms', 'cpu_ms', 'logical_reads', 'last_run']) assert.match(p.sql, new RegExp(`AS ${c}\\b`), `${p.source}: ${c}`);
  assert.deepEqual(Object.values(DIALECTS).map((d) => Boolean(d.jobs.sql)), [true, false, false]);
});

test('top queries are sorted by what was asked, o goes through the sorts the source has, and numbers fit their columns', () => {
  const sets = [{ columns: ['query_id', 'sql_text', 'executions', 'total_ms', 'cpu_ms', 'logical_reads'].map((name) => ({ name })), rows: [['a', 'SELECT 1', 10, 100, 90, 5], ['b', 'SELECT 2', 1000, 50, 10, 500]] }];
  const qs = buildTopQueries(sets);
  assert.equal(qs[1].avgMs, 0.05);
  assert.deepEqual(sortQueries(qs, 'executions').map((q) => q.id), ['b', 'a']);
  assert.deepEqual(sortQueries(qs, 'cpu').map((q) => q.id), ['a', 'b']);
  assert.equal(sortColumn('reads'), 'logical_reads');
  assert.equal(nextSort('duration', 'query_store'), 'cpu');
  assert.equal(nextSort('duration', 'pg_stat_statements'), 'reads', 'no CPU time on Postgres');
  assert.equal(nextSort('executions', 'query_store'), 'duration');
  assert.deepEqual([count(4210), count(48_210), count(12_400_000)], ['4210', '48.2k', '12.4M']);
  assert.deepEqual([shortDuration(0.1), shortDuration(23), shortDuration(12_600), shortDuration(151_000), shortDuration(7_800_000)], ['0.1ms', '23ms', '12.6s', '2m31s', '2h10m']);
  assert.match(queryDetails({ ...qs[1], plans: 3 }, { source: 'query_store' }).join('\n'), /Average   0\.05 ms[\s\S]*Plans     3 in Query Store \(it has run with different plans\)[\s\S]*SELECT 2/);
});

test('the demo answers the jobs and top-queries queries, and starts a job', async () => {
  const s = demoSession({ name: 'demo', demo: true, database: 'ClubA' });
  const d = DIALECTS.sqlserver;
  assert.equal(agentProbe((await s.run(d.jobs.probe)).sets).unavailable, null);
  const jobs = buildJobs((await s.run(d.jobs.sql)).sets);
  assert.deepEqual(jobs.map((j) => [j.name, j.running, j.last?.status ?? null]), [['Backup ClubA', false, 'failed'], ['Nightly load', false, 'succeeded'], ['Old archive', false, null], ['Stats refresh', true, 'succeeded']]);
  const runs = buildJobHistory((await s.run(jobHistorySql(jobs[0].id))).sets);
  assert.equal(runs[0].status, 'failed');
  await s.run(startJobSql('Old archive'));
  assert.ok(buildJobs((await s.run(d.jobs.sql)).sets).find((j) => j.name === 'Old archive').running);
  await assert.rejects(s.run(startJobSql('Stats refresh')), /already running/);
  const probe = topProbe((await s.run(d.topQueries.probe)).sets);
  assert.deepEqual(probe, { database: 'ClubA', store: 'READ_WRITE' });
  const qs = buildTopQueries((await s.run(d.topQueries.plan(probe, 'total_ms').sql)).sets);
  assert.equal(qs.length, 4);
});
