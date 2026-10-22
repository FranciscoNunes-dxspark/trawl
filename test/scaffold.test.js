import { test } from 'node:test';
import assert from 'node:assert/strict';
import { languageOf, pascal, scaffold, singular, snake } from '../src/scaffold.js';

const col = (name, type, extra = {}) => ({ name, type, nullable: false, identity: false, pk: false, ...extra });
const PLAYERS = {
  schema: 'dbo',
  name: 'Players',
  kind: 'table',
  columns: [col('Id', 'int', { pk: true, identity: true }), col('ClubId', 'int'), col('Name', 'nvarchar(100)'), col('Shirt', 'tinyint', { nullable: true }), col('Joined', 'datetimeoffset'), col('Salary', 'decimal(10,2)', { nullable: true }), col('Photo', 'varbinary(max)', { nullable: true }), col('Version', 'rowversion')],
};

test('names: PascalCase, snake_case and singular class names', () => {
  assert.equal(pascal('club_id'), 'ClubId');
  assert.equal(pascal('ClubId'), 'ClubId');
  assert.equal(pascal('first name'), 'FirstName');
  assert.equal(pascal('2fa'), '_2fa');
  assert.equal(snake('ClubId'), 'club_id');
  assert.equal(snake('HTMLBody'), 'html_body');
  assert.deepEqual(['Players', 'Matches', 'Categories', 'Status', 'Addresses', 'Data', 'vTopScorers'].map(singular), ['Player', 'Match', 'Category', 'Status', 'Address', 'Data', 'vTopScorer']);
  assert.equal(languageOf('C#'), 'csharp');
  assert.equal(languageOf('typescript'), 'ts');
  assert.equal(languageOf('py'), 'python');
  assert.equal(languageOf('cobol'), null);
});

test('a C# class with nullable reference types', () => {
  assert.equal(
    scaffold(PLAYERS, 'csharp'),
    `// table dbo.Players
public class Player
{
    public int Id { get; set; }
    public int ClubId { get; set; }
    public string Name { get; set; } = null!;
    public byte? Shirt { get; set; }
    public DateTimeOffset Joined { get; set; }
    public decimal? Salary { get; set; }
    public byte[]? Photo { get; set; }
    public byte[] Version { get; set; } = null!;
}
`,
  );
});

