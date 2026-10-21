import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvInsertScript, detectDelimiter, parseCsv } from '../src/csv.js';

test('quotes, doubled quotes, line breaks inside quotes, CRLF and a byte-order mark', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, ""y""","line\r\nbreak"\r\n1,\r\n\r\n'), [['a', 'b'], ['x, "y"', 'line\r\nbreak'], ['1', '']]);
  assert.deepEqual(parseCsv('a,b\nc,d'), [['a', 'b'], ['c', 'd']], 'no line break at the end');
  assert.deepEqual(parseCsv('"",x\n'), [['', 'x']]);
});

test('the delimiter is the one the header uses: comma, semicolon or tab', () => {
  assert.equal(detectDelimiter('a;b;"c,d"\n1;2;3'), ';');
  assert.equal(detectDelimiter('a\tb\n'), '\t');
  assert.equal(detectDelimiter('single'), ',');
  assert.deepEqual(parseCsv('Name;Goals\nAna;3'), [['Name', 'Goals'], ['Ana', '3']]);
});

const players = {
  schema: 'dbo',
  name: 'Players',
  columns: [
    { name: 'Id', type: 'int', identity: true, nullable: false },
    { name: 'ClubId', type: 'int', nullable: false },
    { name: 'Name', type: 'nvarchar(100)', nullable: false },
    { name: 'Shirt', type: 'tinyint', nullable: true },
    { name: 'Goals', type: 'int', nullable: false },
  ],
};

test('rows become INSERTs, columns matched by header; identity and unknown columns are left out', () => {
  const r = csvInsertScript(parseCsv('id,club_id,NAME,shirt,Colour\n9,1,"O\'Neil, Rui",,red\n10,2,Ana,7,blue\n'), players);
  assert.equal(r.script, "INSERT INTO [dbo].[Players] ([ClubId], [Name], [Shirt]) VALUES\n  (1, N'O''Neil, Rui', NULL),\n  (2, N'Ana', 7);");
  assert.deepEqual(r.skipped, ['id: an identity column, which the server fills', 'Colour: no such column']);
  assert.deepEqual(r.missing, ['Goals']);
});

test('a value that does not fit its column, or a row of the wrong length, says where', () => {
  assert.throws(() => csvInsertScript(parseCsv('ClubId,Name\n1,a\nx,b\n'), players), /Row 3, ClubId: int takes a whole number \("x"\)/);
  assert.throws(() => csvInsertScript(parseCsv('ClubId,Name\n1\n'), players), /Row 2 has 1 value; the header has 2/);
  assert.throws(() => csvInsertScript(parseCsv('Colour\nred\n'), players), /None of the file's columns/);
});
