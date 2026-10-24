// xlsx.js: the ZIP writer and the workbook's parts, read back with a small ZIP reader of the test's
// own; then x in Results and /export file.xlsx against the demo (helpers copied from app.test.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import React from 'react';
import { render } from 'ink-testing-library';
import { DEMO_CONNECTIONS } from '../src/connections.js';
import { cellOf, columnLetters, crc32, sheetNames, toXlsx, zip } from '../src/xlsx.js';
import { App } from '../src/ui/App.jsx';

/** The files in a ZIP, by name, read from its central directory, each checked against its CRC-32. */
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'an end of central directory');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const packed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extra = buf.readUInt16LE(at + 30);
    const comment = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    assert.equal(buf.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + packed);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    assert.equal(data.length, size, `${name}'s size`);
    assert.equal(crc32(data), crc, `${name}'s CRC`);
    out.set(name, data.toString('utf8'));
    at += 46 + nameLen + extra + comment;
  }
  return out;
}

test('CRC-32 and the ZIP: what goes in comes back out, names in UTF-8', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
  const files = unzip(zip([{ name: 'a.txt', data: 'hello '.repeat(100) }, { name: 'dir/ç.xml', data: Buffer.from('<x/>') }, { name: 'empty', data: '' }]));
  assert.deepEqual([...files.keys()], ['a.txt', 'dir/ç.xml', 'empty']);
  assert.equal(files.get('a.txt'), 'hello '.repeat(100));
  assert.equal(files.get('dir/ç.xml'), '<x/>');
  assert.equal(files.get('empty'), '');
});

test('cells: numbers as numbers, dates as serial numbers with a date style, NULL as nothing, the rest as text', () => {
  assert.deepEqual(cellOf(3), { t: 'n', v: '3' });
  assert.deepEqual(cellOf(-1.5), { t: 'n', v: '-1.5' });
  assert.deepEqual(cellOf(5n), { t: 'n', v: '5' });
  assert.deepEqual(cellOf(9007199254740993n), { t: 's', v: '9007199254740993' });
  assert.deepEqual(cellOf(true), { t: 'b', v: '1' });
  assert.equal(cellOf(null), null);
  assert.equal(cellOf(undefined), null);
  assert.deepEqual(cellOf(new Date('2026-02-11T00:00:00Z')), { t: 'n', v: '46064', s: 2 });
  assert.deepEqual(cellOf(new Date('2026-02-11T12:00:00Z')), { t: 'n', v: '46064.5', s: 3 });
  assert.deepEqual(cellOf(Buffer.from([1, 171])), { t: 's', v: '0x01AB' });
  assert.deepEqual(cellOf({ a: 1 }), { t: 's', v: '{"a":1}' });
  // Exact decimals come as text: numbers when the column is numeric and Excel keeps every digit.
  assert.deepEqual(cellOf('12.50', 'Numeric'), { t: 'n', v: '12.5' });
  assert.deepEqual(cellOf('123456789012345678.5', 'Numeric'), { t: 's', v: '123456789012345678.5' });
  assert.deepEqual(cellOf('0123', 'varchar'), { t: 's', v: '0123' });
  assert.deepEqual(cellOf('2026-02-11', 'date'), { t: 'n', v: '46064', s: 2 });
});

test('columns and sheets are named as Excel allows', () => {
  assert.deepEqual([0, 25, 26, 51, 52, 701, 702].map(columnLetters), ['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA']);
  assert.deepEqual(sheetNames(['Players', 'players', 'a/b:[c]?', 'x'.repeat(40), '']), ['Players', 'players 2', 'a b c', 'x'.repeat(31), 'Sheet']);
});