test('an EF Core entity: [Table], [Key], [Column] with its type, [MaxLength], identity and rowversion', () => {
  const text = scaffold(PLAYERS, 'ef');
  assert.match(text, /^using System\.ComponentModel\.DataAnnotations;\nusing System\.ComponentModel\.DataAnnotations\.Schema;\n\n\/\/ table dbo\.Players\n\[Table\("Players", Schema = "dbo"\)\]\npublic class Player\n\{\n/);
  assert.match(text, / {4}\[Key\]\n {4}\[Column\("Id", TypeName = "int"\)\]\n {4}\[DatabaseGenerated\(DatabaseGeneratedOption\.Identity\)\]\n {4}public int Id \{ get; set; \}\n/);
  assert.match(text, / {4}\[Column\("Name", TypeName = "nvarchar\(100\)"\)\]\n {4}\[MaxLength\(100\)\]\n {4}public string Name \{ get; set; \} = null!;/);
  assert.match(text, / {4}\[Column\("Photo", TypeName = "varbinary\(max\)"\)\]\n {4}public byte\[\]\? Photo/);
  assert.match(text, / {4}\[Timestamp\]\n {4}public byte\[\] Version/);
  const composite = scaffold({ schema: 'i18n', name: 'Translations', kind: 'table', columns: [col('ResourceKey', 'nvarchar(200)', { pk: true }), col('Culture', 'nvarchar(10)', { pk: true }), col('Value', 'nvarchar(max)')] }, 'ef');
  assert.match(composite, /using Microsoft\.EntityFrameworkCore;/);
  assert.match(composite, /\[PrimaryKey\(nameof\(ResourceKey\), nameof\(Culture\)\)\]\npublic class Translation/);
  assert.doesNotMatch(composite, /\[Key\]/);
  const view = scaffold({ schema: 'dbo', name: 'vTopScorers', kind: 'view', columns: [col('Name', 'nvarchar(100)'), col('Goals', 'int')] }, 'ef');
  assert.match(view, /\[Keyless\]\npublic class VTopScorer/);
});

test('members never clash with the class or C# keywords', () => {
  const text = scaffold({ schema: 'dbo', name: 'Events', kind: 'table', columns: [col('Event', 'int'), col('class', 'int'), col('event_', 'int')] }, 'csharp');
  assert.match(text, /public class Event\n/);
  assert.match(text, /public int EventValue \{ get; set; \}\n {4}public int Class \{ get; set; \}\n {4}public int EventValue2 \{/);
});

test("a TypeScript interface, typed as each server's driver returns the rows", () => {
  assert.equal(
    scaffold(PLAYERS, 'ts'),
    `// table dbo.Players, as the tedious (mssql) driver returns its rows
export interface Player {
  Id: number;
  ClubId: number;
  Name: string;
  Shirt: number | null;
  Joined: Date;
  Salary: number | null;
  Photo: Buffer | null;
  Version: Buffer;
}
`,
  );
  const pg = scaffold({ schema: 'public', name: 'orders', kind: 'table', columns: [col('id', 'bigint'), col('total', 'numeric(10,2)'), col('paid', 'boolean'), col('meta', 'jsonb', { nullable: true }), col('first name', 'text')] }, 'ts', { kind: 'postgres' });
  assert.match(pg, /as the pg driver/);
  assert.match(pg, / {2}id: string;\n {2}total: string;\n {2}paid: boolean;\n {2}meta: unknown \| null;\n {2}"first name": string;/);
  const my = scaffold({ schema: 'shop', name: 'orders', kind: 'table', columns: [col('id', 'bigint unsigned'), col('total', 'decimal(10,2)'), col('paid', 'tinyint(1)'), col('state', "enum('new','paid')")] }, 'ts', { kind: 'mysql' });
  assert.match(my, / {2}id: number;\n {2}total: string;\n {2}paid: number;\n {2}state: "new" \| "paid";/);
});

test('a Python dataclass, snake_case fields keeping the column order, Optional for NULL', () => {
  assert.equal(
    scaffold(PLAYERS, 'python'),
    `from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Optional


@dataclass
class Player:
    """table dbo.Players"""
    id: int
    club_id: int  # ClubId
    name: str
    shirt: Optional[int]
    joined: datetime
    salary: Optional[Decimal]
    photo: Optional[bytes]
    version: bytes
`,
  );
  assert.match(scaffold({ schema: 'public', name: 'events', kind: 'table', columns: [col('id', 'uuid'), col('from', 'date'), col('took', 'interval')] }, 'python', { kind: 'postgres' }), /^from dataclasses import dataclass\nfrom datetime import date, timedelta\nfrom uuid import UUID\n[\s\S]*id: UUID\n {4}from_: date {2}# from\n {4}took: timedelta/);
});

test('C# types per server: Postgres timestamptz is a DateTime, MySQL unsigned and tinyint(1)', () => {
  const pg = scaffold({ schema: 'public', name: 'logs', kind: 'table', columns: [col('at', 'timestamp with time zone'), col('n', 'smallint'), col('d', 'date')] }, 'csharp', { kind: 'postgres' });
  assert.match(pg, /public DateTime At \{ get; set; \}\n {4}public short N \{ get; set; \}\n {4}public DateOnly D \{ get; set; \}/);
  const my = scaffold({ schema: 'shop', name: 'flags', kind: 'table', columns: [col('id', 'int unsigned'), col('on', 'tinyint(1)'), col('small', 'tinyint')] }, 'csharp', { kind: 'mysql' });
  assert.match(my, /public uint Id \{ get; set; \}\n {4}public bool On \{ get; set; \}\n {4}public sbyte Small \{ get; set; \}/);
});
