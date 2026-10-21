import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIALECTS } from '../src/dialects.js';
import { compareVersions, crc32, createPlainSql, flywayChecksum, historySql, migrationStatus, nextRank, parseFlywayName, pickHistory, probeSql, recordSql, statusText } from '../src/migrations.js';

const { sqlserver: MS, postgres: PG, mysql: MY } = DIALECTS;

test("crc32 is the standard one, and Flyway's checksum ignores line breaks and a byte order mark", () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  // Kept signed, as flyway_schema_history's int column has it.
  assert.equal(flywayChecksum('123456789'), 0xcbf43926 | 0);
  assert.ok(flywayChecksum('123456789') < 0);
  const text = 'CREATE TABLE t (\n  id int\n);\n';
  assert.equal(flywayChecksum(text), flywayChecksum(text.replace(/\n/g, '\r\n')));
  assert.equal(flywayChecksum(text), flywayChecksum(`﻿${text}`));
  // Lines are read one at a time, so the breaks between them count for nothing.
  assert.equal(flywayChecksum('ab\ncd'), crc32(Buffer.from('abcd')) | 0);
  assert.notEqual(flywayChecksum(text), flywayChecksum(text.replace('id', 'Id')));
  assert.equal(flywayChecksum('é'), crc32(Buffer.from('é', 'utf8')) | 0);
});

test('Flyway names: versions with dots or underscores, descriptions, repeatables; others are null', () => {
  assert.deepEqual(parseFlywayName('V1__Create_clubs.sql'), { prefix: 'V', version: '1', description: 'Create clubs' });
  assert.deepEqual(parseFlywayName('V1_2__x.sql'), { prefix: 'V', version: '1.2', description: 'x' });
  assert.deepEqual(parseFlywayName('v2.10.3__Add.sql'), { prefix: 'V', version: '2.10.3', description: 'Add' });
  assert.deepEqual(parseFlywayName('R__Views.sql'), { prefix: 'R', version: null, description: 'Views' });
  assert.equal(parseFlywayName('R1__x.sql'), null);
  assert.equal(parseFlywayName('V__x.sql'), null);
  assert.equal(parseFlywayName('V1_x.sql'), null);
  assert.equal(parseFlywayName('001_init.sql'), null);
  assert.equal(compareVersions('1.10', '1.9'), 1);
  assert.equal(compareVersions('1.0', '1'), 0);
  assert.equal(compareVersions('2', '10'), -1);
});

const file = (path, text = `-- ${path}\nSELECT 1;\n`) => ({ path, text });
const row = (rank, version, script, text, extra = {}) => ({ installed_rank: rank, version, description: script, type: 'SQL', script, checksum: text == null ? null : flywayChecksum(text), installed_by: 'me', installed_on: new Date('2026-01-02T10:00:00Z'), execution_time: 5, success: true, ...extra });

test('Flyway: applied, changed (by checksum), pending in version order, missing, failed, below the baseline, repeatables', () => {
  const v1 = file('V1__One.sql');
  const v2 = file('V2__Two.sql');
  const files = [file('V10__Ten.sql'), v2, v1, file('sub/V3__Three.sql'), file('R__Views.sql', 'CREATE VIEW v AS SELECT 1;'), file('U2__Undo.sql'), file('notes.sql'), file('V0_5__Old.sql'), file('V4__Broken.sql')];
  const rows = [
    row(1, '0.9', '<< Flyway Baseline >>', null, { type: 'BASELINE' }),
    row(2, '1', 'V1__One.sql', v1.text),
    row(3, '2', 'V2__Two.sql', 'something else'),
    row(4, '1.5', 'V1_5__Gone.sql', 'x'),
    row(5, '4', 'V4__Broken.sql', 'y', { success: 0 }),
    row(6, null, 'R__Views.sql', 'CREATE VIEW v AS SELECT 0;'),
  ];
  const s = migrationStatus({ tool: 'flyway', files, rows });
  const by = Object.fromEntries(s.entries.map((e) => [e.script, e]));
  assert.equal(by['V0_5__Old.sql'].status, 'baseline');
  assert.equal(by['V1__One.sql'].status, 'applied');
  assert.equal(by['V2__Two.sql'].status, 'changed');
  assert.match(by['V2__Two.sql'].detail, /^checksum -?\d+ now, -?\d+ when applied$/);
  assert.equal(by['V1_5__Gone.sql'].status, 'missing');
  assert.equal(by['V4__Broken.sql'].status, 'failed');
  assert.equal(by['sub/V3__Three.sql'].status, 'pending');
  assert.match(by['sub/V3__Three.sql'].detail, /older than 4|^$/);
  assert.equal(by['R__Views.sql'].status, 'pending');
  assert.match(by['R__Views.sql'].detail, /changed since it last ran/);
  assert.deepEqual(s.pending.map((e) => e.script), ['sub/V3__Three.sql', 'V10__Ten.sql', 'R__Views.sql']);
  assert.deepEqual(s.entries.map((e) => e.version), ['0.5', '1', '1.5', '2', '3', '4', '10', null]);
  assert.ok(s.notes.some((n) => /Not Flyway names, so left out: notes\.sql/.test(n)));
  assert.ok(s.notes.some((n) => /Undo migrations \(U2__Undo\.sql\)/.test(n)));
  assert.ok(s.runnable);
});

