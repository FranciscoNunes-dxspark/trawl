import { test } from 'node:test';
import assert from 'node:assert/strict';
import { showActualPlan } from '../src/actions.js';

// Enough ctx for the actual plan on Postgres or MySQL: a session that records what it was sent,
// answering EXPLAIN ANALYZE with `plan` (or failing with `error`), and ctx.query running the runner.
function fakeCtx({ kind = 'postgres', tranCount = 0, plan = [], error = null } = {}) {
  const sent = [];
  const shown = [];
  const notes = [];
  const session = {
    conn: { name: 'shop', kind, commit: 'auto' },
    database: 'shop',
    run: async (sql) => {
      sent.push(sql);
      if (/^EXPLAIN/.test(sql)) {
        if (error) throw new Error(error);
        return { sets: [{ columns: [{ name: 'QUERY PLAN' }], rows: plan.map((l) => [l]) }], messages: [], ms: 1 };
      }
      return { sets: /COUNT/.test(sql) ? [{ columns: [{ name: '' }], rows: [[1]] }] : [], messages: [], ms: 1 };
    },
  };
  const ctx = {
    session,
    tranCount,
    writesAllowed: false,
    config: { limit: 500, connections: [] },
    note: (text, kind) => notes.push({ text, kind }),
    task: async (title, start) => {
      try {
        await start(new AbortController().signal);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e };
      }
    },
    confirm: async () => true,
    query: async (sql, { runner }) => {
      try {
        await runner(session, sql, { signal: new AbortController().signal, limit: 500 });
        return { ok: true };
      } catch (e) {
        notes.push({ text: e.message, kind: 'error' });
        return { ok: false, error: e };
      }
    },
    showText: (title, text) => shown.push({ title, text }),
    rememberOutput: () => {},
  };
  return { ctx, sent, shown, notes };
}

test('on Postgres the actual plan is EXPLAIN (ANALYZE, BUFFERS), in a transaction that is rolled back', async () => {
  const { ctx, sent, shown } = fakeCtx({ plan: ['Seq Scan on players  (cost=0.00..1.15 rows=1 width=40) (actual time=0.01..0.01 rows=40 loops=1)'] });
  await showActualPlan(ctx, 'SELECT * FROM players WHERE goals > 3;');
  assert.deepEqual(sent, ['BEGIN;', 'EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM players WHERE goals > 3', 'ROLLBACK;']);
  assert.equal(shown[0].title, 'Actual plan: SELECT * FROM players WHERE goals > 3;');
  assert.match(shown[0].text, /rows=40 loops=1\)   ▲ 40×/);
  assert.equal(ctx.lastPlan.how, 'EXPLAIN ANALYZE');
  assert.equal(ctx.lastPlan.actual, true);
});

test('a write inside an open transaction goes back only to a savepoint, which leaves that transaction as it was', async () => {
  const { ctx, sent, shown } = fakeCtx({ tranCount: 1, plan: ['Update on players  (cost=0.00..1.15 rows=0 width=10) (actual time=0.05..0.05 rows=0 loops=1)'] });
  await showActualPlan(ctx, 'UPDATE players SET goals = 0 WHERE id = 1');
  const plan = sent.filter((s) => !/COUNT/.test(s));
  assert.deepEqual(plan, ['SAVEPOINT trawl_plan;', 'EXPLAIN (ANALYZE, BUFFERS) UPDATE players SET goals = 0 WHERE id = 1', 'ROLLBACK TO SAVEPOINT trawl_plan;']);
  assert.equal(shown.length, 1);
});

test('MySQL: EXPLAIN ANALYZE, rolled back even when it fails, and an error says which versions have it', async () => {
  const { ctx, sent, shown, notes } = fakeCtx({ kind: 'mysql', error: "You have an error in your SQL syntax; check the manual near 'ANALYZE SELECT'" });
  await showActualPlan(ctx, 'SELECT * FROM players');
  assert.deepEqual(sent, ['START TRANSACTION;', 'EXPLAIN ANALYZE SELECT * FROM players', 'ROLLBACK;']);
  assert.equal(shown.length, 0);
  assert.ok(notes.some((n) => /MySQL 8\.0\.18 or later/.test(n.text)));
});

test('a read-only connection refuses the actual plan of a write: it would run', async () => {
  const { ctx, sent, notes } = fakeCtx();
  ctx.session.conn.readOnly = true;
  await showActualPlan(ctx, 'DELETE FROM players WHERE id = 1');
  assert.deepEqual(sent, []);
  assert.match(notes[0].text, /read-only/);
});
