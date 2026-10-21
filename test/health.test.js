import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECKS, bracketList, buildHealth, buildSizes, checksFor, duplicateIndexes, fixableGroups, foreignKeysOf, healthReads, healthScript, healthSummary, healthText, indexName, indexesOf, staleness, unindexedForeignKeys } from '../src/health.js';
import { DIALECTS } from '../src/dialects.js';
import { classifyScript } from '../src/sql.js';

const set = (names, rows) => ({ columns: names.map((name) => ({ name, type: '' })), rows, truncated: false });
const INDEX_COLUMNS = ['schema', 'table', 'index', 'is_primary_key', 'is_unique', 'is_constraint', 'is_clustered', 'filtered', 'key_ordinal', 'column', 'is_included', 'is_descending'];
// [index, columns ('a', 'b DESC', '+c' included), flags]
const ix = (table, index, columns, { pk = false, unique = false, clustered = false, filtered = false } = {}) => {
  let k = 0;
  return columns.map((c) => {
    const included = c.startsWith('+');
    const [name, desc] = c.replace(/^\+/, '').split(' ');
    return ['dbo', table, index, pk, unique || pk, pk, clustered, filtered, included ? 0 : ++k, name, included, desc === 'DESC'];
  });
};
const indexSet = (...lists) => set(INDEX_COLUMNS, lists.flat());

test('indexesOf groups the rows into indexes, keys in order and included columns apart', () => {
  const [a] = indexesOf(indexSet(ix('T', 'IX', ['b DESC', 'a', '+c'])).rows.map((r) => Object.fromEntries(INDEX_COLUMNS.map((n, i) => [n, r[i]]))));
  assert.deepEqual(a.keys, [{ column: 'b', desc: true }, { column: 'a', desc: false }]);
  assert.deepEqual(a.included, ['c']);
});

const shaped = (s) => indexesOf(s.rows.map((r) => Object.fromEntries(INDEX_COLUMNS.map((n, i) => [n, r[i]]))));

test('duplicateIndexes: the same keys, keys that lead another, never a key that enforces something', () => {
  const found = duplicateIndexes(
    shaped(
      indexSet(
        ix('T', 'PK_T', ['id'], { pk: true, clustered: true }),
        ix('T', 'IX_id', ['id']),
        ix('T', 'IX_a', ['a']),
        ix('T', 'IX_a_b', ['a', 'b', '+c']),
        ix('T', 'IX_a2', ['a']),
        ix('T', 'UX_b', ['b'], { unique: true }),
        ix('T', 'IX_b', ['b']),
        ix('T', 'IX_d_desc', ['d DESC']),
        ix('T', 'IX_d', ['d']),
        ix('T', 'IX_e_filtered', ['e'], { filtered: true }),
        ix('T', 'IX_e', ['e']),
        ix('U', 'IX_a', ['a']),
      ),
    ),
  );
  const pairs = found.map((f) => `${f.index.name}→${f.other.name}${f.same ? ' same' : ''}`);
  assert.deepEqual(pairs.sort(), ['IX_a2→IX_a_b', 'IX_a→IX_a_b', 'IX_b→UX_b same', 'IX_id→PK_T same'].sort());
  // Another table's index of the same name and keys isn't a duplicate; nor a descending key of an ascending one.
  assert.ok(!pairs.some((p) => p.startsWith('IX_d') || p.startsWith('IX_e')));
});

test("duplicateIndexes says when the one to drop includes columns the other hasn't", () => {
  const [f] = duplicateIndexes(shaped(indexSet(ix('T', 'IX_a', ['a', '+x']), ix('T', 'IX_a_b', ['a', 'b']))));
  assert.deepEqual(f.uncovered, ['x']);
  const [g] = duplicateIndexes(shaped(indexSet(ix('T', 'IX_a', ['a', '+x']), ix('T', 'CIX', ['a', 'b'], { clustered: true }))));
  assert.deepEqual(g.uncovered, [], 'a clustered index has every column');
});