test('Flyway: a pending version below the newest applied says Flyway only runs it out of order', () => {
  const v1 = file('V1__One.sql');
  const s = migrationStatus({ tool: 'flyway', files: [v1, file('V3__Three.sql'), file('V2__Two.sql')], rows: [row(1, '1', 'V1__One.sql', v1.text), row(2, '3', 'V3__Three.sql', file('V3__Three.sql').text)] });
  assert.deepEqual(s.pending.map((e) => [e.script, e.detail]), [['V2__Two.sql', 'older than 3, the newest applied (Flyway runs it only with outOfOrder)']]);
});

test('EF Core: migration ids from the .cs files and idempotent scripts, listed but never run', () => {
  const files = [
    file('Migrations/20240101120000_Initial.cs', 'class Initial {}'),
    file('Migrations/20240101120000_Initial.Designer.cs', ''),
    file('Migrations/AppModelSnapshot.cs', ''),
    file('Migrations/20240301090000_AddPlayers.cs', ''),
    file('scripts/all.sql', "IF NOT EXISTS(SELECT * FROM [__EFMigrationsHistory] WHERE [MigrationId] = N'20240501000000_AddStadiums')\nBEGIN\n  CREATE TABLE x (id int);\nEND;"),
  ];
  const rows = [{ MigrationId: '20240101120000_Initial', ProductVersion: '8.0.1' }, { MigrationId: '20231201000000_Gone', ProductVersion: '7.0.0' }];
  const s = migrationStatus({ tool: 'ef', files, rows });
  assert.deepEqual(s.entries.map((e) => [e.script, e.status]), [
    ['20231201000000_Gone', 'missing'],
    ['20240101120000_Initial', 'applied'],
    ['20240301090000_AddPlayers', 'pending'],
    ['20240501000000_AddStadiums', 'pending'],
  ]);
  assert.equal(s.runnable, false);
  assert.match(s.notes.at(-1), /dotnet ef database update/);
});

test('DbUp: script names (an embedded resource name ends with the file), in name order, no checksums', () => {
  const files = [file('Script0002 - Players.sql'), file('Script0001 - Clubs.sql'), file('Script0003 - Matches.sql')];
  const rows = [{ SchemaVersionsId: 1, ScriptName: 'MyApp.Scripts.Script0001 - Clubs.sql', Applied: new Date('2026-01-01T00:00:00Z') }, { SchemaVersionsId: 2, ScriptName: 'Script0000 - Old.sql', Applied: new Date() }];
  const s = migrationStatus({ tool: 'dbup', files, rows });
  assert.deepEqual(s.entries.map((e) => [e.script, e.status]), [
    ['Script0001 - Clubs.sql', 'applied'],
    ['Script0002 - Players.sql', 'pending'],
    ['Script0003 - Matches.sql', 'pending'],
    ['Script0000 - Old.sql', 'missing'],
  ]);
  assert.match(s.notes[0], /no checksums/);
});

test("Trawl's own: any .sql by its path, checksums compared", () => {
  const a = file('001_clubs.sql');
  const s = migrationStatus({ tool: 'plain', files: [file('002_players.sql'), a, file('readme.cs')], rows: [{ script: '001_clubs.sql', checksum: flywayChecksum(a.text), applied_on: new Date() }, { script: '000_gone.sql', checksum: 1 }] });
  assert.deepEqual(s.entries.map((e) => [e.script, e.status]), [
    ['001_clubs.sql', 'applied'],
    ['002_players.sql', 'pending'],
    ['000_gone.sql', 'missing'],
  ]);
  const changed = migrationStatus({ tool: 'plain', files: [a], rows: [{ script: '001_clubs.sql', checksum: 5 }] });
  assert.equal(changed.entries[0].status, 'changed');
});

