import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityRows, buildActivity, duration, killSql, sessionDetails } from '../src/activity.js';
import { demoSession } from '../src/demo.js';
import { ACTIVITY_SQL } from '../src/activity.js';

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