test('unindexedForeignKeys: an index whose first keys are the columns, in any order, supports the key', () => {
  const keys = foreignKeysOf([
    { schema: 'dbo', table: 'T', name: 'FK_ab', ordinal: 2, column: 'b', ref_schema: 'dbo', ref_table: 'R' },
    { schema: 'dbo', table: 'T', name: 'FK_ab', ordinal: 1, column: 'a', ref_schema: 'dbo', ref_table: 'R' },
    { schema: 'dbo', table: 'T', name: 'FK_c', ordinal: 1, column: 'c', ref_schema: 'dbo', ref_table: 'R' },
    { schema: 'dbo', table: 'T', name: 'FK_d', ordinal: 1, column: 'd', ref_schema: 'dbo', ref_table: 'R' },
  ]);
  assert.deepEqual(keys[0].columns, ['a', 'b']);
  const indexes = shaped(indexSet(ix('T', 'IX_ba', ['b', 'a', 'z']), ix('T', 'IX_xc', ['x', 'c']), ix('T', 'IX_d_f', ['d'], { filtered: true })));
  assert.deepEqual(unindexedForeignKeys(keys, indexes).map((k) => k.name), ['FK_c', 'FK_d']);
});

test('staleness: changed by a fifth (and 500 rows) since an update over 7 days ago, or never', () => {
  assert.equal(staleness({ rows: 10_000, modifications: 2500, days_since: 8 }).stale, true);
  assert.equal(staleness({ rows: 10_000, modifications: 2500, days_since: 3 }).stale, false);
  assert.equal(staleness({ rows: 10_000, modifications: 1500, days_since: 30 }).stale, false);
  assert.equal(staleness({ rows: 100, modifications: 400, days_since: 30 }).stale, false, 'fewer than 500 changes');
  assert.equal(staleness({ rows: '5000', modifications: '5000', days_since: null }).stale, true, 'never analyzed');
  assert.equal(staleness({ rows: 20_000, modifications: 0, dead_rows: 20_000, days_since: 0 }).dead, true);
});

test('bracketList and indexName', () => {
  assert.deepEqual(bracketList('[a], [b c], [d]]e]'), ['a', 'b c', 'd]e']);
  assert.deepEqual(bracketList(null), []);
  assert.equal(indexName('Matches', ['HomeId', 'Away Id']), 'IX_Matches_HomeId_Away_Id');
  assert.equal(indexName('Mixed Case', ['Ref'], 'postgres'), 'ix_Mixed_Case_Ref');
  assert.equal(indexName('t'.repeat(80), ['c'], 'postgres').length, 63);
});

test('each kind reads what its checks need, and says which it has', () => {
  assert.deepEqual(Object.keys(healthReads('sqlserver')), ['restart', 'missing', 'unused', 'indexes', 'foreignKeys', 'nopk', 'untrusted', 'stats', 'triggers']);
  assert.ok(!('missing' in healthReads('postgres')));
  assert.deepEqual(checksFor('mysql'), ['unused', 'duplicate', 'fk', 'nopk']);
  assert.deepEqual(checksFor('postgres'), CHECKS.map((c) => c.id).filter((id) => id !== 'missing'));
  for (const [kind, d] of Object.entries(DIALECTS)) {
    for (const sql of [...Object.values(d.health), d.sizesSql]) {
      assert.match(sql, /^-- trawl:(health \w+|sizes)\n/, kind);
      assert.equal(classifyScript(sql, { dialect: kind }).write, false, `${kind}: ${sql.split('\n')[0]} only reads`);
    }
  }
});

