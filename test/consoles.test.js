import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIRST_TAB, findTab, freeFile, freeName, tabNameProblem, tabsOf } from '../src/consoles.js';

test('with no tabs saved, the console is the one tab, in console.sql', () => {
  assert.deepEqual(tabsOf({}), [FIRST_TAB]);
  assert.deepEqual(tabsOf({ consoleTabs: [{ name: 'x', file: '../../etc/passwd' }] }), [FIRST_TAB], 'only files Trawl made');
  const tabs = [FIRST_TAB, { name: 'report', file: 'consoles/report.sql' }];
  assert.deepEqual(tabsOf({ consoleTabs: tabs }), tabs);
});

test('new tabs get a free name and a file of their own, which stays through renames', () => {
  const tabs = [FIRST_TAB, { name: 'query', file: 'consoles/query.sql' }];
  assert.equal(freeName(tabs), 'query-2');
  assert.equal(freeName(tabs, 'report'), 'report');
  assert.equal(freeFile(tabs, 'query'), 'consoles/query-2.sql');
  assert.equal(freeFile(tabs, 'Top scorers!'), 'consoles/top-scorers.sql');
});

test('tab names: one word, not a number, not taken; a tab is found by number or name', () => {
  const tabs = [FIRST_TAB, { name: 'Query', file: 'consoles/query.sql' }];
  assert.match(tabNameProblem('query', tabs), /already/);
  assert.equal(tabNameProblem('query', tabs, { except: 1 }), null);
  assert.match(tabNameProblem('two words', tabs), /one word/);
  assert.match(tabNameProblem('3', tabs), /number/);
  assert.equal(findTab(tabs, '2'), 1);
  assert.equal(findTab(tabs, 'QUERY'), 1);
  assert.equal(findTab(tabs, '3'), -1);
});
