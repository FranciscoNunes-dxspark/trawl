import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIRST_TAB, droppedPaths, findTab, freeFile, freeName, tabNameFor, tabNameProblem, tabsOf } from '../src/consoles.js';

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

test('dropped files: absolute .sql or .txt paths, quoted, escaped or as file:// URLs; anything else is typing', () => {
  const win = { windows: true };
  const posix = { windows: false };
  assert.deepEqual(droppedPaths('C:\\scripts\\report.sql', win), ['C:\\scripts\\report.sql']);
  assert.deepEqual(droppedPaths('"C:\\My Scripts\\a.SQL" C:\\b.txt ', win), ['C:\\My Scripts\\a.SQL', 'C:\\b.txt']);
  assert.deepEqual(droppedPaths('\\\\server\\share\\a.sql', win), ['\\\\server\\share\\a.sql']);
  assert.deepEqual(droppedPaths('/home/ana/My\\ Scripts/a.sql', posix), ['/home/ana/My Scripts/a.sql']);
  assert.deepEqual(droppedPaths("'/home/ana/a b.sql' ", posix), ['/home/ana/a b.sql']);
  assert.deepEqual(droppedPaths('file:///home/ana/a%20b.sql', posix), ['/home/ana/a b.sql']);
  assert.equal(droppedPaths('report.sql', win), null, 'not absolute');
  assert.equal(droppedPaths('C:\\data\\players.csv', win), null, 'not SQL or text');
  assert.equal(droppedPaths('/a.sql /b.csv', posix), null, 'all of them or none');
  assert.equal(droppedPaths('SELECT 1', posix), null);
  assert.equal(droppedPaths('/a.sql\n/b.sql', posix), null, 'a pasted script');
});

test('a dropped file’s tab is named after it, as one word', () => {
  assert.equal(tabNameFor('C:\\x\\Top scorers (2024).sql'), 'Top-scorers-2024');
  assert.equal(tabNameFor('/x/relatório.txt'), 'relatório');
  assert.equal(tabNameFor('/x/2024.sql'), 'file-2024');
  assert.equal(tabNameFor('/x/!!.sql'), 'file');
  assert.ok(tabNameFor(`/x/${'a'.repeat(50)}.sql`).length <= 24);
});
