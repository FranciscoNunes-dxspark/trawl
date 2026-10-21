import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareSets, comparisonSet, comparisonSummary } from '../src/compare.js';

const set = (names, rows) => ({ columns: names.map((name) => ({ name, type: 'IntN' })), rows });

test('keyed by the primary key: changed rows say which columns, and from what', () => {
  const before = set(['Id', 'Name', 'Goals'], [[1, 'Rui', 3], [2, 'Ana', 0], [3, 'Inês', 5]]);
  const after = set(['Goals', 'Id', 'Name'], [[4, 1, 'Rui'], [0, 2, 'Ana'], [1, 4, 'Nuno']]);
  const diff = compareSets(before, after, { keys: ['id'] });
  assert.equal(diff.keyed, true);
  assert.deepEqual(diff.changed.map((d) => [d.after, d.cols]), [[[1, 'Rui', 4], [2]]]);
  assert.deepEqual(diff.added, [[4, 'Nuno', 1]]);
  assert.deepEqual(diff.removed, [[3, 'Inês', 5]]);
  assert.equal(diff.same, 1);
  const out = comparisonSet(diff);
  assert.deepEqual(out.columns.map((c) => c.name), ['change', 'Id', 'Name', 'Goals', 'was']);
  assert.deepEqual(out.rows[0], ['~', 1, 'Rui', 4, 'Goals: 3 → 4']);
  assert.deepEqual(out.rows.map((r) => r[0]), ['~', '+', '−']);
  assert.equal(comparisonSummary(diff, ['Id']), '1 changed · 1 added · 1 removed · 1 the same (rows matched by Id)');
});

test('without a key, whole rows are compared and duplicates counted', () => {
  const before = set(['a'], [[1], [1], [2], [null]]);
  const after = set(['a'], [[1], [3], [null]]);
  const diff = compareSets(before, after);
  assert.equal(diff.keyed, false);
  assert.deepEqual(diff.added, [[3]]);
  assert.deepEqual(diff.removed.sort(), [[1], [2]]);
  assert.equal(diff.same, 2);
});

test('a key that repeats falls back to whole rows; different columns are refused', () => {
  assert.equal(compareSets(set(['k', 'v'], [[1, 1], [1, 2]]), set(['k', 'v'], [[1, 1]]), { keys: ['k'] }).keyed, false);
  assert.throws(() => compareSets(set(['a'], []), set(['b'], [])), /columns differ/);
});
