import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSnippet, snippetNameProblem, snippetsFor, withSnippet, withoutSnippet } from '../src/snippets.js';

test("a connection's snippets come first, then those for every connection, and its own wins a name", () => {
  let list = [];
  list = withSnippet(list, { name: 'top', conn: null, sql: 'SELECT 1' });
  list = withSnippet(list, { name: 'Top', conn: 'club', sql: 'SELECT 2' });
  list = withSnippet(list, { name: 'b', conn: 'other', sql: 'SELECT 3' });
  list = withSnippet(list, { name: 'TOP', conn: 'club', sql: 'SELECT 4' });
  assert.equal(list.length, 3, 'saving again replaces');
  assert.deepEqual(snippetsFor(list, 'CLUB').map((s) => s.sql), ['SELECT 4', 'SELECT 1']);
  assert.equal(findSnippet(list, 'club', 'top').sql, 'SELECT 4');
  assert.equal(findSnippet(list, 'other', 'top').sql, 'SELECT 1');
  assert.equal(findSnippet(list, null, 'b'), null);
  assert.equal(withoutSnippet(list, { name: 'top', conn: 'club' }).length, 2);
});

test("names: not empty, not /snippet's own words, no quotes", () => {
  assert.equal(snippetNameProblem('top scorers'), null);
  assert.match(snippetNameProblem('save'), /own words/);
  assert.match(snippetNameProblem('a"b'), /quotes/);
  assert.match(snippetNameProblem(''), /Name it/);
});
