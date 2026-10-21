import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandsSection, searchHelp, sectionFor, sectionLines } from '../src/help-layout.js';
import { HELP } from '../src/help.js';
import { COMMANDS } from '../src/commands.js';

const plain = (lines) => lines.map((segs) => segs.map((s) => s.text).join('').trimEnd());

const SECTION = {
  title: 'Results',
  about: 'the rows that came back',
  views: ['results'],
  rows: [
    ['j k', 'Rows'],
    ['y  Y', 'Copy the cell · the row (tab-separated), or the whole set with /copy'],
    ['/import-csv <file.csv> <table>', 'Too wide for the column'],
    { heading: 'Editing', about: 'one table with its key' },
    ['e', 'Edit the cell\nesc leaves it'],
    'A note across the pane.',
  ],
};

test('a section: keys in a column as wide as the widest that fits, what they do wrapped beside them', () => {
  assert.deepEqual(plain(sectionLines(SECTION, 40)), [
    ' the rows that came back',
    '',
    ' j k   Rows',
    ' y  Y  Copy the cell · the row',
    '       (tab-separated), or the whole',
    '       set with /copy',
    ' /import-csv <file.csv> <table>',
    '       Too wide for the column',
    '',
    ' Editing',
    ' one table with its key',
    ' e     Edit the cell',
    '       esc leaves it',
    '',
    ' A note across the pane.',
  ]);
  const kinds = sectionLines(SECTION, 40)[2].map((s) => s.kind);
  assert.deepEqual(kinds, [undefined, 'keys', undefined, 'text']);
});

test('search keeps the rows that mention it, ignoring case, and marks where; a matching title keeps its section', () => {
  const found = searchHelp([SECTION, { title: 'Copying', rows: [['c', 'Anything']] }], 'COPY');
  assert.deepEqual(found.map((s) => s.title), ['Results', 'Copying']);
  assert.deepEqual(found[0].rows, [SECTION.rows[1]]);
  assert.equal(found[1].rows.length, 1);
  const marked = sectionLines(found[0], 60, { query: 'copy' }).flat().filter((s) => s.match);
  assert.deepEqual(marked.map((s) => s.text), ['Copy', 'copy']);
  assert.deepEqual(searchHelp([SECTION], 'nowhere'), []);
  assert.deepEqual(searchHelp([SECTION], '  '), [SECTION], 'an empty search is everything');
});

test('the slash commands become a section, their arguments dim in front of what they do', () => {
  const s = commandsSection([{ name: 'connect', args: '<name>', desc: 'Connect to a saved connection' }, { name: 'quit', desc: 'Quit' }]);
  const lines = sectionLines(s, 60);
  assert.deepEqual(plain(lines).slice(2), [' /connect  <name>  Connect to a saved connection', ' /quit     Quit']);
  assert.deepEqual(lines[2].filter((x) => x.kind).map((x) => [x.kind, x.text]), [['keys', '/connect'], ['args', '<name>'], ['text', '  Connect to a saved connection']]);
});

test("the window opens on the view's section, else the first", () => {
  assert.equal(sectionFor([{ title: 'A', rows: [] }, SECTION], 'results'), 1);
  assert.equal(sectionFor([SECTION], 'nowhere'), 0);
});

test("help.js: every section has rows, every row is a known shape, and every view has a section", () => {
  for (const s of HELP) {
    assert.ok(s.title && s.rows.length, s.title);
    for (const r of s.rows) assert.ok(typeof r === 'string' || (Array.isArray(r) && r.length === 2 && r.every((x) => typeof x === 'string')) || r.heading, `${s.title}: ${JSON.stringify(r)}`);
  }
  for (const view of ['explorer', 'console', 'file', 'results', 'history', 'connections', 'activity']) assert.ok(HELP.some((s) => s.views?.includes(view)), view);
  assert.ok(commandsSection(COMMANDS).rows.every(([keys, desc]) => keys.startsWith('/') && desc), 'every command says what it does');
});