// What the reads of a small SQL Server database might give.
const RESULTS = {
  restart: { sets: [set(['started', 'stats_reset'], [[new Date('2026-10-18T06:00:00Z'), null]])] },
  missing: { sets: [set(['schema', 'table', 'equality_columns', 'inequality_columns', 'included_columns', 'seeks', 'scans', 'avg_impact', 'impact'], [['dbo', 'Matches', '[HomeId]', '[PlayedOn]', '[AwayId]', '1200', '4', 91.6, 5000]])] },
  unused: { error: "The user does not have permission to perform this action." },
  indexes: { sets: [indexSet(ix('Players', 'PK_Players', ['Id'], { pk: true, clustered: true }), ix('Players', 'IX_Club', ['ClubId']), ix('Players', 'IX_Club_Pos', ['ClubId', 'Position']))] },
  foreignKeys: { sets: [set(['schema', 'table', 'name', 'ordinal', 'column', 'ref_schema', 'ref_table'], [['dbo', 'Matches', 'FK_Home', 1, 'HomeId', 'dbo', 'Clubs'], ['dbo', 'Players', 'FK_Club', 1, 'ClubId', 'dbo', 'Clubs']])] },
  nopk: { sets: [set(['schema', 'table', 'has_pk', 'is_heap', 'rows'], [['dbo', 'Log', false, true, '1200']])] },
  untrusted: { sets: [set(['schema', 'table', 'name', 'kind', 'is_disabled', 'is_not_trusted'], [['dbo', 'Matches', 'FK_Home', 'FOREIGN KEY', false, true]])] },
  stats: { sets: [set(['schema', 'table', 'name', 'last_updated', 'days_since', 'rows', 'modifications', 'dead_rows'], [['dbo', 'Players', 'ST_Goals', new Date('2026-09-01T00:00:00Z'), 50, 1000, 900, null], ['dbo', 'Clubs', 'PK_Clubs', new Date(), 0, 1000, 900, null]])] },
  triggers: { sets: [set(['schema', 'table', 'name'], [['dbo', 'Players', 'trg_Goals']])] },
};