test('a workbook: a sheet per result set, a bold header, numbers, dates and text in their cells', () => {
  const sets = [
    {
      columns: [{ name: 'Id', type: 'IntN' }, { name: 'Name', type: 'NVarChar' }, { name: 'PlayedOn', type: 'DateN' }],
      rows: [
        [1, 'Rui & <Co>', new Date('2026-02-11T00:00:00Z')],
        [2, null, null],
      ],
    },
    { columns: [{ name: 'n', type: '' }], rows: [[1]] },
  ];
  const files = unzip(toXlsx(sets));
  assert.deepEqual([...files.keys()], ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']);
  assert.match(files.get('[Content_Types].xml'), /PartName="\/xl\/worksheets\/sheet2\.xml"/);
  assert.match(files.get('xl/workbook.xml'), /<sheet name="Result 1" sheetId="1" r:id="rId1"\/><sheet name="Result 2" sheetId="2" r:id="rId2"\/>/);
  assert.match(files.get('xl/_rels/workbook.xml.rels'), /Id="rId3" Type="[^"]+\/styles" Target="styles\.xml"/);
  assert.match(files.get('xl/styles.xml'), /<font><b\/>/);
  assert.match(files.get('xl/styles.xml'), /formatCode="yyyy-mm-dd"/);
  const sheet = files.get('xl/worksheets/sheet1.xml');
  assert.match(sheet, /<row r="1"><c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">Id<\/t><\/is><\/c>/);
  assert.match(sheet, /<c r="A2"><v>1<\/v><\/c><c r="B2" t="inlineStr"><is><t xml:space="preserve">Rui &amp; &lt;Co&gt;<\/t><\/is><\/c><c r="C2" s="2"><v>46064<\/v><\/c>/);
  // NULLs are left out.
  assert.match(sheet, /<row r="3"><c r="A3"><v>2<\/v><\/c><\/row>/);
  assert.match(sheet, /state="frozen"/);
  // One set: a sheet named Results, or as asked.
  assert.match(unzip(toXlsx([sets[1]])).get('xl/workbook.xml'), /<sheet name="Results"/);
  assert.match(unzip(toXlsx([sets[1]], { names: ['Players'] })).get('xl/workbook.xml'), /<sheet name="Players"/);
});

// ---------------------------------------------------------------------------------------------------

const KEYS = { enter: '\r', esc: '\x1b', down: '\x1b[B', ctrlU: '\x15' };
let base;
before(() => {
  base = mkdtempSync(join(tmpdir(), 'trawl-'));
  process.env.TRAWL_HOME = join(base, 'home');
});
after(() => rmSync(base, { recursive: true, force: true }));

let lastApp = null;
async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${lastApp?.lastFrame()}`);
}
const frame = () => lastApp.lastFrame();
const type = async (stdin, s) => {
  for (const ch of s) {
    stdin.write(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
};

test('x in Results offers Excel, and /export file.xlsx writes the rows as a workbook', async () => {
  const config = { connections: [...DEMO_CONNECTIONS], history: [], ran: [], limit: 500, last: null };
  const app = (lastApp = render(React.createElement(App, { config, initialConnection: 'demo' })));
  await until(() => frame().includes('Translations'), 'the explorer');
  await type(app.stdin, '!SELECT * FROM dbo.Matches');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('8 rows'), 'the matches');
  app.stdin.write('x');
  await until(() => frame().includes('Export the result set as') && frame().includes('Excel'), 'the choices');
  assert.match(frame(), /CSV +Matches\.csv/);
  app.stdin.write(KEYS.down);
  await until(() => /❯ Excel/.test(frame()), 'Excel picked');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('> /export Matches.xlsx'), 'the command in the prompt');
  // Somewhere of the test's own rather than the working folder.
  app.stdin.write(KEYS.ctrlU);
  const out = join(base, 'matches.xlsx');
  await type(app.stdin, `/export ${out}`);
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('Wrote 8 rows to'), 'the export');
  const files = unzip(readFileSync(out));
  assert.match(files.get('xl/workbook.xml'), /<sheet name="Matches"/);
  const sheet = files.get('xl/worksheets/sheet1.xml');
  assert.match(sheet, /<t xml:space="preserve">PlayedOn<\/t>/);
  assert.equal((sheet.match(/<row /g) ?? []).length, 9);
  assert.match(sheet, /<c r="D2" s="2"><v>\d+<\/v><\/c>/);
  app.unmount();
});