test('the probe looks for every history table, and the first found wins (else Trawl’s own, not made yet)', () => {
  for (const kind of ['sqlserver', 'postgres', 'mysql']) {
    const sql = probeSql(kind);
    assert.match(sql, /^-- trawl:migrations-probe/);
    for (const t of ['flyway_schema_history', '__efmigrationshistory', 'schemaversions', 'trawl_migrations']) assert.ok(sql.includes(`'${t}'`), `${kind}: ${t}`);
  }
  assert.match(probeSql('sqlserver'), /IN \(N'flyway_schema_history', N'__efmigrationshistory'/);
  assert.deepEqual(pickHistory([{ schema: 'dbo', name: 'SchemaVersions' }, { schema: 'dbo', name: '__EFMigrationsHistory' }], 'dbo'), { tool: 'ef', schema: 'dbo', table: '__EFMigrationsHistory' });
  assert.deepEqual(pickHistory([], 'public'), { tool: 'plain', schema: 'public', table: 'trawl_migrations', missing: true });
  assert.equal(historySql(PG, { schema: 'public', table: 'flyway_schema_history' }), '-- trawl:migrations-history\nSELECT * FROM "public"."flyway_schema_history";');
  assert.equal(nextRank([{ installed_rank: 3 }, { INSTALLED_RANK: 7 }]), 8);
  assert.equal(nextRank([]), 1);
});

test("a run is recorded as its tool would: Flyway's row, DbUp's, Trawl's own; the table's own column spelling kept", () => {
  const entry = { script: 'V3__Add_stadiums.sql', version: '3', description: "Add stadiums' things", checksum: -123 };
  assert.equal(
    recordSql(MS, { tool: 'flyway', schema: 'dbo', table: 'flyway_schema_history' }, entry, { ms: 12.4, rank: 4 }),
    "-- trawl:migration-record\nINSERT INTO [dbo].[flyway_schema_history] ([installed_rank], [version], [description], [type], [script], [checksum], [installed_by], [execution_time], [success])\nVALUES (4, N'3', N'Add stadiums'' things', N'SQL', N'V3__Add_stadiums.sql', -123, SUSER_SNAME(), 12, 1);",
  );
  assert.match(recordSql(PG, { tool: 'flyway', schema: 'public', table: 'flyway_schema_history' }, entry, { ms: 1, rank: 1 }), /current_user, 1, TRUE\);$/);
  assert.match(recordSql(MY, { tool: 'flyway', schema: 'shop', table: 'flyway_schema_history' }, entry, { ms: 1, rank: 1 }), /`installed_rank`.*CURRENT_USER\(\), 1, 1\);$/s);
  assert.equal(
    recordSql(PG, { tool: 'dbup', schema: 'public', table: 'schemaversions' }, { script: 'Script0002.sql' }, { ms: 3, columns: ['schemaversionsid', 'scriptname', 'applied'] }),
    "-- trawl:migration-record\nINSERT INTO \"public\".\"schemaversions\" (\"scriptname\", \"applied\")\nVALUES ('Script0002.sql', now());",
  );
  assert.match(recordSql(MS, { tool: 'plain', schema: 'dbo', table: 'trawl_migrations' }, { script: '002.sql', checksum: 9 }, { ms: 40 }), /\(\[script\], \[checksum\], \[execution_ms\]\)\nVALUES \(N'002\.sql', 9, 40\);$/);
  assert.match(createPlainSql(MS, 'dbo'), /^-- trawl:migrations-create\nCREATE TABLE \[dbo\]\.\[trawl_migrations\]/);
  assert.match(createPlainSql(PG, 'public'), /"script" varchar\(1000\) NOT NULL PRIMARY KEY/);
});

test('the status text: what was compared, a line per migration, the counts and the notes', () => {
  const v1 = file('V1__One.sql');
  const s = migrationStatus({ tool: 'flyway', files: [v1, file('V2__Two.sql')], rows: [row(1, '1', 'V1__One.sql', v1.text)] });
  const text = statusText(s, { database: 'ClubA', folder: '/m', history: { schema: 'dbo', table: 'flyway_schema_history' }, files: 2 });
  assert.match(text, /^Flyway · dbo\.flyway_schema_history in ClubA · 2 files in \/m\nChecksums: Flyway's CRC-32/);
  assert.match(text, /✓ applied {2}V1 {2}V1__One\.sql {2}2026-01-02 10:00/);
  assert.match(text, /• pending {2}V2 {2}V2__Two\.sql/);
  assert.match(text, /1 applied · 1 pending$/);
  const none = statusText(migrationStatus({ tool: 'plain', files: [], rows: [] }), { database: 'ClubB', folder: '/m', history: { schema: 'dbo', table: 'trawl_migrations', missing: true }, files: 0 });
  assert.match(none, /trawl_migrations isn't in ClubB yet/);
  assert.match(none, /No migrations in the folder or the history/);
});