test('buildHealth: findings by check, a failed read only in its own group', () => {
  const report = buildHealth(RESULTS);
  const by = Object.fromEntries(report.groups.map((g) => [g.id, g]));
  assert.equal(by.missing.findings[0].fix[0], 'CREATE NONCLUSTERED INDEX [IX_Matches_HomeId_PlayedOn] ON [dbo].[Matches] ([HomeId], [PlayedOn]) INCLUDE ([AwayId]);');
  assert.match(by.missing.findings[0].detail, /92% less cost · 1,204 uses/);
  assert.match(by.unused.error, /permission/);
  assert.equal(by.duplicate.findings[0].fix[0], 'DROP INDEX [IX_Club] ON [dbo].[Players];');
  assert.equal(by.duplicate.findings[0].commented, true);
  assert.deepEqual(by.fk.findings.map((f) => f.object), ['dbo.Matches'], "Players' key has IX_Club");
  assert.match(by.nopk.findings[0].detail, /no primary key · a heap · 1,200 rows/);
  assert.equal(by.untrusted.findings[0].fix[0], 'ALTER TABLE [dbo].[Matches] WITH CHECK CHECK CONSTRAINT [FK_Home];');
  assert.deepEqual(by.stats.findings.map((f) => f.object), ['dbo.Players'], 'Clubs was updated today');
  assert.equal(by.triggers.findings[0].fix[0], 'ENABLE TRIGGER [dbo].[trg_Goals] ON [dbo].[Players];');
  assert.match(healthSummary(report), /^7 findings in 7 checks: .* 1 check couldn't run\.$/);
});

test('healthText says what each check found and why, what failed, and when the counts began', () => {
  const text = healthText(buildHealth(RESULTS), { database: 'ClubA', conn: 'club-a' });
  assert.match(text, /^ClubA on club-a \(SQL Server\): 7 findings, from 8 checks\./);
  assert.match(text, /The server started 2026-10-18 06:00/);
  assert.match(text, /Unused indexes: couldn't check\n  The user does not have permission/);
  assert.match(text, /Foreign keys without an index \(1\)\n  Foreign keys whose columns/);
  assert.match(text, /  dbo\.Matches  FK_Home \(HomeId\) → dbo\.Clubs/);
  assert.doesNotMatch(text, /Not checked on/);
});

test('healthScript: a group or all of them, what changes behaviour commented out, each statement once', () => {
  const report = buildHealth(RESULTS);
  const all = healthScript(report, { database: 'ClubA' });
  assert.match(all, /^-- Fixes from Trawl's health check of ClubA\./);
  assert.match(all, /\n-- Duplicate and overlapping indexes\n-- dbo\.Players: IX_Club \(ClubId\) leads IX_Club_Pos \(ClubId, Position\)\n-- DROP INDEX \[IX_Club\] ON \[dbo\]\.\[Players\];\n/);
  assert.match(all, /\n-- ENABLE TRIGGER \[dbo\]\.\[trg_Goals\]/);
  assert.match(all, /\n-- ALTER TABLE \[dbo\]\.\[Log\] ADD CONSTRAINT \[PK_Log\] PRIMARY KEY \(…\);/);
  assert.match(all, /\nUPDATE STATISTICS \[dbo\]\.\[Players\];\n/);
  const fk = healthScript(report, { groups: ['fk'] });
  assert.match(fk, /CREATE NONCLUSTERED INDEX \[IX_Matches_HomeId\]/);
  assert.doesNotMatch(fk, /DROP INDEX|PlayedOn/);
  // The same index suggested twice (missing, and for a foreign key) is written once.
  const twice = buildHealth({ ...RESULTS, missing: { sets: [set(['schema', 'table', 'equality_columns', 'inequality_columns', 'included_columns', 'seeks', 'scans', 'avg_impact', 'impact'], [['dbo', 'Matches', '[HomeId]', null, null, 5, 0, 50, 10]])] } });
  const script = healthScript(twice);
  assert.equal(script.match(/CREATE NONCLUSTERED INDEX \[IX_Matches_HomeId\]/g).length, 1);
  assert.match(script, /FK_Home \(HomeId\) → dbo\.Clubs \(its statement is above\)/);
  assert.deepEqual(fixableGroups(report).map((g) => g.id), ['missing', 'duplicate', 'fk', 'nopk', 'untrusted', 'stats', 'triggers']);
});

test('on Postgres: its own statements, dead rows, and the checks it has no equivalent for', () => {
  const pg = DIALECTS.postgres;
  const report = buildHealth(
    {
      ...RESULTS,
      missing: undefined,
      stats: { sets: [set(['schema', 'table', 'name', 'last_updated', 'days_since', 'rows', 'modifications', 'dead_rows'], [['shop', 'players', null, null, null, '20000', '0', '20000']])] },
    },
    { kind: 'postgres', quote: pg.quote },
  );
  const by = Object.fromEntries(report.groups.map((g) => [g.id, g]));
  assert.match(by.missing.unavailable, /doesn't suggest missing indexes/);
  assert.equal(by.stats.title, 'Dead rows and stale statistics');
  assert.equal(by.stats.findings[0].fix[0], 'VACUUM (ANALYZE) "shop"."players";');
  assert.equal(by.untrusted.findings[0].fix[0], 'ALTER TABLE "dbo"."Matches" VALIDATE CONSTRAINT "FK_Home";');
  assert.equal(by.duplicate.findings[0].fix[0], 'DROP INDEX "dbo"."IX_Club";');
  assert.match(by.nopk.findings[0].detail, /^no primary key · 1,200 rows$/, 'no heaps on Postgres');
  const text = healthText(report);
  assert.match(text, /Not checked on PostgreSQL:\n  · Missing indexes the server suggests: /);
  assert.match(healthScript(report), /VACUUM can't run inside a transaction/);
});

test('on MySQL without the sys schema, unused indexes say why rather than failing', () => {
  const report = buildHealth({ ...RESULTS, unused: { error: "Table 'sys.schema_unused_indexes' doesn't exist" } }, { kind: 'mysql', quote: DIALECTS.mysql.quote });
  const unused = report.groups.find((g) => g.id === 'unused');
  assert.equal(unused.error, null);
  assert.match(unused.unavailable, /no sys schema/);
  assert.deepEqual(report.groups.filter((g) => !g.unavailable).map((g) => g.id), ['duplicate', 'fk', 'nopk']);
});

test('buildSizes: numbers, KB as MB, biggest first, whatever the driver gave', () => {
  const s = buildSizes([set(['schema', 'table', 'rows', 'reserved_kb', 'data_kb', 'index_kb', 'unused_kb'], [['dbo', 'Small', '3', '72', '16', '32', '24'], ['dbo', 'Big', '120000', '10240', '8192', '2048', '0']])]);
  assert.deepEqual(s.columns.map((c) => c.name), ['schema', 'table', 'rows', 'reserved_mb', 'data_mb', 'index_mb', 'unused_mb']);
  assert.deepEqual(s.rows[0], ['dbo', 'Big', 120000, 10, 8, 2, 0]);
  assert.deepEqual(s.rows[1], ['dbo', 'Small', 3, 0.07, 0.02, 0.03, 0.02]);
  assert.equal(s.columns[3].type, 'Decimal');
  for (const d of Object.values(DIALECTS)) assert.match(d.sizesSql, /^-- trawl:sizes\n/);
});
