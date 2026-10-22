import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellText, fold, hexDump, indentXml, prettyJson } from '../src/cell.js';

test('JSON is laid out two spaces a level, its numbers and key order as they came', () => {
  assert.equal(prettyJson('{"a":1,"b":[1,{}],"big":12345678901234567890,"s":"x,\\"y:{"}'), '{\n  "a": 1,\n  "b": [\n    1,\n    {}\n  ],\n  "big": 12345678901234567890,\n  "s": "x,\\"y:{"\n}');
  assert.equal(prettyJson('[]'), '[]');
  assert.equal(prettyJson('{not json}'), null);
  assert.equal(prettyJson('42'), null, 'only an object or an array');
  assert.deepEqual(cellText('{"a":[1,2]}'), { text: '{\n  "a": [\n    1,\n    2\n  ]\n}', kind: 'json' });
  // Postgres hands json over parsed.
  assert.equal(cellText({ a: 1 }).kind, 'json');
});

test('XML is a tag a line, an element of only text on one', () => {
  assert.equal(indentXml('<?xml version="1.0"?><root a="1"><item>One</item><item><sub/></item><!-- c --></root>'), '<?xml version="1.0"?>\n<root a="1">\n  <item>One</item>\n  <item>\n    <sub/>\n  </item>\n  <!-- c -->\n</root>');
  assert.equal(indentXml('<a><b></a>'), null, 'tags that don’t close in turn');
  assert.equal(indentXml('<not xml'), null);
  assert.equal(indentXml('1 < 2 > 0'), null);
  assert.equal(cellText('<a><b>x</b></a>').kind, 'xml');
});

test('binary is a hex dump, anything else folded to the width', () => {
  assert.equal(hexDump(Buffer.from('Hi!\x00')), '00000000  48 69 21 00                                      Hi!.');
  assert.equal(hexDump(Buffer.alloc(9), 60).split('\n').length, 2, 'eight bytes a line when narrow');
  assert.equal(cellText(Buffer.alloc(0)).text, '(no bytes)');
  assert.deepEqual(cellText(null), { text: 'NULL', kind: 'null' });
  assert.equal(cellText(new Date('2026-10-21T09:30:00Z')).text, '2026-10-21 09:30:00');
  assert.deepEqual(fold('one two three four five six', 10), ['one two', 'three four', 'five six']);
  // A line with no spaces breaks anywhere; one indented keeps its indent.
  assert.deepEqual(fold('x'.repeat(25), 10), ['xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxx']);
  assert.deepEqual(fold(`    "${'y'.repeat(20)}"`, 16), ['    "yyyyyyyyyyy', '    yyyyyyyyy"']);
  assert.equal(cellText('line one\r\nline\ttwo', 40).text, 'line one\nline    two');
  for (const line of cellText('word '.repeat(100), 30).text.split('\n')) assert.ok(line.length <= 30);
});
