import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzedText, estimateFlag, flagAnalyzed, isProfileSet, profileText, rowCount, splitProfile } from '../src/plans.js';

const COLUMNS = ['Rows', 'Executes', 'StmtText', 'StmtId', 'NodeId', 'Parent', 'PhysicalOp', 'LogicalOp', 'Argument', 'DefinedValues', 'EstimateRows', 'EstimateIO', 'EstimateCPU', 'AvgRowSize', 'TotalSubtreeCost', 'OutputList', 'Warnings', 'Type', 'Parallel', 'EstimateExecutions'];
const row = (rows, executes, text, id, parent, est, runs = null, type = 'PLAN_ROW') => [rows, executes, text, 1, id, parent, null, null, null, null, est, 0, 0, 0, 0, null, null, type, false, runs];
const profile = (rows) => ({ columns: COLUMNS.map((name) => ({ name, type: '' })), rows, truncated: false });

// A nested loop, as SQL Server writes it: the seek runs once per outer row.
const LOOP = profile([
  row(40, 1, 'SELECT p.Name FROM dbo.Players p JOIN dbo.Clubs c ON c.Id = p.ClubId WHERE c.Country = N\'PT\'', 1, 0, 2, null, 'SELECT'),
  row(40, 1, '  |--Nested Loops(Inner Join, OUTER REFERENCES:([c].[Id]))', 2, 1, 2),
  row(4, 1, '       |--Clustered Index Scan(OBJECT:([ClubA].[dbo].[Clubs].[PK_Clubs] AS [c]), WHERE:([c].[Country]=N\'PT\'))', 3, 2, 1.2),
  row(40, 4, '       |--Index Seek(OBJECT:([ClubA].[dbo].[Players].[IX_Players_ClubId] AS [p]), SEEK:([p].[ClubId]=[c].[Id]))', 4, 2, 0.5, 1.2),
]);

test('a STATISTICS PROFILE set is known by its columns', () => {
  assert.equal(isProfileSet(LOOP), true);
  assert.equal(isProfileSet({ columns: [{ name: 'Rows' }, { name: 'Name' }], rows: [] }), false);
});

test('the marks: 10× or more either way, counts under 1 counting as 1', () => {
  assert.equal(estimateFlag(40, 2), '▲ 20×');
  assert.equal(estimateFlag(1, 50), '▼ 50×');
  assert.equal(estimateFlag(9, 1), '');
  assert.equal(estimateFlag(0, 0.3), '');
  assert.equal(estimateFlag(null, 3), '');
  assert.equal(rowCount(1.23), '1.2');
  assert.equal(rowCount(12500), '12,500');
  assert.equal(rowCount(null), '?');
});

test('the profile as a tree, actual against estimated rows, the estimate counted over its executions', () => {
  const text = profileText([LOOP]);
  const lines = text.split('\n');
  assert.match(lines[0], /^actual 40 \/ est 2 +▲ 20× +SELECT p\.Name FROM dbo\.Players p JOIN/);
  assert.match(lines[1], /^actual 40 \/ est 2 +▲ 20× +\|--Nested Loops\(Inner Join/);
  assert.match(lines[2], /^actual 4 \/ est 1\.2 + {5}\s+\|--Clustered Index Scan/);
  // 0.5 a seek, estimated to run 1.2 times: 0.6 in all, against 40 over 4 runs.
  assert.match(lines[3], /^actual 40 \/ est 0\.6 · 4 runs +▲ 40× +\|--Index Seek/);
  // The children sit deeper than their parent, and the columns line up.
  assert.ok(lines[2].indexOf('|--') > lines[1].indexOf('|--'));
  assert.equal(lines[0].indexOf('SELECT'), lines[1].indexOf('|--') - 2);
  assert.match(text, /▲ more rows than estimated, ▼ fewer, by 10× or more/);
});

test('splitProfile takes the plan out and leaves the rows for Results', () => {
  const rows = { columns: [{ name: 'Name', type: 'nvarchar' }], rows: [['Rui Costa']], truncated: false };
  const { res, plan } = splitProfile({ sets: [rows, LOOP], messages: ['x'], ms: 3 });
  assert.deepEqual(res.sets, [rows]);
  assert.deepEqual(res.messages, ['x']);
  assert.match(plan, /Nested Loops/);
  assert.doesNotMatch(plan, /Rui Costa/);
  assert.equal(splitProfile({ sets: [rows], messages: [] }).plan, '');
});

test('EXPLAIN ANALYZE text gets the same marks: Postgres’s lines and MySQL’s tree', () => {
  const pg = analyzedText([
    {
      columns: [{ name: 'QUERY PLAN' }],
      rows: [['Seq Scan on players  (cost=0.00..1.15 rows=1 width=40) (actual time=0.010..0.012 rows=300 loops=1)'], ['  Filter: (goals > 3)'], ['Planning Time: 0.05 ms']],
    },
  ]);
  assert.match(pg, /rows=300 loops=1\)   ▲ 300×\n  Filter: \(goals > 3\)\nPlanning Time/);
  assert.match(pg, /by 10× or more/);
  const my = analyzedText([{ columns: [{ name: 'EXPLAIN' }], rows: [['-> Filter: (players.goals > 3)  (cost=1.45 rows=4) (actual time=0.03..0.04 rows=3 loops=1)\n    -> Table scan on players  (cost=1.45 rows=12) (actual time=0.02..0.03 rows=12 loops=1)']] }]);
  assert.equal(my, '-> Filter: (players.goals > 3)  (cost=1.45 rows=4) (actual time=0.03..0.04 rows=3 loops=1)\n    -> Table scan on players  (cost=1.45 rows=12) (actual time=0.02..0.03 rows=12 loops=1)');
  assert.equal(flagAnalyzed('-> Index lookup on p  (cost=0.3 rows=50) (never executed)'), '-> Index lookup on p  (cost=0.3 rows=50) (never executed)');
});
